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


// ------------------------------------------------------------
//  O TRAÇADO DESENHADO, E O QUE ESTÁ ERRADO NELE
//
//  ####  ISTO É O `core/src/dungeons/layout.ts`, PORTADO  ####
//
//  As mesmas contagens e os mesmos cinco defeitos, sobre o mesmo
//  formato de linhas. Duas pontas compiladas separadamente, como
//  o `previewLayout` acima e o `BuildLayout` do plugin.
//
//  A duplicação paga por si: o admin vê o defeito ENQUANTO
//  desenha, e não depois de salvar. E o agente cobra as mesmas
//  regras no que chega por API e por captura in-game, onde não
//  existe editor nenhum para avisar.
//
//  MUDAR UMA REGRA AQUI EXIGE MUDAR LÁ JUNTO.
// ------------------------------------------------------------

/** A cor de uma sala. Espelha `ROOM_COLORS` de `types/dungeons.ts`. */
export type LayoutRoomColor = 'green' | 'blue' | 'red';

/** A letra de cada cor no formato salvo. */
const COLOR_OF_CHAR: Readonly<Record<string, LayoutRoomColor>> = {
  G: 'green',
  B: 'blue',
  R: 'red',
};

/** Os quatro vizinhos. Diagonal não conta: parede não nasce em diagonal. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** O que uma célula é. */
type GridCellKind = 'corridor' | 'entrance' | 'room';

interface GridCell {
  readonly x: number;
  readonly z: number;
  readonly kind: GridCellKind;
  /** Só faz sentido quando `kind === 'room'`. */
  readonly color: LayoutRoomColor;
}

/** O que `analyzeLayout` conta. É o que vira coluna no banco. */
export interface LayoutFacts {
  /** Toda célula que não é vazio — corredor, entrada e salas. */
  readonly cellCount: number;
  /** Manchas contíguas da mesma cor. Ver `findRooms`. */
  readonly roomCount: number;
  readonly byColor: Readonly<Record<LayoutRoomColor, number>>;
  readonly corridorCells: number;
  /** Sem isto o jogador não tem por onde chegar. */
  readonly hasEntrance: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * Lê as linhas para um mapa de células.
 *
 * A primeira linha é a de MAIOR z — o norte em cima, como um mapa
 * é lido. Inverter isso espelha a masmorra na vertical, e tudo
 * parece certo até alguém comparar o desenho com o jogo.
 */
function readCells(grid: readonly string[]): Map<string, GridCell> {
  const cells = new Map<string, GridCell>();

  grid.forEach((row, index) => {
    const z = grid.length - 1 - index;

    [...row].forEach((char, x) => {
      if (char === '.' || char === ' ') return;

      const kind: GridCellKind = char === 'E' ? 'entrance' : char === '#' ? 'corridor' : 'room';

      // Uma letra desconhecida (um traçado de antes de a letra
      // guardar a cor) cai em verde — o mesmo que o editor faz ao
      // reabrir um desenho antigo.
      cells.set(key(x, z), { x, z, kind, color: COLOR_OF_CHAR[char] ?? 'green' });
    });
  });

  return cells;
}

/**
 * Cada mancha contígua da mesma cor é uma sala.
 *
 * É o que separa "duas salas vermelhas" de "uma sala vermelha
 * grande" sem ninguém precisar nomear cômodo — a mesma regra do
 * editor, e a mesma que o construtor aplica.
 *
 * Devolve, para cada célula de sala, o índice da sala dela.
 */
function findRooms(cells: ReadonlyMap<string, GridCell>): Map<string, number> {
  const room = new Map<string, number>();
  let next = 0;

  for (const [id, cell] of cells) {
    if (cell.kind !== 'room' || room.has(id)) continue;

    const index = next;
    next += 1;

    const queue: GridCell[] = [cell];
    room.set(id, index);

    while (queue.length > 0) {
      const current = queue.pop();

      if (current === undefined) break;

      for (const [dx, dz] of NEIGHBOURS) {
        const neighbourId = key(current.x + dx, current.z + dz);
        const neighbour = cells.get(neighbourId);

        if (neighbour === undefined || room.has(neighbourId)) continue;
        if (neighbour.kind !== 'room' || neighbour.color !== current.color) continue;

        room.set(neighbourId, index);
        queue.push(neighbour);
      }
    }
  }

  return room;
}

/**
 * O que o traçado tem dentro.
 *
 * Roda uma vez, na escrita, e o resultado vira coluna: a lista do
 * painel não pode varrer o desenho de cada linha para dizer
 * "9 salas".
 */
export function analyzeLayout(grid: readonly string[]): LayoutFacts {
  const cells = readCells(grid);
  const rooms = findRooms(cells);

  const byColor: Record<LayoutRoomColor, number> = { green: 0, blue: 0, red: 0 };
  const colorOfRoom = new Map<number, LayoutRoomColor>();

  let corridorCells = 0;
  let hasEntrance = false;

  for (const [id, cell] of cells) {
    if (cell.kind === 'corridor') corridorCells += 1;
    if (cell.kind === 'entrance') hasEntrance = true;

    const index = rooms.get(id);

    if (index !== undefined) colorOfRoom.set(index, cell.color);
  }

  // Contar por SALA, e não por célula: uma sala vermelha de nove
  // células é uma sala vermelha, e contá-la nove vezes faria a
  // mistura de cores parecer o que ela não é.
  for (const color of colorOfRoom.values()) byColor[color] += 1;

  return {
    cellCount: cells.size,
    roomCount: colorOfRoom.size,
    byColor,
    corridorCells,
    hasEntrance,
    width: Math.max(0, ...grid.map((row) => row.length)),
    height: grid.length,
  };
}

/**
 * O que está errado no desenho, em português.
 *
 * ####  NENHUM DESTES DÁ ERRO NO JOGO  ####
 *
 * É a razão de esta função existir. Ver o cabeçalho: o servidor
 * constrói o que foi mandado, e o defeito só aparece com um
 * jogador lá dentro.
 *
 * As frases são as que o admin lê. Elas dizem o QUE está errado e
 * o que fazer — "3 células soltas" sem o "elas viram blocos
 * flutuando" não ensina nada a quem nunca viu acontecer.
 */
export function checkLayout(grid: readonly string[]): string[] {
  const problems: string[] = [];
  const cells = readCells(grid);
  const rooms = findRooms(cells);

  const entrances = [...cells.values()].filter((cell) => cell.kind === 'entrance');

  // 0. Sem entrada não há masmorra: o alçapão não teria onde
  //    cuspir o jogador. O editor do painel garante isso sozinho
  //    (a entrada é fixa), mas um desenho que chega por API não.
  if (entrances.length === 0) {
    problems.push(
      'O desenho não tem entrada (E): é nela que o alçapão cospe o jogador, e sem ela ninguém chega.',
    );
  } else if (entrances.length > 1) {
    problems.push(
      `O desenho tem ${String(entrances.length)} entradas: o alçapão cospe em uma só, e as outras viram cômodos sem porta.`,
    );
  }

  // 1. Toda sala precisa encostar num corredor — é ali que a porta
  //    nasce. Sem isso, o cômodo fica lacrado.
  const touching = new Set<number>();

  for (const [id, index] of rooms) {
    const cell = cells.get(id);

    if (cell === undefined) continue;

    for (const [dx, dz] of NEIGHBOURS) {
      const neighbour = cells.get(key(cell.x + dx, cell.z + dz));

      if (neighbour?.kind === 'corridor' || neighbour?.kind === 'entrance') touching.add(index);
    }
  }

  const sealed = [...new Set(rooms.values())].filter((index) => !touching.has(index));

  if (sealed.length > 0) {
    problems.push(
      sealed.length === 1
        ? 'Uma sala não encosta em nenhum corredor: ninguém consegue entrar nela.'
        : `${String(sealed.length)} salas não encostam em corredor nenhum: ninguém consegue entrar nelas.`,
    );
  }

  // 2. A entrada precisa encostar em corredor: sozinha, o jogador
  //    desce para dentro de um quadrado fechado e o evento acaba
  //    ali.
  for (const entrance of entrances) {
    const connected = NEIGHBOURS.some(([dx, dz]) => {
      const neighbour = cells.get(key(entrance.x + dx, entrance.z + dz));

      return neighbour !== undefined && neighbour.kind !== 'room';
    });

    if (!connected) {
      problems.push(
        'A entrada não encosta em nenhum corredor: o jogador desceria para dentro de um quadrado fechado.',
      );
      break;
    }
  }

  // 3. O corredor precisa ser um só e chegar à entrada. Um pedaço
  //    solto é uma parte da masmorra que nunca será visitada.
  const start = entrances[0];

  if (start !== undefined) {
    const reachable = new Set<string>([key(start.x, start.z)]);
    const queue: GridCell[] = [start];

    while (queue.length > 0) {
      const current = queue.pop();

      if (current === undefined) break;

      for (const [dx, dz] of NEIGHBOURS) {
        const id = key(current.x + dx, current.z + dz);
        const neighbour = cells.get(id);

        if (neighbour === undefined || reachable.has(id)) continue;
        if (neighbour.kind === 'room') continue;

        reachable.add(id);
        queue.push(neighbour);
      }
    }

    const orphans = [...cells.values()].filter(
      (cell) => cell.kind === 'corridor' && !reachable.has(key(cell.x, cell.z)),
    ).length;

    if (orphans > 0) {
      problems.push(
        `${String(orphans)} célula(s) de corredor não chegam na entrada: essa parte fica ilhada.`,
      );
    }
  }

  // 4. Uma sala de UMA célula com corredor em três lados nasce
  //    quase sem parede: o construtor abre uma porta em cada lado
  //    que toca o corredor, e três portas num cômodo de 3×3 metros
  //    é um cômodo sem parede.
  const size = new Map<number, number>();

  for (const index of rooms.values()) size.set(index, (size.get(index) ?? 0) + 1);

  let openRooms = 0;

  for (const [id, index] of rooms) {
    if ((size.get(index) ?? 0) > 1) continue;

    const cell = cells.get(id);

    if (cell === undefined) continue;

    const sides = NEIGHBOURS.filter(([dx, dz]) => {
      const neighbour = cells.get(key(cell.x + dx, cell.z + dz));

      return neighbour?.kind === 'corridor' || neighbour?.kind === 'entrance';
    }).length;

    if (sides >= 3) openRooms += 1;
  }

  if (openRooms > 0) {
    problems.push(
      `${String(openRooms)} sala(s) de uma célula têm corredor em três lados: elas nascem quase sem parede. Aumente-as, ou afaste o corredor.`,
    );
  }

  // 5. Célula sem vizinho nenhum: um bloco flutuando no meio do
  //    nada, que o jogador vê de longe e nunca alcança.
  const floating = [...cells.values()].filter(
    (cell) => !NEIGHBOURS.some(([dx, dz]) => cells.has(key(cell.x + dx, cell.z + dz))),
  ).length;

  if (floating > 0) {
    problems.push(
      `${String(floating)} célula(s) estão soltas, sem encostar em nada: elas viram blocos flutuando no meio do nada.`,
    );
  }

  return problems;
}

// ------------------------------------------------------------
//  A PORTA DA SALA GRANDE
//
//  ####  A CONTA É CÉLULAS ÷ PORTAS, E NÃO CÉLULAS  ####
//
//  Um salão de nove células com quatro entradas não afunila
//  ninguém — quatro grupos entram por quatro lados. O funil é nove
//  células com UMA entrada.
//
//  É a mesma conta do `WideDoorThresholdOf` do plugin, portada
//  para a tela poder dizer "com este limite, 4 das 13 salas do
//  traçado ao lado nasceriam com a folha larga" — em vez de
//  deixar o admin escolher um número e descobrir no jogo que ele
//  nunca é atingido.
//
//  MUDAR A REGRA AQUI EXIGE MUDAR NO PLUGIN JUNTO.
// ------------------------------------------------------------

export interface WideDoorStats {
  /** Quantas salas o traçado tem. */
  readonly rooms: number;
  /** Quantas delas passariam do limite. */
  readonly wide: number;
}

/**
 * Quantas salas do traçado receberiam a folha larga.
 *
 * Só serve no modo RECEITA: no modo planta o `room` da prévia é o
 * índice da COR, e não o da sala — todas as vermelhas seriam
 * contadas como um cômodo só.
 */
export function wideDoorStats(preview: DungeonPreview, cellsPerDoor: number): WideDoorStats {
  const cells = new Map<string, PreviewCell>();

  for (const cell of preview.cells) cells.set(key(cell.x, cell.z), cell);

  const size = new Map<number, number>();
  const doors = new Map<number, number>();

  for (const cell of preview.cells) {
    if (cell.kind !== 'room') continue;

    size.set(cell.room, (size.get(cell.room) ?? 0) + 1);

    // Uma porta nasce onde a sala encosta no corredor — e uma
    // célula com corredor em dois lados abre DUAS.
    const sides = NEIGHBOURS.filter(([dx, dz]) => {
      const neighbour = cells.get(key(cell.x + dx, cell.z + dz));

      return neighbour?.kind === 'corridor' || neighbour?.kind === 'entrance';
    }).length;

    if (sides > 0) doors.set(cell.room, (doors.get(cell.room) ?? 0) + sides);
  }

  let wide = 0;

  for (const [room, count] of size) {
    // Sala sem porta nenhuma é um defeito do traçado, e não uma
    // sala larga: dividir por zero aqui a marcaria como a maior de
    // todas.
    const openings = Math.max(1, doors.get(room) ?? 0);

    if (count / openings >= cellsPerDoor) wide += 1;
  }

  return { rooms: size.size, wide };
}
