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

import { useState } from 'react';

import type { GamePlayer, WorldGrid } from '@/lib/api';
import { EM_DASH } from '@/lib/format';

/** O lado do desenho, em unidades de SVG. */
const SIDE = 1000;

/** A faixa das réguas de letra e número, em volta do mapa. */
const GUTTER = 28;

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
        viewBox={`${String(-GUTTER)} ${String(-GUTTER)} ${String(SIDE + GUTTER * 2)} ${String(
          SIDE + GUTTER * 2,
        )}`}
        className="h-full w-full"
        role="img"
        aria-label={`Mapa do mundo com ${String(plotted.length)} jogador(es)`}
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

        {/* Os jogadores por último: ficam por cima de tudo. */}
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
              <circle r={16} className="fill-transparent" />

              {(isSelected || isHovered) && (
                <circle r={11} className="fill-none stroke-foreground" strokeWidth={2} />
              )}

              {/* ####  A FORMA DIZ O ESTADO, E NÃO SÓ A COR  ####

                  Acordado é disco cheio, dormindo é anel, morto é um
                  X. Cor sozinha não fala com quem não separa verde
                  de cinza — a mesma regra do ponto de estado do
                  servidor. */}
              {morto ? (
                <g className="stroke-rust" strokeWidth={3} strokeLinecap="round">
                  <line x1={-6} y1={-6} x2={6} y2={6} />
                  <line x1={-6} y1={6} x2={6} y2={-6} />
                </g>
              ) : dormindo ? (
                <circle r={6} className="fill-background stroke-amber" strokeWidth={3} />
              ) : (
                <circle r={6} className="fill-olive stroke-background" strokeWidth={2} />
              )}

              {/* O nome aparece no hover e na seleção. Todos os
                  nomes o tempo todo viram uma mancha ilegível num
                  servidor cheio. */}
              {(isSelected || isHovered) && (
                <text
                  x={0}
                  y={-18}
                  textAnchor="middle"
                  fontSize={16}
                  className="fill-foreground"
                  style={{ paintOrder: 'stroke', stroke: 'var(--bg)', strokeWidth: 4 }}
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
