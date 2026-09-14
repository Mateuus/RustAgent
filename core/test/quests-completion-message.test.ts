// ============================================================
//  quests-completion-message.test.ts
//
//  A frase que fecha a missão. Ela tem UMA regra, e as quatro
//  formas dela saem daqui:
//
//      o que a missão dá, e onde isso está AGORA.
//
//  O defeito de origem (server01, 14/09/2026) foi mandar resgatar
//  o que já estava no bolso — a frase era escrita no instante em
//  que o último objetivo fechava, e o resgate vinha uma linha
//  depois, no mesmo clique.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  questCompletionMessage,
  rewardStateOf,
  type QuestRewardState,
} from '../src/quests/completion-message.js';

const TITLE = 'Encomenda de Tecido';

const say = (reward: QuestRewardState, npcName: string | null = 'Eira'): string =>
  questCompletionMessage({ title: TITLE, npcName, reward });

describe('a frase de conclusão', () => {
  it('a recompensa JÁ entregue não manda resgatar nada', () => {
    // Era isto que o chat dizia, com os 10 OZCoin caindo logo
    // abaixo: "Resgate no menu, em MISSÕES, ou fale com Eira."
    expect(say('paid')).toBe('Missão concluída: Encomenda de Tecido. Sua recompensa foi entregue.');

    // E o nome do NPC não aparece: não há o que buscar com ele.
    expect(say('paid')).not.toContain('Eira');
  });

  it('a recompensa pendente diz onde resgatar, e com quem', () => {
    expect(say('waiting')).toBe(
      'Missão concluída: Encomenda de Tecido. Resgate no menu, em MISSÕES, ou fale com Eira.',
    );
  });

  it('sem NPC de recebimento, só o menu', () => {
    expect(say('waiting', null)).toBe(
      'Missão concluída: Encomenda de Tecido. Resgate sua recompensa no menu, em MISSÕES.',
    );
  });

  it('missão sem prêmio manda fechar, e não resgatar', () => {
    // Prometer resgate numa missão que não dá nada faria o jogador
    // procurar um botão que não vale nada.
    expect(say('none')).toBe('Missão concluída: Encomenda de Tecido. Feche no menu, em MISSÕES.');
  });

  it('a entrega que falhou não manda resgatar de novo', () => {
    // O resgate JÁ aconteceu: clicar outra vez só devolveria "esta
    // quest já foi resgatada". O motivo veio na mensagem do próprio
    // resgate, logo antes desta.
    expect(say('pending')).toBe('Missão concluída: Encomenda de Tecido.');
    expect(say('pending')).not.toContain('Resgate');
  });

  it('o título é o do snapshot, e viaja inteiro', () => {
    expect(
      questCompletionMessage({ title: 'A chave do velho galpão', npcName: null, reward: 'waiting' }),
    ).toContain('A chave do velho galpão');
  });
});

describe('em que estado o resgate está', () => {
  it('missão sem prêmio nenhum', () => {
    expect(rewardStateOf({ hasRewards: false, status: 'completed' })).toBe('none');
    // Nem depois de resgatada: não havia o que entregar.
    expect(rewardStateOf({ hasRewards: false, status: 'claimed' })).toBe('none');
  });

  it('concluída e ainda não resgatada', () => {
    expect(rewardStateOf({ hasRewards: true, status: 'completed' })).toBe('waiting');
  });

  it('resgatada no mesmo clique, e entregue', () => {
    expect(rewardStateOf({ hasRewards: true, status: 'claimed', claim: { pending: false } })).toBe(
      'paid',
    );
  });

  it('resgatada, mas alguma entrega ficou pendente', () => {
    // Sem olhar o desfecho do resgate, isto seria anunciado como
    // "sua recompensa foi entregue" — para quem não recebeu nada.
    expect(rewardStateOf({ hasRewards: true, status: 'claimed', claim: { pending: true } })).toBe(
      'pending',
    );
  });

  it('resgatada num clique ANTERIOR conta como entregue', () => {
    // Sem `claim` porque nenhum resgate rodou agora: o estado da
    // tentativa é a única verdade que existe.
    expect(rewardStateOf({ hasRewards: true, status: 'claimed' })).toBe('paid');
  });

  it('tentativa que sumiu não vira promessa de resgate', () => {
    // `null` é o que o `viewById` devolve para uma tentativa
    // apagada. Ela não está `claimed`, então a frase volta a ser a
    // de resgate — e é a resposta certa: o que não existe mais não
    // foi entregue a ninguém.
    expect(rewardStateOf({ hasRewards: true, status: null })).toBe('waiting');
  });
});
