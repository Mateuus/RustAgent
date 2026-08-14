'use client';

// ============================================================
//  A casca de modal do painel.
//
//  <dialog> nativo com showModal(), e não uma <div role="dialog">,
//  pelo mesmo motivo da gaveta de navegação (sidebar.tsx): Escape
//  fecha, o foco fica preso dentro, o resto da página vira inerte
//  e ao fechar o foco volta sozinho para o botão que abriu. Nada
//  disso precisa ser escrito à mão aqui.
//
//  ------------------------------------------------------------
//  ####  O CONTEÚDO SÓ EXISTE ENQUANTO A CAIXA ESTÁ ABERTA  ####
//
//  O <dialog> continua montado (o showModal() precisa de alguém a
//  quem mandar), mas os filhos são desmontados ao fechar. Isso não
//  é economia de render: é o que faz um formulário aberto pela
//  segunda vez nascer limpo. Uma concessão de VIP com a duração da
//  anterior ainda no campo é exatamente o tipo de resíduo que vira
//  um VIP de 30 dias para quem comprou 7.
//
//  ------------------------------------------------------------
//  `busy` TRAVA TODOS OS CAMINHOS DE FECHAMENTO
//
//  Inclusive o Escape e o clique no fundo — que o navegador trata
//  sozinho e que de outro modo desmontariam o formulário no meio
//  de uma requisição já enviada, deixando o admin sem o desfecho
//  de uma entrega que aconteceu.
// ============================================================

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DialogProps {
  readonly open: boolean;
  /** Vai no cabeçalho e é quem nomeia a caixa para o leitor de tela. */
  readonly title: string;
  readonly onClose: () => void;
  /** Uma requisição está em andamento: fechar fica bloqueado. */
  readonly busy?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Dialog({ open, title, onClose, busy = false, className, children }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // Cobre TODOS os caminhos de fechamento, inclusive o Escape,
      // que de outro modo deixaria o estado da tela dizendo
      // "aberta" com a caixa já fora do ar.
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClick={(event) => {
        // Clique no ::backdrop é despachado no próprio <dialog>;
        // clique no conteúdo tem o alvo lá dentro.
        if (event.target === dialogRef.current && !busy) onClose();
      }}
      className={cn(
        'm-auto w-[min(30rem,92vw)] border border-border bg-surface p-0 text-foreground',
        className,
      )}
    >
      {open && (
        <div className="flex flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
            <h2
              id={titleId}
              className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide"
            >
              <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
              {title}
            </h2>
            <Button variant="ghost" size="sm" aria-label="Fechar" disabled={busy} onClick={onClose}>
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </header>

          <div className="p-3">{children}</div>
        </div>
      )}
    </dialog>
  );
}
