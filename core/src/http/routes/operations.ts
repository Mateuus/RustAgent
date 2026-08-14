// ============================================================
//  routes/operations.ts  -  disparar e acompanhar.
//
//  ####  O POST RESPONDE 202  ####
//
//  O trabalho continua depois da resposta — uma instalação de 6 GB
//  não cabe em requisição HTTP nenhuma. As recusas de
//  pré-condição (servidor no ar, RCON fora, SteamCMD ocupado)
//  acontecem ANTES do 202, e por isso saem como 409 aqui mesmo.
//
//  ####  O LOG É INCREMENTAL  ####
//
//  `?fromLine=N` devolve só o que chegou depois do cursor. O
//  painel manda o `nextLine` da vez anterior. `droppedLines` diz
//  quantas linhas o teto descartou — log truncado que não avisa
//  que truncou é pior que log nenhum.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Operation, OperationStore } from '../../ops/operations.js';
import { OPERATION_KINDS } from '../../ops/operations.js';
import { MAX_COUNTDOWN_MINUTES } from '../../ops/service.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError, zodErrorToResponse } from '../error-response.js';

export interface OperationRoutesDeps {
  readonly store: OperationStore;
  readonly supervisor: ServerSupervisor;
}

const startSchema = z
  .object({
    kind: z.enum(OPERATION_KINDS, {
      errorMap: () => ({ message: `kind precisa ser um destes: ${OPERATION_KINDS.join(', ')}` }),
    }),
    /** Só no stop/update: mata o processo quando o RCON não responde. */
    force: z.boolean().optional(),
    countdownMinutes: z.number().int().min(0).max(MAX_COUNTDOWN_MINUTES).optional(),
  })
  .strict();

const serverParams = z.object({ id: z.string().min(1) });
const operationParams = z.object({ opId: z.string().min(1) });
const logQuery = z.object({ fromLine: z.coerce.number().int().min(0).optional() });

/** O corpo que descreve uma operação, com o log a partir do cursor. */
function operationBody(operation: Operation, fromLine: number) {
  return {
    ...operation.view(),
    startedAt: new Date(operation.startedAt).toISOString(),
    finishedAt: operation.finishedAt === null ? null : new Date(operation.finishedAt).toISOString(),
    lines: operation.logFrom(fromLine).map((line) => ({
      n: line.n,
      at: new Date(line.at).toISOString(),
      text: line.text,
    })),
    nextLine: operation.nextLine,
    droppedLines: operation.droppedLines,
  };
}

export function registerOperationRoutes(app: FastifyInstance, deps: OperationRoutesDeps): void {
  // ---- o histórico daquele servidor, e o que ele aceita ----
  app.get('/servers/:id/operations', async (request) => {
    const { id } = serverParams.parse(request.params);
    const service = deps.supervisor.operationsOf(id);

    return {
      ok: true,
      // É daqui que a tela desenha os botões: um servidor sem
      // jogo em disco devolve ["server-install"], e mais nada.
      kinds: service.kinds(),
      operations: deps.store.list(id).map((operation) => ({
        ...operation.view(),
        startedAt: new Date(operation.startedAt).toISOString(),
        finishedAt:
          operation.finishedAt === null ? null : new Date(operation.finishedAt).toISOString(),
      })),
    };
  });

  // ---- disparar -------------------------------------------
  app.post('/servers/:id/operations', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const parsed = startSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      const response = zodErrorToResponse(parsed.error);
      return reply.status(response.statusCode).send(response.body);
    }

    const service = deps.supervisor.operationsOf(id);
    const operation = await service.start(parsed.data);

    return reply.status(202).send({
      ok: true,
      operationId: operation.id,
      kind: operation.kind,
      serverId: id,
      message: `A operação está rodando. Acompanhe em GET /api/operations/${operation.id}?fromLine=0`,
    });
  });

  // ---- acompanhar -----------------------------------------
  app.get('/operations/:opId', async (request) => {
    const { opId } = operationParams.parse(request.params);
    const { fromLine } = logQuery.parse(request.query);
    const operation = deps.store.get(opId);

    if (operation === null) {
      throw new ApiError(
        'UNKNOWN_OPERATION',
        `Não conheço a operação "${opId}". O histórico guarda as 20 últimas desta sessão do ` +
          'agente — se ele reiniciou, elas se foram.',
        404,
      );
    }

    return { ok: true, operation: operationBody(operation, fromLine ?? 0) };
  });

  // ---- cancelar -------------------------------------------
  app.post('/operations/:opId/cancel', async (request) => {
    const { opId } = operationParams.parse(request.params);
    const operation = deps.store.get(opId);

    if (operation === null) {
      throw new ApiError('UNKNOWN_OPERATION', `Não conheço a operação "${opId}".`, 404);
    }

    if (operation.status !== 'running') {
      throw new ApiError(
        'OPERATION_NOT_RUNNING',
        `A operação ${opId} já terminou (${operation.status}).`,
        409,
      );
    }

    operation.cancel();

    return {
      ok: true,
      // Cancelar é um PEDIDO. O que responde a ele é quem está
      // rodando: o SteamCMD morre na hora, e uma contagem de
      // atualização avisa no chat que foi adiada. Uma etapa sem
      // ponto seguro de parada termina normalmente.
      message:
        'Cancelamento pedido. O que já estava em curso pode levar alguns segundos para parar.',
    };
  });
}
