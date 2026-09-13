// ============================================================
//  player-timers.test.ts  -  quão rápido as coisas andam para cada
//  grupo, e o que chega ao jogo.
//
//  O que este arquivo guarda:
//
//    1. o payload é o ESTADO COMPLETO: apagar os timers faz o grupo
//       sumir do JSON — é assim que "voltei ao nível de baixo" chega
//       ao jogo;
//    2. o apelido do nível viaja junto com o nome do grupo, e o
//       `default` vira `normal`, porque quem consome (o
//       OrigemZPlayer) pergunta por NÍVEL;
//    3. timer em branco é OMITIDO do JSON — nunca vira 1. O campo
//       ausente é o que faz o plugin descer um nível; um 1 explícito
//       travaria a queda e o VIP perderia o que o `default` dá;
//    4. o ×1 gravado pela tela vira `null` antes do banco, pelo mesmo
//       motivo;
//    5. a tela sabe que NÍVEL cada grupo é — e diz quando um grupo
//       não é nível nenhum, porque o plugin nunca o consultaria;
//    6. a rota recusa os quatro em ×1 e o que passa do teto.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { LoadoutsRepository } from '../src/db/loadouts-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { PlayerTimersRepository } from '../src/db/player-timers-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { SpawnStatusRepository } from '../src/db/spawn-status-repository.js';
import { decodePushPayload } from '../src/game/plugin-push.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import { registerLoadoutRoutes } from '../src/http/routes/loadouts.js';
import { SpawnStatusSync } from '../src/loadouts/status.js';
import { LoadoutSync } from '../src/loadouts/sync.js';
import {
  normalizePlayerTimers,
  PlayerTimersSync,
  timerTierOf,
  type PlayerTimersEntry,
} from '../src/loadouts/timers.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import type { VipTierLevel } from '../src/vip/tiers.js';

const LEVELS = [
  { Tier: 'bronze', Grupo: 'origemz.vip.bronze', Rank: 10, GrupoPai: '' },
  { Tier: 'gold', Grupo: 'origemz.vip.gold', Rank: 30, GrupoPai: 'origemz.vip.bronze' },
];

/** Os mesmos níveis, já lidos — para as funções puras. */
const PARSED_LEVELS: readonly VipTierLevel[] = [
  { tier: 'bronze', group: 'origemz.vip.bronze', title: null, rank: 10, parentGroup: null },
  {
    tier: 'gold',
    group: 'origemz.vip.gold',
    title: null,
    rank: 30,
    parentGroup: 'origemz.vip.bronze',
  },
];

const SERVER = 'pvp1';

interface TimersPayload {
  readonly tiers: Record<string, PlayerTimersEntry>;
}

interface FakeServer {
  readonly commands: string[];
  lastPayload: TimersPayload | null;
  connected: boolean;
}

function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      const sync = /^origemz\.timers\.sync (\S+)$/.exec(command);

      if (sync === null) {
        return Promise.resolve('');
      }

      server.lastPayload = decodePushPayload(sync[1] ?? '') as TimersPayload;

      return Promise.resolve(
        JSON.stringify({ ok: true, tiers: Object.keys(server.lastPayload.tiers).length }),
      );
    },
  };
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: PlayerTimersRepository;
  readonly sync: PlayerTimersSync;
  readonly server: FakeServer;
  readonly servers: {
    ids(): readonly string[];
    contextOf(id: string): { readonly rcon: OpsRcon } | null;
    configOf(id: string): { readonly paths: { readonly oxideConfigDir: string } } | null;
  };
}

let tempRoot: string;
let harness: Harness;

/** Grava um grupo com só os timers dados; o resto em branco. */
function save(
  groupName: string,
  timers: Partial<Record<'smelt' | 'craft' | 'research' | 'recycle', number>>,
  enabled = true,
): void {
  harness.repository.save({
    serverId: SERVER,
    groupName,
    smelt: timers.smelt ?? null,
    craft: timers.craft ?? null,
    research: timers.research ?? null,
    recycle: timers.recycle ?? null,
    enabled,
    updatedBy: 'admin',
  });
}

function keysOfPayload(): string[] {
  return Object.keys(harness.server.lastPayload?.tiers ?? {}).sort();
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rustagent-timers-'));

  const configDir = join(tempRoot, 'oxide', 'config');

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'OrigemZVip.json'), JSON.stringify({ Niveis: LEVELS }), 'utf8');

  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: SERVER,
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const server: FakeServer = { commands: [], lastPayload: null, connected: true };
  const repository = new PlayerTimersRepository(db);
  const servers = {
    ids: () => [SERVER],
    contextOf: (id: string) => (id === SERVER ? { rcon: fakeRcon(server) } : null),
    configOf: (id: string) => (id === SERVER ? { paths: { oxideConfigDir: configDir } } : null),
  };

  harness = {
    db,
    repository,
    server,
    servers,
    sync: new PlayerTimersSync({
      repository,
      servers,
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('o payload é o estado COMPLETO', () => {
  it('apagar os timers faz o grupo sumir do JSON, pelas duas chaves', async () => {
    save('origemz.vip.gold', { smelt: 3, craft: 2 });
    save('origemz.vip.bronze', { smelt: 2 });

    await harness.sync.push(SERVER, 'teste');

    // O nome do grupo E o apelido do nível: quem consome pergunta por
    // nível, e quem administra procura pelo grupo.
    expect(keysOfPayload()).toEqual(['bronze', 'gold', 'origemz.vip.bronze', 'origemz.vip.gold']);

    expect(harness.repository.remove(SERVER, 'origemz.vip.gold')).toBe(true);

    await harness.sync.push(SERVER, 'teste');

    expect(keysOfPayload()).toEqual(['bronze', 'origemz.vip.bronze']);
  });

  it('e os timers DESLIGADOS não vão, mas continuam guardados', async () => {
    save('origemz.vip.gold', { smelt: 5 }, false);

    await harness.sync.push(SERVER, 'teste');

    expect(harness.server.lastPayload?.tiers).toEqual({});
    expect(harness.repository.get(SERVER, 'origemz.vip.gold')?.smelt).toBe(5);
  });

  it('o `default` vira `normal`, que é como o jogo chama quem não é VIP', async () => {
    save('default', { craft: 2 });

    await harness.sync.push(SERVER, 'teste');

    expect(keysOfPayload()).toEqual(['default', 'normal']);
  });
});

describe('em branco é "este grupo não decide", e não 1', () => {
  it('o timer em branco é OMITIDO do JSON', async () => {
    save('origemz.vip.gold', { smelt: 3 });

    await harness.sync.push(SERVER, 'teste');

    const gold = harness.server.lastPayload?.tiers.gold;

    expect(gold).toEqual({ smelt: 3 });

    // O que importa aqui: o craft não virou 1. O campo ausente é o
    // que faz o plugin descer para o `default` — um 1 explícito
    // travaria a queda, e o VIP craftaria mais devagar que todo mundo
    // num servidor com "default: craft ×2".
    expect(gold !== undefined && 'craft' in gold).toBe(false);
  });

  it('e o grupo com os quatro em branco não entra no payload', async () => {
    save('origemz.vip.gold', {});

    await harness.sync.push(SERVER, 'teste');

    expect(harness.server.lastPayload?.tiers).toEqual({});
  });

  it('o ×1 da tela vira null antes do banco, e o resto perde o que passa de duas casas', () => {
    const values = normalizePlayerTimers({
      smelt: 1,
      craft: 1.4999999,
      research: 2,
      recycle: null,
    });

    expect(values).toEqual({ smelt: null, craft: 1.5, research: 2, recycle: null });
  });
});

describe('o nível de cada grupo, para a tela', () => {
  it('grupo de VIP vira o tier dele, o default vira normal e o admin é admin', () => {
    expect(timerTierOf('origemz.vip.gold', PARSED_LEVELS)).toBe('gold');
    expect(timerTierOf('default', PARSED_LEVELS)).toBe('normal');
    expect(timerTierOf('admin', PARSED_LEVELS)).toBe('admin');
  });

  it('um grupo que se CHAMA como um nível é aquele nível', () => {
    // O payload leva o nome do grupo como chave, e o cache do plugin
    // compara sem diferenciar maiúsculas: `GetTimers("gold")` o acha.
    expect(timerTierOf('Gold', PARSED_LEVELS)).toBe('gold');
  });

  it('grupo de evento não é nível nenhum — o plugin nunca o consultaria', () => {
    expect(timerTierOf('evento.natal', PARSED_LEVELS)).toBeNull();
  });
});

describe('o servidor fora do ar', () => {
  it('não impede gravar, e o desfecho diz por que não chegou', async () => {
    harness.server.connected = false;

    save('origemz.vip.gold', { smelt: 3 });

    const result = await harness.sync.push(SERVER, 'teste');

    expect(result.skipped).not.toBeNull();
    expect(harness.server.commands).toHaveLength(0);
    // A configuração ficou pronta e chega na próxima conexão.
    expect(harness.repository.enabled(SERVER)).toHaveLength(1);
  });
});

describe('as rotas', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Desconectado de propósito: gravar não pode depender do jogo, e
    // a lista de grupos vem então do que está guardado.
    harness.server.connected = false;

    const logger = createLogger({ log: { level: 'silent', pretty: false } });
    const supervisor = {
      ids: harness.servers.ids,
      contextOf: harness.servers.contextOf,
      configOf: harness.servers.configOf,
    } as unknown as ServerSupervisor;

    app = Fastify({ logger: false });

    app.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof ZodError) {
        const response = zodErrorToResponse(error);
        return reply.status(response.statusCode).send(response.body);
      }

      if (isApiError(error)) {
        const response = apiErrorToResponse(error);
        return reply.status(response.statusCode).send(response.body);
      }

      return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR', message: String(error) });
    });

    await app.register(async (api) => {
      const loadouts = new LoadoutsRepository(harness.db);
      const status = new SpawnStatusRepository(harness.db);

      registerLoadoutRoutes(api, {
        repository: loadouts,
        sync: new LoadoutSync({ repository: loadouts, servers: harness.servers, logger }),
        statusRepository: status,
        statusSync: new SpawnStatusSync({ repository: status, servers: harness.servers, logger }),
        timersRepository: harness.repository,
        timersSync: harness.sync,
        supervisor,
      });
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const url = (group?: string): string =>
    `/servers/${SERVER}/timers${group === undefined ? '' : `/${encodeURIComponent(group)}`}`;

  it('grava o ×1 da tela como "não decide" e diz que o servidor está fora', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: url('origemz.vip.gold'),
      payload: { smelt: 3, craft: 1, research: null, recycle: 2.5, enabled: true },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ timers: Record<string, unknown>; message: string }>();

    expect(body.timers).toMatchObject({ smelt: 3, craft: null, research: null, recycle: 2.5 });
    // O servidor está parado: a resposta não pode fingir que chegou.
    expect(body.message).toContain('fora do ar');
  });

  it('recusa os quatro em ×1, que é o mesmo que não ter configuração', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: url('origemz.vip.gold'),
      payload: { smelt: 1, craft: 1, research: null, recycle: null },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('EMPTY_PLAYER_TIMERS');
    expect(harness.repository.get(SERVER, 'origemz.vip.gold')).toBeNull();
  });

  it('recusa o que passa do teto, e o que desacelera', async () => {
    for (const smelt of [21, 0.5]) {
      const response = await app.inject({
        method: 'PUT',
        url: url('origemz.vip.gold'),
        payload: { smelt, craft: null, research: null, recycle: null },
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it('a lista diz que nível cada grupo é, na ordem em que o plugin desce', async () => {
    save('admin', { craft: 5 });
    save('origemz.vip.gold', { smelt: 3 });
    save('evento.natal', { recycle: 2 });
    save('origemz.vip.bronze', { smelt: 2 });
    save('default', { craft: 2 });

    const response = await app.inject({ method: 'GET', url: url() });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      connected: boolean;
      levelsProblem: string | null;
      groups: { name: string; tier: string | null; exists: boolean | null }[];
    }>();

    expect(body.connected).toBe(false);
    expect(body.levelsProblem).toBeNull();

    // A ordem da HIERARQUIA, e não a alfabética: o `default` na frente,
    // os VIPs pelo Rank, o admin, e por fim quem não é nível.
    expect(body.groups.map((group) => [group.name, group.tier])).toEqual([
      ['default', 'normal'],
      ['origemz.vip.bronze', 'bronze'],
      ['origemz.vip.gold', 'gold'],
      ['admin', 'admin'],
      ['evento.natal', null],
    ]);
  });

  it('apagar o que não existe é 404, e não sucesso', async () => {
    const response = await app.inject({ method: 'DELETE', url: url('origemz.vip.gold') });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('PLAYER_TIMERS_NOT_FOUND');
  });
});
