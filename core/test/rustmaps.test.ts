// ============================================================
//  rustmaps.test.ts  -  a prévia do mapa, SEM INTERNET.
//
//  Todo `fetch` deste arquivo é um dublê que devolve o conteúdo
//  de core/test/fixtures/. Nenhuma linha aqui sai da máquina — um
//  teste que depende de um serviço de fora falha no CI por um
//  motivo que não é o dele, e passa a atestar a saúde alheia em
//  vez do nosso código. Ver core/test/fixtures/LEIA-ME.md.
//
//  O que este arquivo guarda:
//
//    1. cada código da API (200, 201, 409, 401, 403, 429) vira o
//       desfecho certo, e o 409 anda pelo MESMO caminho do 201;
//    2. colar uma seed gera a prévia sozinho — quem faz isso é a
//       volta do relógio, sem hook na rota de quem cria a entrada;
//    3. SEM REDE a fila continua inteira, o cartão diz "sem
//       prévia" e o wipe usa a seed. É o aceite da frente;
//    4. chave recusada DESLIGA a geração automática, e a volta
//       seguinte não bate mais na API;
//    5. `generating` tem prazo: passado o teto, a entrada sai do
//       limbo com o motivo escrito;
//    6. `staging` liga SOZINHO quando a entrada vai para um wipe
//       forçado;
//    7. a rota de status nunca devolve a chave.
// ============================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { apiErrorToResponse, isApiError } from '../src/http/error-response.js';
import { registerRustMapsRoutes } from '../src/http/routes/rustmaps.js';
import { registerWipeMapsRoutes } from '../src/http/routes/wipe-maps.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import { RustMapsWatcher } from '../src/wipe/rustmaps-poll.js';
import { RustMapsClient } from '../src/wipe/rustmaps.js';

const SERVER = 'pvp1';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Uma resposta GRAVADA, lida do disco. Ver fixtures/LEIA-ME.md. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as unknown;
}

/** O que o dublê de `fetch` devolve numa chamada. */
interface Canned {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Estourar em vez de responder: é o "sem rede". */
  readonly throws?: Error;
}

interface FakeFetch {
  readonly impl: typeof globalThis.fetch;
  /** Uma linha por chamada: método, caminho e corpo. */
  readonly calls: { method: string; url: string; body: unknown }[];
}

/**
 * O `fetch` de mentira.
 *
 * Recebe a fila de respostas na ordem em que devem sair; a última
 * se repete, para o teste não ter de contar quantas voltas o
 * relógio deu.
 */
function fakeFetch(responses: readonly Canned[]): FakeFetch {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let at = 0;

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const canned = responses[Math.min(at, responses.length - 1)] ?? { status: 500 };

    at += 1;

    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });

    if (canned.throws !== undefined) {
      return Promise.reject(canned.throws);
    }

    return Promise.resolve(
      new Response(canned.body === undefined ? null : JSON.stringify(canned.body), {
        status: canned.status,
        headers: { 'content-type': 'application/json', ...(canned.headers ?? {}) },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

/** Um banco na migração mais recente, com um servidor. */
function database(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'PVP 1',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  return db;
}

const supervisor = { ids: () => [SERVER] } as unknown as ServerSupervisor;

interface Rig {
  readonly db: AgentDatabase;
  readonly pool: MapPoolRepository;
  readonly watcher: RustMapsWatcher;
  readonly fetch: FakeFetch;
  /** O relógio do teste, em ms. Mexer nele é andar no tempo. */
  clock: { now: number };
}

function rig(
  responses: readonly Canned[],
  options: { readonly apiKey?: string; readonly autoGenerate?: boolean } = {},
): Rig {
  const db = database();
  const pool = new MapPoolRepository(db);
  const fetched = fakeFetch(responses);
  const clock = { now: 1_770_000_000_000 };

  const watcher = new RustMapsWatcher({
    client: new RustMapsClient({
      apiKey: options.apiKey ?? 'chave-de-teste',
      fetchImpl: fetched.impl,
    }),
    repository: pool,
    servers: { ids: () => [SERVER] },
    autoGenerate: options.autoGenerate ?? true,
    now: () => clock.now,
  });

  return { db, pool, watcher, fetch: fetched, clock };
}

/** Uma seed na fila, pronta e sem prévia. */
function seedNaFila(pool: MapPoolRepository, seed = '18422', worldSize = 4000): number {
  return pool.add(SERVER, { kind: 'procedural', seed, worldSize }).entry.id;
}

describe('os códigos da API, e o que o agente faz com cada um', () => {
  it('200 grava as URLs e a entrada continua pronta', async () => {
    const bancada = rig([{ status: 200, body: fixture('rustmaps-200-ready') }]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    const entry = bancada.pool.get(SERVER, id);

    expect(entry?.status).toBe('ready');
    expect(entry?.rustmapsId).toBe('b3c1f0a2-9d44-4e77-9a6f-2c1e7f0a5d31');
    expect(entry?.previewUrl).toContain('map.png');
    expect(entry?.thumbUrl).toContain('thumbnail.png');
    expect(entry?.monuments).toContain('Launch Site');
    expect(entry?.monuments).toHaveLength(12);
    expect(entry?.lastError).toBeNull();
  });

  it('201 marca "gerando", guarda o mapId e entra no poll', async () => {
    const bancada = rig([
      { status: 201, body: fixture('rustmaps-201-queued') },
      { status: 200, body: fixture('rustmaps-200-ready') },
    ]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    const gerando = bancada.pool.get(SERVER, id);

    expect(gerando?.status).toBe('generating');
    expect(gerando?.rustmapsId).toBe('7a19c8d5-1f60-4b23-8d0e-55b9a4c2e118');

    // A volta seguinte pergunta pelo ID — e é um GET, não um POST:
    // pedir de novo gastaria cota para a mesma imagem.
    bancada.clock.now += 60_000;
    await bancada.watcher.tick();

    expect(bancada.fetch.calls[1]?.method).toBe('GET');
    expect(bancada.fetch.calls[1]?.url).toContain('7a19c8d5-1f60-4b23-8d0e-55b9a4c2e118');
    expect(bancada.pool.get(SERVER, id)?.status).toBe('ready');
    expect(bancada.pool.get(SERVER, id)?.previewUrl).toContain('map.png');
  });

  it('409 anda pelo MESMO caminho do 201 — o id vem, e só ele', async () => {
    const bancada = rig([{ status: 409, body: fixture('rustmaps-409-exists') }]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    const entry = bancada.pool.get(SERVER, id);

    expect(entry?.status).toBe('generating');
    expect(entry?.rustmapsId).toBe('7a19c8d5-1f60-4b23-8d0e-55b9a4c2e118');
  });

  it('429 não muda o estado da fila, e o agente recua', async () => {
    const bancada = rig([
      { status: 429, body: fixture('rustmaps-429-throttled'), headers: { 'retry-after': '120' } },
    ]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    const entry = bancada.pool.get(SERVER, id);

    // A fila continua exatamente utilizável: instabilidade lá fora
    // não é veredicto sobre o mundo daqui.
    expect(entry?.status).toBe('ready');
    expect(entry?.lastError).toContain('429');
    expect(bancada.watcher.state().backoffUntil).toBe(bancada.clock.now + 120_000);

    // E enquanto o recuo vale, a volta seguinte não bate na API.
    await bancada.watcher.tick();
    expect(bancada.fetch.calls).toHaveLength(1);
  });
});

describe('a chave recusada', () => {
  it('401 desliga a geração automática, e o relógio para de bater na API', async () => {
    const bancada = rig([{ status: 401, body: fixture('rustmaps-401-invalid-key') }]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    const state = bancada.watcher.state();

    expect(state.autoGenerate).toBe(false);
    expect(state.disabledReason).toContain('RUSTMAPS_API_KEY');
    // A frase diz o que fazer, e não devolve um 401 cru.
    expect(bancada.pool.get(SERVER, id)?.lastError).toContain('.env');

    bancada.clock.now += 10 * 60_000;
    await bancada.watcher.tick();

    expect(bancada.fetch.calls).toHaveLength(1);
  });

  it('403 fala de PLANO, e não de chave errada', async () => {
    const bancada = rig([{ status: 403, body: fixture('rustmaps-403-plan') }]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    expect(bancada.pool.get(SERVER, id)?.lastError).toContain('plano');
    expect(bancada.watcher.state().autoGenerate).toBe(false);
  });
});

describe('sem rede — o aceite desta frente', () => {
  it('a fila continua inteira, o cartão diz "sem prévia" e o wipe usa a seed', async () => {
    const bancada = rig([{ status: 0, throws: new Error('getaddrinfo ENOTFOUND api.rustmaps.com') }]);
    const id = seedNaFila(bancada.pool, '90173', 3500);

    await bancada.watcher.tick();

    const entry = bancada.pool.get(SERVER, id);

    expect(entry?.status).toBe('ready');
    expect(entry?.previewUrl).toBeNull();
    expect(entry?.lastError).toContain('sem prévia');
    expect(entry?.lastError).toContain('A seed continua valendo');

    // E é ESTA a linha que importa: o wipe consome a seed do
    // mesmo jeito, sem imagem nenhuma.
    const taken = bancada.pool.takeForWipe(SERVER);

    expect(taken.drawn).toBe(false);
    expect(taken.entry.id).toBe(id);
    expect(taken.entry.seed).toBe('90173');
  });

  it('sem RUSTMAPS_API_KEY o agente não pede nada a ninguém', async () => {
    const bancada = rig([{ status: 200, body: fixture('rustmaps-200-ready') }], { apiKey: '  ' });

    seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    expect(bancada.fetch.calls).toHaveLength(0);

    const status = await bancada.watcher.keyStatus();

    expect(status.configured).toBe(false);
    expect(status.message).toContain('RUSTMAPS_API_KEY');
  });
});

describe('o poll tem teto', () => {
  it('"gerando" há tempo demais sai do limbo com o motivo escrito', async () => {
    const bancada = rig([{ status: 201, body: fixture('rustmaps-201-queued') }]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();
    expect(bancada.pool.get(SERVER, id)?.status).toBe('generating');

    // Meia hora depois o RustMaps não terminou.
    bancada.clock.now += 31 * 60_000;
    await bancada.watcher.tick();

    const entry = bancada.pool.get(SERVER, id);

    expect(entry?.status).not.toBe('generating');
    expect(entry?.lastError).toContain('minutos');
    expect(entry?.lastError).toContain('A seed continua valendo');
  });

  it('um mundo procedural NUNCA some da fila por causa da imagem', async () => {
    // A regra 1 da frente, em teste: a prévia é enfeite. Um
    // `failed` aqui tiraria da fila a seed que o admin escolheu, e
    // o wipe sortearia outra sem ninguém pedir.
    const bancada = rig([{ status: 401, body: fixture('rustmaps-401-invalid-key') }]);
    const id = seedNaFila(bancada.pool);

    await bancada.watcher.tick();

    expect(bancada.pool.next(SERVER)?.id).toBe(id);
    expect(bancada.pool.takeForWipe(SERVER).drawn).toBe(false);
  });
});

describe('o staging liga sozinho', () => {
  it('quando a entrada vai para um wipe FORÇADO, e só então', async () => {
    const bancada = rig([
      { status: 201, body: fixture('rustmaps-201-queued') },
      { status: 201, body: fixture('rustmaps-201-queued') },
    ]);
    const id = seedNaFila(bancada.pool);

    // Sem agenda no banco, não há forçado à vista: staging fica
    // desligado, e prévia sem staging continua sendo prévia.
    await bancada.watcher.generate(SERVER, id);
    expect(bancada.fetch.calls[0]?.body).toMatchObject({ staging: false });
    expect(bancada.pool.get(SERVER, id)?.staging).toBe(false);

    // Agora o próximo wipe é forçado, e esta é a entrada que ele
    // vai consumir.
    bancada.db
      .prepare(
        `INSERT INTO wipe_plans
           (server_id, scheduled_at, kind, bp_policy, map_source, status, pinned,
            created_at, updated_at)
         VALUES (@server, @at, 'forced', 'keep', 'pool', 'planned', 0, @at, @at)`,
      )
      .run({ server: SERVER, at: bancada.clock.now + 86_400_000 });

    const outro = seedNaFila(bancada.pool, '55555', 4000);

    // A primeira da fila continua sendo a #1 — ela é quem o
    // forçado consome.
    expect(bancada.pool.aimedAtForcedWipe(SERVER, id, bancada.clock.now)).toBe(true);
    expect(bancada.pool.aimedAtForcedWipe(SERVER, outro, bancada.clock.now)).toBe(false);

    await bancada.watcher.generate(SERVER, id);
    expect(bancada.fetch.calls[1]?.body).toMatchObject({ staging: true });
    expect(bancada.pool.get(SERVER, id)?.staging).toBe(true);
  });
});

describe('as rotas', () => {
  /**
   * A árvore de rotas sozinha, com o mesmo tratamento de erro do
   * `buildServer`.
   *
   * Ele é repetido aqui porque o que se testa é justamente o
   * CÓDIGO do erro (`MAP_NOT_FOUND`) — sem o handler, o Fastify
   * responderia o genérico dele e o teste passaria a conferir a
   * mensagem do framework.
   */
  async function api(bancada: Rig) {
    const app = Fastify();

    app.setErrorHandler(async (error, _request, reply) => {
      if (isApiError(error)) {
        const response = apiErrorToResponse(error);

        return reply.status(response.statusCode).send(response.body);
      }

      throw error;
    });

    void app.register(
      async (scope) => {
        // As duas frentes juntas de propósito: a fila de mapas
        // declara `/servers/:id/wipe/maps/:mapId` e esta declara
        // `/servers/:id/wipe/maps/:mapId/generate`. O
        // `find-my-way` recusa, no `ready()`, o mesmo lugar da URL
        // com nomes de parâmetro diferentes — e essa recusa
        // aconteceria na SUBIDA do agente, não num teste que
        // montasse só as minhas rotas.
        registerWipeMapsRoutes(scope, {
          repository: bancada.pool,
          supervisor,
          checkMapUrl: () =>
            Promise.resolve({ ok: false, code: 'MAP_URL_UNREACHABLE', message: 'sem rede no teste' }),
        });

        registerRustMapsRoutes(scope, {
          watcher: bancada.watcher,
          repository: bancada.pool,
          supervisor,
        });

        return Promise.resolve();
      },
      { prefix: '/api' },
    );

    await app.ready();

    return app;
  }

  it('sobem na mesma árvore que a fila de mapas, sem caminho repetido', async () => {
    const bancada = rig([{ status: 200, body: fixture('rustmaps-200-ready') }]);
    const id = seedNaFila(bancada.pool);

    // O `ready()` do Fastify já rodou dentro de `api()`: se as
    // duas frentes brigassem, este teste nem chegaria aqui.
    const app = await api(bancada);

    const fila = await app.inject({ method: 'GET', url: `/api/servers/${SERVER}/wipe/maps` });
    const previa = await app.inject({
      method: 'POST',
      url: `/api/servers/${SERVER}/wipe/maps/${String(id)}/generate`,
      payload: {},
    });

    expect(fila.statusCode).toBe(200);
    expect(previa.statusCode).toBe(200);

    await app.close();
  });

  it('o status responde válida/inválida, plano e cota — e NUNCA a chave', async () => {
    const bancada = rig([
      {
        status: 404,
        body: { meta: { statusCode: 404 }, data: null },
        headers: {
          'x-rate-limit-limit': '100',
          'x-rate-limit-remaining': '62',
        },
      },
    ]);

    const app = await api(bancada);
    const response = await app.inject({ method: 'GET', url: '/api/wipe/rustmaps/status' });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      configured: boolean;
      valid: boolean | null;
      plan: string | null;
      quota: { limit: number | null; remaining: number | null };
      announcedRateLimit: number;
    }>();

    expect(body.configured).toBe(true);
    // 404 é o mapa que não existe, e não a chave que não serve.
    expect(body.valid).toBe(true);
    expect(body.plan).toBeNull();
    expect(body.quota).toMatchObject({ limit: 100, remaining: 62 });
    expect(body.announcedRateLimit).toBe(60);
    expect(response.body).not.toContain('chave-de-teste');

    await app.close();
  });

  it('a chave inválida vira uma frase que diz o que fazer', async () => {
    const bancada = rig([{ status: 401, body: fixture('rustmaps-401-invalid-key') }]);
    const app = await api(bancada);

    const response = await app.inject({ method: 'GET', url: '/api/wipe/rustmaps/status' });
    const body = response.json<{ valid: boolean | null; message: string }>();

    expect(response.statusCode).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.message).toContain('.env');
    expect(body.message).toContain('rustmaps.com/dashboard');

    await app.close();
  });

  it('gerar sob demanda responde 200 mesmo com o RustMaps fora do ar', async () => {
    const bancada = rig([{ status: 0, throws: new Error('fetch failed') }]);
    const id = seedNaFila(bancada.pool);
    const app = await api(bancada);

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${SERVER}/wipe/maps/${String(id)}/generate`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ outcome: string }>().outcome).toBe('offline');
    // O que não pode acontecer: a tela pintar de vermelho uma fila
    // perfeitamente utilizável.
    expect(bancada.pool.next(SERVER)?.id).toBe(id);

    await app.close();
  });

  it('gerar um mapa que não está na fila é 404, e não 500', async () => {
    const bancada = rig([{ status: 200, body: fixture('rustmaps-200-ready') }]);
    const app = await api(bancada);

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${SERVER}/wipe/maps/999/generate`,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('MAP_NOT_FOUND');

    await app.close();
  });
});
