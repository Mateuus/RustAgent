// ============================================================
//  site-commands-repository.ts  -  o at-most-once do COMANDO.
//
//  ####  A LINHA NASCE ANTES DA OPERAÇÃO, NUNCA DEPOIS  ####
//
//  O caso que ela existe para matar: o agente puxa `CMD-…`, dispara
//  o `server-restart`, e cai junto com o servidor — antes do ACK. Ele
//  volta, o site não recebeu desfecho nenhum, e o que acontece com a
//  linha de lá é decisão do site. Se o comando voltar, o agente
//  precisa saber que JÁ EXECUTOU aquilo. Memória não serve: o
//  `pm2 restart` apaga.
//
//  ####  `indeterminate` NÃO RE-EXECUTA  ####
//
//  A linha órfã em `claimed` significa "a operação pode ter rodado".
//  Repetir um restart em cima de gente que acabou de entrar é o pior
//  desfecho possível, e é o que a regra 8 proíbe: comando puxado é
//  comando CONSUMIDO. Quem decide tentar de novo é o admin, no site,
//  gerando um `CMD-…` novo.
//
//  ####  O `leaseToken` É PARTE DO REGISTRO  ####
//
//  Sem ele não há como fechar a linha do site: um ACK sem token — ou
//  com um de uma reivindicação anterior — volta em `unknown` e não
//  muda nada lá. Guardá-lo é o que permite reenviar, minutos depois
//  e do outro lado de um restart, o desfecho que se perdeu.
//
//  Ver Docs\22-COMANDOS-E-CONFIG-DO-SITE.md §3, regras 1, 2, 7 e 8.
// ============================================================

import type { AgentDatabase } from './database.js';

/**
 * O estado da linha.
 *
 * ####  OS TERMINAIS TÊM OS NOMES DOS STATUS DO ACK  ####
 *
 * E é de propósito: um ACK que se perca é reenviado a partir DESTA
 * coluna. Um estado local que não fosse um status do contrato viraria
 * um segundo desfecho, diferente do primeiro — o site veria `failed`
 * onde o agente tinha dito `refused`.
 */
export type SiteCommandState =
  /** A operação vai começar, ou começou e não sabemos o fim. */
  | 'claimed'
  | 'executed'
  | 'failed'
  /** Nem começou: pré-condição, prazo ou trava. */
  | 'refused'
  /** O agente caiu no meio. NUNCA re-executa. */
  | 'indeterminate';

export interface SiteCommandRow {
  readonly id: string;
  /** O servidor LOCAL que executa. */
  readonly serverId: string;
  readonly kind: string;
  /** Os params como vieram do site, em JSON. */
  readonly params: string;
  readonly leaseToken: string;
  readonly state: SiteCommandState;
  /** O `reason` do contrato, nunca o código interno. */
  readonly reason: string | null;
  readonly operationId: string | null;
  readonly claimedAt: number;
  readonly ackedAt: number | null;
  readonly updatedAt: number;
}

interface CommandRow {
  readonly id: string;
  readonly server_id: string;
  readonly kind: string;
  readonly params: string;
  readonly lease_token: string;
  readonly state: string;
  readonly reason: string | null;
  readonly operation_id: string | null;
  readonly claimed_at: number;
  readonly acked_at: number | null;
  readonly updated_at: number;
}

export class SiteCommandsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  get(id: string): SiteCommandRow | null {
    const row = this.#db.prepare('SELECT * FROM site_commands WHERE id = @id').get({ id }) as
      | CommandRow
      | undefined;

    return row === undefined ? null : toCommand(row);
  }

  /**
   * Registra o comando ANTES de qualquer coisa acontecer.
   *
   * `false` = este id já foi visto, e o comando NÃO deve rodar de
   * novo. INSERT puro, e não `INSERT OR IGNORE`: quem decide a
   * corrida é a chave primária, e é dela que sai a resposta honesta
   * "já estava reivindicado". Um `OR IGNORE` esconderia a colisão —
   * e a colisão é justamente a informação que impede o segundo
   * restart.
   */
  claim(
    input: {
      readonly id: string;
      readonly serverId: string;
      readonly kind: string;
      readonly params: string;
      readonly leaseToken: string;
    },
    now = Date.now(),
  ): boolean {
    try {
      this.#db
        .prepare(
          `INSERT INTO site_commands
             (id, server_id, kind, params, lease_token, state, reason,
              operation_id, claimed_at, acked_at, updated_at)
           VALUES
             (@id, @serverId, @kind, @params, @leaseToken, 'claimed', NULL,
              NULL, @now, NULL, @now)`,
        )
        .run({ ...input, now });

      return true;
    } catch {
      return false;
    }
  }

  /** Grava o desfecho. O `reason` é o do CONTRATO, ou `null`. */
  finish(
    id: string,
    state: Exclude<SiteCommandState, 'claimed'>,
    input: { readonly reason?: string | null; readonly operationId?: string | null } = {},
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE site_commands
            SET state        = @state,
                reason       = @reason,
                operation_id = COALESCE(@operationId, operation_id),
                updated_at   = @now
          WHERE id = @id`,
      )
      .run({
        id,
        state,
        reason: input.reason ?? null,
        operationId: input.operationId ?? null,
        now,
      });
  }

  /**
   * Liga a linha à operação, assim que ela nasce.
   *
   * Ele é escrito ANTES do desfecho de propósito: um agente que caia
   * no meio do restart deixa a linha em `claimed` COM o
   * `operationId`, e é por ele que uma pessoa acha o log daquela
   * tentativa em `Logs\<servidor>\ops\`.
   */
  attachOperation(id: string, operationId: string, now = Date.now()): void {
    this.#db
      .prepare(
        'UPDATE site_commands SET operation_id = @operationId, updated_at = @now WHERE id = @id',
      )
      .run({ id, operationId, now });
  }

  /** O site confirmou o desfecho desta linha. */
  markAcked(id: string, now = Date.now()): void {
    this.#db
      .prepare('UPDATE site_commands SET acked_at = @now, updated_at = @now WHERE id = @id')
      .run({ id, now });
  }

  /**
   * As linhas em `claimed` daquele servidor, do boot para trás.
   *
   * ####  ELAS SÃO O RASTRO DE UMA QUEDA  ####
   *
   * Uma operação em curso não sobrevive ao processo: o registro de
   * operações é de MEMÓRIA. Então toda linha em `claimed` encontrada
   * na subida é um comando cujo fim ninguém sabe — e o certo é
   * carimbá-la `indeterminate`, para que ela nunca mais seja
   * confundida com trabalho por fazer.
   */
  listClaimed(serverId: string): readonly SiteCommandRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM site_commands
          WHERE server_id = @serverId AND state = 'claimed'
          ORDER BY claimed_at ASC`,
      )
      .all({ serverId }) as CommandRow[];

    return rows.map(toCommand);
  }

  /**
   * Os desfechos que o site ainda não confirmou, daquele servidor.
   *
   * O laço os reenvia no começo da rodada: um ACK perdido custa uma
   * volta de 10 s, e uma linha esquecida deixa o admin olhando
   * "executando" para um servidor que já voltou.
   *
   * `claimed` fica de fora: ela não tem desfecho para contar.
   */
  listUnacked(serverId: string, limit: number): readonly SiteCommandRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM site_commands
          WHERE server_id = @serverId AND acked_at IS NULL AND state <> 'claimed'
          ORDER BY updated_at ASC
          LIMIT @limit`,
      )
      .all({ serverId, limit }) as CommandRow[];

    return rows.map(toCommand);
  }

  countByState(state: SiteCommandState): number {
    const row = this.#db
      .prepare('SELECT count(*) AS value FROM site_commands WHERE state = @state')
      .get({ state }) as { readonly value: number } | undefined;

    return row?.value ?? 0;
  }
}

function toCommand(row: CommandRow): SiteCommandRow {
  return {
    id: row.id,
    serverId: row.server_id,
    kind: row.kind,
    params: row.params,
    leaseToken: row.lease_token,
    state: row.state as SiteCommandState,
    reason: row.reason,
    operationId: row.operation_id,
    claimedAt: row.claimed_at,
    ackedAt: row.acked_at,
    updatedAt: row.updated_at,
  };
}
