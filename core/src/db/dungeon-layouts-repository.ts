// ============================================================
//  dungeon-layouts-repository.ts  -  o acervo de traçados.
//
//  Cada linha é um DESENHO de masmorra guardado por si só: o admin
//  desenha uma vez, salva, e toda masmorra nova pode começar dali.
//
//  ####  ELE GRAVA O DEFEITUOSO, E MARCA  ####
//
//  Ao contrário do acervo de plantas — que RECUSA uma entrada sem
//  alçapão —, aqui um traçado com sala lacrada é gravado do mesmo
//  jeito, com a contagem de defeitos ao lado.
//
//  A diferença é o que cada coisa é. Uma planta sem alçapão está
//  pronta e não funciona; um traçado é rascunho por definição, e
//  recusar o de um admin que ia consertar a sala depois do almoço
//  seria perder o trabalho dele. O que não pode é ele NÃO SABER —
//  e é para isso que `problem_count` é coluna.
//
//  ####  E A LISTA TRAZ O DESENHO  ####
//
//  Aqui a regra do acervo de plantas se inverte, e de propósito:
//  lá o `content` tem meio megabyte e nunca entra na lista; aqui o
//  desenho inteiro tem algumas centenas de bytes, e é ELE que a
//  tela precisa para mostrar a miniatura. Uma lista de traçados
//  sem os traçados seria uma lista de nomes.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §4.2.
// ============================================================

import { analyzeLayout, checkLayout } from '../dungeons/layout.js';
import type { Logger } from '../logger.js';
import type { DungeonLayoutOrigin, DungeonLayoutSummary } from '../types/dungeon-layouts.js';
import type { AgentDatabase } from './database.js';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly grid: string;
  readonly cell_count: number;
  readonly room_count: number;
  readonly green_rooms: number;
  readonly blue_rooms: number;
  readonly red_rooms: number;
  readonly has_entrance: number;
  readonly problem_count: number;
  readonly origin: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SaveLayoutInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly grid: readonly string[];
  readonly origin: DungeonLayoutOrigin;
  readonly now?: number;
}

export class DungeonLayoutsRepository {
  readonly #db: AgentDatabase;
  readonly #logger: Logger | undefined;

  constructor(db: AgentDatabase, logger?: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  list(): readonly DungeonLayoutSummary[] {
    const rows = this.#db
      .prepare('SELECT * FROM dungeon_layouts ORDER BY name COLLATE NOCASE')
      .all() as Row[];

    return rows.map(toSummary);
  }

  get(id: string): DungeonLayoutSummary | null {
    const row = this.#db.prepare('SELECT * FROM dungeon_layouts WHERE id = ?').get(id) as
      | Row
      | undefined;

    return row === undefined ? null : toSummary(row);
  }

  exists(id: string): boolean {
    return this.#db.prepare('SELECT 1 FROM dungeon_layouts WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Grava um traçado novo, ou substitui o de mesmo slug.
   *
   * Os derivados são calculados AQUI, e não na rota, porque há três
   * portas de entrada — o painel, o seeder e a captura in-game — e
   * as três precisam da mesma conta. Deixá-la na rota faria a
   * captura gravar contagens que a lista mostraria erradas.
   */
  save(input: SaveLayoutInput): DungeonLayoutSummary {
    const facts = analyzeLayout(input.grid);
    const problems = checkLayout(input.grid);
    const now = input.now ?? Date.now();

    this.#db
      .prepare(
        `INSERT INTO dungeon_layouts
              (id, name, description, grid, cell_count, room_count,
               green_rooms, blue_rooms, red_rooms, has_entrance, problem_count,
               origin, created_at, updated_at)
              VALUES (@id, @name, @description, @grid, @cellCount, @roomCount,
                      @greenRooms, @blueRooms, @redRooms, @hasEntrance, @problemCount,
                      @origin, @now, @now)
         ON CONFLICT (id) DO UPDATE SET
              name          = excluded.name,
              description   = excluded.description,
              grid          = excluded.grid,
              cell_count    = excluded.cell_count,
              room_count    = excluded.room_count,
              green_rooms   = excluded.green_rooms,
              blue_rooms    = excluded.blue_rooms,
              red_rooms     = excluded.red_rooms,
              has_entrance  = excluded.has_entrance,
              problem_count = excluded.problem_count,
              origin        = excluded.origin,
              updated_at    = excluded.updated_at`,
      )
      .run({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        grid: JSON.stringify(input.grid),
        cellCount: facts.cellCount,
        roomCount: facts.roomCount,
        greenRooms: facts.byColor.green,
        blueRooms: facts.byColor.blue,
        redRooms: facts.byColor.red,
        hasEntrance: facts.hasEntrance ? 1 : 0,
        problemCount: problems.length,
        origin: input.origin,
        now,
      });

    const saved = this.get(input.id);

    if (saved === null) {
      // O que acabou de ser gravado não volta. Falhar alto é melhor
      // que devolver `null` e deixar a rota inventar um motivo.
      throw new Error(`o traçado "${input.id}" não pôde ser lido logo após a escrita`);
    }

    this.#logger?.debug(
      { layout: input.id, cells: facts.cellCount, rooms: facts.roomCount, problems: problems.length },
      'traçado gravado',
    );

    return saved;
  }

  /** `false` = não existia. */
  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM dungeon_layouts WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Quantos traçados existem.
   *
   * Serve ao seeder, pela mesma regra do acervo de plantas: ele só
   * age num acervo vazio, para não ressuscitar no boot o que
   * alguém apagou de propósito.
   */
  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM dungeon_layouts').get() as {
      total: number;
    };

    return row.total;
  }
}

function toSummary(row: Row): DungeonLayoutSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    grid: readGrid(row.grid),
    cellCount: row.cell_count,
    roomCount: row.room_count,
    byColor: { green: row.green_rooms, blue: row.blue_rooms, red: row.red_rooms },
    hasEntrance: row.has_entrance === 1,
    problemCount: row.problem_count,
    origin: toOrigin(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * O desenho, de volta do JSON.
 *
 * Uma coluna corrompida à mão devolve o traçado VAZIO em vez de
 * derrubar a listagem inteira: um registro estragado não pode
 * esconder os outros nove da tela.
 */
function readGrid(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter((row): row is string => typeof row === 'string');
  } catch {
    return [];
  }
}

function toOrigin(raw: string): DungeonLayoutOrigin {
  return raw === 'builtin' || raw === 'capture' ? raw : 'panel';
}
