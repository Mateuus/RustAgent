// ============================================================
//  items-mirror.ts  -  o catálogo de ITENS do jogo, contado ao
//  site — e as imagens junto.
//
//  ####  POR QUE ESTE É DIFERENTE DOS OUTROS DOIS ESPELHOS  ####
//
//  O do catálogo da loja e o do VIP contam DECISÕES nossas. Este
//  conta o que a Facepunch pôs no jogo: 1259 itens que ninguém
//  daqui escolheu. O site precisa deles para o admin cadastrar
//  produto escolhendo numa lista em vez de digitar `rifle.ak` na
//  mão — e um shortname digitado errado só falha na entrega, dias
//  depois, com o jogador pagando.
//
//  ####  E É O ÚNICO QUE CARREGA IMAGEM  ####
//
//  Os ícones NÃO existem no servidor dedicado: o servidor tem os
//  `.json` dos itens e nenhum `.png`. Eles só vêm na instalação do
//  CLIENTE do Rust, e por isso o painel carrega um pacote gerado
//  offline (`panel/scripts/build-item-icons.mjs`) e versionado
//  junto. O site não tem de onde buscá-los sozinho — não há CDN
//  oficial —, então este agente é a única ponta que pode
//  entregá-los.
//
//  ------------------------------------------------------------
//  ####  A `version` NÃO COBRE AS IMAGENS  ####
//
//  Ela é o hash do catálogo. Um bootstrap de imagens que morra na
//  requisição 13 de 26 deixa a version JÁ gravada do outro lado: a
//  rodada seguinte veria as duas iguais, não mandaria nada, e as
//  650 imagens restantes nunca seriam pedidas — catálogo meio
//  ilustrado para sempre, sem erro em lugar nenhum.
//
//  Por isso a condição de "nada a fazer" tem DUAS partes, e é E, e
//  não OU:
//
//      version bate  E  missingImageCount === 0
//
//  Ver Docs\29 §3.2.
//
//  ####  QUEM DIZ O QUE FALTA É O SITE  ####
//
//  O agente não adivinha: cada push devolve `missingImages` (até
//  200) e o agente manda só essas, em lotes de 50. Reenviar as
//  1259 a cada rodada seriam 2 MB por hora para não mudar nada.
//
//  ####  O SHORTNAME DO RUST TEM ESPAÇO, E ISSO CUSTOU ITEM  ####
//
//  `mini fridge`, `legacy bow`, `lumberjack hoodie` e `military
//  flamethrower` são shortnames DE VERDADE, com espaço — MEDIDOS
//  no `data/rustagent.db` deste agente. A régua de admissão do
//  site aceita espaço no meio; a de virar arquivo recusa espaço
//  nas PONTAS (no Windows ele é apagado na criação, e gravaríamos
//  com um nome procurando por outro para sempre).
//
//  Um shortname fora da régua reprova o push INTEIRO com 400 — por
//  isso a peneira acontece AQUI, antes de sair.
// ============================================================

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ItemRecord, ItemsRepository } from '../db/items-repository.js';
import type { MetaRepository } from '../db/meta-repository.js';
import type { Logger } from '../logger.js';
import type { ItemImageUpload, SiteClient } from '../site/client.js';
import { stableStringify } from '../store/catalog-mirror.js';
import { toError } from '../util.js';

/** De hora em hora. O catálogo só muda quando o jogo atualiza. */
export const DEFAULT_ITEMS_MIRROR_INTERVAL_MS = 60 * 60_000;

/** Quantas imagens cabem num lote. É o teto do site. */
export const IMAGE_BATCH_SIZE = 50;

/**
 * Quantos itens cabem no espelho.
 *
 * É o teto do site (1..3000), e não uma paginação nossa: o corpo é
 * SNAPSHOT, e mandar uma página faria o outro lado marcar como
 * removido tudo o que ficou de fora do corte.
 */
export const ITEMS_MIRROR_MAX = 3000;

/**
 * Quantas requisições uma rodada gasta, no máximo.
 *
 * O limitador do site é 60/min por servidor, e o bootstrap inteiro
 * (1 push + 26 lotes + os pushes que renovam a lista de 200) cabe
 * em ~33. O teto existe para a primeira rodada não estourar a cota
 * e para uma resposta teimosa não virar laço.
 */
export const MAX_REQUESTS_PER_ROUND = 40;

/** Quanto tempo um destino que respondeu 404 fica de fora. */
export const ITEMS_MIRROR_404_BACKOFF_MS = 10 * 60_000;

/**
 * A régua de ADMISSÃO no catálogo do site.
 *
 * Minúscula, dígito, ponto, hífen, sublinhado e espaço NO MEIO.
 * Ela é do site (Docs\29 §3.1) e está copiada aqui de propósito:
 * um shortname fora dela reprova o push inteiro, e a peneira tem
 * de acontecer antes de sair.
 */
export const SHORTNAME_ADMIT = /^[a-z0-9][a-z0-9._ -]{0,95}$/;

/**
 * A régua para VIRAR ARQUIVO: a de cima, sem espaço nas pontas.
 *
 * O site recusa esses com `INVALID_SHORTNAME` — e nunca os lista
 * como faltando, senão o laço não fecharia.
 */
export function canBeFile(shortname: string): boolean {
  return SHORTNAME_ADMIT.test(shortname) && shortname.trim() === shortname;
}

// ============================================================
//  O CORPO
// ============================================================

export interface ItemMirrorEntry {
  readonly shortname: string;
  readonly displayName: string;
  readonly itemId: number;
  readonly category: string;
  readonly maxStack: number;
  readonly hasCondition: boolean;
  /** O jogo não listou este item na última varredura. */
  readonly removed: boolean;
  /** sha256 do WebP. `null` = este agente não tem ícone dele. */
  readonly imageSha: string | null;
}

export interface ItemsMirrorPayload {
  readonly version: string;
  readonly generatedAt: string;
  /** A build do Rust que gerou o catálogo. `null` = nunca varrido. */
  readonly protocol: string | null;
  readonly items: readonly ItemMirrorEntry[];
}

/** sha256 do corpo canônico SEM `version` e SEM `generatedAt`. */
export function versionOf(payload: Omit<ItemsMirrorPayload, 'version' | 'generatedAt'>): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * O catálogo como ele viaja.
 *
 * ####  A ORDEM É NOSSA, E ELA IMPORTA PARA O HASH  ####
 *
 * O retrato é um CONJUNTO — o site guarda por `class_name`, e
 * ordem nenhuma significa coisa alguma lá. Mas o hash é sensível a
 * ela: sem ordenar, duas leituras do mesmo estado produziriam duas
 * `version`, e o catálogo inteiro atravessaria a rede a cada
 * rodada, para sempre.
 */
export function buildItemsMirror(
  items: readonly ItemMirrorEntry[],
  protocol: string | null,
  now: number,
): { readonly payload: ItemsMirrorPayload; readonly version: string } {
  const sorted = [...items].sort((left, right) =>
    left.shortname < right.shortname ? -1 : left.shortname > right.shortname ? 1 : 0,
  );

  const body = { protocol, items: sorted };
  const version = versionOf(body);

  return { payload: { ...body, version, generatedAt: new Date(now).toISOString() }, version };
}

// ============================================================
//  O ESPELHO
// ============================================================

export interface ItemsMirrorStatus {
  readonly version: string;
  readonly count: number;
  /** Quantos itens têm ícone para mandar. */
  readonly withImage: number;
  readonly mirrored: readonly {
    readonly serverId: string;
    readonly version: string | null;
    readonly at: number | null;
  }[];
  readonly inSync: boolean;
  readonly lastPushAt: number | null;
  readonly lastPushError: string | null;
  /** O outro lado ainda não tem a rota. NÃO é defeito daqui. */
  readonly routeMissing: boolean;
}

export interface ItemsSiteMirrorOptions {
  /** Um por servidor pareado, na chave do id LOCAL. */
  readonly clients: ReadonlyMap<string, SiteClient>;
  readonly repository: ItemsRepository;
  readonly meta: MetaRepository;
  /**
   * Onde mora o pacote de ícones.
   *
   * São dois caminhos porque o painel tem dois estados: `panel/out`
   * é o build que o agente serve em produção, e `panel/public` é a
   * fonte, que existe na máquina de quem desenvolve. O primeiro que
   * responder vale.
   */
  readonly iconDirs: readonly string[];
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

/** Um ícone lido do disco, com o hash e o tamanho. */
interface IconFile {
  readonly sha256: string;
  readonly base64: string;
  readonly bytes: number;
  /** Para o cache não reler o arquivo inteiro a cada rodada. */
  readonly mtimeMs: number;
}

export class ItemsSiteMirror {
  readonly #options: ItemsSiteMirrorOptions;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastPushAt: number | null = null;
  #lastPushError: string | null = null;
  /** Até quando cada destino fica de fora por 404. Epoch ms. */
  readonly #mutedUntil = new Map<string, number>();
  /** O ícone lido, na chave do shortname. Ver `#iconOf`. */
  readonly #icons = new Map<string, IconFile | null>();
  /**
   * Os shortnames que o site recusou PARA SEMPRE.
   *
   * `INVALID_SHORTNAME` é permanente (Docs\29 §3.3): o site nunca
   * os lista como faltando, e reenviá-los seria bater numa porta
   * que já respondeu que não abre.
   */
  readonly #refused = new Set<string>();

  constructor(options: ItemsSiteMirrorOptions) {
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
      this.#options.intervalMs ?? DEFAULT_ITEMS_MIRROR_INTERVAL_MS,
    );
    this.#timer.unref();

    void this.push();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  get status(): ItemsMirrorStatus {
    const entries = this.#entries();
    const { version } = buildItemsMirror(entries, this.#protocol(), this.#now());

    const mirrored = [...this.#options.clients.keys()].map((serverId) => ({
      serverId,
      version: this.#options.meta.read(versionKey(serverId)),
      at: toEpoch(this.#options.meta.read(mirroredAtKey(serverId))),
    }));

    return {
      version,
      count: entries.length,
      withImage: entries.filter((entry) => entry.imageSha !== null).length,
      mirrored,
      inSync: mirrored.every((entry) => entry.version === version),
      lastPushAt: this.#lastPushAt,
      lastPushError: this.#lastPushError,
      routeMissing: this.#mutedUntil.size > 0,
    };
  }

  /** Uma rodada. Nunca lança. */
  async push(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      for (const [serverId, client] of this.#options.clients) {
        await this.#pushOne(serverId, client);
      }
    } catch (error) {
      this.#lastPushError = toError(error).message;
      this.#options.logger.warn({ err: toError(error) }, 'items mirror push failed');
    } finally {
      this.#running = false;
    }
  }

  async #pushOne(serverId: string, client: SiteClient): Promise<void> {
    const now = this.#now();
    const mutedUntil = this.#mutedUntil.get(serverId);

    if (mutedUntil !== undefined && now < mutedUntil) {
      return;
    }

    await this.#loadIcons();

    const entries = this.#entries();

    if (entries.length === 0) {
      // Catálogo vazio é estado NORMAL: instalação nova, nenhum
      // servidor no ar ainda. Mandar `items: []` faria o site
      // marcar os 1259 como removidos.
      return;
    }

    const { payload, version } = buildItemsMirror(entries, this.#protocol(), now);

    // A pergunta barata. Ela também é onde o 404 aparece primeiro.
    const remote = await client.itemsMirrorVersion();

    if (!remote.ok) {
      if (remote.status === 404) {
        this.#mute(serverId, now);

        return;
      }

      this.#lastPushError = remote.code ?? remote.reason;

      return;
    }

    this.#mutedUntil.delete(serverId);

    const missingRemote = remote.body.missingImageCount ?? 0;

    // ####  E, NÃO OU  ####
    //
    // Ver o cabeçalho: a version cobre o catálogo, e não os
    // ícones.
    if (remote.body.version === version && missingRemote === 0) {
      this.#remember(serverId, version);

      return;
    }

    let requests = 1;

    // O laço termina de três jeitos: o site diz que não falta mais
    // nada, o teto de requisições da rodada, ou uma volta que não
    // conseguiu mandar imagem nenhuma (só recusas permanentes).
    while (requests < MAX_REQUESTS_PER_ROUND) {
      const result = await client.pushItemsMirror(payload);

      requests += 1;

      if (!result.ok) {
        if (result.status === 404) {
          this.#mute(serverId, now);

          return;
        }

        this.#lastPushError = result.code ?? result.reason;
        this.#options.logger.warn(
          { serverId, status: result.status, code: result.code, reason: result.reason },
          'the site refused the items mirror',
        );

        return;
      }

      this.#remember(serverId, version);
      this.#lastPushAt = this.#now();
      this.#lastPushError = null;

      this.#options.logger.info(
        {
          serverId,
          version,
          items: payload.items.length,
          removed: result.body.removed ?? 0,
          missingImages: result.body.missingImageCount ?? 0,
        },
        'items mirror accepted',
      );

      const wanted = (result.body.missingImages ?? []).filter(
        (shortname) => !this.#refused.has(shortname),
      );

      if (wanted.length === 0) {
        return;
      }

      const sent = await this.#sendImages(serverId, client, wanted, MAX_REQUESTS_PER_ROUND - requests);

      requests += sent.requests;

      // Nada saiu: ou o teto acabou, ou o que sobrou é recusa
      // permanente. Insistir aqui seria o laço que o Docs\29 §3.3
      // existe para evitar.
      if (sent.stored === 0) {
        return;
      }
    }
  }

  /**
   * Manda os ícones em lotes. Devolve quanto gastou e quanto colou.
   *
   * O que o disco não tem simplesmente não vai: item sem ícone é
   * normal (`researchpaper`, as prateleiras da base — o jogo nunca
   * os desenha no inventário), e o site continuará listando como
   * faltando sem que isso vire erro.
   */
  async #sendImages(
    serverId: string,
    client: SiteClient,
    wanted: readonly string[],
    budget: number,
  ): Promise<{ readonly stored: number; readonly requests: number }> {
    let stored = 0;
    let requests = 0;

    for (let at = 0; at < wanted.length && requests < budget; at += IMAGE_BATCH_SIZE) {
      const batch: ItemImageUpload[] = [];

      for (const shortname of wanted.slice(at, at + IMAGE_BATCH_SIZE)) {
        const icon = this.#icons.get(shortname);

        if (icon === undefined || icon === null || !canBeFile(shortname)) {
          continue;
        }

        batch.push({
          shortname,
          sha256: icon.sha256,
          contentType: 'image/webp',
          data: icon.base64,
        });
      }

      if (batch.length === 0) {
        continue;
      }

      const result = await client.pushItemImages(batch);

      requests += 1;

      if (!result.ok) {
        this.#lastPushError = result.code ?? result.reason;
        this.#options.logger.warn(
          { serverId, status: result.status, code: result.code, images: batch.length },
          'the site refused a batch of item images',
        );

        return { stored, requests };
      }

      stored += result.body.stored ?? 0;

      for (const rejected of result.body.rejected ?? []) {
        if (rejected.shortname === undefined) {
          continue;
        }

        // Só esta é permanente. As outras cinco melhoram sozinhas
        // ou com o arquivo certo, e voltam na rodada seguinte.
        if (rejected.reason === 'INVALID_SHORTNAME') {
          this.#refused.add(rejected.shortname);
        }

        this.#options.logger.warn(
          { serverId, shortname: rejected.shortname, reason: rejected.reason },
          'the site rejected an item image',
        );
      }
    }

    return { stored, requests };
  }

  /** As linhas do catálogo que podem viajar. */
  #entries(): readonly ItemMirrorEntry[] {
    const entries: ItemMirrorEntry[] = [];
    const seen = new Set<string>();

    for (const item of this.#allItems()) {
      // Fora da régua, o push INTEIRO seria reprovado com 400 — e
      // duplicata também (Docs\29 §3.4). A peneira é aqui.
      if (!SHORTNAME_ADMIT.test(item.shortname) || seen.has(item.shortname)) {
        continue;
      }

      seen.add(item.shortname);

      entries.push({
        shortname: item.shortname,
        displayName: item.displayName,
        itemId: item.itemId,
        category: item.category,
        maxStack: item.maxStack,
        hasCondition: item.hasCondition,
        removed: item.removed,
        imageSha: this.#icons.get(item.shortname)?.sha256 ?? null,
      });
    }

    return entries;
  }

  #protocol(): string | null {
    return this.#options.repository.state().protocol;
  }

  /**
   * O catálogo inteiro, numa consulta.
   *
   * O `list` é paginado porque a TELA é paginada; aqui o corpo é
   * SNAPSHOT, e uma página faria o site marcar como removido tudo
   * o que ficasse de fora do corte.
   */
  #allItems(): readonly ItemRecord[] {
    return this.#options.repository.list({ limit: ITEMS_MIRROR_MAX, offset: 0 }).items;
  }

  /**
   * Lê o pacote de ícones, uma vez por rodada.
   *
   * O cache é por `mtime`: o pacote muda quando alguém roda o
   * script de build, o que acontece quando a Facepunch mexe nos
   * ícones — não a cada hora.
   */
  async #loadIcons(): Promise<void> {
    for (const item of this.#allItems()) {
      if (!canBeFile(item.shortname)) {
        continue;
      }

      const cached = this.#icons.get(item.shortname);
      const found = await this.#readIcon(item.shortname, cached ?? null);

      this.#icons.set(item.shortname, found);
    }
  }

  /** `null` = não há ícone deste item, e isso é normal. */
  async #readIcon(shortname: string, cached: IconFile | null): Promise<IconFile | null> {
    for (const dir of this.#options.iconDirs) {
      const path = join(dir, `${shortname}.webp`);

      try {
        const info = await stat(path);

        if (cached !== null && cached.mtimeMs === info.mtimeMs) {
          return cached;
        }

        const raw = await readFile(path);

        return {
          sha256: createHash('sha256').update(raw).digest('hex'),
          base64: raw.toString('base64'),
          bytes: raw.byteLength,
          mtimeMs: info.mtimeMs,
        };
      } catch {
        // Próximo diretório. Ícone faltando é estado esperado.
        continue;
      }
    }

    return null;
  }

  /** O outro lado não tem a rota: recua e diz por quê, uma vez. */
  #mute(serverId: string, now: number): void {
    if (!this.#mutedUntil.has(serverId)) {
      this.#options.logger.warn(
        { serverId },
        'the site does not have the item mirror route yet; backing off',
      );
    }

    this.#mutedUntil.set(serverId, now + ITEMS_MIRROR_404_BACKOFF_MS);
    this.#lastPushError = 'ITEMS_MIRROR_ROUTE_MISSING';
  }

  #remember(serverId: string, version: string): void {
    this.#options.meta.writeMany(
      { [versionKey(serverId)]: version, [mirroredAtKey(serverId)]: String(this.#now()) },
      this.#now(),
    );
  }
}

function versionKey(serverId: string): string {
  return `site.items.mirrored_version.${serverId}`;
}

function mirroredAtKey(serverId: string): string {
  return `site.items.mirrored_at.${serverId}`;
}

/** O carimbo de volta a número. Ilegível vira `null`, nunca `NaN`. */
function toEpoch(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
}
