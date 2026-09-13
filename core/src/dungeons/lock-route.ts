// ============================================================
//  lock-route.ts  -  o código nunca fica atrás da própria porta.
//
//  ####  A REGRA QUE FALTAVA, E O DEFEITO QUE ELA EVITA  ####
//
//  O construtor já se recusava a pôr o papel do código DENTRO da
//  sala que ele abre (`TakeCodeNote`, no plugin:
//  `entry.cells.Contains(cell)`). Isso resolve o caso óbvio e
//  deixa passar o caso que acontece:
//
//         sala VERMELHA        o código dela cai aqui…
//              ║  (trancada)
//         sala AZUL            …e para chegar aqui é preciso abrir
//              ║  (trancada)   a azul…
//          entrada             …cujo código caiu na vermelha.
//
//  Nenhuma das duas fechaduras tem o papel dentro de si mesma, e as
//  duas salas ficam lacradas para sempre. O servidor constrói, a
//  contagem de peças fecha, o evento sobe — e o jogador dá voltas
//  procurando um papel que não existe do lado de fora.
//
//  Pedido do dono em 13/09/2026: *"quando uma porta estiver
//  trancada, o código necessário não pode nascer dentro da sala
//  protegida por ela. O sistema deve validar a rota antes de
//  construir a Dungeon."*
//
//  ####  A RÉGUA É "ZONA PÚBLICA", E ISSO É UMA ESCOLHA  ####
//
//  O portador tem de nascer numa célula que se alcança da entrada
//  SEM abrir porta trancada nenhuma — nem a da sala dele, nem a de
//  outra. É mais severo que a letra do pedido ("acessível antes da
//  porta"), e é de propósito, por dois motivos.
//
//  O primeiro é mecânico: a alternativa é a CADEIA — o código da
//  vermelha pode morar na azul, desde que o da azul esteja na zona
//  pública. Ela funciona, e exige que o construtor ordene as
//  fechaduras na hora de distribuir os papéis, sabendo de antemão
//  onde cada peça vai nascer. Ele não sabe: as peças nascem em
//  ordem sorteada, e o papel vai para a primeira que aparece.
//
//  O segundo é de jogo: o jogador não vê a cadeia. Ele vê duas
//  portas com código e procura os papéis. "Todo papel está na parte
//  aberta" se explica numa linha; "o papel da vermelha está dentro
//  da azul" é uma caça ao tesouro que ninguém desenhou, e que fica
//  indistinguível de um defeito.
//
//  ####  E A MESMA CONTA RODA NO PLUGIN  ####
//
//  O `PublicCells` do `OrigemZDungeon.cs` é este BFS, escrito
//  igual. Duas contas diferentes para a mesma pergunta é como a
//  tela passa a prometer o que o jogo não faz — e é o erro que a
//  seta da entrada já cometeu uma vez neste projeto.
//
//  ####  SÓ NO MODO PLANTA  ####
//
//  No modo receita o traçado é sorteado DENTRO do servidor, a cada
//  nascimento: não existe desenho para conferir aqui. Lá quem
//  decide é o `SettleLocks`, com a mesma regra e no lugar onde ela
//  pode ser respondida.
// ============================================================

import {
  findRooms,
  key,
  NEIGHBOURS,
  readCells,
  type Cell,
  type LayoutRoomColor,
} from './layout.js';

/** O que a régua da rota precisa saber da masmorra. */
export interface LockRouteSpec {
  readonly lock: {
    readonly enabled: boolean;
    readonly carrier: 'npc' | 'crate' | 'none';
    readonly carrierScope: 'corridor' | 'anywhere';
  };
  /** Quantos inimigos e caixas o corredor sorteia, em porcento. */
  readonly corridor: { readonly npcDensity: number; readonly lootDensity: number };
  /** As cores, com o que cada uma tem dentro. */
  readonly rooms: readonly {
    readonly color: LayoutRoomColor;
    readonly locked: boolean;
    readonly npc: { readonly max: number };
    readonly loot: { readonly max: number };
  }[];
  /** Os marcadores do desenho, em coordenadas de ENTRADA. */
  readonly placements: readonly {
    readonly kind: 'npc' | 'crate';
    readonly x: number;
    readonly z: number;
  }[];
}

export interface LockRouteFacts {
  /** As frases para o admin. Vazio = a rota fecha. */
  readonly problems: readonly string[];
  /** Quantas manchas de sala estão trancadas neste desenho. */
  readonly lockedRooms: number;
  /**
   * Quantas células da zona pública podem receber o portador.
   *
   * Zero com sala trancada é o defeito. O número serve à frase da
   * tela: "7 lugares podem carregar o código" diz ao admin que ele
   * tem margem; "0" diz o que consertar.
   */
  readonly carrierCells: number;
}

export function checkLockRoute(grid: readonly string[], spec: LockRouteSpec): LockRouteFacts {
  const problems: string[] = [];
  const cells = readCells(grid);
  const rooms = findRooms(cells);

  const lockedColors = new Set(spec.rooms.filter((room) => room.locked).map((room) => room.color));

  // As manchas trancadas. A cor é do DESENHO, e a régua de "esta cor
  // tranca" vem das `rooms` — as duas juntas dizem quais células o
  // jogador não atravessa de mãos vazias.
  const lockedRoomIndexes = new Set<number>();

  for (const [id, index] of rooms) {
    const cell = cells.get(id);

    if (cell !== undefined && lockedColors.has(cell.color)) lockedRoomIndexes.add(index);
  }

  if (!spec.lock.enabled || lockedRoomIndexes.size === 0 || spec.lock.carrier === 'none') {
    // Sem fechadura não há rota a validar. `carrier: 'none'` com sala
    // trancada já é recusado pelo schema, com a frase dele — repetir
    // aqui daria dois avisos para o mesmo defeito.
    return { problems, lockedRooms: lockedRoomIndexes.size, carrierCells: 0 };
  }

  const entrance = [...cells.values()].find((cell) => cell.kind === 'entrance');

  if (entrance === undefined) {
    // O `checkLayout` já reclama da falta de entrada, com a frase
    // própria — e sem ela não há de onde partir o BFS.
    return { problems, lockedRooms: lockedRoomIndexes.size, carrierCells: 0 };
  }

  const publicCells = reachableFromEntrance(cells, rooms, lockedRoomIndexes, entrance);

  // ####  ONDE O PORTADOR PODE NASCER  ####
  //
  // Não basta a célula ser pública: tem de haver a PEÇA do tipo
  // certo nascendo nela. O construtor entrega o papel de dentro do
  // `SpawnNpc` e do `SpawnContainer` — com `carrier: 'npc'` e um
  // corredor sem inimigo, não há em quem pôr o papel.
  const marked = new Set(
    spec.placements
      .filter((mark) => mark.kind === spec.lock.carrier)
      .map((mark) => key(mark.x + entrance.x, mark.z + entrance.z)),
  );

  const wantsNpc = spec.lock.carrier === 'npc';
  const corridorDensity = wantsNpc ? spec.corridor.npcDensity : spec.corridor.lootDensity;

  let carrierCells = 0;

  for (const id of publicCells) {
    const cell = cells.get(id);

    if (cell === undefined || cell.kind === 'entrance') continue;

    const index = rooms.get(id);
    const inCorridor = index === undefined;

    // `carrierScope: 'corridor'` é o padrão, e ele prende o papel ao
    // caminho: o guarda do corredor tem a chave da sala.
    if (spec.lock.carrierScope === 'corridor' && !inCorridor) continue;

    // Um marcador é uma peça CERTA naquela célula — ele vale mais
    // que qualquer densidade, e é o que faz "o guarda do código
    // nasce aqui" ser escrevível.
    if (marked.has(id)) {
      carrierCells += 1;
      continue;
    }

    if (inCorridor) {
      if (corridorDensity > 0) carrierCells += 1;
      continue;
    }

    const room = spec.rooms.find((candidate) => candidate.color === cell.color);
    const max = wantsNpc ? (room?.npc.max ?? 0) : (room?.loot.max ?? 0);

    if (max > 0) carrierCells += 1;
  }

  if (carrierCells === 0) {
    const what = wantsNpc ? 'um inimigo' : 'uma caixa';
    const where =
      spec.lock.carrierScope === 'corridor'
        ? 'no corredor que se alcança sem abrir porta trancada'
        : 'fora das salas trancadas';
    const fix =
      spec.lock.carrierScope === 'corridor'
        ? 'Suba a densidade do corredor, marque uma posição no desenho ou deixe o portador nascer em qualquer lugar.'
        : 'Marque uma posição no desenho, ou deixe alguma sala aberta com conteúdo.';

    problems.push(
      `O código não teria onde nascer: não há ${what} ${where}. ` +
        `Quem fosse buscá-lo precisaria abrir a porta que ele mesmo destranca. ${fix}`,
    );
  }

  return { problems, lockedRooms: lockedRoomIndexes.size, carrierCells };
}

/**
 * As células que o jogador alcança de mãos vazias.
 *
 * BFS da entrada atravessando tudo MENOS célula de sala trancada —
 * ela é a parede, e é justamente o que o papel do código precisa
 * estar deste lado.
 */
function reachableFromEntrance(
  cells: ReadonlyMap<string, Cell>,
  rooms: ReadonlyMap<string, number>,
  lockedRoomIndexes: ReadonlySet<number>,
  entrance: Cell,
): Set<string> {
  const reached = new Set<string>([key(entrance.x, entrance.z)]);
  const queue: Cell[] = [entrance];

  while (queue.length > 0) {
    const current = queue.pop();

    if (current === undefined) break;

    for (const [dx, dz] of NEIGHBOURS) {
      const id = key(current.x + dx, current.z + dz);
      const neighbour = cells.get(id);

      if (neighbour === undefined || reached.has(id)) continue;

      const index = rooms.get(id);

      if (index !== undefined && lockedRoomIndexes.has(index)) continue;

      reached.add(id);
      queue.push(neighbour);
    }
  }

  return reached;
}
