// ============================================================
//  messages-schedule.test.ts  -  quando é a próxima.
//
//  O que este arquivo guarda:
//
//    1. "a cada 30 min" anda de 30 em 30, SEM DERIVA — mesmo com a
//       entrega demorando, e mesmo com o agente fora do ar por
//       horas (aí ele PULA, e não despeja o atraso);
//    2. "toda quinta às 16:00" atravessa a virada de mês;
//    3. "todo dia às 20:00" atravessa a mudança de horário de verão
//       sem deslizar uma hora;
//    4. "uma vez em <data>" não tem próxima depois de passar;
//    5. a janela que VIRA A MEIA-NOITE ("das 22:00 às 02:00") é
//       verdadeira à meia-noite e meia — a comparação ingênua faria
//       a mensagem nunca sair.
//
//  Tudo com instante injetado: nada aqui espera um mês.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  advanceAfterSend,
  advanceInterval,
  describeSchedule,
  isWithinWindow,
  nextOccurrence,
  type ScheduleShape,
} from '../src/messages/schedule.js';
import { localMinutesOfDay, localWeekday, zonedTimeToUtc } from '../src/messages/timezone-bridge.js';

const SP = 'America/Sao_Paulo';
const MINUTE = 60_000;

function shape(over: Partial<ScheduleShape>): ScheduleShape {
  return {
    scheduleKind: 'interval',
    everySeconds: null,
    timeOfDay: null,
    weekdays: [],
    runAt: null,
    timeZone: SP,
    ...over,
  };
}

/** O instante UTC de uma hora local naquele fuso. */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = SP,
): number {
  return zonedTimeToUtc({ year, month, day }, hour, minute, timeZone);
}

describe('interval', () => {
  it('a primeira sai um intervalo DEPOIS de agora, e não na hora', () => {
    const message = shape({ scheduleKind: 'interval', everySeconds: 1800 });
    const now = at(2026, 8, 18, 10, 0);

    // Criar "a cada 30 minutos" e ver a mensagem no chat no mesmo
    // segundo é o que faz o admin achar que criou errado.
    expect(nextOccurrence(message, now)).toBe(now + 30 * MINUTE);
  });

  it('anda de 30 em 30 SEM DERIVA, mesmo com a entrega demorando', () => {
    const message = shape({ scheduleKind: 'interval', everySeconds: 1800 });

    let scheduled = at(2026, 8, 18, 10, 0);
    const marks: number[] = [];

    for (let volta = 0; volta < 4; volta += 1) {
      // O relógio acorda de 30 em 30 s: o envio sai DEPOIS da hora,
      // e a entrega ainda leva alguns segundos. Somar o intervalo ao
      // instante do envio empurraria a mensagem para frente a cada
      // volta — em um dia, quinze minutos de atraso.
      const sentAt = scheduled + 17_000;
      const next = advanceAfterSend(message, scheduled, sentAt);

      expect(next).not.toBeNull();
      marks.push(next as number);
      scheduled = next as number;
    }

    expect(marks).toEqual([
      at(2026, 8, 18, 10, 30),
      at(2026, 8, 18, 11, 0),
      at(2026, 8, 18, 11, 30),
      at(2026, 8, 18, 12, 0),
    ]);
  });

  it('com o agente horas fora do ar, PULA para o próximo múltiplo', () => {
    const message = shape({ scheduleKind: 'interval', everySeconds: 1800 });
    const scheduled = at(2026, 8, 18, 10, 0);
    // Voltou às 15:07. A mensagem sai UMA vez, e a próxima é a
    // 15:30 — e não dez mensagens seguidas "recuperando o atraso".
    const sentAt = at(2026, 8, 18, 15, 7);

    expect(advanceAfterSend(message, scheduled, sentAt)).toBe(at(2026, 8, 18, 15, 30));
  });

  it('advanceInterval não anda quando a âncora já está no futuro', () => {
    expect(advanceInterval(2_000, 500, 1_000)).toBe(2_000);
  });

  it('sem intervalo não há próxima — e isso é `null`, não zero', () => {
    expect(nextOccurrence(shape({ scheduleKind: 'interval', everySeconds: null }), 0)).toBeNull();
    expect(nextOccurrence(shape({ scheduleKind: 'interval', everySeconds: 0 }), 0)).toBeNull();
  });
});

describe('daily', () => {
  it('o horário de hoje que ainda não passou é o de hoje', () => {
    const message = shape({ scheduleKind: 'daily', timeOfDay: '20:00' });

    expect(nextOccurrence(message, at(2026, 8, 18, 9, 0))).toBe(at(2026, 8, 18, 20, 0));
  });

  it('depois de passar, é o de amanhã', () => {
    const message = shape({ scheduleKind: 'daily', timeOfDay: '20:00' });

    expect(nextOccurrence(message, at(2026, 8, 18, 20, 0))).toBe(at(2026, 8, 19, 20, 0));
  });

  it('atravessa a mudança de offset sem deslizar uma hora', () => {
    // Fuso que ainda muda de offset (os EUA mantêm o horário de
    // verão): 08/03/2026 é o domingo em que Nova York pula das
    // 02:00 para as 03:00.
    const NY = 'America/New_York';
    const message = shape({ scheduleKind: 'daily', timeOfDay: '20:00', timeZone: NY });

    const antes = at(2026, 3, 7, 20, 0, NY);
    const depois = nextOccurrence(message, antes);

    expect(depois).not.toBeNull();
    // Continua às 20:00 LOCAIS — e a distância em milissegundos é
    // de 23 horas, e não de 24. Somar 86 400 000 daria 21:00.
    expect(localMinutesOfDay(depois as number, NY)).toBe(20 * 60);
    expect((depois as number) - antes).toBe(23 * 3_600_000);
  });
});

describe('weekly', () => {
  it('a próxima quinta às 16:00 atravessa a virada de mês', () => {
    // Quinta = 4. 27/08/2026 é uma quinta; a seguinte é 03/09.
    const message = shape({ scheduleKind: 'weekly', timeOfDay: '16:00', weekdays: [4] });
    const depoisDaQuinta = at(2026, 8, 27, 16, 30);
    const proxima = nextOccurrence(message, depoisDaQuinta);

    expect(proxima).not.toBeNull();
    expect(proxima).toBe(at(2026, 9, 3, 16, 0));
    expect(localWeekday(proxima as number, SP)).toBe(4);
  });

  it('com dois dias marcados, pega o mais próximo', () => {
    // Segunda (1) e quinta (4). Partindo de uma terça, a próxima é
    // a quinta.
    const message = shape({ scheduleKind: 'weekly', timeOfDay: '16:00', weekdays: [1, 4] });
    const terca = at(2026, 8, 18, 9, 0);

    expect(nextOccurrence(message, terca)).toBe(at(2026, 8, 20, 16, 0));
  });

  it('sem dia nenhum marcado não há próxima', () => {
    const message = shape({ scheduleKind: 'weekly', timeOfDay: '16:00', weekdays: [] });

    expect(nextOccurrence(message, Date.now())).toBeNull();
  });
});

describe('once', () => {
  it('é a data marcada enquanto ela está no futuro', () => {
    const quando = at(2026, 8, 25, 2, 0);
    const message = shape({ scheduleKind: 'once', runAt: quando });

    expect(nextOccurrence(message, at(2026, 8, 24, 23, 0))).toBe(quando);
  });

  it('depois de passar não tem próxima — é assim que ela se desliga', () => {
    const quando = at(2026, 8, 25, 2, 0);
    const message = shape({ scheduleKind: 'once', runAt: quando });

    expect(nextOccurrence(message, quando)).toBeNull();
    expect(advanceAfterSend(message, quando, quando + 1_000)).toBeNull();
  });
});

describe('a janela de horário', () => {
  it('sem janela, sai a qualquer hora', () => {
    expect(isWithinWindow(Date.now(), null, null, SP)).toBe(true);
  });

  it('a janela normal aceita dentro e recusa fora', () => {
    expect(isWithinWindow(at(2026, 8, 18, 12, 0), '10:00', '23:00', SP)).toBe(true);
    expect(isWithinWindow(at(2026, 8, 18, 9, 59), '10:00', '23:00', SP)).toBe(false);
    expect(isWithinWindow(at(2026, 8, 18, 23, 0), '10:00', '23:00', SP)).toBe(false);
  });

  it('a janela que VIRA A MEIA-NOITE vale dos dois lados', () => {
    // É este o caso que a comparação ingênua (`de <= agora && agora
    // <= ate`) transformaria em "nunca": o admin escreveria o
    // horário certo e a mensagem não sairia, sem nada dizer por quê.
    expect(isWithinWindow(at(2026, 8, 18, 23, 30), '22:00', '02:00', SP)).toBe(true);
    expect(isWithinWindow(at(2026, 8, 18, 0, 30), '22:00', '02:00', SP)).toBe(true);
    expect(isWithinWindow(at(2026, 8, 18, 12, 0), '22:00', '02:00', SP)).toBe(false);
  });

  it('a janela é lida no fuso da MENSAGEM, e não no da máquina', () => {
    const instante = at(2026, 8, 18, 23, 30, SP);

    // 23:30 em São Paulo é 02:30 em UTC: dentro da janela num fuso,
    // fora no outro. Um `getHours()` responderia pelo fuso do host.
    expect(isWithinWindow(instante, '22:00', '02:00', SP)).toBe(true);
    expect(isWithinWindow(instante, '22:00', '02:00', 'UTC')).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('escreve a coluna REPETE da tela', () => {
    expect(describeSchedule(shape({ scheduleKind: 'interval', everySeconds: 1800 }))).toBe('30 min');
    expect(describeSchedule(shape({ scheduleKind: 'interval', everySeconds: 7200 }))).toBe('2 h');
    expect(describeSchedule(shape({ scheduleKind: 'daily', timeOfDay: '20:00' }))).toBe(
      'todo dia às 20:00',
    );
    expect(
      describeSchedule(shape({ scheduleKind: 'weekly', timeOfDay: '16:00', weekdays: [4] })),
    ).toBe('quinta às 16:00');
  });
});
