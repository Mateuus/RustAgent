// ============================================================
//  wipe-schedule.test.ts  -  o cálculo puro da agenda.
//
//  O que este arquivo guarda:
//
//    1. o wipe forçado é a primeira quinta do mês às 19:00 UTC —
//       conferido contra a tabela de datas do Docs/16 (que é para
//       HUMANO ler; o código deriva);
//    2. dezembro vira janeiro do ano seguinte sem caso especial;
//    3. a cadência conta dias de CALENDÁRIO: atravessando uma
//       mudança de offset, o wipe continua às 16:00 LOCAIS e o
//       instante UTC é que anda;
//    4. as três políticas de colisão fazem coisas diferentes, e o
//       absorvido continua na lista, marcado;
//    5. a cadência nasce desligada, e configuração inválida não
//       apaga os forçados da agenda.
//
//  ####  A TABELA DE DATAS MORA AQUI, E SÓ AQUI  ####
//
//  Ela é a conferência humana da regra derivada. No código de
//  produção uma lista dessas envelheceria em silêncio — aqui ela é
//  justamente o oráculo independente que prova que a derivação não
//  saiu do lugar.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { WipeSettings } from '../src/types/wipe.js';
import {
  DEFAULT_WIPE_SETTINGS,
  FORCED_WIPE_HOUR_UTC,
  addDays,
  buildSchedule,
  daysBetween,
  forcedWipeOfMonth,
  forcedWipesBetween,
  isValidTimeZone,
  lastForcedWipeBefore,
  localDateInZone,
  nextForcedWipe,
  nextWipe,
  parseTimeOfDay,
  weekdayInZone,
  zonedTimeToUtc,
  zoneOffsetMinutes,
} from '../src/wipe/schedule.js';

const SAO_PAULO = 'America/Sao_Paulo';
const NEW_YORK = 'America/New_York';

/** O DIA do force wipe de cada mês, na ordem (Docs/16, §5). */
const FORCED_DAYS_2026 = [1, 5, 5, 2, 7, 4, 2, 6, 3, 1, 5, 3];
const FORCED_DAYS_2027 = [7, 4, 4, 1, 6, 3, 1, 5, 2, 7, 4, 2];

/** A hora local naquele fuso, como `16:00`. */
function localTimeOf(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

/** Uma configuração completa a partir do padrão. */
function settingsOf(patch: {
  readonly cadence?: Partial<WipeSettings['cadence']>;
  readonly forced?: Partial<WipeSettings['forced']>;
  readonly collision?: Partial<WipeSettings['collision']>;
}): WipeSettings {
  return {
    cadence: { ...DEFAULT_WIPE_SETTINGS.cadence, ...patch.cadence },
    forced: { ...DEFAULT_WIPE_SETTINGS.forced, ...patch.forced },
    collision: { ...DEFAULT_WIPE_SETTINGS.collision, ...patch.collision },
  };
}

// ============================================================
//  1 e 2 — o forçado
// ============================================================

describe('o wipe forçado da Facepunch', () => {
  it('é a primeira quinta do mês, 19:00 UTC, nos doze meses de 2026', () => {
    for (const [month, day] of FORCED_DAYS_2026.entries()) {
      expect(forcedWipeOfMonth(2026, month)).toBe(
        Date.UTC(2026, month, day, FORCED_WIPE_HOUR_UTC, 0, 0, 0),
      );
    }
  });

  it('e nos doze de 2027', () => {
    for (const [month, day] of FORCED_DAYS_2027.entries()) {
      expect(forcedWipeOfMonth(2027, month)).toBe(
        Date.UTC(2027, month, day, FORCED_WIPE_HOUR_UTC, 0, 0, 0),
      );
    }
  });

  it('cai sempre numa quinta-feira, em UTC', () => {
    for (let month = 0; month < 12; month += 1) {
      expect(new Date(forcedWipeOfMonth(2026, month)).getUTCDay()).toBe(4);
      // E sempre nos sete primeiros dias: "primeira" quinta.
      expect(new Date(forcedWipeOfMonth(2026, month)).getUTCDate()).toBeLessThanOrEqual(7);
    }
  });

  it('em dezembro, o próximo é janeiro do ANO seguinte', () => {
    const dezembro = forcedWipeOfMonth(2026, 11);

    // Um milissegundo depois do wipe de dezembro.
    expect(nextForcedWipe(dezembro + 1)).toBe(forcedWipeOfMonth(2027, 0));
    expect(new Date(nextForcedWipe(dezembro + 1)).getUTCFullYear()).toBe(2027);
  });

  it('no instante EXATO do forçado, o próximo é o do mês seguinte', () => {
    const setembro = forcedWipeOfMonth(2026, 8);

    // Estritamente depois: senão um agendador que rodasse no
    // segundo exato reagendaria o wipe que acabou de executar.
    expect(nextForcedWipe(setembro)).toBe(forcedWipeOfMonth(2026, 9));
    expect(nextForcedWipe(setembro - 1)).toBe(setembro);
  });

  it('o anterior a um instante volta no máximo um mês', () => {
    const setembro = forcedWipeOfMonth(2026, 8);

    expect(lastForcedWipeBefore(setembro + 1)).toBe(setembro);
    expect(lastForcedWipeBefore(setembro)).toBe(forcedWipeOfMonth(2026, 7));
    // Em janeiro, o anterior é o de dezembro do ano passado.
    expect(lastForcedWipeBefore(forcedWipeOfMonth(2027, 0))).toBe(forcedWipeOfMonth(2026, 11));
  });

  it('lista os forçados de uma janela, sem repetir e em ordem', () => {
    const from = Date.UTC(2026, 7, 18, 12, 0, 0);
    const found = forcedWipesBetween(from, from + 90 * 86_400_000);

    expect(found).toEqual([
      forcedWipeOfMonth(2026, 8),
      forcedWipeOfMonth(2026, 9),
      forcedWipeOfMonth(2026, 10),
    ]);
  });

  it('janela curta demais para pegar uma primeira quinta devolve lista vazia', () => {
    const from = Date.UTC(2026, 8, 10, 0, 0, 0);

    expect(forcedWipesBetween(from, from + 5 * 86_400_000)).toEqual([]);
  });
});

// ============================================================
//  3 — o fuso
// ============================================================

describe('as funções de fuso (o contrato que as mensagens também usam)', () => {
  it('lê o dia local, e não o dia UTC', () => {
    // 22:00 de 3 de setembro em São Paulo já é dia 4 em UTC.
    const instant = Date.UTC(2026, 8, 4, 1, 0, 0);

    expect(localDateInZone(instant, SAO_PAULO)).toEqual({ year: 2026, month: 9, day: 3 });
    expect(localDateInZone(instant, 'UTC')).toEqual({ year: 2026, month: 9, day: 4 });
  });

  it('o dia da semana também é o LOCAL', () => {
    // Sexta, 21:00 em São Paulo = sábado, 00:00 UTC.
    const instant = Date.UTC(2026, 8, 5, 0, 0, 0);

    expect(weekdayInZone(instant, SAO_PAULO)).toBe(5);
    expect(weekdayInZone(instant, 'UTC')).toBe(6);
  });

  it('mede o offset por diferença, inclusive nos fusos quebrados', () => {
    const instant = Date.UTC(2026, 8, 3, 12, 0, 0);

    expect(zoneOffsetMinutes(instant, 'UTC')).toBe(0);
    expect(zoneOffsetMinutes(instant, SAO_PAULO)).toBe(-180);
    // Índia: +05:30. Um offset em horas inteiras não cobriria.
    expect(zoneOffsetMinutes(instant, 'Asia/Kolkata')).toBe(330);
  });

  it('16:00 em São Paulo é 19:00 UTC — a mesma hora do forçado', () => {
    const instant = zonedTimeToUtc({ year: 2026, month: 9, day: 3 }, 16, 0, SAO_PAULO);

    expect(instant).toBe(Date.UTC(2026, 8, 3, 19, 0, 0));
    expect(instant).toBe(forcedWipeOfMonth(2026, 8));
  });

  it('atravessando a mudança de offset, o INSTANTE anda e a hora local fica', () => {
    // Nos EUA o horário de verão termina em 1º de novembro de 2026.
    const antes = zonedTimeToUtc({ year: 2026, month: 10, day: 29 }, 16, 0, NEW_YORK);
    const depois = zonedTimeToUtc({ year: 2026, month: 11, day: 5 }, 16, 0, NEW_YORK);

    expect(localTimeOf(antes, NEW_YORK)).toBe('16:00');
    expect(localTimeOf(depois, NEW_YORK)).toBe('16:00');

    // Sete dias de calendário — e 169 horas de relógio, porque uma
    // hora foi devolvida no caminho.
    expect(depois - antes).toBe(169 * 3_600_000);
  });

  it('anda em dias de calendário, e mede a distância entre eles', () => {
    const inicio = { year: 2026, month: 10, day: 29 };
    const fim = addDays(inicio, 7);

    expect(fim).toEqual({ year: 2026, month: 11, day: 5 });
    expect(daysBetween(inicio, fim)).toBe(7);
    // Virada de ano, sem caso especial.
    expect(addDays({ year: 2026, month: 12, day: 30 }, 3)).toEqual({
      year: 2027,
      month: 1,
      day: 2,
    });
  });

  it('reconhece HH:MM e recusa o resto', () => {
    expect(parseTimeOfDay('16:00')).toEqual({ hour: 16, minute: 0 });
    expect(parseTimeOfDay(' 09:30 ')).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('9:30')).toBeNull();
    expect(parseTimeOfDay('16h')).toBeNull();
  });

  it('reconhece a zona IANA que este runtime conhece', () => {
    expect(isValidTimeZone(SAO_PAULO)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Nao_Existe')).toBe(false);
  });
});

// ============================================================
//  4 — a cadência, e a colisão
// ============================================================

describe('a agenda inteira', () => {
  const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
  const HORIZON = NOW + 90 * 86_400_000;

  /** O forçado de setembro, outubro e novembro de 2026. */
  const FORCED = [
    forcedWipeOfMonth(2026, 8),
    forcedWipeOfMonth(2026, 9),
    forcedWipeOfMonth(2026, 10),
  ];

  it('com a cadência DESLIGADA, só o forçado aparece', () => {
    const plans = buildSchedule(DEFAULT_WIPE_SETTINGS, NOW, HORIZON);

    expect(plans.map((plan) => plan.scheduledAt)).toEqual(FORCED);
    expect(plans.every((plan) => plan.kind === 'forced')).toBe(true);
    // O forçado nasce mantendo blueprint: ele apaga o MAPA, e só
    // leva BP quando a Facepunch mexe no sistema de itens.
    expect(plans.every((plan) => plan.bpPolicy === 'keep')).toBe(true);
  });

  it('a cadência sai no horário local escolhido, de N em N dias', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        // Meio-dia UTC de propósito: do marco zero só o DIA importa,
        // e ele é lido NO FUSO da cadência — meia-noite UTC seria a
        // véspera em São Paulo.
        anchorAt: Date.UTC(2026, 7, 15, 12, 0, 0),
        timeOfDay: '16:00',
        timeZone: SAO_PAULO,
      },
      collision: { policy: 'ignore' },
    });

    const cadence = buildSchedule(settings, NOW, HORIZON).filter((plan) => plan.kind === 'cadence');

    expect(cadence.length).toBeGreaterThan(10);
    const noHorario = cadence.every((plan) => localTimeOf(plan.scheduledAt, SAO_PAULO) === '16:00');

    expect(noHorario).toBe(true);
    // Sete dias exatos entre um e outro: São Paulo não muda de
    // offset desde 2019.
    expect(cadence[1]!.scheduledAt - cadence[0]!.scheduledAt).toBe(7 * 86_400_000);
    expect(cadence[0]!.scheduledAt).toBe(
      zonedTimeToUtc({ year: 2026, month: 8, day: 22 }, 16, 0, SAO_PAULO),
    );
  });

  it('num fuso que muda de offset, ela continua às 16:00 LOCAIS', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        anchorAt: Date.UTC(2026, 9, 22, 12, 0, 0),
        timeOfDay: '16:00',
        timeZone: NEW_YORK,
      },
      collision: { policy: 'ignore' },
    });

    const from = Date.UTC(2026, 9, 25, 0, 0, 0);
    const cadence = buildSchedule(settings, from, from + 30 * 86_400_000).filter(
      (plan) => plan.kind === 'cadence',
    );

    expect(cadence.length).toBeGreaterThan(2);
    expect(cadence.every((plan) => localTimeOf(plan.scheduledAt, NEW_YORK) === '16:00')).toBe(true);

    // A prova de que a janela atravessou a mudança: o offset do
    // primeiro é diferente do offset do último.
    const offsets = cadence.map((plan) => zoneOffsetMinutes(plan.scheduledAt, NEW_YORK));

    expect(new Set(offsets).size).toBe(2);
  });

  it('reancorar: o forçado vira o novo marco zero da cadência', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        // Meio-dia UTC de propósito: do marco zero só o DIA importa,
        // e ele é lido NO FUSO da cadência — meia-noite UTC seria a
        // véspera em São Paulo.
        anchorAt: Date.UTC(2026, 7, 15, 12, 0, 0),
        timeOfDay: '16:00',
        timeZone: SAO_PAULO,
      },
      collision: { policy: 'reanchor' },
    });

    const plans = buildSchedule(settings, NOW, HORIZON);
    const forcedSetembro = FORCED[0]!;

    const seguinte = plans.find(
      (plan) => plan.kind === 'cadence' && plan.scheduledAt > forcedSetembro,
    );

    // Sete dias depois do FORÇADO, e não do último da cadência.
    expect(seguinte?.scheduledAt).toBe(forcedSetembro + 7 * 86_400_000);
    expect(localTimeOf(seguinte?.scheduledAt ?? 0, SAO_PAULO)).toBe('16:00');

    // E nunca dois wipes no mesmo instante.
    const instants = plans.map((plan) => plan.scheduledAt);

    expect(new Set(instants).size).toBe(instants.length);
  });

  it('ignorar: os dois calendários acontecem, cada um no seu dia', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        // Meio-dia UTC de propósito: do marco zero só o DIA importa,
        // e ele é lido NO FUSO da cadência — meia-noite UTC seria a
        // véspera em São Paulo.
        anchorAt: Date.UTC(2026, 7, 15, 12, 0, 0),
        timeOfDay: '16:00',
        timeZone: SAO_PAULO,
      },
      collision: { policy: 'ignore' },
    });

    const plans = buildSchedule(settings, NOW, HORIZON);

    expect(plans.some((plan) => plan.absorbedBy !== null)).toBe(false);
    // A cadência não anda: 22/08 + 7n, atravessando os forçados.
    const cadence = plans.filter((plan) => plan.kind === 'cadence');

    for (const [index, plan] of cadence.entries()) {
      expect(plan.scheduledAt).toBe(cadence[0]!.scheduledAt + index * 7 * 86_400_000);
    }
  });

  it('absorver: o wipe perto do forçado é CANCELADO e continua na lista', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        // 19/08 + 7n cai em 02/09, véspera do forçado de 03/09.
        anchorAt: Date.UTC(2026, 7, 19, 12, 0, 0),
        timeOfDay: '16:00',
        timeZone: SAO_PAULO,
      },
      collision: { policy: 'absorb', windowHours: 24 },
    });

    const plans = buildSchedule(settings, NOW, HORIZON);
    const vespera = zonedTimeToUtc({ year: 2026, month: 9, day: 2 }, 16, 0, SAO_PAULO);
    const absorvido = plans.find((plan) => plan.scheduledAt === vespera);

    // Ele NÃO sumiu da agenda: sumindo, a tela não teria como
    // explicar por que aquela quarta não vai ter wipe.
    expect(absorvido).toBeDefined();
    expect(absorvido?.kind).toBe('cadence');
    expect(absorvido?.absorbedBy).toBe(FORCED[0]);

    // E o de uma semana antes, longe do forçado, acontece.
    const semanaAntes = plans.find(
      (plan) => plan.scheduledAt === vespera - 7 * 86_400_000,
    );

    expect(semanaAntes?.absorbedBy).toBeNull();
  });

  it('o próximo wipe pula o absorvido', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        anchorAt: Date.UTC(2026, 7, 19, 12, 0, 0),
        timeOfDay: '16:00',
        timeZone: SAO_PAULO,
      },
      collision: { policy: 'absorb', windowHours: 24 },
    });

    const vespera = zonedTimeToUtc({ year: 2026, month: 9, day: 2 }, 16, 0, SAO_PAULO);
    const proximo = nextWipe(settings, vespera - 3_600_000);

    // Uma hora antes do wipe absorvido, o próximo de verdade é o
    // forçado do dia seguinte.
    expect(proximo?.scheduledAt).toBe(FORCED[0]);
    expect(proximo?.kind).toBe('forced');
  });

  it('a agenda sai em ordem, e nunca antes do "from"', () => {
    const settings = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 3,
        anchorAt: Date.UTC(2020, 0, 1, 0, 0, 0),
        timeOfDay: '16:00',
        timeZone: SAO_PAULO,
      },
    });

    // Marco zero de 2020 com cadência de 3 dias: são ~800 voltas se
    // o cálculo andar dia a dia. Ele salta.
    const plans = buildSchedule(settings, NOW, HORIZON);

    expect(plans.length).toBeGreaterThan(20);
    expect(plans.every((plan) => plan.scheduledAt > NOW && plan.scheduledAt <= HORIZON)).toBe(true);

    for (const [index, plan] of plans.entries()) {
      if (index > 0) {
        expect(plan.scheduledAt).toBeGreaterThan(plans[index - 1]!.scheduledAt);
      }
    }
  });

  it('configuração inválida não apaga os forçados da agenda', () => {
    const quebrada = settingsOf({
      cadence: {
        enabled: true,
        everyDays: 7,
        anchorAt: NOW,
        timeOfDay: 'meio-dia',
        timeZone: 'America/Nao_Existe',
      },
    });

    const plans = buildSchedule(quebrada, NOW, HORIZON);

    // Os forçados continuam listados: é o dado mais importante da
    // tela, e ele não depende de configuração nenhuma nossa.
    expect(plans.map((plan) => plan.scheduledAt)).toEqual(FORCED);
  });
});
