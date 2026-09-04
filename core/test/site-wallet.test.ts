// ============================================================
//  site-wallet.test.ts  -  o protocolo de dinheiro, SEM INTERNET.
//
//  Todo `fetch` deste arquivo é um dublê. Nenhuma linha aqui sai da
//  máquina — um teste que depende de um serviço de fora falha no CI
//  por um motivo que não é o dele, e passa a atestar a saúde alheia
//  em vez do nosso código.
//
//  O que este arquivo guarda:
//
//    1. o saldo do site vem como STRING, e vira número inteiro;
//    2. 200 sem `success` é `unknown` — nunca `ok`;
//    3. 422 é SALDO INSUFICIENTE, e a frase mostrada é a DO SITE;
//    4. 409 é REUSO DE REFERÊNCIA, e `charged` diz que o dinheiro
//       já saiu — o contrário do que a carteira antiga assumia;
//    5. 400 é defeito NOSSO: `rejected`, e não algo a repetir;
//    6. 401/403 de pareamento não são "site lento";
//    7. timeout e 5xx são `unknown`: PODE TER COBRADO;
//    8. saldo que não deu para ler é `null`, e nunca zero.
// ============================================================

import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import { SiteWallet } from '../src/store/site-wallet.js';

const STEAM_ID = '76561198000000000';
const SERVER_ID = 'RUST01';
const REFERENCE = `rust:${SERVER_ID}:loja:p2n8x4q9zk1a`;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

/** O que o dublê de `fetch` devolve numa chamada. */
interface Canned {
  readonly status: number;
  readonly body?: unknown;
  /** Corpo em TEXTO PURO — é como a borda do site responde o 1010. */
  readonly text?: string;
  /** Estourar em vez de responder: é o "sem rede" e o timeout. */
  readonly throws?: Error;
}

interface FakeFetch {
  readonly impl: typeof globalThis.fetch;
  readonly calls: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[];
}

/**
 * O `fetch` de mentira.
 *
 * Recebe a fila de respostas na ordem em que devem sair; a última se
 * repete, para o teste não ter de contar quantas chamadas houve.
 */
function fakeFetch(responses: readonly Canned[]): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  let at = 0;

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const canned = responses[Math.min(at, responses.length - 1)] ?? { status: 500 };

    at += 1;

    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });

    if (canned.throws !== undefined) {
      return Promise.reject(canned.throws);
    }

    if (canned.text !== undefined) {
      return Promise.resolve(
        new Response(canned.text, {
          status: canned.status,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    }

    return Promise.resolve(
      new Response(canned.body === undefined ? null : JSON.stringify(canned.body), {
        status: canned.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

function walletWith(
  responses: readonly Canned[],
  onPairingSuspect?: (reason: string) => void,
): { wallet: SiteWallet; fetch: FakeFetch } {
  const fetch = fakeFetch(responses);

  const wallet = new SiteWallet({
    client: new SiteClient({
      baseUrl: 'https://site.example',
      token: 'tok',
      serverId: SERVER_ID,
      userAgent: 'OrigemZ-Rust-Agent/teste',
      logger: silent,
      fetchImpl: fetch.impl,
    }),
    logger: silent,
    ...(onPairingSuspect === undefined ? {} : { onPairingSuspect }),
  });

  return { wallet, fetch };
}

/** O corpo do débito, sem o que muda entre os testes. */
function debitInput(): Parameters<SiteWallet['debit']>[0] {
  return {
    steamId: STEAM_ID,
    amount: 250,
    reference: REFERENCE,
    reason: 'Loja in-game: Kit Metal x1',
    productId: 'kit-metal',
  };
}

function abortError(): Error {
  const error = new Error('The operation was aborted');

  error.name = 'AbortError';

  return error;
}

describe('o débito', () => {
  it('lê o saldo que vem como STRING e devolve inteiro', async () => {
    const { wallet, fetch } = walletWith([
      {
        status: 200,
        body: {
          success: true,
          steamid: STEAM_ID,
          moedas: '250',
          before: '500',
          after: '250',
          amount: '250',
          direction: 'debit',
          transactionId: 918273,
        },
      },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('ok');

    if (change.status === 'ok') {
      // `moedas`, e não `balance`: o campo que a carteira antiga lia
      // não existe em resposta nenhuma do site.
      expect(change.balance).toBe(250);
      expect(change.replayed).toBe(false);
      // TEXTO: o BIGINT do site passa de 2^53.
      expect(change.transactionId).toBe('918273');
    }

    // O corpo tem de levar `referenceId` (não um header
    // `Idempotency-Key`) e `productId`; e `reason` vira `observacao`.
    expect(fetch.calls[0]?.url).toBe('https://site.example/api/agent/ozcoins/debit');
    expect(fetch.calls[0]?.body).toEqual({
      steamId: STEAM_ID,
      amount: 250,
      referenceId: REFERENCE,
      observacao: 'Loja in-game: Kit Metal x1',
      productId: 'kit-metal',
    });
    // Sem `X-Server-Id` toda chamada morreria em 400 MISSING_SERVER_ID.
    expect(fetch.calls[0]?.headers['X-Server-Id']).toBe(SERVER_ID);
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer tok');
    // O header antigo NÃO sai: o site o ignora, e mandá-lo sugeriria
    // que ele é a idempotência quando quem a carrega é o corpo.
    expect(fetch.calls[0]?.headers['Idempotency-Key']).toBeUndefined();
  });

  it('replay: "idempotent" vira ok com replayed, e sem transactionId', async () => {
    // `idempotent: true` quer dizer JÁ FOI COBRADO, nunca "já foi
    // entregue" — o site não tem como saber da entrega.
    const { wallet } = walletWith([
      {
        status: 200,
        body: { success: true, idempotent: true, moedas: '250', direction: 'debit' },
      },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('ok');

    if (change.status === 'ok') {
      expect(change.replayed).toBe(true);
      // O site não repete o id no replay.
      expect(change.transactionId).toBeNull();
    }
  });

  it('200 sem "success" é INDETERMINADO, e nunca sucesso', async () => {
    // Um 200 que não dá para entender PODE TER COBRADO. Ler isto como
    // `ok` entregaria o item sem saber se o dinheiro saiu.
    const { wallet } = walletWith([{ status: 200, body: { ok: true } }]);

    expect((await wallet.debit(debitInput())).status).toBe('unknown');
  });

  it('422 é saldo insuficiente, e a frase mostrada é a DO SITE', async () => {
    const message = 'Saldo insuficiente. Voce tem 0 OZ, o item custa 250 OZ (faltam 250).';
    const { wallet } = walletWith([{ status: 422, body: { error: message } }]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('insufficient');

    if (change.status === 'insufficient') {
      // Crua: o jogador lê a conta que o DONO DO SALDO fez.
      expect(change.message).toBe(message);
      // Sem os números do ajuste do site, `null` — e NUNCA zero.
      expect(change.balance).toBeNull();
    }
  });

  it('422 com os números traz o saldo DO SITE', async () => {
    const { wallet } = walletWith([
      {
        status: 422,
        body: {
          error: 'Saldo insuficiente. Voce tem 100 OZ, o item custa 250 OZ (faltam 150).',
          error_code: 'INSUFFICIENT_BALANCE',
          balance: 100,
          required: 250,
          missing: 150,
        },
      },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('insufficient');

    if (change.status === 'insufficient') {
      expect(change.balance).toBe(100);
    }
  });

  it('409 é reuso de referência — e "charged" diz que o dinheiro JÁ SAIU', async () => {
    // ####  ESTE É O DESFECHO QUE A CARTEIRA ANTIGA LIA AO CONTRÁRIO ####
    //
    // Ela tratava 409 como "saldo insuficiente". Aqui ele significa o
    // oposto: houve cobrança. Gerar um id novo cobraria de novo.
    const { wallet } = walletWith([
      {
        status: 409,
        body: {
          error: 'Esse referenceId já foi usado numa cobrança de 250 OZ.',
          error_code: 'REFERENCE_ID_AMOUNT_MISMATCH',
          charged: 250,
        },
      },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('rejected');

    if (change.status === 'rejected') {
      expect(change.code).toBe('REFERENCE_ID_AMOUNT_MISMATCH');
      expect(change.charged).toBe(250);
    }
  });

  it('400 de validação é defeito NOSSO, e não algo a repetir', async () => {
    const { wallet } = walletWith([
      { status: 400, body: { error: 'referenceId obrigatório (3..120 chars)' } },
    ]);

    // `unavailable` seria retentável, e o agente repetiria para sempre
    // um pedido que nunca vai passar — contra um canal sem rate-limit.
    expect((await wallet.debit(debitInput())).status).toBe('rejected');
  });

  it('401 de pareamento não é "site lento", e acorda o beacon', async () => {
    const suspects: string[] = [];
    const { wallet } = walletWith(
      [{ status: 401, body: { error: 'Bearer não confere', error_code: 'BEARER_MISMATCH' } }],
      (reason) => suspects.push(reason),
    );

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      // `pairing` é o que faz a loja dizer INDISPONÍVEL e o beacon
      // voltar a bater, em vez de o agente insistir em laço.
      expect(change.cause).toBe('pairing');
    }

    expect(suspects).toEqual(['BEARER_MISMATCH']);
  });

  it('403 AGENT_IP_NOT_ALLOWED é pareamento, e não defeito do pedido', async () => {
    // Sem esta linha o código cairia no ramo do 4xx desconhecido e,
    // pior, um dia viraria `rejected`: cada compra fecharia como
    // `failed`, uma por uma, porque o IP residencial trocou.
    const suspects: string[] = [];
    const { wallet } = walletWith(
      [{ status: 403, body: { error: 'IP não autorizado', error_code: 'AGENT_IP_NOT_ALLOWED' } }],
      (reason) => suspects.push(reason),
    );

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      expect(change.cause).toBe('pairing');
    }

    expect(suspects).toHaveLength(1);
  });

  it('403 da borda com "error code: 1010" NÃO é ban', async () => {
    const { wallet } = walletWith([{ status: 403, text: 'error code: 1010' }]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      expect(change.cause).toBe('network');
    }
  });

  it('403 "Operação não permitida" é campo proibido no corpo', async () => {
    // O middleware global do site mata o request quando o corpo tem
    // `balance`, `ozBalance` ou `epBalance`. Ele não manda
    // `error_code` e nunca vai mandar: repetir dá o mesmo 403.
    const { wallet } = walletWith([{ status: 403, body: { error: 'Operação não permitida' } }]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('rejected');

    if (change.status === 'rejected') {
      expect(change.code).toBe('FORBIDDEN_FIELD');
    }
  });

  it('um error_code DESCONHECIDO recua, e nunca fecha a compra', async () => {
    // ####  A REGRA QUE SALVA O FUTURO  ####
    //
    // `rejected` significa "nunca repita", e FECHA a compra para
    // sempre. No dia em que o site criar um código novo — e ele vai
    // criar —, tratá-lo como defeito nosso mataria cada compra
    // tentada, uma por uma, em silêncio.
    const { wallet } = walletWith([
      { status: 400, body: { error: 'sei lá', error_code: 'CODIGO_QUE_NAO_EXISTE_AINDA' } },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      expect(change.cause).toBe('network');
    }
  });

  it('429 recua com throttle, e não vira defeito', async () => {
    const { wallet } = walletWith([
      { status: 429, body: { error: 'devagar', error_code: 'AGENT_RATE_LIMITED' } },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      expect(change.cause).toBe('throttled');
    }
  });

  it('timeout e 5xx são INDETERMINADOS: pode ter cobrado', async () => {
    // ####  O DESFECHO QUE NÃO EXISTIA  ####
    //
    // Os dois viravam `unavailable`, a compra fechava como `failed` e
    // ninguém voltava a conferir. Como `unknown`, ela fica aberta e o
    // relógio da reconciliação a resolve com prova.
    const timeout = walletWith([{ status: 0, throws: abortError() }]);
    const server = walletWith([{ status: 502, text: 'Bad Gateway' }]);

    expect((await timeout.wallet.debit(debitInput())).status).toBe('unknown');
    expect((await server.wallet.debit(debitInput())).status).toBe('unknown');
  });
});

describe('o estorno', () => {
  it('usa a referência da compra com ":refund", e nunca a mesma', async () => {
    // Com a MESMA chave, o site trataria o crédito como replay do
    // débito, responderia `idempotent: true` e NÃO creditaria — o
    // jogador ficaria sem o item E sem o dinheiro.
    const { wallet, fetch } = walletWith([
      { status: 200, body: { success: true, moedas: '500', direction: 'credit' } },
    ]);

    await wallet.credit({
      steamId: STEAM_ID,
      amount: 250,
      reference: REFERENCE,
      reason: 'Estorno: entrega falhou (INVENTORY_FULL)',
    });

    expect(fetch.calls[0]?.url).toBe('https://site.example/api/agent/ozcoins/credit');
    expect((fetch.calls[0]?.body as { referenceId: string }).referenceId).toBe(
      `${REFERENCE}:refund`,
    );
    // Estorno não é venda de catálogo: sem `productId`, ou o guard de
    // replay do site veria um crédito onde espera uma compra.
    expect(fetch.calls[0]?.body).not.toHaveProperty('productId');
  });

  it('um 422 no crédito é defeito, e não "saldo insuficiente"', async () => {
    // Crédito não fica sem saldo. Se acontecer, é defeito de
    // contrato — e defeito não se repete.
    const { wallet } = walletWith([{ status: 422, body: { error: 'impossível' } }]);

    const change = await wallet.credit({
      steamId: STEAM_ID,
      amount: 250,
      reference: REFERENCE,
      reason: 'Estorno: entrega falhou (INVENTORY_FULL)',
    });

    expect(change.status).toBe('rejected');
  });
});

describe('o saldo', () => {
  it('quando não dá para ler, é null — e nunca zero', async () => {
    // Zero é uma AFIRMAÇÃO sobre o dinheiro de alguém. Com ele, o
    // modal esconde o botão de comprar e diz SALDO INSUFICIENTE a
    // quem tem dinheiro — o oposto do que a loja mandou fazer.
    const { wallet } = walletWith([{ status: 500, text: 'boom' }]);

    expect((await wallet.getBalance(STEAM_ID)).balance).toBeNull();
  });

  it('lê "moedas" como string e devolve inteiro', async () => {
    const { wallet, fetch } = walletWith([
      { status: 200, body: { steamid: STEAM_ID, moedas: '500', exists: true } },
    ]);

    expect((await wallet.getBalance(STEAM_ID)).balance).toBe(500);
    // Query string, e não path: `/wallet/{steamId}` não existe.
    expect(fetch.calls[0]?.url).toBe(
      `https://site.example/api/agent/ozcoins/balance?steamId=${STEAM_ID}`,
    );
  });

  it('um saldo que não é inteiro vira null, e não NaN', async () => {
    const { wallet } = walletWith([{ status: 200, body: { moedas: 'muitas' } }]);

    expect((await wallet.getBalance(STEAM_ID)).balance).toBeNull();
  });
});

describe('a prova de cobrança', () => {
  it('200 com found prova que o dinheiro saiu', async () => {
    const { wallet, fetch } = walletWith([
      {
        status: 200,
        body: {
          found: true,
          transactionId: 918273,
          amount: '250',
          productId: 'kit-metal',
          direction: 'debit',
        },
      },
    ]);

    const proof = await wallet.proveCharge({ reference: REFERENCE, steamId: STEAM_ID });

    expect(proof.status).toBe('charged');

    if (proof.status === 'charged') {
      expect(proof.amount).toBe(250);
      expect(proof.transactionId).toBe('918273');
    }

    expect(fetch.calls[0]?.url).toContain('/api/agent/ozcoins/transaction?');
  });

  it('só REFERENCE_NOT_FOUND prova que NADA foi cobrado', async () => {
    const { wallet } = walletWith([
      {
        status: 404,
        body: { found: false, error: 'Nenhuma transação…', error_code: 'REFERENCE_NOT_FOUND' },
      },
    ]);

    expect((await wallet.proveCharge({ reference: REFERENCE, steamId: STEAM_ID })).status).toBe(
      'not-charged',
    );
  });

  it('REFERENCE_NOT_MINE é terminal, e NÃO prova de não-cobrança', async () => {
    // ####  O 404 QUE NÃO É PROVA  ####
    //
    // A linha EXISTE e não é desta identidade — é o que acontece
    // quando o `SITE_SERVER_ID` muda. Lê-lo como "nunca aconteceu"
    // fecharia a compra com o dinheiro do jogador fora da conta; e
    // lê-lo como `unknown` poria o settler batendo todo minuto num
    // 404 que nunca vai mudar.
    const { wallet } = walletWith([
      {
        status: 404,
        body: { found: false, error: 'Nenhuma transação…', error_code: 'REFERENCE_NOT_MINE' },
      },
    ]);

    const proof = await wallet.proveCharge({ reference: REFERENCE, steamId: STEAM_ID });

    expect(proof.status).toBe('unprovable');
  });

  it('400 é terminal; 500 é retentável — e trocá-los custa nos dois sentidos', async () => {
    // O 400 diz "a pergunta está torta", e nenhuma retentativa a
    // endireita. O 500 diz "a pergunta estava certa e eu falhei" — a
    // compra continua indeterminada e a volta seguinte resolve.
    const bad = walletWith([
      { status: 400, body: { error: 'referenceId inválido', error_code: 'INVALID_REFERENCE_ID' } },
    ]);
    const boom = walletWith([
      { status: 500, body: { error: 'quebrou', error_code: 'TRANSACTION_LOOKUP_FAILED' } },
    ]);

    expect((await bad.wallet.proveCharge({ reference: REFERENCE, steamId: STEAM_ID })).status).toBe(
      'unprovable',
    );
    expect(
      (await boom.wallet.proveCharge({ reference: REFERENCE, steamId: STEAM_ID })).status,
    ).toBe('unknown');
  });

  it('timeout não decide nada', async () => {
    const { wallet } = walletWith([{ status: 0, throws: abortError() }]);

    expect((await wallet.proveCharge({ reference: REFERENCE, steamId: STEAM_ID })).status).toBe(
      'unknown',
    );
  });
});
