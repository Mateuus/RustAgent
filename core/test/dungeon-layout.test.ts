// ============================================================
//  O traçado desenhado: o que ele tem, e o que está errado nele.
//
//  ####  OS CINCO DEFEITOS SOBEM NORMALMENTE NO JOGO  ####
//
//  É a razão de `checkLayout` existir, e a razão de este teste
//  existir. Uma entrada ilhada, uma sala lacrada, um corredor solto
//  — o servidor constrói tudo isso sem reclamar, e o defeito só
//  aparece com um jogador lá dentro, com a casinha de pé e o evento
//  no ar.
//
//  Cada `it` aqui é um desenho com UM defeito, e a asserção é a
//  frase que o admin vai ler.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { DungeonLayoutsRepository } from '../src/db/dungeon-layouts-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { analyzeLayout, checkLayout } from '../src/dungeons/layout.js';
import { seedDungeonLayouts } from '../src/dungeons/seed.js';
import { FACTORY_LAYOUTS } from '../src/types/dungeon-layouts.js';

/** Um traçado sem defeito nenhum, do qual os outros partem. */
const CLEAN = [
  '..RR..',
  '..RR..',
  'GG##BB',
  'GG##BB',
  '..##..',
  '..E#..',
];

describe('analyzeLayout', () => {
  it('conta as células, o corredor e a entrada', () => {
    const facts = analyzeLayout(CLEAN);

    // 4 R + 4 G + 4 B + 7 corredor + 1 entrada.
    expect(facts.cellCount).toBe(20);
    expect(facts.corridorCells).toBe(7);
    expect(facts.hasEntrance).toBe(true);
    expect(facts.width).toBe(6);
    expect(facts.height).toBe(6);
  });

  it('conta SALA, e não célula: uma vermelha de quatro células é uma sala', () => {
    const facts = analyzeLayout(CLEAN);

    expect(facts.roomCount).toBe(3);
    expect(facts.byColor).toEqual({ green: 1, blue: 1, red: 1 });
  });

  it('separa duas manchas da mesma cor em duas salas', () => {
    // Duas manchas verdes, desligadas uma da outra pelo corredor.
    const facts = analyzeLayout(['GG##', 'GG##', '..##', 'GG##', 'GG##', 'E###']);

    expect(facts.roomCount).toBe(2);
    expect(facts.byColor.green).toBe(2);
  });

  it('une em UMA sala o que se toca, mesmo em L', () => {
    const facts = analyzeLayout(['GGG#', 'G..#', 'G..#', 'E###']);

    expect(facts.roomCount).toBe(1);
  });

  it('uma letra desconhecida cai em verde, como o editor faz', () => {
    // Um traçado de antes de a letra guardar a cor.
    const facts = analyzeLayout(['AA##', 'AA##', 'E###']);

    expect(facts.roomCount).toBe(1);
    expect(facts.byColor.green).toBe(1);
  });
});

describe('checkLayout', () => {
  it('não reclama de um desenho bom', () => {
    expect(checkLayout(CLEAN)).toEqual([]);
  });

  it('acusa a sala que não encosta em corredor nenhum', () => {
    // A sala R está colada no G, e o G no corredor — mas nenhuma
    // célula de R toca o corredor: ninguém entra nela.
    const problems = checkLayout(['RRGG##', '..GG##', '....E#']);

    expect(problems.some((line) => line.includes('ninguém consegue entrar'))).toBe(true);
  });

  it('acusa a entrada ilhada — o defeito que acaba com o evento', () => {
    // O `E` sem corredor ao lado: o jogador desce o alçapão e cai
    // dentro de um quadrado fechado.
    const problems = checkLayout(['##..', '##..', '..E.']);

    expect(problems.some((line) => line.includes('quadrado fechado'))).toBe(true);
  });

  it('acusa o pedaço de corredor que não chega na entrada', () => {
    const problems = checkLayout(['##.##', '##.##', 'E#...']);

    expect(problems.some((line) => line.includes('ilhada'))).toBe(true);
  });

  it('acusa a sala de uma célula com corredor em três lados', () => {
    const problems = checkLayout(['.#.', '#G#', '.E.']);

    expect(problems.some((line) => line.includes('quase sem parede'))).toBe(true);
  });

  it('acusa a célula solta no meio do nada', () => {
    const problems = checkLayout(['G....', '.....', '..E#.']);

    expect(problems.some((line) => line.includes('flutuando'))).toBe(true);
  });

  it('acusa o desenho sem entrada nenhuma', () => {
    const problems = checkLayout(['GG##', 'GG##']);

    expect(problems.some((line) => line.includes('não tem entrada'))).toBe(true);
  });

  it('acusa duas entradas: o alçapão cospe em uma só', () => {
    const problems = checkLayout(['E###E', '#####']);

    expect(problems.some((line) => line.includes('2 entradas'))).toBe(true);
  });
});

describe('os traçados de fábrica', () => {
  // ####  UM DEFEITO AQUI SERIA O PIOR LUGAR PARA UM  ####
  //
  // Eles são o que o admin copia achando que é o certo. Um traçado
  // de fábrica com sala lacrada ensinaria o erro.
  it.each(FACTORY_LAYOUTS.map((layout) => [layout.id, layout] as const))(
    '%s não tem defeito nenhum',
    (_id, layout) => {
      expect(checkLayout(layout.grid)).toEqual([]);
    },
  );

  it.each(FACTORY_LAYOUTS.map((layout) => [layout.id, layout] as const))(
    '%s tem entrada e pelo menos três salas',
    (_id, layout) => {
      const facts = analyzeLayout(layout.grid);

      expect(facts.hasEntrance).toBe(true);
      expect(facts.roomCount).toBeGreaterThanOrEqual(3);
    },
  );

  it('trazem as três cores entre eles', () => {
    const total = FACTORY_LAYOUTS.reduce(
      (sum, layout) => {
        const facts = analyzeLayout(layout.grid);

        return {
          green: sum.green + facts.byColor.green,
          blue: sum.blue + facts.byColor.blue,
          red: sum.red + facts.byColor.red,
        };
      },
      { green: 0, blue: 0, red: 0 },
    );

    expect(total.green).toBeGreaterThan(0);
    expect(total.blue).toBeGreaterThan(0);
    expect(total.red).toBeGreaterThan(0);
  });
});

describe('o acervo de traçados', () => {
  function repository(): DungeonLayoutsRepository {
    const db = openDatabase({ file: MEMORY_DATABASE });

    runMigrations(db);

    return new DungeonLayoutsRepository(db);
  }

  it('grava o desenho e devolve as contagens', () => {
    const layouts = repository();

    const saved = layouts.save({
      id: 'teste',
      name: 'Teste',
      grid: CLEAN,
      origin: 'panel',
    });

    expect(saved.cellCount).toBe(20);
    expect(saved.roomCount).toBe(3);
    expect(saved.byColor).toEqual({ green: 1, blue: 1, red: 1 });
    expect(saved.hasEntrance).toBe(true);
    expect(saved.problemCount).toBe(0);
  });

  it('a lista traz o desenho — é dele que a miniatura vive', () => {
    const layouts = repository();

    layouts.save({ id: 'teste', name: 'Teste', grid: CLEAN, origin: 'panel' });

    expect(layouts.list()[0]?.grid).toEqual(CLEAN);
  });

  it('grava o defeituoso, e MARCA', () => {
    // Um traçado é rascunho: recusar perderia o trabalho de quem ia
    // consertar a sala depois. O que não pode é ele não saber.
    const layouts = repository();

    const saved = layouts.save({
      id: 'torto',
      name: 'Torto',
      grid: ['RRGG##', '..GG##', '....E#'],
      origin: 'panel',
    });

    expect(saved.problemCount).toBeGreaterThan(0);
  });

  it('substitui o de mesmo slug em vez de duplicar', () => {
    const layouts = repository();

    layouts.save({ id: 'teste', name: 'Antes', grid: CLEAN, origin: 'panel' });
    layouts.save({ id: 'teste', name: 'Depois', grid: CLEAN, origin: 'panel' });

    expect(layouts.count()).toBe(1);
    expect(layouts.get('teste')?.name).toBe('Depois');
  });

  it('o seeder só age num acervo vazio', () => {
    const layouts = repository();

    expect(seedDungeonLayouts(layouts)).toBe(FACTORY_LAYOUTS.length);
    // O segundo boot não ressuscita o que alguém apagou.
    expect(seedDungeonLayouts(layouts)).toBe(0);
  });
});
