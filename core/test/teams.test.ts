// ============================================================
//  A equipe do jogo, do lado do agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Metade deste sistema é do JOGO, e a outra metade é nossa. Os
//  defeitos que importam são todos na costura entre as duas:
//
//    o cargo sobrevive à equipe      a pessoa entra num time novo
//                                    com o número da equipe morta e
//                                    aparece promovida
//    o cargo esconde o líder         quem manda de verdade some da
//                                    tela porque tinha linha no banco
//    a varredura apaga demais        cargo de equipe VIVA sumindo
//                                    porque a leitura foi parcial
//    o aviso do console é forjado    um jogador digita `#OZTEAM#…`
//                                    no chat e desfaz a equipe alheia
//    o plugin não está carregado     o comando volta vazio e o agente
//                                    trata isso como "sem equipe"
//
//  Nenhum deles quebra a tela. Todos produzem um dado errado com
//  cara de certo, que é o modo de falhar mais caro que existe.
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { TeamRanksRepository, TeamSettingsRepository } from '../src/db/team-ranks-repository.js';
import { TeamCommandError, TeamsService, TEAM_MARKER } from '../src/game/teams.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

/** Uma equipe como o plugin a descreve. */
function gameTeam(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teamId: '7',
    name: 'Os Lobos',
    leader: '76561190000000001',
    leaderName: 'Mateuus',
    ageSeconds: 120,
    members: [
      { steamId: '76561190000000001', name: 'Mateuus', online: true, leader: true },
      { steamId: '76561190000000002', name: 'Bia', online: true, leader: false },
      { steamId: '76561190000000003', name: 'Caio', online: false, leader: false },
    ],
    invites: [],
    ...patch,
  };
}

interface Harness {
  readonly service: TeamsService;
  readonly ranks: TeamRanksRepository;
  readonly db: AgentDatabase;
  /** Cada comando que saiu pelo RCON, em ordem. */
  readonly sent: string[];
  /** O que responder, por comando. A chave é o começo do comando. */
  readonly replies: Map<string, string>;
  connected: boolean;
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'Dev',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\devserver',
  });

  const ranks = new TeamRanksRepository(db);
  const state: Harness = {
    service: null as unknown as TeamsService,
    ranks,
    db,
    sent: [],
    replies: new Map([['origemz.team list', JSON.stringify({ ok: true, maxSize: 8, teams: [gameTeam()] })]]),
    connected: true,
  };

  const service = new TeamsService({
    ranks,
    settings: new TeamSettingsRepository(db),
    servers: {
      ids: () => [SERVER],
      contextOf: () => ({
        rcon: {
          get isConnected() {
            return state.connected;
          },
          send: (command: string) => {
            state.sent.push(command);

            for (const [prefix, reply] of state.replies) {
              if (command.startsWith(prefix)) return Promise.resolve(reply);
            }

            return Promise.resolve('');
          },
        },
      }),
    },
    logger: silent,
  });

  // O serviço é devolvido por referência, como no teste do
  // agendador: o teste mexe em `connected` e em `replies` DEPOIS de
  // montar, e uma cópia deixaria o serviço lendo o estado antigo.
  return Object.assign(state, { service });
}

describe('ler a equipe', () => {
  it('cola o cargo do banco na equipe que o jogo respondeu', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });

    const snapshot = await h.service.snapshot(SERVER);
    const team = snapshot.teams[0];

    expect(team?.name).toBe('Os Lobos');
    expect(team?.officers).toBe(1);
    expect(team?.members.map((member) => member.rank)).toEqual(['leader', 'officer', 'member']);
  });

  it('o líder do jogo ganha de qualquer linha gravada', async () => {
    const h = harness();

    // Uma promoção antiga do próprio líder: acontece quando ele era
    // oficial e foi promovido a líder depois.
    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000001', rank: 'officer' });

    const snapshot = await h.service.snapshot(SERVER);

    expect(snapshot.teams[0]?.members[0]?.rank).toBe('leader');
  });

  it('a varredura apaga cargo de equipe que não existe mais', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });
    h.ranks.set({ serverId: SERVER, teamId: '99', steamId: '76561190000000009', rank: 'officer' });

    expect(h.ranks.count(SERVER)).toBe(2);

    await h.service.snapshot(SERVER);

    // A 99 não veio na lista do jogo: ela acabou enquanto o agente
    // estava fora.
    expect(h.ranks.count(SERVER)).toBe(1);
    expect(h.ranks.ofTeam(SERVER, '7')).toHaveLength(1);
  });

  it('sem equipe nenhuma no jogo, todo cargo é órfão', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });
    h.replies.set('origemz.team list', JSON.stringify({ ok: true, maxSize: 8, teams: [] }));

    await h.service.snapshot(SERVER);

    expect(h.ranks.count(SERVER)).toBe(0);
  });

  it('com o servidor parado, não inventa resposta', async () => {
    const h = harness();

    h.connected = false;

    await expect(h.service.snapshot(SERVER)).rejects.toThrow(TeamCommandError);
  });

  it('com o plugin fora, diz isso — e não "sem equipe"', async () => {
    const h = harness();

    // Comando que não existe: o RCON devolve vazio.
    h.replies.clear();

    await expect(h.service.snapshot(SERVER)).rejects.toMatchObject({ reason: 'no_plugin' });
  });

  it('uma equipe que não existe devolve null, e não erro', async () => {
    const h = harness();

    h.replies.set(
      'origemz.team get',
      JSON.stringify({ ok: false, error: 'not_found', message: 'Não achei essa equipe.' }),
    );

    await expect(h.service.team(SERVER, '404')).resolves.toBeNull();
  });
});

describe('mexer na equipe', () => {
  it('renomear manda o nome inteiro, com espaços', async () => {
    const h = harness();

    h.replies.set('origemz.team rename', JSON.stringify({ ok: true, team: gameTeam({ name: 'Os Lobos da Neve' }) }));

    const team = await h.service.rename(SERVER, '7', 'Os Lobos da Neve');

    expect(team.name).toBe('Os Lobos da Neve');
    expect(h.sent).toContain('origemz.team rename 7 Os Lobos da Neve');
  });

  it('expulsar apaga o cargo de quem saiu', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });
    h.replies.set('origemz.team kick', JSON.stringify({ ok: true, team: gameTeam() }));

    await h.service.kick(SERVER, '7', '76561190000000002');

    expect(h.ranks.of(SERVER, '7', '76561190000000002')).toBeNull();
  });

  it('expulsar o último desfaz a equipe, e leva os cargos junto', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });
    h.replies.set('origemz.team kick', JSON.stringify({ ok: true, disbanded: true }));

    const team = await h.service.kick(SERVER, '7', '76561190000000001');

    expect(team).toBeNull();
    expect(h.ranks.ofTeam(SERVER, '7')).toHaveLength(0);
  });

  it('quem vira líder não guarda cargo nosso embaixo', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });
    h.replies.set('origemz.team leader', JSON.stringify({ ok: true, team: gameTeam() }));

    await h.service.setLeader(SERVER, '7', '76561190000000002');

    expect(h.ranks.of(SERVER, '7', '76561190000000002')).toBeNull();
  });

  it('promover quem não está na equipe é recusado', async () => {
    const h = harness();

    h.replies.set('origemz.team get', JSON.stringify({ ok: true, maxSize: 8, team: gameTeam() }));

    await expect(
      h.service.setRank({
        serverId: SERVER,
        teamId: '7',
        steamId: '76561190000000077',
        rank: 'officer',
      }),
    ).rejects.toMatchObject({ reason: 'not_a_member' });
  });

  it('o líder não recebe cargo: a liderança é do jogo', async () => {
    const h = harness();

    h.replies.set('origemz.team get', JSON.stringify({ ok: true, maxSize: 8, team: gameTeam() }));

    await expect(
      h.service.setRank({
        serverId: SERVER,
        teamId: '7',
        steamId: '76561190000000001',
        rank: 'officer',
      }),
    ).rejects.toMatchObject({ reason: 'is_leader' });
  });

  it('promover grava, e a equipe volta com o cargo', async () => {
    const h = harness();

    h.replies.set('origemz.team get', JSON.stringify({ ok: true, maxSize: 8, team: gameTeam() }));

    const team = await h.service.setRank({
      serverId: SERVER,
      teamId: '7',
      steamId: '76561190000000003',
      rank: 'officer',
      grantedBy: 'admin',
    });

    expect(team.officers).toBe(1);
    expect(h.ranks.of(SERVER, '7', '76561190000000003')?.grantedBy).toBe('admin');
  });

  it('rebaixar para membro APAGA a linha, em vez de gravar outra', async () => {
    const h = harness();

    h.replies.set('origemz.team get', JSON.stringify({ ok: true, maxSize: 8, team: gameTeam() }));
    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000003', rank: 'officer' });

    await h.service.setRank({
      serverId: SERVER,
      teamId: '7',
      steamId: '76561190000000003',
      rank: 'member',
    });

    expect(h.ranks.of(SERVER, '7', '76561190000000003')).toBeNull();
  });
});

describe('o aviso do console', () => {
  it('equipe desfeita apaga tudo daquela equipe', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });
    h.ranks.set({ serverId: SERVER, teamId: '8', steamId: '76561190000000004', rank: 'officer' });

    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ Team] ${TEAM_MARKER}{"kind":"disbanded","teamId":"7","secret":"${secret}"}`,
    );

    expect(h.ranks.ofTeam(SERVER, '7')).toHaveLength(0);
    // A outra equipe não foi tocada.
    expect(h.ranks.ofTeam(SERVER, '8')).toHaveLength(1);
  });

  it('quem sai da equipe perde o cargo', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });

    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ Team] ${TEAM_MARKER}{"kind":"left","teamId":"7","steamId":"76561190000000002","secret":"${secret}"}`,
    );

    expect(h.ranks.of(SERVER, '7', '76561190000000002')).toBeNull();
  });

  it('um aviso com segredo errado não mexe em nada', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });

    h.service.handleLine(
      SERVER,
      `[OrigemZ Team] ${TEAM_MARKER}{"kind":"disbanded","teamId":"7","secret":"chutei"}`,
    );

    expect(h.ranks.ofTeam(SERVER, '7')).toHaveLength(1);
  });

  it('o marcador no MEIO da linha não vale: é o chat', async () => {
    const h = harness();

    h.ranks.set({ serverId: SERVER, teamId: '7', steamId: '76561190000000002', rank: 'officer' });

    const secret = await grabSecret(h);

    // Como o chat chega no console: o nome de quem falou vem antes.
    h.service.handleLine(
      SERVER,
      `[CHAT] Mateuus: ${TEAM_MARKER}{"kind":"disbanded","teamId":"7","secret":"${secret}"}`,
    );

    expect(h.ranks.ofTeam(SERVER, '7')).toHaveLength(1);
  });

  it('uma linha que não é JSON não derruba o stream', async () => {
    const h = harness();

    expect(() => {
      h.service.handleLine(SERVER, `[OrigemZ Team] ${TEAM_MARKER}isto nao e json`);
    }).not.toThrow();
  });

  it('o `ready` do plugin não precisa de segredo — é ele que falta', async () => {
    const h = harness();

    expect(() => {
      h.service.handleLine(SERVER, `[OrigemZ Team] ${TEAM_MARKER}{"kind":"ready"}`);
    }).not.toThrow();
  });
});

/**
 * O segredo desta sessão.
 *
 * Ele nasce dentro do serviço e não tem getter — de propósito. O
 * teste o descobre do único jeito que o plugin também descobre:
 * lendo o comando de sync que saiu pelo RCON.
 */
async function grabSecret(h: Harness): Promise<string> {
  h.replies.set('origemz.team sync', JSON.stringify({ ok: true, teams: 1 }));

  await h.service.sync(SERVER);

  const line = h.sent.find((command) => command.startsWith('origemz.team sync'));
  const match = /"secret":"([^"]+)"/.exec(line ?? '');

  return match?.[1] ?? '';
}
