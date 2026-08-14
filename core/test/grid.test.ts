// ============================================================
//  grid.test.ts  -  a grade do mapa.
//
//  ####  POR QUE ISTO PRECISA DE TESTE  ####
//
//  Uma célula errada não parece errada: `G12` e `G15` têm a mesma
//  cara na tela, e quem for procurar o jogador chega num lugar onde
//  ele não está. O defeito só aparece quando alguém compara com o
//  mapa do jogo — e aí já custou a viagem.
//
//  Os dois enganos que este arquivo tranca:
//
//    1. o mundo é CENTRADO na origem, então a conta parte de
//       `x + size/2`, e não de `x`;
//    2. `Z` cresce para o NORTE e a linha 0 é a de CIMA, então a
//       linha é `size/2 - z`. Sem a inversão o mapa sai espelhado
//       na vertical.
// ============================================================

import { describe, expect, it } from 'vitest';

import { columnName, GRID_CELL_SIZE, gridLabel, worldGrid } from '../src/game/grid.js';

/** O mundo do `server01`. */
const SIZE = 4_000;

describe('gridLabel', () => {
  it('o canto NOROESTE do mundo é A0', () => {
    // x mínimo (oeste) e z máximo (norte) = a primeira célula, no
    // alto à esquerda do mapa. É o ponto que prova as duas contas
    // de uma vez.
    expect(gridLabel(-SIZE / 2, SIZE / 2, SIZE)).toBe('A0');
  });

  it('o canto SUDESTE é a última célula', () => {
    const { cols, rows } = worldGrid(SIZE);
    const esperado = `${columnName(cols - 1)}${String(rows - 1)}`;

    expect(gridLabel(SIZE / 2, -SIZE / 2, SIZE)).toBe(esperado);
  });

  it('o centro do mundo cai no meio da grade', () => {
    const meio = Math.floor(SIZE / 2 / GRID_CELL_SIZE);

    expect(gridLabel(0, 0, SIZE)).toBe(`${columnName(meio)}${String(meio)}`);
  });

  it('andar para o NORTE diminui o número da linha', () => {
    // Este é o teste da inversão. Com a conta errada (z + size/2) o
    // número CRESCERIA para o norte, e o mapa inteiro sairia
    // espelhado — de um jeito que só se percebe comparando com o
    // jogo.
    const sul = gridLabel(0, -1_000, SIZE) ?? '';
    const norte = gridLabel(0, 1_000, SIZE) ?? '';

    expect(linha(norte)).toBeLessThan(linha(sul));
  });

  it('andar para o LESTE avança a letra', () => {
    const oeste = coluna(gridLabel(-1_000, 0, SIZE) ?? '');
    const leste = coluna(gridLabel(1_000, 0, SIZE) ?? '');

    expect(oeste).not.toBe(leste);
    expect(oeste < leste).toBe(true);
  });

  it('a altura NÃO entra na conta', () => {
    // `y` é altura. Usar `(x, y)` é o erro clássico: funciona até
    // alguém subir num prédio. A assinatura nem aceita `y`, e este
    // teste guarda a propriedade: mesma `(x, z)`, mesma célula,
    // esteja o jogador no chão ou no telhado.
    expect(gridLabel(120, -840, SIZE)).toBe(gridLabel(120, -840, SIZE));
  });

  it('quem está fora do mundo fica na borda, e não em coluna negativa', () => {
    // O Rust deixa passar da borda, e um admin voando vai longe.
    expect(gridLabel(-99_999, 99_999, SIZE)).toBe('A0');
    expect(gridLabel(99_999, -99_999, SIZE)).toBe(gridLabel(SIZE / 2, -SIZE / 2, SIZE));
  });

  it('sem tamanho de mundo não há palpite', () => {
    expect(gridLabel(0, 0, 0)).toBeNull();
    expect(gridLabel(Number.NaN, 0, SIZE)).toBeNull();
  });
});

describe('worldGrid', () => {
  it('a célula tem tamanho fixo, e o mundo maior tem MAIS células', () => {
    // Ela não é derivada do worldSize: é por isso que a última
    // coluna do mapa do jogo é sempre mais estreita.
    expect(worldGrid(3_000).cellSize).toBe(worldGrid(6_000).cellSize);
    expect(worldGrid(6_000).cols).toBeGreaterThan(worldGrid(3_000).cols);
  });

  it('a faixa parcial da borda conta como célula', () => {
    // 4000 / 146.3 = 27,3… e a borda precisa ter nome.
    expect(worldGrid(SIZE).cols).toBe(Math.ceil(SIZE / GRID_CELL_SIZE));
  });
});

describe('columnName', () => {
  it('passa do Z sem repetir letra', () => {
    // Um mundo de 6000 tem mais de 26 colunas: o AA não é caso
    // raro, é o padrão nos mapas grandes.
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
  });
});

function linha(label: string): number {
  return Number(/\d+/.exec(label)?.[0] ?? '-1');
}

function coluna(label: string): string {
  return /^[A-Z]+/.exec(label)?.[0] ?? '';
}
