// ============================================================
//  rules-repository.ts  -  as regras que o jogador lê no /menu.
//
//  Duas metades, e a segunda é a que costuma faltar:
//
//      o CONJUNTO      seções e itens, de um escopo
//      o ESCOPO        de qual conjunto aquele servidor lê
//
//  ####  O ESCOPO É EXPLÍCITO, E NÃO DEDUZIDO  ####
//
//  Seria tentador dizer "o servidor que tem seção própria usa a
//  dele". Isso faria a primeira seção criada num servidor apagar as
//  da rede da tela dele no mesmo instante — um efeito que o admin
//  não pediu e que só apareceria no jogo.
//
//  Aqui ele escolhe: `inherit` (o padrão, e o que todo servidor
//  antigo é) ou `own`. E `own` com zero seção é uma página de
//  regras vazia, que é uma escolha legítima — não um estado pela
//  metade a ser consertado.
//
//  Ver types/rules.ts e a migração 083.
// ============================================================

import {
  RULES_TEMPLATE,
  type RuleItem,
  type RuleItemInput,
  type RuleSection,
  type RuleSectionInput,
  type RulesScopeMode,
  type RuleTone,
  type RulesView,
} from '../types/rules.js';

import type { AgentDatabase } from './database.js';

/** O passo da coluna `position`, para caber alguém no meio. */
export const POSITION_STEP = 10;

/**
 * O recorte do escopo, escrito UMA vez.
 *
 * ####  O `IS NULL` TINHA DE CABER NO MESMO SQL  ####
 *
 * Trocar a cláusula conforme o escopo (`server_id IS NULL` ou
 * `server_id = @server_id`) deixa de fora o parâmetro no primeiro
 * caso — e o better-sqlite3 RECUSA um parâmetro nomeado que a
 * consulta não usa, com um erro que só aparece no primeiro
 * servidor que herdar. Assim a consulta é uma só, e o parâmetro
 * viaja sempre.
 */
const SCOPE_WHERE = '((@server_id IS NULL AND server_id IS NULL) OR server_id = @server_id)';

interface SectionRow {
  readonly id: number;
  readonly server_id: string | null;
  readonly title: string;
  readonly position: number;
  readonly enabled: number;
}

interface ItemRow {
  readonly id: number;
  readonly section_id: number;
  readonly text: string;
  readonly tone: string;
  readonly position: number;
}

/**
 * De quem é o conjunto.
 *
 * `null` é a REDE. Um `string` é o id do servidor — e o tipo é o
 * mesmo do parâmetro do SQL de propósito: o `IS NULL` e o `= @x`
 * são o mesmo caminho, escrito uma vez em `#scopeWhere`.
 */
export type RulesScope = string | null;

export class RulesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  A LEITURA
  // ------------------------------------------------------

  /**
   * As seções de um escopo, com os itens dentro.
   *
   * `onlyEnabled` é do JOGO: o painel precisa ver a seção
   * desligada para poder religá-la, e o jogador não.
   */
  sections(scope: RulesScope, options: { readonly onlyEnabled?: boolean } = {}): RuleSection[] {
    const rows = this.#db
      .prepare(
        `SELECT id, server_id, title, position, enabled
           FROM rules_sections
          WHERE ${SCOPE_WHERE}
            ${options.onlyEnabled === true ? 'AND enabled = 1' : ''}
          ORDER BY position ASC, id ASC`,
      )
      .all({ server_id: scope }) as SectionRow[];

    if (rows.length === 0) {
      return [];
    }

    // Uma consulta para todos os itens, e não uma por seção: são
    // quatro ou cinco seções na prática, mas esta leitura roda a
    // cada abertura da aba REGRAS de cada jogador.
    const items = this.#db
      .prepare(
        `SELECT id, section_id, text, tone, position
           FROM rules_items
          WHERE section_id IN (SELECT value FROM json_each(@ids))
          ORDER BY position ASC, id ASC`,
      )
      .all({ ids: JSON.stringify(rows.map((row) => row.id)) }) as ItemRow[];

    const bySection = new Map<number, RuleItem[]>();

    for (const item of items) {
      const list = bySection.get(item.section_id) ?? [];

      list.push({
        id: item.id,
        text: item.text,
        tone: item.tone as RuleTone,
        position: item.position,
      });
      bySection.set(item.section_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      enabled: row.enabled === 1,
      position: row.position,
      items: bySection.get(row.id) ?? [],
    }));
  }

  /** De onde este servidor lê. Sem linha na tabela, ele herda. */
  modeOf(serverId: string): RulesScopeMode {
    const row = this.#db
      .prepare('SELECT mode FROM rules_scopes WHERE server_id = @server_id')
      .get({ server_id: serverId }) as { readonly mode: string } | undefined;

    return row?.mode === 'own' ? 'own' : 'inherit';
  }

  /**
   * O que ESTE servidor mostra no jogo, já resolvido.
   *
   * É a única leitura que a tela do jogo faz: quem chama não
   * precisa saber que existem dois conjuntos.
   */
  viewFor(serverId: string, options: { readonly onlyEnabled?: boolean } = {}): RulesView {
    const mode = this.modeOf(serverId);

    return { mode, sections: this.sections(mode === 'own' ? serverId : null, options) };
  }

  // ------------------------------------------------------
  //  O ESCOPO
  // ------------------------------------------------------

  setMode(serverId: string, mode: RulesScopeMode, now: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO rules_scopes (server_id, mode, updated_at)
         VALUES (@server_id, @mode, @updated_at)
         ON CONFLICT (server_id) DO UPDATE SET mode = @mode, updated_at = @updated_at`,
      )
      .run({ server_id: serverId, mode, updated_at: now });
  }

  // ------------------------------------------------------
  //  A ESCRITA
  // ------------------------------------------------------

  createSection(scope: RulesScope, input: RuleSectionInput, now: number = Date.now()): number {
    const result = this.#db
      .prepare(
        `INSERT INTO rules_sections (server_id, title, position, enabled, created_at, updated_at)
         VALUES (@server_id, @title, @position, @enabled, @created_at, @created_at)`,
      )
      .run({
        server_id: scope,
        title: input.title,
        position: this.#nextSectionPosition(scope),
        enabled: input.enabled ? 1 : 0,
        created_at: now,
      });

    return Number(result.lastInsertRowid);
  }

  updateSection(id: number, input: RuleSectionInput, now: number = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `UPDATE rules_sections
            SET title = @title, enabled = @enabled, updated_at = @updated_at
          WHERE id = @id`,
      )
      .run({ id, title: input.title, enabled: input.enabled ? 1 : 0, updated_at: now });

    return result.changes > 0;
  }

  /** Apaga a seção e, com ela, as regras dentro (ON DELETE CASCADE). */
  deleteSection(id: number): boolean {
    return this.#db.prepare('DELETE FROM rules_sections WHERE id = @id').run({ id }).changes > 0;
  }

  /** O escopo a que a seção pertence. `undefined` = não existe. */
  scopeOfSection(id: number): RulesScope | undefined {
    const row = this.#db
      .prepare('SELECT server_id FROM rules_sections WHERE id = @id')
      .get({ id }) as { readonly server_id: string | null } | undefined;

    return row === undefined ? undefined : row.server_id;
  }

  createItem(sectionId: number, input: RuleItemInput, now: number = Date.now()): number {
    const result = this.#db
      .prepare(
        `INSERT INTO rules_items (section_id, text, tone, position, created_at, updated_at)
         VALUES (@section_id, @text, @tone, @position, @created_at, @created_at)`,
      )
      .run({
        section_id: sectionId,
        text: input.text,
        tone: input.tone,
        position: this.#nextItemPosition(sectionId),
        created_at: now,
      });

    return Number(result.lastInsertRowid);
  }

  updateItem(id: number, input: RuleItemInput, now: number = Date.now()): boolean {
    const result = this.#db
      .prepare(
        'UPDATE rules_items SET text = @text, tone = @tone, updated_at = @updated_at WHERE id = @id',
      )
      .run({ id, text: input.text, tone: input.tone, updated_at: now });

    return result.changes > 0;
  }

  deleteItem(id: number): boolean {
    return this.#db.prepare('DELETE FROM rules_items WHERE id = @id').run({ id }).changes > 0;
  }

  /**
   * Troca a ordem das seções de um escopo.
   *
   * Recebe a fila COMPLETA, como o `reorder` das mensagens: com
   * duas telas abertas, um "mova para cima" de cada uma produz uma
   * ordem que ninguém pediu. Quem não veio fica no fim, na ordem
   * em que estava.
   */
  reorderSections(scope: RulesScope, ids: readonly number[], now: number = Date.now()): void {
    this.#reorder({
      table: 'rules_sections',
      where: '((@parent IS NULL AND server_id IS NULL) OR server_id = @parent)',
      parent: scope,
      ids,
      now,
    });
  }

  /** A mesma troca, para as regras de uma seção. */
  reorderItems(sectionId: number, ids: readonly number[], now: number = Date.now()): void {
    this.#reorder({
      table: 'rules_items',
      where: 'section_id = @parent',
      parent: sectionId,
      ids,
      now,
    });
  }

  /**
   * Copia um conjunto inteiro para outro escopo.
   *
   * É o que faz "começar do conjunto da rede" custar um clique em
   * vez de uma tarde de digitação — e é o caminho normal de quem
   * vai ter regras próprias parecidas com as de todo mundo.
   *
   * Acrescenta ao que já existe no destino; não apaga nada. Quem
   * quer trocar apaga antes, e é uma ação que tem de ser dela.
   */
  copySections(from: RulesScope, to: RulesScope, now: number = Date.now()): number {
    const sections = this.sections(from);

    const run = this.#db.transaction((): number => {
      let copied = 0;

      for (const section of sections) {
        const id = this.createSection(to, { title: section.title, enabled: section.enabled }, now);

        for (const item of section.items) {
          this.createItem(id, { text: item.text, tone: item.tone }, now);
        }

        copied += 1;
      }

      return copied;
    });

    return run();
  }

  /**
   * Escreve o modelo de fábrica num escopo vazio.
   *
   * Só é oferecido pelo painel, e só vence a página em branco: o
   * texto entra como rascunho de quem vai reescrevê-lo. Ver
   * `RULES_TEMPLATE` em types/rules.ts para por que ele não é
   * semeado na migração.
   */
  seedTemplate(scope: RulesScope, now: number = Date.now()): number {
    const run = this.#db.transaction((): number => {
      for (const section of RULES_TEMPLATE) {
        const id = this.createSection(scope, { title: section.title, enabled: true }, now);

        for (const item of section.items) {
          this.createItem(id, { text: item.text, tone: item.tone }, now);
        }
      }

      return RULES_TEMPLATE.length;
    });

    return run();
  }

  // ------------------------------------------------------
  //  O que ninguém de fora precisa saber
  // ------------------------------------------------------

  #nextSectionPosition(scope: RulesScope): number {
    const row = this.#db
      .prepare(
        `SELECT MAX(position) AS top FROM rules_sections WHERE ${SCOPE_WHERE}`,
      )
      .get({ server_id: scope }) as { readonly top: number | null };

    return (row.top ?? 0) + POSITION_STEP;
  }

  #nextItemPosition(sectionId: number): number {
    const row = this.#db
      .prepare('SELECT MAX(position) AS top FROM rules_items WHERE section_id = @section_id')
      .get({ section_id: sectionId }) as { readonly top: number | null };

    return (row.top ?? 0) + POSITION_STEP;
  }

  #reorder(input: {
    readonly table: 'rules_sections' | 'rules_items';
    readonly where: string;
    readonly parent: RulesScope | number;
    readonly ids: readonly number[];
    readonly now: number;
  }): void {
    const run = this.#db.transaction((): void => {
      const update = this.#db.prepare(
        `UPDATE ${input.table} SET position = @position, updated_at = @updated_at WHERE id = @id`,
      );

      let position = POSITION_STEP;

      for (const id of input.ids) {
        update.run({ id, position, updated_at: input.now });
        position += POSITION_STEP;
      }

      const rest = this.#db
        .prepare(
          `SELECT id FROM ${input.table}
            WHERE ${input.where}
              AND id NOT IN (SELECT value FROM json_each(@ids))
            ORDER BY position ASC, id ASC`,
        )
        .all({ parent: input.parent, ids: JSON.stringify([...input.ids]) }) as {
        readonly id: number;
      }[];

      for (const row of rest) {
        update.run({ id: row.id, position, updated_at: input.now });
        position += POSITION_STEP;
      }
    });

    run();
  }
}
