'use client';

// ============================================================
//  dungeon-list.tsx  -  o que existe, e o que está no ar.
//
//  ####  O CARTÃO DO QUE ESTÁ NO AR NÃO MORA AQUI  ####
//
//  Ele é da PÁGINA, e não desta lista. MEDIDO na primeira versão:
//  com zero masmorras cadastradas e uma de pé no mapa, a tela caía
//  no bloco de primeiro uso e o cartão sumia junto — o cabeçalho
//  dizia "0 masmorras · 1 no ar" e não havia onde clicar para
//  derrubá-la.
//
//  Acontece de verdade: basta apagar a masmorra enquanto ela está
//  no ar. O que está no chão do jogo não depende do catálogo.
//
//  ####  A LINHA MOSTRA A MISTURA, E NÃO SÓ O NOME  ####
//
//  Duas masmorras chamadas "Bunker" e "Bunker 2" são
//  indistinguíveis por nome. O que as separa é o que elas SÃO —
//  quantas salas, que mistura de cores, que entrada —, e é isso
//  que a linha carrega.
// ============================================================

import { Copy, Hammer, MapPin, Pencil, Play, Trash2, Users } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { agent, type Dungeon, type DungeonSummary, type EventRun } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface DungeonListProps {
  readonly dungeons: readonly DungeonSummary[];
  readonly onEdit: (dungeon: Dungeon) => void;
  readonly onChanged: () => void;
  /**
   * Erguer esta masmorra agora.
   *
   * `undefined` = a página não oferece o gesto. Ele depende de
   * haver servidor cadastrado: sem nenhum, o botão abriria um
   * diálogo sem para onde mandar o comando.
   */
  readonly onBuild?: (dungeon: DungeonSummary) => void;
}

export function DungeonList({ dungeons, onEdit, onChanged, onBuild }: DungeonListProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(id: string) {
    setBusy(id);
    setError(null);

    try {
      const response = await agent.dungeon(id);

      onEdit(response.dungeon);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function duplicate(summary: DungeonSummary) {
    setBusy(summary.id);
    setError(null);

    try {
      await agent.duplicateDungeon(summary.id, {
        id: `${summary.id}-copia`.slice(0, 48),
        name: `${summary.name} (cópia)`,
      });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove(summary: DungeonSummary) {
    setBusy(summary.id);
    setError(null);

    try {
      await agent.removeDungeon(summary.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error !== null && (
        // Texto em --text com borda colorida: o vermelho do chrome
        // mede 3.7:1, que serve para borda e não para texto.
        <p className="border-l-2 border-rust bg-surface-2 px-3 py-2 text-xs text-foreground">
          {error}
        </p>
      )}

      {dungeons.map((dungeon) => (
        <article
          key={dungeon.id}
          className={cn(
            'border border-border bg-surface p-3',
            busy === dungeon.id && 'animate-pulse',
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 font-condensed text-sm font-bold">
                <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
                {dungeon.name}
              </h3>

              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                <span className="font-mono">{dungeon.id}</span>
                <span>
                  {dungeon.mode === 'recipe' ? 'receita' : 'planta'} ·{' '}
                  {dungeon.sizeMin === dungeon.sizeMax
                    ? `${String(dungeon.sizeMin)} salas`
                    : `${String(dungeon.sizeMin)}–${String(dungeon.sizeMax)} salas`}
                </span>
                <span>
                  entrada:{' '}
                  {dungeon.entranceBlueprint ?? (
                    <span className="italic">mínima, gerada por código</span>
                  )}
                </span>
              </p>
            </div>

            <div className="flex shrink-0 gap-1">
              {/* ####  ERGUER VEM ANTES DE EDITAR  ####

                  É o que se quer fazer com uma masmorra pronta, e
                  até aqui era a única coisa que esta tela NÃO
                  fazia: o editor mandava copiar um comando e ir
                  colar dentro do jogo. */}
              {onBuild !== undefined && (
                <Button size="sm" variant="primary" onClick={() => onBuild(dungeon)}>
                  <Play aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                  Erguer
                </Button>
              )}

              <Button size="sm" variant="outline" onClick={() => void open(dungeon.id)}>
                <Pencil aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                Editar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void duplicate(dungeon)}
                aria-label={`Duplicar ${dungeon.name}`}
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove(dungeon)}
                aria-label={`Apagar ${dungeon.name}`}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/**
 * O que está de pé agora.
 *
 * Primeiro elemento da tela quando existe; ausente quando não há
 * nada — um "nenhuma no ar" permanente vira ruído que se aprende a
 * ignorar.
 */
export function LiveCard({
  runs,
  onChanged,
}: {
  readonly runs: readonly EventRun[];
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  async function stop(run: EventRun) {
    setBusy(run.id);

    try {
      await agent.stopWorldEventRun(run.id);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-olive bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-olive" />
        <h2 className="font-condensed text-sm font-bold uppercase tracking-wide">No ar agora</h2>
      </header>

      <div className="divide-y divide-border">
        {runs.map((run) => (
          <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="font-condensed text-sm font-bold">{run.dungeonId ?? 'masmorra'}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                <span className="flex items-center gap-1">
                  <MapPin aria-hidden="true" className="h-3 w-3" />
                  {run.grid ?? '?'}
                </span>
                <span className="flex items-center gap-1">
                  <Users aria-hidden="true" className="h-3 w-3" />
                  {run.enteredCount} entrou/entraram
                </span>
                <span>{sinceLabel(run.startedAt)}</span>
                <span className="font-mono">{run.serverId}</span>
              </p>
            </div>

            <Button
              size="sm"
              variant="danger"
              disabled={busy === run.id}
              onClick={() => void stop(run)}
            >
              <Hammer aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Derrubar
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** "há 12 min". Sem segundo: ninguém precisa dessa precisão aqui. */
function sinceLabel(epoch: number | null): string {
  if (epoch === null) return 'há pouco';

  const minutes = Math.max(0, Math.round((Date.now() - epoch) / 60_000));

  if (minutes < 1) return 'agora mesmo';
  if (minutes < 60) return `há ${String(minutes)} min`;

  return `há ${String(Math.round(minutes / 60))} h`;
}
