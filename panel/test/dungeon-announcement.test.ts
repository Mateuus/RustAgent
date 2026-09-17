// ============================================================
//  A frase que a masmorra grita no chat, montada como o plugin monta.
//
//  ####  ERRAR AQUI NÃO QUEBRA TELA NENHUMA  ####
//
//  Produz uma prévia confiante e errada: o admin lê "Uma masmorra
//  apareceu em G6." no painel e o servidor inteiro lê "... em G6.
//  (G6)" — ou lê "algum lugar" onde ele esperava a grade. A regra é
//  a do `AnnouncementText` de `Plugins/OrigemZDungeon.cs`.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  ANNOUNCE_DEFAULTS,
  announcementStyle,
  announcementText,
  HIDDEN_GRID,
  isAnnounceColor,
  isAnnounceSize,
  SAMPLE_GRID,
} from '@/lib/dungeon-announcement';

/** A frase com os campos de um rascunho comum, e o que o caso mudar. */
function phrase(change: Partial<Parameters<typeof announcementText>[0]> = {}): string {
  return announcementText({
    template: '',
    fallback: ANNOUNCE_DEFAULTS.onBuild,
    name: 'Bunker Vermelho',
    slug: 'bunker-vermelho',
    grid: SAMPLE_GRID,
    showGrid: true,
    ...change,
  });
}

describe('announcementText', () => {
  it('campo vazio usa a frase padrão', () => {
    expect(phrase()).toBe('Uma masmorra apareceu em G6.');
    expect(phrase({ fallback: ANNOUNCE_DEFAULTS.onEnd })).toBe('A masmorra de G6 fechou.');
  });

  it('troca {nome} pelo NOME, e não pelo identificador', () => {
    expect(phrase({ template: '{nome} abriu em {grid}!' })).toBe('Bunker Vermelho abriu em G6!');
  });

  it('sem nome, {nome} vira o identificador', () => {
    expect(phrase({ template: '{nome} em {grid}', name: '' })).toBe('bunker-vermelho em G6');
  });

  it('troca todas as ocorrências, não só a primeira', () => {
    // O `Replace` do C# troca todas. Um `replace` de JavaScript com
    // texto troca só a primeira — e a prévia diria "{grid}" onde o
    // jogo diz "G6".
    expect(phrase({ template: '{grid}! Corram para {grid}!' })).toBe('G6! Corram para G6!');
  });

  it('com a grade ligada e sem {grid}, acrescenta a grade no fim', () => {
    expect(phrase({ template: 'A masmorra do {nome} abriu.' })).toBe(
      'A masmorra do Bunker Vermelho abriu. (G6)',
    );
  });

  it('não acrescenta a grade quando ela já está na frase', () => {
    // A pergunta do plugin é pela grade no texto PRONTO — então a
    // grade escrita à mão também conta, e não ganha uma segunda.
    expect(phrase({ template: 'Todos para G6.' })).toBe('Todos para G6.');
  });

  it('com a grade desligada, {grid} vira "algum lugar" e nada entra no fim', () => {
    expect(phrase({ showGrid: false })).toBe(`Uma masmorra apareceu em ${HIDDEN_GRID}.`);
    expect(phrase({ template: '{nome} abriu.', showGrid: false })).toBe('Bunker Vermelho abriu.');
  });

  it('a marcação de cor passa intacta, para a prévia colorir', () => {
    expect(phrase({ template: '[verde]{nome}[/] em {grid}' })).toBe('[verde]Bunker Vermelho[/] em G6');
  });

  it('um nome que contém {grid} sai literal, como no plugin', () => {
    // `{grid}` é trocado ANTES de `{nome}`: o que o nome traz já
    // não é mais variável.
    expect(phrase({ template: '{nome} em {grid}', name: 'Sala {grid}' })).toBe('Sala {grid} em G6');
  });
});

describe('a régua dos campos de visual', () => {
  it('cor: vazio ou hexadecimal', () => {
    expect(isAnnounceColor('')).toBe(true);
    expect(isAnnounceColor('#fc0')).toBe(true);
    expect(isAnnounceColor('#ffcc00')).toBe(true);
    expect(isAnnounceColor('#ffcc0080')).toBe(true);
    expect(isAnnounceColor('amarelo')).toBe(false);
    expect(isAnnounceColor('#ffcc00;background:red')).toBe(false);
  });

  it('tamanho: zero ou de 8 a 40', () => {
    expect(isAnnounceSize(0)).toBe(true);
    expect(isAnnounceSize(8)).toBe(true);
    expect(isAnnounceSize(40)).toBe(true);
    expect(isAnnounceSize(7)).toBe(false);
    expect(isAnnounceSize(41)).toBe(false);
    expect(isAnnounceSize(12.5)).toBe(false);
  });
});

describe('announcementStyle', () => {
  it('vazio é o visual do chat', () => {
    expect(announcementStyle({ tagColor: '', color: '', size: 0 })).toEqual({
      tagColor: '#ffcc00',
      color: '#ffffff',
      size: 15,
    });
  });

  it('o que foi escolhido vale', () => {
    expect(announcementStyle({ tagColor: '#ff0000', color: '#22c55e', size: 20 })).toEqual({
      tagColor: '#ff0000',
      color: '#22c55e',
      size: 20,
    });
  });

  it('cor torta e tamanho fora da faixa caem no padrão', () => {
    // A prévia usa isto dentro de `style`: texto livre ali seria CSS
    // injetado na página de quem administra.
    expect(announcementStyle({ tagColor: 'red;x', color: 'azul', size: 3 })).toEqual({
      tagColor: '#ffcc00',
      color: '#ffffff',
      size: 15,
    });
  });
});
