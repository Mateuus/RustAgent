// ============================================================
//  A porta da sala grande, e a conta que decide quando ela nasce.
//
//  ####  ERRAR AQUI NÃO QUEBRA TELA NENHUMA  ####
//
//  Produz uma frase confiante e errada — "4 de 13 salas passam" —
//  que o admin usa para calibrar o limite. O defeito só aparece no
//  jogo, com a folha larga em toda sala ou em nenhuma.
//
//  A regra é a mesma do `WideDoorThresholdOf` do
//  `Plugins/OrigemZDungeon.cs`: células ÷ portas, e não células. Um
//  salão de nove com quatro entradas não afunila ninguém.
// ============================================================

import { describe, expect, it } from 'vitest';

import { previewFromGrid, wideDoorStats } from '@/lib/dungeon-layout';

/**
 * Um traçado escrito à mão, do jeito que o editor guarda.
 *
 * ####  E A PRÉVIA DE GRID NÃO SERVE À CONTAGEM POR SALA  ####
 *
 * `previewFromGrid` numera por COR: as duas manchas 'R' viram a
 * mesma "sala". Aqui isso é PROPOSITAL — cada letra usada uma vez
 * só faz cada mancha ser uma sala de verdade, e o teste consegue
 * falar de tamanho de cômodo.
 */
function preview(rows: readonly string[]) {
  return previewFromGrid(rows);
}

describe('wideDoorStats', () => {
  it('conta a sala de nove células com uma porta', () => {
    // A mancha 3x3 encosta no corredor por UMA célula: 9 ÷ 1 = 9.
    const traced = preview([
      '.AAA.',
      '.AAA.',
      '.AAA.',
      '..#..',
      '..E..',
    ]);

    expect(wideDoorStats(traced, 4)).toEqual({ rooms: 1, wide: 1 });

    // Com o limite em 10 ela deixa de passar — e a folha larga
    // some do jogo sem nada avisar. É o que a frase da tela evita.
    expect(wideDoorStats(traced, 10)).toEqual({ rooms: 1, wide: 0 });
  });

  it('a mesma sala cercada de corredor NÃO passa', () => {
    // ####  É ESTA A RAZÃO DE A CONTA SER POR PORTA  ####
    //
    // As mesmas nove células, agora com o corredor em volta: são
    // oito adjacências, e cada uma é uma porta (o plugin conta
    // TODAS, e não uma por sala). 9 ÷ 8 = 1 — não há funil nenhum
    // para resolver, e a folha larga não deve aparecer.
    const traced = preview([
      '.###.',
      '#AAA#',
      '#AAA#',
      '.AAA.',
      '..E..',
    ]);

    const stats = wideDoorStats(traced, 4);

    expect(stats.rooms).toBe(1);
    expect(stats.wide).toBe(0);
  });

  it('a sala de uma célula nunca passa com o limite padrão', () => {
    const traced = preview(['.A.', '.#.', '.E.']);

    expect(wideDoorStats(traced, 4)).toEqual({ rooms: 1, wide: 0 });

    // E com o limite em 1 ela passa: é o que a tela avisa quando o
    // admin baixa o número até a folha larga valer para tudo.
    expect(wideDoorStats(traced, 1)).toEqual({ rooms: 1, wide: 1 });
  });

  it('sala sem porta nenhuma não é contada como a maior de todas', () => {
    // Dividir por zero a marcaria como infinita. Ela é um defeito
    // do traçado — e quem grita sobre isso é o `checkLayout`.
    const traced = preview([
      'AA...',
      'AA...',
      '...#.',
      '...E.',
    ]);

    expect(wideDoorStats(traced, 4).wide).toBe(1);
    expect(wideDoorStats(traced, 5).wide).toBe(0);
  });

  it('conta cada mancha, e só as que passam', () => {
    const traced = preview([
      'BB.CC',
      'BB.CC',
      '.#.#.',
      '..E..',
    ]);

    // Duas manchas de quatro células, cada uma com uma porta:
    // 4 ÷ 1 = 4, e as duas passam no limite padrão.
    expect(wideDoorStats(traced, 4)).toEqual({ rooms: 2, wide: 2 });
    expect(wideDoorStats(traced, 5)).toEqual({ rooms: 2, wide: 0 });
  });
});
