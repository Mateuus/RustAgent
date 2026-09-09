// ============================================================
//  world-events-repository.ts  -  o guarda-chuva, gravado.
//
//  Quatro tabelas e três assuntos:
//
//    world_events + world_event_servers   a definição, e onde vale
//    world_event_zones                    onde nada nasce
//    world_event_runs + …_players         o que aconteceu
//
//  ####  A RUN É APPEND, E A DEFINIÇÃO É REPLACE  ####
//
//  Editar um evento reescreve a linha dele; um nascimento nunca é
//  reescrito depois de terminado. É a diferença entre o catálogo e
//  a nota fiscal — e é por isso que `world_event_runs` não tem FK
//  para `world_events`: apagar o evento não pode apagar a história
//  dele.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §6.1 e §6.4.
// ============================================================

import type { Logger } from '../logger.js';
import {
  EVENT_ACCESS,
  FAILURE_REASONS,
  RUN_STATUS,
  SPAWN_MODES,
  type EventAccess,
  type EventRun,
  type EventRunPlayer,
  type EventZone,
  type EventZoneInput,
  type FailureReason,
  type RunStatus,
  type SpawnMode,
  type WorldEvent,
  type WorldEventInput,
} from '../types/world-events.js';
import type { AgentDatabase } from './database.js';

interface EventRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly sort: number;
  readonly spawn_mode: string;
  readonly interval_min: number;
  readonly interval_max: number;
  readonly duration_min: number;
  readonly duration_max: number;
  readonly min_online: number;
  readonly count_after_end: number;
  readonly access: string;
  readonly owner_grace_seconds: number;
  readonly marker_enabled: number;
  readonly marker_label: string;
  readonly marker_color: string;
  readonly marker_alpha: number;
  readonly marker_radius: number;
  readonly marker_show_owner: number;
  readonly marker_show_time: number;
  readonly msg_start: string | null;
  readonly msg_location: string | null;
  readonly msg_warning: string | null;
  readonly msg_end: string | null;
  readonly msg_denied: string | null;
  readonly warn_before: number;
  readonly radiation_before: number;
  readonly destroy_after: number;
  readonly respawn_seconds: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RunRow {
  readonly id: number;
  readonly event_id: string;
  readonly server_id: string;
  readonly dungeon_id: string | null;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly pos_x: number | null;
  readonly pos_z: number | null;
  readonly grid: string | null;
  readonly seed: number | null;
  readonly owner_steam_id: string | null;
  readonly entered_count: number;
  readonly scheduled_for: number | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

/** O que o agente sabe quando uma masmorra acaba de nascer. */
export interface RunStartInput {
  readonly eventId: string;
  readonly serverId: string;
  readonly dungeonId: string | null;
  readonly x: number | null;
  readonly z: number | null;
  readonly grid: string | null;
  readonly seed: number | null;
  readonly startedAt?: number;
}

export class WorldEventsRepository {
  readonly #db: AgentDatabase;
  readonly #logger: Logger | undefined;

  constructor(db: AgentDatabase, logger?: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  // ------------------------------------------------------
  //  A definição
  // ------------------------------------------------------

  list(): readonly WorldEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM world_events ORDER BY sort, name COLLATE NOCASE')
      .all() as EventRow[];

    const servers = this.#allServers();

    return rows.map((row) => this.#toEvent(row, servers.get(row.id) ?? []));
  }

  get(id: string): WorldEvent | null {
    const row = this.#db.prepare('SELECT * FROM world_events WHERE id = ?').get(id) as
      | EventRow
      | undefined;

    if (row === undefined) return null;

    return this.#toEvent(row, this.#serversOf(id));
  }

  exists(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM world_events WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Grava o evento e a lista de servidores dele, de uma vez.
   *
   * A lista é REPLACE, como as salas da masmorra: o painel manda o
   * conjunto completo, e o servidor que sumiu do payload deixa de
   * rodar o evento. Um merge parcial precisaria decidir isso, e a
   * resposta certa é o que o replace já faz.
   */
  save(input: WorldEventInput, now: number = Date.now()): WorldEvent {
    this.#db.exec('BEGIN');

    try {
      this.#db
        .prepare(
          `INSERT INTO world_events
                (id, kind, name, description, enabled, sort, spawn_mode,
                 interval_min, interval_max, duration_min, duration_max,
                 min_online, count_after_end, access, owner_grace_seconds,
                 marker_enabled, marker_label, marker_color, marker_alpha,
                 marker_radius, marker_show_owner, marker_show_time,
                 msg_start, msg_location, msg_warning, msg_end, msg_denied,
                 warn_before, radiation_before, destroy_after, respawn_seconds,
                 created_at, updated_at)
                VALUES (@id, @kind, @name, @description, @enabled, @sort, @spawnMode,
                        @intervalMin, @intervalMax, @durationMin, @durationMax,
                        @minOnline, @countAfterEnd, @access, @ownerGrace,
                        @markerEnabled, @markerLabel, @markerColor, @markerAlpha,
                        @markerRadius, @markerShowOwner, @markerShowTime,
                        @msgStart, @msgLocation, @msgWarning, @msgEnd, @msgDenied,
                        @warnBefore, @radiationBefore, @destroyAfter, @respawnSeconds,
                        @now, @now)
           ON CONFLICT (id) DO UPDATE SET
                kind = excluded.kind, name = excluded.name,
                description = excluded.description, enabled = excluded.enabled,
                sort = excluded.sort, spawn_mode = excluded.spawn_mode,
                interval_min = excluded.interval_min, interval_max = excluded.interval_max,
                duration_min = excluded.duration_min, duration_max = excluded.duration_max,
                min_online = excluded.min_online, count_after_end = excluded.count_after_end,
                access = excluded.access, owner_grace_seconds = excluded.owner_grace_seconds,
                marker_enabled = excluded.marker_enabled, marker_label = excluded.marker_label,
                marker_color = excluded.marker_color, marker_alpha = excluded.marker_alpha,
                marker_radius = excluded.marker_radius,
                marker_show_owner = excluded.marker_show_owner,
                marker_show_time = excluded.marker_show_time,
                msg_start = excluded.msg_start, msg_location = excluded.msg_location,
                msg_warning = excluded.msg_warning, msg_end = excluded.msg_end,
                msg_denied = excluded.msg_denied,
                warn_before = excluded.warn_before,
                radiation_before = excluded.radiation_before,
                destroy_after = excluded.destroy_after,
                respawn_seconds = excluded.respawn_seconds,
                updated_at = excluded.updated_at`,
        )
        .run({
          id: input.id,
          kind: input.kind,
          name: input.name,
          description: input.description ?? null,
          enabled: input.enabled ? 1 : 0,
          sort: input.sort,
          spawnMode: input.spawnMode,
          intervalMin: input.interval.min,
          intervalMax: input.interval.max,
          durationMin: input.duration.min,
          durationMax: input.duration.max,
          minOnline: input.minOnline,
          countAfterEnd: input.countAfterEnd ? 1 : 0,
          access: input.access,
          ownerGrace: input.ownerGraceSeconds,
          markerEnabled: input.marker.enabled ? 1 : 0,
          markerLabel: input.marker.label,
          markerColor: input.marker.color,
          markerAlpha: input.marker.alpha,
          markerRadius: input.marker.radius,
          markerShowOwner: input.marker.showOwner ? 1 : 0,
          markerShowTime: input.marker.showTime ? 1 : 0,
          msgStart: emptyToNull(input.messages.start),
          msgLocation: emptyToNull(input.messages.location),
          msgWarning: emptyToNull(input.messages.warning),
          msgEnd: emptyToNull(input.messages.end),
          msgDenied: emptyToNull(input.messages.denied),
          warnBefore: input.warnBefore,
          radiationBefore: input.radiationBefore,
          destroyAfter: input.destroyAfter,
          respawnSeconds: input.respawnSeconds,
          now,
        });

      this.#db.prepare('DELETE FROM world_event_servers WHERE event_id = ?').run(input.id);

      const bind = this.#db.prepare(
        'INSERT OR IGNORE INTO world_event_servers (event_id, server_id) VALUES (?, ?)',
      );

      for (const serverId of input.servers) bind.run(input.id, serverId);

      this.#db.exec('COMMIT');
    } catch (cause) {
      this.#db.exec('ROLLBACK');
      throw cause;
    }

    const saved = this.get(input.id);

    if (saved === null) {
      throw new Error(`o evento "${input.id}" não pôde ser lido logo após a escrita`);
    }

    return saved;
  }

  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM world_events WHERE id = ?').run(id).changes > 0;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM world_events').get() as {
      total: number;
    };

    return row.total;
  }

  // ------------------------------------------------------
  //  As zonas proibidas
  // ------------------------------------------------------

  zonesOf(serverId: string): readonly EventZone[] {
    const rows = this.#db
      .prepare('SELECT * FROM world_event_zones WHERE server_id = ? ORDER BY id')
      .all(serverId) as {
      id: number;
      server_id: string;
      label: string;
      x: number;
      z: number;
      radius: number;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      label: row.label,
      x: row.x,
      z: row.z,
      radius: row.radius,
      createdAt: row.created_at,
    }));
  }

  addZone(serverId: string, input: EventZoneInput, now: number = Date.now()): EventZone {
    const result = this.#db
      .prepare(
        `INSERT INTO world_event_zones (server_id, label, x, z, radius, created_at)
              VALUES (@serverId, @label, @x, @z, @radius, @now)`,
      )
      .run({ serverId, label: input.label, x: input.x, z: input.z, radius: input.radius, now });

    return {
      id: Number(result.lastInsertRowid),
      serverId,
      label: input.label,
      x: input.x,
      z: input.z,
      radius: input.radius,
      createdAt: now,
    };
  }

  removeZone(serverId: string, zoneId: number): boolean {
    return (
      this.#db
        .prepare('DELETE FROM world_event_zones WHERE server_id = ? AND id = ?')
        .run(serverId, zoneId).changes > 0
    );
  }

  // ------------------------------------------------------
  //  As runs
  // ------------------------------------------------------

  /**
   * Registra um nascimento que já aconteceu.
   *
   * O plugin constrói primeiro e avisa depois — então a run nasce
   * `active`, e não `spawning`. O estado `spawning` é do caminho
   * agendado, em que o agente manda construir e espera.
   */
  startRun(input: RunStartInput): EventRun {
    const startedAt = input.startedAt ?? Date.now();

    const result = this.#db
      .prepare(
        `INSERT INTO world_event_runs
              (event_id, server_id, dungeon_id, status, pos_x, pos_z, grid, seed, started_at)
              VALUES (@eventId, @serverId, @dungeonId, 'active', @x, @z, @grid, @seed, @startedAt)`,
      )
      .run({
        eventId: input.eventId,
        serverId: input.serverId,
        dungeonId: input.dungeonId,
        x: input.x,
        z: input.z,
        grid: input.grid,
        seed: input.seed,
        startedAt,
      });

    const run = this.run(Number(result.lastInsertRowid));

    if (run === null) throw new Error('a run não pôde ser lida logo após a escrita');

    this.#logger?.debug({ run: run.id, event: input.eventId, grid: input.grid }, 'run aberta');

    return run;
  }

  /** Registra uma tentativa que não deu certo. */
  failRun(input: {
    readonly eventId: string;
    readonly serverId: string;
    readonly dungeonId: string | null;
    readonly reason: FailureReason;
    readonly at?: number;
  }): EventRun {
    const at = input.at ?? Date.now();

    const result = this.#db
      .prepare(
        `INSERT INTO world_event_runs
              (event_id, server_id, dungeon_id, status, failure_reason, started_at, ended_at)
              VALUES (@eventId, @serverId, @dungeonId, 'failed', @reason, @at, @at)`,
      )
      .run({
        eventId: input.eventId,
        serverId: input.serverId,
        dungeonId: input.dungeonId,
        reason: input.reason,
        at,
      });

    const run = this.run(Number(result.lastInsertRowid));

    if (run === null) throw new Error('a run não pôde ser lida logo após a escrita');

    return run;
  }

  /** Fecha uma run. `cancelled` quando foi o admin. */
  endRun(runId: number, status: RunStatus = 'ended', endedAt: number = Date.now()): boolean {
    return (
      this.#db
        .prepare('UPDATE world_event_runs SET status = ?, ended_at = ? WHERE id = ?')
        .run(status, endedAt, runId).changes > 0
    );
  }

  run(id: number): EventRun | null {
    const row = this.#db.prepare('SELECT * FROM world_event_runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;

    return row === undefined ? null : toRun(row);
  }

  /**
   * O histórico, com filtro.
   *
   * ####  `since` É O OLHO DO ASSISTENTE  ####
   *
   * O passo ⑥ do editor abre, guarda o relógio, e pergunta a cada
   * dois segundos "nasceu alguma coisa desta masmorra depois
   * daquele instante?". Sem `since`, ele celebraria a construção de
   * ontem. Ver §12.1.1 do plano.
   */
  runs(filter: {
    readonly eventId?: string;
    readonly dungeonId?: string;
    readonly serverId?: string;
    readonly since?: number;
    readonly limit?: number;
  }): readonly EventRun[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.eventId !== undefined) {
      where.push('event_id = @eventId');
      params.eventId = filter.eventId;
    }

    if (filter.dungeonId !== undefined) {
      where.push('dungeon_id = @dungeonId');
      params.dungeonId = filter.dungeonId;
    }

    if (filter.serverId !== undefined) {
      where.push('server_id = @serverId');
      params.serverId = filter.serverId;
    }

    if (filter.since !== undefined) {
      where.push('started_at >= @since');
      params.since = filter.since;
    }

    params.limit = filter.limit ?? 50;

    const rows = this.#db
      .prepare(
        `SELECT * FROM world_event_runs
          ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY started_at DESC, id DESC
          LIMIT @limit`,
      )
      .all(params) as RunRow[];

    return rows.map(toRun);
  }

  /** A run que está de pé naquele servidor, se houver. */
  activeRun(serverId: string): EventRun | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM world_event_runs
          WHERE server_id = ? AND status IN ('spawning','active','closing')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(serverId) as RunRow | undefined;

    return row === undefined ? null : toRun(row);
  }

  /** Marca que alguém entrou. Chamar duas vezes não conta duas. */
  playerEntered(runId: number, steamId: string, at: number = Date.now()): void {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO world_event_run_players (run_id, steam_id, entered_at)
              VALUES (?, ?, ?)`,
      )
      .run(runId, steamId, at);

    if (result.changes > 0) {
      this.#db
        .prepare('UPDATE world_event_runs SET entered_count = entered_count + 1 WHERE id = ?')
        .run(runId);
    }
  }

  playerLeft(runId: number, steamId: string, died = false, at: number = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE world_event_run_players SET left_at = ?, died = ?
          WHERE run_id = ? AND steam_id = ?`,
      )
      .run(at, died ? 1 : 0, runId, steamId);
  }

  playersOf(runId: number): readonly EventRunPlayer[] {
    const rows = this.#db
      .prepare(
        'SELECT steam_id, entered_at, left_at, died FROM world_event_run_players WHERE run_id = ? ORDER BY entered_at',
      )
      .all(runId) as {
      steam_id: string;
      entered_at: number;
      left_at: number | null;
      died: number;
    }[];

    return rows.map((row) => ({
      steamId: row.steam_id,
      enteredAt: row.entered_at,
      leftAt: row.left_at,
      died: row.died === 1,
    }));
  }

  // ------------------------------------------------------

  #serversOf(eventId: string): string[] {
    const rows = this.#db
      .prepare('SELECT server_id FROM world_event_servers WHERE event_id = ? ORDER BY server_id')
      .all(eventId) as { server_id: string }[];

    return rows.map((row) => row.server_id);
  }

  /** Todos os vínculos numa consulta só: com dez eventos, o N+1 daqui seriam dez idas. */
  #allServers(): Map<string, string[]> {
    const rows = this.#db
      .prepare('SELECT event_id, server_id FROM world_event_servers ORDER BY server_id')
      .all() as { event_id: string; server_id: string }[];

    const map = new Map<string, string[]>();

    for (const row of rows) {
      const list = map.get(row.event_id);

      if (list === undefined) map.set(row.event_id, [row.server_id]);
      else list.push(row.server_id);
    }

    return map;
  }

  #toEvent(row: EventRow, servers: readonly string[]): WorldEvent {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      sort: row.sort,
      spawnMode: pick(SPAWN_MODES, row.spawn_mode, 'schedule') as SpawnMode,
      interval: { min: row.interval_min, max: row.interval_max },
      duration: { min: row.duration_min, max: row.duration_max },
      minOnline: row.min_online,
      countAfterEnd: row.count_after_end === 1,
      access: pick(EVENT_ACCESS, row.access, 'team') as EventAccess,
      ownerGraceSeconds: row.owner_grace_seconds,
      marker: {
        enabled: row.marker_enabled === 1,
        label: row.marker_label,
        color: row.marker_color,
        alpha: row.marker_alpha,
        radius: row.marker_radius,
        showOwner: row.marker_show_owner === 1,
        showTime: row.marker_show_time === 1,
      },
      messages: {
        start: row.msg_start,
        location: row.msg_location,
        warning: row.msg_warning,
        end: row.msg_end,
        denied: row.msg_denied,
      },
      warnBefore: row.warn_before,
      radiationBefore: row.radiation_before,
      destroyAfter: row.destroy_after,
      respawnSeconds: row.respawn_seconds,
      servers: [...servers],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function toRun(row: RunRow): EventRun {
  return {
    id: row.id,
    eventId: row.event_id,
    serverId: row.server_id,
    dungeonId: row.dungeon_id,
    status: pick(RUN_STATUS, row.status, 'ended') as RunStatus,
    failureReason:
      row.failure_reason !== null &&
      (FAILURE_REASONS as readonly string[]).includes(row.failure_reason)
        ? (row.failure_reason as FailureReason)
        : null,
    x: row.pos_x,
    z: row.pos_z,
    grid: row.grid,
    seed: row.seed,
    ownerSteamId: row.owner_steam_id,
    enteredCount: row.entered_count,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * O valor da coluna, se ele for um dos conhecidos.
 *
 * O CHECK do banco já barra o resto, mas o TypeScript não sabe
 * disso — e um `as` cego aqui faria um valor de um banco editado à
 * mão atravessar como se fosse válido.
 */
function pick<T extends string>(allowed: readonly T[], raw: string, fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Campo esvaziado no painel quer dizer "volte ao padrão". */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}
