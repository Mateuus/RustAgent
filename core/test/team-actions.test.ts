// ============================================================
//  team-actions.test.ts  -  onde a permissão é COBRADA.
//
//  ####  A TELA JÁ TEM TESTE; ELE NÃO BASTA  ####
//
//  `ui-team-screen.test.ts` prova que o botão de expulsar não é
//  DESENHADO para quem não pode. Isto aqui prova a outra metade, e
//  é a que importa de verdade: o endereço de um botão é digitável
//  no F1, e um jogador que nunca viu o botão pode mandar o clique
//  dele.
//
//  Quem chega aqui já passou pelo plugin — token de sessão, ação
//  na tela de agora. O que o plugin NÃO sabe é quem tem cargo para
//  quê, nem se o alvo está na mesma equipe. É o que se cobra aqui.
//
//  ####  O SERVIÇO É DE MENTIRA, E O JOGO É QUE É A VERDADE  ####
//
//  O de verdade pergunta ao Rust por RCON a cada chamada. O daqui
//  devolve uma equipe de mesa E ANOTA o que lhe pediram — porque
//  metade destes testes é sobre o que NÃO pode ser chamado.
// ============================================================

import { describe, expect, it } from 'vitest';

import { TeamCommandError } from '../src/game/teams.js';
import { runTeamAction, type TeamActionService } from '../src/game/team-actions.js';
import type { Team, TeamMember } from '../src/types/teams.js';

const LEADER = '76561198000000001';
const OFFICER = '76561198000000002';
const PLAIN = '76561198000000003';
const OTHER = '76561198000000004';
const ESTRANHO = '76561198000000099';

function member(over: Partial<TeamMember> & { steamId: string }): TeamMember {
  return { name: `J${over.steamId.slice(-2)}`, online: true, leader: false, rank: 'member', ...over };
}

function team(over: Partial<Team> = {}): Team {
  const members = over.members ?? [
    member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
    member({ steamId: OFFICER, name: 'Bia', rank: 'officer' }),
    member({ steamId: PLAIN, name: 'Caio' }),
    member({ steamId: OTHER, name: 'Dani' }),
  ];

  return {
    teamId: '20',
    name: '',
    leader: LEADER,
    leaderName: 'Mateuus',
    ageSeconds: 10,
    invites: [],
    officers: members.filter((entry) => entry.rank === 'officer').length,
    ...over,
    members,
  };
}

/** O que foi pedido ao serviço. Vazio é a resposta de metade dos testes. */
interface Trace {
  readonly calls: string[];
  readonly service: TeamActionService;
}

function harness(options: { readonly team?: Team | null; readonly throws?: Error } = {}): Trace {
  const calls: string[] = [];
  const current = options.team === undefined ? team() : options.team;

  const service: TeamActionService = {
    teamOf: async () => {
      if (options.throws !== undefined) throw options.throws;

      return current;
    },
    rename: async (_serverId, _teamId, name) => {
      calls.push(`rename:${name}`);

      return team({ name });
    },
    kick: async (_serverId, _teamId, steamId) => {
      calls.push(`kick:${steamId}`);

      return current;
    },
    setLeader: async (_serverId, _teamId, steamId) => {
      calls.push(`leader:${steamId}`);

      return current ?? team();
    },
    setRank: async (payload) => {
      calls.push(`rank:${payload.steamId}:${payload.rank}`);

      return current ?? team();
    },
  };

  return { calls, service };
}

async function run(
  steamId: string,
  action: string,
  extra: { readonly value?: string; readonly team?: Team | null; readonly throws?: Error } = {},
) {
  const h = harness(
    extra.team !== undefined
      ? { team: extra.team }
      : extra.throws !== undefined
        ? { throws: extra.throws }
        : {},
  );

  const outcome = await runTeamAction({
    service: h.service,
    serverId: 'server01',
    steamId,
    action,
    value: extra.value,
  });

  return { ...outcome, calls: h.calls };
}

// ============================================================
//  §1  O QUE NÃO PODE — e o serviço nem é tocado
// ============================================================

describe('a permissão, cobrada no agente', () => {
  it('membro comum não expulsa, mesmo mandando o clique direto', () => {
    return run(PLAIN, `kick:${OTHER}`).then((r) => {
      expect(r.ok).toBe(false);
      expect(r.message).toContain('não permite');
      // E o jogo não foi tocado: a recusa vem ANTES.
      expect(r.calls).toEqual([]);
    });
  });

  it('oficial não expulsa outro oficial', async () => {
    const dois = team({
      members: [
        member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
        member({ steamId: OFFICER, rank: 'officer' }),
        member({ steamId: OTHER, rank: 'officer' }),
      ],
    });

    const r = await run(OFFICER, `kick:${OTHER}`, { team: dois });

    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('oficial não expulsa o líder', async () => {
    const r = await run(OFFICER, `kick:${LEADER}`);

    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('oficial não promove ninguém, nem passa liderança, nem renomeia', async () => {
    for (const action of [`rank:${PLAIN}`, `leader:${PLAIN}`, 'name']) {
      const r = await run(OFFICER, action, { value: 'Alcateia' });

      expect(r.ok).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  it('ninguém age sobre si mesmo', async () => {
    const r = await run(LEADER, `kick:${LEADER}`);

    expect(r.ok).toBe(false);
    expect(r.message).toContain('SAIR DA EQUIPE');
    expect(r.calls).toEqual([]);
  });

  it('o alvo de FORA da equipe não é alcançado', async () => {
    // O endereço é digitável: este é o clique forjado que tentaria
    // expulsar alguém de OUTRO time. A lista veio do jogo, para a
    // equipe de quem clicou — e ele não está nela.
    const r = await run(LEADER, `kick:${ESTRANHO}`);

    expect(r.ok).toBe(false);
    expect(r.message).toContain('não está mais na equipe');
    expect(r.calls).toEqual([]);
  });

  it('um SteamID que não é SteamID não vira comando', async () => {
    for (const lixo of ['kick:abc', 'kick:1', 'kick:', 'kick', 'naoexiste:76561198000000003']) {
      const r = await run(LEADER, lixo);

      expect(r.ok).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  it('quem não está em equipe nenhuma não age', async () => {
    const r = await run(PLAIN, `kick:${OTHER}`, { team: null });

    expect(r.ok).toBe(false);
    expect(r.message).toContain('não está em uma equipe');
    expect(r.calls).toEqual([]);
  });
});

// ============================================================
//  §2  O QUE PODE
// ============================================================

describe('o que o líder pode', () => {
  it('expulsa um membro', async () => {
    const r = await run(LEADER, `kick:${PLAIN}`);

    expect(r.ok).toBe(true);
    expect(r.calls).toEqual([`kick:${PLAIN}`]);
  });

  it('promove um membro e rebaixa um oficial — o mesmo botão', async () => {
    const promove = await run(LEADER, `rank:${PLAIN}`);

    expect(promove.ok).toBe(true);
    expect(promove.calls).toEqual([`rank:${PLAIN}:officer`]);

    // O destino sai do cargo de AGORA, relido do jogo — e não do
    // que a tela mostrava quando foi desenhada.
    const rebaixa = await run(LEADER, `rank:${OFFICER}`);

    expect(rebaixa.calls).toEqual([`rank:${OFFICER}:member`]);
  });

  it('passa a liderança', async () => {
    const r = await run(LEADER, `leader:${OFFICER}`);

    expect(r.ok).toBe(true);
    expect(r.calls).toEqual([`leader:${OFFICER}`]);
  });

  it('o oficial expulsa um membro comum', async () => {
    const r = await run(OFFICER, `kick:${PLAIN}`);

    expect(r.ok).toBe(true);
    expect(r.calls).toEqual([`kick:${PLAIN}`]);
  });
});

describe('sair da equipe', () => {
  it('qualquer um sai, e sai por si mesmo', async () => {
    const r = await run(PLAIN, 'leave');

    expect(r.ok).toBe(true);
    expect(r.calls).toEqual([`kick:${PLAIN}`]);
  });

  it('o último avisa que a equipe será desfeita', async () => {
    const sozinho = team({
      members: [member({ steamId: LEADER, leader: true, rank: 'leader' })],
    });

    const r = await run(LEADER, 'leave', { team: sozinho });

    expect(r.ok).toBe(true);
    expect(r.message).toContain('desfeita');
  });
});

// ============================================================
//  §3  O NOME — o texto vem CRU do cliente
// ============================================================

describe('o nome da equipe', () => {
  it('o líder renomeia, e o nome chega aparado', async () => {
    const r = await run(LEADER, 'name', { value: '  Alcateia do Norte  ' });

    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(['rename:Alcateia do Norte']);
  });

  it('nome vazio é recusado, e o jogo não é tocado', async () => {
    for (const vazio of ['', '   ']) {
      const r = await run(LEADER, 'name', { value: vazio });

      expect(r.ok).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  it('o clique no SALVAR sem tocar no campo ensina, em vez de reclamar de nome vazio', async () => {
    // Nenhum botão do CUI consegue LER o campo. Quem manda o texto
    // é o `onEndEdit` dele, ao PERDER O FOCO — e clicar em SALVAR é
    // o que tira o foco (medido no jogo em 16/09/2026).
    //
    // Este caso é o do jogador que clica sem nunca ter tocado no
    // campo: não há foco a perder, e o clique chega sozinho. "O
    // nome não pode ser vazio" seria culpá-lo por uma letra que ele
    // não chegou a digitar.
    const r = await run(LEADER, 'name', { value: undefined });

    expect(r.ok).toBe(false);
    expect(r.message).toContain('Escreva o nome no campo');
    expect(r.calls).toEqual([]);
  });

  it('nome longo demais é recusado — o teto é o do plugin', async () => {
    const r = await run(LEADER, 'name', { value: 'M'.repeat(25) });

    expect(r.ok).toBe(false);
    expect(r.message).toContain('24');
    expect(r.calls).toEqual([]);
  });

  it('quebra de linha é recusada', async () => {
    // No console viraria duas linhas; no CUI, um elemento fora do
    // lugar. O campo do jogo não deixa digitar — mas o comando é
    // digitável no F1.
    const r = await run(LEADER, 'name', { value: 'Alcateia\ndo Norte' });

    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('acento e emoji passam: apelido é apelido', async () => {
    const r = await run(LEADER, 'name', { value: 'Alcatéia 🐺' });

    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(['rename:Alcatéia 🐺']);
  });
});

// ============================================================
//  §4  QUANDO O JOGO NÃO RESPONDE
// ============================================================

describe('o servidor fora do ar', () => {
  it('a frase que o jogador lê é a do serviço, e não uma genérica', async () => {
    const r = await run(LEADER, `kick:${PLAIN}`, {
      throws: new TeamCommandError('offline', 'O servidor não está com o RCON de pé.'),
    });

    expect(r.ok).toBe(false);
    expect(r.message).toBe('O servidor não está com o RCON de pé.');
  });

  it('um erro que não é do serviço não vaza para a tela do jogador', async () => {
    // Pilha de exceção, caminho de arquivo, nome de função: nada
    // disso ajuda quem está olhando o menu.
    const r = await run(LEADER, `kick:${PLAIN}`, {
      throws: new Error('ECONNRESET at Socket._read (node:net:1234)'),
    });

    expect(r.ok).toBe(false);
    expect(r.message).toBe('Não deu para fazer isso agora.');
  });
});
