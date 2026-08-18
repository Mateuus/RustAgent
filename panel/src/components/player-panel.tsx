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
//  ####  TIMERS AINDA É MAQUETE  ####
//
//  E ela diz isso na cara: o desenho está de pé para acertar a
//  forma, mas nada ali grava nem chega ao jogo. Uma tela que PARECE
//  funcionar e não funciona é pior que tela nenhuma — alguém
//  configura, sai, e passa a semana achando que a fornalha está
//  mais rápida.
// ============================================================

import { useState } from 'react';

import { LoadoutPanel } from '@/components/loadout-panel';
import { SpawnStatusPanel } from '@/components/spawn-status-panel';
import { StateBlock } from '@/components/state-block';
import { cn } from '@/lib/utils';

type Tab = 'loadouts' | 'status' | 'timers';

const TABS: readonly { key: Tab; label: string; hint: string }[] = [
  { key: 'loadouts', label: 'Loadouts', hint: 'o que ele ganha ao nascer' },
  { key: 'status', label: 'Status', hint: 'vida, fome e sede ao nascer' },
  { key: 'timers', label: 'Timers', hint: 'quanto tempo as coisas levam' },
];

/**
 * Os tempos que a maquete mostra.
 *
 * Valores de exemplo, com nomes que existem no jogo — é o que
 * permite discutir a forma da tela antes de escrever o que a faz
 * funcionar.
 */
const TIMER_MOCK: readonly { name: string; detail: string; value: string }[] = [
  {
    name: 'Fornalha',
    detail: 'Quanto tempo para fundir um lote de minério.',
    value: '×1 (padrão)',
  },
  {
    name: 'Craft',
    detail: 'O tempo de fabricação de qualquer item na bancada.',
    value: '×1 (padrão)',
  },
  {
    name: 'Pesquisa',
    detail: 'A espera da mesa de pesquisa e do workbench.',
    value: '×1 (padrão)',
  },
  {
    name: 'Reciclador',
    detail: 'O intervalo entre um ciclo e o seguinte.',
    value: '×1 (padrão)',
  },
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

      {tab === 'timers' && (
        <div className="space-y-4">
          <StateBlock
            variant="empty"
            title="Maquete — nada aqui vale no jogo ainda"
            detail="O desenho está de pé para acertar a forma da tela. Nenhum destes campos grava, e nenhum deles chega ao servidor."
          />

          <div className="border border-border bg-surface">
            <div className="border-b border-border px-3 py-2">
              <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                Tempos por grupo
              </p>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                A ideia é a mesma das outras duas divisões: a lista virá dos grupos do Oxide, e cada
                grupo terá o seu multiplicador.
              </p>
            </div>

            <dl className="divide-y divide-border text-sm">
              {TIMER_MOCK.map((timer) => (
                <div key={timer.name} className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2">
                  <dt className="w-40 shrink-0 font-condensed font-bold uppercase tracking-wide">
                    {timer.name}
                  </dt>
                  <dd className="min-w-0 flex-1 text-2xs leading-relaxed text-muted">
                    {timer.detail}
                  </dd>
                  <dd className="shrink-0 font-mono text-2xs text-muted">{timer.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
