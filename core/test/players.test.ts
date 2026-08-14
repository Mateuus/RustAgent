// ============================================================
//  players.test.ts  -  as promessas da base de jogadores que
//  ninguém confere olhando.
//
//  O que este arquivo guarda:
//
//    1. o mesmo SteamID em dois servidores é UMA pessoa e DUAS
//       linhas de servidor;
//    2. `first_seen` da REDE não muda quando ele entra num
//       servidor novo — e o daquele servidor é o de hoje;
//    3. a sessão que ficou aberta é fechada na reconciliação do
//       boot, com o tempo somado UMA vez só;
//    4. o SteamID atravessa a API sem perder dígito;
//    5. a ficha de um banido traz o ban da tabela `bans`, e não
//       uma cópia.
//
//  Banco em memória e um "servidor" que é uma lista de jogadores
//  em memória: é o que permite testar a presença inteira — a
//  entrada, a saída, o reinício do agente — sem servidor de Rust
//  nenhum.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { BanList } from '../src/bans/service.js';
import { BansRepository } from '../src/db/bans-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { PlayersRepository } from '../src/db/players-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { apiErrorToResponse, isApiError } from '../src/http/error-response.js';
import { registerPlayerRoutes } from '../src/http/routes/players.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import { PresenceTracker, type PresencePlayer } from '../src/players/presence.js';
import { PlayerDirectory } from '../src/players/service.js';

/**
 * Um SteamID64 de verdade, com dígitos ATÉ O FIM.
 *
 * O `76561198000000000` sobrevive a um `Number()` por acidente,
 * porque termina em zeros — ele não prova nada. Este perde os
 * últimos dígitos na ida e volta por um número, que é exatamente o
 * defeito que os testes daqui existem para pegar.
 */
const STEAM_ID = '76561198123456789';
const OTHER_STEAM_ID = '76561198987654321';

/** O que o "servidor" responde quando perguntam quem está online. */
interface FakeServer {
  players: PresencePlayer[];
  connected: boolean;
  /** A leitura falha — o RCON respondeu qualquer coisa. */
  broken: boolean;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: PlayersRepository;
  readonly bans: BanList;
  readonly directory: PlayerDirectory;
  readonly servers: Map<string, FakeServer>;
  /** Um tracker NOVO: é o que "o agente reiniciou" quer dizer. */
  readonly newTracker: () => PresenceTracker;
}

let harness: Harness;

function player(
  steamId: string,
  name: string,
  connectedSeconds: number | null,
  ip: string | null = null,
): PresencePlayer {
  return { steamId, name, connectedSeconds, ip };
}

const silent = createLogger({ log: { level: 'silent', pretty: false } });

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const serversRepository = new ServersRepository(db);
  const servers = new Map<string, FakeServer>();
  let nextPort = 28_015;

  const addServer = (id: string): void => {
    // A linha em `servers` não é decoração: `player_servers` aponta
    // para lá, e o pragma de chave estrangeira está ligado.
    serversRepository.create({
      id,
      name: id,
      identity: id,
      gamePort: nextPort,
      rconPort: nextPort + 1,
      queryPort: nextPort + 2,
      appPort: nextPort + 3,
      installDir: `F:\\Servers\\${id}`,
    });

    nextPort += 100;
    servers.set(id, { players: [], connected: true, broken: false });
  };

  addServer('pvp1');
  addServer('pve');

  const repository = new PlayersRepository(db);

  const bans = new BanList({
    repository: new BansRepository(db),
    servers: {
      ids: () => [...servers.keys()].sort(),
      // Sem RCON de propósito: o que se testa aqui é a LINHA na
      // tabela, e não o `banid` chegando ao jogo — disso cuida
      // bans.test.ts.
      contextOf: () => ({ rcon: offlineRcon() }),
    },
    logger: silent,
  });

  harness = {
    db,
    repository,
    bans,
    servers,
    directory: new PlayerDirectory({ repository, bans }),
    newTracker: () =>
      new PresenceTracker({
        repository,
        reader: {
          list: (serverId) => {
            const server = servers.get(serverId);

            if (server === undefined || server.broken) {
              return Promise.reject(new Error('o servidor não respondeu à lista de jogadores.'));
            }

            return Promise.resolve({ players: server.players });
          },
        },
        servers: {
          ids: () => [...servers.keys()].sort(),
          contextOf: (id) => {
            const server = servers.get(id);

            return server === undefined ? null : { rcon: connectedRcon(server) };
          },
          configOf: () => ({ worldSize: 4000 }),
        },
        logger: silent,
      }),
  };
});

/** O RCON de um servidor que a presença só usa para saber se está de pé. */
function connectedRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: () => Promise.resolve(''),
  };
}

function offlineRcon(): OpsRcon {
  return { isConnected: false, send: () => Promise.resolve('') };
}

/**
 * Um Fastify com as rotas de jogador e o tradutor de erro.
 *
 * Em produção quem registra o `setErrorHandler` é o `buildServer`.
 * Aqui ele é repetido porque o que se testa é justamente o CÓDIGO
 * do erro (`INVALID_STEAM_ID`, `PLAYER_NOT_FOUND`) — sem o
 * handler, o Fastify responderia o genérico dele e o teste passaria
 * a conferir a mensagem do framework.
 */
function makeApp(): FastifyInstance {
  const app = Fastify();

  app.setErrorHandler(async (error, _request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    throw error;
  });

  registerPlayerRoutes(app, { directory: harness.directory });

  return app;
}

/** Quantas linhas há na tabela, para conferir a separação. */
function count(table: 'players' | 'player_servers'): number {
  return (harness.db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number })
    .total;
}

// ============================================================
//  1 e 2 — a pessoa é da rede, a atividade é do servidor
// ============================================================

describe('a mesma pessoa em dois servidores', () => {
  it('tem uma linha em players e duas em player_servers', async () => {
    const tracker = harness.newTracker();
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 60)];
    await tracker.sync('pvp1', t0);

    harness.servers.get('pve')!.players = [player(STEAM_ID, 'Fulano', 30)];
    await tracker.sync('pve', t0 + 1000);

    expect(count('players')).toBe(1);
    expect(count('player_servers')).toBe(2);

    const profile = harness.directory.get(STEAM_ID);

    expect(profile?.servers.map((server) => server.serverId).sort()).toEqual(['pve', 'pvp1']);
  });

  it('o "jogador desde" da rede não muda quando ele entra num servidor novo', async () => {
    const tracker = harness.newTracker();
    const maio = Date.UTC(2026, 4, 10, 20, 0, 0);
    const hoje = Date.UTC(2026, 7, 14, 20, 0, 0);

    // Ele joga no pvp1 desde maio…
    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 120)];
    await tracker.sync('pvp1', maio);

    // …e entrou no pve hoje.
    harness.servers.get('pve')!.players = [player(STEAM_ID, 'Fulano', 120)];
    await tracker.sync('pve', hoje);

    const profile = harness.directory.get(STEAM_ID);
    const pvp1 = profile?.servers.find((server) => server.serverId === 'pvp1');
    const pve = profile?.servers.find((server) => server.serverId === 'pve');

    // Jogador desde MAIO na rede — e desde HOJE no pve. As duas
    // respostas são diferentes, e é para isso que há duas tabelas.
    //
    // As horas são as do COMEÇO DA CONEXÃO (dois minutos antes de
    // cada varredura, pelo `connectedSeconds`), e não as da
    // varredura que o descobriu: quem sabe quando o jogador entrou
    // é o servidor.
    expect(profile?.player.firstSeen).toBe(new Date(maio - 120_000).toISOString());
    expect(pvp1?.firstSeen).toBe(new Date(maio - 120_000).toISOString());
    expect(pve?.firstSeen).toBe(new Date(hoje - 120_000).toISOString());
  });

  it('sair de um servidor não marca a pessoa como offline no outro', async () => {
    const tracker = harness.newTracker();
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 60)];
    harness.servers.get('pve')!.players = [player(STEAM_ID, 'Fulano', 60)];

    await tracker.sync('pvp1', t0);
    await tracker.sync('pve', t0);

    // Saiu do pve, continua no pvp1.
    harness.servers.get('pve')!.players = [];
    await tracker.sync('pve', t0 + 30_000);

    const profile = harness.directory.get(STEAM_ID);

    expect(profile?.player.online).toBe(true);
    expect(profile?.servers.find((server) => server.serverId === 'pvp1')?.online).toBe(true);
    expect(profile?.servers.find((server) => server.serverId === 'pve')?.online).toBe(false);
  });
});

// ============================================================
//  3 — o agente reiniciado
// ============================================================

describe('a reconciliação do boot', () => {
  it('fecha a sessão que ficou aberta e soma o tempo uma vez só', async () => {
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    // O agente estava no ar e viu o jogador com 10 minutos de
    // conexão. A sessão dele começou, portanto, às 11h50.
    const antes = harness.newTracker();

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 600)];
    await antes.sync('pvp1', t0);

    // O agente cai (tracker novo = memória zerada) e volta uma hora
    // depois. O jogador não está mais no servidor.
    harness.servers.get('pvp1')!.players = [];

    const depois = harness.newTracker();
    const resultado = await depois.sync('pvp1', t0 + 3_600_000);

    expect(resultado.left).toEqual([STEAM_ID]);

    const primeiro = harness.repository.serversOf(STEAM_ID)[0];

    // 600 s: do começo da conexão até a ÚLTIMA VEZ EM QUE ELE FOI
    // VISTO. A hora em que o agente voltou não entra na conta — ele
    // não estava olhando.
    expect(primeiro?.playedSeconds).toBe(600);
    expect(primeiro?.leftAt).toBe(t0);
    expect(primeiro?.leaveReason).toBe('agente reiniciado');

    // Rodar de novo NÃO dobra o número, e não inventa uma segunda
    // saída na linha do tempo.
    await depois.sync('pvp1', t0 + 3_700_000);
    await harness.newTracker().sync('pvp1', t0 + 3_800_000);

    expect(harness.repository.serversOf(STEAM_ID)[0]?.playedSeconds).toBe(600);
    expect(
      harness.directory.timeline(STEAM_ID).events.filter((event) => event.kind === 'leave'),
    ).toHaveLength(1);
  });

  it('quem continua online depois do reinício mantém a sessão e o contador de entradas', async () => {
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 600)];
    await harness.newTracker().sync('pvp1', t0);

    // Uma hora depois o agente volta e ele CONTINUA lá — com uma
    // hora a mais de conexão, ou seja, a mesma sessão.
    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 4200)];
    await harness.newTracker().sync('pvp1', t0 + 3_600_000);

    const linha = harness.repository.serversOf(STEAM_ID)[0];

    expect(linha?.sessions).toBe(1);
    expect(linha?.leftAt).toBeNull();
    expect(linha?.playedSeconds).toBe(0);
  });

  it('reconhece quem reconectou enquanto o agente estava fora', async () => {
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 600)];
    await harness.newTracker().sync('pvp1', t0);

    // Uma hora depois ele está lá com 60 s de conexão: entrou de
    // novo. A sessão antiga fecha, a nova abre, e a contagem de
    // entradas sobe.
    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 60)];
    await harness.newTracker().sync('pvp1', t0 + 3_600_000);

    const linha = harness.repository.serversOf(STEAM_ID)[0];

    expect(linha?.sessions).toBe(2);
    expect(linha?.playedSeconds).toBe(600);
    expect(linha?.leftAt).toBeNull();
  });

  it('não fecha ninguém quando não conseguiu ler a lista', async () => {
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);
    const tracker = harness.newTracker();

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 600)];
    await tracker.sync('pvp1', t0);

    // O RCON responde, mas a resposta não dá para entender. Supor
    // lista vazia aqui fecharia a sessão de todo mundo.
    harness.servers.get('pvp1')!.broken = true;

    const resultado = await tracker.sync('pvp1', t0 + 60_000);

    expect(resultado.skipped).not.toBeNull();
    expect(resultado.left).toEqual([]);
    expect(harness.repository.serversOf(STEAM_ID)[0]?.leftAt).toBeNull();
  });
});

// ============================================================
//  4 — o SteamID atravessa a API inteira
// ============================================================

describe('o SteamID na API', () => {
  it('volta com os 17 dígitos, na listagem e na ficha', async () => {
    const app = makeApp();

    const tracker = harness.newTracker();

    harness.servers.get('pvp1')!.players = [
      player(STEAM_ID, 'Fulano', 60, '203.0.113.10'),
      player(OTHER_STEAM_ID, 'Ciclano', 60),
    ];

    await tracker.sync('pvp1', Date.UTC(2026, 7, 1, 12, 0, 0));

    const lista = await app.inject({ method: 'GET', url: '/players' });
    const listaBody = lista.json<{
      total: number;
      players: { steamId: string; online: boolean }[];
    }>();

    expect(lista.statusCode).toBe(200);
    expect(listaBody.total).toBe(2);
    expect(listaBody.players.map((item) => item.steamId).sort()).toEqual(
      [STEAM_ID, OTHER_STEAM_ID].sort(),
    );

    const ficha = await app.inject({ method: 'GET', url: `/players/${STEAM_ID}` });
    const fichaBody = ficha.json<{ player: { steamId: string; online: boolean } }>();

    // O texto CRU da resposta, e não só o objeto: é na serialização
    // que um número perderia os dígitos finais.
    expect(ficha.payload).toContain(`"steamId":"${STEAM_ID}"`);
    expect(fichaBody.player.steamId).toBe(STEAM_ID);
    expect(fichaBody.player.online).toBe(true);

    await app.close();
  });

  it('a listagem é paginada, e o total ignora a página', async () => {
    const app = makeApp();

    const tracker = harness.newTracker();

    harness.servers.get('pvp1')!.players = [
      player(STEAM_ID, 'Fulano', 60),
      player(OTHER_STEAM_ID, 'Ciclano', 60),
    ];

    await tracker.sync('pvp1', Date.UTC(2026, 7, 1, 12, 0, 0));

    const pagina = await app.inject({ method: 'GET', url: '/players?limit=1&offset=1' });
    const body = pagina.json<{ count: number; total: number; limit: number; offset: number }>();

    expect(body.count).toBe(1);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);

    await app.close();
  });

  it('recusa o que não é SteamID64 antes de ir ao banco', async () => {
    const app = makeApp();

    const resposta = await app.inject({ method: 'GET', url: '/players/12345' });

    expect(resposta.statusCode).toBe(400);
    expect(resposta.json<{ error: string }>().error).toBe('INVALID_STEAM_ID');

    await app.close();
  });

  it('quem o agente nunca viu é 404, e não uma ficha vazia', async () => {
    const app = makeApp();

    const resposta = await app.inject({ method: 'GET', url: `/players/${STEAM_ID}` });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.json<{ error: string }>().error).toBe('PLAYER_NOT_FOUND');

    await app.close();
  });
});

// ============================================================
//  5 — o ban vem da BanList, e não de uma cópia
// ============================================================

describe('a ficha de um jogador banido', () => {
  it('traz o ban da tabela `bans`, e ele some quando é revogado ali', async () => {
    const tracker = harness.newTracker();

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 60)];
    await tracker.sync('pvp1', Date.UTC(2026, 7, 1, 12, 0, 0));

    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'mateus',
    });

    const banido = harness.directory.get(STEAM_ID);

    expect(banido?.ban?.reason).toBe('uso de cheat');
    expect(banido?.ban?.createdBy).toBe('mateus');
    expect(harness.directory.list({}).players[0]?.banned).toBe(true);

    // A revogação acontece na BanList, e SÓ nela. A ficha vira "sem
    // ban" sem que nada aqui tenha sido atualizado — é isso que uma
    // coluna `banned` copiada não faria.
    await harness.bans.revoke(STEAM_ID, 'mateus');

    expect(harness.directory.get(STEAM_ID)?.ban).toBeNull();
    expect(harness.directory.list({}).players[0]?.banned).toBe(false);
  });

  it('quem só existe na lista de banidos tem ficha, com as datas nulas', async () => {
    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'mateus',
    });

    const ficha = harness.directory.get(STEAM_ID);

    expect(ficha?.player.known).toBe(false);
    expect(ficha?.player.firstSeen).toBeNull();
    expect(ficha?.player.name).toBe('Fulano');
    expect(ficha?.servers).toEqual([]);
  });

  it('o banimento e a revogação aparecem na linha do tempo, vindos da tabela `bans`', async () => {
    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'mateus',
    });

    await harness.bans.revoke(STEAM_ID, 'outro');

    const timeline = harness.directory.timeline(STEAM_ID);

    expect(timeline.events.map((event) => event.kind)).toEqual(['unban', 'ban']);
    // E o exemplo vem rotulado, num campo à parte: mock misturado
    // com dado é a única coisa pior que não ter o dado.
    expect(timeline.sample.measured).toBe(false);
    expect(timeline.sample.events.every((event) => event.kind !== 'ban')).toBe(true);
  });
});

// ============================================================
//  O que a varredura grava, e o que ela não inventa
// ============================================================

describe('a varredura', () => {
  it('guarda o IP quando a fonte traz, e não o apaga quando ela não traz', async () => {
    const tracker = harness.newTracker();
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    // O `playerlist` nativo traz o endereço…
    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 60, '203.0.113.10')];
    await tracker.sync('pvp1', t0);

    expect(harness.repository.get(STEAM_ID)?.lastIp).toBe('203.0.113.10');

    // …e o `origemz.players` não. A leitura pelo plugin não pode
    // apagar o que a outra fonte já sabia.
    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 120, null)];
    await tracker.sync('pvp1', t0 + 60_000);

    expect(harness.repository.get(STEAM_ID)?.lastIp).toBe('203.0.113.10');
  });

  it('ignora quem não tem SteamID64 — o bot não é jogador', async () => {
    const tracker = harness.newTracker();

    harness.servers.get('pvp1')!.players = [
      player(STEAM_ID, 'Fulano', 60),
      player('123', 'scientist', 60),
    ];

    await tracker.sync('pvp1', Date.UTC(2026, 7, 1, 12, 0, 0));

    expect(count('players')).toBe(1);
    expect(harness.repository.get('123')).toBeNull();
  });

  it('a entrada e a saída entram na linha do tempo', async () => {
    const tracker = harness.newTracker();
    const t0 = Date.UTC(2026, 7, 1, 12, 0, 0);

    harness.servers.get('pvp1')!.players = [player(STEAM_ID, 'Fulano', 60)];
    await tracker.sync('pvp1', t0);

    harness.servers.get('pvp1')!.players = [];
    await tracker.sync('pvp1', t0 + 30_000);

    const timeline = harness.directory.timeline(STEAM_ID);

    expect(timeline.events.map((event) => event.kind)).toEqual(['leave', 'join']);
    // Saída vista entre duas rodadas seguidas: o jogo não diz o
    // motivo, e o agente não inventa um.
    expect(timeline.events[0]?.detail).toBeNull();
  });
});
