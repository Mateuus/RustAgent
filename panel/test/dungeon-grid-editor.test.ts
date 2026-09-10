// ============================================================
//  O editor não pode comer o desenho.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO TRANCA  ####
//
//  MEDIDO em 09/09/2026, apontado pelo dono: escolher o traçado
//  "Labirinto" no passo do desenho mostrava 84 das 241 células —
//  o resto sumia, e o rodapé acusava "50 células de corredor não
//  chegam na entrada".
//
//  A causa eram duas constantes: a tela de 24×24 e a entrada
//  cravada no centro dela. Carregar alinhava o desenho pela
//  entrada, e um desenho com a entrada no canto se estende para um
//  lado só — para fora da tela. O que não coubesse era descartado
//  em silêncio.
//
//  E descartado só na TELA: o rascunho guardava o desenho inteiro,
//  então salvar sem tocar em nada gravava um desenho e salvar
//  depois de encostar no grid gravava outro.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §6.
// ============================================================

import { describe, expect, it } from 'vitest';

import { boardFromRows, rowsOfBoard } from '@/components/dungeons/dungeon-grid-editor';

/** Quantas células o desenho tem de fato. */
function cellsOf(rows: readonly string[]): number {
  return rows.reduce(
    (total, row) => total + [...row].filter((char) => char !== '.' && char !== ' ').length,
    0,
  );
}

/**
 * O labirinto que o dono abriu, copiado do banco.
 *
 * 23×23, 241 células, e a entrada no CANTO — que é a forma que o
 * gerador produz e a que quebrava o editor.
 */
const LABIRINTO: readonly string[] = [
  '.......................',
  '.E##.R.######R.#######.',
  '...#.#.#...#...#.....#.',
  '.###.#.###.#####.R.###.',
  '.#...#...#.....#.#.#...',
  '.###.#.###.###.###.###.',
  '...#.#.#...#.#.......#.',
  '.B.#.#####.#.#####.###.',
  '.#.#.....#.#.....#.#.#.',
  '.#.###.R##.#####.###.#.',
  '.#...#.......#.#.....#.',
  '.###.#######.#.#####.B.',
  '...#.......#.#.....#...',
  '.#####.#####.####G.###.',
  '.#...#.#...........#.#.',
  '.#.B##.###.#######.G.#.',
  '.#.......#.#.....#...#.',
  '.#.####G.###.##G.#####.',
  '.#.#.#.......#.......#.',
  '.###.###.###.###.###.#.',
  '.#.....#.#.#.#.#.#.#.#.',
  '.####B.###.###.###.###.',
  '.......................',
];

describe('o desenho que chega é o desenho que fica', () => {
  it('não perde nenhuma célula do labirinto', () => {
    const board = boardFromRows(LABIRINTO);

    // 241 é a contagem do traçado original. Antes do conserto,
    // sobravam 84.
    expect(cellsOf(rowsOfBoard(board))).toBe(cellsOf(LABIRINTO));
    expect(cellsOf(LABIRINTO)).toBe(241);
  });

  it('a tela cresce até caber o desenho', () => {
    expect(boardFromRows(LABIRINTO).size).toBeGreaterThanOrEqual(23);
  });

  it('a entrada acompanha o desenho em vez de puxá-lo para o centro', () => {
    const board = boardFromRows(LABIRINTO);
    const cell = board.cells[board.entrance.z]?.[board.entrance.x];

    // A entrada do labirinto é o canto superior esquerdo, e não o
    // meio da tela: se ela fosse o centro, o desenho teria sido
    // deslocado para fora.
    expect(cell).toBe('corridor');
    expect(board.entrance).not.toEqual({
      x: Math.floor(board.size / 2),
      z: Math.floor(board.size / 2),
    });
  });

  it('ida e volta não muda o desenho', () => {
    const once = rowsOfBoard(boardFromRows(LABIRINTO));
    const twice = rowsOfBoard(boardFromRows(once));

    // A segunda passagem tem de ser idêntica à primeira: é o que
    // garante que abrir, salvar e reabrir não vai encolhendo o
    // desenho a cada volta.
    expect(twice).toEqual(once);

    // A moldura de vazio SAI, e isso é a regra do formato: só o
    // retângulo que contém algo é salvo. O labirinto vem com uma
    // borda de '.' em volta, então ele encolhe de 23×23 para
    // 21×21 — sem perder uma célula, que é o que o primeiro teste
    // deste arquivo cobra.
    expect(once.length).toBe(21);
    expect(once[0]?.length).toBe(21);
  });
});

describe('a tela em branco', () => {
  it('nasce com a entrada e um passo de corredor ao norte', () => {
    const rows = rowsOfBoard(boardFromRows(null));

    // As linhas vão do maior z para o menor — o norte em cima —,
    // e o corredor nasce um passo ao norte da entrada.
    expect(rows.join('\n')).toBe('#\nE');
  });
});

describe('desenhos pequenos continuam como eram', () => {
  it('o corredor reto de fábrica sobrevive à ida e volta', () => {
    const corredor = ['..RR..', '..RR..', 'GG##BB', 'GG##BB', '..##..', '..E#..'];

    expect(rowsOfBoard(boardFromRows(corredor))).toEqual(corredor);
  });

  it('um desenho sem entrada ganha uma no centro, e não some', () => {
    const semEntrada = ['###', '#G#', '###'];
    const board = boardFromRows(semEntrada);
    const rows = rowsOfBoard(board);

    // Nada se perde: 9 células entram, 9 saem — uma delas virou o
    // 'E', que é a chegada do alçapão.
    expect(cellsOf(rows)).toBe(9);
    expect(rows.join('')).toContain('E');
  });
});
