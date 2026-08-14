'use client';

// ============================================================
//  app-shell.tsx  -  a casca: navegação + área de conteúdo.
//
//  A tela de login NÃO usa a casca (ela não tem para onde
//  navegar), e é por isso que o shell decide isso aqui dentro em
//  vez de existir um segundo layout.
//
//  ####  A ÁREA DE CONTEÚDO PRECISA DE min-w-0  ####
//
//  Não é enfeite: sem ele, uma tabela larga ou uma linha de log
//  comprida empurram a coluna inteira e a barra lateral sai da
//  tela.
// ============================================================

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { MobileNav, Sidebar } from '@/components/sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (pathname.startsWith('/entrar')) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
