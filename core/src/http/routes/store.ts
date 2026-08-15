// ============================================================
//  routes/store.ts  -  a vitrine, a carteira e o histórico.
//
//      GET    /store/categories            as abas da loja
//      POST   /store/categories            cria
//      PUT    /store/categories/:id        edita
//      DELETE /store/categories/:id        remove (e as ofertas)
//      GET    /store/offers                tudo, ou de uma categoria
//      POST   /store/offers                cria
//      PUT    /store/offers/:id            edita (a oferta INTEIRA)
//      DELETE /store/offers/:id            remove
//      GET    /store/purchases             o histórico
//      GET    /players/:steamId/wallet     saldo e extrato
//      POST   /players/:steamId/wallet     crédito ou débito à mão
//      POST   /servers/:id/store/buy       compra fora do jogo
//
//  ------------------------------------------------------------
//  ####  A LOJA É DA REDE; A COMPRA É DE UM SERVIDOR  ####
//
//  Por isso as duas famílias de rota. Editar uma oferta muda a
//  vitrine de todo servidor; comprar acontece onde o inventário
//  existe — é lá que o item nasce.
//
//  ####  O PUT REESCREVE A OFERTA INTEIRA  ####
//
//  Não é PATCH, pela mesma razão dos kits: a tela edita a oferta num
//  formulário só e manda tudo. Um merge parcial abriria a pergunta
//  "o que acontece com os itens que não vieram?", e a única resposta
//  segura para ela seria não mexer — o oposto do que espera quem
//  apagou um item na tela.
//
//  ####  AS DATAS SAEM EM ISO  ####
//
//  O banco guarda epoch ms; a borda converte. Num lugar só, e é
//  este.
//
//  ####  E O DINHEIRO É INTEIRO  ####
//
//  `z.number().int()` em preço e em saldo. OZCoin não tem centavo, e
//  o zod é o único lugar onde dá para recusar um float antes de ele
//  virar linha no banco.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { assertSteamId } from '../../bans/service.js';
import {
  OFFER_BADGES,
  OFFER_KINDS,
  type StoreCategory,
  type StoreOffer,
  type StorePurchase,
  type StoreRepository,
} from '../../db/store-repository.js';
import type { WalletsRepository } from '../../db/wallets-repository.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { describePurchase, type StoreService } from '../../store/service.js';
import type { Wallet } from '../../store/wallet.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface StoreRoutesDeps {
  readonly repository: StoreRepository;
  readonly wallets: WalletsRepository;
  readonly service: StoreService;
  readonly wallet: Wallet;
  readonly supervisor: ServerSupervisor;
}

/** Tamanho de página do histórico e do extrato. */
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 500;

const idParams = z.object({ id: z.string().min(1).max(64) });
const serverParams = z.object({ id: z.string().min(1) });
const steamParams = z.object({ steamId: z.string().min(1) });

const categoryBody = z
  .object({
    name: z.string().trim().min(1).max(48),
    position: z.number().int().min(0).max(999).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();

const offerItemSchema = z
  .object({
    shortname: z.string().trim().min(1).max(64),
    /** Pode ser negativo — `hat.wolf` é `-1478212975`. */
    itemId: z.number().int(),
    // String, e não número: skin de workshop passa de 2^53.
    skinId: z
      .string()
      .regex(/^\d+$/, 'a skin é um número inteiro em texto')
      .max(24)
      .default('0'),
    amount: z.number().int().min(1).max(1_000_000),
  })
  .strict();

/**
 * O corpo de criação e de edição de uma oferta.
 *
 * O `superRefine` é onde os quatro formatos ficam honestos: um VIP
 * sem nível e um veículo sem prefab são pedidos que o banco
 * aceitaria (as colunas são anuláveis) e que o jogador descobriria
 * como "paguei e não recebi".
 */
const offerBody = z
  .object({
    categoryId: z.string().min(1).max(64),
    kind: z.enum(OFFER_KINDS),
    name: z.string().trim().min(1).max(64),
    /** Em OZCoin INTEIRO. Ver o cabeçalho. */
    price: z.number().int().min(0).max(100_000_000),
    oldPrice: z.number().int().min(0).max(100_000_000).nullable().default(null),
    position: z.number().int().min(0).max(999).default(0),
    enabled: z.boolean().default(true),
    badge: z.enum(OFFER_BADGES).nullable().default(null),
    icon: z
      .object({
        shortname: z.string().trim().min(1).max(64),
        itemId: z.number().int(),
        skinId: z
          .string()
          .regex(/^\d+$/)
          .max(24)
          .default('0'),
      })
      .strict(),
    items: z.array(offerItemSchema).max(40).default([]),
    perks: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    vip: z
      .object({
        tier: z.string().trim().min(1).max(32),
        /** `null` = vitalício. */
        days: z.number().int().min(1).max(3650).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    vehicle: z
      .object({
        prefab: z.string().trim().min(1).max(64),
        fuel: z.number().int().min(0).max(1000).default(0),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((offer, ctx) => {
    if (offer.kind === 'vip' && offer.vip === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vip'],
        message:
          'uma oferta de VIP precisa dizer QUAL nível ela concede. Sem isso ela cobraria e não ' +
          'daria nada — e a entrega seria estornada',
      });
    }

    if (offer.kind === 'vehicle' && offer.vehicle === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vehicle'],
        message:
          'uma oferta de veículo precisa do prefab (minicopter, rowboat, sedan). O jogo resolve o ' +
          'nome curto — o caminho completo muda quando a Facepunch move um arquivo',
      });
    }

    if (offer.kind === 'bundle' && offer.items.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'um kit sem itens seria comprável, cobrado, e entregaria nada',
      });
    }

    if (offer.kind === 'item' && offer.items.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message:
          'uma oferta de item entrega EXATAMENTE um item. Para vender vários numa compra, use o ' +
          'formato "bundle" — ele mostra a lista do que vem dentro',
      });
    }

    if (offer.oldPrice !== null && offer.oldPrice <= offer.price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oldPrice'],
        message:
          'o preço antigo precisa ser MAIOR que o atual: ele é riscado ao lado para mostrar o ' +
          'desconto, e um valor menor anunciaria um aumento',
      });
    }
  });

const purchaseQuery = z.object({
  serverId: z.string().min(1).optional(),
  steamId: z.string().min(1).optional(),
  state: z.enum(['pending', 'debited', 'delivered', 'refunded', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
});

const walletBody = z
  .object({
    /** Negativo TIRA. Ver a rota. */
    amount: z.number().int().refine((value) => value !== 0, 'um lançamento de zero não move nada'),
    reason: z.string().trim().min(1).max(120),
  })
  .strict();

const buyBody = z
  .object({
    steamId: z.string().min(1),
    offerId: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(1000).default(1),
  })
  .strict();

export function registerStoreRoutes(app: FastifyInstance, deps: StoreRoutesDeps): void {
  // ==========================================================
  //  As categorias
  // ==========================================================

  app.get('/store/categories', async () => ({
    ok: true,
    categories: deps.repository.listCategories().map(toCategoryView),
  }));

  app.post('/store/categories', async (request, reply) => {
    const body = categoryBody.parse(request.body);
    const category = deps.repository.saveCategory(randomUUID(), body);

    deps.repository.audit({
      actor: operatorOf(request),
      action: 'category.create',
      target: category.name,
    });

    request.log.info(
      { category: category.id, name: category.name, by: operatorOf(request) },
      'categoria da loja criada',
    );

    return reply.code(201).send({ ok: true, category: toCategoryView(category) });
  });

  app.put('/store/categories/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = categoryBody.parse(request.body);

    const before = assertCategory(deps, id);
    const saved = deps.repository.saveCategory(id, body);

    deps.repository.audit({
      actor: operatorOf(request),
      action: 'category.update',
      target: saved.name,
      detail: describeCategoryChange(before, saved),
    });

    return { ok: true, category: toCategoryView(saved) };
  });

  app.delete('/store/categories/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const category = assertCategory(deps, id);
    const offers = deps.repository.listOffersByCategory(id).length;

    deps.repository.removeCategory(id);

    deps.repository.audit({
      actor: operatorOf(request),
      action: 'category.remove',
      target: category.name,
      detail: offers === 0 ? null : `levou ${String(offers)} oferta(s) junto`,
    });

    request.log.warn({ category: id, offers, by: operatorOf(request) }, 'categoria da loja removida');

    return {
      ok: true,
      message:
        offers === 0
          ? `A categoria "${category.name}" saiu da loja.`
          : `A categoria "${category.name}" saiu da loja e levou ${String(offers)} oferta(s) junto.`,
    };
  });

  // ==========================================================
  //  As ofertas
  // ==========================================================

  app.get('/store/offers', async (request) => {
    const query = z.object({ categoryId: z.string().min(1).optional() }).parse(request.query);

    const offers =
      query.categoryId === undefined
        ? deps.repository.listOffers()
        : deps.repository.listOffersByCategory(query.categoryId);

    return { ok: true, offers: offers.map(toOfferView) };
  });

  app.post('/store/offers', async (request, reply) => {
    const body = offerBody.parse(request.body);

    assertCategory(deps, body.categoryId);

    const offer = deps.repository.saveOffer(randomUUID(), body);

    deps.repository.audit({
      actor: operatorOf(request),
      action: 'offer.create',
      target: offer.name,
      detail: `${offer.kind}, ${String(offer.price)} OZ`,
    });

    request.log.info(
      { offer: offer.id, name: offer.name, kind: offer.kind, by: operatorOf(request) },
      'oferta da loja criada',
    );

    return reply.code(201).send({ ok: true, offer: toOfferView(offer) });
  });

  app.put('/store/offers/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = offerBody.parse(request.body);

    const before = deps.repository.getOffer(id);

    if (before === null) {
      throw new ApiError('OFFER_NOT_FOUND', `Não existe oferta com o id "${id}".`, 404);
    }

    assertCategory(deps, body.categoryId);

    const saved = deps.repository.saveOffer(id, body);

    deps.repository.audit({
      actor: operatorOf(request),
      action: 'offer.update',
      target: saved.name,
      detail: describeOfferChange(before, saved),
    });

    return { ok: true, offer: toOfferView(saved) };
  });

  app.delete('/store/offers/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const offer = deps.repository.getOffer(id);

    if (offer === null) {
      throw new ApiError('OFFER_NOT_FOUND', `Não existe oferta com o id "${id}".`, 404);
    }

    deps.repository.removeOffer(id);

    deps.repository.audit({
      actor: operatorOf(request),
      action: 'offer.remove',
      target: offer.name,
      detail: `${offer.kind}, ${String(offer.price)} OZ`,
    });

    request.log.warn({ offer: id, name: offer.name, by: operatorOf(request) }, 'oferta removida');

    return {
      ok: true,
      // O histórico NÃO vai junto: `store_purchases` guarda uma cópia
      // do que foi vendido, e é ela que responde "quanto custou".
      message: `A oferta "${offer.name}" saiu da loja. As compras já feitas continuam no histórico.`,
    };
  });

  // ==========================================================
  //  O histórico
  // ==========================================================

  /**
   * O resumo da loja: o que a primeira tela mostra.
   *
   * `days` é a janela do que MUDA (receita, compras, compradores).
   * As compras PRESAS ficam de fora dela: uma que travou há um mês
   * continua sendo alguém que pagou e não recebeu.
   */
  app.get('/store/stats', async (request) => {
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).optional() })
      .parse(request.query);

    const window = days ?? 7;
    const since = Date.now() - window * 24 * 60 * 60 * 1000;

    return {
      ok: true,
      days: window,
      source: deps.wallet.source,
      stats: deps.repository.stats(since),
    };
  });

  /** Quem mexeu na loja, e o quê. Ver a migração 021. */
  app.get('/store/audit', async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).optional() })
      .parse(request.query);

    return {
      ok: true,
      entries: deps.repository.listAudit(limit ?? DEFAULT_HISTORY_LIMIT).map((entry) => ({
        ...entry,
        at: new Date(entry.at).toISOString(),
      })),
    };
  });

  app.get('/store/purchases', async (request) => {
    const query = purchaseQuery.parse(request.query);

    const purchases = deps.repository.listPurchases({
      ...(query.serverId === undefined ? {} : { serverId: query.serverId }),
      ...(query.steamId === undefined ? {} : { steamId: query.steamId }),
      ...(query.state === undefined ? {} : { state: query.state }),
      limit: query.limit ?? DEFAULT_HISTORY_LIMIT,
    });

    return { ok: true, purchases: purchases.map(toPurchaseView) };
  });

  // ==========================================================
  //  A carteira
  // ==========================================================

  app.get('/players/:steamId/wallet', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    const balance = await deps.wallet.getBalance(steamId);

    return {
      ok: true,
      steamId,
      balance: balance.balance,
      // De ONDE veio. A tela precisa dizer isso: com a carteira
      // remota no ar, o extrato local é história, não o saldo de
      // hoje.
      source: balance.source,
      entries: deps.wallets.listEntries(steamId).map((entry) => ({
        ...entry,
        createdAt: new Date(entry.createdAt).toISOString(),
      })),
    };
  });

  /**
   * Crédito ou débito à mão.
   *
   * ####  ELE MEXE NA CARTEIRA LOCAL, E SÓ NELA  ####
   *
   * Com a carteira remota no ar, quem manda no saldo é o site — e um
   * crédito daqui criaria um número que ele não conhece. A recusa é
   * explícita em vez de silenciosa: creditar "com sucesso" um valor
   * que o jogador nunca veria seria pior.
   */
  app.post('/players/:steamId/wallet', async (request) => {
    const { steamId } = steamParams.parse(request.params);
    const body = walletBody.parse(request.body);

    assertSteamId(steamId);

    if (deps.wallet.source === 'remote') {
      throw new ApiError(
        'WALLET_IS_REMOTE',
        'O saldo deste agente vem do site externo (STORE_WALLET_URL). Lançamentos à mão precisam ' +
          'ser feitos lá — um crédito daqui criaria um número que o site não conhece.',
        409,
      );
    }

    const balance = deps.wallets.change(steamId, body.amount, null, body.reason);

    if (balance === null) {
      throw new ApiError(
        'INSUFFICIENT_FUNDS',
        `${steamId} tem ${String(deps.wallets.getBalance(steamId))} OZ, e o lançamento pedido ` +
          'deixaria o saldo negativo.',
        409,
      );
    }

    deps.repository.audit({
      actor: operatorOf(request),
      action: body.amount > 0 ? 'wallet.credit' : 'wallet.debit',
      target: steamId,
      detail: `${body.amount > 0 ? '+' : ''}${String(body.amount)} OZ — ${body.reason}`,
    });

    request.log.info(
      { steamId, amount: body.amount, balance, by: operatorOf(request) },
      'lançamento manual na carteira',
    );

    return { ok: true, steamId, balance };
  });

  // ==========================================================
  //  A compra fora do jogo
  //
  //  ####  ELA EXISTE PARA O SITE  ####
  //
  //  Dentro do jogo o caminho é outro: o clique vira uma linha de
  //  console autenticada por segredo (ver game/ui-sync.ts). Esta
  //  rota é para quem compra pelo site e para o teste manual — e ela
  //  cobra do MESMO jeito, pelo mesmo serviço.
  // ==========================================================

  app.post('/servers/:id/store/buy', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = buyBody.parse(request.body);

    assertSteamId(body.steamId);
    assertServer(deps, id);

    const outcome = await deps.service.buy({
      serverId: id,
      steamId: body.steamId,
      offerId: body.offerId,
      quantity: body.quantity,
    });

    const message = describePurchase(outcome);

    request.log.info(
      {
        server: id,
        steamId: body.steamId,
        offerId: body.offerId,
        outcome: outcome.status,
        by: operatorOf(request),
      },
      'compra pedida pela API',
    );

    if (outcome.status === 'ok') {
      return {
        ok: true,
        message,
        purchase: toPurchaseView(outcome.purchase),
        balance: outcome.balance,
      };
    }

    // ####  O DESFECHO RUIM É UM ERRO HTTP, E NÃO UM 200  ####
    //
    // Quem chama isto é um site, e um `200 {ok:false}` seria tratado
    // como sucesso por metade dos clientes HTTP que existem.
    throw new ApiError(errorCodeOf(outcome.status), message, httpStatusOf(outcome.status));
  });
}

// ------------------------------------------------------------
//  Conversões para a borda
// ------------------------------------------------------------

function toCategoryView(category: StoreCategory): Record<string, unknown> {
  return {
    ...category,
    createdAt: new Date(category.createdAt).toISOString(),
    updatedAt: new Date(category.updatedAt).toISOString(),
  };
}

function toOfferView(offer: StoreOffer): Record<string, unknown> {
  return {
    ...offer,
    createdAt: new Date(offer.createdAt).toISOString(),
    updatedAt: new Date(offer.updatedAt).toISOString(),
  };
}

function toPurchaseView(purchase: StorePurchase): Record<string, unknown> {
  return {
    ...purchase,
    createdAt: new Date(purchase.createdAt).toISOString(),
    updatedAt: new Date(purchase.updatedAt).toISOString(),
  };
}

// ------------------------------------------------------------
//  O que mudou, em uma frase
//
//  ####  A AUDITORIA GUARDA A FRASE, E NÃO UM DIFF  ####
//
//  Quem lê "preço 5000 -> 4500" entende na hora. Um diff
//  estruturado exigiria versionar a oferta inteira para ser
//  reconstruído — e quem quiser o estado de HOJE abre a vitrine.
//
//  Só o que MUDOU entra: uma linha listando os dez campos iguais
//  esconderia o único que não está.
// ------------------------------------------------------------

function describeCategoryChange(before: StoreCategory, after: StoreCategory): string | null {
  const changes: string[] = [];

  if (before.name !== after.name) {
    changes.push(`nome ${before.name} -> ${after.name}`);
  }

  if (before.enabled !== after.enabled) {
    changes.push(after.enabled ? 'ligada' : 'DESLIGADA (some da loja com as ofertas)');
  }

  if (before.position !== after.position) {
    changes.push(`ordem ${String(before.position)} -> ${String(after.position)}`);
  }

  return changes.length === 0 ? null : changes.join('; ');
}

function describeOfferChange(before: StoreOffer, after: StoreOffer): string | null {
  const changes: string[] = [];

  if (before.name !== after.name) {
    changes.push(`nome ${before.name} -> ${after.name}`);
  }

  // O preço primeiro entre os números: é a mudança que o jogador
  // percebe, e a que gera a pergunta que traz alguém a esta tela.
  if (before.price !== after.price) {
    changes.push(`preço ${String(before.price)} -> ${String(after.price)} OZ`);
  }

  if (before.oldPrice !== after.oldPrice) {
    changes.push(
      after.oldPrice === null
        ? 'sem preço riscado'
        : `preço riscado ${String(after.oldPrice)} OZ`,
    );
  }

  if (before.enabled !== after.enabled) {
    changes.push(after.enabled ? 'na vitrine' : 'FORA da vitrine');
  }

  if (before.badge !== after.badge) {
    changes.push(`etiqueta ${before.badge ?? 'nenhuma'} -> ${after.badge ?? 'nenhuma'}`);
  }

  if (before.categoryId !== after.categoryId) {
    changes.push('mudou de categoria');
  }

  if (before.items.length !== after.items.length) {
    changes.push(`${String(before.items.length)} -> ${String(after.items.length)} item(ns)`);
  }

  return changes.length === 0 ? null : changes.join('; ');
}

// ------------------------------------------------------------
//  Recusas
// ------------------------------------------------------------

function assertCategory(deps: StoreRoutesDeps, id: string): StoreCategory {
  const category = deps.repository.getCategory(id);

  if (category === null) {
    throw new ApiError(
      'CATEGORY_NOT_FOUND',
      `Não existe categoria com o id "${id}". A oferta precisa de uma aba onde aparecer.`,
      404,
    );
  }

  return category;
}

function assertServer(deps: StoreRoutesDeps, id: string): void {
  if (!deps.supervisor.list().some((server) => server.id === id)) {
    throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${id}".`, 404);
  }
}

/** O código do desfecho, para quem lê a resposta por programa. */
function errorCodeOf(status: string): string {
  switch (status) {
    case 'offer-not-found':
      return 'OFFER_NOT_FOUND';
    case 'offer-disabled':
      return 'OFFER_DISABLED';
    case 'insufficient':
      return 'INSUFFICIENT_FUNDS';
    case 'wallet-unavailable':
      return 'WALLET_UNAVAILABLE';
    case 'no-space':
      return 'NO_SPACE';
    default:
      return 'DELIVERY_FAILED';
  }
}

/**
 * O status HTTP de cada desfecho.
 *
 * `insufficient` e `no-space` são **409**: o pedido estava certo, o
 * estado é que não permite. `wallet-unavailable` é **503**, porque é
 * RETENTÁVEL — e essa diferença é o que separa "não insista" de
 * "tente de novo em instantes".
 */
function httpStatusOf(status: string): number {
  switch (status) {
    case 'offer-not-found':
      return 404;
    case 'offer-disabled':
    case 'insufficient':
    case 'no-space':
      return 409;
    case 'wallet-unavailable':
      return 503;
    default:
      return 502;
  }
}
