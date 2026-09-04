// ============================================================
//  catalog-mirror.ts  -  a loja in-game vista pelo painel do site.
//
//  ####  SNAPSHOT SUBSTITUI, NUNCA MESCLA  ####
//
//  Produto que sumiu do espelho SAIU DA LOJA, não foi esquecido. Um
//  merge deixaria produto apagado à venda para sempre.
//
//  ####  `generatedAt` FICA FORA DO HASH  ####
//
//  Se entrasse, a `version` mudaria a cada montagem, o espelho seria
//  empurrado a cada volta do relógio, e o catálogo inteiro
//  atravessaria a internet por nada.
//
//  ####  AQUI O RELÓGIO É A CONVERGÊNCIA  ####
//
//  No catálogo do Conan o push é otimização e o POLL do agente é a
//  garantia. Aqui a direção é invertida e não há poll do outro lado:
//  desligar o relógio é aceitar catálogo velho para sempre. Por isso
//  um push que falha não alarma, não bloqueia a loja in-game e não
//  derruba o save da oferta — ele só deixa `lastPushError`
//  preenchido, para a tela dizer por quê.
//
//  ####  A RECEITA DA ENTREGA NÃO VIAJA  ####
//
//  `offer.items[]`, `vip` e `vehicle` ficam. O painel precisa VER a
//  loja para vender, não precisa saber como o item nasce — e vazar
//  isso daria a receita a quem lesse a resposta dele.
//
//  ####  UM CATÁLOGO, N DESTINOS  ####
//
//  As tabelas da loja não têm `server_id`: a loja é UMA, e todos os
//  servidores mostram a mesma. Com N pareamentos, o mesmo snapshot é
//  empurrado para N `Server` do site, e cada um guarda a própria
//  versão confirmada.
//
//  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §13.
// ============================================================

import { createHash } from 'node:crypto';

import type { MetaRepository } from '../db/meta-repository.js';
import type { StoreRepository } from '../db/store-repository.js';
import type { Logger } from '../logger.js';
import type { SiteClient } from '../site/client.js';
import { toError } from '../util.js';

/** O site recusa acima disto; o agente recusa ANTES de sair. */
export const MIRROR_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MIRROR_INTERVAL_MS = 60_000;
/** Três saves em dois segundos viram UM push, com o último estado. */
export const MIRROR_DEBOUNCE_MS = 2_000;

export interface MirrorPayload {
  readonly version: string;
  readonly generatedAt: string;
  readonly currency: 'OZ';
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly enabled: boolean;
  }[];
  readonly offers: readonly {
    readonly id: string;
    readonly categoryId: string;
    readonly kind: string;
    readonly name: string;
    readonly price: number;
    readonly oldPrice: number | null;
    readonly badge: string | null;
    readonly position: number;
    readonly enabled: boolean;
    readonly icon: { readonly shortname: string; readonly itemId: number; readonly skinId: string };
    /** No lugar dos itens: é o que a vitrine precisa para dizer "kit com 8". */
    readonly itemCount: number;
    readonly perks: readonly string[];
  }[];
}

/**
 * JSON com as CHAVES de objeto ordenadas.
 *
 * Elemento de array NÃO é ordenado: ordem de array é conteúdo, e
 * reordenar aqui esconderia uma mudança de posição de oferta.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(',')}}`;
}

/** sha256 do corpo canônico SEM `version` e SEM `generatedAt`. */
export function versionOf(payload: Omit<MirrorPayload, 'version' | 'generatedAt'>): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * O catálogo de AGORA, sem a receita da entrega.
 *
 * A ordem vem do banco (`ORDER BY position, name COLLATE NOCASE`), e
 * não é reordenada aqui: duas verdades sobre a ordem passariam a
 * existir.
 */
export function buildMirror(
  repository: StoreRepository,
  now: number,
): { readonly payload: MirrorPayload; readonly version: string } {
  const categories = repository.listCategories();
  const body = {
    currency: 'OZ' as const,
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      position: category.position,
      enabled: category.enabled,
    })),
    offers: categories.flatMap((category) =>
      repository.listOffersByCategory(category.id).map((offer) => ({
        id: offer.id,
        categoryId: category.id,
        kind: offer.kind,
        name: offer.name,
        price: offer.price,
        oldPrice: offer.oldPrice,
        badge: offer.badge,
        position: offer.position,
        enabled: offer.enabled,
        icon: offer.icon,
        itemCount: offer.items.length,
        perks: offer.perks,
      })),
    ),
  };

  const version = versionOf(body);

  return { payload: { ...body, version, generatedAt: new Date(now).toISOString() }, version };
}

export interface CatalogMirrorOptions {
  /** Um por servidor pareado, na chave do id LOCAL. */
  readonly clients: ReadonlyMap<string, SiteClient>;
  readonly repository: StoreRepository;
  readonly meta: MetaRepository;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class CatalogMirror {
  readonly #options: CatalogMirrorOptions;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #running = false;
  /** Uma rodada em voo e, no máximo, uma pendente. */
  #dirty = false;
  #lastPushAt: number | null = null;
  #lastPushError: string | null = null;

  constructor(options: CatalogMirrorOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(
      () => {
        void this.push();
      },
      this.#options.intervalMs ?? DEFAULT_MIRROR_INTERVAL_MS,
    );
    this.#timer.unref();

    void this.push();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    if (this.#debounce !== null) {
      clearTimeout(this.#debounce);
      this.#debounce = null;
    }
  }

  /** O que a tela de estado mostra. */
  get status(): {
    readonly version: string;
    readonly mirrored: readonly { readonly serverId: string; readonly version: string | null }[];
    readonly lastPushAt: number | null;
    readonly lastPushError: string | null;
  } {
    return {
      version: buildMirror(this.#options.repository, this.#now()).version,
      mirrored: [...this.#options.clients.keys()].map((serverId) => ({
        serverId,
        version: this.#options.meta.read(versionKey(serverId)),
      })),
      lastPushAt: this.#lastPushAt,
      lastPushError: this.#lastPushError,
    };
  }

  /**
   * Uma edição aconteceu.
   *
   * Chamada pelas rotas de catálogo SEM `await` e dentro de
   * try/catch: uma falha de push não pode desfazer uma edição que já
   * foi gravada.
   */
  notifyChanged(): void {
    if (this.#debounce !== null) {
      return;
    }

    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.push();
    }, MIRROR_DEBOUNCE_MS);
    this.#debounce.unref();
  }

  /** Uma rodada. Nunca lança. */
  async push(): Promise<void> {
    if (this.#running) {
      // Sem o bit de sujo, três saves em dois segundos abririam três
      // rodadas concorrentes — e a ordem de chegada na rede deixaria
      // de casar com a ordem de gravação: a tela diria V3 com o
      // painel mostrando V2.
      this.#dirty = true;

      return;
    }

    this.#running = true;

    try {
      do {
        this.#dirty = false;
        await this.#pushOnce();
      } while (this.#dirty);
    } catch (error) {
      this.#lastPushError = toError(error).message;
      this.#options.logger.warn({ err: toError(error) }, 'catalog mirror push failed');
    } finally {
      this.#running = false;
    }
  }

  async #pushOnce(): Promise<void> {
    const { payload, version } = buildMirror(this.#options.repository, this.#now());
    const body = JSON.stringify(payload);

    if (Buffer.byteLength(body, 'utf8') > MIRROR_MAX_BYTES) {
      // Truncar seria pior: meio catálogo no painel é uma mentira
      // mais cara que catálogo velho.
      this.#lastPushError = 'MIRROR_TOO_LARGE';
      this.#options.logger.error(
        { bytes: Buffer.byteLength(body, 'utf8'), max: MIRROR_MAX_BYTES },
        'catalog mirror is too large to send',
      );

      return;
    }

    for (const [serverId, client] of this.#options.clients) {
      const key = versionKey(serverId);

      if (this.#options.meta.read(key) === version) {
        continue;
      }

      // A pergunta barata antes do corpo inteiro: o site pode já ter
      // esta versão de uma rodada que respondeu tarde.
      const remote = await client.mirrorVersion();

      if (remote.ok && remote.body.version === version) {
        this.#remember(serverId, version);
        continue;
      }

      const result = await client.pushMirror(payload);

      if (!result.ok) {
        this.#lastPushError = result.code ?? result.reason;
        this.#options.logger.warn(
          { serverId, status: result.status, code: result.code },
          'the site refused the catalog mirror',
        );
        continue;
      }

      this.#remember(serverId, version);
      this.#lastPushAt = this.#now();
      this.#lastPushError = null;
      this.#options.logger.info({ serverId, version }, 'catalog mirror accepted');
    }
  }

  /**
   * A versão CONFIRMADA por aquele servidor.
   *
   * Se o site responder 2xx com uma `version` diferente da nossa,
   * ela é ignorada: só a que o agente gravou manda.
   */
  #remember(serverId: string, version: string): void {
    this.#options.meta.writeMany(
      {
        [versionKey(serverId)]: version,
        [`site.catalog.mirrored_at.${serverId}`]: String(this.#now()),
      },
      this.#now(),
    );
  }
}

function versionKey(serverId: string): string {
  return `site.catalog.mirrored_version.${serverId}`;
}
