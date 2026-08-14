// ============================================================
//  layout.tsx  -  a raiz do painel.
//
//  Só os pesos de fonte usados são importados: cada peso é um
//  arquivo, e o painel é servido pelo próprio agente — não há CDN
//  para pagar a conta de um peso que ninguém usa.
//
//  O `metadata` é resolvido em TEMPO DE BUILD (o painel é export
//  estático), então ele não pode falar do servidor selecionado.
// ============================================================
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@fontsource/roboto-condensed/400.css';
import '@fontsource/roboto-condensed/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';

import { AppShell } from '@/components/app-shell';
import { SessionProvider } from '@/components/session';
import { ToastViewport } from '@/components/ui/toast';

import './globals.css';

export const metadata: Metadata = {
  title: 'RustAgent — Painel',
  description: 'Instalar, subir, atualizar e cuidar dos servidores de Rust desta máquina.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <SessionProvider>
          <AppShell>{children}</AppShell>
          {/* A pilha de avisos é do app inteiro: um toast disparado
              na tela do servidor precisa sobreviver à navegação. */}
          <ToastViewport />
        </SessionProvider>
      </body>
    </html>
  );
}
