// ============================================================
//  wallet.ts  -  de onde vem o saldo de OZCoin.
//
//  ####  DUAS FONTES, UMA INTERFACE  ####
//
//  Hoje o saldo mora no banco do agente. Amanhã ele mora no site
//  externo, e o agente passa a consultar e debitar LÁ.
//
//  Quem chama não sabe qual das duas está no ar: as duas
//  implementam `Wallet`, e a escolha acontece uma vez, na
//  inicialização, olhando a configuração. Sem isso, cada ponto que
//  mexe em saldo precisaria de um `if` — e o dia da virada seria
//  uma caçada a todos eles.
//
//  ####  QUAL DELAS ESTÁ VALENDO  ####
//
//  `STORE_WALLET_URL` no `.env` decide (ver config.ts):
//
//      vazio      -> carteira LOCAL (banco do agente)
//      preenchido -> carteira REMOTA (o site é o dono)
//
//  A virada é ligar a variável e reiniciar. O saldo local NÃO é
//  migrado automaticamente: são carteiras diferentes, e somar uma
//  na outra sem alguém mandar seria inventar dinheiro.
//
//  ------------------------------------------------------------
//  ####  "NÃO TEM" E "NÃO CONSEGUI PERGUNTAR" SÃO DIFERENTES  ####
//
//  É a distinção que este arquivo existe para preservar. A primeira
//  é resposta ao jogador ("faltam 200"); a segunda é retentável, e
//  tratá-las igual faria a loja dizer "saldo insuficiente" a quem
//  tem dinheiro só porque o site demorou a responder.
//
//  ####  INTEIRO, SEMPRE  ####
//
//  OZCoin não tem centavo. Saldo em float é como um débito de 10
//  vira 9,999999 e o jogador fica com 0,000001 de troco que a tela
//  arredonda para zero.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

export interface WalletBalance {
  readonly steamId: string;
  readonly balance: number;
  /** De onde veio, para a tela poder dizer. */
  readonly source: 'local' | 'remote';
}

/**
 * O resultado de mexer no saldo.
 *
 * `insufficient` é um desfecho NORMAL, e não um erro: o jogador
 * tentou comprar sem ter. Ver o cabeçalho.
 */
export type WalletChange =
  | { readonly status: 'ok'; readonly balance: number }
  | { readonly status: 'insufficient'; readonly balance: number }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface Wallet {
  readonly source: 'local' | 'remote';
  getBalance(steamId: string): Promise<WalletBalance>;
  /**
   * Tira do saldo.
   *
   * `reference` identifica a compra, e é o que torna o débito
   * rastreável e — na carteira remota — idempotente.
   */
  debit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange>;
  /** Devolve ao saldo. Usado no estorno e pelo admin. */
  credit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange>;
}

// ============================================================
//  A CARTEIRA LOCAL
// ============================================================

/**
 * O que a carteira local precisa do banco. E nada além disso.
 *
 * Interface mínima de propósito: quem a satisfaz em produção é o
 * `WalletsRepository`, e no teste são cinco linhas em memória.
 */
export interface WalletStore {
  getBalance(steamId: string): number;
  /**
   * Aplica a variação e devolve o saldo novo.
   *
   * `null` quando não há saldo suficiente — a checagem e a escrita
   * acontecem na MESMA transação, e é isso que impede dois débitos
   * simultâneos de deixarem o saldo negativo.
   */
  change(
    steamId: string,
    amount: number,
    reference: string | null,
    reason: string,
    now?: number,
  ): number | null;
}

export class LocalWallet implements Wallet {
  readonly source = 'local' as const;
  readonly #store: WalletStore;

  constructor(store: WalletStore) {
    this.#store = store;
  }

  getBalance(steamId: string): Promise<WalletBalance> {
    return Promise.resolve({
      steamId,
      balance: this.#store.getBalance(steamId),
      source: this.source,
    });
  }

  debit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange> {
    const balance = this.#store.change(steamId, -Math.abs(amount), reference, reason);

    return Promise.resolve(
      balance === null
        ? { status: 'insufficient', balance: this.#store.getBalance(steamId) }
        : { status: 'ok', balance },
    );
  }

  credit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange> {
    const balance = this.#store.change(steamId, Math.abs(amount), reference, reason);

    // Crédito não tem como faltar saldo; `null` aqui seria um
    // defeito nosso, e devolver "indisponível" é mais honesto do que
    // dizer que creditou.
    return Promise.resolve(
      balance === null
        ? { status: 'unavailable', reason: 'a carteira local recusou um crédito' }
        : { status: 'ok', balance },
    );
  }
}

// ============================================================
//  A CARTEIRA REMOTA — o site externo é o dono
// ============================================================

export interface RemoteWalletOptions {
  /** Base da API do site, sem barra no fim. */
  readonly baseUrl: string;
  readonly token: string;
  readonly logger?: Logger | undefined;
  /**
   * Teto de espera por resposta.
   *
   * Existe porque isto roda no caminho de um jogador que clicou e
   * está olhando a tela: sem timeout, o site lento vira menu
   * travado.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * O contrato que o site externo precisa cumprir.
 *
 *     GET  {base}/wallet/{steamId}          -> { balance }
 *     POST {base}/wallet/{steamId}/debit    -> { ok, balance }
 *     POST {base}/wallet/{steamId}/credit   -> { ok, balance }
 *
 * Com `Idempotency-Key` nos dois POST. Saldo insuficiente é
 * **409**, e não 200 com um campo — o agente precisa distinguir
 * "recusado" (não insista) de "não consegui falar" (tente de novo),
 * e o código de status é onde essa diferença cabe.
 */
export class RemoteWallet implements Wallet {
  readonly source = 'remote' as const;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #logger: Logger | undefined;
  readonly #timeoutMs: number;

  constructor(options: RemoteWalletOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getBalance(steamId: string): Promise<WalletBalance> {
    const response = await this.#request('GET', `/wallet/${steamId}`);

    if (response === null || typeof response.balance !== 'number') {
      // Saldo desconhecido vira ZERO, e não um erro: a loja continua
      // abrindo, e o que falha é a COMPRA — com uma mensagem que diz
      // o que houve. Derrubar a vitrine porque o site piscou seria
      // punir quem só queria olhar.
      this.#logger?.warn({ steamId }, 'a carteira remota não respondeu o saldo');

      return { steamId, balance: 0, source: this.source };
    }

    return { steamId, balance: Math.trunc(response.balance), source: this.source };
  }

  debit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange> {
    return this.#move('debit', steamId, amount, reference, reason);
  }

  credit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange> {
    // Chave DERIVADA no crédito: usando a mesma do débito, o site
    // trataria o estorno como repetição do débito e o ignoraria — o
    // jogador ficaria sem o item e sem o dinheiro.
    return this.#move('credit', steamId, amount, `${reference}:credit`, reason);
  }

  async #move(
    kind: 'debit' | 'credit',
    steamId: string,
    amount: number,
    reference: string,
    reason: string,
  ): Promise<WalletChange> {
    let response: Response;

    try {
      response = await this.#fetch(`/wallet/${steamId}/${kind}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#token}`,
          'Idempotency-Key': reference,
        },
        body: JSON.stringify({ amount: Math.abs(Math.trunc(amount)), reason }),
      });
    } catch (error) {
      const err = toError(error);

      this.#logger?.warn({ err, steamId, kind }, 'a carteira remota não respondeu');

      return { status: 'unavailable', reason: err.message };
    }

    if (response.status === 409) {
      const body = (await this.#json(response)) ?? {};

      return {
        status: 'insufficient',
        balance: typeof body.balance === 'number' ? Math.trunc(body.balance) : 0,
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');

      this.#logger?.warn(
        { steamId, kind, status: response.status },
        'a carteira remota recusou o movimento',
      );

      return {
        status: 'unavailable',
        reason: `o site respondeu ${String(response.status)} ${text}`,
      };
    }

    const body = (await this.#json(response)) ?? {};

    return {
      status: 'ok',
      balance: typeof body.balance === 'number' ? Math.trunc(body.balance) : 0,
    };
  }

  async #request(method: string, path: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.#fetch(path, {
        method,
        headers: { Authorization: `Bearer ${this.#token}` },
      });

      return response.ok ? await this.#json(response) : null;
    } catch (error) {
      this.#logger?.warn({ err: toError(error), path }, 'a consulta à carteira remota falhou');

      return null;
    }
  }

  async #fetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    try {
      return await fetch(`${this.#baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(response: Response): Promise<Record<string, unknown> | null> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
