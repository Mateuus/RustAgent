// ============================================================
//  streamer-sync.ts  -  levar o modo streamer até o jogo, e
//  trazer de volta o que o jogador fez com ele.
//
//  Dois sentidos, e os dois passam pelo console:
//
//    IDA     `origemz.streamer.config <base64>` com quem está
//            liberado, quem está ligado e o que cada um esconde;
//    VOLTA   `#OZSTREAMER#{…}` quando alguém digita `/streamer`.
//
//  ------------------------------------------------------------
//  ####  A CARGA VAI PARA TODOS OS SERVIDORES  ####
//
//  O modo é da REDE (ver types/streamer.ts). Um streamer que
//  ligasse no servidor A e atravessasse para o B veria a logo
//  voltar no meio da transmissão — que é justamente o que ele
//  pediu para não acontecer.
//
//  É por isso que o toque de UM jogador, num servidor, agenda
//  reenvio em TODOS: o estado é dele, e não do lugar onde ele
//  estava quando digitou.
//
//  ------------------------------------------------------------
//  ####  QUEM DECIDE É O PLUGIN, E QUEM GRAVA É O AGENTE  ####
//
//  O plugin alterna na hora e responde ao jogador — ele está AO
//  VIVO, e não pode esperar uma ida e volta pelo agente. Depois
//  grita a linha, e é aqui que ela vira banco.
//
//  Se o agente estiver fora do ar, a tela do jogador já mudou e o
//  banco fica para trás. O conserto não precisa de nada especial:
//  o reenvio que sai a cada reconexão de RCON devolve a verdade ao
//  plugin, e o desfecho de qualquer divergência é sempre o mesmo —
//  vale o banco.
//
//  ------------------------------------------------------------
//  ####  ELE NUNCA LANCA  ####
//
//  Roda em timer e em handler de linha de console, como o
//  `AdsSync`. Uma exceção sem dono mataria o laço, e o modo
//  pararia de chegar ao jogo em silêncio.
// ============================================================

import type { StreamerRepository } from '../db/streamer-repository.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import type { StreamerProfile } from '../types/streamer.js';
import { toError } from '../util.js';
import {
  STREAMER_PUSH,
  isStreamerRequest,
  parseStreamerNotice,
  type StreamerNotice,
  type StreamerPayload,
} from '../types/streamer-transport.js';
import { pushState, type PushOutcome } from './plugin-push.js';

/** O que o transporte precisa saber dos servidores. */
export interface StreamerSyncServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export type StreamerSyncTrigger =
  | 'startup'
  | 'rcon-connected'
  | 'admin-saved'
  | 'player-toggled'
  | 'plugin-requested'
  | 'manual';

export interface StreamerSyncDeps {
  readonly repository: StreamerRepository;
  readonly servers: StreamerSyncServers;
  readonly logger?: Logger | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * O debounce. Curto de propósito: quem mexe nisto é um humano numa
 * tela, e a rajada que ele produz são três cliques seguidos.
 */
const DEBOUNCE_MS = 400;

/** O que o plugin pediu de volta, e o que o RCON acabou de abrir. */
function isForced(trigger: StreamerSyncTrigger): boolean {
  return trigger === 'rcon-connected' || trigger === 'plugin-requested';
}

export class StreamerSync {
  readonly #deps: StreamerSyncDeps;
  readonly #now: () => number;

  /** id do servidor -> o timer de debounce dele. */
  readonly #timers = new Map<string, NodeJS.Timeout>();

  /** id do servidor -> o motivo que abriu o debounce. */
  readonly #pending = new Map<string, StreamerSyncTrigger>();

  /**
   * id do servidor -> a última carga que ENTROU nele.
   *
   * O dedup existe porque este sync é chamado a cada toque de
   * comando e a cada salvamento da ficha, e a carga quase sempre é
   * a mesma para os outros servidores. Mandar de novo custaria um
   * frame de RCON por servidor por clique, sem mudar nada.
   */
  readonly #lastSent = new Map<string, string>();

  constructor(deps: StreamerSyncDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  stop(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
    this.#pending.clear();
  }

  /** Empurra daqui a pouco, juntando as edições em rajada. */
  pushSoon(serverId: string, trigger: StreamerSyncTrigger): void {
    // O motivo mais forte vence: um salvamento que chega no meio do
    // debounce não pode apagar o `rcon-connected` que o abriu — é
    // ele que ignora o dedup.
    const pending = this.#pending.get(serverId);

    if (pending === undefined || !isForced(pending)) {
      this.#pending.set(serverId, trigger);
    }

    if (this.#timers.has(serverId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#timers.delete(serverId);
      const reason = this.#pending.get(serverId) ?? 'manual';
      this.#pending.delete(serverId);

      void this.push(serverId, reason).catch((error: unknown) => {
        // Não deveria acontecer: `push` traduz falha em desfecho. O
        // catch existe porque isto roda dentro de um timer, onde uma
        // Promise rejeitada não teria quem a pegasse.
        this.#deps.logger?.error({ err: toError(error) }, 'o envio do modo streamer lançou');
      });
    }, DEBOUNCE_MS);

    timer.unref();
    this.#timers.set(serverId, timer);
  }

  /** O mesmo, em todos os servidores. Ver o cabeçalho. */
  pushAllSoon(trigger: StreamerSyncTrigger): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.pushSoon(serverId, trigger);
    }
  }

  /**
   * O RCON daquele servidor reconectou.
   *
   * O servidor pode ter reiniciado, e o plugin nasce sem carga —
   * ou seja, sem saber que alguém está em live. Sem este reenvio,
   * o overlay voltaria à tela do streamer no meio da transmissão.
   */
  handleRconConnected(serverId: string): void {
    this.pushSoon(serverId, 'rcon-connected');
  }

  /**
   * Uma linha do console daquele servidor. NUNCA lança.
   *
   * Recusa em UMA comparação de string no caso comum: isto roda
   * para toda linha de todos os servidores.
   */
  handleLine(serverId: string, line: string): void {
    try {
      if (isStreamerRequest(line)) {
        this.#deps.logger?.info({ server: serverId }, 'o plugin pediu o modo streamer de volta');
        this.pushSoon(serverId, 'plugin-requested');
        return;
      }

      const notice = parseStreamerNotice(line);

      if (notice === null) {
        return;
      }

      this.apply(serverId, notice);
    } catch (error) {
      this.#deps.logger?.warn(
        { server: serverId, err: toError(error) },
        'não consegui ler uma linha do modo streamer; ela foi ignorada',
      );
    }
  }

  /**
   * O jogador ligou ou desligou. Grava e espalha.
   *
   * Público porque é o que o teste chama: provar "quem não está
   * liberado não liga o modo" não deveria exigir um console de
   * mentira.
   *
   * ####  A LIBERACAO E CONFERIDA AQUI TAMBEM  ####
   *
   * O plugin já confere — ele tem a lista. Conferir de novo é o que
   * protege de uma linha forjada e de um plugin com a carga velha:
   * o marcador tem âncora (ver types/streamer-transport.ts), mas
   * quem grava no banco não deve confiar em quem fala do outro lado
   * do console.
   */
  apply(serverId: string, notice: StreamerNotice): StreamerToggleOutcome {
    const before = this.#deps.repository.get(notice.steamId);

    if (!before.allowed) {
      this.#deps.logger?.warn(
        { server: serverId, steamId: notice.steamId },
        'um jogador SEM liberação tentou ligar o modo streamer; o plugin está com a lista velha',
      );

      // Reenviar é o conserto: a lista do plugin está para trás, e
      // é ela que faz o comando responder "você não tem acesso".
      this.pushSoon(serverId, 'admin-saved');

      return { status: 'not-allowed', profile: before };
    }

    if (before.active === notice.active) {
      // O plugin e o banco já concordam. Acontece no reenvio de uma
      // linha repetida, e não é erro.
      return { status: 'unchanged', profile: before };
    }

    const profile = this.#deps.repository.save(
      notice.steamId,
      { active: notice.active },
      this.#now(),
    );

    this.#deps.logger?.info(
      {
        server: serverId,
        steamId: notice.steamId,
        name: notice.name,
        active: profile.active,
      },
      profile.active ? 'modo streamer LIGADO pelo jogador' : 'modo streamer DESLIGADO pelo jogador',
    );

    // Em todos, e não só neste: o modo é da rede. O servidor onde
    // ele digitou já aplicou sozinho, e o dedup evita o frame
    // repetido quando a carga de lá não mudou.
    this.pushAllSoon('player-toggled');

    return { status: 'applied', profile };
  }

  /** Monta e envia, naquele servidor. NUNCA lança. */
  async push(serverId: string, trigger: StreamerSyncTrigger): Promise<StreamerSyncOutcome> {
    const rcon = this.#rconOf(serverId);

    if (rcon === null) {
      return { status: 'skipped', reason: 'sem RCON' };
    }

    const payload = this.#buildPayload();
    const fingerprint = JSON.stringify(payload);

    if (!isForced(trigger) && this.#lastSent.get(serverId) === fingerprint) {
      return { status: 'unchanged' };
    }

    const outcome = await pushState({
      rcon,
      command: STREAMER_PUSH,
      payload,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status === 'sent') {
      this.#lastSent.set(serverId, fingerprint);

      this.#deps.logger?.debug(
        { server: serverId, trigger, players: payload.players.length },
        'modo streamer enviado ao plugin',
      );
    } else {
      // O que não entrou não pode ficar marcado como entrado: a
      // próxima tentativa precisa mandar de novo.
      this.#lastSent.delete(serverId);

      // ####  E O QUE NAO ENTROU PRECISA APARECER  ####
      //
      // Sem esta linha, um servidor cujo plugin não conhece o
      // comando (o `.cs` velho) recusaria a carga em silêncio — e o
      // sintoma, lá na frente, seria "o modo streamer não faz nada
      // neste servidor", sem nada no log dizendo por quê.
      this.#deps.logger?.warn(
        {
          server: serverId,
          trigger,
          status: outcome.status,
          ...(outcome.status === 'failed' ? { err: outcome.error } : {}),
          ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {}),
        },
        'o modo streamer NÃO chegou a este servidor',
      );
    }

    return { status: 'pushed', outcome };
  }

  /**
   * A carga: só os LIBERADOS.
   *
   * Ver types/streamer-transport.ts — mandar a base inteira de
   * jogadores por causa de meia dúzia de streamers estouraria o
   * teto do frame por nada.
   */
  #buildPayload(): StreamerPayload {
    return {
      players: this.#deps.repository.allowed().map((profile) => ({
        id: profile.steamId,
        on: profile.active,
        logo: profile.hideLogo,
        ads: profile.hideAds,
        chat: profile.hideMessages,
      })),
    };
  }

  #rconOf(serverId: string): OpsRcon | null {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      return null;
    }

    return context.rcon;
  }
}

/** O que aconteceu com o toque de um jogador. */
export type StreamerToggleOutcome =
  | { readonly status: 'applied' | 'unchanged' | 'not-allowed'; readonly profile: StreamerProfile };

/** O que aconteceu com um envio. */
export type StreamerSyncOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'unchanged' }
  | { readonly status: 'pushed'; readonly outcome: PushOutcome };
