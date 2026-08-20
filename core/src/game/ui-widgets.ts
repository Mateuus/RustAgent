// ============================================================
//  ui-widgets.ts  -  as peças que as telas geradas compartilham.
//
//  ####  POR QUE ELAS SAÍRAM DE DENTRO DAS TELAS  ####
//
//  A loja e a página de kits desenham a mesma coisa: uma grade de
//  cards com ícone, nome, uma linha de estado e um botão. Cada uma
//  tinha a sua cópia dos construtores — e duas cópias divergem no
//  primeiro ajuste, que é como uma tela ficou em grade e a outra em
//  lista.
//
//  Aqui elas são uma só. O que continua em cada arquivo é o que
//  aquela tela decide: o que vai no card, e o que o botão faz.
//
//  ####  ISTO NÃO É UM SISTEMA DE COMPONENTES  ####
//
//  O modelo (types/ui-document.ts) tem quatro tipos de elemento, e
//  nenhum deles é "card". Estas funções devolvem os mesmos quatro,
//  com o estilo do painel aplicado — nada aqui vira um tipo novo que
//  o editor precisaria saber desenhar.
// ============================================================

import type { UiAction, UiElement } from '../types/ui-document.js';

/** Os tokens de panel/src/app/globals.css. */
export const C = {
  /** --bg */
  bg: '#0F0F0F',
  /** --surface */
  surface: '#1B1B1B',
  /** --surface-2 */
  surface2: '#262626',
  /** --border */
  border: '#2E2E2E',
  /** --text */
  text: '#E8E8E8',
  /** --text-muted */
  textMuted: '#9A9A9A',
  /** --rust-red */
  rust: '#C43F2C',
  /** --olive */
  olive: '#6B7F5B',
  /** --amber — a cor do OZCoin, e só dele */
  amber: '#E6B265',
  white: '#FFFFFF',
  /** Transparente: um lugar, não um desenho. */
  none: '#00000000',
} as const;

export type Rect = UiElement['rect'];

/**
 * Estica no pai com uma margem em cada lado.
 *
 * Y do Unity cresce para CIMA: `bottom` entra no min e `top` sai do
 * max. Trocar os dois é o erro clássico, e ele só aparece quando
 * alguém ancora algo embaixo.
 */
export function fill(left = 0, top = 0, right = 0, bottom = 0): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: bottom },
    offsetMax: { x: -right, y: -top },
  };
}

/** Faixa colada no topo do pai, com altura fixa. */
export function topBar(height: number, offsetFromTop = 0): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(offsetFromTop + height) },
    offsetMax: { x: 0, y: -offsetFromTop },
  };
}

export function panel(
  id: string,
  rect: Rect,
  color: string,
  children: readonly UiElement[] = [],
): UiElement {
  return {
    id,
    name: id,
    type: 'panel',
    rect,
    color,
    sprite: null,
    imageType: 'Simple',
    material: null,
    children,
  };
}

export interface LabelStyle {
  readonly size?: number;
  readonly color?: string;
  readonly align?: Extract<UiElement, { type: 'label' }>['align'];
  readonly font?: Extract<UiElement, { type: 'label' }>['font'];
}

export function label(
  id: string,
  text: string,
  rect: Rect,
  style: LabelStyle = {},
  children: readonly UiElement[] = [],
): UiElement {
  return {
    id,
    name: id,
    type: 'label',
    rect,
    text,
    fontSize: style.size ?? 12,
    font: style.font ?? 'RobotoCondensed-Regular.ttf',
    color: style.color ?? C.text,
    align: style.align ?? 'MiddleCenter',
    children,
  };
}

export interface ButtonStyle {
  readonly color: string;
  readonly textColor: string;
  readonly hoverColor?: string;
  readonly fontSize?: number;
}

export function button(
  id: string,
  text: string,
  rect: Rect,
  action: UiAction,
  style: ButtonStyle,
): UiElement {
  return {
    id,
    name: id,
    type: 'button',
    rect,
    color: style.color,
    sprite: null,
    text,
    fontSize: style.fontSize ?? 12,
    font: 'RobotoCondensed-Bold.ttf',
    textColor: style.textColor,
    align: 'MiddleCenter',
    action,
    hoverColor: style.hoverColor ?? null,
    pressedColor: null,
    // Estado ativo é coisa do shell, que não é redesenhado. Numa
    // tela regerada a cada clique, a cor já vem certa de origem.
    activeColor: null,
    activeTextColor: null,
    activeOnScreenId: null,
    children: [],
  };
}

/**
 * O botão que NÃO É um botão: um painel morto com um rótulo.
 *
 * ####  ELE EXISTE PARA NÃO HAVER CLIQUE QUE NÃO FAZ NADA  ####
 *
 * "Já pegou", "daqui a 2h", "saldo insuficiente" — nos três casos o
 * lugar do botão precisa dizer POR QUE não dá, e não recusar depois
 * do toque. Um botão que recusa faz o jogador clicar três vezes
 * antes de desconfiar.
 */
export function deadButton(
  id: string,
  text: string,
  rect: Rect,
  color: string = C.textMuted,
): UiElement {
  return panel(id, rect, C.surface2, [
    label(`${id}l`, text, fill(), { size: 11, color, font: 'RobotoCondensed-Bold.ttf' }),
  ]);
}

/** O ícone de um item do jogo, resolvido pelo CLIENTE. */
export function itemImage(
  id: string,
  item: { readonly itemId: number; readonly skinId: string },
  rect: Rect,
): UiElement {
  return {
    id,
    name: id,
    type: 'image',
    rect,
    source: { kind: 'item', itemId: item.itemId, skinId: item.skinId },
    // Branco: `color` numa imagem TINGE. Qualquer outra cor pintaria
    // o ícone por cima.
    color: C.white,
    children: [],
  };
}

/**
 * Uma imagem BAIXADA PELO CLIENTE, a partir da URL.
 *
 * ####  QUEM BAIXA É O JOGADOR, E NÃO O AGENTE  ####
 *
 * O CUI leva a URL num `RawImage` e cada cliente busca os bytes
 * por conta própria. É o que permite mostrar a prévia do mapa do
 * RustMaps sem o agente guardar arquivo nenhum — e é também por
 * que a URL precisa ser pública: o que estiver atrás de login não
 * carrega para ninguém.
 */
export function urlImage(id: string, url: string, rect: Rect): UiElement {
  return {
    id,
    name: id,
    type: 'image',
    rect,
    source: { kind: 'url', url },
    // Branco: `color` numa imagem TINGE. Ver `itemImage`.
    color: C.white,
    children: [],
  };
}

/** O véu escuro e a caixa no meio, com a faixa de acento no topo. */
export function modalFrame(
  width: number,
  height: number,
  children: readonly UiElement[],
  accent: string = C.rust,
): UiElement {
  const half = { x: width / 2, y: height / 2 };

  // #000000B3 é o véu do preset. Um alfa diferente aqui seria uma
  // cor "quase igual", que é o tipo de diferença que ninguém nota e
  // ninguém consegue explicar depois.
  return panel('veil', fill(), '#000000B3', [
    panel(
      'box',
      {
        anchorMin: { x: 0.5, y: 0.5 },
        anchorMax: { x: 0.5, y: 0.5 },
        offsetMin: { x: -half.x, y: -half.y },
        offsetMax: { x: half.x, y: half.y },
      },
      C.surface,
      [
        // O CUI não tem borda: a faixa de acento faz o papel de
        // moldura, como no cabeçalho do menu.
        panel('acc', topBar(2), accent),
        ...children,
      ],
    ),
  ]);
}

/** O título no topo de um modal. */
export function modalHeader(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 22, y: -46 },
    offsetMax: { x: -22, y: -14 },
  };
}

// ============================================================
//  AS ABAS
// ============================================================

export interface TabSpec {
  /** O que o jogador lê. */
  readonly label: string;
  /** Para onde o clique NAVEGA. Ver o cabeçalho. */
  readonly screenId: string;
  readonly active: boolean;
}

/**
 * As abas de um modal.
 *
 * ####  ELAS NÃO GUARDAM ESTADO EM LUGAR NENHUM  ####
 *
 * Trocar de aba não é um evento: é um ENDEREÇO. O botão navega para
 * o mesmo modal com outro sufixo (`ozkit:kit-inicial:itens`), e o
 * agente devolve a tela já com a aba certa marcada — exatamente como
 * o `+` da quantidade na loja.
 *
 * A alternativa seria o plugin lembrar em que aba cada jogador está,
 * e o agente confiar nesse número. Mais código nos dois lados, para
 * um valor que já cabe no id da tela.
 */
export function tabsRow(prefix: string, tabs: readonly TabSpec[], top: number): UiElement[] {
  const output: UiElement[] = [];
  const width = 78;
  let cursor = 22;

  for (const [index, tab] of tabs.entries()) {
    const id = `${prefix}t${String(index)}`;

    const rect: Rect = {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 0, y: 1 },
      offsetMin: { x: cursor, y: -(top + 22) },
      offsetMax: { x: cursor + width, y: -top },
    };

    output.push(
      tab.active
        ? // A aba ativa é um painel, e não um botão: clicar nela
          // navegaria para onde já se está — um clique que não faz
          // nada, que é o que parece defeito.
          panel(id, rect, C.surface2, [
            label(`${id}l`, tab.label, fill(), {
              size: 11,
              color: C.text,
              font: 'RobotoCondensed-Bold.ttf',
            }),
          ])
        : button(
            id,
            tab.label,
            rect,
            { id: `a${id}`, kind: 'modal.open', screenId: tab.screenId },
            { color: C.none, textColor: C.textMuted, hoverColor: C.surface2, fontSize: 11 },
          ),
    );

    cursor += width + 2;
  }

  // A linha sob as abas, na cor da borda: é ela que amarra as duas
  // numa fileira só em vez de dois retângulos soltos.
  output.push(
    panel(
      `${prefix}tl`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(top + 23) },
        offsetMax: { x: -22, y: -(top + 22) },
      },
      C.border,
    ),
  );

  return output;
}

// ============================================================
//  A LISTA DE ITENS
// ============================================================

/** Uma linha da lista: o ícone é opcional. */
export interface ContentRow {
  readonly text: string;
  /** `null` = sem ícone. Uma vantagem de VIP não é uma coisa. */
  readonly item: { readonly itemId: number; readonly skinId: string } | null;
}

/** Altura de uma linha. */
export const LIST_LINE = 24;

/**
 * As linhas que cabem numa área daquela altura.
 *
 * ####  O QUE NÃO CABE É CONTADO, NUNCA CORTADO EM SILÊNCIO  ####
 *
 * O CUI não tem rolagem (o `ScrollView` derrubou o cliente — ver
 * types/ui-document.ts), então o que passa da área fica ESCONDIDO.
 * Escondido em silêncio é o pior desfecho: o jogador leva um kit
 * achando que ele tem menos do que tem.
 */
export function itemRows(rows: readonly ContentRow[], viewport: number, prefix = 'l'): UiElement[] {
  const fits = Math.floor(viewport / LIST_LINE);
  const visible = rows.length > fits ? rows.slice(0, fits - 1) : rows;
  const rest = rows.length - visible.length;

  const list: ContentRow[] =
    rest > 0 ? [...visible, { text: `e mais ${formatNumber(rest)}...`, item: null }] : [...visible];

  const output: UiElement[] = [];

  for (const [index, row] of list.entries()) {
    const y = LIST_LINE * index;

    if (row.item !== null) {
      output.push(
        itemImage(`${prefix}i${String(index)}`, row.item, {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          offsetMin: { x: 2, y: -(y + 22) },
          offsetMax: { x: 24, y: -y },
        }),
      );
    }

    output.push(
      label(
        `${prefix}n${String(index)}`,
        row.item === null ? `-  ${row.text}` : row.text,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          // Com ícone, o texto começa DEPOIS dele.
          offsetMin: { x: row.item === null ? 4 : 30, y: -(y + 22) },
          offsetMax: { x: -10, y: -y },
        },
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
      ),
    );
  }

  return output;
}

/** Uma fatia da lista: as linhas daquela página, e quantas páginas há. */
export interface RowsPage {
  readonly rows: readonly ContentRow[];
  /** A página que REALMENTE saiu — já aparada para o que existe. */
  readonly page: number;
  readonly pages: number;
}

/**
 * A lista partida em páginas do tamanho da área.
 *
 * ####  PÁGINAS PORQUE NÃO HÁ ROLAGEM  ####
 *
 * O `ScrollView` do CUI derrubou o cliente (ver types/ui-document.ts),
 * então uma lista que não cabe tem duas saídas: CONTAR o que sobrou
 * ("e mais 7...", o que `itemRows` faz) ou PAGINAR.
 *
 * Contar serve onde a lista é lembrete e o inteiro está a um clique —
 * a confirmação do resgate. Onde ela É o conteúdo, como o que vem
 * dentro do kit, contar deixa o jogador sabendo que existem sete
 * itens e sem nenhuma forma de descobrir QUAIS.
 */
export function paginateRows(rows: readonly ContentRow[], viewport: number, page: number): RowsPage {
  // Nunca zero: uma área baixa demais mostra uma linha e pagina o
  // resto, em vez de devolver páginas vazias para sempre.
  const fits = Math.max(1, Math.floor(viewport / LIST_LINE));
  const pages = Math.max(1, Math.ceil(rows.length / fits));
  // O endereço pode apontar para uma página que não existe mais — o
  // admin tirou itens do kit depois que o jogador abriu o menu. A
  // última é a resposta certa; uma tela vazia parece defeito.
  const current = clamp(page, 0, pages - 1);

  return { rows: rows.slice(current * fits, current * fits + fits), page: current, pages };
}

export interface PagerSpec {
  /** O começo dos ids, para não colidir com outra faixa na tela. */
  readonly prefix: string;
  /** A faixa inteira do controle. Os três pedaços se arrumam dentro. */
  readonly rect: Rect;
  readonly page: number;
  readonly pages: number;
  /** Para onde cada página leva. */
  readonly screenIdOf: (page: number) => string;
  /**
   * `navigate` numa página, `modal.open` num modal.
   *
   * Virar a página de uma lista DENTRO de um modal com `navigate`
   * fecharia o modal — o mesmo motivo pelo qual as abas usam
   * `modal.open`.
   */
  readonly kind: 'navigate' | 'modal.open';
}

/**
 * O "‹ 1 / 2 ›" de uma lista paginada.
 *
 * ####  UM DESENHO SÓ, EM TRÊS TELAS  ####
 *
 * A grade da loja, a de kits e as listas dos modais têm todas este
 * controle. Enquanto ele era copiado, cada cópia foi ficando com um
 * tamanho de fonte e um espaçamento — e o jogador vê três coisas
 * diferentes que fazem a mesma coisa.
 */
export function rowsPager(spec: PagerSpec): UiElement {
  const slot = (left: number, right: number): Rect => ({
    anchorMin: { x: 0.5, y: 0 },
    anchorMax: { x: 0.5, y: 1 },
    offsetMin: { x: left, y: 0 },
    offsetMax: { x: right, y: 0 },
  });

  const children: UiElement[] = [
    label(`${spec.prefix}pgn`, `${String(spec.page + 1)} / ${String(spec.pages)}`, slot(-30, 30), {
      size: 11,
      color: C.textMuted,
    }),
  ];

  // Nas pontas a seta SOME, em vez de ficar apagada: um botão visível
  // que não faz nada é indistinguível de um menu travado.
  if (spec.page > 0) {
    children.push(
      button(
        `${spec.prefix}pgp`,
        '‹',
        slot(-64, -34),
        { id: `a${spec.prefix}pgp`, kind: spec.kind, screenId: spec.screenIdOf(spec.page - 1) },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 14 },
      ),
    );
  }

  if (spec.page < spec.pages - 1) {
    children.push(
      button(
        `${spec.prefix}pgx`,
        '›',
        slot(34, 64),
        { id: `a${spec.prefix}pgx`, kind: spec.kind, screenId: spec.screenIdOf(spec.page + 1) },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 14 },
      ),
    );
  }

  return panel(`${spec.prefix}pg`, spec.rect, C.none, children);
}

// ============================================================
//  UTILIDADES
// ============================================================

/** Milhar com ponto, como no painel. */
export function formatNumber(value: number): string {
  return value.toLocaleString('pt-BR');
}

/**
 * Largura aproximada de um texto, para caixas que se ajustam.
 *
 * O agente não tem a fonte para medir de verdade. 0,55 do corpo por
 * caractere é a média da RobotoCondensed — erra alguns pixels e
 * nunca corta, que é o que importa numa etiqueta.
 */
export function textWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.55);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * "2 h 15 min", "45 min", "30 s" — quanto falta, em uma linha.
 *
 * ####  A UNIDADE MUDA COM A ESCALA, E ISSO IMPORTA  ####
 *
 * "faltam 7.320 segundos" é verdade e não responde nada. Entre
 * "falta 1 dia" e "faltam 6 horas" há a diferença que decide se
 * alguém espera ou fecha o menu.
 */
export function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) {
    return `${String(seconds)} s`;
  }

  const minutes = Math.ceil(seconds / 60);

  if (minutes < 60) {
    return `${String(minutes)} min`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const rest = minutes % 60;

    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }

  const days = Math.floor(hours / 24);

  return days === 1 ? '1 dia' : `${String(days)} dias`;
}

/** "15/08/2026 14:30" — a data como o painel a escreve. */
export function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
