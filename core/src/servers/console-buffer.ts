// ============================================================
//  console-buffer.ts  -  o que o servidor de Rust está dizendo,
//  agora.
//
//  O `RconClient` emite `log` para toda linha que o servidor
//  manda sem ser resposta de comando — é exatamente o que o
//  console web oficial mostra. Este buffer guarda as últimas e as
//  entrega por cursor, igual ao log de operação.
//
//  ------------------------------------------------------------
//  ####  ISTO NÃO É O ARQUIVO DE LOG  ####
//
//  O `-logfile` do jogo tem TUDO desde que o processo subiu,
//  inclusive o boot e a geração do mapa. Este buffer tem o que
//  passou pelo RCON DEPOIS que o agente conectou — e some quando
//  o agente reinicia.
//
//  São perguntas diferentes, e a tela oferece as duas: "o que
//  está acontecendo agora" (aqui) e "por que ele não subiu"
//  (arquivo, ver http/routes/console.ts).
//
//  ####  O TETO É POR SERVIDOR  ####
//
//  Um servidor cheio com plugin verboso passa de mil linhas por
//  minuto. 500 linhas é o que cabe numa tela rolável sem virar
//  vazamento de memória num processo que fica meses de pé.
// ============================================================

import type { RconLogEntry } from '../rcon/client.js';

const MAX_LINES = 500;

export interface ConsoleLine {
  /** Número absoluto. É o cursor do `fromLine`. */
  readonly n: number;
  readonly at: number;
  readonly text: string;
  /** `Generic`, `Warning`, `Error`… como o servidor classificou. */
  readonly type: string;
}

export class ConsoleBuffer {
  readonly #lines: ConsoleLine[] = [];
  #next = 0;
  #dropped = 0;

  get nextLine(): number {
    return this.#next;
  }

  get droppedLines(): number {
    return this.#dropped;
  }

  #append(line: ConsoleLine): void {
    this.#lines.push(line);
    this.#next += 1;

    if (this.#lines.length > MAX_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }

  push(entry: RconLogEntry): void {
    // Linha vazia é ruído: o Rust manda várias no boot, e elas só
    // empurram para fora do buffer o que interessa.
    const text = entry.message.trimEnd();

    if (text === '') {
      return;
    }

    this.#append({ n: this.#next, at: entry.receivedAt, text, type: entry.type });
  }

  /** Uma linha escrita pelo AGENTE (comando enviado, aviso). */
  pushLocal(text: string, type = 'Agent'): void {
    this.#append({ n: this.#next, at: Date.now(), text, type });
  }

  from(cursor: number): readonly ConsoleLine[] {
    return this.#lines.filter((line) => line.n >= cursor);
  }
}
