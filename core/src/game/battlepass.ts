// ============================================================
//  battlepass.ts  -  o Passe de Batalha, do lado do agente.
//
//  ####  O QUE É DAQUI E O QUE É DO PLUGIN  ####
//
//    AQUI     a temporada, a trilha, o XP, quem comprou, o que já
//             foi resgatado, a entrega de verdade e o registro
//    LÁ       a tela, o estado de cada faixa NO DESENHO, e o pedido
//
//  O `OrigemZBattlePass.cs` nunca entrega nada: ele PEDE. Quem
//  decide "pode resgatar isto?" é o `battlepass/service.ts`, e este
//  arquivo não reimplementa regra nenhuma — ele é o FIO entre as
//  duas pontas, que já existiam e não se falavam.
//
//  ####  DUAS CARGAS, AS DUAS INTEIRAS  ####
//
//  1. O CATÁLOGO do servidor (temporada, trilha e preço):
//
//      origemz.passe.sync <lote> <i> <n> <pedaço base64>
//
//  2. O PROGRESSO de UM jogador, que é a verdade sobre ele:
//
//      origemz.passe.progress <steamId> <lote> <i> <n> <pedaço>
//
//  As duas em pedaços de até 40 KB de base64 (o frame do WebRCON é
//  de 50 KB), sempre no mesmo formato — MESMO com um pedaço só. O
//  plugin guarda os pedaços do mesmo lote e só troca o que tem
//  quando o último chega; lote fora de ordem é descartado inteiro e
//  a cópia anterior sobrevive.
//
//  O `sync` é quem DESTRAVA o resto: progresso que chega antes do
//  catálogo é recusado com `NO_SEASON`, e o agente reenvia no
//  próximo gatilho.
//
//  ####  AS QUATRO REGRAS DO CANAL, TODAS JÁ PAGAS  ####
//
//  1. BASE64 OBRIGATÓRIO — o parser de console do Rust come as
//     aspas de um JSON cru (ver game/plugin-push.ts).
//  2. SEGREDO POR SUBIDA em todo marcador, menos no `ready`: o
//     `onConsoleLine` recebe o CHAT junto com o resto, e sem o
//     segredo um jogador digita o próprio resgate no chat.
//  3. NENHUM `Puts` no frame do comando — ele entra na resposta
//     casada do RCON e a quebra. Isso é do lado de lá; daqui, o que
//     importa é que a resposta pode vir suja e passa por
//     `firstJsonLine`.
//  4. NENHUM COMANDO DE RCON DE DENTRO DO GANCHO DE CONSOLE: a
//     linha que sai volta pelo mesmo gancho e o agente entra em
//     laço com ele mesmo. Tudo por relógio (`setTimeout`).
//
//  ####  DEPOIS DO `reply`, O `progress`. NÃO É OPCIONAL  ####
//
//  É a única coisa que o contrato do plugin exige deste lado. A
//  tela desenha o clique NA HORA — o resgate vira "esperando" antes
//  de qualquer resposta — e é a carga de `progress` que apaga essa
//  marca. Sem ela, um resgate RECUSADO continua parecendo em
//  andamento até o jogador fechar e reabrir o menu.
//
//  E ele vai FORÇADO: uma recusa não muda nada no banco, então a
//  digital diria "não mudou nada" e o otimismo ficaria na tela.
//
//  ####  "AUSENTE NÃO É VAZIO"  ####
//
//  Sem temporada ativa, NADA desce: nem catálogo nem progresso. O
//  plugin mostra "sincronizando" para quem ele não conhece, que é
//  diferente de mostrar cadeado — "não sei" e "não tem" são
//  respostas diferentes, e só uma delas é verdade.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { BattlePassService, ClaimResult } from '../battlepass/service.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import {
  BATTLEPASS_OPEN,
  BATTLEPASS_PROGRESS,
  BATTLEPASS_REPLY,
  BATTLEPASS_STATUS,
  BATTLEPASS_SYNC,
  battlePassClaimPushSchema,
  battlePassOpenPushSchema,
  battlePassPlayerPushSchema,
  claimExceptionsOf,
  payloadOriginOf,
  xpToReach,
  type BattlePassLane,
  type BattlePassPayload,
  type BattlePassPayloadLevel,
  type BattlePassPayloadPending,
  type BattlePassPayloadReward,
  type BattlePassClaimPush,
  type BattlePassPlayerPush,
  type BattlePassProgressPayload,
  type BattlePassReply,
  type BattlePassStatus,
  type DeliveryOutcome,
  type PendingDelivery,
  type TrackCell,
} from '../types/battlepass.js';
import type { QuestReward } from '../types/quests.js';
import { toError } from '../util.js';
import { firstJsonLine } from './plugin-contract.js';
import { encodePushPayload, pushErrorSchema, pushOkSchema } from './plugin-push.js';
import { rewardLine, type QuestsCatalog } from './ui-quests-screen.js';

/** O marcador do aviso. O mesmo `Marker` do OrigemZBattlePass.cs. */
export const BATTLEPASS_MARKER = '#OZPASSE#';

/**
 * O tamanho de cada pedaço, em caracteres de base64.
 *
 * O mesmo do Workshop, pelo mesmo motivo: 40 KB mais o nome do
 * comando, o SteamID e os três números cabem folgado nos 50 KB do
 * `MAX_PUSH_BYTES` — base64 é ASCII, então caractere e byte são a
 * mesma conta.
 */
export const BATTLEPASS_CHUNK_CHARS = 40_000;

/** Quebra de linha do console, nos dois sabores. */
const SPLIT_LINES = /\r?\n/;

/**
 * A âncora da linha.
 *
 * O marcador tem de estar no COMEÇO, depois de no máximo dois
 * prefixos entre colchetes (`[OrigemZBattlePass] `, que é o que o
 * `Puts` do Oxide acrescenta). A linha de chat traz o nome de quem
 * falou ANTES do texto e não passa — sem isto, qualquer jogador
 * forjaria um resgate digitando o marcador no chat.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZPASSE#/;

/**
 * O relógio que separa o gancho de console do comando de RCON.
 *
 * Um segundo, como o do Workshop: tempo de juntar a rajada de um
 * `oxide.reload` que derruba todos os plugins de uma vez, e de a
 * escrita que a linha provocou já estar no banco.
 */
const SYNC_DELAY_MS = 1000;

/** Quantos `requestId` já tratados este processo lembra. */
const SEEN_REQUESTS_MAX = 500;

export type BattlePassSyncTrigger =
  | 'startup'
  | 'rcon-connected'
  /** O `#OZPASSE#{"kind":"ready"}`: o plugin subiu e pediu a carga. */
  | 'plugin-requested'
  /** A temporada ou a trilha mudou no painel. */
  | 'season-changed'
  | 'manual';

export type BattlePassProgressTrigger =
  | 'player-joined'
  /** O jogador abriu a tela: ele quer o número fresco. */
  | 'menu-opened'
  /** O XP, o resgate ou o direito dele mudaram. */
  | 'progress-changed'
  /** A carga que apaga o otimismo do clique. Ver o cabeçalho. */
  | 'after-reply'
  /** O catálogo desceu: o progresso vem atrás dele. */
  | 'season'
  | 'manual';

/**
 * O que ignora o dedup.
 *
 * O plugin que acabou de subir e o RCON que acabou de reconectar não
 * têm carga nenhuma — mandar "não mudou nada" para eles seria
 * deixá-los com a cópia do disco até alguém editar a temporada.
 */
function isForced(trigger: BattlePassSyncTrigger): boolean {
  return trigger === 'startup' || trigger === 'rcon-connected' || trigger === 'plugin-requested';
}

export interface BattlePassServers {
  readonly ids: () => readonly string[];
  /** `null` = o servidor existe, mas está desligado — sem RCON. */
  readonly contextOf: (serverId: string) => { readonly rcon: OpsRcon } | null;
  /** Quem o agente sabe estar online AGORA naquele servidor. */
  readonly onlineOf: (serverId: string) => readonly string[];
}

/**
 * A loja, vista daqui. Só o que o botão ATIVAR O PASSE precisa.
 *
 * ####  POR QUE NÃO O `StoreService` INTEIRO  ####
 *
 * A compra do passe já tem dono (a frente C): ela confere o mês,
 * recusa quem já tem, debita e concede pelo `PassGranter`. O que
 * falta é alguém apertar o botão — e para isso bastam duas
 * perguntas. Injetar o serviço inteiro traria a carteira, o estorno
 * e o catálogo para dentro de um arquivo que fala com o console.
 */
export interface BattlePassStore {
  /**
   * A oferta de passe daquele mês, ou `null`.
   *
   * `null` = o passe não está à venda aqui e agora, e a tela mostra
   * a faixa paga com cadeado e SEM botão de comprar.
   */
  readonly passOffer: (
    serverId: string,
    period: string,
  ) => { readonly id: string; readonly price: number } | null;
  /** Compra, e devolve a frase que o jogador lê. NUNCA lança. */
  readonly buy: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly offerId: string;
  }) => Promise<{ readonly ok: boolean; readonly message: string }>;
}

/**
 * Quem põe na mão o que o resgate prometeu.
 *
 * ####  AUSENTE, O RESGATE VAI INTEIRO PARA A CAIXA  ####
 *
 * E isso é um desfecho VÁLIDO, não um defeito: a caixa existe
 * exatamente para a promessa que ainda não chegou (01 §7), e o
 * jogador lê isso na frase do rodapé. O que não pode acontecer é o
 * resgate dizer "confira a mochila" quando ninguém entregou nada.
 */
export interface BattlePassDelivery {
  /** NUNCA lança: toda falha vira um `DeliveryOutcome` com o código cru. */
  deliver(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly claimId: number;
    readonly level: number;
    readonly lane: BattlePassLane;
    readonly rewards: readonly QuestReward[];
  }): Promise<readonly DeliveryOutcome[]>;
}

export interface BattlePassSyncDeps {
  /** A porta ÚNICA do módulo. Toda regra sai daqui. */
  readonly service: BattlePassService;
  readonly servers: BattlePassServers;
  /** O nome que o admin deu ao servidor. O id não diz nada a quem joga. */
  readonly serverNameOf: (serverId: string) => string;
  /**
   * O catálogo que transforma `metal.refined` em "Metal Refinado".
   *
   * O mesmo das missões, de propósito: o jogador lê a mesma frase
   * para a mesma recompensa nas duas telas.
   */
  readonly catalog?: QuestsCatalog | undefined;
  readonly store?: BattlePassStore | undefined;
  readonly deliver?: BattlePassDelivery | undefined;
  readonly logger?: Logger | undefined;
  /** Para o teste controlar o tempo. */
  readonly now?: () => number;
}

export class BattlePassCommandError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'BattlePassCommandError';
    this.reason = reason;
  }
}

/** O desfecho de um envio. */
export type BattlePassSyncOutcome =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'unchanged' }
  | { readonly status: 'sent'; readonly bytes: number; readonly parts: number }
  | { readonly status: 'failed'; readonly error: Error };

/** O progresso pendente de um servidor: todos os online, ou alguns. */
interface ProgressPending {
  all: boolean;
  forced: boolean;
  readonly players: Set<string>;
  trigger: BattlePassProgressTrigger;
}

export class BattlePassSync {
  readonly #deps: BattlePassSyncDeps;

  /**
   * O segredo desta subida do agente.
   *
   * Desce no `sync` e no `progress` e volta em todo aviso do plugin
   * — menos no `ready`, que é quem o pede. Nasce novo a cada
   * processo: um segredo fixo vazaria no primeiro log colado num
   * chat de suporte.
   */
  readonly #secret = randomUUID();

  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #pending = new Map<string, BattlePassSyncTrigger>();
  readonly #progressTimers = new Map<string, NodeJS.Timeout>();
  readonly #progressPending = new Map<string, ProgressPending>();

  /** id do servidor -> o último catálogo que ENTROU nele. */
  readonly #lastSent = new Map<string, string>();

  /** `servidor steamId` -> o último progresso que entrou lá. */
  readonly #lastProgress = new Map<string, string>();

  /** Os `requestId` já tratados, contra a linha repetida na reconexão. */
  readonly #seenRequests = new Set<string>();

  #stopped = false;

  constructor(deps: BattlePassSyncDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  stop(): void {
    this.#stopped = true;

    for (const timer of [...this.#timers.values(), ...this.#progressTimers.values()]) {
      clearTimeout(timer);
    }

    this.#timers.clear();
    this.#pending.clear();
    this.#progressTimers.clear();
    this.#progressPending.clear();
  }

  // ------------------------------------------------------------
  //  §1  AS CARGAS
  // ------------------------------------------------------------

  /**
   * O catálogo que desce para AQUELE servidor.
   *
   * `null` = não há temporada ativa ali, e aí NADA desce. Ver
   * "ausente não é vazio" no cabeçalho.
   *
   * Pública porque é o que o teste lê: provar "a faixa desligada não
   * vai" não deveria exigir um console de mentira.
   */
  buildPayload(serverId: string): BattlePassPayload | null {
    const season = this.#deps.service.activeSeason(serverId);

    if (season === null) return null;

    const cells = new Map(
      this.#deps.service
        .track(season.id)
        .map((cell) => [`${String(cell.level)}:${cell.lane}`, cell]),
    );
    const levels: BattlePassPayloadLevel[] = [];

    for (let level = 1; level <= season.levels; level += 1) {
      const free = season.freeLane ? this.#rewardOf(cells.get(`${String(level)}:free`)) : null;
      const paid = season.paidLane ? this.#rewardOf(cells.get(`${String(level)}:paid`)) : null;

      levels.push({
        level,
        // O XP ACUMULADO que alcança este nível, e não o custo do
        // degrau: o plugin só informa, quem soma é o agente.
        xp: xpToReach(season.xpCurve, level),
        // Faixa AUSENTE (e não um objeto vazio) é como se diz "este
        // nível não dá nada aqui".
        ...(free === null ? {} : { free }),
        ...(paid === null ? {} : { paid }),
      });
    }

    const offer = this.#deps.store?.passOffer(serverId, season.period) ?? null;

    return {
      secret: this.#secret,
      period: season.period,
      name: season.label,
      // Sem isto a primeira queixa é "meu nível sumiu": o XP é POR
      // SERVIDOR, e a tela precisa dizer de qual ela está falando.
      serverName: this.#deps.serverNameOf(serverId),
      endsAt: endOfPeriod(season.period),
      freeLane: season.freeLane,
      paidLane: season.paidLane,
      // Faixa paga desligada tira o produto da loja (01 §8): oferecer
      // o passe de uma trilha que não existe é vender o nada.
      purchasable: season.paidLane && offer !== null,
      priceLabel: offer === null ? '' : `${offer.price.toLocaleString('pt-BR')} OZCOIN`,
      note: season.description ?? '',
      levels,
    };
  }

  /**
   * O progresso de UM jogador, como ele desce para AQUELE servidor.
   *
   * `null` = sem temporada ativa ali. Ver `buildPayload`.
   */
  buildProgressPayload(serverId: string, steamId: string): BattlePassProgressPayload | null {
    const track = this.#deps.service.trackOf(serverId, steamId);

    if (track.season === null) return null;

    return {
      secret: this.#secret,
      period: track.season.period,
      level: track.progress.level,
      xp: track.progress.xp,
      xpInto: track.progress.intoLevel,
      // `0` = trilha concluída. Não há próximo nível para comprar, e
      // o plugin desenha "concluída" em vez de uma barra cheia que
      // nunca anda.
      xpNeeded: track.progress.neededForNext ?? 0,
      hasPass: track.paid,
      // O ponto de notificação é o `unseen`: ele marca "ainda não
      // olhou", e não "ainda não recebeu".
      boxSeen: !track.unseen,
      // ####  SÓ A EXCEÇÃO VIAJA  ####
      //
      // O resto o plugin DERIVA pela tabela do 01 §4.1. A regra mora
      // em `claimExceptionsOf`, e não aqui: ela é metade de um
      // contrato cuja outra metade é a derivação do plugin.
      claims: claimExceptionsOf(track.cells),
      pending: track.pending.map((item) => this.#pendingLineOf(item)),
    };
  }

  /**
   * O catálogo como ele viaja: os comandos, em ordem.
   *
   * Pública pelo mesmo motivo do `buildPayload`: o teste corta uma
   * carga grande e confere que as partes remontam o original.
   */
  buildSyncCommands(payload: BattlePassPayload): readonly string[] {
    return chunkCommands(BATTLEPASS_SYNC, payload);
  }

  /** O progresso como ele viaja. `<steamId>` vem ANTES do lote. */
  buildProgressCommands(
    steamId: string,
    payload: BattlePassProgressPayload,
  ): readonly string[] {
    return chunkCommands(`${BATTLEPASS_PROGRESS} ${steamId}`, payload);
  }

  /**
   * Uma faixa, como o plugin a lê.
   *
   * ####  UMA CÉLULA TEM LISTA; O CONTRATO TEM UMA  ####
   *
   * A trilha guarda `rewards: QuestReward[]` — o admin pode pôr a AK
   * E os 500 OZCoin no mesmo nível (02 §5). O plugin desenha UM card
   * por faixa. As duas coisas se encontram assim: o `label` traz a
   * linha INTEIRA ("1x AK-47 + 500 OZCoin", montada pelo mesmo
   * `rewardLine` da tela de missões), e o ícone é o da PRIMEIRA
   * recompensa que tem o que desenhar.
   *
   * ####  O QUE NÃO DESCE, E POR QUÊ  ####
   *
   * `icon` — é o CRC de um PNG do FileStorage, e o agente NUNCA o
   *   conhece: quem guarda os bytes é o plugin de imagens e o número
   *   nasce lá (game/ui-images.ts). Sem ele, o OrigemZBattlePass
   *   desenha a marca do tipo (`OZ`, `KIT`, `VIP`) — que é a
   *   informação, e não um quadrado vazio.
   * `dlc` — depende de uma marca no cadastro do Workshop que ainda
   *   não existe (03 §9). Mandar `true` por adivinhação faria a tela
   *   recusar recompensa que o jogador PODE levar; o plugin já lê
   *   ausente como `false`.
   * `amount` — o plugin não a lê (medido no `ReadReward` dele): o
   *   número que o jogador vê está dentro do `label`. Numa trilha de
   *   200 níveis × 2 faixas ela seria banda paga para repetir o que
   *   já viajou.
   */
  #rewardOf(cell: TrackCell | undefined): BattlePassPayloadReward | null {
    if (cell === undefined || cell.rewards.length === 0) return null;

    const first = cell.rewards[0];

    if (first === undefined) return null;

    // O item que o cliente sabe desenhar. `skin` desenha o item BASE
    // com o número da skin em cima — é a mesma prévia do menu de
    // skins.
    const drawable = cell.rewards.find(
      (reward) => reward.kind === 'item' || reward.kind === 'skin',
    );

    return {
      kind: first.kind,
      label: rewardLine(cell.rewards, this.#deps.catalog ?? {}),
      ...(drawable === undefined
        ? {}
        : {
            shortname: drawable.shortname,
            // Texto, sempre: um `UInt64` não cabe no `number` do JS.
            skinId: String(drawable.skinId ?? '0'),
          }),
      // Marca de TELA, e não de regra: um marco se resgata como
      // qualquer outro nível.
      ...(cell.milestone ? { milestone: true } : {}),
    };
  }

  /** Uma linha da caixa, com a origem que o plugin sabe distinguir. */
  #pendingLineOf(item: PendingDelivery): BattlePassPayloadPending {
    return {
      label: rewardLine([item.reward], this.#deps.catalog ?? {}),
      // `inventory` -> `full`, `rollover` -> `season`. A tradução
      // mora em `payloadOriginOf`, e em lugar nenhum além dela.
      origin: payloadOriginOf(item.origin),
    };
  }

  // ------------------------------------------------------------
  //  §2  EMPURRAR O CATÁLOGO
  // ------------------------------------------------------------

  /** Monta, corta, manda e confere. NUNCA lança. */
  async sync(
    serverId: string,
    trigger: BattlePassSyncTrigger = 'manual',
  ): Promise<BattlePassSyncOutcome> {
    if (this.#stopped) return { status: 'skipped', reason: 'o agente está parando' };

    const rcon = this.#rconOf(serverId);

    // NÃO é erro: metade da lista costuma estar parada, e a
    // reconexão repassa a carga inteira.
    if (rcon === null) return { status: 'skipped', reason: 'sem RCON' };

    const payload = this.buildPayload(serverId);

    if (payload === null) {
      // Sem temporada, o plugin fica com o que ele tem em disco e a
      // tela diz o que sabe. Mandar um catálogo vazio APAGARIA a
      // trilha do servidor que está entre duas temporadas.
      return { status: 'skipped', reason: 'sem temporada ativa' };
    }

    // O segredo é o mesmo a vida toda; o que muda é o resto.
    const fingerprint = JSON.stringify(payload);

    if (!isForced(trigger) && this.#lastSent.get(serverId) === fingerprint) {
      return { status: 'unchanged' };
    }

    const commands = this.buildSyncCommands(payload);
    const outcome = await this.#sendAll(rcon, commands, BATTLEPASS_SYNC);

    if (outcome.status === 'failed') {
      // O que não entrou não pode ficar marcado como entrado.
      this.#lastSent.delete(serverId);

      // Sem esta linha, um servidor cujo plugin não conhece o
      // comando recusaria a carga em silêncio — e o sintoma seria "o
      // passe está vazio neste servidor", sem nada no log.
      this.#deps.logger?.warn(
        { server: serverId, trigger, err: outcome.error, parts: commands.length },
        'a carga do Passe de Batalha NÃO chegou a este servidor',
      );

      return outcome;
    }

    this.#lastSent.set(serverId, fingerprint);

    this.#deps.logger?.debug(
      {
        server: serverId,
        trigger,
        period: payload.period,
        levels: payload.levels.length,
        parts: outcome.parts,
        bytes: outcome.bytes,
      },
      'catálogo do Passe de Batalha enviado ao plugin',
    );

    return outcome;
  }

  /** O mesmo, em todos os servidores, com o progresso de quem está lá. NUNCA lança. */
  async syncAll(trigger: BattlePassSyncTrigger): Promise<void> {
    for (const serverId of this.#deps.servers.ids()) {
      await this.#syncWithProgress(serverId, trigger);
    }
  }

  /**
   * O catálogo e, DEPOIS dele, o progresso de todos os online.
   *
   * Nesta ordem porque é ela que o plugin exige: progresso que chega
   * antes do catálogo é recusado com `NO_SEASON`.
   */
  async #syncWithProgress(serverId: string, trigger: BattlePassSyncTrigger): Promise<void> {
    const outcome = await this.sync(serverId, trigger);

    if (outcome.status === 'skipped' || outcome.status === 'failed') return;

    await this.syncProgressAll(serverId, 'season', isForced(trigger));
  }

  /**
   * Empurra daqui a pouco, juntando as edições em rajada.
   *
   * É por aqui que passa TUDO que nasce de dentro do gancho de
   * console. Ver o cabeçalho.
   */
  syncSoon(serverId: string, trigger: BattlePassSyncTrigger): void {
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

      void this.#syncWithProgress(serverId, reason).catch((error: unknown) => {
        this.#deps.logger?.error(
          { server: serverId, err: toError(error) },
          'o envio da carga do Passe de Batalha lançou',
        );
      });
    }, SYNC_DELAY_MS);

    timer.unref();
    this.#timers.set(serverId, timer);
  }

  syncAllSoon(trigger: BattlePassSyncTrigger): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.syncSoon(serverId, trigger);
    }
  }

  /**
   * O servidor pode ter reiniciado: o plugin só tem a cópia do
   * disco, e ela não tem o segredo desta subida do agente.
   */
  handleRconConnected(serverId: string): void {
    this.syncSoon(serverId, 'rcon-connected');
  }

  /**
   * A temporada ou a trilha mudou no painel.
   *
   * É o `onChange` do `BattlePassService`: ele não sabe em que
   * servidores aquela temporada vale, e a carga de quem não mudou é
   * barrada pela digital.
   */
  handleSeasonChanged(): void {
    this.syncAllSoon('season-changed');
  }

  // ------------------------------------------------------------
  //  §3  EMPURRAR O PROGRESSO
  // ------------------------------------------------------------

  /** O progresso de um jogador, num servidor. NUNCA lança. */
  async syncProgress(
    serverId: string,
    steamId: string,
    trigger: BattlePassProgressTrigger = 'manual',
    forced = false,
  ): Promise<BattlePassSyncOutcome> {
    if (this.#stopped) return { status: 'skipped', reason: 'o agente está parando' };

    const rcon = this.#rconOf(serverId);

    if (rcon === null) return { status: 'skipped', reason: 'sem RCON' };

    const payload = this.buildProgressPayload(serverId, steamId);

    if (payload === null) return { status: 'skipped', reason: 'sem temporada ativa' };

    const key = `${serverId} ${steamId}`;
    const fingerprint = JSON.stringify(payload);

    if (!forced && this.#lastProgress.get(key) === fingerprint) {
      return { status: 'unchanged' };
    }

    const commands = this.buildProgressCommands(steamId, payload);
    const outcome = await this.#sendAll(rcon, commands, BATTLEPASS_PROGRESS);

    if (outcome.status === 'failed') {
      this.#lastProgress.delete(key);
      this.#deps.logger?.warn(
        { server: serverId, steamId, trigger, err: outcome.error, parts: commands.length },
        'o progresso do passe NÃO chegou a este servidor',
      );

      return outcome;
    }

    this.#lastProgress.set(key, fingerprint);
    this.#deps.logger?.debug(
      { server: serverId, steamId, trigger, level: payload.level, parts: outcome.parts },
      'progresso do passe enviado ao plugin',
    );

    return outcome;
  }

  /**
   * O progresso de todos os online daquele servidor. NUNCA lança.
   *
   * Aproveita para esquecer a digital de quem não está mais lá: ela
   * serve para não repetir envio, e quem saiu recebe carga forçada
   * quando voltar.
   */
  async syncProgressAll(
    serverId: string,
    trigger: BattlePassProgressTrigger,
    forced: boolean,
  ): Promise<void> {
    const online = new Set(this.#deps.servers.onlineOf(serverId));

    for (const key of [...this.#lastProgress.keys()]) {
      const [server, steamId] = key.split(' ');

      if (server === serverId && steamId !== undefined && !online.has(steamId)) {
        this.#lastProgress.delete(key);
      }
    }

    for (const steamId of online) {
      const outcome = await this.syncProgress(serverId, steamId, trigger, forced);

      // Sem RCON (ou sem temporada), o resto da lista também não vai.
      if (outcome.status === 'skipped') return;
    }
  }

  /** Arma o envio do progresso daqui a pouco, juntando pedidos. */
  syncProgressSoon(
    serverId: string,
    players: readonly string[] | 'all',
    trigger: BattlePassProgressTrigger,
    forced: boolean,
  ): void {
    if (this.#stopped) return;

    let pending = this.#progressPending.get(serverId);

    if (pending === undefined) {
      pending = { all: false, forced: false, players: new Set(), trigger };
      this.#progressPending.set(serverId, pending);
    }

    if (players === 'all') pending.all = true;
    else for (const steamId of players) pending.players.add(steamId);

    pending.forced ||= forced;
    pending.trigger = trigger;

    if (this.#progressTimers.has(serverId)) return;

    const timer = setTimeout(() => {
      this.#progressTimers.delete(serverId);

      const job = this.#progressPending.get(serverId);

      this.#progressPending.delete(serverId);

      if (job === undefined) return;

      void this.#runProgress(serverId, job).catch((error: unknown) => {
        this.#deps.logger?.error(
          { server: serverId, err: toError(error) },
          'o envio do progresso do passe lançou',
        );
      });
    }, SYNC_DELAY_MS);

    timer.unref();
    this.#progressTimers.set(serverId, timer);
  }

  async #runProgress(serverId: string, job: ProgressPending): Promise<void> {
    if (job.all) {
      await this.syncProgressAll(serverId, job.trigger, job.forced);
      return;
    }

    for (const steamId of job.players) {
      const outcome = await this.syncProgress(serverId, steamId, job.trigger, job.forced);

      if (outcome.status === 'skipped') return;
    }
  }

  /**
   * Alguém entrou (`PresenceWatcher.onJoined`).
   *
   * Forçado: o plugin NÃO guarda progresso em disco (é ele que diz
   * isso no cabeçalho), então quem entra não é conhecido lá — e a
   * digital daqui pode ser de uma sessão anterior.
   */
  handlePlayersJoined(serverId: string, steamIds: readonly string[]): void {
    if (steamIds.length === 0) return;

    this.syncProgressSoon(serverId, steamIds, 'player-joined', true);
  }

  /**
   * O que é DAQUELE jogador mudou: XP, resgate, direito comprado.
   *
   * É o `onPlayerChange` do serviço, e o destino do `playersChanged`
   * que a rodada de XP chama depois do commit. Offline, nada sai:
   * ele recebe ao entrar.
   */
  handlePlayerChanged(serverId: string, steamId: string): void {
    if (!this.#deps.servers.onlineOf(serverId).includes(steamId)) return;

    this.syncProgressSoon(serverId, [steamId], 'progress-changed', false);
  }

  // ------------------------------------------------------------
  //  §4  ESCUTAR
  // ------------------------------------------------------------

  /**
   * Uma linha do console daquele servidor. NUNCA lança.
   *
   * Recusa em UMA comparação de string no caso comum: isto roda para
   * toda linha de todos os servidores.
   *
   * E só ARMA trabalho — nenhum comando de RCON sai daqui. Ver a
   * regra 4 do cabeçalho.
   */
  handleLine(serverId: string, line: string): void {
    if (this.#stopped) return;
    if (!line.includes(BATTLEPASS_MARKER)) return;

    try {
      this.#handle(serverId, line);
    } catch (cause) {
      this.#deps.logger?.warn(
        { server: serverId, error: toError(cause).message },
        'linha do OrigemZBattlePass não pôde ser tratada',
      );
    }
  }

  #handle(serverId: string, line: string): void {
    // A âncora: sem ela, um jogador digita o marcador no chat e
    // resgata a trilha inteira.
    if (!PLUGIN_LINE.test(line.trimStart())) return;

    const body = line.slice(line.indexOf(BATTLEPASS_MARKER) + BATTLEPASS_MARKER.length).trim();

    if (body === '') return;

    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== 'object' || parsed === null) return;

    const push = parsed as { kind?: unknown; secret?: unknown };

    if (push.kind === 'ready') {
      // O ÚNICO sem segredo: é justamente ele que PEDE a carga, e o
      // segredo só existe depois que o catálogo chega. O estrago de
      // um forjado é um reenvio, que o agente faria na próxima
      // reconexão de qualquer jeito.
      this.#deps.logger?.info(
        { server: serverId },
        'o OrigemZBattlePass subiu e pediu a carga',
      );
      this.syncSoon(serverId, 'plugin-requested');

      return;
    }

    if (push.secret !== this.#secret) {
      this.#deps.logger?.warn(
        { server: serverId, kind: push.kind },
        'aviso do passe com segredo errado: descartado',
      );

      return;
    }

    if (push.kind === 'open') {
      const request = battlePassOpenPushSchema.safeParse(parsed);

      if (!request.success) {
        this.#badPush(serverId, 'open', request.error.issues.slice(0, 3));
        return;
      }

      // FORÇADO: o XP chega ao agente em lotes de 60 s, então o
      // plugin pode ter meio minuto de idade — mas o que ele quer é
      // a verdade de agora, e a digital diria "não mudou nada".
      //
      // Não tem `requestId` e não espera resposta: `open` é aviso, e
      // a linha repetida só reenvia a mesma carga.
      this.syncProgressSoon(serverId, [request.data.steamId], 'menu-opened', true);

      return;
    }

    if (push.kind === 'claim') {
      const request = battlePassClaimPushSchema.safeParse(parsed);

      if (!request.success) {
        this.#badPush(serverId, 'claim', request.error.issues.slice(0, 3));
        return;
      }

      const data = request.data;

      this.#once(`claim:${data.requestId}`, () => this.#handleClaim(serverId, data));

      return;
    }

    if (push.kind === 'claimAll' || push.kind === 'box' || push.kind === 'buy') {
      const request = battlePassPlayerPushSchema.safeParse(parsed);

      if (!request.success) {
        this.#badPush(serverId, String(push.kind), request.error.issues.slice(0, 3));
        return;
      }

      const data = request.data;

      this.#once(`${data.kind}:${data.requestId}`, () => {
        if (data.kind === 'claimAll') return this.#handleClaimAll(serverId, data);
        if (data.kind === 'box') return this.#handleBox(serverId, data);

        return this.#handleBuy(serverId, data);
      });

      return;
    }

    this.#deps.logger?.debug(
      { server: serverId, kind: push.kind },
      'aviso do passe de um tipo que este agente não conhece',
    );
  }

  #badPush(serverId: string, kind: string, issues: unknown): void {
    this.#deps.logger?.warn(
      { server: serverId, kind, issues },
      'pedido do passe fora do contrato: descartado',
    );
  }

  /**
   * Roda UMA vez, e fora do gancho de console.
   *
   * As duas coisas no mesmo lugar porque são a mesma armadilha em
   * dois tempos: o console REPETE linha em reconexão (e o mesmo
   * pedido não pode virar duas escritas), e um comando de RCON
   * mandado de dentro do gancho volta por ele. `setTimeout(0)` é o
   * relógio mais curto que ainda sai da pilha do gancho.
   */
  #once(key: string, job: () => Promise<void>): void {
    if (this.#seenRequests.has(key)) return;

    this.#seenRequests.add(key);

    if (this.#seenRequests.size > SEEN_REQUESTS_MAX) {
      this.#seenRequests.delete(this.#seenRequests.values().next().value as string);
    }

    const timer = setTimeout(() => {
      void job().catch((error: unknown) => {
        this.#deps.logger?.error(
          { key, err: toError(error) },
          'um pedido do passe falhou por um erro que não é de regra',
        );
      });
    }, 0);

    timer.unref();
  }

  // ------------------------------------------------------------
  //  §5  RESPONDER
  // ------------------------------------------------------------

  /** O clique num nível. NUNCA lança. */
  async #handleClaim(
    serverId: string,
    push: BattlePassClaimPush,
  ): Promise<void> {
    try {
      const result = this.#deps.service.claim(
        { serverId, steamId: push.steamId, level: push.level, lane: push.lane },
        actorOf(serverId, push.steamId),
        this.#now(),
      );
      const settled = await this.#deliver(serverId, push.steamId, [result]);

      await this.#answer(serverId, push.steamId, push.requestId, true, settled);
    } catch (cause) {
      await this.#answer(serverId, push.steamId, push.requestId, false, this.#refusal(cause));
    }
  }

  /** "Resgatar tudo". NUNCA lança. */
  async #handleClaimAll(
    serverId: string,
    push: BattlePassPlayerPush,
  ): Promise<void> {
    try {
      // O lote NÃO é atômico: cada casa vira um resgate próprio, e
      // uma que falhe não derruba as outras. Quem sabe disso é o
      // serviço.
      const results = this.#deps.service.claimAll(
        serverId,
        push.steamId,
        actorOf(serverId, push.steamId),
        this.#now(),
      );

      if (results.length === 0) {
        await this.#answer(
          serverId,
          push.steamId,
          push.requestId,
          false,
          'Não há nada para resgatar agora.',
        );

        return;
      }

      const settled = await this.#deliver(serverId, push.steamId, results);

      await this.#answer(serverId, push.steamId, push.requestId, true, settled);
    } catch (cause) {
      await this.#answer(serverId, push.steamId, push.requestId, false, this.#refusal(cause));
    }
  }

  /**
   * Ele abriu a caixa: o ponto de notificação some. NUNCA lança.
   *
   * O ponto marca "ainda não olhou", e não "ainda não recebeu" — ter
   * pendência e saber que tem são coisas diferentes (01 §7.1).
   */
  async #handleBox(
    serverId: string,
    push: BattlePassPlayerPush,
  ): Promise<void> {
    try {
      const pending = this.#deps.service.openBox(serverId, push.steamId, this.#now());
      const message =
        pending.length === 0
          ? 'A sua caixa está vazia.'
          : `Você tem ${String(pending.length)} ${pending.length === 1 ? 'item esperando' : 'itens esperando'} na caixa.`;

      await this.#answer(serverId, push.steamId, push.requestId, true, message);
    } catch (cause) {
      await this.#answer(serverId, push.steamId, push.requestId, false, this.#refusal(cause));
    }
  }

  /**
   * "Ativar o passe": o caminho da LOJA, e não um segundo. NUNCA lança.
   *
   * Quem confere o mês, recusa quem já tem, debita e concede é o
   * `StoreService` — o mesmo que serve o botão do menu da loja. Um
   * segundo caminho aqui seria um passe que ninguém sabe expirar.
   */
  async #handleBuy(
    serverId: string,
    push: BattlePassPlayerPush,
  ): Promise<void> {
    const store = this.#deps.store;
    const season = this.#deps.service.activeSeason(serverId);

    if (store === undefined || season === null) {
      await this.#answer(
        serverId,
        push.steamId,
        push.requestId,
        false,
        'O passe não está à venda neste servidor agora.',
      );

      return;
    }

    const offer = store.passOffer(serverId, season.period);

    if (offer === null) {
      await this.#answer(
        serverId,
        push.steamId,
        push.requestId,
        false,
        'O passe não está à venda neste servidor agora.',
      );

      return;
    }

    const outcome = await store.buy({
      serverId,
      steamId: push.steamId,
      offerId: offer.id,
    });

    await this.#answer(serverId, push.steamId, push.requestId, outcome.ok, outcome.message);
  }

  /**
   * A frase da recusa.
   *
   * O `ApiError` já traz a frase pronta, em português, escrita por
   * quem conhece a regra ("Você já resgatou o nível 13."). O que não
   * é regra vira uma frase genérica AQUI e um `error` no log: o
   * jogador não tem o que fazer com um stack trace.
   */
  #refusal(cause: unknown): string {
    if (cause instanceof ApiError) return cause.message;

    this.#deps.logger?.error(
      { err: toError(cause) },
      'um pedido do passe falhou por um erro que não é de regra',
    );

    return 'Não deu para fazer isso agora. Um administrador foi avisado.';
  }

  /**
   * Entrega o que o resgate prometeu, e devolve a frase do rodapé.
   *
   * A marca de `claimed` vem DEPOIS da entrega, nunca antes (01 §6):
   * quem fecha o resgate é o `settle`, com o desfecho posição a
   * posição. O que falhou vira linha da caixa, com o código cru.
   */
  async #deliver(
    serverId: string,
    steamId: string,
    results: readonly ClaimResult[],
  ): Promise<string> {
    const delivery = this.#deps.deliver;

    if (delivery === undefined) {
      // Sem entregador ligado, tudo fica devendo — e a frase diz
      // isso. Ver `BattlePassDelivery`.
      return results.length === 1
        ? 'Resgatado! O prêmio está na sua caixa.'
        : `${String(results.length)} níveis resgatados! Os prêmios estão na sua caixa.`;
    }

    let owed = 0;

    for (const result of results) {
      const outcomes = await delivery.deliver({
        serverId,
        steamId,
        claimId: result.claim.id,
        level: result.claim.level,
        lane: result.claim.lane,
        rewards: result.rewards,
      });

      const settled = this.#deps.service.settle(
        result.claim.id,
        outcomes,
        'inventory',
        this.#now(),
      );

      owed += settled.pending.length;
    }

    if (owed === 0) {
      return results.length === 1
        ? 'Resgatado! Confira a mochila.'
        : `${String(results.length)} níveis resgatados! Confira a mochila.`;
    }

    return owed === 1
      ? 'Resgatado, mas 1 item não coube: ele ficou na sua caixa.'
      : `Resgatado, mas ${String(owed)} itens não couberam: eles ficaram na sua caixa.`;
  }

  /**
   * A resposta do pedido e, DEPOIS dela, o progresso.
   *
   * O `progress` NÃO é opcional e vai FORÇADO. Ver o cabeçalho: é a
   * carga que apaga o otimismo do clique, e uma recusa não muda nada
   * no banco — a digital diria "não mudou nada" e a tela ficaria
   * dizendo "esperando" para sempre.
   */
  async #answer(
    serverId: string,
    steamId: string,
    requestId: string,
    ok: boolean,
    message: string,
  ): Promise<void> {
    await this.#reply(serverId, { requestId, ok, message });
    await this.syncProgress(serverId, steamId, 'after-reply', true);
  }

  async #reply(serverId: string, reply: BattlePassReply): Promise<void> {
    const rcon = this.#rconOf(serverId);

    if (rcon === null) {
      this.#deps.logger?.warn(
        { server: serverId, requestId: reply.requestId },
        'a resposta do passe não saiu: o RCON caiu entre o pedido e ela',
      );

      return;
    }

    try {
      checkPushReply(
        await rcon.send(`${BATTLEPASS_REPLY} ${encodePushPayload(reply)}`),
        BATTLEPASS_REPLY,
      );
    } catch (cause) {
      // O pedido JÁ aconteceu: o resgate está no banco. O que se
      // perde é a frase, e o `progress` que vem logo atrás conserta a
      // tela.
      this.#deps.logger?.warn(
        { server: serverId, requestId: reply.requestId, err: toError(cause) },
        'a resposta do passe não chegou ao jogo',
      );
    }
  }

  // ------------------------------------------------------------
  //  §6  PERGUNTAR E MANDAR ABRIR
  // ------------------------------------------------------------

  /** O que o plugin diz ter de pé. Lança `BattlePassCommandError`. */
  async status(serverId: string): Promise<BattlePassStatus> {
    const reply = await this.#command(serverId, BATTLEPASS_STATUS);
    const text = (key: string): string => (typeof reply[key] === 'string' ? reply[key] : '');
    const count = (key: string): number => (typeof reply[key] === 'number' ? reply[key] : 0);

    return {
      period: text('period'),
      name: text('name'),
      levels: count('levels'),
      players: count('players'),
      menus: count('menus'),
      secret: reply['secret'] === true,
      endsAt: count('endsAt'),
    };
  }

  /** Abre a tela do passe para alguém. Lança `BattlePassCommandError`. */
  async openMenu(serverId: string, steamId: string): Promise<void> {
    await this.#command(serverId, `${BATTLEPASS_OPEN} ${steamId}`);
  }

  async #command(serverId: string, command: string): Promise<Record<string, unknown>> {
    const rcon = this.#rconOf(serverId);

    if (rcon === null) {
      throw new BattlePassCommandError('offline', 'O servidor não está com o RCON de pé.');
    }

    const reply = cleanReply(await rcon.send(command));

    if (reply === '') {
      throw new BattlePassCommandError(
        'no_plugin',
        'O servidor não respondeu: o OrigemZBattlePass pode não estar carregado.',
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(reply);
    } catch {
      throw new BattlePassCommandError(
        'bad_reply',
        `O plugin respondeu algo que não é JSON: ${reply.slice(0, 200)}`,
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new BattlePassCommandError('bad_reply', 'O plugin respondeu um JSON que não é objeto.');
    }

    const payload = parsed as Record<string, unknown>;

    if (payload['ok'] !== true) {
      const reason = typeof payload['error'] === 'string' ? payload['error'] : 'unknown';
      const message =
        typeof payload['message'] === 'string' ? payload['message'] : 'O plugin recusou.';

      throw new BattlePassCommandError(reason, message);
    }

    return payload;
  }

  /** Manda os pedaços em ordem, conferindo cada resposta. NUNCA lança. */
  async #sendAll(
    rcon: OpsRcon,
    commands: readonly string[],
    name: string,
  ): Promise<Extract<BattlePassSyncOutcome, { status: 'sent' | 'failed' }>> {
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

/** O ator do registro: o pedido nasceu no JOGO, e não no painel. */
function actorOf(serverId: string, steamId: string) {
  return { name: `jogo:${steamId}`, source: 'game' as const, serverId };
}

/**
 * Corta a carga em pedaços: `<prefixo> <lote> <i> <n> <pedaço>`.
 *
 * `lote` são 12 caracteres hexadecimais, novos a cada carga; `i` vai
 * de 0 a n-1. SEMPRE neste formato, mesmo com um pedaço só — o
 * plugin tem a forma de um argumento só, mas ela existe para o teste
 * manual no console, e duas formas no caminho normal seriam duas
 * coisas para manter em dia.
 */
function chunkCommands(prefix: string, payload: unknown): readonly string[] {
  const encoded = encodePushPayload(payload);
  const parts = Math.max(1, Math.ceil(encoded.length / BATTLEPASS_CHUNK_CHARS));
  const batch = randomUUID().replace(/-/g, '').slice(0, 12);
  const commands: string[] = [];

  for (let index = 0; index < parts; index += 1) {
    const piece = encoded.slice(index * BATTLEPASS_CHUNK_CHARS, (index + 1) * BATTLEPASS_CHUNK_CHARS);

    commands.push(`${prefix} ${batch} ${String(index)} ${String(parts)} ${piece}`);
  }

  return commands;
}

/**
 * Quando a temporada fecha, em epoch ms.
 *
 * ####  A CONTA É EM UTC, E A TELA ARREDONDA PARA CIMA  ####
 *
 * O último instante do mês depende do fuso, e o do agente é o do
 * SERVIDOR (rankings/periods.ts). Aqui a conta é UTC de propósito:
 * o plugin desenha "TERMINA EM N DIAS" com `Math.ceil`, então um
 * desvio de horas só apareceria na última — e trazer o fuso para
 * dentro desta função criaria um segundo relógio de virada, que é
 * exatamente o que o projeto evita em todo lugar.
 */
export function endOfPeriod(period: string): number {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    // `0` = não sei, e o plugin não desenha prazo nenhum. Melhor que
    // uma data de 1970 dizendo que a temporada acabou.
    return 0;
  }

  return Date.UTC(year, month, 1) - 1;
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
        'O OrigemZBattlePass está carregado?',
    );
  }

  const refused = pushErrorSchema.safeParse(line);

  if (refused.success) {
    throw new Error(`o plugin recusou o ${name}: ${refused.data.error}`);
  }

  if (!pushOkSchema.safeParse(line).success) {
    throw new Error(
      `a resposta do ${name} não bate com o contrato: ${JSON.stringify(line).slice(0, 200)}`,
    );
  }
}

/**
 * A resposta do comando, sem o que o plugin falou por cima.
 *
 * Um `Puts` disparado no frame do comando entra na resposta casada do
 * RCON e quebra o JSON. O plugin já tira o aviso do frame
 * (`timer.Once(0.1f)`); isto é a segunda tranca.
 */
export function cleanReply(reply: string): string {
  return reply
    .split(SPLIT_LINES)
    .filter((line) => !line.includes(BATTLEPASS_MARKER))
    .join('\n')
    .trim();
}
