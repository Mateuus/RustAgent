import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SectionProps {
  /** Vai em caixa alta, condensado. */
  readonly title: string;
  /** Canto direito do cabeçalho: frescor, contagem, atalho. */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}

/**
 * Bloco emoldurado com título.
 *
 * A barra vertical em --rust-red antes do título é o elemento
 * de acento do design system: é ela que marca o começo de um
 * bloco, no lugar de sombra ou canto arredondado.
 */
export function Section({ title, aside, children, className, contentClassName }: SectionProps) {
  return (
    <section className={cn('border border-border bg-surface', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          {title}
        </h2>
        {aside}
      </header>
      <div className={cn('p-3', contentClassName)}>{children}</div>
    </section>
  );
}
