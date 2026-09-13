// ============================================================
//  rotation-queue.ts  -  a fila do rodízio, na tela.
//
//  Duas contas, e as duas são de ORDEM — o tipo de coisa que erra
//  em silêncio: a tela mostra uma sequência bonita e o chat sai em
//  outra. Fora do componente para poder ser testada sem montar
//  React, como o `reorder` dos rankings.
//
//  ------------------------------------------------------------
//  ####  A CONTA DA "PRÓXIMA" É A MESMA DO AGENTE  ####
//
//  Ela repete a regra de `core/src/messages/rotation.ts`: a
//  próxima é a que vem DEPOIS da última que saiu, dando a volta no
//  fim, e sobre a fila das LIGADAS. Duplicar uma regra é dívida —
//  e aqui ela se paga: a alternativa é o admin clicar em "testar"
//  para descobrir qual sai agora, o que manda uma frase de verdade
//  para o servidor só para responder uma pergunta da tela.
//
//  Quando as duas divergirem, quem manda é o agente: ele é quem
//  fala. A tela só erra o rótulo.
// ============================================================

import type { Message, MessageGroup } from '@/lib/api';

/**
 * As mensagens daquele grupo, na ordem da fila.
 *
 * A ordem é a `position`, a mesma da lista geral — e reordenar
 * dentro do grupo só redistribui as posições ENTRE os membros
 * dele, sem mexer em quem é de fora.
 */
export function membersOf(messages: readonly Message[], groupId: number): Message[] {
  return messages
    .filter((message) => message.trigger === 'rotation' && message.groupId === groupId)
    .sort((a, b) => a.position - b.position);
}

/**
 * É esta a próxima da fila, na ordem fixa?
 *
 * `ligadas` é a fila que realmente sai: a desligada é PULADA, e
 * não "o grupo fica mudo na vez dela".
 *
 * Com a última que saiu fora da fila (apagada, desligada, movida
 * de grupo), o ciclo recomeça pela primeira — é o mesmo desfecho
 * do agente, e o único que não exige adivinhar onde ela estava.
 */
export function isNextInLine(
  group: Pick<MessageGroup, 'lastMessageId'>,
  ligadas: readonly Message[],
  message: Message,
): boolean {
  if (ligadas.length === 0 || !message.enabled) {
    return false;
  }

  const previous = ligadas.findIndex((item) => item.id === group.lastMessageId);

  return ligadas[(previous + 1) % ligadas.length]?.id === message.id;
}

/**
 * A fila com uma mensagem movida um degrau.
 *
 * Devolve a lista INTEIRA de ids, e não "suba esta": com duas
 * telas abertas, um "mova para cima" de cada uma produz uma ordem
 * que ninguém pediu. É a mesma disciplina do `reorder` da lista
 * geral e da fila de mapas.
 *
 * Movimento impossível (a primeira subindo, a última descendo)
 * devolve a ordem como está — e não um erro: o botão já vem
 * desabilitado, e quem chega aqui de outro jeito não deve quebrar
 * a tela.
 */
export function moveInQueue(
  queue: readonly Message[],
  id: number,
  delta: number,
): number[] {
  const ids = queue.map((message) => message.id);
  const from = ids.indexOf(id);
  const to = from + delta;

  if (from < 0 || to < 0 || to >= ids.length) {
    return ids;
  }

  const next = [...ids];

  next[from] = ids[to] as number;
  next[to] = id;

  return next;
}
