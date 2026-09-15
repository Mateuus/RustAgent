// ============================================================
//  O relógio do território.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Um agendador falha em SILÊNCIO: não quebra nada, só para de
//  fazer a coisa acontecer, e ninguém percebe até alguém perguntar
//  "faz tempo que não nasce KOTH, né?".
//
//    servidor vazio          adia, e não perde a vez
//    sem território          adia em silêncio — é configuração que
//                            falta, não defeito, e não pode virar
//                            "falhou" no histórico
//    evento de pé            não ergue um segundo por cima
//    masmorra de pé          também não: dois eventos dividem a
//                            população e os dois ficam vazios
//    família errada          o relógio do KOTH não toca em masmorra
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { KothArenasRepository } from '../src/db/koth-arenas-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { KothScheduler } from '../src/game/koth-scheduler.js';
import type { KothService } from '../src/game/koth.js';
import { kothArenaInputSchema } from '../src/types/koth.js';
import { worldEventInputSchema } from '../src/types/world-events.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

interface Harness {
  readonly scheduler: KothScheduler;
  readonly events: WorldEventsRepository;
  readonly arenas: KothArenasRepository;
  /** Cada `start` que o relógio mandou. */
  readonly started: string[];
  online: number | null;
  hasArena: boolean;
  /** O próximo `start` falha? */
  failNext: boolean;
}

function harness(): Harness {
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

  const events = new WorldEventsRepository(db, silent);
  const arenas = new KothArenasRepository(db);

  const state: Harness = {
    scheduler: null as unknown as KothScheduler,
    events,
    arenas,
    started: [],
    online: 10,
    hasArena: true,
    failNext: false,
  };

  const koth = {
    hasArena: () => state.hasArena,
    start: (input: { readonly serverId: string }) => {
      if (state.failNext) return Promise.reject(new Error('o plugin recusou'));

      state.started.push(input.serverId);

      // O serviço de verdade abre a run; aqui o teste faz o mesmo,
      // porque é isso que impede o próximo tick de erguer de novo.
      events.startRun({
        eventId: 'koth-noite',
        serverId: input.serverId,
        dungeonId: null,
        x: 0,
        z: 0,
        grid: 'E7',
        seed: null,
      });

      return Promise.resolve({
        arena: { label: 'Colina' },
        runId: 1,
        grid: 'E7',
      });
    },
  } as unknown as KothService;

  const scheduler = new KothScheduler({
    events,
    koth,
    servers: {
      ids: () => [SERVER],
      onlineCount: () => Promise.resolve(state.online),
    },
    logger: silent,
    // Sem sorteio real: um relógio com Math.random produz um teste
    // que passa nove vezes em dez.
    random: () => 0,
  });

  return Object.assign(state, { scheduler });
}

/** Um evento de KOTH pronto para nascer. */
function makeEvent(h: Harness, patch: Record<string, unknown> = {}): void {
  h.events.save(
    worldEventInputSchema.parse({
      id: 'koth-noite',
      kind: 'koth',
      name: 'KOTH da noite',
      spawnMode: 'schedule',
      interval: { min: 3600, max: 3600 },
      minOnline: 2,
      servers: [SERVER],
      ...patch,
    }),
  );
}

function arena(h: Harness): void {
  h.arenas.add(SERVER, kothArenaInputSchema.parse({ label: 'Colina', x: 10, z: 20 }));
}

/** Faz o compromisso vencer, sem esperar uma hora. */
function makeDue(h: Harness): void {
  const scheduled = h.events.scheduledRun('koth-noite', SERVER);

  if (scheduled !== null) h.events.rescheduleRun(scheduled.id, Date.now() - 1000);
}

describe('a agenda do KOTH', () => {
  it('o primeiro tick marca o próximo, e não ergue nada', async () => {
    const h = harness();

    makeEvent(h);
    arena(h);

    await h.scheduler.tick();

    expect(h.started).toHaveLength(0);
    expect(h.events.scheduledRun('koth-noite', SERVER)).not.toBeNull();
  });

  it('quando a hora chega, ergue', async () => {
    const h = harness();

    makeEvent(h);
    arena(h);

    await h.scheduler.tick();
    makeDue(h);
    await h.scheduler.tick();

    expect(h.started).toEqual([SERVER]);
  });

  it('não toca em evento de outra família', async () => {
    const h = harness();

    makeEvent(h, { id: 'masmorra', kind: 'dungeon', dungeonId: 'labirinto' });
    arena(h);

    await h.scheduler.tick();

    expect(h.events.scheduledRun('masmorra', SERVER)).toBeNull();
  });

  it('um evento desligado não agenda nada', async () => {
    const h = harness();

    makeEvent(h, { enabled: false });
    arena(h);

    await h.scheduler.tick();

    expect(h.events.scheduledRun('koth-noite', SERVER)).toBeNull();
  });

  it('o modo manual não é do relógio', async () => {
    const h = harness();

    makeEvent(h, { spawnMode: 'manual' });
    arena(h);

    await h.scheduler.tick();

    expect(h.events.scheduledRun('koth-noite', SERVER)).toBeNull();
  });
});

describe('quando ele NÃO pode erguer', () => {
  it('servidor vazio adia, e não perde a vez', async () => {
    const h = harness();

    makeEvent(h);
    arena(h);

    await h.scheduler.tick();
    makeDue(h);

    h.online = 1;

    await h.scheduler.tick();

    expect(h.started).toHaveLength(0);
    // O compromisso continua lá, adiado — e não vira falha.
    expect(h.events.scheduledRun('koth-noite', SERVER)).not.toBeNull();
    expect(h.events.runs({ limit: 10 }).filter((run) => run.status === 'failed')).toHaveLength(0);
  });

  it('sem saber quem está online, adia em vez de erguer no escuro', async () => {
    const h = harness();

    makeEvent(h);
    arena(h);

    await h.scheduler.tick();
    makeDue(h);

    h.online = null;

    await h.scheduler.tick();

    expect(h.started).toHaveLength(0);
  });

  it('sem território, adia em SILÊNCIO — não é falha', async () => {
    const h = harness();

    makeEvent(h);
    h.hasArena = false;

    await h.scheduler.tick();
    makeDue(h);
    await h.scheduler.tick();

    expect(h.started).toHaveLength(0);
    expect(h.events.runs({ limit: 10 }).filter((run) => run.status === 'failed')).toHaveLength(0);
  });

  it('com um evento já de pé, não ergue um segundo', async () => {
    const h = harness();

    makeEvent(h);
    arena(h);

    // Uma masmorra de pé conta: dois eventos dividem a população.
    h.events.startRun({
      eventId: 'outro',
      serverId: SERVER,
      dungeonId: 'labirinto',
      x: 0,
      z: 0,
      grid: 'A1',
      seed: null,
    });

    await h.scheduler.tick();
    makeDue(h);
    await h.scheduler.tick();

    expect(h.started).toHaveLength(0);
  });

  it('se o start falha, vira falha com nome — e o evento continua na agenda', async () => {
    const h = harness();

    makeEvent(h);
    arena(h);

    await h.scheduler.tick();
    makeDue(h);

    h.failNext = true;

    await h.scheduler.tick();

    const failed = h.events.runs({ limit: 10 }).filter((run) => run.status === 'failed');

    expect(failed).toHaveLength(1);
    expect(h.events.scheduledRun('koth-noite', SERVER)).not.toBeNull();
  });
});
