'use client';

// ============================================================
//  audit-panel.tsx  -  tudo o que mudou nas skins, e quem mudou.
//
//  ####  QUATRO ORIGENS  ####
//
//  O painel (um usuário), o jogo (`/skin add` e `/skin give`, com
//  `jogo:<steamId>`), o site (venda e caixa, `site:<ref>`) e o
//  próprio agente (`sistema`: uma posse que venceu, a migração
//  097). Todas gravam no mesmo registro, mais novo primeiro.
//
//  `grant.*` e `collection.*` só aparecem em linhas antigas, de
//  antes da 097; os rótulos ficam para que elas continuem legíveis.
//
//  ####  O FILTRO É PELO JOGADOR AFETADO  ####
//
//  `steamId` é quem RECEBEU a posse (ou a perdeu), e não quem
//  clicou. É a pergunta do suporte: "por que ele não tem a skin?".
//
//  A ficha do jogador usa este mesmo painel com `fixedSteamId`: sem
//  o campo de filtro, e só com as linhas dele.
//
//  ####  PÁGINAS POR `before`  ####
//
//  A página seguinte pede as entradas com id menor que a menor desta.
//  Offset daria entrada repetida quando alguém grava no meio. O
//  `useCursorPages` (ui/pagination.tsx) guarda o `before` de cada
//  página já vista, e é isso que faz Anterior e os números voltarem.
//
//  A rota não diz o total nem se há mais: pedimos UMA a mais do que
//  a página mostra, e é essa sobra que diz se existe a próxima.
// ============================================================

import { Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination, useCursorPages, type CursorPage } from '@/components/ui/pagination';
import {
  formatDateTime,
  messageOf,
  safeAuditEntry,
  STEAM_ID_PATTERN,
} from '@/components/workshop/normalize';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import { agent, type WorkshopAuditEntry } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface AuditPanelProps {
  readonly servers: readonly WorkshopServerOption[];
  /** O filtro com que a aba abre. Vazio = tudo. */
  readonly initialSteamId?: string;
  /**
   * Trava o filtro neste jogador e esconde o campo — é a ficha dele.
   */
  readonly fixedSteamId?: string;
}

/** O registro é lido de passada: cabe mais numa página do que as outras listas. */
const DEFAULT_PAGE_SIZE = 50;

const ACTION_LABELS: Readonly<Record<string, string>> = {
  'skin.create': 'Skin cadastrada',
  'skin.update': 'Skin alterada',
  'skin.delete': 'Skin apagada',
  'skin.servers': 'Servidores da skin',
  'collection.create': 'Coleção criada',
  'collection.update': 'Coleção alterada',
  'collection.delete': 'Coleção apagada',
  'collection.skins': 'Itens da coleção',
  'owned.grant': 'Skin dada',
  'owned.revoke': 'Skin tirada',
  'owned.expired': 'Posse venceu',
  'owned.season-cleared': 'Posse de skins de temporada removida no wipe',
  'site.delivered': 'Entregue pelo site',
  'game.add-refused': 'Cadastro pelo jogo recusado',
  'game.give-refused': '/skin give recusado',
  'migration.097': 'Migração 097 (posse)',
  'migration.group-grant-dropped': 'Migração: acesso de grupo descartado',
  'migration.invalid-grant-dropped': 'Migração: acesso inválido descartado',
  'migration.collection-grant-expanded': 'Migração: coleção virou posse',
  'migration.permission-dropped': 'Migração: permissão descartada',
  'migration.collection-dropped': 'Migração: coleção removida',
  // Só em linhas de antes da 097.
  'grant.create': 'Acesso liberado (antigo)',
  'grant.update': 'Acesso renovado (antigo)',
  'grant.revoke': 'Acesso removido (antigo)',
  'grant.expire': 'Acesso venceu (antigo)',
};

/** O rótulo de uma ação; uma `migration.*` nova cai no genérico. */
export function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];

  if (known !== undefined) return known;
  if (action.startsWith('migration.')) return `Migração: ${action.slice('migration.'.length)}`;

  return action;
}

/** As ações que TIRAM algo, em vermelho; as que só registram, em cinza. */
function actionTone(action: string): string {
  if (
    action === 'game.add-refused' ||
    action === 'game.give-refused' ||
    action === 'owned.revoke' ||
    action === 'owned.season-cleared' ||
    action === 'grant.revoke' ||
    action === 'skin.delete'
  ) {
    return 'text-rust';
  }

  if (action === 'owned.expired' || action === 'grant.expire' || action.startsWith('migration.')) {
    return 'text-muted';
  }

  return 'text-foreground';
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  panel: 'painel',
  game: 'jogo',
  system: 'sistema',
  site: 'site',
};

const OWNED_ORIGIN_LABELS: Readonly<Record<string, string>> = {
  site: 'site',
  panel: 'painel',
  game: 'jogo',
  system: 'sistema',
  migration: 'migração',
};

/** Os campos de `detail.changed`, em português. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  label: 'nome',
  shortname: 'item',
  skinId: 'Workshop ID',
  description: 'descrição',
  rarity: 'raridade',
  sort: 'ordem',
  permission: 'permissão',
  collectionId: 'coleção',
  openToAll: 'para todos',
  hideInStreamer: 'esconde no streamer',
  enabled: 'valendo',
  season: 'de temporada',
  servers: 'servidores',
  slug: 'comando',
  workshopTitle: 'título no Workshop',
  previewUrl: 'prévia',
};

/**
 * Um número do detalhe, ou `null`.
 *
 * O detalhe vem do agente como JSON solto, e a régua do registro é a
 * mesma do resto do Workshop: campo ausente não derruba o render —
 * ele vira uma frase mais curta.
 */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (Array.isArray(value)) return value.length === 0 ? '(nenhum)' : value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);

  return String(value);
}

/** Prazo gravado no detalhe: epoch ms (ou ISO). `null` = permanente. */
function formatExpiry(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatDateTime(new Date(value).toISOString());
  }
  if (typeof value === 'string' && value !== '') return formatDateTime(value);

  return null;
}

function subjectOf(detail: Record<string, unknown>): string {
  const subject = formatValue(detail.subject);

  return detail.subjectType === 'group' ? `grupo ${subject}` : subject;
}

function noteOf(detail: Record<string, unknown>): string {
  return typeof detail.note === 'string' && detail.note !== '' ? ` · “${detail.note}”` : '';
}

/** O detalhe em uma linha. */
export function describeDetail(entry: WorkshopAuditEntry): string {
  const detail = entry.detail;

  switch (entry.action) {
    case 'owned.grant': {
      const expiry = formatExpiry(detail.expiresAt);
      const origin = OWNED_ORIGIN_LABELS[String(detail.source)] ?? formatValue(detail.source);
      const renewed = detail.created === false ? 'renovada' : 'nova';
      const ref = typeof detail.sourceRef === 'string' ? ` · ${detail.sourceRef}` : '';

      return `${renewed} · ${expiry === null ? 'permanente' : `até ${expiry}`} · ${origin}${ref}${noteOf(detail)}`;
    }

    case 'owned.revoke': {
      if (detail.removed === false) return 'não tinha — nada a tirar';

      const expiry = formatExpiry(detail.expiresAt);
      const origin = OWNED_ORIGIN_LABELS[String(detail.grantedSource)] ?? '';
      const by = typeof detail.grantedBy === 'string' ? ` por ${detail.grantedBy}` : '';

      return `era ${expiry === null ? 'permanente' : `até ${expiry}`}${origin === '' && by === '' ? '' : ` · dada${origin === '' ? '' : ` pelo ${origin}`}${by}`}`;
    }

    case 'owned.season-cleared': {
      // ####  UMA LINHA PARA O WIPE INTEIRO  ####
      //
      // O agente grava UMA linha com as contagens, e não uma por
      // jogador: um wipe com milhares de posses encheria a tela do
      // registro e esconderia todo o resto daquele dia. Quem tinha o
      // quê continua em cada `owned.grant`. Ver 02 §4.6.
      const removed = numberOf(detail.removed);
      const players = numberOf(detail.players);
      const skins = Array.isArray(detail.skins) ? detail.skins.length : numberOf(detail.skins);

      if (removed === null) return 'o wipe mandou remover a posse das skins de temporada';

      const de = players === null ? '' : `, de ${String(players)} jogador(es)`;
      const quantas = skins === null || skins === 0 ? '' : ` · ${String(skins)} skin(s) marcada(s)`;

      return `${String(removed)} posse(s) removida(s)${de}${quantas}`;
    }

    case 'owned.expired': {
      const expiry = formatExpiry(detail.expiresAt);

      return expiry === null ? '' : `venceu em ${expiry}`;
    }

    case 'game.give-refused':
      return `${formatValue(detail.reason)}: ${formatValue(detail.message)}`;

    case 'migration.097':
      return [
        `${formatValue(detail.grants)} acesso(s) lidos`,
        `${formatValue(detail.owned)} posse(s) criadas`,
        `${formatValue(detail.groupGrantsDropped)} de grupo descartados`,
        `${formatValue(detail.permissionsDropped)} permissão(ões) e ${formatValue(detail.collectionsDropped)} coleção(ões) removidas`,
      ].join(' · ');

    case 'grant.create':
    case 'grant.update':
    case 'grant.revoke': {
      const expiry = formatExpiry(detail.expiresAt);
      const note = typeof detail.note === 'string' && detail.note !== '' ? ` · “${detail.note}”` : '';

      return `${subjectOf(detail)} · ${expiry === null ? 'permanente' : `até ${expiry}`}${note}`;
    }

    case 'grant.expire': {
      const expiry = formatExpiry(detail.expiresAt);

      return `${subjectOf(detail)}${expiry === null ? '' : ` · venceu em ${expiry}`}`;
    }

    case 'skin.update':
    case 'collection.update': {
      const changed = detail.changed;

      if (changed === null || typeof changed !== 'object') return '';

      const parts = Object.entries(changed as Record<string, unknown>).map(([field, change]) => {
        const name = FIELD_LABELS[field] ?? field;

        if (change !== null && typeof change === 'object' && 'to' in change) {
          const { from, to } = change as { from?: unknown; to?: unknown };

          return `${name}: ${formatValue(from)} → ${formatValue(to)}`;
        }

        return name;
      });

      return parts.length === 0 ? 'nada mudou' : parts.join(' · ');
    }

    case 'skin.create': {
      const warning =
        typeof detail.warning === 'string' && detail.warning !== '' ? ` · aviso: ${detail.warning}` : '';

      return `Workshop ${formatValue(detail.workshopId)} · servidores: ${formatValue(detail.servers)}${warning}`;
    }

    case 'skin.delete':
      return `Workshop ${formatValue(detail.workshopId)}`;

    case 'skin.servers':
      return `${formatValue(detail.before)} → ${formatValue(detail.after)}`;

    case 'collection.create':
      return [
        formatValue(detail.label),
        detail.permission ? `permissão ${formatValue(detail.permission)}` : null,
        detail.openToAll === true ? 'para todos' : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');

    case 'collection.skins': {
      const before = Array.isArray(detail.before) ? detail.before.length : 0;
      const after = Array.isArray(detail.after) ? detail.after.length : 0;

      return `${String(before)} → ${String(after)} skins`;
    }

    case 'collection.delete':
      return `${formatValue(detail.skinCount)} skin(s) ficaram avulsas`;

    case 'game.add-refused':
      return `${formatValue(detail.reason)}: ${formatValue(detail.message)}`;

    default:
      return Object.keys(detail).length === 0 ? '' : JSON.stringify(detail);
  }
}

export function AuditPanel({ servers, initialSteamId = '', fixedSteamId }: AuditPanelProps) {
  const [chosenSteamId, setSteamId] = useState(initialSteamId);
  const [draft, setDraft] = useState(initialSteamId);
  const steamId = fixedSteamId ?? chosenSteamId;
  const fixed = fixedSteamId !== undefined;

  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const fetchPage = useCallback(
    async (before: number | null): Promise<CursorPage<WorkshopAuditEntry>> => {
      const response = await agent.workshopAudit({
        // Uma a mais: é ela que diz se existe a próxima página.
        limit: pageSize + 1,
        ...(steamId === '' ? {} : { steamId }),
        ...(before === null ? {} : { before }),
      });
      const all = (Array.isArray(response.entries) ? response.entries : []).map(safeAuditEntry);
      const items = all.slice(0, pageSize);
      // reduce, e não Math.min(...lista): o spread estoura com listas enormes.
      const lowest = items.reduce((min, entry) => Math.min(min, entry.id), Infinity);

      return {
        items,
        next: all.length > pageSize && Number.isFinite(lowest) ? lowest : null,
      };
    },
    [steamId, pageSize],
  );

  const pages = useCursorPages(fetchPage, pageSize);
  const entries = pages.items;
  const busy = pages.busy;
  const error = pages.error === null ? null : messageOf(pages.error);
  const reload = pages.reset;

  function apply(value: string): void {
    const trimmed = value.trim();

    setDraft(trimmed);
    setSteamId(trimmed);
  }

  const serverName = (id: string): string =>
    servers.find((server) => server.id === id)?.name ?? id;

  const draftTrimmed = draft.trim();
  const draftInvalid = draftTrimmed !== '' && !STEAM_ID_PATTERN.test(draftTrimmed);

  return (
    <div className="space-y-4">
      <form
        hidden={fixed}
        className="flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draftInvalid) apply(draft);
        }}
      >
        <div className="min-w-56 flex-1">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <Input
              type="text"
              inputMode="numeric"
              value={draft}
              maxLength={17}
              placeholder="Filtrar por SteamID64 do jogador afetado"
              aria-label="SteamID64"
              className="pl-7 font-mono"
              onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
            />
          </div>
          {draftInvalid && (
            <p className="mt-1 text-2xs text-amber">SteamID64 tem 17 dígitos e começa com 7656.</p>
          )}
        </div>

        <Button type="submit" size="md" variant="outline" disabled={busy || draftInvalid}>
          Filtrar
        </Button>

        {steamId !== '' && (
          <Button size="md" variant="ghost" disabled={busy} onClick={() => apply('')}>
            Limpar filtro
          </Button>
        )}

        <Button
          size="md"
          variant="outline"
          disabled={busy}
          onClick={() => void reload()}
          title="Ler o registro de novo"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
          )}
          Atualizar
        </Button>
      </form>

      {fixed && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>
            {busy ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
            )}
            Atualizar
          </Button>
        </div>
      )}

      {steamId !== '' && !fixed && (
        <p className="text-2xs text-muted">
          Mostrando só o que afetou <span className="font-mono text-foreground">{steamId}</span>.
          O que não tem um jogador afetado (cadastro, migração) não aparece aqui.
        </p>
      )}

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o registro" detail={error} />
      )}

      {entries === null ? (
        <StateBlock variant="loading" title="Lendo o registro…" />
      ) : entries.length === 0 ? (
        error === null && (
          <StateBlock
            variant="empty"
            title={steamId === '' ? 'Nada registrado ainda' : 'Nada registrado para este jogador'}
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Quando</HeaderCell>
                  <HeaderCell>Quem</HeaderCell>
                  <HeaderCell>Origem</HeaderCell>
                  <HeaderCell>Ação</HeaderCell>
                  <HeaderCell>Alvo</HeaderCell>
                  <HeaderCell>Servidor</HeaderCell>
                  {!fixed && <HeaderCell>Jogador</HeaderCell>}
                  <HeaderCell>Detalhe</HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {entries.map((entry) => (
                  <tr key={entry.id} className="align-top hover:bg-surface-2">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-2xs text-muted">
                      {formatDateTime(entry.at)}
                    </td>
                    <td className="px-3 py-2 text-2xs text-foreground">{entry.actor}</td>
                    <td className="px-3 py-2 text-2xs text-muted">
                      {SOURCE_LABELS[entry.source] ?? entry.source}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-2xs">
                      <span
                        className={cn('font-medium', actionTone(entry.action))}
                        title={entry.action}
                      >
                        {actionLabel(entry.action)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-2xs text-foreground">{entry.target}</td>
                    <td className="px-3 py-2 text-2xs text-muted">
                      {entry.serverId === null ? '—' : serverName(entry.serverId)}
                    </td>
                    <td hidden={fixed} className="px-3 py-2 text-2xs">
                      {entry.steamId === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <button
                          type="button"
                          className="font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-foreground"
                          title="Filtrar por este jogador"
                          onClick={() => apply(entry.steamId ?? '')}
                        >
                          {entry.steamId}
                        </button>
                      )}
                    </td>
                    <td className="max-w-md px-3 py-2 text-2xs text-muted">
                      {describeDetail(entry)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={pages.page}
            pageSize={pageSize}
            total={pages.total}
            shown={entries.length}
            knownPages={pages.knownPages}
            hasNext={pages.hasNext}
            busy={busy}
            onPageChange={pages.goTo}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
    >
      {children}
    </th>
  );
}
