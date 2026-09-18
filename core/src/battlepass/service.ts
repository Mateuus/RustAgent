// ============================================================
//  battlepass/service.ts  -  a PORTA ÚNICA do passe de batalha.
//
//  ####  O PAINEL, O JOGO E O SITE ENTRAM POR AQUI  ####
//
//  Três clientes, uma regra. O painel monta a temporada, o plugin
//  resgata pelo console e o site vende o mês — e os três chamam os
//  MESMOS métodos abaixo. Não é gosto de arquitetura: o 01 existe
//  porque a resposta a "posso resgatar isto?" precisa ser uma
//  função, escrita uma vez. Duas implementações divergiriam no
//  primeiro tipo de recompensa novo, e a que ficasse para trás
//  ofereceria menos sem avisar ninguém.
//
//  ####  TODA ESCRITA REGISTRA E AVISA  ####
//
//  Cada método que muda alguma coisa grava uma linha em
//  `battlepass_audit` e chama `onChange` (o catálogo mudou: reenviar
//  a carga) ou `onPlayerChange` (o que é DAQUELE jogador mudou).
//  Esquecer o aviso é a trilha que muda na tela do admin e continua
//  a antiga dentro do jogo.
//
//  ####  AS RECUSAS SAEM COM A FRASE PRONTA  ####
//
//  `ApiError` com texto em português. A rota repassa, e o plugin
//  mostra a MESMA frase no chat — porque é a mesma frase, e não uma
//  segunda escrita para a tela do jogo.
//
//  ####  O QUE ESTE ARQUIVO NÃO FAZ  ####
//
//  Ele não ENTREGA nada. `claim` congela a recompensa e devolve a
//  lista; quem põe o item na mochila (e pergunta antes se cabe, com
//  o `inventory-room.ts`) é a frente B, que reporta o desfecho de
//  volta por `settle`. Foi assim que o resgate ficou possível de
//  testar sem servidor de pé.
//
//  Ele também não decide QUANDO o mês vira. A virada (fechar a
//  anterior, ativar a `scheduled`, entregar o que não foi resgatado)
//  é relógio, e relógio é da frente B — este arquivo dá as peças:
//  `setSeasonState`, `claimFor` e `settle`.
// ============================================================

import {
  BATTLEPASS_LANES,
  dayKeyOf,
  levelAt,
  periodOf,
  trackProgress,
  type BattlePassAuditEntry,
  type BattlePassAuditSource,
  type BattlePassCellState,
  type BattlePassClaim,
  type BattlePassLane,
  type BattlePassPendingOrigin,
  type BattlePassSeason,
  type BattlePassSeasonState,
  type ClaimRequest,
  type DeliveryOutcome,
  type Entitlement,
  type GrantEntitlementInput,
  type PendingDelivery,
  type PlayerTrack,
  type SeasonInput,
  type TrackCell,
  type TrackCellInput,
  type TrackCellView,
  type XpRule,
  type XpRuleInput,
} from '../types/battlepass.js';
import type { QuestReward } from '../types/quests.js';
import type { AuditFilter, BattlePassRepository, ProgressPage } from '../db/battlepass-repository.js';
import { ApiError } from '../http/error-response.js';
import { localDayOf } from '../rankings/periods.js';
import type { PassGranter } from '../store/service.js';
import { xpDayKey } from './xp-day.js';
import { isBatchXpSource, whyNotXpSource, XP_SOURCES, type XpSource } from './xp-sources.js';

/** Quem está mexendo. Vai para o registro. */
export interface BattlePassActor {
  /** Usuário do painel, `jogo:<steamId>`, `site:<ref>` ou `sistema`. */
  readonly name: string;
  readonly source: BattlePassAuditSource;
  /** O servidor de onde veio, quando veio do jogo. */
  readonly serverId?: string | null;
}

export interface BattlePassServiceDeps {
  readonly repository: BattlePassRepository;
  /** Os servidores que existem. É contra esta lista que a junção é conferida. */
  readonly serverIds: () => readonly string[];
  /**
   * A zona do agente (IANA). Ausente = a do processo.
   *
   * O fuso é o do SERVIDOR, e não o do jogador (01 §1): dois
   * relógios dariam dois "dia 1" diferentes na mesma tela.
   */
  readonly timeZone?: string | undefined;
  /**
   * Em que minuto do dia a diária daquele servidor vira.
   *
   * ####  É A RÉGUA DAS MISSÕES, E NÃO UMA SEGUNDA  ####
   *
   * O teto do XP é "por dia", e o projeto já decidiu o que é um dia:
   * `quest_settings.reset_at_minute`, contando dias de CALENDÁRIO
   * (01 §3.1). Em produção quem satisfaz isto é o
   * `QuestsRepository.settingsOf`.
   *
   * Ausente = meia-noite do fuso do agente. Dois relógios de virada
   * no mesmo repositório discordariam duas vezes por ano.
   */
  readonly resetAtMinuteOf?: (serverId: string) => number;
  /** A temporada ou a trilha mudou: reenviar a carga aos servidores. */
  readonly onChange: () => void;
  /** O que é DAQUELE jogador mudou: reenviar a dele, onde ele estiver. */
  readonly onPlayerChange?: (serverId: string, steamId: string) => void;
}

/** O resgate, com o que ele prometeu — para quem vai entregar. */
export interface ClaimResult {
  readonly claim: BattlePassClaim;
  /** A lista congelada, na ordem. O índice é a POSIÇÃO do retry. */
  readonly rewards: readonly QuestReward[];
}

/** O crédito de XP pedido pela frente B. */
export interface CreditXpRequest {
  readonly serverId: string;
  readonly steamId: string;
  /** A chave da métrica: `pvp.kills`, `ore.sulfur`, `quest.completed`. */
  readonly source: string;
  /** Quantas ocorrências chegaram no delta. O valor por ocorrência é da regra. */
  readonly units: number;
  /**
   * O dia local da régua das missões (`reset_at_minute`).
   *
   * Ausente, o serviço usa o dia do calendário do agente. A frente
   * B manda o dela — o passe REUSA a régua que o projeto já tem, e
   * não inventa a segunda (02 §3).
   */
  readonly localDay?: string;
}

export interface CreditXpResult {
  readonly granted: number;
  readonly capped: number;
  readonly level: number;
  readonly levelBefore: number;
  /** Por que não entrou nada, quando não entrou. */
  readonly reason: 'ok' | 'no_season' | 'no_rule' | 'disabled' | 'capped';
}

/** Um jogador do lote, com o delta de 60 s dele. */
export interface BatchXpPlayer {
  readonly steamId: string;
  /** `{ 'ore.sulfur': 1200, 'pvp.kills': 3 }` — sempre DELTAS. */
  readonly metrics: Readonly<Record<string, number>>;
}

/** Quem subiu de nível na rodada. */
export interface XpLevelUp {
  readonly steamId: string;
  readonly from: number;
  readonly to: number;
}

/** O desfecho de uma rodada inteira do coletor. */
export interface BatchXpResult {
  /** `false` = não há temporada no ar ali, e nada foi olhado. */
  readonly season: boolean;
  /** O XP que entrou no lote inteiro. */
  readonly granted: number;
  /** O que o teto cortou — e que NÃO fica para amanhã. */
  readonly capped: number;
  /** Quem recebeu alguma coisa. É por eles que a trilha é reenviada. */
  readonly touched: readonly string[];
  readonly levelUps: readonly XpLevelUp[];
}

/** O XP que um EVENTO concede: a missão diz quanto vale. */
export interface GrantXpRequest {
  readonly serverId: string;
  readonly steamId: string;
  /** `quest:<missão>:<tentativa>:<posição>`. Estável, e é a chave do retry. */
  readonly eventId: string;
  /** A fonte do cardápio. Hoje, sempre `quest.reward`. */
  readonly source: string;
  /** O XP prometido. Vem de quem concede, nunca da regra. */
  readonly amount: number;
  readonly localDay?: string;
}

export interface GrantXpResult {
  readonly granted: number;
  readonly capped: number;
  readonly level: number;
  readonly levelBefore: number;
  /**
   * Por que não entrou tudo.
   *
   *   ok         entrou
   *   no_season  não há temporada no ar naquele servidor
   *   disabled   o admin desligou essa fonte nesta temporada
   *   capped     o teto do dia já estava cheio
   *   repeated   este evento já tinha pago (o retry do painel)
   */
  readonly reason: 'ok' | 'no_season' | 'disabled' | 'capped' | 'repeated';
}

/** A resposta da aba Visão geral. */
export interface BattlePassOverview {
  readonly serverId: string;
  readonly period: string;
  readonly season: BattlePassSeason | null;
  /** A do mês que vem, publicada ou não. `null` = ninguém montou ainda. */
  readonly next: BattlePassSeason | null;
  readonly owners: number;
  readonly players: number;
}

function describeSeason(season: Pick<BattlePassSeason, 'id' | 'period' | 'label'>): string {
  return `temporada #${String(season.id)} ${season.period} ("${season.label}")`;
}

/** O índice único do SQLite, que chega como texto. */
function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message);
}

export class BattlePassService {
  readonly #deps: BattlePassServiceDeps;

  constructor(deps: BattlePassServiceDeps) {
    this.#deps = deps;
  }

  // ======================================================
  //  O CALENDÁRIO
  // ======================================================

  /** O mês de hoje, `2026-10`, no fuso do agente. */
  periodNow(now: number = Date.now()): string {
    return periodOf(localDayOf(now, this.#deps.timeZone));
  }

  /** O dia de hoje, `2026-10-07`, no mesmo fuso. */
  dayNow(now: number = Date.now()): string {
    return dayKeyOf(localDayOf(now, this.#deps.timeZone));
  }

  /**
   * O dia do TETO naquele servidor.
   *
   * É a régua das missões (`reset_at_minute`, dias de calendário),
   * e não uma segunda: com a virada às 06:00, o que o jogador farma
   * às 03:00 ainda conta no teto de ontem — nos dois sistemas, pelo
   * mesmo motivo. Ver `xp-day.ts`.
   *
   * Sem a régua configurada vale a meia-noite do fuso do agente,
   * que é o mesmo resultado quando `reset_at_minute` é zero.
   */
  dayFor(serverId: string, now: number = Date.now()): string {
    const resetAtMinute = this.#deps.resetAtMinuteOf?.(serverId);

    return resetAtMinute === undefined ? this.dayNow(now) : xpDayKey(now, resetAtMinute);
  }

  // ======================================================
  //  TEMPORADAS
  // ======================================================

  listSeasons(): readonly BattlePassSeason[] {
    return this.#deps.repository.list();
  }

  seasonsOf(serverId: string): readonly BattlePassSeason[] {
    return this.#deps.repository.listForServer(serverId);
  }

  /** @throws ApiError `BATTLEPASS_SEASON_NOT_FOUND` (404). */
  getSeason(id: number): BattlePassSeason {
    const season = this.#deps.repository.get(id);

    if (season === null) {
      throw new ApiError(
        'BATTLEPASS_SEASON_NOT_FOUND',
        `Nenhuma temporada com o id ${String(id)}.`,
        404,
      );
    }

    return season;
  }

  /** A que está no ar naquele servidor. `null` = não há passe hoje. */
  activeSeason(serverId: string): BattlePassSeason | null {
    return this.#deps.repository.activeForServer(serverId);
  }

  createSeason(input: SeasonInput, actor: BattlePassActor): BattlePassSeason {
    this.#assertKnownServers(input.servers);

    const season = this.#deps.repository.add(input, { createdBy: actor.name });

    this.#log(actor, 'season.create', describeSeason(season), {
      levels: season.levels,
      servers: season.servers,
    });
    this.#deps.onChange();

    return season;
  }

  updateSeason(id: number, input: SeasonInput, actor: BattlePassActor): BattlePassSeason {
    const current = this.getSeason(id);

    this.#assertKnownServers(input.servers);

    // Mudar o número de níveis para MENOS deixaria recompensas
    // cadastradas fora da trilha — e um resgate já feito lá em cima
    // viraria uma linha que a tela não sabe desenhar.
    this.#assertNoOrphanLevels(current, input);

    const saved = this.#deps.repository.update(id, input);

    if (saved === null) throw this.#seasonGone(id);

    this.#log(actor, 'season.update', describeSeason(saved), {
      levels: { from: current.levels, to: saved.levels },
      servers: { from: current.servers, to: saved.servers },
    });
    this.#deps.onChange();

    return saved;
  }

  setSeasonServers(id: number, servers: readonly string[], actor: BattlePassActor): readonly string[] {
    const current = this.getSeason(id);

    this.#assertKnownServers(servers);

    const saved = this.#deps.repository.setServers(id, servers);

    if (saved === null) throw this.#seasonGone(id);

    this.#log(actor, 'season.servers', describeSeason(current), {
      before: current.servers,
      after: saved,
    });
    this.#deps.onChange();

    return saved;
  }

  /**
   * Publica, ativa, fecha ou volta para rascunho.
   *
   * ####  SÓ UMA FICA `active` POR SERVIDOR  ####
   *
   * Duas seriam duas trilhas na mesma tela sem nada que diga qual
   * vale. A trava é aqui, e não no banco: o estado é da temporada e
   * o servidor é da junção — repetir o estado na junção criaria duas
   * verdades, e a que ficasse velha seria a que o jogo lê.
   *
   * @throws ApiError `BATTLEPASS_SEASON_CONFLICT` (409).
   */
  setSeasonState(
    id: number,
    state: BattlePassSeasonState,
    actor: BattlePassActor,
  ): BattlePassSeason {
    const current = this.getSeason(id);

    if (current.state === state) return current;

    if (state === 'active') {
      if (current.servers.length === 0) {
        throw new ApiError(
          'BATTLEPASS_SEASON_NO_SERVERS',
          `A ${describeSeason(current)} não vale em servidor nenhum: escolha onde ela roda antes de pôr no ar.`,
          400,
        );
      }

      const rivals = this.#deps.repository.activeRivals(id, current.servers);
      const clash = rivals[0];

      if (clash !== undefined) {
        throw new ApiError(
          'BATTLEPASS_SEASON_CONFLICT',
          `A ${describeSeason(clash)} já está no ar num dos mesmos servidores. ` +
            'Feche-a antes de pôr esta no lugar — duas trilhas na mesma tela não têm como dizer qual vale.',
          409,
        );
      }
    }

    const saved = this.#deps.repository.setState(id, state);

    if (saved === null) throw this.#seasonGone(id);

    this.#log(actor, 'season.state', describeSeason(saved), { from: current.state, to: state });
    this.#deps.onChange();

    return saved;
  }

  /**
   * Apaga a temporada, com tudo que pendura nela.
   *
   * O registro sobrevive — é por isso que ele não tem chave
   * estrangeira.
   */
  removeSeason(id: number, actor: BattlePassActor): void {
    const current = this.getSeason(id);

    this.#deps.repository.remove(id);

    this.#log(actor, 'season.delete', describeSeason(current), {
      state: current.state,
      servers: current.servers,
    });
    this.#deps.onChange();
  }

  // ======================================================
  //  A TRILHA
  // ======================================================

  track(seasonId: number): readonly TrackCell[] {
    this.getSeason(seasonId);

    return this.#deps.repository.track(seasonId);
  }

  setTrackCell(
    seasonId: number,
    level: number,
    lane: BattlePassLane,
    input: TrackCellInput,
    actor: BattlePassActor,
  ): TrackCell {
    const season = this.getSeason(seasonId);

    this.#assertLevel(season, level);

    const cell = this.#deps.repository.setCell(seasonId, level, lane, input);

    this.#log(actor, 'track.set', `${describeSeason(season)} nivel ${String(level)} (${lane})`, {
      rewards: cell.rewards.length,
      milestone: cell.milestone,
    });
    this.#deps.onChange();

    return cell;
  }

  clearTrackCell(
    seasonId: number,
    level: number,
    lane: BattlePassLane,
    actor: BattlePassActor,
  ): void {
    const season = this.getSeason(seasonId);

    this.#deps.repository.clearCell(seasonId, level, lane);

    this.#log(actor, 'track.clear', `${describeSeason(season)} nivel ${String(level)} (${lane})`, {});
    this.#deps.onChange();
  }

  // ======================================================
  //  AS REGRAS DE XP
  // ======================================================

  /**
   * O cardápio: o que o agente sabe medir.
   *
   * Servido ao painel, e não escrito nele: o painel que trouxesse a
   * própria lista ofereceria "saquear caixa" ao admin, que ligaria,
   * precificaria — e nada aconteceria, em silêncio. Ver
   * `xp-sources.ts`.
   */
  xpSources(): readonly XpSource[] {
    return XP_SOURCES;
  }

  xpRules(seasonId: number): readonly XpRule[] {
    this.getSeason(seasonId);

    return this.#deps.repository.xpRules(seasonId);
  }

  /** @throws ApiError `BATTLEPASS_XP_SOURCE_UNKNOWN` (400). */
  setXpRule(seasonId: number, input: XpRuleInput, actor: BattlePassActor): XpRule {
    const season = this.getSeason(seasonId);

    // ####  A RECUSA É AQUI, E NÃO NA TELA  ####
    //
    // O cardápio é uma OFERTA; esta é a porta. Sem ela, um PUT com
    // a chave errada — do painel velho, do script de alguém —
    // gravaria uma regra que nunca renderia nada, e o admin passaria
    // o mês achando que o XP de farm está ligado. É a mesma resposta
    // que o ranking deu ao `farm.madeira` (`whyNotPluginMetric`).
    const refusal = whyNotXpSource(input.source);

    if (refusal !== null) {
      throw new ApiError('BATTLEPASS_XP_SOURCE_UNKNOWN', refusal, 400);
    }

    const rule = this.#deps.repository.setXpRule(seasonId, input);

    this.#log(actor, 'xp.rule', `${describeSeason(season)} fonte "${rule.source}"`, {
      enabled: rule.enabled,
      amount: rule.amount,
      dailyCap: rule.dailyCap,
    });
    this.#deps.onChange();

    return rule;
  }

  removeXpRule(seasonId: number, source: string, actor: BattlePassActor): void {
    const season = this.getSeason(seasonId);

    this.#deps.repository.removeXpRule(seasonId, source);

    this.#log(actor, 'xp.rule.delete', `${describeSeason(season)} fonte "${source}"`, {});
    this.#deps.onChange();
  }

  /**
   * Credita XP de uma fonte, com o teto do dia.
   *
   * Quem chama é a frente B, de dentro da transação que aplica o
   * lote do coletor — nunca lendo `player_stats` por fora, que é o
   * caminho que dobra o XP numa rodada repetida (02 §1.1).
   *
   * O XP que estoura o teto NÃO fica para amanhã: ele não acontece.
   */
  creditXp(request: CreditXpRequest, now: number = Date.now()): CreditXpResult {
    const season = this.activeSeason(request.serverId);

    if (season === null) {
      return { granted: 0, capped: 0, level: 1, levelBefore: 1, reason: 'no_season' };
    }

    const rule = this.#deps.repository.xpRule(season.id, request.source);
    const progress = this.#deps.repository.progressOf(request.serverId, request.steamId, season.id);
    const levelBefore = progress?.level ?? 1;

    if (rule === null) {
      return { granted: 0, capped: 0, level: levelBefore, levelBefore, reason: 'no_rule' };
    }

    if (!rule.enabled || rule.amount === 0) {
      return { granted: 0, capped: 0, level: levelBefore, levelBefore, reason: 'disabled' };
    }

    const credit = this.#deps.repository.creditXp(
      {
        serverId: request.serverId,
        steamId: request.steamId,
        season,
        source: rule.source,
        localDay: request.localDay ?? this.dayFor(request.serverId, now),
        amount: rule.amount * Math.max(0, Math.trunc(request.units)),
        dailyCap: rule.dailyCap ?? null,
      },
      now,
    );

    if (credit.granted > 0) {
      this.#deps.onPlayerChange?.(request.serverId, request.steamId);
    }

    return {
      granted: credit.granted,
      capped: credit.capped,
      level: credit.progress.level,
      levelBefore: credit.levelBefore,
      reason: credit.granted === 0 ? 'capped' : 'ok',
    };
  }

  /**
   * O XP que um EVENTO concede — hoje, o que uma missão promete.
   *
   * ####  O VALOR VEM DE QUEM CONCEDE  ####
   *
   * As fontes de ação rendem `regra.amount × ocorrências`, porque
   * ninguém cadastra o preço de cada pedra. Aqui o número está
   * escrito na missão e o jogador o LEU antes de aceitar: a regra
   * decide se aquela fonte vale nesta temporada e qual é o teto do
   * dia — nunca quanto a missão pagou.
   *
   * SEM REGRA CADASTRADA ELE PAGA. É a diferença entre uma torneira
   * e uma promessa: a torneira que ninguém abriu não pinga, mas uma
   * missão que anuncia 800 XP na tela e entrega zero é defeito.
   * Desligar o XP de missão é uma regra `quest.reward` com
   * `enabled: false` — uma ordem explícita, e não um esquecimento.
   *
   * O `eventId` é a proteção do retry: o botão "reentregar" do
   * painel manda o mesmo, e ele cai no `INSERT OR IGNORE` de
   * `battlepass_xp_events`, dentro da transação que soma.
   */
  grantXp(request: GrantXpRequest, now: number = Date.now()): GrantXpResult {
    const season = this.activeSeason(request.serverId);

    if (season === null) {
      return { granted: 0, capped: 0, level: 1, levelBefore: 1, reason: 'no_season' };
    }

    const rule = this.#deps.repository.xpRule(season.id, request.source);
    const progress = this.#deps.repository.progressOf(request.serverId, request.steamId, season.id);
    const levelBefore = progress?.level ?? 1;

    if (rule !== null && !rule.enabled) {
      return { granted: 0, capped: 0, level: levelBefore, levelBefore, reason: 'disabled' };
    }

    const credit = this.#deps.repository.creditXp(
      {
        serverId: request.serverId,
        steamId: request.steamId,
        season,
        source: request.source,
        localDay: request.localDay ?? this.dayFor(request.serverId, now),
        amount: Math.max(0, Math.trunc(request.amount)),
        dailyCap: rule?.dailyCap ?? null,
        eventId: request.eventId,
      },
      now,
    );

    if (credit.granted > 0) {
      this.#deps.onPlayerChange?.(request.serverId, request.steamId);
    }

    return {
      granted: credit.granted,
      capped: credit.capped,
      level: credit.progress.level,
      levelBefore: credit.levelBefore,
      reason: !credit.applied ? 'repeated' : credit.granted === 0 ? 'capped' : 'ok',
    };
  }

  /**
   * O XP de AÇÃO de uma rodada inteira do coletor.
   *
   * ####  ELE RODA DENTRO DA TRANSAÇÃO QUE APLICA O LOTE  ####
   *
   * O delta de 60 s não tem identificador de ocorrência: chega
   * `{"pvp.kills": 3}`, e não três mortes (02 §1). A única
   * idempotência que existe é o `batchId`, e ela vale para o que
   * acontece DENTRO daquela transação — por isso quem chama é o
   * `onApplied` do `applyBatch`, e nunca um segundo passo que lê
   * `player_stats` depois. Ler por fora é o caminho que dobra o XP
   * numa rodada repetida sem nada acusar.
   *
   * ####  O AVISO NÃO SAI DAQUI  ####
   *
   * A trilha de quem subiu é reenviada DEPOIS do commit, pelo
   * coletor, com o `touched`/`levelUps` que este método devolve.
   * Avisar aqui dentro anunciaria um nível que um rollback logo
   * desfaria — e a tela do jogador é o último lugar onde se quer
   * descobrir isso.
   */
  creditBatchXp(
    input: {
      readonly serverId: string;
      readonly players: readonly BatchXpPlayer[];
      /** Ausente = a régua de virada daquele servidor. */
      readonly localDay?: string;
    },
    now: number = Date.now(),
  ): BatchXpResult {
    const empty: BatchXpResult = {
      season: false,
      granted: 0,
      capped: 0,
      touched: [],
      levelUps: [],
    };
    const season = this.activeSeason(input.serverId);

    if (season === null) return empty;

    // As regras de lote, lidas UMA vez: trezentos jogadores vezes
    // dezenove métricas seriam seis mil consultas por rodada, a cada
    // minuto, por servidor.
    const rules = new Map(
      this.#deps.repository
        .xpRules(season.id)
        .filter((rule) => rule.enabled && rule.amount > 0 && isBatchXpSource(rule.source))
        .map((rule) => [rule.source, rule] as const),
    );

    if (rules.size === 0) {
      return { ...empty, season: true };
    }

    const localDay = input.localDay ?? this.dayFor(input.serverId, now);
    const touched: string[] = [];
    const levelUps: XpLevelUp[] = [];
    let granted = 0;
    let capped = 0;

    for (const player of input.players) {
      let got = 0;

      for (const [metric, delta] of Object.entries(player.metrics)) {
        const rule = rules.get(metric);

        if (rule === undefined) continue;

        const units = Math.max(0, Math.trunc(delta));

        if (units === 0) continue;

        const credit = this.#deps.repository.creditXp(
          {
            serverId: input.serverId,
            steamId: player.steamId,
            season,
            source: rule.source,
            localDay,
            amount: rule.amount * units,
            dailyCap: rule.dailyCap ?? null,
          },
          now,
        );

        granted += credit.granted;
        capped += credit.capped;
        got += credit.granted;

        if (credit.progress.level > credit.levelBefore) {
          const up = levelUps.find((item) => item.steamId === player.steamId);

          if (up === undefined) {
            levelUps.push({
              steamId: player.steamId,
              from: credit.levelBefore,
              to: credit.progress.level,
            });
          } else {
            // Duas métricas do mesmo jogador na mesma rodada: o
            // aviso é UM, do nível em que ele estava para o em que
            // ficou. Dois avisos diriam "subiu para o 4" e "subiu
            // para o 5" na mesma tela.
            levelUps[levelUps.indexOf(up)] = { ...up, to: credit.progress.level };
          }
        }
      }

      if (got > 0) {
        touched.push(player.steamId);
      }
    }

    return { season: true, granted, capped, touched, levelUps };
  }

  /**
   * Reenvia a trilha de quem mudou. Chamado DEPOIS do commit.
   *
   * O par deste método é o `creditBatchXp`, que junta os nomes e não
   * avisa ninguém — ver o porquê lá.
   */
  playersChanged(serverId: string, steamIds: readonly string[]): void {
    for (const steamId of steamIds) {
      this.#deps.onPlayerChange?.(serverId, steamId);
    }
  }

  // ======================================================
  //  O DIREITO COMPRADO
  // ======================================================

  /**
   * Dá o passe de um mês — a entrada única, e ela é idempotente.
   *
   * É o que a loja (`PassGranter`) e a entrega do site chamam. O
   * `period` vem do PLANO CONGELADO, nunca do relógio da entrega:
   * um débito `unknown` pode ser reconciliado horas depois,
   * atravessando a virada do mês (04 §4).
   */
  grant(
    input: Omit<GrantEntitlementInput, 'levelAtGrant'>,
    actor: BattlePassActor,
    now: number = Date.now(),
  ): { readonly entitlement: Entitlement; readonly created: boolean } {
    this.#assertKnownServers([input.serverId]);

    const season = this.activeSeason(input.serverId);
    const progress =
      season === null
        ? null
        : this.#deps.repository.progressOf(input.serverId, input.steamId, season.id);

    const result = this.#deps.repository.grantEntitlement(
      { ...input, levelAtGrant: progress?.level ?? 1 },
      now,
    );

    if (result.created) {
      this.#log(
        actor,
        'entitlement.grant',
        `passe de ${result.entitlement.period} em ${result.entitlement.serverId}`,
        { origin: result.entitlement.origin, level: result.entitlement.levelAtGrant },
        result.entitlement.steamId,
      );
      this.#deps.onPlayerChange?.(input.serverId, input.steamId);
    }

    return result;
  }

  /**
   * Já tem o passe daquele mês naquele servidor?
   *
   * É a pergunta que a loja faz ANTES do débito: "comprar o mesmo
   * mês duas vezes" é recusado fora da entrega, porque lá dentro
   * viraria exceção, estorno e chamado de suporte para um caso
   * normal (04 §3).
   */
  hasPass(serverId: string, steamId: string, period: string): boolean {
    return this.#deps.repository.activeEntitlement(serverId, steamId, period) !== null;
  }

  entitlementsOf(steamId: string): readonly Entitlement[] {
    return this.#deps.repository.entitlementsOf(steamId);
  }

  /** @throws ApiError `BATTLEPASS_ENTITLEMENT_NOT_FOUND` (404). */
  revokeEntitlement(id: number, actor: BattlePassActor, now: number = Date.now()): Entitlement {
    const revoked = this.#deps.repository.revokeEntitlement(id, actor.name, now);

    if (revoked === null) {
      throw new ApiError(
        'BATTLEPASS_ENTITLEMENT_NOT_FOUND',
        `Nenhum direito vivo com o id ${String(id)}.`,
        404,
      );
    }

    this.#log(
      actor,
      'entitlement.revoke',
      `passe de ${revoked.period} em ${revoked.serverId}`,
      { origin: revoked.origin },
      revoked.steamId,
    );
    this.#deps.onPlayerChange?.(revoked.serverId, revoked.steamId);

    return revoked;
  }

  // ======================================================
  //  A TRILHA DO JOGADOR
  // ======================================================

  /**
   * O que aquele jogador tem naquele servidor, inteiro.
   *
   * É a resposta única a "o que eu tenho?": o plugin desenha o card
   * com isto, e o painel mostra a mesma coisa na aba Jogadores.
   */
  trackOf(serverId: string, steamId: string): PlayerTrack {
    const season = this.activeSeason(serverId);
    const pending = this.#deps.repository.pendingOf(serverId, steamId);
    const unseen = this.#deps.repository.hasUnseen(serverId, steamId);

    if (season === null) {
      return {
        serverId,
        steamId,
        season: null,
        progress: { level: 1, xp: 0, intoLevel: 0, neededForNext: null, completed: false },
        paid: false,
        cells: [],
        pending,
        unseen,
      };
    }

    const progress = this.#deps.repository.progressOf(serverId, steamId, season.id);
    const xp = progress?.xp ?? 0;
    const entitlement = this.#deps.repository.activeEntitlement(serverId, steamId, season.period);
    const claims = new Map(
      this.#deps.repository
        .claimsOf(serverId, steamId, season.id)
        .map((claim) => [`${String(claim.level)}:${claim.lane}`, claim]),
    );
    const cells = new Map(
      this.#deps.repository.track(season.id).map((cell) => [`${String(cell.level)}:${cell.lane}`, cell]),
    );

    const reached = levelAt(season.xpCurve, season.levels, xp);
    const view: TrackCellView[] = [];

    for (let level = 1; level <= season.levels; level += 1) {
      for (const lane of BATTLEPASS_LANES) {
        if (lane === 'free' && !season.freeLane) continue;
        if (lane === 'paid' && !season.paidLane) continue;

        const key = `${String(level)}:${lane}`;
        const cell = cells.get(key) ?? {
          seasonId: season.id,
          level,
          lane,
          rewards: [],
          milestone: false,
          updatedAt: season.updatedAt,
        };

        const decided = this.#stateOf({
          lane,
          level,
          reached,
          claim: claims.get(key) ?? null,
          entitlement,
          retroactive: season.retroactive,
        });

        view.push({ ...cell, state: decided.state, reason: decided.reason });
      }
    }

    return {
      serverId,
      steamId,
      season,
      progress: trackProgress(season.xpCurve, season.levels, xp),
      paid: entitlement !== null,
      cells: view,
      pending,
      unseen,
    };
  }

  /** A aba Jogadores: quem tem mais XP naquele servidor. */
  leaderboard(input: {
    readonly serverId: string;
    readonly limit: number;
    readonly cursor?: string | undefined;
  }): ProgressPage {
    const season = this.activeSeason(input.serverId);

    if (season === null) return { rows: [], nextCursor: null };

    return this.#deps.repository.leaderboard({
      seasonId: season.id,
      serverId: input.serverId,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  overview(serverId: string, now: number = Date.now()): BattlePassOverview {
    const period = this.periodNow(now);
    const season = this.activeSeason(serverId);
    const seasons = this.#deps.repository.listForServer(serverId);
    const nextPeriod = nextPeriodOf(period);

    return {
      serverId,
      period,
      season,
      next: seasons.find((item) => item.period === nextPeriod) ?? null,
      owners: this.#deps.repository.countEntitlements(serverId, period),
      players:
        season === null
          ? 0
          : this.#deps.repository.leaderboard({
              seasonId: season.id,
              serverId,
              limit: 1_000,
            }).rows.length,
    };
  }

  // ======================================================
  //  O RESGATE
  // ======================================================

  /**
   * Resgata uma casa da trilha e devolve o que ela prometia.
   *
   * ####  A LISTA VOLTA CONGELADA  ####
   *
   * O que sai daqui é o que estava cadastrado NESTE instante, e é
   * isso que fica gravado no resgate. Editar a trilha no dia 20 não
   * muda o que o nível 3 prometia no dia 3 — mesmo princípio do
   * `player_quests.snapshot`.
   *
   * ####  O ESTADO NASCE `pending`, NAS DUAS FAIXAS  ####
   *
   * O 02 §6.1 mostra duas ordens no projeto: a missão marca antes de
   * entregar (para não entregar duas vezes) e a loja entrega antes
   * de marcar (para não perder o que foi pago). O passe tem as duas
   * naturezas, e o `pending` resolve as duas de uma vez: a linha
   * existe (então o segundo clique é recusado pelo UNIQUE) e a
   * dívida fica registrada (então nada do que foi pago se perde).
   *
   * @throws ApiError com a frase pronta em todas as recusas.
   */
  claim(request: ClaimRequest, actor: BattlePassActor, now: number = Date.now()): ClaimResult {
    const season = this.activeSeason(request.serverId);

    if (season === null) {
      throw new ApiError(
        'BATTLEPASS_NO_SEASON',
        'Não há passe de batalha no ar neste servidor.',
        409,
      );
    }

    const track = this.trackOf(request.serverId, request.steamId);
    const cell = track.cells.find(
      (item) => item.level === request.level && item.lane === request.lane,
    );

    if (cell === undefined) {
      throw new ApiError(
        'BATTLEPASS_LEVEL_NOT_FOUND',
        `O nível ${String(request.level)} não existe nesta temporada, ou a faixa está desligada.`,
        404,
      );
    }

    if (cell.state === 'claimed' || cell.state === 'pending') {
      throw new ApiError(
        'BATTLEPASS_ALREADY_CLAIMED',
        `Você já resgatou o nível ${String(request.level)}.`,
        409,
      );
    }

    if (cell.state === 'locked') {
      throw new ApiError(
        'BATTLEPASS_LOCKED',
        cell.reason ?? `O nível ${String(request.level)} ainda está bloqueado.`,
        409,
      );
    }

    // Nível vazio é legítimo (o admin não precisa preencher 60
    // células antes de publicar), e por isso mesmo não se resgata:
    // um resgate sem recompensa nenhuma seria uma linha de histórico
    // dizendo que o jogador levou nada.
    if (cell.rewards.length === 0) {
      throw new ApiError(
        'BATTLEPASS_EMPTY_LEVEL',
        `O nível ${String(request.level)} não dá nada nesta faixa.`,
        409,
      );
    }

    let claim: BattlePassClaim;

    try {
      claim = this.#deps.repository.insertClaim(
        {
          serverId: request.serverId,
          steamId: request.steamId,
          seasonId: season.id,
          level: request.level,
          lane: request.lane,
          snapshot: cell.rewards,
        },
        now,
      );
    } catch (cause) {
      // Dois cliques no mesmo segundo: a conferência acima passou nos
      // dois e o índice único segurou o segundo. É o caso que o 01 §6
      // chama de "clicar duas vezes não entrega duas vezes".
      if (isUniqueViolation(cause)) {
        throw new ApiError(
          'BATTLEPASS_ALREADY_CLAIMED',
          `Você já resgatou o nível ${String(request.level)}.`,
          409,
        );
      }

      throw cause;
    }

    this.#log(
      actor,
      'claim',
      `${describeSeason(season)} nivel ${String(request.level)} (${request.lane})`,
      { rewards: claim.snapshot.length },
      request.steamId,
    );
    this.#deps.onPlayerChange?.(request.serverId, request.steamId);

    return { claim, rewards: claim.snapshot };
  }

  /**
   * "Resgatar tudo": todas as casas disponíveis, de uma vez.
   *
   * Fricção de resgate é a reclamação nº 1 dos passes (03 §2), e
   * quem compra no nível 17 clicaria dezessete vezes. O lote NÃO é
   * atômico: cada casa vira um resgate próprio, e uma que falhe não
   * derruba as outras.
   */
  claimAll(
    serverId: string,
    steamId: string,
    actor: BattlePassActor,
    now: number = Date.now(),
  ): readonly ClaimResult[] {
    const track = this.trackOf(serverId, steamId);
    const done: ClaimResult[] = [];

    for (const cell of track.cells) {
      // Casa vazia não entra: ela não dá nada, e contá-la faria o
      // botão prometer "RESGATAR TUDO (6)" e entregar quatro.
      if (cell.state !== 'available' || cell.rewards.length === 0) continue;

      done.push(this.claim({ serverId, steamId, level: cell.level, lane: cell.lane }, actor, now));
    }

    return done;
  }

  /**
   * Cria o resgate SEM passar pelo estado da trilha.
   *
   * É o caminho da virada do mês: o que estava disponível e não foi
   * resgatado é entregue, não confiscado (01 §7), e nesse instante a
   * temporada já não é mais a ativa — então `claim` recusaria.
   *
   * Continua sujeito ao UNIQUE: quem já resgatou não ganha de novo.
   */
  claimFor(
    input: {
      readonly serverId: string;
      readonly steamId: string;
      readonly seasonId: number;
      readonly level: number;
      readonly lane: BattlePassLane;
    },
    actor: BattlePassActor,
    now: number = Date.now(),
  ): ClaimResult | null {
    const cell = this.#deps.repository.cell(input.seasonId, input.level, input.lane);

    if (cell === null || cell.rewards.length === 0) return null;

    try {
      const claim = this.#deps.repository.insertClaim({ ...input, snapshot: cell.rewards }, now);

      this.#log(
        actor,
        'claim.rollover',
        `temporada #${String(input.seasonId)} nivel ${String(input.level)} (${input.lane})`,
        { rewards: claim.snapshot.length },
        input.steamId,
      );

      return { claim, rewards: claim.snapshot };
    } catch (cause) {
      if (isUniqueViolation(cause)) return null;

      throw cause;
    }
  }

  /**
   * O desfecho da entrega, posição a posição.
   *
   * O que entregou fecha; o que falhou vai para a caixa com o código
   * cru (`INVENTORY_FULL`, `RCON_UNAVAILABLE`). Só quando nada mais
   * deve é que o resgate vira `claimed` — a marca vem DEPOIS da
   * entrega, nunca antes.
   */
  settle(
    claimId: number,
    outcomes: readonly DeliveryOutcome[],
    origin: BattlePassPendingOrigin = 'inventory',
    now: number = Date.now(),
  ): { readonly claim: BattlePassClaim; readonly pending: readonly PendingDelivery[] } {
    const result = this.#deps.repository.settleClaim(claimId, outcomes, origin, now);

    if (result === null) {
      throw new ApiError(
        'BATTLEPASS_CLAIM_NOT_FOUND',
        `Nenhum resgate com o id ${String(claimId)}.`,
        404,
      );
    }

    this.#deps.onPlayerChange?.(result.claim.serverId, result.claim.steamId);

    return result;
  }

  // ======================================================
  //  A CAIXA
  // ======================================================

  pendingOf(serverId: string, steamId: string): readonly PendingDelivery[] {
    return this.#deps.repository.pendingOf(serverId, steamId);
  }

  /**
   * O jogador abriu a caixa: o ponto de notificação some.
   *
   * O ponto marca "ainda não olhou", e não "ainda não recebeu" — ter
   * pendência e saber que tem são coisas diferentes (01 §7.1).
   */
  openBox(serverId: string, steamId: string, now: number = Date.now()): readonly PendingDelivery[] {
    const before = this.#deps.repository.pendingOf(serverId, steamId);

    if (this.#deps.repository.markSeen(serverId, steamId, now) > 0) {
      this.#deps.onPlayerChange?.(serverId, steamId);
    }

    return before;
  }

  // ======================================================
  //  O REGISTRO
  // ======================================================

  audit(filter: AuditFilter): readonly BattlePassAuditEntry[] {
    return this.#deps.repository.audit(filter);
  }

  // ======================================================
  //  Conferências
  // ======================================================

  /**
   * O estado de uma casa para aquele jogador (01 §4.1).
   *
   * A tabela inteira, num lugar só — é o que impede o plugin e o
   * painel de chegarem a respostas diferentes para a mesma casa.
   */
  #stateOf(input: {
    readonly lane: BattlePassLane;
    readonly level: number;
    readonly reached: number;
    readonly claim: BattlePassClaim | null;
    readonly entitlement: Entitlement | null;
    readonly retroactive: boolean;
  }): { readonly state: BattlePassCellState; readonly reason: string | null } {
    if (input.claim !== null) {
      return { state: input.claim.status === 'claimed' ? 'claimed' : 'pending', reason: null };
    }

    if (input.level > input.reached) {
      return {
        state: 'locked',
        reason: `Chegue ao nível ${String(input.level)} para levar esta recompensa.`,
      };
    }

    if (input.lane === 'paid') {
      if (input.entitlement === null) {
        return {
          state: 'locked',
          reason: 'Esta recompensa é da faixa paga: ative o passe para poder levá-la.',
        };
      }

      // Retroativo desligado: a compra vale do nível SEGUINTE ao da
      // compra em diante. É uma venda pior e uma escolha legítima de
      // quem opera o servidor — e a tela precisa dizer o motivo, em
      // vez de mostrar um cadeado mudo.
      if (!input.retroactive && input.level <= input.entitlement.levelAtGrant) {
        return {
          state: 'locked',
          reason:
            `Você já estava no nível ${String(input.entitlement.levelAtGrant)} quando ativou o passe, ` +
            'e nesta temporada a faixa paga vale do nível seguinte em diante.',
        };
      }
    }

    return { state: 'available', reason: null };
  }

  #assertKnownServers(servers: readonly string[]): void {
    const known = new Set(this.#deps.serverIds());
    const unknown = servers.filter((id) => !known.has(id));

    if (unknown.length > 0) {
      throw new ApiError(
        'UNKNOWN_SERVER',
        `Estes servidores não existem: ${unknown.join(', ')}.`,
        400,
      );
    }
  }

  #assertLevel(season: BattlePassSeason, level: number): void {
    if (level >= 1 && level <= season.levels) return;

    throw new ApiError(
      'BATTLEPASS_LEVEL_OUT_OF_RANGE',
      `Esta temporada tem ${String(season.levels)} níveis, e o ${String(level)} está fora da trilha.`,
      400,
    );
  }

  /**
   * Encolher a trilha não pode deixar recompensa fora dela.
   *
   * O admin que quiser mesmo encolher apaga as casas de cima
   * primeiro — e aí a recusa some sozinha. Deixar passar daria uma
   * temporada com resgates em níveis que a tela não desenha.
   */
  #assertNoOrphanLevels(season: BattlePassSeason, input: SeasonInput): void {
    if (input.levels >= season.levels) return;

    const orphans = this.#deps.repository
      .track(season.id)
      .filter((cell) => cell.level > input.levels);

    if (orphans.length === 0) return;

    const highest = orphans.reduce((max, cell) => Math.max(max, cell.level), 0);

    throw new ApiError(
      'BATTLEPASS_LEVELS_IN_USE',
      `Esta temporada tem recompensa cadastrada até o nível ${String(highest)}: ` +
        `encolher para ${String(input.levels)} deixaria ${String(orphans.length)} de fora da trilha. ` +
        'Apague-as primeiro.',
      409,
    );
  }

  #seasonGone(id: number): ApiError {
    // Ela existia no começo do método: só chega aqui quem apagou a
    // temporada no meio da edição, de outra aba.
    return new ApiError(
      'BATTLEPASS_SEASON_NOT_FOUND',
      `A temporada ${String(id)} foi apagada no meio da edição.`,
      404,
    );
  }

  #log(
    actor: BattlePassActor,
    action: string,
    target: string,
    detail: Record<string, unknown>,
    steamId: string | null = null,
  ): void {
    this.#deps.repository.log({
      actor: actor.name,
      source: actor.source,
      action,
      target,
      serverId: actor.serverId ?? null,
      steamId,
      detail,
    });
  }
}

/**
 * O serviço do passe visto por quem VENDE — a loja in-game e a fila
 * do site.
 *
 * ####  POR QUE ELE É UMA FUNÇÃO, E NÃO UM OBJETO NO `index.ts`  ####
 *
 * São os dois canais de venda ligando no mesmo `StoreService`
 * (`store/service.ts:1018`), e o que muda entre eles é uma palavra:
 * a origem. Montar o adaptador à mão em cada lugar faria a segunda
 * cópia divergir da primeira no primeiro ajuste — e o teste
 * exercitaria uma terceira, escrita dentro dele.
 *
 * O ator do registro acompanha a ORIGEM. Fixá-lo em `loja` faria a
 * auditoria contar uma venda do site como venda dentro do jogo.
 */
export function passGranterOf(service: BattlePassService): PassGranter {
  return {
    // De que mês é a compra. A régua do calendário é a do passe — e
    // ela já usa `localDayOf`, a mesma do resto do processo.
    periodNow: (now) => service.periodNow(now),
    hasPass: (serverId, steamId, period) => service.hasPass(serverId, steamId, period),
    grant: (input) => {
      service.grant(
        {
          serverId: input.serverId,
          steamId: input.steamId,
          // O mês do PLANO CONGELADO. Ver store/service.ts.
          period: input.period,
          origin: input.origin,
          sourceRef: input.sourceRef,
          createdBy: input.createdBy,
        },
        { name: input.origin, source: 'system' },
      );
    },
  };
}

/** `2026-12` -> `2027-01`. A conta do mês seguinte, sem `Date`. */
function nextPeriodOf(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));

  if (!Number.isFinite(year) || !Number.isFinite(month)) return period;

  return month === 12
    ? `${String(year + 1)}-01`
    : `${String(year)}-${String(month + 1).padStart(2, '0')}`;
}
