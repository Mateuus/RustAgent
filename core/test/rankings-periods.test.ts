// ============================================================
//  rankings-periods.test.ts  -  quando a janela vira.
//
//  O que este arquivo guarda:
//
//    1. cada `season_mode` vence na HORA CERTA — e `monthly` e
//       `quarterly` viram pela hora LOCAL, não pela UTC. O teste
//       que prova isso é o das 22h do dia 31: já é dia 1 em UTC e
//       ainda é dia 31 aqui, e a temporada NÃO pode virar;
//    2. o wipe é um segundo gatilho, independente do calendário —
//       e a execução manda sobre a configuração, com `NULL`
//       significando "não decidi";
//    3. um wipe feito à MÃO (sem `wipe_runs`) cai na configuração
//       do servidor e vira do mesmo jeito. É o ponto que faz o
//       desenho valer a pena: a âncora é o mundo, não o painel;
//    4. wipe e calendário no mesmo minuto produzem UMA virada.
//
//  As funções puras são testadas sem banco, com um fuso FIXO: sem
//  isso o resultado dependeria da máquina que roda o teste, que é
//  exatamente o tipo de teste que passa aqui e falha no servidor.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { RankingsRepository } from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import {
  isSeasonDue,
  nextSeasonTurnAt,
  opensSeasonOnWipe,
  periodLabel,
  seasonTurn,
  sweepPeriods,
  type PeriodsDeps,
} from '../src/rankings/periods.js';

/** O fuso da rede. Fixo aqui para o teste não depender da máquina. */
const ZONE = 'America/Sao_Paulo';

const DAY = 86_400_000;

// ------------------------------------------------------------
//  As funções puras
// ------------------------------------------------------------

describe('quando a temporada vence, pelo calendário', () => {
  it('`monthly` vira quando o MÊS LOCAL muda, e não quando o UTC muda', () => {
    const started = Date.UTC(2026, 2, 15, 12, 0);
    const window = { seasonMode: 'monthly' as const, startedAt: started, timeZone: ZONE };

    // 31/03 às 20:00 local: mesmo mês, não vira.
    expect(isSeasonDue(window, Date.UTC(2026, 2, 31, 23, 0))).toBe(false);

    // ####  O CASO QUE PAGA ESTE TESTE  ####
    //
    // 01/04 às 01:00 UTC é 31/03 às 22:00 em São Paulo. Quem
    // contasse em UTC viraria a temporada três horas cedo, e o
    // jogador veria o ranking zerar no dia 31 — o bug que ninguém
    // consegue explicar.
    expect(isSeasonDue(window, Date.UTC(2026, 3, 1, 1, 0))).toBe(false);

    // 01/04 às 02:00 local: agora sim.
    expect(isSeasonDue(window, Date.UTC(2026, 3, 1, 5, 0))).toBe(true);
  });

  it('`quarterly` vira em 1/jan, 1/abr, 1/jul e 1/out', () => {
    const window = {
      seasonMode: 'quarterly' as const,
      startedAt: Date.UTC(2026, 7, 10, 12, 0),
      timeZone: ZONE,
    };

    expect(isSeasonDue(window, Date.UTC(2026, 8, 30, 12, 0))).toBe(false);
    expect(isSeasonDue(window, Date.UTC(2026, 9, 1, 12, 0))).toBe(true);
  });

  it('`biweekly` conta 15 dias corridos a partir da âncora', () => {
    const started = Date.UTC(2026, 2, 1, 12, 0);
    const window = { seasonMode: 'biweekly' as const, startedAt: started, timeZone: ZONE };

    expect(isSeasonDue(window, started + 14 * DAY)).toBe(false);
    expect(isSeasonDue(window, started + 15 * DAY)).toBe(true);

    // A âncora configurada sobrepõe o começo do período: é ela que
    // faz a contagem não recomeçar a cada janela.
    const anchored = { ...window, seasonAnchorAt: started - 10 * DAY };

    expect(isSeasonDue(anchored, started + 5 * DAY)).toBe(true);
  });

  it('`days` usa o número configurado, e uma janela sem tamanho NÃO vence', () => {
    const started = Date.UTC(2026, 2, 1, 12, 0);

    expect(
      isSeasonDue({ seasonMode: 'days', startedAt: started, seasonDays: 7 }, started + 7 * DAY),
    ).toBe(true);

    expect(
      isSeasonDue({ seasonMode: 'days', startedAt: started, seasonDays: 7 }, started + 6 * DAY),
    ).toBe(false);

    // Configuração incompleta não pode zerar a temporada a cada
    // sweep de 60 s.
    expect(
      isSeasonDue({ seasonMode: 'days', startedAt: started, seasonDays: null }, started + 400 * DAY),
    ).toBe(false);
  });

  it('`wipe` e `manual` NUNCA vencem pelo relógio', () => {
    const started = Date.UTC(2020, 0, 1, 12, 0);
    const now = Date.UTC(2026, 0, 1, 12, 0);

    expect(isSeasonDue({ seasonMode: 'wipe', startedAt: started, timeZone: ZONE }, now)).toBe(false);
    expect(isSeasonDue({ seasonMode: 'manual', startedAt: started, timeZone: ZONE }, now)).toBe(
      false,
    );
  });

  it('diz quando a janela aberta vira, e `null` quando não há data', () => {
    const started = Date.UTC(2026, 2, 15, 12, 0);

    expect(nextSeasonTurnAt({ seasonMode: 'monthly', startedAt: started, timeZone: ZONE })).toBe(
      Date.UTC(2026, 3, 1, 3, 0),
    );

    expect(nextSeasonTurnAt({ seasonMode: 'biweekly', startedAt: started })).toBe(
      started + 15 * DAY,
    );

    expect(nextSeasonTurnAt({ seasonMode: 'wipe', startedAt: started })).toBeNull();
    expect(nextSeasonTurnAt({ seasonMode: 'manual', startedAt: started })).toBeNull();
  });

  it('o rótulo diz o que a pessoa reconhece na lista', () => {
    const at = Date.UTC(2026, 8, 5, 15, 0);

    expect(periodLabel('season', at, 'monthly', ZONE)).toBe('Temporada de setembro de 2026');
    expect(periodLabel('season', at, 'quarterly', ZONE)).toBe('Temporada do 3º trimestre de 2026');
    expect(periodLabel('season', at, 'biweekly', ZONE)).toBe('Temporada de 05/09/2026');
    expect(periodLabel('wipe', at, null, ZONE)).toBe('Wipe de 05/09/2026');
    expect(periodLabel('lifetime', at, null, ZONE)).toBe('De sempre');
  });
});

describe('quando o wipe abre temporada', () => {
  it('a execução manda, e `null` é "não decidi" — não "não"', () => {
    // A execução disse sim, a configuração diz não: vira.
    expect(opensSeasonOnWipe({ runDecision: true, seasonOnWipe: false })).toBe(true);

    // A execução disse NÃO, a configuração diz sim: não vira. É o
    // caso que um `||` engoliria.
    expect(opensSeasonOnWipe({ runDecision: false, seasonOnWipe: true })).toBe(false);

    // Não decidiu: vale a configuração.
    expect(opensSeasonOnWipe({ runDecision: null, seasonOnWipe: true })).toBe(true);
    expect(opensSeasonOnWipe({ runDecision: null, seasonOnWipe: false })).toBe(false);

    // Nem execução, nem configuração: o padrão é não mexer.
    expect(opensSeasonOnWipe({})).toBe(false);
  });

  it('o motivo gravado é o WIPE quando os dois gatilhos caem juntos', () => {
    const turn = seasonTurn({
      window: { seasonMode: 'monthly', startedAt: Date.UTC(2026, 2, 15, 12, 0), timeZone: ZONE },
      now: Date.UTC(2026, 3, 1, 5, 0),
      wipeDetected: true,
      runDecision: null,
      seasonOnWipe: true,
    });

    // Os dois venceriam. O motivo é o mundo, porque é ele o fato
    // observável — e é ele que explica o farm ter zerado junto.
    expect(turn).toEqual({ due: true, reason: 'wipe' });
  });

  it('sem gatilho nenhum, não vira', () => {
    expect(
      seasonTurn({
        window: { seasonMode: 'monthly', startedAt: Date.UTC(2026, 2, 15, 12, 0), timeZone: ZONE },
        now: Date.UTC(2026, 2, 20, 12, 0),
        wipeDetected: true,
        runDecision: null,
        seasonOnWipe: false,
      }),
    ).toEqual({ due: false, reason: null });
  });
});

// ------------------------------------------------------------
//  A virada, com banco
// ------------------------------------------------------------

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: RankingsRepository;
  readonly deps: PeriodsDeps;
}

let harness: Harness;

const NOW = Date.UTC(2026, 2, 15, 12, 0);

/** Uma execução de wipe com a decisão pedida. */
function wipeRun(decision: number | null): number {
  const result = harness.db
    .prepare(
      `INSERT INTO wipe_runs
         (server_id, kind, started_at, wipe_at, created_at, updated_at, open_ranking_season)
       VALUES ('pvp1', 'manual', @at, @at, @at, @at, @decision)`,
    )
    .run({ at: NOW, decision });

  return Number(result.lastInsertRowid);
}

function seasonPeriods(): { total: number; open: number } {
  const rows = harness.db
    .prepare(
      `SELECT count(*) AS total, sum(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS open
         FROM stat_periods WHERE server_id = 'pvp1' AND kind = 'season'`,
    )
    .get() as { total: number; open: number };

  return rows;
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'PVP 1',
    identity: 'pvp1',
    enabled: true,
    gamePort: 28015,
    rconPort: 28016,
    queryPort: 28017,
    appPort: 28082,
    rconHost: '127.0.0.1',
    installDir: 'Servers/pvp1',
  });

  const repository = new RankingsRepository(db);

  harness = { db, repository, deps: { repository, timeZone: ZONE } };
});

describe('o sweep de janelas', () => {
  it('abre as três janelas na primeira rodada, e não abre de novo na segunda', () => {
    const first = sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });

    expect(first.open.map((period) => period.kind).sort()).toEqual([
      'lifetime',
      'season',
      'wipe',
    ]);
    expect(first.rolled).toHaveLength(0);

    const second = sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW + 60_000 });

    expect(second.open.map((period) => period.id)).toEqual(first.open.map((period) => period.id));
  });

  it('o wipe vira a janela de wipe e NÃO a temporada, quando ninguém pediu', () => {
    const before = sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });
    const season = before.open.find((period) => period.kind === 'season');

    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: NOW + 60_000,
      wipeDetected: true,
    });

    expect(swept.rolled.map((item) => item.kind)).toEqual(['wipe']);
    expect(swept.seasonReason).toBeNull();
    expect(harness.repository.openPeriodOf('pvp1', 'season')?.id).toBe(season?.id);
  });

  it('`open_ranking_season = 1` abre temporada mesmo com a configuração dizendo NÃO', () => {
    harness.repository.saveSettings('pvp1', { seasonMode: 'monthly', seasonOnWipe: false }, NOW);
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });

    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: NOW + 60_000,
      wipeDetected: true,
      wipeRunId: wipeRun(1),
    });

    expect(swept.rolled.map((item) => item.kind).sort()).toEqual(['season', 'wipe']);
    expect(swept.seasonReason).toBe('wipe');
    expect(seasonPeriods()).toEqual({ total: 2, open: 1 });
  });

  it('`open_ranking_season = 0` NÃO abre, mesmo com a configuração dizendo SIM', () => {
    harness.repository.saveSettings('pvp1', { seasonMode: 'monthly', seasonOnWipe: true }, NOW);
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });

    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: NOW + 60_000,
      wipeDetected: true,
      wipeRunId: wipeRun(0),
    });

    expect(swept.rolled.map((item) => item.kind)).toEqual(['wipe']);
    expect(swept.seasonReason).toBeNull();
    expect(seasonPeriods()).toEqual({ total: 1, open: 1 });
  });

  it('`open_ranking_season = NULL` cai na configuração do servidor', () => {
    harness.repository.saveSettings('pvp1', { seasonMode: 'monthly', seasonOnWipe: true }, NOW);
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });

    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: NOW + 60_000,
      wipeDetected: true,
      wipeRunId: wipeRun(null),
    });

    expect(swept.seasonReason).toBe('wipe');
    expect(seasonPeriods()).toEqual({ total: 2, open: 1 });
  });

  it('um wipe feito à MÃO, sem execução nenhuma, cai na configuração do servidor', () => {
    harness.repository.saveSettings('pvp1', { seasonMode: 'monthly', seasonOnWipe: true }, NOW);
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });

    // Sem `wipeRunId`: é o wipe que alguém fez no servidor, com o
    // agente rodando. A âncora é o mundo, não o painel.
    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: NOW + 60_000,
      wipeDetected: true,
    });

    expect(swept.seasonReason).toBe('wipe');
    expect(seasonPeriods()).toEqual({ total: 2, open: 1 });
  });

  it('wipe e calendário no mesmo minuto produzem UMA virada', () => {
    harness.repository.saveSettings('pvp1', { seasonMode: 'monthly', seasonOnWipe: true }, NOW);
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });

    // Abril: o calendário venceria sozinho. E o mundo trocou no
    // mesmo sweep.
    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: Date.UTC(2026, 3, 1, 5, 0),
      wipeDetected: true,
    });

    expect(swept.rolled.filter((item) => item.kind === 'season')).toHaveLength(1);
    // Uma fechada e uma aberta — e nunca duas abertas, porque o
    // índice único parcial não deixaria.
    expect(seasonPeriods()).toEqual({ total: 2, open: 1 });
  });

  it('o calendário sozinho vira a temporada e deixa a janela de wipe de pé', () => {
    const before = sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });
    const wipe = before.open.find((period) => period.kind === 'wipe');

    const swept = sweepPeriods(harness.deps, {
      serverId: 'pvp1',
      now: Date.UTC(2026, 3, 1, 5, 0),
    });

    expect(swept.rolled.map((item) => item.kind)).toEqual(['season']);
    expect(swept.seasonReason).toBe('calendar');
    expect(harness.repository.openPeriodOf('pvp1', 'wipe')?.id).toBe(wipe?.id);
  });

  it('a temporada nova nasce com o rótulo do mês em que abriu', () => {
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: NOW });
    sweepPeriods(harness.deps, { serverId: 'pvp1', now: Date.UTC(2026, 3, 1, 5, 0) });

    expect(harness.repository.openPeriodOf('pvp1', 'season')?.label).toBe(
      'Temporada de abril de 2026',
    );
  });
});
