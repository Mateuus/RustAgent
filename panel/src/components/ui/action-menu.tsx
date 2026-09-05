'use client';

// ============================================================
//  action-menu.tsx  -  as ações de uma linha, atrás de um botão.
//
//  ####  POR QUE ESCONDER O QUE DÁ PARA FAZER  ####
//
//  Uma lista com três botões por linha e catorze linhas mostra
//  quarenta e dois botões de uma vez. O olho para de ler a linha e
//  passa a varrer a coluna da direita — e a informação que decide
//  (a data, os blueprints, a anotação) perde para o que é clicável.
//
//  Atrás de um botão só, a linha volta a ser texto. O custo é um
//  clique a mais em cada ação, e ele se paga: as ações daqui mudam
//  a agenda de um servidor inteiro, e nenhuma delas é frequente o
//  bastante para merecer estar sempre à mão.
//
//  ####  FECHAR É PARTE DO CONTRATO  ####
//
//  Um menu que fica aberto depois do clique fora vira lixo na tela
//  e rouba o clique seguinte. Ele fecha no Escape, no clique fora e
//  ao escolher um item — e devolve o foco para o botão que o abriu,
//  senão quem navega por teclado é jogado para o começo da página.
// ============================================================

import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface ActionMenuItem {
  readonly label: string;
  readonly icon: ReactNode;
  /** A frase que explica o que acontece. Vai no `title` do item. */
  readonly hint?: string;
  /** Destaca em vermelho o que tira algo da frente. */
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

export function ActionMenu({
  label,
  items,
  disabled = false,
  text,
}: {
  /** Para o leitor de tela: de QUAL linha são estas ações. */
  readonly label: string;
  readonly items: readonly ActionMenuItem[];
  readonly disabled?: boolean;
  /**
   * O rótulo VISÍVEL do botão, quando ele precisa de um.
   *
   * ####  DUAS FORMAS, E O QUE DECIDE É A VIZINHANÇA  ####
   *
   * Numa TABELA, os três pontos bastam: a coluna de ações é uma
   * convenção, e o rótulo repetido em catorze linhas vira ruído.
   * Numa BARRA DE AÇÕES — a que abre sob o jogador selecionado —
   * não há coluna nem convenção: o menu é o único caminho para
   * expulsar e banir, e um ícone mudo ao lado de um botão escrito
   * "Copiar" some.
   */
  readonly text?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // ####  O MENU NASCE DENTRO DE UMA CAIXA QUE ROLA  ####
  //
  // A lista de jogadores e a tabela da agenda têm `overflow-y`
  // próprio. Aberto na última linha visível, o menu é CORTADO pela
  // borda de baixo — e some justamente a ação mais perigosa, que é
  // a última da lista.
  //
  // `block: 'nearest'` rola o mínimo para ele caber, e não faz nada
  // quando já cabe. O menu é posicionado dentro do scroller, então
  // ele conta para a área rolável e a caixa alcança.
  useEffect(() => {
    if (open) {
      menuRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={cn(
          'flex items-center justify-center border border-border text-muted transition',
          'hover:border-foreground hover:text-foreground',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
          open && 'border-foreground text-foreground',
          disabled && 'cursor-not-allowed opacity-50',
          text === undefined
            ? 'h-7 w-7'
            : 'h-7 gap-1.5 px-3 font-condensed text-2xs font-bold uppercase tracking-wide',
        )}
      >
        {text === undefined ? (
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        ) : (
          <>
            {text}
            <ChevronDown aria-hidden className="h-3.5 w-3.5" />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          // À direita e por cima: a coluna de ações fica na borda da
          // tela, e um menu que abre para fora dela some.
          className="absolute right-0 z-20 mt-1 min-w-44 border border-border bg-surface py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              title={item.hint}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition',
                'hover:bg-border focus-visible:bg-border focus-visible:outline-none',
                item.danger === true ? 'text-rust' : 'text-foreground',
              )}
            >
              <span aria-hidden className="flex h-3.5 w-3.5 items-center justify-center">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
