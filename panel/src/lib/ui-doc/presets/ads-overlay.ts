// ============================================================
//  O OVERLAY DE PROPAGANDAS, COMO DOCUMENTO DE INTERFACE.
//
//  ####  POR QUE ELE EXISTE DUAS VEZES  ####
//
//  O overlay é ANIMADO, e animação no CUI é o servidor mandando
//  quadros — não cabe num documento, que descreve um estado
//  parado. Por isso o que roda no jogo é gerado pelo agente a
//  partir dos números da tela de Propagandas.
//
//  Só que "os números da tela" são difíceis de acertar no escuro:
//  360 por 120 no canto com 24 de margem é fácil de escrever e
//  difícil de imaginar. Este preset resolve isso pondo o MESMO
//  desenho dentro do editor `/interface`, onde ele pode ser
//  arrastado, medido e comparado com o resto da tela.
//
//  ------------------------------------------------------------
//  ####  A FONTE DA VERDADE CONTINUA SENDO O AJUSTE  ####
//
//  O caminho é de mão dupla e EXPLÍCITO nas duas direções:
//
//    buildAdsOverlayDocument   ajuste  ->  documento (para desenhar)
//    readAdsOverlayLayout      documento -> ajuste (para trazer de volta)
//
//  Nenhuma das duas acontece sozinha. O agente NÃO lê este
//  documento — se lesse, teríamos duas verdades sobre onde o
//  painel fica, e a que diverge é sempre a que ninguém olha.
//
//  ------------------------------------------------------------
//  ####  OS IDS SAO A CONVENCAO, E ELA PODE SER QUEBRADA  ####
//
//  `ads-root`, `ads-logo`, `ads-panel` e `ads-image`. Renomear um
//  deles no editor faz a leitura de volta ignorar aquela medida —
//  sem quebrar mais nada. É a mesma regra dos rótulos do
//  cabeçalho do menu (ver BALANCE_ELEMENT_SUFFIX no agente).
// ============================================================

import type { UiDocument, UiElement, UiRect, UiScreen } from '../model';

/** O id fixo do documento. Regerar SUBSTITUI, não duplica. */
export const ADS_DOCUMENT_ID = 'ozads';

export const ADS_ROOT_ID = 'ads-root';
export const ADS_LOGO_ID = 'ads-logo';
export const ADS_PANEL_ID = 'ads-panel';
export const ADS_IMAGE_ID = 'ads-image';

/** As medidas que viajam entre o ajuste e o documento. */
export interface AdsOverlayLayout {
  readonly anchor: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  readonly marginTop: number;
  readonly marginRight: number;
  readonly logoWidth: number;
  readonly logoHeight: number;
  readonly panelWidth: number;
  readonly panelHeight: number;
  readonly panelColor: string;
  readonly panelBorderColor: string;
  readonly logoImageUrl: string | null;
}

interface Corner {
  readonly anchor: { x: number; y: number };
  readonly sx: number;
  readonly sy: number;
}

/**
 * O canto escolhido, em sinais.
 *
 * É a MESMA conta do agente (`cornerOf` em ads-timeline.ts), e
 * ela precisa continuar sendo: o desenho no editor tem de cair
 * exatamente onde o jogo vai pôr o widget, senão o preset engana
 * quem o usa para medir.
 */
function cornerOf(anchor: AdsOverlayLayout['anchor']): Corner {
  switch (anchor) {
    case 'top-left':
      return { anchor: { x: 0, y: 1 }, sx: 1, sy: -1 };
    case 'bottom-right':
      return { anchor: { x: 1, y: 0 }, sx: -1, sy: 1 };
    case 'bottom-left':
      return { anchor: { x: 0, y: 0 }, sx: 1, sy: 1 };
    case 'top-right':
    default:
      return { anchor: { x: 1, y: 1 }, sx: -1, sy: -1 };
  }
}

function cornerRect(
  corner: Corner,
  insetX: number,
  insetY: number,
  width: number,
  height: number,
): UiRect {
  const x1 = corner.sx * insetX;
  const x2 = x1 + corner.sx * width;
  const y1 = corner.sy * insetY;
  const y2 = y1 + corner.sy * height;

  return {
    anchorMin: { ...corner.anchor },
    anchorMax: { ...corner.anchor },
    offsetMin: { x: Math.min(x1, x2), y: Math.min(y1, y2) },
    offsetMax: { x: Math.max(x1, x2), y: Math.max(y1, y2) },
  };
}

function size(rect: UiRect): { width: number; height: number } {
  return {
    width: Math.abs(rect.offsetMax.x - rect.offsetMin.x),
    height: Math.abs(rect.offsetMax.y - rect.offsetMin.y),
  };
}

/**
 * O ajuste -> um documento desenhável.
 *
 * O documento nasce com `cursor: false` e comando próprio: ele
 * NÃO é um menu que alguém abre, é uma maquete. Abri-lo no jogo
 * mostraria o widget parado, que é justamente o que se quer
 * conferir.
 */
export function buildAdsOverlayDocument(
  layout: AdsOverlayLayout,
  options: { readonly command?: string; readonly layer?: UiDocument['layer'] } = {},
): UiDocument {
  const corner = cornerOf(layout.anchor);

  const areaWidth = Math.max(layout.panelWidth, layout.logoWidth);
  const areaHeight = Math.max(layout.panelHeight, layout.logoHeight);

  const root: UiElement = {
    id: ADS_ROOT_ID,
    name: 'Área do overlay',
    type: 'panel',
    // Transparente: a área existe para POSICIONAR, e não para
    // aparecer. Pintá-la faria o admin acertar o lugar de um
    // retângulo que o jogo nunca desenha.
    color: '#FFFFFF14',
    sprite: null,
    imageType: 'Simple',
    material: null,
    rect: cornerRect(corner, layout.marginRight, layout.marginTop, areaWidth, areaHeight),
    children: [
      {
        id: ADS_LOGO_ID,
        name: 'Logo (repouso)',
        type: 'image',
        source:
          layout.logoImageUrl === null
            ? { kind: 'sprite', sprite: 'assets/content/ui/ui.background.tile.psd' }
            : { kind: 'url', url: layout.logoImageUrl },
        color: '#FFFFFFFF',
        rect: cornerRect(
          { anchor: corner.anchor, sx: corner.sx, sy: corner.sy },
          0,
          0,
          layout.logoWidth,
          layout.logoHeight,
        ),
        children: [],
      },
      {
        id: ADS_PANEL_ID,
        name: 'Painel (aberto)',
        type: 'panel',
        color: layout.panelBorderColor,
        sprite: null,
        imageType: 'Simple',
        material: null,
        rect: cornerRect(
          { anchor: corner.anchor, sx: corner.sx, sy: corner.sy },
          0,
          0,
          layout.panelWidth,
          layout.panelHeight,
        ),
        children: [
          {
            id: ADS_IMAGE_ID,
            name: 'Propaganda',
            type: 'panel',
            color: layout.panelColor,
            sprite: null,
            imageType: 'Simple',
            material: null,
            rect: {
              anchorMin: { x: 0, y: 0 },
              anchorMax: { x: 1, y: 1 },
              offsetMin: { x: 1, y: 1 },
              offsetMax: { x: -1, y: -1 },
            },
            children: [],
          },
        ],
      },
    ],
  };

  const screen: UiScreen = {
    id: 'overlay',
    name: 'Overlay',
    kind: 'page',
    elements: [root],
  };

  return {
    id: ADS_DOCUMENT_ID,
    name: 'Overlay de Propagandas',
    command: options.command ?? 'propagandas',
    permission: null,
    layer: options.layer ?? 'Hud',
    // ####  SEM CURSOR, E ISSO IMPORTA  ####
    //
    // O overlay de verdade não recebe clique. Uma maquete que
    // rouba o mouse do jogador ao ser aberta ensinaria a coisa
    // errada sobre o que se está desenhando.
    cursor: false,
    fadeIn: 0.2,
    shell: [],
    contentSlotId: null,
    modalSlotId: null,
    entryScreenId: 'overlay',
    shortcuts: [],
    screens: [screen],
  };
}

/**
 * O documento -> as medidas, de volta.
 *
 * `null` para o que não seguir a convenção: um documento em que
 * alguém renomeou os ids simplesmente não devolve medida nenhuma,
 * em vez de devolver números errados. Nesse caso a tela mantém o
 * que já tinha, e é a resposta certa — o contrário seria mover o
 * widget para um lugar que ninguém escolheu.
 */
export function readAdsOverlayLayout(
  document: UiDocument,
): Partial<AdsOverlayLayout> | null {
  const screen = document.screens.find((item) => item.id === document.entryScreenId);
  if (screen === undefined) return null;

  const flat = new Map<string, UiElement>();

  const visit = (elements: readonly UiElement[]): void => {
    for (const element of elements) {
      flat.set(element.id, element);
      visit(element.children);
    }
  };

  visit(screen.elements);

  const root = flat.get(ADS_ROOT_ID);
  if (root === undefined) return null;

  const layout: Record<string, unknown> = {};

  // A margem sai do offset do canto ANCORADO, e por isso ela é
  // lida em módulo: no canto direito os offsets são negativos, e
  // uma margem negativa não significa nada.
  const anchorX = root.rect.anchorMin.x;
  const anchorY = root.rect.anchorMin.y;

  // O canto sai da ÂNCORA, e só dela: (1,1) é o superior direito,
  // (0,1) o superior esquerdo, e assim por diante. Uma âncora que
  // não seja um dos quatro cantos (alguém esticou o elemento no
  // editor) não devolve canto nenhum — e a tela mantém o que
  // tinha, em vez de escolher por conta própria.
  if ((anchorX === 0 || anchorX === 1) && (anchorY === 0 || anchorY === 1)) {
    layout.anchor =
      anchorY === 1
        ? anchorX === 1
          ? 'top-right'
          : 'top-left'
        : anchorX === 1
          ? 'bottom-right'
          : 'bottom-left';
  }

  layout.marginRight = Math.round(
    anchorX === 1 ? Math.abs(root.rect.offsetMax.x) : Math.abs(root.rect.offsetMin.x),
  );
  layout.marginTop = Math.round(
    anchorY === 1 ? Math.abs(root.rect.offsetMax.y) : Math.abs(root.rect.offsetMin.y),
  );

  const logo = flat.get(ADS_LOGO_ID);
  if (logo !== undefined) {
    const measured = size(logo.rect);
    layout.logoWidth = Math.round(measured.width);
    layout.logoHeight = Math.round(measured.height);

    if (logo.type === 'image' && logo.source.kind === 'url') {
      layout.logoImageUrl = logo.source.url;
    }
  }

  const panel = flat.get(ADS_PANEL_ID);
  if (panel !== undefined) {
    const measured = size(panel.rect);
    layout.panelWidth = Math.round(measured.width);
    layout.panelHeight = Math.round(measured.height);

    if (panel.type === 'panel') {
      layout.panelBorderColor = panel.color;
    }
  }

  const image = flat.get(ADS_IMAGE_ID);
  if (image !== undefined && image.type === 'panel') {
    layout.panelColor = image.color;
  }

  return layout as Partial<AdsOverlayLayout>;
}
