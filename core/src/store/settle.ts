// ============================================================
//  settle.ts  -  o relógio que fecha compra presa, com PROVA.
//
//  ####  NA DÚVIDA, PRESERVA  ####
//
//  Três desfechos e um deles é NENHUM. Site inalcançável não decide
//  nada: a compra segue presa e o minuto seguinte tenta de novo.
//  Decidir sem prova é o que produz entrega dupla.
//
//  ####  A MARGEM DE 90 s  ####
//
//  O agente aborta em 5 s (`SITE_TIMEOUT_MS`), mas o site pode
//  continuar processando. Reconciliar dentro dessa janela veria
//  "nenhuma linha" enquanto a transação ainda está em voo — e
//  cancelaria uma compra prestes a ser cobrada.
//
//  ####  E ELE DESISTE  ####
//
//  Um relógio que tenta "no próximo minuto" PARA SEMPRE não é
//  resiliência: é um gerador de carga. Com a rota de prova
//  respondendo 400 (referência gravada torta) ou 403 (IP fora da
//  allowlist), a compra nunca sairia do laço, o alarme dispararia e
//  nunca calaria, e o settler queimaria até 50 requisições por
//  minuto contra um pedido que jamais vai passar — num canal que
//  não tem rate-limit do lado de lá.
//
//  ####  O RELÓGIO E O BOTÃO CHAMAM A MESMA FUNÇÃO  ####
//
//  `StoreService.settle`. Dois códigos que decidem a mesma coisa
//  discordam no primeiro ajuste, e o dia em que discordarem é o dia
//  em que alguém é cobrado duas vezes.
//
//  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §11.
// ============================================================

import type { StoreRepository } from '../db/store-repository.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { StoreService } from './service.js';

export const DEFAULT_SETTLE_INTERVAL_MS = 60_000;
/** `charge-unknown` e o estorno retentável entram com 90 s. */
export const SETTLE_MIN_AGE_MS = 90_000;
/** `debited` parado e o `pending` órfão entram com 5 min. */
export const SETTLE_DEBITED_MIN_AGE_MS = 300_000;
export const SETTLE_ORPHAN_MIN_AGE_MS = 300_000;
/** Os dois tetos que fazem o relógio DESISTIR. */
export const SETTLE_MAX_ATTEMPTS = 60;
export const SETTLE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
/** A reivindicação de uma linha expira em 5 min. */
export const SETTLE_CLAIM_TTL_MS = 300_000;
export const SETTLE_BATCH = 50;

/**
 * O que UMA chamada de settle decidiu.
 *
 * ####  `review` NÃO É UM `state`  ####
 *
 * O CHECK da migração 035 tem seis valores, e nenhum deles é
 * `review`: quem responde "isto precisa de gente" é `state='failed'`
 * com `error` começando em `CHARGE_UNPROVABLE`, ou `state='debited'`
 * com `PLAN_MISSING`. Um sétimo estado mudaria o enum público de
 * `GET /api/store/purchases` e a tela do painel por causa de algo
 * que já cabe no `error`.
 */
export type SettleOutcome = 'delivered' | 'refunded' | 'cancelled' | 'review' | null;

export interface PurchaseSettlerOptions {
  /** A MESMA função que o botão chama. */
  readonly service: StoreService;
  readonly repository: StoreRepository;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class PurchaseSettler {
  readonly #service: StoreService;
  readonly #repository: StoreRepository;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: PurchaseSettlerOptions) {
    this.#service = options.service;
    this.#repository = options.repository;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_SETTLE_INTERVAL_MS;
    this.#now = options.now ?? ((): number => Date.now());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);
    this.#timer.unref();

    void this.sweep();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma varredura.
   *
   * NUNCA lança: ela roda num relógio, e um `throw` aqui pararia a
   * reconciliação em silêncio — que é o pior jeito de ela falhar,
   * porque o sintoma é uma compra presa que ninguém resolve.
   */
  async sweep(now = this.#now()): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      const stuck = this.#repository.listStuck({
        // TRÊS cutoffs, e não um: com 90 s para todos, um `debited`
        // de 91 s entraria — e o settler mandaria para conferência
        // humana uma compra que ainda está sendo entregue.
        unknownCutoff: now - SETTLE_MIN_AGE_MS,
        debitedCutoff: now - SETTLE_DEBITED_MIN_AGE_MS,
        orphanCutoff: now - SETTLE_ORPHAN_MIN_AGE_MS,
        limit: SETTLE_BATCH,
      });

      for (const purchase of stuck) {
        try {
          await this.#service.settle({
            serverId: purchase.serverId,
            purchaseId: purchase.id,
          });
        } catch (error) {
          // Uma compra que estoura não pode levar as outras 49
          // junto: a próxima da lista pode ser justamente a que
          // resolve sozinha.
          this.#logger.error(
            { purchaseId: purchase.id, serverId: purchase.serverId, err: toError(error) },
            'settling a stuck purchase threw',
          );
        }
      }
    } catch (error) {
      this.#logger.error({ err: toError(error) }, 'purchase settler sweep failed');
    } finally {
      this.#running = false;
    }
  }
}
