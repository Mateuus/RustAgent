'use client';

// ============================================================
//  tab-players.tsx  -  quem tem o passe, o XP e o nível de cada
//  um, e o que já resgatou.
//
//  ####  A LISTA É DE UM SERVIDOR  ####
//
//  O XP, o nível e o direito comprado são por servidor (01 §1.4).
//  Quem joga no `pvp1` e no `pvp2` aparece duas vezes, com dois
//  níveis — e a tela diz de qual servidor ela está falando, senão a
//  primeira reclamação é "meu nível sumiu".
//
//  ####  POR QUE A PAGINAÇÃO É DAQUI, E NÃO O `useCursorPages`  ####
//
//  Aquele hook guarda cursores NUMÉRICOS (o `before` do registro, o
//  id da posse). O cursor do placar é TEXTO: ele carrega o XP e o
//  steamId juntos, porque a ordenação é por XP e o desempate é pelo
//  jogador. Forçá-lo a número seria perder o desempate e repetir
//  linha na virada da página — que é exatamente o que o cursor
//  existe para evitar. O componente `Pagination` é o mesmo.
// ============================================================

import { Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  CELL_STATE_LABELS,
  ENTITLEMENT_ORIGIN_LABELS,
  LANE_LABELS,
  PENDING_ORIGIN_LABELS,
  STEAM_ID_PATTERN,
  cellKey,
  describeReward,
  messageOf,
  periodLabel,
  safeEntitlements,
  safePlayerTrack,
  safeProgressList,
} from '@/components/battlepass/normalize';
import {
  ServerChoice,
  type BattlePassServerOption,
} from '@/components/battlepass/server-choice';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import {
  agent,
  type BattlePassEntitlement,
  type BattlePassPlayerTrack,
  type BattlePassProgress,
} from '@/lib/api';
import { EM_DASH, formatInteger, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

export function TabPlayers({
  servers,
  serverId,
  onPickServer,
}: {
  readonly servers: readonly BattlePassServerOption[];
  readonly serverId: string;
  readonly onPickServer: (serverId: string) => void;
}) {
  const [rows, setRows] = useState<readonly BattlePassProgress[] | null>(null);
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  const load = useCallback(
    async (target: number, stack: readonly (string | null)[]) => {
      if (serverId === '') {
        setRows(null);

        return;
      }

      setBusy(true);

      // A primeira página não tem cursor; as outras leem o da pilha.
      const cursor = stack[target - 1] ?? null;

      try {
        const response = await agent.battlePassPlayers({
          serverId,
          limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });

        const players = safeProgressList(response.players);
        const next = typeof response.nextCursor === 'string' ? response.nextCursor : null;

        setRows(players);
        setPage(target);
        setHasNext(next !== null);
        // O cursor da página seguinte entra na pilha só quando ela
        // ainda não é conhecida: sem isso, voltar e avançar de novo
        // empilharia o mesmo cursor duas vezes.
        setCursors(stack.length === target && next !== null ? [...stack, next] : stack);
        setError(null);
      } catch (cause) {
        setError(messageOf(cause));
        setRows([]);
      } finally {
        setBusy(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    setCursors([null]);
    void load(1, [null]);
  }, [load]);

  const reload = useCallback(() => load(page, cursors), [load, page, cursors]);

  return (
    <div className="space-y-4">
      <ServerChoice servers={servers} value={serverId} busy={busy} onChange={onPickServer} />

      <GrantForm serverId={serverId} servers={servers} onGranted={reload} />

      <Section
        title="O placar da temporada no ar"
        aside={
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            mais XP primeiro
          </span>
        }
        contentClassName="p-0"
      >
        {error !== null && (
          <div className="p-3">
            <StateBlock variant="error" title="Não consegui ler o placar." detail={error} />
          </div>
        )}

        {rows === null ? (
          <div className="p-3">
            <StateBlock variant="loading" title="Lendo o placar…" />
          </div>
        ) : rows.length === 0 ? (
          error === null && (
            <div className="p-3">
              <StateBlock
                variant="empty"
                title="Ninguém pontuou nesta temporada, neste servidor."
                detail="Sem temporada no ar, o placar vem vazio de qualquer jeito — a Visão geral diz qual é o caso."
              />
            </div>
          )
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-left text-xs">
                <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="w-16 px-3 py-2">#</th>
                    <th className="px-3 py-2">SteamID64</th>
                    <th className="w-24 px-3 py-2">Nível</th>
                    <th className="w-28 px-3 py-2">XP</th>
                    <th className="w-32 px-3 py-2">Mexeu</th>
                    <th className="w-28 px-3 py-2 text-right">Trilha dele</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.steamId} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-muted">
                        {(page - 1) * PAGE_SIZE + index + 1}
                      </td>
                      <td className="px-3 py-2 font-mono text-foreground">{row.steamId}</td>
                      <td className="px-3 py-2 font-condensed text-sm font-bold text-foreground">
                        {formatInteger(row.level)}
                      </td>
                      <td className="px-3 py-2">{formatInteger(row.xp)}</td>
                      <td className="px-3 py-2 text-muted">{formatWhen(row.updatedAt)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => setOpened(row.steamId)}>
                          Abrir
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-t border-border p-3">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={null}
                shown={rows.length}
                knownPages={cursors.length}
                hasNext={hasNext}
                busy={busy}
                onPageChange={(target) => void load(target, cursors)}
              />
            </div>
          </>
        )}
      </Section>

      {opened !== null && (
        <PlayerDialog
          steamId={opened}
          serverId={serverId}
          onClose={() => setOpened(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

/**
 * Dar o passe do mês a um jogador.
 *
 * Dar de novo não é erro: o agente responde 201 com `created:
 * false`, porque o mês já é dele. Quem recusa de verdade é o índice
 * do banco, quando duas concessões acontecem no mesmo instante — e
 * essa recusa vem em português, pronta para a tela.
 */
function GrantForm({
  serverId,
  servers,
  onGranted,
}: {
  readonly serverId: string;
  readonly servers: readonly BattlePassServerOption[];
  readonly onGranted: () => Promise<void>;
}) {
  const [steamId, setSteamId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const invalid = steamId !== '' && !STEAM_ID_PATTERN.test(steamId);
  const serverName = servers.find((entry) => entry.id === serverId)?.name ?? serverId;

  async function grant(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.grantBattlePass({
        serverId,
        steamId,
        // Sem `period`: quem sabe que mês é hoje é o agente, no fuso
        // dele. O relógio do navegador não decide temporada.
        note: note.trim() === '' ? null : note.trim(),
      });

      toast.success(
        response.created
          ? `Passe de ${periodLabel(response.entitlement.period)} dado em ${serverName}`
          : `Ele já tinha o passe de ${periodLabel(response.entitlement.period)} em ${serverName}`,
      );
      setSteamId('');
      setNote('');
      await onGranted();
    } catch (cause) {
      toast.error('Não consegui dar o passe', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Dar o passe do mês">
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid && steamId !== '' && serverId !== '') void grant();
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
              value={steamId}
              placeholder="SteamID64 do jogador"
              aria-label="SteamID64"
              className="pl-7 font-mono"
              onChange={(event) => setSteamId(event.target.value.replace(/\D/g, ''))}
            />
          </div>
          {invalid && (
            <p className="mt-1 text-2xs text-amber">SteamID64 tem 17 dígitos e começa com 7656.</p>
          )}
        </div>

        <div className="min-w-56 flex-1">
          <Input
            value={note}
            maxLength={200}
            placeholder="Observação (fica no registro)"
            aria-label="Observação"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <Button type="submit" variant="primary" disabled={busy || invalid || steamId === '' || serverId === ''}>
          {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Dar o passe
        </Button>
      </form>

      <p className="mt-2 text-2xs text-muted">
        O direito é do mês corrente e <strong>deste servidor</strong> ({serverName}): comprar (ou
        ganhar) num não destrava o outro.
      </p>
    </Section>
  );
}

/** A trilha DELE: o progresso, o estado de cada casa, a caixa e os direitos. */
function PlayerDialog({
  steamId,
  serverId,
  onClose,
  onChanged,
}: {
  readonly steamId: string;
  readonly serverId: string;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
}) {
  const [track, setTrack] = useState<BattlePassPlayerTrack | null>(null);
  const [entitlements, setEntitlements] = useState<readonly BattlePassEntitlement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.battlePassPlayer(steamId, serverId);

      setTrack(safePlayerTrack(response.track));
      setEntitlements(safeEntitlements(response.entitlements));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      setTrack(null);
    }
  }, [steamId, serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(entitlement: BattlePassEntitlement): Promise<void> {
    setBusy(true);

    try {
      await agent.revokeBattlePass(entitlement.id);
      toast.success(`Passe de ${periodLabel(entitlement.period)} revogado`);
      await load();
      await onChanged();
    } catch (cause) {
      toast.error('Não consegui revogar', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  const levels = track?.season?.levels ?? 0;
  const byKey = new Map((track?.cells ?? []).map((cell) => [cellKey(cell.level, cell.lane), cell]));

  return (
    <Dialog open title={`Trilha de ${steamId}`} busy={busy} onClose={onClose} fullScreen>
      <div className="space-y-4 overflow-y-auto">
        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler a trilha dele." detail={error} />
        )}

        {track === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

        {track !== null && (
          <>
            {track.season === null ? (
              <StateBlock
                variant="empty"
                title="Não há temporada no ar neste servidor."
                detail="O XP dele continua gravado; o que não existe agora é trilha para mostrá-lo."
              />
            ) : (
              <div className="space-y-2 border border-border bg-surface-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                    Nível {formatInteger(track.progress.level)}
                    {track.progress.completed ? ' · trilha concluída' : ''}
                  </span>

                  <span
                    className={cn(
                      'border px-2 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                      track.paid ? 'border-olive text-olive' : 'border-border text-muted',
                    )}
                  >
                    {track.paid ? 'passe comprado' : 'sem o passe'}
                  </span>
                </div>

                <p className="text-xs text-muted">
                  {formatInteger(track.progress.intoLevel)} /{' '}
                  {track.progress.neededForNext === null
                    ? EM_DASH
                    : formatInteger(track.progress.neededForNext)}{' '}
                  XP para o próximo · {formatInteger(track.progress.xp)} XP na temporada ·{' '}
                  {track.season.label}
                </p>
              </div>
            )}

            {track.pending.length > 0 && (
              <Section
                title="A caixa"
                aside={
                  track.unseen ? (
                    <span className="border border-amber px-2 py-0.5 text-2xs uppercase text-foreground">
                      ele ainda não abriu
                    </span>
                  ) : undefined
                }
              >
                <ul className="space-y-1 text-xs">
                  {track.pending.map((pending) => (
                    <li key={pending.id} className="flex flex-wrap gap-2 text-muted">
                      <span className="text-foreground">
                        {pending.reward === null ? EM_DASH : describeReward(pending.reward)}
                      </span>
                      <span>({PENDING_ORIGIN_LABELS[pending.origin]})</span>
                      {pending.code !== null && <span className="font-mono">{pending.code}</span>}
                      <span>{formatInteger(pending.attempts)} tentativa(s)</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {levels > 0 && (
              <Section title="As casas" contentClassName="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-xs">
                    <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="w-20 px-3 py-2">Nível</th>
                        <th className="px-3 py-2">{LANE_LABELS.free}</th>
                        <th className="px-3 py-2">{LANE_LABELS.paid}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: levels }, (_, index) => index + 1).map((level) => (
                        <tr key={level} className="border-b border-border last:border-0">
                          <td className="px-3 py-1.5 text-foreground">{level}</td>

                          {(['free', 'paid'] as const).map((lane) => {
                            const cell = byKey.get(cellKey(level, lane)) ?? null;

                            return (
                              <td key={lane} className="px-3 py-1.5 text-muted">
                                {cell === null ? (
                                  EM_DASH
                                ) : (
                                  <span title={cell.reason ?? undefined}>
                                    {CELL_STATE_LABELS[cell.state]}
                                    {cell.rewards.length > 0 && (
                                      <span className="text-muted">
                                        {' '}
                                        · {cell.rewards.map(describeReward).join(', ')}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}

            <Section title="Os direitos dele" contentClassName="p-0">
              {entitlements.length === 0 ? (
                <div className="p-3">
                  <StateBlock
                    variant="empty"
                    title="Ele nunca teve o passe."
                    detail="Nem comprado, nem dado pelo painel, nem entregue pelo site."
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-left text-xs">
                    <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-3 py-2">Mês</th>
                        <th className="px-3 py-2">Servidor</th>
                        <th className="px-3 py-2">De onde</th>
                        <th className="px-3 py-2">Quem deu</th>
                        <th className="px-3 py-2">Estado</th>
                        <th className="px-3 py-2 text-right">O que fazer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entitlements.map((entitlement) => (
                        <tr key={entitlement.id} className="border-b border-border last:border-0">
                          <td className="px-3 py-2 text-foreground">
                            {periodLabel(entitlement.period)}
                          </td>
                          <td className="px-3 py-2">{entitlement.serverId}</td>
                          <td className="px-3 py-2">
                            {ENTITLEMENT_ORIGIN_LABELS[entitlement.origin]}
                          </td>
                          <td className="px-3 py-2 text-muted">{entitlement.createdBy}</td>
                          <td className="px-3 py-2">
                            {entitlement.active ? (
                              <span className="text-olive">vale</span>
                            ) : (
                              <span className="text-foreground">
                                revogado {formatWhen(entitlement.revokedAt)}
                                {entitlement.revokedBy === null ? '' : ` por ${entitlement.revokedBy}`}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {entitlement.active && (
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={() => void revoke(entitlement)}
                              >
                                Revogar
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
