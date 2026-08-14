// ============================================================
//  errors.ts  -  erros do transporte RCON.
//
//  Cada um tem um "code" estável: a camada HTTP decide o status
//  a partir do code, nunca a partir do texto da mensagem.
// ============================================================

export type RconErrorCode =
  | 'RCON_NOT_CONNECTED'
  | 'RCON_TIMEOUT'
  | 'RCON_DISCONNECTED'
  | 'RCON_CLOSED'
  | 'RCON_SEND_FAILED'
  | 'RCON_INVALID_COMMAND';

export class RconError extends Error {
  readonly code: RconErrorCode;

  constructor(code: RconErrorCode, message: string) {
    super(message);
    this.name = 'RconError';
    this.code = code;
  }
}

/** Não há conexão no momento (o servidor caiu, ou ainda subindo). */
export class RconNotConnectedError extends RconError {
  constructor() {
    super('RCON_NOT_CONNECTED', 'RCON is not connected');
  }
}

/** O comando foi enviado, mas ninguém respondeu a tempo. */
export class RconTimeoutError extends RconError {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super('RCON_TIMEOUT', `RCON command timed out after ${timeoutMs}ms: ${command}`);
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/** A conexão caiu enquanto o comando estava no ar. */
export class RconDisconnectedError extends RconError {
  constructor() {
    super('RCON_DISCONNECTED', 'RCON connection was lost before the command completed');
  }
}

/** O cliente foi encerrado (shutdown do processo). */
export class RconClosedError extends RconError {
  constructor() {
    super('RCON_CLOSED', 'RCON client has been closed');
  }
}
