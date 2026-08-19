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
import { WipeRunsRepository, type WipeRunRecord } from '../src/db/wipe-runs-repository.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import {
  buildCalendarScreen,
  buildEmptyCalendarBundle,
  buildPlayerCalendar,
  CALENDAR_SCREEN_ID,
  createCalendarScreenProvider,
  isCalendarScreenId,
  mapAllowanceOf,
  type CalendarNextWipeView,
  type PlayerCalendar,
} from '../src/game/ui-calendar-screen.js';
import { buildMainMenu, MAIN_MENU_SLUG } from '../src/game/ui-preset-main-menu.js';
import { UiSync } from '../src/game/ui-sync.js';
import { registerWipeRoutes } from '../src/http/routes/wipe.js';
import { createLogger } from '../src/logger.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import { walkElements, type UiElement, type UiScreen } from '../src/types/ui-document.js';
import { UI_REQUEST_MARKER } from '../src/types/ui-transport.js';
import type { MapPoolEntry, WipePlan, WipeSettings } from '../src/types/wipe.js';
import type { VipTierLevel } from '../src/vip/tiers.js';
import { nextWipe, type NextWipe } from '../src/wipe/next-wipe.js';

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
    versionOk: false,
    status: 'ready',
    lastError: null,
    usedAt: null,
    createdAt: NOW,
    ...over,
  };
}

function settings(timeZone = 'UTC'): WipeSettings {
  return {
    cadence: {
      enabled: true,
      everyDays: 7,
      anchorAt: NOW,
      timeOfDay: '16:00',
      timeZone,
      bpPolicy: 'keep',
    },
    forced: { bpPolicy: 'keep' },
    collision: { policy: 'absorb', windowHours: 36 },
  };
}

interface DecideInput {
  readonly plans?: readonly WipePlan[];
  readonly queue?: readonly MapPoolEntry[];
  readonly runs?: readonly WipeRunRecord[];
  readonly now?: number;
  readonly timeZone?: string;
}

/**
 * QUAL é o próximo wipe, decidido pela MESMA função do chat.
 *
 * O teste não monta este objeto à mão de propósito: ele chama
 * `nextWipe`, que é quem responde `{wipe.faltam}`. Uma tela montada
 * sobre um `next` inventado passaria mesmo depois de o agente voltar
 * a ter duas contas — que é exatamente o defeito que esta suíte
 * existe para prender.
 */
function decide(input: DecideInput = {}): NextWipe | null {
  const plans = input.plans ?? [];
  const queue = input.queue ?? [];
  const runs = input.runs ?? [];

  return nextWipe(
    SERVER,
    {
      schedule: {
        getSettings: () => settings(input.timeZone),
        listPlans: (_serverId, options) =>
          plans.filter((item) => options?.from === undefined || item.scheduledAt >= options.from),
        getPlan: (_serverId, id) => plans.find((item) => item.id === id) ?? null,
        nextPlan: () => null,
      },
      runs: { running: () => runs },
      mapPool: {
        // A mesma regra do `MapPoolRepository.next`: só `ready`, e
        // num wipe FORÇADO o custom sem marca de versão é pulado.
        next: (_serverId, forced) =>
          queue.find(
            (entry) => entry.status === 'ready' && !(forced === true && entry.kind === 'custom'),
          ) ?? null,
        get: (_serverId, id) => queue.find((entry) => entry.id === id) ?? null,
      },
    },
    input.now ?? NOW,
  );
}

function run(over: Partial<WipeRunRecord> = {}): WipeRunRecord {
  return {
    id: 1,
    serverId: SERVER,
    planId: null,
    operationId: null,
    kind: 'manual',
    bpPolicy: 'keep',
    fullWipe: false,
    startedAt: NOW,
    wipeAt: NOW + 3 * HOUR,
    finishedAt: null,
    status: 'running',
    backupPath: null,
    mapBefore: null,
    mapAfter: null,
    saveCreatedBefore: null,
    saveCreatedAfter: null,
    message: null,
    steps: [],
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
  return textOfElements(screen.elements);
}

/**
 * O texto de UM cartão só, pelo id do painel dele.
 *
 * ####  A TELA INTEIRA FAZ O TESTE PASSAR POR ACIDENTE  ####
 *
 * O cartão da ESQUERDA escreve `MAPA          sorteado na hora`, e
 * o da direita é outro assunto. Um teste que procura a frase na
 * tela inteira encontra a linha da esquerda e passa mesmo quando o
 * cartão do MUNDO está dizendo outra coisa — foi assim que "o
 * cartão diz que o mundo é sorteado na hora" ficou verde enquanto
 * o cartão dizia "a imagem deste mundo ainda não ficou pronta".
 */
function cardTextOf(screen: UiScreen, id: string): string {
  for (const { element } of walkElements(screen.elements)) {
    if (element.id === id) {
      return textOfElements(element.children);
    }
  }

  throw new Error(`a tela não tem o cartão ${id}`);
}

/** O texto de UM rótulo, pelo id — o que aquele widget diz, e nada mais. */
function labelOf(screen: UiScreen, id: string): string {
  for (const { element } of walkElements(screen.elements)) {
    if (element.id === id && element.type === 'label') {
      return element.text;
    }
  }

  throw new Error(`a tela não tem o rótulo ${id}`);
}

function textOfElements(elements: readonly UiElement[]): string {
  const parts: string[] = [];

  for (const { element } of walkElements(elements)) {
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
    next: null,
    wipes: [],
    maps: [],
    ...over,
  };
}

/** O cartão grande, para os testes que só olham o desenho. */
function nextOf(over: Partial<CalendarNextWipeView> = {}): CalendarNextWipeView {
  return {
    scheduledAt: NOW + 6 * DAY + 4 * HOUR,
    kind: 'cadence',
    bpPolicy: 'keep',
    running: false,
    map: null,
    image: null,
    // O padrão é o de quem NÃO alcança a régua, como `map` e
    // `image`: quem quiser outro caso diz qual é.
    mapFromQueue: false,
    mapFrom: null,
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

    const plans = [plan()];

    const base = {
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      levels: LEVELS,
    };

    // O mundo do PRÓXIMO wipe conta como o #1 da régua: ele é
    // `next.image`, e não `maps[0]` — a fila e o plano podem
    // apontar para entradas diferentes.
    const seen = (tiers: readonly string[]): number => {
      const calendar = buildPlayerCalendar({ ...base, tiers });

      return (calendar.next?.image === null ? 0 : 1) + calendar.maps.length;
    };

    expect(seen([])).toBe(0);
    expect(seen(['silver'])).toBe(1);
    expect(seen(['gold'])).toBe(3);

    // O tipo não tem campo de seed, e o objeto tampouco: é isto que
    // impede a seed de chegar ao desenho por acidente.
    const gold = buildPlayerCalendar({ ...base, tiers: ['gold'] });

    for (const map of [gold.next?.image, ...gold.maps]) {
      expect(Object.keys(map ?? {})).not.toContain('seed');
      expect(JSON.stringify(map)).not.toContain(SECRET_SEED);
    }
  });

  it('não promete mapa que ainda está sendo desenhado', () => {
    const queue = [
      mapEntry({ id: 1, status: 'generating' }),
      mapEntry({ id: 2, seed: '999', status: 'ready', worldSize: 3500 }),
    ];

    const plans = [plan()];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      tiers: ['silver'],
      levels: LEVELS,
    });

    expect(calendar.next?.image?.worldSize).toBe(3500);
    expect(calendar.maps).toHaveLength(0);
  });

  it('descarta a imagem cuja URL carrega a seed dentro', () => {
    // A página do RustMaps tem a forma `rustmaps.com/map/4000_18422`.
    // Se uma dessas cair na coluna, a imagem some e o resto fica: a
    // prévia é enfeite, e a seed não é.
    const plans = [plan()];
    const queue = [mapEntry({ previewUrl: `https://rustmaps.com/map/4000_${SECRET_SEED}` })];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      tiers: ['silver'],
      levels: LEVELS,
    });

    expect(calendar.next?.image?.previewUrl).toBeNull();
    // E a anulação deixa RASTRO: sem ele, um mundo com a prévia
    // pronta no banco aparece para sempre como "ainda não ficou
    // pronta", e ninguém tem por onde começar a procurar.
    expect(calendar.next?.image?.imageHiddenBy).toBe('seed-na-url');
  });

  it('uma seed curta NÃO apaga a prévia por casar com pedaço da URL', () => {
    // `files.rustmaps.com/img/287/b3c1f0a2/map.png` carrega dígitos
    // no caminho, e `7` é seed válida. Com `includes`, o VIP lia
    // PARA SEMPRE "a imagem deste mundo ainda não ficou pronta" com
    // a prévia pronta no banco. A comparação é por TOKEN inteiro.
    const plans = [plan()];
    const queue = [mapEntry({ seed: '7' })];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      tiers: ['silver'],
      levels: LEVELS,
    });

    expect(calendar.next?.image?.previewUrl).toBe(
      'https://files.rustmaps.com/img/287/b3c1f0a2/map.png',
    );
    expect(calendar.next?.image?.imageHiddenBy).toBeNull();
  });

  it('o passado e o que já foi pulado ficam de fora', () => {
    const plans = [
      plan({ id: 1, scheduledAt: NOW - DAY }),
      plan({ id: 2, scheduledAt: NOW + DAY, status: 'skipped' }),
      plan({ id: 3, scheduledAt: NOW + 2 * DAY }),
      // O absorvido FICA, marcado: uma agenda com um buraco não
      // explica por que terça não vai ter wipe.
      plan({ id: 4, scheduledAt: NOW + 3 * DAY, status: 'absorbed' }),
    ];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans }),
      plans,
      queue: [],
      tiers: [],
      levels: [],
    });

    // O #3 é o próximo, e ele tem cartão próprio: a lista "DEPOIS"
    // não o repete.
    expect(calendar.next?.scheduledAt).toBe(NOW + 2 * DAY);
    expect(calendar.wipes.map((wipe) => wipe.scheduledAt)).toEqual([NOW + 3 * DAY]);
    expect(calendar.wipes[0]?.absorbed).toBe(true);
  });
});

// ============================================================
//  §1b  QUAL WIPE É O PRÓXIMO — a mesma resposta do chat
// ============================================================

describe('o cartão PRÓXIMO WIPE', () => {
  it('nas horas antes da hora marcada, o plano `running` é o próximo', () => {
    // ####  O CENÁRIO MEDIDO  ####
    //
    // Quarta, 14:00. O wipe é quinta às 10:00 — daqui a 20 horas. O
    // relógio já disparou o plano (a antecedência é o maior offset
    // de aviso, 1440 min no padrão), então ele está `running` e o
    // passo `avisar` já anuncia "WIPE em 20 horas" no chat.
    //
    // Um filtro que só aceita `planned` pula esse plano e mostra o
    // da semana seguinte: "faltam 7 dias e 20 horas".
    const plans = [
      plan({ id: 1, scheduledAt: NOW + 20 * HOUR, status: 'running' }),
      plan({ id: 2, scheduledAt: NOW + 20 * HOUR + 7 * DAY }),
    ];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans }),
      plans,
      queue: [],
      tiers: [],
      levels: [],
    });

    expect(calendar.next?.scheduledAt).toBe(NOW + 20 * HOUR);
    expect(calendar.next?.running).toBe(true);

    const text = textOf(buildCalendarScreen({ calendar }));

    expect(text).toContain('faltam 20 horas');
    expect(text).not.toContain('faltam 7 dias');
    // E a tela diz que ele já está em curso: é a mesma janela em que
    // o passo `avisar` está falando no chat.
    expect(text).toContain('já começou');
  });

  it('o absorvido NA POSIÇÃO [0] não vira o cartão grande', () => {
    // Colisão em `absorb`, com o wipe de cadência CAINDO ANTES do
    // forçado: o absorvido é o mais próximo da agenda. No cartão
    // grande ele daria ao jogador data, contagem regressiva e
    // política de blueprint de um wipe que não vai acontecer — e
    // sem a marca "cancelado pelo forçado", que só é desenhada na
    // lista de baixo.
    const plans = [
      plan({ id: 1, scheduledAt: NOW + DAY, status: 'absorbed', bpPolicy: 'keep', absorbedBy: 2 }),
      plan({ id: 2, scheduledAt: NOW + 2 * DAY, kind: 'forced', bpPolicy: 'wipe' }),
    ];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans }),
      plans,
      queue: [],
      tiers: [],
      levels: [],
    });

    expect(calendar.next?.scheduledAt).toBe(NOW + 2 * DAY);
    expect(calendar.next?.kind).toBe('forced');
    // E a política do cartão é a DO FORÇADO, e não a do cancelado.
    expect(calendar.next?.bpPolicy).toBe('wipe');

    const text = textOf(buildCalendarScreen({ calendar }));

    expect(text).toContain('faltam 2 dias');
    expect(text).toContain('zerados');
    // O cancelado continua na agenda, marcado — uma lista com um
    // buraco não explica por que terça não vai ter wipe.
    expect(text).toContain('cancelado pelo forçado');
  });

  it('o WIPAR AGORA com hora marcada não tem plano, e mesmo assim conta', () => {
    // `POST /wipe/runs` com `at` = agora + 3 h e sem `planId`: quem
    // sabe deste wipe é `wipe_runs`, e só ela. Uma tela que lê só
    // `wipe_plans` diz "sem wipe agendado" enquanto o chat conta as
    // três horas.
    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ runs: [run({ wipeAt: NOW + 3 * HOUR, bpPolicy: 'wipe_except_vip' })] }),
      plans: [],
      queue: [],
      tiers: [],
      levels: [],
    });

    const text = textOf(buildCalendarScreen({ calendar }));

    expect(text).toContain('faltam 3 horas');
    expect(text).not.toContain('SEM WIPE AGENDADO');
    expect(text).toContain('mantidos só para quem tem VIP');
  });

  it('a execução em curso esconde o plano dela da lista DEPOIS', () => {
    const plans = [
      plan({ id: 7, scheduledAt: NOW + 2 * HOUR, status: 'running' }),
      plan({ id: 8, scheduledAt: NOW + 7 * DAY }),
    ];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, runs: [run({ planId: 7, wipeAt: NOW + 2 * HOUR })] }),
      plans,
      queue: [],
      tiers: [],
      levels: [],
    });

    expect(calendar.next?.scheduledAt).toBe(NOW + 2 * HOUR);
    expect(calendar.wipes.map((wipe) => wipe.scheduledAt)).toEqual([NOW + 7 * DAY]);
  });
});

// ============================================================
//  §1c  O MUNDO ANUNCIADO É O DO PLANO
// ============================================================

describe('o mapa do próximo wipe', () => {
  const queue = [
    mapEntry({ id: 1, position: 0, worldSize: 4000 }),
    mapEntry({ id: 2, position: 1, seed: '111', worldSize: 3000 }),
  ];

  function calendarFor(plans: readonly WipePlan[], entries = queue): PlayerCalendar {
    return buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue: entries }),
      plans,
      queue: entries,
      tiers: ['silver'],
      levels: LEVELS,
    });
  }

  it('com `keep`, é o mesmo mundo de agora — e não a cabeça da fila', () => {
    const calendar = calendarFor([plan({ mapSource: 'keep' })]);

    // A MESMA frase de `{wipe.mapa}` no chat.
    expect(calendar.next?.map).toBe('o mesmo mapa de agora');
    expect(calendar.next?.image).toBeNull();

    // ####  A ASSERÇÃO É SOBRE O QUE O CARTÃO ANUNCIA  ####
    //
    // Ela já foi `not.toContain('4000')` sobre a tela inteira, e
    // isso dizia duas coisas de uma vez: que a cabeça da fila não é
    // o mundo do próximo wipe (verdade, e é o que este teste
    // guarda) e que ela some da tela (falso — nada dela foi
    // consumido, e a régua do nível a lista como FILA, numerada a
    // partir do #1; ver §1d).
    const screen = buildCalendarScreen({ calendar });

    expect(labelOf(screen, 'cal-mapa-t')).toBe('O MESMO MAPA DE AGORA');
    expect(cardTextOf(screen, 'cal-mapa')).not.toContain('PROCEDURAL 4000');
  });

  it('com `fixed`, é a entrada apontada, esteja onde estiver na fila', () => {
    const calendar = calendarFor([plan({ mapSource: 'fixed', mapPoolId: 2 })]);

    expect(calendar.next?.map).toBe('procedural 3000');
    expect(calendar.next?.image?.worldSize).toBe(3000);
    // E o que sobra da fila não repete o mundo já anunciado.
    expect(calendar.maps.map((map) => map.worldSize)).not.toContain(3000);
  });

  it('num wipe FORÇADO, o custom sem marca de versão é pulado', () => {
    // O `.map` de ontem não sobe na versão de amanhã: `next` o pula,
    // e vender essa prévia ao VIP prata é vender o mundo errado.
    const entries = [
      mapEntry({ id: 1, position: 0, kind: 'custom', seed: null, level: 'Ilha', worldSize: null }),
      mapEntry({ id: 2, position: 1, seed: '111', worldSize: 3000 }),
    ];

    const calendar = calendarFor([plan({ kind: 'forced', bpPolicy: 'wipe' })], entries);

    expect(calendar.next?.map).toBe('procedural 3000');
    expect(textOf(buildCalendarScreen({ calendar }))).not.toContain('Ilha');
  });

  it('sem fila, o cartão do MUNDO diz que ele é sorteado na hora', () => {
    const calendar = calendarFor([plan()], []);

    expect(calendar.next?.map).toBe('sorteado na hora');
    expect(calendar.next?.mapFrom).toBe('undecided');

    // A asserção é sobre o cartão da DIREITA. Sobre a tela inteira
    // ela ficava verde por acidente: quem tinha a frase era a linha
    // `MAPA          sorteado na hora` do cartão da ESQUERDA,
    // enquanto o cartão do mundo dizia "a imagem deste mundo ainda
    // não ficou pronta" — sobre um mundo que ninguém escolheu.
    const card = cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');

    expect(card).toContain('SORTEADO NA HORA');
    expect(card).toContain('o mundo ainda não foi escolhido');
    expect(card).not.toContain('ainda não ficou pronta');
  });

  it('sem o nível, a frase do mundo NEM CHEGA a existir', () => {
    const plans = [plan()];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      tiers: [],
      levels: LEVELS,
    });

    expect(calendar.next?.map).toBeNull();
    expect(calendar.next?.image).toBeNull();
    expect(JSON.stringify(calendar)).not.toContain('4000');
  });
});

// ============================================================
//  §1d  A RÉGUA CONTA MUNDOS, E NÃO POSIÇÕES DA FILA
//
//  ####  O DEFEITO QUE ESTA SEÇÃO PRENDE  ####
//
//  Quando o mundo do próximo wipe passou a sair do PLANO
//  (`mapOfPlan`), o recorte continuou descontando uma vaga da régua
//  como se a fila tivesse sido consumida SEMPRE. Com `mapSource:
//  'keep'` nada é consumido — `next.image` é null —, e o OURO, que
//  a régua manda ver três mundos, via dois. A numeração seguia a
//  mesma suposição: o primeiro da fila aparecia como "#2".
//
//  A regra que as duas obedecem é uma só: a vaga sai, e a numeração
//  pula, quando o mundo anunciado SAIU DA FILA.
// ============================================================

describe('a régua quando o mundo do wipe não sai da fila', () => {
  /** Três procedurais prontos, cada um com a sua seed. */
  const ready = [
    mapEntry({ id: 1, position: 0, worldSize: 4000, seed: SECRET_SEED }),
    mapEntry({ id: 2, position: 1, worldSize: 3500, seed: '111' }),
    mapEntry({ id: 3, position: 2, worldSize: 3000, seed: '222' }),
  ];

  /**
   * Os mesmos três, custom e sem marca de versão.
   *
   * Num wipe FORÇADO o `next` da fila pula todos — o `.map` de
   * ontem não sobe na versão de amanhã —, e a decisão sai
   * `undecided` com a fila CHEIA. É o único jeito de ter o quarto
   * `mapSource` com mundos para listar atrás.
   */
  const customs = ready.map((entry, index) =>
    mapEntry({
      id: entry.id,
      position: index,
      kind: 'custom',
      seed: null,
      level: `Ilha ${String(index + 1)}`,
      worldSize: null,
      previewUrl: null,
    }),
  );

  function calendarFor(
    plans: readonly WipePlan[],
    queue: readonly MapPoolEntry[],
    tiers: readonly string[],
  ): PlayerCalendar {
    return buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      tiers,
      levels: LEVELS,
    });
  }

  /** As quatro origens de mundo, com fila para as quatro. */
  const SOURCES = [
    { name: 'pool', plans: [plan()], queue: ready },
    { name: 'keep', plans: [plan({ mapSource: 'keep' })], queue: ready },
    { name: 'fixed', plans: [plan({ mapSource: 'fixed', mapPoolId: 2 })], queue: ready },
    { name: 'undecided', plans: [plan({ kind: 'forced', bpPolicy: 'wipe' })], queue: customs },
  ] as const;

  it('a prata vê UM mundo e o ouro TRÊS, venha ele do plano ou da fila', () => {
    for (const source of SOURCES) {
      const seen = (tiers: readonly string[]): number => {
        const calendar = calendarFor(source.plans, source.queue, tiers);

        // Sem wipe à vista a conta daria zero por outro motivo, e o
        // teste não veria a diferença.
        expect(calendar.next).not.toBeNull();

        // O mundo do cartão conta como um: ele é `next.image`, e não
        // `maps[0]`.
        return (calendar.next?.image ? 1 : 0) + calendar.maps.length;
      };

      expect({ origem: source.name, prata: seen(['silver']), ouro: seen(['gold']) }).toEqual({
        origem: source.name,
        prata: 1,
        ouro: 3,
      });
    }
  });

  it('e a seed continua fora do pacote nas quatro origens', () => {
    for (const source of SOURCES) {
      const gold = calendarFor(source.plans, source.queue, ['gold']);

      // Com `keep` a cabeça da fila passou a ser LISTADA, e é ela
      // que carrega a `SECRET_SEED`: o mundo a mais que o ouro
      // ganhou não pode vir com a seed junto.
      expect(JSON.stringify(gold)).not.toContain(SECRET_SEED);

      for (const world of [gold.next?.image ?? null, ...gold.maps]) {
        expect(Object.keys(world ?? {})).not.toContain('seed');
      }
    }
  });

  it('com `keep`, a fila listada começa no #1 — nada dela foi consumido', () => {
    const calendar = calendarFor([plan({ mapSource: 'keep' })], ready, ['gold']);
    const card = cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');

    expect(card).toContain('#1 na fila · procedural 4000');
    expect(card).toContain('#2 na fila · procedural 3500');
    expect(card).toContain('#3 na fila · procedural 3000');
  });

  it('com o mundo saindo da fila, o cartão é o #1 e a lista começa no #2', () => {
    for (const source of [SOURCES[0], SOURCES[2]]) {
      const calendar = calendarFor(source.plans, source.queue, ['gold']);
      const card = cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');

      expect(card).not.toContain('#1 na fila');
      expect(card).toContain('#2 na fila');
      expect(card).toContain('#3 na fila');
    }
  });

  it('a numeração é a ORDEM DE CONSUMO, e não a `position` gravada', () => {
    // ####  É EM `fixed` QUE AS DUAS LEITURAS SE SEPARAM  ####
    //
    // O plano aponta a entrada da posição 1: ela sobe primeiro, e
    // a CABEÇA da fila (posição 0, procedural 4000) só sobe no
    // wipe seguinte. Ela é o "#2 na fila" porque é o segundo mundo
    // a entrar — numerar pela `position` prometeria ao VIP que o
    // próximo mundo é um que só vem depois.
    const calendar = calendarFor([plan({ mapSource: 'fixed', mapPoolId: 2 })], ready, ['gold']);
    const card = cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');

    // O cartão é a entrada apontada, que está na posição 1.
    expect(calendar.next?.map).toBe('procedural 3500');
    expect(card).toContain('#2 na fila · procedural 4000');
    expect(card).toContain('#3 na fila · procedural 3000');
  });

  it('com o mundo JÁ GRAVADO na execução, o cartão custa a vaga do nível', () => {
    // ####  A JANELA É CURTA, E O MUNDO A MAIS É REAL  ####
    //
    // Do `subir` até o fim do `pos-wipe` o mundo está em `map_after`,
    // com o servidor no ar e jogadores entrando. O cartão descreve
    // esse mundo POR EXTENSO — nome e tamanho —, e ele é um mundo do
    // futuro como qualquer entrada da fila. Sem descontar a vaga, a
    // PRATA lia o cartão PROCEDURAL 4000 mais "#1 na fila ·
    // procedural 3500": dois mundos num nível que compra um, e o
    // segundo é faixa do OURO.
    const consumed = [
      mapEntry({ id: 1, position: 0, worldSize: 4000, status: 'used', usedAt: NOW }),
      ready[1] as MapPoolEntry,
      ready[2] as MapPoolEntry,
    ];

    const runs = [
      run({
        mapAfter: {
          level: 'Procedural Map',
          seed: SECRET_SEED,
          worldSize: 4000,
          mapPoolId: 1,
          drawn: false,
        },
      }),
    ];

    const seenBy = (tiers: readonly string[]): PlayerCalendar =>
      buildPlayerCalendar({
        now: NOW,
        timeZone: 'UTC',
        next: decide({ runs, queue: consumed }),
        plans: [],
        queue: consumed,
        tiers,
        levels: LEVELS,
      });

    const silver = seenBy(['silver']);
    const card = cardTextOf(buildCalendarScreen({ calendar: silver }), 'cal-mapa');

    expect(silver.next?.map).toBe('procedural 4000');
    expect(silver.maps).toEqual([]);
    expect(card).toContain('PROCEDURAL 4000');
    expect(card).not.toContain('#1 na fila');
    expect(card).not.toContain('3500');
    expect(card).not.toContain(SECRET_SEED);

    // O ouro compra três: o do cartão e os dois que sobraram na fila.
    expect(seenBy(['gold']).maps.map((world) => world.worldSize)).toEqual([3500, 3000]);
  });

  it('a prata com `keep` vê o primeiro da fila, e só ele', () => {
    const calendar = calendarFor([plan({ mapSource: 'keep' })], ready, ['silver']);
    const card = cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');

    expect(calendar.maps.map((world) => world.worldSize)).toEqual([4000]);
    expect(card).toContain('#1 na fila · procedural 4000');
    expect(card).not.toContain('3500');
  });
});

// ============================================================
//  §1e  O RETÂNGULO SEM IMAGEM DIZ POR QUE NÃO HÁ IMAGEM
//
//  Ele tinha uma frase só — "a imagem deste mundo ainda não ficou
//  pronta" —, e ela só é verdade quando o mundo É uma entrada da
//  fila cujo desenho o RustMaps ainda não devolveu. Nos outros não
//  há prévia pendente nenhuma, e a frase punha o jogador para
//  esperar uma imagem que ninguém está desenhando.
// ============================================================

describe('o cartão do mundo sem imagem', () => {
  function cardFor(input: DecideInput, tiers: readonly string[] = ['silver']): string {
    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide(input),
      plans: input.plans ?? [],
      queue: input.queue ?? [],
      tiers,
      levels: LEVELS,
    });

    return cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');
  }

  it('com `keep`, diz que o mundo é o mesmo de agora', () => {
    const card = cardFor({ plans: [plan({ mapSource: 'keep' })], queue: [mapEntry()] });

    expect(card).toContain('o mundo do próximo wipe é o mesmo de agora');
    expect(card).not.toContain('ainda não ficou pronta');
  });

  it('com o mundo SORTEADO na hora, ou mantido, diz que ele não saiu da fila', () => {
    // ####  OS DOIS MUNDOS QUE NUNCA ESTIVERAM NA FILA  ####
    //
    // A seed que o agente SORTEOU porque a fila estava vazia
    // (`drawn`), e o `keep`, que o `#manterMundo` grava sem
    // `mapPoolId`. Desses dois não existe prévia em lugar nenhum, e
    // aí a frase é verdade. O caso NORMAL — a entrada da fila que
    // virou o mundo — é o teste de baixo.
    const worlds = [
      { level: 'Procedural Map', seed: SECRET_SEED, worldSize: 4500, mapPoolId: 9, drawn: true },
      {
        level: 'Procedural Map',
        seed: SECRET_SEED,
        worldSize: 4500,
        mapPoolId: null,
        drawn: false,
      },
    ];

    for (const mapAfter of worlds) {
      const card = cardFor({ runs: [run({ mapAfter })], queue: [mapEntry()] });

      expect(card).toContain('PROCEDURAL 4500');
      expect(card).toContain('não saiu da fila');
      expect(card).not.toContain('ainda não ficou pronta');
      // O mundo da execução também carrega seed, e ela também para
      // antes do desenho.
      expect(card).not.toContain(SECRET_SEED);
    }
  });

  it('com o mundo que SAIU da fila, mostra a prévia da entrada consumida', () => {
    // ####  A ENTRADA `used` NÃO PERDE A IMAGEM  ####
    //
    // O `configurar` grava em `map_after` o `mapPoolId` da entrada
    // que virou o mundo, e a linha continua no banco com a
    // `preview_url` que o RustMaps devolveu. "Este mundo não saiu da
    // fila" é falso aqui — ele saiu —, e a frase apagava, no dia do
    // wipe, a imagem que o VIP prata via na véspera.
    const card = cardFor({
      runs: [
        run({
          mapAfter: {
            level: 'Procedural Map',
            seed: SECRET_SEED,
            worldSize: 4000,
            mapPoolId: 7,
            drawn: false,
          },
        }),
      ],
      queue: [mapEntry({ id: 7, status: 'used', usedAt: NOW })],
    });

    expect(card).toContain('PROCEDURAL 4000');
    expect(card).toContain('https://files.rustmaps.com/img/287/b3c1f0a2/map.png');
    expect(card).not.toContain('não saiu da fila');
    // A prévia atravessa; a seed continua parando antes do desenho.
    expect(card).not.toContain(SECRET_SEED);
  });

  it('com a entrada consumida sem prévia, aí sim ela ainda não ficou pronta', () => {
    // Mesmo caso do de cima, com a linha `used` sem imagem: a prévia
    // é a que o RustMaps não devolveu, e não uma que não existe.
    const card = cardFor({
      runs: [
        run({
          mapAfter: {
            level: 'Procedural Map',
            seed: SECRET_SEED,
            worldSize: 4000,
            mapPoolId: 7,
            drawn: false,
          },
        }),
      ],
      queue: [mapEntry({ id: 7, status: 'used', usedAt: NOW, previewUrl: null, thumbUrl: null })],
    });

    expect(card).toContain('a imagem deste mundo ainda não ficou pronta');
    expect(card).not.toContain('não saiu da fila');
  });

  it('sem ninguém ter escolhido, diz que o mundo ainda não foi escolhido', () => {
    const card = cardFor({ plans: [plan()], queue: [] });

    expect(card).toContain('o mundo ainda não foi escolhido');
    expect(card).not.toContain('ainda não ficou pronta');
  });

  it('com a entrada da fila sem prévia, aí sim ela ainda não ficou pronta', () => {
    const card = cardFor({
      plans: [plan()],
      queue: [mapEntry({ previewUrl: null, thumbUrl: null })],
    });

    expect(card).toContain('a imagem deste mundo ainda não ficou pronta');
  });

  it('com a prévia anulada pela seed na URL, a frase continua sendo a do rastro', () => {
    const card = cardFor({
      plans: [plan()],
      queue: [mapEntry({ previewUrl: `https://rustmaps.com/map/4000_${SECRET_SEED}` })],
    });

    expect(card).toContain('a prévia foi escondida: o endereço dela carrega a seed');
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
    const screen = buildCalendarScreen({ calendar: calendarOf({ next: nextOf() }) });

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
        calendar: calendarOf({ next: nextOf({ scheduledAt: wipeAt, kind: 'forced' }) }),
      }),
    );

    const later = textOf(
      buildCalendarScreen({
        calendar: calendarOf({
          now: NOW + 30 * 60_000,
          next: nextOf({ scheduledAt: wipeAt, kind: 'forced' }),
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
    const plans = [plan()];
    const queue = [mapEntry(), mapEntry({ id: 2, seed: '777', worldSize: 3000 })];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ plans, queue }),
      plans,
      queue,
      tiers: ['gold'],
      levels: LEVELS,
    });

    const text = textOf(buildCalendarScreen({ calendar }));

    expect(text).toContain('PROCEDURAL 4000');
    expect(text).toContain('https://files.rustmaps.com/img/287/b3c1f0a2/map.png');
    expect(text).toContain('#2 na fila');
    expect(text).not.toContain(SECRET_SEED);
  });

  it('com a fila vazia, o cartão do mundo explica o sorteio na hora', () => {
    const screen = buildCalendarScreen({
      calendar: calendarOf({
        mapsAllowed: 1,
        tier: 'silver',
        next: nextOf({ map: 'sorteado na hora', mapFrom: 'undecided' }),
      }),
    });

    // De novo o cartão da direita, e não a tela toda: a linha `MAPA`
    // do cartão da esquerda faria esta asserção passar sozinha.
    const card = cardTextOf(screen, 'cal-mapa');

    expect(card).toContain('SORTEADO NA HORA');
    expect(card).toContain('o mundo ainda não foi escolhido');
  });

  it('sem wipe marcado, a coluna do mapa não promete mundo nenhum', () => {
    const text = textOf(
      buildCalendarScreen({ calendar: calendarOf({ mapsAllowed: 1, tier: 'silver' }) }),
    );

    expect(text).toContain('SEM MUNDO ESCOLHIDO');
    expect(text).toContain('Quando o próximo wipe for marcado');
  });

  it('sem wipe marcado, a fila que a ROTA devolve continua desenhada', () => {
    // ####  AS DUAS SUPERFÍCIES RESPONDEM A MESMA COISA  ####
    //
    // `buildPlayerCalendar` é literalmente o corpo do
    // `GET /wipe/upcoming/me`, e sem wipe à vista nada é consumido:
    // a régua inteira sobra para a fila. O desenho voltava ANTES de
    // listar, e o OURO lia três mundos na rota e nenhum no menu do
    // jogo — com o Docs\06-API prometendo que as duas dizem a mesma
    // coisa.
    const queue = [
      mapEntry({ id: 1, position: 0, worldSize: 4000 }),
      mapEntry({ id: 2, position: 1, seed: '111', worldSize: 3500 }),
      mapEntry({ id: 3, position: 2, seed: '222', worldSize: 3000 }),
    ];

    const calendar = buildPlayerCalendar({
      now: NOW,
      timeZone: 'UTC',
      next: decide({ queue }),
      plans: [],
      queue,
      tiers: ['gold'],
      levels: LEVELS,
    });

    const card = cardTextOf(buildCalendarScreen({ calendar }), 'cal-mapa');

    expect(calendar.next).toBeNull();
    expect(calendar.maps).toHaveLength(3);

    expect(card).toContain('SEM MUNDO ESCOLHIDO');
    expect(card).toContain('#1 na fila · procedural 4000');
    expect(card).toContain('#2 na fila · procedural 3500');
    expect(card).toContain('#3 na fila · procedural 3000');
    // E a régua não afrouxa por não haver wipe: a seed continua fora.
    expect(card).not.toContain(SECRET_SEED);
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
  readonly runs: WipeRunsRepository;
  /** Para o teste que troca a origem do mapa do plano já agendado. */
  readonly schedule: WipeScheduleRepository;
  readonly planId: number;
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
  const runs = new WipeRunsRepository(db);

  const scheduled = schedule.createPlan(
    SERVER,
    { scheduledAt: NOW + 6 * DAY + 4 * HOUR, bpPolicy: 'keep' },
    NOW,
  );

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
      runs,
      mapPool,
      vips,
      now: () => NOW,
    }),
  });

  harness = { db, server, sync, vips, runs, schedule, planId: scheduled.id };
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

  it('com `keep`, o OURO ganha o mundo a mais — e nenhuma seed junto', async () => {
    // ####  O CAMINHO INTEIRO, E NÃO SÓ O RECORTE  ####
    //
    // Com o plano `keep` nada é consumido da fila, e a régua do ouro
    // passa a caber inteira nela: a CABEÇA — a entrada que carrega a
    // `SECRET_SEED` — vira a #1 da lista. É o mundo que o conserto
    // devolveu ao ouro, e é justamente o que precisa ser conferido
    // no comando enviado: o recorte continua acontecendo ANTES do
    // documento, e a seed não atravessa nem assim.
    harness.schedule.updatePlan(SERVER, harness.planId, { mapSource: 'keep' }, NOW);

    harness.vips.grant(
      { steamId: PLAYER, tier: 'gold', expiresAt: null, origin: 'painel', createdBy: 'teste' },
      NOW,
    );

    const json = await askCalendar(PLAYER);

    expect(json).toContain('o mesmo mapa de agora');
    expect(json).toContain('#1 na fila');
    expect(json).toContain('#2 na fila');
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
//  §3b  ELA NUNCA CAI NO RETÂNGULO DO PRESET
// ============================================================

describe('quando o provedor não consegue montar a página', () => {
  const document = buildMainMenu();

  it('a tela de emergência é VOLÁTIL, e por isso some no clique seguinte', () => {
    const bundle = buildEmptyCalendarBundle(document, CALENDAR_SCREEN_ID, NOW);

    // A do documento ("Wipes e eventos programados entram aqui") NÃO
    // é volátil: o plugin a guarda no cache e o servidor inteiro
    // fica com o retângulo antigo por até cinco minutos.
    expect(bundle.volatile).toBe(true);
    expect(bundle.id).toBe(CALENDAR_SCREEN_ID);
  });

  it('o banco fora do ar não derruba o pedido — ele vira a tela vazia', async () => {
    const explode = (): never => {
      throw new Error('o banco não respondeu');
    };

    const provider = createCalendarScreenProvider({
      schedule: {
        getSettings: explode,
        listPlans: explode,
        getPlan: explode,
        nextPlan: explode,
      },
      runs: { running: explode },
      mapPool: { list: explode, next: explode, get: explode },
      vips: { activeOf: () => [] },
      now: () => NOW,
    });

    const bundle = await provider({
      serverId: SERVER,
      document,
      screenId: CALENDAR_SCREEN_ID,
      steamId: undefined,
    });

    // Não lança, e não devolve `null`: um `null` faria o `UiSync`
    // servir a tela DESENHADA, que fica em cache.
    expect(bundle?.volatile).toBe(true);
    expect(JSON.stringify(bundle)).toContain('SEM WIPE AGENDADO');
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
    const runs = new WipeRunsRepository(db);

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
          runs,
        });

        return Promise.resolve();
      },
      { prefix: '/api' },
    );

    return { app, db, vips, runs };
  }

  it('sem steamId, devolve a agenda e nenhum mapa', async () => {
    const { app, db } = buildApi();
    await app.ready();

    const response = await app.inject(`/api/servers/${SERVER}/wipe/upcoming/me`);
    const body = response.json() as {
      readonly mapsAllowed: number;
      readonly maps: readonly unknown[];
      readonly next: { readonly map: string | null } | null;
      readonly wipes: readonly unknown[];
    };

    expect(response.statusCode).toBe(200);
    // O único wipe da agenda É o próximo: ele vai no cartão, e a
    // lista "DEPOIS" não o repete.
    expect(body.next).not.toBeNull();
    expect(body.wipes).toEqual([]);
    expect(body.mapsAllowed).toBe(0);
    expect(body.maps).toEqual([]);
    // Sem VIP, nem a FRASE do mundo atravessa.
    expect(body.next?.map).toBeNull();
    expect(response.body).not.toContain(SECRET_SEED);

    await app.close();
    db.close();
  });

  it('conta a execução em curso, e não o plano da semana que vem', async () => {
    // A rota do jogador e o `{wipe.faltam}` do chat respondem a
    // MESMA pergunta: se ela lesse só `wipe_plans`, o "WIPAR AGORA
    // com hora marcada" — que não tem plano — sumiria dela.
    const { app, db, runs } = buildApi();
    await app.ready();

    const started = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      wipeAt: Date.now() + 2 * HOUR,
    });

    const response = await app.inject(`/api/servers/${SERVER}/wipe/upcoming/me`);
    const body = response.json() as {
      readonly next: { readonly scheduledAt: number; readonly running: boolean } | null;
    };

    expect(body.next?.scheduledAt).toBe(started.wipeAt);
    expect(body.next?.running).toBe(true);

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
      readonly next: { readonly map: string | null; readonly image: { worldSize: number } | null };
      readonly maps: readonly { readonly worldSize: number }[];
    };

    expect(body.tier).toBe('silver');
    expect(body.mapsAllowed).toBe(1);
    // O mundo do PRÓXIMO wipe é o #1 da régua, e ele vem do PLANO —
    // não da cabeça da fila. A prata para aqui: `maps` é o que vem
    // ATRÁS dele, e é do ouro.
    expect(body.next.image?.worldSize).toBe(4000);
    expect(body.next.map).toBe('procedural 4000');
    expect(body.maps).toEqual([]);
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
