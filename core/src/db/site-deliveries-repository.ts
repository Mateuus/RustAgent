// ============================================================
//  site-deliveries-repository.ts  -  a idempotência da ENTREGA.
//
//  ####  A RESERVA ACONTECE ANTES DO COMANDO, NUNCA DEPOIS  ####
//
//  Um agente que caia entre o `origemz.give` e o ACK reencontra a
//  tarefa na próxima página do site. Sem a reserva, ele entregaria
//  de novo — item duplicado, uma cobrança. Com ela, a linha órfã em
//  `reserved` diz "o comando pode ter saído" e a tarefa vai para
//  conferência humana em vez de ser reexecutada.
//
//  ####  `indeterminate` NÃO REEXECUTA — E ACKA `deferred`  ####
//
//  Reexecutar entrega duas vezes; ACKar `failed` devolve ao site um
//  item que talvez esteja no chão do jogador. Mas NÃO ACKar também
//  não serve: a tarefa fica `pending` no site e a varredura de
//  expiração a devolve ao inventário em 30 dias, sozinha, sem saber
//  o que só nós sabemos.
//
//  Então ele ACKa `deferred` com `reason: 'AGENT_INDETERMINATE'`: o
//  site move a tarefa de `pending` para `review`, o item FICA em
//  `processing`, e a expiração não a alcança. Na dúvida, PRESERVA —
//  e preservar, aqui, é falar.
//
//  ####  O NOME É `indeterminate` PORQUE `review` É DO SITE  ####
//
//  Lá, `review` é o estado para onde o site move a tarefa ao ler
//  esse `reason` — mesmo sentido, banco diferente, contagem
//  diferente. Duas telas mostram as duas contagens lado a lado, e
//  com o mesmo nome alguém concluiria que uma está errada. O FIO não
//  carrega nenhum dos dois nomes: carrega `deferred`.
// ============================================================

import type { AgentDatabase } from './database.js';

export type SiteDeliveryState =
  | 'reserved'
  | 'delivered'
  | 'failed'
  /** O agente caiu no meio. ACKa `deferred`/`AGENT_INDETERMINATE`. */
  | 'indeterminate'
  /** O site devolveu o id em `unknown` e a linha NÃO era terminal. */
  | 'expired';

export type SiteDeliveryKind = 'item' | 'kit' | 'vip' | 'vehicle';

export interface SiteDeliveryRow {
  readonly id: string;
  /** O servidor LOCAL que recebe. */
  readonly serverId: string;
  readonly steamId: string;
  readonly kind: SiteDeliveryKind;
  /** O payload como veio do site, em JSON, depois de validado. */
  readonly payload: string;
  readonly sourceRef: string | null;
  readonly state: SiteDeliveryState;
  readonly reason: string | null;
  readonly attempts: number;
  readonly ackedAt: number | null;
  readonly reservedAt: number;
  readonly updatedAt: number;
}

interface DeliveryRow {
  readonly id: string;
  readonly server_id: string;
  readonly steam_id: string;
  readonly kind: string;
  readonly payload: string;
  readonly source_ref: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly attempts: number;
  readonly acked_at: number | null;
  readonly reserved_at: number;
  readonly updated_at: number;
}

export class SiteDeliveriesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  get(id: string): SiteDeliveryRow | null {
    const row = this.#db.prepare('SELECT * FROM site_deliveries WHERE id = @id').get({ id }) as
      | DeliveryRow
      | undefined;

    return row === undefined ? null : toDelivery(row);
  }

  /**
   * Reserva a tarefa. `false` = alguém já reservou.
   *
   * INSERT puro, e não `INSERT OR IGNORE`: quem decide a corrida é a
   * chave primária, e é dela que sai a resposta honesta "já estava
   * reservada". Um `OR IGNORE` esconderia a colisão, e a colisão é
   * justamente a informação que impede a entrega dupla.
   */
  reserve(
    input: {
      readonly id: string;
      readonly serverId: string;
      readonly steamId: string;
      readonly kind: SiteDeliveryKind;
      readonly payload: string;
      readonly sourceRef: string | null;
    },
    now = Date.now(),
  ): boolean {
    try {
      this.#db
        .prepare(
          `INSERT INTO site_deliveries
             (id, server_id, steam_id, kind, payload, source_ref, state, reason,
              attempts, reserved_at, acked_at, updated_at)
           VALUES
             (@id, @serverId, @steamId, @kind, @payload, @sourceRef, 'reserved', NULL,
              0, @now, NULL, @now)`,
        )
        .run({ ...input, now });

      return true;
    } catch {
      return false;
    }
  }

  /** Grava o desfecho. O `reason` é o código CRU, nunca a frase. */
  finish(id: string, state: SiteDeliveryState, reason: string | null, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE site_deliveries
            SET state = @state, reason = @reason, attempts = attempts + 1, updated_at = @now
          WHERE id = @id`,
      )
      .run({ id, state, reason, now });
  }

  /**
   * A tarefa foi tentada e o comando disse NÃO DEU — solta a
   * reserva para a próxima rodada tentar de novo, limpo.
   *
   * ####  RESPOSTA NÃO É DÚVIDA  ####
   *
   * `PLAYER_DEAD` e `INVENTORY_FULL` são o plugin dizendo que NADA
   * saiu: repetir é seguro. A linha órfã em `reserved` significa
   * outra coisa — o processo morreu SEM resposta —, e deixá-la
   * aqui faria a rodada seguinte ler um adiamento normal como
   * "pode ter saído" e mandar a tarefa para conferência humana.
   */
  release(id: string): void {
    this.#db.prepare("DELETE FROM site_deliveries WHERE id = @id AND state = 'reserved'").run({ id });
  }

  /** O site confirmou o desfecho desta linha. */
  markAcked(id: string, now = Date.now()): void {
    this.#db
      .prepare('UPDATE site_deliveries SET acked_at = @now, updated_at = @now WHERE id = @id')
      .run({ id, now });
  }

  countByState(state: SiteDeliveryState): number {
    const row = this.#db
      .prepare('SELECT count(*) AS value FROM site_deliveries WHERE state = @state')
      .get({ state }) as { readonly value: number } | undefined;

    return row?.value ?? 0;
  }

  /**
   * Os ids que o site devolveu em `unknown` no ACK.
   *
   * ####  `unknown` NÃO SIGNIFICA "NÃO ACONTECEU"  ####
   *
   * Um `delivered` reACKado volta ali, porque o site põe em
   * `unknown` toda tarefa que já saiu de `pending`. Apagar a linha
   * no primeiro reACK jogaria fora justamente o comprovante que esta
   * tabela existe para guardar — a resposta de "o site diz que
   * entregou; entregou mesmo?", meses depois.
   *
   *   reserved / indeterminate -> vira `expired`, e sai do caminho
   *   delivered / failed       -> só `acked_at`. A LINHA FICA
   */
  settleUnknown(ids: readonly string[], now = Date.now()): void {
    if (ids.length === 0) {
      return;
    }

    const expire = this.#db.prepare(
      `UPDATE site_deliveries
          SET state = 'expired', updated_at = @now
        WHERE id = @id AND state IN ('reserved', 'indeterminate')`,
    );
    const keep = this.#db.prepare(
      `UPDATE site_deliveries
          SET acked_at = @now, updated_at = @now
        WHERE id = @id AND state IN ('delivered', 'failed')`,
    );

    const apply = this.#db.transaction((batch: readonly string[]) => {
      for (const id of batch) {
        expire.run({ id, now });
        keep.run({ id, now });
      }
    });

    apply(ids);
  }

  /**
   * As linhas que o site ainda não confirmou.
   *
   * O laço as reenvia: um ACK perdido custa uma volta de 15 s, e uma
   * linha esquecida custa o comprovante da entrega.
   */
  listUnacked(limit: number): readonly SiteDeliveryRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM site_deliveries
          WHERE acked_at IS NULL AND state <> 'reserved'
          ORDER BY updated_at ASC
          LIMIT @limit`,
      )
      .all({ limit }) as DeliveryRow[];

    return rows.map(toDelivery);
  }
}

function toDelivery(row: DeliveryRow): SiteDeliveryRow {
  return {
    id: row.id,
    serverId: row.server_id,
    steamId: row.steam_id,
    kind: row.kind as SiteDeliveryKind,
    payload: row.payload,
    sourceRef: row.source_ref,
    state: row.state as SiteDeliveryState,
    reason: row.reason,
    attempts: row.attempts,
    ackedAt: row.acked_at,
    reservedAt: row.reserved_at,
    updatedAt: row.updated_at,
  };
}
