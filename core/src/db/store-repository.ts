// ============================================================
//  store-repository.ts  -  a vitrine e o histórico de compras.
//
//  Cinco tabelas (migração 015), e cada uma responde a uma
//  pergunta:
//
//      store_categories    quais abas a loja tem
//      store_offers        o que está à venda em cada uma
//      store_offer_items   o que cada oferta ENTREGA
//      store_offer_perks   o que um VIP promete, em texto
//      store_purchases     quem comprou o quê, e como acabou
//
//  ------------------------------------------------------------
//  ####  A COMPRA GUARDA UMA CÓPIA DA OFERTA  ####
//
//  `store_purchases` copia nome, preço e ícone em vez de apontar
//  para `store_offers`. Não é redundância: a oferta pode ser
//  editada ou apagada depois, e o histórico precisa dizer o que a
//  pessoa PAGOU — não o preço de hoje.
//
//  Uma junção responderia "quanto custa"; a cópia responde "quanto
//  custou", que é a pergunta do suporte.
//
//  ####  AS DATAS SAEM DAQUI EM EPOCH MS  ####
//
//  Como em todo repositório deste projeto. Quem converte para ISO é
//  a borda HTTP, num lugar só — ver http/routes/store.ts.
// ============================================================

import type { AgentDatabase } from './database.js';

// ------------------------------------------------------------
//  Tipos
// ------------------------------------------------------------

export interface StoreCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly enabled: boolean;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoreCategoryInput {
  readonly name: string;
  readonly position: number;
  readonly enabled: boolean;
}

/**
 * A etiqueta no canto do card, no jogo.
 *
 * Lista fechada, e não texto livre: cada uma tem cor própria na
 * loja, e um valor solto sairia sem cor nenhuma — visível no painel
 * e invisível no jogo.
 */
export const OFFER_BADGES = ['promo', 'novo', 'destaque'] as const;
export type OfferBadge = (typeof OFFER_BADGES)[number];

/**
 * O FORMATO da oferta.
 *
 * ####  A DIFERENÇA NÃO É COSMÉTICA  ####
 *
 *   item     um item do jogo. O ícone é ele mesmo.
 *   bundle   um kit: vários itens numa compra. Alguém precisa
 *            ESCOLHER o ícone — não existe "o item" de um kit.
 *   vip      um nível de VIP com prazo, mais a lista de vantagens
 *            e, se quiser, itens que vêm junto.
 *   vehicle  um veículo que nasce no mundo.
 *
 * Os quatro entregam pela mesma tabela filha. O que muda é o que a
 * loja mostra e o que a compra concede além dos itens.
 */
export const OFFER_KINDS = ['item', 'bundle', 'vip', 'vehicle'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

/** Um item dentro de uma oferta. */
export interface OfferItem {
  readonly shortname: string;
  /** Para o ícone do jogo — o CUI desenha a partir dele. */
  readonly itemId: number;
  /** String: id de workshop passa de 2^53. `'0'` = sem skin. */
  readonly skinId: string;
  readonly amount: number;
}

/** O desenho que representa a oferta na loja. */
export interface OfferIcon {
  readonly shortname: string;
  readonly itemId: number;
  readonly skinId: string;
}

/**
 * O VIP que a compra concede.
 *
 * `days: null` = VITALÍCIO, que é o que "sem vencimento" significa
 * no vips-repository.
 */
export interface OfferVip {
  readonly tier: string;
  readonly days: number | null;
}

/**
 * O veículo que a compra faz nascer.
 *
 * `prefab` é o NOME CURTO (minicopter, rowboat, sedan): o jogo
 * resolve o caminho, e ele não muda quando a Facepunch move um
 * arquivo.
 */
export interface OfferVehicle {
  readonly prefab: string;
  /** Combustível no tanque. 0 = nenhum. */
  readonly fuel: number;
}

export interface StoreOffer {
  readonly id: string;
  readonly categoryId: string;
  readonly kind: OfferKind;
  /**
   * O que a compra entrega.
   *
   * Vazio é estado VÁLIDO durante a edição — um kit começa sem
   * itens. A borda HTTP é quem recusa publicar assim.
   */
  readonly items: readonly OfferItem[];
  /** As vantagens listadas, só para `vip`. */
  readonly perks: readonly string[];
  /** `null` fora de `vip`. */
  readonly vip: OfferVip | null;
  /** `null` fora de `vehicle`. */
  readonly vehicle: OfferVehicle | null;
  readonly icon: OfferIcon;
  readonly name: string;
  readonly price: number;
  readonly position: number;
  readonly enabled: boolean;
  /** `null` = sem etiqueta. */
  readonly badge: OfferBadge | null;
  /**
   * O preço RISCADO ao lado, em promoção.
   *
   * `null` = não mostra nada. Uma etiqueta de promoção sozinha diz
   * que há desconto, mas não QUANTO — é este número que a
   * transforma em argumento.
   */
  readonly oldPrice: number | null;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoreOfferInput {
  readonly categoryId: string;
  readonly kind: OfferKind;
  readonly items: readonly OfferItem[];
  readonly perks: readonly string[];
  readonly vip: OfferVip | null;
  readonly vehicle: OfferVehicle | null;
  readonly icon: OfferIcon;
  readonly name: string;
  readonly price: number;
  readonly position: number;
  readonly enabled: boolean;
  readonly badge: OfferBadge | null;
  readonly oldPrice: number | null;
}

/** Ver o CHECK da migração 015 para o que cada estado significa. */
export type PurchaseState = 'pending' | 'debited' | 'delivered' | 'refunded' | 'failed';

export interface StorePurchase {
  readonly id: string;
  /** Em qual servidor a compra foi entregue. */
  readonly serverId: string;
  readonly steamId: string;
  readonly offerId: string;
  readonly offerName: string;
  readonly shortname: string;
  readonly skinId: string;
  readonly amount: number;
  readonly unitPrice: number;
  readonly totalPrice: number;
  readonly state: PurchaseState;
  readonly error: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  Linhas
// ------------------------------------------------------------

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface OfferRow {
  readonly id: string;
  readonly category_id: string;
  readonly kind: string;
  readonly icon_shortname: string;
  readonly icon_item_id: number;
  readonly icon_skin_id: string;
  readonly vip_tier: string | null;
  readonly vip_days: number | null;
  readonly vehicle_prefab: string | null;
  readonly vehicle_fuel: number;
  readonly name: string;
  readonly price: number;
  readonly position: number;
  readonly enabled: number;
  readonly badge: string | null;
  readonly old_price: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface OfferItemRow {
  readonly offer_id: string;
  readonly shortname: string;
  readonly item_id: number;
  readonly skin_id: string;
  readonly amount: number;
}

interface OfferPerkRow {
  readonly offer_id: string;
  readonly text: string;
}

interface PurchaseRow {
  readonly id: string;
  readonly server_id: string;
  readonly steam_id: string;
  readonly offer_id: string;
  readonly offer_name: string;
  readonly shortname: string;
  readonly skin_id: string;
  readonly amount: number;
  readonly unit_price: number;
  readonly total_price: number;
  readonly state: string;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function toCategory(row: CategoryRow): StoreCategory {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOffer(row: OfferRow, items: readonly OfferItem[], perks: readonly string[]): StoreOffer {
  return {
    id: row.id,
    categoryId: row.category_id,
    kind: isKind(row.kind) ? row.kind : 'item',
    items,
    perks,
    // Tier sem valor = não é VIP, mesmo que o `kind` diga que é.
    // Melhor uma oferta que não concede nada do que uma que conceda
    // um nível inventado.
    vip: row.vip_tier === null ? null : { tier: row.vip_tier, days: row.vip_days },
    // Prefab vazio = não é veículo, pelo mesmo motivo: melhor uma
    // oferta que não entrega do que uma que tente fazer nascer algo
    // que não existe.
    vehicle:
      row.vehicle_prefab === null || row.vehicle_prefab === ''
        ? null
        : { prefab: row.vehicle_prefab, fuel: row.vehicle_fuel },
    icon: {
      shortname: row.icon_shortname,
      itemId: row.icon_item_id,
      skinId: row.icon_skin_id,
    },
    name: row.name,
    price: row.price,
    position: row.position,
    enabled: row.enabled === 1,
    // Etiqueta desconhecida vira `null`: melhor sem etiqueta do que
    // com uma que a loja não sabe pintar.
    badge: isBadge(row.badge) ? row.badge : null,
    oldPrice: row.old_price,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isBadge(value: string | null): value is OfferBadge {
  return value !== null && (OFFER_BADGES as readonly string[]).includes(value);
}

function isKind(value: string): value is OfferKind {
  return (OFFER_KINDS as readonly string[]).includes(value);
}

function toPurchase(row: PurchaseRow): StorePurchase {
  return {
    id: row.id,
    serverId: row.server_id,
    steamId: row.steam_id,
    offerId: row.offer_id,
    offerName: row.offer_name,
    shortname: row.shortname,
    skinId: row.skin_id,
    amount: row.amount,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    state: row.state as PurchaseState,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
//  O CATÁLOGO
// ============================================================

export class StoreRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ---- Categorias ------------------------------------------

  listCategories(): readonly StoreCategory[] {
    const rows = this.#db
      .prepare(`SELECT * FROM store_categories ORDER BY position ASC, name COLLATE NOCASE`)
      .all() as CategoryRow[];

    return rows.map(toCategory);
  }

  getCategory(id: string): StoreCategory | null {
    const row = this.#db.prepare(`SELECT * FROM store_categories WHERE id = @id`).get({ id }) as
      | CategoryRow
      | undefined;

    return row === undefined ? null : toCategory(row);
  }

  saveCategory(id: string, input: StoreCategoryInput, now = Date.now()): StoreCategory {
    this.#db
      .prepare(
        `INSERT INTO store_categories (id, name, position, enabled, created_at, updated_at)
         VALUES (@id, @name, @position, @enabled, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           position   = excluded.position,
           enabled    = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        name: input.name,
        position: input.position,
        enabled: input.enabled ? 1 : 0,
        now,
      });

    const saved = this.getCategory(id);

    if (saved === null) {
      throw new Error(`categoria ${id} não pôde ser lida após a gravação`);
    }

    return saved;
  }

  /**
   * Apaga a categoria E as ofertas dela.
   *
   * O `ON DELETE CASCADE` da migração só age com `foreign_keys=ON`,
   * que nem toda conexão liga. Apagar aqui também deixa o resultado
   * igual nas duas situações — uma oferta órfã apontando para
   * categoria que não existe some da loja sem ninguém entender por
   * quê.
   */
  removeCategory(id: string): boolean {
    const remove = this.#db.transaction((categoryId: string) => {
      const offers = this.#db
        .prepare(`SELECT id FROM store_offers WHERE category_id = @id`)
        .all({ id: categoryId }) as { readonly id: string }[];

      for (const offer of offers) {
        this.#removeOfferChildren(offer.id);
      }

      this.#db.prepare(`DELETE FROM store_offers WHERE category_id = @id`).run({ id: categoryId });

      return this.#db.prepare(`DELETE FROM store_categories WHERE id = @id`).run({ id: categoryId });
    });

    return remove(id).changes > 0;
  }

  // ---- Ofertas ---------------------------------------------

  listOffers(): readonly StoreOffer[] {
    const rows = this.#db
      .prepare(`SELECT * FROM store_offers ORDER BY position ASC, name COLLATE NOCASE`)
      .all() as OfferRow[];

    return this.#withChildren(rows);
  }

  listOffersByCategory(categoryId: string): readonly StoreOffer[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM store_offers
          WHERE category_id = @categoryId
          ORDER BY position ASC, name COLLATE NOCASE`,
      )
      .all({ categoryId }) as OfferRow[];

    return this.#withChildren(rows);
  }

  getOffer(id: string): StoreOffer | null {
    const row = this.#db.prepare(`SELECT * FROM store_offers WHERE id = @id`).get({ id }) as
      | OfferRow
      | undefined;

    return row === undefined ? null : (this.#withChildren([row])[0] ?? null);
  }

  /**
   * Cola os itens e as vantagens nas ofertas.
   *
   * ####  DUAS CONSULTAS, E NÃO UMA POR OFERTA  ####
   *
   * Uma consulta por oferta transformaria listar a loja em N+1 idas
   * ao banco. Com trinta ofertas isso é trinta consultas para
   * desenhar uma grade — e a grade é pedida a cada clique numa
   * categoria.
   */
  #withChildren(rows: readonly OfferRow[]): readonly StoreOffer[] {
    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const holes = ids.map(() => '?').join(', ');

    const itemRows = this.#db
      .prepare(
        `SELECT offer_id, shortname, item_id, skin_id, amount
           FROM store_offer_items
          WHERE offer_id IN (${holes})
          ORDER BY position ASC`,
      )
      .all(...ids) as OfferItemRow[];

    const perkRows = this.#db
      .prepare(
        `SELECT offer_id, text
           FROM store_offer_perks
          WHERE offer_id IN (${holes})
          ORDER BY position ASC`,
      )
      .all(...ids) as OfferPerkRow[];

    const itemsBy = new Map<string, OfferItem[]>();

    for (const item of itemRows) {
      const list = itemsBy.get(item.offer_id) ?? [];

      list.push({
        shortname: item.shortname,
        itemId: item.item_id,
        skinId: item.skin_id,
        amount: item.amount,
      });

      itemsBy.set(item.offer_id, list);
    }

    const perksBy = new Map<string, string[]>();

    for (const perk of perkRows) {
      const list = perksBy.get(perk.offer_id) ?? [];

      list.push(perk.text);
      perksBy.set(perk.offer_id, list);
    }

    return rows.map((row) => toOffer(row, itemsBy.get(row.id) ?? [], perksBy.get(row.id) ?? []));
  }

  /**
   * Grava a oferta e o conteúdo dela.
   *
   * ####  TUDO NUMA TRANSAÇÃO  ####
   *
   * Os filhos são APAGADOS e regravados — é o que faz remover um
   * item do kit funcionar sem um "delete" próprio. Se o processo
   * morresse entre o apagar e o gravar, o kit ficaria vazio na loja:
   * comprável, cobrado, e entregando nada.
   */
  saveOffer(id: string, input: StoreOfferInput, now = Date.now()): StoreOffer {
    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO store_offers
             (id, category_id, kind, icon_shortname, icon_item_id, icon_skin_id,
              vip_tier, vip_days, vehicle_prefab, vehicle_fuel, name, price,
              position, enabled, badge, old_price, created_at, updated_at)
           VALUES
             (@id, @categoryId, @kind, @iconShortname, @iconItemId, @iconSkinId,
              @vipTier, @vipDays, @vehiclePrefab, @vehicleFuel, @name, @price,
              @position, @enabled, @badge, @oldPrice, @now, @now)
           ON CONFLICT(id) DO UPDATE SET
             category_id    = excluded.category_id,
             kind           = excluded.kind,
             icon_shortname = excluded.icon_shortname,
             icon_item_id   = excluded.icon_item_id,
             icon_skin_id   = excluded.icon_skin_id,
             vip_tier       = excluded.vip_tier,
             vip_days       = excluded.vip_days,
             vehicle_prefab = excluded.vehicle_prefab,
             vehicle_fuel   = excluded.vehicle_fuel,
             name           = excluded.name,
             price          = excluded.price,
             position       = excluded.position,
             enabled        = excluded.enabled,
             badge          = excluded.badge,
             old_price      = excluded.old_price,
             updated_at     = excluded.updated_at`,
        )
        .run({
          id,
          categoryId: input.categoryId,
          kind: input.kind,
          iconShortname: input.icon.shortname,
          iconItemId: input.icon.itemId,
          iconSkinId: input.icon.skinId,
          vipTier: input.vip?.tier ?? null,
          vipDays: input.vip?.days ?? null,
          vehiclePrefab: input.vehicle?.prefab ?? null,
          vehicleFuel: input.vehicle?.fuel ?? 0,
          name: input.name,
          price: input.price,
          position: input.position,
          enabled: input.enabled ? 1 : 0,
          badge: input.badge,
          oldPrice: input.oldPrice,
          now,
        });

      this.#removeOfferChildren(id);

      const insertItem = this.#db.prepare(
        `INSERT INTO store_offer_items
           (id, offer_id, shortname, item_id, skin_id, amount, position)
         VALUES (@rowId, @id, @shortname, @itemId, @skinId, @amount, @position)`,
      );

      for (const [index, item] of input.items.entries()) {
        insertItem.run({
          rowId: `${id}_i${String(index)}`,
          id,
          shortname: item.shortname,
          itemId: item.itemId,
          skinId: item.skinId,
          amount: item.amount,
          position: index,
        });
      }

      const insertPerk = this.#db.prepare(
        `INSERT INTO store_offer_perks (id, offer_id, text, position)
         VALUES (@rowId, @id, @text, @position)`,
      );

      for (const [index, perk] of input.perks.entries()) {
        insertPerk.run({ rowId: `${id}_p${String(index)}`, id, text: perk, position: index });
      }
    });

    write();

    const saved = this.getOffer(id);

    if (saved === null) {
      throw new Error(`oferta ${id} não pôde ser lida após a gravação`);
    }

    return saved;
  }

  removeOffer(id: string): boolean {
    const remove = this.#db.transaction((offerId: string) => {
      this.#removeOfferChildren(offerId);

      return this.#db.prepare(`DELETE FROM store_offers WHERE id = @id`).run({ id: offerId });
    });

    return remove(id).changes > 0;
  }

  /** Itens e vantagens de uma oferta. Ver `removeCategory`. */
  #removeOfferChildren(offerId: string): void {
    this.#db.prepare(`DELETE FROM store_offer_items WHERE offer_id = @id`).run({ id: offerId });
    this.#db.prepare(`DELETE FROM store_offer_perks WHERE offer_id = @id`).run({ id: offerId });
  }

  // ---- Compras ---------------------------------------------

  /**
   * Registra a compra.
   *
   * O servidor vem DENTRO do objeto, e não como primeiro argumento:
   * ele é um campo da compra como o steamId e o preço, e a chamada
   * já monta o objeto inteiro. Nas leituras, que não têm objeto, ele
   * é um filtro entre outros.
   */
  createPurchase(
    purchase: Omit<StorePurchase, 'createdAt' | 'updatedAt'>,
    now = Date.now(),
  ): StorePurchase {
    this.#db
      .prepare(
        `INSERT INTO store_purchases
           (id, server_id, steam_id, offer_id, offer_name, shortname, skin_id, amount,
            unit_price, total_price, state, error, created_at, updated_at)
         VALUES
           (@id, @serverId, @steamId, @offerId, @offerName, @shortname, @skinId, @amount,
            @unitPrice, @totalPrice, @state, @error, @now, @now)`,
      )
      .run({
        id: purchase.id,
        serverId: purchase.serverId,
        steamId: purchase.steamId,
        offerId: purchase.offerId,
        offerName: purchase.offerName,
        shortname: purchase.shortname,
        skinId: purchase.skinId,
        amount: purchase.amount,
        unitPrice: purchase.unitPrice,
        totalPrice: purchase.totalPrice,
        state: purchase.state,
        error: purchase.error,
        now,
      });

    const saved = this.getPurchase(purchase.serverId, purchase.id);

    if (saved === null) {
      throw new Error(`compra ${purchase.id} não pôde ser lida após a gravação`);
    }

    return saved;
  }

  setPurchaseState(
    serverId: string,
    id: string,
    state: PurchaseState,
    error: string | null = null,
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE store_purchases
            SET state = @state, error = @error, updated_at = @now
          WHERE server_id = @serverId AND id = @id`,
      )
      .run({ serverId, id, state, error, now });
  }

  getPurchase(serverId: string, id: string): StorePurchase | null {
    const row = this.#db
      .prepare(`SELECT * FROM store_purchases WHERE server_id = @serverId AND id = @id`)
      .get({ serverId, id }) as PurchaseRow | undefined;

    return row === undefined ? null : toPurchase(row);
  }

  // ---- A auditoria -----------------------------------------

  /**
   * Registra uma mexida na loja.
   *
   * NUNCA lança para quem chama: uma falha em auditar não pode
   * desfazer a edição que já aconteceu. O que se perde é a linha do
   * histórico — ruim, e melhor que um 500 depois de gravar.
   */
  audit(entry: {
    readonly actor: string | null;
    readonly action: string;
    readonly target: string;
    readonly detail?: string | null;
  }, now = Date.now()): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO store_audit (at, actor, action, target, detail)
           VALUES (@at, @actor, @action, @target, @detail)`,
        )
        .run({
          at: now,
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          detail: entry.detail ?? null,
        });
    } catch {
      // Ver o cabeçalho do método.
    }
  }

  listAudit(limit = 100): readonly {
    readonly id: number;
    readonly at: number;
    readonly actor: string | null;
    readonly action: string;
    readonly target: string;
    readonly detail: string | null;
  }[] {
    return this.#db
      .prepare(`SELECT * FROM store_audit ORDER BY at DESC, id DESC LIMIT @limit`)
      .all({ limit }) as {
      readonly id: number;
      readonly at: number;
      readonly actor: string | null;
      readonly action: string;
      readonly target: string;
      readonly detail: string | null;
    }[];
  }

  // ---- Os números da visão geral ---------------------------

  /**
   * O que a primeira tela da loja precisa responder.
   *
   * ####  UMA CONSULTA POR PERGUNTA, E NÃO UMA POR CARD  ####
   *
   * São agregações do MESMO conjunto de linhas. Fazê-las no
   * JavaScript exigiria trazer o histórico inteiro para a memória a
   * cada abertura da tela — e ele é a tabela que mais cresce.
   */
  stats(since: number): {
    readonly offers: number;
    readonly categories: number;
    readonly revenue: number;
    readonly delivered: number;
    readonly refunded: number;
    readonly stuck: number;
    readonly buyers: number;
    readonly top: readonly { readonly name: string; readonly count: number; readonly total: number }[];
  } {
    const one = (sql: string, params: Record<string, unknown> = {}): number =>
      ((this.#db.prepare(sql).get(params) as { readonly value: number | null } | undefined)?.value ??
        0);

    return {
      offers: one(`SELECT count(*) AS value FROM store_offers WHERE enabled = 1`),
      categories: one(`SELECT count(*) AS value FROM store_categories WHERE enabled = 1`),
      // Só o que foi ENTREGUE conta como receita: uma compra
      // estornada não é venda, e uma presa é problema — somá-las
      // faria o número mais visível da tela ser o mais errado.
      revenue: one(
        `SELECT coalesce(sum(total_price), 0) AS value FROM store_purchases
          WHERE state = 'delivered' AND created_at >= @since`,
        { since },
      ),
      delivered: one(
        `SELECT count(*) AS value FROM store_purchases
          WHERE state = 'delivered' AND created_at >= @since`,
        { since },
      ),
      refunded: one(
        `SELECT count(*) AS value FROM store_purchases
          WHERE state = 'refunded' AND created_at >= @since`,
        { since },
      ),
      // As presas NÃO são filtradas por data: uma compra que travou
      // há um mês continua sendo alguém que pagou e não recebeu.
      stuck: one(`SELECT count(*) AS value FROM store_purchases WHERE state = 'failed'`),
      buyers: one(
        `SELECT count(DISTINCT steam_id) AS value FROM store_purchases
          WHERE state = 'delivered' AND created_at >= @since`,
        { since },
      ),
      top: this.#db
        .prepare(
          `SELECT offer_name AS name, count(*) AS count, sum(total_price) AS total
             FROM store_purchases
            WHERE state = 'delivered' AND created_at >= @since
            GROUP BY offer_name
            ORDER BY count DESC, total DESC
            LIMIT 5`,
        )
        .all({ since }) as { readonly name: string; readonly count: number; readonly total: number }[],
    };
  }

  /**
   * O histórico.
   *
   * `serverId` ausente = a rede inteira. É a forma da tela de
   * compras presas: o que travou não pertence a um servidor na
   * cabeça de quem procura — pertence à loja.
   */
  listPurchases(
    options: {
      readonly serverId?: string;
      readonly state?: PurchaseState;
      readonly steamId?: string;
      readonly limit?: number;
    } = {},
  ): readonly StorePurchase[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };

    if (options.serverId !== undefined) {
      conditions.push('server_id = @serverId');
      params.serverId = options.serverId;
    }

    if (options.state !== undefined) {
      conditions.push('state = @state');
      params.state = options.state;
    }

    if (options.steamId !== undefined) {
      conditions.push('steam_id = @steamId');
      params.steamId = options.steamId;
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

    const rows = this.#db
      .prepare(`SELECT * FROM store_purchases ${where} ORDER BY created_at DESC LIMIT @limit`)
      .all(params) as PurchaseRow[];

    return rows.map(toPurchase);
  }
}
