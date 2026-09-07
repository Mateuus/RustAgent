// ============================================================
//  O que a aba RANKINGS calcula sozinha ao arrastar uma linha.
//
//  A tela é otimista: ela reordena ANTES de o agente responder, e
//  manda `PUT /rankings/metrics/order` com a lista inteira. Se a
//  conta de posição estiver errada, o defeito não aparece na
//  tela — aparece no recarregamento seguinte, quando a lista
//  volta numa ordem que ninguém pediu. É exatamente o tipo de
//  erro que um teste puro pega e o olho não.
//
//  Componente React não é montado aqui: o vitest do painel roda
//  em node puro, e simular um arrasto de mouse custaria mais do
//  que descobre.
// ============================================================

import { describe, expect, it } from 'vitest';

import { moveInOrder, sameOrder } from '@/components/ranking/reorder';

/** O catálogo, reduzido ao que a reordenação enxerga. */
const CATALOG = [
  { id: 'abates' },
  { id: 'mortes' },
  { id: 'minerio' },
  { id: 'trofeu-bleik' },
] as const;

const idsOf = (items: readonly { readonly id: string }[]): string[] =>
  items.map((item) => item.id);

describe('moveInOrder', () => {
  it('leva a linha para baixo e empurra as do caminho para cima', () => {
    expect(idsOf(moveInOrder(CATALOG, 0, 2))).toEqual([
      'mortes',
      'minerio',
      'abates',
      'trofeu-bleik',
    ]);
  });

  it('leva a linha para cima e empurra as do caminho para baixo', () => {
    expect(idsOf(moveInOrder(CATALOG, 3, 1))).toEqual([
      'abates',
      'trofeu-bleik',
      'mortes',
      'minerio',
    ]);
  });

  it('o vizinho de cima e o de baixo trocam de lugar, e só eles', () => {
    expect(idsOf(moveInOrder(CATALOG, 1, 0))).toEqual([
      'mortes',
      'abates',
      'minerio',
      'trofeu-bleik',
    ]);
  });

  it('não perde nem duplica ninguém, para qualquer par de posições', () => {
    for (let from = 0; from < CATALOG.length; from += 1) {
      for (let to = 0; to < CATALOG.length; to += 1) {
        const moved = moveInOrder(CATALOG, from, to);

        expect(idsOf(moved).sort()).toEqual(idsOf(CATALOG).sort());
        // A rota recusa a lista com id repetido; um `splice` errado
        // produziria exatamente isso.
        expect(new Set(idsOf(moved)).size).toBe(CATALOG.length);
      }
    }
  });

  it('leva a linha EXATAMENTE para a posição pedida', () => {
    for (let to = 0; to < CATALOG.length; to += 1) {
      expect(moveInOrder(CATALOG, 0, to)[to]?.id).toBe('abates');
    }
  });

  // ####  DEVOLVER O MESMO ARRAY NÃO É DETALHE  ####
  //
  // É como quem chama sabe que não há o que gravar. Uma cópia nova
  // a cada arrasto pediria uma gravação que não muda nada.
  it('devolve o mesmo array quando não há para onde mover', () => {
    expect(moveInOrder(CATALOG, 1, 1)).toBe(CATALOG);
    expect(moveInOrder(CATALOG, 0, -1)).toBe(CATALOG);
    expect(moveInOrder(CATALOG, 0, CATALOG.length)).toBe(CATALOG);
    expect(moveInOrder(CATALOG, -1, 0)).toBe(CATALOG);
    expect(moveInOrder(CATALOG, CATALOG.length, 0)).toBe(CATALOG);
  });

  it('uma lista de um item não tem para onde mover', () => {
    const single = [{ id: 'abates' }] as const;

    expect(moveInOrder(single, 0, 0)).toBe(single);
  });
});

describe('sameOrder', () => {
  it('a mesma sequência de ids é a mesma ordem, mesmo em arrays diferentes', () => {
    expect(sameOrder(CATALOG, [...CATALOG])).toBe(true);
  });

  it('duas linhas trocadas já é outra ordem', () => {
    expect(sameOrder(CATALOG, moveInOrder(CATALOG, 0, 1))).toBe(false);
  });

  it('tamanhos diferentes nunca são a mesma ordem', () => {
    expect(sameOrder(CATALOG, CATALOG.slice(0, 3))).toBe(false);
  });
});
