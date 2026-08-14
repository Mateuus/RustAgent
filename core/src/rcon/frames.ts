// ============================================================
//  frames.ts  -  o protocolo do WebRCON: serializar, parsear e
//  decidir se um frame recebido é a resposta de um comando.
//
//  Com `rcon.web 1` o Rust expõe o RCON como WebSocket em
//  ws://HOST:PORTA/SENHA, trocando frames JSON nos dois sentidos.
//
//  Nós -> servidor:
//      { "Identifier": 42, "Message": "players", "Name": "WebRcon" }
//
//  Servidor -> nós:
//      { "Message": "...", "Identifier": 42, "Type": "Generic",
//        "Stacktrace": "" }
// ============================================================

import { z } from 'zod';

/**
 * Vai no campo "Name" de todo frame enviado. O servidor usa isso
 * só para rotular a origem no log dele. "WebRcon" é o valor que
 * o console web oficial manda, e é o mesmo que
 * Tools\ReloadPlugin.ps1 já usa neste repositório.
 */
export const RCON_SENDER_NAME = 'WebRcon';

export interface RconIncomingFrame {
  readonly identifier: number;
  readonly message: string;
  readonly type: string;
  readonly stacktrace: string;
  /**
   * true = o frame não era o JSON esperado e `message` carrega o
   * texto cru. Acontece com algumas linhas de console e com
   * versões/mods que escrevem texto puro no socket.
   */
  readonly raw: boolean;
}

// ------------------------------------------------------------
//  Schema propositalmente FROUXO.
//
//  Aqui é a borda do transporte: um frame estranho não pode
//  derrubar a conexão. Campo faltando vira padrão, e a validação
//  séria (a do contrato com o plugin) acontece depois, em
//  game/plugin-bridge.ts, em cima do conteúdo de `message`.
// ------------------------------------------------------------
const incomingFrameSchema = z.object({
  Identifier: z.number().int().optional(),
  Message: z.unknown().optional(),
  Type: z.string().optional(),
  Stacktrace: z.string().optional(),
});

/** Serializa um comando no formato que o servidor espera. */
export function encodeCommandFrame(identifier: number, command: string): string {
  return JSON.stringify({
    Identifier: identifier,
    Message: command,
    Name: RCON_SENDER_NAME,
  });
}

/**
 * Lê um frame recebido. NUNCA lança: qualquer entrada vira um
 * frame válido, no pior caso um `raw`.
 */
export function parseIncomingFrame(text: string): RconIncomingFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rawFrame(text);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rawFrame(text);
  }

  const result = incomingFrameSchema.safeParse(parsed);
  if (!result.success) {
    return rawFrame(text);
  }

  const { Identifier, Message, Type, Stacktrace } = result.data;

  return {
    identifier: Identifier ?? UNSOLICITED_IDENTIFIER,
    message: typeof Message === 'string' ? Message : String(Message ?? ''),
    type: Type ?? 'Generic',
    stacktrace: Stacktrace ?? '',
    raw: false,
  };
}

function rawFrame(text: string): RconIncomingFrame {
  return {
    identifier: UNSOLICITED_IDENTIFIER,
    message: text,
    type: 'Raw',
    stacktrace: '',
    raw: true,
  };
}

/**
 * Identificador usado para frames que o servidor manda por
 * conta própria. O Rust usa 0; algumas builds/plugins usam -1.
 * Por isso o teste é `<= 0`, não `=== 0`.
 */
export const UNSOLICITED_IDENTIFIER = 0;

/**
 * Identificadores que NÓS geramos começam em 1 e só crescem.
 * O zero fica reservado ao servidor, o que torna
 * "identifier > 0" um teste confiável de "isto é resposta a algo
 * que eu pedi".
 */
export const FIRST_REQUEST_IDENTIFIER = 1;

/**
 * Teto antes de dar a volta. Bem abaixo de 2^31 para caber num
 * int32 do lado do servidor com folga.
 */
export const MAX_REQUEST_IDENTIFIER = 2_000_000_000;

export function nextRequestIdentifier(current: number): number {
  return current >= MAX_REQUEST_IDENTIFIER ? FIRST_REQUEST_IDENTIFIER : current + 1;
}

/** Um frame originado pelo servidor, não resposta a comando. */
export function isUnsolicitedIdentifier(identifier: number): boolean {
  return identifier <= UNSOLICITED_IDENTIFIER;
}

/**
 * Tipos de frame que são saída de diagnóstico, não resposta.
 *
 * O Rust marca no campo Type de onde a linha veio. `Warning` e
 * `Error` são o que sai de PrintWarning/PrintError de um plugin —
 * inclusive de dentro do comando que estamos esperando responder,
 * e nesse caso com o MESMO Identifier do pedido.
 *
 * Tratamos essas linhas como log. O preço é conhecido e aceito: um
 * comando cuja única saída seja um Warning termina em timeout em
 * vez de devolver o texto do aviso. Vale, porque a alternativa é
 * pior — entregar o aviso como se fosse a resposta faz uma chamada
 * bem-sucedida virar erro de contrato.
 */
export function isDiagnosticType(type: string): boolean {
  return type === 'Warning' || type === 'Error';
}

// ============================================================
//  ####  CORRELAÇÃO REQUISIÇÃO <-> RESPOSTA  ####
//
//  #### PONTO DE INCERTEZA — LEIA ANTES DE MEXER ####
//
//  Toda a decisão de "este frame é a resposta do comando que
//  mandei?" está NESTA função, de propósito. Se o servidor real
//  se comportar diferente do previsto, o conserto é aqui e só
//  aqui — nenhuma outra parte do código olha Identifier.
//
//  O QUE ASSUMIMOS (estratégia 'identifier', padrão):
//      o servidor devolve, no campo Identifier da resposta, o
//      mesmo número que mandamos. Frames espontâneos (log do
//      servidor, saída de Puts() de plugin, chat) chegam com
//      Identifier 0 ou negativo.
//
//  Isso bate com o console web oficial do Rust e com o
//  comportamento observado por Tools\ReloadPlugin.ps1. NÃO foi
//  verificado contra o servidor deste projeto rodando — não
//  houve servidor disponível durante a implementação.
//
//  SE FALHAR NO SERVIDOR REAL, o sintoma é claro e específico:
//  todo comando estoura RCON_TIMEOUT enquanto os eventos `log`
//  mostram a resposta certa chegando com Identifier 0. Nesse
//  caso troque a estratégia para 'in-flight' (uma linha, em
//  RconClient) e o problema some.
//
//  A estratégia 'in-flight' funciona porque o RconClient
//  serializa os comandos: existe no máximo UM comando no ar por
//  vez, então o primeiro frame que chegar depois do envio só
//  pode ser a resposta dele. O preço é real e é este: uma linha
//  de log do servidor que caia na janela entre o envio e a
//  resposta é confundida com a resposta. Por isso ela não é o
//  padrão.
// ============================================================

export type CorrelationStrategy =
  /** Casa pelo Identifier ecoado. Preciso; é o padrão. */
  | 'identifier'
  /** Casa o primeiro frame que chegar com o comando no ar. */
  | 'in-flight';

export const DEFAULT_CORRELATION_STRATEGY: CorrelationStrategy = 'identifier';

export interface InFlightCommand {
  readonly identifier: number;
}

/**
 * Decide se `frame` responde ao comando em voo.
 *
 * @returns o Identifier casado, ou null se o frame for
 *   espontâneo (e portanto deva virar evento `log`).
 */
export function matchPendingIdentifier(
  frame: RconIncomingFrame,
  inFlight: InFlightCommand | null,
  strategy: CorrelationStrategy = DEFAULT_CORRELATION_STRATEGY,
): number | null {
  // Sem comando no ar, tudo que chega é espontâneo.
  if (inFlight === null) {
    return null;
  }

  // Diagnóstico NUNCA é resposta, mesmo com o Identifier certo.
  //
  // Isto foi medido no servidor real. `origemz.give` recusando uma
  // entrega devolve DOIS frames, os dois com o Identifier do
  // pedido:
  //
  //   Identifier=42  Type=Warning  [OrigemZAgent] recusado: ...
  //   Identifier=42  Type=Generic  {"ok":false,"error":"TOO_MANY_STACKS"}
  //
  // Ou seja: PrintWarning/PrintError de dentro de um comando de
  // console herdam o Identifier de quem chamou. Casar pelo
  // Identifier sozinho entregava o AVISO como resposta, e o JSON
  // de verdade era descartado — a API respondia
  // PLUGIN_INVALID_RESPONSE numa chamada que funcionou.
  //
  // O Type é o que separa os dois, e o console web oficial do Rust
  // usa o mesmo campo para decidir a cor da linha.
  if (isDiagnosticType(frame.type)) {
    return null;
  }

  if (strategy === 'identifier') {
    return frame.identifier === inFlight.identifier ? inFlight.identifier : null;
  }

  // 'in-flight': aceita o eco correto E também o frame
  // espontâneo, assumindo que ele é a resposta atrasada.
  if (frame.identifier === inFlight.identifier || isUnsolicitedIdentifier(frame.identifier)) {
    return inFlight.identifier;
  }

  return null;
}
