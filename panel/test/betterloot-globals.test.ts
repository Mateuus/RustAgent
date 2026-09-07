// ============================================================
//  Os globais do BetterLoot, editáveis.
//
//  ####  ERRAR AQUI GRAVA NO SERVIDOR DO DONO  ####
//
//  Não é uma tela feia: é um número que ninguém digitou indo para
//  o `oxide/config/BetterLoot.json` de produção e valendo para os
//  111 contêineres de uma vez.
//
//  Os tipos são medidos no fonte do plugin instalado em
//  Plugins/server01/BetterLoot.cs:
//
//      public int LootMultiplier = 1;      (:174-175)
//      public int ScrapMultiplier = 1;     (:176-177)
//      public double BlueprintWeight = 0.11;   (:127-128)
//
//  Os dois primeiros são INTEIROS — é por isso que `1,5` não pode
//  atravessar — e o terceiro é fração de 0 a 1, enquanto a tela
//  fala em porcentagem.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  draftOfGlobals,
  formatBlueprintPercent,
  globalsDirty,
  normalizeBlueprintPercent,
  normalizeMultiplier,
  toGlobalsInput,
} from '@/components/loot/betterloot-globals';
import type { BetterLootGlobals } from '@/lib/api';

function globals(patch: Partial<BetterLootGlobals> = {}): BetterLootGlobals {
  return {
    lootMultiplier: 1,
    scrapMultiplier: 1,
    blueprintWeight: 0.11,
    blueprintConversion: true,
    allowDuplicates: true,
    poolLocking: true,
    ...patch,
  };
}

describe('o multiplicador é inteiro', () => {
  it('arredonda o decimal antes de ele sair da tela', () => {
    // O campo do plugin é `int`. Deixar 1,5 atravessar seria
    // prometer meio multiplicador a quem não pode ter.
    expect(normalizeMultiplier(1.5)).toBe(2);
    expect(normalizeMultiplier(2.4)).toBe(2);
  });

  it('nunca deixa passar zero — ele zeraria o loot do servidor', () => {
    // `amount * 0 = 0` em todo item de todo container (:2815).
    expect(normalizeMultiplier(0)).toBe(MIN_MULTIPLIER);
    expect(normalizeMultiplier(-3)).toBe(MIN_MULTIPLIER);
  });

  it('tem teto, para um dígito a mais não virar quarenta mil enxofres', () => {
    expect(normalizeMultiplier(999_999)).toBe(MAX_MULTIPLIER);
  });

  it('trata o campo apagado como o piso, e não como NaN', () => {
    expect(normalizeMultiplier(Number.NaN)).toBe(MIN_MULTIPLIER);
  });
});

describe('o peso de blueprint', () => {
  it('vira porcentagem na ida e fração na volta', () => {
    const draft = draftOfGlobals(globals({ blueprintWeight: 0.11 }));

    expect(draft.blueprintPercent).toBe(11);
    expect(toGlobalsInput(draft).blueprintWeight).toBe(0.11);
  });

  it('guarda a meia casa em vez de arredondar o que já estava lá', () => {
    // 0,115 no arquivo é 11,5 %. Arredondar para 12 % gravaria um
    // valor que o admin não pediu só por ele ter aberto a tela.
    const draft = draftOfGlobals(globals({ blueprintWeight: 0.115 }));

    expect(draft.blueprintPercent).toBe(11.5);
    expect(toGlobalsInput(draft).blueprintWeight).toBe(0.115);
  });

  it('não deixa o ponto flutuante inventar dígitos', () => {
    // `11.5 / 100` é 0.11499999999999999 em ponto flutuante, e
    // gravar isso faria o arquivo diferir do que a tela mostra.
    expect(toGlobalsInput({ ...draftOfGlobals(globals()), blueprintPercent: 11.5 })
      .blueprintWeight).toBe(0.115);
  });

  it('fica entre 0 e 100', () => {
    expect(normalizeBlueprintPercent(-5)).toBe(0);
    expect(normalizeBlueprintPercent(140)).toBe(100);
  });
});

describe('o rascunho sem configuração lida', () => {
  it('nasce no padrão do plugin, e não em zero', () => {
    const draft = draftOfGlobals(null);

    expect(draft.lootMultiplier).toBe(1);
    expect(draft.scrapMultiplier).toBe(1);
    expect(draft.blueprintPercent).toBe(0);
    expect(draft.blueprintConversion).toBe(false);
  });

  it('nunca se diz alterado — não há com o que comparar', () => {
    // Sem o arquivo, "mudou?" não tem resposta. Dizer que sim
    // ofereceria gravar por cima de algo que ninguém leu.
    expect(globalsDirty(draftOfGlobals(null), null)).toBe(false);
  });
});

describe('mudou?', () => {
  it('vê o multiplicador trocado', () => {
    const disk = globals({ lootMultiplier: 1 });

    expect(globalsDirty({ ...draftOfGlobals(disk), lootMultiplier: 2 }, disk)).toBe(true);
  });

  it('vê o interruptor de blueprint desligado', () => {
    const disk = globals({ blueprintConversion: true });

    expect(globalsDirty({ ...draftOfGlobals(disk), blueprintConversion: false }, disk)).toBe(true);
  });

  it('não acusa alteração só por a tela ter aberto', () => {
    // A ida e volta pela porcentagem não pode inventar diferença:
    // um aviso de "mudanças não gravadas" que aparece sozinho
    // ensina a ignorá-lo.
    for (const weight of [0, 0.11, 0.115, 0.5, 1]) {
      const disk = globals({ blueprintWeight: weight });

      expect(globalsDirty(draftOfGlobals(disk), disk)).toBe(false);
    }
  });

  it('compara na escala do ARQUIVO, e não na da tela', () => {
    // 0,1149 e 0,115 são o mesmo "11,5 %" no campo. Comparar as
    // porcentagens diria "igual" para dois arquivos diferentes — e
    // o rascunho que a tela vai gravar É o arredondado.
    const disk = globals({ blueprintWeight: 0.1149 });

    expect(globalsDirty(draftOfGlobals(disk), disk)).toBe(true);
  });
});

describe('o que a faixa mostra', () => {
  it('mostra travessão quando não houve leitura, e sem sufixo', () => {
    expect(formatBlueprintPercent(null)).toBe('—');
  });

  it('não força casa decimal onde não há', () => {
    expect(formatBlueprintPercent(0.11)).toBe('11 %');
    expect(formatBlueprintPercent(0.115)).toBe('11,5 %');
  });
});
