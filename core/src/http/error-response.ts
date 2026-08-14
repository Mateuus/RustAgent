// ============================================================
//  error-response.ts  -  o corpo de erro, um só para a API toda.
//
//      { "ok": false, "error": "CODIGO", "message": "…" }
//
//  `error` é o contrato — quem integra programa contra ele.
//  `message` é para humano, está em português e pode mudar sem
//  aviso. Ver Docs\06-API.md.
// ============================================================

import type { ZodError } from 'zod';

export interface ApiErrorBody {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
  /** Só na validação de entrada. */
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
}

export interface ApiErrorResponse {
  readonly statusCode: number;
  readonly body: ApiErrorBody;
}

/**
 * Erro de regra de negócio, com o status HTTP já escolhido.
 *
 * A mensagem nasce em quem CONHECE a regra — o módulo de
 * operações, o de criação de servidor — e a rota só a repassa.
 * Uma rota que reescreve a mensagem produz duas frases para o
 * mesmo problema: uma na API e outra no painel.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function apiErrorToResponse(error: ApiError): ApiErrorResponse {
  return {
    statusCode: error.status,
    body: { ok: false, error: error.code, message: error.message },
  };
}

/**
 * ZodError -> 400 com o caminho de cada campo.
 *
 * O `issues` existe para o painel poder apontar o campo errado no
 * formulário em vez de mostrar uma frase genérica no topo.
 */
export function zodErrorToResponse(error: ZodError, code = 'INVALID_BODY'): ApiErrorResponse {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  const message =
    issues.length === 0
      ? 'Os dados enviados não passaram na validação.'
      : issues
          .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
          .join('; ');

  return {
    statusCode: 400,
    body: { ok: false, error: code, message, issues },
  };
}

/** O 500 genérico. O detalhe fica no log, nunca na resposta. */
export function internalErrorResponse(): ApiErrorResponse {
  return {
    statusCode: 500,
    body: {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erro interno no agente. Veja o log do processo para o detalhe.',
    },
  };
}
