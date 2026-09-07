// ============================================================
//  betterloot-chance.ts  -  peso, probabilidade e a prévia.
//
//  ####  O ADMIN NÃO DIGITA PESO NENHUM, E ESSE É O PROBLEMA  ####
//
//  Foi medido no `LootTables.json` real: uma entrada de
//  `Ungrouped Items` tem `Item Minimum`, `Item Maximum`, skin, nome
//  e duplicata — e NENHUM campo de probabilidade. As 6.824 entradas
//  do server01 são assim.
//
//  Quem decide a chance é a RARIDADE DO ITEM NO JOGO. O plugin
//  separa os itens da caixa em cinco baldes por `ItemDefinition
//  .rarity` (BetterLoot.cs:2250) e dá a cada balde um peso fixo:
//
//      ItemWeight(2, i) = (int)(2^(4 - i) * 1000)   (:1657, :84)
//
//  que é [16000, 8000, 4000, 2000, 1000] para i = 0..4. O peso do
//  balde é multiplicado pela QUANTIDADE de itens dentro dele
//  (:2270), o sorteio escolhe um balde por peso, e dentro do balde
//  escolhe um item por sorteio uniforme (:2882-2891).
//
//  Cancelando a contagem dos dois lados, sobra a conta que esta
//  tela mostra:
//
//      P(item) = W(raridade do item) / Σ_i (W(i) × n_i)
//
//  ####  POR QUE ISSO PRECISA APARECER AO LADO  ####
//
//  Porque a consequência é a menos óbvia que existe numa tela de
//  loot: ACRESCENTAR UM ITEM MUDA A CHANCE DE TODOS OS OUTROS. O
//  denominador cresce, e a linha que o admin não tocou passa a sair
//  menos — sem aviso, sem erro, e sem nada na tela que o diga.
//
//  Um editor que mostrasse só min/máx deixaria o admin "ajustando"
//  uma caixa e desregulando as outras 144 entradas dela a cada
//  item novo.
//
//  ####  O MODO PLANO EXISTE E MUDA A CONTA INTEIRA  ####
//
//  `Select ungrouped items ignoring rarity bias` (:2441) troca o
//  sorteio por `UngroupedFlatSelect`, que é uniforme entre as
//  entradas — P = 1/N para todo mundo, raridade nenhuma. É um
//  interruptor por caixa, e ele muda o significado da coluna de
//  porcentagem. Por isso a conta recebe o interruptor, e não uma
//  suposição.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React: é a parte que `panel/test/betterloot-chance.test.ts`
//  alcança. Errar a conta aqui não quebra tela nenhuma — produz uma
//  porcentagem confiante e errada, que é pior.
// ============================================================

import type { BetterLootEntry, BetterLootGlobals, BetterLootTable } from '@/lib/api';

/**
 * O peso de cada balde de raridade, medido.
 *
 * `BASE_ITEM_RARITY = 2` (BetterLoot.cs:84) e
 * `ItemWeight(base, i) = (int)(Math.Pow(base, 4 - i) * 1000)`
 * (:1657). O índice 0 é o item MAIS comum do jogo e pesa 16 vezes
 * mais que o índice 4.
 */
export const RARITY_WEIGHTS: readonly number[] = [16000, 8000, 4000, 2000, 1000];

/**
 * Como o jogo chama cada índice.
 *
 * ####  ISTO É RÓTULO, E A CONTA NÃO DEPENDE DELE  ####
 *
 * O que foi medido no fonte do plugin é o ÍNDICE (`(int)def.rarity`)
 * e o peso que ele recebe. Os nomes vêm do enum `ItemDefinition
 * .Rarity` do jogo e são conferidos, não medidos — por isso a tela
 * mostra o número ao lado, do mesmo jeito que mostra o prefab ao
 * lado do apelido: se o nome estiver errado, o número desmente.
 */
export const RARITY_LABELS: readonly string[] = [
  'Comuníssimo',
  'Comum',
  'Incomum',
  'Raro',
  'Raríssimo',
];

/** O teto do jogo por caixa: `Math.Clamp(..., 1, 36)` (:2349). */
export const MAX_ITEMS_PER_CONTAINER = 36;

/** O rótulo de uma raridade. Fora da faixa, o número cru — nunca um chute. */
export function rarityLabel(rarity: number | null): string {
  if (rarity === null) {
    return '—';
  }

  return RARITY_LABELS[rarity] ?? `raridade ${String(rarity)}`;
}

/** O peso de uma raridade. `null` fora da faixa: o item não entra na conta. */
export function weightOfRarity(rarity: number | null): number | null {
  if (rarity === null) {
    return null;
  }

  return RARITY_WEIGHTS[rarity] ?? null;
}

/**
 * A fatia de cada entrada no sorteio parelho: `1/N`.
 *
 * ####  A CONTA É UMA SÓ, E O DENOMINADOR MUDA DE LUGAR  ####
 *
 * Três telas fazem esta divisão com números diferentes: a lista da
 * caixa aberta divide por `items.length`, a coluna que projeta o
 * item novo divide por `items.length + 1`, e a tabela de chances
 * divide pelo tamanho que recebeu. Escrever a divisão em cada uma
 * foi o que produziu um guarda de zero copiado para onde ele não
 * cabia — numa caixa vazia o "com mais um item" vale 100 %, e a
 * tela chegou a mostrar travessão.
 *
 * `null` só quando não há por quem dividir: zero não é uma fatia, é
 * a ausência dela.
 */
export function flatShareOf(count: number): number | null {
  return count <= 0 ? null : 1 / count;
}

/**
 * O multiplicador global como o admin lê.
 *
 * ####  O TRAVESSÃO NÃO LEVA SUFIXO  ####
 *
 * Montar `${valor}×` com o travessão dentro produz "—×", que se lê
 * como um número que não carregou — pior que o vazio, porque parece
 * defeito de tela em vez de dado ausente. O `×` só existe quando há
 * um número na frente dele.
 */
export function formatMultiplier(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return `${value.toLocaleString('pt-BR')}×`;
}

/** A chance de UMA entrada, e por que ela não pôde ser calculada. */
export interface EntryChance {
  readonly key: string;
  /**
   * O peso que aquela entrada tem no sorteio.
   *
   * `null` quando a raridade do item é desconhecida — ver
   * `unknownRarity` abaixo.
   */
  readonly weight: number | null;
  /**
   * A fatia dela, de 0 a 1, por sorteio de item solto.
   *
   * `null` é "não dá para dizer", e NUNCA zero: zero se lê como
   * "este item não sai", que é uma afirmação que a tela não tem
   * como fazer.
   */
  readonly probability: number | null;
}

export interface ChanceTable {
  readonly entries: readonly EntryChance[];
  /** A soma dos pesos — o denominador. `null` no modo plano. */
  readonly totalWeight: number | null;
  /**
   * Quantas entradas ficaram sem raridade.
   *
   * Enquanto for maior que zero, o denominador está INCOMPLETO e
   * toda porcentagem da tabela é otimista. A tela precisa dizer
   * isso em voz alta em vez de mostrar números que parecem prontos.
   */
  readonly unknownRarity: number;
  /** O sorteio é uniforme (o interruptor de "ignorar raridade"). */
  readonly flat: boolean;
}

/**
 * A chance de cada entrada de itens soltos.
 *
 * No modo enviesado, um item sem raridade conhecida sai da conta
 * inteira — dele E do denominador. Chutar uma raridade seria
 * inventar um peso; contá-lo como zero seria dizer que ele não sai.
 */
export function chancesOf(
  entries: readonly BetterLootEntry[],
  options: { readonly flat: boolean },
): ChanceTable {
  if (options.flat) {
    const share = flatShareOf(entries.length);

    return {
      entries: entries.map((entry) => ({
        key: entry.key,
        weight: null,
        probability: share,
      })),
      totalWeight: null,
      unknownRarity: 0,
      flat: true,
    };
  }

  const weights = entries.map((entry) => weightOfRarity(entry.rarity));
  const totalWeight = weights.reduce((sum: number, weight) => sum + (weight ?? 0), 0);
  const unknownRarity = weights.filter((weight) => weight === null).length;

  return {
    entries: entries.map((entry, index) => {
      const weight = weights[index] ?? null;

      return {
        key: entry.key,
        weight,
        probability: weight === null || totalWeight <= 0 ? null : weight / totalWeight,
      };
    }),
    totalWeight,
    unknownRarity,
    flat: false,
  };
}

/**
 * Quantos sorteios de item SOLTO uma caixa faz.
 *
 * O laço de população começa no número de itens garantidos quando
 * eles contam para o total (`:2390`), e em zero quando não contam.
 * O total é limitado a 36 pelo próprio jogo (`:2349`), e é por isso
 * que um `Maximum Amount of Items` acima disso não faz nada — a
 * tela avisa em vez de deixar o admin digitar 60 e esperar 60.
 */
export function ungroupedRollsOf(table: BetterLootTable): number {
  const settings = table.itemSettings;
  const low = Math.min(settings.minItems, settings.maxItems);
  const high = Math.max(settings.minItems, settings.maxItems);
  const average = (clampItems(low) + clampItems(high)) / 2;
  const guaranteed = settings.guaranteedItemsCountToTotal ? table.guaranteed.length : 0;

  return Math.max(0, average - guaranteed);
}

function clampItems(value: number): number {
  return Math.min(Math.max(value, 1), MAX_ITEMS_PER_CONTAINER);
}

/** Uma linha da prévia: um item e quantos saem em N aberturas. */
export interface PreviewLine {
  /**
   * A identidade da LINHA, e não a da entrada.
   *
   * ####  GARANTIDO E SOLTO SÃO DOIS DICIONÁRIOS  ####
   *
   * `Guaranteed Items` e `Ungrouped Items` são chaveados
   * separadamente no arquivo do BetterLoot: o mesmo scrap pode estar
   * nos dois, com a MESMA `key`. Sem o prefixo, as duas linhas
   * chegariam ao `.map` da prévia com a chave repetida, e o React
   * reconciliaria o nó errado — a linha do garantido passaria a
   * mostrar o número do solto.
   */
  readonly key: string;
  readonly shortname: string;
  readonly label: string;
  readonly skinId: string;
  /** Sai sempre, sem sorteio. */
  readonly guaranteed: boolean;
  /**
   * Em quantas das N caixas este item aparece pelo menos uma vez.
   *
   * `null` quando a chance é desconhecida. É o número que o admin
   * lê primeiro — "sai em 3 de 100" diz mais que "0,7 por caixa".
   */
  readonly containers: number | null;
  /** Quantas UNIDADES saem no total, já com o multiplicador. */
  readonly units: number | null;
}

export interface Preview {
  readonly opens: number;
  readonly lines: readonly PreviewLine[];
  /** Quantos itens soltos a caixa sorteia, em média. */
  readonly rolls: number;
  /** Scrap total nas N aberturas, já multiplicado. `null` = a caixa não dá. */
  readonly scrap: number | null;
  /** Quantas entradas ficaram de fora por raridade desconhecida. */
  readonly unknownRarity: number;
  /**
   * O multiplicador do servidor não veio.
   *
   * ####  1× É UM CHUTE, E ELE PARECE UM DADO  ####
   *
   * O mesmo motivo do `unknownRarity`: sem o `BetterLoot.json` a
   * tela não sabe se o servidor está em 1× ou em 5×, e assumir o
   * primeiro faria a coluna de unidades mostrar um quinto do que
   * sai — com a cara de número pronto. Enquanto isto for verdade, as
   * UNIDADES ficam com travessão e a tela diz por quê.
   *
   * A coluna "em quantas caixas" não depende dele e continua valendo:
   * o multiplicador mexe na quantidade, nunca na chance.
   */
  readonly unknownMultiplier: boolean;
  readonly flat: boolean;
}

/**
 * "Abrindo N caixas dessas, sai isto."
 *
 * ####  É ARITMÉTICA, E A TELA PRECISA DIZER QUE É  ####
 *
 * Não é uma simulação do motor: reproduzir o sorteio do BetterLoot
 * exigiria o `ProbalisticRNG`, o `MightyRNG`, o `UngroupedFlatSelect`
 * e o loot pool locking dentro do painel — reescrever o motor para
 * prever o motor.
 *
 * O que ela é: o VALOR ESPERADO de cada entrada, que é exato
 * quando a caixa não usa grupos (e nenhuma das 111 do server01
 * usa: `Loot Profiles` vem `[]` em todas). Onde ela aproxima:
 *
 *   · a rejeição de duplicata (`Allow Duplicates`) faz o plugin
 *     sortear de novo, o que empurra um pouco de massa para os
 *     outros itens — o desvio é pequeno com 145 entradas e 8
 *     sorteios, e cresce quando a caixa tem poucos itens;
 *   · a conversão em blueprint troca o item por um projeto dele em
 *     parte das vezes (`Blueprint Weight`, 0,11 por padrão);
 *   · um `Loot Profile` associado rouba sorteios dos itens soltos.
 *
 * As três estão declaradas na tela, e não só aqui.
 */
export function previewOf(
  table: BetterLootTable,
  globals: BetterLootGlobals | null,
  opens: number,
  labelOfEntry: (entry: BetterLootEntry) => string,
): Preview {
  const chances = chancesOf(table.items, { flat: table.ignoreRarityBias });
  const rolls = ungroupedRollsOf(table);
  // `null`, e não 1: sem o arquivo global a tela não sabe o
  // multiplicador, e o 1 sairia daqui com cara de medido — ver
  // `unknownMultiplier`.
  const lootMultiplier = globals?.lootMultiplier ?? null;
  const scrapMultiplier = globals?.scrapMultiplier ?? null;

  const lines: PreviewLine[] = [];

  // Os garantidos primeiro, e sem sorteio: eles saem em TODAS as
  // caixas. E sem o multiplicador — medido em `:2557`, que chama
  // `CreateByName(name, GetRNG(min, max), skin)` sem multiplicar,
  // ao contrário do item solto em `:2815`.
  for (const entry of table.guaranteed) {
    lines.push({
      key: `guaranteed:${entry.key}`,
      shortname: entry.shortname,
      label: entry.customName ?? entry.displayName ?? entry.shortname,
      skinId: entry.skinId,
      guaranteed: true,
      containers: opens,
      units: opens * averageAmount(entry.min, entry.max),
    });
  }

  for (const entry of table.items) {
    const chance = chances.entries.find((candidate) => candidate.key === entry.key);
    const probability = chance?.probability ?? null;

    if (probability === null) {
      lines.push({
        key: `item:${entry.key}`,
        shortname: entry.shortname,
        label: labelOfEntry(entry),
        skinId: entry.skinId,
        guaranteed: false,
        containers: null,
        units: null,
      });

      continue;
    }

    // Em quantas caixas ele aparece pelo menos uma vez. Somar as
    // chances dos sorteios daria mais de 100 % num item comum de
    // caixa grande — o complemento do "nunca sair" não dá.
    const appears = 1 - Math.pow(1 - probability, rolls);

    lines.push({
      key: `item:${entry.key}`,
      shortname: entry.shortname,
      label: labelOfEntry(entry),
      skinId: entry.skinId,
      guaranteed: false,
      containers: opens * appears,
      units:
        lootMultiplier === null
          ? null
          : opens * rolls * probability * averageAmount(entry.min, entry.max) * lootMultiplier,
    });
  }

  const scrap = averageAmount(table.itemSettings.minScrap, table.itemSettings.maxScrap);

  return {
    opens,
    lines: lines.sort(byExpectation),
    rolls,
    scrap: scrap === 0 || scrapMultiplier === null ? null : opens * scrap * scrapMultiplier,
    unknownRarity: chances.unknownRarity,
    unknownMultiplier: globals === null,
    flat: chances.flat,
  };
}

/** A média de uma faixa, com os extremos trocados se vierem ao contrário. */
function averageAmount(min: number, max: number): number {
  return (Math.min(min, max) + Math.max(min, max)) / 2;
}

/**
 * O que sai mais, em cima.
 *
 * Garantido antes de sorteado: ele sai sempre, e ler a lista de
 * cima para baixo é ler da certeza para a raridade. O item sem
 * chance conhecida vai para o fim — ele não é raro, é indefinido, e
 * misturá-lo com os raros faria parecer que a tela sabe.
 */
function byExpectation(left: PreviewLine, right: PreviewLine): number {
  if (left.guaranteed !== right.guaranteed) {
    return left.guaranteed ? -1 : 1;
  }

  if (left.containers === null || right.containers === null) {
    if (left.containers === right.containers) {
      return left.label.localeCompare(right.label, 'pt-BR');
    }

    return left.containers === null ? 1 : -1;
  }

  return right.containers - left.containers;
}

/**
 * A porcentagem como o admin lê.
 *
 * ####  UMA CHANCE DE 1/5000 NÃO PODE VIRAR "0,0 %"  ####
 *
 * É exatamente a ordem de grandeza que um item raro tem, e
 * arredondar para uma casa a transformaria em zero — a tela diria
 * que o item nunca sai. Por isso as casas crescem conforme o número
 * encolhe, até "1 em N", que é como se fala de raridade.
 */
export function formatChance(probability: number | null): string {
  if (probability === null) {
    return '—';
  }

  if (probability <= 0) {
    return '0 %';
  }

  const percent = probability * 100;

  // Abaixo de 0,1 % a porcentagem para de comunicar: o admin lê
  // "0,020 %" e não sente a diferença para "0,002 %". "1 em 5.000"
  // é como se fala de raridade, e é o número que ele consegue
  // comparar com o próprio servidor.
  if (percent < 0.1) {
    return `1 em ${Math.round(1 / probability).toLocaleString('pt-BR')}`;
  }

  // Vírgula decimal: é texto de tela, e em português "50.0" se lê
  // como cinquenta mil na primeira olhada.
  const digits = percent >= 10 ? 1 : percent >= 1 ? 2 : 3;

  return `${percent.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} %`;
}

/** Uma contagem de prévia. Menos de meia unidade vira "menos de 1". */
export function formatCount(value: number | null): string {
  if (value === null) {
    return '—';
  }

  if (value === 0) {
    return '0';
  }

  if (value < 0.5) {
    return '< 1';
  }

  return Math.round(value).toLocaleString('pt-BR');
}
