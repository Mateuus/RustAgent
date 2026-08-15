// ============================================================
//  wipe.ts  -  quando foi o último wipe daquele servidor.
//
//  ####  QUEM SABE ISSO É O SERVIDOR, E ELE JÁ RESPONDE  ####
//
//  MEDIDO no `server01`, pelo RCON:
//
//      serverinfo -> "SaveCreatedTime": "08/14/2026 16:00:11"
//
//  É a hora em que o save nasceu — ou seja, o wipe. Não há por que
//  inventar uma segunda fonte: um carimbo nosso, gravado quando o
//  agente vê o servidor subir, erraria em todo servidor que fizesse
//  wipe com o agente parado. E é o tipo de erro que só aparece no
//  dia do wipe, que é justamente quando isto importa.
//
//  ------------------------------------------------------------
//  ####  O FORMATO É AMERICANO, E ISSO NÃO É DETALHE  ####
//
//  `08/14/2026` só pode ser 14 de agosto: não existe mês 14. Mas
//  `05/06/2026` é ambíguo, e o `new Date()` do Node o leria como 5
//  de junho — o que num servidor com wipe em 6 de maio daria um mês
//  de diferença, em silêncio.
//
//  Por isso o parse é EXPLÍCITO, campo a campo, e recusa o que não
//  casar com o formato inteiro.
//
//  ####  E ELE É CACHEADO ATÉ O RCON RECONECTAR  ####
//
//  A hora do wipe não muda enquanto o servidor está no ar: para ela
//  mudar, o servidor precisa parar, apagar o save e subir — e isso
//  derruba o RCON. Perguntar a cada abertura de tela seria uma ida
//  ao servidor por clique, para receber sempre o mesmo número.
// ============================================================

import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

/**
 * Rede de segurança do cache.
 *
 * A invalidação de verdade é a reconexão do RCON (ver `forget`).
 * Este prazo existe para o caso que ela não cobre: alguém trocando o
 * save por baixo com o servidor de pé. Meia hora de atraso num
 * bloqueio pós-wipe é tolerável; um valor preso para sempre não é.
 */
const TTL_MS = 30 * 60_000;

interface Cached {
  /** Epoch ms do wipe. `null` = perguntei e não deu para saber. */
  readonly at: number | null;
  readonly readAt: number;
}

export interface WipeClockDeps {
  readonly logger?: Logger | undefined;
  /** Injetável para o teste não depender do relógio. */
  readonly now?: () => number;
}

export class WipeClock {
  readonly #cache = new Map<string, Cached>();
  readonly #deps: WipeClockDeps;
  readonly #now: () => number;

  constructor(deps: WipeClockDeps = {}) {
    this.#deps = deps;
    this.#now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Quando foi o wipe. `null` = não deu para saber.
   *
   * E `null` NÃO é o mesmo que "faz muito tempo": quem usa isto
   * precisa decidir o que fazer sem a informação, e a escolha deste
   * projeto é LIBERAR — recusar sem certeza puniria o jogador por um
   * servidor que não respondeu.
   */
  async at(serverId: string, rcon: OpsRcon | null): Promise<number | null> {
    const cached = this.#cache.get(serverId);

    if (cached !== undefined && this.#now() - cached.readAt < TTL_MS) {
      return cached.at;
    }

    if (rcon === null || !rcon.isConnected) {
      // Sem RCON não dá para perguntar, e NÃO se cacheia a ausência:
      // a próxima tentativa, com o servidor no ar, precisa perguntar
      // de novo.
      return cached?.at ?? null;
    }

    let at: number | null = null;

    try {
      at = parseSaveCreatedTime(await rcon.send('serverinfo'));

      if (at === null) {
        this.#deps.logger?.warn(
          { server: serverId },
          'o serverinfo não trouxe SaveCreatedTime; o bloqueio pós-wipe fica desligado aqui',
        );
      }
    } catch (error) {
      this.#deps.logger?.warn(
        { server: serverId, err: toError(error) },
        'não consegui perguntar a hora do wipe',
      );

      return cached?.at ?? null;
    }

    this.#cache.set(serverId, { at, readAt: this.#now() });

    return at;
  }

  /**
   * Esquece o que sabia daquele servidor.
   *
   * Chamado na RECONEXÃO do RCON, que é o momento em que um wipe
   * pode ter acontecido: para o save mudar, o servidor precisou
   * parar e subir.
   */
  forget(serverId: string): void {
    this.#cache.delete(serverId);
  }
}

/**
 * `SaveCreatedTime` do `serverinfo` -> epoch ms. `null` = não achou.
 *
 * O `serverinfo` responde JSON INDENTADO em várias linhas (medido —
 * ver game/item-catalog.ts), então a busca é pelo CAMPO, e não pela
 * primeira linha.
 */
export function parseSaveCreatedTime(raw: string): number | null {
  const found = /"SaveCreatedTime"\s*:\s*"([^"]+)"/.exec(raw);

  if (found === null) {
    return null;
  }

  return parseUsDateTime(found[1] ?? '');
}

/**
 * `MM/DD/YYYY HH:mm:ss` -> epoch ms. `null` = não é isso.
 *
 * Campo a campo de propósito: ver o cabeçalho para por que
 * `new Date(texto)` erraria um mês inteiro em silêncio.
 */
export function parseUsDateTime(text: string): number | null {
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());

  if (parts === null) {
    return null;
  }

  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const year = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);

  const at = new Date(year, month - 1, day, hour, minute, second).getTime();

  // Uma data impossível (13/45/2026) atravessa o regex, e o
  // `new Date` a "corrige" rolando o mês. Conferir de volta é o que
  // separa "li errado" de "li outra coisa".
  const back = new Date(at);

  const same =
    back.getFullYear() === year &&
    back.getMonth() === month - 1 &&
    back.getDate() === day &&
    back.getHours() === hour;

  return same ? at : null;
}
