// ============================================================
//  store-charge.test.ts  -  a compra com os CINCO desfechos.
//
//  O `store.test.ts` cobre a compra feliz e o estorno; este cobre o
//  que nasceu com a integração do site, e cada caso aqui é um jeito
//  de perder dinheiro que existia antes:
//
//    1. `unknown` NÃO entrega e NÃO estorna — e não fecha a compra;
//    2. `rejected` fecha, e nunca é repetido;
//    3. o teto de OZ recusa ANTES de criar linha e de falar com o
//       dono do saldo;
//    4. o débito leva `productId` e a referência com prefixo;
//    5. o estorno usa `:refund`, nunca a chave da compra;
//    6. a loja sem pareamento diz INDISPONÍVEL, e a frase não pode
//       conter a palavra "saldo";
//    7. um segundo clique não abre uma segunda compra.
//
//  Nada aqui sai da máquina: a carteira é um dublê escrito à mão.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StoreRepository, type StoreOfferInput } from '../src/db/store-repository.js';
import { WalletsRepository } from '../src/db/wallets-repository.js';
import { ApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import { buildReference } from '../src/store/reference.js';
import { StoreService, describePurchase } from '../src/store/service.js';
import { LocalWallet, type Wallet, type WalletChange, type WalletMoveInput } from '../src/store/wallet.js';

const SERVER = 'pvp1';
const SITE_SERVER = 'RUST01';
const STEAM_ID = '76561198000000000';
const NOW = 1_700_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

/** O que a carteira recebeu, para o teste conferir o corpo. */
interface Move {
  readonly kind: 'debit' | 'credit';
  readonly input: WalletMoveInput;
}

/**
 * Uma carteira que devolve o desfecho que o teste pedir.
 *
 * Objeto literal escrito à mão, no molde da casa: dublê de
 * biblioteca esconderia justamente o que este arquivo quer ver, que
 * é o corpo exato que sai daqui.
 */
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
      getBalance: (steamId) => Promise.resolve({ steamId, balance: 10_000, source: 'remote' }),
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

interface FakeServer {
  readonly commands: string[];
  connected: boolean;
}

function harness(
  options: {
    readonly wallet?: Wallet;
    readonly ready?: (serverId: string) => boolean;
    readonly maxOzPerPurchase?: number;
    readonly paired?: boolean;
  } = {},
): {
  readonly db: AgentDatabase;
  readonly repository: StoreRepository;
  readonly service: StoreService;
  readonly server: FakeServer;
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
  const server: FakeServer = { commands: [], connected: true };
  const paired = options.paired ?? true;

  const service = new StoreService({
    repository,
    wallet: options.wallet ?? new LocalWallet(new WalletsRepository(db)),
    servers: {
      contextOf: () => ({
        rcon: {
          get isConnected(): boolean {
            return server.connected;
          },
          send: (command: string): Promise<string> => {
            if (!server.connected) {
              // O MESMO erro do RCON de verdade: um `ApiError` com
              // `code`, e a mensagem em português. Quem lê a
              // mensagem em vez do código classifica isto como
              // falha desconhecida.
              return Promise.reject(
                new ApiError(
                  'RCON_UNAVAILABLE',
                  `O agente não está conectado ao RCON do servidor "${SERVER}".`,
                  503,
                ),
              );
            }

            server.commands.push(command);

            return Promise.resolve('{"ok":true}');
          },
        },
      }),
    },
    logger: silent,
    now: () => NOW,
    newId: ((): (() => string) => {
      let count = 0;

      return (): string => `p${String((count += 1))}`;
    })(),
    ...(options.ready === undefined ? {} : { ready: options.ready }),
    ...(options.maxOzPerPurchase === undefined
      ? {}
      : { maxOzPerPurchase: options.maxOzPerPurchase }),
    ...(paired
      ? { newReference: (_serverId, id) => buildReference(SITE_SERVER, 'loja', id) }
      : {}),
  });

  return { db, repository, service, server };
}

function offer(over: Partial<StoreOfferInput> = {}): StoreOfferInput {
  return {
    categoryId: 'cat',
    kind: 'item',
    name: 'Kit Metal',
    price: 250,
    position: 1,
    enabled: true,
    icon: { shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', file: null },
    items: [{ shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', amount: 100 }],
    vip: null,
    vehicle: null,
    badge: null,
    oldPrice: null,
    perks: [],
    ...over,
  };
}

function withOffer(
  repository: StoreRepository,
  over: Partial<StoreOfferInput> = {},
  offerId = 'kit-metal',
): { readonly offerId: string } {
  repository.saveCategory('cat', { name: 'Kits', position: 1, enabled: true }, NOW);
  repository.saveOffer(offerId, offer(over), NOW);

  return { offerId };
}

describe('a compra quando o dono do saldo não responde direito', () => {
  it('INDETERMINADO não entrega, não estorna e não fecha a compra', async () => {
    // ####  O DESFECHO QUE O DOCUMENTO INTEIRO EXISTE PARA CRIAR  ####
    //
    // Antes, um timeout virava `failed` — o mesmo estado de "não
    // tinha saldo". O jogador pagava, não recebia, e nada voltava a
    // olhar aquela linha.
    const { wallet, moves } = scriptedWallet([
      { status: 'unknown', reason: 'o site não respondeu em 5 s' },
    ]);
    const { repository, service, server } = harness({ wallet });
    const { offerId } = withOffer(repository);

    const outcome = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 1,
    });

    expect(outcome.status).toBe('charge-unknown');

    const purchase = repository.getPurchase(SERVER, 'p1');

    expect(purchase?.state).toBe('charge-unknown');
    expect(purchase?.error).toBe('CHARGE_UNKNOWN');
    // Nada entregue: o comando não saiu.
    expect(server.commands).toHaveLength(0);
    // Nada estornado: só houve o débito.
    expect(moves).toHaveLength(1);
    // A frase manda CONFERIR, e não tentar de novo — tentar aqui é
    // arriscar pagar duas vezes.
    expect(describePurchase(outcome)).toContain('Confira');
    expect(describePurchase(outcome)).not.toContain('Tente de novo');
  });

  it('RECUSADO fecha a compra com o código, e guarda o valor cobrado', async () => {
    const { wallet, moves } = scriptedWallet([
      {
        status: 'rejected',
        code: 'REFERENCE_ID_AMOUNT_MISMATCH',
        reason: 'esse referenceId já foi usado',
        charged: 250,
      },
    ]);
    const { repository, service, server } = harness({ wallet });
    const { offerId } = withOffer(repository);

    const outcome = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 1,
    });

    expect(outcome.status).toBe('charge-rejected');

    const purchase = repository.getPurchase(SERVER, 'p1');

    expect(purchase?.state).toBe('failed');
    // O valor cobrado fica GRAVADO: é conferência humana, e sem o
    // número ninguém sabe quanto devolver.
    expect(purchase?.error).toBe('CHARGE_REJECTED: REFERENCE_ID_AMOUNT_MISMATCH charged=250');
    expect(server.commands).toHaveLength(0);
    expect(moves).toHaveLength(1);
    // O jogador não resolve um 409: a frase manda avisar a
    // administração, sem detalhe técnico.
    expect(describePurchase(outcome)).toContain('administração');
  });

  it('a compra indeterminada conta como PRESA nas estatísticas', async () => {
    const { wallet } = scriptedWallet([{ status: 'unknown', reason: 'timeout' }]);
    const { repository, service } = harness({ wallet });
    const { offerId } = withOffer(repository);

    await service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId, quantity: 1 });

    // Dinheiro que pode ter saído sem item é a pergunta mais urgente
    // que a tabela responde.
    expect(repository.stats(0).stuck).toBe(1);
  });
});

describe('o que a compra manda ao dono do saldo', () => {
  it('leva a referência com prefixo e o productId', async () => {
    const { wallet, moves } = scriptedWallet([
      { status: 'ok', balance: 750, transactionId: '918273', replayed: false },
    ]);
    const { repository, service } = harness({ wallet });
    const { offerId } = withOffer(repository);

    await service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId, quantity: 1 });

    // Sem o prefixo, uma colisão com DayZ ou Conan devolveria a
    // transação alheia com `idempotent: true` — e o item sairia de
    // graça, com resposta de sucesso.
    expect(moves[0]?.input.reference).toBe(`rust:${SITE_SERVER}:loja:p1`);
    expect(moves[0]?.input.productId).toBe('kit-metal');
    // Português e voltado ao jogador: é isto que ele lê no extrato.
    expect(moves[0]?.input.reason).toBe('Loja in-game: Kit Metal x1');
  });

  it('grava a referência, o plano e o id da transação na linha', async () => {
    const { wallet } = scriptedWallet([
      { status: 'ok', balance: 750, transactionId: '918273', replayed: false },
    ]);
    const { repository, service } = harness({ wallet });
    const { offerId } = withOffer(repository);

    await service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId, quantity: 2 });

    const purchase = repository.getPurchase(SERVER, 'p1');

    expect(purchase?.state).toBe('delivered');
    expect(purchase?.reference).toBe(`rust:${SITE_SERVER}:loja:p1`);
    // O id do ledger sobrevive à transição seguinte: é o COALESCE do
    // repositório, e é a única coisa que responde "eu paguei e não
    // recebi" meses depois.
    expect(purchase?.siteTransactionId).toBe('918273');

    // O plano é CONGELADO: uma oferta editada depois não muda o que
    // esta compra prometeu.
    const plan = JSON.parse(purchase?.delivery ?? 'null') as { units: number; items: unknown[] };

    expect(plan.units).toBe(2);
    expect(plan.items).toHaveLength(1);
  });

  it('um offer.id de mais de 100 chars sai SEM productId', async () => {
    // O site recusa `productId` acima de 100 chars com um 400 que
    // FECHA a compra. Sem o campo ele grava `product_id = NULL` e a
    // compra passa — que é o lado certo de errar. O limite seria
    // descoberto em produção, por um admin que só cadastrou uma
    // oferta com id comprido.
    const { wallet, moves } = scriptedWallet([
      { status: 'ok', balance: 750, transactionId: null, replayed: false },
    ]);
    const { repository, service } = harness({ wallet });
    const { offerId } = withOffer(repository, {}, 'x'.repeat(101));

    await service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId, quantity: 1 });

    expect(offerId).toHaveLength(101);
    expect(moves[0]?.input.productId).toBeUndefined();
    // E a compra ACONTECE: o campo some, o débito não.
    expect(moves[0]?.input.reference).toBe(`rust:${SITE_SERVER}:loja:p1`);
  });
});

describe('as recusas que acontecem ANTES de falar com o dono do saldo', () => {
  it('acima do teto: nenhuma linha criada e nenhuma chamada', async () => {
    const { wallet, moves } = scriptedWallet([
      { status: 'ok', balance: 0, transactionId: null, replayed: false },
    ]);
    const { repository, service } = harness({ wallet, maxOzPerPurchase: 1_000 });
    const { offerId } = withOffer(repository);

    const outcome = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 100,
    });

    expect(outcome.status).toBe('over-limit');
    // Nada aconteceu: nada precisa ser registrado como se tivesse
    // acontecido.
    expect(repository.listPurchases({ limit: 10 })).toHaveLength(0);
    expect(moves).toHaveLength(0);
  });

  it('loja não pareada: INDISPONÍVEL, e a frase não fala em saldo', async () => {
    // ####  A PALAVRA "SALDO" É O DEFEITO  ####
    //
    // Pareamento quebrado e bolso vazio produzem o mesmo botão morto.
    // O jogador que lê "saldo" acha que perdeu dinheiro.
    const { wallet, moves } = scriptedWallet([
      { status: 'ok', balance: 0, transactionId: null, replayed: false },
    ]);
    const { repository, service } = harness({ wallet, ready: () => false });
    const { offerId } = withOffer(repository);

    const outcome = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 1,
    });

    expect(outcome.status).toBe('store-unavailable');
    expect(moves).toHaveLength(0);
    expect(repository.listPurchases({ limit: 10 })).toHaveLength(0);
    expect(describePurchase(outcome).toLowerCase()).not.toContain('saldo');
  });

  it('uma compra aberta bloqueia a segunda do mesmo jogador', async () => {
    // O `referenceId` protege ESTA tentativa de sair duas vezes; ele
    // não protege o jogador de comprar duas vezes, porque cada clique
    // gera uma chave nova. A única barreira era o plugin, e o timeout
    // dele solta o botão com a compra ainda em voo.
    const { wallet, moves } = scriptedWallet([{ status: 'unknown', reason: 'timeout' }]);
    const { repository, service } = harness({ wallet });
    const { offerId } = withOffer(repository);

    await service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId, quantity: 1 });

    const second = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 1,
    });

    expect(second.status).toBe('already-in-flight');
    // Uma linha só, e uma chamada só ao dono do saldo.
    expect(repository.listPurchases({ limit: 10 })).toHaveLength(1);
    expect(moves).toHaveLength(1);
  });
});

describe('o estorno', () => {
  it('manda a referência da COMPRA — o sufixo é da carteira', async () => {
    // Quem deriva o `:refund` é a carteira, não quem chama: com a
    // chave da compra, o site trataria o crédito como replay do
    // débito e não creditaria.
    const { wallet, moves } = scriptedWallet([
      { status: 'ok', balance: 750, transactionId: '1', replayed: false },
      { status: 'ok', balance: 1_000, transactionId: '2', replayed: false },
    ]);
    const { repository, service, server } = harness({ wallet });
    const { offerId } = withOffer(repository);

    // O RCON fora faz a entrega falhar depois do débito, que é o
    // único caminho em que o estorno acontece.
    server.connected = false;

    const outcome = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 1,
    });

    expect(outcome.status).toBe('delivery-failed');
    expect(moves).toHaveLength(2);
    expect(moves[1]?.kind).toBe('credit');
    // A referência que sai daqui é a da COMPRA, sem sufixo.
    expect(moves[1]?.input.reference).toBe(`rust:${SITE_SERVER}:loja:p1`);
    // E o estorno não leva produto: ele não é venda de catálogo.
    expect(moves[1]?.input.productId).toBeUndefined();
    expect(moves[1]?.input.reason).toContain('Estorno: entrega falhou');
  });
});

describe('a frase do saldo insuficiente', () => {
  it('é a do DONO DO SALDO, mais o caminho para comprar', async () => {
    const message = 'Saldo insuficiente. Voce tem 0 OZ, o item custa 250 OZ (faltam 250).';
    const { wallet } = scriptedWallet([{ status: 'insufficient', balance: 0, message }]);
    const { repository, service } = harness({ wallet });
    const { offerId } = withOffer(repository);

    const outcome = await service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId,
      quantity: 1,
    });

    expect(outcome.status).toBe('insufficient');
    // Crua, e não reescrita: quem sabe quanto falta é quem tem o
    // dinheiro — inclusive depois de uma compra feita no site
    // enquanto o modal estava aberto.
    expect(describePurchase(outcome)).toContain(message);
    expect(describePurchase(outcome)).toContain('Compre OzCoins no site OrigemZ');
  });

  it('a carteira LOCAL monta a MESMA frase, no mesmo formato', async () => {
    // Sem isso, `describePurchase` precisaria de um `if` para saber
    // quem é o dono do saldo — e o suporte leria duas versões da
    // mesma história.
    const db = openDatabase({ file: MEMORY_DATABASE });

    runMigrations(db);

    const wallets = new WalletsRepository(db);

    wallets.change(STEAM_ID, 100, null, 'saldo do teste', NOW);

    const local = new LocalWallet(wallets);
    const change = await local.debit({
      steamId: STEAM_ID,
      amount: 250,
      reference: 'p1',
      reason: 'Loja in-game: Kit Metal x1',
    });

    expect(change.status).toBe('insufficient');

    if (change.status === 'insufficient') {
      expect(change.message).toBe(
        'Saldo insuficiente. Voce tem 100 OZ, o item custa 250 OZ (faltam 150).',
      );
    }
  });
});
