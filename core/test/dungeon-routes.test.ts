// ============================================================
//  As rotas da masmorra e das plantas.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  As três regras que só a rota enxerga, e que sozinhas custam um
//  wipe cada:
//
//    BLUEPRINT_NO_HATCH   a planta sem alçapão SOBE BONITA e falha
//                         60 s depois, no jogo, com a casinha de pé
//    BLUEPRINT_IN_USE     apagar a planta que é a entrada de uma
//                         masmorra
//    BLUEPRINT_MISSING    apontar para uma planta que não existe
//
//  E o olho do assistente (`/runs?since=`), que é o que faz o passo
//  ⑥ do editor terminar sozinho em vez de mandar o admin adivinhar
//  se deu certo.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonLayoutsRepository } from '../src/db/dungeon-layouts-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerDungeonRoutes, type DungeonRoutesDeps } from '../src/http/routes/dungeons.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

/** Uma planta mínima COM a marca do vaso. Ver §5.3.7 do plano. */
const WITH_HATCH = JSON.stringify({
  entities: [
    {
      prefabname: 'assets/prefabs/deployable/planters/planter.large.deployed.prefab',
      pos: { x: '0', y: '0', z: '0' },
      rot: { x: '0', y: '0', z: '0' },
      items: [
        { id: -930193596, position: 0, amount: 1 },
        { id: -930193596, position: 5, amount: 999 },
      ],
    },
  ],
});

/** A mesma planta, com um vaso comum: nenhuma marca. */
const WITHOUT_HATCH = JSON.stringify({
  entities: [
    {
      prefabname: 'assets/prefabs/deployable/planters/planter.large.deployed.prefab',
      pos: { x: '0', y: '0', z: '0' },
      rot: { x: '0', y: '0', z: '0' },
      items: [{ id: -930193596, position: 0, amount: 3 }],
    },
  ],
});

interface Harness {
  readonly app: FastifyInstance;
  readonly db: AgentDatabase;
  readonly events: WorldEventsRepository;
}

let harness: Harness | null = null;

/**
 * O que a rota de erguer chama.
 *
 * O teste injeta um dublê: o que se prova aqui e a TRADUCAO entre
 * a tentativa e a resposta HTTP - qual recusa vira 409, qual vira
 * 422, e o que o painel le. O RCON de verdade e do `sync`.
 */
type BuildStub = DungeonRoutesDeps['build'];
type GroundStub = DungeonRoutesDeps['groundAt'];

async function buildHarness(
  extra: { readonly build?: BuildStub; readonly groundAt?: GroundStub } = {},
): Promise<Harness> {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // A linha em `servers` não é decoração: `world_event_runs` aponta
  // para lá e o pragma de chave estrangeira está ligado.
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

  const dungeons = new DungeonsRepository(db, silent);
  const blueprints = new DungeonBlueprintsRepository(db, silent);
  const layouts = new DungeonLayoutsRepository(db, silent);
  const events = new WorldEventsRepository(db, silent);

  const app = Fastify({ logger: false });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    if (isApiError(error)) {
      const response = apiErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR', message: String(error) });
  });

  await app.register(async (api) => {
    registerDungeonRoutes(api, { dungeons, blueprints, layouts, events, ...extra });
  });

  await app.ready();

  harness = { app, db, events };
  return harness;
}

afterEach(async () => {
  if (harness !== null) {
    await harness.app.close();
    harness.db.close();
    harness = null;
  }
});

async function uploadBlueprint(
  app: FastifyInstance,
  id: string,
  content = WITH_HATCH,
  kind = 'entrance',
) {
  return app.inject({
    method: 'POST',
    url: '/dungeon-blueprints',
    payload: { id, name: id, kind, content },
  });
}

async function createDungeon(app: FastifyInstance, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/dungeons',
    payload: { id: 'bunker', name: 'Bunker', ...body },
  });
}

describe('as plantas', () => {
  it('sobe uma planta com marca de alçapão', async () => {
    const { app } = await buildHarness();

    const response = await uploadBlueprint(app, 'entrada-teste');

    expect(response.statusCode).toBe(201);

    const body = response.json() as { blueprint: { hasHatch: boolean; entityCount: number } };

    expect(body.blueprint.hasHatch).toBe(true);
    expect(body.blueprint.entityCount).toBe(1);
  });

  it('RECUSA uma entrada sem alçapão, e diz onde está a marca', async () => {
    // É o teste que impede o pior desfecho do sistema: a casinha
    // sobe, o admin comemora, e ninguém consegue descer.
    const { app } = await buildHarness();

    const response = await uploadBlueprint(app, 'entrada-quebrada', WITHOUT_HATCH);

    expect(response.statusCode).toBe(422);

    const body = response.json() as { error: string; message: string };

    expect(body.error).toBe('BLUEPRINT_NO_HATCH');
    // A frase tem de ENSINAR, não só recusar.
    expect(body.message).toContain('0707');
    expect(body.message).toContain('fertilizante');
  });

  it('aceita uma BASE sem alçapão: só a entrada precisa dele', async () => {
    const { app } = await buildHarness();

    const response = await uploadBlueprint(app, 'base-teste', WITHOUT_HATCH, 'base');

    expect(response.statusCode).toBe(201);
  });

  it('recusa um arquivo que não é planta, dizendo o quê', async () => {
    const { app } = await buildHarness();

    const response = await uploadBlueprint(app, 'lixo', '{"default":{}}');

    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: string }).error).toBe('BLUEPRINT_INVALID');
  });

  it('a lista não devolve o conteúdo', async () => {
    // 1,1 MB de plantas numa listagem de sete nomes.
    const { app } = await buildHarness();

    await uploadBlueprint(app, 'entrada-teste');

    const body = (await app.inject({ method: 'GET', url: '/dungeon-blueprints' })).json() as {
      blueprints: Record<string, unknown>[];
    };

    expect(body.blueprints).toHaveLength(1);
    expect(body.blueprints[0]).not.toHaveProperty('content');
    expect(body.blueprints[0]).toHaveProperty('entityCount');
  });

  it('a leitura de UMA devolve o conteúdo', async () => {
    const { app } = await buildHarness();

    await uploadBlueprint(app, 'entrada-teste');

    const body = (
      await app.inject({ method: 'GET', url: '/dungeon-blueprints/entrada-teste' })
    ).json() as { blueprint: { content: string } };

    expect(body.blueprint.content).toBe(WITH_HATCH);
  });
});

describe('as masmorras', () => {
  it('cria e lê de volta', async () => {
    const { app } = await buildHarness();

    expect((await createDungeon(app)).statusCode).toBe(201);

    const body = (await app.inject({ method: 'GET', url: '/dungeons/bunker' })).json() as {
      dungeon: { name: string; mode: string; rooms: unknown[] };
    };

    expect(body.dungeon.name).toBe('Bunker');
    expect(body.dungeon.mode).toBe('recipe');
  });

  it('a masmorra nasce aberta ao servidor inteiro e protegida', async () => {
    // ####  É O PEDIDO DO DONO, E ELE É O PADRÃO  ####
    //
    // "A Dungeon todo o servidor pode entrar nela, não só um player
    // que faz claimer" — e "impedir que jogadores com martelo
    // remover objetos da entrada". Quem cria uma masmorra sem tocar
    // em nada tem de receber exatamente isso.
    const { app } = await buildHarness();

    await createDungeon(app);

    const body = (await app.inject({ method: 'GET', url: '/dungeons/bunker' })).json() as {
      dungeon: {
        access: { whoEnters: string; enterPermission: string };
        protection: { enabled: boolean; allowAdmin: boolean; warnOnAttempt: boolean };
      };
    };

    expect(body.dungeon.access).toEqual({ whoEnters: 'everyone', enterPermission: '' });
    expect(body.dungeon.protection).toEqual({
      enabled: true,
      allowAdmin: true,
      warnOnAttempt: true,
    });
  });

  it('guarda quem entra e a proteção, e devolve os dois na edição', async () => {
    const { app } = await buildHarness();

    await createDungeon(app, {
      access: { whoEnters: 'permission', enterPermission: 'origemz.vip.diamante' },
      protection: { enabled: true, allowAdmin: false, warnOnAttempt: false },
    });

    const body = (await app.inject({ method: 'GET', url: '/dungeons/bunker' })).json() as {
      dungeon: {
        access: { whoEnters: string; enterPermission: string };
        protection: { allowAdmin: boolean; warnOnAttempt: boolean };
      };
    };

    // O nome da permissão é o campo que o painel precisa VER de
    // volta: sem ele, reabrir a masmorra mostraria o campo vazio e
    // salvar de novo apagaria a escolha sem avisar.
    expect(body.dungeon.access.whoEnters).toBe('permission');
    expect(body.dungeon.access.enterPermission).toBe('origemz.vip.diamante');
    expect(body.dungeon.protection.allowAdmin).toBe(false);
    expect(body.dungeon.protection.warnOnAttempt).toBe(false);
  });

  it('recusa duas com o mesmo identificador', async () => {
    const { app } = await buildHarness();

    await createDungeon(app);

    const response = await createDungeon(app);

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('DUNGEON_EXISTS');
  });

  it('recusa apontar para uma planta que não existe', async () => {
    // Sem isto a masmorra nasceria com a entrada mínima de código —
    // que funciona, e não é o que o admin pediu. Ele passaria um
    // wipe achando que escolheu outra coisa.
    const { app } = await buildHarness();

    const response = await createDungeon(app, { entranceBlueprint: 'nao-existe' });

    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: string }).error).toBe('BLUEPRINT_MISSING');
  });

  it('recusa apagar a planta que uma masmorra usa como entrada', async () => {
    const { app } = await buildHarness();

    await uploadBlueprint(app, 'entrada-teste');
    await createDungeon(app, { entranceBlueprint: 'entrada-teste' });

    const response = await app.inject({
      method: 'DELETE',
      url: '/dungeon-blueprints/entrada-teste',
    });

    expect(response.statusCode).toBe(409);

    const body = response.json() as { error: string; message: string };

    expect(body.error).toBe('BLUEPRINT_IN_USE');
    // A frase diz QUEM usa, senão o admin fica caçando.
    expect(body.message).toContain('bunker');
  });

  it('exige o grid no modo planta', async () => {
    const { app } = await buildHarness();

    const response = await createDungeon(app, { mode: 'blueprint' });

    expect(response.statusCode).toBe(400);
  });

  it('guarda o grid, e ele volta como veio', async () => {
    const { app } = await buildHarness();

    const grid = ['..AAA', 'E####', '..BB.'];

    expect((await createDungeon(app, { mode: 'blueprint', grid })).statusCode).toBe(201);

    const body = (await app.inject({ method: 'GET', url: '/dungeons/bunker' })).json() as {
      dungeon: { grid: string[] };
    };

    expect(body.dungeon.grid).toEqual(grid);
  });

  it('recusa uma receita com todas as cores em zero', async () => {
    // Não é "sem salas": é divisão por zero no sorteio, e a
    // masmorra nasce só com corredor.
    const { app } = await buildHarness();

    const response = await createDungeon(app, { weights: { green: 0, blue: 0, red: 0 } });

    expect(response.statusCode).toBe(400);
  });

  it('guarda as salas, e reescreve o conjunto inteiro ao editar', async () => {
    const { app } = await buildHarness();

    await createDungeon(app, {
      rooms: [
        { key: 'green', color: 'green' },
        { key: 'red', color: 'red', door: 'toptier', locked: true },
      ],
    });

    let body = (await app.inject({ method: 'GET', url: '/dungeons/bunker' })).json() as {
      dungeon: { rooms: { key: string; locked: boolean }[] };
    };

    expect(body.dungeon.rooms).toHaveLength(2);
    expect(body.dungeon.rooms.find((room) => room.key === 'red')?.locked).toBe(true);

    // A sala que sumiu do payload tem de sumir do banco: um merge
    // parcial deixaria a vermelha lá para sempre.
    await app.inject({
      method: 'PUT',
      url: '/dungeons/bunker',
      payload: { name: 'Bunker', rooms: [{ key: 'green', color: 'green' }] },
    });

    body = (await app.inject({ method: 'GET', url: '/dungeons/bunker' })).json() as {
      dungeon: { rooms: { key: string; locked: boolean }[] };
    };

    expect(body.dungeon.rooms).toHaveLength(1);
    expect(body.dungeon.rooms[0]?.key).toBe('green');
  });

  it('duplica uma receita de fábrica', async () => {
    // É o botão "começar de um pronto": o admin não encara trinta
    // campos em branco.
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/dungeons/dificil/duplicate',
      payload: { id: 'minha-dificil', name: 'Minha Difícil' },
    });

    expect(response.statusCode).toBe(201);

    const body = (await app.inject({ method: 'GET', url: '/dungeons/minha-dificil' })).json() as {
      dungeon: { size: { min: number; max: number }; rooms: unknown[] };
    };

    expect(body.dungeon.size).toEqual({ min: 15, max: 20 });
    expect(body.dungeon.rooms).toHaveLength(3);
  });

  it('as quatro receitas de fábrica saem prontas', async () => {
    const { app } = await buildHarness();

    const body = (await app.inject({ method: 'GET', url: '/dungeons/factory' })).json() as {
      recipes: { id: string }[];
    };

    expect(body.recipes.map((recipe) => recipe.id)).toEqual([
      'facil',
      'normal',
      'dificil',
      'pesadelo',
    ]);
  });

  it('devolve o comando que o admin cola no jogo', async () => {
    const { app } = await buildHarness();

    await createDungeon(app);

    const body = (await app.inject({ method: 'GET', url: '/dungeons/bunker/command' })).json() as {
      chat: string;
    };

    expect(body.chat).toBe('/ozdungeon build bunker');
  });
});

describe('o olho do assistente', () => {
  it('não vê nada antes de o admin construir', async () => {
    const { app } = await buildHarness();

    await createDungeon(app);

    const body = (
      await app.inject({ method: 'GET', url: `/dungeons/bunker/runs?since=${String(Date.now())}` })
    ).json() as { runs: unknown[] };

    expect(body.runs).toEqual([]);
  });

  it('vê a construção assim que ela acontece', async () => {
    const { app, events } = await buildHarness();

    await createDungeon(app);

    const openedAt = Date.now();

    // É o que o agente faz ao ler `#OZDUNGEON#{"kind":"built",…}`
    // no stream do console.
    events.startRun({
      eventId: 'manual',
      serverId: SERVER,
      dungeonId: 'bunker',
      x: 500,
      z: 500,
      grid: 'Q10',
      seed: 42,
      startedAt: openedAt + 1000,
    });

    const body = (
      await app.inject({
        method: 'GET',
        url: `/dungeons/bunker/runs?serverId=${SERVER}&since=${String(openedAt)}`,
      })
    ).json() as { runs: { grid: string; status: string }[] };

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.grid).toBe('Q10');
    expect(body.runs[0]?.status).toBe('active');
  });

  it('NÃO celebra a construção de ontem', async () => {
    // Sem `since`, o assistente daria por concluído um passo que o
    // admin nem começou.
    const { app, events } = await buildHarness();

    await createDungeon(app);

    const ontem = Date.now() - 86_400_000;

    events.startRun({
      eventId: 'manual',
      serverId: SERVER,
      dungeonId: 'bunker',
      x: 0,
      z: 0,
      grid: 'A1',
      seed: 1,
      startedAt: ontem,
    });

    const body = (
      await app.inject({ method: 'GET', url: `/dungeons/bunker/runs?since=${String(Date.now())}` })
    ).json() as { runs: unknown[] };

    expect(body.runs).toEqual([]);
  });

  it('a falha também é um resultado', async () => {
    // Senão o spinner gira até o admin desistir e abrir o console
    // do servidor.
    const { app, events } = await buildHarness();

    await createDungeon(app);

    const openedAt = Date.now();

    events.failRun({
      eventId: 'manual',
      serverId: SERVER,
      dungeonId: 'bunker',
      reason: 'no_hatch',
      at: openedAt + 500,
    });

    const body = (
      await app.inject({ method: 'GET', url: `/dungeons/bunker/runs?since=${String(openedAt)}` })
    ).json() as { runs: { status: string; failureReason: string }[] };

    expect(body.runs[0]?.status).toBe('failed');
    expect(body.runs[0]?.failureReason).toBe('no_hatch');
  });
});

describe('o acervo de traçados', () => {
  const CLEAN = ['..RR..', '..RR..', 'GG##BB', 'GG##BB', '..##..', '..E#..'];

  it('salva o desenho e devolve as contagens', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'meu', name: 'O meu', grid: CLEAN },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      layout: { roomCount: number; cellCount: number; grid: string[] };
      problems: string[];
    };

    expect(body.layout.roomCount).toBe(3);
    expect(body.layout.cellCount).toBe(20);
    expect(body.problems).toEqual([]);
  });

  it('a lista TRAZ o desenho — e dele vive a miniatura', async () => {
    const { app } = await buildHarness();

    await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'meu', name: 'O meu', grid: CLEAN },
    });

    const body = (await app.inject({ method: 'GET', url: '/dungeon-layouts' })).json() as {
      layouts: { grid: string[] }[];
    };

    expect(body.layouts[0]?.grid).toEqual(CLEAN);
  });

  it('GRAVA o desenho com defeito, e diz quais', async () => {
    // Um traçado é rascunho: recusar perderia o trabalho de quem ia
    // consertar a sala depois. O que não pode é ele não saber.
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'torto', name: 'Torto', grid: ['RRGG##', '..GG##', '....E#'] },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as { layout: { problemCount: number }; problems: string[] };

    expect(body.layout.problemCount).toBe(body.problems.length);
    expect(body.problems.some((line) => line.includes('ninguém consegue entrar'))).toBe(true);
  });

  it('salvar de novo com o mesmo slug substitui, e responde 200', async () => {
    const { app } = await buildHarness();

    await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'meu', name: 'Antes', grid: CLEAN },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'meu', name: 'Depois', grid: CLEAN },
    });

    expect(second.statusCode).toBe(200);

    const body = (await app.inject({ method: 'GET', url: '/dungeon-layouts' })).json() as {
      layouts: { name: string }[];
    };

    expect(body.layouts).toHaveLength(1);
    expect(body.layouts[0]?.name).toBe('Depois');
  });

  it('apagar um traçado não pergunta quem o usa', async () => {
    // Ao contrário da planta de entrada: carregar um traçado COPIA
    // o desenho, então nenhuma masmorra depende do original.
    const { app } = await buildHarness();

    await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'meu', name: 'O meu', grid: CLEAN },
    });

    expect((await app.inject({ method: 'DELETE', url: '/dungeon-layouts/meu' })).statusCode).toBe(
      200,
    );

    expect((await app.inject({ method: 'DELETE', url: '/dungeon-layouts/meu' })).statusCode).toBe(
      404,
    );
  });

  it('recusa um grid com caractere que o formato não tem', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/dungeon-layouts',
      payload: { id: 'meu', name: 'O meu', grid: ['@@@', 'E##'] },
    });

    expect(response.statusCode).toBe(400);
  });
});

// ============================================================
//  Erguer a masmorra pelo painel.
//
//  ####  O QUE ESTE BLOCO PROTEGE  ####
//
//  O passo ⑥ do editor dizia que erguer "é a única parte que não
//  dá para fazer daqui" — e não era verdade, era uma peça que
//  faltava: o console aceita `ozdungeon build <slug> <x> <z>`
//  desde a frente C.
//
//  O que se prova aqui é a TRADUÇÃO: cada recusa do servidor vira
//  um código HTTP que a tela sabe tratar, e nenhuma delas vira um
//  "pronto" — o painel já afirmou uma vez ter derrubado uma
//  masmorra que continuava de pé, e essa é a falha que ninguém
//  desconfia.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §1.
// ============================================================

const DRY_LAND = {
  x: 120,
  z: -340,
  grid: 'E7',
  ground: 12.4,
  water: 0,
  depth: 0,
  serves: true,
};

async function askBuild(app: FastifyInstance, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/dungeons/bunker/build',
    payload: { serverId: SERVER, x: 120, z: -340, ...body },
  });
}

describe('erguer pelo painel', () => {
  it('manda o comando e diz onde, sem afirmar que ela existe', async () => {
    const asked: unknown[] = [];

    const { app } = await buildHarness({
      build: async (serverId, input) => {
        asked.push({ serverId, ...input });

        return Promise.resolve({ sent: true, reply: "Construindo 'bunker'…", ground: DRY_LAND });
      },
    });

    await createDungeon(app);

    const response = await askBuild(app, { yaw: 90 });

    expect(response.statusCode).toBe(200);

    const body = response.json() as { sent: boolean; grid: string; message: string };

    expect(body.sent).toBe(true);
    expect(body.grid).toBe('E7');
    // A frase não pode prometer o que ainda não aconteceu: quem
    // confirma é o `built` do stream, segundos depois.
    expect(body.message).toContain('leva alguns segundos');

    expect(asked).toEqual([{ serverId: SERVER, slug: 'bunker', x: 120, z: -340, yaw: 90 }]);
  });

  it('a masmorra precisa existir antes', async () => {
    const { app } = await buildHarness({
      build: async () => Promise.resolve({ sent: true, reply: '', ground: null }),
    });

    const response = await askBuild(app);

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('DUNGEON_NOT_FOUND');
  });

  it('água vira 422 com a profundidade na frase', async () => {
    const { app } = await buildHarness({
      build: async () =>
        Promise.resolve({
          sent: false,
          refused: 'water' as const,
          reply: '',
          ground: { ...DRY_LAND, depth: 3.2, serves: false },
        }),
    });

    await createDungeon(app);

    const response = await askBuild(app);

    expect(response.statusCode).toBe(422);

    const body = response.json() as { error: string; message: string };

    expect(body.error).toBe('BUILD_POINT_IS_WATER');
    expect(body.message).toContain('3.2 m');
  });

  it('uma masmorra já de pé vira 409, com a frase do plugin', async () => {
    const { app } = await buildHarness({
      build: async () =>
        Promise.resolve({
          sent: false,
          refused: 'occupied' as const,
          reply: "Já existe uma masmorra de pé ('visita'). Use /ozdungeon stop antes.",
          ground: DRY_LAND,
        }),
    });

    await createDungeon(app);

    const response = await askBuild(app);

    expect(response.statusCode).toBe(409);

    const body = response.json() as { error: string; message: string };

    expect(body.error).toBe('DUNGEON_ALREADY_ACTIVE');
    // A frase do servidor chega inteira: é ela que diz QUAL masmorra
    // está no chão, e o painel não sabe disso sozinho.
    expect(body.message).toContain('visita');
  });

  it('servidor fora do fio vira 409, e não um "pronto"', async () => {
    const { app } = await buildHarness({
      build: async () =>
        Promise.resolve({ sent: false, refused: 'offline' as const, reply: '', ground: null }),
    });

    await createDungeon(app);

    const response = await askBuild(app);

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('SERVER_OFFLINE');
  });

  it('sem canal com os servidores, a rota recusa em vez de fingir', async () => {
    const { app } = await buildHarness();

    await createDungeon(app);

    const response = await askBuild(app);

    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toBe('BUILD_UNAVAILABLE');
  });

  it('o chão pode ser consultado antes de escolher o ponto', async () => {
    const { app } = await buildHarness({
      groundAt: async (_serverId, x, z) => Promise.resolve({ ...DRY_LAND, x, z }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/dungeons/ground?serverId=${SERVER}&x=120&z=-340`,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as { ground: { grid: string; serves: boolean } };

    expect(body.ground.grid).toBe('E7');
    expect(body.ground.serves).toBe(true);
  });
});
