// ============================================================
//  routes/steam-updates.ts  -  o build instalado x o publicado.
//
//  Duas rotas, e a diferença entre elas importa:
//
//    GET   o último retrato. NÃO fala com a Steam — é o que o
//          painel chama a cada atualização de tela
//    POST  pergunta AGORA. Leva ~4 s e disputa o lock do
//          SteamCMD, então não serve para polling
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ServerSupervisor } from '../../servers/supervisor.js';
import type { SteamUpdateState, SteamUpdateWatcher } from '../../steam/update-watcher.js';
import { ApiError } from '../error-response.js';

export interface SteamUpdateRoutesDeps {
  readonly watcher: SteamUpdateWatcher;
  readonly supervisor: ServerSupervisor;
}

const params = z.object({ id: z.string().min(1) });

/** Datas em ISO na borda; o estado guarda epoch. */
function body(state: SteamUpdateState) {
  return {
    ok: true,
    ...state,
    checkedAt: state.checkedAt === null ? null : new Date(state.checkedAt).toISOString(),
  };
}

export function registerSteamUpdateRoutes(app: FastifyInstance, deps: SteamUpdateRoutesDeps): void {
  app.get('/servers/:id/steam-update', async (request) => {
    const { id } = params.parse(request.params);

    if (deps.supervisor.configOf(id) === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    return body(deps.watcher.stateOf(id));
  });

  app.post('/servers/:id/steam-update/check', async (request) => {
    const { id } = params.parse(request.params);

    if (deps.supervisor.configOf(id) === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    return body(await deps.watcher.check(id));
  });
}
