'use client';

// ============================================================
//  body-preview.tsx  -  a construção importada, vista de cima, com
//  os pontos por cima.
//
//  ####  É O QUE RESPONDE "ONDE ESTE INIMIGO ESTÁ?"  ####
//
//  A lista de pontos diz `x 4,2 · z -7,5`, e ninguém lê isso como
//  lugar. A prévia desenha a construção — pisos, paredes, os vãos por
//  onde se passa, os móveis como pontinhos — e os pontos em cima dela,
//  cada tipo com uma FORMA:
//
//    círculo   inimigo (com um risco para onde ele olha)
//    quadrado  caixa
//    seta      a chegada do jogador, apontando para onde ele olha
//    triângulo vazado  uma árvore de Natal da planta
//
//  Forma, e não só cor: a régua do design system diz que identidade
//  nunca vem só da cor.
//
//  ####  O MESMO REFERENCIAL DO `blueprint-preview.tsx`  ####
//
//  Vista de cima, `x` para a direita e `z` para CIMA — o desenho usa
//  `maxZ - z`, senão sai espelhado. A diferença é que aqui o giro de
//  cada peça importa (a parede é um risco, não um quadradinho), e a
//  conta dele mora em `lib/dungeon-body.ts`, com teste.
//
//  ####  CLICAR SELECIONA; COM "MOVER" LIGADO, CLICAR POSICIONA  ####
//
//  Dois gestos no mesmo clique seriam o jeito de mover um inimigo sem
//  querer. O modo de posicionar é explícito (o botão "Mover" da
//  lista), dura um clique e diz isso na tela.
// ============================================================

import type { KeyboardEvent, MouseEvent } from 'react';

import type { BodyAnalysis, BodyArrival, BodyPoint } from '@/lib/api';
import {
  levelOf,
  pieceLayer,
  pieceOutlines,
  viewBounds,
  yawDirection,
  type PlanePoint,
} from '@/lib/dungeon-body';
import { cn } from '@/lib/utils';

/** A folga em volta do desenho, em metros. */
const PAD = 1;

/** O id que a chegada usa na seleção e nos avisos. */
export const ARRIVAL_ID = 'arrival';

const LAYER_STYLE = {
  floor: { fill: 'var(--surface-2)', stroke: 'var(--border)' },
  wall: { fill: 'var(--text-muted)', stroke: 'none' },
  opening: { fill: 'var(--text-muted)', stroke: 'none' },
  partial: { fill: 'var(--border)', stroke: 'var(--text-muted)' },
} as const;

export interface BodyPreviewProps {
  readonly analysis: BodyAnalysis | null;
  readonly points: readonly BodyPoint[];
  readonly arrival: BodyArrival | null;
  /** O id do ponto selecionado, ou `ARRIVAL_ID`. */
  readonly selected: string | null;
  /** Os ids com aviso no último scan. */
  readonly flagged: ReadonlySet<string>;
  /** Os andares da construção. Vazio ou um só = sem filtro. */
  readonly levels: readonly number[];
  /** O índice do andar mostrado. `null` = todos. */
  readonly level: number | null;
  /** Há um ponto esperando o clique que o posiciona? */
  readonly placing: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onPlace: (spot: PlanePoint) => void;
}

export function BodyPreview({
  analysis,
  points,
  arrival,
  selected,
  flagged,
  levels,
  level,
  placing,
  onSelect,
  onPlace,
}: BodyPreviewProps) {
  // O quadro enquadra TODOS os andares: trocar de andar não pode
  // mudar a escala, ou o admin perde a referência de onde estava.
  const bounds = viewBounds(analysis, points, arrival);
  const width = bounds.maxX - bounds.minX + PAD * 2;
  const height = bounds.maxZ - bounds.minZ + PAD * 2;

  const sx = (x: number): number => x - bounds.minX + PAD;
  const sy = (z: number): number => bounds.maxZ - z + PAD;

  /** Aquela altura está no andar mostrado? */
  const onLevel = (y: number): boolean =>
    level === null || levels.length < 2 || Math.max(0, levelOf(y, levels)) === level;

  const pieces = [...(analysis?.pieces ?? [])]
    .filter((piece) => onLevel(piece.y))
    // O piso primeiro: a parede desenhada antes dele sumiria embaixo.
    .sort((a, b) => layerOrder(pieceLayer(a.shape)) - layerOrder(pieceLayer(b.shape)));

  const props = (analysis?.props ?? []).filter((prop) => onLevel(prop.y));
  const trees = analysis?.markers.arrival ?? [];

  function handleClick(event: MouseEvent<SVGSVGElement>): void {
    if (!placing) {
      onSelect(null);
      return;
    }

    // `getScreenCTM` já desconta o letterbox do `preserveAspectRatio`:
    // é a única conta de tela para metro que não erra nas bordas.
    const matrix = event.currentTarget.getScreenCTM();

    if (matrix === null) return;

    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());

    onPlace({ x: local.x + bounds.minX - PAD, z: bounds.maxZ + PAD - local.y });
  }

  function pick(event: MouseEvent<SVGGElement>, id: string): void {
    // Posicionando, o clique em cima de outro ponto é o LUGAR, e não
    // uma troca de seleção: ele segue para o `svg`.
    if (placing) return;

    event.stopPropagation();
    onSelect(id);
  }

  function pickByKey(event: KeyboardEvent<SVGGElement>, id: string): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    event.preventDefault();
    onSelect(id);
  }

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn(
        // `overflow-hidden` explícito: nada do desenho — nem um anel,
        // nem um ponto fora da construção — pode vazar do quadro. A
        // altura acompanha a janela: o diálogo ocupa a tela inteira, e
        // a prévia fica parada enquanto a lista rola ao lado.
        'max-h-[max(16rem,calc(100dvh-21rem))] w-full select-none overflow-hidden border border-border bg-background',
        placing && 'cursor-crosshair',
      )}
      // `group`, e não `img`: um `img` torna os filhos decorativos, e os
      // pontos clicáveis sumiriam para o leitor de tela.
      role="group"
      aria-label={`Vista de cima da construção, com ${String(points.length)} ponto(s)`}
      onClick={handleClick}
    >
      {pieces.map((piece, index) =>
        pieceOutlines(piece).map((outline, part) => {
          const style = LAYER_STYLE[pieceLayer(piece.shape)];

          return (
            <polygon
              key={`${String(index)}-${String(part)}`}
              points={outline.map((corner) => `${String(sx(corner.x))},${String(sy(corner.z))}`).join(' ')}
              fill={style.fill}
              stroke={style.stroke}
              strokeWidth={0.05}
            />
          );
        }),
      )}

      {props.map((prop, index) => (
        <circle
          key={`prop-${String(index)}`}
          cx={sx(prop.x)}
          cy={sy(prop.z)}
          r={0.18}
          fill="var(--text-muted)"
          opacity={0.45}
        />
      ))}

      {trees.map((tree, index) => (
        <polygon
          key={tree.id}
          points={triangle(sx(tree.x), sy(tree.z), 0.7)}
          fill="none"
          stroke="var(--olive)"
          strokeWidth={0.12}
          opacity={onLevel(tree.y) ? 1 : 0.3}
        >
          <title>{`Árvore de Natal ${String(index + 1)} (x ${fixed(tree.x)}, z ${fixed(tree.z)})`}</title>
        </polygon>
      ))}

      {points.map((point) => {
        const cx = sx(point.x);
        const cy = sy(point.z);
        const facing = yawDirection(point.yaw);
        const isSelected = point.id === selected;
        const isFlagged = flagged.has(point.id);
        const label = `${point.kind === 'npc' ? 'Inimigo' : 'Caixa'}${point.label === '' ? '' : `: ${point.label}`}`;

        return (
          <g
            key={point.id}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={isSelected}
            opacity={onLevel(point.y) ? 1 : 0.3}
            // ####  O ANEL DE FOCO É NOSSO, E NÃO O DO NAVEGADOR  ####
            //
            // MEDIDO na prévia: o `outline` padrão de um `<g>` é
            // desenhado DENTRO do referencial do `viewBox` — 5 px
            // viram 5 metros, e o ponto focado some embaixo de um
            // borrão branco. O anel abaixo tem a espessura certa, e
            // só aparece no foco de teclado.
            className="cursor-pointer outline-none"
            onClick={(event) => pick(event, point.id)}
            onKeyDown={(event) => pickByKey(event, point.id)}
          >
            <title>{`${label} — x ${fixed(point.x)}, y ${fixed(point.y)}, z ${fixed(point.z)}`}</title>

            <circle
              cx={cx}
              cy={cy}
              r={1.15}
              fill="none"
              stroke="var(--text)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="opacity-0 [g:focus-visible>&]:opacity-100"
            />

            {isFlagged && (
              <circle
                cx={cx}
                cy={cy}
                r={0.95}
                fill="none"
                stroke="var(--amber)"
                strokeWidth={0.1}
                strokeDasharray="0.25 0.2"
              />
            )}

            {point.kind === 'npc' ? (
              <>
                <line
                  x1={cx}
                  y1={cy}
                  x2={cx + facing.x * 0.9}
                  y2={cy - facing.z * 0.9}
                  stroke="var(--rust-red)"
                  strokeWidth={0.12}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={0.45}
                  fill="var(--rust-red)"
                  stroke={isSelected ? 'var(--text)' : 'var(--bg)'}
                  strokeWidth={isSelected ? 0.16 : 0.06}
                />
              </>
            ) : (
              <rect
                x={cx - 0.4}
                y={cy - 0.4}
                width={0.8}
                height={0.8}
                fill="var(--amber)"
                stroke={isSelected ? 'var(--text)' : 'var(--bg)'}
                strokeWidth={isSelected ? 0.16 : 0.06}
              />
            )}

            {point.amount > 1 && (
              <text
                x={cx + 0.55}
                y={cy - 0.45}
                fontSize={0.7}
                fill="var(--text)"
                className="pointer-events-none"
              >
                {`×${String(point.amount)}`}
              </text>
            )}
          </g>
        );
      })}

      {arrival !== null && (
        <g
          role="button"
          tabIndex={0}
          aria-label="Chegada do jogador"
          aria-pressed={selected === ARRIVAL_ID}
          opacity={onLevel(arrival.y) ? 1 : 0.3}
          className="cursor-pointer outline-none"
          onClick={(event) => pick(event, ARRIVAL_ID)}
          onKeyDown={(event) => pickByKey(event, ARRIVAL_ID)}
        >
          <title>{`Chegada — x ${fixed(arrival.x)}, y ${fixed(arrival.y)}, z ${fixed(arrival.z)}, olhando a ${fixed(arrival.yaw)}°`}</title>

          <circle
            cx={sx(arrival.x)}
            cy={sy(arrival.z)}
            r={1.6}
            fill="none"
            stroke="var(--text)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            className="opacity-0 [g:focus-visible>&]:opacity-100"
          />

          {flagged.has(ARRIVAL_ID) && (
            <circle
              cx={sx(arrival.x)}
              cy={sy(arrival.z)}
              r={1.35}
              fill="none"
              stroke="var(--amber)"
              strokeWidth={0.12}
              strokeDasharray="0.3 0.2"
            />
          )}

          <circle
            cx={sx(arrival.x)}
            cy={sy(arrival.z)}
            r={1}
            fill="var(--olive)"
            fillOpacity={0.25}
            stroke={selected === ARRIVAL_ID ? 'var(--text)' : 'var(--olive)'}
            strokeWidth={selected === ARRIVAL_ID ? 0.16 : 0.1}
          />
          <polygon points={arrow(sx(arrival.x), sy(arrival.z), arrival.yaw)} fill="var(--olive)" />
        </g>
      )}
    </svg>
  );
}

/**
 * A legenda: cada forma com o nome dela.
 *
 * Fica fora do SVG para ser texto de verdade — selecionável, legível
 * no tamanho da fonte da tela, e lido pelo leitor de tela.
 */
export function BodyPreviewLegend({
  npcs,
  crates,
  hasArrival,
  trees,
}: {
  readonly npcs: number;
  readonly crates: number;
  readonly hasArrival: boolean;
  readonly trees: number;
}) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true">
          <circle cx={5} cy={5} r={4.5} fill="var(--rust-red)" />
        </svg>
        {npcs} inimigo(s)
      </li>
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true">
          <rect x={1} y={1} width={8} height={8} fill="var(--amber)" />
        </svg>
        {crates} caixa(s)
      </li>
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true">
          <polygon points="5,0 10,10 0,10" fill="var(--olive)" />
        </svg>
        {hasArrival ? 'a chegada (a ponta é para onde o jogador olha)' : 'sem chegada definida'}
      </li>
      {trees > 0 && (
        <li className="flex items-center gap-1">
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true">
            <polygon points="5,1 9,9 1,9" fill="none" stroke="var(--olive)" strokeWidth={1.5} />
          </svg>
          {trees} árvore(s) de Natal na planta
        </li>
      )}
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true">
          <circle cx={5} cy={5} r={4} fill="none" stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="2 1.5" />
        </svg>
        com aviso
      </li>
      <li>para cima é a frente da planta (+z) · um piso tem 3 m</li>
    </ul>
  );
}

function layerOrder(layer: ReturnType<typeof pieceLayer>): number {
  return layer === 'floor' ? 0 : layer === 'partial' ? 1 : 2;
}

/** Um triângulo com a ponta para cima, centrado no ponto. */
function triangle(cx: number, cy: number, size: number): string {
  return [
    [cx, cy - size],
    [cx + size * 0.87, cy + size * 0.5],
    [cx - size * 0.87, cy + size * 0.5],
  ]
    .map(([x, y]) => `${String(x)},${String(y)}`)
    .join(' ');
}

/**
 * A seta da chegada, apontando para onde o jogador olha.
 *
 * A frente é `yawDirection` — e o `y` da tela cresce para baixo, por
 * isso o sinal trocado no `z`.
 */
function arrow(cx: number, cy: number, yaw: number): string {
  const ahead = yawDirection(yaw);
  const side = yawDirection(yaw + 90);
  const tip = { x: cx + ahead.x * 1.3, y: cy - ahead.z * 1.3 };
  const left = { x: cx - side.x * 0.55 - ahead.x * 0.2, y: cy + side.z * 0.55 + ahead.z * 0.2 };
  const right = { x: cx + side.x * 0.55 - ahead.x * 0.2, y: cy - side.z * 0.55 + ahead.z * 0.2 };

  return [tip, left, right].map((corner) => `${String(corner.x)},${String(corner.y)}`).join(' ');
}

function fixed(value: number): string {
  return value.toFixed(1).replace('.', ',');
}
