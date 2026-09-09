// ============================================================
//  routes/world-events.ts  -  o que nasce no mapa.
//
//      GET    /world-events                 a lista
//      GET    /world-events/:id             um inteiro
//      POST   /world-events                 cria. 201
//      PUT    /world-events/:id             edita
//      DELETE /world-events/:id             apaga
//
//      GET    /world-events/runs            o histórico, com filtro
//      GET    /world-events/runs/:runId     uma run, com quem entrou
//      POST   /world-events/runs/:runId/stop  encerra
//
//      GET    /servers/:id/event-zones      onde nada nasce
//      POST   /servers/:id/event-zones      cria. 201
//      DELETE /servers/:id/event-zones/:zoneId
//
//  ####  `world-events` E NÃO `events`  ####
//
//  Porque `/api/events` já é o CALENDÁRIO — "Raid Night, sábado às
//  20h", da migração 027. As duas são "evento" em português e não
//  têm nada em comum: a do calendário é uma data anunciada; estas
//  são coisas que nascem no mapa, com posição, dono e destroços.
//
//  Reaproveitar o prefixo faria a grade do wipe listar masmorras.
//
//  ####  AS DUAS REGRAS QUE NASCEM AQUI  ####
//
//    1. `EVENT_IN_USE` — apagar um evento com run de pé. Os
//       destroços ficariam no mapa sem ninguém para derrubá-los;
//    2. `SERVER_NOT_FOUND` — ligar o evento a um servidor que não
//       existe. Ele ficaria invisível e ninguém entenderia por quê.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §10.1.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ServersRepository } from '../../db/servers-repository.js';
import type { WorldEventsRepository } from '../../db/world-events-repository.js';
import {
  eventZoneInputSchema,
  FAILURE_MESSAGE,
  worldEventInputSchema,
  worldEventUpdateSchema,
  type EventRun,
  type WorldEventInput,
} from '../../types/world-events.js';
import { ApiError } from '../error-response.js';

export interface WorldEventRoutesDeps {
  readonly events: WorldEventsRepository;
  readonly servers: ServersRepository;
}

const idParams = z.object({ id: z.string().min(1) });
const runParams = z.object({ runId: z.coerce.number().int().positive() });
const zoneParams = z.object({ id: z.string().min(1), zoneId: z.coerce.number().int().positive() });

const runsQuery = z.object({
  eventId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function registerWorldEventRoutes(app: FastifyInstance, deps: WorldEventRoutesDeps): void {
  // ==========================================================
  //  O HISTÓRICO
  //
  //  Vem ANTES de `/world-events/:id` de propósito: o Fastify casa
  //  na ordem de registro, e `/world-events/runs` seria engolido
  //  por `:id` — o painel pediria o histórico e receberia
  //  "não existe evento chamado runs".
  // ==========================================================

  app.get('/world-events/runs', async (request) => {
    const query = runsQuery.parse(request.query);

    return { ok: true, runs: deps.events.runs(query).map(withMessage) };
  });

  app.get('/world-events/runs/:runId', async (request) => {
    const { runId } = runParams.parse(request.params);
    const run = deps.events.run(runId);

    if (run === null) {
      throw new ApiError('RUN_NOT_FOUND', `Não existe nascimento com o número ${runId}.`, 404);
    }

    return { ok: true, run: withMessage(run), players: deps.events.playersOf(runId) };
  });

  /**
   * Encerra um nascimento.
   *
   * Só marca no banco: derrubar a construção é o comando
   * `origemz.dungeon.stop`, que é da frente C. Marcar aqui sem o
   * comando lá deixaria o painel dizendo "encerrado" com a
   * masmorra de pé — por isso a rota devolve `pendingCommand`, e
   * a tela mostra isso enquanto o canal não existe.
   */
  app.post('/world-events/runs/:runId/stop', async (request) => {
    const { runId } = runParams.parse(request.params);
    const run = deps.events.run(runId);

    if (run === null) {
      throw new ApiError('RUN_NOT_FOUND', `Não existe nascimento com o número ${runId}.`, 404);
    }

    if (run.endedAt !== null) {
      throw new ApiError('RUN_ALREADY_ENDED', 'Esse nascimento já tinha terminado.', 409);
    }

    deps.events.endRun(runId, 'cancelled');

    return { ok: true, pendingCommand: 'ozdungeon stop' };
  });

  // ==========================================================
  //  A DEFINIÇÃO
  // ==========================================================

  app.get('/world-events', async () => ({ ok: true, events: deps.events.list() }));

  app.get('/world-events/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const event = deps.events.get(id);

    if (event === null) throw notFound(id);

    return { ok: true, event };
  });

  app.post('/world-events', async (request, reply) => {
    const input = worldEventInputSchema.parse(request.body);

    if (deps.events.exists(input.id)) {
      throw new ApiError('EVENT_EXISTS', `Já existe um evento com o identificador "${input.id}".`, 409);
    }

    assertServersExist(deps, input.servers);

    return reply.status(201).send({ ok: true, event: deps.events.save(input) });
  });

  app.put('/world-events/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = worldEventUpdateSchema.parse(request.body);

    if (!deps.events.exists(id)) throw notFound(id);

    assertServersExist(deps, body.servers);

    return { ok: true, event: deps.events.save({ id, ...body } as WorldEventInput) };
  });

  app.delete('/world-events/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    const live = deps.events
      .runs({ eventId: id, limit: 200 })
      .filter((run) => run.endedAt === null);

    if (live.length > 0) {
      throw new ApiError(
        'EVENT_IN_USE',
        `Este evento tem ${live.length} nascimento(s) de pé agora. ` +
          'Encerre antes de apagar, ou os destroços ficam no mapa sem ninguém para derrubá-los.',
        409,
      );
    }

    if (!deps.events.remove(id)) throw notFound(id);

    return { ok: true };
  });

  // ==========================================================
  //  AS ZONAS PROIBIDAS
  //
  //  Por SERVIDOR, e é por isso que elas moram sob `/servers/:id`:
  //  uma zona é um lugar no mapa, e cada servidor tem o seu.
  // ==========================================================

  app.get('/servers/:id/event-zones', async (request) => {
    const { id } = idParams.parse(request.params);

    assertServerExists(deps, id);

    return { ok: true, zones: deps.events.zonesOf(id) };
  });

  app.post('/servers/:id/event-zones', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = eventZoneInputSchema.parse(request.body);

    assertServerExists(deps, id);

    return reply.status(201).send({ ok: true, zone: deps.events.addZone(id, input) });
  });

  app.delete('/servers/:id/event-zones/:zoneId', async (request) => {
    const { id, zoneId } = zoneParams.parse(request.params);

    if (!deps.events.removeZone(id, zoneId)) {
      throw new ApiError('ZONE_NOT_FOUND', `Não existe zona ${zoneId} no servidor "${id}".`, 404);
    }

    return { ok: true };
  });
}

function notFound(id: string): ApiError {
  return new ApiError('EVENT_NOT_FOUND', `Não existe evento com o identificador "${id}".`, 404);
}

function assertServerExists(deps: WorldEventRoutesDeps, serverId: string): void {
  if (deps.servers.get(serverId) === null) {
    throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${serverId}".`, 404);
  }
}

/**
 * Ligar o evento a um servidor que não existe.
 *
 * Ele ficaria cadastrado, ligado, e não rodaria em lugar nenhum —
 * sem nada na tela explicando por quê.
 */
function assertServersExist(deps: WorldEventRoutesDeps, servers: readonly string[]): void {
  const missing = servers.filter((serverId) => deps.servers.get(serverId) === null);

  if (missing.length > 0) {
    throw new ApiError(
      'SERVER_NOT_FOUND',
      `Estes servidores não existem: ${missing.join(', ')}.`,
      422,
    );
  }
}

/**
 * A run com a frase da falha já resolvida.
 *
 * O código (`no_hatch`) é do contrato e viaja entre as pontas; a
 * frase é para gente. Traduzir na borda evita que cada tela do
 * painel invente a sua versão do mesmo motivo.
 */
function withMessage(run: EventRun): EventRun & { readonly failureMessage: string | null } {
  return {
    ...run,
    failureMessage: run.failureReason === null ? null : FAILURE_MESSAGE[run.failureReason],
  };
}
