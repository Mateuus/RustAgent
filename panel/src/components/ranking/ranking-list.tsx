'use client';

// ============================================================
//  ranking-list.tsx  -  a lista: quem está na frente, e em quê.
//
//  ####  O MOLDE É /jogadores  ####
//
//  Mesma paginação, mesmos três estados (erro / carregando /
//  vazio), mesmo pager "1–50 de 1.234" e mesma nota de rodapé
//  dizendo de onde vem o dado. Uma segunda maneira de desenhar
//  tabela paginada seria a que diverge no primeiro ajuste.
//
//  ####  QUATRO SELETORES, E CADA UM MUDA UMA PERGUNTA  ####
//
//    ranking   — o quê se mede
//    escopo    — a rede inteira, ou um servidor
//    janela    — wipe, temporada, de sempre
//    temporada — uma FECHADA, e aí a lista vem congelada
//
//  ####  `scope=global` NÃO APARECE PARA TODO RANKING  ####
//
//  Minério e explosivo têm `globalEligible = false`: somar um
//  servidor 1x com um 5x produz uma lista ordenada por EM QUE
//  SERVIDOR a pessoa jogou. O seletor some para eles em vez de
//  oferecer um botão que o agente vai recusar com
//  `RANKING_SCOPE_INVALID`.
// ============================================================

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { CoverageBlock } from '@/components/ranking/coverage-block';
import {
  formatRankingValue,
  isDurationRanking,
  periodTitle,
  WINDOW_HINTS,
  WINDOW_LABELS,
} from '@/components/ranking/labels';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import {
  agent,
  ApiError,
  type RankingDefinition,
  type RankingListResponse,
  type RankingPeriod,
  type RankingPeriodKind,
  type RankingScope,
} from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Uma página. O agente aceita até 200. */
const PAGE_SIZE = 50;

/**
 * De quanto em quanto tempo reler.
 *
 * O coletor roda a cada 60 s (Docs/Ranking/20 §6.4); reler mais
 * rápido que isso só gastaria consulta para ver o mesmo número.
 */
const POLL_MS = 30_000;

const WINDOWS: readonly RankingPeriodKind[] = ['wipe', 'season', 'lifetime'];

interface RankingListProps {
  readonly rankings: readonly RankingDefinition[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
}

export function RankingList({ rankings, servers }: RankingListProps) {
  const [metric, setMetric] = useState('');
  const [scope, setScope] = useState<RankingScope>('global');
  const [serverId, setServerId] = useState('');
  const [periodKind, setPeriodKind] = useState<RankingPeriodKind | null>(null);
  /** Uma temporada FECHADA. `null` = a janela aberta de agora. */
  const [periodId, setPeriodId] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<RankingListResponse | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [closed, setClosed] = useState<readonly RankingPeriod[]>([]);

  const ranking = useMemo(
    () => rankings.find((entry) => entry.metric === metric) ?? null,
    [rankings, metric],
  );

  // O primeiro ranking da lista é o que abre a tela: a ordem é a
  // `sortOrder` que o admin escolheu, e ela existe para isto.
  useEffect(() => {
    if (metric !== '' || rankings.length === 0) return;

    const first = rankings.find((entry) => entry.enabled) ?? rankings[0];

    if (first !== undefined) {
      setMetric(first.metric);
    }
  }, [rankings, metric]);

  // Trocar de ranking abre a janela DELE — é o que `window` quer
  // dizer (Docs/Ranking/20 §3.1), e é a única janela cuja virada o
  // zera aos olhos de quem joga.
  useEffect(() => {
    if (ranking === null) return;

    setPeriodKind(ranking.window);
    setPeriodId(null);
  }, [ranking]);

  // Um ranking que não soma entre servidores não pode ficar preso
  // num escopo de rede escolhido para o anterior: a tela responderia
  // com a recusa do agente até alguém adivinhar o motivo.
  useEffect(() => {
    if (ranking !== null && !ranking.globalEligible && scope === 'global') {
      setScope('server');
    }
  }, [ranking, scope]);

  useEffect(() => {
    if (scope === 'server' && serverId === '' && servers.length > 0) {
      setServerId(servers[0]?.id ?? '');
    }
  }, [scope, serverId, servers]);

  // Trocar de filtro com a página 3 aberta deixaria a tela vazia sem
  // explicação: o resultado novo pode nem ter três páginas.
  useEffect(() => {
    setOffset(0);
  }, [metric, scope, serverId, periodKind, periodId]);

  const load = useCallback(async () => {
    if (metric === '' || periodKind === null) return;
    if (scope === 'server' && serverId === '') return;

    try {
      const response = await agent.ranking({
        metric,
        scope,
        serverId: scope === 'server' ? serverId : undefined,
        period: periodKind,
        periodId: periodId ?? undefined,
        limit: PAGE_SIZE,
        offset,
      });

      setPage(response);
      setError(null);
    } catch (cause) {
      setPage(null);
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [metric, scope, serverId, periodKind, periodId, offset]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  // As temporadas fechadas daquele servidor — é o seletor do
  // histórico dentro da lista. Só existe no escopo de servidor: uma
  // temporada é de UM servidor, e a rede tem várias ao mesmo tempo.
  useEffect(() => {
    if (scope !== 'server' || serverId === '') {
      setClosed([]);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const response = await agent.rankingPeriods({
          serverId,
          kind: 'season',
          limit: 50,
          offset: 0,
        });

        if (alive) {
          setClosed(response.periods.filter((period) => period.endedAt !== null));
        }
      } catch {
        // O seletor de temporada fechada é auxiliar: sem ele a
        // lista de agora continua servindo, e o erro de verdade
        // aparece na tabela.
        if (alive) setClosed([]);
      }
    })();

    return () => {
      alive = false;
    };
  }, [scope, serverId]);

  const total = page?.total ?? 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);
  const filtered = periodId !== null || scope === 'server';

  // Sem ranking ligado, ou sem servidor para o escopo escolhido, não
  // há consulta a fazer — e o `load` volta cedo. Sem estas duas
  // guardas a tela ficaria em "lendo…" para sempre, que é o pior
  // jeito de dizer "não tem nada aqui".
  const blocked = rankings.length === 0 || (scope === 'server' && servers.length === 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Ranking" htmlFor="ranking-metric">
          <select
            id="ranking-metric"
            value={metric}
            onChange={(event) => setMetric(event.target.value)}
            className="h-9 min-w-56 border border-border bg-surface-2 px-2 text-sm text-foreground"
          >
            {/* Só os LIGADOS chegam aqui: um ranking desligado
                continua sendo contado, mas saiu das telas de
                propósito — quem quer religá-lo vai à aba Rankings. */}
            {rankings.map((entry) => (
              <option key={entry.id} value={entry.metric}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>

        {/* O escopo de rede só existe para quem soma entre
            servidores. Ver o cabeçalho. */}
        {ranking !== null && ranking.globalEligible && (
          <Field label="Escopo">
            <div className="flex items-stretch border border-border">
              {(
                [
                  ['global', 'A rede'],
                  ['server', 'Um servidor'],
                ] as const
              ).map(([value, label], index) => (
                <div key={value} className="flex items-stretch">
                  {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                  <button
                    type="button"
                    aria-pressed={scope === value}
                    onClick={() => setScope(value)}
                    className={cn(
                      'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                      scope === value
                        ? 'bg-surface-2 text-foreground'
                        : 'text-muted hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                </div>
              ))}
            </div>
          </Field>
        )}

        {scope === 'server' && (
          <Field label="Servidor" htmlFor="ranking-server">
            <select
              id="ranking-server"
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
              className="h-9 min-w-40 border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Janela" htmlFor="ranking-window">
          <select
            id="ranking-window"
            value={periodKind ?? ''}
            disabled={periodId !== null}
            onChange={(event) => setPeriodKind(event.target.value as RankingPeriodKind)}
            className="h-9 border border-border bg-surface-2 px-2 text-sm text-foreground disabled:opacity-50"
          >
            {WINDOWS.map((kind) => (
              <option key={kind} value={kind}>
                {WINDOW_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>

        {scope === 'server' && (
          <Field label="Temporada fechada" htmlFor="ranking-period">
            <select
              id="ranking-period"
              value={periodId === null ? '' : String(periodId)}
              onChange={(event) =>
                setPeriodId(event.target.value === '' ? null : Number(event.target.value))
              }
              className="h-9 min-w-48 border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              <option value="">A janela de agora</option>
              {closed.map((period) => (
                <option key={period.id} value={String(period.id)}>
                  {periodTitle(period)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {ranking !== null && (
        <p className="text-2xs leading-relaxed text-muted">
          {ranking.description ?? `A métrica é ${ranking.metric}.`} Este ranking disputa na janela{' '}
          <strong className="text-foreground">{WINDOW_LABELS[ranking.window]}</strong> —{' '}
          {WINDOW_HINTS[ranking.window]}.
        </p>
      )}

      {rankings.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum ranking ligado"
          detail="Todo ranking está desligado, ou o catálogo está vazio. Ligue um na aba Rankings — ou crie o primeiro dinâmico por lá, que é onde nasce o Troféu Bleik Store."
        />
      )}

      {rankings.length > 0 && scope === 'server' && servers.length === 0 && (
        <StateBlock
          variant="empty"
          title="Este agente não cuida de nenhum servidor"
          detail="O escopo de servidor precisa de um servidor cadastrado. Enquanto isso, a lista da rede continua respondendo."
        />
      )}

      {error !== null && (
        <StateBlock
          variant={
            error instanceof ApiError && error.code === 'RANKING_NOT_MEASURED' ? 'offline' : 'error'
          }
          title={
            error instanceof ApiError && error.code === 'RANKING_NOT_MEASURED'
              ? 'Este escopo nunca teve coleta'
              : 'Não consegui ler o ranking'
          }
          // A frase é do CORE: ela conhece a regra, e a nossa
          // camada não. Reescrevê-la daria duas explicações para o
          // mesmo problema.
          detail={error.message}
        />
      )}

      {page === null && error === null && !blocked && (
        <StateBlock variant="loading" title="Lendo o ranking…" />
      )}

      {page !== null && (
        <>
          <CoverageBlock
            coverage={page.coverage}
            measuredSince={page.measuredSince}
            updatedAt={page.updatedAt}
            period={page.period}
            frozen={page.frozen}
          />

          {page.entries.length === 0 ? (
            <StateBlock
              variant="empty"
              title={filtered ? 'Ninguém pontuou nesta janela' : 'Ninguém pontuou ainda'}
              detail={
                filtered
                  ? 'Troque a janela, o servidor ou a temporada. Se algum servidor aparece acima como "não estava medindo", o vazio pode ser dele — e não dos jogadores.'
                  : 'A lista nasce sozinha: o primeiro lote do coletor põe todo mundo que pontuou aqui dentro.'
              }
            />
          ) : (
            <div className="overflow-x-auto border border-border bg-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr>
                    <HeaderCell className="w-16 text-right">#</HeaderCell>
                    <HeaderCell>Jogador</HeaderCell>
                    <HeaderCell className="text-right">
                      {page.ranking.label}
                      {page.ranking.unit === null || isDurationRanking(page.ranking)
                        ? ''
                        : ` (${page.ranking.unit})`}
                    </HeaderCell>
                    <HeaderCell className="text-right">
                      {page.frozen ? 'congelado em' : 'somou por último'}
                    </HeaderCell>
                  </tr>
                </thead>

                <tbody className="divide-y divide-border">
                  {page.entries.map((entry) => (
                    <tr key={entry.steamId} className="hover:bg-surface-2">
                      <td className="px-3 py-2 text-right font-condensed text-sm font-bold text-muted">
                        {String(entry.position)}
                      </td>

                      <td className="px-3 py-2">
                        <Link
                          href={`/jogador/?id=${encodeURIComponent(entry.steamId)}`}
                          className="block min-w-0"
                        >
                          {/* O nome pode ter sumido da base — o
                              pódio congelado guarda o de quando
                              ganhou, e a lista viva depende do
                              jogador ainda existir. */}
                          <span className="block truncate">{entry.name ?? EM_DASH}</span>
                          <span className="block truncate font-mono text-2xs text-muted">
                            {entry.steamId}
                          </span>
                        </Link>
                      </td>

                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {formatRankingValue(page.ranking, entry.value)}
                      </td>

                      <td className="px-3 py-2 text-right text-2xs text-muted">
                        {formatWhen(entry.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > 0 && (
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
        </>
      )}

      <p className="text-2xs leading-relaxed text-muted">
        O número vem do <strong>agente</strong>: o coletor pede o lote ao plugin de cada servidor a
        cada 60 segundos e soma no período aberto. Uma temporada fechada é lida do{' '}
        <strong>pódio congelado</strong> — ela não muda mais. Empate desempata por quem chegou
        primeiro ao valor.
      </p>
    </div>
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
