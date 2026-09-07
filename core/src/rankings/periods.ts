// ============================================================
//  periods.ts  -  quando a janela vira, e o que acontece quando
//  ela vira.
//
//  ####  A DECISÃO É PURA; A ESCRITA É DO REPOSITÓRIO  ####
//
//  Tudo o que responde "já venceu?" aqui é função pura: entra
//  configuração e um instante, sai um sim ou um não. É o que
//  permite testar as seis maneiras de a temporada virar sem abrir
//  banco nenhum — e testar as bordas que só acontecem uma vez por
//  ano (a virada de trimestre, o mês de 28 dias) sem esperar a
//  data chegar.
//
//  Só `closeAndOpen` toca no banco, e mesmo ela delega a transação
//  ao repositório: os cinco passos do §5.4 acontecem num `BEGIN`
//  só, e quem sabe abrir um `BEGIN` é quem tem a conexão.
//
//  ------------------------------------------------------------
//  ####  A TEMPORADA TEM DOIS GATILHOS, E ELES SÃO INDEPENDENTES
//
//    1. o CALENDÁRIO — o `season_mode` diz o tamanho da janela;
//    2. o MUNDO — um wipe abre temporada nova se a configuração
//       (ou aquela execução) mandar.
//
//  Os dois podem cair no mesmo minuto, e o resultado é UMA virada:
//  o índice único parcial `idx_stat_periods_open` recusa o segundo
//  aberto, e isso é tratado como "já virou" — não como erro.
//
//  ------------------------------------------------------------
//  ####  O FUSO É O DA MÁQUINA, E ISSO É UMA ESCOLHA  ####
//
//  `monthly` e `quarterly` viram pela hora LOCAL, que é a mesma
//  régua do agendador de mensagens (Docs/16 §14). Um ranking que
//  vira às 21h do dia 31 porque alguém pensou em UTC é um bug que
//  ninguém consegue explicar ao jogador.
//
//  O `timeZone` é opcional em toda função daqui: quando ele vem,
//  a conta é feita naquela zona (é o que os testes usam, para não
//  dependerem da máquina que roda); quando não vem, vale a zona do
//  processo — que é a da máquina do agente, e é a resposta certa
//  em produção.
//
//  Ver Docs/Ranking/20-PLANO-E-CONTRATOS.md §5.
// ============================================================

import type {
  PeriodKind,
  RankingSettings,
  RankingsRepository,
  RollPeriodResult,
  SeasonMode,
  StatPeriod,
  ComputedPodium,
} from '../db/rankings-repository.js';
import { localDateInZone, zonedTimeToUtc } from '../wipe/schedule.js';

/** Um dia, em milissegundos. */
const DAY_MS = 86_400_000;

/**
 * Quinze dias, e não "meio mês".
 *
 * O dono pediu "por 15 dias". Meio mês seria 14 em fevereiro e 15,5
 * em janeiro, e a temporada mudaria de tamanho conforme o mês — que
 * é justamente o que quem pede "15 dias" não quer.
 */
const BIWEEKLY_DAYS = 15;

const MONTH_NAMES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

/** Uma data no calendário local, sem hora. */
export interface LocalDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** O que a decisão de virar precisa saber sobre a janela aberta. */
export interface SeasonWindow {
  readonly seasonMode: SeasonMode;
  /** Quando o período aberto começou. Epoch ms. */
  readonly startedAt: number;
  readonly seasonDays?: number | null;
  /** De onde `biweekly` e `days` contam. `null` = o `startedAt`. */
  readonly seasonAnchorAt?: number | null;
  /** Zona IANA. Ausente = a hora local da máquina do agente. */
  readonly timeZone?: string | undefined;
}

/** Por que a temporada virou. Vai para o log e para o histórico. */
export type SeasonTurnReason = 'calendar' | 'wipe';

export interface SeasonTurnInput {
  readonly window: SeasonWindow;
  readonly now: number;
  /** Um mundo novo apareceu nesta rodada? */
  readonly wipeDetected?: boolean;
  /**
   * O que AQUELA execução de wipe decidiu. `null` = não decidiu,
   * e não "decidiu que não" — a diferença é o §3.4 inteiro.
   */
  readonly runDecision?: boolean | null;
  /** A regra permanente do servidor. */
  readonly seasonOnWipe?: boolean;
}

export interface SeasonTurn {
  readonly due: boolean;
  /** `null` quando não venceu. */
  readonly reason: SeasonTurnReason | null;
}

// ------------------------------------------------------------
//  As funções puras
// ------------------------------------------------------------

/**
 * De onde a contagem de `biweekly` e `days` parte.
 *
 * Sem âncora configurada, a abertura do período atual serve — o
 * que faz a primeira temporada de um servidor novo começar a
 * contar quando ele começou a existir, e não numa data que
 * ninguém escolheu.
 */
export function seasonAnchorOf(window: SeasonWindow): number {
  return window.seasonAnchorAt ?? window.startedAt;
}

/**
 * A temporada venceu pelo CALENDÁRIO?
 *
 * `wipe` e `manual` respondem sempre `false` aqui, e é de
 * propósito: os dois viram por um gatilho que não é o relógio —
 * o mundo e a mão de alguém. Misturá-los nesta conta faria
 * `season_mode = 'manual'` virar sozinho no primeiro sweep.
 */
export function isSeasonDue(window: SeasonWindow, now: number): boolean {
  switch (window.seasonMode) {
    case 'wipe':
    case 'manual':
      return false;

    case 'biweekly':
      return now >= seasonAnchorOf(window) + BIWEEKLY_DAYS * DAY_MS;

    case 'days': {
      const days = window.seasonDays ?? 0;

      // Sem `season_days` a janela não tem tamanho, e uma janela
      // sem tamanho não vence — vencer aqui zeraria a temporada a
      // cada 60 s por causa de uma configuração incompleta.
      return days > 0 && now >= seasonAnchorOf(window) + days * DAY_MS;
    }

    case 'monthly': {
      const from = localDayOf(window.startedAt, window.timeZone);
      const to = localDayOf(now, window.timeZone);

      return to.year * 12 + to.month > from.year * 12 + from.month;
    }

    case 'quarterly': {
      const from = localDayOf(window.startedAt, window.timeZone);
      const to = localDayOf(now, window.timeZone);

      return to.year * 4 + quarterOf(to) > from.year * 4 + quarterOf(from);
    }
  }
}

/**
 * O wipe abre temporada nova?
 *
 * A execução manda; a configuração é o padrão. `null` na execução
 * significa "não decidi" — e é por isso que o `??` está aqui e não
 * um `||`: `false` é uma decisão, e `||` a engoliria.
 */
export function opensSeasonOnWipe(input: {
  readonly runDecision?: boolean | null;
  readonly seasonOnWipe?: boolean;
}): boolean {
  return input.runDecision ?? input.seasonOnWipe ?? false;
}

/**
 * A resposta completa: venceu, e por quê.
 *
 * ####  O WIPE VEM ANTES DO CALENDÁRIO  ####
 *
 * Quando os dois gatilhos caem no mesmo sweep, o motivo gravado é
 * o wipe. Não é empate arbitrário: o mundo é o fato observável, e
 * quem for ler o log meses depois precisa ver "virou porque o mapa
 * trocou" — que explica também por que o ranking de farm zerou no
 * mesmo instante.
 */
export function seasonTurn(input: SeasonTurnInput): SeasonTurn {
  if (input.wipeDetected === true) {
    const byWipe =
      input.window.seasonMode === 'wipe' ||
      opensSeasonOnWipe({
        ...(input.runDecision === undefined ? {} : { runDecision: input.runDecision }),
        ...(input.seasonOnWipe === undefined ? {} : { seasonOnWipe: input.seasonOnWipe }),
      });

    if (byWipe) {
      return { due: true, reason: 'wipe' };
    }
  }

  return isSeasonDue(input.window, input.now)
    ? { due: true, reason: 'calendar' }
    : { due: false, reason: null };
}

/**
 * Quando a janela aberta vira, se ninguém mexer.
 *
 * É o que a tela do painel mostra ("a temporada atual vira em…").
 * `null` para os modos que não têm data: `wipe` depende do mundo e
 * `manual` depende de alguém.
 */
export function nextSeasonTurnAt(window: SeasonWindow): number | null {
  switch (window.seasonMode) {
    case 'wipe':
    case 'manual':
      return null;

    case 'biweekly':
      return seasonAnchorOf(window) + BIWEEKLY_DAYS * DAY_MS;

    case 'days': {
      const days = window.seasonDays ?? 0;

      return days > 0 ? seasonAnchorOf(window) + days * DAY_MS : null;
    }

    case 'monthly': {
      const from = localDayOf(window.startedAt, window.timeZone);

      return startOfLocalDay(nextMonth(from), window.timeZone);
    }

    case 'quarterly': {
      const from = localDayOf(window.startedAt, window.timeZone);
      const quarter = quarterOf(from);
      const month = quarter * 3 + 1;

      return startOfLocalDay(
        month > 12 ? { year: from.year + 1, month: 1, day: 1 } : { year: from.year, month, day: 1 },
        window.timeZone,
      );
    }
  }
}

/**
 * O nome da janela, para a tela e para o histórico.
 *
 * Nunca é chave: ele existe para alguém reconhecer a temporada
 * numa lista, e mudar de forma amanhã não quebra nada.
 */
export function periodLabel(
  kind: PeriodKind,
  at: number,
  seasonMode?: SeasonMode | null,
  timeZone?: string,
): string {
  const day = localDayOf(at, timeZone);
  const month = MONTH_NAMES[day.month - 1] ?? '';

  if (kind === 'lifetime') {
    return 'De sempre';
  }

  if (kind === 'wipe') {
    return `Wipe de ${formatDay(day)}`;
  }

  if (seasonMode === 'monthly') {
    return `Temporada de ${month} de ${String(day.year)}`;
  }

  if (seasonMode === 'quarterly') {
    return `Temporada do ${String(quarterOf(day))}º trimestre de ${String(day.year)}`;
  }

  return `Temporada de ${formatDay(day)}`;
}

// ------------------------------------------------------------
//  A virada, com banco
// ------------------------------------------------------------

/** O que `closeAndOpen` precisa do mundo. E nada além disso. */
export interface PeriodsDeps {
  readonly repository: RankingsRepository;
  /** A ponte para congelar o K/D e os outros derivados. */
  readonly computed?: ComputedPodium;
  /** Zona IANA para os rótulos. Ausente = a da máquina. */
  readonly timeZone?: string | undefined;
}

export interface CloseAndOpenOptions {
  readonly serverId: string;
  readonly kind: PeriodKind;
  readonly now?: number;
  /** O `wipes.id` que abriu o período seguinte, quando houver. */
  readonly nextWipeId?: number | null;
  /** Um rótulo escolhido à mão. Ausente = o calculado. */
  readonly label?: string | null;
}

/**
 * Fecha a janela aberta e abre a seguinte. Os cinco passos do
 * §5.4, numa transação só.
 *
 * ####  "JÁ VIROU" NÃO É ERRO  ####
 *
 * Duas coisas podem querer virar a mesma temporada no mesmo minuto
 * — o wipe e o calendário —, e é normal que aconteça. Quando não
 * há período aberto para fechar, a resposta é `null`: alguém já
 * fez o trabalho. Tratar isso como falha encheria o log de erro
 * exatamente na configuração mais comum (temporada mensal com
 * `season_on_wipe`).
 *
 * @returns `null` quando não havia janela aberta.
 */
export function closeAndOpen(
  deps: PeriodsDeps,
  options: CloseAndOpenOptions,
): RollPeriodResult | null {
  const now = options.now ?? Date.now();
  const open = deps.repository.openPeriodOf(options.serverId, options.kind);

  if (open === null) {
    return null;
  }

  const settings = deps.repository.settingsOf(options.serverId);

  return deps.repository.rollPeriod({
    periodId: open.id,
    snapshotSize: settings.snapshotSize,
    // O modo NOVO vale para a janela nova. A que está fechando
    // termina com o modo que ela tinha quando abriu — é o que
    // impede a temporada de março virar trimestral no meio dela.
    nextSeasonMode: options.kind === 'season' ? settings.seasonMode : null,
    nextLabel:
      options.label ??
      periodLabel(
        options.kind,
        now,
        options.kind === 'season' ? settings.seasonMode : null,
        deps.timeZone,
      ),
    nextWipeId: options.nextWipeId ?? null,
    at: now,
    ...(deps.computed === undefined ? {} : { computed: deps.computed }),
  });
}

export interface SweepPeriodsInput {
  readonly serverId: string;
  readonly now?: number;
  /** Um mundo novo apareceu nesta rodada? */
  readonly wipeDetected?: boolean;
  /** A linha de `wipes` daquele mundo, quando houver. */
  readonly wipeId?: number | null;
  /** A execução que o criou. `null` = wipe feito à mão. */
  readonly wipeRunId?: number | null;
}

export interface SweepPeriodsResult {
  /** As janelas que viraram nesta rodada. */
  readonly rolled: readonly { readonly kind: PeriodKind; readonly result: RollPeriodResult }[];
  /** Por que a temporada virou, quando virou. */
  readonly seasonReason: SeasonTurnReason | null;
  readonly settings: RankingSettings;
  readonly open: readonly StatPeriod[];
}

/**
 * Uma rodada do coletor, do ponto de vista das janelas.
 *
 * ####  A ORDEM É WIPE, DEPOIS TEMPORADA  ####
 *
 * O wipe vira primeiro porque ele é o fato: o mundo trocou, e o
 * ranking de farm precisa refletir isso mesmo que a temporada
 * fique. A temporada olha para o MESMO wipe logo em seguida e
 * decide por conta própria — é isso que permite "zera o minério a
 * cada mapa, mas mantém os abates até o fim do mês".
 *
 * Ela nunca lança por "já virou": ver `closeAndOpen`.
 */
export function sweepPeriods(deps: PeriodsDeps, input: SweepPeriodsInput): SweepPeriodsResult {
  const now = input.now ?? Date.now();
  const settings = deps.repository.settingsOf(input.serverId);

  // Antes de virar qualquer coisa é preciso haver o que virar: um
  // servidor que nunca coletou não tem janela aberta nenhuma.
  deps.repository.ensureOpenPeriods(input.serverId, settings.seasonMode, now);

  const rolled: { kind: PeriodKind; result: RollPeriodResult }[] = [];

  if (input.wipeDetected === true) {
    const result = closeAndOpen(deps, {
      serverId: input.serverId,
      kind: 'wipe',
      now,
      nextWipeId: input.wipeId ?? null,
    });

    if (result !== null) {
      rolled.push({ kind: 'wipe', result });
    }
  }

  const season = deps.repository.openPeriodOf(input.serverId, 'season');

  const turn =
    season === null
      ? { due: false, reason: null as SeasonTurnReason | null }
      : seasonTurn({
          window: {
            // O modo com que ELA abriu, e não o configurado agora:
            // trocar a configuração não reabre a janela em curso.
            seasonMode: season.seasonMode ?? settings.seasonMode,
            startedAt: season.startedAt,
            seasonDays: settings.seasonDays,
            seasonAnchorAt: settings.seasonAnchorAt,
            ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
          },
          now,
          ...(input.wipeDetected === undefined ? {} : { wipeDetected: input.wipeDetected }),
          runDecision: deps.repository.seasonDecisionOfRun(input.wipeRunId),
          seasonOnWipe: settings.seasonOnWipe,
        });

  if (turn.due) {
    const result = closeAndOpen(deps, {
      serverId: input.serverId,
      kind: 'season',
      now,
      nextWipeId: turn.reason === 'wipe' ? (input.wipeId ?? null) : null,
    });

    if (result !== null) {
      rolled.push({ kind: 'season', result });
    }
  }

  return {
    rolled,
    seasonReason: turn.due ? turn.reason : null,
    settings,
    open: deps.repository.ensureOpenPeriods(input.serverId, settings.seasonMode, now),
  };
}

// ------------------------------------------------------------
//  O calendário local
// ------------------------------------------------------------

/**
 * Que dia é, para o agente, o instante `epochMs`.
 *
 * Com `timeZone` delega ao `localDateInZone` do wipe — a conta de
 * fuso deste projeto é uma só, e ela mora lá (Docs/17 §10). Sem
 * ele, os getters locais do `Date` respondem no fuso do processo,
 * que é o da máquina do agente.
 */
export function localDayOf(epochMs: number, timeZone?: string): LocalDay {
  if (timeZone !== undefined) {
    return localDateInZone(epochMs, timeZone);
  }

  const date = new Date(epochMs);

  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** 1 a 4. Janeiro é o primeiro. */
function quarterOf(day: LocalDay): number {
  return Math.ceil(day.month / 3);
}

function nextMonth(day: LocalDay): LocalDay {
  return day.month === 12
    ? { year: day.year + 1, month: 1, day: 1 }
    : { year: day.year, month: day.month + 1, day: 1 };
}

/**
 * A meia-noite daquele dia, em epoch.
 *
 * Com `timeZone` a conta é a do wipe (`zonedTimeToUtc`), que já
 * resolve as duas madrugadas difíceis do ano — a que não existe e
 * a que acontece duas vezes. Duplicá-la aqui seria a segunda conta
 * de fuso do projeto, e a segunda é a que diverge no primeiro
 * ajuste (Docs/17 §10).
 *
 * Sem ele, o construtor do `Date` resolve no fuso do processo,
 * fazendo o mesmo trabalho.
 */
function startOfLocalDay(day: LocalDay, timeZone?: string): number {
  if (timeZone === undefined) {
    return new Date(day.year, day.month - 1, day.day, 0, 0, 0, 0).getTime();
  }

  return zonedTimeToUtc(day, 0, 0, timeZone);
}

function formatDay(day: LocalDay): string {
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${pad(day.day)}/${pad(day.month)}/${String(day.year)}`;
}
