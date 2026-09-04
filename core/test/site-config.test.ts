// ============================================================
//  site-config.test.ts  -  a config do site vira `.ini` daqui.
//
//  Cada caso é um jeito de gravar o que não devia, de não gravar o
//  que devia, ou de reescrever o mesmo arquivo para sempre:
//
//    - `version` é o que diz se há trabalho: a igual não faz nada;
//    - campo AUSENTE é "o site não opina", nunca "apague";
//    - campo que o agente não grava vai em `errors[]` — porque o
//      `updateSettings` o IGNORARIA em silêncio;
//    - `requiresRestart` é o que o `updateSettings` devolveu, e não
//      uma lista escrita à mão;
//    - a versão é gravada mesmo quando a gravação falha, senão o
//      `.ini` seria reescrito a cada 30 s, para sempre;
//    - o ACK que se perdeu volta na volta seguinte, inclusive no 304.
//
//  Nada aqui sai da máquina: o `fetch` é um dublê.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import {
  CONFIG_ACK_KEY,
  CONFIG_ETAG_KEY,
  CONFIG_VERSION_KEY,
  SiteConfig,
  planOfDesired,
} from '../src/site/config.js';

const SERVER = 'pvp1';
const NOW = 1_700_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Canned {
  readonly status: number;
  readonly body?: unknown;
  readonly etag?: string;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly ifNoneMatch: string | null;
}

function fakeFetch(routes: {
  readonly get?: readonly Canned[];
  readonly ack?: readonly Canned[];
}): { impl: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const at = { get: 0, ack: 0 };

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const route = href.endsWith('/server/config') ? 'get' : 'ack';
    const queue = routes[route] ?? [];
    const canned = queue[Math.min(at[route], queue.length - 1)] ?? {
      status: 200,
      body: { ok: true },
    };

    at[route] += 1;
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      ifNoneMatch: ((init?.headers ?? {}) as Record<string, string>)['If-None-Match'] ?? null,
    });

    return Promise.resolve(
      new Response(canned.status === 304 || canned.body === undefined ? null : JSON.stringify(canned.body), {
        status: canned.status,
        headers: {
          'content-type': 'application/json',
          ...(canned.etag === undefined ? {} : { etag: canned.etag }),
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

interface Harness {
  readonly config: SiteConfig;
  readonly meta: MetaRepository;
  readonly calls: Call[];
  /** Os patches que chegaram ao `updateSettings`, na ordem. */
  readonly patches: Record<string, unknown>[];
  /** O que chegou ao `enable`/`disable`, na ordem. */
  readonly enabling: boolean[];
  /** O que chegou ao vigia da Steam, na ordem. */
  readonly autoUpdating: boolean[];
  readonly acks: () => readonly Record<string, unknown>[];
}

function harness(
  routes: { readonly get?: readonly Canned[]; readonly ack?: readonly Canned[] },
  options: {
    readonly apply?: (patch: Record<string, string | number | boolean>) => readonly string[];
    /** Ausente = o caminho do `enabled` NÃO está montado. */
    readonly setEnabled?: ((value: boolean) => void) | null;
    /** `null` = o caminho da atualização automática NÃO está montado. */
    readonly setAutoUpdate?: ((value: boolean) => void) | null;
  } = {},
): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const meta = new MetaRepository(db);
  const fetch = fakeFetch(routes);
  const patches: Record<string, unknown>[] = [];
  const enabling: boolean[] = [];
  const autoUpdating: boolean[] = [];

  const config = new SiteConfig({
    client: new SiteClient({
      baseUrl: 'https://site.example',
      token: 'tok',
      serverId: 'RUST01',
      userAgent: 'OrigemZ-Rust-Agent/teste',
      logger: silent,
      fetchImpl: fetch.impl,
    }),
    meta,
    serverId: SERVER,
    apply: (patch) => {
      patches.push(patch);

      return options.apply?.(patch) ?? Object.keys(patch).filter((field) => field !== 'name');
    },
    // `null` é o jeito de dizer "não montado" sem cair no default.
    ...(options.setEnabled === null
      ? {}
      : {
          setEnabled: (value: boolean): Promise<void> => {
            enabling.push(value);
            options.setEnabled?.(value);

            return Promise.resolve();
          },
        }),
    ...(options.setAutoUpdate === null
      ? {}
      : {
          setAutoUpdate: (value: boolean): void => {
            autoUpdating.push(value);
            options.setAutoUpdate?.(value);
          },
        }),
    logger: silent,
    now: () => NOW,
  });

  return {
    config,
    meta,
    calls: fetch.calls,
    patches,
    enabling,
    autoUpdating,
    acks: () =>
      fetch.calls
        .filter((call) => call.url.endsWith('/server/config/ack'))
        .map((call) => call.body as Record<string, unknown>),
  };
}

describe('planOfDesired', () => {
  it('separa o que o agente grava do que ele não grava', () => {
    // ####  A ARMADILHA MEDIDA  ####
    //
    // `updateSettings` faz `if (key === undefined) continue`: campo
    // desconhecido não gera erro, ele DESAPARECE. Sem esta régua o
    // ACK diria `applied: true, errors: []` e o site concluiria que
    // a config está valendo.
    const plan = planOfDesired({ hostname: 'OrigemZ #1', pvpMode: 'hardcore' });

    expect(plan.patch).toEqual({ hostname: 'OrigemZ #1' });
    expect(plan.errors).toEqual([{ field: 'pvpMode', code: 'UNKNOWN_FIELD' }]);
  });

  it('recusa o valor fora da régua, campo a campo', () => {
    // Um `worldSize` de 40000 derrubaria o servidor no próximo
    // start, longe de quem gravou.
    const plan = planOfDesired({ worldSize: 40_000, seed: -1, map: 'Ilha', maxPlayers: 200 });

    expect(plan.patch).toEqual({ maxPlayers: 200 });
    expect(plan.errors).toEqual([
      { field: 'worldSize', code: 'INVALID_VALUE' },
      { field: 'seed', code: 'INVALID_VALUE' },
      { field: 'map', code: 'INVALID_VALUE' },
    ]);
  });

  it('descrição vazia é legítima: é como se tira a do servidor', () => {
    expect(planOfDesired({ description: '' })).toEqual({
      patch: { description: '' },
      enabled: null,
      autoUpdate: null,
      errors: [],
    });
  });

  it('a tela de configuração INTEIRA atravessa o canal', () => {
    // A lista aqui é a do `patchSchema` de `routes/servers.ts`, menos
    // o pareamento. Um campo que a tela local edita e este teste não
    // cita é um campo que só existe para quem está na máquina.
    const plan = planOfDesired({
      name: 'PVP 1',
      hostname: 'OrigemZ PvP',
      description: 'X5',
      url: 'https://origemz.com',
      headerImage: 'https://origemz.com/header.png',
      map: 'Procedural Map',
      worldSize: 3_500,
      seed: 12_345,
      levelUrl: 'https://mapas.example/mundo.map',
      maxPlayers: 200,
      saveInterval: 600,
      identity: 'pvp1-set',
      gamePort: 28_015,
      queryPort: 28_017,
      appPort: 28_082,
      rconPort: 28_016,
      rconPassword: 'uma-senha-boa',
      steamAppId: '258550',
      steamLogin: 'anonymous',
      steamBranch: '',
      consoleWindow: false,
    });

    expect(plan.errors).toEqual([]);
    expect(Object.keys(plan.patch)).toHaveLength(21);
  });

  it('o pareamento NÃO atravessa: ele é o que segura o próprio canal', () => {
    // Um `siteToken` errado gravado por aqui derrubaria o canal que o
    // gravou, e o conserto seria presencial. O código é PRÓPRIO: o
    // site precisa distinguir "não conheço" de "recuso por desenho".
    const plan = planOfDesired({ siteServerId: 'RUST02', siteToken: 'seja-o-que-for' });

    expect(plan.patch).toEqual({});
    expect(plan.errors).toEqual([
      { field: 'siteServerId', code: 'FIELD_NOT_REMOTELY_WRITABLE' },
      { field: 'siteToken', code: 'FIELD_NOT_REMOTELY_WRITABLE' },
    ]);
  });

  it('a senha de RCON com espaço ou barra é recusada ANTES de virar linha do .ini', () => {
    // O WebRCON transporta a senha no CAMINHO da URL, e o Rust
    // compara o caminho cru: uma senha com "/" nunca conecta.
    const plan = planOfDesired({ rconPassword: 'senha com espaço', identity: 'Mundo Novo' });

    expect(plan.patch).toEqual({});
    expect(plan.errors).toEqual([
      { field: 'rconPassword', code: 'INVALID_VALUE' },
      { field: 'identity', code: 'INVALID_VALUE' },
    ]);
  });

  it('`enabled` sai do patch: ele não passa pelo updateSettings', () => {
    // `KEY_OF` não tem `enabled`: mandá-lo no mesmo patch faria o
    // `updateSettings` ignorá-lo em silêncio.
    const plan = planOfDesired({ enabled: true, hostname: 'OrigemZ #1' });

    expect(plan.patch).toEqual({ hostname: 'OrigemZ #1' });
    expect(plan.enabled).toBe(true);
    expect(plan.errors).toEqual([]);
  });

  it('`enabled` que não é booleano é valor inválido, não campo desconhecido', () => {
    const plan = planOfDesired({ enabled: 'sim' });

    expect(plan.enabled).toBeNull();
    expect(plan.errors).toEqual([{ field: 'enabled', code: 'INVALID_VALUE' }]);
  });
});

describe('SiteConfig', () => {
  it('grava o mapa novo e ACKa com o requiresRestart REAL', async () => {
    const test = harness({
      get: [
        {
          status: 200,
          etag: 'W/"v7"',
          body: {
            ok: true,
            version: 7,
            desired: { map: 'Barren', worldSize: 3_500, seed: 1_234_567 },
          },
        },
      ],
    });

    await test.config.pull();

    expect(test.patches).toEqual([{ map: 'Barren', worldSize: 3_500, seed: 1_234_567 }]);
    expect(test.acks()).toEqual([
      {
        version: 7,
        applied: true,
        // Ele é o RETORNO do `updateSettings`, e não uma lista
        // escrita à mão: é o que faz o painel do site dizer
        // "gravado, vale no próximo start" em vez de "salvo".
        requiresRestart: ['map', 'worldSize', 'seed'],
        errors: [],
      },
    ]);
    expect(test.meta.read(`${CONFIG_VERSION_KEY}.${SERVER}`)).toBe('7');
    expect(test.meta.read(`${CONFIG_ETAG_KEY}.${SERVER}`)).toBe('W/"v7"');
    // Confirmado: nada pendente.
    expect(test.meta.read(`${CONFIG_ACK_KEY}.${SERVER}`)).toBeNull();
  });

  it('liga o servidor pelo caminho próprio, DEPOIS de gravar o resto', async () => {
    const order: string[] = [];
    const test = harness(
      {
        get: [
          {
            status: 200,
            body: { ok: true, version: 8, desired: { gamePort: 28_115, enabled: true } },
          },
        ],
      },
      {
        apply: (patch) => {
          order.push(`apply:${Object.keys(patch).join(',')}`);

          return Object.keys(patch);
        },
        setEnabled: (value) => {
          order.push(`enabled:${String(value)}`);
        },
      },
    );

    await test.config.pull();

    // Ligar um servidor cujas portas acabaram de mudar é subir com a
    // config nova, e não com a que ele tinha quando a rodada começou.
    expect(order).toEqual(['apply:gamePort', 'enabled:true']);
    expect(test.patches).toEqual([{ gamePort: 28_115 }]);
    expect(test.enabling).toEqual([true]);
    expect(test.acks()).toEqual([
      { version: 8, applied: true, requiresRestart: ['gamePort'], errors: [] },
    ]);
  });

  it('sem o caminho do enabled montado, o site ouve a recusa em vez de um applied mentiroso', async () => {
    const test = harness(
      { get: [{ status: 200, body: { ok: true, version: 9, desired: { enabled: false } } }] },
      { setEnabled: null },
    );

    await test.config.pull();

    expect(test.enabling).toEqual([]);
    expect(test.acks()).toEqual([
      {
        version: 9,
        applied: false,
        requiresRestart: [],
        errors: [{ field: 'enabled', code: 'FIELD_NOT_REMOTELY_WRITABLE' }],
      },
    ]);
  });

  it('ligar o que não está instalado vira o código real do agente, e o resto entra', async () => {
    const test = harness(
      {
        get: [
          {
            status: 200,
            body: { ok: true, version: 10, desired: { hostname: 'OrigemZ #1', enabled: true } },
          },
        ],
      },
      {
        setEnabled: () => {
          throw new ApiError('SERVER_NOT_INSTALLED', 'o jogo ainda não está em disco', 409);
        },
      },
    );

    await test.config.pull();

    // O hostname entrou: `applied` é sobre a gravação que aconteceu,
    // e o campo que não entrou aparece com o código que diz o que
    // fazer.
    expect(test.patches).toEqual([{ hostname: 'OrigemZ #1' }]);
    expect(test.acks()).toEqual([
      {
        version: 10,
        applied: true,
        requiresRestart: ['hostname'],
        errors: [{ field: 'enabled', code: 'SERVER_NOT_INSTALLED' }],
      },
    ]);
  });

  it('campo AUSENTE é "o site não opina", e não "apague"', async () => {
    const test = harness({
      get: [{ status: 200, body: { ok: true, version: 1, desired: { hostname: 'OrigemZ #1' } } }],
    });

    await test.config.pull();

    expect(test.patches).toEqual([{ hostname: 'OrigemZ #1' }]);
  });

  it('a mesma versão não faz nada: config é estado, não tarefa', async () => {
    const test = harness({
      get: [
        { status: 200, body: { ok: true, version: 4, desired: { maxPlayers: 100 } } },
        { status: 200, body: { ok: true, version: 4, desired: { maxPlayers: 100 } } },
      ],
    });

    await test.config.pull();
    await test.config.pull();

    expect(test.patches).toHaveLength(1);
    expect(test.acks()).toHaveLength(1);
  });

  it('manda If-None-Match na volta seguinte, e o 304 não aplica nada', async () => {
    const test = harness({
      get: [
        { status: 200, etag: '"abc"', body: { ok: true, version: 2, desired: { seed: 42 } } },
        { status: 304 },
      ],
    });

    await test.config.pull();
    await test.config.pull();

    expect(test.calls[0]?.ifNoneMatch).toBeNull();
    // A volta barata: um 304 sem corpo é o desfecho normal deste
    // laço, e ele não pode aparecer como falha.
    expect(test.calls.at(-1)?.ifNoneMatch).toBe('"abc"');
    expect(test.patches).toHaveLength(1);
  });

  it('o ACK que não passou volta na volta seguinte, mesmo num 304', async () => {
    const test = harness({
      get: [
        { status: 200, etag: '"v9"', body: { ok: true, version: 9, desired: { maxPlayers: 150 } } },
        { status: 304 },
      ],
      ack: [{ status: 500 }, { status: 200, body: { ok: true } }],
    });

    await test.config.pull();

    expect(test.meta.read(`${CONFIG_ACK_KEY}.${SERVER}`)).not.toBeNull();

    await test.config.pull();

    // A gravação NÃO se repete — ela já aconteceu; o que se repete é
    // o ACK, que é o que o site ainda não ouviu.
    expect(test.patches).toHaveLength(1);
    expect(test.acks()).toHaveLength(2);
    expect(test.acks()[1]).toMatchObject({ version: 9, applied: true });
    expect(test.meta.read(`${CONFIG_ACK_KEY}.${SERVER}`)).toBeNull();
  });

  it('o campo que o agente não grava vai em errors, e o resto entra', async () => {
    const test = harness({
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 3,
            desired: { hostname: 'OrigemZ #1', pvpMode: 'hardcore', worldSize: 99 },
          },
        },
      ],
    });

    await test.config.pull();

    expect(test.patches).toEqual([{ hostname: 'OrigemZ #1' }]);
    expect(test.acks()[0]).toMatchObject({
      version: 3,
      // A gravação aconteceu, mesmo com campo em `errors[]`.
      applied: true,
      errors: [
        { field: 'pvpMode', code: 'UNKNOWN_FIELD' },
        { field: 'worldSize', code: 'INVALID_VALUE' },
      ],
    });
  });

  it('a gravação que falha vira applied:false com o código do erro, e NÃO reaplica', async () => {
    const test = harness(
      {
        get: [
          { status: 200, body: { ok: true, version: 5, desired: { maxPlayers: 300 } } },
          { status: 200, body: { ok: true, version: 5, desired: { maxPlayers: 300 } } },
        ],
      },
      {
        apply: () => {
          throw new ApiError('PORT_IN_USE', 'a porta já é de outro servidor', 409);
        },
      },
    );

    await test.config.pull();
    await test.config.pull();

    expect(test.acks()[0]).toMatchObject({
      version: 5,
      applied: false,
      requiresRestart: [],
      errors: [{ field: 'maxPlayers', code: 'PORT_IN_USE' }],
    });
    // ####  A VERSÃO É GRAVADA MESMO ASSIM  ####
    //
    // Sem isso, o `.ini` seria reescrito a cada 30 s, para sempre,
    // por um campo que nunca vai entrar. Quem conserta é o admin, no
    // site, gerando uma versão nova.
    expect(test.meta.read(`${CONFIG_VERSION_KEY}.${SERVER}`)).toBe('5');
    expect(test.patches).toHaveLength(1);
  });

  it('desired vazio não é erro: não há o que gravar, e o site fica sabendo', async () => {
    const test = harness({
      get: [{ status: 200, body: { ok: true, version: 2, desired: {} } }],
    });

    await test.config.pull();

    expect(test.patches).toEqual([]);
    expect(test.acks()[0]).toMatchObject({ version: 2, applied: true, errors: [] });
  });

  it('config sem version não aplica nada: não daria para dizer o que o ACK fecha', async () => {
    const test = harness({
      get: [{ status: 200, body: { ok: true, desired: { maxPlayers: 10 } } }],
    });

    await test.config.pull();

    expect(test.patches).toEqual([]);
    expect(test.acks()).toEqual([]);
  });

  it('autoUpdate desligado pelo site chega ao vigia, e NÃO vira patch do .ini', async () => {
    // ####  QUEM APLICA NÃO É O `updateSettings`  ####
    //
    // `autoUpdate` não existe em `KEY_OF`, e o `updateSettings`
    // ignora em silêncio o que não conhece. Se ele entrasse no
    // patch, o ACK diria `applied: true` e o site concluiria que a
    // atualização automática está desligada enquanto ela continua
    // ligada — e o sintoma só apareceria semanas depois, no dia em
    // que a Facepunch publicasse.
    const test = harness({
      get: [
        {
          status: 200,
          body: { ok: true, version: 12, desired: { hostname: 'OrigemZ #1', autoUpdate: false } },
        },
      ],
    });

    await test.config.pull();

    expect(test.patches).toEqual([{ hostname: 'OrigemZ #1' }]);
    expect(test.autoUpdating).toEqual([false]);
    expect(test.acks()[0]).toMatchObject({ version: 12, applied: true, errors: [] });
  });

  it('autoUpdate ausente NÃO é `false`: o site simplesmente não opina', async () => {
    // A armadilha da coluna `NOT NULL DEFAULT false` do outro lado:
    // o admin abre a tela para acertar o hostname, grava, e o
    // `desired` sai carregando um `autoUpdate: false` que ninguém
    // escolheu. Ausente tem de chegar aqui como ausência.
    const test = harness({
      get: [{ status: 200, body: { ok: true, version: 13, desired: { hostname: 'OrigemZ #2' } } }],
    });

    await test.config.pull();

    expect(test.autoUpdating).toEqual([]);
  });

  it('a string "false" é INVALID_VALUE — coagi-la ligaria o que o site desligou', async () => {
    // `Boolean('false') === true`: coagir aqui LIGARIA a atualização
    // automática que o site pediu para desligar.
    const test = harness({
      get: [{ status: 200, body: { ok: true, version: 14, desired: { autoUpdate: 'false' } } }],
    });

    await test.config.pull();

    expect(test.autoUpdating).toEqual([]);
    expect(test.acks()[0]).toMatchObject({
      version: 14,
      applied: false,
      errors: [{ field: 'autoUpdate', code: 'INVALID_VALUE' }],
    });
  });

  it('sem o vigia montado, autoUpdate volta em errors[] — nunca applied em silêncio', async () => {
    const test = harness(
      {
        get: [{ status: 200, body: { ok: true, version: 15, desired: { autoUpdate: true } } }],
      },
      { setAutoUpdate: null },
    );

    await test.config.pull();

    expect(test.acks()[0]).toMatchObject({
      version: 15,
      applied: false,
      errors: [{ field: 'autoUpdate', code: 'FIELD_NOT_REMOTELY_WRITABLE' }],
    });
  });

  it('erro do canal não derruba o laço, e a volta seguinte tenta de novo', async () => {
    const test = harness({ get: [{ status: 503 }] });

    await expect(test.config.pull()).resolves.toBeUndefined();
    expect(test.patches).toEqual([]);
    expect(test.config.health.appliedVersion).toBeNull();
  });
});
