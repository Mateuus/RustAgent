// ============================================================
//  factory.ts  -  elementos e documentos NOVOS, já válidos.
//
//  ####  NADA NASCE PELA METADE  ####
//
//  Todo elemento criado aqui já passa no schema do agente: cor em
//  hex, fonte da lista, ação com id próprio. É o que permite ao
//  editor criar um botão em um clique sem abrir um formulário
//  antes — e o que impede um documento de ser recusado na
//  gravação por um campo que o editor esqueceu de preencher.
//
//  ####  O ID É SORTEADO, E O ALFABETO É RESTRITO  ####
//
//  Ele viaja num comando de console (`origemz.ui.act <token>
//  <actionId>`), que o Rust separa por ESPAÇO. Um id com espaço
//  deslocaria os argumentos e o plugin leria outra coisa.
// ============================================================

import { BLACK, TRANSPARENT, WHITE } from './color';
import { REFERENCE_HEIGHT, REFERENCE_WIDTH } from './geometry';
import {
  DEFAULT_FONT,
  type UiAction,
  type UiDocument,
  type UiElement,
  type UiElementType,
  type UiRect,
  type UiScreen,
} from './model';

/**
 * Um id curto e único o bastante.
 *
 * Oito caracteres de base36 dão ~2,8 trilhões de combinações; num
 * documento de algumas centenas de elementos, a chance de colisão
 * é desprezível — e a validação pega o que passar.
 *
 * Sorteado, e não sequencial: dois editores abertos na mesma tela
 * gerariam o mesmo `elemento-7`, e o segundo a salvar apagaria o
 * trabalho do primeiro sem ninguém ver.
 */
export function newId(prefix = 'e'): string {
  const random = Math.random().toString(36).slice(2, 10);

  return `${prefix}${random}`;
}

/** Um retângulo centralizado, com tamanho fixo em pixels. */
export function centeredRect(width: number, height: number): UiRect {
  return {
    anchorMin: { x: 0.5, y: 0.5 },
    anchorMax: { x: 0.5, y: 0.5 },
    offsetMin: { x: -width / 2, y: -height / 2 },
    offsetMax: { x: width / 2, y: height / 2 },
  };
}

/** O retângulo padrão de quem acabou de nascer: um bloco no meio. */
function defaultRect(): UiRect {
  return centeredRect(240, 80);
}

/**
 * Um elemento novo do tipo pedido.
 *
 * As cores são as do painel, e não branco puro: um elemento que
 * nasce invisível parece que não foi criado, e quem clicou em
 * "Adicionar" clica de novo.
 */
export function createElement(type: UiElementType, name?: string): UiElement {
  const id = newId();
  const rect = defaultRect();

  switch (type) {
    case 'panel':
      return {
        id,
        name: name ?? 'Painel',
        type: 'panel',
        rect,
        children: [],
        color: '#1B1B1BFF',
        sprite: null,
        imageType: 'Simple',
        material: null,
      };

    case 'label':
      return {
        id,
        name: name ?? 'Texto',
        type: 'label',
        rect,
        children: [],
        text: 'Texto',
        fontSize: 14,
        font: DEFAULT_FONT,
        color: '#E8E8E8FF',
        align: 'MiddleCenter',
      };

    case 'button':
      return {
        id,
        name: name ?? 'Botão',
        type: 'button',
        rect,
        children: [],
        color: '#262626FF',
        sprite: null,
        text: 'BOTÃO',
        fontSize: 12,
        font: DEFAULT_FONT,
        textColor: '#E8E8E8FF',
        align: 'MiddleCenter',
        // Nasce fechando a interface: é a única ação que funciona
        // sem depender de outra tela existir.
        action: { id: newId('a'), kind: 'close' },
        hoverColor: '#C43F2CFF',
        pressedColor: '#A83525FF',
        activeColor: null,
        activeTextColor: null,
        activeOnScreenId: null,
      };

    case 'image':
      return {
        id,
        name: name ?? 'Imagem',
        type: 'image',
        rect,
        children: [],
        // Um sprite do jogo que sempre existe: assim a imagem nasce
        // VISÍVEL, e quem a criou vê onde ela está antes de escolher
        // a fonte de verdade.
        source: { kind: 'sprite', sprite: 'assets/content/ui/ui.background.tile.psd' },
        color: WHITE,
      };
  }
}

/**
 * Uma ação nova do tipo pedido.
 *
 * O `id` é sempre novo: reaproveitar o da ação anterior faria dois
 * botões dividirem o mesmo endereço, e o plugin resolveria o
 * primeiro que achasse.
 */
export function createAction(kind: UiAction['kind'], screenId: string | null): UiAction {
  const id = newId('a');

  switch (kind) {
    case 'navigate':
      return { id, kind: 'navigate', screenId: screenId ?? '' };
    case 'modal.open':
      return { id, kind: 'modal.open', screenId: screenId ?? '' };
    case 'modal.close':
      return { id, kind: 'modal.close' };
    case 'chat':
      return { id, kind: 'chat', command: '/ajuda' };
    case 'console':
      return { id, kind: 'console', command: 'say olá' };
    case 'store.buy':
      return { id, kind: 'store.buy', offerId: '', quantity: 1 };
    case 'close':
      return { id, kind: 'close' };
  }
}

export function createScreen(name = 'Tela nova'): UiScreen {
  return { id: newId('tela-'), name, kind: 'page', elements: [] };
}

/**
 * Um documento em branco.
 *
 * Ele já vem com UMA tela, e ela é a de entrada: um documento sem
 * tela de entrada não abre no jogo, e o editor não deve conseguir
 * criar um estado que o agente recusa.
 *
 * Sem shell: quem quiser cabeçalho começa pelo Menu Principal, que
 * é o modelo. Um shell vazio inventado aqui só teria elementos que
 * ninguém pediu.
 */
export function createDocument(id: string, name: string, command: string): UiDocument {
  const screen = createScreen('Início');

  return {
    id,
    name,
    command,
    permission: null,
    layer: 'Overall',
    cursor: true,
    shell: [],
    contentSlotId: null,
    modalSlotId: null,
    entryScreenId: screen.id,
    fadeIn: 0.15,
    screens: [screen],
  };
}

/** O tamanho da tela do jogo, para quem precisa das medidas. */
export const GAME_SIZE = { width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT } as const;

/** As cores neutras, para o editor não importar dois arquivos. */
export { BLACK, TRANSPARENT, WHITE };
