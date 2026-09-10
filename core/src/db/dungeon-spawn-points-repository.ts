// ============================================================
//  dungeon-spawn-points-repository.ts  -  onde a masmorra nasce.
//
//  ####  NÃO CONFUNDIR COM AS world_event_zones  ####
//
//  Aquelas dizem onde NADA pode nascer. Estas dizem o contrário:
//  são os lugares que o admin escolheu olhando o mapa — "aquela
//  encosta com vista, longe das bases e perto da estrada" —, e é
//  entre eles que o botão de erguer e o agendador sorteiam.
//
//  Pedido do dono em 09/09/2026: "o admin pode definir posições
//  que ela vai spawn, que ele determina e já sabe".
//
//  ####  UM PONTO É DE UM MAPA  ####
//
//  `worldKey` é `"<worldSize>:<seed>"`. Trocado o mapa, aquele x/z
//  é outro lugar: a encosta virou fundo de lago, e uma masmorra
//  que nasce lá afoga quem descer pelo alçapão.
//
//  Os pontos não somem no wipe — apagar sozinho é o tipo de coisa
//  que ninguém relaciona com o botão que apertou. Eles ficam, e
//  `staleFor()` responde quais são de outro mundo. A tela cobra a
//  revalidação, que custa um clique.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §4.
// ============================================================

import { z } from 'zod';

import type { AgentDatabase } from './database.js';

/**
 * O que o painel manda ao criar ou editar um ponto.
 *
 * `x` e `z` não têm limite aqui: o mundo do Rust vai de `-size/2`
 * a `+size/2`, e o `size` é do servidor, não do schema. Um ponto
 * fora do mundo é recusado pelo servidor na hora de conferir o
 * chão — e é ele quem sabe.
 */
export const spawnPointInputSchema = z.object({
  label: z.string().trim().max(60).default(''),
  x: z.number().finite(),
  z: z.number().finite(),
  /** Para onde a masmorra cresce, em graus. Zero é o norte. */
  yaw: z.number().finite().default(0),
  enabled: z.boolean().default(true),
});

export type SpawnPointInput = z.infer<typeof spawnPointInputSchema>;

/** O que o servidor respondeu sobre aquele chão. */
export interface SpawnPointGround {
  /** A grade do mapa: 'E7'. É o que gente lê. */
  readonly grid: string | null;
  /** Metros de água sobre o chão. Zero é terra. */
  readonly waterDepth: number | null;
  /** Quando alguém perguntou. `null` = ninguém perguntou ainda. */
  readonly checkedAt: number | null;
}

export interface SpawnPoint extends SpawnPointGround {
  readonly id: number;
  readonly serverId: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly enabled: boolean;
  /** `"<worldSize>:<seed>"` do mundo em que ele foi marcado. */
  readonly worldKey: string | null;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface Row {
  readonly id: number;
  readonly server_id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly enabled: number;
  readonly world_key: string | null;
  readonly grid: string | null;
  readonly water_depth: number | null;
  readonly checked_at: number | null;
  readonly last_used_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export class DungeonSpawnPointsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  list(serverId: string): readonly SpawnPoint[] {
    const rows = this.#db
      .prepare('SELECT * FROM dungeon_spawn_points WHERE server_id = ? ORDER BY id')
      .all(serverId) as Row[];

    return rows.map(toPoint);
  }

  get(serverId: string, id: number): SpawnPoint | null {
    const row = this.#db
      .prepare('SELECT * FROM dungeon_spawn_points WHERE server_id = ? AND id = ?')
      .get(serverId, id) as Row | undefined;

    return row === undefined ? null : toPoint(row);
  }

  /**
   * Os pontos que servem para sortear AGORA.
   *
   * Ligados, e do mundo que está carregado. Um ponto de outro mapa
   * fica de fora sem ser apagado: ele volta a valer se o admin
   * revalidá-lo, e some da conta enquanto não.
   */
  usable(serverId: string, worldKey: string | null): readonly SpawnPoint[] {
    return this.list(serverId).filter(
      (point) =>
        point.enabled && (worldKey === null || point.worldKey === null || point.worldKey === worldKey),
    );
  }

  add(
    serverId: string,
    input: SpawnPointInput,
    context: { readonly worldKey?: string | null; readonly ground?: SpawnPointGround } = {},
    now: number = Date.now(),
  ): SpawnPoint {
    const ground = context.ground ?? { grid: null, waterDepth: null, checkedAt: null };

    const result = this.#db
      .prepare(
        `INSERT INTO dungeon_spawn_points
              (server_id, label, x, z, yaw, enabled, world_key,
               grid, water_depth, checked_at, created_at, updated_at)
            VALUES (@serverId, @label, @x, @z, @yaw, @enabled, @worldKey,
                    @grid, @waterDepth, @checkedAt, @now, @now)`,
      )
      .run({
        serverId,
        label: input.label,
        x: input.x,
        z: input.z,
        yaw: input.yaw,
        enabled: input.enabled ? 1 : 0,
        worldKey: context.worldKey ?? null,
        grid: ground.grid,
        waterDepth: ground.waterDepth,
        checkedAt: ground.checkedAt,
        now,
      });

    const point = this.get(serverId, Number(result.lastInsertRowid));

    if (point === null) throw new Error('o ponto sumiu entre a escrita e a leitura');

    return point;
  }

  /**
   * Reescreve um ponto.
   *
   * ####  MEXER NO x/z APAGA O QUE O SERVIDOR TINHA DITO  ####
   *
   * `grid` e `waterDepth` são a resposta sobre AQUELE chão. Movido
   * o ponto, eles passam a descrever um lugar que ninguém escolheu
   * — e um "serve" herdado é pior que um "não sei", porque ninguém
   * o questiona.
   */
  update(
    serverId: string,
    id: number,
    input: SpawnPointInput,
    context: { readonly worldKey?: string | null; readonly ground?: SpawnPointGround } = {},
    now: number = Date.now(),
  ): SpawnPoint | null {
    const current = this.get(serverId, id);

    if (current === null) return null;

    const moved = current.x !== input.x || current.z !== input.z;

    const ground =
      context.ground ??
      (moved ? { grid: null, waterDepth: null, checkedAt: null } : current);

    this.#db
      .prepare(
        `UPDATE dungeon_spawn_points
              SET label = @label, x = @x, z = @z, yaw = @yaw, enabled = @enabled,
                  world_key = @worldKey, grid = @grid, water_depth = @waterDepth,
                  checked_at = @checkedAt, updated_at = @now
            WHERE server_id = @serverId AND id = @id`,
      )
      .run({
        serverId,
        id,
        label: input.label,
        x: input.x,
        z: input.z,
        yaw: input.yaw,
        enabled: input.enabled ? 1 : 0,
        worldKey: context.worldKey ?? (moved ? null : current.worldKey),
        grid: ground.grid,
        waterDepth: ground.waterDepth,
        checkedAt: ground.checkedAt,
        now,
      });

    return this.get(serverId, id);
  }

  remove(serverId: string, id: number): boolean {
    return (
      this.#db
        .prepare('DELETE FROM dungeon_spawn_points WHERE server_id = ? AND id = ?')
        .run(serverId, id).changes > 0
    );
  }

  /** Marca que a masmorra nasceu ali. É o que evita repetir o ponto. */
  markUsed(serverId: string, id: number, now: number = Date.now()): void {
    this.#db
      .prepare(
        'UPDATE dungeon_spawn_points SET last_used_at = ? WHERE server_id = ? AND id = ?',
      )
      .run(now, serverId, id);
  }
}

function toPoint(row: Row): SpawnPoint {
  return {
    id: row.id,
    serverId: row.server_id,
    label: row.label,
    x: row.x,
    z: row.z,
    yaw: row.yaw,
    enabled: row.enabled === 1,
    worldKey: row.world_key,
    grid: row.grid,
    waterDepth: row.water_depth,
    checkedAt: row.checked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
