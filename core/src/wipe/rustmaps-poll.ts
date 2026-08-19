// ============================================================
//  rustmaps-poll.ts  -  o RELÓGIO da prévia.
//
//  Uma volta por minuto, e ela faz duas coisas:
//
//    1. pede a prévia das seeds que ainda não têm uma;
//    2. pergunta se o que está `generating` já ficou pronto.
//
//  É o mesmo desenho do vigia da Steam (steam/update-watcher.ts):
//  um `setInterval` com `unref`, uma rodada que nunca lança, e um
//  retrato em memória que a tela lê. A diferença é o peso do que
//  está em jogo — aquele derruba e sobe servidor; este desenha
//  uma imagem.
//
//  ------------------------------------------------------------
//  ####  ELE NUNCA SEGURA UM WIPE  ####
//
//  Nada aqui para servidor, apaga arquivo ou tira seed da fila.
//  O pior desfecho possível de uma volta ruim é uma frase em
//  `last_error` e um cartão sem imagem. Um servidor que não zerou
//  de madrugada porque um site estava fora do ar é o defeito que
//  esta regra existe para impedir.
//
//  ------------------------------------------------------------
//  ####  AS TRÊS TRAVAS  ####
//
//  1. TETO DE CHAMADAS POR VOLTA. O limite da API não foi medido
//     (ver `RUSTMAPS_REQUESTS_PER_MINUTE`), então o agente
//     trabalha uma ordem de grandeza abaixo do que ele diz ser.
//
//  2. CHAVE RECUSADA DESLIGA A GERAÇÃO. Um 401/403 trava o
//     relógio até alguém trocar a chave — e trocar a chave é
//     mexer no `.env` e reiniciar, que é justamente o que zera
//     esta trava. Sem ela, uma chave errada bateria na API a cada
//     minuto, para sempre.
//
//  3. `generating` TEM PRAZO. Passou de `RUSTMAPS_GIVE_UP_MS`
//     sem ficar pronto, a entrada sai do limbo com o motivo
//     escrito. Ver `MapPoolRepository.markPreviewFailed`: num
//     mundo procedural ela volta para a fila, porque a seed nunca
//     dependeu da imagem.
// ============================================================

import type { MapPoolRecord, MapPoolRepository } from '../db/map-pool-repository.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import {
  EMPTY_QUOTA,
  RUSTMAPS_REQUESTS_PER_MINUTE,
  type RustMapsClient,
  type RustMapsKeyStatus,
  type RustMapsOutcome,
  type RustMapsQuota,
} from './rustmaps.js';

/** De quanto em quanto tempo o relógio dá uma volta. */
export const RUSTMAPS_POLL_INTERVAL_MS = 60_000;

/**
 * Quantas chamadas cabem numa volta.
 *
 * Dez por minuto contra um teto ANUNCIADO de
 * `RUSTMAPS_REQUESTS_PER_MINUTE` — que não foi medido. A folga é
 * de propósito: estourar a cota mensal de uma conta por causa de
 * um enfeite seria trocar a imagem de hoje pelas prévias do mês
 * inteiro.
 */
export const RUSTMAPS_MAX_CALLS_PER_TICK = 10;

/**
 * Quanto tempo uma entrada pode ficar `generating`.
 *
 * A fila do RustMaps costuma andar em minutos. Meia hora é folga
 * larga para um dia ruim lá, e é curta o bastante para ninguém
 * ficar olhando um "gerando…" que já morreu.
 */
export const RUSTMAPS_GIVE_UP_MS = 30 * 60_000;

/** Quanto esperar antes de tentar de novo uma entrada que falhou. */
export const RUSTMAPS_RETRY_AFTER_ERROR_MS = 10 * 60_000;

/** O recuo inicial depois de um 429 ou 5xx. Ele dobra até o teto. */
export const RUSTMAPS_BACKOFF_MS = 2 * 60_000;
export const RUSTMAPS_MAX_BACKOFF_MS = 30 * 60_000;

/** Por quanto tempo o retrato da chave vale sem perguntar de novo. */
export const RUSTMAPS_STATUS_TTL_MS = 5 * 60_000;

/** O retrato que a rota de status devolve. A chave NÃO está aqui. */
export interface RustMapsWatcherState {
  readonly key: RustMapsKeyStatus;
  /** O agente pede prévia sozinho ao ver uma seed sem imagem? */
  readonly autoGenerate: boolean;
  /** Por que a geração automática está desligada. `null` = está ligada. */
  readonly disabledReason: string | null;
  /** Até quando o agente está recuando por causa de 429/5xx. Epoch ms. */
  readonly backoffUntil: number | null;
  /** O teto ANUNCIADO pela API, que ninguém mediu. Ver Docs\17. */
  readonly announcedRateLimit: number;
  /** Quantas chamadas cabem numa volta do relógio. */
  readonly callsPerTick: number;
}

export interface RustMapsWatcherOptions {
  readonly client: RustMapsClient;
  readonly repository: MapPoolRepository;
  /** De onde sai a lista de servidores. Só `ids()` é usado. */
  readonly servers: { ids: () => readonly string[] };
  readonly logger?: Logger;
  readonly intervalMs?: number;
  /**
   * Pedir a prévia sozinho ao ver uma seed sem imagem.
   *
   * Nasce ligado: colar uma seed e ver a imagem aparecer é o
   * produto. Desliga por `RUSTMAPS_AUTO_GENERATE=0` no `.env`, ou
   * sozinho quando a chave é recusada.
   */
  readonly autoGenerate?: boolean;
  readonly giveUpMs?: number;
  readonly retryAfterErrorMs?: number;
  /** Injetável para o teste andar no tempo sem esperar. */
  readonly now?: () => number;
}

/**
 * O desfecho de pedir a prévia de UMA entrada — o que a rota
 * devolve para a tela.
 */
export interface RustMapsGenerateResult {
  readonly entry: MapPoolRecord;
  readonly outcome: RustMapsOutcome;
  readonly message: string;
}

export class RustMapsWatcher {
  readonly #options: RustMapsWatcherOptions;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #giveUpMs: number;
  readonly #retryAfterErrorMs: number;

  #timer: ReturnType<typeof setInterval> | null = null;
  #autoGenerate: boolean;
  #disabledReason: string | null = null;
  #backoffUntil = 0;
  #backoffMs = RUSTMAPS_BACKOFF_MS;
  #status: RustMapsKeyStatus | null = null;
  #statusAt = 0;

  /**
   * Quando cada entrada foi perguntada por último.
   *
   * Em memória, e de propósito: é uma trava de gentileza com o
   * serviço de fora, não um dado do produto. Perder isso num
   * reinício custa uma pergunta a mais; gravá-la no banco custaria
   * uma coluna e uma migração que esta frente não tem.
   */
  readonly #askedAt = new Map<number, number>();

  constructor(options: RustMapsWatcherOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? RUSTMAPS_POLL_INTERVAL_MS;
    this.#giveUpMs = options.giveUpMs ?? RUSTMAPS_GIVE_UP_MS;
    this.#retryAfterErrorMs = options.retryAfterErrorMs ?? RUSTMAPS_RETRY_AFTER_ERROR_MS;
    this.#autoGenerate = options.autoGenerate ?? true;

    if (!this.#autoGenerate) {
      this.#disabledReason =
        'RUSTMAPS_AUTO_GENERATE=0 no .env: o agente só pede prévia quando alguém clica.';
    }
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    const timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);

    // Uma imagem de mapa não é motivo para o processo não
    // desligar.
    timer.unref?.();
    this.#timer = timer;

    this.#options.logger?.info(
      {
        configured: this.#options.client.configured,
        autoGenerate: this.#autoGenerate,
        intervalSeconds: Math.round(this.#intervalMs / 1000),
      },
      this.#options.client.configured
        ? 'relógio do RustMaps ligado — a fila de mapas ganha imagem'
        : 'relógio do RustMaps ligado sem chave (RUSTMAPS_API_KEY vazia) — a fila fica sem prévia, ' +
            'e nenhum wipe depende disso',
    );
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** O retrato para a tela. Nunca sai na rede. */
  state(): RustMapsWatcherState {
    return {
      key: this.#status ?? {
        configured: this.#options.client.configured,
        valid: null,
        plan: null,
        quota: this.#options.client.quota,
        checkedAt: null,
        message: this.#options.client.configured
          ? 'A chave ainda não foi conferida nesta subida do agente.'
          : 'RUSTMAPS_API_KEY está vazia no .env: a fila funciona, e os cartões ficam sem imagem.',
      },
      autoGenerate: this.#autoGenerate,
      disabledReason: this.#disabledReason,
      backoffUntil: this.#backoffUntil > this.#now() ? this.#backoffUntil : null,
      announcedRateLimit: RUSTMAPS_REQUESTS_PER_MINUTE,
      callsPerTick: RUSTMAPS_MAX_CALLS_PER_TICK,
    };
  }

  /**
   * O estado da chave, com cache.
   *
   * A tela de mapas recarrega sozinha; perguntar ao RustMaps a
   * cada abertura gastaria cota para redesenhar o mesmo cadeado.
   */
  async keyStatus(force = false): Promise<RustMapsKeyStatus> {
    const now = this.#now();

    if (!force && this.#status !== null && now - this.#statusAt < RUSTMAPS_STATUS_TTL_MS) {
      return this.#status;
    }

    const status = await this.#options.client.status(now);

    this.#status = status;
    this.#statusAt = now;

    if (status.valid === false) {
      this.#disableAuto(status.message);
    }

    return status;
  }

  /**
   * Pede a prévia de UMA entrada. É o botão da tela, e é também o
   * que a volta do relógio chama.
   *
   * `staging` só é decidido aqui quando ninguém disse: a regra é
   * "a entrada aponta para um wipe forçado?" (ver
   * `aimedAtForcedWipe`), e não uma caixinha na tela.
   */
  async generate(
    serverId: string,
    mapId: number,
    options: { readonly staging?: boolean } = {},
  ): Promise<RustMapsGenerateResult> {
    const now = this.#now();
    const entry = this.#options.repository.get(serverId, mapId);

    if (entry === null) {
      throw new Error(`o mapa ${String(mapId)} não está na fila de ${serverId}`);
    }

    if (entry.kind === 'custom' || entry.seed === null || entry.worldSize === null) {
      return {
        entry,
        outcome: {
          kind: 'unconfigured',
          message: 'mapa custom não tem prévia do RustMaps',
        },
        message:
          'Esta entrada é um arquivo .map de fora: a imagem dela vem de quem fez o mapa, e não ' +
          'do gerador do RustMaps.',
      };
    }

    const staging = options.staging ?? this.#options.repository.aimedAtForcedWipe(serverId, mapId, now);

    this.#askedAt.set(mapId, now);

    const outcome = await this.#options.client.request({
      seed: entry.seed,
      size: entry.worldSize,
      staging,
    });

    const saved = this.#apply(serverId, entry, outcome, now);

    return { entry: saved, outcome, message: describe(outcome, staging) };
  }

  /**
   * Uma volta.
   *
   * ####  ELA NÃO LANÇA  ####
   *
   * Rodando num `setInterval`, uma exceção sem dono mataria o
   * laço e as prévias parariam em silêncio. Cada servidor é
   * tentado dentro do seu `try`, e o que der errado vira linha de
   * log — nunca um `catch` mudo.
   */
  async tick(): Promise<void> {
    if (!this.#options.client.configured) {
      return;
    }

    const now = this.#now();

    if (now < this.#backoffUntil) {
      return;
    }

    let budget = RUSTMAPS_MAX_CALLS_PER_TICK;

    for (const serverId of this.#options.servers.ids()) {
      if (budget <= 0) {
        return;
      }

      try {
        budget = await this.#sweep(serverId, budget, now);
      } catch (error) {
        this.#options.logger?.warn(
          { server: serverId, err: toError(error) },
          'relógio do RustMaps: esta volta falhou neste servidor — a fila de mapas segue intacta',
        );
      }
    }
  }

  // ------------------------------------------------------
  //  Interno
  // ------------------------------------------------------

  /** Um servidor: primeiro quem está gerando, depois quem não tem. */
  async #sweep(serverId: string, budget: number, now: number): Promise<number> {
    let left = budget;

    // 1. O que já está na fila do RustMaps. Vem antes porque
    //    terminar o que começou é mais útil que começar mais.
    for (const entry of this.#options.repository.generating(serverId)) {
      if (left <= 0) {
        return left;
      }

      if (entry.rustmapsId === null) {
        // `generating` sem id é um estado que ninguém consegue
        // acompanhar — tira do limbo com o motivo escrito.
        this.#options.repository.markPreviewFailed(
          serverId,
          entry.id,
          'a prévia ficou marcada como "gerando" sem o id do RustMaps, e não havia como ' +
            'acompanhá-la. A seed continua valendo.',
          now,
        );
        continue;
      }

      if (now - entry.updatedAt > this.#giveUpMs) {
        this.#options.repository.markPreviewFailed(
          serverId,
          entry.id,
          `o RustMaps não terminou esta prévia em ${String(Math.round(this.#giveUpMs / 60_000))} ` +
            'minutos. A seed continua valendo — peça a prévia de novo quando quiser.',
          now,
        );
        continue;
      }

      left -= 1;

      const outcome = await this.#options.client.mapOf(entry.rustmapsId, entry.staging);

      this.#apply(serverId, entry, outcome, now);

      if (this.#stopSweeping(outcome)) {
        return 0;
      }
    }

    if (!this.#autoGenerate) {
      return left;
    }

    // 2. As seeds que ainda não têm imagem. É o "colar uma seed
    //    gera a prévia sozinho" — sem hook nenhum na rota de
    //    quem cria a entrada.
    for (const entry of this.#options.repository.withoutPreview(serverId)) {
      if (left <= 0) {
        return left;
      }

      const askedAt = this.#askedAt.get(entry.id);

      if (askedAt !== undefined && now - askedAt < this.#retryAfterErrorMs) {
        continue;
      }

      if (entry.seed === null || entry.worldSize === null) {
        continue;
      }

      left -= 1;

      const staging = this.#options.repository.aimedAtForcedWipe(serverId, entry.id, now);

      this.#askedAt.set(entry.id, now);

      const outcome = await this.#options.client.request({
        seed: entry.seed,
        size: entry.worldSize,
        staging,
      });

      this.#apply(serverId, entry, outcome, now);

      if (this.#stopSweeping(outcome)) {
        return 0;
      }
    }

    return left;
  }

  /**
   * O desfecho vira linha no banco. Ver a tabela do Docs\17.
   *
   * Repare que o `staging` do PEDIDO não entra aqui: quem grava a
   * coluna é o desfecho (`outcome.preview.staging`,
   * `outcome.staging`), porque é ele que sabe em que branch o
   * retrato foi realmente tirado.
   */
  #apply(
    serverId: string,
    entry: MapPoolRecord,
    outcome: RustMapsOutcome,
    now: number,
  ): MapPoolRecord {
    if (outcome.kind === 'ready') {
      this.#clearBackoff();

      return this.#options.repository.markPreviewReady(
        serverId,
        entry.id,
        {
          rustmapsId: outcome.preview.mapId,
          staging: outcome.preview.staging,
          previewUrl: outcome.preview.imageUrl,
          thumbUrl: outcome.preview.thumbUrl,
          monuments: outcome.preview.monuments,
        },
        now,
      );
    }

    if (outcome.kind === 'queued') {
      this.#clearBackoff();

      return this.#options.repository.markGenerating(
        serverId,
        entry.id,
        outcome.mapId,
        outcome.staging,
        now,
      );
    }

    if (outcome.kind === 'denied') {
      this.#disableAuto(outcome.message);
      this.#status = null;

      return this.#options.repository.markPreviewFailed(serverId, entry.id, outcome.message, now);
    }

    if (outcome.kind === 'missing') {
      return this.#options.repository.markPreviewFailed(serverId, entry.id, outcome.message, now);
    }

    if (outcome.kind === 'throttled') {
      this.#recuar(outcome.retryAfterMs, now);
      // Estado NÃO muda: instabilidade lá fora não é veredicto
      // sobre o mundo daqui. A frase fica para a tela poder dizer
      // por que a imagem ainda não veio.
      this.#options.repository.noteError(serverId, entry.id, outcome.message, now);

      return this.#options.repository.get(serverId, entry.id) ?? entry;
    }

    // `offline` e `unconfigured`: a seed continua valendo, a fila
    // continua andando, e o cartão diz "sem prévia".
    this.#options.repository.noteError(
      serverId,
      entry.id,
      outcome.kind === 'offline'
        ? `sem prévia: ${outcome.message}. A seed continua valendo, e o wipe usa ela do mesmo jeito.`
        : outcome.message,
      now,
    );

    return this.#options.repository.get(serverId, entry.id) ?? entry;
  }

  /** Vale a pena continuar esta volta depois deste desfecho? */
  #stopSweeping(outcome: RustMapsOutcome): boolean {
    return outcome.kind === 'denied' || outcome.kind === 'throttled' || outcome.kind === 'offline';
  }

  #disableAuto(reason: string): void {
    if (!this.#autoGenerate) {
      return;
    }

    this.#autoGenerate = false;
    this.#disabledReason = reason;

    this.#options.logger?.error(
      { reason },
      'o RustMaps recusou a chave — geração automática de prévia DESLIGADA até trocarem a ' +
        'RUSTMAPS_API_KEY no .env e reiniciar. Nenhum wipe depende disto.',
    );
  }

  #recuar(retryAfterMs: number | null, now: number): void {
    const wait = retryAfterMs ?? this.#backoffMs;

    this.#backoffUntil = now + wait;
    this.#backoffMs = Math.min(this.#backoffMs * 2, RUSTMAPS_MAX_BACKOFF_MS);

    this.#options.logger?.warn(
      { untilInSeconds: Math.round(wait / 1000) },
      'o RustMaps pediu calma — o relógio da prévia recua',
    );
  }

  #clearBackoff(): void {
    this.#backoffUntil = 0;
    this.#backoffMs = RUSTMAPS_BACKOFF_MS;
  }
}

/** A frase do desfecho, pronta para a tela. */
function describe(outcome: RustMapsOutcome, staging: boolean): string {
  const nota = staging
    ? ' Pedida no branch STAGING, porque este mundo entra num wipe FORÇADO: o forçado troca a ' +
      'versão do jogo, e um retrato tirado na de hoje pode não descrever o mundo de amanhã.'
    : '';

  switch (outcome.kind) {
    case 'ready':
      return `A prévia já existia no RustMaps e entrou no cartão.${nota}`;
    case 'queued':
      return (
        'O RustMaps aceitou o pedido' +
        (outcome.queuePosition === null
          ? '. '
          : ` e pôs em ${String(outcome.queuePosition)}º na fila dele. `) +
        `O agente acompanha e a imagem aparece sozinha.${nota}`
      );
    case 'denied':
      return outcome.message;
    case 'missing':
      return outcome.message;
    case 'throttled':
      return `${outcome.message} O agente recua sozinho e tenta de novo — a fila não para.`;
    case 'offline':
      return (
        `Não deu para falar com o rustmaps.com: ${outcome.message}. A seed continua valendo, e ` +
        'o wipe usa ela do mesmo jeito — a prévia é enfeite.'
      );
    case 'unconfigured':
      return outcome.message;
  }
}

/** A cota vazia, reexportada para quem só importa este arquivo. */
export const RUSTMAPS_EMPTY_QUOTA: RustMapsQuota = EMPTY_QUOTA;
