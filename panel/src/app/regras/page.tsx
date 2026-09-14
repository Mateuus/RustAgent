'use client';

// ============================================================
//  /regras  -  a aba REGRAS do menu do jogo.
//
//  A tela que o jogador abre em `/menu` → REGRAS (ou digitando
//  `/regras`) é montada do que se escreve aqui: seções à esquerda,
//  regras dentro, e a quebra de página feita pelo jogo conforme o
//  que cabe na caixa.
//
//  ####  UMA PÁGINA, E NÃO UMA ABA DENTRO DE OUTRA  ####
//
//  As regras não pertencem a um servidor nem a um assunto do
//  painel: elas são da REDE, com exceção por servidor. Pendurá-las
//  na página de um servidor faria parecer que cada um tem as suas
//  — que é o contrário do padrão.
//
//  Ver core/src/game/ui-rules-screen.ts para a tela do jogo.
// ============================================================

import { Scale } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { RulesPanel } from '@/components/rules/rules-panel';
import { RequireSession } from '@/components/session';

export default function RulesPage() {
  return (
    <RequireSession>
      <div className="flex min-h-full flex-col">
        <PageHeader
          title="Regras"
          description="O que o jogador lê na aba REGRAS do menu, e em /regras."
          aside={<Scale aria-hidden="true" className="h-5 w-5 text-muted" />}
        />

        <div className="flex-1 p-4">
          <RulesPanel />
        </div>
      </div>
    </RequireSession>
  );
}
