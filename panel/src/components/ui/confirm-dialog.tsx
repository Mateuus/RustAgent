'use client';

// ============================================================
//  confirm-dialog.tsx  -  "tem certeza?", quando a pergunta
//  precisa REPETIR sobre quem ela é.
//
//  ####  ELE NÃO SUBSTITUI O ConfirmButton  ####
//
//  O botão de dois toques (ui/confirm-button.tsx) serve onde a mão
//  já está no botão e não há dado a repetir: parar um servidor,
//  atualizar o agente. A tela inteira é sobre aquela coisa, então
//  "reiniciar mesmo" basta.
//
//  Aqui é o contrário. A ação nasce DENTRO de um menu, e o menu
//  fecha ao ser escolhido — some a linha, some o nome, some o
//  contexto. Quem clicou em "Expulsar" no menu de um jogador
//  precisa ver o NOME de quem vai cair antes de confirmar,
//  principalmente numa lista que se reordena sozinha a cada cinco
//  segundos: o jogador que estava sob o cursor pode não ser mais o
//  mesmo.
//
//  ####  O BOTÃO DE CONFIRMAR NÃO DIZ "OK"  ####
//
//  Ele repete o VERBO — "Expulsar" —, porque é a última coisa que
//  se lê antes de agir. "Sim" e "OK" obrigam a subir os olhos de
//  volta para lembrar do que se trata, e é assim que se confirma o
//  que não se queria.
// ============================================================

import type { ReactNode } from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  variant = 'danger',
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  /** O verbo do botão. Ver o cabeçalho: nunca "OK". */
  readonly confirmLabel: string;
  readonly variant?: NonNullable<ButtonProps['variant']>;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  /** Quem é, e o que acontece com ele. */
  readonly children: ReactNode;
}) {
  return (
    <Dialog open={open} title={title} busy={busy} onClose={onClose}>
      <div className="space-y-4">
        {children}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant={variant} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
