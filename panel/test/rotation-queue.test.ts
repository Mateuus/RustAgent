// ============================================================
//  A fila do rodízio, como a tela a calcula.
//
//  As três contas aqui são de ORDEM — o tipo de erro que não
//  aparece na tela: ela mostra uma sequência bonita e o chat sai
//  em outra. Um teste puro pega; o olho, não.
//
//  Componente React não é montado: o vitest do painel roda em node
//  puro, e a regra que importa está fora do componente justamente
//  por isso.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  isNextInLine,
  membersOf,
  moveInQueue,
} from '@/components/messages/rotation-queue';
import type { Message } from '@/lib/api';

/** Uma mensagem reduzida ao que a fila enxerga. */
function message(over: Partial<Message> & { id: number; position: number }): Message {
  return {
    name: `Msg ${String(over.id)}`,
    text: 'texto',
    enabled: true,
    trigger: 'rotation',
    groupId: 1,
    command: null,
    cooldownSeconds: 0,
    scheduleKind: 'interval',
    everySeconds: 1800,
    timeOfDay: null,
    weekdays: [],
    runAt: null,
    timeZone: 'America/Sao_Paulo',
    windowFrom: null,
    windowTo: null,
    onlyWithPlayers: false,
    minPlayers: 1,
    tag: null,
    tagColor: null,
    color: null,
    size: null,
    lastSentAt: null,
    nextAt: null,
    sentCount: 0,
    targets: [],
    schedule: 'rodízio',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  };
}

const A = message({ id: 1, position: 10 });
const B = message({ id: 2, position: 20 });
const C = message({ id: 3, position: 30 });

describe('quem está na fila', () => {
  it('só as do grupo, na ordem da posição', () => {
    const outra = message({ id: 9, position: 5, groupId: 2 });
    const avulsa = message({ id: 8, position: 1, trigger: 'schedule', groupId: null });

    expect(membersOf([C, avulsa, B, outra, A], 1).map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it('a de outro gatilho no mesmo grupo não entra', () => {
    // `group_id` sobrevive no banco enquanto o gatilho for rodízio;
    // trocado o gatilho, o agente o zera. A tela não pode depender
    // disso para não mostrar uma mensagem que já não sai ali.
    const trocada = message({ id: 4, position: 40, trigger: 'command', command: 'pop' });

    expect(membersOf([A, trocada], 1).map((item) => item.id)).toEqual([1]);
  });
});

describe('qual é a próxima', () => {
  it('a primeira, quando o grupo nunca falou', () => {
    expect(isNextInLine({ lastMessageId: null }, [A, B, C], A)).toBe(true);
    expect(isNextInLine({ lastMessageId: null }, [A, B, C], B)).toBe(false);
  });

  it('a seguinte à última que saiu', () => {
    expect(isNextInLine({ lastMessageId: 1 }, [A, B, C], B)).toBe(true);
  });

  it('dá a volta no fim do ciclo', () => {
    expect(isNextInLine({ lastMessageId: 3 }, [A, B, C], A)).toBe(true);
  });

  it('a última fora da fila recomeça pela primeira', () => {
    // Apagada, desligada ou movida de grupo. Adivinhar onde ela
    // estava seria pior que recomeçar.
    expect(isNextInLine({ lastMessageId: 99 }, [A, B, C], A)).toBe(true);
  });

  it('a desligada nunca é a próxima', () => {
    const desligada = message({ id: 2, position: 20, enabled: false });

    expect(isNextInLine({ lastMessageId: 1 }, [A, C], desligada)).toBe(false);
  });
});

describe('subir e descer na fila', () => {
  it('devolve a fila INTEIRA, e não "suba esta"', () => {
    // Com duas telas abertas, um "mova para cima" de cada uma
    // produz uma ordem que ninguém pediu.
    expect(moveInQueue([A, B, C], 3, -1)).toEqual([1, 3, 2]);
    expect(moveInQueue([A, B, C], 1, 1)).toEqual([2, 1, 3]);
  });

  it('movimento impossível devolve a ordem como está', () => {
    expect(moveInQueue([A, B, C], 1, -1)).toEqual([1, 2, 3]);
    expect(moveInQueue([A, B, C], 3, 1)).toEqual([1, 2, 3]);
    expect(moveInQueue([A, B, C], 99, 1)).toEqual([1, 2, 3]);
  });
});
