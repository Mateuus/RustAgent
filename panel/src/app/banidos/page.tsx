'use client';

// ============================================================
//  /banidos  -  a BanList do agente.
//
//  ####  ESTA TELA É DE REDE, NÃO DE SERVIDOR  ####
//
//  Antes, cada servidor tinha a lista dele no `bans.cfg`: um
//  jogador expulso do `pvp1` entrava no `pvp2` no minuto seguinte,
//  e quem administra descobria pelo Discord. Aqui o banimento é
//  estado do AGENTE, e cada servidor é espelho.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Mesma razão da lista de servidores e da de plugins: é uma tela
//  de COMPARAÇÃO — varrer a coluna de vencimento de cima a baixo e
//  achar quem já devia ter saído.
//
//  ####  REVOGAR NÃO APAGA  ####
//
//  A linha continua no histórico, com quem revogou e quando. É o
//  que responde à segunda discussão sobre o mesmo jogador — e é por
//  isso que o filtro padrão mostra SÓ OS ATIVOS: sem ele, a lista
//  viraria um histórico onde ninguém acha quem está banido agora.
// ============================================================

import { Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BanDialog } from '@/components/ban-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { agent, type Ban } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export default function BanidosPage() {
  return (
    <RequireSession>
      <Banidos />
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

function Banidos() {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [servers, setServers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banindo, setBanindo] = useState(false);

  /** Só quem está banido agora. Ver o cabeçalho. */
  const [somenteAtivos, setSomenteAtivos] = useState(true);
  const [busca, setBusca] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await agent.bans({ active: somenteAtivos, query: busca });

      setBans(response.bans);
      setServers(response.servers);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [somenteAtivos, busca]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(ban: Ban): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.revokeBan(ban.steamId);

      toast.success(response.message);
      await load();
    } catch (cause) {
      toast.error('Não consegui revogar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Banidos"
        description="A lista do agente. Cada servidor é espelho dela."
        aside={
          <Button variant="danger" disabled={busy} onClick={() => setBanindo(true)}>
            Banir jogador
          </Button>
        }
      />

      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-64 flex-1 items-center gap-2 border border-border bg-surface-2 px-2">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
            <Input
              value={busca}
              placeholder="SteamID ou nome"
              aria-label="Buscar por SteamID ou nome"
              className="border-0 bg-transparent px-0 hover:border-0"
              onChange={(event) => setBusca(event.target.value)}
            />
          </label>

          <div className="flex items-stretch border border-border">
            {(
              [
                [true, 'Ativos'],
                [false, 'Todos'],
              ] as const
            ).map(([value, label], index) => (
              <div key={String(value)} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={somenteAtivos === value}
                  onClick={() => setSomenteAtivos(value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    somenteAtivos === value
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
          <StateBlock variant="error" title="Não consegui ler a lista de banidos" detail={error} />
        )}

        {bans === null && error === null && <StateBlock variant="loading" title="Lendo a lista…" />}

        {bans !== null && bans.length === 0 && (
          <StateBlock
            variant="empty"
            title={busca === '' ? 'Ninguém banido' : 'Nada com essa busca'}
            detail={
              busca === ''
                ? 'Um banimento aplicado aqui vale em todos os servidores — inclusive nos que ainda vão ser criados.'
                : 'Tente o SteamID completo, ou parte do nome de quando ele foi banido.'
            }
          />
        )}

        {bans !== null && bans.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Jogador</HeaderCell>
                  <HeaderCell>Motivo</HeaderCell>
                  <HeaderCell>Onde vale</HeaderCell>
                  <HeaderCell>Quem aplicou</HeaderCell>
                  <HeaderCell>Situação</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {bans.map((ban) => (
                  <tr key={ban.id} className={cn(!ban.active && 'text-muted')}>
                    <td className="px-3 py-2">
                      <p className="truncate">{ban.name ?? EM_DASH}</p>
                      <p className="truncate font-mono text-2xs text-muted">{ban.steamId}</p>
                    </td>

                    <td className="px-3 py-2">{ban.reason}</td>

                    {/* Os NOMES, e não a contagem: "2 servidores"
                        obriga a ir procurar quais. */}
                    <td className="px-3 py-2">
                      {ban.scope === 'network' ? (
                        <span title="Inclusive nos servidores que ainda vão ser criados.">
                          toda a rede
                        </span>
                      ) : (
                        <span className="text-muted">
                          {ban.servers.length === 0 ? EM_DASH : ban.servers.join(', ')}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2 text-muted">
                      {ban.origin === 'adopted' ? 'adotado do servidor' : (ban.createdBy ?? EM_DASH)}
                    </td>

                    <td className="px-3 py-2 text-muted">{situacaoDe(ban)}</td>

                    <td className="px-3 py-2 text-right">
                      {ban.active ? (
                        <ConfirmButton
                          variant="danger"
                          disabled={busy}
                          icon={null}
                          label="Revogar"
                          confirmLabel="Revogar mesmo"
                          hint={
                            ban.scope === 'network'
                              ? `${ban.name ?? ban.steamId} volta a entrar em TODOS os servidores.`
                              : `${ban.name ?? ban.steamId} volta a entrar em ${ban.servers.join(
                                  ', ',
                                )}.`
                          }
                          onConfirm={() => void revoke(ban)}
                        />
                      ) : (
                        <span className="text-2xs text-muted">
                          revogado por {ban.revokedBy ?? 'prazo cumprido'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          Revogar <strong>não apaga a linha</strong>: ela fica no histórico com quem revogou e
          quando — é o que responde à segunda discussão sobre o mesmo jogador. Um banimento com
          prazo é solto por um relógio do agente: o Rust não tem banimento temporário.
        </p>
      </div>

      {banindo && (
        <BanDialog
          open
          servers={servers}
          onClose={() => setBanindo(false)}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}

/** Ativo, vencido saindo, ou como ele terminou. */
function situacaoDe(ban: Ban): string {
  if (ban.revokedAt !== null) {
    return `revogado em ${new Date(ban.revokedAt).toLocaleDateString('pt-BR')}`;
  }

  if (ban.expired) {
    // O relógio ainda não passou por ele. Estado real e curto —
    // dizer "ativo" faria o prazo parecer quebrado.
    return 'vencido, saindo';
  }

  if (ban.expiresAt === null) {
    return 'permanente';
  }

  return `vence em ${new Date(ban.expiresAt).toLocaleDateString('pt-BR')}`;
}
