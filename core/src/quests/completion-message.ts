// ============================================================
//  completion-message.ts  -  a frase que o jogador lê quando a
//  missão fecha.
//
//  ####  ELA DEPENDE DO ESTADO DO RESGATE, E NÃO DO CAMINHO  ####
//
//  Medido no server01 em 14/09/2026: o dono entregou os panos na
//  Eira, o balcão concluiu a missão E pagou os 10 OZCoin no mesmo
//  clique — e o chat dizia, no meio das duas coisas:
//
//      Missão concluída: Encomenda de Tecido.
//      Resgate no menu, em MISSÕES, ou fale com Eira.
//      10 OZCoin no seu saldo.
//
//  Mandar o jogador resgatar o que ele acabou de receber. A frase
//  era montada no instante em que o último objetivo fechava, e
//  naquele instante o resgate ainda não tinha acontecido — ele
//  vinha uma linha depois, no mesmo clique.
//
//  Por isso ela mora aqui, longe de quem a dispara: quem chama
//  decide QUANDO perguntar, e a resposta é sempre sobre o estado
//  que existe naquele momento.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §7.1.
// ============================================================

/**
 * Onde a recompensa está quando a frase é escrita.
 *
 *   none     a missão não dá nada — só precisa ser fechada
 *   waiting  tem prêmio, e ele espera o resgate
 *   paid     resgatada, e a entrega saiu inteira
 *   pending  resgatada, mas alguma entrega falhou e virou pendência
 *
 * `pending` não manda ninguém resgatar de novo: o resgate JÁ
 * aconteceu, e clicar outra vez só devolveria "esta quest já foi
 * resgatada". O que aconteceu com a entrega é dito pela mensagem do
 * próprio resgate, que é quem sabe o motivo.
 */
export type QuestRewardState = 'none' | 'waiting' | 'paid' | 'pending';

export interface QuestCompletionMessageInput {
  /** O título do SNAPSHOT: o que ele aceitou, e não o de hoje. */
  readonly title: string;
  /**
   * Onde resgatar, além do menu. `null` = só o menu.
   *
   * Ele só aparece na frase quando há resgate PENDENTE nele —
   * mandar falar com a Eira sobre uma recompensa que já está no
   * bolso é o defeito que este arquivo existe para não repetir.
   */
  readonly npcName: string | null;
  readonly reward: QuestRewardState;
}

export function questCompletionMessage(input: QuestCompletionMessageInput): string {
  const head = `Missão concluída: ${input.title}.`;

  switch (input.reward) {
    case 'paid':
      return `${head} Sua recompensa foi entregue.`;

    // Sem prêmio não há o que resgatar — e prometer resgate numa
    // missão que não dá nada faria o jogador procurar um botão que
    // não vale nada. Mesmo assim ela precisa ser fechada no menu.
    case 'none':
      return `${head} Feche no menu, em MISSÕES.`;

    // A entrega falhou e virou pendência no painel. Nada a fazer
    // pelo jogador, e nada a prometer: o motivo veio na mensagem do
    // resgate, logo antes desta.
    case 'pending':
      return head;

    case 'waiting':
      return input.npcName === null
        ? `${head} Resgate sua recompensa no menu, em MISSÕES.`
        : `${head} Resgate no menu, em MISSÕES, ou fale com ${input.npcName}.`;
  }
}

/**
 * Em que estado o resgate daquela tentativa está.
 *
 * `status` é o da tentativa AGORA — e não o de quando ela fechou.
 * `claim` é o desfecho do resgate que acabou de rodar, quando houve
 * um: sem ele, uma entrega que falhou seria anunciada como entregue.
 */
export function rewardStateOf(input: {
  readonly hasRewards: boolean;
  readonly status: string | null;
  readonly claim?: { readonly pending: boolean } | undefined;
}): QuestRewardState {
  if (!input.hasRewards) {
    return 'none';
  }

  if (input.status !== 'claimed') {
    return 'waiting';
  }

  return input.claim?.pending === true ? 'pending' : 'paid';
}
