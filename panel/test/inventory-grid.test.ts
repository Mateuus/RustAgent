// ============================================================
//  Testes da grade que decide ONDE cada item do kit nasce.
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  A grade faz uma promessa: "este item nasce NESTA casinha". Uma
//  promessa dessas só vale se duas coisas forem verdade:
//
//    1. o que a tela desenha é o que o cadastro guarda — mover na
//       grade tem de produzir o mesmo `slot`/`position` que alguém
//       digitaria à mão;
//    2. e o que a tela NÃO desenha é dito em voz alta. Um item sem
//       casinha própria continua sendo entregue; escondê-lo daria
//       um kit que entrega mais do que a tela mostra.
//
//  As capacidades (24/7/6) são as do jogo, e estão repetidas em
//  `core/src/game/ui-inventory.ts` — dois processos, nenhum
//  importando do outro. Cada lado as afirma no seu teste; é isso
//  que impede uma de andar sem a outra.
// ============================================================

import { describe, expect, it } from 'vitest';

import { CONTAINERS, layoutOf, swapInto } from '../src/components/inventory-grid';
import type { LoadoutItem, LoadoutSlot } from '../src/lib/api';

function item(over: Partial<LoadoutItem> = {}): LoadoutItem {
  return { slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0, ...over };
}

describe('as capacidades dos contêineres', () => {
  it('são as do jogo, e não números escolhidos aqui', () => {
    const shape = Object.fromEntries(
      CONTAINERS.map((container) => [container.slot, container.capacity]),
    );

    // containerMain, containerWear e containerBelt do BasePlayer.
    // Oferecer uma casinha a mais faria a tela prometer um lugar que
    // o MoveToContainer recusa.
    expect(shape).toEqual({ main: 24, wear: 7, belt: 6 });
  });
});

describe('arrastar um item para outra casinha', () => {
  it('leva o slot e a posição junto', () => {
    const items = [item({ slot: 'belt', position: 0 })];

    expect(swapInto(items, 0, 'main', 5)[0]).toMatchObject({ slot: 'main', position: 5 });
  });

  it('troca com quem já estava lá, em vez de empilhar por cima', () => {
    const items = [
      item({ shortname: 'rifle.ak', slot: 'belt', position: 0 }),
      item({ shortname: 'pickaxe', slot: 'belt', position: 3 }),
    ];

    const depois = swapInto(items, 0, 'belt', 3);

    expect(depois[0]).toMatchObject({ shortname: 'rifle.ak', slot: 'belt', position: 3 });
    // O antigo dono herda o lugar de onde o outro saiu. Sem isso os
    // dois ficariam na casinha 3 e a tela mostraria um só.
    expect(depois[1]).toMatchObject({ shortname: 'pickaxe', slot: 'belt', position: 0 });
  });

  it('troca entre contêineres diferentes também', () => {
    const items = [
      item({ shortname: 'rifle.ak', slot: 'belt', position: 1 }),
      item({ shortname: 'hoodie', slot: 'wear', position: 2 }),
    ];

    const depois = swapInto(items, 0, 'wear', 2);

    expect(depois[0]).toMatchObject({ slot: 'wear', position: 2 });
    expect(depois[1]).toMatchObject({ slot: 'belt', position: 1 });
  });

  it('não mexe em quem ninguém tocou', () => {
    const items = [
      item({ shortname: 'a', position: 0 }),
      item({ shortname: 'b', position: 1 }),
      item({ shortname: 'c', position: 2 }),
    ];

    const depois = swapInto(items, 0, 'belt', 4);

    expect(depois[1]).toEqual(items[1]);
    expect(depois[2]).toEqual(items[2]);
  });

  it('um índice que não existe devolve a lista intacta', () => {
    // Acontece quando alguém apaga uma linha com o arrasto em
    // andamento. Devolver a lista de volta é melhor que criar um
    // item do nada.
    const items = [item()];

    expect(swapInto(items, 9, 'main', 0)).toEqual(items);
  });
});

describe('o que a grade desenha', () => {
  it('põe cada item na casinha que ele pediu', () => {
    const items = [item({ slot: 'belt', position: 4 })];
    const { drawn, stray } = layoutOf(items, 'belt', 6);

    expect(drawn.get(4)?.index).toBe(0);
    expect(drawn.has(0)).toBe(false);
    expect(stray).toHaveLength(0);
  });

  it('ignora o que é de outro contêiner', () => {
    const items = [item({ slot: 'main', position: 0 })];
    const { drawn, stray } = layoutOf(items, 'belt', 6);

    expect(drawn.size).toBe(0);
    expect(stray).toHaveLength(0);
  });

  // ####  OS DOIS CASOS QUE A TELA NÃO PODE ENGOLIR  ####

  it('conta quem pediu uma casinha que não existe', () => {
    // "Posição 9" numa barra rápida de seis. O campo aceitava
    // qualquer inteiro, e kits antigos têm isso gravado.
    const items = [item({ slot: 'belt', position: 9 })];
    const { drawn, stray } = layoutOf(items, 'belt', 6);

    expect(drawn.size).toBe(0);
    expect(stray.map((entry) => entry.index)).toEqual([0]);
  });

  it('conta o segundo item que pediu a mesma casinha', () => {
    const items = [
      item({ shortname: 'primeiro', slot: 'belt', position: 2 }),
      item({ shortname: 'segundo', slot: 'belt', position: 2 }),
    ];

    const { drawn, stray } = layoutOf(items, 'belt', 6);

    expect(drawn.get(2)?.item.shortname).toBe('primeiro');
    // Desenhar os dois na casinha 2 mostraria um só — e o segundo
    // continua sendo entregue.
    expect(stray.map((entry) => entry.item.shortname)).toEqual(['segundo']);
  });

  it('conta a posição negativa, que quer dizer "onde couber"', () => {
    const items = [item({ slot: 'belt', position: -1 })];

    expect(layoutOf(items, 'belt', 6).stray).toHaveLength(1);
  });

  it('nenhum item do contêiner escapa da conta', () => {
    const slots: readonly LoadoutSlot[] = ['belt', 'main', 'wear'];
    const items = [
      item({ slot: 'belt', position: 0 }),
      item({ slot: 'belt', position: 0 }),
      item({ slot: 'belt', position: 99 }),
      item({ slot: 'main', position: 0 }),
    ];

    for (const slot of slots) {
      const capacity = CONTAINERS.find((container) => container.slot === slot)?.capacity ?? 0;
      const { drawn, stray } = layoutOf(items, slot, capacity);
      const total = items.filter((candidate) => candidate.slot === slot).length;

      // Desenhado + contado = todos. É esta soma que garante que
      // nenhum item some da tela em silêncio.
      expect(drawn.size + stray.length).toBe(total);
    }
  });
});
