// ============================================================
//  ui-calendar-screen.ts  -  a página CALENDÁRIO, montada da
//  agenda do wipe.
//
//  ####  POR QUE ESTA TELA NÃO É DESENHADA NO EDITOR  ####
//
//  Até aqui ela era um retângulo dizendo "Wipes e eventos
//  programados entram aqui". O que ela precisa mostrar — a data do
//  próximo wipe e QUANTO FALTA para ele — muda a cada minuto e vem
//  do banco, não do desenho de ninguém. É o mesmo caso da página
//  de KITS, e o padrão é o dela, linha por linha: o documento
//  guarda só o ENDEREÇO (`tela-calendario`) e o agente monta o
//  conteúdo na hora do clique.
//
//  ####  ELA NUNCA É GUARDADA EM CACHE  ####
//
//  `volatile: true` no pacote — quem o marca é o
//  `toGeneratedScreenBundle`. A tela diz "faltam 6 dias e 4
//  horas"; em cache ela mostraria as mesmas seis horas para
//  sempre, e o jogador decidiria se sobe a base hoje confiando
//  naquilo.
//
//  ------------------------------------------------------------
//  ####  O RECORTE POR NÍVEL ACONTECE ANTES DO DESENHO  ####
//
//  É a regra que manda neste arquivo, e é por ela que existem DUAS
//  funções em vez de uma:
//
//    buildPlayerCalendar()   corta pelo nível de VIP e devolve só
//                            o que AQUELE jogador pode ver;
//    buildCalendarScreen()   desenha o que recebeu, e nada além.
//
//  Recortar só na hora de desenhar deixaria a seed do próximo mapa
//  viajar na payload do RCON — escondida atrás de um widget que
//  ninguém desenhou, mas presente no JSON que o cliente recebe. O
//  que o jogador não pode ver NÃO ATRAVESSA O RCON.
//
//  E a seed não atravessa para ninguém: `CalendarMapView` não tem
//  campo para ela. Mostrar a IMAGEM é uma chave; mostrar a SEED é
//  outra, e ela não é desta frente (Docs\16 §9.3) — com a seed o
//  jogador abre o RustMaps e estuda cada monumento dias antes.
//
//  ------------------------------------------------------------
//  ####  A RÉGUA DO VIP, E POR QUE ELA VEM DE GRAÇA  ####
//
//    sem VIP / bronze   a data e a política de blueprint
//    silver             + o mapa #1 (tamanho e imagem)
//    gold               + os mapas #2 e #3
//
//  O dado já existe: a fila de mapas é do admin e o RustMaps já
//  preencheu as imagens. "VIP vê o futuro" é produto que não custa
//  uma tabela nova.
//
//  ------------------------------------------------------------
//  ####  AS FRASES SÃO AS MESMAS DO CHAT  ####
//
//  `formatWipeCountdown`, `formatWipeMoment`, `describeBpPolicy` e
//  `describeMapEntry` vêm de messages/providers/wipe.ts, que é
//  quem responde `{wipe.faltam}`. Uma segunda conta aqui daria
//  duas respostas para "quando é o próximo wipe", e a divergência
//  apareceria justamente no dia do wipe — o chat dizendo uma coisa
//  e o menu outra.
//
//  Os construtores de tela vêm de ui-widgets.ts, compartilhados
//  com a loja e os kits: duas cópias divergem no primeiro ajuste.
// ============================================================

import type { WipeScheduleReader } from '../db/wipe-schedule-repository.js';
import {
  describeBpPolicy,
  describeMapEntry,
  formatWipeCountdown,
  formatWipeMoment,
  MAP_DRAWN_ON_THE_SPOT,
  NO_WIPE_SCHEDULED,
} from '../messages/providers/wipe.js';
import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import type { BpPolicy, MapKind, MapPoolEntry, WipePlan, WipePlanKind } from '../types/wipe.js';
import type { VipTierLevel } from '../vip/tiers.js';

import {
  C,
  fill,
  itemRows,
  label,
  panel,
  topBar,
  urlImage,
  type ContentRow,
  type Rect,
} from './ui-widgets.js';

/**
 * O id da tela no documento.
 *
 * FIXO, e não sorteado: é por ele que o agente reconhece a tela
 * cujo conteúdo ele mesmo monta. Precisa bater com o preset — a
 * nav `calendario` de game/ui-preset-main-menu.ts já navega para
 * cá.
 */
export const CALENDAR_SCREEN_ID = 'tela-calendario';

/**
 * O pedido é DESTA tela?
 *
 * Id exato, sem família de endereços: o calendário não tem
 * categoria, página nem modal — ele é uma leitura só. Quem
 * reconhece um prefixo é a loja (`tela-loja:vip:2`), e é por isso
 * que ela é perguntada antes.
 */
export function isCalendarScreenId(screenId: string): boolean {
  return screenId === CALENDAR_SCREEN_ID;
}

// ============================================================
//  §1  O RECORTE — o que aquele jogador pode ver
// ============================================================

/**
 * A régua, do nível mais alto para o mais baixo.
 *
 * Lida NESTA ordem: quem tem `gold` para no primeiro degrau.
 * Acrescentar um nível é acrescentar uma linha.
 */
export const CALENDAR_TIER_RULER = [
  { tier: 'gold', maps: 3 },
  { tier: 'silver', maps: 1 },
] as const;

/** Quantos wipes futuros a tela lista. */
export const CALENDAR_WIPE_LIMIT = 5;

/** Um wipe da agenda, como o jogador o vê. */
export interface CalendarWipeView {
  /** Epoch ms UTC. */
  readonly scheduledAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  /**
   * Ele foi cancelado por um wipe forçado que cai perto.
   *
   * Continua na lista, marcado: uma agenda com um buraco não
   * explica por que terça não vai ter wipe.
   */
  readonly absorbed: boolean;
}

/**
 * Um mundo da fila, como o jogador o vê.
 *
 * ####  NÃO HÁ CAMPO PARA A SEED, E ISSO É O RECURSO  ####
 *
 * Não é esquecimento nem economia de bytes: é o tipo que impede a
 * seed de chegar ao desenho por acidente. Quem quiser mostrá-la um
 * dia vai precisar mexer AQUI, que é onde o comentário está.
 */
export interface CalendarMapView {
  readonly kind: MapKind;
  /** O nome do mundo, quando ele não é procedural. */
  readonly level: string | null;
  readonly worldSize: number | null;
  /** A imagem grande. `null` = ainda não veio do RustMaps. */
  readonly previewUrl: string | null;
  readonly thumbUrl: string | null;
}

/** Tudo o que a tela daquele jogador pode desenhar. E nada além. */
export interface PlayerCalendar {
  /** O relógio do AGENTE, que é de onde a contagem sai. */
  readonly now: number;
  /** A zona IANA em que as datas são escritas. */
  readonly timeZone: string;
  /** O nível que mandou no recorte. `null` = sem VIP. */
  readonly tier: string | null;
  /** Quantos mundos da fila este nível enxerga: 0, 1 ou 3. */
  readonly mapsAllowed: number;
  /** O que vem por aí, do mais próximo para o mais distante. */
  readonly wipes: readonly CalendarWipeView[];
  /** Os mundos que ele PODE ver, na ordem da fila. Sem seed. */
  readonly maps: readonly CalendarMapView[];
}

export interface PlayerCalendarInput {
  readonly now: number;
  readonly timeZone: string;
  /** A agenda já lida do banco, em ordem. */
  readonly plans: readonly WipePlan[];
  /** A fila de mapas daquele servidor, em ordem. */
  readonly queue: readonly MapPoolEntry[];
  /** Os níveis que o jogador tem AGORA. Vazio = sem VIP. */
  readonly tiers: readonly string[];
  /**
   * Os níveis daquele servidor, para saber que `gold` vale mais
   * que `silver`. Vazio = config não lido, e aí a comparação vira
   * igualdade pura de nome — é o que se pode afirmar sem inventar
   * hierarquia. A mesma decisão do `#hasTier` dos kits.
   */
  readonly levels: readonly VipTierLevel[];
  readonly limit?: number;
}

/**
 * Quantos mundos aquele jogador enxerga, e por qual nível.
 *
 * A ordem entre níveis sai do `Rank` do `OrigemZVip.json` daquele
 * servidor — a mesma tabela que o plugin usa no `HasVipTier`, e a
 * mesma que os kits leem. Sem ela, só a igualdade de nome vale.
 */
export function mapAllowanceOf(
  tiers: readonly string[],
  levels: readonly VipTierLevel[],
): { readonly maps: number; readonly tier: string | null } {
  const owned = tiers.map((tier) => tier.trim().toLowerCase()).filter((tier) => tier !== '');
  const rankOf = new Map(levels.map((level, index) => [level.tier, level.rank ?? index]));

  const hasAtLeast = (wanted: string): boolean => {
    if (owned.includes(wanted)) {
      return true;
    }

    const needed = rankOf.get(wanted);

    if (needed === undefined) {
      return false;
    }

    return owned.some((tier) => (rankOf.get(tier) ?? Number.NEGATIVE_INFINITY) >= needed);
  };

  for (const step of CALENDAR_TIER_RULER) {
    if (hasAtLeast(step.tier)) {
      return { maps: step.maps, tier: step.tier };
    }
  }

  // Sem direito a mapa nenhum. O nível continua sendo dito: quem
  // tem bronze precisa ler "o seu VIP não alcança", e não "você
  // não tem VIP".
  return { maps: 0, tier: owned[0] ?? null };
}

/**
 * A agenda e a fila, RECORTADAS para quem está olhando.
 *
 * É aqui que o VIP vira ou não vira informação. Depois disto, o
 * desenho não tem como vazar o que não recebeu.
 */
export function buildPlayerCalendar(input: PlayerCalendarInput): PlayerCalendar {
  const allowance = mapAllowanceOf(input.tiers, input.levels);

  const wipes = input.plans
    .filter((plan) => plan.scheduledAt >= input.now)
    // `planned` e `absorbed`, como o `/wipe/upcoming` do painel:
    // `done`, `skipped` e `failed` estão na tabela para explicar um
    // dia sem wipe, e não para serem prometidos a ninguém.
    .filter((plan) => plan.status === 'planned' || plan.status === 'absorbed')
    .slice(0, input.limit ?? CALENDAR_WIPE_LIMIT)
    .map(
      (plan): CalendarWipeView => ({
        scheduledAt: plan.scheduledAt,
        kind: plan.kind,
        bpPolicy: plan.bpPolicy,
        absorbed: plan.status === 'absorbed',
      }),
    );

  // Só os mundos PRONTOS: prometer um mapa que o RustMaps ainda
  // está desenhando é prometer o que pode não entrar.
  const ready = input.queue.filter((entry) => entry.status === 'ready');

  return {
    now: input.now,
    timeZone: input.timeZone,
    tier: allowance.tier,
    mapsAllowed: allowance.maps,
    wipes,
    maps: ready.slice(0, allowance.maps).map(toMapView),
  };
}

/**
 * Uma entrada da fila vira o que pode ser visto.
 *
 * ####  A URL QUE CARREGA A SEED É DESCARTADA  ####
 *
 * O RustMaps devolve a imagem num endereço com UUID
 * (`.../img/287/b3c1f0a2/map.png`), e é ele que fica gravado. Mas
 * a coluna aceita qualquer texto, e a PÁGINA do mapa lá tem a
 * forma `rustmaps.com/map/4000_18422` — com a seed dentro. Se uma
 * dessas cair aqui, a imagem some e o resto continua: a prévia é
 * enfeite, e a seed não é.
 */
function toMapView(entry: MapPoolEntry): CalendarMapView {
  const withoutSeed = (url: string | null): string | null =>
    url === null || (entry.seed !== null && entry.seed !== '' && url.includes(entry.seed))
      ? null
      : url;

  return {
    kind: entry.kind,
    level: entry.level,
    worldSize: entry.worldSize,
    previewUrl: withoutSeed(entry.previewUrl),
    thumbUrl: withoutSeed(entry.thumbUrl),
  };
}

// ============================================================
//  §2  O DESENHO
// ============================================================

/** As colunas: a agenda à esquerda, o mundo que vem à direita. */
const COLUMN = {
  leftMin: 0,
  leftMax: 0.56,
  rightMin: 0.58,
  rightMax: 1,
} as const;

/** O que fica onde, medido do topo do slot de conteúdo. */
const Y = {
  title: 30,
  section: 42,
  sectionHeight: 18,
  nextCard: 66,
  nextCardHeight: 168,
  laterSection: 246,
  laterCard: 270,
  laterCardHeight: 148,
} as const;

/** A margem de dentro dos cartões. */
const PAD = 16;

/** O lado da imagem do mapa. */
const MAP_IMAGE = 180;

/** A altura do cartão da direita: ele acompanha os dois da esquerda. */
const MAP_CARD_HEIGHT = Y.laterCard + Y.laterCardHeight - Y.nextCard;

/** O que cada origem de wipe é, em uma palavra. */
const KIND_WORDS: Readonly<Record<WipePlanKind, string>> = {
  cadence: 'cadência',
  forced: 'FORÇADO',
  manual: 'marcado à mão',
};

export interface BuildCalendarScreenOptions {
  readonly calendar: PlayerCalendar;
  /**
   * O id EXATO que foi pedido.
   *
   * Volta idêntico porque o plugin descarta a resposta cujo id não
   * bate com o que ele pediu. Ver ui-store-screens.ts.
   */
  readonly screenId?: string;
}

export function buildCalendarScreen(options: BuildCalendarScreenOptions): UiScreen {
  const { calendar } = options;

  const elements: UiElement[] = [
    label('cal-titulo', 'CALENDÁRIO', topBar(Y.title), {
      size: 20,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),

    ...section('cal-s1', 'PRÓXIMO WIPE', COLUMN.leftMin, COLUMN.leftMax, Y.section),
    panel(
      'cal-prox',
      block(COLUMN.leftMin, COLUMN.leftMax, Y.nextCard, Y.nextCardHeight),
      C.surface,
      nextWipeBody(calendar),
    ),

    ...section('cal-s2', 'DEPOIS', COLUMN.leftMin, COLUMN.leftMax, Y.laterSection),
    panel(
      'cal-depois',
      block(COLUMN.leftMin, COLUMN.leftMax, Y.laterCard, Y.laterCardHeight),
      C.surface,
      laterBody(calendar),
    ),

    ...section('cal-s3', 'O MAPA DO PRÓXIMO WIPE', COLUMN.rightMin, COLUMN.rightMax, Y.section),
    panel(
      'cal-mapa',
      block(COLUMN.rightMin, COLUMN.rightMax, Y.nextCard, MAP_CARD_HEIGHT),
      C.surface,
      mapBody(calendar),
    ),
  ];

  return {
    id: options.screenId ?? CALENDAR_SCREEN_ID,
    name: 'CALENDÁRIO',
    kind: 'page',
    elements,
  };
}

/**
 * O título de uma seção: a barra de acento e a palavra.
 *
 * O mesmo "▌ TÍTULO" do painel — é o que amarra a tela do jogo à
 * do navegador sem uma folha de estilo compartilhada.
 */
function section(
  id: string,
  text: string,
  minX: number,
  maxX: number,
  top: number,
): readonly UiElement[] {
  const bar: Rect = {
    anchorMin: { x: minX, y: 1 },
    anchorMax: { x: minX, y: 1 },
    offsetMin: { x: 0, y: -(top + Y.sectionHeight) },
    offsetMax: { x: 3, y: -top },
  };

  return [
    panel(`${id}b`, bar, C.rust),
    label(`${id}t`, text, block(minX, maxX, top, Y.sectionHeight, 10), {
      size: 12,
      align: 'MiddleLeft',
      color: C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];
}

/** Um bloco de altura fixa, ancorado no topo, entre duas colunas. */
function block(minX: number, maxX: number, top: number, height: number, left = 0): Rect {
  return {
    anchorMin: { x: minX, y: 1 },
    anchorMax: { x: maxX, y: 1 },
    offsetMin: { x: left, y: -(top + height) },
    offsetMax: { x: 0, y: -top },
  };
}

/** Uma linha de texto dentro de um cartão, medida do topo dele. */
function line(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: PAD, y: -(top + height) },
    offsetMax: { x: -PAD, y: -top },
  };
}

/**
 * O cartão do próximo wipe.
 *
 * ####  SEM AGENDA, ELE DIZ A FRASE — E NÃO ABRE VAZIO  ####
 *
 * "sem wipe agendado" é a mesma resposta que `{wipe.faltam}` dá no
 * chat (messages/providers/wipe.ts). Um cartão em branco faria o
 * jogador achar que a tela quebrou.
 */
function nextWipeBody(calendar: PlayerCalendar): readonly UiElement[] {
  const next = calendar.wipes[0];

  if (next === undefined) {
    return [
      label('cal-prox-t', NO_WIPE_SCHEDULED.toUpperCase(), line(PAD, 28), {
        size: 17,
        align: 'MiddleLeft',
        color: C.textMuted,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'cal-prox-x',
        'Ninguém marcou o próximo wipe deste servidor. Quando marcarem, a data aparece aqui.',
        line(PAD + 30, 22),
        { size: 12, align: 'MiddleLeft', color: C.textMuted },
      ),
    ];
  }

  const rows: ContentRow[] = [];

  // ####  O MAPA SÓ ENTRA PARA QUEM TEM DIREITO  ####
  //
  // E ele já chegou aqui recortado: `calendar.maps` está vazio para
  // quem não alcança a régua. Não há `if` de desenho escondendo
  // dado que veio junto na payload.
  const map = calendar.maps[0];

  if (map !== undefined) {
    rows.push({ text: `MAPA          ${describeMapEntry(map)}`, item: null });
  }

  rows.push({ text: `BLUEPRINTS    ${describeBpPolicy(next.bpPolicy)}`, item: null });
  rows.push({ text: `WIPE          ${KIND_WORDS[next.kind]}`, item: null });

  return [
    label(
      'cal-prox-t',
      formatWipeMoment(next.scheduledAt, calendar.timeZone).toUpperCase(),
      line(PAD, 28),
      { size: 17, align: 'MiddleLeft', font: 'RobotoCondensed-Bold.ttf' },
    ),

    label(
      'cal-prox-c',
      `faltam ${formatWipeCountdown(next.scheduledAt - calendar.now)}`,
      line(PAD + 30, 22),
      { size: 14, align: 'MiddleLeft', color: C.amber, font: 'RobotoCondensed-Bold.ttf' },
    ),

    panel(
      'cal-prox-l',
      fill(PAD, PAD + 60, PAD, PAD),
      C.none,
      itemRows(rows, Y.nextCardHeight - (PAD + 60) - PAD, 'calp'),
    ),
  ];
}

/** A lista do que vem depois do próximo. */
function laterBody(calendar: PlayerCalendar): readonly UiElement[] {
  const rest = calendar.wipes.slice(1);

  const rows: ContentRow[] =
    rest.length === 0
      ? [{ text: 'Depois deste, nada marcado ainda.', item: null }]
      : rest.map((wipe) => ({
          text:
            `${formatWipeMoment(wipe.scheduledAt, calendar.timeZone)} · ` +
            `${KIND_WORDS[wipe.kind]} · BP ${describeBpPolicy(wipe.bpPolicy)}` +
            // O absorvido fica, marcado: se ele sumisse, ninguém
            // entenderia a semana sem wipe.
            (wipe.absorbed ? ' · cancelado pelo forçado' : ''),
          item: null,
        }));

  return [
    panel(
      'cal-depois-l',
      fill(PAD, PAD, PAD, PAD),
      C.none,
      itemRows(rows, Y.laterCardHeight - PAD * 2, 'call'),
    ),
  ];
}

/**
 * O cartão do mundo que vem — ou o cadeado.
 *
 * ####  O CADEADO É UMA OFERTA, E NÃO UM ERRO  ####
 *
 * Quem não tem o nível lê o que ganharia com ele. Esconder a seção
 * inteira faria a vantagem de VIP não existir para quem ainda não
 * comprou — que é exatamente quem precisa vê-la.
 */
function mapBody(calendar: PlayerCalendar): readonly UiElement[] {
  if (calendar.mapsAllowed === 0) {
    return [
      label('cal-mapa-t', 'VIP PRATA VÊ O MAPA DO PRÓXIMO WIPE', line(PAD, 26), {
        size: 15,
        align: 'MiddleLeft',
        color: C.amber,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      panel(
        'cal-mapa-l',
        fill(PAD, PAD + 34, PAD, PAD),
        C.none,
        itemRows(
          [
            { text: 'PRATA: o tamanho e a imagem do mundo do próximo wipe', item: null },
            { text: 'OURO: os três próximos mundos, na ordem da fila', item: null },
            { text: 'A seed continua sendo segredo até o wipe, para todo mundo', item: null },
          ],
          MAP_CARD_HEIGHT - (PAD + 34) - PAD,
          'calm',
        ),
      ),
    ];
  }

  const first = calendar.maps[0];

  if (first === undefined) {
    return [
      label('cal-mapa-t', 'A FILA DE MAPAS ESTÁ VAZIA', line(PAD, 26), {
        size: 15,
        align: 'MiddleLeft',
        color: C.textMuted,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'cal-mapa-x',
        `O mundo do próximo wipe é ${MAP_DRAWN_ON_THE_SPOT}.`,
        line(PAD + 30, 22),
        { size: 12, align: 'MiddleLeft', color: C.textMuted },
      ),
    ];
  }

  const image = first.previewUrl ?? first.thumbUrl;

  const imageRect: Rect = {
    anchorMin: { x: 0.5, y: 1 },
    anchorMax: { x: 0.5, y: 1 },
    offsetMin: { x: -MAP_IMAGE / 2, y: -(PAD + MAP_IMAGE) },
    offsetMax: { x: MAP_IMAGE / 2, y: -PAD },
  };

  const elements: UiElement[] = [
    // Sem imagem ainda, um retângulo vazio é honesto: ele não finge
    // ser um mundo que ninguém desenhou. A mesma escolha do card de
    // kit sem catálogo lido.
    isDrawableUrl(image)
      ? urlImage('cal-mapa-i', image, imageRect)
      : panel('cal-mapa-i', imageRect, C.surface2, [
          label('cal-mapa-in', 'a imagem deste mundo ainda não ficou pronta', fill(8, 8, 8, 8), {
            size: 11,
            color: C.textMuted,
          }),
        ]),

    label('cal-mapa-t', describeMapEntry(first).toUpperCase(), line(PAD + MAP_IMAGE + 10, 24), {
      size: 15,
      align: 'MiddleCenter',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];

  // O OURO vê a fila; a PRATA vê só o próximo. A lista aparece
  // quando há o que listar, e não como um retângulo vazio.
  const rest = calendar.maps.slice(1);

  if (rest.length > 0) {
    const top = PAD + MAP_IMAGE + 40;

    elements.push(
      panel(
        'cal-mapa-l',
        fill(PAD, top, PAD, PAD),
        C.none,
        itemRows(
          rest.map((entry, index) => ({
            text: `#${String(index + 2)} na fila · ${describeMapEntry(entry)}`,
            item: null,
          })),
          MAP_CARD_HEIGHT - top - PAD,
          'calq',
        ),
      ),
    );
  }

  return elements;
}

/**
 * Só `http(s)` vira imagem.
 *
 * O CUI manda a URL para o CLIENTE baixar; qualquer outra coisa ali
 * é um pedido que nunca resolve, e o jogador fica olhando um
 * quadrado vazio sem explicação nenhuma.
 */
function isDrawableUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

// ============================================================
//  §3  A LIGAÇÃO COM O RESTO DO AGENTE
// ============================================================

/** A fila de mapas, só de leitura. O recorte de `MapPoolRepository`. */
export interface CalendarMapQueueReader {
  list(serverId: string): readonly MapPoolEntry[];
}

/** Quem tem VIP agora. O recorte de `VipsRepository` e do `VipList`. */
export interface CalendarVipReader {
  activeOf(steamId: string, now?: number): readonly { readonly tier: string }[];
}

export interface CalendarScreenProviderOptions {
  readonly schedule: WipeScheduleReader;
  readonly mapPool: CalendarMapQueueReader;
  readonly vips: CalendarVipReader;
  /**
   * Os níveis daquele servidor (o `OrigemZVip.json`).
   *
   * Ausente = sem hierarquia conhecida, e a comparação vira
   * igualdade de nome. A tela continua de pé: o pior que acontece é
   * um nível ainda não declarado no config não desbloquear o mapa.
   */
  readonly levelsOf?: (serverId: string) => Promise<readonly VipTierLevel[]>;
  /** O relógio, injetável para o teste. */
  readonly now?: () => number;
}

/**
 * A forma que o `generatedScreens` do `UiSync` espera.
 *
 * Nomeada porque o index.ts guarda uma destas numa variável que
 * nasce vazia: a tela depende da agenda e da fila de mapas, que são
 * construídas depois do `UiSync`.
 */
export type CalendarScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

/**
 * A tela do calendário, montada para quem pediu.
 *
 * Devolve `null` para tudo o que não é dela — é assim que o
 * `generatedScreens` do index.ts encadeia loja, kits e calendário
 * sem que nenhum deles saiba dos outros.
 */
export function createCalendarScreenProvider(
  options: CalendarScreenProviderOptions,
): CalendarScreenProvider {
  return async (input) => {
    if (!isCalendarScreenId(input.screenId)) {
      return null;
    }

    const now = (options.now ?? Date.now)();
    const settings = options.schedule.getSettings(input.serverId);

    // ####  O NÍVEL VEM DA CONEXÃO, NUNCA DO CLIQUE  ####
    //
    // O `steamId` chega do plugin junto do pedido, tirado de quem
    // está com o menu aberto. Sem ele — plugin antigo, ou a carga
    // inicial que vai ao servidor sem jogador nenhum —, a resposta
    // é a de quem não tem VIP: negar por falta de identidade é a
    // saída conservadora.
    const tiers =
      input.steamId === undefined
        ? []
        : options.vips.activeOf(input.steamId, now).map((vip) => vip.tier);

    // Sem VIP nenhum não há hierarquia a consultar, e ler o config
    // do plugin seria ir ao disco para confirmar um zero.
    const levels = tiers.length === 0 ? [] : ((await options.levelsOf?.(input.serverId)) ?? []);

    const calendar = buildPlayerCalendar({
      now,
      timeZone: settings.cadence.timeZone,
      plans: options.schedule.listPlans(input.serverId, { from: now }),
      queue: options.mapPool.list(input.serverId),
      tiers,
      levels,
    });

    return toGeneratedScreenBundle(
      input.document,
      buildCalendarScreen({ calendar, screenId: input.screenId }),
      // O SHELL conhece `tela-calendario`: sem isto, o destaque do
      // botão CALENDÁRIO sumiria justamente ao entrar nele.
      CALENDAR_SCREEN_ID,
    );
  };
}
