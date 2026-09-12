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
   * Vai buscar o número quando o push de conclusão não se sustenta.
   *
   * ####  SEM ISTO, O "AGORA" VIRA "ATÉ UM MINUTO"  ####
   *
   * MEDIDO no servidor em 07/09/2026: o jogador matou o terceiro
   * cientista, o plugin gritou a conclusão, o agente recusou —
   * porque o contador dele ainda estava em 1 — e a quest só fechou
   * 78 segundos depois, no lote do relógio.
   *
   * A recusa está certa: quem paga o prêmio confere com o número
   * próprio. O que estava errado era ESPERAR o relógio depois dela.
   *
   * Ausente = o comportamento antigo (o lote resolve), que é o que
   * os testes usam.
   */
  readonly flushNow?: (serverId: string) => void;
}

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

      // A entrega pode ter fechado a missão — e quem avisa o jogador
      // nesse caso é o `onCompleted` do serviço, que dispara de
      // dentro da transição. Aqui não sobra nada a fazer.
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
      //
      // Mas o primeiro caso não pode ficar esperando o relógio: o
      // push chegou porque alguém acabou de concluir, e o número
      // que falta está no plugin, a uma ida de RCON. Ver `flushNow`.
      //
      // Pedir também na segunda chegada (o lote já fechou) custaria
      // uma ida à toa; por isso a pergunta é feita ao serviço, e
      // não deduzida daqui.
      if (this.#deps.service.viewById(event.pq)?.status === 'active') {
        this.#deps.flushNow?.(serverId);
      }

      return;
    }

    // ####  O RECIBO NÃO MORA MAIS AQUI  ####
    //
    // Ele avisava só quem concluiu pelo PUSH do plugin; quem
    // fechou pelo lote de 60 s, pelo recálculo do tempo online ou
    // pela mão do suporte não recebia nada. O aviso passou para o
    // `onCompleted` do serviço, que é o único ponto por onde os
    // quatro caminhos passam — e que só dispara na transição, o
    // que garante uma mensagem por conclusão.
  }
}
