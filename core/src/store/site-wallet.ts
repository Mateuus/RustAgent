// ============================================================
//  site-wallet.ts  -  a carteira do SITE OrigemZ.
//
//  ####  O SITE É O DONO DO DINHEIRO  ####
//
//  Esta é a segunda implementação de `Wallet`, e a única que fala
//  com alguém de fora. A `LocalWallet` continua existindo para quem
//  não ligou a integração; a antiga `RemoteWallet` foi aposentada
//  porque falava um contrato que nenhum servidor jamais respondeu:
//  `/wallet/{steamId}`, `Idempotency-Key` no header, 409 para saldo
//  insuficiente.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO SÓ TRADUZ PROTOCOLO  ####
//
//  Ele não sabe o que é `fetch` (isso é do `SiteClient`) e não sabe
//  o que é uma compra (isso é do `StoreService`). O que ele sabe é
//  transformar "HTTP 422 com uma frase" em `insufficient`, e
//  "timeout" em `unknown`.
//
//  ####  CINCO DESFECHOS, E O QUINTO É O QUE FALTAVA  ####
//
//  `unknown` significa PODE TER COBRADO. Ele nasce de timeout, de
//  erro de rede, de 5xx e de um 200 que não deu para entender — e é
//  o único que não fecha a compra. Sem ele, uma resposta perdida no
//  caminho deixa o jogador cobrado e sem item, e nada volta a
//  conferir. Ver Docs\20 §4 e §11.
//
//  ####  409 NÃO É SALDO INSUFICIENTE  ####
//
//  No site, 409 é reuso de `referenceId`, e em três dos quatro
//  códigos ele vem com `charged` — o dinheiro JÁ SAIU. Saldo
//  insuficiente é 422. Ler um pelo outro inverteria o desfecho mais
//  perigoso do protocolo.
//
//  ####  UMA CARTEIRA POR PAREAMENTO  ####
//
//  O `SiteClient` que ela recebe carrega o bearer e o `X-Server-Id`
//  de UM servidor. Com N servidores de Rust pareados, existem N
//  destas — e é o `StoreService` que escolhe a do servidor onde a
//  compra aconteceu.
// ============================================================

import type { Logger } from '../logger.js';
import type { SiteClient, SiteResult } from '../site/client.js';
import { refundReferenceOf } from './reference.js';
import type {
  ChargeProofResult,
  ChargeProver,
  Wallet,
  WalletBalance,
  WalletChange,
  WalletMoveInput,
} from './wallet.js';

export interface SiteWalletOptions {
  readonly client: SiteClient;
  readonly logger?: Logger | undefined;
  /**
   * Chamado quando uma resposta diz que o PAREAMENTO quebrou.
   *
   * É o que faz o agente descobrir em segundos — e não em minutos —
   * que o token foi rotacionado: o `SiteBeacon` marca o pareamento
   * como suspeito e força uma batida. Opcional porque o teste da
   * carteira não constrói beacon nenhum.
   */
  readonly onPairingSuspect?: ((reason: string) => void) | undefined;
}

export class SiteWallet implements Wallet, ChargeProver {
  readonly source = 'remote' as const;
  readonly #client: SiteClient;
  readonly #logger: Logger | undefined;
  readonly #onPairingSuspect: ((reason: string) => void) | undefined;
  // A saúde da carteira, para a tela de estado. Ela mora aqui porque
  // é aqui que as respostas passam — e uma segunda contagem em outro
  // lugar discordaria desta no primeiro erro.
  #lastOkAt: number | null = null;
  #lastError: string | null = null;

  constructor(options: SiteWalletOptions) {
    this.#client = options.client;
    this.#logger = options.logger;
    this.#onPairingSuspect = options.onPairingSuspect;
  }

  /** O id deste pareamento NO SITE. Para log e para a tela. */
  get siteServerId(): string {
    return this.#client.serverId;
  }

  /** O que a tela de status mostra. Nunca inclui segredo. */
  get health(): { readonly lastOkAt: number | null; readonly lastError: string | null } {
    return { lastOkAt: this.#lastOkAt, lastError: this.#lastError };
  }

  /**
   * O saldo, ou `null` quando não deu para perguntar.
   *
   * `null` e não zero: a vitrine continua abrindo (é a razão do
   * comportamento antigo), mas o modal para de dizer SALDO
   * INSUFICIENTE a quem tem dinheiro.
   *
   * `exists` da resposta é IGNORADO de propósito: ele é sempre
   * `true`, porque o `findOrCreate` do site cria a conta na própria
   * consulta. Ramificar por ele seria ramificar por algo que nunca
   * é falso.
   */
  async getBalance(steamId: string): Promise<WalletBalance> {
    const result = await this.#client.balance(steamId);

    if (!result.ok) {
      this.#lastError = result.reason;
      this.#logger?.warn(
        { steamId, status: result.status, code: result.code },
        'site wallet did not answer the balance',
      );

      return { steamId, balance: null, source: this.source };
    }

    // Já vem `balance`, inteiro, traduzido no `SiteClient`.
    const { balance } = result.body;

    if (balance === null) {
      this.#lastError = 'o site respondeu um saldo que não é inteiro';
      this.#logger?.warn({ steamId }, 'site wallet answered a balance that is not an integer');

      return { steamId, balance: null, source: this.source };
    }

    this.#lastOkAt = Date.now();
    this.#lastError = null;

    return { steamId, balance, source: this.source };
  }

  debit(input: WalletMoveInput): Promise<WalletChange> {
    return this.#move('debit', input, input.reference);
  }

  /**
   * Devolve ao saldo.
   *
   * ####  A CHAVE DO ESTORNO É `:refund`, E ELA É DERIVADA AQUI  ####
   *
   * Usando a MESMA referência do débito, o site trataria o crédito
   * como replay do débito, responderia `idempotent: true` e NÃO
   * creditaria — o jogador ficaria sem o item E sem o dinheiro, com
   * uma resposta de sucesso em todo lugar que alguém fosse olhar.
   *
   * Derivada aqui, e não montada por quem chama, porque é a carteira
   * que conhece o dialeto do dono do saldo.
   */
  credit(input: WalletMoveInput): Promise<WalletChange> {
    // Estorno não é venda de catálogo: `productId` fica de fora, ou
    // o guard de replay do site passaria a ver um crédito onde
    // espera uma compra.
    return this.#move(
      'credit',
      { ...input, productId: undefined },
      refundReferenceOf(input.reference),
    );
  }

  async proveCharge(input: {
    readonly reference: string;
    readonly steamId: string;
  }): Promise<ChargeProofResult> {
    const result = await this.#client.transaction(input.reference, input.steamId);

    if (result.ok) {
      if (!result.body.found) {
        // 200 com `found: false` não é o contrato (o site responde
        // 404), mas um 200 que nega a transação sem o código não
        // prova nada — e prova é o que esta chamada existe para dar.
        return { status: 'unknown', reason: 'o site respondeu 200 sem encontrar a transação' };
      }

      return {
        status: 'charged',
        amount: result.body.amount ?? 0,
        transactionId: result.body.transactionId,
        productId: result.body.productId,
      };
    }

    // ####  SÓ `REFERENCE_NOT_FOUND` É PROVA  ####
    //
    // O site devolve 404 com o MESMO CORPO para três casos — não
    // existe, é de outro jogador, é de outro servidor —, mas com
    // DOIS códigos. Só o primeiro prova que nada foi cobrado. Ler os
    // outros dois como prova transformaria uma cobrança REAL em
    // "nunca aconteceu" toda vez que o `SITE_SERVER_ID` mudasse — e
    // fecharia a compra com o dinheiro do jogador fora da conta.
    if (result.status === 404 && result.code === 'REFERENCE_NOT_FOUND') {
      return { status: 'not-charged' };
    }

    // ####  `REFERENCE_NOT_MINE` É TERMINAL, E NÃO `unknown`  ####
    //
    // A linha EXISTE e não é desta identidade. Nem prova de
    // cobrança, nem prova de não-cobrança — e nenhuma retentativa
    // muda isso, porque o `referenceId` e o `steamId` gravados não
    // mudam sozinhos. Devolver `unknown` aqui poria o settler
    // batendo no site todo minuto até o teto. Sai do laço e vai para
    // gente.
    if (result.status === 404 && result.code === 'REFERENCE_NOT_MINE') {
      return { status: 'unprovable', reason: 'REFERENCE_NOT_MINE' };
    }

    // 400 é PERMANENTE: a referência ou o steamId gravados não
    // passam na régua do site, e nenhuma retentativa muda isso. Sem
    // este ramo o settler bate todo minuto, para sempre, num pedido
    // que nunca vai passar — contra um canal sem rate-limit.
    if (result.status === 400) {
      return { status: 'unprovable', reason: result.code ?? result.reason };
    }

    if (PAIRING_CODES.has(result.code ?? '')) {
      this.#onPairingSuspect?.(result.code ?? 'PAIRING');
    }

    // Tudo o mais — 403, 429, 5xx, timeout — é "não sei", e não
    // decide nada. O settler tenta de novo no minuto seguinte.
    return { status: 'unknown', reason: result.reason };
  }

  // ------------------------------------------------------------
  //  A tradução — a tabela do §4.2 do manual, em código
  // ------------------------------------------------------------

  async #move(
    direction: 'debit' | 'credit',
    input: WalletMoveInput,
    referenceId: string,
  ): Promise<WalletChange> {
    const result = await this.#client.mutate(direction, {
      steamId: input.steamId,
      // Sempre positivo e inteiro: o sentido é da ROTA.
      amount: Math.abs(Math.trunc(input.amount)),
      referenceId,
      reason: input.reason,
      ...(input.productId === undefined ? {} : { productId: input.productId }),
    });

    if (result.ok) {
      // `balance`, `transactionId` e `idempotent` já vêm com o nome
      // da casa e com o tipo certo — a tradução é do `SiteClient`.
      const { balance } = result.body;

      if (balance === null || !result.body.success) {
        // 200 que não dá para entender PODE TER COBRADO. Nunca `ok`.
        return {
          status: 'unknown',
          reason: 'o site respondeu 200 com um corpo que não dá para ler',
        };
      }

      this.#lastOkAt = Date.now();
      this.#lastError = null;

      return {
        status: 'ok',
        balance,
        transactionId: result.body.transactionId,
        // ####  `replayed` FALA DA COBRANÇA, NÃO DO SALDO  ####
        //
        // Num replay, `balance` é o saldo NO MOMENTO DA COBRANÇA
        // ORIGINAL — o site devolve o `after_balance` da linha
        // gravada, que pode ser de horas atrás. Ele serve para
        // conferência, NUNCA para a tela: quem for exibir saldo relê
        // com `getBalance`.
        replayed: result.body.idempotent,
      };
    }

    return this.#classify(direction, result);
  }

  #classify(
    direction: 'debit' | 'credit',
    result: Extract<SiteResult<never>, { ok: false }>,
  ): WalletChange {
    const { status, code, reason, body } = result;

    this.#lastError = reason;

    // Sem status = não chegou no site: timeout, DNS, TLS, cabo. Pode
    // ter cobrado se o corte foi na VOLTA, e é por isso que isto é
    // `unknown` e não `unavailable`.
    if (status === null) {
      return { status: 'unknown', reason };
    }

    if (status >= 500) {
      return { status: 'unknown', reason };
    }

    if (status === 429) {
      return { status: 'unavailable', reason, cause: 'throttled' };
    }

    if (PAIRING_CODES.has(code ?? '')) {
      // O beacon precisa saber AGORA: é assim que o agente descobre
      // em segundos, e não em minutos, que o token foi rotacionado
      // ou que o IP saiu da allowlist.
      this.#onPairingSuspect?.(code ?? 'PAIRING');

      return { status: 'unavailable', reason, cause: 'pairing' };
    }

    // O 403 da BORDA, em texto puro. Não é ban e não é pareamento: é
    // o User-Agent recusado. Insistir com o nosso resolve.
    if (status === 403 && code === null && /error code: 1010/i.test(reason)) {
      return { status: 'unavailable', reason, cause: 'network' };
    }

    if (status === 422) {
      // Num crédito isto é impossível (crédito não fica sem saldo).
      // Se acontecer, é defeito — e defeito não se repete.
      if (direction === 'credit') {
        return { status: 'rejected', code: 'CREDIT_422', reason, charged: null };
      }

      return {
        status: 'insufficient',
        // ####  NUNCA ZERO  ####
        //
        // O 422 do site traz `balance`, `required` e `missing` como
        // NUMBER. `null` quando o site é anterior a esse ajuste — e
        // `null` é "não perguntei", que é diferente de "não tem". Um
        // `0` fixo aqui viajaria até o corpo do 409 de `/store/buy` e
        // até o painel, dizendo a um jogador com dinheiro que ele
        // está zerado.
        balance: typeof body?.balance === 'number' ? Math.trunc(body.balance) : null,
        // A FRASE DO SITE, CRUA: quem sabe quanto falta é o dono do
        // saldo, inclusive depois de uma compra feita no site
        // enquanto o jogador olhava o modal.
        message: reason,
      };
    }

    // 409 = reuso de referenceId. `charged` preenchido = O DINHEIRO
    // SAIU numa cobrança anterior com esta mesma chave.
    if (status === 409) {
      return {
        status: 'rejected',
        code: code ?? 'REFERENCE_ID_REUSED',
        reason,
        charged: typeof body?.charged === 'number' ? Math.trunc(body.charged) : null,
      };
    }

    // Os 4xx que o agente RECONHECE como defeito dele.
    if (REJECTED_CODES.has(code ?? '')) {
      return { status: 'rejected', code: code ?? 'BAD_REQUEST', reason, charged: null };
    }

    if (status === 400 && code === null) {
      // 400 SEM código nenhum é o corpo torto de hoje (o site ainda
      // não subiu os `error_code` das validações de entrada):
      // defeito nosso, com certeza.
      return { status: 'rejected', code: 'BAD_REQUEST', reason, charged: null };
    }

    // O 403 do middleware global do site: o corpo levava um campo
    // chamado `balance`, `ozBalance` ou `epBalance`. Ele não tem
    // `error_code` e nunca vai ter — é defeito NOSSO, e repetir o
    // mesmo corpo dá o mesmo 403 para sempre. É a única exceção
    // `rejected` sem código além do 400 acima, e ela é reconhecida
    // pela FRASE porque é só o que o site manda.
    if (status === 403 && code === null && /opera[çc][ãa]o n[ãa]o permitida/i.test(reason)) {
      return { status: 'rejected', code: 'FORBIDDEN_FIELD', reason, charged: null };
    }

    // ####  4xx DESCONHECIDO RECUA; NÃO DESISTE  ####
    //
    // `rejected` significa "nunca repita", e ele FECHA a compra como
    // `failed`, para sempre. Um código que o agente não conhece não
    // pode carregar esse peso: no dia em que o site criar um novo —
    // e ele vai criar, `AGENT_IP_NOT_ALLOWED` e `AGENT_RATE_LIMITED`
    // nasceram assim —, a escolha errada mata cada compra tentada,
    // uma por uma, em silêncio. Errar para `unavailable` custa uma
    // espera; errar para `rejected` custa a loja.
    this.#logger?.warn(
      { status, code },
      'site answered a 4xx with an error_code this agent does not know; backing off',
    );

    return { status: 'unavailable', reason, cause: 'network' };
  }
}

/**
 * Os códigos que significam "o pareamento está quebrado".
 *
 * Todos eles: (a) viram `unavailable` / `pairing`, (b) fazem a loja
 * responder INDISPONÍVEL em vez de fechar a compra, e (c) acordam o
 * beacon por `onPairingSuspect`.
 *
 * Exportado porque o retrato periódico (`site/status.ts`) lê a MESMA
 * lista: uma segunda cópia discordaria desta no dia em que o site
 * criasse um código novo de pareamento.
 */
export const PAIRING_CODES = new Set([
  'MISSING_BEARER',
  'BEARER_MISMATCH',
  'AGENT_NOT_ACTIVE',
  'AGENT_NOT_FOUND',
  'MISSING_SERVER_ID',
  // O IP saiu da allowlist do site. NÃO é defeito do pedido: é
  // pareamento, e o conserto é no admin do site. Sem esta linha, um
  // IP residencial que troque fecharia cada compra como `failed`,
  // uma por uma, sem retentativa e sem alarme.
  'AGENT_IP_NOT_ALLOWED',
  // Só aparecem na resposta do beacon, mas moram aqui porque a
  // classificação é a mesma e uma segunda lista discordaria desta.
  'BEACON_SIGNATURE_MISSING',
  'BEACON_TIMESTAMP_INVALID',
  'BEACON_NO_CREDENTIALS',
  'BEACON_SIGNATURE_MISMATCH',
]);

/**
 * Os 4xx que são defeito NOSSO, e por isso nunca se repetem com o
 * mesmo corpo. Lista FECHADA: o que não está aqui recua.
 */
const REJECTED_CODES = new Set([
  'INVALID_STEAM_ID',
  'INVALID_AMOUNT',
  'INVALID_REFERENCE_ID',
  'INVALID_PRODUCT_ID',
  'REFERENCE_ID_REUSED',
  'REFERENCE_ID_AMOUNT_MISMATCH',
  'REFERENCE_ID_PRODUCT_MISMATCH',
]);
