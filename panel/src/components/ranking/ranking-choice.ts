// ============================================================
//  ranking-choice.ts  -  o que o seletor de ranking DECIDE.
//
//  Separado do componente pela regra do painel: o vitest daqui
//  roda em node puro e não monta React. O que se prova é a
//  decisão, e a decisão cabe em funções.
//
//  Duas delas, e cada uma fecha um buraco diferente:
//
//    awardable()  quais rankings podem RECEBER ponto de missão —
//                 a regra que impediu "5 pontos em Metal"
//    matches()    a busca, que é o que torna a lista usável
//                 quando o servidor tem trinta rankings
//
//  A primeira é a mesma de `core/src/rankings/awards.ts`. Duas
//  cópias de uma regra divergem — e esta aqui é a OFERTA, enquanto
//  a do core é a PORTA: o painel mostrando algo que a API recusa é
//  feio, o contrário seria um buraco. Por isso a porta manda, e o
//  teste de cada lado guarda o seu.
// ============================================================

import type { RankingDefinition } from '@/lib/api';

/** O uso que se está fazendo do ranking. Ver `RankingPicker`. */
export type RankingPickerMode = 'award' | 'read';

/**
 * Este ranking pode RECEBER ponto concedido?
 *
 * `source: 'item'` é o valor que quer dizer "concedido" — ele
 * nasceu com o Troféu Bleik, quando um item custom era o único
 * jeito de dar ponto. O que o jogo mede (`plugin`), o que o agente
 * calcula (`agent`) e o que é derivado (`computed`) ficam de fora:
 * somar à mão num deles é mentir sobre uma medição.
 */
export function isAwardable(ranking: RankingDefinition): boolean {
  return ranking.source === 'item';
}

/** Os rankings que servem para aquele uso, na ordem em que vieram. */
export function eligibleRankings(
  rankings: readonly RankingDefinition[],
  mode: RankingPickerMode,
): readonly RankingDefinition[] {
  // Ler é livre: "chegue a 1.000 de minério" é um objetivo
  // legítimo, e é por isso que os dois modos existem.
  return mode === 'read' ? rankings : rankings.filter(isAwardable);
}

/**
 * A busca: casa pelo nome que se lê e pelo código que se grava.
 *
 * Pelos dois porque os dois aparecem na tela — `Troféu Bleik
 * (trophy.bleik)` —, e quem já conhece a métrica digita ela.
 */
export function matchesRanking(ranking: RankingDefinition, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('pt-BR');

  if (needle === '') {
    return true;
  }

  return (
    ranking.label.toLocaleLowerCase('pt-BR').includes(needle) ||
    ranking.metric.toLocaleLowerCase('pt-BR').includes(needle)
  );
}

export function searchRankings(
  rankings: readonly RankingDefinition[],
  query: string,
): readonly RankingDefinition[] {
  return rankings.filter((ranking) => matchesRanking(ranking, query));
}
