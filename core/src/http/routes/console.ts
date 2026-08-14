// ============================================================
//  routes/console.ts  -  o console do servidor.
//
//  Duas fontes, e elas respondem perguntas DIFERENTES:
//
//    /console      o que passou pelo RCON depois que o agente
//                  conectou. É o "o que está acontecendo agora",
//                  e é o mesmo que o console web oficial mostra
//
//    /console/file o fim do `-logfile` do jogo. Tem TUDO desde
//                  que o processo subiu, inclusive o boot e a
//                  geração do mapa — é o "por que ele não subiu",
//                  e funciona com o RCON fora do ar
//
//  Misturar as duas numa rota só pareceria simples e produziria a
//  pergunta mais cara desta tela: "esta linha é de agora ou de
//  duas horas atrás?".
// ============================================================

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';

export interface ConsoleRoutesDeps {
  readonly supervisor: ServerSupervisor;
}

const params = z.object({ id: z.string().min(1) });
const cursorQuery = z.object({ fromLine: z.coerce.number().int().min(0).optional() });
const tailQuery = z.object({ lines: z.coerce.number().int().min(1).max(2_000).optional() });

/**
 * Quanto do FIM do arquivo ler.
 *
 * O log de um servidor de dias tem centenas de MB. Ler o arquivo
 * inteiro para mostrar as últimas cem linhas derrubaria o agente
 * por memória — então a leitura começa a 512 KB do fim, que cobre
 * folgadamente qualquer pedido de até 2000 linhas.
 */
const TAIL_BYTES = 512 * 1024;

async function tailFile(path: string, lines: number): Promise<readonly string[]> {
  const info = await stat(path);
  const start = Math.max(0, info.size - TAIL_BYTES);

  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    createReadStream(path, { start })
      .on('data', (chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  const text = Buffer.concat(chunks).toString('utf8');
  const all = text.split(/\r?\n/);

  // A primeira linha pode ter sido cortada ao meio pelo `start`.
  // Descartá-la é melhor que mostrar meia frase como se fosse
  // uma linha de log.
  if (start > 0 && all.length > 1) {
    all.shift();
  }

  return all.filter((line) => line.trim() !== '').slice(-lines);
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleRoutesDeps): void {
  // ---- ao vivo, pelo RCON ---------------------------------
  app.get('/servers/:id/console', async (request) => {
    const { id } = params.parse(request.params);
    const { fromLine } = cursorQuery.parse(request.query);
    const context = deps.supervisor.contextOf(id);

    if (context === null) {
      if (deps.supervisor.configOf(id) === null) {
        throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
      }

      // Servidor conhecido, mas sem contexto: o agente não está
      // cuidando dele. NÃO é erro — é um estado que a tela mostra,
      // com o log do arquivo continuando disponível ao lado.
      return {
        ok: true,
        connected: false,
        lines: [],
        nextLine: 0,
        droppedLines: 0,
        message:
          `O agente não está cuidando do servidor "${id}", então não há console ao vivo. ` +
          'O log do jogo continua disponível na aba de arquivo.',
      };
    }

    const cursor = fromLine ?? 0;

    return {
      ok: true,
      connected: context.rcon.isConnected,
      state: context.rcon.state,
      lines: context.console.from(cursor).map((line) => ({
        n: line.n,
        at: new Date(line.at).toISOString(),
        text: line.text,
        type: line.type,
      })),
      nextLine: context.console.nextLine,
      droppedLines: context.console.droppedLines,
    };
  });

  // ---- o arquivo do jogo ----------------------------------
  app.get('/servers/:id/console/file', async (request) => {
    const { id } = params.parse(request.params);
    const { lines } = tailQuery.parse(request.query);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    const path = join(config.paths.logsDir, `server-${config.identity}.log`);

    try {
      return { ok: true, path, lines: await tailFile(path, lines ?? 200) };
    } catch {
      // Arquivo ausente é o estado NORMAL de um servidor que nunca
      // subiu. Dizer isso é melhor que um 500 que assusta.
      return {
        ok: true,
        path,
        lines: [],
        message: `Ainda não há log em ${path}. Ele é criado quando o servidor sobe pela primeira vez.`,
      };
    }
  });
}
