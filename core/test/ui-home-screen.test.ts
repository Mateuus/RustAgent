// ============================================================
//  ui-home-screen.test.ts  -  a HOME com dado vivo dentro.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  A home é a tela de ENTRADA: ela viaja na carga inicial do
//  documento e é redesenhada a cada abertura do menu. Três coisas
//  quebram o menu inteiro quando ela quebra, e nenhuma delas dá
//  erro no jogo:
//
//    1. a carga inicial estourar o frame do RCON — o menu
//       simplesmente não abre;
//    2. a marca `generated` sumir do preset — o plugin desenha o
//       repouso e nunca pede a de verdade, e o jogador fica com
//       "Carregando…" para sempre (MEDIDO com as missões);
//    3. um `:` num `screenId` de ação gravada — o `uiDocumentSchema`
//       recusa o documento inteiro na gravação.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  applyPlayerName,
  buildHomeScreen,
  cardsOf,
  createHomeScreenProvider,
  emptyHomeView,
  HOME_SCREEN_ID,
  HOME_SLOTS,
  type HomeScreenProviderOptions,
  type HomeStoreOffer,
  type HomeView,
} from '../src/game/ui-home-screen.js';
import { CANVAS, measureElement, type Box } from '../src/game/ui-geometry.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import {
  applyHidden,
  uiDocumentSchema,
  type UiElement,
  type UiScreen,
} from '../src/types/ui-document.js';
import {
  encodeUiDocPayload,
  toDocumentPayload,
  UI_DOC_MAX_BYTES,
} from '../src/types/ui-transport.js';

/** A árvore achatada, para procurar por id. */
function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function find(screen: UiScreen, suffix: string): UiElement | undefined {
  return walk(screen.elements).find((element) => element.id.endsWith(suffix));
}

function textOf(screen: UiScreen, suffix: string): string {
  const element = find(screen, suffix);

  if (element === undefined) {
    return '';
  }

  return element.type === 'label' || element.type === 'button' ? element.text : '';
}

const OFFER: HomeStoreOffer = {
  id: 'ak-diamante',
  name: 'AK Diamante',
  price: 1200,
  oldPrice: 1500,
  badge: 'promo',
  icon: { itemId: 1545779598, skinId: '3080000' },
  createdAt: 1_000,
};

function view(overrides: Partial<HomeView> = {}): HomeView {
  return {
    ...emptyHomeView(),
    rank: {
      metric: 'Abates',
      top: [
        { position: 1, name: 'Mateuus', value: '1.420', mine: false },
        { position: 2, name: 'Beltrano', value: '980', mine: true },
      ],
      self: 'Você está em 2º de 340',
    },
    offer: {
      offerId: OFFER.id,
      name: OFFER.name,
      price: OFFER.price,
      oldPrice: OFFER.oldPrice,
      icon: OFFER.icon,
      badge: OFFER.badge,
    },
    offerNote: '',
    wipe: { when: 'quinta, 03/09 às 16:00', countdown: 'faltam 3 dias', note: 'Blueprints zerados.' },
    wipeNote: '',
    quests: [{ title: 'Caçador', progress: '3/10', done: false }],
    questNote: '1 missão em andamento',
    ...overrides,
  };
}

// ------------------------------------------------------------
//  O DESENHO
// ------------------------------------------------------------

describe('a HOME desenhada', () => {
  it('mostra o pódio, a oferta, o wipe e as missões', () => {
    const screen = buildHomeScreen({ view: view() });

    expect(textOf(screen, HOME_SLOTS.rankMetric)).toBe('Abates');
    expect(textOf(screen, HOME_SLOTS.rankSelf)).toBe('Você está em 2º de 340');
    expect(textOf(screen, HOME_SLOTS.offerName)).toBe('AK Diamante');
    expect(textOf(screen, HOME_SLOTS.offerPrice)).toBe('1.200 OZ');
    expect(textOf(screen, HOME_SLOTS.offerOld)).toBe('de 1.500 OZ');
    expect(textOf(screen, HOME_SLOTS.wipeWhen)).toBe('quinta, 03/09 às 16:00');
    expect(textOf(screen, HOME_SLOTS.wipeCountdown)).toBe('faltam 3 dias');
    expect(textOf(screen, HOME_SLOTS.questNote)).toBe('1 missão em andamento');

    // As linhas das listas são derramadas, e não desenhadas: são
    // elas que mudam a cada abertura.
    const rows = find(screen, HOME_SLOTS.rankList)?.children ?? [];

    expect(rows).toHaveLength(2);
    expect(walk(rows).some((element) => element.type === 'label' && element.text === 'Mateuus')).toBe(
      true,
    );
  });

  /**
   * ####  O BOTÃO DE COMPRAR LEVA O `offerId`  ####
   *
   * É a única ação desta tela que move dinheiro, e ela abre o MESMO
   * modal da loja — `ozitem:<offerId>:1`. Um endereço divergente
   * daqui apareceria como um botão que não faz nada: o plugin
   * descarta a resposta cujo id não bate com o que ele pediu.
   */
  it('o botão da oferta abre o modal de compra daquele item', () => {
    const screen = buildHomeScreen({ view: view() });
    const element = find(screen, HOME_SLOTS.offerButton);

    expect(element?.type).toBe('button');
    expect(element?.type === 'button' ? element.action : null).toEqual({
      id: 'hm-loja-a',
      kind: 'modal.open',
      screenId: 'ozitem:ak-diamante:1',
    });
  });

  it('sem oferta, o cartão explica o vazio em vez de oferecer nada', () => {
    const screen = buildHomeScreen({
      view: view({ offer: null, offerNote: 'A loja ainda não tem oferta ligada.' }),
    });

    expect(textOf(screen, HOME_SLOTS.offerName)).toBe('A loja ainda não tem oferta ligada.');
    // A seta vai DENTRO do texto: no conceito ela é um `<span>`
    // vermelho à direita, e aqui seria um segundo elemento por
    // cartão, numa tela que viaja inteira na carga inicial.
    expect(textOf(screen, HOME_SLOTS.offerButton)).toBe('VER A LOJA   ›');
    // Um COMPRAR sobre coisa nenhuma é pior que um cartão honesto.
    expect(textOf(screen, HOME_SLOTS.offerPrice)).toBe('');
  });

  /**
   * ####  O NOME ENTRA NO TEXTO DO ADMIN  ####
   *
   * `{jogador}` é a variável dele, e não um rótulo nosso ao lado —
   * quem decide onde o nome aparece é quem escreve a frase.
   */
  it('troca `{jogador}` pelo nome de quem abriu', () => {
    const screen = buildHomeScreen({ view: view({ player: 'Mateuus' }) });

    // ####  O NOME TEM UMA LINHA SÓ PARA ELE  ####
    //
    // Ele e a saudação eram um texto único, e isso dava aos dois o
    // mesmo peso — quem abre o menu não está lendo a saudação, está
    // se reconhecendo nela. Separado, o nome fica no tamanho e na
    // cor em que é a primeira coisa vista.
    expect(textOf(screen, 'hm-ola')).toBe('BEM-VINDO DE VOLTA');
    expect(textOf(screen, 'hm-titulo')).toBe('Mateuus');
  });

  // ####  O CAMINHO QUE IMPORTA É O DO MODELO  ####
  //
  // O teste acima mede o layout EMBUTIDO, e no jogo ele quase nunca
  // roda: o preset gera a tela-home chamando este mesmo gerador, o
  // resultado vai para o documento, e daí em diante ele volta como
  // TEMPLATE — só os slots são preenchidos.
  //
  // O texto do banner não era slot. Ele ia para o documento com o
  // `{jogador}` JÁ RESOLVIDO, e resolvido para vazio, porque no
  // preset não há jogador: o que ficava gravado era "BEM-VINDO",
  // sem variável, e não havia mais o que substituir.
  //
  // O nome de quem abria o menu NUNCA aparecia. Medido em
  // 14/09/2026 percorrendo preset -> documento -> preenchimento.
  it('o nome chega ao jogador pelo caminho do MODELO, que é o do jogo', () => {
    const congelada = buildMainMenu().screens.find((screen) => screen.id === HOME_SCREEN_ID);

    expect(congelada).toBeDefined();

    if (congelada === undefined) {
      return;
    }

    const vista = buildHomeScreen({
      view: view({ player: 'Mateuus' }),
      template: congelada,
    });

    expect(textOf(vista, 'hm-titulo')).toBe('Mateuus');
    expect(textOf(vista, 'hm-ola')).toBe('BEM-VINDO DE VOLTA');
  });

  /**
   * A carga inicial vai ao servidor sem jogador nenhum, e plugin
   * antigo não manda o `steamId`. Sem este cuidado, o banner abria
   * com "BEM-VINDO," e a vírgula pendurada.
   */
  it('sem nome, a saudação toma o lugar dele em vez de deixar um buraco', () => {
    // A carga inicial vai ao servidor sem jogador nenhum, e plugin
    // antigo não manda o `steamId`.
    const congelada = buildMainMenu().screens.find((screen) => screen.id === HOME_SCREEN_ID);

    expect(congelada).toBeDefined();

    if (congelada === undefined) {
      return;
    }

    const vista = buildHomeScreen({ view: view({ player: '' }), template: congelada });

    expect(textOf(vista, 'hm-titulo')).toBe('BEM-VINDO');
    // A linha de cima some inteira: uma linha em branco sobre outra
    // é pior que uma linha só.
    expect(find(vista, 'hm-ola')).toBeUndefined();
  });

  it('a variável vale em qualquer texto, e nas duas pontas', () => {
    expect(applyPlayerName('Olá, {jogador}!', 'Ana')).toBe('Olá, Ana!');
    expect(applyPlayerName('{jogador}, o servidor mudou', '')).toBe('o servidor mudou');
    expect(applyPlayerName('sem variável nenhuma', 'Ana')).toBe('sem variável nenhuma');
  });

  it('a missão pronta pede o resgate, e não o progresso', () => {
    const screen = buildHomeScreen({
      view: view({ quests: [{ title: 'Caçador', progress: '10/10', done: true }] }),
    });

    const rows = walk(find(screen, HOME_SLOTS.questList)?.children ?? []);

    expect(rows.some((element) => element.type === 'label' && element.text === 'RESGATAR')).toBe(true);
  });
});

// ------------------------------------------------------------
//  O QUE ESTE SERVIDOR ESCONDE
// ------------------------------------------------------------

describe('os cartões e o que o servidor esconde', () => {
  it('o cartão só existe se a tela que ele abre existir', () => {
    const menu = buildMainMenu();
    const semLoja = applyHidden(menu, ['tela-loja']);

    expect(cardsOf(menu)).toEqual({ rank: true, offer: true, wipe: true, quest: true });
    expect(cardsOf(semLoja).offer).toBe(false);

    const screen = buildHomeScreen({ view: view(), cards: cardsOf(semLoja) });

    expect(find(screen, HOME_SLOTS.offerName)).toBeUndefined();
    // E os que sobraram dividem a largura entre si: nada de buraco
    // de 25% onde a loja estava.
    const cards = screen.elements.filter((element) => element.id.startsWith('hm-') && element.id !== 'hm-banner');

    expect(cards).toHaveLength(3);
    expect(cards.at(-1)?.rect.anchorMax.x).toBe(1);
  });

  /**
   * A poda é TRANSITIVA desde 07/09/2026: esconder a tela leva o
   * botão que ia até ela. Antes, esconder `tela-loja` sem esconder
   * `nav-loja` deixava um botão que não fazia nada — e com a home
   * mostrando um cartão por assunto, deixaria um cartão inteiro
   * prometendo uma seção que aquele servidor não tem.
   */
  it('esconder a tela leva junto o botão que ia até ela', () => {
    const podado = applyHidden(buildMainMenu(), ['tela-loja']);
    const ids = walk(podado.shell).map((element) => element.id);

    expect(ids).not.toContain('nav-loja');
    expect(ids).toContain('nav-kits');
    expect(podado.screens.some((screen) => screen.id === 'tela-loja')).toBe(false);
  });

  it('a tela de entrada nunca some, nem o botão que leva a ela', () => {
    const podado = applyHidden(buildMainMenu(), [HOME_SCREEN_ID]);

    expect(podado.screens.some((screen) => screen.id === HOME_SCREEN_ID)).toBe(true);
    expect(walk(podado.shell).map((element) => element.id)).toContain('nav-home');
  });
});

// ------------------------------------------------------------
//  O PRESET
// ------------------------------------------------------------

describe('a HOME dentro do menu', () => {
  it('nasce marcada como gerada, senão o plugin nunca a pede', () => {
    const home = buildMainMenu().screens.find((screen) => screen.id === HOME_SCREEN_ID);

    expect(home?.generated).toBe(true);
    // E a marca viaja: é ela que o plugin lê para decidir se pede.
    const payload = toDocumentPayload(buildMainMenu());

    expect(payload.screens[0]?.generated).toBe(true);
  });

  it('o repouso traz as caixas que o agente preenche', () => {
    const home = buildMainMenu().screens.find((screen) => screen.id === HOME_SCREEN_ID);

    // Sem elas, `fillTemplate` não teria onde derramar: ele preenche
    // o que existe e não cria o que falta.
    for (const suffix of Object.values(HOME_SLOTS)) {
      expect(find(home as UiScreen, suffix), suffix).toBeDefined();
    }
  });

  /**
   * ####  A HOME É QUEM PAGA A CARGA INICIAL  ####
   *
   * Só o shell, a tela de ENTRADA e o índice viajam no primeiro
   * envio, e a tela de entrada é esta. Os quatro cartões custaram
   * caro: a carga foi de 29 KB para 37 KB dos 50 KB do frame.
   *
   * O teto é medido em ui.test.ts; aqui está a FOLGA, que é o que
   * avisa antes. Uma tela a 98% passa hoje e estoura no dia em que
   * alguém acrescentar um cartão — e uma carga estourada não dá
   * erro no jogo: o menu não abre.
   *
   * ####  14/09/2026: O CABEÇALHO DO CONCEITO COUBE EM 85%  ####
   *
   * Os cartões ganharam ícone e linha de apoio, e o caminho até
   * caber vale mais que o número final:
   *
   *   - FIEL ao protótipo (traço no canto, quadrado vazado,
   *     símbolo, título, apoio e régua = 6 elementos por cartão):
   *     **45.552 bytes, 91% do frame**. Passaria da trava;
   *   - sem a régua (o respiro separa igual) e com o traço fundido
   *     ao quadrado: 42.692, 85,4%. Ainda acima;
   *   - com o símbolo trocado por ARTE — `image` em vez de
   *     `panel`+`label` —: **42.368, 85%**. Coube, e de quebra o
   *     ícone deixou de depender de um glifo que a
   *     RobotoCondensed não tem.
   *
   * O terceiro passo não era economia: era conserto. Ver
   * `CARD_ICON` em ui-home-screen.ts.
   *
   * ####  14/09/2026: A BORDA E A RÉGUA  ####
   *
   * 46.900 bytes, 94%. Os cartões ganharam borda (um painel cada,
   * porque o CUI não tem borda) e a régua que fecha o cabeçalho
   * (mais um cada). Oito elementos, pedidos depois de ver a tela no
   * jogo e com o custo autorizado.
   *
   * ####  ONDE A GORDURA NÃO ESTÁ  ####
   *
   * Procurei antes de aceitar o número, e o palpite óbvio estava
   * errado: os três MODELOS de modal da loja somam 13.031 bytes no
   * documento, e cheguei a escrever uma poda para tirá-los do
   * envio.
   *
   * Eles já não viajavam. `toDocumentPayload` manda o shell, o
   * ÍNDICE e **só a tela de entrada** — medido: o payload tem uma
   * tela, não doze. A poda rendeu 216 bytes (os ids no índice) e
   * foi desfeita.
   *
   * O peso é o que tem de ser: shell 9.091 e HOME 15.313 em JSON,
   * que viram 46.900 em base64. Não há o que cortar sem cortar
   * desenho.
   *
   * ####  A PARTIR DAQUI, TROCA — NÃO ACRÉSCIMO  ####
   *
   * Restam 3.100 bytes. O critério que permitiu subir a trava três
   * vezes — ela existe para pegar crescimento que ESCALA COM OS
   * DADOS, e esqueleto não escala — chegou ao fim útil dele.
   *
   * Nenhum elemento novo entra sem tirar outro. Na ordem de saída:
   *
   *   1. as linhas de apoio de LOJA e WIPE ("DESTAQUE DO MÊS",
   *      "CALENDÁRIO DO SERVIDOR"): texto fixo, enfeitam e não
   *      informam, ~1.040 bytes. As do ranking e das missões NÃO —
   *      a primeira diz qual ranking, a segunda quantas missões, e
   *      as duas mudam com o estado;
   *   2. a régua dos cartões, ~1.400;
   *   3. a borda, ~1.950 — a peça mais cara e a única puramente
   *      decorativa.
   *
   * E se o crescimento vier de DADOS, a trava não sobe: encurta-se
   * a lista. Essa não tem exceção, porque o pior caso do teste é
   * sempre menor que o pior caso do mundo.
   */
  it('a carga inicial fica com folga confortável', () => {
    const bytes = encodeUiDocPayload({ documents: [toDocumentPayload(buildMainMenu())] }).length;

    expect(bytes).toBeLessThan(UI_DOC_MAX_BYTES * 0.95);
  });

  it('nenhuma ação gravada tem `:` no destino', () => {
    // O `uiDocumentSchema` recusa, e o documento inteiro não grava:
    // o menu sumiria do jogo. O endereço do modal de compra (que TEM
    // `:`) entra só na tela que o agente monta.
    expect(() => uiDocumentSchema.parse(buildMainMenu())).not.toThrow();
  });
});

// ------------------------------------------------------------
//  O PROVEDOR
// ------------------------------------------------------------

describe('o provedor da HOME', () => {
  const document = buildMainMenu();

  /** Sem ranking ligado, sem missões e sem agenda: só a loja responde. */
  const RANKINGS: HomeScreenProviderOptions['rankings'] = {
    metrics: () => [],
    leaderboard: () => Promise.resolve({ rows: [], total: 0 }) as never,
    playerRankings: () => [],
  };

  function provider(
    overrides: Partial<HomeScreenProviderOptions> = {},
  ): ReturnType<typeof createHomeScreenProvider> {
    return createHomeScreenProvider({
      rankings: RANKINGS,
      store: { catalog: () => [{ offers: [OFFER] }] },
      quests: { liveFor: () => [] },
      wipe: null,
      now: () => 1_700_000_000_000,
      ...overrides,
    });
  }

  it('devolve `null` para o endereço que não é dele', async () => {
    const bundle = await provider()({
      serverId: 'pvp1',
      document,
      screenId: 'tela-kits',
      steamId: undefined,
    });

    expect(bundle).toBeNull();
  });

  /**
   * ####  ELA NUNCA CAI NA TELA GRAVADA  ####
   *
   * A tela do documento não é `volatile`: o plugin a guardaria por
   * até cinco minutos, com o "Carregando…" do repouso congelado
   * dentro. O que sai daqui sempre pode ser refeito no clique
   * seguinte.
   */
  it('a resposta é volátil, para o clique seguinte tentar de novo', async () => {
    const bundle = await provider()({
      serverId: 'pvp1',
      document,
      screenId: HOME_SCREEN_ID,
      steamId: undefined,
    });

    expect(bundle?.volatile).toBe(true);
    expect(bundle?.id).toBe(HOME_SCREEN_ID);
  });

  /**
   * Uma leitura que explode não pode levar os outros três cartões
   * junto: o jogador veria a tela inteira dizendo que não deu por
   * causa de algo que ele nem estava olhando.
   */
  it('a loja quebrada não derruba o resto da tela', async () => {
    const quebrada = provider({
      store: {
        catalog: () => {
          throw new Error('banco fora');
        },
      },
    });

    const bundle = await quebrada({
      serverId: 'pvp1',
      document,
      screenId: HOME_SCREEN_ID,
      steamId: undefined,
    });

    const json = JSON.stringify(bundle);

    expect(json).toContain('Não consegui ler a loja agora.');
    // E o cartão do wipe continua lá, com a frase dele.
    expect(json).toContain('Não consegui ler a agenda agora.');
  });
});

// ------------------------------------------------------------
//  O CARTÃO DA LOJA
// ------------------------------------------------------------

describe('o cartão NOVO NA LOJA', () => {
  /** A caixa de um elemento dentro do cartão da loja, em pixels. */
  function boxOf(screen: UiScreen, suffix: string): Box {
    const box = measureElement(screen.elements, (id) => id.endsWith(suffix), CANVAS);

    if (box === null) {
      throw new Error(`o elemento "${suffix}" não está no desenho`);
    }

    return box;
  }

  it('o ícone do item não encosta na régua do cabeçalho', () => {
    const screen = buildHomeScreen({ view: view() });

    const regua = boxOf(screen, 'hm-loja-titulo-regua');
    const icone = boxOf(screen, HOME_SLOTS.offerIcon);

    // ####  ELE PASSAVA POR CIMA DELA  ####
    //
    // Até 14/09/2026 o ícone começava a 48 px do topo do cartão e a
    // régua está a 58: o desenho entregue tinha a arma cortando a
    // linha, encostada no subtítulo. O dono viu na tela e pediu.
    //
    // A folga é medida, e não olhada: o cartão estica com a altura
    // do canvas, e "parece certo aqui" não diz nada sobre a próxima
    // resolução.
    expect(icone.top).toBeGreaterThan(regua.top + regua.height + 20);
  });

  it('o miolo fica CENTRADO, e não pendurado no topo', () => {
    const screen = buildHomeScreen({ view: view() });

    const cartao = boxOf(screen, 'hm-loja');
    const icone = boxOf(screen, HOME_SLOTS.offerIcon);
    const antes = boxOf(screen, HOME_SLOTS.offerOld);

    // O `measureElement` devolve a caixa RELATIVA ao pai, e ícone e
    // preço são filhos do cartão: o meio deles se compara com a
    // metade da ALTURA do cartão, e não com o topo dele no canvas.
    const meioDoBloco = (icone.top + antes.top + antes.height) / 2;

    // O corpo vai da régua ao rodapé, e o centro dele fica 1 px
    // acima do centro do cartão — perto demais para justificar uma
    // segunda âncora. A folga de 4 px é para essa diferença.
    expect(Math.abs(meioDoBloco - cartao.height / 2)).toBeLessThan(4);
  });

  it('a oferta com ARTE PRÓPRIA usa a arte, e não o ícone do jogo', () => {
    // ####  O VIP DE 30 DIAS NÃO TEM ÍCONE NO JOGO  ####
    //
    // Nem o pacote, nem o kit, nem o item nosso. Para esses o admin
    // escolhe uma arte, que sobe ao OrigemZImages com a chave
    // `store.<id>` — e até 14/09/2026 ela aparecia na loja e sumia
    // na entrada, porque o `file` não chegava até aqui.
    const comArte = view({
      offer: {
        offerId: 'vip-30-dias',
        name: 'VIP 30 dias',
        price: 3000,
        oldPrice: null,
        icon: { itemId: 0, skinId: '0', file: 'vip.png' },
        badge: null,
      },
    });

    const desenho = find(buildHomeScreen({ view: comArte }), HOME_SLOTS.offerIcon);

    expect(desenho?.type).toBe('image');
    expect(desenho?.type === 'image' ? desenho.source : null).toEqual({
      kind: 'stored',
      key: 'store.vip-30-dias',
    });
  });

  it('e sem arte própria continua no ícone do jogo, que não custa download', () => {
    const desenho = find(buildHomeScreen({ view: view() }), HOME_SLOTS.offerIcon);

    expect(desenho?.type === 'image' ? desenho.source : null).toEqual({
      kind: 'item',
      itemId: OFFER.icon.itemId,
      skinId: OFFER.icon.skinId,
    });
  });
});
