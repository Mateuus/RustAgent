// ============================================================
//  awards.ts  -  quais rankings aceitam ponto CONCEDIDO.
//
//  ####  A PERGUNTA QUE ESTE ARQUIVO RESPONDE  ####
//
//  Uma missão pode pagar "5 pontos em X". Um item custom também
//  (é o Troféu Bleik). Mas nem todo ranking pode receber isso:
//
//      Metal, Pedra, Enxofre, Abates, Mortes   o jogo MEDE
//      Tempo online                            o agente CALCULA
//      K/D                                     é DERIVADO de outros
//
//  Somar cinco pontos à mão em "Metal" seria dizer que o jogador
//  minerou cinco de metal — uma mentira sobre uma medição. No K/D
//  seria pior: ele não tem linha em `player_stats`, e o ponto
//  cairia num lugar que nenhuma tela lê.
//
//  ####  A REGRA CABE EM UMA LINHA, E É POR ISSO QUE ELA MORA
//        NUM ARQUIVO SÓ  ####
//
//  `source === 'item'`. O nome do valor é histórico — ele nasceu
//  com o Troféu Bleik, que era o único jeito de conceder ponto — e
//  o que ele quer dizer hoje é CONCEDIDO: o número não é medido
//  pelo jogo nem calculado pelo agente; alguém o entrega.
//
//  Item e missão concedem no mesmo ranking sem se atrapalhar: o
//  `eventId` de cada um é próprio, e `stat_events` é uma tabela de
//  eventos, não de donos.
//
//  Trocar o nome do valor custaria uma migração, uma mudança no
//  CHECK, e o mesmo valor viajando para o site — enquanto o que
//  muda de verdade é o RÓTULO que o admin lê. Se um dia a
//  separação for necessária (um ranking que aceita item e recusa
//  missão), é esta função que vira duas.
//
//  Ver Docs/Ranking/20-PLANO-E-CONTRATOS.md §4.
// ============================================================

import type { RankingSource } from '../db/rankings-repository.js';

/** O mínimo que se precisa saber de um ranking para decidir. */
export interface AwardableRanking {
  readonly source: RankingSource;
  readonly enabled: boolean;
}

/**
 * Este ranking aceita ponto concedido por missão ou item?
 *
 * Desligado NÃO aceita: o número continuaria somando numa lista
 * que sumiu de todas as telas, e o admin só descobriria ao religar
 * o ranking meses depois, com pontos de origem esquecida.
 */
export function acceptsAwardedPoints(ranking: AwardableRanking): boolean {
  return ranking.enabled && ranking.source === 'item';
}

/**
 * Por que este ranking não serve de destino. `null` = ele serve.
 *
 * A frase é a que o admin lê no painel, e ela diz o MOTIVO — "não
 * pode" sem motivo faria ele tentar o próximo da lista até acertar
 * por eliminação.
 */
export function whyNotAwardable(input: {
  readonly label: string;
  readonly source: RankingSource;
  readonly enabled: boolean;
}): string | null {
  if (acceptsAwardedPoints(input)) {
    return null;
  }

  if (!input.enabled) {
    return `O ranking "${input.label}" está desligado.`;
  }

  switch (input.source) {
    case 'plugin':
      return `"${input.label}" é medido pelo jogo, e não aceita pontos dados por missão. Use um ranking de pontos.`;
    case 'agent':
      return `"${input.label}" é calculado pelo agente, e não aceita pontos dados por missão. Use um ranking de pontos.`;
    case 'computed':
      return `"${input.label}" é derivado de outros rankings e não tem onde guardar ponto. Use um ranking de pontos.`;
    case 'item':
      // Inalcançável: `acceptsAwardedPoints` já teria dito que sim.
      // O `case` existe para o compilador cobrar o dia em que um
      // valor novo entrar no `RankingSource`.
      return null;
  }
}
