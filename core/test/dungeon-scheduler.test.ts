// ============================================================
//  O relógio que faz a masmorra nascer sozinha.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Um agendador falha de um jeito específico: em SILÊNCIO. Ele não
//  quebra a tela nem derruba o agente — simplesmente para de fazer
//  a coisa acontecer, e ninguém percebe até alguém perguntar "faz
//  tempo que não nasce masmorra, né?".
//
//  Os casos abaixo são os que produzem esse silêncio:
//
//    servidor vazio        adia, e não perde a vez
//    sem ponto marcado     adia, e NUNCA ergue em (0,0)
//    masmorra já de pé     não manda um segundo comando
//    agente reiniciado     o compromisso vencido é cumprido, e a
//                          run órfã é fechada
//    evento torto          não pode calar os outros
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §2.
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { DungeonSpawnPointsRepository } from '../src/db/dungeon-spawn-points-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { DungeonScheduler, RETRY_DELAY_MS } from '../src/dungeons/scheduler.js';
import type { DungeonBuildAttempt, DungeonBuildInput } from '../src/dungeons/sync.js';
import { worldEventInputSchema } from '../src/types/world-events.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const WORLD = '4000:1234';

interface Harness {
  scheduler: DungeonScheduler;
  readonly events: WorldEventsRepository;
  readonly points: DungeonSpawnPointsRepository;
  readonly db: AgentDatabase;
  /** Cada `ozdungeon build` que o agendador mandou. */
  readonly built: (DungeonBuildInput & { serverId: string })[];
  readonly demolished: string[];
  /** Quantos online o servidor tem, para o teste mexer. */
  online: number | null;
}

function harness(
  options: {
    readonly sent?: boolean;
    readonly refused?: DungeonBuildAttempt['refused'];
    readonly random?: () => number;
  } = {},
): Harness {
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
  const points = new DungeonSpawnPointsRepository(db);

  // ####  O ESTADO É DEVOLVIDO POR REFERÊNCIA, E ISSO IMPORTA  ####
  //
  // MEDIDO ao escrever este arquivo: devolvendo `{ ...state }`, o
  // teste que muda `h.online` mexia numa CÓPIA — e o agendador
  // continuava lendo 10 jogadores num servidor que o teste tinha
  // esvaziado. Os dois testes de adiamento passavam a erguer.
  const state: Harness = {
    events,
    points,
    db,
    built: [],
    demolished: [],
    online: 10,
    scheduler: null as unknown as DungeonScheduler,
  };

  const scheduler = new DungeonScheduler({
    events,
    spawnPoints: points,
    servers: {
      ids: () => [SERVER],
      onlineCount: () => Promise.resolve(state.online),
      worldKey: () => WORLD,
    },
    build: (serverId, input) => {
      state.built.push({ serverId, ...input });

      return Promise.resolve({
        sent: options.sent ?? true,
        ...(options.refused === undefined ? {} : { refused: options.refused }),
        reply: '',
        ground: null,
      });
    },
    demolish: (serverId) => {
      state.demolished.push(serverId);

      return Promise.resolve(true);
    },
    logger: silent,
    // Sem sorteio real: um agendador com Math.random produz um
    // teste que passa nove vezes em dez.
    random: options.random ?? (() => 0),
  });

  state.scheduler = scheduler;

  return state;
}

/** Um evento pronto para nascer: ligado, agendado, com masmorra. */
function makeEvent(
  events: WorldEventsRepository,
  patch: Record<string, unknown> = {},
): ReturnType<WorldEventsRepository['save']> {
  return events.save(
    worldEventInputSchema.parse({
      id: 'noite-de-masmorra',
      name: 'Noite de masmorra',
      dungeonId: 'labirinto',
      spawnMode: 'schedule',
      interval: { min: 3600, max: 3600 },
      duration: { min: 1800, max: 1800 },
      minOnline: 2,
      servers: [SERVER],
      ...patch,
    }),
  );
}

function addPoint(points: DungeonSpawnPointsRepository, label: string, x: number): void {
  points.add(
    SERVER,
    { label, x, z: 0, yaw: 90, enabled: true },
    { worldKey: WORLD },
  );
}

describe('a agenda', () => {
  it('o primeiro tick marca o próximo nascimento, e não ergue nada', async () => {
    const h = harness();

    makeEvent(h.events);
    addPoint(h.points, 'Encosta', 100);

    await h.scheduler.tick();

    // Um evento que nascesse no instante em que o admin o criou
    // surpreenderia o servidor: o primeiro também espera.
    expect(h.built).toHaveLength(0);

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    expect(scheduled).not.toBeNull();
    expect(scheduled?.scheduledFor).toBeGreaterThan(Date.now());
  });

  it('quando a hora chega, ergue no ponto marcado', async () => {
    const h = harness();

    makeEvent(h.events);
    addPoint(h.points, 'Encosta', 100);

    await h.scheduler.tick();

    // A hora chegou (o agente pode até ter ficado fora do ar).
    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    await h.scheduler.tick();

    expect(h.built).toEqual([
      { serverId: SERVER, slug: 'labirinto', x: 100, z: 0, yaw: 90 },
    ]);

    // O compromisso foi cumprido: quem abre a run do nascimento é o
    // `built` que volta pelo stream, com as peças e a grade.
    expect(h.events.scheduledRun('noite-de-masmorra', SERVER)?.id).not.toBe(scheduled.id);
  });
});

describe('quando ele NÃO pode erguer', () => {
  async function readyToSpawn(h: Harness): Promise<number> {
    makeEvent(h.events);
    addPoint(h.points, 'Encosta', 100);

    await h.scheduler.tick();

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    return scheduled.id;
  }

  it('servidor vazio adia, e não perde a vez', async () => {
    const h = harness();
    const runId = await readyToSpawn(h);

    h.online = 1; // o mínimo do evento é 2

    await h.scheduler.tick();

    expect(h.built).toHaveLength(0);

    // Adiado, e não cancelado: a condição pode melhorar em dois
    // minutos, e um evento que perde a vez porque o servidor
    // esvaziou por um instante quase nunca acontece.
    const again = h.events.run(runId);

    expect(again?.status).toBe('scheduled');
    expect(again?.scheduledFor).toBeGreaterThan(Date.now());
    expect(again?.scheduledFor).toBeLessThanOrEqual(Date.now() + RETRY_DELAY_MS + 1000);
  });

  it('sem saber quem está online, adia em vez de erguer no escuro', async () => {
    const h = harness();

    await readyToSpawn(h);

    h.online = null;

    await h.scheduler.tick();

    expect(h.built).toHaveLength(0);
  });

  it('sem ponto marcado, adia — e nunca ergue em (0,0)', async () => {
    const h = harness();

    makeEvent(h.events);

    await h.scheduler.tick();

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    await h.scheduler.tick();

    // (0,0) é o meio do mapa, e quase sempre oceano.
    expect(h.built).toHaveLength(0);
    expect(h.events.run(scheduled.id)?.status).toBe('scheduled');
  });

  it('com uma masmorra já de pé, não manda um segundo comando', async () => {
    const h = harness();

    await readyToSpawn(h);

    h.events.startRun({
      eventId: 'manual',
      serverId: SERVER,
      dungeonId: 'visita',
      x: 1,
      z: 1,
      grid: 'A1',
      seed: null,
    });

    await h.scheduler.tick();

    expect(h.built).toHaveLength(0);
  });

  it('um evento desligado ou sem masmorra não agenda nada', async () => {
    const desligado = harness();

    makeEvent(desligado.events, { enabled: false });
    addPoint(desligado.points, 'Encosta', 100);

    await desligado.scheduler.tick();

    expect(desligado.events.scheduledRun('noite-de-masmorra', SERVER)).toBeNull();

    const semMasmorra = harness();

    makeEvent(semMasmorra.events, { dungeonId: null });
    addPoint(semMasmorra.points, 'Encosta', 100);

    await semMasmorra.scheduler.tick();

    // Não é erro: o admin cria o evento, ajusta os horários e
    // escolhe a masmorra depois.
    expect(semMasmorra.events.scheduledRun('noite-de-masmorra', SERVER)).toBeNull();
  });

  it('o modo manual não é do relógio', async () => {
    const h = harness();

    makeEvent(h.events, { spawnMode: 'manual' });
    addPoint(h.points, 'Encosta', 100);

    await h.scheduler.tick();

    expect(h.events.scheduledRun('noite-de-masmorra', SERVER)).toBeNull();
  });
});

describe('quando o comando não chega', () => {
  it('a tentativa vira uma falha com nome, e o evento continua na agenda', async () => {
    const h = harness({ sent: false, refused: 'water' });

    makeEvent(h.events);
    addPoint(h.points, 'Encosta', 100);

    await h.scheduler.tick();

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    await h.scheduler.tick();

    const failed = h.events
      .runs({ eventId: 'noite-de-masmorra', limit: 20 })
      .find((run) => run.status === 'failed');

    expect(failed?.failureReason).toBe('no_position');

    // E o evento não morre com uma tentativa frustrada.
    expect(h.events.scheduledRun('noite-de-masmorra', SERVER)).not.toBeNull();
  });
});

describe('o agente reinicia', () => {
  it('fecha a run que sobrou de uma vida anterior', async () => {
    const h = harness();

    const orphan = h.events.startRun({
      eventId: 'manual',
      serverId: SERVER,
      dungeonId: 'labirinto',
      x: 1,
      z: 1,
      grid: 'A1',
      seed: null,
    });

    await h.scheduler.recover();

    // Nada da masmorra entra no save do mundo: uma run `active` de
    // antes deste processo está morta no jogo, e mantê-la aberta
    // faria o painel dizer "1 no ar" com o mapa vazio, para sempre.
    expect(h.events.run(orphan.id)?.status).toBe('ended');
    expect(h.events.activeRun(SERVER)).toBeNull();
  });

  it('cumpre o compromisso que venceu enquanto ele estava fora', async () => {
    const h = harness();

    makeEvent(h.events);
    addPoint(h.points, 'Encosta', 100);

    // O compromisso foi marcado numa vida anterior, e venceu há uma
    // hora — o agente estava fora.
    h.events.scheduleRun({
      eventId: 'noite-de-masmorra',
      serverId: SERVER,
      dungeonId: 'labirinto',
      at: Date.now() - 3_600_000,
    });

    await h.scheduler.recover();

    expect(h.built).toHaveLength(1);
  });
});

describe('o sorteio do ponto', () => {
  it('não repete o último lugar usado', async () => {
    const h = harness();

    makeEvent(h.events);
    addPoint(h.points, 'Norte', 100);
    addPoint(h.points, 'Sul', -100);

    // O "Norte" acabou de ser usado.
    const norte = h.points.list(SERVER)[0];

    if (norte === undefined) throw new Error('sem ponto');

    h.points.markUsed(SERVER, norte.id);

    await h.scheduler.tick();

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    await h.scheduler.tick();

    // Quem estava lá na primeira já sabe o caminho.
    expect(h.built[0]?.x).toBe(-100);
  });

  it('com um ponto só, usa esse mesmo', async () => {
    const h = harness();

    makeEvent(h.events);
    addPoint(h.points, 'Único', 42);

    const only = h.points.list(SERVER)[0];

    if (only === undefined) throw new Error('sem ponto');

    h.points.markUsed(SERVER, only.id);

    await h.scheduler.tick();

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    await h.scheduler.tick();

    expect(h.built[0]?.x).toBe(42);
  });

  it('um ponto de outro mapa fica de fora', async () => {
    const h = harness();

    makeEvent(h.events);

    h.points.add(
      SERVER,
      { label: 'Do mapa passado', x: 999, z: 0, yaw: 0, enabled: true },
      { worldKey: '4000:9999' },
    );

    await h.scheduler.tick();

    const scheduled = h.events.scheduledRun('noite-de-masmorra', SERVER);

    if (scheduled === null) throw new Error('nada foi agendado');

    h.events.rescheduleRun(scheduled.id, Date.now() - 1000);

    await h.scheduler.tick();

    // A mesma coordenada, depois de um wipe de mapa, é outro lugar.
    expect(h.built).toHaveLength(0);
  });
});
