// ============================================================
//  op-log-file.ts  -  cada operação deixa um arquivo para trás.
//
//  ####  O CONSOLE DA TELA É AO VIVO, E SÓ  ####
//
//  As linhas de uma operação moram na memória do agente: cabem
//  2.000 (o `app_update` imprime dezenas de milhares), o
//  histórico guarda 20 operações, e um `pm2 restart` apaga tudo.
//  Isso serve para acompanhar um botão que acabou de ser
//  clicado — e não serve para a pergunta que sempre vem depois:
//
//      "o update automático da madrugada falhou. Por quê?"
//
//  Quem quisesse responder ia ao log do PM2 e NÃO ACHAVA: a saída
//  do SteamCMD nunca passou por ele. Ela ia para o console da
//  operação e morria ali. Este arquivo fecha esse buraco — a
//  MESMA linha que vai para a tela vai para
//  `Logs\<servidor>\ops\`, inteira e sem teto de 2.000.
//
//  ####  ESCREVER LOG NÃO PODE DERRUBAR OPERAÇÃO  ####
//
//  Disco cheio, pasta sem permissão, antivírus segurando o
//  arquivo: nada disso pode interromper uma atualização que já
//  está em curso. Todo erro daqui vira uma linha no log do agente
//  e a operação segue — no pior caso sem o arquivo, que é
//  exatamente o que se tinha antes.
// ============================================================

import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { Operation, OperationLogLine, OperationSink } from './operations.js';

/**
 * Quantos arquivos ficam na pasta.
 *
 * Uma instalação de 25 GB gera alguns MB de texto, e o resto das
 * operações gera KB. Cinquenta cobre semanas de histórico por uma
 * dezena de MB — e sem um teto a pasta cresceria para sempre numa
 * máquina que ninguém visita.
 */
const MAX_FILES = 50;

/** A subpasta, dentro de `Logs\<servidor>\`. */
export const OPS_LOG_DIRNAME = 'ops';

export interface OpLogFileOptions {
  /** `Logs\<servidor>\` — o log do jogo mora ao lado. */
  readonly logsDir: string;
  readonly logger: Logger;
}

/**
 * Abre o arquivo desta operação e devolve por onde despejar nele.
 *
 * `null` quando não deu para abrir — quem chama segue sem
 * arquivo, e não sem operação.
 */
export function openOperationLogFile(
  operation: Operation,
  options: OpLogFileOptions,
): {
  readonly path: string;
  readonly sink: OperationSink;
  /**
   * Resolve quando o arquivo terminou de ser escrito.
   *
   * `finish()` na operação devolve o controle na hora, mas a
   * escrita ainda está a caminho do disco — quem for LER o
   * arquivo logo em seguida (o teste é quem faz isso) precisa
   * esperar aqui, ou lê um arquivo que ainda não existe.
   */
  readonly closed: Promise<void>;
} | null {
  const dir = join(options.logsDir, OPS_LOG_DIRNAME);
  const path = join(dir, fileNameFor(operation));

  let stream: WriteStream;

  try {
    mkdirSync(dir, { recursive: true });

    // `a` e não `w`: o nome tem o id da operação e não se repete,
    // mas um arquivo que já exista é para ser continuado, nunca
    // truncado.
    stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  } catch (error) {
    options.logger.warn(
      { operation: operation.id, path, err: toError(error) },
      'não deu para abrir o arquivo de log desta operação — ela segue sem ele',
    );

    return null;
  }

  let broken = false;
  let settle: () => void = () => undefined;

  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  stream.on('close', () => {
    settle();
  });

  // Sem este ouvinte, um erro de escrita vira exceção não tratada
  // e derruba o agente INTEIRO por causa de um log.
  stream.on('error', (error: unknown) => {
    settle();

    if (broken) {
      return;
    }

    broken = true;

    options.logger.warn(
      { operation: operation.id, path, err: toError(error) },
      'falhou escrevendo o log desta operação — o resto dela não vai para o arquivo',
    );
  });

  const write = (text: string): void => {
    if (broken) {
      return;
    }

    stream.write(text);
  };

  write(header(operation, path));

  // A poda roda solta: ela olha a pasta inteira e não pode
  // atrasar a primeira linha de um update que já está saindo.
  void prune(dir, options.logger);

  return {
    path,
    closed,
    sink: {
      line: (line: OperationLogLine) => {
        write(`${stampOf(line.at)} ${line.text}\n`);
      },
      close: (finished: Operation) => {
        write(footer(finished));
        stream.end();
      },
    },
  };
}

/**
 * `2026-08-18_19-25-19_server-auto-update_op_d163abca.log`
 *
 * A data vem primeiro para a ordem alfabética da pasta ser a
 * ordem do tempo — é como alguém acha "a de ontem à noite" sem
 * abrir nenhuma.
 */
export function fileNameFor(operation: Operation): string {
  const stamp = new Date(operation.startedAt)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  return `${stamp}_${operation.kind}_${operation.id}.log`;
}

function header(operation: Operation, path: string): string {
  return (
    `======== ${operation.kind} · ${operation.id} · servidor ${operation.serverId}\n` +
    `======== começou em ${new Date(operation.startedAt).toISOString()}\n` +
    `======== arquivo: ${path}\n`
  );
}

function footer(operation: Operation): string {
  const seconds = Math.round(((operation.finishedAt ?? Date.now()) - operation.startedAt) / 1000);

  return (
    `======== ${operation.status.toUpperCase()} em ${String(seconds)}s` +
    `${operation.message === null ? '' : ` — ${operation.message}`}\n`
  );
}

/** `19:25:19` — o mesmo relógio que o console da tela mostra. */
function stampOf(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `[${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`;
}

/**
 * Apaga os mais velhos, mantendo os `MAX_FILES` últimos.
 *
 * Falhar aqui não é assunto de ninguém: no pior caso sobra um
 * arquivo a mais na pasta.
 */
async function prune(dir: string, logger: Logger): Promise<void> {
  try {
    if (!existsSync(dir)) {
      return;
    }

    const files = (await readdir(dir)).filter((name) => name.endsWith('.log')).sort();

    for (const name of files.slice(0, Math.max(0, files.length - MAX_FILES))) {
      await unlink(join(dir, name));
    }
  } catch (error) {
    logger.debug({ dir, err: toError(error) }, 'não deu para podar os logs de operação');
  }
}
