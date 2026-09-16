// ============================================================
//  A leitura de um território de pé.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Duas linhas da barra parecem iguais e não são:
//
//    contestado   duas equipes em cima do ponto, a barra parou
//    parado       ninguém lá, e o progresso continua guardado
//
//  Confundir as duas faz o admin derrubar um evento DISPUTADO
//  achando que ele está morto — e é o clique que ninguém desfaz.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { KothLiveEvent } from '@/lib/api';
import { clock, holderOf, phaseOf, remainingSeconds } from '@/lib/koth/live';

function event(patch: Partial<KothLiveEvent> = {}): KothLiveEvent {
  return {
    runId: '52',
    name: 'Colina do Norte',
    grid: 'N14',
    x: 100,
    z: -200,
    radius: 30,
    percent: 0,
    progress: 0,
    captureSeconds: 900,
    holder: '0',
    holderName: '',
    contested: false,
    elapsed: 0,
    durationSeconds: 3600,
    inside: 0,
    ...patch,
  };
}

describe('quem está com o território', () => {
  it('o "0" do plugin é ninguém, e não uma equipe chamada zero', () => {
    expect(holderOf(event())).toBeNull();
  });

  it('equipe sem nome cai no id — melhor um número que um vazio', () => {
    expect(holderOf(event({ holder: '76561198000000000', holderName: '   ' }))).toBe(
      '76561198000000000',
    );
  });

  it('com nome, é o nome', () => {
    expect(holderOf(event({ holder: '123', holderName: 'Os Bravos' }))).toBe('Os Bravos');
  });
});

describe('em que pé está a disputa', () => {
  it('sem ninguém e sem progresso, está ocioso', () => {
    expect(phaseOf(event())).toBe('idle');
  });

  it('uma equipe sozinha lá dentro está DOMINANDO', () => {
    expect(phaseOf(event({ inside: 3, holder: '1', holderName: 'Os Bravos', percent: 20 }))).toBe(
      'holding',
    );
  });

  it('contestado ganha de tudo: a barra parou, e não é por falta de gente', () => {
    expect(
      phaseOf(event({ contested: true, inside: 6, holder: '1', holderName: 'Os Bravos' })),
    ).toBe('contested');
  });

  it('área vazia com progresso guardado é PARADO, não ocioso', () => {
    // A regra do dono: o progresso é do evento e nunca volta a
    // zero. Quem chegar depois continua de onde este parou.
    expect(phaseOf(event({ percent: 65, holder: '1', holderName: 'Os Bravos' }))).toBe('paused');
  });

  it('gente dentro sem equipe nenhuma não domina', () => {
    // Só participa quem está em equipe: o plugin manda `inside`
    // mesmo assim, e sem dono a barra não anda.
    expect(phaseOf(event({ inside: 2 }))).toBe('idle');
  });
});

describe('o que falta de tempo', () => {
  it('desconta o que já passou', () => {
    expect(remainingSeconds(event({ elapsed: 600, durationSeconds: 3600 }))).toBe(3000);
  });

  it('estourado não fica negativo', () => {
    expect(remainingSeconds(event({ elapsed: 4000, durationSeconds: 3600 }))).toBe(0);
  });
});

describe('o relógio', () => {
  it('abaixo de uma hora é minuto e segundo', () => {
    expect(clock(754)).toBe('12:34');
  });

  it('acima de uma hora a hora aparece — 120:00 ninguém lê', () => {
    expect(clock(3723)).toBe('1:02:03');
  });

  it('zero é zero, e não vazio', () => {
    expect(clock(0)).toBe('0:00');
  });
});
