// ============================================================
//  bans.test.ts  -  as promessas da BanList que ninguém confere
//  olhando.
//
//  O que este arquivo guarda:
//
//    1. UM banimento ativo por SteamID — dois não teriam resposta
//       para "qual motivo vale?";
//    2. a reconciliação ADOTA o que já estava no servidor, e não
//       apaga nada de lá;
//    3. um ban vencido é revogado pelo relógio E vira `unban` no
//       jogo — sem isso o prazo seria enfeite;
//    4. um ban `network` vale num servidor cadastrado DEPOIS dele,
//       que é a razão inteira de o escopo não enumerar ninguém;
//    5. o SteamID atravessa a API sem perder dígito.
//
//  Banco em memória e um RCON de mentira que se comporta como o
//  servidor: guarda quem foi banido e responde ao `banlist`. É o
//  que permite testar a reconciliação inteira sem servidor de Rust
//  nenhum.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { parseBanList, sanitizeArgument } from '../src/bans/rust-bans.js';
import { BanList } from '../src/bans/service.js';
import { BansRepository } from '../src/db/bans-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { isApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';

/** Um SteamID64 de verdade: 17 dígitos, acima de 2^53. */
const STEAM_ID = '76561198000000000';
const OTHER_STEAM_ID = '76561198000000001';

/** O servidor de mentira: o que ele tem banido, e o que recebeu. */
interface FakeServer {
  /** O `bans.cfg` dele, em memória. */
  readonly bans: Map<string, { name: string; reason: string }>;
  /** Todo comando que chegou, na ordem. */
  readonly commands: string[];
  connected: boolean;
}

function makeServer(): FakeServer {
  return { bans: new Map(), commands: [], connected: true };
}

/**
 * Um RCON que se comporta como o servidor de Rust.
 *
 * Ele PRECISA responder ao `banlist` com o que recebeu: uma
 * reconciliação testada contra um RCON mudo passaria sem provar
 * nada — o que se quer saber é justamente se o agente enxerga o
 * que o servidor tem.
 */
function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      if (command === 'banlist') {
        return Promise.resolve(
          [...server.bans.entries()]
            .map(([steamId, entry]) => `${steamId} "${entry.name}" "${entry.reason}"`)
            .join('\n'),
        );
      }

      const ban = /^banid (\d+) "([^"]*)" "([^"]*)"$/.exec(command);

      if (ban !== null) {
        server.bans.set(ban[1] ?? '', { name: ban[2] ?? '', reason: ban[3] ?? '' });
        return Promise.resolve('');
      }

      const unban = /^unban (\d+)$/.exec(command);

      if (unban !== null) {
        server.bans.delete(unban[1] ?? '');
        return Promise.resolve('');
      }

      return Promise.resolve('');
    },
  };
}

interface Harness {
  readonly bans: BanList;
  readonly repository: BansRepository;
  readonly db: AgentDatabase;
  /** id do servidor -> o servidor de mentira. */
  readonly servers: Map<string, FakeServer>;
  /** Cadastra um servidor NOVO, depois do banco já em uso. */
  readonly addServer: (id: string) => FakeServer;
}

let harness: Harness;

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const serversRepository = new ServersRepository(db);
  const servers = new Map<string, FakeServer>();
  let nextPort = 28_015;

  const addServer = (id: string): FakeServer => {
    // A linha em `servers` não é decoração: `ban_servers` aponta
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

    const server = makeServer();

    servers.set(id, server);

    return server;
  };

  addServer('pvp1');
  addServer('pvp2');

  const repository = new BansRepository(db);

  harness = {
    repository,
    db,
    servers,
    addServer,
    bans: new BanList({
      repository,
      servers: {
        ids: () => [...servers.keys()].sort(),
        contextOf: (id) => {
          const server = servers.get(id);

          return server === undefined ? null : { rcon: fakeRcon(server) };
        },
      },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
  };
});

describe('um banimento ativo por SteamID', () => {
  it('o índice único recusa o segundo, e a mensagem diz qual é o primeiro', async () => {
    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    const segundo = harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'outro motivo',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    await expect(segundo).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'BAN_ALREADY_ACTIVE',
    );
  });

  it('mas aceita banir de novo depois de revogar, e o histórico fica', async () => {
    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'primeira vez',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    await harness.bans.revoke(STEAM_ID, 'admin');

    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'reincidiu',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    // Duas linhas para o mesmo jogador: a revogada e a ativa.
    // Revogar NÃO apaga — ver a migração 005.
    const todos = harness.bans.list();

    expect(todos).toHaveLength(2);
    expect(todos.filter((ban) => ban.active)).toHaveLength(1);
    expect(todos.find((ban) => ban.active)?.reason).toBe('reincidiu');
  });
});

describe('escopo network', () => {
  it('vale num servidor cadastrado DEPOIS do banimento', async () => {
    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    // O `pvp3` nasce agora — depois do ban. É este o caso que uma
    // lista enumerada perderia em silêncio.
    const pvp3 = harness.addServer('pvp3');

    expect(harness.bans.serverBans('pvp3').map((ban) => ban.steamId)).toEqual([STEAM_ID]);

    const resultado = await harness.bans.reconcile('pvp3');

    expect(resultado.applied).toEqual([STEAM_ID]);
    expect([...pvp3.bans.keys()]).toEqual([STEAM_ID]);
    // O lote termina com o writecfg: sem ele o bans.cfg só é
    // gravado quando o servidor decidir, e um crash perde tudo.
    expect(pvp3.commands).toContain('server.writecfg');
  });

  it('e não enumera servidor nenhum na tabela', async () => {
    const { ban } = await harness.bans.create({
      steamId: STEAM_ID,
      name: null,
      reason: 'uso de cheat',
      scope: 'network',
      servers: ['pvp1'],
      expiresAt: null,
      createdBy: 'admin',
    });

    // `servers` no corpo é ignorado num ban de rede: enumerar é
    // justamente o que ele existe para não fazer.
    expect(ban.servers).toEqual([]);
  });
});

describe('escopo servers', () => {
  it('vale só nos listados', async () => {
    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'briga no chat',
      scope: 'servers',
      servers: ['pvp1'],
      expiresAt: null,
      createdBy: 'admin',
    });

    expect(harness.bans.serverBans('pvp1').map((ban) => ban.steamId)).toEqual([STEAM_ID]);
    expect(harness.bans.serverBans('pvp2')).toEqual([]);
  });

  it('recusa um ban específico sem servidor nenhum', async () => {
    await expect(
      harness.bans.create({
        steamId: STEAM_ID,
        name: null,
        reason: 'motivo',
        scope: 'servers',
        servers: [],
        expiresAt: null,
        createdBy: 'admin',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'BAN_WITHOUT_SERVERS',
    );
  });
});

describe('reconciliação', () => {
  it('adota o que está no servidor e não na tabela, sem apagar nada', async () => {
    const pvp1 = harness.servers.get('pvp1');

    // O servidor já tinha um banido quando o agente chegou. Aquilo
    // foi decisão de alguém.
    pvp1?.bans.set(STEAM_ID, { name: 'Fulano', reason: 'decisão antiga' });

    const resultado = await harness.bans.reconcile('pvp1');

    expect(resultado.adopted).toEqual([STEAM_ID]);
    // O ban continua NO SERVIDOR: adotar não é mexer no bans.cfg.
    expect([...(pvp1?.bans.keys() ?? [])]).toEqual([STEAM_ID]);
    expect(pvp1?.commands).not.toContain(`unban ${STEAM_ID}`);

    const adotado = harness.repository.activeOf(STEAM_ID);

    expect(adotado?.origin).toBe('adopted');
    expect(adotado?.scope).toBe('servers');
    expect(adotado?.servers).toEqual(['pvp1']);
    // O motivo que estava no servidor sobrevive: ele é a única
    // pista do que aconteceu.
    expect(adotado?.reason).toBe('decisão antiga');
  });

  it('manda unban do que foi revogado na tabela e continua no servidor', async () => {
    const pvp1 = harness.servers.get('pvp1');

    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'servers',
      servers: ['pvp1'],
      expiresAt: null,
      createdBy: 'admin',
    });

    // O servidor cai ANTES da revogação: o unban não chega nele.
    if (pvp1 !== undefined) {
      pvp1.connected = false;
    }

    await harness.bans.revoke(STEAM_ID, 'admin');

    if (pvp1 !== undefined) {
      pvp1.connected = true;
    }

    expect(pvp1?.bans.has(STEAM_ID)).toBe(true);

    const resultado = await harness.bans.reconcile('pvp1');

    expect(resultado.removed).toEqual([STEAM_ID]);
    expect(pvp1?.bans.has(STEAM_ID)).toBe(false);
  });

  it('não age quando não consegue ler a lista do servidor', async () => {
    const pvp1 = harness.servers.get('pvp1');

    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    if (pvp1 !== undefined) {
      pvp1.connected = false;
      pvp1.commands.length = 0;
    }

    const resultado = await harness.bans.reconcile('pvp1');

    // Sem RCON a rodada é ADIADA, e a resposta diz isso. Supor
    // lista vazia aqui reaplicaria tudo a cada rodada.
    expect(resultado.skipped).not.toBeNull();
    expect(resultado.applied).toEqual([]);
    expect(pvp1?.commands).toEqual([]);
  });

  it('estende para cá o ban que já era ativo em outro servidor', async () => {
    const pvp2 = harness.servers.get('pvp2');

    await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'briga no chat',
      scope: 'servers',
      servers: ['pvp1'],
      expiresAt: null,
      createdBy: 'admin',
    });

    // Alguém baniu o mesmo jogador à mão no console do pvp2.
    pvp2?.bans.set(STEAM_ID, { name: 'Fulano', reason: 'à mão' });

    const resultado = await harness.bans.reconcile('pvp2');

    expect(resultado.extended).toEqual([STEAM_ID]);
    expect(resultado.adopted).toEqual([]);
    // Continua UM ban ativo, agora valendo nos dois.
    expect(harness.repository.activeOf(STEAM_ID)?.servers).toEqual(['pvp1', 'pvp2']);
    expect(pvp2?.bans.has(STEAM_ID)).toBe(true);
  });
});

describe('o prazo', () => {
  it('um ban vencido é revogado pelo relógio e vira unban', async () => {
    const pvp1 = harness.servers.get('pvp1');
    const agora = Date.now();

    const { ban } = await harness.bans.create({
      steamId: STEAM_ID,
      name: 'Fulano',
      reason: 'sete dias',
      scope: 'network',
      servers: [],
      expiresAt: agora + 60_000,
      createdBy: 'admin',
    });

    expect(pvp1?.bans.has(STEAM_ID)).toBe(true);

    // O relógio, um minuto e um segundo depois.
    const soltos = await harness.bans.sweepExpired(agora + 61_000);

    expect(soltos).toEqual([STEAM_ID]);
    expect(pvp1?.bans.has(STEAM_ID)).toBe(false);
    expect(pvp1?.commands).toContain(`unban ${STEAM_ID}`);

    const linha = harness.repository.get(ban.id);

    // Revogado pelo RELÓGIO: `revoked_at` preenchido e `revoked_by`
    // nulo. É a assinatura de "ninguém revogou, o prazo acabou".
    expect(linha?.revokedAt).not.toBeNull();
    expect(linha?.revokedBy).toBeNull();
  });

  it('recusa um banimento que já nasce vencido', async () => {
    await expect(
      harness.bans.create({
        steamId: STEAM_ID,
        name: null,
        reason: 'motivo',
        scope: 'network',
        servers: [],
        expiresAt: Date.now() - 1_000,
        createdBy: 'admin',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'BAN_ALREADY_EXPIRED',
    );
  });

  it('um ban vencido não conta como ativo naquele servidor', () => {
    const agora = Date.now();

    harness.repository.create(
      {
        steamId: OTHER_STEAM_ID,
        name: null,
        reason: 'vencido',
        scope: 'network',
        servers: [],
        expiresAt: agora - 1_000,
        createdBy: null,
        origin: 'panel',
      },
      agora - 10_000,
    );

    expect(harness.repository.activeFor('pvp1', agora)).toEqual([]);
    // Mas ele continua na lista global, marcado como vencido — a
    // tela precisa poder dizer "vencido, saindo" em vez de sumir
    // com a linha enquanto o bans.cfg ainda a segura.
    expect(harness.bans.list().find((ban) => ban.steamId === OTHER_STEAM_ID)?.expired).toBe(true);
  });
});

describe('o SteamID atravessa a API sem perder dígito', () => {
  /**
   * Um SteamID com dígitos até o fim.
   *
   * O `76561198000000000` dos outros testes sobrevive a um
   * `Number()` por acidente — ele termina em zeros. Este não: em
   * ponto flutuante ele vira `…790`, e o banimento iria para outra
   * conta. É com ele que a garantia se prova.
   */
  const PRECISO = '76561198123456789';

  it('ida e volta pelo JSON, com 17 dígitos', async () => {
    const { ban } = await harness.bans.create({
      steamId: PRECISO,
      name: 'Fulano',
      reason: 'uso de cheat',
      scope: 'network',
      servers: [],
      expiresAt: null,
      createdBy: 'admin',
    });

    // É exatamente o que o Fastify faz com o corpo da resposta.
    const doJson = JSON.parse(JSON.stringify(ban)) as { steamId: unknown };

    expect(doJson.steamId).toBe(PRECISO);
    expect(typeof doJson.steamId).toBe('string');

    // E o comando que saiu para o jogo carrega o id inteiro: é o
    // último ponto onde ele poderia se perder.
    expect(harness.servers.get('pvp1')?.commands).toContain(
      `banid ${PRECISO} "Fulano" "uso de cheat"`,
    );

    // A prova de por que ele é string em toda parte: como número, o
    // mesmo id volta arredondado.
    expect(String(Number(PRECISO))).not.toBe(PRECISO);
  });

  it('recusa o que não é SteamID64', async () => {
    await expect(
      harness.bans.create({
        steamId: '12345',
        name: null,
        reason: 'motivo',
        scope: 'network',
        servers: [],
        expiresAt: null,
        createdBy: 'admin',
      }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'INVALID_STEAM_ID');
  });
});

describe('a leitura do banlist', () => {
  it('entende o formato de texto do console', () => {
    const lista = parseBanList(`${STEAM_ID} "Fulano" "uso de cheat"`);

    expect(lista).toEqual([{ steamId: STEAM_ID, name: 'Fulano', reason: 'uso de cheat' }]);
  });

  it('entende o formato JSON', () => {
    const lista = parseBanList(
      `[{"steamid":"${STEAM_ID}","username":"Fulano","notes":"uso de cheat"}]`,
    );

    expect(lista).toEqual([{ steamId: STEAM_ID, name: 'Fulano', reason: 'uso de cheat' }]);
  });

  it('lista vazia e resposta ilegível são coisas diferentes', () => {
    // Vazio = o servidor não tem ninguém banido.
    expect(parseBanList('')).toEqual([]);
    // Texto sem SteamID nenhum = não entendi. `null`, e não `[]`:
    // é o que impede a reconciliação de agir sobre um palpite.
    expect(parseBanList('Comando desconhecido: banlist')).toBeNull();
  });
});

describe('as aspas no comando', () => {
  it('somem do nome e do motivo', () => {
    // Uma aspa no meio fecharia o argumento cedo, e o resto da
    // frase viraria o argumento seguinte.
    expect(sanitizeArgument('Ful"ano', 'desconhecido')).toBe('Ful ano');
    expect(sanitizeArgument('linha\nquebrada', 'x')).toBe('linha quebrada');
    expect(sanitizeArgument('   ', 'desconhecido')).toBe('desconhecido');
  });
});
