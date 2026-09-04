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

import { RconError, RconTimeoutError } from '../rcon/errors.js';

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

/**
 * Falha do TRANSPORTE RCON -> resposta com nome e explicação.
 *
 * ####  POR QUE ISTO PRECISA EXISTIR  ####
 *
 * `errors.ts` promete que "a camada HTTP decide o status a partir
 * do code". Ela não decidia: um `RconError` não é `ApiError`, caía
 * no 500 genérico e a tela mostrava "Erro interno no agente. Veja
 * o log do processo" — a frase que manda procurar em outro lugar
 * o que o agente já sabia.
 *
 * Em 04/09/2026 isso custou caro: o OrigemZAgent parou de compilar
 * depois de um update do Rust, o `origemz.players` passou a não
 * responder, e a aba Jogadores dizia "erro interno" no lugar de
 * "o servidor não respondeu a este comando".
 *
 * O timeout cita o COMANDO de propósito: o console do Rust não
 * reclama de comando que não conhece — ele se cala. Sem o nome do
 * comando na mensagem, "não respondeu" não leva a lugar nenhum.
 */
export function rconErrorToResponse(error: RconError): ApiErrorResponse {
  const message = ((): string => {
    switch (error.code) {
      case 'RCON_NOT_CONNECTED':
        return (
          'Sem conexão com o RCON deste servidor. Ele pode estar parado ou ainda subindo — o ' +
          'agente reconecta sozinho, com espera crescente.'
        );
      case 'RCON_DISCONNECTED':
        return (
          'A conexão com o RCON caiu enquanto o comando estava no ar. Não dá para saber se ele ' +
          'chegou a rodar; o agente já está reconectando.'
        );
      case 'RCON_CLOSED':
        return 'O agente está desligando e não manda mais comandos.';
      case 'RCON_TIMEOUT': {
        const timeout = error instanceof RconTimeoutError ? error : null;
        const comando = timeout === null ? 'o comando' : `\`${timeout.command}\``;
        const segundos = timeout === null ? '' : ` em ${String(timeout.timeoutMs / 1000)}s`;

        return (
          `O servidor não respondeu a ${comando}${segundos}. O console do Rust não reclama de ` +
          'comando que não conhece — ele apenas se cala. Se esse comando vem de um plugin, ' +
          'confira no console se ele está carregado: `oxide.plugins` mostra quem falhou ao ' +
          'compilar e quem ficou sem dependência.'
        );
      }
      case 'RCON_SEND_FAILED':
        return 'Não consegui mandar o comando pelo RCON. A conexão deve ter acabado de cair.';
      case 'RCON_INVALID_COMMAND':
        return 'Esse comando não pode ser mandado assim: ele está vazio ou tem mais de uma linha.';
    }
  })();

  const status = ((): number => {
    switch (error.code) {
      case 'RCON_TIMEOUT':
        return 504;
      case 'RCON_SEND_FAILED':
        return 502;
      case 'RCON_INVALID_COMMAND':
        return 400;
      default:
        return 503;
    }
  })();

  return { statusCode: status, body: { ok: false, error: error.code, message } };
}

export function isRconError(error: unknown): error is RconError {
  return error instanceof RconError;
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
