// ============================================================
//  battlepass-repository.ts  -  as dez tabelas do passe, atrás de
//  uma classe.
//
//  ####  O PAINEL, O JOGO E O SITE ESCREVEM PELO MESMO LUGAR  ####
//
//  Este repositório é chamado só pelo `BattlePassService`, que é a
//  porta única do módulo (Docs/BattlePass/06 §3). A separação tem
//  função: aqui mora o SQL e a transação; lá moram a regra e a
//  frase da recusa.
//
//  O schema e o porquê de cada coluna estão na migração 101.
//
//  ####  O ZOD RODA AQUI DENTRO TAMBÉM  ####
//
//  Não só na borda HTTP. O `grant` de um passe chega pela compra da
//  loja e pela entrega do site, que não passam por rota nenhuma —
//  e a régua do `period` (a forma `2026-10`) é a diferença entre um
//  direito que vale e um direito que nunca casa com temporada
//  nenhuma.
//
//  ####  O QUE SE LÊ NÃO SE REVALIDA  ####
//
//  `snapshot` e `rewards` voltam do JSON sem passar pelo zod, pelo
//  mesmo motivo escrito em `quests-repository.ts`: o zod é a régua
//  da ENTRADA, e revalidar na leitura faria a tela mostrar menos do
//  que o banco tem sempre que a régua ficasse mais estrita — que é
//  exatamente o que aconteceria com uma recompensa do tipo `skin`
//  gravada por um agente mais novo.
// ============================================================

import {
  BATTLEPASS_ENTITLEMENT_ORIGINS,
  BATTLEPASS_LANES,
  BATTLEPASS_SEASON_STATES,
  DEFAULT_XP_CURVE,
  grantEntitlementSchema,
  levelAt,
  seasonInputSchema,
  trackCellInputSchema,
  xpCurveSchema,
  xpRuleInputSchema,
  type BattlePassAuditEntry,
  type BattlePassAuditInput,
  type BattlePassAuditSource,
  type BattlePassClaim,
  type BattlePassClaimStatus,
  type BattlePassEntitlementOrigin,
  type BattlePassLane,
  type BattlePassPendingOrigin,
  type BattlePassSeason,
  type BattlePassSeasonState,
  type DeliveryOutcome,
  type Entitlement,
  type GrantEntitlementInput,
  type PendingDelivery,
  type PlayerProgress,
  type SeasonInput,
  type SeasonMeta,
  type TrackCell,
  type TrackCellInput,
  type XpCurve,
  type XpRule,
  type XpRuleInput,
} from '../types/battlepass.js';
import type { QuestReward } from '../types/quests.js';
import type { AgentDatabase } from './database.js';

// ------------------------------------------------------------
//  As linhas cruas
// ------------------------------------------------------------

interface SeasonRow {
  readonly id: number;
  readonly period: string;
  readonly label: string;
  readonly levels: number;
  readonly xp_curve: string;
  readonly state: string;
  readonly free_lane: number;
  readonly paid_lane: number;
  readonly retroactive: number;
  readonly description: string | null;
  readonly created_at: number;
  readonly created_by: string | null;
  readonly updated_at: number;
}

interface RewardRow {
  readonly season_id: number;
  readonly level: number;
  readonly lane: string;
  readonly rewards: string;
  readonly milestone: number;
  readonly updated_at: number;
}

interface XpRuleRow {
  readonly season_id: number;
  readonly source: string;
  readonly enabled: number;
  readonly amount: number;
  readonly daily_cap: number | null;
  readonly label: string | null;
  readonly updated_at: number;
}

interface ProgressRow {
  readonly server_id: string;
  readonly steam_id: string;
  readonly season_id: number;
  readonly xp: number;
  readonly level: number;
  readonly updated_at: number;
}

interface EntitlementRow {
  readonly id: number;
  readonly server_id: string;
  readonly steam_id: string;
  readonly period: string;
  readonly origin: string;
  readonly level_at_grant: number;
  readonly source_ref: string | null;
  readonly note: string | null;
  readonly created_at: number;
  readonly created_by: string;
  readonly revoked_at: number | null;
  readonly revoked_by: string | null;
}

interface ClaimRow {
  readonly id: number;
  readonly server_id: string;
  readonly steam_id: string;
  readonly season_id: number;
  readonly level: number;
  readonly lane: string;
  readonly status: string;
  readonly snapshot: string;
  readonly claimed_at: number;
  readonly settled_at: number | null;
}

interface PendingRow {
  readonly id: number;
  readonly claim_id: number;
  readonly idx: number;
  readonly server_id: string;
  readonly steam_id: string;
  readonly origin: string;
  readonly reward: string;
  readonly code: string | null;
  readonly attempts: number;
  readonly seen_at: number | null;
  readonly delivered_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly source: string;
  readonly action: string;
  readonly target: string;
  readonly server_id: string | null;
  readonly steam_id: string | null;
  readonly detail: string;
}

// ------------------------------------------------------------
//  Conversões
// ------------------------------------------------------------

/** Um valor de lista fechada, ou o primeiro dela. Ver o cabeçalho. */
function oneOf<T extends string>(values: readonly T[], raw: string, fallback: T): T {
  return (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * A curva gravada vira objeto.
 *
 * Ilegível cai na curva padrão em vez de derrubar a temporada: uma
 * trilha com a curva errada é visivelmente errada na tela; uma
 * listagem que não abre esconde as outras onze temporadas.
 */
function parseCurve(raw: string): XpCurve {
  try {
    const parsed = xpCurveSchema.safeParse(JSON.parse(raw));

    if (parsed.success) return parsed.data;
  } catch {
    // Ver o comentário acima.
  }

  return DEFAULT_XP_CURVE;
}

/** A lista congelada vira objeto. Sem revalidar — ver o cabeçalho. */
function parseRewards(raw: string): readonly QuestReward[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) return parsed as QuestReward[];
  } catch {
    // Lista ilegível vira lista vazia: o resgate aparece na tela sem
    // recompensa nenhuma, que é visivelmente errado, e não derruba a
    // trilha inteira.
  }

  return [];
}

function toSeason(row: SeasonRow, servers: readonly string[]): BattlePassSeason {
  return {
    id: row.id,
    period: row.period,
    label: row.label,
    levels: row.levels,
    xpCurve: parseCurve(row.xp_curve),
    state: oneOf<BattlePassSeasonState>(BATTLEPASS_SEASON_STATES, row.state, 'draft'),
    freeLane: row.free_lane === 1,
    paidLane: row.paid_lane === 1,
    retroactive: row.retroactive === 1,
    description: row.description === null || row.description === '' ? null : row.description,
    servers: [...servers],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCell(row: RewardRow): TrackCell {
  return {
    seasonId: row.season_id,
    level: row.level,
    lane: oneOf<BattlePassLane>(BATTLEPASS_LANES, row.lane, 'free'),
    rewards: [...parseRewards(row.rewards)],
    milestone: row.milestone === 1,
    updatedAt: row.updated_at,
  };
}

function toXpRule(row: XpRuleRow): XpRule {
  return {
    seasonId: row.season_id,
    source: row.source,
    enabled: row.enabled === 1,
    amount: row.amount,
    dailyCap: row.daily_cap,
    label: row.label,
    updatedAt: row.updated_at,
  };
}

function toProgress(row: ProgressRow): PlayerProgress {
  return {
    serverId: row.server_id,
    steamId: row.steam_id,
    seasonId: row.season_id,
    xp: row.xp,
    level: row.level,
    updatedAt: row.updated_at,
  };
}

function toEntitlement(row: EntitlementRow): Entitlement {
  return {
    id: row.id,
    serverId: row.server_id,
    steamId: row.steam_id,
    period: row.period,
    origin: oneOf<BattlePassEntitlementOrigin>(BATTLEPASS_ENTITLEMENT_ORIGINS, row.origin, 'painel'),
    levelAtGrant: row.level_at_grant,
    sourceRef: row.source_ref,
    note: row.note,
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

function toClaim(row: ClaimRow): BattlePassClaim {
  return {
    id: row.id,
    serverId: row.server_id,
    steamId: row.steam_id,
    seasonId: row.season_id,
    level: row.level,
    lane: oneOf<BattlePassLane>(BATTLEPASS_LANES, row.lane, 'free'),
    status: row.status === 'claimed' ? 'claimed' : 'pending',
    snapshot: parseRewards(row.snapshot),
    claimedAt: row.claimed_at,
    settledAt: row.settled_at,
  };
}

function toPending(row: PendingRow): PendingDelivery {
  return {
    id: row.id,
    claimId: row.claim_id,
    idx: row.idx,
    serverId: row.server_id,
    steamId: row.steam_id,
    origin: row.origin === 'rollover' ? 'rollover' : 'inventory',
    // UMA recompensa, e não a lista: a linha é de uma posição do
    // snapshot. Ilegível vira um objeto sem `kind`, que quem entrega
    // recusa com código próprio — some da caixa seria pior.
    reward: parseOne(row.reward) as QuestReward,
    code: row.code,
    attempts: row.attempts,
    seenAt: row.seen_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOne(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toAudit(row: AuditRow): BattlePassAuditEntry {
  let detail: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(row.detail);

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // Detalhe ilegível não pode esconder a linha do registro: quem
    // mexeu, quando e em quê continuam legíveis nas outras colunas.
  }

  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    source: oneOf<BattlePassAuditSource>(
      ['panel', 'game', 'system', 'site'],
      row.source,
      'system',
    ),
    action: row.action,
    target: row.target,
    serverId: row.server_id,
    steamId: row.steam_id,
    detail,
  };
}

// ------------------------------------------------------------
//  Os pedidos compostos
// ------------------------------------------------------------

/** O que `creditXp` precisa saber. A régua do dia vem de fora. */
export interface CreditXpInput {
  readonly serverId: string;
  readonly steamId: string;
  readonly season: Pick<BattlePassSeason, 'id' | 'levels' | 'xpCurve'>;
  readonly source: string;
  /** O dia local, `2026-10-07`. Ver `dayKeyOf` em types/battlepass.ts. */
  readonly localDay: string;
  readonly amount: number;
  /** O teto daquela fonte, ou `null` para sem teto. */
  readonly dailyCap: number | null;
}

/** O desfecho de um crédito de XP. */
export interface XpCredit {
  /** Quanto XP realmente entrou, depois do teto. */
  readonly granted: number;
  /** Quanto foi cortado pelo teto — e NÃO fica para amanhã. */
  readonly capped: number;
  readonly progress: PlayerProgress;
  /** O nível de antes, para quem quiser avisar "você subiu". */
  readonly levelBefore: number;
}

export interface ProgressPage {
  readonly rows: readonly PlayerProgress[];
  /** O cursor da próxima página, ou `null` no fim. */
  readonly nextCursor: string | null;
}

export interface AuditFilter {
  readonly limit: number;
  readonly steamId?: string;
  readonly serverId?: string;
  /** O `id` da última linha da página anterior. */
  readonly before?: number;
}

/** Quem está devendo o quê, para o `settle`. */
export interface SettleResult {
  readonly claim: BattlePassClaim;
  readonly pending: readonly PendingDelivery[];
}

const SEASON_ORDER = 'period DESC, id DESC';

export class BattlePassRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ======================================================
  //  TEMPORADAS
  // ======================================================

  list(): readonly BattlePassSeason[] {
    const rows = this.#db
      .prepare(`SELECT * FROM battlepass_seasons ORDER BY ${SEASON_ORDER}`)
      .all() as SeasonRow[];

    return this.#withServers(rows);
  }

  get(id: number): BattlePassSeason | null {
    const row = this.#db.prepare('SELECT * FROM battlepass_seasons WHERE id = ?').get(id) as
      | SeasonRow
      | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /**
   * As temporadas daquele servidor, da mais nova para a mais velha.
   *
   * Um JOIN e não duas consultas: a junção é quem responde "vale
   * aqui?", e sem ela a lista do servidor seria o catálogo inteiro.
   */
  listForServer(serverId: string): readonly BattlePassSeason[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM battlepass_seasons s
           JOIN battlepass_season_servers j ON j.season_id = s.id
          WHERE j.server_id = @server_id
          ORDER BY s.period DESC, s.id DESC`,
      )
      .all({ server_id: serverId }) as SeasonRow[];

    return this.#withServers(rows);
  }

  /**
   * A temporada no ar naquele servidor.
   *
   * `null` é uma resposta legítima: o passe simplesmente não
   * aparece. Quem garante que existe no máximo UMA é o serviço —
   * ver a nota da migração 101. Aqui, se houver duas, vence a mais
   * nova, para a tela não alternar entre elas a cada carga.
   */
  activeForServer(serverId: string): BattlePassSeason | null {
    const row = this.#db
      .prepare(
        `SELECT s.* FROM battlepass_seasons s
           JOIN battlepass_season_servers j ON j.season_id = s.id
          WHERE j.server_id = @server_id AND s.state = 'active'
          ORDER BY s.period DESC, s.id DESC
          LIMIT 1`,
      )
      .get({ server_id: serverId }) as SeasonRow | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /**
   * As temporadas `active` que compartilham servidor com esta.
   *
   * É a pergunta que a trava "só uma no ar por servidor" faz antes
   * de deixar publicar. Fora dela não tem uso.
   */
  activeRivals(seasonId: number, servers: readonly string[]): readonly BattlePassSeason[] {
    if (servers.length === 0) return [];

    const marks = servers.map((_, index) => `@s${String(index)}`).join(', ');
    const params: Record<string, unknown> = { season: seasonId };

    servers.forEach((server, index) => {
      params[`s${String(index)}`] = server;
    });

    const rows = this.#db
      .prepare(
        `SELECT DISTINCT s.* FROM battlepass_seasons s
           JOIN battlepass_season_servers j ON j.season_id = s.id
          WHERE s.state = 'active' AND s.id <> @season AND j.server_id IN (${marks})
          ORDER BY s.period DESC, s.id DESC`,
      )
      .all(params) as SeasonRow[];

    return this.#withServers(rows);
  }

  serversOf(seasonId: number): readonly string[] {
    return (
      this.#db
        .prepare(
          `SELECT server_id FROM battlepass_season_servers
            WHERE season_id = ? ORDER BY server_id`,
        )
        .all(seasonId) as { server_id: string }[]
    ).map((row) => row.server_id);
  }

  /**
   * Cria a temporada e a liga aos servidores, numa transação.
   *
   * @throws ZodError quando o formulário não passa na régua.
   */
  add(input: SeasonInput, meta: SeasonMeta, now: number = Date.now()): BattlePassSeason {
    const value = seasonInputSchema.parse(input);

    let id = 0;

    this.#db.transaction((): void => {
      const result = this.#db
        .prepare(
          `INSERT INTO battlepass_seasons
             (period, label, levels, xp_curve, state, free_lane, paid_lane, retroactive,
              description, created_at, created_by, updated_at)
           VALUES
             (@period, @label, @levels, @xp_curve, 'draft', @free_lane, @paid_lane, @retroactive,
              @description, @now, @created_by, @now)`,
        )
        .run({ ...seasonColumns(value), created_by: meta.createdBy, now });

      id = Number(result.lastInsertRowid);

      this.#replaceServers(id, value.servers);
    })();

    return this.#mustGet(id);
  }

  /**
   * Reescreve a temporada inteira — menos o estado.
   *
   * PUT e não PATCH, como o resto do projeto: a tela edita num
   * formulário só e manda tudo. O ESTADO fica de fora de propósito:
   * publicar é outra ação, com outra regra e outra recusa.
   *
   * @returns `null` quando o id não existe.
   */
  update(id: number, input: SeasonInput, now: number = Date.now()): BattlePassSeason | null {
    const value = seasonInputSchema.parse(input);

    if (this.get(id) === null) return null;

    this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE battlepass_seasons SET
             period      = @period,
             label       = @label,
             levels      = @levels,
             xp_curve    = @xp_curve,
             free_lane   = @free_lane,
             paid_lane   = @paid_lane,
             retroactive = @retroactive,
             description = @description,
             updated_at  = @now
           WHERE id = @id`,
        )
        .run({ id, ...seasonColumns(value), now });

      this.#replaceServers(id, value.servers);
    })();

    return this.get(id);
  }

  setServers(id: number, servers: readonly string[], now: number = Date.now()): readonly string[] | null {
    if (this.get(id) === null) return null;

    this.#db.transaction((): void => {
      this.#replaceServers(id, servers);
      this.#db.prepare('UPDATE battlepass_seasons SET updated_at = ? WHERE id = ?').run(now, id);
    })();

    return this.serversOf(id);
  }

  setState(
    id: number,
    state: BattlePassSeasonState,
    now: number = Date.now(),
  ): BattlePassSeason | null {
    const changed = this.#db
      .prepare('UPDATE battlepass_seasons SET state = @state, updated_at = @now WHERE id = @id')
      .run({ id, state, now }).changes;

    return changed === 0 ? null : this.get(id);
  }

  /**
   * Apaga a temporada.
   *
   * A cascata leva a trilha, as regras de XP, o progresso, os
   * direitos, os resgates e a caixa. O que sobrevive é o registro,
   * que não tem chave estrangeira — é ele que responde "quem apagou
   * a temporada de setembro?".
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM battlepass_seasons WHERE id = ?').run(id).changes > 0;
  }

  // ======================================================
  //  A TRILHA
  // ======================================================

  track(seasonId: number): readonly TrackCell[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM battlepass_rewards WHERE season_id = ?
            ORDER BY level ASC, lane ASC`,
        )
        .all(seasonId) as RewardRow[]
    ).map(toCell);
  }

  cell(seasonId: number, level: number, lane: BattlePassLane): TrackCell | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM battlepass_rewards
          WHERE season_id = @season AND level = @level AND lane = @lane`,
      )
      .get({ season: seasonId, level, lane }) as RewardRow | undefined;

    return row === undefined ? null : toCell(row);
  }

  /**
   * Grava o que aquela faixa daquele nível dá.
   *
   * @throws ZodError quando a recompensa não passa na régua.
   */
  setCell(
    seasonId: number,
    level: number,
    lane: BattlePassLane,
    input: TrackCellInput,
    now: number = Date.now(),
  ): TrackCell {
    const value = trackCellInputSchema.parse(input);

    this.#db
      .prepare(
        `INSERT INTO battlepass_rewards (season_id, level, lane, rewards, milestone, updated_at)
         VALUES (@season, @level, @lane, @rewards, @milestone, @now)
         ON CONFLICT(season_id, level, lane) DO UPDATE SET
           rewards    = excluded.rewards,
           milestone  = excluded.milestone,
           updated_at = excluded.updated_at`,
      )
      .run({
        season: seasonId,
        level,
        lane,
        rewards: JSON.stringify(value.rewards),
        milestone: value.milestone ? 1 : 0,
        now,
      });

    return this.#mustGetCell(seasonId, level, lane);
  }

  /** Esvazia a casa. Nível vazio é legítimo: a tela mostra um traço. */
  clearCell(seasonId: number, level: number, lane: BattlePassLane): boolean {
    return (
      this.#db
        .prepare(
          `DELETE FROM battlepass_rewards
            WHERE season_id = @season AND level = @level AND lane = @lane`,
        )
        .run({ season: seasonId, level, lane }).changes > 0
    );
  }

  // ======================================================
  //  AS REGRAS DE XP
  // ======================================================

  xpRules(seasonId: number): readonly XpRule[] {
    return (
      this.#db
        .prepare('SELECT * FROM battlepass_xp_rules WHERE season_id = ? ORDER BY source ASC')
        .all(seasonId) as XpRuleRow[]
    ).map(toXpRule);
  }

  xpRule(seasonId: number, source: string): XpRule | null {
    const row = this.#db
      .prepare('SELECT * FROM battlepass_xp_rules WHERE season_id = ? AND source = ?')
      .get(seasonId, source) as XpRuleRow | undefined;

    return row === undefined ? null : toXpRule(row);
  }

  /** @throws ZodError quando a fonte ou o valor não passam na régua. */
  setXpRule(seasonId: number, input: XpRuleInput, now: number = Date.now()): XpRule {
    const value = xpRuleInputSchema.parse(input);

    this.#db
      .prepare(
        `INSERT INTO battlepass_xp_rules
           (season_id, source, enabled, amount, daily_cap, label, updated_at)
         VALUES (@season, @source, @enabled, @amount, @daily_cap, @label, @now)
         ON CONFLICT(season_id, source) DO UPDATE SET
           enabled    = excluded.enabled,
           amount     = excluded.amount,
           daily_cap  = excluded.daily_cap,
           label      = excluded.label,
           updated_at = excluded.updated_at`,
      )
      .run({
        season: seasonId,
        source: value.source,
        enabled: value.enabled ? 1 : 0,
        amount: value.amount,
        daily_cap: value.dailyCap ?? null,
        label: value.label,
        now,
      });

    const saved = this.xpRule(seasonId, value.source);

    if (saved === null) {
      throw new Error(`a regra de XP "${value.source}" sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  removeXpRule(seasonId: number, source: string): boolean {
    return (
      this.#db
        .prepare('DELETE FROM battlepass_xp_rules WHERE season_id = ? AND source = ?')
        .run(seasonId, source).changes > 0
    );
  }

  // ======================================================
  //  O PROGRESSO
  // ======================================================

  progressOf(serverId: string, steamId: string, seasonId: number): PlayerProgress | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM battlepass_progress
          WHERE server_id = @server AND steam_id = @steam AND season_id = @season`,
      )
      .get({ server: serverId, steam: steamId, season: seasonId }) as ProgressRow | undefined;

    return row === undefined ? null : toProgress(row);
  }

  /**
   * A página da aba Jogadores: quem tem mais XP naquele servidor.
   *
   * O cursor é `"<xp>:<steamId>"` — o par que a ordenação usa. Um
   * cursor por deslocamento mudaria de significado a cada XP
   * creditado, que aqui acontece a cada 60 segundos.
   */
  leaderboard(input: {
    readonly seasonId: number;
    readonly serverId: string;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): ProgressPage {
    const parsed = parseCursor(input.cursor);
    const params: Record<string, unknown> = {
      season: input.seasonId,
      server: input.serverId,
      limit: input.limit + 1,
    };

    let keyset = '';

    if (parsed !== null) {
      keyset = ' AND (xp < @cursor_xp OR (xp = @cursor_xp AND steam_id > @cursor_steam))';
      params['cursor_xp'] = parsed.xp;
      params['cursor_steam'] = parsed.steamId;
    }

    const rows = this.#db
      .prepare(
        `SELECT * FROM battlepass_progress
          WHERE season_id = @season AND server_id = @server${keyset}
          ORDER BY xp DESC, steam_id ASC
          LIMIT @limit`,
      )
      .all(params) as ProgressRow[];

    const page = rows.slice(0, input.limit).map(toProgress);
    const last = page[page.length - 1];

    return {
      rows: page,
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? `${String(last.xp)}:${last.steamId}`
          : null,
    };
  }

  /**
   * Soma XP respeitando o teto da fonte, numa transação.
   *
   * ####  O TETO É APLICADO AQUI, E NÃO POR QUEM CHAMA  ####
   *
   * Ler o acumulado do dia, decidir e somar em três chamadas
   * separadas abriria a janela em que duas rodadas do coletor leem
   * o mesmo "faltam 40" e creditam 80. Uma transação só é o que faz
   * o teto ser teto.
   *
   * O excedente NÃO fica para amanhã (01 §3.2): ele não acontece. O
   * `capped` existe para quem quiser dizer isso na tela, não para
   * guardar em lugar nenhum.
   */
  creditXp(input: CreditXpInput, now: number = Date.now()): XpCredit {
    return this.#db.transaction((): XpCredit => {
      const current = this.progressOf(input.serverId, input.steamId, input.season.id);
      const before = current ?? {
        serverId: input.serverId,
        steamId: input.steamId,
        seasonId: input.season.id,
        xp: 0,
        level: 1,
        updatedAt: now,
      };

      const wanted = Math.max(0, Math.trunc(input.amount));
      const granted = wanted === 0 ? 0 : this.#allowedBy(input, wanted);

      if (granted === 0) {
        return { granted: 0, capped: wanted, progress: before, levelBefore: before.level };
      }

      this.#bumpDaily(input, granted, now);

      const xp = before.xp + granted;
      const level = levelAt(input.season.xpCurve, input.season.levels, xp);

      this.#db
        .prepare(
          `INSERT INTO battlepass_progress
             (server_id, steam_id, season_id, xp, level, updated_at)
           VALUES (@server, @steam, @season, @xp, @level, @now)
           ON CONFLICT(server_id, steam_id, season_id) DO UPDATE SET
             xp         = excluded.xp,
             level      = excluded.level,
             updated_at = excluded.updated_at`,
        )
        .run({
          server: input.serverId,
          steam: input.steamId,
          season: input.season.id,
          xp,
          level,
          now,
        });

      const saved = this.progressOf(input.serverId, input.steamId, input.season.id);

      if (saved === null) {
        throw new Error('o progresso sumiu logo depois de ser gravado');
      }

      return { granted, capped: wanted - granted, progress: saved, levelBefore: before.level };
    })();
  }

  /** Quanto aquela fonte já rendeu hoje. O teto do §3 se apoia nisto. */
  dailyXp(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly seasonId: number;
    readonly source: string;
    readonly localDay: string;
  }): number {
    const row = this.#db
      .prepare(
        `SELECT xp FROM battlepass_xp_daily
          WHERE server_id = @server AND steam_id = @steam AND season_id = @season
            AND source = @source AND local_day = @day`,
      )
      .get({
        server: input.serverId,
        steam: input.steamId,
        season: input.seasonId,
        source: input.source,
        day: input.localDay,
      }) as { readonly xp: number } | undefined;

    return row?.xp ?? 0;
  }

  /**
   * Apaga o acumulado de dias anteriores a `localDay`.
   *
   * A tabela é a de escrita mais frequente do módulo e não serve a
   * pergunta nenhuma depois que o dia vira: o teto de hoje só olha
   * hoje. Quem chama é a faxina do agente.
   */
  pruneDailyXp(localDay: string): number {
    return this.#db
      .prepare('DELETE FROM battlepass_xp_daily WHERE local_day < ?')
      .run(localDay).changes;
  }

  // ======================================================
  //  O DIREITO COMPRADO
  // ======================================================

  /** O direito VIVO daquele mês, naquele servidor. `null` = não tem. */
  activeEntitlement(serverId: string, steamId: string, period: string): Entitlement | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM battlepass_entitlements
          WHERE server_id = @server AND steam_id = @steam AND period = @period
            AND revoked_at IS NULL`,
      )
      .get({ server: serverId, steam: steamId, period }) as EntitlementRow | undefined;

    return row === undefined ? null : toEntitlement(row);
  }

  getEntitlement(id: number): Entitlement | null {
    const row = this.#db.prepare('SELECT * FROM battlepass_entitlements WHERE id = ?').get(id) as
      | EntitlementRow
      | undefined;

    return row === undefined ? null : toEntitlement(row);
  }

  /** O histórico do jogador, vivos e revogados, do mais novo ao mais velho. */
  entitlementsOf(steamId: string): readonly Entitlement[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM battlepass_entitlements WHERE steam_id = ?
            ORDER BY period DESC, id DESC`,
        )
        .all(steamId) as EntitlementRow[]
    ).map(toEntitlement);
  }

  /** Quantos compraram aquele mês naquele servidor. A aba Visão geral. */
  countEntitlements(serverId: string, period: string): number {
    const row = this.#db
      .prepare(
        `SELECT count(*) AS n FROM battlepass_entitlements
          WHERE server_id = @server AND period = @period AND revoked_at IS NULL`,
      )
      .get({ server: serverId, period }) as { readonly n: number };

    return row.n;
  }

  /**
   * Dá o passe de um mês — idempotente por (servidor, jogador, mês).
   *
   * ####  IDEMPOTENTE, E NÃO "SOMA PRAZO"  ####
   *
   * É a diferença em relação ao VIP, que renova estendendo a linha
   * viva. O passe do mês não tem o que somar: outubro já é do
   * jogador, e um segundo outubro não existe. Então a segunda
   * chamada devolve a MESMA linha com `created: false`, e é isso
   * que faz um retry da entrega do site não virar dois direitos.
   *
   * A recusa amigável ("você já tem o passe deste mês") é da
   * COMPRA, antes do débito — ver o serviço. Aqui a resposta é um
   * fato, não uma recusa.
   *
   * @throws ZodError quando a entrada não passa na régua.
   */
  grantEntitlement(
    input: GrantEntitlementInput,
    now: number = Date.now(),
  ): { readonly entitlement: Entitlement; readonly created: boolean } {
    const value = grantEntitlementSchema.parse(input);

    return this.#db.transaction((): { entitlement: Entitlement; created: boolean } => {
      const live = this.activeEntitlement(value.serverId, value.steamId, value.period);

      if (live !== null) return { entitlement: live, created: false };

      const result = this.#db
        .prepare(
          `INSERT INTO battlepass_entitlements
             (server_id, steam_id, period, origin, level_at_grant, source_ref, note,
              created_at, created_by)
           VALUES (@server, @steam, @period, @origin, @level_at_grant, @source_ref, @note,
                   @now, @created_by)`,
        )
        .run({
          server: value.serverId,
          steam: value.steamId,
          period: value.period,
          origin: value.origin,
          level_at_grant: value.levelAtGrant,
          source_ref: value.sourceRef ?? null,
          note: value.note,
          now,
          created_by: value.createdBy,
        });

      const saved = this.getEntitlement(Number(result.lastInsertRowid));

      if (saved === null) {
        throw new Error('o direito sumiu logo depois de ser gravado');
      }

      return { entitlement: saved, created: true };
    })();
  }

  /**
   * Revoga. NÃO apaga a linha: a segunda discussão sobre o mesmo
   * jogador precisa da primeira.
   *
   * @returns `null` quando o id não existe ou já estava revogado.
   */
  revokeEntitlement(id: number, by: string, now: number = Date.now()): Entitlement | null {
    const changed = this.#db
      .prepare(
        `UPDATE battlepass_entitlements SET revoked_at = @now, revoked_by = @by
          WHERE id = @id AND revoked_at IS NULL`,
      )
      .run({ id, by, now }).changes;

    return changed === 0 ? null : this.getEntitlement(id);
  }

  // ======================================================
  //  O RESGATE
  // ======================================================

  claimsOf(serverId: string, steamId: string, seasonId: number): readonly BattlePassClaim[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM battlepass_claims
            WHERE server_id = @server AND steam_id = @steam AND season_id = @season
            ORDER BY level ASC, lane ASC`,
        )
        .all({ server: serverId, steam: steamId, season: seasonId }) as ClaimRow[]
    ).map(toClaim);
  }

  getClaim(id: number): BattlePassClaim | null {
    const row = this.#db.prepare('SELECT * FROM battlepass_claims WHERE id = ?').get(id) as
      | ClaimRow
      | undefined;

    return row === undefined ? null : toClaim(row);
  }

  /**
   * Grava o resgate com a recompensa CONGELADA.
   *
   * O snapshot é gravado como veio do catálogo NAQUELE instante:
   * editar a trilha no dia 20 não muda o que o nível 3 prometia.
   *
   * @throws quando já existe resgate daquela casa (o UNIQUE). Quem
   *         traduz isso numa frase é o serviço — "clicar duas vezes
   *         não entrega duas vezes".
   */
  insertClaim(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly seasonId: number;
    readonly level: number;
    readonly lane: BattlePassLane;
    readonly snapshot: readonly QuestReward[];
    readonly status?: BattlePassClaimStatus;
  }, now: number = Date.now()): BattlePassClaim {
    const status: BattlePassClaimStatus = input.status ?? 'pending';
    const result = this.#db
      .prepare(
        `INSERT INTO battlepass_claims
           (server_id, steam_id, season_id, level, lane, status, snapshot, claimed_at, settled_at)
         VALUES (@server, @steam, @season, @level, @lane, @status, @snapshot, @now, @settled)`,
      )
      .run({
        server: input.serverId,
        steam: input.steamId,
        season: input.seasonId,
        level: input.level,
        lane: input.lane,
        status,
        snapshot: JSON.stringify(input.snapshot),
        now,
        // Uma faixa sem recompensa nenhuma nasce fechada: não há o
        // que entregar, e deixá-la `pending` faria a tela cobrar
        // para sempre uma entrega que nunca vai acontecer.
        settled: status === 'claimed' || input.snapshot.length === 0 ? now : null,
      });

    const saved = this.getClaim(Number(result.lastInsertRowid));

    if (saved === null) {
      throw new Error('o resgate sumiu logo depois de ser gravado');
    }

    return saved;
  }

  /**
   * Fecha o que entregou e põe na caixa o que ficou devendo.
   *
   * O lote NÃO é atômico (01 §6): cabendo 6 de 17, entregam-se as 6
   * e as 11 continuam esperando. Por isso o desfecho chega POSIÇÃO
   * A POSIÇÃO, e a pendência é gravada com o índice — renumerar
   * quebraria o dedupe de pagamento no caminho do retry.
   *
   * Chamar de novo com o mesmo resultado é seguro: a pendência tem
   * `UNIQUE (claim_id, idx)` e a linha é atualizada, não duplicada.
   */
  settleClaim(
    claimId: number,
    outcomes: readonly DeliveryOutcome[],
    origin: BattlePassPendingOrigin = 'inventory',
    now: number = Date.now(),
  ): SettleResult | null {
    return this.#db.transaction((): SettleResult | null => {
      const claim = this.getClaim(claimId);

      if (claim === null) return null;

      for (const outcome of outcomes) {
        const reward = claim.snapshot[outcome.idx];

        // Posição que não existe no snapshot não vira linha: ela
        // seria uma promessa sem recompensa, e a caixa a mostraria
        // para sempre.
        if (reward === undefined) continue;

        if (outcome.ok) {
          this.#db
            .prepare(
              `UPDATE battlepass_pending SET delivered_at = @now, code = NULL, updated_at = @now
                WHERE claim_id = @claim AND idx = @idx AND delivered_at IS NULL`,
            )
            .run({ claim: claimId, idx: outcome.idx, now });
          continue;
        }

        this.#db
          .prepare(
            `INSERT INTO battlepass_pending
               (claim_id, idx, server_id, steam_id, origin, reward, code, attempts,
                seen_at, delivered_at, created_at, updated_at)
             VALUES (@claim, @idx, @server, @steam, @origin, @reward, @code, 1,
                     NULL, NULL, @now, @now)
             ON CONFLICT(claim_id, idx) DO UPDATE SET
               code       = excluded.code,
               attempts   = battlepass_pending.attempts + 1,
               updated_at = excluded.updated_at`,
          )
          .run({
            claim: claimId,
            idx: outcome.idx,
            server: claim.serverId,
            steam: claim.steamId,
            origin,
            reward: JSON.stringify(reward),
            code: outcome.code ?? null,
            now,
          });
      }

      const open = this.#db
        .prepare(
          'SELECT count(*) AS n FROM battlepass_pending WHERE claim_id = ? AND delivered_at IS NULL',
        )
        .get(claimId) as { readonly n: number };

      // A marca de `claimed` vem DEPOIS da entrega, nunca antes.
      this.#db
        .prepare(
          `UPDATE battlepass_claims
              SET status = @status, settled_at = @settled
            WHERE id = @id`,
        )
        .run({
          id: claimId,
          status: open.n === 0 ? 'claimed' : 'pending',
          settled: open.n === 0 ? now : null,
        });

      const saved = this.getClaim(claimId);

      if (saved === null) {
        throw new Error('o resgate sumiu no meio da entrega');
      }

      return { claim: saved, pending: this.pendingOfClaim(claimId) };
    })();
  }

  // ======================================================
  //  A CAIXA
  // ======================================================

  /** O que está esperando aquele jogador naquele servidor. */
  pendingOf(serverId: string, steamId: string): readonly PendingDelivery[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM battlepass_pending
            WHERE server_id = @server AND steam_id = @steam AND delivered_at IS NULL
            ORDER BY id ASC`,
        )
        .all({ server: serverId, steam: steamId }) as PendingRow[]
    ).map(toPending);
  }

  pendingOfClaim(claimId: number): readonly PendingDelivery[] {
    return (
      this.#db
        .prepare('SELECT * FROM battlepass_pending WHERE claim_id = ? ORDER BY idx ASC')
        .all(claimId) as PendingRow[]
    ).map(toPending);
  }

  /**
   * O jogador ABRIU a caixa.
   *
   * O ponto de notificação some aqui, e não quando ele recebe os
   * itens: ter pendência e saber que tem são coisas diferentes.
   *
   * @returns quantas linhas deixaram de ser novidade.
   */
  markSeen(serverId: string, steamId: string, now: number = Date.now()): number {
    return this.#db
      .prepare(
        `UPDATE battlepass_pending SET seen_at = @now, updated_at = @now
          WHERE server_id = @server AND steam_id = @steam
            AND delivered_at IS NULL AND seen_at IS NULL`,
      )
      .run({ server: serverId, steam: steamId, now }).changes;
  }

  /** Há pendência que ele ainda não olhou? É o ponto no ícone. */
  hasUnseen(serverId: string, steamId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 AS ok FROM battlepass_pending
          WHERE server_id = @server AND steam_id = @steam
            AND delivered_at IS NULL AND seen_at IS NULL
          LIMIT 1`,
      )
      .get({ server: serverId, steam: steamId });

    return row !== undefined;
  }

  // ======================================================
  //  O REGISTRO
  // ======================================================

  log(entry: BattlePassAuditInput, at: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO battlepass_audit
           (at, actor, source, action, target, server_id, steam_id, detail)
         VALUES (@at, @actor, @source, @action, @target, @server_id, @steam_id, @detail)`,
      )
      .run({
        at,
        actor: entry.actor,
        source: entry.source,
        action: entry.action,
        target: entry.target,
        server_id: entry.serverId ?? null,
        steam_id: entry.steamId ?? null,
        detail: JSON.stringify(entry.detail ?? {}),
      });
  }

  audit(filter: AuditFilter): readonly BattlePassAuditEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit };

    if (filter.steamId !== undefined) {
      where.push('steam_id = @steam_id');
      params['steam_id'] = filter.steamId.trim();
    }

    if (filter.serverId !== undefined) {
      where.push('server_id = @server_id');
      params['server_id'] = filter.serverId;
    }

    if (filter.before !== undefined) {
      where.push('id < @before');
      params['before'] = filter.before;
    }

    const sql =
      'SELECT * FROM battlepass_audit' +
      (where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`) +
      ' ORDER BY id DESC LIMIT @limit';

    return (this.#db.prepare(sql).all(params) as AuditRow[]).map(toAudit);
  }

  // ======================================================
  //  Privados
  // ======================================================

  /** Quanto daquele crédito o teto deixa passar. */
  #allowedBy(input: CreditXpInput, wanted: number): number {
    if (input.dailyCap === null) return wanted;

    const used = this.dailyXp({
      serverId: input.serverId,
      steamId: input.steamId,
      seasonId: input.season.id,
      source: input.source,
      localDay: input.localDay,
    });

    return Math.max(0, Math.min(wanted, input.dailyCap - used));
  }

  #bumpDaily(input: CreditXpInput, amount: number, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO battlepass_xp_daily
           (server_id, steam_id, season_id, source, local_day, xp, updated_at)
         VALUES (@server, @steam, @season, @source, @day, @xp, @now)
         ON CONFLICT(server_id, steam_id, season_id, source, local_day) DO UPDATE SET
           xp         = battlepass_xp_daily.xp + excluded.xp,
           updated_at = excluded.updated_at`,
      )
      .run({
        server: input.serverId,
        steam: input.steamId,
        season: input.season.id,
        source: input.source,
        day: input.localDay,
        xp: amount,
        now,
      });
  }

  #mustGet(id: number): BattlePassSeason {
    const saved = this.get(id);

    // Ela acabou de ser gravada numa transação que não lançou: só
    // chegaria aqui um banco corrompido, e é melhor dizer isso alto.
    if (saved === null) {
      throw new Error(`a temporada ${String(id)} sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  #mustGetCell(seasonId: number, level: number, lane: BattlePassLane): TrackCell {
    const saved = this.cell(seasonId, level, lane);

    if (saved === null) {
      throw new Error(`o nível ${String(level)} (${lane}) sumiu logo depois de ser gravado`);
    }

    return saved;
  }

  /**
   * As temporadas com os servidores de cada uma.
   *
   * Duas consultas, e não uma por linha: perguntar "onde esta vale?"
   * por temporada seria o N+1 clássico da tela que lista tudo.
   */
  #withServers(rows: readonly SeasonRow[]): readonly BattlePassSeason[] {
    if (rows.length === 0) return [];

    const bySeason = new Map<number, string[]>();

    for (const link of this.#db
      .prepare(
        `SELECT season_id, server_id FROM battlepass_season_servers
          ORDER BY season_id, server_id`,
      )
      .all() as { season_id: number; server_id: string }[]) {
      const list = bySeason.get(link.season_id);

      if (list === undefined) {
        bySeason.set(link.season_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    return rows.map((row) => toSeason(row, bySeason.get(row.id) ?? []));
  }

  #replaceServers(id: number, servers: readonly string[]): void {
    this.#db.prepare('DELETE FROM battlepass_season_servers WHERE season_id = @id').run({ id });

    const insert = this.#db.prepare(
      `INSERT OR IGNORE INTO battlepass_season_servers (season_id, server_id)
       VALUES (@id, @server_id)`,
    );

    for (const serverId of new Set(servers)) {
      insert.run({ id, server_id: serverId });
    }
  }
}

function seasonColumns(input: SeasonInput): Record<string, unknown> {
  return {
    period: input.period,
    label: input.label,
    levels: input.levels,
    xp_curve: JSON.stringify(input.xpCurve),
    free_lane: input.freeLane ? 1 : 0,
    paid_lane: input.paidLane ? 1 : 0,
    retroactive: input.retroactive ? 1 : 0,
    description: input.description,
  };
}

/** `"3200:7656…"` vira o par da ordenação. Lixo vira `null`. */
function parseCursor(raw: string | undefined): { readonly xp: number; readonly steamId: string } | null {
  if (raw === undefined || raw === '') return null;

  const at = raw.indexOf(':');

  if (at <= 0) return null;

  const xp = Number(raw.slice(0, at));
  const steamId = raw.slice(at + 1);

  return Number.isFinite(xp) && steamId !== '' ? { xp, steamId } : null;
}
