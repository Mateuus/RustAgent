// ============================================================
//  site-deliveries.test.ts  -  o que foi comprado no site chega.
//
//  Cada caso aqui é um jeito de entregar duas vezes, de não entregar
//  nunca, ou de devolver ao inventário um item que já saiu:
//
//    - a RESERVA acontece antes do comando (queda no meio);
//    - `deferred` preserva, `failed` devolve — e trocá-los custa;
//    - `RCON_UNAVAILABLE` vem do CÓDIGO, não da mensagem;
//    - a rodada PAGINA: sem isso a tarefa nº 51 nunca é vista;
//    - `INVALID_CURSOR` joga o cursor fora, e não vira laço;
//    - `unknown` no ACK não significa "não aconteceu";
//    - as duas tarefas de VIP não esperam o jogador entrar, e não
//      ter o que tirar é sucesso.
//
//  Nada aqui sai da máquina: o `fetch` é um dublê.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { SiteDeliveriesRepository } from '../src/db/site-deliveries-repository.js';
import { ApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import { SiteDeliveries, ackOf, planOfPayload } from '../src/site/deliveries.js';
import type { DeliveryPlan } from '../src/store/service.js';

const SERVER = 'pvp1';
const STEAM_ID = '76561198000000000';
const NOW = 1_700_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Canned {
  readonly status: number;
  readonly body?: unknown;
}

interface Call {
  readonly url: string;
  readonly body: unknown;
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

interface Delivered {
  readonly steamId: string;
  readonly plan: DeliveryPlan;
}

interface Revoked {
  readonly steamId: string;
  readonly tier: string;
}

function harness(
  responses: readonly Canned[],
  options: {
    readonly online?: readonly string[] | null;
    readonly deliver?: () => Promise<void>;
    readonly revoke?: () => Promise<void>;
    /** O agente sem concessor de VIP ligado. */
    readonly withoutVips?: boolean;
  } = {},
): {
  readonly queue: SiteDeliveries;
  readonly repository: SiteDeliveriesRepository;
  readonly calls: Call[];
  readonly delivered: Delivered[];
  readonly revoked: Revoked[];
} {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const repository = new SiteDeliveriesRepository(db);
  const fetch = fakeFetch(responses);
  const delivered: Delivered[] = [];
  const revoked: Revoked[] = [];

  const queue = new SiteDeliveries({
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
    presence: () =>
      Promise.resolve(options.online === undefined ? [STEAM_ID] : options.online),
    deliver: async (input) => {
      if (options.deliver !== undefined) {
        await options.deliver();
      }

      delivered.push({ steamId: input.steamId, plan: input.plan });
    },
    revokeVip:
      options.withoutVips === true
        ? undefined
        : async (input): Promise<void> => {
            if (options.revoke !== undefined) {
              await options.revoke();
            }

            revoked.push({ steamId: input.steamId, tier: input.tier });
          },
    logger: silent,
    now: () => NOW,
  });

  return { queue, repository, calls: fetch.calls, delivered, revoked };
}

/** Uma tarefa de item, como o site a manda. */
function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'DLV-9f3a1c2b7e04',
    steamId: STEAM_ID,
    kind: 'item',
    payload: { items: [{ shortname: 'metal.refined', amount: 100, skinId: '0' }] },
    sourceRef: 'ITM-4b81c9e2a017',
    attempts: 0,
    ...over,
  };
}

/** Uma tarefa de revogação, como o sweep do site a manda. */
function revokeTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'DLV-0aa1bb2cc3d4',
    steamId: STEAM_ID,
    kind: 'vip_revoke',
    payload: { tier: 'gold' },
    sourceRef: 'ITM-4b81c9e2a017',
    ...over,
  };
}

function page(tasks: readonly unknown[], next: string | null = null): Canned {
  return { status: 200, body: { ok: true, deliveries: tasks, next } };
}

const ACK_OK: Canned = { status: 200, body: { ok: true, applied: 1, unknown: [] } };

/**
 * Só os ACKs enviados, na ordem, SEM o `at`.
 *
 * O carimbo é o relógio do agente, e não o desfecho: mantê-lo aqui
 * faria toda expectativa carregar um número que não diz nada sobre
 * a entrega. Ele tem um caso próprio.
 */
function acksOf(calls: readonly Call[]): { id: string; status: string; reason?: string }[] {
  return calls
    .filter((call) => call.url.includes('/deliveries/ack'))
    .flatMap(
      (call) =>
        (call.body as { deliveries: { id: string; status: string; reason?: string; at: string }[] })
          .deliveries,
    )
    .map(({ at: _at, ...rest }) => rest);
}

describe('a entrega de uma tarefa', () => {
  it('reserva ANTES do comando, entrega e ACKa delivered', async () => {
    const { queue, repository, calls, delivered } = harness([page([task()]), ACK_OK]);

    await queue.poll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.plan.items[0]?.amount).toBe(100);
    // `units` é sempre 1: o `amount` que veio da fila JÁ é o total.
    expect(delivered[0]?.plan.units).toBe(1);
    expect(repository.get('DLV-9f3a1c2b7e04')?.state).toBe('delivered');
    expect(acksOf(calls)).toEqual([{ id: 'DLV-9f3a1c2b7e04', status: 'delivered' }]);
  });

  it('jogador offline: adia, sem comando e SEM reserva', async () => {
    const { queue, repository, calls, delivered } = harness([page([task()]), ACK_OK], {
      online: [],
    });

    await queue.poll();

    expect(delivered).toHaveLength(0);
    // Sem linha local: a tarefa não é nossa ainda.
    expect(repository.get('DLV-9f3a1c2b7e04')).toBeNull();
    expect(acksOf(calls)).toEqual([
      { id: 'DLV-9f3a1c2b7e04', status: 'deferred', reason: 'PLAYER_OFFLINE' },
    ]);
  });

  it('presença indisponível: adia com motivo PRÓPRIO', async () => {
    // "Não deu para perguntar" é diferente de "ele não está aqui", e
    // nada é tentado às cegas.
    const { queue, calls, delivered } = harness([page([task()]), ACK_OK], { online: null });

    await queue.poll();

    expect(delivered).toHaveLength(0);
    expect(acksOf(calls)[0]?.reason).toBe('PRESENCE_UNAVAILABLE');
  });

  it('RCON fora chega como DEFERRED, e não como falha definitiva', async () => {
    // ####  O CÓDIGO, E NÃO A MENSAGEM  ####
    //
    // O `disconnectedRcon` rejeita com um `ApiError` cuja mensagem
    // está em PORTUGUÊS. Quem lê `error.message` classifica isso como
    // falha desconhecida e manda `failed` DEFINITIVO — o item pago
    // volta ao inventário porque o RCON piscou.
    const { queue, repository, calls } = harness([page([task()]), ACK_OK], {
      deliver: () =>
        Promise.reject(
          new ApiError('RCON_UNAVAILABLE', 'O agente não está conectado ao RCON do servidor.', 503),
        ),
    });

    await queue.poll();

    expect(acksOf(calls)[0]?.status).toBe('deferred');
    expect(acksOf(calls)[0]?.reason).toBe('RCON_UNAVAILABLE');
    // A reserva é SOLTA: o comando respondeu que não deu, e resposta
    // não é dúvida — a próxima rodada tenta limpo.
    expect(repository.get('DLV-9f3a1c2b7e04')).toBeNull();
  });

  it('uma falha DEFINITIVA fecha a linha e devolve o item ao site', async () => {
    const { queue, repository, calls } = harness([page([task()]), ACK_OK], {
      deliver: () => Promise.reject(new Error('ITEM_NOT_FOUND')),
    });

    await queue.poll();

    expect(acksOf(calls)[0]).toEqual({
      id: 'DLV-9f3a1c2b7e04',
      status: 'failed',
      reason: 'ITEM_NOT_FOUND',
    });
    expect(repository.get('DLV-9f3a1c2b7e04')?.state).toBe('failed');
  });

  it('payload fora da régua NÃO é executado', async () => {
    const { queue, calls, delivered } = harness(
      [page([task({ payload: { items: [{ shortname: 'metal refined', amount: 100 }] } })]), ACK_OK],
      {},
    );

    await queue.poll();

    expect(delivered).toHaveLength(0);
    expect(acksOf(calls)[0]).toEqual({
      id: 'DLV-9f3a1c2b7e04',
      status: 'failed',
      reason: 'PAYLOAD_INVALID',
    });
  });
});

describe('a tarefa que já conhecemos', () => {
  it('já entregue: reACKa e NÃO executa de novo', async () => {
    const { queue, repository, calls, delivered } = harness([page([task()]), ACK_OK]);

    repository.reserve(
      {
        id: 'DLV-9f3a1c2b7e04',
        serverId: SERVER,
        steamId: STEAM_ID,
        kind: 'item',
        payload: '{}',
        sourceRef: null,
      },
      NOW,
    );
    repository.finish('DLV-9f3a1c2b7e04', 'delivered', null, NOW);

    await queue.poll();

    expect(delivered).toHaveLength(0);
    expect(acksOf(calls)[0]?.status).toBe('delivered');
  });

  it('órfã em reserved: vira indeterminate e ACKa deferred', async () => {
    // ####  O PROCESSO MORREU ENTRE O COMANDO E O ACK  ####
    //
    // Reexecutar entregaria duas vezes; ACKar `failed` devolveria ao
    // site um item que talvez esteja no chão do jogador. E NÃO ACKar
    // também não serve: a tarefa ficaria `pending` lá e a expiração a
    // devolveria ao inventário em 30 dias, sozinha, sem saber o que
    // só nós sabemos.
    const { queue, repository, calls, delivered } = harness([page([task()]), ACK_OK]);

    repository.reserve(
      {
        id: 'DLV-9f3a1c2b7e04',
        serverId: SERVER,
        steamId: STEAM_ID,
        kind: 'item',
        payload: '{}',
        sourceRef: null,
      },
      NOW,
    );

    await queue.poll();

    expect(delivered).toHaveLength(0);
    expect(repository.get('DLV-9f3a1c2b7e04')?.state).toBe('indeterminate');
    // O fio carrega TRÊS valores, e o indeterminado viaja no `reason`.
    expect(acksOf(calls)[0]).toEqual({
      id: 'DLV-9f3a1c2b7e04',
      status: 'deferred',
      reason: 'AGENT_INDETERMINATE',
    });
  });

  it('NENHUM ack carrega um quarto status', async () => {
    // Um valor fora dos três vale 400 `INVALID_ACK_STATUS` para o
    // LOTE INTEIRO no site: um ACK torto derruba os outros 49.
    const { queue, calls } = harness(
      [page([task(), task({ id: 'DLV-2', steamId: '76561198000000001' })]), ACK_OK],
      { online: [STEAM_ID] },
    );

    await queue.poll();

    for (const ack of acksOf(calls)) {
      expect(['delivered', 'failed', 'deferred']).toContain(ack.status);
    }
  });
});

describe('a rodada que caminha pelas páginas', () => {
  it('com next preenchido, pede a página seguinte com o cursor', async () => {
    const { queue, calls } = harness([
      page([task()], 'DLV-9f3a1c2b7e04'),
      ACK_OK,
      page([task({ id: 'DLV-2' })], null),
      ACK_OK,
    ]);

    await queue.poll();

    const pulls = calls.filter((call) => call.url.includes('/deliveries/pending'));

    expect(pulls).toHaveLength(2);
    expect(pulls[0]?.url).not.toContain('cursor=');
    expect(pulls[1]?.url).toContain('cursor=DLV-9f3a1c2b7e04');
  });

  it('para no teto de páginas e CONTINUA de onde parou na rodada seguinte', async () => {
    // ####  SEM ISTO, A TAREFA Nº 251 NUNCA É VISTA  ####
    //
    // O site serve só `pending`, por id ASC, e um ACK `deferred`
    // mantém a tarefa lá. Cinquenta jogadores que sumiram ocupam a
    // cabeça da fila por trinta dias.
    const many = Array.from({ length: 12 }, (_, at) => page([task({ id: `DLV-${String(at)}` })], `DLV-${String(at)}`));
    const responses: Canned[] = [];

    for (const p of many) {
      responses.push(p, ACK_OK);
    }

    const { queue, calls } = harness(responses, { online: [] });

    await queue.poll();

    const first = calls.filter((call) => call.url.includes('/deliveries/pending'));

    // Cinco páginas por rodada: o teto é derivado do rate limit do
    // site, não do gosto de quem opera.
    expect(first).toHaveLength(5);

    await queue.poll();

    const second = calls
      .filter((call) => call.url.includes('/deliveries/pending'))
      .slice(first.length);

    // A rodada seguinte NÃO recomeça do topo.
    expect(second[0]?.url).toContain('cursor=DLV-4');
  });

  it('com next null, faz UM pull e zera o cursor', async () => {
    const { queue, calls } = harness([page([task()], null), ACK_OK, page([], null)]);

    await queue.poll();
    await queue.poll();

    const pulls = calls.filter((call) => call.url.includes('/deliveries/pending'));

    expect(pulls).toHaveLength(2);
    // A segunda rodada começa do topo: a fila acabou.
    expect(pulls[1]?.url).not.toContain('cursor=');
  });

  it('INVALID_CURSOR joga o cursor fora e recomeça do topo, UMA vez', async () => {
    // ####  TRATÁ-LO COMO "SITE INDISPONÍVEL" É UM LAÇO ETERNO  ####
    //
    // `unavailable` significa "tente de novo igualzinho" — e
    // "igualzinho" inclui o mesmo cursor que o site acabou de
    // recusar. A cada 15 s, para sempre, e a fila para inteira.
    const { queue, calls } = harness([
      page([task()], 'DLV-velho'),
      ACK_OK,
      { status: 400, body: { error: 'cursor inválido', error_code: 'INVALID_CURSOR' } },
      page([], null),
    ]);

    await queue.poll();

    const pulls = calls.filter((call) => call.url.includes('/deliveries/pending'));
    const withCursor = pulls.filter((call) => call.url.includes('cursor='));

    // O cursor recusado sai UMA vez só; a retomada é do topo.
    expect(withCursor).toHaveLength(1);
    expect(pulls[pulls.length - 1]?.url).not.toContain('cursor=');
  });
});

describe('o ACK e o que volta dele', () => {
  it('todo ack leva o carimbo do relógio do AGENTE', async () => {
    const { queue, calls } = harness([page([task()], null), ACK_OK]);

    await queue.poll();

    const sent = (calls.find((call) => call.url.includes('/deliveries/ack'))?.body as {
      deliveries: { at: string }[];
    }).deliveries;

    expect(sent[0]?.at).toBe(new Date(NOW).toISOString());
  });

  it('um id em "unknown" com a linha delivered MANTÉM a linha', async () => {
    // `unknown` NÃO significa "não aconteceu": um `delivered`
    // reACKado cai exatamente aí. Apagar a linha jogaria fora o
    // comprovante que esta tabela existe para guardar.
    const { queue, repository } = harness([
      page([task()], null),
      { status: 200, body: { ok: true, applied: 0, unknown: ['DLV-9f3a1c2b7e04'] } },
    ]);

    await queue.poll();

    const row = repository.get('DLV-9f3a1c2b7e04');

    expect(row?.state).toBe('delivered');
    expect(row?.ackedAt).not.toBeNull();
  });

  it('um ACK recusado NÃO carimba acked_at: o lote volta na rodada seguinte', async () => {
    const { queue, repository } = harness([
      page([task()], null),
      { status: 400, body: { error: 'lote torto', error_code: 'INVALID_ACK_BODY' } },
    ]);

    await queue.poll();

    expect(repository.get('DLV-9f3a1c2b7e04')?.state).toBe('delivered');
    expect(repository.get('DLV-9f3a1c2b7e04')?.ackedAt).toBeNull();
  });
});

describe('o vocabulário do payload', () => {
  it('aceita o nome curto E o exato do veículo — o ponto é legal', () => {
    // Proibir o ponto proibiria junto o nome EXATO, que é a
    // ferramenta que existe para o caso caro: `sedan` resolve para o
    // vagão de trilho, e o jogador paga por um carro que nasce e não
    // serve para nada.
    expect(planOfPayload('vehicle', { prefab: 'minicopter', fuel: 100 })).not.toBeNull();
    expect(planOfPayload('vehicle', { prefab: 'sedantest.entity', fuel: 0 })).not.toBeNull();
    // O que continua proibido: a barra e a extensão.
    expect(planOfPayload('vehicle', { prefab: 'assets/x/minicopter', fuel: 0 })).toBeNull();
    expect(planOfPayload('vehicle', { prefab: 'minicopter.prefab', fuel: 0 })).toBeNull();
  });

  it('recusa o que está fora de faixa, régua por régua', () => {
    const item = (over: Record<string, unknown>): unknown => ({
      items: [{ shortname: 'metal.refined', amount: 100, skinId: '0', ...over }],
    });

    expect(planOfPayload('item', item({ amount: 0 }))).toBeNull();
    expect(planOfPayload('item', item({ amount: 100_001 }))).toBeNull();
    expect(planOfPayload('item', item({ shortname: 'metal refined' }))).toBeNull();
    // `skinId` é STRING de dígitos: em number, uma skin de workshop
    // voltaria arredondada e o jogador receberia outra skin.
    expect(planOfPayload('item', item({ skinId: 123 }))).toBeNull();
    expect(planOfPayload('item', item({ skinId: 'abc' }))).toBeNull();
    // Um `item` com dois itens é um kit mal cadastrado.
    expect(
      planOfPayload('item', {
        items: [
          { shortname: 'a.b', amount: 1, skinId: '0' },
          { shortname: 'c.d', amount: 1, skinId: '0' },
        ],
      }),
    ).toBeNull();
    // 40 é o teto de um inventário que ainda cabe.
    expect(
      planOfPayload('kit', {
        items: Array.from({ length: 41 }, () => ({ shortname: 'a.b', amount: 1, skinId: '0' })),
      }),
    ).toBeNull();
    expect(planOfPayload('vip', { tier: 'ouro', days: 3651 })).toBeNull();
    expect(planOfPayload('vehicle', { prefab: 'minicopter', fuel: 1001 })).toBeNull();
  });

  it('o VIP vitalício é days null, e continua valendo', () => {
    // Código morto na fase 1 — nada no site cria tarefa deste kind —,
    // e testado assim mesmo: ramo não exercitado sem teste apodrece
    // calado, e o caminho por baixo é o mesmo da compra in-game.
    const plan = planOfPayload('vip', { tier: 'ouro', days: null });

    expect(plan?.vip).toEqual({ tier: 'ouro', days: null });
    expect(plan?.units).toBe(1);
  });
});

describe('a classificação do desfecho', () => {
  it('o que melhora sozinho adia; o resto é definitivo', () => {
    expect(ackOf(new Error('PLAYER_DEAD')).status).toBe('deferred');
    expect(ackOf(new Error('INVENTORY_FULL')).status).toBe('deferred');
    // O veículo que não cabe: ele sai da base e tenta de novo.
    expect(ackOf(new Error('VEHICLE_NO_SPACE')).status).toBe('deferred');
    // Qualquer outro VEHICLE_* não melhora sozinho.
    expect(ackOf(new Error('VEHICLE_VEHICLE_NOT_FOUND')).status).toBe('failed');
    expect(ackOf(new Error('ITEM_NOT_FOUND')).status).toBe('failed');
    expect(ackOf(new Error('UNKNOWN_VIP_TIER')).status).toBe('failed');
    // O default é `failed` de propósito: ele devolve o item e o
    // jogador resgata de novo — ruim, mas visível.
    expect(ackOf(new Error('COISA_NOVA')).status).toBe('failed');
  });
});

describe('a revogação de VIP vinda da fila', () => {
  it('tira o VIP SEM esperar o jogador entrar', async () => {
    // O caso mais comum de uma revogação é justamente quem parou de
    // jogar. Com o portão de presença, ela ficaria adiada por 30
    // dias enquanto o VIP estornado continuava valendo.
    const { queue, repository, calls, revoked } = harness(
      [page([revokeTask()]), ACK_OK],
      { online: [] },
    );

    await queue.poll();

    expect(revoked).toEqual([{ steamId: STEAM_ID, tier: 'gold' }]);
    expect(repository.get('DLV-0aa1bb2cc3d4')?.state).toBe('delivered');
    expect(acksOf(calls)).toEqual([{ id: 'DLV-0aa1bb2cc3d4', status: 'delivered' }]);
  });

  it('nem pergunta quem está online', async () => {
    // Nem sequer o `PRESENCE_UNAVAILABLE`: a resposta da presença
    // não muda nada aqui.
    const { queue, calls, revoked } = harness([page([revokeTask()]), ACK_OK], {
      online: null,
    });

    await queue.poll();

    expect(revoked).toHaveLength(1);
    expect(acksOf(calls)[0]?.status).toBe('delivered');
  });

  it('o tier vem normalizado, e sem ele o payload não passa', async () => {
    const { queue, calls, revoked } = harness([page([revokeTask({ payload: { tier: ' GOLD ' } })]), ACK_OK]);

    await queue.poll();

    expect(revoked[0]?.tier).toBe('gold');

    const semTier = harness([page([revokeTask({ payload: {} })]), ACK_OK]);

    await semTier.queue.poll();

    expect(semTier.revoked).toHaveLength(0);
    expect(acksOf(semTier.calls)).toEqual([
      { id: 'DLV-0aa1bb2cc3d4', status: 'failed', reason: 'PAYLOAD_INVALID' },
    ]);
    // `calls` do primeiro caso já foi conferido pelo ACK acima.
    expect(acksOf(calls)[0]?.status).toBe('delivered');
  });

  it('VIP que não existe mais é delivered, e não failed', async () => {
    // O relógio DAQUI expira o VIP sozinho, quase sempre antes de a
    // varredura do site chegar. `failed` aqui geraria alarme no
    // funcionamento normal — e alarme que toca todo dia ninguém lê.
    const { queue, repository, calls } = harness([page([revokeTask()]), ACK_OK], {
      revoke: () =>
        Promise.reject(new ApiError('VIP_NOT_FOUND', 'não tem VIP "gold" ativo', 404)),
    });

    await queue.poll();

    expect(repository.get('DLV-0aa1bb2cc3d4')?.state).toBe('delivered');
    // Sem `reason`: a lista do fio é fechada, e VIP_NOT_FOUND não
    // está nela — ele apareceria cru para quem está de plantão.
    expect(acksOf(calls)).toEqual([{ id: 'DLV-0aa1bb2cc3d4', status: 'delivered' }]);
  });

  it('sem o concessor ligado, falha com o MESMO código da concessão', async () => {
    const { queue, repository, calls } = harness([page([revokeTask()]), ACK_OK], {
      withoutVips: true,
    });

    await queue.poll();

    expect(repository.get('DLV-0aa1bb2cc3d4')?.reason).toBe('VIP_GRANTER_UNAVAILABLE');
    expect(acksOf(calls)).toEqual([
      { id: 'DLV-0aa1bb2cc3d4', status: 'failed', reason: 'VIP_GRANTER_UNAVAILABLE' },
    ]);
  });

  it('a linha órfã REEXECUTA, em vez de virar indeterminada', async () => {
    // É a única tarefa que reexecuta: tirar o VIP duas vezes não
    // tira nada na segunda. Mandá-la para conferência humana
    // deixaria de pé, até alguém olhar, um VIP já estornado.
    const { queue, repository, calls, revoked } = harness([page([revokeTask()]), ACK_OK]);

    repository.reserve(
      {
        id: 'DLV-0aa1bb2cc3d4',
        serverId: SERVER,
        steamId: STEAM_ID,
        kind: 'vip_revoke',
        payload: '{"tier":"gold"}',
        sourceRef: null,
      },
      NOW - 60_000,
    );

    await queue.poll();

    expect(revoked).toEqual([{ steamId: STEAM_ID, tier: 'gold' }]);
    expect(repository.get('DLV-0aa1bb2cc3d4')?.state).toBe('delivered');
    expect(acksOf(calls)).toEqual([{ id: 'DLV-0aa1bb2cc3d4', status: 'delivered' }]);
  });

  it('mas a ENTREGA órfã continua indo para conferência humana', async () => {
    // O contraste é o ponto: lá o comando pode ter saído, e repetir
    // entregaria duas vezes.
    const { queue, repository, calls, delivered } = harness([page([task()]), ACK_OK]);

    repository.reserve(
      {
        id: 'DLV-9f3a1c2b7e04',
        serverId: SERVER,
        steamId: STEAM_ID,
        kind: 'item',
        payload: '{}',
        sourceRef: null,
      },
      NOW - 60_000,
    );

    await queue.poll();

    expect(delivered).toHaveLength(0);
    expect(repository.get('DLV-9f3a1c2b7e04')?.state).toBe('indeterminate');
    expect(acksOf(calls)).toEqual([
      { id: 'DLV-9f3a1c2b7e04', status: 'deferred', reason: 'AGENT_INDETERMINATE' },
    ]);
  });

  it('o RCON fora ADIA a revogação, e a reserva sai da frente', async () => {
    const { queue, repository, calls } = harness([page([revokeTask()]), ACK_OK], {
      revoke: () =>
        Promise.reject(new ApiError('RCON_UNAVAILABLE', 'o agente não fala com o RCON', 503)),
    });

    await queue.poll();

    expect(repository.get('DLV-0aa1bb2cc3d4')).toBeNull();
    expect(acksOf(calls)).toEqual([
      { id: 'DLV-0aa1bb2cc3d4', status: 'deferred', reason: 'RCON_UNAVAILABLE' },
    ]);
  });
});

describe('a concessão de VIP vinda da fila', () => {
  it('concede com o jogador OFFLINE: a linha é do agente, o grupo é reflexo dela', async () => {
    // Era o defeito que aparecia na tela de VIPs vazia: o VIP
    // comprado ficava preso na fila do site, invisível no painel,
    // até o jogador entrar — e o prazo do grant de lá já corria.
    // Quem põe o grupo em quem estava fora é o `OnPlayerConnected`
    // do OrigemZVip.
    const { queue, repository, calls, delivered } = harness(
      [page([task({ id: 'DLV-82d44653f2be', kind: 'vip', payload: { tier: 'gold', days: 30 } })]), ACK_OK],
      { online: [] },
    );

    await queue.poll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.plan.vip).toEqual({ tier: 'gold', days: 30 });
    expect(repository.get('DLV-82d44653f2be')?.state).toBe('delivered');
    expect(acksOf(calls)).toEqual([{ id: 'DLV-82d44653f2be', status: 'delivered' }]);
  });

  it('nem pergunta quem está online', async () => {
    const { queue, calls, delivered } = harness(
      [page([task({ kind: 'vip', payload: { tier: 'gold', days: 30 } })]), ACK_OK],
      { online: null },
    );

    await queue.poll();

    expect(delivered).toHaveLength(1);
    expect(acksOf(calls)[0]?.status).toBe('delivered');
  });

  it('mas o ITEM continua esperando: ele nasce ao lado de um corpo', async () => {
    // O contraste é o ponto. Sem o portão, o `origemz.give` sairia
    // para um jogador que não está lá.
    const { queue, calls, delivered } = harness([page([task()]), ACK_OK], { online: [] });

    await queue.poll();

    expect(delivered).toHaveLength(0);
    expect(acksOf(calls)).toEqual([
      { id: 'DLV-9f3a1c2b7e04', status: 'deferred', reason: 'PLAYER_OFFLINE' },
    ]);
  });
});
