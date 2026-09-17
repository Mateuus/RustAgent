'use client';

// ============================================================
//  tab-audit.tsx  -  quem mexeu em quê, e o que foi entregue.
//
//  O molde é o `workshop/audit-panel.tsx`: cursor por `before` (o
//  menor id da página), uma linha a mais para saber se existe a
//  próxima, e o `useCursorPages` guardando o caminho de volta.
//
//  ####  A AÇÃO CRUA APARECE QUANDO NÃO TEM RÓTULO  ####
//
//  `season.state` é o que fica no banco; "mudou o estado da" é o
//  que se lê. Uma ação que este painel não conhece cai no próprio
//  código em vez de sumir — um registro sem rótulo é melhor que um
//  registro escondido, e é assim que a aba sobrevive a uma frente
//  que acrescente ação nova.
//
//  ####  O FILTRO DE JOGADOR SÓ ACHA O QUE TEM JOGADOR  ####
//
//  Criar temporada, mexer na trilha e ligar fonte de XP não afetam
//  ninguém em particular, e por isso não têm `steamId`. Filtrar por
//  jogador esconde tudo isso — e a tela diz isso com todas as
//  letras, senão parece que o registro perdeu linhas.
// ============================================================

import { Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useState } from 'react';

import {
  AUDIT_SOURCE_LABELS,
  STEAM_ID_PATTERN,
  messageOf,
  safeAuditEntries,
} from '@/components/battlepass/normalize';
import {
  ServerChoice,
  type BattlePassServerOption,
} from '@/components/battlepass/server-choice';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination, useCursorPages, type CursorPage } from '@/components/ui/pagination';
import { agent, type BattlePassAuditEntry } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const PAGE_SIZE = 50;

/** O que cada ação significa, em português. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'season.create': 'criou a temporada',
  'season.update': 'editou a temporada',
  'season.servers': 'mudou onde vale a',
  'season.state': 'mudou o estado da',
  'season.delete': 'apagou a temporada',
  'track.set': 'mexeu na casa',
  'track.clear': 'esvaziou a casa',
  'xp.rule': 'configurou a fonte de XP',
  'xp.rule.delete': 'tirou a fonte de XP',
  'entitlement.grant': 'deu o',
  'entitlement.revoke': 'revogou o',
  claim: 'resgatou',
  'claim.rollover': 'recebeu na virada do mês',
};

export function TabAudit({
  servers,
  serverId,
  onPickServer,
}: {
  readonly servers: readonly BattlePassServerOption[];
  readonly serverId: string;
  readonly onPickServer: (serverId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [steamId, setSteamId] = useState('');
  /** O filtro de servidor é opcional: vazio = a rede inteira. */
  const [byServer, setByServer] = useState(false);

  const fetchPage = useCallback(
    async (before: number | null): Promise<CursorPage<BattlePassAuditEntry>> => {
      const response = await agent.battlePassAudit({
        // Uma a mais: é ela que diz se existe a próxima página.
        limit: PAGE_SIZE + 1,
        ...(steamId === '' ? {} : { steamId }),
        ...(byServer && serverId !== '' ? { serverId } : {}),
        ...(before === null ? {} : { before }),
      });

      const all = safeAuditEntries(response.entries);
      const items = all.slice(0, PAGE_SIZE);
      // reduce, e não Math.min(...lista): o spread estoura com listas enormes.
      const lowest = items.reduce((min, entry) => Math.min(min, entry.id), Infinity);

      return {
        items,
        next: all.length > PAGE_SIZE && Number.isFinite(lowest) ? lowest : null,
      };
    },
    [steamId, byServer, serverId],
  );

  const pages = useCursorPages(fetchPage, PAGE_SIZE);
  const entries = pages.items;
  const error = pages.error === null ? null : messageOf(pages.error);
  const draftTrimmed = draft.trim();
  const draftInvalid = draftTrimmed !== '' && !STEAM_ID_PATTERN.test(draftTrimmed);

  const serverName = (id: string): string => servers.find((entry) => entry.id === id)?.name ?? id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ServerChoice servers={servers} value={serverId} onChange={onPickServer} />

        <label className="flex items-center gap-2 text-2xs text-muted">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-rust"
            checked={byServer}
            onChange={(event) => setByServer(event.target.checked)}
          />
          só o que é deste servidor
        </label>
      </div>

      <Section title="O registro" contentClassName="p-0">
        <form
          className="flex flex-wrap items-start gap-2 border-b border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draftInvalid) setSteamId(draftTrimmed);
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
                maxLength={17}
                value={draft}
                placeholder="Filtrar por SteamID64 do jogador afetado"
                aria-label="SteamID64"
                className="pl-7 font-mono"
                onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
              />
            </div>
            {draftInvalid && (
              <p className="mt-1 text-2xs text-amber">
                SteamID64 tem 17 dígitos e começa com 7656.
              </p>
            )}
          </div>

          <Button type="submit" variant="outline" disabled={pages.busy || draftInvalid}>
            Filtrar
          </Button>

          {steamId !== '' && (
            <Button
              variant="ghost"
              disabled={pages.busy}
              onClick={() => {
                setDraft('');
                setSteamId('');
              }}
            >
              Limpar filtro
            </Button>
          )}

          <Button variant="outline" disabled={pages.busy} onClick={() => void pages.reset()}>
            {pages.busy ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
            )}
            Atualizar
          </Button>
        </form>

        {steamId !== '' && (
          <p className="border-b border-border px-3 py-2 text-2xs text-muted">
            Mostrando só o que afetou <span className="font-mono text-foreground">{steamId}</span>.
            O que não tem jogador afetado — criar temporada, mexer na trilha, ligar fonte de XP —
            não aparece aqui.
          </p>
        )}

        {error !== null && (
          <div className="p-3">
            <StateBlock variant="error" title="Não consegui ler o registro." detail={error} />
          </div>
        )}

        {entries === null ? (
          <div className="p-3">
            <StateBlock variant="loading" title="Lendo o registro…" />
          </div>
        ) : entries.length === 0 ? (
          error === null && (
            <div className="p-3">
              <StateBlock
                variant="empty"
                title="Nada registrado com esses filtros."
                detail="O registro guarda o que mudou no passe — inclusive o que o jogo e o site fizeram."
              />
            </div>
          )
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-left text-xs">
                <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="w-36 px-3 py-2">Quando</th>
                    <th className="w-40 px-3 py-2">Quem</th>
                    <th className="px-3 py-2">O que</th>
                    <th className="w-36 px-3 py-2">Servidor</th>
                    <th className="w-40 px-3 py-2">Jogador</th>
                  </tr>
                </thead>

                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 whitespace-nowrap text-muted">
                        {formatDateTime(entry.at)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-foreground">{entry.actor}</span>{' '}
                        <span className="text-muted">({AUDIT_SOURCE_LABELS[entry.source]})</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-foreground">
                          {ACTION_LABELS[entry.action] ?? entry.action}
                        </span>{' '}
                        <span className="text-muted">{entry.target}</span>
                        <Detail detail={entry.detail} />
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {entry.serverId === null ? '—' : serverName(entry.serverId)}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted">{entry.steamId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-t border-border p-3">
              <Pagination
                page={pages.page}
                pageSize={PAGE_SIZE}
                total={pages.total}
                shown={entries.length}
                knownPages={pages.knownPages}
                hasNext={pages.hasNext}
                busy={pages.busy}
                onPageChange={pages.goTo}
              />
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

/**
 * O detalhe da linha, quando ele diz alguma coisa.
 *
 * O `detail` é livre: cada ação grava o que importa para ela. Em vez
 * de um formatador por ação — que envelhece a cada ação nova —, os
 * campos saem como `chave: valor`, e o que não couber numa linha
 * fica no `title`.
 */
function Detail({ detail }: { readonly detail: Record<string, unknown> }) {
  const parts = Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);

  if (parts.length === 0) return null;

  return (
    <span className="ml-1 truncate text-2xs text-muted" title={parts.join(' · ')}>
      · {parts.join(' · ')}
    </span>
  );
}
