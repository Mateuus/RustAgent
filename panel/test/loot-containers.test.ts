// ============================================================
//  O agrupamento dos contêineres de loot.
//
//  ####  CLASSIFICAR ERRADO NÃO QUEBRA NADA — E É O PROBLEMA  ####
//
//  A caixa de elite dentro de "Outros" não produz erro nenhum:
//  produz um admin que não a acha e conclui que o painel não a
//  tem. O mesmo vale para o apelido: quem lê "Caixa de elite" e
//  marca `crate_elite_tutorial` só descobre no wipe seguinte.
//
//  Os grupos e os prefabs são os medidos no Docs/CustomItem/05
//  §8.2 e no 04 §6.4.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_CONTAINERS,
  groupContainers,
  groupOf,
  groupOfName,
  labelOf,
  labelOfName,
  matchesContainer,
} from '@/components/loot/containers';
import type { LootContainerInfo } from '@/lib/api';

function container(patch: Partial<LootContainerInfo> = {}): LootContainerInfo {
  return { name: 'crate_elite', label: null, group: null, refreshSeconds: null, ...patch };
}

describe('groupOfName', () => {
  it('põe cada contêiner medido na natureza que o admin espera', () => {
    expect(groupOfName('crate_elite')).toBe('riskCrates');
    expect(groupOfName('loot_barrel_1')).toBe('barrels');
    expect(groupOfName('supply_drop')).toBe('events');
    expect(groupOfName('crate_basic')).toBe('commonCrates');
    expect(groupOfName('missionstash')).toBe('missions');
  });

  // A ordem das pistas importa: tutorial vem antes de elite, senão
  // a caixa do tutorial cairia no meio das caixas de risco.
  it('o tutorial é tutorial antes de ser caixa de elite', () => {
    expect(groupOfName('crate_elite_tutorial')).toBe('missions');
    expect(groupOfName('loot-barrel-tutorial')).toBe('missions');
  });

  it('classifica pelo pedaço do nome o que não está na tabela', () => {
    expect(groupOfName('xmastunnellootbox')).toBe('seasonal');
    expect(groupOfName('player_corpse')).toBe('bodies');
    expect(groupOfName('roadsign_2')).toBe('barrels');
  });

  it('o que ninguém reconhece vai para Outros, e não some', () => {
    expect(groupOfName('coisa_que_nao_existe')).toBe('other');
  });
});

describe('groupOf', () => {
  it('o grupo do agente manda quando o painel o conhece', () => {
    expect(groupOf(container({ name: 'coisa_estranha', group: 'Eventos' }))).toBe('events');
    expect(groupOf(container({ name: 'coisa_estranha', group: 'events' }))).toBe('events');
  });

  it('grupo desconhecido do agente cai na heurística, e não vira seção órfã', () => {
    expect(groupOf(container({ name: 'loot_barrel_1', group: 'Tier 4' }))).toBe('barrels');
  });
});

describe('labelOf', () => {
  it('o nome do agente vence o apelido do painel', () => {
    expect(labelOf(container({ name: 'crate_elite', label: 'Caixa top' }))).toBe('Caixa top');
  });

  it('sem nome do agente, usa o apelido da casa', () => {
    expect(labelOf(container({ name: 'crate_elite' }))).toBe('Caixa de elite');
  });

  it('prefab desconhecido vira texto legível, e não some', () => {
    expect(labelOfName('crate_ammunition_military')).toBe('Crate ammunition military');
  });
});

describe('groupContainers', () => {
  it('não devolve seção vazia', () => {
    const sections = groupContainers([container({ name: 'crate_elite' })]);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.group.id).toBe('riskCrates');
  });

  it('mantém a ordem da tela: risco antes de barril', () => {
    const sections = groupContainers([
      container({ name: 'loot_barrel_1' }),
      container({ name: 'crate_elite' }),
    ]);

    expect(sections.map((section) => section.group.id)).toEqual(['riskCrates', 'barrels']);
  });
});

describe('matchesContainer', () => {
  it('acha pelo apelido, pelo prefab e pelo grupo', () => {
    expect(matchesContainer(container({ name: 'crate_elite' }), 'elite')).toBe(true);
    expect(matchesContainer(container({ name: 'crate_elite' }), 'crate_')).toBe(true);
    expect(matchesContainer(container({ name: 'crate_elite' }), 'risco')).toBe(true);
  });

  it('acha sem acento, porque é assim que se digita com pressa', () => {
    expect(matchesContainer(container({ name: 'supply_drop', label: 'Airdrop' }), 'AIRDROP')).toBe(
      true,
    );
    expect(matchesContainer(container({ name: 'crate_elite' }), 'conteiner')).toBe(false);
  });

  it('busca vazia não filtra nada', () => {
    expect(matchesContainer(container(), '   ')).toBe(true);
  });
});

describe('FALLBACK_CONTAINERS', () => {
  // ####  ELA NÃO AFIRMA REFRESH  ####
  //
  // 71 dos 105 contêineres têm refresh, mas qual é o de cada um
  // só o agente sabe. Um "3600" inventado aqui diria ao admin que
  // a regra volta a valer de hora em hora sem ninguém ter medido.
  it('não inventa refresh nem apelido de agente', () => {
    for (const entry of FALLBACK_CONTAINERS) {
      expect(entry.refreshSeconds).toBeNull();
      expect(entry.label).toBeNull();
      expect(entry.group).toBeNull();
    }
  });

  it('traz os contêineres que o pedido do dono cita', () => {
    const names = FALLBACK_CONTAINERS.map((entry) => entry.name);

    expect(names).toContain('crate_elite');
    expect(names).toContain('heli_crate');
    expect(names).toContain('loot_barrel_1');
    expect(names).toContain('supply_drop');
  });
});
