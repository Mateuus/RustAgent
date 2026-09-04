// ============================================================
//  status.ts  -  o retrato do servidor, EMPURRADO para o site.
//
//  ####  ELE É TELEMETRIA, E NADA MAIS  ####
//
//  Nenhum desfecho daqui pode mexer em loja, carteira ou entrega.
//  O único efeito colateral permitido é acordar o beacon quando o
//  site responde que o pareamento não vale — e isso é diagnóstico,
//  não dinheiro. Um retrato que falhasse a compra de alguém seria
//  uma tela derrubando um caixa.
//
//  ####  POSIÇÃO DE JOGADOR NÃO SOBE. NUNCA.  ####
//
//  A rota de jogadores do agente devolve `position` e `grid`
//  quando o plugin está ligado — e ela PARA AQUI. Posição viva de
//  jogador é intel de raid: qualquer um que leia o painel do site
//  saberia onde cada pessoa está, com 30 s de atraso no pior caso.
//  `entryOf()` é o único lugar que monta uma linha da lista, e ele
//  copia quatro campos, um a um, de propósito: um espalhamento
//  (`...player`) traria a posição junto no dia em que alguém o
//  escrevesse por conveniência.
//
//  ####  A CONTAGEM É O QUE NÃO PODE FALTAR  ####
//
//  `online`/`max` são obrigatórios; a `list` é opcional. Quando o
//  corpo estoura o teto, o que sai é a lista — e o retrato vai
//  assim mesmo. Perder o número por causa do tamanho da lista
//  seria trocar o essencial pelo acessório.
//
//  ####  UM RETRATO POR SERVIDOR PAREADO  ####
//
//  Como o beacon: cada `Server` do site tem bearer próprio, e este
//  laço bate uma vez por pareamento, com o `X-Server-Id` dele.
//
//  Contrato `oz-rust/2`. Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §23.8.
// ============================================================

import type { PlayersSnapshot } from '../game/players.js';
import type { Logger } from '../logger.js';
import type { OperationView } from '../ops/operations.js';
import type { ServerView } from '../servers/supervisor.js';
import type { SteamUpdateState } from '../steam/update-watcher.js';
import { PAIRING_CODES } from '../store/site-wallet.js';
import { toError } from '../util.js';
import type { DiskUsage } from '../util/disk.js';
import { machineSnapshot, type MachineSnapshot } from '../util/machine.js';
import type { SiteClient } from './client.js';

/** A cadência do contrato. O piso e o teto são do canal. */
export const DEFAULT_STATUS_INTERVAL_MS = 30_000;
export const MIN_STATUS_INTERVAL_MS = 10_000;
export const MAX_STATUS_INTERVAL_MS = 300_000;

/** Os dois tetos de corpo do contrato. O agente recusa ANTES de sair. */
export const STATUS_MAX_BYTES = 8 * 1024;
export const STATUS_MAX_BYTES_WITH_LIST = 64 * 1024;

/** Quantos jogadores cabem na lista. Acima disto ela é cortada. */
export const STATUS_MAX_PLAYERS = 300;

/**
 * Quanto tempo a lista fica de fora depois de um 413.
 *
 * O 413 diz que o teto do SITE é menor que o nosso, e repetir o
 * mesmo corpo grande a cada 30 s só gasta banda dos dois lados.
 * Mas ele também acontece por lotação passageira — um servidor
 * cheio numa noite de wipe —, então a supressão VENCE: sem prazo,
 * um pico de uma noite calaria a lista até o próximo reinício.
 */
export const LIST_SUPPRESSION_MS = 10 * 60_000;

/**
 * De quanto em quanto tempo a MESMA linha de erro volta ao log.
 *
 * Enquanto a rota não existir do outro lado, o 404 chega a cada 30
 * s, por servidor. Sem este freio, o log do agente vira uma coluna
 * só de uma linha repetida — e é nele que se procura outra coisa.
 */
export const LOG_REPEAT_MS = 10 * 60_000;

// ============================================================
//  O CORPO, POR EXTENSO
// ============================================================

/** Uma linha da lista. Quatro campos, e a posição não é um deles. */
export interface StatusPlayer {
  readonly steamId: string;
  readonly name: string;
  /** `null` = a fonte atual não sabe (o `playerlist` nativo). */
  readonly isAlive: boolean | null;
  readonly isSleeping: boolean | null;
}

export interface StatusPayload {
  readonly at: string;
  readonly agent: {
    readonly version: string;
    readonly uptimeSeconds: number;
    readonly health: 'ok' | 'degraded';
  };
  readonly server: {
    readonly running: boolean;
    readonly pid: number | null;
    readonly installed: boolean;
    readonly hostname: string;
    readonly map: string;
    readonly worldSize: number;
    readonly seed: number;
    readonly maxPlayers: number;
    readonly rcon: { readonly connected: boolean; readonly state: string } | null;
  };
  readonly players: {
    readonly online: number;
    readonly max: number;
    /** `unavailable` = não deu para PERGUNTAR. Leia isto antes do número. */
    readonly source: 'plugin' | 'nativo' | 'unavailable';
    readonly list?: readonly StatusPlayer[];
  };
  readonly build: {
    readonly installed: string | null;
    readonly published: string | null;
    readonly updateAvailable: boolean;
    readonly checkedAt: string | null;
    readonly autoUpdate: boolean;
  } | null;
  readonly machine: MachineSnapshot;
  readonly operation: {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly progress: number | null;
    readonly message: string | null;
  } | null;
  readonly kinds: readonly string[];
}

/** O que o agente coletou daquele servidor, cru. */
export interface StatusCollected {
  readonly server: ServerView;
  /** `null` = não deu para perguntar. NUNCA lista vazia por omissão. */
  readonly players: PlayersSnapshot | null;
  /** O ÚLTIMO retrato guardado. Aqui NUNCA se pergunta à Steam. */
  readonly build: SteamUpdateState | null;
  /** `null` = não há operação em curso. */
  readonly operation: OperationView | null;
  readonly kinds: readonly string[];
}

export interface StatusInput extends StatusCollected {
  readonly at: number;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly machine: MachineSnapshot;
}

/** Corta o que um humano escreveu antes que ele estoure o corpo. */
function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * A saúde do agente NAQUELE servidor, em uma palavra.
 *
 * Servidor parado NÃO é `degraded`: quem o parou foi um humano, e
 * pintar de vermelho o que está desligado de propósito ensina a
 * ignorar o vermelho. `degraded` é reservado para a discordância
 * que interessa: o jogo está no ar e o agente não fala com ele.
 */
function healthOf(server: ServerView, players: PlayersSnapshot | null): 'ok' | 'degraded' {
  if (server.running !== true) {
    return 'ok';
  }

  return server.rcon?.connected === true && players !== null ? 'ok' : 'degraded';
}

/**
 * Uma linha da lista.
 *
 * ####  OS QUATRO CAMPOS SÃO COPIADOS UM A UM  ####
 *
 * Ver o cabeçalho: `position` e `grid` existem no `PlayerView` e
 * não podem sair da máquina. Um `...player` aqui os levaria junto,
 * sem erro, sem teste falhando e sem ninguém percebendo até
 * alguém do outro lado descobrir onde a base de um jogador está.
 */
function entryOf(player: PlayersSnapshot['players'][number]): StatusPlayer {
  return {
    steamId: player.steamId,
    name: cut(player.name, 64),
    isAlive: player.isAlive,
    isSleeping: player.isSleeping,
  };
}

/** O retrato COM a lista, quando há uma. */
export function buildStatusPayload(input: StatusInput): StatusPayload {
  const { server, players } = input;

  return {
    at: new Date(input.at).toISOString(),
    agent: {
      version: input.version,
      uptimeSeconds: input.uptimeSeconds,
      health: healthOf(server, players),
    },
    server: {
      // `running: null` é "ainda não varremos os processos", e quem
      // coleta varre antes. Sobrando o `null`, `false` é o que a
      // tela do outro lado já desenha para "parado".
      running: server.running === true,
      pid: server.pid,
      installed: server.installed,
      hostname: cut(server.hostname, 120),
      map: cut(server.map, 64),
      worldSize: server.worldSize,
      seed: server.seed,
      maxPlayers: server.maxPlayers,
      rcon: server.rcon,
    },
    players:
      players === null
        ? // ####  ZERO AQUI NÃO É "NÃO TEM NINGUÉM"  ####
          //
          // É "não deu para perguntar", e o `source` é quem diz. O
          // contrato exige `online` como número, então o número vai
          // — mas quem o exibir sem ler o `source` mostrará um
          // servidor cheio como vazio.
          { online: 0, max: server.maxPlayers, source: 'unavailable' as const }
        : {
            online: players.total,
            max: server.maxPlayers,
            source: players.source,
            list: players.players.slice(0, STATUS_MAX_PLAYERS).map(entryOf),
          },
    build:
      input.build === null
        ? null
        : {
            installed: input.build.installed,
            published: input.build.published,
            updateAvailable: input.build.updateAvailable,
            checkedAt:
              input.build.checkedAt === null ? null : new Date(input.build.checkedAt).toISOString(),
            autoUpdate: input.build.autoUpdate,
          },
    machine: input.machine,
    operation:
      input.operation === null
        ? null
        : {
            id: input.operation.id,
            kind: input.operation.kind,
            status: input.operation.status,
            progress: input.operation.progress,
            message: input.operation.message === null ? null : cut(input.operation.message, 300),
          },
    kinds: input.kinds,
  };
}

/** O MESMO retrato, sem a lista. A contagem continua. */
export function withoutList(payload: StatusPayload): StatusPayload {
  const { list: _list, ...players } = payload.players;

  return { ...payload, players };
}

/**
 * O corpo carrega algum dos três nomes proibidos?
 *
 * ####  ELE JÁ MORDEU ESTE PROJETO  ####
 *
 * O site tem um middleware GLOBAL que responde 403 `{error:
 * 'Operação não permitida'}` SEM `error_code` quando `balance`,
 * `ozBalance` ou `epBalance` aparecem no corpo. Ele é mudo: não há
 * código, não há campo, e o sintoma é uma rota que "parou de
 * funcionar". Este retrato não os monta hoje — a rede existe para
 * o dia em que alguém acrescentar um campo de saldo aqui achando
 * que telemetria não conta.
 */
export function hasForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenField(item));
  }

  if (value === null || typeof value !== 'object') {
    return false;
  }

  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) =>
      key === 'balance' || key === 'ozBalance' || key === 'epBalance' || hasForbiddenField(item),
  );
}

function bytesOf(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

// ============================================================
//  O LAÇO
// ============================================================

export interface SiteStatusOptions {
  readonly client: SiteClient;
  /** O servidor LOCAL. O do site é o `X-Server-Id` do cliente. */
  readonly serverId: string;
  readonly version: string;
  /** Epoch do boot do agente. Vira `agent.uptimeSeconds`. */
  readonly startedAt: number;
  /** `null` = o servidor sumiu do supervisor. A rodada não sai. */
  readonly collect: () => Promise<StatusCollected | null>;
  readonly logger: Logger;
  /** O disco onde o jogo mora. `null` = não deu para ler. */
  readonly disk?: () => Promise<DiskUsage | null>;
  /**
   * O site respondeu que o pareamento não vale.
   *
   * Acorda o beacon — que já tem freio próprio de 5 s, e é ele
   * quem descobre em segundos, e não em minutos, que o token foi
   * rotacionado. Este laço NÃO retenta por conta própria: o
   * intervalo de 30 s é a espera, e um retrato não vale um laço
   * apertado contra o site.
   */
  readonly onPairingSuspect?: (reason: string) => void;
  readonly intervalMs?: number;
  readonly now?: () => number;
  /**
   * Os dois tetos de corpo. Injetáveis para o TESTE, e só para ele.
   *
   * Os padrões são o contrato (`STATUS_MAX_BYTES` e
   * `STATUS_MAX_BYTES_WITH_LIST`), e um retrato real com os 300
   * jogadores do teto cabe folgado neles — o que torna o caminho do
   * corpo grande impossível de exercitar sem baixá-los aqui.
   */
  readonly maxBytes?: number;
  readonly maxBytesWithList?: number;
}

export interface SiteStatusHealth {
  readonly lastPushAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
  readonly lastBytes: number | null;
  /** Até quando a lista fica de fora. `null` = ela está indo. */
  readonly listSuppressedUntil: number | null;
}

export class SiteStatus {
  readonly #options: SiteStatusOptions;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #maxBytes: number;
  readonly #maxBytesWithList: number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastPushAt: number | null = null;
  #lastError: string | null = null;
  #lastErrorCode: string | null = null;
  #lastBytes: number | null = null;
  #listSuppressedUntil = 0;
  #lastLogged: { message: string; at: number } | null = null;

  constructor(options: SiteStatusOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
    this.#intervalMs = Math.min(
      MAX_STATUS_INTERVAL_MS,
      Math.max(MIN_STATUS_INTERVAL_MS, options.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS),
    );
    this.#maxBytes = options.maxBytes ?? STATUS_MAX_BYTES;
    this.#maxBytesWithList = options.maxBytesWithList ?? STATUS_MAX_BYTES_WITH_LIST;
  }

  /** O que uma tela de diagnóstico mostra. */
  get health(): SiteStatusHealth {
    return {
      lastPushAt: this.#lastPushAt,
      lastError: this.#lastError,
      lastErrorCode: this.#lastErrorCode,
      lastBytes: this.#lastBytes,
      listSuppressedUntil:
        this.#listSuppressedUntil > this.#now() ? this.#listSuppressedUntil : null,
    };
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.push();
    }, this.#intervalMs);
    // Um relógio de conveniência não pode ser a razão de o agente
    // não conseguir desligar — a mesma disciplina do beacon.
    this.#timer.unref();

    // Uma batida no boot: o site sabe do servidor no primeiro
    // segundo, e não no trigésimo.
    void this.push();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma batida.
   *
   * NUNCA lança e NUNCA rejeita: ela roda num relógio, e um erro
   * aqui é rotina. Derrubar o laço deixaria o site sem retrato —
   * em silêncio, que é o pior jeito de um relógio falhar.
   */
  async push(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      const collected = await this.#options.collect();

      if (collected === null) {
        return;
      }

      const now = this.#now();
      const disk = (await this.#options.disk?.()) ?? null;
      const full = buildStatusPayload({
        ...collected,
        at: now,
        version: this.#options.version,
        uptimeSeconds: Math.floor((now - this.#options.startedAt) / 1000),
        machine: machineSnapshot({ disk }),
      });

      const payload = this.#fit(full);

      if (payload === null) {
        return;
      }

      await this.#send(payload);
    } catch (error) {
      // Não deveria acontecer — o cliente não lança —, mas o
      // relógio não pode morrer por causa de uma surpresa.
      this.#lastError = toError(error).message;
      this.#log('error', { err: toError(error) }, 'status round failed');
    } finally {
      this.#running = false;
    }
  }

  /**
   * O corpo que CABE, e `null` quando nem o menor cabe.
   *
   * A ordem é uma só: tenta com a lista, cai para sem ela, e
   * desiste quando o retrato pelado ainda estoura — o que só
   * acontece com um campo de texto absurdo, e aí mandar seria
   * tomar 413 de propósito.
   */
  #fit(full: StatusPayload): StatusPayload | null {
    if (this.#listSuppressedUntil > this.#now()) {
      return this.#fitBare(withoutList(full));
    }

    if (full.players.list === undefined) {
      return this.#fitBare(full);
    }

    const bytes = bytesOf(JSON.stringify(full));

    if (bytes > this.#maxBytesWithList) {
      this.#log(
        'warn',
        { serverId: this.#options.serverId, bytes, max: this.#maxBytesWithList },
        'the status body is too large with the player list; sending the count only',
      );

      return this.#fitBare(withoutList(full));
    }

    return full;
  }

  /** O retrato SEM lista contra o teto de 8 KB. */
  #fitBare(bare: StatusPayload): StatusPayload | null {
    const bytes = bytesOf(JSON.stringify(bare));

    if (bytes > this.#maxBytes) {
      this.#lastError = 'STATUS_TOO_LARGE';
      this.#log(
        'error',
        { serverId: this.#options.serverId, bytes, max: this.#maxBytes },
        'the status body does not fit even without the player list',
      );

      return null;
    }

    return bare;
  }

  async #send(payload: StatusPayload): Promise<void> {
    if (hasForbiddenField(payload)) {
      // Ver `hasForbiddenField`: o 403 do outro lado é mudo, e
      // repetir o mesmo corpo daria o mesmo 403 para sempre.
      this.#lastError = 'FORBIDDEN_FIELD';
      this.#log(
        'error',
        { serverId: this.#options.serverId },
        'the status body carries a forbidden balance field; not sending',
      );

      return;
    }

    this.#lastBytes = bytesOf(JSON.stringify(payload));

    const result = await this.#options.client.pushServerStatus(payload);

    if (result.ok) {
      this.#lastPushAt = this.#now();
      this.#lastError = null;
      this.#lastErrorCode = null;
      this.#lastLogged = null;

      return;
    }

    this.#lastError = result.reason;
    this.#lastErrorCode = result.code;

    this.#classify(result.status, result.code, result.reason);
  }

  /**
   * A tabela de tradução, e ela é curta de propósito.
   *
   * Status é telemetria: aqui não há compra para fechar nem item
   * para devolver, então só três desfechos importam — o corpo
   * estourou, o pareamento quebrou, ou foi a rede. Todo o resto
   * espera a volta seguinte.
   */
  #classify(status: number | null, code: string | null, reason: string): void {
    const serverId = this.#options.serverId;

    if (status === 413) {
      this.#listSuppressedUntil = this.#now() + LIST_SUPPRESSION_MS;
      this.#log(
        'warn',
        { serverId, until: this.#listSuppressedUntil },
        'the site refused the status body for size; dropping the player list for a while',
      );

      return;
    }

    // O 403 da BORDA, em texto puro: o User-Agent foi recusado. Não
    // é ban e não é pareamento — no painel do Conan isto custou
    // horas procurando ban numa tabela vazia.
    if (status === 403 && code === null && /error code: 1010/i.test(reason)) {
      this.#log('warn', { serverId, status }, 'the edge refused the status push (user-agent)');

      return;
    }

    if (status === 401 || status === 403 || status === 404 || PAIRING_CODES.has(code ?? '')) {
      // ####  O SITE PODE SÓ NÃO TER A ROTA AINDA  ####
      //
      // Um 404 SEM `error_code` é isso: o Lote 2 do outro lado não
      // subiu. Ele não acorda o beacon — o pareamento está inteiro,
      // e um `suspect` a cada 30 s por servidor faria o beacon bater
      // sem motivo até o dia em que a rota nascesse.
      if (status === 404 && code === null) {
        this.#log(
          'warn',
          { serverId, status },
          'the site does not answer POST /api/agent/server/status yet',
        );

        return;
      }

      this.#options.onPairingSuspect?.(code ?? 'PAIRING');
      this.#log('warn', { serverId, status, code }, 'the site refused the status push (pairing)');

      return;
    }

    // 429, 5xx, timeout, DNS, TLS: a volta seguinte tenta de novo.
    // Nada aqui é retentado na hora — um retrato não vale um laço
    // apertado contra o site.
    this.#log('warn', { serverId, status, code }, 'status push failed');
  }

  /**
   * Registra, com freio para a linha REPETIDA.
   *
   * Ver `LOG_REPEAT_MS`: enquanto a rota não existir do outro lado,
   * o mesmo erro chega a cada 30 s, por servidor.
   */
  #log(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
    const now = this.#now();
    const last = this.#lastLogged;

    if (last !== null && last.message === message && now - last.at < LOG_REPEAT_MS) {
      return;
    }

    this.#lastLogged = { message, at: now };
    this.#options.logger[level](fields, message);
  }
}
