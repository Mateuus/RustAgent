// ============================================================
//  A parede cai na aresta do desenho, em qualquer giro.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  MEDIDO em 17/09/2026 no server01, parede por parede: a fundação
//  nascia com a rotação do MUNDO (`R0`) enquanto a posição dela
//  seguia os eixos girados da masmorra. Parede, vão e teto nascem
//  como filhos da fundação, em ±1,5 m nos eixos LOCAIS dela — então
//  a parede da vizinha "à direita no desenho" caía à direita no
//  mundo.
//
//  O "Labirinto" no ponto de dev (yaw 90 com a saída do E a 90°)
//  cancelava os dois giros e subia perfeito. Com yaw 0 subiram 122
//  das 496 paredes no lugar; com 45°, nenhuma. Na entrada, faltava a
//  parede de trás e sobrava uma entre o E e o corredor — o que o
//  dono relatou nas plantas desenhadas.
//
//  ####  O QUE ESTE TESTE TRAVA  ####
//
//  A conta de `GenerateRooms` + `WallPlacement`, portada do C#: a
//  parede entre duas células tem de nascer no ponto médio entre os
//  centros delas, qualquer que seja o giro. E o controle negativo:
//  com a fundação parada no eixo do mundo, a mesma conta erra — que
//  é o comportamento de antes, medido.
// ============================================================

import { describe, expect, it } from 'vitest';

import { FACTORY_LAYOUTS } from '../src/types/dungeon-layouts.js';

interface Vec {
  readonly x: number;
  readonly z: number;
}

const CELL = 3;

/** `Quaternion.Euler(0, deg, 0) * v`, no plano. */
function rotate(deg: number, v: Vec): Vec {
  const r = (deg * Math.PI) / 180;

  return { x: v.x * Math.cos(r) + v.z * Math.sin(r), z: -v.x * Math.sin(r) + v.z * Math.cos(r) };
}

/** O porte do `GridExitYaw`: frente, direita, esquerda, trás. */
function exitYaw(rows: readonly string[]): number {
  const line = rows.findIndex((row) => row.includes('E'));
  const column = rows[line]?.indexOf('E') ?? -1;
  const z = rows.length - 1 - line;
  const has = (c: number, zz: number): boolean => {
    const ch = rows[rows.length - 1 - zz]?.[c];

    return ch !== undefined && ch !== '.' && ch !== ' ';
  };

  if (has(column, z + 1)) return 0;
  if (has(column + 1, z)) return 90;
  if (has(column - 1, z)) return 270;
  if (has(column, z - 1)) return 180;

  return 0;
}

/** As arestas que pedem parede: vizinho de outro dono, ou nenhum. */
function wallEdges(rows: readonly string[]): [Vec, Vec][] {
  const line = rows.findIndex((row) => row.includes('E'));
  const ex = rows[line]?.indexOf('E') ?? 0;
  const ez = rows.length - 1 - line;
  const cells = new Map<string, string>();

  rows.forEach((row, index) => {
    [...row].forEach((ch, column) => {
      if (ch === '.' || ch === ' ') return;
      const kind = ch === 'E' || ch === '#' ? '#' : ch;

      cells.set(`${String(column - ex)},${String(rows.length - 1 - index - ez)}`, kind);
    });
  });

  const edges: [Vec, Vec][] = [];

  for (const [id, kind] of cells) {
    const [x = 0, z = 0] = id.split(',').map(Number);

    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      const other = cells.get(`${String(x + dx)},${String(z + dz)}`);

      // Mesma letra dos dois lados é o mesmo cômodo (ou o mesmo
      // corredor) — basta para esta conta, que olha a POSE.
      if (other === kind) continue;

      edges.push([
        { x, z },
        { x: x + dx, z: z + dz },
      ]);
    }
  }

  return edges;
}

/** O porte do `WallPlacement`: a posição local da parede na fundação. */
function wallLocal(cell: Vec, neighbour: Vec): Vec {
  if (cell.x === neighbour.x) return { x: 0, z: cell.z < neighbour.z ? 1.5 : -1.5 };

  return { x: cell.x < neighbour.x ? 1.5 : -1.5, z: 0 };
}

/**
 * Onde a parede nasce no mundo.
 *
 * `rotatedFoundation` é a correção: a fundação nasce com
 * `LookRotation(forward)`. Sem ela, o eixo local é o do mundo.
 */
function wallWorld(rows: readonly string[], yaw: number, cell: Vec, neighbour: Vec, rotatedFoundation: boolean): Vec {
  const exit = exitYaw(rows);
  let forward = rotate(yaw, { x: 0, z: 1 });

  if (exit !== 0) forward = rotate(-exit, forward);

  // `Vector3.Cross(Vector3.up, forward)`.
  const right = { x: forward.z, z: -forward.x };
  const base = { x: right.x * cell.x * CELL + forward.x * cell.z * CELL, z: right.z * cell.x * CELL + forward.z * cell.z * CELL };
  const local = wallLocal(cell, neighbour);

  // A rotação da fundação leva +x local para `right` e +z para
  // `forward`. A parada no mundo não leva nada para lugar nenhum.
  const offset = rotatedFoundation
    ? { x: right.x * local.x + forward.x * local.z, z: right.z * local.x + forward.z * local.z }
    : local;

  return { x: base.x + offset.x, z: base.z + offset.z };
}

function expectedMidpoint(rows: readonly string[], yaw: number, cell: Vec, neighbour: Vec): Vec {
  const exit = exitYaw(rows);
  let forward = rotate(yaw, { x: 0, z: 1 });

  if (exit !== 0) forward = rotate(-exit, forward);

  const right = { x: forward.z, z: -forward.x };
  const mx = ((cell.x + neighbour.x) / 2) * CELL;
  const mz = ((cell.z + neighbour.z) / 2) * CELL;

  return { x: right.x * mx + forward.x * mz, z: right.z * mx + forward.z * mz };
}

function misplaced(rows: readonly string[], yaw: number, rotatedFoundation: boolean): number {
  return wallEdges(rows).filter(([cell, neighbour]) => {
    const got = wallWorld(rows, yaw, cell, neighbour, rotatedFoundation);
    const want = expectedMidpoint(rows, yaw, cell, neighbour);

    return Math.hypot(got.x - want.x, got.z - want.z) > 0.01;
  }).length;
}

/** Uma entrada para cada lado: é o giro do desenho que variava. */
const EXITS: Record<string, readonly string[]> = {
  frente: ['.#.', '.E.', '...'],
  direita: ['...', '.E#', '...'],
  esquerda: ['...', '#E.', '...'],
  tras: ['...', '.E.', '.#.'],
};

const YAWS = [0, 45, 90, 135, 180, 217, 270, 333];

describe('parede na aresta do desenho', () => {
  for (const [name, rows] of Object.entries(EXITS)) {
    it(`entrada com saída para ${name}: nenhuma parede fora do lugar em ${String(YAWS.length)} giros`, () => {
      for (const yaw of YAWS) expect(misplaced(rows, yaw, true), `yaw ${String(yaw)}`).toBe(0);
    });
  }

  for (const layout of FACTORY_LAYOUTS) {
    it(`"${layout.name}" sobe certa em qualquer giro`, () => {
      for (const yaw of YAWS) expect(misplaced(layout.grid, yaw, true), `yaw ${String(yaw)}`).toBe(0);
    });
  }

  it('controle: com a fundação parada no eixo do mundo, só o giro que zera acerta', () => {
    const rows = EXITS.direita ?? [];

    // Saída a 90° com yaw 90: os dois giros se anulam — era o ponto
    // de dev, e por isso ele passava.
    expect(misplaced(rows, 90, false)).toBe(0);

    // Com yaw 0 a entrada perde a parede de trás e ganha outra no
    // caminho: é o defeito medido no server01.
    expect(misplaced(rows, 0, false)).toBeGreaterThan(0);
    expect(misplaced(rows, 45, false)).toBe(wallEdges(rows).length);
  });
});
