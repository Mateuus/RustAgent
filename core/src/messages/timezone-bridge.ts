// ============================================================
//  timezone-bridge.ts  -  o fuso das mensagens, DELEGADO ao wipe.
//
//  ####  A CONTA DE FUSO É UMA SÓ, E ELA MORA EM wipe/schedule.ts
//
//  As mensagens e o wipe contam tempo do MESMO jeito — "a cada 7
//  dias" são sete voltas do calendário local, e não 604 800 000 ms
//  — e o Docs/17 §10 diz, com todas as letras, que as funções de
//  fuso são as do wipe. Este arquivo nasceu com uma cópia porque as
//  duas frentes foram construídas em paralelo, em árvores
//  separadas: quando ele foi escrito, `core/src/wipe/schedule.ts`
//  ainda não existia aqui.
//
//  Na integração das duas, a cópia saiu. O que resta abaixo é
//  reexportação — a mesma função, com o nome que o módulo de
//  mensagens usa — mais as DUAS contas que só as mensagens
//  precisam e que o wipe não tem:
//
//      localMinutesOfDay   que horas são, em minutos desde a
//                          meia-noite: é o que a JANELA compara
//      parseMinutesOfDay   `HH:MM` -> minutos, construído sobre o
//                          `parseTimeOfDay` do wipe
//
//  ------------------------------------------------------------
//  ####  POR QUE O ARQUIVO CONTINUA EXISTINDO  ####
//
//  Porque ele é o ponto ÚNICO em que o módulo de mensagens fala de
//  fuso. Espalhar os `import` de `wipe/schedule.js` por
//  `messages/schedule.ts` e pelas rotas amarraria o módulo inteiro
//  ao wipe — e o combinado do Docs/16 §11 é o contrário: mensagens
//  não sabe o que é um wipe. Uma porta só, e ela é esta.
//
//  ------------------------------------------------------------
//  ####  E TODO INSTANTE CONTINUA SENDO EPOCH MS EM UTC  ####
//
//  Horário local NUNCA vira um instante com fuso embutido: ele é o
//  texto `HH:MM` MAIS a zona IANA, e os dois só viram instante
//  aqui dentro. Ver Docs/16 §14, decisão 7.
// ============================================================

import {
  localDateInZone,
  parseTimeOfDay,
  weekdayInZone,
} from '../wipe/schedule.js';

export {
  addDays,
  isValidTimeZone,
  parseTimeOfDay,
  zoneOffsetMinutes,
  zonedTimeToUtc,
} from '../wipe/schedule.js';

export type { LocalDate } from '../wipe/schedule.js';

/**
 * Que dia é, no fuso pedido, o instante `epochMs`.
 *
 * É o `localDateInZone` do wipe. O nome daqui é outro porque o
 * módulo de mensagens já o chamava assim em quatro lugares, e
 * renomear a chamada não muda uma vírgula do que ele faz.
 */
export const toLocalDate = localDateInZone;

/**
 * O dia da semana naquele fuso, com 0 = domingo.
 *
 * É o `weekdayInZone` do wipe. Zero é domingo porque é o que o
 * contrato de `MessageView.weekdays` diz (types/messages.ts) — e é
 * a mesma convenção que o wipe usa, o que era o ponto de as duas
 * contas serem uma só.
 */
export const localWeekday = weekdayInZone;

/**
 * Que horas são, no fuso pedido, em MINUTOS desde a meia-noite.
 *
 * É o que a janela ("só entre 22:00 e 02:00") compara, e é por isso
 * que ela não pode ser feita com `new Date().getHours()`: aquilo
 * responde no fuso da MÁQUINA, e a mensagem é da rede.
 *
 * ####  POR QUE ESTA NÃO DELEGA  ####
 *
 * O wipe não tem equivalente: ele pergunta o DIA e monta a hora a
 * partir da configuração, e nunca "que horas são ali agora".
 * Derivá-la de `zonedTimeToUtc(meia-noite)` daria a resposta errada
 * justamente no dia em que o relógio pula: entre o salto e a
 * meia-noite seguinte, a distância até a meia-noite local deixa de
 * ser o horário local. Então ela é medida, e não calculada — e é o
 * ÚNICO `Intl` que sobrou em `messages/`.
 */
export function localMinutesOfDay(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(epochMs));

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };

  // `hour12: false` devolve 24 para a meia-noite em algumas versões
  // do ICU. 24 e 0 são o mesmo minuto do dia.
  return (get('hour') % 24) * 60 + get('minute');
}

/** `HH:MM` -> minutos desde a meia-noite. `null` quando não é isso. */
export function parseMinutesOfDay(value: string): number | null {
  const parsed = parseTimeOfDay(value);

  return parsed === null ? null : parsed.hour * 60 + parsed.minute;
}
