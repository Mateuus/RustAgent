'use client';

// ============================================================
//  app-shell.tsx  -  a moldura: barra lateral e cabeçalho.
//
//  A tela de login NÃO usa a moldura (ela não tem para onde
//  navegar), e é por isso que o shell decide isso aqui dentro em
//  vez de existir um segundo layout.
// ============================================================

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useSession } from '@/components/session';

// A visão geral JÁ É a lista de servidores — uma tela só, e não
// duas com o mesmo conteúdo. Ver Docs\07-PAINEL.md.
const NAV = [
  { href: '/', label: 'Servidores' },
  { href: '/config/', label: 'Agente' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useSession();

  if (pathname.startsWith('/entrar')) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <p className="font-condensed text-lg font-bold uppercase tracking-wide text-foreground">
            Rust<span className="text-rust">Agent</span>
          </p>
          <p className="text-2xs uppercase tracking-wider text-muted">painel do operador</p>
        </div>

        <nav className="flex flex-col p-2">
          {NAV.map((item) => {
            // `/` casaria com tudo se fosse `startsWith`.
            const active =
              item.href === '/' ? pathname === '/' : pathname.startsWith(item.href.slice(0, -1));

            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  'px-3 py-2 text-sm ' +
                  (active
                    ? 'border-l-2 border-rust bg-surface-2 text-foreground'
                    : 'border-l-2 border-transparent text-muted hover:bg-surface-2 hover:text-foreground')
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <span className="text-sm text-muted">{user === null ? '' : `Conectado como ${user}`}</span>

          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-muted hover:text-foreground"
          >
            Sair
          </button>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
