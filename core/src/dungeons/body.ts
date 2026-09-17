// ============================================================
//  body.ts  -  a construção feita à mão, lida como corpo de masmorra.
//
//  O admin constrói a masmorra DENTRO do Rust, salva com o CopyPaste
//  e sobe o JSON para a biblioteca. Este arquivo responde, sobre esse
//  JSON, o que o agente precisa saber antes de o plugin colá-lo a -90:
//
//    onde estão os marcadores?          `analyzeBody`
//    que peças entram e quais não?      `analyzeBody`
//    que pontos a masmorra tem agora?   `mergeBodyPoints`
//    cada ponto cabe onde está?         `checkBodyPoints`
//
//  ####  OS TRÊS MARCADORES  ####
//
//  MEDIDO em 17/09/2026 no server01, perguntando ao `ItemModDeployable`
//  de cada item que prefab ele põe no mundo — é o prefab, e não o item,
//  que o CopyPaste grava:
//
//    Gravestone        gravestone     809199956   ponto de INIMIGO
//    Large Candle Set  largecandles  -489848205   ponto de CAIXA
//    Christmas Tree    xmas.tree      794443127   CHEGADA do jogador
//
//  Cada item tem UM prefab. A `gravestone.wood.deployed` que mora na
//  mesma pasta é outro item (`woodcross`, 699075597) e não é marcador;
//  a `xmas_tree_a.deployed` não é posta por item nenhum.
//
//  ####  O MARCADOR MARCA; QUEM DECIDE O CONTEÚDO É O EVENTO  ####
//
//  A lápide diz ONDE. Que inimigo, quantos, com que arma e com que
//  loot vem da configuração da masmorra (`BODY_PROFILES`). E o marcador
//  não entra na masmorra ativa: o plugin o pula na colagem.
//
//  O mesmo vale para o que a construção carrega: NPC, caixa de loot de
//  monumento, armadilha, torre, veículo, fechadura e item dentro de
//  inventário não são importados — senão a recompensa viria duas
//  vezes, uma do arquivo e outra do evento. Este arquivo CONTA cada
//  um, para a tela dizer o que ficou de fora.
//
//  ####  AS DUAS PONTAS SÃO SEPARADAS, COMO NO ALÇAPÃO  ####
//
//  O plugin (`BodyRoleOf`) decide pelo TIPO da entidade, que é a
//  verdade; aqui se decide pelo CAMINHO do prefab, que é o que se tem
//  sem o jogo. Um prefab novo que escape daqui ainda é filtrado lá —
//  e a tela o mostra como "não reconhecida".
//
//  Ver Docs/OrigemZDurgeon/04-PLANTA-CORPO-E-MENSAGENS.md.
// ============================================================

import type { BodyArrivalInput, BodyPointInput, PlacementKind } from '../types/dungeons.js';

// ------------------------------------------------------------
//  OS MARCADORES
// ------------------------------------------------------------

export const BODY_MARKER_PREFABS = {
  npc: 'assets/prefabs/misc/halloween/deployablegravestone/gravestone.stone.deployed.prefab',
  crate: 'assets/prefabs/misc/halloween/candles/largecandleset.prefab',
  arrival: 'assets/prefabs/misc/xmas/xmastree/xmas_tree.deployed.prefab',
} as const;

export type BodyMarkerKind = keyof typeof BODY_MARKER_PREFABS;

/** O nome de cada marcador, na tela. */
export const BODY_MARKER_LABEL: Record<BodyMarkerKind, string> = {
  npc: 'Lápide',
  crate: 'Velas grandes',
  arrival: 'Árvore de Natal',
};

export interface BodyMarker {
  readonly kind: BodyMarkerKind;
  /** O id que o ponto derivado dele recebe. Ver `markerId`. */
  readonly id: string;
  /** A posição na lista `entities` do arquivo. Só para a tela. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

// ------------------------------------------------------------
//  AS PEÇAS
// ------------------------------------------------------------

/** O que o plugin faz com cada entidade do arquivo, no papel de corpo. */
export type BodyEntityRole =
  | 'structure'
  | 'attachment'
  | 'deployable'
  | 'marker'
  | 'npc'
  | 'loot'
  | 'hostile'
  | 'vehicle'
  | 'lock'
  | 'weapon'
  | 'unknown';

/** Os papéis que o plugin NÃO cola. */
export const SKIPPED_ROLES: ReadonlySet<BodyEntityRole> = new Set([
  'marker',
  'npc',
  'loot',
  'hostile',
  'vehicle',
  'lock',
  'weapon',
]);

/**
 * A forma de uma peça de construção, para medir espaço.
 *
 * Só as formas que importam para "cabe alguém aqui": piso (quadrado ou
 * triângulo) e parede (com ou sem vão). Telhado, rampa e escada ficam
 * fora — a régua não tenta adivinhar a altura de um degrau.
 */
export type BodyPieceShape =
  | 'foundation'
  | 'foundation-triangle'
  | 'floor'
  | 'floor-triangle'
  | 'wall'
  | 'doorway'
  | 'frame'
  | 'window'
  | 'half'
  | 'low';

export interface BodyPiece {
  readonly shape: BodyPieceShape;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Graus. */
  readonly yaw: number;
  readonly grade: number;
  readonly skin: number;
}

/** Um enfeite ou móvel, para a prévia desenhar onde ele está. */
export interface BodyProp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly role: BodyEntityRole;
}

export interface BodyAnalysis {
  /** As entidades de cima do arquivo. */
  readonly entityCount: number;
  /** Contando filhos e netos. É o "de N" do relatório do plugin. */
  readonly nodeCount: number;
  readonly markers: {
    readonly npc: readonly BodyMarker[];
    readonly crate: readonly BodyMarker[];
    readonly arrival: readonly BodyMarker[];
  };
  /**
   * Marcadores pendurados em outra peça (filhos). Não viram ponto: a
   * posição deles é relativa ao pai, e o CopyPaste só grava assim o
   * que foi ENCAIXADO — uma vela numa estante, por exemplo.
   */
  readonly nestedMarkers: number;
  /** Quantas entidades de cada papel (contando filhos). */
  readonly roles: Readonly<Record<BodyEntityRole, number>>;
  /** Nós com itens dentro. Os itens não são importados. */
  readonly inventoriesWithItems: number;
  /** Peças elétricas: sobem, mas sem fiação. */
  readonly electrical: number;
  /** As peças de construção, em coordenadas da planta. */
  readonly pieces: readonly BodyPiece[];
  /** Os móveis e enfeites que sobem, para a prévia. */
  readonly props: readonly BodyProp[];
  /** A caixa que a construção ocupa. `null` = planta sem posição legível. */
  readonly bounds: {
    readonly min: { readonly x: number; readonly y: number; readonly z: number };
    readonly max: { readonly x: number; readonly y: number; readonly z: number };
  } | null;
  /** O arquivo guarda rotação em radianos (o CopyPaste faz assim). */
  readonly rotationInRadians: boolean;
  /** As frases que a tela mostra sobre o que fica de fora. */
  readonly warnings: readonly string[];
}

interface RawNode {
  readonly prefabname?: unknown;
  readonly pos?: unknown;
  readonly rot?: unknown;
  readonly items?: unknown;
  readonly children?: unknown;
  readonly grade?: unknown;
  readonly skinid?: unknown;
}

/** O mesmo teto do plugin (`TwoPiCeiling`). Ver `RotationScaleOf` lá. */
const TWO_PI_CEILING = 6.2833;

function readNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function readVector(value: unknown): { x: number; y: number; z: number } {
  if (value === null || typeof value !== 'object') return { x: 0, y: 0, z: 0 };

  const node = value as { x?: unknown; y?: unknown; z?: unknown };

  return { x: readNumber(node.x), y: readNumber(node.y), z: readNumber(node.z) };
}

function prefabOf(node: RawNode): string {
  return typeof node.prefabname === 'string' ? node.prefabname.toLowerCase() : '';
}

function childrenOf(node: RawNode): RawNode[] {
  return Array.isArray(node.children)
    ? node.children.filter((child): child is RawNode => child !== null && typeof child === 'object')
    : [];
}

/**
 * O papel de uma entidade, pelo caminho do prefab.
 *
 * A ordem das perguntas importa: o marcador vem antes de "enfeite",
 * porque os três moram em `assets/prefabs/misc/`.
 */
export function roleOfPrefab(rawPrefab: string): BodyEntityRole {
  const prefab = rawPrefab.toLowerCase();

  if (prefab === '') return 'unknown';

  if (
    prefab === BODY_MARKER_PREFABS.npc ||
    prefab === BODY_MARKER_PREFABS.crate ||
    prefab === BODY_MARKER_PREFABS.arrival
  ) {
    return 'marker';
  }

  if (
    prefab.includes('modularcar') ||
    prefab.includes('module_car_spawned') ||
    prefab.includes('modular_car_fuel_storage') ||
    prefab.startsWith('assets/content/vehicles/')
  ) {
    return 'vehicle';
  }

  if (prefab.startsWith('assets/rust.ai/') || prefab.includes('/npc/scientist')) return 'npc';

  if (
    prefab.includes('autoturret') ||
    prefab.includes('flameturret') ||
    prefab.includes('guntrap') ||
    prefab.includes('landmine') ||
    prefab.includes('beartrap') ||
    prefab.includes('sam_site') ||
    prefab.includes('teslacoil') ||
    prefab.includes('spikes.floor')
  ) {
    return 'hostile';
  }

  if (
    prefab.startsWith('assets/bundled/prefabs/radtown/') ||
    prefab.includes('loot_barrel') ||
    prefab.includes('lootcrate') ||
    prefab.includes('supply_drop') ||
    prefab.includes('codelockedhackablecrate') ||
    prefab.includes('/item drop/') ||
    prefab.includes('item_drop')
  ) {
    return 'loot';
  }

  if (
    prefab.startsWith('assets/prefabs/weapons/') ||
    prefab.startsWith('assets/prefabs/ammo/') ||
    prefab.startsWith('assets/prefabs/tools/')
  ) {
    return 'weapon';
  }

  if (prefab.startsWith('assets/prefabs/locks/')) return 'lock';
  if (prefab.startsWith('assets/prefabs/building core/')) return 'structure';
  if (prefab.startsWith('assets/prefabs/building/')) return 'attachment';

  if (
    prefab.startsWith('assets/prefabs/deployable/') ||
    prefab.startsWith('assets/prefabs/misc/') ||
    prefab.startsWith('assets/prefabs/plants/') ||
    prefab.startsWith('assets/bundled/prefabs/static/')
  ) {
    return 'deployable';
  }

  return 'unknown';
}

/** A forma de uma peça de construção, ou `null` para as que a régua ignora. */
function shapeOf(prefab: string): BodyPieceShape | null {
  const match = /^assets\/prefabs\/building core\/([^/]+)\/\1\.prefab$/u.exec(prefab);
  const name = match?.[1];

  switch (name) {
    case 'foundation':
      return 'foundation';
    case 'foundation.triangle':
      return 'foundation-triangle';
    case 'floor':
    case 'floor.frame':
      return 'floor';
    case 'floor.triangle':
    case 'floor.triangle.frame':
      return 'floor-triangle';
    case 'wall':
      return 'wall';
    case 'wall.doorway':
      return 'doorway';
    case 'wall.frame':
      return 'frame';
    case 'wall.window':
      return 'window';
    case 'wall.half':
      return 'half';
    case 'wall.low':
      return 'low';
    default:
      return null;
  }
}

/**
 * O id estável de um ponto que veio de marcador.
 *
 * Depende do TIPO e da POSIÇÃO do marcador no arquivo, arredondada no
 * centímetro — e de mais nada. O mesmo arquivo reprocessado dá o mesmo
 * id; a lápide movida de lugar (e a planta reenviada) dá outro, e o
 * ponto antigo sai. É o que torna o reprocesso idempotente.
 */
export function markerId(kind: BodyMarkerKind, x: number, y: number, z: number): string {
  const text = `${kind}|${x.toFixed(2)}|${y.toFixed(2)}|${z.toFixed(2)}`;
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  const letter = kind === 'npc' ? 'g' : kind === 'crate' ? 'v' : 'a';

  return `m${letter}-${hash.toString(36)}`;
}

function normalizeYaw(degrees: number): number {
  const value = ((degrees % 360) + 360) % 360;

  return Math.round(value * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Lê a construção inteira.
 *
 * `entities` é o array do arquivo (já conferido por `parseBlueprint`).
 */
export function analyzeBody(entities: readonly unknown[]): BodyAnalysis {
  const nodes = entities.filter((node): node is RawNode => node !== null && typeof node === 'object');

  // Radiano ou grau: a planta inteira decide, como no plugin.
  let maxRotation = 0;

  for (const node of nodes) {
    for (const each of [node, ...childrenOf(node)]) {
      const rot = readVector(each.rot);

      maxRotation = Math.max(maxRotation, Math.abs(rot.x), Math.abs(rot.y), Math.abs(rot.z));
    }
  }

  const rotationInRadians = maxRotation <= TWO_PI_CEILING;
  const toDegrees = rotationInRadians ? 180 / Math.PI : 1;

  const roles: Record<BodyEntityRole, number> = {
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
  };

  const markers: Record<BodyMarkerKind, BodyMarker[]> = { npc: [], crate: [], arrival: [] };
  const pieces: BodyPiece[] = [];
  const props: BodyProp[] = [];

  let nodeCount = 0;
  let nestedMarkers = 0;
  let inventoriesWithItems = 0;
  let electrical = 0;
  let min: { x: number; y: number; z: number } | null = null;
  let max: { x: number; y: number; z: number } | null = null;

  const visit = (node: RawNode, nested: boolean, parentSkipped: boolean): void => {
    nodeCount += 1;

    const prefab = prefabOf(node);
    const role = roleOfPrefab(prefab);

    roles[role] += 1;

    const skipped = parentSkipped || SKIPPED_ROLES.has(role);

    if (Array.isArray(node.items) && node.items.length > 0 && !skipped) inventoriesWithItems += 1;
    if (prefab.includes('/playerioents/') && !skipped) electrical += 1;

    if (role === 'marker' && nested) nestedMarkers += 1;

    for (const child of childrenOf(node)) visit(child, true, skipped);
  };

  for (const [index, node] of nodes.entries()) {
    visit(node, false, false);

    const prefab = prefabOf(node);
    const role = roleOfPrefab(prefab);
    const pos = readVector(node.pos);
    const yaw = normalizeYaw(readVector(node.rot).y * toDegrees);

    if (role === 'marker') {
      const kind = (Object.keys(BODY_MARKER_PREFABS) as BodyMarkerKind[]).find(
        (candidate) => BODY_MARKER_PREFABS[candidate] === prefab,
      );

      if (kind !== undefined) {
        markers[kind].push({
          kind,
          id: markerId(kind, pos.x, pos.y, pos.z),
          index,
          x: round(pos.x),
          y: round(pos.y),
          z: round(pos.z),
          yaw,
        });
      }

      continue;
    }

    if (SKIPPED_ROLES.has(role)) continue;

    min = min === null ? { ...pos } : { x: Math.min(min.x, pos.x), y: Math.min(min.y, pos.y), z: Math.min(min.z, pos.z) };
    max = max === null ? { ...pos } : { x: Math.max(max.x, pos.x), y: Math.max(max.y, pos.y), z: Math.max(max.z, pos.z) };

    const shape = role === 'structure' ? shapeOf(prefab) : null;

    if (shape !== null) {
      pieces.push({
        shape,
        x: round(pos.x),
        y: round(pos.y),
        z: round(pos.z),
        yaw,
        grade: Math.round(readNumber(node.grade)),
        skin: Math.round(readNumber(node.skinid)),
      });
      continue;
    }

    if (role === 'deployable' || role === 'attachment' || role === 'unknown') {
      props.push({ x: round(pos.x), y: round(pos.y), z: round(pos.z), role });
    }
  }

  const warnings: string[] = [];
  const say = (count: number, one: string, many: string): void => {
    if (count === 1) warnings.push(one);
    else if (count > 1) warnings.push(many.replace('{n}', String(count)));
  };

  say(roles.npc, 'Um NPC do arquivo não será importado: os inimigos vêm dos pontos de lápide.', '{n} NPCs do arquivo não serão importados: os inimigos vêm dos pontos de lápide.');
  say(roles.loot, 'Uma caixa de loot do arquivo não será importada: as caixas vêm dos pontos de velas.', '{n} caixas de loot do arquivo não serão importadas: as caixas vêm dos pontos de velas.');
  say(roles.hostile, 'Uma armadilha ou torre não será importada: quem ataca é configurado no evento.', '{n} armadilhas ou torres não serão importadas: quem ataca é configurado no evento.');
  say(roles.vehicle, 'Um veículo não será importado.', '{n} peças de veículo não serão importadas.');
  say(roles.lock, 'Uma fechadura não será importada: com o código do arquivo, a porta ficaria trancada para sempre.', '{n} fechaduras não serão importadas: com o código do arquivo, as portas ficariam trancadas para sempre.');
  say(roles.weapon, 'Uma arma exposta não será importada.', '{n} armas ou ferramentas expostas não serão importadas.');
  say(inventoriesWithItems, 'Uma peça tem itens dentro, e eles não serão importados (a peça sobe vazia).', '{n} peças têm itens dentro, e eles não serão importados (as peças sobem vazias).');
  say(electrical, 'Uma peça elétrica sobe sem fiação.', '{n} peças elétricas sobem sem fiação.');
  say(roles.unknown, 'Uma peça não foi reconhecida; ela sobe como está, se o jogo a aceitar.', '{n} peças não foram reconhecidas; elas sobem como estão, se o jogo as aceitar.');
  say(nestedMarkers, 'Um marcador está encaixado em outra peça e foi ignorado: ponha-o solto no piso.', '{n} marcadores estão encaixados em outras peças e foram ignorados: ponha-os soltos no piso.');

  if (pieces.length === 0) {
    warnings.push('A construção não tem piso nem parede reconhecíveis: não dá para conferir se os pontos cabem nela.');
  }

  return {
    entityCount: nodes.length,
    nodeCount,
    markers,
    nestedMarkers,
    roles,
    inventoriesWithItems,
    electrical,
    pieces,
    props,
    bounds: min === null || max === null ? null : { min, max },
    rotationInRadians,
    warnings,
  };
}

// ------------------------------------------------------------
//  OS PONTOS
// ------------------------------------------------------------

export interface BodyMergeResult {
  readonly points: BodyPointInput[];
  readonly arrival: BodyArrivalInput | null;
  /** Pontos de marcador que não existiam e entraram agora. */
  readonly added: number;
  /** Pontos de marcador que já existiam e foram mantidos como estavam. */
  readonly kept: number;
  /** Pontos de marcador cujo marcador sumiu da planta. */
  readonly removed: number;
  /** Pontos criados à mão, sempre mantidos. */
  readonly manual: number;
  /**
   * O que aconteceu com a chegada.
   *
   *   `marker`     veio da única árvore da planta
   *   `manual`     o admin definiu, e a planta não muda isso
   *   `missing`    a planta não tem árvore: o admin precisa definir
   *   `ambiguous`  a planta tem mais de uma: o admin precisa escolher
   */
  readonly arrivalState: 'marker' | 'manual' | 'missing' | 'ambiguous';
}

const KIND_OF_MARKER: Record<'npc' | 'crate', PlacementKind> = { npc: 'npc', crate: 'crate' };

/**
 * Os pontos da masmorra depois de ler (ou reler) a planta.
 *
 * ####  NUNCA DUPLICA, E NUNCA PASSA POR CIMA DO ADMIN  ####
 *
 *   - o marcador cujo id já existe fica como está (nome, perfil,
 *     quantidade e até a posição que o admin ajustou);
 *   - o marcador novo entra no fim;
 *   - o ponto de marcador cujo marcador sumiu sai;
 *   - o ponto manual fica, sempre.
 *
 * A chegada manual também manda: reprocessar não a troca pela árvore.
 */
export function mergeBodyPoints(
  analysis: BodyAnalysis,
  current: { readonly points: readonly BodyPointInput[]; readonly arrival: BodyArrivalInput | null },
): BodyMergeResult {
  const found = [...analysis.markers.npc, ...analysis.markers.crate];
  const foundIds = new Set(found.map((marker) => marker.id));
  const existing = new Set(current.points.map((point) => point.id));

  let kept = 0;
  let removed = 0;
  let manual = 0;

  const points: BodyPointInput[] = [];

  for (const point of current.points) {
    if (point.source === 'manual') {
      manual += 1;
      points.push(point);
      continue;
    }

    if (foundIds.has(point.id)) {
      kept += 1;
      points.push(point);
      continue;
    }

    removed += 1;
  }

  let added = 0;
  const counter: Record<'npc' | 'crate', number> = { npc: 0, crate: 0 };

  for (const marker of found) {
    if (marker.kind === 'arrival') continue;

    counter[marker.kind] += 1;

    if (existing.has(marker.id)) continue;

    added += 1;
    points.push({
      id: marker.id,
      kind: KIND_OF_MARKER[marker.kind],
      label: `${marker.kind === 'npc' ? 'Inimigo' : 'Caixa'} ${String(counter[marker.kind])}`,
      x: marker.x,
      y: marker.y,
      z: marker.z,
      yaw: marker.yaw,
      profile: 'green',
      amount: 1,
      prefab: '',
      source: 'marker',
    });
  }

  const trees = analysis.markers.arrival;

  if (current.arrival?.source === 'manual') {
    return { points, arrival: current.arrival, added, kept, removed, manual, arrivalState: 'manual' };
  }

  const tree = trees.length === 1 ? trees[0] : undefined;

  if (tree !== undefined) {
    return {
      points,
      arrival: { x: tree.x, y: tree.y, z: tree.z, yaw: tree.yaw, source: 'marker' },
      added,
      kept,
      removed,
      manual,
      arrivalState: 'marker',
    };
  }

  return {
    points,
    arrival: null,
    added,
    kept,
    removed,
    manual,
    arrivalState: trees.length === 0 ? 'missing' : 'ambiguous',
  };
}

// ------------------------------------------------------------
//  CABE ALGUÉM AQUI?
// ------------------------------------------------------------

/** O que pode estar errado com um ponto. */
export type BodyPointProblemCode =
  | 'no_floor'
  | 'inside_floor'
  | 'inside_wall'
  | 'no_headroom'
  | 'on_prop'
  | 'unreachable'
  | 'outside';

export interface BodyPointProblem {
  /** O id do ponto, ou `arrival`. */
  readonly id: string;
  readonly code: BodyPointProblemCode;
  readonly message: string;
}

/**
 * A altura que cada coisa precisa.
 *
 * O jogador tem 1,8 m; a caixa mais alta do catálogo, uns 1,2 m (o
 * armário). Quem mediu foi o `bounds` dos prefabs no server01.
 */
const HEADROOM = { npc: 1.8, crate: 1.2, arrival: 1.8 } as const;

/** Quanto do centro o corpo ocupa, na horizontal. */
const RADIUS = { npc: 0.35, crate: 0.3, arrival: 0.4 } as const;

/** O triângulo de piso, com a base no pivô (medido: bounds z de 0 a 2,6). */
const TRIANGLE: readonly (readonly [number, number])[] = [
  [-1.5, 0],
  [1.5, 0],
  [0, 2.598],
];

/** A posição de um ponto no referencial local de uma peça. */
function toLocal(piece: BodyPiece, x: number, z: number): { lx: number; lz: number } {
  const radians = (piece.yaw * Math.PI) / 180;
  const dx = x - piece.x;
  const dz = z - piece.z;

  // O inverso de `Quaternion.Euler(0, yaw, 0)` no plano.
  return {
    lx: dx * Math.cos(radians) - dz * Math.sin(radians),
    lz: dx * Math.sin(radians) + dz * Math.cos(radians),
  };
}

function insideTriangle(lx: number, lz: number): boolean {
  const [a, b, c] = TRIANGLE;

  if (a === undefined || b === undefined || c === undefined) return false;

  const sign = (p: readonly [number, number], q: readonly [number, number]): number =>
    (lx - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (lz - q[1]);

  const d1 = sign(a, b);
  const d2 = sign(b, c);
  const d3 = sign(c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;

  return !(negative && positive);
}

function covers(piece: BodyPiece, x: number, z: number): boolean {
  const { lx, lz } = toLocal(piece, x, z);

  if (piece.shape === 'foundation' || piece.shape === 'floor') return Math.abs(lx) <= 1.5 && Math.abs(lz) <= 1.5;

  return insideTriangle(lx, lz);
}

const FLOORS: ReadonlySet<BodyPieceShape> = new Set(['foundation', 'foundation-triangle', 'floor', 'floor-triangle']);

/** A altura de cada parede, e o vão que dá para atravessar. */
const WALLS: Readonly<Partial<Record<BodyPieceShape, { height: number; gap: number; gapHeight: number }>>> = {
  wall: { height: 3, gap: 0, gapHeight: 0 },
  window: { height: 3, gap: 0, gapHeight: 0 },
  half: { height: 1.5, gap: 0, gapHeight: 0 },
  low: { height: 1, gap: 0, gapHeight: 0 },
  // O vão da porta tem pouco mais de um metro; o do quadro, quase a
  // parede inteira. Folga conservadora para não acusar à toa.
  doorway: { height: 3, gap: 0.5, gapHeight: 2.1 },
  frame: { height: 3, gap: 1.2, gapHeight: 2.6 },
};

/**
 * Onde cada ponto não cabe.
 *
 * ####  É UM AVISO, E O PLUGIN TEM A ÚLTIMA PALAVRA  ####
 *
 * Esta conta usa a forma das peças de construção, medida no jogo, e
 * nada mais: móvel, escada e telhado não entram. O plugin confere de
 * novo com a física de verdade antes de pôr cada coisa no lugar, e
 * afasta ou pula o que estiver preso (ver `ClearSpot` no .cs). A tela
 * mostra estas frases para o admin corrigir ANTES — e não salva a
 * chegada sem piso, que é a única que prenderia um jogador.
 */
export function checkBodyPoints(
  analysis: BodyAnalysis,
  points: readonly BodyPointInput[],
  arrival: BodyArrivalInput | null,
): BodyPointProblem[] {
  const problems: BodyPointProblem[] = [];

  if (analysis.pieces.length === 0) return problems;

  const floors = analysis.pieces.filter((piece) => FLOORS.has(piece.shape));
  const walls = analysis.pieces.filter((piece) => WALLS[piece.shape] !== undefined);

  const check = (id: string, what: 'npc' | 'crate' | 'arrival', x: number, y: number, z: number): void => {
    const name = what === 'arrival' ? 'A chegada' : what === 'npc' ? 'O inimigo' : 'A caixa';
    const push = (code: BodyPointProblemCode, message: string): void => {
      problems.push({ id, code, message });
    };

    const bounds = analysis.bounds;

    if (
      bounds !== null &&
      (x < bounds.min.x - 3 || x > bounds.max.x + 3 || z < bounds.min.z - 3 || z > bounds.max.z + 3 || y < bounds.min.y - 3 || y > bounds.max.y + 3)
    ) {
      push('outside', `${name} está fora da construção: nasceria no vazio, a noventa metros de profundidade.`);
      return;
    }

    // 1) Piso embaixo. O topo da fundação e o do piso ficam no pivô.
    const support = floors.some((piece) => y >= piece.y - 0.25 && y <= piece.y + 0.6 && covers(piece, x, z));

    if (!support) {
      push('no_floor', `${name} não tem piso embaixo: ajuste a altura (y) para o nível do chão, ou mova o ponto para dentro da construção.`);
      return;
    }

    // 2) Dentro de uma fundação: ela ocupa 2,8 m ABAIXO do pivô.
    const buried = floors.some(
      (piece) =>
        (piece.shape === 'foundation' || piece.shape === 'foundation-triangle') &&
        y < piece.y - 0.25 &&
        y > piece.y - 2.8 &&
        covers(piece, x, z),
    );

    if (buried) {
      push('inside_floor', `${name} está dentro de uma fundação.`);
      return;
    }

    // 3) Altura livre: nenhum piso entre o pé e a cabeça.
    const head = HEADROOM[what];
    const low = floors.some((piece) => piece.y > y + 0.3 && piece.y < y + head && covers(piece, x, z));

    if (low) {
      push('no_headroom', `${name} não tem altura: há um piso a menos de ${head.toFixed(1).replace('.', ',')} m acima.`);
      return;
    }

    // 4) Parede atravessada.
    const radius = RADIUS[what];

    for (const piece of walls) {
      const shape = WALLS[piece.shape];

      if (shape === undefined) continue;
      if (y + 0.1 >= piece.y + shape.height || y + head <= piece.y) continue;

      const { lx, lz } = toLocal(piece, x, z);

      if (Math.abs(lx) >= 0.1 + radius || Math.abs(lz) >= 1.5) continue;

      // O vão da porta deixa passar, desde que o corpo caiba nele.
      if (shape.gap > 0 && Math.abs(lz) + radius <= shape.gap + 0.15 && y + head <= piece.y + shape.gapHeight + 0.2) continue;

      push('inside_wall', `${name} está encostada numa parede (ou dentro dela): afaste o ponto uns ${(radius + 0.1).toFixed(1).replace('.', ',')} m.`);
      return;
    }

    // 5) Em cima de um móvel. A forma de cada móvel a régua não sabe;
    //    o centro dele, sabe. MEDIDO em 17/09/2026: uma lápide posta a
    //    meio metro de uma caixa grande de madeira caiu DENTRO dela, e
    //    o plugin teve de desistir do inimigo.
    const prop = analysis.props.find(
      (entry) =>
        entry.role === 'deployable' &&
        Math.hypot(entry.x - x, entry.z - z) < radius + 0.35 &&
        entry.y > y - 0.5 &&
        entry.y < y + head,
    );

    if (prop !== undefined) {
      push('on_prop', `${name} está em cima de um móvel ou enfeite: o jogo empurra até 1 m para o lado, e desiste se não houver espaço.`);
    }
  };

  for (const point of points) check(point.id, point.kind, point.x, point.y, point.z);

  if (arrival !== null) check('arrival', 'arrival', arrival.x, arrival.y, arrival.z);

  // 6) Dá para chegar lá a pé? Só para quem não tem outro problema: o
  //    ponto sem piso já foi apontado, e a régua não empilha frases.
  if (arrival !== null) {
    const reachable = reachability(analysis, arrival);
    const flagged = new Set(problems.map((problem) => problem.id));

    if (reachable !== null) {
      for (const point of points) {
        if (flagged.has(point.id)) continue;
        if (reachable(point.x, point.y, point.z) !== false) continue;

        problems.push({
          id: point.id,
          code: 'unreachable',
          message: `${point.kind === 'npc' ? 'O inimigo' : 'A caixa'} fica num cômodo que não se alcança da chegada sem atravessar parede: abra um vão ou ponha uma porta no caminho.`,
        });
      }
    }
  }

  return problems;
}

/** O passo da grade de construção do Rust. */
const TILE = 3;

/**
 * Quem se alcança a pé, a partir da chegada, no MESMO andar dela.
 *
 * Anda pelos pisos quadrados e atravessa a aresta que não tem parede —
 * ou que tem vão de porta ou de quadro (as fechaduras do arquivo não
 * sobem, então toda porta abre). Parede baixa (1 m) se pula; meia
 * parede e janela, não.
 *
 * ####  É UMA RESPOSTA DE MELHOR ESFORÇO, E DIZ QUANDO NÃO SABE  ####
 *
 * Devolve `null` — "não sei" — quando a chegada não está num piso
 * quadrado, ou quando o andar dela tem triângulo ou peça fora de
 * esquadro: a grade não os representa, e acusar à toa é pior que
 * calar. A função devolvida responde `undefined` para ponto de OUTRO
 * andar: escada e rampa não entram na conta.
 */
function reachability(
  analysis: BodyAnalysis,
  arrival: BodyArrivalInput,
): ((x: number, y: number, z: number) => boolean | undefined) | null {
  const squares = analysis.pieces.filter((piece) => piece.shape === 'foundation' || piece.shape === 'floor');
  const reference = squares.find(
    (piece) => arrival.y >= piece.y - 0.25 && arrival.y <= piece.y + 0.6 && covers(piece, arrival.x, arrival.z),
  );

  if (reference === undefined) return null;

  const level = reference.y;
  const sameLevel = (y: number): boolean => Math.abs(y - level) < 0.3;
  const aligned = (yaw: number): boolean => {
    const off = (((yaw - reference.yaw) % 90) + 90) % 90;

    return off < 2 || off > 88;
  };

  if (analysis.pieces.some((piece) => sameLevel(piece.y) && (piece.shape === 'floor-triangle' || piece.shape === 'foundation-triangle'))) {
    return null;
  }

  // A posição de uma peça em unidades de grade, no referencial da
  // chegada. `null` = fora do esquadro.
  const toGrid = (x: number, z: number): { gx: number; gz: number } => {
    const { lx, lz } = toLocal(reference, x, z);

    return { gx: lx / TILE, gz: lz / TILE };
  };
  const near = (value: number): boolean => Math.abs(value - Math.round(value)) < 0.1;
  const tileKey = (gx: number, gz: number): string => `${String(gx)},${String(gz)}`;

  const tiles = new Set<string>();

  for (const piece of squares) {
    if (!sameLevel(piece.y)) continue;
    if (!aligned(piece.yaw)) return null;

    const { gx, gz } = toGrid(piece.x, piece.z);

    if (!near(gx) || !near(gz)) return null;

    tiles.add(tileKey(Math.round(gx), Math.round(gz)));
  }

  const blocked = new Set<string>();
  const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const piece of analysis.pieces) {
    if (!sameLevel(piece.y)) continue;
    if (piece.shape === 'doorway' || piece.shape === 'frame' || piece.shape === 'low') continue;
    if (piece.shape !== 'wall' && piece.shape !== 'window' && piece.shape !== 'half') continue;
    if (!aligned(piece.yaw)) return null;

    const { gx, gz } = toGrid(piece.x, piece.z);

    // A parede mora no MEIO de uma aresta: meia unidade num eixo e
    // inteira no outro.
    if (near(gx) && Math.abs(gz - Math.round(gz)) > 0.4) {
      const x = Math.round(gx);
      blocked.add(edgeKey(tileKey(x, Math.floor(gz)), tileKey(x, Math.ceil(gz))));
    } else if (near(gz) && Math.abs(gx - Math.round(gx)) > 0.4) {
      const z = Math.round(gz);
      blocked.add(edgeKey(tileKey(Math.floor(gx), z), tileKey(Math.ceil(gx), z)));
    }
  }

  const start = tileKey(0, 0);
  const visited = new Set<string>([start]);
  const queue: [number, number][] = [[0, 0]];

  while (queue.length > 0) {
    const current = queue.pop();

    if (current === undefined) break;

    const [cx, cz] = current;
    const here = tileKey(cx, cz);

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = tileKey(cx + dx, cz + dz);

      if (visited.has(next) || !tiles.has(next) || blocked.has(edgeKey(here, next))) continue;

      visited.add(next);
      queue.push([cx + dx, cz + dz]);
    }
  }

  return (x, y, z) => {
    if (!sameLevel(y)) return undefined;

    const { gx, gz } = toGrid(x, z);
    const key = tileKey(Math.round(gx), Math.round(gz));

    return tiles.has(key) ? visited.has(key) : undefined;
  };
}
