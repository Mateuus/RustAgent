// ============================================================
//  normalize.ts  -  o que o agente manda sobre o passe, com
//  padrão em cada campo.
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  `lib/api.ts:143` é literalmente `return payload as T` — um cast,
//  sem validação, e não há Zod no painel. Um campo que o agente
//  omitir vira TypeError no render e derruba a página inteira com
//  "This page couldn't load". Toda resposta do passe passa por uma
//  destas funções antes de chegar ao JSX.
//
//  O molde é `components/workshop/normalize.ts`, e as quatro regras
//  que ele já descobriu valem aqui:
//
//    1. enum desconhecido vira `null` — não erro, e não um palpite;
//    2. booleano ausente cai no LADO SEGURO. Aqui o lado seguro é:
//       recompensa ausente NÃO é "disponível" (`locked`), regra de
//       XP ausente NÃO paga, e direito ausente NÃO é "comprou";
//    3. id maior que 2^53 é TEXTO (`steamId`, `skinId`);
//    4. campo derivável se recalcula quando falta (`active` a partir
//       de `revokedAt`).
//
//  ####  E UMA QUINTA, QUE É DESTE MÓDULO  ####
//
//  RECOMPENSA DE TIPO DESCONHECIDO NÃO SE APAGA. A frente B vai
//  acrescentar `kind: 'xp'` ao `QuestReward`; um painel mais velho
//  que a descartasse "por segurança" a apagaria de verdade no
//  primeiro salvamento da casa — silenciosamente, porque o PUT da
//  trilha manda a lista INTEIRA. Aqui ela é preservada como veio, e
//  a tela diz que existe e que não sabe editá-la.
//
//  ####  A CONTA DA CURVA É COPIADA, E ISSO É CONSCIENTE  ####
//
//  `xpToReach` existe igual em `core/src/types/battlepass.ts`. Não
//  há pacote de tipos compartilhado neste repositório (05 §6), e a
//  cópia aqui serve a UMA coisa: a estimativa de quanto tempo leva
//  para terminar a trilha. Quem manda no XP de verdade é o agente —
//  esta conta nunca vira número gravado.
// ============================================================

import type {
  BattlePassAuditEntry,
  BattlePassAuditSource,
  BattlePassCellState,
  BattlePassEntitlement,
  BattlePassEntitlementOrigin,
  BattlePassLane,
  BattlePassOverview,
  BattlePassPendingDelivery,
  BattlePassPendingOrigin,
  BattlePassPlayerTrack,
  BattlePassProgress,
  BattlePassSeason,
  BattlePassSeasonState,
  BattlePassTrackCell,
  BattlePassTrackCellView,
  BattlePassTrackProgress,
  BattlePassXpCurve,
  BattlePassXpRule,
  BattlePassXpSource,
  QuestReward,
  QuestRewardKind,
} from '@/lib/api';

// ------------------------------------------------------------
//  OS HELPERS  (os mesmos três do workshop, e mais dois)
// ------------------------------------------------------------

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Um inteiro dentro de uma faixa, com padrão. Nunca `NaN` na tela. */
function integer(value: unknown, fallback: number, min = 0): number {
  const parsed = nullableNumber(value);

  return parsed === null ? fallback : Math.max(min, Math.trunc(parsed));
}

/** Um objeto qualquer, para ler campo a campo sem `any`. */
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A mensagem de um erro qualquer, sem `[object Object]`. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ------------------------------------------------------------
//  OS ENUMOS, E O QUE A TELA CHAMA CADA UM
// ------------------------------------------------------------

export const SEASON_STATES: readonly BattlePassSeasonState[] = [
  'draft',
  'scheduled',
  'active',
  'closed',
];

/** O que cada estado significa para quem opera (01 §1.1). */
export const SEASON_STATE_LABELS: Readonly<Record<BattlePassSeasonState, string>> = {
  draft: 'Rascunho',
  scheduled: 'Programada',
  active: 'No ar',
  closed: 'Encerrada',
};

/** O que o JOGADOR vê em cada estado. A tela mostra isto junto. */
export const SEASON_STATE_HINTS: Readonly<Record<BattlePassSeasonState, string>> = {
  draft: 'ninguém vê; ainda está sendo montada',
  scheduled: 'pronta e publicada, esperando o mês chegar',
  active: 'é o mês corrente e a trilha está na tela do jogo',
  closed: 'o mês passou; fica só o histórico',
};

/**
 * A cor de cada estado — borda e ícone, nunca texto.
 *
 * `--rust-red` dá 3,74:1 e não passa em contraste (globals.css:98),
 * então `closed` usa a borda vermelha com o texto em `--text`.
 */
export const SEASON_STATE_TONES: Readonly<Record<BattlePassSeasonState, string>> = {
  draft: 'border-border text-muted',
  scheduled: 'border-chart-2 text-foreground',
  active: 'border-olive text-olive',
  closed: 'border-rust text-foreground',
};

export const LANES: readonly BattlePassLane[] = ['free', 'paid'];

export const LANE_LABELS: Readonly<Record<BattlePassLane, string>> = {
  free: 'Grátis',
  paid: 'Pago',
};

export const CELL_STATE_LABELS: Readonly<Record<BattlePassCellState, string>> = {
  locked: 'Trancada',
  available: 'Pode levar',
  claimed: 'Levou',
  pending: 'Esperando entrega',
};

export const ENTITLEMENT_ORIGIN_LABELS: Readonly<Record<BattlePassEntitlementOrigin, string>> = {
  loja: 'loja do jogo',
  painel: 'painel',
  site: 'site',
};

export const PENDING_ORIGIN_LABELS: Readonly<Record<BattlePassPendingOrigin, string>> = {
  inventory: 'não coube na mochila',
  rollover: 'sobrou da temporada',
};

export const AUDIT_SOURCE_LABELS: Readonly<Record<BattlePassAuditSource, string>> = {
  panel: 'painel',
  game: 'jogo',
  system: 'sistema',
  site: 'site',
};

/** Estado desconhecido (ou ausente) vira "não sei", e não um palpite. */
export function safeSeasonState(value: unknown): BattlePassSeasonState | null {
  return typeof value === 'string' && (SEASON_STATES as readonly string[]).includes(value)
    ? (value as BattlePassSeasonState)
    : null;
}

export function safeLane(value: unknown): BattlePassLane | null {
  return value === 'free' || value === 'paid' ? value : null;
}

/**
 * O estado de uma casa PARA UM JOGADOR.
 *
 * Desconhecido cai em `locked`, que é o lado seguro: a tela nunca
 * promete que alguém pode levar uma recompensa por causa de um
 * campo que não veio.
 */
export function safeCellState(value: unknown): BattlePassCellState {
  return value === 'available' || value === 'claimed' || value === 'pending' ? value : 'locked';
}

// ------------------------------------------------------------
//  AS RECOMPENSAS
// ------------------------------------------------------------

const REWARD_KINDS: readonly QuestRewardKind[] = ['item', 'coins', 'kit', 'points', 'vip', 'skin'];

/** O `RewardList` sabe editar este tipo? */
export function isKnownRewardKind(kind: string): kind is QuestRewardKind {
  return (REWARD_KINDS as readonly string[]).includes(kind);
}

/**
 * Uma recompensa, campo a campo.
 *
 * O tipo que este painel não conhece volta INTEIRO, como veio: ver
 * a quinta regra no cabeçalho. Quem não for nem objeto vira `null` e
 * some — isso não é uma recompensa, é lixo.
 */
export function safeReward(value: unknown): QuestReward | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const reward = value as Record<string, unknown>;
  const kind = text(reward.kind);

  switch (kind) {
    case 'item':
      return {
        kind: 'item',
        shortname: text(reward.shortname),
        amount: integer(reward.amount, 1),
        // TEXTO: o id do Workshop passa de 2^53, e `'0'` é "sem skin".
        skinId: text(reward.skinId) === '' ? '0' : text(reward.skinId),
      };

    case 'coins':
      return {
        kind: 'coins',
        amount: nullableNumber(reward.amount),
        perMeter: nullableNumber(reward.perMeter),
        min: nullableNumber(reward.min),
        max: nullableNumber(reward.max),
      };

    case 'kit':
      return { kind: 'kit', slug: text(reward.slug) };

    case 'points':
      return { kind: 'points', metric: text(reward.metric), amount: integer(reward.amount, 1) };

    case 'vip':
      // O contrato do agente recusa `days` menor que 1 com uma frase
      // pronta; um zero aqui vira recusa visível, e não um VIP de
      // duração inventada por este arquivo.
      return { kind: 'vip', tier: text(reward.tier), days: integer(reward.days, 0) };

    case 'skin':
      return {
        kind: 'skin',
        shortname: text(reward.shortname),
        skinId: text(reward.skinId),
        days: nullableNumber(reward.days),
      };

    default:
      // Tipo que este painel não conhece (a frente B traz `xp`).
      // Preservado como veio — ver o cabeçalho.
      return kind === '' ? null : (value as QuestReward);
  }
}

export function safeRewards(list: unknown): QuestReward[] {
  if (!Array.isArray(list)) return [];

  const rewards: QuestReward[] = [];

  for (const entry of list) {
    const reward = safeReward(entry);

    if (reward !== null) rewards.push(reward);
  }

  return rewards;
}

/** A frase curta de uma recompensa — o que cabe numa casa da trilha. */
export function describeReward(reward: QuestReward): string {
  switch (reward.kind) {
    case 'item':
      return `${reward.shortname === '' ? 'item' : reward.shortname} ×${String(reward.amount)}`;

    case 'coins':
      return reward.amount === null
        ? `${String(reward.perMeter ?? 0)} OZCoin por metro`
        : `${reward.amount.toLocaleString('pt-BR')} OZCoin`;

    case 'kit':
      return `kit "${reward.slug}"`;

    case 'points':
      return `${String(reward.amount)} pontos em ${reward.metric === '' ? '—' : reward.metric}`;

    case 'vip':
      return `VIP ${reward.tier} por ${String(reward.days)} dia(s)`;

    case 'skin':
      return `skin ${reward.shortname === '' ? '' : `${reward.shortname} `}${reward.skinId}${
        reward.days === null ? '' : ` (${String(reward.days)} dia(s))`
      }`;

    default:
      // Ver a quinta regra: ela existe, e a tela diz isso em vez de
      // fingir que a casa está vazia.
      return `recompensa "${text((reward as { kind?: unknown }).kind)}" (este painel não sabe editar)`;
  }
}

// ------------------------------------------------------------
//  A TEMPORADA
// ------------------------------------------------------------

/**
 * A curva de quem não escolheu nenhuma. A mesma do agente.
 *
 * O tipo é o RAMO `flat`, e não a união: assim `DEFAULT_XP_CURVE.perLevel`
 * se lê sem um `if` que não decide nada.
 */
export const DEFAULT_XP_CURVE: Extract<BattlePassXpCurve, { kind: 'flat' }> = {
  kind: 'flat',
  perLevel: 1000,
};

/**
 * A curva de XP.
 *
 * Curva desconhecida NÃO vira `null`: a tela precisa de uma para
 * desenhar a trilha, e `null` aqui viraria o TypeError que este
 * arquivo existe para evitar. Ela cai na do agente — a mesma que ele
 * usa quando ninguém escolheu — e a aba Configuração mostra qual é.
 */
export function safeCurve(value: unknown): BattlePassXpCurve {
  const curve = fields(value);

  switch (curve.kind) {
    case 'flat':
      return { kind: 'flat', perLevel: integer(curve.perLevel, DEFAULT_XP_CURVE.perLevel, 1) };

    case 'linear':
      return { kind: 'linear', base: integer(curve.base, 1000, 1), step: integer(curve.step, 0) };

    case 'table':
      return {
        kind: 'table',
        steps: Array.isArray(curve.steps) ? curve.steps.map((step) => integer(step, 0)) : [],
      };

    default:
      return DEFAULT_XP_CURVE;
  }
}

export function safeSeason(value: unknown): BattlePassSeason {
  const season = fields(value);

  return {
    id: integer(season.id, 0),
    period: text(season.period),
    label: text(season.label),
    levels: integer(season.levels, 1, 1),
    xpCurve: safeCurve(season.xpCurve),
    state: safeSeasonState(season.state),
    // As três chaves caem no lado seguro: faixa ausente NÃO aparece
    // para o jogador, e retroativo ausente NÃO promete os níveis
    // passados a quem comprar. O agente as manda sempre; o padrão
    // aqui é para quando ele não manda.
    freeLane: season.freeLane === true,
    paidLane: season.paidLane === true,
    retroactive: season.retroactive === true,
    description: nullableText(season.description),
    servers: Array.isArray(season.servers) ? season.servers.map(text) : [],
    createdBy: nullableText(season.createdBy),
    createdAt: text(season.createdAt),
    updatedAt: text(season.updatedAt),
  };
}

export function safeSeasons(list: unknown): BattlePassSeason[] {
  return Array.isArray(list) ? list.map(safeSeason) : [];
}

/** A temporada que pode não ter vindo (a do mês que vem, por exemplo). */
export function safeNullableSeason(value: unknown): BattlePassSeason | null {
  return value === null || value === undefined ? null : safeSeason(value);
}

// ------------------------------------------------------------
//  A TRILHA
// ------------------------------------------------------------

/**
 * Uma casa da trilha.
 *
 * Sem faixa ou sem nível ela é DESCARTADA (`null`): uma casa que não
 * sabe onde fica não tem lugar na grade, e desenhá-la "em algum
 * lugar" seria pior que não desenhá-la.
 */
export function safeTrackCell(value: unknown): BattlePassTrackCell | null {
  const cell = fields(value);
  const lane = safeLane(cell.lane);
  const level = nullableNumber(cell.level);

  if (lane === null || level === null || level < 1) return null;

  return {
    seasonId: integer(cell.seasonId, 0),
    level: Math.trunc(level),
    lane,
    rewards: safeRewards(cell.rewards),
    milestone: cell.milestone === true,
    updatedAt: text(cell.updatedAt),
  };
}

export function safeTrackCells(list: unknown): BattlePassTrackCell[] {
  if (!Array.isArray(list)) return [];

  const cells: BattlePassTrackCell[] = [];

  for (const entry of list) {
    const cell = safeTrackCell(entry);

    if (cell !== null) cells.push(cell);
  }

  return cells;
}

/** A casa já resolvida para um jogador: com o estado e o motivo. */
export function safeTrackCellView(value: unknown): BattlePassTrackCellView | null {
  const cell = safeTrackCell(value);

  if (cell === null) return null;

  const view = fields(value);

  return { ...cell, state: safeCellState(view.state), reason: nullableText(view.reason) };
}

export function safeTrackCellViews(list: unknown): BattlePassTrackCellView[] {
  if (!Array.isArray(list)) return [];

  const cells: BattlePassTrackCellView[] = [];

  for (const entry of list) {
    const cell = safeTrackCellView(entry);

    if (cell !== null) cells.push(cell);
  }

  return cells;
}

/** A chave de uma casa na grade: `12:free`. */
export function cellKey(level: number, lane: BattlePassLane): string {
  return `${String(level)}:${lane}`;
}

// ------------------------------------------------------------
//  O XP
// ------------------------------------------------------------

export function safeXpRule(value: unknown): BattlePassXpRule {
  const rule = fields(value);

  return {
    seasonId: integer(rule.seasonId, 0),
    source: text(rule.source),
    // Lado seguro: regra que chegou sem o campo NÃO paga XP.
    enabled: rule.enabled === true,
    amount: integer(rule.amount, 0),
    // `null` = sem teto, que é o que o contrato diz. Um número
    // inventado aqui apertaria a torneira sem ninguém ter pedido.
    dailyCap: nullableNumber(rule.dailyCap),
    label: nullableText(rule.label),
    updatedAt: text(rule.updatedAt),
  };
}

export function safeXpRules(list: unknown): BattlePassXpRule[] {
  return Array.isArray(list) ? list.map(safeXpRule).filter((rule) => rule.source !== '') : [];
}

/**
 * Uma fonte do CARDÁPIO — a lista do que o agente sabe medir.
 *
 * Fonte sem chave é descartada: ela não tem como ser ligada (a chave
 * é o `:source` da rota), e oferecê-la seria oferecer XP por algo que
 * o agente nunca vai contar.
 */
export function safeXpSource(value: unknown): BattlePassXpSource | null {
  const source = fields(value);
  const key = text(source.source);

  if (key === '') return null;

  return {
    source: key,
    label: text(source.label) === '' ? key : text(source.label),
    hint: nullableText(source.hint),
    warning: nullableText(source.warning),
    // Lado seguro: o agente precisa DIZER que recomenda ligar. Sem o
    // campo, a tela não sugere nada — `sleeper.kills` não pode nascer
    // ligado por omissão.
    recommended: source.recommended === true,
    // Lado seguro aqui é `batch`: com ele a tela PEDE o valor, e o
    // pior caso é um campo a mais. Cair em `event` por omissão
    // esconderia o campo de uma fonte que precisa dele, e a fonte
    // passaria a pagar zero sem ninguém ver onde mexer.
    feed: source.feed === 'event' ? 'event' : 'batch',
  };
}

export function safeXpSources(list: unknown): BattlePassXpSource[] {
  if (!Array.isArray(list)) return [];

  const sources: BattlePassXpSource[] = [];

  for (const entry of list) {
    const source = safeXpSource(entry);

    if (source !== null) sources.push(source);
  }

  return sources;
}

/**
 * As fontes com pegadinha que o PAINEL conhece.
 *
 * O cardápio é do agente (06 §7) e o aviso dele vem no `warning` da
 * fonte; estes dois estão escritos aqui porque já foram medidos e
 * documentados (06 §4) antes de existir campo para eles — e um aviso
 * que só aparece depois da reclamação não serve para nada.
 *
 * A chave casa por prefixo: `gather.` cobre `gather.stone` e os
 * outros todos.
 */
const KNOWN_CAVEATS: readonly { readonly prefix: string; readonly warning: string }[] = [
  {
    prefix: 'sleeper.kills',
    warning:
      'Paga quem anda de machado por base vazia: o jogador dormindo não reage, e a fonte vira XP de graça. O agente não a liga sozinha.',
  },
  {
    prefix: 'gather.',
    warning:
      'Depende do ranking correspondente estar habilitado. Desligado o ranking, esta fonte para de pagar em silêncio — e ninguém vai relacionar as duas coisas.',
  },
];

/** O aviso daquela fonte: o do agente, e o que o painel já sabia. */
export function caveatOf(source: BattlePassXpSource): string | null {
  if (source.warning !== null) return source.warning;

  return KNOWN_CAVEATS.find((entry) => source.source.startsWith(entry.prefix))?.warning ?? null;
}

/** Uma linha da aba XP: a fonte do cardápio, a regra gravada, ou as duas. */
export interface XpRow {
  readonly source: string;
  readonly label: string;
  readonly hint: string | null;
  readonly warning: string | null;
  readonly recommended: boolean;
  /**
   * De onde o XP chega — e o que decide se a linha pede um valor.
   *
   * `event` é a missão: quem diz quanto ela paga é a recompensa
   * dela. A órfã cai em `batch`, porque sem cardápio não há como
   * saber, e esconder o campo de quem precisa dele é pior.
   */
  readonly feed: 'batch' | 'event';
  /** `null` = está no cardápio e ainda não foi configurada. */
  readonly rule: BattlePassXpRule | null;
  /** Gravada, mas fora do cardápio: ela pode não medir mais nada. */
  readonly orphan: boolean;
}

/**
 * As linhas da aba XP: o cardápio do agente, mais o que já foi
 * gravado.
 *
 * ####  REGRA GRAVADA FORA DO CARDÁPIO NÃO SOME DA TELA  ####
 *
 * Ela continua valendo no agente — é uma linha no banco, e desligá-la
 * exige vê-la. Sumir seria a pior das duas opções: XP sendo pago (ou
 * não sendo) por uma fonte que o painel decidiu não mostrar. Ela
 * aparece marcada como órfã, e a tela explica o que isso quer dizer.
 *
 * A ordem é a do cardápio, que é a que o agente escolheu; as órfãs
 * vão para o fim.
 */
export function buildXpRows(
  sources: readonly BattlePassXpSource[],
  rules: readonly BattlePassXpRule[],
): XpRow[] {
  const pending = new Map(rules.map((rule) => [rule.source, rule]));
  const rows: XpRow[] = [];

  for (const source of sources) {
    const rule = pending.get(source.source) ?? null;

    rows.push({
      source: source.source,
      label: rule?.label ?? source.label,
      hint: source.hint,
      warning: caveatOf(source),
      recommended: source.recommended,
      feed: source.feed,
      rule,
      orphan: false,
    });

    pending.delete(source.source);
  }

  for (const rule of pending.values()) {
    rows.push({
      source: rule.source,
      label: rule.label ?? rule.source,
      hint: null,
      feed: 'batch',
      // A pegadinha continua valendo mesmo sem cardápio: é a chave da
      // fonte que a denuncia, e não o verbete do agente.
      warning: caveatOf({
        source: rule.source,
        label: rule.source,
        hint: null,
        feed: 'batch',
        warning: null,
        recommended: false,
      }),
      recommended: false,
      rule,
      orphan: true,
    });
  }

  return rows;
}

// ------------------------------------------------------------
//  O PROGRESSO, O DIREITO E A CAIXA
// ------------------------------------------------------------

export function safeProgress(value: unknown): BattlePassProgress {
  const progress = fields(value);

  return {
    serverId: text(progress.serverId),
    // TEXTO: SteamID64 passa de 2^53.
    steamId: text(progress.steamId),
    seasonId: integer(progress.seasonId, 0),
    xp: integer(progress.xp, 0),
    // O nível ALCANÇADO começa em 1: quem nasce já está no primeiro.
    level: integer(progress.level, 1, 1),
    updatedAt: text(progress.updatedAt),
  };
}

export function safeProgressList(list: unknown): BattlePassProgress[] {
  return Array.isArray(list) ? list.map(safeProgress).filter((row) => row.steamId !== '') : [];
}

/** A barra do card: onde ele está e quanto falta. */
export function safeTrackProgress(value: unknown): BattlePassTrackProgress {
  const progress = fields(value);

  return {
    level: integer(progress.level, 1, 1),
    xp: integer(progress.xp, 0),
    intoLevel: integer(progress.intoLevel, 0),
    // `null` no último nível: não há próximo para comprar.
    neededForNext: nullableNumber(progress.neededForNext),
    completed: progress.completed === true,
  };
}

export function safeEntitlement(value: unknown): BattlePassEntitlement {
  const entitlement = fields(value);
  const revokedAt = nullableText(entitlement.revokedAt);
  const origin = entitlement.origin;

  return {
    id: integer(entitlement.id, 0),
    serverId: text(entitlement.serverId),
    steamId: text(entitlement.steamId),
    period: text(entitlement.period),
    origin:
      origin === 'loja' || origin === 'painel' || origin === 'site'
        ? origin
        : // Origem desconhecida não some e não vira erro: o registro
          // fica, e a tela mostra de onde ela diz que veio.
          'site',
    levelAtGrant: integer(entitlement.levelAtGrant, 1, 1),
    sourceRef: nullableText(entitlement.sourceRef),
    note: nullableText(entitlement.note),
    createdAt: text(entitlement.createdAt),
    createdBy: text(entitlement.createdBy),
    revokedAt,
    revokedBy: nullableText(entitlement.revokedBy),
    // Derivado: sem o campo, quem decide é a data da revogação.
    active: typeof entitlement.active === 'boolean' ? entitlement.active : revokedAt === null,
  };
}

export function safeEntitlements(list: unknown): BattlePassEntitlement[] {
  return Array.isArray(list) ? list.map(safeEntitlement) : [];
}

export function safePending(value: unknown): BattlePassPendingDelivery {
  const pending = fields(value);
  const origin = pending.origin;

  return {
    id: integer(pending.id, 0),
    claimId: integer(pending.claimId, 0),
    idx: integer(pending.idx, 0),
    serverId: text(pending.serverId),
    steamId: text(pending.steamId),
    origin: origin === 'rollover' ? 'rollover' : 'inventory',
    reward: safeReward(pending.reward),
    code: nullableText(pending.code),
    attempts: integer(pending.attempts, 0),
    seenAt: nullableText(pending.seenAt),
    deliveredAt: nullableText(pending.deliveredAt),
    createdAt: text(pending.createdAt),
    updatedAt: text(pending.updatedAt),
  };
}

export function safePendingList(list: unknown): BattlePassPendingDelivery[] {
  return Array.isArray(list) ? list.map(safePending) : [];
}

export function safePlayerTrack(value: unknown): BattlePassPlayerTrack {
  const track = fields(value);

  return {
    serverId: text(track.serverId),
    steamId: text(track.steamId),
    season: safeNullableSeason(track.season ?? null),
    progress: safeTrackProgress(track.progress),
    // Lado seguro: sem o campo, ele NÃO comprou — a tela não promete
    // faixa paga a quem talvez não tenha direito a ela.
    paid: track.paid === true,
    cells: safeTrackCellViews(track.cells),
    pending: safePendingList(track.pending),
    unseen: track.unseen === true,
  };
}

// ------------------------------------------------------------
//  O REGISTRO E A VISÃO GERAL
// ------------------------------------------------------------

export function safeAuditEntry(value: unknown): BattlePassAuditEntry {
  const entry = fields(value);
  const source = entry.source;
  const detail = entry.detail;

  return {
    id: integer(entry.id, 0),
    at: text(entry.at),
    actor: text(entry.actor),
    source:
      source === 'game' || source === 'system' || source === 'site'
        ? source
        : // Desconhecida cai em `panel`, que é de onde vem a maior
          // parte — e o `actor` ao lado diz quem foi de verdade.
          'panel',
    action: text(entry.action),
    target: text(entry.target),
    serverId: nullableText(entry.serverId),
    steamId: nullableText(entry.steamId),
    detail: fields(detail),
  };
}

export function safeAuditEntries(list: unknown): BattlePassAuditEntry[] {
  return Array.isArray(list) ? list.map(safeAuditEntry) : [];
}

export function safeOverview(value: unknown): BattlePassOverview {
  const overview = fields(value);

  return {
    serverId: text(overview.serverId),
    period: text(overview.period),
    season: safeNullableSeason(overview.season ?? null),
    next: safeNullableSeason(overview.next ?? null),
    owners: integer(overview.owners, 0),
    players: integer(overview.players, 0),
  };
}

// ------------------------------------------------------------
//  O CALENDÁRIO DA TEMPORADA
// ------------------------------------------------------------

const MONTHS: readonly string[] = [
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
];

/** `2026-10` partido em ano e mês. `null` quando não é um período. */
export function parsePeriod(period: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period.trim());

  if (match === null) return null;

  return { year: Number(match[1]), month: Number(match[2]) };
}

/** `2026-10` vira "outubro de 2026". O que não é período volta como veio. */
export function periodLabel(period: string): string {
  const parsed = parsePeriod(period);

  if (parsed === null) return period === '' ? '—' : period;

  return `${MONTHS[parsed.month - 1] ?? String(parsed.month)} de ${String(parsed.year)}`;
}

/** O mês seguinte: `2026-12` vira `2027-01`. */
export function nextPeriodOf(period: string): string {
  const parsed = parsePeriod(period);

  if (parsed === null) return period;

  const year = parsed.month === 12 ? parsed.year + 1 : parsed.year;
  const month = parsed.month === 12 ? 1 : parsed.month + 1;

  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

/** Quantos dias o mês da temporada tem. `null` fora de um período. */
export function daysInPeriod(period: string): number | null {
  const parsed = parsePeriod(period);

  return parsed === null ? null : new Date(parsed.year, parsed.month, 0).getDate();
}

/**
 * Quantos dias faltam para a temporada fechar.
 *
 * ####  O RELÓGIO AQUI É O DO NAVEGADOR  ####
 *
 * O fuso que manda no passe é o do AGENTE (01 §1.2), e o navegador
 * pode estar em outro. Por isso o número sai na tela com "~" e nunca
 * decide nada: quem fecha a temporada é o agente.
 */
export function daysLeftInPeriod(period: string, now: number = Date.now()): number | null {
  const parsed = parsePeriod(period);

  if (parsed === null) return null;

  const endsAt = new Date(parsed.year, parsed.month, 1).getTime();

  return Math.max(0, Math.ceil((endsAt - now) / 86_400_000));
}

/** Os N meses a partir do de hoje, para o seletor da temporada nova. */
export function upcomingPeriods(count: number, now: number = Date.now()): string[] {
  const start = new Date(now);
  const periods: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const month = new Date(start.getFullYear(), start.getMonth() + index, 1);

    periods.push(`${String(month.getFullYear())}-${String(month.getMonth() + 1).padStart(2, '0')}`);
  }

  return periods;
}

// ------------------------------------------------------------
//  A CURVA, E QUANTO TEMPO A TRILHA LEVA
// ------------------------------------------------------------

/** O custo do degrau `step` (1 = sair do nível 1 e chegar ao 2). */
function stepCost(curve: BattlePassXpCurve, step: number): number {
  if (step < 1) return 0;

  switch (curve.kind) {
    case 'flat':
      return curve.perLevel;

    case 'linear':
      return curve.base + curve.step * (step - 1);

    default:
      return curve.steps[step - 1] ?? 0;
  }
}

/** O XP para alcançar `level` vindo do anterior. O nível 1 é de graça. */
export function levelCost(curve: BattlePassXpCurve, level: number): number {
  return level <= 1 ? 0 : stepCost(curve, level - 1);
}

/** O XP acumulado que o nível `level` exige desde o começo do mês. */
export function xpToReach(curve: BattlePassXpCurve, level: number): number {
  let total = 0;

  for (let current = 2; current <= level; current += 1) {
    total += levelCost(curve, current);
  }

  return total;
}

export interface TrackEstimate {
  /** O XP que a trilha inteira custa. */
  readonly totalXp: number;
  /** Quantas fontes estão ligadas E pagando mais que zero. */
  readonly paying: number;
  /** O que um jogador dedicado consegue por dia, somando os tetos. */
  readonly dailyXp: number;
  /** Em quantos dias ele termina nesse ritmo. `null` = não dá para saber. */
  readonly days: number | null;
  /** Quantas fontes ligadas não têm teto — elas encurtam o prazo. */
  readonly uncapped: number;
  /** Quantos dias o mês tem. */
  readonly monthDays: number | null;
  /**
   * O veredito, que é o motivo desta conta existir.
   *
   *   ok       termina com pelo menos uma semana de folga
   *   tight    termina, mas só no fim do mês
   *   overrun  NÃO dá para terminar dentro do mês
   *   unknown  falta teto diário em tudo: não há ritmo para medir
   */
  readonly verdict: 'ok' | 'tight' | 'overrun' | 'unknown';
}

/**
 * Quanto tempo leva para terminar a trilha, no ritmo configurado.
 *
 * ####  POR QUE ESTA CONTA ESTÁ NA TELA  ####
 *
 * A falha nº 1 dos passes, medida nos sete jogos de referência
 * (05 §4.4), é a temporada que NÃO DÁ PARA TERMINAR — e o alvo é ser
 * completável cerca de uma semana antes do fim. Uma linha dizendo
 * "no ritmo configurado, a trilha leva ~N dias" vale mais que
 * qualquer aviso depois da reclamação.
 *
 * ####  O RITMO É A SOMA DOS TETOS, E ISSO É DE PROPÓSITO  ####
 *
 * Fonte SEM teto é torneira aberta: quem joga o dia inteiro termina
 * mais cedo, e nenhuma conta honesta diz quanto. Por isso o número
 * sai dos tetos (o ritmo de quem esgota o dia) e as fontes sem teto
 * entram como `uncapped`, com a tela dizendo que elas encurtam o
 * prazo.
 */
export function estimateTrack(input: {
  readonly curve: BattlePassXpCurve;
  readonly levels: number;
  readonly rules: readonly BattlePassXpRule[];
  readonly period: string;
}): TrackEstimate {
  const totalXp = xpToReach(input.curve, input.levels);
  const paying = input.rules.filter((rule) => rule.enabled && rule.amount > 0);

  let dailyXp = 0;
  let uncapped = 0;

  for (const rule of paying) {
    if (rule.dailyCap === null) uncapped += 1;
    else dailyXp += rule.dailyCap;
  }

  const monthDays = daysInPeriod(input.period);
  const days = dailyXp > 0 ? Math.ceil(totalXp / dailyXp) : null;

  let verdict: TrackEstimate['verdict'] = 'unknown';

  if (days !== null && monthDays !== null) {
    if (days > monthDays) verdict = 'overrun';
    else if (days > monthDays - 7) verdict = 'tight';
    else verdict = 'ok';
  } else if (days !== null) {
    verdict = 'ok';
  }

  return { totalXp, paying: paying.length, dailyXp, days, uncapped, monthDays, verdict };
}

/** SteamID64 de conta de usuário: a mesma régua do agente. */
export const STEAM_ID_PATTERN = /^7656\d{13}$/;
