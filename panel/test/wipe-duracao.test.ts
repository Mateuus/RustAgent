// ============================================================
//  wipe-duracao.test.ts  -  a duração que a sub-aba EXECUÇÃO
//                           escreve ao lado de cada passo.
//
//  ####  O DEFEITO QUE ISTO EXISTE PARA PEGAR  ####
//
//  Um passo RETOMADO tem dois começos, e eles são de execuções
//  diferentes: `startedAt` é a primeira tentativa — a que morreu
//  com o agente, preservada de propósito — e `finishedAt` é o fim
//  da tentativa que concluiu. Subtrair um do outro não mede o
//  passo: mede o tempo em que o agente esteve MORTO.
//
//  MEDIDO na simulação (cenário D, `process.exit` no meio do
//  `apagar`): 8 arquivos apagados em 8 ms e o banco marcando
//  20.901 ms, porque a retomada veio 20 s depois. Com a retomada
//  na manhã seguinte a tela mostraria um `apagar` de dez horas.
//
//  A conta certa é `finishedAt - attemptStartedAt`, e é ela que
//  está fixada aqui.
// ============================================================

import { describe, expect, it } from 'vitest';

import { stepDuration } from '@/components/wipe/labels';
import type { WipeRunStepView } from '@/lib/api';

/** 2026-08-19 18:43:33.891, o horário do cenário D. */
const COMECOU = 1_787_186_613_891;

const DEZ_HORAS = 10 * 60 * 60 * 1000;

function step(patch: Partial<WipeRunStepView>): WipeRunStepView {
  return {
    step: 'apagar',
    position: 4,
    status: 'done',
    startedAt: COMECOU,
    attemptStartedAt: COMECOU,
    finishedAt: COMECOU + 8,
    message: '8 arquivo(s), 27 MB liberados.',
    ...patch,
  };
}

describe('a duração de um passo de wipe', () => {
  it('o passo retomado mostra a tentativa que concluiu, e não as dez horas de agente morto', () => {
    const apagar = step({
      startedAt: COMECOU,
      attemptStartedAt: COMECOU + DEZ_HORAS,
      finishedAt: COMECOU + DEZ_HORAS + 8,
    });

    expect(stepDuration(apagar)).toBe('8 ms');
  });

  it('sem retomada nenhuma a conta é a mesma de sempre', () => {
    expect(stepDuration(step({ finishedAt: COMECOU + 12 }))).toBe('12 ms');
  });

  it('escala a unidade: milissegundos, segundos e minutos', () => {
    expect(stepDuration(step({ finishedAt: COMECOU + 1229 }))).toBe('1.2 s');
    // O `avisar` de um wipe com aviso de 1 min, medido no cenário A.
    expect(stepDuration(step({ finishedAt: COMECOU + 75_001 }))).toBe('1m 15s');
    expect(stepDuration(step({ finishedAt: COMECOU + 86_400_000 }))).toBe('1440m 00s');
  });

  it('não escreve duração de passo que não terminou nem de passo que nunca rodou', () => {
    expect(stepDuration(step({ status: 'running', finishedAt: null }))).toBe('');
    expect(
      stepDuration(
        step({ status: 'skipped', startedAt: null, attemptStartedAt: null, finishedAt: COMECOU }),
      ),
    ).toBe('');
  });
});
