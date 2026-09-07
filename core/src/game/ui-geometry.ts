// ============================================================
//  ui-geometry.ts  -  âncora + offset  ->  caixa em pixels.
//
//  ####  POR QUE ISTO EXISTE DOS DOIS LADOS  ####
//
//  A mesma conta mora em `panel/src/lib/ui-doc/geometry.ts`, e por
//  lá ela serve ao CANVAS: onde desenhar o retângulo na tela do
//  admin. Aqui ela serve a outra pergunta, que é a que a frente das
//  telas desenhadas precisa responder:
//
//      o admin desenhou uma caixa para a lista.
//      QUANTAS LINHAS CABEM DENTRO DELA?
//
//  Sem isso, o admin pode mover e recolorir a lista, mas
//  redimensioná-la faz a paginação mentir — o agente continuaria
//  derramando dez linhas numa caixa que agora comporta quatro.
//
//  Não há tipo compartilhado entre os pacotes (o painel é bundle de
//  navegador, o core é ESM de Node), então a conta é repetida. Ela
//  tem teste dos dois lados, e as duas versões precisam concordar:
//  divergir aqui faz o editor mostrar uma coisa e o jogo desenhar
//  outra.
//
//  ------------------------------------------------------------
//  ####  AS DUAS REGRAS DO CUI  ####
//
//   1. A ÂNCORA é normalizada (0..1) e relativa ao ELEMENTO PAI.
//   2. O OFFSET é em pixels e desloca a partir da âncora já
//      resolvida — NÃO do pai.
//
//  Com origem no canto INFERIOR esquerdo do pai e Y crescendo para
//  CIMA:
//
//      xMin = anchorMin.x * larguraPai + offsetMin.x
//      xMax = anchorMax.x * larguraPai + offsetMax.x
//      yMin = anchorMin.y * alturaPai  + offsetMin.y
//      yMax = anchorMax.y * alturaPai  + offsetMax.y
//
//  ####  O EIXO Y É INVERTIDO EM RELAÇÃO AO CSS  ####
//
//  A distância do topo do pai até o topo do elemento é
//  `alturaPai - yMax` — e não `yMin`, que é o engano natural.
//  Quem manda no TOPO em CSS é o offset MAX do Unity.
// ============================================================

import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';

import { documentUsesShell } from './ui-cui.js';

/**
 * O retângulo, do jeito que o schema o define.
 *
 * Tirado de `UiElement` porque `rectSchema` não é exportado — e
 * derivá-lo daqui é o que garante que esta conta nunca fique
 * olhando para uma forma que o modelo deixou de ter.
 */
type UiRect = UiElement['rect'];

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

/**
 * A base do CUI.
 *
 * Os offsets são pixels sobre 1280x720, e o jogo escala conforme a
 * resolução do cliente. Todo cálculo desta frente acontece nessa
 * unidade — a mesma em que as telas embutidas já são desenhadas
 * (ver as medidas em `ui-preset-main-menu.ts`).
 */
export const CANVAS: Size = { width: 1280, height: 720 };

/**
 * Âncora + offset -> caixa em pixels.
 *
 * `parent` é o tamanho do ELEMENTO PAI, não o da tela: um elemento
 * aninhado ancora dentro do contêiner dele.
 *
 * Largura e altura podem sair NEGATIVAS quando os offsets se
 * cruzam. Isso não é corrigido aqui de propósito — é um estado
 * legítimo do modelo, e escondê-lo faria o editor e o jogo
 * discordarem. Quem paginar dentro de uma caixa negativa recebe
 * zero linha, que é a leitura certa dela.
 */
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

/**
 * O tamanho do primeiro elemento cujo id casa, medido na cadeia.
 *
 * `null` = não existe na árvore. Percorre em profundidade
 * acumulando o tamanho do pai a cada nível, porque é assim que a
 * âncora resolve: um elemento a três níveis de fundo ancora dentro
 * do avô, não dentro da tela.
 *
 * O casamento é por FUNÇÃO, e não por id exato, porque a convenção
 * dos slots é por SUFIXO — ver `ui-template.ts`.
 */
export function measureElement(
  elements: readonly UiElement[],
  matches: (id: string) => boolean,
  parent: Size,
): Box | null {
  for (const element of elements) {
    const box = resolveRect(element.rect, parent);

    if (matches(element.id)) {
      return box;
    }

    const inside = measureElement(element.children, matches, {
      width: box.width,
      height: box.height,
    });

    if (inside !== null) {
      return inside;
    }
  }

  return null;
}

/**
 * O tamanho do contêiner onde UMA tela é desenhada.
 *
 * ####  UMA TELA NÃO É DESENHADA NA TELA DO JOGO  ####
 *
 * Com shell, ela entra no SLOT — o elemento que o cabeçalho reserva
 * para o conteúdo (ou para o modal). É o retângulo dele que manda
 * no que cabe, e ele costuma ser bem menor que 1280x720: o menu
 * principal tem cabeçalho, moldura e véu em volta.
 *
 * Sem shell, cada tela desenha tudo, e o contêiner é o canvas
 * inteiro. É como um menu simples funciona.
 *
 * Slot declarado que não existe no desenho cai no canvas: é o mesmo
 * que o conversor faz, e trocar isso por um erro derrubaria a tela
 * inteira por causa de um id trocado no editor.
 */
export function screenViewport(document: UiDocument, screen: UiScreen): Size {
  if (!documentUsesShell(document)) {
    return CANVAS;
  }

  const slotId = screen.kind === 'modal' ? document.modalSlotId : document.contentSlotId;

  if (slotId === null) {
    return CANVAS;
  }

  const box = measureElement(document.shell, (id) => id === slotId, CANVAS);

  return box === null ? CANVAS : { width: box.width, height: box.height };
}
