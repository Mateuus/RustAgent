// ============================================================
//  bp-repository.ts  -  o snapshot de blueprints e a fila de
//  devolução (migração 28).
//
//  Três tabelas, e cada uma responde uma pergunta:
//
//      bp_snapshots     o que cada jogador sabia antes do wipe
//      bp_restores      o que ainda é devido a alguém
//      bp_item_benches  que bancada o JOGO exige de cada item
//
//  ------------------------------------------------------------
//  ####  UM SNAPSHOT POR SERVIDOR, E ELE É SUBSTITUÍDO INTEIRO  ####
//
//  `replaceSnapshot` apaga o anterior e grava o novo NA MESMA
//  transação. É assim que "o snapshot vale para o wipe seguinte, e
//  só ele" vira regra do banco em vez de intenção: não existe
//  estado em que dois snapshots do mesmo servidor convivem, e por
//  isso nunca há dúvida sobre qual deles uma devolução usa.
//
//  As devoluções pendentes do snapshot anterior viram `expired` na
//  mesma transação. Elas NÃO são apagadas: "ninguém entrou para
//  receber" é exatamente o que alguém vai querer ler depois.
//
//  ####  A IDEMPOTÊNCIA É UM ÍNDICE, E NÃO UM `if`  ####
//
//  `UNIQUE (snapshot_id, steam_id)`: o jogador que entra e sai três
//  vezes não ganha três linhas, e um `enqueue` repetido (a retomada
//  de um wipe) não duplica a fila.
//
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Quem manda `origemz.bp.export` e `origemz.bp.restore` é
//  wipe/blueprints.ts. Aqui só entra e sai linha — e é essa
//  separação que permite testar a régua e a expiração com um banco
//  em memória, sem servidor de Rust nenhum.
// ============================================================

import {
  DEFAULT_BP_SETTINGS,
  MAX_BENCH,
  MAX_BP_DELAY_HOURS,
  type BpRuleMode,
  type BpSettings,
  type BpTierRule,
} from '../wipe/blueprints.js';
import type { AgentDatabase } from './database.js';

/** As chaves deste módulo dentro de `wipe_settings`. */
const KEY = {
  tiers: 'bp.tiers',
  delayHours: 'bp.delayHours',
} as const;

/** Uma linha de `bp_snapshots`, do jeito que o serviço lê. */
export interface BpSnapshotRecord {
  readonly id: number;
  readonly serverId: string;
  readonly wipeRunId: number | null;
  readonly steamId: string;
  /** Os itemIds que ele sabia. */
  readonly items: readonly number[];
  readonly itemCount: number;
  readonly createdAt: number;
}

/** O que a tela mostra sobre o último snapshot. */
export interface BpSnapshotSummary {
  readonly players: number;
  readonly items: number;
  readonly createdAt: number;
  /** A execução de wipe que o tirou. `null` = foi tirado na mão. */
  readonly wipeRunId: number | null;
}

/** O par que o `replaceSnapshot` grava. */
export interface BpSnapshotEntry {
  readonly steamId: string;
  readonly items: readonly number[];
}

export const BP_RESTORE_STATES = ['pending', 'sent', 'applied', 'expired', 'failed'] as const;

/**
 * Em que pé está uma devolução.
 *
 *   pending  ainda é devida, e o relógio olha para ela
 *   sent     o comando saiu; o plugin aplicou ou pôs na fila dele
 *   applied  o jogo confirmou que aplicou
 *   expired  um wipe novo aconteceu antes de ela sair
 *   failed   o plugin recusou vezes demais
 */
export type BpRestoreState = (typeof BP_RESTORE_STATES)[number];

export interface BpRestoreRecord {
  readonly id: number;
  readonly serverId: string;
  /**
   * `null` = o snapshot que a originou já foi substituído.
   *
   * A linha vira histórico: ela continua dizendo a quem era
   * devida e o que saiu, com `state: 'expired'`.
   */
  readonly snapshotId: number | null;
  readonly steamId: string;
  /** O nível usado na entrega. `null` = ainda não foi entregue. */
  readonly tier: string | null;
  /** O que de fato saiu, depois da régua. `null` = ainda não saiu. */
  readonly items: readonly number[] | null;
  readonly releaseAt: number;
  readonly state: BpRestoreState;
  readonly attempts: number;
  readonly sentAt: number | null;
  readonly appliedAt: number | null;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface BpRestoreCounters {
  readonly pending: number;
  readonly sent: number;
  readonly applied: number;
  readonly expired: number;
  readonly failed: number;
}

interface SnapshotRow {
  readonly id: number;
  readonly server_id: string;
  readonly wipe_run_id: number | null;
  readonly steam_id: string;
  readonly items: string;
  readonly item_count: number;
  readonly created_at: number;
}

interface RestoreRow {
  readonly id: number;
  readonly server_id: string;
  readonly snapshot_id: number | null;
  readonly steam_id: string;
  readonly tier: string | null;
  readonly items: string | null;
  readonly release_at: number;
  readonly state: string;
  readonly attempts: number;
  readonly sent_at: number | null;
  readonly applied_at: number | null;
  readonly error: string | null;
  readonly created_at: number;
}

export class BpRepository {
  readonly #db: AgentDatabase;

  /**
   * A bancada de cada item, por servidor, em memória.
   *
   * ####  POR QUE NÃO UMA CONSULTA POR ITEM  ####
   *
   * A régua é aplicada item a item, e um jogador tem centenas
   * deles: consultar o banco por item transformaria uma devolução
   * em milhares de idas ao SQLite. O mapa é trocado inteiro a cada
   * snapshot novo, que é a única hora em que ele muda.
   */
  readonly #benches = new Map<string, Map<number, number>>();

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ----------------------------------------------------------
  //  A RÉGUA
  // ----------------------------------------------------------

  getSettings(serverId: string): BpSettings {
    const rows = this.#db
      .prepare(
        `SELECT key, value FROM wipe_settings
          WHERE server_id = @server_id AND key IN (@tiers, @delay)`,
      )
      .all({ server_id: serverId, tiers: KEY.tiers, delay: KEY.delayHours }) as {
      readonly key: string;
      readonly value: string;
    }[];

    const stored = new Map(rows.map((row) => [row.key, row.value]));

    return {
      tiers: parseTiers(stored.get(KEY.tiers)),
      delayHours: parseDelay(stored.get(KEY.delayHours)),
    };
  }

  saveSettings(serverId: string, settings: BpSettings, now: number = Date.now()): BpSettings {
    const statement = this.#db.prepare(
      `INSERT INTO wipe_settings (server_id, key, value, updated_at)
            VALUES (@server_id, @key, @value, @now)
       ON CONFLICT (server_id, key) DO UPDATE SET value = @value, updated_at = @now`,
    );

    const values: Readonly<Record<string, string>> = {
      // JSON, e não uma lista com separador: o nome do nível vem do
      // `OrigemZVip.json` daquele servidor e é texto livre.
      [KEY.tiers]: JSON.stringify(normalizeTiers(settings.tiers)),
      [KEY.delayHours]: String(parseDelay(String(settings.delayHours))),
    };

    this.#db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        statement.run({ server_id: serverId, key, value, now });
      }
    })();

    return this.getSettings(serverId);
  }

  // ----------------------------------------------------------
  //  O SNAPSHOT
  // ----------------------------------------------------------

  /**
   * Troca o snapshot inteiro daquele servidor.
   *
   * Ver o cabeçalho: é uma transação só, e é ela que faz o snapshot
   * valer para o wipe seguinte e só ele.
   */
  replaceSnapshot(
    serverId: string,
    input: {
      readonly wipeRunId: number | null;
      readonly entries: readonly BpSnapshotEntry[];
      readonly benches: ReadonlyMap<number, number>;
    },
    now: number = Date.now(),
  ): number {
    const insertSnapshot = this.#db.prepare(
      `INSERT INTO bp_snapshots (server_id, wipe_run_id, steam_id, items, item_count, created_at)
            VALUES (@server_id, @wipe_run_id, @steam_id, @items, @item_count, @created_at)`,
    );

    const insertBench = this.#db.prepare(
      `INSERT INTO bp_item_benches (server_id, item_id, workbench, updated_at)
            VALUES (@server_id, @item_id, @workbench, @now)
       ON CONFLICT (server_id, item_id) DO UPDATE SET workbench = @workbench, updated_at = @now`,
    );

    const run = this.#db.transaction((): number => {
      // As devoluções que ainda não saíram morrem com o snapshot
      // que as originou. Elas ficam registradas como `expired` —
      // ver o cabeçalho.
      this.#db
        .prepare(
          `UPDATE bp_restores
              SET state = 'expired', error = 'um wipe novo aconteceu antes desta devolução sair'
            WHERE server_id = @server_id AND state IN ('pending', 'sent')`,
        )
        .run({ server_id: serverId });

      this.#db.prepare('DELETE FROM bp_snapshots WHERE server_id = @server_id').run({
        server_id: serverId,
      });

      for (const entry of input.entries) {
        const items = [...new Set(entry.items)];

        insertSnapshot.run({
          server_id: serverId,
          wipe_run_id: input.wipeRunId,
          steam_id: entry.steamId,
          items: JSON.stringify(items),
          item_count: items.length,
          created_at: now,
        });
      }

      for (const [itemId, workbench] of input.benches) {
        insertBench.run({ server_id: serverId, item_id: itemId, workbench, now });
      }

      return input.entries.length;
    });

    const written = run();

    // O mapa em memória é reconstruído na próxima consulta: o que
    // acabou de chegar do jogo é a verdade, e o que estava aqui
    // pode ser de uma versão anterior do Rust.
    this.#benches.delete(serverId);

    return written;
  }

  /** O retrato do último snapshot, para a tela. `null` = não há. */
  lastSnapshot(serverId: string): BpSnapshotSummary | null {
    const row = this.#db
      .prepare(
        `SELECT count(*) AS players,
                coalesce(sum(item_count), 0) AS items,
                max(created_at) AS created_at,
                max(wipe_run_id) AS wipe_run_id
           FROM bp_snapshots
          WHERE server_id = @server_id`,
      )
      .get({ server_id: serverId }) as {
      readonly players: number;
      readonly items: number;
      readonly created_at: number | null;
      readonly wipe_run_id: number | null;
    };

    if (row.players === 0 || row.created_at === null) {
      return null;
    }

    return {
      players: row.players,
      items: row.items,
      createdAt: row.created_at,
      wipeRunId: row.wipe_run_id,
    };
  }

  snapshotOf(serverId: string, steamId: string): BpSnapshotRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM bp_snapshots WHERE server_id = @server_id AND steam_id = @steam_id')
      .get({ server_id: serverId, steam_id: steamId }) as SnapshotRow | undefined;

    return row === undefined ? null : toSnapshot(row);
  }

  snapshotById(id: number): BpSnapshotRecord | null {
    const row = this.#db.prepare('SELECT * FROM bp_snapshots WHERE id = @id').get({ id }) as
      | SnapshotRow
      | undefined;

    return row === undefined ? null : toSnapshot(row);
  }

  /** A bancada que o jogo exige daquele item. `0` = nenhuma. */
  benchOf(serverId: string, itemId: number): number {
    let map = this.#benches.get(serverId);

    if (map === undefined) {
      const rows = this.#db
        .prepare('SELECT item_id, workbench FROM bp_item_benches WHERE server_id = @server_id')
        .all({ server_id: serverId }) as {
        readonly item_id: number;
        readonly workbench: number;
      }[];

      map = new Map(rows.map((row) => [row.item_id, row.workbench]));
      this.#benches.set(serverId, map);
    }

    return map.get(itemId) ?? 0;
  }

  // ----------------------------------------------------------
  //  A FILA DE DEVOLUÇÃO
  // ----------------------------------------------------------

  /**
   * Uma linha por jogador do snapshot daquela execução.
   *
   * Inclusive quem não é VIP hoje: o direito é conferido na
   * entrega, e o `ON CONFLICT DO NOTHING` faz uma retomada de wipe
   * não duplicar a fila.
   *
   * ####  O FILTRO POR EXECUÇÃO NÃO É ENFEITE  ####
   *
   * Sem ele, um wipe cujo snapshot FALHOU abriria a fila em cima do
   * snapshot que alguém tirou na mão dias antes — e devolveria a
   * todo mundo o que eles sabiam naquele dia, com o log da execução
   * dizendo que a política tinha caído para `wipe`. Duas verdades
   * sobre o mesmo wipe.
   *
   * `wipeRunId` nulo casa com os snapshots tirados na mão, e é o
   * que a rota de devolução manual usa.
   */
  enqueueRestores(
    serverId: string,
    wipeRunId: number | null,
    releaseAt: number,
    now: number = Date.now(),
  ): number {
    const result = this.#db
      .prepare(
        `INSERT INTO bp_restores (server_id, snapshot_id, steam_id, release_at, state, created_at)
              SELECT server_id, id, steam_id, @release_at, 'pending', @now
                FROM bp_snapshots
               WHERE server_id = @server_id AND wipe_run_id IS @wipe_run_id
         ON CONFLICT (snapshot_id, steam_id) DO NOTHING`,
      )
      .run({ server_id: serverId, wipe_run_id: wipeRunId, release_at: releaseAt, now });

    return result.changes;
  }

  /**
   * O que já pode sair, para quem está ONLINE agora.
   *
   * `sent` volta na lista de propósito: ele quer dizer "o comando
   * saiu e o plugin pôs na fila VOLÁTIL dele". Um `oxide.reload`
   * apaga aquela fila, e a única maneira de o jogador ainda receber
   * é o agente insistir quando ele estiver online.
   *
   * ####  O FILTRO DE QUEM ESTÁ ONLINE É SQL, E NÃO UM `filter`  ####
   *
   * Porque a consulta tem TETO. Filtrando depois, um servidor com
   * mil devoluções pendentes gastaria as cem linhas da rodada com
   * jogadores que não voltaram mais — e quem estivesse online
   * nunca receberia, para sempre, sem nada dizendo por quê.
   */
  dueRestores(
    serverId: string,
    now: number,
    limit: number,
    onlyPlayers?: readonly string[],
  ): readonly BpRestoreRecord[] {
    const filters: Record<string, string | number> = { server_id: serverId, now, limit };
    let clause = '';

    if (onlyPlayers !== undefined) {
      if (onlyPlayers.length === 0) {
        return [];
      }

      const names = onlyPlayers.map((steamId, index) => {
        const name = `p${String(index)}`;

        filters[name] = steamId;

        return `@${name}`;
      });

      clause = `AND steam_id IN (${names.join(', ')})`;
    }

    const rows = this.#db
      .prepare(
        `SELECT * FROM bp_restores
          WHERE server_id = @server_id
            AND state IN ('pending', 'sent')
            AND release_at <= @now
            ${clause}
          ORDER BY release_at ASC, id ASC
          LIMIT @limit`,
      )
      .all(filters) as RestoreRow[];

    return rows.map(toRestore);
  }

  restoreOf(serverId: string, snapshotId: number): BpRestoreRecord | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM bp_restores WHERE server_id = @server_id AND snapshot_id = @snapshot_id',
      )
      .get({ server_id: serverId, snapshot_id: snapshotId }) as RestoreRow | undefined;

    return row === undefined ? null : toRestore(row);
  }

  markSent(
    id: number,
    tier: string | null,
    items: readonly number[],
    now: number = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE bp_restores
            SET state = 'sent', tier = @tier, items = @items, sent_at = @now,
                attempts = attempts + 1, error = NULL
          WHERE id = @id AND state IN ('pending', 'sent')`,
      )
      .run({ id, tier, items: JSON.stringify([...items]), now });
  }

  markApplied(id: number, now: number = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE bp_restores
            SET state = 'applied', applied_at = @now
          WHERE id = @id AND state IN ('pending', 'sent')`,
      )
      .run({ id, now });
  }

  /** O comando saiu e o plugin recusou. A linha continua devida. */
  markAttempt(id: number, now: number = Date.now()): void {
    this.#db
      .prepare('UPDATE bp_restores SET attempts = attempts + 1, sent_at = @now WHERE id = @id')
      .run({ id, now });
  }

  markFailed(id: number, error: string, now: number = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE bp_restores
            SET state = 'failed', error = @error, attempts = attempts + 1, sent_at = @now
          WHERE id = @id`,
      )
      .run({ id, error, now });
  }

  /** Quantas devoluções em cada estado. É o que a tela conta. */
  counters(serverId: string): BpRestoreCounters {
    const rows = this.#db
      .prepare(
        'SELECT state, count(*) AS total FROM bp_restores WHERE server_id = @server_id GROUP BY state',
      )
      .all({ server_id: serverId }) as { readonly state: string; readonly total: number }[];

    const of = (state: BpRestoreState): number =>
      rows.find((row) => row.state === state)?.total ?? 0;

    return {
      pending: of('pending'),
      sent: of('sent'),
      applied: of('applied'),
      expired: of('expired'),
      failed: of('failed'),
    };
  }
}

// ------------------------------------------------------------
//  A leitura da configuração
// ------------------------------------------------------------

/**
 * A régua gravada, ou o padrão.
 *
 * JSON quebrado vira o PADRÃO, e não um erro: esta função é
 * chamada no meio de uma devolução e de um wipe, e derrubar
 * qualquer um dos dois por causa de uma linha de configuração
 * seria trocar um problema pequeno por um grande.
 */
function parseTiers(raw: string | undefined): Readonly<Record<string, BpTierRule>> {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_BP_SETTINGS.tiers;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_BP_SETTINGS.tiers;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_BP_SETTINGS.tiers;
  }

  const tiers: Record<string, BpTierRule> = {};

  for (const [tier, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') {
      continue;
    }

    const entry = value as { readonly mode?: unknown; readonly bench?: unknown };
    const mode = normalizeMode(entry.mode);

    if (mode === null) {
      continue;
    }

    tiers[tier.trim().toLowerCase()] = { mode, bench: normalizeBench(entry.bench) };
  }

  return Object.keys(tiers).length === 0 ? DEFAULT_BP_SETTINGS.tiers : tiers;
}

function normalizeTiers(
  tiers: Readonly<Record<string, BpTierRule>>,
): Readonly<Record<string, BpTierRule>> {
  const normalized: Record<string, BpTierRule> = {};

  for (const [tier, rule] of Object.entries(tiers)) {
    const mode = normalizeMode(rule.mode);

    if (mode === null) {
      continue;
    }

    normalized[tier.trim().toLowerCase()] = { mode, bench: normalizeBench(rule.bench) };
  }

  return normalized;
}

function normalizeMode(value: unknown): BpRuleMode | null {
  return value === 'none' || value === 'bench' || value === 'all' ? value : null;
}

function normalizeBench(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_BENCH, Math.round(parsed)));
}

function parseDelay(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_BP_SETTINGS.delayHours;
  }

  return Math.max(0, Math.min(MAX_BP_DELAY_HOURS, Math.round(parsed)));
}

// ------------------------------------------------------------
//  As linhas cruas
// ------------------------------------------------------------

function toSnapshot(row: SnapshotRow): BpSnapshotRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    wipeRunId: row.wipe_run_id,
    steamId: row.steam_id,
    // Linha corrompida vira lista vazia, e o desfecho é o
    // conservador: a régua não devolve nada, em vez de devolver
    // uma lista adivinhada.
    items: parseItems(row.items) ?? [],
    itemCount: row.item_count,
    createdAt: row.created_at,
  };
}

function toRestore(row: RestoreRow): BpRestoreRecord {
  const state = (BP_RESTORE_STATES as readonly string[]).includes(row.state)
    ? (row.state as BpRestoreState)
    : 'pending';

  return {
    id: row.id,
    serverId: row.server_id,
    snapshotId: row.snapshot_id,
    steamId: row.steam_id,
    tier: row.tier,
    items: row.items === null ? null : parseItems(row.items),
    releaseAt: row.release_at,
    state,
    attempts: row.attempts,
    sentAt: row.sent_at,
    appliedAt: row.applied_at,
    error: row.error,
    createdAt: row.created_at,
  };
}

/**
 * A coluna `items` é JSON de inteiros.
 *
 * `null` quando ela não faz parse: é uma linha corrompida, e
 * devolver lista vazia a esconderia — quem chama trata `null` como
 * "não sei o que ele sabia", que é a verdade.
 */
function parseItems(raw: string): readonly number[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed.filter((value): value is number => Number.isInteger(value));
  } catch {
    return null;
  }
}
