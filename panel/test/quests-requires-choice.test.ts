// ============================================================
//  O que o seletor de "quem pode ver" decide sozinho.
//
//  O campo era texto livre, com o formato explicado numa dica
//  (`vip:ouro`). Digitado errado, ele não dá erro nenhum: a missão
//  simplesmente não aparece para ninguém, para sempre.
//
//  Em 14/09/2026 ele virou uma lista de níveis clicáveis, e o que
//  se prova aqui é a leitura e a escrita do campo — o mesmo
//  contrato que `core/src/quests/requires.ts` lê do outro lado.
//
//  Componente React não é montado: o vitest do painel roda em node
//  puro.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  formatRequires,
  parseRequires,
  vipRequirement,
} from '@/components/quests/requires-choice';

describe('ler o campo', () => {
  it('um requisito só continua sendo um', () => {
    expect(parseRequires('vip:ouro')).toEqual(['vip:ouro']);
  });

  it('a lista vem separada por vírgula', () => {
    expect(parseRequires('vip:ouro,vip:bronze')).toEqual(['vip:ouro', 'vip:bronze']);
  });

  it('espaço em volta não cria requisito nem atrapalha', () => {
    expect(parseRequires(' vip:ouro , vip:bronze ')).toEqual(['vip:ouro', 'vip:bronze']);
  });

  it('todas as formas de nada dizem a mesma coisa', () => {
    // Vazio = todo mundo vê, e é o estado normal da maioria das
    // missões.
    expect(parseRequires(null)).toEqual([]);
    expect(parseRequires('')).toEqual([]);
    expect(parseRequires(' , ')).toEqual([]);
  });
});

describe('escrever o campo', () => {
  it('nada marcado volta como `null`', () => {
    // É `null` que a coluna guarda para "todo mundo vê" — string
    // vazia seria um requisito que ninguém cumpre.
    expect(formatRequires([])).toBeNull();
  });

  it('marcar e desmarcar volta ao começo', () => {
    const marcado = formatRequires(['vip:ouro']);

    expect(marcado).toBe('vip:ouro');
    expect(formatRequires(parseRequires(marcado).filter((item) => item !== 'vip:ouro'))).toBeNull();
  });

  it('o mesmo nível duas vezes conta uma', () => {
    // Dois cliques rápidos no mesmo chip não podem gravar o
    // requisito em dobro.
    expect(formatRequires(['vip:ouro', 'vip:ouro'])).toBe('vip:ouro');
  });

  it('a ordem é a de quem clicou', () => {
    expect(formatRequires(['vip:bronze', 'vip:ouro'])).toBe('vip:bronze,vip:ouro');
  });
});

describe('o requisito de um nível', () => {
  it('é o tier com o prefixo que o agente confere', () => {
    expect(vipRequirement('ouro')).toBe('vip:ouro');
  });

  it('não carrega espaço do cadastro', () => {
    expect(vipRequirement(' ouro ')).toBe('vip:ouro');
  });
});
