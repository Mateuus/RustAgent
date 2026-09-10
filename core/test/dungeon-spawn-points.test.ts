// ============================================================
//  Os pontos onde a masmorra nasce.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Até aqui a masmorra só nascia onde o admin estava de pé, com o
//  comando colado no chat. O pedido do dono em 09/09/2026 foi
//  outro: "o admin pode definir posições que ela vai spawn, que
//  ele determina e já sabe".
//
//  Três coisas podem dar errado com um ponto salvo, e as três
//  matam alguém ou fazem o evento não acontecer:
//
//    ÁGUA        a entrada nasce submersa. Em 09/09/2026 uma nasceu
//                dentro de um rio e o dono morreu no teleporte.
//    OUTRO MAPA  a mesma coordenada, depois de um wipe de mapa, é
//                outro lugar: a encosta virou fundo de lago.
//    MOVIDO      o ponto andou e continuou exibindo o "serve" que o
//                servidor disse sobre o lugar ANTERIOR.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §4.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonLayoutsRepository } from '../src/db/dungeon-layouts-repository.js';
import { DungeonSpawnPointsRepository } from '../src/db/dungeon-spawn-points-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerDungeonRoutes, type DungeonRoutesDeps } from '../src/http/routes/dungeons.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const WORLD = '4000:1234';

interface Harness {
  readonly app: FastifyInstance;
  readonly db: AgentDatabase;
  readonly points: DungeonSpawnPointsRepository;
}

let harness: Harness | null = null;

async function buildHarness(
  extra: {
    readonly groundAt?: DungeonRoutesDeps['groundAt'];
    readonly build?: DungeonRoutesDeps['build'];
    readonly worldKey?: string | null;
  } = {},
): Promise<Harness> {
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

  const points = new DungeonSpawnPointsRepository(db);
  const app = Fastify({ logger: false });

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
    registerDungeonRoutes(api, {
      dungeons: new DungeonsRepository(db, silent),
      blueprints: new DungeonBlueprintsRepository(db, silent),
      layouts: new DungeonLayoutsRepository(db, silent),
      events: new WorldEventsRepository(db, silent),
      spawnPoints: points,
      worldKeyOf: () => (extra.worldKey === undefined ? WORLD : extra.worldKey),
      ...(extra.groundAt === undefined ? {} : { groundAt: extra.groundAt }),
      ...(extra.build === undefined ? {} : { build: extra.build }),
    });
  });

  await app.ready();

  harness = { app, db, points };
  return harness;
}

afterEach(async () => {
  if (harness !== null) {
    await harness.app.close();
    harness.db.close();
    harness = null;
  }
});

/** O chão de um lugar bom: seco, e o servidor confirmou. */
const DRY = { grid: 'E7', ground: 12.4, water: 0, depth: 0, serves: true };

async function addPoint(app: FastifyInstance, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/servers/${SERVER}/spawn-points`,
    payload: { label: 'Encosta do lago', x: 120, z: -340, yaw: 90, ...body },
  });
}

describe('marcar um ponto', () => {
  it('grava o lugar, a direção e o que o servidor disse do chão', async () => {
    const { app } = await buildHarness({
      groundAt: async (_serverId, x, z) => Promise.resolve({ ...DRY, x, z }),
    });

    const response = await addPoint(app);

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      point: {
        label: string;
        x: number;
        z: number;
        yaw: number;
        grid: string;
        waterDepth: number;
        worldKey: string;
        enabled: boolean;
      };
      warning: string | null;
    };

    expect(body.point.label).toBe('Encosta do lago');
    expect(body.point.x).toBe(120);
    expect(body.point.z).toBe(-340);

    // Sem o yaw, toda masmorra nasceria apontada para o norte — e a
    // casinha entraria na encosta que o admin escolheu justamente
    // para ficar de frente.
    expect(body.point.yaw).toBe(90);

    // A grade é o que gente lê num mapa de Rust. Guardá-la evita a
    // lista de pontos virar uma lista de coordenadas.
    expect(body.point.grid).toBe('E7');
    expect(body.point.waterDepth).toBe(0);
    expect(body.point.worldKey).toBe(WORLD);
    expect(body.warning).toBeNull();
  });

  it('avisa sobre água, e mesmo assim grava', async () => {
    const { app } = await buildHarness({
      groundAt: async (_serverId, x, z) =>
        Promise.resolve({ ...DRY, x, z, depth: 3.2, serves: false }),
    });

    const response = await addPoint(app);

    // Gravar é do admin: ele pode estar marcando uma praia. O que
    // não pode é gravar em silêncio e alguém descobrir se afogando.
    expect(response.statusCode).toBe(201);

    const body = response.json() as { warning: string; point: { waterDepth: number } };

    expect(body.warning).toContain('água');
    expect(body.warning).toContain('3.2 m');
    expect(body.point.waterDepth).toBe(3.2);
  });

  it('grava com o servidor parado, sem inventar um veredito', async () => {
    // Sem `groundAt`: é o agente que subiu com tudo desligado, e
    // desenhar masmorra assim é o caso normal deste painel.
    const { app } = await buildHarness();

    const response = await addPoint(app);

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      point: { grid: string | null; checkedAt: number | null };
      warning: string | null;
    };

    expect(body.point.grid).toBeNull();
    expect(body.point.checkedAt).toBeNull();
    expect(body.warning).toBeNull();
  });
});

describe('mexer num ponto', () => {
  it('mover apaga o veredito do lugar anterior', async () => {
    const { app, points } = await buildHarness({
      groundAt: async (_serverId, x, z) => Promise.resolve({ ...DRY, x, z }),
    });

    const created = (await addPoint(app)).json() as { point: { id: number } };

    // Agora o servidor some, e o ponto anda.
    await harness?.app.close();

    const { app: offline, points: offlinePoints } = await buildHarness();

    const point = offlinePoints.add(
      SERVER,
      { label: 'Encosta', x: 120, z: -340, yaw: 90, enabled: true },
      { worldKey: WORLD, ground: { grid: 'E7', waterDepth: 0, checkedAt: 111 } },
    );

    expect(created.point.id).toBeGreaterThan(0);

    const response = await offline.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/spawn-points/${String(point.id)}`,
      payload: { label: 'Encosta', x: 900, z: 900, yaw: 90, enabled: true },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      point: { grid: string | null; waterDepth: number | null; checkedAt: number | null };
    };

    // O "serve" era sobre o chão de (120, -340). Herdá-lo para
    // (900, 900) é pior que não saber: ninguém questiona um
    // veredito que já está na tela.
    expect(body.point.grid).toBeNull();
    expect(body.point.waterDepth).toBeNull();
    expect(body.point.checkedAt).toBeNull();

    expect(points.list(SERVER).length).toBeGreaterThanOrEqual(0);
  });

  it('trocar só o rótulo preserva o que o servidor tinha dito', async () => {
    const { app, points } = await buildHarness();

    const point = points.add(
      SERVER,
      { label: 'Antigo', x: 120, z: -340, yaw: 0, enabled: true },
      { worldKey: WORLD, ground: { grid: 'E7', waterDepth: 0, checkedAt: 111 } },
    );

    const response = await app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/spawn-points/${String(point.id)}`,
      payload: { label: 'Novo nome', x: 120, z: -340, yaw: 0, enabled: true },
    });

    const body = response.json() as { point: { label: string; grid: string; checkedAt: number } };

    expect(body.point.label).toBe('Novo nome');
    expect(body.point.grid).toBe('E7');
    expect(body.point.checkedAt).toBe(111);
  });

  it('apagar um ponto que não existe é 404', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'DELETE',
      url: `/servers/${SERVER}/spawn-points/999`,
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('SPAWN_POINT_NOT_FOUND');
  });
});

describe('o ponto é de um mapa', () => {
  it('um ponto de outro mundo sai da conta sem ser apagado', async () => {
    const { points } = await buildHarness();

    points.add(
      SERVER,
      { label: 'Deste mapa', x: 1, z: 1, yaw: 0, enabled: true },
      { worldKey: WORLD },
    );

    points.add(
      SERVER,
      { label: 'Do mapa passado', x: 2, z: 2, yaw: 0, enabled: true },
      { worldKey: '4000:9999' },
    );

    points.add(
      SERVER,
      { label: 'Desligado', x: 3, z: 3, yaw: 0, enabled: false },
      { worldKey: WORLD },
    );

    // A lista mostra os três: apagar sozinho é o tipo de coisa que
    // ninguém relaciona com o botão que apertou.
    expect(points.list(SERVER)).toHaveLength(3);

    // O sorteio vê um só.
    const usable = points.usable(SERVER, WORLD);

    expect(usable).toHaveLength(1);
    expect(usable[0]?.label).toBe('Deste mapa');
  });
});

describe('erguer num ponto salvo', () => {
  it('a masmorra nasce onde e para onde o ponto diz', async () => {
    const asked: unknown[] = [];

    const { app, points } = await buildHarness({
      build: async (serverId, input) => {
        asked.push({ serverId, ...input });

        return Promise.resolve({ sent: true, reply: '', ground: { ...DRY, x: 120, z: -340 } });
      },
    });

    const point = points.add(SERVER, {
      label: 'Encosta',
      x: 120,
      z: -340,
      yaw: 270,
      enabled: true,
    });

    await app.inject({
      method: 'POST',
      url: '/dungeons',
      payload: { id: 'bunker', name: 'Bunker' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/dungeons/bunker/build',
      payload: { serverId: SERVER, pointId: point.id },
    });

    expect(response.statusCode).toBe(200);
    expect(asked).toEqual([{ serverId: SERVER, slug: 'bunker', x: 120, z: -340, yaw: 270 }]);

    // O ponto usado é marcado: é o que impede o sorteio de repetir
    // o mesmo lugar duas vezes seguidas.
    expect(points.get(SERVER, point.id)?.lastUsedAt).not.toBeNull();
  });

  it('apontar para um ponto que não existe é 404, e nada é mandado', async () => {
    let called = false;

    const { app } = await buildHarness({
      build: async () => {
        called = true;

        return Promise.resolve({ sent: true, reply: '', ground: null });
      },
    });

    await app.inject({
      method: 'POST',
      url: '/dungeons',
      payload: { id: 'bunker', name: 'Bunker' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/dungeons/bunker/build',
      payload: { serverId: SERVER, pointId: 4242 },
    });

    expect(response.statusCode).toBe(404);
    expect(called).toBe(false);
  });

  it('sem ponto e sem coordenada, a rota recusa em vez de erguer na origem', async () => {
    const { app } = await buildHarness({
      build: async () => Promise.resolve({ sent: true, reply: '', ground: null }),
    });

    await app.inject({
      method: 'POST',
      url: '/dungeons',
      payload: { id: 'bunker', name: 'Bunker' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/dungeons/bunker/build',
      payload: { serverId: SERVER },
    });

    // (0, 0) é o meio do mapa, e quase sempre oceano. Um corpo
    // incompleto não pode virar uma masmorra no fundo do mar.
    expect(response.statusCode).toBe(400);
  });
});
