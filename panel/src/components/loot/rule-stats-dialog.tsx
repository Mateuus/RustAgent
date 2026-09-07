'use client';

// ============================================================
//  rule-stats-dialog.tsx  -  o que a regra contou, por dia.
//
//  ####  É O QUE FAZ O MODO DE MEDIÇÃO VALER A PENA  ####
//
//  Uma regra medindo não cria item nenhum. Sem esta tela ela seria
//  uma regra que não faz NADA visível — o admin ligaria, esperaria
//  e concluiria que a ferramenta está quebrada.
//
//  ####  E É AQUI QUE O DENOMINADOR APARECE  ####
//
//  Quantos contêineres daqueles o mapa popula por dia não é medido
//  em lugar nenhum (Docs/CustomItem/05 §9.6): o formulário
//  trabalha com um palpite. A contagem responde isso por divisão —
//  sorteios por dia, dividido pela chance, é o número de caixas
//  que passaram pela regra. O botão ao lado leva esse número para
//  a tela toda, e a partir daí a projeção deixa de ser chute.
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  averageOf,
  formatApprox,
  formatRate,
  impliedContainersPerDay,
} from '@/components/loot/chance';
import { ruleToInput } from '@/components/loot/rule-form';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { agent, ApiError, type LootRule, type LootRuleStatsDay } from '@/lib/api';
import { EM_DASH, formatInteger } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface RuleStatsDialogProps {
  readonly open: boolean;
  readonly rule: LootRule | null;
  readonly onClose: () => void;
  /** A regra mudou de modo aqui dentro: a lista precisa reler. */
  readonly onChanged: () => void;
  /** Levar o denominador medido para o resto da tela. */
  readonly onContainersPerDayChange: (value: number) => void;
}

export function RuleStatsDialog({
  open,
  rule,
  onClose,
  onChanged,
  onContainersPerDayChange,
}: RuleStatsDialogProps) {
  const [days, setDays] = useState<readonly LootRuleStatsDay[] | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  const ruleId = rule?.id ?? null;

  const load = useCallback(async () => {
    if (ruleId === null) return;

    setDays(null);
    setError(null);

    try {
      const response = await agent.lootRuleStats(ruleId);

      setDays(response.days);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [ruleId]);

  useEffect(() => {
    if (!open) return;

    void load();
  }, [open, load]);

  if (rule === null) {
    return null;
  }

  const rollsPerDay = days === null ? null : averageOf(days.map((day) => day.rolls));
  const emittedPerDay = days === null ? null : averageOf(days.map((day) => day.emitted));
  const implied = impliedContainersPerDay(rollsPerDay, rule.chance);

  const measuring = rule.mode === 'measuring';

  const switchMode = async (): Promise<void> => {
    setBusy(true);

    try {
      // O PUT reescreve a regra inteira (é a regra da rota), então
      // trocar de modo manda a regra de volta com um campo
      // diferente — e não um PATCH que a API não tem.
      await agent.updateLootRule(rule.id, {
        ...ruleToInput(rule),
        mode: measuring ? 'live' : 'measuring',
      });

      toast.success(
        measuring
          ? `"${rule.label}" passou a valer: o item começa a cair.`
          : `"${rule.label}" voltou a só medir: nada mais cai por ela.`,
      );
      onChanged();
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      busy={busy}
      onClose={onClose}
      className="w-[min(46rem,94vw)]"
      title={`Contagem de "${rule.label}"`}
    >
      <div className="space-y-4">
        <p
          className={cn(
            'border px-3 py-2 text-2xs leading-relaxed',
            measuring ? 'border-amber text-amber' : 'border-olive text-foreground',
          )}
        >
          {measuring ? (
            <>
              <strong className="text-foreground">Esta regra está só medindo.</strong> Ela é
              sorteada a cada contêiner, o resultado é contado aqui, e{' '}
              <strong className="text-foreground">nenhum item é criado</strong>. É de propósito:
              primeiro se descobre quantas vezes por dia ela dispararia, depois se decide a chance.
            </>
          ) : (
            <>
              <strong>Esta regra está valendo.</strong> O que a coluna &quot;saíram&quot; mostra são
              itens que foram parar na mão de alguém.
            </>
          )}
        </p>

        {error !== null && (
          <StateBlock
            variant="error"
            title="Não consegui ler a contagem"
            // A frase é do CORE. Quando ela vier com 404, é porque
            // esta rota ainda não existe do outro lado — e é isso
            // que o admin precisa saber, em vez de um "erro".
            detail={
              error instanceof ApiError && error.status === 404
                ? `${error.message} (o agente ainda não responde /api/loot/rules/${rule.id}/stats)`
                : error.message
            }
          />
        )}

        {days === null && error === null && (
          <StateBlock variant="loading" title="Lendo o que a regra contou…" />
        )}

        {days !== null && days.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nada contado ainda"
            detail="A regra conta a partir do momento em que o plugin a recebe. Num servidor no meio do wipe, os contêineres que já existem só passam por ela quando refazem o loot."
          />
        )}

        {days !== null && days.length > 0 && (
          <>
            <div className="overflow-x-auto border border-border bg-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr>
                    <HeaderCell>Dia</HeaderCell>
                    <HeaderCell className="text-right">
                      {measuring ? 'Teria disparado' : 'Disparou'}
                    </HeaderCell>
                    <HeaderCell className="text-right">Saíram</HeaderCell>
                    <HeaderCell className="text-right">Contêineres vistos</HeaderCell>
                  </tr>
                </thead>

                <tbody className="divide-y divide-border">
                  {days.map((day) => (
                    <tr key={day.day} className="hover:bg-surface-2">
                      <td className="px-3 py-1.5 font-mono text-2xs text-muted">{day.day}</td>
                      <td className="px-3 py-1.5 text-right text-foreground">
                        {formatInteger(day.rolls)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {/* Em medição a coluna é zero por
                            construção, e um zero aqui não é
                            ausência: é a promessa cumprida. */}
                        <span className={measuring ? 'text-muted' : 'text-foreground'}>
                          {formatInteger(day.emitted)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-muted">
                        {formatInteger(day.containers)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="grid gap-x-4 gap-y-1 text-2xs sm:grid-cols-2">
              <Row
                term="No ritmo contado"
                value={rollsPerDay === null ? EM_DASH : formatRate(rollsPerDay * 7)}
              />
              <Row
                term="Sorteios por dia"
                value={rollsPerDay === null ? EM_DASH : formatApprox(rollsPerDay)}
              />
              <Row
                term="Itens por dia"
                value={emittedPerDay === null ? EM_DASH : formatApprox(emittedPerDay)}
              />
              <Row term="Dias contados" value={formatInteger(days.length)} />
            </dl>

            {implied !== null && (
              <p className="flex flex-wrap items-center gap-2 border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
                <span>
                  Com a chance de{' '}
                  <strong className="text-foreground">
                    1 em {formatApprox(1 / rule.chance)}
                  </strong>
                  , esses sorteios só acontecem se o mapa estiver populando{' '}
                  <strong className="text-amber">
                    ≈ {formatApprox(implied)} contêineres por dia
                  </strong>{' '}
                  desses. Esse é o número que ninguém tinha medido.
                </span>

                <Button size="sm" onClick={() => onContainersPerDayChange(Math.round(implied))}>
                  Usar na projeção
                </Button>
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <Button variant="ghost" disabled={busy} onClick={() => void load()}>
            Reler
          </Button>

          <div className="flex gap-2">
            {measuring ? (
              <ConfirmButton
                variant="primary"
                disabled={busy}
                icon={<span aria-hidden="true">▶</span>}
                label="Pôr para valer"
                confirmLabel="Pôr para valer mesmo"
                hint="A partir daqui o item cai de verdade — nos contêineres que nascerem ou refizerem o loot. Os que já estão no mapa não mudam."
                onConfirm={() => void switchMode()}
              />
            ) : (
              <ConfirmButton
                variant="danger"
                disabled={busy}
                icon={<span aria-hidden="true">⏸</span>}
                label="Voltar a só medir"
                confirmLabel="Voltar a medir mesmo"
                hint="A regra para de criar item e volta a só contar. O que já caiu no mapa continua lá."
                onConfirm={() => void switchMode()}
              />
            )}

            <Button variant="outline" disabled={busy} onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ term, value }: { readonly term: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 py-0.5">
      <dt className="font-condensed uppercase tracking-wide text-muted">{term}</dt>
      <dd className="text-right text-foreground">{value}</dd>
    </div>
  );
}

function HeaderCell({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
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
