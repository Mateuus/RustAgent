'use client';

// ============================================================
//  purge-wipe-dialog.tsx  -  apagar a linha, e não só o wipe.
//
//  ####  DELETAR DUAS VEZES NÃO É REDUNDÂNCIA  ####
//
//  O primeiro "deletar" tira o wipe da agenda e GUARDA a linha, com
//  a data ocupada, para a cadência não marcar outro ali. É o que a
//  maioria quer, e é por isso que ele é o padrão.
//
//  Este aqui apaga a linha. A data fica livre de novo — o que com a
//  cadência DESLIGADA é exatamente o certo (nada recria nada, e a
//  linha guardada seria lixo permanente na agenda), e com ela
//  LIGADA significa que a reconciliação vai marcar um wipe novo
//  naquele dia na volta seguinte.
//
//  A caixa não escolhe por ninguém: ela diz qual dos dois casos é o
//  desta tela, agora, e deixa apertar.
// ============================================================

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { formatShortMoment } from '@/components/wipe/labels';
import type { WipePlan } from '@/lib/api';

export function PurgeWipeDialog({
  plan,
  open,
  busy,
  cadenceEnabled,
  onConfirm,
  onClose,
}: {
  readonly plan: WipePlan;
  readonly open: boolean;
  readonly busy: boolean;
  /** Com ela ligada, a data apagada volta a ser marcada sozinha. */
  readonly cadenceEnabled: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={open} title="Apagar de vez" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Apagar a linha do wipe de{' '}
          <strong className="text-foreground">{formatShortMoment(plan.scheduledAt)}</strong>. Ela
          some do banco, e não dá para restaurar depois.
        </p>

        {cadenceEnabled ? (
          <StateBlock
            variant="error"
            title="A cadência vai marcar um wipe novo nesse dia."
            detail="A linha guardada é o que segura a data ocupada. Apagando, ela fica livre e a próxima reconciliação marca outro wipe ali — parecendo que este voltou. Se a intenção é não ter wipe nesse dia, deixe-o deletado, ou passe a agenda para o modo manual."
          />
        ) : (
          <StateBlock
            variant="empty"
            title="A agenda está no modo manual."
            detail="Nada recria wipes sozinho aqui, então a data simplesmente fica livre — e a linha, que não serviria para mais nada, some de vez."
          />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            Apagar de vez
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
