// ============================================================
//  schedule.ts  -  QUANDO o servidor zera.
//
//  Cálculo puro: entra a configuração e um instante, sai a lista
//  de wipes. Sem banco, sem RCON e sem relógio próprio — o `now`
//  vem sempre por parâmetro. É o que torna este módulo testável
//  contra datas do passado e do futuro sem mexer no relógio da
//  máquina.
//
//  Quem grava é db/wipe-schedule-repository.ts; quem responde
//  HTTP é http/routes/wipe.ts. Aqui não há efeito nenhum.
//
//  ------------------------------------------------------------
//  ####  SÃO DOIS CALENDÁRIOS, E ELES NÃO SE CONHECEM  ####
//
//    FORÇADO   toda primeira quinta-feira do mês, 19:00 UTC.
//              É da Facepunch. A atualização mensal muda o
//              protocolo e invalida o save do mundo: o wipe
//              acontece querendo ou não. NÃO é opcional, e por
//              isso não existe configuração para desligá-lo.
//
//    CADÊNCIA  a nossa: a cada N dias, no horário local que o
//              dono do servidor escolher.
//
//  Os dois colidem — cadência de 7 dias ancorada no domingo com o
//  forçado numa quinta produz dois wipes em quatro dias. A §3
//  deste arquivo trata disso, com as três políticas do Docs/16 §5.
//
//  ------------------------------------------------------------
//  ####  A REGRA É DERIVADA, NUNCA UMA TABELA DE DATAS  ####
//
//  Existe a tentação de chumbar "06/08/2026, 03/09/2026, …" num
//  array. Uma lista dessas envelhece em silêncio: no dia em que
//  ela acaba, o agente para de agendar e ninguém percebe até o
//  wipe não acontecer. "Primeira quinta às 19:00 UTC" é derivável
//  em dez linhas e vale para sempre.
//
//  ------------------------------------------------------------
//  ####  AS FUNÇÕES DE FUSO DA §2 SÃO CONTRATO PÚBLICO  ####
//
//  Elas estão exportadas porque o agendador de MENSAGENS (Frente
//  E, Docs/17) usa ESTAS, e não uma segunda cópia: "a cada 7
//  dias" e "toda quinta às 20:00" contam dias de CALENDÁRIO nos
//  dois módulos, e a diferença entre uma implementação e outra só
//  apareceria na semana em que o fuso muda de offset — que é
//  exatamente a semana em que ninguém está olhando para isso.
// ============================================================

import type { BpPolicy, CollisionPolicy, PlannedWipe, WipeSettings } from '../types/wipe.js';

// ------------------------------------------------------------
//  §1  O WIPE FORÇADO
// ------------------------------------------------------------

/**
 * A hora UTC do wipe forçado.
 *
 * 19:00 UTC = 16:00 em Brasília. O valor é da Facepunch e não é
 * configurável: mudar isto não muda o jogo, só faria o agente
 * mentir sobre quando o servidor vai cair.
 */
export const FORCED_WIPE_HOUR_UTC = 19;

/** Quinta-feira, na numeração do `Date` (0 = domingo). */
const THURSDAY = 4;

/**
 * O instante do wipe forçado do mês de `year`/`month`.
 *
 * `month` é 0-based, como no `Date` — o parâmetro é consumido
 * direto pelo `Date.UTC`, e converter aqui só criaria um lugar a
 * mais para errar em um. `month = 12` é janeiro do ano seguinte e
 * `month = -1` é dezembro do anterior: quem normaliza é o próprio
 * `Date.UTC`, e por isso a virada do ano não tem caso especial.
 */
export function forcedWipeOfMonth(year: number, month: number): number {
  // Que dia da semana é o dia 1?
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();

  // Quantos dias faltam dele até a quinta. O `% 7` cobre o mês que
  // já COMEÇA numa quinta (resto 0, dia 1) e o que começa numa
  // sexta (resto 6, dia 7).
  const day = 1 + ((THURSDAY - firstWeekday + 7) % 7);

  return Date.UTC(year, month, day, FORCED_WIPE_HOUR_UTC, 0, 0, 0);
}

/**
 * O próximo wipe forçado DEPOIS de `from`.
 *
 * Estritamente depois: chamado exatamente às 19:00 de uma primeira
 * quinta, devolve o do mês seguinte. É o que impede um agendador
 * que roda no segundo exato de reagendar o wipe que ele acabou de
 * executar.
 */
export function nextForcedWipe(from: number): number {
  const reference = new Date(from);
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();

  const thisMonth = forcedWipeOfMonth(year, month);

  if (thisMonth > from) {
    return thisMonth;
  }

  return forcedWipeOfMonth(year, month + 1);
}

/**
 * O forçado imediatamente ANTES de `instant`.
 *
 * Volta no máximo um mês: entre dois forçados nunca há mais de 35
 * dias, então o de "dois meses atrás" nunca é o mais recente.
 */
export function lastForcedWipeBefore(instant: number): number {
  const reference = new Date(instant);
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();

  const thisMonth = forcedWipeOfMonth(year, month);

  return thisMonth < instant ? thisMonth : forcedWipeOfMonth(year, month - 1);
}

/**
 * Todos os forçados dentro de `(from, to]`.
 *
 * Lista vazia quando a janela é menor que um mês e não pega
 * nenhuma primeira quinta — o que é normal, e não erro.
 */
export function forcedWipesBetween(from: number, to: number): readonly number[] {
  const found: number[] = [];

  let cursor = nextForcedWipe(from);

  while (cursor <= to) {
    found.push(cursor);
    cursor = nextForcedWipe(cursor);
  }

  return found;
}

// ------------------------------------------------------------
//  §2  FUSO HORÁRIO  (contrato público — ver o cabeçalho)
//
//  ####  O DADO É UTC. O FUSO É DA EXIBIÇÃO E DO AGENDAMENTO. ####
//
//  O forçado é definido em UTC; a cadência é definida no horário
//  que o dono do servidor pensa ("wipe às 16h"). Guardar as duas
//  no mesmo campo sem fuso é como se erra — e o erro não aparece
//  em teste, aparece em novembro, quando o horário de verão do
//  hemisfério norte muda a distância entre 19:00 UTC e o relógio
//  de quem opera.
//
//  Aqui dentro tudo é epoch ms. O fuso entra só para responder
//  "que instante é o dia D às 16:00 EM São Paulo".
// ------------------------------------------------------------

/**
 * Um dia no calendário local, sem hora.
 *
 * É a unidade em que a cadência conta: "a cada 7 dias" é sete
 * VOLTAS DO CALENDÁRIO, e não 7 × 86 400 000 ms — a diferença
 * aparece na semana em que o fuso muda de offset.
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
export function localDateInZone(epochMs: number, timeZone: string): LocalDate {
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
 * Quantos minutos o fuso está À FRENTE do UTC naquele instante.
 *
 * Calculado por diferença, e não por tabela: formata o instante no
 * fuso pedido, lê o resultado como se fosse UTC e subtrai.
 * Funciona para qualquer zona IANA, inclusive as de offset
 * quebrado (Índia, +05:30) e as que mudam de offset no meio do
 * ano.
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

  // `hour12: false` pode devolver 24 para a meia-noite em algumas
  // versões do ICU. 24 e 0 são o mesmo instante do MESMO dia (o
  // dia já vem correto nos outros campos), então normalizar aqui é
  // seguro.
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
 * é preciso o offset. A saída é chutar (tratar o horário local
 * como se fosse UTC), medir o offset ALI, corrigir, e medir de
 * novo — a segunda medição pega o caso em que a correção
 * atravessou a mudança de horário de verão e caiu num offset
 * diferente do medido.
 *
 * Nas horas que NÃO EXISTEM (a madrugada em que o relógio pula
 * para frente) o resultado é o instante equivalente logo depois do
 * salto — a alternativa seria recusar a configuração, e recusar um
 * horário de wipe porque ele não existe uma vez por ano em outro
 * hemisfério é pior que deslocá-lo em uma hora.
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

/** Distância em dias de calendário entre duas datas locais. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);

  return Math.round((b - a) / 86_400_000);
}

/**
 * Que dia da semana é, NAQUELE fuso, o instante `epochMs`.
 *
 * 0 = domingo, como no `Date` e como na coluna `weekdays` das
 * mensagens (Docs/16 §7). O dia sai do calendário local primeiro:
 * às 21:00 de uma sexta em São Paulo já é sábado em UTC, e uma
 * mensagem "toda sexta" sairia no dia errado se a pergunta fosse
 * feita ao relógio UTC.
 */
export function weekdayInZone(epochMs: number, timeZone: string): number {
  const date = localDateInZone(epochMs, timeZone);

  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** `HH:MM` -> hora e minuto. `null` quando não é isso. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());

  if (match === null) {
    return null;
  }

  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** A zona IANA existe neste runtime? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
//  §3  A AGENDA
// ------------------------------------------------------------

/**
 * O padrão de um servidor recém-instalado.
 *
 * ####  A CADÊNCIA NASCE DESLIGADA  ####
 *
 * Um agente que acabou de subir não tem opinião sobre quando zerar
 * o servidor de ninguém. Só o forçado aparece — e ele apareceria
 * de qualquer jeito.
 *
 * O forçado nasce com `keep` pela mesma disciplina: o force wipe
 * da Facepunch apaga o MAPA, e só leva blueprint quando eles mexem
 * no sistema de itens (uma ou duas vezes por ano). Nascer com
 * `wipe` faria o agente endurecer o jogo além do que o próprio
 * jogo faz.
 */
export const DEFAULT_WIPE_SETTINGS: WipeSettings = {
  cadence: {
    enabled: false,
    everyDays: 7,
    anchorAt: 0,
    timeOfDay: '16:00',
    timeZone: 'America/Sao_Paulo',
    bpPolicy: 'keep',
  },
  forced: {
    bpPolicy: 'keep',
  },
  collision: {
    policy: 'reanchor',
    windowHours: 24,
  },
};

/**
 * Teto de linhas de cadência por chamada.
 *
 * Com `everyDays = 1` e uma janela de um ano são ~366 voltas;
 * qualquer coisa muito além disso é sinal de configuração absurda,
 * e um laço infinito num processo que atende HTTP é pior que uma
 * agenda truncada.
 */
const MAX_CADENCE_ENTRIES = 1_000;

/**
 * Os wipes de `(from, to]`, na ordem em que acontecem.
 *
 * ####  POR QUE OS DOIS CALENDÁRIOS SÃO GERADOS JUNTOS  ####
 *
 * A política `reanchor` faz a cadência DEPENDER dos forçados: cada
 * forçado reinicia a contagem. Gerar as duas listas em separado e
 * juntar depois não expressaria isso — seria preciso um segundo
 * passe corrigindo a primeira lista, que é a mesma coisa escrita
 * de um jeito mais difícil de conferir.
 *
 * Então: percorre o tempo uma vez, do mais antigo para o mais
 * novo, com o marco zero da cadência mudando no caminho.
 */
export function buildSchedule(
  settings: WipeSettings,
  from: number,
  to: number,
): readonly PlannedWipe[] {
  const forced = forcedWipesBetween(from, to);

  const plans: PlannedWipe[] = forced.map((scheduledAt) => ({
    scheduledAt,
    kind: 'forced' as const,
    bpPolicy: settings.forced.bpPolicy,
    absorbedBy: null,
  }));

  const cadence = settings.cadence;

  if (cadence.enabled && cadence.everyDays >= 1) {
    const time = parseTimeOfDay(cadence.timeOfDay);
    const zoneOk = isValidTimeZone(cadence.timeZone);

    // ####  CONFIGURAÇÃO INVÁLIDA NÃO DERRUBA A AGENDA  ####
    //
    // Os forçados continuam listados, que é o dado mais importante
    // da tela. A validação de verdade está na borda HTTP; aqui a
    // tolerância existe para uma linha escrita à mão no SQLite não
    // apagar o calendário inteiro.
    if (time !== null && zoneOk) {
      plans.push(...cadenceWipes(settings, time, forced, from, to));
    }
  }

  return plans.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

function cadenceWipes(
  settings: WipeSettings,
  time: { hour: number; minute: number },
  forced: readonly number[],
  from: number,
  to: number,
): readonly PlannedWipe[] {
  const cadence = settings.cadence;
  const zone = cadence.timeZone;
  const policy: CollisionPolicy = settings.collision.policy;
  const bpPolicy: BpPolicy = cadence.bpPolicy;
  const found: PlannedWipe[] = [];

  // O marco zero, em dia de calendário local.
  let anchor = localDateInZone(cadence.anchorAt, zone);

  // ####  AVANÇAR EM SALTOS, E NÃO DIA A DIA  ####
  //
  // Um marco zero de 2020 com cadência de 1 dia daria mais de dois
  // mil voltas de laço até chegar em `from`. A aritmética abaixo
  // pula direto para o último múltiplo antes de `from`.
  const startDay = localDateInZone(from, zone);
  const elapsed = daysBetween(anchor, startDay);

  if (elapsed > 0) {
    const skipped = Math.floor(elapsed / cadence.everyDays) * cadence.everyDays;
    anchor = addDays(anchor, skipped);
  }

  // ####  O MARCO ZERO, COMO INSTANTE  ####
  //
  // Ele é rastreado em epoch — e não só como dia — porque a
  // política `reanchor` precisa perguntar "que forçados são
  // POSTERIORES ao marco atual?". Com o dia só, o próprio forçado
  // que acabou de virar marco continuaria satisfazendo a busca, e a
  // cadência reancoraria nele para sempre sem nunca avançar.
  let anchorInstant = zonedTimeToUtc(anchor, time.hour, time.minute, zone);

  // `reanchor`: o último forçado ANTES da janela também recontou a
  // cadência. Sem isto, a agenda mostrada hoje sairia diferente da
  // que o agente vai executar amanhã, e a diferença apareceria como
  // um wipe que "andou sozinho".
  if (policy === 'reanchor') {
    const previousForced = lastForcedWipeBefore(from);

    if (previousForced > anchorInstant) {
      anchor = localDateInZone(previousForced, zone);
      anchorInstant = previousForced;
    }
  }

  const windowMs = settings.collision.windowHours * 3_600_000;

  // ####  A ABSORÇÃO OLHA UM FORÇADO ANTES DA JANELA  ####
  //
  // `forced` só tem os que caem DENTRO de (from, to]. Sem a linha
  // abaixo, consultar a agenda no dia 7 esconderia o fato de o wipe
  // do dia 9 ter sido absorvido pelo forçado do dia 6 — a mesma
  // configuração daria respostas diferentes conforme a hora da
  // pergunta, e o wipe reapareceria sozinho na tela.
  const absorptionCandidates = [lastForcedWipeBefore(from), ...forced];

  let cursor = anchor;

  for (let guard = 0; guard < MAX_CADENCE_ENTRIES; guard += 1) {
    cursor = addDays(cursor, cadence.everyDays);

    const scheduledAt = zonedTimeToUtc(cursor, time.hour, time.minute, zone);

    if (scheduledAt > to) {
      break;
    }

    // `reanchor`: um forçado entre o marco atual e este wipe
    // recomeça a contagem A PARTIR DELE — o wipe que viria agora é
    // descartado e recalculado a partir do forçado.
    //
    // A comparação é contra `anchorInstant`, e não contra o último
    // wipe da lista: o forçado que acabou de virar marco precisa
    // sair da busca, senão a cadência reancora nele de novo a cada
    // volta e nunca passa dali.
    if (policy === 'reanchor') {
      const between = forced.find((instant) => instant > anchorInstant && instant < scheduledAt);

      if (between !== undefined) {
        cursor = localDateInZone(between, zone);
        anchorInstant = between;
        continue;
      }
    }

    // ####  EMPATE EXATO: O FORÇADO VENCE, EM QUALQUER POLÍTICA ####
    //
    // Cadência de 7 dias reancorada num forçado cai exatamente em
    // cima do forçado seguinte quando os dois distam múltiplo de 7
    // — e aí a agenda mostraria DOIS wipes no mesmo segundo. Não é
    // uma colisão a decidir por configuração: é a mesma parada de
    // servidor, contada duas vezes.
    if (forced.includes(scheduledAt)) {
      if (policy === 'reanchor') {
        anchorInstant = scheduledAt;
      }

      continue;
    }

    if (scheduledAt <= from) {
      continue;
    }

    const absorbedBy =
      policy === 'absorb'
        ? (absorptionCandidates.find((instant) => Math.abs(instant - scheduledAt) <= windowMs) ??
          null)
        : null;

    found.push({ scheduledAt, kind: 'cadence', bpPolicy, absorbedBy });
  }

  return found;
}

/**
 * O PRÓXIMO wipe que vai acontecer de verdade.
 *
 * O absorvido fica de fora: ele está na lista para a tela poder
 * explicar um dia sem wipe, não para ser executado.
 *
 * `null` quando não há nenhum na janela — o que só acontece com
 * horizonte curto demais, já que o forçado é mensal.
 */
export function nextWipe(
  settings: WipeSettings,
  from: number,
  horizonDays = 90,
): PlannedWipe | null {
  const to = from + horizonDays * 86_400_000;

  return buildSchedule(settings, from, to).find((plan) => plan.absorbedBy === null) ?? null;
}
