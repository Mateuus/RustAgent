'use client';

// ============================================================
//  build-dialog.tsx  -  erguer a masmorra, daqui.
//
//  ####  O PASSO ⑥ DIZIA QUE ISTO NÃO DAVA PARA FAZER  ####
//
//  "Esta é a única parte que não dá para fazer daqui — e não é
//  limitação, é o ponto." O painel copiava `/ozdungeon build x`
//  para a área de transferência e esperava o admin entrar no jogo.
//
//  Não era limitação nenhuma: o console aceita
//  `ozdungeon build <slug> <x> <z> [graus]` desde a frente C.
//  Faltava o botão, e faltava alguém saber ONDE — que é o que os
//  pontos de nascimento resolveram.
//
//  ####  E ELE NÃO DIZ "PRONTO"  ####
//
//  Mandar o comando não é a masmorra existir: a construção leva
//  segundos e quem confirma é o histórico. O painel já afirmou uma
//  vez ter derrubado uma masmorra que continuava de pé, e essa é a
//  falha que ninguém desconfia.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §1.
// ============================================================

import { Hammer, Loader2, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { agent, type DungeonSummary, type SpawnPoint } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface BuildDialogProps {
  readonly dungeon: DungeonSummary;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  /** Chamado depois que o comando saiu: o histórico tem novidade. */
  readonly onSent: () => void;
}

export function BuildDialog({ dungeon, servers, onClose, onSent }: BuildDialogProps) {
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [points, setPoints] = useState<readonly SpawnPoint[] | null>(null);
  const [worldKey, setWorldKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (serverId === '') return undefined;

    let alive = true;

    setPoints(null);
    setChosen(null);

    void (async () => {
      try {
        const response = await agent.spawnPoints(serverId);

        if (!alive) return;

        setPoints(response.points);
        setWorldKey(response.worldKey);

        // O primeiro utilizável já vem escolhido: com um ponto só —
        // que é o caso normal — erguer vira um clique.
        const first = response.points.find((point) => usable(point, response.worldKey));

        setChosen(first?.id ?? null);
      } catch (cause) {
        if (alive) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPoints([]);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  async function build() {
    if (chosen === null) return;

    setBusy(true);
    setError(null);

    try {
      const response = await agent.buildDungeon(dungeon.id, { serverId, pointId: chosen });

      setDone(response.message);
      onSent();
    } catch (cause) {
      // A frase da API vem inteira: ela sabe se o ponto é água, se
      // já há uma masmorra de pé (e qual), ou se o servidor caiu.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const ready = points ?? [];
  const options = ready.filter((point) => usable(point, worldKey));

  return (
    <Dialog open title={`Erguer ${dungeon.name}`} onClose={onClose} busy={busy}>
      <div className="space-y-3">
        {servers.length > 1 && (
          <label className="block">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Servidor
            </span>
            <select
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
              className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
            >
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {points === null ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Lendo os pontos deste servidor…
          </p>
        ) : options.length === 0 ? (
          <p className="border-l-2 border-amber bg-surface-2 px-3 py-3 text-xs">
            Este servidor não tem nenhum lugar marcado onde a masmorra possa nascer. Marque um na
            aba <strong className="text-foreground">Onde nasce</strong> — é um clique no mapa.
          </p>
        ) : (
          <div>
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Onde ela nasce
            </span>

            <ul className="mt-1 space-y-1">
              {options.map((point) => (
                <li key={point.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(point.id)}
                    aria-pressed={chosen === point.id}
                    className={cn(
                      'flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors',
                      chosen === point.id
                        ? 'border-amber bg-surface-2'
                        : 'border-border hover:border-amber',
                    )}
                  >
                    <MapPin
                      aria-hidden="true"
                      className={cn(
                        'h-4 w-4 shrink-0',
                        chosen === point.id ? 'text-amber' : 'text-muted',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{point.label}</span>
                      <span className="block font-mono text-2xs text-muted">
                        {point.grid ?? '?'} · ({String(Math.round(point.x))},{' '}
                        {String(Math.round(point.z))})
                        {point.waterDepth !== null && point.waterDepth > 0.5 && ' · ÁGUA'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {done !== null && (
          <div className="border-l-2 border-olive bg-surface-2 px-3 py-3">
            <p className="font-condensed text-sm font-bold uppercase tracking-wide">Mandei</p>
            <p className="mt-1 text-xs text-muted">
              {done} A linha aparece no histórico quando ela terminar de subir.
            </p>
          </div>
        )}

        {error !== null && (
          <p role="alert" className="border-l-2 border-rust bg-surface-2 px-3 py-2 text-xs">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {done === null ? 'Fechar' : 'Pronto'}
          </Button>

          <Button
            size="sm"
            variant="confirm"
            disabled={busy || chosen === null}
            onClick={() => void build()}
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Hammer aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            )}
            {done === null ? 'Erguer agora' : 'Erguer de novo'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Este ponto serve para erguer AGORA?
 *
 * Desligado não serve. De outro mapa também não: a coordenada é a
 * mesma e o lugar é outro — a encosta virou fundo de lago.
 */
function usable(point: SpawnPoint, worldKey: string | null): boolean {
  if (!point.enabled) return false;

  return worldKey === null || point.worldKey === null || point.worldKey === worldKey;
}
