// ============================================================
//  O que a aba WIPE calcula sozinha.
//
//  São três coisas puras, e as três são exatamente onde a tela
//  poderia mentir sem ninguém perceber:
//
//    a GRADE DO MÊS   em que casa cai cada marcação;
//    o RELÓGIO        quanto falta, contra o relógio do agente;
//    a LEITURA DA AGENDA  qual é o próximo wipe, e o próximo forçado.
//
//  Componente React não é montado aqui — o vitest do painel roda
//  em node puro, e o que estes testes cobrem é justamente a parte
//  que não depende do DOM.
//
//  ####  OS PLANOS SÃO UM MOCK LOCAL  ####
//
//  Eles espelham `core/src/types/wipe.ts` campo a campo. É contra
//  o CONTRATO que esta tela foi escrita, e não contra uma resposta
//  de API que ainda não existe.
// ============================================================

import { describe, expect, it } from 'vitest';

import { buildMonthGrid, dayKey, monthLabel, monthStart, shiftMonth } from '@/components/wipe/calendar-month';
import {
  nextForcedWipe,
  nextWipe,
  sortByDate,
  toCalendarMarks,
  toneOfPlan,
  fromDateTimeFields,
  toDateField,
} from '@/components/wipe/labels';
import { describeSkew, formatCountdown, projectNow } from '@/components/wipe/use-agent-clock';
import type { WipePlan } from '@/lib/api';

/** Um wipe marcado, com o resto do contrato em valores neutros. */
function plan(patch: Partial<WipePlan> & { id: number; scheduledAt: number }): WipePlan {
  return {
    serverId: 'server01',
    kind: 'cadence',
    bpPolicy: 'keep',
    mapSource: 'pool',
    mapPoolId: null,
    status: 'planned',
    absorbedBy: null,
    generatedFor: null,
    pinned: false,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

/** Meio-dia local do dia pedido — longe de qualquer virada de fuso. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe('a grade do mês', () => {
  // Setembro de 2026 começa numa TERÇA, e é o mês do mockup do
  // Docs/16 §9.1 — os wipes caem nas quintas 3, 10, 17 e 24.
  const setembro = at(2026, 9, 15);

  it('abre a semana no domingo e completa as bordas com os meses vizinhos', () => {
    const rows = buildMonthGrid(setembro, [], setembro);
    const first = rows[0];

    expect(rows).toHaveLength(5);
    expect(first).toHaveLength(7);
    // 30 e 31 de agosto ocupam as duas casas antes do dia 1º.
    expect(first?.[0]).toMatchObject({ day: 30, inMonth: false });
    expect(first?.[1]).toMatchObject({ day: 31, inMonth: false });
    expect(first?.[2]).toMatchObject({ day: 1, inMonth: true });
    // A quinta da primeira semana é o dia 3.
    expect(first?.[4]).toMatchObject({ day: 3, inMonth: true });
  });

  it('fecha o mês com os primeiros dias do seguinte', () => {
    const rows = buildMonthGrid(setembro, [], setembro);
    const last = rows[rows.length - 1];

    expect(last?.[3]).toMatchObject({ day: 30, inMonth: true });
    expect(last?.[4]).toMatchObject({ day: 1, inMonth: false });
  });

  it('põe cada marcação na casa do dia LOCAL dela', () => {
    // 23:30 do dia 3: em UTC isso já é o dia 4 em qualquer fuso do
    // Brasil. A marcação continua no dia 3, que é o dia de quem
    // está olhando a tela.
    const marks = [
      { at: at(2026, 9, 3, 23, 30), kind: 'cadence', label: 'wipe', tone: 'olive' as const },
    ];

    const rows = buildMonthGrid(setembro, marks, setembro);

    expect(rows[0]?.[4]).toMatchObject({ day: 3, marks: [marks[0]] });
    expect(rows[0]?.[5]?.marks).toHaveLength(0);
  });

  it('marca hoje numa casa só', () => {
    const hoje = at(2026, 9, 17);
    const rows = buildMonthGrid(setembro, [], hoje);
    const marcadas = rows.flat().filter((cell) => cell.isToday);

    expect(marcadas).toHaveLength(1);
    expect(marcadas[0]).toMatchObject({ day: 17, inMonth: true });
  });

  it('empilha duas marcações do mesmo dia, da mais cedo para a mais tarde', () => {
    const marks = [
      { at: at(2026, 9, 3, 20, 0), kind: 'manual', label: 'tarde', tone: 'amber' as const },
      { at: at(2026, 9, 3, 8, 0), kind: 'cadence', label: 'cedo', tone: 'olive' as const },
    ];

    const rows = buildMonthGrid(setembro, marks, setembro);

    expect(rows[0]?.[4]?.marks.map((mark) => mark.label)).toEqual(['cedo', 'tarde']);
  });

  it('navega para trás atravessando a virada do ano', () => {
    const janeiro = monthStart(at(2026, 1, 31));
    const dezembro = new Date(shiftMonth(janeiro, -1));

    expect(dezembro.getFullYear()).toBe(2025);
    expect(dezembro.getMonth()).toBe(11);
    expect(dezembro.getDate()).toBe(1);
  });

  it('rotula o mês por extenso', () => {
    expect(monthLabel(setembro)).toContain('2026');
    expect(monthLabel(setembro).toLowerCase()).toContain('setembro');
  });

  it('a chave do dia usa os campos locais, e nunca o dia em UTC', () => {
    expect(dayKey(at(2026, 9, 3, 23, 59))).toBe('2026-09-03');
    expect(dayKey(at(2026, 9, 3, 0, 1))).toBe('2026-09-03');
  });
});

describe('o relógio do agente', () => {
  it('projeta o carimbo do agente com o que o relógio local andou', () => {
    expect(projectNow({ agentNow: 1_000, receivedAt: 5_000 }, 8_000)).toBe(4_000);
  });

  it('sem relógio local ainda, devolve o carimbo cru', () => {
    expect(projectNow({ agentNow: 1_000, receivedAt: 5_000 }, null)).toBe(1_000);
  });

  it('conta em dias, horas, minutos e segundos', () => {
    const seis_dias = ((6 * 24 + 4) * 60 + 12) * 60 * 1_000 + 33_000;

    expect(formatCountdown(seis_dias)).toBe('06d 04h 12m 33s');
  });

  it('esconde as unidades vazias da frente, e nunca a da direita', () => {
    expect(formatCountdown(3_600_000)).toBe('01h 00m 00s');
    expect(formatCountdown(90_000)).toBe('01m 30s');
    expect(formatCountdown(5_000)).toBe('05s');
  });

  it('não conta para trás', () => {
    expect(formatCountdown(-60_000)).toBe('00s');
  });

  it('chama de ok a diferença que é só a viagem da resposta', () => {
    expect(describeSkew(400)).toBe('ok (±0,4 s)');
    expect(describeSkew(-1_200)).toContain('ok');
  });

  it('diz para que lado o navegador está fora de hora', () => {
    expect(describeSkew(30_000)).toContain('adiantado');
    expect(describeSkew(-30_000)).toContain('atrasado');
    expect(describeSkew(null)).toBe('ainda não medido');
  });
});

describe('a leitura da agenda', () => {
  const agora = at(2026, 9, 1, 10, 0);

  const agenda: readonly WipePlan[] = [
    plan({ id: 1, scheduledAt: at(2026, 8, 27, 16), status: 'done' }),
    plan({ id: 2, scheduledAt: at(2026, 9, 3, 16) }),
    plan({ id: 3, scheduledAt: at(2026, 9, 10, 16), status: 'absorbed', absorbedBy: 4 }),
    plan({ id: 4, scheduledAt: at(2026, 10, 1, 16), kind: 'forced' }),
    plan({ id: 5, scheduledAt: at(2026, 9, 17, 16) }),
  ];

  it('o próximo é o mais cedo que ainda vai acontecer', () => {
    expect(nextWipe(agenda, agora)?.id).toBe(2);
  });

  it('não devolve o que já passou nem o que foi cancelado', () => {
    // Passado o dia 3, o seguinte é o 17: o dia 10 foi absorvido
    // pelo forçado e não acontece.
    expect(nextWipe(agenda, at(2026, 9, 4))?.id).toBe(5);
  });

  it('o forçado sai da agenda, e não de uma conta feita na tela', () => {
    expect(nextForcedWipe(agenda, agora)?.id).toBe(4);
    expect(nextForcedWipe([], agora)).toBeNull();
  });

  it('sem nada marcado, não inventa um próximo', () => {
    expect(nextWipe([], agora)).toBeNull();
  });

  it('ordena sem mexer na lista que recebeu', () => {
    const ordered = sortByDate(agenda);

    expect(ordered.map((entry) => entry.id)).toEqual([1, 2, 3, 5, 4]);
    expect(agenda.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a cor separa forçado, cadência e manual — e apaga o que não acontece', () => {
    expect(toneOfPlan(plan({ id: 9, scheduledAt: agora, kind: 'forced' }))).toBe('rust');
    expect(toneOfPlan(plan({ id: 9, scheduledAt: agora, kind: 'cadence' }))).toBe('olive');
    expect(toneOfPlan(plan({ id: 9, scheduledAt: agora, kind: 'manual' }))).toBe('amber');
    expect(toneOfPlan(plan({ id: 9, scheduledAt: agora, status: 'absorbed' }))).toBe('muted');
  });

  it('vira marcação genérica: a grade não sabe o que é um wipe', () => {
    const marks = toCalendarMarks(agenda);

    expect(marks).toHaveLength(agenda.length);
    expect(Object.keys(marks[0] ?? {}).sort()).toEqual(['at', 'kind', 'label', 'tone']);
    // O cancelado diz na etiqueta por que está apagado.
    expect(marks[2]?.label).toContain('cancelado');
  });
});

describe('os campos de data do formulário', () => {
  it('leva a data para o <input type="date"> e volta', () => {
    expect(toDateField(at(2026, 9, 3))).toBe('2026-09-03');
    expect(toDateField(0)).toBe('');
  });

  it('junta dia e hora no fuso de quem digitou', () => {
    expect(fromDateTimeFields('2026-09-03', '16:00')).toBe(at(2026, 9, 3, 16, 0));
  });

  it('recusa campo vazio ou pela metade em vez de inventar uma data', () => {
    expect(fromDateTimeFields('', '16:00')).toBeNull();
    expect(fromDateTimeFields('2026-09-03', '')).toBeNull();
  });
});
