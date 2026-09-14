// ============================================================
//  ui-rules-screen.ts  -  a página REGRAS, montada do que o admin
//  escreveu no painel.
//
//  ####  A ABA EXISTIA E NÃO TINHA NADA DENTRO  ####
//
//  `nav-regras` está no menu desde o primeiro preset, e a tela
//  dele era um retângulo dizendo "As regras do servidor entram
//  aqui". Pedido do dono em 14/09/2026: que ela vire a página de
//  verdade, com barra lateral como a do ranking, paginação, e
//  editável pelo painel — "sem alterar arquivos manualmente".
//
//  ####  O DESENHO É DA REDE; O TEXTO É DO BANCO  ####
//
//  Pela mesma razão da página DISCORD: um documento com as regras
//  escritas dentro obrigaria um menu por servidor. Aqui o
//  documento guarda o ENDEREÇO (`tela-regras`) e o desenho; o
//  texto vem de `RulesRepository`, que sabe se aquele servidor lê
//  as regras da rede ou as próprias.
//
//  ####  E ELA NÃO INVENTA REGRA NENHUMA  ####
//
//  Servidor que não publicou nada mostra a página dizendo isso.
//  Uma regra de exemplo aqui seria o agente publicando, no lugar
//  do dono, um texto pelo qual alguém pode ser banido. O modelo
//  existe, mas atrás de um clique no painel — ver `RULES_TEMPLATE`
//  em types/rules.ts.
//
//  ####  A PAGINAÇÃO É POR ALTURA, E NÃO POR CONTAGEM  ####
//
//  Uma regra de uma linha e uma de três ocupam coisas diferentes,
//  e "seis por página" deixaria metade das páginas com um buraco e
//  a outra metade com texto cortado pela borda — o CUI não tem
//  rolagem (ver types/ui-document.ts), então o que passa da caixa
//  some em silêncio.
//
//  Então a conta é de PIXELS: cada regra é medida, e a página
//  fecha quando a próxima não cabe. A largura da caixa vem do
//  desenho do admin quando ele existe (`measureSlot`), e da régua
//  estimada quando não.
// ============================================================

import type { Logger } from '../logger.js';
import type { RuleTone, RulesView } from '../types/rules.js';
import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';

import { screenViewport, type Size } from './ui-geometry.js';
import { fillTemplate, findTemplate, measureSlot, type SlotValue } from './ui-template.js';
import {
  button,
  C,
  clamp,
  fill,
  label,
  panel,
  rowsPager,
  textWidth,
  topBar,
  type Rect,
} from './ui-widgets.js';

/** O endereço desta tela no documento. */
export const RULES_SCREEN_ID = 'tela-regras';

/**
 * O comando de chat que abre nela.
 *
 * Sem barra: quem a põe é o jogo. Ele é um ATALHO do documento, e
 * é o que faz o Oxide parar de responder "Unknown command: regras"
 * a quem digita — ver `shortcuts` em types/ui-document.ts.
 */
export const RULES_COMMAND = 'regras';

/**
 * Os quatro lugares que o agente preenche na tela DESENHADA.
 *
 * Mesma disciplina do ranking: a tela gravada no documento não é
 * descartada, ela é o MODELO. O admin move a caixa, muda a cor da
 * coluna, reescreve o título — e o texto das regras é derramado
 * dentro do que ele desenhou. Ver ui-template.ts.
 */
export const RULES_SLOTS = {
  title: 'rg-titulo',
  subtitle: 'rg-sub',
  /** A coluna de seções. O agente derrama os itens dentro. */
  column: 'rg-col',
  /** A caixa das regras: as linhas da página e o pager. */
  list: 'rg-lista',
} as const;

/**
 * O teto da página que um endereço pode pedir.
 *
 * O id vem do plugin, e um `tela-regras:12:99999999` viraria um
 * índice absurdo. O teto o apara antes; a página que não existe é
 * aparada de novo contra o total real.
 */
const MAX_PAGE = 9_999;

// ####  AS MEDIDAS SÃO AS DO RANKING E DAS MISSÕES  ####
//
// Não são escolhas novas: são os números de `ui-ranking-screen.ts`
// e `ui-quests-screen.ts`, copiados. Três telas com colunas
// parecidas mas não iguais é pior que uma só — o olho nota a
// diferença de 4 px e ninguém sabe qual é a certa.
const Y = {
  /** A faixa do título. */
  title: 30,
  /** Onde a coluna e o conteúdo começam. */
  body: 40,
} as const;

const COLUMN = {
  width: 210,
  gap: 16,
  item: 34,
  textLeft: 12,
} as const;

/** A faixa do número de regras, à direita do item da coluna. */
const BADGE = 34;

const CONTENT_LEFT = COLUMN.width + COLUMN.gap;

/** A altura da faixa do subtítulo, logo abaixo do corpo. */
const SUBTITLE_HEIGHT = 18;

/** O rodapé onde o "‹ 1 / 2 ›" mora. */
const PAGER_HEIGHT = 26;

const RULE = {
  fontSize: 12,
  /** A altura de UMA linha de texto na fonte acima. */
  lineHeight: 16,
  /** O respiro entre duas regras. */
  gap: 10,
  /** A largura da barra de tom, à esquerda da regra. */
  accent: 3,
  /** O recuo do texto: a barra, mais o ar depois dela. */
  textLeft: 14,
  /** Quantas linhas uma regra pode ocupar. Ver MAX_RULE_TEXT. */
  maxLines: 4,
} as const;

/**
 * A caixa das regras, quando ninguém mediu o desenho.
 *
 * É a altura que sobra no slot de conteúdo do menu na base
 * 1280x720, descontados o corpo e o rodapé do pager. Serve de
 * régua para o documento que não tem a tela desenhada — com ela,
 * a paginação erra para menos, e errar para menos é uma página a
 * mais, nunca texto escondido.
 */
const FALLBACK_VIEWPORT = { width: 890, height: 430 } as const;

// ------------------------------------------------------------
//  §1  O ENDEREÇO
// ------------------------------------------------------------

export interface RulesScreenTarget {
  /** A seção aberta. `null` = a primeira. */
  readonly sectionId: number | null;
  readonly page: number;
}

/**
 * Lê o id da tela. `null` = não é uma tela de regras.
 *
 *     tela-regras          a primeira seção, primeira página
 *     tela-regras:12       aquela seção
 *     tela-regras:12:1     a segunda página dela
 *
 * ####  TUDO O QUE VEM TORTO É APARADO, NUNCA RECUSADO  ####
 *
 * O pedido veio do plugin e o jogador está com um "carregando" na
 * tela. Uma seção apagada vira a primeira; uma página que não é
 * número vira zero. Recusar deixaria alguém girando até o timeout.
 */
export function parseRulesScreenId(screenId: string): RulesScreenTarget | null {
  const parts = screenId.split(':');

  if (parts[0] !== RULES_SCREEN_ID) {
    return null;
  }

  const sectionId = Number(parts[1]);
  const page = Number(parts[2]);

  return {
    sectionId: Number.isInteger(sectionId) && sectionId > 0 ? sectionId : null,
    page: Number.isInteger(page) ? clamp(page, 0, MAX_PAGE) : 0,
  };
}

export function isRulesScreenId(screenId: string): boolean {
  return parseRulesScreenId(screenId) !== null;
}

/** O endereço de uma seção, para os botões da coluna e do pager. */
export function rulesScreenId(sectionId: number | null, page = 0): string {
  if (sectionId === null) {
    return RULES_SCREEN_ID;
  }

  return page === 0
    ? `${RULES_SCREEN_ID}:${String(sectionId)}`
    : `${RULES_SCREEN_ID}:${String(sectionId)}:${String(page)}`;
}

// ------------------------------------------------------------
//  §2  O QUE A TELA MOSTRA
// ------------------------------------------------------------

/** Um item da coluna: o nome da seção e quantas regras ela tem. */
export interface RulesSectionCard {
  readonly id: number;
  readonly title: string;
  readonly count: number;
}

/** Uma regra, já pronta para virar linha. */
export interface RulesLine {
  readonly text: string;
  readonly tone: RuleTone;
}

export interface RulesScreenView {
  readonly sections: readonly RulesSectionCard[];
  /** A seção aberta. `null` = não há nenhuma. */
  readonly activeId: number | null;
  /** As regras da seção ABERTA, inteiras: o recorte é por altura. */
  readonly lines: readonly RulesLine[];
  /** A página pedida. O que existe de verdade é aparado no desenho. */
  readonly page: number;
  /** A frase sob o título. */
  readonly subtitle: string;
  /** O aviso no lugar da lista. `null` = há regras para mostrar. */
  readonly emptyMessage: string | null;
}

export function emptyRulesView(): RulesScreenView {
  return {
    sections: [],
    activeId: null,
    lines: [],
    page: 0,
    subtitle: 'As regras deste servidor.',
    emptyMessage: 'Este servidor ainda não publicou as regras.',
  };
}

/**
 * O que o banco tem, recortado para a seção pedida.
 *
 * A seção do endereço pode não existir mais — o admin a apagou
 * enquanto o menu estava aberto. Aí vale a primeira, que é a
 * resposta certa: uma tela vazia pareceria defeito.
 */
export function readRulesView(input: {
  readonly rules: RulesView;
  readonly target: RulesScreenTarget;
}): RulesScreenView {
  const sections: RulesSectionCard[] = input.rules.sections
    .filter((section) => section.enabled)
    .map((section) => ({ id: section.id, title: section.title, count: section.items.length }));

  if (sections.length === 0) {
    return emptyRulesView();
  }

  const active =
    input.rules.sections.find((section) => section.id === input.target.sectionId && section.enabled) ??
    input.rules.sections.find((section) => section.id === sections[0]?.id);

  const lines: RulesLine[] =
    active === undefined ? [] : active.items.map((item) => ({ text: item.text, tone: item.tone }));

  return {
    sections,
    activeId: active?.id ?? null,
    lines,
    page: input.target.page,
    subtitle:
      input.rules.mode === 'own'
        ? 'As regras deste servidor.'
        : 'As regras valem em todos os servidores da rede.',
    // Seção existente e vazia é diferente de servidor sem regras: a
    // primeira é o admin no meio de escrever, e a frase diz isso.
    emptyMessage: lines.length === 0 ? 'Esta seção ainda não tem regras.' : null,
  };
}

// ------------------------------------------------------------
//  §3  A PAGINAÇÃO, QUE É POR ALTURA
// ------------------------------------------------------------

/**
 * Quantas linhas de texto uma regra ocupa naquela largura.
 *
 * ####  QUEM QUEBRA O TEXTO É O JOGO; AQUI SÓ SE CONTA  ####
 *
 * O rótulo do CUI quebra sozinho, então a regra inteira vai num
 * label só — dois elementos por regra em vez de um por linha, o
 * que importa num documento cujo teto é o frame do RCON.
 *
 * O que o agente precisa saber é a ALTURA que ela vai ocupar, para
 * fechar a página antes de o texto passar da caixa. A medida é a
 * estimada de `textWidth` (o agente não tem a fonte), e ela erra
 * alguns pixels para mais — o que sobra é ar no fim da página,
 * nunca uma linha escondida.
 */
export function ruleLineCount(text: string, width: number): number {
  const usable = Math.max(40, width - RULE.textLeft - 8);
  const words = text.split(/\s+/u).filter((word) => word !== '');

  let lines = 1;
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;

    if (textWidth(candidate, RULE.fontSize) <= usable) {
      current = candidate;
      continue;
    }

    lines += 1;
    current = word;
  }

  return clamp(lines, 1, RULE.maxLines);
}

interface RulesPage {
  readonly lines: readonly RulesLine[];
  /** O número da primeira regra da página, para a numeração. */
  readonly firstIndex: number;
  readonly page: number;
  readonly pages: number;
}

/**
 * As regras partidas em páginas do tamanho da caixa.
 *
 * Uma regra sozinha mais alta que a caixa inteira ainda entra —
 * sozinha, na página dela. Cortá-la seria esconder uma regra, e
 * uma página com uma linha só é feia, não errada.
 */
export function paginateRules(
  lines: readonly RulesLine[],
  box: Size,
  page: number,
): RulesPage {
  const pages: { readonly start: number; readonly end: number }[] = [];

  let start = 0;
  let used = 0;

  for (const [index, line] of lines.entries()) {
    const height = ruleLineCount(line.text, box.width) * RULE.lineHeight + RULE.gap;

    if (used > 0 && used + height > box.height) {
      pages.push({ start, end: index });
      start = index;
      used = 0;
    }

    used += height;
  }

  pages.push({ start, end: lines.length });

  const current = clamp(page, 0, pages.length - 1);
  const slice = pages[current] ?? { start: 0, end: lines.length };

  return {
    lines: lines.slice(slice.start, slice.end),
    firstIndex: slice.start,
    page: current,
    pages: pages.length,
  };
}

// ------------------------------------------------------------
//  §4  O DESENHO
// ------------------------------------------------------------

export interface BuildRulesScreenOptions {
  readonly view: RulesScreenView;
  /** O id PEDIDO. Responder outro faz o plugin descartar em silêncio. */
  readonly screenId?: string;
  /** O desenho gravado, para preencher em vez de montar. */
  readonly template?: UiScreen | null;
  /** O tamanho de onde a tela é desenhada. Só importa com `template`. */
  readonly viewport?: Size;
  /**
   * Desenhar o ESQUELETO: a tela que fica gravada no documento.
   *
   * A mesma peça do ranking, pela mesma razão: `fillTemplate`
   * preenche o que existe e NÃO CRIA o que falta. Sem a coluna no
   * esqueleto, ela nunca apareceria no jogo. Então ela entra
   * transparente e vazia — invisível no repouso, que é quando essa
   * tela é vista —, e o agente a pinta ao preencher.
   */
  readonly skeleton?: boolean;
}

export function buildRulesScreen(options: BuildRulesScreenOptions): UiScreen {
  if (options.template != null && isRulesTemplate(options.template)) {
    return fillRulesTemplate(options.template, options);
  }

  const { view } = options;
  const skeleton = options.skeleton ?? false;
  const hasColumn = view.sections.length > 0 || skeleton;
  const left = hasColumn ? CONTENT_LEFT : 0;

  const elements: UiElement[] = [
    label(RULES_SLOTS.title, titleOf(view), topBar(Y.title), {
      size: 20,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];

  if (hasColumn) {
    elements.push(...rulesColumn(view, skeleton));
  }

  elements.push(
    label(RULES_SLOTS.subtitle, view.subtitle, band(left, Y.body, SUBTITLE_HEIGHT), {
      size: 11,
      align: 'MiddleLeft',
      color: C.textMuted,
    }),
    listBox(view, left, options.viewport ?? FALLBACK_VIEWPORT),
  );

  return {
    id: options.screenId ?? RULES_SCREEN_ID,
    name: 'REGRAS',
    kind: 'page',
    elements,
  };
}

/**
 * Este desenho serve de modelo?
 *
 * A regra é a do ranking, e é estrutural: vale como modelo quem
 * tem os dois elementos que estruturam a tela — a coluna e a caixa
 * das regras. Quem não tem cai no layout embutido inteiro, que é o
 * que todo documento gravado antes desta frente tem.
 */
function isRulesTemplate(template: UiScreen): boolean {
  const has = (suffix: string): boolean =>
    walk(template.elements).some((element) => element.id.endsWith(suffix));

  return has(RULES_SLOTS.column) && has(RULES_SLOTS.list);
}

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

/**
 * O texto, derramado no desenho que o admin fez.
 *
 * Dele: onde cada peça fica, de que tamanho e de que cor. Nosso: o
 * nome da seção aberta, os itens da coluna, as regras da página —
 * e TODAS as ações, porque elas carregam `tela-regras:12:1` e o
 * `uiDocumentSchema` recusa `:` em `screenId` de ação.
 */
function fillRulesTemplate(template: UiScreen, options: BuildRulesScreenOptions): UiScreen {
  const { view } = options;
  const id = options.screenId ?? rulesScreenId(view.activeId, view.page);

  const box =
    options.viewport === undefined
      ? null
      : measureSlot(template, RULES_SLOTS.list, options.viewport);

  const size: Size =
    box === null ? FALLBACK_VIEWPORT : { width: box.width, height: box.height - PAGER_HEIGHT };

  const values: Record<string, SlotValue> = {
    [RULES_SLOTS.title]: { text: titleOf(view) },
    [RULES_SLOTS.subtitle]: { text: view.subtitle },
    // A cor vem daqui porque no esqueleto a coluna é transparente.
    [RULES_SLOTS.column]:
      view.sections.length === 0
        ? { hide: true }
        : { color: C.surface2, children: rulesColumnItems(view) },
    [RULES_SLOTS.list]: { children: listBody(view, size) },
  };

  return { ...fillTemplate(template, id, values), name: 'REGRAS' };
}

/**
 * O título da tela.
 *
 * Fica com o nome da seção aberta, como o do ranking fica com o do
 * ranking aberto: na tela desenhada, ele pode ser a única peça que
 * diz O QUE se está lendo — o admin pode ter movido a coluna para
 * longe dele.
 */
function titleOf(view: RulesScreenView): string {
  const active = view.sections.find((section) => section.id === view.activeId);

  return active === undefined ? 'REGRAS' : active.title.toUpperCase();
}

/** Uma faixa que vai do `left` até a borda direita, contada do topo. */
function band(left: number, top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -(top + height) },
    offsetMax: { x: 0, y: -top },
  };
}

// ------------------------------------------------------------
//  A COLUNA
// ------------------------------------------------------------

function rulesColumn(view: RulesScreenView, skeleton: boolean): UiElement[] {
  return [
    label('rg-coltit', 'REGRAS', columnTitle(), {
      size: 20,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    // O fundo da coluna é a divisória: pintá-la faz o trabalho de
    // uma régua de 1 px com um elemento a menos.
    panel(
      RULES_SLOTS.column,
      columnRect(),
      skeleton ? C.none : C.surface2,
      skeleton ? [] : rulesColumnItems(view),
    ),
  ];
}

function rulesColumnItems(view: RulesScreenView): UiElement[] {
  const items: UiElement[] = [];

  for (const [index, section] of view.sections.entries()) {
    const id = `rgs${String(section.id)}`;
    const active = section.id === view.activeId;

    // ####  O NÚMERO NÃO PODE ENCOSTAR NO BOTÃO  ####
    //
    // Um rótulo por cima do botão engole o clique: no Unity o texto
    // tem `raycastTarget` ligado, e no CUI a ordem da lista é a
    // profundidade. Custou uma tarde na tela de missões. O botão
    // termina onde o número começa.
    const badge = (color: string): UiElement =>
      label(`${id}n`, String(section.count), columnItem(index, COLUMN.width - BADGE, 12), {
        size: 12,
        color,
        align: 'MiddleRight',
        font: 'RobotoCondensed-Bold.ttf',
      });

    if (active) {
      items.push(
        panel(id, columnItem(index), C.bg, [
          panel(`${id}b`, columnAccent(), C.rust),
          label(`${id}l`, section.title.toUpperCase(), fill(COLUMN.textLeft, 0, BADGE, 0), {
            size: 12,
            color: C.text,
            align: 'MiddleLeft',
            font: 'RobotoCondensed-Bold.ttf',
          }),
        ]),
        badge(C.text),
      );

      continue;
    }

    items.push(
      button(
        id,
        section.title.toUpperCase(),
        columnItem(index, COLUMN.textLeft, BADGE),
        { id: `a${id}`, kind: 'navigate', screenId: rulesScreenId(section.id) },
        {
          color: C.none,
          textColor: C.textMuted,
          // O hover ESCURECE, na direção do item aberto: passar o
          // mouse prenuncia o que o clique faz.
          hoverColor: C.surface,
          fontSize: 12,
          align: 'MiddleLeft',
        },
      ),
      badge(C.textMuted),
    );
  }

  return items;
}

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

function columnItem(index: number, left = 0, right = 0): Rect {
  const top = index * COLUMN.item;

  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -(top + COLUMN.item) },
    offsetMax: { x: -right, y: -top },
  };
}

function columnAccent(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 3 },
    offsetMax: { x: RULE.accent, y: -3 },
  };
}

// ------------------------------------------------------------
//  A CAIXA DAS REGRAS
// ------------------------------------------------------------

/** A caixa inteira: do corpo até o fundo, à direita da coluna. */
function listBox(view: RulesScreenView, left: number, viewport: Size): UiElement {
  const top = Y.body + SUBTITLE_HEIGHT + 8;

  const rect: Rect = {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: 0 },
    offsetMax: { x: 0, y: -top },
  };

  // O que sobra para as regras é a caixa menos o rodapé do pager.
  const size: Size = {
    width: Math.max(200, viewport.width - left),
    height: Math.max(RULE.lineHeight, viewport.height - top - PAGER_HEIGHT),
  };

  return panel(RULES_SLOTS.list, rect, C.none, listBody(view, size));
}

/** O conteúdo da caixa: as regras da página, e o pager embaixo. */
function listBody(view: RulesScreenView, size: Size): UiElement[] {
  if (view.emptyMessage !== null) {
    return [
      label('rg-vazio', view.emptyMessage, fill(0, 0, 0, 0), {
        size: 13,
        color: C.textMuted,
        align: 'UpperCenter',
      }),
    ];
  }

  const page = paginateRules(view.lines, size, view.page);
  const elements: UiElement[] = [];

  let top = 0;

  for (const [index, line] of page.lines.entries()) {
    const height = ruleLineCount(line.text, size.width) * RULE.lineHeight;
    const id = `rgl${String(index)}`;

    elements.push(
      // A barra de tom, à esquerda: é ela que separa "isto é
      // proibido" de "isto é um lembrete" sem gastar uma palavra.
      panel(id, lineRect(top, top + height, 0, size.width - RULE.accent), toneColor(line.tone)),
      label(
        `${id}t`,
        `${String(page.firstIndex + index + 1)}.  ${line.text}`,
        lineRect(top, top + height, RULE.textLeft, 0),
        { size: RULE.fontSize, color: C.text, align: 'UpperLeft' },
      ),
    );

    top += height + RULE.gap;
  }

  if (page.pages > 1) {
    // O controle fica no RODAPÉ, e não depois da última regra: com
    // três regras ele nasce num lugar e com seis, noutro — e o
    // jogador teria de procurá-lo a cada seção.
    elements.push(
      rowsPager({
        prefix: 'rgp',
        rect: {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 0, y: 0 },
          offsetMax: { x: 0, y: PAGER_HEIGHT },
        },
        page: page.page,
        pages: page.pages,
        screenIdOf: (target) => rulesScreenId(view.activeId, target),
        kind: 'navigate',
      }),
    );
  }

  return elements;
}

/** Uma linha dentro da caixa, contada do topo dela. */
function lineRect(top: number, bottom: number, left: number, right: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -bottom },
    offsetMax: { x: -right, y: -top },
  };
}

function toneColor(tone: RuleTone): string {
  switch (tone) {
    case 'proibido':
      return C.rust;

    case 'alerta':
      return C.amber;

    case 'normal':
      return C.border;
  }
}

// ------------------------------------------------------------
//  §5  O PROVEDOR
// ------------------------------------------------------------

export type RulesScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
}) => UiScreenBundle | null;

export interface RulesScreenProviderOptions {
  /** O que aquele servidor lê, já resolvido entre rede e próprio. */
  readonly viewOf: (serverId: string) => RulesView;
  readonly logger?: Logger;
}

/**
 * O provedor que o `generatedScreens` do index.ts chama.
 *
 * `null` só para o que não é dele. Qualquer falha vira A TELA com o
 * aviso — volátil, e por isso o clique seguinte tenta de novo.
 * Silêncio deixaria o jogador girando até o timeout do plugin.
 */
export function createRulesScreenProvider(
  options: RulesScreenProviderOptions,
): RulesScreenProvider {
  return (input) => {
    const target = parseRulesScreenId(input.screenId);

    if (target === null) {
      return null;
    }

    const template = findTemplate(input.document.screens, RULES_SCREEN_ID);
    const viewport =
      template === null ? undefined : screenViewport(input.document, template);

    const pack = (view: RulesScreenView): UiScreenBundle =>
      toGeneratedScreenBundle(
        input.document,
        buildRulesScreen({ view, screenId: input.screenId, template, viewport }),
        // O endereço que o SHELL conhece: sem ele, abrir uma seção
        // apagaria o destaque de REGRAS no cabeçalho.
        RULES_SCREEN_ID,
      );

    try {
      return pack(readRulesView({ rules: options.viewOf(input.serverId), target }));
    } catch (error) {
      options.logger?.error(
        { server: input.serverId, screen: input.screenId, err: error },
        'não consegui montar a tela de regras; mando a tela com o aviso, que não fica em cache',
      );

      return pack({
        ...emptyRulesView(),
        emptyMessage: 'Não deu para carregar as regras agora. Tente de novo em instantes.',
      });
    }
  };
}
