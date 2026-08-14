// ============================================================
//  routes/auth.ts  -  entrar, sair, e "quem sou eu".
//
//  Estas três NÃO passam pelo guarda de /api/*: é por elas que se
//  obtém a sessão que o guarda exige.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { csrfTokenFor } from '../../auth/csrf.js';
import { SESSION_COOKIE, type OperatorAuth } from '../../auth/operator.js';
import { zodErrorToResponse } from '../error-response.js';

const loginSchema = z
  .object({
    user: z.string().min(1, 'informe o usuário'),
    password: z.string().min(1, 'informe a senha'),
  })
  .strict();

export function registerAuthRoutes(app: FastifyInstance, operators: OperatorAuth): void {
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      const response = zodErrorToResponse(parsed.error);
      return reply.status(response.statusCode).send(response.body);
    }

    if (!operators.configured) {
      return reply.status(503).send({
        ok: false,
        error: 'PANEL_NOT_CONFIGURED',
        message:
          'O painel não tem senha configurada. Gere uma com "npm run panel:senha -w core" ' +
          'e ponha o resultado em PANEL_PASSWORD_HASH, no .env.',
      });
    }

    const session = await operators.login(parsed.data.user, parsed.data.password);

    if (session === null) {
      // Uma frase só para os dois casos: dizer que o usuário não
      // existe é entregar metade da credencial.
      return reply.status(401).send({
        ok: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Usuário ou senha inválidos.',
      });
    }

    void reply.setCookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // `secure` fica de fora: o agente fala HTTP puro, e um
      // cookie `secure` simplesmente não seria enviado. Quem
      // expuser o painel põe TLS num proxy à frente — e aí este
      // campo passa a valer a pena.
    });

    return {
      ok: true,
      user: session.user,
      csrfToken: csrfTokenFor(session.csrfToken),
      startedAt: new Date(session.createdAt).toISOString(),
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    operators.logout(request.cookies[SESSION_COOKIE]);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });

    return { ok: true };
  });

  app.get('/auth/session', async (request, reply) => {
    const session = operators.touch(request.cookies[SESSION_COOKIE]);

    if (session === null) {
      return reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Sessão ausente ou expirada.',
      });
    }

    return {
      ok: true,
      user: session.user,
      csrfToken: csrfTokenFor(session.csrfToken),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    };
  });
}
