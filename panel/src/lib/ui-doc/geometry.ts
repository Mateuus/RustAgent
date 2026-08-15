// ============================================================
//  GEOMETRIA: âncora + offset do CUI  <->  caixa em pixels.
//
//  ####  ESTE ARQUIVO É O QUE MAIS ERRA, E O ERRO É INVISÍVEL  ####
//
//  Um engano aqui não quebra nada no navegador: o layout aparece
//  bonito e chega ESPELHADO dentro do jogo. Como menu costuma
//  ser simétrico, o defeito só se revela quando alguém ancora
//  algo embaixo — e aí já tem uma tela inteira desenhada em cima
//  do erro. Por isso a lógica está separada da renderização e
//  tem teste próprio.
//
//  ------------------------------------------------------------
//  AS DUAS REGRAS DO CUI
//
//   1. A ÂNCORA é normalizada (0..1) e relativa ao ELEMENTO PAI.
//   2. O OFFSET é em pixels e desloca a partir da âncora já
//      resolvida — NÃO do pai.
//
//  Em coordenadas do Unity, com origem no canto INFERIOR
//  esquerdo do pai e Y crescendo para CIMA:
//
//      xMin = anchorMin.x * larguraPai + offsetMin.x
//      xMax = anchorMax.x * larguraPai + offsetMax.x
//      yMin = anchorMin.y * alturaPai  + offsetMin.y
//      yMax = anchorMax.y * alturaPai  + offsetMax.y
//
//  ------------------------------------------------------------
//  ####  O EIXO Y É INVERTIDO EM RELAÇÃO AO CSS  ####
//
//  No Unity Y cresce para cima; em CSS `top` cresce para baixo.
//  A distância do topo do pai até o topo do elemento é, então,
//  `alturaPai - yMax` — e não `yMin`, que é o engano natural.
//
//      top = alturaPai - yMax
//          = alturaPai - (anchorMax.y * alturaPai + offsetMax.y)
//          = (1 - anchorMax.y) * alturaPai - offsetMax.y
//
//  Note que quem manda no TOPO em CSS é o offset MAX do Unity.
// ============================================================

import type { UiRect, Vec2 } from './model';

// ------------------------------------------------------------
//  A base de referência do CUI.
//
//  Os offsets são pixels sobre 1280x720, e o jogo escala
//  conforme a resolução do cliente. O editor trabalha nessa base
//  e o canvas aplica um `transform: scale()` — assim toda conta
//  deste arquivo acontece na mesma unidade que o jogo usa, e a
//  escala é problema só da apresentação.
//
//  #### PONTO DE INCERTEZA ####
//  Não foi verificado no servidor real como isso interage com o
//  `graphics.uiscale` do cliente. Se a medição contradisser, o
//  que muda é a régua do canvas, não este módulo.
// ------------------------------------------------------------
export const REFERENCE_WIDTH = 1280;
export const REFERENCE_HEIGHT = 720;

/** Uma caixa em pixels, no sistema do CSS (Y para baixo). */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const REFERENCE_SIZE: Size = {
  width: REFERENCE_WIDTH,
  height: REFERENCE_HEIGHT,
};

// ------------------------------------------------------------
//  Âncora + offset  ->  caixa em pixels.
//
//  `parent` é o tamanho do ELEMENTO PAI, não o da tela: um
//  elemento aninhado ancora dentro do contêiner dele.
//
//  Largura e altura podem sair NEGATIVAS quando os offsets se
//  cruzam (offsetMin.x maior que offsetMax.x). Isso não é
//  corrigido aqui de propósito — é um estado legítimo do modelo,
//  produzido ao arrastar uma borda além da oposta, e quem
//  renderiza decide se mostra vazio ou normaliza. Escondê-lo
//  aqui faria o canvas e o jogo discordarem.
// ------------------------------------------------------------
export function resolveRect(rect: UiRect, parent: Size): Box {
  const xMin = rect.anchorMin.x * parent.width + rect.offsetMin.x;
  const xMax = rect.anchorMax.x * parent.width + rect.offsetMax.x;

  const yMin = rect.anchorMin.y * parent.height + rect.offsetMin.y;
  const yMax = rect.anchorMax.y * parent.height + rect.offsetMax.y;

  return {
    left: xMin,
    // A inversão do eixo. Ver o cabeçalho.
    top: parent.height - yMax,
    width: xMax - xMin,
    height: yMax - yMin,
  };
}

// ------------------------------------------------------------
//  Caixa em pixels  ->  offsets, PRESERVANDO as âncoras.
//
//  É o caminho de volta, usado quando alguém arrasta ou
//  redimensiona no canvas.
//
//  ####  POR QUE AS ÂNCORAS NÃO MUDAM AO ARRASTAR  ####
//
//  A âncora é uma DECISÃO de layout ("este botão gruda no canto
//  inferior direito"), e o offset é o ajuste fino. Recalcular a
//  âncora a cada arrasto destruiria essa decisão em silêncio: um
//  elemento ancorado no canto passaria a ancorar em 0.37 0.62 e
//  deixaria de acompanhar o canto quando a tela mudasse de
//  tamanho.
//
//  Quem quer trocar a âncora troca no inspetor, de propósito.
// ------------------------------------------------------------
export function rectFromBox(box: Box, anchors: UiRect, parent: Size): UiRect {
  const xMin = box.left;
  const xMax = box.left + box.width;

  // De volta ao sistema do Unity: yMax é a distância do FUNDO do
  // pai até o topo do elemento.
  const yMax = parent.height - box.top;
  const yMin = yMax - box.height;

  return {
    anchorMin: anchors.anchorMin,
    anchorMax: anchors.anchorMax,
    offsetMin: {
      x: xMin - anchors.anchorMin.x * parent.width,
      y: yMin - anchors.anchorMin.y * parent.height,
    },
    offsetMax: {
      x: xMax - anchors.anchorMax.x * parent.width,
      y: yMax - anchors.anchorMax.y * parent.height,
    },
  };
}

// ------------------------------------------------------------
//  Trocar a âncora SEM mover o elemento.
//
//  É o que o inspetor precisa: mudar "gruda no canto" não pode
//  fazer a caixa saltar na tela. Resolve a caixa com a âncora
//  velha e recalcula os offsets com a nova.
// ------------------------------------------------------------
export function reanchor(rect: UiRect, anchorMin: Vec2, anchorMax: Vec2, parent: Size): UiRect {
  const box = resolveRect(rect, parent);
  return rectFromBox(box, { ...rect, anchorMin, anchorMax }, parent);
}

// ------------------------------------------------------------
//  Estilo CSS de um elemento, para o preview.
//
//  Usa `calc(% + px)` em vez de pixels prontos, e isso é de
//  propósito: assim a âncora continua sendo uma PORCENTAGEM do
//  pai no DOM, exatamente como no jogo, e o preview não precisa
//  saber o tamanho de contêiner nenhum para renderizar. Um
//  elemento aninhado três níveis abaixo funciona sem que ninguém
//  resolva a cadeia.
//
//  `right`/`bottom` em vez de `width`/`height` pelo mesmo
//  motivo: as duas bordas são ancoradas independentemente, e
//  derivar largura exigiria resolver o pai.
// ------------------------------------------------------------
export interface CssBox {
  readonly left: string;
  readonly top: string;
  readonly right: string;
  readonly bottom: string;
}

export function rectToCss(rect: UiRect): CssBox {
  const percent = (value: number): string => `${(value * 100).toFixed(4)}%`;
  const offset = (value: number): string => `${value.toFixed(2)}px`;

  return {
    left: `calc(${percent(rect.anchorMin.x)} + ${offset(rect.offsetMin.x)})`,
    right: `calc(${percent(1 - rect.anchorMax.x)} - ${offset(rect.offsetMax.x)})`,
    // Topo do CSS vem do MAX do Unity — ver o cabeçalho.
    top: `calc(${percent(1 - rect.anchorMax.y)} - ${offset(rect.offsetMax.y)})`,
    bottom: `calc(${percent(rect.anchorMin.y)} + ${offset(rect.offsetMin.y)})`,
  };
}

// ------------------------------------------------------------
//  Âncoras prontas, para o inspetor oferecer em um clique.
//
//  São as decisões de layout que aparecem em 90% dos casos, e
//  digitar quatro pares de números para "centralizado" é o tipo
//  de atrito que faz uma ferramenta parecer hostil.
// ------------------------------------------------------------
export interface AnchorPreset {
  readonly id: string;
  readonly label: string;
  readonly anchorMin: Vec2;
  readonly anchorMax: Vec2;
}

export const ANCHOR_PRESETS: readonly AnchorPreset[] = [
  {
    id: 'stretch',
    label: 'Esticar',
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
  },
  {
    id: 'center',
    label: 'Centro',
    anchorMin: { x: 0.5, y: 0.5 },
    anchorMax: { x: 0.5, y: 0.5 },
  },
  {
    id: 'top-left',
    label: 'Topo esq.',
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
  },
  {
    id: 'top-right',
    label: 'Topo dir.',
    anchorMin: { x: 1, y: 1 },
    anchorMax: { x: 1, y: 1 },
  },
  {
    id: 'bottom-left',
    label: 'Base esq.',
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 0 },
  },
  {
    id: 'bottom-right',
    label: 'Base dir.',
    anchorMin: { x: 1, y: 0 },
    anchorMax: { x: 1, y: 0 },
  },
  {
    id: 'top-stretch',
    label: 'Faixa topo',
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
  },
  {
    id: 'bottom-stretch',
    label: 'Faixa base',
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
  },
];

/**
 * Qual preset corresponde às âncoras atuais, se algum.
 *
 * Comparação exata: o preset é uma escolha discreta, e um
 * elemento em 0.4999 não está "quase centralizado" — está com
 * âncora própria, e marcar o botão de centro como ativo mentiria
 * sobre o que um clique nele faria.
 */
export function matchAnchorPreset(rect: UiRect): AnchorPreset | null {
  return (
    ANCHOR_PRESETS.find(
      (preset) =>
        preset.anchorMin.x === rect.anchorMin.x &&
        preset.anchorMin.y === rect.anchorMin.y &&
        preset.anchorMax.x === rect.anchorMax.x &&
        preset.anchorMax.y === rect.anchorMax.y,
    ) ?? null
  );
}
