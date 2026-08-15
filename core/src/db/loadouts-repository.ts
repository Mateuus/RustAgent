// ============================================================
//  loadouts-repository.ts  -  o que cada GRUPO recebe ao nascer.
//
//  ####  ESTA TABELA NÃO É A LISTA DE LOADOUTS  ####
//
//  A lista é DERIVADA dos grupos do Oxide daquele servidor
//  (`oxide.show groups`, por oxide/permissions.ts): grupo novo
//  aparece na tela vazio, e um loadout que perdeu o grupo aparece
//  como órfão. Aqui só mora o CONTEÚDO de cada um — quem cruza as
//  duas coisas é http/routes/loadouts.ts.
//
//  A alternativa (uma lista própria de níveis) envelheceria em
//  silêncio: o grupo criado hoje nasceria sem lugar na tela, e
//  ninguém saberia por quê.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Empurrar `origemz.loadout.sync` é trabalho de loadouts/sync.ts.
//  Aqui só entra e sai linha.
//
//  ####  GRAVAR SUBSTITUI O CONJUNTO INTEIRO  ####
//
//  Isto é CONFIGURAÇÃO, não histórico: a tela manda o kit completo
//  a cada edição, e reconciliar item a item só criaria a chance de
//  sobrar no banco um item que alguém tirou da tela. Lista vazia é
//  uma edição válida — é como se zera um loadout sem apagá-lo.
// ============================================================

import {
  parseLoadoutItems,
  serializeLoadoutItems,
  sortLoadoutItems,
  type LoadoutItem,
} from '../loadouts/items.js';
import type { AgentDatabase } from './database.js';

export interface LoadoutRecord {
  readonly id: number;
  readonly serverId: string;
  /** O NOME DO GRUPO do Oxide. Ver o cabeçalho da migração 011. */
  readonly groupName: string;
  readonly items: readonly LoadoutItem[];
  /**
   * Desligado é diferente de apagado.
   *
   * O loadout continua guardado e some do payload empurrado ao
   * jogo. É o "tira do ar sem perder meia hora de montagem" — e é
   * por isso que ele não é um `DELETE` disfarçado.
   */
  readonly enabled: boolean;
  /** Epoch ms. */
  readonly updatedAt: number;
  readonly updatedBy: string | null;
}

export interface SaveLoadoutInput {
  readonly serverId: string;
  readonly groupName: string;
  readonly items: readonly LoadoutItem[];
  readonly enabled: boolean;
  readonly updatedBy: string | null;
}

interface LoadoutRow {
  readonly id: number;
  readonly server_id: string;
  readonly group_name: string;
  readonly items: string;
  readonly enabled: number;
  readonly updated_at: number;
  readonly updated_by: string | null;
}

export class LoadoutsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /** Todos os loadouts daquele servidor, por nome de grupo. */
  list(serverId: string): readonly LoadoutRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM loadouts WHERE server_id = @server_id ORDER BY group_name ASC')
      .all({ server_id: serverId }) as LoadoutRow[];

    return rows.map(toRecord);
  }

  get(serverId: string, groupName: string): LoadoutRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM loadouts WHERE server_id = @server_id AND group_name = @group_name')
      .get({ server_id: serverId, group_name: groupName }) as LoadoutRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * O que vai para o jogo: só os LIGADOS e com item dentro.
   *
   * Grupo sem item não entra no payload — ausência é como "sem kit"
   * viaja, e uma lista vazia diria a mesma coisa ocupando espaço num
   * comando que tem teto de tamanho.
   */
  enabled(serverId: string): readonly LoadoutRecord[] {
    return this.list(serverId).filter((loadout) => loadout.enabled && loadout.items.length > 0);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Grava o loadout daquele grupo, criando a linha se preciso.
   *
   * Upsert pela chave natural `(server_id, group_name)`: a tela não
   * conhece o `id`, ela conhece o grupo — e um `SELECT` antes do
   * `INSERT` deixaria a janela em que duas gravações simultâneas
   * criam duas linhas (que o `UNIQUE` recusaria com um 500).
   */
  save(input: SaveLoadoutInput, now: number = Date.now()): LoadoutRecord {
    this.#db
      .prepare(
        `INSERT INTO loadouts (server_id, group_name, items, enabled, updated_at, updated_by)
              VALUES (@server_id, @group_name, @items, @enabled, @updated_at, @updated_by)
         ON CONFLICT (server_id, group_name) DO UPDATE SET
              items      = @items,
              enabled    = @enabled,
              updated_at = @updated_at,
              updated_by = @updated_by`,
      )
      .run({
        server_id: input.serverId,
        group_name: input.groupName,
        items: serializeLoadoutItems(sortLoadoutItems(input.items)),
        // 0/1: o better-sqlite3 recusa boolean como parâmetro.
        enabled: input.enabled ? 1 : 0,
        updated_at: now,
        updated_by: input.updatedBy,
      });

    const saved = this.get(input.serverId, input.groupName);

    if (saved === null) {
      throw new Error(
        `o loadout de "${input.groupName}" em ${input.serverId} sumiu logo depois de ser gravado`,
      );
    }

    return saved;
  }

  /**
   * Apaga o loadout daquele grupo.
   *
   * ####  AQUI APAGAR É APAGAR MESMO  ####
   *
   * Diferente do VIP e do claim, que guardam história: isto é
   * configuração, e o histórico dela seria uma tabela de versões
   * que ninguém pediu. O que o `DELETE` precisa garantir é que a
   * remoção CHEGUE AO JOGO — e chega, porque o payload seguinte é o
   * estado completo, e o grupo simplesmente não estará nele.
   *
   * @returns `false` quando não havia o que apagar.
   */
  remove(serverId: string, groupName: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM loadouts WHERE server_id = @server_id AND group_name = @group_name')
      .run({ server_id: serverId, group_name: groupName });

    return result.changes > 0;
  }
}

function toRecord(row: LoadoutRow): LoadoutRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    groupName: row.group_name,
    items: parseLoadoutItems(row.items),
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
