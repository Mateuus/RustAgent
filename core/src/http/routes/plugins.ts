// ============================================================
//  routes/plugins.ts  -  a tela que instala plugin.
//
//  É o que a Fase 1 entrega do lado dos plugins: o agente não
//  conhece nenhum deles, mas sabe instalar qualquer `.cs` em
//  qualquer servidor e pedir ao Oxide que recarregue (ver
//  Docs\03-DECISOES.md, D6).
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { disconnectedRcon, type OpsRcon } from '../../ops/service.js';
import {
  installPlugin,
  listPlugins,
  MAX_PLUGIN_BYTES,
  reloadPlugin,
  removePlugin,
} from '../../oxide/plugins.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';

export interface PluginRoutesDeps {
  readonly supervisor: ServerSupervisor;
}

const serverParams = z.object({ id: z.string().min(1) });
const pluginParams = z.object({ id: z.string().min(1), name: z.string().min(1) });

/**
 * A pasta de plugins e o RCON daquele servidor.
 *
 * Servidor DESLIGADO também responde: o arquivo pode ser
 * instalado com o jogo parado, e o Oxide o carrega no próximo
 * start. Recusar aqui obrigaria a ligar o servidor só para
 * preparar a pasta.
 */
function targetOf(deps: PluginRoutesDeps, id: string): { pluginsDir: string; rcon: OpsRcon } {
  const config = deps.supervisor.configOf(id);

  if (config === null) {
    throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}" neste agente.`, 404);
  }

  return {
    pluginsDir: config.paths.pluginsDir,
    rcon: deps.supervisor.contextOf(id)?.rcon ?? disconnectedRcon(id),
  };
}

export function registerPluginRoutes(app: FastifyInstance, deps: PluginRoutesDeps): void {
  app.get('/servers/:id/plugins', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { pluginsDir } = targetOf(deps, id);

    return { ok: true, pluginsDir, plugins: await listPlugins(pluginsDir) };
  });

  // ---- enviar ---------------------------------------------
  app.post('/servers/:id/plugins', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { pluginsDir, rcon } = targetOf(deps, id);

    if (!request.isMultipart()) {
      throw new ApiError(
        'INVALID_BODY',
        'Mande o arquivo do plugin como multipart/form-data (campo "file").',
        400,
      );
    }

    const file = await request.file({ limits: { fileSize: MAX_PLUGIN_BYTES } });

    if (file === undefined) {
      throw new ApiError('INVALID_BODY', 'Nenhum arquivo veio na requisição.', 400);
    }

    const content = await file.toBuffer();

    const result = await installPlugin({
      pluginsDir,
      name: file.filename,
      content,
      rcon,
    });

    return {
      ok: true,
      ...result,
      // Gravar e carregar são coisas diferentes: `ok` é sobre o
      // arquivo, `reload.output` é sobre o Oxide ter aceitado.
      message: result.reload.sent
        ? 'Plugin enviado e recarregado. Veja em reload.output o que o Oxide respondeu.'
        : 'Plugin enviado. O servidor está parado — ele carrega no próximo start.',
    };
  });

  app.delete('/servers/:id/plugins/:name', async (request) => {
    const { id, name } = pluginParams.parse(request.params);
    const { pluginsDir, rcon } = targetOf(deps, id);

    const unload = await removePlugin(pluginsDir, name, rcon);

    return { ok: true, name, unload };
  });

  app.post('/servers/:id/plugins/:name/reload', async (request) => {
    const { id, name } = pluginParams.parse(request.params);
    const { rcon } = targetOf(deps, id);

    if (!name.toLowerCase().endsWith('.cs')) {
      throw new ApiError('INVALID_PLUGIN_NAME', 'O nome precisa terminar em .cs.', 400);
    }

    const reload = await reloadPlugin(rcon, name.slice(0, -3));

    if (!reload.sent && reload.output === null) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `O servidor "${id}" não está no ar — não há para quem mandar o oxide.reload.`,
        503,
      );
    }

    return { ok: true, name, reload };
  });
}
