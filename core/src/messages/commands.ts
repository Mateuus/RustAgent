// ============================================================
//  commands.ts  -  o `/pop` do jogador.
//
//  O jogador digita, o plugin avisa pelo console, e ESTE módulo
//  responde — só para ele, com as variáveis resolvidas agora.
//
//  O contrato com o plugin (o marcador, o comando de push, o
//  formato do aviso) está em game/chat-commands.ts, e a razão de
//  ele existir também: uma frase começada por `/` nunca chega ao
//  `OnPlayerChat`, então não há como o agente descobrir o comando
//  lendo o console. O plugin precisa interceptar, e para isso
//  precisa da lista.
//
//  ------------------------------------------------------------
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO  ####
//
//  MEDIDO neste projeto: um comando de RCON mandado de dentro do
//  `onConsoleLine` imprime no console, a linha volta pelo mesmo
//  caminho e dispara de novo. O `handleLine` daqui só EMPILHA o
//  trabalho num relógio de 0 ms; a fala sai dele. Mesmo desenho do
//  game/agent-requests.ts e do quests/events.ts.
//
//  ------------------------------------------------------------
//  ####  O COOLDOWN É POR JOGADOR, E ELE MORA NA MEMÓRIA  ####
//
//  Por jogador porque o que ele evita é UMA pessoa martelando o
//  comando — e um cooldown global calaria o `/pop` do servidor
//  inteiro por causa de um engraçadinho.
//
//  Na memória porque ele dura segundos. Reiniciar o agente zera as
//  esperas, e o pior que acontece é um jogador conseguir repetir o
//  comando uma vez a mais — um custo que não paga uma escrita em
//  disco a cada `/pop` de cada jogador.
//
//  ------------------------------------------------------------
//  ####  QUEM FICA SEM RESPOSTA SABE POR QUÊ  ####
//
//  Em cooldown, o jogador recebe quanto falta. Uma frase que
//  simplesmente não aparece é indistinguível de um comando
//  quebrado — e a segunda coisa que ele faz é digitar de novo,
//  cinco vezes, que é exatamente o que o cooldown existe para
//  evitar.
// ============================================================

import type { MessagesRepository } from '../db/messages-repository.js';
import {
  CHAT_COMMANDS_PUSH,
  isChatCommandsRequest,
  parseChatCommandNotice,
  type ChatCommandNotice,
  type ChatCommandsPayload,
} from '../game/chat-commands.js';
import { pushState } from '../game/plugin-push.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import type { MessageView } from '../types/messages.js';
import { toError } from '../util.js';
import type { MessagesPresence, MessagesService } from './service.js';

/**
 * A espera antes de agir sobre uma linha.
 *
 * Zero, e não um intervalo: o jogador está olhando o chat. O timer
 * existe só para tirar a fala da pilha do `onConsoleLine` — ver o
 * cabeçalho.
 */
const REPLY_DELAY_MS = 0;

/**
 * De quanto em quanto tempo as esperas vencidas saem da memória.
 *
 * Sem a poda, o mapa guardaria uma entrada por jogador por comando
 * para sempre — pequeno, mas crescente, e num processo que fica
 * meses no ar.
 */
const SWEEP_EVERY_MS = 300_000;

/** O que o módulo precisa saber dos servidores. */
export interface ChatCommandServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface ChatCommandsDeps {
  readonly repository: MessagesRepository;
  readonly service: MessagesService;
  readonly servers: ChatCommandServers;
  readonly presence: MessagesPresence;
  readonly logger?: Logger | undefined;
  /** Injetável no teste. */
  readonly now?: (() => number) | undefined;
}

/** O desfecho de um `/pop`. É o que o teste lê, e o que o log conta. */
export interface ChatCommandOutcome {
  readonly serverId: string;
  readonly command: string;
  readonly steamId: string;
  /**
   * O que aconteceu:
   *
   *   answered       a mensagem saiu para o jogador
   *   cooling        ainda em espera; ele recebeu quanto falta
   *   unknown        nenhuma mensagem ligada usa este comando aqui
   *   not-enough     o filtro de jogadores online barrou
   *   failed         a entrega falhou
   */
  readonly status: 'answered' | 'cooling' | 'unknown' | 'not-enough' | 'failed';
  readonly messageId: number | null;
  /** Quantos segundos ainda faltam, no `cooling`. */
  readonly remainingSeconds: number;
  readonly error: string | null;
}

export class ChatCommands {
  readonly #deps: ChatCommandsDeps;
  readonly #now: () => number;

  /**
   * Quando cada jogador pode repetir cada comando.
   *
   * A chave é `messageId:steamId`: duas mensagens com cooldowns
   * diferentes não podem compartilhar a espera, e dois jogadores
   * também não.
   */
  readonly #cooling = new Map<string, number>();

  /** Um relógio por servidor, para não empilhar trabalho repetido. */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  #lastSweep = 0;

  constructor(deps: ChatCommandsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Uma linha do console. **NUNCA LANÇA.**
   *
   * Ela roda para TODA linha de TODOS os servidores. Uma exceção
   * aqui subiria pelo `onConsoleLine` e derrubaria o tratamento das
   * outras frentes que dividem o mesmo gancho.
   */
  handleLine(serverId: string, line: string): void {
    try {
      if (isChatCommandsRequest(line)) {
        // O plugin subiu de novo (ou levou um `oxide.reload`) e
        // perdeu a lista. Reenviar é barato e é o que faz o comando
        // voltar a responder sem ninguém reiniciar nada.
        this.#later(`sync:${serverId}`, () => {
          void this.sync(serverId, 'pedido-do-plugin');
        });
        return;
      }

      const notice = parseChatCommandNotice(line);

      if (notice === null) {
        return;
      }

      // A chave inclui o jogador: dois jogadores digitando ao mesmo
      // tempo são dois atendimentos, e não um que substitui o outro.
      this.#later(`cmd:${serverId}:${notice.steamId}:${notice.command}`, () => {
        void this.handle(serverId, notice);
      });
    } catch (error) {
      this.#deps.logger?.warn(
        { server: serverId, err: toError(error) },
        'não consegui ler uma linha de comando de chat; ela foi ignorada',
      );
    }
  }

  /**
   * Atende um comando. **NUNCA LANÇA** — devolve o que aconteceu.
   *
   * Público porque é o que o teste chama: provar "o cooldown
   * impede o spam" não deveria exigir um console de mentira.
   */
  async handle(serverId: string, notice: ChatCommandNotice): Promise<ChatCommandOutcome> {
    const base = {
      serverId,
      command: notice.command,
      steamId: notice.steamId,
      messageId: null,
      remainingSeconds: 0,
      error: null,
    } as const;

    try {
      this.#sweep();

      const message = this.#resolve(serverId, notice.command);

      if (message === null) {
        // O plugin interceptou um comando que o agente não conhece
        // mais: a lista dele está velha. Reenviar devolve o comando
        // ao jogo como desconhecido, que é o certo.
        this.#later(`sync:${serverId}`, () => {
          void this.sync(serverId, 'comando-desconhecido');
        });

        return { ...base, status: 'unknown' };
      }

      const at = this.#now();
      const key = `${String(message.id)}:${notice.steamId}`;
      const until = this.#cooling.get(key) ?? 0;

      if (until > at) {
        const remaining = Math.ceil((until - at) / 1000);

        await this.#tell(
          message,
          serverId,
          notice.steamId,
          `Espere ${String(remaining)}s para usar isso de novo.`,
        );

        return { ...base, status: 'cooling', messageId: message.id, remainingSeconds: remaining };
      }

      const enough = await this.#hasEnoughPlayers(message, serverId);

      if (!enough) {
        // O filtro é do admin, e ele é explícito na tela. O jogador
        // não recebe a frase; quem precisa entender por quê olha o
        // histórico da mensagem, e é por isso que a linha vai para
        // o log com o motivo.
        this.#deps.repository.log({
          messageId: message.id,
          serverId,
          at,
          players: 0,
          ok: false,
          error: `nao respondi ao /${notice.command}: o servidor tem menos de ${String(
            Math.max(1, message.minPlayers),
          )} jogador(es) online, e esta mensagem exige isso`,
        });

        return { ...base, status: 'not-enough', messageId: message.id };
      }

      const report = await this.#deps.service.reply(message, serverId, notice.steamId);

      if (!report.ok) {
        return {
          ...base,
          status: 'failed',
          messageId: message.id,
          error: report.error,
        };
      }

      if (message.cooldownSeconds > 0) {
        // A espera começa NA RESPOSTA, e não na digitação: uma
        // entrega que falhou não pode calar o jogador por um minuto.
        this.#cooling.set(key, at + message.cooldownSeconds * 1000);
      }

      this.#deps.logger?.info(
        {
          server: serverId,
          message: message.id,
          command: notice.command,
          steamId: notice.steamId,
          player: notice.name,
        },
        'respondi a um comando de chat',
      );

      return { ...base, status: 'answered', messageId: message.id };
    } catch (error) {
      const err = toError(error);

      this.#deps.logger?.warn(
        { server: serverId, command: notice.command, err },
        'não consegui responder a um comando de chat',
      );

      return { ...base, status: 'failed', error: err.message };
    }
  }

  /**
   * Empurra ao plugin daquele servidor a lista de comandos que ele
   * deve interceptar.
   *
   * NUNCA LANÇA: quase sempre é chamado de um relógio ou de uma
   * reconexão, e metade da frota costuma estar parada.
   */
  async sync(serverId: string, trigger: string): Promise<void> {
    const rcon = this.#deps.servers.contextOf(serverId)?.rcon ?? null;

    if (rcon === null) {
      return;
    }

    const payload: ChatCommandsPayload = { commands: this.commandsFor(serverId) };

    const outcome = await pushState({
      rcon,
      command: CHAT_COMMANDS_PUSH,
      payload,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status === 'failed') {
      // `debug`, e não `warn`: o servidor pode simplesmente não ter
      // o OrigemZChat carregado, e nesse caso não há comando de chat
      // nenhum para responder — nada quebrou.
      this.#deps.logger?.debug(
        { server: serverId, err: outcome.error, trigger },
        'não consegui empurrar a lista de comandos de chat ao plugin',
      );
    }
  }

  /** A lista em todos os servidores conhecidos. */
  async syncAll(trigger: string): Promise<void> {
    for (const serverId of this.#deps.servers.ids()) {
      await this.sync(serverId, trigger);
    }
  }

  /**
   * Os comandos que valem NESTE servidor, sem repetição.
   *
   * Lista de alvos vazia quer dizer TODOS — a mesma regra do resto
   * do módulo de mensagens.
   */
  commandsFor(serverId: string): readonly string[] {
    const commands = new Set<string>();

    for (const message of this.#deps.repository.commands()) {
      if (message.command !== null && reaches(message, serverId)) {
        commands.add(message.command);
      }
    }

    return [...commands];
  }

  /** Esquece as esperas. É o que o teste usa entre dois casos. */
  clearCooldowns(): void {
    this.#cooling.clear();
  }

  stop(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
  }

  // ----------------------------------------------------------

  /**
   * Qual mensagem responde a este comando NESTE servidor.
   *
   * Mais de uma é configuração que a rota recusa (ver
   * `assertCommandIsFree`). Se mesmo assim houver — duas abas
   * gravando ao mesmo tempo, um banco editado à mão —, vale a
   * primeira da lista e o log diz que havia outra: escolher em
   * silêncio faria o admin ver uma das duas responder sem entender
   * a regra.
   */
  #resolve(serverId: string, command: string): MessageView | null {
    const candidates = this.#deps.repository
      .byCommand(command)
      .filter((message) => reaches(message, serverId));

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length > 1) {
      this.#deps.logger?.warn(
        {
          server: serverId,
          command,
          messages: candidates.map((message) => message.id),
        },
        'mais de uma mensagem ligada usa este comando neste servidor; respondi com a primeira da lista',
      );
    }

    return candidates[0] ?? null;
  }

  /** O filtro de jogadores online, quando a mensagem o exige. */
  async #hasEnoughPlayers(message: MessageView, serverId: string): Promise<boolean> {
    if (!message.onlyWithPlayers) {
      return true;
    }

    const online = await this.#deps.presence.online(serverId);

    if (online === null) {
      // Não deu para contar. Quem digitou ESTÁ online, então o
      // servidor tem pelo menos um — e recusar aqui calaria o
      // comando toda vez que a contagem falhasse.
      return Math.max(1, message.minPlayers) <= 1;
    }

    return online >= Math.max(1, message.minPlayers);
  }

  /**
   * Uma frase de serviço (a espera do cooldown), com a cara da
   * mensagem.
   *
   * Com a tag e as cores dela de propósito: o jogador acabou de
   * pedir aquilo, e uma resposta sem identidade nenhuma parece de
   * outro plugin.
   */
  async #tell(
    message: MessageView,
    serverId: string,
    steamId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.#deps.service.speak({
        serverId,
        text,
        tag: message.tag ?? undefined,
        tagColor: message.tagColor ?? undefined,
        color: message.color ?? undefined,
        size: message.size ?? undefined,
        steamId,
      });
    } catch (error) {
      // Sem o plugin não há fala dirigida (o `say` falaria para o
      // servidor inteiro — ver game/broadcast.ts). Avisar do
      // cooldown é o menos importante do caminho: ele não pode
      // derrubar o atendimento.
      this.#deps.logger?.debug(
        { server: serverId, err: toError(error) },
        'não consegui avisar o jogador sobre a espera do comando',
      );
    }
  }

  /** Um relógio por chave, substituindo o que ainda não disparou. */
  #later(key: string, run: () => void): void {
    const existing = this.#timers.get(key);

    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.#timers.delete(key);
      run();
    }, REPLY_DELAY_MS);

    timer.unref?.();
    this.#timers.set(key, timer);
  }

  /** Tira da memória as esperas que já venceram. */
  #sweep(): void {
    const at = this.#now();

    if (at - this.#lastSweep < SWEEP_EVERY_MS) {
      return;
    }

    this.#lastSweep = at;

    for (const [key, until] of this.#cooling) {
      if (until <= at) {
        this.#cooling.delete(key);
      }
    }
  }
}

/** A mensagem vale neste servidor? Lista vazia = TODOS. */
function reaches(message: MessageView, serverId: string): boolean {
  return message.targets.length === 0 || message.targets.includes(serverId);
}
