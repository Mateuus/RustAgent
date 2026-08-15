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
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import { StoreService, type StoreCatalogEntry } from '../src/store/service.js';
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
}

/**
 * Um agente inteiro em memória.
 *
 * `wallet` é injetável para o teste do estorno que falha: é a única
 * forma de exercitar `failed` sem quebrar o banco de propósito.
 */
function setup(options: { readonly wallet?: Wallet; readonly balance?: number } = {}): Harness {
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
    logger: silent,
    now: () => NOW,
    // Determinístico: sem isto, duas compras do mesmo milissegundo
    // colidiriam na chave primária de vez em quando.
    newId: ((): (() => string) => {
      let count = 0;

      return (): string => `p${String((count += 1))}`;
    })(),
  });

  return { db, repository, wallets, service, server, granted };
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
    icon: { shortname: 'rifle.ak', itemId: 1_545_779_598, skinId: '0' },
    items: [{ shortname: 'rifle.ak', itemId: 1_545_779_598, skinId: '0', amount: 1 }],
    perks: [],
    vip: null,
    vehicle: null,
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
      debit: (): Promise<WalletChange> => Promise.resolve({ status: 'ok', balance: 500 }),
      credit: (): Promise<WalletChange> =>
        Promise.resolve({ status: 'unavailable', reason: 'a carteira sumiu' }),
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

    // ####  O QUE NÃO CABE É CONTADO, NUNCA CORTADO EM SILÊNCIO  ####
    //
    // Sem rolagem no CUI, o excedente ficaria escondido — e o jogador
    // compraria achando que o kit tem menos do que tem.
    expect(texts.some((text) => text.includes('e mais'))).toBe(true);
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
