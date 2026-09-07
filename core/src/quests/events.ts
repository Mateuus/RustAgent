// ============================================================
//  events.ts  -  o `#OZQUEST#` que o plugin grita, e o recibo que
//  o jogador lê na hora.
//
//  ####  POR QUE EXISTEM DOIS CANAIS  ####
//
//  O lote de 60 s (quests/collector.ts) é o "garantido": nada se
//  perde, o `batchId` congela e o `ack` descarta. Mas ele NÃO
//  serve para o instante da conclusão — concluir uma missão e não
//  ver nada acontecer é o que faz o jogador achar que o sistema
//  está quebrado, e reclamar antes do próximo lote.
//
//  Este arquivo é o "agora". Ele é como UDP: perdeu o frame,
//  perdeu o instante — nunca o dado, porque o lote vem atrás.
//
//  ------------------------------------------------------------
//  ####  ELE NÃO ACREDITA NO PLUGIN  ####
//
//  O push diz "a tentativa 8412 fechou". O `reportCompletion` do
//  serviço CONFERE com o número do agente antes de mudar qualquer
//  coisa. Um `oxide.reload` no meio do lote esvazia o cache do
//  plugin sem derrubar o RCON — para o agente, nada aconteceu — e
//  sem essa conferência a conclusão sairia de um contador
//  incompleto.
//
//  ------------------------------------------------------------
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO  ####
//
//  MEDIDO neste projeto (`core/src/index.ts:309-319`): um comando
//  de RCON mandado de dentro do `onConsoleLine` imprime no console,
//  a linha volta pelo mesmo caminho e dispara de novo — o console
//  do jogo virou um paredão de `loadout.sync` repetido no dia em
//  que isso aconteceu.
//
//  Daí o `handleLine` aqui aplicar no SQLite (que não fala com o
//  jogo) e ARMAR UM RELÓGIO para o recibo. Mesmo desenho do
//  `stat-events.ts`, do `custom-items-sync.ts` e do `ui-sync.ts`.
//
//  ------------------------------------------------------------
//  ####  E O CHAT PASSA PELO MESMO CANO  ####
//
//  O `onConsoleLine` recebe o chat dos jogadores junto com o resto.
//  Sem defesa, digitar `#OZQUEST#{…}` no chat seria concluir a
//  própria missão. O segredo é sorteado a cada subida e viaja no
//  `watch` — quem não o tem não passa, e a recusa é SILENCIOSA:
//  alguém testando o marcador não pode encher o log de alarme.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §8.5 e §9.
// ============================================================

import { parseQuestPush, type QuestPushEvent } from '../game/quests-contract.js';
import type { Logger } from '../logger.js';
import type { QuestsService } from './service.js';

/** Como o recibo chega ao jogador. */
export interface QuestChat {
  /** Uma linha no chat DELE. Nunca no de todo mundo. */
  tell(serverId: string, steamId: string, message: string): Promise<void>;
}

export interface QuestEventsDeps {
  readonly service: QuestsService;
  readonly logger: Logger;
  /** O segredo que autentica o marcador. Ver o cabeçalho. */
  readonly secret: string;
  readonly chat?: QuestChat;
  /**
   * Quanto esperar antes de falar com o jogo.
   *
   * Zero seria dentro do gancho — o laço de console. Ver o
   * cabeçalho. O valor é pequeno porque o recibo precisa parecer
   * imediato.
   */
  readonly replyDelayMs?: number;
}

const DEFAULT_REPLY_DELAY_MS = 50;

export class QuestEvents {
  readonly #deps: QuestEventsDeps;
  /** Os relógios armados, para poder cancelá-los na parada. */
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(deps: QuestEventsDeps) {
    this.#deps = deps;
  }

  /**
   * Uma linha do console daquele servidor.
   *
   * ####  ELA NÃO PODE LANÇAR, NUNCA  ####
   *
   * Roda no mesmo handler que recebe TODA linha do servidor. Uma
   * exceção subiria por um caminho que ninguém trata e levaria
   * junto o processamento do resto do stream.
   *
   * @returns `true` quando a linha era um push nosso e foi tratada.
   */
  handleLine(serverId: string, line: string): boolean {
    let event: QuestPushEvent | null;

    try {
      event = parseQuestPush(line, this.#deps.secret);
    } catch {
      // O `parseQuestPush` já trata JSON quebrado; isto é a rede de
      // segurança para o inesperado.
      return false;
    }

    if (event === null) {
      return false;
    }

    try {
      this.#apply(serverId, event);
    } catch (error) {
      this.#deps.logger.warn(
        { server: serverId, pq: event.pq, err: error },
        'não consegui aplicar um evento de missão; o lote resolve',
      );
    }

    return true;
  }

  /** Cancela os relógios armados. Chamado na parada do agente. */
  stop(): void {
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }

    this.#timers.clear();
  }

  // ------------------------------------------------------

  #apply(serverId: string, event: QuestPushEvent): void {
    if (event.kind === 'progress') {
      // O marco (25/50/75%) não muda nada no banco: o número de
      // verdade vem no lote. Ele existe só para o recibo — e por
      // isso não vale um `INSERT` a cada pedra minerada.
      return;
    }

    // A escrita acontece AQUI, na pilha do gancho: SQLite não fala
    // com o jogo, então não há laço a temer.
    //
    // ####  A ENTREGA TEM CAMINHO PRÓPRIO  ####
    //
    // Ela é o único objetivo que o agente não tem como contar
    // sozinho — só o plugin sabe que o jogador chegou ao NPC. O
    // `reportDelivery` confere o CONTRATO (existe um objetivo de
    // entrega apontando para este NPC?) e marca; a conclusão segue
    // pelo mesmo caminho das outras.
    //
    // O `meters` que vem no push é IGNORADO de propósito: quem mede
    // a distância é o agente, com as coordenadas do banco. Ver
    // `deliveryDistanceOf`.
    if (event.kind === 'deliver') {
      if (event.npcId === undefined) {
        return;
      }

      this.#deps.service.reportDelivery({
        playerQuestId: event.pq,
        npcId: event.npcId,
        eventId: event.eventId,
      });

      // O recibo da entrega sai pelo caminho normal se ela fechou a
      // missão — e a leitura abaixo é quem descobre isso.
      const view = this.#deps.service.viewById(event.pq);

      if (view?.status === 'completed') {
        this.#later(() => this.#receipt(serverId, event));
      }

      return;
    }

    const closed = this.#deps.service.reportCompletion({
      playerQuestId: event.pq,
      eventId: event.eventId,
    });

    if (!closed) {
      // O agente discorda do plugin, ou o lote já tinha fechado. Os
      // dois são o caso NORMAL deste desenho — sem recibo, e sem
      // linha de alarme.
      return;
    }

    // E o relógio para falar com o jogo. Ver o cabeçalho.
    this.#later(() => this.#receipt(serverId, event));
  }

  async #receipt(serverId: string, event: QuestPushEvent): Promise<void> {
    const chat = this.#deps.chat;

    if (chat === undefined) {
      return;
    }

    // O título vem do SNAPSHOT da tentativa — o que o jogador
    // aceitou —, e não da quest de hoje, que pode ter sido
    // renomeada no meio.
    const view = this.#deps.service.viewById(event.pq);

    if (view === null) {
      return;
    }

    try {
      await chat.tell(
        serverId,
        event.steamId,
        `Missão concluída: ${view.title}. Abra /quest para resgatar.`,
      );
    } catch (error) {
      // O recibo é conforto, não contrato: a missão está concluída
      // no banco de qualquer jeito, e a tela mostra o botão de
      // resgatar quando ele abrir.
      this.#deps.logger.debug(
        { server: serverId, steamId: event.steamId, err: error },
        'não deu para mandar o recibo da missão',
      );
    }
  }

  #later(action: () => Promise<void> | void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void action();
    }, this.#deps.replyDelayMs ?? DEFAULT_REPLY_DELAY_MS);

    // `unref` para o relógio não segurar o processo na saída: um
    // recibo pendente não pode impedir o agente de parar.
    timer.unref();
    this.#timers.add(timer);
  }
}
