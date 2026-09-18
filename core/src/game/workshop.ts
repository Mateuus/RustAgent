// ============================================================
//  workshop.ts  -  as skins do Workshop, do lado do agente.
//
//  ####  O QUE É DAQUI E O QUE É DO PLUGIN  ####
//
//    AQUI     o catálogo, a posse de cada jogador, em que servidores
//             cada skin vale, quem está em modo streamer, e o
//             registro de tudo isso
//    LÁ       o menu de skins, a decisão "este jogador pode?" (na
//             hora, com a posse que desceu) e a troca do número no
//             item
//
//  ####  DUAS CARGAS (Docs/OrigemZWorkshop/02 §5)  ####
//
//  1. O CATÁLOGO do servidor, inteiro, a cada mudança:
//
//      origemz.workshop.sync <lote> <i> <n> <pedaço base64>
//
//  2. A POSSE de UM jogador, inteira, quando ela muda e ele está
//     online, quando ele entra, e para todos os online quando o
//     plugin sobe ou o RCON reconecta:
//
//      origemz.workshop.owned <steamId> <lote> <i> <n> <pedaço base64>
//
//  As duas são cortadas em pedaços de até 40 KB de base64 (o frame
//  do WebRCON é de 50 KB). O plugin guarda os pedaços do mesmo lote
//  e só troca o que tem quando o último chega; lote incompleto é
//  descartado e o que ele tinha continua inteiro. Carga pequena vai
//  num pedaço só, com `0 1` — o formato é sempre o mesmo.
//
//  A posse NUNCA é delta, e a lista VAZIA é mandada: ela é a
//  informação "não tem nada", diferente de "ainda não sei".
//
//  A carga da posse leva também as FAVORITAS daquele jogador
//  (`favorites: [ids]`, 02 §5.2): são a mesma pergunta ("o que é
//  deste jogador?") e o plugin troca os dois conjuntos de uma vez.
//  Desde a migração 100 elas são do AGENTE, e não do
//  `favorites.json` do plugin — que continua existindo, como cache de
//  leitura para o servidor que sobe com o agente fora do ar.
//
//  ####  A ESTRELA DO MENU: OTIMISTA LÁ, VERDADE AQUI  ####
//
//      jogador clica na estrela
//            ↓  o plugin desenha na hora e grita
//      #OZWORKSHOP#{"kind":"fav","secret":…,"steamId":…,
//                   "skinId":N,"on":true|false}
//            ↓  este arquivo
//      WorkshopCatalog.setFavorite  →  workshop_favorites
//            ↓
//      origemz.workshop.owned  →  o conjunto trocado, que é a verdade
//
//  O aviso diz o ESTADO (`on`), e não "alterne": o console repete
//  linha em reconexão, e alternar duas vezes desfaria o clique em
//  silêncio.
//
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO DE CONSOLE  ####
//
//  A lição medida do `agent-requests.ts`, repetida no `koth.ts`: um
//  comando mandado de dentro do `onConsoleLine` imprime no console,
//  a linha volta e dispara de novo. O `ready`, o `/streamer`, o
//  `/skin add` e o `/skin give` só ARMAM trabalho; o comando sai de
//  um relógio.
//
//  ####  O `/skin add` E O `/skin give` DO JOGO  ####
//
//      admin digita  /skin add "rifle.ak" "3802433262"
//                    /skin give Fulano "rifle.ak" "3802433262" 30
//            ↓  o plugin confere e grita
//      #OZWORKSHOP#{"kind":"add"|"give","secret":…,"requestId":…}
//            ↓  este arquivo
//      WorkshopCatalog.createSkin / grantOwnership  ← as MESMAS
//                                                    regras do painel
//            ↓
//      origemz.workshop.reply <base64>  → a frase no chat do admin
// ============================================================

import { randomUUID } from 'node:crypto';

import type { MetaRepository } from '../db/meta-repository.js';
import type { StreamerRepository } from '../db/streamer-repository.js';
import type { WorkshopOwnedRepository } from '../db/workshop-owned-repository.js';
import type { WorkshopSkinsRepository } from '../db/workshop-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { parseStreamerNotice } from '../types/streamer-transport.js';
import {
  workshopAddRequestSchema,
  workshopFavoriteRequestSchema,
  workshopGiveRequestSchema,
  type WorkshopAddReply,
  type WorkshopAddRequest,
  type WorkshopFavoriteRequest,
  type WorkshopGiveRequest,
  type WorkshopOwnedPayload,
  type WorkshopPayload,
  type WorkshopPayloadSkin,
  type WorkshopPush,
  type WorkshopStatus,
} from '../types/workshop.js';
import { toError } from '../util.js';
import { firstJsonLine } from './plugin-contract.js';
import { encodePushPayload, pushErrorSchema, pushOkSchema, pushState } from './plugin-push.js';
import type { WorkshopCatalog } from './workshop-catalog.js';

/** O marcador do aviso. O mesmo `Marker` do OrigemZWorkshop.cs. */
export const WORKSHOP_MARKER = '#OZWORKSHOP#';

/** Os comandos do contrato. */
export const WORKSHOP_SYNC = 'origemz.workshop.sync';
export const WORKSHOP_OWNED = 'origemz.workshop.owned';
export const WORKSHOP_STATUS = 'origemz.workshop.status';
export const WORKSHOP_REPLY = 'origemz.workshop.reply';

/**
 * O tamanho de cada pedaço, em caracteres de base64.
 *
 * 40 KB mais o nome do comando, o SteamID e os três números cabe
 * folgado nos 50 KB do `MAX_PUSH_BYTES` — base64 é ASCII, então
 * caractere e byte são a mesma conta.
 */
export const WORKSHOP_CHUNK_CHARS = 40_000;

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
 * `StreamerSync`, no mesmo gancho) e de juntar a rajada de um
 * `oxide.reload` que derruba todos os plugins de uma vez.
 */
const SYNC_DELAY_MS = 1000;

/** O `setTimeout` do Node estoura acima de ~24,8 dias. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Onde o relógio de vencimento lembra até quando já conferiu.
 *
 * A MESMA chave da 096: o que venceu até ali já foi registrado como
 * `grant.expire`, e a posse migrada guarda os mesmos prazos.
 */
const EXPIRY_CHECKED_KEY = 'workshop.expiry_checked_at';

export type WorkshopSyncTrigger =
  | 'startup'
  | 'rcon-connected'
  | 'plugin-requested'
  | 'catalog-changed'
  | 'streamer-toggled'
  | 'manual';

export type WorkshopOwnedTrigger =
  | 'player-joined'
  | 'ownership-changed'
  | 'owned-expired'
  /** O jogador marcou (ou desmarcou) uma favorita no menu. */
  | 'favorite-changed'
  /** O catálogo desceu: a posse é filtrada por ele. */
  | 'catalog'
  | 'manual';

/**
 * O que ignora o dedup.
 *
 * O plugin que acabou de subir e o RCON que acabou de reconectar
 * não têm carga nenhuma — mandar "não mudou nada" para eles seria
 * deixá-los com a carga do disco até alguém editar o catálogo.
 */
function isForced(trigger: WorkshopSyncTrigger): boolean {
  return trigger === 'rcon-connected' || trigger === 'plugin-requested' || trigger === 'startup';
}

export interface WorkshopServers {
  readonly ids: () => readonly string[];
  /** `null` = o servidor existe, mas está desligado — sem RCON. */
  readonly contextOf: (serverId: string) => { readonly rcon: OpsRcon } | null;
  /**
   * Quem o agente sabe estar online AGORA naquele servidor.
   *
   * Lido das sessões abertas (`player_servers`), que a varredura de
   * presença mantém — e não do RCON: esta pergunta é feita a cada
   * mudança de posse, e perguntar ao jogo a cada vez seria uma
   * `playerlist` por clique no painel.
   */
  readonly onlineOf: (serverId: string) => readonly string[];
}

export interface WorkshopDeps {
  readonly skins: WorkshopSkinsRepository;
  readonly owned: WorkshopOwnedRepository;
  /**
   * Quem está em modo streamer. Lido a cada envio: a lista é
   * pequena, e um cache aqui seria a terceira cópia da verdade.
   */
  readonly streamers: StreamerRepository;
  readonly servers: WorkshopServers;
  /** As regras do cadastro e da posse. O `/skin add`/`give` grava por aqui. */
  readonly catalog: WorkshopCatalog;
  /** Guarda até quando o vencimento de posse já foi registrado. */
  readonly meta?: MetaRepository;
  /**
   * O texto do cadeado no menu (03 §5), p. ex. `origemz.com.br/skins`.
   * Vazio ou ausente = o campo não desce.
   */
  readonly storeUrl?: string | null;
  readonly logger?: Logger | undefined;
  /** Para o teste controlar o tempo. */
  readonly now?: () => number;
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
  | { readonly status: 'sent'; readonly bytes: number; readonly parts: number }
  | { readonly status: 'failed'; readonly error: Error };

/** A posse pendente de um servidor: todos os online, ou alguns. */
interface OwnedPending {
  all: boolean;
  forced: boolean;
  readonly players: Set<string>;
  trigger: WorkshopOwnedTrigger;
}

export class WorkshopService {
  readonly #deps: WorkshopDeps;

  /**
   * O segredo desta sessão do agente.
   *
   * Desce no `sync` e no `owned` e volta em todo aviso do plugin —
   * menos no `ready`, que é quem o pede. Sem ele, um jogador digita o
   * marcador no chat e forja um `/skin give`. Nasce novo a cada
   * processo: um segredo fixo vazaria no primeiro log colado num
   * chat de suporte.
   */
  readonly #secret = randomUUID();

  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #pending = new Map<string, WorkshopSyncTrigger>();
  readonly #ownedTimers = new Map<string, NodeJS.Timeout>();
  readonly #ownedPending = new Map<string, OwnedPending>();

  /**
   * id do servidor -> o último catálogo que ENTROU nele.
   *
   * O `/streamer` de um jogador agenda reenvio em TODOS os
   * servidores, e a carga dos outros quase sempre não muda.
   */
  readonly #lastSent = new Map<string, string>();

  /** `servidor steamId` -> a última posse que entrou lá. */
  readonly #lastOwned = new Map<string, string>();

  /** id do servidor -> quantas skins o plugin confirmou ter aplicado. */
  readonly #applied = new Map<string, number>();

  /** Os `requestId` de `/skin add`/`give` já tratados, contra aviso repetido. */
  readonly #seenRequests = new Set<string>();

  #expiryTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(deps: WorkshopDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  stop(): void {
    this.#stopped = true;

    for (const timer of [...this.#timers.values(), ...this.#ownedTimers.values()]) {
      clearTimeout(timer);
    }

    this.#timers.clear();
    this.#pending.clear();
    this.#ownedTimers.clear();
    this.#ownedPending.clear();

    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }

  // ------------------------------------------------------------
  //  §1  AS CARGAS
  // ------------------------------------------------------------

  /**
   * O catálogo que desce para AQUELE servidor.
   *
   * Pública porque é o que o teste lê: provar "a skin desligada não
   * vai" não deveria exigir um console de mentira.
   */
  buildPayload(serverId: string): WorkshopPayload {
    // O repositório já filtra: só as LIGADAS, e só as da junção
    // deste servidor.
    const skins: WorkshopPayloadSkin[] = this.#deps.skins.listForServer(serverId).map((skin) => ({
      id: skin.id,
      label: skin.label,
      shortname: skin.shortname,
      skinId: skin.skinId,
      // "Pode faltar" (02 §5.1): sem valor, a chave não viaja.
      ...(skin.description === null ? {} : { description: skin.description }),
      ...(skin.rarity === null ? {} : { rarity: skin.rarity }),
      sort: skin.sort,
      openToAll: skin.openToAll,
      hideInStreamer: skin.hideInStreamer,
      // "Skin de temporada": o menu desenha uma linha por causa dela
      // (03 §3.5) e nada mais muda no jogo. Ver 02 §4.6.
      season: skin.season,
    }));

    const storeUrl = (this.#deps.storeUrl ?? '').trim();

    return {
      secret: this.#secret,
      skins,
      // ####  QUEM ESTÁ ESCONDENDO A LOGO, E NÃO QUEM É STREAMER  ####
      //
      // A skin do Workshop É a logo — um parceiro que escondeu só a
      // propaganda continua com o item marcado. Ver types/streamer.ts.
      streamers: this.#deps.streamers
        .active()
        .filter((profile) => profile.hideLogo)
        .map((profile) => profile.steamId),
      ...(storeUrl === '' ? {} : { storeUrl }),
    };
  }

  /**
   * A posse de UM jogador, como ela desce para AQUELE servidor.
   *
   * Só as vivas, e só as de skins que estão no catálogo deste
   * servidor (ligadas e na junção) — o resto o plugin não saberia
   * desenhar. `expiresAt` 0 = permanente.
   *
   * As FAVORITAS dele vêm na mesma carga, pelo mesmo filtro: favorita
   * de skin que não existe naquele servidor não tem célula para
   * marcar. São a lista de ids, inteira, nunca delta — o plugin troca
   * o conjunto de uma vez, como faz com a posse (02 §5.2).
   */
  buildOwnedPayload(serverId: string, steamId: string): WorkshopOwnedPayload {
    const now = this.#now();
    const here = new Set(this.#deps.skins.listForServer(serverId).map((skin) => skin.id));

    return {
      secret: this.#secret,
      steamId,
      skins: this.#deps.owned
        .liveOwnedForPlayer(steamId, now)
        .filter((owned) => here.has(owned.skinRef))
        .map((owned) => ({ id: owned.skinRef, expiresAt: owned.expiresAt ?? 0 })),
      favorites: this.#deps.owned.listFavorites(steamId).filter((skinRef) => here.has(skinRef)),
    };
  }

  /**
   * O catálogo como ele viaja: os comandos, em ordem.
   *
   * Pública pelo mesmo motivo do `buildPayload`: o teste corta uma
   * carga grande e confere que as partes remontam o original.
   */
  buildSyncCommands(payload: WorkshopPayload): readonly string[] {
    return chunkCommands(WORKSHOP_SYNC, payload);
  }

  /** A posse como ela viaja. `<steamId>` vem antes do lote. */
  buildOwnedCommands(payload: WorkshopOwnedPayload): readonly string[] {
    return chunkCommands(`${WORKSHOP_OWNED} ${payload.steamId}`, payload);
  }

  // ------------------------------------------------------------
  //  §2  EMPURRAR O CATÁLOGO
  // ------------------------------------------------------------

  /** Monta, corta, manda e confere. NUNCA lança. */
  async sync(serverId: string, trigger: WorkshopSyncTrigger = 'manual'): Promise<WorkshopSyncOutcome> {
    if (this.#stopped) return { status: 'skipped', reason: 'o agente está parando' };

    const rcon = this.#rconOf(serverId);

    // NÃO é erro: metade da lista costuma estar parada, e a
    // reconexão repassa a carga inteira.
    if (rcon === null) return { status: 'skipped', reason: 'sem RCON' };

    const payload = this.buildPayload(serverId);
    // O segredo é o mesmo a vida toda; o que muda é o resto.
    const fingerprint = JSON.stringify(payload);

    if (!isForced(trigger) && this.#lastSent.get(serverId) === fingerprint) {
      return { status: 'unchanged' };
    }

    const commands = this.buildSyncCommands(payload);
    const outcome = await this.#sendAll(rcon, commands, WORKSHOP_SYNC);

    if (outcome.status === 'failed') {
      // O que não entrou não pode ficar marcado como entrado.
      this.#lastSent.delete(serverId);

      // Sem esta linha, um servidor cujo plugin não conhece o
      // comando recusaria a carga em silêncio — e o sintoma seria
      // "o menu está vazio neste servidor", sem nada no log.
      this.#deps.logger?.warn(
        { server: serverId, trigger, err: outcome.error, parts: commands.length },
        'a carga do Workshop NÃO chegou a este servidor',
      );

      return outcome;
    }

    this.#lastSent.set(serverId, fingerprint);

    this.#deps.logger?.debug(
      { server: serverId, trigger, skins: payload.skins.length, parts: outcome.parts, bytes: outcome.bytes },
      'carga do Workshop enviada ao plugin',
    );

    return outcome;
  }

  /** O mesmo, em todos os servidores, com a posse de quem está lá. NUNCA lança. */
  async syncAll(trigger: WorkshopSyncTrigger): Promise<void> {
    for (const serverId of this.#deps.servers.ids()) {
      await this.#syncWithOwned(serverId, trigger);
    }
  }

  /**
   * O catálogo e, depois dele, a posse de todos os online.
   *
   * A posse vem DEPOIS porque é filtrada pelo catálogo: uma skin que
   * acabou de entrar neste servidor só vai para a posse de quem a tem
   * depois de existir aqui. O `streamer-toggled` não mexe na posse.
   */
  async #syncWithOwned(serverId: string, trigger: WorkshopSyncTrigger): Promise<void> {
    const outcome = await this.sync(serverId, trigger);

    if (trigger === 'streamer-toggled') return;
    if (outcome.status === 'skipped' || outcome.status === 'failed') return;

    await this.syncOwnedAll(serverId, 'catalog', isForced(trigger));
  }

  /**
   * Empurra daqui a pouco, juntando as edições em rajada.
   *
   * É por aqui que passa TUDO que nasce de dentro do gancho de
   * console. Ver o cabeçalho.
   */
  syncSoon(serverId: string, trigger: WorkshopSyncTrigger): void {
    if (this.#stopped) return;

    // O motivo mais forte vence: um salvamento no meio do debounce
    // não pode apagar o `plugin-requested` que o abriu.
    const pending = this.#pending.get(serverId);

    if (pending === undefined || !isForced(pending)) {
      // O `streamer-toggled` não pode apagar um `catalog-changed`
      // pendente: este último também leva a posse.
      if (!(trigger === 'streamer-toggled' && pending !== undefined)) {
        this.#pending.set(serverId, trigger);
      }
    }

    if (this.#timers.has(serverId)) return;

    const timer = setTimeout(() => {
      this.#timers.delete(serverId);

      const reason = this.#pending.get(serverId) ?? 'manual';

      this.#pending.delete(serverId);

      void this.#syncWithOwned(serverId, reason).catch((error: unknown) => {
        this.#deps.logger?.error(
          { server: serverId, err: toError(error) },
          'o envio da carga do Workshop lançou',
        );
      });
    }, SYNC_DELAY_MS);

    timer.unref();
    this.#timers.set(serverId, timer);
  }

  syncAllSoon(trigger: WorkshopSyncTrigger): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.syncSoon(serverId, trigger);
    }
  }

  /**
   * O servidor pode ter reiniciado: o plugin só tem a carga do disco.
   * Leva o catálogo e a posse de todos os online, forçados.
   */
  handleRconConnected(serverId: string): void {
    this.syncSoon(serverId, 'rcon-connected');
  }

  /**
   * O catálogo mudou.
   *
   * Rearma o relógio de vencimento junto: apagar uma skin leva posses
   * com prazo na cascata.
   */
  handleCatalogChanged(): void {
    this.syncAllSoon('catalog-changed');
    this.scheduleExpiry();
  }

  /** O modo streamer é da REDE: o jogador atravessa de servidor. */
  handleStreamerChanged(): void {
    this.syncAllSoon('streamer-toggled');
  }

  // ------------------------------------------------------------
  //  §3  EMPURRAR A POSSE
  // ------------------------------------------------------------

  /** A posse de um jogador, num servidor. NUNCA lança. */
  async syncOwned(
    serverId: string,
    steamId: string,
    trigger: WorkshopOwnedTrigger = 'manual',
    forced = false,
  ): Promise<WorkshopSyncOutcome> {
    if (this.#stopped) return { status: 'skipped', reason: 'o agente está parando' };

    const rcon = this.#rconOf(serverId);

    if (rcon === null) return { status: 'skipped', reason: 'sem RCON' };

    const key = `${serverId} ${steamId}`;
    const payload = this.buildOwnedPayload(serverId, steamId);
    const fingerprint = JSON.stringify(payload);

    if (!forced && this.#lastOwned.get(key) === fingerprint) {
      return { status: 'unchanged' };
    }

    const commands = this.buildOwnedCommands(payload);
    const outcome = await this.#sendAll(rcon, commands, WORKSHOP_OWNED);

    if (outcome.status === 'failed') {
      this.#lastOwned.delete(key);
      this.#deps.logger?.warn(
        { server: serverId, steamId, trigger, err: outcome.error, parts: commands.length },
        'a posse de skins NÃO chegou a este servidor',
      );

      return outcome;
    }

    this.#lastOwned.set(key, fingerprint);
    this.#deps.logger?.debug(
      { server: serverId, steamId, trigger, skins: payload.skins.length, parts: outcome.parts },
      'posse de skins enviada ao plugin',
    );

    return outcome;
  }

  /**
   * A posse de todos os online daquele servidor. NUNCA lança.
   *
   * Aproveita para esquecer a digital de quem não está mais lá: ela
   * serve para não repetir envio, e quem saiu recebe carga forçada
   * quando voltar.
   */
  async syncOwnedAll(serverId: string, trigger: WorkshopOwnedTrigger, forced: boolean): Promise<void> {
    const online = new Set(this.#deps.servers.onlineOf(serverId));

    for (const key of [...this.#lastOwned.keys()]) {
      const [server, steamId] = key.split(' ');

      if (server === serverId && steamId !== undefined && !online.has(steamId)) {
        this.#lastOwned.delete(key);
      }
    }

    for (const steamId of online) {
      const outcome = await this.syncOwned(serverId, steamId, trigger, forced);

      // Sem RCON, o resto da lista também não vai: a reconexão manda.
      if (outcome.status === 'skipped') return;
    }
  }

  /** Arma o envio da posse daqui a pouco, juntando pedidos. */
  syncOwnedSoon(
    serverId: string,
    players: readonly string[] | 'all',
    trigger: WorkshopOwnedTrigger,
    forced: boolean,
  ): void {
    if (this.#stopped) return;

    let pending = this.#ownedPending.get(serverId);

    if (pending === undefined) {
      pending = { all: false, forced: false, players: new Set(), trigger };
      this.#ownedPending.set(serverId, pending);
    }

    if (players === 'all') pending.all = true;
    else for (const steamId of players) pending.players.add(steamId);

    pending.forced ||= forced;
    pending.trigger = trigger;

    if (this.#ownedTimers.has(serverId)) return;

    const timer = setTimeout(() => {
      this.#ownedTimers.delete(serverId);

      const job = this.#ownedPending.get(serverId);

      this.#ownedPending.delete(serverId);

      if (job === undefined) return;

      void this.#runOwned(serverId, job).catch((error: unknown) => {
        this.#deps.logger?.error(
          { server: serverId, err: toError(error) },
          'o envio da posse de skins lançou',
        );
      });
    }, SYNC_DELAY_MS);

    timer.unref();
    this.#ownedTimers.set(serverId, timer);
  }

  async #runOwned(serverId: string, job: OwnedPending): Promise<void> {
    if (job.all) {
      await this.syncOwnedAll(serverId, job.trigger, job.forced);
      return;
    }

    for (const steamId of job.players) {
      const outcome = await this.syncOwned(serverId, steamId, job.trigger, job.forced);

      if (outcome.status === 'skipped') return;
    }
  }

  /**
   * Alguém entrou (`PresenceWatcher.onJoined`).
   *
   * Forçado: o plugin pode ter uma cópia do disco, de dias atrás, e a
   * digital daqui pode ser de uma sessão anterior.
   */
  handlePlayersJoined(serverId: string, steamIds: readonly string[]): void {
    if (steamIds.length === 0) return;

    this.syncOwnedSoon(serverId, steamIds, 'player-joined', true);
  }

  /**
   * A posse deste jogador mudou (painel, site, `/skin give`).
   *
   * Reenvia em CADA servidor em que ele está online — a posse é da
   * rede. Offline, nada sai: ele recebe ao entrar. Rearma o relógio
   * de vencimento, porque o prazo novo pode vencer antes do que o
   * relógio esperava.
   */
  handleOwnershipChanged(steamId: string): void {
    this.#resendOwned(steamId, 'ownership-changed');
    this.scheduleExpiry();
  }

  /**
   * A posse (e as favoritas) dele, em cada servidor onde ele está.
   *
   * `forced` existe para o caso em que o agente RECUSOU o que o plugin
   * pediu: a carga não mudou, então a digital diria "não mudou nada" —
   * e o plugin ficaria com o estado otimista que ele desenhou antes de
   * perguntar. Forçado, a verdade volta e desfaz o otimismo.
   */
  #resendOwned(steamId: string, trigger: WorkshopOwnedTrigger, forced = false): void {
    for (const serverId of this.#deps.servers.ids()) {
      if (this.#deps.servers.onlineOf(serverId).includes(steamId)) {
        this.syncOwnedSoon(serverId, [steamId], trigger, forced);
      }
    }
  }

  // ------------------------------------------------------------
  //  §4  O VENCIMENTO DA POSSE
  // ------------------------------------------------------------

  /**
   * Dorme até o próximo prazo, e acorda para registrar e reenviar.
   *
   * O plugin confere o prazo sozinho — o reenvio é o que TIRA a posse
   * vencida da carga de quem está online, e o registro é o que
   * responde "quem tirou minha skin?".
   */
  scheduleExpiry(): void {
    if (this.#stopped) return;

    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }

    const now = this.#now();

    // O que venceu com o agente desligado é registrado agora; e só
    // quem venceu tem a posse reenviada.
    for (const steamId of this.#recordExpired(now)) {
      this.#resendOwned(steamId, 'owned-expired');
    }

    const next = this.#deps.owned.nextExpiry(now);

    if (next === null) return;

    const delay = Math.min(Math.max(next - now + 250, 0), MAX_TIMER_MS);

    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      this.scheduleExpiry();
    }, delay);

    this.#expiryTimer.unref();
  }

  /** Registra o que venceu desde a última conferência. @returns quem venceu. */
  #recordExpired(now: number): ReadonlySet<string> {
    const meta = this.#deps.meta;
    const raw = meta?.read(EXPIRY_CHECKED_KEY) ?? null;
    const since = raw === null ? now : Number(raw);
    const players = new Set<string>();

    if (Number.isFinite(since) && since < now) {
      for (const owned of this.#deps.owned.expiredBetween(since, now)) {
        players.add(owned.steamId);
        this.#deps.owned.log(
          {
            actor: 'sistema',
            source: 'system',
            action: 'owned.expired',
            target: this.#skinLabel(owned.skinRef),
            steamId: owned.steamId,
            detail: { ownedId: owned.id, expiresAt: owned.expiresAt, source: owned.source },
          },
          owned.expiresAt ?? now,
        );
      }
    }

    meta?.write(EXPIRY_CHECKED_KEY, String(now));

    return players;
  }

  #skinLabel(id: number): string {
    const skin = this.#deps.skins.get(id);

    return skin === null ? `skin #${String(id)}` : `skin #${String(id)} "${skin.label}" (${skin.shortname})`;
  }

  // ------------------------------------------------------------
  //  §5  ESCUTAR
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

      // O `/streamer` também muda a carga. Quem grava é o
      // `StreamerSync`, no mesmo gancho e antes deste.
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
    if (!PLUGIN_LINE.test(line.trimStart())) return;

    const body = line.slice(line.indexOf(WORKSHOP_MARKER) + WORKSHOP_MARKER.length).trim();

    if (body === '') return;

    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== 'object' || parsed === null) return;

    const push = parsed as WorkshopPush;

    if (push.kind === 'ready') {
      // O ÚNICO sem segredo: é justamente ele que pede a carga. O
      // estrago de um forjado é um reenvio, que o agente faria na
      // próxima reconexão de qualquer jeito. Leva o catálogo e a
      // posse de todos os online.
      this.#deps.logger?.info({ server: serverId }, 'o OrigemZWorkshop subiu e pediu a carga');
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

      if (typeof push.message === 'string' && push.message !== '') {
        // Linha recusada lá é cadastro que o painel aceitou e o jogo
        // não — o motivo só existe aqui, e precisa aparecer.
        this.#deps.logger?.warn(
          { server: serverId, skins: count, message: push.message },
          'o OrigemZWorkshop recusou parte da carga',
        );
      }

      return;
    }

    if (push.kind === 'fav') {
      const request = workshopFavoriteRequestSchema.safeParse(parsed);

      if (!request.success) {
        this.#deps.logger?.warn(
          { server: serverId, issues: request.error.issues.slice(0, 3) },
          'favorita fora do contrato: descartada',
        );

        return;
      }

      // ####  NÃO TEM DEDUP POR requestId, E NÃO PRECISA  ####
      //
      // O aviso diz o ESTADO (`on`), e não "alterne": a mesma linha
      // duas vezes (o console repete em reconexão) dá no mesmo. Ver
      // `setFavorite` no repositório.
      //
      // Fora do gancho: a escrita reenvia a carga, que é um comando de
      // RCON. Ver o cabeçalho.
      const data = request.data;
      const favTimer = setTimeout(() => {
        this.#handleFavorite(serverId, data);
      }, 0);

      favTimer.unref();

      return;
    }

    if (push.kind === 'add' || push.kind === 'give') {
      const request =
        push.kind === 'add' ? workshopAddRequestSchema.safeParse(parsed) : workshopGiveRequestSchema.safeParse(parsed);

      if (!request.success) {
        this.#deps.logger?.warn(
          { server: serverId, kind: push.kind, issues: request.error.issues.slice(0, 3) },
          `pedido de /skin ${push.kind} fora do contrato: descartado`,
        );

        return;
      }

      // Um aviso pode chegar duas vezes (o console repete linha em
      // reconexão). O mesmo pedido não pode virar duas escritas.
      const requestKey = `${push.kind}:${request.data.requestId}`;

      if (this.#seenRequests.has(requestKey)) return;

      this.#seenRequests.add(requestKey);

      if (this.#seenRequests.size > 500) {
        this.#seenRequests.delete(this.#seenRequests.values().next().value as string);
      }

      // Fora do gancho: a resposta é um comando de RCON. Ver o
      // cabeçalho.
      const data = request.data;
      const timer = setTimeout(() => {
        void (data.kind === 'add' ? this.#handleAdd(serverId, data) : this.#handleGive(serverId, data));
      }, 0);

      timer.unref();

      return;
    }

    this.#deps.logger?.debug(
      { server: serverId, kind: push.kind },
      'aviso do Workshop de um tipo que este agente não conhece',
    );
  }

  /**
   * A estrela do menu (02 §5.4). NUNCA lança.
   *
   * O plugin já desenhou a estrela antes de avisar (otimista) e o
   * agente é a verdade: a escrita reenvia a posse+favoritas dele, e
   * uma RECUSA reenvia forçado, o que desfaz o otimismo.
   */
  #handleFavorite(serverId: string, request: WorkshopFavoriteRequest): void {
    try {
      this.#deps.catalog.setFavorite(request.steamId, request.skinId, request.on, this.#now());
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : null;

      this.#deps.logger?.[error === null ? 'error' : 'warn'](
        {
          server: serverId,
          steamId: request.steamId,
          skin: request.skinId,
          on: request.on,
          ...(error === null ? { err: toError(cause) } : { reason: error.code, message: error.message }),
        },
        'a favorita do menu foi recusada',
      );

      this.#resendOwned(request.steamId, 'favorite-changed', true);
    }
  }

  /** O `/skin add` do jogo, pela mesma regra do painel. NUNCA lança. */
  async #handleAdd(serverId: string, request: WorkshopAddRequest): Promise<void> {
    const actor = { name: `jogo:${describePlayer(request)}`, source: 'game' as const, serverId };

    let reply: WorkshopAddReply;

    try {
      const { skin, warning } = await this.#deps.catalog.createSkin(
        {
          label: '',
          shortname: request.shortname.trim().toLowerCase(),
          skinId: request.skinId.trim(),
          description: null,
          rarity: null,
          sort: 0,
          openToAll: false,
          hideInStreamer: true,
          enabled: true,
          // O `/skin add` do jogo não tem como dizer "de temporada": a
          // marca é decisão de operação, e sai do painel.
          season: false,
          // O cadastro do jogo vale no servidor de onde veio. Levar
          // para os outros é decisão do painel.
          servers: [serverId],
        },
        actor,
      );

      reply = {
        requestId: request.requestId,
        steamId: request.steamId,
        ok: true,
        message:
          `Skin "${skin.label}" cadastrada (#${String(skin.id)}) e ligada neste servidor. ` +
          'Ajuste descrição, raridade e servidores no painel.' +
          (warning === null ? '' : ` Aviso: ${warning}`),
      };
    } catch (cause) {
      reply = this.#refusal(serverId, request, actor.name, 'game.add-refused', `${request.shortname} ${request.skinId}`, cause);
    }

    await this.#reply(serverId, reply, 'skin-add');
  }

  /** O `/skin give` do jogo, pelo mesmo `grantOwnership` do painel. NUNCA lança. */
  async #handleGive(serverId: string, request: WorkshopGiveRequest): Promise<void> {
    const actorName = `jogo:${describePlayer(request)}`;
    const target =
      request.targetName === '' ? request.targetSteamId : `${request.targetName} (${request.targetSteamId})`;

    let reply: WorkshopAddReply;

    try {
      const skin = this.#deps.catalog.findSkinByMark(request.shortname, request.skinId);

      if (skin === null) {
        throw new ApiError(
          'WORKSHOP_SKIN_NOT_FOUND',
          `Nenhuma skin cadastrada com "${request.shortname}" e Workshop ID ${request.skinId}. ` +
            'Cadastre antes com /skin add.',
          404,
        );
      }

      const { owned } = this.#deps.catalog.grantOwnership(
        {
          steamId: request.targetSteamId,
          skinRef: skin.id,
          days: request.days ?? null,
          source: 'game',
          createdBy: actorName,
          serverId,
        },
        this.#now(),
      );

      reply = {
        requestId: request.requestId,
        steamId: request.steamId,
        ok: true,
        message:
          `Skin "${skin.label}" dada a ${target}: ` +
          (owned.expiresAt === null ? 'permanente.' : `vale até ${formatDate(owned.expiresAt)}.`),
      };
    } catch (cause) {
      reply = this.#refusal(
        serverId,
        request,
        actorName,
        'game.give-refused',
        `${request.shortname} ${request.skinId} -> ${request.targetSteamId}`,
        cause,
      );
    }

    await this.#reply(serverId, reply, 'skin-give');
  }

  /** A recusa de um pedido do jogo: frase de volta, e linha no registro. */
  #refusal(
    serverId: string,
    request: { readonly requestId: string; readonly steamId: string },
    actorName: string,
    action: string,
    target: string,
    cause: unknown,
  ): WorkshopAddReply {
    const message = cause instanceof ApiError ? cause.message : toError(cause).message;

    this.#deps.owned.log({
      actor: actorName,
      source: 'game',
      action,
      target,
      serverId,
      detail: { reason: cause instanceof ApiError ? cause.code : 'ERROR', message },
    });

    if (!(cause instanceof ApiError)) {
      this.#deps.logger?.error(
        { server: serverId, action, err: toError(cause) },
        'um pedido de admin do jogo falhou por um erro que não é de regra',
      );
    }

    return { requestId: request.requestId, steamId: request.steamId, ok: false, message };
  }

  async #reply(serverId: string, reply: WorkshopAddReply, trigger: string): Promise<void> {
    const rcon = this.#rconOf(serverId);

    if (rcon === null) return;

    const outcome = await pushState({
      rcon,
      command: WORKSHOP_REPLY,
      payload: reply,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status !== 'sent') {
      this.#deps.logger?.warn(
        { server: serverId, status: outcome.status, trigger },
        'a resposta ao admin não chegou ao jogo',
      );
    }
  }

  /**
   * Quantas skins o plugin daquele servidor confirmou.
   *
   * `null` = ele nunca confirmou nada. NÃO é zero: "nenhuma skin" e
   * "não sei" são respostas diferentes, e a tela precisa das duas.
   */
  appliedCount(serverId: string): number | null {
    return this.#applied.get(serverId) ?? null;
  }

  // ------------------------------------------------------------
  //  §6  PERGUNTAR
  // ------------------------------------------------------------

  /** O que o plugin diz ter de pé. Lança `WorkshopCommandError`. */
  async status(serverId: string): Promise<WorkshopStatus> {
    const reply = await this.#command(serverId, WORKSHOP_STATUS);
    const count = (key: string): number => (typeof reply[key] === 'number' ? reply[key] : 0);

    return {
      skins: count('skins'),
      ownedPlayers: count('ownedPlayers'),
      streamers: count('streamers'),
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

  /** Manda os pedaços em ordem, conferindo cada resposta. NUNCA lança. */
  async #sendAll(
    rcon: OpsRcon,
    commands: readonly string[],
    name: string,
  ): Promise<Extract<WorkshopSyncOutcome, { status: 'sent' | 'failed' }>> {
    let bytes = 0;

    try {
      for (const command of commands) {
        bytes += Buffer.byteLength(command, 'utf8');
        checkPushReply(await rcon.send(command), name);
      }
    } catch (cause) {
      return { status: 'failed', error: toError(cause) };
    }

    return { status: 'sent', bytes, parts: commands.length };
  }

  #rconOf(serverId: string): OpsRcon | null {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) return null;

    return context.rcon;
  }
}

/**
 * Corta a carga em pedaços: `<prefixo> <lote> <i> <n> <pedaço>`.
 *
 * `lote` são 12 caracteres hexadecimais, novos a cada carga; `i` vai
 * de 0 a n-1. Sempre neste formato, mesmo com um pedaço só.
 */
function chunkCommands(prefix: string, payload: unknown): readonly string[] {
  const encoded = encodePushPayload(payload);
  const parts = Math.max(1, Math.ceil(encoded.length / WORKSHOP_CHUNK_CHARS));
  const batch = randomUUID().replace(/-/g, '').slice(0, 12);
  const commands: string[] = [];

  for (let index = 0; index < parts; index += 1) {
    const piece = encoded.slice(index * WORKSHOP_CHUNK_CHARS, (index + 1) * WORKSHOP_CHUNK_CHARS);

    commands.push(`${prefix} ${batch} ${String(index)} ${String(parts)} ${piece}`);
  }

  return commands;
}

function describePlayer(request: { readonly playerName: string; readonly steamId: string }): string {
  return request.playerName === '' ? request.steamId : `${request.playerName} (${request.steamId})`;
}

/** A data para o chat do admin, no fuso da casa. */
function formatDate(at: number): string {
  return new Date(at).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/**
 * A resposta de um pedaço de carga, conferida.
 *
 * @throws quando o plugin recusou ou não respondeu JSON.
 */
function checkPushReply(raw: string, name: string): void {
  const line = firstJsonLine(raw);

  if (line === null) {
    throw new Error(
      `o servidor respondeu ao ${name} sem JSON (veio: ${raw.trim().slice(0, 200)}). ` +
        'O OrigemZWorkshop (0.3.0 ou mais novo) está carregado?',
    );
  }

  const refused = pushErrorSchema.safeParse(line);

  if (refused.success) {
    throw new Error(`o plugin recusou o ${name}: ${refused.data.error}`);
  }

  if (!pushOkSchema.safeParse(line).success) {
    throw new Error(`a resposta do ${name} não bate com o contrato: ${JSON.stringify(line).slice(0, 200)}`);
  }
}

/**
 * A resposta do comando, sem o que o plugin falou por cima.
 *
 * Um `Puts` disparado no frame do comando entra na resposta casada
 * do RCON e quebra o JSON. O plugin já tira o aviso do frame; isto
 * é a segunda tranca.
 */
export function cleanReply(reply: string): string {
  return reply
    .split(SPLIT_LINES)
    .filter((line) => !line.includes(WORKSHOP_MARKER))
    .join('\n')
    .trim();
}
