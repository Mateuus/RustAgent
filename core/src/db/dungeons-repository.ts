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
//  A tabela de loot (063) e o bloco de IA (064) entraram pelo
//  mesmo caminho, e o de IA por um motivo a mais: guardá-lo em
//  coluna faria NULL e 0 conviverem na mesma casa, e é justamente
//  a diferença entre eles que sustenta a herança campo a campo.
//
//  ####  LINHA ILEGÍVEL VIRA O PADRÃO, NUNCA UMA EXCEÇÃO  ####
//
//  Toda leitura de coluna JSON passa por `safeParse`. Um texto
//  torto ali — edição à mão, restauração de backup velho — não
//  pode derrubar a masmorra inteira: ele vira o padrão, com aviso
//  no log. É a mesma escolha do `ui-documents-repository`.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §6.2.
// ============================================================

import type { Logger } from '../logger.js';
import {
  ACCESS_WHO_ENTERS,
  aiSpecSchema,
  BUILD_GRADES,
  dungeonGridSchema,
  ENTRANCE_ITEM_MODES,
  LOCK_CARRIER_SCOPES,
  LOCK_CARRIERS,
  LOCK_UNDELIVERED,
  lootTableSchema,
  ROOM_COLORS,
  ROOM_DOORS,
  type AccessWhoEnters,
  type AiSpecInput,
  type BuildGrade,
  type Dungeon,
  type DungeonInput,
  type DungeonRoomInput,
  type DungeonSummary,
  type GradeSetInput,
  type LockCarrier,
  type LockCarrierScope,
  type EntranceItemMode,
  type LockUndelivered,
  type LootTableInput,
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
  readonly entrance_items: string;
  readonly entrance_rotation: number;
  readonly entrance_facing: number | null;
  readonly marker_enabled: number;
  readonly marker_label: string | null;
  readonly marker_color: string;
  readonly marker_alpha: number;
  readonly marker_radius: number;
  readonly announce_enabled: number;
  readonly announce_on_build: string | null;
  readonly announce_on_end: string | null;
  readonly announce_show_grid: number;
  readonly size_min: number;
  readonly size_max: number;
  readonly weight_green: number;
  readonly weight_blue: number;
  readonly weight_red: number;
  readonly corridor_npc_density: number;
  readonly corridor_loot_density: number;
  readonly corridor_crates: string;
  readonly corridor_loot_table: string;
  readonly corridor_ai: string;
  readonly grid: string | null;
  readonly npc_health_min: number;
  readonly npc_health_max: number;
  readonly npc_damage_scale: number;
  readonly npc_weapons: string;
  readonly npc_names: string;
  readonly npc_loot_table: string;
  readonly npc_ai: string;
  readonly time_of_day: number;
  readonly structure_foundation: string;
  readonly structure_wall: string;
  readonly structure_ceiling: string;
  readonly lock_enabled: number;
  readonly lock_shared_code: number;
  readonly lock_carrier: string;
  readonly lock_carrier_scope: string;
  readonly lock_on_undelivered: string;
  readonly lock_note_title: string | null;
  readonly lock_announce_open: number;
  readonly lock_warn_wrong_code: number;
  readonly access_who_enters: string;
  readonly access_enter_permission: string | null;
  readonly protection_enabled: number;
  readonly protection_allow_admin: number;
  readonly protection_warn_on_attempt: number;
  readonly respawn_enabled: number;
  readonly respawn_minutes: number;
  readonly respawn_only_when_empty: number;
  readonly respawn_rebuild_destroyed: number;
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
  readonly wide_door: string | null;
  readonly wide_door_cells_per_door: number;
  readonly grade_foundation: string | null;
  readonly grade_wall: string | null;
  readonly grade_ceiling: string | null;
  readonly loot_table: string;
  readonly ai: string;
}

/**
 * O título padrão do papel do código.
 *
 * Ele mora no schema Zod, e a coluna do banco é anulável para não
 * congelar essa frase em toda linha já gravada. Aqui é o que uma
 * linha antiga (`NULL`) lê.
 */
const DEFAULT_NOTE_TITLE = 'Código da porta';

/** O nome do círculo no mapa, quando a coluna está vazia. */
const DEFAULT_MARKER_LABEL = 'Masmorra';

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
                (id, name, description, mode, entrance_blueprint, entrance_items,
                 entrance_rotation, entrance_facing,
                 size_min, size_max, weight_green, weight_blue, weight_red,
                 corridor_npc_density, corridor_loot_density, corridor_crates,
                 corridor_loot_table, corridor_ai,
                 grid, npc_health_min, npc_health_max, npc_damage_scale,
                 npc_weapons, npc_names, npc_loot_table, npc_ai, time_of_day,
                 structure_foundation, structure_wall, structure_ceiling,
                 lock_enabled, lock_shared_code, lock_carrier, lock_carrier_scope,
                 lock_on_undelivered, lock_note_title, lock_announce_open,
                 lock_warn_wrong_code,
                 access_who_enters, access_enter_permission,
                 protection_enabled, protection_allow_admin, protection_warn_on_attempt,
                 respawn_enabled, respawn_minutes, respawn_only_when_empty,
                 respawn_rebuild_destroyed,
                 marker_enabled, marker_label, marker_color, marker_alpha, marker_radius,
                 announce_enabled, announce_on_build, announce_on_end, announce_show_grid,
                 created_at, updated_at)
                VALUES (@id, @name, @description, @mode, @entranceBlueprint, @entranceItems,
                        @entranceRotation, @entranceFacing,
                        @sizeMin, @sizeMax, @weightGreen, @weightBlue, @weightRed,
                        @corridorNpc, @corridorLoot, @corridorCrates,
                        @corridorTable, @corridorAi,
                        @grid, @healthMin, @healthMax, @damageScale,
                        @weapons, @names, @npcTable, @npcAi, @timeOfDay,
                        @structureFoundation, @structureWall, @structureCeiling,
                        @lockEnabled, @lockSharedCode, @lockCarrier, @lockCarrierScope,
                        @lockOnUndelivered, @lockNoteTitle, @lockAnnounceOpen,
                        @lockWarnWrongCode,
                        @accessWhoEnters, @accessEnterPermission,
                        @protectionEnabled, @protectionAllowAdmin, @protectionWarnOnAttempt,
                        @respawnEnabled, @respawnMinutes, @respawnOnlyWhenEmpty,
                        @respawnRebuildDestroyed,
                        @markerEnabled, @markerLabel, @markerColor, @markerAlpha, @markerRadius,
                        @announceEnabled, @announceOnBuild, @announceOnEnd, @announceShowGrid,
                        @now, @now)
           ON CONFLICT (id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                mode = excluded.mode,
                entrance_blueprint = excluded.entrance_blueprint,
                entrance_items = excluded.entrance_items,
                entrance_rotation = excluded.entrance_rotation,
                entrance_facing = excluded.entrance_facing,
                size_min = excluded.size_min,
                size_max = excluded.size_max,
                weight_green = excluded.weight_green,
                weight_blue = excluded.weight_blue,
                weight_red = excluded.weight_red,
                corridor_npc_density = excluded.corridor_npc_density,
                corridor_loot_density = excluded.corridor_loot_density,
                corridor_crates = excluded.corridor_crates,
                corridor_loot_table = excluded.corridor_loot_table,
                corridor_ai = excluded.corridor_ai,
                grid = excluded.grid,
                npc_health_min = excluded.npc_health_min,
                npc_health_max = excluded.npc_health_max,
                npc_damage_scale = excluded.npc_damage_scale,
                npc_weapons = excluded.npc_weapons,
                npc_names = excluded.npc_names,
                npc_loot_table = excluded.npc_loot_table,
                npc_ai = excluded.npc_ai,
                time_of_day = excluded.time_of_day,
                structure_foundation = excluded.structure_foundation,
                structure_wall = excluded.structure_wall,
                structure_ceiling = excluded.structure_ceiling,
                lock_enabled = excluded.lock_enabled,
                lock_shared_code = excluded.lock_shared_code,
                lock_carrier = excluded.lock_carrier,
                lock_carrier_scope = excluded.lock_carrier_scope,
                lock_on_undelivered = excluded.lock_on_undelivered,
                lock_note_title = excluded.lock_note_title,
                lock_announce_open = excluded.lock_announce_open,
                lock_warn_wrong_code = excluded.lock_warn_wrong_code,
                access_who_enters = excluded.access_who_enters,
                access_enter_permission = excluded.access_enter_permission,
                protection_enabled = excluded.protection_enabled,
                protection_allow_admin = excluded.protection_allow_admin,
                protection_warn_on_attempt = excluded.protection_warn_on_attempt,
                respawn_enabled = excluded.respawn_enabled,
                respawn_minutes = excluded.respawn_minutes,
                respawn_only_when_empty = excluded.respawn_only_when_empty,
                respawn_rebuild_destroyed = excluded.respawn_rebuild_destroyed,
                marker_enabled = excluded.marker_enabled,
                marker_label = excluded.marker_label,
                marker_color = excluded.marker_color,
                marker_alpha = excluded.marker_alpha,
                marker_radius = excluded.marker_radius,
                announce_enabled = excluded.announce_enabled,
                announce_on_build = excluded.announce_on_build,
                announce_on_end = excluded.announce_on_end,
                announce_show_grid = excluded.announce_show_grid,
                updated_at = excluded.updated_at`,
        )
        .run({
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          mode: input.mode,
          entranceBlueprint: input.entranceBlueprint,
          entranceItems: input.entranceItems,
          entranceRotation: input.entranceRotation,
          entranceFacing: input.entranceFacing,
          markerEnabled: input.marker.enabled ? 1 : 0,
          markerLabel: input.marker.label,
          markerColor: input.marker.color,
          markerAlpha: input.marker.alpha,
          markerRadius: input.marker.radius,
          announceEnabled: input.announce.enabled ? 1 : 0,
          // Texto vazio vira NULL: a frase padrão mora no código, e
          // gravá-la em cada linha a congelaria. Ver a migração 068.
          announceOnBuild: input.announce.onBuild === '' ? null : input.announce.onBuild,
          announceOnEnd: input.announce.onEnd === '' ? null : input.announce.onEnd,
          announceShowGrid: input.announce.showGrid ? 1 : 0,
          sizeMin: input.size.min,
          sizeMax: input.size.max,
          weightGreen: input.weights.green,
          weightBlue: input.weights.blue,
          weightRed: input.weights.red,
          corridorNpc: input.corridor.npcDensity,
          corridorLoot: input.corridor.lootDensity,
          corridorCrates: JSON.stringify(input.corridor.crates),
          corridorTable: JSON.stringify(input.corridor.table),
          corridorAi: JSON.stringify(input.corridor.ai),
          grid: input.grid === null ? null : JSON.stringify(input.grid),
          healthMin: input.npc.health.min,
          healthMax: input.npc.health.max,
          damageScale: input.npc.damageScale,
          weapons: JSON.stringify(input.npc.weapons),
          names: JSON.stringify(input.npc.names),
          npcTable: JSON.stringify(input.npc.loot),
          npcAi: JSON.stringify(input.npc.ai),
          timeOfDay: input.timeOfDay,
          structureFoundation: input.structure.foundation,
          structureWall: input.structure.wall,
          structureCeiling: input.structure.ceiling,
          lockEnabled: input.lock.enabled ? 1 : 0,
          lockSharedCode: input.lock.sharedCode ? 1 : 0,
          lockCarrier: input.lock.carrier,
          lockCarrierScope: input.lock.carrierScope,
          lockOnUndelivered: input.lock.onUndelivered,
          lockNoteTitle: input.lock.noteTitle,
          lockAnnounceOpen: input.lock.announceOpen ? 1 : 0,
          lockWarnWrongCode: input.lock.warnOnWrongCode ? 1 : 0,
          accessWhoEnters: input.access.whoEnters,
          // Vazia vira NULL: a coluna é anulável justamente para não
          // congelar a permissão padrão, que é do contrato.
          accessEnterPermission: input.access.enterPermission === '' ? null : input.access.enterPermission,
          protectionEnabled: input.protection.enabled ? 1 : 0,
          protectionAllowAdmin: input.protection.allowAdmin ? 1 : 0,
          protectionWarnOnAttempt: input.protection.warnOnAttempt ? 1 : 0,
          respawnEnabled: input.respawn.enabled ? 1 : 0,
          respawnMinutes: input.respawn.minutes,
          respawnOnlyWhenEmpty: input.respawn.onlyWhenEmpty ? 1 : 0,
          respawnRebuildDestroyed: input.respawn.rebuildDestroyed ? 1 : 0,
          now,
        });

      this.#db.prepare('DELETE FROM dungeon_rooms WHERE dungeon_id = ?').run(input.id);

      const insertRoom = this.#db.prepare(
        `INSERT INTO dungeon_rooms
              (dungeon_id, room_key, color, npc_min, npc_max, loot_min, loot_max,
               crates, door, locked, wide_door, wide_door_cells_per_door,
               grade_foundation, grade_wall, grade_ceiling, loot_table, ai)
              VALUES (@dungeonId, @key, @color, @npcMin, @npcMax, @lootMin, @lootMax,
                      @crates, @door, @locked, @wideDoor, @wideDoorCells,
                      @gradeFoundation, @gradeWall, @gradeCeiling, @table, @ai)`,
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
          wideDoor: room.wideDoor,
          wideDoorCells: room.wideDoorCellsPerDoor,
          gradeFoundation: room.grade === null ? null : room.grade.foundation,
          gradeWall: room.grade === null ? null : room.grade.wall,
          gradeCeiling: room.grade === null ? null : room.grade.ceiling,
          table: JSON.stringify(room.table),
          ai: JSON.stringify(room.ai),
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
      // Um modo que o banco nao conhece cai em 'none': a entrada
      // que nao da nada decepciona, a que da uma M249 de graca
      // reescreve o wipe. Ver ENTRANCE_ITEM_MODES.
      entranceItems: oneOf(ENTRANCE_ITEM_MODES, row.entrance_items, 'none') as EntranceItemMode,
      entranceRotation: clampNumber(row.entrance_rotation, 0, 359, 0),
      // Um valor que não é múltiplo de 90 — banco editado à mão —
      // cai no automático, que é o que a coluna nula já vale.
      entranceFacing: quarterTurn(row.entrance_facing),
      marker: {
        enabled: row.marker_enabled === 1,
        label: row.marker_label ?? DEFAULT_MARKER_LABEL,
        // Uma cor torta — banco editado à mão — vira o vermelho
        // padrão em vez de derrubar a leitura da masmorra inteira.
        color: /^#[0-9a-fA-F]{6}$/u.test(row.marker_color) ? row.marker_color : '#ff0000',
        alpha: clampNumber(row.marker_alpha, 0, 1, 0.55),
        radius: clampNumber(row.marker_radius, 0.1, 10, 0.5),
      },
      announce: {
        enabled: row.announce_enabled === 1,
        onBuild: row.announce_on_build ?? '',
        onEnd: row.announce_on_end ?? '',
        showGrid: row.announce_show_grid === 1,
      },
      size: { min: row.size_min, max: row.size_max },
      weights: { green: row.weight_green, blue: row.weight_blue, red: row.weight_red },
      corridor: {
        npcDensity: row.corridor_npc_density,
        lootDensity: row.corridor_loot_density,
        crates: this.#jsonArray(row.corridor_crates, row.id, 'corridor_crates'),
        table: this.#lootTable(row.corridor_loot_table, row.id, 'corridor_loot_table'),
        ai: this.#aiSpec(row.corridor_ai, row.id, 'corridor_ai'),
      },
      grid: this.#grid(row.grid, row.id),
      npc: {
        health: { min: row.npc_health_min, max: row.npc_health_max },
        damageScale: row.npc_damage_scale,
        weapons: this.#jsonArray(row.npc_weapons, row.id, 'npc_weapons'),
        names: this.#jsonArray(row.npc_names, row.id, 'npc_names'),
        loot: this.#lootTable(row.npc_loot_table, row.id, 'npc_loot_table'),
        ai: this.#aiSpec(row.npc_ai, row.id, 'npc_ai'),
      },
      timeOfDay: row.time_of_day,
      structure: {
        foundation: grade(row.structure_foundation),
        wall: grade(row.structure_wall),
        ceiling: grade(row.structure_ceiling),
      },
      lock: {
        enabled: row.lock_enabled === 1,
        sharedCode: row.lock_shared_code === 1,
        carrier: oneOf(LOCK_CARRIERS, row.lock_carrier, 'npc') as LockCarrier,
        carrierScope: oneOf(LOCK_CARRIER_SCOPES, row.lock_carrier_scope, 'corridor') as LockCarrierScope,
        onUndelivered: oneOf(LOCK_UNDELIVERED, row.lock_on_undelivered, 'unlock') as LockUndelivered,
        noteTitle: row.lock_note_title ?? DEFAULT_NOTE_TITLE,
        announceOpen: row.lock_announce_open === 1,
        warnOnWrongCode: row.lock_warn_wrong_code === 1,
      },
      access: {
        // Um modo que o banco não conhece cai em `everyone`, e não
        // em "lacrada": é a mesma escolha do plugin, e pela mesma
        // razão — abrir por engano devolve a masmorra ao que ela já
        // era; trancar por engano ninguém diagnostica de dentro do
        // jogo.
        whoEnters: oneOf(ACCESS_WHO_ENTERS, row.access_who_enters, 'everyone') as AccessWhoEnters,
        enterPermission: row.access_enter_permission ?? '',
      },
      protection: {
        enabled: row.protection_enabled === 1,
        allowAdmin: row.protection_allow_admin === 1,
        warnOnAttempt: row.protection_warn_on_attempt === 1,
      },
      respawn: {
        enabled: row.respawn_enabled === 1,
        minutes: row.respawn_minutes,
        onlyWhenEmpty: row.respawn_only_when_empty === 1,
        rebuildDestroyed: row.respawn_rebuild_destroyed === 1,
      },
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
      wideDoor:
        row.wide_door !== null && (ROOM_DOORS as readonly string[]).includes(row.wide_door)
          ? (row.wide_door as RoomDoor)
          : null,
      wideDoorCellsPerDoor: row.wide_door_cells_per_door,
      grade: this.#grade(row),
      table: this.#lootTable(row.loot_table, row.dungeon_id, 'loot_table'),
      ai: this.#aiSpec(row.ai, row.dungeon_id, 'ai'),
    };
  }

  /**
   * O nível das peças daquela sala.
   *
   * Os três `NULL` juntos são "herda o `structure`" — o padrão, e o
   * que toda linha anterior à 062 tem. Um só preenchido é uma
   * edição à mão pela metade: os outros dois caem em `stone`, que é
   * o que o construtor cravava.
   */
  #grade(row: RoomRow): GradeSetInput | null {
    if (row.grade_foundation === null && row.grade_wall === null && row.grade_ceiling === null) {
      return null;
    }

    return {
      foundation: grade(row.grade_foundation),
      wall: grade(row.grade_wall),
      ceiling: grade(row.grade_ceiling),
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

  /**
   * A tabela de loot que veio da coluna.
   *
   * Ilegível vira a tabela PADRÃO (`mode: 'server'`), e não uma
   * tabela vazia: vazia em `replace` seria uma masmorra inteira de
   * caixas sem nada dentro, e nada no jogo diria por quê.
   */
  #lootTable(raw: string, dungeonId: string, column: string): LootTableInput {
    try {
      const parsed = lootTableSchema.safeParse(JSON.parse(raw));

      if (parsed.success) return parsed.data;
    } catch {
      // cai no aviso abaixo
    }

    this.#logger?.warn(
      { dungeon: dungeonId, column },
      'tabela de loot ilegível: a caixa volta a se encher pela tabela do servidor',
    );

    return lootTableSchema.parse({});
  }

  /**
   * O bloco de comportamento que veio da coluna.
   *
   * Ilegível vira o bloco VAZIO, que quer dizer "herda tudo" — e
   * não um bloco de zeros, que produziria um cientista cego e
   * parado sem ninguém ter pedido.
   */
  #aiSpec(raw: string, dungeonId: string, column: string): AiSpecInput {
    try {
      const parsed = aiSpecSchema.safeParse(JSON.parse(raw));

      if (parsed.success) return parsed.data;
    } catch {
      // cai no aviso abaixo
    }

    this.#logger?.warn(
      { dungeon: dungeonId, column },
      'bloco de IA ilegível: o inimigo fica com o comportamento padrão',
    );

    return {};
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

/** O grau da peça, com `stone` para o que o banco não souber dizer. */
function grade(raw: string | null): BuildGrade {
  return raw !== null && (BUILD_GRADES as readonly string[]).includes(raw)
    ? (raw as BuildGrade)
    : 'stone';
}

/**
 * Um valor de enum vindo do banco.
 *
 * O CHECK da coluna já barra o que não pertence, mas a coluna de
 * texto continua sendo texto — e um banco restaurado de um schema
 * mais velho não tem CHECK nenhum.
 */
function oneOf(allowed: readonly string[], raw: string, fallback: string): string {
  return allowed.includes(raw) ? raw : fallback;
}

/**
 * Um número do banco, preso na faixa que o schema promete.
 *
 * Uma coluna fora da faixa — banco editado à mão, restaurado de
 * uma versão mais velha — não pode derrubar a leitura: ela vira o
 * padrão, como toda coluna torta faz neste arquivo.
 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, value));
}

/**
 * Um dos quatro quartos de volta, ou nada.
 *
 * O desenho é uma grade: a entrada aponta para cima, para a
 * direita, para baixo ou para a esquerda. Qualquer outro valor é
 * lixo de escrita à mão e vale o mesmo que ausente — o automático.
 */
function quarterTurn(value: number | null): 0 | 90 | 180 | 270 | null {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;

  return null;
}
