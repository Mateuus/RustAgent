// ============================================================
//  betterloot-rebuild.test.ts  -  refazer a base pelo próprio
//  plugin.
//
//  ####  O QUE ESTE ARQUIVO GUARDA  ####
//
//    1. a base nova vem do PLUGIN, e o que era da casa volta por
//       cima dela: caixa que alguém deixou só com perfis recupera
//       a lista de itens do jogo SEM perder os perfis;
//    2. o item da casa (`trophy{1}`, a chave com sufixo)
//       sobrevive, e a quantidade editada de um item DO JOGO não —
//       que é a decisão do dono, e a que mais surpreende;
//    3. rodar duas vezes seguidas dá o mesmo arquivo. É o
//       "repetir a importação sem duplicar" do pedido, e a única
//       forma de conferi-lo é rodando duas vezes;
//    4. a adoção mexe nos DOIS interruptores, e preserva as outras
//       chaves do `BetterLoot.json`;
//    5. plugin que não gera a base devolve o arquivo anterior ao
//       lugar e responde 503 — este é o teste que impede a
//       operação de zerar o loot de um servidor por acidente;
//    6. e a palavra de confirmação é conferida ANTES de tocar em
//       disco.
//
//  ####  O PLUGIN DE MENTIRA IMITA O DE VERDADE  ####
//
//  O BetterLoot só lê a tabela nativa quando NÃO encontra o
//  arquivo ao carregar (`LoadAllContainers`); com ele no lugar,
//  apenas o reescreve ao validar (`:780`). O `fakePlugin` abaixo
//  faz as duas coisas — sem essa diferença, o teste não
//  distinguiria "gerou a base" de "não fez nada".
// ============================================================

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { BetterLootJunkRepository } from '../src/db/betterloot-junk-repository.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerBetterLootRoutes } from '../src/http/routes/betterloot.js';
import { BetterLootEditor } from '../src/oxide/betterloot.js';

const SERVER = 'server01';
const ELITE = 'assets/bundled/prefabs/radtown/crate_elite.prefab';
const MILITARY = 'assets/bundled/prefabs/radtown/crate_normal.prefab';
/** O prefab que só existe no jogo de agora: o plugin o gera, e o disco não o tinha. */
const BARREL = 'assets/bundled/prefabs/autospawn/resource/loot/loot-barrel-1.prefab';
/**
 * O corpo de cientista — o prefab que o plugin SÓ gera se estiver
 * vigiado.
 *
 * `LoadAllContainers` pula a geração de NPC cujo prefab está na
 * lista como `false` (BetterLoot.cs:1934-1941), e só a de NPC. É a
 * diferença entre a caixa ser refeita e a entrada dela sumir.
 */
const NPC = 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_roam.prefab';

interface Harness {
  readonly db: AgentDatabase;
  readonly app: FastifyInstance;
  readonly dataDir: string;
  readonly configDir: string;
  readonly backupsDir: string;
  readonly reloads: string[];
  /** `false` = o plugin não faz nada ao recarregar (não compilou, servidor caiu). */
  generates: boolean;
  /** `false` = o `oxide.reload` não chegou a sair (servidor parado). */
  sent: boolean;
}

let harness: Harness;

function tablesPath(): string {
  return join(harness.dataDir, 'BetterLoot', 'LootTables.json');
}

function groupsPath(): string {
  return join(harness.dataDir, 'BetterLoot', 'LootGroups.json');
}

function configPath(): string {
  return join(harness.configDir, 'BetterLoot.json');
}

/** Uma entrada de item como o plugin a escreve. */
function entry(min: number, max: number, patch: Record<string, unknown> = {}): unknown {
  return {
    'Allow Duplicates': true,
    'Skin ID (0 = default)': 0,
    'Display Name (empty = none)': '',
    'Item Minimum': min,
    'Item Maximum': max,
    ...patch,
  };
}

/**
 * A base que o PLUGIN gera do jogo.
 *
 * Três caixas: a elite (com dois itens do jogo), a militar (com um)
 * e o barril, que a configuração do disco não tem — é o prefab que
 * entrou num update, e o caso que deixa caixa presa em "JOGO".
 */
function baseline(npcWatched: boolean): unknown {
  return {
    LootTables: {
      ...(npcWatched
        ? {
            [NPC]: {
              'Item Settings': { 'Minimum Amount of Items': 6, 'Maximum Amount of Items': 6 },
              'Loot Profiles': [],
              'Ungrouped Items': { 'syringe.medical': entry(1, 2) },
              'Guaranteed Items': {},
              'Is Prefab Enabled?': true,
              'Enable Loot Pool Locking': false,
              'Select ungrouped items ignoring rarity bias': false,
            },
          }
        : {}),
      [ELITE]: {
        'Item Settings': {
          'Minimum Amount of Items': 8,
          'Maximum Amount of Items': 8,
          'Minimum Scrap Amount': 25,
          'Maximum Scrap Amount': 25,
          'Minimum Blueprints': 0,
          'Maximum Blueprints': 1,
          'Bonus Items Contribute to Item Count': false,
          'Guaranteed Items Contribute to Item Count': true,
        },
        'Loot Profiles': [],
        'Ungrouped Items': { 'rifle.ak': entry(1, 1), 'metal.refined': entry(2, 8) },
        'Guaranteed Items': {},
        'Is Prefab Enabled?': true,
        'Enable Loot Pool Locking': false,
        'Select ungrouped items ignoring rarity bias': false,
      },
      [MILITARY]: {
        'Item Settings': { 'Minimum Amount of Items': 6, 'Maximum Amount of Items': 6 },
        'Loot Profiles': [],
        'Ungrouped Items': { scrap: entry(10, 20) },
        'Guaranteed Items': {},
        'Is Prefab Enabled?': true,
        'Enable Loot Pool Locking': false,
        'Select ungrouped items ignoring rarity bias': false,
      },
      [BARREL]: {
        'Item Settings': { 'Minimum Amount of Items': 1, 'Maximum Amount of Items': 1 },
        'Loot Profiles': [],
        'Ungrouped Items': { sticks: entry(1, 3) },
        'Guaranteed Items': {},
        'Is Prefab Enabled?': true,
        'Enable Loot Pool Locking': false,
        'Select ungrouped items ignoring rarity bias': false,
      },
    },
  };
}

/**
 * O que está no disco HOJE — a configuração estropiada do pedido.
 *
 * A elite tem um item do jogo com quantidade mexida, um item DA
 * CASA e dois perfis ligados (um deles órfão). A militar é o caso
 * do print: nenhum item, só perfis. O barril não existe.
 */
function current(): unknown {
  return {
    LootTables: {
      [ELITE]: {
        'Item Settings': {
          'Minimum Amount of Items': 2,
          'Maximum Amount of Items': 2,
          'Minimum Scrap Amount': 6,
          'Maximum Scrap Amount': 10,
        },
        'Loot Profiles': [
          {
            'Loot Profile Name': 'Bleik',
            'Group Enabled?': true,
            'Loot Profile Probability (1% - 100%)': 70,
            'Max Items From Profile (0 = unlimited)': 0,
          },
          {
            'Loot Profile Name': 'GUNS T2',
            'Group Enabled?': false,
            'Loot Profile Probability (1% - 100%)': 9,
            'Max Items From Profile (0 = unlimited)': 1,
          },
        ],
        'Ungrouped Items': {
          // Item do jogo com a quantidade mexida: ele VOLTA ao do
          // jogo, e é a decisão que mais surpreende.
          'rifle.ak': entry(5, 10),
          // Item da casa: a chave com sufixo não existe no jogo, e
          // é o Troféu Bleik Store dos prints.
          'trophy{1}': entry(1, 1, {
            'Skin ID (0 = default)': 3403269092,
            'Display Name (empty = none)': 'Troféu Bleik Store',
          }),
        },
        'Guaranteed Items': { 'xmas.present.small': entry(1, 1) },
        'Is Prefab Enabled?': true,
        'Enable Loot Pool Locking': true,
        'Select ungrouped items ignoring rarity bias': true,
      },
      // A caixa do print 3: perfis, e nenhum item.
      [MILITARY]: {
        'Item Settings': {},
        'Loot Profiles': [
          {
            'Loot Profile Name': 'Bleik',
            'Group Enabled?': true,
            'Loot Profile Probability (1% - 100%)': 100,
            'Max Items From Profile (0 = unlimited)': 0,
          },
        ],
        'Ungrouped Items': {},
        'Guaranteed Items': {},
        // E ela está em "JOGO": o plugin a cadastrou desligada.
        'Is Prefab Enabled?': false,
      },
      // O corpo de cientista, desligado e com item da casa dentro.
      [NPC]: {
        'Item Settings': {},
        'Loot Profiles': [],
        'Ungrouped Items': { 'trophy{2}': entry(1, 1, { 'Skin ID (0 = default)': 42 }) },
        'Guaranteed Items': {},
        'Is Prefab Enabled?': false,
      },
      // Prefab que saiu do jogo. O plugin não o gera de novo, e o
      // `CheckWatchedPrefabs` já o tirou da lista de vigia.
      'assets/bundled/prefabs/radtown/crate_extinto.prefab': {
        'Ungrouped Items': { scrap: entry(1, 1) },
        'Is Prefab Enabled?': true,
      },
    },
  };
}

/** Os perfis que existem. "GUNS T2" NÃO está aqui — é o órfão. */
function lootGroups(): unknown {
  return {
    'Loot Groups': {
      Bleik: {
        'Enabled?': true,
        'Guaranteed Items': {},
        'Item List': {
          trophy: { 'Item Probability (1-100)': 100, 'Item Amount': entry(1, 1) },
        },
      },
    },
  };
}

function betterLootConfig(): unknown {
  return {
    'General Configuration': {
      'Blueprint Weight (0.0 = min bias, 1.0 = max bias, 0.5 = balanced)': 0.11,
      'Watched Container Prefabs (true = monitor container loot, false = disabled)': {
        [ELITE]: true,
        [MILITARY]: false,
        // O NPC está na lista e desligado — é o estado que o
        // `CheckWatchedPrefabs` cria para tudo que entra depois da
        // instalação. O `crate_extinto` NÃO está: o plugin já o
        // tirou daqui, e é isso que o separa do NPC.
        [NPC]: false,
      },
    },
    'Loot Configuration': {
      'Loot Multiplier': 2,
      'Scrap Multipler': 5,
      'Allow duplicate items': true,
      'Enable Blueprint Conversion': true,
      'Enable Loot Pool Locking System': true,
    },
  };
}

/**
 * O que o BetterLoot faz ao receber o `oxide.reload`.
 *
 * Arquivo ausente: ele o GERA do jogo. Arquivo presente: ele o
 * reescreve como está, que é o `:780` — não condicional, e a
 * origem da corrida que o `waitForRewrite` resolve.
 */
async function fakePlugin(): Promise<void> {
  if (!harness.generates) {
    return;
  }

  if (!existsSync(tablesPath())) {
    // E ele olha a lista de vigia antes de gerar o NPC, como o de
    // verdade. Sem isso o teste não distinguiria "adotou e gerou"
    // de "não gerou e preservou".
    const config = JSON.parse(await readFile(configPath(), 'utf8')) as Record<
      string,
      Record<string, Record<string, boolean>>
    >;
    const watched =
      config['General Configuration'][
        'Watched Container Prefabs (true = monitor container loot, false = disabled)'
      ];

    await writeFile(
      tablesPath(),
      JSON.stringify(baseline(watched[NPC] === true), null, 2),
      'utf8',
    );
  }

  if (!existsSync(groupsPath())) {
    // O plugin cria o arquivo de perfis com o exemplo dele, e
    // DESLIGADO. É o estado de instalação.
    await writeFile(
      groupsPath(),
      JSON.stringify(
        { 'Loot Groups': { example_group: { 'Enabled?': false, 'Item List': {} } } },
        null,
        2,
      ),
      'utf8',
    );
  }
}

async function readTables(): Promise<Record<string, Record<string, unknown>>> {
  const raw: unknown = JSON.parse(await readFile(tablesPath(), 'utf8'));

  return (raw as { LootTables: Record<string, Record<string, unknown>> }).LootTables;
}

async function rebuild(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/servers/${SERVER}/betterloot/rebuild`,
    payload: body,
  });

  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const items = new ItemsRepository(db);

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
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });

  const root = await mkdtemp(join(tmpdir(), 'rustagent-rebuild-'));
  const dataDir = join(root, 'oxide', 'data');
  const configDir = join(root, 'oxide', 'config');
  const backupsDir = join(root, 'backups');

  await mkdir(join(dataDir, 'BetterLoot'), { recursive: true });
  await mkdir(configDir, { recursive: true });

  const reloads: string[] = [];

  const servers = {
    configOf: (id: string) =>
      id === SERVER
        ? { paths: { oxideConfigDir: configDir, oxideDataDir: dataDir, backupsDir } }
        : null,
    contextOf: () => null,
  };

  const editor = new BetterLootEditor({
    servers,
    items,
    reload: async (serverId) => {
      reloads.push(serverId);

      if (!harness.sent) {
        return { sent: false, output: null };
      }

      await fakePlugin();

      return { sent: true, output: 'Reloaded plugin BetterLoot v4.4.0' };
    },
    // Os tempos de produção em escala de teste. A `graceMs` é a
    // paciência até o arquivo NASCER: o teste do plugin que não
    // gera espera por ela inteira, e por isso ela é curta aqui.
    rewriteWait: { pollMs: 5, quietMs: 15, graceMs: 150, timeoutMs: 1_000 },
  });

  const app = Fastify();

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
    registerBetterLootRoutes(api, {
      editor,
      junk: new BetterLootJunkRepository(db),
      servers,
    });
  });

  await app.ready();

  db.prepare(
    `INSERT INTO servers
       (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
        install_dir, created_at, updated_at)
     VALUES (@id, @id, @id, 1, 28015, 28016, 28017, 28018, @dir, @now, @now)`,
  ).run({ id: SERVER, dir: dataDir, now: Date.now() });

  harness = {
    db,
    app,
    dataDir,
    configDir,
    backupsDir,
    reloads,
    generates: true,
    sent: true,
  };

  await writeFile(tablesPath(), JSON.stringify(current(), null, 2), 'utf8');
  await writeFile(groupsPath(), JSON.stringify(lootGroups(), null, 2), 'utf8');
  await writeFile(configPath(), JSON.stringify(betterLootConfig(), null, 2), 'utf8');
});

describe('refazer a base (merge)', () => {
  it('traz a lista do jogo de volta e preserva o que é da casa', async () => {
    const { status, body } = await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    expect(status).toBe(200);

    const tables = await readTables();
    const elite = tables[ELITE];
    const ungrouped = elite['Ungrouped Items'] as Record<string, Record<string, number>>;

    // A lista do jogo voltou inteira...
    expect(Object.keys(ungrouped).sort()).toEqual(['metal.refined', 'rifle.ak', 'trophy{1}']);
    // ...o item da casa continua lá, com a skin dele...
    expect(ungrouped['trophy{1}']['Skin ID (0 = default)']).toBe(3403269092);
    // ...e a quantidade mexida de um item DO JOGO voltou ao do jogo.
    expect(ungrouped['rifle.ak']['Item Maximum']).toBe(1);

    // O garantido da casa também sobrevive: ele não está em
    // nenhuma das duas listas do jogo.
    expect(Object.keys(elite['Guaranteed Items'] as object)).toEqual(['xmas.present.small']);

    const report = body.report as Record<string, unknown>;

    // Quatro caixas: as três do jogo mais o corpo de cientista,
    // que só entra porque a adoção o pôs na vigia ANTES de gerar.
    expect(report.tables).toBe(4);
    // `trophy{1}` e o garantido da elite, e o `trophy{2}` do NPC.
    expect(report.keptItems).toBe(3);
  });

  it('adotar antes de gerar é o que traz o corpo de cientista de volta', async () => {
    await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    const npc = (await readTables())[NPC];
    const items = npc['Ungrouped Items'] as Record<string, unknown>;

    // O plugin só gera NPC que está vigiado. Adotar depois de
    // gerar deixaria esta caixa sem a lista do jogo — que é
    // exatamente o defeito que este botão existe para consertar.
    expect(Object.keys(items).sort()).toEqual(['syringe.medical', 'trophy{2}']);
  });

  it('mantém os perfis ligados à caixa, com chance e teto', async () => {
    await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    const tables = await readTables();
    const links = tables[ELITE]['Loot Profiles'] as Record<string, unknown>[];

    expect(links).toHaveLength(2);
    expect(links[0]['Loot Profile Name']).toBe('Bleik');
    expect(links[0]['Loot Profile Probability (1% - 100%)']).toBe(70);
    expect(links[1]['Max Items From Profile (0 = unlimited)']).toBe(1);

    // E a caixa que SÓ tinha perfis ganhou a lista de itens sem
    // perder o perfil — é o print 3 do pedido.
    const military = tables[MILITARY];

    expect(Object.keys(military['Ungrouped Items'] as object)).toEqual(['scrap']);
    expect(military['Loot Profiles']).toHaveLength(1);
  });

  it('denuncia o perfil que a caixa cita e que não existe', async () => {
    const { body } = await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });
    const report = body.report as Record<string, unknown>;

    expect(report.orphanProfiles).toEqual(['GUNS T2']);
  });

  it('adota as caixas nos DOIS interruptores, e preserva o resto da config', async () => {
    const { body } = await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    const tables = await readTables();

    expect(tables[MILITARY]['Is Prefab Enabled?']).toBe(true);

    const config = JSON.parse(await readFile(configPath(), 'utf8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const watched =
      config['General Configuration'][
        'Watched Container Prefabs (true = monitor container loot, false = disabled)'
      ];

    expect(watched[MILITARY]).toBe(true);
    expect(watched[BARREL]).toBe(true);

    // O que o rebuild não edita continua lá: o multiplicador do
    // servidor é a chave que dói perder.
    expect(config['Loot Configuration']['Loot Multiplier']).toBe(2);
    // Duas antes de gerar (a militar e o NPC) e o barril depois,
    // que o plugin acrescentou à lista ao carregar.
    expect(body.watchedAdded).toBe(3);

    const report = body.report as Record<string, string[]>;

    expect(report.adopted.sort()).toEqual([MILITARY, NPC].sort());
    expect(report.fresh).toEqual([BARREL]);
    // O prefab que saiu do jogo não entra na base nova, e o
    // relatório diz o nome dele.
    expect(report.dropped).toEqual(['assets/bundled/prefabs/radtown/crate_extinto.prefab']);
  });

  it('preserva o travamento de pool e o "ignorar raridade" da caixa', async () => {
    await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    const tables = await readTables();

    expect(tables[ELITE]['Enable Loot Pool Locking']).toBe(true);
    expect(tables[ELITE]['Select ungrouped items ignoring rarity bias']).toBe(true);
  });

  it('repetido, dá exatamente o mesmo arquivo', async () => {
    await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    const first = await readFile(tablesPath(), 'utf8');

    await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    const second = await readFile(tablesPath(), 'utf8');

    expect(second).toBe(first);
  });

  it('copia os três arquivos antes de tocar em qualquer um', async () => {
    const { body } = await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });
    const backups = body.backups as string[];

    expect(backups).toHaveLength(3);

    const copied = JSON.parse(
      await readFile(
        backups.find((path) => path.includes('LootTables')) ?? '',
        'utf8',
      ),
    ) as { LootTables: Record<string, unknown> };

    // A cópia é do que estava lá ANTES — inclusive o prefab que a
    // base nova não tem mais.
    expect(
      Object.keys(copied.LootTables).includes(
        'assets/bundled/prefabs/radtown/crate_extinto.prefab',
      ),
    ).toBe(true);
  });

  it('o que o plugin não gerou fica como estava, e o extinto não', async () => {
    const { body } = await rebuild({ mode: 'merge', adopt: false, confirm: 'REFAZER' });
    const report = body.report as Record<string, string[]>;
    const tables = await readTables();

    // O NPC continua na lista de vigia: o jogo o tem, o plugin é
    // que não o gerou porque ele está desligado. A entrada dele
    // sobrevive inteira.
    expect(report.preserved).toEqual([NPC]);
    expect(Object.keys(tables[NPC]['Ungrouped Items'] as object)).toEqual(['trophy{2}']);

    // O extinto saiu da lista de vigia, e some. Ele continua no
    // backup, que é o único lugar onde ainda faz sentido.
    expect(report.dropped).toEqual(['assets/bundled/prefabs/radtown/crate_extinto.prefab']);
    expect(tables['assets/bundled/prefabs/radtown/crate_extinto.prefab']).toBeUndefined();
  });

  it('sem adotar, a caixa em "JOGO" continua em "JOGO"', async () => {
    const { body } = await rebuild({ mode: 'merge', adopt: false, confirm: 'REFAZER' });

    const tables = await readTables();

    expect(tables[MILITARY]['Is Prefab Enabled?']).toBe(false);
    expect(body.watchedAdded).toBe(0);

    const config = JSON.parse(await readFile(configPath(), 'utf8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

    expect(
      config['General Configuration'][
        'Watched Container Prefabs (true = monitor container loot, false = disabled)'
      ][MILITARY],
    ).toBe(false);
  });
});

describe('resetar tudo ao padrão do jogo (factory)', () => {
  it('zera as caixas e os perfis, e não devolve nada da casa', async () => {
    const { status } = await rebuild({ mode: 'factory', adopt: true, confirm: 'RESETAR' });

    expect(status).toBe(200);

    const tables = await readTables();

    // Nem o item da casa, nem o vínculo com o perfil.
    expect(Object.keys(tables[ELITE]['Ungrouped Items'] as object).sort()).toEqual([
      'metal.refined',
      'rifle.ak',
    ]);
    expect(tables[ELITE]['Loot Profiles']).toEqual([]);

    const groups = JSON.parse(await readFile(groupsPath(), 'utf8')) as {
      'Loot Groups': Record<string, unknown>;
    };

    // O `Bleik` saiu, e ficou o exemplo que o plugin cria sozinho.
    expect(Object.keys(groups['Loot Groups'])).toEqual(['example_group']);
  });

  it('deixa todas as caixas gerenciáveis pelo painel', async () => {
    await rebuild({ mode: 'factory', adopt: true, confirm: 'RESETAR' });

    const tables = await readTables();

    for (const table of Object.values(tables)) {
      expect(table['Is Prefab Enabled?']).toBe(true);
    }
  });

  it('a palavra do outro modo não serve', async () => {
    const before = await readFile(tablesPath(), 'utf8');
    const { status, body } = await rebuild({
      mode: 'factory',
      adopt: true,
      confirm: 'REFAZER',
    });

    expect(status).toBe(400);
    expect(body.error).toBe('BETTERLOOT_CONFIRM_REQUIRED');
    // E nada foi tocado: nem o arquivo, nem o plugin.
    expect(await readFile(tablesPath(), 'utf8')).toBe(before);
    expect(harness.reloads).toHaveLength(0);
  });
});

// ============================================================
//  O ARQUIVO DE VERDADE, EM ESCALA
//
//  111 prefabs e 6.824 entradas, gerados pelo BetterLoot no
//  `server01`. Ele entra aqui porque as contas deste merge são
//  todas sobre VOLUME — "não duplica", "não perde", "roda duas
//  vezes igual" — e num fixture de três caixas as três passariam
//  por acidente.
//
//  A configuração "estropiada" é derivada dele na hora, com os
//  mesmos três estragos que os prints mostram: caixa esvaziada,
//  item da casa e vínculo com perfil.
//
//  Ausente, o bloco é PULADO: quem clonar o repositório sem os
//  backups não tem por que ver vermelho.
// ============================================================
describe('o merge contra o LootTables.json do server01', () => {
  const real = join(
    process.cwd(),
    '..',
    'Backups',
    'server01',
    'betterloot-config-inicial-2026-09-06_20-21',
    'LootTables.json',
  );

  it.skipIf(!existsSync(real))('não duplica, não perde, e repete igual', async () => {
    const { mergeRebuiltTables, parseLootTables } = await import('../src/oxide/betterloot.js');

    const base = parseLootTables(await readFile(real, 'utf8'), real).tables;
    const prefabs = Object.keys(base);

    expect(prefabs).toHaveLength(111);

    // O estrago: a primeira caixa perde a lista inteira e fica só
    // com um perfil, a segunda ganha um troféu da casa.
    const [first, second] = prefabs as [string, string];
    const broken: Record<string, Record<string, unknown>> = structuredClone(base);

    broken[first]['Ungrouped Items'] = {};
    broken[first]['Loot Profiles'] = [
      {
        'Loot Profile Name': 'Bleik',
        'Group Enabled?': true,
        'Loot Profile Probability (1% - 100%)': 70,
        'Max Items From Profile (0 = unlimited)': 0,
      },
    ];
    (broken[second]['Ungrouped Items'] as Record<string, unknown>)['trophy{1}'] = entry(1, 1, {
      'Skin ID (0 = default)': 3403269092,
    });

    const options = {
      adopt: true,
      profiles: new Set(['Bleik']),
      watched: new Set(prefabs),
    };
    const once = mergeRebuiltTables(broken, base, options);

    // Nenhuma caixa a mais, nenhuma a menos.
    expect(Object.keys(once.tables)).toHaveLength(111);

    // A caixa esvaziada recuperou a lista do jogo, e continua com
    // o perfil.
    expect(Object.keys(once.tables[first]['Ungrouped Items'] as object)).toEqual(
      Object.keys(base[first]['Ungrouped Items'] as object),
    );
    expect(once.tables[first]['Loot Profiles']).toHaveLength(1);

    // O troféu da casa ficou, e é o ÚNICO item a mais na caixa.
    const merged = Object.keys(once.tables[second]['Ungrouped Items'] as object);

    expect(merged).toHaveLength(Object.keys(base[second]['Ungrouped Items'] as object).length + 1);
    expect(merged.filter((key) => key === 'trophy{1}')).toHaveLength(1);
    expect(once.report.keptItems).toBe(1);

    // E a segunda passada não muda mais nada.
    const twice = mergeRebuiltTables(once.tables, base, options);

    expect(JSON.stringify(twice.tables)).toBe(JSON.stringify(once.tables));
  });
});

describe('quando o plugin não gera a base', () => {
  it('devolve os arquivos ao lugar e responde 503', async () => {
    const before = await readFile(tablesPath(), 'utf8');
    const groupsBefore = await readFile(groupsPath(), 'utf8');

    harness.generates = false;

    const { status, body } = await rebuild({ mode: 'factory', adopt: true, confirm: 'RESETAR' });

    expect(status).toBe(503);
    expect(body.error).toBe('BETTERLOOT_REBUILD_FAILED');
    expect(await readFile(tablesPath(), 'utf8')).toBe(before);
    expect(await readFile(groupsPath(), 'utf8')).toBe(groupsBefore);
  });

  it('servidor parado é recusado com a tabela intacta', async () => {
    const before = await readFile(tablesPath(), 'utf8');

    harness.sent = false;

    const { status, body } = await rebuild({ mode: 'merge', adopt: true, confirm: 'REFAZER' });

    expect(status).toBe(503);
    expect(String(body.message)).toContain('no ar');
    expect(await readFile(tablesPath(), 'utf8')).toBe(before);
  });
});
