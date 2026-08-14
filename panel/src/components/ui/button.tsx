// ============================================================
//  Botão. Convenção shadcn/ui (cva + cn), estética do Rust.
//
//  Cor de texto por variante NÃO é escolha estética — é o que
//  faz cada uma passar em contraste sobre o próprio fundo:
//
//    amber  + #0F0F0F  ->  9.97:1
//    olive  + #0F0F0F  ->  4.87:1
//    rust   + #FFFFFF  ->  5.13:1   (com --text daria 4.1:1,
//                                    abaixo do mínimo de 4.5)
// ============================================================
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'border font-condensed font-bold uppercase tracking-wide',
    'transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-50',
  ),
  {
    variants: {
      variant: {
        /** Ação principal da tela (entregar item). */
        primary: 'border-amber bg-amber text-background hover:border-foreground',
        /** Confirmação. */
        confirm: 'border-olive bg-olive text-background hover:border-foreground',
        /** Destrutivo. */
        danger: 'border-rust bg-rust text-white hover:border-foreground',
        /** Neutro, para ações secundárias e alternâncias. */
        outline: 'border-border bg-surface-2 text-foreground hover:border-muted',
        /** Sem moldura — cabeçalho de tabela, por exemplo. */
        ghost: 'border-transparent bg-transparent text-foreground hover:bg-surface-2',
      },
      size: {
        sm: 'h-7 px-2 text-2xs',
        md: 'h-9 px-3 text-sm',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'md',
    },
  },
);

/**
 * `ComponentPropsWithRef` e não `ButtonHTMLAttributes`: o menu de
 * ações precisa medir o botão para posicionar a lista, e para isso
 * precisa da `ref`.
 *
 * Sem forwardRef porque no React 19 `ref` é uma prop comum de
 * componente de função — ela cai no `...props` e chega ao <button>
 * junto com o resto. O forwardRef existiria só para satisfazer uma
 * regra que a versão anterior tinha.
 */
export type ButtonProps = ComponentPropsWithRef<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    // `type` padrão "button": dentro de um <form>, o padrão do
    // HTML é "submit", e um botão auxiliar acabaria enviando a
    // entrega de item sem querer.
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
