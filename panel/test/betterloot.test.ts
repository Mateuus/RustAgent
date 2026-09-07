// ============================================================
//  O vocabulário do `LootTables.json`, traduzido para a tela.
//
//  ####  CLASSIFICAR ERRADO NÃO QUEBRA NADA — E É O PROBLEMA  ####
//
//  A caixa de elite dentro de "Corpos de NPC" não produz erro
//  nenhum: produz um admin que não a acha. E dois rótulos "Caixa de
//  elite" na mesma lista produzem coisa pior — ele edita a de baixo
//  d'água achando que mexeu na de radtown, e nada avisa.
//
//  Os caminhos abaixo são os do arquivo REAL, gerado pelo BetterLoot
//  no server01 e medido em Backups/server01/betterloot-gerado-*:
//  111 chaves, 33 de NPC, 9 de `unwrap/`, 5 nomes curtos repetidos.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  duplicatedShortNames,
  labelOfPrefab,
  matchesRow,
  natureOfPrefab,
  nextEntryKey,
  rowOf,
  rowsOf,
  sectionOfPrefab,
  sectionsOf,
  shortPrefabOf,
} from '@/components/loot/betterloot';
import type { BetterLootItemSettings, BetterLootTableSummary } from '@/lib/api';

const SETTINGS: BetterLootItemSettings = {
  minItems: 3,
  maxItems: 6,
  minScrap: 0,
  maxScrap: 0,
  minBlueprints: 0,
  maxBlueprints: 1,
  bonusItemsCountToTotal: false,
  guaranteedItemsCountToTotal: true,
};

function summary(prefab: string, patch: Partial<BetterLootTableSummary> = {}): BetterLootTableSummary {
  return {
    prefab,
    enabled: true,
    itemCount: 10,
    guaranteedCount: 0,
    profileCount: 0,
    itemSettings: SETTINGS,
    ...patch,
  };
}

describe('natureOfPrefab', () => {
  it('separa caixa, corpo de NPC e presente', () => {
    expect(natureOfPrefab('assets/bundled/prefabs/radtown/crate_elite.prefab')).toBe('container');
    expect(
      natureOfPrefab('assets/rust.ai/agents/npcplayer/humannpc/scientist/gen2/scientist2.prefab'),
    ).toBe('npc');
    expect(natureOfPrefab('unwrap/xmas.present.large')).toBe('unwrap');
  });

  // Os 33 cientistas medidos vêm de dois caminhos diferentes, e os
  // dois precisam cair no mesmo lugar — senão metade deles aparece
  // no meio das caixas.
  it('pega os cientistas pelos dois caminhos do arquivo', () => {
    expect(
      natureOfPrefab('assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_cargo.prefab'),
    ).toBe('npc');
    expect(natureOfPrefab('assets/prefabs/npc/scientist/scientist.prefab')).toBe('npc');
  });

  // As caixas de heli e Bradley moram em `prefabs/npc/`, mas são
  // CAIXAS: o admin as procura entre os eventos. Cair no grupo de
  // corpos as esconderia numa seção que nasce fechada.
  it('a caixa do helicóptero é caixa, e não corpo', () => {
    expect(natureOfPrefab('assets/prefabs/npc/patrol helicopter/heli_crate.prefab')).toBe(
      'container',
    );
    expect(natureOfPrefab('assets/prefabs/npc/m2bradley/bradley_crate.prefab')).toBe('container');
  });
});

describe('shortPrefabOf', () => {
  it('tira a pasta e a extensão', () => {
    expect(shortPrefabOf('assets/bundled/prefabs/radtown/crate_elite.prefab')).toBe('crate_elite');
  });

  // `unwrap/` não é pasta: o que vem depois da barra é o shortname
  // do ITEM que se abre.
  it('o `unwrap/` não é caminho', () => {
    expect(shortPrefabOf('unwrap/xmas.present.large')).toBe('xmas.present.large');
    expect(shortPrefabOf('unwrap/easter.goldegg')).toBe('easter.goldegg');
  });

  it('aguenta prefab com espaço no nome', () => {
    expect(shortPrefabOf('assets/bundled/prefabs/radtown/dmloot/dm ammo.prefab')).toBe('dm ammo');
  });
});

describe('duplicatedShortNames', () => {
  // Medido: são exatamente estes cinco no arquivo real.
  it('acha os nomes curtos que aparecem duas vezes', () => {
    const tables = [
      summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
      summary('assets/bundled/prefabs/radtown/underwater_labs/crate_elite.prefab'),
      summary('assets/bundled/prefabs/radtown/loot_barrel_1.prefab'),
    ];

    const duplicated = duplicatedShortNames(tables);

    expect(duplicated.has('crate_elite')).toBe(true);
    expect(duplicated.has('loot_barrel_1')).toBe(false);
  });
});

describe('labelOfPrefab', () => {
  it('usa o apelido que o admin reconhece', () => {
    expect(labelOfPrefab('assets/bundled/prefabs/radtown/crate_elite.prefab')).toBe(
      'Caixa de elite',
    );
  });

  // ####  O DESEMPATE É O QUE IMPEDE A TELA DE MENTIR  ####
  //
  // Duas linhas "Caixa de elite" e o admin edita a errada — sem
  // erro, sem sintoma, e só aparece no wipe seguinte.
  it('marca a origem quando o nome curto se repete', () => {
    expect(
      labelOfPrefab('assets/bundled/prefabs/radtown/underwater_labs/crate_elite.prefab', true),
    ).toBe('Caixa de elite (labs)');
    expect(labelOfPrefab('assets/bundled/prefabs/radtown/crate_elite.prefab', true)).toBe(
      'Caixa de elite',
    );
  });

  it('dá nome legível ao que ninguém apelidou', () => {
    expect(labelOfPrefab('assets/bundled/prefabs/radtown/underwater_labs/crate_fuel.prefab')).toBe(
      'Caixa de combustível',
    );
  });
});

describe('sectionsOf', () => {
  it('põe caixa, corpo e presente em seções diferentes', () => {
    const sections = sectionsOf([
      summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
      summary('assets/rust.ai/agents/npcplayer/humannpc/scientist/gen2/scientist2.prefab'),
      summary('unwrap/xmas.present.large'),
    ]);

    const ids = sections.map((section) => section.id);

    expect(ids).toContain('riskCrates');
    expect(ids).toContain('npc');
    expect(ids).toContain('unwrap');
  });

  // 42 das 111 chaves são corpo ou presente. Abertas, elas afogam a
  // caixa de elite; filtradas, somem de vez.
  it('corpos e presentes nascem fechados; as caixas de risco não', () => {
    const sections = sectionsOf([
      summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
      summary('assets/rust.ai/agents/npcplayer/humannpc/scientist/gen2/scientist2.prefab'),
      summary('unwrap/xmas.present.large'),
    ]);

    expect(sections.find((section) => section.id === 'npc')?.collapsed).toBe(true);
    expect(sections.find((section) => section.id === 'unwrap')?.collapsed).toBe(true);
    expect(sections.find((section) => section.id === 'riskCrates')?.collapsed).toBe(false);
  });

  it('não cria seção vazia', () => {
    const sections = sectionsOf([summary('assets/bundled/prefabs/radtown/crate_elite.prefab')]);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe('riskCrates');
  });

  it('desempata os nomes repetidos dentro da lista inteira', () => {
    const sections = sectionsOf([
      summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
      summary('assets/bundled/prefabs/radtown/underwater_labs/crate_elite.prefab'),
    ]);

    const labels = sections.flatMap((section) => section.rows.map((row) => row.label));

    expect(new Set(labels).size).toBe(2);
  });
});

describe('sectionOfPrefab', () => {
  // ####  "OUTROS" NASCE FECHADO, E ISSO O TORNA UM SUMIÇO  ####
  //
  // Rodando a classificação contra as 111 chaves reais do server01,
  // dezenove caíam ali — as dez caixas de deathmatch, as cinco
  // reservas de comida, as peças de labs e os dois barcos do mar
  // profundo. Todas úteis, todas dentro de uma seção colapsada.
  it('tira do genérico o que o `containers.ts` não conhece', () => {
    expect(sectionOfPrefab('assets/bundled/prefabs/radtown/dmloot/dm c4.prefab')).toBe('deathmatch');
    expect(
      sectionOfPrefab('assets/bundled/prefabs/radtown/underwater_labs/tech_parts_1.prefab'),
    ).toBe('labs');
    expect(sectionOfPrefab('assets/content/vehicles/boats/rhib/rhib.deepsea.prefab')).toBe('events');
    expect(sectionOfPrefab('assets/prefabs/misc/food cache/food_cache_001.prefab')).toBe(
      'commonCrates',
    );
    expect(sectionOfPrefab('assets/content/props/roadsigns/roadsign1.prefab')).toBe('barrels');
    expect(sectionOfPrefab('assets/bundled/prefabs/radtown/vehicle_parts.prefab')).toBe(
      'commonCrates',
    );
  });

  it('a natureza vem antes de qualquer pista de caminho', () => {
    expect(
      sectionOfPrefab('assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_rhib.prefab'),
    ).toBe('npc');
    expect(sectionOfPrefab('unwrap/halloween.lootbag.large')).toBe('unwrap');
  });
});

describe('rowsOf', () => {
  // ####  A SEGUNDA CAMADA DE DESEMPATE É A REDE  ####
  //
  // `scientist2.heavy` e `scientistnpc_heavy` têm nomes curtos
  // DIFERENTES — o desempate por origem não os pega —, e os dois
  // cairiam em "Cientista · heavy". Duas linhas idênticas numa
  // lista de edição é o admin editando uma achando que é a outra.
  it('nenhum rótulo se repete, mesmo com nomes curtos diferentes', () => {
    const rows = rowsOf([
      summary('assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab'),
      summary('assets/rust.ai/agents/npcplayer/humannpc/scientist/gen2/scientist2.heavy.prefab'),
      summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
      summary('assets/bundled/prefabs/radtown/underwater_labs/crate_elite.prefab'),
    ]);

    const labels = rows.map((row) => row.label);

    expect(new Set(labels).size).toBe(labels.length);
  });

  // A camada feia só entra quando a bonita falhou: colar o prefab no
  // nome de toda linha gastaria a coluna inteira dizendo o que já
  // está escrito embaixo.
  it('não estraga o rótulo de quem já era único', () => {
    const rows = rowsOf([
      summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
      summary('assets/bundled/prefabs/radtown/loot_barrel_1.prefab'),
    ]);

    expect(rows.map((row) => row.label)).toEqual(['Caixa de elite', 'Barril de estrada 1']);
  });

  // Os `npc_*` são moradores de túnel, e não cientistas. Chamá-los
  // de cientista faria o admin ajustar o loot dos túneis achando
  // que mexia na radtown.
  it('o morador do túnel não vira cientista', () => {
    const rows = rowsOf([
      summary('assets/rust.ai/agents/npcplayer/humannpc/tunneldweller/npc_tunneldweller.prefab'),
    ]);

    expect(rows[0]?.label).toBe('Morador do túnel');
  });
});

describe('matchesRow', () => {
  const row = rowOf(
    summary('assets/bundled/prefabs/radtown/crate_elite.prefab'),
    new Set<string>(),
  );

  it('acha pelo apelido, pelo nome curto e pelo caminho', () => {
    expect(matchesRow(row, 'elite')).toBe(true);
    expect(matchesRow(row, 'crate_eli')).toBe(true);
    expect(matchesRow(row, 'radtown')).toBe(true);
    expect(matchesRow(row, 'barril')).toBe(false);
  });

  it('ignora acento e caixa alta dos dois lados', () => {
    expect(matchesRow(row, 'CAIXA DE ÉLITE')).toBe(true);
    expect(matchesRow(row, 'caixa de elite')).toBe(true);
    expect(matchesRow(row, 'Caixa')).toBe(true);
  });

  it('busca vazia casa com tudo', () => {
    expect(matchesRow(row, '   ')).toBe(true);
  });
});

describe('nextEntryKey', () => {
  // ####  SEM O SUFIXO, O SEGUNDO TROFÉU APAGA O PRIMEIRO  ####
  //
  // `Ungrouped Items` é um dicionário chaveado por shortname. Dois
  // itens nossos com o mesmo corpo emprestado e skins diferentes
  // precisam de duas chaves — e o plugin tira `{\d+}` antes de
  // resolver o item, o que é exatamente o que torna isso possível.
  it('a primeira entrada de um item usa o shortname puro', () => {
    expect(nextEntryKey('discord.trophy', [])).toBe('discord.trophy');
  });

  it('a segunda ganha sufixo, e a terceira o seguinte', () => {
    expect(nextEntryKey('discord.trophy', ['discord.trophy'])).toBe('discord.trophy{1}');
    expect(nextEntryKey('discord.trophy', ['discord.trophy', 'discord.trophy{1}'])).toBe(
      'discord.trophy{2}',
    );
  });

  it('preenche o buraco em vez de sempre crescer', () => {
    expect(nextEntryKey('discord.trophy', ['discord.trophy', 'discord.trophy{2}'])).toBe(
      'discord.trophy{1}',
    );
  });

  it('não inventa chave para nome vazio', () => {
    expect(nextEntryKey('   ', [])).toBe('');
  });
});
