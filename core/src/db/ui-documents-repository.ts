// ============================================================
//  ui-documents-repository.ts  -  as interfaces do jogo.
//
//  Cada linha de `ui_documents` é um menu: o comando que o abre, a
//  permissão que ele exige, e o desenho inteiro em JSON. Cada
//  linha de `server_ui` é um servidor dizendo qual menu usa e o
//  que esconde dele.
//
//  ------------------------------------------------------------
//  ####  O DOCUMENTO É GRAVADO E LIDO INTEIRO  ####
//
//  Não há escrita parcial, e isso não é limitação: um documento
//  pela metade é uma interface quebrada no jogo de quem abrir o
//  menu no instante seguinte. O editor edita em memória e manda o
//  conjunto completo.
//
//  ####  O JSON DA COLUNA É VALIDADO NA LEITURA  ####
//
//  O banco guarda texto, então nada impede uma edição à mão deixar
//  ali algo que não é um documento. Ler sem validar faria esse
//  texto atravessar o agente e chegar ao plugin, onde o defeito
//  apareceria longe da causa. Por isso `get` passa pelo schema, e
//  a linha ilegível é DESCARTADA com aviso no log em vez de
//  derrubar a listagem inteira.
//
//  ####  O `slug` É O `id` DO DOCUMENTO  ####
//
//  E não um terceiro identificador. O `id` do JSON é o que viaja
//  para o plugin (ele indexa o cache por ele) e o que o botão
//  carrega; o `slug` é o mesmo valor, promovido a coluna para o
//  banco poder exigir unicidade e para a URL do editor ter um nome
//  legível. Dois nomes para a mesma coisa seriam dois nomes para
//  divergir.
//
//  A chave numérica (`ui_documents.id`) é outra coisa: é ela que
//  `server_ui` referencia, porque renomear o slug de um documento
//  não pode desligá-lo dos servidores que já o usam.
// ============================================================

import type { Logger } from '../logger.js';
import { uiDocumentSchema, type UiDocument } from '../types/ui-document.js';
import type { AgentDatabase } from './database.js';

/** O documento com o que só o banco sabe. Datas em epoch ms. */
export interface StoredUiDocument {
  /** A chave numérica. É ela que `server_ui` referencia. */
  readonly id: number;
  /** O mesmo valor de `document.id`. Ver o cabeçalho. */
  readonly slug: string;
  readonly name: string;
  /** Sobe a cada gravação. Diz ao servidor que ele está velho. */
  readonly revision: number;
  readonly document: UiDocument;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A forma resumida, para a listagem.
 *
 * Existe porque a lista do painel não precisa da árvore inteira:
 * mostrar dez menus traria dez documentos completos, e o desenho é
 * a maior parte do peso de cada um.
 */
export interface UiDocumentSummary {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly command: string;
  readonly revision: number;
  readonly screens: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Quem usa este documento, e em que revisão cada um está. */
  readonly servers: readonly ServerUiBinding[];
}

/** O que UM servidor faz com UM documento. */
export interface ServerUiBinding {
  readonly serverId: string;
  readonly documentId: number;
  /** `false` = escolhido, mas não empurrado. Ver a migração 008. */
  readonly enabled: boolean;
  /** Os ids de elementos e telas que ESTE servidor não mostra. */
  readonly hidden: readonly string[];
  /** A revisão que está no jogo. `null` = nunca foi aplicada. */
  readonly appliedRevision: number | null;
  readonly appliedAt: number | null;
}

interface DocumentRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly document: string;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SummaryRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly command: string | null;
  readonly revision: number;
  readonly screens: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface BindingRow {
  readonly server_id: string;
  readonly document_id: number;
  readonly enabled: number;
  readonly hidden: string;
  readonly applied_revision: number | null;
  readonly applied_at: number | null;
}

export class UiDocumentsRepository {
  readonly #db: AgentDatabase;
  readonly #logger: Logger | undefined;

  constructor(db: AgentDatabase, logger?: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  // ------------------------------------------------------
  //  Documentos
  // ------------------------------------------------------

  /**
   * A lista, com quem usa cada documento.
   *
   * `json_extract` e `json_array_length` fazem o SQLite abrir o
   * JSON só para contar as telas e pegar o comando — sem trazer o
   * documento inteiro para o processo, que é o peso de cada linha.
   *
   * As ligações vêm numa consulta só, e não uma por documento: com
   * dez menus e seis servidores, o N+1 daqui seria sessenta idas ao
   * banco por abertura de tela.
   */
  list(): readonly UiDocumentSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT id, slug, name, revision, created_at, updated_at,
                json_extract(document, '$.command')      AS command,
                json_array_length(document, '$.screens') AS screens
           FROM ui_documents
          ORDER BY name COLLATE NOCASE`,
      )
      .all() as SummaryRow[];

    const byDocument = new Map<number, ServerUiBinding[]>();

    for (const binding of this.#allBindings()) {
      const list = byDocument.get(binding.documentId);

      if (list === undefined) {
        byDocument.set(binding.documentId, [binding]);
      } else {
        list.push(binding);
      }
    }

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      // Documento corrompido não tem comando legível. Vazio é
      // honesto: diz "não consegui ler", e o `get` devolve o erro
      // de verdade.
      command: row.command ?? '',
      revision: row.revision,
      screens: row.screens ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      servers: byDocument.get(row.id) ?? [],
    }));
  }

  get(id: number): StoredUiDocument | null {
    const row = this.#db.prepare('SELECT * FROM ui_documents WHERE id = @id').get({ id }) as
      | DocumentRow
      | undefined;

    return row === undefined ? null : this.#toStored(row);
  }

  getBySlug(slug: string): StoredUiDocument | null {
    const row = this.#db.prepare('SELECT * FROM ui_documents WHERE slug = @slug').get({ slug }) as
      | DocumentRow
      | undefined;

    return row === undefined ? null : this.#toStored(row);
  }

  /**
   * Cria um documento. A revisão nasce em 1.
   *
   * O `slug` sai do `document.id` — ver o cabeçalho. Um id repetido
   * bate no UNIQUE da tabela, e quem chama traduz isso em 409.
   */
  create(document: UiDocument, now: number = Date.now()): StoredUiDocument {
    const result = this.#db
      .prepare(
        `INSERT INTO ui_documents (slug, name, document, revision, created_at, updated_at)
              VALUES (@slug, @name, @document, 1, @now, @now)`,
      )
      .run({ slug: document.id, name: document.name, document: JSON.stringify(document), now });

    const created = this.get(Number(result.lastInsertRowid));

    if (created === null) {
      // O que acabou de ser gravado não passa no próprio schema.
      // Falhar alto é melhor que devolver `null` e deixar a rota
      // inventar um motivo.
      throw new Error(`o documento "${document.id}" não pôde ser lido logo após a criação`);
    }

    return created;
  }

  /**
   * Grava por cima e SOBE a revisão.
   *
   * ####  `created_at` NÃO ENTRA NO UPDATE  ####
   *
   * É o mesmo documento, reeditado. Sobrescrevê-lo com a hora do
   * salvamento apagaria a única informação de quando ele passou a
   * existir.
   *
   * O `slug` também não muda: ele é a identidade com que o plugin
   * indexa o cache e com que o botão navega. Trocá-lo numa edição
   * seria trocar o endereço de tudo o que aponta para cá, em
   * silêncio.
   *
   * `null` = não existe documento com esse id.
   */
  update(id: number, document: UiDocument, now: number = Date.now()): StoredUiDocument | null {
    const result = this.#db
      .prepare(
        `UPDATE ui_documents
            SET name       = @name,
                document   = @document,
                revision   = revision + 1,
                updated_at = @now
          WHERE id = @id`,
      )
      .run({ id, name: document.name, document: JSON.stringify(document), now });

    return result.changes === 0 ? null : this.get(id);
  }

  /**
   * Apaga o documento.
   *
   * As linhas de `server_ui` vão junto pela cascata: sem documento,
   * "o que este servidor esconde dele" não tem sobre o que falar.
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM ui_documents WHERE id = @id').run({ id }).changes > 0;
  }

  // ------------------------------------------------------
  //  O que cada servidor usa
  // ------------------------------------------------------

  bindingsOf(serverId: string): readonly ServerUiBinding[] {
    const rows = this.#db
      .prepare('SELECT * FROM server_ui WHERE server_id = @server_id')
      .all({ server_id: serverId }) as BindingRow[];

    return rows.map((row) => this.#toBinding(row));
  }

  /**
   * Os documentos que ESTE servidor empurra.
   *
   * Documento ilegível fica de FORA em silêncio: o aviso já saiu no
   * log da leitura, e derrubar a carga inteira por causa de um
   * documento quebrado tiraria os outros menus do ar junto.
   */
  documentsFor(
    serverId: string,
  ): readonly { readonly stored: StoredUiDocument; readonly binding: ServerUiBinding }[] {
    const out: { stored: StoredUiDocument; binding: ServerUiBinding }[] = [];

    for (const binding of this.bindingsOf(serverId)) {
      if (!binding.enabled) {
        continue;
      }

      const stored = this.get(binding.documentId);

      if (stored !== null) {
        out.push({ stored, binding });
      }
    }

    return out;
  }

  /**
   * Define o que este servidor usa daquele documento.
   *
   * Upsert, e não INSERT: religar um documento desligado precisa
   * preservar a lista de escondidos — apagar a linha para desligar
   * faria "desliguei para testar" custar a reconfiguração inteira.
   *
   * `applied_revision` NÃO é tocado aqui: ela responde "o que está
   * no jogo", e mudar a configuração não muda o que já foi
   * empurrado. Quem a escreve é `markApplied`, depois do envio.
   */
  setBinding(
    serverId: string,
    documentId: number,
    options: { readonly enabled: boolean; readonly hidden: readonly string[] },
  ): ServerUiBinding {
    this.#db
      .prepare(
        `INSERT INTO server_ui (server_id, document_id, enabled, hidden)
              VALUES (@server_id, @document_id, @enabled, @hidden)
         ON CONFLICT (server_id, document_id) DO UPDATE SET
              enabled = excluded.enabled,
              hidden  = excluded.hidden`,
      )
      .run({
        server_id: serverId,
        document_id: documentId,
        enabled: options.enabled ? 1 : 0,
        hidden: JSON.stringify([...options.hidden]),
      });

    const row = this.#db
      .prepare('SELECT * FROM server_ui WHERE server_id = @server_id AND document_id = @document_id')
      .get({ server_id: serverId, document_id: documentId }) as BindingRow | undefined;

    if (row === undefined) {
      throw new Error(
        `a configuração de interface de "${serverId}" não pôde ser lida logo após a gravação`,
      );
    }

    return this.#toBinding(row);
  }

  /** Desfaz a escolha: este servidor não usa mais nenhum menu. */
  clearBindings(serverId: string): void {
    this.#db.prepare('DELETE FROM server_ui WHERE server_id = @server_id').run({
      server_id: serverId,
    });
  }

  /**
   * Carimba a revisão que ACABOU de entrar no jogo.
   *
   * É o que responde "este servidor está com a versão de agora ou
   * com a de anteontem?" sem perguntar ao plugin — e a resposta
   * continua valendo com o servidor parado.
   */
  markApplied(
    serverId: string,
    documentId: number,
    revision: number,
    at: number = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE server_ui
            SET applied_revision = @revision,
                applied_at       = @at
          WHERE server_id = @server_id AND document_id = @document_id`,
      )
      .run({ server_id: serverId, document_id: documentId, revision, at });
  }

  #allBindings(): readonly ServerUiBinding[] {
    const rows = this.#db.prepare('SELECT * FROM server_ui ORDER BY server_id').all() as BindingRow[];

    return rows.map((row) => this.#toBinding(row));
  }

  #toBinding(row: BindingRow): ServerUiBinding {
    return {
      serverId: row.server_id,
      documentId: row.document_id,
      enabled: row.enabled === 1,
      hidden: parseHidden(row.hidden, this.#logger, row.server_id),
      appliedRevision: row.applied_revision,
      appliedAt: row.applied_at,
    };
  }

  /**
   * Linha -> documento validado.
   *
   * `null` (e um aviso no log) quando o texto não é um documento:
   * ver o cabeçalho. O aviso importa porque é o único rastro — do
   * lado de fora, a linha simplesmente não existe.
   */
  #toStored(row: DocumentRow): StoredUiDocument | null {
    let raw: unknown;

    try {
      raw = JSON.parse(row.document);
    } catch {
      this.#logger?.warn({ uiDocument: row.slug }, 'documento de interface com JSON ilegível');
      return null;
    }

    const parsed = uiDocumentSchema.safeParse(raw);

    if (!parsed.success) {
      this.#logger?.warn(
        { uiDocument: row.slug, issues: parsed.error.issues.length },
        'documento de interface fora do modelo; ele foi ignorado',
      );
      return null;
    }

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      revision: row.revision,
      document: parsed.data,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * A lista de escondidos, da coluna JSON.
 *
 * Texto ilegível vira lista VAZIA, e não erro: o pior que acontece
 * é o servidor mostrar um pedaço a mais do menu, enquanto recusar a
 * leitura tiraria o menu inteiro do ar por causa de um campo de
 * configuração.
 */
function parseHidden(raw: string, logger: Logger | undefined, serverId: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    logger?.warn({ server: serverId }, 'lista de elementos escondidos ilegível; tratada como vazia');
    return [];
  }
}
