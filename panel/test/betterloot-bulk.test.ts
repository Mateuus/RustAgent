// ============================================================
//  A multiplicação em massa das quantidades de uma caixa.
//
//  ####  ERRAR AQUI REESCREVE 145 ENTRADAS DE PRODUÇÃO  ####
//
//  E sem volta pelo botão: o `Item Minimum`/`Item Maximum` de antes
//  não fica guardado em lugar nenhum depois que o arquivo é
//  gravado — só no backup que o agente faz do `LootTables.json`.
//
//  As duas regras que este arquivo guarda, e que ninguém vê
//  olhando a tela:
//
//    1. zero continua zero — "pode não vir nenhum" não vira "vem
//       cinco" só porque o admin pediu 5x;
//    2. o que era 1 nunca desce a zero com um fator fracionário.
//       Isso não seria reduzir a quantidade pela metade, seria
//       mudar a natureza da entrada em silêncio, no meio de 145
//       linhas.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  formatFactor,
  formatRange,
  multiplyAmounts,
  rangeOf,
  scaleAmount,
} from '@/components/loot/betterloot-bulk';
import type {
  BetterLootEntry,
  BetterLootGuaranteedEntry,
  BetterLootTable,
} from '@/lib/api';

function entry(patch: Partial<BetterLootEntry> = {}): BetterLootEntry {
  return {
    key: 'sticks',
    shortname: 'sticks',
    displayName: 'Sticks',
    skinId: '0',
    customName: null,
    min: 1,
    max: 4,
    allowDuplicates: true,
    canConvertToBlueprint: null,
    durability: null,
    rarity: 0,
    bonusItems: [],
    hasWeaponProperties: false,
    ...patch,
  };
}

function guaranteed(patch: Partial<BetterLootGuaranteedEntry> = {}): BetterLootGuaranteedEntry {
  return {
    key: 'scrap',
    shortname: 'scrap',
    displayName: 'Scrap',
    skinId: '0',
    customName: null,
    min: 10,
    max: 25,
    ...patch,
  };
}

function table(patch: Partial<BetterLootTable> = {}): BetterLootTable {
  return {
    prefab: 'assets/bundled/prefabs/radtown/crate_elite.prefab',
    enabled: true,
    itemCount: 0,
    guaranteedCount: 0,
    profileCount: 0,
    itemSettings: {
      minItems: 3,
      maxItems: 6,
      minScrap: 25,
      maxScrap: 25,
      minBlueprints: 0,
      maxBlueprints: 1,
      bonusItemsCountToTotal: false,
      guaranteedItemsCountToTotal: true,
    },
    poolLocking: false,
    ignoreRarityBias: false,
    profiles: [],
    guaranteed: [],
    items: [],
    ...patch,
  };
}

describe('a quantidade multiplicada', () => {
  it('dobra o que havia', () => {
    expect(scaleAmount(4, 2)).toBe(8);
    expect(scaleAmount(1, 10)).toBe(10);
  });

  it('deixa zero em zero', () => {
    // "Pode não vir nenhum" é uma decisão da entrada, e nenhum
    // multiplicador a desfaz: 0 × 5 é 0 em qualquer aritmética.
    expect(scaleAmount(0, 5)).toBe(0);
    expect(scaleAmount(0, 100)).toBe(0);
  });

  it('nunca faz um item que saía virar um que não sai', () => {
    // Com 0,5, `round(1 * 0.5)` seria 0 — e a entrada passaria a
    // poder sair vazia. Isso não é reduzir pela metade, é mudar a
    // natureza dela.
    expect(scaleAmount(1, 0.5)).toBe(1);
    expect(scaleAmount(1, 0.1)).toBe(1);
    expect(scaleAmount(2, 0.5)).toBe(1);
  });

  it('arredonda, porque a quantidade do arquivo é inteira', () => {
    expect(scaleAmount(3, 1.5)).toBe(5);
    expect(scaleAmount(5, 0.5)).toBe(3);
  });
});

describe('a faixa agregada', () => {
  it('vai do menor mínimo ao maior máximo', () => {
    expect(rangeOf([{ min: 5, max: 10 }, { min: 1, max: 4 }])).toEqual({ min: 1, max: 10 });
  });

  it('é ausência, e não zero, quando não há entrada', () => {
    // Uma faixa "de 0 a 0" se lê como um dado; a caixa vazia não
    // tem dado nenhum para mostrar.
    expect(rangeOf([])).toBeNull();
    expect(formatRange(null)).toBe('—');
  });
});

describe('a caixa multiplicada', () => {
  it('mexe nos itens soltos e nos garantidos', () => {
    // Dobrar só o que é sorteado e não o que é certo faria o admin
    // achar que o 2x não pegou na metade da caixa.
    const outcome = multiplyAmounts(
      table({ items: [entry()], guaranteed: [guaranteed()] }),
      2,
    );

    expect(outcome.table.items[0]).toMatchObject({ min: 2, max: 8 });
    expect(outcome.table.guaranteed[0]).toMatchObject({ min: 20, max: 50 });
    expect(outcome.items).toBe(1);
    expect(outcome.guaranteed).toBe(1);
  });

  it('conta a faixa de antes e a de depois, que é o que a tela escreve', () => {
    const outcome = multiplyAmounts(
      table({ items: [entry({ min: 1, max: 4 }), entry({ key: 'wood', min: 2, max: 3 })] }),
      2,
    );

    expect(formatRange(outcome.before)).toBe('1 a 4');
    expect(formatRange(outcome.after)).toBe('2 a 8');
  });

  it('conta quantas entradas mudam de verdade', () => {
    // As que já saem em zero ficam como estão, e dizer isso evita
    // o "apliquei 5x e só 140 das 145 mudaram" virar suspeita.
    const outcome = multiplyAmounts(
      table({ items: [entry({ min: 1, max: 4 }), entry({ key: 'nada', min: 0, max: 0 })] }),
      5,
    );

    expect(outcome.changed).toBe(1);
    expect(outcome.items).toBe(2);
  });

  it('não mexe em quantos itens a caixa entrega', () => {
    // Quem decide isso é `Item Settings`, e o jogo o corta em 36.
    // Multiplicar as quantidades não chega perto desse teto — e é
    // exatamente por isso que a tela precisa dizê-lo.
    const outcome = multiplyAmounts(table({ items: [entry()] }), 10);

    expect(outcome.table.itemSettings).toEqual(table().itemSettings);
  });

  it('não mexe no scrap da caixa', () => {
    // Ele é um par de campos visível e editável logo acima; incluí-lo
    // faria "multiplicar os itens" mexer num número que o admin não
    // estava olhando.
    const outcome = multiplyAmounts(table({ items: [entry()] }), 10);

    expect(outcome.table.itemSettings.minScrap).toBe(25);
    expect(outcome.table.itemSettings.maxScrap).toBe(25);
  });

  it('não estraga a entrada: mínimo continua menor ou igual ao máximo', () => {
    // Com os dois invertidos o plugin sorteia sempre o mínimo, e
    // nada reclama.
    const outcome = multiplyAmounts(
      table({ items: [entry({ min: 1, max: 1 }), entry({ key: 'x', min: 3, max: 9 })] }),
      1.5,
    );

    for (const item of outcome.table.items) {
      expect(item.min).toBeLessThanOrEqual(item.max);
    }
  });

  it('não toca no que não é quantidade', () => {
    // A skin é a identidade do item nosso, e a raridade é o que dá
    // a porcentagem. Um `map` descuidado as perderia.
    const outcome = multiplyAmounts(
      table({ items: [entry({ skinId: '3403269092', rarity: 3, customName: 'Troféu Bleik' })] }),
      2,
    );

    expect(outcome.table.items[0]).toMatchObject({
      skinId: '3403269092',
      rarity: 3,
      customName: 'Troféu Bleik',
    });
  });

  it('devolve uma caixa nova, sem mexer na que recebeu', () => {
    // O rascunho da tela só pode mudar quando o admin confirma. Uma
    // mutação aqui aplicaria o 10x antes de ele ler o aviso.
    const original = table({ items: [entry({ min: 1, max: 4 })] });

    multiplyAmounts(original, 10);

    expect(original.items[0]).toMatchObject({ min: 1, max: 4 });
  });
});

describe('o fator como o admin lê', () => {
  it('usa vírgula decimal', () => {
    expect(formatFactor(2)).toBe('2×');
    expect(formatFactor(1.5)).toBe('1,5×');
  });
});
