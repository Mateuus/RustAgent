'use client';

// ============================================================
//  postpone-dialog.tsx  -  adiar um wipe, com a data à vista.
//
//  Vive em arquivo próprio porque DUAS telas adiam o mesmo wipe:
//  a sub-aba Geral (o próximo, em destaque) e a Agenda (qualquer
//  um da lista). Duas caixas com regras próprias divergiriam na
//  primeira mudança — e a regra aqui é a que impede um clique de
//  remarcar o wipe de uma rede inteira.
// ============================================================

import { useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatShortMoment, fromDateTimeFields, toDateTimeFields } from '@/components/wipe/labels';
import { formatCountdown, type AgentClock } from '@/components/wipe/use-agent-clock';
import type { WipePlan } from '@/lib/api';

/**
 * De quanto em quanto se costuma empurrar um wipe.
 *
 * Uma semana está aqui porque é o pulo que mantém o wipe no MESMO
 * dia da semana — adiar a quinta para a quinta seguinte é o caso
 * mais comum de todos, e com 24 h ele exigia sete cliques.
 */
const POSTPONE_SHORTCUTS: readonly { readonly hours: number; readonly label: string }[] = [
  { hours: 24, label: '+ 1 dia' },
  { hours: 48, label: '+ 2 dias' },
  { hours: 72, label: '+ 3 dias' },
  { hours: 168, label: '+ 1 semana' },
];
/**
 * Adiar, com a data à vista antes de valer.
 *
 * ####  ADIAR MEXE NA AGENDA, E AGENDA É COMBINADO  ####
 *
 * O botão empurrava 24 horas no primeiro clique, sem perguntar e
 * sem desfazer. Um clique errado remarcava o wipe de uma rede
 * inteira — e quem clicou só descobria pela linha mudando de dia.
 *
 * O que mudou não é só a confirmação: 24 horas era a ÚNICA
 * distância possível. Adiar um wipe de quinta para sábado exigia
 * clicar duas vezes e torcer, ou abrir o editor e calcular a data
 * na mão. Aqui os atalhos cobrem o comum e o campo cobre o resto,
 * com o resultado escrito por extenso antes de qualquer coisa
 * acontecer.
 */
export function PostponeDialog({
  plan,
  open,
  busy,
  clock,
  onConfirm,
  onClose,
}: {
  readonly plan: WipePlan;
  readonly open: boolean;
  readonly busy: boolean;
  readonly clock: AgentClock;
  readonly onConfirm: (scheduledAt: number) => void;
  readonly onClose: () => void;
}) {
  const inicial = toDateTimeFields(plan.scheduledAt);
  const [date, setDate] = useState(inicial.date);
  const [time, setTime] = useState(inicial.time);

  // Reabrir a caixa depois de um adiamento tem que mostrar a data
  // NOVA, e não a que estava em tela na primeira vez.
  useEffect(() => {
    if (open) {
      const campos = toDateTimeFields(plan.scheduledAt);

      setDate(campos.date);
      setTime(campos.time);
    }
  }, [open, plan.scheduledAt]);

  const at = fromDateTimeFields(date, time);
  const past = at !== null && clock.now !== null && at <= clock.now;
  const igual = at === plan.scheduledAt;
  const podeAdiar = at !== null && !past && !igual;

  /** Os atalhos escrevem nos campos: o resultado fica visível. */
  const empurrar = (hours: number): void => {
    const campos = toDateTimeFields(plan.scheduledAt + hours * 60 * 60 * 1_000);

    setDate(campos.date);
    setTime(campos.time);
  };

  return (
    <Dialog open={open} title="Adiar este wipe" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Hoje ele está marcado para{' '}
          <strong className="text-foreground">{formatShortMoment(plan.scheduledAt)}</strong>.
        </p>

        <div>
          <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Empurrar
          </span>

          <div className="mt-1 flex flex-wrap gap-2">
            {POSTPONE_SHORTCUTS.map((item) => (
              <Button
                key={item.hours}
                size="sm"
                variant="outline"
                onClick={() => {
                  empurrar(item.hours);
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`adiar-${String(plan.id)}-date`}>Dia</Label>
            <Input
              id={`adiar-${String(plan.id)}-date`}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor={`adiar-${String(plan.id)}-time`}>Hora</Label>
            <Input
              id={`adiar-${String(plan.id)}-time`}
              type="time"
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
              }}
              className="mt-1"
            />
          </div>
        </div>

        {/* O resultado por extenso: é o que a pessoa confere antes
            de apertar, e o que falta quando o botão age sozinho. */}
        {at !== null && !past && (
          <StateBlock
            variant={igual ? 'empty' : 'loading'}
            title={
              igual
                ? 'É a mesma data de agora.'
                : `Passa a ser ${formatShortMoment(at)}`
            }
            detail={
              igual
                ? 'Escolha um instante diferente, ou feche a caixa.'
                : clock.now === null
                  ? undefined
                  : `Daqui a ${formatCountdown(at - clock.now)}.`
            }
          />
        )}

        {past && (
          <StateBlock
            variant="error"
            title="Essa data já passou."
            detail="O agente não mexe no passado: escolha um instante à frente do relógio dele."
          />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button
            variant="confirm"
            disabled={busy || !podeAdiar}
            onClick={() => {
              if (at !== null) {
                onConfirm(at);
              }
            }}
          >
            Adiar o wipe
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
