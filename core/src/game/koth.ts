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

      // ####  O PRÊMIO VIAJA COM O EVENTO  ####
      //
      // O plugin não lê banco nem config: o que ele sabe do prêmio é
      // o que vem neste corpo. Assim um território editado no painel
      // vale no PRÓXIMO evento, sem recarregar plugin nenhum.
      reward: {
        smoke: arena.reward.smoke,
        flare: arena.reward.flare,
        count: arena.reward.count,
        crateSeconds: arena.reward.crateSeconds,
        crates: arena.reward.crates.map((crate) => ({
          prefab: crate.prefab,
          // O plugin chama de `chance` o que aqui é `weight`: é peso
          // de sorteio nos dois lados, e o nome antigo ficou no
          // protocolo. Traduzir aqui, na fronteira, é mais barato que
          // uma migração de nome no `.cs`.
          chance: crate.weight,
        })),
      },
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
      // A tag `[KOTH]` já vem do broadcaster: repetir o nome aqui
      // saía no chat como "[KOTH] KOTH: …".
      `O território <color=#8FBF4F>${arena.label}</color> (${grid}) está aberto. Vá com a sua equipe!`,
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
          `<color=#8FBF4F>${winner}</color> dominou o território!`,
        );

        return;
      }

      case 'expired': {
        this.#closeLocal(serverId, 'ended', 'expired');

        this.#deps.logger.info({ server: serverId }, 'KOTH expirou sem vencedor');

        // Ele também é notícia: quem estava indo para lá precisa saber
        // que não vale mais a pena. O silêncio aqui faria o evento
        // "sumir" sem explicação.
        void this.#say(
          serverId,
          'Ninguém dominou o território a tempo.',
        );

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
   * Acerta o que o agente sabe com o que está no chão.
   *
   * ####  O KOTH SOBREVIVE A UM AGENTE PARADO — A MASMORRA NÃO  ####
   *
   * Esta é a diferença que quase virou bug. A masmorra morre quando o
   * plugin descarrega, então a run dela é lixo garantido no boot
   * seguinte. O KOTH, não: reiniciar o AGENTE não toca no servidor de
   * jogo, e lá o território continua de pé, com o relógio do plugin
   * correndo e a bandeira plantada.
   *
   * Fechar a run cegamente deixaria a bandeira órfã no mapa e o
   * histórico mentindo. Então o agente PERGUNTA, e há três respostas:
   *
   *   de pé, e a run bate     readota — o evento segue, e o desfecho
   *                           ainda vai chegar pelo console
   *   de pé, e ninguém sabe   manda parar: uma bandeira de dono
   *                           desconhecido não some sozinha
   *   nada de pé, run aberta  fecha a run (o servidor reiniciou)
   *
   * Roda no `sync`, e não no boot do agente: é quando o RCON conecta
   * que existe alguém a quem perguntar.
   */
  async reconcile(serverId: string): Promise<void> {
    if (this.#stopped) return;

    const open = this.#deps.events.activeRun(serverId);
    // Uma run de masmorra não é nossa: ela tem `dungeonId`.
    const mine = open !== null && open.dungeonId === null ? open : null;

    let status: KothStatus;

    try {
      status = await this.status(serverId);
    } catch (cause) {
      // Sem resposta não se decide nada. Fechar a run aqui seria
      // apagar o registro de um evento que pode estar acontecendo.
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'não consegui conferir o KOTH do servidor',
      );

      return;
    }

    if (status.active === true) {
      const runId = Number(status.runId ?? '0');

      if (mine !== null && runId === mine.id) {
        this.#live.set(serverId, {
          runId: mine.id,
          arenaId: 0,
          eventId: mine.eventId,
          startedAt: mine.startedAt ?? Date.now(),
        });

        this.#deps.logger.info(
          { server: serverId, run: mine.id },
          'KOTH readotado: ele continuou de pé enquanto o agente reiniciava',
        );

        return;
      }

      // De pé sem dono conhecido. Parar é o certo: ninguém mais vai
      // fechá-lo, e a bandeira ficaria no mapa até o wipe.
      await this.stopRun(serverId, 'orfao');

      this.#deps.logger.warn(
        { server: serverId, runId: status.runId },
        'havia um KOTH de pé que este agente não conhecia: derrubado',
      );

      return;
    }

    if (mine !== null) {
      this.#deps.events.endRun(mine.id, 'ended');

      this.#deps.logger.info(
        { server: serverId, run: mine.id },
        'run de KOTH fechada: não há território de pé no servidor',
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

      // Com o canal aberto, acerta o que o agente sabe com o que está
      // no chão. Ver `reconcile`.
      await this.reconcile(serverId);
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
