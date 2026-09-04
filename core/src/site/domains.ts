// ============================================================
//  domains.ts  -  a loja, os kits e os VIPs, na opinião do site.
//
//  ####  O IRMÃO DO `config.ts`, E DE PROPÓSITO  ####
//
//  Mesmo desenho: uma `version` inteira que só cresce, `ETag`
//  opcional, ACK guardado em disco até o site confirmar, e NENHUMA
//  reaplicação em laço. O que muda é o que viaja dentro do
//  `desired` — e quem conhece essa forma é o aplicador do assunto,
//  nunca este arquivo.
//
//  ####  ESTES ASSUNTOS SÃO DO AGENTE, NÃO DO SERVIDOR  ####
//
//  A loja é UMA: as tabelas dela não têm `server_id`, e todos os
//  servidores mostram a mesma vitrine. O mesmo vale para os kits da
//  rede e para o VIP, que é da conta do jogador. Por isso este laço
//  roda UMA VEZ por agente — pelo cliente de UM servidor pareado —,
//  e não uma vez por pareamento.
//
//  Se ele rodasse por servidor, dois `Server` do site poderiam
//  mandar catálogos diferentes para o MESMO banco, e o último a
//  chegar ganharia. O sintoma seria uma loja que muda sozinha a cada
//  trinta segundos.
//
//  ####  SNAPSHOT SUBSTITUI, NUNCA MESCLA  ####
//
//  É a mesma regra do espelho que sai daqui (`store/catalog-mirror
//  .ts`): produto que sumiu do `desired` SAIU DA LOJA, não foi
//  esquecido. Um merge deixaria produto apagado à venda para sempre.
//
//  A consequência é dita em voz alta no `Docs/23`: enquanto o site
//  opinar sobre um assunto, ele é o dono daquele assunto. Editar
//  pelo painel local continua funcionando, e continua valendo — até
//  a próxima versão do site, que reescreve tudo.
//
//  ####  NADA AQUI LANÇA  ####
//
//  Roda num relógio. Um `throw` para a convergência em silêncio.
//
//  Ver Docs\23-CONFIG-PELO-SITE.md.
// ============================================================

import type { MetaRepository } from '../db/meta-repository.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { ConfigFieldError, SiteClient } from './client.js';

/**
 * A cadência.
 *
 * Um minuto, e não os 30 s da config de servidor: catálogo muda
 * muito menos que hostname, e a volta que não mudou nada custa um
 * 304 sem corpo de qualquer jeito.
 */
export const DEFAULT_DOMAIN_INTERVAL_MS = 60_000;
export const MIN_DOMAIN_INTERVAL_MS = 15_000;
export const MAX_DOMAIN_INTERVAL_MS = 600_000;

/** De quanto em quanto tempo a MESMA linha de erro volta ao log. */
export const LOG_REPEAT_MS = 10 * 60_000;

/** As chaves na tabela `meta`. Uma família por assunto. */
export const DOMAIN_VERSION_KEY = 'site.domain.version';
export const DOMAIN_ETAG_KEY = 'site.domain.etag';
export const DOMAIN_ACK_KEY = 'site.domain.ack';

/** Os assuntos que este agente sabe receber. */
export const SITE_DOMAINS = ['store', 'kits', 'vips'] as const;

export type SiteDomain = (typeof SITE_DOMAINS)[number];

/**
 * Os códigos de `errors[].code` que este canal produz.
 *
 * Os mesmos da config de servidor, mais os que só existem quando o
 * que viaja é uma LISTA: uma oferta que aponta para uma categoria
 * que não existe é um caso que `hostname` não tem.
 */
export const DOMAIN_ERROR_CODES = {
  /** O corpo não tem a forma que este assunto espera. */
  invalidShape: 'INVALID_SHAPE',
  /** A linha existe e não passa na régua do painel local. */
  invalidValue: 'INVALID_VALUE',
  /** A linha aponta para outra que não veio no snapshot. */
  unknownReference: 'UNKNOWN_REFERENCE',
  /** A gravação daquela linha falhou. */
  writeFailed: 'WRITE_FAILED',
} as const;

/** O que a régua separou, antes de qualquer escrita. */
export interface DomainPlan<W> {
  /** `null` = não há o que aplicar. */
  readonly work: W | null;
  readonly errors: readonly ConfigFieldError[];
}

/** O que a gravação fez. */
export interface DomainOutcome {
  /** `true` = alguma coisa entrou. Ver `applied` no ACK. */
  readonly applied: boolean;
  /** Contagens. É o que separa "entrou" de "entrou tudo". */
  readonly stats: Record<string, number>;
  readonly errors: readonly ConfigFieldError[];
}

/**
 * Um assunto: a régua e a escrita dele.
 *
 * ####  A RÉGUA VEM ANTES DA ESCRITA, E É SEPARADA DELA  ####
 *
 * O mesmo motivo do `planOfDesired`: os repositórios daqui aceitam
 * o que a rota local já validou, e uma escrita sem régua chega ao
 * banco. Por isso `plan` não escreve nada, e `apply` não valida
 * nada.
 */
export interface DomainApplier<W> {
  readonly domain: SiteDomain;
  /** Traduz o `desired` em trabalho. NÃO escreve. */
  plan(desired: Record<string, unknown>): DomainPlan<W>;
  /** Escreve. Só lança o que for catastrófico. */
  apply(work: W): Promise<DomainOutcome>;
}

/** O ACK, do jeito que ele é guardado até o site confirmar. */
interface PendingAck {
  readonly version: number;
  readonly applied: boolean;
  readonly errors: readonly ConfigFieldError[];
  readonly stats: Record<string, number>;
}

export interface SiteDomainConfigOptions<W> {
  readonly client: SiteClient;
  readonly meta: MetaRepository;
  readonly applier: DomainApplier<W>;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface SiteDomainHealth {
  readonly domain: SiteDomain;
  /** A última versão que o agente TENTOU aplicar. */
  readonly appliedVersion: number | null;
  readonly lastPullAt: number | null;
  readonly lastError: string | null;
  readonly ackPending: boolean;
}

/**
 * O laço visto de fora, sem o genérico.
 *
 * Quem sobe e desce os relógios (o `index.ts`) tem uma lista de
 * assuntos com formas de `desired` diferentes: sem este tipo, a
 * lista precisaria de um `any`, e o `any` de um lint desligado.
 */
export interface SiteDomainLoop {
  readonly domain: SiteDomain;
  readonly health: SiteDomainHealth;
  start(): void;
  stop(): void;
  pull(): Promise<void>;
}

export class SiteDomainConfig<W> implements SiteDomainLoop {
  readonly #options: SiteDomainConfigOptions<W>;
  readonly #now: () => number;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastPullAt: number | null = null;
  #lastError: string | null = null;
  #lastLogged: { message: string; at: number } | null = null;

  constructor(options: SiteDomainConfigOptions<W>) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
    this.#intervalMs = Math.min(
      MAX_DOMAIN_INTERVAL_MS,
      Math.max(MIN_DOMAIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_DOMAIN_INTERVAL_MS),
    );
  }

  get domain(): SiteDomain {
    return this.#options.applier.domain;
  }

  get health(): SiteDomainHealth {
    return {
      domain: this.domain,
      appliedVersion: this.#appliedVersion(),
      lastPullAt: this.#lastPullAt,
      lastError: this.#lastError,
      ackPending: this.#pendingAck() !== null,
    };
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.pull();
    }, this.#intervalMs);
    this.#timer.unref();

    void this.pull();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma volta. NUNCA lança e NUNCA rejeita.
   *
   * A ordem — pegar, comparar, aplicar, GRAVAR A VERSÃO, ACKar — é a
   * mesma da config de servidor, e pelo mesmo motivo: ela é o que
   * impede reaplicar o que já vale e reaplicar em laço o que falhou.
   */
  async pull(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      const etag = this.#options.meta.read(this.#key(DOMAIN_ETAG_KEY));
      const result = await this.#options.client.domainConfig(this.domain, etag);

      if (!result.ok) {
        this.#lastError = result.reason;
        this.#classify(result.status, result.code);

        return;
      }

      this.#lastPullAt = this.#now();
      this.#lastError = null;

      if (result.body.notModified) {
        await this.#flushAck();

        return;
      }

      const { version, desired } = result.body;

      if (version === null && desired === null) {
        // Assunto sem nada gravado do outro lado — `version: 0`,
        // `desired: null`. É o normal, e não vai para o log: ver a
        // mesma passagem em `site/config.ts`.
        return;
      }

      if (version === null || desired === null) {
        this.#log('warn', { domain: this.domain }, 'the site sent a domain config we cannot read');

        return;
      }

      const applied = this.#appliedVersion();

      if (applied !== null && version <= applied) {
        this.#rememberEtag(result.etag ?? null);
        await this.#flushAck();

        return;
      }

      await this.#converge(version, desired, result.etag ?? null);
      await this.#flushAck();
    } catch (error) {
      this.#lastError = toError(error).message;
      this.#log('error', { domain: this.domain, err: toError(error) }, 'domain round failed');
    } finally {
      this.#running = false;
    }
  }

  /**
   * Aplica UMA versão e deixa o ACK pronto, em disco.
   *
   * A versão é gravada JUNTO com o ACK, e antes dele, numa transação
   * só: uma queda entre as duas escritas deixaria o agente ou
   * reaplicando o que já gravou, ou devendo um ACK que ninguém sabe
   * que existe.
   */
  async #converge(
    version: number,
    desired: Record<string, unknown>,
    etag: string | null,
  ): Promise<void> {
    const plan = this.#options.applier.plan(desired);
    const failures = [...plan.errors];

    let applied = plan.errors.length === 0;
    let stats: Record<string, number> = {};

    if (plan.work !== null) {
      try {
        const outcome = await this.#options.applier.apply(plan.work);

        applied = outcome.applied;
        stats = outcome.stats;
        failures.push(...outcome.errors);
      } catch (error) {
        // A escrita inteira não aconteceu. Diferente do `.ini`, aqui
        // não dá para nomear campo a campo o que ficou de fora: o
        // que o site precisa ver é que a versão NÃO entrou.
        applied = false;
        failures.push({ field: this.domain, code: DOMAIN_ERROR_CODES.writeFailed });

        this.#log(
          'error',
          { domain: this.domain, version, err: toError(error) },
          'could not write the desired domain config',
        );
      }
    }

    const ack: PendingAck = { version, applied, errors: failures, stats };

    this.#options.meta.writeMany(
      {
        [this.#key(DOMAIN_VERSION_KEY)]: String(version),
        [this.#key(DOMAIN_ACK_KEY)]: JSON.stringify(ack),
        ...(etag === null ? {} : { [this.#key(DOMAIN_ETAG_KEY)]: etag }),
      },
      this.#now(),
    );

    if (applied) {
      this.#options.logger.info(
        { domain: this.domain, version, stats, errors: failures.length },
        'the desired config from the site was written',
      );
    }
  }

  /** Manda o ACK guardado, se houver. Só o sucesso o apaga. */
  async #flushAck(): Promise<void> {
    const pending = this.#pendingAck();

    if (pending === null) {
      return;
    }

    const result = await this.#options.client.ackDomainConfig(this.domain, {
      version: pending.version,
      applied: pending.applied,
      errors: pending.errors,
      stats: pending.stats,
    });

    if (!result.ok) {
      this.#log(
        'warn',
        { domain: this.domain, status: result.status, code: result.code },
        'the site refused the domain config ack',
      );

      return;
    }

    this.#options.meta.clear(this.#key(DOMAIN_ACK_KEY));
  }

  #rememberEtag(etag: string | null): void {
    if (etag === null || etag === this.#options.meta.read(this.#key(DOMAIN_ETAG_KEY))) {
      return;
    }

    this.#options.meta.write(this.#key(DOMAIN_ETAG_KEY), etag, this.#now());
  }

  #appliedVersion(): number | null {
    const raw = this.#options.meta.read(this.#key(DOMAIN_VERSION_KEY));

    if (raw === null || !/^-?\d+$/.test(raw)) {
      return null;
    }

    const parsed = Number(raw);

    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  #pendingAck(): PendingAck | null {
    const raw = this.#options.meta.read(this.#key(DOMAIN_ACK_KEY));

    if (raw === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as PendingAck;

      return typeof parsed.version === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Uma chave por ASSUNTO. Sem `serverId`: ver o cabeçalho. */
  #key(prefix: string): string {
    return `${prefix}.${this.domain}`;
  }

  /**
   * A tradução, curta como a da config de servidor.
   *
   * Todo 4xx com código desconhecido é "indisponível", e a volta
   * seguinte tenta de novo. Recuar, nunca fechar.
   */
  #classify(status: number | null, code: string | null): void {
    if (status === 404 && code === null) {
      this.#log(
        'warn',
        { domain: this.domain, status },
        'the site does not answer GET /api/agent/config/:domain yet',
      );

      return;
    }

    this.#log(
      'warn',
      { domain: this.domain, status, code },
      'could not read the desired domain config',
    );
  }

  #log(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
    const now = this.#now();
    const last = this.#lastLogged;

    if (last !== null && last.message === message && now - last.at < LOG_REPEAT_MS) {
      return;
    }

    this.#lastLogged = { message, at: now };
    this.#options.logger[level](fields, message);
  }
}
