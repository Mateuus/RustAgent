// ============================================================
//  auth.ts  -  quem pode chamar /api/*.
//
//  Duas identidades, e elas são diferentes de propósito:
//
//    SESSÃO      o painel, num navegador. Cookie HttpOnly +
//                header de CSRF em toda mutação.
//    BEARER      uma integração (script, site, bot). Sem cookie,
//                logo sem CSRF — não há navegador para enganar.
//
//  Ver Docs\06-API.md.
// ============================================================

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { CSRF_HEADER, csrfTokenMatches, isMutation } from '../auth/csrf.js';
import { SESSION_COOKIE, type OperatorAuth, type OperatorSession } from '../auth/operator.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo `requireAuth`. */
    operator?: OperatorSession | undefined;
    /** `true` quando quem chamou usou o token, e não a sessão. */
    viaToken?: boolean | undefined;
  }
}

/**
 * Compara dois segredos em tempo constante.
 *
 * O SHA-256 no meio existe para os dois lados terem o MESMO
 * tamanho: `timingSafeEqual` estoura com buffers de tamanhos
 * diferentes, e o tamanho do que chegou já seria uma informação
 * sobre o token.
 */
function secretsMatch(received: string, expected: string): boolean {
  if (expected === '') {
    return false;
  }

  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();

  return timingSafeEqual(a, b);
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;

  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  return match?.[1]?.trim() ?? null;
}

export interface AuthGuardOptions {
  readonly apiToken: string;
  readonly operators: OperatorAuth;
}

/**
 * O `preHandler` de `/api/*`.
 *
 * Falha é sempre 401 com o mesmo corpo, sem distinguir "faltou
 * header" de "token errado": a diferença ensina quem está
 * tentando adivinhar.
 */
export function createAuthGuard(options: AuthGuardOptions) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearerOf(request);

    if (token !== null && secretsMatch(token, options.apiToken)) {
      request.viaToken = true;
      return;
    }

    const session = options.operators.touch(request.cookies[SESSION_COOKIE]);

    if (session === null) {
      await reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message:
          'Autenticação necessária: entre no painel, ou mande o header ' +
          'Authorization: Bearer <AGENT_API_TOKEN>.',
      });
      return;
    }

    // O CSRF vale só para a SESSÃO. Um bearer não vem de um
    // navegador com cookie, então não há requisição forjada a
    // impedir — exigir o header ali só quebraria integração.
    if (
      isMutation(request.method) &&
      !csrfTokenMatches(session.csrfToken, request.headers[CSRF_HEADER])
    ) {
      await reply.status(403).send({
        ok: false,
        error: 'CSRF_INVALID',
        message:
          `Falta o header ${CSRF_HEADER} (ou ele não bate com a sessão). ` +
          'Ele é devolvido no login e precisa acompanhar todo POST, PATCH e DELETE.',
      });
      return;
    }

    request.operator = session;
  };
}
