// ============================================================
//  rankings-service.test.ts  -  as regras que a rota vai chamar.
//
//  O que este arquivo guarda:
//
//    1. o K/D não é uma divisão. Com amostra pequena o topo de
//       qualquer lista de razão é ocupado por quem jogou pouco —
//       3 abates e 0 mortes é K/D infinito —, e o encolhimento
//       bayesiano é o que conserta isso sem esconder ninguém;
//    2. métrica fora do catálogo é RECUSA com nome, e não lista
//       vazia: lista vazia é uma afirmação sobre os jogadores, e
//       a verdade aqui é sobre a pergunta;
//    3. minério não tem ranking de rede — somar um servidor 1x
//       com um 5x ordena a lista por em que servidor a pessoa
//       jogou;
//    4. `coverage` vem de fora, e é o que separa "zero" de "não
//       consegui perguntar";
//    5. a temporada fechada é lida do pódio CONGELADO, e o valor
//       de lá não muda mais;
//    6. e o `coverage` tem QUATRO estados: um ranking que nunca
//       recebeu coleta nenhuma não pode dizer que a coleta parou
//       de responder — é o defeito visto na tela em 06/09/2026.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { RankingsRepository, type StatBatchPlayer } from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { isApiError } from '../src/http/error-response.js';
import {
  COVERAGE_FRESH_MS,
  COVERAGE_MESSAGES,
  coverageMessageOf,
  coverageStatusOf,
  RankingsService,
  shrunkKd,
  type CoverageReport,
  type CoverageStatus,
} from '../src/rankings/service.js';

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: RankingsRepository;
  readonly service: RankingsService;
}

let harness: Harness;

const NOW = Date.UTC(2026, 2, 15, 12, 0);

/** O `coverage` que o `index.ts` daria, aqui em três linhas. */
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

function pvp(steamId: string, name: string, kills: number, deaths: number): StatBatchPlayer {
  return { steamId, name, metrics: { 'pvp.kills': kills, 'pvp.deaths': deaths } };
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of ['pvp1', 'pvp2'].entries()) {
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

  const repository = new RankingsRepository(db);

  harness = {
    db,
    repository,
    service: new RankingsService({
      repository,
      servers: { ids: (): readonly string[] => servers.list().map((server) => server.id) },
      coverage,
      timeZone: 'America/Sao_Paulo',
    }),
  };
});

// ------------------------------------------------------------
//  O K/D
// ------------------------------------------------------------

describe('o K/D com encolhimento', () => {
  it('3 abates e 0 mortes NÃO é infinito, e 400/300 fica praticamente o bruto', () => {
    // Com C = 10 e m = 1: (3 + 10) / (0 + 10) = 1,3.
    expect(shrunkKd(3, 0)).toBeCloseTo(1.3, 3);

    // Com amostra grande o prior desaparece sozinho: 1,32 contra o
    // bruto 1,333.
    expect(shrunkKd(400, 300)).toBeCloseTo(1.32, 2);
    expect(400 / 300).toBeCloseTo(1.333, 3);
  });

  it('o pódio corta quem não tem amostra, e a lista sai ordenada pelo valor encolhido', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [
          // Muita amostra e bom desempenho: é ele o primeiro.
          pvp('76561198000000001', 'Veterano', 120, 40),
          // Amostra suficiente, desempenho mediano.
          pvp('76561198000000002', 'Regular', 30, 30),
          // 3 e 0: sem o encolhimento, ele lideraria com infinito.
          // Sem amostra, ele nem entra no pódio.
          pvp('76561198000000003', 'Novato', 3, 0),
        ],
      },
      NOW,
    );

    const page = await harness.service.leaderboard({
      metric: 'pvp.kd',
      serverId: 'pvp1',
      limit: 10,
      offset: 0,
    });

    expect(page.entries.map((entry) => entry.name)).toEqual(['Veterano', 'Regular']);
    expect(page.total).toBe(2);
    expect(page.entries[0]?.value).toBeGreaterThan(page.entries[1]?.value ?? 0);

    // Ele não some da ficha — só não disputa.
    const mine = harness.service.playerRankings('76561198000000003', { serverId: 'pvp1' });
    const kd = mine.find((row) => row.ranking.metric === 'pvp.kd');

    expect(kd?.position).toBeNull();
    expect(kd?.value).toBeGreaterThan(0);
  });

  it('o K/D entra no pódio congelado quando a temporada fecha', () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp('76561198000000001', 'Veterano', 120, 40)],
      },
      NOW,
    );

    const season = harness.repository.openPeriodOf('pvp1', 'season');

    harness.service.closePeriod(season!.id);

    const podium = harness.repository.snapshotOf(season!.id, 'pvp.kd');

    // Sem a ponte `computedPodium`, este seria o único ranking sem
    // pódio no histórico — um buraco que ninguém sabe explicar.
    expect(podium).toHaveLength(1);
    expect(podium[0]?.displayName).toBe('Veterano');
    expect(podium[0]?.value).toBeCloseTo(shrunkKd(120, 40, 3), 3);
  });
});

// ------------------------------------------------------------
//  As recusas com nome
// ------------------------------------------------------------

describe('as recusas', () => {
  it('métrica fora do catálogo é RANKING_METRIC_UNKNOWN, e não lista vazia', async () => {
    await expect(
      harness.service.leaderboard({ metric: 'nao.existe', serverId: 'pvp1', limit: 10, offset: 0 }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'RANKING_METRIC_UNKNOWN',
    );
  });

  it('minério na rede é RANKING_SCOPE_INVALID', async () => {
    await expect(
      harness.service.leaderboard({
        metric: 'ore.sulfur',
        scope: 'global',
        limit: 10,
        offset: 0,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'RANKING_SCOPE_INVALID',
    );
  });

  it('um escopo que nunca mediu nada é RANKING_NOT_MEASURED', async () => {
    await expect(
      harness.service.leaderboard({ metric: 'pvp.kills', serverId: 'pvp1', limit: 10, offset: 0 }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'RANKING_NOT_MEASURED',
    );
  });
});

// ------------------------------------------------------------
//  Os três campos de toda lista
// ------------------------------------------------------------

describe('measuredSince, coverage e updatedAt', () => {
  it('a lista diz desde quando mede, quem estava coletando, e quando foi o último lote', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp('76561198000000001', 'Fulano', 3, 1)],
      },
      NOW,
    );

    // O pvp2 nem coletou: ele precisa aparecer como "não carregado",
    // e não como zero.
    harness.repository.ensureOpenPeriods('pvp2', 'monthly', NOW);

    const page = await harness.service.leaderboard({
      metric: 'pvp.kills',
      scope: 'global',
      limit: 10,
      offset: 0,
    });

    expect(page.measuredSince).toBe(NOW);
    expect(page.updatedAt).toBe(NOW);
    expect(page.coverage.servers).toEqual([
      { serverId: 'pvp1', status: 'ok', lastBatchAt: NOW },
      { serverId: 'pvp2', status: 'not-loaded', lastBatchAt: null },
    ]);
  });

  it('a temporada FECHADA é lida do pódio congelado, e não muda mais', async () => {
    harness.repository.applyBatch(
      {
        serverId: 'pvp1',
        batchId: 'b1',
        seq: 1,
        players: [pvp('76561198000000001', 'Fulano', 9, 1)],
      },
      NOW,
    );

    const season = harness.repository.openPeriodOf('pvp1', 'season');

    harness.service.closePeriod(season!.id);

    // O número do período fechado é reescrito à mão: é o estorno de
    // fraude do §3.3. O pódio congelado tem de ignorá-lo.
    harness.repository.resetPlayer(
      { periodId: season!.id, steamId: '76561198000000001', actor: 'admin' },
      NOW + 1_000,
    );

    const page = await harness.service.leaderboard({
      metric: 'pvp.kills',
      periodId: season!.id,
      limit: 10,
      offset: 0,
    });

    expect(page.frozen).toBe(true);
    expect(page.entries[0]?.value).toBe(9);
    expect(page.entries[0]?.name).toBe('Fulano');
  });
});

// ------------------------------------------------------------
//  A temporada nova pelo painel
// ------------------------------------------------------------

describe('o botão "abrir temporada nova agora"', () => {
  it('fecha a aberta, abre a seguinte, e recusa quando não há o que fechar', () => {
    harness.repository.ensureOpenPeriods('pvp1', 'monthly', NOW);

    const rolled = harness.service.openNewSeason('pvp1', { now: NOW + 1_000 });

    expect(rolled.closed.endedAt).toBe(NOW + 1_000);
    expect(rolled.opened.endedAt).toBeNull();
    expect(rolled.opened.label).toBe('Temporada de março de 2026');

    // Um servidor sem temporada aberta não tem o que fechar.
    expect(() => harness.service.openNewSeason('pvp2')).toThrowError(
      /não tem temporada aberta/,
    );
  });
});

// ------------------------------------------------------------
//  O `coverage`, e o estado que faltava
// ------------------------------------------------------------

describe('o estado da coleta', () => {
  const velho = NOW - COVERAGE_FRESH_MS - 1;

  it('nunca coletou é `never`, e NÃO "a coleta não responde"', () => {
    // ####  O DEFEITO QUE ESTE TESTE GUARDA  ####
    //
    // A tela dizia "A coleta não responde há um tempo" num ranking
    // que nunca tinha recebido lote nenhum. Dizer que a coleta
    // falhou quando ela nunca rodou manda o admin caçar um
    // problema que não existe.
    expect(
      coverageStatusOf({ pluginLoaded: true, pluginEnabled: null, lastBatchAt: null }),
    ).toBe('never');

    // E com lote VELHO a acusação é legítima: já houve coleta, e
    // ela parou.
    expect(
      coverageStatusOf({
        pluginLoaded: true,
        pluginEnabled: null,
        lastBatchAt: velho,
        now: NOW,
      }),
    ).toBe('no-answer');

    // Lote da última rodada: nada a avisar.
    expect(
      coverageStatusOf({
        pluginLoaded: true,
        pluginEnabled: null,
        lastBatchAt: NOW - 30_000,
        now: NOW,
      }),
    ).toBe('ok');
  });

  it('o plugin fora vem antes de tudo: é a resposta que se conserta', () => {
    // Com o plugin fora, "nunca chegou lote" é consequência, e não
    // notícia — e mandar carregar o plugin é o que resolve.
    expect(
      coverageStatusOf({ pluginLoaded: false, pluginEnabled: null, lastBatchAt: null }),
    ).toBe('not-loaded');

    // O Oxide não soube responder, mas o acervo confirmou: o `.cs`
    // está desligado ali.
    expect(
      coverageStatusOf({ pluginLoaded: null, pluginEnabled: false, lastBatchAt: velho }),
    ).toBe('not-loaded');

    // Ninguém conseguiu confirmar nada e nunca houve lote: o único
    // fato é o do banco. Acusar a coleta seria palpite.
    expect(
      coverageStatusOf({ pluginLoaded: null, pluginEnabled: null, lastBatchAt: null }),
    ).toBe('never');
  });

  it('cada estado tem UMA frase, e `ok` não tem nenhuma', () => {
    // As duas telas — a do jogo e a do painel — leem daqui. Duas
    // explicações para o mesmo defeito é o que isto impede.
    const estados: readonly CoverageStatus[] = ['ok', 'never', 'no-answer', 'not-loaded'];

    expect(Object.keys(COVERAGE_MESSAGES).sort()).toEqual([...estados].sort());
    expect(coverageMessageOf('ok')).toBeNull();
    expect(coverageMessageOf(null)).toBeNull();
    expect(coverageMessageOf('never')).toBe('Este ranking ainda não recebeu nenhuma coleta.');
    expect(coverageMessageOf('no-answer')).toContain('podem estar atrasados');
    expect(coverageMessageOf('not-loaded')).toContain('não está carregado');
  });
});
