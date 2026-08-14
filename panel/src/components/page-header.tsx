import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** Vira o <h1> da página. Um por rota. */
  readonly title: string;
  readonly description?: string;
  /** Canto direito: contagem, frescor, ação da tela. */
  readonly aside?: ReactNode;
}

/**
 * Cabeçalho das telas internas.
 *
 * Mesmo desenho do <HeaderBar/> do dashboard (borda embaixo,
 * superfície mais clara, barra de acento antes do título) — a
 * diferença é que ali o título é a identidade do servidor, e aqui
 * é o nome da tela.
 */
export function PageHeader({ title, description, aside }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="h-8 w-1 shrink-0 bg-rust" />
        <div className="min-w-0">
          <h1 className="truncate font-condensed text-xl font-bold uppercase tracking-wide text-foreground">
            {title}
          </h1>
          {description !== undefined && (
            <p className="truncate text-xs text-muted">{description}</p>
          )}
        </div>
      </div>

      {aside}
    </header>
  );
}
