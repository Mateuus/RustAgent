// ============================================================
//  Os campos das três frentes, do schema até o comando de RCON.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Um campo de configuração só está pronto quando percorreu cinco
//  degraus: o schema Zod, a coluna, o repositório, o `sync` e a
//  tela. Parar no QUARTO é o pior resultado possível — o admin
//  configura, salva, a tela mostra o valor de volta, e o jogo
//  ignora sem uma linha de aviso.
//
//  Os testes abaixo percorrem os degraus 1 a 4 de uma vez: gravam
//  uma masmorra com TODO campo novo preenchido, leem de volta e
//  conferem que cada um deles atravessou o base64 do comando.
//
//  E medem o payload, porque o teto de 50 KB do WebRCON é real:
//  um estado que estoura não falha alto, ele é RECUSADO e o plugin
//  fica com o cache velho.
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { BlueprintMaterializer } from '../src/dungeons/materializer.js';
import { DungeonSync } from '../src/dungeons/sync.js';
import { DUNGEON_SYNC_MAX_BYTES } from '../src/game/dungeon-contract.js';
import { dungeonInputSchema, FACTORY_RECIPES } from '../src/types/dungeons.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

/**
 * Uma masmorra com TODO campo das três frentes fora do padrão.
 *
 * Nenhum valor aqui é o padrão do schema, de propósito: um campo
 * que o repositório esquecer de gravar volta como o padrão, e um
 * teste montado com padrões não notaria a diferença.
 */
const FULL = dungeonInputSchema.parse({
  id: 'completa',
  name: 'A masmorra com tudo',
  mode: 'recipe',
  corridor: {
    npcDensity: 35,
    lootDensity: 15,
    table: {
      mode: 'add',
      rolls: { min: 2, max: 4 },
      entries: [{ shortname: 'scrap', amount: { min: 10, max: 50 }, weight: 40 }],
    },
    ai: { chaseRadius: 12, returnHome: false },
  },
  npc: {
    weapons: ['rifle.ak'],
    loot: {
      mode: 'replace',
      rolls: { min: 1, max: 1 },
      entries: [
        { shortname: 'cloth', amount: { min: 5, max: 5 }, guaranteed: true, condition: 0.5 },
      ],
    },
    ai: { visionRadius: 30, fireRange: 22, alertOnSpot: false, senseInterval: 0.8 },
  },
  structure: { foundation: 'metal', wall: 'toptier', ceiling: 'metal' },
  lock: {
    enabled: true,
    sharedCode: true,
    carrier: 'crate',
    carrierScope: 'anywhere',
    onUndelivered: 'keep',
    noteTitle: 'O papel amassado',
    announceOpen: false,
    warnOnWrongCode: false,
  },
  respawn: { enabled: true, minutes: 45, onlyWhenEmpty: false, rebuildDestroyed: false },
  rooms: [
    {
      key: 'red',
      color: 'red',
      npc: { min: 3, max: 5 },
      loot: { min: 2, max: 3 },
      door: 'garage',
      locked: true,
      wideDoor: 'double_toptier',
      wideDoorCellsPerDoor: 6,
      grade: { foundation: 'stone', wall: 'stone', ceiling: 'stone' },
      table: {
        mode: 'replace',
        rolls: { min: 3, max: 3 },
        entries: [
          { shortname: 'rifle.ak', amount: { min: 1, max: 1 }, blueprint: true, skin: 12_345 },
        ],
      },
      ai: { aimConeScale: 0.7, fireInterval: 0.2, holdPosition: true },
    },
  ],
});

interface Captured {
  readonly sync: DungeonSync;
  readonly dungeons: DungeonsRepository;
  /** O último comando que o RCON falso recebeu. */
  readonly sent: string[];
}

function harness(): Captured {
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

  const dungeons = new DungeonsRepository(db, silent);
  const events = new WorldEventsRepository(db, silent);
  const sent: string[] = [];

  const sync = new DungeonSync({
    dungeons,
    events,
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
    // `dataDirOf` nulo faz o materializador não escrever nada: o
    // que este teste mede é o COMANDO, não o disco.
    materializer: new BlueprintMaterializer({
      blueprints: new DungeonBlueprintsRepository(db, silent),
      servers: { ids: () => [SERVER], dataDirOf: () => null },
      logger: silent,
    }),
    logger: silent,
  });

  return { sync, dungeons, sent };
}

/** O JSON que viajou dentro do `origemz.dungeon.sync <base64>`. */
function decode(command: string): { dungeons: Record<string, unknown>[] } {
  const payload = command.slice(command.indexOf(' ') + 1);

  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
    dungeons: Record<string, unknown>[];
  };
}

describe('os campos das três frentes atravessam o banco', () => {
  it('nada se perde entre a escrita e a leitura', () => {
    const { dungeons } = harness();

    const saved = dungeons.save(FULL);

    // A comparação é do objeto inteiro, e não campo a campo: um
    // campo novo que alguém acrescentar ao schema e esquecer no
    // INSERT falha aqui sem ninguém precisar lembrar de testá-lo.
    expect(saved.structure).toEqual(FULL.structure);
    expect(saved.lock).toEqual(FULL.lock);
    expect(saved.respawn).toEqual(FULL.respawn);
    expect(saved.corridor).toEqual(FULL.corridor);
    expect(saved.npc).toEqual(FULL.npc);
    expect(saved.rooms).toEqual(FULL.rooms);
  });

  it('o bloco de IA guarda só o que foi dito — ausente não vira zero', () => {
    const { dungeons } = harness();

    const saved = dungeons.save(FULL);
    const room = saved.rooms[0];

    if (room === undefined) throw new Error('a sala sumiu');

    // A sala falou de três campos. Os outros dezesseis NÃO podem
    // voltar como 0: é o que faz a herança campo a campo existir.
    expect(Object.keys(room.ai).sort()).toEqual(['aimConeScale', 'fireInterval', 'holdPosition']);
    expect(room.ai.visionRadius).toBeUndefined();
  });
});

describe('os campos das três frentes atravessam o sync', () => {
  it('cada um deles chega ao comando de RCON', async () => {
    const { sync, dungeons, sent } = harness();

    dungeons.save(FULL);

    expect(await sync.push(SERVER, 'teste')).toBe(true);

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    const dungeon = decode(command).dungeons[0];

    if (dungeon === undefined) throw new Error('a masmorra não viajou');

    expect(dungeon.structure).toEqual(FULL.structure);
    expect(dungeon.lock).toEqual(FULL.lock);
    expect(dungeon.respawn).toEqual(FULL.respawn);

    const corridor = dungeon.corridor as Record<string, unknown>;
    const npc = dungeon.npc as Record<string, unknown>;
    const rooms = dungeon.rooms as Record<string, unknown>[];
    const room = rooms[0];

    if (room === undefined) throw new Error('a sala não viajou');

    // A linha da tabela viaja SEM o que já é o padrão do plugin —
    // `weight` 10, `skin` 0, `blueprint`/`guaranteed` falsos e
    // `condition` 0. São ~55 bytes por linha, e é o que faz caber
    // sete masmorras em vez de cinco.
    expect(corridor.table).toEqual({
      mode: 'add',
      rolls: { min: 2, max: 4 },
      entries: [{ shortname: 'scrap', amount: { min: 10, max: 50 }, weight: 40 }],
    });
    expect(corridor.ai).toEqual(FULL.corridor.ai);

    expect(npc.loot).toEqual({
      mode: 'replace',
      rolls: { min: 1, max: 1 },
      entries: [
        { shortname: 'cloth', amount: { min: 5, max: 5 }, guaranteed: true, condition: 0.5 },
      ],
    });
    expect(npc.ai).toEqual(FULL.npc.ai);

    expect(room.door).toBe('garage');
    expect(room.wideDoor).toBe('double_toptier');
    expect(room.wideDoorCellsPerDoor).toBe(6);
    expect(room.grade).toEqual(FULL.rooms[0]?.grade);
    expect(room.ai).toEqual(FULL.rooms[0]?.ai);

    // A linha da tabela guarda só o que não é padrão — mas o que
    // NÃO é padrão tem de estar lá inteiro.
    expect(room.table).toEqual({
      mode: 'replace',
      rolls: { min: 3, max: 3 },
      entries: [
        { shortname: 'rifle.ak', amount: { min: 1, max: 1 }, blueprint: true, skin: 12_345 },
      ],
    });
  });

  it('o que está no padrão do plugin NÃO viaja', async () => {
    // ####  É ISTO QUE PAGA O TETO DE 50 KB  ####
    //
    // Uma receita de fábrica não mexeu em nada das três frentes.
    // Se ela mandasse `structure`, `lock`, três tabelas vazias e
    // cinco blocos de IA vazios, seriam ~400 bytes por masmorra
    // gastos para dizer "faça o que você já faria".
    const { sync, dungeons, sent } = harness();

    const factory = FACTORY_RECIPES[0];

    if (factory === undefined) throw new Error('sem receita de fábrica');

    dungeons.save(factory);

    await sync.push(SERVER, 'teste');

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    const dungeon = decode(command).dungeons[0];

    if (dungeon === undefined) throw new Error('a masmorra não viajou');

    expect(dungeon.structure).toBeUndefined();
    expect(dungeon.lock).toBeUndefined();
    expect((dungeon.npc as Record<string, unknown>).ai).toBeUndefined();
    expect((dungeon.npc as Record<string, unknown>).loot).toBeUndefined();
    expect((dungeon.corridor as Record<string, unknown>).table).toBeUndefined();

    const room = (dungeon.rooms as Record<string, unknown>[])[0];

    if (room === undefined) throw new Error('a sala não viajou');

    expect(room.table).toBeUndefined();
    expect(room.ai).toBeUndefined();
    expect(room.grade).toBeUndefined();
    expect(room.wideDoor).toBeUndefined();
    expect(room.wideDoorCellsPerDoor).toBeUndefined();

    // O respawn é a EXCEÇÃO, e ela é de propósito: ausente e
    // `enabled: false` não são a mesma coisa no plugin — ausente
    // deixa o refresh do prefab de pé, e a caixa se repõe sozinha.
    expect(dungeon.respawn).toEqual({ enabled: false });
  });

  it('as quatro receitas de fábrica cabem folgadas no comando', async () => {
    const { sync, dungeons, sent } = harness();

    for (const recipe of FACTORY_RECIPES) dungeons.save(recipe);

    await sync.push(SERVER, 'teste');

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    expect(command.length).toBeLessThan(DUNGEON_SYNC_MAX_BYTES);
  });
});
