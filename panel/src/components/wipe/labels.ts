// ============================================================
//  labels.ts  -  as palavras da aba WIPE, e as contas puras que
//  as duas sub-abas fazem em cima da agenda.
//
//  Existe para que Geral e Agenda digam a MESMA coisa com as
//  mesmas palavras: "BP mantidos" numa tela e "blueprints
//  preservados" na outra descreveriam a mesma política e pareceriam
//  duas configurações diferentes.
//
//  Nada aqui toca em React nem em rede — é tudo função pura, e é o
//  que o teste do painel cobre.
// ============================================================

import type { CalendarMark } from '@/components/wipe/calendar-month';
import type { BpPolicy, CollisionPolicy, MapSource, WipePlan, WipePlanKind } from '@/lib/api';
import { EM_DASH } from '@/lib/format';

export const BP_POLICY_LABEL: Readonly<Record<BpPolicy, string>> = {
  keep: 'Mantém os blueprints',
  wipe: 'Zera os blueprints',
  wipe_except_vip: 'Zera, menos para quem tem VIP',
};

/** A versão curta, para caber numa linha de lista. */
export const BP_POLICY_SHORT: Readonly<Record<BpPolicy, string>> = {
  keep: 'BP mantidos',
  wipe: 'BP zerados',
  wipe_except_vip: 'BP só de VIP',
};

export const KIND_LABEL: Readonly<Record<WipePlanKind, string>> = {
  cadence: 'Cadência',
  forced: 'Forçado',
  manual: 'Manual',
};

export const COLLISION_LABEL: Readonly<Record<CollisionPolicy, string>> = {
  reanchor: 'Reancorar — o forçado vira o novo marco zero',
  absorb: 'Absorver — cancelar o da cadência que cair perto',
  ignore: 'Ignorar — os dois acontecem',
};

export const COLLISION_HINT: Readonly<Record<CollisionPolicy, string>> = {
  reanchor:
    'A cadência passa a contar a partir do forçado. É o mais previsível para o jogador, e é o padrão.',
  absorb:
    'O wipe de cadência dentro da janela abaixo é cancelado, e o forçado ocupa o lugar dele. Serve para cadência longa (15 ou 30 dias).',
  ignore:
    'Nenhum ajuste. Pode dar dois wipes em quatro dias, e o segundo pega bases de dois dias.',
};

/**
 * De onde sai o mundo, na frase que a agenda mostra.
 *
 * ####  `random` NÃO É "SORTEADO NA HORA"  ####
 *
 * Ele segue a MESMA fila do `pool`: consome a cabeça dela, e só
 * sorteia quando não sobra nada utilizável. A etiqueta antiga
 * prometia um sorteio que nunca aconteceu com a fila curada — o
 * admin marcava "sorteia" e o wipe comia a entrada que ele mesmo
 * tinha posto lá.
 */
export const MAP_SOURCE_LABEL: Readonly<Record<MapSource, string>> = {
  pool: 'o primeiro pronto da fila',
  random: 'da fila; sorteado só se ela esvaziar',
  fixed: 'escolhido a dedo',
  keep: 'o mesmo mapa de novo',
};

/**
 * O que já aconteceu com um wipe marcado.
 *
 * `absorbed` continua na lista de propósito: uma agenda com um
 * buraco não explica por que terça não vai ter wipe.
 */
export const STATUS_LABEL: Readonly<Record<WipePlan['status'], string>> = {
  planned: 'marcado',
  running: 'acontecendo agora',
  done: 'aconteceu',
  skipped: 'pulado',
  failed: 'falhou',
  absorbed: 'cancelado pelo forçado',
};

/** Um wipe que ainda vai acontecer? */
export function isPending(plan: WipePlan): boolean {
  return plan.status === 'planned' || plan.status === 'running';
}

/**
 * O próximo wipe, qualquer que seja o tipo dele.
 *
 * `now` é o relógio do AGENTE. Com o do navegador, um relógio
 * adiantado esconderia da tela o wipe que está para acontecer.
 */
export function nextWipe(plans: readonly WipePlan[], now: number): WipePlan | null {
  return (
    plans
      .filter((plan) => isPending(plan) && plan.scheduledAt >= now)
      .sort((left, right) => left.scheduledAt - right.scheduledAt)[0] ?? null
  );
}

/**
 * O próximo wipe FORÇADO, lido da agenda.
 *
 * A data não é calculada aqui de propósito. "Primeira quinta do
 * mês às 19:00 UTC" é regra do agente, e uma segunda conta no
 * painel seria uma segunda verdade — que divergiria da primeira no
 * dia em que a Facepunch mudasse o horário.
 */
export function nextForcedWipe(plans: readonly WipePlan[], now: number): WipePlan | null {
  return (
    plans
      .filter((plan) => plan.kind === 'forced' && isPending(plan) && plan.scheduledAt >= now)
      .sort((left, right) => left.scheduledAt - right.scheduledAt)[0] ?? null
  );
}

/** A agenda em ordem, do mais próximo ao mais distante. */
export function sortByDate(plans: readonly WipePlan[]): readonly WipePlan[] {
  return [...plans].sort((left, right) => left.scheduledAt - right.scheduledAt);
}

/**
 * A cor de um wipe na grade do mês.
 *
 * ####  A COR NÃO É A INFORMAÇÃO  ####
 *
 * Rust e olive ficam a ΔE 3.4 sob deuteranopia — quem não separa
 * verde de vermelho não separa "forçado" de "cadência" pela cor.
 * Por isso cada casa da grade leva também o RÓTULO, no `title` e
 * num texto só para leitor de tela: a cor reforça, e não informa
 * sozinha.
 */
export function toneOfPlan(plan: WipePlan): CalendarMark['tone'] {
  if (!isPending(plan)) {
    return 'muted';
  }

  if (plan.kind === 'forced') {
    return 'rust';
  }

  return plan.kind === 'manual' ? 'amber' : 'olive';
}

/**
 * A agenda vira marcações genéricas de calendário.
 *
 * É aqui que o wipe para de existir: da grade para baixo, só
 * existem `{ at, kind, label, tone }` — e é o que permite a tela
 * de eventos usar a MESMA grade depois.
 */
export function toCalendarMarks(plans: readonly WipePlan[]): readonly CalendarMark[] {
  return plans.map((plan) => ({
    at: plan.scheduledAt,
    kind: plan.kind,
    label: `${formatTime(plan.scheduledAt)} · ${KIND_LABEL[plan.kind]} · ${
      BP_POLICY_SHORT[plan.bpPolicy]
    }${isPending(plan) ? '' : ` · ${STATUS_LABEL[plan.status]}`}`,
    tone: toneOfPlan(plan),
  }));
}

/**
 * A data por extenso, com o dia da SEMANA.
 *
 * "quinta" é o que o admin cruza com a rotina do servidor, e é o
 * que denuncia na hora um wipe agendado para uma terça de manhã.
 */
export function formatMoment(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return EM_DASH;
  }

  return new Date(epochMs).toLocaleString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `qui 03/09 · 16:00` — a versão de lista. */
export function formatShortMoment(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return EM_DASH;
  }

  const date = new Date(epochMs);

  return `${date.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  })} · ${formatTime(epochMs)}`;
}

/** Só a hora, `16:00`. */
export function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return EM_DASH;
  }

  return new Date(epochMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Epoch ms -> `YYYY-MM-DD`, para o `<input type="date">`. */
export function toDateField(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return '';
  }

  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `YYYY-MM-DD` -> epoch ms ao MEIO-DIA local.
 *
 * Meio-dia, e não meia-noite: do marco zero da cadência o agente
 * usa só o DIA, lido no fuso configurado. Com meia-noite local, um
 * fuso algumas horas à frente leria o dia anterior — e a cadência
 * inteira andaria um dia sem ninguém entender por quê.
 */
export function fromDateField(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (match === null) {
    return null;
  }

  const [, year, month, day] = match;

  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }

  const parsed = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);

  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/**
 * `YYYY-MM-DD` + `HH:MM` -> epoch ms, no fuso do NAVEGADOR.
 *
 * É o que o wipe manual usa: quem digita a data está olhando o
 * próprio relógio. O agente recebe o instante em UTC, que é como
 * toda data viaja neste projeto.
 */
export function fromDateTimeFields(date: string, time: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const hour = /^(\d{2}):(\d{2})$/.exec(time);

  if (day === null || hour === null) {
    return null;
  }

  const parsed = new Date(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
    Number(hour[1]),
    Number(hour[2]),
    0,
    0,
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}
