// ============================================================
//  dungeons-repository.ts  -  a masmorra, gravada.
//
//  Duas tabelas e uma transação: `dungeons` guarda a receita ou a
//  planta, `dungeon_rooms` guarda o conteúdo de cada sala.
//
//  ####  AS SALAS SÃO REESCRITAS INTEIRAS  ####
//
//  Toda gravação apaga as salas e insere as novas. Não há
//  "atualizar a sala azul": o editor manda o conjunto completo,
//  como o editor de interface manda o documento inteiro.
//
//  A razão é a mesma: um merge parcial precisaria decidir o que
//  fazer com a sala que sumiu do payload — e a resposta certa
//  ("apagar") é exatamente o que o replace já faz, sem código.
//
//  ####  E O JSON MORA EM COLUNA DE TEXTO  ####
//
//  `crates`, `weapons`, `names` e `grid` são arrays pequenos que
//  ninguém consulta por dentro. Normalizá-los em tabelas daria
//  quatro joins para montar uma masmorra que cabe numa linha.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §6.2.
// ============================================================

import type { Logger } from '../logger.js';
import {
  dungeonGridSchema,
  ROOM_COLORS,
  ROOM_DOORS,
  type Dungeon,
  type DungeonInput,
  type DungeonRoomInput,
  type DungeonSummary,
  type RoomColor,
  type RoomDoor,
} from '../types/dungeons.js';
import type { AgentDatabase } from './database.js';

interface DungeonRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly mode: string;
  readonly entrance_blueprint: string | null;
  readonly size_min: number;
  readonly size_max: number;
  readonly weight_green: number;
  readonly weight_blue: number;
  readonly weight_red: number;
  readonly corridor_npc_density: number;
  readonly corridor_loot_density: number;
  readonly corridor_crates: string;
  readonly grid: string | null;
  readonly npc_health_min: number;
  readonly npc_health_max: number;
  readonly npc_damage_scale: number;
  readonly npc_weapons: string;
  readonly npc_names: string;
  readonly time_of_day: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RoomRow {
  readonly dungeon_id: string;
  readonly room_key: string;
  readonly color: string;
  readonly npc_min: number;
  readonly npc_max: number;
  readonly loot_min: number;
  readonly loot_max: number;
  readonly crates: string;
  readonly door: string;
  readonly locked: number;
}

export class DungeonsRepository {
  readonly #db: AgentDatabase;
  readonly #logger: Logger | undefined;

  constructor(db: AgentDatabase, logger?: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  /**
   * A lista, com a contagem de salas.
   *
   * Sem `grid` e sem as salas: dez masmorras numa tela, e nenhuma
   * delas precisa do desenho para caber numa linha.
   */
  list(): readonly DungeonSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT d.id, d.name, d.mode, d.entrance_blueprint, d.size_min, d.size_max,
                d.created_at, d.updated_at,
                (SELECT COUNT(*) FROM dungeon_rooms r WHERE r.dungeon_id = d.id) AS room_count
           FROM dungeons d
          ORDER BY d.name COLLATE NOCASE`,
      )
      .all() as (Pick<
      DungeonRow,
      'id' | 'name' | 'mode' | 'entrance_blueprint' | 'size_min' | 'size_max' | 'created_at' | 'updated_at'
    > & { room_count: number })[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mode: row.mode === 'blueprint' ? 'blueprint' : 'recipe',
      entranceBlueprint: row.entrance_blueprint,
      roomCount: row.room_count,
      sizeMin: row.size_min,
      sizeMax: row.size_max,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Uma masmorra inteira, com as salas. `null` = não existe. */
  get(id: string): Dungeon | null {
    const row = this.#db.prepare('SELECT * FROM dungeons WHERE id = ?').get(id) as
      | DungeonRow
      | undefined;

    if (row === undefined) return null;

    const rooms = this.#db
      .prepare('SELECT * FROM dungeon_rooms WHERE dungeon_id = ? ORDER BY room_key')
      .all(id) as RoomRow[];

    return this.#toDungeon(row, rooms);
  }

  exists(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM dungeons WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Grava a masmorra e as salas dela, de uma vez.
   *
   * ####  A TRANSAÇÃO NÃO É ZELO EXCESSIVO  ####
   *
   * São três comandos: grava a masmorra, apaga as salas, insere as
   * novas. Falhar no segundo deixaria uma masmorra sem sala nenhuma
   * — que o construtor lê como "só corredor" e ergue, calado.
   */
  save(input: DungeonInput, now: number = Date.now()): Dungeon {
    const existing = this.exists(input.id);

    this.#db.exec('BEGIN');

    try {
      this.#db
        .prepare(
          `INSERT INTO dungeons
                (id, name, description, mode, entrance_blueprint,
                 size_min, size_max, weight_green, weight_blue, weight_red,
                 corridor_npc_density, corridor_loot_density, corridor_crates,
                 grid, npc_health_min, npc_health_max, npc_damage_scale,
                 npc_weapons, npc_names, time_of_day, created_at, updated_at)
                VALUES (@id, @name, @description, @mode, @entranceBlueprint,
                        @sizeMin, @sizeMax, @weightGreen, @weightBlue, @weightRed,
                        @corridorNpc, @corridorLoot, @corridorCrates,
                        @grid, @healthMin, @healthMax, @damageScale,
                        @weapons, @names, @timeOfDay, @now, @now)
           ON CONFLICT (id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                mode = excluded.mode,
                entrance_blueprint = excluded.entrance_blueprint,
                size_min = excluded.size_min,
                size_max = excluded.size_max,
                weight_green = excluded.weight_green,
                weight_blue = excluded.weight_blue,
                weight_red = excluded.weight_red,
                corridor_npc_density = excluded.corridor_npc_density,
                corridor_loot_density = excluded.corridor_loot_density,
                corridor_crates = excluded.corridor_crates,
                grid = excluded.grid,
                npc_health_min = excluded.npc_health_min,
                npc_health_max = excluded.npc_health_max,
                npc_damage_scale = excluded.npc_damage_scale,
                npc_weapons = excluded.npc_weapons,
                npc_names = excluded.npc_names,
                time_of_day = excluded.time_of_day,
                updated_at = excluded.updated_at`,
        )
        .run({
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          mode: input.mode,
          entranceBlueprint: input.entranceBlueprint,
          sizeMin: input.size.min,
          sizeMax: input.size.max,
          weightGreen: input.weights.green,
          weightBlue: input.weights.blue,
          weightRed: input.weights.red,
          corridorNpc: input.corridor.npcDensity,
          corridorLoot: input.corridor.lootDensity,
          corridorCrates: JSON.stringify(input.corridor.crates),
          grid: input.grid === null ? null : JSON.stringify(input.grid),
          healthMin: input.npc.health.min,
          healthMax: input.npc.health.max,
          damageScale: input.npc.damageScale,
          weapons: JSON.stringify(input.npc.weapons),
          names: JSON.stringify(input.npc.names),
          timeOfDay: input.timeOfDay,
          now,
        });

      this.#db.prepare('DELETE FROM dungeon_rooms WHERE dungeon_id = ?').run(input.id);

      const insertRoom = this.#db.prepare(
        `INSERT INTO dungeon_rooms
              (dungeon_id, room_key, color, npc_min, npc_max, loot_min, loot_max,
               crates, door, locked)
              VALUES (@dungeonId, @key, @color, @npcMin, @npcMax, @lootMin, @lootMax,
                      @crates, @door, @locked)`,
      );

      for (const room of input.rooms) {
        insertRoom.run({
          dungeonId: input.id,
          key: room.key,
          color: room.color,
          npcMin: room.npc.min,
          npcMax: room.npc.max,
          lootMin: room.loot.min,
          lootMax: room.loot.max,
          crates: JSON.stringify(room.crates),
          door: room.door,
          locked: room.locked ? 1 : 0,
        });
      }

      this.#db.exec('COMMIT');
    } catch (cause) {
      this.#db.exec('ROLLBACK');
      throw cause;
    }

    const saved = this.get(input.id);

    if (saved === null) {
      throw new Error(`a masmorra "${input.id}" não pôde ser lida logo após a escrita`);
    }

    this.#logger?.debug(
      { dungeon: input.id, mode: input.mode, rooms: input.rooms.length, created: !existing },
      'masmorra gravada',
    );

    return saved;
  }

  /** `false` = não existia. As salas caem por CASCADE. */
  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM dungeons WHERE id = ?').run(id).changes > 0;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM dungeons').get() as {
      total: number;
    };

    return row.total;
  }

  /** Quem usa aquela planta como entrada. É o que barra o DELETE dela. */
  usersOfBlueprint(blueprintId: string): readonly string[] {
    const rows = this.#db
      .prepare('SELECT id FROM dungeons WHERE entrance_blueprint = ? ORDER BY id')
      .all(blueprintId) as { id: string }[];

    return rows.map((row) => row.id);
  }

  #toDungeon(row: DungeonRow, rooms: readonly RoomRow[]): Dungeon {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      mode: row.mode === 'blueprint' ? 'blueprint' : 'recipe',
      entranceBlueprint: row.entrance_blueprint,
      size: { min: row.size_min, max: row.size_max },
      weights: { green: row.weight_green, blue: row.weight_blue, red: row.weight_red },
      corridor: {
        npcDensity: row.corridor_npc_density,
        lootDensity: row.corridor_loot_density,
        crates: this.#jsonArray(row.corridor_crates, row.id, 'corridor_crates'),
      },
      grid: this.#grid(row.grid, row.id),
      npc: {
        health: { min: row.npc_health_min, max: row.npc_health_max },
        damageScale: row.npc_damage_scale,
        weapons: this.#jsonArray(row.npc_weapons, row.id, 'npc_weapons'),
        names: this.#jsonArray(row.npc_names, row.id, 'npc_names'),
      },
      timeOfDay: row.time_of_day,
      rooms: rooms.map((room) => this.#toRoom(room)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #toRoom(row: RoomRow): DungeonRoomInput {
    return {
      key: row.room_key,
      color: (ROOM_COLORS as readonly string[]).includes(row.color)
        ? (row.color as RoomColor)
        : 'green',
      npc: { min: row.npc_min, max: row.npc_max },
      loot: { min: row.loot_min, max: row.loot_max },
      crates: this.#jsonArray(row.crates, row.dungeon_id, 'crates'),
      door: (ROOM_DOORS as readonly string[]).includes(row.door) ? (row.door as RoomDoor) : 'wood',
      locked: row.locked === 1,
    };
  }

  /**
   * Um array de texto que veio da coluna.
   *
   * O banco guarda texto, e nada impede uma edição à mão deixar ali
   * algo que não é um array. Ler sem validar faria esse texto
   * atravessar o agente e chegar ao plugin, onde o defeito
   * apareceria longe da causa — é a mesma escolha do
   * `ui-documents-repository`.
   */
  #jsonArray(raw: string, dungeonId: string, column: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);

      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      // cai no aviso abaixo
    }

    this.#logger?.warn({ dungeon: dungeonId, column }, 'coluna JSON ilegível: tratada como vazia');

    return [];
  }

  #grid(raw: string | null, dungeonId: string): string[] | null {
    if (raw === null) return null;

    try {
      const parsed = dungeonGridSchema.safeParse(JSON.parse(raw));

      if (parsed.success) return parsed.data;
    } catch {
      // cai no aviso abaixo
    }

    // Grid ilegível vira `null`, e não um grid vazio: `null` é
    // "modo receita" e o construtor sorteia; um grid vazio seria
    // uma masmorra sem nenhuma célula, erguida em silêncio.
    this.#logger?.warn({ dungeon: dungeonId }, 'grid ilegível: a masmorra vai cair no sorteio');

    return null;
  }
}
