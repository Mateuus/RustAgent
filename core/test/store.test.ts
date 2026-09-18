// ============================================================
//  store.test.ts  -  a loja: o que ela cobra, o que ela entrega e o
//  que ela desenha.
//
//  O que este arquivo guarda:
//
//    1. a compra debita ANTES de entregar, e o estado final é
//       `delivered`;
//    2. sem saldo, nada é entregue — e o motivo diz quanto falta;
//    3. entrega que falha vira ESTORNO, com o saldo de volta;
//    4. estorno que também falha vira `failed`, que é o estado que
//       precisa de gente;
//    5. o VIP comprado nasce pelo mesmo caminho do concedido, com os
//       dias multiplicados pelas unidades;
//    6. veículo sem espaço é recusado ANTES do débito;
//    7. a carteira local nunca deixa o saldo negativo;
//    8. a grade pagina e a lista de um pacote conta o que não coube;
//    9. sem saldo, o botão de comprar NÃO É DESENHADO;
//   10. o cabeçalho vira update no lugar, sem recriar elemento.
//
//  O relógio e o gerador de id são INJETADOS: sem isso o teste
//  dependeria do acaso, e duas compras do mesmo milissegundo
//  colidiriam de vez em quando — que é a pior forma de um teste
//  falhar.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StoreRepository, type StoreOfferInput } from '../src/db/store-repository.js';
import { WalletsRepository } from '../src/db/wallets-repository.js';

import { collectScreenActions, headerUpdatesToCui } from '../src/game/ui-cui.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import { createHeaderProvider } from '../src/game/ui-store-bridge.js';
import {
  buildResultScreen,
  buildStoreScreen,
  itemScreenId,
  parseStoreScreenId,
  STORE_SCREEN_ID,
} from '../src/game/ui-store-screens.js';
import { storeOfferBody } from '../src/http/routes/store.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import {
  DEFAULT_VEHICLE_FUEL,
  StoreService,
  daysLeftInPeriod,
  planFromJson,
  type StoreCatalogEntry,
} from '../src/store/service.js';
import { LocalWallet, type Wallet, type WalletChange } from '../src/store/wallet.js';
import type { UiElement, UiScreen } from '../src/types/ui-document.js';

const STEAM_ID = '76561198123456789';
const SERVER = 'pvp1';
const NOW = 1_700_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface FakeServer {
  readonly commands: string[];
  connected: boolean;
  /** O `origemz.give` vai aceitar? */
  acceptsGive: boolean;
  /** Cabe um veículo aqui? */
  hasSpace: boolean;
}

function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      if (command.startsWith('origemz.vehicle.space ')) {
        return Promise.resolve(JSON.stringify({ ok: true, space: server.hasSpace }));
      }

      if (command.startsWith('origemz.vehicle.spawn ')) {
        return Promise.resolve(
          server.hasSpace
            ? JSON.stringify({ ok: true, prefab: 'minicopter', fuel: 100 })
            : JSON.stringify({ ok: false, error: 'NO_SPACE' }),
        );
      }

      if (!command.startsWith('origemz.give ')) {
        return Promise.resolve('');
      }

      return Promise.resolve(
        server.acceptsGive
          ? JSON.stringify({ ok: true, given: 1, dropped: 0 })
          : JSON.stringify({ ok: false, error: 'PLAYER_NOT_FOUND' }),
      );
    },
  };
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: StoreRepository;
  readonly wallets: WalletsRepository;
  readonly service: StoreService;
  readonly server: FakeServer;
  readonly granted: { tier: string; expiresAt: number | null }[];
  readonly pass: FakePass;
}

/**
 * O concessor do passe, em cinco linhas.
 *
 * `owned` é o índice único parcial do banco visto de fora: uma chave
 * por `(servidor, jogador, mês)`. `period` é o relógio da virada — o
 * teste o move para provar que o mês da ENTREGA não é o mês da
 * compra.
 */
interface FakePass {
  readonly granted: {
    serverId: string;
    steamId: string;
    period: string;
    sourceRef: string | null;
  }[];
  readonly owned: Set<string>;
  /** O mês corrente, como o agente o vê AGORA. */
  period: string;
}

/**
 * Um agente inteiro em memória.
 *
 * `wallet` é injetável para o teste do estorno que falha: é a única
 * forma de exercitar `failed` sem quebrar o banco de propósito.
 */
function setup(
  options: {
    readonly wallet?: Wallet;
    readonly balance?: number;
    /** `false` = agente sem o concessor do passe ligado. */
    readonly pass?: boolean;
  } = {},
): Harness {
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
  const wallets = new WalletsRepository(db);

  if (options.balance !== undefined && options.balance > 0) {
    wallets.change(STEAM_ID, options.balance, null, 'saldo do teste', NOW);
  }

  const server: FakeServer = { commands: [], connected: true, acceptsGive: true, hasSpace: true };
  const granted: Harness['granted'] = [];
  const pass: FakePass = { granted: [], owned: new Set<string>(), period: '2026-09' };

  const service = new StoreService({
    repository,
    wallet: options.wallet ?? new LocalWallet(wallets),
    servers: { contextOf: () => ({ rcon: fakeRcon(server) }) },
    vips: {
      grant: (input) => {
        granted.push({ tier: input.tier, expiresAt: input.expiresAt });

        return Promise.resolve(undefined);
      },
    },
    ...(options.pass === false
      ? {}
      : {
          pass: {
            periodNow: () => pass.period,
            hasPass: (serverId, steamId, period) =>
              pass.owned.has(`${serverId}|${steamId}|${period}`),
            grant: (input) => {
              pass.granted.push({
                serverId: input.serverId,
                steamId: input.steamId,
                period: input.period,
                sourceRef: input.sourceRef,
              });
              // O `grant` de verdade é idempotente por mês: o índice
              // único parcial recusa o segundo direito vivo.
              pass.owned.add(`${input.serverId}|${input.steamId}|${input.period}`);
            },
          },
        }),
    logger: silent,
    now: () => NOW,
    // Determinístico: sem isto, duas compras do mesmo milissegundo
    // colidiriam na chave primária de vez em quando.
    newId: ((): (() => string) => {
      let count = 0;

      return (): string => `p${String((count += 1))}`;
    })(),
  });

  return { db, repository, wallets, service, server, granted, pass };
}

function offer(over: Partial<StoreOfferInput> = {}): StoreOfferInput {
  return {
    categoryId: 'cat',
    kind: 'item',
    name: 'Assault Rifle',
    price: 500,
    oldPrice: null,
    position: 0,
    enabled: true,
    badge: null,
    icon: { shortname: 'rifle.ak', itemId: 1_545_779_598, skinId: '0', file: null },
    items: [{ shortname: 'rifle.ak', itemId: 1_545_779_598, skinId: '0', amount: 1 }],
    perks: [],
    vip: null,
    vehicle: null,
    pass: null,
    ...over,
  };
}

function seed(harness: Harness, over: Partial<StoreOfferInput> = {}, id = 'of1'): string {
  harness.repository.saveCategory('cat', { name: 'Armas', position: 0, enabled: true }, NOW);
  harness.repository.saveOffer(id, offer(over), NOW);

  return id;
}

// ============================================================
//  A COMPRA
// ============================================================

describe('a compra', () => {
  it('debita, entrega e termina em "delivered"', async () => {
    const harness = setup({ balance: 1000 });
    const id = seed(harness);

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('ok');
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(500);

    const purchase = harness.repository.listPurchases({ steamId: STEAM_ID })[0];

    expect(purchase?.state).toBe('delivered');
    expect(purchase?.totalPrice).toBe(500);

    // O item saiu de verdade, pelo comando do plugin.
    expect(harness.server.commands.some((line) => line.startsWith('origemz.give '))).toBe(true);
  });

  it('multiplica o preço pelas unidades, e a quantidade entregue junto', async () => {
    const harness = setup({ balance: 1000 });

    const id = seed(harness, {
      items: [{ shortname: 'wood', itemId: 1, skinId: '0', amount: 100 }],
    });

    await harness.service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId: id, quantity: 2 });

    expect(harness.wallets.getBalance(STEAM_ID)).toBe(0);
    expect(harness.server.commands).toContain(`origemz.give ${STEAM_ID} wood 200 0 auto`);
  });

  it('sem saldo, NÃO entrega — e diz quanto custa e quanto ele tem', async () => {
    const harness = setup({ balance: 100 });
    const id = seed(harness);

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('insufficient');

    if (outcome.status === 'insufficient') {
      expect(outcome.price).toBe(500);
      expect(outcome.balance).toBe(100);
    }

    // Nada de `origemz.give`: a recusa acontece ANTES da entrega.
    expect(harness.server.commands.some((line) => line.startsWith('origemz.give '))).toBe(false);
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(100);
  });

  it('oferta desligada é recusada mesmo com saldo de sobra', async () => {
    const harness = setup({ balance: 10_000 });
    const id = seed(harness, { enabled: false });

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('offer-disabled');
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(10_000);
  });
});

// ============================================================
//  O ESTORNO
// ============================================================

describe('quando a entrega falha', () => {
  it('devolve o valor e grava "refunded"', async () => {
    const harness = setup({ balance: 1000 });
    const id = seed(harness);

    harness.server.acceptsGive = false;

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('delivery-failed');

    if (outcome.status === 'delivery-failed') {
      expect(outcome.refunded).toBe(true);
    }

    // O saldo voltou INTEIRO.
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(1000);
    expect(harness.repository.listPurchases({ steamId: STEAM_ID })[0]?.state).toBe('refunded');
  });

  it('e o estorno também falha, o estado vira "failed"', async () => {
    // ####  ESTE É O ESTADO QUE PRECISA DE GENTE  ####
    //
    // Pagou, não recebeu, e o valor não voltou. Sem um estado
    // próprio, este caso seria uma linha de log que ninguém lê.
    const brokenWallet: Wallet = {
      source: 'local',
      getBalance: (steamId) => Promise.resolve({ steamId, balance: 1000, source: 'local' }),
      debit: (): Promise<WalletChange> =>
        Promise.resolve({ status: 'ok', balance: 500, transactionId: null, replayed: false }),
      credit: (): Promise<WalletChange> =>
        Promise.resolve({ status: 'unavailable', reason: 'a carteira sumiu', cause: 'network' }),
    };

    const harness = setup({ wallet: brokenWallet });
    const id = seed(harness);

    harness.server.acceptsGive = false;

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('delivery-failed');

    if (outcome.status === 'delivery-failed') {
      expect(outcome.refunded).toBe(false);
    }

    const purchase = harness.repository.listPurchases({ steamId: STEAM_ID })[0];

    expect(purchase?.state).toBe('failed');
    expect(purchase?.error).toContain('DELIVERY_AND_REFUND_FAILED');
  });
});

// ============================================================
//  VIP E VEÍCULO
// ============================================================

describe('as ofertas que não são item', () => {
  it('o VIP é concedido pelo mesmo caminho, com os dias vezes as unidades', async () => {
    const harness = setup({ balance: 10_000 });

    const id = seed(harness, {
      kind: 'vip',
      name: 'VIP Ouro 30 dias',
      items: [],
      vip: { tier: 'gold', days: 30 },
      perks: ['fila prioritária', 'kit exclusivo'],
    });

    await harness.service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId: id, quantity: 2 });

    expect(harness.granted).toHaveLength(1);
    expect(harness.granted[0]?.tier).toBe('gold');
    // Comprar duas vezes compra o DOBRO de tempo.
    expect(harness.granted[0]?.expiresAt).toBe(NOW + 60 * 24 * 60 * 60 * 1000);
  });

  it('veículo sem espaço é recusado ANTES de cobrar', async () => {
    const harness = setup({ balance: 10_000 });

    const id = seed(harness, {
      kind: 'vehicle',
      name: 'Minicopter',
      items: [],
      vehicle: { prefab: 'minicopter', fuel: 100 },
    });

    harness.server.hasSpace = false;

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('no-space');
    // Nada foi cobrado, e nenhuma linha de compra nasceu: recusar
    // antes é o que evita débito, estorno e susto no extrato.
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(10_000);
    expect(harness.repository.listPurchases({ steamId: STEAM_ID })).toHaveLength(0);
  });

  it('veículo cadastrado SEM combustível nasce com o padrão', async () => {
    const harness = setup({ balance: 10_000 });

    // É o que está gravado hoje em toda oferta antiga: a coluna
    // nasceu com DEFAULT 0 na migração 035.
    const id = seed(harness, {
      kind: 'vehicle',
      name: 'Minicopter',
      items: [],
      vehicle: { prefab: 'minicopter', fuel: 0 },
    });

    await harness.service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId: id, quantity: 1 });

    expect(harness.server.commands).toContain(
      `origemz.vehicle.spawn ${STEAM_ID} minicopter ${String(DEFAULT_VEHICLE_FUEL)}`,
    );
  });

  it('o número cadastrado manda: o padrão só substitui o zero', async () => {
    const harness = setup({ balance: 10_000 });

    // 50 é MENOS que o padrão e mesmo assim vale: quem escreveu um
    // número pequeno quis um tanque pequeno. O que o padrão conserta
    // é o veículo que sairia SECO.
    const id = seed(harness, {
      kind: 'vehicle',
      name: 'Minicopter na reserva',
      items: [],
      vehicle: { prefab: 'minicopter', fuel: 50 },
    });

    await harness.service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId: id, quantity: 1 });

    expect(harness.server.commands).toContain(`origemz.vehicle.spawn ${STEAM_ID} minicopter 50`);
  });
});

// ============================================================
//  O PASSE DE BATALHA
//
//  O formato 'pass' não entrega item nenhum: ele concede um DIREITO,
//  e o direito é de um MÊS e de um SERVIDOR. Daí as três coisas que
//  este bloco guarda, e que nenhum outro formato da loja precisa:
//
//    1. comprar o mesmo mês duas vezes é recusado ANTES do débito —
//       o VIP não sofre disso porque compra nova SOMA prazo;
//    2. o mês vem do PLANO CONGELADO, e não do relógio da entrega;
//    3. um plano gravado ANTES desta frente continua legível — sem
//       isso, toda compra em voo no deploy vira conferência humana.
// ============================================================

/** Uma oferta de passe, com o mês resolvido na compra. */
function passOffer(over: Partial<StoreOfferInput> = {}): Partial<StoreOfferInput> {
  return {
    kind: 'pass',
    name: 'Passe de Batalha',
    price: 500,
    items: [],
    // `null` é o caso normal: quem resolve o mês é a compra.
    pass: { period: null },
    ...over,
  };
}

describe('a compra do passe', () => {
  it('concede o direito do mês corrente e termina em "delivered"', async () => {
    const harness = setup({ balance: 1000 });
    const id = seed(harness, passOffer());

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('ok');
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(500);
    expect(harness.pass.granted).toEqual([
      { serverId: SERVER, steamId: STEAM_ID, period: '2026-09', sourceRef: 'p1' },
    ]);
    expect(harness.repository.listPurchases({ steamId: STEAM_ID })[0]?.state).toBe('delivered');

    // Nada de `origemz.give`: o passe é uma linha de tabela, e não
    // uma coisa na mochila.
    expect(harness.server.commands.some((line) => line.startsWith('origemz.give '))).toBe(false);
  });

  it('comprar o mesmo mês duas vezes é recusado SEM tocar em dinheiro', async () => {
    const harness = setup({ balance: 10_000 });
    const id = seed(harness, passOffer());

    // Ele já comprou hoje de manhã.
    harness.pass.owned.add(`${SERVER}|${STEAM_ID}|2026-09`);

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('pass-owned');

    if (outcome.status === 'pass-owned') {
      expect(outcome.period).toBe('2026-09');
    }

    // ####  O QUE ESTE TESTE REALMENTE GUARDA  ####
    //
    // Saldo intacto, NENHUMA linha de compra e nenhum estorno. Se a
    // recusa morasse no `deliverPlan`, os três seriam diferentes:
    // débito, exceção, estorno — e um extrato com uma cobrança e uma
    // devolução para quem só clicou no botão errado.
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(10_000);
    expect(harness.repository.listPurchases({ steamId: STEAM_ID })).toHaveLength(0);
    expect(harness.pass.granted).toHaveLength(0);
  });

  it('ter o passe no pvp1 não impede comprá-lo no pvp2', async () => {
    const harness = setup({ balance: 10_000 });
    const id = seed(harness, passOffer());

    harness.pass.owned.add(`${SERVER}|${STEAM_ID}|2026-09`);

    // São duas trilhas, e o XP de uma não conta na outra — então o
    // direito também é de um servidor só. É o comportamento
    // pretendido, e não um furo na recusa.
    const outcome = await harness.service.buy({
      serverId: 'pvp2',
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('ok');
    expect(harness.pass.granted).toEqual([
      { serverId: 'pvp2', steamId: STEAM_ID, period: '2026-09', sourceRef: 'p1' },
    ]);
  });

  it('quantidade não multiplica o passe: um mês não vem em dobro', async () => {
    const harness = setup({ balance: 10_000 });
    const id = seed(harness, passOffer());

    // A vitrine não oferece o seletor, mas a rota HTTP aceita até
    // 1000. Sem o teto aqui seriam TRÊS PREÇOS e UM direito: o
    // `grant` é idempotente por mês.
    await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 3,
    });

    expect(harness.wallets.getBalance(STEAM_ID)).toBe(9500);
    expect(harness.pass.granted).toHaveLength(1);
  });

  it('num agente sem o concessor, a oferta é recusada antes do débito', async () => {
    const harness = setup({ balance: 10_000, pass: false });
    const id = seed(harness, passOffer());

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    // Diferente do VIP de propósito: sem o concessor não há de quem
    // perguntar de que mês é a compra, e um plano sem mês é uma
    // promessa que a entrega não sabe cumprir. Cobrar para estornar
    // em seguida seria susto no extrato por configuração faltando.
    expect(outcome.status).toBe('pass-unavailable');
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(10_000);
    expect(harness.repository.listPurchases({ steamId: STEAM_ID })).toHaveLength(0);
  });

  it('o direito é o ÚLTIMO passo: entrega que falha não concede passe', async () => {
    // ####  A PERGUNTA EM ABERTO DO 04 §9 NÃO CHEGA A EXISTIR  ####
    //
    // "Estorno de um passe já resgatado" só seria possível se algum
    // passo da entrega pudesse falhar DEPOIS do `grant`. Não pode: o
    // passe é o último. Aqui o item extra falha, o valor volta
    // inteiro e nenhum direito nasceu.
    const harness = setup({ balance: 10_000 });

    const id = seed(
      harness,
      passOffer({ items: [{ shortname: 'wood', itemId: 1, skinId: '0', amount: 100 }] }),
    );

    harness.server.acceptsGive = false;

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('delivery-failed');
    expect(harness.pass.granted).toHaveLength(0);
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(10_000);
  });

  it('a oferta com mês FIXO manda no mês corrente', async () => {
    const harness = setup({ balance: 10_000 });
    const id = seed(harness, passOffer({ pass: { period: '2026-12' } }));

    await harness.service.buy({ serverId: SERVER, steamId: STEAM_ID, offerId: id, quantity: 1 });

    expect(harness.pass.granted[0]?.period).toBe('2026-12');
  });
});

// ============================================================
//  O MÊS VEM DO PLANO CONGELADO
// ============================================================

describe('o mês do passe', () => {
  it('é o da COMPRA, mesmo que a entrega aconteça no mês seguinte', async () => {
    // ####  A ARMADILHA QUE SÓ APARECE QUANDO O SITE CAI  ####
    //
    // Débito `unknown` deixa a compra aberta, e quem a fecha é o
    // reconciliador — com teto de 6 horas. Se essas horas
    // atravessarem a meia-noite do dia 1, um passe pago em setembro
    // seria ativado como outubro.
    const unknownWallet: Wallet = {
      source: 'remote',
      getBalance: (steamId) => Promise.resolve({ steamId, balance: 10_000, source: 'remote' }),
      debit: (): Promise<WalletChange> =>
        Promise.resolve({ status: 'unknown', reason: 'timeout', cause: 'network' }),
      credit: (): Promise<WalletChange> =>
        Promise.resolve({ status: 'ok', balance: 10_000, transactionId: null, replayed: false }),
    };

    const harness = setup({ wallet: unknownWallet });
    const id = seed(harness, passOffer());

    const outcome = await harness.service.buy({
      serverId: SERVER,
      steamId: STEAM_ID,
      offerId: id,
      quantity: 1,
    });

    expect(outcome.status).toBe('charge-unknown');
    expect(harness.pass.granted).toHaveLength(0);

    const purchase = harness.repository.listPurchases({ steamId: STEAM_ID })[0];

    expect(purchase?.state).toBe('charge-unknown');

    // O mês ficou GRAVADO na linha, e não numa variável de quem
    // comprou.
    const plan = planFromJson(purchase?.delivery ?? null);

    expect(plan?.pass).toEqual({ period: '2026-09' });

    // ---- horas depois, e já é outubro ----
    harness.pass.period = '2026-10';

    if (plan === null) {
      throw new Error('o plano tinha de estar legível');
    }

    // É o que o settle faz com a prova na mão: entrega o PLANO, e
    // não a oferta de hoje.
    await harness.service.deliverPlan(SERVER, STEAM_ID, plan, {
      reference: purchase?.reference ?? null,
      origin: 'loja',
    });

    expect(harness.pass.granted).toEqual([
      {
        serverId: SERVER,
        steamId: STEAM_ID,
        period: '2026-09',
        sourceRef: purchase?.reference ?? null,
      },
    ]);
  });

  it('planFromJson aceita um plano gravado ANTES desta frente', () => {
    // ####  SEM O `.default(null)`, ISTO SERIA `null`  ####
    //
    // E `null` não é "entregue o que der": é "não sei o que
    // prometi", que vira `PLAN_MISSING` e conferência humana. Toda
    // compra em voo no momento do deploy tem um plano com esta
    // forma — sem o padrão, o deploy vira uma fila de suporte.
    const gravadoAntes = JSON.stringify({
      items: [{ shortname: 'wood', itemId: 1, amount: 100, skinId: '0' }],
      vehicle: null,
      vip: null,
      units: 2,
    });

    expect(planFromJson(gravadoAntes)).toEqual({
      items: [{ shortname: 'wood', itemId: 1, amount: 100, skinId: '0' }],
      vehicle: null,
      vip: null,
      pass: null,
      units: 2,
    });
  });

  it('daysLeftInPeriod conta o dia de hoje, e zera num mês vencido', () => {
    // Comprar no dia 30 é comprar UM dia, e é isso que a tela
    // precisa dizer antes de cobrar.
    const dia30 = Date.UTC(2026, 8, 30, 12, 0, 0);

    expect(daysLeftInPeriod('2026-09', dia30, 'UTC')).toBe(1);
    expect(daysLeftInPeriod('2026-09', Date.UTC(2026, 8, 1, 12, 0, 0), 'UTC')).toBe(30);
    // Mês futuro: ele ainda vem inteiro.
    expect(daysLeftInPeriod('2026-10', dia30, 'UTC')).toBe(31);
    // Mês vencido: uma oferta de mês fixo que ficou ligada.
    expect(daysLeftInPeriod('2026-08', dia30, 'UTC')).toBe(0);
  });
});

// ============================================================
//  A CARTEIRA
// ============================================================

describe('a carteira local', () => {
  it('nunca deixa o saldo negativo', () => {
    const harness = setup({ balance: 100 });

    expect(harness.wallets.change(STEAM_ID, -150, null, 'compra', NOW)).toBeNull();
    expect(harness.wallets.getBalance(STEAM_ID)).toBe(100);
  });

  it('guarda o extrato, com o saldo DEPOIS de cada lançamento', () => {
    const harness = setup({ balance: 100 });

    harness.wallets.change(STEAM_ID, -30, 'p1', 'store:AK x1', NOW);

    const entries = harness.wallets.listEntries(STEAM_ID);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.amount).toBe(-30);
    expect(entries[0]?.balance).toBe(70);
    expect(entries[0]?.reference).toBe('p1');
  });

  it('quem nunca teve saldo lê zero, sem linha no banco', () => {
    const harness = setup();

    expect(harness.wallets.getBalance('76561198000000009')).toBe(0);
    expect(harness.wallets.listEntries('76561198000000009')).toHaveLength(0);
  });
});

// ============================================================
//  A RÉGUA DA OFERTA
//
//  O `storeOfferBody` é UM só, e o canal de config do site o importa
//  (site/appliers/store.ts). Então o que este bloco prova vale nos
//  dois caminhos de uma vez — o painel e o snapshot do site.
// ============================================================

describe('o cadastro de uma oferta de passe', () => {
  const base = {
    categoryId: 'cat',
    name: 'Passe de Batalha',
    price: 500,
    icon: { shortname: 'box.wooden', itemId: 1 },
  };

  it('sem dizer o mês é o cadastro NORMAL — quem resolve é a compra', () => {
    const parsed = storeOfferBody.parse({ ...base, kind: 'pass' });

    // `null`, e não o mês de hoje: congelar o mês na OFERTA daria
    // uma oferta que vence sozinha na virada.
    expect(parsed.pass).toBeNull();
  });

  it('com mês, ele passa pela mesma régua da temporada', () => {
    expect(storeOfferBody.parse({ ...base, kind: 'pass', pass: { period: '2026-10' } }).pass)
      .toEqual({ period: '2026-10' });

    // Mês 13 não existe, e o banco só protege a FORMA.
    expect(() =>
      storeOfferBody.parse({ ...base, kind: 'pass', pass: { period: '2026-13' } }),
    ).toThrow();
  });

  it('mês num formato que não é passe é RECUSADO', () => {
    // Ele não viria do painel, mas vem do canal do site, que aplica
    // a loja por este mesmo schema. Gravado, seria um campo que
    // ninguém lê: a oferta cobraria e não daria passe nenhum.
    expect(() =>
      storeOfferBody.parse({
        ...base,
        kind: 'bundle',
        items: [{ shortname: 'wood', itemId: 1, amount: 1 }],
        pass: { period: '2026-10' },
      }),
    ).toThrow(/passe de batalha/i);
  });
});

// ============================================================
//  AS TELAS
// ============================================================

function catalogOf(count: number): readonly StoreCatalogEntry[] {
  const harness = setup();

  harness.repository.saveCategory('cat', { name: 'Armas', position: 0, enabled: true }, NOW);

  for (let index = 0; index < count; index += 1) {
    harness.repository.saveOffer(
      `of${String(index)}`,
      offer({ name: `Item ${String(index)}` }),
      NOW,
    );
  }

  return harness.service.catalog();
}

function collect(elements: readonly UiElement[]): UiElement[] {
  const output: UiElement[] = [];

  const visit = (list: readonly UiElement[]): void => {
    for (const element of list) {
      output.push(element);
      visit(element.children);
    }
  };

  visit(elements);

  return output;
}

function textsOf(screen: UiScreen): string[] {
  return collect(screen.elements)
    .filter((element) => element.type === 'label' || element.type === 'button')
    .map((element) => (element.type === 'label' || element.type === 'button' ? element.text : ''));
}

describe('o endereço da tela', () => {
  it('lê categoria e página, e apara o que vier fora do esperado', () => {
    expect(parseStoreScreenId(STORE_SCREEN_ID)).toEqual({
      kind: 'catalog',
      categoryId: null,
      page: 0,
    });

    expect(parseStoreScreenId(`${STORE_SCREEN_ID}:vip:2`)).toEqual({
      kind: 'catalog',
      categoryId: 'vip',
      page: 2,
    });

    // Página negativa vira zero em vez de erro: o jogador está com um
    // aviso de carregando na tela.
    expect(parseStoreScreenId(`${STORE_SCREEN_ID}:vip:-4`)).toMatchObject({ page: 0 });

    // A quantidade é aparada ao teto — um clique preso no `+` não
    // vira uma compra de mil unidades.
    expect(parseStoreScreenId('ozitem:of1:9999')).toMatchObject({ quantity: 100 });

    expect(parseStoreScreenId('tela-kits')).toBeNull();
  });
});

describe('a grade', () => {
  it('pagina depois de oito ofertas, e diz em que página está', () => {
    const catalog = catalogOf(10);

    const first = buildStoreScreen({
      catalog,
      target: { kind: 'catalog', categoryId: 'cat', page: 0 },
    });

    expect(textsOf(first)).toContain('1 / 2');

    const second = buildStoreScreen({
      catalog,
      target: { kind: 'catalog', categoryId: 'cat', page: 1 },
    });

    expect(textsOf(second)).toContain('2 / 2');

    // ####  NAS PONTAS O BOTÃO SOME  ####
    //
    // Um botão visível que não faz nada é indistinguível de um menu
    // travado.
    expect(collect(first.elements).some((element) => element.id === 'pgp')).toBe(false);
    expect(collect(second.elements).some((element) => element.id === 'pgx')).toBe(false);
  });

  it('loja sem categoria nenhuma DIZ que está fechada', () => {
    const screen = buildStoreScreen({
      catalog: [],
      target: { kind: 'catalog', categoryId: null, page: 0 },
    });

    // Uma tela em branco pareceria o menu travado.
    expect(textsOf(screen)).toContain('A loja está fechada');
  });
});

describe('o modal', () => {
  it('sem saldo, o botão de comprar NÃO é desenhado', () => {
    const screen = buildStoreScreen({
      catalog: catalogOf(1),
      target: { kind: 'item', offerId: 'of0', quantity: 1, tab: 'geral' },
      balance: 10,
    });

    const ids = collect(screen.elements).map((element) => element.id);

    expect(ids).not.toContain('buy');
    expect(textsOf(screen)).toContain('SALDO INSUFICIENTE');
  });

  it('com saldo, o botão carrega o offerId e a quantidade', () => {
    const screen = buildStoreScreen({
      catalog: catalogOf(1),
      target: { kind: 'item', offerId: 'of0', quantity: 3, tab: 'geral' },
      balance: 10_000,
    });

    const buy = collect(screen.elements).find((element) => element.id === 'buy');

    expect(buy?.type).toBe('button');

    if (buy?.type === 'button') {
      expect(buy.action).toEqual({ id: 'abuy', kind: 'store.buy', offerId: 'of0', quantity: 3 });
    }
  });

  it('o OK do aviso VOLTA para a página, para a lista chegar atualizada', () => {
    // ####  FECHAR O AVISO NÃO BASTA  ####
    //
    // MEDIDO no jogo: depois de pegar um kit, o card continuava
    // dizendo RESGATAR. O modal é desenhado POR CIMA, e a página
    // atrás — a que mudou — fica como estava até alguém navegar.
    const voltando = buildResultScreen({
      ok: true,
      message: 'Kit Sucata: 3 de 3 itens no seu inventário.',
      balance: null,
      backTo: 'tela-kits:recursos',
    });

    expect(collectScreenActions(voltando)['arok']).toEqual({
      kind: 'navigate',
      screenId: 'tela-kits:recursos',
    });

    // Sem a página (plugin antigo), o OK só fecha — como antes.
    const fechando = buildResultScreen({ ok: true, message: 'pronto', balance: null });

    expect(collectScreenActions(fechando)['arok']).toEqual({ kind: 'modal.close' });
  });

  it('a oferta que sumiu entre a grade e o clique DIZ que sumiu', () => {
    const screen = buildStoreScreen({
      catalog: catalogOf(1),
      target: { kind: 'item', offerId: 'nao-existe', quantity: 1, tab: 'geral' },
      balance: 10_000,
    });

    expect(textsOf(screen)).toContain('Item indisponível');
  });

  it('o pacote lista o que vem dentro, e conta o que não coube', () => {
    const harness = setup();

    harness.repository.saveCategory('cat', { name: 'Kits', position: 0, enabled: true }, NOW);
    harness.repository.saveOffer(
      'kit',
      offer({
        kind: 'bundle',
        name: 'Kit Grande',
        items: Array.from({ length: 12 }, (_unused, index) => ({
          shortname: `item${String(index)}`,
          itemId: index + 1,
          skinId: '0',
          amount: 1,
        })),
      }),
      NOW,
    );

    const screen = buildStoreScreen({
      catalog: harness.service.catalog(),
      target: { kind: 'item', offerId: 'kit', quantity: 1, tab: 'geral' },
      balance: 10_000,
      nameOf: (shortname) => `Nome de ${shortname}`,
    });

    const texts = textsOf(screen);

    expect(texts).toContain('O QUE VEM NO KIT');
    expect(texts).toContain('Nome de item0');

    // ####  O QUE NÃO CABE VAI PARA A PÁGINA SEGUINTE  ####
    //
    // Sem rolagem no CUI, o excedente ficaria escondido. Contá-lo
    // ("e mais 8...") avisava e não resolvia: o jogador sabia que
    // existiam mais oito itens e não tinha como ver QUAIS, dentro do
    // modal em que foi conferir o que estava comprando.
    expect(texts.some((text) => text.includes('e mais'))).toBe(false);
    expect(texts).toContain('1 / 3');

    const ultima = buildStoreScreen({
      catalog: harness.service.catalog(),
      target: { kind: 'item', offerId: 'kit', quantity: 1, tab: 'geral', page: 2 },
      balance: 10_000,
      nameOf: (shortname) => `Nome de ${shortname}`,
    });

    // O décimo segundo item, que antes não existia para o jogador.
    expect(textsOf(ultima)).toContain('Nome de item11');

    // E o id VOLTA com a página: o plugin compara com o que pediu e
    // descarta o que não bate — o "carregando" ficaria preso.
    expect(ultima.id).toBe('ozitem:kit:1:geral:2');

    // A seta é um ENDEREÇO, e `modal.open`: `navigate` fecharia o
    // modal em vez de virar a página dentro dele.
    const avanca = collect(screen.elements).find((element) => element.id === 'ozpgx');

    expect(avanca?.type).toBe('button');

    if (avanca?.type === 'button') {
      expect(avanca.action).toMatchObject({
        kind: 'modal.open',
        screenId: 'ozitem:kit:1:geral:1',
      });
    }
  });

  it('kit NÃO tem seletor de quantidade; item solto tem', () => {
    const harness = setup();

    harness.repository.saveCategory('cat', { name: 'Loja', position: 0, enabled: true }, NOW);
    harness.repository.saveOffer('solto', offer(), NOW);
    harness.repository.saveOffer(
      'pacote',
      offer({ kind: 'bundle', name: 'Kit', items: offer().items }),
      NOW,
    );

    const catalog = harness.service.catalog();

    const item = buildStoreScreen({
      catalog,
      target: { kind: 'item', offerId: 'solto', quantity: 1, tab: 'geral' },
      balance: 10_000,
    });

    const bundle = buildStoreScreen({
      catalog,
      target: { kind: 'item', offerId: 'pacote', quantity: 1, tab: 'geral' },
      balance: 10_000,
    });

    expect(textsOf(item)).toContain('QUANTIDADE');
    // "3x Kit Base" não é uma compra que alguém queira fazer.
    expect(textsOf(bundle)).not.toContain('QUANTIDADE');
  });

  it('o VIP que promete E entrega separa as duas coisas em abas', () => {
    // ####  DUAS ABAS SÓ QUANDO HÁ DOIS ASSUNTOS  ####
    //
    // Numa lista só, "fila prioritária" e "500x Sucata" viram a mesma
    // coisa — e o que o VIP promete é justamente o que o vende.
    const harness = setup();

    harness.repository.saveCategory('cat', { name: 'VIP', position: 0, enabled: true }, NOW);
    harness.repository.saveOffer(
      'vip',
      offer({
        kind: 'vip',
        name: 'VIP Ouro',
        perks: ['fila prioritária', 'kit exclusivo'],
        items: [{ shortname: 'wood', itemId: 1, skinId: '0', amount: 500 }],
        vip: { tier: 'gold', days: 30 },
      }),
      NOW,
    );

    const catalog = harness.service.catalog();

    const geral = buildStoreScreen({
      catalog,
      target: { kind: 'item', offerId: 'vip', quantity: 1, tab: 'geral' },
      balance: 10_000,
      nameOf: (shortname) => (shortname === 'wood' ? 'Wood' : shortname),
    });

    const itens = buildStoreScreen({
      catalog,
      target: { kind: 'item', offerId: 'vip', quantity: 1, tab: 'itens' },
      balance: 10_000,
      nameOf: (shortname) => (shortname === 'wood' ? 'Wood' : shortname),
    });

    // A aba GERAL mostra as promessas; a de ITENS, as coisas.
    expect(textsOf(geral)).toContain('-  fila prioritária');
    expect(textsOf(geral).some((text) => text.includes('Wood'))).toBe(false);
    expect(textsOf(itens).some((text) => text.includes('Wood'))).toBe(true);

    // E a aba inativa é um ENDEREÇO, não um estado guardado.
    const toItens = collect(geral.elements).find(
      (element) =>
        element.type === 'button' &&
        element.action.kind === 'modal.open' &&
        element.action.screenId === itemScreenId('vip', 1, 'itens'),
    );

    expect(toItens).toBeDefined();
  });

  it('um kit SEM vantagens não ganha aba nenhuma', () => {
    // Uma aba solitária é um clique que não leva a lugar nenhum.
    const harness = setup();

    harness.repository.saveCategory('cat', { name: 'Kits', position: 0, enabled: true }, NOW);
    harness.repository.saveOffer('kit', offer({ kind: 'bundle', name: 'Kit' }), NOW);

    const screen = buildStoreScreen({
      catalog: harness.service.catalog(),
      target: { kind: 'item', offerId: 'kit', quantity: 1, tab: 'geral' },
      balance: 10_000,
    });

    expect(textsOf(screen)).toContain('O QUE VEM NO KIT');
    expect(textsOf(screen)).not.toContain('GERAL');
  });

  it('o passo de quantidade NAVEGA para o mesmo modal com outro número', () => {
    const screen = buildStoreScreen({
      catalog: catalogOf(1),
      target: { kind: 'item', offerId: 'of0', quantity: 2, tab: 'geral' },
      balance: 10_000,
    });

    const plus = collect(screen.elements).find((element) => element.id === 'qp');

    expect(plus?.type).toBe('button');

    if (plus?.type === 'button') {
      // `modal.open`, e não `navigate`: a grade continua intacta
      // atrás.
      expect(plus.action).toMatchObject({
        kind: 'modal.open',
        screenId: itemScreenId('of0', 3),
      });
    }
  });
});

describe('o modal do passe', () => {
  /** Um catálogo com uma oferta de passe só. */
  function passCatalog(): readonly StoreCatalogEntry[] {
    const harness = setup();

    harness.repository.saveCategory('cat', { name: 'Passe', position: 0, enabled: true }, NOW);
    harness.repository.saveOffer('of0', offer(passOffer()), NOW);

    return harness.service.catalog();
  }

  const view = {
    period: '2026-09',
    serverName: 'OrigemZ PVP #1',
    daysLeft: 3,
    owned: false,
    level: 17,
    retroactive: true,
    seasonReady: true,
  };

  it('diz o mês, o servidor, os dias que restam e o que o retroativo dá', () => {
    // ####  CADA LINHA AQUI EVITA UMA RECLAMAÇÃO PREVISÍVEL  ####
    //
    // Sem o mês, quem compra no dia 1 e quem compra no dia 30 leem a
    // mesma frase. Sem o servidor, quem joga em dois compra no
    // errado. Sem os dias, descobre depois de pagar que comprou três
    // dias. E sem o retroativo, o principal argumento de venda do
    // passe comprado tarde simplesmente não é dito.
    const texts = textsOf(
      buildStoreScreen({
        catalog: passCatalog(),
        target: { kind: 'item', offerId: 'of0', quantity: 1, tab: 'geral' },
        balance: 10_000,
        pass: view,
      }),
    );

    // As linhas da lista saem com o marcador na frente ("-  "), como
    // as vantagens de um VIP: o que se confere é o texto dentro.
    const corpo = texts.join(' | ');

    expect(texts).toContain('Passe de setembro de 2026');
    expect(corpo).toContain('Vale só no servidor OrigemZ PVP #1');
    expect(corpo).toContain('Faltam 3 dias para o mês acabar');
    // O número é DAQUELE jogador: um genérico não vende nada.
    expect(corpo).toContain('Resgate na hora os 17 níveis que você já alcançou');
    // E o título da lista não promete um pacote de coisas.
    expect(texts).toContain('O PASSE DESTE MÊS');
  });

  it('quem já tem NÃO vê o botão de comprar', () => {
    const screen = buildStoreScreen({
      catalog: passCatalog(),
      target: { kind: 'item', offerId: 'of0', quantity: 1, tab: 'geral' },
      balance: 10_000,
      pass: { ...view, owned: true },
    });

    // A compra recusaria isto antes de cobrar; o botão só levaria a
    // um aviso.
    expect(collect(screen.elements).some((element) => element.id === 'buy')).toBe(false);
    expect(textsOf(screen).join(' | ')).toContain('Você já tem o passe deste mês');

    // ####  E O MOTIVO NO LUGAR DO BOTÃO É O CERTO  ####
    //
    // "SALDO INSUFICIENTE" ali faria quem tem 10.000 OZ achar que
    // está sem dinheiro — a mesma armadilha do `store-unavailable`.
    expect(textsOf(screen)).toContain('VOCÊ JÁ TEM');
    expect(textsOf(screen)).not.toContain('SALDO INSUFICIENTE');
  });

  it('com o retroativo desligado, a tela conta', () => {
    const texts = textsOf(
      buildStoreScreen({
        catalog: passCatalog(),
        target: { kind: 'item', offerId: 'of0', quantity: 1, tab: 'geral' },
        balance: 10_000,
        pass: { ...view, retroactive: false },
      }),
    );

    // É uma chave do admin, e desligada ela muda o que a compra
    // entrega: quem não souber vai achar que perdeu os níveis.
    expect(texts.join(' | ')).toContain('A faixa paga vale do próximo nível em diante');
    expect(texts.join(' | ')).not.toContain('Resgate na hora os 17 níveis');
  });

  it('sem saber do passe, o modal ainda abre — e o botão continua lá', () => {
    // `null` = não deu para perguntar. Recusar sem certeza seria
    // pior: a compra confere de novo antes de cobrar.
    const screen = buildStoreScreen({
      catalog: passCatalog(),
      target: { kind: 'item', offerId: 'of0', quantity: 1, tab: 'geral' },
      balance: 10_000,
    });

    expect(collect(screen.elements).some((element) => element.id === 'buy')).toBe(true);
  });

  it('não tem seletor de quantidade', () => {
    // "2x Passe de setembro" é ambíguo e não existe: o mês é um só.
    const screen = buildStoreScreen({
      catalog: passCatalog(),
      target: { kind: 'item', offerId: 'of0', quantity: 1, tab: 'geral' },
      balance: 10_000,
      pass: view,
    });

    expect(textsOf(screen)).not.toContain('QUANTIDADE');
  });
});

// ============================================================
//  O CABEÇALHO
// ============================================================

describe('o cabeçalho', () => {
  it('troca o saldo NO LUGAR, sem recriar o elemento', async () => {
    const harness = setup({ balance: 4500 });

    const header = createHeaderProvider({
      wallet: new LocalWallet(harness.wallets),
      vips: { activeOf: () => [{ tier: 'gold', expiresAt: NOW + 5 * 24 * 3_600_000 }] },
      logger: silent,
    });

    const values = await header({ serverId: SERVER, steamId: STEAM_ID });
    const updates = headerUpdatesToCui(buildMainMenu(), values);

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((element) => element.update === true)).toBe(true);

    const texts = updates.flatMap((element) =>
      element.components.map((component) => String((component as { text?: unknown }).text ?? '')),
    );

    // Milhar com ponto, como no painel.
    expect(texts).toContain('4.500');
    expect(texts).toContain('VIP');
    expect(texts).toContain('GOLD');
  });

  it('sem VIP, os rótulos ficam VAZIOS em vez de dizer "SEM VIP"', async () => {
    const harness = setup({ balance: 10 });

    const header = createHeaderProvider({
      wallet: new LocalWallet(harness.wallets),
      vips: { activeOf: () => [] },
      logger: silent,
    });

    const values = await header({ serverId: SERVER, steamId: STEAM_ID });

    // "SEM VIP" ocupa o mesmo espaço e não informa: para a maioria
    // seria um aviso permanente do que lhes falta.
    expect(values['vip-word']).toBe('');
    expect(values['vip-tier']).toBe('');
    expect(values['vip-left']).toBe('');
  });
});

// ============================================================
//  O DESENHO DO CARD
// ============================================================

describe('o card da grade', () => {
  it('o nome e o preço NÃO se sobrepõem', () => {
    // ####  ISTO JÁ ACONTECEU DE VERDADE  ####
    //
    // No projeto anterior o card mudou de altura e as coordenadas dos
    // filhos ficaram as de antes: no jogo, "Python Revolver" apareceu
    // escrito por cima de "100 OZ".
    const screen = buildStoreScreen({
      catalog: catalogOf(1),
      target: { kind: 'catalog', categoryId: 'cat', page: 0 },
    });

    const all = collect(screen.elements);
    const card = all.find((element) => element.id === 'cof0');
    const name = all.find((element) => element.id === 'nof0');
    const price = all.find((element) => element.id === 'pof0');

    expect(card).toBeDefined();
    expect(name).toBeDefined();
    expect(price).toBeDefined();

    const height = Math.abs((card?.rect.offsetMin.y ?? 0) - (card?.rect.offsetMax.y ?? 0));
    // O nome desce do topo; o preço sobe da base.
    const fromTop = Math.abs(name?.rect.offsetMin.y ?? 0);
    const fromBottom = price?.rect.offsetMax.y ?? 0;

    expect(fromTop + fromBottom).toBeLessThan(height);
  });
});
