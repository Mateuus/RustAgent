// ============================================================
//  spawn-status-repository.ts  -  com quanta vida, fome e sede
//  cada GRUPO nasce.
//
//  Irmão do `loadouts-repository.ts`, e vale dizer no que difere —
//  é o que justifica uma tabela e um arquivo separados:
//
//    - o loadout é o que o jogador GANHA (itens no inventário);
//      isto é o ESTADO em que ele acorda (as três barras);
//    - o jogo os trata como duas coisas: um viaja no
//      `origemz.loadout.sync`, o outro no `origemz.status.sync`, e
//      cada comando troca o SEU cache;
//    - um grupo pode ter status sem kit, e kit sem status.
//
//  O que é IGUAL, e de propósito: a lista de grupos é DERIVADA do
//  Oxide daquele servidor (aqui só mora o conteúdo), gravar
//  substitui a linha inteira, e desligar não é apagar.
//
//  ------------------------------------------------------------
//  ####  NULL É "O JOGO DECIDE"  ####
//
//  E não zero. Zero de fome é nascer morrendo; `null` é não
//  encostar naquele atributo. O plugin trata os dois como coisas
//  diferentes (`float?` no `SpawnStatusPayload`), e o tipo daqui
//  até lá precisa carregar essa diferença — por isso `number |
//  null`, e nunca um `number` com 0 fazendo as vezes de vazio.
//
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Empurrar `origemz.status.sync` é trabalho de loadouts/status.ts.
//  Aqui só entra e sai linha.
// ============================================================

import type { AgentDatabase } from './database.js';

/**
 * Os três atributos, como o plugin os espera.
 *
 * `null` em qualquer um = o jogo decide aquele. Os três nulos
 * juntos são o mesmo que não haver configuração — e é assim que o
 * `origemz.status.sync` descarta a entrada.
 */
export interface SpawnStatusValues {
  /** Vida ao nascer. O padrão do Rust é 100. */
  readonly health: number | null;
  /** Comida. O máximo padrão do Rust é 500. */
  readonly calories: number | null;
  /** Água. O máximo padrão do Rust é 250. */
  readonly hydration: number | null;
}

export interface SpawnStatusRecord extends SpawnStatusValues {
  readonly id: number;
  readonly serverId: string;
  /** O NOME DO GRUPO do Oxide. Ver o cabeçalho da migração 022. */
  readonly groupName: string;
  /**
   * Desligado é diferente de apagado.
   *
   * O status continua guardado e some do payload empurrado ao jogo:
   * quem nasce nesse grupo volta ao padrão do Rust sem ninguém
   * perder o que configurou.
   */
  readonly enabled: boolean;
  /** Epoch ms. */
  readonly updatedAt: number;
  readonly updatedBy: string | null;
}

export interface SaveSpawnStatusInput extends SpawnStatusValues {
  readonly serverId: string;
  readonly groupName: string;
  readonly enabled: boolean;
  readonly updatedBy: string | null;
}

interface SpawnStatusRow {
  readonly id: number;
  readonly server_id: string;
  readonly group_name: string;
  readonly health: number | null;
  readonly calories: number | null;
  readonly hydration: number | null;
  readonly enabled: number;
  readonly updated_at: number;
  readonly updated_by: string | null;
}

/** Tem alguma coisa a aplicar? Três nulos = não. */
export function hasAnyAttribute(values: SpawnStatusValues): boolean {
  return values.health !== null || values.calories !== null || values.hydration !== null;
}

export class SpawnStatusRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /** Todos os status daquele servidor, por nome de grupo. */
  list(serverId: string): readonly SpawnStatusRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM spawn_status WHERE server_id = @server_id ORDER BY group_name ASC')
      .all({ server_id: serverId }) as SpawnStatusRow[];

    return rows.map(toRecord);
  }

  get(serverId: string, groupName: string): SpawnStatusRecord | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM spawn_status WHERE server_id = @server_id AND group_name = @group_name',
      )
      .get({ server_id: serverId, group_name: groupName }) as SpawnStatusRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * O que vai para o jogo: só os LIGADOS e com algum atributo.
   *
   * Grupo com os três nulos não entra no payload — o plugin o
   * descartaria de qualquer jeito, e mandá-lo só gastaria bytes num
   * comando que tem teto de tamanho.
   */
  enabled(serverId: string): readonly SpawnStatusRecord[] {
    return this.list(serverId).filter((status) => status.enabled && hasAnyAttribute(status));
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Grava o status daquele grupo, criando a linha se preciso.
   *
   * Upsert pela chave natural `(server_id, group_name)`, pelo mesmo
   * motivo do loadout: a tela conhece o grupo, não o `id`.
   */
  save(input: SaveSpawnStatusInput, now: number = Date.now()): SpawnStatusRecord {
    this.#db
      .prepare(
        `INSERT INTO spawn_status
              (server_id, group_name, health, calories, hydration, enabled, updated_at, updated_by)
              VALUES
              (@server_id, @group_name, @health, @calories, @hydration, @enabled, @updated_at,
               @updated_by)
         ON CONFLICT (server_id, group_name) DO UPDATE SET
              health     = @health,
              calories   = @calories,
              hydration  = @hydration,
              enabled    = @enabled,
              updated_at = @updated_at,
              updated_by = @updated_by`,
      )
      .run({
        server_id: input.serverId,
        group_name: input.groupName,
        health: input.health,
        calories: input.calories,
        hydration: input.hydration,
        // 0/1: o better-sqlite3 recusa boolean como parâmetro.
        enabled: input.enabled ? 1 : 0,
        updated_at: now,
        updated_by: input.updatedBy,
      });

    const saved = this.get(input.serverId, input.groupName);

    if (saved === null) {
      throw new Error(
        `o status de "${input.groupName}" em ${input.serverId} sumiu logo depois de ser gravado`,
      );
    }

    return saved;
  }

  /**
   * Apaga o status daquele grupo.
   *
   * Como no loadout, apagar é apagar mesmo — e a remoção CHEGA ao
   * jogo porque o payload seguinte é o estado completo: o grupo não
   * estará nele, e quem nascer ali volta ao padrão do Rust.
   *
   * @returns `false` quando não havia o que apagar.
   */
  remove(serverId: string, groupName: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM spawn_status WHERE server_id = @server_id AND group_name = @group_name')
      .run({ server_id: serverId, group_name: groupName });

    return result.changes > 0;
  }
}

function toRecord(row: SpawnStatusRow): SpawnStatusRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    groupName: row.group_name,
    health: row.health,
    calories: row.calories,
    hydration: row.hydration,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
