// ============================================================
//  rankings-repository.ts  -  o ranking, do lado do banco.
//
//  ####  ELE GUARDA TRÊS COISAS QUE PARECEM UMA  ####
//
//    1. o CATÁLOGO (`rankings`) — quais rankings existem;
//    2. a JANELA (`stat_periods`) — em que fatia de tempo o
//       número está sendo contado;
//    3. o NÚMERO (`player_stats`, `player_records`).
//
//  Um ranking "fixo" e um "dinâmico" são a MESMA linha do
//  catálogo: a única diferença é a coluna `builtin`, que decide se
//  o botão de apagar aparece no painel. É essa escolha que faz o
//  Troféu Bleik custar uma linha em vez de um módulo — ver
//  Docs/Ranking/20-PLANO-E-CONTRATOS.md §1.
//
//  ------------------------------------------------------------
//  ####  AQUI NÃO SE CALCULA NADA: SÓ SE GUARDA  ####
//
//  O K/D com encolhimento, a resolução de escopo, o `coverage` e a
//  validação da métrica moram em `rankings/service.ts`. Este
//  arquivo é SQL: quem quiser saber por que uma coluna existe lê a
//  migração 033/034; quem quiser saber por que uma REGRA existe lê
//  o serviço.
//
//  ------------------------------------------------------------
//  ####  A ORDENAÇÃO TEM TRÊS CRITÉRIOS, E O TERCEIRO NÃO É
//        PRECIOSISMO  ####
//
//    1. o valor, na `direction` do ranking;
//    2. quem chegou primeiro àquele valor (`updated_at` asc);
//    3. `steam_id` ascendente.
//
//  Sem o terceiro, dois jogadores empatados trocam de lugar entre
//  a página 1 e a página 2 e um deles SOME da lista. É o defeito
//  clássico de paginação sem ordem total, e ele só aparece em
//  produção — o mesmo que o `players-repository` já paga com o
//  desempate por `steam_id`.
// ============================================================

import { ApiError } from '../http/error-response.js';
import type { AgentDatabase } from './database.js';

// ------------------------------------------------------------
//  Vocabulário
// ------------------------------------------------------------

/** De onde o número vem. Ver a migração 034. */
export type RankingSource = 'plugin' | 'agent' | 'item' | 'computed';

/** Onde o número mora: contador, recorde ou razão calculada. */
export type RankingValueKind = 'counter' | 'record' | 'ratio';

export type RankingDirection = 'desc' | 'asc';

/** O papel da janela. O TAMANHO dela é o `seasonMode`. */
export type PeriodKind = 'wipe' | 'season' | 'lifetime';

/**
 * Em que janela um ranking DISPUTA.
 *
 * É o mesmo conjunto do `PeriodKind` porque é a mesma coisa vista
 * do outro lado: o período é a janela que existe, e esta é a
 * janela que aquele ranking escolheu como sua.
 */
export type RankingWindow = PeriodKind;

export type SeasonMode = 'wipe' | 'biweekly' | 'monthly' | 'quarterly' | 'days' | 'manual';

export type RecordStatus = 'ok' | 'suspect' | 'void';

/** Por qual dos dois caminhos o evento chegou primeiro. */
export type StatEventVia = 'push' | 'flush';

export type AdjustmentAction = 'reset' | 'set' | 'void_record' | 'grant';

/**
 * Os três papéis de janela, na ordem em que o coletor os abre.
 *
 * `lifetime` por último de propósito: ele é o único que nunca
 * fecha, e ler a lista de cima para baixo conta a história certa —
 * do mais curto para o mais longo.
 */
export const PERIOD_KINDS: readonly PeriodKind[] = ['wipe', 'season', 'lifetime'];

/**
 * O que vale num servidor sem linha em `ranking_settings`.
 *
 * O padrão mora AQUI, e não numa linha semeada por servidor: um
 * servidor criado depois da migração 034 ficaria sem a linha, e o
 * código teria de saber o padrão de qualquer jeito. Duas fontes
 * para a mesma resposta é o que o 02-ARQUITETURA proíbe.
 */
export const DEFAULT_RANKING_SETTINGS: RankingSettings = {
  seasonMode: 'monthly',
  seasonDays: null,
  seasonAnchorAt: null,
  seasonOnWipe: false,
  snapshotSize: 50,
  updatedAt: null,
};

// ------------------------------------------------------------
//  Os tipos do domínio
// ------------------------------------------------------------

/** A definição de um ranking. */
export interface RankingRecord {
  readonly id: string;
  readonly metric: string;
  readonly label: string;
  /**
   * O nome que cabe na aba do jogo. `null` = use o `label`.
   *
   * Ele existe porque a coluna da tela do jogo é estreita, e a
   * abreviação feita por causa DELA não pode vazar para o painel e
   * para o site — ver a migração 044.
   */
  readonly shortLabel: string | null;
  readonly unit: string | null;
  readonly description: string | null;
  readonly source: RankingSource;
  readonly valueKind: RankingValueKind;
  readonly direction: RankingDirection;
  /**
   * Em que janela ele disputa — e, portanto, qual virada o zera
   * aos olhos de quem joga.
   *
   * Ela NÃO muda a escrita: o número continua somando nas três
   * janelas abertas. Ela diz qual delas a tela abre por padrão.
   */
  readonly window: RankingWindow;
  /** Entra na soma da rede? 0 para minério e explosivo. */
  readonly globalEligible: boolean;
  /** Veio semeado pela migração 034 — o admin não apaga. */
  readonly builtin: boolean;
  readonly enabled: boolean;
  /**
   * Aparece no menu do jogo?
   *
   * Diferente do `enabled`: desligar o ranking o tira de todo
   * lugar; isto o tira só do menu do jogo, onde o espaço é caro. O
   * número continua sendo contado, e o site continua mostrando.
   */
  readonly showInGame: boolean;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RankingInput {
  readonly id: string;
  readonly metric: string;
  readonly label: string;
  /** Ausente, `null` ou vazio = a aba do jogo usa o `label`. */
  readonly shortLabel?: string | null;
  readonly unit: string | null;
  readonly description: string | null;
  readonly source: RankingSource;
  readonly valueKind: RankingValueKind;
  readonly direction: RankingDirection;
  readonly window: RankingWindow;
  readonly globalEligible: boolean;
  readonly enabled: boolean;
  /** Ausente = `true`. Um ranking novo aparece no menu do jogo. */
  readonly showInGame?: boolean;
  /**
   * A posição na lista.
   *
   * ####  POR QUE ELE É OPCIONAL  ####
   *
   * A ordem se muda **arrastando**, no painel. Um campo de número
   * no cadastro seria um SEGUNDO jeito de fazer a mesma coisa:
   * salvar um ranking com a ordem digitada reordenaria a lista por
   * fora do arrasto, e a partir daí ninguém sabe qual dos dois
   * mandou. É a segunda fonte que o 02-ARQUITETURA já proíbe.
   *
   * Ausente na criação = entra no fim. Quem quiser mudar, arrasta.
   */
  readonly sortOrder?: number;
}

/** A janela: (servidor, papel, começo). */
export interface StatPeriod {
  readonly id: number;
  readonly serverId: string;
  readonly kind: PeriodKind;
  /** A linha de `wipes` que abriu este período, quando houve uma. */
  readonly wipeId: number | null;
  readonly startedAt: number;
  /** `null` = ainda aberto. */
  readonly endedAt: number | null;
  /** Como o modo estava configurado QUANDO o período abriu. */
  readonly seasonMode: SeasonMode | null;
  readonly label: string | null;
}

export interface OpenPeriodInput {
  readonly serverId: string;
  readonly kind: PeriodKind;
  readonly wipeId?: number | null;
  readonly seasonMode?: SeasonMode | null;
  readonly label?: string | null;
  /** Quando a janela começou. Ausente = agora. */
  readonly startedAt?: number;
}

export interface ListPeriodsOptions {
  readonly serverId?: string | undefined;
  readonly kind?: PeriodKind | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ListPeriodsResult {
  readonly periods: readonly StatPeriod[];
  /** Quantos casaram com o filtro ANTES da paginação. */
  readonly total: number;
}

/** A janela configurada de um servidor. */
export interface RankingSettings {
  readonly seasonMode: SeasonMode;
  readonly seasonDays: number | null;
  readonly seasonAnchorAt: number | null;
  /**
   * A temporada TAMBÉM vira quando o mundo vira?
   *
   * Diferente de `seasonMode === 'wipe'`: o modo diz que a
   * temporada É o wipe (uma por mundo); isto diz que a temporada
   * mensal, ou de 15 dias, também vira quando o mapa troca.
   */
  readonly seasonOnWipe: boolean;
  readonly snapshotSize: number;
  /** `null` = o servidor nunca foi configurado; valem os padrões. */
  readonly updatedAt: number | null;
}

export interface RankingSettingsInput {
  readonly seasonMode: SeasonMode;
  readonly seasonDays?: number | null;
  readonly seasonAnchorAt?: number | null;
  readonly seasonOnWipe?: boolean;
  readonly snapshotSize?: number;
}

// ---- o lote --------------------------------------------------

/** Um jogador do lote, com os contadores que ele acumulou. */
export interface StatBatchPlayer {
  readonly steamId: string;
  readonly name?: string | null;
  /** `{ 'ore.sulfur': 1200, 'pvp.kills': 3 }` — sempre DELTAS. */
  readonly metrics: Readonly<Record<string, number>>;
}

/** Um fato com testemunho: o tiro longo, e o que vier depois. */
export interface StatBatchRecord {
  readonly steamId: string;
  readonly name?: string | null;
  readonly metric: string;
  readonly value: number;
  /** Epoch em SEGUNDOS, relógio do servidor de jogo. */
  readonly at: number;
  readonly detail?: unknown;
  readonly status?: RecordStatus;
}

/** Um evento pontual: o troféu convertido, a medalha concedida. */
export interface StatEventInput {
  /** Gerado pelo PLUGIN. É a chave da idempotência. */
  readonly eventId: string;
  readonly serverId: string;
  readonly steamId: string;
  readonly name?: string | null;
  readonly metric: string;
  /** Já multiplicado pelos pontos por unidade. */
  readonly amount: number;
  readonly source?: string | null;
  /** Epoch em SEGUNDOS, relógio do servidor de jogo. */
  readonly at: number;
  readonly via: StatEventVia;
}

export interface StatBatchInput {
  readonly serverId: string;
  readonly batchId: string;
  readonly seq: number;
  readonly players: readonly StatBatchPlayer[];
  readonly records?: readonly StatBatchRecord[];
  readonly events?: readonly Omit<StatEventInput, 'serverId' | 'via'>[];
  /**
   * Em quais janelas somar. Ausente = os períodos abertos daquele
   * servidor, abrindo os que faltarem.
   */
  readonly periodIds?: readonly number[];
  /** O modo com que abrir um `season` que ainda não existe. */
  readonly seasonMode?: SeasonMode;
}

export interface ApplyBatchResult {
  /** `false` = este `batchId` já tinha sido aplicado. */
  readonly applied: boolean;
  readonly periodIds: readonly number[];
  readonly playersTouched: number;
  /** Quantos eventos entraram AGORA (os repetidos não contam). */
  readonly eventsApplied: number;
  readonly recordsInserted: number;
}

export interface ApplyEventResult {
  /** `false` = este `eventId` já tinha sido visto. */
  readonly applied: boolean;
  readonly periodIds: readonly number[];
}

// ---- a leitura -----------------------------------------------

export interface TopQuery {
  readonly periodId: number;
  readonly metric: string;
  readonly limit: number;
  readonly offset: number;
  readonly direction?: RankingDirection;
}

export interface GlobalTopQuery {
  readonly metric: string;
  readonly kind: PeriodKind;
  /** Ausente = todos os servidores que têm período aberto. */
  readonly serverIds?: readonly string[] | undefined;
  readonly limit: number;
  readonly offset: number;
  readonly direction?: RankingDirection;
}

/** Uma linha da lista, já com a colocação calculada. */
export interface RankingEntry {
  readonly position: number;
  readonly steamId: string;
  /** `null` quando o jogador saiu da base (o snapshot preserva). */
  readonly name: string | null;
  readonly value: number;
  readonly updatedAt: number;
}

export interface RankingEntryPage {
  readonly entries: readonly RankingEntry[];
  /** Quantos jogadores têm número naquela métrica, antes da página. */
  readonly total: number;
}

/** Uma linha da lista de recordes, com o testemunho junto. */
export interface RecordEntry {
  readonly position: number;
  readonly steamId: string;
  readonly name: string | null;
  readonly value: number;
  /** Epoch em SEGUNDOS, relógio do servidor de jogo. */
  readonly at: number;
  readonly detail: unknown;
}

export interface RecordEntryPage {
  readonly entries: readonly RecordEntry[];
  readonly total: number;
}

/** Onde um jogador está numa lista, sem paginar até achá-lo. */
export interface PlayerPosition {
  readonly position: number;
  readonly value: number;
  readonly total: number;
}

/** O que um jogador somou em várias métricas de uma vez. */
export interface PlayerMetricSums {
  readonly steamId: string;
  readonly name: string | null;
  readonly values: Readonly<Record<string, number>>;
  readonly updatedAt: number;
}

export interface SumByPlayerQuery {
  readonly periodIds: readonly number[];
  readonly metrics: readonly string[];
}

/** Uma linha do pódio congelado. */
export interface SnapshotEntry {
  readonly position: number;
  readonly steamId: string;
  readonly displayName: string | null;
  readonly value: number;
  readonly frozenAt: number;
}

/** Uma linha que o serviço quer ver congelada (K/D e afins). */
export interface PodiumRow {
  readonly steamId: string;
  readonly displayName: string | null;
  readonly value: number;
}

/**
 * Como congelar um ranking que NÃO tem linha em `player_stats`.
 *
 * O K/D é `computed`: ele não existe como número guardado, e o
 * encolhimento que o torna honesto mora no serviço. Sem esta
 * ponte, fechar a temporada congelaria dez rankings e deixaria o
 * décimo primeiro de fora — e a tela do histórico mostraria um
 * buraco que ninguém sabe explicar.
 *
 * Síncrona de propósito: ela roda DENTRO da transação que fecha o
 * período, e um `await` ali abriria a janela que a transação
 * existe para fechar.
 */
export type ComputedPodium = (
  ranking: RankingRecord,
  periodId: number,
  size: number,
) => readonly PodiumRow[];

export interface RollPeriodInput {
  readonly periodId: number;
  /** Quantas posições congelar. Ver `ranking_settings`. */
  readonly snapshotSize: number;
  /** O modo com que o PRÓXIMO período nasce. */
  readonly nextSeasonMode?: SeasonMode | null;
  readonly nextLabel?: string | null;
  readonly nextWipeId?: number | null;
  /** O instante do corte. Ausente = agora. */
  readonly at?: number;
  readonly computed?: ComputedPodium;
}

export interface RollPeriodResult {
  readonly closed: StatPeriod;
  readonly opened: StatPeriod;
  /** Quantas linhas de pódio foram congeladas. */
  readonly frozen: number;
}

export interface AdjustmentInput {
  readonly periodId: number;
  readonly steamId: string;
  readonly metric?: string | null;
  readonly action: AdjustmentAction;
  readonly oldValue?: number | null;
  readonly newValue?: number | null;
  readonly actor: string;
  readonly reason?: string | null;
}

export interface ResetPlayerInput {
  readonly periodId: number;
  readonly steamId: string;
  /** Ausente = todas as métricas daquele período. */
  readonly metric?: string | null;
  readonly actor: string;
  readonly reason?: string | null;
}

// ------------------------------------------------------------
//  As linhas cruas
// ------------------------------------------------------------

interface RankingRow {
  readonly id: string;
  readonly metric: string;
  readonly label: string;
  readonly short_label: string | null;
  readonly unit: string | null;
  readonly description: string | null;
  readonly source: string;
  readonly value_kind: string;
  readonly direction: string;
  readonly window: string;
  readonly global_eligible: number;
  readonly builtin: number;
  readonly enabled: number;
  readonly show_in_game: number;
  readonly sort_order: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface PeriodRow {
  readonly id: number;
  readonly server_id: string;
  readonly kind: string;
  readonly wipe_id: number | null;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly season_mode: string | null;
  readonly label: string | null;
}

interface SettingsRow {
  readonly season_mode: string;
  readonly season_days: number | null;
  readonly season_anchor_at: number | null;
  readonly season_on_wipe: number;
  readonly snapshot_size: number;
  readonly updated_at: number;
}

interface EntryRow {
  readonly steam_id: string;
  readonly name: string | null;
  readonly value: number;
  readonly updated_at: number;
}

interface RecordRow {
  readonly steam_id: string;
  readonly name: string | null;
  readonly value: number;
  readonly at: number;
  readonly detail: string | null;
}

interface SnapshotRow {
  readonly position: number;
  readonly steam_id: string;
  readonly display_name: string | null;
  readonly value: number;
  readonly frozen_at: number;
}

interface CountRow {
  readonly total: number;
}

const PERIOD_COLUMNS = 'id, server_id, kind, wipe_id, started_at, ended_at, season_mode, label';

/**
 * As aspas em `"window"` não são estilo: `WINDOW` é palavra-chave
 * do SQLite (as funções de janela). Ele hoje aceita a coluna sem
 * elas, e é exatamente esse tipo de tolerância que uma versão
 * seguinte retira.
 */
const RANKING_COLUMNS =
  'id, metric, label, short_label, unit, description, source, value_kind, direction, "window", ' +
  'global_eligible, builtin, enabled, show_in_game, sort_order, created_at, updated_at';

/**
 * O passo entre duas posições do catálogo.
 *
 * Dez, e não um, porque o catálogo semeado já usa 10, 20, 30… (ver
 * a migração 034): quem quiser encaixar um ranking à mão entre
 * dois, por SQL, tem nove números livres para isso sem precisar
 * reescrever a lista inteira.
 */
const SORT_ORDER_STEP = 10;

/**
 * O jogador precisa EXISTIR antes de o contador dele somar.
 *
 * ####  E ISTO NÃO É ZELO: É O QUE SALVA O LOTE INTEIRO  ####
 *
 * `player_stats.steam_id` referencia `players`. Um lote pode
 * trazer alguém que o agente nunca viu — quem entrou e farmou
 * entre duas rodadas de presença. Somar antes de o jogador existir
 * viola a FK e derruba a transação, ou seja: perde o lote de TODO
 * MUNDO por causa de um recém-chegado.
 *
 * ####  POR QUE `INSERT OR IGNORE`, E NÃO O UPSERT DA PRESENÇA
 *
 * `players-repository.recordSightings()` carimba `last_seen` e
 * mexe em `player_servers` — ele descreve o AGORA, e é chamado por
 * quem acabou de ver a lista de online. Um lote descreve o
 * PASSADO: ele traz o que aconteceu nos últimos 60 s, inclusive de
 * quem já desconectou. Reusar o upsert marcaria como "visto agora"
 * quem saiu há um minuto.
 *
 * Então aqui só se garante a EXISTÊNCIA da linha. Quem estiver
 * online de verdade é carimbado pela presença, que é de quem essa
 * resposta é.
 */
const ENSURE_PLAYER = `
INSERT OR IGNORE INTO players (steam_id, name, first_seen, last_seen, last_ip, created_at, updated_at)
     VALUES (@steam_id, @name, @at, @at, NULL, @at, @at)
`;

const UPSERT_STAT = `
INSERT INTO player_stats (period_id, steam_id, metric, value, updated_at)
     VALUES (@period_id, @steam_id, @metric, @delta, @at)
ON CONFLICT (period_id, steam_id, metric) DO UPDATE SET
     value      = player_stats.value + @delta,
     updated_at = @at
`;

export class RankingsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  O catálogo
  // ------------------------------------------------------

  /**
   * Os rankings, na ordem em que aparecem na tela.
   *
   * `enabledOnly` é o que a tela do jogo e o site pedem: um
   * ranking desligado continua no banco, com o número intacto, e
   * só some das telas — a mesma regra do `custom_items.enabled`.
   *
   * `inGameOnly` é só da tela do jogo, e é um filtro DIFERENTE: o
   * ranking escondido do menu continua ligado, continua contando e
   * continua na resposta do painel. Ver a migração 044.
   */
  list(
    options: { readonly enabledOnly?: boolean; readonly inGameOnly?: boolean } = {},
  ): readonly RankingRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT ${RANKING_COLUMNS} FROM rankings
          WHERE (@enabled_only = 0 OR enabled = 1)
            AND (@in_game_only = 0 OR show_in_game = 1)
          ORDER BY sort_order ASC, id ASC`,
      )
      .all({
        enabled_only: options.enabledOnly === true ? 1 : 0,
        in_game_only: options.inGameOnly === true ? 1 : 0,
      }) as RankingRow[];

    return rows.map(toRanking);
  }

  get(id: string): RankingRecord | null {
    const row = this.#db
      .prepare(`SELECT ${RANKING_COLUMNS} FROM rankings WHERE id = @id`)
      .get({ id }) as RankingRow | undefined;

    return row === undefined ? null : toRanking(row);
  }

  /**
   * O ranking daquela métrica.
   *
   * É por aqui que a borda decide se `metric=ore.sulfur` é uma
   * pergunta legítima: métrica fora do catálogo é
   * `RANKING_METRIC_UNKNOWN`, e não lista vazia. "Zero" e "não
   * existe" são respostas diferentes.
   */
  getByMetric(metric: string): RankingRecord | null {
    const row = this.#db
      .prepare(`SELECT ${RANKING_COLUMNS} FROM rankings WHERE metric = @metric`)
      .get({ metric }) as RankingRow | undefined;

    return row === undefined ? null : toRanking(row);
  }

  /**
   * A ordem de quem entra agora: depois do último.
   *
   * Catálogo vazio devolve o primeiro degrau, e não zero — assim
   * toda linha da tabela segue o mesmo passo, e a reordenação
   * (que reescreve 10, 20, 30…) não precisa de um caso especial
   * para a primeira.
   */
  #nextSortOrder(): number {
    const row = this.#db.prepare('SELECT MAX(sort_order) AS last FROM rankings').get() as {
      last: number | null;
    };

    return (row.last ?? 0) + SORT_ORDER_STEP;
  }

  /**
   * Cria um ranking dinâmico. Ele nasce com `builtin = 0`.
   *
   * @throws `RANKING_METRIC_TAKEN` quando a métrica já tem dono.
   *         Dois rankings sobre a mesma métrica seriam a mesma
   *         lista com dois nomes.
   */
  create(input: RankingInput, now: number = Date.now()): RankingRecord {
    if (this.get(input.id) !== null) {
      throw new ApiError(
        'RANKING_METRIC_TAKEN',
        `Já existe um ranking com o identificador "${input.id}".`,
        409,
      );
    }

    const owner = this.getByMetric(input.metric);

    if (owner !== null) {
      throw new ApiError(
        'RANKING_METRIC_TAKEN',
        `A métrica "${input.metric}" já é do ranking "${owner.label}".`,
        409,
      );
    }

    this.#db
      .prepare(
        `INSERT INTO rankings
           (id, metric, label, short_label, unit, description, source, value_kind, direction,
            "window", global_eligible, builtin, enabled, show_in_game, sort_order,
            created_at, updated_at)
         VALUES
           (@id, @metric, @label, @short_label, @unit, @description, @source, @value_kind,
            @direction, @window, @global_eligible, 0, @enabled, @show_in_game, @sort_order,
            @created_at, @updated_at)`,
      )
      .run({
        ...toRankingColumns(input),
        // Sem ordem declarada, ele entra no FIM — nunca no meio.
        // Um ranking novo que caísse entre dois já existentes
        // mudaria a coluna do menu do jogo de quem não pediu nada.
        sort_order: input.sortOrder ?? this.#nextSortOrder(),
        created_at: now,
        updated_at: now,
      });

    const saved = this.get(input.id);

    if (saved === null) {
      throw new Error(`o ranking "${input.id}" sumiu logo depois de ser gravado`);
    }

    return saved;
  }

  /**
   * Reescreve o ranking inteiro. PUT, e não PATCH — mesma regra do
   * cadastro de item custom: a tela edita num formulário só.
   *
   * ####  UM `builtin` NÃO TROCA DE MÉTRICA  ####
   *
   * Editar o rótulo, a descrição ou a ordem de um ranking semeado
   * é uso normal. Trocar a MÉTRICA dele é outra coisa: o número
   * guardado continua sob a chave antiga, e a lista ficaria vazia
   * sem que nada tivesse sido apagado — o pior defeito possível,
   * porque parece perda de dado.
   *
   * @returns `null` quando o id não existe.
   */
  update(id: string, input: RankingInput, now: number = Date.now()): RankingRecord | null {
    const current = this.get(id);

    if (current === null) {
      return null;
    }

    if (current.builtin && input.metric !== current.metric) {
      throw new ApiError(
        'RANKING_BUILTIN_LOCKED',
        `O ranking "${current.label}" veio com o agente e não pode trocar de métrica — ` +
          'o número já contado continuaria sob a métrica antiga.',
        409,
      );
    }

    const owner = this.getByMetric(input.metric);

    if (owner !== null && owner.id !== id) {
      throw new ApiError(
        'RANKING_METRIC_TAKEN',
        `A métrica "${input.metric}" já é do ranking "${owner.label}".`,
        409,
      );
    }

    this.#db
      .prepare(
        `UPDATE rankings SET
           metric          = @metric,
           label           = @label,
           short_label     = @short_label,
           unit            = @unit,
           description     = @description,
           source          = @source,
           value_kind      = @value_kind,
           direction       = @direction,
           "window"        = @window,
           global_eligible = @global_eligible,
           enabled         = @enabled,
           show_in_game    = @show_in_game,
           sort_order      = @sort_order,
           updated_at      = @updated_at
         WHERE id = @current_id`,
      )
      .run({
        ...toRankingColumns(input),
        // Editar um ranking NÃO mexe na ordem: ela é do arrasto.
        // Sem esta linha, salvar "desligar" mandaria de volta o
        // `sortOrder` que a tela tinha carregado — e desfaria um
        // arrasto feito no intervalo, sem ninguém tocar em ordem.
        sort_order: input.sortOrder ?? current.sortOrder,
        current_id: id,
        updated_at: now,
      });

    // O `id` NÃO muda junto com o rótulo: renomear um ranking no
    // painel não pode quebrar o item custom que aponta para ele.
    // Mesma regra do cadastro de itens.
    return this.get(id);
  }

  /**
   * Apaga um ranking dinâmico.
   *
   * ####  O `builtin` NÃO SAI, E O BOTÃO NEM APARECE  ####
   *
   * Apagar "abates" deixaria o número contado sem definição: as
   * linhas de `player_stats` continuariam lá, invisíveis, e a
   * primeira coleta seguinte voltaria a somá-las sem que nada as
   * mostrasse. A recusa é do banco de dados para cima, e o painel
   * some com o botão em vez de desabilitá-lo.
   *
   * Quem apontar para o ranking (um item custom com ação `points`)
   * é problema da ROTA — ela é quem sabe perguntar ao cadastro de
   * itens, e a resposta dela é `RANKING_IN_USE`.
   *
   * @returns `false` quando o id não existe.
   * @throws `RANKING_BUILTIN_LOCKED`
   */
  remove(id: string): boolean {
    const current = this.get(id);

    if (current === null) {
      return false;
    }

    if (current.builtin) {
      throw new ApiError(
        'RANKING_BUILTIN_LOCKED',
        `O ranking "${current.label}" veio com o agente e não pode ser apagado. ` +
          'Desligue-o se quiser tirá-lo das telas.',
        409,
      );
    }

    return this.#db.prepare('DELETE FROM rankings WHERE id = @id').run({ id }).changes > 0;
  }

  /**
   * Reescreve a ordem do catálogo inteiro, numa transação só.
   *
   * ####  A LISTA VEM INTEIRA, E É POR ISSO QUE ELA É CONFERIDA
   *
   * A tela arrasta e solta, e manda de volta a ordem que ficou.
   * Uma lista PARCIAL — porque a tela filtrava, porque alguém
   * criou um ranking noutra aba enquanto isto era arrastado —
   * deixaria os ausentes com a ordem antiga misturada à nova: dois
   * rankings no mesmo número, e a posição deles passando a
   * depender do desempate por `id`. O defeito não apareceria
   * agora; apareceria na próxima vez que alguém abrisse a tela, e
   * ninguém ligaria uma coisa à outra.
   *
   * Recusar com nome é dizer, na hora, que a tela está olhando
   * para um catálogo que já mudou.
   *
   * ####  SÓ QUEM MUDOU DE LUGAR É CARIMBADO  ####
   *
   * O `WHERE sort_order <> @sort_order` evita reescrever
   * `updated_at` de onze rankings porque dois trocaram de posição.
   * `updated_at` responde "quando esta definição mudou", e mover
   * o vizinho não é uma mudança nesta.
   *
   * @throws `RANKING_ORDER_MISMATCH` — lista parcial, com id
   *         repetido ou com id que não existe.
   */
  reorder(ids: readonly string[], now: number = Date.now()): readonly RankingRecord[] {
    const run = this.#db.transaction((): readonly RankingRecord[] => {
      const current = this.list();
      const existing = new Set(current.map((ranking) => ranking.id));
      const wanted = new Set(ids);

      if (wanted.size !== ids.length) {
        const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);

        throw new ApiError(
          'RANKING_ORDER_MISMATCH',
          `A ordem veio com o mesmo ranking mais de uma vez: ${[...new Set(repeated)].join(', ')}.`,
          400,
        );
      }

      const unknown = ids.filter((id) => !existing.has(id));

      if (unknown.length > 0) {
        throw new ApiError(
          'RANKING_ORDER_MISMATCH',
          `A ordem cita rankings que não existem: ${unknown.join(', ')}. Recarregue a tela.`,
          400,
        );
      }

      const missing = current.filter((ranking) => !wanted.has(ranking.id));

      if (missing.length > 0) {
        throw new ApiError(
          'RANKING_ORDER_MISMATCH',
          'A ordem tem de trazer TODOS os rankings: ficaram de fora ' +
            `${missing.map((ranking) => ranking.id).join(', ')}. Sem eles, a posição desses ` +
            'ficaria indefinida e a lista mudaria sozinha na próxima vez que a tela abrisse.',
          400,
        );
      }

      const move = this.#db.prepare(
        `UPDATE rankings SET sort_order = @sort_order, updated_at = @updated_at
          WHERE id = @id AND sort_order <> @sort_order`,
      );

      for (const [index, id] of ids.entries()) {
        move.run({ id, sort_order: (index + 1) * SORT_ORDER_STEP, updated_at: now });
      }

      return this.list();
    });

    return run();
  }

  // ------------------------------------------------------
  //  As janelas
  // ------------------------------------------------------

  /**
   * Abre um período.
   *
   * ####  ELE É ESTRITO DE PROPÓSITO  ####
   *
   * Se já houver um período aberto daquele (servidor, papel), o
   * índice único parcial `idx_stat_periods_open` recusa, e o erro
   * sobe. Quem quer "abre se não houver" chama `ensureOpenPeriod`
   * — são perguntas diferentes, e confundi-las esconderia a única
   * falha que importa aqui: dois períodos abertos com pódios
   * diferentes e a tela sem saber qual é "o" ranking.
   */
  openPeriod(input: OpenPeriodInput, now: number = Date.now()): StatPeriod {
    const startedAt = input.startedAt ?? now;

    const result = this.#db
      .prepare(
        `INSERT INTO stat_periods (server_id, kind, wipe_id, started_at, ended_at, season_mode, label)
              VALUES (@server_id, @kind, @wipe_id, @started_at, NULL, @season_mode, @label)`,
      )
      .run({
        server_id: input.serverId,
        kind: input.kind,
        wipe_id: input.wipeId ?? null,
        started_at: startedAt,
        season_mode: input.seasonMode ?? null,
        label: input.label ?? null,
      });

    const saved = this.getPeriod(Number(result.lastInsertRowid));

    if (saved === null) {
      throw new Error(
        `o período ${input.kind} do servidor "${input.serverId}" sumiu entre a escrita e a leitura`,
      );
    }

    return saved;
  }

  /** O período aberto, ou o que abriu agora. Idempotente. */
  ensureOpenPeriod(input: OpenPeriodInput, now: number = Date.now()): StatPeriod {
    return this.openPeriodOf(input.serverId, input.kind) ?? this.openPeriod(input, now);
  }

  /**
   * Os três períodos abertos daquele servidor, abrindo o que
   * faltar.
   *
   * ####  POR QUE A PRIMEIRA COLETA ABRE OS TRÊS  ####
   *
   * Um lote que chega e não acha onde somar é dado perdido — e
   * perdido em silêncio, que é o pior jeito. O `lifetime` "abre na
   * primeira coleta" por definição; o `wipe` e o `season` também
   * precisam existir antes do primeiro golpe de picareta, senão o
   * primeiro minuto de cada servidor novo não conta para ninguém.
   *
   * A virada deles continua sendo decidida por quem sabe —
   * `rankings/periods.ts` —, e não aqui.
   */
  ensureOpenPeriods(
    serverId: string,
    seasonMode: SeasonMode,
    now: number = Date.now(),
  ): readonly StatPeriod[] {
    const run = this.#db.transaction((): readonly StatPeriod[] =>
      PERIOD_KINDS.map((kind) =>
        this.ensureOpenPeriod(
          {
            serverId,
            kind,
            // O modo só descreve a temporada. Guardá-lo no `wipe` e
            // no `lifetime` diria que aquela janela tem tamanho
            // configurável, e ela não tem.
            seasonMode: kind === 'season' ? seasonMode : null,
          },
          now,
        ),
      ),
    );

    return run();
  }

  /**
   * O valor de UMA métrica de UM jogador num período.
   *
   * ####  ELE EXISTE PARA AS QUESTS  ####
   *
   * O objetivo de quest do tipo `metric` mede "quanto subiu desde
   * o aceite", e a conta é `total agora - total no aceite`. Sem
   * este método, quem quisesse o número teria de montar uma
   * consulta de leaderboard e procurar o jogador nela — pagando
   * uma ordenação de milhares de linhas para ler uma.
   *
   * `0` quando aquilo nunca foi medido: ausência de linha é zero
   * aqui, e não "não sei". A distinção que importa no ranking (o
   * `coverage`) não importa numa subtração — o que não subiu não
   * conta, tenha sido por não jogar ou por não haver coleta.
   */
  valueOf(periodId: number, steamId: string, metric: string): number {
    const row = this.#db
      .prepare(
        `SELECT value FROM player_stats
          WHERE period_id = @period_id AND steam_id = @steam_id AND metric = @metric`,
      )
      .get({ period_id: periodId, steam_id: steamId, metric }) as { value: number } | undefined;

    return row?.value ?? 0;
  }

  openPeriodOf(serverId: string, kind: PeriodKind): StatPeriod | null {
    const row = this.#db
      .prepare(
        `SELECT ${PERIOD_COLUMNS} FROM stat_periods
          WHERE server_id = @server_id AND kind = @kind AND ended_at IS NULL`,
      )
      .get({ server_id: serverId, kind }) as PeriodRow | undefined;

    return row === undefined ? null : toPeriod(row);
  }

  /** Os períodos abertos daquele papel, em vários servidores. */
  openPeriodsOf(kind: PeriodKind, serverIds?: readonly string[]): readonly StatPeriod[] {
    const scope = buildInClause('s', serverIds);

    const rows = this.#db
      .prepare(
        `SELECT ${PERIOD_COLUMNS} FROM stat_periods
          WHERE kind = @kind AND ended_at IS NULL${scope.sql === '' ? '' : ` AND server_id ${scope.sql}`}
          ORDER BY server_id ASC`,
      )
      .all({ kind, ...scope.params }) as PeriodRow[];

    return rows.map(toPeriod);
  }

  getPeriod(id: number): StatPeriod | null {
    const row = this.#db
      .prepare(`SELECT ${PERIOD_COLUMNS} FROM stat_periods WHERE id = @id`)
      .get({ id }) as PeriodRow | undefined;

    return row === undefined ? null : toPeriod(row);
  }

  /** O histórico: do mais novo para o mais velho. */
  listPeriods(options: ListPeriodsOptions): ListPeriodsResult {
    const filters = {
      server_id: options.serverId ?? null,
      kind: options.kind ?? null,
    };

    const total = (
      this.#db
        .prepare(
          `SELECT count(*) AS total FROM stat_periods
            WHERE (@server_id IS NULL OR server_id = @server_id)
              AND (@kind IS NULL OR kind = @kind)`,
        )
        .get(filters) as CountRow
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT ${PERIOD_COLUMNS} FROM stat_periods
          WHERE (@server_id IS NULL OR server_id = @server_id)
            AND (@kind IS NULL OR kind = @kind)
          ORDER BY started_at DESC, id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...filters, limit: options.limit, offset: options.offset }) as PeriodRow[];

    return { periods: rows.map(toPeriod), total };
  }

  /**
   * Fecha um período, sem abrir o seguinte.
   *
   * Use isto só quando NÃO houver um seguinte (um servidor que
   * saiu do ar). O caminho normal é `rollPeriod`, que fecha e abre
   * na mesma transação — deixar um servidor sem período aberto faz
   * o próximo lote chegar sem onde somar.
   *
   * @throws `RANKING_PERIOD_NOT_FOUND`, `RANKING_PERIOD_CLOSED`
   */
  closePeriod(periodId: number, at: number = Date.now()): StatPeriod {
    const period = this.#requireOpenPeriod(periodId);

    this.#db
      .prepare('UPDATE stat_periods SET ended_at = @at WHERE id = @id')
      .run({ id: period.id, at });

    const closed = this.getPeriod(period.id);

    if (closed === null) {
      throw new Error(`o período ${String(periodId)} sumiu entre a escrita e a leitura`);
    }

    return closed;
  }

  /**
   * A virada, nos cinco passos do §5.4 — e numa transação só.
   *
   * ####  FECHAR SEM ABRIR É PERDER DADO  ####
   *
   * Entre o `ended_at` e o `INSERT` do período seguinte existe um
   * instante em que aquele servidor não tem onde somar. Se a
   * escrita falhar ali, o próximo lote chega e não acha janela
   * nenhuma — e o que se perde não é a virada, é a coleta até
   * alguém perceber. O índice único parcial garante que o passo de
   * abrir nunca produz dois abertos.
   *
   * @throws `RANKING_PERIOD_LIFETIME` — o "de sempre" não vira.
   */
  rollPeriod(input: RollPeriodInput): RollPeriodResult {
    const at = input.at ?? Date.now();

    const run = this.#db.transaction((): RollPeriodResult => {
      const period = this.#requireOpenPeriod(input.periodId);

      if (period.kind === 'lifetime') {
        throw new ApiError(
          'RANKING_PERIOD_LIFETIME',
          'O período "de sempre" não fecha: ele existe justamente para o ranking sobreviver ao wipe.',
          409,
        );
      }

      // 2. congela o pódio ANTES de fechar: as consultas de
      //    congelamento não olham `ended_at`, mas a ordem do
      //    documento é a que se lê num log e faz sentido.
      const frozen = this.freezePodium(period.id, input.snapshotSize, at, input.computed);

      // 3. o corte.
      const closed = this.closePeriod(period.id, at);

      // 4. e o seguinte já nasce aberto.
      const opened = this.openPeriod(
        {
          serverId: period.serverId,
          kind: period.kind,
          wipeId: input.nextWipeId ?? null,
          seasonMode: input.nextSeasonMode ?? period.seasonMode,
          label: input.nextLabel ?? null,
          startedAt: at,
        },
        at,
      );

      return { closed, opened, frozen };
    });

    return run();
  }

  // ------------------------------------------------------
  //  A escrita: o lote e o evento
  // ------------------------------------------------------

  /**
   * Aplica um lote inteiro. Uma transação, e uma só.
   *
   * ####  UMA TRANSAÇÃO POR LOTE, NÃO POR JOGADOR  ####
   *
   * O SQLite com WAL faz trezentos jogadores em milissegundos;
   * trezentas transações separadas fariam disso um problema — e,
   * pior, deixariam o lote pela metade quando a última falhasse.
   *
   * ####  A IDEMPOTÊNCIA É DUPLA, PORQUE OS ERROS SÃO DOIS  ####
   *
   * O `batchId` cobre o `ack` perdido: o plugin remanda o mesmo
   * lote e ele não soma de novo. O `eventId` cobre outra coisa —
   * o mesmo ponto chegando pelo push E pelo lote, em lotes
   * diferentes, onde o `batchId` não ajudaria.
   */
  applyBatch(input: StatBatchInput, now: number = Date.now()): ApplyBatchResult {
    const run = this.#db.transaction((): ApplyBatchResult => {
      const seen = this.#db
        .prepare('SELECT 1 FROM stat_batches WHERE server_id = @server_id AND batch_id = @batch_id')
        .get({ server_id: input.serverId, batch_id: input.batchId });

      if (seen !== undefined) {
        // Já aplicado. Quem chamou dá o `ack` de novo e segue: uma
        // confirmação repetida é barata, um lote em dobro não.
        return {
          applied: false,
          periodIds: [],
          playersTouched: 0,
          eventsApplied: 0,
          recordsInserted: 0,
        };
      }

      const periodIds =
        input.periodIds ??
        this.ensureOpenPeriods(
          input.serverId,
          // Mesma razão do `applyEvent`: sem modo declarado pelo
          // chamador, quem manda é a configuração do servidor — e
          // só na ausência das duas o padrão do código entra.
          input.seasonMode ?? this.settingsOf(input.serverId).seasonMode,
          now,
        ).map((period) => period.id);

      const ensurePlayer = this.#db.prepare(ENSURE_PLAYER);
      const upsert = this.#db.prepare(UPSERT_STAT);

      for (const player of input.players) {
        ensurePlayer.run({ steam_id: player.steamId, name: player.name ?? '', at: now });

        for (const [metric, delta] of Object.entries(player.metrics)) {
          if (!Number.isFinite(delta) || delta === 0) {
            // Zero não é escrita: gravá-lo criaria a linha e
            // carimbaria `updated_at`, o que moveria o jogador no
            // desempate sem ele ter feito nada.
            continue;
          }

          for (const periodId of periodIds) {
            upsert.run({
              period_id: periodId,
              steam_id: player.steamId,
              metric,
              delta: Math.trunc(delta),
              at: now,
            });
          }
        }
      }

      const recordsInserted = this.#insertRecords(input.records ?? [], periodIds, now);

      const eventsApplied = this.#insertEvents(
        (input.events ?? []).map((event) => ({ ...event, serverId: input.serverId, via: 'flush' })),
        periodIds,
        now,
      );

      this.#db
        .prepare(
          `INSERT INTO stat_batches (server_id, batch_id, seq, applied_at, players, events)
                VALUES (@server_id, @batch_id, @seq, @applied_at, @players, @events)`,
        )
        .run({
          server_id: input.serverId,
          batch_id: input.batchId,
          seq: input.seq,
          applied_at: now,
          players: input.players.length,
          events: (input.events ?? []).length,
        });

      return {
        applied: true,
        periodIds,
        playersTouched: input.players.length,
        eventsApplied,
        recordsInserted,
      };
    });

    return run();
  }

  /**
   * O caminho do push: um evento só, idempotente por `eventId`.
   *
   * ####  O `INSERT OR IGNORE` **É** O TESTE DE DUPLICATA  ####
   *
   * Consultar antes e inserir depois abriria uma corrida entre o
   * push e o lote que chega no mesmo instante — e a corrida daria
   * o ponto em dobro justamente no caso que este canal existe para
   * cobrir.
   */
  applyEvent(input: StatEventInput, now: number = Date.now()): ApplyEventResult {
    const run = this.#db.transaction((): ApplyEventResult => {
      // ####  O MODO SAI DA CONFIGURAÇÃO, E NÃO DO PADRÃO  ####
      //
      // Um evento de push pode ser a PRIMEIRA coisa que um servidor
      // registra — antes de o coletor ter aberto período nenhum. Se
      // o modo viesse do padrão aqui, a temporada daquele servidor
      // nasceria mensal mesmo estando configurada como quinzenal, e
      // `stat_periods.season_mode` — que é o registro histórico de
      // como a janela estava configurada — guardaria uma mentira que
      // ninguém reescreve depois.
      const periodIds = this.ensureOpenPeriods(
        input.serverId,
        this.settingsOf(input.serverId).seasonMode,
        now,
      ).map((period) => period.id);

      const applied = this.#insertEvents([input], periodIds, now);

      return { applied: applied > 0, periodIds: applied > 0 ? periodIds : [] };
    });

    return run();
  }

  // ------------------------------------------------------
  //  A leitura
  // ------------------------------------------------------

  /**
   * O top N de uma métrica num período.
   *
   * O desempate de três critérios está no cabeçalho do arquivo, e
   * é ele que faz a página 2 continuar a página 1.
   */
  topOf(query: TopQuery): RankingEntryPage {
    const order = query.direction === 'asc' ? 'ASC' : 'DESC';

    const total = (
      this.#db
        .prepare(
          `SELECT count(*) AS total FROM player_stats
            WHERE period_id = @period_id AND metric = @metric`,
        )
        .get({ period_id: query.periodId, metric: query.metric }) as CountRow
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT s.steam_id, p.name, s.value, s.updated_at
           FROM player_stats s
           LEFT JOIN players p ON p.steam_id = s.steam_id
          WHERE s.period_id = @period_id AND s.metric = @metric
          ORDER BY s.value ${order}, s.updated_at ASC, s.steam_id ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all({
        period_id: query.periodId,
        metric: query.metric,
        limit: query.limit,
        offset: query.offset,
      }) as EntryRow[];

    return { entries: rows.map((row, index) => toEntry(row, query.offset + index + 1)), total };
  }

  /**
   * A soma da rede: os períodos ABERTOS daquele papel, somados.
   *
   * ####  SOMAR PERÍODO FECHADO SERIA OUTRA PERGUNTA  ####
   *
   * "O ranking da rede agora" é a soma do que está sendo contado
   * agora. Incluir temporadas fechadas responderia "de sempre",
   * que é o que o papel `lifetime` já responde — com a vantagem de
   * ser uma janela declarada em vez de uma soma acidental.
   */
  globalTop(query: GlobalTopQuery): RankingEntryPage {
    const order = query.direction === 'asc' ? 'ASC' : 'DESC';
    const scope = buildInClause('s', query.serverIds);
    const serverFilter = scope.sql === '' ? '' : ` AND per.server_id ${scope.sql}`;

    const params = {
      metric: query.metric,
      kind: query.kind,
      ...scope.params,
    };

    const total = (
      this.#db
        .prepare(
          `SELECT count(*) AS total FROM (
             SELECT s.steam_id
               FROM player_stats s
               JOIN stat_periods per ON per.id = s.period_id
              WHERE s.metric = @metric AND per.kind = @kind AND per.ended_at IS NULL${serverFilter}
              GROUP BY s.steam_id)`,
        )
        .get(params) as CountRow
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT s.steam_id AS steam_id,
                max(p.name) AS name,
                sum(s.value) AS value,
                max(s.updated_at) AS updated_at
           FROM player_stats s
           JOIN stat_periods per ON per.id = s.period_id
           LEFT JOIN players p ON p.steam_id = s.steam_id
          WHERE s.metric = @metric AND per.kind = @kind AND per.ended_at IS NULL${serverFilter}
          GROUP BY s.steam_id
          ORDER BY value ${order}, updated_at ASC, s.steam_id ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit, offset: query.offset }) as EntryRow[];

    return { entries: rows.map((row, index) => toEntry(row, query.offset + index + 1)), total };
  }

  /**
   * Onde aquele jogador está, sem paginar a lista até achá-lo.
   *
   * A conta é "quantos estão à frente dele", com os MESMOS três
   * critérios da listagem — senão a ficha diria 14º e a lista o
   * mostraria em 15º.
   */
  positionOf(query: {
    readonly steamId: string;
    readonly periodId: number;
    readonly metric: string;
    readonly direction?: RankingDirection;
  }): PlayerPosition | null {
    const mine = this.#db
      .prepare(
        `SELECT value, updated_at FROM player_stats
          WHERE period_id = @period_id AND steam_id = @steam_id AND metric = @metric`,
      )
      .get({ period_id: query.periodId, steam_id: query.steamId, metric: query.metric }) as
      | { value: number; updated_at: number }
      | undefined;

    if (mine === undefined) {
      return null;
    }

    const ahead = query.direction === 'asc' ? '<' : '>';

    const counted = this.#db
      .prepare(
        `SELECT count(*) AS total FROM player_stats
          WHERE period_id = @period_id AND metric = @metric
            AND (value ${ahead} @value
                 OR (value = @value AND updated_at < @updated_at)
                 OR (value = @value AND updated_at = @updated_at AND steam_id < @steam_id))`,
      )
      .get({
        period_id: query.periodId,
        metric: query.metric,
        value: mine.value,
        updated_at: mine.updated_at,
        steam_id: query.steamId,
      }) as CountRow;

    const total = (
      this.#db
        .prepare(
          `SELECT count(*) AS total FROM player_stats
            WHERE period_id = @period_id AND metric = @metric`,
        )
        .get({ period_id: query.periodId, metric: query.metric }) as CountRow
    ).total;

    return { position: counted.total + 1, value: mine.value, total };
  }

  /**
   * A mesma pergunta do `positionOf`, na soma da rede.
   *
   * A CTE existe porque a colocação depende do TOTAL de cada
   * jogador, e o total só existe depois do `GROUP BY`: comparar
   * linha a linha daria a posição dentro de um servidor, que é
   * outra pergunta.
   */
  globalPositionOf(query: {
    readonly steamId: string;
    readonly metric: string;
    readonly kind: PeriodKind;
    readonly serverIds?: readonly string[] | undefined;
    readonly direction?: RankingDirection;
  }): PlayerPosition | null {
    const ahead = query.direction === 'asc' ? '<' : '>';
    const scope = buildInClause('s', query.serverIds);
    const serverFilter = scope.sql === '' ? '' : ` AND per.server_id ${scope.sql}`;

    const totals = `
      WITH totals AS (
        SELECT s.steam_id AS steam_id, sum(s.value) AS value, max(s.updated_at) AS updated_at
          FROM player_stats s
          JOIN stat_periods per ON per.id = s.period_id
         WHERE s.metric = @metric AND per.kind = @kind AND per.ended_at IS NULL${serverFilter}
         GROUP BY s.steam_id)`;

    const params = { metric: query.metric, kind: query.kind, ...scope.params };

    const mine = this.#db
      .prepare(`${totals} SELECT value, updated_at FROM totals WHERE steam_id = @steam_id`)
      .get({ ...params, steam_id: query.steamId }) as
      | { value: number; updated_at: number }
      | undefined;

    if (mine === undefined) {
      return null;
    }

    const counted = this.#db
      .prepare(
        `${totals}
         SELECT count(*) AS total FROM totals
          WHERE (value ${ahead} @value
                 OR (value = @value AND updated_at < @updated_at)
                 OR (value = @value AND updated_at = @updated_at AND steam_id < @steam_id))`,
      )
      .get({
        ...params,
        value: mine.value,
        updated_at: mine.updated_at,
        steam_id: query.steamId,
      }) as CountRow;

    const total = (
      this.#db.prepare(`${totals} SELECT count(*) AS total FROM totals`).get(params) as CountRow
    ).total;

    return { position: counted.total + 1, value: mine.value, total };
  }

  /**
   * A conta do §2.4: eventos por dia, por fonte.
   *
   * ####  É ELA QUE RESPONDE "GANHEI 3 TROFÉUS E SÓ CONTOU 1"  ####
   *
   * Sem esta consulta, aquela reclamação não tem resposta — só a
   * palavra de um contra a do outro. O dia é calculado do `at`, que
   * é o relógio do SERVIDOR DE JOGO em segundos: é a hora que o
   * jogador viu no chat, e é com ela que ele vai reclamar.
   */
  auditOf(query: {
    readonly serverId?: string | undefined;
    readonly metric?: string | undefined;
    /** Epoch em SEGUNDOS, como a coluna. */
    readonly from?: number | undefined;
    readonly to?: number | undefined;
  }): readonly {
    readonly day: string;
    readonly metric: string;
    readonly source: string | null;
    readonly events: number;
    readonly amount: number;
  }[] {
    return this.#db
      .prepare(
        `SELECT date(at, 'unixepoch', 'localtime') AS day, metric, source,
                count(*) AS events, sum(amount) AS amount
           FROM stat_events
          WHERE (@server_id IS NULL OR server_id = @server_id)
            AND (@metric IS NULL OR metric = @metric)
            AND (@from IS NULL OR at >= @from)
            AND (@to IS NULL OR at <= @to)
          GROUP BY day, metric, source
          ORDER BY day DESC, metric ASC, source ASC`,
      )
      .all({
        server_id: query.serverId ?? null,
        metric: query.metric ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
      }) as {
      day: string;
      metric: string;
      source: string | null;
      events: number;
      amount: number;
    }[];
  }

  /**
   * Os recordes, com o testemunho.
   *
   * ####  UM POR JOGADOR, E O `MAX` ESCOLHE A LINHA  ####
   *
   * A tabela guarda cada recorde pessoal como um fato — três tiros
   * cada vez mais longos são três linhas. A lista mostra o MELHOR
   * de cada um: sem o `GROUP BY`, o pódio seria o mesmo atirador
   * cinco vezes.
   *
   * As colunas soltas ao lado do `max()` vêm da linha do máximo:
   * é comportamento documentado do SQLite quando há exatamente um
   * `min()`/`max()` na consulta, e é o que dá arma e vítima do
   * tiro certo.
   *
   * `status <> 'ok'` fica de fora do pódio e CONTINUA na tabela:
   * apagar o suspeito seria perder o rastro da fraude.
   */
  topRecordsOf(query: TopQuery): RecordEntryPage {
    const order = query.direction === 'asc' ? 'ASC' : 'DESC';

    const total = (
      this.#db
        .prepare(
          `SELECT count(DISTINCT steam_id) AS total FROM player_records
            WHERE period_id = @period_id AND metric = @metric AND status = 'ok'`,
        )
        .get({ period_id: query.periodId, metric: query.metric }) as CountRow
    ).total;

    const rows = this.#db
      .prepare(
        `SELECT r.steam_id AS steam_id, p.name AS name, max(r.value) AS value,
                r.at AS at, r.detail AS detail
           FROM player_records r
           LEFT JOIN players p ON p.steam_id = r.steam_id
          WHERE r.period_id = @period_id AND r.metric = @metric AND r.status = 'ok'
          GROUP BY r.steam_id
          ORDER BY value ${order}, at ASC, r.steam_id ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all({
        period_id: query.periodId,
        metric: query.metric,
        limit: query.limit,
        offset: query.offset,
      }) as RecordRow[];

    return {
      entries: rows.map((row, index) => ({
        position: query.offset + index + 1,
        steamId: row.steam_id,
        name: row.name,
        value: row.value,
        at: row.at,
        detail: parseDetail(row.detail),
      })),
      total,
    };
  }

  /**
   * Várias métricas do mesmo jogador, de uma vez.
   *
   * É o que o K/D precisa: pedir `pvp.kills` e depois `pvp.deaths`
   * seriam duas listas para casar em memória, e casar por chave é
   * exatamente o que o SQL faz melhor.
   */
  sumByPlayer(query: SumByPlayerQuery): readonly PlayerMetricSums[] {
    if (query.periodIds.length === 0 || query.metrics.length === 0) {
      return [];
    }

    const periods = buildInClause('p', query.periodIds);
    const metrics = buildInClause('m', query.metrics);

    const rows = this.#db
      .prepare(
        `SELECT s.steam_id AS steam_id, max(p.name) AS name, s.metric AS metric,
                sum(s.value) AS value, max(s.updated_at) AS updated_at
           FROM player_stats s
           LEFT JOIN players p ON p.steam_id = s.steam_id
          WHERE s.period_id ${periods.sql} AND s.metric ${metrics.sql}
          GROUP BY s.steam_id, s.metric`,
      )
      .all({ ...periods.params, ...metrics.params }) as (EntryRow & { metric: string })[];

    const byPlayer = new Map<string, { name: string | null; values: Record<string, number>; updatedAt: number }>();

    for (const row of rows) {
      const found = byPlayer.get(row.steam_id);

      if (found === undefined) {
        byPlayer.set(row.steam_id, {
          name: row.name,
          values: { [row.metric]: row.value },
          updatedAt: row.updated_at,
        });
        continue;
      }

      found.values[row.metric] = row.value;
      found.name = found.name ?? row.name;
      found.updatedAt = Math.max(found.updatedAt, row.updated_at);
    }

    return [...byPlayer.entries()].map(([steamId, data]) => ({
      steamId,
      name: data.name,
      values: data.values,
      updatedAt: data.updatedAt,
    }));
  }

  /** Quando o último lote daquele escopo foi aplicado. */
  lastBatchAt(serverIds?: readonly string[]): number | null {
    const scope = buildInClause('s', serverIds);

    const row = this.#db
      .prepare(
        `SELECT max(applied_at) AS total FROM stat_batches
          ${scope.sql === '' ? '' : `WHERE server_id ${scope.sql}`}`,
      )
      .get(scope.params) as { total: number | null } | undefined;

    return row?.total ?? null;
  }

  // ------------------------------------------------------
  //  O pódio congelado
  // ------------------------------------------------------

  /**
   * Congela o pódio de todos os rankings habilitados.
   *
   * ####  POR QUE CONGELAR, SE OS DADOS CONTINUAM NO BANCO  ####
   *
   * Porque o pódio de março precisa continuar sendo o pódio de
   * março. Um estorno de fraude, um peso de índice que muda ou um
   * jogador apagado da base mudariam a resposta de uma pergunta
   * sobre o passado. Congelar não é cache — é a única maneira de a
   * tela "campeões da temporada passada" dizer amanhã o que diz
   * hoje.
   *
   * `INSERT OR REPLACE` porque congelar duas vezes o mesmo período
   * (uma retomada, um fechamento refeito à mão) tem que dar o
   * mesmo resultado, e não um erro de chave.
   *
   * @returns quantas linhas foram congeladas.
   */
  freezePodium(
    periodId: number,
    size: number,
    now: number = Date.now(),
    computed?: ComputedPodium,
  ): number {
    const insert = this.#db.prepare(
      `INSERT OR REPLACE INTO ranking_snapshots
         (period_id, metric, position, steam_id, display_name, value, frozen_at)
       VALUES (@period_id, @metric, @position, @steam_id, @display_name, @value, @frozen_at)`,
    );

    const run = this.#db.transaction((): number => {
      let frozen = 0;

      for (const ranking of this.list({ enabledOnly: true })) {
        const rows = this.#podiumOf(ranking, periodId, size, computed);

        for (const [index, row] of rows.entries()) {
          insert.run({
            period_id: periodId,
            metric: ranking.metric,
            position: index + 1,
            steam_id: row.steamId,
            display_name: row.displayName,
            value: row.value,
            frozen_at: now,
          });
          frozen += 1;
        }
      }

      return frozen;
    });

    return run();
  }

  /** O pódio congelado de uma métrica. */
  snapshotOf(periodId: number, metric: string): readonly SnapshotEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT position, steam_id, display_name, value, frozen_at
           FROM ranking_snapshots
          WHERE period_id = @period_id AND metric = @metric
          ORDER BY position ASC`,
      )
      .all({ period_id: periodId, metric }) as SnapshotRow[];

    return rows.map((row) => ({
      position: row.position,
      steamId: row.steam_id,
      displayName: row.display_name,
      value: row.value,
      frozenAt: row.frozen_at,
    }));
  }

  /** Quais métricas aquele período congelou. */
  snapshotMetricsOf(periodId: number): readonly string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT metric FROM ranking_snapshots
          WHERE period_id = @period_id ORDER BY metric ASC`,
      )
      .all({ period_id: periodId }) as { metric: string }[];

    return rows.map((row) => row.metric);
  }

  // ------------------------------------------------------
  //  Os ajustes
  // ------------------------------------------------------

  /**
   * Registra que alguém mexeu no número.
   *
   * Ação administrativa sem autor é o que não se consegue explicar
   * depois — a mesma razão da `store_audit`.
   */
  recordAdjustment(input: AdjustmentInput, at: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO stat_adjustments
           (period_id, steam_id, metric, action, old_value, new_value, actor, reason, at)
         VALUES
           (@period_id, @steam_id, @metric, @action, @old_value, @new_value, @actor, @reason, @at)`,
      )
      .run({
        period_id: input.periodId,
        steam_id: input.steamId,
        metric: input.metric ?? null,
        action: input.action,
        old_value: input.oldValue ?? null,
        new_value: input.newValue ?? null,
        actor: input.actor,
        reason: input.reason ?? null,
        at,
      });
  }

  /**
   * Zera o que aquele jogador tem no período, com autor.
   *
   * O ajuste é gravado ANTES de a linha ser zerada — é o `old_value`
   * que dá sentido ao registro, e depois do UPDATE ele já não
   * existe em lugar nenhum.
   *
   * @returns quantas métricas foram zeradas.
   */
  resetPlayer(input: ResetPlayerInput, at: number = Date.now()): number {
    const run = this.#db.transaction((): number => {
      const rows = this.#db
        .prepare(
          `SELECT metric, value FROM player_stats
            WHERE period_id = @period_id AND steam_id = @steam_id
              AND (@metric IS NULL OR metric = @metric)`,
        )
        .all({
          period_id: input.periodId,
          steam_id: input.steamId,
          metric: input.metric ?? null,
        }) as { metric: string; value: number }[];

      for (const row of rows) {
        this.recordAdjustment(
          {
            periodId: input.periodId,
            steamId: input.steamId,
            metric: row.metric,
            action: 'reset',
            oldValue: row.value,
            newValue: 0,
            actor: input.actor,
            reason: input.reason ?? null,
          },
          at,
        );
      }

      this.#db
        .prepare(
          `UPDATE player_stats SET value = 0, updated_at = @at
            WHERE period_id = @period_id AND steam_id = @steam_id
              AND (@metric IS NULL OR metric = @metric)`,
        )
        .run({
          period_id: input.periodId,
          steam_id: input.steamId,
          metric: input.metric ?? null,
          at,
        });

      return rows.length;
    });

    return run();
  }

  // ------------------------------------------------------
  //  A configuração
  // ------------------------------------------------------

  /** A janela daquele servidor, ou os padrões do código. */
  settingsOf(serverId: string): RankingSettings {
    const row = this.#db
      .prepare(
        `SELECT season_mode, season_days, season_anchor_at, season_on_wipe, snapshot_size, updated_at
           FROM ranking_settings WHERE server_id = @server_id`,
      )
      .get({ server_id: serverId }) as SettingsRow | undefined;

    if (row === undefined) {
      return DEFAULT_RANKING_SETTINGS;
    }

    return {
      seasonMode: toSeasonMode(row.season_mode),
      seasonDays: row.season_days,
      seasonAnchorAt: row.season_anchor_at,
      seasonOnWipe: row.season_on_wipe === 1,
      snapshotSize: row.snapshot_size,
      updatedAt: row.updated_at,
    };
  }

  /**
   * O que AQUELA execução de wipe decidiu sobre a temporada.
   *
   * ####  TRÊS ESTADOS, E O `null` É UM DELES  ####
   *
   *   `null`  — não decidiu; vale a configuração do servidor
   *   `true`  — esta execução abre temporada nova
   *   `false` — esta execução NÃO abre, mesmo que a configuração
   *             diga que sim
   *
   * Um wipe feito à mão não tem execução nenhuma, e cai aqui como
   * `null` pelo mesmo caminho — que é o ponto do desenho: a âncora
   * é o mundo, não o painel.
   */
  seasonDecisionOfRun(wipeRunId: number | null | undefined): boolean | null {
    if (wipeRunId === null || wipeRunId === undefined) {
      return null;
    }

    const row = this.#db
      .prepare('SELECT open_ranking_season AS decision FROM wipe_runs WHERE id = @id')
      .get({ id: wipeRunId }) as { decision: number | null } | undefined;

    if (row === undefined || row.decision === null) {
      return null;
    }

    return row.decision === 1;
  }

  /**
   * Grava a janela.
   *
   * ####  TROCAR O MODO NÃO REABRE O PERÍODO EM CURSO  ####
   *
   * A temporada que está rodando termina como estava — o
   * `season_mode` dela foi gravado em `stat_periods` na abertura,
   * justamente para isto. O modo novo vale para a seguinte.
   * Reescrever o passado faria a temporada de março virar
   * trimestral no meio dela.
   */
  saveSettings(
    serverId: string,
    input: RankingSettingsInput,
    now: number = Date.now(),
  ): RankingSettings {
    this.#db
      .prepare(
        `INSERT INTO ranking_settings
           (server_id, season_mode, season_days, season_anchor_at, season_on_wipe,
            snapshot_size, updated_at)
         VALUES
           (@server_id, @season_mode, @season_days, @season_anchor_at, @season_on_wipe,
            @snapshot_size, @updated_at)
         ON CONFLICT (server_id) DO UPDATE SET
           season_mode      = @season_mode,
           season_days      = @season_days,
           season_anchor_at = @season_anchor_at,
           season_on_wipe   = @season_on_wipe,
           snapshot_size    = @snapshot_size,
           updated_at       = @updated_at`,
      )
      .run({
        server_id: serverId,
        season_mode: input.seasonMode,
        season_days: input.seasonDays ?? null,
        season_anchor_at: input.seasonAnchorAt ?? null,
        season_on_wipe: (input.seasonOnWipe ?? DEFAULT_RANKING_SETTINGS.seasonOnWipe) ? 1 : 0,
        snapshot_size: input.snapshotSize ?? DEFAULT_RANKING_SETTINGS.snapshotSize,
        updated_at: now,
      });

    return this.settingsOf(serverId);
  }

  // ------------------------------------------------------
  //  Privados
  // ------------------------------------------------------

  #requireOpenPeriod(periodId: number): StatPeriod {
    const period = this.getPeriod(periodId);

    if (period === null) {
      throw new ApiError('RANKING_PERIOD_NOT_FOUND', `Não existe o período ${String(periodId)}.`, 404);
    }

    if (period.endedAt !== null) {
      throw new ApiError(
        'RANKING_PERIOD_CLOSED',
        `O período ${String(periodId)} já foi fechado — um período fechado não muda mais.`,
        409,
      );
    }

    return period;
  }

  /**
   * O que congelar de UM ranking.
   *
   * As três formas de valor pedem três consultas diferentes, e é
   * por isso que este método existe em vez de um `SELECT` só:
   * contador soma, recorde é o melhor de cada um, e razão nem
   * sequer está no banco.
   */
  #podiumOf(
    ranking: RankingRecord,
    periodId: number,
    size: number,
    computed?: ComputedPodium,
  ): readonly PodiumRow[] {
    if (ranking.valueKind === 'ratio' || ranking.source === 'computed') {
      // Sem a ponte, um ranking derivado simplesmente não congela.
      // Isso é melhor que congelar um número errado — mas quem
      // fecha o período de verdade (o serviço) sempre a passa.
      return computed === undefined ? [] : computed(ranking, periodId, size).slice(0, size);
    }

    if (ranking.valueKind === 'record') {
      return this.topRecordsOf({
        periodId,
        metric: ranking.metric,
        limit: size,
        offset: 0,
        direction: ranking.direction,
      }).entries.map((entry) => ({
        steamId: entry.steamId,
        displayName: entry.name,
        value: entry.value,
      }));
    }

    return this.topOf({
      periodId,
      metric: ranking.metric,
      limit: size,
      offset: 0,
      direction: ranking.direction,
    }).entries.map((entry) => ({
      steamId: entry.steamId,
      displayName: entry.name,
      value: entry.value,
    }));
  }

  /**
   * Os recordes do lote.
   *
   * ####  SÓ ENTRA QUEM BATEU O PRÓPRIO RECORDE  ####
   *
   * O plugin manda o melhor tiro de cada jogador no lote, e o lote
   * roda a cada 60 s. Sem esta comparação, um jogador com um bom
   * tiro geraria uma linha por minuto até o fim da temporada — e a
   * tabela do "fato com testemunho" viraria um log de repetições.
   *
   * ####  A COMPARAÇÃO É DENTRO DO MESMO `status`  ####
   *
   * Um tiro suspeito de 940 m e um legítimo de 412 m são dois
   * fatos, e cada um tem o seu melhor. Comparar o suspeito contra o
   * melhor `ok` erraria dos dois lados: o mesmo tiro suspeito
   * chegando pelo push E pelo lote viraria duas linhas (nenhum
   * `ok` o barra), e um suspeito menor que o recorde legítimo
   * sumiria — justamente o rastro que a coluna `status` existe para
   * guardar.
   */
  #insertRecords(
    records: readonly StatBatchRecord[],
    periodIds: readonly number[],
    now: number,
  ): number {
    if (records.length === 0) {
      return 0;
    }

    const ensurePlayer = this.#db.prepare(ENSURE_PLAYER);

    const best = this.#db.prepare(
      `SELECT max(value) AS total FROM player_records
        WHERE period_id = @period_id AND steam_id = @steam_id AND metric = @metric
          AND status = @status`,
    );

    const insert = this.#db.prepare(
      `INSERT INTO player_records (period_id, steam_id, metric, value, at, detail, status)
            VALUES (@period_id, @steam_id, @metric, @value, @at, @detail, @status)`,
    );

    let inserted = 0;

    for (const record of records) {
      ensurePlayer.run({ steam_id: record.steamId, name: record.name ?? '', at: now });

      const status = record.status ?? 'ok';

      for (const periodId of periodIds) {
        const current = best.get({
          period_id: periodId,
          steam_id: record.steamId,
          metric: record.metric,
          status,
        }) as { total: number | null } | undefined;

        if (current?.total !== null && current?.total !== undefined && current.total >= record.value) {
          continue;
        }

        insert.run({
          period_id: periodId,
          steam_id: record.steamId,
          metric: record.metric,
          value: record.value,
          at: record.at,
          detail: record.detail === undefined ? null : JSON.stringify(record.detail),
          status,
        });
        inserted += 1;
      }
    }

    return inserted;
  }

  /**
   * Os eventos, e a soma dos que entraram.
   *
   * Quem já estava em `stat_events` não soma de novo: é o mesmo
   * ponto chegando pelo segundo caminho, e o `changes === 0` do
   * `INSERT OR IGNORE` é a resposta.
   */
  #insertEvents(
    events: readonly StatEventInput[],
    periodIds: readonly number[],
    now: number,
  ): number {
    if (events.length === 0) {
      return 0;
    }

    const insertEvent = this.#db.prepare(
      `INSERT OR IGNORE INTO stat_events
         (event_id, server_id, steam_id, metric, amount, source, at, applied_at, via)
       VALUES
         (@event_id, @server_id, @steam_id, @metric, @amount, @source, @at, @applied_at, @via)`,
    );

    const ensurePlayer = this.#db.prepare(ENSURE_PLAYER);
    const upsert = this.#db.prepare(UPSERT_STAT);

    let applied = 0;

    for (const event of events) {
      const result = insertEvent.run({
        event_id: event.eventId,
        server_id: event.serverId,
        steam_id: event.steamId,
        metric: event.metric,
        amount: Math.trunc(event.amount),
        source: event.source ?? null,
        at: event.at,
        applied_at: now,
        via: event.via,
      });

      if (result.changes === 0) {
        continue;
      }

      applied += 1;
      ensurePlayer.run({ steam_id: event.steamId, name: event.name ?? '', at: now });

      for (const periodId of periodIds) {
        upsert.run({
          period_id: periodId,
          steam_id: event.steamId,
          metric: event.metric,
          delta: Math.trunc(event.amount),
          at: now,
        });
      }
    }

    return applied;
  }
}

// ------------------------------------------------------------
//  Conversões
// ------------------------------------------------------------

function toRanking(row: RankingRow): RankingRecord {
  return {
    id: row.id,
    metric: row.metric,
    label: row.label,
    shortLabel: toShortLabel(row.short_label),
    unit: row.unit,
    description: row.description,
    source: toSource(row.source),
    valueKind: toValueKind(row.value_kind),
    direction: row.direction === 'asc' ? 'asc' : 'desc',
    window: toPeriodKind(row.window),
    globalEligible: row.global_eligible === 1,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1,
    showInGame: row.show_in_game === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRankingColumns(input: RankingInput): Record<string, unknown> {
  return {
    id: input.id,
    metric: input.metric,
    label: input.label,
    // Vazio vira `NULL` na ESCRITA: `''` e `NULL` significariam a
    // mesma coisa ("use o `label`") guardados de dois jeitos, e a
    // primeira consulta que testasse `short_label IS NULL` só
    // acertaria metade das linhas.
    short_label: toShortLabel(input.shortLabel ?? null),
    unit: input.unit,
    description: input.description,
    source: input.source,
    value_kind: input.valueKind,
    direction: input.direction,
    window: input.window,
    global_eligible: input.globalEligible ? 1 : 0,
    enabled: input.enabled ? 1 : 0,
    // Ausente = aparece: um ranking novo que nascesse escondido
    // seria criado pelo painel e sumiria sem explicação.
    show_in_game: (input.showInGame ?? true) ? 1 : 0,
    // Quem chama resolve o ausente: na criação vira o fim da lista
    // (`#nextSortOrder`), na edição vira o valor que já estava.
    sort_order: input.sortOrder ?? 0,
  };
}

/** Nome curto em branco é nome curto ausente. */
function toShortLabel(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';

  return trimmed === '' ? null : trimmed;
}

function toPeriod(row: PeriodRow): StatPeriod {
  return {
    id: row.id,
    serverId: row.server_id,
    kind: toPeriodKind(row.kind),
    wipeId: row.wipe_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seasonMode: row.season_mode === null ? null : toSeasonMode(row.season_mode),
    label: row.label,
  };
}

function toEntry(row: EntryRow, position: number): RankingEntry {
  return {
    position,
    steamId: row.steam_id,
    name: row.name,
    value: row.value,
    updatedAt: row.updated_at,
  };
}

/**
 * O CHECK do banco já garante os valores; estas funções só fazem o
 * compilador saber disso.
 *
 * Um valor fora do conjunto só existiria em banco mexido à mão, e
 * a escolha ali é o padrão — nunca uma exceção, que derrubaria a
 * listagem inteira por causa de uma linha.
 */
function toSource(value: string): RankingSource {
  switch (value) {
    case 'agent':
    case 'item':
    case 'computed':
      return value;
    default:
      return 'plugin';
  }
}

function toValueKind(value: string): RankingValueKind {
  switch (value) {
    case 'record':
    case 'ratio':
      return value;
    default:
      return 'counter';
  }
}

function toPeriodKind(value: string): PeriodKind {
  switch (value) {
    case 'wipe':
    case 'season':
      return value;
    default:
      return 'lifetime';
  }
}

function toSeasonMode(value: string): SeasonMode {
  switch (value) {
    case 'wipe':
    case 'biweekly':
    case 'quarterly':
    case 'days':
    case 'manual':
      return value;
    default:
      return 'monthly';
  }
}

/**
 * O testemunho volta como objeto.
 *
 * JSON quebrado vira `null` em vez de estourar: a coluna é escrita
 * por nós, e derrubar a lista de recordes inteira por causa de uma
 * linha esconderia os outros trinta que estão bons. Mesma escolha
 * do `parseAction` do cadastro de itens.
 */
function parseDetail(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Uma cláusula `IN (...)` com um placeholder por item.
 *
 * Concatenar os valores no SQL seria o caminho curto e o errado —
 * a lista de servidores nasce numa query string. O prefixo existe
 * para duas listas na mesma consulta não colidirem de nome.
 *
 * Lista ausente devolve SQL vazio: "todos" e "nenhum" são
 * perguntas diferentes, e quem passa `[]` está pedindo nenhum.
 */
function buildInClause(
  prefix: string,
  values: readonly (string | number)[] | undefined,
): { readonly sql: string; readonly params: Record<string, string | number> } {
  if (values === undefined) {
    return { sql: '', params: {} };
  }

  if (values.length === 0) {
    // `IN ()` não é SQL válido, e "nenhum" precisa de uma resposta.
    return { sql: 'IN (NULL)', params: {} };
  }

  const params: Record<string, string | number> = {};
  const names = values.map((value, index) => {
    const name = `${prefix}${String(index)}`;
    params[name] = value;
    return `@${name}`;
  });

  return { sql: `IN (${names.join(', ')})`, params };
}
