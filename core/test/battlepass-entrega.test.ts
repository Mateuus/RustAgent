// ============================================================
//  battlepass-entrega.test.ts  -  do clique à mochila.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O adaptador entre o resgate e quem entrega. Os casos abaixo são
//  os modos de ele apagar um prêmio SEM ninguém perceber:
//
//    "cabe" sem perguntar     a mochila cheia marca o nível como
//                             resgatado e o item some (foi o defeito
//                             de 17/09/2026, nas missões)
//    "cabe" por não saber     RCON fora vira otimismo, e o prêmio é
//                             derramado no chão de uma base
//    lote tudo-ou-nada        cabendo 6 de 17, as 6 também ficam
//                             devendo
//    moeda refém do item      os 500 OZCoin da mesma linha não são
//                             creditados porque uma AK não coube
//    posição renumerada       a referência da carteira muda e o
//                             retry credita duas vezes
//    dois cliques             o mesmo nível é entregue duas vezes
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { BattlePassDeliveryService, missingRoomMessage } from '../src/battlepass/delivery.js';
import { BattlePassService, type BattlePassActor } from '../src/battlepass/service.js';
import { BattlePassRepository } from '../src/db/battlepass-repository.js';
import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { BATTLEPASS_MARKER, BattlePassSync } from '../src/game/battlepass.js';
import { decodePushPayload } from '../src/game/plugin-push.js';
import type { OpsRcon } from '../src/ops/service.js';
import { GIVE_CHECK_COMMAND } from '../src/quests/inventory-room.js';
import { QuestRewardService } from '../src/quests/rewards.js';
import {
  BATTLEPASS_REPLY,
  BATTLEPASS_SYNC,
  seasonInputSchema,
  type BattlePassPayload,
  type SeasonInput,
} from '../src/types/battlepass.js';
import { questRewardSchema, type QuestReward } from '../src/types/quests.js';

const silent = pino({ level: 'silent' });
const SERVER = 'pvp1';
const PLAYER = '76561190000000001';
const PANEL: BattlePassActor = { name: 'admin', source: 'panel' };
const T0 = 1_800_000_000_000;

const AK: QuestReward = questRewardSchema.parse({ kind: 'item', shortname: 'rifle.ak', amount: 1 });
const COINS: QuestReward = questRewardSchema.parse({ kind: 'coins', amount: 500 });
const KIT: QuestReward = questRewardSchema.parse({ kind: 'kit', slug: 'inicial' });

/** O que o `origemz.give.check` responde nesta rodada. */
type RoomAnswer =
  | { readonly fits: true }
  | { readonly fits: false; readonly missingSlots: number }
  /** O plugin velho, que não conhece o comando: ele se cala. */
  | 'mudo';

interface Spy {
  /** O que o `deliverPlan` da loja recebeu. */
  readonly given: { readonly shortname: string; readonly amount: number }[];
  /** O que a carteira creditou, com a referência que protege o retry. */
  readonly credited: { readonly amount: number; readonly reference: string; readonly reason: string }[];
  readonly kitsClaimed: string[];
  /** Todo `origemz.give.check` que saiu, na ordem. */
  readonly checks: string[];
  /**
   * As respostas do `give.check`, uma por pergunta.
   *
   * Fila, e não um valor só, porque a mochila MUDA entre um nível e
   * o outro do lote: o primeiro cabe, o segundo já não. Vazia = vale
   * a última resposta para sempre.
   */
  readonly rooms: RoomAnswer[];
  room: RoomAnswer;
  connected: boolean;
}

function spy(): Spy {
  return {
    given: [],
    credited: [],
    kitsClaimed: [],
    checks: [],
    rooms: [],
    room: { fits: true },
    connected: true,
  };
}

/**
 * O tradutor de verdade, com dublês nas pontas.
 *
 * O `QuestRewardService` é o REAL de propósito: provar que o OZCoin
 * é creditado quando a AK não coube exige o caminho inteiro, e não
 * um dublê que diz "creditei".
 */
function rewardsOf(state: Spy): QuestRewardService {
  return new QuestRewardService({
    logger: silent,
    delivery: {
      deliverPlan: (_serverId, _steamId, plan) => {
        state.given.push(...plan.items.map((item) => ({ shortname: item.shortname, amount: item.amount })));

        return Promise.resolve();
      },
    },
    catalog: { itemIdOf: (shortname) => (shortname === 'rifle.ak' ? 1_545_779_598 : null) },
    wallet: () => ({
      credit: (input) => {
        state.credited.push({
          amount: input.amount,
          reference: input.reference,
          reason: input.reason,
        });

        return Promise.resolve({ status: 'ok' });
      },
    }),
    kits: {
      list: () => [{ id: 7, slug: 'inicial', name: 'Inicial' }],
      claim: (input) => {
        state.kitsClaimed.push(input.steamId);

        return Promise.resolve({ status: 'entregue' });
      },
    },
  });
}

/** O RCON de mentira: ele responde ao `give.check` e ao passe. */
function rconOf(state: Spy): OpsRcon {
  return {
    get isConnected() {
      return state.connected;
    },
    send: (command: string) => {
      if (command.startsWith(GIVE_CHECK_COMMAND)) {
        state.checks.push(command);

        const answer = state.rooms.shift() ?? state.room;

        if (answer === 'mudo') return Promise.resolve('');

        return Promise.resolve(
          JSON.stringify(
            answer.fits
              ? { ok: true, fits: true, slotsNeeded: 1, freeSlots: 9, missingSlots: 0 }
              : {
                  ok: true,
                  fits: false,
                  slotsNeeded: 3,
                  freeSlots: 0,
                  missingSlots: answer.missingSlots,
                },
          ),
        );
      }

      return Promise.resolve(JSON.stringify({ ok: true }));
    },
  } as unknown as OpsRcon;
}

function deliveryOf(state: Spy): BattlePassDeliveryService {
  const rcon = rconOf(state);

  return new BattlePassDeliveryService({
    rewards: rewardsOf(state),
    rconOf: () => rcon,
    kitItemsOf: (slug) =>
      slug === 'inicial'
        ? [
            { shortname: 'wood', amount: 1000, skinId: '0' },
            { shortname: 'stone', amount: 1000, skinId: '0' },
          ]
        : null,
    logger: silent,
  });
}

// ============================================================
//  O ADAPTADOR, SOZINHO
// ============================================================

describe('a pergunta que vem antes', () => {
  it('sem item nem kit, nem pergunta ao plugin', async () => {
    const state = spy();
    const outcomes = await deliveryOf(state).deliver({
      serverId: SERVER,
      steamId: PLAYER,
      claimId: 1,
      level: 3,
      lane: 'free',
      rewards: [COINS],
    });

    // Moeda não ocupa slot: uma ida ao RCON aqui seria por nada.
    expect(state.checks).toEqual([]);
    expect(outcomes).toEqual([{ idx: 0, ok: true, code: null }]);
    expect(state.credited).toHaveLength(1);
  });

  it('o kit entra na conta de espaço com todos os itens dele', async () => {
    const state = spy();

    await deliveryOf(state).deliver({
      serverId: SERVER,
      steamId: PLAYER,
      claimId: 1,
      level: 3,
      lane: 'free',
      rewards: [KIT],
    });

    const payload = state.checks[0]?.split(' ')[2] ?? '';

    expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual({
      items: [
        { shortname: 'wood', amount: 1000, skinId: '0' },
        { shortname: 'stone', amount: 1000, skinId: '0' },
      ],
    });
    expect(state.kitsClaimed).toEqual([PLAYER]);
  });

  it('sem espaço, o item NÃO sai — e o OZCoin da mesma linha sai', async () => {
    const state = spy();

    state.room = { fits: false, missingSlots: 2 };

    const outcomes = await deliveryOf(state).deliver({
      serverId: SERVER,
      steamId: PLAYER,
      claimId: 42,
      level: 3,
      lane: 'free',
      rewards: [AK, COINS],
    });

    // Travar o crédito porque uma espingarda não coube seria punir o
    // jogador por um problema que não é dele (02 §6.3).
    expect(state.given).toEqual([]);
    expect(state.credited).toEqual([
      {
        amount: 500,
        reference: 'rust:pvp1:passe:42:1:1',
        reason: 'Passe: Nível 3 (grátis)',
      },
    ]);
    expect(outcomes).toEqual([
      { idx: 0, ok: false, code: 'INVENTORY_FULL', message: missingRoomMessage(2) },
      { idx: 1, ok: true, code: null },
    ]);
  });

  it('RCON fora NÃO vira "cabe"', async () => {
    const state = spy();

    state.connected = false;

    const outcomes = await deliveryOf(state).deliver({
      serverId: SERVER,
      steamId: PLAYER,
      claimId: 7,
      level: 1,
      lane: 'free',
      rewards: [AK, COINS],
    });

    // Nem perguntou (sem RCON não há a quem perguntar), e o item
    // ficou devendo com o código cru.
    expect(state.checks).toEqual([]);
    expect(state.given).toEqual([]);
    expect(outcomes[0]).toMatchObject({ idx: 0, ok: false, code: 'RCON_UNAVAILABLE' });
    // E a moeda, que não depende do jogo, foi creditada.
    expect(outcomes[1]).toEqual({ idx: 1, ok: true, code: null });
  });

  it('plugin velho, que se cala, também não vira "cabe"', async () => {
    const state = spy();

    state.room = 'mudo';

    const outcomes = await deliveryOf(state).deliver({
      serverId: SERVER,
      steamId: PLAYER,
      claimId: 8,
      level: 1,
      lane: 'free',
      rewards: [AK],
    });

    expect(state.given).toEqual([]);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.code).toContain(GIVE_CHECK_COMMAND);
  });

  it('NUNCA lança: o tradutor que explode vira desfecho com código', async () => {
    const state = spy();
    const service = new BattlePassDeliveryService({
      rewards: {
        deliver: () => Promise.reject(new Error('BOOM')),
      } as unknown as QuestRewardService,
      rconOf: () => rconOf(state),
      kitItemsOf: () => null,
      logger: silent,
    });

    await expect(
      service.deliver({
        serverId: SERVER,
        steamId: PLAYER,
        claimId: 9,
        level: 1,
        lane: 'free',
        rewards: [AK, COINS],
      }),
    ).resolves.toEqual([
      { idx: 0, ok: false, code: 'BOOM' },
      { idx: 1, ok: false, code: 'BOOM' },
    ]);
  });

  it('a posição não é renumerada: a chave do retry é estável', async () => {
    const state = spy();

    state.room = { fits: false, missingSlots: 1 };

    // A moeda está na posição 2; entregar só ela não pode fazê-la
    // virar posição 0 — a referência da carteira é montada com o
    // índice, e renumerar quebraria a proteção contra creditar duas
    // vezes justamente no caminho do retry.
    await deliveryOf(state).deliver({
      serverId: SERVER,
      steamId: PLAYER,
      claimId: 42,
      level: 3,
      lane: 'free',
      rewards: [AK, KIT, COINS],
    });

    expect(state.credited[0]?.reference).toBe('rust:pvp1:passe:42:1:2');
  });
});

// ============================================================
//  DO CLIQUE À MOCHILA
// ============================================================

interface Harness {
  readonly service: BattlePassService;
  readonly sync: BattlePassSync;
  readonly state: Spy;
  readonly sent: string[];
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  servers.create({
    id: SERVER,
    name: 'Dev 1',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const state = spy();
  const sent: string[] = [];
  const rcon = rconOf(state);
  const wrapped = {
    get isConnected() {
      return rcon.isConnected;
    },
    send: (command: string) => {
      sent.push(command);

      return rcon.send(command);
    },
  } as unknown as OpsRcon;

  const h = {
    state,
    sent,
  } as Harness & { service: BattlePassService; sync: BattlePassSync };

  h.service = new BattlePassService({
    repository: new BattlePassRepository(db),
    serverIds: () => servers.list().map((server) => server.id),
    onChange: () => h.sync.handleSeasonChanged(),
    onPlayerChange: (serverId, steamId) => h.sync.handlePlayerChanged(serverId, steamId),
  });

  h.sync = new BattlePassSync({
    service: h.service,
    servers: {
      ids: () => [SERVER],
      contextOf: () => ({ rcon: wrapped }),
      onlineOf: () => [PLAYER],
    },
    serverNameOf: () => 'Dev 1',
    deliver: new BattlePassDeliveryService({
      rewards: rewardsOf(state),
      rconOf: () => wrapped,
      kitItemsOf: () => null,
      logger: silent,
    }),
    logger: silent,
    now: () => T0,
  });

  return h;
}

/** Uma temporada publicada, com as duas primeiras casas cheias. */
function publish(h: Harness, overrides: Partial<SeasonInput> = {}): void {
  const input: SeasonInput = seasonInputSchema.parse({
    period: '2026-10',
    label: 'Temporada de outubro de 2026',
    levels: 5,
    xpCurve: { kind: 'flat', perLevel: 1000 },
    servers: [SERVER],
    ...overrides,
  });
  const season = h.service.createSeason(input, PANEL);

  h.service.setTrackCell(season.id, 1, 'free', { rewards: [AK, COINS], milestone: false }, PANEL);
  h.service.setTrackCell(season.id, 2, 'free', { rewards: [AK], milestone: false }, PANEL);
  h.service.setSeasonState(season.id, 'active', PANEL);
  h.service.grantXp(
    { serverId: SERVER, steamId: PLAYER, eventId: 'xp-1', source: 'quest.reward', amount: 5000 },
    T0,
  );
}

/** O segredo desta subida, lido da carga — como o plugin o recebe. */
async function grabSecret(h: Harness): Promise<string> {
  await h.sync.sync(SERVER, 'manual');

  const first = h.sent.find((line) => line.startsWith(`${BATTLEPASS_SYNC} `));
  const parts = (first ?? '').slice(BATTLEPASS_SYNC.length + 1).split(' ');

  return (decodePushPayload(parts[3] ?? '') as BattlePassPayload).secret;
}

function pluginLine(payload: Record<string, unknown>): string {
  return `[OrigemZBattlePass] ${BATTLEPASS_MARKER}${JSON.stringify(payload)}`;
}

/** Deixa os relógios (1 s do sync, 0 do pedido) dispararem. */
async function settle(ms = 1400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A última frase que o jogador leu no rodapé. */
function lastReply(h: Harness): { readonly ok: boolean; readonly message: string } {
  const line = h.sent.filter((command) => command.startsWith(`${BATTLEPASS_REPLY} `)).at(-1);

  if (line === undefined) throw new Error('nenhum reply saiu');

  return decodePushPayload(line.slice(BATTLEPASS_REPLY.length + 1)) as {
    ok: boolean;
    message: string;
  };
}

describe('o resgate com o entregador ligado', () => {
  it('cabendo, entrega e fecha a casa', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.sent.length = 0;
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'r1', steamId: PLAYER, level: 1, lane: 'free' }),
    );
    await settle();

    expect(lastReply(h)).toMatchObject({ ok: true, message: 'Resgatado! Confira a mochila.' });
    expect(h.state.given).toEqual([{ shortname: 'rifle.ak', amount: 1 }]);
    expect(h.state.credited).toHaveLength(1);
    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([
      { level: 1, lane: 'free', state: 'claimed' },
    ]);
    expect(h.service.pendingOf(SERVER, PLAYER)).toEqual([]);
  });

  it('mochila cheia NÃO marca como resgatado, e a frase diz quantos slots faltam', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.state.room = { fits: false, missingSlots: 2 };
    h.sent.length = 0;
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'r2', steamId: PLAYER, level: 1, lane: 'free' }),
    );
    await settle();

    // A marca de `claimed` vem DEPOIS da entrega, nunca antes: a AK
    // não saiu, então a casa continua devendo.
    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([
      { level: 1, lane: 'free', state: 'pending' },
    ]);
    expect(h.state.given).toEqual([]);

    const pending = h.service.pendingOf(SERVER, PLAYER);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ idx: 0, code: 'INVENTORY_FULL', origin: 'inventory' });

    // E o jogador lê o que fazer, e não só que "não coube".
    expect(lastReply(h).message).toBe(
      'Resgatado, mas 1 item não coube: ele ficou na sua caixa. Libere 2 slots na mochila.',
    );
  });

  it('o OZCoin é creditado mesmo quando o item não coube', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.state.room = { fits: false, missingSlots: 1 };
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'r3', steamId: PLAYER, level: 1, lane: 'free' }),
    );
    await settle();

    expect(h.state.credited).toEqual([
      { amount: 500, reference: 'rust:pvp1:passe:1:1:1', reason: 'Passe: Nível 1 (grátis)' },
    ]);
    // A moeda fechou a posição 1; só a AK ficou na caixa.
    expect(h.service.pendingOf(SERVER, PLAYER).map((item) => item.idx)).toEqual([0]);
  });

  it('cabendo parte do lote, entrega a parte e o resto continua devendo', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    // A mochila enche entre um nível e o outro: o primeiro cabe, o
    // segundo já não. O lote NÃO é atômico — cabendo 6 de 17,
    // entregam-se as 6 (02 §6.2).
    h.state.rooms.push({ fits: true }, { fits: false, missingSlots: 3 });
    h.sent.length = 0;
    h.sync.handleLine(SERVER, pluginLine({ kind: 'claimAll', secret, requestId: 'r4', steamId: PLAYER }));
    await settle();

    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([
      { level: 1, lane: 'free', state: 'claimed' },
      { level: 2, lane: 'free', state: 'pending' },
    ]);
    expect(h.state.given).toEqual([{ shortname: 'rifle.ak', amount: 1 }]);
    expect(lastReply(h).message).toBe(
      'Resgatado, mas 1 item não coube: ele ficou na sua caixa. Libere 3 slots na mochila.',
    );
  });

  it('dois cliques não entregam duas vezes', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.sent.length = 0;
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'r5', steamId: PLAYER, level: 1, lane: 'free' }),
    );
    await settle();
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'r6', steamId: PLAYER, level: 1, lane: 'free' }),
    );
    await settle();

    // O segundo clique não chega ao entregador: quem barra é a
    // regra, e ela responde com a frase pronta.
    expect(h.state.given).toEqual([{ shortname: 'rifle.ak', amount: 1 }]);
    expect(h.state.credited).toHaveLength(1);
    expect(lastReply(h)).toMatchObject({ ok: false, message: 'Você já resgatou o nível 1.' });
  });
});
