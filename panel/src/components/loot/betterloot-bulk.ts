// ============================================================
//  betterloot-bulk.ts  -  multiplicar a quantidade de todos os
//  itens de UMA caixa.
//
//  ####  ISTO NÃO É O MULTIPLICADOR GLOBAL COM OUTRO NOME  ####
//
//  O global (`Loot Multiplier`) é um número no
//  `oxide/config/BetterLoot.json` que vale para os 111 contêineres
//  e pode ser desfeito voltando-o a 1. Isto aqui REESCREVE o `Item
//  Minimum`/`Item Maximum` de cada entrada da caixa aberta: depois
//  de gravado, não existe "voltar a 1x" — o valor antigo não está
//  guardado em lugar nenhum a não ser no backup do arquivo.
//
//  É a mesma operação que o Looty chama de `Apply Multiplier to
//  All Items`, e é por isso que a tela mostra o resultado ANTES de
//  aplicar, e não uma confirmação genérica.
//
//  ####  E ELE NÃO MUDA QUANTOS ITENS A CAIXA ENTREGA  ####
//
//  Quem decide isso é `Minimum/Maximum Amount of Items`, que o
//  jogo corta em 36 (`Math.Clamp(..., 1, 36)`, BetterLoot.cs:2349).
//  Multiplicar as quantidades não chega perto desse teto — e dizer
//  isso na tela é o que impede o admin de aplicar 10x esperando
//  dez vezes mais ITENS e não entender o resultado.
//
//  ####  ZERO CONTINUA ZERO, E UM NUNCA VIRA ZERO  ####
//
//  Uma entrada com `Item Minimum: 0` é "pode não vir nenhum", e
//  multiplicá-la mantém isso — 0 × 5 é 0 em qualquer aritmética.
//
//  O contrário é a armadilha: com fator 0,5, um mínimo de 1
//  arredondaria para 0 e a entrada passaria a poder sair vazia.
//  Isso não é reduzir a quantidade pela metade, é mudar a natureza
//  da entrada — e em silêncio, no meio de 145 linhas. O piso de 1
//  para quem já era 1 ou mais existe por isso.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React: é a parte que `panel/test/betterloot-bulk.test.ts`
//  alcança. Uma tela errada se vê; uma conta errada aqui reescreve
//  145 entradas de um servidor de produção.
// ============================================================

import type {
  BetterLootEntry,
  BetterLootGuaranteedEntry,
  BetterLootTable,
} from '@/lib/api';

/** Os atalhos do menu da caixa. */
export const BULK_SHORTCUTS: readonly number[] = [2, 5, 10];

/** Menos que isto não é reduzir, é apagar. */
export const MIN_BULK_FACTOR = 0.1;

/**
 * O teto do fator.
 *
 * Não vem do plugin — ele não tem teto. Vem de que 100× numa caixa
 * de 145 entradas é a diferença entre um servidor generoso e um
 * arquivo que ninguém vai querer conferir linha a linha depois.
 */
export const MAX_BULK_FACTOR = 100;

/** A faixa agregada de uma lista de entradas. */
export interface AmountRange {
  /** O menor mínimo da caixa. */
  readonly min: number;
  /** O maior máximo da caixa. */
  readonly max: number;
}

/** O que a multiplicação faria — antes de ela acontecer. */
export interface BulkMultiplyOutcome {
  readonly factor: number;
  /** Quantos itens soltos são atingidos. */
  readonly items: number;
  /** Quantos garantidos são atingidos. */
  readonly guaranteed: number;
  /** Quantas entradas mudam de valor de fato. */
  readonly changed: number;
  /**
   * A faixa de antes e a de depois, considerando as duas listas.
   *
   * `null` quando não há entrada nenhuma: uma faixa "de 0 a 0" numa
   * caixa vazia se leria como um dado, e não como a ausência dele.
   */
  readonly before: AmountRange | null;
  readonly after: AmountRange | null;
  /** A caixa já com tudo aplicado. */
  readonly table: BetterLootTable;
}

/**
 * Uma quantidade multiplicada.
 *
 * Zero fica zero; o que era pelo menos 1 nunca desce a zero. Ver o
 * cabeçalho — as duas regras existem por motivos diferentes.
 */
export function scaleAmount(value: number, factor: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(value * factor));
}

/** A faixa agregada, ou `null` se não houver entrada. */
export function rangeOf(
  entries: readonly { readonly min: number; readonly max: number }[],
): AmountRange | null {
  if (entries.length === 0) {
    return null;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    min = Math.min(min, entry.min);
    max = Math.max(max, entry.max);
  }

  return { min, max };
}

/**
 * A caixa com todas as quantidades multiplicadas, e o resumo do
 * que muda.
 *
 * ####  OS GARANTIDOS ENTRAM JUNTO  ####
 *
 * Eles são `Guaranteed Items` — o que sai em toda caixa, sem
 * sorteio. Deixá-los de fora faria "2x nesta caixa" dobrar o que é
 * sorteado e não dobrar o que é certo, e o admin descobriria isso
 * comparando dois números na tela.
 *
 * ####  O QUE NÃO ENTRA, E É DE PROPÓSITO  ####
 *
 * O scrap da caixa (`Minimum/Maximum Scrap Amount`) fica de fora:
 * ele é UM par de campos, visível e editável a dois cliques logo
 * acima. O problema de escala que justifica a edição em massa —
 * 145 linhas — não existe para ele, e incluí-lo faria "multiplicar
 * os itens" mexer num número que o admin não estava olhando.
 */
export function multiplyAmounts(table: BetterLootTable, factor: number): BulkMultiplyOutcome {
  const items: BetterLootEntry[] = table.items.map((entry) => ({
    ...entry,
    min: scaleAmount(entry.min, factor),
    max: scaleAmount(entry.max, factor),
  }));

  const guaranteed: BetterLootGuaranteedEntry[] = table.guaranteed.map((entry) => ({
    ...entry,
    min: scaleAmount(entry.min, factor),
    max: scaleAmount(entry.max, factor),
  }));

  const before = [...table.items, ...table.guaranteed];
  const after = [...items, ...guaranteed];

  let changed = 0;

  for (const [index, entry] of after.entries()) {
    const original = before[index];

    if (original !== undefined && (original.min !== entry.min || original.max !== entry.max)) {
      changed += 1;
    }
  }

  return {
    factor,
    items: items.length,
    guaranteed: guaranteed.length,
    changed,
    before: rangeOf(before),
    after: rangeOf(after),
    table: { ...table, items, guaranteed },
  };
}

/** Uma faixa como o admin lê: "1 a 4", ou "4" quando não há faixa. */
export function formatRange(range: AmountRange | null): string {
  if (range === null) {
    return '—';
  }

  return range.min === range.max
    ? range.min.toLocaleString('pt-BR')
    : `${range.min.toLocaleString('pt-BR')} a ${range.max.toLocaleString('pt-BR')}`;
}

/** O fator como o admin lê: `2×`, `1,5×`. */
export function formatFactor(factor: number): string {
  return `${factor.toLocaleString('pt-BR')}×`;
}
