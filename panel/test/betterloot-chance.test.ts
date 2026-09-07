// ============================================================
//  Peso, probabilidade e prévia do editor de loot.
//
//  ####  ERRAR A CONTA AQUI NÃO QUEBRA TELA NENHUMA  ####
//
//  Produz uma porcentagem confiante e errada, que é pior: o admin
//  balanceia o servidor contra ela e o defeito só aparece semanas
//  depois, como "o loot está estranho".
//
//  A fórmula é medida no fonte do plugin instalado em
//  Plugins/server01/BetterLoot.cs:
//
//      BASE_ITEM_RARITY = 2                              (:84)
//      ItemWeight(base, i) = (int)(base^(4 - i) * 1000)   (:1657)
//      ItemWeights[t][i] = ItemWeight(i) * Items[t][i].Count  (:2270)
//      r = RNG.Next(total); acha o balde; item uniforme dentro  (:2882)
//
//  Cancelando a contagem dos dois lados sobra
//  `P(item) = W(raridade) / Σ (W(i) × n_i)`.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  MAX_ITEMS_PER_CONTAINER,
  RARITY_WEIGHTS,
  chancesOf,
  flatShareOf,
  formatChance,
  formatCount,
  formatMultiplier,
  previewOf,
  rarityLabel,
  ungroupedRollsOf,
  weightOfRarity,
} from '@/components/loot/betterloot-chance';
import type {
  BetterLootEntry,
  BetterLootGlobals,
  BetterLootGuaranteedEntry,
  BetterLootTable,
} from '@/lib/api';

function entry(patch: Partial<BetterLootEntry> = {}): BetterLootEntry {
  return {
    key: 'rifle.ak',
    shortname: 'rifle.ak',
    displayName: 'Assault Rifle',
    skinId: '0',
    customName: null,
    min: 1,
    max: 1,
    allowDuplicates: true,
    canConvertToBlueprint: null,
    durability: null,
    rarity: 4,
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
    max: 10,
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
      minItems: 8,
      maxItems: 8,
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

const GLOBALS: BetterLootGlobals = {
  lootMultiplier: 1,
  scrapMultiplier: 1,
  blueprintWeight: 0.11,
  blueprintConversion: true,
  allowDuplicates: true,
  poolLocking: true,
};

describe('weightOfRarity', () => {
  // `2^(4-i) * 1000` — o índice 0 é o item mais comum do jogo e
  // pesa 16 vezes mais que o índice 4.
  it('vale a potência que o plugin calcula', () => {
    expect(RARITY_WEIGHTS).toEqual([16_000, 8000, 4000, 2000, 1000]);
    expect(weightOfRarity(0)).toBe(16_000);
    expect(weightOfRarity(4)).toBe(1000);
  });

  // Uma raridade fora da faixa NÃO vira zero: zero seria dizer que
  // o item nunca sai, e a tela não sabe disso.
  it('devolve nulo para raridade desconhecida ou fora da faixa', () => {
    expect(weightOfRarity(null)).toBeNull();
    expect(weightOfRarity(7)).toBeNull();
  });
});

describe('rarityLabel', () => {
  it('nomeia o que conhece e mostra o número do que não conhece', () => {
    expect(rarityLabel(0)).toBe('Comuníssimo');
    expect(rarityLabel(4)).toBe('Raríssimo');
    expect(rarityLabel(9)).toBe('raridade 9');
    expect(rarityLabel(null)).toBe('—');
  });
});

describe('chancesOf', () => {
  it('divide o peso do item pela soma da caixa', () => {
    const chances = chancesOf(
      [
        entry({ key: 'a', rarity: 0 }),
        entry({ key: 'b', rarity: 4 }),
        entry({ key: 'c', rarity: 4 }),
      ],
      { flat: false },
    );

    // 16000 + 1000 + 1000 = 18000
    expect(chances.totalWeight).toBe(18_000);
    expect(chances.entries[0]?.probability).toBeCloseTo(16_000 / 18_000, 10);
    expect(chances.entries[1]?.probability).toBeCloseTo(1000 / 18_000, 10);
  });

  // ####  É A CONSEQUÊNCIA QUE A TELA EXISTE PARA MOSTRAR  ####
  //
  // O admin acrescenta um item e a chance de todos os outros cai —
  // sem aviso, sem erro, e sem nada na tela que o diga.
  it('acrescentar um item derruba a chance de todos os outros', () => {
    const before = chancesOf([entry({ key: 'a', rarity: 4 }), entry({ key: 'b', rarity: 4 })], {
      flat: false,
    });
    const after = chancesOf(
      [entry({ key: 'a', rarity: 4 }), entry({ key: 'b', rarity: 4 }), entry({ key: 'c', rarity: 0 })],
      { flat: false },
    );

    const first = before.entries[0]?.probability ?? 0;
    const then = after.entries[0]?.probability ?? 0;

    expect(then).toBeLessThan(first);
  });

  // O interruptor por caixa troca o sorteio inteiro: raridade
  // nenhuma, P = 1/N para todo mundo.
  it('o modo parelho ignora a raridade', () => {
    const chances = chancesOf(
      [entry({ key: 'a', rarity: 0 }), entry({ key: 'b', rarity: 4 })],
      { flat: true },
    );

    expect(chances.flat).toBe(true);
    expect(chances.totalWeight).toBeNull();
    expect(chances.entries[0]?.probability).toBe(0.5);
    expect(chances.entries[1]?.probability).toBe(0.5);
  });

  // Chutar uma raridade seria inventar um peso; contá-la como zero
  // seria afirmar que o item não sai. As duas coisas mentem.
  it('item sem raridade sai da conta, e a tela fica sabendo quantos', () => {
    const chances = chancesOf(
      [entry({ key: 'a', rarity: 4 }), entry({ key: 'b', rarity: null })],
      { flat: false },
    );

    expect(chances.unknownRarity).toBe(1);
    expect(chances.entries[1]?.probability).toBeNull();
    expect(chances.entries[1]?.weight).toBeNull();
    expect(chances.totalWeight).toBe(1000);
  });

  // ####  A SOMA PRECISA FECHAR EM 1, OU A TELA MENTE POR OMISSÃO  ####
  //
  // Conferido contra a caixa de elite REAL do server01: 145
  // entradas, peso total 595.000, soma das probabilidades
  // 1,000000000000. Uma soma que não fecha significa massa
  // perdida em algum lugar — e a tela mostraria todo mundo mais
  // raro (ou mais comum) do que é, sem nada apontar o erro.
  it('as probabilidades de uma caixa somam 1', () => {
    const many = Array.from({ length: 145 }, (_, index) =>
      entry({ key: `item-${String(index)}`, rarity: index % 5 }),
    );

    const sum = chancesOf(many, { flat: false }).entries.reduce(
      (total, candidate) => total + (candidate.probability ?? 0),
      0,
    );

    expect(sum).toBeCloseTo(1, 12);
  });

  it('no modo parelho elas também somam 1', () => {
    const many = Array.from({ length: 7 }, (_, index) => entry({ key: `item-${String(index)}` }));

    const sum = chancesOf(many, { flat: true }).entries.reduce(
      (total, candidate) => total + (candidate.probability ?? 0),
      0,
    );

    expect(sum).toBeCloseTo(1, 12);
  });

  it('caixa vazia não divide por zero', () => {
    expect(chancesOf([], { flat: false }).entries).toHaveLength(0);
    expect(chancesOf([], { flat: true }).entries).toHaveLength(0);
  });
});

describe('ungroupedRollsOf', () => {
  it('é a média do mín./máx. de itens', () => {
    expect(ungroupedRollsOf(table({ itemSettings: { ...table().itemSettings, minItems: 4, maxItems: 8 } }))).toBe(6);
  });

  // O laço de população começa no número de garantidos quando eles
  // contam para o total (BetterLoot.cs:2390).
  it('desconta os garantidos quando eles contam para o total', () => {
    const withGuaranteed = table({
      guaranteed: [guaranteed({ key: 'scrap' }), guaranteed({ key: 'cloth' })],
    });

    expect(ungroupedRollsOf(withGuaranteed)).toBe(6);
  });

  it('não desconta quando eles apenas somam', () => {
    const withGuaranteed = table({
      guaranteed: [guaranteed({ key: 'scrap' })],
      itemSettings: { ...table().itemSettings, guaranteedItemsCountToTotal: false },
    });

    expect(ungroupedRollsOf(withGuaranteed)).toBe(8);
  });

  // `Math.Clamp(..., 1, 36)` no plugin: digitar 60 e esperar 60 é
  // exatamente o silêncio que a tela precisa evitar.
  it('respeita o teto de 36 do jogo', () => {
    const huge = table({ itemSettings: { ...table().itemSettings, minItems: 60, maxItems: 60 } });

    expect(ungroupedRollsOf(huge)).toBe(MAX_ITEMS_PER_CONTAINER);
  });

  it('nunca fica negativo, mesmo com mais garantidos que itens', () => {
    const odd = table({
      guaranteed: Array.from({ length: 20 }, (_, index) => guaranteed({ key: `g${String(index)}` })),
      itemSettings: { ...table().itemSettings, minItems: 2, maxItems: 2 },
    });

    expect(ungroupedRollsOf(odd)).toBe(0);
  });
});

describe('previewOf', () => {
  const labelOf = (item: BetterLootEntry): string => item.customName ?? item.shortname;

  it('o item garantido sai em todas as caixas', () => {
    const preview = previewOf(
      table({ guaranteed: [guaranteed({ min: 10, max: 10 })] }),
      GLOBALS,
      100,
      labelOf,
    );

    const line = preview.lines[0];

    expect(line?.guaranteed).toBe(true);
    expect(line?.containers).toBe(100);
    expect(line?.units).toBe(1000);
  });

  // Medido: `:2557` cria o garantido SEM multiplicar, ao contrário
  // do item solto em `:2815`. Aplicar o multiplicador aos dois faria
  // a prévia prometer scrap que não vem.
  it('o multiplicador não vale para o item garantido', () => {
    const preview = previewOf(
      table({ guaranteed: [guaranteed({ min: 10, max: 10 })] }),
      { ...GLOBALS, lootMultiplier: 5 },
      100,
      labelOf,
    );

    expect(preview.lines[0]?.units).toBe(1000);
  });

  it('o multiplicador vale para o item solto', () => {
    const single = table({
      items: [entry({ key: 'a', rarity: 4, min: 2, max: 2 })],
      itemSettings: { ...table().itemSettings, minItems: 1, maxItems: 1 },
    });

    const plain = previewOf(single, GLOBALS, 100, labelOf);
    const boosted = previewOf(single, { ...GLOBALS, lootMultiplier: 5 }, 100, labelOf);

    expect(plain.lines[0]?.units).toBe(200);
    expect(boosted.lines[0]?.units).toBe(1000);
  });

  // "Em quantas caixas ele aparece" não é a soma das chances dos
  // sorteios: isso passaria de 100 % num item comum de caixa
  // grande. É o complemento de "nunca sair".
  it('a contagem de caixas nunca passa do total aberto', () => {
    const preview = previewOf(
      table({
        items: [entry({ key: 'a', rarity: 0 }), entry({ key: 'b', rarity: 4 })],
      }),
      GLOBALS,
      100,
      labelOf,
    );

    for (const line of preview.lines) {
      expect(line.containers ?? 0).toBeLessThanOrEqual(100);
    }
  });

  it('o item sem raridade vai para o fim, com travessão', () => {
    const preview = previewOf(
      table({
        items: [entry({ key: 'a', rarity: null }), entry({ key: 'b', rarity: 4 })],
      }),
      GLOBALS,
      100,
      labelOf,
    );

    expect(preview.unknownRarity).toBe(1);
    expect(preview.lines.at(-1)?.key).toBe('item:a');
    expect(preview.lines.at(-1)?.containers).toBeNull();
  });

  it('leva o scrap da caixa, com o multiplicador dele', () => {
    const preview = previewOf(table(), { ...GLOBALS, scrapMultiplier: 2 }, 100, labelOf);

    expect(preview.scrap).toBe(5000);
  });

  it('caixa sem scrap devolve nulo, e não zero', () => {
    const dry = table({ itemSettings: { ...table().itemSettings, minScrap: 0, maxScrap: 0 } });

    expect(previewOf(dry, GLOBALS, 100, labelOf).scrap).toBeNull();
  });

  // ####  GARANTIDO E SOLTO SÃO DOIS DICIONÁRIOS DO ARQUIVO  ####
  //
  // `Guaranteed Items` e `Ungrouped Items` são chaveados
  // separadamente: o mesmo scrap pode estar nos dois com a MESMA
  // chave. Duas linhas de mesma `key` no `.map` da prévia fazem o
  // React reconciliar o nó errado — a linha do garantido passaria a
  // mostrar o número do solto.
  it('o mesmo item garantido e solto produz chaves distintas', () => {
    const preview = previewOf(
      table({
        guaranteed: [guaranteed({ key: 'scrap' })],
        items: [entry({ key: 'scrap', shortname: 'scrap', rarity: 0 })],
      }),
      GLOBALS,
      100,
      labelOf,
    );

    const keys = preview.lines.map((line) => line.key);

    expect(keys).toEqual(['guaranteed:scrap', 'item:scrap']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // ####  1× É UM CHUTE, E ELE PARECE UM DADO  ####
  //
  // O mesmo tratamento que a raridade desconhecida recebe: sem o
  // arquivo global a tela não sabe se o servidor está em 1× ou em
  // 5×, e o número sairia com cara de medido.
  it('sem o arquivo global, as unidades ficam com travessão e a tela fica sabendo', () => {
    const preview = previewOf(
      table({
        items: [entry({ key: 'a', rarity: 4, min: 2, max: 2 })],
        itemSettings: { ...table().itemSettings, minItems: 1, maxItems: 1 },
      }),
      null,
      100,
      labelOf,
    );

    expect(preview.unknownMultiplier).toBe(true);
    expect(preview.lines[0]?.units).toBeNull();
    expect(preview.scrap).toBeNull();
    // A chance não depende do multiplicador: ele mexe na quantidade.
    expect(preview.lines[0]?.containers).toBe(100);
  });

  // O garantido nasce sem multiplicador (`:2557`), então a ausência
  // do arquivo global não tira nada dele.
  it('o garantido continua com unidades mesmo sem o arquivo global', () => {
    const preview = previewOf(
      table({ guaranteed: [guaranteed({ min: 10, max: 10 })] }),
      null,
      100,
      labelOf,
    );

    expect(preview.lines[0]?.units).toBe(1000);
  });

  it('com o arquivo global presente, nada fica de fora', () => {
    const preview = previewOf(table(), GLOBALS, 100, labelOf);

    expect(preview.unknownMultiplier).toBe(false);
  });
});

describe('flatShareOf', () => {
  // ####  A CAIXA VAZIA É O CASO NORMAL, E NÃO A BORDA  ####
  //
  // É onde se começa uma tabela nova. Com o item que ainda vai
  // entrar, a conta é `1/1` — e a resposta é 100 %, não travessão.
  it('a caixa vazia mais o item novo dá 100 %', () => {
    expect(flatShareOf(0 + 1)).toBe(1);
    expect(formatChance(flatShareOf(0 + 1))).toBe('100,0 %');
  });

  it('divide pelo que recebe', () => {
    expect(flatShareOf(4)).toBe(0.25);
    expect(flatShareOf(1)).toBe(1);
  });

  // Zero não é uma fatia, é a ausência dela — e a lista de uma caixa
  // vazia divide pelo tamanho dela, sem o item novo.
  it('sem ninguém por quem dividir, é travessão e não zero', () => {
    expect(flatShareOf(0)).toBeNull();
    expect(flatShareOf(-1)).toBeNull();
    expect(formatChance(flatShareOf(0))).toBe('—');
  });
});

describe('formatMultiplier', () => {
  // ####  "—×" SE LÊ COMO NÚMERO QUE NÃO CARREGOU  ####
  //
  // O travessão diz "não sei"; o travessão com sufixo diz "defeito
  // de tela". O `×` só existe quando há número na frente dele.
  it('o ausente é travessão puro, sem o sufixo', () => {
    expect(formatMultiplier(null)).toBe('—');
    expect(formatMultiplier(null)).not.toContain('×');
  });

  it('o presente leva o sinal de vezes', () => {
    expect(formatMultiplier(1)).toBe('1×');
    expect(formatMultiplier(5)).toBe('5×');
  });
});

describe('formatChance', () => {
  // ####  1/5000 NÃO PODE VIRAR "0,0 %"  ####
  //
  // É a ordem de grandeza de um item raro, e arredondar diria ao
  // admin que ele nunca sai.
  it('vira "1 em N" quando a porcentagem sumiria no arredondamento', () => {
    expect(formatChance(1 / 5000)).toBe('1 em 5.000');
    expect(formatChance(0.00001)).toBe('1 em 100.000');
  });

  it('mostra casas suficientes na faixa do meio', () => {
    expect(formatChance(0.5)).toBe('50,0 %');
    expect(formatChance(0.05)).toBe('5,00 %');
    expect(formatChance(0.005)).toBe('0,500 %');
  });

  it('desconhecido é travessão, e nunca zero', () => {
    expect(formatChance(null)).toBe('—');
  });
});

describe('formatCount', () => {
  it('separa "nenhum" de "menos de um"', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(0.2)).toBe('< 1');
    expect(formatCount(null)).toBe('—');
  });

  it('arredonda o resto', () => {
    expect(formatCount(1234.6)).toBe('1.235');
  });
});
