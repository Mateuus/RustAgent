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
  buildDiscordScreen,
  DISCORD_COMMAND,
  DISCORD_SCREEN_ID,
} from './ui-discord-screen.js';
import { defaultStreamerProfile } from '../types/streamer.js';
import {
  buildStreamerScreen,
  STREAMER_SCREEN_ID,
  STREAMER_TAB_ID,
  STREAMER_TAB_LABEL,
} from './ui-streamer-screen.js';
import { CALENDAR_SCREEN_ID } from './ui-calendar-screen.js';
import { buildHomeScreen, emptyHomeView, HOME_SCREEN_ID } from './ui-home-screen.js';
import { KITS_SCREEN_ID } from './ui-kits-screen.js';
import { buildQuestsScreen, emptyQuestsView, QUESTS_SCREEN_ID } from './ui-quests-screen.js';
import { buildRankingScreen, emptyRankingView } from './ui-ranking-screen.js';
import {
  buildTeamScreen,
  TEAM_COMMANDS,
  TEAM_SCREEN_ID,
  TEAM_TAB_LABEL,
} from './ui-team-screen.js';
import { buildRulesScreen, emptyRulesView, RULES_COMMAND, RULES_SCREEN_ID } from './ui-rules-screen.js';
import {
  BUNDLE_TEMPLATE_ID,
  BUY_TEMPLATE_ID,
  RESULT_TEMPLATE_ID,
} from './ui-store-template.js';
// A régua do texto é a mesma do resto do menu: uma segunda
// estimativa aqui daria abas com largura diferente das etiquetas
// das telas, medidas pela mesma fonte.
import { textWidth } from './ui-widgets.js';

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

/**
 * Medidas, na base 1280x720 do CUI.
 *
 * ####  O CABEÇALHO TEM DUAS FAIXAS DESDE 14/09/2026  ####
 *
 * Ele era uma faixa só, com as abas à esquerda e o saldo, o VIP e
 * o fechar à direita — tudo na mesma linha, disputando o mesmo
 * olhar. Quem abria o menu para ver o saldo passava pelas oito
 * abas, e quem queria uma aba passava pelo saldo.
 *
 * Agora são duas: em cima a MARCA e o que é do jogador (VIP,
 * moeda, fechar); embaixo, a barra de navegação, num tom mais
 * escuro que a separa do resto.
 *
 * A soma continua sendo os mesmos 76, e isso não é estética: a
 * altura do cabeçalho decide onde começa o slot de conteúdo, e o
 * slot decide quantas linhas cabem numa página do ranking e das
 * regras. Mudá-la repagina cinco telas de uma vez.
 */
const LAYOUT = {
  headerHeight: 76,
  /** A faixa de cima: marca, VIP, moeda e fechar. */
  brandHeight: 44,
  /** A faixa de baixo: só as abas. Fecha os 76 com a de cima. */
  navBarHeight: 32,
  /** A barra de acento vermelha sob o cabeçalho. */
  accentHeight: 2,
  contentPadding: 30,
  navButtonHeight: 26,
  navGap: 6,
  edgePadding: 16,
  /**
   * A altura da marca na faixa de cima.
   *
   * A LARGURA sai daqui pela proporção do logo — ver `BRAND_RATIO`.
   */
  brandMark: 30,
} as const;

/**
 * O ar dos dois lados do rótulo de uma aba.
 *
 * ####  A LARGURA DEIXOU DE SER UM NÚMERO ESCRITO À MÃO  ####
 *
 * Cada aba trazia a largura dela no cadastro (`width: 108`), e
 * eram nove números medidos a olho. Renomear uma aba no editor não
 * mexia nela — o rótulo ficava apertado ou sobrava fundo —, e
 * ninguém tinha como saber qual era o número certo.
 *
 * Agora ela sai do texto, pela mesma régua estimada que o resto do
 * menu usa (`textWidth`). Erra alguns pixels para mais, que é o
 * lado seguro: sobra ar, nunca corta letra.
 */
const NAV_PADDING = 20;

/**
 * A proporção da arte da marca (largura ÷ altura).
 *
 * ####  O LOGO NÃO É QUADRADO, E ESTICÁ-LO SE VÊ  ####
 *
 * O da rede tem 4048x1735 — dois e um terço de largura para cada
 * altura. Desenhá-lo num quadrado o achataria, e num retângulo
 * chutado o deformaria de outro jeito. O número é o da arte que
 * está em `Assets` hoje; trocar o PNG por outro de proporção
 * diferente pede trocar este número junto.
 */
const BRAND_RATIO = 2.34;

/**
 * As medidas do modal de kit, VIP e veiculo.
 *
 * ####  ELAS SAO UMA SO PORQUE JA DIVERGIRAM  ####
 *
 * A caixa tinha 340 de altura escritos num lugar, e o slot da lista
 * terminava a 304 do topo escritos em outro. Trinta e seis pixels de
 * folga sob uma lista que cresce com o pacote — e o "TOTAL", colado
 * a 78 do fundo, ficava DENTRO dela. No jogo, um VIP de cinco
 * vantagens escrevia a quarta por cima da palavra TOTAL.
 *
 * Nada no desenho estava errado isoladamente; errada estava a
 * relacao entre dois numeros que ninguem obrigava a concordar.
 * Aqui a altura do slot e CALCULADA a partir da altura da caixa e do
 * rodape, e a conta nao tem como sair do lugar sozinha.
 *
 *   topo                       0
 *   +-- cabecalho (icone, resumo)
 *   +-- regua ..................... listTop - 34
 *   +-- titulo da lista ........... listTop - 22
 *   +-- SLOT ...................... listTop .. listTop + listHeight
 *   +-- regua ..................... footer (contada do FUNDO)
 *   +-- total, saldo, botoes
 *   fundo                          height
 */
const BUNDLE_MODAL = {
  /**
   * 520, e nao 420.
   *
   * A largura antiga cabia "FORNALHA DIVIDE OS ITENS AUTOMATICO."
   * por poucos pixels, e qualquer vantagem uma palavra mais longa
   * quebrava. Ela tambem nao comportava uma grade de inventario:
   * seis casinhas de 44 pedem 274, e sobravam 376 uteis contra as
   * margens — apertado demais para o rotulo do conteiner ao lado.
   */
  width: 520,
  height: 500,
  /** Onde o slot da lista comeca, contado do TOPO. */
  listTop: 186,
  /** Quanto o rodape reserva, contado do FUNDO. */
  footer: 122,
} as const;

/**
 * A altura do slot: o que sobra entre o cabecalho e o rodape.
 *
 * Os 12 px sao o ar entre a ultima linha da lista e a regua do
 * preco. Sem eles a lista encosta na regua, que e o mesmo defeito
 * de antes com um pixel de diferenca.
 */
const BUNDLE_LIST_HEIGHT = BUNDLE_MODAL.height - BUNDLE_MODAL.footer - 12 - BUNDLE_MODAL.listTop;


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
  /** O que a página mostra enquanto ninguém a preencheu. */
  readonly hint: string;
}

const HOME: NavEntry = {
  id: 'home',
  label: 'HOME',
  hint: 'O banner e as novidades da rede.',
};

const NAV: readonly NavEntry[] = [
  { id: 'loja', label: 'LOJA', hint: 'As ofertas da loja entram aqui.' },
  {
    id: 'calendario',
    label: 'CALENDÁRIO',
    hint: 'Wipes e eventos programados entram aqui.',
  },
  { id: 'eventos', label: 'EVENTOS', hint: 'Os eventos ativos entram aqui.' },
  { id: 'regras', label: 'REGRAS', hint: 'As regras do servidor entram aqui.' },
  { id: 'kits', label: 'KITS', hint: 'Os kits disponíveis por nível entram aqui.' },
  // A dica desta não é desenhada: a página RANKING é montada pelo
  // agente (ver `buildMainMenu`). Ela fica para o dia em que
  // alguém apagar a tela e o botão precisar dizer alguma coisa.
  { id: 'ranking', label: 'RANKING', hint: 'O ranking de jogadores entra aqui.' },
  // A dica desta também não é desenhada: a página é montada pelo
  // agente, como a do ranking. Ver `buildMainMenu`.
  //
  // O `id` é `missoes` e não `quest` porque dele sai o id da tela
  // (`tela-missoes`), e ele fica numa lista de sete portugueses.
  { id: 'missoes', label: 'MISSÕES', hint: 'As missões do servidor entram aqui.' },
];

/**
 * As abas cuja tela já existe FORA desta lista.
 *
 * ####  POR QUE ELAS NÃO ENTRAM NO `NAV`  ####
 *
 * O `NAV` faz duas coisas para cada entrada: o botão da barra E uma
 * página de repouso com o id `tela-<id>`. A aba EQUIPE já tem a
 * página dela — montada pelo agente, com o esqueleto próprio — e
 * entrar no `NAV` criaria uma SEGUNDA `tela-equipe`, vazia, que
 * ganharia da primeira na ordem do documento.
 *
 * Então elas ganham só o botão, e o id da tela vem do módulo que a
 * desenha. Mesma razão pela qual o botão do Discord é montado à
 * parte, logo abaixo.
 */
const EXTRA_NAV: readonly { readonly id: string; readonly label: string; readonly screenId: string }[] = [
  { id: 'equipe', label: TEAM_TAB_LABEL, screenId: TEAM_SCREEN_ID },
];

/** As entradas cuja página o AGENTE monta. Ver `buildMainMenu`. */
const RANKING_NAV_ID = 'ranking';
const QUESTS_NAV_ID = 'missoes';
const RULES_NAV_ID = 'regras';

/**
 * O comando que abre o menu JÁ nas missões.
 *
 * Ele é um ATALHO do próprio documento, e não um segundo menu —
 * ver `shortcuts` em types/ui-document.ts.
 */
const QUESTS_COMMAND = 'quest';


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

  const navRect = (label: string): Rect => {
    const width = textWidth(label, 12) + NAV_PADDING;

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
        navRect(entry.label),
        entry.label,
        { id: `ir-${entry.id}`, kind: 'navigate', screenId: SCREEN_ID(entry.id) },
        'nav',
        12,
        // Fica vermelho quando a tela dele estiver aberta.
        SCREEN_ID(entry.id),
      ),
    );
  }

  // ####  AS ABAS CUJA TELA VEM DE FORA  ####
  //
  // Elas entram ANTES do Discord porque são do servidor, e o
  // Discord é o link que fecha a barra. Ver `EXTRA_NAV`.
  for (const entry of EXTRA_NAV) {
    nav.push(
      button(
        `nav-${entry.id}`,
        entry.label,
        navRect(entry.label),
        entry.label,
        { id: `ir-${entry.id}`, kind: 'navigate', screenId: entry.screenId },
        'nav',
        12,
        entry.screenId,
      ),
    );
  }

  nav.push(
    button(
      'nav-discord',
      'DISCORD',
      navRect('DISCORD'),
      'DISCORD',
      { id: 'ir-discord', kind: 'navigate', screenId: DISCORD_SCREEN_ID },
      'nav',
      12,
      // Fica vermelho quando a tela dele estiver aberta, como o
      // resto da barra.
      DISCORD_SCREEN_ID,
    ),
  );

  // ####  A ABA CONFIGURACOES  ####
  //
  // Ela leva ao que vale só para quem abriu — hoje, o modo
  // streamer. O botão NASCE aqui, mas quem decide se ele aparece é
  // o plugin: só os liberados o enxergam, com a lista que desce no
  // payload do modo (ver game/ui-streamer-screen.ts).
  nav.push(
    button(
      STREAMER_TAB_ID,
      STREAMER_TAB_LABEL,
      navRect(STREAMER_TAB_LABEL),
      STREAMER_TAB_LABEL,
      { id: 'ir-config', kind: 'navigate', screenId: STREAMER_SCREEN_ID },
      'nav',
      12,
      STREAMER_SCREEN_ID,
    ),
  );

  // ------------------------------------------------------------
  //  A FAIXA DE CIMA: a marca, e o que é de quem abriu
  //
  //  ####  A MARCA VEM ANTES DE TUDO  ####
  //
  //  O menu abria direto nas abas, sem dizer de quem ele é. Agora
  //  ele abre com o logo da rede — a mesma arte que o overlay de
  //  propagandas já põe no alto da tela, guardada na pasta de
  //  interface sob a chave `ozlogo`.
  //
  //  Não há texto ao lado: o logo TEM o nome escrito dentro dele, e
  //  repeti-lo em rótulo era dizer duas vezes a mesma coisa.
  //
  //  Trocar o PNG na pasta troca a marca no próximo envio, sem
  //  reiniciar nada. Arte AUSENTE é um estado previsto: sem o
  //  arquivo a imagem não desenha e o cabeçalho segue inteiro — é o
  //  mesmo caminho da moeda.
  // ------------------------------------------------------------
  const brand: UiElement[] = [
    {
      id: 'marca-logo',
      name: 'Marca (arte)',
      type: 'image',
      rect: {
        anchorMin: { x: 0, y: 0.5 },
        anchorMax: { x: 0, y: 0.5 },
        offsetMin: { x: LAYOUT.edgePadding, y: -LAYOUT.brandMark / 2 },
        offsetMax: {
          x: LAYOUT.edgePadding + LAYOUT.brandMark * BRAND_RATIO,
          y: LAYOUT.brandMark / 2,
        },
      },
      source: { kind: 'stored', key: 'ozlogo' },
      // Branco: o `color` de uma imagem TINGE, e qualquer outra cor
      // aqui pintaria a arte por cima.
      color: C.white,
      children: [],
    },

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
  ];

  const contentTop = LAYOUT.headerHeight + LAYOUT.accentHeight + LAYOUT.contentPadding;

  return [
    // O véu, com o desfoque. Ele é o fundo de tudo.
    panel('veu', 'Véu', inset(0, 0, 0, 0), OVERLAY, [], BLUR_MATERIAL),

    // ####  A MOLDURA: O MENU OCUPA 88% DA TELA  ####
    //
    // O interior dela é `--bg`, e não `--surface`. Isso não é
    // estética: é o que faz os cartões EXISTIREM.
    //
    // O CUI não tem borda — ela se faz com dois painéis, um por
    // cima do outro, e a esta tela não sobram elementos para isso.
    // Então o que separa um cartão do fundo é a DIFERENÇA DE TOM, e
    // ela só existe se os dois tons forem diferentes.
    //
    // Enquanto o interior foi `--surface`, os cartões — também
    // `--surface` — não tinham contorno nenhum: a HOME parecia um
    // bloco único com texto espalhado, e a grade de kits, oito
    // retângulos invisíveis. Visto no jogo em 14/09/2026.
    //
    // Com `--bg` embaixo, `--surface` vira o cartão e `--surface-2`
    // vira o destaque dentro dele. Três tons, nenhum elemento a
    // mais.
    borderedPanel(
      'moldura',
      'Moldura',
      {
        anchorMin: { x: 0.06, y: 0.06 },
        anchorMax: { x: 0.94, y: 0.94 },
        offsetMin: { x: 0, y: 0 },
        offsetMax: { x: 0, y: 0 },
      },
      C.bg,
      [
        panel('cabecalho', 'Cabeçalho', topBar(LAYOUT.headerHeight), C.surface2, [
          // Em cima: a marca à esquerda, o jogador à direita.
          panel('marca', 'Marca', topBar(LAYOUT.brandHeight), '#00000000', brand),

          // ####  E EMBAIXO A BARRA DE NAVEGAÇÃO, MAIS ESCURA  ####
          //
          // O tom de `--bg` sob as abas é o que as separa do resto
          // do cabeçalho sem gastar uma régua de 1 px: a barra lê
          // como uma faixa própria, e a aba ATIVA — vermelha — salta
          // dela em vez de competir com o saldo ao lado.
          panel(
            'nav-barra',
            'Barra de navegação',
            topBar(LAYOUT.navBarHeight, LAYOUT.brandHeight),
            C.bg,
            nav,
          ),
        ]),
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
  return modalBox('mb', BUNDLE_MODAL.width, BUNDLE_MODAL.height, C.rust, [
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
        // Ate -100, e nao -86: "VIP BRONZE por 30 dias" cabe numa
        // linha, mas o resumo de um kit longo precisa de duas, e
        // uma caixa de 24 px de altura corta a segunda.
        offsetMin: { x: 116, y: -100 },
        offsetMax: { x: -22, y: -62 },
      },
      '3 itens no kit',
      { size: 12, color: C.textMuted, align: 'MiddleLeft', font: 'RobotoCondensed-Regular.ttf' },
    ),

    // A régua que fecha o cabeçalho. Sem ela o ícone e a lista são
    // duas coisas soltas no mesmo retângulo; com ela, o modal tem
    // "quem é este pacote" em cima e "o que vem nele" embaixo.
    panel(
      'mb-regua-topo',
      'Régua do cabeçalho',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(BUNDLE_MODAL.listTop - 34) },
        offsetMax: { x: -22, y: -(BUNDLE_MODAL.listTop - 33) },
      },
      C.border,
    ),

    label(
      'mbtitulo',
      'Título da lista',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(BUNDLE_MODAL.listTop - 6) },
        offsetMax: { x: -22, y: -(BUNDLE_MODAL.listTop - 22) },
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
    //
    // ####  ELE TERMINA ACIMA DO RODAPÉ, E ISSO NÃO É DETALHE  ####
    //
    // Ele já foi de -172 a -304 numa caixa de 340 de altura: a lista
    // ia até 36 px do fundo, e o "TOTAL" mora a 78. Um VIP com cinco
    // vantagens escrevia a quarta POR CIMA da palavra TOTAL — visível
    // no jogo, e não em nenhum teste, porque o desenho estava certo
    // para as três primeiras.
    //
    // A altura da caixa e a do slot saem as duas de BUNDLE_MODAL,
    // justamente para não voltarem a divergir.
    panel(
      'mblista',
      'Lista (preenchida pelo agente)',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 22, y: -(BUNDLE_MODAL.listTop + BUNDLE_LIST_HEIGHT) },
        offsetMax: { x: -22, y: -BUNDLE_MODAL.listTop },
      },
      '#00000000',
    ),

    // A régua que separa o pacote do preço — o pedido é literal:
    // "exibir o TOTAL junto ao valor da compra, SEPARADO dos
    // benefícios".
    panel(
      'mb-regua-preco',
      'Régua do preço',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: 22, y: BUNDLE_MODAL.footer },
        offsetMax: { x: -22, y: BUNDLE_MODAL.footer + 1 },
      },
      C.border,
    ),

    label(
      'mb-rotulo-total',
      'Rótulo total',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 0 },
        offsetMin: { x: 22, y: 84 },
        offsetMax: { x: 140, y: 110 },
      },
      'TOTAL',
      { size: 11, color: C.textMuted, align: 'MiddleLeft' },
    ),

    ...coinValue('mbtotal', 'Total', 84, 26, 18, C.amber),

    // ####  O SALDO GANHOU DUAS LINHAS DE ALTURA  ####
    //
    // "Saldo insuficiente — você tem 1.085" em 18 px de caixa ficava
    // encostado no valor em cima e no botão embaixo. Aqui ele tem a
    // sua faixa, entre a régua e os botões.
    label(
      'mbsaldo',
      'Saldo',
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: 22, y: 58 },
        offsetMax: { x: -22, y: 78 },
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
        offsetMin: { x: 22, y: 18 },
        offsetMax: { x: 120, y: 48 },
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
        offsetMin: { x: -180, y: 18 },
        offsetMax: { x: -22, y: 48 },
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
    // ####  A HOME TAMBÉM É MONTADA PELO AGENTE  ####
    //
    // Ela deixou de ser um cartaz de três frases: mostra o pódio do
    // ranking, a oferta em destaque, o próximo wipe e as missões de
    // quem abriu. O que fica gravado aqui é o MODELO — as caixas
    // vazias, com "Carregando…" no lugar de cada dado —, e o agente
    // derrama o conteúdo a cada abertura. Ver game/ui-home-screen.ts.
    //
    // `generated: true` é o que faz o plugin PEDIR a de verdade. Sem
    // a marca ele desenha o repouso e para — e como esta é a tela de
    // ENTRADA, o jogador ficaria com "Carregando…" para sempre. Foi
    // assim que o menu de missões quebrou, MEDIDO no jogo em
    // 06/09/2026 (ver `generated` em types/ui-transport.ts).
    { ...buildHomeScreen({ view: emptyHomeView() }), generated: true },
    // ####  A PÁGINA RANKING NÃO É UM PLACEHOLDER  ####
    //
    // Ela é MONTADA pelo agente a cada clique (ver
    // game/ui-ranking-screen.ts), e o que fica gravado aqui é a
    // mesma tela em REPOUSO: o título, e a frase de que ainda não
    // há nada medido. É a diferença entre um retângulo prometendo
    // um recurso que já existe ("o ranking entra aqui") e a tela
    // de verdade sem número nenhum dentro.
    //
    // Ela é a única do menu que o agente redesenha e que precisa
    // caber no `uiDocumentSchema` — e o schema não aceita `:` em
    // `screenId` de ação. Por isso a versão de repouso nasce SEM
    // ABA NENHUMA: uma aba levaria a `tela-ranking:pvp.kills`, e o
    // documento inteiro seria recusado na gravação.
    ...NAV.map((entry): UiScreen => {
      if (entry.id === RANKING_NAV_ID) {
        // ####  `skeleton` É O QUE A TORNA EDITÁVEL  ####
        //
        // Desde 06/09/2026 esta tela não é só o repouso: ela é o
        // MODELO que o agente preenche a cada clique. Para isso ela
        // precisa TER a coluna e a caixa da lista desenhadas —
        // `fillTemplate` preenche o que existe e não cria o que
        // falta. Ver `RANKING_SLOTS` em game/ui-ranking-screen.ts.
        return buildRankingScreen({ view: emptyRankingView(), skeleton: true });
      }

      // ####  A PÁGINA MISSÕES TAMBÉM É MONTADA  ####
      //
      // Mesma escolha da de ranking, com uma diferença que custou
      // uma sessão: ela vai marcada com `generated: true`. Sem a
      // marca, o plugin desenha o repouso gravado e NUNCA pede a de
      // verdade — o jogador fica no "carregando" para sempre.
      //
      // Ela também nasce SEM A BARRA LATERAL, pela mesma razão do
      // ranking: o schema não aceita `:` em `screenId` de ação, e o
      // item da barra navega para `tela-quest:disponiveis`.
      if (entry.id === QUESTS_NAV_ID) {
        return {
          ...buildQuestsScreen({
            view: { ...emptyQuestsView(), emptyMessage: 'Carregando as suas missões…' },
            screenId: QUESTS_SCREEN_ID,
            withNav: false,
          }),
          generated: true,
        };
      }

      // ####  A PÁGINA REGRAS TAMBÉM É MONTADA  ####
      //
      // O desenho é da rede; o TEXTO é do banco daquele servidor —
      // igual ao convite do Discord, e pelo mesmo motivo: regras
      // escritas dentro do documento obrigariam um menu por
      // servidor. Ver game/ui-rules-screen.ts.
      //
      // `skeleton: true` põe a coluna e a caixa das regras no
      // desenho, transparentes: `fillTemplate` preenche o que
      // existe e não cria o que falta, e sem elas o admin não teria
      // o que mover no editor. `generated: true` é o de sempre —
      // sem a marca o plugin desenha o esqueleto e nunca pede o
      // texto, e a aba abriria vazia para sempre.
      if (entry.id === RULES_NAV_ID) {
        return {
          ...buildRulesScreen({ view: emptyRulesView(), skeleton: true }),
          generated: true,
        };
      }

      return {
        id: SCREEN_ID(entry.id),
        name: entry.label,
        kind: 'page',
        elements: buildPlaceholder(entry),
      };
    }),

    // ####  A PÁGINA DISCORD  ####
    //
    // O convite é do `.ini` de cada servidor, e por isso ela é
    // MONTADA pelo agente (ver game/ui-discord-screen.ts). O que
    // fica gravado é a mesma tela sem convite nenhum — que é
    // também o que o servidor que não configurou nada mostra.
    //
    // `generated: true` pelo motivo de sempre: sem a marca, o
    // plugin desenha o repouso e nunca pede a de verdade, e o
    // jogador fica olhando "este servidor ainda não divulgou um
    // Discord" num servidor que divulgou.
    { ...buildDiscordScreen({ view: { invite: '' } }), generated: true },

    // ####  A ABA CONFIGURACOES  ####
    //
    // Montada por JOGADOR: ela mostra o modo streamer de quem
    // abriu o menu. O que fica gravado é a tela de quem não foi
    // liberado — que é também o que a maioria vê.
    {
      // O ESQUELETO, e não a tela: ela é remontada por jogador a
      // cada clique, e o documento não tem bytes sobrando. Ver
      // `skeleton` em game/ui-streamer-screen.ts.
      ...buildStreamerScreen({ profile: defaultStreamerProfile(''), skeleton: true }),
      generated: true,
    },

    // ####  A ABA EQUIPE  ####
    //
    // Montada por JOGADOR, como a de configurações: ela mostra a
    // equipe de quem abriu o menu, e quem está online nela AGORA.
    // Por isso o que fica gravado é só o esqueleto — e ele vai
    // `generated: true` pelo motivo de sempre: sem a marca, o
    // plugin desenha o repouso e nunca pede a de verdade.
    {
      ...buildTeamScreen({ steamId: undefined, team: null, maxSize: 0, skeleton: true }),
      generated: true,
    },

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
    // `/quest` abre este mesmo menu, direto em MISSÕES. Um segundo
    // documento faria o servidor carregar o menu inteiro duas
    // vezes — ver `shortcuts` em types/ui-document.ts.
    //
    // ####  E `/discord` EXISTE POR CAUSA DESTA LINHA  ####
    //
    // Ela não é conveniência: o plugin registra no Oxide todo
    // comando de atalho que chega na carga, e é isso que faz o
    // servidor parar de responder `Unknown command: discord` a
    // quem digita no chat. O botão do cabeçalho não depende dela —
    // ele navega direto —, mas o jogador que aprendeu `/discord`
    // em outro servidor depende.
    // ####  E OS OUTROS QUATRO SÃO A MESMA IDEIA  ####
    //
    // Pedido do dono em 14/09/2026: "/info, /kits, /discord e
    // /wipe — cada comando deve abrir corretamente sua respectiva
    // informação". Nenhum deles é um segundo menu: são endereços
    // dentro deste, e por isso não custam um byte a mais na carga.
    //
    // `/info` abre a HOME, que é onde a informação do servidor já
    // mora — o pódio, a oferta em destaque, o próximo wipe e as
    // missões de quem abriu. `/wipe` abre o CALENDÁRIO, que é a
    // tela que responde "quando vira".
    shortcuts: [
      { command: QUESTS_COMMAND, screenId: QUESTS_SCREEN_ID },
      { command: DISCORD_COMMAND, screenId: DISCORD_SCREEN_ID },
      { command: RULES_COMMAND, screenId: RULES_SCREEN_ID },
      { command: 'info', screenId: HOME_SCREEN_ID },
      { command: 'kits', screenId: KITS_SCREEN_ID },
      { command: 'wipe', screenId: CALENDAR_SCREEN_ID },
      // ####  A EQUIPE TEM DOIS NOMES  ####
      //
      // Pedido do dono em 15/09/2026. `/equipe` é o do servidor,
      // que fala português; `/team` é o que a pessoa traz de outro
      // servidor — e quem digita o de fora não devia ler "Unknown
      // command" por isso.
      //
      // Dois atalhos para a mesma tela não custam nada: o plugin
      // registra os dois no Oxide, e os dois navegam para o mesmo
      // endereço. É mais barato que a explicação de por que só um
      // deles funciona.
      //
      // A lista vem de `ui-team-screen.ts`: o menu gravado ANTES
      // desta frente ganha os mesmos dois pelo `withTeamTab`, e
      // duas listas divergiriam no dia em que um terceiro nome
      // aparecesse.
      ...TEAM_COMMANDS.map((command) => ({ command, screenId: TEAM_SCREEN_ID })),
    ],
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

