// ============================================================
//  O resumo de um horário, por família.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  A linha da agenda é onde o admin confere se o que ele montou vai
//  acontecer. Ela errou duas vezes com o KOTH:
//
//    disse "sem masmorra escolhida — não vai nascer" embaixo de um
//    KOTH, que não tem masmorra nenhuma e nasce muito bem;
//
//    disse "dura 30 min" lendo um campo que o agente IGNORA no
//    KOTH — quem manda ali é o território.
//
//  Nenhuma das duas quebra a tela. As duas fazem o admin desfazer
//  configuração que estava certa.
// ============================================================

import { describe, expect, it } from 'vitest';

import { describeSchedule, windowLabel, type ScheduleLike } from '@/lib/events/schedule-summary';

function schedule(patch: Partial<ScheduleLike> = {}): ScheduleLike {
  return {
    kind: 'dungeon',
    dungeonId: 'labirinto',
    interval: { min: 3600, max: 3600 },
    duration: { min: 1800, max: 1800 },
    minOnline: 2,
    servers: ['server01'],
    ...patch,
  };
}

/** O catálogo de masmorras deste teste. */
const NAMES: Record<string, string> = { labirinto: 'O Labirinto' };

const nameOf = (id: string): string | null => NAMES[id] ?? null;

describe('a masmorra', () => {
  it('diz qual, a cada quanto e quanto dura', () => {
    const summary = describeSchedule(schedule(), nameOf);

    expect(summary.warning).toBeNull();
    expect(summary.parts.join(' · ')).toBe(
      'O Labirinto · a cada 60 min · dura 30 min · mínimo 2 online · server01',
    );
  });

  it('sem masmorra escolhida, avisa — e o aviso substitui o resumo', () => {
    const summary = describeSchedule(schedule({ dungeonId: null }), nameOf);

    expect(summary.warning).toContain('sem masmorra escolhida');
    // De que adianta a cadência de um evento que não nasce?
    expect(summary.parts).toHaveLength(0);
  });

  it('masmorra apagada mostra o id cru, e não some da lista', () => {
    const summary = describeSchedule(schedule({ dungeonId: 'que-nao-existe' }), nameOf);

    expect(summary.parts[0]).toBe('que-nao-existe');
  });
});

describe('o KOTH', () => {
  it('NÃO reclama de masmorra: ele não tem uma', () => {
    const summary = describeSchedule(schedule({ kind: 'koth', dungeonId: null }), nameOf);

    expect(summary.warning).toBeNull();
  });

  it('não promete duração: quem manda nela é o território', () => {
    const summary = describeSchedule(
      // Uma duração gorda no horário, que o agente ignora.
      schedule({ kind: 'koth', dungeonId: null, duration: { min: 99_999, max: 99_999 } }),
      nameOf,
    );

    const line = summary.parts.join(' · ');

    expect(line).toContain('dura o que o território disser');
    expect(line).not.toContain('1667 min');
  });

  it('diz a cadência, o mínimo online e os servidores', () => {
    const summary = describeSchedule(
      schedule({ kind: 'koth', dungeonId: null, servers: ['server01', 'server02'] }),
      nameOf,
    );

    expect(summary.parts.join(' · ')).toBe(
      'a cada 60 min · dura o que o território disser · mínimo 2 online · server01, server02',
    );
  });
});

describe('uma família que o painel não conhece', () => {
  it('avisa que nada vai nascer, em vez de inventar um resumo', () => {
    // Um agente mais novo devolve `kind` que este build nunca viu.
    const summary = describeSchedule(schedule({ kind: 'supermassivo' }), nameOf);

    expect(summary.warning).toContain('não sabe erguer');
    expect(summary.parts).toHaveLength(0);
  });
});

describe('a janela', () => {
  it('fechada vira um número só', () => {
    expect(windowLabel({ min: 3600, max: 3600 })).toBe('60 min');
  });

  it('aberta mostra as duas pontas', () => {
    expect(windowLabel({ min: 3600, max: 7200 })).toBe('60–120 min');
  });
});
