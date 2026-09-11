// ============================================================
//  agent-requests.ts  -  o OrigemZAgent pedindo o estado de volta.
//
//  ####  O PEDIDO EXISTIA, E NINGUÉM RESPONDIA  ####
//
//  Um `oxide.reload OrigemZAgent` ESVAZIA os caches do plugin — VIP,
//  kits, status de nascimento, timers — sem derrubar o RCON. Para o
//  agente nada aconteceu, e o `onRconConnected` não roda. Por isso o
//  plugin grita, no boot dele:
//
//      [OrigemZAgent] #OZAREQ#{"want":"loadouts"}
//
//  e o cabeçalho do `RequestMarker` (OrigemZAgent.cs) promete que o
//  agente responde empurrando o estado na hora. CONFERIDO em
//  11/09/2026, lendo o core inteiro: nenhum pedaço do agente escutava
//  esse formato. O `#OZAREQ#items` do OrigemZItems tinha dono
//  (custom-items-sync.ts); o do hub, não. O VIP ainda voltava pelo
//  relógio do `VipExpiryWatcher`, mas o kit e o status só voltavam
//  na próxima queda do RCON — e quem nascia no meio-tempo nascia com
//  a tocha e a pedra, que é o aviso que o OrigemZPlayer imprime.
//
//  Os timers entraram nesse caminho, e ficar sem resposta ali seria
//  voltar ao ×1 depois de todo reload. Então o pedido ganhou dono.
//
//  ------------------------------------------------------------
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO  ####
//
//  MEDIDO neste projeto: um comando de RCON mandado de dentro do
//  `onConsoleLine` imprime no console, a linha volta pelo mesmo
//  caminho e dispara de novo — o console do jogo virou um paredão de
//  `loadout.sync` repetido no dia em que isso aconteceu. O
//  `handleLine` daqui só ARMA UM RELÓGIO; o envio sai dele. Mesmo
//  desenho do `custom-items-sync.ts`.
//
//  ####  E O CHAT PASSA PELO MESMO CANO  ####
//
//  O `onConsoleLine` recebe o chat dos jogadores junto com o resto.
//  A âncora é a mesma do `stat-events.ts`: o marcador tem de estar no
//  COMEÇO da linha, depois de no máximo dois prefixos entre
//  colchetes (`[OrigemZAgent] `). A linha de chat tem o nome de quem
//  falou no meio, e não passa. E mesmo que passasse, o estrago seria
//  pequeno: o pedido só faz o agente reenviar um estado que já é
//  dele, inteiro.
//
//  ####  AS MISSÕES NÃO SÃO DAQUI  ####
//
//  O hub também pede `quests`, e o dono das missões é o
//  `QuestCollector` (quests/collector.ts). Este módulo ignora o que
//  não conhece, e nunca responde por outro.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

/** O marcador do pedido, o mesmo `RequestMarker` do OrigemZAgent. */
export const AGENT_REQUEST_MARKER = '#OZAREQ#';

/**
 * O que este módulo sabe reenviar. Os nomes são os do plugin
 * (`RequestVips`, `RequestLoadouts`, `RequestSpawnStatus`,
 * `RequestTimers`), e são contrato: mudar um lado sem o outro é o
 * pedido voltar a ficar sem resposta.
 */
export const AGENT_REQUEST_TOPICS = ['vips', 'loadouts', 'status', 'timers'] as const;

export type AgentRequestTopic = (typeof AGENT_REQUEST_TOPICS)[number];

/**
 * A âncora. Ver o cabeçalho: o marcador no começo da linha, depois de
 * no máximo dois prefixos entre colchetes.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZAREQ#/;

/**
 * Espera antes de responder. Curta, e só para tirar o envio da pilha
 * do gancho e juntar os pedidos repetidos do mesmo boot.
 */
const REPLY_DELAY_MS = 250;

/**
 * O assunto que a linha pede, ou `null` quando ela não é um pedido
 * do hub que este módulo atenda.
 *
 * Exige o JSON INTEIRO, e com uma chave só: `{"want":"loadouts"}`. Um
 * `includes` aceitaria o eco de qualquer comando nosso que carregasse
 * o marcador no texto.
 */
export function parseAgentRequest(line: string): AgentRequestTopic | null {
  if (!line.includes(AGENT_REQUEST_MARKER) || !PLUGIN_LINE.test(line)) {
    return null;
  }

  const raw = line.slice(line.indexOf(AGENT_REQUEST_MARKER) + AGENT_REQUEST_MARKER.length).trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // `#OZAREQ#items` e `#OZAREQ#quests`: pedidos de outros donos, e
    // não JSON.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const keys = Object.keys(parsed);
  const want = (parsed as { want?: unknown }).want;

  if (keys.length !== 1 || typeof want !== 'string') {
    return null;
  }

  return (AGENT_REQUEST_TOPICS as readonly string[]).includes(want)
    ? (want as AgentRequestTopic)
    : null;
}

export interface AgentRequestsDeps {
  /**
   * Quem reenvia cada assunto. É o MESMO caminho da reconexão do RCON
   * (`onRconConnected`, em index.ts): uma verdade só sobre "o que
   * reenviar quando o plugin esquece".
   */
  readonly resend: Readonly<Record<AgentRequestTopic, (serverId: string) => Promise<unknown>>>;
  readonly logger: Logger;
  /** Para o teste não esperar relógio de verdade. */
  readonly delayMs?: number;
}

export class AgentRequests {
  readonly #deps: AgentRequestsDeps;

  /**
   * O que já está a caminho, por `servidor:assunto`. O boot do plugin
   * pede tudo de uma vez, e um segundo reload no mesmo segundo pediria
   * de novo: os dois viram um envio só.
   */
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: AgentRequestsDeps) {
    this.#deps = deps;
  }

  /**
   * Olha uma linha do console. NUNCA lança e NUNCA manda comando daqui
   * de dentro — ver o cabeçalho.
   *
   * @returns `true` quando a linha era um pedido deste módulo.
   */
  handleLine(serverId: string, line: string): boolean {
    const topic = parseAgentRequest(line);

    if (topic === null) {
      return false;
    }

    const key = `${serverId}:${topic}`;

    if (this.#pending.has(key)) {
      return true;
    }

    const timer = setTimeout(() => {
      this.#pending.delete(key);

      this.#deps.logger.info(
        { server: serverId, topic },
        'o OrigemZAgent pediu o estado de volta; reenviando',
      );

      void this.#deps.resend[topic](serverId).catch((error: unknown) => {
        // Não deveria acontecer: os envios traduzem falha em desfecho.
        // O catch existe porque isto roda num relógio, onde uma
        // Promise rejeitada não teria quem a pegasse.
        this.#deps.logger.error(
          { server: serverId, topic, err: toError(error) },
          'o reenvio pedido pelo OrigemZAgent lançou',
        );
      });
    }, this.#deps.delayMs ?? REPLY_DELAY_MS);

    // Como todo relógio deste projeto: um envio pendente não segura o
    // processo vivo no desligamento.
    timer.unref();
    this.#pending.set(key, timer);

    return true;
  }

  /** Cancela o que estava a caminho. É o que o desligamento chama. */
  stop(): void {
    for (const timer of this.#pending.values()) {
      clearTimeout(timer);
    }

    this.#pending.clear();
  }
}
