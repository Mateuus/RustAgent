// ============================================================
//  run.ts  -  rodar um programa e transcrever a saída, linha a
//  linha, enquanto ele roda.
//
//  Substitui o `#spawnBat` do projeto anterior (ver
//  Docs\03-DECISOES.md, D3). A diferença que importa: aqui o
//  executável é o programa DE VERDADE — `steamcmd.exe`,
//  `taskkill` —, e não um `cmd.exe /c` com o comando montado como
//  texto. Sem `cmd` no meio não há metacaractere a escapar, e o
//  código de saída é o do programa, não o do interpretador.
// ============================================================

import { spawn } from 'node:child_process';

import { toError } from '../util.js';

export interface RunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Cada linha da saída (stdout e stderr juntos, na ordem). */
  readonly onLine: (line: string) => void;
  /** Mata o processo depois disto. */
  readonly timeoutMs?: number;
  /** Abortar de fora — é o "Cancelar operação" do painel. */
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly code: number;
  /** `true` quando o timeout ou o cancelamento derrubou o processo. */
  readonly killed: boolean;
}

/**
 * Roda e resolve com o código de saída.
 *
 * Não rejeita por código ≠ 0: "o SteamCMD saiu com 8" é um
 * desfecho que quem chamou precisa interpretar (há códigos que
 * significam "já estava atualizado"), e transformar isso em
 * exceção obrigaria a desembrulhar de volta.
 *
 * Rejeita, sim, quando o processo NÃO NASCEU — executável
 * ausente, permissão negada. Aí não há desfecho a interpretar.
 */
export function run(options: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      windowsHide: true,
      // stdin fechado: um programa que resolva perguntar alguma
      // coisa recebe EOF e desiste, em vez de ficar esperando
      // para sempre um Enter que ninguém vai dar.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killed = false;
    let settled = false;

    // ------------------------------------------------------
    //  A saída vem em PEDAÇOS, e não em linhas.
    //
    //  O SteamCMD escreve o progresso sem quebra de linha
    //  (`\r`), então um chunk pode trazer meia linha ou dez. O
    //  resto fica no buffer até a quebra chegar — senão o log da
    //  tela mostraria palavras cortadas ao meio.
    // ------------------------------------------------------
    let buffer = '';

    const consume = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');

      // `\r` sozinho também quebra: é o que o SteamCMD usa para
      // reescrever a linha de progresso no lugar.
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() !== '') {
          options.onLine(line);
        }
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    const kill = (): void => {
      killed = true;
      // `taskkill /T` derruba a árvore: matar só o pai deixaria
      // netos vivos segurando arquivo aberto na pasta que a
      // operação seguinte vai reescrever.
      if (child.pid !== undefined) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      }
    };

    const timer =
      options.timeoutMs === undefined ? null : setTimeout(kill, options.timeoutMs).unref();

    options.signal?.addEventListener('abort', kill, { once: true });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== null) {
        clearTimeout(timer);
      }

      reject(
        new Error(
          `não consegui executar "${options.command}": ${toError(error).message}. ` +
            'Confira se o arquivo existe e se o agente tem permissão para executá-lo.',
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== null) {
        clearTimeout(timer);
      }

      // O que sobrou no buffer sem quebra final ainda é uma
      // linha — e costuma ser justamente a mensagem de erro.
      if (buffer.trim() !== '') {
        options.onLine(buffer);
      }

      resolve({ code: code ?? -1, killed });
    });
  });
}
