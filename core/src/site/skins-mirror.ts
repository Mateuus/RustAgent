// ============================================================
//  skins-mirror.ts  -  o catálogo de SKINS do Workshop, contado ao
//  site para a vitrine e a caixa.
//
//  Ver Docs/OrigemZWorkshop/04-ENTREGA-PELO-SITE.md §2.
//
//  ####  É O RETRATO DA REDE, E VAI POR TODOS OS PAREAMENTOS  ####
//
//  O catálogo de skins não tem dono entre os servidores: a skin vale
//  na rede e a junção diz onde ela aparece. O canal com o site, ao
//  contrário, é pareado POR SERVIDOR — não existe um bearer "da
//  rede".
//
//  A decisão (17/09/2026, sem o site para confirmar): o MESMO
//  snapshot vai por TODOS os pareamentos com token, e cada um
//  pergunta a `version` antes. Isso funciona nos dois desenhos
//  possíveis do outro lado:
//
//    - o site guarda UM espelho da rede: o primeiro pareamento
//      grava, e os outros perguntam a versão, veem que bate e não
//      mandam nada. Custo: um GET por pareamento;
//    - o site guarda um espelho por servidor: cada um recebe o seu.
//
//  Escolher "um pareamento qualquer" quebraria o segundo desenho, e
//  quebraria o primeiro no dia em que o pareamento escolhido
//  perdesse o token.
//
//  ####  `servers` VIAJA COM O ID DO SITE  ####
//
//  A junção guarda o id LOCAL (`Configs<id>.ini`), que o site não
//  conhece. Aqui ele vira o `SITE_SERVER_ID` do pareamento. Servidor
//  sem pareamento some da lista: para o site, ele não existe.
//
//  ####  404 É "O SITE AINDA NÃO SABE DISSO"  ####
//
//  Até o site subir as rotas, todo pedido volta 404. Isso não é
//  defeito daqui: vira UM `debug` por pareamento por boot, e o
//  pareamento fica quieto até a próxima volta do relógio (10 min),
//  que tenta de novo em silêncio. Assim o espelho começa a andar
//  sozinho no dia em que o site publicar a rota, sem reiniciar o
//  agente e sem um aviso a cada 10 minutos.
//
//  ####  NADA AQUI LANÇA  ####
//
//  Roda num relógio. Um `throw` pararia o espelho em silêncio.
// ============================================================

import { createHash } from 'node:crypto';

import type { ItemsRepository } from '../db/items-repository.js';
import type { WorkshopSkinsRepository } from '../db/workshop-repository.js';
import type { Logger } from '../logger.js';
import { stableStringify } from '../store/catalog-mirror.js';
import type { WorkshopRarity, WorkshopSkin } from '../types/workshop.js';
import { toError } from '../util.js';
import type { SiteClient } from './client.js';

/** A garantia: mesmo sem aviso de mudança, confere a cada 10 min. */
export const DEFAULT_SKINS_MIRROR_INTERVAL_MS = 10 * 60_000;

/** Edições em sequência no painel viram UM push. */
export const SKINS_MIRROR_DEBOUNCE_MS = 5_000;

/** O teto do site, o mesmo do `items/mirror`. O snapshot não se fatia. */
export const SKINS_MIRROR_MAX = 3000;

/** O teto de corpo da rota: 1 MiB. */
export const SKINS_MIRROR_MAX_BYTES = 1024 * 1024;

/**
 * As categorias que o contrato aceita (04 §2), em minúsculas.
 *
 * O espelho `items` guarda o nome do enum do jogo (`Weapon`,
 * `Attire`…). O que não estiver aqui — `Component`, por exemplo —
 * vai como `misc`.
 */
export const SKIN_CATEGORIES = [
  'weapon',
  'attire',
  'tool',
  'construction',
  'items',
  'traps',
  'electrical',
  'medical',
  'ammunition',
  'resources',
  'food',
  'fun',
  'misc',
] as const;

export type SkinCategory = (typeof SKIN_CATEGORIES)[number];

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(SKIN_CATEGORIES);

/** A categoria do jogo na grafia do contrato. Desconhecida = `misc`. */
export function skinCategoryOf(gameCategory: string | null | undefined): SkinCategory {
  const lowered = (gameCategory ?? '').trim().toLowerCase();

  return KNOWN_CATEGORIES.has(lowered) ? (lowered as SkinCategory) : 'misc';
}

// ============================================================
//  O CORPO
// ============================================================

/**
 * Uma skin como ela viaja.
 *
 * O `id` interno NÃO viaja: ele muda se a skin for recadastrada. A
 * chave para o site é `(shortname, workshopId)`.
 */
export interface SkinMirrorEntry {
  readonly shortname: string;
  /** TEXTO: é UInt64 e não cabe em número de JS. */
  readonly workshopId: string;
  readonly label: string;
  readonly description: string | null;
  readonly rarity: WorkshopRarity | null;
  readonly category: SkinCategory;
  readonly previewUrl: string | null;
  readonly openToAll: boolean;
  readonly enabled: boolean;
  /** Os ids NO SITE dos servidores em que a skin aparece. */
  readonly servers: readonly string[];
}

export interface SkinsMirrorPayload {
  readonly version: string;
  readonly skins: readonly SkinMirrorEntry[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * O snapshot e a `version` dele.
 *
 * A `version` é o sha256 do corpo canônico SEM ela. A ordem é nossa
 * e existe só por causa do hash: duas leituras do mesmo estado têm
 * de dar a mesma `version`, senão o catálogo inteiro atravessaria a
 * rede a cada volta.
 */
export function buildSkinsMirror(entries: readonly SkinMirrorEntry[]): SkinsMirrorPayload {
  const skins = [...entries]
    .map((entry) => ({ ...entry, servers: [...new Set(entry.servers)].sort(compareText) }))
    .sort(
      (left, right) =>
        compareText(left.shortname, right.shortname) || compareText(left.workshopId, right.workshopId),
    );
  const version = createHash('sha256').update(stableStringify({ skins })).digest('hex');

  return { version, skins };
}

// ============================================================
//  O ESPELHO
// ============================================================

export interface SkinsSiteMirrorOptions {
  /** Um por servidor pareado COM token, na chave do id LOCAL. */
  readonly clients: ReadonlyMap<string, SiteClient>;
  readonly skins: Pick<WorkshopSkinsRepository, 'list'>;
  readonly items: Pick<ItemsRepository, 'get'>;
  /**
   * O id NO SITE de um servidor local. `null` = ele não está
   * pareado, e sai do `servers` da skin.
   */
  readonly siteServerIdOf: (localServerId: string) => string | null;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly debounceMs?: number;
  readonly now?: () => number;
}

export class SkinsSiteMirror {
  readonly #options: SkinsSiteMirrorOptions;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #running = false;
  /** Uma volta pedida enquanto outra rodava: roda de novo no fim. */
  #again = false;
  /**
   * Os pareamentos que responderam 404, e até quando ficam quietos.
   *
   * O aviso de mudança não os acorda: só o relógio, na volta dele.
   */
  readonly #routeMissingUntil = new Map<string, number>();
  /** Quem já ganhou o `debug` do 404 neste boot. */
  readonly #routeMissingLogged = new Set<string>();

  constructor(options: SkinsSiteMirrorOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.push();
    }, this.#intervalMs());
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

  /**
   * O catálogo mudou. Junta as edições dos próximos segundos num push
   * só.
   */
  notifyChanged(): void {
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce);
    }

    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.push();
    }, this.#options.debounceMs ?? SKINS_MIRROR_DEBOUNCE_MS);
    this.#debounce.unref();
  }

  /** O snapshot de agora. Exposto para o teste e o diagnóstico. */
  snapshot(): SkinsMirrorPayload {
    return buildSkinsMirror(this.#options.skins.list().map((skin) => this.#entryOf(skin)));
  }

  /** Uma volta por todos os pareamentos. Nunca lança. */
  async push(): Promise<void> {
    if (this.#running) {
      this.#again = true;

      return;
    }

    this.#running = true;

    try {
      do {
        this.#again = false;
        await this.#round();
      } while (this.#again);
    } catch (error) {
      this.#options.logger.warn({ err: toError(error) }, 'skins mirror push failed');
    } finally {
      this.#running = false;
    }
  }

  async #round(): Promise<void> {
    const payload = this.snapshot();

    if (payload.skins.length > SKINS_MIRROR_MAX) {
      this.#options.logger.warn(
        { skins: payload.skins.length, max: SKINS_MIRROR_MAX },
        'the skins catalog is larger than the site accepts; the mirror was not sent',
      );

      return;
    }

    const bytes = Buffer.byteLength(JSON.stringify(payload));

    if (bytes > SKINS_MIRROR_MAX_BYTES) {
      this.#options.logger.warn(
        { bytes, max: SKINS_MIRROR_MAX_BYTES },
        'the skins mirror is larger than the site accepts; it was not sent',
      );

      return;
    }

    for (const [serverId, client] of this.#options.clients) {
      await this.#pushOne(serverId, client, payload);
    }
  }

  async #pushOne(serverId: string, client: SiteClient, payload: SkinsMirrorPayload): Promise<void> {
    const now = this.#now();
    const quietUntil = this.#routeMissingUntil.get(serverId);

    if (quietUntil !== undefined && now < quietUntil) {
      return;
    }

    // A pergunta barata. É nela que o 404 aparece primeiro.
    const remote = await client.skinsMirrorVersion();

    if (!remote.ok) {
      this.#failed(serverId, remote, now, 'could not read the skins mirror version');

      return;
    }

    this.#routeMissingUntil.delete(serverId);

    if (remote.body.version === payload.version) {
      return;
    }

    const result = await client.pushSkinsMirror(payload);

    if (!result.ok) {
      this.#failed(serverId, result, now, 'the site refused the skins mirror');

      return;
    }

    this.#options.logger.info(
      { serverId, version: payload.version, skins: payload.skins.length },
      'skins mirror accepted',
    );
  }

  #failed(
    serverId: string,
    result: { readonly status: number | null; readonly code: string | null; readonly reason: string },
    now: number,
    message: string,
  ): void {
    if (result.status === 404) {
      // A volta do relógio que vier depois deste instante tenta de
      // novo; o aviso de mudança não.
      this.#routeMissingUntil.set(serverId, now + this.#intervalMs() - 1);

      if (!this.#routeMissingLogged.has(serverId)) {
        this.#routeMissingLogged.add(serverId);
        this.#options.logger.debug(
          { serverId },
          'the site does not have the skins mirror route yet; retrying quietly on the regular clock',
        );
      }

      return;
    }

    this.#options.logger.warn(
      { serverId, status: result.status, code: result.code, reason: result.reason },
      message,
    );
  }

  #entryOf(skin: WorkshopSkin): SkinMirrorEntry {
    const servers: string[] = [];

    for (const localId of skin.servers) {
      const siteId = this.#options.siteServerIdOf(localId);

      if (siteId !== null && siteId !== '') {
        servers.push(siteId);
      }
    }

    return {
      shortname: skin.shortname,
      workshopId: skin.skinId,
      label: skin.label,
      description: skin.description,
      rarity: skin.rarity,
      category: skinCategoryOf(this.#options.items.get(skin.shortname)?.category),
      previewUrl: skin.previewUrl,
      openToAll: skin.openToAll,
      enabled: skin.enabled,
      servers,
    };
  }

  #intervalMs(): number {
    return this.#options.intervalMs ?? DEFAULT_SKINS_MIRROR_INTERVAL_MS;
  }
}
