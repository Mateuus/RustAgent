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
  SCROLL_GUTTER,
  scrollArea,
  storedImage,
  tabsRow,
  tip,
  topBar,
  type ContentRow,
  type Rect,
} from './ui-widgets.js';
import { UI_DOC_MAX_BYTES } from '../types/ui-transport.js';

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

/**
 * A chave da pedra que marca o kit de VIP, na biblioteca de imagens.
 *
 * O arquivo é `Assets\ui\icon-gem.png` — branco sobre transparente,
 * como todos os de `Assets\menu-icons\`, porque o CUI TINGE a
 * imagem pela cor: o mesmo PNG serve ao âmbar daqui e a qualquer
 * outra cor que alguém precise depois.
 *
 * Chave que a biblioteca não tem vira um quadrado vazio, e não um
 * erro — ver `ResolveImages` no OrigemZUI.cs. É por isso que ela
 * pode ser usada sem o agente conferir antes se o PNG já subiu.
 */
const VIP_ICON_KEY = 'icon-gem';

/**
 * A grade, igual à da loja. Ver ui-store-screens.ts.
 *
 * ####  A ALTURA DO CARD CAIU DE 240 PARA 196  ####
 *
 * Com paginação, a grade tinha DUAS fileiras e ponto: o que não
 * coubesse ia para a página seguinte, então o card podia usar toda
 * a altura disponível. Agora ela ROLA, e a altura do card decide
 * outra coisa — quanto da terceira fileira aparece embaixo.
 *
 * 196 com 12 de respiro: duas fileiras usam 404 dos ~460 visíveis,
 * e sobram ~56 para uma FATIA da terceira. Essa fatia é o que diz
 * "tem mais aqui embaixo" antes de o jogador tocar na roda do
 * mouse — a barra de rolagem sozinha é fina demais para ser a
 * única a dizer isso.
 */
const GRID = {
  columns: 4,
  gap: 12,
  /**
   * 230, e o número saiu de duas contas que se cruzam.
   *
   * ####  A PRIMEIRA: O CARD ESTAVA DEITADO E VAZIO  ####
   *
   * A área da grade tem ~1.048 px, então em quatro colunas cada
   * card fica com 250 de largura. Com 196 de altura ele é um
   * retângulo deitado, e a arte de 100 px boiava no meio com 75 de
   * vazio de cada lado — foi o que o dono viu na captura e chamou
   * de "não ficou legal". Em 230, com a arte em 130, o card fica
   * quase quadrado e a figura do kit ocupa mais da metade dele.
   *
   * ####  A SEGUNDA: PRECISA SOBRAR O QUE ROLAR  ####
   *
   * Cinco colunas resolveriam a primeira conta melhor ainda (cards
   * de 200 x 200). Mas o frame do RCON comporta uns doze cards, e
   * doze em cinco colunas são DUAS FILEIRAS E MEIA — ou seja, tudo
   * o que cabe no frame cabe também na tela, e a rolagem nunca
   * apareceria.
   *
   * Em quatro colunas, os mesmos doze cards são TRÊS fileiras de
   * 230: 714 px de conteúdo para 460 de área visível. A terceira
   * fileira fica meio à mostra embaixo, que é o convite a rolar.
   */
  cardHeight: 230,
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
  /**
   * A faixa da barra de rolagem, dentro da coluna.
   *
   * Metade da que a grade reserva: a coluna tem 190 px de largura, e
   * 16 deles seriam um décimo do nome da categoria.
   */
  gutter: 8,
} as const;

/**
 * A altura útil da área de conteúdo, em pixels.
 *
 * ####  ELA ERA 516, E 516 ESTAVA ERRADO  ####
 *
 * O número vinha de uma estimativa escrita à mão ("720 menos o
 * cabeçalho de 76 e as margens de 30"). MEDIDO com
 * `screenViewport` sobre o preset do menu, o slot de conteúdo tem
 * 493,6 px — e o erro era para o lado PERIGOSO: a coluna
 * desenhava até a décima quinta categoria, e a última caía fora da
 * tela sem nada dizendo que existia.
 *
 * Continua sendo uma constante, e não um parâmetro, porque quem
 * monta esta tela não recebe o documento. O jeito de mantê-la
 * honesta é o teste: `ui-kits-grade.test.ts` a confere contra
 * `screenViewport(buildMainMenu(), …)` e quebra no dia em que
 * alguém mexer nas margens do preset.
 */
const VIEWPORT_HEIGHT = 493.6;

/**
 * A largura útil da área de conteúdo, em pixels.
 *
 * Mesma medição e mesmo motivo da altura: a grade precisa dela para
 * repartir as colunas em PIXELS. Repartir em fração do pai parecia
 * mais simples — até a barra de rolagem aparecer.
 *
 * ####  A BARRA É DESENHADA POR DENTRO  ####
 *
 * O `ScrollRect` não encolhe o conteúdo para abrir espaço: a barra
 * ocupa os últimos pixels da própria área, POR CIMA do que estiver
 * lá. Com os cards em fração, o último de cada fileira ia até a
 * borda — e a barra caía em cima dele, que foi o que o dono
 * fotografou.
 *
 * Encolher a ÁREA não resolvia: a barra acompanha a área, e o card
 * também. O que resolve é o conteúdo ser mais estreito que a área,
 * e para isso a conta precisa ser em pixels.
 */
const VIEWPORT_WIDTH = 1064.4;

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
  /**
   * A arte, 130 x 130 no meio do card.
   *
   * Ela era 100 e sobrava vazio dos dois lados. É a figura do kit —
   * o que identifica um kit à distância —, e não um selo de canto.
   */
  iconTop: 38,
  iconBottom: 168,
  /**
   * A linha de meta: quantos itens, e de quanto em quanto tempo.
   *
   * ####  ELA ENGOLIU A LINHA DO VIP, QUE FICAVA ATRÁS DO BOTÃO  ####
   *
   * Eram duas: a regra (174–192) e o nível exigido (194–210). Num
   * card de 240 o botão ia de 200 a 230 contados do topo — ou seja,
   * ele passava POR CIMA dos últimos dez pixels do "EXCLUSIVO VIP
   * OURO". No jogo o texto aparecia cortado ao meio, e foi assim
   * que o dono o encontrou.
   *
   * Agora o nível não é mais uma linha: é o ÍCONE à direita da
   * faixa do nome, com a frase inteira no tooltip. Uma informação
   * que precisa de cor para ser vista não precisa de uma linha
   * inteira para ser lida.
   */
  metaTop: 175,
  metaBottom: 191,
  /**
   * O rodapé, contado do FUNDO do card.
   *
   * 8 e 38 deixam o botão entre 158 e 188 do topo, dois pixels
   * abaixo de onde a meta termina. A conta está escrita aqui de
   * propósito: foi ela que faltou da última vez.
   */
  buttonBottom: 8,
  buttonTop: 38,
  /** O quadrado do ícone de VIP, na ponta direita da faixa do nome. */
  tierIcon: 16,
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

  if (offers.length === 0) {
    return {
      id,
      name: 'KITS',
      kind: 'page',
      elements: [
        ...header(0, 0),
        panel('kits-vazio', fill(0, HEADER_BAR, 0, 0), C.surface, [
          label('kits-vazio-texto', 'Nenhum kit disponível neste servidor.', fill(20, 20, 20, 20), {
            color: C.textMuted,
          }),
        ]),
      ],
    };
  }

  // ####  A BARRA SÓ APARECE COM MAIS DE UMA CATEGORIA  ####
  //
  // Com uma só, ela seria uma aba solitária ocupando trinta pixels
  // para dizer o que a tela toda já diz.
  const categories = categoriesOf(offers);
  const grouped = categories.length > 1;
  const active =
    categories.find((entry) => entry.slug === target.category) ?? categories[0] ?? null;

  const shown = ordered(
    grouped && active !== null
      ? offers.filter((kit) => categorySlug(kit.category) === active.slug)
      : offers,
  );

  const elements: UiElement[] = [
    ...header(shown.length, shown.filter((kit) => kit.available).length),
  ];

  if (grouped) {
    elements.push(...sidebar(categories, active, offers));
  }

  // ####  QUANTOS CABEM NUM FRAME, E NÃO QUANTOS CABEM NA TELA  ####
  //
  // A rolagem tirou o teto VISUAL: cabe a fileira que for. O teto
  // que sobrou é o do transporte — a tela inteira vai num comando
  // de RCON, e o frame são 50.000 bytes em base64.
  //
  // `fitCards` responde quantos cards cabem nesse orçamento. Quando
  // a categoria tem mais que isso, o resto vai para uma PÁGINA
  // seguinte, e o "‹ 1 / 2 ›" reaparece embaixo. É rede de
  // segurança, não o desenho: com kits de nome normal ele só
  // aparece perto dos vinte, e uma categoria com vinte kits é
  // incomum.
  const perPage = fitCards(shown, grouped ? categories.length : 0);
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const current = Math.min(target.page, pages - 1);
  const slice = shown.slice(current * perPage, current * perPage + perPage);

  const rows = Math.max(1, Math.ceil(slice.length / GRID.columns));
  const contentHeight = rows * GRID.cardHeight + (rows - 1) * GRID.gap;
  const paged = pages > 1;
  const width = cardWidth(grouped);

  // A área visível: o que sobra sob o cabeçalho, menos a faixa do
  // pager quando ele existe.
  const viewport = VIEWPORT_HEIGHT - HEADER_BAR - (paged ? PAGER_BAR : 0);

  elements.push(
    scrollArea(
      'kg',
      // A área encolhe pela ESQUERDA quando há coluna. À direita ela
      // vai até o fim: a faixa da barra é descontada do CONTEÚDO
      // (ver `cardWidth`), e não da área, senão a barra continua
      // caindo sobre o último card de cada fileira.
      fill(grouped ? SIDEBAR.width + SIDEBAR.gap : 0, HEADER_BAR, 0, paged ? PAGER_BAR : 0),
      { viewport, content: contentHeight },
      slice.map((kit, index) =>
        kitCard(kit, index, index % GRID.columns, Math.floor(index / GRID.columns), width, itemOf),
      ),
    ),
  );

  // Sem isto, o vigésimo primeiro kit sumiria sem nada na tela
  // dizendo que ele existe — a pior forma de perder conteúdo,
  // porque ninguém percebe.
  if (paged) {
    elements.push(...pager(active?.slug ?? NO_CATEGORY, current, pages));
  }

  return { id, name: 'KITS', kind: 'page', elements };
}

/**
 * A ordem da vitrine: primeiro o que dá para pegar AGORA.
 *
 * ####  A GRADE VINHA NA ORDEM DO BANCO  ####
 *
 * Que é a de cadastro, e não diz nada a quem está olhando. Numa
 * categoria com doze kits, isso põe o que o jogador pode resgatar
 * espalhado no meio do que ele não pode — e agora que a grade ROLA,
 * o que ele pode pegar pode estar abaixo da dobra, atrás de três
 * cards bloqueados que ele já viu ontem.
 *
 * A pergunta que a tela responde é "o que eu levo agora?". A ordem
 * é essa pergunta:
 *
 *   1. disponível      — é o que ele veio buscar
 *   2. esperando       — volta sozinho, e o card diz quando
 *   3. bloqueado       — exige VIP, acabou, está desligado
 *
 * Dentro de cada grupo, o que estava valendo continua valendo: a
 * ordem do banco. Reordenar por nome faria o admin perder o
 * controle da vitrine dele.
 *
 * ####  E ELA NÃO ESCONDE NADA  ####
 *
 * Nenhum kit sai da lista: o bloqueado continua lá, com o motivo.
 * É o que separa "ordenar" de "filtrar" — e filtrar faria o jogador
 * achar que o kit sumiu do servidor.
 */
function ordered(offers: readonly KitOfferView[]): readonly KitOfferView[] {
  const rank = (kit: KitOfferView): number => {
    if (kit.available) {
      return 0;
    }

    // Esperar é diferente de não poder: um volta sozinho, o outro
    // depende de o jogador fazer alguma coisa (comprar VIP, esperar
    // o wipe). É a mesma distinção que a barra de estado do card
    // faz em cor — ver `accentColor`.
    return kit.nextAt === null ? 2 : 1;
  };

  // `toSorted` não está no Node 20.11, que é o piso do projeto
  // (package.json), e `sort` mexe no array de quem chamou. A cópia
  // é o que mantém a lista do serviço intacta.
  return [...offers].sort((left, right) => rank(left) - rank(right));
}

// ============================================================
//  O CABEÇALHO
// ============================================================

/** A altura da faixa de título, com o respiro. */
const HEADER_BAR = 34;

/** A faixa do "‹ 1 / 2 ›", quando a categoria não cabe num frame. */
const PAGER_BAR = 26;

/**
 * A faixa de título: o nome, a contagem e o "?".
 *
 * ####  ELA ERA A `titleBar` COMPARTILHADA, DE 42 PX  ####
 *
 * O título em 18 px e, sob ele, "O que a rede entrega, e a regra de
 * cada um." em 11. Duas linhas para dizer o que a aba acesa lá em
 * cima já dizia — e 42 px é um quinto da altura de um card.
 *
 * Aqui ele é UMA linha de 22 px: o nome, e ao lado a única coisa
 * que muda de servidor para servidor e de jogador para jogador —
 * quantos kits há, e quantos dão para pegar AGORA. A frase de antes
 * virou a dica do "?" à direita: quem nunca viu esta tela pergunta
 * uma vez, e quem já viu não precisa ler de novo a cada abertura.
 */
function header(total: number, ready: number): UiElement[] {
  const count =
    total === 0
      ? 'nenhum kit por aqui'
      : `${String(total)} ${total === 1 ? 'kit' : 'kits'} · ${
          ready === 0
            ? 'nenhum disponível agora'
            : `${String(ready)} ${ready === 1 ? 'disponível' : 'disponíveis'} agora`
        }`;

  return [
    // O acento vermelho, o mesmo de todas as páginas do menu.
    panel(
      'kh-a',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: 0, y: -22 },
        offsetMax: { x: 3, y: 0 },
      },
      C.rust,
    ),
    label('kh-t', 'KITS', topBar(22, 0, 13), {
      size: 16,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    // A contagem começa depois do nome. 62 px é onde "KITS" em 16
    // bold termina, com ar — ver `textWidth`.
    label('kh-c', count, topBar(22, 0, 62), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
    }),
    // ####  O "?" É UM RÓTULO, E NÃO UM ÍCONE  ####
    //
    // Um ícone custaria um PNG na biblioteca e um elemento de
    // imagem; o "?" custa o mesmo elemento que qualquer texto, e
    // não depende de o OrigemZImages já ter subido o arquivo. O que
    // ele precisa ser é DESCOBRÍVEL — e um "?" no canto de uma
    // barra de título é o sinal mais antigo que existe de "passe o
    // mouse aqui".
    tip(
      label(
        'kh-i',
        '?',
        {
          anchorMin: { x: 1, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: -22, y: -22 },
          offsetMax: { x: 0, y: 0 },
        },
        { size: 13, color: C.textMuted, align: 'MiddleCenter' },
      ),
      'O que a rede entrega, e a regra de cada um. Passe o mouse num kit para ver a regra dele.',
    ),
  ];
}

/** O endereço de uma página da grade. */
export function gridScreenId(category: string, page: number): string {
  return page === 0
    ? `${KITS_SCREEN_ID}:${category}`
    : `${KITS_SCREEN_ID}:${category}:${String(page)}`;
}

/**
 * A largura de um card, em pixels.
 *
 * Sai da área da grade menos a faixa da barra de rolagem e os vãos
 * entre as colunas. É o número que faz a última coluna parar ANTES
 * da barra em vez de ficar debaixo dela.
 */
function cardWidth(grouped: boolean): number {
  const area =
    VIEWPORT_WIDTH - (grouped ? SIDEBAR.width + SIDEBAR.gap : 0) - SCROLL_GUTTER;

  return (area - (GRID.columns - 1) * GRID.gap) / GRID.columns;
}

/** Uma faixa colada no topo do PAI, com altura fixa. */
function topBarRect(height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -height },
    offsetMax: { x: 0, y: 0 },
  };
}

// ============================================================
//  A RÉGUA DE BYTES
//
//  ####  O QUE SEGURA ESTA TELA NÃO É A ALTURA  ####
//
//  Com rolagem, a grade cresce para baixo o quanto quiser: o
//  jogador rola. O que não cresce é o TRANSPORTE — a tela inteira
//  vai ao plugin num comando de console, e o frame do WebRCON são
//  `UI_DOC_MAX_BYTES` (50.000) em base64.
//
//  Estourar isso não dá erro visível: o frame é cortado, o JSON
//  chega truncado e o menu não abre. É exatamente o tipo de defeito
//  que aparece no servidor do dono com vinte kits e nunca na
//  máquina de quem escreveu o código com três.
//
//  Por isso a conta acontece ANTES de desenhar, e o que não couber
//  vira página — que é o mecanismo que esta tela já tinha e que
//  passa a ser rede de segurança em vez de desenho.
//
//  ####  OS NÚMEROS SÃO MEDIDOS, E O TESTE OS MANTÉM HONESTOS  ####
//
//  `ui-kits-grade.test.ts` monta a tela cheia, converte para CUI e
//  confere o tamanho real contra o teto. Quando alguém acrescentar
//  um elemento ao card, é lá que o número velho aparece.
// ============================================================

/**
 * O orçamento da tela, em bytes de JSON.
 *
 * ####  ELE ERA UM FRAME, E ISSO ERA O TETO DA ROLAGEM  ####
 *
 * A tela viajava num comando de console: 50.000 bytes em base64,
 * 37.500 de JSON, doze cards. A grade rolava três fileiras e
 * empurrava o décimo terceiro kit para a página 2 — o que a
 * rolagem tinha acabado de vir substituir.
 *
 * Desde 20/09/2026 o agente PARTE a tela em comandos que cabem, e o
 * plugin os junta antes de desenhar (ver `encodeUiScreenParts` em
 * types/ui-transport.ts e `Assemble` no OrigemZUI.cs). O teto
 * passou a ser outro, e ele é generoso: três frames de JSON.
 *
 * ####  POR QUE CONTINUA HAVENDO TETO  ####
 *
 * Do outro lado o desenho ainda vira um `AddUi` por jogador, e cada
 * elemento é um objeto que o cliente monta. Trinta e poucos cards
 * numa categoria é uma vitrine; trezentos é um servidor mandando o
 * cliente de cada jogador montar dois mil retângulos toda vez que
 * alguém abre a aba.
 *
 * O que passar disso vira página, como sempre — só que agora a
 * página comporta nove fileiras em vez de três.
 */
const BYTE_BUDGET = Math.floor((UI_DOC_MAX_BYTES * 3) / 4) * 3;

// ------------------------------------------------------------
//  OS NÚMEROS ABAIXO FORAM MEDIDOS EM 20/09/2026, convertendo a
//  tela para CUI e contando o JSON do pacote inteiro. Quem mexer no
//  card muda os dois primeiros; o teste `cabe no frame` é o que
//  avisa.
// ------------------------------------------------------------

/** O cabeçalho, a área rolável e o envelope do pacote. */
const FIXED_BYTES = 2_900;

/** Cada linha da coluna de categorias: um botão são dois elementos. */
const CATEGORY_BYTES = 930;

/** O card sem nome, sem descrição e sem o ícone de VIP. */
const CARD_BYTES = 2_650;

/** O ícone de VIP: um elemento a mais, com a dica junto. */
const CARD_TIER_BYTES = 330;

/**
 * Quantos cards cabem no orçamento.
 *
 * ####  O TEXTO DO ADMIN ENTRA NA CONTA  ####
 *
 * "KIT" e "KIT DE SOBREVIVÊNCIA AVANÇADA PARA O WIPE DE SEXTA"
 * custam bytes diferentes, e a descrição viaja inteira no tooltip.
 * Um mural de nomes longos é justamente o caso em que uma régua de
 * "oito por página" erra — e erra para o lado em que o menu não
 * abre.
 *
 * Nunca devolve menos que uma fileira: uma página com dois cards
 * seria pior que o frame cortado — ela funcionaria, e ninguém
 * entenderia por que a grade virou aquilo.
 */
/**
 * Quantas categorias a coluna pode desenhar sem comer a grade.
 *
 * Uma fileira de cards é reservada antes: uma tela com a coluna
 * inteira e nenhum kit à direita responderia à pergunta errada.
 *
 * O número que sai daqui — trinta e poucas — não é um limite que
 * alguém alcance cadastrando categorias de verdade. Ele existe
 * porque a alternativa é o frame estourar em silêncio.
 */
function fitCategories(): number {
  const room = (BYTE_BUDGET - FIXED_BYTES - GRID.columns * CARD_BYTES) / CATEGORY_BYTES;

  return Math.max(1, Math.floor(room));
}

function fitCards(offers: readonly KitOfferView[], categories: number): number {
  let spent = FIXED_BYTES + categories * CATEGORY_BYTES;
  let fit = 0;

  for (const kit of offers) {
    spent +=
      CARD_BYTES +
      // Duas vezes: o rótulo da faixa, e a dica do card.
      kit.name.length * 2 +
      Math.min(kit.description?.length ?? 0, TIP_DESCRIPTION_MAX) +
      // O motivo de não dar para pegar também viaja no tooltip. Ele
      // é montado aqui (ver `longReason`), então o teto é conhecido:
      // a frase mais longa que ele escreve tem ~70 caracteres.
      (kit.available ? 0 : 80) +
      (kit.requiredTier === null ? 0 : CARD_TIER_BYTES);

    if (spent > BYTE_BUDGET) {
      break;
    }

    fit += 1;
  }

  return Math.max(GRID.columns, fit);
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
  offers: readonly KitOfferView[],
): UiElement[] {
  // ####  A COLUNA ROLA, COMO A GRADE  ####
  //
  // Ela contava o que não coubesse: treze categorias na tela e um
  // "e mais 4..." embaixo — o excedente era DITO, mas continuava
  // inalcançável. Quem tivesse dezessete categorias não tinha como
  // abrir as quatro últimas.
  //
  // Com a rolagem, "quantas cabem NA TELA" deixou de ser uma
  // pergunta: a coluna desenha todas e rola o que passar da altura.
  //
  // O teto que resta é o do FRAME — cada linha custa ~780 bytes, e
  // uma coluna sem limite come o orçamento dos cards até a grade
  // não ter o que mostrar. `fitCategories` guarda uma fileira de
  // cards antes de repartir o resto, e o que passar disso volta a
  // ser CONTADO, como era.
  const room = fitCategories();
  const visible = categories.length > room ? categories.slice(0, room) : categories;
  const rest = categories.length - visible.length;

  const height = VIEWPORT_HEIGHT - HEADER_BAR;
  const content = (visible.length + (rest > 0 ? 1 : 0)) * SIDEBAR.item;

  // ####  A FAIXA DA BARRA SÓ EXISTE QUANDO HÁ BARRA  ####
  //
  // Os itens param antes da borda direita para a barra de rolagem
  // não cair em cima do nome da categoria. Mas com poucas
  // categorias não há barra nenhuma — a área não rola, e o CUI a
  // esconde (`autoHide`) — e aí o recuo vira um defeito visível: o
  // fundo preto do item ABERTO deixava de encostar na borda da
  // coluna, e ficava com uma tira cinza do lado. Foi o que o dono
  // fotografou.
  const rolling = content > height;
  const gutter = rolling ? -SIDEBAR.gutter : 0;

  const items: UiElement[] = [];

  for (const [index, entry] of visible.entries()) {
    // ####  O ID É O ÍNDICE, E NÃO O SLUG  ####
    //
    // `kcatroupa-bronze` viajava duas vezes por elemento (no `name`
    // e no `parent` do filho) mais uma no comando do botão. `kc3`
    // diz a mesma coisa para o cliente, que só precisa que seja
    // único DENTRO desta tela — e a tela é redesenhada inteira a
    // cada clique. Ver a régua de bytes.
    const id = `kc${String(index)}`;
    const count = offers.filter((kit) => categorySlug(kit.category) === entry.slug).length;
    // A contagem entra no MESMO rótulo, e não num segundo elemento
    // à direita: ela responde "vale entrar aqui?" e custa os
    // caracteres, não os ~260 bytes de um elemento novo.
    const text = `${entry.name.toUpperCase()} · ${String(count)}`;
    const isActive = active !== null && entry.slug === active.slug;

    const rect: Rect = {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 1, y: 1 },
      offsetMin: { x: 0, y: -((index + 1) * SIDEBAR.item) },
      // Recuado só quando a coluna ROLA: a barra é desenhada POR
      // DENTRO da área, como a da grade. Ver `rolling`.
      offsetMax: { x: gutter, y: -(index * SIDEBAR.item) },
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
        'kcmais',
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
        offsetMin: { x: 0, y: 0 },
        offsetMax: { x: SIDEBAR.width, y: -HEADER_BAR },
      },
      C.surface2,
      [
        // A área rolável ocupa a coluna inteira; os itens se
        // posicionam dentro dela, na altura do CONTEÚDO. Com poucas
        // categorias o conteúdo cabe, a barra some e a coluna fica
        // idêntica à de antes.
        scrollArea(
          'kcs',
          // A área ocupa a coluna inteira; quem recua para a barra
          // são os ITENS (ver `SIDEBAR.gutter`), e não ela — a barra
          // acompanha a área, então encolher a área não a tiraria de
          // cima do texto.
          fill(),
          { viewport: height, content },
          items,
        ),
      ],
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

/**
 * Um card da grade.
 *
 * ####  O CARD INTEIRO É O BOTÃO  ####
 *
 * Ele tinha um "VER" de 50 px no rodapé, ao lado do RESGATAR. Dois
 * botões num card de 200 px de largura, e o da esquerda existia só
 * para dizer "mostre o que já está escrito aqui, só que completo".
 *
 * Agora o card é um `button` cujo desenho mora nos FILHOS — o mesmo
 * arranjo do cartão do passe. Clicar em qualquer lugar dele abre o
 * detalhe; o RESGATAR continua por cima, e o clique nele é dele (no
 * Unity quem recebe o raio é o elemento da frente).
 *
 * Isso vale dois elementos por card — um botão são DOIS no CUI, o
 * retângulo e o rótulo — e é parte do que paga a rolagem: são ~700
 * bytes que voltam para o orçamento do frame, por card.
 */
function kitCard(
  kit: KitOfferView,
  index: number,
  column: number,
  row: number,
  width: number,
  itemOf: ItemLookup,
): UiElement {
  // Em PIXELS, e ancorado no canto superior esquerdo da área. Era em
  // fração do pai, o que dividia a largura INTEIRA entre as colunas
  // — inclusive a faixa em que a barra de rolagem é desenhada. Ver
  // `cardWidth`.
  const x = column * (width + GRID.gap);
  const y = row * (GRID.cardHeight + GRID.gap);
  // Curto de propósito: o id viaja no `name` do elemento, no
  // `parent` de cada filho e no comando do botão. Ver a régua de
  // bytes.
  const id = `k${String(index)}`;

  const first = kit.items[0];
  const icon = first === undefined ? null : itemOf(first.shortname);
  const tier = tierLineOf(kit);

  // A arte do kit, grande e no meio. Ela é o que identifica o kit à
  // distância — ver `CARD`.
  const iconRect: Rect = {
    anchorMin: { x: 0.5, y: 1 },
    anchorMax: { x: 0.5, y: 1 },
    offsetMin: { x: -65, y: -CARD.iconBottom },
    offsetMax: { x: 65, y: -CARD.iconTop },
  };

  const children: UiElement[] = [
    // ####  A BARRA DE ESTADO, TRÊS PIXELS NO TOPO  ####
    //
    // Ela chegou a virar a FAIXA INTEIRA do nome, tingida de
    // verde-musgo, âmbar-terra ou vinho. Durou uma captura de tela:
    // o dono olhou e disse que não ficou legal, e ele tem razão —
    // uma faixa colorida atrás do nome do kit briga com a arte
    // logo abaixo, e o card inteiro ganha um tom que não é dele.
    //
    // A tira fina diz a mesma coisa com a cor CHEIA da paleta, que
    // é o que se lê à distância, sem tingir nada.
    panel(`${id}a`, topBarRect(CARD.accent), accentColor(kit)),

    // ####  A FAIXA DO NOME  ####
    //
    // Escura, um tom abaixo do card: ela é a primeira coisa que se
    // lê, e é o que dá ao card uma borda visível contra a moldura
    // do menu.
    panel(
      `${id}n`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -CARD.nameBottom },
        offsetMax: { x: 0, y: -CARD.nameTop },
      },
      C.bg,
      [
        label(
          `${id}t`,
          // MAIÚSCULAS, como as abas do menu e os nomes da coluna de
          // categorias. "Kit Avancado" no meio de uma tela em caixa
          // alta parecia texto de outro lugar.
          kit.name.toUpperCase(),
          // Com ícone de VIP, o texto para antes dele: um nome longo
          // passando POR BAIXO do ícone é o mesmo defeito que o
          // "EXCLUSIVO VIP OURO" atrás do botão, só que menor.
          fill(10, 0, tier === null ? 10 : CARD.tierIcon + 12, 0),
          {
            size: 13,
            color: C.text,
            align: 'MiddleLeft',
            font: 'RobotoCondensed-Bold.ttf',
          },
        ),
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
      ? storedImage(`${id}i`, kitIconKey(kit.slug), iconRect)
      : icon === null
        ? // Sem catálogo lido não há itemId, e sem itemId não há
          // ícone. Um retângulo vazio é honesto: ele não finge ser um
          // item que não sabemos qual é.
          panel(`${id}i`, iconRect, C.surface)
        : itemImage(`${id}i`, { itemId: icon.itemId, skinId: first?.skinId ?? '0' }, iconRect),

    // A linha de meta: quantos itens vêm dentro, e de quanto em
    // quanto tempo. É o que decide se vale abrir o card.
    label(
      `${id}m`,
      `${String(kit.items.length)} ${kit.items.length === 1 ? 'item' : 'itens'} · ${ruleOf(kit)}`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: CARD.pad, y: -CARD.metaBottom },
        offsetMax: { x: -CARD.pad, y: -CARD.metaTop },
      },
      { size: 11, color: C.textMuted },
    ),
  ];

  // ####  O VIP VIROU UM ÍCONE COM DICA  ####
  //
  // Em âmbar, na ponta da faixa do nome. A frase inteira —
  // "EXCLUSIVO VIP OURO" — está no tooltip, e o que fica na tela é
  // a COR: âmbar é a marca do que é premium em todo o menu, e ela
  // se lê à distância de um olhar, que é o que um mural de cards
  // pede. Escrita, ela custava uma linha inteira do card e acabava
  // atrás do botão.
  if (tier !== null) {
    children.push(
      tip(
        storedImage(
          `${id}v`,
          VIP_ICON_KEY,
          {
            anchorMin: { x: 1, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: -(CARD.tierIcon + 8), y: -(CARD.nameTop + 5 + CARD.tierIcon) },
            offsetMax: { x: -8, y: -(CARD.nameTop + 5) },
          },
          C.amber,
        ),
        tier,
      ),
    );
  }

  // ####  O CARD INTEIRO ABRE O DETALHE  ####
  //
  // Um botão TRANSPARENTE por cima do desenho, do topo até onde o
  // rodapé começa. Ele deixa o RESGATAR de fora de propósito: no
  // Unity quem recebe o clique é o elemento da frente, e dois
  // botões empilhados no mesmo ponto fariam o de baixo nunca
  // responder.
  //
  // Ele substituiu o "VER" de 50 px que dividia o rodapé com a
  // ação. O que aquele botão dizia — "mostre o que já está escrito
  // aqui, só que completo" — não precisava de um rótulo próprio.
  children.push(
    tip(
      button(
        `${id}o`,
        '',
        fill(0, 0, 0, GRID.cardHeight - CARD.metaBottom),
        { id: `o${String(index)}`, kind: 'modal.open', screenId: kitInfoScreenId(kit.slug) },
        {
          color: C.none,
          textColor: C.text,
          // Um véu claríssimo: o card ACENDE sob o cursor, e é isso
          // que diz que ele inteiro é clicável.
          hoverColor: '#FFFFFF14',
        },
      ),
      cardTip(kit),
    ),
  );

  const buttonRect: Rect = {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: 8, y: CARD.buttonBottom },
    offsetMax: { x: -8, y: CARD.buttonTop },
  };

  children.push(
    kit.available
      ? // Sem dica: "RESGATAR" já é a frase inteira, e uma dica que
        // repete o rótulo em outras palavras gasta bytes do frame
        // para não dizer nada.
        button(
          `${id}b`,
          'RESGATAR',
          buttonRect,
            // ####  O CARD NÃO RESGATA: ELE PERGUNTA  ####
            //
            // Um resgate único é irreversível, e o botão fica a um
            // clique de distância num card pequeno, ao lado de
            // outros sete. A confirmação é a diferença entre "peguei
            // o que queria" e "gastei minha única chance sem
            // querer".
          {
            id: `p${String(index)}`,
            kind: 'modal.open',
            screenId: kitInfoScreenId(kit.slug, 'confirmar'),
          },
          { color: C.rust, textColor: C.white, hoverColor: '#D4553FFF', fontSize: 12 },
        )
      : // ####  QUEM NÃO PODE PEGAR VÊ O MOTIVO, NÃO UM BOTÃO MORTO  ####
        //
        // Na tela vai o motivo CURTO, montado aqui: a frase do
        // `KitStore` traz o nome do kit e o SteamID porque serve ao
        // painel e ao suporte, e num card estreito ela apareceu
        // cortada no meio no jogo.
        //
        // A frase inteira não se perde: ela é a dica. É para isso
        // que o tooltip serve — o que não cabe escrito, e que quem
        // quer saber pergunta parando o mouse em cima.
        tip(deadButton(`${id}b`, shortReason(kit), buttonRect, stateColor(kit)), longReason(kit)),
  );

  return panel(
    `${id}c`,
    {
      anchorMin: { x: 0, y: 1 },
      anchorMax: { x: 0, y: 1 },
      offsetMin: { x, y: -(y + GRID.cardHeight) },
      offsetMax: { x: x + width, y: -y },
    },
    // ####  `--surface-2`, E NÃO `--surface`  ####
    //
    // A moldura do menu é `--surface` (ver o preset). Um card da
    // mesma cor não tem borda contra ela — e o CUI não tem borda de
    // verdade para dar. Um tom acima é o que o separa do fundo, que
    // é o mesmo recurso que a coluna de categorias já usa.
    //
    // ####  E É UM `panel`, E NÃO UM `button`  ####
    //
    // O card já foi um botão, para ser clicável inteiro. No jogo ele
    // apareceu PRETO: o cliente não pinta um `CuiButton` como pinta
    // um `CuiPanel` da mesma cor — a cor passa pelo `ColorBlock` do
    // botão antes de virar pixel, e #262626 vira quase #000000.
    //
    // Quem carrega o clique agora é a `área` logo abaixo, que é
    // transparente e não pinta nada. Assim a cor do card é a cor
    // que se pediu, e o card inteiro continua abrindo o detalhe.
    C.surface2,
    children,
  );
}

/**
 * O quanto da descrição do admin cabe numa dica de uma linha.
 *
 * 120 caracteres são ~14 palavras, o que um tooltip do jogo mostra
 * sem sair da tela num monitor de 1920.
 */
const TIP_DESCRIPTION_MAX = 120;

/** Corta um texto no tamanho de uma dica, com reticências. */
function shorten(text: string): string {
  return text.length > TIP_DESCRIPTION_MAX
    ? `${text.slice(0, TIP_DESCRIPTION_MAX).trimEnd()}...`
    : text;
}

/**
 * A dica do card: o que não coube escrito nele.
 *
 * A DESCRIÇÃO do admin vem primeiro quando existe — é o texto que
 * alguém escreveu justamente para explicar aquele kit, e ele não
 * aparecia em lugar nenhum da grade. Sem ela, a dica diz a regra e
 * o nível, que é mais do que a linha de meta cabe dizer.
 */
function cardTip(kit: KitOfferView): string {
  const parts: string[] = [kit.name];
  const description = kit.description ?? '';

  if (description !== '') {
    // ####  CORTADA, E O CORTE APARECE  ####
    //
    // A descrição pode ter 400 caracteres (é o teto do cadastro), e
    // o tooltip é UMA LINHA: 400 caracteres nela saem da tela pelos
    // dois lados. O detalhe inteiro está a um clique daqui, no
    // modal — a dica é a isca, não o texto.
    parts.push(shorten(description));
  }

  const tier = tierLineOf(kit);

  if (tier !== null) {
    parts.push(tier);
  }

  parts.push('Clique para ver o que vem dentro.');

  return parts.join(' — ');
}

/**
 * Por que não dá para pegar, por extenso e na SEGUNDA PESSOA.
 *
 * ####  O `reason` DO `KitStore` NÃO SERVE AQUI  ####
 *
 * Ele é a frase do PAINEL: "O kit "Kit Avançado" é de resgate
 * único, e 76561198065694695 já o pegou em 06/09/2026." Ela nomeia
 * o kit e o SteamID porque quem a lê está no suporte, olhando o
 * registro de outra pessoa.
 *
 * Quem lê ESTA é o dono daquele SteamID, com o nome do kit escrito
 * dois centímetros acima. O que falta para ele é "você já pegou" —
 * e foi o dono quem apontou isso, vendo o número da própria conta
 * numa dica dentro do jogo.
 */
function longReason(kit: KitOfferView): string {
  if (!kit.enabled) {
    return 'Este kit está desligado no momento.';
  }

  if (kit.nextAt !== null) {
    const left = new Date(kit.nextAt).getTime() - Date.now();

    return left > 0
      ? `Você já pegou este kit. Pode pegar de novo em ${describeWait(left)}.`
      : 'Já dá para pegar de novo — clique para confirmar.';
  }

  if (kit.kind === 'resgate' && kit.usesLeft === 0) {
    return (kit.useLimit ?? 1) === 1
      ? 'Você já pegou este kit, e ele é de uma vez só.'
      : `Você já usou as ${String(kit.useLimit ?? 1)} vezes deste kit.`;
  }

  const tier = tierLineOf(kit);

  if (tier !== null) {
    return kit.requiredTierExact
      ? `Este kit é só para quem tem VIP ${(kit.requiredTier ?? '').toUpperCase()}.`
      : `Este kit pede VIP ${(kit.requiredTier ?? '').toUpperCase()} ou acima.`;
  }

  return 'Este kit não está disponível para você agora.';
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
 *
 * ####  AS CORES SÃO AS CHEIAS DA PALETA  ####
 *
 * Isto chegou a ser a faixa inteira do nome, e aí as cores tiveram
 * de ser rebaixadas para o nome caber legível em cima. O resultado
 * tingia o card todo, e o dono recusou na primeira captura. Numa
 * tira de três pixels não há nada escrito por cima: ela pode usar
 * `--olive`, `--amber` e `--rust-red` como eles são.
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
