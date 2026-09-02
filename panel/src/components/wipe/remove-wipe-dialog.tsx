'use client';

// ============================================================
//  remove-wipe-dialog.tsx  -  tirar um wipe da agenda.
//
//  ####  A MESMA CHAMADA, DUAS COISAS DIFERENTES  ####
//
//  O `DELETE` do core SOME com o que foi marcado à mão e apenas
//  MARCA como pulado o que a cadência gerou — porque a regra o
//  recriaria na reconciliação seguinte, e um wipe que volta sozinho
//  depois de "apagado" é pior que um riscado na lista.
//
//  Quem confirma precisa saber em qual dos dois casos está, e é o
//  que esta caixa diz antes de qualquer coisa acontecer.
//
//  ####  POR QUE CAIXA, E NÃO BOTÃO ARMADO  ####
//
//  A primeira versão usava um botão de dois toques. Ele funcionava,
//  mas pintava a linha inteira de vermelho enquanto existisse — com
//  catorze wipes na agenda, a lista virava uma parede de alertas e o
//  que dava para LER (a data, os blueprints) desaparecia atrás do
//  que dava para APERTAR.
//
//  Uma caixa aparece só quando é chamada, cabe a frase inteira do
//  que vai acontecer, e deixa a lista em paz.
// ============================================================

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { formatShortMoment } from '@/components/wipe/labels';
import type { WipePlan } from '@/lib/api';

export function RemoveWipeDialog({
  plan,
  open,
  busy,
  onConfirm,
  onClose,
}: {
  readonly plan: WipePlan;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const manual = plan.kind === 'manual';

  return (
    <Dialog
      open={open}
      title="Deletar este wipe"
      busy={busy}
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Tirar da agenda o wipe de{' '}
          <strong className="text-foreground">{formatShortMoment(plan.scheduledAt)}</strong>.
        </p>

        <StateBlock
          variant="empty"
          title="Ele sai da agenda."
          detail={
            manual
              ? 'Foi marcado à mão, então nada o recria. Para tê-lo de volta é preciso marcar outro.'
              : 'A cadência recriaria a data se ela ficasse livre, então o agente a guarda ocupada nos ' +
                'bastidores. Dá para trazer o wipe de volta em "mostrar os deletados", no fim da lista.'
          }
        />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            Deletar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
