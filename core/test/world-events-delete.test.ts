// ============================================================
//  Apagar um evento do guarda-chuva.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Uma regra só, e ela tinha um beco sem saída.
//
//  `EVENT_IN_USE` existe para impedir que alguém apague um evento
//  com coisa DE PÉ no mapa — os destroços ficariam lá sem ninguém
//  para derrubá-los. Certo.
//
//  Só que a conta olhava `endedAt === null`, e isso pega a run
//  `scheduled` junto — que não é nada no mapa: é a hora marcada do
//  próximo nascimento. MEDIDO em 15/09/2026, com um KOTH agendado e
//  o chão vazio: apagar respondia "tem 1 nascimento de pé".
//
//  E era um beco: desligar o evento não cumpre nem cancela o
//  compromisso, então ele ficava lá para sempre — e o evento, sem
//  como apagar.
//
//  Estes testes fixam os dois lados: o compromisso NÃO impede, e o
//  que tem destroços impede.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerWorldEventRoutes } from '../src/http/routes/world-events.js';
import { worldEventInputSchema } from '../src/types/world-events.js';

const silent = pino({ level: 'silent' });
const SERVER = 'devserver';

interface Harness {
  readonly app: FastifyInstance;
  readonly db: AgentDatabase;
  readonly events: WorldEventsRepository;
}

let harness: Harness | null = null;

async function buildHarness(): Promise<Harness> {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  servers.create({
    id: SERVER,
    name: 'Dev',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\devserver',
  });

  const events = new WorldEventsRepository(db, silent);
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    if (isApiError(error)) {
      const response = apiErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    return reply.status(500).send({ ok: false, error: 'INTERNAL', message: error.message });
  });

  registerWorldEventRoutes(app, { events, servers });

  await app.ready();

  const state = { app, db, events };

  harness = state;

  return state;
}

afterEach(async () => {
  if (harness !== null) {
    await harness.app.close();
    harness.db.close();
    harness = null;
  }
});

function makeEvent(h: Harness): void {
  h.events.save(
    worldEventInputSchema.parse({
      id: 'koth-noite',
      kind: 'koth',
      name: 'KOTH da noite',
      servers: [SERVER],
    }),
  );
}

describe('apagar um evento', () => {
  it('um compromisso agendado NÃO impede: ele não é nada no mapa', async () => {
    const h = await buildHarness();

    makeEvent(h);

    h.events.scheduleRun({
      eventId: 'koth-noite',
      serverId: SERVER,
      dungeonId: null,
      at: Date.now() + 60_000,
    });

    const response = await h.app.inject({ method: 'DELETE', url: '/world-events/koth-noite' });

    expect(response.statusCode).toBe(200);
    expect(h.events.get('koth-noite')).toBeNull();
  });

  it('uma run de pé impede, e diz quantas', async () => {
    const h = await buildHarness();

    makeEvent(h);

    h.events.startRun({
      eventId: 'koth-noite',
      serverId: SERVER,
      dungeonId: null,
      x: 10,
      z: 20,
      grid: 'E7',
      seed: null,
    });

    const response = await h.app.inject({ method: 'DELETE', url: '/world-events/koth-noite' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('EVENT_IN_USE');
    // E o evento continua lá: recusar tem de ser recusar.
    expect(h.events.get('koth-noite')).not.toBeNull();
  });

  it('depois que a run fecha, apagar volta a funcionar', async () => {
    const h = await buildHarness();

    makeEvent(h);

    const run = h.events.startRun({
      eventId: 'koth-noite',
      serverId: SERVER,
      dungeonId: null,
      x: 10,
      z: 20,
      grid: 'E7',
      seed: null,
    });

    h.events.endRun(run.id, 'ended');

    const response = await h.app.inject({ method: 'DELETE', url: '/world-events/koth-noite' });

    expect(response.statusCode).toBe(200);
  });

  it('um evento que não existe é 404, e não 409', async () => {
    const h = await buildHarness();

    const response = await h.app.inject({ method: 'DELETE', url: '/world-events/fantasma' });

    expect(response.statusCode).toBe(404);
  });
});
