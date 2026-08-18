// ============================================================
//  spawn-status.test.ts  -  com que vida, fome e sede o jogador
//  acorda, e o que chega ao jogo.
//
//  O que este arquivo guarda:
//
//    1. o payload é o ESTADO COMPLETO: apagar o status faz o grupo
//       sumir do JSON empurrado — é assim que "voltei ao padrão do
//       Rust" chega ao jogo;
//    2. o apelido do nível viaja junto com o nome do grupo, e o
//       `default` vira `normal`, porque quem consome (o
//       OrigemZPlayer) pergunta por NÍVEL;
//    3. status DESLIGADO não vai, e continua guardado;
//    4. atributo nulo é OMITIDO do JSON — nunca vira 0. Zero de
//       fome é nascer morrendo, e o plugin distingue os dois casos
//       (`float?` no `SpawnStatusPayload`);
//    5. linha com os três nulos não entra no payload: ela não tem
//       nada a aplicar.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { SpawnStatusRepository } from '../src/db/spawn-status-repository.js';
import { decodePushPayload } from '../src/game/plugin-push.js';
import { SpawnStatusSync, type SpawnStatusEntry } from '../src/loadouts/status.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';

const LEVELS = [
  { Tier: 'bronze', Grupo: 'origemz.vip.bronze', Rank: 10, GrupoPai: '' },
  { Tier: 'gold', Grupo: 'origemz.vip.gold', Rank: 30, GrupoPai: 'origemz.vip.bronze' },
];

interface StatusPayload {
  readonly tiers: Record<string, SpawnStatusEntry>;
}

interface FakeServer {
  readonly commands: string[];
  lastPayload: StatusPayload | null;
  connected: boolean;
}

let tempRoot: string;

function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      const sync = /^origemz\.status\.sync (\S+)$/.exec(command);

      if (sync === null) {
        return Promise.resolve('');
      }

      server.lastPayload = decodePushPayload(sync[1] ?? '') as StatusPayload;

      return Promise.resolve(
        JSON.stringify({ ok: true, tiers: Object.keys(server.lastPayload.tiers).length }),
      );
    },
  };
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: SpawnStatusRepository;
  readonly sync: SpawnStatusSync;
  readonly server: FakeServer;
}

let harness: Harness;

/** Os atributos do payload daquela chave, ou `undefined`. */
function tierOf(name: string): SpawnStatusEntry | undefined {
  return harness.server.lastPayload?.tiers[name];
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rustagent-status-'));

  const configDir = join(tempRoot, 'oxide', 'config');

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'OrigemZVip.json'), JSON.stringify({ Niveis: LEVELS }), 'utf8');

  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'pvp1',
    identity: 'pvp1',
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const server: FakeServer = { commands: [], lastPayload: null, connected: true };
  const repository = new SpawnStatusRepository(db);

  harness = {
    db,
    repository,
    server,
    sync: new SpawnStatusSync({
      repository,
      servers: {
        ids: () => ['pvp1'],
        contextOf: () => ({ rcon: fakeRcon(server) }),
        configOf: () => ({ paths: { oxideConfigDir: configDir } }),
      },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('o payload é o estado COMPLETO', () => {
  it('apagar o status faz o grupo sumir do JSON empurrado', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      health: 100,
      calories: 500,
      hydration: 250,
      enabled: true,
      updatedBy: 'admin',
    });

    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.bronze',
      health: 100,
      calories: null,
      hydration: null,
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    // O nome do grupo E o apelido do nível: quem consome pergunta
    // por nível, e quem administra procura pelo grupo.
    expect(Object.keys(harness.server.lastPayload?.tiers ?? {}).sort()).toEqual([
      'bronze',
      'gold',
      'origemz.vip.bronze',
      'origemz.vip.gold',
    ]);

    expect(harness.repository.remove('pvp1', 'origemz.vip.gold')).toBe(true);

    await harness.sync.push('pvp1', 'teste');

    // Sumiu pelas duas chaves. É isso que faz o plugin trocar o
    // cache inteiro e o nível voltar ao padrão do Rust.
    expect(Object.keys(harness.server.lastPayload?.tiers ?? {}).sort()).toEqual([
      'bronze',
      'origemz.vip.bronze',
    ]);
  });

  it('e um status DESLIGADO não vai, mas continua guardado', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      health: 150,
      calories: null,
      hydration: null,
      enabled: false,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    expect(harness.server.lastPayload?.tiers).toEqual({});
    expect(harness.repository.get('pvp1', 'origemz.vip.gold')?.health).toBe(150);
  });
});

describe('o apelido do nível', () => {
  it('o `default` vira `normal`, que é como o jogo chama quem não é VIP', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'default',
      health: 100,
      calories: 500,
      hydration: 250,
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    expect(Object.keys(harness.server.lastPayload?.tiers ?? {}).sort()).toEqual([
      'default',
      'normal',
    ]);
  });
});

describe('null é "o jogo decide", e não zero', () => {
  it('o atributo vazio é OMITIDO do JSON', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      health: 100,
      calories: null,
      hydration: 62.5,
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    const gold = tierOf('gold');

    expect(gold).toEqual({ health: 100, hydration: 62.5 });

    // O que importa aqui: `calories` não virou 0. Zero de fome é
    // nascer morrendo, e é o que o jogador veria se este teste
    // deixasse de valer.
    expect(gold !== undefined && 'calories' in gold).toBe(false);
  });

  it('e o grupo com os três vazios não entra no payload', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      health: null,
      calories: null,
      hydration: null,
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    // Ela não tem nada a aplicar: mandá-la só faria o plugin
    // descartar a entrada e o número do cache não bater com o
    // enviado.
    expect(harness.server.lastPayload?.tiers).toEqual({});
  });
});

describe('o servidor fora do ar', () => {
  it('não impede gravar, e o desfecho diz por que não chegou', async () => {
    harness.server.connected = false;

    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      health: 100,
      calories: null,
      hydration: null,
      enabled: true,
      updatedBy: 'admin',
    });

    const result = await harness.sync.push('pvp1', 'teste');

    expect(result.skipped).not.toBeNull();
    expect(harness.server.commands).toHaveLength(0);
    // A configuração ficou pronta e chega na próxima conexão.
    expect(harness.repository.enabled('pvp1')).toHaveLength(1);
  });
});
