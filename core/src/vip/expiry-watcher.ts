// ============================================================
//  expiry-watcher.ts  -  o relógio que tira o VIP de quem venceu.
//
//  ####  O PLUGIN NÃO CUMPRE PRAZO SOZINHO  ####
//
//  O `OrigemZAgent` guarda a data e recusa um nível vencido nas
//  LEITURAS dele (`FindHighestActiveVipGrant` compara com
//  `DateTime.UtcNow`) — mas o GRUPO do Oxide não vence: ele fica lá
//  até alguém tirar. E o cache do plugin só muda quando o agente
//  empurra.
//
//  Sem este relógio, `expires_at` seria enfeite: a tela mostraria
//  "vence em 3 dias", a data passaria, e o jogador continuaria com
//  a tag no chat, a vaga na fila e o kit de VIP ao nascer.
//
//  Um VIP vencido que ninguém tirou é pior que não ter prazo: o
//  jogador parou de pagar e continua com o benefício, e quem
//  administra descobre pelo Discord.
//
//  ------------------------------------------------------------
//  ####  MESMO DESENHO DO RELÓGIO DOS BANIMENTOS  ####
//
//  Ver bans/expiry-watcher.ts. As três propriedades que importam:
//
//    intervalo configurável   um minuto é folga de sobra para um
//                             prazo medido em dias, e a varredura é
//                             uma consulta por índice num banco
//                             local;
//
//    `unref()` no timer       o relógio sozinho não segura o
//                             processo vivo. Quem mantém o event
//                             loop de pé é o servidor HTTP, e sem o
//                             unref o desligamento esperaria a
//                             próxima batida;
//
//    cede a vez               uma rodada que ainda não terminou não
//                             ganha companhia. A varredura fala com
//                             N servidores pelo RCON e pode passar
//                             do intervalo; duas em paralelo
//                             empurrariam o mesmo estado duas vezes
//                             e disputariam a mesma linha.
//
//  ####  A PRIMEIRA RODADA SAI NO BOOT  ####
//
//  Prazos vencem enquanto o agente está parado, e a varredura é
//  barata. O que ela faz de fato (empurrar o estado, tirar do
//  grupo) só acontece nos servidores com RCON de pé; os outros
//  ficam para a reconciliação da próxima conexão.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { VipList } from './service.js';

/** De quanto em quanto tempo olhar os vencimentos. */
export const DEFAULT_VIP_SWEEP_INTERVAL_MS = 60_000;

export interface VipExpiryWatcherOptions {
  readonly vips: VipList;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export class VipExpiryWatcher {
  readonly #vips: VipList;
  readonly #logger: Logger;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  /** Uma rodada por vez. Ver o cabeçalho. */
  #running = false;

  constructor(options: VipExpiryWatcherOptions) {
    this.#vips = options.vips;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_VIP_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);

    this.#timer.unref();

    this.#logger.info(
      { intervalSeconds: Math.round(this.#intervalMs / 1000) },
      'relógio dos VIPs com prazo ligado',
    );

    // A rodada do boot: prazos venceram enquanto o agente esteve
    // parado, e não há motivo para esperar um intervalo inteiro
    // para descobrir isso.
    void this.sweep();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma passada. Também é o que o `start` dispara no boot.
   *
   * Nunca lança: um erro aqui é de rotina, e derrubar o relógio por
   * causa dele deixaria os vencimentos parados para sempre — em
   * silêncio, que é o pior jeito de um relógio falhar.
   */
  async sweep(): Promise<void> {
    if (this.#running) {
      this.#logger.debug('relógio dos VIPs: a rodada anterior ainda não terminou');
      return;
    }

    this.#running = true;

    try {
      const expired = await this.#vips.sweepExpired();

      if (expired.length > 0) {
        this.#logger.info(
          { count: expired.length, vips: expired.map((vip) => `${vip.steamId}:${vip.tier}`) },
          'VIPs vencidos revogados pelo relógio',
        );
      }
    } catch (error) {
      this.#logger.warn(
        { err: toError(error) },
        'a varredura de VIPs vencidos falhou; a próxima rodada tenta de novo',
      );
    } finally {
      this.#running = false;
    }
  }
}
