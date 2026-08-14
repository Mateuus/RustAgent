'use client';

// ============================================================
//  map-view.tsx  -  o mundo, e quem está nele.
//
//  ####  A PROJEÇÃO, QUE É ONDE MORA O ERRO CLÁSSICO  ####
//
//  O mundo do Rust é centrado na origem: `X` e `Z` vão de `-size/2`
//  a `+size/2`.
//
//      px = ((x + size/2) / size) * lado
//      py = ((size/2 - z) / size) * lado
//
//  Duas coisas que parecem detalhe e não são:
//
//  `Y` É ALTURA e não entra aqui. Usar `(x, y)` funciona até alguém
//  subir num prédio — e então o ponto salta para o outro lado do
//  mapa.
//
//  `Z` É INVERTIDO. Ele cresce para o NORTE no jogo e para BAIXO na
//  tela. Sem o `size/2 - z` o mapa sai espelhado na vertical: tudo
//  parece certo até alguém comparar com o mapa do jogo.
//
//  ------------------------------------------------------------
//  ####  SVG, E NÃO CANVAS  ####
//
//  Cada jogador é um elemento de verdade: hover, clique e leitor de
//  tela saem de graça. Num canvas, cada um desses seria uma conta
//  de posição feita à mão — e o volume aqui (até algumas centenas
//  de pontos) não chega perto de justificar isso.
//
//  ####  E O MOVIMENTO NÃO É INTERPOLADO  ####
//
//  O ponto pula da posição antiga para a nova a cada leitura. Uma
//  animação contínua custa FPS no navegador o tempo todo — e essa
//  lição já foi paga uma vez, no overlay de propagandas (ver
//  Docs\09-ROADMAP.md).
// ============================================================

import { useCallback, useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';

import { Button } from '@/components/ui/button';
import type { GamePlayer, WorldGrid } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { cn } from '@/lib/utils';

/** O lado do desenho, em unidades de SVG. */
const SIDE = 1000;

/** A faixa das réguas de letra e número, em volta do mapa. */
const GUTTER = 28;

/** O enquadramento inteiro: mapa mais as réguas. */
const FULL_VIEW = { x: -GUTTER, y: -GUTTER, side: SIDE + GUTTER * 2 } as const;

/**
 * Os limites do zoom.
 *
 * O mínimo é o mapa inteiro — não há o que ver afastando mais que
 * isso. O máximo é ~20×, onde uma célula da grade ocupa a tela e dá
 * para separar dois jogadores na mesma base.
 */
const MIN_SIDE = FULL_VIEW.side / 20;
const MAX_SIDE = FULL_VIEW.side;

interface View {
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Mantém o enquadramento dentro do desenho.
 *
 * Sem isto, arrastar leva o mapa para fora da tela e a única saída
 * é o botão de reenquadrar — que a pessoa ainda não sabe que
 * existe.
 */
function clampView(view: View): View {
  const side = clamp(view.side, MIN_SIDE, MAX_SIDE);
  const limit = FULL_VIEW.side - side;

  return {
    side,
    x: clamp(view.x, FULL_VIEW.x, FULL_VIEW.x + limit),
    y: clamp(view.y, FULL_VIEW.y, FULL_VIEW.y + limit),
  };
}

export interface MapViewProps {
  readonly players: readonly GamePlayer[];
  readonly world: WorldGrid;
  /** O SteamID selecionado, se houver. */
  readonly selected: string | null;
  readonly onSelect: (player: GamePlayer) => void;
  /**
   * A imagem do mundo, já baixada (um `blob:`).
   *
   * `null` = ainda não há. O mapa continua servindo: a grade e os
   * pontos são o que respondem "onde eles estão", e a imagem é o
   * que torna a resposta reconhecível. Ver o cabeçalho.
   */
  readonly imageUrl?: string | null;
  /**
   * Quantas unidades do mundo a IMAGEM cobre, de ponta a ponta.
   *
   * ####  ELA NÃO É O `worldSize`  ####
   *
   * MEDIDO: um mundo de 4000 rende um PNG de 5000×5000 — o jogo
   * desenha uma faixa de oceano em volta do mundo jogável. Projetar
   * sobre o `worldSize` empurra todo mundo para fora por 25%: quem
   * está na costa norte aparece no meio do oceano.
   *
   * `null` = sem imagem, e aí o desenho é do mundo puro.
   */
  readonly coverage?: number | null;
}

/**
 * Mundo -> desenho.
 *
 * `span` é o que o quadrado do desenho REPRESENTA: a cobertura da
 * imagem quando há imagem, o mundo quando não há. Ver o cabeçalho —
 * `z` é invertido.
 */
function project(
  position: { x: number; z: number },
  span: number,
): { readonly px: number; readonly py: number } {
  const half = span / 2;

  return {
    px: ((position.x + half) / span) * SIDE,
    py: ((half - position.z) / span) * SIDE,
  };
}

/** `0 -> A`, `26 -> AA`. O mesmo do agente (game/grid.ts). */
function columnName(index: number): string {
  let name = '';
  let remaining = index;

  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);

  return name;
}

export function MapView({
  players,
  world,
  selected,
  onSelect,
  imageUrl = null,
  coverage = null,
}: MapViewProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setView] = useState<View>(FULL_VIEW);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** De onde o arraste começou, em coordenadas do desenho. */
  const dragFrom = useRef<{ x: number; y: number; view: View } | null>(null);

  /** Tela -> desenho. É o que faz o zoom respeitar o cursor. */
  const toDrawing = useCallback(
    (clientX: number, clientY: number, current: View) => {
      const box = svgRef.current?.getBoundingClientRect();

      if (box === undefined || box.width === 0) {
        return { x: current.x + current.side / 2, y: current.y + current.side / 2 };
      }

      // O SVG mantém proporção (o viewBox é quadrado): o lado
      // visível é o MENOR dos dois, e sobra faixa no outro eixo.
      const rendered = Math.min(box.width, box.height);
      const offsetX = (box.width - rendered) / 2;
      const offsetY = (box.height - rendered) / 2;

      return {
        x: current.x + ((clientX - box.left - offsetX) / rendered) * current.side,
        y: current.y + ((clientY - box.top - offsetY) / rendered) * current.side,
      };
    },
    [],
  );

  /**
   * ####  O ZOOM É EM VOLTA DO CURSOR  ####
   *
   * Aproximar sempre no centro obriga a arrastar depois de cada
   * passo para voltar ao lugar que se estava olhando. Ancorar no
   * cursor é o que torna a roda utilizável sem pensar.
   */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      setView((current) => {
        const anchor = toDrawing(clientX, clientY, current);
        const side = clamp(current.side * factor, MIN_SIDE, MAX_SIDE);
        // A fração do ponto dentro do enquadramento não muda: é
        // isso que o mantém debaixo do cursor.
        const ratioX = (anchor.x - current.x) / current.side;
        const ratioY = (anchor.y - current.y) / current.side;

        return clampView({ side, x: anchor.x - ratioX * side, y: anchor.y - ratioY * side });
      });
    },
    [toDrawing],
  );

  const onWheel = useCallback(
    (event: WheelEvent<SVGSVGElement>) => {
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 1.2 : 1 / 1.2);
    },
    [zoomAt],
  );

  // O `wheel` precisa de um ouvinte NÃO-passivo para o
  // `preventDefault` valer: com o passivo do React, a roda rola a
  // página junto e a tela foge enquanto se dá zoom.
  useEffect(() => {
    const element = svgRef.current;

    if (element === null) {
      return;
    }

    const handler = (event: globalThis.WheelEvent): void => {
      event.preventDefault();
    };

    element.addEventListener('wheel', handler, { passive: false });

    return () => element.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      // Só o botão principal, e só fora de um jogador: arrastar a
      // partir de um ponto é como se seleciona, não como se move o
      // mapa.
      if (event.button !== 0) {
        return;
      }

      dragFrom.current = { ...toDrawing(event.clientX, event.clientY, view), view };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [toDrawing, view],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const from = dragFrom.current;

      if (from === null) {
        return;
      }

      const now = toDrawing(event.clientX, event.clientY, from.view);

      setView(
        clampView({
          side: from.view.side,
          x: from.view.x + (from.x - now.x),
          y: from.view.y + (from.y - now.y),
        }),
      );
    },
    [toDrawing],
  );

  const endDrag = useCallback((event: PointerEvent<SVGSVGElement>) => {
    dragFrom.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const zoomed = view.side < MAX_SIDE;

  if (world.size <= 0 || world.cols <= 0) {
    return (
      <div className="flex h-full items-center justify-center border border-border bg-background p-6 text-center text-2xs text-muted">
        O tamanho do mundo deste servidor não é conhecido — sem ele não há como projetar posição
        nenhuma.
      </div>
    );
  }

  // O que o quadrado do desenho representa. Com imagem é a
  // cobertura DELA (maior que o mundo); sem imagem, o mundo puro.
  const span = imageUrl !== null && coverage !== null && coverage > 0 ? coverage : world.size;

  // ####  A GRADE É DO MUNDO, E A IMAGEM É MAIOR QUE ELE  ####
  //
  // Ela precisa cair sobre a área jogável — que é a mesma que o
  // jogo desenha com grade na própria imagem. Esticá-la até as
  // bordas faria duas grades diferentes no mesmo desenho, e a
  // errada seria a nossa.
  const worldOrigin = ((span - world.size) / 2 / span) * SIDE;
  const worldSide = (world.size / span) * SIDE;
  const step = worldSide / world.cols;

  /**
   * O fator que desfaz o zoom.
   *
   * Tudo que precisa manter o tamanho APARENTE — marcador, rótulo,
   * espessura de linha — é multiplicado por ele. Sem isso, um zoom
   * de 20× deixaria um ponto de 6px ocupando um quinto da tela.
   */
  const k = view.side / FULL_VIEW.side;

  // Só quem tem posição vai para o mapa. Quem não tem continua na
  // lista ao lado, e a faixa de aviso explica por quê — sumir do
  // mapa sem explicação seria o pior desfecho.
  const plotted = players.filter(
    (player): player is GamePlayer & { position: { x: number; y: number; z: number } } =>
      player.position !== null,
  );

  return (
    <div className="relative h-full w-full overflow-hidden border border-border bg-background">
      <svg
        ref={svgRef}
        viewBox={`${String(view.x)} ${String(view.y)} ${String(view.side)} ${String(view.side)}`}
        className={cn('h-full w-full touch-none', zoomed ? 'cursor-grab' : 'cursor-default')}
        role="img"
        aria-label={`Mapa do mundo com ${String(plotted.length)} jogador(es)`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <rect x={0} y={0} width={SIDE} height={SIDE} className="fill-surface" />

        {/* ####  A IMAGEM É O MUNDO INTEIRO  ####

            O `world.rendermap` do jogo desenha exatamente a área
            que vai de `-size/2` a `+size/2` nos dois eixos — a
            mesma faixa da projeção. Por isso ela cobre o quadrado
            do desenho sem recorte nem deslocamento, e por isso um
            ponto cai sobre o lugar certo do terreno. */}
        {imageUrl !== null && (
          <image
            href={imageUrl}
            x={0}
            y={0}
            width={SIDE}
            height={SIDE}
            preserveAspectRatio="none"
          />
        )}

        {/* A grade. `crispEdges` porque linha de 1px em SVG
            escalado vira um borrão cinza.

            Sobre a imagem ela fica discreta: o terreno é que
            informa, e a grade só serve para nomear a célula. */}
        <g
          className="stroke-border"
          strokeWidth={1}
          shapeRendering="crispEdges"
          opacity={imageUrl === null ? 1 : 0.35}
        >
          {Array.from({ length: world.cols + 1 }, (_, index) => (
            <line
              key={`v${String(index)}`}
              x1={worldOrigin + index * step}
              y1={worldOrigin}
              x2={worldOrigin + index * step}
              y2={worldOrigin + worldSide}
              opacity={0.5}
            />
          ))}
          {Array.from({ length: world.rows + 1 }, (_, index) => (
            <line
              key={`h${String(index)}`}
              x1={worldOrigin}
              y1={worldOrigin + index * step}
              x2={worldOrigin + worldSide}
              y2={worldOrigin + index * step}
              opacity={0.5}
            />
          ))}
        </g>

        {/* As réguas: letra em cima, número à esquerda. São elas que
            fazem o mapa falar a mesma língua do jogo — "ele está em
            G12" só serve se G12 estiver escrito em algum lugar. */}
        <g className="fill-muted" fontSize={13}>
          {Array.from({ length: world.cols }, (_, index) => (
            <text
              key={`cx${String(index)}`}
              x={worldOrigin + index * step + step / 2}
              y={worldOrigin - 8}
              textAnchor="middle"
            >
              {columnName(index)}
            </text>
          ))}
          {Array.from({ length: world.rows }, (_, index) => (
            <text
              key={`cy${String(index)}`}
              x={worldOrigin - 8}
              y={worldOrigin + index * step + step / 2 + 4}
              textAnchor="end"
            >
              {index}
            </text>
          ))}
        </g>

        {/* A moldura marca o MUNDO, e não a imagem: é ela que diz
            até onde alguém pode andar. O que fica fora é o oceano
            que o jogo desenha de brinde. */}
        <rect
          x={worldOrigin}
          y={worldOrigin}
          width={worldSide}
          height={worldSide}
          className="fill-none stroke-border"
          strokeWidth={2}
        />

        {/* Os jogadores por último: ficam por cima de tudo.

            ####  O MARCADOR NÃO CRESCE COM O ZOOM  ####

            Ele vive no mesmo espaço do desenho, então aproximar 20×
            o deixaria ocupando um quinto da tela. Multiplicar por
            `k` desfaz a escala do enquadramento — o ponto mantém o
            mesmo tamanho APARENTE, que é o que faz dele um
            marcador e não um borrão. */}
        {plotted.map((player) => {
          const { px, py } = project(player.position, span);
          const isSelected = selected === player.steamId;
          const isHovered = hovered === player.steamId;
          const morto = player.isAlive === false;
          const dormindo = player.isSleeping === true;

          return (
            <g
              key={player.steamId}
              transform={`translate(${String(px)} ${String(py)})`}
              className="cursor-pointer"
              onMouseEnter={() => setHovered(player.steamId)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect(player)}
            >
              {/* O alvo de clique é maior que o ponto: um círculo de
                  6px é difícil de acertar com o mouse e impossível
                  no toque. */}
              <circle r={16 * k} className="fill-transparent" />

              {(isSelected || isHovered) && (
                <circle r={11 * k} className="fill-none stroke-foreground" strokeWidth={2 * k} />
              )}

              {/* ####  A FORMA DIZ O ESTADO, E NÃO SÓ A COR  ####

                  Acordado é disco cheio, dormindo é anel, morto é um
                  X. Cor sozinha não fala com quem não separa verde
                  de cinza — a mesma regra do ponto de estado do
                  servidor. */}
              {morto ? (
                <g className="stroke-rust" strokeWidth={3 * k} strokeLinecap="round">
                  <line x1={-6 * k} y1={-6 * k} x2={6 * k} y2={6 * k} />
                  <line x1={-6 * k} y1={6 * k} x2={6 * k} y2={-6 * k} />
                </g>
              ) : dormindo ? (
                <circle r={6 * k} className="fill-background stroke-amber" strokeWidth={3 * k} />
              ) : (
                <circle r={6 * k} className="fill-olive stroke-background" strokeWidth={2 * k} />
              )}

              {/* O nome aparece no hover e na seleção. Todos os
                  nomes o tempo todo viram uma mancha ilegível num
                  servidor cheio. */}
              {(isSelected || isHovered) && (
                <text
                  x={0}
                  y={-18 * k}
                  textAnchor="middle"
                  fontSize={16 * k}
                  className="fill-foreground"
                  style={{ paintOrder: 'stroke', stroke: 'var(--bg)', strokeWidth: 4 * k }}
                >
                  {player.name}
                </text>
              )}

              {/* `<title>` é o tooltip nativo E o nome acessível do
                  ponto para o leitor de tela. */}
              <title>{`${player.name} — ${player.grid ?? EM_DASH}`}</title>
            </g>
          );
        })}
      </svg>

      {/* ####  OS BOTÕES DE ZOOM NÃO SÃO REDUNDANTES  ####

          A roda do mouse resolve para quem tem mouse. Num trackpad
          ela briga com o gesto de rolar a página, e no toque não
          existe — os botões são o caminho que funciona em todos. */}
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <Button
          size="sm"
          variant="outline"
          aria-label="Aproximar"
          onClick={() => {
            const box = svgRef.current?.getBoundingClientRect();

            zoomAt(
              (box?.left ?? 0) + (box?.width ?? 0) / 2,
              (box?.top ?? 0) + (box?.height ?? 0) / 2,
              1 / 1.4,
            );
          }}
        >
          +
        </Button>

        <Button
          size="sm"
          variant="outline"
          aria-label="Afastar"
          onClick={() => {
            const box = svgRef.current?.getBoundingClientRect();

            zoomAt(
              (box?.left ?? 0) + (box?.width ?? 0) / 2,
              (box?.top ?? 0) + (box?.height ?? 0) / 2,
              1.4,
            );
          }}
        >
          −
        </Button>

        {/* Só aparece quando há o que desfazer: um botão de
            "reenquadrar" com o mapa já inteiro na tela é ruído. */}
        {zoomed && (
          <Button
            size="sm"
            variant="outline"
            aria-label="Ver o mapa inteiro"
            onClick={() => setView(FULL_VIEW)}
          >
            ⤢
          </Button>
        )}
      </div>

      {/* A legenda fica SOBRE o mapa, no canto: ela é consultada uma
          vez e viraria ruído ocupando uma linha própria. */}
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-3 border border-border bg-surface/90 px-2 py-1 text-2xs text-muted">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-olive" />
          acordado
        </span>
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full border-2 border-amber bg-background"
          />
          dormindo
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="text-rust">
            ✕
          </span>
          morto
        </span>
        <span className="tabular-nums">{world.size} m</span>
      </div>
    </div>
  );
}
