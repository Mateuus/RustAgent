'use client';

// ============================================================
//  player-panel.tsx  -  o JOGADOR deste servidor, num lugar só.
//
//  Três perguntas sobre a mesma pessoa, e por isso uma aba só com
//  três divisões em vez de três sub-abas soltas em Configurações:
//
//      Loadouts   o que ele GANHA ao nascer (os itens)
//      Status     em que ESTADO ele acorda (vida, fome, sede)
//      Timers     quanto TEMPO as coisas levam para ele
//
//  As três respondem "o que muda para quem está neste grupo", e as
//  três usam a MESMA lista de grupos do Oxide. Espalhá-las pela
//  barra de cima faria procurar em três lugares o ajuste de um
//  jogador só.
//
//  ------------------------------------------------------------
//  ####  O TERCEIRO NÍVEL TEM DESENHO PRÓPRIO  ####
//
//  As abas de cima são barra sublinhada; as sub-abas de
//  Configurações, uma faixa segmentada. Se este nível copiasse
//  qualquer um dos dois, dois níveis iguais na tela fariam a pessoa
//  perder de vista onde está — então aqui são botões com borda.
//
//  ####  TIMERS DEIXOU DE SER MAQUETE  ####
//
//  Foi maquete até 11/09/2026, e dizia isso na cara. Agora grava e
//  chega ao jogo pelo `origemz.timers.sync` — ver timers-panel.tsx.
// ============================================================

import { useState } from 'react';

import { LoadoutPanel } from '@/components/loadout-panel';
import { SpawnStatusPanel } from '@/components/spawn-status-panel';
import { TimersPanel } from '@/components/timers-panel';
import { cn } from '@/lib/utils';

type Tab = 'loadouts' | 'status' | 'timers';

const TABS: readonly { key: Tab; label: string; hint: string }[] = [
  { key: 'loadouts', label: 'Loadouts', hint: 'o que ele ganha ao nascer' },
  { key: 'status', label: 'Status', hint: 'vida, fome e sede ao nascer' },
  { key: 'timers', label: 'Timers', hint: 'quão rápido as coisas andam para ele' },
];

export function PlayerPanel({ serverId }: { readonly serverId: string }) {
  const [tab, setTab] = useState<Tab>('loadouts');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            title={item.hint}
            className={cn(
              'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
              tab === item.key
                ? 'border-rust bg-surface-2 text-foreground'
                : 'border-border text-muted hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}

        <span className="text-2xs text-muted">{TABS.find((item) => item.key === tab)?.hint}</span>
      </div>

      {tab === 'loadouts' && <LoadoutPanel serverId={serverId} />}

      {tab === 'status' && <SpawnStatusPanel serverId={serverId} />}

      {tab === 'timers' && <TimersPanel serverId={serverId} />}
    </div>
  );
}
