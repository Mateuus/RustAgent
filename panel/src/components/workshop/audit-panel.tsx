'use client';

// ============================================================
//  audit-panel.tsx  -  tudo o que mudou nas skins, e quem mudou.
//
//  ####  TRÊS ORIGENS  ####
//
//  O painel (um usuário), o jogo (`/skin add`, com `jogo:<steamId>`)
//  e o próprio agente (`sistema`: um acesso que venceu). As três
//  gravam no mesmo registro, mais novo primeiro.
//
//  ####  O FILTRO É PELO JOGADOR AFETADO  ####
//
//  `steamId` é quem RECEBEU o acesso (ou o perdeu), e não quem
//  clicou. É a pergunta do suporte: "por que ele não tem a skin?".
//
//  ####  PÁGINAS POR `before`  ####
//
//  Carregar mais pede as entradas com id menor que a menor desta
//  lista. Offset daria entrada repetida quando alguém grava no meio.
// ============================================================

import { Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
}

const PAGE_SIZE = 100;

const ACTION_LABELS: Readonly<Record<string, string>> = {
  'skin.create': 'Skin cadastrada',
  'skin.update': 'Skin alterada',
  'skin.delete': 'Skin apagada',
  'skin.servers': 'Servidores da skin',
  'collection.create': 'Coleção criada',
  'collection.update': 'Coleção alterada',
  'collection.delete': 'Coleção apagada',
  'collection.skins': 'Itens da coleção',
  'grant.create': 'Acesso liberado',
  'grant.update': 'Acesso renovado',
  'grant.revoke': 'Acesso removido',
  'grant.expire': 'Acesso venceu',
  'game.add-refused': 'Cadastro pelo jogo recusado',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  panel: 'painel',
  game: 'jogo',
  system: 'sistema',
};

/** Os campos de `detail.changed`, em português. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  label: 'nome',
  shortname: 'item',
  skinId: 'Workshop ID',
  permission: 'permissão',
  collectionId: 'coleção',
  openToAll: 'para todos',
  hideInStreamer: 'esconde no streamer',
  enabled: 'valendo',
  servers: 'servidores',
  slug: 'comando',
  workshopTitle: 'título no Workshop',
  previewUrl: 'prévia',
};

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

/** O detalhe em uma linha. */
function describeDetail(entry: WorkshopAuditEntry): string {
  const detail = entry.detail;

  switch (entry.action) {
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

export function AuditPanel({ servers, initialSteamId = '' }: AuditPanelProps) {
  const [steamId, setSteamId] = useState(initialSteamId);
  const [draft, setDraft] = useState(initialSteamId);

  const [entries, setEntries] = useState<readonly WorkshopAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchPage = useCallback(
    async (before?: number) => {
      const response = await agent.workshopAudit({
        limit: PAGE_SIZE,
        ...(steamId === '' ? {} : { steamId }),
        ...(before === undefined ? {} : { before }),
      });
      const page = (response.entries ?? []).map(safeAuditEntry);

      return { page, more: page.length >= PAGE_SIZE };
    },
    [steamId],
  );

  const reload = useCallback(async () => {
    setBusy(true);

    try {
      const { page, more } = await fetchPage();

      setEntries(page);
      setHasMore(more);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      setEntries((current) => current ?? []);
    } finally {
      setBusy(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function loadMore(): Promise<void> {
    if (entries === null || entries.length === 0) return;

    setBusy(true);

    try {
      const before = Math.min(...entries.map((entry) => entry.id));
      const { page, more } = await fetchPage(before);

      setEntries([...entries, ...page]);
      setHasMore(more);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

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

      {steamId !== '' && (
        <p className="text-2xs text-muted">
          Mostrando só o que afetou <span className="font-mono text-foreground">{steamId}</span>.
          Acessos por grupo não aparecem aqui: eles não têm um jogador afetado.
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
                  <HeaderCell>Jogador</HeaderCell>
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
                        className={cn(
                          'font-medium',
                          entry.action === 'game.add-refused' || entry.action === 'grant.revoke'
                            ? 'text-rust'
                            : entry.action === 'grant.expire'
                              ? 'text-muted'
                              : 'text-foreground',
                        )}
                        title={entry.action}
                      >
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-2xs text-foreground">{entry.target}</td>
                    <td className="px-3 py-2 text-2xs text-muted">
                      {entry.serverId === null ? '—' : serverName(entry.serverId)}
                    </td>
                    <td className="px-3 py-2 text-2xs">
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

          <div className="flex items-center justify-between gap-3">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              {entries.length === 1 ? '1 entrada' : `${String(entries.length)} entradas`}
            </span>

            {hasMore && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadMore()}>
                {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
                Carregar mais
              </Button>
            )}
          </div>
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
