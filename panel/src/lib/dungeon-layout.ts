// ============================================================
//  dungeon-layout.ts  -  a masmorra, antes de ela existir.
//
//  ####  ELE É O `BuildLayout` DO PLUGIN, PORTADO  ####
//
//  O mesmo corredor que serpenteia em segmentos de 8 a 16 passos,
//  as mesmas salas penduradas nas laterais livres, as mesmas cinco
//  formas de retângulo. Não é uma aproximação para enfeitar a
//  tela: é o algoritmo que vai rodar no servidor.
//
//  A consequência é o que dá valor à tela: o admin mexe no peso da
//  sala vermelha e vê A MASMORRA mudar — não um número mudar.
//
//  ####  AS DUAS PONTAS SÃO COMPILADAS SEPARADAMENTE  ####
//
//  Nada amarra este arquivo ao `Plugins/OrigemZDungeon.cs` além
//  deste comentário. Mudar o sorteio lá exige mudar aqui, ou a
//  prévia passa a mentir — e mentir com precisão é pior que não
//  mostrar nada.
//
//  O rascunho verificado vive em
//  `core/scripts/pluginlint/layout-check.mjs`, que roda 300
//  sorteios cobrando as quatro invariantes: entrada livre, toda
//  sala com porta, corredor conectado, toda porta alcançável.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §11.0 e §14.4.
// ============================================================

/** Leste, norte, oeste, sul — nesta ordem, como no plugin. */
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * As formas de sala, em células.
 *
 * Só retângulos: a regra "a parede morre entre duas células da
 * mesma sala" produz geometria válida só para eles. Uma sala em L
 * nasceria com uma parede solta no meio.
 */
const SHAPES: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 2],
  [3, 1],
  [3, 2],
  [3, 3],
];

export type CellKind = 'empty' | 'corridor' | 'entrance' | 'room';

export interface PreviewCell {
  readonly x: number;
  readonly z: number;
  readonly kind: CellKind;
  /** `-1` para corredor; o número da sala quando `kind === 'room'`. */
  readonly room: number;
}

export interface DungeonPreview {
  readonly cells: readonly PreviewCell[];
  readonly rooms: number;
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
  /** Quantas células o corredor ocupa. */
  readonly corridorCells: number;
}

/**
 * Um sorteio reproduzível.
 *
 * ####  POR QUE NÃO `Math.random()`  ####
 *
 * A prévia precisa ficar PARADA enquanto o admin arrasta um
 * controle. Com `Math.random()`, cada tecla redesenharia uma
 * masmorra diferente — e a tela viraria um caleidoscópio em vez de
 * uma ferramenta. A semente só muda quando ele pede outra.
 *
 * É o mesmo gerador linear congruente do rascunho, e o mesmo que o
 * modo permanente vai precisar para reconstruir igual (§9.3).
 */
function makeRng(seed: number): { next: (bound?: number) => number } {
  let state = seed >>> 0;

  return {
    next(bound?: number): number {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;

      return bound === undefined || bound <= 0 ? state : state % bound;
    },
  };
}

const key = (x: number, z: number): string => `${String(x)},${String(z)}`;

/** A (0,0) e a (0,1): a chegada do alçapão. Sala ali taparia a entrada. */
const isEntranceCell = (x: number, z: number): boolean => x === 0 && (z === 0 || z === 1);

/**
 * Sorteia uma masmorra com aquele número de salas.
 *
 * O `targetRooms` é o que o painel calcula do intervalo da receita
 * — a mesma conta que o plugin faz antes de chamar o construtor.
 */
export function previewLayout(targetRooms: number, seed: number): DungeonPreview {
  const rng = makeRng(seed);
  const cells = new Set<string>();
  const owner = new Map<string, number>();

  let x = 0;
  let z = 0;
  let dir = 0;
  let stepsLeft = 8 + rng.next(9);

  // Três células de corredor por sala é a proporção do plugin: ela
  // dá salas com espaço para nascer nos dois lados sem se
  // atropelarem.
  const wanted = Math.max(6, targetRooms * 3 + 6);

  // O teto de voltas não é zelo: uma mudança no sorteio que nunca
  // atingisse `wanted` travaria a aba inteira do navegador.
  let guard = 0;

  while (cells.size < wanted && guard < 100_000) {
    guard += 1;

    if (stepsLeft <= 0) {
      stepsLeft = 8 + rng.next(9);
      dir = (dir + (rng.next(2) === 0 ? 1 : 3)) % 4;
    }

    // O par: a célula e a vizinha à esquerda. O corredor tem DOIS
    // de largura — um de uma célula vira um cano claustrofóbico em
    // que dois jogadores não se cruzam.
    const side = (dir + 1) % 4;
    const a: [number, number] = [x, z];
    const b: [number, number] = [x + (DIRS[side]?.[0] ?? 0), z + (DIRS[side]?.[1] ?? 0)];

    for (const cell of [a, b]) {
      const id = key(cell[0], cell[1]);

      if (!cells.has(id)) {
        cells.add(id);
        owner.set(id, -1);
      }
    }

    stepsLeft -= 1;
    x += DIRS[dir]?.[0] ?? 0;
    z += DIRS[dir]?.[1] ?? 0;
  }

  // As salas, penduradas nas laterais livres. Quatro passadas: a
  // primeira pega os lugares fáceis, as seguintes aproveitam o que
  // sobrou entre elas.
  let nextRoom = 0;

  for (let pass = 0; pass < 4 && nextRoom < targetRooms; pass += 1) {
    const free = [...cells]
      .filter((id) => owner.get(id) === -1)
      .sort(() => rng.next(3) - 1);

    for (const id of free) {
      if (nextRoom >= targetRooms) break;

      const [cx, cz] = id.split(',').map(Number) as [number, number];

      if (isEntranceCell(cx, cz)) continue;

      for (let side = 0; side < 4 && nextRoom < targetRooms; side += 1) {
        const anchor: [number, number] = [cx + (DIRS[side]?.[0] ?? 0), cz + (DIRS[side]?.[1] ?? 0)];

        if (cells.has(key(anchor[0], anchor[1]))) continue;
        if (tryPlaceRoom(cells, owner, anchor, side, nextRoom, rng)) nextRoom += 1;
      }
    }
  }

  const list: PreviewCell[] = [];
  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;
  let corridorCells = 0;

  for (const id of cells) {
    const [cx, cz] = id.split(',').map(Number) as [number, number];
    const room = owner.get(id) ?? -1;

    if (room < 0) corridorCells += 1;

    list.push({
      x: cx,
      z: cz,
      kind: isEntranceCell(cx, cz) && room < 0 ? 'entrance' : room < 0 ? 'corridor' : 'room',
      room,
    });

    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minZ = Math.min(minZ, cz);
    maxZ = Math.max(maxZ, cz);
  }

  return {
    cells: list,
    rooms: nextRoom,
    bounds: { minX, maxX, minZ, maxZ },
    corridorCells,
  };
}

function tryPlaceRoom(
  cells: Set<string>,
  owner: Map<string, number>,
  anchor: readonly [number, number],
  side: number,
  roomId: number,
  rng: { next: (bound?: number) => number },
): boolean {
  for (const shape of [...SHAPES].sort(() => rng.next(3) - 1)) {
    let width: number;
    let depth: number;
    let originX: number;
    let originZ: number;

    // Sala que sai pelo lado leste/oeste nasce deitada; pelo
    // norte/sul, em pé. Sem isso, metade delas cresceria para
    // dentro do corredor.
    if (side <= 1) {
      width = shape[0];
      depth = shape[1];
      const offset = rng.next(shape[0]);
      originX = anchor[0] - offset;
      originZ = side === 0 ? anchor[1] : anchor[1] - depth + 1;
    } else {
      width = shape[1];
      depth = shape[0];
      const offset = rng.next(shape[0]);
      originX = side === 2 ? anchor[0] : anchor[0] - width + 1;
      originZ = anchor[1] - offset;
    }

    let fits = true;

    for (let dx = 0; dx < width && fits; dx += 1) {
      for (let dz = 0; dz < depth && fits; dz += 1) {
        if (cells.has(key(originX + dx, originZ + dz))) fits = false;
      }
    }

    if (!fits) continue;

    for (let dx = 0; dx < width; dx += 1) {
      for (let dz = 0; dz < depth; dz += 1) {
        const id = key(originX + dx, originZ + dz);
        cells.add(id);
        owner.set(id, roomId);
      }
    }

    return true;
  }

  return false;
}

/**
 * O mesmo objeto, mas lido de um desenho em vez de sorteado.
 *
 * ####  POR QUE ELE EXISTE  ####
 *
 * No modo planta, a prévia ao lado dos controles PRECISA mostrar o
 * que o admin desenhou — e não uma masmorra sorteada. A primeira
 * versão sorteava nos dois modos, e a tela ficava dizendo "13
 * salas" ao lado de um desenho com quatro.
 *
 * Devolvendo o mesmo `DungeonPreview`, tudo que vem depois — o
 * SVG, a estimativa, a barra de proporção — continua funcionando
 * sem saber de onde veio a masmorra.
 */
export function previewFromGrid(rows: readonly string[]): DungeonPreview {
  const cells: PreviewCell[] = [];
  const roomIds = new Map<string, number>();
  let corridorCells = 0;

  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;
  let first = true;

  rows.forEach((row, index) => {
    // As linhas vêm do maior z para o menor: a primeira é a de
    // cima, como num mapa com o norte para cima.
    const z = rows.length - 1 - index;

    [...row].forEach((char, x) => {
      if (char === '.' || char === ' ') return;

      const kind: CellKind = char === 'E' ? 'entrance' : char === '#' ? 'corridor' : 'room';

      let room = -1;

      if (kind === 'room') {
        // A letra é a COR (G/B/R), e a prévia colore por ela: o
        // desenho na tela tem de mostrar as mesmas três cores que o
        // admin pintou, e não uma paleta de sala numerada.
        const known = roomIds.get(char);

        if (known === undefined) {
          room = roomIds.size;
          roomIds.set(char, room);
        } else {
          room = known;
        }
      } else {
        corridorCells += 1;
      }

      cells.push({ x, z, kind, room });

      if (first) {
        minX = maxX = x;
        minZ = maxZ = z;
        first = false;
      } else {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    });
  });

  return {
    cells,
    rooms: roomIds.size,
    bounds: { minX, maxX, minZ, maxZ },
    corridorCells,
  };
}

// ------------------------------------------------------------
//  A TRADUÇÃO DOS NÚMEROS
// ------------------------------------------------------------

export interface RecipeEstimate {
  readonly rooms: number;
  readonly cells: number;
  /** Fundação + paredes + teto. É o que pesa no servidor. */
  readonly blocks: number;
  readonly byColor: { readonly green: number; readonly blue: number; readonly red: number };
  readonly npcs: number;
  readonly crates: number;
  /** Minutos para um grupo de três limpar. */
  readonly minutes: number;
}

/**
 * O que aqueles números produzem, em português.
 *
 * ####  ESTA FUNÇÃO É O CORAÇÃO DA TELA  ####
 *
 * Sem ela, "peso vermelho: 15" é um número sem tradução, e
 * balancear vira tentativa e erro de wipe em wipe. O concorrente
 * vende exatamente esta função como diferencial, e o editor de
 * loot deste projeto já aprendeu a lição.
 *
 * As contas são estimativas HONESTAS e estão documentadas uma a
 * uma: preferir um número redondo e explicado a um número preciso
 * e mágico.
 */
export function estimateRecipe(input: {
  readonly preview: DungeonPreview;
  readonly weights: { readonly green: number; readonly blue: number; readonly red: number };
  readonly rooms: readonly {
    readonly key: string;
    readonly npc: { readonly min: number; readonly max: number };
    readonly loot: { readonly min: number; readonly max: number };
  }[];
  readonly corridor: { readonly npcDensity: number; readonly lootDensity: number };
}): RecipeEstimate {
  const total = input.weights.green + input.weights.blue + input.weights.red;
  const rooms = input.preview.rooms;

  const byColor =
    total === 0
      ? { green: rooms, blue: 0, red: 0 }
      : {
          green: Math.round((rooms * input.weights.green) / total),
          blue: Math.round((rooms * input.weights.blue) / total),
          red: Math.round((rooms * input.weights.red) / total),
        };

  const cells = input.preview.cells.length;

  // Uma fundação e um teto por célula, mais ~1,7 paredes: é a
  // média medida no `layout-check`, porque a parede entre duas
  // células da mesma sala não nasce.
  const blocks = Math.round(cells * 3.7);

  const perColor = (name: string) => input.rooms.find((room) => room.key === name);
  const mid = (range?: { min: number; max: number }) =>
    range === undefined ? 0 : (range.min + range.max) / 2;

  const roomNpcs =
    byColor.green * mid(perColor('green')?.npc) +
    byColor.blue * mid(perColor('blue')?.npc) +
    byColor.red * mid(perColor('red')?.npc);

  const roomCrates =
    byColor.green * mid(perColor('green')?.loot) +
    byColor.blue * mid(perColor('blue')?.loot) +
    byColor.red * mid(perColor('red')?.loot);

  // A densidade do corredor é "de cada 100 células, quantas ganham
  // uma". O plugin sorteia por célula, então a média é direta.
  const corridorNpcs = (input.preview.corridorCells * input.corridor.npcDensity) / 100;
  const corridorCrates = (input.preview.corridorCells * input.corridor.lootDensity) / 100;

  const npcs = Math.round(roomNpcs + corridorNpcs);
  const crates = Math.round(roomCrates + corridorCrates);

  // ~40 s por sala e ~12 s por NPC, para um grupo de três. É um
  // palpite grosso, e está escrito na tela como "≈" justamente por
  // isso: ele serve para comparar duas receitas, não para prometer
  // um cronômetro.
  const minutes = Math.max(1, Math.round((rooms * 40 + npcs * 12) / 60));

  return { rooms, cells, blocks, byColor, npcs, crates, minutes };
}
