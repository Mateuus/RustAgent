// ============================================================
//  Os estados que todo bloco do painel precisa ter.
//
//  Carregando / vazio / erro estão aqui juntos porque o risco é
//  esquecer um deles: painel que mostra tela branca quando a API
//  cai é pior que painel que diz "sem conexão".
//
//  Nenhum deles depende de cor para ser entendido — cada um tem
//  ícone E texto, e a cor só reforça.
//
//  ------------------------------------------------------------
//  ####  E `offline` NÃO É `error`  ####
//
//  Um servidor de Rust fora do ar é o estado NORMAL de uma máquina
//  em que ninguém subiu o servidor ainda — e aparecia em vermelho,
//  com triângulo de alerta e `role=alert`, como se o agente
//  tivesse falhado. Ele não falhou: está de pé, respondendo, e
//  dizendo que do outro lado não há ninguém.
//
//  Vermelho em estado normal tem preço: quem vê alerta o tempo
//  todo para de ler alerta, e o dia em que houver um de verdade
//  ele vai parecer igual aos outros.
// ============================================================
import { AlertTriangle, Inbox, Loader2, PowerOff } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface StateBlockProps {
  readonly variant: 'loading' | 'empty' | 'error' | 'offline';
  readonly title: string;
  /** Segunda linha: a causa, o código do erro, o que fazer. */
  readonly detail?: ReactNode;
  readonly className?: string;
}

export function StateBlock({ variant, title, detail, className }: StateBlockProps) {
  const isError = variant === 'error';

  return (
    <div
      // `role=alert` só no erro: o leitor de tela interrompe a
      // leitura para anunciar, e fazer isso a cada spinner de
      // polling seria insuportável.
      role={isError ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2 border px-3 py-3 text-sm',
        isError ? 'border-rust bg-surface-2' : 'border-border bg-surface-2',
        className,
      )}
    >
      <StateIcon variant={variant} />
      <div className="min-w-0">
        {/* Texto em --text, nunca em --rust-red: o vermelho do
            chrome dá 3.7:1 sobre o fundo, o que serve para
            ícone e borda mas não para texto. */}
        <p className={cn('font-medium', isError ? 'text-foreground' : 'text-muted')}>{title}</p>
        {detail !== undefined && <div className="mt-1 text-xs text-muted">{detail}</div>}
      </div>
    </div>
  );
}

function StateIcon({ variant }: { readonly variant: StateBlockProps['variant'] }) {
  const className = 'mt-0.5 h-4 w-4 shrink-0';

  if (variant === 'loading') {
    return <Loader2 aria-hidden="true" className={cn(className, 'animate-spin text-amber')} />;
  }
  if (variant === 'error') {
    return <AlertTriangle aria-hidden="true" className={cn(className, 'text-rust')} />;
  }
  // Desligado, e não quebrado: o mesmo cinza do vazio. É a
  // diferença entre "não há ninguém do outro lado" e "algo deu
  // errado aqui dentro".
  if (variant === 'offline') {
    return <PowerOff aria-hidden="true" className={cn(className, 'text-muted')} />;
  }
  return <Inbox aria-hidden="true" className={cn(className, 'text-muted')} />;
}
