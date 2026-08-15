// ============================================================
//  kits-repository.ts  -  os kits da loja, e quem já pegou cada
//  um.
//
//  Três tabelas (migrações 012 e 013), e cada uma responde a uma
//  pergunta:
//
//      kits         o que existe para vender ou resgatar
//      kit_servers  onde cada um é oferecido
//      kit_claims   quem já pegou, quando, e se deu certo
//
//  ------------------------------------------------------------
//  ####  O KIT É DA REDE; O CLAIM É DE UM SERVIDOR  ####
//
//  Um kit editado uma vez vale em todos os servidores que o
//  oferecem — a alternativa seriam cinco cópias do mesmo kit, e a
//  sexta mudança entraria em quatro delas. Já a ENTREGA acontece
//  num servidor: é lá que o inventário existe.
//
//  ####  A LINHA DO CLAIM NASCE ANTES DO COMANDO  ####
//
//  `openClaim` grava `falhou` com o motivo "entrega interrompida", e
//  `closeClaim` põe o desfecho de verdade. Gravar só no fim faria a
//  entrega que travou no meio (agente derrubado, RCON caindo)
//  desaparecer do histórico — e ela é justamente a que gera
//  reclamação.
//
//  ####  E O COOLDOWN É CALCULADO, NUNCA GUARDADO  ####
//
//  "Pode pegar de novo?" é `agora - último claim >= cooldown`. Um
//  campo `next_at` seria um segundo lugar para a mesma verdade — e
//  ele erraria no dia em que alguém mudasse o cooldown do kit.
// ============================================================

import {
  parseLoadoutItems,
  serializeLoadoutItems,
  sortLoadoutItems,
  type LoadoutItem,
} from '../loadouts/items.js';
import type { AgentDatabase } from './database.js';

/**
 * Como o kit chega ao jogador.
 *
 *   `compra`    ele paga e leva, quantas vezes quiser
 *   `resgate`   uma vez por jogador, para sempre
 *   `cooldown`  de N em N segundos
 */
export type KitKind = 'compra' | 'resgate' | 'cooldown';

/** O desfecho de uma entrega. Ver o cabeçalho. */
export type KitClaimStatus = 'entregue' | 'falhou';

export interface KitRecord {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  /**
   * A aba em que ele aparece no jogo. `null` = sem categoria.
   *
   * Texto livre, e não uma tabela: aqui a categoria é um RÓTULO, e
   * não algo que se publica e despublica como na loja. Ver a
   * migração 019.
   */
  readonly category: string | null;
  readonly kind: KitKind;
  /** Em CENTAVOS. `null` fora de `compra`. */
  readonly priceCents: number | null;
  /** Em SEGUNDOS. `null` fora de `cooldown`. */
  readonly cooldownSeconds: number | null;
  /**
   * Só libera este tanto de segundos DEPOIS do wipe.
   *
   * `null` = sem bloqueio. Quem sabe a hora do wipe é o servidor —
   * ver game/wipe.ts.
   */
  readonly wipeDelaySeconds: number | null;
  /** `null` = qualquer um. Preenchido = só quem tem aquele nível. */
  readonly requiredTier: string | null;
  readonly items: readonly LoadoutItem[];
  readonly enabled: boolean;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Em quais servidores ele é oferecido. Vazio = em nenhum. */
  readonly servers: readonly string[];
  /**
   * Quantas entregas deram certo.
   *
   * As que falharam NÃO entram: a pergunta da tela é "quantas vezes
   * este kit foi resgatado", e uma tentativa que não chegou ao
   * jogador não foi um resgate. O detalhe das falhas está na lista
   * de claims do kit.
   */
  readonly claimCount: number;
}

export interface KitInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly kind: KitKind;
  readonly priceCents: number | null;
  readonly cooldownSeconds: number | null;
  readonly wipeDelaySeconds: number | null;
  readonly requiredTier: string | null;
  readonly items: readonly LoadoutItem[];
  readonly enabled: boolean;
  readonly servers: readonly string[];
}

export interface KitClaimRecord {
  readonly id: number;
  readonly kitId: number;
  readonly steamId: string;
  readonly serverId: string;
  /** Epoch ms. */
  readonly claimedAt: number;
  readonly status: KitClaimStatus;
  readonly detail: string | null;
}

/** O claim mais o nome do jogador, para a tela do kit. */
export interface KitClaimListRecord extends KitClaimRecord {
  readonly playerName: string | null;
}

interface KitRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly kind: string;
  readonly price_cents: number | null;
  readonly cooldown_seconds: number | null;
  readonly wipe_delay_seconds: number | null;
  readonly required_tier: string | null;
  readonly items: string;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface KitClaimRow {
  readonly id: number;
  readonly kit_id: number;
  readonly steam_id: string;
  readonly server_id: string;
  readonly claimed_at: number;
  readonly status: string;
  readonly detail: string | null;
}

export class KitsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * Todos os kits da rede.
   *
   * ####  TRÊS CONSULTAS, E NÃO TRÊS POR KIT  ####
   *
   * Os kits, os servidores de todos eles e a contagem de entregas
   * de todos eles. Perguntar "onde este é oferecido?" e "quantas
   * vezes foi pego?" por linha seria o N+1 clássico desta tela —
   * que é justamente a que lista tudo de uma vez.
   */
  list(): readonly KitRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM kits ORDER BY name COLLATE NOCASE ASC, id ASC')
      .all() as KitRow[];

    return this.#withRelations(rows);
  }

  /** Os kits que AQUELE servidor oferece. */
  listForServer(serverId: string): readonly KitRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT k.* FROM kits k
           JOIN kit_servers s ON s.kit_id = k.id
          WHERE s.server_id = @server_id
          ORDER BY k.name COLLATE NOCASE ASC, k.id ASC`,
      )
      .all({ server_id: serverId }) as KitRow[];

    return this.#withRelations(rows);
  }

  get(id: number): KitRecord | null {
    const row = this.#db.prepare('SELECT * FROM kits WHERE id = @id').get({ id }) as
      | KitRow
      | undefined;

    return row === undefined ? null : (this.#withRelations([row])[0] ?? null);
  }

  getBySlug(slug: string): KitRecord | null {
    const row = this.#db.prepare('SELECT * FROM kits WHERE slug = @slug').get({ slug }) as
      | KitRow
      | undefined;

    return row === undefined ? null : (this.#withRelations([row])[0] ?? null);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Cria o kit e o liga aos servidores, numa transação.
   *
   * As duas coisas juntas porque um kit sem servidor nenhum é um
   * kit que não aparece em lugar algum — pior que a falha, porque
   * não parece falha.
   *
   * @throws quando o `slug` já existe (o `UNIQUE` recusa). Quem
   * traduz isso numa frase é http/routes/kits.ts.
   */
  create(input: KitInput, now: number = Date.now()): KitRecord {
    const run = this.#db.transaction((): number => {
      const result = this.#db
        .prepare(
          `INSERT INTO kits
             (slug, name, description, category, kind, price_cents, cooldown_seconds, wipe_delay_seconds, required_tier,
              items, enabled, created_at, updated_at)
           VALUES
             (@slug, @name, @description, @category, @kind, @price_cents, @cooldown_seconds, @wipe_delay_seconds, @required_tier,
              @items, @enabled, @created_at, @updated_at)`,
        )
        .run({ ...toColumns(input), created_at: now, updated_at: now });

      const id = Number(result.lastInsertRowid);

      this.#replaceServers(id, input.servers);

      return id;
    });

    const id = run();
    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`o kit "${input.slug}" sumiu logo depois de ser gravado`);
    }

    return saved;
  }

  /**
   * Reescreve o kit inteiro.
   *
   * PUT, e não PATCH: a tela edita o kit num formulário só e manda
   * tudo. Um merge parcial abriria a pergunta "o que acontece com
   * os itens que não vieram?", e a única resposta segura para ela
   * seria não mexer — o oposto do que espera quem apagou um item na
   * tela.
   *
   * @returns `null` quando o id não existe.
   */
  update(id: number, input: KitInput, now: number = Date.now()): KitRecord | null {
    const run = this.#db.transaction((): boolean => {
      const result = this.#db
        .prepare(
          `UPDATE kits
              SET slug = @slug, name = @name, description = @description, category = @category,
                  kind = @kind,
                  price_cents = @price_cents, cooldown_seconds = @cooldown_seconds,
                  wipe_delay_seconds = @wipe_delay_seconds,
                  required_tier = @required_tier, items = @items, enabled = @enabled,
                  updated_at = @updated_at
            WHERE id = @id`,
        )
        .run({ ...toColumns(input), id, updated_at: now });

      if (result.changes === 0) {
        return false;
      }

      this.#replaceServers(id, input.servers);

      return true;
    });

    return run() ? this.get(id) : null;
  }

  /**
   * Apaga o kit.
   *
   * ####  E LEVA OS CLAIMS JUNTO, PELA CASCATA  ####
   *
   * É deliberado, e é a diferença entre este e o VIP: o claim
   * responde "ele já pegou ESTE kit?", e sem o kit a pergunta deixa
   * de existir. Guardar entrega de um kit que ninguém mais consegue
   * ver produziria um histórico que não dá para ler.
   *
   * Quem quiser tirar o kit do ar SEM perder o histórico usa
   * `enabled = 0` — e é isso que a tela oferece primeiro.
   *
   * @returns `false` quando não havia o que apagar.
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM kits WHERE id = @id').run({ id }).changes > 0;
  }

  // ------------------------------------------------------
  //  Os claims
  // ------------------------------------------------------

  /**
   * Abre a linha da entrega e devolve o id dela.
   *
   * ####  ELA NASCE COMO `falhou`  ####
   *
   * E isso não é pessimismo: é o estado correto de uma entrega que
   * foi PEDIDA e cujo desfecho ainda não se conhece. Se o agente
   * morrer entre o `openClaim` e o `closeClaim`, a linha que fica é
   * "não deu certo, e o motivo foi este" — que é honesto e visível.
   * O contrário (nascer `entregue`) transformaria toda queda numa
   * entrega fantasma que o jogador nunca recebeu.
   */
  openClaim(
    input: { readonly kitId: number; readonly steamId: string; readonly serverId: string },
    now: number = Date.now(),
  ): number {
    const result = this.#db
      .prepare(
        `INSERT INTO kit_claims (kit_id, steam_id, server_id, claimed_at, status, detail)
              VALUES (@kit_id, @steam_id, @server_id, @claimed_at, 'falhou', @detail)`,
      )
      .run({
        kit_id: input.kitId,
        steam_id: input.steamId,
        server_id: input.serverId,
        claimed_at: now,
        detail:
          'entrega interrompida — o agente não chegou a registrar o desfecho. ' +
          'Confira no jogo antes de entregar de novo.',
      });

    return Number(result.lastInsertRowid);
  }

  /** Fecha a linha com o desfecho de verdade. */
  closeClaim(id: number, status: KitClaimStatus, detail: string | null): void {
    this.#db
      .prepare('UPDATE kit_claims SET status = @status, detail = @detail WHERE id = @id')
      .run({ id, status, detail });
  }

  claim(id: number): KitClaimRecord | null {
    const row = this.#db.prepare('SELECT * FROM kit_claims WHERE id = @id').get({ id }) as
      | KitClaimRow
      | undefined;

    return row === undefined ? null : toClaim(row);
  }

  /**
   * A última entrega BEM-SUCEDIDA daquele jogador naquele kit.
   *
   * ####  SÓ AS ENTREGUES CONTAM  ####
   *
   * É ela que responde "já pegou?" e "quando pode de novo?". Contar
   * as que falharam queimaria o resgate único de quem não recebeu
   * nada — e a falha típica é o jogador ter saído no meio, ou seja,
   * culpa de ninguém. A falha continua no histórico, visível, para
   * quem administra decidir.
   */
  lastDeliveredClaim(steamId: string, kitId: number): KitClaimRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM kit_claims
          WHERE steam_id = @steam_id AND kit_id = @kit_id AND status = 'entregue'
          ORDER BY claimed_at DESC, id DESC
          LIMIT 1`,
      )
      .get({ steam_id: steamId, kit_id: kitId }) as KitClaimRow | undefined;

    return row === undefined ? null : toClaim(row);
  }

  /**
   * Quantas vezes AQUELE jogador já levou este kit.
   *
   * Diferente de `KitRecord.claimCount`, que conta a rede inteira: a
   * tela do jogo mostra este número para quem está olhando, e "47
   * resgates" seria o total de todo mundo — uma informação que não
   * responde à pergunta dele.
   *
   * Só as ENTREGUES, pelo mesmo motivo de `lastDeliveredClaim`.
   */
  deliveredCountOf(steamId: string, kitId: number): number {
    return (
      this.#db
        .prepare(
          `SELECT count(*) AS total FROM kit_claims
            WHERE steam_id = @steam_id AND kit_id = @kit_id AND status = 'entregue'`,
        )
        .get({ steam_id: steamId, kit_id: kitId }) as { readonly total: number }
    ).total;
  }

  /** Quem já pegou este kit, do mais recente ao mais antigo. */
  claimsOf(
    kitId: number,
    options: { readonly limit: number; readonly offset: number },
  ): { readonly claims: readonly KitClaimListRecord[]; readonly total: number } {
    const total = (
      this.#db
        .prepare('SELECT count(*) AS total FROM kit_claims WHERE kit_id = @kit_id')
        .get({ kit_id: kitId }) as { readonly total: number }
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT c.*, p.name AS player_name
           FROM kit_claims c
           LEFT JOIN players p ON p.steam_id = c.steam_id
          WHERE c.kit_id = @kit_id
          ORDER BY c.claimed_at DESC, c.id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ kit_id: kitId, limit: options.limit, offset: options.offset }) as (KitClaimRow & {
      readonly player_name: string | null;
    })[];

    return {
      claims: rows.map((row) => ({ ...toClaim(row), playerName: row.player_name })),
      total,
    };
  }

  /** Os últimos resgates daquele jogador, para a ficha dele. */
  claimsOfPlayer(steamId: string, limit: number): readonly KitClaimRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM kit_claims
          WHERE steam_id = @steam_id
          ORDER BY claimed_at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ steam_id: steamId, limit }) as KitClaimRow[];

    return rows.map(toClaim);
  }

  // ------------------------------------------------------
  //  Ajudantes
  // ------------------------------------------------------

  /**
   * Troca o conjunto de servidores de um kit.
   *
   * Apagar e regravar em vez de reconciliar: é configuração, a tela
   * manda a lista completa, e um diff só criaria a chance de sobrar
   * um servidor que alguém desmarcou.
   */
  #replaceServers(kitId: number, servers: readonly string[]): void {
    this.#db.prepare('DELETE FROM kit_servers WHERE kit_id = @kit_id').run({ kit_id: kitId });

    const link = this.#db.prepare(
      'INSERT OR IGNORE INTO kit_servers (kit_id, server_id) VALUES (@kit_id, @server_id)',
    );

    for (const serverId of new Set(servers)) {
      link.run({ kit_id: kitId, server_id: serverId });
    }
  }

  /** Os servidores e a contagem de entregas de um lote, em duas consultas. */
  #withRelations(rows: readonly KitRow[]): readonly KitRecord[] {
    if (rows.length === 0) {
      return [];
    }

    const links = this.#db
      .prepare('SELECT kit_id, server_id FROM kit_servers ORDER BY kit_id, server_id')
      .all() as { readonly kit_id: number; readonly server_id: string }[];

    const counts = this.#db
      .prepare(
        `SELECT kit_id, count(*) AS total
           FROM kit_claims
          WHERE status = 'entregue'
          GROUP BY kit_id`,
      )
      .all() as { readonly kit_id: number; readonly total: number }[];

    const byKit = new Map<number, string[]>();

    for (const link of links) {
      const list = byKit.get(link.kit_id);

      if (list === undefined) {
        byKit.set(link.kit_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    const countByKit = new Map(counts.map((row) => [row.kit_id, row.total]));

    return rows.map((row) => toRecord(row, byKit.get(row.id) ?? [], countByKit.get(row.id) ?? 0));
  }
}

/** O input vira colunas. Uma tradução só, para o create e o update. */
function toColumns(input: KitInput): Record<string, string | number | null> {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    category: input.category,
    kind: input.kind,
    // Preço só faz sentido em `compra`, e cooldown só em
    // `cooldown`. Zerar o que não se aplica é o que impede um kit
    // que virou resgate de continuar cobrando na tela.
    price_cents: input.kind === 'compra' ? input.priceCents : null,
    cooldown_seconds: input.kind === 'cooldown' ? input.cooldownSeconds : null,
    // O atraso pós-wipe NÃO é zerado por tipo: ele vale para os
    // três. Um kit de compra liberado só depois do wipe é tão
    // legítimo quanto um de resgate — a regra é sobre QUANDO, e não
    // sobre COMO.
    wipe_delay_seconds: input.wipeDelaySeconds,
    required_tier: input.requiredTier,
    items: serializeLoadoutItems(sortLoadoutItems(input.items)),
    // 0/1: o better-sqlite3 recusa boolean como parâmetro.
    enabled: input.enabled ? 1 : 0,
  };
}

/**
 * A linha crua vira registro.
 *
 * `kind` e `status` chegam como `string` do SQLite. Quem garante os
 * valores é o `CHECK` da tabela — o estreitamento aqui só reconhece
 * isso para o TypeScript, e não substitui a trava.
 */
function toRecord(row: KitRow, servers: readonly string[], claimCount: number): KitRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    kind: row.kind === 'compra' || row.kind === 'cooldown' ? row.kind : 'resgate',
    priceCents: row.price_cents,
    cooldownSeconds: row.cooldown_seconds,
    wipeDelaySeconds: row.wipe_delay_seconds,
    requiredTier: row.required_tier,
    items: parseLoadoutItems(row.items),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    servers,
    claimCount,
  };
}

function toClaim(row: KitClaimRow): KitClaimRecord {
  return {
    id: row.id,
    kitId: row.kit_id,
    steamId: row.steam_id,
    serverId: row.server_id,
    claimedAt: row.claimed_at,
    status: row.status === 'entregue' ? 'entregue' : 'falhou',
    detail: row.detail,
  };
}
