'use client';

// ============================================================
//  Notificações transitórias — a parte visível.
//
//  A fila mora em lib/toast.ts; aqui é só o desenho e o relógio.
//
//  ------------------------------------------------------------
//  TRÊS DECISÕES QUE NÃO SÃO ESTÉTICAS
//
//  1. ÍCONE + PALAVRA, nunca só a cor. Cada variante estampa
//     "SUCESSO", "ERRO", "AVISO" ou "INFO" ao lado de um ícone
//     de forma diferente. Quem não distingue oliva de vermelho
//     (e são as duas cores mais próximas da paleta sob
//     deuteranopia) lê a palavra.
//
//  2. O RELÓGIO PAUSA no hover E no foco. Um aviso que some no
//     meio da leitura é pior que nenhum aviso — e quem navega por
//     teclado nunca passa o mouse por cima, então parar só no
//     hover deixaria essa pessoa de fora.
//
//  3. O <ol> FICA SEMPRE MONTADO, mesmo vazio. Região viva que
//     nasce junto com o conteúdo não é anunciada de forma
//     confiável: o leitor de tela precisa já estar observando o
//     container quando o item entra. (Mesma armadilha comentada
//     no item-combobox.)
// ============================================================

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useToasts } from '@/lib/hooks/use-toasts';
import { dismissToast, type ToastMessage, type ToastVariant } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Appearance {
  /** A palavra que substitui a cor para quem não a distingue. */
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly iconClassName: string;
  /** Barra vertical de acento à esquerda, na cor da variante. */
  readonly accentClassName: string;
}

const APPEARANCE: Readonly<Record<ToastVariant, Appearance>> = {
  success: {
    label: 'Sucesso',
    Icon: CheckCircle2,
    iconClassName: 'text-olive',
    accentClassName: 'border-l-olive',
  },
  error: {
    label: 'Erro',
    Icon: XCircle,
    iconClassName: 'text-rust',
    accentClassName: 'border-l-rust',
  },
  warning: {
    label: 'Aviso',
    Icon: AlertTriangle,
    iconClassName: 'text-amber',
    accentClassName: 'border-l-amber',
  },
  info: {
    // Neutro: o acento acompanha a borda comum, e a distinção
    // fica por conta do ícone e da palavra.
    label: 'Info',
    Icon: Info,
    iconClassName: 'text-muted',
    accentClassName: 'border-l-muted',
  },
};

export function ToastViewport() {
  const toasts = useToasts();

  return (
    <ol
      aria-label="Notificações"
      className={cn(
        'fixed bottom-0 right-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4',
        // O container cobre um pedaço do canto inferior direito.
        // Sem `pointer-events-none` ele engoliria o clique em
        // qualquer coisa embaixo, mesmo sem nenhum toast na tela.
        'pointer-events-none',
      )}
    >
      {toasts.map((entry) => (
        <ToastItem key={entry.id} toast={entry} />
      ))}
    </ol>
  );
}

function ToastItem({ toast: entry }: { readonly toast: ToastMessage }) {
  const { label, Icon, iconClassName, accentClassName } = APPEARANCE[entry.variant];
  const isError = entry.variant === 'error';

  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const isPaused = isHovered || isFocused;

  // O que FALTA correr, não o total: ao pausar, o efeito devolve
  // ao ref o tempo que sobrou, e ao retomar ele agenda só esse
  // resto. Reiniciar do zero a cada hover daria um toast
  // praticamente eterno.
  const remainingRef = useRef<number | null>(entry.duration);
  const startedAtRef = useRef(0);

  useEffect(() => {
    const remaining = remainingRef.current;
    // `null` = fica até fecharem (ver o RCON_TIMEOUT em give-panel).
    if (remaining === null || isPaused) return;

    startedAtRef.current = Date.now();
    const timer = setTimeout(() => {
      dismissToast(entry.id);
    }, remaining);

    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remaining - (Date.now() - startedAtRef.current));
    };
  }, [isPaused, entry.id]);

  return (
    <li
      // Erro INTERROMPE a leitura (assertive); o resto espera a
      // vez (polite). Um "entregue" que corta a frase no meio a
      // cada clique tornaria o leitor de tela inutilizável nesta
      // tela, que é toda feita de ações repetidas.
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      // A mensagem só faz sentido inteira: sem `atomic`, o leitor
      // anunciaria apenas o pedaço que mudou.
      aria-atomic="true"
      onMouseEnter={() => {
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        setIsHovered(false);
      }}
      // onFocus/onBlur do React são focusin/focusout: sobem da
      // árvore, então focar o botão de fechar já pausa o relógio.
      onFocus={() => {
        setIsFocused(true);
      }}
      onBlur={() => {
        setIsFocused(false);
      }}
      className={cn(
        'pointer-events-auto flex items-start gap-2 px-3 py-2',
        'border-y border-r border-border border-l-[3px] bg-surface-2',
        'animate-toast-in motion-reduce:animate-none',
        accentClassName,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0', iconClassName)} />

      <div className="min-w-0 flex-1">
        <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          {label}
        </p>
        <p className="text-sm text-foreground">{entry.message}</p>
        {entry.description !== null && (
          <p className="mt-0.5 text-2xs text-muted">{entry.description}</p>
        )}
      </div>

      <button
        type="button"
        aria-label="Fechar notificação"
        onClick={() => {
          dismissToast(entry.id);
        }}
        className="-mr-1 shrink-0 p-1 text-muted hover:text-foreground"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
