// ============================================================
//  rankings-awards.test.ts
//
//  Quais rankings aceitam ponto CONCEDIDO por missão ou item.
//
//  O defeito que trouxe esta regra: o editor de missões tinha um
//  campo de texto livre para a métrica, e `quest.completed` — que
//  não é ranking nenhum — salvou. O jogador concluiu a missão,
//  recebeu os 50 OZCoin e os 5 pontos viraram pendência no painel.
//  Medido em 14/09/2026.
//
//  A regra que saiu daí é mais larga que "existe?": há rankings que
//  EXISTEM e mesmo assim não podem receber ponto à mão.
// ============================================================

import { describe, expect, it } from 'vitest';

import { acceptsAwardedPoints, whyNotAwardable } from '../src/rankings/awards.js';

describe('quem pode receber ponto de missão', () => {
  it('o ranking CONCEDIDO aceita — é o do Troféu Bleik', () => {
    expect(acceptsAwardedPoints({ source: 'item', enabled: true })).toBe(true);
  });

  it('o que o jogo MEDE não aceita', () => {
    // Somar cinco à mão em "Metal" seria dizer que o jogador
    // minerou cinco de metal.
    expect(acceptsAwardedPoints({ source: 'plugin', enabled: true })).toBe(false);
  });

  it('o que o agente CALCULA não aceita', () => {
    expect(acceptsAwardedPoints({ source: 'agent', enabled: true })).toBe(false);
  });

  it('o DERIVADO não aceita — não há onde guardar', () => {
    // O K/D não tem linha em `player_stats`: o ponto cairia num
    // lugar que nenhuma tela lê.
    expect(acceptsAwardedPoints({ source: 'computed', enabled: true })).toBe(false);
  });

  it('desligado não aceita, nem sendo do tipo certo', () => {
    // O número somaria numa lista que sumiu de todas as telas, e o
    // admin só descobriria ao religar o ranking meses depois.
    expect(acceptsAwardedPoints({ source: 'item', enabled: false })).toBe(false);
  });
});

describe('a frase que explica a recusa', () => {
  it('o que serve não tem recusa', () => {
    expect(whyNotAwardable({ label: 'Troféu Bleik', source: 'item', enabled: true })).toBeNull();
  });

  it('cada motivo tem a sua frase, e todas dizem o que fazer', () => {
    const medido = whyNotAwardable({ label: 'Metal', source: 'plugin', enabled: true });
    const calculado = whyNotAwardable({ label: 'Tempo online', source: 'agent', enabled: true });
    const derivado = whyNotAwardable({ label: 'K/D', source: 'computed', enabled: true });

    expect(medido).toContain('medido pelo jogo');
    expect(calculado).toContain('calculado pelo agente');
    expect(derivado).toContain('derivado');

    // "Não pode" sem motivo faria o admin tentar o próximo da lista
    // até acertar por eliminação.
    for (const frase of [medido, calculado, derivado]) {
      expect(frase).toContain('origem "Concedido (item custom ou missão)"');
    }
  });

  it('o desligado é dito como desligado, e não como tipo errado', () => {
    expect(whyNotAwardable({ label: 'Bleik', source: 'item', enabled: false })).toBe(
      'O ranking "Bleik" está desligado.',
    );
  });

  it('o nome do ranking aparece na frase', () => {
    // Sem ele, um formulário com três recompensas de pontos não
    // diria QUAL das três está errada.
    expect(whyNotAwardable({ label: 'Enxofre', source: 'plugin', enabled: true })).toContain(
      'Enxofre',
    );
  });
});
