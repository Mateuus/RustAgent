// ============================================================
//  workshop-access-repository.ts  -  quem pode usar o quê, e o
//  registro de tudo que mudou.
//
//  ####  O ACESSO É UM "OU" A MAIS, NUNCA UM "E"  ####
//
//  Uma linha aqui LIBERA uma skin ou uma coleção para um jogador
//  (SteamID64) ou para um grupo do Oxide. Ela não bloqueia nada: a
//  permissão e o "para todos" da skin continuam valendo por conta
//  própria. Ver types/workshop.ts, "QUEM PODE USAR UMA SKIN".
//
//  ####  VENCIDO NÃO É APAGADO  ####
//
//  O push só leva os vivos (e o plugin confere o prazo de novo).
//  A linha vencida fica para a tela dizer "venceu em 12/10" — um
//  acesso que some sozinho é a pergunta de suporte "quem tirou
//  minha skin?" sem resposta.
//
//  ####  O REGISTRO NÃO TEM CHAVE ESTRANGEIRA  ####
//
//  "Apaguei a skin 12" precisa sobreviver à skin 12. O alvo é
//  gravado em texto, com o nome que tinha naquela hora.
// ============================================================

import type {
  GrantSubjectType,
  GrantTargetType,
  WorkshopAuditEntry,
  WorkshopAuditInput,
  WorkshopAuditSource,
  WorkshopGrant,
  WorkshopGrantInput,
} from '../types/workshop.js';
import type { AgentDatabase } from './database.js';

interface GrantRow {
  readonly id: number;
  readonly subject_type: string;
  readonly subject: string;
  readonly target_type: string;
  readonly skin_ref: number | null;
  readonly collection_ref: number | null;
  readonly expires_at: number | null;
  readonly note: string;
  readonly created_by: string | null;
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

function toGrant(row: GrantRow): WorkshopGrant {
  const targetType: GrantTargetType = row.target_type === 'collection' ? 'collection' : 'skin';

  return {
    id: row.id,
    subjectType: (row.subject_type === 'group' ? 'group' : 'player') satisfies GrantSubjectType,
    subject: row.subject,
    targetType,
    targetId: (targetType === 'skin' ? row.skin_ref : row.collection_ref) ?? 0,
    expiresAt: row.expires_at,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAudit(row: AuditRow): WorkshopAuditEntry {
  let detail: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(row.detail);

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // Detalhe estragado não esconde a linha: o que importa nela é
    // quem, quando e o quê, e isso está nas outras colunas.
  }

  const source: WorkshopAuditSource =
    row.source === 'game' ? 'game' : row.source === 'system' ? 'system' : 'panel';

  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    source,
    action: row.action,
    target: row.target,
    serverId: row.server_id,
    steamId: row.steam_id,
    detail,
  };
}

export interface GrantFilter {
  readonly subjectType?: GrantSubjectType;
  readonly subject?: string;
  readonly targetType?: GrantTargetType;
  readonly targetId?: number;
  /** `false` = só os vivos. Padrão: todos. */
  readonly includeExpired?: boolean;
}

export interface AuditFilter {
  readonly steamId?: string;
  readonly limit: number;
  /** Só linhas com id menor que este — a página seguinte. */
  readonly before?: number;
}

export class WorkshopAccessRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ======================================================
  //  ACESSOS
  // ======================================================

  listGrants(filter: GrantFilter = {}, now: number = Date.now()): readonly WorkshopGrant[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { now };

    if (filter.subjectType !== undefined) {
      where.push('subject_type = @subject_type');
      params['subject_type'] = filter.subjectType;
    }

    if (filter.subject !== undefined) {
      where.push('subject = @subject');
      params['subject'] = filter.subject;
    }

    if (filter.targetType !== undefined) {
      where.push('target_type = @target_type');
      params['target_type'] = filter.targetType;

      if (filter.targetId !== undefined) {
        where.push(filter.targetType === 'skin' ? 'skin_ref = @target_id' : 'collection_ref = @target_id');
        params['target_id'] = filter.targetId;
      }
    }

    if (filter.includeExpired === false) {
      where.push('(expires_at IS NULL OR expires_at > @now)');
    }

    const sql =
      'SELECT * FROM workshop_grants' +
      (where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`) +
      ' ORDER BY created_at DESC, id DESC';

    return (this.#db.prepare(sql).all(params) as GrantRow[]).map(toGrant);
  }

  /** Os que valem agora. É o que desce para o plugin. */
  liveGrants(now: number = Date.now()): readonly WorkshopGrant[] {
    return this.listGrants({ includeExpired: false }, now);
  }

  getGrant(id: number): WorkshopGrant | null {
    const row = this.#db.prepare('SELECT * FROM workshop_grants WHERE id = ?').get(id) as
      | GrantRow
      | undefined;

    return row === undefined ? null : toGrant(row);
  }

  /**
   * Libera — ou troca o prazo de quem já tinha.
   *
   * O mesmo acesso duas vezes é UM só (índice único): liberar de
   * novo por 30 dias quem tinha 7 é o gesto de "renovar", e não o
   * de empilhar duas linhas que a tela teria de explicar.
   *
   * @returns a linha e se ela era nova.
   */
  upsertGrant(
    input: WorkshopGrantInput,
    createdBy: string | null,
    now: number = Date.now(),
  ): { readonly grant: WorkshopGrant; readonly created: boolean } {
    const refs = {
      skin_ref: input.targetType === 'skin' ? input.targetId : null,
      collection_ref: input.targetType === 'collection' ? input.targetId : null,
    };

    const existing = this.#db
      .prepare(
        `SELECT id FROM workshop_grants
          WHERE subject_type = @subject_type AND subject = @subject
            AND target_type = @target_type
            AND ifnull(skin_ref, 0) = ifnull(@skin_ref, 0)
            AND ifnull(collection_ref, 0) = ifnull(@collection_ref, 0)`,
      )
      .get({
        subject_type: input.subjectType,
        subject: input.subject,
        target_type: input.targetType,
        ...refs,
      }) as { id: number } | undefined;

    if (existing !== undefined) {
      this.#db
        .prepare(
          `UPDATE workshop_grants SET expires_at = @expires_at, note = @note, updated_at = @now
            WHERE id = @id`,
        )
        .run({ id: existing.id, expires_at: input.expiresAt, note: input.note, now });

      return { grant: this.#mustGetGrant(existing.id), created: false };
    }

    const result = this.#db
      .prepare(
        `INSERT INTO workshop_grants
           (subject_type, subject, target_type, skin_ref, collection_ref, expires_at, note,
            created_by, created_at, updated_at)
         VALUES
           (@subject_type, @subject, @target_type, @skin_ref, @collection_ref, @expires_at, @note,
            @created_by, @now, @now)`,
      )
      .run({
        subject_type: input.subjectType,
        subject: input.subject,
        target_type: input.targetType,
        ...refs,
        expires_at: input.expiresAt,
        note: input.note,
        created_by: createdBy,
        now,
      });

    return { grant: this.#mustGetGrant(Number(result.lastInsertRowid)), created: true };
  }

  removeGrant(id: number): boolean {
    return this.#db.prepare('DELETE FROM workshop_grants WHERE id = ?').run(id).changes > 0;
  }

  /**
   * O próximo prazo que vai vencer DEPOIS de `after`, se houver.
   *
   * É o relógio do serviço: ele dorme até lá, reenvia a carga e
   * registra quem venceu.
   */
  nextExpiry(after: number): number | null {
    const row = this.#db
      .prepare(
        `SELECT min(expires_at) AS at FROM workshop_grants
          WHERE expires_at IS NOT NULL AND expires_at > ?`,
      )
      .get(after) as { at: number | null };

    return row.at;
  }

  /** Os que venceram na janela `(from, to]`. */
  expiredBetween(from: number, to: number): readonly WorkshopGrant[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM workshop_grants
            WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
            ORDER BY expires_at ASC`,
        )
        .all(from, to) as GrantRow[]
    ).map(toGrant);
  }

  #mustGetGrant(id: number): WorkshopGrant {
    const grant = this.getGrant(id);

    if (grant === null) throw new Error(`o acesso ${String(id)} sumiu logo depois de ser gravado`);

    return grant;
  }

  // ======================================================
  //  REGISTRO
  // ======================================================

  log(entry: WorkshopAuditInput, at: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO workshop_audit
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

  audit(filter: AuditFilter): readonly WorkshopAuditEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit };

    if (filter.steamId !== undefined) {
      where.push('steam_id = @steam_id');
      params['steam_id'] = filter.steamId;
    }

    if (filter.before !== undefined) {
      where.push('id < @before');
      params['before'] = filter.before;
    }

    const sql =
      'SELECT * FROM workshop_audit' +
      (where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`) +
      ' ORDER BY id DESC LIMIT @limit';

    return (this.#db.prepare(sql).all(params) as AuditRow[]).map(toAudit);
  }
}
