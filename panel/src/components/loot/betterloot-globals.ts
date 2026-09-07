// ============================================================
//  betterloot-globals.ts  -  o que vale no servidor inteiro,
//  editável.
//
//  ####  OS MULTIPLICADORES SÃO INTEIROS, E ISSO FOI MEDIDO  ####
//
//  `BetterLoot.cs:174-177`: `public int LootMultiplier = 1` e
//  `public int ScrapMultiplier = 1`. Não é uma escolha de tela — é
//  o tipo do campo no arquivo que outro programa lê.
//
//  Um controle que aceitasse `1,5` seria uma promessa que o
//  servidor não cumpre: o valor iria para um campo `int`, e o que
//  o Newtonsoft faz com um decimal ali não é coisa que a tela possa
//  afirmar. Por isso a normalização arredonda ANTES de o número
//  sair daqui, e o campo mostra o que vai ser gravado.
//
//  ####  O PESO DE BLUEPRINT É O CONTRÁRIO  ####
//
//  `public double BlueprintWeight = 0.11` (`:127`), de 0 a 1. O
//  admin lê "11 %", e o arquivo guarda "0.11". A conversão acontece
//  num ponto só — `toGlobalsInput` —, e não espalhada por cada
//  campo da tela.
//
//  Uma casa decimal na porcentagem, e não zero: 0,115 no arquivo é
//  11,5 %, e arredondar para 12 % gravaria um valor que o admin não
//  pediu só por ele ter aberto a tela.
//
//  ####  ZERO NÃO É UM MULTIPLICADOR  ####
//
//  Ele entra numa MULTIPLICAÇÃO (`:2815`): com zero, todo item de
//  todo container do servidor passa a sair com quantidade zero. Não
//  existe intenção por trás desse número — só o dedo escorregando —,
//  e o piso é 1 aqui e no agente.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React: é a parte que `panel/test/betterloot-globals.test.ts`
//  alcança. Errar aqui não quebra tela nenhuma — grava no servidor
//  do dono um número que ninguém digitou.
// ============================================================

import type { BetterLootGlobals, BetterLootGlobalsInput } from '@/lib/api';

/** Os atalhos do menu, na ordem em que aparecem. */
export const MULTIPLIER_SHORTCUTS: readonly number[] = [2, 5, 10];

/** O piso. Ver o cabeçalho: zero zera o loot do servidor inteiro. */
export const MIN_MULTIPLIER = 1;

/**
 * O teto sanitário — o mesmo do agente.
 *
 * O plugin não tem teto nenhum. Este existe para que um dígito a
 * mais digitado por engano não vire uma caixa com quarenta mil
 * enxofres, que o jogo entrega sem reclamar.
 */
export const MAX_MULTIPLIER = 1_000;

/**
 * O rascunho da faixa de topo.
 *
 * O peso de blueprint mora aqui em PORCENTAGEM porque é o que o
 * admin digita; a tradução para o 0-1 do arquivo é do
 * `toGlobalsInput`.
 */
export interface GlobalsDraft {
  readonly lootMultiplier: number;
  readonly scrapMultiplier: number;
  /** 0 a 100. */
  readonly blueprintPercent: number;
  readonly blueprintConversion: boolean;
}

/** Um multiplicador aceitável: inteiro, dentro da faixa. */
export function normalizeMultiplier(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_MULTIPLIER;
  }

  return Math.min(Math.max(Math.round(value), MIN_MULTIPLIER), MAX_MULTIPLIER);
}

/** Uma porcentagem aceitável de blueprint: 0 a 100, uma casa. */
export function normalizeBlueprintPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(Math.round(value * 10) / 10, 0), 100);
}

/** O rascunho que a tela abre a partir do disco. */
export function draftOfGlobals(globals: BetterLootGlobals | null): GlobalsDraft {
  return {
    lootMultiplier: normalizeMultiplier(globals?.lootMultiplier ?? MIN_MULTIPLIER),
    scrapMultiplier: normalizeMultiplier(globals?.scrapMultiplier ?? MIN_MULTIPLIER),
    blueprintPercent: normalizeBlueprintPercent((globals?.blueprintWeight ?? 0) * 100),
    blueprintConversion: globals?.blueprintConversion ?? false,
  };
}

/**
 * O rascunho como o arquivo o guarda.
 *
 * ####  A FRONTEIRA DA PORCENTAGEM É AQUI, E SÓ AQUI  ####
 *
 * Dividir por 100 em cada lugar que precisa do número é como um
 * arquivo fica com metade em porcentagem e metade em fração — e a
 * partir daí ninguém sabe qual valor está em qual escala.
 *
 * A divisão volta a arredondar em três casas porque `11,5 / 100` em
 * ponto flutuante é `0.11499999999999999`: gravar isso faria o
 * arquivo diferir do que a tela mostra, e a comparação de "mudou?"
 * acusaria alteração num campo que ninguém tocou.
 */
export function toGlobalsInput(draft: GlobalsDraft): BetterLootGlobalsInput {
  return {
    lootMultiplier: normalizeMultiplier(draft.lootMultiplier),
    scrapMultiplier: normalizeMultiplier(draft.scrapMultiplier),
    blueprintWeight: Math.round(normalizeBlueprintPercent(draft.blueprintPercent) * 10) / 1000,
    blueprintConversion: draft.blueprintConversion,
  };
}

/**
 * O rascunho difere do que está no disco?
 *
 * A comparação é feita NA ESCALA DO ARQUIVO, e não na da tela: um
 * peso de 0,1149 no disco vira 11,5 % no campo e volta como 0,115,
 * e comparar as porcentagens diria "igual" para dois arquivos
 * diferentes.
 */
export function globalsDirty(draft: GlobalsDraft, globals: BetterLootGlobals | null): boolean {
  if (globals === null) {
    return false;
  }

  const next = toGlobalsInput(draft);

  return (
    next.lootMultiplier !== globals.lootMultiplier ||
    next.scrapMultiplier !== globals.scrapMultiplier ||
    next.blueprintWeight !== globals.blueprintWeight ||
    next.blueprintConversion !== globals.blueprintConversion
  );
}

/**
 * O peso de blueprint como o admin lê.
 *
 * Sem casas forçadas: 11 % é "11 %", e 11,5 % é "11,5 %". Um
 * "11,0 %" na faixa de topo sugere uma precisão que o campo não
 * tem, e um "12 %" para um arquivo em 0,115 seria mentira.
 */
export function formatBlueprintPercent(weight: number | null): string {
  if (weight === null) {
    return '—';
  }

  return `${(Math.round(weight * 1000) / 10).toLocaleString('pt-BR')} %`;
}
