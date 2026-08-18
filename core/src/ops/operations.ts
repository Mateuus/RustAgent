// ============================================================
//  operations.ts  -  o que está acontecendo na máquina agora.
//
//  Uma operação é um trabalho LONGO disparado por HTTP: instalar
//  6 GB, subir um servidor, atualizar. O POST responde 202 com um
//  id, e o painel acompanha por `GET /api/operations/<id>`.
//
//  Este arquivo guarda três coisas, e só elas:
//
//    1. o REGISTRO   estado, log incremental, progresso
//    2. a TRAVA      por recurso nomeado, não "uma por máquina"
//    3. o HISTÓRICO  as 20 últimas, em memória
//
//  Quem SABE FAZER cada operação é o `ops/service.ts`.
// ============================================================

import { randomUUID } from 'node:crypto';

import { ApiError } from '../http/error-response.js';

export const OPERATION_KINDS = [
  'server-install',
  'server-update',
  'server-start',
  'server-stop',
  'server-restart',
  'server-auto-update',
  'oxide-install',
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Quantas linhas de log uma operação guarda.
 *
 * Um `app_update` de 6 GB imprime dezenas de milhares. Guardar
 * tudo seria segurar megabytes de texto em memória por uma tela
 * que ninguém vai rolar até o começo — e o que interessa quando
 * dá errado está sempre no FIM.
 */
const MAX_LOG_LINES = 2_000;

/** Quantas operações terminadas ficam visíveis. */
const MAX_HISTORY = 20;

export interface OperationLogLine {
  /** Número absoluto da linha. É o cursor do `fromLine`. */
  readonly n: number;
  readonly at: number;
  readonly text: string;
}

/**
 * Para onde as linhas vão ALÉM da memória.
 *
 * Existe um só uso hoje — o arquivo em `Logs\<servidor>\ops\` —,
 * e ele é a razão de a operação ter deixado de ser um objeto
 * fechado: o console da tela morre no `pm2 restart`, e a pergunta
 * "por que o update da madrugada falhou?" chega sempre depois
 * disso. Ver `op-log-file.ts`.
 */
export interface OperationSink {
  readonly line: (line: OperationLogLine) => void;
  readonly close: (operation: Operation) => void;
}

export interface OperationView {
  readonly id: string;
  readonly kind: OperationKind;
  readonly serverId: string;
  readonly status: OperationStatus;
  /** 0 a 100, quando dá para saber. `null` no resto do tempo. */
  readonly progress: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** A frase do desfecho: o que deu errado, ou o que foi feito. */
  readonly message: string | null;
}

/**
 * Uma operação em curso ou terminada.
 *
 * Mutável de propósito — ela é escrita enquanto roda. Quem lê de
 * fora recebe `view()` e `logFrom()`, que copiam.
 */
export class Operation {
  readonly id = `op_${randomUUID().slice(0, 8)}`;
  readonly kind: OperationKind;
  readonly serverId: string;
  readonly startedAt = Date.now();
  readonly #abort = new AbortController();

  status: OperationStatus = 'running';
  progress: number | null = null;
  finishedAt: number | null = null;
  message: string | null = null;

  /** As últimas linhas. A primeira delas é a de número `#dropped`. */
  readonly #lines: OperationLogLine[] = [];
  #dropped = 0;
  #next = 0;
  #sink: OperationSink | null = null;

  /**
   * Resolve quando a operação termina — de qualquer jeito.
   *
   * É o que deixa o vigia da Steam saber COMO acabou a tentativa
   * que ele mesmo disparou: sem isto, ele só sabia que tinha
   * disparado, e a tela repetia "o agente atualiza sozinho"
   * mesmo depois de três fracassos seguidos.
   */
  readonly done: Promise<Operation>;
  readonly #settle: (operation: Operation) => void;

  constructor(kind: OperationKind, serverId: string) {
    this.kind = kind;
    this.serverId = serverId;

    let settle: (operation: Operation) => void = () => undefined;

    this.done = new Promise<Operation>((resolve) => {
      settle = resolve;
    });

    this.#settle = settle;
  }

  /**
   * Liga o despejo em arquivo. Uma vez só, antes de rodar.
   *
   * Fora do construtor porque quem sabe abrir o arquivo precisa
   * do `id` e do `startedAt` — que só existem depois que a
   * operação nasce.
   */
  pipeTo(sink: OperationSink): void {
    this.#sink ??= sink;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get cancelled(): boolean {
    return this.#abort.signal.aborted;
  }

  /** Quantas linhas foram descartadas por causa do teto. */
  get droppedLines(): number {
    return this.#dropped;
  }

  /** O número que a próxima linha vai receber. */
  get nextLine(): number {
    return this.#next;
  }

  log(text: string): void {
    const line: OperationLogLine = { n: this.#next, at: Date.now(), text };

    this.#lines.push(line);
    this.#next += 1;

    if (this.#lines.length > MAX_LOG_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }

    // O arquivo recebe TUDO: o teto acima é da memória, e o que
    // some dela é justamente o começo da instalação — onde mora
    // metade das respostas.
    this.#sink?.line(line);
  }

  /**
   * As linhas a partir de um cursor.
   *
   * O painel manda o `nextLine` que recebeu da vez anterior, e
   * recebe só o que chegou desde então. Um cursor mais antigo que
   * o que sobrou devolve o que existe — e `droppedLines` na
   * resposta diz que houve corte.
   */
  logFrom(cursor: number): readonly OperationLogLine[] {
    return this.#lines.filter((line) => line.n >= cursor);
  }

  finish(status: Exclude<OperationStatus, 'running'>, message: string | null): void {
    if (this.status !== 'running') {
      return;
    }

    this.status = status;
    this.finishedAt = Date.now();
    this.message = message;

    this.#sink?.close(this);
    this.#settle(this);
  }

  /**
   * Pede o cancelamento.
   *
   * Ele não mata nada aqui: quem lê o `signal` é o `run()` (que
   * derruba o processo) e os laços de espera. Uma operação que
   * ignora o sinal termina normalmente — e é o certo para as que
   * não têm ponto seguro de parada.
   */
  cancel(): void {
    this.#abort.abort();
    this.log('[agente] cancelamento pedido');
  }

  view(): OperationView {
    return {
      id: this.id,
      kind: this.kind,
      serverId: this.serverId,
      status: this.status,
      progress: this.progress,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      message: this.message,
    };
  }
}

function describeResource(resource: string): string {
  if (resource === 'steamcmd') {
    return 'O SteamCMD';
  }

  if (resource.startsWith('disk:')) {
    return `A pasta do servidor "${resource.slice(5)}"`;
  }

  if (resource.startsWith('server:')) {
    return `O servidor "${resource.slice(7)}"`;
  }

  return resource;
}

/**
 * A trava, por RECURSO nomeado.
 *
 * Não é "uma operação por máquina": subir o `pvp1` enquanto o
 * `pve` instala não disputa nada. O que disputa é isto:
 *
 *    steamcmd     um cliente só, um lock só. Dois `app_update`
 *                 em paralelo deixam a pasta pela metade
 *    disk:<id>    qualquer escrita em Servers\<id>\
 *    server:<id>  start/stop/restart daquele servidor
 *
 * A recusa diz QUEM está segurando e desde quando — "ocupado" sem
 * dono é a mensagem que faz a pessoa clicar de novo.
 */
export class OperationLock {
  readonly #held = new Map<string, Operation>();

  acquire(resources: readonly string[], operation: Operation): void {
    for (const resource of resources) {
      const holder = this.#held.get(resource);

      if (holder !== undefined && holder.status === 'running') {
        const minutes = Math.max(1, Math.round((Date.now() - holder.startedAt) / 60_000));

        throw new ApiError(
          'OPERATION_IN_PROGRESS',
          `${describeResource(resource)} já está ocupado com a operação ${holder.kind} do ` +
            `servidor "${holder.serverId}" (começou há ${String(minutes)} min). ` +
            'Espere ela terminar, ou cancele-a na tela de Operações.',
          409,
        );
      }
    }

    for (const resource of resources) {
      this.#held.set(resource, operation);
    }
  }

  release(resources: readonly string[]): void {
    for (const resource of resources) {
      this.#held.delete(resource);
    }
  }

  /** Só para o teste e para a tela de diagnóstico. */
  holderOf(resource: string): Operation | null {
    const holder = this.#held.get(resource);

    return holder?.status === 'running' ? holder : null;
  }
}

/**
 * Onde as operações vivem enquanto o agente está no ar.
 *
 * ####  ISTO NÃO É AUDITORIA  ####
 *
 * É o que aconteceu NESTA SESSÃO. Reiniciou o agente, o histórico
 * some. Persistir exigiria uma tabela e uma política de expurgo
 * para responder a uma pergunta que ninguém faz — quem quer saber
 * o que aconteceu ontem olha o log do PM2, que é rotacionado e
 * tem tudo.
 */
export class OperationStore {
  readonly #byId = new Map<string, Operation>();
  readonly #order: string[] = [];

  add(operation: Operation): void {
    this.#byId.set(operation.id, operation);
    this.#order.push(operation.id);

    // Só as TERMINADAS são podadas: uma operação em curso fica,
    // mesmo que 20 outras tenham começado depois — perder o log
    // ao vivo de uma instalação de uma hora seria o pior desfecho
    // possível deste teto.
    while (this.#order.length > MAX_HISTORY) {
      const oldest = this.#order.find((id) => this.#byId.get(id)?.status !== 'running');

      if (oldest === undefined) {
        break;
      }

      this.#order.splice(this.#order.indexOf(oldest), 1);
      this.#byId.delete(oldest);
    }
  }

  get(id: string): Operation | null {
    return this.#byId.get(id) ?? null;
  }

  /** Da mais nova para a mais velha. */
  list(serverId?: string): readonly Operation[] {
    const all = this.#order
      .map((id) => this.#byId.get(id))
      .filter((operation): operation is Operation => operation !== undefined)
      .reverse();

    return serverId === undefined ? all : all.filter((operation) => operation.serverId === serverId);
  }

  get running(): readonly Operation[] {
    return this.list().filter((operation) => operation.status === 'running');
  }
}
