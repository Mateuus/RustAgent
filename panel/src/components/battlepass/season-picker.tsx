'use client';

// ============================================================
//  season-picker.tsx  -  qual MÊS está sendo montado.
//
//  Três abas (Trilha, XP e Configuração) editam uma temporada, e as
//  três precisam da mesma pergunta no topo — inclusive com a mesma
//  resposta quando não há nenhuma criada ainda.
//
//  O estado vem junto com o nome porque a diferença entre mexer num
//  RASCUNHO e mexer no mês que está NO AR é a coisa mais importante
//  desta tela: editar a trilha de um mês no ar muda o que os
//  jogadores estão vendo agora.
// ============================================================

import { SEASON_STATE_LABELS, periodLabel } from '@/components/battlepass/normalize';
import { StateBlock } from '@/components/state-block';
import type { BattlePassSeason } from '@/lib/api';

export function SeasonPicker({
  seasons,
  value,
  busy = false,
  onChange,
}: {
  readonly seasons: readonly BattlePassSeason[];
  readonly value: number | null;
  readonly busy?: boolean;
  readonly onChange: (seasonId: number) => void;
}) {
  if (seasons.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="Nenhuma temporada criada ainda."
        detail="Crie o mês na aba Temporadas. Enquanto não houver uma, não há trilha, regra de XP nem configuração para editar."
      />
    );
  }

  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Temporada</span>

      <select
        disabled={busy}
        value={value === null ? '' : String(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-9 border border-border bg-surface-2 px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {value === null && <option value="">Escolha o mês…</option>}

        {seasons.map((season) => (
          <option key={season.id} value={String(season.id)}>
            {periodLabel(season.period)} · {season.label} ·{' '}
            {season.state === null ? 'estado desconhecido' : SEASON_STATE_LABELS[season.state]}
          </option>
        ))}
      </select>
    </label>
  );
}
