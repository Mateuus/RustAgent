// ============================================================
//  ui-streamer-screen.ts  -  a aba CONFIGURAÇÕES do menu, e o
//  que mora nela hoje: o modo streamer.
//
//  Pedido do dono em 14/09/2026, depois de o comando existir:
//  "além do chat, podemos colocar em nosso menu uma aba
//  Configurações e uma tab streamer — e nessa aba tem a opção de
//  desativar as coisas: logo, mensagem do chat etc."
//
//  E, vendo a primeira versão no jogo: "coloque uma side bar igual
//  ao ranking, igual aos outros; aí no side coloca Modo Streamer, e
//  abre essa aba — porque depois vamos ter outras configurações".
//
//  ------------------------------------------------------------
//  ####  A COLUNA COM UM ITEM SO  ####
//
//  Ela parece exagero hoje, e é justamente o contrário: é o lugar
//  onde a segunda configuração entra sem redesenhar nada. Sem a
//  coluna, o segundo assunto teria de virar uma aba nova na barra
//  de cima — e a barra é o espaço mais disputado do menu.
//
//  As medidas são as do ranking, das missões e das regras,
//  copiadas: quatro telas com colunas parecidas mas não iguais é
//  pior que uma só, porque o olho nota a diferença de 4 px e
//  ninguém sabe qual é a certa.
//
//  ------------------------------------------------------------
//  ####  O COMANDO CONTINUA SENDO A ENGRENAGEM  ####
//
//  Os botões daqui não têm ação própria: eles rodam `/streamer`,
//  `/streamer logo`, `/streamer ads` e `/streamer chat` COMO O
//  JOGADOR — a ação `chat` do documento, que o plugin já sabe
//  executar (ver `Execute` em OrigemZUI.cs).
//
//  Isso é o que faz a tela não precisar de nada novo no `.cs` do
//  lado das ações: um caminho só decide o que acontece, e ele é o
//  mesmo de quem digita no chat. Dois caminhos divergiriam no
//  primeiro ajuste — e o que diverge aqui é o que o jogador vê.
//
//  ------------------------------------------------------------
//  ####  A TELA É MONTADA POR JOGADOR  ####
//
//  Ela mostra o estado DELE, e por isso é `generated`: o plugin a
//  pede no clique, com o SteamID junto, e a resposta é volátil
//  (nunca vai para o cache de cinco minutos do plugin). Uma tela
//  desenhada no editor mostraria o mesmo interruptor para todo
//  mundo — e um interruptor que mente sobre o próprio estado é
//  pior que nenhum.
//
//  ------------------------------------------------------------
//  ####  AS TRES CHAVES TEM DOIS DONOS  ####
//
//  O admin escolhe na ficha o que some quando o modo liga; o
//  jogador ajusta aqui. São as MESMAS três chaves, e o último que
//  mexeu manda.
//
//  Poderiam ser dois pares de campos — "o que o admin permite" e
//  "o que o jogador quer" —, e não são de propósito: o valor de
//  cada um seria idêntico em 99% dos casos, e a pergunta "por que
//  a logo ainda aparece se eu desmarquei?" passaria a ter duas
//  respostas possíveis em vez de uma.
// ============================================================

import { defaultStreamerProfile, type StreamerProfile } from '../types/streamer.js';
import {
  MAX_SCREENS_PER_DOCUMENT,
  type UiDocument,
  type UiElement,
  type UiScreen,
} from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';

import { C, button, fill, label, panel, textWidth, titleBar, type Rect } from './ui-widgets.js';

/** O endereço desta tela no documento. */
export const STREAMER_SCREEN_ID = 'tela-config';

/**
 * O botão da barra que leva até aqui.
 *
 * O id viaja ao plugin no payload do modo streamer (`tab`), e é
 * por ele que o botão some da barra de quem não foi liberado. Ver
 * types/streamer-transport.ts.
 */
export const STREAMER_TAB_ID = 'nav-config';

export const STREAMER_TAB_LABEL = 'CONFIG';

/** O comando que cada botão roda. */
const TOGGLE_COMMAND = '/streamer';

// ####  AS MEDIDAS SÃO AS DAS REGRAS E DO RANKING  ####
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
  /** A barra vermelha do item aberto. */
  accent: 3,
} as const;

const CONTENT_LEFT = COLUMN.width + COLUMN.gap;

/** Os blocos do corpo. */
const ROW = {
  mode: 64,
  item: 48,
  gap: 6,
  /** O respiro dos dois lados de tudo que está dentro de um bloco. */
  pad: 12,
} as const;

export function isStreamerScreenId(screenId: string): boolean {
  return screenId === STREAMER_SCREEN_ID;
}

// ------------------------------------------------------------
//  AS MEDIDAS
// ------------------------------------------------------------

/** Uma faixa do conteúdo, medida a partir do topo do corpo. */
function row(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: CONTENT_LEFT, y: -(Y.body + top + height) },
    offsetMax: { x: 0, y: -(Y.body + top) },
  };
}

/** Uma linha de texto DENTRO de um bloco, recuada do canto. */
function line(top: number, height: number, right = 0): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: ROW.pad, y: -(top + height) },
    offsetMax: { x: -right, y: -top },
  };
}

/** O botão no canto direito de um bloco. */
function actionRect(width: number): Rect {
  return {
    anchorMin: { x: 1, y: 0.5 },
    anchorMax: { x: 1, y: 0.5 },
    offsetMin: { x: -(width + ROW.pad), y: -13 },
    offsetMax: { x: -ROW.pad, y: 13 },
  };
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
    offsetMax: { x: COLUMN.accent, y: -3 },
  };
}

// ------------------------------------------------------------
//  A COLUNA
// ------------------------------------------------------------

/**
 * A barra lateral.
 *
 * ####  O ITEM ABERTO NAO E UM BOTAO  ####
 *
 * Ele é um painel com a barra de acento — igual ao das regras e ao
 * do ranking. Um botão que navega para a tela em que já se está
 * seria um clique que não faz nada, e o hover prometeria o
 * contrário.
 */
function sidebar(): UiElement[] {
  return [
    label('cfg-coltit', 'CONFIGURAÇÕES', columnTitle(), {
      size: 20,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    panel('cfg-col', columnRect(), C.surface2, [
      panel('cfg-col-0', columnItem(0), C.bg, [
        panel('cfg-col-0b', columnAccent(), C.rust),
        label('cfg-col-0l', 'MODO STREAMER', fill(COLUMN.textLeft, 0, ROW.pad, 0), {
          size: 12,
          color: C.text,
          align: 'MiddleLeft',
          font: 'RobotoCondensed-Bold.ttf',
        }),
      ]),
    ]),
  ];
}

// ------------------------------------------------------------
//  O CORPO
// ------------------------------------------------------------

interface SwitchRow {
  readonly id: string;
  readonly arg: string;
  readonly title: string;
  readonly hint: string;
  readonly hidden: boolean;
}

/**
 * As três chaves, na ordem em que o jogador pensa nelas: o que ele
 * VÊ primeiro é o que ele quer tirar primeiro.
 */
function rowsOf(profile: StreamerProfile): readonly SwitchRow[] {
  return [
    {
      id: 'logo',
      arg: 'logo',
      title: 'LOGO DO SERVIDOR',
      hint: 'A marca que fica parada na tela.',
      hidden: profile.hideLogo,
    },
    {
      id: 'ads',
      arg: 'ads',
      title: 'PROPAGANDA',
      hint: 'O painel que abre e gira as campanhas.',
      hidden: profile.hideAds,
    },
    {
      id: 'chat',
      arg: 'chat',
      title: 'AVISOS DO CHAT',
      hint: 'Os anúncios automáticos. Recado para você continua chegando.',
      hidden: profile.hideMessages,
    },
  ];
}

export interface BuildStreamerScreenOptions {
  readonly profile: StreamerProfile;
  /**
   * O ESQUELETO: o que fica gravado no documento.
   *
   * ####  O DOCUMENTO TEM TETO, E ELE JA ESTA NO FIM  ####
   *
   * A carga do menu inteiro viaja num frame de RCON, e o teste de
   * `ui-home-screen.ts` guarda a folga que sobrou: "a partir daqui,
   * troca -- nao acrescimo". Gravar esta tela inteira custaria
   * ~1.700 bytes para desenhar o que ninguem ve: ela é `generated`,
   * e o agente a remonta a cada clique com o estado do jogador.
   *
   * Então o que fica no documento é o mínimo que responde quando o
   * agente NÃO responde — o título e uma linha dizendo isso.
   */
  readonly skeleton?: boolean;
  /**
   * O id EXATO que foi pedido.
   *
   * Volta idêntico porque o plugin DESCARTA a resposta cujo id não
   * bate com o que ele pediu.
   */
  readonly screenId?: string;
}

/**
 * A página, do jeito que o jogador a vê.
 *
 * Sem liberação ela não some nem fica vazia: ela diz que o modo
 * não está liberado e manda falar com a administração. Quem chegou
 * aqui foi porque a barra ainda tinha o botão — a carga anterior,
 * o clique que cruzou com a mudança —, e uma tela em branco faria
 * o jogador achar que o menu quebrou.
 */
export function buildStreamerScreen(options: BuildStreamerScreenOptions): UiScreen {
  const { profile } = options;

  if (options.skeleton === true) {
    return {
      id: options.screenId ?? STREAMER_SCREEN_ID,
      name: 'CONFIGURAÇÕES',
      kind: 'page',
      elements: [
        ...titleBar('cfg', 'CONFIGURAÇÕES'),
        label('cfg-esq', 'Carregando…', row(0, 22), {
          size: 12,
          color: C.textMuted,
          align: 'MiddleLeft',
        }),
      ],
    };
  }

  return {
    id: options.screenId ?? STREAMER_SCREEN_ID,
    name: 'CONFIGURAÇÕES',
    kind: 'page',
    elements: [
      // O título da TELA começa depois da coluna: no zero ele cairia
      // em cima do título dela. É a mesma divisão das regras.
      ...titleBar('cfg', 'MODO STREAMER', {
        left: CONTENT_LEFT,
        subtitle: 'O que some da sua tela enquanto você transmite.',
      }),
      ...sidebar(),
      ...(profile.allowed ? forStreamer(profile) : notAllowed()),
    ],
  };
}

function forStreamer(profile: StreamerProfile): readonly UiElement[] {
  const live = profile.active;

  return [
    // ----------------------------------------------------------
    //  A CHAVE GERAL
    // ----------------------------------------------------------
    panel('cfg-modo', row(0, ROW.mode), C.surface2, [
      label('cfg-modo-t', live ? 'VOCÊ ESTÁ NO AR' : 'VOCÊ ESTÁ FORA DO AR', line(12, 18, 150), {
        size: 14,
        color: live ? C.rust : C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'cfg-modo-h',
        live
          ? 'O que está marcado abaixo não aparece para você.'
          : 'Você vê a tela como qualquer outro jogador.',
        line(34, 16, 150),
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
      ),
      button(
        'cfg-modo-b',
        live ? 'SAIR DO AR' : 'ENTRAR NO AR',
        actionRect(120),
        { id: 'cfg-modo-a', kind: 'chat', command: TOGGLE_COMMAND },
        { color: live ? C.border : C.rust, textColor: C.white, fontSize: 12 },
      ),
    ]),

    label('cfg-lista-t', 'O QUE SOME QUANDO VOCÊ ESTÁ NO AR', row(ROW.mode + 10, 18), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),

    // ----------------------------------------------------------
    //  AS TRÊS CHAVES
    //
    //  ####  ELAS CONTINUAM CLICAVEIS COM O MODO DESLIGADO  ####
    //
    //  Escolher o que vai sumir ANTES de entrar no ar é o uso
    //  normal: ninguém quer ajustar isso com a transmissão já
    //  rodando. Por isso a única coisa que muda com o modo
    //  desligado é o tom do rótulo, que diz que nada disso está
    //  valendo agora.
    // ----------------------------------------------------------
    ...rowsOf(profile).flatMap((entry, index) =>
      switchRow(entry, live, ROW.mode + 32 + index * (ROW.item + ROW.gap)),
    ),
  ];
}

function switchRow(entry: SwitchRow, live: boolean, top: number): readonly UiElement[] {
  return [
    panel(`cfg-${entry.id}`, row(top, ROW.item), C.surface2, [
      label(`cfg-${entry.id}-t`, entry.title, line(8, 16, 130), {
        size: 12,
        color: live && entry.hidden ? C.amber : C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(`cfg-${entry.id}-h`, entry.hint, line(26, 14, 130), {
        size: 10,
        color: C.textMuted,
        align: 'MiddleLeft',
      }),
      button(
        `cfg-${entry.id}-b`,
        entry.hidden ? 'ESCONDIDO' : 'APARECE',
        actionRect(110),
        { id: `cfg-${entry.id}-a`, kind: 'chat', command: `${TOGGLE_COMMAND} ${entry.arg}` },
        {
          color: entry.hidden ? C.rust : C.border,
          textColor: entry.hidden ? C.white : C.textMuted,
          fontSize: 11,
        },
      ),
    ]),
  ];
}

function notAllowed(): readonly UiElement[] {
  return [
    panel('cfg-nao', row(0, ROW.mode), C.surface2, [
      label('cfg-nao-t', 'VOCÊ AINDA NÃO TEM CONFIGURAÇÕES AQUI', line(12, 18), {
        size: 13,
        color: C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'cfg-nao-h',
        'O modo streamer é liberado pela administração. Fale com um admin se você transmite.',
        line(34, 16),
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
      ),
    ]),
  ];
}

// ============================================================
//  O PROVEDOR
// ============================================================

export interface StreamerScreenProviderOptions {
  /**
   * O perfil daquele jogador.
   *
   * `undefined` no SteamID vem do plugin quando ele pede a tela
   * sem sessão — e a resposta certa é a tela de "não liberado",
   * nunca um erro: o jogador está olhando para ela.
   */
  readonly profileOf: (steamId: string | undefined) => StreamerProfile;
}

export type StreamerScreenProvider = (input: {
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => UiScreenBundle | null;

export function createStreamerScreenProvider(
  options: StreamerScreenProviderOptions,
): StreamerScreenProvider {
  return (input) => {
    if (!isStreamerScreenId(input.screenId)) {
      return null;
    }

    return toGeneratedScreenBundle(
      input.document,
      buildStreamerScreen({
        profile: options.profileOf(input.steamId),
        screenId: input.screenId,
      }),
      // O SHELL conhece `tela-config`: sem isto, o destaque do
      // botão sumiria justamente ao entrar nele.
      STREAMER_SCREEN_ID,
    );
  };
}

// ============================================================
//  O MENU QUE JÁ ESTÁ GRAVADO
//
//  ####  MUDAR O MODELO NAO CONSERTA QUEM JA TEM O MENU  ####
//
//  O documento nasce do preset UMA vez e depois é do admin: quem
//  editou o menu antes desta frente não ganharia a aba nunca,
//  porque o modelo não é reaplicado.
//
//  Então o agente ACRESCENTA a aba, uma vez, no boot — do mesmo
//  jeito que o botão do Discord foi religado (ver
//  ui-discord-screen.ts). A edição é a mais contida possível: um
//  botão a mais no fim da barra e uma tela a mais no documento.
//
//  ####  O BOTAO E UMA COPIA DO VIZINHO  ####
//
//  Cor, fonte, altura e tamanho de texto saem do último botão da
//  barra, e não de constantes daqui. É o que faz a aba nova nascer
//  parecida com as outras num menu que o admin recoloriu — um
//  botão com as cores do preset no meio de uma barra customizada
//  seria a marca de que ele foi posto por fora.
// ============================================================

/** O que separa um botão do outro na barra. Igual ao do preset. */
const NAV_GAP = 6;

/** A folga dos dois lados do texto, também do preset. */
const NAV_PADDING = 20;

interface NavSpot {
  /** O botão usado de modelo — o mais à direita da barra. */
  readonly model: Extract<UiElement, { type: 'button' }>;
  /** Onde ele mora: o id do pai, para a cópia entrar ao lado. */
  readonly parentId: string | null;
}

/** O botão de navegação mais à direita, e onde ele está pendurado. */
function findNavSpot(
  elements: readonly UiElement[],
  parentId: string | null = null,
): NavSpot | null {
  let best: NavSpot | null = null;

  for (const element of elements) {
    if (element.type === 'button' && element.id.startsWith('nav-')) {
      if (best === null || element.rect.offsetMax.x > best.model.rect.offsetMax.x) {
        best = { model: element, parentId };
      }
    }

    const deeper = findNavSpot(element.children, element.id);

    if (deeper !== null && (best === null || deeper.model.rect.offsetMax.x > best.model.rect.offsetMax.x)) {
      best = deeper;
    }
  }

  return best;
}

/** A cópia do modelo, deslocada para a direita dele. */
function tabFrom(model: Extract<UiElement, { type: 'button' }>): UiElement {
  const width = textWidth(STREAMER_TAB_LABEL, model.fontSize) + NAV_PADDING;
  const left = model.rect.offsetMax.x + NAV_GAP;

  return {
    ...model,
    id: STREAMER_TAB_ID,
    name: STREAMER_TAB_ID,
    text: STREAMER_TAB_LABEL,
    rect: {
      anchorMin: model.rect.anchorMin,
      anchorMax: model.rect.anchorMax,
      offsetMin: { x: left, y: model.rect.offsetMin.y },
      offsetMax: { x: left + width, y: model.rect.offsetMax.y },
    },
    action: { id: 'ir-config', kind: 'navigate', screenId: STREAMER_SCREEN_ID },
    // O "você está aqui" da barra, como o dos vizinhos.
    activeOnScreenId: STREAMER_SCREEN_ID,
    children: [],
  };
}

function insertAfter(
  elements: readonly UiElement[],
  parentId: string | null,
  afterId: string,
  tab: UiElement,
): UiElement[] {
  if (parentId === null) {
    return spliceAfter(elements, afterId, tab);
  }

  return elements.map((element) =>
    element.id === parentId
      ? { ...element, children: spliceAfter(element.children, afterId, tab) }
      : { ...element, children: insertAfter(element.children, parentId, afterId, tab) },
  );
}

function spliceAfter(
  elements: readonly UiElement[],
  afterId: string,
  tab: UiElement,
): UiElement[] {
  const out: UiElement[] = [];

  for (const element of elements) {
    out.push(element);

    if (element.id === afterId) {
      out.push(tab);
    }
  }

  return out;
}

/**
 * O documento com a aba CONFIGURAÇÕES, ou `null` se não há o que
 * fazer.
 *
 * `null` quando a tela já existe, quando o documento está no teto
 * de telas, ou quando a barra não tem nenhum botão de navegação —
 * um menu desenhado do zero, sem barra, não tem onde pendurar a
 * aba, e inventar um lugar seria desenhar por cima do trabalho de
 * quem fez.
 */
export function withStreamerTab(document: UiDocument): UiDocument | null {
  if (document.screens.some((screen) => screen.id === STREAMER_SCREEN_ID)) {
    return null;
  }

  if (document.screens.length >= MAX_SCREENS_PER_DOCUMENT) {
    return null;
  }

  const spot = findNavSpot(document.shell);

  if (spot === null) {
    return null;
  }

  return {
    ...document,
    shell: insertAfter(document.shell, spot.parentId, spot.model.id, tabFrom(spot.model)),
    screens: [
      ...document.screens,
      {
        ...buildStreamerScreen({ profile: defaultStreamerProfile(''), skeleton: true }),
        generated: true,
      },
    ],
  };
}
