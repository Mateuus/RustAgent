// ============================================================
//  koth-scheduler.ts  -  o relógio do território.
//
//  ####  POR QUE ELE NÃO É O DA MASMORRA  ####
//
//  O `DungeonScheduler` sabe coisas que só a masmorra tem: a planta
//  escolhida, o ponto com yaw, o comando de construir, o de
//  demolir, e o fato de que o PLUGIN abre a run do nascimento. Nada
//  disso vale aqui.
//
//  O que os dois compartilham é a agenda (`world_events`) e o
//  histórico (`world_event_runs`) — e é por eles que os dois
//  aparecem juntos na mesma tela, que é o que importa para quem
//  olha. Forçar um relógio só faria uma função com dois caminhos
//  inteiros dentro, e a masmorra é a que está em produção.
//
//  ####  QUEM FECHA O EVENTO É O JOGO  ####
//
//  A masmorra tem um `setTimeout` que manda derrubar. Aqui não: o
//  território morre sozinho quando o tempo dele acaba (o
//  `durationSeconds` que viajou no start) ou quando alguém captura,
//  e nos dois casos o plugin avisa. Este relógio só ERGUE.
//
//  ####  UM EVENTO POR SERVIDOR  ####
//
//  Se há qualquer run aberta naquele servidor — masmorra inclusive —
//  o KOTH adia. Dois eventos ao mesmo tempo dividem a população do
//  servidor em dois, e os dois ficam vazios. É a "regra de conflito
//  com masmorras" da spec, no lugar mais barato de aplicá-la.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md §1.
// ============================================================

import type { WorldEventsRepository } from '../db/world-events-repository.js';
import type { Logger } from '../logger.js';
import type { WorldEvent } from '../types/world-events.js';
import { toError } from '../util.js';
import type { KothService } from './koth.js';

/** De quanto em quanto tempo o relógio olha a agenda. */
export const KOTH_TICK_MS = 30_000;

/** Quanto esperar depois de uma recusa. O mesmo do agendador da masmorra. */
export const KOTH_RETRY_MS = 120_000;

export interface KothSchedulerDeps {
  readonly events: WorldEventsRepository;
  readonly koth: KothService;
  /** Quantas vagas de KOTH aquele servidor tem. Ver a migração 092. */
  readonly maxConcurrent: (serverId: string) => number;
  readonly servers: {
    readonly ids: () => readonly string[];
    /** `null` = o agente não conseguiu contar. Adiar é o certo. */
    readonly onlineCount: (serverId: string) => Promise<number | null>;
  };
  readonly logger: Logger;
  readonly intervalMs?: number | undefined;
  readonly random?: (() => number) | undefined;
}

export class KothScheduler {
  readonly #deps: KothSchedulerDeps;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;
  #stopped = false;

  constructor(deps: KothSchedulerDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#timer !== null) return;

    void this.tick();

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#deps.intervalMs ?? KOTH_TICK_MS);
  }

  stop(): void {
    this.#stopped = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Uma volta. Nunca lança: uma exceção aqui mataria o laço. */
  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;

    this.#ticking = true;

    try {
      const now = Date.now();

      for (const event of this.#deps.events.list()) {
        if (event.kind !== 'koth') continue;

        try {
          await this.#tickEvent(event, now);
        } catch (cause) {
          // Um evento com problema não pode calar os outros.
          this.#deps.logger.warn(
            { event: event.id, error: toError(cause).message },
            'o KOTH agendado não pôde ser avaliado agora',
          );
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #tickEvent(event: WorldEvent, now: number): Promise<void> {
    if (!event.enabled || event.spawnMode !== 'schedule') return;

    const known = new Set(this.#deps.servers.ids());

    for (const serverId of event.servers) {
      if (!known.has(serverId)) continue;

      await this.#tickServer(event, serverId, now);
    }
  }

  async #tickServer(event: WorldEvent, serverId: string, now: number): Promise<void> {
    const scheduled = this.#deps.events.scheduledRun(event.id, serverId);

    if (scheduled === null) {
      // Sem compromisso: marca o próximo e vai embora. O primeiro
      // também espera o intervalo — um evento que nasce no instante
      // em que o admin o cria surpreende o servidor.
      this.#schedule(event, serverId, now);
      return;
    }

    if ((scheduled.scheduledFor ?? 0) > now) return;

    const refusal = await this.#whyNot(event, serverId);

    if (refusal !== null) {
      this.#deps.events.rescheduleRun(scheduled.id, now + KOTH_RETRY_MS);

      this.#deps.logger.debug(
        { event: event.id, server: serverId, reason: refusal },
        'KOTH adiado',
      );

      return;
    }

    // ####  O COMPROMISSO FECHA ANTES DE ERGUER  ####
    //
    // O `start` abre uma run PRÓPRIA, com posição e grade. Deixar o
    // compromisso aberto faria o mesmo evento contar duas vezes no
    // histórico — a lição do agendador da masmorra, e aqui ela vale
    // igual.
    this.#deps.events.endRun(scheduled.id, 'ended');

    try {
      const started = await this.#deps.koth.start({ serverId, eventId: event.id });

      this.#deps.logger.info(
        { event: event.id, server: serverId, arena: started.arena.label, grid: started.grid },
        'KOTH agendado erguido',
      );
    } catch (cause) {
      // A tentativa vira uma falha com nome, e o evento continua na
      // agenda: amanhã ele acontece.
      this.#deps.events.failRun({
        eventId: event.id,
        serverId,
        dungeonId: null,
        reason: 'no_position',
      });

      this.#deps.logger.warn(
        { event: event.id, server: serverId, error: toError(cause).message },
        'o KOTH agendado não nasceu',
      );
    }

    if (!event.countAfterEnd) this.#schedule(event, serverId, now);
  }

  /**
   * Por que este nascimento não pode acontecer agora?
   *
   * `null` = pode. Toda recusa aqui produz um ADIAMENTO, nunca um
   * cancelamento: a condição pode melhorar em dois minutos, e um
   * evento que perde a vez porque o servidor esvaziou por um
   * instante é um evento que quase nunca acontece.
   */
  async #whyNot(event: WorldEvent, serverId: string): Promise<string | null> {
    // ####  AS VAGAS  ####
    //
    // Era "já há um evento de pé, adie". Agora o limite é do ADMIN:
    // ele diz quantos KOTH cabem no servidor dele, e o relógio só
    // adia quando todas as vagas estão ocupadas.
    //
    // A razão do limite continua verdadeira — dois eventos dividem a
    // população e os dois ficam vazios —, mas quem conhece o servidor
    // é quem cuida dele.
    const vagas = this.#deps.maxConcurrent(serverId);
    const ocupadas = this.#deps.koth.liveCount(serverId);

    if (ocupadas >= vagas) {
      return `as ${String(vagas)} vaga(s) de KOTH estão ocupadas`;
    }

    // A masmorra continua sendo bloqueio: ela é de outra família, e
    // duas famílias ao mesmo tempo é a divisão de população que o
    // limite acima existe para evitar.
    const active = this.#deps.events.activeRun(serverId);

    if (active !== null && active.dungeonId !== null) return 'há uma masmorra de pé';

    const online = await this.#deps.servers.onlineCount(serverId);

    if (online === null) return 'não sei quantos estão online';

    if (online < event.minOnline) {
      return `${String(online)} online, e o mínimo é ${String(event.minOnline)}`;
    }

    // ####  O TERRITÓRIO É CONFERIDO AQUI, E NÃO SÓ NO START  ####
    //
    // Erguer sem território devolve erro, e o erro viraria uma FALHA
    // no histórico — "não nasceu" com cara de defeito. Sem território
    // cadastrado não é defeito: é configuração que falta, e o certo é
    // adiar em silêncio até alguém cadastrar.
    if (!this.#deps.koth.hasArena(serverId)) return 'nenhum território disponível';

    return null;
  }

  /** Marca o próximo nascimento, a partir de `from`. */
  #schedule(event: WorldEvent, serverId: string, from: number): void {
    const random = this.#deps.random ?? Math.random;
    const span = event.interval.max - event.interval.min;
    const seconds = event.interval.min + Math.floor(random() * (span + 1));

    this.#deps.events.scheduleRun({
      eventId: event.id,
      serverId,
      dungeonId: null,
      at: from + seconds * 1000,
    });
  }
}
