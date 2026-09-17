// ============================================================
//  normalize.ts  -  o que o agente manda, com padrão em cada campo.
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  Um campo que o agente omitir vira TypeError no render e derruba
//  a página inteira com "This page couldn't load". Toda resposta do
//  Workshop passa por uma destas funções antes de chegar ao JSX —
//  e elas moram juntas porque as abas (e a ficha do jogador) leem skins, e duas
//  cópias do `safeSkin` divergiriam no primeiro campo novo.
//
//  ####  `skinId` E `steamId` SÃO TEXTO  ####
//
//  Os dois passam de 2^53. `String(...)` aqui não conserta um número
//  que já chegou arredondado, mas impede a tela de arredondá-lo de
//  novo.
// ============================================================

import type {
  WorkshopAuditEntry,
  WorkshopLookup,
  WorkshopOwned,
  WorkshopOwnedSkin,
  WorkshopOwnedSource,
  WorkshopRarity,
  WorkshopSkin,
} from '@/lib/api';

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** As raridades, na ordem do menu: da mais comum à mais rara. */
export const RARITIES: readonly WorkshopRarity[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
];

export const RARITY_LABELS: Readonly<Record<WorkshopRarity, string>> = {
  common: 'Comum',
  uncommon: 'Incomum',
  rare: 'Rara',
  epic: 'Épica',
  legendary: 'Lendária',
};

/** A cor do rótulo de cada raridade, nos tokens do painel. */
export const RARITY_TONES: Readonly<Record<WorkshopRarity, string>> = {
  common: 'border-muted text-muted',
  uncommon: 'border-olive text-olive',
  rare: 'border-chart-2 text-chart-2',
  epic: 'border-chart-4 text-chart-4',
  legendary: 'border-amber text-amber',
};

/** Raridade desconhecida (ou ausente) vira "sem raridade", e não erro. */
export function safeRarity(value: unknown): WorkshopRarity | null {
  return typeof value === 'string' && (RARITIES as readonly string[]).includes(value)
    ? (value as WorkshopRarity)
    : null;
}

export function safeSkin(skin: WorkshopSkin): WorkshopSkin {
  return {
    id: Number(skin.id),
    label: text(skin.label),
    shortname: text(skin.shortname),
    skinId: text(skin.skinId),
    description: nullableText(skin.description),
    rarity: safeRarity(skin.rarity),
    sort: nullableNumber(skin.sort) ?? 0,
    openToAll: skin.openToAll === true,
    hideInStreamer: skin.hideInStreamer === true,
    enabled: skin.enabled === true,
    servers: Array.isArray(skin.servers) ? skin.servers.map(text) : [],
    source: skin.source === 'game' ? 'game' : 'panel',
    createdBy: nullableText(skin.createdBy),
    workshopTitle: nullableText(skin.workshopTitle),
    previewUrl: nullableText(skin.previewUrl),
    owners: nullableNumber(skin.owners) ?? 0,
    createdAt: text(skin.createdAt),
    updatedAt: text(skin.updatedAt),
  };
}

const OWNED_SOURCES: readonly WorkshopOwnedSource[] = [
  'site',
  'panel',
  'game',
  'system',
  'migration',
];

export const OWNED_SOURCE_LABELS: Readonly<Record<WorkshopOwnedSource, string>> = {
  site: 'site',
  panel: 'painel',
  game: 'jogo',
  system: 'sistema',
  migration: 'migração',
};

function safeOwnedSkin(skin: unknown): WorkshopOwnedSkin | null {
  if (skin === null || typeof skin !== 'object') return null;

  const value = skin as Partial<Record<keyof WorkshopOwnedSkin, unknown>>;

  return {
    id: Number(value.id),
    label: text(value.label),
    shortname: text(value.shortname),
    workshopId: text(value.workshopId),
    description: nullableText(value.description),
    rarity: safeRarity(value.rarity),
    previewUrl: nullableText(value.previewUrl),
    openToAll: value.openToAll === true,
    enabled: value.enabled === true,
    servers: Array.isArray(value.servers) ? value.servers.map(text) : [],
  };
}

export function safeOwned(owned: WorkshopOwned): WorkshopOwned {
  const expiresAt = nullableText(owned.expiresAt);

  return {
    id: Number(owned.id),
    steamId: text(owned.steamId),
    skinId: Number(owned.skinId),
    expiresAt,
    // Sem o campo, o prazo decide: a tela não pode chamar de viva uma
    // posse que já passou.
    expired:
      typeof owned.expired === 'boolean'
        ? owned.expired
        : expiresAt !== null && Date.parse(expiresAt) <= Date.now(),
    source: (OWNED_SOURCES as readonly string[]).includes(owned.source)
      ? owned.source
      : 'system',
    sourceRef: nullableText(owned.sourceRef),
    note: nullableText(owned.note),
    createdBy: text(owned.createdBy),
    createdAt: text(owned.createdAt),
    updatedAt: text(owned.updatedAt),
    skin: safeOwnedSkin(owned.skin),
  };
}

/** Uma lista que pode nem ter vindo. */
export function safeOwnedList(list: unknown): WorkshopOwned[] {
  return Array.isArray(list) ? (list as WorkshopOwned[]).map(safeOwned) : [];
}

export function safeAuditEntry(entry: WorkshopAuditEntry): WorkshopAuditEntry {
  const detail = entry.detail;

  return {
    id: Number(entry.id),
    at: text(entry.at),
    actor: text(entry.actor),
    source:
      entry.source === 'game' || entry.source === 'system' || entry.source === 'site'
        ? entry.source
        : 'panel',
    action: text(entry.action),
    target: text(entry.target),
    serverId: nullableText(entry.serverId),
    steamId: nullableText(entry.steamId),
    detail:
      detail !== null && typeof detail === 'object' && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : {},
  };
}

export function safeLookup(lookup: WorkshopLookup): WorkshopLookup {
  const details = lookup.details;
  const verdict = lookup.verdict;

  return {
    ok: true,
    status:
      lookup.status === 'found' || lookup.status === 'not_found' ? lookup.status : 'unavailable',
    details:
      details === null || details === undefined || typeof details !== 'object'
        ? null
        : {
            workshopId: text(details.workshopId),
            title: text(details.title),
            previewUrl: nullableText(details.previewUrl),
            appId: nullableNumber(details.appId),
            banned: details.banned === true,
            tags: Array.isArray(details.tags) ? details.tags.map(text) : [],
          },
    reason: nullableText(lookup.reason),
    suggestedShortnames: Array.isArray(lookup.suggestedShortnames)
      ? lookup.suggestedShortnames.map(text).filter((name) => name !== '')
      : [],
    verdict:
      verdict === null || verdict === undefined || typeof verdict !== 'object'
        ? null
        : verdict.ok === true
          ? { ok: true, warning: nullableText(verdict.warning) }
          : {
              ok: false,
              code: text((verdict as { code?: unknown }).code),
              message: text((verdict as { message?: unknown }).message),
            },
  };
}

/** SteamID64 de conta de usuário: a mesma régua do agente. */
export const STEAM_ID_PATTERN = /^7656\d{13}$/;

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "16/09/2026 14:30". Data ilegível volta como veio. */
export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);

  return Number.isNaN(time) ? iso : DATE_TIME.format(time);
}

/**
 * As skins agrupadas por item, na ordem do nome do item.
 *
 * É como a posse as mostra: a pergunta ali é "qual máscara?", e não
 * "qual das 40 skins?". Dentro do item, a ordem do menu (`sort`, e
 * o nome no empate).
 */
export function groupByShortname(
  skins: readonly WorkshopSkin[],
): { shortname: string; skins: WorkshopSkin[] }[] {
  const groups = new Map<string, WorkshopSkin[]>();

  for (const skin of skins) {
    const list = groups.get(skin.shortname);

    if (list === undefined) groups.set(skin.shortname, [skin]);
    else list.push(skin);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([shortname, list]) => ({
      shortname,
      skins: [...list].sort(
        (left, right) =>
          left.sort - right.sort || left.label.localeCompare(right.label, 'pt-BR'),
      ),
    }));
}

/** "permanente", "até 16/09/2026 14:30" ou "venceu em …". */
export function describeOwnedExpiry(owned: Pick<WorkshopOwned, 'expiresAt' | 'expired'>): string {
  if (owned.expiresAt === null) return 'permanente';

  return owned.expired
    ? `venceu em ${formatDateTime(owned.expiresAt)}`
    : `até ${formatDateTime(owned.expiresAt)}`;
}

/**
 * A posse bate com o que foi digitado na busca da ficha?
 *
 * Procura no nome, no item e no Workshop ID, sem caixa. Busca vazia
 * aceita tudo; posse cuja skin foi apagada só bate pelo número.
 */
export function ownedMatches(owned: WorkshopOwned, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;

  const skin = owned.skin;
  const haystack =
    skin === null
      ? [String(owned.skinId)]
      : [skin.label, skin.shortname, skin.workshopId, String(owned.skinId)];

  return haystack.some((value) => value.toLowerCase().includes(needle));
}

/** A mensagem de um erro qualquer, sem `[object Object]`. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
