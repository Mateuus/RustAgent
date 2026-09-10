// ============================================================
//  betterloot.test.ts  -  as promessas do editor de loot que
//  ninguém confere olhando.
//
//  O que este arquivo guarda:
//
//    1. o plugin AUSENTE responde 200 com a lista vazia e uma
//       frase — nunca erro. É o estado do `server01` de hoje, e um
//       erro ali faria a tela parecer quebrada num caso normal;
//    2. a RARIDADE atravessa: ela não está no arquivo, sai do
//       nosso catálogo, e sem ela a tela não calcula porcentagem
//       nenhuma;
//    3. a `revision` recusa a gravação de quem abriu a tela antes
//       de outra pessoa gravar — sem ela, duas telas abertas
//       perdem trabalho em silêncio;
//    4. o BACKUP acontece antes da escrita, e o caminho volta na
//       resposta;
//    5. `Item Properties` SOBREVIVE ao salvamento. É o defeito que
//       só apareceria no jogo: a tela não edita esse bloco, e uma
//       gravação que o montasse do zero apagaria a munição e os
//       acessórios de toda arma da caixa;
//    6. o prefab com ESPAÇO e o `unwrap/` viajam inteiros — as
//       duas formas que quebram quem tratar a chave como caminho;
//    7. e a lista de contêineres devolve `name`, que é o campo que
//       a tela lê. Ela devolvia `prefab`, e o painel recebia 33
//       linhas sem nome.
//
//  ####  E O ARQUIVO DE VERDADE ENTRA NO TESTE  ####
//
//  O último bloco abre o `LootTables.json` que o BetterLoot gerou
//  no `server01` — 2,53 MB, 111 prefabs, 6.824 entradas — e
//  confere a leitura contra ele. Um teste que só lê o JSON que ele
//  mesmo escreveu não teria descoberto o prefab com espaço nem as
//  chaves `unwrap/`.
// ============================================================

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import { registerBetterLootRoutes } from '../src/http/routes/betterloot.js';
import { registerLootRoutes } from '../src/http/routes/loot.js';
import {
  BetterLootEditor,
  natureOfPrefab,
  parseLootTables,
  shortPrefabOf,
  shortnameOfKey,
} from '../src/oxide/betterloot.js';
import { LootRulesRepository } from '../src/db/loot-rules-repository.js';
import { CustomItemsRepository } from '../src/db/custom-items-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import {
  BetterLootJunkRepository,
  DEFAULT_JUNK_SHORTNAMES,
} from '../src/db/betterloot-junk-repository.js';

const SERVER = 'server01';

/** O prefab com ESPAÇO — um dos dezessete medidos no arquivo real. */
const SPACED_PREFAB = 'assets/bundled/prefabs/radtown/dmloot/dm ammo.prefab';
const ELITE = 'assets/bundled/prefabs/radtown/crate_elite.prefab';

interface Harness {
  readonly db: AgentDatabase;
  readonly app: FastifyInstance;
  readonly dataDir: string;
  readonly configDir: string;
  readonly backupsDir: string;
  readonly reloads: string[];
  /**
   * O que o "Oxide" faz ao receber o `oxide.reload`.
   *
   * O plugin de verdade REESCREVE o `LootTables.json` ao carregar
   * (`BetterLoot.cs:780`), e é essa reescrita que fazia a segunda
   * gravação da mesma caixa levar 409. Sem um jeito de imitá-la
   * aqui, o teste nunca veria o defeito.
   */
  onReload: (() => Promise<void>) | null;
}

let harness: Harness;

/**
 * Um `LootTables.json` pequeno, com as três formas de chave.
 *
 * O `rifle.ak` carrega `Item Properties` de propósito: é o bloco
 * que a tela não edita e que o salvamento não pode apagar.
 */
function lootTables(): unknown {
  return {
    LootTables: {
      [ELITE]: {
        'Is Prefab Enabled?': true,
        'Loot Profiles': [],
        'Enable Loot Pool Locking': false,
        'Select ungrouped items ignoring rarity bias': false,
        'Guaranteed Items': {
          scrap: {
            'Skin ID (0 = default)': 0,
            'Display Name (empty = none)': '',
            'Item Minimum': 10,
            'Item Maximum': 25,
          },
        },
        'Ungrouped Items': {
          'rifle.ak': {
            'Allow Duplicates': true,
            'Skin ID (0 = default)': 0,
            'Display Name (empty = none)': '',
            'Item Minimum': 1,
            'Item Maximum': 1,
            'Can Convert To Blueprint': true,
            'Item Durability': { 'Minimum Durability': 10, 'Maximum Durability': 60 },
            'Item Properties': {
              'Ammunition Settings': {
                'Ammo Item Shortname': 'ammo.rifle',
                'Minimum Amount': 0,
                'Maximum Amount': 30,
              },
              'Weapon Attachments': {
                'Minimum Mod Amount': 1,
                'Maximum Mod Amount': 2,
                'Available Attachments': {
                  'weapon.mod.holosight': { 'Spawn Probability (0%-100%)': 50.0 },
                },
              },
            },
            'Bonus Items': {},
          },
          // O mesmo item base, duas skins: é o sufixo `{n}` que faz
          // um catálogo de itens nossos caber numa caixa só.
          'trophy{1}': {
            'Allow Duplicates': false,
            'Skin ID (0 = default)': 3403269092,
            'Display Name (empty = none)': 'Troféu Bleik Store',
            'Item Minimum': 1,
            'Item Maximum': 1,
            'Bonus Items': {},
          },
          sticks: {
            'Allow Duplicates': true,
            'Skin ID (0 = default)': 0,
            'Display Name (empty = none)': '',
            'Item Minimum': 5,
            'Item Maximum': 10,
            'Bonus Items': {},
          },
        },
        'Item Settings': {
          'Minimum Amount of Items': 3,
          'Maximum Amount of Items': 6,
          'Minimum Scrap Amount': 25,
          'Maximum Scrap Amount': 25,
          'Minimum Blueprints': 0,
          'Maximum Blueprints': 1,
          'Bonus Items Contribute to Item Count': false,
          'Guaranteed Items Contribute to Item Count': true,
        },
      },
      [SPACED_PREFAB]: {
        'Is Prefab Enabled?': true,
        'Ungrouped Items': { 'ammo.rifle': { 'Item Minimum': 30, 'Item Maximum': 60 } },
        'Item Settings': {},
      },
      'unwrap/xmas.present.large': {
        'Is Prefab Enabled?': true,
        'Ungrouped Items': {},
        'Item Settings': {},
      },
    },
  };
}

function betterLootConfig(): unknown {
  return {
    'General Configuration': {
      'Blueprint Weight (0.0 = min bias, 1.0 = max bias, 0.5 = balanced)': 0.11,
    },
    'Loot Configuration': {
      'Loot Multiplier': 2,
      // Sem o "i": é erro de grafia do plugin, e o agente tem de
      // encontrar a chave como ela é.
      'Scrap Multipler': 5,
      'Allow duplicate items': true,
      'Enable Blueprint Conversion': true,
      'Enable Loot Pool Locking System': true,
    },
  };
}

beforeEach(async () => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const items = new ItemsRepository(db);

  // O catálogo do jogo. As raridades são as do enum: 0 é o mais
  // comum e 4 o mais raro. O `sticks` vem SEM raridade — é como um
  // plugin anterior a 06/09/2026 responde, e é o caso que faz a
  // tela mostrar travessão em vez de zero.
  items.replace({
    items: [
      {
        shortname: 'rifle.ak',
        displayName: 'Assault Rifle',
        itemId: 1545779598,
        category: 'Weapon',
        maxStack: 1,
        hasCondition: true,
        consumable: false,
        rarity: 4,
      },
      {
        shortname: 'trophy',
        displayName: 'Twitch Rivals Trophy',
        itemId: 975983052,
        category: 'Items',
        maxStack: 1,
        hasCondition: false,
        consumable: false,
        rarity: 0,
      },
      {
        shortname: 'scrap',
        displayName: 'Scrap',
        itemId: -932201673,
        category: 'Resources',
        maxStack: 1000,
        hasCondition: false,
        consumable: false,
        rarity: 1,
      },
      {
        shortname: 'sticks',
        displayName: 'Sticks',
        itemId: -1090916276,
        category: 'Resources',
        maxStack: 1000,
        hasCondition: false,
      },
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });

  const root = await mkdtemp(join(tmpdir(), 'rustagent-betterloot-'));
  const dataDir = join(root, 'oxide', 'data');
  const configDir = join(root, 'oxide', 'config');
  const backupsDir = join(root, 'backups');

  await mkdir(join(dataDir, 'BetterLoot'), { recursive: true });
  await mkdir(configDir, { recursive: true });

  const reloads: string[] = [];

  const servers = {
    configOf: (id: string) =>
      id === SERVER ? { paths: { oxideConfigDir: configDir, oxideDataDir: dataDir, backupsDir } } : null,
  };

  const editor = new BetterLootEditor({
    servers,
    items,
    reload: async (serverId) => {
      reloads.push(serverId);

      await harness?.onReload?.();

      return { sent: true, output: 'Reloaded plugin BetterLoot v4.4.0' };
    },
    // Os mesmos tempos de produção, em escala de teste: sem um
    // Oxide do outro lado ninguém reescreve nada, e a paciência de
    // dois segundos seria cobrada de cada gravação para não
    // descobrir coisa alguma. A `graceMs` daqui ainda é folgada o
    // bastante para o teste da corrida ver a reescrita chegar
    // atrasada. Ver `RewriteWait`.
    rewriteWait: { pollMs: 5, quietMs: 15, graceMs: 150, timeoutMs: 1_000 },
  });

  const app = Fastify();

  // O mesmo tratamento do servidor real (http/server.ts). Sem a
  // linha do ZodError, uma recusa de validação viria como 500 e o
  // teste passaria a medir o handler do teste.
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
    registerBetterLootRoutes(api, { editor, junk: new BetterLootJunkRepository(db) });
    registerLootRoutes(api, {
      repository: new LootRulesRepository(db),
      customItems: new CustomItemsRepository(db),
      servers: new ServersRepository(db),
      supervisor: servers,
    });
  });

  await app.ready();

  // Os dois servidores existem no BANCO porque a lista de "lixo"
  // tem FK para `servers` — ela é cadastro nosso, e não arquivo do
  // plugin. O resto deste teste fala com o disco por `configOf`, que
  // é fake, e nunca precisou de linha nenhuma aqui.
  for (const [id, port] of [
    ['server01', 28015],
    ['server02', 28025],
  ] as const) {
    db.prepare(
      `INSERT INTO servers
         (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
          install_dir, created_at, updated_at)
       VALUES (@id, @id, @id, 1, @game, @rcon, @query, @app, @dir, @now, @now)`,
    ).run({
      id,
      game: port,
      rcon: port + 1,
      query: port + 2,
      app: port + 3,
      dir: dataDir,
      now: Date.now(),
    });
  }

  harness = { db, app, dataDir, configDir, backupsDir, reloads, onReload: null };
});

/** Põe os três arquivos no lugar. Sem isto, o plugin "nunca rodou". */
async function seedFiles(): Promise<void> {
  await writeFile(
    join(harness.dataDir, 'BetterLoot', 'LootTables.json'),
    JSON.stringify(lootTables(), null, 2),
    'utf8',
  );
  await writeFile(
    join(harness.dataDir, 'BetterLoot', 'Blacklist.json'),
    JSON.stringify({ ItemList: ['wood', 'stones'] }),
    'utf8',
  );
  await writeFile(
    join(harness.configDir, 'BetterLoot.json'),
    JSON.stringify(betterLootConfig(), null, 2),
    'utf8',
  );
}

/**
 * Um `LootGroups.json` com um perfil — a forma medida no
 * `server01`, campo por campo.
 */
function lootGroups(): unknown {
  return {
    'Loot Groups': {
      armas_t3: {
        'Enabled?': true,
        'Guaranteed Items': {},
        'Item List': {
          'rifle.ak': {
            'Item Probability (1-100)': 60.0,
            'Item Amount': {
              'Allow Duplicates': true,
              'Skin ID (0 = default)': 0,
              'Display Name (empty = none)': '',
              'Item Minimum': 1,
              'Item Maximum': 1,
              'Item Properties': {
                'Ammunition Settings': {
                  'Ammo Item Shortname': 'ammo.rifle',
                  'Minimum Amount': 0,
                  'Maximum Amount': 30,
                },
              },
              'Bonus Items': {},
            },
          },
          sticks: {
            'Item Probability (1-100)': 40.0,
            'Item Amount': {
              'Allow Duplicates': true,
              'Skin ID (0 = default)': 0,
              'Display Name (empty = none)': '',
              'Item Minimum': 5,
              'Item Maximum': 10,
              'Bonus Items': {},
            },
          },
        },
      },
    },
  };
}

async function seedGroups(): Promise<void> {
  await writeFile(
    join(harness.dataDir, 'BetterLoot', 'LootGroups.json'),
    JSON.stringify(lootGroups(), null, 2),
    'utf8',
  );
}

describe('o plugin ausente', () => {
  it('responde 200 com a lista vazia e uma frase que ensina', async () => {
    const response = await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot` });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(body.tables).toEqual([]);
    expect(body.revision).toBeNull();
    expect(body.globals).toBeNull();
    // A tela mostra este aviso, e ele é verdade: o plugin nunca
    // rodou ali.
    expect(body.loaded).toBe(false);
    expect(String(body.note)).toContain('LootTables.json');
  });

  it('recusa abrir uma caixa, e a mensagem diz o que faz a tabela nascer', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BETTERLOOT_NOT_CONFIGURED');
    expect(String(response.json().message)).toContain('primeiro carregamento');
  });

  it('e o servidor que não existe é 404, e não 409', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/servers/nao-existe/betterloot' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('UNKNOWN_SERVER');
  });
});

describe('a lista', () => {
  beforeEach(seedFiles);

  it('traz resumo, e não a caixa inteira', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot` })
    ).json();

    expect(body.count).toBe(3);

    const elite = body.tables.find((table: { prefab: string }) => table.prefab === ELITE);

    expect(elite.itemCount).toBe(3);
    expect(elite.guaranteedCount).toBe(1);
    expect(elite.itemSettings.maxScrap).toBe(25);
    // O resumo NÃO carrega as entradas: é o que faz 111 caixas
    // caberem em 34,8 KB.
    expect(elite.items).toBeUndefined();
  });

  it('lê os globais do outro arquivo, inclusive a chave com erro de grafia', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot` })
    ).json();

    expect(body.globals.lootMultiplier).toBe(2);
    expect(body.globals.scrapMultiplier).toBe(5);
    expect(body.globals.blueprintWeight).toBeCloseTo(0.11);
    expect(body.blacklist).toEqual(['wood', 'stones']);
  });

  it('e o prefab com espaço e o unwrap/ chegam inteiros', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot` })
    ).json();

    const prefabs = body.tables.map((table: { prefab: string }) => table.prefab);

    expect(prefabs).toContain(SPACED_PREFAB);
    expect(prefabs).toContain('unwrap/xmas.present.large');
  });
});

describe('a raridade', () => {
  beforeEach(seedFiles);

  it('atravessa do catálogo até a entrada, porque o arquivo não a tem', async () => {
    const body = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    const byKey = new Map<string, { rarity: number | null; displayName: string | null }>(
      body.table.items.map((item: { key: string }) => [item.key, item]),
    );

    // O AK é raríssimo (4) e o troféu é do balde mais comum (0).
    expect(byKey.get('rifle.ak')?.rarity).toBe(4);
    expect(byKey.get('rifle.ak')?.displayName).toBe('Assault Rifle');

    // ####  A CHAVE COM `{1}` RESOLVE PARA O ITEM BASE  ####
    //
    // Sem isto, um catálogo de cinco troféus com skins diferentes
    // apareceria sem raridade nenhuma — e a tela inteira voltaria
    // ao travessão por causa do sufixo.
    expect(byKey.get('trophy{1}')?.rarity).toBe(0);
    expect(byKey.get('trophy{1}')?.displayName).toBe('Twitch Rivals Trophy');
  });

  it('e o item que ninguém perguntou vem NULO, e não zero', async () => {
    const body = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    const sticks = body.table.items.find((item: { key: string }) => item.key === 'sticks');

    // Zero é uma raridade DE VERDADE — a mais comum. Confundir os
    // dois faria a tela dar ao graveto o maior peso do sorteio.
    expect(sticks.rarity).toBeNull();
  });
});

describe('gravar', () => {
  beforeEach(seedFiles);

  /** Abre a caixa e devolve o corpo do PUT já montado. */
  async function open(): Promise<{ baseRevision: string; table: Record<string, unknown> }> {
    const body = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    // A revisão que o PUT quer é a DA CAIXA, e não a do arquivo.
    return { baseRevision: body.tableRevision, table: body.table };
  }

  it('recusa quem abriu antes de outra pessoa gravar', async () => {
    const input = await open();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: { ...input, baseRevision: 'a-revisao-de-outra-tela' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BETTERLOOT_STALE_REVISION');

    // ####  E NADA FOI GRAVADO  ####
    //
    // A recusa que grava metade é pior que a que não recusa.
    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    expect(Object.keys(disk.LootTables[ELITE]['Ungrouped Items'])).toHaveLength(3);
  });

  /**
   * O que o BetterLoot faz ao carregar, reduzido ao que importa.
   *
   * ####  E O ATRASO É O TESTE INTEIRO  ####
   *
   * Ele reescreve o `LootTables.json` DEPOIS que o `oxide.reload`
   * já respondeu — o RCON volta quando o comando é despachado, e o
   * Oxide só então descarrega, compila e chama `Init`. Reescrever
   * aqui de forma síncrona provaria outra coisa: a releitura do
   * `save` pegaria o arquivo novo por acaso, que é justamente o
   * que NÃO acontece em produção.
   */
  function pluginRewritesFileLate(): void {
    setTimeout(() => {
      void (async () => {
        const path = join(harness.dataDir, 'BetterLoot', 'LootTables.json');
        const disk = JSON.parse(await readFile(path, 'utf8'));

        // Uma caixa que a tela nem abriu: é o que o `scanEntry` faz
        // ao validar as 6.824 entradas de uma vez.
        disk.LootTables[SPACED_PREFAB]['Item Settings']['Maximum Scrap Amount'] = 999;

        // E a caixa ABERTA também — o `scanEntry` cria `Item
        // Durability` para todo item com condição, e é essa mexida
        // que fazia a revisão devolvida à tela nascer velha.
        disk.LootTables[ELITE]['Ungrouped Items'].sticks['Can Convert To Blueprint'] = true;

        await writeFile(path, JSON.stringify(disk, null, 2), 'utf8');
      })();
    }, 30);
  }

  it('deixa gravar a mesma caixa duas vezes depois de o plugin reescrever o arquivo', async () => {
    // ####  ISTO É O DEFEITO QUE O DONO RELATOU  ####
    //
    // A primeira gravação funcionava; a segunda, da MESMA caixa e
    // sem ninguém ter editado nada, respondia
    // BETTERLOOT_STALE_REVISION. A culpa era a revisão ser do
    // arquivo inteiro — e o próprio plugin reescrever o arquivo ao
    // recarregar.
    harness.onReload = async () => {
      pluginRewritesFileLate();
    };

    const first = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: await open(),
    });

    expect(first.statusCode).toBe(200);

    // ####  O ADMIN NÃO CLICA DUAS VEZES NO MESMO INSTANTE  ####
    //
    // Ele lê a tela, muda um número, e só então grava de novo — e
    // a reescrita do plugin já aconteceu quando isso ocorre. Sem
    // esta pausa o teste passaria mesmo com o defeito: as duas
    // gravações caberiam ANTES da reescrita, que é justamente o
    // caso que não acontece na vida real.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // A revisão que volta é a da CAIXA, e é com ela que a tela
    // grava de novo — sem F5, sem reabrir.
    const second = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        baseRevision: first.json().tableRevision,
        table: {
          ...first.json().table,
          itemSettings: { ...first.json().table.itemSettings, maxScrap: 42 },
        },
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().table.itemSettings.maxScrap).toBe(42);
  });

  it('não chama de conflito a gravação de OUTRA caixa', async () => {
    // O `save` copia as demais caixas do disco de agora: gravar a
    // caixa A nunca pôde apagar a caixa B. Com a revisão do arquivo
    // inteiro isso era recusado assim mesmo.
    const elite = await open();

    const spaced = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(SPACED_PREFAB)}`,
      })
    ).json();

    expect(
      (
        await harness.app.inject({
          method: 'PUT',
          url: `/servers/${SERVER}/betterloot/table`,
          payload: elite,
        })
      ).statusCode,
    ).toBe(200);

    // A segunda tela abriu ANTES da gravação acima e grava depois.
    // A caixa dela não foi tocada, logo não há conflito nenhum.
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: { baseRevision: spaced.tableRevision, table: spaced.table },
    });

    expect(response.statusCode).toBe(200);
  });

  it('ainda recusa quem abriu a MESMA caixa antes de outra pessoa gravar', async () => {
    // A trava não foi afrouxada: o conflito de verdade continua
    // sendo pego. Duas telas na mesma caixa, e a segunda perde.
    const first = await open();
    const second = await open();

    expect(first.baseRevision).toBe(second.baseRevision);

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        ...first,
        table: {
          ...first.table,
          itemSettings: { ...(first.table.itemSettings as object), maxScrap: 99 },
        },
      },
    });

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: second,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BETTERLOOT_STALE_REVISION');
  });

  it('grava, faz backup antes e recarrega o plugin', async () => {
    const input = await open();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        ...input,
        table: {
          ...input.table,
          itemSettings: { ...(input.table.itemSettings as object), maxScrap: 90 },
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.table.itemSettings.maxScrap).toBe(90);
    expect(body.reloaded).toBe(true);
    expect(harness.reloads).toEqual([SERVER]);

    // O backup é o que torna um salvamento errado reversível, e o
    // caminho volta na resposta em vez de virar promessa no log.
    expect(typeof body.backup).toBe('string');
    expect(existsSync(String(body.backup))).toBe(true);

    const backup = JSON.parse(await readFile(String(body.backup), 'utf8'));

    // A cópia é do que estava lá ANTES.
    expect(backup.LootTables[ELITE]['Item Settings']['Maximum Scrap Amount']).toBe(25);
  });

  it('####  PRESERVA `Item Properties`, QUE A TELA NÃO EDITA  ####', async () => {
    const input = await open();

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: input,
    });

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    const ak = disk.LootTables[ELITE]['Ungrouped Items']['rifle.ak'];

    // Se isto quebrar, a munição e os acessórios de toda arma do
    // servidor somem no primeiro salvamento — sem erro, e só
    // percebido no jogo.
    expect(ak['Item Properties']['Ammunition Settings']['Ammo Item Shortname']).toBe('ammo.rifle');
    expect(
      ak['Item Properties']['Weapon Attachments']['Available Attachments'][
        'weapon.mod.holosight'
      ]['Spawn Probability (0%-100%)'],
    ).toBe(50);
  });

  it('e as OUTRAS caixas ficam onde estavam', async () => {
    const input = await open();

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: input,
    });

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    // Salvar substitui o arquivo INTEIRO: se a caixa vizinha não
    // for reescrita junto, ela desaparece do servidor.
    expect(Object.keys(disk.LootTables)).toHaveLength(3);
    expect(disk.LootTables[SPACED_PREFAB]).toBeDefined();
  });

  it('remove a entrada que a tela tirou', async () => {
    const input = await open();
    const items = (input.table.items as { key: string }[]).filter((item) => item.key !== 'sticks');

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: { ...input, table: { ...input.table, items } },
    });

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    expect(Object.keys(disk.LootTables[ELITE]['Ungrouped Items'])).toEqual([
      'rifle.ak',
      'trophy{1}',
    ]);
  });

  it('recusa mínimo maior que máximo antes de encostar no disco', async () => {
    const input = await open();
    const items = (input.table.items as Record<string, unknown>[]).map((item) =>
      item.key === 'sticks' ? { ...item, min: 10, max: 1 } : item,
    );

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: { ...input, table: { ...input.table, items } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('BETTERLOOT_INVALID_RANGE');
    expect(harness.reloads).toEqual([]);
  });

  it('e a skin volta como TEXTO, com todos os dígitos', async () => {
    const input = await open();
    const trophy = (input.table.items as { key: string; skinId: string }[]).find(
      (item) => item.key === 'trophy{1}',
    );

    expect(trophy?.skinId).toBe('3403269092');
  });
});

describe('a lista de contêineres', () => {
  it('devolve `name`, que é o campo que a tela lê', async () => {
    const body = (await harness.app.inject({ method: 'GET', url: '/loot/containers' })).json();

    expect(body.count).toBeGreaterThan(60);

    for (const container of body.containers) {
      // Era `prefab`, e o painel lia `name`: 33 linhas chegavam sem
      // nome, todas caíam em "Outros" e nenhuma casava com a busca.
      expect(typeof container.name).toBe('string');
      expect(container.name.length).toBeGreaterThan(0);
    }

    const names = body.containers.map((container: { name: string }) => container.name);

    expect(names).toContain('crate_elite');
    // Os que entraram em 06/09/2026, medidos no LootTables.json.
    expect(names).toContain('crate_ammunition');
    expect(names).toContain('roadsign1');
  });

  it('enriquece com o que aquele servidor conhece', async () => {
    await seedFiles();

    const body = (
      await harness.app.inject({ method: 'GET', url: `/loot/containers?serverId=${SERVER}` })
    ).json();

    const names = body.containers.map((container: { name: string }) => container.name);

    // O `unwrap/` não é caixa no mapa: é o que sai ao ABRIR um
    // presente, e misturá-lo com barril afogaria a lista.
    expect(names).not.toContain('xmas.present.large');
    // O `dm ammo` tem ESPAÇO no nome curto, e a criação de regra o
    // recusaria. Oferecer o que não se pode escolher é pior que
    // não oferecer.
    expect(names).not.toContain('dm ammo');
  });

  it('e responde igual com o servidor que não existe', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: '/loot/containers?serverId=nao-existe' })
    ).json();

    // A lista tem UM dever, e o catálogo já o cumpre. Deixar de
    // responder por causa de um id errado seria trocar uma lista
    // boa por um erro.
    expect(body.ok).toBe(true);
    expect(body.fromServer).toBe(0);
    expect(body.count).toBeGreaterThan(60);
  });
});

// ============================================================
//  O ARQUIVO DE VERDADE
//
//  2,53 MB gerados pelo BetterLoot no `server01` em 06/09/2026.
//  Ele entra aqui porque um teste que só lê o JSON que ele mesmo
//  escreveu não teria descoberto o prefab com espaço, as chaves
//  `unwrap/` nem os 31 corpos de cientista.
//
//  Ausente, o bloco é PULADO em vez de falhar: quem clonar o
//  repositório sem os backups não tem por que ver vermelho.
// ============================================================
describe('o LootTables.json medido no server01', () => {
  const real = join(
    process.cwd(),
    '..',
    'Backups',
    'server01',
    'betterloot-config-inicial-2026-09-06_20-21',
    'LootTables.json',
  );

  it.skipIf(!existsSync(real))('abre inteiro, e a conta das naturezas fecha', async () => {
    const parsed = parseLootTables(await readFile(real, 'utf8'), real);
    const prefabs = Object.keys(parsed.tables);

    expect(prefabs).toHaveLength(111);

    const natures = prefabs.map(natureOfPrefab);

    expect(natures.filter((nature) => nature === 'container')).toHaveLength(71);
    expect(natures.filter((nature) => nature === 'npc')).toHaveLength(31);
    expect(natures.filter((nature) => nature === 'unwrap')).toHaveLength(9);

    // A revisão é o sha256 do texto: a mesma leitura dá a mesma
    // revisão, e é isso que faz a conferência do PUT valer.
    expect(parsed.revision).toMatch(/^[0-9a-f]{64}$/);

    // O `unwrap/` NÃO é caminho: o que vem depois da barra é o
    // shortname do item.
    expect(shortPrefabOf('unwrap/xmas.present.large')).toBe('xmas.present.large');
    expect(shortPrefabOf(SPACED_PREFAB)).toBe('dm ammo');
    expect(shortnameOfKey('discord.trophy{2}')).toBe('discord.trophy');
  });
});

// ============================================================
//  OS GLOBAIS — o que vale para o servidor inteiro
//
//  ####  ESTA ROTA MULTIPLICA 111 CONTÊINERES DE UMA VEZ  ####
//
//  `Loot Multiplier` e `Scrap Multipler` não são de uma caixa: eles
//  entram na quantidade de todo item de todo container daquele
//  servidor (BetterLoot.cs:1532, :2815, :2972, :2585).
//
//  O que este bloco guarda:
//
//    1. o merge PRESERVA `Watched Container Prefabs`. É o defeito
//       que só apareceria no jogo: montar o arquivo do zero
//       devolveria as 111 caixas vigiadas, incluindo as que o admin
//       tinha desligado de propósito;
//    2. a grafia `Scrap Multipler` (sem o "i") é a DO PLUGIN, e
//       consertá-la gravaria uma chave que ele não lê;
//    3. 1,5 é recusado — o campo é `int` no plugin;
//    4. zero é recusado — ele zeraria o loot do servidor inteiro;
//    5. a revisão velha é recusada, e sem gravar metade.
// ============================================================
describe('os globais', () => {
  /** Uma configuração com o dicionário de prefabs vigiados. */
  function configWithWatched(): unknown {
    return {
      'Chat Configuration': { 'Chat Message Prefix': '[BetterLoot]' },
      'General Configuration': {
        'Blueprint Weight (0.0 = min bias, 1.0 = max bias, 0.5 = balanced)': 0.11,
        'Watched Container Prefabs (true = monitor container loot, false = disabled)': {
          [ELITE]: true,
          // Desligada de propósito pelo admin — é o que um arquivo
          // montado do zero devolveria ligada.
          [SPACED_PREFAB]: false,
        },
      },
      'Loot Configuration': {
        'Loot Multiplier': 1,
        'Scrap Multipler': 1,
        'Allow duplicate items': true,
        'Enable Blueprint Conversion': true,
        'Enable Loot Pool Locking System': true,
      },
    };
  }

  async function seedWithWatched(): Promise<void> {
    await seedFiles();
    await writeFile(
      join(harness.configDir, 'BetterLoot.json'),
      JSON.stringify(configWithWatched(), null, 2),
      'utf8',
    );
  }

  /** A revisão do `BetterLoot.json`, como a tela a lê. */
  async function configRevision(): Promise<string | null> {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot` })
    ).json();

    return body.configRevision;
  }

  it('grava, preserva os prefabs vigiados e recarrega', async () => {
    await seedWithWatched();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/globals`,
      payload: {
        baseRevision: await configRevision(),
        globals: {
          lootMultiplier: 5,
          scrapMultiplier: 2,
          blueprintWeight: 0.2,
          blueprintConversion: true,
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.globals.lootMultiplier).toBe(5);
    expect(body.globals.scrapMultiplier).toBe(2);
    expect(body.reloaded).toBe(true);

    const disk = JSON.parse(await readFile(join(harness.configDir, 'BetterLoot.json'), 'utf8'));

    // A grafia é a do plugin. Consertá-la gravaria uma chave que
    // ele não lê, e o multiplicador de scrap voltaria a 1.
    expect(disk['Loot Configuration']['Scrap Multipler']).toBe(2);
    expect(disk['Loot Configuration']['Loot Multiplier']).toBe(5);

    // ####  O QUE A TELA NÃO EDITA SOBREVIVEU  ####
    const watched =
      disk['General Configuration'][
        'Watched Container Prefabs (true = monitor container loot, false = disabled)'
      ];

    expect(watched[ELITE]).toBe(true);
    expect(watched[SPACED_PREFAB]).toBe(false);
    expect(disk['Chat Configuration']['Chat Message Prefix']).toBe('[BetterLoot]');
    // E o que a tela não pediu para mudar também.
    expect(disk['Loot Configuration']['Enable Loot Pool Locking System']).toBe(true);

    // O backup é o que torna reversível um multiplicador errado.
    expect(existsSync(String(body.backup))).toBe(true);

    const backup = JSON.parse(await readFile(String(body.backup), 'utf8'));

    expect(backup['Loot Configuration']['Loot Multiplier']).toBe(1);
  });

  it('recusa 1,5 — o campo é inteiro no plugin', async () => {
    await seedWithWatched();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/globals`,
      payload: {
        baseRevision: await configRevision(),
        globals: {
          lootMultiplier: 1.5,
          scrapMultiplier: 1,
          blueprintWeight: 0.11,
          blueprintConversion: true,
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('recusa zero — ele zeraria o loot do servidor inteiro', async () => {
    await seedWithWatched();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/globals`,
      payload: {
        baseRevision: await configRevision(),
        globals: {
          lootMultiplier: 0,
          scrapMultiplier: 1,
          blueprintWeight: 0.11,
          blueprintConversion: true,
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('recusa quem abriu antes de outra pessoa gravar, e não grava metade', async () => {
    await seedWithWatched();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/globals`,
      payload: {
        baseRevision: 'a-revisao-de-outra-tela',
        globals: {
          lootMultiplier: 9,
          scrapMultiplier: 9,
          blueprintWeight: 0.9,
          blueprintConversion: false,
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BETTERLOOT_STALE_REVISION');

    const disk = JSON.parse(await readFile(join(harness.configDir, 'BetterLoot.json'), 'utf8'));

    expect(disk['Loot Configuration']['Loot Multiplier']).toBe(1);
  });

  it('a revisão dos globais é OUTRA que a da tabela', async () => {
    await seedWithWatched();

    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot` })
    ).json();

    // Uma revisão só faria gravar o multiplicador recusar o próximo
    // salvamento de caixa: recarregar o plugin reescreve o
    // LootTables.json sozinho.
    expect(body.configRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(body.configRevision).not.toBe(body.revision);
  });

  it('nasce parcial quando o plugin nunca criou a configuração', async () => {
    // O `MaybeUpdateConfigDict` completa o resto no próximo load
    // (Docs/CustomItem/06 §2.2). Recusar aqui obrigaria a subir o
    // servidor uma vez só para poder dizer "2x" antes do boot.
    await seedFiles();
    await rm(join(harness.configDir, 'BetterLoot.json'));

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/globals`,
      payload: {
        baseRevision: null,
        globals: {
          lootMultiplier: 3,
          scrapMultiplier: 3,
          blueprintWeight: 0.11,
          blueprintConversion: true,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().backup).toBeNull();

    const disk = JSON.parse(await readFile(join(harness.configDir, 'BetterLoot.json'), 'utf8'));

    expect(disk['Loot Configuration']['Loot Multiplier']).toBe(3);
  });
});

// ============================================================
//  OS PERFIS — o `LootGroups.json`
//
//  O que este bloco guarda:
//
//    1. o arquivo AUSENTE responde lista vazia, e criar o primeiro
//       perfil funciona. Um servidor sem perfil nenhum é normal;
//    2. a lista diz EM QUAIS CAIXAS cada perfil está — é o que a
//       tela precisa para perguntar antes de apagar, e é o que o
//       Looty não faz;
//    3. apagar um perfil em uso é RECUSADO sem `detach`, e com ele
//       a associação sai das caixas junto. Sem isso, o BetterLoot
//       ignora a caixa e o ajuste se perde em silêncio;
//    4. `Item Properties` sobrevive aqui também: a tela não edita
//       esse bloco nem dentro de um perfil.
// ============================================================

describe('os perfis de loot', () => {
  beforeEach(async () => {
    await seedFiles();
    await seedGroups();
  });

  it('lista os perfis com a soma das probabilidades', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/profiles` })
    ).json();

    expect(body.count).toBe(1);
    expect(body.profiles[0].name).toBe('armas_t3');
    expect(body.profiles[0].itemCount).toBe(2);

    // 60 + 40. Diferente de 100, o plugin rebalanceia sozinho no
    // próximo load — e a tela tem de avisar antes disso.
    expect(body.profiles[0].probabilitySum).toBe(100);
  });

  it('abre um perfil com o peso de cada item', async () => {
    const body = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/profile?name=armas_t3`,
      })
    ).json();

    const ak = body.profile.items.find((item: { key: string }) => item.key === 'rifle.ak');

    expect(ak.probability).toBe(60);
    expect(ak.min).toBe(1);

    // O nome do catálogo atravessa aqui também: ele não está no
    // arquivo, e sem ele a tela mostra shortname cru.
    expect(ak.displayName).toBe('Assault Rifle');
  });

  it('cria um perfil num servidor que ainda não tem o arquivo', async () => {
    await rm(join(harness.dataDir, 'BetterLoot', 'LootGroups.json'));

    const empty = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/profiles` })
    ).json();

    // Arquivo ausente é lista vazia, e não erro.
    expect(empty.configured).toBe(false);
    expect(empty.count).toBe(0);

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/profile`,
      payload: {
        baseRevision: null,
        profile: {
          name: 'medicos',
          enabled: true,
          guaranteed: [],
          items: [
            {
              key: 'sticks',
              shortname: 'sticks',
              displayName: null,
              skinId: '0',
              customName: null,
              min: 1,
              max: 2,
              allowDuplicates: true,
              canConvertToBlueprint: null,
              durability: null,
              rarity: null,
              bonusItems: [],
              hasWeaponProperties: false,
              probability: 100,
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootGroups.json'), 'utf8'),
    );

    expect(disk['Loot Groups'].medicos['Item List'].sticks['Item Probability (1-100)']).toBe(100);
    expect(disk['Loot Groups'].medicos['Item List'].sticks['Item Amount']['Item Maximum']).toBe(2);
  });

  it('recusa criar um perfil com nome que já existe', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/profile`,
      payload: {
        baseRevision: null,
        profile: { name: 'armas_t3', enabled: true, guaranteed: [], items: [] },
      },
    });

    // Dois admins criando "armas_t3" ao mesmo tempo não podem virar
    // um sobrescrevendo o trabalho do outro sem aviso.
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BETTERLOOT_PROFILE_EXISTS');
  });

  it('preserva Item Properties ao gravar', async () => {
    const opened = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/profile?name=armas_t3`,
      })
    ).json();

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/profile`,
      payload: {
        baseRevision: opened.revision,
        profile: {
          ...opened.profile,
          items: opened.profile.items.map((item: { key: string }) =>
            item.key === 'rifle.ak' ? { ...item, min: 2, max: 3 } : item,
          ),
        },
      },
    });

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootGroups.json'), 'utf8'),
    );

    const amount = disk['Loot Groups'].armas_t3['Item List']['rifle.ak']['Item Amount'];

    expect(amount['Item Minimum']).toBe(2);

    // ####  E A MUNIÇÃO CONTINUA LÁ  ####
    //
    // A tela não edita este bloco. Montar a entrada do zero o
    // apagaria — sem erro, e só percebido no jogo.
    expect(amount['Item Properties']['Ammunition Settings']['Ammo Item Shortname']).toBe(
      'ammo.rifle',
    );
  });
});

describe('apagar um perfil em uso', () => {
  beforeEach(async () => {
    await seedFiles();
    await seedGroups();

    // A caixa de elite passa a pedir o perfil — é a associação que
    // mora no OUTRO arquivo.
    const opened = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        baseRevision: opened.tableRevision,
        table: {
          ...opened.table,
          profiles: [{ name: 'armas_t3', enabled: true, probability: 30, maxItems: 0 }],
        },
      },
    });
  });

  it('a lista diz em quais caixas ele está', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/profiles` })
    ).json();

    expect(body.profiles[0].usedBy).toEqual([ELITE]);
  });

  it('recusa apagar sem autorização, e diz quais caixas perderiam o ajuste', async () => {
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/servers/${SERVER}/betterloot/profile?name=armas_t3`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BETTERLOOT_PROFILE_IN_USE');

    // A mensagem nomeia a caixa: "está em uso" sozinho manda o
    // admin procurar em 111 prefabs.
    expect(response.json().message).toContain('crate_elite');

    // E nada foi apagado.
    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootGroups.json'), 'utf8'),
    );

    expect(disk['Loot Groups'].armas_t3).toBeDefined();
  });

  it('com detach, tira a associação das caixas junto', async () => {
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/servers/${SERVER}/betterloot/profile?name=armas_t3`,
      payload: { detach: true },
    });

    expect(response.statusCode).toBe(200);

    // A tela precisa dizer quantas caixas mudaram: o admin
    // autorizou um apagamento, e não uma edição que ele não viu.
    expect(response.json().detached).toEqual([ELITE]);

    const groups = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootGroups.json'), 'utf8'),
    );

    expect(groups['Loot Groups'].armas_t3).toBeUndefined();

    // ####  E A CAIXA NÃO FICOU PEDINDO O QUE NÃO EXISTE  ####
    //
    // O BetterLoot ignora o import órfão e resmunga no log; o admin
    // só descobriria abrindo a caixa.
    const tables = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    expect(tables.LootTables[ELITE]['Loot Profiles']).toEqual([]);
  });
});

// ============================================================
//  O LIXO — a lista de curadoria
//
//  ####  ELA NÃO É DO PLUGIN, E É POR ISSO QUE ELA É NOSSA  ####
//
//  `grep -i junk` no BetterLoot.cs v4.4.0 dá zero. A lista mora no
//  banco e o que chega ao servidor é a caixa já sem esses itens.
//
//  O que este bloco guarda:
//
//    1. os 31 padrões vêm de graça, sem ninguém semear nada;
//    2. desligar um PADRÃO não o apaga — ele volta desligado, para
//       poder ser religado. Apagar a linha o traria de volta ligado
//       na leitura seguinte, que é o contrário do que o admin pediu;
//    3. o que o admin acrescenta some de vez quando ele tira;
//    4. e a lista é POR SERVIDOR: o PvP e o PvE discordam sobre o
//       que é lixo.
// ============================================================

describe('a lista de lixo', () => {
  it('nasce com os 31 padrões, sem semear linha nenhuma', async () => {
    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/junk` })
    ).json();

    expect(body.count).toBe(DEFAULT_JUNK_SHORTNAMES.length);
    expect(body.items.every((item: { isDefault: boolean }) => item.isDefault)).toBe(true);

    // E o banco continua vazio: o padrão mora no código, e é por
    // isso que um item novo na lista chega a todo servidor já
    // cadastrado.
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM betterloot_junk').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('acrescenta um item e o tira de vez', async () => {
    await harness.app.inject({
      method: 'POST',
      url: `/servers/${SERVER}/betterloot/junk`,
      payload: { shortname: 'sticks' },
    });

    const added = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/junk` })
    ).json();

    const sticks = added.items.find((item: { shortname: string }) => item.shortname === 'sticks');

    expect(sticks).toEqual({ shortname: 'sticks', isDefault: false, active: true });

    await harness.app.inject({
      method: 'DELETE',
      url: `/servers/${SERVER}/betterloot/junk?shortname=sticks`,
    });

    const removed = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/junk` })
    ).json();

    expect(
      removed.items.some((item: { shortname: string }) => item.shortname === 'sticks'),
    ).toBe(false);
  });

  it('desligar um padrão o deixa apagado, e não o apaga', async () => {
    await harness.app.inject({
      method: 'DELETE',
      url: `/servers/${SERVER}/betterloot/junk?shortname=rug`,
    });

    const body = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/junk` })
    ).json();

    const rug = body.items.find((item: { shortname: string }) => item.shortname === 'rug');

    // ####  ELE CONTINUA NA LISTA, DESLIGADO  ####
    //
    // Sumir seria o mesmo que voltar: o padrão mora no código, e a
    // leitura seguinte o traria de volta LIGADO — desfazendo em
    // silêncio o que o admin acabou de decidir.
    expect(rug).toEqual({ shortname: 'rug', isDefault: true, active: false });
    expect(body.count).toBe(DEFAULT_JUNK_SHORTNAMES.length - 1);

    // E religar funciona.
    await harness.app.inject({
      method: 'POST',
      url: `/servers/${SERVER}/betterloot/junk`,
      payload: { shortname: 'rug' },
    });

    const back = (
      await harness.app.inject({ method: 'GET', url: `/servers/${SERVER}/betterloot/junk` })
    ).json();

    expect(back.count).toBe(DEFAULT_JUNK_SHORTNAMES.length);
  });

  it('é de um servidor, e não da rede', async () => {
    const junk = new BetterLootJunkRepository(harness.db);

    junk.add('server01', 'sticks', Date.now());

    expect(junk.activeOf('server02')).not.toContain('sticks');
  });
});

// ============================================================
//  OS GARANTIDOS — o que sai sem sorteio
//
//  A tela mostrava esta lista e não a editava, nos dois arquivos.
//  Estes testes guardam que ela agora atravessa: o que a tela manda
//  chega ao disco, e o que ela tira some de lá.
// ============================================================

describe('os itens garantidos', () => {
  beforeEach(async () => {
    await seedFiles();
    await seedGroups();
  });

  it('acrescenta e tira um garantido de uma caixa', async () => {
    const opened = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    // O seed tem um: `scrap`, 10 a 25.
    expect(opened.table.guaranteed).toHaveLength(1);

    const put = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        baseRevision: opened.tableRevision,
        table: {
          ...opened.table,
          guaranteed: [
            ...opened.table.guaranteed,
            {
              key: 'sticks',
              shortname: 'sticks',
              displayName: null,
              skinId: '0',
              customName: null,
              min: 2,
              max: 4,
            },
          ],
        },
      },
    });

    expect(put.statusCode).toBe(200);

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    const guaranteed = disk.LootTables[ELITE]['Guaranteed Items'];

    expect(guaranteed.sticks['Item Minimum']).toBe(2);
    expect(guaranteed.sticks['Item Maximum']).toBe(4);
    // E o que já estava lá continua.
    expect(guaranteed.scrap['Item Minimum']).toBe(10);

    // Agora o caminho de volta: tirar o `scrap` some do arquivo.
    const after = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        baseRevision: after.tableRevision,
        table: {
          ...after.table,
          guaranteed: after.table.guaranteed.filter(
            (entry: { key: string }) => entry.key !== 'scrap',
          ),
        },
      },
    });

    const final = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootTables.json'), 'utf8'),
    );

    expect(final.LootTables[ELITE]['Guaranteed Items'].scrap).toBeUndefined();
    expect(final.LootTables[ELITE]['Guaranteed Items'].sticks).toBeDefined();
  });

  it('acrescenta um garantido dentro de um perfil', async () => {
    const opened = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/profile?name=armas_t3`,
      })
    ).json();

    expect(opened.profile.guaranteed).toEqual([]);

    const put = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/profile`,
      payload: {
        baseRevision: opened.revision,
        profile: {
          ...opened.profile,
          guaranteed: [
            {
              key: 'sticks',
              shortname: 'sticks',
              displayName: null,
              skinId: '0',
              customName: null,
              min: 1,
              max: 3,
            },
          ],
        },
      },
    });

    expect(put.statusCode).toBe(200);

    const disk = JSON.parse(
      await readFile(join(harness.dataDir, 'BetterLoot', 'LootGroups.json'), 'utf8'),
    );

    // ####  ESTE "SEMPRE" É OUTRO  ####
    //
    // O garantido do PERFIL sai quando o perfil é sorteado pela
    // caixa; o da caixa sai toda vez que ela abre. São dois campos
    // com o mesmo nome em dois arquivos, e confundi-los faria a tela
    // prometer um item que quase nunca aparece.
    expect(disk['Loot Groups'].armas_t3['Guaranteed Items'].sticks['Item Maximum']).toBe(3);
  });

  it('recusa um garantido com mínimo maior que o máximo', async () => {
    const opened = (
      await harness.app.inject({
        method: 'GET',
        url: `/servers/${SERVER}/betterloot/table?prefab=${encodeURIComponent(ELITE)}`,
      })
    ).json();

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/servers/${SERVER}/betterloot/table`,
      payload: {
        baseRevision: opened.tableRevision,
        table: {
          ...opened.table,
          guaranteed: [{ ...opened.table.guaranteed[0], min: 9, max: 2 }],
        },
      },
    });

    // Com os dois trocados o BetterLoot entrega sempre o mínimo, e
    // nada reclama: a tela mostraria "9 a 2" e o admin acharia que
    // pediu isso.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('BETTERLOOT_INVALID_RANGE');
  });
});
