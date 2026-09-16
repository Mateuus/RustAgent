// ============================================================
//  A busca e a ordem da lista de equipes.
//
//  ####  POR QUE ESTA É A ÚNICA PARTE TESTADA DA TELA  ####
//
//  O resto da aba Equipes é leitura do jogo e cliques — coisa de
//  navegador. Isto aqui é decisão pura, e é a que erra em silêncio:
//  uma ordenação torta não quebra nada, só deixa a equipe que
//  importa fora da vista.
//
//  O caso que motivou o arquivo: equipe SEM NOME. Ordenar por nome
//  com string vazia a joga para o TOPO — bem onde ela menos ajuda,
//  já que "sem nome" não diz nada a ninguém.
// ============================================================

import { describe, expect, it } from 'vitest';

import { filterAndSort } from '../src/components/teams-panel';
import type { Team, TeamMember } from '../src/lib/api';

function member(steamId: string, name: string, online = false): TeamMember {
  return { steamId, name, online, leader: false, rank: 'member' };
}

function team(patch: Partial<Team> = {}): Team {
  return {
    teamId: '1',
    name: 'Alcateia',
    leader: '76561190000000001',
    leaderName: 'Mateuus',
    ageSeconds: 60,
    members: [member('76561190000000001', 'Mateuus')],
    invites: [],
    officers: 0,
    ...patch,
  };
}

describe('a busca', () => {
  it('acha pelo nome da equipe', () => {
    const all = [team({ teamId: '1', name: 'Alcateia' }), team({ teamId: '2', name: 'Os Corvos' })];

    expect(filterAndSort(all, 'corvo', 'size').map((found) => found.teamId)).toEqual(['2']);
  });

  it('acha pelo SteamID de um MEMBRO, que é a pergunta real da tela', () => {
    const all = [
      team({ teamId: '1', members: [member('76561190000000001', 'Mateuus')] }),
      team({ teamId: '2', members: [member('76561190000000099', 'Fulano')] }),
    ];

    expect(filterAndSort(all, '76561190000000099', 'size').map((found) => found.teamId)).toEqual([
      '2',
    ]);
  });

  it('acha pelo nome de um membro, sem diferenciar maiúscula', () => {
    const all = [
      team({ teamId: '1', members: [member('76561190000000001', 'Mateuus')] }),
      team({ teamId: '2', members: [member('76561190000000002', 'Bia')] }),
    ];

    expect(filterAndSort(all, 'BIA', 'size').map((found) => found.teamId)).toEqual(['2']);
  });

  it('busca vazia devolve tudo', () => {
    const all = [team({ teamId: '1' }), team({ teamId: '2' })];

    expect(filterAndSort(all, '   ', 'size')).toHaveLength(2);
  });

  it('não devolve a lista original: ordenar não pode mexer no que veio do agente', () => {
    const all = [team({ teamId: '1', name: 'Zulu' }), team({ teamId: '2', name: 'Alfa' })];

    filterAndSort(all, '', 'name');

    expect(all.map((entry) => entry.teamId)).toEqual(['1', '2']);
  });
});

describe('a ordem', () => {
  it('por tamanho, a maior primeiro', () => {
    const all = [
      team({ teamId: 'pequena', members: [member('1', 'a')] }),
      team({ teamId: 'grande', members: [member('1', 'a'), member('2', 'b'), member('3', 'c')] }),
    ];

    expect(filterAndSort(all, '', 'size')[0]?.teamId).toBe('grande');
  });

  it('por online, quem tem gente dentro primeiro — mesmo sendo menor', () => {
    const all = [
      team({
        teamId: 'grande-offline',
        members: [member('1', 'a'), member('2', 'b'), member('3', 'c')],
      }),
      team({ teamId: 'pequena-online', members: [member('4', 'd', true)] }),
    ];

    expect(filterAndSort(all, '', 'online')[0]?.teamId).toBe('pequena-online');
  });

  it('por nome, e a equipe SEM NOME vai para o fim', () => {
    const all = [
      team({ teamId: 'sem-nome', name: '' }),
      team({ teamId: 'zulu', name: 'Zulu' }),
      team({ teamId: 'alfa', name: 'Alfa' }),
    ];

    expect(filterAndSort(all, '', 'name').map((found) => found.teamId)).toEqual([
      'alfa',
      'zulu',
      'sem-nome',
    ]);
  });

  it('empate no tamanho desempata por quem está online', () => {
    const all = [
      team({ teamId: 'dormindo', members: [member('1', 'a'), member('2', 'b')] }),
      team({ teamId: 'acordada', members: [member('3', 'c', true), member('4', 'd')] }),
    ];

    expect(filterAndSort(all, '', 'size')[0]?.teamId).toBe('acordada');
  });
});
