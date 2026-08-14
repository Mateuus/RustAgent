import type { LabelHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * Rótulo de campo: condensado, caixa alta, cinza.
 *
 * É sempre um <label htmlFor> de verdade, nunca um <span>
 * decorativo — é o que dá nome acessível ao campo e o que faz o
 * clique no texto levar o foco para ele.
 */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        'block font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        className,
      )}
      {...props}
    />
  );
}
