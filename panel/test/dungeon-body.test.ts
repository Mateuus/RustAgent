// ============================================================
//  A construção importada, vista de cima.
//
//  ####  O SENTIDO DO GIRO É O QUE ESTE ARQUIVO TRANCA  ####
//
//  Com o sinal trocado, a parede girada sai espelhada em volta do
//  pivô: a prévia desenha uma construção coerente e ERRADA, e o admin
//  põe o inimigo no corredor que não existe. A convenção é a do
//  Unity, medida no jogo — `mundo = Euler(0, yaw) · local`.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { BodyAnalysis, BodyMerge, BodyPiece, BodyPoint } from '@/lib/api';
import {
  clampMeters,
  floorCenter,
  floorHeightAt,
  floorLevels,
  insidePolygon,
  levelOf,
  newPointId,
  normalizeYaw,
  pieceLayer,
  pieceOutlines,
  problemsByTarget,
  profileTotals,
  readingWouldChange,
  rotateLocal,
  startingSpot,
  viewBounds,
  yawDirection,
} from '@/lib/dungeon-body';

function piece(change: Partial<BodyPiece>): BodyPiece {
  return { shape: 'foundation', x: 0, y: 0, z: 0, yaw: 0, grade: 2, skin: 0, ...change };
}

function point(change: Partial<BodyPoint>): BodyPoint {
  return {
    id: 'p-1',
    kind: 'npc',
    label: '',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    profile: 'green',
    amount: 1,
    prefab: '',
    source: 'manual',
    ...change,
  };
}

function analysis(change: Partial<BodyAnalysis>): BodyAnalysis {
  return {
    entityCount: 0,
    nodeCount: 0,
    markers: { npc: [], crate: [], arrival: [] },
    nestedMarkers: 0,
    roles: {
      structure: 0,
      attachment: 0,
      deployable: 0,
      marker: 0,
      npc: 0,
      loot: 0,
      hostile: 0,
      vehicle: 0,
      lock: 0,
      weapon: 0,
      unknown: 0,
    },
    inventoriesWithItems: 0,
    electrical: 0,
    pieces: [],
    props: [],
    bounds: null,
    rotationInRadians: true,
    warnings: [],
    ...change,
  };
}

const close = (value: number): number => Math.round(value * 1000) / 1000;

describe('rotateLocal', () => {
  it('sem giro, nada muda', () => {
    expect(rotateLocal(1, 2, 0)).toEqual({ x: 1, z: 2 });
  });

  it('90 graus leva a frente para a direita, como no Unity', () => {
    // Quaternion.Euler(0, 90, 0) * Vector3.forward = (1, 0, 0).
    const turned = rotateLocal(0, 1, 90);

    expect(close(turned.x)).toBe(1);
    expect(close(turned.z)).toBe(0);
  });

  it('90 graus leva a direita para trás', () => {
    // Quaternion.Euler(0, 90, 0) * Vector3.right = (0, 0, -1).
    const turned = rotateLocal(1, 0, 90);

    expect(close(turned.x)).toBe(0);
    expect(close(turned.z)).toBe(-1);
  });

  it('é o inverso exato da conta do agente (`toLocal`)', () => {
    // core/src/dungeons/body.ts: lx = dx·cos − dz·sin; lz = dx·sin + dz·cos.
    const yaw = 37;
    const radians = (yaw * Math.PI) / 180;
    const world = rotateLocal(0.7, -1.2, yaw);
    const lx = world.x * Math.cos(radians) - world.z * Math.sin(radians);
    const lz = world.x * Math.sin(radians) + world.z * Math.cos(radians);

    expect(close(lx)).toBe(0.7);
    expect(close(lz)).toBe(-1.2);
  });

  it('a frente do jogador com giro 180 é o sul', () => {
    const facing = yawDirection(180);

    expect(close(facing.x)).toBe(0);
    expect(close(facing.z)).toBe(-1);
  });
});

describe('pieceOutlines', () => {
  it('a fundação é um quadrado de 3 m centrado no pivô', () => {
    const [square] = pieceOutlines(piece({ x: 10, z: 20 }));

    expect(square).toEqual([
      { x: 8.5, z: 18.5 },
      { x: 11.5, z: 18.5 },
      { x: 11.5, z: 21.5 },
      { x: 8.5, z: 21.5 },
    ]);
  });

  it('o triângulo tem a base no pivô e a ponta à frente', () => {
    const [triangle] = pieceOutlines(piece({ shape: 'floor-triangle' }));

    expect(triangle?.map((corner) => ({ x: close(corner.x), z: close(corner.z) }))).toEqual([
      { x: -1.5, z: 0 },
      { x: 1.5, z: 0 },
      { x: 0, z: 2.598 },
    ]);
  });

  it('a parede corre ao longo do Z local, e gira com a peça', () => {
    // Sem giro, a parede vai de z = −1,5 a z = 1,5 (norte-sul). Com
    // 90 graus, ela deita: vai de x = −1,5 a x = 1,5.
    const [upright] = pieceOutlines(piece({ shape: 'wall' }));
    const [lying] = pieceOutlines(piece({ shape: 'wall', yaw: 90 }));

    expect(Math.max(...(upright ?? []).map((corner) => corner.z))).toBeCloseTo(1.5);
    expect(Math.max(...(upright ?? []).map((corner) => corner.x))).toBeCloseTo(0.1);
    expect(Math.max(...(lying ?? []).map((corner) => corner.x))).toBeCloseTo(1.5);
    expect(Math.max(...(lying ?? []).map((corner) => corner.z))).toBeCloseTo(0.1);
  });

  it('a porta e o quadro deixam o vão aberto', () => {
    const doorway = pieceOutlines(piece({ shape: 'doorway' }));
    const frame = pieceOutlines(piece({ shape: 'frame' }));

    expect(doorway).toHaveLength(2);
    expect(frame).toHaveLength(2);

    // O vão da porta é de um metro; o do quadro, 2,4.
    const innerEdge = (slabs: typeof doorway): number =>
      Math.min(...(slabs[1] ?? []).map((corner) => corner.z));

    expect(innerEdge(doorway)).toBeCloseTo(0.5);
    expect(innerEdge(frame)).toBeCloseTo(1.2);
  });

  it('classifica cada forma', () => {
    expect(pieceLayer('foundation-triangle')).toBe('floor');
    expect(pieceLayer('window')).toBe('wall');
    expect(pieceLayer('frame')).toBe('opening');
    expect(pieceLayer('low')).toBe('partial');
  });

  it('o meio do triângulo é o baricentro, e gira', () => {
    const middle = floorCenter(piece({ shape: 'foundation-triangle', yaw: 90 }));

    expect(close(middle.x)).toBe(0.866);
    expect(close(middle.z)).toBe(0);
  });
});

describe('o piso embaixo do clique', () => {
  it('reconhece o dentro e o fora de um polígono girado', () => {
    const [square] = pieceOutlines(piece({ yaw: 45 }));

    // Girado 45°, o quadrado de 3 m vira um losango: o canto (1,4; 0)
    // está dentro, e o (1,4; 1,4) — que estaria no quadrado reto — não.
    expect(insidePolygon(square ?? [], { x: 1.4, z: 0 })).toBe(true);
    expect(insidePolygon(square ?? [], { x: 1.4, z: 1.4 })).toBe(false);
  });

  it('mantém a altura pedida quando há piso nela', () => {
    const pieces = [piece({ y: 0 }), piece({ shape: 'floor', y: 3 })];

    expect(floorHeightAt(pieces, { x: 0.5, z: 0.5 }, 3.2)).toBe(3.2);
  });

  it('desce (ou sobe) para o piso que existe embaixo do clique', () => {
    // O ponto estava no andar de cima, e o clique caiu num cômodo que
    // só tem o térreo: ele vai para o térreo, e não fica no ar.
    const pieces = [piece({ x: 0, y: 0 }), piece({ shape: 'floor', x: 9, y: 3 })];

    expect(floorHeightAt(pieces, { x: 0.5, z: 0 }, 3)).toBe(0);
  });

  it('escolhe o piso mais perto da altura pedida', () => {
    const pieces = [piece({ y: 0 }), piece({ shape: 'floor', y: 3 }), piece({ shape: 'floor', y: 6 })];

    expect(floorHeightAt(pieces, { x: 0, z: 0 }, 5)).toBe(6);
  });

  it('sem piso embaixo, não inventa altura', () => {
    expect(floorHeightAt([piece({})], { x: 10, z: 10 }, 0)).toBeNull();
    // A parede não é chão.
    expect(floorHeightAt([piece({ shape: 'wall' })], { x: 0, z: 0 }, 0)).toBeNull();
  });
});

describe('os andares', () => {
  it('junta alturas próximas e ordena', () => {
    // O andar fica com a MENOR altura do grupo: é a primeira que a
    // ordenação encontra. A parede não conta — ela não é piso.
    const levels = floorLevels([
      piece({ y: 3.02 }),
      piece({ y: 0 }),
      piece({ shape: 'floor', y: 3 }),
      piece({ shape: 'wall', y: 1.5 }),
      piece({ y: 0.1 }),
    ]);

    expect(levels).toEqual([0, 3]);
  });

  it('um ponto pertence ao andar de baixo até meio metro do de cima', () => {
    const levels = [0, 3];

    expect(levelOf(0.2, levels)).toBe(0);
    expect(levelOf(2.4, levels)).toBe(0);
    expect(levelOf(2.6, levels)).toBe(1);
    expect(levelOf(-2, levels)).toBe(-1);
  });
});

describe('newPointId', () => {
  it('tem o formato que o agente aceita', () => {
    const id = newPointId(new Set());

    expect(id).toMatch(/^p-[a-z0-9]{1,8}$/u);
    expect(id.length).toBeLessThanOrEqual(40);
  });

  it('não repete um id que já existe', () => {
    // Um sorteio viciado que sempre devolve o mesmo número.
    const stuck = (): number => 0.5;
    const first = newPointId(new Set(), stuck);
    const second = newPointId(new Set([first]), stuck);

    expect(second).not.toBe(first);
    expect(second).toMatch(/^p-[a-z0-9]+$/u);
  });
});

describe('os números dos campos', () => {
  it('o metro fica na faixa do agente', () => {
    expect(clampMeters(600)).toBe(512);
    expect(clampMeters(-600)).toBe(-512);
    expect(clampMeters(1.23456)).toBe(1.235);
    expect(clampMeters(Number.NaN)).toBe(0);
  });

  it('o giro volta para 0..360', () => {
    expect(normalizeYaw(370)).toBe(10);
    expect(normalizeYaw(-90)).toBe(270);
    expect(normalizeYaw(360)).toBe(0);
    expect(normalizeYaw(12.346)).toBe(12.35);
  });
});

describe('o que a tela junta do scan', () => {
  it('agrupa os avisos por ponto', () => {
    const found = problemsByTarget([
      { id: 'p-1', code: 'no_floor', message: 'a' },
      { id: 'arrival', code: 'inside_wall', message: 'b' },
      { id: 'p-1', code: 'outside', message: 'c' },
    ]);

    expect(found.get('p-1')?.map((problem) => problem.message)).toEqual(['a', 'c']);
    expect(found.get('arrival')).toHaveLength(1);
    expect(found.get('p-2')).toBeUndefined();
  });

  it('reler só muda algo quando a planta mudou', () => {
    const merged: BodyMerge = {
      points: [],
      arrival: { x: 1, y: 0, z: 1, yaw: 0, source: 'marker' },
      added: 0,
      kept: 3,
      removed: 0,
      manual: 1,
      arrivalState: 'marker',
    };

    expect(readingWouldChange(merged, { arrival: { x: 1, y: 0, z: 1, yaw: 0, source: 'marker' } })).toBe(false);
    expect(readingWouldChange({ ...merged, added: 1 }, { arrival: merged.arrival })).toBe(true);
    // A árvore andou: a chegada do rascunho está velha.
    expect(readingWouldChange(merged, { arrival: { x: 4, y: 0, z: 1, yaw: 0, source: 'marker' } })).toBe(true);
    expect(readingWouldChange(merged, { arrival: null })).toBe(true);
  });

  it('soma o que cada perfil recebe', () => {
    const totals = profileTotals([
      point({ kind: 'npc', amount: 2 }),
      point({ id: 'p-2', kind: 'npc', amount: 1 }),
      point({ id: 'p-3', kind: 'crate', amount: 3, profile: 'corridor' }),
    ]);

    expect(totals.green).toEqual({ npcPoints: 2, npcs: 3, cratePoints: 0, crates: 0 });
    expect(totals.corridor).toEqual({ npcPoints: 0, npcs: 0, cratePoints: 1, crates: 3 });
    expect(totals.red).toEqual({ npcPoints: 0, npcs: 0, cratePoints: 0, crates: 0 });
  });
});

describe('startingSpot e viewBounds', () => {
  it('começa no piso mais perto do centro, na altura dele', () => {
    const scanned = analysis({
      pieces: [piece({ x: 0, z: 0, y: 0 }), piece({ x: 9, z: 0, y: 0 }), piece({ x: 3, z: 0, y: 0 })],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 3, z: 0 } },
    });

    expect(startingSpot(scanned)).toEqual({ x: 3, y: 0, z: 0 });
  });

  it('sem andar pedido, começa no andar com mais pisos', () => {
    // O piso mais perto do centro é o do andar de cima — e mesmo assim
    // a chegada à mão começa no térreo, que tem mais pisos.
    const scanned = analysis({
      pieces: [
        piece({ x: -6, y: 0 }),
        piece({ x: -3, y: 0 }),
        piece({ x: 6, y: 0 }),
        piece({ shape: 'floor', x: 0, y: 3 }),
      ],
      bounds: { min: { x: -6, y: 0, z: 0 }, max: { x: 6, y: 3, z: 0 } },
    });

    expect(startingSpot(scanned)).toEqual({ x: -3, y: 0, z: 0 });
  });

  it('respeita o andar pedido', () => {
    const scanned = analysis({
      pieces: [piece({ x: 0, y: 0 }), piece({ shape: 'floor', x: 6, y: 3 })],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 3, z: 0 } },
    });

    expect(startingSpot(scanned, 3)).toEqual({ x: 6, y: 3, z: 0 });
  });

  it('sem nada, é a origem da planta', () => {
    expect(startingSpot(null)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('enquadra também o ponto fora da construção', () => {
    const bounds = viewBounds(analysis({ pieces: [piece({})] }), [point({ x: 40, z: -30 })], null);

    expect(bounds.minX).toBeLessThan(-1.5);
    expect(bounds.maxX).toBeGreaterThan(40);
    expect(bounds.minZ).toBeLessThan(-30);
  });

  it('sem nada, enquadra um quadro padrão', () => {
    expect(viewBounds(null, [], null)).toEqual({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
  });
});
