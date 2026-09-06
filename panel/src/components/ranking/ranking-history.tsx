'use client';

// ============================================================
//  ranking-history.tsx  -  as temporadas que já fecharam, e o
//  pódio congelado de cada uma.
//
//  ####  O QUE ESTA TELA PROMETE  ####
//
//  Que o pódio de setembro continue sendo o pódio de setembro. Três
//  coisas o mudariam se ele fosse recalculado: um estorno de fraude
//  aplicado ao período fechado, um peso de índice que muda, e um
//  jogador apagado da base. Por isso o fechamento COPIA as
//  primeiras posições — inclusive o nome do jogador, que ele pode
//  trocar amanhã.
//
//  Ver Docs/Ranking/20 §3.3. A tela existe para deixar isso
//  visível: quem lê precisa saber que aquele número não muda mais.
// ============================================================

import { Snowflake } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  formatRankingValue,
  periodTitle,
  SEASON_MODE_LABELS,
  WINDOW_LABELS,
} from '@/components/ranking/labels';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import {
  agent,
  type RankingDefinition,
  type RankingPeriod,
  type RankingPeriodDetailResponse,
  type RankingPeriodKind,
} from '@/lib/api';
import { EM_DASH, formatDateTime, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Uma página. O agente aceita até 200. */
const PAGE_SIZE = 50;

const KINDS: readonly RankingPeriodKind[] = ['season', 'wipe', 'lifetime'];

interface RankingHistoryProps {
  readonly rankings: readonly RankingDefinition[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
}

export function RankingHistory({ rankings, servers }: RankingHistoryProps) {
  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState<RankingPeriodKind>('season');
  const [offset, setOffset] = useState(0);

  const [periods, setPeriods] = useState<readonly RankingPeriod[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<RankingPeriodDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
    setSelected(null);
    setDetail(null);
    setDetailError(null);
  }, [serverId, kind]);

  const load = useCallback(async () => {
    try {
      const response = await agent.rankingPeriods({
        serverId: serverId === '' ? undefined : serverId,
        kind,
        limit: PAGE_SIZE,
        offset,
      });

      setPeriods(response.periods);
      setTotal(response.total);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId, kind, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const response = await agent.rankingPeriod(selected);

        if (alive) {
          setDetail(response);
          setDetailError(null);
        }
      } catch (cause) {
        if (alive) {
          setDetail(null);
          setDetailError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [selected]);

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Servidor" htmlFor="history-server">
          <select
            id="history-server"
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
            className="h-9 min-w-40 border border-border bg-surface-2 px-2 text-sm text-foreground"
          >
            <option value="">Todos</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Janela" htmlFor="history-kind">
          <select
            id="history-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as RankingPeriodKind)}
            className="h-9 border border-border bg-surface-2 px-2 text-sm text-foreground"
          >
            {KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {WINDOW_LABELS[entry]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o histórico" detail={error} />
      )}

      {periods === null && error === null && (
        <StateBlock variant="loading" title="Lendo as janelas…" />
      )}

      {periods !== null && periods.length === 0 && (
        <StateBlock
          variant="empty"
          title={serverId === '' ? 'Nenhuma janela ainda' : 'Nenhuma janela neste servidor'}
          detail="A primeira janela nasce quando o coletor aplica o primeiro lote daquele servidor. Antes disso não há nada a fechar."
        />
      )}

      {periods !== null && periods.length > 0 && (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <HeaderCell>Janela</HeaderCell>
                <HeaderCell>Servidor</HeaderCell>
                <HeaderCell>Modo</HeaderCell>
                <HeaderCell>Começou</HeaderCell>
                <HeaderCell>Fechou</HeaderCell>
                <HeaderCell className="text-right">
                  <span className="sr-only">Pódio</span>
                </HeaderCell>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {periods.map((period) => (
                <tr
                  key={period.id}
                  className={cn('hover:bg-surface-2', selected === period.id && 'bg-surface-2')}
                >
                  <td className="px-3 py-2">
                    <span className="text-foreground">{periodTitle(period)}</span>
                    <span className="ml-2 font-mono text-2xs text-muted">#{String(period.id)}</span>
                  </td>

                  <td className="px-3 py-2 text-muted">{period.serverId}</td>

                  <td className="px-3 py-2 text-2xs text-muted">
                    {period.seasonMode === null ? EM_DASH : SEASON_MODE_LABELS[period.seasonMode]}
                  </td>

                  <td className="px-3 py-2 text-2xs text-muted">
                    {formatDateTime(period.startedAt)}
                  </td>

                  <td className="px-3 py-2 text-2xs">
                    {period.endedAt === null ? (
                      <span className="border border-olive px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-olive">
                        aberta
                      </span>
                    ) : (
                      <span className="text-muted">{formatDateTime(period.endedAt)}</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected(selected === period.id ? null : period.id)}
                    >
                      {selected === period.id ? 'Esconder o pódio' : 'Ver o pódio'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {periods !== null && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-2xs text-muted">
            {String(start)}–{String(end)} de {String(total)}
          </p>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={end >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Próxima
            </Button>
          </div>
        </div>
      )}

      {detailError !== null && (
        <StateBlock variant="error" title="Não consegui ler este período" detail={detailError} />
      )}

      {selected !== null && detail === null && detailError === null && (
        <StateBlock variant="loading" title="Lendo o pódio congelado…" />
      )}

      {detail !== null && <Podium detail={detail} rankings={rankings} />}
    </div>
  );
}

function Podium({
  detail,
  rankings,
}: {
  readonly detail: RankingPeriodDetailResponse;
  readonly rankings: readonly RankingDefinition[];
}) {
  const { period } = detail;

  return (
    <Section
      title={`Pódio de ${periodTitle(period)} · ${period.serverId}`}
      aside={
        <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
          <Snowflake aria-hidden="true" className="h-4 w-4 text-amber" />
          {period.endedAt === null ? 'ainda aberta' : `fechada ${formatWhen(period.endedAt)}`}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="text-2xs leading-relaxed text-muted">
          {period.endedAt === null ? (
            <>
              Esta janela <strong>ainda está aberta</strong>: o pódio só é congelado no fechamento,
              e por isso a lista abaixo pode estar vazia. O que vale agora é a aba{' '}
              <strong>Lista</strong>.
            </>
          ) : (
            <>
              Congelado no fechamento: estes valores <strong>não mudam mais</strong>. O nome é o que
              o jogador tinha quando ganhou — trocar de nome depois não reescreve o campeão.
            </>
          )}
        </p>

        {detail.podium.length === 0 ? (
          <StateBlock
            variant="empty"
            title="Nada congelado nesta janela"
            detail="Ou ela fechou sem ninguém ter pontuado, ou ela fechou antes de o ranking existir."
          />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {detail.podium.map((board) => {
              const ranking = rankings.find((entry) => entry.metric === board.metric) ?? null;

              return (
                <div key={board.metric} className="border border-border bg-surface-2">
                  <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
                    <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
                      {board.label}
                    </h3>
                    <span className="font-mono text-2xs text-muted">{board.metric}</span>
                  </header>

                  <ol className="divide-y divide-border">
                    {board.entries.map((entry) => (
                      <li
                        key={`${board.metric}-${String(entry.position)}`}
                        className="flex items-center gap-3 px-3 py-1.5 text-sm"
                      >
                        <span className="w-6 shrink-0 text-right font-condensed font-bold text-muted">
                          {String(entry.position)}
                        </span>

                        <Link
                          href={`/jogador/?id=${encodeURIComponent(entry.steamId)}`}
                          className="min-w-0 flex-1 truncate"
                        >
                          {entry.name ?? EM_DASH}
                        </Link>

                        <span className="shrink-0 tabular-nums text-foreground">
                          {ranking === null
                            ? entry.value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
                            : formatRankingValue(ranking, entry.value)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function HeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}
