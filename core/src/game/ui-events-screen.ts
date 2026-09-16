// ============================================================
//  ui-events-screen.ts  -  a aba EVENTOS do menu.
//
//  Pedido do dono em 15/09/2026: "No '/menu' vamos ter a aba
//  eventos, vai mostrar todos os eventos e vai mostrar o koth e
//  nisso vamos conseguir ver a equipe que está participando... temos
//  que fazer com sidebar do lado para separar melhor, exemplo por
//  ter vários koth acontecendo ao mesmo tempo".
//
//  E depois: "tipo pode ter vários koth ativo no momento, aí na
//  sidebar aperta em Koth, aí do lado do conteúdo tem paginação.
//  Cada koth tem o card e ao apertar para mais informação abre o
//  modal com mais detalhes".
//
//  ------------------------------------------------------------
//  ####  ELA MOSTRA O QUE ESTÁ ACONTECENDO AGORA  ####
//
//  Não é a agenda (isso é o CALENDÁRIO) nem o histórico. É a
//  pergunta que o jogador faz quando abre o menu no meio da noite:
//  "tem alguma coisa rolando, e vale a pena ir?".
//
//  Por isso o card leva o que muda a decisão de ir: onde é, quanto
//  já foi conquistado, quem está segurando, quantos estão lá e
//  quanto tempo ainda dá.
//
//  ------------------------------------------------------------
//  ####  A VAGA VAZIA MOSTRA O ÚLTIMO RESULTADO  ####
//
//  Regra do dono: "ao finalizar o evento fica ali até outro iniciar
//  (tipo para mostrar um histórico de quem levou)".
//
//  Então a lista não é "os eventos de pé": é AS VAGAS. Uma vaga
//  ocupada mostra a disputa; uma vaga livre mostra quem levou o
//  último que aconteceu ali. Quando um novo nasce, ele empurra o
//  encerrado mais velho para fora — que é exatamente "fica até
//  outro iniciar".
//
//  ------------------------------------------------------------
//  ####  ELA É GERADA, E NUNCA VAI PARA O CACHE  ####
//
//  Uma barra de captura guardada por cinco minutos é pior que
//  nenhuma: ela manda o jogador correr para um território que já
//  acabou. O pacote sai `volatile`, como o da loja e o da equipe.
//
//  ------------------------------------------------------------
//  ####  "NÃO CONSEGUI PERGUNTAR" NÃO É "NÃO TEM NADA"  ####
//
//  O estado vivo vem do plugin por RCON. Com o servidor sem
//  resposta, dizer "nenhum evento acontecendo" seria mentir com
//  cara de dado — e o jogador fecharia o menu achando que a noite
//  está parada. A tela diz que não conseguiu perguntar.
// ============================================================

import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';

import {
  C,
  button,
  fill,
  label,
  modalFrame,
  panel,
  rowsPager,
  titleBar,
  type Rect,
} from './ui-widgets.js';

/** O endereço desta tela no documento. */
export const EVENTS_SCREEN_ID = 'tela-eventos';

/** O que a sidebar separa. */
export const EVENT_TABS = ['koth', 'masmorra'] as const;

export type EventTab = (typeof EVENT_TABS)[number];

const TAB_LABEL: Readonly<Record<EventTab, string>> = {
  koth: 'KOTH',
  masmorra: 'MASMORRA',
};

/** Quantos cards cabem numa página: uma grade de 2 por 2. */
export const CARDS_PER_PAGE = 4;

/** Teto de página, para um endereço forjado não virar uma conta grande. */
const MAX_PAGE = 99;

// ------------------------------------------------------------
//  O ENDEREÇO
//
//  `tela-eventos`                   KOTH, primeira página
//  `tela-eventos:masmorra`          a outra família
//  `tela-eventos:koth:1`            segunda página
//  `tela-eventos:koth:0:r:52`       o modal da run 52
//
//  O id da run vai como TEXTO, e não é convertido para número em
//  lugar nenhum desta tela: ele nasce do plugin, e o dia em que
//  ele deixar de caber num double não pode virar um evento errado
//  aberto em silêncio.
// ------------------------------------------------------------

export interface EventsScreenTarget {
  readonly tab: EventTab;
  readonly page: number;
  /** A run cujo detalhe está aberto, ou `null`. */
  readonly detail: string | null;
}

export function parseEventsScreenId(screenId: string): EventsScreenTarget | null {
  const parts = screenId.split(':');

  if (parts[0] !== EVENTS_SCREEN_ID) return null;

  const tab = (EVENT_TABS as readonly string[]).includes(parts[1] ?? '')
    ? (parts[1] as EventTab)
    : 'koth';

  const page = /^\d+$/.test(parts[2] ?? '')
    ? Math.min(Number.parseInt(parts[2] ?? '0', 10), MAX_PAGE)
    : 0;

  // `:r:<id>` — o marcador existe para o id da run poder ser
  // qualquer coisa sem virar "página" por engano.
  const detail = parts[3] === 'r' && (parts[4] ?? '') !== '' ? (parts[4] ?? null) : null;

  return { tab, page, detail };
}

export function eventsScreenId(tab: EventTab, page = 0, detail?: string): string {
  // O que está no padrão não vai no id: `tela-eventos` continua
  // sendo o endereço de sempre, e é ele que o botão da barra
  // aponta.
  if (tab === 'koth' && page === 0 && detail === undefined) return EVENTS_SCREEN_ID;

  const base = `${EVENTS_SCREEN_ID}:${tab}:${String(page)}`;

  return detail === undefined ? base : `${base}:r:${detail}`;
}

// ------------------------------------------------------------
//  OS DADOS
// ------------------------------------------------------------

/** Uma vaga de KOTH: ou uma disputa de pé, ou o último resultado. */
export interface KothCard {
  readonly runId: string;
  readonly name: string;
  readonly grid: string;
  readonly radius: number;
  /** De pé agora? `false` = é o resultado do último que aconteceu. */
  readonly live: boolean;

  // ####  DE PÉ  ####
  readonly percent?: number;
  /** O teamID de quem segura, como TEXTO: ele passa de 2^53. */
  readonly holderId?: string | null;
  readonly holderName?: string | null;
  readonly contested?: boolean;
  readonly inside?: number;
  /** Segundos até expirar. */
  readonly remaining?: number;
  /** Quanto tempo de domínio o território exige. */
  readonly captureSeconds?: number;
  /** A equipe que segura é a DE QUEM ABRIU o menu? */
  readonly mine?: boolean;

  // ####  ENCERRADO  ####
  readonly outcome?: 'captured' | 'expired' | 'stopped' | null;
  readonly winnerName?: string | null;
  /** Quando acabou, em epoch ms. */
  readonly endedAt?: number | null;
}

/** A masmorra de pé, quando há uma. */
export interface DungeonCard {
  readonly name: string;
  readonly grid: string | null;
  readonly startedAt: number | null;
}

export interface EventsScreenData {
  /** As vagas de KOTH, na ordem: as de pé primeiro. */
  readonly koth: readonly KothCard[];
  readonly dungeon: DungeonCard | null;
  /** Quantas vagas o servidor tem. */
  readonly vagas: number;
  /**
   * O que impediu de perguntar ao jogo.
   *
   * Presente = a tela diz que não sabe, em vez de dizer que não há
   * nada acontecendo.
   */
  readonly failure?: string | undefined;
}

// ------------------------------------------------------------
//  AS MEDIDAS
// ------------------------------------------------------------

const COLUMN = {
  width: 210,
  gap: 16,
  item: 34,
  textLeft: 12,
  accent: 3,
} as const;

const CONTENT_LEFT = COLUMN.width + COLUMN.gap;

const Y = {
  /** A faixa de título. */
  title: 42,
  /** Onde o corpo começa. */
  body: 56,
} as const;

const CARD = {
  height: 118,
  gapX: 12,
  gapY: 10,
  pad: 12,
} as const;

/** A faixa do paginador, embaixo. */
const PAGER_HEIGHT = 26;

function columnTitle(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: -Y.title },
    offsetMax: { x: COLUMN.width, y: 0 },
  };
}

function columnRect(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: COLUMN.width, y: -Y.body },
  };
}

function columnItem(index: number): Rect {
  const top = index * COLUMN.item;

  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(top + COLUMN.item) },
    offsetMax: { x: 0, y: -top },
  };
}

/** Uma faixa do conteúdo, medida do topo. */
function row(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: CONTENT_LEFT, y: -(Y.body + top + height) },
    offsetMax: { x: 0, y: -(Y.body + top) },
  };
}

/**
 * O retângulo de um card na grade 2×2.
 *
 * Ele é ancorado nos dois lados em X para a grade acompanhar a
 * largura do menu: com offset fixo, a segunda coluna ficaria no
 * lugar errado em qualquer resolução diferente da minha.
 */
function cardRect(index: number): Rect {
  const column = index % 2;
  const line = Math.floor(index / 2);
  const top = Y.body + line * (CARD.height + CARD.gapY);

  return {
    anchorMin: { x: column === 0 ? 0 : 0.5, y: 1 },
    anchorMax: { x: column === 0 ? 0.5 : 1, y: 1 },
    offsetMin: {
      x: column === 0 ? CONTENT_LEFT : CARD.gapX / 2,
      y: -(top + CARD.height),
    },
    offsetMax: { x: column === 0 ? -CARD.gapX / 2 : 0, y: -top },
  };
}

/** Uma linha DENTRO de um card, recuada da borda. */
function inner(top: number, height: number, right: number = CARD.pad): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: CARD.pad, y: -(top + height) },
    offsetMax: { x: -right, y: -top },
  };
}

// ------------------------------------------------------------
//  AS PALAVRAS
// ------------------------------------------------------------

/** "12:34", "1:02:03". O mesmo relógio do painel. */
export function clock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);

  if (hours > 0) return `${String(hours)}:${pad(minutes)}:${pad(safe % 60)}`;

  return `${String(minutes)}:${pad(safe % 60)}`;
}

/**
 * "agora", "há 12 min", "há 2 h".
 *
 * Hora do relógio não serve aqui: o jogador não sabe que horas são
 * no servidor, e "às 21:04" não responde "ainda dá tempo?".
 */
export function ago(epoch: number | null | undefined, now: number): string {
  if (epoch === null || epoch === undefined) return '';

  const minutes = Math.floor((now - epoch) / 60_000);

  if (minutes < 1) return 'agora';

  if (minutes < 60) return `há ${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `há ${String(hours)} h`;

  return `há ${String(Math.floor(hours / 24))} d`;
}

/** Em que pé está a disputa, em uma palavra. */
export function phaseOf(card: KothCard): 'contested' | 'holding' | 'paused' | 'idle' {
  if (card.contested === true) return 'contested';

  if ((card.inside ?? 0) > 0 && (card.holderName ?? '') !== '') return 'holding';

  return (card.percent ?? 0) > 0 ? 'paused' : 'idle';
}

/**
 * A linha de estado de um card.
 *
 * ####  ELA NÃO DIZ DE QUE EQUIPE SÃO OS OUTROS  ####
 *
 * A barra na tela do jogo também não: saber o nome de quem está lá
 * dentro é vantagem que se ganha indo ver, não abrindo o menu.
 */
export function stateLine(card: KothCard): string {
  if (!card.live) {
    if (card.outcome === 'captured') {
      return card.winnerName === null || card.winnerName === undefined || card.winnerName === ''
        ? 'terminou — uma equipe levou'
        : `levou: ${card.winnerName}`;
    }

    if (card.outcome === 'expired') return 'ninguém dominou a tempo';

    return 'encerrado';
  }

  switch (phaseOf(card)) {
    case 'contested':
      return 'CONTESTADO — a barra parou';

    case 'holding':
      return card.mine === true
        ? `sua equipe está dominando`
        : `dominando: ${card.holderName ?? ''}`;

    case 'paused':
      return card.holderName === null || card.holderName === undefined || card.holderName === ''
        ? 'território vazio'
        : `guardado por ${card.holderName}`;

    default:
      return 'ninguém no território';
  }
}

/** A cor daquele estado. */
function stateColor(card: KothCard): string {
  if (!card.live) return C.textMuted;

  switch (phaseOf(card)) {
    case 'contested':
      return C.amber;

    case 'holding':
      return card.mine === true ? C.olive : C.text;

    default:
      return C.textMuted;
  }
}

// ------------------------------------------------------------
//  O DESENHO
// ------------------------------------------------------------

export interface BuildEventsScreenOptions {
  readonly data: EventsScreenData;
  readonly target?: EventsScreenTarget;
  /** O id EXATO pedido: o plugin descarta o que não bate. */
  readonly screenId?: string;
  /** O relógio, para "há 12 min". Injetado para o teste não depender da hora. */
  readonly now?: number;
  /**
   * O ESQUELETO gravado no documento.
   *
   * O que fica no disco é o mínimo que responde enquanto o agente
   * não responde — a tela inteira é remontada a cada clique.
   */
  readonly skeleton?: boolean;
}

export function buildEventsScreen(options: BuildEventsScreenOptions): UiScreen {
  const target = options.target ?? { tab: 'koth', page: 0, detail: null };
  const screenId = options.screenId ?? eventsScreenId(target.tab, target.page);
  const now = options.now ?? Date.now();

  if (options.skeleton === true) {
    return {
      id: EVENTS_SCREEN_ID,
      name: 'EVENTOS',
      kind: 'page',
      elements: [
        ...titleBar('ev', 'EVENTOS', { subtitle: 'O que está acontecendo no mapa agora' }),
        label('ev-load', 'Perguntando ao servidor…', row(0, 22), {
          size: 12,
          color: C.textMuted,
          align: 'MiddleLeft',
        }),
      ],
    };
  }

  const { data } = options;

  // ####  O DETALHE É UM MODAL, E SÓ ELE  ####
  //
  // Um modal é uma tela `kind: 'modal'` inteira; desenhar a página
  // atrás dele de novo dobraria o pacote sem mudar um pixel — o
  // plugin mantém a página que já está na tela embaixo do véu.
  if (target.detail !== null) {
    return detailModal(data, target, screenId, now);
  }

  const elements: UiElement[] = [
    ...titleBar('ev', 'EVENTOS', {
      subtitle: 'O que está acontecendo no mapa agora',
      left: CONTENT_LEFT,
    }),
    ...sidebar(data, target),
  ];

  if (target.tab === 'masmorra') {
    elements.push(...dungeonBody(data));

    return { id: screenId, name: 'EVENTOS', kind: 'page', elements };
  }

  elements.push(...kothBody(data, target, now));

  return { id: screenId, name: 'EVENTOS', kind: 'page', elements };
}

/**
 * A coluna da esquerda.
 *
 * O item ABERTO não é botão: navegar para a tela em que já se está
 * é um clique que não faz nada, com o hover prometendo o contrário.
 * É a mesma regra da aba EQUIPE.
 */
function sidebar(data: EventsScreenData, target: EventsScreenTarget): UiElement[] {
  const live = data.koth.filter((card) => card.live).length;

  const count: Readonly<Record<EventTab, string>> = {
    koth: live > 0 ? String(live) : '',
    masmorra: data.dungeon === null ? '' : '1',
  };

  const items = EVENT_TABS.map((tab, index) => {
    const open = tab === target.tab;
    const children: UiElement[] = [
      label(`ev-col-${String(index)}l`, TAB_LABEL[tab], fill(COLUMN.textLeft, 0, 34, 0), {
        size: 12,
        color: open ? C.text : C.textMuted,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
    ];

    // O número de eventos de pé, à direita — é o que faz a coluna
    // valer a leitura quando há coisa acontecendo na outra família.
    if (count[tab] !== '') {
      children.push(
        label(`ev-col-${String(index)}n`, count[tab], fill(0, 0, COLUMN.textLeft, 0), {
          size: 12,
          color: C.rust,
          align: 'MiddleRight',
          font: 'RobotoCondensed-Bold.ttf',
        }),
      );
    }

    if (open) {
      return panel(`ev-col-${String(index)}`, columnItem(index), C.bg, [
        panel(`ev-col-${String(index)}b`, columnAccent(), C.rust),
        ...children,
      ]);
    }

    // O rótulo e o número vão como FILHOS do botão: o texto do
    // botão é um só, e aqui há dois textos em cantos opostos.
    return {
      ...button(
        `ev-col-${String(index)}`,
        '',
        columnItem(index),
        {
          id: `aev-col-${String(index)}`,
          kind: 'navigate',
          screenId: eventsScreenId(tab),
        },
        { color: C.none, textColor: C.text, hoverColor: C.surface },
      ),
      children,
    };
  });

  return [
    label('ev-coltit', 'EVENTOS', columnTitle(), {
      size: 20,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    panel('ev-col', columnRect(), C.surface2, items),
  ];
}

function columnAccent(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: COLUMN.accent, y: 0 },
  };
}

// ------------------------------------------------------------
//  O CORPO DO KOTH
// ------------------------------------------------------------

function kothBody(
  data: EventsScreenData,
  target: EventsScreenTarget,
  now: number,
): UiElement[] {
  if (data.failure !== undefined) {
    return [
      label('ev-falha', 'Não consegui perguntar ao servidor.', row(0, 20), {
        size: 13,
        align: 'MiddleLeft',
      }),
      label('ev-falha2', data.failure, row(22, 34), {
        size: 11,
        color: C.textMuted,
        align: 'UpperLeft',
      }),
    ];
  }

  if (data.koth.length === 0) {
    return [
      label('ev-vazio', 'Nenhum território agora.', row(0, 20), {
        size: 13,
        align: 'MiddleLeft',
      }),
      label(
        'ev-vazio2',
        'Quando um nascer, o servidor avisa no chat e ele aparece aqui — com a barra andando.',
        row(22, 34),
        { size: 11, color: C.textMuted, align: 'UpperLeft' },
      ),
    ];
  }

  const pages = Math.max(1, Math.ceil(data.koth.length / CARDS_PER_PAGE));
  const page = Math.min(target.page, pages - 1);
  const slice = data.koth.slice(page * CARDS_PER_PAGE, page * CARDS_PER_PAGE + CARDS_PER_PAGE);

  const out: UiElement[] = slice.map((card, index) => kothCard(card, index, page, now));

  if (pages > 1) {
    out.push(
      rowsPager({
        prefix: 'ev',
        rect: row(2 * (CARD.height + CARD.gapY) + 4, PAGER_HEIGHT),
        page,
        pages,
        screenIdOf: (next) => eventsScreenId('koth', next),
        kind: 'navigate',
      }),
    );
  }

  return out;
}

function kothCard(card: KothCard, index: number, page: number, now: number): UiElement {
  const id = `ev-c${String(index)}`;
  const percent = Math.max(0, Math.min(100, Math.round(card.percent ?? 0)));
  const children: UiElement[] = [];

  // ####  O ACENTO DIZ O ESTADO ANTES DA LEITURA  ####
  //
  // Vermelho é disputa de pé; cinza é vaga vazia com o último
  // resultado. De longe, a coluna de cards já se separa em duas.
  children.push(
    panel(`${id}-ac`, cardAccent(), card.live ? C.rust : C.border),

    label(`${id}-nome`, card.name, inner(10, 18, 70), {
      size: 14,
      align: 'MiddleLeft',
      color: card.live ? C.text : C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),

    // A grade é a informação mais prática do card: é por ela que o
    // jogador acha o lugar no mapa.
    label(`${id}-grid`, card.grid, inner(10, 18), {
      size: 12,
      align: 'MiddleRight',
      color: card.live ? C.amber : C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),

    label(`${id}-est`, stateLine(card), inner(30, 16), {
      size: 11,
      align: 'MiddleLeft',
      color: stateColor(card),
    }),
  );

  if (card.live) {
    // A barra: trilho e preenchimento. Ela é a mesma coisa que o
    // jogador vê na tela quando está lá dentro.
    children.push(
      panel(`${id}-tr`, inner(52, 8), C.surface2, [
        panel(`${id}-fl`, barFill(percent), phaseOf(card) === 'contested' ? C.amber : C.rust),
      ]),

      label(`${id}-pct`, `${String(percent)}%`, inner(64, 16, 90), {
        size: 12,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),

      label(
        `${id}-gente`,
        (card.inside ?? 0) === 1 ? '1 na área' : `${String(card.inside ?? 0)} na área`,
        inner(64, 16),
        { size: 11, align: 'MiddleRight', color: C.textMuted },
      ),

      label(`${id}-tempo`, `acaba em ${clock(card.remaining ?? 0)}`, inner(82, 16, 90), {
        size: 11,
        align: 'MiddleLeft',
        color: C.textMuted,
      }),
    );
  } else {
    children.push(
      label(`${id}-quando`, ago(card.endedAt, now), inner(52, 16), {
        size: 11,
        align: 'MiddleLeft',
        color: C.textMuted,
      }),
    );
  }

  children.push(
    button(
      `${id}-det`,
      'DETALHES',
      {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -96, y: CARD.pad },
        offsetMax: { x: -CARD.pad, y: CARD.pad + 22 },
      },
      {
        id: `a${id}-det`,
        kind: 'modal.open',
        screenId: eventsScreenId('koth', page, card.runId),
      },
      { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 11 },
    ),
  );

  return panel(id, cardRect(index), C.surface, children);
}

function cardAccent(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: 3, y: 0 },
  };
}

/** O preenchimento da barra, em fração da largura do trilho. */
function barFill(percent: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: Math.max(0, Math.min(1, percent / 100)), y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: 0, y: 0 },
  };
}

// ------------------------------------------------------------
//  O CORPO DA MASMORRA
// ------------------------------------------------------------

function dungeonBody(data: EventsScreenData): UiElement[] {
  if (data.dungeon === null) {
    return [
      label('ev-mvazio', 'Nenhuma masmorra de pé.', row(0, 20), {
        size: 13,
        align: 'MiddleLeft',
      }),
      label(
        'ev-mvazio2',
        'Ela nasce sozinha, avisa no chat e fica algum tempo no mapa. A entrada é uma casinha com alçapão.',
        row(22, 34),
        { size: 11, color: C.textMuted, align: 'UpperLeft' },
      ),
    ];
  }

  const dungeon = data.dungeon;

  return [
    panel('ev-m', row(0, 76), C.surface, [
      panel('ev-m-ac', cardAccent(), C.rust),
      label('ev-m-nome', dungeon.name, inner(12, 20, 90), {
        size: 14,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label('ev-m-grid', dungeon.grid ?? '', inner(12, 20), {
        size: 12,
        align: 'MiddleRight',
        color: C.amber,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label('ev-m-est', 'de pé agora', inner(36, 16), {
        size: 11,
        align: 'MiddleLeft',
        color: C.olive,
      }),
    ]),
  ];
}

// ------------------------------------------------------------
//  O MODAL DE DETALHES
// ------------------------------------------------------------

function detailModal(
  data: EventsScreenData,
  target: EventsScreenTarget,
  screenId: string,
  now: number,
): UiScreen {
  const card = data.koth.find((entry) => entry.runId === target.detail) ?? null;

  const close = button(
    'ev-d-fechar',
    'FECHAR',
    {
      anchorMin: { x: 0.5, y: 0 },
      anchorMax: { x: 0.5, y: 0 },
      offsetMin: { x: -60, y: 16 },
      offsetMax: { x: 60, y: 42 },
    },
    { id: 'aev-d-fechar', kind: 'modal.close' },
    { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 12 },
  );

  // O card sumiu entre a grade e o clique — o evento acabou no meio
  // do caminho. Dizer isso é melhor que um modal vazio.
  if (card === null) {
    return {
      id: screenId,
      name: 'EVENTO',
      kind: 'modal',
      elements: [
        modalFrame(380, 170, [
          label('ev-d-t', 'Este evento não está mais aí', modalTitle(), {
            size: 15,
            align: 'MiddleLeft',
          }),
          label('ev-d-m', 'Ele terminou enquanto você olhava a lista.', modalLine(58, 18), {
            size: 12,
            color: C.textMuted,
            align: 'MiddleLeft',
          }),
          close,
        ]),
      ],
    };
  }

  const lines: readonly (readonly [string, string])[] = card.live
    ? [
        ['Onde', `${card.name} · ${card.grid}`],
        ['Progresso', `${String(Math.round(card.percent ?? 0))}%`],
        ['Situação', stateLine(card)],
        ['Na área', String(card.inside ?? 0)],
        ['Acaba em', clock(card.remaining ?? 0)],
        ['Para vencer', `${String(Math.round((card.captureSeconds ?? 0) / 60))} min dominando`],
        ['Raio', `${String(card.radius)} m`],
      ]
    : [
        ['Onde', `${card.name} · ${card.grid}`],
        ['Como acabou', stateLine(card)],
        ['Quando', ago(card.endedAt, now)],
        ['Raio', `${String(card.radius)} m`],
      ];

  const body: UiElement[] = [
    label('ev-d-t', card.name, modalTitle(), { size: 16, align: 'MiddleLeft' }),
    label('ev-d-s', card.live ? 'Acontecendo agora' : 'Último resultado desta vaga', modalLine(46, 14), {
      size: 11,
      color: card.live ? C.olive : C.textMuted,
      align: 'MiddleLeft',
    }),
  ];

  lines.forEach(([name, value], index) => {
    const top = 70 + index * 22;

    body.push(
      label(`ev-d-k${String(index)}`, name, modalLine(top, 18, 0.42), {
        size: 11,
        color: C.textMuted,
        align: 'MiddleLeft',
      }),
      label(`ev-d-v${String(index)}`, value, modalLineRight(top, 18, 0.42), {
        size: 12,
        align: 'MiddleLeft',
      }),
    );
  });

  body.push(close);

  return {
    id: screenId,
    name: card.name,
    kind: 'modal',
    elements: [modalFrame(420, 110 + lines.length * 22 + 60, body)],
  };
}

function modalTitle(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 22, y: -46 },
    offsetMax: { x: -22, y: -18 },
  };
}

/** Uma linha do modal, medida do topo. */
function modalLine(top: number, height: number, widthFraction = 1): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: widthFraction, y: 1 },
    offsetMin: { x: 22, y: -(top + height) },
    offsetMax: { x: -8, y: -top },
  };
}

/** A metade direita de uma linha do modal. */
function modalLineRight(top: number, height: number, from: number): Rect {
  return {
    anchorMin: { x: from, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(top + height) },
    offsetMax: { x: -22, y: -top },
  };
}

// ============================================================
//  O MENU QUE JÁ ESTÁ GRAVADO
//
//  ####  A ABA EXISTE DESDE SEMPRE; A TELA VIVA, NÃO  ####
//
//  EVENTOS está no preset desde o primeiro menu — como um cartaz
//  dizendo "os eventos ativos entram aqui". Quem editou o menu
//  antes desta frente tem esse cartaz gravado, e o modelo não é
//  reaplicado: sem esta passagem, a aba continuaria prometendo para
//  sempre.
//
//  ####  A MARCA `generated` É O QUE FAZ O PLUGIN PERGUNTAR  ####
//
//  Sem ela o plugin desenha o que está no disco e nunca pede a tela
//  de verdade — a mesma pegadinha que custou uma sessão na aba
//  MISSÕES. É por isso que o upgrade existe mesmo quando a tela já
//  está lá: o que muda não é o desenho, é a marca.
//
//  Ele NÃO mexe na barra: o botão já aponta para `tela-eventos`.
// ============================================================

/**
 * Este documento TEM a aba EVENTOS?
 *
 * ####  NEM TODO DOCUMENTO É O MENU  ####
 *
 * O agente guarda mais de um: o menu principal e o overlay de
 * propaganda, por exemplo. A primeira versão desta passagem
 * acrescentava a tela em TODOS — e o overlay ganhou uma aba de
 * eventos que ninguém abre, no documento que o dono edita em
 * /propaganda.
 *
 * O que define o menu é haver um BOTÃO apontando para cá. Sem
 * botão, a tela seria um cômodo sem porta.
 */
function hasEventsTab(document: UiDocument): boolean {
  const visit = (elements: readonly UiElement[]): boolean =>
    elements.some(
      (element) =>
        (element.type === 'button' &&
          'screenId' in element.action &&
          element.action.screenId === EVENTS_SCREEN_ID) ||
        visit(element.children),
    );

  return visit(document.shell) || document.screens.some((screen) => visit(screen.elements));
}

/** Os ids do esqueleto: é por eles que ele se reconhece. */
const SKELETON_IDS = ['ev-ac', 'ev-titulo', 'ev-sub', 'ev-load'];

function isOurSkeleton(screen: UiScreen): boolean {
  return (
    screen.generated === true &&
    screen.elements.length === SKELETON_IDS.length &&
    screen.elements.every((element) => SKELETON_IDS.includes(element.id))
  );
}

export function withEventsScreen(document: UiDocument): UiDocument | null {
  const current = document.screens.find((screen) => screen.id === EVENTS_SCREEN_ID);

  if (!hasEventsTab(document)) {
    // ####  E DESFAZ O QUE A PRIMEIRA VERSÃO FEZ  ####
    //
    // Ela deixou o esqueleto em documento sem aba. Tirar é seguro
    // porque a condição é estreita: sem botão, marcado como nosso,
    // e com exatamente os elementos que nós escrevemos. Qualquer
    // tela que alguém tenha desenhado ali não casa e fica.
    if (current !== undefined && isOurSkeleton(current)) {
      return {
        ...document,
        screens: document.screens.filter((screen) => screen.id !== EVENTS_SCREEN_ID),
      };
    }

    return null;
  }

  // Já está marcada: nada a fazer, e é o caso de todo boot depois
  // do primeiro.
  if (current !== undefined && current.generated === true) return null;

  const skeleton: UiScreen = {
    ...buildEventsScreen({
      data: { koth: [], dungeon: null, vagas: 1 },
      skeleton: true,
    }),
    generated: true,
  };

  if (current === undefined) {
    // O botão existe e a tela não: ela entra, e o botão passa a
    // abrir alguma coisa.
    return { ...document, screens: [...document.screens, skeleton] };
  }

  return {
    ...document,
    screens: document.screens.map((screen) =>
      screen.id === EVENTS_SCREEN_ID ? skeleton : screen,
    ),
  };
}

// ------------------------------------------------------------
//  O PROVEDOR
// ------------------------------------------------------------

export interface EventsScreenProviderOptions {
  /**
   * O que está de pé AGORA, perguntado ao jogo.
   *
   * Lança quando não dá para perguntar — e é por isso que o
   * provedor embrulha: "não sei" é diferente de "não tem nada".
   */
  readonly liveKoth: (serverId: string) => Promise<readonly KothCard[]>;
  /** Os últimos KOTH encerrados, do banco, mais recentes primeiro. */
  readonly recentKoth: (serverId: string, limit: number) => readonly KothCard[];
  /** Quantas vagas aquele servidor tem. */
  readonly vagasOf: (serverId: string) => number;
  /** A masmorra de pé, se houver. */
  readonly liveDungeon: (serverId: string) => DungeonCard | null;
  /**
   * A equipe de quem abriu o menu, para marcar "sua equipe".
   *
   * Só é chamada quando há um território com dono — uma pergunta a
   * mais por RCON em toda abertura de menu não se paga.
   */
  readonly teamIdOf?: (serverId: string, steamId: string) => Promise<string | null>;
}

export type EventsScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

export function createEventsScreenProvider(
  options: EventsScreenProviderOptions,
): EventsScreenProvider {
  return async (input) => {
    const target = parseEventsScreenId(input.screenId);

    if (target === null) return null;

    const vagas = options.vagasOf(input.serverId);

    let live: readonly KothCard[] = [];
    let failure: string | undefined;

    try {
      live = await options.liveKoth(input.serverId);
    } catch (cause) {
      failure =
        cause instanceof Error && cause.message !== ''
          ? cause.message
          : 'O servidor não respondeu a tempo. Tente de novo em instantes.';
    }

    // ####  A VAGA VAZIA MOSTRA O ÚLTIMO RESULTADO  ####
    //
    // Sem isso, um servidor entre dois eventos mostraria a aba
    // vazia — e quem perdeu o evento por dez minutos não teria como
    // saber que ele existiu.
    const restantes = Math.max(0, vagas - live.length);
    const koth =
      failure === undefined
        ? [...live, ...options.recentKoth(input.serverId, restantes).slice(0, restantes)]
        : [];

    // Marcar "sua equipe" custa uma pergunta ao jogo: só vale
    // quando há dono para comparar.
    const holder = live.some(
      (card) => card.holderName !== null && card.holderName !== undefined && card.holderName !== '',
    );

    let mineTeam: string | null = null;

    if (holder && input.steamId !== undefined && options.teamIdOf !== undefined) {
      try {
        mineTeam = await options.teamIdOf(input.serverId, input.steamId);
      } catch {
        // Sem a equipe de quem abriu, o card só perde o destaque —
        // não é motivo para a tela inteira virar erro.
        mineTeam = null;
      }
    }

    const data: EventsScreenData = {
      koth:
        mineTeam === null
          ? koth
          : koth.map((card) => (card.holderId === mineTeam ? { ...card, mine: true } : card)),
      dungeon: options.liveDungeon(input.serverId),
      vagas,
      failure,
    };

    return toGeneratedScreenBundle(
      input.document,
      buildEventsScreen({ data, target, screenId: input.screenId }),
      // O SHELL conhece `tela-eventos`: sem isto, o destaque do
      // botão sumiria nas páginas com `:`.
      EVENTS_SCREEN_ID,
    );
  };
}
