'use client';

// ============================================================
//  Botão que só age no SEGUNDO clique.
//
//  ####  POR QUE NÃO É UM DIÁLOGO MODAL  ####
//
//  Nasceu na tela de Operações, onde três botões derrubam coisa
//  (parar, reiniciar, atualizar). A mão já está no botão, e um
//  modal a mais no caminho vira reflexo de clicar em "sim" — a
//  confirmação que ninguém lê não confirma nada. O primeiro clique
//  troca o rótulo e escreve o que se perde; o segundo executa.
//
//  Isto NÃO substitui a `<dialog>` de confirmação (ver
//  vip-remove-dialog.tsx): aquela existe onde a decisão precisa
//  REPETIR dados — qual jogador, qual nível, qual vencimento — e
//  aqui não há dado a repetir, há consequência a avisar.
//
//  Mora em ui/ porque duas telas dependem dele: Operações, e a
//  atualização do próprio agente em Configurações. Duplicá-lo faria
//  as duas divergirem no primeiro ajuste de prazo.
// ============================================================

import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

export interface ConfirmButtonProps {
  readonly variant: 'danger' | 'primary';
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly confirmLabel: string;
  /** O que acontece de verdade. Aparece com o botão armado. */
  readonly hint: string;
  readonly onConfirm: () => void;
}

export function ConfirmButton({
  variant,
  disabled,
  icon,
  label,
  confirmLabel,
  hint,
  onConfirm,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      setArmed(false);
    }, 5_000);
    return () => {
      clearTimeout(timer);
    };
  }, [armed]);

  // Desabilitar um botão armado deixaria a confirmação pendurada
  // para a próxima vez que ele voltasse a valer.
  useEffect(() => {
    if (disabled) setArmed(false);
  }, [disabled]);

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={armed ? 'danger' : variant}
        disabled={disabled}
        onClick={() => {
          if (armed) {
            setArmed(false);
            onConfirm();
            return;
          }
          setArmed(true);
        }}
      >
        {icon}
        {armed ? confirmLabel : label}
      </Button>
      {armed && <span className="max-w-64 text-2xs text-amber">{hint}</span>}
    </span>
  );
}
