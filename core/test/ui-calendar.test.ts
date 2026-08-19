// ============================================================
//  ui-calendar.test.ts  -  a página CALENDÁRIO do menu do jogo.
//
//  ####  O TESTE QUE MAIS IMPORTA DESTE ARQUIVO  ####
//
//  É o do §3: ele olha o COMANDO ENVIADO ao servidor, e não a
//  tela. A régua de VIP desta frente é uma promessa sobre o que
//  atravessa o RCON — "sem VIP não vê a seed do próximo mapa" —, e
//  uma tela que simplesmente não desenha a seed cumpre a promessa
//  aos olhos e a quebra na prática: o JSON chega ao cliente inteiro,
//  e quem quiser lê-lo tem o console do próprio jogo para isso.
//
//  Por isso o recorte acontece em `buildPlayerCalendar`, ANTES de
//  existir documento, e por isso o teste decodifica o base64 do
//  `origemz.ui.screen` e procura a seed lá dentro.
//
//  O que este arquivo guarda:
//
//    1. a régua do VIP: 0 mapas / 1 / 3, e a hierarquia do
//       OrigemZVip.json quando ela existe;
//    2. a tela nunca abre vazia — sem agenda ela diz a frase;
//    3. a seed não atravessa o RCON, e a contagem regressiva não
//       fica em cache;
//    4. `GET /wipe/upcoming/me` corta pela MESMA régua, porque usa
//       a mesma função.
// ============================================================

import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { UiDocumentsRepository } from '../src/db/ui-documents-repository.js';
import { VipsRepository } from '../src/db/vips-repository.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import {
  buildCalendarScreen,
  buildPlayerCalendar,
  CALENDAR_SCREEN_ID,
  createCalendarScreenProvider,
  isCalendarScreenId,
  mapAllowanceOf,
  type PlayerCalendar,
} from '../src/game/ui-calendar-screen.js';
import { buildMainMenu, MAIN_MENU_SLUG } from '../src/game/ui-preset-main-menu.js';
import { UiSync } from '../src/game/ui-sync.js';
import { registerWipeRoutes } from '../src/http/routes/wipe.js';
import { createLogger } from '../src/logger.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import { walkElements, type UiScreen } from '../src/types/ui-document.js';
import { UI_REQUEST_MARKER } from '../src/types/ui-transport.js';
import type { MapPoolEntry, WipePlan } from '../src/types/wipe.js';
import type { VipTierLevel } from '../src/vip/tiers.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

const SERVER = 'pvp1';
/** Um SteamID64 de verdade tem 17 dígitos, e o plugin exige isso. */
const PLAYER = '76561198000000001';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Um instante fixo: a contagem regressiva só é conferível contra um. */
const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

/**
 * Uma seed que não se confunde com nada.
 *
 * O teste do §3 procura este texto no comando enviado. Um `4000`
 * apareceria por acaso (é o tamanho do mundo), e o teste passaria
 * ou falharia por engano.
 */
const SECRET_SEED = '13579246';

// ------------------------------------------------------------
//  Fábricas
// ------------------------------------------------------------

function plan(over: Partial<WipePlan> = {}): WipePlan {
  return {
    id: 1,
    serverId: SERVER,
    scheduledAt: NOW + 6 * DAY + 4 * HOUR,
    kind: 'cadence',
    bpPolicy: 'keep',
    mapSource: 'pool',
    mapPoolId: null,
    status: 'planned',
    absorbedBy: null,
    generatedFor: null,
    pinned: false,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function mapEntry(over: Partial<MapPoolEntry> = {}): MapPoolEntry {
  return {
    id: 1,
    serverId: SERVER,
    position: 0,
    kind: 'procedural',
    seed: SECRET_SEED,
    worldSize: 4000,
    level: 'Procedural Map',
    levelUrl: null,
    rustmapsId: null,
    staging: false,
    previewUrl: 'https://files.rustmaps.com/img/287/b3c1f0a2/map.png',
    thumbUrl: null,
    monuments: null,
    status: 'ready',
    lastError: null,
    usedAt: null,
    createdAt: NOW,
    ...over,
  };
}

/** Os níveis do `OrigemZVip.json`, como o plugin os declara. */
const LEVELS: readonly VipTierLevel[] = [
  { tier: 'bronze', group: 'origemz.vip.bronze', title: 'Bronze', rank: 1, parentGroup: null },
  {
    tier: 'silver',
    group: 'origemz.vip.silver',
    title: 'Prata',
    rank: 2,
    parentGroup: 'origemz.vip.bronze',
  },
  {
    tier: 'gold',
    group: 'origemz.vip.gold',
    title: 'Ouro',
    rank: 3,
    parentGroup: 'origemz.vip.silver',
  },
];

/** Todo o texto que a tela desenha, numa string só. */
function textOf(screen: UiScreen): string {
  const parts: string[] = [];

  for (const { element } of walkElements(screen.elements)) {
    if (element.type === 'label') {
      parts.push(element.text);
    }

    if (element.type === 'image' && element.source.kind === 'url') {
      parts.push(element.source.url);
    }
  }

  return parts.join('\n');
}

function calendarOf(over: Partial<PlayerCalendar> = {}): PlayerCalendar {
  return {
    now: NOW,
    timeZone: 'America/Sao_Paulo',
    tier: null,
    mapsAllowed: 0,
    wipes: [],
    maps: [],
    ...over,
  };
}

// ============================================================
//  §1  A RÉGUA DO VIP
// ============================================================

describe('a régua do VIP', () => {
  it('sem VIP e com bronze, nenhum mapa do futuro', () => {
    expect(mapAllowanceOf([], LEVELS)).toEqual({ maps: 0, tier: null });
    expect(mapAllowanceOf(['bronze'], LEVELS)).toEqual({ maps: 0, tier: 'bronze' });
  });

  it('prata vê o próximo mapa; ouro vê os três', () => {
    expect(mapAllowanceOf(['silver'], LEVELS).maps).toBe(1);
    expect(mapAllowanceOf(['gold'], LEVELS).maps).toBe(3);
  });

  it('o nível MAIS ALTO manda, e não o primeiro da lista', () => {
    // Quem comprou bronze e ganhou ouro de brinde leva o do ouro.
    expect(mapAllowanceOf(['bronze', 'gold'], LEVELS)).toEqual({ maps: 3, tier: 'gold' });
  });

  it('um nível de rank alto herda o direito do que está abaixo', () => {
    const levels: readonly VipTierLevel[] = [
      ...LEVELS,
      // Um nível que o dono do servidor inventou, acima do ouro.
      { tier: 'diamante', group: 'origemz.vip.dia', title: null, rank: 9, parentGroup: null },
    ];

    expect(mapAllowanceOf(['diamante'], levels).maps).toBe(3);
  });

  it('sem o config do plugin lido, só a igualdade de nome vale', () => {
    // Sem os níveis não há hierarquia a afirmar. `silver` continua
    // valendo por ele mesmo; um nível desconhecido não desbloqueia
    // nada — inventar ordem aqui daria vantagem por acidente.
    expect(mapAllowanceOf(['silver'], []).maps).toBe(1);
    expect(mapAllowanceOf(['diamante'], []).maps).toBe(0);
  });

  it('corta a fila de mapas pelo nível, e sempre sem a seed', () => {
    const queue = [
      mapEntry({ id: 1, position: 0 }),
      mapEntry({ id: 2, position: 1, seed: '111' }),
      mapEntry({ id: 3, position: 2, seed: '222' }),
      mapEntry({ id: 4, position: 3, seed: '333' }),
    ];

    const base = { now: NOW, timeZone: 'UTC', plans: [plan()], queue, levels: LEVELS };

    expect(buildPlayerCalendar({ ...base, tiers: [] }).maps).toEqual([]);
    expect(buildPlayerCalendar({ ...base, tiers: ['silver'] }).maps).toHaveLength(1);
    expect(buildPlayerCalendar({ ...base, tiers: ['gold'] }).maps).toHaveLength(3);

    // O tipo não tem campo de seed, e o objeto tampouco: é isto que
    // impede a seed de chegar ao desenho por acidente.
    for (const map of buildPlayerCalendar({ ...base, tiers: ['gold'] }).maps) {
      expect(Object.keys(map)).not.toContain('seed');
      expect(JSON.stringify(map)).not.toContain(SECRET_SEED);
    }
  });

  it('não promete mapa que ainda está sendo desenhado', () => {
    const queue = [
      mapEntry({ id: 1, status: 'generating' }),
      mapEntry({ id: 2, seed: '999', status: 'ready', worldSize: 3500 }),
    ];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      plans: [plan()],
      queue,
      tiers: ['silver'],
      levels: LEVELS,
    });

    expect(calendar.maps).toHaveLength(1);
    expect(calendar.maps[0]?.worldSize).toBe(3500);
  });

  it('descarta a imagem cuja URL carrega a seed dentro', () => {
    // A página do RustMaps tem a forma `rustmaps.com/map/4000_18422`.
    // Se uma dessas cair na coluna, a imagem some e o resto fica: a
    // prévia é enfeite, e a seed não é.
    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      plans: [plan()],
      queue: [mapEntry({ previewUrl: `https://rustmaps.com/map/4000_${SECRET_SEED}` })],
      tiers: ['silver'],
      levels: LEVELS,
    });

    expect(calendar.maps[0]?.previewUrl).toBeNull();
  });

  it('o passado e o que já foi pulado ficam de fora', () => {
    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      plans: [
        plan({ id: 1, scheduledAt: NOW - DAY }),
        plan({ id: 2, scheduledAt: NOW + DAY, status: 'skipped' }),
        plan({ id: 3, scheduledAt: NOW + 2 * DAY }),
        // O absorvido FICA, marcado: uma agenda com um buraco não
        // explica por que terça não vai ter wipe.
        plan({ id: 4, scheduledAt: NOW + 3 * DAY, status: 'absorbed' }),
      ],
      queue: [],
      tiers: [],
      levels: [],
    });

    expect(calendar.wipes.map((wipe) => wipe.scheduledAt)).toEqual([NOW + 2 * DAY, NOW + 3 * DAY]);
    expect(calendar.wipes[1]?.absorbed).toBe(true);
  });
});

// ============================================================
//  §2  A TELA
// ============================================================

describe('a tela do calendário', () => {
  it('reconhece o endereço dela, e só ele', () => {
    expect(isCalendarScreenId(CALENDAR_SCREEN_ID)).toBe(true);
    expect(isCalendarScreenId('tela-kits')).toBe(false);
    expect(isCalendarScreenId('tela-calendario:2')).toBe(false);
  });

  it('sem agenda, ela diz a frase — e NÃO abre vazia', () => {
    const screen = buildCalendarScreen({ calendar: calendarOf() });
    const text = textOf(screen);

    expect(screen.elements.length).toBeGreaterThan(0);
    expect(text).toContain('SEM WIPE AGENDADO');
    // E continua explicando o resto: uma tela que só diz "nada" faz
    // o jogador achar que ela quebrou.
    expect(text).toContain('CALENDÁRIO');
  });

  it('mostra a data, quanto falta e o que o wipe leva', () => {
    const screen = buildCalendarScreen({
      calendar: calendarOf({
        wipes: [
          {
            scheduledAt: NOW + 6 * DAY + 4 * HOUR,
            kind: 'cadence',
            bpPolicy: 'keep',
            absorbed: false,
          },
        ],
      }),
    });

    const text = textOf(screen);

    // A mesma conta do `{wipe.faltam}` do chat: uma segunda aqui
    // daria dois números para a mesma pergunta.
    expect(text).toContain('faltam 6 dias e 4 horas');
    expect(text).toContain('BLUEPRINTS');
    expect(text).toContain('mantidos');
    // 12:00 UTC é 09:00 em São Paulo — a data sai no fuso do
    // servidor, e não no do processo.
    expect(text).toContain('25/08');
  });

  it('reaberta um minuto depois, mostra o número atualizado', () => {
    const wipeAt = NOW + 2 * HOUR;

    const first = textOf(
      buildCalendarScreen({
        calendar: calendarOf({
          wipes: [{ scheduledAt: wipeAt, kind: 'forced', bpPolicy: 'keep', absorbed: false }],
        }),
      }),
    );

    const later = textOf(
      buildCalendarScreen({
        calendar: calendarOf({
          now: NOW + 30 * 60_000,
          wipes: [{ scheduledAt: wipeAt, kind: 'forced', bpPolicy: 'keep', absorbed: false }],
        }),
      }),
    );

    expect(first).toContain('faltam 2 horas');
    expect(later).toContain('faltam 1 hora e 30 minutos');
  });

  it('quem não alcança a régua lê a OFERTA, e não um buraco', () => {
    const text = textOf(buildCalendarScreen({ calendar: calendarOf() }));

    expect(text).toContain('VIP PRATA VÊ O MAPA DO PRÓXIMO WIPE');
    expect(text).toContain('OURO');
    // A seed não é uma vantagem à venda nesta tela, e a frase diz
    // isso para não parecer que ela vem com o nível seguinte.
    expect(text).toContain('A seed continua sendo segredo até o wipe, para todo mundo');
  });

  it('quem alcança vê o tamanho e a imagem — nunca a seed', () => {
    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      plans: [plan()],
      queue: [mapEntry(), mapEntry({ id: 2, seed: '777', worldSize: 3000 })],
      tiers: ['gold'],
      levels: LEVELS,
    });

    const text = textOf(buildCalendarScreen({ calendar }));

    expect(text).toContain('PROCEDURAL 4000');
    expect(text).toContain('https://files.rustmaps.com/img/287/b3c1f0a2/map.png');
    expect(text).toContain('#2 na fila');
    expect(text).not.toContain(SECRET_SEED);
  });

  it('com a fila vazia, diz que o mundo é sorteado na hora', () => {
    const text = textOf(
      buildCalendarScreen({ calendar: calendarOf({ mapsAllowed: 1, tier: 'silver' }) }),
    );

    expect(text).toContain('A FILA DE MAPAS ESTÁ VAZIA');
    expect(text).toContain('sorteado na hora');
  });

  it('o id volta IDÊNTICO ao pedido', () => {
    // O plugin descarta a resposta cujo id não bate com o que ele
    // pediu, e o jogador fica com o aviso de carregando na tela.
    const screen = buildCalendarScreen({
      calendar: calendarOf(),
      screenId: CALENDAR_SCREEN_ID,
    });

    expect(screen.id).toBe(CALENDAR_SCREEN_ID);
    expect(screen.kind).toBe('page');
  });
});

// ============================================================
//  §3  O QUE ATRAVESSA O RCON
// ============================================================

interface FakeServer {
  connected: boolean;
  readonly sent: string[];
}

interface Harness {
  readonly db: AgentDatabase;
  readonly server: FakeServer;
  readonly sync: UiSync;
  readonly vips: VipsRepository;
}

let harness: Harness;

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'PVP 1',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const schedule = new WipeScheduleRepository(db);
  const mapPool = new MapPoolRepository(db);
  const vips = new VipsRepository(db);

  schedule.createPlan(SERVER, { scheduledAt: NOW + 6 * DAY + 4 * HOUR, bpPolicy: 'keep' }, NOW);

  const first = mapPool.add(SERVER, { seed: SECRET_SEED, worldSize: 4000 }, NOW).entry;

  mapPool.markPreviewReady(
    SERVER,
    first.id,
    {
      rustmapsId: 'b3c1f0a2',
      staging: false,
      previewUrl: 'https://files.rustmaps.com/img/287/b3c1f0a2/map.png',
      thumbUrl: null,
      monuments: null,
    },
    NOW,
  );

  mapPool.add(SERVER, { seed: '24680135', worldSize: 3500 }, NOW);

  const server: FakeServer = { connected: true, sent: [] };
  const repository = new UiDocumentsRepository(db, silent);

  repository.create(buildMainMenu());
  repository.setBinding(SERVER, 1, { enabled: true, hidden: [] });

  const sync = new UiSync({
    repository,
    servers: {
      ids: () => [SERVER],
      contextOf: (id) =>
        id === SERVER
          ? {
              rcon: {
                get isConnected() {
                  return server.connected;
                },
                send: (command: string) => {
                  server.sent.push(command);

                  return Promise.resolve('{"ok":true}');
                },
              },
            }
          : null,
    },
    logger: silent,
    generatedScreens: createCalendarScreenProvider({
      schedule,
      mapPool,
      vips,
      now: () => NOW,
    }),
  });

  harness = { db, server, sync, vips };
});

/** Pede a tela como o plugin pede, e devolve o JSON que saiu. */
async function askCalendar(steamId?: string): Promise<string> {
  harness.server.sent.length = 0;

  const request = {
    requestId: 'r1',
    documentId: MAIN_MENU_SLUG,
    screenId: CALENDAR_SCREEN_ID,
    ...(steamId === undefined ? {} : { steamId }),
  };

  harness.sync.handleLine(SERVER, `[OrigemZUI] ${UI_REQUEST_MARKER}${JSON.stringify(request)}`);

  await new Promise((resolve) => setImmediate(resolve));

  const sent = harness.server.sent.at(-1) ?? '';

  expect(sent).toMatch(/^origemz\.ui\.screen /);

  return Buffer.from(sent.split(' ')[1] ?? '', 'base64').toString('utf8');
}

describe('o comando que chega ao servidor', () => {
  it('o jogador SEM VIP não recebe a seed nem a imagem na payload', async () => {
    const json = await askCalendar(PLAYER);

    // A prova da frente: não é que a tela não desenhe a seed — é
    // que ela não está no comando. Um widget invisível carregando o
    // número seria uma tela certa com um vazamento atrás.
    expect(json).not.toContain(SECRET_SEED);
    expect(json).not.toContain('files.rustmaps.com');
    expect(json).toContain('VIP PRATA');
  });

  it('o jogador com PRATA recebe a imagem — e continua sem a seed', async () => {
    harness.vips.grant(
      { steamId: PLAYER, tier: 'silver', expiresAt: null, origin: 'painel', createdBy: 'teste' },
      NOW,
    );

    const json = await askCalendar(PLAYER);

    expect(json).toContain('files.rustmaps.com');
    expect(json).toContain('4000');
    expect(json).not.toContain(SECRET_SEED);
  });

  it('o OURO vê os próximos da fila, e nenhuma das seeds', async () => {
    harness.vips.grant(
      { steamId: PLAYER, tier: 'gold', expiresAt: null, origin: 'painel', createdBy: 'teste' },
      NOW,
    );

    const json = await askCalendar(PLAYER);

    expect(json).toContain('#2 na fila');
    expect(json).toContain('3500');
    expect(json).not.toContain(SECRET_SEED);
    expect(json).not.toContain('24680135');
  });

  it('sem SteamID no pedido, a resposta é a de quem não tem VIP', async () => {
    // Plugin antigo, ou a carga que vai ao servidor sem jogador
    // nenhum: negar por falta de identidade é a saída conservadora.
    const json = await askCalendar();

    expect(json).not.toContain(SECRET_SEED);
    expect(json).toContain('VIP PRATA');
  });

  it('a tela vai marcada para NÃO ficar em cache', async () => {
    const json = await askCalendar(PLAYER);
    const payload = JSON.parse(json) as { readonly screen: { readonly volatile?: boolean } };

    // Em cache, "faltam 6 dias e 4 horas" ficaria dizendo as mesmas
    // seis horas para sempre — e o jogador decidiria se sobe a base
    // hoje confiando naquilo.
    expect(payload.screen.volatile).toBe(true);
  });

  it('o pedido de outra tela continua sendo servido pelo documento', async () => {
    harness.server.sent.length = 0;

    harness.sync.handleLine(
      SERVER,
      `[OrigemZUI] ${UI_REQUEST_MARKER}${JSON.stringify({
        requestId: 'r2',
        documentId: MAIN_MENU_SLUG,
        screenId: 'tela-regras',
      })}`,
    );

    await new Promise((resolve) => setImmediate(resolve));

    const sent = harness.server.sent.at(-1) ?? '';
    const json = Buffer.from(sent.split(' ')[1] ?? '', 'base64').toString('utf8');

    // O provedor devolve `null` para o que não é dele, e o caminho
    // normal segue: a tela desenhada no editor.
    //
    // A palavra procurada é "PRÓXIMO WIPE", e não "CALENDÁRIO": o
    // botão do calendário está no SHELL, e o shell viaja em toda
    // tela para o destaque da navegação continuar certo.
    expect(json).toContain('tela-regras');
    expect(json).not.toContain('PRÓXIMO WIPE');
  });
});

// ============================================================
//  §4  A ROTA DO JOGADOR
// ============================================================

describe('GET /wipe/upcoming/me', () => {
  function buildApi() {
    const db = openDatabase({ file: MEMORY_DATABASE });

    runMigrations(db);

    new ServersRepository(db).create({
      id: SERVER,
      name: 'PVP 1',
      identity: SERVER,
      gamePort: 28_015,
      rconPort: 28_016,
      queryPort: 28_017,
      appPort: 28_082,
      installDir: 'F:\\Servers\\pvp1',
    });

    const repository = new WipeScheduleRepository(db);
    const mapPool = new MapPoolRepository(db);
    const vips = new VipsRepository(db);

    repository.createPlan(SERVER, { scheduledAt: Date.now() + 3 * DAY, bpPolicy: 'wipe' }, Date.now());
    mapPool.add(SERVER, { seed: SECRET_SEED, worldSize: 4000 });

    const app = Fastify();

    void app.register(
      async (api) => {
        registerWipeRoutes(api, {
          repository,
          // A rota só chama `ids()` e `configOf()`: montar o
          // supervisor de verdade traria processo, RCON e disco
          // para um teste que fala de recorte.
          supervisor: { ids: () => [SERVER], configOf: () => null } as unknown as ServerSupervisor,
          mapPool,
          vips,
        });

        return Promise.resolve();
      },
      { prefix: '/api' },
    );

    return { app, db, vips };
  }

  it('sem steamId, devolve a agenda e nenhum mapa', async () => {
    const { app, db } = buildApi();
    await app.ready();

    const response = await app.inject(`/api/servers/${SERVER}/wipe/upcoming/me`);
    const body = response.json() as {
      readonly mapsAllowed: number;
      readonly maps: readonly unknown[];
      readonly wipes: readonly unknown[];
    };

    expect(response.statusCode).toBe(200);
    expect(body.wipes).toHaveLength(1);
    expect(body.mapsAllowed).toBe(0);
    expect(body.maps).toEqual([]);
    expect(response.body).not.toContain(SECRET_SEED);

    await app.close();
    db.close();
  });

  it('com PRATA, devolve o mapa #1 sem a seed', async () => {
    const { app, db, vips } = buildApi();
    await app.ready();

    vips.grant({
      steamId: PLAYER,
      tier: 'silver',
      expiresAt: null,
      origin: 'painel',
      createdBy: 'teste',
    });

    const response = await app.inject(
      `/api/servers/${SERVER}/wipe/upcoming/me?steamId=${PLAYER}`,
    );

    const body = response.json() as {
      readonly tier: string | null;
      readonly mapsAllowed: number;
      readonly maps: readonly { readonly worldSize: number }[];
    };

    expect(body.tier).toBe('silver');
    expect(body.mapsAllowed).toBe(1);
    expect(body.maps[0]?.worldSize).toBe(4000);
    // O corte é o MESMO da tela do jogo, porque é a mesma função.
    expect(response.body).not.toContain(SECRET_SEED);

    await app.close();
    db.close();
  });

  it('num servidor que não existe, 404 com a lista dos que existem', async () => {
    const { app, db } = buildApi();
    await app.ready();

    const response = await app.inject('/api/servers/nao-existe/wipe/upcoming/me');

    expect(response.statusCode).toBe(404);

    await app.close();
    db.close();
  });
});
