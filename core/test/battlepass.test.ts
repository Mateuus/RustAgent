// ============================================================
//  O passe de batalha, do lado do agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O passe falha calado por natureza: ninguém reclama de um nível
//  que não destravou, e quem reclama descobre semanas depois. Os
//  casos abaixo são os que produzem esse silêncio:
//
//    duas temporadas no ar     duas trilhas na mesma tela, sem nada
//                              que diga qual vale
//    dois direitos vivos       comprar outubro duas vezes, e o
//                              estorno sem saber qual fechar
//    trilha editada depois     o jogador levou a AK e a tela passa a
//                              dizer que ele levou pedra
//    migração que perde dado   a reconstrução de quest_rewards para
//                              abrir o CHECK do tipo `skin`
//    teto virando fila         XP que estoura o teto voltando amanhã
//    clique duplo              a mesma recompensa entregue duas vezes
//    faixa paga de graça       o nível alcançado destravando o pago
//                              de quem não comprou
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { BattlePassRepository } from '../src/db/battlepass-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { BattlePassService, type BattlePassActor } from '../src/battlepass/service.js';
import { ApiError, apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerBattlePassRoutes } from '../src/http/routes/battlepass.js';
import {
  battlePassClaimPushSchema,
  battlePassReadyPushSchema,
  claimExceptionsOf,
  levelAt,
  levelCost,
  payloadOriginOf,
  periodOf,
  seasonInputSchema,
  trackProgress,
  xpToReach,
  type SeasonInput,
} from '../src/types/battlepass.js';
import { questRewardSchema, type QuestReward } from '../src/types/quests.js';

const SERVER = 'pvp1';
const OTHER = 'pvp2';
const PLAYER = '76561190000000001';
const PLAYER_2 = '76561190000000002';
const PANEL: BattlePassActor = { name: 'admin', source: 'panel' };
const T0 = 1_800_000_000_000;

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: BattlePassRepository;
  readonly service: BattlePassService;
  readonly servers: ServersRepository;
  /** Quantas vezes o catálogo avisou que mudou. */
  readonly changed: { count: number };
  /** Quem teve a trilha avisada. */
  readonly players: string[];
}

function seedServers(servers: ServersRepository): void {
  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: `Dev ${String(index + 1)}`,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  seedServers(servers);

  const repository = new BattlePassRepository(db);
  const changed = { count: 0 };
  const players: string[] = [];

  const service = new BattlePassService({
    repository,
    serverIds: () => servers.list().map((server) => server.id),
    onChange: () => {
      changed.count += 1;
    },
    onPlayerChange: (_serverId, steamId) => players.push(steamId),
  });

  return { db, repository, service, servers, changed, players };
}

/** Uma temporada de outubro, pronta para publicar. */
function october(overrides: Partial<SeasonInput> = {}): SeasonInput {
  return seasonInputSchema.parse({
    period: '2026-10',
    label: 'Temporada de outubro de 2026',
    levels: 5,
    xpCurve: { kind: 'flat', perLevel: 1000 },
    servers: [SERVER],
    ...overrides,
  });
}

/**
 * As recompensas passam pelo zod aqui de proposito.
 *
 * Ele preenche os campos que faltam (`skinId: '0'`, `perMeter:
 * null`), e e a forma NORMALIZADA que o banco guarda. Comparar com
 * o objeto cru faria o teste falhar por um campo que ninguem
 * digitou -- e passar a limpo o que o snapshot realmente congela.
 */
const AK: QuestReward = questRewardSchema.parse({ kind: 'item', shortname: 'rifle.ak', amount: 1 });
const COINS: QuestReward = questRewardSchema.parse({ kind: 'coins', amount: 500 });
const STONES: QuestReward = questRewardSchema.parse({
  kind: 'item',
  shortname: 'stones',
  amount: 1000,
});

// ============================================================
//  A CURVA
// ============================================================

describe('a curva de XP', () => {
  const flat = { kind: 'flat', perLevel: 1000 } as const;

  it('o nível 1 é de graça, e é onde todo mundo nasce', () => {
    // A decisão que o documento não tomava: o card mostra "NÍVEL 17"
    // com a recompensa do 17 já disponível, então alcançar o 1 não
    // pode custar XP — senão o jogador novo nasceria no nível 0.
    expect(levelCost(flat, 1)).toBe(0);
    expect(xpToReach(flat, 1)).toBe(0);
    expect(levelAt(flat, 30, 0)).toBe(1);
  });

  it('a barra diz quanto falta para o próximo', () => {
    const at = trackProgress(flat, 30, 2400);

    expect(at.level).toBe(3);
    expect(at.intoLevel).toBe(400);
    expect(at.neededForNext).toBe(1000);
    expect(at.completed).toBe(false);
  });

  it('passar do último nível não é erro: o excedente não compra nada', () => {
    const at = trackProgress(flat, 5, 1_000_000);

    expect(at.level).toBe(5);
    expect(at.completed).toBe(true);
    // Fingir um nível 6 numa trilha de 5 quebraria a tela e a
    // tabela de recompensas.
    expect(at.neededForNext).toBeNull();
  });

  it('a curva linear encarece degrau a degrau', () => {
    const linear = { kind: 'linear', base: 100, step: 50 } as const;

    expect(levelCost(linear, 2)).toBe(100);
    expect(levelCost(linear, 3)).toBe(150);
    expect(xpToReach(linear, 4)).toBe(100 + 150 + 200);
  });

  it('a curva desenhada à mão precisa de um valor por degrau', () => {
    // Sobra ou falta é um nível custando um número que ninguém
    // escolheu — e é o tipo de erro que só aparece quando alguém
    // trava no nível 39.
    expect(() =>
      october({ levels: 5, xpCurve: { kind: 'table', steps: [100, 200] } }),
    ).toThrow(ZodError);

    const ok = october({ levels: 5, xpCurve: { kind: 'table', steps: [10, 20, 30, 40] } });

    expect(xpToReach(ok.xpCurve, 5)).toBe(100);
  });
});

// ============================================================
//  A MIGRAÇÃO 101
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
    ).run({ id: migration.id, name: migration.name, applied_at: T0 });
  }

  return db;
}

describe('101 — o passe, sobre um banco na 100', () => {
  /** Um banco na 100 com uma quest que já paga três recompensas. */
  function seeded(): AgentDatabase {
    const db = databaseAt(100);

    db.prepare(
      `INSERT INTO quests (id, title, description, category, enabled, sort, created_at, updated_at)
       VALUES ('caca-ao-urso', 'Caça ao urso', 'mate o urso', 'diaria', 1, 10, @now, @now)`,
    ).run({ now: T0 });

    const insert = db.prepare(
      'INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)',
    );

    insert.run('caca-ao-urso', 0, 'item', JSON.stringify({ shortname: 'rifle.ak', amount: 1 }));
    insert.run('caca-ao-urso', 1, 'coins', JSON.stringify({ amount: 500 }));
    insert.run('caca-ao-urso', 2, 'vip', JSON.stringify({ tier: 'ouro', days: 30 }));

    return db;
  }

  it('não perde nada do que já estava gravado', () => {
    const db = seeded();
    const before = db
      .prepare('SELECT id, quest_id, seq, kind, payload FROM quest_rewards ORDER BY seq')
      .all();

    // `toContain`, e não `toEqual([101])`: a lista cresce a cada
    // migração nova acima da 100 — a 103, da loja que vende o passe,
    // já entrou. O que este teste prova é sobre a 101, e não que ela
    // seja a última do array.
    expect(runMigrations(db).map((migration) => migration.id)).toContain(101);

    // A 101 RECONSTRÓI `quest_rewards` para abrir o CHECK do `kind`.
    // Recriar tabela com INSERT ... SELECT é onde se perde dado em
    // silêncio — e o `id` precisa sobreviver, porque o registro de
    // quem já entregou aponta para ele.
    expect(
      db.prepare('SELECT id, quest_id, seq, kind, payload FROM quest_rewards ORDER BY seq').all(),
    ).toEqual(before);

    // E a quest continua de pé: o DROP da tabela velha não pode ter
    // levado o dono dela pela cascata.
    expect(db.prepare('SELECT count(*) AS n FROM quests').get()).toEqual({ n: 1 });

    db.close();
  });

  it('o CHECK passa a aceitar a recompensa do tipo skin', () => {
    const db = seeded();

    // Antes: o zod da frente F aceitava e o banco recusava — a
    // feature ficava completa e inerte.
    expect(() =>
      db
        .prepare('INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)')
        .run('caca-ao-urso', 9, 'skin', '{}'),
    ).toThrow(/CHECK constraint failed/i);

    runMigrations(db);

    db.prepare('INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)').run(
      'caca-ao-urso',
      9,
      'skin',
      JSON.stringify({ skinRef: 12, days: 30 }),
    );

    expect(
      db.prepare("SELECT count(*) AS n FROM quest_rewards WHERE kind = 'skin'").get(),
    ).toEqual({ n: 1 });

    // E o que não é tipo conhecido continua recusado: o CHECK abriu
    // para um tipo, não para qualquer texto.
    expect(() =>
      db
        .prepare('INSERT INTO quest_rewards (quest_id, seq, kind, payload) VALUES (?, ?, ?, ?)')
        .run('caca-ao-urso', 10, 'kind-que-nao-existe', '{}'),
    ).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it('o índice da trilha volta depois da reconstrução', () => {
    const db = seeded();

    runMigrations(db);

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quest_rewards'")
        .all() as { readonly name: string }[]
    ).map((row) => row.name);

    expect(indexes).toContain('idx_quest_rewards_quest');
    // E a tabela de trabalho não ficou para trás.
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'quest_rewards_100'").get(),
    ).toEqual({ n: 0 });

    db.close();
  });

  it('as dez tabelas do passe existem', () => {
    const db = databaseAt(101);
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'battlepass_%'")
        .all() as { readonly name: string }[]
    ).map((row) => row.name);

    expect(tables.sort()).toEqual([
      'battlepass_audit',
      'battlepass_claims',
      'battlepass_entitlements',
      'battlepass_pending',
      'battlepass_progress',
      'battlepass_rewards',
      'battlepass_season_servers',
      'battlepass_seasons',
      'battlepass_xp_daily',
      'battlepass_xp_rules',
    ]);

    db.close();
  });
});

// ============================================================
//  A TEMPORADA
// ============================================================

describe('a temporada', () => {
  it('só uma fica no ar por servidor', () => {
    const h = harness();
    const outubro = h.service.createSeason(october(), PANEL);
    const novembro = h.service.createSeason(
      october({ period: '2026-11', label: 'Temporada de novembro' }),
      PANEL,
    );

    h.service.setSeasonState(outubro.id, 'active', PANEL);

    // Duas seriam duas trilhas na mesma tela sem nada que diga qual
    // vale — e o jogo leria a que o ORDER BY escolhesse.
    expect(() => h.service.setSeasonState(novembro.id, 'active', PANEL)).toThrowError(
      expect.objectContaining({ code: 'BATTLEPASS_SEASON_CONFLICT' }),
    );

    expect(h.service.activeSeason(SERVER)?.id).toBe(outubro.id);

    // Fechada a primeira, a segunda entra.
    h.service.setSeasonState(outubro.id, 'closed', PANEL);
    h.service.setSeasonState(novembro.id, 'active', PANEL);

    expect(h.service.activeSeason(SERVER)?.id).toBe(novembro.id);

    h.db.close();
  });

  it('a trava é POR SERVIDOR: dois servidores, duas trilhas', () => {
    const h = harness();
    const noPvp1 = h.service.createSeason(october(), PANEL);
    const noPvp2 = h.service.createSeason(
      october({ label: 'Outubro no PVP2', servers: [OTHER] }),
      PANEL,
    );

    h.service.setSeasonState(noPvp1.id, 'active', PANEL);
    h.service.setSeasonState(noPvp2.id, 'active', PANEL);

    expect(h.service.activeSeason(SERVER)?.id).toBe(noPvp1.id);
    expect(h.service.activeSeason(OTHER)?.id).toBe(noPvp2.id);

    h.db.close();
  });

  it('não entra no ar sem servidor nenhum', () => {
    const h = harness();
    const orfa = h.service.createSeason(october({ servers: [] }), PANEL);

    // Sem junção ela não vale em lugar nenhum: publicar seria um
    // botão que não faz nada, e o admin acharia que fez.
    expect(() => h.service.setSeasonState(orfa.id, 'active', PANEL)).toThrowError(
      expect.objectContaining({ code: 'BATTLEPASS_SEASON_NO_SERVERS' }),
    );

    h.db.close();
  });

  it('encolher a trilha com recompensa lá em cima é recusado', () => {
    const h = harness();
    const season = h.service.createSeason(october({ levels: 10 }), PANEL);

    h.service.setTrackCell(season.id, 9, 'free', { rewards: [AK], milestone: false }, PANEL);

    expect(() =>
      h.service.updateSeason(season.id, october({ levels: 5 }), PANEL),
    ).toThrowError(expect.objectContaining({ code: 'BATTLEPASS_LEVELS_IN_USE' }));

    h.db.close();
  });

  it('toda escrita registra e avisa', () => {
    const h = harness();
    const season = h.service.createSeason(october(), PANEL);

    h.service.setTrackCell(season.id, 1, 'free', { rewards: [COINS], milestone: false }, PANEL);
    h.service.setSeasonState(season.id, 'active', PANEL);

    // Esquecer o aviso é a trilha que muda na tela do admin e
    // continua a antiga dentro do jogo.
    expect(h.changed.count).toBe(3);

    const actions = h.service.audit({ limit: 10 }).map((entry) => entry.action);

    expect(actions).toEqual(['season.state', 'track.set', 'season.create']);

    h.db.close();
  });
});

// ============================================================
//  O DIREITO COMPRADO
// ============================================================

describe('o direito comprado', () => {
  function active(h: Harness): number {
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);

    return season.id;
  }

  it('o índice parcial recusa dois direitos vivos no mesmo mês', () => {
    const h = harness();

    active(h);

    h.repository.grantEntitlement({
      serverId: SERVER,
      steamId: PLAYER,
      period: '2026-10',
      origin: 'loja',
      createdBy: 'loja:1',
    });

    // O INSERT cru é o que a corrida faria: duas concessões no mesmo
    // instante, uma pela loja e outra pelo painel. Quem segura é o
    // BANCO, e não o código lembrando de conferir.
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO battlepass_entitlements
             (server_id, steam_id, period, origin, level_at_grant, created_at, created_by)
           VALUES (?, ?, ?, 'painel', 1, ?, 'admin')`,
        )
        .run(SERVER, PLAYER, '2026-10', T0),
    ).toThrow(/UNIQUE constraint failed/i);

    h.db.close();
  });

  it('revogado libera o mês de novo, e o histórico fica', () => {
    const h = harness();

    active(h);

    const first = h.repository.grantEntitlement({
      serverId: SERVER,
      steamId: PLAYER,
      period: '2026-10',
      origin: 'loja',
      createdBy: 'loja:1',
    });

    h.service.revokeEntitlement(first.entitlement.id, PANEL);

    const second = h.repository.grantEntitlement({
      serverId: SERVER,
      steamId: PLAYER,
      period: '2026-10',
      origin: 'painel',
      createdBy: 'admin',
    });

    expect(second.created).toBe(true);
    // Revogar NÃO apaga a linha: a segunda discussão sobre o mesmo
    // jogador precisa da primeira.
    expect(h.service.entitlementsOf(PLAYER)).toHaveLength(2);

    h.db.close();
  });

  it('dar de novo é idempotente, e não soma nada', () => {
    const h = harness();

    active(h);

    const first = h.service.grant(
      { serverId: SERVER, steamId: PLAYER, period: '2026-10', origin: 'loja', createdBy: 'loja:1' },
      PANEL,
    );
    const again = h.service.grant(
      { serverId: SERVER, steamId: PLAYER, period: '2026-10', origin: 'site', createdBy: 'site:2' },
      PANEL,
    );

    // Outubro já é dele, e um segundo outubro não existe. É isso que
    // faz o retry da entrega do site não virar dois direitos.
    expect(again.created).toBe(false);
    expect(again.entitlement.id).toBe(first.entitlement.id);
    expect(again.entitlement.origin).toBe('loja');

    h.db.close();
  });

  it('o passe vale só naquele servidor', () => {
    const h = harness();
    const noPvp2 = h.service.createSeason(october({ servers: [OTHER] }), PANEL);

    active(h);
    h.service.setSeasonState(noPvp2.id, 'active', PANEL);

    h.service.grant(
      { serverId: SERVER, steamId: PLAYER, period: '2026-10', origin: 'loja', createdBy: 'loja:1' },
      PANEL,
    );

    expect(h.service.hasPass(SERVER, PLAYER, '2026-10')).toBe(true);
    // Comprar no pvp1 não destrava a faixa paga no pvp2, pela mesma
    // razão que matar no pvp1 não dá nível no pvp2.
    expect(h.service.hasPass(OTHER, PLAYER, '2026-10')).toBe(false);

    h.db.close();
  });
});

// ============================================================
//  O XP
// ============================================================

describe('o XP', () => {
  function withSeason(h: Harness): number {
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setXpRule(
      season.id,
      { source: 'ore.sulfur', enabled: true, amount: 10, dailyCap: 100, label: null },
      PANEL,
    );

    return season.id;
  }

  it('o teto corta, e o excedente não fica para amanhã', () => {
    const h = harness();

    withSeason(h);

    const first = h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'ore.sulfur',
      units: 8,
      localDay: '2026-10-07',
    });

    expect(first.granted).toBe(80);

    // A 101ª unidade de XP de uma fonte com teto 100 não entra...
    const second = h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'ore.sulfur',
      units: 8,
      localDay: '2026-10-07',
    });

    expect(second.granted).toBe(20);
    expect(second.capped).toBe(60);

    // ...e não fica guardada: amanhã o teto é 100 de novo, e não
    // 160. Guardar seria uma segunda contabilidade, e viraria o teto
    // numa fila.
    const tomorrow = h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'ore.sulfur',
      units: 20,
      localDay: '2026-10-08',
    });

    expect(tomorrow.granted).toBe(100);

    h.db.close();
  });

  it('o teto é POR FONTE, e não um só somando tudo', () => {
    const h = harness();
    const season = withSeason(h);

    h.service.setXpRule(
      season,
      { source: 'quest.completed', enabled: true, amount: 800, dailyCap: null, label: null },
      PANEL,
    );

    h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'ore.sulfur',
      units: 50,
      localDay: '2026-10-07',
    });

    // A missão é generosa e o farm é contido, sem escolher entre as
    // duas coisas — que é o motivo de o teto ser por fonte.
    const quest = h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'quest.completed',
      units: 1,
      localDay: '2026-10-07',
    });

    expect(quest.granted).toBe(800);
    expect(h.repository.progressOf(SERVER, PLAYER, season)?.xp).toBe(900);

    h.db.close();
  });

  it('fonte desligada, ou que não existe, não rende nada', () => {
    const h = harness();
    const season = withSeason(h);

    expect(
      h.service.creditXp({ serverId: SERVER, steamId: PLAYER, source: 'sleeper.kills', units: 9 })
        .reason,
    ).toBe('no_rule');

    h.service.setXpRule(
      season,
      { source: 'ore.sulfur', enabled: false, amount: 10, dailyCap: 100, label: null },
      PANEL,
    );

    expect(
      h.service.creditXp({ serverId: SERVER, steamId: PLAYER, source: 'ore.sulfur', units: 9 })
        .reason,
    ).toBe('disabled');

    h.db.close();
  });

  it('o XP é por servidor: o nível do pvp1 não anda no pvp2', () => {
    const h = harness();
    const season = withSeason(h);

    h.repository.setServers(season, [SERVER, OTHER]);
    h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'ore.sulfur',
      units: 10,
      localDay: '2026-10-07',
    });

    expect(h.repository.progressOf(SERVER, PLAYER, season)?.xp).toBe(100);
    expect(h.repository.progressOf(OTHER, PLAYER, season)).toBeNull();

    h.db.close();
  });

  it('o nível sobe pela curva, e nunca desce', () => {
    const h = harness();
    const season = h.service.createSeason(october({ levels: 5 }), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setXpRule(
      season.id,
      { source: 'quest.completed', enabled: true, amount: 1500, dailyCap: null, label: null },
      PANEL,
    );

    const credit = h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'quest.completed',
      units: 2,
      localDay: '2026-10-07',
    });

    expect(credit.levelBefore).toBe(1);
    expect(credit.level).toBe(4);

    h.db.close();
  });
});

// ============================================================
//  A TRILHA DO JOGADOR, E O RESGATE
// ============================================================

describe('o resgate', () => {
  /** Uma temporada no ar, com AK no nível 1 grátis e pago. */
  function ready(h: Harness, overrides: Partial<SeasonInput> = {}): number {
    const season = h.service.createSeason(october(overrides), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setTrackCell(season.id, 1, 'free', { rewards: [AK, COINS], milestone: false }, PANEL);
    h.service.setTrackCell(season.id, 1, 'paid', { rewards: [STONES], milestone: true }, PANEL);

    return season.id;
  }

  it('a faixa paga fica trancada para quem não comprou — e diz por quê', () => {
    const h = harness();

    ready(h);

    const track = h.service.trackOf(SERVER, PLAYER);
    const free = track.cells.find((cell) => cell.level === 1 && cell.lane === 'free');
    const paid = track.cells.find((cell) => cell.level === 1 && cell.lane === 'paid');

    expect(free?.state).toBe('available');
    expect(paid?.state).toBe('locked');
    // Cadeado sem motivo faz o jogador achar que o passe engoliu o
    // prêmio. A recompensa aparece; o motivo também.
    expect(paid?.reason).toContain('faixa paga');
    expect(paid?.rewards).toHaveLength(1);

    h.db.close();
  });

  it('a compra olha para trás: comprar destrava todo nível já alcançado', () => {
    const h = harness();
    const season = ready(h);

    h.service.setTrackCell(season, 2, 'paid', { rewards: [AK], milestone: false }, PANEL);
    h.service.setXpRule(
      season,
      { source: 'quest.completed', enabled: true, amount: 1000, dailyCap: null, label: null },
      PANEL,
    );
    h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'quest.completed',
      units: 2,
      localDay: '2026-10-07',
    });

    h.service.grant(
      { serverId: SERVER, steamId: PLAYER, period: '2026-10', origin: 'loja', createdBy: 'loja:1' },
      PANEL,
    );

    const paid = h.service
      .trackOf(SERVER, PLAYER)
      .cells.filter(
        (cell) => cell.lane === 'paid' && cell.state === 'available' && cell.rewards.length > 0,
      );

    // Quem compra no nível 3 leva os 3. É o principal motivo de
    // alguém comprar um passe no meio do mês.
    expect(paid.map((cell) => cell.level)).toEqual([1, 2]);

    h.db.close();
  });

  it('com o retroativo desligado, a compra vale do nível seguinte', () => {
    const h = harness();
    const season = ready(h, { retroactive: false });

    h.service.setTrackCell(season, 2, 'paid', { rewards: [AK], milestone: false }, PANEL);
    h.service.setXpRule(
      season,
      { source: 'quest.completed', enabled: true, amount: 1000, dailyCap: null, label: null },
      PANEL,
    );
    h.service.creditXp({
      serverId: SERVER,
      steamId: PLAYER,
      source: 'quest.completed',
      units: 1,
      localDay: '2026-10-07',
    });

    h.service.grant(
      { serverId: SERVER, steamId: PLAYER, period: '2026-10', origin: 'loja', createdBy: 'loja:1' },
      PANEL,
    );

    const track = h.service.trackOf(SERVER, PLAYER);
    const first = track.cells.find((cell) => cell.level === 1 && cell.lane === 'paid');
    const second = track.cells.find((cell) => cell.level === 2 && cell.lane === 'paid');

    // Ele estava no nível 2 ao comprar: o 1 e o 2 ficam para trás, e
    // a tela diz isso em vez de mostrar um cadeado mudo.
    expect(first?.state).toBe('locked');
    expect(first?.reason).toContain('nível seguinte');
    expect(second?.state).toBe('locked');

    h.db.close();
  });

  it('a trilha congelada no resgate não muda quando o catálogo muda depois', () => {
    const h = harness();
    const season = ready(h);

    const { claim } = h.service.claim(
      { serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' },
      PANEL,
    );

    expect(claim.snapshot).toEqual([AK, COINS]);

    // O admin reescreve o nível 1 no dia 20.
    h.service.setTrackCell(season, 1, 'free', { rewards: [STONES], milestone: false }, PANEL);

    // O que ele levou continua sendo o que ele levou. Editar a
    // trilha no dia 20 não pode mudar o que o nível 1 prometia.
    const saved = h.repository.getClaim(claim.id);

    expect(saved?.snapshot).toEqual([AK, COINS]);
    expect(h.repository.cell(season, 1, 'free')?.rewards).toEqual([STONES]);

    h.db.close();
  });

  it('apagar a recompensa depois não apaga o que já foi levado', () => {
    const h = harness();
    const season = ready(h);
    const { claim } = h.service.claim(
      { serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' },
      PANEL,
    );

    h.service.clearTrackCell(season, 1, 'free', PANEL);

    expect(h.repository.getClaim(claim.id)?.snapshot).toEqual([AK, COINS]);

    h.db.close();
  });

  it('clicar duas vezes não entrega duas vezes', () => {
    const h = harness();

    ready(h);
    h.service.claim({ serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' }, PANEL);

    expect(() =>
      h.service.claim({ serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' }, PANEL),
    ).toThrowError(expect.objectContaining({ code: 'BATTLEPASS_ALREADY_CLAIMED' }));

    h.db.close();
  });

  it('nível não alcançado é recusado com o motivo', () => {
    const h = harness();
    const season = ready(h);

    h.service.setTrackCell(season, 4, 'free', { rewards: [AK], milestone: false }, PANEL);

    expect(() =>
      h.service.claim({ serverId: SERVER, steamId: PLAYER, level: 4, lane: 'free' }, PANEL),
    ).toThrowError(expect.objectContaining({ code: 'BATTLEPASS_LOCKED' }));

    h.db.close();
  });

  it('resgatar tudo leva só o que está disponível', () => {
    const h = harness();
    const season = ready(h);

    h.service.setTrackCell(season, 3, 'free', { rewards: [AK], milestone: false }, PANEL);

    const done = h.service.claimAll(SERVER, PLAYER, PANEL);

    // O nível 3 não foi alcançado, e a faixa paga não foi comprada:
    // sobra o nível 1 grátis.
    expect(done).toHaveLength(1);
    expect(done[0]?.claim.level).toBe(1);

    h.db.close();
  });
});

// ============================================================
//  A CAIXA
// ============================================================

describe('a caixa de pendências', () => {
  function claimed(h: Harness): number {
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setTrackCell(season.id, 1, 'free', { rewards: [AK, COINS], milestone: false }, PANEL);

    return h.service.claim({ serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' }, PANEL)
      .claim.id;
  }

  it('o que não coube fica devendo, e o resto sai', () => {
    const h = harness();
    const claimId = claimed(h);

    // Uma falha não derruba as outras: o item falha por espaço e os
    // 500 OZCoin da mesma linha são creditados.
    const settled = h.service.settle(claimId, [
      { idx: 0, ok: false, code: 'INVENTORY_FULL' },
      { idx: 1, ok: true },
    ]);

    expect(settled.claim.status).toBe('pending');
    expect(settled.claim.settledAt).toBeNull();
    expect(settled.pending).toHaveLength(1);
    expect(settled.pending[0]?.idx).toBe(0);
    expect(settled.pending[0]?.code).toBe('INVENTORY_FULL');

    h.db.close();
  });

  it('a marca de resgatado só vem depois de tudo entregue', () => {
    const h = harness();
    const claimId = claimed(h);

    h.service.settle(claimId, [{ idx: 0, ok: false, code: 'INVENTORY_FULL' }, { idx: 1, ok: true }]);
    h.service.settle(claimId, [{ idx: 0, ok: true }]);

    const claim = h.repository.getClaim(claimId);

    expect(claim?.status).toBe('claimed');
    expect(claim?.settledAt).not.toBeNull();
    expect(h.service.pendingOf(SERVER, PLAYER)).toHaveLength(0);

    h.db.close();
  });

  it('a mesma falha duas vezes conta tentativa, e não vira duas linhas', () => {
    const h = harness();
    const claimId = claimed(h);

    h.service.settle(claimId, [{ idx: 0, ok: false, code: 'INVENTORY_FULL' }]);
    h.service.settle(claimId, [{ idx: 0, ok: false, code: 'INVENTORY_FULL' }]);

    const pending = h.service.pendingOf(SERVER, PLAYER);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(2);

    h.db.close();
  });

  it('o ponto some quando ele ABRE a caixa, não quando recebe', () => {
    const h = harness();
    const claimId = claimed(h);

    h.service.settle(claimId, [{ idx: 0, ok: false, code: 'INVENTORY_FULL' }]);

    expect(h.service.trackOf(SERVER, PLAYER).unseen).toBe(true);

    h.service.openBox(SERVER, PLAYER);

    // Ter pendência e saber que tem são coisas diferentes: a
    // pendência continua lá.
    expect(h.service.trackOf(SERVER, PLAYER).unseen).toBe(false);
    expect(h.service.pendingOf(SERVER, PLAYER)).toHaveLength(1);

    h.db.close();
  });

  it('o que sobrou da temporada é entregue, e não confiscado', () => {
    const h = harness();
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setTrackCell(season.id, 1, 'free', { rewards: [AK], milestone: false }, PANEL);
    h.service.setSeasonState(season.id, 'closed', PANEL);

    // A temporada fechou: `claim` recusaria, e é por isso que a
    // virada do mês tem porta própria.
    const rolled = h.service.claimFor(
      { serverId: SERVER, steamId: PLAYER, seasonId: season.id, level: 1, lane: 'free' },
      { name: 'sistema', source: 'system' },
    );

    expect(rolled?.rewards).toEqual([AK]);

    h.service.settle(
      rolled?.claim.id ?? 0,
      [{ idx: 0, ok: false, code: 'PLAYER_OFFLINE' }],
      'rollover',
    );

    expect(h.service.pendingOf(SERVER, PLAYER)[0]?.origin).toBe('rollover');

    // E quem já tinha resgatado não ganha de novo.
    expect(
      h.service.claimFor(
        { serverId: SERVER, steamId: PLAYER, seasonId: season.id, level: 1, lane: 'free' },
        { name: 'sistema', source: 'system' },
      ),
    ).toBeNull();

    h.db.close();
  });
});

// ============================================================
//  AS ROTAS
// ============================================================

async function routes(h: Harness): Promise<FastifyInstance> {
  const app = Fastify();

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

  await app.register(async (api) => {
    registerBattlePassRoutes(api, { service: h.service, servers: h.servers });
  });

  await app.ready();

  return app;
}

describe('as rotas', () => {
  it('criam, publicam e devolvem a temporada com as datas em ISO', async () => {
    const h = harness();
    const app = await routes(h);

    const created = await app.inject({
      method: 'POST',
      url: '/battlepass/seasons',
      payload: october(),
    });

    expect(created.statusCode).toBe(201);

    const season = created.json<{ season: { id: number; state: string; createdAt: string } }>().season;

    expect(season.state).toBe('draft');
    // Epoch em ms é do banco; a borda formata.
    expect(season.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const published = await app.inject({
      method: 'PUT',
      url: `/battlepass/seasons/${String(season.id)}/state`,
      payload: { state: 'active' },
    });

    expect(published.json<{ season: { state: string } }>().season.state).toBe('active');

    await app.close();
    h.db.close();
  });

  it('a recusa chega com a frase pronta, e não como 500', async () => {
    const h = harness();
    const app = await routes(h);
    const first = h.service.createSeason(october(), PANEL);
    const second = h.service.createSeason(october({ period: '2026-11' }), PANEL);

    h.service.setSeasonState(first.id, 'active', PANEL);

    const refused = await app.inject({
      method: 'PUT',
      url: `/battlepass/seasons/${String(second.id)}/state`,
      payload: { state: 'active' },
    });

    expect(refused.statusCode).toBe(409);

    const body = refused.json<{ error: string; message: string }>();

    expect(body.error).toBe('BATTLEPASS_SEASON_CONFLICT');
    // A mesma frase que o admin lê no painel e o jogo mostra no chat.
    expect(body.message).toContain('já está no ar');

    await app.close();
    h.db.close();
  });

  it('a trilha de um jogador vem com estado, motivo e a caixa', async () => {
    const h = harness();
    const app = await routes(h);
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setTrackCell(season.id, 1, 'paid', { rewards: [AK], milestone: true }, PANEL);

    const response = await app.inject({
      method: 'GET',
      url: `/battlepass/players/${PLAYER_2}?serverId=${SERVER}`,
    });

    const track = response.json<{
      track: { paid: boolean; unseen: boolean; cells: { state: string; reason: string | null }[] };
    }>().track;

    expect(track.paid).toBe(false);
    expect(track.unseen).toBe(false);
    expect(track.cells.some((cell) => cell.state === 'locked' && cell.reason !== null)).toBe(true);

    await app.close();
    h.db.close();
  });

  it('servidor que não existe é 404, e não lista vazia', async () => {
    const h = harness();
    const app = await routes(h);

    const response = await app.inject({ method: 'GET', url: '/battlepass/overview?serverId=pvp9' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('SERVER_NOT_FOUND');

    await app.close();
    h.db.close();
  });

  it('o direito concedido pelo painel volta 201 com created', async () => {
    const h = harness();
    const app = await routes(h);
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);

    const first = await app.inject({
      method: 'POST',
      url: '/battlepass/entitlements',
      payload: { serverId: SERVER, steamId: PLAYER, period: '2026-10' },
    });

    expect(first.statusCode).toBe(201);
    expect(first.json<{ created: boolean }>().created).toBe(true);

    // Dar de novo não é erro: o mês já é dele.
    const again = await app.inject({
      method: 'POST',
      url: '/battlepass/entitlements',
      payload: { serverId: SERVER, steamId: PLAYER, period: '2026-10' },
    });

    expect(again.json<{ created: boolean }>().created).toBe(false);

    await app.close();
    h.db.close();
  });
});

// ============================================================
//  O CALENDÁRIO
// ============================================================

describe('o mês', () => {
  it('é o do calendário, e não "a atual"', () => {
    expect(periodOf({ year: 2026, month: 10, day: 7 })).toBe('2026-10');
    // O zero à esquerda não é enfeite: sem ele a ordenação por texto
    // poria dezembro antes de fevereiro.
    expect(periodOf({ year: 2026, month: 2, day: 1 })).toBe('2026-02');
  });

  it('a temporada recusa um mês que não existe', () => {
    expect(() => october({ period: '2026-13' })).toThrow(ZodError);
    expect(() => october({ period: 'outubro' })).toThrow(ZodError);
  });

  it('a recusa por servidor desconhecido é ApiError, não erro de banco', () => {
    const h = harness();

    expect(() => h.service.createSeason(october({ servers: ['pvp9'] }), PANEL)).toThrowError(
      ApiError,
    );

    h.db.close();
  });
});

// ============================================================
//  O CONTRATO DO CONSOLE
// ============================================================

describe('o que atravessa o console', () => {
  it('a origem da pendência é traduzida num ponto só', () => {
    // No banco elas se chamam `inventory` e `rollover`; no contrato
    // do plugin, `full` e `season`. `season` ali dentro não podia ser
    // o nosso `season` — ele já é TEMPORADA no módulo inteiro.
    expect(payloadOriginOf('inventory')).toBe('full');
    expect(payloadOriginOf('rollover')).toBe('season');
  });

  it('o progresso manda só a exceção, e o plugin deriva o resto', () => {
    const h = harness();
    const season = h.service.createSeason(october(), PANEL);

    h.service.setSeasonState(season.id, 'active', PANEL);
    h.service.setTrackCell(season.id, 1, 'free', { rewards: [AK], milestone: false }, PANEL);
    h.service.setTrackCell(season.id, 2, 'free', { rewards: [COINS], milestone: false }, PANEL);

    const claim = h.service.claim(
      { serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' },
      PANEL,
    );

    h.service.settle(claim.claim.id, [{ idx: 0, ok: true }]);

    const exceptions = claimExceptionsOf(h.service.trackOf(SERVER, PLAYER).cells);

    // Só o nível 1 viaja: o resto o plugin deduz pela tabela do 01
    // §4.1. Mandar as trinta linhas seria pagar banda para repetir o
    // que a regra já diz.
    expect(exceptions).toEqual([{ level: 1, lane: 'free', state: 'claimed' }]);

    h.db.close();
  });

  it('o push de resgate é recusado sem segredo', () => {
    // Sem isto o jogador digita o marcador no chat e resgata a
    // trilha inteira: o `onConsoleLine` recebe o chat junto com o
    // resto.
    expect(() =>
      battlePassClaimPushSchema.parse({
        kind: 'claim',
        requestId: 'abc',
        steamId: PLAYER,
        level: 1,
        lane: 'free',
      }),
    ).toThrow(ZodError);

    const ok = battlePassClaimPushSchema.parse({
      kind: 'claim',
      secret: 's3cr3t',
      requestId: 'abc',
      steamId: PLAYER,
      level: 1,
      lane: 'free',
    });

    expect(ok.lane).toBe('free');
  });

  it('o handshake é o único sem segredo', () => {
    expect(battlePassReadyPushSchema.parse({ kind: 'ready' }).kind).toBe('ready');
  });

  it('o XP de cada nível do catálogo é o ACUMULADO', () => {
    const flat = { kind: 'flat', perLevel: 1000 } as const;

    // O plugin só informa; quem soma é o agente. Mandar o custo do
    // degrau faria a tela mostrar "1.000" no nível 30.
    expect(xpToReach(flat, 1)).toBe(0);
    expect(xpToReach(flat, 3)).toBe(2000);
  });
});
