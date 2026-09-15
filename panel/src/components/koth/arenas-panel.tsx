'use client';

// ============================================================
//  arenas-panel.tsx  -  onde o território acontece.
//
//  ####  O MAPA É O CAMPO, E NÃO UM ENFEITE  ####
//
//  A mesma lição dos pontos de masmorra: ninguém escolhe entre
//  (-1330, 871) e (204, -1502) sem ver os dois no mapa — e foi
//  digitando coordenada sem olhar que uma entrada nasceu dentro de
//  um rio.
//
//  Aqui é pior, porque o território não é um ponto: é um CÍRCULO de
//  raio configurável. Um raio de 25 m numa encosta é uma disputa;
//  os mesmos 25 m dentro de um monumento são um corredor.
//
//  ####  O QUE DIFERENCIA ISTO DE "ONDE NASCE"  ####
//
//  Lá o ponto é só um lugar, e o que nasce ali vem da masmorra
//  escolhida. Aqui o lugar É a disputa: o raio, a altura e o tempo
//  de captura são dele, e é por isso que o formulário é maior.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md.
// ============================================================

import { Flag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ArenaForm, blankReward } from '@/components/koth/arena-form';
import { MapView } from '@/components/map-view';
import { StateBlock } from '@/components/state-block';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Toggle } from '@/components/ui/toggle';
import { useMapImage } from '@/lib/hooks/use-map-image';
import { agent, type KothArena, type KothArenaInput, type PlayersSnapshot } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface ArenasPanelProps {
  readonly serverId: string;
}

/**
 * O território que o admin está criando ou editando.
 *
 * `null` = nenhum. O formulário é o mesmo nos dois casos — ver
 * `arena-form.tsx`.
 */
interface Editing {
  readonly value: KothArenaInput;
  /** Ausente = é um território novo. */
  readonly arena?: KothArena;
}

function blankArena(x: number, z: number): KothArenaInput {
  return {
    label: '',
    x,
    z,
    radius: 30,
    height: 30,
    // O padrão da casa: quinze minutos de domínio para vencer.
    captureSeconds: 900,
    durationSeconds: 3600,
    decayPerSecond: 0,
    enabled: true,
    reward: blankReward(),
  };
}

export function ArenasPanel({ serverId }: ArenasPanelProps) {
  const [arenas, setArenas] = useState<readonly KothArena[] | null>(null);
  const [snapshot, setSnapshot] = useState<PlayersSnapshot | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mapImage = useMapImage(serverId);

  const load = useCallback(async () => {
    try {
      const response = await agent.kothArenas(serverId);

      setArenas(response.arenas);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setArenas([]);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  // O mundo vem da mesma leitura dos jogadores — é ela que traz o
  // tamanho do mapa, sem o qual nada é projetável. Os jogadores vêm
  // junto de graça, e ver onde as pessoas estão ajuda a escolher.
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.players(serverId);

        if (alive) setSnapshot(response);
      } catch {
        if (alive) setSnapshot(null);
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  async function save(value: KothArenaInput): Promise<void> {
    if (editing === null) return;

    setSaving(true);

    try {
      if (editing.arena === undefined) {
        await agent.createKothArena(serverId, value);
        toast.success('Território cadastrado', { description: value.label });
      } else {
        await agent.updateKothArena(serverId, editing.arena.id, value);
        toast.success('Território salvo', { description: value.label });
      }

      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove(arena: KothArena): Promise<void> {
    try {
      await agent.removeKothArena(serverId, arena.id);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function toggle(arena: KothArena): Promise<void> {
    try {
      await agent.updateKothArena(serverId, arena.id, { ...arena, enabled: !arena.enabled });
      await load();
    } catch (cause) {
      toast.error('Não consegui mudar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (error !== null && arenas !== null && arenas.length === 0) {
    return <StateBlock variant="error" title="Não consegui ler os territórios" detail={error} />;
  }

  if (arenas === null) return <StateBlock variant="loading" title="Lendo os territórios…" />;

  const world = snapshot?.world ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
            Territórios
            <span className="font-normal text-muted">({arenas.length})</span>
          </h3>
          <p className="mt-1 max-w-2xl text-2xs text-muted">
            Clique no mapa para marcar onde o KOTH pode acontecer. O agendador sorteia entre os
            territórios ligados — e nunca repete o último usado quando há mais de um.
          </p>
        </div>
      </div>

      {world === null ? (
        <StateBlock
          variant="empty"
          title="O mapa não veio"
          detail="Sem o tamanho do mundo não há onde projetar. O servidor precisa estar de pé para marcar um território."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="border border-border bg-surface p-2">
            <MapView
              players={snapshot?.players ?? []}
              world={world}
              selected={null}
              onSelect={() => undefined}
              imageUrl={mapImage.url}
              coverage={mapImage.coverage}
              onPick={(point) => {
                setSelected(null);
                setEditing({ value: blankArena(Math.round(point.x), Math.round(point.z)) });
              }}
              marks={[
                ...arenas.map((arena) => ({
                  id: arena.id,
                  x: arena.x,
                  z: arena.z,
                  label: arena.label,
                  tone: arena.enabled ? ('normal' as const) : ('muted' as const),
                  selected: selected === arena.id,
                })),
                ...(editing === null || editing.arena !== undefined
                  ? []
                  : [
                      {
                        id: 'novo',
                        x: editing.value.x,
                        z: editing.value.z,
                        label: editing.value.label === '' ? 'novo' : editing.value.label,
                        tone: 'warning' as const,
                        selected: true,
                      },
                    ]),
              ]}
            />
          </div>

          <div className="space-y-3">
            {editing !== null && (
              <ArenaForm
                key={editing.arena?.id ?? 'novo'}
                value={editing.value}
                {...(editing.arena === undefined ? {} : { arena: editing.arena })}
                busy={saving}
                onSave={(value) => void save(value)}
                onCancel={() => setEditing(null)}
              />
            )}

            {arenas.length === 0 ? (
              <StateBlock
                variant="empty"
                title="Nenhum território ainda"
                detail="Clique no mapa para marcar o primeiro. Sem território, o KOTH não tem onde nascer."
              />
            ) : (
              <ul className="divide-y divide-border border border-border bg-surface">
                {arenas.map((arena) => (
                  <li key={arena.id} className="p-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(arena.id);
                        // Editar é a ação que se quer ao clicar num
                        // território: os números dele são a disputa.
                        setEditing({ value: { ...arena }, arena });
                      }}
                      className="flex w-full items-start justify-between gap-2 text-left"
                    >
                      <div className="min-w-0">
                        <p
                          className={cn(
                            'flex items-center gap-2 font-condensed text-sm font-bold',
                            !arena.enabled && 'text-muted',
                          )}
                        >
                          <Flag aria-hidden="true" className="h-3.5 w-3.5 text-rust" />
                          {arena.label}
                        </p>
                        <p className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-muted">
                          <span className="font-mono">
                            {Math.round(arena.x)}, {Math.round(arena.z)}
                          </span>
                          {arena.grid !== null && <span>{arena.grid}</span>}
                          <span>raio {arena.radius} m</span>
                          <span>captura {durationLabel(arena.captureSeconds)}</span>
                        </p>
                      </div>
                    </button>

                    <div className="mt-2 flex items-center justify-between gap-2">
                      <Toggle
                        on={arena.enabled}
                        busy={false}
                        onChange={() => void toggle(arena)}
                        labels={['no sorteio', 'fora do sorteio']}
                        label="Este território entra no sorteio?"
                      />

                      <ConfirmButton
                        variant="danger"
                        disabled={false}
                        icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
                        label="Apagar"
                        confirmLabel="Apagar mesmo"
                        hint="O território some do sorteio. O histórico do que já aconteceu nele fica."
                        onConfirm={() => void remove(arena)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "20 s", "5 min", "1 h 30 min".
 *
 * Arredondar tudo para minuto mostrava "captura 0 min" num
 * território de teste de vinte segundos — um número que diz que o
 * evento é instantâneo, e ele não é.
 */
function durationLabel(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} s`;

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}
