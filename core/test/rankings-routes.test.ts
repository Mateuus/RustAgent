// ============================================================
//  rankings-routes.test.ts  -  as promessas da API do ranking.
//
//  O que este arquivo guarda:
//
//    1. métrica fora do catálogo é RECUSA COM NOME
//       (`RANKING_METRIC_UNKNOWN`), e não lista vazia: lista vazia
//       é uma afirmação sobre os jogadores, e a verdade aqui é
//       sobre a pergunta;
//    2. minério não tem ranking de rede — `scope=global` numa
//       métrica com `global_eligible = 0` é `RANKING_SCOPE_INVALID`;
//    3. um `builtin` não se apaga, e a recusa tem nome;
//    4. A MESMA LISTA, EM DUAS PÁGINAS, COM VALORES EMPATADOS, NÃO
//       PERDE NEM REPETE JOGADOR. É o defeito do §9.3 — o que só
//       aparece em produção, e o que a ordem total impede;
//    5. toda lista carrega `measuredSince`, `coverage` e
//       `updatedAt`;
//    6. um servidor com o plugin fora aparece como `not-loaded` no
//       `coverage`, e NÃO como lista vazia: "zero" e "não consegui
//       perguntar" são respostas diferentes;
//    7. uma temporada fechada, lida por `periodId`, devolve o
//       pódio CONGELADO — e ele não muda mais;
//    8. virar a temporada duas vezes seguidas com o mesmo
//       `periodId` recusa na segunda, e NÃO abre uma terceira;
//    9. apagar um ranking para o qual um item custom dá pontos é
//       `RANKING_IN_USE`;
//   10. e a ordem do catálogo é reescrita INTEIRA: uma lista
//       parcial é recusada, porque os ausentes ficariam com a
//       posição indefinida e o defeito só apareceria na próxima
//       vez que alguém abrisse a tela.
//
//  Banco em memória, migrações de verdade: é o que permite testar
//  a API inteira sem servidor de Rust nenhum — que é justamente a
//  promessa destas rotas.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { CustomItemsRepository } from '../src/db/custom-items-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  RankingsRepository,
  type StatBatchPlayer,
  type StatPeriod,
} from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerRankingRoutes } from '../src/http/routes/rankings.js';
import { RankingsService, type CoverageReport } from '../src/rankings/service.js';

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: RankingsRepository;
  readonly customItems: CustomItemsRepository;
  readonly service: RankingsService;
  readonly app: FastifyInstance;
}

let harness: Harness;

const NOW = Date.UTC(2026, 2, 15, 12, 0);

const SERVER_IDS = ['pvp1', 'pvp2'] as const;

/**
 * O `coverage` que o `index.ts` daria, aqui em três linhas.
 *
 * `pvp2` é o servidor com o plugin fora — é ele que prova que a
 * ausência de coleta chega à tela como ausência, e não como zero.
 */
const coverage = {
  coverageOf: (serverIds: readonly string[]): Promise<CoverageReport> =>
    Promise.resolve({
      servers: serverIds.map((serverId) => ({
        serverId,
        status: serverId === 'pvp2' ? ('not-loaded' as const) : ('ok' as const),
        lastBatchAt: serverId === 'pvp2' ? null : NOW,
      })),
    }),
};

function pvp(steamId: string, name: string, kills: number): StatBatchPlayer {
  return { steamId, name, metrics: { 'pvp.kills': kills } };
}

/** O SteamID de índice `n`, com os 17 dígitos que a régua exige. */
function steamId(n: number): string {
  return `765611980000000${String(n).padStart(2, '0')}`;
}

function openSeasonOf(serverId: string): StatPeriod {
  const period = harness.repository.openPeriodOf(serverId, 'season');

  if (period === null) {
    throw new Error(`o servidor ${serverId} deveria ter temporada aberta`);
  }

  return period;
}

beforeEach(async () => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of SERVER_IDS.entries()) {
    servers.create({
      id,
      name: id.toUpperCase(),
      identity: id,
      enabled: true,
      gamePort: 28015 + index * 10,
      rconPort: 28016 + index * 10,
      queryPort: 28017 + index * 10,
      appPort: 28082 + index * 10,
      rconHost: '127.0.0.1',
      installDir: `Servers/${id}`,
    });
  }

  // O item custom precisa de um item base no catálogo do jogo: é o
  // corpo que ele empresta. Ver custom-items.test.ts.
  new ItemsRepository(db).replace({
    items: [
      {
        shortname: 'trophy',
        displayName: 'Twitch Rivals Trophy',
        itemId: 975983052,
        category: 'Items',
        maxStack: 1,
        hasCondition: false,
      },
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });

  const repository = new RankingsRepository(db);
  const customItems = new CustomItemsRepository(db);

  const service = new RankingsService({
    repository,
    servers: { ids: (): readonly string[] => servers.list().map((server) => server.id) },
    coverage,
    timeZone: 'America/Sao_Paulo',
  });

  const app = Fastify();

  // O mesmo tratamento do servidor real (http/server.ts:310). Sem
  // a linha do ZodError, uma recusa de validação viria como 500 e o
  // teste passaria a medir o handler do teste, e não a rota.
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

  await app.register(
    async (api) => {
      registerRankingRoutes(api, {
        service,
        servers: { ids: (): readonly string[] => [...SERVER_IDS] },
        customItems,
      });
    },
    { prefix: '/api' },
  );

  harness = { db, repository, customItems, service, app };
});

// ------------------------------------------------------------
//  As recusas com nome
// ------------------------------------------------------------

describe('as recusas', () => {
  it('métrica fora do catálogo é 400 RANKING_METRIC_UNKNOWN, e não lista vazia', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/rankings?metric=nao.existe&serverId=pvp1',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_METRIC_UNKNOWN' });
  });

  it('minério na rede é 400 RANKING_SCOPE_INVALID', async () => {
    // `ore.sulfur` nasce com `global_eligible = 0` na migração
    // 034: somar um servidor 1x com um 5x ordenaria a lista por em
    // que servidor a pessoa jogou.
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/rankings?metric=ore.sulfur&scope=global',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_SCOPE_INVALID' });
  });

  it('apagar um builtin é 409 RANKING_BUILTIN_LOCKED, e ele continua lá', async () => {
    const response = await harness.app.inject({ method: 'DELETE', url: '/api/rankings/metrics/abates' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_BUILTIN_LOCKED' });

    const catalog = await harness.app.inject({ method: 'GET', url: '/api/rankings/metrics' });

    expect(
      catalog.json<{ rankings: { id: string }[] }>().rankings.some((item) => item.id === 'abates'),
    ).toBe(true);
  });

  it('apagar um ranking para o qual um item custom dá pontos é 409 RANKING_IN_USE', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/rankings/metrics',
      payload: {
        id: 'trofeu-bleik',
        metric: 'trophy.bleik',
        label: 'Troféu Bleik Store',
        source: 'item',
        valueKind: 'counter',
      },
    });

    expect(created.statusCode).toBe(201);

    harness.customItems.create({
      displayName: 'Troféu Bleik Store',
      baseShortname: 'trophy',
      skinId: '3000000001',
      category: 'Troféus',
      description: null,
      iconFile: null,
      maxStack: null,
      deployable: false,
      consumeOnPickup: true,
      action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1, onPickup: true },
      message: null,
      enabled: true,
      servers: ['pvp1'],
    });

    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/rankings/metrics/trofeu-bleik',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_IN_USE' });
    // A frase diz QUAL item colidiu, e não só que colidiu.
    expect(response.json<{ message: string }>().message).toContain('Troféu Bleik Store');
  });
});

// ------------------------------------------------------------
//  A paginação: o defeito do §9.3
// ------------------------------------------------------------

describe('a paginação com valores empatados', () => {
  it('duas páginas da mesma lista não perdem nem repetem jogador', async () => {
    // Seis jogadores, o MESMO valor e o MESMO instante: sem o
    // terceiro critério de desempate (`steam_id`), a ordem entre
    // eles seria a que o SQLite escolher — e ela pode mudar entre
    // as duas consultas, fazendo um jogador aparecer nas duas
    // páginas e outro em nenhuma.
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [1, 2, 3, 4, 5, 6].map((n) => pvp(steamId(n), `Jogador ${String(n)}`, 10)),
      },
      NOW,
    );

    const url = '/api/rankings?metric=pvp.kills&serverId=pvp1&limit=3';

    const first = await harness.app.inject({ method: 'GET', url: `${url}&offset=0` });
    const second = await harness.app.inject({ method: 'GET', url: `${url}&offset=3` });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const page1 = first.json<{
      count: number;
      total: number;
      entries: { position: number; steamId: string }[];
    }>();
    const page2 = second.json<{ entries: { position: number; steamId: string }[] }>();

    expect(page1.total).toBe(6);
    expect(page1.count).toBe(3);

    const seen = [...page1.entries, ...page2.entries].map((entry) => entry.steamId);

    // Nem repete...
    expect(new Set(seen).size).toBe(6);
    // ...nem perde: os seis, e os seis mesmos.
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6].map(steamId).sort());

    // E a colocação continua contando a partir do `offset`.
    expect(page1.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(page2.entries.map((entry) => entry.position)).toEqual([4, 5, 6]);
  });
});

// ------------------------------------------------------------
//  Os três campos que toda lista carrega
// ------------------------------------------------------------

describe('measuredSince, coverage e updatedAt', () => {
  it('a lista diz desde quando mede, quem coletava, e quando foi o último lote', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp(steamId(1), 'Fulano', 3)],
      },
      NOW,
    );

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/rankings?metric=pvp.kills&serverId=pvp1',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      measuredSince: string | null;
      updatedAt: string | null;
      frozen: boolean;
      period: { id: number; kind: string; turnsAt: string | null };
      coverage: {
        servers: {
          serverId: string;
          status: string;
          message: string | null;
          lastBatchAt: string | null;
        }[];
      };
    }>();

    // Datas em ISO na borda, sempre.
    expect(body.measuredSince).toBe(new Date(NOW).toISOString());
    expect(body.updatedAt).toBe(new Date(NOW).toISOString());
    expect(body.frozen).toBe(false);
    expect(body.period.kind).toBe('season');
    // `message` viaja junto do `status`: a tela do painel e a do
    // jogo leem a MESMA frase, e nenhuma delas a reescreve. Em
    // `ok` ela é nula — não há aviso quando não há o que avisar.
    expect(body.coverage.servers).toEqual([
      { serverId: 'pvp1', status: 'ok', message: null, lastBatchAt: new Date(NOW).toISOString() },
    ]);
  });

  it('o servidor com o plugin fora aparece como not-loaded, e não como lista vazia', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp(steamId(1), 'Fulano', 7)],
      },
      NOW,
    );

    // O pvp2 tem janela aberta e nunca coletou nada.
    harness.repository.ensureOpenPeriods('pvp2', 'monthly', NOW);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/rankings?metric=pvp.kills&scope=global',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      entries: { steamId: string; value: number }[];
      coverage: { servers: { serverId: string; status: string; message: string | null }[] };
    }>();

    // A lista NÃO some, e nem finge que o pvp2 teve zero.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.value).toBe(7);
    expect(body.coverage.servers).toEqual([
      {
        serverId: 'pvp1',
        status: 'ok',
        message: null,
        lastBatchAt: new Date(NOW).toISOString(),
      },
      {
        serverId: 'pvp2',
        status: 'not-loaded',
        message: 'O plugin de coleta não está carregado neste servidor.',
        lastBatchAt: null,
      },
    ]);
  });
});

// ------------------------------------------------------------
//  O histórico
// ------------------------------------------------------------

describe('a temporada fechada', () => {
  it('lida por periodId, devolve o pódio congelado — e ele não muda mais', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp(steamId(1), 'Fulano', 9)],
      },
      NOW,
    );

    const season = openSeasonOf('pvp1');

    harness.service.closePeriod(season.id);

    // O número do período fechado é reescrito à mão — é o estorno
    // de fraude do §3.3. O pódio congelado tem de ignorá-lo.
    harness.repository.resetPlayer(
      { periodId: season.id, steamId: steamId(1), actor: 'admin' },
      NOW + 1_000,
    );

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/rankings?metric=pvp.kills&periodId=${String(season.id)}`,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      frozen: boolean;
      entries: { steamId: string; name: string | null; value: number }[];
    }>();

    expect(body.frozen).toBe(true);
    expect(body.entries[0]?.value).toBe(9);
    expect(body.entries[0]?.name).toBe('Fulano');

    // E o detalhe do período traz o mesmo pódio, por métrica.
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/rankings/periods/${String(season.id)}`,
    });

    expect(detail.statusCode).toBe(200);

    const podium = detail.json<{
      period: { id: number; endedAt: string | null };
      podium: { metric: string; entries: { name: string | null; value: number }[] }[];
    }>();

    expect(podium.period.endedAt).not.toBeNull();

    const kills = podium.podium.find((item) => item.metric === 'pvp.kills');

    expect(kills?.entries[0]).toMatchObject({ name: 'Fulano', value: 9 });
  });

  it('um período que não existe é 404 RANKING_PERIOD_NOT_FOUND', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/rankings/periods/9999' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_PERIOD_NOT_FOUND' });
  });
});

// ------------------------------------------------------------
//  O botão "abrir temporada nova agora"
// ------------------------------------------------------------

describe('POST /api/servers/:serverId/rankings/season', () => {
  it('fecha a aberta e abre a seguinte, congelando o pódio', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp(steamId(1), 'Fulano', 5)],
      },
      NOW,
    );

    const before = openSeasonOf('pvp1');

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/servers/pvp1/rankings/season',
      payload: { reason: 'fim da temporada de março' },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      closed: { id: number; endedAt: string | null };
      opened: { id: number; endedAt: string | null; label: string | null };
      frozen: number;
    }>();

    expect(body.closed.id).toBe(before.id);
    expect(body.closed.endedAt).not.toBeNull();
    expect(body.opened.endedAt).toBeNull();
    expect(body.frozen).toBeGreaterThan(0);
  });

  it('virar duas vezes com o mesmo periodId recusa na segunda, e NÃO abre uma terceira', async () => {
    harness.repository.ensureOpenPeriods('pvp1', 'monthly', NOW);

    const season = openSeasonOf('pvp1');

    const payload = { reason: 'temporada nova agora', periodId: season.id };

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/servers/pvp1/rankings/season',
      payload,
    });

    expect(first.statusCode).toBe(200);

    // O segundo clique no mesmo botão, com a mesma tela na mão.
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/servers/pvp1/rankings/season',
      payload,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ ok: false, error: 'RANKING_PERIOD_CLOSED' });

    // Duas temporadas: a que fechou e a que abriu. Não três.
    const periods = harness.repository.listPeriods({
      serverId: 'pvp1',
      kind: 'season',
      limit: 10,
      offset: 0,
    });

    expect(periods.total).toBe(2);
    expect(periods.periods.filter((period) => period.endedAt === null)).toHaveLength(1);
  });

  it('um servidor que este agente não conhece é 404 UNKNOWN_SERVER', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/servers/naoexiste/rankings/season',
      payload: { reason: 'nada' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: 'UNKNOWN_SERVER' });
  });

  it('sem motivo, a virada é recusada na borda', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/servers/pvp1/rankings/season',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'INVALID_BODY' });
  });
});

// ------------------------------------------------------------
//  O ciclo forçado, sem coletor
// ------------------------------------------------------------

describe('POST /api/servers/:serverId/rankings/flush', () => {
  it('sem coleta ligada, recusa com nome em vez de prometer um ciclo que não vem', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/servers/pvp1/rankings/flush',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_COLLECTOR_OFF' });
  });
});

// ------------------------------------------------------------
//  O nome curto, o menu do jogo e a ordem
// ------------------------------------------------------------

interface RankingBody {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string | null;
  readonly showInGame: boolean;
  readonly sortOrder: number;
}

/** O catálogo como o PAINEL o recebe: sem filtro nenhum. */
async function catalogo(): Promise<readonly RankingBody[]> {
  const response = await harness.app.inject({ method: 'GET', url: '/api/rankings/metrics' });

  return response.json<{ rankings: RankingBody[] }>().rankings;
}

describe('os dois campos que a tela nova precisa', () => {
  it('o POST aceita `shortLabel` e `showInGame`, e o catálogo os devolve', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/rankings/metrics',
      payload: {
        id: 'trofeu-bleik',
        metric: 'trophy.bleik',
        label: 'Troféu Bleik Store',
        shortLabel: 'Bleik Store',
        showInGame: false,
        source: 'item',
        valueKind: 'counter',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<{ ranking: RankingBody }>().ranking).toMatchObject({
      label: 'Troféu Bleik Store',
      shortLabel: 'Bleik Store',
      showInGame: false,
    });

    // ####  ESCONDIDO DO JOGO CONTINUA NO PAINEL  ####
    //
    // Sumir daqui tiraria do admin justamente o interruptor que
    // ele foi ligar — e ele não teria como desfazer.
    const painel = await catalogo();

    expect(painel.find((item) => item.id === 'trofeu-bleik')?.showInGame).toBe(false);
  });

  it('sem os campos, o ranking nasce sem nome curto e aparecendo no jogo', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/rankings/metrics',
      payload: {
        id: 'trofeu-bleik',
        metric: 'trophy.bleik',
        label: 'Troféu Bleik Store',
        source: 'item',
        valueKind: 'counter',
      },
    });

    expect(created.json<{ ranking: RankingBody }>().ranking).toMatchObject({
      shortLabel: null,
      showInGame: true,
    });
  });

  it('um nome curto que não é curto é recusado na borda', async () => {
    // O campo existe por causa da largura da aba do jogo: um
    // "nome curto" de sessenta caracteres deixaria de resolver o
    // problema para o qual ele foi criado.
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/rankings/metrics/abates',
      payload: {
        id: 'abates',
        metric: 'pvp.kills',
        label: 'Abates',
        shortLabel: 'a'.repeat(25),
        source: 'plugin',
        valueKind: 'counter',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'INVALID_BODY' });
  });
});

describe('PUT /api/rankings/metrics/order', () => {
  const pedir = async (ids: readonly string[]) =>
    await harness.app.inject({
      method: 'PUT',
      url: '/api/rankings/metrics/order',
      payload: { ids },
    });

  it('a lista inteira reordena o catálogo, e a resposta já vem na ordem nova', async () => {
    const antes = (await catalogo()).map((item) => item.id);
    const invertida = [...antes].reverse();

    const response = await pedir(invertida);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ rankings: RankingBody[] }>().rankings.map((item) => item.id)).toEqual(
      invertida,
    );

    // E o catálogo lido de novo conta a mesma história.
    expect((await catalogo()).map((item) => item.id)).toEqual(invertida);
  });

  it('uma lista PARCIAL é 400, e nada se move', async () => {
    const antes = (await catalogo()).map((item) => item.id);

    const response = await pedir(antes.slice(0, 3));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_ORDER_MISMATCH' });
    expect((await catalogo()).map((item) => item.id)).toEqual(antes);
  });

  it('um id desconhecido é 400 — a tela está olhando outro catálogo', async () => {
    const antes = (await catalogo()).map((item) => item.id);

    const response = await pedir([...antes, 'ranking-que-nao-existe']);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'RANKING_ORDER_MISMATCH' });
    expect((await catalogo()).map((item) => item.id)).toEqual(antes);
  });

  it('`order` não é confundido com o id de um ranking', async () => {
    // A rota estática vem antes da de `:id` no arquivo. Sem isso,
    // reordenar viraria a edição de um ranking chamado "order" —
    // e a recusa seria uma validação de corpo sem sentido nenhum.
    const response = await pedir([]);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'INVALID_BODY' });
  });
});
