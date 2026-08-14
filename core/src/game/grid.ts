// ============================================================
//  grid.ts  -  a grade do mapa do Rust, em letra e número.
//
//  `G12` é como jogador e admin falam de posição no Rust — não
//  `(120.5, -840.2)`. Quem pergunta "onde ele está?" no Discord
//  espera a célula do mapa, e é ela que faz a resposta ser útil sem
//  abrir o jogo.
//
//  ------------------------------------------------------------
//  ####  O MUNDO É CENTRADO NA ORIGEM  ####
//
//  `X` e `Z` vão de `-worldSize/2` a `+worldSize/2`. Somar
//  `worldSize/2` é o que traz a coordenada para a faixa `0..size`,
//  que é a do desenho e a da grade.
//
//  ####  E `Y` É ALTURA  ####
//
//  Ele NÃO entra aqui, e não entra no mapa 2D. Usar `(x, y)` é o
//  erro clássico: funciona até alguém subir num prédio, e então o
//  ponto salta para o outro lado do mapa.
//
//  ####  A LINHA CRESCE PARA BAIXO  ####
//
//  `Z` cresce para o NORTE no jogo, e a linha 0 do mapa é a de
//  cima. Por isso a conta da linha é `(size/2 - z)`, e não
//  `(z + size/2)`: sem a inversão o mapa sai espelhado na
//  vertical — e ninguém percebe até comparar com o do jogo.
// ============================================================

/**
 * O lado de uma célula, em unidades do mundo.
 *
 * ####  DE ONDE SAI ESTE NÚMERO  ####
 *
 * É a constante que o próprio jogo usa para desenhar a grade do
 * mapa, e a mesma que os plugins de coordenada da comunidade
 * adotam. Ela NÃO é derivada do `worldSize`: um mundo de 3000 e um
 * de 6000 têm células do mesmo tamanho e quantidades diferentes
 * delas — que é o motivo de a última coluna do mapa do jogo ser
 * sempre mais estreita que as outras.
 *
 * Como conferir, se um dia isso mudar: abra o mapa no jogo (G),
 * ande até a borda de uma célula e compare a letra/número com o que
 * o painel mostra. Divergiu, é este número.
 */
export const GRID_CELL_SIZE = 146.3;

export interface WorldGrid {
  /** O lado do mundo, em unidades. */
  readonly size: number;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
}

export function worldGrid(worldSize: number): WorldGrid {
  const size = Number.isFinite(worldSize) && worldSize > 0 ? worldSize : 0;
  // `ceil`: a última faixa é parcial e continua sendo uma célula —
  // é assim no mapa do jogo, e cortá-la deixaria a borda do mundo
  // sem nome.
  const count = size === 0 ? 0 : Math.ceil(size / GRID_CELL_SIZE);

  return { size, cellSize: GRID_CELL_SIZE, cols: count, rows: count };
}

/**
 * A célula de uma posição: `A0`, `G12`, `AA3`.
 *
 * `null` quando não dá para saber — mundo de tamanho desconhecido,
 * ou coordenada que não é número. Nunca um palpite: uma célula
 * errada manda quem procura para o outro lado do mapa.
 */
export function gridLabel(x: number, z: number, worldSize: number): string | null {
  const grid = worldGrid(worldSize);

  if (grid.cols === 0 || !Number.isFinite(x) || !Number.isFinite(z)) {
    return null;
  }

  const half = grid.size / 2;

  // O clamp existe para quem está FORA do mundo: o Rust deixa um
  // jogador passar da borda (e um admin voando vai longe). Sem ele
  // sairia uma coluna negativa — e `columnName` devolveria vazio,
  // que na tela vira um rótulo sem sentido.
  const col = clamp(Math.floor((x + half) / grid.cellSize), 0, grid.cols - 1);
  const row = clamp(Math.floor((half - z) / grid.cellSize), 0, grid.rows - 1);

  return `${columnName(col)}${String(row)}`;
}

/**
 * `0 -> A`, `25 -> Z`, `26 -> AA`.
 *
 * Um mundo de 6000 tem 42 colunas, então passar do Z não é caso
 * raro: é o padrão nos mapas grandes, e é como o jogo os nomeia.
 */
export function columnName(index: number): string {
  if (index < 0) {
    return '';
  }

  let name = '';
  let remaining = index;

  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);

  return name;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
