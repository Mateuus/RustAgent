// ============================================================
//  site-mirror.ts  -  quem tem VIP no JOGO, contado ao site.
//
//  ####  POR QUE ELE EXISTE  ####
//
//  O site vende VIP e cria um `UserVipGrant`. Depois disso, quem é
//  dono do vencimento é ESTE agente: ele reaplica o grupo do Oxide
//  no boot, ESTENDE o prazo quando o jogador compra de novo, revoga
//  quando o relógio bate, e ADOTA quem alguém pôs no grupo à mão.
//
//  Nenhuma dessas quatro coisas passa pelo site. Sem este espelho, o
//  `UserVipGrant` de lá é uma promessa que ninguém confere — e a
//  divergência aparece no suporte, não no log.
//
//  ####  RETRATO INTEIRO, NUNCA DELTA  ####
//
//  Delta exige que os dois lados concordem sobre o que já chegou, e
//  a primeira mensagem perdida deixa a divergência PERMANENTE e
//  invisível. O retrato inteiro se conserta sozinho na rodada
//  seguinte. É a mesma escolha do catálogo (store/catalog-mirror.ts)
//  e pelo mesmo motivo.
//
//  Do outro lado isso significa SUBSTITUIR: quem sumiu do retrato
//  não é VIP mais.
//
//  ####  AQUI A `version` MUDA SOZINHA, E ISSO É O PONTO  ####
//
//  No catálogo, `inSync` em silêncio significa "ninguém mexeu na
//  loja". Aqui não: um VIP vence às 3 da manhã sem ninguém tocar em
//  nada, e o retrato muda porque ele SAIU. É a diferença entre
//  espelhar uma decisão e espelhar um estado com prazo.
//
//  Consequência prática: desligar o relógio não é "ficar com o
//  espelho de ontem", é ficar dizendo que gente sem VIP tem VIP. O
//  push por mudança (`notifyChanged`) é a otimização; o relógio é a
//  garantia.
//
//  ####  O RETRATO TAMBÉM DIZ QUAIS NÍVEIS EXISTEM  ####
//
//  Junto dos VIPs vai a lista de tiers declarados no jogo
//  (`OrigemZVip.json`, por servidor). Ela não é estado de ninguém —
//  é VOCABULÁRIO: sem ela o admin do site DIGITA o nível ao
//  cadastrar, e um `gold ` com espaço só falha cinco resgates
//  depois, em `needs_admin`.
//
//  E ela viaja DENTRO do corpo, portanto dentro do hash. É o que se
//  quer: mexer no `OrigemZVip.json` sozinho passa a invalidar o
//  retrato, e a lista nova chega na volta seguinte. Fora do hash,
//  um nível recém-criado só chegaria quando algum jogador ganhasse
//  VIP — tarde demais, porque é justamente o nível novo que o admin
//  quer cadastrar.
//
//  ####  A ROTA PODE NÃO EXISTIR AINDA  ####
//
//  Enquanto o Lote de VIP não subir do outro lado, isto toma 404 a
//  cada rodada, por servidor. O 404 recua (`MIRROR_404_BACKOFF_MS`)
//  em vez de insistir: a rota não vai nascer entre uma rodada e a
//  seguinte, e o log de quem opera não pode virar uma coluna só de
//  uma linha repetida. Mesmo freio do `site/status.ts`.
//
//  Ver Docs\24-PROMPT-VIP-DE-RUST-PARA-O-AGENTE-DO-SITE.md.
// ============================================================

import { createHash } from 'node:crypto';

import type { MetaRepository } from '../db/meta-repository.js';
import { ANY_SERVER, type VipOrigin, type VipsRepository } from '../db/vips-repository.js';
import type { Logger } from '../logger.js';
import type { SiteClient } from '../site/client.js';
import { stableStringify } from '../store/catalog-mirror.js';
import { toError } from '../util.js';

/**
 * O teto do corpo. Generoso de propósito: a ~90 bytes por linha, ele
 * comporta mais de vinte mil VIPs ativos.
 */
export const VIP_MIRROR_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_VIP_MIRROR_INTERVAL_MS = 60_000;
/** Três concessões seguidas viram UM push, com o último estado. */
export const VIP_MIRROR_DEBOUNCE_MS = 2_000;

/**
 * Quanto tempo um destino que respondeu 404 fica de fora.
 *
 * O 404 aqui tem um significado só, e ele não muda em um minuto: o
 * outro lado ainda não tem a rota. Ver o cabeçalho.
 */
export const MIRROR_404_BACKOFF_MS = 10 * 60_000;

/** De quanto em quanto tempo a MESMA linha de erro volta ao log. */
export const LOG_REPEAT_MS = 10 * 60_000;

/**
 * Quantos níveis cabem no retrato.
 *
 * É o mesmo teto que o SITE aplica ao normalizar o campo. Passar
 * dele não custaria só a lista: o 400 recusa o corpo INTEIRO, e o
 * site ficaria com o retrato de ontem — VIP vencido de pé — por
 * causa de um `OrigemZVip.json` com níveis demais.
 */
export const VIP_MIRROR_MAX_TIERS = 64;

// ============================================================
//  O CORPO
// ============================================================

/**
 * Uma linha do retrato.
 *
 * `expiresAt` sai em ISO-8601 porque é o vocabulário do site (o
 * `at` do status e o `generatedAt` do catálogo já são). Por dentro o
 * agente guarda epoch ms — a tradução acontece AQUI, na fronteira, e
 * em lugar nenhum mais.
 */
export interface VipMirrorEntry {
  readonly steamId: string;
  readonly tier: string;
  /** `null` = vitalício. */
  readonly expiresAt: string | null;
  /**
   * De onde veio, e é isto que o site não tem como saber sozinho.
   *
   * `loja` = comprado dentro do jogo com OZ. `painel` = alguém deu à
   * mão. `adotado` = já estava no grupo do Oxide quando o agente
   * chegou. Nenhum dos três nasce de uma venda do site, e um grant
   * de lá sem linha correspondente aqui é exatamente a divergência
   * que este campo deixa diagnosticar.
   */
  readonly origin: VipOrigin;
  /** Epoch ms de quando a concessão nasceu, em ISO. */
  readonly grantedAt: string;
}

export interface VipMirrorPayload {
  readonly version: string;
  readonly generatedAt: string;
  readonly vips: readonly VipMirrorEntry[];
  /**
   * Os níveis que ESTE agente conhece — minúsculos, sem repetição
   * e em ordem.
   *
   * Lista vazia é resposta legítima, e diferente de campo ausente:
   * ela diz "o `OrigemZVip.json` não declara nível nenhum aqui", e
   * é o que faz o cadastro do site mostrar o aviso em vez de abrir
   * um campo de texto livre.
   */
  readonly tiers: readonly string[];
}

/**
 * A lista como ela viaja: minúscula, sem espaço, sem repetição, em
 * ordem e dentro do teto.
 *
 * A ordem não é enfeite — o hash é sensível a ela, e dois
 * servidores declarando os mesmos níveis em ordens diferentes
 * produziriam duas `version` para o mesmo estado, empurrando o
 * retrato inteiro a cada rodada.
 */
export function normalizeTiers(tiers: readonly string[]): readonly string[] {
  const normalized = tiers
    .map((tier) => tier.trim().toLowerCase())
    .filter((tier) => tier !== '');

  return [...new Set(normalized)].sort().slice(0, VIP_MIRROR_MAX_TIERS);
}

/** sha256 do corpo canônico SEM `version` e SEM `generatedAt`. */
export function versionOf(payload: Omit<VipMirrorPayload, 'version' | 'generatedAt'>): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Os VIPs válidos AGORA.
 *
 * ####  A ORDEM É NOSSA, E NO CATÁLOGO ELA NÃO ERA  ####
 *
 * Lá a ordem vinha do banco e não podia ser mexida: `position` é
 * conteúdo, e reordenar esconderia uma mudança de vitrine. Aqui não
 * há vitrine — o retrato é um CONJUNTO, e ordem nenhuma significa
 * coisa alguma. Mas o hash é sensível a ela: sem ordenar, duas
 * leituras do mesmo estado poderiam produzir duas `version`, e o
 * espelho seria empurrado inteiro a cada rodada, para sempre.
 */
export function buildVipMirror(
  repository: VipsRepository,
  serverId: string,
  now: number,
  tiers: readonly string[] = [],
): { readonly payload: VipMirrorPayload; readonly version: string } {
  const vips = repository
    // O retrato é DAQUELE servidor: o site guarda uma linha por
    // `server_id` e a trata como substitutiva ("quem sumiu não é VIP
    // mais"). Mandar a tabela inteira para todos faria o site ver o
    // VIP do `pvp1` como se ele valesse no `pve` — o mesmo vazamento
    // que a migração 102 fechou aqui dentro, só que do lado de lá.
    .activeIn(serverId, now)
    .map((vip) => ({
      steamId: vip.steamId,
      tier: vip.tier,
      expiresAt: vip.expiresAt === null ? null : new Date(vip.expiresAt).toISOString(),
      origin: vip.origin,
      grantedAt: new Date(vip.createdAt).toISOString(),
    }))
    .sort((a, b) =>
      a.steamId === b.steamId
        ? a.tier < b.tier
          ? -1
          : a.tier > b.tier
            ? 1
            : 0
        : a.steamId < b.steamId
          ? -1
          : 1,
    );

  const body = { vips, tiers: normalizeTiers(tiers) };
  const version = versionOf(body);

  return { payload: { ...body, version, generatedAt: new Date(now).toISOString() }, version };
}

/**
 * O estado do espelho, para a tela de diagnóstico.
 *
 * ####  NÃO HÁ MAIS UM HASH SÓ  ####
 *
 * Desde que o VIP tem servidor (migração 102), cada destino recebe um
 * retrato DIFERENTE — o dele mais a rede. Um `version` global voltou
 * a ser o que ele nunca deveria ter sido: um número que casa com um
 * servidor e mente sobre os outros. Por isso o hash esperado mora em
 * `mirrored[]`, ao lado do que aquele destino confirmou.
 */
export interface VipMirrorStatus {
  /** Quantas concessões valem agora, somando TODOS os escopos. */
  readonly count: number;
  /** Todos os destinos já confirmaram o retrato DELES? */
  readonly inSync: boolean;
  readonly mirrored: readonly {
    readonly serverId: string;
    /** O hash do retrato daquele servidor AGORA. */
    readonly expected: string;
    /** A que aquele destino confirmou. `null` = nunca recebeu. */
    readonly version: string | null;
    readonly at: number | null;
    /** Quantos VIPs valem ali — os do servidor mais os de rede. */
    readonly count: number;
  }[];
  readonly lastPushAt: number | null;
  readonly lastPushError: string | null;
  /**
   * O outro lado ainda não tem a rota.
   *
   * Separado de `lastPushError` porque as duas perguntas que alguém
   * faz olhando esta tela são diferentes: "está quebrado?" e "já dá
   * para usar?". Um 404 responde `false` à segunda e NÃO é defeito
   * deste lado.
   */
  readonly routeMissing: boolean;
}

export interface VipSiteMirrorOptions {
  /** Um por servidor pareado, na chave do id LOCAL. */
  readonly clients: ReadonlyMap<string, SiteClient>;
  readonly repository: VipsRepository;
  readonly meta: MetaRepository;
  /**
   * Quais níveis de VIP existem no jogo, para o cadastro do site
   * ESCOLHER em vez de digitar.
   *
   * É uma função, e async, porque a lista mora em disco — um
   * `OrigemZVip.json` por servidor. Ausente = o retrato viaja com
   * `tiers: []`, que é o que ele dizia antes de este campo
   * existir.
   */
  readonly tiers?: (() => Promise<readonly string[]>) | undefined;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class VipSiteMirror {
  readonly #options: VipSiteMirrorOptions;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #running = false;
  #dirty = false;
  #lastPushAt: number | null = null;
  #lastPushError: string | null = null;
  #lastLogged: { message: string; at: number } | null = null;
  /**
   * A última lista de níveis LIDA. Ela é cache de propósito: o
   * getter `status` monta o retrato de forma síncrona, e ler disco
   * ali travaria a tela.
   */
  #tiers: readonly string[] = [];
  /** Até quando cada destino fica de fora por 404. Epoch ms. */
  readonly #mutedUntil = new Map<string, number>();

  constructor(options: VipSiteMirrorOptions) {
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
      this.#options.intervalMs ?? DEFAULT_VIP_MIRROR_INTERVAL_MS,
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

  get status(): VipMirrorStatus {
    const now = this.#now();

    const mirrored = [...this.#options.clients.keys()].map((serverId) => {
      const { payload, version } = buildVipMirror(
        this.#options.repository,
        serverId,
        now,
        this.#tiers,
      );

      return {
        serverId,
        expected: version,
        version: this.#options.meta.read(versionKey(serverId)),
        at: toEpoch(this.#options.meta.read(mirroredAtKey(serverId))),
        count: payload.vips.length,
      };
    });

    return {
      count: this.#options.repository.activeIn(ANY_SERVER, now).length,
      inSync: mirrored.every((entry) => entry.version === entry.expected),
      mirrored,
      lastPushAt: this.#lastPushAt,
      lastPushError: this.#lastPushError,
      routeMissing: this.#mutedUntil.size > 0,
    };
  }

  /**
   * Concedeu, revogou ou venceu.
   *
   * Chamada pela `VipList` SEM `await` e sem try/catch de quem
   * chama: ela não lança. Uma falha de push não pode desfazer uma
   * concessão que já foi gravada.
   */
  notifyChanged(): void {
    if (this.#debounce !== null) {
      return;
    }

    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.push();
    }, VIP_MIRROR_DEBOUNCE_MS);
    this.#debounce.unref();
  }

  /** Uma rodada. Nunca lança. */
  async push(): Promise<void> {
    if (this.#running) {
      this.#dirty = true;

      return;
    }

    this.#running = true;

    try {
      // UMA leitura de disco por rodada, antes de montar o retrato:
      // o laço abaixo pode dar mais de uma volta, e os níveis não
      // mudam entre elas.
      await this.#refreshTiers();

      do {
        this.#dirty = false;
        await this.#pushOnce();
      } while (this.#dirty);
    } catch (error) {
      this.#lastPushError = toError(error).message;
      this.#options.logger.warn({ err: toError(error) }, 'vip mirror push failed');
    } finally {
      this.#running = false;
    }
  }

  /**
   * Relê os níveis declarados no jogo. Nunca lança.
   *
   * ####  FALHA DE LEITURA MANTÉM A ÚLTIMA LISTA  ####
   *
   * Mandar `[]` porque o disco piscou faria o cadastro do site
   * perder os níveis e cair no campo de texto livre — que é
   * exatamente o que este campo existe para evitar. Uma lista
   * velha por um minuto não custa nada; uma lista vazia por
   * engano custa um resgate errado.
   */
  async #refreshTiers(): Promise<void> {
    const read = this.#options.tiers;

    if (read === undefined) {
      return;
    }

    try {
      this.#tiers = normalizeTiers(await read());
    } catch (error) {
      this.#options.logger.warn(
        { err: toError(error) },
        'could not read the vip tiers for the mirror; keeping the last known list',
      );
    }
  }

  async #pushOnce(): Promise<void> {
    const now = this.#now();

    for (const [serverId, client] of this.#options.clients) {
      const mutedUntil = this.#mutedUntil.get(serverId);

      if (mutedUntil !== undefined && now < mutedUntil) {
        continue;
      }

      // O retrato é montado DENTRO do laço: cada destino recebe o
      // dele. Montar um só, fora, era o que contava ao site que o VIP
      // do `pvp1` valia no `pve`.
      const { payload, version } = buildVipMirror(
        this.#options.repository,
        serverId,
        now,
        this.#tiers,
      );
      const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

      if (bytes > VIP_MIRROR_MAX_BYTES) {
        // Truncar aqui é pior que no catálogo: o retrato SUBSTITUI, e
        // meio retrato faria o site revogar o VIP de quem ficou de
        // fora do corte. Um espelho velho é recuperável; um VIP pago
        // apagado por corte de página, não.
        //
        // E o `continue` é por DESTINO: o retrato grande demais de um
        // servidor não pode calar os outros, que provavelmente cabem.
        this.#lastPushError = 'VIP_MIRROR_TOO_LARGE';
        this.#options.logger.error(
          { serverId, bytes, max: VIP_MIRROR_MAX_BYTES, vips: payload.vips.length },
          'vip mirror is too large to send',
        );

        continue;
      }

      if (this.#options.meta.read(versionKey(serverId)) === version) {
        continue;
      }

      // A pergunta barata antes do corpo inteiro. Ela também é onde
      // o 404 aparece primeiro, e onde ele custa menos.
      const remote = await client.vipMirrorVersion();

      if (remote.ok && remote.body.version === version) {
        this.#remember(serverId, version);
        continue;
      }

      if (!remote.ok && remote.status === 404) {
        this.#mute(serverId, now);
        continue;
      }

      const result = await client.pushVipMirror(payload);

      if (!result.ok) {
        if (result.status === 404) {
          this.#mute(serverId, now);
          continue;
        }

        this.#lastPushError = result.code ?? result.reason;
        this.#log(
          `the site refused the vip mirror (${String(result.status)} ${result.code ?? result.reason})`,
          { serverId, status: result.status, code: result.code },
          now,
        );
        continue;
      }

      this.#mutedUntil.delete(serverId);
      this.#remember(serverId, version);
      this.#lastPushAt = now;
      this.#lastPushError = null;
      this.#lastLogged = null;
      this.#options.logger.info(
        { serverId, version, vips: payload.vips.length, tiers: payload.tiers.length },
        'vip mirror accepted',
      );
    }
  }

  /** O outro lado não tem a rota: recua e diz por quê, uma vez. */
  #mute(serverId: string, now: number): void {
    this.#mutedUntil.set(serverId, now + MIRROR_404_BACKOFF_MS);
    this.#lastPushError = 'VIP_MIRROR_ROUTE_MISSING';
    this.#log(
      'the site does not have the vip mirror route yet; backing off',
      { serverId },
      now,
    );
  }

  #remember(serverId: string, version: string): void {
    this.#options.meta.writeMany(
      { [versionKey(serverId)]: version, [mirroredAtKey(serverId)]: String(this.#now()) },
      this.#now(),
    );
  }

  /** A MESMA linha não volta ao log antes de `LOG_REPEAT_MS`. */
  #log(message: string, fields: Record<string, unknown>, now: number): void {
    const last = this.#lastLogged;

    if (last !== null && last.message === message && now - last.at < LOG_REPEAT_MS) {
      return;
    }

    this.#lastLogged = { message, at: now };
    this.#options.logger.warn(fields, message);
  }
}

function versionKey(serverId: string): string {
  return `site.vip.mirrored_version.${serverId}`;
}

function mirroredAtKey(serverId: string): string {
  return `site.vip.mirrored_at.${serverId}`;
}

/** O carimbo de volta a número. Ilegível vira `null`, nunca `NaN`. */
function toEpoch(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
}
