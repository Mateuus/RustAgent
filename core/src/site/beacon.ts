// ============================================================
//  beacon.ts  -  o agente se anuncia ao site, e sabe dizer se
//  está pareado.
//
//  ####  ELE É A ÚNICA CHAMADA QUE NÃO PRECISA DE TOKEN  ####
//
//  É o primeiro contato: o site cria a linha em `agents` como
//  `pending`, e um HUMANO ativa colando o token no admin. Enquanto
//  isso não acontece, a loja fica INDISPONÍVEL — nunca "saldo 0",
//  que é o erro que faz o jogador achar que perdeu dinheiro.
//
//  ####  O ESTADO QUE ELE GUARDA É A PRIMEIRA TELA DO DIAGNÓSTICO  ####
//
//  "o agente está pending", "o token foi rotacionado" e "o site está
//  fora do ar" produzem o MESMO sintoma para o jogador: o botão de
//  comprar para de funcionar. Sem separar as três, cada ocorrência
//  custa uma tarde.
//
//  ####  UM BEACON POR SERVIDOR PAREADO  ####
//
//  Cada `Server` do site tem sua própria linha em `agents` e seu
//  próprio bearer. Um RustAgent com três servidores de Rust bate
//  três vezes, e cada batida fala de um deles.
//
//  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §9.
// ============================================================

import { createHmac } from 'node:crypto';

import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { SiteClient } from './client.js';

export const DEFAULT_BEACON_INTERVAL_MS = 10_000;
export const MIN_BEACON_INTERVAL_MS = 5_000;
/** O site considera "online" quem beaconou nos últimos 5 min. */
export const MAX_BEACON_INTERVAL_MS = 300_000;

/**
 * O freio do `suspect`.
 *
 * Uma rajada de compras contra um token rotacionado chamaria
 * `suspect` uma vez por compra, e sem freio isso vira um beacon por
 * clique — exatamente o laço que o piso de 5 s do intervalo existe
 * para impedir. Mesmo número, mesma razão.
 */
export const SUSPECT_DEBOUNCE_MS = 5_000;

/**
 * O que este agente sabe fazer, na palavra que o site entende.
 *
 * `deliver_item` é o nome que o painel do Conan já usa e que o site
 * reconhece ao lado de `inventory_delivery` (do DayZ): inventar um
 * terceiro nome faria o site não reconhecer nada. `pull_delivery` é
 * a bandeira que diz "eu PUXO a fila; não me chame".
 */
export const RUST_CAPABILITIES = [
  'ozcoins',
  'shop',
  'deliver_item',
  'players_online',
  'pull_delivery',
] as const;

export type SitePairingStatus = 'unknown' | 'pending' | 'active' | 'banned' | 'orphan';

export interface SitePairing {
  readonly status: SitePairingStatus;
  /** O que o site respondeu, em português, para a tela. */
  readonly message: string | null;
  readonly lastBeaconAt: number | null;
  readonly lastBeaconError: string | null;
  /** O `error_code` cru da última resposta ruim. Separa as sete causas. */
  readonly lastBeaconErrorCode: string | null;
  /** `false` = o `Server` não existe no site com esse id. */
  readonly serverExists: boolean | null;
  /** Diferente do nosso = o site reatribuiu o agente. */
  readonly currentServerId: string | null;
}

export interface SiteBeaconOptions {
  readonly client: SiteClient;
  /** O bearer DESTE servidor. Vazio = ainda não ativado no site. */
  readonly token: string;
  /** A porta do agente. Vai no corpo, e o site a guarda. */
  readonly port: number;
  readonly version: string;
  readonly mac: string;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class SiteBeacon {
  readonly #client: SiteClient;
  readonly #token: string;
  readonly #port: number;
  readonly #version: string;
  readonly #mac: string;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastSuspectAt = 0;
  #pairing: SitePairing = {
    status: 'unknown',
    message: null,
    lastBeaconAt: null,
    lastBeaconError: null,
    lastBeaconErrorCode: null,
    serverExists: null,
    currentServerId: null,
  };

  constructor(options: SiteBeaconOptions) {
    this.#client = options.client;
    this.#token = options.token;
    this.#port = options.port;
    this.#version = options.version;
    this.#mac = options.mac;
    this.#logger = options.logger;
    this.#intervalMs = Math.min(
      MAX_BEACON_INTERVAL_MS,
      Math.max(MIN_BEACON_INTERVAL_MS, options.intervalMs ?? DEFAULT_BEACON_INTERVAL_MS),
    );
    this.#now = options.now ?? ((): number => Date.now());
  }

  get pairing(): SitePairing {
    return this.#pairing;
  }

  /** Só com `active` a loja cobra. */
  get ready(): boolean {
    return this.#pairing.status === 'active';
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.beat();
    }, this.#intervalMs);
    // Não segura o processo: um relógio de conveniência não pode ser
    // a razão de o agente não conseguir desligar.
    this.#timer.unref();

    // Uma rodada no boot: esperar 10 s para descobrir que o token
    // está errado é 10 s de loja indisponível sem ninguém saber.
    void this.beat();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Alguém viu um código de pareamento numa rota autenticada: o
   * pareamento pode ter quebrado. Força uma batida AGORA.
   *
   * Nunca lança, e nunca é esperado com `await`: quem chama está no
   * caminho de um jogador que clicou.
   */
  suspect(reason: string): void {
    const now = this.#now();

    if (now - this.#lastSuspectAt < SUSPECT_DEBOUNCE_MS) {
      return;
    }

    this.#lastSuspectAt = now;
    this.#logger.warn({ reason }, 'pairing looks broken; beaconing now');
    void this.beat();
  }

  /**
   * Uma batida.
   *
   * NUNCA lança: um erro aqui é rotina, e derrubar o relógio
   * deixaria o pareamento parado para sempre — em silêncio, que é o
   * pior jeito de um relógio falhar.
   */
  async beat(): Promise<SitePairing> {
    if (this.#running) {
      return this.#pairing;
    }

    this.#running = true;

    try {
      const timestamp = Math.floor(this.#now() / 1000);
      const result = await this.#client.beacon({
        port: this.#port,
        version: this.#version,
        mac: this.#mac,
        capabilities: RUST_CAPABILITIES,
        // Assina SEMPRE que há token — não condicionado ao status
        // conhecido, para que o primeiro beacon depois de o admin
        // ativar já venha assinado. Um site que ainda não exija a
        // assinatura ignora os dois headers.
        ...(this.#token === ''
          ? {}
          : { signature: { timestamp, value: this.#sign(timestamp) } }),
      });

      this.#pairing = result.ok
        ? this.#fromBody(result.body)
        : this.#fromError(result.status, result.code, result.reason, result.body);
    } catch (error) {
      // Não deveria acontecer — o cliente não lança —, mas o relógio
      // não pode morrer por causa de uma surpresa.
      this.#pairing = {
        ...this.#pairing,
        lastBeaconError: toError(error).message,
        lastBeaconErrorCode: null,
      };
    } finally {
      this.#running = false;
    }

    return this.#pairing;
  }

  #fromBody(body: Record<string, unknown>): SitePairing {
    const status = typeof body.status === 'string' ? body.status : 'unknown';
    const serverExists = typeof body.serverExists === 'boolean' ? body.serverExists : null;
    const currentServerId =
      typeof body.currentServerId === 'string' ? body.currentServerId : null;
    const message = typeof body.message === 'string' ? body.message : null;

    // `serverExists: false` é mais grave que o status: o `Server` não
    // existe no site com esse id, e nenhuma ativação vai acontecer
    // até alguém cadastrá-lo. A tela precisa dizer isso, e não
    // "pending" — que soa como "espere".
    const resolved: SitePairingStatus =
      serverExists === false
        ? 'orphan'
        : status === 'active' || status === 'pending' || status === 'banned'
          ? status
          : 'unknown';

    if (resolved === 'active' && this.#pairing.status !== 'active') {
      this.#logger.info({ serverId: this.#client.serverId }, 'site pairing became active');
    }

    if (currentServerId !== null && currentServerId !== this.#client.serverId) {
      // O site reatribuiu o agente para outro `Server`. Não é erro de
      // rede nem de token: alguém mexeu no cadastro, e o `.env` (ou o
      // `.ini`) daqui está desatualizado.
      this.#logger.error(
        { ours: this.#client.serverId, theirs: currentServerId },
        'the site reassigned this agent to another serverId',
      );
    }

    return {
      status: resolved,
      message,
      lastBeaconAt: this.#now(),
      lastBeaconError: null,
      lastBeaconErrorCode: null,
      serverExists,
      currentServerId,
    };
  }

  /**
   * As três famílias de 403, e a regra é esta — a única.
   *
   *   1. corpo que parseia como JSON e tem a chave `banId`
   *      -> ban de verdade: PARA de beaconar;
   *   2. corpo que NÃO parseia como JSON e contém `error code: 1010`
   *      -> a borda recusou o User-Agent: continua;
   *   3. qualquer outro 403 -> trata como borda.
   *
   * O terceiro é conservador de propósito: parar de beaconar por
   * engano deixa o agente invisível para o site, e ninguém descobre
   * por quê. E o `error_code` não serve aqui — o beacon é a única
   * rota do site que não tem `error_code` em resposta nenhuma.
   */
  #fromError(
    status: number | null,
    code: string | null,
    reason: string,
    body: Record<string, unknown> | null,
  ): SitePairing {
    const keep = {
      ...this.#pairing,
      lastBeaconError: reason,
      lastBeaconErrorCode: code,
    };

    if (status === 403 && body !== null && 'banId' in body) {
      this.#logger.error({ reason }, 'this agent is BANNED on the site; beacon stopped');
      this.stop();

      return { ...keep, status: 'banned', message: reason };
    }

    if (status === 401 && code !== null && code.startsWith('BEACON_')) {
      // O site parou de aceitar as batidas. Para de cobrar, guarda o
      // código CRU para a tela e continua beaconando, assinado: o
      // conserto é do lado de fora (token, relógio, reativação), e o
      // agente precisa perceber o instante em que ele acontece.
      this.#logger.error({ code, reason }, 'the site refused a signed beacon');

      return { ...keep, status: 'pending', message: reason };
    }

    this.#logger.warn({ status, code, reason }, 'beacon failed');

    return keep;
  }

  /**
   * HMAC-SHA256 do bearer sobre `serverId|timestamp`, em hex.
   *
   * Aditiva: um site que ainda não a exija ignora o header. Ela
   * existe porque o beacon não tem autenticação nenhuma — quem
   * souber (ou adivinhar) um `serverId` sobrescreve o IP, a porta e
   * as capabilities de um agente EM PRODUÇÃO.
   */
  #sign(timestamp: number): string {
    return createHmac('sha256', this.#token)
      .update(`${this.#client.serverId}|${String(timestamp)}`)
      .digest('hex');
  }
}
