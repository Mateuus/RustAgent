// ============================================================
//  socket.ts  -  a fronteira entre o RconClient e a biblioteca
//  de WebSocket.
//
//  O RconClient não conhece o pacote `ws`: ele fala com a
//  interface RconSocket abaixo. Isso existe por um motivo
//  prático — nos testes, o socket falso implementa esta mesma
//  interface, e a suíte inteira roda sem abrir uma conexão de
//  verdade. Testar reconexão e timeout contra um servidor real
//  seria lento e instável.
// ============================================================

import WebSocket from 'ws';

/** O mínimo que o RconClient precisa de um socket. */
export interface RconSocket {
  /** Envia texto. Pode lançar se o socket já tiver fechado. */
  send(data: string): void;
  /** Inicia o fechamento. */
  close(code?: number, reason?: string): void;
  /** Derruba na marra, sem handshake de fechamento. */
  terminate(): void;

  onOpen(handler: () => void): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

export type RconSocketFactory = (url: string) => RconSocket;

/**
 * Converte o payload do `ws` para texto.
 *
 * O `ws` entrega Buffer, Buffer[] ou ArrayBuffer dependendo de
 * como a mensagem chegou fragmentada. O RCON do Rust só manda
 * texto, então normalizamos tudo para string num lugar só.
 */
function rawDataToString(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return String(data);
}

/**
 * Implementação real, em cima do `ws`.
 *
 * Sobre autenticação: o WebRCON não tem frame de login. A senha
 * está no caminho da URL e o servidor valida no handshake HTTP.
 * Se ela estiver errada, o handshake é recusado e o socket vai
 * direto para 'error'/'close' — nunca chega a abrir. Ou seja,
 * receber 'open' já significa autenticado.
 */
export function createWebSocketAdapter(url: string): RconSocket {
  const socket = new WebSocket(url, {
    // O servidor de Rust não negocia subprotocolo nem
    // compressão; desligar evita um caminho de código a mais.
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });

  return {
    send(data: string): void {
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason);
    },
    terminate(): void {
      socket.terminate();
    },
    onOpen(handler: () => void): void {
      socket.on('open', handler);
    },
    onMessage(handler: (text: string) => void): void {
      socket.on('message', (data: unknown) => {
        handler(rawDataToString(data));
      });
    },
    onClose(handler: (code: number, reason: string) => void): void {
      socket.on('close', (code: number, reason: Buffer) => {
        handler(code, reason.toString('utf8'));
      });
    },
    onError(handler: (error: Error) => void): void {
      socket.on('error', handler);
    },
  };
}
