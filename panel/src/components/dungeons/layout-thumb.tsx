'use client';

// ============================================================
//  layout-thumb.tsx  -  o traçado, pequeno.
//
//  ####  UMA LISTA DE TRAÇADOS SEM OS TRAÇADOS É UMA LISTA DE NOMES  ####
//
//  "Serpente · 46 células · 4 salas" não diz que desenho é aquele,
//  do mesmo jeito que "584 peças" não dizia que construção era a
//  `base2`. O desenho inteiro cabe em algumas centenas de bytes e
//  vem junto na listagem — então dá para MOSTRAR.
//
//  ####  ELE DESENHA DAS LINHAS, E NÃO DO `previewFromGrid`  ####
//
//  Aquele converte letra em índice de sala, e no caminho perde QUAL
//  letra era: a miniatura sairia com a paleta de salas numeradas em
//  vez das três cores que o admin pintou. Aqui a letra é a cor, e
//  ler direto é também menos código.
//
//  O mesmo componente serve à prateleira, ao seletor do passo ② e
//  ao diálogo de ver. Um segundo desenho seria um segundo lugar
//  para o norte sair invertido.
// ============================================================

import { cn } from '@/lib/utils';

/**
 * A cor de cada caractere do formato.
 *
 * São os mesmos tokens do editor e da prévia: verde, azul e
 * vermelho vêm dos tokens de GRÁFICO, que o design system separou
 * do chrome justamente porque `--rust-red` e `--olive` não se
 * distinguem sob deuteranopia.
 */
const FILL: Readonly<Record<string, string>> = {
  '#': 'var(--surface-2)',
  E: 'var(--amber)',
  G: 'var(--olive)',
  B: 'var(--chart-2)',
  R: 'var(--rust-red)',
};

export interface LayoutThumbProps {
  /** Uma linha por fileira de z, do maior para o menor. */
  readonly grid: readonly string[];
  readonly className?: string;
  /**
   * O tamanho do traço entre as células.
   *
   * Numa miniatura de 90 pixels, a borda de cada célula come metade
   * do desenho — então ela some. No tamanho grande ela volta, e é o
   * que deixa contar os cômodos.
   */
  readonly gridLines?: boolean;
}

export function LayoutThumb({ grid, className, gridLines = false }: LayoutThumbProps) {
  const height = grid.length;
  const width = Math.max(1, ...grid.map((row) => row.length));

  if (height === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center border border-border bg-background text-2xs text-muted',
          className,
        )}
      >
        sem desenho
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      // `meet` mantém a proporção: um traçado comprido não pode
      // aparecer esticado, ou o admin escolhe pela forma errada.
      preserveAspectRatio="xMidYMid meet"
      className={cn('border border-border bg-background', className)}
      role="img"
      aria-label={describe(grid)}
    >
      {grid.map((row, index) =>
        [...row].map((char, x) => {
          const fill = FILL[char];

          if (fill === undefined) return null;

          return (
            <rect
              // As células não entram na árvore de acessibilidade:
              // um traçado de 24×24 viraria 576 itens, e quem
              // descreve o conjunto é o `aria-label` do SVG.
              aria-hidden="true"
              key={`${String(index)},${String(x)}`}
              x={x}
              // A primeira linha é a de MAIOR z — o norte em cima.
              // O índice já cresce para baixo, então ele serve
              // direto; inverter aqui espelharia o desenho.
              y={index}
              width={1}
              height={1}
              fill={fill}
              stroke={gridLines ? 'var(--bg)' : undefined}
              strokeWidth={gridLines ? 0.06 : undefined}
            />
          );
        }),
      )}
    </svg>
  );
}

/** O que um leitor de tela ouve no lugar do desenho. */
function describe(grid: readonly string[]): string {
  let corridor = 0;
  let rooms = 0;

  for (const row of grid) {
    for (const char of row) {
      if (char === '#' || char === 'E') corridor += 1;
      else if (char !== '.' && char !== ' ') rooms += 1;
    }
  }

  return `Traçado com ${String(corridor)} células de corredor e ${String(rooms)} de sala`;
}
