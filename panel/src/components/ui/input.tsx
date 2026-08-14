import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * Campo de texto. Cantos retos, borda de 1px, fundo mais claro
 * que a superfície do bloco para o campo se distinguir da
 * moldura em volta.
 */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground',
        'placeholder:text-muted',
        'hover:border-muted',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
