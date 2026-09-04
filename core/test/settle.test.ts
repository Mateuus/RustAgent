// ============================================================
//  settle.test.ts  -  a compra presa sai do limbo, com PROVA.
//
//  Este arquivo guarda a invariante mais cara do projeto: NA DÚVIDA,
//  PRESERVA. Cada caso é um jeito de quebrá-la:
//
//    - prova 200  -> entrega o plano CONGELADO (não a oferta de hoje);
//    - prova 404  -> fecha SEM COBRAR NINGUÉM;
//    - sem prova  -> não decide NADA, e tenta no minuto seguinte;
//    - 400        -> sai do laço (terminal), e não bate para sempre;
//    - 500        -> CONTINUA no laço (retentável) — o oposto do 400;
//    - duas chamadas ao mesmo tempo produzem UMA entrega.
//
//  Nada aqui sai da máquina: a prova é um dublê escrito à mão.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StoreRepository, type StoreOfferInput } from '../src/db/store-repository.js';
import { WalletsRepository } from '../src/db/wallets-repository.js';
import { createLogger } from '../src/logger.js';
import { StoreService } from '../src/store/service.js';
import { SETTLE_MAX_ATTEMPTS, PurchaseSettler } from '../src/store/settle.js';
import {
  LocalWallet,
  type ChargeProofResult,
  type ChargeProver,
  type Wallet,
  type WalletChange,
  type WalletMoveInput,
} from '../src/store/wallet.js';

const SERVER = 'pvp1';
const STEAM_ID = '76561198000000000';
const NOW = 1_700_000_000_000;
const REFERENCE = 'rust:RUST01:loja:p1';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

/** Uma prova que responde o que o teste pedir, e conta as perguntas. */
function scriptedProof(answers: readonly ChargeProofResult[]): {
  readonly prover: ChargeProver;
  readonly asked: { reference: string; steamId: string }[];
} {
  const asked: { reference: string; steamId: string }[] = [];
  let at = 0;

  return {
    asked,
    prover: {
      proveCharge: (input) => {
        asked.push(input);

        const value = answers[Math.min(at, answers.length - 1)] ?? {
          status: 'unknown',
          reason: 'sem resposta programada',
        };

        at += 1;

        return Promise.resolve(value);
      },
    },
  };
}

interface Move {
  readonly kind: 'debit' | 'credit';
  readonly input: WalletMoveInput;
}

function scriptedWallet(answers: readonly WalletChange[]): {
  readonly wallet: Wallet;
  readonly moves: Move[];
} {
  const moves: Move[] = [];
  let at = 0;

  const answer = (): Promise<WalletChange> => {
    const value = answers[Math.min(at, answers.length - 1)] ?? {
      status: 'unavailable',
      reason: 'sem resposta programada',
      cause: 'network',
    };

    at += 1;

    return Promise.resolve(value);
  };

  return {
    moves,
    wallet: {
      source: 'remote',
      getBalance: (steamId) => Promise.resolve({ steamId, balance: 1_000, source: 'remote' }),
      debit: (input) => {
        moves.push({ kind: 'debit', input });

        return answer();
      },
      credit: (input) => {
        moves.push({ kind: 'credit', input });

        return answer();
      },
    },
  };
}

const PLAN = JSON.stringify({
  items: [{ shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', amount: 100 }],
  vehicle: null,
  vip: null,
  units: 1,
});

function harness(
  options: {
    readonly prover?: ChargeProver;
    readonly wallet?: Wallet;
    readonly rconUp?: boolean;
  } = {},
): {
  readonly repository: StoreRepository;
  readonly service: StoreService;
  readonly commands: string[];
} {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: SERVER,
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const repository = new StoreRepository(db);
  const commands: string[] = [];
  const rconUp = options.rconUp ?? true;

  const service = new StoreService({
    repository,
    wallet: options.wallet ?? new LocalWallet(new WalletsRepository(db)),
    servers: {
      contextOf: () => ({
        rcon: {
          isConnected: rconUp,
          send: (command: string): Promise<string> => {
            commands.push(command);

            return rconUp
              ? Promise.resolve('{"ok":true}')
              : Promise.resolve('{"ok":false,"error":"PLAYER_NOT_FOUND"}');
          },
        },
      }),
    },
    logger: silent,
    now: () => NOW,
    ...(options.prover === undefined ? {} : { proofFor: () => options.prover ?? null }),
  });

  return { repository, service, commands };
}

/** Uma compra já gravada no estado que o teste quer exercitar. */
function stuck(
  repository: StoreRepository,
  over: Partial<Parameters<StoreRepository['createPurchase']>[0]> = {},
): void {
  repository.createPurchase(
    {
      id: 'p1',
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: 'kit-metal',
      offerName: 'Kit Metal',
      shortname: 'metal.refined',
      skinId: '0',
      amount: 1,
      unitPrice: 250,
      totalPrice: 250,
      state: 'charge-unknown',
      error: 'CHARGE_UNKNOWN',
      reference: REFERENCE,
      siteTransactionId: null,
      delivery: PLAN,
      settleAttempts: 0,
      settlingAt: null,
      ...over,
    },
    NOW,
  );
}

function offer(): StoreOfferInput {
  return {
    categoryId: 'cat',
    kind: 'item',
    name: 'Kit Metal',
    price: 250,
    position: 1,
    enabled: true,
    icon: { shortname: 'metal.refined', itemId: 69_511_070, skinId: '0' },
    items: [{ shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', amount: 100 }],
    vip: null,
    vehicle: null,
    badge: null,
    oldPrice: null,
    perks: [],
  };
}

describe('a compra indeterminada, com prova', () => {
  it('cobrança PROVADA: entrega o plano congelado e fecha', async () => {
    const { prover, asked } = scriptedProof([
      { status: 'charged', amount: 250, transactionId: '918273', productId: 'kit-metal' },
    ]);
    const { repository, service, commands } = harness({ prover });

    stuck(repository);

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('delivered');

    const purchase = repository.getPurchase(SERVER, 'p1');

    expect(purchase?.state).toBe('delivered');
    // O id do ledger fica gravado: é o que responde "eu paguei e não
    // recebi" meses depois.
    expect(purchase?.siteTransactionId).toBe('918273');
    // O plano CONGELADO é o que vale — e não a oferta de hoje, que
    // pode ter sido editada no meio.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('metal.refined 100');
    expect(asked[0]?.reference).toBe(REFERENCE);
  });

  it('404: fecha SEM COBRAR NINGUÉM', async () => {
    // ####  A PROVA DE NÃO-COBRANÇA  ####
    //
    // É ela que permite cancelar uma compra indeterminada sem cobrar
    // o jogador que já fechou o jogo e desistiu.
    const { prover } = scriptedProof([{ status: 'not-charged' }]);
    const { wallet, moves } = scriptedWallet([]);
    const { repository, service, commands } = harness({ prover, wallet });

    stuck(repository);

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('cancelled');

    const purchase = repository.getPurchase(SERVER, 'p1');

    expect(purchase?.state).toBe('failed');
    expect(purchase?.error).toBe('CHARGE_NEVER_HAPPENED');
    // Nenhum débito e nenhum crédito: nada aconteceu, e nada é
    // inventado agora.
    expect(moves).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  it('sem prova: NÃO decide nada, e o estado não muda', async () => {
    const { prover } = scriptedProof([{ status: 'unknown', reason: 'o site não respondeu' }]);
    const { repository, service, commands } = harness({ prover });

    stuck(repository);

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBeNull();
    // A compra continua aberta, esperando o minuto seguinte.
    expect(repository.getPurchase(SERVER, 'p1')?.state).toBe('charge-unknown');
    expect(commands).toHaveLength(0);
  });

  it('400 é TERMINAL e 500 é RETENTÁVEL — trocá-los custa nos dois sentidos', async () => {
    // O 400 diz "a pergunta está torta", e nenhuma retentativa a
    // endireita: como retentável, o settler bateria todo minuto até
    // o teto. O 500 diz "a pergunta estava certa e eu falhei": como
    // terminal, mandaria para conferência humana o que a volta
    // seguinte resolveria sozinha.
    const terminal = scriptedProof([{ status: 'unprovable', reason: 'INVALID_REFERENCE_ID' }]);
    const retryable = scriptedProof([{ status: 'unknown', reason: 'TRANSACTION_LOOKUP_FAILED' }]);

    const a = harness({ prover: terminal.prover });

    stuck(a.repository);

    expect(await a.service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('review');
    expect(a.repository.getPurchase(SERVER, 'p1')?.state).toBe('failed');
    expect(a.repository.getPurchase(SERVER, 'p1')?.error).toContain('CHARGE_UNPROVABLE');

    const b = harness({ prover: retryable.prover });

    stuck(b.repository);

    expect(await b.service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBeNull();
    expect(b.repository.getPurchase(SERVER, 'p1')?.state).toBe('charge-unknown');
  });

  it('cobrança provada e plano AUSENTE: não entrega nada', async () => {
    // O dinheiro saiu e não sabemos o que prometemos. Entregar "o que
    // der" seria inventar a compra de alguém.
    const { prover } = scriptedProof([
      { status: 'charged', amount: 250, transactionId: '1', productId: null },
    ]);
    const { repository, service, commands } = harness({ prover });

    stuck(repository, { delivery: null });

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('review');
    expect(repository.getPurchase(SERVER, 'p1')?.error).toBe('PLAN_MISSING');
    expect(commands).toHaveLength(0);
  });

  it('duas chamadas concorrentes produzem UMA entrega', async () => {
    // ####  O RELÓGIO E O BOTÃO PODEM CAIR NA MESMA LINHA  ####
    //
    // Sem a reivindicação, as duas veriam a prova 200, as duas
    // gravariam `debited` e as duas entregariam — item duplicado,
    // uma cobrança.
    const { prover } = scriptedProof([
      { status: 'charged', amount: 250, transactionId: '1', productId: null },
    ]);
    const { repository, service, commands } = harness({ prover });

    stuck(repository);

    const [first, second] = await Promise.all([
      service.settle({ serverId: SERVER, purchaseId: 'p1' }),
      service.settle({ serverId: SERVER, purchaseId: 'p1' }),
    ]);

    // Uma decide; a outra devolve `null` por não ter conseguido a
    // reivindicação.
    expect([first, second].filter((outcome) => outcome === 'delivered')).toHaveLength(1);
    expect([first, second].filter((outcome) => outcome === null)).toHaveLength(1);
    expect(commands).toHaveLength(1);
  });

  it('depois do teto de tentativas, a compra SAI do laço', async () => {
    const { prover, asked } = scriptedProof([{ status: 'unknown', reason: 'nada' }]);
    const { repository, service } = harness({ prover });

    stuck(repository, { settleAttempts: SETTLE_MAX_ATTEMPTS + 1 });

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('review');
    // Ela nem pergunta: o teto existe para o settler parar de bater.
    expect(asked).toHaveLength(0);
    expect(repository.getPurchase(SERVER, 'p1')?.error).toContain('CHARGE_UNPROVABLE');
  });

  it('sem referência gravada, não há o que perguntar', async () => {
    // A compra que morreu entre a criação da linha e a gravação, e as
    // anteriores à migração 035.
    const { prover, asked } = scriptedProof([{ status: 'not-charged' }]);
    const { repository, service } = harness({ prover });

    stuck(repository, { state: 'pending', error: null, reference: null });

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('review');
    expect(asked).toHaveLength(0);
    expect(repository.getPurchase(SERVER, 'p1')?.error).toBe('CHARGE_UNKNOWN_NO_REFERENCE');
  });

  it('sem carteira do site (rollback), a chamada não decide nada', async () => {
    // Depois de esvaziar `SITE_BASE_URL` não há como provar nada: a
    // rota existe, responde, e não muda estado.
    const { repository, service } = harness();

    stuck(repository);

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBeNull();
    expect(repository.getPurchase(SERVER, 'p1')?.state).toBe('charge-unknown');
  });
});

describe('o estorno retentável', () => {
  it('REFUND_RETRYABLE repete o crédito com a MESMA chave', async () => {
    const { wallet, moves } = scriptedWallet([
      { status: 'ok', balance: 1_250, transactionId: '2', replayed: false },
    ]);
    const { prover } = scriptedProof([{ status: 'not-charged' }]);
    const { repository, service } = harness({ wallet, prover });

    stuck(repository, { state: 'failed', error: 'REFUND_RETRYABLE: o site não respondeu' });

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('refunded');
    expect(repository.getPurchase(SERVER, 'p1')?.state).toBe('refunded');
    // A referência da COMPRA: o `:refund` é derivado dentro da
    // carteira, e repetir com ele é seguro.
    expect(moves[0]?.kind).toBe('credit');
    expect(moves[0]?.input.reference).toBe(REFERENCE);
  });

  it('um crédito RECUSADO sai do laço, e não vira retry eterno', async () => {
    const { wallet } = scriptedWallet([
      { status: 'rejected', code: 'INVALID_REFERENCE_ID', reason: 'torta', charged: null },
    ]);
    const { prover } = scriptedProof([{ status: 'not-charged' }]);
    const { repository, service } = harness({ wallet, prover });

    stuck(repository, { state: 'failed', error: 'REFUND_RETRYABLE: o site não respondeu' });

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('review');
    // O prefixo muda, e é ele que a varredura lê: `REFUND_REJECTED`
    // não entra mais.
    expect(repository.getPurchase(SERVER, 'p1')?.error).toContain('REFUND_REJECTED');
  });
});

describe('o que a varredura pega', () => {
  it('respeita as três idades: 90 s, 5 min e 5 min', () => {
    const { repository } = harness();

    // Uma indeterminada NOVA não entra: o site pode estar terminando
    // de processar, e cancelá-la agora seria a decisão errada.
    stuck(repository, { id: 'nova' } as never);
    repository.setPurchaseState(SERVER, 'nova', 'charge-unknown', 'CHARGE_UNKNOWN', NOW);

    const fresh = repository.listStuck({
      unknownCutoff: NOW - 90_000,
      debitedCutoff: NOW - 300_000,
      orphanCutoff: NOW - 300_000,
      limit: 50,
    });

    expect(fresh).toHaveLength(0);

    // Com 91 s ela entra.
    repository.setPurchaseState(SERVER, 'nova', 'charge-unknown', 'CHARGE_UNKNOWN', NOW - 91_000);

    expect(
      repository.listStuck({
        unknownCutoff: NOW - 90_000,
        debitedCutoff: NOW - 300_000,
        orphanCutoff: NOW - 300_000,
        limit: 50,
      }),
    ).toHaveLength(1);
  });

  it('um "failed" comum NÃO entra; com REFUND_RETRYABLE, entra', () => {
    // Sem esse filtro, o settler reprocessaria toda compra recusada
    // por saldo insuficiente.
    const { repository } = harness();

    stuck(repository);
    repository.setPurchaseState(SERVER, 'p1', 'failed', 'INSUFFICIENT_FUNDS', NOW - 600_000);

    const cutoffs = {
      unknownCutoff: NOW - 90_000,
      debitedCutoff: NOW - 300_000,
      orphanCutoff: NOW - 300_000,
      limit: 50,
    };

    expect(repository.listStuck(cutoffs)).toHaveLength(0);

    repository.setPurchaseState(SERVER, 'p1', 'failed', 'REFUND_RETRYABLE: timeout', NOW - 600_000);

    expect(repository.listStuck(cutoffs)).toHaveLength(1);
  });
});

describe('o relógio', () => {
  it('varre e nunca lança, mesmo com uma compra que estoura', async () => {
    const { repository, service } = harness({
      prover: {
        proveCharge: () => Promise.reject(new Error('boom')),
      },
    });

    stuck(repository);
    repository.setPurchaseState(SERVER, 'p1', 'charge-unknown', 'CHARGE_UNKNOWN', NOW - 600_000);

    const settler = new PurchaseSettler({
      service,
      repository,
      logger: silent,
      now: () => NOW,
    });

    // Um `throw` aqui pararia a reconciliação em silêncio, que é o
    // pior jeito de um relógio falhar.
    await expect(settler.sweep(NOW)).resolves.toBeUndefined();
    // E a compra continua lá, para a volta seguinte.
    expect(repository.getPurchase(SERVER, 'p1')?.state).toBe('charge-unknown');
  });

  it('a oferta pode ter sido apagada: o plano congelado ainda entrega', async () => {
    const { prover } = scriptedProof([
      { status: 'charged', amount: 250, transactionId: '1', productId: null },
    ]);
    const { repository, service, commands } = harness({ prover });

    repository.saveCategory('cat', { name: 'Kits', position: 1, enabled: true }, NOW);
    repository.saveOffer('kit-metal', offer(), NOW);
    stuck(repository);
    // O admin apaga a oferta entre a compra e a reconciliação.
    repository.removeOffer('kit-metal');

    expect(await service.settle({ serverId: SERVER, purchaseId: 'p1' })).toBe('delivered');
    expect(commands[0]).toContain('metal.refined 100');
  });
});
