'use client';

// ============================================================
//  tab-blueprints.tsx  -  "quem recomeça sabendo o quê?"
//
//  ####  ISTO MUDA O JOGO PARA QUEM NÃO PAGOU  ####
//
//  Um VIP que começa o wipe sabendo fazer AK contra um novato que
//  precisa de scrap não é diferença cosmética — é o item mais
//  forte do jogo na primeira hora. A régua por nível e o atraso em
//  horas existem para dosar, e por isso os dois estão aqui, lado a
//  lado, e não escondidos em telas diferentes.
//
//  ####  A POLÍTICA DE CADA WIPE NÃO SE ESCOLHE AQUI  ####
//
//  "manter / zerar / zerar menos para VIP" é da linha de cada wipe,
//  na sub-aba Agenda. Aqui se responde a pergunta seguinte: quando
//  a política for `wipe_except_vip`, QUANTO cada nível leva de
//  volta, e com quanto atraso.
//
//  ####  E O SNAPSHOT PRECISA DO SERVIDOR NO AR  ####
//
//  Ele é lido pelo OrigemZAgent dentro do jogo. Com o servidor
//  parado, o agente responde 503 com a frase — e a tela mostra a
//  frase, em vez de fingir que guardou uma cópia.
// ============================================================

import { AlertTriangle, Camera, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  type BpCounters,
  type BpRuleMode,
  type BpSettings,
  type BpSnapshot,
  type BpTierRule,
} from '@/lib/api';
import { formatInteger, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * A ordem em que os níveis aparecem.
 *
 * Ela é fixa para os três que o OrigemZVip traz de fábrica, e o
 * que o dono do servidor criou entra depois, em ordem alfabética —
 * uma lista que muda de ordem a cada leitura faria o admin clicar
 * na linha errada.
 */
const TIER_ORDER = ['bronze', 'silver', 'gold'];

const TIER_LABEL: Readonly<Record<string, string>> = {
  bronze: 'Bronze',
  silver: 'Prata',
  gold: 'Ouro',
};

const MODE_LABEL: Readonly<Record<BpRuleMode, string>> = {
  none: 'nada',
  bench: 'até a bancada',
  all: 'tudo',
};

export function TabBlueprints({ serverId }: { readonly serverId: string }) {
  const [settings, setSettings] = useState<BpSettings | null>(null);
  const [snapshot, setSnapshot] = useState<BpSnapshot | null>(null);
  const [counters, setCounters] = useState<BpCounters | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [steamId, setSteamId] = useState('');
  const [force, setForce] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.wipeBlueprints(serverId);

      setSettings(response.settings);
      setSnapshot(response.snapshot);
      setCounters(response.counters);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: BpSettings) => {
      setBusy(true);
      // Otimista: a régua precisa responder ao clique, e o agente
      // devolve o estado gravado logo em seguida.
      setSettings(next);

      try {
        const response = await agent.saveWipeBlueprints(serverId, next);

        setSettings(response.settings);
        toast.success('Régua salva', { description: response.message });
      } catch (cause) {
        toast.error('Não deu para salvar', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, serverId],
  );

  const take = useCallback(async () => {
    setBusy(true);

    try {
      const response = await agent.takeWipeBlueprintSnapshot(serverId);

      setSnapshot(response.snapshot);
      toast.success('Snapshot tirado', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não deu para tirar o snapshot', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }, [load, serverId]);

  const restore = useCallback(async () => {
    const target = steamId.trim();

    if (!/^\d{17}$/.test(target)) {
      toast.error('SteamID inválido', {
        description: 'Um SteamID64 tem 17 dígitos. É por ele que o agente acha o snapshot.',
      });
      return;
    }

    setBusy(true);

    try {
      const response = await agent.restoreWipeBlueprints(serverId, { steamId: target, force });

      setCounters(response.counters);

      // `sent: 0` não é erro: é "ele não tinha direito", "o
      // snapshot expirou" ou "a régua não devolve nada". Em todos, a
      // frase do agente explica — e ela é o conteúdo do aviso.
      if (response.sent === 0) {
        toast.error('Nada foi devolvido', { description: response.message });
      } else {
        toast.success('Blueprints devolvidos', { description: response.message });
      }
    } catch (cause) {
      toast.error('Não deu para devolver', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }, [force, serverId, steamId]);

  if (loading) {
    return <StateBlock variant="loading" title="Consultando o agente…" />;
  }

  if (error !== null || settings === null) {
    return (
      <StateBlock
        variant="error"
        title="Não consegui ler a régua de blueprints."
        detail={error ?? 'O agente respondeu sem a configuração.'}
      />
    );
  }

  const tiers = orderedTiers(settings);

  const setRule = (tier: string, rule: BpTierRule): void => {
    void save({ ...settings, tiers: { ...settings.tiers, [tier]: rule } });
  };

  return (
    <div className="space-y-4">
      {/* ---- A RÉGUA ---- */}
      <Section title="A régua por nível">
        <div className="space-y-3">
          <p className="text-2xs text-muted">
            Vale para os wipes cuja política é <strong>zerar, menos para quem tem VIP</strong>. O
            snapshot é de <strong>todo mundo</strong>: quem recebe de volta é decidido na hora da
            devolução, contra o VIP daquele instante — quem comprar VIP no dia seguinte ao wipe
            ainda recebe.
          </p>

          <ul className="space-y-2">
            {tiers.map((tier) => (
              <li
                key={tier}
                className="flex flex-wrap items-center gap-3 border-b border-border pb-2 last:border-0"
              >
                <span className="w-20 shrink-0 font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                  {TIER_LABEL[tier] ?? tier}
                </span>

                {(['none', 'bench', 'all'] as const).map((mode) => (
                  <label key={mode} className="flex cursor-pointer items-center gap-1 text-sm">
                    <input
                      type="radio"
                      name={`bp-${tier}`}
                      checked={settings.tiers[tier]?.mode === mode}
                      disabled={busy}
                      onChange={() =>
                        setRule(tier, { mode, bench: settings.tiers[tier]?.bench ?? 1 })
                      }
                    />
                    <span
                      className={cn(
                        settings.tiers[tier]?.mode === mode ? 'text-foreground' : 'text-muted',
                      )}
                    >
                      {MODE_LABEL[mode]}
                    </span>
                  </label>
                ))}

                <select
                  aria-label={`Bancada do nível ${TIER_LABEL[tier] ?? tier}`}
                  value={String(settings.tiers[tier]?.bench ?? 1)}
                  disabled={busy || settings.tiers[tier]?.mode !== 'bench'}
                  onChange={(event) =>
                    setRule(tier, { mode: 'bench', bench: Number(event.target.value) })
                  }
                  className="h-9 border border-border bg-surface-2 px-2 text-sm text-foreground disabled:opacity-50"
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-24">
              <Label htmlFor="bp-delay">Devolver depois de</Label>
              <Input
                id="bp-delay"
                inputMode="numeric"
                defaultValue={String(settings.delayHours)}
                disabled={busy}
                onBlur={(event) => {
                  const hours = Number(event.target.value.trim());

                  if (!Number.isFinite(hours) || hours < 0) {
                    toast.error('Atraso inválido', {
                      description: 'É um número de horas, e 0 quer dizer "assim que ele entrar".',
                    });
                    return;
                  }

                  if (Math.round(hours) !== settings.delayHours) {
                    void save({ ...settings, delayHours: Math.round(hours) });
                  }
                }}
              />
            </div>
            <span className="pb-2 text-sm text-muted">horas do wipe</span>
          </div>

          {settings.delayHours > 0 && (
            <p className="flex items-start gap-2 text-2xs text-muted">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-rust" />
              Com atraso, a corrida inicial acontece <strong>sem</strong> a vantagem: o VIP entra
              sem nada e recebe {formatInteger(settings.delayHours)} h depois, ao entrar de novo.
            </p>
          )}
        </div>
      </Section>

      {/* ---- O SNAPSHOT ---- */}
      <Section
        title="O último snapshot"
        aside={
          <Button size="sm" disabled={busy} onClick={() => void take()}>
            <Camera aria-hidden className="mr-1 h-3 w-3" />
            tirar agora
          </Button>
        }
      >
        {snapshot === null ? (
          <StateBlock
            variant="empty"
            title="Nenhum snapshot guardado neste servidor."
            detail="Ele é tirado sozinho no último instante antes de o mundo ser apagado, e só quando o wipe é do tipo que zera os blueprints menos para quem tem VIP. O botão acima existe para conferir que o caminho funciona ANTES do dia do wipe."
          />
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-foreground">
              {formatInteger(snapshot.players)} jogador(es) · {formatInteger(snapshot.items)}{' '}
              blueprint(s)
            </p>
            <p className="text-2xs text-muted">
              tirado em {formatWhen(new Date(snapshot.createdAt).toISOString())}
              {snapshot.wipeRunId === null
                ? ' — na mão, pelo painel'
                : `, antes da execução #${String(snapshot.wipeRunId)}`}
              . Ele vale para o <strong>próximo wipe, e só para ele</strong>.
            </p>

            {counters !== null && (
              <ul className="flex flex-wrap gap-3 pt-1 text-2xs">
                <Counter label="devolvidos" value={counters.applied} tone="ok" />
                <Counter label="a caminho" value={counters.sent} />
                <Counter label="aguardando o jogador" value={counters.pending} />
                <Counter label="falharam" value={counters.failed} tone="bad" />
                <Counter label="expirados" value={counters.expired} />
              </ul>
            )}
          </div>
        )}
      </Section>

      {/* ---- DEVOLVER NA MÃO ---- */}
      <Section title="Devolver na mão">
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <Label htmlFor="bp-steamid">SteamID64 do jogador</Label>
              <Input
                id="bp-steamid"
                inputMode="numeric"
                placeholder="7656119…"
                value={steamId}
                disabled={busy}
                onChange={(event) => setSteamId(event.target.value)}
              />
            </div>
            <Button size="md" disabled={busy} onClick={() => void restore()}>
              <Undo2 aria-hidden className="mr-1 h-4 w-4" />
              devolver os BPs
            </Button>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-2xs text-muted">
            <input
              type="checkbox"
              checked={force}
              disabled={busy}
              onChange={(event) => setForce(event.target.checked)}
            />
            devolver tudo mesmo sem VIP — é o botão do suporte, para quando a régua e o direito não
            contam a mesma história
          </label>

          <p className="text-2xs text-muted">
            A devolução acontece <strong>no login</strong>: o jogo só ensina blueprint a um jogador
            carregado. Com ele fora, o agente guarda a pendência e entrega assim que ele entrar.
          </p>
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------
//  Peças
// ------------------------------------------------------------

function Counter({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'ok' | 'bad';
}) {
  return (
    <li className="flex items-baseline gap-1">
      <span
        className={cn(
          'font-mono text-sm',
          value === 0 ? 'text-muted' : tone === 'ok' ? 'text-foreground' : 'text-foreground',
          tone === 'bad' && value > 0 ? 'text-rust' : '',
        )}
      >
        {formatInteger(value)}
      </span>
      <span className="text-muted">{label}</span>
    </li>
  );
}

/** Os três de fábrica primeiro; o que o servidor criou, depois. */
function orderedTiers(settings: BpSettings): readonly string[] {
  const known = Object.keys(settings.tiers);
  const extra = known.filter((tier) => !TIER_ORDER.includes(tier)).sort();

  return [...TIER_ORDER, ...extra];
}
