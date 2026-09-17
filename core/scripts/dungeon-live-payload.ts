// ============================================================
//  dungeon-live-payload.ts  -  o comando de sync para o teste ao vivo.
//
//  Monta, num banco EM MEMÓRIA, duas masmorras de teste com os
//  recursos de 17/09/2026 (corpo importado, skins, anúncio com
//  visual) e imprime o `origemz.dungeon.sync <base64>` que o agente
//  mandaria. Não toca no banco de desenvolvimento.
//
//  Também grava a construção de exemplo no disco do plugin, com o
//  nome `ozteste-corpo.json`.
//
//  ####  A CONSTRUÇÃO DE EXEMPLO É MONTADA, NÃO EXPORTADA  ####
//
//  Os campos são os de uma exportação real do CopyPaste (os mesmos
//  das plantas herdadas: `pos` em texto, `rot` em radianos, `items`,
//  `children` com `parentbone`), e os prefabs foram medidos no jogo.
//  Ainda assim, ela não saiu do CopyPaste: a primeira exportação feita
//  no jogo com os três marcadores precisa ser conferida do mesmo jeito.
//
//  uso: npx tsx scripts/dungeon-live-payload.ts <pasta de dados do plugin> <arquivo de saída> [exportação real]
//
//  Com o terceiro argumento, o corpo é uma exportação REAL do CopyPaste
//  (gravada como `ozteste-real.json`) em vez da construção montada.
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pino } from 'pino';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { analyzeBody, checkBodyPoints, mergeBodyPoints } from '../src/dungeons/body.js';
import { BlueprintMaterializer } from '../src/dungeons/materializer.js';
import { DungeonSync } from '../src/dungeons/sync.js';
import { FACTORY_LAYOUTS } from '../src/types/dungeon-layouts.js';
import { dungeonInputSchema } from '../src/types/dungeons.js';

const [dataDir, outFile, realFile] = process.argv.slice(2);

if (dataDir === undefined || outFile === undefined) {
  console.error('uso: tsx scripts/dungeon-live-payload.ts <pasta de dados do plugin> <arquivo de saída>');
  process.exit(1);
}

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const RAD = Math.PI / 180;

const vec = (x: number, y: number, z: number): Record<string, string> => ({
  x: x.toFixed(6),
  y: y.toFixed(6),
  z: z.toFixed(6),
});
const rot = (yaw: number): Record<string, string> => vec(0, yaw * RAD, 0);
const core = (name: string): string => `assets/prefabs/building core/${name}/${name}.prefab`;

// Dois cômodos de 3×2 células, com uma parede de vão no meio.
const entities: Record<string, unknown>[] = [];
const cells: [number, number][] = [];

for (let i = 0; i < 3; i += 1) for (let j = 0; j < 2; j += 1) cells.push([i, j]);

const has = (i: number, j: number): boolean => cells.some(([a, b]) => a === i && b === j);

for (const [i, j] of cells) {
  const x = i * 3;
  const z = j * 3;

  entities.push({ prefabname: core('foundation'), pos: vec(x, 0, z), rot: rot(0), grade: 2, skinid: 0, flags: {} });
  entities.push({ prefabname: core('floor'), pos: vec(x, 3, z), rot: rot(0), grade: 2, skinid: 10223, flags: {} });

  // As paredes do contorno: +x/-x ficam em yaw 0 (comprimento em z),
  // +z/-z em yaw 90 (comprimento em x). Medido nos `bounds` do jogo.
  if (!has(i + 1, j)) entities.push({ prefabname: core('wall'), pos: vec(x + 1.5, 0, z), rot: rot(0), grade: 2, skinid: 10223 });
  if (!has(i - 1, j)) entities.push({ prefabname: core('wall'), pos: vec(x - 1.5, 0, z), rot: rot(180), grade: 2, skinid: 10223 });
  if (!has(i, j + 1)) entities.push({ prefabname: core('wall'), pos: vec(x, 0, z + 1.5), rot: rot(270), grade: 3, skinid: 10221, customColour: 4 });
  if (!has(i, j - 1)) entities.push({ prefabname: core('wall'), pos: vec(x, 0, z - 1.5), rot: rot(90), grade: 3, skinid: 10221, customColour: 4 });
}

// A divisória entre a coluna 0 e a 1: um vão com porta (e fechadura,
// que tem de ficar de fora) e uma parede cheia.
entities.push({
  prefabname: core('wall.doorway'),
  pos: vec(1.5, 0, 0),
  rot: rot(0),
  grade: 2,
  skinid: 0,
  children: [
    {
      prefabname: 'assets/prefabs/building/door.hinged/door.hinged.metal.prefab',
      pos: vec(0, 0, 0),
      rot: rot(0),
      skinid: 0,
      children: [
        {
          prefabname: 'assets/prefabs/locks/keypad/lock.code.prefab',
          parentbone: 'lock',
          pos: vec(0, 0, 0),
          rot: rot(0),
          code: '1234',
          flags: { Locked: true },
        },
      ],
    },
  ],
});
entities.push({ prefabname: core('wall'), pos: vec(1.5, 0, 3), rot: rot(0), grade: 2, skinid: 0 });

// Os marcadores.
const tree = 'assets/prefabs/misc/xmas/xmastree/xmas_tree.deployed.prefab';
const grave = 'assets/prefabs/misc/halloween/deployablegravestone/gravestone.stone.deployed.prefab';
const candles = 'assets/prefabs/misc/halloween/candles/largecandleset.prefab';

entities.push({ prefabname: tree, pos: vec(0, 0, 0), rot: rot(90), items: [{ id: -1667224349, amount: 1, position: 0 }] });
entities.push({ prefabname: grave, pos: vec(6, 0, 3.4), rot: rot(180) });
entities.push({ prefabname: grave, pos: vec(3.2, 0, 3.6), rot: rot(200) });
entities.push({ prefabname: candles, pos: vec(6.2, 0, -0.6), rot: rot(0) });
entities.push({ prefabname: candles, pos: vec(0.4, 0, 3.8), rot: rot(45) });

// O que tem de ficar de fora.
entities.push({ prefabname: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab', pos: vec(4.5, 0, 1.5), rot: rot(0) });
entities.push({ prefabname: 'assets/bundled/prefabs/radtown/crate_elite.prefab', pos: vec(7, 0, 0.8), rot: rot(0) });
entities.push({ prefabname: 'assets/prefabs/deployable/landmine/landmine.prefab', pos: vec(3, 0, -0.2), rot: rot(0) });
entities.push({
  prefabname: 'assets/prefabs/deployable/large wood storage/box.wooden.large.prefab',
  pos: vec(3.6, 0, 3.9),
  rot: rot(0),
  items: [{ id: -1812555177, amount: 1, position: 0 }],
});

const bodyId = realFile === undefined ? 'ozteste-corpo' : 'ozteste-real';
const blueprintJson =
  realFile === undefined
    ? JSON.stringify(
        { default: { position: vec(0, 0, 0), rotationy: '0', rotationdiff: '0' }, entities, protocol: { items: 2, version: { Major: 4, Minor: 2, Patch: 0 } } },
        null,
        2,
      )
    : readFileSync(realFile, 'utf8');
const bodyEntities = (JSON.parse(blueprintJson) as { entities: Record<string, unknown>[] }).entities;

writeFileSync(join(dataDir, `${bodyId}.json`), blueprintJson, 'utf8');

const db = openDatabase({ file: MEMORY_DATABASE });

runMigrations(db);

new ServersRepository(db).create({
  id: SERVER,
  name: 'Dev',
  identity: SERVER,
  gamePort: 28_015,
  rconPort: 28_016,
  queryPort: 28_017,
  appPort: 28_082,
  installDir: 'F:\\Servers\\devserver',
});

const blueprints = new DungeonBlueprintsRepository(db, silent);
const saved = blueprints.save({ id: bodyId, name: 'Teste de corpo', kind: 'base', content: blueprintJson, origin: 'import' });

if (!saved.ok) throw new Error(`a planta de teste foi recusada: ${saved.problem}`);

const analysis = analyzeBody(bodyEntities);
const merged = mergeBodyPoints(analysis, { points: [], arrival: null });

// Perfis diferentes para provar que cada ponto lê o cadastro certo.
const points = merged.points.map((point, index) =>
  point.kind === 'npc'
    ? { ...point, profile: index === 0 ? ('red' as const) : ('corridor' as const), amount: index === 0 ? 2 : 1 }
    : { ...point, profile: index === 2 ? ('red' as const) : ('green' as const) },
);

console.error(
  JSON.stringify({
    markers: {
      npc: analysis.markers.npc.length,
      crate: analysis.markers.crate.length,
      arrival: analysis.markers.arrival.length,
    },
    roles: analysis.roles,
    warnings: analysis.warnings,
    arrivalState: merged.arrivalState,
    problems: checkBodyPoints(analysis, points, merged.arrival),
  }),
);

const dungeons = new DungeonsRepository(db, silent);

dungeons.save(
  dungeonInputSchema.parse({
    id: 'ozteste-corpo',
    name: 'Cripta de Teste',
    mode: 'construction',
    entranceBlueprint: null,
    body: { blueprint: bodyId, arrival: merged.arrival, points },
    announce: {
      tag: '[MASMORRA]',
      tagColor: '#C43F2C',
      color: '#ffffff',
      size: 16,
      onBuild: 'A [vermelho]{nome}[/] abriu em {grid}!',
      onEnd: 'A {nome} fechou.',
    },
    npc: { health: { min: 50, max: 60 }, names: ['Guarda de Teste'] },
    corridor: { crates: ['assets/bundled/prefabs/radtown/crate_basic.prefab'] },
    rooms: [
      { key: 'green', color: 'green', crates: ['assets/bundled/prefabs/radtown/crate_normal_2.prefab'] },
      { key: 'red', color: 'red', crates: ['assets/bundled/prefabs/radtown/crate_elite.prefab'] },
    ],
  }),
);

const corredor = FACTORY_LAYOUTS.find((layout) => layout.id === 'corredor-reto');

dungeons.save(
  dungeonInputSchema.parse({
    id: 'ozteste-skins',
    name: 'Skins de Teste',
    mode: 'blueprint',
    grid: corredor?.grid,
    structure: { foundation: 'stone', wall: 'stone', ceiling: 'stone', foundationSkin: 10220, wallSkin: 10223, ceilingSkin: 10225 },
    corridor: { grade: { foundation: 'wood', wall: 'wood', ceiling: 'wood', wallSkin: 10232 } },
    rooms: [
      { key: 'red', color: 'red', grade: { foundation: 'metal', wall: 'metal', ceiling: 'metal', wallSkin: 10221 } },
      { key: 'green', color: 'green', grade: { foundation: 'toptier', wall: 'toptier', ceiling: 'toptier', wallSkin: 10430 } },
    ],
  }),
);

const sent: string[] = [];
const sync = new DungeonSync({
  dungeons,
  events: new WorldEventsRepository(db, silent),
  servers: {
    ids: () => [SERVER],
    contextOf: () => ({
      rcon: {
        isConnected: true,
        send: async (command: string) => {
          sent.push(command);
          return Promise.resolve('');
        },
      },
    }),
  },
  materializer: new BlueprintMaterializer({
    blueprints,
    servers: { ids: () => [SERVER], dataDirOf: () => null },
    logger: silent,
  }),
  logger: silent,
});

await sync.push(SERVER, 'teste-ao-vivo');

const command = sent[0];

if (command === undefined) throw new Error('o sync não mandou nada');

writeFileSync(outFile, command, 'utf8');
console.error(`comando: ${String(command.length)} bytes`);
