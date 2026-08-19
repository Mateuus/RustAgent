// ============================================================
//  timezone-bridge.ts  -  a ponte de fuso, e ela é PROVISÓRIA.
//
//  ####  ESTE ARQUIVO PASSA A DELEGAR PARA core/src/wipe/schedule.ts
//        (Frente A) ASSIM QUE ELA ENTRAR  ####
//
//  As mensagens e o wipe contam tempo do MESMO jeito — "a cada 7
//  dias" são sete voltas do calendário local, e não 604 800 000 ms
//  — e o Docs/17 diz, com todas as letras, que as funções de fuso
//  são as do wipe. Só que as duas frentes foram construídas em
//  paralelo, em árvores separadas: quando este módulo nasceu,
//  `core/src/wipe/schedule.ts` ainda não existia aqui.
//
//  Então isto não é uma segunda implementação por preguiça: é o
//  ponto ÚNICO em que o módulo de mensagens fala de fuso, escrito
//  para ser esvaziado numa linha. Quando a Frente A entrar, o corpo
//  de cada função abaixo vira um `export { ... } from
//  '../wipe/schedule.js'` — e nada mais no módulo de mensagens
//  precisa mudar, porque nada mais no módulo de mensagens conhece
//  `Intl`.
//
//  ------------------------------------------------------------
//  ####  POR QUE UM MÓDULO, E NÃO AS FUNÇÕES ESPALHADAS  ####
//
//  Porque a substituição precisa ser conferível. Cálculo de fuso
//  espalhado por três arquivos daria três lugares para a integração
//  esquecer um — e o que sobrasse erraria só na semana em que o
//  horário de verão muda, meses depois, sem nada apontando para cá.
//
//  ------------------------------------------------------------
//  ####  E TODO INSTANTE CONTINUA SENDO EPOCH MS EM UTC  ####
//
//  Horário local NUNCA vira um instante com fuso embutido: ele é o
//  texto `HH:MM` MAIS a zona IANA, e os dois só viram instante
//  aqui dentro. Ver Docs/16 §14, decisão 7.
// ============================================================

/**
 * Um dia no calendário local, sem hora.
 *
 * É a unidade em que a repetição conta: "toda quinta" e "a cada 7
 * dias" são voltas do CALENDÁRIO, e a diferença para a aritmética
 * de milissegundos aparece na semana em que o fuso muda de offset.
 */
export interface LocalDate {
  readonly year: number;
  /** 1-based, como o humano escreve. */
  readonly month: number;
  readonly day: number;
}

/**
 * Que dia é, no fuso pedido, o instante `epochMs`.
 *
 * `en-CA` porque ele formata como `2026-08-05` — ordem fixa e
 * zero-padded. Depender do locale da máquina aqui produziria
 * `05/08/2026` num host e `8/5/2026` noutro.
 */
export function toLocalDate(epochMs: number, timeZone: string): LocalDate {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));

  const [year, month, day] = formatted.split('-').map(Number);

  // Os três são sempre números aqui: o formato acima é fixo. O
  // `?? 0` existe porque `split` devolve `(string|undefined)[]`
  // para o compilador, e um `!` seria mentir onde ele está certo.
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

/**
 * Que horas são, no fuso pedido, em MINUTOS desde a meia-noite.
 *
 * É o que a janela ("só entre 22:00 e 02:00") compara, e é por isso
 * que ela não pode ser feita com `new Date().getHours()`: aquilo
 * responde no fuso da MÁQUINA, e a mensagem é da rede.
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

/**
 * O dia da semana naquele fuso, com 0 = domingo.
 *
 * Zero é domingo porque é o que o contrato de `MessageView.weekdays`
 * diz (types/messages.ts) — e porque é o que o `getUTCDay` do
 * JavaScript já usa, o que evita uma tradução a mais no meio.
 */
export function localWeekday(epochMs: number, timeZone: string): number {
  const date = toLocalDate(epochMs, timeZone);

  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Quantos minutos o fuso está À FRENTE do UTC naquele instante.
 *
 * Calculado por diferença, e não por tabela: formata o instante nos
 * dois fusos e subtrai. Funciona para qualquer zona IANA, inclusive
 * as de offset quebrado (Índia, +05:30) e as que mudam de offset no
 * meio do ano.
 */
export function zoneOffsetMinutes(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };

  const hour = get('hour') % 24;

  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );

  // A divisão é exata: os dois lados estão em segundos inteiros.
  return (asIfUtc - Math.floor(epochMs / 1000) * 1000) / 60_000;
}

/**
 * O instante UTC de "tal dia, tal hora, naquele fuso".
 *
 * ####  POR QUE DUAS PASSADAS  ####
 *
 * Para saber o offset é preciso um instante; para achar o instante
 * é preciso o offset. A saída é chutar (tratar o horário local como
 * se fosse UTC), medir o offset ALI, corrigir, e medir de novo — a
 * segunda medição pega o caso em que a correção atravessou a
 * mudança de horário de verão e caiu num offset diferente.
 *
 * Nas horas que NÃO EXISTEM (a madrugada em que o relógio pula para
 * frente) o resultado é o instante equivalente logo depois do
 * salto. Recusar a configuração seria pior: o admin escreveria um
 * horário legítimo e a mensagem não sairia nunca.
 */
export function zonedTimeToUtc(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);

  const firstGuess = naive - zoneOffsetMinutes(naive, timeZone) * 60_000;
  const secondOffset = zoneOffsetMinutes(firstGuess, timeZone);

  return naive - secondOffset * 60_000;
}

/** Anda `days` dias no calendário, sem passar por epoch. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

/** `HH:MM` -> hora e minuto. `null` quando não é isso. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());

  if (match === null) {
    return null;
  }

  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** `HH:MM` -> minutos desde a meia-noite. `null` quando não é isso. */
export function parseMinutesOfDay(value: string): number | null {
  const parsed = parseTimeOfDay(value);

  return parsed === null ? null : parsed.hour * 60 + parsed.minute;
}

/**
 * A zona existe neste runtime?
 *
 * A conferência é na BORDA (a rota), e não no motor: uma zona
 * inválida gravada no banco faria a mensagem falhar de madrugada,
 * longe de quem a digitou.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}
