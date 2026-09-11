// ============================================================
//  player-timers-repository.ts  -  quão RÁPIDO as coisas andam
//  para cada GRUPO: fornalha, craft, pesquisa e reciclador.
//
//  Terceiro irmão do `loadouts-repository.ts` e do
//  `spawn-status-repository.ts`, e com o mesmo desenho: a lista de
//  grupos é DERIVADA do Oxide daquele servidor (aqui só mora o
//  conteúdo), gravar substitui a linha inteira, e desligar não é
//  apagar.
//
//  ------------------------------------------------------------
//  ####  CADA TIMER É UM MULTIPLICADOR DE VELOCIDADE  ####
//
//  ×2 é duas vezes mais rápido — metade do tempo. ×1 é o jogo, e o
//  mínimo: o plugin não desacelera nada (ver o cabeçalho da seção
//  OS TIMERS, no OrigemZPlayer.cs).
//
//  ####  NULL É "ESTE GRUPO NÃO DECIDE ESTE TIMER"  ####
//
//  E não ×1. O plugin resolve campo a campo — admin, depois o VIP,
//  depois o normal —, e o primeiro que DEFINE o timer ganha. Por isso
//  o tipo é `number | null` e o 1 não faz as vezes de vazio: um VIP
//  com ×1 gravado perderia o ×2 que o `default` dá a todo mundo.
//
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Empurrar o `origemz.timers.sync` é trabalho de loadouts/timers.ts.
//  Aqui só entra e sai linha.
// ============================================================

import type { AgentDatabase } from './database.js';

/** Os quatro timers, como o plugin os espera. `null` = o grupo não decide. */
export interface PlayerTimersValues {
  /** Fornalha, fornalha grande, elétrica e refinaria. */
  readonly smelt: number | null;
  /** A fila de fabricação do jogador. */
  readonly craft: number | null;
  /** A mesa de pesquisa. */
  readonly research: number | null;
  /** O reciclador. */
  readonly recycle: number | null;
}

export interface PlayerTimersRecord extends PlayerTimersValues {
  readonly id: number;
  readonly serverId: string;
  /** O NOME DO GRUPO do Oxide. Ver o cabeçalho da migração 074. */
  readonly groupName: string;
  /**
   * Desligado é diferente de apagado: os timers continuam guardados e
   * somem do payload empurrado ao jogo.
   */
  readonly enabled: boolean;
  /** Epoch ms. */
  readonly updatedAt: number;
  readonly updatedBy: string | null;
}

export interface SavePlayerTimersInput extends PlayerTimersValues {
  readonly serverId: string;
  readonly groupName: string;
  readonly enabled: boolean;
  readonly updatedBy: string | null;
}

interface PlayerTimersRow {
  readonly id: number;
  readonly server_id: string;
  readonly group_name: string;
  readonly smelt_speed: number | null;
  readonly craft_speed: number | null;
  readonly research_speed: number | null;
  readonly recycle_speed: number | null;
  readonly enabled: number;
  readonly updated_at: number;
  readonly updated_by: string | null;
}

/** Tem algum timer a aplicar? Quatro nulos = não. */
export function hasAnyTimer(values: PlayerTimersValues): boolean {
  return (
    values.smelt !== null ||
    values.craft !== null ||
    values.research !== null ||
    values.recycle !== null
  );
}

export class PlayerTimersRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /** Todos os timers daquele servidor, por nome de grupo. */
  list(serverId: string): readonly PlayerTimersRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM player_timers WHERE server_id = @server_id ORDER BY group_name ASC')
      .all({ server_id: serverId }) as PlayerTimersRow[];

    return rows.map(toRecord);
  }

  get(serverId: string, groupName: string): PlayerTimersRecord | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM player_timers WHERE server_id = @server_id AND group_name = @group_name',
      )
      .get({ server_id: serverId, group_name: groupName }) as PlayerTimersRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * O que vai para o jogo: só os LIGADOS e com algum timer.
   *
   * Grupo com os quatro nulos não entra no payload — o plugin o
   * descartaria de qualquer jeito, e mandá-lo só gastaria bytes num
   * comando que tem teto de tamanho.
   */
  enabled(serverId: string): readonly PlayerTimersRecord[] {
    return this.list(serverId).filter((timers) => timers.enabled && hasAnyTimer(timers));
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Grava os timers daquele grupo, criando a linha se preciso.
   *
   * Upsert pela chave natural `(server_id, group_name)`, pelo mesmo
   * motivo do loadout: a tela conhece o grupo, não o `id`.
   */
  save(input: SavePlayerTimersInput, now: number = Date.now()): PlayerTimersRecord {
    this.#db
      .prepare(
        `INSERT INTO player_timers
              (server_id, group_name, smelt_speed, craft_speed, research_speed, recycle_speed,
               enabled, updated_at, updated_by)
              VALUES
              (@server_id, @group_name, @smelt_speed, @craft_speed, @research_speed,
               @recycle_speed, @enabled, @updated_at, @updated_by)
         ON CONFLICT (server_id, group_name) DO UPDATE SET
              smelt_speed    = @smelt_speed,
              craft_speed    = @craft_speed,
              research_speed = @research_speed,
              recycle_speed  = @recycle_speed,
              enabled        = @enabled,
              updated_at     = @updated_at,
              updated_by     = @updated_by`,
      )
      .run({
        server_id: input.serverId,
        group_name: input.groupName,
        smelt_speed: input.smelt,
        craft_speed: input.craft,
        research_speed: input.research,
        recycle_speed: input.recycle,
        // 0/1: o better-sqlite3 recusa boolean como parâmetro.
        enabled: input.enabled ? 1 : 0,
        updated_at: now,
        updated_by: input.updatedBy,
      });

    const saved = this.get(input.serverId, input.groupName);

    if (saved === null) {
      throw new Error(
        `os timers de "${input.groupName}" em ${input.serverId} sumiram logo depois de gravados`,
      );
    }

    return saved;
  }

  /**
   * Apaga os timers daquele grupo.
   *
   * A remoção CHEGA ao jogo porque o payload seguinte é o estado
   * completo: o grupo não estará nele, e quem é daquele nível cai
   * para o nível de baixo.
   *
   * @returns `false` quando não havia o que apagar.
   */
  remove(serverId: string, groupName: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM player_timers WHERE server_id = @server_id AND group_name = @group_name')
      .run({ server_id: serverId, group_name: groupName });

    return result.changes > 0;
  }
}

function toRecord(row: PlayerTimersRow): PlayerTimersRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    groupName: row.group_name,
    smelt: row.smelt_speed,
    craft: row.craft_speed,
    research: row.research_speed,
    recycle: row.recycle_speed,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
