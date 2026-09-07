// ============================================================
//  service.ts  -  a camada que a API chama, e a única que sabe as
//  REGRAS do ranking.
//
//  O repositório guarda; este arquivo decide. A separação paga por
//  si em três lugares:
//
//    1. o K/D não existe no banco — ele é calculado aqui, com o
//       encolhimento do 19-PESQUISA §6.3, e a rota nem sabe;
//    2. "métrica desconhecida" e "lista vazia" são respostas
//       diferentes, e quem sabe a diferença é quem conhece o
//       catálogo;
//    3. `coverage` vem de fora (RankingCoverage): quem sabe se o
//       plugin está carregado é o `index.ts`, e ele não tem por
//       que estar aqui dentro.
//
//  ------------------------------------------------------------
//  ####  OS TRÊS CAMPOS QUE TODA LISTA CARREGA  ####
//
//    measuredSince  desde quando aquilo é medido. Sem ele, um
//                   ranking que começou ontem parece um ranking de
//                   sempre — e um ranking premiado que não diz
//                   desde quando mede é um ranking contestado;
//    coverage       quais servidores do escopo tinham coleta ativa.
//                   "Zero" e "não consegui perguntar" são respostas
//                   diferentes, e esta é a que separa as duas;
//    updatedAt      do último lote aplicado.
//
//  Ver Docs/Ranking/20-PLANO-E-CONTRATOS.md §9.
// ============================================================

import { ApiError } from '../http/error-response.js';
import type {
  ComputedPodium,
  PeriodKind,
  PlayerPosition,
  PodiumRow,
  RankingDirection,
  RankingEntry,
  RankingRecord,
  RankingSettings,
  RankingSettingsInput,
  RankingsRepository,
  RankingInput,
  RecordEntry,
  RollPeriodResult,
  SnapshotEntry,
  StatPeriod,
} from '../db/rankings-repository.js';
import { closeAndOpen, periodLabel, nextSeasonTurnAt, type PeriodsDeps } from './periods.js';

// ------------------------------------------------------------
//  O K/D, e por que ele não é uma divisão
// ------------------------------------------------------------

/**
 * As "mortes fantasma" do encolhimento bayesiano.
 *
 * ####  POR QUE 3 ABATES E 0 MORTES NÃO PODE SER O PRIMEIRO  ####
 *
 * Com amostra pequena, o topo de qualquer lista de razão é ocupado
 * por quem jogou pouco: 3/0 é K/D infinito. A correção padrão é
 * somar votos fantasma na média da população:
 *
 *     kd = (kills + C * m) / (deaths + C)
 *
 * Com C = 10, 3/0 vira 1,3 — plausível. E 400/300 vira 1,32 contra
 * o bruto 1,33: com amostra grande o prior desaparece sozinho, que
 * é exatamente o comportamento desejado.
 *
 * Ver 19-PESQUISA §6.3.
 */
export const KD_PRIOR = 10;

/**
 * O corte de amostra para aparecer no PÓDIO.
 *
 * Quem não atingiu continua com o número na ficha — ele só não
 * disputa. Esconder o número seria pior: o jogador veria "sem
 * dados" onde ele sabe que matou alguém.
 */
export const KD_MIN_DEATHS = 10;
export const KD_MIN_KILLS = 20;

export const KD_KILLS_METRIC = 'pvp.kills';
export const KD_DEATHS_METRIC = 'pvp.deaths';

/** A razão com encolhimento. `mean` é o K/D médio da população. */
export function shrunkKd(kills: number, deaths: number, mean = 1, prior = KD_PRIOR): number {
  return (kills + prior * mean) / (deaths + prior);
}

// ------------------------------------------------------------
//  As dependências injetadas
// ------------------------------------------------------------

/**
 * Como a coleta daquele servidor estava.
 *
 * ####  SÃO QUATRO, E O QUARTO NASCEU DE UM DEFEITO NA TELA  ####
 *
 *   `ok`          chegou lote na última rodada;
 *   `never`       o plugin está aí, mas NUNCA houve lote deste
 *                 servidor — a primeira coleta ainda não veio;
 *   `no-answer`   já houve lote, e o último é velho: a coleta
 *                 parou;
 *   `not-loaded`  o plugin de coleta não está carregado.
 *
 * Antes do `never`, um ranking que nunca tinha recebido coleta
 * nenhuma dizia "a coleta não responde há um tempo" — mandando o
 * admin caçar uma falha que não existe. É o mesmo princípio que
 * este projeto segue em toda parte ("zero" ≠ "não consegui
 * perguntar"), com o terceiro caso que faltava: "ainda não
 * perguntei nenhuma vez".
 */
export type CoverageStatus = 'ok' | 'never' | 'no-answer' | 'not-loaded';

/**
 * O que cada estado quer dizer, em português, num lugar só.
 *
 * ####  POR QUE ELAS MORAM AQUI, E NÃO NA TELA  ####
 *
 * São duas telas — a do jogo e a do painel — explicando o MESMO
 * defeito. Escritas em dois arquivos, elas divergem no primeiro
 * ajuste, e o jogador e o admin passam a ler duas versões da
 * mesma história. O painel não importa este módulo: ele recebe a
 * frase pronta no `coverage` da API (ver `routes/rankings.ts`).
 *
 * `ok` é `null` de propósito: não há aviso quando não há o que
 * avisar, e um texto vazio na tela ocuparia espaço dizendo nada.
 */
export const COVERAGE_MESSAGES: Readonly<Record<CoverageStatus, string | null>> = {
  ok: null,
  never: 'Este ranking ainda não recebeu nenhuma coleta.',
  'no-answer': 'A coleta não responde há um tempo: estes números podem estar atrasados.',
  'not-loaded': 'O plugin de coleta não está carregado neste servidor.',
};

/** O aviso daquele estado. `null` = não há o que avisar. */
export function coverageMessageOf(status: CoverageStatus | null): string | null {
  return status === null ? null : COVERAGE_MESSAGES[status];
}

/**
 * Quanto tempo um lote continua contando como "agora".
 *
 * O ciclo da coleta é de 60 s (Docs\Ranking\20 §6.4); dez ciclos
 * de folga separam "está coletando" de "parou e ninguém viu", sem
 * acusar um servidor que perdeu uma volta.
 */
export const COVERAGE_FRESH_MS = 10 * 60_000;

/** O tripé com que o `index.ts` responde pelo estado da coleta. */
export interface CoverageEvidence {
  /** O Oxide carregou o plugin? `null` = ninguém conseguiu perguntar. */
  readonly pluginLoaded: boolean | null;
  /** O `.cs` está ligado no acervo? `null` = não deu para ler. */
  readonly pluginEnabled: boolean | null;
  /** Quando o último lote daquele servidor foi aplicado. */
  readonly lastBatchAt: number | null;
  readonly now?: number;
  readonly freshMs?: number;
}

/**
 * O estado da coleta, a partir das três testemunhas.
 *
 * ####  A ORDEM DAS PERGUNTAS É A ORDEM DA CULPA  ####
 *
 * Plugin fora do ar é a resposta mais acionável, e por isso vem
 * primeiro: com ele fora, "nunca chegou lote" é consequência, e
 * não notícia. Só depois disso a ausência de lote vira a
 * afirmação que ela é.
 *
 * Sem lote NENHUM o veredito é `never` mesmo quando ninguém
 * conseguiu confirmar o plugin (`pluginLoaded` e `pluginEnabled`
 * nulos): "nunca chegou lote deste servidor" é um fato do banco,
 * enquanto "a coleta parou" seria um palpite sobre um servidor
 * que talvez nunca tenha coletado. Acusar é o que manda consertar
 * o que não está quebrado — a mesma escolha de
 * `game/players.ts:#whyNoAnswer`.
 *
 * A função é PURA de propósito: quem junta as testemunhas é o
 * `index.ts` (é lá que moram o Oxide e o acervo), e quem decide é
 * este módulo, que é onde as regras do ranking moram — e é o que
 * permite testar o defeito sem subir agente nenhum.
 */
export function coverageStatusOf(evidence: CoverageEvidence): CoverageStatus {
  if (evidence.pluginLoaded === false || evidence.pluginEnabled === false) {
    return 'not-loaded';
  }

  if (evidence.lastBatchAt === null) {
    return 'never';
  }

  const now = evidence.now ?? Date.now();
  const freshMs = evidence.freshMs ?? COVERAGE_FRESH_MS;

  return now - evidence.lastBatchAt <= freshMs ? 'ok' : 'no-answer';
}

/**
 * O nome que a tela do jogo mostra na aba.
 *
 * O `shortLabel` em branco cai no `label`: "sem nome curto" e
 * "nome curto vazio" são a mesma intenção, e a aba não pode ficar
 * sem texto por causa de um campo que o admin apagou.
 */
export function gameLabelOf(ranking: Pick<RankingRecord, 'label' | 'shortLabel'>): string {
  const short = ranking.shortLabel?.trim() ?? '';

  return short === '' ? ranking.label : short;
}

export interface CoverageServer {
  readonly serverId: string;
  readonly status: CoverageStatus;
  readonly lastBatchAt: number | null;
}

export interface CoverageReport {
  readonly servers: readonly CoverageServer[];
}

/**
 * Quem sabe se a coleta estava viva.
 *
 * ####  POR QUE ISTO É INJETADO, E NÃO CALCULADO AQUI  ####
 *
 * A resposta sai de um tripé que mora fora do ranking:
 * `library.serverList()` (o `.cs` está ligado?),
 * `oxideRuntime.pluginOf()` (o Oxide carregou?) e o resultado do
 * último `flush`. Quem tem os três na mão é o `index.ts`.
 *
 * Uma interface mínima, e de propósito: um teste a satisfaz com
 * uma função de três linhas, e a coleta (F3) a satisfaz de
 * verdade.
 */
export interface RankingCoverage {
  coverageOf(serverIds: readonly string[]): Promise<CoverageReport>;
}

/** O que o serviço precisa saber dos servidores. E nada além. */
export interface RankingServers {
  ids(): readonly string[];
}

export interface RankingsServiceDeps {
  readonly repository: RankingsRepository;
  readonly servers: RankingServers;
  readonly coverage: RankingCoverage;
  /** Zona IANA para os rótulos e para a virada. Ausente = a da máquina. */
  readonly timeZone?: string | undefined;
}

// ------------------------------------------------------------
//  As perguntas
// ------------------------------------------------------------

/**
 * Tamanho de página das listas de ranking: o padrão e o teto.
 *
 * Eles moram aqui, e não no zod da rota, pela mesma razão de
 * `players/service.ts:48-54`: quem conhece o custo de uma página é
 * quem monta a consulta. Uma rota que escolhesse o próprio teto
 * teria de ser encontrada de novo no dia em que o teto mudasse — e
 * a segunda rota que listasse ranking escolheria outro número.
 */
export const DEFAULT_RANKING_LIMIT = 50;
export const MAX_RANKING_LIMIT = 200;

export type RankingScope = 'server' | 'global';

export interface LeaderboardQuery {
  readonly metric: string;
  readonly scope?: RankingScope | undefined;
  readonly serverId?: string | undefined;
  /** Ausente = a `window` do próprio ranking. */
  readonly period?: PeriodKind | undefined;
  /** Sobrepõe `period`. É como se lê uma temporada FECHADA. */
  readonly periodId?: number | undefined;
  readonly limit: number;
  readonly offset: number;
}

/** A janela em que a lista foi lida. */
export interface PeriodView {
  readonly id: number | null;
  readonly kind: PeriodKind;
  readonly serverId: string | null;
  readonly label: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly seasonMode: string | null;
  /** Quando ela vira, se ninguém mexer. `null` = não tem data. */
  readonly turnsAt: number | null;
}

export interface LeaderboardResult {
  readonly ranking: RankingRecord;
  readonly scope: RankingScope;
  readonly period: PeriodView;
  /** A lista veio do pódio congelado? Aí ela não muda mais. */
  readonly frozen: boolean;
  readonly entries: readonly RankingEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly measuredSince: number | null;
  readonly updatedAt: number | null;
  readonly coverage: CoverageReport;
}

export interface RecordsResult {
  readonly ranking: RankingRecord;
  readonly scope: RankingScope;
  readonly period: PeriodView;
  readonly entries: readonly RecordEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly measuredSince: number | null;
  readonly updatedAt: number | null;
  readonly coverage: CoverageReport;
}

export interface PlayerRankingRow {
  readonly ranking: RankingRecord;
  readonly scope: RankingScope;
  readonly periodId: number | null;
  readonly position: number | null;
  readonly value: number | null;
  readonly total: number;
}

export interface PeriodDetail {
  readonly period: StatPeriod;
  readonly podium: readonly {
    readonly metric: string;
    readonly label: string;
    readonly entries: readonly SnapshotEntry[];
  }[];
}

export interface SeasonTurnResult {
  readonly closed: StatPeriod;
  readonly opened: StatPeriod;
  readonly frozen: number;
}

export class RankingsService {
  readonly #repository: RankingsRepository;
  readonly #servers: RankingServers;
  readonly #coverage: RankingCoverage;
  readonly #timeZone: string | undefined;

  constructor(deps: RankingsServiceDeps) {
    this.#repository = deps.repository;
    this.#servers = deps.servers;
    this.#coverage = deps.coverage;
    this.#timeZone = deps.timeZone;
  }

  // ------------------------------------------------------
  //  O catálogo
  // ------------------------------------------------------

  /**
   * O catálogo. `inGameOnly` é o filtro da tela do JOGO.
   *
   * Ele é diferente do `enabledOnly`: o ranking escondido do menu
   * do jogo continua ligado, continua contando e continua na
   * resposta do painel — ver a migração 044.
   */
  metrics(
    options: { readonly enabledOnly?: boolean; readonly inGameOnly?: boolean } = {},
  ): readonly RankingRecord[] {
    return this.#repository.list(options);
  }

  /**
   * O ranking daquela métrica, ou uma recusa com nome.
   *
   * Uma métrica fora do catálogo devolve `RANKING_METRIC_UNKNOWN`,
   * e não lista vazia: lista vazia diria "ninguém pontuou ainda",
   * que é uma afirmação sobre os jogadores — e a verdade é sobre a
   * pergunta.
   */
  requireMetric(metric: string): RankingRecord {
    const ranking = this.#repository.getByMetric(metric);

    if (ranking === null) {
      throw new ApiError(
        'RANKING_METRIC_UNKNOWN',
        `Não existe ranking para a métrica "${metric}".`,
        400,
      );
    }

    return ranking;
  }

  createMetric(input: RankingInput, now?: number): RankingRecord {
    return this.#repository.create(input, now);
  }

  updateMetric(id: string, input: RankingInput, now?: number): RankingRecord {
    const saved = this.#repository.update(id, input, now);

    if (saved === null) {
      throw new ApiError('RANKING_NOT_FOUND', `Não existe o ranking "${id}".`, 404);
    }

    return saved;
  }

  removeMetric(id: string): void {
    if (!this.#repository.remove(id)) {
      throw new ApiError('RANKING_NOT_FOUND', `Não existe o ranking "${id}".`, 404);
    }
  }

  /**
   * A ordem do catálogo, reescrita de uma vez.
   *
   * É o que o arrastar-e-soltar do painel manda: a lista INTEIRA,
   * na ordem que ficou. A conferência de que ela é mesmo inteira
   * mora no repositório, junto da transação que a aplica — ver
   * `db/rankings-repository.ts`.
   */
  reorderMetrics(ids: readonly string[], now?: number): readonly RankingRecord[] {
    return this.#repository.reorder(ids, now);
  }

  // ------------------------------------------------------
  //  A configuração
  // ------------------------------------------------------

  settingsOf(serverId: string): RankingSettings {
    return this.#repository.settingsOf(serverId);
  }

  saveSettings(serverId: string, input: RankingSettingsInput, now?: number): RankingSettings {
    return this.#repository.saveSettings(serverId, input, now);
  }

  // ------------------------------------------------------
  //  As listas
  // ------------------------------------------------------

  /**
   * A lista, paginada, com os três campos do §9.2.
   *
   * Três caminhos, e o `valueKind` escolhe: contador soma, recorde
   * é o melhor de cada um e razão é calculada aqui.
   */
  async leaderboard(query: LeaderboardQuery): Promise<LeaderboardResult> {
    const ranking = this.requireMetric(query.metric);
    const scope = this.#scopeOf(ranking, query.scope, query.serverId);

    if (query.periodId !== undefined) {
      return await this.#frozenLeaderboard(ranking, query, query.periodId);
    }

    const kind = query.period ?? ranking.window;
    const periods = this.#periodsOf(scope, kind, query.serverId);
    const serverIds = periods.map((period) => period.serverId);

    const page =
      ranking.valueKind === 'ratio'
        ? this.#ratioPage(ranking, periods, query.limit, query.offset)
        : this.#counterPage(ranking, periods, scope, kind, serverIds, query);

    return {
      ranking,
      scope,
      period: this.#periodView(periods, kind, scope),
      frozen: false,
      entries: page.entries,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
      measuredSince: measuredSinceOf(periods),
      updatedAt: this.#repository.lastBatchAt(serverIds),
      coverage: await this.#coverage.coverageOf(serverIds),
    };
  }

  /** Os recordes, com o testemunho. */
  async records(query: LeaderboardQuery): Promise<RecordsResult> {
    const ranking = this.requireMetric(query.metric);
    const scope = this.#scopeOf(ranking, query.scope, query.serverId);
    const kind = query.period ?? ranking.window;

    const periods =
      query.periodId === undefined
        ? this.#periodsOf(scope, kind, query.serverId)
        : [this.#requirePeriod(query.periodId)];

    const serverIds = periods.map((period) => period.serverId);
    const page = this.#recordsPage(ranking, periods, query.limit, query.offset);

    return {
      ranking,
      scope,
      period: this.#periodView(periods, kind, scope),
      entries: page.entries,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
      measuredSince: measuredSinceOf(periods),
      updatedAt: this.#repository.lastBatchAt(serverIds),
      coverage: await this.#coverage.coverageOf(serverIds),
    };
  }

  /**
   * As posições DELE, ranking a ranking.
   *
   * Um ranking em que ele não pontuou vem com `position: null` — e
   * não com o último lugar. "Sem número" e "em último" são coisas
   * diferentes, e a segunda ofende quem nem jogou.
   */
  playerRankings(
    steamId: string,
    options: { readonly serverId?: string | undefined; readonly scope?: RankingScope } = {},
  ): readonly PlayerRankingRow[] {
    const rows: PlayerRankingRow[] = [];

    for (const ranking of this.#repository.list({ enabledOnly: true })) {
      const scope = this.#scopeOf(ranking, options.scope, options.serverId, true);

      if (scope === null) {
        continue;
      }

      const periods = this.#periodsOf(scope, ranking.window, options.serverId, true);

      if (periods.length === 0) {
        continue;
      }

      rows.push({
        ranking,
        scope,
        periodId: scope === 'server' ? (periods[0]?.id ?? null) : null,
        ...this.#positionIn(ranking, periods, scope, steamId),
      });
    }

    return rows;
  }

  // ------------------------------------------------------
  //  O histórico
  // ------------------------------------------------------

  periods(options: {
    readonly serverId?: string | undefined;
    readonly kind?: PeriodKind | undefined;
    readonly limit: number;
    readonly offset: number;
  }): { readonly periods: readonly StatPeriod[]; readonly total: number } {
    return this.#repository.listPeriods(options);
  }

  /** Um período e o pódio congelado dele. */
  periodDetail(periodId: number): PeriodDetail {
    const period = this.#requirePeriod(periodId);
    const byMetric = new Map(this.#repository.list().map((item) => [item.metric, item.label]));

    return {
      period,
      podium: this.#repository.snapshotMetricsOf(periodId).map((metric) => ({
        metric,
        label: byMetric.get(metric) ?? metric,
        entries: this.#repository.snapshotOf(periodId, metric),
      })),
    };
  }

  // ------------------------------------------------------
  //  As ações
  // ------------------------------------------------------

  /**
   * Fecha um período à mão e abre o seguinte.
   *
   * `POST /api/rankings/periods/:id/close`. Fechar o mesmo duas
   * vezes devolve `RANKING_PERIOD_CLOSED` e NÃO abre um terceiro —
   * a idempotência é por período, e não por requisição.
   */
  closePeriod(periodId: number, options: { readonly label?: string | null } = {}): RollPeriodResult {
    const period = this.#requirePeriod(periodId);
    const settings = this.#repository.settingsOf(period.serverId);
    const now = Date.now();

    return this.#repository.rollPeriod({
      periodId,
      snapshotSize: settings.snapshotSize,
      nextSeasonMode: period.kind === 'season' ? settings.seasonMode : null,
      nextLabel:
        options.label ??
        periodLabel(
          period.kind,
          now,
          period.kind === 'season' ? settings.seasonMode : null,
          this.#timeZone,
        ),
      at: now,
      computed: this.computedPodium,
    });
  }

  /**
   * O botão "abrir temporada nova agora".
   *
   * `POST /api/servers/:id/rankings/season`. É o mesmo caminho da
   * virada automática — de propósito: um botão que fecha a
   * temporada por um caminho próprio é um botão que um dia congela
   * o pódio de um jeito diferente do sweep.
   *
   * @throws `RANKING_PERIOD_NOT_FOUND` quando o servidor não tem
   *         temporada aberta.
   */
  openNewSeason(
    serverId: string,
    options: { readonly label?: string | null; readonly now?: number } = {},
  ): SeasonTurnResult {
    const rolled = closeAndOpen(this.#periodsDeps(), {
      serverId,
      kind: 'season',
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.label === undefined ? {} : { label: options.label }),
    });

    if (rolled === null) {
      throw new ApiError(
        'RANKING_PERIOD_NOT_FOUND',
        `O servidor "${serverId}" não tem temporada aberta para fechar.`,
        404,
      );
    }

    return rolled;
  }

  /** Zera o jogador naquele período, com autor. */
  resetPlayer(input: {
    readonly steamId: string;
    readonly periodId: number;
    readonly metric?: string | null;
    readonly actor: string;
    readonly reason?: string | null;
  }): number {
    this.#requirePeriod(input.periodId);

    return this.#repository.resetPlayer(input);
  }

  /** A conta de emitidos × convertidos, por dia e por fonte. */
  audit(query: {
    readonly serverId?: string | undefined;
    readonly metric?: string | undefined;
    readonly from?: number | undefined;
    readonly to?: number | undefined;
  }): ReturnType<RankingsRepository['auditOf']> {
    return this.#repository.auditOf(query);
  }

  /**
   * A ponte que congela os rankings derivados.
   *
   * É passada ao repositório na hora de fechar o período: sem ela,
   * o K/D seria o único ranking sem pódio no histórico, e a tela
   * mostraria um buraco que ninguém sabe explicar.
   */
  readonly computedPodium: ComputedPodium = (ranking, periodId, size): readonly PodiumRow[] => {
    if (ranking.metric !== 'pvp.kd') {
      // Um ranking `computed` que este serviço não conhece não é
      // congelado com zero: zero seria uma afirmação falsa sobre
      // todo mundo. Fica sem pódio, e a ausência é visível.
      return [];
    }

    return this.#kdRows([periodId])
      .filter((row) => row.eligible)
      .slice(0, size)
      .map((row) => ({ steamId: row.steamId, displayName: row.name, value: row.value }));
  };

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  #periodsDeps(): PeriodsDeps {
    return {
      repository: this.#repository,
      computed: this.computedPodium,
      ...(this.#timeZone === undefined ? {} : { timeZone: this.#timeZone }),
    };
  }

  /**
   * Servidor ou rede — e a recusa quando a pergunta não faz
   * sentido.
   *
   * ####  MINÉRIO NÃO TEM RANKING DE REDE  ####
   *
   * Somar um servidor 1x com um 5x produz uma lista ordenada por
   * EM QUE SERVIDOR a pessoa jogou. É por isso que a recusa é
   * explícita (`RANKING_SCOPE_INVALID`) em vez de uma soma que
   * parece funcionar.
   */
  #scopeOf(
    ranking: RankingRecord,
    asked: RankingScope | undefined,
    serverId: string | undefined,
    quiet = false,
  ): RankingScope {
    const scope = asked ?? (serverId === undefined ? 'global' : 'server');

    if (scope === 'global' && !ranking.globalEligible) {
      if (quiet) {
        // Na ficha do jogador, um ranking que não soma na rede
        // simplesmente não aparece — recusar a página inteira por
        // causa dele seria pior.
        return 'server';
      }

      throw new ApiError(
        'RANKING_SCOPE_INVALID',
        `O ranking "${ranking.label}" não soma entre servidores: as taxas de coleta são ` +
          'diferentes, e a lista sairia ordenada por em que servidor a pessoa jogou.',
        400,
      );
    }

    return scope;
  }

  /**
   * As janelas do escopo pedido.
   *
   * @throws `RANKING_NOT_MEASURED` quando não há janela nenhuma —
   *         o escopo nunca teve coleta ativa. "Sem dados" e "zero"
   *         são respostas diferentes.
   */
  #periodsOf(
    scope: RankingScope,
    kind: PeriodKind,
    serverId: string | undefined,
    quiet = false,
  ): readonly StatPeriod[] {
    if (scope === 'server') {
      if (serverId === undefined) {
        throw new ApiError(
          'RANKING_SCOPE_INVALID',
          'Para ver o ranking de um servidor é preciso dizer qual.',
          400,
        );
      }

      const open = this.#repository.openPeriodOf(serverId, kind);

      if (open === null) {
        if (quiet) {
          return [];
        }

        throw new ApiError(
          'RANKING_NOT_MEASURED',
          `O servidor "${serverId}" ainda não tem janela de ranking aberta — nada foi medido ali.`,
          409,
        );
      }

      return [open];
    }

    const open = this.#repository.openPeriodsOf(kind, this.#servers.ids());

    if (open.length === 0 && !quiet) {
      throw new ApiError(
        'RANKING_NOT_MEASURED',
        'Nenhum servidor da rede tem janela de ranking aberta — nada foi medido ainda.',
        409,
      );
    }

    return open;
  }

  #requirePeriod(periodId: number): StatPeriod {
    const period = this.#repository.getPeriod(periodId);

    if (period === null) {
      throw new ApiError('RANKING_PERIOD_NOT_FOUND', `Não existe o período ${String(periodId)}.`, 404);
    }

    return period;
  }

  /**
   * A lista de uma temporada FECHADA vem do pódio congelado.
   *
   * O valor de lá não muda mais — pode ser cacheado sem prazo — e
   * é essa a diferença que faz o histórico responder amanhã o que
   * responde hoje.
   */
  async #frozenLeaderboard(
    ranking: RankingRecord,
    query: LeaderboardQuery,
    periodId: number,
  ): Promise<LeaderboardResult> {
    const period = this.#requirePeriod(periodId);

    if (period.endedAt === null) {
      // Período ainda aberto: a fonte é o contador vivo, e não o
      // congelado (que nem existe).
      const page =
        ranking.valueKind === 'ratio'
          ? this.#ratioPage(ranking, [period], query.limit, query.offset)
          : this.#counterPage(ranking, [period], 'server', period.kind, [period.serverId], query);

      return {
        ranking,
        scope: 'server',
        period: this.#periodView([period], period.kind, 'server'),
        frozen: false,
        entries: page.entries,
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        measuredSince: period.startedAt,
        updatedAt: this.#repository.lastBatchAt([period.serverId]),
        coverage: await this.#coverage.coverageOf([period.serverId]),
      };
    }

    const frozen = this.#repository.snapshotOf(periodId, ranking.metric);
    const page = frozen.slice(query.offset, query.offset + query.limit);

    return {
      ranking,
      scope: 'server',
      period: this.#periodView([period], period.kind, 'server'),
      frozen: true,
      entries: page.map((row) => ({
        position: row.position,
        steamId: row.steamId,
        name: row.displayName,
        value: row.value,
        updatedAt: row.frozenAt,
      })),
      total: frozen.length,
      limit: query.limit,
      offset: query.offset,
      measuredSince: period.startedAt,
      updatedAt: period.endedAt,
      coverage: await this.#coverage.coverageOf([period.serverId]),
    };
  }

  #counterPage(
    ranking: RankingRecord,
    periods: readonly StatPeriod[],
    scope: RankingScope,
    kind: PeriodKind,
    serverIds: readonly string[],
    query: LeaderboardQuery,
  ): { readonly entries: readonly RankingEntry[]; readonly total: number } {
    if (ranking.valueKind === 'record') {
      const page = this.#recordsPage(ranking, periods, query.limit, query.offset);

      return {
        entries: page.entries.map((entry) => ({
          position: entry.position,
          steamId: entry.steamId,
          name: entry.name,
          value: entry.value,
          updatedAt: entry.at * 1000,
        })),
        total: page.total,
      };
    }

    if (scope === 'global') {
      return this.#repository.globalTop({
        metric: ranking.metric,
        kind,
        serverIds,
        limit: query.limit,
        offset: query.offset,
        direction: ranking.direction,
      });
    }

    const period = periods[0];

    if (period === undefined) {
      return { entries: [], total: 0 };
    }

    return this.#repository.topOf({
      periodId: period.id,
      metric: ranking.metric,
      limit: query.limit,
      offset: query.offset,
      direction: ranking.direction,
    });
  }

  /**
   * Os recordes de uma ou várias janelas.
   *
   * Na rede, o melhor de cada jogador entre os servidores — e não
   * a soma, que não faria sentido nenhum para "o tiro mais longo".
   */
  #recordsPage(
    ranking: RankingRecord,
    periods: readonly StatPeriod[],
    limit: number,
    offset: number,
  ): { readonly entries: readonly RecordEntry[]; readonly total: number } {
    if (periods.length === 1) {
      const period = periods[0];

      if (period === undefined) {
        return { entries: [], total: 0 };
      }

      return this.#repository.topRecordsOf({
        periodId: period.id,
        metric: ranking.metric,
        limit,
        offset,
        direction: ranking.direction,
      });
    }

    const best = new Map<string, RecordEntry>();

    for (const period of periods) {
      // Uma página grande por servidor, e não a tabela inteira: o
      // pódio da rede não precisa do 900º melhor tiro de cada um.
      const page = this.#repository.topRecordsOf({
        periodId: period.id,
        metric: ranking.metric,
        limit: offset + limit,
        offset: 0,
        direction: ranking.direction,
      });

      for (const entry of page.entries) {
        const current = best.get(entry.steamId);

        if (current === undefined || isBetter(entry.value, current.value, ranking.direction)) {
          best.set(entry.steamId, entry);
        }
      }
    }

    const sorted = [...best.values()].sort((a, b) =>
      compareEntries(
        { value: a.value, updatedAt: a.at, steamId: a.steamId },
        { value: b.value, updatedAt: b.at, steamId: b.steamId },
        ranking.direction,
      ),
    );

    return {
      entries: sorted
        .slice(offset, offset + limit)
        .map((entry, index) => ({ ...entry, position: offset + index + 1 })),
      total: sorted.length,
    };
  }

  /**
   * O K/D, calculado na leitura.
   *
   * ####  A MÉDIA DA POPULAÇÃO SAI DA PRÓPRIA JANELA  ####
   *
   * `m` é o K/D médio de quem jogou naquele período — que é ≈ 1,0
   * por construção (todo abate é a morte de alguém), mas não
   * exatamente: mortes para NPC e queda não contam como abate de
   * ninguém. Medi-la em vez de fixá-la em 1 faz o encolhimento
   * continuar honesto num servidor de PvE pesado.
   */
  #kdRows(periodIds: readonly number[]): readonly {
    readonly steamId: string;
    readonly name: string | null;
    readonly value: number;
    readonly updatedAt: number;
    readonly eligible: boolean;
  }[] {
    const sums = this.#repository.sumByPlayer({
      periodIds,
      metrics: [KD_KILLS_METRIC, KD_DEATHS_METRIC],
    });

    let totalKills = 0;
    let totalDeaths = 0;

    for (const row of sums) {
      totalKills += row.values[KD_KILLS_METRIC] ?? 0;
      totalDeaths += row.values[KD_DEATHS_METRIC] ?? 0;
    }

    const mean = totalDeaths > 0 ? totalKills / totalDeaths : 1;

    return sums
      .map((row) => {
        const kills = row.values[KD_KILLS_METRIC] ?? 0;
        const deaths = row.values[KD_DEATHS_METRIC] ?? 0;

        return {
          steamId: row.steamId,
          name: row.name,
          value: shrunkKd(kills, deaths, mean),
          updatedAt: row.updatedAt,
          eligible: deaths >= KD_MIN_DEATHS || kills >= KD_MIN_KILLS,
        };
      })
      .sort((a, b) => compareEntries(a, b, 'desc'));
  }

  #ratioPage(
    ranking: RankingRecord,
    periods: readonly StatPeriod[],
    limit: number,
    offset: number,
  ): { readonly entries: readonly RankingEntry[]; readonly total: number } {
    if (ranking.metric !== 'pvp.kd') {
      return { entries: [], total: 0 };
    }

    const rows = this.#kdRows(periods.map((period) => period.id)).filter((row) => row.eligible);

    return {
      entries: rows.slice(offset, offset + limit).map((row, index) => ({
        position: offset + index + 1,
        steamId: row.steamId,
        name: row.name,
        value: row.value,
        updatedAt: row.updatedAt,
      })),
      total: rows.length,
    };
  }

  #positionIn(
    ranking: RankingRecord,
    periods: readonly StatPeriod[],
    scope: RankingScope,
    steamId: string,
  ): { readonly position: number | null; readonly value: number | null; readonly total: number } {
    if (ranking.valueKind === 'ratio') {
      const rows = this.#kdRows(periods.map((period) => period.id));
      const eligible = rows.filter((row) => row.eligible);
      const index = eligible.findIndex((row) => row.steamId === steamId);
      const mine = rows.find((row) => row.steamId === steamId);

      return {
        position: index === -1 ? null : index + 1,
        value: mine?.value ?? null,
        total: eligible.length,
      };
    }

    if (ranking.valueKind === 'record') {
      const page = this.#recordsPage(ranking, periods, Number.MAX_SAFE_INTEGER, 0);
      const index = page.entries.findIndex((entry) => entry.steamId === steamId);

      return {
        position: index === -1 ? null : index + 1,
        value: index === -1 ? null : (page.entries[index]?.value ?? null),
        total: page.total,
      };
    }

    const found: PlayerPosition | null =
      scope === 'global'
        ? this.#repository.globalPositionOf({
            steamId,
            metric: ranking.metric,
            kind: ranking.window,
            serverIds: periods.map((period) => period.serverId),
            direction: ranking.direction,
          })
        : this.#positionInPeriod(ranking, periods, steamId);

    return {
      position: found?.position ?? null,
      value: found?.value ?? null,
      total: found?.total ?? 0,
    };
  }

  #positionInPeriod(
    ranking: RankingRecord,
    periods: readonly StatPeriod[],
    steamId: string,
  ): PlayerPosition | null {
    const period = periods[0];

    if (period === undefined) {
      return null;
    }

    return this.#repository.positionOf({
      steamId,
      periodId: period.id,
      metric: ranking.metric,
      direction: ranking.direction,
    });
  }

  #periodView(periods: readonly StatPeriod[], kind: PeriodKind, scope: RankingScope): PeriodView {
    const single = scope === 'server' ? periods[0] : undefined;

    if (single === undefined) {
      return {
        id: null,
        kind,
        serverId: null,
        label: null,
        startedAt: measuredSinceOf(periods),
        endedAt: null,
        seasonMode: null,
        turnsAt: null,
      };
    }

    const settings = this.#repository.settingsOf(single.serverId);

    return {
      id: single.id,
      kind: single.kind,
      serverId: single.serverId,
      label: single.label,
      startedAt: single.startedAt,
      endedAt: single.endedAt,
      seasonMode: single.seasonMode,
      turnsAt:
        single.kind === 'season'
          ? nextSeasonTurnAt({
              seasonMode: single.seasonMode ?? settings.seasonMode,
              startedAt: single.startedAt,
              seasonDays: settings.seasonDays,
              seasonAnchorAt: settings.seasonAnchorAt,
              ...(this.#timeZone === undefined ? {} : { timeZone: this.#timeZone }),
            })
          : null,
    };
  }
}

// ------------------------------------------------------------
//  Ordenação
// ------------------------------------------------------------

/**
 * Os três critérios do §9.3, agora em memória.
 *
 * Eles precisam ser os MESMOS do SQL: uma lista calculada aqui
 * (K/D, recorde de rede) que ordenasse diferente da lista vinda do
 * banco faria a ficha do jogador discordar do pódio, e ninguém
 * saberia qual das duas está certa.
 */
function compareEntries(
  a: { readonly value: number; readonly updatedAt: number; readonly steamId: string },
  b: { readonly value: number; readonly updatedAt: number; readonly steamId: string },
  direction: RankingDirection,
): number {
  if (a.value !== b.value) {
    return direction === 'asc' ? a.value - b.value : b.value - a.value;
  }

  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt - b.updatedAt;
  }

  return a.steamId < b.steamId ? -1 : a.steamId > b.steamId ? 1 : 0;
}

function isBetter(candidate: number, current: number, direction: RankingDirection): boolean {
  return direction === 'asc' ? candidate < current : candidate > current;
}

/**
 * Desde quando aquilo é medido.
 *
 * Na rede, a janela mais ANTIGA: dizer "desde ontem" porque um
 * servidor entrou ontem esconderia que os outros medem há meses.
 */
function measuredSinceOf(periods: readonly StatPeriod[]): number | null {
  let oldest: number | null = null;

  for (const period of periods) {
    if (oldest === null || period.startedAt < oldest) {
      oldest = period.startedAt;
    }
  }

  return oldest;
}
