// ============================================================
//  dungeon-blueprints-repository.ts  -  o acervo de plantas.
//
//  Cada linha é uma construção inteira em JSON: a casinha da
//  superfície (`entrance`) ou a masmorra pronta (`base`).
//
//  ####  A LISTA NÃO TRAZ O `content`, NUNCA  ####
//
//  As sete plantas herdadas somam 1,1 MB, e a maior sozinha tem
//  512 KB. Uma listagem que carregasse tudo faria o painel baixar
//  isso a cada abertura de tela — para mostrar sete nomes.
//
//  É por isso que `entity_count`, `byte_size` e `has_hatch` são
//  COLUNAS e não contas: elas são calculadas uma vez, na escrita,
//  e a lista responde sem abrir um único JSON.
//
//  ####  E O `has_hatch` É O CAMPO QUE IMPORTA  ####
//
//  Sem alçapão não há masmorra. Uma planta sem ele sobe bonita e
//  falha 60 segundos depois, no jogo, com a casinha já de pé —
//  que é o pior lugar possível para descobrir. Medido aqui, o
//  painel recusa no upload e diz por quê.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §5 e §6.3.
// ============================================================

import { analyzeBlueprint, parseBlueprint, type BlueprintProblem } from '../dungeons/blueprint.js';
import { analyzeBody } from '../dungeons/body.js';
import type { Logger } from '../logger.js';
import type { AgentDatabase } from './database.js';

/** De onde a planta veio. */
export type BlueprintOrigin = 'builtin' | 'import' | 'capture';

/**
 * Onde ela é colada.
 *
 * `entrance` é a casinha da superfície; `base` é o CORPO da masmorra,
 * colado a -90 no modo construção. Na tela, "entrada" e "masmorra".
 */
export type BlueprintKind = 'entrance' | 'base';

/**
 * Quantos marcadores de corpo a planta tem. Ver `dungeons/body.ts`.
 *
 * Contados na escrita, para a biblioteca dizer "3 lápides, 2 velas,
 * 1 árvore" sem abrir o JSON de cada linha.
 */
export interface BlueprintMarkerCounts {
  readonly npc: number;
  readonly crate: number;
  readonly arrival: number;
}

/** A linha, sem o conteúdo. É o que a lista devolve. */
export interface BlueprintSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: BlueprintKind;
  readonly entityCount: number;
  readonly byteSize: number;
  readonly hasHatch: boolean;
  /** `null` = gravada antes da migração 099 e ainda não relida. */
  readonly markers: BlueprintMarkerCounts | null;
  readonly origin: BlueprintOrigin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A linha inteira. Só quem vai colar precisa disto. */
export interface StoredBlueprint extends BlueprintSummary {
  readonly content: string;
}

/** O que `save` devolve quando recusa. */
export interface BlueprintRejected {
  readonly ok: false;
  readonly problem: BlueprintProblem | 'no_hatch';
}

export interface BlueprintSaved {
  readonly ok: true;
  readonly blueprint: BlueprintSummary;
}

interface Row {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly content?: string;
  readonly entity_count: number;
  readonly byte_size: number;
  readonly has_hatch: number;
  readonly markers: string | null;
  readonly origin: string;
  readonly created_at: number;
  readonly updated_at: number;
}

const SUMMARY_COLUMNS =
  'id, name, kind, entity_count, byte_size, has_hatch, markers, origin, created_at, updated_at';

export class DungeonBlueprintsRepository {
  readonly #db: AgentDatabase;
  readonly #logger: Logger | undefined;

  constructor(db: AgentDatabase, logger?: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  /** Todas, sem o conteúdo. */
  list(): readonly BlueprintSummary[] {
    const rows = this.#db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM dungeon_blueprints ORDER BY name COLLATE NOCASE`)
      .all() as Row[];

    return rows.map(toSummary);
  }

  /** Uma, sem o conteúdo. */
  summary(id: string): BlueprintSummary | null {
    const row = this.#db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM dungeon_blueprints WHERE id = ?`)
      .get(id) as Row | undefined;

    return row === undefined ? null : toSummary(row);
  }

  /** Uma, inteira. É o que o materializador escreve no disco. */
  get(id: string): StoredBlueprint | null {
    const row = this.#db
      .prepare(`SELECT ${SUMMARY_COLUMNS}, content FROM dungeon_blueprints WHERE id = ?`)
      .get(id) as Row | undefined;

    if (row === undefined) return null;

    return { ...toSummary(row), content: row.content ?? '' };
  }

  /**
   * Grava uma planta nova, ou substitui a de mesmo slug.
   *
   * ####  A VALIDAÇÃO ACONTECE AQUI, E NÃO NA ROTA  ####
   *
   * Porque há três portas de entrada — o upload do painel, a
   * captura in-game e o seeder das sete herdadas — e as três
   * precisam da mesma régua. Deixá-la na rota faria a captura
   * gravar o que o upload recusaria.
   *
   * `requireHatch` é falso para plantas de `base`: só a entrada
   * precisa do alçapão de superfície.
   */
  save(input: {
    readonly id: string;
    readonly name: string;
    readonly kind: BlueprintKind;
    readonly content: string;
    readonly origin: BlueprintOrigin;
    readonly requireHatch?: boolean;
    readonly now?: number;
  }): BlueprintSaved | BlueprintRejected {
    const parsed = parseBlueprint(input.content);

    if (!parsed.ok) return { ok: false, problem: parsed.problem };

    const facts = analyzeBlueprint(parsed.blueprint, input.content);
    const body = analyzeBody(parsed.blueprint.entities);
    const markers: BlueprintMarkerCounts = {
      npc: body.markers.npc.length,
      crate: body.markers.crate.length,
      arrival: body.markers.arrival.length,
    };
    const requireHatch = input.requireHatch ?? input.kind === 'entrance';

    if (requireHatch && !facts.hasHatch) return { ok: false, problem: 'no_hatch' };

    const now = input.now ?? Date.now();

    this.#db
      .prepare(
        `INSERT INTO dungeon_blueprints
              (id, name, kind, content, entity_count, byte_size, has_hatch, markers, origin,
               created_at, updated_at)
              VALUES (@id, @name, @kind, @content, @entityCount, @byteSize, @hasHatch, @markers, @origin,
                      @now, @now)
         ON CONFLICT (id) DO UPDATE SET
              name         = excluded.name,
              kind         = excluded.kind,
              content      = excluded.content,
              entity_count = excluded.entity_count,
              byte_size    = excluded.byte_size,
              has_hatch    = excluded.has_hatch,
              markers      = excluded.markers,
              origin       = excluded.origin,
              updated_at   = excluded.updated_at`,
      )
      .run({
        id: input.id,
        name: input.name,
        kind: input.kind,
        content: input.content,
        entityCount: facts.entityCount,
        byteSize: facts.byteSize,
        hasHatch: facts.hasHatch ? 1 : 0,
        markers: JSON.stringify(markers),
        origin: input.origin,
        now,
      });

    const saved = this.summary(input.id);

    if (saved === null) {
      // O que acabou de ser gravado não volta. Falhar alto é melhor
      // que devolver `null` e deixar a rota inventar um motivo.
      throw new Error(`a planta "${input.id}" não pôde ser lida logo após a escrita`);
    }

    this.#logger?.debug(
      {
        blueprint: input.id,
        entities: facts.entityCount,
        hasHatch: facts.hasHatch,
        vehicles: facts.vehicles,
        markers,
      },
      'planta gravada',
    );

    return { ok: true, blueprint: saved };
  }

  /**
   * Conta os marcadores das plantas gravadas antes da migração 099.
   *
   * Roda no boot e só toca as linhas com `markers` NULL: da segunda
   * subida em diante, não lê arquivo nenhum. Devolve quantas contou.
   * Uma planta cujo JSON não é mais legível fica NULL — a tela mostra
   * "não contado", e não um zero que ninguém mediu.
   */
  backfillMarkers(): number {
    const rows = this.#db
      .prepare('SELECT id, content FROM dungeon_blueprints WHERE markers IS NULL')
      .all() as { id: string; content: string }[];

    const update = this.#db.prepare('UPDATE dungeon_blueprints SET markers = ? WHERE id = ?');
    let counted = 0;

    for (const row of rows) {
      const parsed = parseBlueprint(row.content);

      if (!parsed.ok) continue;

      const body = analyzeBody(parsed.blueprint.entities);

      update.run(
        JSON.stringify({
          npc: body.markers.npc.length,
          crate: body.markers.crate.length,
          arrival: body.markers.arrival.length,
        }),
        row.id,
      );
      counted += 1;
    }

    if (counted > 0) this.#logger?.info({ counted }, 'marcadores das plantas antigas contados');

    return counted;
  }

  /** `false` = não existia. */
  remove(id: string): boolean {
    const result = this.#db.prepare('DELETE FROM dungeon_blueprints WHERE id = ?').run(id);

    return result.changes > 0;
  }

  /**
   * Quantas plantas existem.
   *
   * Serve ao seeder: ele só age num acervo vazio, para não
   * ressuscitar no boot uma planta que alguém apagou de propósito.
   */
  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM dungeon_blueprints').get() as {
      total: number;
    };

    return row.total;
  }
}

function toSummary(row: Row): BlueprintSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'base' ? 'base' : 'entrance',
    entityCount: row.entity_count,
    byteSize: row.byte_size,
    hasHatch: row.has_hatch === 1,
    markers: toMarkers(row.markers),
    origin: toOrigin(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A contagem gravada, ou `null` quando ela não existe ou está torta. */
function toMarkers(raw: string | null): BlueprintMarkerCounts | null {
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof BlueprintMarkerCounts, unknown>>;
    const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

    return { npc: count(parsed.npc), crate: count(parsed.crate), arrival: count(parsed.arrival) };
  } catch {
    return null;
  }
}

function toOrigin(raw: string): BlueprintOrigin {
  return raw === 'builtin' || raw === 'capture' ? raw : 'import';
}
