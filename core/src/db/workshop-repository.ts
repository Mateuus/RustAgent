// ============================================================
//  workshop-repository.ts  -  o catálogo de skins do Workshop.
//
//  ####  ELE É PRIMO DO custom-items-repository.ts  ####
//
//  A forma do dado é a mesma — um id nosso, um item base, um
//  número de skin, e em que servidores vale. A diferença é o que
//  cada um representa: lá o item é NOSSO (nome, ícone, ação
//  própria); aqui o item é o DO JOGO com outra aparência. Ver o §5
//  do Docs/OrigemZWorkshop/00-LEVANTAMENTO.md.
//
//  A tabela e o porquê de cada coluna estão na migração 095.
//
//  ####  O CATÁLOGO É DA REDE; A JUNÇÃO DIZ ONDE VALE  ####
//
//  `workshop_skins` não tem `server_id`. Quem responde "esta skin
//  vale aqui?" é `workshop_skin_servers`, e a regra herdada da 041
//  é: sem linha nenhuma = em nenhum servidor.
//
//  ####  O ZOD RODA AQUI DENTRO TAMBÉM  ####
//
//  Não só na borda HTTP. O `add` e o `update` reparseiam o que
//  recebem porque este repositório é chamado por testes, por
//  scripts e — um dia — por uma importação em lote, e a régua do
//  `skinId` (nunca zero, nunca acima do UInt64) é a diferença
//  entre um item vanilla silencioso e um cadastro recusado com
//  frase.
// ============================================================

import {
  normalizePermission,
  workshopSkinInputSchema,
  type WorkshopSkin,
  type WorkshopSkinInput,
} from '../types/workshop.js';
import type { AgentDatabase } from './database.js';

interface Row {
  readonly id: number;
  readonly label: string;
  readonly shortname: string;
  readonly skin_id: string;
  readonly permission: string;
  readonly hide_in_streamer: number;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * A permissão da linha, sempre no formato da feature.
 *
 * ####  UMA COLUNA MEXIDA À MÃO NÃO PODE VIRAR "TODO MUNDO"  ####
 *
 * O CHECK do banco recusa o texto vazio, mas não recusa
 * `PEDRA OrigemZ` — e uma permissão com espaço atravessa o
 * console do Rust como dois argumentos, o que faz o plugin
 * registrar outra coisa. Normalizar na LEITURA é o que garante
 * que o que sai no push é sempre uma permissão de verdade,
 * qualquer que tenha sido o caminho que a gravou.
 */
function toSkin(row: Row, servers: readonly string[]): WorkshopSkin {
  return {
    id: row.id,
    label: row.label,
    shortname: row.shortname,
    skinId: row.skin_id,
    permission: normalizePermission(row.permission),
    hideInStreamer: row.hide_in_streamer === 1,
    enabled: row.enabled === 1,
    // Copia: o tipo do dominio guarda uma lista mutavel, e o
    // `readonly` daqui e so da fronteira.
    servers: [...servers],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkshopSkinsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * Todas, com os servidores de cada uma.
   *
   * ####  DUAS CONSULTAS, E NÃO UMA POR LINHA  ####
   *
   * A lista e as ligações de todas. Perguntar "onde esta vale?"
   * por linha seria o N+1 clássico desta tela — que é justamente a
   * que lista tudo de uma vez.
   */
  list(): readonly WorkshopSkin[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM workshop_skins
          ORDER BY label COLLATE NOCASE ASC, id ASC`,
      )
      .all() as Row[];

    return this.#withServers(rows);
  }

  /**
   * As que AQUELE servidor recebe, e só as ligadas.
   *
   * É esta a consulta que alimenta o push: uma skin desligada não
   * é empurrada, e uma skin que não está na junção daquele
   * servidor não existe para ele.
   */
  listForServer(serverId: string): readonly WorkshopSkin[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM workshop_skins s
           JOIN workshop_skin_servers j ON j.workshop_skin_id = s.id
          WHERE j.server_id = @server_id AND s.enabled = 1
          ORDER BY s.label COLLATE NOCASE ASC, s.id ASC`,
      )
      .all({ server_id: serverId }) as Row[];

    return this.#withServers(rows);
  }

  get(id: number): WorkshopSkin | null {
    const row = this.#db.prepare('SELECT * FROM workshop_skins WHERE id = ?').get(id) as
      | Row
      | undefined;

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

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Cadastra a skin e a liga aos servidores, numa transação.
   *
   * As duas coisas juntas porque uma skin ligada a servidor nenhum
   * não chega a lugar nenhum — e isso não parece falha, que é o
   * que a torna pior que uma falha.
   *
   * @throws ZodError quando a marca não passa na régua.
   * @throws quando a marca `(shortname, skinId)` ou a permissão já
   *         existem. O `UNIQUE` recusa, e quem traduz isso numa
   *         frase é a rota.
   */
  add(input: WorkshopSkinInput, now: number = Date.now()): WorkshopSkin {
    const value = workshopSkinInputSchema.parse(input);

    let id = 0;

    const run = this.#db.transaction((): void => {
      const result = this.#db
        .prepare(
          `INSERT INTO workshop_skins
             (label, shortname, skin_id, permission, hide_in_streamer, enabled,
              created_at, updated_at)
           VALUES
             (@label, @shortname, @skin_id, @permission, @hide_in_streamer, @enabled,
              @now, @now)`,
        )
        .run({ ...toColumns(value), now });

      id = Number(result.lastInsertRowid);

      this.#replaceServers(id, value.servers);
    });

    run();

    const saved = this.get(id);

    // Ela acabou de ser gravada dentro de uma transação que não
    // lançou: só chegaria aqui um banco corrompido, e é melhor
    // dizer isso alto que devolver `null` para quem não espera.
    if (saved === null) {
      throw new Error(`a skin ${String(id)} sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  /**
   * Reescreve a skin inteira.
   *
   * PUT, e não PATCH: a tela edita num formulário só e manda tudo.
   * Um merge parcial abriria a pergunta "o que acontece com os
   * servidores que não vieram?", e a única resposta segura seria
   * não mexer — o oposto do que espera quem desmarcou um na tela.
   *
   * @returns `null` quando o id não existe.
   */
  update(id: number, input: WorkshopSkinInput, now: number = Date.now()): WorkshopSkin | null {
    const value = workshopSkinInputSchema.parse(input);

    if (this.get(id) === null) return null;

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE workshop_skins SET
             label            = @label,
             shortname        = @shortname,
             skin_id          = @skin_id,
             permission       = @permission,
             hide_in_streamer = @hide_in_streamer,
             enabled          = @enabled,
             updated_at       = @now
           WHERE id = @id`,
        )
        .run({ id, ...toColumns(value), now });

      this.#replaceServers(id, value.servers);
    });

    run();

    return this.get(id);
  }

  /**
   * Troca só a lista de servidores.
   *
   * Existe separado do `update` porque a tela de um SERVIDOR marca
   * e desmarca skins sem ter o cadastro inteiro na mão — e mandar
   * o resto do formulário de volta só para mexer numa caixa de
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
   * A cascata leva as ligações de servidor junto. O que ela NÃO
   * desfaz é o que já está no mundo: um item que nasceu com a
   * skin continua com ela, porque quem guarda a marca é o item.
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM workshop_skins WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  #withServers(rows: readonly Row[]): readonly WorkshopSkin[] {
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

    // O `Set` porque a tela pode mandar o mesmo servidor duas vezes
    // e o `INSERT OR IGNORE` engoliria em silêncio — melhor não
    // chegar lá.
    for (const serverId of new Set(servers)) {
      insert.run({ id, server_id: serverId });
    }
  }
}

function toColumns(input: WorkshopSkinInput): Record<string, unknown> {
  return {
    label: input.label,
    shortname: input.shortname,
    skin_id: input.skinId,
    permission: input.permission,
    hide_in_streamer: input.hideInStreamer ? 1 : 0,
    enabled: input.enabled ? 1 : 0,
  };
}
