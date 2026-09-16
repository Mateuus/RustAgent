// ============================================================
//  workshop.ts  -  o catálogo de skins do Workshop, do lado do
//  agente.
//
//  ####  O QUE É DAQUI E O QUE É DO PLUGIN  ####
//
//    AQUI     o que existe no catálogo, quem tem direito a cada
//             skin, em que servidores ela vale e quem está em
//             modo streamer agora
//    LÁ       carimbar o número no item que está nascendo, e
//             registrar as permissões no Oxide
//
//  A decisão por item não pode vir para cá: ela acontece milhares
//  de vezes por minuto num servidor cheio, dentro de um hook do
//  jogo. O que sobe pelo console é o CATÁLOGO, e ele muda quando
//  um humano mexe numa tela.
//
//  ####  O PAYLOAD É COMPLETO, NUNCA UM DELTA  ####
//
//  Mesma regra do `origemz.vip.sync` (ver plugin-push.ts): quem
//  sumiu da lista perde a skin no instante em que o comando é
//  aplicado. É isso que faz "apaguei a skin" chegar ao jogo sem um
//  comando de remoção. Passou do teto de 50 KB, o envio é RECUSADO
//  inteiro — meio catálogo é pior que catálogo velho, porque o
//  plugin troca um cache bom por um incompleto que ele acredita
//  ser completo.
//
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO DE CONSOLE  ####
//
//  A lição medida do `agent-requests.ts`, repetida no `koth.ts`: um
//  comando mandado de dentro do `onConsoleLine` imprime no console,
//  a linha volta e dispara de novo. Por isso o `ready` do plugin e
//  o `/streamer` do jogador só ARMAM um relógio; o comando sai dele.
//
//  ####  E A LISTA DE STREAMERS VIAJA JUNTO  ####
//
//  O modo streamer já existe inteiro no projeto e a fonte da
//  verdade dele é o agente. Mandar a lista dentro do próprio sync
//  é o que evita a pior das opções do §3.3 do levantamento — duas
//  cópias da mesma lista em dois plugins, que divergem no primeiro
//  reload. Ver types/workshop.ts.
//
//  Ver Docs/OrigemZWorkshop/00-LEVANTAMENTO.md.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { StreamerRepository } from '../db/streamer-repository.js';
import type { WorkshopSkinsRepository } from '../db/workshop-repository.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { parseStreamerNotice } from '../types/streamer-transport.js';
import type {
  WorkshopPayload,
  WorkshopPayloadSkin,
  WorkshopPush,
  WorkshopStatus,
} from '../types/workshop.js';
import { toError } from '../util.js';
import { pushState, type PushOutcome } from './plugin-push.js';

/** O marcador do aviso. O mesmo `Marker` do OrigemZWorkshop.cs. */
export const WORKSHOP_MARKER = '#OZWORKSHOP#';

/** Os dois comandos do contrato. */
export const WORKSHOP_SYNC = 'origemz.workshop.sync';
export const WORKSHOP_STATUS = 'origemz.workshop.status';

/** Quebra de linha do console, nos dois sabores. */
const SPLIT_LINES = /\r?\n/;

/**
 * A âncora da linha.
 *
 * O marcador tem de estar no COMEÇO, depois de no máximo dois
 * prefixos entre colchetes (`[OrigemZ Workshop] `). A linha de chat
 * traz o nome de quem falou antes do texto e NÃO passa — sem isso,
 * qualquer jogador forjaria um aviso digitando o marcador.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZWORKSHOP#/;

/**
 * O relógio que separa o gancho de console do comando de RCON.
 *
 * Um segundo, como o do KOTH: tempo de o banco já ter recebido a
 * escrita que a linha provocou (o `/streamer` é gravado pelo
 * `StreamerSync`, que roda no mesmo gancho) e de juntar a rajada de
 * um `oxide.reload` que derruba todos os plugins de uma vez.
 */
const SYNC_DELAY_MS = 1000;

export type WorkshopSyncTrigger =
  | 'startup'
  | 'rcon-connected'
  | 'plugin-requested'
  | 'catalog-changed'
  | 'streamer-toggled'
  | 'manual';

/**
 * O que ignora o dedup.
 *
 * O plugin que acabou de subir e o RCON que acabou de reconectar
 * não têm carga nenhuma — mandar "não mudou nada" para eles seria
 * deixá-los vazios até alguém editar o catálogo.
 */
function isForced(trigger: WorkshopSyncTrigger): boolean {
  return trigger === 'rcon-connected' || trigger === 'plugin-requested' || trigger === 'startup';
}

export interface WorkshopServers {
  readonly ids: () => readonly string[];
  /** `null` = o servidor existe, mas está desligado — sem RCON. */
  readonly contextOf: (serverId: string) => { readonly rcon: OpsRcon } | null;
}

export interface WorkshopDeps {
  readonly skins: WorkshopSkinsRepository;
  /**
   * Quem está em modo streamer.
   *
   * O catálogo é lido a cada envio, e a lista também: as duas são
   * pequenas, e um cache aqui seria a terceira cópia da mesma
   * verdade.
   */
  readonly streamers: StreamerRepository;
  readonly servers: WorkshopServers;
  readonly logger?: Logger | undefined;
}

export class WorkshopCommandError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'WorkshopCommandError';
    this.reason = reason;
  }
}

/** O desfecho de um envio. */
export type WorkshopSyncOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'unchanged' }
  | { readonly status: 'pushed'; readonly outcome: PushOutcome };

export class WorkshopService {
  readonly #deps: WorkshopDeps;

  /**
   * O segredo desta sessão do agente.
   *
   * Ele desce no `sync` e volta em todo aviso do plugin — menos no
   * `ready`, que é quem o pede. Sem ele, um jogador digita o
   * marcador no chat e forja evento. Ver `handleLine`.
   *
   * Nasce novo a cada processo de propósito: um segredo fixo em
   * arquivo vazaria no primeiro log colado num chat de suporte.
   */
  readonly #secret = randomUUID();

  /** id do servidor -> o relógio de debounce dele. */
  readonly #timers = new Map<string, NodeJS.Timeout>();

  /** id do servidor -> o motivo que abriu o debounce. */
  readonly #pending = new Map<string, WorkshopSyncTrigger>();

  /**
   * id do servidor -> a última carga que ENTROU nele.
   *
   * O dedup existe porque o `/streamer` de um jogador agenda
   * reenvio em TODOS os servidores, e a carga dos outros quase
   * sempre não muda. Mandar de novo custaria um frame de RCON por
   * servidor por clique, sem mudar nada.
   */
  readonly #lastSent = new Map<string, string>();

  /** id do servidor -> quantas skins o plugin confirmou ter aplicado. */
  readonly #applied = new Map<string, number>();

  #stopped = false;

  constructor(deps: WorkshopDeps) {
    this.#deps = deps;
  }

  stop(): void {
    this.#stopped = true;

    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
    this.#pending.clear();
  }

  // ------------------------------------------------------------
  //  §1  A CARGA
  // ------------------------------------------------------------

  /**
   * O que desce para AQUELE servidor.
   *
   * Pública porque é o que a rota de diagnóstico e o teste leem:
   * provar "a skin desligada não vai" não deveria exigir um console
   * de mentira.
   */
  buildPayload(serverId: string): WorkshopPayload {
    // O repositório já filtra: só as LIGADAS, e só as que a junção
    // deu a este servidor. Ver db/workshop-repository.ts.
    const skins: WorkshopPayloadSkin[] = this.#deps.skins.listForServer(serverId).map((skin) => ({
      id: skin.id,
      shortname: skin.shortname,
      skinId: skin.skinId,
      permission: skin.permission,
      hideInStreamer: skin.hideInStreamer,
      // Sempre `true` aqui: o que está desligado não chegou. Ver
      // types/workshop.ts para por que o campo continua viajando.
      enabled: true,
    }));

    return {
      secret: this.#secret,
      skins,
      // ####  QUEM ESTÁ ESCONDENDO A LOGO, E NÃO QUEM É STREAMER  ####
      //
      // `allowed` é "o admin liberou"; `active` é "ele está no ar
      // agora"; `hideLogo` é "o que ele escondeu é a logo". A skin
      // do Workshop É a logo — um parceiro que escondeu só a
      // propaganda continua recebendo o item marcado, que é
      // exatamente o acordo que se faz com quem divulga o servidor.
      // Ver types/streamer.ts.
      streamers: this.#deps.streamers
        .active()
        .filter((profile) => profile.hideLogo)
        .map((profile) => profile.steamId),
    };
  }

  // ------------------------------------------------------------
  //  §2  EMPURRAR
  // ------------------------------------------------------------

  /** Monta, mede, manda e confere. NUNCA lança. */
  async sync(
    serverId: string,
    trigger: WorkshopSyncTrigger = 'manual',
  ): Promise<WorkshopSyncOutcome> {
    if (this.#stopped) return { status: 'skipped', reason: 'o agente está parando' };

    const rcon = this.#rconOf(serverId);

    if (rcon === null) {
      // NÃO é erro: metade da lista costuma estar parada, e a
      // reconexão repassa o catálogo inteiro.
      return { status: 'skipped', reason: 'sem RCON' };
    }

    const payload = this.buildPayload(serverId);
    const fingerprint = JSON.stringify(payload);

    if (!isForced(trigger) && this.#lastSent.get(serverId) === fingerprint) {
      return { status: 'unchanged' };
    }

    const outcome = await pushState({
      rcon,
      command: WORKSHOP_SYNC,
      payload,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status === 'sent') {
      this.#lastSent.set(serverId, fingerprint);

      this.#deps.logger?.debug(
        { server: serverId, trigger, skins: payload.skins.length },
        'catálogo do Workshop enviado ao plugin',
      );
    } else {
      // O que não entrou não pode ficar marcado como entrado: a
      // próxima tentativa precisa mandar de novo.
      this.#lastSent.delete(serverId);

      // ####  E O QUE NÃO ENTROU PRECISA APARECER  ####
      //
      // Sem esta linha, um servidor cujo plugin não conhece o
      // comando recusaria a carga em silêncio — e o sintoma, lá na
      // frente, seria "as skins não funcionam neste servidor", sem
      // nada no log dizendo por quê.
      this.#deps.logger?.warn(
        {
          server: serverId,
          trigger,
          status: outcome.status,
          ...(outcome.status === 'failed' ? { err: outcome.error } : {}),
          ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {}),
          ...(outcome.status === 'refused'
            ? { bytes: outcome.bytes, limitBytes: outcome.limitBytes }
            : {}),
        },
        'o catálogo do Workshop NÃO chegou a este servidor',
      );
    }

    return { status: 'pushed', outcome };
  }

  /** O mesmo, em todos os servidores. NUNCA lança. */
  async syncAll(trigger: WorkshopSyncTrigger): Promise<void> {
    for (const serverId of this.#deps.servers.ids()) {
      await this.sync(serverId, trigger);
    }
  }

  /**
   * Empurra daqui a pouco, juntando as edições em rajada.
   *
   * É por aqui que passa TUDO que nasce de dentro do gancho de
   * console. Ver o cabeçalho.
   */
  syncSoon(serverId: string, trigger: WorkshopSyncTrigger): void {
    if (this.#stopped) return;

    // O motivo mais forte vence: um salvamento que chega no meio do
    // debounce não pode apagar o `plugin-requested` que o abriu — é
    // ele que ignora o dedup.
    const pending = this.#pending.get(serverId);

    if (pending === undefined || !isForced(pending)) {
      this.#pending.set(serverId, trigger);
    }

    if (this.#timers.has(serverId)) return;

    const timer = setTimeout(() => {
      this.#timers.delete(serverId);

      const reason = this.#pending.get(serverId) ?? 'manual';

      this.#pending.delete(serverId);

      void this.sync(serverId, reason).catch((error: unknown) => {
        // Não deveria acontecer: `sync` traduz falha em desfecho. O
        // catch existe porque isto roda dentro de um relógio, onde
        // uma Promise rejeitada não teria quem a pegasse.
        this.#deps.logger?.error(
          { server: serverId, err: toError(error) },
          'o envio do catálogo do Workshop lançou',
        );
      });
    }, SYNC_DELAY_MS);

    timer.unref();
    this.#timers.set(serverId, timer);
  }

  /** O mesmo, em todos. É o caminho do `/streamer`: o estado é da REDE. */
  syncAllSoon(trigger: WorkshopSyncTrigger): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.syncSoon(serverId, trigger);
    }
  }

  /**
   * O RCON daquele servidor reconectou.
   *
   * O servidor pode ter reiniciado, e o plugin nasce sem catálogo —
   * ou seja, todo item nasceria vanilla até alguém editar a tela.
   */
  handleRconConnected(serverId: string): void {
    this.syncSoon(serverId, 'rcon-connected');
  }

  /**
   * O catálogo mudou no painel.
   *
   * Sem isto a skin fica no banco, aparece na tela, e o plugin
   * nunca soube que ela existe.
   */
  handleCatalogChanged(): void {
    this.syncAllSoon('catalog-changed');
  }

  /**
   * O modo streamer de alguém mudou (pelo painel, ou pelo comando).
   *
   * Reenvia em TODOS: o modo é da rede, e o jogador atravessa para
   * outro servidor no meio da transmissão. Ver streamer-sync.ts.
   */
  handleStreamerChanged(): void {
    this.syncAllSoon('streamer-toggled');
  }

  // ------------------------------------------------------------
  //  §3  ESCUTAR
  // ------------------------------------------------------------

  /**
   * Uma linha do console daquele servidor. NUNCA lança.
   *
   * Recusa em UMA comparação de string no caso comum: isto roda
   * para toda linha de todos os servidores.
   */
  handleLine(serverId: string, line: string): void {
    if (this.#stopped) return;

    try {
      if (line.includes(WORKSHOP_MARKER)) {
        this.#handle(serverId, line);
        return;
      }

      // ####  O `/streamer` TAMBÉM É NOTÍCIA NOSSA  ####
      //
      // Quem grava é o `StreamerSync`, no mesmo gancho e antes
      // deste. O que interessa aqui é que a lista do payload mudou
      // — e o relógio de um segundo garante que a escrita dele já
      // aconteceu quando o comando sair.
      if (parseStreamerNotice(line) !== null) {
        this.syncAllSoon('streamer-toggled');
      }
    } catch (cause) {
      this.#deps.logger?.warn(
        { server: serverId, error: toError(cause).message },
        'linha do OrigemZWorkshop não pôde ser tratada',
      );
    }
  }

  #handle(serverId: string, line: string): void {
    // A âncora: o marcador no começo da linha, depois de no máximo
    // dois prefixos entre colchetes. Ver `PLUGIN_LINE`.
    if (!PLUGIN_LINE.test(line.trimStart())) return;

    const body = line.slice(line.indexOf(WORKSHOP_MARKER) + WORKSHOP_MARKER.length).trim();

    if (body === '') return;

    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== 'object' || parsed === null) return;

    const push = parsed as WorkshopPush;

    if (push.kind === 'ready') {
      // ####  O ÚNICO QUE VEM SEM SEGREDO  ####
      //
      // É o plugin dizendo que subiu sem catálogo. Ele ainda não
      // tem o segredo — é justamente isto que o pede. O estrago
      // possível de uma linha forjada aqui é um reenvio do
      // catálogo, que é o que o agente faria de qualquer jeito na
      // próxima reconexão.
      this.#deps.logger?.info(
        { server: serverId },
        'o OrigemZWorkshop subiu e pediu o catálogo',
      );

      this.syncSoon(serverId, 'plugin-requested');

      return;
    }

    if (push.secret !== this.#secret) {
      this.#deps.logger?.warn(
        { server: serverId, kind: push.kind },
        'aviso do Workshop com segredo errado: descartado',
      );

      return;
    }

    if (push.kind === 'applied') {
      const count = typeof push.count === 'number' ? push.count : 0;

      this.#applied.set(serverId, count);

      this.#deps.logger?.debug(
        { server: serverId, skins: count },
        'o OrigemZWorkshop confirmou o catálogo',
      );

      return;
    }

    // Um aviso de uma versão mais nova do plugin. Ele passou pelo
    // segredo, então é legítimo — e ignorá-lo em silêncio faria
    // parecer que o agente o entendeu.
    this.#deps.logger?.debug(
      { server: serverId, kind: push.kind },
      'aviso do Workshop de um tipo que este agente não conhece',
    );
  }

  /**
   * Quantas skins o plugin daquele servidor confirmou.
   *
   * `null` = ele nunca confirmou nada — plugin antigo, ou que ainda
   * não recebeu carga. NÃO é zero: "nenhuma skin" e "não sei" são
   * respostas diferentes, e a tela precisa poder dizer a segunda.
   */
  appliedCount(serverId: string): number | null {
    return this.#applied.get(serverId) ?? null;
  }

  // ------------------------------------------------------------
  //  §4  PERGUNTAR
  // ------------------------------------------------------------

  /** O que o plugin diz ter de pé. Lança `WorkshopCommandError`. */
  async status(serverId: string): Promise<WorkshopStatus> {
    const reply = await this.#command(serverId, WORKSHOP_STATUS);

    return {
      skins: typeof reply['skins'] === 'number' ? reply['skins'] : 0,
      streamers: typeof reply['streamers'] === 'number' ? reply['streamers'] : 0,
    };
  }

  async #command(serverId: string, command: string): Promise<Record<string, unknown>> {
    const rcon = this.#rconOf(serverId);

    if (rcon === null) {
      throw new WorkshopCommandError('offline', 'O servidor não está com o RCON de pé.');
    }

    const reply = cleanReply(await rcon.send(command));

    if (reply === '') {
      throw new WorkshopCommandError(
        'no_plugin',
        'O servidor não respondeu: o OrigemZWorkshop pode não estar carregado.',
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(reply);
    } catch {
      throw new WorkshopCommandError(
        'bad_reply',
        `O plugin respondeu algo que não é JSON: ${reply.slice(0, 200)}`,
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new WorkshopCommandError('bad_reply', 'O plugin respondeu um JSON que não é objeto.');
    }

    const payload = parsed as Record<string, unknown>;

    if (payload['ok'] !== true) {
      const reason = typeof payload['error'] === 'string' ? payload['error'] : 'unknown';
      const message =
        typeof payload['message'] === 'string' ? payload['message'] : 'O plugin recusou.';

      throw new WorkshopCommandError(reason, message);
    }

    return payload;
  }

  #rconOf(serverId: string): OpsRcon | null {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) return null;

    return context.rcon;
  }
}

/**
 * A resposta do comando, sem o que o plugin falou por cima.
 *
 * Mesma defesa do `koth.ts`, e pela mesma razão medida: um `Puts`
 * disparado no frame do comando entra na resposta casada do RCON e
 * quebra o JSON. O plugin já tira o aviso do frame; isto é a
 * segunda tranca.
 */
export function cleanReply(reply: string): string {
  return reply
    .split(SPLIT_LINES)
    .filter((line) => !line.includes(WORKSHOP_MARKER))
    .join('\n')
    .trim();
}
