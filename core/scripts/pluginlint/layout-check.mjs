// ============================================================
//  layout-check.mjs  -  a masmorra faz sentido?
//
//  Porta o `BuildLayout` do `Plugins/OrigemZDungeon.cs` e roda o
//  sorteio N vezes, cobrando as quatro invariantes de que o
//  construtor depende:
//
//    1. a célula (0,0) existe e é corredor  — é onde o alçapão cospe
//    2. toda sala tem ao menos uma porta    — sala trancada é sala perdida
//    3. o corredor é conectado à entrada    — senão metade fica ilhada
//    4. toda porta dá num corredor alcançável
//
//  Uso:  node core/scripts/pluginlint/layout-check.mjs [seeds]
//
//  ####  ELE EXISTE PORQUE O ERRO É INVISÍVEL DO OUTRO LADO  ####
//
//  Uma sala sem porta não dá erro nenhum: ela nasce, fica bonita, e
//  ninguém entra. Descobrir isso exige um cliente de Rust aberto e
//  alguém andando por 78 células. Aqui sai em ASCII, em 200 sorteios,
//  em dois segundos.
//
//  ####  ELE É PROVISÓRIO  ####
//
//  Na frente B este código vira `core/src/dungeons/blueprint.ts`, com
//  teste de verdade — é o mesmo `Layout` que o editor de planta do
//  painel vai usar para pré-visualizar uma receita sem ir ao jogo
//  (ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §14). Até lá, esta
//  cópia é o que impede a geometria de regredir sem ninguém notar.
//
//  MANTER EM SINCRONIA COM O .cs À MÃO. As duas pontas são compiladas
//  separadamente e nada as amarra além deste comentário.
// ============================================================

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const SHAPES = [[1, 2], [2, 2], [3, 1], [3, 2], [3, 3]];

const key = (x, z) => `${x},${z}`;
const isEntrance = (x, z) => x === 0 && (z === 0 || z === 1);

function rng(seed) {
  let s = seed >>> 0;
  return {
    next(n) { s = (s * 1664525 + 1013904223) >>> 0; return n ? s % n : s; },
  };
}

function buildLayout(targetRooms, r) {
  const cells = new Set();
  const owner = new Map();
  const doors = [];
  const corridor = [];

  let x = 0, z = 0, dir = 0, stepsLeft = 8 + r.next(9);
  const wanted = targetRooms * 3 + 6;

  let guard = 0;
  while (cells.size < wanted && guard++ < 100000) {
    if (stepsLeft <= 0) {
      stepsLeft = 8 + r.next(9);
      dir = (dir + (r.next(2) === 0 ? 1 : 3)) % 4;
    }
    const side = (dir + 1) % 4;
    const a = [x, z];
    const b = [x + DIRS[side][0], z + DIRS[side][1]];
    corridor.push([a, b]);
    for (const c of [a, b]) {
      if (!cells.has(key(...c))) { cells.add(key(...c)); owner.set(key(...c), -1); }
    }
    stepsLeft--;
    x += DIRS[dir][0];
    z += DIRS[dir][1];
  }

  let nextRoom = 0;
  for (let pass = 0; pass < 4 && nextRoom < targetRooms; pass++) {
    const free = [...cells].filter((c) => owner.get(c) < 0).sort(() => r.next(3) - 1);

    for (const cc of free) {
      if (nextRoom >= targetRooms) break;
      const [cx, cz] = cc.split(',').map(Number);
      if (isEntrance(cx, cz)) continue;

      for (let side = 0; side < 4 && nextRoom < targetRooms; side++) {
        const anchor = [cx + DIRS[side][0], cz + DIRS[side][1]];
        if (cells.has(key(...anchor))) continue;
        if (tryPlaceRoom(cells, owner, anchor, side, nextRoom, r)) {
          doors.push({ room: anchor, corridor: [cx, cz] });
          nextRoom++;
        }
      }
    }
  }

  return { cells, owner, doors, corridor, rooms: nextRoom };
}

function tryPlaceRoom(cells, owner, anchor, side, roomId, r) {
  for (const shape of [...SHAPES].sort(() => r.next(3) - 1)) {
    let width, depth, ox, oz;
    if (side <= 1) {
      width = shape[0]; depth = shape[1];
      const off = r.next(shape[0]);
      ox = anchor[0] - off;
      oz = side === 0 ? anchor[1] : anchor[1] - depth + 1;
    } else {
      width = shape[1]; depth = shape[0];
      const off = r.next(shape[0]);
      ox = side === 2 ? anchor[0] : anchor[0] - width + 1;
      oz = anchor[1] - off;
    }

    let fits = true;
    for (let dx = 0; dx < width && fits; dx++)
      for (let dz = 0; dz < depth && fits; dz++)
        if (cells.has(key(ox + dx, oz + dz))) fits = false;
    if (!fits) continue;

    for (let dx = 0; dx < width; dx++)
      for (let dz = 0; dz < depth; dz++) {
        cells.add(key(ox + dx, oz + dz));
        owner.set(key(ox + dx, oz + dz), roomId);
      }
    return true;
  }
  return false;
}

// ---- as invariantes que o plugin depende ----

function check(layout) {
  const problems = [];
  const { cells, owner, doors } = layout;

  if (!cells.has('0,0')) problems.push('a entrada (0,0) não existe');
  if (owner.get('0,0') !== -1) problems.push('a entrada (0,0) foi engolida por uma sala');

  // Toda sala tem ao menos uma porta.
  const withDoor = new Set(doors.map((d) => owner.get(key(...d.room))));
  const allRooms = new Set([...owner.values()].filter((o) => o >= 0));
  for (const room of allRooms) if (!withDoor.has(room)) problems.push(`sala ${room} sem porta`);

  // O corredor é conectado, e a entrada faz parte dele.
  const corridorCells = [...cells].filter((c) => owner.get(c) === -1);
  const seen = new Set(['0,0']);
  const queue = ['0,0'];
  while (queue.length) {
    const [cx, cz] = queue.pop().split(',').map(Number);
    for (const [dx, dz] of DIRS) {
      const n = key(cx + dx, cz + dz);
      if (seen.has(n) || owner.get(n) !== -1) continue;
      seen.add(n); queue.push(n);
    }
  }
  const orphans = corridorCells.length - seen.size;
  if (orphans > 0) problems.push(`${orphans} célula(s) de corredor não chegam na entrada`);

  // Toda sala é alcançável: a porta dela dá num corredor conectado.
  for (const d of doors) {
    if (!seen.has(key(...d.corridor)))
      problems.push(`a porta da sala em ${d.room} dá num corredor ilhado`);
  }

  return problems;
}

function draw(layout) {
  const coords = [...layout.cells].map((c) => c.split(',').map(Number));
  const minX = Math.min(...coords.map((c) => c[0]));
  const maxX = Math.max(...coords.map((c) => c[0]));
  const minZ = Math.min(...coords.map((c) => c[1]));
  const maxZ = Math.max(...coords.map((c) => c[1]));

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const lines = [];
  for (let z = maxZ; z >= minZ; z--) {
    let line = '';
    for (let x = minX; x <= maxX; x++) {
      const o = layout.owner.get(key(x, z));
      if (o === undefined) line += ' .';
      else if (x === 0 && z === 0) line += ' E';
      else if (o === -1) line += ' #';
      else line += ' ' + (letters[o] ?? '?');
    }
    lines.push(line);
  }
  return { text: lines.join('\n'), size: `${maxX - minX + 1} x ${maxZ - minZ + 1}` };
}

// ---- roda ----

let failures = 0;
const seeds = Number(process.argv[2] ?? 200);

for (let seed = 1; seed <= seeds; seed++) {
  const layout = buildLayout(12, rng(seed));
  const problems = check(layout);
  if (problems.length) {
    failures++;
    if (failures <= 3) {
      const d = draw(layout);
      console.log(`\n### seed ${seed} — ${layout.cells.size} células, ${layout.rooms} salas, ${d.size}`);
      console.log(d.text);
      console.log('  problemas: ' + problems.join(' | '));
    }
  }
}

const ok = buildLayout(12, rng(7));
const drawn = draw(ok);
console.log(`\n### exemplo (seed 7) — ${ok.cells.size} células, ${ok.rooms} salas, ${drawn.size}`);
console.log(drawn.text);

console.log(`\n${seeds - failures}/${seeds} layouts íntegros; ${failures} com problema.`);
