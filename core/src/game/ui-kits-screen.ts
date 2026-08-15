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
import type { UiElement, UiScreen } from '../types/ui-document.js';

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
  panel,
  tabsRow,
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
  cardHeight: 160,
  rows: 2,
  /** A altura da barra de categorias, quando ela existe. */
  categoryHeight: 30,
} as const;

const PER_PAGE = GRID.columns * GRID.rows;

/** O que fica onde DENTRO do card. Ver ui-store-screens.ts. */
const CARD = {
  iconTop: 10,
  iconBottom: 68,
  nameTop: 72,
  nameBottom: 92,
  ruleTop: 94,
  ruleBottom: 110,
  buttonBottom: 8,
  buttonTop: 34,
} as const;

/** A altura da área da lista, no modal. */
const LIST_VIEWPORT = 168;

// ------------------------------------------------------------
//  O ENDEREÇO
// ------------------------------------------------------------

/**
 * O que o modal de um kit mostra.
 *
 *   geral      a regra, e o que já houve entre ele e este kit
 *   itens      o que vem dentro, com ícone
 *   confirmar  a última parada antes de gastar o resgate
 */
export type KitTab = 'geral' | 'itens' | 'confirmar';

/** O grupo dos kits SEM categoria. Ver `categorySlug`. */
export const NO_CATEGORY = '-';

export type KitScreenTarget =
  | { readonly kind: 'grid'; readonly category: string | null; readonly page: number }
  | { readonly kind: 'info'; readonly slug: string; readonly tab: KitTab };

/**
 * Lê o id da tela. `null` = não é uma tela de kits.
 *
 *     tela-kits          a primeira categoria, primeira página
 *     tela-kits:vip      aquela categoria
 *     tela-kits:vip:1    a segunda página dela
 *     ozkit:kit-x        o modal daquele kit
 *     ozkit:kit-x:itens  a aba de itens dele
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
      tab: tab === 'itens' || tab === 'confirmar' ? tab : 'geral',
    };
  }

  return null;
}

/** O endereço do modal daquele kit. */
export function kitInfoScreenId(slug: string, tab: KitTab = 'geral'): string {
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
    label('kits-titulo', 'KITS', topBarRect(30), {
      size: 20,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
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

  const top = grouped ? 42 + GRID.categoryHeight + 8 : 42;

  if (grouped) {
    let cursor = 0;

    for (const entry of categories) {
      const isActive = active !== null && entry.slug === active.slug;
      const width = Math.min(150, Math.max(60, entry.name.length * 7 + 22));

      elements.push(
        button(
          `kcat${entry.slug}`,
          entry.name.toUpperCase(),
          {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 0, y: 1 },
            offsetMin: { x: cursor, y: -(42 + GRID.categoryHeight) },
            offsetMax: { x: cursor + width, y: -42 },
          },
          { id: `akcat${entry.slug}`, kind: 'navigate', screenId: gridScreenId(entry.slug, 0) },
          {
            color: isActive ? C.surface2 : C.none,
            textColor: isActive ? C.text : C.textMuted,
            fontSize: 11,
          },
        ),
      );

      cursor += width + 4;
    }
  }

  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const current = Math.min(target.page, pages - 1);
  const slice = shown.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);

  elements.push(
    panel(
      'kits-grade',
      fill(0, top, 0, 26),
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

function kitCard(kit: KitOfferView, column: number, row: number, itemOf: ItemLookup): UiElement {
  const columnWidth = 1 / GRID.columns;
  const half = GRID.gap / 2;
  const y = row * (GRID.cardHeight + GRID.gap);
  const id = `k${kit.slug}`;

  const first = kit.items[0];
  const icon = first === undefined ? null : itemOf(first.shortname);

  const iconRect: Rect = {
    anchorMin: { x: 0.5, y: 1 },
    anchorMax: { x: 0.5, y: 1 },
    offsetMin: { x: -29, y: -CARD.iconBottom },
    offsetMax: { x: 29, y: -CARD.iconTop },
  };

  const children: UiElement[] = [
    icon === null
      ? // Sem catálogo lido não há itemId, e sem itemId não há ícone.
        // Um retângulo vazio é honesto: ele não finge ser um item que
        // não sabemos qual é.
        panel(`${id}-i`, iconRect, C.surface2)
      : itemImage(`${id}-i`, { itemId: icon.itemId, skinId: first?.skinId ?? '0' }, iconRect),

    label(
      `${id}-n`,
      kit.name,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 8, y: -CARD.nameBottom },
        offsetMax: { x: -8, y: -CARD.nameTop },
      },
      { size: 12, color: C.text, font: 'RobotoCondensed-Bold.ttf' },
    ),

    label(
      `${id}-r`,
      `${String(kit.items.length)} ${kit.items.length === 1 ? 'item' : 'itens'} · ${ruleOf(kit)}`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 8, y: -CARD.ruleBottom },
        offsetMax: { x: -8, y: -CARD.ruleTop },
      },
      { size: 10, color: C.textMuted },
    ),

    // ####  O "i" ABRE O QUE NÃO CABE NO CARD  ####
    //
    // A lista do que vem dentro, quando ele pegou pela última vez e
    // quantas vezes já pegou. Num card de 160px isso não entra — e
    // sem isso o jogador clica em RESGATAR para descobrir o que
    // ganha, o que num resgate único não dá para desfazer.
    button(
      `${id}-info`,
      'i',
      {
        anchorMin: { x: 1, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: -24, y: -24 },
        offsetMax: { x: -4, y: -4 },
      },
      { id: `a${id}info`, kind: 'modal.open', screenId: kitInfoScreenId(kit.slug) },
      { color: C.none, textColor: C.textMuted, hoverColor: C.surface2, fontSize: 12 },
    ),
  ];

  const buttonRect: Rect = {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: 8, y: CARD.buttonBottom },
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
          { color: C.rust, textColor: C.white, hoverColor: '#D4553FFF', fontSize: 11 },
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
    C.surface,
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
  const tier = kit.requiredTier === null ? '' : ` · VIP ${kit.requiredTier.toUpperCase()}`;

  if (kit.kind === 'resgate') {
    return `uma vez${tier}`;
  }

  if (kit.kind === 'cooldown') {
    return `a cada ${describeWait((kit.cooldownSeconds ?? 0) * 1000)}${tier}`;
  }

  return `compra${tier}`;
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

  if (kit.kind === 'resgate' && kit.lastClaimedAt !== null) {
    return 'JÁ PEGOU';
  }

  if (kit.requiredTier !== null) {
    return `EXIGE ${kit.requiredTier.toUpperCase()}`;
  }

  return 'INDISPONÍVEL';
}

/** Âmbar para o que é só ESPERAR; cinza para o que não muda. */
function stateColor(kit: KitOfferView): string {
  return kit.nextAt === null ? C.textMuted : C.amber;
}

// ============================================================
//  O MODAL DE DETALHES
// ============================================================

function buildInfo(
  offers: readonly KitOfferView[],
  target: Extract<KitScreenTarget, { kind: 'info' }>,
  itemOf: ItemLookup,
): UiScreen {
  const id = kitInfoScreenId(target.slug, target.tab);
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
      elements: [modalFrame(420, 250, confirmBody(kit, itemOf))],
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

    ...(target.tab === 'geral' ? generalTab(kit) : itemsTab(kit, itemOf)),

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
    elements: [modalFrame(440, 330, body)],
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
function generalTab(kit: KitOfferView): UiElement[] {
  const lines: ContentRow[] = [];

  if (kit.description !== null && kit.description.trim() !== '') {
    lines.push({ text: kit.description, item: null });
  }

  lines.push({ text: `Regra: ${ruleOf(kit)}`, item: null });

  if (kit.requiredTier !== null) {
    lines.push({ text: `Exige VIP ${kit.requiredTier.toUpperCase()} (ou mais alto)`, item: null });
  }

  lines.push({
    text:
      kit.myClaims === 0
        ? 'Você nunca pegou este kit'
        : `Você já pegou ${formatNumber(kit.myClaims)} ${kit.myClaims === 1 ? 'vez' : 'vezes'}`,
    item: null,
  });

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

  return [
    panel(
      'kgeral',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(84 + LIST_VIEWPORT) },
        offsetMax: { x: -22, y: -84 },
      },
      C.none,
      itemRows(lines, LIST_VIEWPORT, 'kg'),
    ),
  ];
}

/** A aba ITENS: o que vem dentro, com o ícone de cada um. */
function itemsTab(kit: KitOfferView, itemOf: ItemLookup): UiElement[] {
  const lines: ContentRow[] = kit.items.map((item) => {
    const known = itemOf(item.shortname);
    const name = known?.displayName ?? item.shortname;

    return {
      text: item.amount > 1 ? `${formatNumber(item.amount)}x ${name}` : name,
      item: known === null ? null : { itemId: known.itemId, skinId: item.skinId },
    };
  });

  if (lines.length === 0) {
    lines.push({ text: 'Este kit está vazio.', item: null });
  }

  return [
    panel(
      'kitens',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(84 + LIST_VIEWPORT) },
        offsetMax: { x: -22, y: -84 },
      },
      C.none,
      itemRows(lines, LIST_VIEWPORT, 'ki'),
    ),
  ];
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
