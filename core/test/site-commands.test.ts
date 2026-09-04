// ============================================================
//  site-commands.test.ts  -  o botão do site acontece aqui, UMA vez.
//
//  Cada caso é um jeito de reiniciar duas vezes, de não reiniciar
//  nunca, ou de deixar o admin olhando "enfileirado" para sempre:
//
//    - o `accepted` sai ANTES da operação, e o desfecho depois;
//    - o id vai para o DISCO antes de a operação começar;
//    - comando expirado NÃO executa — nem pelo prazo do site, nem
//      pelo teto local de 60 s;
//    - kind fora dos três é `refused` + UNKNOWN_KIND, nunca silêncio;
//    - `SERVER_ALREADY_RUNNING` daqui é `SERVER_RUNNING` lá;
//    - erro fora do mapa vira `failed` SEM reason, nunca inventado;
//    - o ACK que se perdeu volta na rodada seguinte.
//
//  Nada aqui sai da máquina: o `fetch` é um dublê.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { SiteCommandsRepository } from '../src/db/site-commands-repository.js';
import { ApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import { SiteClient, type CommandAck } from '../src/site/client.js';
import {
  COMMAND_LOCAL_TTL_MS,
  SiteCommands,
  deadlineOf,
  reasonOf,
  type CommandExecution,
  type SiteCommandKind,
} from '../src/site/commands.js';

const SERVER = 'pvp1';
const NOW = 1_700_000_000_000;
const COMMAND_ID = 'CMD-9f3a1c2b7e04';
const LEASE = 'b7c1cafe';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Canned {
  readonly status: number;
  readonly body?: unknown;
}

interface Call {
  readonly url: string;
  readonly body: unknown;
}

/**
 * O `fetch` de mentira, com uma fila POR ROTA.
 *
 * Por rota, e não uma fila só: o `claim` e o `ack` se intercalam de
 * um jeito que depende do caminho tomado — um comando recusado ACKa
 * uma vez, um executado ACKa duas —, e uma fila única obrigaria cada
 * caso a saber a ordem exata das chamadas para montar as respostas.
 */
function fakeFetch(
  routes: {
    readonly claim?: readonly Canned[];
    readonly ack?: readonly Canned[];
  },
  /** Chamado a cada ida à rede: é onde o relógio de teste anda. */
  onCall?: (route: 'claim' | 'ack') => void,
): { impl: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const at = { claim: 0, ack: 0 };

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const route = href.includes('/commands/claim') ? 'claim' : 'ack';
    const queue = routes[route] ?? [];
    const canned = queue[Math.min(at[route], queue.length - 1)] ?? { status: 200, body: { ok: true } };

    at[route] += 1;
    onCall?.(route);
    calls.push({
      url: href,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });

    return Promise.resolve(
      new Response(canned.body === undefined ? '{}' : JSON.stringify(canned.body), {
        status: canned.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

/** Um comando como o site o manda. */
function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: COMMAND_ID,
    kind: 'server-restart',
    params: {},
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
    ttlMs: 120_000,
    leaseToken: LEASE,
    ...overrides,
  };
}

interface Harness {
  readonly commands: SiteCommands;
  readonly repository: SiteCommandsRepository;
  readonly calls: Call[];
  readonly started: SiteCommandKind[];
  /** Os ACKs que saíram, na ordem, achatados do lote. */
  readonly acks: () => readonly CommandAck[];
}

function harness(
  routes: { readonly claim?: readonly Canned[]; readonly ack?: readonly Canned[] },
  options: {
    readonly enabled?: boolean;
    readonly installed?: boolean;
    readonly execute?: (kind: SiteCommandKind) => Promise<CommandExecution>;
    /** Quanto o relógio anda a cada ida à rede. Zero = parado. */
    readonly drift?: { readonly route: 'claim' | 'ack'; readonly ms: number };
  } = {},
): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const repository = new SiteCommandsRepository(db);
  const clock = { at: NOW };
  const fetch = fakeFetch(routes, (route) => {
    if (options.drift !== undefined && options.drift.route === route) {
      clock.at += options.drift.ms;
    }
  });
  const started: SiteCommandKind[] = [];

  const commands = new SiteCommands({
    client: new SiteClient({
      baseUrl: 'https://site.example',
      token: 'tok',
      serverId: 'RUST01',
      userAgent: 'OrigemZ-Rust-Agent/teste',
      logger: silent,
      fetchImpl: fetch.impl,
    }),
    repository,
    serverId: SERVER,
    enabled: () => options.enabled ?? true,
    installed: () => options.installed ?? true,
    execute: async (kind) => {
      started.push(kind);

      if (options.execute !== undefined) {
        return options.execute(kind);
      }

      return {
        operationId: 'op_7f2c',
        done: Promise.resolve({ status: 'succeeded' as const, message: null }),
      };
    },
    logger: silent,
    now: () => clock.at,
  });

  return {
    commands,
    repository,
    calls: fetch.calls,
    started,
    acks: () =>
      fetch.calls
        .filter((call) => call.url.includes('/commands/ack'))
        .flatMap((call) => (call.body as { commands: CommandAck[] }).commands),
  };
}

/** Uma rodada com UM comando na fila e o resto no default. */
function withCommand(
  overrides: Record<string, unknown> = {},
  options: Parameters<typeof harness>[1] = {},
): Harness {
  return harness(
    { claim: [{ status: 200, body: { ok: true, commands: [command(overrides)] } }] },
    options,
  );
}

describe('deadlineOf', () => {
  it('usa o MENOR dos três: o do site, o relativo e o teto local', () => {
    // O site diz que vale por 40 min — o teto local diz 60 s, e é
    // ele que impede o comando velho de reiniciar um servidor cheio.
    expect(deadlineOf({ expiresAt: new Date(NOW + 2_400_000).toISOString() }, NOW)).toBe(
      NOW + COMMAND_LOCAL_TTL_MS,
    );

    // O relógio do site adiantado: o `expiresAt` ainda permite, o
    // `ttlMs` não.
    expect(
      deadlineOf({ expiresAt: new Date(NOW + 600_000).toISOString(), ttlMs: 30_000 }, NOW),
    ).toBe(NOW + 30_000);

    // O relógio do site ATRASADO: o absoluto já venceu, e ele vence.
    expect(deadlineOf({ expiresAt: new Date(NOW - 1).toISOString(), ttlMs: 120_000 }, NOW)).toBe(
      NOW - 1,
    );
  });

  it('prazo ausente NÃO vira "para sempre": sobra o teto local', () => {
    expect(deadlineOf({}, NOW)).toBe(NOW + COMMAND_LOCAL_TTL_MS);
  });
});

describe('reasonOf', () => {
  it('traduz os dois códigos que mudam de nome no contrato', () => {
    // Repassar `err.code` cru mandaria estes dois para fora do
    // vocabulário fechado — e um valor fora dele é 400 no ACK.
    expect(reasonOf(new ApiError('SERVER_ALREADY_RUNNING', 'x', 409))).toBe('SERVER_RUNNING');
    expect(reasonOf(new ApiError('SERVER_NOT_INSTALLED', 'x', 409))).toBe('NOT_INSTALLED');
  });

  it('a trava de operação vira AGENT_BUSY', () => {
    expect(reasonOf(new ApiError('OPERATION_IN_PROGRESS', 'x', 409))).toBe('AGENT_BUSY');
  });

  it('o que não está no mapa é `null`, e nunca um reason inventado', () => {
    expect(reasonOf(new ApiError('WIPE_MUST_BE_CONFIRMED', 'x', 409))).toBeNull();
    expect(reasonOf(new Error('deu ruim'))).toBeNull();
  });
});

describe('SiteCommands', () => {
  it('o caminho feliz: accepted na hora, executed no desfecho', async () => {
    const test = withCommand();

    await test.commands.poll();

    expect(test.started).toEqual(['server-restart']);

    const acks = test.acks();

    // Duas batidas, e nesta ordem: sem o `accepted`, o painel do
    // site não distingue "o agente não viu" de "está rodando".
    expect(acks).toHaveLength(2);
    expect(acks[0]).toMatchObject({ id: COMMAND_ID, leaseToken: LEASE, status: 'accepted' });
    expect(acks[1]).toMatchObject({
      id: COMMAND_ID,
      leaseToken: LEASE,
      status: 'executed',
      operationId: 'op_7f2c',
    });

    const row = test.repository.get(COMMAND_ID);

    expect(row?.state).toBe('executed');
    expect(row?.operationId).toBe('op_7f2c');
    expect(row?.ackedAt).not.toBeNull();
  });

  it('a linha vai para o DISCO antes de a operação começar', async () => {
    let seen: string | null = null;

    const test = withCommand(
      {},
      {
        execute: (kind) => {
          // A pergunta é feita DE DENTRO da execução: é o instante em
          // que o agente pode cair junto com o servidor.
          seen = test.repository.get(COMMAND_ID)?.state ?? null;

          return Promise.resolve({
            operationId: `op_${kind}`,
            done: Promise.resolve({ status: 'succeeded' as const, message: null }),
          });
        },
      },
    );

    await test.commands.poll();

    expect(seen).toBe('claimed');
  });

  it('o expirado NÃO executa, e volta refused/COMMAND_EXPIRED', async () => {
    const test = withCommand({ expiresAt: new Date(NOW - 1_000).toISOString(), ttlMs: 120_000 });

    await test.commands.poll();

    expect(test.started).toEqual([]);
    expect(test.acks()).toEqual([
      expect.objectContaining({ status: 'refused', reason: 'COMMAND_EXPIRED' }),
    ]);
    // Ele nem vira linha: nada foi executado, e uma linha para um
    // comando que este agente nunca tocou seria ruído.
    expect(test.repository.get(COMMAND_ID)).toBeNull();
  });

  it('o prazo é reconferido DEPOIS do accepted, que custa rede', async () => {
    // O ACK acima custa até o timeout do canal. Um comando que
    // chegou com três segundos de prazo não pode executar depois de
    // uma espera de seis.
    const test = withCommand({ ttlMs: 3_000 }, { drift: { route: 'ack', ms: 6_000 } });

    await test.commands.poll();

    expect(test.started).toEqual([]);
    expect(test.acks().at(-1)).toMatchObject({ status: 'refused', reason: 'COMMAND_EXPIRED' });
    // A linha JÁ existia quando a recusa aconteceu, então ela é
    // gravada: um `claimed` que nunca executou se pareceria, para
    // sempre, com uma queda no meio.
    expect(test.repository.get(COMMAND_ID)?.state).toBe('refused');
  });

  it('o teto local de 60 s corta o que ficou esperando na rodada', async () => {
    // O pior caso do §3, regra 3: o admin clica Reiniciar, a rodada
    // demora, e o comando velho reiniciaria um servidor cheio. O
    // `expiresAt` do site ainda permitiria — o teto local, não.
    const second = 'CMD-000000000002';
    const test = harness(
      {
        claim: [
          {
            status: 200,
            body: {
              ok: true,
              commands: [
                command(),
                command({
                  id: second,
                  expiresAt: new Date(NOW + 40 * 60_000).toISOString(),
                  ttlMs: 40 * 60_000,
                }),
              ],
            },
          },
        ],
      },
      // Cada ida à rede custa 40 s: o primeiro comando gasta duas
      // (o `accepted` e o desfecho), e o segundo chega à sua vez
      // oitenta segundos depois do pull.
      { drift: { route: 'ack', ms: 40_000 } },
    );

    await test.commands.poll();

    expect(test.started).toEqual(['server-restart']);
    // Nem AGENT_BUSY: o prazo é conferido antes, porque um comando
    // vencido não deveria nem disputar a vez.
    expect(test.acks().at(-1)).toMatchObject({ id: second, reason: 'COMMAND_EXPIRED' });
  });

  it('kind fora dos três é refused/UNKNOWN_KIND, e nunca silêncio', async () => {
    const test = withCommand({ kind: 'wipe-run' });

    await test.commands.poll();

    expect(test.started).toEqual([]);
    expect(test.acks()).toEqual([
      expect.objectContaining({ status: 'refused', reason: 'UNKNOWN_KIND' }),
    ]);
  });

  it('servidor desabilitado e jogo fora do disco têm nome próprio', async () => {
    const off = withCommand({}, { enabled: false });

    await off.commands.poll();

    expect(off.acks()).toEqual([
      expect.objectContaining({ status: 'refused', reason: 'SERVER_DISABLED' }),
    ]);

    const bare = withCommand({}, { installed: false });

    await bare.commands.poll();

    // Sem esta checagem o erro seria `OPERATION_NOT_ALLOWED` — que é
    // verdade e não diz nada a quem está do outro lado.
    expect(bare.acks()).toEqual([
      expect.objectContaining({ status: 'refused', reason: 'NOT_INSTALLED' }),
    ]);
  });

  it('a pré-condição vira refused com o reason TRADUZIDO', async () => {
    const test = withCommand(
      { kind: 'server-start' },
      {
        execute: () =>
          Promise.reject(new ApiError('SERVER_ALREADY_RUNNING', 'já está no ar', 409)),
      },
    );

    await test.commands.poll();

    const acks = test.acks();

    expect(acks[0]?.status).toBe('accepted');
    expect(acks[1]).toMatchObject({ status: 'refused', reason: 'SERVER_RUNNING' });
    expect(test.repository.get(COMMAND_ID)?.state).toBe('refused');
  });

  it('erro fora do mapa vira failed SEM reason', async () => {
    const test = withCommand(
      {},
      { execute: () => Promise.reject(new Error('o disco encheu')) },
    );

    await test.commands.poll();

    const last = test.acks().at(-1);

    expect(last?.status).toBe('failed');
    // Um `reason` inventado é 400 do lado do site, e um 400 num ACK
    // deixa a linha pendurada.
    expect(last?.reason).toBeUndefined();
  });

  it('a operação que falha vira failed com o operationId, e sem reason', async () => {
    const test = withCommand(
      {},
      {
        execute: () =>
          Promise.resolve({
            operationId: 'op_dead',
            done: Promise.resolve({ status: 'failed' as const, message: 'o servidor não subiu' }),
          }),
      },
    );

    await test.commands.poll();

    expect(test.acks().at(-1)).toMatchObject({ status: 'failed', operationId: 'op_dead' });
    // A frase em português não vira código: quem quer a causa segue
    // o `operationId` até o log da operação.
    expect(test.acks().at(-1)?.reason).toBeUndefined();
  });

  it('o mesmo id duas vezes NÃO executa duas vezes', async () => {
    const test = harness({
      claim: [
        { status: 200, body: { ok: true, commands: [command()] } },
        { status: 200, body: { ok: true, commands: [command()] } },
      ],
    });

    await test.commands.poll();
    await test.commands.poll();

    // Uma execução, dois ACKs de desfecho: o segundo é o reACK do
    // que já estava gravado.
    expect(test.started).toEqual(['server-restart']);
    expect(test.acks().filter((ack) => ack.status === 'executed')).toHaveLength(2);
  });

  it('o reACK sai com o leaseToken NOVO, e não com o guardado', async () => {
    const test = harness({
      claim: [
        { status: 200, body: { ok: true, commands: [command()] } },
        { status: 200, body: { ok: true, commands: [command({ leaseToken: 'outro' })] } },
      ],
    });

    await test.commands.poll();
    await test.commands.poll();

    // Quem fecha a linha de hoje é o token DESTA reivindicação: com o
    // velho, o site devolveria `unknown` e a linha não mudaria.
    expect(test.acks().at(-1)).toMatchObject({ leaseToken: 'outro', status: 'executed' });
  });

  it('a linha deixada em claimed por uma queda vira indeterminate, e nunca roda', async () => {
    const test = harness({
      claim: [{ status: 200, body: { ok: true, commands: [command()] } }],
    });

    // O rastro de um `pm2 restart` no meio do restart do servidor.
    test.repository.claim(
      { id: COMMAND_ID, serverId: SERVER, kind: 'server-restart', params: '{}', leaseToken: LEASE },
      NOW - 60_000,
    );

    test.commands.stop();
    test.commands.start();
    test.commands.stop();

    expect(test.repository.get(COMMAND_ID)?.state).toBe('indeterminate');

    await test.commands.poll();

    // Ele NÃO re-executa: comando puxado é comando consumido.
    expect(test.started).toEqual([]);
    expect(test.acks().at(-1)).toMatchObject({ status: 'failed' });
    expect(test.acks().at(-1)?.reason).toBeUndefined();
  });

  it('no lote, o segundo comando é AGENT_BUSY — e uma recusa não gasta a vez', async () => {
    const second = 'CMD-000000000002';
    const third = 'CMD-000000000003';
    const test = harness({
      claim: [
        {
          status: 200,
          body: {
            ok: true,
            commands: [
              // Uma recusa primeiro: ela não pode consumir a rodada.
              command({ id: second, kind: 'oxide-install' }),
              command(),
              command({ id: third, kind: 'server-stop' }),
            ],
          },
        },
      ],
    });

    await test.commands.poll();

    expect(test.started).toEqual(['server-restart']);

    const byId = new Map(test.acks().map((ack) => [`${ack.id}:${ack.status}`, ack]));

    expect(byId.get(`${second}:refused`)?.reason).toBe('UNKNOWN_KIND');
    expect(byId.get(`${COMMAND_ID}:executed`)).toBeDefined();
    // O terceiro NÃO vira fila local: a fila é do site, e é lá que
    // ela é visível, cancelável e auditada.
    expect(byId.get(`${third}:refused`)?.reason).toBe('AGENT_BUSY');
  });

  it('o ACK que não passou volta na rodada seguinte', async () => {
    const test = harness({
      claim: [
        { status: 200, body: { ok: true, commands: [command()] } },
        { status: 200, body: { ok: true, commands: [] } },
      ],
      // O `accepted` passa; o desfecho toma 500; a volta seguinte
      // reenvia.
      ack: [{ status: 200, body: { ok: true } }, { status: 500 }, { status: 200, body: { ok: true } }],
    });

    await test.commands.poll();

    expect(test.repository.get(COMMAND_ID)?.ackedAt).toBeNull();

    await test.commands.poll();

    expect(test.repository.get(COMMAND_ID)?.ackedAt).not.toBeNull();
    expect(test.acks().filter((ack) => ack.status === 'executed')).toHaveLength(2);
  });

  it('o ACK que o site não reconhece sai do caminho, mas a linha fica', async () => {
    const test = harness({
      claim: [{ status: 200, body: { ok: true, commands: [command()] } }],
      ack: [
        { status: 200, body: { ok: true } },
        { status: 200, body: { ok: true, unknown: [COMMAND_ID] } },
      ],
    });

    await test.commands.poll();

    // Insistir com o MESMO token daria o mesmo `unknown` para
    // sempre, e o reenvio travaria na primeira linha da fila.
    expect(test.repository.get(COMMAND_ID)?.ackedAt).not.toBeNull();
    // A linha é o comprovante: ela não some.
    expect(test.repository.get(COMMAND_ID)?.state).toBe('executed');
  });

  it('reason fora do vocabulário fechado não chega ao fio', async () => {
    const test = harness({ claim: [{ status: 200, body: { ok: true, commands: [] } }] });

    // O caso real: uma linha gravada por uma versão anterior deste
    // arquivo, reenviada pelo `#resend`. Um valor fora do
    // vocabulário é 400 PARA O LOTE — o desfecho de um comando some
    // por causa do carimbo de outro.
    test.repository.claim(
      { id: COMMAND_ID, serverId: SERVER, kind: 'server-stop', params: '{}', leaseToken: LEASE },
      NOW,
    );
    test.repository.finish(COMMAND_ID, 'refused', { reason: 'SERVER_ALREADY_RUNNING' }, NOW);

    await test.commands.poll();

    // Ele diz MENOS em vez de dizer errado: `refused` exige um
    // `reason` válido, e `failed` aceita a ausência.
    expect(test.acks()).toEqual([
      expect.objectContaining({ id: COMMAND_ID, status: 'failed' }),
    ]);
    expect(test.acks()[0]?.reason).toBeUndefined();
  });

  it('comando sem leaseToken não vira ACK nenhum: sem ele nada fecha', async () => {
    const test = withCommand({ leaseToken: undefined });

    await test.commands.poll();

    expect(test.started).toEqual([]);
    expect(test.acks()).toEqual([]);
  });

  it('fila vazia é a resposta NORMAL: nada sai, nada acende', async () => {
    const test = harness({ claim: [{ status: 200, body: { ok: true, commands: [] } }] });

    await test.commands.poll();

    expect(test.calls.filter((call) => call.url.includes('/ack'))).toEqual([]);
  });

  it('o claim que falha não derruba o laço nem executa nada', async () => {
    const test = harness({ claim: [{ status: 503 }] });

    await expect(test.commands.poll()).resolves.toBeUndefined();
    expect(test.started).toEqual([]);
  });

  it('pede UM comando por rodada: o excedente viraria recusa', async () => {
    const test = harness({ claim: [{ status: 200, body: { ok: true, commands: [] } }] });

    await test.commands.poll();

    expect(test.calls[0]?.body).toEqual({ limit: 1 });
  });
});
