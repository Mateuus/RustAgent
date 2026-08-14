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
import staticFiles from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { OperatorAuth } from '../auth/operator.js';
import type { AgentConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createAuthGuard } from './auth.js';
import {
  apiErrorToResponse,
  internalErrorResponse,
  isApiError,
  zodErrorToResponse,
} from './error-response.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes, type HealthServerView } from './routes/health.js';

export interface BuildServerOptions {
  readonly config: AgentConfig;
  readonly logger: Logger;
  readonly operators: OperatorAuth;
  readonly version: string;
  readonly startedAt: number;
  readonly servers: () => readonly HealthServerView[];
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

      // As rotas da Fase 1 entram aqui conforme cada etapa fecha:
      //   registerServerRoutes(api, deps)
      //   registerOperationRoutes(api, deps)
      //   registerPluginRoutes(api, deps)
      api.get('/servers', async () => ({ ok: true, servers: [] }));
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
