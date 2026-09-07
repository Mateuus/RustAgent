// ============================================================
//  A tradução da chance de loot.
//
//  ####  ESTA CONTA ERRA EM SILÊNCIO  ####
//
//  Se ela estiver errada, nenhuma tela quebra: o admin lê "≈ 2 por
//  semana", salva, e uma semana depois o servidor está com mil
//  troféus — ou com nenhum. É por isso que ela é a parte testada.
//
//  Os números conferidos aqui são os do Docs/CustomItem/04 §6.3,
//  que é a tabela que o estudo usou para chegar em "1 em 7.000 dá
//  2 por semana com 2.000 contêineres por dia".
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  averageOf,
  chanceFromOneIn,
  describeChance,
  formatInterval,
  formatRate,
  impliedContainersPerDay,
  oneInFromChance,
  parseCount,
  projectChance,
} from '@/components/loot/chance';

describe('parseCount', () => {
  it('aceita o número com o ponto de milhar que o admin digita', () => {
    expect(parseCount('5.000')).toBe(5000);
    expect(parseCount('5000')).toBe(5000);
    expect(parseCount(' 1 000 ')).toBe(1000);
  });

  it('aceita a vírgula decimal do português', () => {
    expect(parseCount('2,5')).toBe(2.5);
  });

  it('devolve null no que não é número positivo — e não zero', () => {
    // Zero seria um denominador válido para a conta, e produziria
    // "0 por semana" para uma regra que dispara.
    expect(parseCount('')).toBeNull();
    expect(parseCount('abc')).toBeNull();
    expect(parseCount('0')).toBeNull();
    expect(parseCount('-3')).toBeNull();
  });
});

describe('a chance e o "1 em N"', () => {
  it('vai e volta sem se perder', () => {
    expect(oneInFromChance(0.0002)).toBe(5000);
    expect(chanceFromOneIn(5000)).toBe(0.0002);
  });

  it('recusa o que não é probabilidade', () => {
    expect(oneInFromChance(0)).toBeNull();
    expect(oneInFromChance(1.5)).toBeNull();
    expect(oneInFromChance(null)).toBeNull();
    // "1 em 0,5" seria mais de uma por caixa.
    expect(chanceFromOneIn(0.5)).toBeNull();
  });
});

describe('projectChance', () => {
  // A linha da tabela do 04 §6.3: 2.000 contêineres por dia e
  // 1 em 7.000 dão dois por semana.
  it('reproduz a conta do estudo', () => {
    const projection = projectChance({
      chance: 1 / 7000,
      containersPerDay: 2000,
      dailyCap: null,
    });

    expect(projection).not.toBeNull();
    expect(projection?.perWeek).toBeCloseTo(2, 5);
    expect(formatRate(projection?.perWeek ?? 0)).toBe('≈ 2 por semana');
  });

  it('sem denominador não há projeção — e não uma projeção zerada', () => {
    expect(projectChance({ chance: 0.5, containersPerDay: null, dailyCap: null })).toBeNull();
    expect(projectChance({ chance: null, containersPerDay: 400, dailyCap: null })).toBeNull();
  });

  // ####  O TETO PRECISA APARECER COMO TETO  ####
  //
  // Uma tela que mostrasse "≈ 700 por semana" numa regra com teto
  // de 3 por dia estaria mentindo em uma ordem de grandeza.
  it('corta pelo teto diário e diz que cortou', () => {
    const projection = projectChance({ chance: 0.5, containersPerDay: 400, dailyCap: 3 });

    expect(projection?.perDay).toBe(200);
    expect(projection?.cappedPerDay).toBe(3);
    expect(projection?.cappedPerWeek).toBe(21);
    expect(projection?.capped).toBe(true);
  });

  it('teto folgado não é teto cortando', () => {
    const projection = projectChance({ chance: 1 / 7000, containersPerDay: 2000, dailyCap: 3 });

    expect(projection?.capped).toBe(false);
  });

  // A tabela de Poisson do 04 §6.3: com λ = 2 por semana, 13,5 %
  // das semanas não têm troféu nenhum — uma em cada sete.
  it('calcula a semana seca como o estudo calculou', () => {
    const projection = projectChance({ chance: 1 / 7000, containersPerDay: 2000, dailyCap: null });

    expect(projection?.drySpellOdds).toBeCloseTo(0.135, 3);
    expect(projection?.drySpellOneIn).toBeCloseTo(7.39, 2);
  });

  it('some com a semana seca quando ela deixa de dizer algo', () => {
    // Trinta por semana: a chance de não sair nenhum é 1 em 10^13,
    // e "1 semana em cada 10 trilhões" não informa ninguém.
    const projection = projectChance({ chance: 0.01, containersPerDay: 430, dailyCap: null });

    expect(projection?.drySpellOneIn).toBeNull();
  });
});

describe('formatRate', () => {
  it('usa a unidade em que o número se lê', () => {
    expect(formatRate(21)).toBe('≈ 3 por dia');
    expect(formatRate(2)).toBe('≈ 2 por semana');
    expect(formatRate(0.5)).toBe('≈ 2,1 por mês');
    expect(formatRate(0.1)).toBe('menos de 1 por mês');
  });

  it('nada por semana é travessão, e não "0"', () => {
    expect(formatRate(0)).toBe('—');
  });
});

describe('formatInterval', () => {
  it('vira dias quando as horas deixam de caber na cabeça', () => {
    expect(formatInterval(3)).toBe('a cada 3 h');
    expect(formatInterval(84)).toBe('a cada 3,5 dias');
    expect(formatInterval(null)).toBe('—');
  });
});

describe('describeChance', () => {
  it('junta a raridade e o efeito numa frase só', () => {
    expect(
      describeChance({ chance: 1 / 7000, containersPerDay: 2000, dailyCap: null }),
    ).toBe('1 em 7.000 · ≈ 2 por semana');
  });

  it('sem chance não inventa frase', () => {
    expect(describeChance({ chance: null, containersPerDay: 2000, dailyCap: null })).toBe('—');
  });
});

describe('averageOf', () => {
  // ####  DIA SEM DADO NÃO É DIA COM ZERO  ####
  //
  // Contar o `null` como zero puxaria a média para baixo e faria a
  // regra parecer mais rara do que é — e alguém subiria a chance
  // sem precisar.
  it('ignora o dia que o agente não sabe', () => {
    expect(averageOf([2, null, 4])).toBe(3);
  });

  it('tudo desconhecido devolve null', () => {
    expect(averageOf([null, null])).toBeNull();
    expect(averageOf([])).toBeNull();
  });
});

describe('impliedContainersPerDay', () => {
  // É o que o modo de medição existe para responder: com a chance
  // conhecida e os sorteios contados, o denominador sai por
  // divisão — e ele não era medido em lugar nenhum.
  it('devolve o denominador que a contagem implica', () => {
    expect(impliedContainersPerDay(0.2, 1 / 5000)).toBe(1000);
  });

  it('sem contagem, ou sem chance, não implica nada', () => {
    expect(impliedContainersPerDay(null, 0.5)).toBeNull();
    expect(impliedContainersPerDay(3, 0)).toBeNull();
  });
});
