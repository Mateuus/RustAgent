// ============================================================
//  expiry-watcher.ts  -  o relógio que solta quem cumpriu a pena.
//
//  ####  O BAN DO RUST NÃO TEM PRAZO  ####
//
//  Não existe "banir por 7 dias" no jogo: o `banid` é permanente,
//  e o `bans.cfg` não guarda vencimento. O prazo é NOSSO — mora na
//  coluna `expires_at` — e por isso quem desbane precisa ser um
//  relógio deste lado.
//
//  Sem ele, `expires_at` seria enfeite: a tela mostraria "vence em
//  3 dias", a data passaria, e o jogador continuaria fora. Um ban
//  vencido que ninguém removeu é pior que não ter prazo — a pessoa
//  cumpriu a pena, e quem está mentindo é o agente.
//
//  ------------------------------------------------------------
//  ####  MESMO DESENHO DO VIGIA DA STEAM  ####
//
//  Ver steam/update-watcher.ts. As três propriedades que importam,
//  e o motivo de cada uma:
//
//    intervalo configurável   um minuto é folga de sobra para uma
//                             pena medida em horas, e não custa
//                             nada — a varredura é uma consulta
//                             por índice num banco local;
//
//    `unref()` no timer       o relógio sozinho não segura o
//                             processo vivo. Quem mantém o event
//                             loop de pé é o servidor HTTP, e sem
//                             o unref o desligamento esperaria a
//                             próxima batida;
//
//    cede a vez               uma rodada que ainda não terminou não
//                             ganha companhia. A varredura fala com
//                             N servidores pelo RCON e pode passar
//                             do intervalo; duas em paralelo
//                             mandariam o mesmo `unban` duas vezes
//                             e disputariam a mesma linha.
//
//  ####  A PRIMEIRA RODADA SAI NO BOOT, E NÃO DEPOIS DO
//        INTERVALO  ####
//
//  Diferente do vigia da Steam, aqui a primeira batida vale a pena
//  logo: enquanto o agente esteve parado, prazos venceram — e a
//  varredura é barata. O que ela faz de fato (mandar `unban`) só
//  acontece nos servidores com RCON de pé; os outros ficam para a
//  reconciliação do próximo start.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { BanList } from './service.js';

/** De quanto em quanto tempo olhar os vencimentos. */
export const DEFAULT_BAN_SWEEP_INTERVAL_MS = 60_000;

export interface BanExpiryWatcherOptions {
  readonly bans: BanList;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export class BanExpiryWatcher {
  readonly #bans: BanList;
  readonly #logger: Logger;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  /** Uma rodada por vez. Ver o cabeçalho. */
  #running = false;

  constructor(options: BanExpiryWatcherOptions) {
    this.#bans = options.bans;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? DEFAULT_BAN_SWEEP_INTERVAL_MS;
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
      'relógio dos banimentos temporários ligado',
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
      this.#logger.debug('relógio dos banimentos: a rodada anterior ainda não terminou');
      return;
    }

    this.#running = true;

    try {
      const released = await this.#bans.sweepExpired();

      if (released.length > 0) {
        this.#logger.info(
          { count: released.length, steamIds: released },
          'banimentos vencidos revogados pelo relógio',
        );
      }
    } catch (error) {
      this.#logger.warn(
        { err: toError(error) },
        'a varredura de banimentos vencidos falhou; a próxima rodada tenta de novo',
      );
    } finally {
      this.#running = false;
    }
  }
}
