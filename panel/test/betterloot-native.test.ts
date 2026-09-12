// ============================================================
//  O que é do JOGO e o que é da casa, numa caixa do BetterLoot.
//
//  ####  ERRAR AQUI FAZ O ADMIN APAGAR O TRABALHO DELE  ####
//
//  A tela pinta cada linha da caixa com a origem que sai daqui, e
//  oferece um botão que REMOVE o que não é do jogo. Uma
//  classificação errada não aparece como defeito: ela aparece como
//  o troféu da casa marcado "do jogo", sobrevivendo a um "voltar
//  ao padrão" que devia tê-lo tirado — ou, pior, como item do Rust
//  marcado "da casa" e varrido por um clique.
//
//  As três regras que este arquivo guarda, e que nenhuma delas se
//  vê olhando a tela:
//
//    1. o casamento é por CHAVE EXATA. `rifle.ak` é do jogo;
//       `rifle.ak{1}`, a segunda AK com skin própria, é da casa.
//       Comparar pelo shortname base marcaria as duas como do
//       jogo;
//    2. o garantido do jogo conta como do jogo mesmo quando a
//       caixa o guarda entre os itens soltos — o plugin move
//       entradas entre as duas listas sozinho;
//    3. importar NUNCA reescreve quantidade de quem já está lá. Um
//       servidor 10x que trouxesse os itens que faltam não pode
//       voltar a 1x no caminho.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  compareWithNative,
  importNative,
  isAdopted,
  switchesDisagree,
} from '@/components/loot/betterloot-native';
import type {
  BetterLootEntry,
  BetterLootGuaranteedEntry,
  BetterLootNativeTable,
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
    max: 25,
    ...patch,
  };
}

function table(patch: Partial<BetterLootTable> = {}): BetterLootTable {
  return {
    prefab: 'assets/bundled/prefabs/radtown/crate_elite.prefab',
    enabled: true,
    watched: true,
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

function native(patch: Partial<BetterLootNativeTable> = {}): BetterLootNativeTable {
  return {
    prefab: 'assets/bundled/prefabs/radtown/crate_elite.prefab',
    source: 'container',
    slotsMin: 8,
    slotsMax: 8,
    scrap: 25,
    items: [
      { shortname: 'rifle.ak', min: 1, max: 1 },
      { shortname: 'metal.refined', min: 2, max: 8 },
    ],
    guaranteed: [],
    ...patch,
  };
}

describe('compareWithNative', () => {
  it('sem resposta do servidor, nenhuma linha é classificada', () => {
    const comparison = compareWithNative(table({ items: [entry()] }), null);

    // `unknown`, e não `added`: pintar tudo como da casa com o
    // servidor parado faria a tela afirmar o que ninguém perguntou.
    expect(comparison.originOf('rifle.ak')).toBe('unknown');
    expect(comparison.missing).toEqual([]);
    expect(comparison.native).toBeNull();
  });

  it('separa o item do jogo do que foi acrescentado', () => {
    const comparison = compareWithNative(
      table({
        items: [entry(), entry({ key: 'discord.trophy', shortname: 'discord.trophy' })],
      }),
      native(),
    );

    expect(comparison.originOf('rifle.ak')).toBe('game');
    expect(comparison.originOf('discord.trophy')).toBe('added');
    expect(comparison.fromGame).toBe(1);
    expect(comparison.added).toBe(1);
  });

  it('a segunda cópia do mesmo item, com sufixo, é da casa', () => {
    // O caso do Troféu Bleik: `rifle.ak{1}` é uma AK com skin
    // nossa. Casar pelo shortname base a marcaria como item
    // original do Rust.
    const comparison = compareWithNative(
      table({
        items: [entry(), entry({ key: 'rifle.ak{1}', skinId: '1552602728526292' })],
      }),
      native(),
    );

    expect(comparison.originOf('rifle.ak')).toBe('game');
    expect(comparison.originOf('rifle.ak{1}')).toBe('added');
    expect(comparison.added).toBe(1);
  });

  it('o garantido do jogo conta como do jogo entre os itens soltos', () => {
    // O plugin move entradas entre `Ungrouped` e `Guaranteed`
    // sozinho — o item que sai de todos os galhos vira garantido.
    // A linha não pode mudar de cor por uma decisão que não foi de
    // ninguém.
    const comparison = compareWithNative(
      table({ items: [entry({ key: 'scrap', shortname: 'scrap' })] }),
      native({ items: [], guaranteed: [{ shortname: 'scrap', min: 1, max: 1 }] }),
    );

    expect(comparison.originOf('scrap')).toBe('game');
  });

  it('lista o que o jogo põe e a caixa não tem', () => {
    const comparison = compareWithNative(table({ items: [entry()] }), native());

    expect(comparison.missing.map((item) => item.shortname)).toEqual(['metal.refined']);
    expect(comparison.missing[0]?.min).toBe(2);
    expect(comparison.missing[0]?.max).toBe(8);
  });

  it('o que já está entre os garantidos não conta como faltando', () => {
    const comparison = compareWithNative(
      table({ guaranteed: [guaranteed({ key: 'metal.refined', shortname: 'metal.refined' })] }),
      native(),
    );

    expect(comparison.missing.map((item) => item.shortname)).toEqual(['rifle.ak']);
  });

  it('caixa montada só com perfis recebe o padrão inteiro como faltante', () => {
    // É o caso da crate_normal que chegou como reclamação: alguém
    // apagou a lista de itens e deixou só os grupos.
    const comparison = compareWithNative(
      table({ items: [], profiles: [{ name: 'armas', enabled: true, probability: 100, maxItems: 0 }] }),
      native(),
    );

    expect(comparison.missing).toHaveLength(2);
    expect(comparison.fromGame).toBe(0);
  });
});

describe('importNative — trazer o que falta', () => {
  it('acrescenta só o que não existe, e não tira nada', () => {
    const before = table({
      items: [entry(), entry({ key: 'discord.trophy', shortname: 'discord.trophy' })],
    });
    const outcome = importNative(before, native(), 'fill');

    expect(outcome.added).toBe(1);
    expect(outcome.removed).toBe(0);
    expect(outcome.table.items.map((item) => item.key)).toEqual([
      'rifle.ak',
      'discord.trophy',
      'metal.refined',
    ]);
  });

  it('não reescreve a quantidade de quem já estava na caixa', () => {
    // A regra que protege o servidor 10x: trazer o que falta não
    // pode devolver a AK a 1–1 porque é isso que o jogo faz.
    const before = table({ items: [entry({ min: 10, max: 20 })] });
    const outcome = importNative(before, native(), 'fill');

    expect(outcome.table.items[0]?.min).toBe(10);
    expect(outcome.table.items[0]?.max).toBe(20);
  });

  it('a entrada nova nasce com a quantidade do jogo e sem skin', () => {
    const outcome = importNative(table(), native(), 'fill');
    const refined = outcome.table.items.find((item) => item.key === 'metal.refined');

    expect(refined?.min).toBe(2);
    expect(refined?.max).toBe(8);
    expect(refined?.skinId).toBe('0');
    // Os três que o `scanEntry` do plugin preenche ao validar vão
    // nulos: mandar palpite é mandar o que ele apaga na volta.
    expect(refined?.canConvertToBlueprint).toBeNull();
    expect(refined?.durability).toBeNull();
  });

  it('o garantido do jogo entra na lista de garantidos', () => {
    const outcome = importNative(
      table(),
      native({ items: [], guaranteed: [{ shortname: 'scrap', min: 5, max: 5 }] }),
      'fill',
    );

    expect(outcome.guaranteedAdded).toBe(1);
    expect(outcome.table.guaranteed.map((item) => item.key)).toEqual(['scrap']);
    expect(outcome.table.items).toEqual([]);
  });

  it('não mexe no "quanto sai"', () => {
    const before = table({ itemSettings: { ...table().itemSettings, minItems: 3, maxItems: 3 } });
    const outcome = importNative(before, native(), 'fill');

    expect(outcome.table.itemSettings.minItems).toBe(3);
    expect(outcome.settingsChanged).toBe(false);
  });

  it('não mexe nos perfis', () => {
    const profiles = [{ name: 'armas', enabled: true, probability: 100, maxItems: 0 }];
    const outcome = importNative(table({ profiles }), native(), 'fill');

    expect(outcome.table.profiles).toEqual(profiles);
  });

  it('as contagens do resumo acompanham as listas', () => {
    // Elas viajam no PUT e alimentam a lista da esquerda: deixá-las
    // para trás faria a caixa mostrar um número e ter outro.
    const outcome = importNative(table(), native(), 'fill');

    expect(outcome.table.itemCount).toBe(outcome.table.items.length);
    expect(outcome.table.guaranteedCount).toBe(outcome.table.guaranteed.length);
  });
});

describe('importNative — voltar ao loot do jogo', () => {
  it('tira o que o jogo não põe e traz o que falta', () => {
    const before = table({
      items: [entry({ min: 10, max: 20 }), entry({ key: 'discord.trophy', shortname: 'discord.trophy' })],
    });
    const outcome = importNative(before, native(), 'reset');

    expect(outcome.removed).toBe(1);
    expect(outcome.added).toBe(1);
    expect(outcome.table.items.map((item) => item.key)).toEqual(['rifle.ak', 'metal.refined']);
    // Quem fica, fica COMO ESTÁ: "voltar ao padrão" devolve a
    // lista, e não as quantidades. A tela escreve isso por extenso.
    expect(outcome.table.items[0]?.min).toBe(10);
  });

  it('devolve o "quanto sai" ao do jogo', () => {
    const before = table({
      items: [entry()],
      itemSettings: { ...table().itemSettings, minItems: 3, maxItems: 3, minScrap: 0, maxScrap: 0 },
    });
    const outcome = importNative(before, native(), 'reset');

    expect(outcome.table.itemSettings.minItems).toBe(8);
    expect(outcome.table.itemSettings.maxItems).toBe(8);
    expect(outcome.table.itemSettings.minScrap).toBe(25);
    expect(outcome.settingsChanged).toBe(true);
  });

  it('não zera o scrap de quem não é contêiner', () => {
    // O plugin responde `scrap: 0` para corpo de cientista e para
    // presente — gravar esse zero apagaria um valor que alguém pôs
    // ali de propósito.
    const before = table({ itemSettings: { ...table().itemSettings, minScrap: 5, maxScrap: 5 } });
    const outcome = importNative(before, native({ source: 'npc', scrap: 0 }), 'reset');

    expect(outcome.table.itemSettings.minScrap).toBe(5);
    expect(outcome.table.itemSettings.maxScrap).toBe(5);
  });

  it('preserva o garantido que o jogo também põe', () => {
    const before = table({
      guaranteed: [
        guaranteed({ key: 'rifle.ak', shortname: 'rifle.ak' }),
        guaranteed({ key: 'discord.trophy', shortname: 'discord.trophy' }),
      ],
    });
    const outcome = importNative(before, native(), 'reset');

    expect(outcome.table.guaranteed.map((item) => item.key)).toEqual(['rifle.ak']);
  });

  it('não mexe nos perfis', () => {
    // "Substituir o loot original por perfis" e "combinar os dois"
    // são os dois casos que o dono pediu — e nenhum dos dois
    // sobrevive se voltar ao padrão desligar os grupos.
    const profiles = [{ name: 'armas', enabled: true, probability: 100, maxItems: 0 }];
    const outcome = importNative(table({ profiles }), native(), 'reset');

    expect(outcome.table.profiles).toEqual(profiles);
  });
});

describe('isAdopted', () => {
  it('exige os dois interruptores', () => {
    expect(isAdopted({ enabled: true, watched: true })).toBe(true);
    expect(isAdopted({ enabled: true, watched: false })).toBe(false);
    expect(isAdopted({ enabled: false, watched: true })).toBe(false);
  });

  it('sem BetterLoot.json, responde pelo que dá para saber', () => {
    // `watched: null` é "não há lista para consultar", e não
    // "está fora dela": tratá-lo como `false` faria toda caixa de
    // um servidor sem configuração aparecer como "jogo".
    expect(isAdopted({ enabled: true, watched: null })).toBe(true);
    expect(isAdopted({ enabled: false, watched: null })).toBe(false);
  });
});

describe('switchesDisagree', () => {
  it('acusa o arquivo que diz uma coisa e o servidor que faz outra', () => {
    expect(switchesDisagree({ enabled: true, watched: false })).toBe(true);
    expect(switchesDisagree({ enabled: false, watched: true })).toBe(true);
  });

  it('concordando, não há o que dizer', () => {
    expect(switchesDisagree({ enabled: true, watched: true })).toBe(false);
    expect(switchesDisagree({ enabled: false, watched: false })).toBe(false);
    expect(switchesDisagree({ enabled: true, watched: null })).toBe(false);
  });
});
