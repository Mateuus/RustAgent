// ============================================================
//  wipes-repository.ts  -  o histórico de MUNDOS detectados.
//
//  ####  ISTO NÃO É O QUE A EXECUÇÃO RELATOU  ####
//
//  É o que o servidor DIZ que aconteceu. O `WipeClock`
//  (game/wipe.ts) lê o `SaveCreatedTime` do `serverinfo`, que é a
//  hora em que o save nasceu; quando ela muda, um mundo novo
//  existe — tenha o agente mandado ou não.
//
//  Essa independência é o ponto. Uma execução que relata sucesso e
//  um `SaveCreatedTime` que não mudou é um wipe que NÃO aconteceu,
//  e é o único defeito desta fase que nenhuma quantidade de log da
//  própria execução pegaria: ela estaria relatando o que tentou
//  fazer, não o que aconteceu.
//
//  E ela pega também o caso sem execução nenhuma: um wipe feito à
//  mão com o agente parado, um servidor adotado já com mundo
//  antigo. Nesses casos `wipe_run_id` fica NULL, e a linha
//  continua valendo.
//
//  ------------------------------------------------------------
//  ####  ELE TAMBÉM RESPONDE À FILA DE MAPAS  ####
//
//  `map-pool-repository.ts` pergunta a esta tabela quais seeds
//  saíram nos últimos wipes, para não sortear a mesma duas vezes
//  seguidas (`recentSeeds`). As colunas `server_id`, `seed` e
//  `detected_at` são contrato com aquele arquivo.
// ============================================================

import type { AgentDatabase } from './database.js';

/** Um mundo que existiu naquele servidor. */
export interface WipeRecord {
  readonly id: number;
  readonly serverId: string;
  /** Epoch ms do `SaveCreatedTime`: quando o mundo nasceu. */
  readonly saveCreatedAt: number;
  readonly level: string | null;
  /** Texto, como em `map_pool.seed`: comparada e exibida, nunca somada. */
  readonly seed: string | null;
  readonly worldSize: number | null;
  /** Quando o AGENTE viu. Diferente de `saveCreatedAt` se ele estava parado. */
  readonly detectedAt: number;
  /** A execução que criou este mundo. `null` = apareceu sem o agente. */
  readonly wipeRunId: number | null;
}

export interface WipeInput {
  readonly saveCreatedAt: number;
  readonly level?: string | null;
  readonly seed?: string | null;
  readonly worldSize?: number | null;
  readonly wipeRunId?: number | null;
}

interface WipeRow {
  readonly id: number;
  readonly server_id: string;
  readonly save_created_at: number;
  readonly level: string | null;
  readonly seed: string | null;
  readonly world_size: number | null;
  readonly detected_at: number;
  readonly wipe_run_id: number | null;
}

const COLUMNS = `id, server_id, save_created_at, level, seed, world_size, detected_at, wipe_run_id`;

export class WipesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /**
   * Registra um mundo. Chamar duas vezes com o mesmo instante não
   * cria duas linhas.
   *
   * ####  A IDEMPOTÊNCIA É O PONTO, E NÃO UM DETALHE  ####
   *
   * Quem chama isto é o boot do agente e o fim de cada execução —
   * os dois olhando para o mesmo servidor. Sem o índice único de
   * `(server_id, save_created_at)`, cada `pm2 restart` gravaria o
   * mundo atual de novo, e "quantos wipes este servidor teve?"
   * viraria "quantas vezes o agente reiniciou?".
   *
   * Quando a linha já existe e chega um `wipeRunId`, ele é
   * PREENCHIDO: é o caso normal de o boot ter visto o mundo antes
   * de a execução terminar de se registrar.
   */
  record(serverId: string, input: WipeInput, now: number = Date.now()): WipeRecord {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO wipes (server_id, save_created_at, level, seed, world_size,
                                      detected_at, wipe_run_id)
              VALUES (@server_id, @save_created_at, @level, @seed, @world_size, @now, @run_id)`,
      )
      .run({
        server_id: serverId,
        save_created_at: input.saveCreatedAt,
        level: input.level ?? null,
        seed: input.seed ?? null,
        world_size: input.worldSize ?? null,
        now,
        run_id: input.wipeRunId ?? null,
      });

    if (input.wipeRunId !== undefined && input.wipeRunId !== null) {
      this.#db
        .prepare(
          `UPDATE wipes SET wipe_run_id = @run_id
            WHERE server_id = @server_id AND save_created_at = @save_created_at
              AND wipe_run_id IS NULL`,
        )
        .run({
          server_id: serverId,
          save_created_at: input.saveCreatedAt,
          run_id: input.wipeRunId,
        });
    }

    const row = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM wipes
          WHERE server_id = @server_id AND save_created_at = @save_created_at`,
      )
      .get({ server_id: serverId, save_created_at: input.saveCreatedAt }) as WipeRow | undefined;

    if (row === undefined) {
      throw new Error(
        `o mundo detectado do servidor "${serverId}" sumiu do banco entre a escrita e a leitura`,
      );
    }

    return toRecord(row);
  }

  /** Do mais novo para o mais velho. */
  list(serverId: string, limit = 20): readonly WipeRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM wipes
          WHERE server_id = @server_id
          ORDER BY detected_at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ server_id: serverId, limit }) as WipeRow[];

    return rows.map(toRecord);
  }

  /** O mundo em que o servidor está agora, pelo que o agente viu. */
  latest(serverId: string): WipeRecord | null {
    const row = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM wipes
          WHERE server_id = @server_id
          ORDER BY save_created_at DESC, id DESC
          LIMIT 1`,
      )
      .get({ server_id: serverId }) as WipeRow | undefined;

    return row === undefined ? null : toRecord(row);
  }
}

function toRecord(row: WipeRow): WipeRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    saveCreatedAt: row.save_created_at,
    level: row.level,
    // O SQLite devolve o que foi gravado, e uma seed gravada como
    // número por outra versão do agente voltaria como number. O
    // `String` aqui é o que mantém o tipo do contrato.
    seed: row.seed === null ? null : String(row.seed),
    worldSize: row.world_size,
    detectedAt: row.detected_at,
    wipeRunId: row.wipe_run_id,
  };
}
