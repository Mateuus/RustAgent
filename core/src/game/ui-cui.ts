// ============================================================
//  ui-cui.ts  -  MODELO -> JSON de CUI, do lado do AGENTE.
//
//  ####  POR QUE A CONVERSÃO MORA AQUI, E NÃO NO PLUGIN  ####
//
//  O plugin poderia receber o modelo e montar o CUI em C#. Não
//  recebe, e a diferença é grande:
//
//    - a conversão tem armadilhas (nomes de campo minúsculos e
//      diferentes dos da classe C#, botão que são DOIS elementos,
//      cor em floats de 0 a 1) e cada uma delas falha em SILÊNCIO
//      no cliente — campo errado é ignorado, sem erro nenhum;
//    - em C# ela não teria teste: não há servidor de Rust no CI;
//    - e ela precisaria ser mantida em sincronia com o modelo, que
//      muda no painel.
//
//  Com a conversão aqui, o plugin fica BURRO: recebe uma lista de
//  `CuiElement` pronta, troca o token da sessão e chama `AddUi`.
//  Um campo novo no modelo não exige recompilar plugin nenhum.
//
//  ####  ESTE ARQUIVO ESPELHA panel/src/lib/ui-doc/to-cui.ts  ####
//
//  São duas implementações da mesma conversão, em pacotes que não
//  compartilham código. A do painel serve ao preview do editor;
//  esta serve ao jogo. **Mudar uma exige mudar a outra** — e o
//  `POST /api/ui/documents/:id/preview` existe justamente para o
//  editor conferir contra ESTA, que é a que vale.
// ============================================================

import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { imagePlaceholder } from './ui-images.js';

export interface CuiComponent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface CuiElement {
  readonly name: string;
  readonly parent: string;
  readonly components: readonly CuiComponent[];
  readonly destroyUi?: string;
  /**
   * Atualiza um elemento que JÁ existe, em vez de criar.
   *
   * O cliente casa pelo `name` e troca só os componentes enviados.
   * É o que permite mudar a cor do botão ativo sem recriar o
   * cabeçalho — ver `screenUpdatesToCui`.
   */
  readonly update?: boolean;
}

/**
 * Nome do elemento raiz.
 *
 * Fixo, e igual ao `RootName` do OrigemZUI: é por ele que o plugin
 * destrói a interface inteira, e é o que torna "trocar de tela"
 * possível. MUDAR AQUI EXIGE MUDAR O PLUGIN JUNTO.
 */
export const ROOT_NAME = 'OrigemZUI';

/**
 * O lugar do token de sessão dentro do comando do botão.
 *
 * O token só existe quando a interface abre para um jogador
 * específico, e o CUI é gerado antes disso. O plugin faz um
 * `Replace` deste texto pelo token da sessão — é a única coisa que
 * ele precisa mexer no JSON que recebe.
 */
export const SESSION_TOKEN_PLACEHOLDER = '{token}';

function vec(x: number, y: number): string {
  const format = (value: number): string => Number.parseFloat(value.toFixed(4)).toString();

  return `${format(x)} ${format(y)}`;
}

/**
 * `#RRGGBBAA` -> `"R G B A"` com floats de 0 a 1.
 *
 * O CUI não entende hex. Mandar `"#C43F2C"` num campo de cor não
 * dá erro: o cliente lê zero em tudo e desenha um retângulo preto
 * transparente — que é exatamente o tipo de falha silenciosa que
 * justifica esta conversão morar num lugar com teste.
 */
export function cuiColor(hex: string): string {
  const clean = hex.replace('#', '');
  const byteAt = (index: number): number => Number.parseInt(clean.slice(index, index + 2), 16);

  const channels = [byteAt(0), byteAt(2), byteAt(4), clean.length >= 8 ? byteAt(6) : 255];

  return channels
    .map((channel) => {
      const value = Number.isFinite(channel) ? channel : 0;

      return Number.parseFloat((value / 255).toFixed(3)).toString();
    })
    .join(' ');
}

function rectTransform(element: UiElement): CuiComponent {
  const { rect } = element;

  return {
    type: 'RectTransform',
    // Minúsculos, e diferentes dos nomes em C#. Nome errado é
    // ignorado em silêncio pelo cliente, e o elemento nasce com o
    // retângulo inteiro do pai.
    anchormin: vec(rect.anchorMin.x, rect.anchorMin.y),
    anchormax: vec(rect.anchorMax.x, rect.anchorMax.y),
    offsetmin: vec(rect.offsetMin.x, rect.offsetMin.y),
    offsetmax: vec(rect.offsetMax.x, rect.offsetMax.y),
  };
}

/**
 * O comando que o botão manda ao ser clicado.
 *
 * ####  ELE CARREGA UM ENDEREÇO, NUNCA A INTENÇÃO  ####
 *
 * O `command` de um botão é executado pelo CLIENTE: qualquer
 * jogador pode digitá-lo no F1 com os argumentos que quiser. Por
 * isso ele leva só o id da ação, e é o servidor que decide o que
 * fazer — lendo o documento que o admin salvou.
 *
 * Inclusive o `close`: usar o campo `close` do
 * `CuiButtonComponent` fecharia a interface só do lado do cliente,
 * e o servidor não saberia invalidar o token da sessão.
 */
function actionCommand(actionId: string): string {
  return `origemz.ui.act ${SESSION_TOKEN_PLACEHOLDER} ${actionId}`;
}

/**
 * O skin como NÚMERO, ou 0 quando não há.
 *
 * O cliente lê com `(ulong)obj.GetNumber("skinid")`, então string
 * não serve. O modelo guarda string porque skin de workshop passa
 * de 2^53 e não sobreviveria a um `number` de JavaScript.
 */
function skinIdOf(raw: string): number {
  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function emitElement(
  element: UiElement,
  parentName: string,
  fadeIn: number,
  output: CuiElement[],
): void {
  const name = `${ROOT_NAME}.${element.id}`;
  const fade = fadeIn > 0 ? { fadeIn } : {};

  switch (element.type) {
    case 'panel': {
      const image: Record<string, unknown> = {
        type: 'UnityEngine.UI.Image',
        color: cuiColor(element.color),
        ...fade,
      };

      if (element.sprite !== null) {
        image.sprite = element.sprite;
        image.imagetype = element.imageType;
      }

      if (element.material !== null) {
        image.material = element.material;
      }

      output.push({
        name,
        parent: parentName,
        components: [image as CuiComponent, rectTransform(element)],
      });
      break;
    }

    case 'label': {
      output.push({
        name,
        parent: parentName,
        components: [
          {
            type: 'UnityEngine.UI.Text',
            text: element.text,
            fontSize: element.fontSize,
            font: element.font,
            align: element.align,
            color: cuiColor(element.color),
            ...fade,
          },
          rectTransform(element),
        ],
      });
      break;
    }

    case 'button': {
      const button: Record<string, unknown> = {
        type: 'UnityEngine.UI.Button',
        command: actionCommand(element.action.id),
        color: cuiColor(element.color),
        ...fade,
      };

      if (element.sprite !== null) {
        button.sprite = element.sprite;
      }

      if (element.hoverColor !== null) {
        button.highlightedColor = cuiColor(element.hoverColor);
      }

      if (element.pressedColor !== null) {
        button.pressedColor = cuiColor(element.pressedColor);
      }

      output.push({
        name,
        parent: parentName,
        components: [button as CuiComponent, rectTransform(element)],
      });

      // ####  UM BOTÃO SÃO DOIS ELEMENTOS  ####
      //
      // O `CuiButtonComponent` não tem texto. Sem este segundo
      // elemento o botão sai VAZIO no jogo, sem erro nenhum — e o
      // menu fica com uma fileira de retângulos mudos.
      output.push({
        name: `${name}.text`,
        parent: name,
        components: [
          {
            type: 'UnityEngine.UI.Text',
            text: element.text,
            fontSize: element.fontSize,
            font: element.font,
            align: element.align,
            color: cuiColor(element.textColor),
            ...fade,
          },
          {
            type: 'RectTransform',
            anchormin: '0 0',
            anchormax: '1 1',
            offsetmin: '0 0',
            offsetmax: '0 0',
          },
        ],
      });
      break;
    }

    case 'image': {
      const source = element.source;

      const base =
        source.kind === 'url'
          ? { type: 'UnityEngine.UI.RawImage', url: source.url }
          : source.kind === 'stored'
            ? // `png` recebe o CRC do FileStorage, que só o plugin
              // conhece. Aqui sai o lugar reservado, e ele o troca
              // na hora de desenhar — igual ao token da sessão.
              { type: 'UnityEngine.UI.RawImage', png: imagePlaceholder(source.key) }
            : source.kind === 'sprite'
              ? { type: 'UnityEngine.UI.Image', sprite: source.sprite }
              : {
                  type: 'UnityEngine.UI.Image',
                  itemid: source.itemId,
                  // ####  skinid 0 DERRUBA O JOGADOR  ####
                  //
                  // O cliente faz:
                  //
                  //   var skin = itemdef.skins.FirstOrDefault(
                  //       x => x.id == (int)requestedSkin);
                  //   if (skin.id == (int)requestedSkin)
                  //       c.sprite = skin.invItem.icon;
                  //
                  // Com skinid 0 num item SEM skins, o
                  // `FirstOrDefault` devolve o default do struct —
                  // cujo id é 0. O `if` passa, `skin.invItem` é
                  // null, e o `AddUI` lança
                  // NullReferenceException: o jogador CAI do
                  // servidor.
                  //
                  // Omitir o campo faz o cliente pular o bloco
                  // inteiro (`obj.ContainsKey("skinid")`) e ficar
                  // com `itemdef.iconSprite`, que é o ícone que se
                  // quer.
                  ...(skinIdOf(source.skinId) === 0 ? {} : { skinid: skinIdOf(source.skinId) }),
                };

      output.push({
        name,
        parent: parentName,
        components: [
          { ...base, color: cuiColor(element.color), ...fade } as CuiComponent,
          rectTransform(element),
        ],
      });
      break;
    }
  }

  // Filhos DEPOIS do pai: o cliente monta na ordem da lista, e um
  // filho que chega antes não encontra onde se pendurar — ele
  // simplesmente não aparece.
  for (const child of element.children) {
    emitElement(child, name, fadeIn, output);
  }
}

function rootElement(document: UiDocument): CuiElement {
  const components: CuiComponent[] = [
    {
      type: 'UnityEngine.UI.Image',
      // Transparente: a raiz é só o ponto de pendura. Qualquer cor
      // aqui pintaria a tela inteira do jogador.
      color: '0 0 0 0',
      ...(document.fadeIn > 0 ? { fadeIn: document.fadeIn } : {}),
    },
    {
      type: 'RectTransform',
      anchormin: '0 0',
      anchormax: '1 1',
      offsetmin: '0 0',
      offsetmax: '0 0',
    },
  ];

  if (document.cursor) {
    components.push({ type: 'NeedsCursor' });
  }

  return {
    name: ROOT_NAME,
    parent: document.layer,
    components,
    // Destrói a versão anterior antes de desenhar. Sem isto, abrir
    // o menu duas vezes empilharia duas interfaces, e a de baixo
    // ficaria para sempre.
    destroyUi: ROOT_NAME,
  };
}

/**
 * O documento usa shell, ou cada tela desenha tudo?
 *
 * Shell sem slot de conteúdo não é shell: as telas não teriam onde
 * ser penduradas e apareceriam na raiz, por cima da moldura. As
 * duas condições andam juntas em toda decisão daqui.
 */
export function documentUsesShell(document: UiDocument): boolean {
  return document.shell.length > 0 && document.contentSlotId !== null;
}

/**
 * O SHELL: o que é desenhado UMA vez, na abertura.
 *
 * ####  É O QUE TIRA O PISCAR  ####
 *
 * Sem ele, navegar destrói e recria a interface inteira, e o
 * jogador vê o menu fechar e reabrir a cada clique. Com ele, o
 * cabeçalho e a moldura ficam, e trocar de tela mexe só no
 * conteúdo.
 *
 * Documento sem shell devolve só a raiz — e aí cada tela desenha
 * tudo, que é como um menu simples funciona.
 */
export function shellToCui(document: UiDocument): readonly CuiElement[] {
  const output: CuiElement[] = [rootElement(document)];

  for (const element of document.shell) {
    emitElement(element, ROOT_NAME, document.fadeIn, output);
  }

  return output;
}

/**
 * O CONTEÚDO de uma tela, pendurado no slot do shell.
 *
 * O `parent` é o slot, e não a raiz: é assim que o conteúdo entra
 * dentro da moldura que já está na tela.
 *
 * Modal vai no slot DELE, e não no de conteúdo — é o que faz a
 * página continuar embaixo, intacta.
 */
export function screenContentToCui(
  document: UiDocument,
  screen: UiScreen,
  /**
   * Sobrepõe o fade do documento.
   *
   * O fade existe para a interface ENTRAR na tela. Numa tela que o
   * agente remonta a cada clique, ele re-anima tudo do zero: o que
   * o jogador vê é a caixa sumindo e voltando a cada toque. Passar
   * 0 é o que faz uma atualização parecer atualização.
   */
  fadeIn: number = document.fadeIn,
): readonly CuiElement[] {
  const output: CuiElement[] = [];

  const slot = screen.kind === 'modal' ? document.modalSlotId : document.contentSlotId;
  const parentName = slot === null ? ROOT_NAME : `${ROOT_NAME}.${slot}`;

  for (const element of screen.elements) {
    emitElement(element, parentName, fadeIn, output);
  }

  return output;
}

/**
 * Uma tela INTEIRA — raiz, shell e conteúdo.
 *
 * É o caminho do documento sem shell, e o que o `preview` do
 * editor usa para mostrar a tela completa.
 */
export function screenToCui(document: UiDocument, screen: UiScreen): readonly CuiElement[] {
  const output: CuiElement[] = [rootElement(document)];

  // O shell primeiro: no CUI a ordem da lista é a profundidade, e o
  // conteúdo precisa vir por cima da moldura.
  for (const element of document.shell) {
    emitElement(element, ROOT_NAME, document.fadeIn, output);
  }

  const slot = screen.kind === 'modal' ? document.modalSlotId : document.contentSlotId;
  const parentName = slot === null ? ROOT_NAME : `${ROOT_NAME}.${slot}`;

  for (const element of screen.elements) {
    emitElement(element, parentName, document.fadeIn, output);
  }

  return output;
}

/**
 * As ATUALIZAÇÕES de estado do shell ao entrar numa tela.
 *
 * ####  POR QUE ATUALIZAR EM VEZ DE RECRIAR  ####
 *
 * O botão ativo da navegação precisa mudar de cor, mas o shell NÃO
 * é redesenhado — esse é o ponto dele. O CUI resolve isso com
 * `update: true`: um elemento com o mesmo nome ATUALIZA os
 * componentes no lugar, sem destruir e recriar.
 *
 * Recriar o botão funcionaria e faria ele piscar, que é exatamente
 * o defeito que o shell existe para corrigir.
 *
 * Documento sem shell devolve lista vazia: não há o que atualizar
 * quando tudo é redesenhado de qualquer jeito.
 */
export function screenUpdatesToCui(
  document: UiDocument,
  screen: UiScreen,
  /** Qual tela conta como "você está aqui". */
  activeScreenId: string = screen.id,
): readonly CuiElement[] {
  const output: CuiElement[] = [];

  const visit = (elements: readonly UiElement[]): void => {
    for (const element of elements) {
      if (element.type === 'button' && element.activeColor !== null) {
        const isActive = element.activeOnScreenId === activeScreenId;

        output.push({
          name: `${ROOT_NAME}.${element.id}`,
          parent: ROOT_NAME,
          update: true,
          components: [
            {
              type: 'UnityEngine.UI.Button',
              command: actionCommand(element.action.id),
              color: cuiColor(isActive ? element.activeColor : element.color),
            },
          ],
        });

        // O texto do botão é um elemento SEPARADO (ver
        // `emitElement`), então a cor dele se atualiza à parte.
        output.push({
          name: `${ROOT_NAME}.${element.id}.text`,
          parent: `${ROOT_NAME}.${element.id}`,
          update: true,
          components: [
            {
              type: 'UnityEngine.UI.Text',
              text: element.text,
              fontSize: element.fontSize,
              font: element.font,
              align: element.align,
              color: cuiColor(
                isActive && element.activeTextColor !== null
                  ? element.activeTextColor
                  : element.textColor,
              ),
            },
          ],
        });
      }

      visit(element.children);
    }
  };

  visit(document.shell);

  return output;
}

// ------------------------------------------------------------
//  AS AÇÕES DA TELA
//
//  ####  É COM ISTO QUE O PLUGIN VALIDA O CLIQUE  ####
//
//  O CUI que vai ao cliente não diz o que cada ação FAZ — ele
//  carrega só o id. O plugin precisa da tabela para responder a
//  "esta tela contém esse actionId, e o que ele significa?", que é
//  a pergunta de segurança do `origemz.ui.act`.
//
//  Ela é pequena (uma entrada por botão) e vai junto com a tela.
// ------------------------------------------------------------

export type UiActionEntry =
  | { readonly kind: 'navigate'; readonly screenId: string }
  | { readonly kind: 'close' }
  | { readonly kind: 'chat'; readonly command: string }
  | { readonly kind: 'console'; readonly command: string }
  | { readonly kind: 'modal.open'; readonly screenId: string }
  | { readonly kind: 'modal.close' }
  | { readonly kind: 'store.buy'; readonly offerId: string; readonly quantity: number };

export function collectScreenActions(
  screen: UiScreen,
  shell: readonly UiElement[] = [],
): Record<string, UiActionEntry> {
  const actions: Record<string, UiActionEntry> = {};

  const visit = (elements: readonly UiElement[]): void => {
    for (const element of elements) {
      if (element.type === 'button') {
        const action = element.action;

        switch (action.kind) {
          case 'navigate':
            actions[action.id] = { kind: 'navigate', screenId: action.screenId };
            break;
          case 'close':
            actions[action.id] = { kind: 'close' };
            break;
          case 'chat':
            actions[action.id] = { kind: 'chat', command: action.command };
            break;
          case 'console':
            actions[action.id] = { kind: 'console', command: action.command };
            break;
          case 'modal.open':
            actions[action.id] = { kind: 'modal.open', screenId: action.screenId };
            break;
          case 'modal.close':
            actions[action.id] = { kind: 'modal.close' };
            break;
          case 'store.buy':
            actions[action.id] = {
              kind: 'store.buy',
              offerId: action.offerId,
              quantity: action.quantity,
            };
            break;
        }
      }

      visit(element.children);
    }
  };

  // O SHELL entra junto: os botões de navegação vivem lá, e sem
  // eles a validação do clique recusaria justamente a ação mais
  // comum do menu.
  visit(shell);
  visit(screen.elements);

  return actions;
}
