// ============================================================
//  client.ts  -  cliente WebRCON persistente.
//
//  Responsabilidades:
//    - manter UMA conexão de pé, reconectando sozinho com
//      backoff exponencial quando o servidor de Rust reinicia;
//    - transformar `send(comando)` numa Promise que resolve com
//      o texto da resposta, com timeout;
//    - separar resposta de comando (casada por Identifier) de
//      log espontâneo do servidor (evento `log`).
//
//  O que ele NÃO faz: entender o conteúdo. Interpretar JSON de
//  plugin é trabalho de game/.
// ============================================================

import type { Logger } from 'pino';

import { toError } from '../util.js';
import {
  RconClosedError,
  RconDisconnectedError,
  RconError,
  RconNotConnectedError,
  RconTimeoutError,
} from './errors.js';
import {
  DEFAULT_CORRELATION_STRATEGY,
  encodeCommandFrame,
  FIRST_REQUEST_IDENTIFIER,
  matchPendingIdentifier,
  nextRequestIdentifier,
  parseIncomingFrame,
  type CorrelationStrategy,
} from './frames.js';
import { createWebSocketAdapter, type RconSocket, type RconSocketFactory } from './socket.js';
import { TypedEmitter } from './typed-emitter.js';
import { buildRconUrl, describeRconTarget, maskRconUrl } from './url.js';

// ------------------------------------------------------------
//  Backoff
// ------------------------------------------------------------

export interface BackoffOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  /** Variação aleatória aplicada ao atraso, de 0 a 1. */
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
};

/**
 * Atraso da tentativa `attempt` (base 0): 1s, 2s, 4s, 8s, 16s,
 * 30s, 30s, ... mais um jitter de ±20%.
 *
 * O teto importa: sem ele, depois de algumas horas de servidor
 * fora do ar o intervalo chegaria a horas, e o agente demoraria
 * para perceber que o Rust voltou.
 *
 * O jitter também: quando o servidor reinicia, ele e todos os
 * clientes voltam ao mesmo tempo. Espalhar as tentativas evita
 * que o agente bata na porta exatamente no instante mais
 * ocupado do boot, repetidamente.
 *
 * `random` é injetável só para o teste ser determinístico.
 */
export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = options.initialDelayMs * Math.pow(options.factor, Math.max(0, attempt));
  const capped = Math.min(exponential, options.maxDelayMs);
  const jitter = capped * options.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

// ------------------------------------------------------------
//  Eventos
// ------------------------------------------------------------

/** Linha vinda do servidor que não responde a nenhum comando. */
export interface RconLogEntry {
  readonly identifier: number;
  readonly message: string;
  readonly type: string;
  readonly stacktrace: string;
  readonly receivedAt: number;
}

export interface RconDisconnectInfo {
  readonly code: number;
  readonly reason: string;
  /** false = a conexão nem chegou a abrir (tentativa falhou). */
  readonly wasConnected: boolean;
}

/**
 * Precisa ser `type`, não `interface`: só um type alias satisfaz
 * a restrição `Record<string, unknown[]>` do TypedEmitter
 * (interfaces não ganham index signature implícita).
 */
export type RconClientEvents = {
  connected: [];
  disconnected: [RconDisconnectInfo];
  log: [RconLogEntry];
  error: [Error];
};

export type RconConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface RconClientStatus {
  readonly state: RconConnectionState;
  readonly connected: boolean;
  readonly target: string;
  /** Comandos em voo + enfileirados. Deve voltar a 0 sempre. */
  readonly pendingCommands: number;
  readonly reconnectAttempts: number;
  readonly lastConnectedAt: number | null;
  readonly lastDisconnectedAt: number | null;
}

export interface RconClientOptions {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly commandTimeoutMs?: number;
  readonly backoff?: Partial<BackoffOptions>;
  readonly correlationStrategy?: CorrelationStrategy;
  readonly logger?: Logger;
  /** Trocado nos testes pelo socket falso. */
  readonly socketFactory?: RconSocketFactory;
  /** Injetável para tornar o jitter determinístico no teste. */
  readonly random?: () => number;
}

interface QueuedCommand {
  readonly command: string;
  readonly resolve: (response: string) => void;
  readonly reject: (error: Error) => void;
  /**
   * Falso = a resposta não interessa, e a Promise resolve assim
   * que o frame sai pelo socket.
   *
   * ####  POR QUE ISTO PRECISA EXISTIR  ####
   *
   * Comandos como `say` e `server.save` respondem — com corpo
   * VAZIO, e em tempo que depende do que o servidor está fazendo.
   * Logo depois de um boot, com o mundo ainda carregando, essa
   * resposta passa dos cinco segundos do timeout.
   *
   * O desfecho é enganoso: a mensagem CHEGOU no chat e o agente
   * registra "falhou". Aconteceu nesta máquina, no aviso de "o
   * servidor voltou" logo após a primeira atualização automática.
   *
   * Numa contagem regressiva com oito avisos, o preço é pior: até
   * 40 segundos de espera acumulada, empurrando cada aviso para
   * longe do instante que ele anuncia — "faltam 30 segundos"
   * dito com 25 restando.
   *
   * Para um aviso, o que importa é o comando SAIR. É isto que
   * este campo expressa.
   */
  readonly expectsReply: boolean;
}

interface InFlightRequest extends QueuedCommand {
  readonly identifier: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ------------------------------------------------------------

export class RconClient extends TypedEmitter<RconClientEvents> {
  readonly #host: string;
  readonly #port: number;
  readonly #password: string;
  readonly #commandTimeoutMs: number;
  readonly #backoff: BackoffOptions;
  readonly #correlationStrategy: CorrelationStrategy;
  readonly #socketFactory: RconSocketFactory;
  readonly #random: () => number;
  readonly #logger: Logger | undefined;

  #socket: RconSocket | null = null;
  #state: RconConnectionState = 'idle';
  #queue: QueuedCommand[] = [];
  #inFlight: InFlightRequest | null = null;
  #identifier = FIRST_REQUEST_IDENTIFIER - 1;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #lastConnectedAt: number | null = null;
  #lastDisconnectedAt: number | null = null;

  constructor(options: RconClientOptions) {
    super();

    this.#host = options.host;
    this.#port = options.port;
    this.#password = options.password;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#correlationStrategy = options.correlationStrategy ?? DEFAULT_CORRELATION_STRATEGY;
    this.#socketFactory = options.socketFactory ?? createWebSocketAdapter;
    this.#random = options.random ?? Math.random;
    this.#logger = options.logger;

    // Só agora, com o logger já atribuído, dá para instalar o
    // hook de erro de listener (ver TypedEmitter).
    this.onListenerError = (error, event): void => {
      this.#logger?.error(
        { err: toError(error), event },
        'rcon event listener threw; continuing',
      );
    };
  }

  get state(): RconConnectionState {
    return this.#state;
  }

  get isConnected(): boolean {
    return this.#state === 'connected' && this.#socket !== null;
  }

  /** Em voo + fila. Usado no /health e nos testes de vazamento. */
  get pendingCommands(): number {
    return (this.#inFlight === null ? 0 : 1) + this.#queue.length;
  }

  get target(): string {
    return describeRconTarget(this.#host, this.#port);
  }

  getStatus(): RconClientStatus {
    return {
      state: this.#state,
      connected: this.isConnected,
      target: this.target,
      pendingCommands: this.pendingCommands,
      reconnectAttempts: this.#reconnectAttempts,
      lastConnectedAt: this.#lastConnectedAt,
      lastDisconnectedAt: this.#lastDisconnectedAt,
    };
  }

  /**
   * Começa a conectar e assume a responsabilidade de continuar
   * tentando. Não devolve Promise de propósito: o serviço sobe
   * mesmo com o servidor de Rust fora do ar — /health passa a
   * dizer connected:false e o agente reconecta quando puder.
   * Amarrar o boot do processo à disponibilidade do jogo faria o
   * PM2 entrar em loop de restart durante um wipe.
   */
  connect(): void {
    if (this.#closed) {
      throw new RconClosedError();
    }
    // Idempotente: chamar connect() de novo enquanto já há uma
    // conexão de pé, uma tentativa em curso, ou uma reconexão
    // agendada não pode abrir um segundo socket — seriam duas
    // conexões WebRCON, que é exatamente o que este serviço
    // existe para não ter.
    if (
      this.#state === 'connecting' ||
      this.#state === 'connected' ||
      this.#reconnectTimer !== null
    ) {
      return;
    }
    this.#openSocket();
  }

  /**
   * Executa um comando e resolve com o texto bruto da resposta.
   *
   * Rejeita NA HORA se não houver conexão, em vez de enfileirar
   * para quando voltar. Isso é deliberado num serviço de
   * entrega: uma fila que sobrevive à reconexão poderia executar
   * um `origemz.give` trinta segundos depois: tempo de sobra
   * para o site já ter recebido o erro, marcado a compra como
   * falha e reembolsado — e aí o item chega assim mesmo.
   * Falhar rápido e deixar o retry (com Idempotency-Key) para o
   * chamador é mais seguro que entregar tarde.
   */
  send(command: string): Promise<string> {
    return this.#enqueue(command, true);
  }

  /**
   * Executa um comando cuja RESPOSTA não interessa.
   *
   * Resolve assim que o frame sai pelo socket. `say`,
   * `server.save` e os comandos de console que apenas AGEM caem
   * aqui: eles respondem vazio, e o único conteúdo dessa resposta
   * é o instante em que ela chega.
   *
   * ####  ISTO NÃO É "IGNORAR O ERRO"  ####
   *
   * A rejeição continua acontecendo pelos motivos que valem: sem
   * conexão, comando vazio, comando com quebra de linha, falha do
   * socket ao enviar. O que some é a espera — e, com ela, o
   * timeout que transformava um aviso ENTREGUE em falha
   * registrada quando o servidor estava ocupado.
   *
   * O preço é honesto: não se sabe se o servidor processou o
   * comando, só que ele foi enviado. Para um aviso no chat, é a
   * garantia certa; para uma entrega de item, não seria — e por
   * isso `send()` continua sendo o caminho padrão.
   */
  async sendWithoutReply(command: string): Promise<void> {
    await this.#enqueue(command, false);
  }

  /**
   * O corpo comum de `send` e `sendWithoutReply`.
   *
   * As validações são as MESMAS de propósito: a barreira contra
   * "\n" no meio do comando — que viraria DOIS comandos no
   * console do servidor, e que existe porque parte do comando é
   * montada com dados vindos da API (shortname, steamId) — não
   * pode depender de qual dos dois métodos o chamador usou.
   */
  #enqueue(command: string, expectsReply: boolean): Promise<string> {
    if (this.#closed) {
      return Promise.reject(new RconClosedError());
    }

    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return Promise.reject(new RconError('RCON_INVALID_COMMAND', 'command is empty'));
    }

    if (/[\r\n]/.test(trimmed)) {
      return Promise.reject(
        new RconError('RCON_INVALID_COMMAND', 'command must be a single line'),
      );
    }

    if (!this.isConnected) {
      return Promise.reject(new RconNotConnectedError());
    }

    return new Promise<string>((resolve, reject) => {
      this.#queue.push({ command: trimmed, resolve, reject, expectsReply });
      this.#pump();
    });
  }

  /**
   * Encerra de vez: cancela a reconexão, rejeita o que estiver
   * pendente e fecha o socket. Depois disso o cliente não
   * reconecta mais — é o caminho do SIGINT/SIGTERM.
   */
  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }

    this.#closed = true;
    this.#state = 'closed';

    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    this.#failAllPending(new RconClosedError());

    const socket = this.#socket;
    // Zerado ANTES de fechar: a partir daqui os handlers deste
    // socket veem que ele não é mais o atual e se calam.
    this.#socket = null;

    if (socket === null) {
      return Promise.resolve();
    }

    this.#logger?.info({ target: this.target }, 'closing rcon connection');

    return new Promise<void>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        // O servidor não confirmou o fechamento. Derruba na
        // marra para não segurar o shutdown do processo.
        try {
          socket.terminate();
        } catch {
          /* já estava morto */
        }
        finish();
      }, 2_000);
      timer.unref?.();

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      socket.onClose(() => {
        finish();
      });

      try {
        socket.close(1000, 'client shutdown');
      } catch {
        finish();
      }
    });
  }

  // ----------------------------------------------------------
  //  Conexão
  // ----------------------------------------------------------

  #openSocket(): void {
    this.#state = this.#reconnectAttempts === 0 ? 'connecting' : 'reconnecting';

    const url = buildRconUrl(this.#host, this.#port, this.#password);

    // maskRconUrl SEMPRE. A URL crua tem a senha do RCON, que dá
    // execução de comando arbitrário no servidor.
    this.#logger?.info(
      { url: maskRconUrl(url), attempt: this.#reconnectAttempts },
      'connecting to rcon',
    );

    let socket: RconSocket;
    try {
      socket = this.#socketFactory(url);
    } catch (error) {
      // Falha síncrona ao criar o socket (URL inválida, por
      // exemplo). Sem 'close' para nos avisar: agendamos aqui.
      this.#reportError(toError(error));
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;

    socket.onOpen(() => {
      this.#handleOpen(socket);
    });
    socket.onMessage((text) => {
      this.#handleMessage(socket, text);
    });
    socket.onClose((code, reason) => {
      this.#handleClose(socket, code, reason);
    });
    socket.onError((error) => {
      this.#handleError(socket, error);
    });
  }

  #handleOpen(socket: RconSocket): void {
    if (this.#socket !== socket) {
      return;
    }

    // Não existe frame de login no WebRCON: a senha viaja no
    // caminho da URL e é validada no handshake HTTP. Chegar aqui
    // já significa autenticado.
    this.#state = 'connected';
    this.#reconnectAttempts = 0;
    this.#lastConnectedAt = Date.now();

    this.#logger?.info({ target: this.target }, 'rcon connected');
    this.emit('connected');

    this.#pump();
  }

  #handleMessage(socket: RconSocket, text: string): void {
    if (this.#socket !== socket) {
      return;
    }

    const frame = parseIncomingFrame(text);
    const inFlight = this.#inFlight;

    const matched = matchPendingIdentifier(
      frame,
      inFlight === null ? null : { identifier: inFlight.identifier },
      this.#correlationStrategy,
    );

    if (matched !== null && inFlight !== null && inFlight.identifier === matched) {
      clearTimeout(inFlight.timer);
      this.#inFlight = null;
      inFlight.resolve(frame.message);
      this.#pump();
      return;
    }

    // Frame espontâneo: log do servidor, Puts() de plugin, chat.
    //
    // Cai aqui também a resposta que chegou DEPOIS do timeout —
    // o handler dela já foi descartado, então não há a quem
    // entregar. Virar log é o comportamento certo: o importante
    // é que ela não seja casada com o PRÓXIMO comando, o que
    // faria um `give` responder com o resultado de outro.
    this.emit('log', {
      identifier: frame.identifier,
      message: frame.message,
      type: frame.type,
      stacktrace: frame.stacktrace,
      receivedAt: Date.now(),
    });
  }

  #handleError(socket: RconSocket, error: Error): void {
    if (this.#socket !== socket) {
      return;
    }
    // Não agendamos reconexão aqui: o `ws` sempre emite 'close'
    // depois de 'error'. Agendar nos dois lugares abriria duas
    // conexões paralelas.
    this.#reportError(error);
  }

  #handleClose(socket: RconSocket, code: number, reason: string): void {
    if (this.#socket !== socket) {
      return;
    }

    this.#socket = null;
    const wasConnected = this.#state === 'connected';
    this.#lastDisconnectedAt = Date.now();

    this.#failAllPending(new RconDisconnectedError());

    this.emit('disconnected', { code, reason, wasConnected });

    if (this.#closed) {
      this.#state = 'closed';
      return;
    }

    this.#logger?.warn(
      { target: this.target, code, reason, wasConnected },
      'rcon connection closed',
    );

    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) {
      return;
    }

    this.#state = 'reconnecting';

    const delayMs = computeBackoffDelay(this.#reconnectAttempts, this.#backoff, this.#random);
    this.#reconnectAttempts += 1;

    this.#logger?.warn(
      { delayMs, attempt: this.#reconnectAttempts },
      'scheduling rcon reconnect',
    );

    const timer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#closed) {
        this.#openSocket();
      }
    }, delayMs);

    // unref: o timer de reconexão sozinho não deve segurar o
    // processo vivo. Quem mantém o event loop de pé é o
    // servidor HTTP.
    timer.unref?.();
    this.#reconnectTimer = timer;
  }

  // ----------------------------------------------------------
  //  Fila de comandos
  // ----------------------------------------------------------

  /**
   * Envia o próximo comando, se houver espaço.
   *
   * A serialização (um comando em voo por vez) é intencional. O
   * console do Rust não garante ordem nem separação entre a
   * saída de comandos concorrentes: dois `give` simultâneos
   * podem intercalar linhas. Com um de cada vez, cada resposta
   * pertence sem ambiguidade ao comando que a provocou — e é o
   * que permite a estratégia de correlação alternativa descrita
   * em frames.ts.
   *
   * O custo é vazão, e ela não é problema aqui: as entregas de
   * uma loja chegam em ritmo humano, não em milhares por
   * segundo.
   */
  #pump(): void {
    if (this.#inFlight !== null || !this.isConnected) {
      return;
    }

    const next = this.#queue.shift();
    if (next === undefined) {
      return;
    }

    this.#identifier = nextRequestIdentifier(this.#identifier);
    const identifier = this.#identifier;

    // ####  O COMANDO CUJA RESPOSTA NÃO INTERESSA  ####
    //
    // Ele NÃO vira `#inFlight`: sem entrada pendente não há
    // timeout para estourar, e o próximo comando da fila sai em
    // seguida em vez de esperar por uma resposta vazia que pode
    // demorar (servidor carregando o mundo, por exemplo).
    //
    // A resposta, quando chegar, cai no caminho de "resposta sem
    // dono" — que já existe e a trata como linha de log.
    if (!next.expectsReply) {
      try {
        this.#socket?.send(encodeCommandFrame(identifier, next.command));
        next.resolve('');
      } catch (error) {
        next.reject(new RconError('RCON_SEND_FAILED', toError(error).message));
      }

      this.#pump();
      return;
    }

    const timer = setTimeout(() => {
      this.#handleTimeout(identifier);
    }, this.#commandTimeoutMs);

    this.#inFlight = { ...next, identifier, timer };

    try {
      this.#socket?.send(encodeCommandFrame(identifier, next.command));
    } catch (error) {
      clearTimeout(timer);
      this.#inFlight = null;
      next.reject(new RconError('RCON_SEND_FAILED', toError(error).message));
      this.#pump();
    }
  }

  #handleTimeout(identifier: number): void {
    const inFlight = this.#inFlight;
    if (inFlight === null || inFlight.identifier !== identifier) {
      return;
    }

    // Descarta o handler ANTES de rejeitar. Sem isto, um
    // comando que nunca é respondido deixaria a entrada
    // pendente para sempre — e, num processo que roda 24/7,
    // "para sempre" é um vazamento de memória de verdade.
    this.#inFlight = null;

    this.#logger?.warn(
      { command: inFlight.command, timeoutMs: this.#commandTimeoutMs },
      'rcon command timed out',
    );

    inFlight.reject(new RconTimeoutError(inFlight.command, this.#commandTimeoutMs));
    this.#pump();
  }

  #failAllPending(error: Error): void {
    const inFlight = this.#inFlight;
    if (inFlight !== null) {
      clearTimeout(inFlight.timer);
      this.#inFlight = null;
      inFlight.reject(error);
    }

    const queued = this.#queue;
    this.#queue = [];
    for (const command of queued) {
      command.reject(error);
    }
  }

  #reportError(error: Error): void {
    this.#logger?.error({ err: error, target: this.target }, 'rcon error');
    this.emit('error', error);
  }
}
