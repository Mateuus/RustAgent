// ============================================================
//  routes/koth.ts  -  o território, pelo painel.
//
//      GET    /servers/:id/koth/arenas        os territórios
//      POST   /servers/:id/koth/arenas        cria. 201
//      PUT    /servers/:id/koth/arenas/:aid   edita
//      DELETE /servers/:id/koth/arenas/:aid   apaga
//
//      GET    /servers/:id/koth/status        o que está de pé
//      POST   /servers/:id/koth/start         ergue (sorteia ou escolhe)
//      POST   /servers/:id/koth/stop          derruba
//
//  ####  O CADASTRO VEM DO BANCO; O ESTADO VEM DO JOGO  ####
//
//  As quatro primeiras respondem com o servidor parado — é
//  justamente com ele parado que se desenha um território novo. As
//  três últimas não: elas perguntam ao jogo, e com ele fora do ar
//  devolvem 503.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { KothArenasRepository } from '../../db/koth-arenas-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import { KothCommandError, type KothService } from '../../game/koth.js';
import { kothArenaInputSchema } from '../../types/koth.js';
import { ApiError } from '../error-response.js';

export interface KothRoutesDeps {
  readonly arenas: KothArenasRepository;
  readonly servers: ServersRepository;
  /**
   * O canal com o jogo.
   *
   * Ausente = o agente subiu sem servidor nenhum. O cadastro continua
   * funcionando; erguer, não — e a rota diz isso em vez de fingir.
   */
  readonly koth?: KothService;
}

const serverParams = z.object({ id: z.string().min(1) });
const arenaParams = z.object({ id: z.string().min(1), arenaId: z.coerce.number().int().positive() });

function asApiError(cause: unknown): never {
  if (!(cause instanceof KothCommandError)) throw cause;

  switch (cause.reason) {
    case 'offline':
      throw new ApiError('SERVER_OFFLINE', cause.message, 503);

    case 'no_plugin':
      throw new ApiError('KOTH_PLUGIN_MISSING', cause.message, 503);

    case 'already_active':
    case 'not_active':
    case 'no_arena':
    case 'arena_disabled':
      throw new ApiError('KOTH_REFUSED', cause.message, 409);

    default:
      throw new ApiError('KOTH_FAILED', cause.message, 502);
  }
}

export function registerKothRoutes(app: FastifyInstance, deps: KothRoutesDeps): void {
  function assertServer(id: string): void {
    if (deps.servers.get(id) === null) {
      throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${id}".`, 404);
    }
  }

  function service(): KothService {
    if (deps.koth === undefined) {
      throw new ApiError(
        'KOTH_UNAVAILABLE',
        'Este agente subiu sem canal com os servidores: não há como erguer um KOTH.',
        503,
      );
    }

    return deps.koth;
  }

  // ==========================================================
  //  OS TERRITÓRIOS
  // ==========================================================

  app.get('/servers/:id/koth/arenas', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    return { ok: true, arenas: deps.arenas.list(id) };
  });

  app.post('/servers/:id/koth/arenas', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const input = kothArenaInputSchema.parse(request.body);

    assertServer(id);

    return reply.status(201).send({ ok: true, arena: deps.arenas.add(id, input) });
  });

  app.put('/servers/:id/koth/arenas/:arenaId', async (request) => {
    const { id, arenaId } = arenaParams.parse(request.params);
    const input = kothArenaInputSchema.parse(request.body);

    assertServer(id);

    const arena = deps.arenas.update(id, arenaId, input);

    if (arena === null) {
      throw new ApiError('ARENA_NOT_FOUND', 'Esse território não existe mais.', 404);
    }

    return { ok: true, arena };
  });

  app.delete('/servers/:id/koth/arenas/:arenaId', async (request) => {
    const { id, arenaId } = arenaParams.parse(request.params);

    assertServer(id);

    if (!deps.arenas.remove(id, arenaId)) {
      throw new ApiError('ARENA_NOT_FOUND', 'Esse território não existe mais.', 404);
    }

    return { ok: true };
  });

  // ==========================================================
  //  O QUE ESTÁ DE PÉ
  // ==========================================================

  app.get('/servers/:id/koth/status', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    try {
      return { ok: true, status: await service().status(id) };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.post('/servers/:id/koth/start', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = z
      .object({ arenaId: z.number().int().positive().optional() })
      .parse(request.body ?? {});

    assertServer(id);

    try {
      const started = await service().start({ serverId: id, arenaId: body.arenaId });

      return {
        ok: true,
        runId: started.runId,
        grid: started.grid,
        arena: started.arena,
      };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.post('/servers/:id/koth/stop', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    try {
      await service().stopRun(id);

      return { ok: true };
    } catch (cause) {
      return asApiError(cause);
    }
  });
}
