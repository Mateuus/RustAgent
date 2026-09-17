// ============================================================
//  dungeon-body.ts  -  a construção importada, vista de cima.
//
//  O agente lê a planta (`POST /dungeon-blueprints/:id/body-scan`) e
//  devolve as peças com posição e giro. Este arquivo transforma isso
//  no que a prévia desenha — e só isso: quem junta os marcadores e
//  quem diz se um ponto cabe é o agente, numa régua só.
//
//  ####  O GIRO É O DO UNITY, E O SENTIDO IMPORTA  ####
//
//  MEDIDO no jogo: `mundo = Quaternion.Euler(0, yaw, 0) · local`. No
//  plano isso é
//
//      x' =  x·cos(yaw) + z·sin(yaw)
//      z' = -x·sin(yaw) + z·cos(yaw)
//
//  com +x à direita e +z à frente. O sinal trocado desenha a parede
//  espelhada em volta do pivô — e ela parece certa até alguém comparar
//  com o jogo. `core/src/dungeons/body.ts` faz a conta inversa
//  (`toLocal`) com a mesma convenção.
//
//  ####  AS FORMAS  ####
//
//    fundação e piso    quadrado de 3×3 m, centrado no pivô
//    triângulo          (−1,5; 0), (1,5; 0), (0; 2,598)
//    paredes            3 m ao longo do Z local, centradas no pivô,
//                       com ~0,2 m de espessura no X local
//
//  O vão da porta e o do quadro são as mesmas medidas que o agente usa
//  para saber se um corpo passa (`WALLS` em body.ts).
// ============================================================

import {
  BODY_METERS,
  type BodyAnalysis,
  type BodyArrival,
  type BodyMarker,
  type BodyMerge,
  type BodyPiece,
  type BodyPieceShape,
  type BodyPoint,
  type BodyPointProblem,
  type BodyProfile,
} from '@/lib/api';

/** Um ponto do plano: `x` para a direita (leste), `z` para a frente (norte). */
export interface PlanePoint {
  readonly x: number;
  readonly z: number;
}

/** Local → mundo, no plano. Ver o cabeçalho. */
export function rotateLocal(lx: number, lz: number, yawDegrees: number): PlanePoint {
  const radians = (yawDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return { x: lx * cos + lz * sin, z: -lx * sin + lz * cos };
}

/**
 * Para onde a frente aponta, com aquele giro.
 *
 * A frente local é +z — a mesma do jogador que chega e do inimigo que
 * vigia.
 */
export function yawDirection(yawDegrees: number): PlanePoint {
  return rotateLocal(0, 1, yawDegrees);
}

/** Como a prévia pinta cada forma. */
export type PieceLayer = 'floor' | 'wall' | 'opening' | 'partial';

export function pieceLayer(shape: BodyPieceShape): PieceLayer {
  switch (shape) {
    case 'foundation':
    case 'foundation-triangle':
    case 'floor':
    case 'floor-triangle':
      return 'floor';
    case 'doorway':
    case 'frame':
      return 'opening';
    case 'half':
    case 'low':
      return 'partial';
    case 'wall':
    case 'window':
      return 'wall';
  }
}

const SQUARE: readonly (readonly [number, number])[] = [
  [-1.5, -1.5],
  [1.5, -1.5],
  [1.5, 1.5],
  [-1.5, 1.5],
];

/** Medido: bounds z de 0 a 2,6, com a base no pivô. */
const TRIANGLE: readonly (readonly [number, number])[] = [
  [-1.5, 0],
  [1.5, 0],
  [0, 2.598],
];

/** Meia espessura da parede, no X local. */
const WALL_HALF_THICKNESS = 0.1;

/**
 * Metade do vão que atravessa cada parede, no Z local.
 *
 * Os números do agente: pouco mais de um metro na porta, quase a
 * parede inteira no quadro.
 */
const OPENING_HALF_GAP: Readonly<Partial<Record<BodyPieceShape, number>>> = {
  doorway: 0.5,
  frame: 1.2,
};

/** Um retângulo de parede entre dois pontos do Z local. */
function wallSlab(fromZ: number, toZ: number): (readonly [number, number])[] {
  return [
    [-WALL_HALF_THICKNESS, fromZ],
    [WALL_HALF_THICKNESS, fromZ],
    [WALL_HALF_THICKNESS, toZ],
    [-WALL_HALF_THICKNESS, toZ],
  ];
}

/**
 * Os polígonos de uma peça, em metros da planta.
 *
 * Mais de um só na porta e no quadro: os dois pedaços de parede em
 * volta do vão. É o vão que diz ao admin por onde se passa.
 */
export function pieceOutlines(piece: BodyPiece): PlanePoint[][] {
  const layer = pieceLayer(piece.shape);
  let shapes: (readonly (readonly [number, number])[])[];

  if (layer === 'floor') {
    shapes = [piece.shape === 'foundation' || piece.shape === 'floor' ? SQUARE : TRIANGLE];
  } else {
    const gap = OPENING_HALF_GAP[piece.shape];

    shapes = gap === undefined ? [wallSlab(-1.5, 1.5)] : [wallSlab(-1.5, -gap), wallSlab(gap, 1.5)];
  }

  return shapes.map((shape) =>
    shape.map(([lx, lz]) => {
      const turned = rotateLocal(lx, lz, piece.yaw);

      return { x: piece.x + turned.x, z: piece.z + turned.z };
    }),
  );
}

/** O ponto está dentro do polígono? Serve a qualquer contorno de `pieceOutlines`. */
export function insidePolygon(polygon: readonly PlanePoint[], spot: PlanePoint): boolean {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];

    if (a === undefined || b === undefined) continue;

    const crosses =
      a.z > spot.z !== b.z > spot.z && spot.x < ((b.x - a.x) * (spot.z - a.z)) / (b.z - a.z) + a.x;

    if (crosses) inside = !inside;
  }

  return inside;
}

/**
 * A altura do piso que está embaixo de um clique.
 *
 * ####  O CLIQUE É NO PLANO, E O PONTO PRECISA DE CHÃO  ####
 *
 * A prévia é vista de cima: um clique diz `x` e `z`, e nada sobre a
 * altura. Manter a altura antiga levava o ponto do térreo para o ar
 * quando o admin clicava num cômodo do andar de cima.
 *
 *   - há piso na altura pedida, embaixo do clique: ela fica;
 *   - há piso em outra altura: vale o mais perto da pedida;
 *   - não há piso nenhum: `null`, e a régua do agente avisa.
 */
export function floorHeightAt(
  pieces: readonly BodyPiece[],
  spot: PlanePoint,
  wanted: number,
): number | null {
  const heights = pieces
    .filter((piece) => pieceLayer(piece.shape) === 'floor')
    .filter((piece) => pieceOutlines(piece).some((outline) => insidePolygon(outline, spot)))
    .map((piece) => piece.y);

  if (heights.length === 0) return null;
  if (heights.some((height) => Math.abs(height - wanted) <= 0.6)) return wanted;

  return heights.reduce((best, height) =>
    Math.abs(height - wanted) < Math.abs(best - wanted) ? height : best,
  );
}

/**
 * O meio de uma peça de piso, em metros da planta.
 *
 * O do quadrado é o pivô; o do triângulo é o baricentro, que fica
 * 0,866 m à frente da base.
 */
export function floorCenter(piece: BodyPiece): PlanePoint {
  if (piece.shape !== 'foundation-triangle' && piece.shape !== 'floor-triangle') {
    return { x: piece.x, z: piece.z };
  }

  const turned = rotateLocal(0, 2.598 / 3, piece.yaw);

  return { x: piece.x + turned.x, z: piece.z + turned.z };
}

/** O retângulo que a prévia enquadra. */
export interface ViewBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * O que a prévia precisa enquadrar: as peças, os enfeites, os
 * marcadores da planta e os pontos do rascunho.
 *
 * Os pontos entram de propósito: um ponto fora da construção é
 * exatamente o que o admin precisa VER para consertar.
 */
export function viewBounds(
  analysis: BodyAnalysis | null,
  points: readonly { readonly x: number; readonly z: number }[],
  arrival: { readonly x: number; readonly z: number } | null,
): ViewBounds {
  const xs: number[] = [];
  const zs: number[] = [];

  const add = (x: number, z: number, reach: number): void => {
    xs.push(x - reach, x + reach);
    zs.push(z - reach, z + reach);
  };

  for (const piece of analysis?.pieces ?? []) add(piece.x, piece.z, 1.6);
  for (const prop of analysis?.props ?? []) add(prop.x, prop.z, 0.5);

  for (const marker of [
    ...(analysis?.markers.npc ?? []),
    ...(analysis?.markers.crate ?? []),
    ...(analysis?.markers.arrival ?? []),
  ]) {
    add(marker.x, marker.z, 0.5);
  }

  for (const point of points) add(point.x, point.z, 0.8);
  if (arrival !== null) add(arrival.x, arrival.z, 1);

  if (xs.length === 0) return { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

/**
 * Os andares da construção: as alturas distintas dos pisos.
 *
 * Duas alturas a menos de meio metro uma da outra são o mesmo andar
 * — uma fundação e um piso encostados não ficam exatamente no mesmo
 * y. Em ordem, de baixo para cima.
 */
export function floorLevels(pieces: readonly BodyPiece[]): number[] {
  const heights = pieces
    .filter((piece) => pieceLayer(piece.shape) === 'floor')
    .map((piece) => piece.y)
    .sort((a, b) => a - b);

  const levels: number[] = [];

  for (const height of heights) {
    const last = levels.at(-1);

    if (last === undefined || height - last >= 0.5) levels.push(Math.round(height * 100) / 100);
  }

  return levels;
}

/**
 * O andar a que uma altura pertence. `-1` = abaixo de todos.
 *
 * Cada andar vai de meio metro abaixo do piso dele até meio metro
 * abaixo do piso de cima: a parede nasce no piso, e o inimigo fica de
 * pé um pouco acima dele.
 */
export function levelOf(y: number, levels: readonly number[]): number {
  let found = -1;

  levels.forEach((level, index) => {
    if (y >= level - 0.5) found = index;
  });

  return found;
}

/**
 * Um id novo para o ponto manual: `p-` e um pedaço aleatório.
 *
 * O agente exige `[a-z0-9-]{1,40}` e recusa dois pontos com o mesmo
 * id. O sorteio em base 36 com oito casas praticamente não repete; o
 * laço é para o "praticamente".
 */
export function newPointId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `p-${Math.floor(random() * 36 ** 8).toString(36)}`;

    if (!taken.has(id)) return id;
  }

  // Um sorteio que só repete é um `random` de teste. Contar para a
  // frente sempre termina.
  let counter = taken.size;

  while (taken.has(`p-${counter.toString(36)}`)) counter += 1;

  return `p-${counter.toString(36)}`;
}

/** Um metro dentro do que o agente aceita, no milímetro. */
export function clampMeters(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const rounded = Math.round(value * 1000) / 1000;

  return Math.min(BODY_METERS.max, Math.max(BODY_METERS.min, rounded));
}

/** Graus de 0 a 360 (exclusive), no centésimo — como o agente guarda. */
export function normalizeYaw(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const turned = ((value % 360) + 360) % 360;

  return Math.round(turned * 100) / 100;
}

/** Os avisos do último scan, por ponto (e `arrival`). */
export function problemsByTarget(
  problems: readonly BodyPointProblem[],
): ReadonlyMap<string, readonly BodyPointProblem[]> {
  const found = new Map<string, BodyPointProblem[]>();

  for (const problem of problems) {
    const list = found.get(problem.id);

    if (list === undefined) found.set(problem.id, [problem]);
    else list.push(problem);
  }

  return found;
}

/** Duas posições são a mesma, no centímetro? */
export function sameSpot(
  a: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number } | null,
  b: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number } | null,
): boolean {
  if (a === null || b === null) return a === b;

  const near = (p: number, q: number): boolean => Math.abs(p - q) < 0.01;

  return near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z) && near(a.yaw, b.yaw);
}

/**
 * A planta mudou desde a última leitura?
 *
 * É a pergunta da conferência automática: ela não mexe no rascunho,
 * e por isso precisa dizer quando reler os marcadores mudaria alguma
 * coisa — um marcador novo, um que sumiu, ou a árvore que andou.
 */
export function readingWouldChange(
  merged: BodyMerge,
  current: { readonly arrival: BodyArrival | null },
): boolean {
  return merged.added > 0 || merged.removed > 0 || !sameSpot(merged.arrival, current.arrival);
}

/**
 * A chegada tirada de uma árvore que o admin escolheu.
 *
 * `manual`, e não `marker`: foi uma ESCOLHA entre várias (ou uma
 * troca), e reler a planta não pode desfazê-la. Com uma árvore só, o
 * agente já faz isso sozinho, como `marker`.
 */
export function arrivalFromMarker(marker: BodyMarker): BodyArrival {
  return { x: marker.x, y: marker.y, z: marker.z, yaw: marker.yaw, source: 'manual' };
}

/**
 * Um lugar razoável para começar um ponto novo: o meio do piso mais
 * perto do centro da construção (no andar pedido, se houver).
 *
 * O `y` é o do piso — é onde algo fica de pé. Sem piso nenhum, o
 * centro da caixa da construção; sem nada, a origem da planta.
 *
 * ####  SEM ANDAR PEDIDO, O ANDAR PRINCIPAL  ####
 *
 * O piso mais perto do centro pode estar no terceiro andar — e foi
 * lá que a primeira versão pôs a chegada de uma construção de três
 * andares. O andar com mais pisos é o térreo em quase toda
 * construção, e é por ele que se começa.
 */
export function startingSpot(
  analysis: BodyAnalysis | null,
  level: number | null = null,
): { x: number; y: number; z: number } {
  const allFloors = (analysis?.pieces ?? []).filter((piece) => pieceLayer(piece.shape) === 'floor');
  const height = level ?? mainLevel(allFloors);
  const floors = allFloors.filter((piece) => height === null || Math.abs(piece.y - height) < 0.5);

  const bounds = analysis?.bounds ?? null;
  const center =
    bounds === null
      ? { x: 0, z: 0 }
      : { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 };

  let best: { piece: BodyPiece; distance: number } | null = null;

  for (const piece of floors) {
    const middle = floorCenter(piece);
    const distance = (middle.x - center.x) ** 2 + (middle.z - center.z) ** 2;

    if (best === null || distance < best.distance) best = { piece, distance };
  }

  if (best !== null) {
    const middle = floorCenter(best.piece);

    return {
      x: clampMeters(middle.x),
      y: clampMeters(best.piece.y),
      z: clampMeters(middle.z),
    };
  }

  if (bounds !== null) {
    return { x: clampMeters(center.x), y: clampMeters(bounds.min.y), z: clampMeters(center.z) };
  }

  return { x: 0, y: 0, z: 0 };
}

/** O andar com mais pisos. Empatados, o de baixo. `null` = sem piso. */
function mainLevel(floors: readonly BodyPiece[]): number | null {
  let best: { height: number; count: number } | null = null;

  for (const height of floorLevels(floors)) {
    const count = floors.filter((piece) => Math.abs(piece.y - height) < 0.5).length;

    if (best === null || count > best.count) best = { height, count };
  }

  return best?.height ?? null;
}

/** Quanto cada perfil vai receber: é o resumo ao lado de "Salas e loot". */
export interface ProfileTotals {
  readonly npcPoints: number;
  readonly npcs: number;
  readonly cratePoints: number;
  readonly crates: number;
}

export function profileTotals(points: readonly BodyPoint[]): Record<BodyProfile, ProfileTotals> {
  const empty = (): { npcPoints: number; npcs: number; cratePoints: number; crates: number } => ({
    npcPoints: 0,
    npcs: 0,
    cratePoints: 0,
    crates: 0,
  });

  const totals = { green: empty(), blue: empty(), red: empty(), corridor: empty() };

  for (const point of points) {
    const entry = totals[point.profile];

    if (point.kind === 'npc') {
      entry.npcPoints += 1;
      entry.npcs += point.amount;
    } else {
      entry.cratePoints += 1;
      entry.crates += point.amount;
    }
  }

  return totals;
}
