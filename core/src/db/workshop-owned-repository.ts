// ============================================================
//  workshop-owned-repository.ts  -  quem tem qual skin, e o
//  registro de tudo que mudou.
//
//  ####  A POSSE É UM "OU" A MAIS, NUNCA UM "E"  ####
//
//  Uma linha aqui LIBERA uma skin para um jogador (SteamID64), na
//  rede inteira. Ela não bloqueia nada: a skin "liberada para todos"
//  continua valendo sem posse. Ver types/workshop.ts.
//
//  ####  DAR DE NOVO MEXE NO PRAZO, NUMA FUNÇÃO SÓ  ####
//
//  A tabela do 02 §4.2 mora em `grantOwnership`, e SÓ nela. O
//  painel, a entrega do site e o `/skin give` do jogo chamam esta
//  mesma função (pelo `WorkshopCatalog`). Duas implementações dessa
//  tabela divergiriam no primeiro bug.
//
//  ####  VENCIDA NÃO É APAGADA  ####
//
//  A carga só leva as vivas (e o plugin confere o prazo de novo). A
//  linha vencida fica para a ficha dizer "venceu em 12/10" — uma
//  posse que some sozinha é a pergunta de suporte "quem tirou minha
//  skin?" sem resposta. Dar de novo uma vencida conta o prazo a
//  partir de agora, como se ela não existisse.
//
//  ####  O REGISTRO NÃO TEM CHAVE ESTRANGEIRA  ####
//
//  "Apaguei a skin 12" precisa sobreviver à skin 12. O alvo é
//  gravado em texto, com o nome que tinha naquela hora.
//
//  ####  AS FAVORITAS MORAM AQUI, E NÃO NUM ARQUIVO PRÓPRIO  ####
//
//  Decisão de 17/09/2026, ao trazer a favorita do plugin para o
//  agente (migração 100). Ela é uma tabela à parte, mas a MESMA
//  pergunta: "o que é deste jogador?". Três motivos:
//
//    1. ela desce na MESMA carga da posse (`origemz.workshop.owned`
//       leva `skins` e `favorites`): quem monta a carga precisa das
//       duas na mão, e um segundo repositório seria um quarto
//       parâmetro em toda a fiação (index.ts, rotas, serviço, testes)
//       por três métodos;
//    2. a forma é a mesma: `(steam_id, skin_ref)` único, sem
//       `server_id`, cascata pela skin, mesmo CHECK de SteamID64;
//    3. esta classe já não é só "posse" — ela guarda o registro
//       (`workshop_audit`), que também não é posse.
//
//  O que NÃO veio junto: favoritar não vai para o registro. É
//  preferência de tela, um clique por segundo se o jogador quiser, e
//  o 02 §6.2 já deixou "aplicar" de fora pelo mesmo motivo.
// ============================================================

import {
  grantOwnershipInputSchema,
  MAX_FAVORITES_PER_PLAYER,
  OWNED_SOURCES,
  revokeOwnershipInputSchema,
  type GrantOwnershipInput,
  type OwnedSkin,
  type OwnedSource,
  type RevokeOwnershipInput,
  type WorkshopAuditEntry,
  type WorkshopAuditInput,
  type WorkshopAuditSource,
} from '../types/workshop.js';
import type { AgentDatabase } from './database.js';

/** Um dia, em ms. O prazo do site e do painel é contado em dias. */
export const DAY_MS = 86_400_000;

interface OwnedRow {
  readonly id: number;
  readonly steam_id: string;
  readonly skin_ref: number;
  readonly expires_at: number | null;
  readonly source: string;
  readonly source_ref: string | null;
  readonly note: string | null;
  readonly created_by: string;
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

function toOwned(row: OwnedRow): OwnedSkin {
  return {
    id: row.id,
    steamId: row.steam_id,
    skinRef: row.skin_ref,
    expiresAt: row.expires_at,
    source: (OWNED_SOURCES as readonly string[]).includes(row.source)
      ? (row.source as OwnedSource)
      : 'system',
    sourceRef: row.source_ref,
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
    row.source === 'game' || row.source === 'system' || row.source === 'site' ? row.source : 'panel';

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

/** A posse está valendo neste instante? */
export function isOwnedLive(owned: Pick<OwnedSkin, 'expiresAt'>, now: number): boolean {
  return owned.expiresAt === null || owned.expiresAt > now;
}

/**
 * O prazo que resulta de dar a skin — a tabela do 02 §4.2 inteira.
 *
 * | existe            | chega         | resultado                         |
 * |-------------------|---------------|-----------------------------------|
 * | nada / vencida    | permanente    | permanente                        |
 * | nada / vencida    | `days`        | agora + days                      |
 * | nada / vencida    | `expiresAt`   | expiresAt                         |
 * | permanente        | qualquer      | permanente (NUNCA encurta)        |
 * | com prazo         | permanente    | permanente                        |
 * | com prazo         | `days`        | max(agora, prazo) + days — SOMA   |
 * | com prazo         | `expiresAt`   | max(prazo, expiresAt) — nunca encurta |
 *
 * A linha do `expiresAt` com prazo vivo não está no 02 (ele só fala
 * de dias): decidido aqui, pela mesma régua do "nunca encurta". Quem
 * quer encurtar remove e dá de novo.
 *
 * Exportada para o teste percorrer a tabela sem banco.
 */
export function renewedExpiry(
  current: Pick<OwnedSkin, 'expiresAt'> | null,
  request: { readonly days?: number | null; readonly expiresAt?: number | null },
  now: number,
): number | null {
  const days = request.days ?? null;
  const absolute = request.expiresAt ?? null;
  const permanent = days === null && absolute === null;
  if (current === null || !isOwnedLive(current, now)) {
    if (permanent) return null;

    return days !== null ? now + days * DAY_MS : absolute;
  }

  // Viva e permanente: nada encurta.
  if (current.expiresAt === null || permanent) return null;

  if (days !== null) return Math.max(now, current.expiresAt) + days * DAY_MS;

  return Math.max(current.expiresAt, absolute ?? current.expiresAt);
}

export interface OwnedFilter {
  readonly steamId?: string;
  readonly skinRef?: number;
  /** `false` = só as vivas. Padrão: todas. */
  readonly includeExpired?: boolean;
  /** Só linhas com id menor que este — a página seguinte. */
  readonly cursor?: number;
  readonly limit?: number;
}

export interface OwnedPage {
  readonly owned: readonly OwnedSkin[];
  /** O `cursor` da próxima página, ou `null` quando acabou. */
  readonly nextCursor: number | null;
}

export interface GrantOwnershipResult {
  readonly owned: OwnedSkin;
  /** `true` quando não havia posse VIVA antes (nova ou vencida). */
  readonly created: boolean;
  /** A linha como estava antes, se havia uma. */
  readonly previous: OwnedSkin | null;
}

export interface FavoriteResult {
  /** O estado DEPOIS da escrita. */
  readonly on: boolean;
  /** `false` quando já estava assim: quem chama pode não reenviar nada. */
  readonly changed: boolean;
  /** Quantas favoritas o jogador tem agora. */
  readonly count: number;
}

/**
 * O jogador já tem 200 favoritas.
 *
 * Classe própria (e não um `RangeError` genérico) porque quem chama
 * tem de distinguir "o teto" de "o banco caiu": no teto, a resposta é
 * uma frase para o jogador e o reenvio FORÇADO da verdade, que desfaz
 * o otimismo da tela dele.
 */
export class FavoritesFullError extends RangeError {
  readonly count: number;

  constructor(count: number) {
    super(
      `o jogador já tem ${String(count)} skins favoritas (o teto é ${String(MAX_FAVORITES_PER_PLAYER)})`,
    );
    this.name = 'FavoritesFullError';
    this.count = count;
  }
}

export interface AuditFilter {
  readonly steamId?: string;
  readonly limit: number;
  /** Só linhas com id menor que este — a página seguinte. */
  readonly before?: number;
}

export class WorkshopOwnedRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ======================================================
  //  POSSE — leitura
  // ======================================================

  get(id: number): OwnedSkin | null {
    const row = this.#db.prepare('SELECT * FROM workshop_owned_skins WHERE id = ?').get(id) as
      | OwnedRow
      | undefined;

    return row === undefined ? null : toOwned(row);
  }

  find(steamId: string, skinRef: number): OwnedSkin | null {
    const row = this.#db
      .prepare('SELECT * FROM workshop_owned_skins WHERE steam_id = ? AND skin_ref = ?')
      .get(steamId, skinRef) as OwnedRow | undefined;

    return row === undefined ? null : toOwned(row);
  }

  /**
   * A lista paginada, do mais novo para o mais velho.
   *
   * Cursor por `id` e não `OFFSET`: a aba Posse dá e tira em lote
   * enquanto alguém pagina, e um OFFSET pularia ou repetiria linha.
   */
  listOwned(filter: OwnedFilter = {}, now: number = Date.now()): OwnedPage {
    const where: string[] = [];
    const params: Record<string, unknown> = { now };
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);

    if (filter.steamId !== undefined) {
      where.push('steam_id = @steam_id');
      params['steam_id'] = filter.steamId;
    }

    if (filter.skinRef !== undefined) {
      where.push('skin_ref = @skin_ref');
      params['skin_ref'] = filter.skinRef;
    }

    if (filter.includeExpired === false) {
      where.push('(expires_at IS NULL OR expires_at > @now)');
    }

    if (filter.cursor !== undefined) {
      where.push('id < @cursor');
      params['cursor'] = filter.cursor;
    }

    params['limit'] = limit + 1;

    const rows = this.#db
      .prepare(
        'SELECT * FROM workshop_owned_skins' +
          (where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`) +
          ' ORDER BY id DESC LIMIT @limit',
      )
      .all(params) as OwnedRow[];

    const page = rows.slice(0, limit).map(toOwned);

    return {
      owned: page,
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Tudo de um jogador, vivas e vencidas. A ficha do painel. */
  listForPlayer(steamId: string): readonly OwnedSkin[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM workshop_owned_skins WHERE steam_id = ?
            ORDER BY (expires_at IS NULL) DESC, expires_at DESC, id DESC`,
        )
        .all(steamId) as OwnedRow[]
    ).map(toOwned);
  }

  /** As vivas de um jogador. É o que desce no `origemz.workshop.owned`. */
  liveOwnedForPlayer(steamId: string, now: number = Date.now()): readonly OwnedSkin[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM workshop_owned_skins
            WHERE steam_id = @steam_id AND (expires_at IS NULL OR expires_at > @now)
            ORDER BY skin_ref ASC`,
        )
        .all({ steam_id: steamId, now }) as OwnedRow[]
    ).map(toOwned);
  }

  /** Quantos donos VIVOS cada skin tem. A coluna "donos" do painel. */
  liveOwnerCounts(now: number = Date.now()): ReadonlyMap<number, number> {
    const rows = this.#db
      .prepare(
        `SELECT skin_ref, count(*) AS n FROM workshop_owned_skins
          WHERE expires_at IS NULL OR expires_at > ?
          GROUP BY skin_ref`,
      )
      .all(now) as { skin_ref: number; n: number }[];

    return new Map(rows.map((row) => [row.skin_ref, row.n]));
  }

  /**
   * O próximo prazo que vai vencer DEPOIS de `after`, se houver.
   *
   * É o relógio do serviço: ele dorme até lá, reenvia a posse de quem
   * venceu e registra.
   */
  nextExpiry(after: number): number | null {
    const row = this.#db
      .prepare(
        `SELECT min(expires_at) AS at FROM workshop_owned_skins
          WHERE expires_at IS NOT NULL AND expires_at > ?`,
      )
      .get(after) as { at: number | null };

    return row.at;
  }

  /** As que venceram na janela `(from, to]`. */
  expiredBetween(from: number, to: number): readonly OwnedSkin[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM workshop_owned_skins
            WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
            ORDER BY expires_at ASC, id ASC`,
        )
        .all(from, to) as OwnedRow[]
    ).map(toOwned);
  }

  // ======================================================
  //  POSSE — escrita
  // ======================================================

  /**
   * Dá a skin — ou mexe no prazo de quem já tinha. Ver `renewedExpiry`.
   *
   * `source`, `sourceRef` e a nota guardam a ÚLTIMA escrita. Quando a
   * linha antiga estava vencida, ela é tratada como nova: `createdBy`
   * e `createdAt` também são trocados.
   *
   * @throws ZodError quando a entrada não passa na régua.
   * @throws RangeError quando o prazo resultante já passou — gravar
   *         uma posse morta não libera nada, e quem chama deveria ter
   *         recusado antes com uma frase.
   */
  grantOwnership(input: GrantOwnershipInput, now: number = Date.now()): GrantOwnershipResult {
    const value = grantOwnershipInputSchema.parse(input);

    return this.#db.transaction((): GrantOwnershipResult => {
      const previous = this.find(value.steamId, value.skinRef);
      const live = previous !== null && isOwnedLive(previous, now);
      const expiresAt = renewedExpiry(previous, value, now);

      if (expiresAt !== null && expiresAt <= now) {
        throw new RangeError('o prazo pedido já passou: a posse nasceria vencida');
      }

      const params = {
        steam_id: value.steamId,
        skin_ref: value.skinRef,
        expires_at: expiresAt,
        source: value.source,
        source_ref: value.sourceRef ?? null,
        note: value.note,
        created_by: value.createdBy,
        now,
      };

      if (previous === null) {
        const result = this.#db
          .prepare(
            `INSERT INTO workshop_owned_skins
               (steam_id, skin_ref, expires_at, source, source_ref, note, created_by, created_at, updated_at)
             VALUES
               (@steam_id, @skin_ref, @expires_at, @source, @source_ref, @note, @created_by, @now, @now)`,
          )
          .run(params);

        return { owned: this.#mustGet(Number(result.lastInsertRowid)), created: true, previous: null };
      }

      if (live) {
        this.#db
          .prepare(
            `UPDATE workshop_owned_skins SET
               expires_at = @expires_at,
               source     = @source,
               source_ref = @source_ref,
               note       = COALESCE(@note, note),
               updated_at = @now
             WHERE id = @id`,
          )
          .run({ ...params, id: previous.id });
      } else {
        this.#db
          .prepare(
            `UPDATE workshop_owned_skins SET
               expires_at = @expires_at,
               source     = @source,
               source_ref = @source_ref,
               note       = @note,
               created_by = @created_by,
               created_at = @now,
               updated_at = @now
             WHERE id = @id`,
          )
          .run({ ...params, id: previous.id });
      }

      return { owned: this.#mustGet(previous.id), created: !live, previous };
    })();
  }

  /**
   * Tira a posse daquele par, QUALQUER que seja a origem dela.
   *
   * @returns a linha removida, ou `null` quando não havia nada — que
   *          não é erro: o estado pedido já vale (04 §3).
   */
  revokeOwnership(input: RevokeOwnershipInput): OwnedSkin | null {
    const value = revokeOwnershipInputSchema.parse(input);

    return this.#db.transaction((): OwnedSkin | null => {
      const current = this.find(value.steamId, value.skinRef);

      if (current === null) return null;

      this.#db.prepare('DELETE FROM workshop_owned_skins WHERE id = ?').run(current.id);

      return current;
    })();
  }

  /** Tira pelo id da linha. @returns a linha removida, ou `null`. */
  removeById(id: number): OwnedSkin | null {
    return this.#db.transaction((): OwnedSkin | null => {
      const current = this.get(id);

      if (current === null) return null;

      this.#db.prepare('DELETE FROM workshop_owned_skins WHERE id = ?').run(id);

      return current;
    })();
  }

  #mustGet(id: number): OwnedSkin {
    const owned = this.get(id);

    if (owned === null) throw new Error(`a posse ${String(id)} sumiu logo depois de ser gravada`);

    return owned;
  }

  // ======================================================
  //  A TEMPORADA — o que o wipe apaga
  // ======================================================

  /**
   * As posses de skins marcadas como "Skin de temporada".
   *
   * Vivas E vencidas: o wipe apaga a linha, e uma vencida que
   * sobrasse voltaria a valer se alguém a renovasse.
   */
  seasonOwned(): readonly OwnedSkin[] {
    return (
      this.#db
        .prepare(
          `SELECT o.* FROM workshop_owned_skins o
             JOIN workshop_skins s ON s.id = o.skin_ref
            WHERE s.season = 1
            ORDER BY o.id ASC`,
        )
        .all() as OwnedRow[]
    ).map(toOwned);
  }

  /**
   * Apaga TODAS as posses de skin de temporada, numa transação.
   *
   * @returns as linhas removidas, para quem chama saber a quem
   *          reenviar a posse. A contagem é o `length`.
   */
  deleteSeasonOwned(): readonly OwnedSkin[] {
    return this.#db.transaction((): readonly OwnedSkin[] => {
      const doomed = this.seasonOwned();

      if (doomed.length === 0) return [];

      this.#db.prepare(
        `DELETE FROM workshop_owned_skins
          WHERE skin_ref IN (SELECT id FROM workshop_skins WHERE season = 1)`,
      ).run();

      return doomed;
    })();
  }

  // ======================================================
  //  FAVORITAS (migração 100)
  // ======================================================

  /**
   * As favoritas do jogador, por `id` de skin, em ordem crescente.
   *
   * A ordem é a do `id` e não a da marcação: é assim que ela desce na
   * carga, e uma lista ordenada faz a digital de envio
   * (`JSON.stringify` do payload) só mudar quando o CONJUNTO muda.
   */
  listFavorites(steamId: string): readonly number[] {
    return (
      this.#db
        .prepare('SELECT skin_ref FROM workshop_favorites WHERE steam_id = ? ORDER BY skin_ref ASC')
        .all(steamId) as { skin_ref: number }[]
    ).map((row) => row.skin_ref);
  }

  isFavorite(steamId: string, skinRef: number): boolean {
    return (
      this.#db
        .prepare('SELECT 1 FROM workshop_favorites WHERE steam_id = ? AND skin_ref = ?')
        .get(steamId, skinRef) !== undefined
    );
  }

  countFavorites(steamId: string): number {
    return (
      this.#db.prepare('SELECT count(*) AS n FROM workshop_favorites WHERE steam_id = ?').get(steamId) as {
        n: number;
      }
    ).n;
  }

  /**
   * Põe a favorita no estado pedido.
   *
   * ####  É `on`, E NÃO "ALTERNE"  ####
   *
   * O plugin manda o estado que quer, porque o console repete linha em
   * reconexão: um "alterne" repetido desfaria o clique do jogador em
   * silêncio. Chamar duas vezes com o mesmo `on` é o mesmo que chamar
   * uma.
   *
   * @throws FavoritesFullError quando o jogador já está no teto e a
   *         favorita é NOVA. Desfavoritar nunca é recusado — senão
   *         quem bateu no teto não teria como sair dele.
   */
  setFavorite(
    steamId: string,
    skinRef: number,
    on: boolean,
    now: number = Date.now(),
  ): FavoriteResult {
    return this.#db.transaction((): FavoriteResult => {
      const before = this.isFavorite(steamId, skinRef);

      if (on === before) {
        return { on, changed: false, count: this.countFavorites(steamId) };
      }

      if (!on) {
        this.#db
          .prepare('DELETE FROM workshop_favorites WHERE steam_id = ? AND skin_ref = ?')
          .run(steamId, skinRef);

        return { on: false, changed: true, count: this.countFavorites(steamId) };
      }

      const count = this.countFavorites(steamId);

      if (count >= MAX_FAVORITES_PER_PLAYER) throw new FavoritesFullError(count);

      this.#db
        .prepare(
          `INSERT INTO workshop_favorites (steam_id, skin_ref, created_at)
           VALUES (@steam_id, @skin_ref, @now)`,
        )
        .run({ steam_id: steamId, skin_ref: skinRef, now });

      return { on: true, changed: true, count: count + 1 };
    })();
  }

  /**
   * Inverte a favorita e devolve o estado NOVO.
   *
   * É o que a tela chama quando ela só sabe "o jogador clicou na
   * estrela". O caminho do plugin usa `setFavorite`, que é idempotente
   * — ver o porquê lá.
   *
   * @throws FavoritesFullError quando o clique tentaria passar do teto.
   */
  toggleFavorite(steamId: string, skinRef: number, now: number = Date.now()): FavoriteResult {
    return this.#db.transaction((): FavoriteResult =>
      this.setFavorite(steamId, skinRef, !this.isFavorite(steamId, skinRef), now),
    )();
  }

  /** Tira a favorita. @returns `true` quando havia uma para tirar. */
  removeFavorite(steamId: string, skinRef: number): boolean {
    return (
      this.#db
        .prepare('DELETE FROM workshop_favorites WHERE steam_id = ? AND skin_ref = ?')
        .run(steamId, skinRef).changes > 0
    );
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
      params['steam_id'] = filter.steamId.trim();
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
