// ============================================================
//  rotation.ts  -  de quem é a vez.
//
//  Cálculo PURO: recebe a fila do grupo, o estado do ciclo e uma
//  fonte de aleatoriedade, e devolve QUEM sai agora e o baralho
//  que sobrou. Sem banco, sem RCON, sem relógio próprio — é o que
//  permite provar "cinco frases saem todas antes de qualquer uma
//  repetir" num teste de cinco linhas, e não observando o chat por
//  meia hora.
//
//  ------------------------------------------------------------
//  ####  UMA POR VEZ, E ESSE É O PONTO  ####
//
//  O grupo tem UM intervalo. Quando ele vence, sai UMA mensagem —
//  a próxima da vez. É a diferença entre um rodízio e cinco
//  mensagens com o mesmo intervalo, que é o que o admin monta
//  sozinho hoje e por isso vê as cinco saírem juntas, empilhadas,
//  no mesmo segundo.
//
//  ------------------------------------------------------------
//  ####  A ORDEM FIXA CONTINUA DEPOIS DA ÚLTIMA  ####
//
//  E não num índice guardado. A diferença aparece no dia em que
//  alguém apaga a segunda mensagem de um rodízio de cinco: com o
//  índice, o ciclo pula uma; com "a próxima depois daquela", ele
//  segue. O estado é o ID da última que saiu, e ele sobrevive a
//  qualquer edição da lista.
//
//  Quando a última não está mais na fila (foi apagada, desligada
//  ou trocou de grupo), o ciclo recomeça do começo. É o desfecho
//  certo: a alternativa seria adivinhar onde ela estava.
//
//  ------------------------------------------------------------
//  ####  A ALEATÓRIA É UM BARALHO, E NÃO UM DADO  ####
//
//  Sortear a cada volta parece a mesma coisa e não é. Num grupo de
//  cinco, o dado repete a frase anterior uma vez a cada cinco — e
//  deixa alguma delas sem sair por meia hora, sem nada de errado
//  acontecendo. O baralho distribui TODAS antes de embaralhar de
//  novo, que é o que "aleatório" quer dizer para quem lê o chat.
//
//  E o baralho novo nunca começa pela carta que acabou de sair:
//  sem essa regra, a virada de ciclo é exatamente o ponto em que a
//  repetição consecutiva reaparece.
// ============================================================

import type { MessageView, RotationOrder } from '../types/messages.js';

/** O estado do ciclo de um grupo — o que sobrevive entre as voltas. */
export interface RotationState {
  /** A última mensagem que saiu. `null` = o grupo nunca falou. */
  readonly lastMessageId: number | null;
  /** As que ainda não saíram no ciclo aleatório. */
  readonly deck: readonly number[];
}

/** De quem é a vez, e o que fica para as próximas. */
export interface RotationPick {
  /** O id da mensagem que sai agora. */
  readonly messageId: number;
  /** O baralho DEPOIS de tirar esta carta. Vazio fora do `random`. */
  readonly deck: readonly number[];
}

/**
 * Uma fonte de aleatoriedade injetável.
 *
 * `Math.random` em produção; uma sequência conhecida no teste. Sem
 * isto, "não repete a mesma duas vezes seguidas" só seria testável
 * rodando o embaralhamento mil vezes e torcendo.
 */
export type RandomSource = () => number;

/**
 * Quem sai agora. `null` = a fila está vazia, e nada sai.
 *
 * `queue` são as mensagens LIGADAS do grupo, na ordem da tela —
 * quem desligou uma mensagem do rodízio quis que ela fosse pulada,
 * e não que o grupo ficasse mudo na vez dela.
 */
export function pickNext(
  queue: readonly MessageView[],
  order: RotationOrder,
  state: RotationState,
  random: RandomSource = Math.random,
): RotationPick | null {
  if (queue.length === 0) {
    return null;
  }

  return order === 'random' ? pickRandom(queue, state, random) : pickFixed(queue, state);
}

/**
 * A próxima DEPOIS da última que saiu, dando a volta no fim.
 *
 * Ver o cabeçalho: o estado é o id, e não a posição.
 */
function pickFixed(queue: readonly MessageView[], state: RotationState): RotationPick {
  const previous =
    state.lastMessageId === null
      ? -1
      : queue.findIndex((message) => message.id === state.lastMessageId);

  // `-1` cobre os dois casos que são o mesmo: o grupo nunca falou,
  // e a última que saiu não está mais na fila. Nos dois, a próxima
  // é a primeira — e `(-1 + 1) % n` é 0 sem um `if` a mais.
  const index = (previous + 1) % queue.length;
  // A fila não é vazia (o `pickNext` garantiu), então os dois
  // índices existem. O `??` é para o TypeScript, e não para o
  // caso: um `!` aqui esconderia um defeito futuro em vez de
  // sobreviver a ele.
  const chosen = queue[index] ?? queue[0];

  return { messageId: chosen === undefined ? 0 : chosen.id, deck: [] };
}

/**
 * Uma carta do baralho. Vazio, embaralha tudo de novo.
 *
 * O baralho guardado pode ter ids que saíram da fila (mensagem
 * apagada, desligada, movida de grupo) — eles são descartados aqui,
 * e não na gravação: descartar na gravação exigiria reescrever o
 * baralho de todos os grupos a cada edição de mensagem.
 */
function pickRandom(
  queue: readonly MessageView[],
  state: RotationState,
  random: RandomSource,
): RotationPick {
  const alive = new Set(queue.map((message) => message.id));
  let deck = state.deck.filter((id) => alive.has(id));

  if (deck.length === 0) {
    deck = shuffle(
      queue.map((message) => message.id),
      random,
    );

    // ####  O CICLO NOVO NÃO COMEÇA PELA ÚLTIMA CARTA  ####
    //
    // É a única emenda entre dois baralhos, e é exatamente onde a
    // repetição consecutiva reapareceria. Com uma mensagem só na
    // fila não há o que fazer — e ali repetir é o certo, porque a
    // alternativa é o grupo ficar mudo.
    if (deck.length > 1 && deck[0] === state.lastMessageId) {
      const first = deck[0];
      const second = deck[1];

      if (first !== undefined && second !== undefined) {
        deck = [second, first, ...deck.slice(2)];
      }
    }
  }

  const [chosen, ...rest] = deck;

  if (chosen === undefined) {
    // Inalcançável: `deck` acabou de ser preenchido com a fila, que
    // não é vazia. Mas devolver a primeira é melhor que um `!`.
    const first = queue[0];

    return { messageId: first === undefined ? 0 : first.id, deck: [] };
  }

  return { messageId: chosen, deck: rest };
}

/**
 * Fisher-Yates, com a fonte injetada.
 *
 * Não é `sort(() => random() - 0.5)`: aquele embaralhamento é
 * enviesado (o resultado depende do algoritmo de ordenação) e, com
 * cinco frases, o viés é visível para quem lê o chat todo dia.
 */
export function shuffle(ids: readonly number[], random: RandomSource): number[] {
  const deck = [...ids];

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const here = deck[index];
    const there = deck[swap];

    if (here !== undefined && there !== undefined) {
      deck[index] = there;
      deck[swap] = here;
    }
  }

  return deck;
}

/**
 * "a cada 5 min, em ordem", "a cada 30 min, embaralhado".
 *
 * Mora aqui, e não no painel, pela mesma razão do
 * `describeSchedule`: é a frase que o log do agente também escreve,
 * e duas versões dela divergiriam no primeiro ajuste.
 */
export function describeRotation(group: {
  readonly everySeconds: number;
  readonly order: RotationOrder;
}): string {
  const every = group.everySeconds;
  const rhythm =
    every % 3_600 === 0
      ? `${String(every / 3_600)} h`
      : every % 60 === 0
        ? `${String(every / 60)} min`
        : `${String(every)} s`;

  return `a cada ${rhythm}, ${group.order === 'random' ? 'embaralhado' : 'em ordem'}`;
}
