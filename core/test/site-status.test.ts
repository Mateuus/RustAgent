// ============================================================
//  site-status.test.ts  -  o retrato do servidor que sobe para o
//  site.
//
//  O que este arquivo guarda:
//
//    1. POSIÇÃO DE JOGADOR NÃO SOBE — nem `x/y/z`, nem `grid`. É o
//       caso mais caro do arquivo: um vazamento aqui entrega a
//       base de cada jogador a quem abrir o painel do site;
//    2. `online`/`max` sempre vão, e "não deu para perguntar" é
//       dito com `source: 'unavailable'`, nunca com um zero mudo;
//    3. os dois tetos de corpo: com lista cai para sem lista, e
//       sem lista que ainda estoura simplesmente não sai;
//    4. `load1` vem `null` no Windows — e o zero de lá não vira
//       "máquina ociosa";
//    5. 401 acorda o beacon, 413 tira a lista da próxima batida, e
//       5xx só espera a volta seguinte;
//    6. o corpo NUNCA carrega `balance`/`ozBalance`/`epBalance`.
//
//  Nada aqui sai da máquina: o `fetch` é um dublê.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { PlayersSnapshot } from '../src/game/players.js';
import { createLogger } from '../src/logger.js';
import type { OperationView } from '../src/ops/operations.js';
import type { ServerView } from '../src/servers/supervisor.js';
import { SiteClient } from '../src/site/client.js';
import {
  buildStatusPayload,
  hasForbiddenField,
  SiteStatus,
  STATUS_MAX_BYTES,
  STATUS_MAX_BYTES_WITH_LIST,
  STATUS_MAX_PLAYERS,
  withoutList,
  type StatusCollected,
  type StatusPayload,
} from '../src/site/status.js';
import type { SteamUpdateState } from '../src/steam/update-watcher.js';
import { load1Of, machineSnapshot } from '../src/util/machine.js';

const SERVER = 'pvp1';
const SITE_SERVER = 'RUST01';
const NOW = 1_700_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Canned {
  readonly status: number;
  readonly body?: unknown;
}

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

/** O `fetch` de mentira, com a fila de respostas na ordem. */
function fakeFetch(responses: readonly Canned[]): {
  impl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let at = 0;

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const canned = responses[Math.min(at, responses.length - 1)] ?? { status: 500 };

    at += 1;
    calls.push({
      url: String(url),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    });

    return Promise.resolve(
      new Response(canned.body === undefined ? '{"ok":true}' : JSON.stringify(canned.body), {
        status: canned.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

function serverView(over: Partial<ServerView> = {}): ServerView {
  return {
    id: SERVER,
    site: { serverId: SITE_SERVER, hasToken: true },
    name: 'PVP 1',
    identity: 'pvp1',
    hostname: 'OrigemZ PVP',
    enabled: true,
    installed: true,
    consoleWindow: false,
    running: true,
    pid: 4120,
    map: 'Procedural Map',
    worldSize: 4000,
    seed: 1234,
    maxPlayers: 200,
    saveInterval: 300,
    description: 'servidor de teste',
    url: 'https://origemz.com',
    headerImage: '',
    steam: { appId: '258550', login: 'anonymous', branch: 'public' },
    ports: { game: 28015, rcon: 28016, query: 28017, app: 28082 },
    rcon: { connected: true, state: 'connected' },
    paths: { installDir: 'C:\\Servers\\pvp1', configPath: 'C:\\Configs\\pvp1.ini', logsDir: 'C:\\Logs' },
    ...over,
  };
}

/** Um jogador COM posição: é dela que o retrato precisa se livrar. */
function player(index: number, over: Record<string, unknown> = {}): PlayersSnapshot['players'][number] {
  return {
    steamId: `7656119800000${String(1000 + index)}`,
    name: `Jogador ${String(index)}`,
    health: 100,
    isAlive: true,
    isSleeping: false,
    ping: 42,
    connectedSeconds: 600,
    position: { x: 120.5, y: 10, z: -840.2 },
    grid: 'G12',
    ip: '203.0.113.10',
    ...over,
  } as PlayersSnapshot['players'][number];
}

function snapshot(count: number, over: Partial<PlayersSnapshot> = {}): PlayersSnapshot {
  const list = Array.from({ length: count }, (_value, index) => player(index));

  return {
    source: 'plugin',
    total: count,
    players: list,
    world: { size: 4000, cellSize: 146.3, cols: 28, rows: 28 },
    plugin: { name: 'OrigemZAgent', id: 1, enabled: true },
    missing: [],
    ...over,
  };
}

function buildState(over: Partial<SteamUpdateState> = {}): SteamUpdateState {
  return {
    appId: '258550',
    branch: 'public',
    installed: '123456',
    published: '123499',
    updateAvailable: true,
    checkedAt: NOW - 60_000,
    lastError: null,
    autoUpdate: true,
    attempts: 0,
    maxAttempts: 3,
    lastAttempt: null,
    nextAttemptAt: null,
    ...over,
  };
}

function operationView(over: Partial<OperationView> = {}): OperationView {
  return {
    id: 'op_7f3a',
    kind: 'server-restart',
    serverId: SERVER,
    status: 'running',
    progress: 40,
    startedAt: NOW - 10_000,
    finishedAt: null,
    message: 'reiniciando',
    ...over,
  };
}

function collected(over: Partial<StatusCollected> = {}): StatusCollected {
  return {
    server: serverView(),
    players: snapshot(2),
    build: buildState(),
    operation: operationView(),
    kinds: ['server-start', 'server-stop', 'server-restart'],
    ...over,
  };
}

function payloadOf(over: Partial<StatusCollected> = {}): StatusPayload {
  return buildStatusPayload({
    ...collected(over),
    at: NOW,
    version: '1.0.0',
    uptimeSeconds: 3600,
    machine: machineSnapshot({ load: [0, 0, 0], disk: { total: 0, free: 0 } }),
  });
}

interface Harness {
  readonly reporter: SiteStatus;
  readonly calls: Call[];
  readonly suspects: string[];
}

function harness(
  responses: readonly Canned[],
  options: {
    readonly collect?: () => Promise<StatusCollected | null>;
    readonly maxBytes?: number;
    readonly maxBytesWithList?: number;
    readonly now?: () => number;
  } = {},
): Harness {
  const { impl, calls } = fakeFetch(responses);
  const suspects: string[] = [];
  const client = new SiteClient({
    baseUrl: 'https://origemz.test',
    token: 'bearer-de-teste',
    serverId: SITE_SERVER,
    userAgent: 'OrigemZ-Rust-Agent/1.0.0',
    fetchImpl: impl,
  });

  const reporter = new SiteStatus({
    client,
    serverId: SERVER,
    version: '1.0.0',
    startedAt: NOW - 3_600_000,
    logger: silent,
    collect: options.collect ?? ((): Promise<StatusCollected | null> => Promise.resolve(collected())),
    onPairingSuspect: (reason) => suspects.push(reason),
    now: options.now ?? ((): number => NOW),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxBytesWithList === undefined ? {} : { maxBytesWithList: options.maxBytesWithList }),
  });

  return { reporter, calls, suspects };
}

// ============================================================

describe('o corpo montado', () => {
  it('leva os seis blocos do contrato, com o `at` em ISO', () => {
    const payload = payloadOf();

    expect(payload.at).toBe(new Date(NOW).toISOString());
    expect(payload.agent).toEqual({ version: '1.0.0', uptimeSeconds: 3600, health: 'ok' });
    expect(payload.server).toMatchObject({
      running: true,
      pid: 4120,
      installed: true,
      hostname: 'OrigemZ PVP',
      map: 'Procedural Map',
      worldSize: 4000,
      seed: 1234,
      maxPlayers: 200,
      rcon: { connected: true, state: 'connected' },
    });
    expect(payload.build).toEqual({
      installed: '123456',
      published: '123499',
      updateAvailable: true,
      checkedAt: new Date(NOW - 60_000).toISOString(),
      autoUpdate: true,
    });
    expect(payload.operation).toEqual({
      id: 'op_7f3a',
      kind: 'server-restart',
      status: 'running',
      progress: 40,
      message: 'reiniciando',
    });
    expect(payload.kinds).toEqual(['server-start', 'server-stop', 'server-restart']);
  });

  it('`operation` é null quando não há operação em curso', () => {
    expect(payloadOf({ operation: null }).operation).toBeNull();
  });

  it('a lista NUNCA carrega posição — nem `x/y/z`, nem `grid`', () => {
    // O caso mais caro do arquivo: posição viva de jogador é intel
    // de raid, e a rota de jogadores do agente a devolve. Ela para
    // no `entryOf`, e este teste é a única coisa que percebe se
    // alguém trocar os quatro campos por um espalhamento.
    const payload = payloadOf({ players: snapshot(3) });
    const entries = payload.players.list ?? [];

    expect(entries).toHaveLength(3);

    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['isAlive', 'isSleeping', 'name', 'steamId']);
    }

    const wire = JSON.stringify(payload);

    expect(wire).not.toContain('position');
    expect(wire).not.toContain('grid');
    expect(wire).not.toContain('-840.2');
    // O IP também não sobe: ele não está no contrato, e ninguém
    // precisa dele do outro lado para desenhar uma tela.
    expect(wire).not.toContain('203.0.113.10');
  });

  it('a lista para no teto de 300, e a contagem continua sendo a real', () => {
    const payload = payloadOf({ players: snapshot(420) });

    expect(payload.players.list).toHaveLength(STATUS_MAX_PLAYERS);
    // `online` é o TOTAL conectado, e não o tamanho da lista: um
    // corte de página não pode virar "sumiram 120 jogadores".
    expect(payload.players.online).toBe(420);
    expect(payload.players.max).toBe(200);
  });

  it('sem conseguir perguntar, `online` vai zerado e o `source` diz por quê', () => {
    // Zero aqui NÃO é "não tem ninguém". Quem exibir o número sem
    // ler o `source` mostrará um servidor cheio como vazio.
    const payload = payloadOf({ players: null });

    expect(payload.players).toEqual({ online: 0, max: 200, source: 'unavailable' });
    expect(payload.players.list).toBeUndefined();
  });

  it('o jogo no ar sem RCON é `degraded`; parado de propósito é `ok`', () => {
    expect(payloadOf({ players: null }).agent.health).toBe('degraded');
    expect(
      payloadOf({ server: serverView({ rcon: { connected: false, state: 'connecting' } }) }).agent
        .health,
    ).toBe('degraded');
    expect(
      payloadOf({ server: serverView({ running: false, pid: null, rcon: null }), players: null })
        .agent.health,
    ).toBe('ok');
  });

  it('`running: null` (varredura ainda não feita) vira `false` no fio', () => {
    expect(payloadOf({ server: serverView({ running: null }) }).server.running).toBe(false);
  });

  it('o corpo NUNCA carrega `balance`, `ozBalance` nem `epBalance`', () => {
    // O middleware global do site responde 403 SEM código quando
    // encontra um deles — um 403 mudo que se parece com pareamento
    // quebrado e não é.
    expect(hasForbiddenField(payloadOf())).toBe(false);
    expect(hasForbiddenField({ agent: { nested: { ozBalance: 10 } } })).toBe(true);
    expect(hasForbiddenField({ list: [{ balance: 1 }] })).toBe(true);
  });
});

describe('os tetos de corpo', () => {
  it('o retrato cheio (300 jogadores) cabe nos 64 KB, e sem lista nos 8 KB', () => {
    // É esta folga que torna o caminho do corpo grande raro — e é
    // por isso que os tetos do laço são injetáveis no teste.
    const payload = payloadOf({ players: snapshot(STATUS_MAX_PLAYERS) });

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(
      STATUS_MAX_BYTES_WITH_LIST,
    );
    expect(Buffer.byteLength(JSON.stringify(withoutList(payload)), 'utf8')).toBeLessThan(
      STATUS_MAX_BYTES,
    );
  });

  it('estourando com a lista, sai sem ela — e a contagem vai junto', async () => {
    const { reporter, calls } = harness([{ status: 200 }], {
      collect: () => Promise.resolve(collected({ players: snapshot(50) })),
      maxBytesWithList: 400,
    });

    await reporter.push();

    expect(calls).toHaveLength(1);

    const body = calls[0]?.body as { players: Record<string, unknown> };

    expect(body.players.list).toBeUndefined();
    expect(body.players.online).toBe(50);
    expect(body.players.max).toBe(200);
  });

  it('quando nem o retrato pelado cabe, nada sai — e o laço não quebra', async () => {
    // Sem lista, o teto que vale é o de 8 KB. Um corpo que não
    // couber nele não é enviado: mandar seria tomar 413 de
    // propósito, e o retrato não vale um erro programado.
    const { reporter, calls } = harness([{ status: 200 }], {
      collect: () => Promise.resolve(collected({ players: null })),
      maxBytes: 100,
    });

    await expect(reporter.push()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(reporter.health.lastError).toBe('STATUS_TOO_LARGE');
  });
});

describe('a máquina', () => {
  it('`load1` é null quando o sistema não mede a carga (Windows)', () => {
    // No Windows o `loadavg` é sempre [0,0,0]. Devolver o zero
    // seria inventar uma medida — e a máquina apareceria ociosa.
    expect(load1Of([0, 0, 0])).toBeNull();
    expect(load1Of([0.5, 0.2, 0.1])).toBe(0.5);
    expect(machineSnapshot({ load: [0, 0, 0] }).load1).toBeNull();

    if (process.platform === 'win32') {
      expect(machineSnapshot().load1).toBeNull();
    }
  });

  it('não existe CPU em porcentagem, e o disco ausente vai como zero', () => {
    const machine = machineSnapshot({ disk: null });

    expect(Object.keys(machine.cpu).sort()).toEqual(['cores', 'model', 'speedMhz']);
    expect(machine.disk).toEqual({ total: 0, free: 0 });
  });
});

describe('as respostas do site', () => {
  it('a batida sai autenticada, no caminho do contrato', async () => {
    const { reporter, calls } = harness([{ status: 200 }]);

    await reporter.push();

    expect(calls[0]?.url).toBe('https://origemz.test/api/agent/server/status');
    expect(calls[0]?.headers.Authorization).toBe('Bearer bearer-de-teste');
    expect(calls[0]?.headers['X-Server-Id']).toBe(SITE_SERVER);
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(reporter.health.lastPushAt).toBe(NOW);
  });

  it('401 de pareamento acorda o beacon e não derruba nada', async () => {
    const { reporter, suspects } = harness([
      { status: 401, body: { error: 'sem bearer', error_code: 'MISSING_BEARER' } },
    ]);

    await expect(reporter.push()).resolves.toBeUndefined();
    expect(suspects).toEqual(['MISSING_BEARER']);
    expect(reporter.health.lastErrorCode).toBe('MISSING_BEARER');
  });

  it('404 sem código é "a rota ainda não existe": não acorda o beacon', async () => {
    // O Lote 2 do outro lado pode não ter subido. Um `suspect` a
    // cada 30 s por servidor faria o beacon bater sem motivo até o
    // dia em que a rota nascesse.
    const { reporter, suspects } = harness([{ status: 404, body: {} }]);

    await reporter.push();

    expect(suspects).toEqual([]);
  });

  it('413 tira a lista da batida seguinte, e ela volta depois do prazo', async () => {
    let clock = NOW;
    const { reporter, calls } = harness([{ status: 413 }, { status: 200 }, { status: 200 }], {
      now: () => clock,
    });

    await reporter.push();
    expect((calls[0]?.body as { players: { list?: unknown } }).players.list).toHaveLength(2);

    clock += 30_000;
    await reporter.push();
    expect((calls[1]?.body as { players: { list?: unknown } }).players.list).toBeUndefined();
    expect(reporter.health.listSuppressedUntil).not.toBeNull();

    // Passado o prazo, a lista volta: o 413 também acontece por
    // lotação passageira, e um pico de uma noite não pode calar a
    // lista até o próximo reinício.
    clock += 11 * 60_000;
    await reporter.push();
    expect((calls[2]?.body as { players: { list?: unknown } }).players.list).toHaveLength(2);
  });

  it('5xx só espera a volta seguinte — e a volta seguinte manda igual', async () => {
    const { reporter, calls } = harness([{ status: 503, body: {} }, { status: 200 }]);

    await reporter.push();

    expect(reporter.health.lastPushAt).toBeNull();
    expect(reporter.health.lastError).not.toBeNull();

    await reporter.push();

    expect(calls).toHaveLength(2);
    expect((calls[1]?.body as { players: { list?: unknown } }).players.list).toHaveLength(2);
    expect(reporter.health.lastPushAt).toBe(NOW);
    expect(reporter.health.lastError).toBeNull();
  });

  it('erro de rede não lança e não para o laço', async () => {
    const impl = ((): Promise<Response> =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof globalThis.fetch;
    const client = new SiteClient({
      baseUrl: 'https://origemz.test',
      token: 'bearer-de-teste',
      serverId: SITE_SERVER,
      userAgent: 'OrigemZ-Rust-Agent/1.0.0',
      fetchImpl: impl,
    });
    const reporter = new SiteStatus({
      client,
      serverId: SERVER,
      version: '1.0.0',
      startedAt: NOW - 1000,
      logger: silent,
      collect: () => Promise.resolve(collected()),
      now: () => NOW,
    });

    await expect(reporter.push()).resolves.toBeUndefined();
    expect(reporter.health.lastPushAt).toBeNull();
  });

  it('sem servidor no supervisor, a rodada não sai', async () => {
    const { reporter, calls } = harness([{ status: 200 }], {
      collect: () => Promise.resolve(null),
    });

    await reporter.push();

    expect(calls).toHaveLength(0);
  });

  it('uma coleta que estoura vira log, e não uma promessa rejeitada', async () => {
    const { reporter, calls } = harness([{ status: 200 }], {
      collect: () => Promise.reject(new Error('o supervisor caiu')),
    });

    await expect(reporter.push()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(reporter.health.lastError).toBe('o supervisor caiu');
  });

  it('`start()` bate uma vez no boot, e `stop()` não deixa relógio para trás', async () => {
    const { reporter, calls } = harness([{ status: 200 }]);

    reporter.start();
    // A batida do boot é disparada sem `await`: uma volta do laço de
    // eventos basta para ela chegar no dublê.
    await new Promise((resolve) => setImmediate(resolve));
    reporter.stop();

    expect(calls).toHaveLength(1);
  });
});
