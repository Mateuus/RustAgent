// ============================================================
//  server.ts  -  a montagem do Fastify.
//
//  Ordem que importa:
//
//    1. cookie          (o guarda lê request.cookies)
//    2. /health         sem autenticação
//    3. /auth/*         sem o guarda — é por aqui que a sessão nasce
//    4. /api/*          COM o guarda
//    5. painel estático (fallback, por último)
//
//  O painel entra por último de propósito: ele responde a
//  QUALQUER caminho não casado, e registrado antes engoliria as
//  rotas de API que viessem depois.
// ============================================================

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { OperatorAuth } from '../auth/operator.js';
import type { BanList } from '../bans/service.js';
import type { AgentConfig } from '../config.js';
import type { ServersRepository } from '../db/servers-repository.js';
import type { MonumentReader } from '../game/monuments.js';
import type { PlayersReader } from '../game/players.js';
import type { Logger } from '../logger.js';
import type { OperationStore } from '../ops/operations.js';
import type { PluginLibrary } from '../oxide/library.js';
import type { PlayerDirectory } from '../players/service.js';
import type { ServerSupervisor } from '../servers/supervisor.js';
import type { SteamUpdateWatcher } from '../steam/update-watcher.js';
import { createAuthGuard } from './auth.js';
import {
  apiErrorToResponse,
  internalErrorResponse,
  isApiError,
  zodErrorToResponse,
} from './error-response.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBanRoutes } from './routes/bans.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerHealthRoutes, type HealthServerView } from './routes/health.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerOxideRoutes } from './routes/oxide.js';
import { registerPlayerRoutes } from './routes/players.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerSteamUpdateRoutes } from './routes/steam-updates.js';
import { registerSystemRoutes } from './routes/system.js';

export interface BuildServerOptions {
  readonly config: AgentConfig;
  readonly logger: Logger;
  readonly operators: OperatorAuth;
  readonly version: string;
  readonly startedAt: number;
  readonly servers: () => readonly HealthServerView[];
  readonly supervisor: ServerSupervisor;
  readonly repository: ServersRepository;
  readonly operations: OperationStore;
  readonly steamWatcher: SteamUpdateWatcher;
  /** A biblioteca de plugins do agente. Ver oxide/library.ts. */
  readonly library: PluginLibrary;
  /** A lista de banidos, global. Ver bans/service.ts. */
  readonly bans: BanList;
  /** Quem está online, com ou sem plugin. Ver game/players.ts. */
  readonly players: PlayersReader;
  /**
   * A base de jogadores da REDE. Ver players/service.ts.
   *
   * Repare que ela e o `players` acima respondem a perguntas
   * diferentes: aquele é quem está conectado AGORA naquele
   * servidor, lido do RCON; este é todo mundo que já jogou, lido
   * do banco. Os dois convivem porque as duas telas existem.
   */
  readonly directory: PlayerDirectory;
  /** Os monumentos do mundo. Ver game/monuments.ts. */
  readonly monuments: MonumentReader;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    // O `as FastifyBaseLogger` mantém a instância no tipo PADRÃO
    // do Fastify. Sem ele, todo o app fica parametrizado com o
    // tipo do pino, e cada função que recebe `FastifyInstance`
    // (as de rota) deixa de casar — por um campo (`msgPrefix`)
    // que ninguém aqui usa.
    loggerInstance: options.logger as FastifyBaseLogger,
    // O painel manda JSON pequeno; o upload de plugin vem por
    // multipart e tem limite próprio. 1 MB aqui é folga para o
    // maior corpo que uma rota de configuração produz.
    bodyLimit: 1_048_576,
    // Confia no `X-Forwarded-For` só quando alguém pôs um proxy
    // na frente — e quem faz isso é quem expôs a API.
    trustProxy: options.config.host !== '127.0.0.1',
  });

  void app.register(cookie);

  // O upload de plugin. O teto de 256 KB é do próprio plugin
  // (oxide/plugins.ts); aqui ele é repetido porque o multipart
  // precisa recusar ANTES de ler o corpo inteiro na memória.
  void app.register(multipart, { limits: { fileSize: 256 * 1024, files: 1 } });

  // ---- o error handler: uma forma de erro para a API toda ----
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    // Corpo malformado, método não permitido e afins já vêm com
    // statusCode do próprio Fastify. Só o que não tem status é
    // erro nosso — e desses o detalhe fica no log.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        ok: false,
        error: error.code ?? 'BAD_REQUEST',
        message: error.message,
      });
    }

    request.log.error({ err: error }, 'erro não tratado numa rota');

    const response = internalErrorResponse();
    return reply.status(response.statusCode).send(response.body);
  });

  registerHealthRoutes(app, {
    version: options.version,
    startedAt: options.startedAt,
    servers: options.servers,
  });

  registerAuthRoutes(app, options.operators);

  const requireAuth = createAuthGuard({
    apiToken: options.config.apiToken,
    operators: options.operators,
  });

  // Tudo que vier de `/api` passa pelo guarda. Registrar rota de
  // API fora deste escopo é o jeito de esquecer a autenticação —
  // por isso as rotas recebem a instância `api`, e não a raiz.
  void app.register(
    async (api) => {
      api.addHook('preHandler', requireAuth);

      registerSystemRoutes(api, {
        paths: options.config.paths,
        supervisor: options.supervisor,
        version: options.version,
        startedAt: options.startedAt,
      });

      registerServerRoutes(api, {
        paths: options.config.paths,
        repository: options.repository,
        supervisor: options.supervisor,
      });

      // As rotas de operação só existem com OPS_ENABLED=1. Com 0
      // elas nem são registradas — respondem 404, e não 403: quem
      // desligou não quer nem anunciar que elas existiriam.
      if (options.config.ops.enabled) {
        registerOperationRoutes(api, {
          store: options.operations,
          supervisor: options.supervisor,
        });
      }

      registerConsoleRoutes(api, { supervisor: options.supervisor });

      registerPluginRoutes(api, { library: options.library });

      // Os grupos e as permissões do Oxide. Eles moram DENTRO do
      // servidor (protobuf reescrito por ele), então tudo aqui
      // passa pelo console — nada de editar arquivo.
      registerOxideRoutes(api, { supervisor: options.supervisor });

      registerSteamUpdateRoutes(api, {
        watcher: options.steamWatcher,
        supervisor: options.supervisor,
      });

      registerAdminRoutes(api, {
        supervisor: options.supervisor,
        players: options.players,
        monuments: options.monuments,
        // Expulsar e teleportar passam a deixar rastro na ficha do
        // jogador, e não só no log do processo.
        history: options.directory,
      });

      registerBanRoutes(api, { bans: options.bans, supervisor: options.supervisor });

      // A base de jogadores da rede. Vem DEPOIS das rotas de
      // servidor porque é o caminho `/players` da raiz — o
      // `/servers/:id/players`, que é outra coisa, já foi
      // registrado por `registerAdminRoutes`.
      registerPlayerRoutes(api, { directory: options.directory });
    },
    { prefix: '/api' },
  );

  // ---- o painel ----
  const panelDir = join(options.config.paths.root, 'panel', 'out');

  if (existsSync(panelDir)) {
    void app.register(staticFiles, { root: panelDir, index: ['index.html'] });

    // O export do Next gera uma pasta por rota (`trailingSlash`),
    // então o @fastify/static resolve sozinho. O que sobra é a
    // URL desconhecida: ela recebe o index, e o roteador do Next
    // decide o que mostrar.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/auth')) {
        return reply.status(404).send({
          ok: false,
          error: 'NOT_FOUND',
          message: `Rota não encontrada: ${request.method} ${request.url}`,
        });
      }

      return reply.sendFile('index.html');
    });
  } else {
    options.logger.warn(
      { panelDir },
      'painel não compilado (panel/out ausente) — a API responde, a tela não. ' +
        'Rode "npm run build -w panel".',
    );
  }

  return app;
}
