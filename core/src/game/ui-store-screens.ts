// ============================================================
//  ui-store-screens.ts  -  a loja desenhada a partir do banco.
//
//  As outras telas do menu são desenhadas no editor e gravadas. A
//  loja NÃO PODE SER: o admin cria uma categoria no painel e ela
//  precisa aparecer no jogo, sem ninguém abrir o editor para
//  redesenhar a grade.
//
//  Então esta tela é GERADA. O documento gravado guarda só o
//  endereço dela (`tela-loja`), e quem pede recebe o catálogo de
//  agora — com os preços, as etiquetas e o que está ligado no
//  momento do clique.
//
//  ------------------------------------------------------------
//  ####  O ID DA TELA CARREGA OS PARÂMETROS  ####
//
//      tela-loja                  catálogo, primeira categoria
//      tela-loja:vip              aquela categoria
//      tela-loja:vip:2            a segunda página dela
//      ozitem:ak47:3              o modal do item, 3 unidades
//
//  Isto é o que dispensa estado no plugin. O botão `+` não
//  incrementa um contador em lugar nenhum: ele NAVEGA para o mesmo
//  modal com outro número, e o agente devolve a tela já com o total
//  recalculado.
//
//  A alternativa seria o plugin guardar a quantidade por jogador e o
//  agente confiar no número que ele mandasse — mais código nos dois
//  lados, para um valor que o servidor teria de validar de novo na
//  hora de cobrar.
//
//  ####  MAS ID DE TELA NÃO É ID DE MODELO  ####
//
//  `:` não passa no `idSchema` do documento, de propósito. Estes ids
//  NUNCA são gravados: nascem aqui, viajam dentro do JSON do pedido
//  (onde `:` é inofensivo) e morrem quando a tela fecha. Só
//  `tela-loja`, o endereço que o botão LOJA guarda, é um id de
//  verdade — e ele passa no schema.
//
//  ####  O QUE O JOGADOR CLICA NÃO É O QUE COBRA  ####
//
//  O botão de comprar carrega um id de AÇÃO, e a ação — com o
//  `offerId` e a quantidade — vai na tabela que acompanha a tela.
//  Ela é montada aqui, no servidor. O cliente não tem como pedir
//  "compre 3 pelo preço de 1": o preço nem passa por ele.
//
//  ####  E NÃO HÁ ROLAGEM  ####
//
//  O `ScrollView` do CUI derrubou o cliente do jogo — ver o
//  cabeçalho de types/ui-document.ts. Sem ele, o que passa da área
//  fica ESCONDIDO: não cortado, não avisado, some. Por isso a grade
//  PAGINA, e a lista de um pacote também: quando ela não cabe, a
//  última linha vira "‹ 1 / 2 ›" e o resto está a um clique.
//
//  Contar o que sobrou ("e mais 7...") não bastava aqui. O jogador
//  ficava sabendo que existiam mais sete itens e sem nenhuma forma
//  de ver QUAIS — dentro do modal em que ele foi justamente conferir
//  o que estava comprando.
// ============================================================

import type { OfferBadge, StoreOffer } from '../db/store-repository.js';
import { passPeriodLabel, vehicleFuelOf, type StoreCatalogEntry } from '../store/service.js';
import type { UiAction, UiElement, UiScreen } from '../types/ui-document.js';

import { storeIconKey } from './card-icons.js';
import type { SlotValue } from './ui-template.js';
import { type Size } from './ui-geometry.js';
import { measureSlot } from './ui-template.js';
import { SLOTS, fillTemplate } from './ui-store-template.js';
import { CELL, inventoryBlocks } from './ui-inventory.js';
import {
  deadButton,
  itemImage as gameItemImage,
  itemRows,
  label as styledLabel,
  LIST_LINE,
  paginateRows,
  rowsPager,
  tabsRow,
  type ContentRow,
} from './ui-widgets.js';

// ------------------------------------------------------------
//  Os mesmos tokens do painel (globals.css) e do preset do menu.
// ------------------------------------------------------------
const C = {
  bg: '#0F0F0F',
  surface: '#1B1B1B',
  surface2: '#262626',
  border: '#2E2E2E',
  text: '#E8E8E8',
  textMuted: '#9A9A9A',
  rust: '#C43F2C',
  olive: '#6B7F5B',
  amber: '#E6B265',
  white: '#FFFFFF',
  /** Transparente: um lugar, e não um desenho. */
  none: '#00000000',
} as const;

/** As cores de cada etiqueta, iguais às do painel. */
const BADGE_STYLE: Record<OfferBadge, { readonly bg: string; readonly text: string }> = {
  promo: { bg: C.rust, text: C.white },
  novo: { bg: C.olive, text: C.bg },
  destaque: { bg: C.amber, text: C.bg },
};

const BADGE_LABEL: Record<OfferBadge, string> = {
  promo: 'PROMO',
  novo: 'NOVO',
  destaque: 'DESTAQUE',
};

/**
 * O endereço da loja dentro do documento.
 *
 * O botão LOJA do cabeçalho navega para cá, e é isto que o agente
 * intercepta para GERAR em vez de ler. Mudar esta constante exige
 * mudar o preset do menu junto — ver game/ui-preset-main-menu.ts.
 */
export const STORE_SCREEN_ID = 'tela-loja';

/** O modal de um item. `ozitem:<offerId>:<quantidade>` */
export const STORE_ITEM_PREFIX = 'ozitem';

/** O id do aviso de resultado. Nasce aqui e morre no OK. */
export const RESULT_SCREEN_ID = 'ozresult';

/**
 * A grade da loja.
 *
 * ####  ALTURA EM PIXEL, E NÃO EM FRAÇÃO  ####
 *
 * Um card que ocupa "metade da área" funciona com oito ofertas e com
 * mais nenhuma. Com altura fixa ele tem o mesmo tamanho com quatro
 * ou com quarenta, e a paginação cuida do resto.
 */
const GRID = {
  columns: 4,
  gap: 10,
  categoryHeight: 30,
  /**
   * Altura de um card, na base 1280x720.
   *
   * As faixas em `CARD` somam 150; os 10 restantes são a folga entre
   * o nome e o preço. Sem ela os dois se ENCOSTAM, o que ainda passa
   * no teste de sobreposição mas fica feio na tela.
   */
  cardHeight: 160,
  /** Quantas linhas cabem na área de conteúdo. Ver o cabeçalho. */
  rows: 2,
} as const;

const PER_PAGE = GRID.columns * GRID.rows;

/**
 * O que fica onde DENTRO do card.
 *
 * ####  ISTO EXISTE PORQUE O NOME E O PREÇO SE SOBREPUSERAM  ####
 *
 * No projeto anterior o card mudou de tamanho e as coordenadas dos
 * filhos continuaram as de antes — nome a 110 do topo, preço a 62 da
 * base, num card de 150. Trinta e dois pixels de sobreposição, e no
 * jogo isso apareceu como "Python Revolver" escrito por cima de
 * "100 OZ".
 *
 * Com as faixas declaradas aqui, a conta é verificável: o teste soma
 * o que desce do topo com o que sobe da base e confere que cabe.
 * Antes não havia o que somar — os números estavam espalhados por
 * cinco chamadas.
 */
const CARD = {
  /** Do TOPO para baixo. */
  iconTop: 10,
  iconBottom: 68,
  nameTop: 72,
  nameBottom: 92,
  /** Da BASE para cima. */
  buttonBottom: 8,
  buttonTop: 34,
  priceBottom: 38,
  priceTop: 58,
} as const;

/**
 * Teto de unidades por compra.
 *
 * Não é preço: é o que impede um clique preso no `+` de virar uma
 * compra de mil unidades. O servidor cobra o que a ação diz, então o
 * limite precisa existir onde a ação é CRIADA.
 */
export const MAX_QUANTITY = 100;

/**
 * A altura da área da lista, no modal de um pacote.
 *
 * Sem rolagem (ver o cabeçalho), o que passa dela vai para a página
 * seguinte — ver `listChildren`.
 */
const LIST_VIEWPORT = 132;

// ------------------------------------------------------------
//  O ENDEREÇO
// ------------------------------------------------------------

/**
 * Qual aba do modal de um pacote está aberta.
 *
 * ####  ELA É PARTE DO ENDEREÇO, E NÃO UM ESTADO  ####
 *
 * `ozitem:vip-ouro:1:itens`. Trocar de aba NAVEGA para o mesmo modal
 * com outro sufixo, e o agente devolve a tela já com a aba certa —
 * exatamente como o `+` da quantidade. Nada é lembrado do lado do
 * plugin.
 */
export type StoreTab = 'geral' | 'itens' | 'item';

export type StoreScreenTarget =
  | { readonly kind: 'catalog'; readonly categoryId: string | null; readonly page: number }
  | {
      readonly kind: 'item';
      readonly offerId: string;
      readonly quantity: number;
      readonly tab: StoreTab;
      /** A página DA LISTA daquela aba. Ausente = a primeira. */
      readonly page?: number;
    };

/**
 * Lê o id da tela. `null` = não é uma tela da loja.
 *
 * Tudo o que vier fora do esperado é APARADO para algo válido em vez
 * de recusado: o pedido veio do plugin, e o jogador está com um
 * aviso de carregando na tela. Uma página 900 numa loja de 3 páginas
 * vira a última — nunca um erro.
 */
export function parseStoreScreenId(screenId: string): StoreScreenTarget | null {
  const parts = screenId.split(':');
  const head = parts[0];

  if (head === STORE_SCREEN_ID) {
    const category = parts[1] ?? '';

    return {
      kind: 'catalog',
      categoryId: category === '' ? null : category,
      page: Math.max(0, Number.parseInt(parts[2] ?? '0', 10) || 0),
    };
  }

  if (head === STORE_ITEM_PREFIX) {
    const offerId = parts[1] ?? '';

    if (offerId === '') {
      return null;
    }

    const parsed = Number.parseInt(parts[2] ?? '1', 10);

    return {
      kind: 'item',
      offerId,
      quantity: clamp(Number.isFinite(parsed) ? parsed : 1, 1, MAX_QUANTITY),
      // ####  "item" É A CASINHA ABERTA, E NÃO UMA TERCEIRA ABA  ####
      //
      // Ela não aparece na fileira: chega-se nela clicando numa
      // casinha da grade, e sai-se dela pelo VOLTAR. O número que
      // vem depois é o ÍNDICE do item, e não a página — numa tela
      // que mostra um item só não há o que paginar.
      tab: parts[3] === 'itens' || parts[3] === 'item' ? parts[3] : 'geral',
      page: Math.max(0, Number.parseInt(parts[4] ?? '0', 10) || 0),
    };
  }

  return null;
}

/**
 * O nome bonito de um item, a partir do shortname.
 *
 * ####  POR QUE ISTO É INJETADO  ####
 *
 * A oferta guarda `rifle.ak`, e é isso que o jogo precisa para
 * entregar. Mas "rifle.ak" numa lista de kit é ilegível — quem lê
 * quer "Assault Rifle".
 *
 * O nome bonito mora no catálogo de itens do agente, que este módulo
 * não conhece (e nem deveria: ele desenha telas). Injetar mantém o
 * gerador testável sem banco, e o recurso final é o próprio
 * shortname — feio, mas nunca vazio.
 */
export type NameResolver = (shortname: string) => string;

export interface BuildStoreScreenOptions {
  readonly catalog: readonly StoreCatalogEntry[];
  readonly target: StoreScreenTarget;
  /**
   * O id EXATO que foi pedido.
   *
   * ####  ELE PRECISA VOLTAR IDÊNTICO  ####
   *
   * O plugin guarda o que pediu e compara com o que chega:
   *
   *     if (session.PendingScreenId != screen.Id) return;
   *
   * É essa checagem que impede uma tela atrasada de aparecer depois
   * de o jogador já ter navegado para outra. Mas ela também DESCARTA
   * a resposta certa quando o id volta diferente — e o aviso de
   * "carregando" fica na tela até o timeout.
   *
   * Ausente = remonta a partir do alvo, que serve a quem chama de
   * teste.
   */
  readonly screenId?: string;
  /** Saldo do jogador, para o modal. `null` = ainda não se sabe. */
  readonly balance?: number | null;
  /**
   * O modal desenhado NO EDITOR, se o documento tiver um.
   *
   * Com ele, o layout é do admin e só os campos vêm daqui — ver
   * game/ui-store-template.ts. Sem ele, vale o layout embutido
   * abaixo, que é o que mantém funcionando os documentos gravados
   * antes disto.
   */
  readonly template?: UiScreen | null;
  /** O modal de KIT/VIP/VEÍCULO desenhado no editor. */
  readonly bundleTemplate?: UiScreen | null;
  /** Ausente = a lista mostra os shortnames. */
  readonly nameOf?: NameResolver;
  /**
   * Há lugar para um veículo perto do jogador AGORA?
   *
   * ####  POR QUE ISTO CHEGA ATÉ O DESENHO  ####
   *
   * Um veículo pode não caber onde a pessoa está — dentro da base,
   * num penhasco. Descobrir isso DEPOIS de cobrar seria débito,
   * estorno e susto no extrato.
   *
   * `null` = não se sabe (o plugin não respondeu). Aí o modal mostra
   * o botão: recusar sem certeza seria pior.
   */
  readonly vehicleSpace?: boolean | null;
  /**
   * O passe daquele jogador, para a VITRINE e para o modal.
   *
   * O card da grade usa isto pelo mesmo motivo do modal: quem já tem
   * não deve ver um COMPRAR que vai recusar depois do clique.
   *
   * `null` = não há oferta de passe na tela, ou não deu para
   * perguntar. Aí o card e o modal saem com nome e preço — e o botão
   * continua lá, pelo mesmo motivo do veículo: recusar sem certeza é
   * pior, e a compra confere de novo antes de cobrar.
   */
  readonly pass?: StorePassView | null;
  /**
   * O tamanho da tela em que o modal é desenhado.
   *
   * ####  SEM ELE, A LISTA PAGINA PELO NÚMERO ERRADO  ####
   *
   * No layout embutido a área da lista é conhecida (LIST_VIEWPORT).
   * No modelo DESENHADO ela é do admin — ele pode ter feito o slot
   * o dobro do tamanho, ou a metade.
   *
   * Paginar sempre por 132 px dava os dois erros de uma vez: num
   * slot maior, o modal mostrava cinco linhas e um "‹ 1 / 3 ›" com
   * meia caixa vazia embaixo; num slot menor, mandava pelo RCON
   * linhas que ninguém veria — e o teto de 50 000 bytes é do frame
   * inteiro.
   *
   * Ausente = vale a régua embutida, que é o que mantém funcionando
   * quem chama isto de um teste.
   */
  readonly viewport?: Size;
}

/**
 * Gera a tela. Nunca devolve `null` para um alvo válido.
 *
 * Loja vazia vira uma tela DIZENDO que está vazia — o jogador clicou
 * em LOJA e precisa receber alguma coisa. Uma tela em branco
 * pareceria o menu travado.
 */
export function buildStoreScreen(options: BuildStoreScreenOptions): UiScreen {
  return options.target.kind === 'catalog'
    ? buildCatalogScreen(options.catalog, options.target, options.screenId, options.pass ?? null)
    : buildItemScreen(
        options.catalog,
        options.target,
        options.balance ?? null,
        options.template ?? null,
        options.nameOf ?? ((shortname): string => shortname),
        options.vehicleSpace ?? null,
        options.bundleTemplate ?? null,
        options.viewport,
        options.pass ?? null,
      );
}

/**
 * O que a tela de compra precisa dizer sobre o passe (04 §7).
 *
 * ####  CADA CAMPO AQUI EVITA UMA RECLAMAÇÃO PREVISÍVEL  ####
 *
 * Não é enfeite: um passe é um mês nominal, de um servidor só, e
 * quem paga sem ver isso abre suporte — e tem razão. O `level` é o
 * argumento de venda do passe comprado tarde, e ele é DAQUELE
 * jogador, nunca um número genérico.
 */
export interface StorePassView {
  /** `2026-10`. O mês que a compra vai congelar no plano. */
  readonly period: string;
  /** Onde o passe vale — e só ali. */
  readonly serverName: string;
  /** Quantos dias do mês ainda restam, contando hoje. */
  readonly daysLeft: number;
  /** Já tem? Então o botão de comprar NÃO é desenhado. */
  readonly owned: boolean;
  /** O nível alcançado naquele servidor. É o que o retroativo entrega. */
  readonly level: number;
  /** O retroativo está ligado nesta temporada? */
  readonly retroactive: boolean;
  /** Há temporada no ar neste servidor? `false` = comprou, mas a trilha ainda não abriu. */
  readonly seasonReady: boolean;
}

// ============================================================
//  A GRADE
// ============================================================

function buildCatalogScreen(
  catalog: readonly StoreCatalogEntry[],
  target: Extract<StoreScreenTarget, { kind: 'catalog' }>,
  screenId: string | undefined,
  pass: StorePassView | null,
): UiScreen {
  // O id pedido, sem remontar. Ver `screenId` nas opções.
  const id =
    screenId ?? `${STORE_SCREEN_ID}${target.categoryId === null ? '' : `:${target.categoryId}`}`;

  if (catalog.length === 0) {
    return {
      id,
      name: 'Loja',
      kind: 'page',
      elements: [
        emptyState(
          'A loja está fechada',
          'Nenhuma categoria foi publicada ainda. Volte mais tarde.',
        ),
      ],
    };
  }

  // Categoria pedida, ou a primeira. Uma que sumiu (desligada com o
  // menu aberto) cai na primeira em vez de dar erro — o jogador vê a
  // loja, não uma falha.
  const active = catalog.find((entry) => entry.category.id === target.categoryId) ?? catalog[0];

  if (active === undefined) {
    return { id, name: 'Loja', kind: 'page', elements: [] };
  }

  const elements: UiElement[] = [];

  // ---- a barra de categorias ----
  let cursor = 0;

  for (const entry of catalog) {
    const isActive = entry.category.id === active.category.id;
    const width = categoryWidth(entry.category.name);

    elements.push(
      button(
        `cat${entry.category.id}`,
        entry.category.name.toUpperCase(),
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          offsetMin: { x: cursor, y: -GRID.categoryHeight },
          offsetMax: { x: cursor + width, y: 0 },
        },
        {
          id: `acat${entry.category.id}`,
          kind: 'navigate',
          screenId: `${STORE_SCREEN_ID}:${entry.category.id}`,
        },
        {
          color: isActive ? C.surface2 : '#00000000',
          textColor: isActive ? C.text : C.textMuted,
          fontSize: 11,
        },
      ),
    );

    cursor += width + 4;
  }

  // ---- as ofertas ----
  const offers = active.offers;
  const top = GRID.categoryHeight + GRID.gap;

  if (offers.length === 0) {
    elements.push(
      emptyState('Categoria vazia', 'Nenhum item publicado nesta categoria por enquanto.', top),
    );

    return { id, name: 'Loja', kind: 'page', elements };
  }

  const pages = Math.max(1, Math.ceil(offers.length / PER_PAGE));
  const page = Math.min(target.page, pages - 1);
  const slice = offers.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  elements.push(
    panel(
      'grid',
      fill(0, top, 0, 26),
      '#00000000',
      slice.map((offer, index) =>
        offerCard(offer, index % GRID.columns, Math.floor(index / GRID.columns), pass),
      ),
    ),
  );

  // Sem isto, o nono item de uma categoria sumiria sem nada na tela
  // dizer que ele existe — a pior forma de perder conteúdo, porque
  // ninguém percebe.
  if (pages > 1) {
    elements.push(...pager(active.category.id, page, pages));
  }

  return { id, name: 'Loja', kind: 'page', elements };
}

/** Largura do botão pelo tamanho do nome, com mínimo e teto. */
function categoryWidth(name: string): number {
  return clamp(name.length * 7 + 22, 60, 150);
}

/**
 * Os botões de página.
 *
 * Nas pontas o botão SOME em vez de ficar apagado: um botão visível
 * que não faz nada é indistinguível de um menu travado.
 */
function pager(categoryId: string, page: number, pages: number): readonly UiElement[] {
  const target = (next: number): string => `${STORE_SCREEN_ID}:${categoryId}:${String(next)}`;

  const elements: UiElement[] = [
    label(
      'pgn',
      `${String(page + 1)} / ${String(pages)}`,
      {
        anchorMin: { x: 0.5, y: 0 },
        anchorMax: { x: 0.5, y: 0 },
        offsetMin: { x: -30, y: 0 },
        offsetMax: { x: 30, y: 22 },
      },
      { size: 12, color: C.textMuted },
    ),
  ];

  if (page > 0) {
    elements.push(
      button(
        'pgp',
        '‹',
        {
          anchorMin: { x: 0.5, y: 0 },
          anchorMax: { x: 0.5, y: 0 },
          offsetMin: { x: -64, y: 0 },
          offsetMax: { x: -34, y: 22 },
        },
        { id: 'apgp', kind: 'navigate', screenId: target(page - 1) },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 14 },
      ),
    );
  }

  if (page < pages - 1) {
    elements.push(
      button(
        'pgx',
        '›',
        {
          anchorMin: { x: 0.5, y: 0 },
          anchorMax: { x: 0.5, y: 0 },
          offsetMin: { x: 34, y: 0 },
          offsetMax: { x: 64, y: 22 },
        },
        { id: 'apgx', kind: 'navigate', screenId: target(page + 1) },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 14 },
      ),
    );
  }

  return elements;
}

function offerCard(
  offer: StoreOffer,
  column: number,
  row: number,
  pass: StorePassView | null,
): UiElement {
  const columnWidth = 1 / GRID.columns;
  const half = GRID.gap / 2;
  // Do TOPO do conteúdo para baixo: é o topo que fica parado.
  const y = row * (GRID.cardHeight + GRID.gap);

  // ####  A VITRINE AVISA ANTES DO CLIQUE  ####
  //
  // Quem já comprou o passe do mês seria recusado na hora de cobrar
  // (store/service.ts, `pass-owned`) — mas só DEPOIS de clicar em
  // COMPRAR, abrir o modal e confirmar. Três passos para receber um
  // "não". Aqui o lugar do botão já diz que o passe é dele.
  //
  // `null` — não deu para perguntar, o passe não está ligado neste
  // servidor, ou não há temporada no ar — NÃO esconde nada: o botão
  // fica, e a recusa do servidor continua sendo a última palavra.
  // Errar para o lado do clique custa um aviso; errar para o outro
  // custa uma venda.
  const owned = offer.kind === 'pass' && pass?.owned === true;

  const buttonRect: Rect = {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: 8, y: CARD.buttonBottom },
    offsetMax: { x: -8, y: CARD.buttonTop },
  };

  const children: UiElement[] = [
    // O ícone vem do JOGO: `itemid` + `skinid`, e o cliente resolve o
    // sprite. Sem download, sem URL, e a skin aparece como aparece no
    // inventário.
    itemImage(`i${offer.id}`, offer, {
      anchorMin: { x: 0.5, y: 1 },
      anchorMax: { x: 0.5, y: 1 },
      offsetMin: { x: -29, y: -CARD.iconBottom },
      offsetMax: { x: 29, y: -CARD.iconTop },
    }),

    label(
      `n${offer.id}`,
      offerTitle(offer),
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 8, y: -CARD.nameBottom },
        offsetMax: { x: -8, y: -CARD.nameTop },
      },
      { size: 12 },
    ),

    // O preço em âmbar: a mesma cor do saldo no cabeçalho, para
    // "isto é OZCoin" ser uma ideia visual só.
    priceRow(
      `p${offer.id}`,
      formatNumber(offer.price),
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: 8, y: CARD.priceBottom },
        offsetMax: { x: -8, y: CARD.priceTop },
      },
      { size: 14, color: C.amber, align: offer.oldPrice === null ? 'center' : 'right' },
    ),

    owned
      ? // O botão que não é botão: mesmo lugar, mesma caixa, e o
        // motivo no lugar do convite. A frase é a MESMA do modal —
        // duas maneiras de dizer isto fariam o jogador conferir se
        // são a mesma coisa. Ver `deadButton`.
        deadButton(`b${offer.id}`, 'VOCÊ JÁ TEM', buttonRect)
      : button(
          `b${offer.id}`,
          'COMPRAR',
          buttonRect,
          // MODAL: a grade continua atrás, e fechar volta para onde
          // estava sem recarregar nada.
          { id: `ab${offer.id}`, kind: 'modal.open', screenId: itemScreenId(offer.id, 1) },
          { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 11 },
        ),
  ];

  // ---- o preço antigo, riscado ----
  //
  // O CUI não tem texto riscado: o risco é um painel de 1px por cima
  // do rótulo. Feito com o que existe, em vez de deixar o desconto
  // sem a comparação que o torna um desconto.
  if (offer.oldPrice !== null) {
    children.push(
      label(
        `o${offer.id}`,
        formatNumber(offer.oldPrice),
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 0, y: 0 },
          offsetMin: { x: 10, y: CARD.priceBottom },
          offsetMax: { x: 58, y: CARD.priceTop },
        },
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
        [
          panel(
            `os${offer.id}`,
            {
              anchorMin: { x: 0, y: 0.5 },
              anchorMax: { x: 0, y: 0.5 },
              offsetMin: { x: 0, y: -1 },
              offsetMax: { x: textWidth(formatNumber(offer.oldPrice), 11), y: 0 },
            },
            C.textMuted,
          ),
        ],
      ),
    );
  }

  if (offer.badge !== null) {
    const style = BADGE_STYLE[offer.badge];
    const text = BADGE_LABEL[offer.badge];

    children.push(
      panel(
        `t${offer.id}`,
        {
          anchorMin: { x: 1, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: -(textWidth(text, 10) + 12), y: -22 },
          offsetMax: { x: -6, y: -6 },
        },
        style.bg,
        [label(`tl${offer.id}`, text, fill(), { size: 10, color: style.text })],
      ),
    );
  }

  return panel(
    `c${offer.id}`,
    {
      anchorMin: { x: columnWidth * column, y: 1 },
      anchorMax: { x: columnWidth * (column + 1), y: 1 },
      offsetMin: { x: column === 0 ? 0 : half, y: -(y + GRID.cardHeight) },
      offsetMax: { x: column === GRID.columns - 1 ? 0 : -half, y: -y },
    },
    C.surface,
    children,
  );
}

// ============================================================
//  O MODAL DO ITEM
// ============================================================

export function itemScreenId(
  offerId: string,
  quantity: number,
  tab: StoreTab = 'geral',
  page = 0,
): string {
  const base = `${STORE_ITEM_PREFIX}:${offerId}:${String(quantity)}`;

  // A primeira página fica de fora pelo mesmo motivo da aba padrão:
  // só quem virou a página carrega o número.
  //
  // Na aba `item` o zero é CONTEÚDO, e não o padrão: ali o número
  // diz QUAL item, e omiti-lo daria ao primeiro da grade um
  // endereço de forma diferente da dos outros.
  if (page > 0 || tab === 'item') {
    return `${base}:${tab}:${String(page)}`;
  }

  // A aba padrão fica FORA do id: assim o endereço de um item solto
  // (que não tem abas) continua o mesmo de antes, e o plugin, que
  // compara o id pedido com o que volta, não vê diferença nenhuma.
  return tab === 'geral' ? base : `${base}:${tab}`;
}

function buildItemScreen(
  catalog: readonly StoreCatalogEntry[],
  target: Extract<StoreScreenTarget, { kind: 'item' }>,
  balance: number | null,
  template: UiScreen | null,
  nameOf: NameResolver,
  vehicleSpace: boolean | null,
  bundleTemplate: UiScreen | null,
  viewport: Size | undefined,
  pass: StorePassView | null,
): UiScreen {
  // A página entra no id que VOLTA: o plugin compara com o que
  // pediu e descarta o que não bate — ver `screenId` em
  // BuildStoreScreenOptions.
  const id = itemScreenId(target.offerId, target.quantity, target.tab, target.page ?? 0);
  const offer = findOffer(catalog, target.offerId);

  // A oferta saiu do ar entre a grade e o clique. Dizer isso é
  // melhor que um modal vazio — e melhor ainda que deixar comprar
  // algo que o admin acabou de desligar.
  if (offer === null) {
    return {
      id,
      name: 'Item',
      kind: 'modal',
      elements: [
        modalFrame(360, 170, [
          label('gt', 'Item indisponível', header(), { size: 16 }),
          label(
            'gm',
            'Esta oferta saiu da loja.',
            {
              anchorMin: { x: 0, y: 0 },
              anchorMax: { x: 1, y: 1 },
              offsetMin: { x: 20, y: 54 },
              offsetMax: { x: -20, y: -50 },
            },
            { size: 12, color: C.textMuted },
          ),
          closeButton('FECHAR'),
        ]),
      ],
    };
  }

  // ####  O DETALHE DE UMA CASINHA NÃO USA O MODELO  ####
  //
  // O modelo é "o modal do PACOTE": ele tem nome, ícone, resumo,
  // preço e os dois botões de compra. Preenchê-lo com um item de
  // dentro do pacote daria uma tela dizendo "BRONZE" com o preço do
  // VIP e a figura de uma bala — e um CONFIRMAR COMPRA que compraria
  // o VIP inteiro. Esta é outra tela, e tem o desenho dela.
  if (target.tab === 'item') {
    return {
      id,
      name: offer.name,
      kind: 'modal',
      elements: [modalFrame(400, 250, offerItemDetail(offer, nameOf, target))],
    };
  }

  const quantity = target.quantity;
  const total = offer.price * quantity;
  const affordable = balance === null || balance >= total;

  // ####  VEÍCULO SEM LUGAR NÃO PODE SER COMPRADO  ####
  //
  // `null` (não se sabe) NÃO bloqueia: recusar sem certeza seria
  // pior que deixar tentar — a compra confere de novo antes de
  // cobrar, e devolve a mesma recusa com o mesmo texto.
  const noSpace = offer.kind === 'vehicle' && vehicleSpace === false;

  // ####  QUEM JÁ TEM NÃO VÊ UM BOTÃO QUE VAI RECUSAR  ####
  //
  // A compra recusaria isto antes de cobrar (04 §3), então o botão
  // só levaria a um aviso. `null` — não deu para perguntar — NÃO
  // esconde nada, pelo mesmo critério do veículo: recusar sem
  // certeza é pior, e a compra confere de novo antes de cobrar.
  const owned = offer.kind === 'pass' && pass?.owned === true;
  const canBuy = affordable && !noSpace && !owned;

  // ####  KIT, VIP E VEÍCULO NÃO TÊM QUANTIDADE  ####
  //
  // "3x Kit Base" não é uma compra que alguém queira fazer, e "2x
  // VIP Gold 30 dias" é ambíguo — vira 60 dias ou dois VIPs?
  //
  // Tirar o seletor deles é o que faz o modal dizer uma coisa só:
  // isto é o pacote, isto é o preço. Item solto continua com ele,
  // que é onde comprar dez de uma vez faz sentido.
  const stacks = offer.kind === 'item';
  const lines = contentRows(offer, nameOf, pass);
  const page = target.page ?? 0;

  // ####  O MODELO DE ITEM VALE SÓ PARA ITEM SOLTO  ####
  //
  // Ele é um desenho FIXO, e a lista de um kit tem N linhas. Usá-lo
  // num kit apagava justamente o que importa: o modal saía sem "o
  // que vem dentro", que é a única coisa que justifica pagar por um
  // pacote.
  if (template !== null && stacks) {
    return fillTemplate(template, id, {
      [SLOTS.nome]: { text: offer.name },
      [SLOTS.icone]: offerImageSlot(offer),
      [SLOTS.descricao]: { text: offerSummary(offer, pass) },
      [SLOTS.quantidade]: { text: String(quantity) },
      [SLOTS.total]: { text: formatNumber(total), color: canBuy ? C.amber : C.rust },
      [SLOTS.saldo]:
        balance === null
          ? { hide: true }
          : {
              text: affordable
                ? `Seu saldo: ${formatNumber(balance)}`
                : `Saldo insuficiente — você tem ${formatNumber(balance)}`,
              color: affordable ? C.textMuted : C.rust,
            },
      // Nos limites o passo SOME, em vez de virar um clique que não
      // faz nada — o mesmo critério do layout embutido.
      [SLOTS.menos]:
        quantity > 1
          ? {
              action: {
                id: 'aqm',
                kind: 'modal.open',
                screenId: itemScreenId(offer.id, quantity - 1),
              },
            }
          : { hide: true },
      [SLOTS.mais]:
        quantity < MAX_QUANTITY
          ? {
              action: {
                id: 'aqp',
                kind: 'modal.open',
                screenId: itemScreenId(offer.id, quantity + 1),
              },
            }
          : { hide: true },
      [SLOTS.comprar]: canBuy
        ? { action: { id: 'abuy', kind: 'store.buy', offerId: offer.id, quantity } }
        : { hide: true },
      [SLOTS.cancelar]: { action: { id: 'acls', kind: 'modal.close' } },
    });
  }

  // ####  O PACOTE TEM MODELO PRÓPRIO  ####
  //
  // Ele hospeda uma lista de tamanho desconhecido, e por isso precisa
  // de um SLOT — o de item não tem onde pô-la.
  if (!stacks && bundleTemplate !== null) {
    return fillTemplate(bundleTemplate, id, {
      [SLOTS.pacoteNome]: { text: offer.name },
      [SLOTS.pacoteIcone]: offerImageSlot(offer),
      [SLOTS.pacoteResumo]: { text: offerSummary(offer, pass) },
      [SLOTS.pacoteTitulo]:
        lines.length === 0
          ? { hide: true }
          : {
              text:
                offer.perks.length > 0 && offer.items.length > 0
                  ? // Com abas, o título viraria um terceiro rótulo
                    // dizendo o que as abas já dizem.
                    ''
                  : listTitleOf(offer),
            },
      // A lista entra no elemento que o admin posicionou — e as setas
      // vão DENTRO dele, que é o único lugar cujo tamanho este
      // arquivo conhece num layout desenhado por outra pessoa.
      [SLOTS.pacoteLista]:
        lines.length === 0
          ? { hide: true }
          : {
              // ####  A ALTURA É A DO SLOT QUE O ADMIN DESENHOU  ####
              //
              // E não a régua embutida: num slot maior, paginar por
              // 132 px deixava meia caixa vazia sob um "‹ 1 / 3 ›";
              // num menor, mandava pelo RCON linhas que ninguém
              // veria. Ver `viewport` em BuildStoreScreenOptions.
              children: bundleBody(
                offer,
                nameOf,
                quantity,
                target.tab,
                page,
                bundleListHeight(bundleTemplate, viewport),
                bundleListWidth(bundleTemplate, viewport),
              ),
            },
      [SLOTS.pacoteTotal]: { text: formatNumber(total), color: canBuy ? C.amber : C.rust },
      [SLOTS.pacoteSaldo]: noSpace
        ? { text: 'Sem espaço aqui — vá para um lugar aberto', color: C.rust }
        : balance === null
          ? { hide: true }
          : {
              text: affordable
                ? `Seu saldo: ${formatNumber(balance)}`
                : `Saldo insuficiente — você tem ${formatNumber(balance)}`,
              color: affordable ? C.textMuted : C.rust,
            },
      [SLOTS.pacoteComprar]: canBuy
        ? { action: { id: 'abuy', kind: 'store.buy', offerId: offer.id, quantity: 1 } }
        : { hide: true },
      [SLOTS.pacoteCancelar]: { action: { id: 'acls', kind: 'modal.close' } },
    });
  }

  // ---- o layout embutido ----
  const body: UiElement[] = [
    label('ttl', offer.name, header(), { size: 16 }),

    itemImage('img', offer, {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 0, y: 1 },
      offsetMin: { x: 22, y: -140 },
      offsetMax: { x: 102, y: -60 },
    }),

    label(
      'qtd',
      offerSummary(offer, pass),
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 116, y: -86 },
        offsetMax: { x: -22, y: -62 },
      },
      { size: 12, color: C.textMuted, align: 'MiddleLeft' },
    ),
  ];

  if (stacks) {
    body.push(
      label(
        'qlb',
        'QUANTIDADE',
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 116, y: -112 },
          offsetMax: { x: -22, y: -92 },
        },
        { size: 10, color: C.textMuted, align: 'MiddleLeft' },
      ),

      stepper('m', '−', quantity > 1, itemScreenId(offer.id, quantity - 1), 116),

      panel(
        'qbx',
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          offsetMin: { x: 148, y: -142 },
          offsetMax: { x: 196, y: -114 },
        },
        C.bg,
        [label('qv', String(quantity), fill(), { size: 14 })],
      ),

      stepper('p', '+', quantity < MAX_QUANTITY, itemScreenId(offer.id, quantity + 1), 200),
    );
  }

  body.push(
    // O total, o saldo e os botões ficam colados na BASE da caixa —
    // então crescer a caixa os afasta do conteúdo sozinho, sem
    // cálculo nenhum aqui.
    priceRow(
      'tot',
      formatNumber(total),
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: 22, y: 78 },
        offsetMax: { x: -22, y: 104 },
      },
      { size: 18, color: affordable ? C.amber : C.rust, align: 'right' },
    ),

    label(
      'tlb',
      'TOTAL',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 78 },
        offsetMax: { x: 120, y: 104 },
      },
      { size: 11, color: C.textMuted, align: 'MiddleLeft' },
    ),
  );

  if (noSpace) {
    body.push(
      label(
        'nsp',
        'Sem espaço aqui — vá para um lugar aberto',
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 22, y: 54 },
          offsetMax: { x: -22, y: 72 },
        },
        { size: 11, color: C.rust, align: 'MiddleRight' },
      ),
    );
  } else if (balance !== null) {
    body.push(
      priceRow(
        'sal',
        affordable
          ? `Seu saldo: ${formatNumber(balance)}`
          : `Saldo insuficiente — você tem ${formatNumber(balance)}`,
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 22, y: 54 },
          offsetMax: { x: -22, y: 72 },
        },
        { size: 11, color: affordable ? C.textMuted : C.rust, align: 'right' },
      ),
    );
  }

  // ####  A CAIXA CRESCE COM O QUE ELA MOSTRA  ####
  //
  // Altura fixa cortaria a lista de um VIP com seis vantagens, ou
  // deixaria um buraco embaixo de um item solto.
  if (lines.length > 0) {
    // ####  A LISTA COMEÇA ABAIXO DO ÍCONE  ####
    //
    // O ícone ocupa até 140px do topo. O título da lista já esteve em
    // 116 e SAÍA POR CIMA DELE — visível no jogo como duas coisas
    // escritas uma sobre a outra.
    const listTop = 152;

    // ####  DUAS ABAS SÓ QUANDO HÁ DUAS COISAS  ####
    //
    // Um VIP que promete vantagens E entrega itens tem dois assuntos,
    // e misturá-los numa lista só faz "fila prioritária" e "500x
    // Sucata" virarem a mesma coisa. Já um kit sem vantagens tem UM
    // assunto — e uma aba solitária é um clique que não leva a lugar
    // nenhum.
    const tabbed = offer.perks.length > 0 && offer.items.length > 0;

    if (tabbed) {
      const rows =
        target.tab === 'itens'
          ? itemLines(offer, nameOf)
          : offer.perks.map((text) => ({ text, item: null }));

      body.push(
        ...tabsRow(
          'oz',
          [
            {
              label: 'GERAL',
              screenId: itemScreenId(offer.id, quantity, 'geral'),
              active: target.tab === 'geral',
            },
            {
              label: 'ITENS',
              screenId: itemScreenId(offer.id, quantity, 'itens'),
              active: target.tab === 'itens',
            },
          ],
          listTop,
        ),
        panel(
          'lsv',
          {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 22, y: -(listTop + 30 + LIST_VIEWPORT) },
            offsetMax: { x: -22, y: -(listTop + 30) },
          },
          C.none,
          listChildren(rows, offer.id, quantity, target.tab, page),
        ),
      );
    } else {
      body.push(
        label(
          'lst',
          listTitleOf(offer),
          {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 22, y: -(listTop + 16) },
            offsetMax: { x: -22, y: -listTop },
          },
          { size: 10, color: C.textMuted, align: 'MiddleLeft' },
        ),
        panel(
          'lsv',
          {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 22, y: -(listTop + 20 + LIST_VIEWPORT) },
            offsetMax: { x: -22, y: -(listTop + 20) },
          },
          C.none,
          listChildren(lines, offer.id, quantity, target.tab, page),
        ),
      );
    }
  }

  body.push(closeButton('CANCELAR'));

  // ####  O BOTÃO DE COMPRAR SÓ EXISTE SE DÁ PARA COMPRAR  ####
  //
  // Sem saldo, ele não é desenhado — em vez de desenhado e recusado
  // depois. A recusa funcionaria (o servidor confere de novo), mas
  // fazer o jogador clicar para descobrir que não pode é pior que
  // dizer antes.
  if (canBuy) {
    body.push(
      button(
        'buy',
        'CONFIRMAR COMPRA',
        {
          anchorMin: { x: 1, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: -170, y: 16 },
          offsetMax: { x: -22, y: 44 },
        },
        // A AÇÃO carrega o offerId e a quantidade. O cliente manda só
        // o id dela — ver o cabeçalho deste arquivo.
        { id: 'abuy', kind: 'store.buy', offerId: offer.id, quantity },
        { color: C.rust, textColor: C.white, hoverColor: '#D4553FFF', fontSize: 12 },
      ),
    );
  } else {
    body.push(
      panel(
        'nob',
        {
          anchorMin: { x: 1, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: -170, y: 16 },
          offsetMax: { x: -22, y: 44 },
        },
        C.surface2,
        [
          // ####  O MOTIVO CERTO, E NÃO "SEM SALDO" PARA TUDO  ####
          //
          // Três coisas escondem o botão, e dizer "saldo" nas três
          // faria quem já tem o passe achar que está sem dinheiro —
          // a mesma armadilha do `store-unavailable` na compra.
          label(
            'nol',
            owned ? 'VOCÊ JÁ TEM' : noSpace ? 'SEM ESPAÇO AQUI' : 'SALDO INSUFICIENTE',
            fill(),
            {
              size: 11,
              color: C.textMuted,
            },
          ),
        ],
      ),
    );
  }

  const extra = lines.length === 0 ? 0 : 20 + LIST_VIEWPORT;

  return {
    id,
    name: offer.name,
    kind: 'modal',
    elements: [modalFrame(420, 285 + extra, body)],
  };
}

/**
 * O aviso de que a compra terminou.
 *
 * ####  POR QUE UM MODAL, E NÃO SÓ UMA LINHA NO CHAT  ####
 *
 * A mensagem de chat aparece atrás do menu aberto, no canto, e some
 * sozinha. Quem acabou de gastar OZCoin fica olhando a loja sem
 * saber se funcionou — e clica de novo.
 *
 * O modal exige um OK. É a diferença entre avisar e ter certeza de
 * que a pessoa viu.
 */
export function buildResultScreen(options: {
  readonly ok: boolean;
  readonly message: string;
  readonly balance: number | null;
  /** O aviso desenhado no editor, se houver. */
  readonly template?: UiScreen | null;
  /**
   * A página para onde o OK volta.
   *
   * ####  FECHAR O AVISO NÃO BASTA  ####
   *
   * MEDIDO no jogo: depois de pegar um kit, o card continuava
   * dizendo RESGATAR. O modal é desenhado POR CIMA, e a página
   * atrás — a que mudou — fica como estava até alguém navegar.
   *
   * Com o OK navegando de volta, o plugin fecha o modal E pede a
   * tela de novo; como ela é gerada, ela chega do banco de agora,
   * com o botão já no estado certo.
   *
   * Ausente = `modal.close`, que é o comportamento de quem está com
   * o plugin antigo (ele não manda a página no pedido).
   */
  readonly backTo?: string | undefined;
}): UiScreen {
  const okAction: UiAction =
    options.backTo === undefined
      ? { id: 'arok', kind: 'modal.close' }
      : { id: 'arok', kind: 'navigate', screenId: options.backTo };

  if (options.template != null) {
    return fillTemplate(options.template, RESULT_SCREEN_ID, {
      [SLOTS.titulo]: {
        text: options.ok ? 'COMPRA CONCLUÍDA' : 'NÃO DEU CERTO',
        color: options.ok ? C.olive : C.rust,
      },
      [SLOTS.mensagem]: { text: options.message },
      [SLOTS.saldoResultado]:
        options.balance === null
          ? { hide: true }
          : { text: `Saldo: ${formatNumber(options.balance)}` },
      [SLOTS.ok]: { action: okAction },
    });
  }

  const body: UiElement[] = [
    // A faixa de acento muda de cor com o desfecho: é o que se lê
    // antes de ler qualquer palavra.
    panel(
      'racc',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -3 },
        offsetMax: { x: 0, y: 0 },
      },
      options.ok ? C.olive : C.rust,
    ),

    label('rttl', options.ok ? 'COMPRA CONCLUÍDA' : 'NÃO DEU CERTO', header(), {
      size: 15,
      color: options.ok ? C.olive : C.rust,
      align: 'MiddleLeft',
    }),

    label(
      'rmsg',
      options.message,
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: 60 },
        offsetMax: { x: -22, y: -52 },
      },
      { size: 13, color: C.text, align: 'UpperLeft' },
    ),

    button(
      'rok',
      'OK',
      {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -110, y: 16 },
        offsetMax: { x: -22, y: 44 },
      },
      okAction,
      { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 12 },
    ),
  ];

  if (options.balance !== null) {
    body.push(
      priceRow(
        'rbal',
        `Saldo: ${formatNumber(options.balance)}`,
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 0, y: 0 },
          offsetMin: { x: 22, y: 16 },
          offsetMax: { x: 210, y: 44 },
        },
        { size: 12, color: C.amber, align: 'right' },
      ),
    );
  }

  return {
    id: RESULT_SCREEN_ID,
    name: 'Resultado',
    kind: 'modal',
    elements: [modalFrame(400, 190, body)],
  };
}

/**
 * O que vem dentro do pacote, uma linha por coisa.
 *
 * ####  SEM ISTO, "KIT BASE" NÃO DIZ NADA  ####
 *
 * Um item solto se explica pelo ícone e pelo nome. Um kit, não: quem
 * paga 500 OZ por "Kit Base" precisa ver o que está levando ANTES de
 * clicar — e um VIP precisa mostrar por que vale.
 */
function contentRows(
  offer: StoreOffer,
  nameOf: NameResolver,
  pass: StorePassView | null,
): readonly ContentRow[] {
  if (offer.kind === 'vip') {
    // As vantagens primeiro: é o que vende o VIP. Os itens que vêm
    // junto são o extra, e vêm depois. (Com os dois, o modal separa
    // em abas — ver `tabbed` em buildItemScreen.)
    return [...offer.perks.map((text) => ({ text, item: null })), ...itemLines(offer, nameOf)];
  }

  if (offer.kind === 'pass') {
    // As linhas do passe vêm primeiro pelo mesmo motivo das
    // vantagens do VIP: é o que o jogador precisa ler ANTES de
    // pagar. Os itens que venham junto são o extra.
    return [...passLines(pass), ...itemLines(offer, nameOf)];
  }

  return offer.kind === 'item' ? [] : itemLines(offer, nameOf);
}

/**
 * As quatro linhas que a tela do passe precisa dizer (04 §7).
 *
 * ####  SEM ELAS, O CARD "PASSE DE BATALHA" MENTE POR OMISSÃO  ####
 *
 * Um passe é de um MÊS, de um SERVIDOR, e comprar no dia 30 é
 * comprar um dia. Cada uma dessas três coisas é uma reclamação
 * previsível — e a quarta, o retroativo, é o principal argumento de
 * venda de quem compra tarde, e desaparece se ninguém disser.
 *
 * Vazio quando não deu para perguntar: uma linha inventada sobre o
 * que o jogador tem seria pior que nenhuma.
 */
function passLines(pass: StorePassView | null): readonly ContentRow[] {
  if (pass === null) {
    return [];
  }

  const rows: ContentRow[] = [
    { text: `Vale só no servidor ${pass.serverName}`, item: null },
    {
      text:
        pass.daysLeft === 1
          ? 'Falta 1 dia para o mês acabar'
          : `Faltam ${formatNumber(pass.daysLeft)} dias para o mês acabar`,
      item: null,
    },
  ];

  if (!pass.seasonReady) {
    // Comprou um mês que ainda não abriu. Dizer isso é melhor que
    // deixá-lo procurar a trilha que não existe — e o direito fica
    // gravado, então a compra não se perde.
    rows.push({ text: 'A temporada deste mês ainda não começou', item: null });
  } else if (!pass.retroactive) {
    // O retroativo é uma chave do admin (01 §5), e desligada ela
    // muda o que a compra entrega. A tela conta.
    rows.push({ text: 'A faixa paga vale do próximo nível em diante', item: null });
  } else if (pass.level > 1) {
    // O número é DAQUELE jogador. Um genérico ("resgate os níveis
    // que você já tem") não vende nada.
    rows.push({
      text: `Resgate na hora os ${formatNumber(pass.level)} níveis que você já alcançou`,
      item: null,
    });
  } else {
    rows.push({ text: 'As recompensas pagas destravam conforme você sobe de nível', item: null });
  }

  if (pass.owned) {
    rows.push({ text: 'Você já tem o passe deste mês', item: null });
  }

  return rows;
}

/**
 * A lista de um pacote, com o "‹ 1 / 2 ›" quando ela não cabe.
 *
 * ####  A ÚLTIMA LINHA CEDE O LUGAR PARA AS SETAS  ####
 *
 * Aqui não há vão sobrando como no modal de kits: logo abaixo da
 * lista vêm o total e o saldo, colados na base da caixa. Então
 * quando a lista passa da área, a última linha vira o controle — uma
 * linha a menos por página, e o último item ALCANÇÁVEL.
 *
 * É o que faltava: um kit de treze itens dizia "e mais 7..." e
 * acabava ali, dentro do modal em que o jogador foi justamente ver o
 * que estava comprando.
 */
function listChildren(
  rows: readonly ContentRow[],
  offerId: string,
  quantity: number,
  tab: StoreTab,
  page: number,
  height = LIST_VIEWPORT,
): UiElement[] {
  // Cabendo inteira, ela ocupa a área inteira: nada de gastar uma
  // linha com um "1 / 1".
  const whole = paginateRows(rows, height, page);

  if (whole.pages === 1) {
    return itemRows(whole.rows, height, 'oz');
  }

  const viewport = height - LIST_LINE;
  const slice = paginateRows(rows, viewport, page);

  return [
    ...itemRows(slice.rows, viewport, 'oz'),
    rowsPager({
      prefix: 'oz',
      rect: {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -height },
        offsetMax: { x: 0, y: -viewport },
      },
      page: slice.page,
      pages: slice.pages,
      screenIdOf: (next) => itemScreenId(offerId, quantity, tab, next),
      // `navigate` fecharia o modal — ver as abas.
      kind: 'modal.open',
    }),
  ];
}

/**
 * A altura do slot da lista no modelo desenhado.
 *
 * `null` em qualquer ponto da cadeia devolve a régua embutida: um
 * documento sem o slot (alguém o apagou no editor) não tem onde a
 * lista ser derramada de qualquer jeito, e um modal sem `viewport`
 * é o caso de quem chama isto de um teste.
 */
function bundleListHeight(template: UiScreen | null, viewport: Size | undefined): number {
  if (template === null || viewport === undefined) {
    return LIST_VIEWPORT;
  }

  const box = measureSlot(template, SLOTS.pacoteLista, viewport);

  // Altura não-positiva é um estado legítimo do modelo (os offsets
  // se cruzaram no editor). Paginar por ela daria zero linha por
  // página para sempre — a régua embutida ao menos mostra alguma
  // coisa, e o desenho torto é visível.
  return box === null || box.height < LIST_LINE ? LIST_VIEWPORT : box.height;
}

/**
 * A largura do slot, que decide quantas casinhas cabem na fileira.
 *
 * O padrão é o do preset (520 de caixa menos 22 de margem de cada
 * lado): num slot que não dá para medir, seis casinhas de 44 ainda
 * é a aposta certa, e a grade quebra a fileira sozinha se errar
 * para mais.
 */
function bundleListWidth(template: UiScreen | null, viewport: Size | undefined): number {
  const fallback = 476;

  if (template === null || viewport === undefined) {
    return fallback;
  }

  const box = measureSlot(template, SLOTS.pacoteLista, viewport);

  return box === null || box.width < CELL ? fallback : box.width;
}

/**
 * O conteúdo do slot da lista, no modelo desenhado.
 *
 * ####  AS ABAS MORAM DENTRO DO SLOT  ####
 *
 * O modelo tem UM lugar para o conteúdo do pacote, e um VIP que
 * promete vantagens E entrega itens tem dois assuntos. Misturá-los
 * numa lista só faz "fila prioritária" e "500x Sucata" virarem a
 * mesma coisa — foi por isso que o layout embutido ganhou abas.
 *
 * Dar ao modelo um slot próprio para elas obrigaria o admin a
 * desenhar mais uma peça, e quebraria todo documento gravado antes
 * disto. Desenhá-las DENTRO do slot custa 30 px do topo dele e
 * funciona em qualquer layout que já exista.
 *
 * ####  E OS ITENS SÃO UMA GRADE  ####
 *
 * Uma linha de texto por item responde "o que vem". A grade
 * responde isso com o ícone no tamanho em que se reconhece a arma —
 * e o nome, que não cabe numa casinha de 44 px, fica a um clique.
 * Ver `inventoryBlocks` e a aba `item`.
 */
function bundleBody(
  offer: StoreOffer,
  nameOf: NameResolver,
  quantity: number,
  tab: StoreTab,
  page: number,
  height: number,
  width: number,
): UiElement[] {
  const tabbed = offer.perks.length > 0 && offer.items.length > 0;
  const showingItems = offer.items.length > 0 && (!tabbed || tab === 'itens');

  const head = tabbed ? TAB_STRIP : 0;
  const room = height - head;

  // ####  O PAGER COME UMA LINHA, E ELA PRECISA SER DESCONTADA  ####
  //
  // Ele é ancorado na base da área. Paginar pela área INTEIRA e
  // desenhá-lo depois o punha por cima da última linha — duas
  // coisas escritas no mesmo lugar, que é exatamente o defeito que
  // este modal acabou de deixar de ter.
  //
  // Então a conta é feita duas vezes: uma para saber SE pagina, e
  // outra, com uma linha a menos, para saber o que mostrar.
  const rows = perkRows(offer);
  const whole = showingItems ? null : paginateRows(rows, room, page);
  const paged = whole !== null && whole.pages > 1;
  const viewport = paged ? room - LIST_LINE : room;
  const slice = whole === null ? null : paginateRows(rows, viewport, page);

  const body = showingItems
    ? inventoryChildren(offer, nameOf, room, width, quantity)
    : itemRows(slice?.rows ?? [], viewport, 'oz');

  const elements: UiElement[] = [];

  if (tabbed) {
    elements.push(
      ...tabsRow(
        'ozb',
        [
          {
            label: 'GERAL',
            screenId: itemScreenId(offer.id, quantity, 'geral'),
            active: tab !== 'itens',
          },
          {
            label: 'ITENS',
            screenId: itemScreenId(offer.id, quantity, 'itens'),
            active: tab === 'itens',
          },
        ],
        0,
      ),
    );
  }

  elements.push(
    panel(
      'ozbody',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -height },
        offsetMax: { x: 0, y: -head },
      },
      C.none,
      body,
    ),
  );

  // A paginação é das VANTAGENS: elas são texto de tamanho
  // desconhecido. A grade não pagina — ela CONTA o que não coube, e
  // o número aparece dentro dela.
  if (paged && slice !== null) {
    elements.push(
      rowsPager({
        prefix: 'ozb',
        rect: {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 0, y: -height },
          offsetMax: { x: 0, y: -(height - LIST_LINE) },
        },
        page: slice.page,
        pages: slice.pages,
        screenIdOf: (next) => itemScreenId(offer.id, quantity, tab, next),
        // `navigate` fecharia o modal — ver as abas.
        kind: 'modal.open',
      }),
    );
  }

  return elements;
}

/** A altura que a fileira de abas ocupa dentro do slot. */
const TAB_STRIP = 30;

/** As vantagens, como linhas de texto. */
function perkRows(offer: StoreOffer): ContentRow[] {
  return offer.perks.map((text) => ({ text, item: null }));
}

/**
 * Os itens da oferta, na grade.
 *
 * ####  TODOS EM "main", E ISSO É A VERDADE  ####
 *
 * A oferta da loja não guarda contêiner: ela sai pelo
 * `origemz.give` em modo `auto`, que põe tudo no inventário e
 * derruba no chão o que não couber. Desenhá-los na barra rápida
 * seria uma promessa que a entrega não cumpre.
 *
 * O kit, esse sim, tem `slot` por item — e é na tela de kits que a
 * grade mostra os três contêineres. Ver ui-kits-screen.ts.
 */
function inventoryChildren(
  offer: StoreOffer,
  nameOf: NameResolver,
  height: number,
  width: number,
  quantity: number,
): UiElement[] {
  const blocks = inventoryBlocks(
    offer.items.map((item, index) => ({
      index,
      container: 'main' as const,
      // Sem casinha escolhida: elas se acomodam em ordem, e a
      // entrega faz o mesmo.
      position: index,
      itemId: item.itemId,
      skinId: item.skinId,
      amount: item.amount,
      name: nameOf(item.shortname),
    })),
    {
      prefix: 'ozg',
      width,
      height,
      screenIdOf: (entry) => itemScreenId(offer.id, quantity, 'item', entry.index),
    },
  );

  const elements: UiElement[] = [...blocks.elements];

  if (blocks.hidden > 0) {
    elements.push(
      label(
        'ozgmais',
        `e mais ${formatNumber(blocks.hidden)}...`,
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 0, y: 0 },
          offsetMax: { x: 0, y: LIST_LINE },
        },
        { size: 10, color: C.amber, align: 'MiddleLeft' },
      ),
    );
  }

  // O rótulo "MOCHILA" acima de uma grade de itens de LOJA diria uma
  // coisa que não interessa aqui: a compra vai para o inventário de
  // qualquer jeito, e não há outro contêiner com que comparar. Ele é
  // removido em vez de nunca desenhado porque a mesma função serve à
  // tela de kits, onde ele é o ponto.
  return elements.filter((element) => element.id !== 'ozgmaint');
}

/** Só os ITENS, com o ícone de cada um. */
function itemLines(offer: StoreOffer, nameOf: NameResolver): ContentRow[] {
  return offer.items.map((item) => ({
    text:
      item.amount > 1
        ? `${formatNumber(item.amount)}x ${nameOf(item.shortname)}`
        : nameOf(item.shortname),
    item: { itemId: item.itemId, skinId: item.skinId },
  }));
}

function stepper(
  suffix: string,
  glyph: string,
  enabled: boolean,
  screenId: string,
  left: number,
): UiElement {
  const rect: Rect = {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: left, y: -142 },
    offsetMax: { x: left + 28, y: -114 },
  };

  // No limite vira um painel morto, e não um botão que recusa: o
  // clique que não faz nada é o que parece defeito.
  return enabled
    ? button(
        `q${suffix}`,
        glyph,
        rect,
        // `modal.open` e não `navigate`: trocar a quantidade
        // redesenha o MODAL, e a grade continua intacta atrás.
        { id: `aq${suffix}`, kind: 'modal.open', screenId },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 15 },
      )
    : panel(`q${suffix}`, rect, C.bg, [
        label(`q${suffix}l`, glyph, fill(), { size: 15, color: C.border }),
      ]);
}

/** O véu escuro e a caixa no meio. */
function modalFrame(width: number, height: number, children: readonly UiElement[]): UiElement {
  const half = { x: width / 2, y: height / 2 };

  // #000000B3 é o véu do painel — o mesmo valor da paleta do preset.
  // Um alfa diferente aqui seria uma cor "quase igual".
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
        // O CUI não tem borda, então a faixa de acento no topo faz o
        // papel de moldura — como no cabeçalho do menu.
        panel(
          'acc',
          {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 0, y: -2 },
            offsetMax: { x: 0, y: 0 },
          },
          C.rust,
        ),
        ...children,
      ],
    ),
  ]);
}

function closeButton(text: string): UiElement {
  return button(
    'cls',
    text,
    {
      anchorMin: { x: 0, y: 0 },
      anchorMax: { x: 0, y: 0 },
      offsetMin: { x: 22, y: 16 },
      offsetMax: { x: 110, y: 44 },
    },
    { id: 'acls', kind: 'modal.close' },
    { color: '#00000000', textColor: C.textMuted, hoverColor: C.surface2, fontSize: 12 },
  );
}

function header(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 22, y: -46 },
    offsetMax: { x: -22, y: -14 },
  };
}

function emptyState(title: string, message: string, top = 0): UiElement {
  return panel('empty', fill(0, top, 0, 0), '#00000000', [
    label(
      'et',
      title,
      {
        anchorMin: { x: 0, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: 0, y: 4 },
        offsetMax: { x: 0, y: 30 },
      },
      { size: 16, color: C.textMuted },
    ),
    label(
      'em',
      message,
      {
        anchorMin: { x: 0, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: 0, y: -24 },
        offsetMax: { x: 0, y: 0 },
      },
      { size: 12, color: C.border },
    ),
  ]);
}

// ============================================================
//  CONSTRUTORES
//
//  Os mesmos do preset do menu, reescritos aqui porque o core não
//  importa nada do painel. São dez linhas cada; compartilhá-los
//  exigiria um pacote comum para poupar isto.
// ============================================================

type Rect = UiElement['rect'];

function fill(left = 0, top = 0, right = 0, bottom = 0): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    // Y do Unity cresce para CIMA: `bottom` entra no min e `top` sai
    // do max.
    offsetMin: { x: left, y: bottom },
    offsetMax: { x: -right, y: -top },
  };
}

function panel(
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

interface LabelStyle {
  readonly size?: number;
  readonly color?: string;
  readonly align?: Extract<UiElement, { type: 'label' }>['align'];
}

function label(
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
    font: 'RobotoCondensed-Regular.ttf',
    color: style.color ?? C.text,
    align: style.align ?? 'MiddleCenter',
    children,
  };
}

interface ButtonStyle {
  readonly color: string;
  readonly textColor: string;
  readonly hoverColor?: string;
  readonly fontSize?: number;
}

function button(
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
    // Estado ativo é coisa do shell, que não é redesenhado. Aqui a
    // tela inteira é regerada a cada clique, então a cor já vem certa
    // de origem.
    activeColor: null,
    activeTextColor: null,
    activeOnScreenId: null,
    children: [],
  };
}

/**
 * A chave da moeda em `Assets\ui`.
 *
 * Uma constante e não o literal espalhado: trocar o arquivo é mexer
 * aqui, e o nome errado sai como quadrado vazio — sem erro, sem log,
 * em todos os preços de uma vez.
 */
export const COIN_IMAGE_KEY = 'ozcoin';

/**
 * O preço: o número e a moeda ao lado.
 *
 * ####  POR QUE NÃO É SÓ UM TEXTO "100 OZ"  ####
 *
 * A sigla precisa ser aprendida; o desenho da moeda é reconhecido. E
 * como o CUI não tem texto com imagem embutida, são dois elementos
 * que precisam ser posicionados um ao lado do outro À MÃO — não
 * existe layout automático aqui.
 *
 * A largura do texto é ESTIMADA (ver `textWidth`): o agente não tem
 * a fonte para medir. O erro é de alguns pixels e sempre para mais,
 * então a moeda nunca encosta no número.
 */
function priceRow(
  id: string,
  value: string,
  rect: Rect,
  style: { readonly size: number; readonly color: string; readonly align: 'center' | 'right' },
): UiElement {
  // A moeda é redonda: na mesma altura de uma maiúscula ela pareceria
  // menor do que é.
  const icon = style.size + 2;
  const gap = 3;
  const text = textWidth(value, style.size);
  const total = text + gap + icon;

  // Âncora no meio ou na direita do contêiner, e os dois filhos
  // deslocados a partir dela — é o que mantém o par junto quando o
  // card muda de largura.
  const anchor = style.align === 'center' ? 0.5 : 1;
  const start = style.align === 'center' ? -total / 2 : -total;

  return panel(id, rect, '#00000000', [
    label(
      `${id}n`,
      value,
      {
        anchorMin: { x: anchor, y: 0 },
        anchorMax: { x: anchor, y: 1 },
        offsetMin: { x: start, y: 0 },
        offsetMax: { x: start + text, y: 0 },
      },
      { size: style.size, color: style.color, align: 'MiddleRight' },
    ),
    {
      id: `${id}c`,
      name: `${id}c`,
      type: 'image',
      rect: {
        anchorMin: { x: anchor, y: 0.5 },
        anchorMax: { x: anchor, y: 0.5 },
        offsetMin: { x: start + text + gap, y: -icon / 2 },
        offsetMax: { x: start + total, y: icon / 2 },
      },
      source: { kind: 'stored', key: COIN_IMAGE_KEY },
      // Branco: `color` numa imagem TINGE. Qualquer outra cor
      // pintaria a moeda por cima.
      color: C.white,
      children: [],
    },
  ]);
}

/**
 * O ícone da oferta, resolvido pelo CLIENTE a partir do itemId.
 *
 * Vem do campo próprio, e não do item entregue: um kit de dez coisas
 * não tem "o item", e quem escolhe o desenho é o admin.
 */
function itemImage(id: string, offer: StoreOffer, rect: Rect): UiElement {
  return {
    id,
    name: id,
    type: 'image',
    rect,
    source: offerImageSource(offer),
    color: C.white,
    children: [],
  };
}

/**
 * O desenho da oferta: a arte própria, ou o ícone do jogo.
 *
 * ####  O ICONE DO JOGO CONTINUA SENDO O PADRAO  ####
 *
 * Ele não custa download nenhum — o cliente já o tem — e o jogador
 * reconhece a arte. A arte própria existe para o que NÃO é um item:
 * um VIP de 30 dias, um pacote, um kit, que antes pegavam emprestado
 * o ícone de alguma coisa.
 *
 * Quem leva os bytes ao jogo é game/card-icons.ts; aqui sai só o
 * lugar reservado, que o plugin troca pelo CRC na hora de desenhar.
 */
function offerImageSource(offer: StoreOffer): Extract<UiElement, { type: 'image' }>['source'] {
  return offer.icon.file === null
    ? { kind: 'item', itemId: offer.icon.itemId, skinId: offer.icon.skinId }
    : { kind: 'stored', key: storeIconKey(offer.id) };
}

/** O mesmo desenho, na forma que o preenchimento de modelo entende. */
function offerImageSlot(offer: StoreOffer): SlotValue {
  return offer.icon.file === null
    ? { item: { itemId: offer.icon.itemId, skinId: offer.icon.skinId } }
    : { stored: { key: storeIconKey(offer.id) } };
}

/**
 * O título da oferta na grade.
 *
 * Um item solto ganha a quantidade no nome ("Sucata x1000") — sem
 * isso, dois pacotes do mesmo item ficariam com rótulos idênticos.
 * Kit e VIP não: o nome deles já foi escolhido.
 */
function offerTitle(offer: StoreOffer): string {
  if (offer.kind !== 'item') {
    return offer.name;
  }

  const only = offer.items[0];

  return only !== undefined && only.amount > 1
    ? `${offer.name} x${formatNumber(only.amount)}`
    : offer.name;
}

/**
 * O que a oferta entrega, em uma linha.
 *
 * É o subtítulo do modal, e ele muda com o formato: quantas unidades
 * vêm num item, quantos itens tem o kit, quanto tempo dura o VIP.
 */
/**
 * O título da lista, e ele muda com o formato.
 *
 * "O QUE VEM NO KIT" sobre as linhas de um passe seria uma promessa
 * falsa: o que vem é um direito de um mês, e não um pacote de
 * coisas.
 */
function listTitleOf(offer: StoreOffer): string {
  if (offer.kind === 'vip') {
    return 'O QUE VOCÊ GANHA';
  }

  return offer.kind === 'pass' ? 'O PASSE DESTE MÊS' : 'O QUE VEM NO KIT';
}

function offerSummary(offer: StoreOffer, pass: StorePassView | null): string {
  if (offer.kind === 'pass') {
    // ####  "PASSE DE OUTUBRO DE 2026", E NÃO "PASSE DE BATALHA"  ####
    //
    // O mês é o produto. Sem ele no subtítulo, quem compra no dia 1
    // e quem compra no dia 30 leem a mesma frase e compram coisas
    // muito diferentes.
    const period = pass?.period ?? offer.pass?.period ?? null;

    return period === null ? 'Passe de batalha do mês' : `Passe de ${passPeriodLabel(period)}`;
  }

  if (offer.kind === 'vip') {
    const days = offer.vip?.days ?? null;
    const tier = (offer.vip?.tier ?? '').toUpperCase();

    return days === null
      ? `VIP ${tier} vitalício`
      : `VIP ${tier} por ${formatNumber(days)} ${days === 1 ? 'dia' : 'dias'}`;
  }

  if (offer.kind === 'vehicle') {
    const prefab = offer.vehicle?.prefab ?? 'veículo';

    // O que a tela promete é o que a ENTREGA faz, e a entrega troca
    // o zero pelo padrão: "sem combustível" virou mentira no dia em
    // que ele passou a existir.
    const fuel = vehicleFuelOf(offer.vehicle?.fuel ?? 0);

    return `${prefab}, com ${formatNumber(fuel)} de combustível`;
  }

  if (offer.kind === 'bundle') {
    const count = offer.items.length;

    return count === 1 ? '1 item no kit' : `${formatNumber(count)} itens no kit`;
  }

  const only = offer.items[0];
  const amount = only?.amount ?? 1;

  return amount > 1 ? `${formatNumber(amount)} unidades por compra` : 'Uma unidade por compra';
}

// ------------------------------------------------------------
//  Utilidades
// ------------------------------------------------------------

function findOffer(catalog: readonly StoreCatalogEntry[], offerId: string): StoreOffer | null {
  for (const entry of catalog) {
    const found = entry.offers.find((offer) => offer.id === offerId);

    if (found !== undefined) {
      return found;
    }
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Milhar com ponto, como no painel. */
function formatNumber(value: number): string {
  return value.toLocaleString('pt-BR');
}

/**
 * Largura aproximada de um texto, para caixas que se ajustam.
 *
 * O agente não tem a fonte para medir de verdade. 0,55 do corpo por
 * caractere é a média da RobotoCondensed — erra alguns pixels e
 * nunca corta, que é o que importa numa etiqueta.
 */
function textWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.55);
}

/**
 * Uma casinha da grade, aberta.
 *
 * ####  ELA EXISTE PORQUE O CUI NÃO TEM TOOLTIP  ####
 *
 * Não há evento de hover: um `CuiButton` conhece a cor normal e a
 * de mouse em cima, e nada mais. O nome de um item não cabe numa
 * casinha de 44 px, e escrevê-lo sob cada uma transformaria a grade
 * numa parede de texto.
 *
 * Então a casinha clica. É um clique a mais que um tooltip, e em
 * troca cabe o nome inteiro e a quantidade exata.
 */
function offerItemDetail(
  offer: StoreOffer,
  nameOf: NameResolver,
  target: Extract<StoreScreenTarget, { kind: 'item' }>,
): UiElement[] {
  const index = target.page ?? 0;
  const item = offer.items[index];

  const back = button(
    'ozdv',
    '‹ VOLTAR',
    {
      anchorMin: { x: 1, y: 0 },
      anchorMax: { x: 1, y: 0 },
      offsetMin: { x: -150, y: 16 },
      offsetMax: { x: -22, y: 44 },
    },
    {
      id: 'aozdv',
      kind: 'modal.open',
      screenId: itemScreenId(offer.id, target.quantity, 'itens'),
    },
    { color: C.surface2, textColor: C.text, hoverColor: C.border, fontSize: 12 },
  );

  // O admin mexeu na oferta enquanto o modal estava aberto. Voltar
  // para a grade é melhor que um modal vazio.
  if (item === undefined) {
    return [
      label('ozdt', 'Item indisponível', header(), { size: 15 }),
      label('ozdm', 'Este item saiu da oferta.', fill(22, 60, 22, 60), {
        size: 12,
        color: C.textMuted,
      }),
      back,
      closeButton('FECHAR'),
    ];
  }

  const body: UiElement[] = [
    label('ozdt', nameOf(item.shortname), header(), { size: 15 }),

    gameItemImage('ozdi', item, {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 0, y: 1 },
      offsetMin: { x: 22, y: -150 },
      offsetMax: { x: 110, y: -62 },
    }),

    label(
      'ozdq',
      'QUANTIDADE',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 128, y: -76 },
        offsetMax: { x: -22, y: -62 },
      },
      { size: 10, color: C.textMuted, align: 'MiddleLeft' },
    ),

    styledLabel(
      'ozdqv',
      // A quantidade do PACOTE já multiplicada: quem comprou dois
      // pacotes de 128 balas recebe 256, e é esse o número que
      // interessa aqui.
      formatNumber(item.amount * target.quantity),
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 128, y: -98 },
        offsetMax: { x: -22, y: -78 },
      },
      { size: 14, align: 'MiddleLeft', font: 'RobotoCondensed-Bold.ttf' },
    ),

    label(
      'ozdw',
      'Vai para o seu inventário.',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 128, y: -124 },
        offsetMax: { x: -22, y: -106 },
      },
      { size: 11, color: C.textMuted, align: 'MiddleLeft' },
    ),
  ];

  if (item.skinId !== '0' && item.skinId !== '') {
    body.push(
      label('ozdsk', `Skin ${item.skinId}`, fill(22, 166, 22, 60), {
        size: 10,
        color: C.textMuted,
        align: 'MiddleLeft',
      }),
    );
  }

  body.push(back, closeButton('FECHAR'));

  return body;
}
