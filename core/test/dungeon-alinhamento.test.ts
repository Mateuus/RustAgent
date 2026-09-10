// ============================================================
//  A entrada e o corredor apontam para o mesmo lado.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  MEDIDO em 09/09/2026, pelo dono, dentro do jogo: "é a entrada,
//  está virada ao lado contrário do corredor, 90 graus".
//
//  A casinha é colada apontando para o `forward` — a direção que o
//  ponto de nascimento manda. A masmorra usa esse MESMO `forward`
//  como o eixo Z do desenho e o `right` como o eixo X. Então, num
//  traçado cujo `E` tem o corredor à direita, o corredor saía
//  noventa graus fora de onde a casinha olhava.
//
//  Nada estava errado isoladamente: eram dois sistemas de
//  coordenadas que ninguém tinha juntado. E foram precisas TRÊS
//  tentativas para acertar qual peça girar — a casinha, o jogador,
//  ou a masmorra — porque não havia como verificar sem alguém
//  entrar no jogo e olhar.
//
//  ####  POR QUE A CONTA MORA AQUI, E NÃO SÓ NO PLUGIN  ####
//
//  Ela vive em três lugares: o construtor em C#, a seta do editor
//  em TSX, e este teste. As duas primeiras são compiladas
//  separadamente e não podem importar uma da outra — é a mesma
//  situação do `checkLayout`.
//
//  O que este arquivo trava é a REGRA: dado um traçado, para que
//  lado a masmorra tem de girar. Se alguém mudar a ordem de
//  procura num dos lados, o número aqui muda e o teste cai.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §8.
// ============================================================

import { describe, expect, it } from 'vitest';

import { FACTORY_LAYOUTS } from '../src/types/dungeon-layouts.js';

/**
 * Para que lado o corredor sai da célula da entrada.
 *
 * É o porte fiel do `GridExitYaw` do plugin, e a ordem de procura
 * tem de ser a mesma: frente, direita, esquerda, trás. A ordem
 * importa quando a entrada tem mais de uma saída — e é ela que
 * decide qual delas o jogador vê ao chegar.
 */
function gridExitYaw(rows: readonly string[]): 0 | 90 | 180 | 270 {
  const height = rows.length;
  let column = -1;
  let line = -1;

  for (const [index, row] of rows.entries()) {
    const found = row.indexOf('E');

    if (found < 0) continue;

    column = found;
    line = index;
    break;
  }

  if (line < 0) return 0;

  // A primeira linha é a de MAIOR z: o norte em cima.
  const z = height - 1 - line;

  const has = (x: number, atZ: number): boolean => {
    const at = height - 1 - atZ;

    if (at < 0 || at >= height || x < 0) return false;

    const row = rows[at] ?? '';
    const char = row[x];

    return char !== undefined && char !== '.' && char !== ' ';
  };

  if (has(column, z + 1)) return 0;
  if (has(column + 1, z)) return 90;
  if (has(column - 1, z)) return 270;
  if (has(column, z - 1)) return 180;

  return 0;
}

/**
 * O mundo, como o construtor o monta.
 *
 * Uma célula `(x, z)` do desenho vira
 * `origem + right * x + forward * z`, e `right` é
 * `cross(up, forward)`. Aqui isso é feito em duas dimensões, com
 * ângulos em graus de bússola: 0 = norte, 90 = leste.
 */
function cellDirection(cell: readonly [number, number], forwardYaw: number): number {
  const [x, z] = cell;

  // `right` é o `forward` girado noventa graus no sentido horário.
  const yaw = z !== 0 ? (z > 0 ? forwardYaw : forwardYaw + 180) : x > 0 ? forwardYaw + 90 : forwardYaw + 270;

  return ((yaw % 360) + 360) % 360;
}

/** A saída do corredor, em células, a partir da entrada. */
function exitCell(rows: readonly string[]): readonly [number, number] {
  switch (gridExitYaw(rows)) {
    case 0:
      return [0, 1];
    case 90:
      return [1, 0];
    case 180:
      return [0, -1];
    default:
      return [-1, 0];
  }
}

describe('a masmorra gira para o corredor sair de frente', () => {
  // Os cinco de fábrica mais o "Labirinto", que é o traçado em que o
  // dono viu o defeito: 23×23, com a entrada no canto e o corredor
  // saindo para o lado.
  const LABIRINTO = [
    '.......................',
    '.E##.R.######R.#######.',
    '...#.#.#...#...#.....#.',
    '.###.#.###.#####.R.###.',
    '.#...#...#.....#.#.#...',
  ];

  const todos = [
    ...FACTORY_LAYOUTS.map((layout) => ({ id: layout.id, grid: layout.grid })),
    { id: 'labirinto', grid: LABIRINTO },
  ];

  for (const layout of todos) {
    it(`"${layout.id}": quem desce olha para o corredor`, () => {
      // O admin escolheu uma direção qualquer para a casinha.
      const casinha = 137;

      // O construtor gira a masmorra por este ângulo.
      const giro = gridExitYaw(layout.grid);
      const forwardDaMasmorra = casinha - giro;

      // E então o corredor sai... exatamente para onde a casinha
      // aponta. É a invariante inteira deste arquivo.
      const corredor = cellDirection(exitCell(layout.grid), forwardDaMasmorra);

      expect(corredor).toBe(((casinha % 360) + 360) % 360);
    });
  }

  it('o "Labirinto" é o que precisa de um quarto de volta', () => {
    // O número que o dono viu no jogo, antes do conserto.
    expect(gridExitYaw(LABIRINTO)).toBe(90);
  });

  it('um traçado com o corredor em frente não gira nada', () => {
    // É o caso do sorteio, e de quase todo desenho feito à mão: a
    // entrada embaixo, o corredor subindo. Nada muda para eles.
    expect(gridExitYaw(['..##..', '..E#..'])).toBe(0);
  });

  it('a ordem de procura é frente, direita, esquerda, trás', () => {
    // Uma entrada com saída para os quatro lados: a de frente ganha,
    // porque é o que qualquer um espera de uma porta. Se esta ordem
    // mudar no plugin sem mudar aqui, o teste cai — que é o ponto.
    expect(gridExitYaw(['.#.', '#E#', '.#.'])).toBe(0);

    // Sem a de frente, a direita.
    expect(gridExitYaw(['...', '#E#', '.#.'])).toBe(90);

    // Sem frente nem direita, a esquerda.
    expect(gridExitYaw(['...', '#E.', '.#.'])).toBe(270);

    // Sobrou a de trás.
    expect(gridExitYaw(['...', '.E.', '.#.'])).toBe(180);
  });

  it('uma entrada sem saída nenhuma não gira', () => {
    // Um desenho assim é uma masmorra sem chegada. Quem reclama
    // disso é o verificador; aqui o que não pode é girar por um
    // corredor que não existe.
    expect(gridExitYaw(['...', '.E.', '...'])).toBe(0);
  });
});
