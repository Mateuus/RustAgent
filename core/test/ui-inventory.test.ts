// ============================================================
//  ui-inventory.test.ts  -  a grade que desenha um kit como o
//  inventário do jogo.
//
//  ####  O QUE PRECISA SER MEDIDO AQUI  ####
//
//  A grade faz uma promessa forte: "o item nasce NESTA casinha".
//  Uma promessa dessas só vale se o desenho concordar com o jogo —
//  e o jogo tem 24 casinhas na mochila, 7 na vestimenta e 6 na
//  barra rápida, número nenhum negociável.
//
//  Então o que se mede é a honestidade do desenho:
//
//    1. o item pedido aparece na casinha pedida;
//    2. o contêiner não cresce porque o kit pediu mais;
//    3. o que não coube é CONTADO, nunca engolido;
//    4. duas posições iguais não viram um item sobre o outro.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_LABEL,
  INVENTORY_SHAPE,
  inventoryBlocks,
  inventoryHeight,
  type InventoryEntry,
} from '../src/game/ui-inventory.js';
import type { UiElement } from '../src/types/ui-document.js';

function entry(over: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    container: 'belt',
    position: 0,
    itemId: 1545779598,
    skinId: '0',
    amount: 1,
    name: 'Assault Rifle',
    ...over,
  };
}

/** Todos os elementos, achatados. */
function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function idsOf(elements: readonly UiElement[]): string[] {
  return walk(elements).map((element) => element.id);
}

/** Uma área folgada, para quem não está medindo altura. */
const ROOMY = { prefix: 'g', width: 480, height: 600 } as const;

describe('a grade de inventário', () => {
  it('põe o item na casinha que o kit pediu', () => {
    const blocks = inventoryBlocks([entry({ container: 'belt', position: 3 })], ROOMY);
    const ids = idsOf(blocks.elements);

    // A casinha 3 tem o ícone dentro; as outras cinco estão lá e
    // vazias — é isso que faz a fileira se ler como barra rápida.
    expect(ids).toContain('gbeltc3i');
    expect(ids).not.toContain('gbeltc0i');
    expect(ids).toContain('gbeltc0');
    expect(ids).toContain('gbeltc5');
  });

  it('desenha só os contêineres que têm item', () => {
    const blocks = inventoryBlocks([entry({ container: 'belt' })], ROOMY);
    const texts = walk(blocks.elements)
      .filter((element) => element.type === 'label')
      .map((element) => element.text);

    expect(texts).toContain(CONTAINER_LABEL.belt);
    // Uma grade vazia rotulada "VESTIMENTA" só ocupa altura para
    // dizer "nada aqui".
    expect(texts).not.toContain(CONTAINER_LABEL.wear);
    expect(texts).not.toContain(CONTAINER_LABEL.main);
  });

  it('não inventa casinha que o jogo não tem', () => {
    // Treze itens numa barra rápida de seis.
    const many = Array.from({ length: 13 }, (_unused, index) =>
      entry({ container: 'belt', position: index }),
    );

    const blocks = inventoryBlocks(many, ROOMY);
    const ids = idsOf(blocks.elements);

    expect(ids).toContain('gbeltc5');
    expect(ids).not.toContain('gbeltc6');

    // ####  E O QUE SOBROU É CONTADO  ####
    //
    // Seis desenhados, sete fora. Sem esta conta o jogador leva um
    // kit achando que ele tem menos do que tem — e a tela teria
    // mentido com aparência de certeza.
    expect(blocks.hidden).toBe(13 - INVENTORY_SHAPE.belt.capacity);
  });

  it('não empilha dois itens na mesma casinha', () => {
    const blocks = inventoryBlocks(
      [
        entry({ container: 'belt', position: 2, name: 'primeiro' }),
        entry({ container: 'belt', position: 2, name: 'segundo' }),
      ],
      ROOMY,
    );

    const ids = idsOf(blocks.elements);

    // O segundo cai na primeira casinha livre, e não por cima do
    // primeiro: desenhados um sobre o outro, o de baixo sumiria.
    expect(ids).toContain('gbeltc2i');
    expect(ids).toContain('gbeltc0i');
    expect(blocks.hidden).toBe(0);
  });

  it('conta o que não coube na altura, em vez de cortar calado', () => {
    const blocks = inventoryBlocks(
      [entry({ container: 'main' }), entry({ container: 'belt' }), entry({ container: 'wear' })],
      // Altura para um bloco só.
      { prefix: 'g', width: 480, height: 70 },
    );

    expect(blocks.hidden).toBe(2);
  });

  it('quebra a fileira quando a largura não comporta as colunas do jogo', () => {
    // 120 px cabem duas casinhas de 44 com o vão. As seis da barra
    // rápida viram três fileiras de dois — espremer a casinha até
    // caber faria o ícone virar um borrão.
    const many = Array.from({ length: 6 }, (_unused, index) =>
      entry({ container: 'belt', position: index }),
    );

    const blocks = inventoryBlocks(many, { prefix: 'g', width: 120, height: 600 });

    expect(blocks.hidden).toBe(0);
    expect(idsOf(blocks.elements)).toContain('gbeltc5');
  });

  it('a altura anunciada é a que o desenho usa', () => {
    // Quem monta um modal decide o tamanho da caixa ANTES de
    // desenhar. Se as duas contas divergirem, a lista volta a
    // atravessar o rodapé — que é o defeito que originou tudo isto.
    const entries = [
      entry({ container: 'main', position: 0 }),
      entry({ container: 'main', position: 8 }),
      entry({ container: 'belt', position: 1 }),
    ];

    const blocks = inventoryBlocks(entries, ROOMY);

    expect(inventoryHeight(entries, ROOMY.width)).toBe(blocks.height);
    expect(blocks.height).toBeLessThanOrEqual(ROOMY.height);
  });

  it('sem itemId, a casinha mostra o nome em vez de fingir um ícone', () => {
    const blocks = inventoryBlocks([entry({ itemId: null, name: 'desconhecido' })], ROOMY);
    const ids = idsOf(blocks.elements);

    expect(ids).toContain('gbeltc0u');
    expect(ids).not.toContain('gbeltc0i');
  });

  it('a casinha só clica quando há para onde ir', () => {
    const muda = inventoryBlocks([entry()], ROOMY);

    expect(idsOf(muda.elements)).not.toContain('gbeltc0b');

    const clicavel = inventoryBlocks([entry()], { ...ROOMY, screenIdOf: () => 'ozkit:x:item:0' });

    expect(idsOf(clicavel.elements)).toContain('gbeltc0b');
  });
});
