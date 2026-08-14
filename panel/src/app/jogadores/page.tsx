'use client';

// ============================================================
//  /jogadores  -  a lista de jogadores da REDE.
//
//  ####  ESTA TELA É DE REDE, NÃO DE SERVIDOR  ####
//
//  A aba Administração de um servidor mostra quem está conectado
//  NELE, agora, lido do RCON. Aqui é a base do agente: todo mundo
//  que já jogou em qualquer servidor, com onde está, desde quando
//  joga e se está banido. Ela sobrevive ao wipe e ao reinício.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Mesma razão da lista de servidores, da de plugins e da de
//  banidos: é uma tela de COMPARAÇÃO — varrer a coluna "visto por
//  último" de cima a baixo e achar quem sumiu.
//
//  ####  PAGINADA DESDE A PRIMEIRA VERSÃO  ####
//
//  Uma rede com meses de vida tem dezenas de milhares de
//  jogadores. Uma lista infinita trava o navegador antes de
//  derrubar o agente — e um "carregar mais" para sempre esconde de
//  quem procura o fato de que há dez mil linhas.
// ============================================================

import { Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent, type NetworkPlayer } from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Uma página. O agente aceita até 200. */
const PAGE_SIZE = 50;

/**
 * De quanto em quanto tempo reler.
 *
 * A presença do agente é conferida a cada 15 s; reler mais rápido
 * que isso só gastaria consulta para ver o mesmo número.
 */
const POLL_MS = 15_000;

export default function JogadoresPage() {
  return (
    <RequireSession>
      <Jogadores />
    </RequireSession>
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

function Jogadores() {
  const [players, setPlayers] = useState<NetworkPlayer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [busca, setBusca] = useState('');
  /** Só quem está com sessão aberta em algum servidor. */
  const [somenteOnline, setSomenteOnline] = useState(false);
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await agent.networkPlayers({
        query: busca,
        online: somenteOnline,
        limit: PAGE_SIZE,
        offset,
      });

      setPlayers(response.players);
      setTotal(response.total);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [busca, somenteOnline, offset]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  // Trocar de filtro com a página 3 aberta deixaria a tela vazia
  // sem explicação: o resultado novo pode nem ter três páginas.
  useEffect(() => {
    setOffset(0);
  }, [busca, somenteOnline]);

  const inicio = total === 0 ? 0 : offset + 1;
  const fim = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <PageHeader
        title="Jogadores"
        description="Quem já jogou na rede. A lista é do agente, e não de um servidor."
        aside={
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <Users aria-hidden="true" className="h-4 w-4" />
            {total === 0 ? 'nenhum' : `${String(total)} no total`}
          </span>
        }
      />

      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-64 flex-1 items-center gap-2 border border-border bg-surface-2 px-2">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
            <Input
              value={busca}
              placeholder="Nome ou SteamID"
              aria-label="Buscar por nome ou SteamID"
              className="border-0 bg-transparent px-0 hover:border-0"
              onChange={(event) => setBusca(event.target.value)}
            />
          </label>

          <div className="flex items-stretch border border-border">
            {(
              [
                [false, 'Todos'],
                [true, 'Online agora'],
              ] as const
            ).map(([value, label], index) => (
              <div key={String(value)} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={somenteOnline === value}
                  onClick={() => setSomenteOnline(value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    somenteOnline === value
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              </div>
            ))}
          </div>
        </div>

        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler a lista de jogadores" detail={error} />
        )}

        {players === null && error === null && (
          <StateBlock variant="loading" title="Lendo a lista…" />
        )}

        {players !== null && players.length === 0 && (
          <StateBlock
            variant="empty"
            title={busca === '' && !somenteOnline ? 'Ninguém por aqui ainda' : 'Nada com esses filtros'}
            detail={
              busca === '' && !somenteOnline
                ? 'A lista nasce sozinha: cada jogador entra nela na primeira vez que aparece em algum servidor da rede.'
                : 'Tente o SteamID completo, parte do nome, ou desligue o filtro de online.'
            }
          />
        )}

        {players !== null && players.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Jogador</HeaderCell>
                  <HeaderCell>Onde está</HeaderCell>
                  <HeaderCell>Visto por último</HeaderCell>
                  <HeaderCell>Jogador desde</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Situação</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {players.map((player) => (
                  <tr key={player.steamId} className="hover:bg-surface-2">
                    <td className="px-3 py-2">
                      <Link
                        href={`/jogador/?id=${encodeURIComponent(player.steamId)}`}
                        className="block min-w-0"
                      >
                        <span className="flex items-center gap-2">
                          {/* A forma diz o estado, e não só a cor:
                              disco cheio é online, anel é offline —
                              a mesma regra do ponto do servidor. */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              player.online ? 'bg-olive' : 'border border-muted',
                            )}
                          />
                          <span className="truncate">
                            {player.name === '' ? EM_DASH : player.name}
                          </span>
                        </span>
                        <span className="block truncate font-mono text-2xs text-muted">
                          {player.steamId}
                        </span>
                      </Link>
                    </td>

                    {/* Onde ele está AGORA — ou, offline, o último
                        lugar em que esteve. Os dois na mesma coluna
                        porque a pergunta é uma só: "onde procuro por
                        ele?". */}
                    <td className="px-3 py-2">
                      {player.online ? (
                        <span className="text-foreground">{player.onlineOn.join(', ')}</span>
                      ) : (
                        <span className="text-muted">{player.lastServerId ?? EM_DASH}</span>
                      )}
                    </td>

                    <td className="px-3 py-2 text-muted">
                      {player.online ? 'online' : formatWhen(player.lastSeen)}
                    </td>

                    <td className="px-3 py-2 text-muted">{formatWhen(player.firstSeen)}</td>

                    <td className="px-3 py-2 text-right">
                      {player.banned && (
                        <span className="border border-rust px-2 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
                          banido
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {players !== null && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-2xs text-muted">
              {String(inicio)}–{String(fim)} de {String(total)}
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
                disabled={fim >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          A lista é do <strong>agente</strong>: um jogador entra nela na primeira vez que aparece em
          qualquer servidor da rede, e continua aqui depois de sair. Quem está online é conferido a
          cada 15 segundos — e quem aparece sem servidor é quem o agente ainda não viu jogar, o caso
          de um SteamID que só foi banido.
        </p>
      </div>
    </div>
  );
}
