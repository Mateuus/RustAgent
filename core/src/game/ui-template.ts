// ============================================================
//  ui-template.ts  -  a tela é desenhada; o dado é preenchido.
//
//  ####  O QUE ESTE MECANISMO RESOLVE  ####
//
//  As telas com dado vivo — loja, ranking, kits, missões,
//  calendário — nascem de código: seis mil linhas de TypeScript
//  posicionando retângulo por retângulo. Funciona, e tira do painel
//  justamente as cinco telas que o jogador mais abre: mover um
//  botão exige editar TypeScript, e trocar uma cor exige um deploy.
//
//  Aqui está o meio-termo, e ele já estava provado nos modais da
//  loja antes de virar um arquivo próprio:
//
//    do ADMIN     posição, tamanho, cor, fonte, o que é escrito nos
//                 rótulos fixos, quais elementos existem
//
//    do AGENTE    os textos que dependem do jogador, os ícones, as
//                 N linhas de uma lista, e TODAS as ações
//
//  ------------------------------------------------------------
//  ####  A AÇÃO É SEMPRE DO AGENTE, E ISSO É SEGURANÇA  ####
//
//  Não é conveniência. As ações carregam o que vai ser COBRADO — o
//  `offerId` e a quantidade de uma compra, o kit que será entregue.
//  Se viessem do documento, um admin distraído (ou um documento
//  adulterado) mudaria o preço de uma compra.
//
//  O desenho diz ONDE o botão fica; o agente diz o que ele FAZ.
//
//  ------------------------------------------------------------
//  ####  E É O QUE FAZ A NAVEGAÇÃO COM PARÂMETRO CABER  ####
//
//  O `uiDocumentSchema` recusa `:` em `screenId` de ação. Um
//  documento com um botão apontando para `tela-quest:disponiveis`
//  SERIA RECUSADO NA GRAVAÇÃO, e o menu sumiria do jogo — a tela
//  que o agente monta a cada clique é que não passa pelo schema.
//
//  Ou seja: aba e paginação NÃO PODEM estar no desenho. O admin
//  desenha o botão; o endereço entra aqui.
//
//  ------------------------------------------------------------
//  ####  COMO O AGENTE SABE QUAL ELEMENTO É QUAL  ####
//
//  Pelo FIM do id. O desenho traz `…mcnome`, e quem preenche
//  procura por esse sufixo.
//
//  É convenção, e ela quebra em SILÊNCIO: renomear o elemento no
//  editor faz aquele campo parar de ser preenchido, e o rótulo fica
//  com o texto de exemplo. Em troca, o admin pode mover, recolorir
//  e redimensionar tudo sem que nada aqui precise saber.
//
//  ------------------------------------------------------------
//  ####  SEM A TELA NO DOCUMENTO, O LAYOUT EMBUTIDO VALE  ####
//
//  `findTemplate` devolve `null` e quem chamou desenha do jeito
//  antigo. Não é degradação temporária: é o que mantém de pé todo
//  documento gravado antes desta frente, e o que faz cada tela
//  convertida ser reversível — apagar a tela do documento devolve
//  o layout de código.
// ============================================================

import type { UiAction, UiElement, UiScreen } from '../types/ui-document.js';

import { measureElement, type Box, type Size } from './ui-geometry.js';

/**
 * O que preencher em cada lugar.
 *
 * `text` troca o rótulo; `action` troca o que o botão faz; `item`
 * troca o ícone; `color` a cor; `hide` some com o elemento.
 */
export interface SlotValue {
  readonly text?: string;
  readonly action?: UiAction;
  readonly item?: { readonly itemId: number; readonly skinId: string };
  /**
   * A arte PRÓPRIA, pela chave no OrigemZImages.
   *
   * Ganha do `item` quando os dois vêm: quem preenche os dois é o
   * card da loja, que sabe qual dos dois desenhos a oferta escolheu.
   */
  readonly stored?: { readonly key: string };
  readonly color?: string;
  readonly hide?: boolean;
  /**
   * O CONTEÚDO a derramar dentro deste elemento.
   *
   * Substitui os filhos que o modelo tinha. É o que permite um
   * desenho fixo hospedar uma lista de tamanho desconhecido: o admin
   * decide ONDE ela cabe, o agente decide o que vai dentro.
   */
  readonly children?: readonly UiElement[];
}

/**
 * Aplica os valores sobre a tela desenhada no editor.
 *
 * Devolve uma tela NOVA — o documento em memória é compartilhado
 * entre pedidos, e mutá-lo faria a compra de um jogador aparecer na
 * tela do seguinte.
 */
export function fillTemplate(
  template: UiScreen,
  screenId: string,
  values: Readonly<Record<string, SlotValue>>,
): UiScreen {
  return {
    ...template,
    id: screenId,
    elements: fillElements(template.elements, values),
  };
}

function fillElements(
  elements: readonly UiElement[],
  values: Readonly<Record<string, SlotValue>>,
): UiElement[] {
  const output: UiElement[] = [];

  for (const element of elements) {
    const slot = slotOf(element.id, values);

    // `hide` remove a SUBÁRVORE inteira: o botão de comprar sem
    // saldo não pode ficar como um retângulo morto na tela, e o
    // texto dele é filho dele.
    if (slot?.hide === true) {
      continue;
    }

    output.push({
      ...applyValue(element, slot),
      // Conteúdo injetado GANHA dos filhos do modelo: o elemento de
      // lista é um marcador vazio, e o que estiver desenhado dentro
      // dele é exemplo.
      children: slot?.children ?? fillElements(element.children, values),
    } as UiElement);
  }

  return output;
}

function slotOf(id: string, values: Readonly<Record<string, SlotValue>>): SlotValue | undefined {
  for (const [suffix, value] of Object.entries(values)) {
    if (id.endsWith(suffix)) {
      return value;
    }
  }

  return undefined;
}

function applyValue(element: UiElement, slot: SlotValue | undefined): UiElement {
  if (slot === undefined) {
    return element;
  }

  switch (element.type) {
    case 'label':
      return {
        ...element,
        ...(slot.text === undefined ? {} : { text: slot.text }),
        ...(slot.color === undefined ? {} : { color: slot.color }),
      };

    case 'button':
      return {
        ...element,
        ...(slot.text === undefined ? {} : { text: slot.text }),
        ...(slot.color === undefined ? {} : { color: slot.color }),
        // A AÇÃO SEMPRE VEM DAQUI, nunca do documento: ela carrega o
        // que vai ser cobrado. Ver o cabeçalho.
        ...(slot.action === undefined ? {} : { action: slot.action }),
      };

    case 'image':
      if (slot.stored !== undefined) {
        return { ...element, source: { kind: 'stored', key: slot.stored.key } };
      }

      return slot.item === undefined
        ? element
        : {
            ...element,
            source: { kind: 'item', itemId: slot.item.itemId, skinId: slot.item.skinId },
          };

    case 'panel':
      // Painel só aceita cor: o que muda dentro dele são os FILHOS,
      // e esses já são visitados.
      return slot.color === undefined ? element : { ...element, color: slot.color };
  }
}

/**
 * A tela base existe no documento?
 *
 * `null` = o documento não a tem (foi gravado antes disto, ou o
 * admin a apagou), e o gerador cai no layout embutido.
 */
export function findTemplate(screens: readonly UiScreen[], templateId: string): UiScreen | null {
  return screens.find((screen) => screen.id === templateId) ?? null;
}

/**
 * O tamanho do slot que o admin desenhou. `null` = não existe.
 *
 * ####  A PERGUNTA É "QUANTAS LINHAS CABEM"  ####
 *
 * Um modal de compra tem tamanho fixo, e por isso a loja nunca
 * precisou disto: as linhas do pacote entram e pronto. Uma lista
 * PAGINADA não tem essa sorte — o agente decide quantas linhas
 * mandar, e mandar mais do que cabe não corta nada na tela: manda
 * pelo RCON o que ninguém vai ver, e aproxima do teto de 50.000
 * bytes a carga inteira.
 *
 * `viewport` é o tamanho de onde a tela é desenhada, e vem de
 * `screenViewport` — com shell, é o slot de conteúdo, e não a tela
 * do jogo.
 */
export function measureSlot(template: UiScreen, suffix: string, viewport: Size): Box | null {
  return measureElement(template.elements, (id) => id.endsWith(suffix), viewport);
}
