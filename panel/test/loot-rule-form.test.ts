// ============================================================
//  O que o formulário de regra de loot decide sozinho.
//
//  ####  AS PORTAS QUE FECHAM EM SILÊNCIO  ####
//
//  Uma regra sem contêiner é aceita pelo banco e não dispara
//  nunca. Uma regra sem servidor idem. Nas duas, o sintoma é o
//  mesmo — "cadastrei e não caiu nada" —, e ele é
//  indistinguível de uma chance baixa demais. Por isso o motivo
//  aparece no rodapé do formulário, e por isso ele é testado.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  describeAmount,
  describeLimits,
  EMPTY_RULE,
  ruleToInput,
  toSlug,
  whyNotReady,
} from '@/components/loot/rule-form';
import type { LootRule, LootRuleInput } from '@/lib/api';

function ready(patch: Partial<LootRuleInput> = {}): LootRuleInput {
  return {
    ...EMPTY_RULE,
    id: 'trofeu-no-elite',
    label: 'Troféu na caixa de elite',
    customItemId: 'trofeu-bleik-store',
    containers: ['crate_elite'],
    servers: ['server01'],
    ...patch,
  };
}

describe('EMPTY_RULE', () => {
  // ####  UMA REGRA NOVA NASCE MEDINDO, E RARA  ####
  //
  // O padrão é o que o admin apressado salva sem ler. Nascer
  // valendo e comum encheria o mapa no primeiro wipe; nascer
  // medindo não cria item nenhum, e nascer raro erra para menos —
  // que é o erro seguro.
  it('nasce em medição e com chance rara', () => {
    expect(EMPTY_RULE.mode).toBe('measuring');
    expect(EMPTY_RULE.chance).toBeLessThanOrEqual(0.0001);
    expect(EMPTY_RULE.containers).toHaveLength(0);
  });

  it('nasce sem teto e sem carência, e isso é null — não zero', () => {
    // Zero seria lido pelo agente como "nenhum por dia", que é o
    // contrário de "sem teto".
    expect(EMPTY_RULE.dailyCap).toBeNull();
    expect(EMPTY_RULE.playerCooldownHours).toBeNull();
  });
});

describe('toSlug', () => {
  it('tira o acento e junta com hífen', () => {
    expect(toSlug('Troféu na caixa de elite')).toBe('trofeu-na-caixa-de-elite');
  });

  it('não deixa hífen sobrando nas pontas', () => {
    expect(toSlug('  Troféu!!  ')).toBe('trofeu');
  });
});

describe('whyNotReady', () => {
  it('um formulário completo pode salvar', () => {
    expect(whyNotReady(ready())).toBeNull();
  });

  it('recusa a regra sem contêiner, dizendo o que aconteceria', () => {
    expect(whyNotReady(ready({ containers: [] }))).toContain('nunca dispara');
  });

  it('recusa a regra sem servidor', () => {
    expect(whyNotReady(ready({ servers: [] }))).toContain('servidor');
  });

  it('recusa o item que não é nosso', () => {
    expect(whyNotReady(ready({ customItemId: '' }))).toContain('item nosso');
  });

  it('recusa a chance fora de 0 a 1', () => {
    expect(whyNotReady(ready({ chance: 0 }))).not.toBeNull();
    expect(whyNotReady(ready({ chance: 2 }))).not.toBeNull();
  });

  it('recusa o máximo menor que o mínimo', () => {
    expect(whyNotReady(ready({ amountMin: 3, amountMax: 1 }))).not.toBeNull();
  });
});

describe('describeAmount', () => {
  it('quantidade fixa não vira faixa', () => {
    expect(describeAmount(1, 1)).toBe('1');
    expect(describeAmount(1, 3)).toBe('1 a 3');
  });
});

describe('describeLimits', () => {
  // O admin não precisa saber que o campo se chama `dailyCap`.
  it('diz o EFEITO, e não o nome do campo', () => {
    expect(describeLimits({ dailyCap: 3, playerCooldownHours: 24 })).toEqual([
      'No máximo 3 por dia neste servidor.',
      'O mesmo jogador não acha outro nas próximas 24 h.',
    ]);
  });

  it('sem freio nenhum, não inventa linha', () => {
    expect(describeLimits({ dailyCap: null, playerCooldownHours: null })).toEqual([]);
  });
});

describe('ruleToInput', () => {
  // O PUT reescreve a regra inteira: mandar o array do objeto
  // original faria uma edição cancelada mexer na lista da tela.
  it('copia as listas em vez de compartilhá-las', () => {
    const rule: LootRule = { ...ready(), id: 'r1' };
    const input = ruleToInput(rule);

    expect(input.containers).not.toBe(rule.containers);
    expect(input.servers).not.toBe(rule.servers);
    expect(input).toEqual(rule);
  });
});
