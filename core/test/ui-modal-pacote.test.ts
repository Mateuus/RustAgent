// ============================================================
//  ui-modal-pacote.test.ts  -  o modal de kit, VIP e veículo,
//  medido.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  O modal do preset tinha 340 px de altura. O slot da lista ia de
//  172 a 304 contados do topo — 36 px de folga até o fundo. E o
//  "TOTAL", como todo o rodapé, é ancorado no FUNDO: 78 px acima
//  dele.
//
//  78 é maior que 36. A lista e o TOTAL ocupavam o mesmo lugar.
//
//  No jogo isso se via como duas frases escritas uma sobre a outra
//  — "RECICLADORA MAIS RÁPIDA" atravessada pela palavra TOTAL — e
//  só a partir da QUARTA linha da lista. Um kit de três itens
//  desenhava certo, e foi por isso que ninguém viu antes: o bug
//  dependia do conteúdo, e o conteúdo é do admin.
//
//  Nenhum teste pegava isso porque nenhum media o desenho contra
//  ele mesmo. O documento estava válido, o schema aceitava, o
//  preset cabia no RCON. O que estava errado era a RELAÇÃO entre
//  dois números que ninguém obrigava a concordar.
//
//  É essa relação que se mede aqui.
// ============================================================

import { describe, expect, it } from 'vitest';

import { CANVAS, resolveRect, type Box } from '../src/game/ui-geometry.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import { LIST_LINE } from '../src/game/ui-widgets.js';
import { BUNDLE_TEMPLATE_ID, SLOTS } from '../src/game/ui-store-template.js';
import type { UiElement, UiScreen } from '../src/types/ui-document.js';

/**
 * A caixa de um elemento, medida na cadeia inteira.
 *
 * A âncora resolve dentro do PAI: medir o slot da lista sem passar
 * pelo véu e pela caixa do modal daria um número que não existe em
 * lugar nenhum.
 */
function boxOf(elements: readonly UiElement[], id: string, parent = CANVAS): Box | null {
  for (const element of elements) {
    const box = resolveRect(element.rect, parent);

    if (element.id === id) {
      return box;
    }

    const inside = boxOf(element.children, id, { width: box.width, height: box.height });

    if (inside !== null) {
      return inside;
    }
  }

  return null;
}

function requireBox(screen: UiScreen, id: string): Box {
  const box = boxOf(screen.elements, id);

  if (box === null) {
    throw new Error(`o elemento "${id}" sumiu do modal de pacote`);
  }

  return box;
}

/** O fundo de uma caixa, contado do topo da tela. */
function bottomOf(box: Box): number {
  return box.top + box.height;
}

describe('o modal de kit, VIP e veículo', () => {
  const menu = buildMainMenu();
  const modal = menu.screens.find((screen) => screen.id === BUNDLE_TEMPLATE_ID);

  it('existe no preset', () => {
    expect(modal).toBeDefined();
  });

  if (modal === undefined) {
    return;
  }

  const list = requireBox(modal, SLOTS.pacoteLista);

  // ####  A MEDIDA QUE FALTAVA  ####
  //
  // Cada peça do rodapé é ancorada no fundo, e a lista no topo. A
  // única pergunta que importa é se elas se cruzam.
  for (const [name, id] of [
    ['o rótulo TOTAL', 'mb-rotulo-total'],
    ['o valor total', SLOTS.pacoteTotal],
    ['o saldo', SLOTS.pacoteSaldo],
    ['o botão de cancelar', SLOTS.pacoteCancelar],
    ['o botão de comprar', SLOTS.pacoteComprar],
  ] as const) {
    it(`não deixa a lista invadir ${name}`, () => {
      const footer = requireBox(modal, id);

      expect(bottomOf(list)).toBeLessThanOrEqual(footer.top);
    });
  }

  it('não deixa o cabeçalho invadir a lista', () => {
    // O ícone é a peça mais baixa do cabeçalho: 80 px a partir de
    // 60 do topo. O título da lista já esteve por cima dele.
    const icon = requireBox(modal, SLOTS.pacoteIcone);
    const title = requireBox(modal, SLOTS.pacoteTitulo);

    expect(bottomOf(icon)).toBeLessThanOrEqual(title.top);
    expect(bottomOf(title)).toBeLessThanOrEqual(list.top);
  });

  it('mantém a lista dentro da caixa', () => {
    const box = requireBox(modal, 'mb-caixa');

    // Medidas na mesma origem: o slot resolve DENTRO da caixa, então
    // o que se compara é a altura dele com a dela.
    const inner = boxOf(modal.elements, SLOTS.pacoteLista);

    expect(inner).not.toBeNull();
    expect(box.height).toBeGreaterThan(list.height);
  });

  // ####  CABER NÃO BASTA: PRECISA CABER GENTE  ####
  //
  // Um slot de 24 px não cruza com nada e não serve para nada. O VIP
  // mais vendido da rede tem cinco vantagens, e o modal precisa
  // mostrá-las SEM paginar — paginar cinco linhas é pedir um clique
  // para ler meia frase.
  it('comporta pelo menos seis linhas sem paginar', () => {
    expect(Math.floor(list.height / LIST_LINE)).toBeGreaterThanOrEqual(6);
  });

  it('é largo o bastante para uma vantagem de VIP', () => {
    // "FORNALHA DIVIDE OS ITENS AUTOMÁTICO." é a mais longa em uso, e
    // ela cabia por poucos pixels na largura antiga.
    expect(list.width).toBeGreaterThanOrEqual(400);
  });
});
