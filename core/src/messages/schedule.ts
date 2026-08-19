// ============================================================
//  schedule.ts  -  quando é a próxima vez que esta mensagem sai.
//
//  Cálculo PURO: sem banco, sem RCON, sem relógio próprio. Recebe a
//  mensagem e um instante, devolve outro instante. É o que permite
//  testar "toda quinta às 16:00 atravessando a virada de mês" sem
//  esperar um mês.
//
//  ------------------------------------------------------------
//  ####  O RITMO É DE CADA MENSAGEM  ####
//
//  O agente antigo tinha UM intervalo e um rodízio de frases (ver
//  game/announcements.ts lá). Aqui cada mensagem sabe quando é a
//  próxima dela — é o que permite o convite do Discord de meia em
//  meia hora conviver com o aviso de manutenção de uma vez só, na
//  terça de madrugada.
//
//  ------------------------------------------------------------
//  ####  `interval` NÃO ACUMULA DERIVA  ####
//
//  "A cada 30 minutos" tem de bater 10:00, 10:30, 11:00 — e não
//  10:00, 10:31, 11:03. A conta é a partir do horário PREVISTO
//  (`nextAt`), e não da hora em que o envio realmente saiu: o
//  relógio acorda de 30 em 30 segundos, a entrega leva o tempo que
//  levar, e somar o intervalo ao instante do envio empurraria a
//  mensagem alguns segundos para frente a cada volta.
//
//  E quando o agente ficou horas fora do ar, a mensagem não sai
//  cinquenta vezes seguidas para "recuperar o atraso": o próximo
//  horário PULA para o primeiro múltiplo ainda no futuro. Ver
//  `advanceInterval`.
//
//  ------------------------------------------------------------
//  ####  `daily` E `weekly` CONTAM DIAS DE CALENDÁRIO  ####
//
//  E não 86 400 000 ms. A diferença aparece na madrugada em que o
//  fuso muda de offset: somar um dia em milissegundos faria a
//  mensagem das 20:00 sair às 19:00 no dia seguinte, para sempre.
//  Quem sabe de fuso é o timezone-bridge.ts — e ele é o único.
//
//  ------------------------------------------------------------
//  ####  A JANELA PODE VIRAR A MEIA-NOITE  ####
//
//  "Das 22:00 às 02:00" é pedido normal. Com a comparação ingênua
//  (`de <= agora && agora <= ate`) ela nunca seria verdadeira: o
//  admin escreveria o horário certo e a mensagem não sairia nunca,
//  sem nada dizer por quê. Ver `isWithinWindow`.
// ============================================================

import type { MessageView, ScheduleKind } from '../types/messages.js';
import {
  addDays,
  localMinutesOfDay,
  localWeekday,
  parseMinutesOfDay,
  parseTimeOfDay,
  toLocalDate,
  zonedTimeToUtc,
} from './timezone-bridge.js';

/** O que o cálculo precisa saber de uma mensagem. */
export interface ScheduleShape {
  readonly scheduleKind: ScheduleKind;
  readonly everySeconds: number | null;
  readonly timeOfDay: string | null;
  readonly weekdays: readonly number[];
  readonly runAt: number | null;
  readonly timeZone: string;
}

/**
 * Quantas voltas de calendário o `daily`/`weekly` procura antes de
 * desistir.
 *
 * Oito dias cobrem qualquer combinação de dias da semana (uma
 * semana inteira, mais a volta). Existir um teto é o que impede um
 * `weekdays` vazio de virar laço infinito — e `weekdays` vazio num
 * `weekly` é configuração inválida, que a rota recusa e que aqui
 * vira `null` em vez de travar o relógio.
 */
const MAX_DAY_PROBES = 8;

/**
 * O primeiro horário DEPOIS de `from` em que esta mensagem sai.
 *
 * `null` = não há próxima. Acontece no `once` já passado, no
 * `weekly` sem dia nenhum marcado e em qualquer configuração que
 * não faça sentido — e `null` é melhor que um chute, porque uma
 * mensagem sem próxima aparece na tela como "sem próxima" em vez de
 * sair numa hora que ninguém pediu.
 *
 * O corte é ESTRITO (`> from`): sem isso, uma mensagem que acabou
 * de sair teria como próxima ela mesma, e o relógio a repetiria na
 * volta seguinte.
 */
export function nextOccurrence(message: ScheduleShape, from: number): number | null {
  switch (message.scheduleKind) {
    case 'interval':
      return nextInterval(message, from);

    case 'daily':
      return nextDaily(message, from);

    case 'weekly':
      return nextWeekly(message, from);

    case 'once':
      // A `once` que já passou não tem próxima — e é isso que faz
      // ela se desligar sozinha depois de sair. Uma "manutenção às
      // 03:00" que continuasse ligada reapareceria no mês seguinte,
      // sozinha, sem manutenção nenhuma.
      return message.runAt !== null && message.runAt > from ? message.runAt : null;
  }
}

/**
 * O horário seguinte de uma mensagem que ACABOU de sair.
 *
 * Diferente de `nextOccurrence(message, agora)` num ponto que é o
 * ponto: no `interval`, a conta parte do horário PREVISTO
 * (`scheduledFor`), e não do instante do envio. É isso que faz "a
 * cada 30 min" andar de 30 em 30 sem deriva acumulada.
 *
 * `scheduledFor` é o `next_at` que estava gravado. Quando ele é
 * `null` (mensagem recém-criada, ou enviada pelo botão de testar
 * — que não passa por aqui), a base é o instante do envio.
 */
export function advanceAfterSend(
  message: ScheduleShape,
  scheduledFor: number | null,
  sentAt: number,
): number | null {
  if (message.scheduleKind !== 'interval') {
    return nextOccurrence(message, sentAt);
  }

  const everyMs = intervalMs(message);

  if (everyMs === null) {
    return null;
  }

  return advanceInterval(scheduledFor ?? sentAt, everyMs, sentAt);
}

/**
 * Anda de `everyMs` em `everyMs` a partir de `anchor` até passar de
 * `after`.
 *
 * ####  O SALTO É EM UM CÁLCULO, E NÃO NUM LAÇO  ####
 *
 * O agente pode ter ficado horas fora do ar. Um `while` andando de
 * meia em meia hora seria correto e lento; a divisão faz o mesmo
 * numa conta — e, mais importante, não deixa a duração do cálculo
 * depender de quanto tempo o processo ficou parado.
 */
export function advanceInterval(anchor: number, everyMs: number, after: number): number {
  if (anchor > after) {
    return anchor;
  }

  const missed = Math.floor((after - anchor) / everyMs) + 1;

  return anchor + missed * everyMs;
}

/**
 * A mensagem pode sair AGORA, pela janela de horário?
 *
 * `null` nos dois lados = a qualquer hora. Um lado só preenchido é
 * configuração pela metade, e ela vale como "a qualquer hora"
 * também: recusar em silêncio faria a mensagem sumir sem motivo
 * visível na tela.
 *
 * ####  A JANELA QUE VIRA A MEIA-NOITE  ####
 *
 * `22:00`–`02:00` significa "das dez da noite às duas da manhã", e
 * não "nunca". Quando o começo é maior que o fim, a janela é a
 * UNIÃO de dois pedaços (do começo ao fim do dia, e do início do
 * dia até o fim) — que é o `||` abaixo.
 */
export function isWithinWindow(
  now: number,
  windowFrom: string | null,
  windowTo: string | null,
  timeZone: string,
): boolean {
  if (windowFrom === null || windowTo === null) {
    return true;
  }

  const start = parseMinutesOfDay(windowFrom);
  const end = parseMinutesOfDay(windowTo);

  if (start === null || end === null) {
    return true;
  }

  const minutes = localMinutesOfDay(now, timeZone);

  if (start === end) {
    // Começo igual ao fim é o dia inteiro, e não um instante só:
    // ninguém configura uma janela de um minuto por engano, e a
    // leitura contrária deixaria a mensagem calada para sempre.
    return true;
  }

  if (start < end) {
    return minutes >= start && minutes < end;
  }

  return minutes >= start || minutes < end;
}

// ------------------------------------------------------------
//  Os quatro ritmos
// ------------------------------------------------------------

/**
 * O intervalo em milissegundos. `null` quando ele não serve.
 *
 * Sem piso artificial: quem decide o mínimo é a rota (que recusa
 * abaixo de 10 s, porque um aviso de 3 em 3 segundos é ruído, não
 * configuração). Aqui só se recusa o que não é número de verdade —
 * zero ou negativo travaria o `advanceInterval` num laço de
 * divisão por zero.
 */
function intervalMs(message: ScheduleShape): number | null {
  const every = message.everySeconds;

  if (every === null || !Number.isFinite(every) || every <= 0) {
    return null;
  }

  return Math.round(every * 1000);
}

function nextInterval(message: ScheduleShape, from: number): number | null {
  const everyMs = intervalMs(message);

  if (everyMs === null) {
    return null;
  }

  // Sem âncora, a primeira sai um intervalo depois de agora — e não
  // imediatamente. Criar "a cada 30 minutos" e ver a mensagem no
  // chat no mesmo segundo é o comportamento que faz o admin achar
  // que criou errado.
  return from + everyMs;
}

function nextDaily(message: ScheduleShape, from: number): number | null {
  const time = message.timeOfDay === null ? null : parseTimeOfDay(message.timeOfDay);

  if (time === null) {
    return null;
  }

  // Começa HOJE no fuso da mensagem: o horário de hoje ainda pode
  // estar no futuro. Só se ele já passou é que vira amanhã.
  let date = toLocalDate(from, message.timeZone);

  for (let probe = 0; probe < 2; probe += 1) {
    const instant = zonedTimeToUtc(date, time.hour, time.minute, message.timeZone);

    if (instant > from) {
      return instant;
    }

    date = addDays(date, 1);
  }

  return null;
}

function nextWeekly(message: ScheduleShape, from: number): number | null {
  const time = message.timeOfDay === null ? null : parseTimeOfDay(message.timeOfDay);

  if (time === null) {
    return null;
  }

  const wanted = new Set(message.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));

  if (wanted.size === 0) {
    return null;
  }

  // Anda dia a dia no CALENDÁRIO. A alternativa — calcular quantos
  // dias faltam para o próximo dia da semana e somar em ms — erra
  // exatamente na semana em que o fuso muda de offset, que é o caso
  // que este módulo inteiro existe para acertar.
  let date = toLocalDate(from, message.timeZone);

  for (let probe = 0; probe < MAX_DAY_PROBES; probe += 1) {
    const instant = zonedTimeToUtc(date, time.hour, time.minute, message.timeZone);

    if (instant > from && wanted.has(localWeekday(instant, message.timeZone))) {
      return instant;
    }

    date = addDays(date, 1);
  }

  return null;
}

// ------------------------------------------------------------
//  Para a tela
// ------------------------------------------------------------

/**
 * "30 min", "toda quinta às 16:00", "1× 25/08".
 *
 * Mora aqui, e não no painel, porque é a mesma frase que o log do
 * agente escreve — duas versões dela divergiriam no primeiro ajuste,
 * e a que ninguém lê seria a errada.
 */
export function describeSchedule(message: Pick<MessageView, keyof ScheduleShape>): string {
  switch (message.scheduleKind) {
    case 'interval': {
      const every = message.everySeconds;

      if (every === null || every <= 0) {
        return 'sem ritmo';
      }

      if (every % 86_400 === 0) {
        return `${String(every / 86_400)} dia(s)`;
      }

      if (every % 3_600 === 0) {
        return `${String(every / 3_600)} h`;
      }

      if (every % 60 === 0) {
        return `${String(every / 60)} min`;
      }

      return `${String(every)} s`;
    }

    case 'daily':
      return `todo dia às ${message.timeOfDay ?? '??:??'}`;

    case 'weekly': {
      const names = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
      const days = [...message.weekdays]
        .filter((day) => day >= 0 && day <= 6)
        .sort((a, b) => a - b)
        .map((day) => names[day] ?? String(day));

      return days.length === 0
        ? 'sem dia marcado'
        : `${days.join(', ')} às ${message.timeOfDay ?? '??:??'}`;
    }

    case 'once':
      return message.runAt === null
        ? 'uma vez'
        : `1× ${formatLocal(message.runAt, message.timeZone)}`;
  }
}

/**
 * `1758765600000` -> `25/08 02:00`, no fuso da MENSAGEM.
 *
 * No fuso dela, e não no de quem lê a tela: o admin pode estar em
 * Lisboa cuidando de um servidor brasileiro, e "02:00" ali seria
 * outra hora.
 */
function formatLocal(epochMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    // Zona que este runtime não conhece. A rota já recusa isso na
    // gravação; aqui uma frase de lista não pode quebrar por causa
    // de uma linha antiga.
    return new Date(epochMs).toISOString();
  }
}
