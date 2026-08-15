// ============================================================
//  ui-store-template.ts  -  os modais da loja, desenhados no
//  editor.
//
//  O modal de compra e o de resultado nascem no código
//  (ui-store-screens.ts). Isso funciona, mas tira do painel a única
//  parte da interface que o admin não consegue mexer: mover o
//  botão, trocar uma cor ou o texto exigiria editar TypeScript.
//
//  Este arquivo dá o meio-termo: o admin desenha o modal no editor,
//  e o agente PREENCHE os campos.
//
//  ------------------------------------------------------------
//  ####  O QUE É DO ADMIN E O QUE É DO AGENTE  ####
//
//    do ADMIN     posição, tamanho, cor, fonte, o que é escrito nos
//                 rótulos fixos, quais elementos existem
//
//    do AGENTE    o nome do item, o ícone, a quantidade, o total, o
//                 saldo e TODAS as ações
//
//  A divisão não é arbitrária. As ações carregam o `offerId` e a
//  quantidade que serão COBRADOS — se viessem do documento, um admin
//  distraído (ou um documento adulterado) mudaria o preço de uma
//  compra. Elas são montadas pelo agente, sempre.
//
//  ------------------------------------------------------------
//  ####  COMO O AGENTE SABE QUAL ELEMENTO É QUAL  ####
//
//  Pelo FIM do id, a mesma convenção do cabeçalho (ver ui-cui.ts). O
//  preset cria `…mcnome`, `…mctotal`, e este arquivo procura por
//  esses sufixos.
//
//  É convenção, e ela quebra em silêncio: renomear o elemento no
//  editor faz aquele campo parar de ser preenchido — o rótulo fica
//  com o texto de exemplo. Em troca, o admin pode mover, recolorir e
//  redimensionar tudo sem que nada aqui saiba.
//
//  Sem a tela no documento, o layout embutido continua valendo: é o
//  que mantém a loja funcionando em qualquer documento gravado antes
//  disto.
// ============================================================

import type { UiAction, UiElement, UiScreen } from '../types/ui-document.js';

/** A tela que serve de base para o modal de compra de ITEM. */
export const BUY_TEMPLATE_ID = 'ozmodalcompra';

/**
 * A base do modal de KIT, VIP e VEÍCULO.
 *
 * ####  ELE PRECISA DE UM SLOT, E O DE ITEM NÃO  ####
 *
 * Um modelo é um desenho FIXO. Isso basta para o modal de um item,
 * onde tudo o que muda é texto — mas a lista de um kit tem N linhas,
 * e nenhum layout estático abre espaço para três itens hoje e sete
 * amanhã.
 *
 * A saída é um elemento VAZIO marcando onde a lista mora. O admin
 * escolhe a posição e o tamanho dele; o agente derrama as linhas
 * dentro. Ver `children` em `SlotValue`.
 */
export const BUNDLE_TEMPLATE_ID = 'ozmodalpacote';

/** A tela que serve de base para o aviso de resultado. */
export const RESULT_TEMPLATE_ID = 'ozmodalresultado';

/**
 * Os sufixos que o agente reconhece.
 *
 * Mudar um destes exige regerar o preset do menu — ver
 * game/ui-preset-main-menu.ts.
 */
export const SLOTS = {
  // ---- modal de compra de item ----
  nome: 'mcnome',
  icone: 'mcicone',
  descricao: 'mcdesc',
  quantidade: 'mcqtd',
  total: 'mctotal',
  saldo: 'mcsaldo',
  menos: 'mcmenos',
  mais: 'mcmais',
  comprar: 'mccomprar',
  cancelar: 'mccancelar',

  // ---- modal de kit, VIP e veículo ----
  pacoteNome: 'mbnome',
  pacoteIcone: 'mbicone',
  pacoteResumo: 'mbdesc',
  pacoteTitulo: 'mbtitulo',
  /** O elemento VAZIO onde a lista é derramada. */
  pacoteLista: 'mblista',
  pacoteTotal: 'mbtotal',
  pacoteSaldo: 'mbsaldo',
  pacoteComprar: 'mbcomprar',
  pacoteCancelar: 'mbcancelar',

  // ---- aviso de resultado ----
  titulo: 'mrtitulo',
  mensagem: 'mrmsg',
  saldoResultado: 'mrsaldo',
  ok: 'mrok',
} as const;

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
