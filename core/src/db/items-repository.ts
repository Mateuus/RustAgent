// ============================================================
//  items-repository.ts  -  o catálogo de itens do jogo, em disco.
//
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Perguntar ao servidor quais itens existem é trabalho do
//  `ItemCatalog` (game/item-catalog.ts). Aqui só entra e sai
//  linha — e é essa separação que permite testar as regras que
//  importam ("o item que sumiu continua na tabela", "a rodada é
//  tudo ou nada") com um banco em memória, sem servidor de Rust
//  nenhum.
//
//  ------------------------------------------------------------
//  ####  A GRAVAÇÃO É UMA RODADA INTEIRA, E SÓ  ####
//
//  Não existe "atualizar um item". O que existe é `replace`, que
//  recebe a lista COMPLETA lida do jogo e a aplica numa transação.
//  Quem não conseguiu montar a lista inteira não chama este método
//  — ver a regra de tudo-ou-nada em game/item-catalog.ts.
//
//  ####  E ELA NÃO APAGA NADA  ####
//
//  Um item que sumiu do jogo continua na tabela, com o `last_seen`
//  da última varredura que o viu. É o que impede um kit do mês
//  passado de ficar apontando para um shortname órfão — ver o
//  cabeçalho da migração 007.
//
//  Quem responde "ainda existe?" é a comparação com o carimbo da
//  varredura:
//
//      last_seen == items.scanned_at   existe
//      last_seen <  items.scanned_at   sumiu
//
//  Por isso TODA leitura carrega o carimbo junto: sem ele, a
//  resposta não sabe dizer o que está velho.
// ============================================================

import type { AgentDatabase } from './database.js';

/** Chaves em `meta`. Ver o cabeçalho da migração 007. */
const PROTOCOL_KEY = 'items.protocol';
const SCANNED_AT_KEY = 'items.scanned_at';

/** Um item, como o jogo o descreve. Ver `origemz.items`. */
export interface ItemInput {
  /** `rifle.ak`. A chave, e o que todo comando do jogo recebe. */
  readonly shortname: string;
  /** `Assault Rifle`. */
  readonly displayName: string;
  readonly itemId: number;
  readonly category: string;
  readonly maxStack: number;
  readonly hasCondition: boolean;
}

/** Um item guardado, com o que só a tabela sabe. */
export interface ItemRecord extends ItemInput {
  /** Epoch ms. Nunca muda depois da inserção. */
  readonly firstSeen: number;
  readonly lastSeen: number;
  /**
   * O jogo NÃO listou este item na última varredura.
   *
   * Derivado, nunca guardado — ver o cabeçalho. É o que a tela de
   * kits usa para dizer "este item não existe mais nesta versão".
   */
  readonly removed: boolean;
}

/** De quando é o catálogo, e de qual versão do jogo. */
export interface ItemCatalogState {
  /**
   * O `Protocol` do `serverinfo` que gerou o catálogo.
   *
   * `null` = nunca houve varredura, ou ela não conseguiu ler o
   * protocolo. Nos dois casos a resposta certa para "precisa
   * refazer?" é sim.
   */
  readonly protocol: string | null;
  /** Quando a última varredura terminou. `null` = nunca houve. */
  readonly scannedAt: number | null;
  /** Quantas linhas existem, incluindo as dos itens que sumiram. */
  readonly total: number;
}

export interface ListItemsOptions {
  /** Trecho de shortname ou de nome de exibição. */
  readonly query?: string | undefined;
  readonly category?: string | undefined;
  /**
   * `true` = só os que sumiram; `false` = só os que existem;
   * ausente = todos, que é o padrão da tela.
   */
  readonly removed?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ListItemsResult {
  readonly items: readonly ItemRecord[];
  /** Quantos casaram com o filtro ANTES da paginação. */
  readonly total: number;
}

/** Uma categoria e quantos itens ela tem. */
export interface ItemCategoryCount {
  readonly category: string;
  readonly total: number;
}

/** O que uma rodada mudou. Só para o log e para a resposta. */
export interface ItemScanResult {
  /** Quantos entraram agora. */
  readonly added: number;
  /** Quantos o jogo listou nesta rodada. */
  readonly present: number;
  /** Quantos continuam na tabela sem estar mais no jogo. */
  readonly removed: number;
  readonly protocol: string | null;
  readonly scannedAt: number;
}

interface ItemRow {
  readonly shortname: string;
  readonly display_name: string;
  readonly item_id: number;
  readonly category: string;
  readonly max_stack: number;
  readonly has_condition: number;
  readonly first_seen: number;
  readonly last_seen: number;
}

/**
 * A avistagem de um item, em uma instrução.
 *
 * `first_seen` NÃO está no `DO UPDATE` — é o que o preserva. Ele é
 * o "existe desde", e reescrevê-lo apagaria a única informação
 * daqui que não dá para reconstruir de nenhuma outra fonte.
 *
 * O `ON CONFLICT` não é redundante mesmo com a tabela vazia: o
 * catálogo chega em ~5 idas ao RCON e nada garante que o servidor
 * não recarregou o plugin entre elas, então o mesmo shortname pode
 * aparecer em duas páginas. Com `INSERT` puro isso estouraria a
 * chave e derrubaria a transação inteira.
 */
const UPSERT_ITEM = `
INSERT INTO items
     (shortname, display_name, item_id, category, max_stack, has_condition,
      first_seen, last_seen)
     VALUES (@shortname, @display_name, @item_id, @category, @max_stack, @has_condition,
             @at, @at)
ON CONFLICT (shortname) DO UPDATE SET
     display_name  = excluded.display_name,
     item_id       = excluded.item_id,
     category      = excluded.category,
     max_stack     = excluded.max_stack,
     has_condition = excluded.has_condition,
     last_seen     = excluded.last_seen
`;

export class ItemsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  state(): ItemCatalogState {
    return {
      protocol: this.#readMeta(PROTOCOL_KEY),
      scannedAt: this.#scannedAt(),
      total: (this.#db.prepare('SELECT count(*) AS total FROM items').get() as { total: number })
        .total,
    };
  }

  /**
   * Uma página do catálogo, em ordem alfabética de nome.
   *
   * ####  A ORDEM É POR NOME, E NÃO PELA DO JOGO  ####
   *
   * A ordem em que o `ItemManager` entrega os itens não quer dizer
   * nada para quem procura "Assault Rifle" numa lista. O desempate
   * por shortname não é zelo: dois itens podem ter o mesmo nome de
   * exibição (a mesma arma em variantes), e sem ele a paginação
   * repetiria ou pularia linhas entre uma requisição e a seguinte.
   *
   * O SQL é estático e os filtros são parâmetros que podem vir
   * nulos: montar o WHERE por concatenação seria mais um ponto em
   * que texto de query string encosta no SQL.
   */
  list(options: ListItemsOptions): ListItemsResult {
    const scannedAt = this.#scannedAt();

    const filters = {
      q:
        options.query === undefined || options.query.trim() === ''
          ? null
          : `%${escapeLike(options.query.trim())}%`,
      category:
        options.category === undefined || options.category.trim() === ''
          ? null
          : options.category.trim(),
      // Sem varredura nenhuma não há como separar quem sumiu: o
      // filtro passa a não filtrar nada, que é honesto — a tabela
      // está vazia de qualquer jeito.
      scanned_at: scannedAt,
      removed: options.removed === undefined ? null : options.removed ? 1 : 0,
    };

    const where = `
      WHERE (@q IS NULL OR shortname LIKE @q ESCAPE '\\' OR display_name LIKE @q ESCAPE '\\')
        AND (@category IS NULL OR category = @category)
        AND (@removed IS NULL OR @scanned_at IS NULL
             OR (CASE WHEN last_seen < @scanned_at THEN 1 ELSE 0 END) = @removed)
    `;

    const total = (
      this.#db.prepare(`SELECT count(*) AS total FROM items ${where}`).get(filters) as {
        readonly total: number;
      }
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT * FROM items
          ${where}
          ORDER BY display_name COLLATE NOCASE ASC, shortname ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...filters, limit: options.limit, offset: options.offset }) as ItemRow[];

    return { items: rows.map((row) => toItem(row, scannedAt)), total };
  }

  get(shortname: string): ItemRecord | null {
    const row = this.#db.prepare('SELECT * FROM items WHERE shortname = @shortname').get({
      shortname,
    }) as ItemRow | undefined;

    return row === undefined ? null : toItem(row, this.#scannedAt());
  }

  /**
   * As categorias que existem, com quantos itens cada uma tem.
   *
   * Sai do banco, e não de uma lista fixa: as categorias são do
   * JOGO (`Weapon`, `Attire`, `Misc`…), e uma constante aqui
   * ficaria errada no primeiro update que criasse uma nova — em
   * silêncio, com o filtro da tela escondendo itens.
   */
  categories(): readonly ItemCategoryCount[] {
    return this.#db
      .prepare(
        `SELECT category, count(*) AS total
           FROM items
          GROUP BY category
          ORDER BY category COLLATE NOCASE`,
      )
      .all() as ItemCategoryCount[];
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Aplica uma rodada INTEIRA do catálogo.
   *
   * Tudo numa transação: os upserts e as duas chaves de `meta`
   * acontecem juntos ou não acontecem. Um agente morto no meio da
   * gravação não pode deixar metade dos itens com o carimbo novo e
   * a outra metade sem — a leitura seguinte concluiria que
   * seiscentos itens sumiram do jogo.
   *
   * `at` carimba TODOS os itens desta rodada com o MESMO valor, e
   * é isso que faz `last_seen < scanned_at` significar "sumiu". Um
   * `Date.now()` por item deixaria a comparação sem sentido.
   *
   * Lote vazio é RECUSADO: uma lista vazia é o sintoma de leitura
   * que deu errado do outro lado, e aplicá-la marcaria o catálogo
   * inteiro como removido. Quem chama já sabe disso (ver
   * game/item-catalog.ts); a trava aqui é a segunda.
   */
  replace(scan: {
    readonly items: readonly ItemInput[];
    readonly protocol: string | null;
    readonly at?: number;
  }): ItemScanResult {
    if (scan.items.length === 0) {
      throw new Error('uma rodada do catálogo de itens não pode estar vazia');
    }

    // ####  O CARIMBO PRECISA ANDAR PARA A FRENTE  ####
    //
    // Toda a marcação de "sumiu" é a comparação `last_seen <
    // scanned_at`. Duas rodadas com o MESMO carimbo fariam a
    // segunda achar que nada sumiu — e o caso não é hipotético:
    // duas varreduras no mesmo milissegundo acontecem em teste e
    // num relógio que anda para trás.
    //
    // O `+1 ms` custa nada e fecha a porta.
    const previous = this.#scannedAt();
    const now = scan.at ?? Date.now();
    const at = previous === null ? now : Math.max(now, previous + 1);

    const apply = this.#db.transaction((): ItemScanResult => {
      const before = (
        this.#db.prepare('SELECT count(*) AS total FROM items').get() as { total: number }
      ).total;

      // Preparado UMA vez, fora do laço: são ~1250 execuções, e
      // compilar o mesmo SQL 1250 vezes seria trabalho puro.
      const upsert = this.#db.prepare(UPSERT_ITEM);

      for (const item of scan.items) {
        upsert.run({
          shortname: item.shortname,
          display_name: item.displayName,
          item_id: item.itemId,
          category: item.category,
          max_stack: item.maxStack,
          // 1/0: o better-sqlite3 não aceita boolean como
          // parâmetro, e o SQLite não tem tipo booleano.
          has_condition: item.hasCondition ? 1 : 0,
          at,
        });
      }

      const present = (
        this.#db.prepare('SELECT count(*) AS total FROM items WHERE last_seen = @at').get({ at }) as {
          total: number;
        }
      ).total;

      const removed = (
        this.#db.prepare('SELECT count(*) AS total FROM items WHERE last_seen < @at').get({ at }) as {
          total: number;
        }
      ).total;

      this.#writeMeta(SCANNED_AT_KEY, String(at), at);

      if (scan.protocol === null) {
        // Protocolo desconhecido: apagar a chave é melhor que
        // guardar o anterior. Ausente, a próxima conferência
        // conclui "não dá para afirmar que vale" e relê — que é o
        // lado certo de errar.
        this.#db.prepare('DELETE FROM meta WHERE key = @key').run({ key: PROTOCOL_KEY });
      } else {
        this.#writeMeta(PROTOCOL_KEY, scan.protocol, at);
      }

      return {
        added: present + removed - before,
        present,
        removed,
        protocol: scan.protocol,
        scannedAt: at,
      };
    });

    return apply();
  }

  #scannedAt(): number | null {
    const raw = this.#readMeta(SCANNED_AT_KEY);

    if (raw === null) {
      return null;
    }

    const parsed = Number(raw);

    // Valor ilegível (banco editado à mão) vira "não sei quando",
    // que é o mesmo que não ter a informação — e melhor que
    // devolver NaN adiante, onde toda comparação daria falso.
    return Number.isFinite(parsed) ? parsed : null;
  }

  #readMeta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = @key').get({ key }) as
      | { readonly value: string }
      | undefined;

    return row === undefined ? null : row.value;
  }

  #writeMeta(key: string, value: string, updatedAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value, updated_at)
              VALUES (@key, @value, @updated_at)
         ON CONFLICT (key) DO UPDATE SET
              value      = excluded.value,
              updated_at = excluded.updated_at`,
      )
      .run({ key, value, updated_at: updatedAt });
  }
}

function toItem(row: ItemRow, scannedAt: number | null): ItemRecord {
  return {
    shortname: row.shortname,
    displayName: row.display_name,
    itemId: row.item_id,
    category: row.category,
    maxStack: row.max_stack,
    hasCondition: row.has_condition === 1,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    // Sem carimbo de varredura não dá para afirmar que sumiu, e
    // `false` é a resposta certa: marcar tudo como removido por
    // não saber seria pior que não marcar nada.
    removed: scannedAt !== null && row.last_seen < scannedAt,
  };
}

/**
 * Neutraliza os curingas do LIKE.
 *
 * Sem isto, buscar por "%" no painel casaria com o catálogo
 * inteiro e um "_" casaria com qualquer caractere — a busca
 * mentiria sobre o que encontrou.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
