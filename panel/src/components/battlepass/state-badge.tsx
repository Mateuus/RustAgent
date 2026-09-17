'use client';

// ============================================================
//  state-badge.tsx  -  em que pé está a temporada.
//
//  Três abas mostram esta etiqueta (Visão geral, Temporadas e
//  Configuração), e é ela que responde a pergunta mais importante
//  antes de qualquer edição: o que estou mexendo está NO AR?
//
//  A cor entra na BORDA, nunca no texto: `--rust-red` dá 3,74:1 e
//  não passa em contraste (globals.css:98). O `title` traz o que o
//  jogador vê naquele estado, que é a parte que ninguém decora.
// ============================================================

import {
  SEASON_STATE_HINTS,
  SEASON_STATE_LABELS,
  SEASON_STATE_TONES,
} from '@/components/battlepass/normalize';
import type { BattlePassSeasonState } from '@/lib/api';
import { cn } from '@/lib/utils';

export function StateBadge({ state }: { readonly state: BattlePassSeasonState | null }) {
  if (state === null) {
    // O agente mandou um estado que este painel não conhece. Dizer
    // isso é melhor que escolher um dos quatro e mentir.
    return (
      <span className="border border-border px-2 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        estado desconhecido
      </span>
    );
  }

  return (
    <span
      title={SEASON_STATE_HINTS[state]}
      className={cn(
        'border px-2 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide',
        SEASON_STATE_TONES[state],
      )}
    >
      {SEASON_STATE_LABELS[state]}
    </span>
  );
}
