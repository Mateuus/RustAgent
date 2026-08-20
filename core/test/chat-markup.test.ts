// ============================================================
//  chat-markup.test.ts  -  a cor no meio da frase.
//
//  O que se guarda aqui é a fronteira entre "isto é uma cor" e
//  "isto é texto entre colchetes". Errar para um lado apaga a tag
//  que o admin digitou; errar para o outro deixa `[verde]` na cara
//  de mil jogadores.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  hasChatMarkup,
  parseChatMarkup,
  resolveChatColor,
  stripChatMarkup,
} from '../src/game/chat-markup.js';

describe('resolveChatColor', () => {
  it('conhece a paleta em português', () => {
    expect(resolveChatColor('verde')).toBe('#22c55e');
    expect(resolveChatColor('AZUL')).toBe('#3b82f6');
  });

  it('aceita hexadecimal, e o normaliza para minúsculas', () => {
    // A normalização é o que faz `[#FF0000]x[#ff0000]` fechar o par:
    // sem ela seriam duas cores diferentes para o mesmo vermelho.
    expect(resolveChatColor('#FF0000')).toBe('#ff0000');
    expect(resolveChatColor('#abc')).toBe('#abc');
    expect(resolveChatColor('#ff000080')).toBe('#ff000080');
  });

  it('recusa o que não é cor', () => {
    expect(resolveChatColor('AVISO')).toBeNull();
    expect(resolveChatColor('#12345')).toBeNull();
    expect(resolveChatColor('')).toBeNull();
  });
});

describe('parseChatMarkup', () => {
  it('separa o pedaço colorido do resto', () => {
    expect(parseChatMarkup('Agora tem [verde]3[/]/300')).toEqual([
      { text: 'Agora tem ', color: null },
      { text: '3', color: '#22c55e' },
      { text: '/300', color: null },
    ]);
  });

  it('fecha com a MESMA cor, que é como a maioria escreve', () => {
    // O pedido que originou isto foi escrito assim, e sem a regra
    // do "abrir de novo fecha" a frase sairia azul até o fim.
    expect(parseChatMarkup('Agora tem [azul]3[azul]/300')).toEqual([
      { text: 'Agora tem ', color: null },
      { text: '3', color: '#3b82f6' },
      { text: '/300', color: null },
    ]);
  });

  it('aceita hexadecimal no lugar do nome', () => {
    expect(parseChatMarkup('Wipe [#ff0000]HOJE[/] às 16h')).toEqual([
      { text: 'Wipe ', color: null },
      { text: 'HOJE', color: '#ff0000' },
      { text: ' às 16h', color: null },
    ]);
  });

  it('deixa literal o colchete que não é cor', () => {
    // `[AVISO]` no meio do texto é o caso real: quem tem tag de
    // servidor a escreve assim, e comê-la seria apagar o recado.
    expect(parseChatMarkup('[AVISO] servidor [BR] 2x')).toEqual([
      { text: '[AVISO] servidor [BR] 2x', color: null },
    ]);
  });

  it('cor aberta e não fechada vale até o fim, e não além', () => {
    expect(parseChatMarkup('leia o [vermelho]discord')).toEqual([
      { text: 'leia o ', color: null },
      { text: 'discord', color: '#ef4444' },
    ]);
  });

  it('volta à cor de fora quando o de dentro fecha', () => {
    expect(parseChatMarkup('[azul]a[verde]b[/]c[/]d')).toEqual([
      { text: 'a', color: '#3b82f6' },
      { text: 'b', color: '#22c55e' },
      { text: 'c', color: '#3b82f6' },
      { text: 'd', color: null },
    ]);
  });

  it('deixa literal o fechamento que sobrou', () => {
    // Sobrou porque o admin errou. Ele VÊ o `[/]` no chat e
    // conserta; um fechamento comido em silêncio ele nunca acha.
    expect(parseChatMarkup('nada aqui [/] mesmo')).toEqual([
      { text: 'nada aqui [/] mesmo', color: null },
    ]);
  });

  it('não confunde texto entre colchetes com marcador quebrado', () => {
    expect(parseChatMarkup('sai [a cada 30 min] de novo')).toEqual([
      { text: 'sai [a cada 30 min] de novo', color: null },
    ]);
  });

  it('não inventa pedaço vazio quando a frase começa com cor', () => {
    expect(parseChatMarkup('[dourado]VIP[/]')).toEqual([{ text: 'VIP', color: '#ffcc00' }]);
  });
});

describe('stripChatMarkup', () => {
  it('devolve a frase como o `say` do jogo vai dizê-la', () => {
    // Sem isto o jogador leria os marcadores: o `say` não tem cor
    // nenhuma, e o que sobra na tela é `[verde]3[/]`.
    expect(stripChatMarkup('Agora tem [verde]3[/]/300')).toBe('Agora tem 3/300');
  });

  it('não mexe no que não é cor', () => {
    expect(stripChatMarkup('[AVISO] entre no discord')).toBe('[AVISO] entre no discord');
  });
});

describe('hasChatMarkup', () => {
  it('separa a frase pintada da frase com colchete', () => {
    expect(hasChatMarkup('Agora tem [verde]3[/]/300')).toBe(true);
    expect(hasChatMarkup('[AVISO] entre no discord')).toBe(false);
  });
});
