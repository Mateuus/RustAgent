// ============================================================
//  normalize.ts  -  o que o agente manda, com padrão em cada campo.
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  Um campo que o agente omitir vira TypeError no render e derruba
//  a página inteira com "This page couldn't load". Toda resposta do
//  Workshop passa por uma destas funções antes de chegar ao JSX —
//  e elas moram juntas porque as quatro abas leem skins, e duas
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
  WorkshopCollection,
  WorkshopGrant,
  WorkshopLookup,
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

export function safeSkin(skin: WorkshopSkin): WorkshopSkin {
  return {
    id: Number(skin.id),
    label: text(skin.label),
    shortname: text(skin.shortname),
    skinId: text(skin.skinId),
    permission: nullableText(skin.permission),
    collectionId: nullableNumber(skin.collectionId),
    openToAll: skin.openToAll === true,
    hideInStreamer: skin.hideInStreamer === true,
    enabled: skin.enabled === true,
    servers: Array.isArray(skin.servers) ? skin.servers.map(text) : [],
    source: skin.source === 'game' ? 'game' : 'panel',
    createdBy: nullableText(skin.createdBy),
    workshopTitle: nullableText(skin.workshopTitle),
    previewUrl: nullableText(skin.previewUrl),
    createdAt: text(skin.createdAt),
    updatedAt: text(skin.updatedAt),
  };
}

export function safeCollection(collection: WorkshopCollection): WorkshopCollection {
  return {
    id: Number(collection.id),
    slug: text(collection.slug),
    label: text(collection.label),
    permission: nullableText(collection.permission),
    openToAll: collection.openToAll === true,
    enabled: collection.enabled === true,
    skinCount: Number(collection.skinCount ?? 0),
    createdBy: nullableText(collection.createdBy),
    createdAt: text(collection.createdAt),
    updatedAt: text(collection.updatedAt),
  };
}

export function safeGrant(grant: WorkshopGrant): WorkshopGrant {
  return {
    id: Number(grant.id),
    subjectType: grant.subjectType === 'group' ? 'group' : 'player',
    subject: text(grant.subject),
    targetType: grant.targetType === 'collection' ? 'collection' : 'skin',
    targetId: Number(grant.targetId),
    targetLabel: text(grant.targetLabel),
    targetShortname: nullableText(grant.targetShortname),
    expiresAt: nullableText(grant.expiresAt),
    expired: grant.expired === true,
    note: text(grant.note),
    createdBy: nullableText(grant.createdBy),
    createdAt: text(grant.createdAt),
    updatedAt: text(grant.updatedAt),
  };
}

export function safeAuditEntry(entry: WorkshopAuditEntry): WorkshopAuditEntry {
  const detail = entry.detail;

  return {
    id: Number(entry.id),
    at: text(entry.at),
    actor: text(entry.actor),
    source: entry.source === 'game' || entry.source === 'system' ? entry.source : 'panel',
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

/** Grupo do Oxide: a mesma régua do agente. */
export const OXIDE_GROUP_PATTERN = /^[a-z0-9_.-]{1,64}$/;

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
 * É como a coleção e o acesso as mostram: a pergunta ali é "qual
 * máscara?", e não "qual das 40 skins?".
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
      skins: [...list].sort((left, right) => left.label.localeCompare(right.label, 'pt-BR')),
    }));
}

/** A mensagem de um erro qualquer, sem `[object Object]`. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
