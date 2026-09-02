'use client';

// ============================================================
//  day-dialog.tsx  -  um dia da grade, aberto por inteiro.
//
//  ####  POR QUE UMA CAIXA, E NÃO UM BALÃO MAIOR  ####
//
//  O balão da grade cabe numa frase por linha e some quando o
//  mouse sai — não dá para copiar dele, não dá para agir a partir
//  dele, e num toque ele nem abre. Tudo o que o admin faz depois
//  de olhar um dia ("esse aí eu movo") exigia descer até a lista e
//  encontrar a mesma data outra vez.
//
//  Aqui o dia vem inteiro: cada wipe com TODOS os campos que o
//  agente guarda, e as ações do lado do wipe a que pertencem.
//
//  ####  ELE NÃO SALVA NADA  ####
//
//  Nenhuma ação daqui muda a agenda sozinha: cada botão fecha esta
//  caixa e abre a caixa que já existe para aquilo (editar, mover,
//  deletar), que é onde a confirmação mora. Duas telas capazes de
//  gravar a mesma coisa é como se ganha duas regras de validação
//  que divergem seis meses depois.
//
//  A exceção é RESTAURAR, que devolve o wipe à agenda na mesma
//  data — não há o que perguntar, e ele já é o desfazer de outra
//  coisa.
// ============================================================

import { CalendarClock, Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  BP_POLICY_LABEL,
  KIND_LABEL,
  MAP_SOURCE_LABEL,
  STATUS_LABEL,
  formatFullDay,
  formatMoment,
  formatShortMoment,
  formatTime,
  isPending,
} from '@/components/wipe/labels';
import { formatCountdown, type AgentClock } from '@/components/wipe/use-agent-clock';
import type { WipePlan } from '@/lib/api';
import { cn } from '@/lib/utils';

/** O que dá para fazer com um wipe, e que tem caixa própria. */
export type PlanActionKind = 'edit' | 'move' | 'remove' | 'purge';

export interface WipeDayDialogProps {
  readonly open: boolean;
  /** Os wipes daquele dia, do mais cedo para o mais tarde. */
  readonly plans: readonly WipePlan[];
  readonly clock: AgentClock;
  readonly busy: boolean;
  /** Fecha esta caixa e abre a que faz a coisa. */
  readonly onAction: (plan: WipePlan, kind: PlanActionKind) => void;
  readonly onRestore: (plan: WipePlan) => void;
  readonly onClose: () => void;
}

export function WipeDayDialog({
  open,
  plans,
  clock,
  busy,
  onAction,
  onRestore,
  onClose,
}: WipeDayDialogProps) {
  // O título sai do primeiro wipe, e não da chave do dia: a caixa
  // só abre em dia que tem alguma coisa marcada, e assim não há um
  // segundo jeito de escrever uma data no painel.
  const first = plans[0];
  const title = first === undefined ? 'Dia' : formatFullDay(first.scheduledAt);

  return (
    <Dialog open={open} title={title} busy={busy} onClose={onClose} className="w-[min(34rem,92vw)]">
      <div className="space-y-3">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            clock={clock}
            busy={busy}
            onAction={onAction}
            onRestore={onRestore}
          />
        ))}
      </div>
    </Dialog>
  );
}

/** O tom da barra de acento, o mesmo da grade lá em cima. */
function edgeClass(plan: WipePlan): string {
  if (!isPending(plan)) {
    return 'border-l-muted';
  }

  if (plan.kind === 'forced') {
    return 'border-l-rust';
  }

  return plan.kind === 'manual' ? 'border-l-amber' : 'border-l-olive';
}

function PlanCard({
  plan,
  clock,
  busy,
  onAction,
  onRestore,
}: {
  readonly plan: WipePlan;
  readonly clock: AgentClock;
  readonly busy: boolean;
  readonly onAction: (plan: WipePlan, kind: PlanActionKind) => void;
  readonly onRestore: (plan: WipePlan) => void;
}) {
  const pending = isPending(plan);
  const remaining = clock.now === null ? null : plan.scheduledAt - clock.now;
  const future = pending && remaining !== null && remaining > 0;

  return (
    <article className={cn('border border-border border-l-[3px] bg-surface-2 p-3', edgeClass(plan))}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3
          className={cn(
            'font-condensed text-base font-bold tabular-nums',
            pending ? 'text-foreground' : 'text-muted line-through decoration-rust',
          )}
        >
          {`${formatTime(plan.scheduledAt)} · ${KIND_LABEL[plan.kind]}`}
        </h3>

        <span className="text-2xs tabular-nums text-muted">
          {future && remaining !== null
            ? `em ${formatCountdown(remaining)}`
            : STATUS_LABEL[plan.status]}
        </span>
      </header>

      {/* Uma <dl> e não uma tabela: são pares rótulo/valor, e o
          leitor de tela anuncia os dois juntos sem precisar de
          cabeçalho de coluna nenhum. */}
      <dl className="mt-3 grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <Field label="Quando">{formatMoment(plan.scheduledAt)}</Field>
        <Field label="Blueprints">{BP_POLICY_LABEL[plan.bpPolicy]}</Field>
        <Field label="Mapa">{MAP_SOURCE_LABEL[plan.mapSource]}</Field>

        {plan.mapPoolId !== null && (
          <Field label="Mundo da fila">{`#${String(plan.mapPoolId)}`}</Field>
        )}

        <Field label="Situação">{STATUS_LABEL[plan.status]}</Field>

        {/* `generatedFor` é o que faz mover ser MOVER: sem ele, um
            wipe adiado é indistinguível de um wipe que a regra
            sempre quis naquele dia. */}
        {plan.generatedFor !== null && plan.generatedFor !== plan.scheduledAt && (
          <Field label="A cadência previa">{formatShortMoment(plan.generatedFor)}</Field>
        )}

        {plan.absorbedBy !== null && (
          <Field label="Absorvido pelo">{`wipe #${String(plan.absorbedBy)}`}</Field>
        )}

        <Field label="Reconciliação">
          {plan.pinned ? 'congelado — foi mexido à mão' : 'livre — a regra pode recalcular'}
        </Field>

        {plan.note !== null && plan.note.trim() !== '' && (
          <Field label="Anotação">{plan.note}</Field>
        )}

        <Field label="Marcado em">{formatMoment(plan.createdAt)}</Field>

        {plan.updatedAt !== plan.createdAt && (
          <Field label="Mexido em">{formatMoment(plan.updatedAt)}</Field>
        )}
      </dl>

      <footer className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        {future && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onAction(plan, 'edit');
              }}
            >
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              Editar
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onAction(plan, 'move');
              }}
            >
              <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
              Mover
            </Button>

            {/* O forçado não se apaga: ele acontece com ou sem nós,
                e o core recusa a exclusão com 409. */}
            {plan.kind !== 'forced' && (
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  onAction(plan, 'remove');
                }}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                Deletar
              </Button>
            )}
          </>
        )}

        {plan.status === 'skipped' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              onRestore(plan);
            }}
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Restaurar
          </Button>
        )}

        {!future && plan.status !== 'skipped' && (
          <p className="text-2xs text-muted">
            Não há o que mudar: este wipe já saiu da frente do relógio do agente.
          </p>
        )}
      </footer>
    </article>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <>
      <dt className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}
