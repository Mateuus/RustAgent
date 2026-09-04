'use client';

// ============================================================
//  mode-dialog.tsx  -  trocar de automático para manual.
//
//  ####  A TROCA APAGA UM CALENDÁRIO INTEIRO  ####
//
//  Desligar a cadência não é só parar de gerar wipes novos: a
//  reconciliação seguinte varre os que ela já tinha gerado e não
//  foram fixados à mão. Meses de agenda somem de uma vez, sem
//  aviso, por causa de um clique num botão que diz "Manual".
//
//  Só que perder a agenda é às vezes exatamente o que se quer —
//  quem troca para manual costuma estar recomeçando o calendário.
//  Como as duas intenções são legítimas e nenhuma é óbvia, a caixa
//  pergunta em vez de escolher.
//
//  ####  HERDAR É COPIAR, E CÓPIA PODE FALHAR NO MEIO  ####
//
//  Não existe "converter em manual" no agente: herdar é criar um
//  wipe manual para cada data que a cadência tinha marcado, um
//  POST de cada vez. Por isso a caixa diz QUANTOS são antes, e quem
//  faz a cópia relata quantos entraram de verdade — um número que
//  não bate é a única forma de saber que algo ficou pelo caminho.
// ============================================================

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { WipePlan } from '@/lib/api';

export function ModeDialog({
  open,
  busy,
  cadencePlans,
  onKeep,
  onDiscard,
  onClose,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  /** Os wipes que a cadência gerou e que somem se ninguém os copiar. */
  readonly cadencePlans: readonly WipePlan[];
  readonly onKeep: () => void;
  readonly onDiscard: () => void;
  readonly onClose: () => void;
}) {
  const quantos = cadencePlans.length;

  return (
    <Dialog open={open} title="Passar para o modo manual" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          No modo manual o agente para de marcar wipes sozinho. O forçado da Facepunch continua
          aparecendo na agenda — ele acontece com ou sem o painel.
        </p>

        {quantos === 0 ? (
          <StateBlock
            variant="empty"
            title="Não há wipes de cadência para herdar."
            detail="A agenda já só tem o forçado e o que foi marcado à mão, e nada disso se perde na troca."
          />
        ) : (
          <StateBlock
            variant="empty"
            title={`${String(quantos)} wipe(s) da cadência estão marcados.`}
            detail="Herdando, cada um vira um wipe seu, na mesma data e com a mesma política — e você continua editando um a um. Limpando, eles somem na próxima reconciliação."
          />
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant="danger" disabled={busy} onClick={onDiscard}>
            Limpar a agenda
          </Button>

          <Button variant="confirm" disabled={busy} onClick={onKeep}>
            {quantos === 0 ? 'Passar para manual' : `Herdar os ${String(quantos)}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
