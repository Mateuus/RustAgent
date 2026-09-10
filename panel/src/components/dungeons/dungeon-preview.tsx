'use client';

// ============================================================
//  dungeon-preview.tsx  -  a masmorra, antes de ela existir.
//
//  ####  É O BLOCO CENTRAL DESTA TELA  ####
//
//  O admin vai mexer em "peso da sala vermelha: 15" sem fazer
//  ideia do que isso produz. O que responde a pergunta dele não é
//  outro número ao lado: é VER a masmorra — quinze salas, três
//  vermelhas, um corredor que serpenteia por setenta células.
//
//  Sem isto, a tela é um editor de números e balancear vira
//  tentativa e erro de wipe em wipe. O editor de loot deste
//  projeto já pagou essa lição (`chance-explainer.tsx`).
//
//  ####  E O DESENHO NÃO É DECORATIVO  ####
//
//  `previewLayout` é o `BuildLayout` do plugin portado: o mesmo
//  corredor, as mesmas salas, as mesmas formas. O que aparece aqui
//  é a masmorra que vai nascer — e é por isso que o botão diz
//  "sortear outra" em vez de "atualizar".
//
//  ####  SVG, E NÃO CANVAS  ####
//
//  Mesma razão do `map-view.tsx`: cada célula é um elemento de
//  verdade, com `<title>` para o leitor de tela, e o volume aqui
//  (algumas centenas de retângulos) não chega perto de justificar
//  a conta de posição feita à mão que um canvas exigiria.
// ============================================================

import { Dices } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  estimateRecipe,
  previewLayout,
  type DungeonPreview,
  type DungeonPreview as Preview,
  type PreviewCell,
} from '@/lib/dungeon-layout';
import { cn } from '@/lib/utils';

/**
 * As cores das salas na prévia.
 *
 * ####  ELAS NÃO SÃO OS TOKENS DO CHROME  ####
 *
 * `--rust-red` e `--olive` têm ΔE 3.4 sob deuteranopia — quem tem
 * esse tipo de daltonismo não distingue os dois. Aqui verde, azul
 * e vermelho PRECISAM ser distinguíveis, então valem os tokens de
 * GRÁFICO, que o design system separou justamente para isso.
 *
 * E, mesmo assim, identidade nunca por cor sozinha: a contagem de
 * cada cor aparece escrita ao lado, com o nome.
 */
const ROOM_FILL = ['var(--chart-2)', 'var(--chart-1)', 'var(--chart-3)', 'var(--chart-4)'];

/** O lado de uma célula, em unidades de SVG. */
const CELL = 10;

export interface DungeonPreviewProps {
  /** Quantas salas sortear. É o meio do intervalo da receita. */
  readonly rooms: number;
  readonly seed: number;
  readonly onReseed: () => void;
  /**
   * O desenho pronto, no modo planta.
   *
   * Quando vem preenchido, NÃO se sorteia nada: a prévia mostra o
   * que o admin desenhou. Sortear ali seria pôr uma masmorra ao
   * lado de outra e chamar as duas de a mesma.
   */
  readonly fixed?: DungeonPreview | null;
  readonly weights: { readonly green: number; readonly blue: number; readonly red: number };
  readonly roomSpecs: readonly {
    readonly key: string;
    readonly npc: { readonly min: number; readonly max: number };
    readonly loot: { readonly min: number; readonly max: number };
  }[];
  readonly corridor: { readonly npcDensity: number; readonly lootDensity: number };
  readonly className?: string;
}

export function DungeonPreviewPanel({
  rooms,
  seed,
  onReseed,
  fixed = null,
  weights,
  roomSpecs,
  corridor,
  className,
}: DungeonPreviewProps) {
  const preview = fixed ?? previewLayout(rooms, seed);
  const estimate = estimateRecipe({ preview, weights, rooms: roomSpecs, corridor });

  return (
    <div className={cn('border border-border bg-surface', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />O que isso produz
        </h3>
        {/* Sortear não faz sentido sobre um desenho: o que está
            ali é o que o admin fez. */}
        {fixed === null && (
          <Button size="sm" variant="ghost" onClick={onReseed}>
            <Dices aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Sortear outra
          </Button>
        )}
      </header>

      <div className="grid gap-3 p-3 sm:grid-cols-[1fr_auto]">
        <LayoutSvg preview={preview} />

        <dl className="grid content-start gap-y-2 text-xs sm:w-44">
          <Stat label="Salas" value={String(estimate.rooms)} />
          <Stat label="Células" value={String(estimate.cells)} />
          <Stat label="Blocos" value={`≈ ${String(estimate.blocks)}`} />
          <Stat label="NPCs" value={`≈ ${String(estimate.npcs)}`} />
          <Stat label="Caixas" value={`≈ ${String(estimate.crates)}`} />
          <Stat label="Para limpar" value={`≈ ${String(estimate.minutes)} min`} />
        </dl>
      </div>

      <ColorBar counts={estimate.byColor} />

      <p className="border-t border-border px-3 py-2 text-2xs text-muted">
        {fixed === null
          ? 'Este é o algoritmo do servidor, não um desenho: cada nascimento sorteia um traçado novo dentro dessas contas. Os números com ≈ são médias — servem para comparar duas receitas, não como promessa.'
          : 'Este é o seu desenho, exatamente como ele vai ser construído. Os números com ≈ são médias do conteúdo, que ainda é sorteado dentro de cada sala.'}
      </p>
    </div>
  );
}

/**
 * O grid.
 *
 * O `viewBox` acompanha os limites do sorteio, então uma masmorra
 * de trinta salas e uma de três ocupam o mesmo espaço na tela — o
 * que importa é a FORMA, e não o tamanho aparente.
 */
function LayoutSvg({ preview }: { readonly preview: Preview }) {
  const { minX, maxX, minZ, maxZ } = preview.bounds;
  const width = (maxX - minX + 1) * CELL;
  const height = (maxZ - minZ + 1) * CELL;

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className="max-h-64 w-full border border-border bg-background"
      role="img"
      aria-label={`Prévia: ${String(preview.rooms)} salas e ${String(preview.cells.length)} células`}
    >
      {preview.cells.map((cell) => (
        <Cell key={`${String(cell.x)},${String(cell.z)}`} cell={cell} minX={minX} maxZ={maxZ} />
      ))}
    </svg>
  );
}

function Cell({
  cell,
  minX,
  maxZ,
}: {
  readonly cell: PreviewCell;
  readonly minX: number;
  readonly maxZ: number;
}) {
  // `z` cresce para o NORTE no jogo e para BAIXO na tela. Sem o
  // `maxZ - z` o desenho sai espelhado na vertical — a mesma
  // armadilha do `map-view.tsx`.
  const px = (cell.x - minX) * CELL;
  const py = (maxZ - cell.z) * CELL;

  const fill =
    cell.kind === 'entrance'
      ? 'var(--amber)'
      : cell.kind === 'corridor'
        ? 'var(--surface-2)'
        : (ROOM_FILL[cell.room % ROOM_FILL.length] ?? 'var(--chart-1)');

  return (
    <rect
      x={px}
      y={py}
      width={CELL}
      height={CELL}
      fill={fill}
      stroke="var(--bg)"
      strokeWidth={0.75}
      opacity={cell.kind === 'corridor' ? 1 : 0.85}
    >
      <title>
        {cell.kind === 'entrance'
          ? 'Entrada: é aqui que o alçapão cospe'
          : cell.kind === 'corridor'
            ? 'Corredor'
            : `Sala ${String(cell.room + 1)}`}
      </title>
    </rect>
  );
}

/**
 * A proporção das cores.
 *
 * Três campos numéricos soltos perdem o que a cor SIGNIFICA — ela
 * é o tier do cômodo, e a única linguagem que o jogador aprende
 * sem ler nada. A barra mostra a mistura de relance; os números ao
 * lado existem porque identidade nunca é só cor.
 */
function ColorBar({
  counts,
}: {
  readonly counts: { readonly green: number; readonly blue: number; readonly red: number };
}) {
  const total = counts.green + counts.blue + counts.red;

  if (total === 0) return null;

  const parts = [
    { label: 'verdes', count: counts.green, fill: 'var(--olive)' },
    { label: 'azuis', count: counts.blue, fill: 'var(--chart-2)' },
    { label: 'vermelhas', count: counts.red, fill: 'var(--rust-red)' },
  ] as const;

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="flex h-2 overflow-hidden">
        {parts.map((part) => (
          <div
            key={part.label}
            style={{ width: `${String((part.count / total) * 100)}%`, backgroundColor: part.fill }}
          />
        ))}
      </div>

      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted">
        {parts.map((part) => (
          <span key={part.label} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0"
              style={{ backgroundColor: part.fill }}
            />
            {part.count} {part.label}
          </span>
        ))}
      </p>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
      <dt className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-condensed text-sm font-bold tabular-nums">{value}</dd>
    </div>
  );
}
