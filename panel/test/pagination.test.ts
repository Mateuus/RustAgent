// ============================================================
//  Testes da lógica do paginador (components/ui/pagination.tsx).
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  A mesma conta serve a quatro telas (Skins, Posse, Registro e a
//  ficha do jogador). Um erro de um na faixa ou na janela de
//  números aparece nas quatro de uma vez — e a pilha de cursores,
//  se errar, faz a Posse pular ou repetir linha.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  advanceCursors,
  clampPage,
  describeRange,
  pageCount,
  pageRange,
  pageWindow,
  slicePage,
} from '@/components/ui/pagination';

const ninety = Array.from({ length: 90 }, (_, index) => index + 1);

describe('pageCount', () => {
  it('arredonda para cima', () => {
    expect(pageCount(90, 20)).toBe(5);
    expect(pageCount(100, 20)).toBe(5);
    expect(pageCount(101, 20)).toBe(6);
  });

  it('lista vazia ainda é uma página', () => {
    expect(pageCount(0, 20)).toBe(1);
  });

  it('tamanho inválido não divide por zero', () => {
    expect(pageCount(90, 0)).toBe(1);
  });
});

describe('clampPage', () => {
  it('traz de volta a página que ficou além do fim', () => {
    expect(clampPage(5, 30, 20)).toBe(2);
  });

  it('não aceita página zero, negativa ou NaN', () => {
    expect(clampPage(0, 90, 20)).toBe(1);
    expect(clampPage(-3, 90, 20)).toBe(1);
    expect(clampPage(Number.NaN, 90, 20)).toBe(1);
  });
});

describe('slicePage', () => {
  it('fatia a página pedida', () => {
    expect(slicePage(ninety, 2, 20)).toEqual(ninety.slice(20, 40));
  });

  it('a última página vem incompleta', () => {
    expect(slicePage(ninety, 5, 20)).toEqual([81, 82, 83, 84, 85, 86, 87, 88, 89, 90]);
  });

  it('página além do fim mostra a última, e não nada', () => {
    expect(slicePage(ninety, 9, 20)).toEqual(ninety.slice(80));
  });

  it('lista vazia devolve vazio', () => {
    expect(slicePage([], 1, 20)).toEqual([]);
  });
});

describe('pageRange e describeRange', () => {
  it('"mostrando 21–40 de 90"', () => {
    expect(pageRange({ page: 2, pageSize: 20, total: 90 })).toEqual({ start: 21, end: 40 });
    expect(describeRange({ page: 2, pageSize: 20, total: 90 })).toBe('mostrando 21–40 de 90');
  });

  it('a última página termina no total', () => {
    expect(describeRange({ page: 5, pageSize: 20, total: 90 })).toBe('mostrando 81–90 de 90');
  });

  it('separa o milhar como no resto do painel', () => {
    expect(describeRange({ page: 1, pageSize: 50, total: 1234 })).toBe('mostrando 1–50 de 1.234');
  });

  it('sem total (cursor), a faixa vem do que a página tem', () => {
    expect(describeRange({ page: 3, pageSize: 50, total: null, shown: 50 })).toBe(
      'mostrando 101–150',
    );
    expect(describeRange({ page: 3, pageSize: 50, total: null, shown: 7 })).toBe(
      'mostrando 101–107',
    );
  });

  it('nada para mostrar não vira "1–0"', () => {
    expect(pageRange({ page: 1, pageSize: 20, total: 0 })).toBeNull();
    expect(describeRange({ page: 1, pageSize: 20, total: 0 })).toBe('nada para mostrar');
    expect(describeRange({ page: 1, pageSize: 20, total: null, shown: 0 })).toBe(
      'nada para mostrar',
    );
  });
});

describe('pageWindow', () => {
  it('até 7 páginas, mostra todas', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('no começo, reticências só à direita', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
  });

  it('no meio, dos dois lados', () => {
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(5, 20)).toEqual([1, 'gap', 4, 5, 6, 'gap', 20]);
  });

  it('no fim, só à esquerda', () => {
    expect(pageWindow(17, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });

  it('nunca passa de 7 posições', () => {
    for (let page = 1; page <= 40; page += 1) {
      expect(pageWindow(page, 40).length).toBeLessThanOrEqual(7);
      expect(pageWindow(page, 40)).toContain(page);
    }
  });

  it('página fora da faixa é trazida para dentro', () => {
    expect(pageWindow(0, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 0)).toEqual([1]);
  });
});

describe('advanceCursors', () => {
  it('a primeira leitura guarda o cursor da página 2', () => {
    expect(advanceCursors([null], 1, 900)).toEqual({ cursors: [null, 900], kept: false });
  });

  it('a última página fecha a pilha', () => {
    expect(advanceCursors([null, 900, 800], 3, null)).toEqual({
      cursors: [null, 900, 800],
      kept: true,
    });
  });

  it('voltar sem nada mudar mantém as páginas já vistas', () => {
    expect(advanceCursors([null, 900, 800], 1, 900)).toEqual({
      cursors: [null, 900, 800],
      kept: true,
    });
  });

  it('se a página seguinte mudou de cursor, esquece o que vinha depois', () => {
    // Tiraram uma posse da página 1: ela agora termina numa linha mais velha.
    expect(advanceCursors([null, 900, 800], 1, 890)).toEqual({
      cursors: [null, 890],
      kept: false,
    });
  });

  it('a página que virou a última corta o resto', () => {
    expect(advanceCursors([null, 900, 800], 2, null)).toEqual({
      cursors: [null, 900],
      kept: false,
    });
  });
});
