'use client';

// ============================================================
//  vip-dialog.tsx  -  conceder ou RENOVAR um VIP.
//
//  Um formulário só para as duas coisas, porque o agente também
//  tem um caminho só: o mesmo POST estende a concessão que já
//  existe. Uma tela "renovar" separada abriria a chance de criar
//  uma segunda concessão do mesmo nível — que o índice único
//  recusaria com um erro que ninguém entende.
//
//  ------------------------------------------------------------
//  ####  OS NÍVEIS VÊM DO SERVIDOR, NÃO DE UMA LISTA DAQUI  ####
//
//  Eles saem do `OrigemZVip.json` de cada servidor
//  (`GET /api/vips/tiers`). Um campo de texto livre aqui deixaria
//  alguém vender um "diamante" que não existe em servidor nenhum —
//  e o VIP apareceria ativo na tela, sem efeito nenhum no jogo.
//
//  ####  O PRAZO É EM DIAS AQUI, E EM DATA NA API  ####
//
//  Quem vende pensa em "30 dias"; o agente guarda o vencimento. A
//  conta é da TELA de propósito: o agente não sabe se o pacote é de
//  30 dias corridos ou de um mês de calendário, e essa decisão é de
//  quem vende.
//
//  ####  RENOVAR SOMA SOBRE O VENCIMENTO  ####
//
//  Quem já tem 20 dias e compra 30 fica com 50. A tela DIZ isso
//  antes de o botão ser apertado, porque é a pergunta que quem
//  administra faz na hora ("vou perder os dias dele?").
// ============================================================

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { agent, type Vip, type VipTier } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Os prazos que se vende. O resto vai no campo de dias. */
const PRESETS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
  { days: null, label: 'Vitalício' },
];

interface VipDialogProps {
  readonly open: boolean;
  /** Preenchido quando o diálogo vem da ficha de um jogador. */
  readonly steamId?: string;
  /** O que ele já tem, para a tela avisar que vai RENOVAR. */
  readonly current?: readonly Vip[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function VipDialog({ open, steamId, current = [], onClose, onDone }: VipDialogProps) {
  const [tiers, setTiers] = useState<VipTier[] | null>(null);
  const [tiersMessage, setTiersMessage] = useState<string | null>(null);

  const [id, setId] = useState(steamId ?? '');
  const [tier, setTier] = useState('');
  const [days, setDays] = useState<number | null>(30);
  const [origin, setOrigin] = useState<'loja' | 'painel'>('painel');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await agent.vipTiers();

        setTiers(response.tiers);
        setTiersMessage(response.message ?? null);
        setTier((previous) => (previous === '' ? (response.tiers[0]?.tier ?? '') : previous));
      } catch (cause) {
        setTiersMessage(cause instanceof Error ? cause.message : String(cause));
        setTiers([]);
      }
    })();
  }, []);

  const renewing = current.find((vip) => vip.tier === tier && vip.active);

  async function submit(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.grantVip({
        steamId: id.trim(),
        tier,
        // A conta da tela: dias viram a data de vencimento. `null` é
        // vitalício, e vai explícito.
        expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
        origin,
      });

      toast.success(response.outcome === 'created' ? 'VIP concedido' : 'VIP renovado', {
        description: response.message,
      });

      onDone();
      onClose();
    } catch (cause) {
      toast.error('Não consegui conceder', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Conceder VIP" busy={busy} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label>SteamID</Label>
          <Input
            value={id}
            placeholder="76561198000000000"
            disabled={busy || steamId !== undefined}
            onChange={(event) => setId(event.target.value.trim())}
            className="font-mono"
          />
          <p className="mt-1 text-2xs text-muted">
            17 dígitos, começando em 7656. O VIP é da <strong>rede</strong>: vale em todos os
            servidores deste agente.
          </p>
        </div>

        <div>
          <Label>Nível</Label>
          {tiers !== null && tiers.length > 0 ? (
            <select
              value={tier}
              disabled={busy}
              onChange={(event) => setTier(event.target.value)}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              {tiers.map((option) => (
                <option key={option.tier} value={option.tier}>
                  {option.title ?? option.tier} ({option.tier})
                </option>
              ))}
            </select>
          ) : (
            <p className="border border-amber bg-surface-2 px-3 py-2 text-2xs leading-relaxed">
              {tiersMessage ??
                'Nenhum servidor declarou níveis de VIP. Eles vêm do OrigemZVip.json de cada servidor, criado no primeiro carregamento do plugin.'}
            </p>
          )}

          {tiers !== null && tier !== '' && (
            <p className="mt-1 text-2xs text-muted">
              Grupo do Oxide: <code>{tiers.find((option) => option.tier === tier)?.group ?? '—'}</code>
              . É nele que o jogador entra.
            </p>
          )}
        </div>

        <div>
          <Label>Prazo</Label>
          <div className="flex flex-wrap items-stretch border border-border">
            {PRESETS.map((preset, index) => (
              <div key={preset.label} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={days === preset.days}
                  disabled={busy}
                  onClick={() => setDays(preset.days)}
                  className={cn(
                    'px-3 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    days === preset.days
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {preset.label}
                </button>
              </div>
            ))}
          </div>

          {days !== null && (
            <div className="mt-2">
              <Input
                type="number"
                min={1}
                max={3650}
                value={days}
                disabled={busy}
                onChange={(event) => setDays(Math.max(1, Number(event.target.value)))}
              />
              <p className="mt-1 text-2xs text-muted">
                Vence em {new Date(Date.now() + days * 86_400_000).toLocaleDateString('pt-BR')}
                {renewing === undefined
                  ? '.'
                  : ' — somados ao que ele já tem, e não no lugar deles.'}
              </p>
            </div>
          )}
        </div>

        <div>
          <Label>De onde veio</Label>
          <select
            value={origin}
            disabled={busy}
            onChange={(event) => setOrigin(event.target.value === 'loja' ? 'loja' : 'painel')}
            className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
          >
            <option value="painel">Painel — um admin concedeu</option>
            <option value="loja">Loja — foi comprado</option>
          </select>
        </div>

        {renewing !== undefined && (
          <p className="border border-amber bg-surface-2 px-3 py-2 text-2xs leading-relaxed">
            Este jogador <strong>já tem</strong> o nível {renewing.tier}
            {renewing.expiresAt === null
              ? ' (vitalício)'
              : `, até ${new Date(renewing.expiresAt).toLocaleDateString('pt-BR')}`}
            . Gravar vai <strong>renovar</strong>: o tempo novo é somado ao que falta, e nenhum dia
            se perde.
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button
            variant="primary"
            disabled={busy || id.trim() === '' || tier === ''}
            onClick={() => void submit()}
          >
            {busy ? 'Gravando…' : renewing === undefined ? 'Conceder' : 'Renovar'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
