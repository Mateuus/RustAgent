// ============================================================
//  ui-item-label.test.ts  -  a regra de queda do nome do item.
//
//  Uma função de uma linha, com quatro testes, porque o que ela
//  decide é o que 1.259 itens mostram na tela — e porque as duas
//  formas de errar aqui são invisíveis para quem lê o código:
//  mostrar inglês num menu traduzido, e mostrar branco.
// ============================================================

import { describe, expect, it } from 'vitest';

import { screenLabelOf } from '../src/game/ui-item-label.js';

describe('o nome do item na tela do jogo', () => {
  it('é o português quando o jogo traduz o item', () => {
    expect(
      screenLabelOf({ displayName: 'Assault Rifle', displayNamePtBr: 'Rifle de Assalto' }),
    ).toBe('Rifle de Assalto');
  });

  it('é o inglês quando o jogo NÃO traduz o item', () => {
    // 4 dos 1.259 itens do catálogo, MEDIDO em produção. São
    // poucos, e é por isso que este caminho precisa de teste: um
    // ramo que roda em 4 casos de 1.259 ninguém vê quebrado.
    expect(screenLabelOf({ displayName: 'Sedan', displayNamePtBr: null })).toBe('Sedan');
  });

  it('é o inglês quando o catálogo é anterior ao campo', () => {
    // Um servidor com o plugin de antes de 07/09/2026 grava a
    // coluna nula, e a rede inteira volta à tela de hoje. Nada
    // quebra — é a razão de o campo ser opcional.
    expect(screenLabelOf({ displayName: 'Assault Rifle' })).toBe('Assault Rifle');
  });

  it('NUNCA é vazio, mesmo com uma tradução em branco gravada', () => {
    // Uma string vazia não deveria chegar aqui — o plugin a
    // descarta e o schema exige `min(1)`. Mas se uma linha gravada
    // por uma versão anterior dessas regras passasse, o resultado
    // seria um rótulo em branco ao lado do ícone: o único defeito
    // desta tela que ninguém consegue diagnosticar olhando.
    expect(screenLabelOf({ displayName: 'Assault Rifle', displayNamePtBr: '' })).toBe(
      'Assault Rifle',
    );
  });
});
