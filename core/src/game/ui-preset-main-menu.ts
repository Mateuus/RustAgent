// ============================================================
//  ui-preset-main-menu.ts  -  o Menu Principal, pronto.
//
//  ####  POR QUE ELE NASCE DE CÓDIGO, E NÃO DO EDITOR  ####
//
//  São ~130 elementos com âncora, cor e ação em cada um. À mão
//  seriam ~130 chances de errar. Documento é DADO, e dado se gera.
//
//  ####  E POR QUE NO CORE, E NÃO NO PAINEL  ####
//
//  Por duas razões que apontam para o mesmo lugar:
//
//    1. ele precisa NASCER NO PRIMEIRO BOOT, sem ninguém abrir o
//       navegador. Um preset que só existe no bundle do painel não
//       tem como fazer isso;
//    2. o teto do RCON é medido AQUI (ver types/ui-transport.ts), e
//       o teste que garante que a carga inicial cabe precisa do
//       preset ao lado dele. No painel não há vitest.
//
//  Daqui em diante ele é um documento como qualquer outro:
//  editável, apagável, e sem nada de especial no banco.
//
//  ------------------------------------------------------------
//  ####  O CABEÇALHO É SHELL, E ISSO É O QUE TIRA O PISCAR  ####
//
//  Trocar de tela no CUI redesenha tudo. Com o cabeçalho repetido
//  nas sete telas, o jogador veria o menu fechar e reabrir a cada
//  clique — e o documento carregaria sete cópias da mesma moldura,
//  que é o que estourava o teto do RCON.
//
//  Aqui véu, moldura e cabeçalho ficam no `shell`, desenhados UMA
//  vez, e cada tela traz só o conteúdo, que entra no slot.
//
//  ------------------------------------------------------------
//  ####  OS IDS SÃO FIXOS E LEGÍVEIS, DE PROPÓSITO  ####
//
//  `nav-loja`, `tela-kits`. É o que a tela de Configurações mostra
//  quando pergunta "o que ESTE servidor esconde?" — uma lista de
//  ids sorteados ali seria uma lista de códigos que ninguém
//  reconhece.
//
//  ------------------------------------------------------------
//  ####  TRÊS COISAS QUE O CUI NÃO FAZ  ####
//
//  1. `scale` em hover NÃO EXISTE. O Unity UI expõe um ColorBlock
//     — cor por estado — e nada de transform. Onde se quer
//     "cresce ao passar o mouse", o que há é troca de cor.
//  2. Não há BORDA em elemento. Uma borda de 1px se faz com um
//     painel na cor da borda e outro 1px menor por cima — é o que
//     `borderedPanel` produz.
//  3. Não há ícone de biblioteca. Ícone é sprite do jogo ou
//     imagem; onde caberia um, há texto.
// ============================================================

import type { UiAction, UiDocument, UiElement, UiScreen } from '../types/ui-document.js';

import {
  BUNDLE_TEMPLATE_ID,
  BUY_TEMPLATE_ID,
  RESULT_TEMPLATE_ID,
} from './ui-store-template.js';

/** O identificador do Menu Principal. É o `slug` no banco. */
export const MAIN_MENU_SLUG = 'menu-principal';

// ------------------------------------------------------------
//  TOKENS — os mesmos hex de panel/src/app/globals.css
//
//  Não são "parecidos": são os valores copiados, e o comentário de
//  cada um diz de qual variável ele veio, para o dia em que a
//  paleta mudar.
// ------------------------------------------------------------
const C = {
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
  /** --olive — o verde de "deu certo" */
  olive: '#6B7F5B',
  /** --amber — a cor do OZCoin, e só dele */
  amber: '#E6B265',
  /** --bg */
  bg: '#0F0F0F',
  white: '#FFFFFF',
} as const;

/**
 * O véu sobre o jogo.
 *
 * Preto a 82%: escurece o suficiente para o menu ficar legível e
 * pouco o bastante para ainda se ver o jogo atrás. O desfoque
 * entra pelo `material` — e ele SÓ funciona com alfa abaixo de 1,
 * motivo pelo qual esta cor não é opaca.
 */
const OVERLAY = '#000000D1';
const BLUR_MATERIAL = 'assets/content/ui/uibackgroundblur.mat';

/** Medidas, na base 1280x720 do CUI. */
const LAYOUT = {
  headerHeight: 76,
  /** A barra de acento vermelha sob o cabeçalho. */
  accentHeight: 2,
  contentPadding: 30,
  navButtonHeight: 36,
  navGap: 4,
  edgePadding: 16,
} as const;

// ------------------------------------------------------------
//  Construtores de retângulo
// ------------------------------------------------------------

type Rect = UiElement['rect'];

/** Estica no pai com uma margem em cada lado. */
function inset(left: number, top: number, right: number, bottom: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    // Y do Unity cresce para CIMA: `bottom` entra no min e `top`
    // sai do max. Trocar os dois é o erro clássico, e ele só
    // aparece quando alguém ancora algo embaixo.
    offsetMin: { x: left, y: bottom },
    offsetMax: { x: -right, y: -top },
  };
}

/** Faixa colada no topo do pai, com altura fixa. */
function topBar(height: number, offsetFromTop = 0): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(offsetFromTop + height) },
    offsetMax: { x: 0, y: -offsetFromTop },
  };
}

/** Faixa vertical colada à esquerda — a barra de acento. */
function leftBar(width: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: width, y: 0 },
  };
}

// ------------------------------------------------------------
//  Construtores de elemento
//
//  São o "sistema de componentes" do preset: em vez de inventar um
//  tipo novo no modelo, cada função devolve os elementos que já
//  existem, com o estilo do painel aplicado.
// ------------------------------------------------------------

function panel(
  id: string,
  name: string,
  rect: Rect,
  color: string,
  children: readonly UiElement[] = [],
  material: string | null = null,
): UiElement {
  return {
    id,
    name,
    type: 'panel',
    rect,
    children,
    color,
    sprite: null,
    imageType: 'Simple',
    material,
  };
}

/**
 * Painel com borda de 1px — a moldura do painel web.
 *
 * O CUI não tem borda, então ela é um painel na cor da borda com
 * outro 1px menor por cima. Dois elementos para uma linha, mas é o
 * que dá ao menu a mesma moldura de 1px que o painel usa em todo
 * bloco.
 */
function borderedPanel(
  id: string,
  name: string,
  rect: Rect,
  fill: string,
  children: readonly UiElement[] = [],
): UiElement {
  return panel(id, name, rect, C.border, [
    panel(`${id}-i`, `${name} (interior)`, inset(1, 1, 1, 1), fill, children),
  ]);
}

interface LabelOptions {
  readonly size?: number;
  readonly color?: string;
  readonly align?: Extract<UiElement, { type: 'label' }>['align'];
  readonly font?: Extract<UiElement, { type: 'label' }>['font'];
}

function label(
  id: string,
  name: string,
  rect: Rect,
  text: string,
  options: LabelOptions = {},
): UiElement {
  return {
    id,
    name,
    type: 'label',
    rect,
    children: [],
    text,
    fontSize: options.size ?? 14,
    // RobotoCondensed-Bold é a fonte dos títulos e rótulos do
    // painel (font-condensed + uppercase), e é o padrão do CUI.
    font: options.font ?? 'RobotoCondensed-Bold.ttf',
    color: options.color ?? C.text,
    align: options.align ?? 'MiddleCenter',
  };
}

/**
 * Botão no estilo do painel.
 *
 * `nav` espelha o item da barra lateral (transparente, texto
 * cinza, fundo em `--surface-2` sob o cursor) e `close` é o
 * `ghost` com hover vermelho.
 *
 * O estado ATIVO não é uma variante: ele é DECLARADO por
 * `activeOnScreenId` e aplicado pelo agente, porque o shell não é
 * redesenhado ao navegar — ver `screenUpdatesToCui`.
 */
function button(
  id: string,
  name: string,
  rect: Rect,
  text: string,
  action: UiAction,
  variant: 'nav' | 'close' | 'comprar',
  size = 12,
  activeOnScreenId: string | null = null,
): UiElement {
  // `comprar` é a única variante com fundo: ela é a ação que move
  // dinheiro, e uma ação irreversível não pode ter o mesmo peso
  // visual de "cancelar".
  const style =
    variant === 'comprar'
      ? { color: C.rust, hover: '#D4553FFF', pressed: '#A83525FF', text: C.white }
      : variant === 'nav'
        ? { color: '#26262600', hover: C.surface2, pressed: '#1B1B1BFF', text: C.textMuted }
        : { color: '#26262600', hover: C.rust, pressed: '#A83525FF', text: C.textMuted };

  return {
    id,
    name,
    type: 'button',
    rect,
    children: [],
    color: style.color,
    sprite: null,
    text,
    fontSize: size,
    font: 'RobotoCondensed-Bold.ttf',
    textColor: style.text,
    align: 'MiddleCenter',
    action,
    hoverColor: style.hover,
    pressedColor: style.pressed,
    // Fundo vermelho e texto branco: o mesmo par da variante
    // `danger` do painel, escolhida lá por contraste (5.13:1).
    activeColor: activeOnScreenId === null ? null : C.rust,
    activeTextColor: activeOnScreenId === null ? null : C.white,
    activeOnScreenId,
  };
}

// ------------------------------------------------------------
//  A NAVEGAÇÃO
// ------------------------------------------------------------

interface NavEntry {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  /** O que a página mostra enquanto ninguém a preencheu. */
  readonly hint: string;
}

const HOME: NavEntry = {
  id: 'home',
  label: 'HOME',
  width: 60,
  hint: 'O banner e as novidades da rede.',
};

const NAV: readonly NavEntry[] = [
  { id: 'loja', label: 'LOJA', width: 74, hint: 'As ofertas da loja entram aqui.' },
  {
    id: 'calendario',
    label: 'CALENDÁRIO',
    width: 108,
    hint: 'Wipes e eventos programados entram aqui.',
  },
  { id: 'eventos', label: 'EVENTOS', width: 90, hint: 'Os eventos ativos entram aqui.' },
  { id: 'regras', label: 'REGRAS', width: 84, hint: 'As regras do servidor entram aqui.' },
  { id: 'kits', label: 'KITS', width: 66, hint: 'Os kits disponíveis por nível entram aqui.' },
  { id: 'ranking', label: 'RANKING', width: 90, hint: 'O ranking de jogadores entra aqui.' },
];

/**
 * O Discord não é uma tela.
 *
 * O jogo não abre navegador a partir de um botão de CUI, então não
 * há "página do Discord" a mostrar. O que servidores fazem é rodar
 * um comando de chat que imprime o convite — e é isso que o botão
 * faz. Trocar o comando é editar o botão, no editor.
 */
const DISCORD_COMMAND = '/discord';

const SCREEN_ID = (entry: string): string => `tela-${entry}`;

/** Onde as telas são penduradas. Ver `contentSlotId`. */
const CONTENT_SLOT = 'conteudo';
/** Onde os modais aparecem, POR CIMA do conteúdo. */
const MODAL_SLOT = 'modais';

// ------------------------------------------------------------
//  O SHELL
// ------------------------------------------------------------

function buildShell(): UiElement[] {
  const nav: UiElement[] = [];

  // Os botões são posicionados por deslocamento acumulado a partir
  // da BORDA ESQUERDA, com âncora à esquerda: assim a barra inteira
  // gruda na esquerda e não se deforma quando a tela muda de
  // proporção (ultrawide, 4K).
  let cursor = LAYOUT.edgePadding;

  const navRect = (width: number): Rect => {
    const rect: Rect = {
      anchorMin: { x: 0, y: 0.5 },
      anchorMax: { x: 0, y: 0.5 },
      offsetMin: { x: cursor, y: -LAYOUT.navButtonHeight / 2 },
      offsetMax: { x: cursor + width, y: LAYOUT.navButtonHeight / 2 },
    };

    cursor += width + LAYOUT.navGap;

    return rect;
  };

  for (const entry of [HOME, ...NAV]) {
    nav.push(
      button(
        `nav-${entry.id}`,
        entry.label,
        navRect(entry.width),
        entry.label,
        { id: `ir-${entry.id}`, kind: 'navigate', screenId: SCREEN_ID(entry.id) },
        'nav',
        12,
        // Fica vermelho quando a tela dele estiver aberta.
        SCREEN_ID(entry.id),
      ),
    );
  }

  nav.push(
    button(
      'nav-discord',
      'DISCORD',
      navRect(88),
      'DISCORD',
      { id: 'ir-discord', kind: 'chat', command: DISCORD_COMMAND },
      'nav',
    ),

    // ####  O VIP DO JOGADOR  ####
    //
    // Duas linhas à ESQUERDA da moeda: o nível em cima, quanto falta
    // embaixo. Nascem VAZIOS — o agente os preenche quando a
    // interface abre, pelo mesmo caminho do saldo (`#OZBAL#`).
    //
    // Vazio e não "SEM VIP": este cabeçalho é empurrado ao servidor
    // sem jogador nenhum, e um texto fixo aqui seria lido como o
    // estado de quem abriu o menu.
    label(
      'vip-word',
      'VIP (palavra)',
      {
        anchorMin: { x: 1, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: -300, y: 0 },
        offsetMax: { x: -274, y: 15 },
      },
      '',
      // ####  AS DUAS LINHAS COMEÇAM NO MESMO X  ####
      //
      // Alinhar à direita parecia natural (o cabeçalho inteiro gruda
      // ali), mas o nível tem largura VARIÁVEL — BRONZE é maior que
      // OURO — e o prazo ficava desencontrado dele. Pela esquerda, as
      // duas nascem no mesmo ponto e o que varia sobra do lado
      // direito, onde ninguém compara.
      { size: 12, color: C.text, align: 'MiddleLeft' },
    ),
    // O NÍVEL, na cor dele — o agente manda a cor junto com o texto,
    // porque ela muda com o nível.
    label(
      'vip-tier',
      'VIP (nível)',
      {
        anchorMin: { x: 1, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: -272, y: 0 },
        offsetMax: { x: -152, y: 15 },
      },
      '',
      { size: 12, color: C.amber, align: 'MiddleLeft' },
    ),
    label(
      'vip-left',
      'VIP (prazo)',
      {
        anchorMin: { x: 1, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: -300, y: -15 },
        offsetMax: { x: -152, y: -1 },
      },
      '',
      { size: 10, color: C.textMuted, align: 'MiddleLeft' },
    ),

    // ####  A MOEDA  ####
    //
    // O PNG vive em `Assets\ui\ozcoin.png` e é o agente que o entrega
    // ao servidor; aqui fica só a chave. Ver game/ui-images.ts para
    // por que não é URL.
    //
    // Um pouco maior que o texto ao lado porque a moeda é redonda: um
    // círculo da mesma altura de uma maiúscula parece menor do que é.
    {
      id: 'coin',
      name: 'OZCoin (ícone)',
      type: 'image',
      rect: {
        anchorMin: { x: 1, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: -138, y: -12 },
        offsetMax: { x: -114, y: 12 },
      },
      source: { kind: 'stored', key: 'ozcoin' },
      // Branco: o `color` de uma imagem TINGE. Qualquer outra cor
      // aqui pintaria a moeda por cima.
      color: C.white,
      children: [],
    },
    label(
      'coin-value',
      'OZCoin (valor)',
      {
        anchorMin: { x: 1, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: -108, y: -12 },
        offsetMax: { x: -52, y: 12 },
      },
      // ####  O TRAÇO É PROPOSITAL  ####
      //
      // Esta tela é EMPURRADA ao servidor sem jogador nenhum — não há
      // saldo a preencher aqui. O plugin pede o valor ao abrir a
      // interface e o troca no lugar.
      //
      // Um número fixo seria pior que um traço: o jogador o leria
      // como se fosse o saldo dele.
      '—',
      { size: 17, color: C.amber, align: 'MiddleLeft' },
    ),

    button(
      'btn-fechar',
      'Fechar',
      {
        // Âncora à DIREITA, deslocamento negativo: gruda no canto
        // em qualquer largura de tela.
        anchorMin: { x: 1, y: 0.5 },
        anchorMax: { x: 1, y: 0.5 },
        offsetMin: { x: -LAYOUT.edgePadding - 32, y: -16 },
        offsetMax: { x: -LAYOUT.edgePadding, y: 16 },
      },
      'X',
      { id: 'fechar', kind: 'close' },
      'close',
      15,
    ),
  );

  const contentTop = LAYOUT.headerHeight + LAYOUT.accentHeight + LAYOUT.contentPadding;

  return [
    // O véu, com o desfoque. Ele é o fundo de tudo.
    panel('veu', 'Véu', inset(0, 0, 0, 0), OVERLAY, [], BLUR_MATERIAL),

    // A moldura: o menu ocupa 88% da tela.
    borderedPanel(
      'moldura',
      'Moldura',
      {
        anchorMin: { x: 0.06, y: 0.06 },
        anchorMax: { x: 0.94, y: 0.94 },
        offsetMin: { x: 0, y: 0 },
        offsetMax: { x: 0, y: 0 },
      },
      C.surface,
      [
        panel('cabecalho', 'Cabeçalho', topBar(LAYOUT.headerHeight), C.surface2, nav),
        // A barra de acento. O painel usa vermelho como acento (a
        // barra vertical antes de cada título); aqui ela é
        // horizontal e fecha o cabeçalho.
        panel('cabecalho-acento', 'Acento', topBar(LAYOUT.accentHeight, LAYOUT.headerHeight), C.rust),

        // ####  O SLOT DE CONTEÚDO  ####
        //
        // É aqui que cada tela é pendurada. Transparente de
        // propósito: ele é um lugar, não um desenho.
        panel(
          CONTENT_SLOT,
          'Conteúdo',
          inset(LAYOUT.contentPadding, contentTop, LAYOUT.contentPadding, LAYOUT.contentPadding),
          '#00000000',
        ),

        // ####  O SLOT DE MODAL NÃO ENTRA NO SHELL  ####
        //
        // Ele já esteve aqui, cobrindo a tela inteira e
        // transparente — e ENGOLIA TODOS OS CLIQUES. No Unity,
        // alpha 0 NÃO desliga o raycast: um painel invisível por
        // cima continua interceptando, e o clique nem sai do
        // cliente. O menu abria bonito e nenhum botão respondia,
        // nem o de fechar.
        //
        // Quem cria o contêiner é o PLUGIN, ao abrir um modal, e
        // ele o destrói ao fechar (ver `ModalContainerJson` em
        // OrigemZUI.cs). Enquanto não há modal, não há nada por
        // cima; quando há, bloquear o que está atrás passa a ser o
        // comportamento certo.
        //
        // `modalSlotId` continua declarado no documento: ele é o
        // NOME que o plugin dá a esse contêiner, e o mesmo que a
        // conversão usa como `parent` do conteúdo do modal.
      ],
    ),
  ];
}

// ------------------------------------------------------------
//  AS TELAS
// ------------------------------------------------------------

/**
 * A Home: banner + três cartões.
 *
 * Os elementos JÁ nascem dentro do slot do shell, então o
 * retângulo é relativo a ele — não à tela inteira.
 */
function buildHome(): UiElement[] {
  const bannerHeight = 150;
  const gap = 12;

  const cards = [
    { title: 'WIPE', body: 'O próximo wipe e o que ele leva.' },
    { title: 'EVENTOS', body: 'O que está acontecendo agora no servidor.' },
    { title: 'LOJA', body: 'As novidades e promoções da loja.' },
  ];

  return [
    borderedPanel('home-banner', 'Banner', topBar(bannerHeight), C.surface, [
      panel('home-banner-acento', 'Acento', leftBar(3), C.rust),
      label(
        'home-banner-titulo',
        'Título',
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 20, y: -70 },
          offsetMax: { x: -20, y: -34 },
        },
        'BEM-VINDO',
        { size: 26, align: 'MiddleLeft' },
      ),
      label(
        'home-banner-sub',
        'Subtítulo',
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 20, y: -100 },
          offsetMax: { x: -20, y: -72 },
        },
        'Edite este texto no painel, em Interface.',
        { size: 14, color: C.textMuted, align: 'MiddleLeft', font: 'RobotoCondensed-Regular.ttf' },
      ),
    ]),

    // Três cartões lado a lado. A largura vem de FRAÇÃO da largura
    // disponível, então eles acompanham a tela em vez de ter
    // tamanho fixo.
    ...cards.map((card, index) => {
      const width = 1 / cards.length;

      return borderedPanel(
        `home-cartao-${String(index + 1)}`,
        `Cartão ${String(index + 1)}`,
        {
          anchorMin: { x: width * index, y: 0 },
          anchorMax: { x: width * (index + 1), y: 1 },
          offsetMin: { x: index === 0 ? 0 : gap / 2, y: 0 },
          offsetMax: {
            x: index === cards.length - 1 ? 0 : -gap / 2,
            y: -(bannerHeight + gap),
          },
        },
        C.surface,
        [
          panel(`home-cartao-${String(index + 1)}-acento`, 'Acento', topBar(2), C.rust),
          label(
            `home-cartao-${String(index + 1)}-titulo`,
            'Título',
            {
              anchorMin: { x: 0, y: 1 },
              anchorMax: { x: 1, y: 1 },
              offsetMin: { x: 14, y: -44 },
              offsetMax: { x: -14, y: -16 },
            },
            card.title,
            { size: 15, align: 'MiddleLeft' },
          ),
          label(
            `home-cartao-${String(index + 1)}-texto`,
            'Texto',
            inset(14, 52, 14, 14),
            card.body,
            {
              size: 12,
              color: C.textMuted,
              align: 'UpperLeft',
              font: 'RobotoCondensed-Regular.ttf',
            },
          ),
        ],
      );
    }),
  ];
}

/**
 * Uma página com título e um bloco vazio.
 *
 * Serve às seções que ainda não têm conteúdo definido. É melhor
 * que um retângulo mudo: quem navega até ela sabe onde está e que
 * ali vai entrar algo.
 */
function buildPlaceholder(entry: NavEntry): UiElement[] {
  return [
    label(`${entry.id}-titulo`, 'Título', topBar(30), entry.label, {
      size: 20,
      align: 'MiddleLeft',
    }),
    borderedPanel(`${entry.id}-corpo`, 'Conteúdo', inset(0, 42, 0, 0), C.surface, [
      label(`${entry.id}-aviso`, 'Aviso', inset(20, 20, 20, 20), entry.hint, {
        size: 13,
        color: C.textMuted,
        align: 'MiddleCenter',
        font: 'RobotoCondensed-Regular.ttf',
      }),
    ]),
  ];
}

// ============================================================
//  OS MODAIS DA LOJA
//
//  ####  ELES SÃO MODELOS, E NÃO TELAS  ####
//
//  O agente PREENCHE estes desenhos com o item, o total e as ações —
//  ver game/ui-store-template.ts. O que está escrito aqui é exemplo:
//  "Nome do item" vira "Assault Rifle" na hora do clique.
//
//  A divisão é deliberada. Posição, cor, fonte e tamanho são do
//  ADMIN, que os edita no painel sem tocar em TypeScript. As AÇÕES
//  são do agente, sempre: elas carregam o `offerId` e a quantidade
//  que serão cobrados, e vindas do documento um admin distraído
//  mudaria o preço de uma compra.
//
//  ####  OS IDS TERMINAM EM SUFIXOS RECONHECIDOS  ####
//
//  `mcnome`, `mbtotal`, `mrok`. Renomear um deles no editor faz
//  aquele campo parar de ser preenchido — em silêncio, com o texto
//  de exemplo na tela. É o preço de o admin poder mover tudo o
//  resto.
// ============================================================

/** O título no topo da caixa, comum aos três modais. */
function modalHeader(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 22, y: -46 },
    offsetMax: { x: -22, y: -14 },
  };
}

/** O véu escuro e a caixa no meio, com a faixa de acento. */
function modalBox(
  prefix: string,
  width: number,
  height: number,
  accent: string,
  children: readonly UiElement[],
): UiElement[] {
  return [
    panel(`${prefix}-veu`, 'Véu', inset(0, 0, 0, 0), '#000000B3', [
      panel(
        `${prefix}-caixa`,
        'Caixa',
        {
          anchorMin: { x: 0.5, y: 0.5 },
          anchorMax: { x: 0.5, y: 0.5 },
          offsetMin: { x: -width / 2, y: -height / 2 },
          offsetMax: { x: width / 2, y: height / 2 },
        },
        C.surface,
        [panel(`${prefix}-acento`, 'Acento', topBar(3), accent), ...children],
      ),
    ]),
  ];
}

/**
 * O par número + moeda, com a moeda fixa à direita.
 *
 * São DOIS elementos porque o CUI não tem texto com imagem embutida
 * — e por isso eles precisam ser posicionados um ao lado do outro à
 * mão.
 */
function coinValue(
  suffix: string,
  name: string,
  bottom: number,
  height: number,
  size: number,
  color: string,
): UiElement[] {
  const icon = size + 2;

  return [
    label(
      suffix,
      name,
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: 22, y: bottom },
        offsetMax: { x: -(22 + icon + 5), y: bottom + height },
      },
      '0',
      { size, color, align: 'MiddleRight' },
    ),
    {
      id: `${suffix}coin`,
      name: `${name} (moeda)`,
      type: 'image',
      rect: {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -(22 + icon), y: bottom + (height - icon) / 2 },
        offsetMax: { x: -22, y: bottom + (height + icon) / 2 },
      },
      source: { kind: 'stored', key: 'ozcoin' },
      color: C.white,
      children: [],
    },
  ];
}

/** O modal de um item solto: o único com seletor de quantidade. */
function buildBuyModal(): UiElement[] {
  const stepper = (id: string, glyph: string, left: number): UiElement =>
    button(
      id,
      glyph === '+' ? 'Mais' : 'Menos',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: left, y: -142 },
        offsetMax: { x: left + 28, y: -114 },
      },
      glyph,
      // Ação de EXEMPLO: o agente a substitui pela de verdade, com a
      // quantidade certa. Ver ui-store-template.ts.
      { id: `${id}-a`, kind: 'modal.close' },
      'nav',
      15,
    );

  return modalBox('mc', 420, 285, C.rust, [
    label('mcnome', 'Nome do item', modalHeader(), 'Nome do item', { size: 16 }),

    {
      id: 'mcicone',
      name: 'Ícone do item',
      type: 'image',
      rect: {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: 22, y: -140 },
        offsetMax: { x: 102, y: -60 },
      },
      // O agente troca pelo item da oferta.
      source: { kind: 'item', itemId: 1545779598, skinId: '0' },
      color: C.white,
      children: [],
    },

    label(
      'mcdesc',
      'Descrição',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 116, y: -86 },
        offsetMax: { x: -22, y: -62 },
      },
      'Uma unidade por compra',
      { size: 12, color: C.textMuted, align: 'MiddleLeft', font: 'RobotoCondensed-Regular.ttf' },
    ),

    label(
      'mc-rotulo-qtd',
      'Rótulo quantidade',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 116, y: -112 },
        offsetMax: { x: -22, y: -92 },
      },
      'QUANTIDADE',
      { size: 10, color: C.textMuted, align: 'MiddleLeft' },
    ),

    stepper('mcmenos', '−', 116),

    panel(
      'mc-caixa-qtd',
      'Caixa da quantidade',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: 148, y: -142 },
        offsetMax: { x: 196, y: -114 },
      },
      C.bg,
      [label('mcqtd', 'Quantidade', inset(0, 0, 0, 0), '1', { size: 14 })],
    ),

    stepper('mcmais', '+', 200),

    label(
      'mc-rotulo-total',
      'Rótulo total',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 78 },
        offsetMax: { x: 120, y: 104 },
      },
      'TOTAL',
      { size: 11, color: C.textMuted, align: 'MiddleLeft' },
    ),

    ...coinValue('mctotal', 'Total', 78, 26, 18, C.amber),
    ...coinValue('mcsaldo', 'Saldo', 54, 18, 11, C.textMuted),

    button(
      'mccancelar',
      'Cancelar',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 16 },
        offsetMax: { x: 110, y: 46 },
      },
      'CANCELAR',
      { id: 'mccancelar-a', kind: 'modal.close' },
      'nav',
      12,
    ),

    button(
      'mccomprar',
      'Comprar',
      {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -170, y: 16 },
        offsetMax: { x: -22, y: 46 },
      },
      'CONFIRMAR COMPRA',
      // Substituída pelo agente pela ação de compra de verdade.
      { id: 'mccomprar-a', kind: 'modal.close' },
      'comprar',
      12,
    ),
  ]);
}

/**
 * O modal de kit, VIP e veículo.
 *
 * Sem seletor de quantidade: "3x Kit Base" não é uma compra que
 * alguém queira fazer, e "2x VIP Ouro 30 dias" é ambíguo — vira 60
 * dias ou dois VIPs?
 */
function buildBundleModal(): UiElement[] {
  return modalBox('mb', 420, 340, C.rust, [
    label('mbnome', 'Nome', modalHeader(), 'Nome do pacote', { size: 16 }),

    {
      id: 'mbicone',
      name: 'Ícone',
      type: 'image',
      rect: {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: 22, y: -140 },
        offsetMax: { x: 102, y: -60 },
      },
      source: { kind: 'item', itemId: 1189981699, skinId: '0' },
      color: C.white,
      children: [],
    },

    label(
      'mbdesc',
      'Resumo',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 116, y: -86 },
        offsetMax: { x: -22, y: -62 },
      },
      '3 itens no kit',
      { size: 12, color: C.textMuted, align: 'MiddleLeft', font: 'RobotoCondensed-Regular.ttf' },
    ),

    label(
      'mbtitulo',
      'Título da lista',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -168 },
        offsetMax: { x: -22, y: -152 },
      },
      'O QUE VEM NO KIT',
      { size: 10, color: C.textMuted, align: 'MiddleLeft' },
    ),

    // ####  O SLOT  ####
    //
    // Nasce VAZIO de propósito. Mova e redimensione à vontade — é a
    // área que o agente preenche com o conteúdo do pacote, e um
    // desenho fixo não teria como abrir espaço para três itens hoje e
    // sete amanhã.
    panel(
      'mblista',
      'Lista (preenchida pelo agente)',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -304 },
        offsetMax: { x: -22, y: -172 },
      },
      '#00000000',
    ),

    label(
      'mb-rotulo-total',
      'Rótulo total',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 78 },
        offsetMax: { x: 120, y: 104 },
      },
      'TOTAL',
      { size: 11, color: C.textMuted, align: 'MiddleLeft' },
    ),

    ...coinValue('mbtotal', 'Total', 78, 26, 18, C.amber),

    label(
      'mbsaldo',
      'Saldo',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: 22, y: 54 },
        offsetMax: { x: -22, y: 72 },
      },
      'Seu saldo: 0',
      { size: 11, color: C.textMuted, align: 'MiddleRight' },
    ),

    button(
      'mbcancelar',
      'Cancelar',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 16 },
        offsetMax: { x: 110, y: 46 },
      },
      'CANCELAR',
      { id: 'mbcancelar-a', kind: 'modal.close' },
      'nav',
      12,
    ),

    button(
      'mbcomprar',
      'Comprar',
      {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -170, y: 16 },
        offsetMax: { x: -22, y: 46 },
      },
      'CONFIRMAR COMPRA',
      { id: 'mbcomprar-a', kind: 'modal.close' },
      'comprar',
      12,
    ),
  ]);
}

/**
 * O aviso do desfecho.
 *
 * ####  POR QUE ELE É UM MODAL, E NÃO UMA LINHA DE CHAT  ####
 *
 * A mensagem de chat aparece atrás do menu aberto, no canto, e some
 * sozinha. Quem acabou de gastar OZCoin fica olhando a loja sem
 * saber se funcionou — e clica de novo. O modal exige um OK.
 */
function buildResultModal(): UiElement[] {
  return modalBox('mr', 400, 190, C.olive, [
    label('mrtitulo', 'Título', modalHeader(), 'COMPRA CONCLUÍDA', {
      size: 15,
      color: C.olive,
      align: 'MiddleLeft',
    }),

    label(
      'mrmsg',
      'Mensagem',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: 60 },
        offsetMax: { x: -22, y: -52 },
      },
      'O que aconteceu com a compra aparece aqui.',
      { size: 13, align: 'UpperLeft', font: 'RobotoCondensed-Regular.ttf' },
    ),

    label(
      'mrsaldo',
      'Saldo',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 16 },
        offsetMax: { x: 200, y: 44 },
      },
      'Saldo: 0',
      { size: 12, color: C.amber, align: 'MiddleLeft' },
    ),

    button(
      'mrok',
      'OK',
      {
        anchorMin: { x: 1, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: -110, y: 16 },
        offsetMax: { x: -22, y: 44 },
      },
      'OK',
      { id: 'mrok-a', kind: 'modal.close' },
      'nav',
      12,
    ),
  ]);
}

// ------------------------------------------------------------
//  O DOCUMENTO
// ------------------------------------------------------------

export interface MainMenuOptions {
  /** O comando de chat que abre. SEM a barra: `menu` vira `/menu`. */
  readonly command?: string;
  /** `null` = todo mundo abre. */
  readonly permission?: string | null;
}

/**
 * Monta o Menu Principal inteiro.
 *
 * O resultado é DETERMINÍSTICO: as mesmas opções produzem o mesmo
 * documento, byte a byte. É o que torna o teste de tamanho útil e
 * o que permite recriar o preset para comparar com o que está
 * gravado.
 */
export function buildMainMenu(options: MainMenuOptions = {}): UiDocument {
  const screens: UiScreen[] = [
    { id: SCREEN_ID(HOME.id), name: HOME.label, kind: 'page', elements: buildHome() },
    ...NAV.map(
      (entry): UiScreen => ({
        id: SCREEN_ID(entry.id),
        name: entry.label,
        kind: 'page',
        elements: buildPlaceholder(entry),
      }),
    ),

    // ####  OS MODAIS DA LOJA  ####
    //
    // Eles NÃO são navegáveis: nenhum botão do menu leva a eles. São
    // MODELOS que o agente preenche na hora do clique — ver
    // game/ui-store-template.ts.
    //
    // Ficam no documento (e não no código do gerador) para que o
    // admin possa mover, recolorir e redimensionar tudo no editor.
    // Apagá-los é legítimo: o gerador cai no layout embutido.
    //
    // Eles também não pesam na carga inicial: só a tela de ENTRADA
    // viaja nela — o resto vai no índice, com id e nome.
    { id: BUY_TEMPLATE_ID, name: 'Modal · comprar item', kind: 'modal', elements: buildBuyModal() },
    {
      id: BUNDLE_TEMPLATE_ID,
      name: 'Modal · comprar pacote',
      kind: 'modal',
      elements: buildBundleModal(),
    },
    {
      id: RESULT_TEMPLATE_ID,
      name: 'Modal · resultado',
      kind: 'modal',
      elements: buildResultModal(),
    },
  ];

  return {
    id: MAIN_MENU_SLUG,
    name: 'Menu Principal',
    command: options.command ?? 'menu',
    permission: options.permission ?? null,
    // `Overall` fica por cima de tudo, inclusive do HUD. É onde um
    // menu de tela cheia pertence.
    layer: 'Overall',
    // Sem cursor não há como clicar em botão.
    cursor: true,
    // 0,15 s: rápido o bastante para não parecer travado e lento o
    // bastante para a interface não aparecer de estalo.
    fadeIn: 0.15,
    shell: buildShell(),
    contentSlotId: CONTENT_SLOT,
    modalSlotId: MODAL_SLOT,
    entryScreenId: SCREEN_ID(HOME.id),
    screens,
  };
}

/**
 * Os modelos que a rota de criação aceita.
 *
 * Um mapa, e não um `if`: acrescentar um preset novo é acrescentar
 * uma linha, e a lista de chaves é o que a tela oferece.
 */
export const UI_PRESETS: Readonly<Record<string, () => UiDocument>> = {
  [MAIN_MENU_SLUG]: () => buildMainMenu(),
};

