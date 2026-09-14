// ============================================================
//  ui-inventory.ts  -  o conteúdo de um kit desenhado como o
//  inventário do jogo.
//
//  ####  POR QUE UMA GRADE, E NÃO UMA LISTA  ####
//
//  Uma lista de texto ("128x Munição de Rifle") responde o QUE vem
//  no kit. Ela não responde a pergunta que o jogador faz de
//  verdade antes de resgatar: ONDE isso cai. Um kit com a AK na
//  barra rápida e o colete no corpo é outro kit — e pela lista os
//  dois são idênticos.
//
//  A grade responde as duas de uma vez, porque é o MESMO desenho
//  que ele vê ao apertar TAB: três contêineres, cada um com as
//  suas casinhas, e o item na casinha em que vai nascer.
//
//  ####  SÓ O QUE TEM ITEM É DESENHADO  ####
//
//  O inventário do jogo tem 24 + 6 + 7 casinhas. Desenhar as 37
//  num modal gastaria a altura inteira para mostrar, na maioria
//  dos kits, trinta quadrados vazios.
//
//  Então cada contêiner aparece com as LINHAS que ele usa — e o
//  que não tem item nenhum não aparece. Um kit só de barra rápida
//  desenha uma fileira de seis, e não o inventário inteiro com uma
//  fileira preenchida no meio.
//
//  ####  O CUI NÃO TEM TOOLTIP  ####
//
//  Não há evento de hover no CUI: um `CuiButton` conhece a cor
//  normal e a de mouse em cima, e nada mais. Não existe "mostrar
//  este texto enquanto o cursor está aqui".
//
//  O que dá, e é o que está aqui: a casinha CLICA. A cor muda sob
//  o cursor (é assim que ela se anuncia como clicável) e o clique
//  abre o detalhe do item. Uma casinha sem para onde ir continua
//  sendo um painel morto, pelo mesmo motivo de sempre — clique que
//  não faz nada é o que parece defeito.
// ============================================================

import type { UiElement } from '../types/ui-document.js';
import { C, type Rect, itemImage, label, panel, button } from './ui-widgets.js';

/** Os contêineres do jogador, na ordem em que o inventário os mostra. */
export const INVENTORY_CONTAINERS = ['main', 'wear', 'belt'] as const;

export type InventoryContainer = (typeof INVENTORY_CONTAINERS)[number];

/**
 * Quantas casinhas cada contêiner tem, e em quantas colunas.
 *
 * ####  ESTES NÚMEROS SÃO DO JOGO, NÃO NOSSOS  ####
 *
 * `containerMain` tem 24 casinhas em 6 colunas, `containerBelt` 6
 * numa fileira, `containerWear` 7. Inventar um número diferente
 * aqui faria a tela oferecer uma casinha que o `MoveToContainer`
 * recusa — e o item cairia em outro lugar, sem aviso, depois de o
 * jogador ter visto a promessa na tela.
 */
export const INVENTORY_SHAPE: Readonly<
  Record<InventoryContainer, { readonly capacity: number; readonly columns: number }>
> = {
  main: { capacity: 24, columns: 6 },
  wear: { capacity: 7, columns: 7 },
  belt: { capacity: 6, columns: 6 },
};

/** O nome de cada contêiner na tela. */
export const CONTAINER_LABEL: Readonly<Record<InventoryContainer, string>> = {
  main: 'MOCHILA',
  wear: 'VESTIMENTA',
  belt: 'BARRA RÁPIDA',
};

/** Um item já resolvido: com ícone, nome e casinha. */
export interface InventoryEntry {
  readonly container: InventoryContainer;
  /** A casinha. Negativa = "a primeira que estiver livre". */
  readonly position: number;
  /** `null` = o catálogo não conhece o shortname; a casinha sai vazia. */
  readonly itemId: number | null;
  readonly skinId: string;
  readonly amount: number;
  /** O nome bonito, para o detalhe. */
  readonly name: string;
}

/** O tamanho de uma casinha e o vão entre elas. */
export const CELL = 44;
const GAP = 2;
const STEP = CELL + GAP;

/** A altura do rótulo de um contêiner, mais o vão até a grade. */
const TITLE = 18;

/** O vão entre um bloco de contêiner e o seguinte. */
const BLOCK_GAP = 8;

/**
 * Quantas colunas cabem na largura disponível.
 *
 * O contêiner quer 6 (ou 7, no caso da vestimenta). Num modal
 * estreito não cabem seis de 44 — e espremer a casinha até caber
 * faria o ícone virar um borrão. Então a FILEIRA quebra: seis
 * casinhas em duas fileiras de três continuam legíveis, e
 * continuam dizendo em que contêiner o item está.
 */
function columnsIn(width: number, wanted: number): number {
  const fits = Math.floor((width + GAP) / STEP);

  return Math.max(1, Math.min(wanted, fits));
}

/** Quantas fileiras aquele contêiner precisa para mostrar os itens. */
function rowsFor(
  entries: readonly InventoryEntry[],
  columns: number,
  capacity: number,
): number {
  // A casinha mais distante manda: um item na posição 13 exige as
  // fileiras de 0 a 13, mesmo que as doze do meio estejam vazias —
  // senão o desenho mentiria sobre ONDE ele cai.
  let highest = entries.length - 1;

  for (const entry of entries) {
    if (entry.position >= 0 && entry.position < capacity && entry.position > highest) {
      highest = entry.position;
    }
  }

  // ####  O CONTÊINER NÃO CRESCE PORQUE O KIT PEDIU  ####
  //
  // Treze itens no `belt` dariam três fileiras por esta conta, e a
  // barra rápida tem UMA. Desenhar as três inventaria doze casinhas
  // que não existem no jogo — e o jogador confiaria nelas. O que
  // não coube é contado pelo `placeEntries`, não desenhado aqui.
  const capped = Math.min(highest, capacity - 1);

  return Math.max(1, Math.ceil((capped + 1) / columns));
}

/**
 * Onde cada item mora na grade, resolvendo as posições repetidas e
 * as negativas.
 *
 * ####  O DESENHO PRECISA CONCORDAR COM A ENTREGA  ####
 *
 * O plugin põe o item na casinha pedida; se ela estiver ocupada,
 * na primeira livre. Aqui a "ocupada" é por OUTRO ITEM DO KIT — dois
 * itens do kit na casinha 0 é erro de cadastro, e mostrar um por
 * cima do outro esconderia o segundo.
 *
 * O inventário do jogador na hora do resgate é outra história, e
 * esta tela não tem como sabê-la: ela mostra o kit, não a bagunça
 * de quem vai recebê-lo.
 */
function placeEntries<T extends InventoryEntry>(
  entries: readonly T[],
  capacity: number,
): { readonly taken: ReadonlyMap<number, T>; readonly overflow: number } {
  const taken = new Map<number, T>();
  const floating: T[] = [];

  for (const entry of entries) {
    const wanted = entry.position;

    if (wanted >= 0 && wanted < capacity && !taken.has(wanted)) {
      taken.set(wanted, entry);
      continue;
    }

    floating.push(entry);
  }

  let cursor = 0;
  let overflow = 0;

  for (const entry of floating) {
    while (cursor < capacity && taken.has(cursor)) {
      cursor += 1;
    }

    // ####  MAIS ITENS QUE CASINHAS É UM ESTADO QUE ACONTECE  ####
    //
    // O teto de um kit é MAX_LOADOUT_ITEMS = 60, e a barra rápida
    // tem 6 casinhas. Nada no cadastro impede treze itens no `belt`
    // — e quando isso acontece, o jogo põe os sete que sobram onde
    // couber, exatamente como faria com qualquer outro item sem
    // lugar.
    //
    // O que não pode é o DESENHO engoli-los calados. Quem chama
    // recebe a contagem e escreve "e mais N" — a mesma regra do
    // `itemRows`, e pela mesma razão: o jogador leva um kit achando
    // que ele tem menos do que tem.
    if (cursor >= capacity) {
      overflow += 1;
      continue;
    }

    taken.set(cursor, entry);
    cursor += 1;
  }

  return { taken, overflow };
}

export interface InventoryBlocksOptions<T extends InventoryEntry = InventoryEntry> {
  /** O começo dos ids, para não colidir com outra faixa da tela. */
  readonly prefix: string;
  /** A largura útil, para decidir quantas colunas cabem. */
  readonly width: number;
  /** Quanto o bloco pode ocupar. O que não couber vira "e mais N...". */
  readonly height: number;
  /**
   * Para onde o clique numa casinha leva. Ausente = casinha morta.
   *
   * Ele recebe o ITEM DE QUEM CHAMOU, e não uma cópia enxuta: quem
   * monta o endereço costuma precisar de algo que só existe do lado
   * dele — o índice no kit, o id da oferta — e devolver só os campos
   * da grade obrigaria a procurar o item de novo pelo nome.
   */
  readonly screenIdOf?: ((entry: T) => string) | undefined;
}

export interface InventoryBlocks {
  readonly elements: readonly UiElement[];
  /** A altura de fato usada, para quem precisa empilhar algo embaixo. */
  readonly height: number;
  /**
   * Quantos itens ficaram fora do desenho, por qualquer motivo.
   *
   * São duas causas com o mesmo desfecho para quem olha a tela: o
   * bloco não coube na altura disponível, ou o contêiner não tem
   * casinha livre para ele. Quem chama precisa DIZER o número; qual
   * das duas foi é assunto de quem cadastrou o kit.
   */
  readonly hidden: number;
}

/**
 * Os contêineres empilhados, de cima para baixo, ancorados no TOPO
 * do pai.
 *
 * Devolve a altura usada porque quem chama precisa saber onde
 * continuar — e porque um bloco de altura variável dentro de um
 * modal de altura fixa é exatamente o desenho que produziu a lista
 * atravessando o TOTAL.
 */
export function inventoryBlocks<T extends InventoryEntry>(
  entries: readonly T[],
  options: InventoryBlocksOptions<T>,
): InventoryBlocks {
  const elements: UiElement[] = [];
  let top = 0;
  let hidden = 0;

  for (const container of INVENTORY_CONTAINERS) {
    const mine = entries.filter((entry) => entry.container === container);

    // Contêiner sem item nenhum não aparece: uma grade vazia
    // rotulada "VESTIMENTA" só ocupa altura para dizer "nada aqui".
    if (mine.length === 0) {
      continue;
    }

    const shape = INVENTORY_SHAPE[container];
    const columns = columnsIn(options.width, shape.columns);
    const rows = rowsFor(mine, columns, shape.capacity);
    const needed = TITLE + rows * STEP - GAP;

    // Não cabe mais um bloco inteiro: o resto é contado, nunca
    // cortado em silêncio — a mesma regra do `itemRows`.
    if (top + needed > options.height) {
      hidden += mine.length;
      continue;
    }

    const id = `${options.prefix}${container}`;

    elements.push(
      label(
        `${id}t`,
        CONTAINER_LABEL[container],
        band(top, TITLE - 4),
        { size: 10, color: C.textMuted, align: 'MiddleLeft', font: 'RobotoCondensed-Bold.ttf' },
      ),
    );

    const placed = placeEntries(mine, shape.capacity);

    hidden += placed.overflow;

    for (let index = 0; index < rows * columns; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const entry = placed.taken.get(index) ?? null;

      elements.push(
        cell(
          `${id}c${String(index)}`,
          {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 0, y: 1 },
            offsetMin: { x: column * STEP, y: -(top + TITLE + row * STEP + CELL) },
            offsetMax: { x: column * STEP + CELL, y: -(top + TITLE + row * STEP) },
          },
          entry,
          options.screenIdOf,
        ),
      );
    }

    top += needed + BLOCK_GAP;
  }

  return {
    elements,
    height: top === 0 ? 0 : top - BLOCK_GAP,
    hidden,
  };
}

/** Uma faixa de altura fixa, a tantos pixels do topo do pai. */
function band(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(top + height) },
    offsetMax: { x: 0, y: -top },
  };
}

/**
 * Uma casinha: o fundo, o ícone e a quantidade.
 *
 * A casinha VAZIA também é desenhada. Ela é o que faz a grade se
 * ler como inventário — sem ela, três itens soltos no escuro são
 * três ícones, e o jogador não tem como ver que o quarto lugar da
 * barra está livre.
 */
function cell<T extends InventoryEntry>(
  id: string,
  rect: Rect,
  entry: T | null,
  screenIdOf: ((entry: T) => string) | undefined,
): UiElement {
  if (entry === null) {
    return panel(id, rect, C.bg);
  }

  const inside: UiElement[] = [];

  if (entry.itemId !== null) {
    inside.push(
      itemImage(
        `${id}i`,
        { itemId: entry.itemId, skinId: entry.skinId },
        // Uma margem de 3 px de cada lado: encostado na borda, o
        // ícone lê como um quadrado colorido em vez de um item
        // dentro de uma casinha.
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 3, y: 3 },
          offsetMax: { x: -3, y: -3 },
        },
      ),
    );
  } else {
    // Shortname que o catálogo não conhece. O nome no lugar do
    // ícone é melhor que uma casinha vazia: o item VEM no kit, e
    // uma casinha vazia diria o contrário.
    inside.push(
      label(`${id}u`, entry.name.slice(0, 8), fillCell(), {
        size: 9,
        color: C.textMuted,
      }),
    );
  }

  if (entry.amount > 1) {
    inside.push(
      label(
        `${id}q`,
        `x${formatAmount(entry.amount)}`,
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 0, y: 1 },
          offsetMax: { x: -3, y: 13 },
        },
        // Branco e em negrito porque ela fica SOBRE o ícone: em
        // cinza, sumia contra a metade clara de qualquer arma.
        { size: 10, color: C.white, align: 'MiddleRight', font: 'RobotoCondensed-Bold.ttf' },
      ),
    );
  }

  if (screenIdOf === undefined) {
    return panel(id, rect, C.surface2, inside);
  }

  // O botão vai DENTRO do painel, esticado, e não no lugar dele: o
  // texto de um `CuiButton` preenche o botão inteiro, então um
  // botão com ícone dentro precisaria do ícone como filho — e aí o
  // ícone comeria o clique. Painel com o conteúdo, botão
  // transparente por cima.
  return panel(id, rect, C.surface2, [
    ...inside,
    button(
      `${id}b`,
      '',
      fillCell(),
      { id: `a${id}`, kind: 'modal.open', screenId: screenIdOf(entry) },
      // Transparente por cima do ícone, e só o hover o revela: a
      // casinha continua parecendo uma casinha, e ainda assim se
      // anuncia quando o cursor passa.
      { color: C.none, textColor: C.none, hoverColor: '#FFFFFF22', fontSize: 1 },
    ),
  ]);
}

function fillCell(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: 0, y: 0 },
  };
}

/**
 * A quantidade encurtada.
 *
 * "x12500" não cabe numa casinha de 44 px em corpo 10. Acima de mil
 * ela vira "x12.5k" — o jogador precisa da ORDEM DE GRANDEZA aqui;
 * o número exato está no detalhe, a um clique.
 */
function formatAmount(amount: number): string {
  if (amount < 1000) {
    return String(amount);
  }

  const thousands = amount / 1000;

  return thousands >= 100
    ? `${String(Math.round(thousands))}k`
    : `${thousands.toFixed(1).replace(/\.0$/, '').replace('.', ',')}k`;
}

/**
 * A altura que estes itens PEDEM, sem desenhar nada.
 *
 * Quem monta um modal precisa dela antes de decidir o tamanho da
 * caixa — e medir desenhando e jogando fora seria o mesmo cálculo
 * feito duas vezes.
 */
export function inventoryHeight(entries: readonly InventoryEntry[], width: number): number {
  let total = 0;

  for (const container of INVENTORY_CONTAINERS) {
    const mine = entries.filter((entry) => entry.container === container);

    if (mine.length === 0) {
      continue;
    }

    const shape = INVENTORY_SHAPE[container];
    const columns = columnsIn(width, shape.columns);
    const rows = rowsFor(mine, columns, shape.capacity);

    total += TITLE + rows * STEP - GAP + BLOCK_GAP;
  }

  return total === 0 ? 0 : total - BLOCK_GAP;
}
