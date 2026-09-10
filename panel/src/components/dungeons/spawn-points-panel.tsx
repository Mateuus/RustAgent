'use client';

// ============================================================
//  spawn-points-panel.tsx  -  onde a masmorra nasce.
//
//  ####  O QUE ESTA TELA RESOLVE  ####
//
//  Até aqui a masmorra só nascia onde o admin estivesse de pé, com
//  o comando colado no chat do jogo. O pedido do dono em
//  09/09/2026 foi outro: "o admin pode definir posições que ela vai
//  spawn, que ele determina e já sabe".
//
//  Aqui ele marca esses lugares uma vez. Depois, erguer é apontar
//  para um nome — e o agendador vai sortear entre eles.
//
//  ####  NÃO CONFUNDIR COM AS ZONAS DE EVENTO  ####
//
//  Aquelas dizem onde NADA nasce. Estas dizem o contrário.
//
//  ####  O MAPA É O CAMPO, E NÃO UM ENFEITE  ####
//
//  A alternativa era dois campos de número. Ninguém escolhe entre
//  (-1330, 871) e (204, -1502) sem ver os dois no mapa — e foi
//  exatamente digitando coordenada sem olhar que uma entrada nasceu
//  dentro de um rio e matou o dono no teleporte.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §4.
// ============================================================

import { Crosshair, Loader2, MapPin, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { MapView } from '@/components/map-view';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { useMapImage } from '@/lib/hooks/use-map-image';
import { agent, type GroundReport, type PlayersSnapshot, type SpawnPoint } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface SpawnPointsPanelProps {
  readonly serverId: string;
  /** Chamado quando a lista muda: quem mostra contagem precisa saber. */
  readonly onChanged?: () => void;
}

/** O que está sendo marcado agora, antes de virar ponto. */
interface Draft {
  readonly x: number;
  readonly z: number;
  readonly label: string;
  readonly yaw: number;
  /** O que o servidor disse do chão. `null` = ainda perguntando, ou não deu. */
  readonly ground: GroundReport | null;
  readonly asking: boolean;
}

export function SpawnPointsPanel({ serverId, onChanged }: SpawnPointsPanelProps) {
  const [points, setPoints] = useState<readonly SpawnPoint[] | null>(null);
  const [worldKey, setWorldKey] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PlayersSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mapImage = useMapImage(serverId);

  const load = useCallback(async () => {
    try {
      const response = await agent.spawnPoints(serverId);

      setPoints(response.points);
      setWorldKey(response.worldKey);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPoints([]);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ####  O MUNDO VEM DA MESMA LEITURA DOS JOGADORES  ####
  //
  // O `MapView` precisa do tamanho do mundo para projetar
  // qualquer coisa, e é essa chamada que o traz. Os jogadores
  // vêm junto de graça — e ver onde as pessoas estão é
  // exatamente o que decide "longe das bases".
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.players(serverId);

        if (alive) setSnapshot(response);
      } catch {
        // Sem servidor no fio a tela continua servindo: a lista de
        // pontos é do banco, e marcar um novo é o que fica de fora.
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  /**
   * Clicou no mapa: começa um ponto ali e pergunta como é o chão.
   *
   * A pergunta é o que separa esta tela de dois campos de número.
   */
  const pick = useCallback(
    (point: { x: number; z: number }) => {
      const x = Math.round(point.x);
      const z = Math.round(point.z);

      setDraft({ x, z, label: '', yaw: 0, ground: null, asking: true });

      void (async () => {
        try {
          const response = await agent.dungeonGround(serverId, x, z);

          setDraft((current) =>
            current === null || current.x !== x || current.z !== z
              ? current
              : { ...current, ground: response.ground, asking: false },
          );
        } catch {
          // Servidor parado: marca-se do mesmo jeito, sem veredito.
          // Inventar um "serve" aqui seria pior que não ter nenhum.
          setDraft((current) => (current === null ? current : { ...current, asking: false }));
        }
      })();
    },
    [serverId],
  );

  async function save() {
    if (draft === null) return;

    setSaving(true);

    try {
      const response = await agent.createSpawnPoint(serverId, {
        label: draft.label.trim() === '' ? `Ponto ${draft.ground?.grid ?? ''}`.trim() : draft.label,
        x: draft.x,
        z: draft.z,
        yaw: draft.yaw,
        enabled: true,
      });

      if (response.warning !== null) {
        toast.warning('Ponto marcado, com ressalva', { description: response.warning });
      }

      setDraft(null);
      await load();
      onChanged?.();
    } catch (cause) {
      toast.error('Não consegui marcar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggle(point: SpawnPoint) {
    try {
      await agent.updateSpawnPoint(serverId, point.id, {
        label: point.label,
        x: point.x,
        z: point.z,
        yaw: point.yaw,
        enabled: !point.enabled,
      });

      await load();
      onChanged?.();
    } catch (cause) {
      toast.error('Não consegui mudar o ponto', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function remove(point: SpawnPoint) {
    try {
      await agent.removeSpawnPoint(serverId, point.id);
      await load();
      onChanged?.();
    } catch (cause) {
      toast.error('Não consegui apagar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (error !== null) {
    return <StateBlock variant="error" title="Os pontos não vieram" detail={error} />;
  }

  if (points === null) {
    return <StateBlock variant="loading" title="Lendo os pontos…" />;
  }

  const stale = points.filter((point) => isStale(point, worldKey));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
            Onde ela pode nascer
          </h3>
          <p className="mt-1 text-2xs text-muted">
            Clique no mapa para marcar um lugar. Depois, erguer é escolher o nome dele.
          </p>
        </div>

        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          {points.length} ponto(s)
        </span>
      </div>

      {stale.length > 0 && (
        <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-2xs">
          {stale.length === 1
            ? 'Um ponto foi marcado noutro mapa'
            : `${String(stale.length)} pontos foram marcados noutro mapa`}
          : a mesma coordenada, depois de um wipe, é outro lugar. Eles ficam de fora do sorteio até
          serem remarcados.
        </p>
      )}

      {snapshot === null ? (
        <div className="border border-border bg-surface-2 p-4 text-center text-2xs text-muted">
          O mapa é do servidor, e ele não está respondendo. Os pontos abaixo continuam valendo — o
          que não dá para fazer agora é marcar um novo.
        </div>
      ) : (
        <div className="h-140 min-h-64">
          <MapView
            players={snapshot.players}
            world={snapshot.world}
            selected={null}
            onSelect={() => undefined}
            imageUrl={mapImage.url}
            coverage={mapImage.coverage}
            onPick={pick}
            marks={[
              ...points.map((point) => ({
                id: point.id,
                x: point.x,
                z: point.z,
                label: point.label,
                tone: !point.enabled || isStale(point, worldKey) ? ('muted' as const) : ('normal' as const),
              })),
              ...(draft === null
                ? []
                : [
                    {
                      id: 'draft',
                      x: draft.x,
                      z: draft.z,
                      label: draft.label === '' ? 'Aqui' : draft.label,
                      tone: 'warning' as const,
                      selected: true,
                    },
                  ]),
            ]}
          />
        </div>
      )}

      {draft !== null && (
        <div className="border border-amber bg-surface-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-condensed text-xs font-bold uppercase tracking-wide">
              <Crosshair aria-hidden="true" className="h-3.5 w-3.5 text-amber" />
              {draft.ground === null
                ? `(${String(draft.x)}, ${String(draft.z)})`
                : `${draft.ground.grid} · (${String(draft.x)}, ${String(draft.z)})`}
            </p>

            <GroundNote draft={draft} />
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <Input
              autoFocus
              value={draft.label}
              maxLength={60}
              placeholder="Encosta do lago, atrás do aeroporto…"
              onChange={(event) =>
                setDraft((current) =>
                  current === null ? current : { ...current, label: event.target.value },
                )
              }
            />

            <label className="flex items-center gap-2 text-2xs text-muted">
              Cresce para
              <select
                value={String(draft.yaw)}
                onChange={(event) =>
                  setDraft((current) =>
                    current === null ? current : { ...current, yaw: Number(event.target.value) },
                  )
                }
                className="h-9 border border-border bg-background px-2 text-sm text-foreground"
              >
                {YAWS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancelar
              </Button>
              <Button size="sm" variant="confirm" disabled={saving} onClick={() => void save()}>
                {saving ? (
                  <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MapPin aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                )}
                Marcar aqui
              </Button>
            </span>
          </div>
        </div>
      )}

      {points.length === 0 ? (
        <p className="border border-border bg-surface-2 p-3 text-xs text-muted">
          Nenhum ponto ainda. Sem eles, a masmorra só nasce onde alguém estiver de pé no jogo, com o
          comando colado no chat.
        </p>
      ) : (
        <ul className="space-y-1">
          {points.map((point) => (
            <li
              key={point.id}
              className={cn(
                'flex flex-wrap items-center gap-3 border border-border bg-surface-2 px-3 py-2',
                !point.enabled && 'opacity-60',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{point.label}</span>
                <span className="block font-mono text-2xs text-muted">
                  {point.grid ?? '?'} · ({String(Math.round(point.x))}, {String(Math.round(point.z))}
                  ) · cresce para {yawLabel(point.yaw)}
                  {isStale(point, worldKey) && ' · de outro mapa'}
                  {point.waterDepth !== null && point.waterDepth > 0.5 && ' · ÁGUA'}
                </span>
              </span>

              <Button size="sm" variant="outline" onClick={() => void toggle(point)}>
                {point.enabled ? 'Desligar' : 'Ligar'}
              </Button>

              <ConfirmButton
                variant="danger"
                disabled={false}
                icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
                label="Apagar"
                confirmLabel="Apagar mesmo"
                hint="O ponto some da lista. As masmorras que já nasceram ali continuam de pé."
                onConfirm={() => void remove(point)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** O que o servidor disse daquele chão, em uma linha. */
function GroundNote({ draft }: { readonly draft: Draft }) {
  if (draft.asking) {
    return (
      <span className="flex items-center gap-2 text-2xs text-muted">
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
        Perguntando ao servidor como é o chão ali…
      </span>
    );
  }

  if (draft.ground === null) {
    return (
      <span className="text-2xs text-muted">
        O servidor não respondeu: dá para marcar, mas ninguém conferiu o terreno.
      </span>
    );
  }

  if (!draft.ground.serves) {
    return (
      <span className="text-2xs text-amber">
        É água: {draft.ground.depth.toFixed(1)} m de profundidade. A entrada nasceria submersa.
      </span>
    );
  }

  return <span className="text-2xs text-olive">Terra firme, altura {draft.ground.ground.toFixed(1)}.</span>;
}

/**
 * As oito direções.
 *
 * Graus, e não uma bússola livre: a masmorra cresce em blocos de
 * 3 metros alinhados, e 37° não faz nada que 45° não faça.
 */
const YAWS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 0, label: 'Norte' },
  { value: 45, label: 'Nordeste' },
  { value: 90, label: 'Leste' },
  { value: 135, label: 'Sudeste' },
  { value: 180, label: 'Sul' },
  { value: 225, label: 'Sudoeste' },
  { value: 270, label: 'Oeste' },
  { value: 315, label: 'Noroeste' },
];

function yawLabel(yaw: number): string {
  const normalized = ((Math.round(yaw / 45) * 45) % 360 + 360) % 360;

  return YAWS.find((option) => option.value === normalized)?.label ?? `${String(Math.round(yaw))}°`;
}

/**
 * Este ponto é de outro mapa?
 *
 * Sem `worldKey` de um dos lados a resposta é NÃO: acusar um ponto
 * de estar errado porque o agente não sabe qual mundo está no ar
 * seria pedir que o admin remarque tudo por nada.
 */
function isStale(point: SpawnPoint, worldKey: string | null): boolean {
  return worldKey !== null && point.worldKey !== null && point.worldKey !== worldKey;
}
