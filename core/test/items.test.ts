// ============================================================
//  items.test.ts  -  as promessas do catálogo de itens que
//  ninguém confere olhando.
//
//  O que este arquivo guarda:
//
//    1. protocolo IGUAL não relê; protocolo DIFERENTE relê;
//    2. o item que sumiu do jogo continua na tabela, MARCADO;
//    3. uma leitura que falha no meio não apaga nem corrompe o
//       catálogo anterior — a rodada some inteira;
//    4. a resposta paginada é montada inteira, e o `count` é quem
//       diz se ela fechou;
//    5. a lista responde com TODOS os servidores desligados, que é
//       a razão de a tabela existir.
//
//  Banco em memória e um "servidor" que é um catálogo em memória:
//  é o que permite testar a varredura inteira sem servidor de Rust
//  nenhum.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository, type ItemInput } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ItemCatalog, readGameProtocol } from '../src/game/item-catalog.js';
import { apiErrorToResponse, isApiError } from '../src/http/error-response.js';
import { registerItemRoutes } from '../src/http/routes/items.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

function item(shortname: string, displayName: string, category = 'Weapon'): ItemInput {
  return {
    shortname,
    displayName,
    itemId: shortname.length * 1000,
    category,
    maxStack: 1,
    hasCondition: true,
  };
}

const AK = item('rifle.ak', 'Assault Rifle');
const BOW = item('bow.hunting', 'Hunting Bow');
const HAT = item('hat.wolf', 'Wolf Headdress', 'Attire');

/** O "servidor de Rust": um catálogo e um protocolo, em memória. */
interface FakeGame {
  protocol: string | null;
  catalog: ItemInput[];
  connected: boolean;
  /** Quantas varreduras ele respondeu. É o que prova o cache. */
  reads: number;
  /**
   * A leitura quebra a partir desta página (0 = a primeira).
   *
   * `null` = ela vai até o fim. É como se simula o RCON caindo no
   * meio de uma varredura de várias páginas.
   */
  breakAtPage: number | null;
  /** O plugin ANUNCIA mais itens do que entrega. */
  lieAboutCount: number | null;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: ItemsRepository;
  readonly game: FakeGame;
  readonly catalog: ItemCatalog;
  readonly app: FastifyInstance;
}

let harness: Harness;

/** Itens por página. O mesmo padrão do plugin. */
const PAGE = 250;

function fakeRcon(game: FakeGame): OpsRcon {
  let page = 0;

  return {
    get isConnected() {
      return game.connected;
    },
    send: (command: string) => {
      if (!game.connected) {
        return Promise.reject(new Error('RCON fora do ar'));
      }

      if (command === 'serverinfo') {
        // ####  INDENTADO, COMO O SERVIDOR DE VERDADE RESPONDE  ####
        //
        // MEDIDO no server01: o `serverinfo` devolve o JSON em
        // vinte linhas, ao contrário dos plugins deste projeto, que
        // respondem numa linha só. Um teste que devolvesse tudo
        // junto passaria com um leitor que não funciona no jogo —
        // e o sintoma lá seria o catálogo relido a cada reconexão.
        return Promise.resolve(
          `${JSON.stringify(
            { Hostname: 'Craggy Island', Players: 1, Version: 2632, Protocol: game.protocol },
            null,
            2,
          )}\n`,
        );
      }

      if (command.startsWith('origemz.items')) {
        const offset = Number(command.split(' ')[1]);

        if (offset === 0) {
          page = 0;
          game.reads += 1;
        }

        if (game.breakAtPage !== null && page >= game.breakAtPage) {
          // O RCON caiu no meio: o comando não volta.
          return Promise.reject(new Error('a conexão caiu no meio da leitura'));
        }

        page += 1;

        return Promise.resolve(
          JSON.stringify({
            ok: true,
            count: game.lieAboutCount ?? game.catalog.length,
            offset,
            limit: PAGE,
            items: game.catalog.slice(offset, offset + PAGE),
          }),
        );
      }

      return Promise.resolve('');
    },
  };
}

beforeEach(async () => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const game: FakeGame = {
    protocol: '2632.287.1',
    catalog: [AK, BOW, HAT],
    connected: true,
    reads: 0,
    breakAtPage: null,
    lieAboutCount: null,
  };

  const repository = new ItemsRepository(db);
  const rcon = fakeRcon(game);

  const catalog = new ItemCatalog({
    repository,
    servers: {
      ids: () => ['pvp1'],
      contextOf: (id) => (id === 'pvp1' ? { rcon } : null),
    },
    logger: silent,
  });

  const app = Fastify();

  app.setErrorHandler(async (error, _request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR', message: String(error) });
  });

  await app.register(
    async (api) => {
      registerItemRoutes(api, { repository, catalog });
    },
    { prefix: '/api' },
  );

  harness = { db, repository, game, catalog, app };
});

// ------------------------------------------------------------
//  A invalidação
// ------------------------------------------------------------

describe('quando o catálogo é relido', () => {
  it('não relê com o MESMO protocolo', async () => {
    expect((await harness.catalog.sync('pvp1')).status).toBe('updated');
    expect(harness.game.reads).toBe(1);

    // Segunda conexão do RCON, mesma versão do jogo: nada a fazer.
    // Sem isto, todo restart do servidor custaria cinco idas ao
    // RCON para redescobrir os mesmos ~1250 itens.
    const again = await harness.catalog.sync('pvp1');

    expect(again.status).toBe('fresh');
    expect(harness.game.reads).toBe(1);
  });

  it('relê quando o protocolo MUDA', async () => {
    await harness.catalog.sync('pvp1');

    // A Facepunch publicou um update: o servidor reinicia e o RCON
    // reconecta com outro protocolo.
    harness.game.protocol = '2633.290.2';
    harness.game.catalog = [AK, BOW, HAT, item('gun.water', 'Water Gun', 'Fun')];

    expect((await harness.catalog.sync('pvp1')).status).toBe('updated');
    expect(harness.game.reads).toBe(2);
    expect(harness.repository.state().protocol).toBe('2633.290.2');
    expect(harness.repository.state().total).toBe(4);
  });

  it('lê o protocolo de um `serverinfo` indentado, com log em volta', async () => {
    // A resposta do RCON traz o que o servidor estava imprimindo
    // naquele instante, antes e depois do bloco.
    const rcon = {
      isConnected: true,
      send: () =>
        Promise.resolve(
          '[Oxide] carregando…\n{\n  "Hostname": "Craggy Island",\n  "Protocol": "2632.287.1"\n}\nsaving complete\n',
        ),
    };

    expect(await readGameProtocol(rcon)).toBe('2632.287.1');
  });

  it('relê quando não dá para saber o protocolo', async () => {
    await harness.catalog.sync('pvp1');

    // Sem protocolo não dá para AFIRMAR que a cópia guardada
    // continua valendo, e o lado certo de errar é reler.
    harness.game.protocol = null;

    expect((await harness.catalog.sync('pvp1')).status).toBe('updated');
    expect(harness.game.reads).toBe(2);
  });

  it('não age sobre um palpite com o servidor parado', async () => {
    harness.game.connected = false;

    const result = await harness.catalog.sync('pvp1');

    expect(result.status).toBe('skipped');
    expect(harness.repository.state().total).toBe(0);
  });
});

// ------------------------------------------------------------
//  O item que sumiu
// ------------------------------------------------------------

describe('um item que sumiu do jogo', () => {
  it('continua na tabela, marcado', async () => {
    await harness.catalog.sync('pvp1');

    // A Facepunch tirou o arco do jogo.
    harness.game.protocol = '2633.290.2';
    harness.game.catalog = [AK, HAT];

    const result = await harness.catalog.sync('pvp1');

    expect(result.status).toBe('updated');

    // A linha FICA: um kit do mês passado aponta para ela, e
    // apagá-la deixaria o kit com um shortname órfão.
    const bow = harness.repository.get('bow.hunting');

    expect(bow).not.toBeNull();
    expect(bow?.removed).toBe(true);

    // E o que continua no jogo não é marcado.
    expect(harness.repository.get('rifle.ak')?.removed).toBe(false);
    expect(harness.repository.state().total).toBe(3);
  });

  it('preserva o "existe desde" de quem continua', () => {
    harness.repository.replace({ items: [AK], protocol: 'a', at: 1_000 });
    harness.repository.replace({ items: [AK], protocol: 'b', at: 2_000 });

    const ak = harness.repository.get('rifle.ak');

    // `first_seen` é a única informação daqui que não dá para
    // reconstruir de nenhuma outra fonte.
    expect(ak?.firstSeen).toBe(1_000);
    expect(ak?.lastSeen).toBe(2_000);
  });

  it('deixa filtrar só o que sumiu, e só o que existe', () => {
    harness.repository.replace({ items: [AK, BOW], protocol: 'a', at: 1_000 });
    harness.repository.replace({ items: [AK], protocol: 'b', at: 2_000 });

    const gone = harness.repository.list({ removed: true, limit: 50, offset: 0 });
    const alive = harness.repository.list({ removed: false, limit: 50, offset: 0 });

    expect(gone.items.map((entry) => entry.shortname)).toEqual(['bow.hunting']);
    expect(alive.items.map((entry) => entry.shortname)).toEqual(['rifle.ak']);
  });
});

// ------------------------------------------------------------
//  A rodada é tudo ou nada
// ------------------------------------------------------------

describe('uma leitura que falha no meio', () => {
  it('não apaga nem corrompe o catálogo anterior', async () => {
    // Um catálogo grande, para a leitura ter mais de uma página.
    const big = Array.from({ length: 600 }, (_, index) =>
      item(`item.${String(index)}`, `Item ${String(index)}`),
    );

    harness.game.catalog = big;

    expect((await harness.catalog.sync('pvp1')).status).toBe('updated');
    expect(harness.repository.state().total).toBe(600);

    const before = harness.repository.state();

    // Agora o RCON cai na segunda página.
    harness.game.protocol = '2633.290.2';
    harness.game.catalog = [...big, item('item.novo', 'Item Novo')];
    harness.game.breakAtPage = 1;

    const result = await harness.catalog.sync('pvp1');

    expect(result.status).toBe('failed');

    // O catálogo anterior está INTACTO — mesmo tamanho, mesmo
    // protocolo, mesmo carimbo. Meio catálogo é pior que um
    // catálogo velho.
    const after = harness.repository.state();

    expect(after.total).toBe(before.total);
    expect(after.protocol).toBe(before.protocol);
    expect(after.scannedAt).toBe(before.scannedAt);
    expect(harness.repository.get('item.novo')).toBeNull();
  });

  it('descarta a rodada quando o total anunciado não bate', async () => {
    // O plugin diz que tem 5000 itens e entrega 3. Sem a
    // conferência, o catálogo entraria pela metade.
    harness.game.lieAboutCount = 5_000;

    const result = await harness.catalog.sync('pvp1');

    expect(result.status).toBe('failed');
    expect(harness.repository.state().total).toBe(0);
  });

  it('recusa gravar uma rodada vazia', () => {
    // Lista vazia é o sintoma de leitura que deu errado do outro
    // lado. Aplicá-la marcaria o catálogo inteiro como removido.
    expect(() => harness.repository.replace({ items: [], protocol: 'a' })).toThrow();
  });
});

// ------------------------------------------------------------
//  A paginação
// ------------------------------------------------------------

describe('a resposta paginada', () => {
  it('é montada inteira, em quantas páginas forem precisas', async () => {
    harness.game.catalog = Array.from({ length: 1_252 }, (_, index) =>
      item(`item.${String(index)}`, `Item ${String(index)}`),
    );

    const result = await harness.catalog.sync('pvp1');

    expect(result.status).toBe('updated');
    expect(harness.repository.state().total).toBe(1_252);

    // O último item da última página chegou: é o que prova que o
    // laço não parou no `limit` da primeira resposta.
    expect(harness.repository.get('item.1251')).not.toBeNull();
  });
});

// ------------------------------------------------------------
//  A rota
// ------------------------------------------------------------

describe('GET /api/items', () => {
  it('responde com TODOS os servidores desligados', async () => {
    await harness.catalog.sync('pvp1');

    // É a razão de a tabela existir: montar um kit é trabalho de
    // madrugada, com tudo parado.
    harness.game.connected = false;

    const response = await harness.app.inject({ method: 'GET', url: '/api/items' });
    const body = response.json() as {
      total: number;
      catalog: { source: string; protocol: string | null; note: string | null };
    };

    expect(response.statusCode).toBe(200);
    expect(body.total).toBe(3);
    expect(body.catalog.protocol).toBe('2632.287.1');
    // E a resposta DIZ que ninguém está conferindo. Uma tela que
    // mostra 1252 itens sem avisar que eles são de três versões
    // atrás é uma tela que mente.
    expect(body.catalog.source).toBe('banco');
    expect(body.catalog.note).toContain('Nenhum servidor');
  });

  it('devolve 200 com lista vazia numa instalação nova', async () => {
    harness.game.connected = false;

    const response = await harness.app.inject({ method: 'GET', url: '/api/items' });
    const body = response.json() as { total: number; catalog: { note: string | null } };

    // Não é erro: é o estado de quem acabou de instalar. Um 404
    // aqui faria a tela parecer quebrada.
    expect(response.statusCode).toBe(200);
    expect(body.total).toBe(0);
    expect(body.catalog.note).toContain('preenchido quando o primeiro servidor subir');
  });

  it('busca por nome e por shortname, e filtra por categoria', async () => {
    await harness.catalog.sync('pvp1');

    const byName = await harness.app.inject({ method: 'GET', url: '/api/items?q=Assault' });
    const byShortname = await harness.app.inject({ method: 'GET', url: '/api/items?q=hat.' });
    const byCategory = await harness.app.inject({
      method: 'GET',
      url: '/api/items?category=Attire',
    });

    expect((byName.json() as { total: number }).total).toBe(1);
    expect((byShortname.json() as { total: number }).total).toBe(1);
    expect((byCategory.json() as { total: number }).total).toBe(1);
  });

  it('pagina de verdade, com o total antes do corte', async () => {
    harness.game.catalog = Array.from({ length: 120 }, (_, index) =>
      item(`item.${String(index)}`, `Item ${String(index)}`),
    );

    await harness.catalog.sync('pvp1');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/items?limit=50&offset=100',
    });

    const body = response.json() as { count: number; total: number };

    expect(body.count).toBe(20);
    // Sem o `total`, a tela não sabe se há página seguinte.
    expect(body.total).toBe(120);
  });

  it('recusa o refresh sem nenhum servidor no ar, com o motivo', async () => {
    harness.game.connected = false;

    const response = await harness.app.inject({ method: 'POST', url: '/api/items/refresh' });
    const body = response.json() as { error: string; message: string };

    expect(response.statusCode).toBe(409);
    expect(body.error).toBe('NO_SERVER_ONLINE');
    expect(body.message).toContain('Nenhum servidor está no ar');
  });

  it('devolve 404 com a frase certa para um shortname que não existe', async () => {
    await harness.catalog.sync('pvp1');

    const response = await harness.app.inject({ method: 'GET', url: '/api/items/nao.existe' });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('ITEM_NOT_FOUND');
  });
});
