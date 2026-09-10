// ============================================================
//  scheduler.ts  -  o relógio que faz a masmorra nascer sozinha.
//
//  Pedido do dono em 09/09/2026: "temos que fazer um sistema de
//  ativação, sheduler etc.".
//
//  ####  ELE MORA NO AGENTE, E NÃO NUM PLUGIN  ####
//
//  A mesma razão do `WipeScheduler`: um relógio dentro do jogo não
//  roda com o Oxide quebrado, com o servidor parado ou durante um
//  download do SteamCMD. O agente é um processo separado e continua
//  contando.
//
//  ####  O COMPROMISSO É UMA LINHA, E NÃO UM TIMER  ####
//
//  Guardar "daqui a 42 minutos" na memória é o defeito que o wipe
//  já pagou: reiniciar o agente matava a execução em curso. Aqui, o
//  próximo nascimento é uma run `scheduled` com `scheduled_for` —
//  reiniciar não muda nada, e a agenda é consultável.
//
//  Isso também é o que faz o `dueRuns` olhar para TRÁS: um agente
//  que ficou fora uma hora volta com compromissos vencidos, e eles
//  são cumpridos, não esquecidos.
//
//  ####  O TICK NUNCA LANÇA  ####
//
//  Rodando num `setInterval`, uma exceção sem dono mata o laço — e
//  a partir dali nenhum evento acontece, em SILÊNCIO, que é o pior
//  desfecho possível para um relógio. Cada evento é tratado dentro
//  do seu próprio `try`.
//
//  ####  O QUE ELE NÃO FAZ  ####
//
//  Não escolhe ONDE: isso é dos pontos de nascimento
//  (`dungeon-spawn-points-repository.ts`), e um evento cujo
//  servidor não tem ponto nenhum é adiado com um aviso — nunca
//  erguido em (0,0), que é quase sempre oceano.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §2.
// ============================================================

import type { DungeonSpawnPointsRepository, SpawnPoint } from '../db/dungeon-spawn-points-repository.js';
import type { WorldEventsRepository } from '../db/world-events-repository.js';
import type { Logger } from '../logger.js';
import type { EventRun, WorldEvent } from '../types/world-events.js';
import { toError } from '../util.js';
import type { DungeonBuildAttempt, DungeonBuildInput } from './sync.js';

/** De quanto em quanto tempo ele acorda. */
export const EVENT_TICK_MS = 30_000;

/**
 * Quanto tempo um adiamento dura.
 *
 * Servidor vazio, sem ponto de nascimento, RCON fora: o evento
 * volta a tentar daqui a pouco em vez de perder a vez. Curto o
 * bastante para o evento acontecer assim que a condição melhorar,
 * longo o bastante para não martelar um servidor parado.
 */
export const RETRY_DELAY_MS = 2 * 60_000;

export interface DungeonSchedulerDeps {
  readonly events: WorldEventsRepository;
  readonly spawnPoints: DungeonSpawnPointsRepository;
  /** Os servidores deste agente, lidos a cada tick. */
  readonly servers: {
    readonly ids: () => readonly string[];
    /**
     * Quantos jogadores estão online ali.
     *
     * `null` = não deu para perguntar, e nunca zero: dizer "0
     * jogadores" num servidor cheio porque o RCON piscou faria o
     * evento ser adiado sem motivo. É a mesma promessa do
     * `onlinePlayersOf` do agente.
     */
    readonly onlineCount: (serverId: string) => Promise<number | null>;
    /** `"<worldSize>:<seed>"` do mundo carregado. Ver os pontos. */
    readonly worldKey: (serverId: string) => string | null;
  };
  /** Manda erguer. É o mesmo caminho do botão do painel. */
  readonly build: (serverId: string, input: DungeonBuildInput) => Promise<DungeonBuildAttempt>;
  /** Manda derrubar. É o mesmo caminho do "parar" do painel. */
  readonly demolish: (serverId: string, reason: string) => Promise<boolean>;
  readonly logger: Logger;
  readonly intervalMs?: number | undefined;
  /**
   * O sorteio.
   *
   * Injetável só para o teste poder cravar o resultado: um
   * agendador com sorteio real produz um teste que passa nove
   * vezes em dez, que é o mesmo que um teste quebrado.
   */
  readonly random?: () => number;
}

export class DungeonScheduler {
  readonly #deps: DungeonSchedulerDeps;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;
  #stopped = false;

  constructor(deps: DungeonSchedulerDeps) {
    this.#deps = deps;
  }

  /**
   * Começa a contar.
   *
   * O primeiro tick é IMEDIATO, e é ele que cumpre o que venceu
   * enquanto o agente estava fora — ver `recover`.
   */
  start(): void {
    if (this.#timer !== null) return;

    void this.recover();

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#deps.intervalMs ?? EVENT_TICK_MS);
  }

  stop(): void {
    this.#stopped = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * O que fazer com o que ficou pendurado enquanto o agente esteve
   * fora do ar.
   *
   * ####  UMA MASMORRA NÃO SOBREVIVE A UM AGENTE PARADO  ####
   *
   * Nem a um servidor parado: nada dela entra no save do mundo, e o
   * plugin a derruba ao descarregar. Então toda run que ficou
   * `active` de uma vida anterior deste processo está morta no
   * jogo — e mantê-la aberta no banco faria o painel dizer "1 no
   * ar" com o mapa vazio, para sempre.
   *
   * Elas são fechadas como `ended`. Os compromissos vencidos, esses
   * continuam valendo: o `tick` os cumpre.
   */
  async recover(): Promise<void> {
    if (this.#stopped) return;

    try {
      // Tudo que estava de pé: o corte é AGORA, e não uma duração —
      // qualquer run aberta antes deste processo subir é passado.
      const orphans = this.#deps.events.overdueRuns(Date.now());

      for (const run of orphans) {
        this.#deps.events.endRun(run.id, 'ended');

        this.#deps.logger.info(
          { run: run.id, event: run.eventId, server: run.serverId },
          'run fechada no boot: nada da masmorra sobrevive a um agente parado',
        );
      }
    } catch (cause) {
      this.#deps.logger.warn(
        { error: toError(cause).message },
        'não consegui limpar as runs abertas no boot',
      );
    }

    await this.tick();
  }

  /** Uma volta. Nunca lança: ver o cabeçalho. */
  async tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return;

    this.#ticking = true;

    try {
      const now = Date.now();

      for (const event of this.#deps.events.list()) {
        try {
          await this.#tickEvent(event, now);
        } catch (cause) {
          // Um evento com problema não pode calar os outros.
          this.#deps.logger.warn(
            { event: event.id, error: toError(cause).message },
            'o evento não pôde ser avaliado agora',
          );
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #tickEvent(event: WorldEvent, now: number): Promise<void> {
    // Um evento desligado, sem masmorra ou fora do modo agendado
    // não tem compromisso nenhum a cumprir. `manual` é o botão do
    // painel; `permanent` é plantado à mão e fica até o wipe.
    if (!event.enabled || event.dungeonId === null || event.spawnMode !== 'schedule') return;

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
      // nascimento também espera o intervalo — um evento que nasce
      // no instante em que o admin o cria surpreende o servidor.
      this.#schedule(event, serverId, now);
      return;
    }

    if ((scheduled.scheduledFor ?? 0) > now) return;

    const refusal = await this.#whyNot(event, serverId);

    if (refusal !== null) {
      this.#deps.events.rescheduleRun(scheduled.id, now + RETRY_DELAY_MS);

      this.#deps.logger.debug(
        { event: event.id, server: serverId, reason: refusal },
        'nascimento adiado',
      );

      return;
    }

    await this.#spawn(event, serverId, scheduled, now);
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
    // Já há uma masmorra de pé ali. O plugin também recusaria — o
    // limite é dele, um por servidor —, mas gastar um comando de
    // RCON para ouvir "não" é desperdício.
    if (this.#deps.events.activeRun(serverId) !== null) return 'já há uma masmorra de pé';

    const online = await this.#deps.servers.onlineCount(serverId);

    // `null` = o agente não conseguiu contar. Adiar é o certo:
    // erguer no escuro pode significar erguer para ninguém.
    if (online === null) return 'não sei quantos estão online';

    if (online < event.minOnline) {
      return `${String(online)} online, e o mínimo é ${String(event.minOnline)}`;
    }

    if (this.#pointsOf(serverId).length === 0) return 'nenhum ponto de nascimento marcado';

    return null;
  }

  async #spawn(
    event: WorldEvent,
    serverId: string,
    scheduled: EventRun,
    now: number,
  ): Promise<void> {
    const spot = this.#chooseSpot(serverId);

    if (spot === null) {
      this.#deps.events.rescheduleRun(scheduled.id, now + RETRY_DELAY_MS);
      return;
    }

    // ####  MARCA ANTES DE MANDAR  ####
    //
    // O comando pode demorar. Um tick que entrasse no meio veria o
    // compromisso ainda `scheduled` e mandaria construir de novo —
    // e o plugin recusaria a segunda, mas o histórico ganharia uma
    // falha que ninguém provocou.
    if (!this.#deps.events.markSpawning(scheduled.id, now)) return;

    const attempt = await this.#deps.build(serverId, {
      slug: event.dungeonId ?? '',
      x: spot.x,
      z: spot.z,
      yaw: spot.yaw,
    });

    if (!attempt.sent) {
      // O compromisso vira uma falha com nome, e o próximo é
      // marcado: o evento continua acontecendo amanhã.
      this.#deps.events.endRun(scheduled.id, 'failed');
      this.#deps.events.failRun({
        eventId: event.id,
        serverId,
        dungeonId: event.dungeonId,
        reason: attempt.refused === 'water' ? 'no_position' : 'build_timeout',
      });

      this.#schedule(event, serverId, now);

      this.#deps.logger.warn(
        { event: event.id, server: serverId, refused: attempt.refused },
        'a masmorra agendada não nasceu',
      );

      return;
    }

    this.#deps.spawnPoints.markUsed(serverId, spot.id);

    // ####  A RUN DO NASCIMENTO É A DO PLUGIN, NÃO ESTA  ####
    //
    // O `built` do stream abre uma run `active` com as peças, a
    // grade e a semente — dados que só ele tem. Este compromisso
    // termina aqui, cumprido; deixá-lo aberto faria o mesmo
    // nascimento contar duas vezes no histórico.
    this.#deps.events.endRun(scheduled.id, 'ended');

    // A duração é sorteada AGORA e vira o compromisso de derrubar.
    const duration = this.#pick(event.duration.min, event.duration.max) * 1000;

    setTimeout(() => {
      void this.#close(event, serverId, duration);
    }, duration).unref?.();

    // E o próximo nascimento já entra na agenda, a não ser que o
    // evento peça para contar só depois que este acabar.
    if (!event.countAfterEnd) this.#schedule(event, serverId, now + duration);

    this.#deps.logger.info(
      {
        event: event.id,
        server: serverId,
        dungeon: event.dungeonId,
        spot: spot.label,
        minutes: Math.round(duration / 60_000),
      },
      'masmorra agendada mandada erguer',
    );
  }

  /**
   * A hora de fechar.
   *
   * ####  ELE NÃO É A ÚNICA DEFESA  ####
   *
   * Este `setTimeout` morre com o processo. O que garante que uma
   * masmorra não fique de pé para sempre é o `recover` do boot
   * seguinte, que fecha toda run que sobrou de uma vida anterior.
   */
  async #close(event: WorldEvent, serverId: string, duration: number): Promise<void> {
    if (this.#stopped) return;

    try {
      const active = this.#deps.events.activeRun(serverId);

      if (active === null) return;

      await this.#deps.demolish(serverId, 'agenda');

      this.#deps.logger.info(
        { event: event.id, server: serverId, minutes: Math.round(duration / 60_000) },
        'a masmorra agendada terminou',
      );

      if (event.countAfterEnd) this.#schedule(event, serverId, Date.now());
    } catch (cause) {
      this.#deps.logger.warn(
        { event: event.id, server: serverId, error: toError(cause).message },
        'não consegui fechar a masmorra agendada',
      );
    }
  }

  /** Marca o próximo nascimento, a partir de `from`. */
  #schedule(event: WorldEvent, serverId: string, from: number): void {
    const seconds = this.#pick(event.interval.min, event.interval.max);

    this.#deps.events.scheduleRun({
      eventId: event.id,
      serverId,
      dungeonId: event.dungeonId,
      at: from + seconds * 1000,
    });
  }

  /**
   * Qual ponto usar.
   *
   * ####  O ÚLTIMO USADO FICA POR ÚLTIMO  ####
   *
   * Sem isso, um servidor com três pontos veria a masmorra nascer
   * duas vezes seguidas no mesmo lugar em um terço das vezes — e
   * quem estava lá na primeira já sabe o caminho.
   */
  #chooseSpot(serverId: string): SpawnPoint | null {
    const points = this.#pointsOf(serverId);

    if (points.length === 0) return null;
    if (points.length === 1) return points[0] ?? null;

    const last = points.reduce<SpawnPoint | null>(
      (latest, point) =>
        point.lastUsedAt === null
          ? latest
          : latest === null || point.lastUsedAt > (latest.lastUsedAt ?? 0)
            ? point
            : latest,
      null,
    );

    const candidates = points.filter((point) => point.id !== last?.id);
    const pool = candidates.length > 0 ? candidates : points;
    const index = Math.min(pool.length - 1, Math.floor(this.#roll() * pool.length));

    return pool[index] ?? null;
  }

  #pointsOf(serverId: string): readonly SpawnPoint[] {
    return this.#deps.spawnPoints.usable(serverId, this.#deps.servers.worldKey(serverId));
  }

  /** Um inteiro entre os dois, inclusive nas pontas. */
  #pick(min: number, max: number): number {
    if (max <= min) return min;

    return min + Math.floor(this.#roll() * (max - min + 1));
  }

  #roll(): number {
    return (this.#deps.random ?? Math.random)();
  }
}
