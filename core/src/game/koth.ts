// ============================================================
//  koth.ts  -  o domínio de território, do lado do agente.
//
//  ####  O QUE É DAQUI E O QUE É DO PLUGIN  ####
//
//    AQUI     onde nasce, quando nasce, e o que fica no histórico
//    LÁ       quem está dentro do círculo agora, quanto subiu, quem
//             está contestando — a conta por segundo
//
//  A conta não pode vir para cá: seriam sessenta idas e voltas de
//  RCON por minuto para saber quem está pisando num círculo. O que
//  sobe é o DESFECHO — capturou, expirou, acabou —, e é isso que
//  vira linha no histórico.
//
//  ####  A RUN É DO GUARDA-CHUVA  ####
//
//  Ela mora em `world_event_runs`, a mesma tabela da masmorra. O
//  KOTH não ganhou histórico próprio de propósito: "o que nasceu no
//  mapa ontem, e o que não nasceu" é uma pergunta só, e duas tabelas
//  seriam duas respostas para ela.
//
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO  ####
//
//  A lição medida do `agent-requests.ts`, repetida no `teams.ts`: um
//  comando mandado de dentro do `onConsoleLine` imprime no console, a
//  linha volta e dispara de novo.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { KothArenasRepository } from '../db/koth-arenas-repository.js';
import type { WorldEventsRepository } from '../db/world-events-repository.js';
import type { Logger } from '../logger.js';
import type { KothArena, KothPush, KothStatus } from '../types/koth.js';
import { toError } from '../util.js';

/** O marcador do aviso. O mesmo `Marker` do OrigemZKoth.cs. */
export const KOTH_MARKER = '#OZKOTH#';

/** Quebra de linha do console, nos dois sabores. */
const SPLIT_LINES = /\r?\n/;

/**
 * A âncora da linha.
 *
 * O marcador tem de estar no COMEÇO, depois de no máximo dois
 * prefixos entre colchetes (`[OrigemZ KOTH] `). A linha de chat traz
 * o nome de quem falou antes do texto e não passa.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZKOTH#/;

export interface KothRcon {
  readonly isConnected: boolean;
  send: (command: string) => Promise<string>;
}

export interface KothServers {
  readonly ids: () => readonly string[];
  readonly contextOf: (serverId: string) => { readonly rcon: KothRcon } | null;
  /** `"<worldSize>:<seed>"` daquele servidor, ou `null`. */
  readonly worldKey: (serverId: string) => string | null;
}

export interface KothDeps {
  readonly arenas: KothArenasRepository;
  readonly events: WorldEventsRepository;
  readonly servers: KothServers;
  readonly logger: Logger;
  /**
   * Fala no chat do servidor.
   *
   * Ausente = o evento acontece calado. Ele funciona assim, e é o
   * que acontece num agente sem canal de chat — mas ninguém fica
   * sabendo que começou.
   */
  readonly announce?: (serverId: string, message: string) => Promise<void>;
}

export class KothCommandError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'KothCommandError';
    this.reason = reason;
  }
}

/** O que está de pé agora, por servidor. */
interface Live {
  readonly runId: number;
  readonly arenaId: number;
  readonly eventId: string;
  readonly startedAt: number;
}

export class KothService {
  readonly #deps: KothDeps;
  readonly #secret = randomUUID();
  /** O que este processo ergueu, por servidor. */
  readonly #live = new Map<string, Live>();
  #stopped = false;

  constructor(deps: KothDeps) {
    this.#deps = deps;
  }

  stop(): void {
    this.#stopped = true;
  }

  // ------------------------------------------------------------
  //  §1  ERGUER E DERRUBAR
  // ------------------------------------------------------------

  /**
   * Ergue o território no mapa.
   *
   * `arenaId` ausente = sorteia entre os elegíveis daquele servidor.
   * É o caminho do agendador; o painel manda o id porque o admin
   * escolheu na tela.
   */
  async start(input: {
    readonly serverId: string;
    readonly eventId?: string;
    readonly arenaId?: number;
  }): Promise<{ readonly arena: KothArena; readonly runId: number; readonly grid: string }> {
    const { serverId } = input;

    if (this.#live.has(serverId)) {
      throw new KothCommandError('already_active', 'Já há um KOTH de pé neste servidor.');
    }

    const worldKey = this.#deps.servers.worldKey(serverId);

    const arena =
      input.arenaId === undefined
        ? this.#deps.arenas.pickFor(serverId, { worldKey })
        : this.#deps.arenas.get(serverId, input.arenaId);

    if (arena === null) {
      throw new KothCommandError(
        'no_arena',
        'Nenhum território disponível: cadastre um, ligue os que existem, ou revalide os que são de outro mapa.',
      );
    }

    if (!arena.enabled) {
      throw new KothCommandError('arena_disabled', `O território "${arena.label}" está desligado.`);
    }

    // ####  A RUN NASCE ANTES DO COMANDO  ####
    //
    // Assim o `runId` viaja com o start, e o aviso que volta do
    // plugin encontra a linha já aberta. Ao contrário da masmorra,
    // aqui é o AGENTE quem abre a run: o plugin do KOTH não tem
    // dados próprios do nascimento (peças, semente) para justificar
    // abri-la do lado de lá.
    const eventId = input.eventId ?? 'koth-manual';
    const run = this.#deps.events.startRun({
      eventId,
      serverId,
      dungeonId: null,
      x: arena.x,
      z: arena.z,
      grid: arena.grid,
      seed: null,
    });

    const body = JSON.stringify({
      runId: String(run.id),
      name: arena.label,
      x: arena.x,
      z: arena.z,
      y: arena.y,
      radius: arena.radius,
      height: arena.height,
      captureSeconds: arena.captureSeconds,
      durationSeconds: arena.durationSeconds,
      decayPerSecond: arena.decayPerSecond,
      color: arena.color,
      requireTeam: true,
    });

    let reply: Record<string, unknown>;

    try {
      reply = await this.#command(serverId, `origemz.koth start ${body}`);
    } catch (cause) {
      // O comando não saiu: a run não pode ficar aberta dizendo que
      // há um evento de pé. Ela vira falha com nome, e o histórico
      // conta o que aconteceu.
      this.#deps.events.endRun(run.id, 'failed');

      throw cause;
    }

    const grid = typeof reply['grid'] === 'string' ? reply['grid'] : (arena.grid ?? '?');

    this.#deps.arenas.markUsed(serverId, arena.id);
    this.#deps.arenas.markChecked(serverId, arena.id, { worldKey, grid });

    this.#live.set(serverId, {
      runId: run.id,
      arenaId: arena.id,
      eventId,
      startedAt: Date.now(),
    });

    this.#deps.logger.info(
      { server: serverId, arena: arena.label, grid, run: run.id },
      'KOTH erguido',
    );

    await this.#say(
      serverId,
      `<color=#C4B454>KOTH</color>: o território <color=#8FBF4F>${arena.label}</color> (${grid}) está aberto. Vá com a sua equipe!`,
    );

    return { arena, runId: run.id, grid };
  }

  /**
   * Há território para erguer neste servidor?
   *
   * O agendador pergunta ANTES de tentar: erguer sem território
   * devolve erro, e o erro viraria uma FALHA no histórico — "não
   * nasceu" com cara de defeito. Falta de território não é defeito,
   * é configuração que ainda não foi feita.
   */
  hasArena(serverId: string): boolean {
    return this.#deps.arenas.pickFor(serverId, {
      worldKey: this.#deps.servers.worldKey(serverId),
    }) !== null;
  }

  /** Derruba o que estiver de pé. */
  async stopRun(serverId: string, reason = 'painel'): Promise<void> {
    await this.#command(serverId, 'origemz.koth stop', { allow: ['not_active'] });

    this.#closeLocal(serverId, 'cancelled', reason);
  }

  async status(serverId: string): Promise<KothStatus> {
    const reply = await this.#command(serverId, 'origemz.koth status');

    return reply as unknown as KothStatus;
  }

  // ------------------------------------------------------------
  //  §2  ESCUTAR
  // ------------------------------------------------------------

  handleLine(serverId: string, line: string): void {
    if (this.#stopped || !line.includes(KOTH_MARKER)) return;

    try {
      this.#handle(serverId, line);
    } catch (cause) {
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'linha do OrigemZKoth não pôde ser tratada',
      );
    }
  }

  #handle(serverId: string, line: string): void {
    if (!PLUGIN_LINE.test(line.trimStart())) return;

    const body = line.slice(line.indexOf(KOTH_MARKER) + KOTH_MARKER.length).trim();

    if (body === '') return;

    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== 'object' || parsed === null) return;

    const push = parsed as KothPush & { readonly secret?: string };

    if (push.kind === 'ready') {
      this.#deps.logger.info({ server: serverId }, 'o OrigemZKoth subiu e pediu o segredo');
      this.#syncSoon(serverId);
      return;
    }

    if (push.secret !== this.#secret) {
      this.#deps.logger.warn(
        { server: serverId, kind: push.kind },
        'aviso de KOTH com segredo errado: ignorado',
      );

      return;
    }

    this.#apply(serverId, push);
  }

  #apply(serverId: string, push: KothPush): void {
    switch (push.kind) {
      case 'captured': {
        const winner = push.teamName === undefined || push.teamName === '' ? 'uma equipe' : push.teamName;

        this.#closeLocal(serverId, 'ended', 'captured');

        this.#deps.logger.info(
          { server: serverId, team: push.teamId, name: push.teamName, members: push.members?.length ?? 0 },
          'KOTH capturado',
        );

        // A recompensa entra AQUI quando existir. Hoje o agente
        // registra quem ganhou e não paga nada — e é melhor assim do
        // que pagar um prêmio que ninguém configurou.
        void this.#say(
          serverId,
          `<color=#C4B454>KOTH</color>: <color=#8FBF4F>${winner}</color> dominou o território!`,
        );

        return;
      }

      case 'expired': {
        this.#closeLocal(serverId, 'ended', 'expired');

        this.#deps.logger.info({ server: serverId }, 'KOTH expirou sem vencedor');

        return;
      }

      case 'ended': {
        // O plugin desmontou (comando, `Unload`, ou fim normal). Se a
        // run ainda estiver aberta aqui, ela fecha — uma run aberta
        // com o mapa vazio faz o painel dizer "1 no ar" para sempre.
        this.#closeLocal(serverId, 'ended', push.reason ?? 'plugin');

        return;
      }

      default:
        return;
    }
  }

  /** Fecha a run local, se houver. Chamar duas vezes é inofensivo. */
  #closeLocal(serverId: string, status: 'ended' | 'cancelled', why: string): void {
    const live = this.#live.get(serverId);

    if (live === undefined) return;

    this.#live.delete(serverId);
    this.#deps.events.endRun(live.runId, status);

    this.#deps.logger.debug({ server: serverId, run: live.runId, why }, 'run de KOTH fechada');
  }

  /**
   * Fecha o que sobrou de uma vida anterior deste processo.
   *
   * Um KOTH não sobrevive a um agente parado pelo mesmo motivo da
   * masmorra: nada dele entra no save, e o plugin o derruba ao
   * descarregar. Mantê-lo aberto no banco faria o painel dizer "1 no
   * ar" com o mapa vazio, para sempre.
   */
  recover(): void {
    for (const serverId of this.#deps.servers.ids()) {
      const active = this.#deps.events.activeRun(serverId);

      if (active === null || this.#live.has(serverId)) continue;
      if (active.dungeonId !== null) continue;

      this.#deps.events.endRun(active.id, 'ended');

      this.#deps.logger.info(
        { server: serverId, run: active.id },
        'run de KOTH fechada no boot: nada dele sobrevive a um agente parado',
      );
    }
  }

  // ------------------------------------------------------------
  //  §3  FERRAMENTA
  // ------------------------------------------------------------

  async sync(serverId: string): Promise<void> {
    if (this.#stopped) return;

    try {
      await this.#command(serverId, `origemz.koth sync {"secret":"${this.#secret}"}`);

      this.#deps.logger.info({ server: serverId }, 'o OrigemZKoth recebeu o segredo');
    } catch (cause) {
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'não consegui sincronizar o OrigemZKoth',
      );
    }
  }

  #syncSoon(serverId: string): void {
    setTimeout(() => {
      void this.sync(serverId);
    }, 1000).unref();
  }

  async #say(serverId: string, message: string): Promise<void> {
    if (this.#deps.announce === undefined) return;

    try {
      await this.#deps.announce(serverId, message);
    } catch (cause) {
      // Um anúncio que não sai não pode derrubar o evento.
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'o anúncio do KOTH não saiu',
      );
    }
  }

  async #command(
    serverId: string,
    command: string,
    options: { readonly allow?: readonly string[] } = {},
  ): Promise<Record<string, unknown>> {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      throw new KothCommandError('offline', 'O servidor não está com o RCON de pé.');
    }

    const reply = cleanReply(await context.rcon.send(command));

    if (reply === '') {
      throw new KothCommandError(
        'no_plugin',
        'O servidor não respondeu: o OrigemZKoth pode não estar carregado.',
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(reply);
    } catch {
      throw new KothCommandError('bad_reply', `O plugin respondeu algo que não é JSON: ${reply}`);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new KothCommandError('bad_reply', 'O plugin respondeu um JSON que não é objeto.');
    }

    const payload = parsed as Record<string, unknown>;

    if (payload['ok'] !== true) {
      const reason = typeof payload['error'] === 'string' ? payload['error'] : 'unknown';

      if (options.allow?.includes(reason) === true) return payload;

      const message =
        typeof payload['message'] === 'string' ? payload['message'] : 'O plugin recusou.';

      throw new KothCommandError(reason, message);
    }

    return payload;
  }
}

/**
 * A resposta do comando, sem o que o plugin falou por cima.
 *
 * Mesma defesa do `teams.ts`, e pela mesma razão medida: um `Puts`
 * disparado no frame do comando entra na resposta casada do RCON e
 * quebra o JSON. O plugin já tira o aviso do frame; isto é a segunda
 * tranca.
 */
export function cleanReply(reply: string): string {
  return reply
    .split(SPLIT_LINES)
    .filter((line) => !line.includes(KOTH_MARKER))
    .join('\n')
    .trim();
}
