// ============================================================
//  xp-day.ts  -  QUANDO O DIA DO TETO VIRA.
//
//  ####  A RÉGUA NÃO É NOVA, E É DE PROPÓSITO QUE NÃO SEJA  ####
//
//  "Farm teto de 100 XP por dia" (o dono, 17/09/2026) exige saber
//  quando o dia vira. O projeto já decidiu isso uma vez, para as
//  missões diárias: `reset_at_minute`, e uma aritmética que conta
//  DIAS DE CALENDÁRIO e não 24 horas — com o horário de verão
//  explicado no comentário de `nextReset` (quests/service.ts).
//
//  Este arquivo não reimplementa aquela conta: ele CHAMA a função.
//  Uma segunda virada no mesmo repositório seriam dois relógios
//  discordando duas vezes por ano, e ninguém lembrando por quê — e
//  o sintoma seria o pior possível: o jogador que farma às 23h50
//  perde o teto num sistema e não no outro.
//
//  ####  O NOME DO DIA É O DA VIRADA QUE O ABRIU  ####
//
//  Com `reset_at_minute = 360` (06:00), o que acontece às 03:00 do
//  dia 8 ainda pertence ao dia 7 — a virada das 06:00 do dia 7 é
//  que abriu essa janela, e a do dia 8 ainda não chegou. Por isso a
//  chave é o dia da virada ANTERIOR, e não o do calendário: se
//  fosse o do calendário, o teto zeraria à meia-noite e a diária
//  às 06:00, e o jogador teria dois dias por dia.
//
//  A conta é: a próxima virada, menos um dia NO CAMPO do dia. O
//  campo, e não 86.400.000 — é a mesma razão do `nextReset`.
// ============================================================

import { nextReset } from '../quests/service.js';
import { dayKeyOf } from '../types/battlepass.js';

/**
 * A chave do dia do teto: `2026-10-07`.
 *
 * `resetAtMinute` é o minuto do dia em que a diária vira, o mesmo
 * número que `quest_settings.reset_at_minute` guarda. Zero = meia-
 * noite, e aí a chave é o dia do calendário.
 */
export function xpDayKey(now: number, resetAtMinute: number): string {
  const opened = new Date(nextReset(now, resetAtMinute, 1));

  // A virada que ABRIU a janela em que estamos. `setDate` anda no
  // campo do dia: em 31 de outubro ele chega no dia 30, e na
  // madrugada em que o relógio muda ele continua chegando no dia
  // anterior — que é o que a conta em milissegundos erra.
  opened.setDate(opened.getDate() - 1);

  return dayKeyOf({
    year: opened.getFullYear(),
    month: opened.getMonth() + 1,
    day: opened.getDate(),
  });
}
