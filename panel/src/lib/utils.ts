import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Junta classes do Tailwind resolvendo conflito pela última
 * (`cn('p-2', cond && 'p-4')` vira `p-4`). É o utilitário padrão
 * do shadcn/ui; os componentes de src/components/ui contam com
 * ele para aceitar `className` de fora sem duplicar utilitário.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
