// ============================================================
//  layout.ts  -  o traçado desenhado, do lado do agente.
//
//  Um traçado é o DESENHO de uma masmorra: uma linha de texto por
//  fileira de células, do maior z para o menor — o norte em cima,
//  como num mapa. Um caractere por célula:
//
//      .  vazio      #  corredor
//      E  a entrada  G/B/R  sala verde, azul, vermelha
//
//  ####  NÃO CONFUNDIR COM `blueprint.ts`  ####
//
//  Aquele lê o JSON do CopyPaste: uma construção literal, peça por
//  peça, com posição e rotação. Este lê um esquema de células, que
//  é o que o construtor recebe para MONTAR as peças.
//
//  São dois acervos e dois formatos, e misturá-los faria o
//  materializador escrever um desenho no disco como se fosse uma
//  planta de colar.
//
//  ####  E É AQUI QUE OS DEFEITOS SÃO COBRADOS  ####
//
//  Os cinco defeitos de `checkLayout` SOBEM NORMALMENTE no jogo: o
//  servidor constrói o que foi mandado e não reclama de nada. Uma
//  entrada ilhada só aparece quando um jogador desce o alçapão e
//  cai dentro de um quadrado fechado — com a casinha de pé, o
//  evento no ar e todo mundo olhando.
//
//  O painel cobra as mesmas regras enquanto o admin desenha
//  (`dungeon-grid-editor.tsx`), e essa duplicação é deliberada:
//  são duas pontas compiladas separadamente, e o desenho também
//  entra por API e por captura in-game, onde não existe editor
//  nenhum para avisar.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §4.2 e §11.0.
// ============================================================

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
type CellKind = 'corridor' | 'entrance' | 'room';

interface Cell {
  readonly x: number;
  readonly z: number;
  readonly kind: CellKind;
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

const key = (x: number, z: number): string => `${String(x)},${String(z)}`;

/**
 * Lê as linhas para um mapa de células.
 *
 * A primeira linha é a de MAIOR z — o norte em cima, como um mapa
 * é lido. Inverter isso espelha a masmorra na vertical, e tudo
 * parece certo até alguém comparar o desenho com o jogo.
 */
function readCells(grid: readonly string[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();

  grid.forEach((row, index) => {
    const z = grid.length - 1 - index;

    [...row].forEach((char, x) => {
      if (char === '.' || char === ' ') return;

      const kind: CellKind = char === 'E' ? 'entrance' : char === '#' ? 'corridor' : 'room';

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
function findRooms(cells: ReadonlyMap<string, Cell>): Map<string, number> {
  const room = new Map<string, number>();
  let next = 0;

  for (const [id, cell] of cells) {
    if (cell.kind !== 'room' || room.has(id)) continue;

    const index = next;
    next += 1;

    const queue: Cell[] = [cell];
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
    const queue: Cell[] = [start];

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
