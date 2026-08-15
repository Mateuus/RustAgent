'use client';

// ============================================================
//  /vips  -  quem tem VIP na REDE.
//
//  ####  ESTA TELA É DE REDE, NÃO DE SERVIDOR  ####
//
//  Quem compra compra da rede — a alternativa produziria a pergunta
//  "comprei no PVP e não tenho no PVE?" com a resposta errada. O
//  que é por servidor é o GRUPO do Oxide, que é como o VIP vira
//  efeito dentro do jogo, e ele é conferido sozinho a cada conexão.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Mesma razão da lista de banidos: é uma tela de COMPARAÇÃO —
//  varrer a coluna de vencimento de cima a baixo e achar quem vence
//  esta semana.
//
//  ####  REVOGAR NÃO APAGA  ####
//
//  A linha fica no histórico com quem revogou e quando. É por isso
//  que o filtro padrão mostra SÓ OS ATIVOS: sem ele, a lista viraria
//  um histórico onde ninguém acha quem é VIP agora.
//
//  ####  E A PAGINAÇÃO NÃO É ENFEITE  ####
//
//  Uma rede com meses de vida acumula concessões — as ativas e todas
//  as que já venceram. Uma chamada que devolvesse tudo travaria o
//  navegador antes de derrubar o agente.
// ============================================================

import { Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { VipDialog } from '@/components/vip-dialog';
import { agent, type Vip } from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

export default function VipsPage() {
  return (
    <RequireSession>
      <Vips />
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

function Vips() {
  const [vips, setVips] = useState<Vip[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [concedendo, setConcedendo] = useState(false);

  /** Só quem é VIP agora. Ver o cabeçalho. */
  const [somenteAtivos, setSomenteAtivos] = useState(true);
  const [busca, setBusca] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await agent.vips({
        active: somenteAtivos ? true : undefined,
        query: busca,
        limit: PAGE_SIZE,
        offset,
      });

      setVips(response.vips);
      setTotal(response.total);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [somenteAtivos, busca, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Trocar o filtro com a página no fim deixaria a tela vazia, sem
  // nada explicando por quê.
  useEffect(() => {
    setOffset(0);
  }, [somenteAtivos, busca]);

  async function revoke(vip: Vip): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.revokeVip(vip.steamId, vip.tier);

      toast.success('VIP revogado', { description: response.message });
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
        title="VIPs"
        description="O direito é da rede. O grupo do Oxide é o reflexo dele em cada servidor."
        aside={
          <Button variant="primary" disabled={busy} onClick={() => setConcedendo(true)}>
            Conceder VIP
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
          <StateBlock variant="error" title="Não consegui ler a lista de VIPs" detail={error} />
        )}

        {vips === null && error === null && <StateBlock variant="loading" title="Lendo a lista…" />}

        {vips !== null && vips.length === 0 && (
          <StateBlock
            variant="empty"
            title={busca === '' ? 'Ninguém com VIP' : 'Nada com essa busca'}
            detail={
              busca === ''
                ? 'Um VIP concedido aqui vale em todos os servidores da rede, e o jogador entra no grupo do Oxide de cada um deles.'
                : 'Tente o SteamID completo, ou parte do nome do jogador.'
            }
          />
        )}

        {vips !== null && vips.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Jogador</HeaderCell>
                  <HeaderCell>Nível</HeaderCell>
                  <HeaderCell>Desde</HeaderCell>
                  <HeaderCell>Até</HeaderCell>
                  <HeaderCell>De onde veio</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {vips.map((vip) => (
                  <tr key={vip.id} className={cn(!vip.active && 'text-muted')}>
                    <td className="px-3 py-2">
                      <p className="truncate">{vip.playerName ?? EM_DASH}</p>
                      <p className="truncate font-mono text-2xs text-muted">{vip.steamId}</p>
                    </td>

                    <td className="px-3 py-2 font-mono text-2xs">{vip.tier}</td>

                    <td className="px-3 py-2 text-muted">{formatWhen(vip.createdAt)}</td>

                    <td className="px-3 py-2 text-muted">{situacaoDe(vip)}</td>

                    <td className="px-3 py-2 text-muted">
                      {vip.origin === 'adotado'
                        ? 'adotado do grupo'
                        : `${vip.origin}${vip.createdBy === null ? '' : ` (${vip.createdBy})`}`}
                    </td>

                    <td className="px-3 py-2 text-right">
                      {vip.active ? (
                        <ConfirmButton
                          variant="danger"
                          disabled={busy}
                          icon={null}
                          label="Revogar"
                          confirmLabel="Revogar mesmo"
                          hint={`${vip.playerName ?? vip.steamId} sai do grupo ${vip.tier} em todos os servidores.`}
                          onConfirm={() => void revoke(vip)}
                        />
                      ) : (
                        <span className="text-2xs text-muted">
                          {vip.revokedAt === null
                            ? 'vencido'
                            : `revogado por ${vip.revokedBy ?? 'prazo cumprido'}`}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-2xs text-muted">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} de {total}
            </span>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Anteriores
              </Button>

              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Próximos
              </Button>
            </div>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          Revogar <strong>não apaga a linha</strong>: ela fica no histórico com quem revogou e
          quando. Um VIP com prazo é revogado por um relógio do agente, que também tira o jogador do
          grupo do Oxide — sem ele, a data passaria e o benefício continuaria valendo.
        </p>
      </div>

      {concedendo && (
        <VipDialog
          open
          onClose={() => setConcedendo(false)}
          onDone={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Ativo, vencido saindo, ou como ele terminou. */
function situacaoDe(vip: Vip): string {
  if (vip.revokedAt !== null) {
    return `revogado em ${new Date(vip.revokedAt).toLocaleDateString('pt-BR')}`;
  }

  if (vip.expired) {
    // O relógio ainda não passou por ele. Estado real e curto —
    // dizer "ativo" faria o prazo parecer quebrado.
    return 'vencido, saindo';
  }

  if (vip.expiresAt === null) {
    return 'vitalício';
  }

  return new Date(vip.expiresAt).toLocaleDateString('pt-BR');
}
