// ============================================================
//  workshop-repository.ts  -  o catálogo de skins.
//
//  ####  O PAINEL E O JOGO GRAVAM AQUI, E SÓ AQUI  ####
//
//  O `/skin add` do jogo não tem cópia própria: ele vira um pedido
//  ao agente, que grava por este mesmo `add` com `source: 'game'`.
//  É o que garante que "os cadastros feitos pelo jogo e pelo painel
//  utilizam os mesmos dados" — não há duas tabelas para divergir.
//
//  A tabela e o porquê de cada coluna estão nas migrações 095, 096,
//  097 e 100. Coleções e permissão por skin saíram na 097; a marca
//  "Skin de temporada" (`season`) entrou na 100.
//
//  ####  O CATÁLOGO É DA REDE; A JUNÇÃO DIZ ONDE VALE  ####
//
//  `workshop_skins` não tem `server_id`. Quem responde "esta skin
//  vale aqui?" é `workshop_skin_servers`: sem linha nenhuma = em
//  nenhum servidor.
//
//  ####  O ZOD RODA AQUI DENTRO TAMBÉM  ####
//
//  Não só na borda HTTP: o `/skin add` chega por outro caminho, e a
//  régua do `skinId` (nunca zero, nunca acima do UInt64) é a
//  diferença entre um item vanilla silencioso e uma recusa com
//  frase.
// ============================================================

import {
  WORKSHOP_RARITIES,
  workshopSkinInputSchema,
  type WorkshopRarity,
  type WorkshopSkin,
  type WorkshopSkinInput,
  type WorkshopSkinMeta,
  type WorkshopSkinSource,
} from '../types/workshop.js';
import type { AgentDatabase } from './database.js';

interface SkinRow {
  readonly id: number;
  readonly label: string;
  readonly shortname: string;
  readonly skin_id: string;
  readonly description: string | null;
  readonly rarity: string | null;
  readonly sort_order: number;
  readonly open_to_all: number;
  readonly hide_in_streamer: number;
  readonly enabled: number;
  readonly season: number;
  readonly source: string;
  readonly created_by: string | null;
  readonly workshop_title: string | null;
  readonly preview_url: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** A raridade lida, sempre dentro da lista (ou nula). */
function readRarity(value: string | null): WorkshopRarity | null {
  return (WORKSHOP_RARITIES as readonly string[]).includes(value ?? '') ? (value as WorkshopRarity) : null;
}

function toSkin(row: SkinRow, servers: readonly string[]): WorkshopSkin {
  return {
    id: row.id,
    label: row.label,
    shortname: row.shortname,
    skinId: row.skin_id,
    description: row.description === null || row.description === '' ? null : row.description,
    rarity: readRarity(row.rarity),
    sort: row.sort_order,
    openToAll: row.open_to_all === 1,
    hideInStreamer: row.hide_in_streamer === 1,
    enabled: row.enabled === 1,
    season: row.season === 1,
    servers: [...servers],
    source: (row.source === 'game' ? 'game' : 'panel') satisfies WorkshopSkinSource,
    createdBy: row.created_by,
    workshopTitle: row.workshop_title,
    previewUrl: row.preview_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A ordem da grade do menu (02 §4.1): `sort`, depois o nome. */
const SKIN_ORDER = 'sort_order ASC, label COLLATE NOCASE ASC, id ASC';

export class WorkshopSkinsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ======================================================
  //  Leitura
  // ======================================================

  /**
   * Todas, com os servidores de cada uma.
   *
   * Duas consultas, e não uma por linha: perguntar "onde esta
   * vale?" por skin seria o N+1 clássico da tela que lista tudo.
   */
  list(): readonly WorkshopSkin[] {
    const rows = this.#db
      .prepare(`SELECT * FROM workshop_skins ORDER BY ${SKIN_ORDER}`)
      .all() as SkinRow[];

    return this.#withServers(rows);
  }

  /**
   * As que AQUELE servidor recebe, e só as ligadas.
   *
   * É a consulta que alimenta o push: uma skin desligada não desce,
   * e uma que não está na junção daquele servidor não existe para
   * ele.
   */
  listForServer(serverId: string): readonly WorkshopSkin[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM workshop_skins s
           JOIN workshop_skin_servers j ON j.workshop_skin_id = s.id
          WHERE j.server_id = @server_id AND s.enabled = 1
          ORDER BY s.sort_order ASC, s.label COLLATE NOCASE ASC, s.id ASC`,
      )
      .all({ server_id: serverId }) as SkinRow[];

    return this.#withServers(rows);
  }

  get(id: number): WorkshopSkin | null {
    const row = this.#db.prepare('SELECT * FROM workshop_skins WHERE id = ?').get(id) as
      | SkinRow
      | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /** Várias de uma vez, por id. As que não existem ficam de fora. */
  getMany(ids: readonly number[]): ReadonlyMap<number, WorkshopSkin> {
    const wanted = new Set(ids);

    if (wanted.size === 0) return new Map();

    // O catálogo é pequeno (centenas); ler tudo e filtrar evita
    // montar um IN com milhares de parâmetros.
    return new Map(this.list().filter((skin) => wanted.has(skin.id)).map((skin) => [skin.id, skin]));
  }

  /**
   * A linha que já usa esta marca, se houver.
   *
   * É a chave natural da skin (04 §2): o `id` interno muda se ela for
   * recadastrada, o par `(shortname, workshopId)` não. A entrega do
   * site e o `/skin give` do jogo procuram por aqui.
   */
  findByMark(shortname: string, skinId: string): WorkshopSkin | null {
    const row = this.#db
      .prepare('SELECT * FROM workshop_skins WHERE shortname = ? AND skin_id = ?')
      .get(shortname, skinId) as SkinRow | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /** Em que servidores aquela skin vale. */
  serversOf(id: number): readonly string[] {
    return (
      this.#db
        .prepare(
          `SELECT server_id FROM workshop_skin_servers
            WHERE workshop_skin_id = ? ORDER BY server_id`,
        )
        .all(id) as { server_id: string }[]
    ).map((row) => row.server_id);
  }

  // ======================================================
  //  Escrita
  // ======================================================

  /**
   * Cadastra a skin e a liga aos servidores, numa transação.
   *
   * @throws ZodError quando a marca não passa na régua.
   * @throws quando a marca `(shortname, skinId)` já existe. Quem
   *         traduz isso numa frase é quem chama.
   */
  add(input: WorkshopSkinInput, meta: WorkshopSkinMeta, now: number = Date.now()): WorkshopSkin {
    const value = workshopSkinInputSchema.parse(input);

    let id = 0;

    this.#db.transaction((): void => {
      const result = this.#db
        .prepare(
          `INSERT INTO workshop_skins
             (label, shortname, skin_id, description, rarity, sort_order, open_to_all,
              hide_in_streamer, enabled, season, source, created_by, workshop_title, preview_url,
              created_at, updated_at)
           VALUES
             (@label, @shortname, @skin_id, @description, @rarity, @sort_order, @open_to_all,
              @hide_in_streamer, @enabled, @season, @source, @created_by, @workshop_title, @preview_url,
              @now, @now)`,
        )
        .run({
          ...skinColumns(value),
          source: meta.source,
          created_by: meta.createdBy,
          workshop_title: meta.workshopTitle,
          preview_url: meta.previewUrl,
          now,
        });

      id = Number(result.lastInsertRowid);

      this.#replaceServers(id, value.servers);
    })();

    return this.#mustGet(id);
  }

  /**
   * Reescreve a skin inteira.
   *
   * PUT, e não PATCH: a tela edita num formulário só e manda tudo.
   * Um merge parcial abriria "o que acontece com os servidores que
   * não vieram?", e a única resposta segura seria não mexer — o
   * oposto do que espera quem desmarcou um na tela.
   *
   * O título e a prévia do Workshop só são trocados quando vêm:
   * `undefined` preserva o que a Steam disse da última vez.
   *
   * @returns `null` quando o id não existe.
   */
  update(
    id: number,
    input: WorkshopSkinInput,
    steam?: Pick<WorkshopSkinMeta, 'workshopTitle' | 'previewUrl'>,
    now: number = Date.now(),
  ): WorkshopSkin | null {
    const value = workshopSkinInputSchema.parse(input);
    const current = this.get(id);

    if (current === null) return null;

    this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE workshop_skins SET
             label            = @label,
             shortname        = @shortname,
             skin_id          = @skin_id,
             description      = @description,
             rarity           = @rarity,
             sort_order       = @sort_order,
             open_to_all      = @open_to_all,
             hide_in_streamer = @hide_in_streamer,
             enabled          = @enabled,
             season           = @season,
             workshop_title   = @workshop_title,
             preview_url      = @preview_url,
             updated_at       = @now
           WHERE id = @id`,
        )
        .run({
          id,
          ...skinColumns(value),
          workshop_title: steam?.workshopTitle ?? current.workshopTitle,
          preview_url: steam?.previewUrl ?? current.previewUrl,
          now,
        });

      this.#replaceServers(id, value.servers);
    })();

    return this.get(id);
  }

  /**
   * Troca só a lista de servidores.
   *
   * A tela marca e desmarca servidores sem ter o cadastro inteiro na
   * mão — mandar o formulário de volta só para mexer numa caixa de
   * seleção é como se perde o que outra pessoa salvou no meio.
   *
   * @returns `null` quando a skin não existe.
   */
  setServers(id: number, servers: readonly string[]): readonly string[] | null {
    if (this.get(id) === null) return null;

    this.#db.transaction((): void => {
      this.#replaceServers(id, servers);
      this.#db
        .prepare('UPDATE workshop_skins SET updated_at = ? WHERE id = ?')
        .run(Date.now(), id);
    })();

    return this.serversOf(id);
  }

  /**
   * Apaga.
   *
   * A cascata leva as ligações de servidor e as POSSES junto. O que
   * ela NÃO desfaz é o que já está no mundo: um item pintado continua
   * pintado, porque quem guarda a marca é o item.
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM workshop_skins WHERE id = ?').run(id).changes > 0;
  }

  // ======================================================
  //  Privados
  // ======================================================

  #mustGet(id: number): WorkshopSkin {
    const saved = this.get(id);

    // Ela acabou de ser gravada numa transação que não lançou: só
    // chegaria aqui um banco corrompido, e é melhor dizer isso alto.
    if (saved === null) {
      throw new Error(`a skin ${String(id)} sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  #withServers(rows: readonly SkinRow[]): readonly WorkshopSkin[] {
    if (rows.length === 0) return [];

    const bySkin = new Map<number, string[]>();

    for (const link of this.#db
      .prepare(
        `SELECT workshop_skin_id, server_id FROM workshop_skin_servers
          ORDER BY workshop_skin_id, server_id`,
      )
      .all() as { workshop_skin_id: number; server_id: string }[]) {
      const list = bySkin.get(link.workshop_skin_id);

      if (list === undefined) {
        bySkin.set(link.workshop_skin_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    return rows.map((row) => toSkin(row, bySkin.get(row.id) ?? []));
  }

  #replaceServers(id: number, servers: readonly string[]): void {
    this.#db
      .prepare('DELETE FROM workshop_skin_servers WHERE workshop_skin_id = @id')
      .run({ id });

    const insert = this.#db.prepare(
      `INSERT OR IGNORE INTO workshop_skin_servers (workshop_skin_id, server_id)
       VALUES (@id, @server_id)`,
    );

    for (const serverId of new Set(servers)) {
      insert.run({ id, server_id: serverId });
    }
  }
}

function skinColumns(input: WorkshopSkinInput): Record<string, unknown> {
  return {
    label: input.label,
    shortname: input.shortname,
    skin_id: input.skinId,
    description: input.description,
    rarity: input.rarity,
    sort_order: input.sort,
    open_to_all: input.openToAll ? 1 : 0,
    hide_in_streamer: input.hideInStreamer ? 1 : 0,
    enabled: input.enabled ? 1 : 0,
    season: input.season ? 1 : 0,
  };
}
