'use client';

// ============================================================
//  /loja  -  os kits da rede.
//
//  ####  O KIT É DA REDE; CADA SERVIDOR DECIDE SE O OFERECE  ####
//
//  Mesma razão da biblioteca de plugins: um kit por servidor faria
//  cinco cópias do mesmo kit, e a sexta mudança entraria em quatro
//  delas. Por isso esta tela é de rede, e a coluna "onde" mostra os
//  NOMES — "2 servidores" obrigaria a ir procurar quais.
//
//  ####  TIRAR DO AR NÃO É APAGAR  ####
//
//  Desligar mantém o kit e o histórico de resgates; apagar leva os
//  dois. A confirmação diz quantos resgates vão junto, porque é
//  esse número que faz alguém mudar de ideia.
//
//  ####  E QUEM JÁ PEGOU É UMA PERGUNTA DA TELA  ####
//
//  As entregas que FALHARAM aparecem ali também, com o motivo: uma
//  entrega que não aconteceu é a pergunta que o suporte recebe.
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { KitDialog } from '@/components/kit-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type Kit, type KitClaim } from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export default function LojaPage() {
  return (
    <RequireSession>
      <Loja />
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

function Loja() {
  const [kits, setKits] = useState<Kit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** `undefined` = fechado; `null` = criando; um kit = editando. */
  const [editing, setEditing] = useState<Kit | null | undefined>(undefined);

  /** Qual kit teve os resgates abertos. */
  const [claimsOf, setClaimsOf] = useState<number | null>(null);
  const [claims, setClaims] = useState<KitClaim[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.kits();

      setKits(response.kits);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openClaims(kit: Kit): Promise<void> {
    if (claimsOf === kit.id) {
      setClaimsOf(null);
      return;
    }

    setClaimsOf(kit.id);
    setClaims(null);

    try {
      setClaims((await agent.kitClaims(kit.id, { limit: 50, offset: 0 })).claims);
    } catch (cause) {
      toast.error('Não consegui ler os resgates', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      setClaimsOf(null);
    }
  }

  async function remove(kit: Kit): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeKit(kit.id);

      toast.success('Kit removido', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui remover', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Loja"
        description="Os kits da rede: compra, resgate único e cooldown."
        aside={
          <Button variant="primary" disabled={busy} onClick={() => setEditing(null)}>
            Novo kit
          </Button>
        }
      />

      <div className="mt-4 space-y-4">
        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler os kits" detail={error} />
        )}

        {kits === null && error === null && <StateBlock variant="loading" title="Lendo a loja…" />}

        {kits !== null && kits.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nenhum kit ainda"
            detail="Um kit é um loadout com regra de entrega: pago, uma vez por jogador, ou de tempos em tempos. Ele é da rede, e cada servidor decide se o oferece."
          />
        )}

        {kits !== null && kits.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Kit</HeaderCell>
                  <HeaderCell>Como recebe</HeaderCell>
                  <HeaderCell>Exige VIP</HeaderCell>
                  <HeaderCell>Onde</HeaderCell>
                  <HeaderCell>Itens</HeaderCell>
                  <HeaderCell>Resgates</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {kits.map((kit) => (
                  <tr key={kit.id} className={cn(!kit.enabled && 'text-muted')}>
                    <td className="px-3 py-2">
                      <p className="truncate">{kit.name}</p>
                      <p className="truncate font-mono text-2xs text-muted">{kit.slug}</p>
                    </td>

                    <td className="px-3 py-2">{regraDe(kit)}</td>

                    <td className="px-3 py-2 text-muted">{kit.requiredTier ?? EM_DASH}</td>

                    {/* Os NOMES, e não a contagem: "2 servidores"
                        obriga a ir procurar quais. */}
                    <td className="px-3 py-2 text-muted">
                      {kit.servers.length === 0 ? (
                        <span className="text-amber">nenhum</span>
                      ) : (
                        kit.servers.join(', ')
                      )}
                    </td>

                    <td className="px-3 py-2 text-muted">{kit.items.length}</td>

                    <td className="px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void openClaims(kit)}
                      >
                        {kit.claimCount}
                      </Button>
                    </td>

                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {!kit.enabled && <span className="text-2xs text-amber">fora do ar</span>}

                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(kit)}
                        >
                          Editar
                        </Button>

                        <ConfirmButton
                          variant="danger"
                          disabled={busy}
                          icon={null}
                          label="Remover"
                          confirmLabel="Remover mesmo"
                          hint={
                            kit.claimCount === 0
                              ? `"${kit.name}" some da loja.`
                              : `"${kit.name}" some da loja e leva ${String(kit.claimCount)} resgate(s) de histórico. Para preservá-los, desligue o kit.`
                          }
                          onConfirm={() => void remove(kit)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {claimsOf !== null && (
          <div className="border border-border bg-surface">
            <div className="border-b border-border px-3 py-2">
              <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
                <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
                Quem já pegou
              </h2>
            </div>

            <div className="p-3">
              {claims === null && <StateBlock variant="loading" title="Lendo…" />}

              {claims !== null && claims.length === 0 && (
                <StateBlock variant="empty" title="Ninguém pegou este kit ainda" />
              )}

              {claims !== null && claims.length > 0 && (
                <ul className="divide-y divide-border">
                  {claims.map((claim) => (
                    <li key={claim.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2 text-sm">
                      <span className="min-w-40">{claim.playerName ?? claim.steamId}</span>
                      <span className="text-2xs text-muted">{claim.serverId}</span>
                      <span className="text-2xs text-muted">{formatWhen(claim.claimedAt)}</span>
                      <span
                        className={cn(
                          'text-2xs',
                          claim.status === 'entregue' ? 'text-muted' : 'text-amber',
                        )}
                      >
                        {claim.status}
                        {claim.detail === null ? '' : ` — ${claim.detail}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          A entrega exige o jogador <strong>dentro do servidor</strong>: item entra em inventário, e
          inventário só existe para quem está conectado. Uma tentativa que falha fica no histórico,
          com o motivo — e não queima o resgate de quem não recebeu nada.
        </p>
      </div>

      {editing !== undefined && (
        <KitDialog
          open
          kit={editing}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

/** "R$ 19,90", "uma vez por jogador" ou "a cada 24 h". */
function regraDe(kit: Kit): string {
  if (kit.kind === 'compra') {
    return kit.priceCents === null
      ? EM_DASH
      : (kit.priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  if (kit.kind === 'resgate') {
    return 'uma vez por jogador';
  }

  return kit.cooldownSeconds === null
    ? EM_DASH
    : `a cada ${String(Math.round(kit.cooldownSeconds / 3600))} h`;
}
