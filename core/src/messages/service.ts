// ============================================================
//  service.ts  -  o relógio de 30 segundos.
//
//  UM `setInterval` por processo. Não por mensagem, e não por
//  servidor: ele acorda, pergunta ao banco quem venceu, e manda.
//
//  Trinta segundos é o atraso MÁXIMO entre "deu a hora" e "saiu no
//  chat", e é barato: uma consulta indexada e uma comparação de
//  números. Um timer por mensagem seria mais preciso e obrigaria a
//  recriar todos eles a cada gravação na tela — que é o caminho
//  para um timer órfão continuar falando depois de a mensagem ser
//  apagada.
//
//  ------------------------------------------------------------
//  ####  O `tick` NUNCA LANÇA  ####
//
//  É a regra que manda neste arquivo. Rodando num `setInterval`,
//  uma exceção sem dono mata o laço e as mensagens param EM
//  SILÊNCIO — o pior desfecho possível para algo cuja única
//  evidência de funcionamento é aparecer no chat.
//
//  Ele DEVOLVE o que aconteceu. Os testes leem isso, e o log
//  também.
//
//  ------------------------------------------------------------
//  ####  RCON OFFLINE E SERVIDOR VAZIO NÃO CONSOMEM O HORÁRIO  ####
//
//  `next_at` fica como está, e a próxima volta tenta de novo. É a
//  diferença entre "sai assim que o servidor voltar" e "some até a
//  semana que vem" — e, no caso do servidor vazio, é o que faz o
//  primeiro jogador a entrar receber a mensagem logo, em vez de
//  esperar meia hora porque o contador correu sozinho num servidor
//  sem ninguém.
//
//  ------------------------------------------------------------
//  ####  E COM VÁRIOS ALVOS, UM ENTREGUE BASTA  ####
//
//  Uma mensagem de rede sai em N servidores. Exigir que TODOS
//  aceitem para marcar o horário como consumido faria um servidor
//  parado há meses calar a mensagem nos outros quatro — e a
//  primeira volta depois de ele voltar despejaria tudo de uma vez.
//
//  Entregou em pelo menos um, o horário anda. Não entregou em
//  nenhum, ele fica. O que aconteceu em CADA servidor está no
//  `message_log`.
// ============================================================

import type { MessageLogEntry, MessagesRepository } from '../db/messages-repository.js';
import type { Broadcaster } from '../game/broadcast.js';
import type { Logger } from '../logger.js';
import type { MessageView } from '../types/messages.js';
import { toError } from '../util.js';
import { advanceAfterSend, isWithinWindow, nextOccurrence } from './schedule.js';
import type { VariableRegistry } from './variables.js';

/** De quanto em quanto tempo o laço ACORDA. Ver o cabeçalho. */
export const MESSAGES_TICK_MS = 30_000;

/**
 * Quantas linhas de log ficam por mensagem.
 *
 * Uma mensagem de 30 em 30 minutos em três servidores escreve 144
 * linhas por dia. Duzentas cobrem o que se olha ("saiu hoje? e
 * ontem?") e mantêm a tabela pequena para sempre.
 */
export const MESSAGE_LOG_KEEP = 200;

/** De quantas em quantas voltas o log é podado. 120 × 30 s = 1 h. */
const PRUNE_EVERY_TICKS = 120;

/** O que o motor precisa saber dos servidores. */
export interface MessagesServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: { readonly isConnected: boolean } } | null;
}

/**
 * Quantos jogadores estão online.
 *
 * `null` = não deu para perguntar, e é DIFERENTE de zero: com
 * `null` a mensagem NÃO sai e o horário NÃO anda, porque não dá
 * para afirmar que o servidor está vazio.
 */
export interface MessagesPresence {
  online(serverId: string): Promise<number | null>;
}

export interface MessagesServiceDeps {
  readonly repository: MessagesRepository;
  readonly broadcaster: Broadcaster;
  readonly variables: VariableRegistry;
  readonly servers: MessagesServers;
  readonly presence: MessagesPresence;
  readonly logger?: Logger | undefined;
  /** Injetável no teste — é como se atravessa uma virada de mês. */
  readonly now?: (() => number) | undefined;
}

/** O que aconteceu com UMA mensagem numa volta do relógio. */
export interface MessageTickResult {
  readonly messageId: number;
  readonly name: string;
  /** Em quais servidores ela saiu. */
  readonly delivered: readonly string[];
  /**
   * Em quais ela nem foi tentada, e por quê: `rcon-offline`,
   * `server-empty`, `unknown-server`.
   */
  readonly skipped: readonly { readonly serverId: string; readonly reason: string }[];
  /** Onde a entrega foi tentada e falhou. */
  readonly failed: readonly { readonly serverId: string; readonly error: string }[];
  /** O horário foi consumido? */
  readonly consumed: boolean;
  /** O `next_at` gravado depois desta volta. */
  readonly nextAt: number | null;
}

/** O resumo de uma volta inteira. */
export interface TickSummary {
  readonly at: number;
  /** Quantas venceram. */
  readonly due: number;
  readonly results: readonly MessageTickResult[];
  /**
   * A volta quebrou de um jeito que ninguém previu.
   *
   * Preenchido, o laço continua vivo: é justamente para isso que
   * este campo existe em vez de uma exceção.
   */
  readonly error: string | null;
}

/** O desfecho de "mandar agora", do botão de testar. */
export interface MessageSendReport {
  readonly serverId: string;
  readonly ok: boolean;
  readonly players: number;
  readonly via: 'plugin' | 'say' | null;
  readonly text: string;
  readonly error: string | null;
}

export class MessagesService {
  readonly #deps: MessagesServiceDeps;
  readonly #now: () => number;

  #timer: ReturnType<typeof setInterval> | null = null;
  #ticks = 0;

  constructor(deps: MessagesServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    const timer = setInterval(() => {
      void this.tick();
    }, MESSAGES_TICK_MS);

    // unref: uma mensagem de chat não é motivo para o processo
    // continuar vivo durante o desligamento.
    timer.unref?.();
    this.#timer = timer;

    const all = this.#deps.repository.list();

    this.#deps.logger?.info(
      { messages: all.length, enabled: all.filter((message) => message.enabled).length },
      'o agendador de mensagens está no ar (uma volta a cada 30 s)',
    );
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma volta do relógio. **NUNCA LANÇA.**
   *
   * O `try` de fora não é zelo: ele é o que mantém o laço vivo
   * quando o banco recusa uma escrita, quando um provedor de
   * variável estoura, ou quando aparece o defeito que ninguém
   * previu. Um `catch {}` vazio seria o oposto — aqui o erro vira
   * campo do retorno E linha de log.
   */
  async tick(): Promise<TickSummary> {
    const at = this.#now();

    try {
      const due = this.#deps.repository.due(at);
      const results: MessageTickResult[] = [];

      for (const message of due) {
        results.push(await this.#run(message, at));
      }

      this.#ticks += 1;

      if (this.#ticks % PRUNE_EVERY_TICKS === 0) {
        this.#prune();
      }

      return { at, due: due.length, results, error: null };
    } catch (error) {
      const err = toError(error);

      // `error`, e não `warn`: o laço não morreu, mas esta volta
      // não fez o que devia — e nada disso se resolve sozinho.
      this.#deps.logger?.error(
        { err },
        'a volta do agendador de mensagens falhou; o laço continua e a próxima tenta de novo',
      );

      return { at, due: 0, results: [], error: err.message };
    }
  }

  /**
   * Manda AGORA, sem mexer no `next_at`.
   *
   * É o botão "testar agora" da tela. O horário fica exatamente
   * como estava de propósito: testar não pode adiar a próxima
   * saída, senão conferir a mensagem seria mudá-la.
   *
   * Diferente do `tick`, ESTE PODE LANÇAR quando não há alvo
   * nenhum: quem chamou é uma requisição HTTP esperando resposta, e
   * "não existe esse servidor" precisa virar status, não uma linha
   * de log que ninguém vai ler. A falha de ENTREGA, essa, vem no
   * relatório — é o que permite a tela dizer em qual servidor deu
   * certo e em qual não.
   */
  async test(message: MessageView, only?: string): Promise<readonly MessageSendReport[]> {
    const targets = only === undefined ? this.#targetsOf(message) : [only];
    const at = this.#now();
    const reports: MessageSendReport[] = [];

    for (const serverId of targets) {
      reports.push(await this.#deliver(message, serverId, at));
    }

    return reports;
  }

  /**
   * Uma fala avulsa, já com as variáveis resolvidas.
   *
   * É o caminho do `POST /api/chat/broadcast` — e é o MESMO
   * transporte das mensagens agendadas, de propósito. Uma segunda
   * forma de mandar texto ao chat é o que o Docs/17 §10 proíbe.
   */
  async speak(input: {
    readonly serverId: string;
    readonly text: string;
    readonly tag?: string | undefined;
    readonly tagColor?: string | undefined;
    readonly color?: string | undefined;
    readonly size?: number | undefined;
    readonly steamId?: string | undefined;
  }): Promise<{ readonly sent: number; readonly via: 'plugin' | 'say'; readonly text: string }> {
    const text = await this.#deps.variables.resolve(input.text, {
      serverId: input.serverId,
      steamId: input.steamId,
    });

    const result = await this.#deps.broadcaster.send({ ...input, text });

    return { sent: result.sent, via: result.via, text };
  }

  /** As últimas linhas do log daquela mensagem. */
  logOf(messageId: number, limit: number): readonly MessageLogEntry[] {
    return this.#deps.repository.logOf(messageId, limit);
  }

  /**
   * O horário que uma mensagem recém-gravada deve ter.
   *
   * Mora aqui, e não na rota, porque é a mesma conta que o `tick`
   * usa — e o relógio injetado precisa valer para as duas, senão o
   * teste que atravessa uma virada de mês gravaria com o relógio de
   * verdade.
   */
  nextAtFor(shape: Parameters<typeof nextOccurrence>[0], enabled: boolean): number | null {
    // Desligada não tem próxima: deixar um horário gravado faria a
    // mensagem sair na volta seguinte a alguém religá-la, com um
    // horário de semanas atrás.
    return enabled ? nextOccurrence(shape, this.#now()) : null;
  }

  // ----------------------------------------------------------

  /** Uma mensagem vencida, em todos os servidores dela. */
  async #run(message: MessageView, at: number): Promise<MessageTickResult> {
    const skipped: { serverId: string; reason: string }[] = [];
    const failed: { serverId: string; error: string }[] = [];
    const delivered: string[] = [];

    // A janela é da MENSAGEM, e não do servidor: ela vale para
    // todos os alvos de uma vez, e por isso é conferida antes do
    // laço. Fora dela, nada sai e o horário NÃO é consumido.
    if (!isWithinWindow(at, message.windowFrom, message.windowTo, message.timeZone)) {
      return {
        messageId: message.id,
        name: message.name,
        delivered: [],
        skipped: [{ serverId: '*', reason: 'fora-da-janela' }],
        failed: [],
        consumed: false,
        nextAt: message.nextAt,
      };
    }

    const known = new Set(this.#deps.servers.ids());

    for (const serverId of this.#targetsOf(message)) {
      if (!known.has(serverId)) {
        // Alvo de um servidor que saiu da frota. Não é falha de
        // entrega: não há a quem entregar.
        skipped.push({ serverId, reason: 'servidor-desconhecido' });
        continue;
      }

      const reason = await this.#whyNotNow(message, serverId);

      if (reason !== null) {
        // ####  O QUE NÃO FOI TENTADO NÃO VAI PARA O LOG  ####
        //
        // Um servidor parado há uma semana geraria 20 160 linhas de
        // "RCON offline" — e o log existe para responder "essa
        // mensagem está aparecendo?", pergunta que essa enxurrada
        // torna impossível de ler. O motivo fica no retorno da
        // volta, que é onde alguém depurando olha.
        skipped.push({ serverId, reason });
        continue;
      }

      const report = await this.#deliver(message, serverId, at);

      if (report.ok) {
        delivered.push(serverId);
      } else {
        failed.push({ serverId, error: report.error ?? 'falhou' });
      }
    }

    if (delivered.length === 0) {
      // Nada saiu: o horário NÃO é consumido. Ver o cabeçalho.
      return {
        messageId: message.id,
        name: message.name,
        delivered,
        skipped,
        failed,
        consumed: false,
        nextAt: message.nextAt,
      };
    }

    const nextAt = advanceAfterSend(message, message.nextAt, at);

    this.#deps.repository.markSent(message.id, at, nextAt);

    // ####  A `once` SE DESLIGA SOZINHA  ####
    //
    // Uma "manutenção às 03:00" que continuasse ligada reapareceria
    // no mês seguinte, sozinha, sem manutenção nenhuma. `nextAt`
    // null e `once` é o único par em que desligar é o certo — nos
    // outros ritmos, `null` é configuração incompleta, e apagar o
    // `enabled` esconderia isso da tela.
    if (message.scheduleKind === 'once') {
      this.#deps.repository.setEnabled(message.id, false, null, at);
    }

    this.#deps.logger?.info(
      {
        message: message.id,
        name: message.name,
        servers: delivered,
        failed: failed.length,
        nextAt,
      },
      'mensagem agendada entregue',
    );

    return {
      messageId: message.id,
      name: message.name,
      delivered,
      skipped,
      failed,
      consumed: true,
      nextAt: message.scheduleKind === 'once' ? null : nextAt,
    };
  }

  /**
   * Por que esta mensagem não pode sair NESTE servidor agora.
   * `null` = pode.
   *
   * A checagem de RCON aqui é uma decisão de AGENDA, e não de
   * transporte: o `Broadcaster` também recusa sem RCON, mas ali a
   * recusa é uma exceção, e uma exceção por servidor parado viraria
   * linha de log e linha de `message_log` a cada trinta segundos.
   */
  async #whyNotNow(message: MessageView, serverId: string): Promise<string | null> {
    if (this.#deps.servers.contextOf(serverId)?.rcon.isConnected !== true) {
      return 'rcon-offline';
    }

    if (!message.onlyWithPlayers) {
      return null;
    }

    const online = await this.#deps.presence.online(serverId);

    if (online === null) {
      // Não deu para perguntar. Não é zero, e também não é
      // permissão: falar sem saber contraria o que o admin marcou.
      return 'nao-consegui-contar';
    }

    // `min_players` vale a partir de 1: quem marcou "só com
    // jogadores" e deixou zero quis dizer "pelo menos um".
    return online >= Math.max(1, message.minPlayers) ? null : 'servidor-vazio';
  }

  /**
   * Resolve as variáveis e manda, gravando a linha do log.
   *
   * As variáveis são resolvidas POR SERVIDOR: `{servidor}` e
   * `{online}` respondem coisas diferentes em cada um, e resolver
   * uma vez só faria a mensagem anunciar a lotação do vizinho.
   */
  async #deliver(message: MessageView, serverId: string, at: number): Promise<MessageSendReport> {
    let text = message.text;

    try {
      text = await this.#deps.variables.resolve(message.text, { serverId });

      const result = await this.#deps.broadcaster.send({
        serverId,
        text,
        tag: message.tag ?? undefined,
        tagColor: message.tagColor ?? undefined,
        color: message.color ?? undefined,
        size: message.size ?? undefined,
      });

      this.#deps.repository.log({
        messageId: message.id,
        serverId,
        at,
        players: result.sent,
        ok: true,
        error: null,
      });

      return { serverId, ok: true, players: result.sent, via: result.via, text, error: null };
    } catch (error) {
      const err = toError(error);

      this.#deps.repository.log({
        messageId: message.id,
        serverId,
        at,
        players: 0,
        ok: false,
        error: err.message,
      });

      return { serverId, ok: false, players: 0, via: null, text, error: err.message };
    }
  }

  /** Lista vazia = TODOS os servidores. Ver types/messages.ts. */
  #targetsOf(message: MessageView): readonly string[] {
    return message.targets.length === 0 ? this.#deps.servers.ids() : message.targets;
  }

  #prune(): void {
    try {
      const removed = this.#deps.repository.pruneLog(MESSAGE_LOG_KEEP);

      if (removed > 0) {
        this.#deps.logger?.debug({ removed }, 'linhas antigas do log de mensagens podadas');
      }
    } catch (error) {
      // Podar é higiene, e não função. Falhar aqui não pode
      // atrapalhar o envio da próxima volta.
      this.#deps.logger?.warn({ err: toError(error) }, 'não consegui podar o log de mensagens');
    }
  }
}
