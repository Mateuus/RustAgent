// ============================================================
//  ui-kits-screen.ts  -  a página KITS, montada do banco.
//
//  ####  POR QUE ESTA TELA NÃO É DESENHADA NO EDITOR  ####
//
//  As outras páginas do menu são desenho: o que está lá é o que
//  alguém pôs. Esta é uma VITRINE que muda sem ninguém abrir o
//  editor — o admin cria um kit no painel e ele precisa aparecer no
//  jogo — e que depende de QUEM está olhando: o mesmo kit é
//  "RESGATAR" para um e "EM 2 H" para outro.
//
//  Então o documento guarda só o ENDEREÇO (a tela `tela-kits`) e o
//  agente monta o conteúdo na hora do clique.
//
//  ####  ELA É UMA GRADE, COMO A LOJA  ####
//
//  E pela mesma razão: o ícone do que vem dentro é o que se
//  reconhece antes de ler. Uma lista de linhas cabe mais nomes na
//  tela e não mostra item nenhum — e "Kit Inicial · 1 item" não diz
//  QUAL item.
//
//  Os construtores vêm de ui-widgets.ts, compartilhados com a loja:
//  duas cópias divergem no primeiro ajuste, e foi assim que esta
//  tela ficou em lista enquanto a outra virou grade.
//
//  ####  ELA NUNCA É GUARDADA EM CACHE  ####
//
//  `volatile: true` no pacote. Um kit de cooldown mostra "EM 2 H" —
//  em cache, ele mostraria as duas horas para sempre, e o jogador
//  clicaria confiando naquilo.
//
//  ------------------------------------------------------------
//  ####  O BOTÃO CARREGA O SLUG, E NADA MAIS  ####
//
//  A ação é `store.buy` com `offerId` = o slug do kit. Ela chega ao
//  agente pelo `#OZBUY#`, com o SteamID vindo da conexão que clicou
//  — nunca de um argumento. Quem decide se aquele jogador pode pegar
//  é o `KitStore`, lendo o banco: o clique não carrega preço,
//  quantidade nem permissão.
// ============================================================

import type { KitOfferView } from '../kits/service.js';
import { kitIconKey } from './card-icons.js';
import type { UiElement, UiScreen } from '../types/ui-document.js';

import {
  CONTAINER_LABEL,
  inventoryBlocks,
  type InventoryEntry,
} from './ui-inventory.js';
import {
  button,
  C,
  deadButton,
  describeWait,
  fill,
  formatNumber,
  formatWhen,
  itemImage,
  itemRows,
  label,
  modalFrame,
  modalHeader,
  paginateRows,
  panel,
  rowsPager,
  storedImage,
  tabsRow,
  titleBar,
  type ContentRow,
  type Rect,
} from './ui-widgets.js';

/**
 * O id da tela de kits no documento.
 *
 * FIXO, e não sorteado: é por ele que o agente reconhece a tela cujo
 * conteúdo ele mesmo monta. Precisa bater com o preset — ver
 * game/ui-preset-main-menu.ts.
 */
export const KITS_SCREEN_ID = 'tela-kits';

/** O modal de detalhes. `ozkit:<slug>` ou `ozkit:<slug>:itens`. */
export const KIT_INFO_PREFIX = 'ozkit';

/** A grade, igual à da loja. Ver ui-store-screens.ts. */
const GRID = {
  columns: 4,
  gap: 10,
  /**
   * 240, e não 160.
   *
   * ####  A ALTURA ESTAVA SOBRANDO, E O CARD ERA APERTADO  ####
   *
   * A área da grade tem ~516 px. Duas fileiras de 160 usavam 330 e
   * deixavam 186 de vazio embaixo — enquanto o ícone do kit cabia em
   * 58 px e o nome disputava espaço com a regra e o botão.
   *
   * Duas de 240 usam 490. O ícone dobrou, o nome ganhou faixa
   * própria, e o rodapé comporta duas ações lado a lado.
   *
   * ####  E POR QUE NÃO TRÊS FILEIRAS  ####
   *
   * Cabiam: 3 x 162 = 506. Mas cada card custa ~3.100 bytes no CUI
   * (oito elementos, e o CUI repete `name`, `parent` e o
   * `RectTransform` inteiro em cada um). MEDIDO: doze cards mais a
   * coluna dão 41.756 bytes, 84% do frame de 50.000 do RCON.
   *
   * Oito dão ~28.000 — 56%. A margem importa porque o nome do kit é
   * do admin, e um mural de nomes longos empurra o número para cima
   * sem ninguém mexer em código.
   */
  cardHeight: 240,
  rows: 2,
} as const;

/**
 * A coluna de categorias, à esquerda.
 *
 * ####  ELA ERA UMA FILEIRA DE ABAS, E A FILEIRA NÃO CRESCE  ####
 *
 * As categorias ficavam numa faixa horizontal sob o título, cada
 * uma com a largura do próprio nome. Funcionava com três; com
 * sete, a última saía pela borda da tela — e saía em silêncio, sem
 * seta, sem reticências, sem nada dizendo que existia mais.
 *
 * A coluna cresce para BAIXO, que é a direção em que há espaço, e
 * é o mesmo desenho que o ranking já usa para a mesma pergunta
 * ("qual destes eu quero ver?"). Duas telas do mesmo menu
 * respondendo isso de dois jeitos diferentes é o tipo de diferença
 * que ninguém explica depois.
 *
 * A largura sai do mesmo raciocínio da coluna do ranking: 190 px
 * comportam ~25 caracteres no corpo 12, e nome de categoria maior
 * que isso já não cabia na fileira antiga também.
 */
const SIDEBAR = {
  width: 190,
  /** O respiro entre a coluna e a grade. */
  gap: 16,
  /** A altura de um item. Alvo de clique confortável, e não mais. */
  item: 32,
} as const;

/**
 * A altura útil da coluna, estimada.
 *
 * ####  ESTIMADA, E O ERRO É PARA O LADO SEGURO  ####
 *
 * A altura real é a do slot de conteúdo do shell, que esta função
 * não conhece — ela desenha uma tela, e quem a encaixa é o
 * documento. 516 px é o que sobra numa tela de 720 com o cabeçalho
 * de 76 e as margens de 30 do preset.
 *
 * Errar para MENOS deixa uma categoria de fora com um "e mais 1..."
 * visível. Errar para mais a desenharia fora da tela, em silêncio —
 * que é exatamente o defeito da fileira de abas que esta coluna
 * substituiu.
 */
const SIDEBAR_HEIGHT = 516;

const PER_PAGE = GRID.columns * GRID.rows;

/**
 * O que fica onde DENTRO do card.
 *
 * ####  O NOME SUBIU PARA UMA FAIXA PRÓPRIA  ####
 *
 * Ele ficava sob o ícone, na mesma cor de fundo do resto — nome,
 * regra e botão empilhados sem nada separando. Num mural de doze
 * cards iguais, o olho não tinha onde pousar primeiro.
 *
 * Agora ele é uma FAIXA, no topo, com fundo próprio: é a primeira
 * coisa que se lê em cada card, e é o que se procura quando se
 * varre a tela atrás de um kit pelo nome.
 *
 * ####  E O ACENTO DIZ O ESTADO ANTES DA LEITURA  ####
 *
 * Dois pixels de cor no topo do card. Verde = dá para pegar;
 * vermelho = não; âmbar = espera. À distância de um olhar isso
 * responde "o que está disponível agora?" sem ler doze rodapés.
 */
const CARD = {
  /** A barra de estado, colada no topo. */
  accent: 3,
  /** A margem interna. */
  pad: 12,
  /**
   * A faixa do nome, no TOPO.
   *
   * ####  ELA SAIU UMA VEZ, E O CARD PIOROU  ####
   *
   * O conceito de 14/09/2026 alinha o cabeçalho do cartão à
   * esquerda, com um ícone pequeno numa moldura. Copiei isso aqui e
   * ficou ruim por duas razões que só aparecem NESTA tela:
   *
   *   1. o kit tem ARTE PRÓPRIA — o admin sobe um PNG por kit — e
   *      ela é o que identifica o kit à distância. Reduzida a 64 px
   *      e encostada num canto, ela deixa de ser a figura do kit e
   *      vira um selo;
   *   2. o card ficou SEM CONTRASTE. Ele é `--surface`, e a moldura
   *      do menu também: era a faixa do nome, em `--surface-2`, que
   *      dava a ele uma borda visível. Sem ela, oito cards sumiram
   *      no fundo.
   *
   * O conceito tem razão para os cartões DELE, que não têm arte
   * própria e vivem sobre um fundo mais escuro. Aqui o desenho
   * certo é o de antes: nome em faixa no topo, arte grande no meio.
   */
  nameTop: 3,
  nameBottom: 31,
  iconTop: 50,
  iconBottom: 166,
  ruleTop: 174,
  ruleBottom: 192,
  /** A linha em âmbar, quando o kit exige VIP. */
  tierTop: 194,
  tierBottom: 210,
  buttonBottom: 10,
  buttonTop: 40,
  /** A largura do botão que abre os detalhes, no rodapé. */
  peek: 50,
} as const;

/**
 * O modal de um kit.
 *
 * ####  ELE CRESCEU PARA CABER UM INVENTÁRIO  ####
 *
 * Era 440x330, e isso bastava enquanto a aba ITENS era uma lista de
 * texto. Ela deixou de ser: agora é a GRADE do jogo, e uma grade tem
 * uma largura que não se negocia — a vestimenta são sete casinhas
 * lado a lado, e sete de 44 pedem 320 px antes das margens.
 *
 * A altura veio junto porque um kit completo desenha três
 * contêineres empilhados, e recortá-los pela metade devolveria o
 * problema que a grade existe para resolver: o jogador não saberia
 * onde o resto cai.
 */
const KIT_MODAL = { width: 520, height: 440 } as const;

/** Onde a área da lista começa, no modal — logo abaixo das abas. */
const LIST_TOP = 84;

/**
 * A altura da área da lista, no modal.
 *
 * Sai da caixa, e não de um número solto: o rodapé reserva 60 (os
 * botões a 16 do fundo, mais 28 de altura, mais ar) e o pager mais
 * 24. O que sobra é da lista.
 */
const LIST_VIEWPORT = KIT_MODAL.height - LIST_TOP - 60 - 24;

/** A faixa do "‹ 1 / 2 ›", entre a lista e o rodapé do modal. */
const LIST_PAGER = { top: LIST_TOP + LIST_VIEWPORT + 2, height: 22 } as const;

// ------------------------------------------------------------
//  O ENDEREÇO
// ------------------------------------------------------------

/**
 * O que o modal de um kit mostra.
 *
 *   geral      a regra, e o que já houve entre ele e este kit
 *   itens      o que vem dentro, na grade do inventário
 *   item       o detalhe de UM item da grade
 *   confirmar  a última parada antes de gastar o resgate
 *
 * ####  "item" USA A PÁGINA COMO ÍNDICE  ####
 *
 * `ozkit:kit-x:item:3` é o detalhe do quarto item. Seria mais
 * explícito um campo próprio, e custaria um quinto pedaço no id —
 * que o parser, o gerador e o plugin teriam de aprender juntos. A
 * página já é um número livre nessa posição, e numa aba que mostra
 * UM item não há o que paginar.
 */
export type KitTab = 'geral' | 'itens' | 'item' | 'confirmar';

/** O grupo dos kits SEM categoria. Ver `categorySlug`. */
export const NO_CATEGORY = '-';

export type KitScreenTarget =
  | { readonly kind: 'grid'; readonly category: string | null; readonly page: number }
  | {
      readonly kind: 'info';
      readonly slug: string;
      readonly tab: KitTab;
      /** A página DA LISTA daquela aba. Ausente = a primeira. */
      readonly page?: number;
    };

/**
 * Lê o id da tela. `null` = não é uma tela de kits.
 *
 *     tela-kits            a primeira categoria, primeira página
 *     tela-kits:vip        aquela categoria
 *     tela-kits:vip:1      a segunda página dela
 *     ozkit:kit-x          o modal daquele kit
 *     ozkit:kit-x:itens    a aba de itens dele
 *     ozkit:kit-x:itens:1  a segunda página da lista dela
 *
 * Tudo o que vier fora do esperado é APARADO para algo válido em vez
 * de recusado: o pedido veio do plugin, e o jogador está com um aviso
 * de carregando na tela.
 */
export function parseKitScreenId(screenId: string): KitScreenTarget | null {
  const parts = screenId.split(':');
  const head = parts[0];

  if (head === KITS_SCREEN_ID) {
    const category = parts[1] ?? '';

    return {
      kind: 'grid',
      category: category === '' ? null : category,
      page: Math.max(0, Number.parseInt(parts[2] ?? '0', 10) || 0),
    };
  }

  if (head === KIT_INFO_PREFIX) {
    const slug = parts[1] ?? '';

    if (slug === '') {
      return null;
    }

    const tab = parts[2];

    return {
      kind: 'info',
      slug,
      tab: tab === 'itens' || tab === 'confirmar' || tab === 'item' ? tab : 'geral',
      page: Math.max(0, Number.parseInt(parts[3] ?? '0', 10) || 0),
    };
  }

  return null;
}

/**
 * O endereço do modal daquele kit.
 *
 * A primeira página não vai no id: `ozkit:kit-x:itens` continua sendo
 * o mesmo endereço de sempre, e só quem virou a página carrega o
 * número.
 */
export function kitInfoScreenId(slug: string, tab: KitTab = 'geral', page = 0): string {
  // ####  NA ABA "item" O ZERO É CONTEÚDO, E NÃO O PADRÃO  ####
  //
  // Ali o número não é a página: é QUAL item. Omiti-lo por ser zero
  // mandava o primeiro item da grade para `ozkit:kit-x:item`, que o
  // parser lê como índice 0 por sorte — e o botão do primeiro item
  // ficava com um endereço diferente em forma do dos outros doze.
  // Basta alguém passar a tratar a ausência como "nenhum" para o
  // primeiro item parar de abrir.
  if (page > 0 || tab === 'item') {
    return `${KIT_INFO_PREFIX}:${slug}:${tab}:${String(page)}`;
  }

  return tab === 'geral' ? `${KIT_INFO_PREFIX}:${slug}` : `${KIT_INFO_PREFIX}:${slug}:${tab}`;
}

/**
 * O nome da categoria vira um pedaço de endereço.
 *
 * ####  POR QUE NÃO O NOME CRU, E NÃO O ÍNDICE  ####
 *
 * O nome cru levaria acento e espaço para dentro de um id que viaja
 * em JSON e é comparado como string pelo plugin — funciona, e quebra
 * no dia em que alguém puser `:` no nome da categoria.
 *
 * O índice ("a segunda aba") quebraria sozinho: basta o admin criar
 * uma categoria nova e o endereço de ontem passa a apontar para
 * outra.
 *
 * O slug é estável enquanto o NOME for o mesmo, que é exatamente a
 * garantia que se quer.
 */
export function categorySlug(category: string | null): string {
  if (category === null) {
    return NO_CATEGORY;
  }

  const clean = category
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return clean === '' ? NO_CATEGORY : clean;
}

/**
 * O nome bonito e o ícone de um item, a partir do shortname.
 *
 * ####  POR QUE ISTO É INJETADO  ####
 *
 * O kit guarda `rifle.ak`, que é o que a entrega exige. O CUI
 * precisa do `itemId` para desenhar o ícone, e quem lê quer "Assault
 * Rifle" — as duas coisas moram no catálogo de itens, que este
 * módulo não conhece (e nem deveria: ele desenha telas).
 *
 * `null` = catálogo ainda não lido. Aí a lista mostra o shortname e
 * fica sem ícone — feio, e nunca vazio.
 */
export type ItemLookup = (
  shortname: string,
) => { readonly itemId: number; readonly displayName: string } | null;

export interface BuildKitsScreenOptions {
  readonly offers: readonly KitOfferView[];
  readonly target: KitScreenTarget;
  /** O id EXATO que foi pedido. Ver ui-store-screens.ts. */
  readonly screenId?: string;
  readonly itemOf?: ItemLookup;
}

export function buildKitsScreen(options: BuildKitsScreenOptions): UiScreen {
  const itemOf = options.itemOf ?? ((): null => null);

  return options.target.kind === 'grid'
    ? buildGrid(options.offers, options.target, itemOf, options.screenId)
    : buildInfo(options.offers, options.target, itemOf);
}

/** As categorias que existem, na ordem em que aparecem. */
function categoriesOf(
  offers: readonly KitOfferView[],
): readonly { readonly slug: string; readonly name: string }[] {
  const seen = new Map<string, string>();

  for (const kit of offers) {
    const slug = categorySlug(kit.category);

    if (!seen.has(slug)) {
      seen.set(slug, kit.category ?? 'GERAL');
    }
  }

  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

// ============================================================
//  A GRADE
// ============================================================

function buildGrid(
  offers: readonly KitOfferView[],
  target: Extract<KitScreenTarget, { kind: 'grid' }>,
  itemOf: ItemLookup,
  screenId?: string,
): UiScreen {
  const id = screenId ?? KITS_SCREEN_ID;

  const elements: UiElement[] = [
    ...titleBar('kits', 'KITS', { subtitle: 'O que a rede entrega, e a regra de cada um.' }),
  ];

  if (offers.length === 0) {
    elements.push(
      panel('kits-vazio', fill(0, 42, 0, 0), C.surface, [
        label('kits-vazio-texto', 'Nenhum kit disponível neste servidor.', fill(20, 20, 20, 20), {
          color: C.textMuted,
        }),
      ]),
    );

    return { id, name: 'KITS', kind: 'page', elements };
  }

  // ####  A BARRA SÓ APARECE COM MAIS DE UMA CATEGORIA  ####
  //
  // Com uma só, ela seria uma aba solitária ocupando trinta pixels
  // para dizer o que a tela toda já diz.
  const categories = categoriesOf(offers);
  const grouped = categories.length > 1;
  const active =
    categories.find((entry) => entry.slug === target.category) ?? categories[0] ?? null;

  const shown =
    grouped && active !== null
      ? offers.filter((kit) => categorySlug(kit.category) === active.slug)
      : offers;

  const top = 42;

  if (grouped) {
    elements.push(...sidebar(categories, active));
  }

  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const current = Math.min(target.page, pages - 1);
  const slice = shown.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);

  elements.push(
    panel(
      'kits-grade',
      // A grade encolhe pela ESQUERDA quando há coluna. Os cards
      // são ancorados em fração do pai (ver `kitCard`), então eles
      // se reacomodam sozinhos — nenhuma medida de card muda aqui.
      fill(grouped ? SIDEBAR.width + SIDEBAR.gap : 0, top, 0, 26),
      C.none,
      slice.map((kit, index) =>
        kitCard(kit, index % GRID.columns, Math.floor(index / GRID.columns), itemOf),
      ),
    ),
  );

  // Sem isto, o nono kit sumiria sem nada na tela dizer que ele
  // existe — a pior forma de perder conteúdo, porque ninguém percebe.
  if (pages > 1) {
    elements.push(...pager(active?.slug ?? NO_CATEGORY, current, pages));
  }

  return { id, name: 'KITS', kind: 'page', elements };
}

/** O endereço de uma página da grade. */
export function gridScreenId(category: string, page: number): string {
  return page === 0
    ? `${KITS_SCREEN_ID}:${category}`
    : `${KITS_SCREEN_ID}:${category}:${String(page)}`;
}

function topBarRect(height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -height },
    offsetMax: { x: 0, y: 0 },
  };
}

function pager(category: string, page: number, pages: number): UiElement[] {
  const target = (next: number): string => gridScreenId(category, next);

  const elements: UiElement[] = [
    label(
      'kits-pgn',
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

  // Nas pontas o botão SOME, em vez de ficar apagado: um botão
  // visível que não faz nada é indistinguível de um menu travado.
  if (page > 0) {
    elements.push(
      button(
        'kits-pgp',
        '‹',
        {
          anchorMin: { x: 0.5, y: 0 },
          anchorMax: { x: 0.5, y: 0 },
          offsetMin: { x: -64, y: 0 },
          offsetMax: { x: -34, y: 22 },
        },
        { id: 'akitspgp', kind: 'navigate', screenId: target(page - 1) },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 14 },
      ),
    );
  }

  if (page < pages - 1) {
    elements.push(
      button(
        'kits-pgx',
        '›',
        {
          anchorMin: { x: 0.5, y: 0 },
          anchorMax: { x: 0.5, y: 0 },
          offsetMin: { x: 34, y: 0 },
          offsetMax: { x: 64, y: 22 },
        },
        { id: 'akitspgx', kind: 'navigate', screenId: target(page + 1) },
        { color: C.surface2, textColor: C.text, hoverColor: C.rust, fontSize: 14 },
      ),
    );
  }

  return elements;
}

/**
 * A coluna de categorias.
 *
 * ####  O ATIVO É PAINEL; OS OUTROS SÃO BOTÃO  ####
 *
 * Clicar no que já está aberto navegaria para onde já se está — um
 * clique que não faz nada, que é o que parece defeito. É a mesma
 * regra das abas dos modais e da coluna do ranking.
 *
 * ####  E ELES `navigate`, E NÃO `modal.open`  ####
 *
 * Esta é uma PÁGINA. `modal.open` abriria a tela de kits por cima
 * da tela de kits, empilhando um modal a cada troca de categoria.
 */
function sidebar(
  categories: readonly { readonly slug: string; readonly name: string }[],
  active: { readonly slug: string; readonly name: string } | null,
): UiElement[] {
  // ####  QUANTAS CABEM  ####
  //
  // A área útil vai de 42 (sob o título) até 26 do fundo (o pager).
  // Numa tela de 720 com o cabeçalho e as margens do shell, sobram
  // ~516 px — dezesseis categorias. Passar disso é improvável, e
  // "improvável" não é o mesmo que "impossível": o que não couber é
  // CONTADO, como em todo o resto deste menu.
  const room = Math.max(1, Math.floor((SIDEBAR_HEIGHT - SIDEBAR.item) / SIDEBAR.item));
  const visible = categories.length > room ? categories.slice(0, room) : categories;
  const rest = categories.length - visible.length;

  const items: UiElement[] = [];

  for (const [index, entry] of visible.entries()) {
    const id = `kcat${entry.slug}`;
    const text = entry.name.toUpperCase();
    const isActive = active !== null && entry.slug === active.slug;

    const rect: Rect = {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 1, y: 1 },
      offsetMin: { x: 0, y: -((index + 1) * SIDEBAR.item) },
      offsetMax: { x: 0, y: -(index * SIDEBAR.item) },
    };

    if (isActive) {
      items.push(
        // Mais ESCURO que a coluna, e não mais claro: sobre fundo
        // escuro o buraco lê como "aberto", e a barra vermelha diz
        // qual é. Clarear seria o mesmo efeito do hover, e aí o
        // item aberto e o item sob o cursor pareceriam iguais.
        panel(id, rect, C.bg, [
          panel(`${id}b`, accentRect(), C.rust),
          label(`${id}l`, text, fill(14, 0, 10, 0), {
            size: 12,
            align: 'MiddleLeft',
            font: 'RobotoCondensed-Bold.ttf',
          }),
        ]),
      );

      continue;
    }

    items.push(
      button(
        id,
        text,
        // O retângulo começa onde o texto do ativo começa: o texto
        // de um `CuiButton` preenche o botão inteiro, e não há
        // margem interna para dar. Recuado, o rótulo cai sob o do
        // item aberto, e a coluna se lê de cima para baixo.
        { ...rect, offsetMin: { x: 14, y: rect.offsetMin.y } },
        { id: `a${id}`, kind: 'navigate', screenId: gridScreenId(entry.slug, 0) },
        {
          color: C.none,
          textColor: C.textMuted,
          hoverColor: C.surface2,
          fontSize: 12,
          align: 'MiddleLeft',
        },
      ),
    );
  }

  if (rest > 0) {
    items.push(
      label(
        'kcatmais',
        `e mais ${String(rest)}...`,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 14, y: -((visible.length + 1) * SIDEBAR.item) },
          offsetMax: { x: 0, y: -(visible.length * SIDEBAR.item) },
        },
        { size: 11, color: C.amber, align: 'MiddleLeft' },
      ),
    );
  }

  return [
    // ####  O FUNDO DA COLUNA É A DIVISÓRIA  ####
    //
    // Pintar a coluna faz o trabalho de uma régua de 1 px ao lado
    // com UM elemento a menos — e num documento cujo teto é o frame
    // do RCON, cada elemento a menos é espaço para um card a mais.
    panel(
      'kits-col',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: 0, y: 26 },
        offsetMax: { x: SIDEBAR.width, y: -42 },
      },
      C.surface2,
      items,
    ),
  ];
}

/** A barra de acento do item aberto, colada na borda esquerda. */
function accentRect(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 3 },
    offsetMax: { x: 3, y: -3 },
  };
}

function kitCard(kit: KitOfferView, column: number, row: number, itemOf: ItemLookup): UiElement {
  const columnWidth = 1 / GRID.columns;
  const half = GRID.gap / 2;
  const y = row * (GRID.cardHeight + GRID.gap);
  const id = `k${kit.slug}`;

  const first = kit.items[0];
  const icon = first === undefined ? null : itemOf(first.shortname);

  // A arte do kit, grande e no meio. Ela é o que identifica o kit à
  // distância — ver `CARD`.
  const iconRect: Rect = {
    anchorMin: { x: 0.5, y: 1 },
    anchorMax: { x: 0.5, y: 1 },
    offsetMin: { x: -58, y: -CARD.iconBottom },
    offsetMax: { x: 58, y: -CARD.iconTop },
  };

  const children: UiElement[] = [
    // ####  A BARRA DE ESTADO  ####
    //
    // Dois pixels no topo. É o que responde "o que dá para pegar
    // agora?" num mural de doze cards, sem ler doze rodapés.
    panel(`${id}-a`, topBarRect(CARD.accent), accentColor(kit)),

    // ####  A FAIXA DO NOME  ####
    //
    // Ela é a primeira coisa que se lê em cada card — e é também o
    // que dá ao card uma borda visível contra a moldura do menu,
    // que é da mesma cor dele. Ver `CARD`.
    panel(
      `${id}-nb`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -CARD.nameBottom },
        offsetMax: { x: 0, y: -CARD.nameTop },
      },
      C.bg,
      [
        label(`${id}-n`, kit.name, fill(10, 0, 10, 0), {
          size: 13,
          color: C.text,
          align: 'MiddleLeft',
          font: 'RobotoCondensed-Bold.ttf',
        }),
      ],
    ),

    // ####  A ARTE PRÓPRIA GANHA DO PALPITE  ####
    //
    // Sem ela, o card mostra o PRIMEIRO item do kit — um palpite
    // honesto (um kit de sucata mostra sucata) e o que todo kit
    // gravado antes disto continua fazendo. Mas "Kit Inicial" não é
    // uma pedra, e quem monta o kit sabe que arte o representa.
    //
    // Quem leva os bytes ao jogo é game/card-icons.ts; aqui sai só o
    // lugar reservado, que o plugin troca pelo CRC ao desenhar.
    kit.iconFile !== null
      ? storedImage(`${id}-i`, kitIconKey(kit.slug), iconRect)
      : icon === null
        ? // Sem catálogo lido não há itemId, e sem itemId não há
          // ícone. Um retângulo vazio é honesto: ele não finge ser um
          // item que não sabemos qual é.
          panel(`${id}-i`, iconRect, C.surface2)
        : itemImage(`${id}-i`, { itemId: icon.itemId, skinId: first?.skinId ?? '0' }, iconRect),

    label(
      `${id}-r`,
      `${String(kit.items.length)} ${kit.items.length === 1 ? 'item' : 'itens'} · ${ruleOf(kit)}`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: CARD.pad, y: -CARD.ruleBottom },
        offsetMax: { x: -CARD.pad, y: -CARD.ruleTop },
      },
      { size: 11, color: C.textMuted },
    ),

    // ####  "VER" ABRE O QUE NÃO CABE NO CARD  ####
    //
    // A grade do que vem dentro, quando ele pegou pela última vez e
    // quantas vezes já pegou. Num card de 162 px isso não entra — e
    // sem isso o jogador clica em RESGATAR para descobrir o que
    // ganha, o que num resgate único não dá para desfazer.
    //
    // Ele era um "i" de 20 px flutuando no canto superior, sobre o
    // nada. Aqui está no RODAPÉ, ao lado da ação, com o tamanho de
    // um alvo de clique — o mesmo arranjo de qualquer card que
    // ofereça "olhar" e "fazer".
    button(
      `${id}-info`,
      'VER',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 8, y: CARD.buttonBottom },
        offsetMax: { x: 8 + CARD.peek, y: CARD.buttonTop },
      },
      { id: `a${id}info`, kind: 'modal.open', screenId: kitInfoScreenId(kit.slug) },
      { color: C.surface2, textColor: C.textMuted, hoverColor: C.border, fontSize: 11 },
    ),
  ];

  const tier = tierLineOf(kit);

  if (tier !== null) {
    children.push(
      label(
        `${id}-t`,
        tier,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: CARD.pad, y: -CARD.tierBottom },
          offsetMax: { x: -CARD.pad, y: -CARD.tierTop },
        },
        { size: 11, color: C.amber, font: 'RobotoCondensed-Bold.ttf' },
      ),
    );
  }

  const buttonRect: Rect = {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: 8 + CARD.peek + 4, y: CARD.buttonBottom },
    offsetMax: { x: -8, y: CARD.buttonTop },
  };

  children.push(
    kit.available
      ? button(
          `${id}-b`,
          'RESGATAR',
          buttonRect,
          // ####  O CARD NÃO RESGATA: ELE PERGUNTA  ####
          //
          // Um resgate único é irreversível, e o botão fica a um
          // clique de distância num card pequeno, ao lado de outros
          // sete. A confirmação é a diferença entre "peguei o que
          // queria" e "gastei minha única chance sem querer".
          { id: `pedir-${kit.slug}`, kind: 'modal.open', screenId: kitInfoScreenId(kit.slug, 'confirmar') },
          { color: C.rust, textColor: C.white, hoverColor: '#D4553FFF', fontSize: 12 },
        )
      : // ####  QUEM NÃO PODE PEGAR VÊ O MOTIVO, NÃO UM BOTÃO MORTO  ####
        //
        // E o motivo é CURTO, montado aqui: a frase do `KitStore` traz
        // o nome do kit e o SteamID porque serve ao painel e ao
        // suporte. Num card de 160px ela não cabe — e não coube mesmo:
        // no jogo ela apareceu cortada no meio.
        deadButton(`${id}-b`, shortReason(kit), buttonRect, stateColor(kit)),
  );

  return panel(
    `${id}-c`,
    {
      anchorMin: { x: columnWidth * column, y: 1 },
      anchorMax: { x: columnWidth * (column + 1), y: 1 },
      offsetMin: { x: column === 0 ? 0 : half, y: -(y + GRID.cardHeight) },
      offsetMax: { x: column === GRID.columns - 1 ? 0 : -half, y: -y },
    },
    // ####  `--surface-2`, E NÃO `--surface`  ####
    //
    // A moldura do menu é `--surface` (ver o preset). Um card da
    // mesma cor não tem borda contra ela — e o CUI não tem borda de
    // verdade para dar. Um tom acima é o que o separa do fundo, que
    // é o mesmo recurso que a coluna de categorias já usa.
    C.surface2,
    children,
  );
}

/**
 * A regra do kit, em três palavras.
 *
 * É o que decide se vale a pena olhar — e ela precisa estar no CARD,
 * não escondida atrás do "i".
 */
function ruleOf(kit: KitOfferView): string {
  // ####  O NÍVEL SAIU DAQUI  ####
  //
  // Ele vinha grudado no fim ("uma vez · SÓ VIP OURO"), e as duas
  // coisas competiam pela mesma linha em corpo 10. São perguntas
  // diferentes — "com que frequência?" e "posso?" — e a segunda é a
  // que faz alguém parar de olhar. Ela virou uma linha própria, em
  // âmbar: ver `tierLineOf`.
  if (kit.kind === 'cooldown') {
    return `a cada ${describeWait((kit.cooldownSeconds ?? 0) * 1000)}`;
  }

  const limit = kit.useLimit ?? 1;

  if (limit === 1) {
    return `uma vez${kit.useResetOn === 'never' ? '' : ' por wipe'}`;
  }

  return `${String(limit)} usos${kit.useResetOn === 'never' ? '' : ' por wipe'}`;
}

/**
 * A exigência de VIP, quando existe.
 *
 * ####  "EXCLUSIVO" E "EXIGE" DIZEM COISAS DIFERENTES  ####
 *
 * `requiredTierExact` quer dizer AQUELE nível e nenhum outro — quem
 * está acima também é recusado, e é justamente ele quem clica no
 * kit de baixo achando que o nível melhor dá acesso a tudo.
 *
 * Em âmbar porque é a cor do que é premium na paleta, a mesma do
 * OZCoin. É a única linha colorida do card, e é a que decide se
 * vale continuar olhando.
 */
function tierLineOf(kit: KitOfferView): string | null {
  if (kit.requiredTier === null) {
    return null;
  }

  const tier = kit.requiredTier.toUpperCase();

  return kit.requiredTierExact ? `EXCLUSIVO VIP ${tier}` : `EXIGE VIP ${tier}`;
}

/**
 * Por que não dá para pegar AGORA, em duas palavras.
 *
 * O `reason` do `KitStore` é a frase do painel: ela nomeia o kit e o
 * jogador porque quem a lê está no suporte. Aqui o nome do kit está
 * logo acima e o jogador é quem está olhando — o que falta é só o
 * QUANTO FALTA.
 */
function shortReason(kit: KitOfferView): string {
  if (!kit.enabled) {
    return 'FORA DO AR';
  }

  if (kit.nextAt !== null) {
    const left = new Date(kit.nextAt).getTime() - Date.now();

    return left > 0 ? `EM ${describeWait(left).toUpperCase()}` : 'JÁ PODE';
  }

  if (kit.kind === 'resgate' && kit.usesLeft === 0) {
    return (kit.useLimit ?? 1) === 1 ? 'JÁ PEGOU' : 'SEM USOS';
  }

  if (kit.requiredTier !== null) {
    return kit.requiredTierExact
      ? `SÓ ${kit.requiredTier.toUpperCase()}`
      : `EXIGE ${kit.requiredTier.toUpperCase()}`;
  }

  return 'INDISPONÍVEL';
}

/** Âmbar para o que é só ESPERAR; cinza para o que não muda. */
function stateColor(kit: KitOfferView): string {
  return kit.nextAt === null ? C.textMuted : C.amber;
}

/**
 * A cor da barra de estado do card.
 *
 * ####  POR QUE NÃO REAPROVEITAR `stateColor`  ####
 *
 * Ela responde outra pergunta: que cor dar ao TEXTO de um botão que
 * já se sabe morto — âmbar para "espera", cinza para "acabou". Ela
 * nunca precisou de uma cor para "dá para pegar", porque nesse caso
 * não há botão morto nenhum.
 *
 * A barra pergunta as TRÊS de uma vez, e é lida à distância, sem
 * texto ao lado. Verde é o que diz "vá" sem precisar de legenda.
 */
function accentColor(kit: KitOfferView): string {
  if (kit.available) {
    return C.olive;
  }

  // Esperando o cooldown é diferente de esgotado: um volta sozinho,
  // o outro não. Misturá-los faria o jogador desistir de um kit que
  // estará dele em duas horas.
  return kit.nextAt === null ? C.rust : C.amber;
}

// ============================================================
//  O MODAL DE DETALHES
// ============================================================

function buildInfo(
  offers: readonly KitOfferView[],
  target: Extract<KitScreenTarget, { kind: 'info' }>,
  itemOf: ItemLookup,
): UiScreen {
  // ####  A PÁGINA ENTRA NO ID QUE VOLTA  ####
  //
  // O plugin compara o que pediu com o que chega e DESCARTA o que
  // não bate. Devolver `ozkit:x:itens` para quem pediu
  // `ozkit:x:itens:1` deixaria o "carregando" preso na tela até o
  // timeout — a seta pareceria não funcionar.
  const id = kitInfoScreenId(target.slug, target.tab, target.page ?? 0);
  const kit = offers.find((offer) => offer.slug === target.slug);

  if (kit === undefined) {
    return {
      id,
      name: 'Kit',
      kind: 'modal',
      elements: [
        modalFrame(360, 170, [
          label('kt', 'Kit indisponível', modalHeader(), {
            size: 16,
            font: 'RobotoCondensed-Bold.ttf',
          }),
          label('km', 'Este kit saiu do ar.', fill(20, 54, 20, 50), { color: C.textMuted }),
          closeButton(),
        ]),
      ],
    };
  }

  // ####  A CONFIRMAÇÃO NÃO É UMA ABA  ####
  //
  // Ela é uma PERGUNTA, e uma pergunta com abas em cima convida a
  // sair dela por engano. Aqui o modal tem duas saídas só: sim e
  // não.
  if (target.tab === 'confirmar') {
    return {
      id,
      name: kit.name,
      kind: 'modal',
      elements: [modalFrame(460, 260, confirmBody(kit, itemOf))],
    };
  }

  // O detalhe de UMA casinha da grade. Também sem abas, e pelo mesmo
  // motivo da confirmação: daqui só se volta para a grade.
  if (target.tab === 'item') {
    return {
      id,
      name: kit.name,
      kind: 'modal',
      elements: [modalFrame(420, 270, itemDetail(kit, itemOf, target.page ?? 0))],
    };
  }

  const body: UiElement[] = [
    label('kt', kit.name, modalHeader(), { size: 16, font: 'RobotoCondensed-Bold.ttf' }),

    ...tabsRow(
      'k',
      [
        {
          label: 'GERAL',
          screenId: kitInfoScreenId(kit.slug, 'geral'),
          active: target.tab === 'geral',
        },
        {
          label: 'ITENS',
          screenId: kitInfoScreenId(kit.slug, 'itens'),
          active: target.tab === 'itens',
        },
      ],
      52,
    ),

    ...(target.tab === 'geral' ? generalTab(kit, target.page ?? 0) : itemsTab(kit, itemOf)),

    closeButton('FECHAR'),
  ];

  // Só quem pode pegar tem o botão — e ele fica AQUI também, para
  // quem abriu os detalhes não precisar fechar o modal para agir.
  if (kit.available) {
    body.push(
      button(
        'kbuy',
        'RESGATAR',
        {
          anchorMin: { x: 1, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: -150, y: 16 },
          offsetMax: { x: -22, y: 44 },
        },
        // Passa pela confirmação, como o card: o caminho é UM só.
        {
          id: `pedir-${kit.slug}`,
          kind: 'modal.open',
          screenId: kitInfoScreenId(kit.slug, 'confirmar'),
        },
        { color: C.rust, textColor: C.white, hoverColor: '#D4553FFF', fontSize: 12 },
      ),
    );
  } else {
    body.push(
      deadButton(
        'knob',
        shortReason(kit),
        {
          anchorMin: { x: 1, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: -150, y: 16 },
          offsetMax: { x: -22, y: 44 },
        },
        stateColor(kit),
      ),
    );
  }

  return {
    id,
    name: kit.name,
    kind: 'modal',
    elements: [modalFrame(KIT_MODAL.width, KIT_MODAL.height, body)],
  };
}

/**
 * A última parada antes de gastar o resgate.
 *
 * ####  ELA DIZ O QUE A REGRA CUSTA  ####
 *
 * "Tem certeza?" não informa nada. O que muda a decisão é saber que
 * o kit é de resgate ÚNICO — ou que o próximo só vem daqui a 2 h —
 * e o que exatamente vai entrar no inventário.
 */
function confirmBody(kit: KitOfferView, itemOf: ItemLookup): UiElement[] {
  const rule =
    kit.kind === 'resgate'
      ? 'Este kit é de resgate ÚNICO: depois de pegar, não dá para pegar de novo.'
      : kit.kind === 'cooldown'
        ? `Depois de pegar, o próximo só volta em ${describeWait((kit.cooldownSeconds ?? 0) * 1000)}.`
        : 'Os itens vão direto para o seu inventário.';

  const lines: ContentRow[] = kit.items.map((item) => {
    const known = itemOf(item.shortname);
    const name = known?.displayName ?? item.shortname;

    return {
      text: item.amount > 1 ? `${formatNumber(item.amount)}x ${name}` : name,
      item: known === null ? null : { itemId: known.itemId, skinId: item.skinId },
    };
  });

  return [
    label('kct', `Resgatar ${kit.name}?`, modalHeader(), {
      size: 16,
      font: 'RobotoCondensed-Bold.ttf',
    }),

    label(
      'kcr',
      rule,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -76 },
        offsetMax: { x: -22, y: -52 },
      },
      { size: 11, color: kit.kind === 'resgate' ? C.amber : C.textMuted, align: 'MiddleLeft' },
    ),

    panel(
      'kcl',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -178 },
        offsetMax: { x: -22, y: -84 },
      },
      C.none,
      // Uma área menor que a das abas: aqui a lista é lembrete, e
      // quem quiser vê-la inteira tem a aba ITENS.
      itemRows(lines, 94, 'kc'),
    ),

    button(
      'kcn',
      'CANCELAR',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 16 },
        offsetMax: { x: 130, y: 44 },
      },
      // Volta aos detalhes, e não fecha tudo: quem cancelou ainda
      // está decidindo.
      { id: `voltar-${kit.slug}`, kind: 'modal.open', screenId: kitInfoScreenId(kit.slug, 'geral') },
      { color: C.none, textColor: C.textMuted, hoverColor: C.surface2, fontSize: 12 },
    ),

    button(
      'kcy',
      'CONFIRMAR',
      {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -150, y: 16 },
        offsetMax: { x: -22, y: 44 },
      },
      // É AQUI, e em nenhum outro lugar, que o resgate acontece.
      { id: `pegar-${kit.slug}`, kind: 'store.buy', offerId: kit.slug, quantity: 1 },
      { color: C.rust, textColor: C.white, hoverColor: '#D4553FFF', fontSize: 12 },
    ),
  ];
}

/**
 * A aba GERAL: a regra, e o que aconteceu entre ele e este kit.
 *
 * ####  "QUANDO PEGUEI?" É A PERGUNTA DO JOGADOR  ####
 *
 * Ela não tinha resposta em lugar nenhum do jogo — e sem ela, num
 * kit de cooldown, a única forma de descobrir era clicar e ser
 * recusado.
 */
function generalTab(kit: KitOfferView, page: number): UiElement[] {
  const lines: ContentRow[] = [];

  if (kit.description !== null && kit.description.trim() !== '') {
    lines.push({ text: kit.description, item: null });
  }

  lines.push({ text: `Regra: ${ruleOf(kit)}`, item: null });

  if (kit.requiredTier !== null) {
    lines.push({
      text: kit.requiredTierExact
        ? `Exclusivo do VIP ${kit.requiredTier.toUpperCase()} — só esse nível pega`
        : `Exige VIP ${kit.requiredTier.toUpperCase()} (ou mais alto)`,
      item: null,
    });
  }

  lines.push({
    text:
      kit.myClaims === 0
        ? 'Você nunca pegou este kit'
        : `Você já pegou ${formatNumber(kit.myClaims)} ${kit.myClaims === 1 ? 'vez' : 'vezes'}`,
    item: null,
  });

  // ####  "QUANTOS ME SOBRAM?" É A OUTRA PERGUNTA  ####
  //
  // O total acima é histórico e não muda no wipe; este é o que vale
  // AGORA. Num kit que zera no wipe os dois discordam de propósito,
  // e é justamente essa diferença que o jogador precisa ver.
  if (kit.usesLeft !== null && (kit.useLimit ?? 1) > 1) {
    lines.push({
      text:
        `Restam ${formatNumber(kit.usesLeft)} de ${formatNumber(kit.useLimit ?? 1)} usos` +
        (kit.useResetOn === 'never' ? '' : ' — a conta zera no wipe'),
      item: null,
    });
  }

  if (kit.lastClaimedAt !== null) {
    lines.push({
      text: `Última vez: ${formatWhen(new Date(kit.lastClaimedAt).getTime())}`,
      item: null,
    });
  }

  if (kit.nextAt !== null) {
    const left = new Date(kit.nextAt).getTime() - Date.now();

    lines.push({
      text:
        left > 0 ? `Você pode pegar de novo em ${describeWait(left)}` : 'Você já pode pegar de novo',
      item: null,
    });
  } else if (kit.available) {
    lines.push({ text: 'Disponível agora', item: null });
  }

  return listBody(kit, 'geral', lines, page, 'kgeral', 'kg');
}

/** A aba ITENS: o que vem dentro, com o ícone de cada um. */
/**
 * O que vem no kit, desenhado como o inventário do jogo.
 *
 * ####  POR QUE ISTO DEIXOU DE SER UMA LISTA  ####
 *
 * A lista respondia "o que vem". Ela não respondia a pergunta que o
 * jogador realmente faz antes de gastar um resgate ÚNICO: onde isso
 * cai. Um kit com a AK na barra rápida e o colete no corpo é outro
 * kit — e pela lista os dois eram idênticos.
 *
 * A grade responde as duas de uma vez, porque é o mesmo desenho que
 * ele vê ao apertar TAB. O `slot` e a `position` já estavam no
 * cadastro desde sempre; o que faltava era a tela mostrá-los.
 */
function itemsTab(kit: KitOfferView, itemOf: ItemLookup): UiElement[] {
  const entries = inventoryEntriesOf(kit, itemOf);

  if (entries.length === 0) {
    return [
      label('kivazio', 'Este kit está vazio.', listArea(), {
        size: 12,
        color: C.textMuted,
      }),
    ];
  }

  const width = KIT_MODAL.width - 44;

  const blocks = inventoryBlocks(entries, {
    prefix: 'ki',
    width,
    height: LIST_VIEWPORT,
    // O clique abre o detalhe daquele item. O CUI não tem tooltip —
    // ver o cabeçalho de ui-inventory.ts.
    screenIdOf: (entry) => kitInfoScreenId(kit.slug, 'item', entry.index),
  });

  const elements: UiElement[] = [panel('kitens', listArea(), C.none, blocks.elements)];

  // O que não coube é CONTADO, nunca cortado em silêncio: um kit de
  // trinta itens não pode dizer que tem dez.
  if (blocks.hidden > 0) {
    elements.push(
      label(
        'kimais',
        `e mais ${formatNumber(blocks.hidden)} ${blocks.hidden === 1 ? 'item' : 'itens'} que não coube na tela`,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 22, y: -(LIST_PAGER.top + LIST_PAGER.height) },
          offsetMax: { x: -22, y: -LIST_PAGER.top },
        },
        { size: 10, color: C.amber, align: 'MiddleLeft' },
      ),
    );
  }

  return elements;
}

/** A área onde a lista (ou a grade) é desenhada. */
function listArea(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 22, y: -(LIST_TOP + LIST_VIEWPORT) },
    offsetMax: { x: -22, y: -LIST_TOP },
  };
}

/** Um item do kit, já resolvido, mais o índice que o endereça. */
interface KitEntry extends InventoryEntry {
  /** A posição no array do kit — é ela que vai no id do detalhe. */
  readonly index: number;
}

/**
 * Os itens do kit no formato da grade.
 *
 * ####  O SLOT DO CADASTRO É A VERDADE  ####
 *
 * Ele sempre foi `wear`, `belt` ou `main` — o zod da borda HTTP não
 * aceita outra coisa. O que mudou é que agora alguém OLHA para ele.
 */
function inventoryEntriesOf(kit: KitOfferView, itemOf: ItemLookup): readonly KitEntry[] {
  return kit.items.map((item, index) => {
    const known = itemOf(item.shortname);

    return {
      index,
      container: item.slot,
      position: item.position,
      itemId: known?.itemId ?? null,
      skinId: item.skinId,
      amount: item.amount,
      name: known?.displayName ?? item.shortname,
    };
  });
}

/**
 * O detalhe de um item da grade.
 *
 * ####  ELE EXISTE PORQUE O CUI NÃO TEM TOOLTIP  ####
 *
 * Não há evento de hover: um `CuiButton` conhece a cor normal e a de
 * mouse em cima, e nada mais. O nome de um item não cabe numa
 * casinha de 44 px, e escrevê-lo embaixo de cada uma transformaria a
 * grade numa parede de texto.
 *
 * Então a casinha clica. É um clique a mais que um tooltip, e em
 * troca cabe o nome inteiro, a quantidade exata e o contêiner.
 */
function itemDetail(kit: KitOfferView, itemOf: ItemLookup, index: number): UiElement[] {
  const entries = inventoryEntriesOf(kit, itemOf);
  const entry = entries[index];

  // Índice fora da lista: o admin mexeu no kit enquanto o modal
  // estava aberto. Voltar para a grade é melhor que um modal vazio.
  if (entry === undefined) {
    return [
      label('kdt', 'Item indisponível', modalHeader(), {
        size: 15,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label('kdm', 'Este item saiu do kit.', fill(22, 60, 22, 60), {
        size: 12,
        color: C.textMuted,
      }),
      backToItems(kit),
      closeButton(),
    ];
  }

  const body: UiElement[] = [
    label('kdt', entry.name, modalHeader(), { size: 15, font: 'RobotoCondensed-Bold.ttf' }),
  ];

  if (entry.itemId !== null) {
    body.push(
      itemImage(
        'kdi',
        { itemId: entry.itemId, skinId: entry.skinId },
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          offsetMin: { x: 22, y: -160 },
          offsetMax: { x: 118, y: -64 },
        },
      ),
    );
  }

  const facts: readonly (readonly [string, string])[] = [
    ['QUANTIDADE', formatNumber(entry.amount)],
    ['VAI PARA', CONTAINER_LABEL[entry.container]],
    [
      'CASINHA',
      entry.position >= 0
        ? String(entry.position + 1)
        : // Sem posição escolhida o jogo decide, e dizer "0" seria
          // inventar uma casinha que ninguém pediu.
          'a primeira livre',
    ],
  ];

  for (const [index_, [name, value]] of facts.entries()) {
    const top = 70 + index_ * 34;

    body.push(
      label(
        `kdf${String(index_)}`,
        name,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 136, y: -(top + 14) },
          offsetMax: { x: -22, y: -top },
        },
        { size: 10, color: C.textMuted, align: 'MiddleLeft' },
      ),
      label(
        `kdv${String(index_)}`,
        value,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 136, y: -(top + 32) },
          offsetMax: { x: -22, y: -(top + 15) },
        },
        { size: 13, align: 'MiddleLeft', font: 'RobotoCondensed-Bold.ttf' },
      ),
    );
  }

  if (entry.skinId !== '0' && entry.skinId !== '') {
    body.push(
      label('kdsk', `Skin ${entry.skinId}`, fill(22, 186, 22, 60), {
        size: 10,
        color: C.textMuted,
        align: 'MiddleLeft',
      }),
    );
  }

  body.push(backToItems(kit), closeButton());

  return body;
}

/** A volta para a grade. Sem ela o detalhe é um beco. */
function backToItems(kit: KitOfferView): UiElement {
  return button(
    'kdvolta',
    '‹ VOLTAR',
    {
      anchorMin: { x: 1, y: 0 },
      anchorMax: { x: 1, y: 0 },
      offsetMin: { x: -150, y: 16 },
      offsetMax: { x: -22, y: 44 },
    },
    { id: `kdv-${kit.slug}`, kind: 'modal.open', screenId: kitInfoScreenId(kit.slug, 'itens') },
    { color: C.surface2, textColor: C.text, hoverColor: C.border, fontSize: 12 },
  );
}

/**
 * A área da lista de uma aba, com as setas quando ela não cabe.
 *
 * ####  A ABA INTEIRA É ALCANÇÁVEL, E ISSO É O PONTO  ####
 *
 * Antes esta lista era `itemRows` direto: o que passava dos sete
 * primeiros virava "e mais 7..." e ACABAVA ali. Num kit de treze
 * itens o jogador ficava sabendo que existiam mais seis e sem
 * nenhuma forma de ver QUAIS — e é justamente na aba ITENS que ele
 * foi procurar exatamente isso.
 *
 * Sem `ScrollView` (ele derruba o cliente — ver types/ui-document.ts),
 * virar a página é o jeito de chegar ao último item.
 */
function listBody(
  kit: KitOfferView,
  tab: KitTab,
  lines: readonly ContentRow[],
  page: number,
  id: string,
  prefix: string,
): UiElement[] {
  const slice = paginateRows(lines, LIST_VIEWPORT, page);

  const elements: UiElement[] = [
    panel(
      id,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(LIST_TOP + LIST_VIEWPORT) },
        offsetMax: { x: -22, y: -LIST_TOP },
      },
      C.none,
      itemRows(slice.rows, LIST_VIEWPORT, prefix),
    ),
  ];

  if (slice.pages > 1) {
    elements.push(listPager(kit.slug, tab, slice.page, slice.pages));
  }

  return elements;
}

/**
 * O "‹ 1 / 2 ›" da lista do modal.
 *
 * Ele navega como as ABAS navegam — `modal.open` para o mesmo modal
 * com outro sufixo. Virar a página não é um evento que alguém
 * precise lembrar: é um endereço.
 */
function listPager(slug: string, tab: KitTab, page: number, pages: number): UiElement {
  return rowsPager({
    // Uma aba por vez está na tela: o id não precisa dizer qual.
    prefix: 'k',
    rect: {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 1, y: 1 },
      offsetMin: { x: 22, y: -(LIST_PAGER.top + LIST_PAGER.height) },
      offsetMax: { x: -22, y: -LIST_PAGER.top },
    },
    page,
    pages,
    screenIdOf: (next) => kitInfoScreenId(slug, tab, next),
    // `navigate` fecharia o modal; as abas usam `modal.open` pelo
    // mesmo motivo.
    kind: 'modal.open',
  });
}

function closeButton(text = 'FECHAR'): UiElement {
  return button(
    'kcls',
    text,
    {
      anchorMin: { x: 0, y: 0 },
      anchorMax: { x: 0, y: 0 },
      offsetMin: { x: 22, y: 16 },
      offsetMax: { x: 110, y: 44 },
    },
    { id: 'akcls', kind: 'modal.close' },
    { color: C.none, textColor: C.textMuted, hoverColor: C.surface2, fontSize: 12 },
  );
}
