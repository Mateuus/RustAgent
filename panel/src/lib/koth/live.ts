// ============================================================
//  koth/live.ts  -  a leitura de um território de pé.
//
//  ####  POR QUE ISTO NÃO MORA NO CARD  ####
//
//  O card é JSX; estas quatro perguntas são aritmética, e é a
//  aritmética que erra. "Contestado" e "parado" parecem a mesma
//  coisa na tela — os dois têm a barra imóvel — e são o oposto um
//  do outro: num, duas equipes estão se matando em cima do ponto;
//  no outro, não há ninguém lá.
//
//  Separadas do JSX, elas têm teste. Dentro do JSX, teriam um
//  print.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md §4 (contestado PAUSA) e §5 (o
//  progresso é do EVENTO, e nunca volta a zero).
// ============================================================

import type { KothLiveEvent } from '@/lib/api';

/**
 * Em que pé está a disputa.
 *
 *   contested   dois ou mais lados dentro: a barra PAROU
 *   holding     uma equipe sozinha lá dentro: a barra anda
 *   paused      ninguém dentro, mas já há progresso guardado
 *   idle        ninguém dentro, e nada conquistado ainda
 */
export type KothPhase = 'contested' | 'holding' | 'paused' | 'idle';

/** Quem está capturando agora, ou `null`. */
export function holderOf(event: KothLiveEvent): string | null {
  // O plugin manda `"0"` — e não string vazia — quando não há dono:
  // os ids de equipe do Rust passam de 2^53 e viajam como TEXTO.
  if (event.holder === '0' || event.holder === '') return null;

  return event.holderName.trim() === '' ? event.holder : event.holderName;
}

export function phaseOf(event: KothLiveEvent): KothPhase {
  if (event.contested) return 'contested';

  if (event.inside > 0 && holderOf(event) !== null) return 'holding';

  return event.percent > 0 ? 'paused' : 'idle';
}

/** Quanto falta para o evento expirar. Nunca negativo. */
export function remainingSeconds(event: KothLiveEvent): number {
  return Math.max(0, Math.round(event.durationSeconds - event.elapsed));
}

/**
 * Segundos em relógio.
 *
 * Abaixo de uma hora sai `12:34`; acima, `1:02:03` — um evento de
 * duas horas mostrado como `120:00` faz o admin contar nos dedos.
 */
export function clock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');

  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);

  if (hours > 0) return `${String(hours)}:${pad(minutes)}:${pad(safe % 60)}`;

  return `${String(minutes)}:${pad(safe % 60)}`;
}
