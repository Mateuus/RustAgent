// ============================================================
//  custom-items-repository.ts  -  os itens que NÓS criamos.
//
//  ####  ELE É O OPOSTO DO items-repository.ts  ####
//
//  Aquele guarda um ESPELHO: a lista de itens do jogo, reescrita a
//  cada varredura do catálogo. Este guarda DECISÕES nossas, e nada
//  aqui é apagado por varredura nenhuma.
//
//  A tabela e o porquê de cada coluna estão na migração 041
//  (db/migrations.ts). A pesquisa que decidiu o desenho está em
//  Docs\CustomItem\01-PESQUISA-ITEM-CUSTOM.md.
//
//  ####  O ITEM CUSTOM É UM ITEM DO JOGO COM UMA MARCA  ####
//
//  A marca é o par `(base_shortname, skin_id)`, e ela é a única
//  coisa que o próprio Rust carrega por nós. `skin_id` NUNCA é
//  zero: skin 0 é indistinguível de item comum, e num item sem
//  skins ela derruba o jogador do servidor pelo caminho do CUI.
//
//  ####  O `id` É GERADO DO NOME, E NÃO DIGITADO  ####
//
//  Ele atravessa para o plugin (`origemz.item.set`), para a loja e
//  para o site — e um `a3f9c1` num log de RCON não diz nada a quem
//  está lendo às três da manhã. `trofeu-bleik-store` diz.
//
//  Ele também NÃO MUDA quando o nome muda: renomear o item no
//  painel não pode quebrar o kit que aponta para ele.
// ============================================================

import type { AgentDatabase } from './database.js';

/** Uma ação: o que o item FAZ. */
export interface CustomItemAction {
  /** `none` | `consume` | `points`. O zod valida; o banco só guarda. */
  readonly kind: string;

  // ---- `consume` ----
  /** Qual gesto dispara: `use`, `drop`, `unwrap`… */
  readonly trigger?: string;
  readonly consumes?: number;
  readonly effects?: readonly CustomItemEffect[];

  // ---- `points` ----
  /** Qual ranking recebe (`trophy.bleik`). */
  readonly metric?: string;
  readonly perUnit?: number;
  /** Converter assim que cai no inventário? */
  readonly onPickup?: boolean;
}

/**
 * Um efeito, dos oito que o jogo tem.
 *
 * MEDIDOS no enum `MetabolismAttribute.Type` do
 * `Assembly-CSharp.dll`: Calories, Hydration, Heartrate, Poison,
 * Radiation, Bleeding, Health e HealthOverTime. São os mesmos que a
 * bandagem comum usa — a "super bandagem" é número maior nos mesmos
 * campos, e não código novo.
 */
export interface CustomItemEffect {
  readonly type: string;
  readonly amount: number;
  /** Só age abaixo desta vida. Zero = sempre. */
  readonly onlyIfHealthBelow?: number;
}

export interface CustomItemInput {
  readonly displayName: string;
  readonly baseShortname: string;
  /** UInt64 como texto. Nunca `'0'` — ver o cabeçalho. */
  readonly skinId: string;
  readonly category: string;
  readonly description: string | null;
  /** Nome do arquivo em `Assets\items\`, ou null para usar o do base. */
  readonly iconFile: string | null;
  /** Null herda o do item base. Só sabe DIMINUIR — ver a migração. */
  readonly maxStack: number | null;
  readonly deployable: boolean;
  /**
   * O item se gasta assim que cai no inventario?
   *
   * `true` faz dele um RECIBO: nasce, e a acao acontece na hora.
   * E o desenho do Trofeu Bleik, e e o que resolve as tres
   * proibicoes do briefing de graca - nao ha o que dropar.
   */
  readonly consumeOnPickup: boolean;
  readonly action: CustomItemAction;
  readonly message: string | null;
  readonly enabled: boolean;
  readonly servers: readonly string[];
}

export interface CustomItemRecord extends CustomItemInput {
  readonly id: string;
  /** Do catálogo do jogo. Null quando o item base sumiu do jogo. */
  readonly baseItemId: number | null;
  /** O item base ainda existe nesta versão do Rust? */
  readonly baseMissing: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface CustomItemRow {
  readonly id: string;
  readonly display_name: string;
  readonly base_shortname: string;
  readonly skin_id: string;
  readonly category: string;
  readonly description: string | null;
  readonly icon_file: string | null;
  readonly max_stack: number | null;
  readonly deployable: number;
  readonly consume_on_pickup: number;
  readonly action: string;
  readonly message: string | null;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly base_item_id: number | null;
  /** Do catálogo do jogo. Null quando o shortname nunca existiu. */
  readonly base_last_seen: number | null;
  /**
   * Quando a última varredura do catálogo aconteceu.
   *
   * Vem da `meta`, e é TEXT lá — daí o tipo. Ver o cabeçalho do
   * items-repository para o porquê de a marca de "sumiu" ser uma
   * comparação de datas, e não uma coluna.
   */
  readonly scanned_at: string | null;
}

/** A ação padrão de quem não escolheu nenhuma. */
export const NO_ACTION: CustomItemAction = { kind: 'none' };

export class CustomItemsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * Todos, com os servidores de cada um.
   *
   * ####  DUAS CONSULTAS, E NÃO UMA POR ITEM  ####
   *
   * A lista e as ligações de todos. Perguntar "onde este vale?"
   * por linha seria o N+1 clássico desta tela — que é justamente a
   * que lista tudo de uma vez.
   *
   * O `LEFT JOIN items` traz o `item_id` numérico do catálogo do
   * jogo. É LEFT porque o item base pode ter sumido numa versão
   * nova do Rust, e a linha continua aqui de propósito: um kit do
   * mês passado aponta para ela.
   */
  list(): readonly CustomItemRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT c.*, i.item_id AS base_item_id, i.last_seen AS base_last_seen,
                (SELECT value FROM meta WHERE key = 'items.scanned_at') AS scanned_at
           FROM custom_items c
           LEFT JOIN items i ON i.shortname = c.base_shortname
          ORDER BY c.display_name COLLATE NOCASE ASC, c.id ASC`,
      )
      .all() as CustomItemRow[];

    return this.#withServers(rows);
  }

  /**
   * Os que AQUELE servidor tem, e só os ligados.
   *
   * É esta a consulta que alimenta o plugin: um item desligado não
   * é empurrado, mas continua no banco — e continua sendo
   * reconhecido por quem já o tem no inventário.
   */
  listForServer(serverId: string): readonly CustomItemRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT c.*, i.item_id AS base_item_id, i.last_seen AS base_last_seen,
                (SELECT value FROM meta WHERE key = 'items.scanned_at') AS scanned_at
           FROM custom_items c
           JOIN custom_item_servers s ON s.item_id = c.id
           LEFT JOIN items i ON i.shortname = c.base_shortname
          WHERE s.server_id = @server_id AND c.enabled = 1
          ORDER BY c.display_name COLLATE NOCASE ASC, c.id ASC`,
      )
      .all({ server_id: serverId }) as CustomItemRow[];

    return this.#withServers(rows);
  }

  get(id: string): CustomItemRecord | null {
    const row = this.#db
      .prepare(
        `SELECT c.*, i.item_id AS base_item_id, i.last_seen AS base_last_seen,
                (SELECT value FROM meta WHERE key = 'items.scanned_at') AS scanned_at
           FROM custom_items c
           LEFT JOIN items i ON i.shortname = c.base_shortname
          WHERE c.id = @id`,
      )
      .get({ id }) as CustomItemRow | undefined;

    return row === undefined ? null : (this.#withServers([row])[0] ?? null);
  }

  /** As categorias que existem, com quantos itens cada uma tem. */
  categories(): readonly { readonly category: string; readonly total: number }[] {
    return this.#db
      .prepare(
        `SELECT category, count(*) AS total
           FROM custom_items
          GROUP BY category
          ORDER BY category COLLATE NOCASE ASC`,
      )
      .all() as { category: string; total: number }[];
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Cria o item e o liga aos servidores, numa transação.
   *
   * As duas coisas juntas porque um item ligado a servidor nenhum
   * não é entregue em lugar nenhum — e isso não parece falha, que
   * é o que o torna pior que uma falha.
   *
   * @throws quando a marca `(base, skin)` já existe. O `UNIQUE`
   * recusa, e quem traduz isso numa frase é a rota.
   */
  create(input: CustomItemInput, now: number = Date.now()): CustomItemRecord {
    const id = this.#freeId(input.displayName);

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `INSERT INTO custom_items
             (id, display_name, base_shortname, skin_id, category, description,
              icon_file, max_stack, deployable, consume_on_pickup, action, message, enabled,
              created_at, updated_at)
           VALUES
             (@id, @display_name, @base_shortname, @skin_id, @category, @description,
              @icon_file, @max_stack, @deployable, @consume_on_pickup, @action, @message, @enabled,
              @created_at, @updated_at)`,
        )
        .run({ id, ...toColumns(input), created_at: now, updated_at: now });

      this.#replaceServers(id, input.servers);
    });

    run();

    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`o item custom "${id}" sumiu logo depois de ser gravado`);
    }

    return saved;
  }

  /**
   * Reescreve o item inteiro.
   *
   * PUT, e não PATCH: a tela edita num formulário só e manda tudo.
   * Um merge parcial abriria a pergunta "o que acontece com os
   * servidores que não vieram?", e a única resposta segura seria
   * não mexer — o oposto do que espera quem desmarcou um na tela.
   *
   * O `id` NÃO muda junto com o nome. Ver o cabeçalho.
   *
   * @returns `null` quando o id não existe.
   */
  update(id: string, input: CustomItemInput, now: number = Date.now()): CustomItemRecord | null {
    if (this.get(id) === null) {
      return null;
    }

    const run = this.#db.transaction((): void => {
      this.#db
        .prepare(
          `UPDATE custom_items SET
             display_name   = @display_name,
             base_shortname = @base_shortname,
             skin_id        = @skin_id,
             category       = @category,
             description    = @description,
             icon_file      = @icon_file,
             max_stack      = @max_stack,
             deployable     = @deployable,
             consume_on_pickup = @consume_on_pickup,
             action         = @action,
             message        = @message,
             enabled        = @enabled,
             updated_at     = @updated_at
           WHERE id = @id`,
        )
        .run({ id, ...toColumns(input), updated_at: now });

      this.#replaceServers(id, input.servers);
    });

    run();

    return this.get(id);
  }

  /**
   * Apaga.
   *
   * A cascata leva as ligações de servidor junto. O que ela NÃO
   * sabe é dos kits e ofertas que apontam para este item — quem
   * pergunta isso antes de deixar apagar é a rota, e o motivo está
   * lá.
   */
  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM custom_items WHERE id = @id').run({ id }).changes > 0;
  }

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  #withServers(rows: readonly CustomItemRow[]): readonly CustomItemRecord[] {
    if (rows.length === 0) {
      return [];
    }

    const byItem = new Map<string, string[]>();

    for (const link of this.#db
      .prepare('SELECT item_id, server_id FROM custom_item_servers ORDER BY item_id, server_id')
      .all() as { item_id: string; server_id: string }[]) {
      const list = byItem.get(link.item_id);

      if (list === undefined) {
        byItem.set(link.item_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    return rows.map((row) => toRecord(row, byItem.get(row.id) ?? []));
  }

  #replaceServers(itemId: string, servers: readonly string[]): void {
    this.#db.prepare('DELETE FROM custom_item_servers WHERE item_id = @item_id').run({
      item_id: itemId,
    });

    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO custom_item_servers (item_id, server_id) VALUES (@item_id, @server_id)',
    );

    // O `Set` porque a tela pode mandar o mesmo servidor duas vezes
    // e o `INSERT OR IGNORE` engoliria em silêncio — melhor não
    // chegar lá.
    for (const serverId of new Set(servers)) {
      insert.run({ item_id: itemId, server_id: serverId });
    }
  }

  /**
   * Um `id` livre, derivado do nome.
   *
   * "Troféu Bleik Store" vira `trofeu-bleik-store`. Se já existir,
   * vira `trofeu-bleik-store-2`, e assim por diante.
   *
   * O sufixo numérico é feio, e é de propósito: ele avisa quem
   * cadastrou que já existe um item com aquele nome. Um hash
   * aleatório esconderia isso.
   */
  #freeId(displayName: string): string {
    const base = slugify(displayName);
    const exists = this.#db.prepare('SELECT 1 FROM custom_items WHERE id = @id');

    if (exists.get({ id: base }) === undefined) {
      return base;
    }

    // O teto existe para o laço não ser infinito num banco
    // corrompido. Cem itens com o mesmo nome já é outro problema.
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${String(suffix)}`;

      if (exists.get({ id: candidate }) === undefined) {
        return candidate;
      }
    }

    throw new Error(`não achei um id livre para "${displayName}" — há 99 itens com esse nome?`);
  }
}

/**
 * Nome legível vira identificador.
 *
 * Sem acento, sem maiúscula, sem símbolo: o `id` viaja num comando
 * de console do Rust, onde o espaço separa argumentos e o acento
 * depende do encoding do console.
 *
 * A régua é a mesma do shortname do jogo (minúscula, dígito, ponto,
 * hífen), o que garante que um id nosso nunca precise de aspas em
 * lugar nenhum.
 */
export function slugify(value: string): string {
  const ascii = value
    .normalize('NFD')
    // A faixa U+0300–U+036F são os diacríticos, já separados da
    // letra pelo NFD acima. "Troféu" vira "Trofeu", e não "Trofu".
    //
    // Escrita como escape, e não com os caracteres literais: um
    // acento solto no meio do código-fonte é invisível no editor e
    // vira outra coisa em qualquer conversão de encoding.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Nome só de símbolos ("★★★") deixaria o id vazio, e um id vazio
  // colidiria com o próximo nome só de símbolos.
  return ascii === '' ? 'item' : ascii.slice(0, 60);
}

function toColumns(input: CustomItemInput): Record<string, unknown> {
  return {
    display_name: input.displayName,
    base_shortname: input.baseShortname,
    skin_id: input.skinId,
    category: input.category,
    description: input.description,
    icon_file: input.iconFile,
    max_stack: input.maxStack,
    deployable: input.deployable ? 1 : 0,
    consume_on_pickup: input.consumeOnPickup ? 1 : 0,
    action: JSON.stringify(input.action),
    message: input.message,
    enabled: input.enabled ? 1 : 0,
  };
}

function toRecord(row: CustomItemRow, servers: readonly string[]): CustomItemRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    baseShortname: row.base_shortname,
    skinId: row.skin_id,
    category: row.category,
    description: row.description,
    iconFile: row.icon_file,
    maxStack: row.max_stack,
    deployable: row.deployable === 1,
    consumeOnPickup: row.consume_on_pickup === 1,
    action: parseAction(row.action),
    message: row.message,
    enabled: row.enabled === 1,
    baseItemId: row.base_item_id,
    baseMissing: isBaseMissing(row),
    servers,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * O item base ainda existe nesta versão do Rust?
 *
 * ####  A TABELA `items` NUNCA APAGA  ####
 *
 * E é por isso que "sumiu" não é o `LEFT JOIN` vir vazio. A
 * migração 007 guarda item que saiu do jogo de propósito — um kit
 * do mês passado aponta para ele —, e quem marca a ausência são as
 * duas datas:
 *
 *     last_seen == items.scanned_at   o jogo listou na última varredura
 *     last_seen <  items.scanned_at   sumiu
 *
 * Sem varredura nenhuma (`scanned_at` nulo, instalação nova) nada
 * está ausente: não há como afirmar isso sem ter perguntado ao jogo
 * uma vez sequer.
 */
function isBaseMissing(row: CustomItemRow): boolean {
  // O shortname nunca esteve no catálogo. Só acontece em banco
  // mexido à mão: a rota confere isto no cadastro.
  if (row.base_last_seen === null) {
    return true;
  }

  if (row.scanned_at === null) {
    return false;
  }

  return row.base_last_seen < Number(row.scanned_at);
}

/**
 * O JSON da coluna vira objeto.
 *
 * JSON quebrado vira `{kind:'none'}` em vez de estourar: a coluna é
 * escrita por nós, então um valor ilegível ali é defeito nosso — e
 * derrubar a listagem inteira por causa de um item esconderia os
 * outros trinta que estão bons.
 */
function parseAction(raw: string): CustomItemAction {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed) {
      return parsed as CustomItemAction;
    }
  } catch {
    // Ver o comentário acima.
  }

  return NO_ACTION;
}
