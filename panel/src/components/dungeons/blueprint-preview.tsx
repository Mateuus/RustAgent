'use client';

// ============================================================
//  blueprint-preview.tsx  -  ver a planta, e não só contá-la.
//
//  ####  "584 PEÇAS" NÃO DIZ NADA  ####
//
//  A lista sabe o tamanho, o peso e se tem alçapão — e nenhum
//  desses números responde à pergunta que o admin faz de verdade:
//  "que construção é essa?". Duas plantas de 155 peças podem ser
//  uma torre e um galpão.
//
//  O JSON tem a posição de cada peça. Então dá para DESENHAR: uma
//  vista de cima, cada peça no lugar dela, colorida pelo que ela é.
//
//  ####  VISTA DE CIMA, E POR ISSO `x` E `z`  ####
//
//  `y` é altura e não entra na projeção — a mesma armadilha do
//  `map-view.tsx`. E `z` cresce para o NORTE no jogo e para BAIXO
//  na tela, então o desenho usa `maxZ - z`; sem isso ele sai
//  espelhado, e tudo parece certo até alguém comparar com o jogo.
//
//  ####  ELE NÃO EDITA  ####
//
//  Mover peça é outro programa — o editor de grid, que é a frente
//  seguinte. Aqui é só olhar, e olhar já responde a pergunta.
// ============================================================

import { useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Dialog } from '@/components/ui/dialog';
import { agent, type BlueprintSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * As categorias de peça, na ordem em que são desenhadas.
 *
 * A ordem importa: estrutura primeiro, detalhe por cima. Desenhar
 * uma parede depois de uma caixa esconderia a caixa.
 */
const LAYERS = [
  {
    id: 'floor',
    label: 'Piso e fundação',
    color: 'var(--surface-2)',
    match: (prefab: string) =>
      prefab.includes('foundation') || prefab.includes('/floor/') || prefab.includes('floor.frame'),
  },
  {
    id: 'wall',
    label: 'Paredes',
    color: 'var(--border)',
    match: (prefab: string) => prefab.includes('/wall') || prefab.includes('wall.'),
  },
  {
    id: 'door',
    label: 'Portas',
    color: 'var(--amber)',
    match: (prefab: string) => prefab.includes('door') && !prefab.includes('doorway'),
  },
  {
    id: 'loot',
    label: 'Caixas e armários',
    color: 'var(--chart-2)',
    match: (prefab: string) =>
      prefab.includes('crate') ||
      prefab.includes('box') ||
      prefab.includes('locker') ||
      prefab.includes('cupboard'),
  },
  {
    id: 'light',
    label: 'Luzes',
    color: 'var(--chart-3)',
    match: (prefab: string) =>
      prefab.includes('light') || prefab.includes('lantern') || prefab.includes('lamp'),
  },
  {
    id: 'hatch',
    label: 'Marca do alçapão',
    color: 'var(--rust-red)',
    // As duas convenções do §5.3.7: o hatch e o vaso marcado. Aqui
    // basta o prefab — quem confere a marca de verdade é o agente,
    // na hora de gravar.
    match: (prefab: string) =>
      prefab.includes('floor.ladder.hatch') || prefab.includes('planter.large'),
  },
] as const;

interface Piece {
  readonly x: number;
  readonly z: number;
  readonly layer: number;
}

export interface BlueprintPreviewProps {
  readonly blueprint: BlueprintSummary;
  readonly onClose: () => void;
}

export function BlueprintPreview({ blueprint, onClose }: BlueprintPreviewProps) {
  const [pieces, setPieces] = useState<readonly Piece[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.dungeonBlueprint(blueprint.id);

        if (alive) setPieces(readPieces(response.blueprint.content));
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      alive = false;
    };
  }, [blueprint.id]);

  return (
    <Dialog open title={blueprint.name} onClose={onClose} className="w-[min(56rem,94vw)]">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui abrir a planta" detail={error} />
      )}

      {error === null && pieces === null && (
        <StateBlock variant="loading" title="Lendo a planta…" />
      )}

      {pieces !== null && (
        <div className="grid gap-3 sm:grid-cols-[1fr_13rem]">
          <TopView pieces={pieces} />

          <div className="space-y-3">
            <dl className="space-y-1.5 text-xs">
              <Stat label="Peças" value={String(blueprint.entityCount)} />
              <Stat label="Tamanho" value={formatBytes(blueprint.byteSize)} />
              <Stat
                label="Tipo"
                value={blueprint.kind === 'entrance' ? 'entrada' : 'masmorra'}
              />
              <Stat label="Alçapão" value={blueprint.hasHatch ? 'tem a marca' : 'sem marca'} />
            </dl>

            <Legend pieces={pieces} />
          </div>
        </div>
      )}

      <p className="mt-3 border-t border-border pt-2 text-2xs text-muted">
        Vista de cima, com cada peça no lugar dela. A altura não aparece: uma construção de dois
        andares se sobrepõe no desenho.
      </p>
    </Dialog>
  );
}

function TopView({ pieces }: { readonly pieces: readonly Piece[] }) {
  if (pieces.length === 0) {
    return (
      <div className="flex min-h-48 items-center justify-center border border-border bg-background text-xs text-muted">
        Nenhuma peça com posição legível.
      </div>
    );
  }

  const xs = pieces.map((piece) => piece.x);
  const zs = pieces.map((piece) => piece.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  // Uma margem em volta, para a peça da borda não encostar no
  // limite do quadro.
  const pad = 1.5;
  const width = Math.max(1, maxX - minX) + pad * 2;
  const height = Math.max(1, maxZ - minZ) + pad * 2;

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className="max-h-96 w-full border border-border bg-background"
      role="img"
      aria-label={`Vista de cima da planta, com ${String(pieces.length)} peças`}
    >
      {/* Ordenar por camada é o que faz o detalhe ficar por cima da
          estrutura. Ver o cabeçalho. */}
      {[...pieces]
        .sort((a, b) => a.layer - b.layer)
        .map((piece, index) => (
          <rect
            key={index}
            x={piece.x - minX + pad - 0.6}
            // `z` cresce para o norte no jogo e para baixo na tela.
            y={maxZ - piece.z + pad - 0.6}
            width={1.2}
            height={1.2}
            fill={LAYERS[piece.layer]?.color ?? 'var(--text-muted)'}
            opacity={piece.layer === 0 ? 0.9 : 1}
          />
        ))}
    </svg>
  );
}

function Legend({ pieces }: { readonly pieces: readonly Piece[] }) {
  const counts = new Map<number, number>();

  for (const piece of pieces) counts.set(piece.layer, (counts.get(piece.layer) ?? 0) + 1);

  return (
    <ul className="space-y-1 text-2xs">
      {LAYERS.map((layer, index) => {
        const count = counts.get(index) ?? 0;

        return (
          <li
            key={layer.id}
            className={cn('flex items-center gap-2', count === 0 && 'opacity-40')}
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 border border-border"
              style={{ backgroundColor: layer.color }}
            />
            <span className="min-w-0 flex-1 truncate text-muted">{layer.label}</span>
            <span className="shrink-0 tabular-nums">{count}</span>
          </li>
        );
      })}

      {(counts.get(LAYERS.length) ?? 0) > 0 && (
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 border border-border bg-muted"
          />
          <span className="min-w-0 flex-1 truncate text-muted">Outras</span>
          <span className="shrink-0 tabular-nums">{counts.get(LAYERS.length) ?? 0}</span>
        </li>
      )}
    </ul>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
      <dt className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-condensed text-sm font-bold">{value}</dd>
    </div>
  );
}

/**
 * Lê as posições do JSON do CopyPaste.
 *
 * ####  OS NÚMEROS VÊM COMO STRING  ####
 *
 * É o CopyPaste que faz isso, e `Number('3.515838')` funciona no
 * JavaScript sem depender de local — ao contrário do C#, onde a
 * mesma leitura sem `InvariantCulture` põe a construção a três
 * milhões de metros de altura.
 */
function readPieces(raw: string): Piece[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const entities = (parsed as { entities?: unknown }).entities;

  if (!Array.isArray(entities)) return [];

  const pieces: Piece[] = [];

  for (const entity of entities) {
    if (entity === null || typeof entity !== 'object') continue;

    const node = entity as { prefabname?: unknown; pos?: unknown };
    const prefab = typeof node.prefabname === 'string' ? node.prefabname : '';
    const pos = node.pos as { x?: unknown; z?: unknown } | undefined;

    if (pos === undefined) continue;

    const x = Number(pos.x);
    const z = Number(pos.z);

    if (Number.isNaN(x) || Number.isNaN(z)) continue;

    const layer = LAYERS.findIndex((candidate) => candidate.match(prefab));

    pieces.push({ x, z, layer: layer < 0 ? LAYERS.length : layer });
  }

  return pieces;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} KB`;
}
