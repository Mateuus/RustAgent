// ============================================================
//  plugins-repository.ts  -  os plugins que o agente conhece, e o
//  que cada servidor ativou.
//
//  Duas tabelas, e três perguntas:
//
//      plugins (server_id NULL)   a BIBLIOTECA — vale para todos
//      plugins (server_id = X)    o CUSTOM do servidor X
//      server_plugins             o que o servidor <id> ativou
//
//  ------------------------------------------------------------
//  ####  A CHAVE É O `id`, E ISSO NÃO É DETALHE  ####
//
//  O `name` não é único: a biblioteca pode ter um `Kits` e o `pvp1`
//  ter outro, custom, com conteúdo diferente. Toda função aqui que
//  aponta para um plugin aponta pelo `id` — passar o nome seria
//  ambíguo justamente no caso que a migração 003 existe para
//  permitir.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NÃO TOCA EM DISCO  ####
//
//  Copiar o `.cs`, apagá-lo e mandar o `oxide.reload` é trabalho de
//  oxide/library.ts. Aqui só entra e sai linha — e essa separação é
//  o que permite testar a regra ("desligar preserva a linha", "o
//  applied_sha divergente é atualização pendente") com um banco em
//  memória, sem servidor de Rust nenhum.
//
//  ####  A LINHA VIVE MAIS QUE O ARQUIVO  ####
//
//  Desligar um plugin apaga o `.cs` daquele servidor mas MANTÉM a
//  linha com `enabled = 0`. Ver o cabeçalho da migração 002: é o
//  que separa "desliguei para testar" de "nunca usei".
// ============================================================

import type { AgentDatabase } from './database.js';

/** Um `.cs` que o agente conhece — da biblioteca ou custom. */
export interface PluginRecord {
  /** A chave. Ver o cabeçalho: o nome NÃO é único. */
  readonly id: number;
  /** `OrigemZPlayer` — sem o `.cs`. É o que o `oxide.reload` recebe. */
  readonly name: string;
  /** `OrigemZPlayer.cs` — o nome do arquivo em disco. */
  readonly file: string;
  /**
   * `null` = da biblioteca, disponível para todo servidor.
   * Preenchido = custom DAQUELE servidor, e de mais ninguém.
   */
  readonly serverId: string | null;
  /** Lidos do `[Info(...)]` do próprio arquivo. Ver plugin-metadata.ts. */
  readonly title: string | null;
  readonly author: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * `// Requires: X` — de quem ele NÃO carrega sem.
   *
   * `null` = as dependências ainda não foram extraídas daquele
   * `.cs` (linha anterior à migração 004). Diferente de `[]`, que é
   * "li o arquivo e ele não depende de ninguém" — e é essa
   * diferença que faz a varredura da pasta saber o que reler.
   */
  readonly requires: readonly string[] | null;
  /** `[PluginReference]` — de quem ele usa, mas sobrevive sem. */
  readonly references: readonly string[] | null;
  /** Epoch ms. */
  readonly addedAt: number;
  readonly updatedAt: number;
}

/** O que um servidor sabe sobre um plugin. */
export interface ServerPluginRecord {
  readonly serverId: string;
  readonly pluginId: number;
  readonly enabled: boolean;
  /**
   * O sha256 do que está EM DISCO naquele servidor.
   *
   * `null` com o plugin desligado — não há arquivo lá. Diferente
   * do `sha256` do plugin = há atualização para aplicar.
   */
  readonly appliedSha: string | null;
  readonly appliedAt: number | null;
}

export interface PluginInput {
  readonly name: string;
  readonly file: string;
  /** `null` = biblioteca; um id = custom daquele servidor. */
  readonly serverId: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly requires: readonly string[];
  readonly references: readonly string[];
}

interface PluginRow {
  readonly id: number;
  readonly name: string;
  readonly file: string;
  readonly server_id: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly requires: string | null;
  readonly plugin_refs: string | null;
  readonly added_at: number;
  readonly updated_at: number;
}

interface ServerPluginRow {
  readonly server_id: string;
  readonly plugin_id: number;
  readonly enabled: number;
  readonly applied_sha: string | null;
  readonly applied_at: number | null;
}

export class PluginsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /** Só os da biblioteca. É o que a tela de rede mostra. */
  library(): readonly PluginRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM plugins WHERE server_id IS NULL ORDER BY name COLLATE NOCASE')
      .all() as PluginRow[];

    return rows.map(toPluginRecord);
  }

  /** Só os customs daquele servidor. */
  customOf(serverId: string): readonly PluginRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM plugins WHERE server_id = @server_id ORDER BY name COLLATE NOCASE')
      .all({ server_id: serverId }) as PluginRow[];

    return rows.map(toPluginRecord);
  }

  /**
   * Tudo o que aquele servidor PODE ligar: a biblioteca mais os
   * customs dele.
   *
   * Uma consulta só, e não duas somadas em memória, porque a
   * ordenação precisa valer sobre o conjunto — e porque é
   * exatamente a pergunta que a tela do servidor faz.
   */
  availableFor(serverId: string): readonly PluginRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM plugins
          WHERE server_id IS NULL OR server_id = @server_id
          ORDER BY name COLLATE NOCASE`,
      )
      .all({ server_id: serverId }) as PluginRow[];

    return rows.map(toPluginRecord);
  }

  get(id: number): PluginRecord | null {
    const row = this.#db.prepare('SELECT * FROM plugins WHERE id = @id').get({ id }) as
      | PluginRow
      | undefined;

    return row === undefined ? null : toPluginRecord(row);
  }

  /** O plugin da BIBLIOTECA com aquele nome. */
  findLibrary(name: string): PluginRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM plugins WHERE server_id IS NULL AND name = @name')
      .get({ name }) as PluginRow | undefined;

    return row === undefined ? null : toPluginRecord(row);
  }

  /** O CUSTOM daquele servidor com aquele nome. */
  findCustom(serverId: string, name: string): PluginRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM plugins WHERE server_id = @server_id AND name = @name')
      .get({ server_id: serverId, name }) as PluginRow | undefined;

    return row === undefined ? null : toPluginRecord(row);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Grava o plugin, criando ou substituindo o que havia.
   *
   * Subir a versão nova é o MESMO gesto de subir a primeira, e por
   * isso é o mesmo método: um `update` à parte obrigaria a tela a
   * saber de antemão se aquele nome já existe — e a errar quando
   * dois uploads chegassem juntos.
   *
   * `added_at` sobrevive à substituição: é a data em que o plugin
   * entrou, não a do último upload.
   */
  upsert(input: PluginInput, now: number = Date.now()): PluginRecord {
    const existing =
      input.serverId === null
        ? this.findLibrary(input.name)
        : this.findCustom(input.serverId, input.name);

    if (existing === null) {
      const result = this.#db
        .prepare(
          `INSERT INTO plugins
             (name, file, server_id, title, author, version, description, bytes, sha256,
              requires, plugin_refs, added_at, updated_at)
           VALUES
             (@name, @file, @server_id, @title, @author, @version, @description, @bytes,
              @sha256, @requires, @plugin_refs, @now, @now)`,
        )
        .run({
          name: input.name,
          file: input.file,
          server_id: input.serverId,
          title: input.title,
          author: input.author,
          version: input.version,
          description: input.description,
          bytes: input.bytes,
          sha256: input.sha256,
          requires: JSON.stringify(input.requires),
          plugin_refs: JSON.stringify(input.references),
          now,
        });

      return this.#requireAfterWrite(Number(result.lastInsertRowid), input.name);
    }

    this.#db
      .prepare(
        `UPDATE plugins
            SET file        = @file,
                title       = @title,
                author      = @author,
                version     = @version,
                description = @description,
                bytes       = @bytes,
                sha256      = @sha256,
                requires    = @requires,
                plugin_refs = @plugin_refs,
                updated_at  = @now
          WHERE id = @id`,
      )
      .run({
        id: existing.id,
        file: input.file,
        title: input.title,
        author: input.author,
        version: input.version,
        description: input.description,
        bytes: input.bytes,
        sha256: input.sha256,
        requires: JSON.stringify(input.requires),
        plugin_refs: JSON.stringify(input.references),
        now,
      });

    return this.#requireAfterWrite(existing.id, input.name);
  }

  /**
   * Tira o plugin do agente.
   *
   * As linhas de `server_plugins` vão junto, pela cascata — e é o
   * comportamento certo: sem o arquivo de referência, "ligado no
   * pvp1" deixaria de ter significado. Quem apaga o `.cs` de cada
   * servidor é a camada de cima, ANTES de chamar isto.
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM plugins WHERE id = @id').run({ id }).changes > 0;
  }

  // ------------------------------------------------------
  //  O que cada servidor ativou
  // ------------------------------------------------------

  /** As linhas daquele servidor, ligadas e desligadas. */
  serverPlugins(serverId: string): readonly ServerPluginRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM server_plugins WHERE server_id = @server_id')
      .all({ server_id: serverId }) as ServerPluginRow[];

    return rows.map(toServerPluginRecord);
  }

  serverPlugin(serverId: string, pluginId: number): ServerPluginRecord | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM server_plugins WHERE server_id = @server_id AND plugin_id = @plugin_id',
      )
      .get({ server_id: serverId, plugin_id: pluginId }) as ServerPluginRow | undefined;

    return row === undefined ? null : toServerPluginRecord(row);
  }

  /**
   * Liga ou desliga o plugin naquele servidor.
   *
   * `appliedSha` vem preenchido ao ligar (o resumo do que acabou de
   * ser copiado) e `null` ao desligar — não há arquivo lá para
   * resumir.
   */
  setServerPlugin(
    serverId: string,
    pluginId: number,
    enabled: boolean,
    appliedSha: string | null,
    now: number = Date.now(),
  ): ServerPluginRecord {
    this.#db
      .prepare(
        `INSERT INTO server_plugins (server_id, plugin_id, enabled, applied_sha, applied_at)
         VALUES (@server_id, @plugin_id, @enabled, @applied_sha, @applied_at)
         ON CONFLICT(server_id, plugin_id) DO UPDATE SET
           enabled     = excluded.enabled,
           applied_sha = excluded.applied_sha,
           applied_at  = excluded.applied_at`,
      )
      .run({
        server_id: serverId,
        plugin_id: pluginId,
        enabled: enabled ? 1 : 0,
        applied_sha: appliedSha,
        applied_at: appliedSha === null ? null : now,
      });

    const saved = this.serverPlugin(serverId, pluginId);

    if (saved === null) {
      throw new Error(`a linha do plugin ${String(pluginId)} em ${serverId} sumiu ao ser gravada`);
    }

    return saved;
  }

  /**
   * Em quais servidores este plugin está ATIVO.
   *
   * É o que a remoção mostra antes de confirmar: "vai sair do pvp1
   * e do pvp2" diz o tamanho do estrago; "2 servidores" obriga a ir
   * procurar quais.
   */
  activeServersOf(pluginId: number): readonly string[] {
    const rows = this.#db
      .prepare(
        `SELECT server_id FROM server_plugins
          WHERE plugin_id = @plugin_id AND enabled = 1
          ORDER BY server_id`,
      )
      .all({ plugin_id: pluginId }) as { readonly server_id: string }[];

    return rows.map((row) => row.server_id);
  }

  /**
   * Os servidores ativos de TODOS os plugins, de uma vez.
   *
   * A tela da biblioteca precisa disso por linha listada, e uma
   * consulta por plugin faria vinte idas ao banco para desenhar uma
   * tela só.
   */
  activeServersByPlugin(): ReadonlyMap<number, readonly string[]> {
    const rows = this.#db
      .prepare(
        `SELECT plugin_id, server_id FROM server_plugins
          WHERE enabled = 1
          ORDER BY plugin_id, server_id`,
      )
      .all() as { readonly plugin_id: number; readonly server_id: string }[];

    const byPlugin = new Map<number, string[]>();

    for (const row of rows) {
      const list = byPlugin.get(row.plugin_id);

      if (list === undefined) {
        byPlugin.set(row.plugin_id, [row.server_id]);
      } else {
        list.push(row.server_id);
      }
    }

    return byPlugin;
  }

  #requireAfterWrite(id: number, name: string): PluginRecord {
    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`o plugin ${name} sumiu logo depois de ser gravado`);
    }

    return saved;
  }
}

/**
 * A coluna JSON de volta em lista.
 *
 * `null` sobrevive como `null` — ele quer dizer "ainda não sei", e
 * transformá-lo em `[]` apagaria a diferença entre isso e "não
 * depende de ninguém". JSON quebrado também vira `null`, pelo mesmo
 * motivo: é melhor a varredura reler o arquivo do que a tela
 * afirmar, com uma lista vazia, que nada depende daquele plugin.
 */
function parseNames(raw: string | null): readonly string[] | null {
  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function toPluginRecord(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    name: row.name,
    file: row.file,
    serverId: row.server_id,
    title: row.title,
    author: row.author,
    version: row.version,
    description: row.description,
    bytes: row.bytes,
    sha256: row.sha256,
    requires: parseNames(row.requires),
    references: parseNames(row.plugin_refs),
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function toServerPluginRecord(row: ServerPluginRow): ServerPluginRecord {
  return {
    serverId: row.server_id,
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    appliedSha: row.applied_sha,
    appliedAt: row.applied_at,
  };
}
