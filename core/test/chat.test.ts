// ============================================================
//  chat.test.ts  -  a leitura do histórico de chat do servidor.
//
//  ####  POR QUE ISTO PRECISA DE TESTE  ####
//
//  A primeira versão da aba de chat lia o log do RCON e ficou VAZIA
//  num servidor cheio de gente conversando: o `OrigemZChat` cancela
//  a mensagem original para reenviá-la formatada, e com ela some o
//  frame de chat do WebRCON.
//
//  O que este arquivo guarda é o formato REAL medido naquele
//  servidor — inclusive a peculiaridade que a leitura ingênua erra:
//  com plugin de chat, o campo `Message` do histórico vem
//  RENDERIZADO, com a tag e o nome dentro dele.
// ============================================================

import { describe, expect, it } from 'vitest';

import { parseChatTail, splitRendered } from '../src/game/chat.js';

const STEAM_ID = '76561198065694695';

/** Uma entrada como o `chat.tail` a devolve. Medido no server01. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Channel: 0,
    Message: 'Mateuus: dsad',
    UserId: STEAM_ID,
    Username: 'Mateuus',
    Color: '#55aaff',
    Time: 1_786_739_883,
    ...over,
  };
}

describe('parseChatTail', () => {
  it('lê o formato medido no servidor', () => {
    const [line] = parseChatTail(JSON.stringify([entry()]));

    expect(line?.steamId).toBe(STEAM_ID);
    expect(line?.name).toBe('Mateuus');
    // O nome NÃO se repete no texto: a tela já o mostra numa coluna
    // própria, e "Mateuus: Mateuus: dsad" seria o resultado ingênuo.
    expect(line?.text).toBe('dsad');
    expect(line?.tag).toBeNull();
    expect(line?.channel).toBe('global');
    expect(line?.color).toBe('#55aaff');
  });

  it('o Time do Rust é em SEGUNDOS', () => {
    const [line] = parseChatTail(JSON.stringify([entry({ Time: 1_786_739_883 })]));

    // Sem o x1000, toda mensagem apareceria em 1970.
    expect(line?.at).toBe(1_786_739_883_000);
    expect(new Date(line?.at ?? 0).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('separa a TAG do grupo que o plugin de chat deixou no texto', () => {
    const [line] = parseChatTail(
      JSON.stringify([
        entry({ Message: '[VIP OURO] Mateuus: alguem viu o helicoptero?', Color: '#ffd700' }),
      ]),
    );

    // É o que o jogador vê no jogo, e é o que quem administra
    // precisa ver: sem a tag, não dá para saber se está falando com
    // um VIP ou com um novato.
    expect(line?.tag).toBe('[VIP OURO]');
    expect(line?.name).toBe('Mateuus');
    expect(line?.text).toBe('alguem viu o helicoptero?');
    expect(line?.color).toBe('#ffd700');
  });

  it('a mensagem do próprio servidor não tem SteamID', () => {
    const [line] = parseChatTail(
      JSON.stringify([
        entry({ Channel: 2, Message: '"sa"', UserId: '0', Username: 'SERVER', Color: '#eee' }),
      ]),
    );

    // "0" é o servidor — um `say`, ou o aviso de atualização. Deixar
    // o "0" ali faria a tela oferecer banir uma conta que não
    // existe.
    expect(line?.steamId).toBeNull();
    expect(line?.name).toBe('SERVER');
    expect(line?.channel).toBe('servidor');
  });

  it('a cor só passa se for uma cor', () => {
    const [line] = parseChatTail(
      JSON.stringify([entry({ Color: 'red; background:url(http://x)' })]),
    );

    // O campo vem do config de um plugin e vai para o `style` da
    // tela: sem a trava, ele seria um caminho para injetar CSS.
    expect(line?.color).toBeNull();
  });

  it('uma entrada estranha não derruba as outras', () => {
    const lines = parseChatTail(JSON.stringify([entry(), { lixo: true }, entry({ Message: 'x' })]));

    expect(lines).toHaveLength(2);
  });

  it('resposta vazia é servidor sem conversa, e não erro', () => {
    expect(parseChatTail('')).toEqual([]);
    expect(parseChatTail('[]')).toEqual([]);
  });

  it('resposta que não é JSON vira erro, e não lista vazia', () => {
    // Lista vazia aqui faria a tela dizer "ninguém falou nada"
    // quando o que houve foi o comando não existir.
    expect(() => parseChatTail('Comando desconhecido: chat.tail')).toThrow();
  });
});

describe('splitRendered', () => {
  it('sem plugin de chat, o texto vai inteiro', () => {
    // Servidor de fábrica: `Message` é só a mensagem.
    expect(splitRendered('alguem viu o helicoptero?', 'Mateuus')).toEqual({
      tag: null,
      text: 'alguem viu o helicoptero?',
    });
  });

  it('com dois-pontos no meio da fala, corta no NOME', () => {
    expect(splitRendered('[ADMIN] Mateuus: olha isso: um urso', 'Mateuus')).toEqual({
      tag: '[ADMIN]',
      text: 'olha isso: um urso',
    });
  });

  it('sem nome conhecido, não inventa tag', () => {
    expect(splitRendered('mensagem solta', '')).toEqual({ tag: null, text: 'mensagem solta' });
  });
});
