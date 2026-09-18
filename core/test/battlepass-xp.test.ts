// ============================================================
//  battlepass-xp.test.ts  -  DE ONDE VEM O XP, E O QUE O IMPEDE DE
//  VIR DUAS VEZES.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O XP erra em silêncio por natureza: ninguém reclama de ter
//  subido de nível rápido demais, e quem reclama do contrário é
//  ignorado por semanas. Os casos abaixo são os que produzem esse
//  silêncio:
//
//    lote repetido        o `ack` se perde, o plugin remanda o
//                         MESMO lote, e o XP dobra
//    retry do painel      "reentregar" a missão paga o XP de novo
//    teto virando fila    o que estourou hoje voltando amanhã
//    virada de dia própria  o teto zerando à meia-noite e a diária
//                         às 6 h, dando dois dias por dia
//    fonte que não existe o admin liga "saquear caixa", precifica,
//                         e nada acontece — sem nada avisando
//    time.played como XP  ele só cresce quando a SESSÃO FECHA
//
//  Nada aqui fala com um servidor de Rust: o RCON é falso e
//  responde o que o plugin responderia.
// ============================================================

import { describe, expect, it } from 'vitest';

import { BattlePassService, type BattlePassActor } from '../src/battlepass/service.js';
import { xpDayKey } from '../src/battlepass/xp-day.js';
import {
  QUEST_XP_SOURCE,
  XP_SOURCES,
  isBatchXpSource,
  whyNotXpSource,
  xpSourceOf,
} from '../src/battlepass/xp-sources.js';
import { BattlePassRepository } from '../src/db/battlepass-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { PlayersRepository } from '../src/db/players-repository.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { RankingsRepository } from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { STATS_COMMANDS, STATS_CONTRACT } from '../src/game/stats-contract.js';
import { isApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import { QuestRewardService } from '../src/quests/rewards.js';
import { StatsCollector } from '../src/rankings/collector.js';
import { FIXED_PLUGIN_METRICS } from '../src/rankings/plugin-metrics.js';
import { seasonInputSchema, type SeasonInput } from '../src/types/battlepass.js';
import { DEFAULT_QUEST_SETTINGS, questRewardSchema } from '../src/types/quests.js';

const SERVER = 'pvp1';
const OTHER = 'pvp2';
const FULANO = '76561198000000001';
const BELTRANO = '76561198000000002';
const PANEL: BattlePassActor = { name: 'admin', source: 'panel' };
const NOW = 1_757_000_000_000;
const DAY = '2026-10-07';

const logger = createLogger({ log: { level: 'silent', pretty: false } });

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: BattlePassRepository;
  readonly service: BattlePassService;
  readonly rankings: RankingsRepository;
  readonly wipes: WipesRepository;
  readonly players: PlayersRepository;
  readonly quests: QuestsRepository;
  /** Quem teve a trilha reenviada, na ordem. */
  readonly announced: string[];
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: id.toUpperCase(),
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `Servers/${id}`,
    });
  }

  const repository = new BattlePassRepository(db);
  const quests = new QuestsRepository(db);
  const announced: string[] = [];

  const service = new BattlePassService({
    repository,
    serverIds: () => servers.list().map((server) => server.id),
    // A MESMA régua das missões — é o ponto do teste da virada.
    resetAtMinuteOf: (serverId) => quests.settingsOf(serverId).resetAtMinute,
    onChange: () => undefined,
    onPlayerChange: (_serverId, steamId) => announced.push(steamId),
  });

  return {
    db,
    repository,
    service,
    rankings: new RankingsRepository(db),
    wipes: new WipesRepository(db),
    players: new PlayersRepository(db),
    quests,
    announced,
  };
}

/** Uma temporada de outubro, pronta para publicar. */
function october(overrides: Partial<SeasonInput> = {}): SeasonInput {
  return seasonInputSchema.parse({
    period: '2026-10',
    label: 'Temporada de outubro de 2026',
    levels: 10,
    xpCurve: { kind: 'flat', perLevel: 1000 },
    servers: [SERVER],
    ...overrides,
  });
}

/** Uma temporada NO AR, com as regras que o teste pedir. */
function live(
  h: Harness,
  rules: readonly { source: string; amount: number; dailyCap?: number | null; enabled?: boolean }[],
  overrides: Partial<SeasonInput> = {},
): number {
  const season = h.service.createSeason(october(overrides), PANEL);

  h.service.setSeasonState(season.id, 'active', PANEL);

  for (const rule of rules) {
    h.service.setXpRule(
      season.id,
      {
        source: rule.source,
        enabled: rule.enabled ?? true,
        amount: rule.amount,
        dailyCap: rule.dailyCap ?? null,
        label: null,
      },
      PANEL,
    );
  }

  return season.id;
}

function xpOf(h: Harness, seasonId: number, steamId: string, serverId = SERVER): number {
  return h.repository.progressOf(serverId, steamId, seasonId)?.xp ?? 0;
}

// ============================================================
//  A MIGRAÇÃO 105 (nasceu 102 — o VIP pegou o id primeiro)
// ============================================================

/** Um banco parado na migração `upTo`, como em migrations.test.ts. */
function databaseAt(upTo: number): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  for (const migration of MIGRATIONS.filter((item) => item.id <= upTo)) {
    applyMigration(db, migration);
    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @applied_at)',
    ).run({ id: migration.id, name: migration.name, applied_at: NOW });
  }

  return db;
}

describe('105 — o XP como recompensa, sobre um banco na 101', () => {
  /** Um banco na 101 com uma quest que já paga três recompensas. */
  function seeded(): AgentDatabase {
    const db = databaseAt(101);

    db.prepare(
      `INSERT INTO quests (id, title, description, category, enabled, sort, created_at, updated_at)
       VALUES ('minerador', 'Minerador', 'mine enxofre', 'diaria', 1, 10, @now, @now)`,
    ).run({ now: NOW });

    const insert = db.prepare(
      'INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)',
    );

    insert.run('minerador', 0, 'item', JSON.stringify({ shortname: 'rifle.ak', amount: 1 }));
    insert.run('minerador', 1, 'coins', JSON.stringify({ amount: 500 }));
    insert.run('minerador', 2, 'skin', JSON.stringify({ shortname: 'rifle.ak', skinId: '123' }));

    return db;
  }

  it('não perde nada do que já estava gravado', () => {
    const db = seeded();
    const before = db
      .prepare('SELECT id, quest_id, seq, kind, payload FROM quest_rewards ORDER BY seq')
      .all();

    // `toContain`, e não `toEqual([102])`: um banco semeado na 101
    // recebe tudo o que veio depois dela, e a 103 — a loja que vende
    // o passe — entrou pela mesma branch de integração. O que este
    // caso prova é sobre a 102; quantas vieram junto é outra coisa.
    expect(runMigrations(db).map((migration) => migration.id)).toContain(105);

    // Reconstruir tabela com INSERT ... SELECT é onde se perde dado
    // em silêncio — e o `id` precisa sobreviver, porque o registro
    // de quem já entregou aponta para ele.
    expect(
      db.prepare('SELECT id, quest_id, seq, kind, payload FROM quest_rewards ORDER BY seq').all(),
    ).toEqual(before);

    expect(db.prepare('SELECT count(*) AS n FROM quests').get()).toEqual({ n: 1 });

    db.close();
  });

  it('o CHECK passa a aceitar a recompensa do tipo xp', () => {
    const db = seeded();

    // Antes: o zod aceitava e o banco recusava — a missão que paga
    // XP ficava impossível de salvar.
    expect(() =>
      db
        .prepare('INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)')
        .run('minerador', 9, 'xp', '{}'),
    ).toThrow(/CHECK constraint failed/i);

    runMigrations(db);

    db.prepare('INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)').run(
      'minerador',
      9,
      'xp',
      JSON.stringify({ amount: 800 }),
    );

    expect(db.prepare("SELECT count(*) AS n FROM quest_rewards WHERE kind = 'xp'").get()).toEqual({
      n: 1,
    });

    // E o CHECK abriu para UM tipo, não para qualquer texto.
    expect(() =>
      db
        .prepare('INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)')
        .run('minerador', 10, 'kind-que-nao-existe', '{}'),
    ).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it('o índice da lista volta, e a tabela de trabalho não fica para trás', () => {
    const db = seeded();

    runMigrations(db);

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quest_rewards'",
        )
        .all() as { readonly name: string }[]
    ).map((row) => row.name);

    expect(indexes).toContain('idx_quest_rewards_quest');
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'quest_rewards_101'").get(),
    ).toEqual({ n: 0 });

    db.close();
  });

  it('a chave do XP de evento existe, e recusa o mesmo evento duas vezes', () => {
    const db = databaseAt(105);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO battlepass_xp_events
         (event_id, server_id, steam_id, season_id, source, xp, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(insert.run('quest:minerador:1:0', SERVER, FULANO, 1, QUEST_XP_SOURCE, 800, NOW).changes)
      .toBe(1);
    // A segunda é engolida pelo IGNORE: é ELE que testa a duplicata,
    // e não uma consulta antes dele.
    expect(insert.run('quest:minerador:1:0', SERVER, FULANO, 1, QUEST_XP_SOURCE, 800, NOW).changes)
      .toBe(0);

    db.close();
  });
});

// ============================================================
//  O CARDÁPIO
// ============================================================

describe('o cardápio de fontes', () => {
  it('é servido pelo agente, e cada fonte diz de onde o XP chega', () => {
    const h = harness();

    // A lista é do AGENTE: se ela morasse no painel, o admin
    // configuraria XP por "saquear caixa" e nada aconteceria.
    expect(h.service.xpSources()).toBe(XP_SOURCES);
    expect(XP_SOURCES.every((item) => item.label.length > 0 && item.unit.length > 0)).toBe(true);

    h.db.close();
  });

  it('não oferece nada que o plugin não conte', () => {
    // O `farm.madeira` do ranking nasceu assim: uma chave que
    // nenhum hook alimentava, ligada e parada em zero.
    const missing = XP_SOURCES.filter(
      (item) => item.feed === 'batch' && !FIXED_PLUGIN_METRICS.includes(item.source),
    );

    expect(missing).toEqual([]);
  });

  it('sleeper.kills está no cardápio e NÃO nasce ligado', () => {
    const sleeper = xpSourceOf('sleeper.kills');

    // Ele paga quem anda de machado por base vazia: o cardápio
    // oferece, a configuração padrão não liga.
    expect(sleeper?.defaultEnabled).toBe(false);
    expect(sleeper?.note).toMatch(/machado/i);
  });

  it('gather.* fica de fora, e a recusa diz por quê', () => {
    // Ele só é contado enquanto existir um ranking LIGADO com
    // aquele shortname: o XP morreria no dia em que o admin
    // desligasse o ranking "Madeira", sem nada acusando.
    expect(xpSourceOf('gather.wood')).toBeNull();
    expect(whyNotXpSource('gather.wood')).toMatch(/ranking ligado/i);
    expect(whyNotXpSource('gather.wood')).toMatch(/ore\./);
  });

  it('time.played fica de fora: ele é de ontem', () => {
    expect(xpSourceOf('time.played')).toBeNull();
    expect(whyNotXpSource('time.played')).toMatch(/sess/i);
  });

  it('shot.distance fica de fora: recorde não se multiplica', () => {
    expect(xpSourceOf('shot.distance')).toBeNull();
    expect(whyNotXpSource('shot.distance')).toMatch(/recorde/i);
  });

  it('a porta de gravar RECUSA a fonte que não existe', () => {
    const h = harness();
    const season = live(h, []);

    // A recusa é aqui, e não na tela: um PUT do painel velho ou do
    // script de alguém gravaria uma regra que nunca renderia nada,
    // e o admin passaria o mês achando que ligou o XP de saque.
    try {
      h.service.setXpRule(
        season,
        { source: 'loot.crate', enabled: true, amount: 10, dailyCap: null, label: null },
        PANEL,
      );
      expect.unreachable('a fonte inventada tinha que ser recusada');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      expect(isApiError(error) ? error.code : '').toBe('BATTLEPASS_XP_SOURCE_UNKNOWN');
      expect(isApiError(error) ? error.message : '').toMatch(/não dá XP/i);
    }

    expect(h.service.xpRules(season)).toEqual([]);

    h.db.close();
  });
});

// ============================================================
//  O XP DE AÇÃO — DENTRO DA TRANSAÇÃO DO LOTE
// ============================================================

/** O plugin, como ele responderia ao `flush` e ao `ack`. */
class FakePlugin {
  readonly sent: string[] = [];

  #pending: {
    batchId: string;
    players: readonly { steamId: string; metrics: Readonly<Record<string, number>> }[];
  } | null = null;

  #open: readonly { steamId: string; metrics: Readonly<Record<string, number>> }[];

  /** Quantos `ack` serão engolidos antes de o RCON voltar. */
  ackFails = 0;

  constructor(players: readonly { steamId: string; metrics: Readonly<Record<string, number>> }[]) {
    this.#open = players;
  }

  rcon(): OpsRcon {
    return {
      isConnected: true,
      send: (command: string) => Promise.resolve(this.#handle(command)),
    };
  }

  #handle(command: string): string {
    this.sent.push(command);

    const parts = command.trim().split(/\s+/);

    if (parts[0] === STATS_COMMANDS.ack) {
      if (this.ackFails > 0) {
        this.ackFails -= 1;

        throw new Error('o RCON caiu antes do ack');
      }

      this.#pending = null;

      return JSON.stringify({ ok: true, contract: STATS_CONTRACT, batchId: parts[1], players: 0 });
    }

    if (parts[0] !== STATS_COMMANDS.flush) {
      return '';
    }

    if (Number(parts[1] ?? '0') === 0 && this.#pending === null) {
      this.#pending = { batchId: 'pvp1-1757088123-41', players: this.#open };
      this.#open = [];
    }

    const batch = this.#pending;

    if (batch === null) {
      return JSON.stringify({ ok: false, error: 'NO_BATCH' });
    }

    return JSON.stringify({
      ok: true,
      contract: STATS_CONTRACT,
      batchId: batch.batchId,
      seq: 41,
      count: batch.players.length,
      offset: 0,
      limit: 100,
      players: batch.players,
      records: [],
      events: [],
    });
  }
}

function collectorOf(h: Harness, plugin: FakePlugin): StatsCollector {
  return new StatsCollector({
    repository: h.rankings,
    wipes: h.wipes,
    players: h.players,
    servers: { ids: () => [SERVER], rconOf: () => plugin.rcon() },
    pluginLoaded: () => true,
    worldAt: () => Promise.resolve(null),
    battlePass: h.service,
    logger,
  });
}

describe('o XP de ação', () => {
  it('o mesmo lote aplicado duas vezes NÃO dobra o XP', async () => {
    const h = harness();
    const season = live(h, [{ source: 'ore.sulfur', amount: 1 }]);

    const plugin = new FakePlugin([
      { steamId: FULANO, metrics: { 'ore.sulfur': 120, 'ore.total': 120 } },
    ]);

    // O RCON cai entre o COMMIT e a confirmação: o lote já está
    // gravado, e o plugin continua segurando o mesmo `batchId`.
    plugin.ackFails = 1;

    const first = await collectorOf(h, plugin).collect(SERVER, NOW);

    expect(first.applied).toBe(true);
    expect(first.xpGranted).toBe(120);
    expect(xpOf(h, season, FULANO)).toBe(120);

    const second = await collectorOf(h, plugin).collect(SERVER, NOW);

    // É o `batchId` que segura, e é por isso que o XP é calculado
    // DENTRO da transação: um segundo passo lendo `player_stats`
    // por fora somaria 120 de novo, sem nada acusar.
    expect(second.applied).toBe(false);
    expect(second.xpGranted).toBe(0);
    expect(xpOf(h, season, FULANO)).toBe(120);

    h.db.close();
  });

  it('a trilha só é reenviada DEPOIS do commit, e só de quem ganhou', async () => {
    const h = harness();

    live(h, [{ source: 'pvp.kills', amount: 500 }]);

    const plugin = new FakePlugin([
      { steamId: FULANO, metrics: { 'pvp.kills': 3 } },
      // Beltrano só morreu: nada que dê XP nesta temporada.
      { steamId: BELTRANO, metrics: { 'pvp.deaths': 2 } },
    ]);

    const round = await collectorOf(h, plugin).collect(SERVER, NOW);

    expect(round.xpGranted).toBe(1500);
    expect(h.announced).toEqual([FULANO]);
    // O `ack` é a última coisa na conversa com o plugin: o aviso
    // saiu depois dele, e portanto depois do COMMIT.
    expect(plugin.sent.at(-1)).toMatch(new RegExp(`^${STATS_COMMANDS.ack} `));

    h.db.close();
  });

  it('sem temporada no ar, o lote entra e o XP não existe', async () => {
    const h = harness();
    const plugin = new FakePlugin([{ steamId: FULANO, metrics: { 'ore.sulfur': 120 } }]);

    const round = await collectorOf(h, plugin).collect(SERVER, NOW);

    // O ranking é do ranking: o passe é carona do lote, e não
    // condição dele.
    expect(round.applied).toBe(true);
    expect(round.xpGranted).toBe(0);

    h.db.close();
  });

  it('a rodada pulada por plugin descarregado não vira XP zero', async () => {
    const h = harness();

    live(h, [{ source: 'ore.sulfur', amount: 1 }]);

    const plugin = new FakePlugin([{ steamId: FULANO, metrics: { 'ore.sulfur': 120 } }]);
    const collector = new StatsCollector({
      repository: h.rankings,
      wipes: h.wipes,
      players: h.players,
      servers: { ids: () => [SERVER], rconOf: () => plugin.rcon() },
      pluginLoaded: () => false,
      worldAt: () => Promise.resolve(null),
      battlePass: h.service,
      logger,
    });

    const round = await collector.collect(SERVER, NOW);

    // "Sem dados" não é "zero": o `status` é quem diz isso, e o
    // zero do XP ao lado dele é o zero de "não houve rodada".
    expect(round.status).toBe('not-loaded');
    expect(round.batchId).toBeNull();
    expect(plugin.sent).toEqual([]);

    h.db.close();
  });

  it('time.played viaja no mesmo lote e NÃO vira XP', () => {
    const h = harness();
    const season = live(h, [{ source: 'pvp.kills', amount: 100 }]);

    // O coletor costura `time.played` no lote junto com as
    // métricas do plugin. Ele não está no cardápio de propósito:
    // só cresce quando a sessão FECHA, e quem está online há três
    // horas tem o número de ontem.
    const result = h.service.creditBatchXp(
      {
        serverId: SERVER,
        players: [{ steamId: FULANO, metrics: { 'time.played': 10_800, 'pvp.kills': 1 } }],
        localDay: DAY,
      },
      NOW,
    );

    expect(result.granted).toBe(100);
    expect(xpOf(h, season, FULANO)).toBe(100);

    h.db.close();
  });

  it('a regra desligada não conta, e a fonte sem regra também não', () => {
    const h = harness();
    const season = live(h, [
      { source: 'ore.sulfur', amount: 10, enabled: false },
      { source: 'pvp.kills', amount: 0 },
    ]);

    const result = h.service.creditBatchXp(
      {
        serverId: SERVER,
        players: [
          { steamId: FULANO, metrics: { 'ore.sulfur': 50, 'pvp.kills': 3, 'ore.metal': 90 } },
        ],
        localDay: DAY,
      },
      NOW,
    );

    expect(result.granted).toBe(0);
    expect(xpOf(h, season, FULANO)).toBe(0);
    expect(h.announced).toEqual([]);

    h.db.close();
  });

  it('o nível sobe pela curva da temporada, numa rodada só', () => {
    const h = harness();
    const season = live(h, [{ source: 'pvp.kills', amount: 1000 }], { levels: 5 });

    const result = h.service.creditBatchXp(
      {
        serverId: SERVER,
        players: [{ steamId: FULANO, metrics: { 'pvp.kills': 3 } }],
        localDay: DAY,
      },
      NOW,
    );

    expect(result.levelUps).toEqual([{ steamId: FULANO, from: 1, to: 4 }]);
    expect(h.repository.progressOf(SERVER, FULANO, season)?.level).toBe(4);

    h.db.close();
  });
});

// ============================================================
//  O TETO, E O DIA
// ============================================================

describe('o teto diário', () => {
  it('a unidade que estoura o teto não entra, e não fica para amanhã', () => {
    const h = harness();
    const season = live(h, [{ source: 'pvp.kills', amount: 10, dailyCap: 100 }]);

    const first = h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 9 } }], localDay: DAY },
      NOW,
    );

    expect(first.granted).toBe(90);

    // A 101ª unidade não entra: o teto corta no 100.
    const second = h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 9 } }], localDay: DAY },
      NOW,
    );

    expect(second.granted).toBe(10);
    expect(second.capped).toBe(80);
    expect(xpOf(h, season, FULANO)).toBe(100);

    // E o que estourou NÃO volta amanhã: o teto de amanhã é 100 de
    // novo, e não 180. Guardar seria uma segunda contabilidade, e
    // viraria o teto numa fila.
    const tomorrow = h.service.creditBatchXp(
      {
        serverId: SERVER,
        players: [{ steamId: FULANO, metrics: { 'pvp.kills': 30 } }],
        localDay: '2026-10-08',
      },
      NOW,
    );

    expect(tomorrow.granted).toBe(100);
    expect(xpOf(h, season, FULANO)).toBe(200);

    h.db.close();
  });

  it('o teto é por FONTE, e não um só somando tudo', () => {
    const h = harness();
    const season = live(h, [
      { source: 'pvp.kills', amount: 50, dailyCap: 100 },
      { source: 'ore.sulfur', amount: 1, dailyCap: 100 },
    ]);

    h.service.creditBatchXp(
      {
        serverId: SERVER,
        players: [{ steamId: FULANO, metrics: { 'pvp.kills': 9, 'ore.sulfur': 400 } }],
        localDay: DAY,
      },
      NOW,
    );

    // Cada uma bate no seu teto: 100 + 100. Um teto único daria
    // 100 no total, e o admin teria de escolher entre deixar a
    // missão generosa e o farm contido.
    expect(xpOf(h, season, FULANO)).toBe(200);

    h.db.close();
  });

  it('o teto é por JOGADOR: o de um não gasta o do outro', () => {
    const h = harness();
    const season = live(h, [{ source: 'pvp.kills', amount: 50, dailyCap: 100 }]);

    h.service.creditBatchXp(
      {
        serverId: SERVER,
        players: [
          { steamId: FULANO, metrics: { 'pvp.kills': 4 } },
          { steamId: BELTRANO, metrics: { 'pvp.kills': 4 } },
        ],
        localDay: DAY,
      },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(100);
    expect(xpOf(h, season, BELTRANO)).toBe(100);

    h.db.close();
  });
});

describe('a virada do dia', () => {
  it('é a régua das missões: dia de calendário, e não 24 horas', () => {
    // Meio-dia de 7 de outubro, hora LOCAL — a mesma base que o
    // `nextReset` usa.
    const noon = new Date(2026, 9, 7, 12, 0, 0, 0).getTime();

    expect(xpDayKey(noon, 0)).toBe('2026-10-07');

    // Com a virada às 03:00, o que acontece à 01:00 do dia 8 ainda
    // é do dia 7: é a virada das 03:00 do dia 7 que abriu a janela.
    const lateNight = new Date(2026, 9, 8, 1, 0, 0, 0).getTime();

    expect(xpDayKey(lateNight, 180)).toBe('2026-10-07');
    // Passada a virada, é o dia 8.
    expect(xpDayKey(new Date(2026, 9, 8, 4, 0, 0, 0).getTime(), 180)).toBe('2026-10-08');
    // E com a virada à meia-noite, a mesma 01:00 já é o dia 8.
    expect(xpDayKey(lateNight, 0)).toBe('2026-10-08');
  });

  it('atravessa a virada do mês sem inventar um dia 0', () => {
    expect(xpDayKey(new Date(2026, 10, 1, 1, 0, 0, 0).getTime(), 180)).toBe('2026-10-31');
    expect(xpDayKey(new Date(2026, 10, 1, 5, 0, 0, 0).getTime(), 180)).toBe('2026-11-01');
  });

  it('o teto do passe usa o reset_at_minute DAQUELE servidor', () => {
    const h = harness();
    const season = live(h, [{ source: 'pvp.kills', amount: 10, dailyCap: 100 }]);

    h.quests.saveSettings(SERVER, { ...DEFAULT_QUEST_SETTINGS, resetAtMinute: 180 });

    // 01:00 do dia 8: pela régua do servidor ainda é o dia 7.
    const lateNight = new Date(2026, 9, 8, 1, 0, 0, 0).getTime();

    expect(h.service.dayFor(SERVER, lateNight)).toBe('2026-10-07');

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 10 } }] },
      lateNight,
    );

    // O mesmo instante, lido pelo dia do calendário, teria zerado o
    // teto — e o jogador ganharia 200 num dia só.
    const again = h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 10 } }] },
      lateNight + 60_000,
    );

    expect(again.granted).toBe(0);
    expect(xpOf(h, season, FULANO)).toBe(100);

    h.db.close();
  });
});

// ============================================================
//  O XP DE MISSÃO — A FONTE PRIORITÁRIA
// ============================================================

describe('o XP de missão', () => {
  function rewards(h: Harness): QuestRewardService {
    return new QuestRewardService({ logger, xp: h.service });
  }

  function deliver(h: Harness, amount: number, attempt = 1) {
    return rewards(h).deliver({
      serverId: SERVER,
      steamId: FULANO,
      questId: 'minerador',
      attempt,
      questTitle: 'Minerador',
      rewards: [questRewardSchema.parse({ kind: 'xp', amount })],
    });
  }

  it('paga o que a missão prometeu, e o valor não vem da regra', async () => {
    const h = harness();
    // A regra existe com outro número de propósito: o valor é o da
    // RECOMPENSA, que é o que o jogador leu na tela.
    const season = live(h, [{ source: QUEST_XP_SOURCE, amount: 7 }]);

    const [outcome] = await deliver(h, 800);

    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toMatch(/800 XP no passe/);
    expect(xpOf(h, season, FULANO)).toBe(800);

    h.db.close();
  });

  it('paga mesmo sem regra cadastrada: a missão prometeu na tela', async () => {
    const h = harness();
    const season = live(h, []);

    const [outcome] = await deliver(h, 800);

    expect(outcome?.ok).toBe(true);
    expect(xpOf(h, season, FULANO)).toBe(800);

    h.db.close();
  });

  it('o retry do painel NÃO paga duas vezes', async () => {
    const h = harness();
    const season = live(h, [{ source: QUEST_XP_SOURCE, amount: 0 }]);

    await deliver(h, 800);

    const [again] = await deliver(h, 800);

    // A chave é (escopo, missão, tentativa, posição): o botão
    // "reentregar" manda a mesma, e ela cai no INSERT OR IGNORE.
    // Isto NÃO é falha — é o retry funcionando como devia.
    expect(again?.ok).toBe(true);
    expect(again?.message).toMatch(/já tinha sido somado/i);
    expect(xpOf(h, season, FULANO)).toBe(800);

    // A tentativa SEGUINTE da mesma missão é outro evento: quem
    // refez a missão amanhã ganha de novo.
    await deliver(h, 800, 2);

    expect(xpOf(h, season, FULANO)).toBe(1600);

    h.db.close();
  });

  it('o teto da fonte vale para a missão também', async () => {
    const h = harness();
    const season = live(h, [{ source: QUEST_XP_SOURCE, amount: 0, dailyCap: 500 }]);

    const [first] = await deliver(h, 800);

    expect(first?.ok).toBe(true);
    expect(first?.message).toMatch(/cortou 300/);
    expect(xpOf(h, season, FULANO)).toBe(500);

    const [second] = await deliver(h, 800, 2);

    // O teto já estava cheio: o evento chegou, ficou registrado e
    // não somou nada. E o que sobrou NÃO fica para amanhã.
    expect(second?.ok).toBe(true);
    expect(second?.message).toMatch(/teto de XP de missão de hoje/i);
    expect(xpOf(h, season, FULANO)).toBe(500);

    h.db.close();
  });

  it('desligada a fonte, a missão não paga XP — e diz isso', async () => {
    const h = harness();
    const season = live(h, [{ source: QUEST_XP_SOURCE, amount: 0, enabled: false }]);

    const [outcome] = await deliver(h, 800);

    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toMatch(/desligado nesta temporada/i);
    expect(xpOf(h, season, FULANO)).toBe(0);

    h.db.close();
  });

  it('sem temporada no ar a recompensa FALHA, em vez de pagar zero calada', async () => {
    const h = harness();

    const [outcome] = await deliver(h, 800);

    // A missão anunciou "800 XP" e o jogador aceitou por causa
    // disso: isto precisa virar pendência no painel, com o motivo.
    expect(outcome?.ok).toBe(false);
    expect(outcome?.code).toBe('BATTLEPASS_NO_SEASON');

    h.db.close();
  });

  it('agente sem passe vira pendência visível, e não sumiço', async () => {
    const h = harness();
    const service = new QuestRewardService({ logger });

    const [outcome] = await service.deliver({
      serverId: SERVER,
      steamId: FULANO,
      questId: 'minerador',
      attempt: 1,
      questTitle: 'Minerador',
      rewards: [questRewardSchema.parse({ kind: 'xp', amount: 800 })],
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome?.code).toBe('QUEST_REWARD_UNAVAILABLE');

    h.db.close();
  });

  it('o XP de missão é de EVENTO, e não de lote', () => {
    // A distinção não é decorativa: o crédito por lote multiplica
    // pelas ocorrências do delta, e a missão traz o valor pronto.
    expect(isBatchXpSource(QUEST_XP_SOURCE)).toBe(false);
    expect(xpSourceOf(QUEST_XP_SOURCE)?.feed).toBe('event');
  });
});

// ============================================================
//  A PENALIDADE  (XP negativo)
// ============================================================

describe('o XP negativo', () => {
  it('a penalidade tira XP de quem tem', () => {
    const h = harness();
    const season = live(h, [
      { source: 'pvp.kills', amount: 100 },
      { source: 'team.kills', amount: -50 },
    ]);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 3 } }], localDay: DAY },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(300);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'team.kills': 2 } }], localDay: DAY },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(200);
  });

  it('o XP não passa de zero para baixo', () => {
    // ####  O PISO  ####
    //
    // Decisão do dono em 18/09/2026. Um buraco de -3.000 XP que o
    // jogador nunca recupera faz ele desistir da temporada — e o que
    // a penalidade existe para corrigir é o comportamento de hoje,
    // não o saldo do mês inteiro.
    const h = harness();
    const season = live(h, [{ source: 'team.kills', amount: -500 }]);

    const first = h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'team.kills': 1 } }], localDay: DAY },
      NOW,
    );

    // Ele não tinha nada: não há o que tirar.
    expect(first.granted).toBe(0);
    expect(xpOf(h, season, FULANO)).toBe(0);
  });

  it('a penalidade para no que ele tem, e não no que ela vale', () => {
    const h = harness();
    const season = live(h, [
      { source: 'pvp.kills', amount: 100 },
      { source: 'team.kills', amount: -500 },
    ]);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 2 } }], localDay: DAY },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(200);

    // A penalidade vale 500 e ele só tem 200: tira 200, não 500.
    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'team.kills': 1 } }], localDay: DAY },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(0);
  });

  it('o nível NÃO desce quando o XP cai', () => {
    // ####  O QUE ELE ALCANÇOU É DELE  ####
    //
    // O 01 §2 já dizia "o nível nunca desce", e a penalidade não
    // muda isso: o XP cai, o próximo nível volta a ficar longe, mas
    // o que já estava disponível continua disponível — senão uma
    // morte boba trancaria recompensa que ele viu destravada.
    const h = harness();
    const season = live(h, [
      { source: 'pvp.kills', amount: 100 },
      { source: 'team.kills', amount: -1000 },
    ]);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 25 } }], localDay: DAY },
      NOW,
    );

    // 2.500 XP, com 1.000 por nível: nível 3.
    expect(xpOf(h, season, FULANO)).toBe(2500);
    expect(h.repository.progressOf(SERVER, FULANO, season)?.level).toBe(3);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'team.kills': 2 } }], localDay: DAY },
      NOW,
    );

    // O XP caiu para 500 — que sozinho daria nível 1.
    expect(xpOf(h, season, FULANO)).toBe(500);
    // E o nível ficou.
    expect(h.repository.progressOf(SERVER, FULANO, season)?.level).toBe(3);
  });

  it('a penalidade não abre espaço no teto do ganho', () => {
    // Somar a penalidade ao acumulado do dia deixaria quem perdeu
    // 200 ganhar 200 além do que o admin permitiu — o teto viraria
    // um saldo, e não um limite.
    const h = harness();
    const season = live(h, [
      { source: 'pvp.kills', amount: 100, dailyCap: 300 },
      { source: 'team.kills', amount: -100 },
    ]);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 3 } }], localDay: DAY },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(300);

    h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'team.kills': 1 } }], localDay: DAY },
      NOW,
    );

    expect(xpOf(h, season, FULANO)).toBe(200);

    // O teto de `pvp.kills` continua estourado: os 300 do dia já
    // foram, e a penalidade de outra fonte não os devolve.
    const again = h.service.creditBatchXp(
      { serverId: SERVER, players: [{ steamId: FULANO, metrics: { 'pvp.kills': 3 } }], localDay: DAY },
      NOW,
    );

    expect(again.granted).toBe(0);
    expect(xpOf(h, season, FULANO)).toBe(200);
  });

  it('as fontes de penalidade continuam nascendo desligadas', () => {
    // O cardápio OFERECE; a configuração padrão não liga. Vale para
    // `sleeper.kills` (paga quem anda de machado por base vazia) e
    // vale aqui: ninguém deve perder XP por uma regra que o admin
    // não escolheu.
    for (const key of ['team.kills', 'suicides', 'pvp.deaths']) {
      expect(xpSourceOf(key)?.defaultEnabled ?? false).toBe(false);
    }
  });
});
