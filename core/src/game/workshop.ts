// ============================================================
//  workshop.ts  -  as skins do Workshop, do lado do agente.
//
//  ####  O QUE É DAQUI E O QUE É DO PLUGIN  ####
//
//    AQUI     o catálogo, as coleções, os acessos, em que
//             servidores cada skin vale, quem está em modo
//             streamer, e o registro de tudo isso
//    LÁ       a caixa do `/skin`, o `/skin <coleção>`, a decisão
//             "este jogador pode?" (grupo e permissão do Oxide só
//             existem lá) e a troca do número no item
//
//  ####  A CARGA É COMPLETA, E DESCE EM PEDAÇOS  ####
//
//  Nunca um delta: quem sumiu da lista some do jogo no instante em
//  que a carga é aplicada. Com acessos por jogador, a carga passa do
//  frame de 50 KB do WebRCON com poucas centenas de linhas — então
//  ela é cortada:
//
//      origemz.workshop.sync <lote> <i> <n> <pedaço base64>
//
//  O plugin guarda os pedaços do mesmo lote e só troca o que tem
//  quando o último chega. Um lote que não se completa (o RCON caiu
//  no meio) é descartado lá — o plugin continua com a carga velha,
//  inteira, que é melhor que meia carga nova.
//
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO DE CONSOLE  ####
//
//  A lição medida do `agent-requests.ts`, repetida no `koth.ts`: um
//  comando mandado de dentro do `onConsoleLine` imprime no console,
//  a linha volta e dispara de novo. O `ready`, o `/streamer` e o
//  `/skin add` só ARMAM trabalho; o comando sai de um relógio.
//
//  ####  O `/skin add` DO JOGO  ####
//
//      admin digita  /skin add "metal.facemask" "3802433262"
//            ↓  o plugin confere item e número, e grita
//      #OZWORKSHOP#{"kind":"add","secret":…,"requestId":…}
//            ↓  este arquivo
//      WorkshopCatalog.createSkin   ← a MESMA regra do painel
//            ↓
//      origemz.workshop.reply <base64>  → a frase no chat do admin
//      origemz.workshop.sync …          → a skin já na caixa
//
//  Ver Docs/OrigemZWorkshop/01-CAIXA-E-COLECOES.md.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { MetaRepository } from '../db/meta-repository.js';
import type { StreamerRepository } from '../db/streamer-repository.js';
import type { WorkshopAccessRepository } from '../db/workshop-access-repository.js';
import type { WorkshopSkinsRepository } from '../db/workshop-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { parseStreamerNotice } from '../types/streamer-transport.js';
import {
  workshopAddRequestSchema,
  type WorkshopAddReply,
  type WorkshopAddRequest,
  type WorkshopPayload,
  type WorkshopPayloadCollection,
  type WorkshopPayloadGrant,
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
export const WORKSHOP_STATUS = 'origemz.workshop.status';
export const WORKSHOP_REPLY = 'origemz.workshop.reply';

/**
 * O tamanho de cada pedaço, em caracteres de base64.
 *
 * 40 KB mais o nome do comando e os três números cabe folgado nos
 * 50 KB do `MAX_PUSH_BYTES` — base64 é ASCII, então caractere e
 * byte são a mesma conta.
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

/** Onde o relógio de vencimento lembra até quando já conferiu. */
const EXPIRY_CHECKED_KEY = 'workshop.expiry_checked_at';

export type WorkshopSyncTrigger =
  | 'startup'
  | 'rcon-connected'
  | 'plugin-requested'
  | 'catalog-changed'
  | 'streamer-toggled'
  | 'grant-expired'
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
}

export interface WorkshopDeps {
  readonly skins: WorkshopSkinsRepository;
  readonly access: WorkshopAccessRepository;
  /**
   * Quem está em modo streamer. Lido a cada envio: a lista é
   * pequena, e um cache aqui seria a terceira cópia da verdade.
   */
  readonly streamers: StreamerRepository;
  readonly servers: WorkshopServers;
  /** As regras do cadastro. É por aqui que o `/skin add` grava. */
  readonly catalog: WorkshopCatalog;
  /** Guarda até quando o vencimento de acessos já foi registrado. */
  readonly meta?: MetaRepository;
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

export class WorkshopService {
  readonly #deps: WorkshopDeps;

  /**
   * O segredo desta sessão do agente.
   *
   * Desce no `sync` e volta em todo aviso do plugin — menos no
   * `ready`, que é quem o pede. Sem ele, um jogador digita o
   * marcador no chat e forja um `/skin add`. Nasce novo a cada
   * processo: um segredo fixo vazaria no primeiro log colado num
   * chat de suporte.
   */
  readonly #secret = randomUUID();

  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #pending = new Map<string, WorkshopSyncTrigger>();

  /**
   * id do servidor -> a última carga que ENTROU nele.
   *
   * O `/streamer` de um jogador agenda reenvio em TODOS os
   * servidores, e a carga dos outros quase sempre não muda.
   */
  readonly #lastSent = new Map<string, string>();

  /** id do servidor -> quantas skins o plugin confirmou ter aplicado. */
  readonly #applied = new Map<string, number>();

  /** Os `requestId` de `/skin add` já tratados, contra aviso repetido. */
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

    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
    this.#pending.clear();

    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }

  // ------------------------------------------------------------
  //  §1  A CARGA
  // ------------------------------------------------------------

  /**
   * O que desce para AQUELE servidor.
   *
   * Pública porque é o que o teste lê: provar "a skin desligada não
   * vai" não deveria exigir um console de mentira.
   */
  buildPayload(serverId: string): WorkshopPayload {
    const now = this.#now();

    // O repositório já filtra: só as LIGADAS, e só as da junção
    // deste servidor.
    const skins: WorkshopPayloadSkin[] = this.#deps.skins.listForServer(serverId).map((skin) => ({
      id: skin.id,
      label: skin.label,
      shortname: skin.shortname,
      skinId: skin.skinId,
      permission: skin.permission,
      collectionId: skin.collectionId,
      openToAll: skin.openToAll,
      hideInStreamer: skin.hideInStreamer,
    }));

    const skinIds = new Set(skins.map((skin) => skin.id));
    const usedCollections = new Set(
      skins.map((skin) => skin.collectionId).filter((id): id is number => id !== null),
    );

    // ####  SÓ AS COLEÇÕES QUE TÊM ALGO AQUI  ####
    //
    // Uma coleção sem nenhuma skin neste servidor faria o `/skin
    // neve` responder "0 itens alterados", que parece defeito. Fora
    // da carga, o plugin responde "não existe coleção neve aqui" —
    // que é a verdade deste servidor.
    const collections: WorkshopPayloadCollection[] = this.#deps.skins
      .listCollections()
      .filter((collection) => collection.enabled && usedCollections.has(collection.id))
      .map((collection) => ({
        id: collection.id,
        slug: collection.slug,
        label: collection.label,
        permission: collection.permission,
        openToAll: collection.openToAll,
      }));

    const collectionIds = new Set(collections.map((collection) => collection.id));

    const grants: WorkshopPayloadGrant[] = this.#deps.access
      .liveGrants(now)
      .filter((grant) =>
        grant.targetType === 'skin' ? skinIds.has(grant.targetId) : collectionIds.has(grant.targetId),
      )
      .map((grant) => ({
        subjectType: grant.subjectType,
        subject: grant.subject,
        targetType: grant.targetType,
        targetId: grant.targetId,
        expiresAt: grant.expiresAt,
      }));

    return {
      secret: this.#secret,
      skins,
      collections,
      grants,
      // ####  QUEM ESTÁ ESCONDENDO A LOGO, E NÃO QUEM É STREAMER  ####
      //
      // A skin do Workshop É a logo — um parceiro que escondeu só a
      // propaganda continua com o item marcado. Ver types/streamer.ts.
      streamers: this.#deps.streamers
        .active()
        .filter((profile) => profile.hideLogo)
        .map((profile) => profile.steamId),
    };
  }

  /**
   * A carga como ela viaja: os comandos, em ordem.
   *
   * Pública pelo mesmo motivo do `buildPayload`: o teste corta uma
   * carga grande e confere que as partes remontam o original.
   */
  buildSyncCommands(payload: WorkshopPayload): readonly string[] {
    const encoded = encodePushPayload(payload);
    const parts = Math.max(1, Math.ceil(encoded.length / WORKSHOP_CHUNK_CHARS));
    const batch = randomUUID().replace(/-/g, '').slice(0, 12);
    const commands: string[] = [];

    for (let index = 0; index < parts; index += 1) {
      const piece = encoded.slice(index * WORKSHOP_CHUNK_CHARS, (index + 1) * WORKSHOP_CHUNK_CHARS);

      commands.push(`${WORKSHOP_SYNC} ${batch} ${String(index)} ${String(parts)} ${piece}`);
    }

    return commands;
  }

  // ------------------------------------------------------------
  //  §2  EMPURRAR
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
    let bytes = 0;

    try {
      for (const command of commands) {
        bytes += Buffer.byteLength(command, 'utf8');
        checkPushReply(await rcon.send(command));
      }
    } catch (cause) {
      const error = toError(cause);

      // O que não entrou não pode ficar marcado como entrado.
      this.#lastSent.delete(serverId);

      // Sem esta linha, um servidor cujo plugin não conhece o
      // comando recusaria a carga em silêncio — e o sintoma seria
      // "a caixa está vazia neste servidor", sem nada no log.
      this.#deps.logger?.warn(
        { server: serverId, trigger, err: error, parts: commands.length },
        'a carga do Workshop NÃO chegou a este servidor',
      );

      return { status: 'failed', error };
    }

    this.#lastSent.set(serverId, fingerprint);

    this.#deps.logger?.debug(
      {
        server: serverId,
        trigger,
        skins: payload.skins.length,
        collections: payload.collections.length,
        grants: payload.grants.length,
        parts: commands.length,
        bytes,
      },
      'carga do Workshop enviada ao plugin',
    );

    return { status: 'sent', bytes, parts: commands.length };
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

    // O motivo mais forte vence: um salvamento no meio do debounce
    // não pode apagar o `plugin-requested` que o abriu.
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

  /** O servidor pode ter reiniciado: o plugin só tem a carga do disco. */
  handleRconConnected(serverId: string): void {
    this.syncSoon(serverId, 'rcon-connected');
  }

  /**
   * O catálogo ou os acessos mudaram.
   *
   * Rearma o relógio de vencimento junto: um acesso novo de 1 hora
   * pode vencer antes do que o relógio esperava.
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
  //  §3  O VENCIMENTO DOS ACESSOS
  // ------------------------------------------------------------

  /**
   * Dorme até o próximo prazo, e acorda para reenviar e registrar.
   *
   * O plugin confere o prazo sozinho — o reenvio é o que TIRA a
   * linha vencida da carga, e o registro é o que responde "quem
   * tirou minha skin?".
   */
  scheduleExpiry(): void {
    if (this.#stopped) return;

    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }

    const now = this.#now();

    // O que venceu com o agente desligado é registrado agora.
    this.#recordExpired(now);

    const next = this.#deps.access.nextExpiry(now);

    if (next === null) return;

    const delay = Math.min(Math.max(next - now + 250, 0), MAX_TIMER_MS);

    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      this.syncAllSoon('grant-expired');
      this.scheduleExpiry();
    }, delay);

    this.#expiryTimer.unref();
  }

  #recordExpired(now: number): void {
    const meta = this.#deps.meta;
    const raw = meta?.read(EXPIRY_CHECKED_KEY) ?? null;
    const since = raw === null ? now : Number(raw);

    if (Number.isFinite(since) && since < now) {
      for (const grant of this.#deps.access.expiredBetween(since, now)) {
        this.#deps.access.log({
          actor: 'sistema',
          source: 'system',
          action: 'grant.expire',
          target:
            grant.targetType === 'skin'
              ? this.#skinLabel(grant.targetId)
              : this.#collectionLabel(grant.targetId),
          steamId: grant.subjectType === 'player' ? grant.subject : null,
          detail: {
            grantId: grant.id,
            subjectType: grant.subjectType,
            subject: grant.subject,
            expiresAt: grant.expiresAt,
          },
        }, grant.expiresAt ?? now);
      }
    }

    meta?.write(EXPIRY_CHECKED_KEY, String(now));
  }

  #skinLabel(id: number): string {
    const skin = this.#deps.skins.get(id);

    return skin === null ? `skin #${String(id)}` : `skin #${String(id)} "${skin.label}" (${skin.shortname})`;
  }

  #collectionLabel(id: number): string {
    const collection = this.#deps.skins.getCollection(id);

    return collection === null ? `coleção #${String(id)}` : `coleção "${collection.slug}"`;
  }

  // ------------------------------------------------------------
  //  §4  ESCUTAR
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
      // próxima reconexão de qualquer jeito.
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

    if (push.kind === 'add') {
      const request = workshopAddRequestSchema.safeParse(parsed);

      if (!request.success) {
        this.#deps.logger?.warn(
          { server: serverId, issues: request.error.issues.slice(0, 3) },
          'pedido de /skin add fora do contrato: descartado',
        );

        return;
      }

      // Um aviso pode chegar duas vezes (o console repete linha em
      // reconexão). O mesmo pedido não pode virar dois cadastros.
      if (this.#seenRequests.has(request.data.requestId)) return;

      this.#seenRequests.add(request.data.requestId);

      if (this.#seenRequests.size > 500) {
        this.#seenRequests.delete(this.#seenRequests.values().next().value as string);
      }

      // Fora do gancho: a resposta é um comando de RCON. Ver o
      // cabeçalho.
      const timer = setTimeout(() => {
        void this.#handleAdd(serverId, request.data);
      }, 0);

      timer.unref();

      return;
    }

    this.#deps.logger?.debug(
      { server: serverId, kind: push.kind },
      'aviso do Workshop de um tipo que este agente não conhece',
    );
  }

  /** O `/skin add` do jogo, pela mesma regra do painel. NUNCA lança. */
  async #handleAdd(serverId: string, request: WorkshopAddRequest): Promise<void> {
    const who = request.playerName === '' ? request.steamId : `${request.playerName} (${request.steamId})`;
    const actor = { name: `jogo:${who}`, source: 'game' as const, serverId };

    let reply: WorkshopAddReply;

    try {
      const { skin, warning } = await this.#deps.catalog.createSkin(
        {
          label: '',
          shortname: request.shortname.trim().toLowerCase(),
          skinId: request.skinId.trim(),
          permission: null,
          collectionId: null,
          openToAll: false,
          hideInStreamer: true,
          enabled: true,
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
          `Skin "${skin.label}" cadastrada (#${String(skin.id)}) e liberada neste servidor. ` +
          'Ajuste permissão, coleção e servidores no painel.' +
          (warning === null ? '' : ` Aviso: ${warning}`),
      };
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : toError(cause).message;

      reply = { requestId: request.requestId, steamId: request.steamId, ok: false, message };

      this.#deps.access.log({
        actor: actor.name,
        source: 'game',
        action: 'game.add-refused',
        target: `${request.shortname} ${request.skinId}`,
        serverId,
        detail: { reason: cause instanceof ApiError ? cause.code : 'ERROR', message },
      });

      if (!(cause instanceof ApiError)) {
        this.#deps.logger?.error(
          { server: serverId, err: toError(cause) },
          'o /skin add do jogo falhou por um erro que não é de regra',
        );
      }
    }

    const rcon = this.#rconOf(serverId);

    if (rcon === null) return;

    const outcome = await pushState({
      rcon,
      command: WORKSHOP_REPLY,
      payload: reply,
      logger: this.#deps.logger,
      trigger: 'skin-add',
    });

    if (outcome.status !== 'sent') {
      this.#deps.logger?.warn(
        { server: serverId, status: outcome.status },
        'a resposta do /skin add não chegou ao jogo',
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
  //  §5  PERGUNTAR
  // ------------------------------------------------------------

  /** O que o plugin diz ter de pé. Lança `WorkshopCommandError`. */
  async status(serverId: string): Promise<WorkshopStatus> {
    const reply = await this.#command(serverId, WORKSHOP_STATUS);
    const count = (key: string): number => (typeof reply[key] === 'number' ? reply[key] : 0);

    return {
      skins: count('skins'),
      collections: count('collections'),
      grants: count('grants'),
      streamers: count('streamers'),
      openBoxes: count('openBoxes'),
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
 * A resposta de um pedaço da carga, conferida.
 *
 * @throws quando o plugin recusou ou não respondeu JSON.
 */
function checkPushReply(raw: string): void {
  const line = firstJsonLine(raw);

  if (line === null) {
    throw new Error(
      `o servidor respondeu ao ${WORKSHOP_SYNC} sem JSON (veio: ${raw.trim().slice(0, 200)}). ` +
        'O OrigemZWorkshop está carregado?',
    );
  }

  const refused = pushErrorSchema.safeParse(line);

  if (refused.success) {
    throw new Error(`o plugin recusou o ${WORKSHOP_SYNC}: ${refused.data.error}`);
  }

  if (!pushOkSchema.safeParse(line).success) {
    throw new Error(`a resposta do ${WORKSHOP_SYNC} não bate com o contrato: ${JSON.stringify(line).slice(0, 200)}`);
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
