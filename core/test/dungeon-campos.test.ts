// ============================================================
//  Os campos das quatro frentes, do schema até o comando de RCON.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Um campo de configuração só está pronto quando percorreu cinco
//  degraus: o schema Zod, a coluna, o repositório, o `sync` e a
//  tela. Parar no QUARTO é o pior resultado possível — o admin
//  configura, salva, a tela mostra o valor de volta, e o jogo
//  ignora sem uma linha de aviso.
//
//  Os testes abaixo percorrem os degraus 1 a 4 de uma vez: gravam
//  uma masmorra com TODO campo novo preenchido, leem de volta e
//  conferem que cada um deles atravessou o base64 do comando.
//
//  E medem o payload, porque o teto de 50 KB do WebRCON é real:
//  um estado que estoura não falha alto, ele é RECUSADO e o plugin
//  fica com o cache velho.
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { BlueprintMaterializer } from '../src/dungeons/materializer.js';
import { DungeonSync } from '../src/dungeons/sync.js';
import { DUNGEON_SYNC_MAX_BYTES } from '../src/game/dungeon-contract.js';
import { dungeonInputSchema, FACTORY_RECIPES } from '../src/types/dungeons.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

/**
 * Uma masmorra com TODO campo das quatro frentes fora do padrão.
 *
 * Nenhum valor aqui é o padrão do schema, de propósito: um campo
 * que o repositório esquecer de gravar volta como o padrão, e um
 * teste montado com padrões não notaria a diferença.
 */
const FULL = dungeonInputSchema.parse({
  id: 'completa',
  name: 'A masmorra com tudo',
  mode: 'recipe',
  corridor: {
    npcDensity: 35,
    lootDensity: 15,
    table: {
      mode: 'add',
      rolls: { min: 2, max: 4 },
      entries: [{ shortname: 'scrap', amount: { min: 10, max: 50 }, weight: 40 }],
    },
    ai: { chaseRadius: 12, returnHome: false },
  },
  npc: {
    weapons: ['rifle.ak'],
    loot: {
      mode: 'replace',
      rolls: { min: 1, max: 1 },
      entries: [
        { shortname: 'cloth', amount: { min: 5, max: 5 }, guaranteed: true, condition: 0.5 },
      ],
    },
    ai: { visionRadius: 30, fireRange: 22, alertOnSpot: false, senseInterval: 0.8 },
  },
  structure: { foundation: 'metal', wall: 'toptier', ceiling: 'metal' },
  lock: {
    enabled: true,
    sharedCode: true,
    carrier: 'crate',
    carrierScope: 'anywhere',
    onUndelivered: 'keep',
    noteTitle: 'O papel amassado',
    announceOpen: false,
    warnOnWrongCode: false,
  },
  access: { whoEnters: 'permission', enterPermission: 'origemz.vip.diamante' },
  protection: { enabled: false, allowAdmin: false, warnOnAttempt: false },
  respawn: { enabled: true, minutes: 45, onlyWhenEmpty: false, rebuildDestroyed: false },
  rooms: [
    {
      key: 'red',
      color: 'red',
      npc: { min: 3, max: 5 },
      loot: { min: 2, max: 3 },
      door: 'garage',
      locked: true,
      wideDoor: 'double_toptier',
      wideDoorCellsPerDoor: 6,
      grade: { foundation: 'stone', wall: 'stone', ceiling: 'stone' },
      table: {
        mode: 'replace',
        rolls: { min: 3, max: 3 },
        entries: [
          { shortname: 'rifle.ak', amount: { min: 1, max: 1 }, blueprint: true, skin: 12_345 },
        ],
      },
      ai: { aimConeScale: 0.7, fireInterval: 0.2, holdPosition: true },
    },
  ],
});

interface Captured {
  readonly sync: DungeonSync;
  readonly dungeons: DungeonsRepository;
  /** O último comando que o RCON falso recebeu. */
  readonly sent: string[];
  /**
   * O banco cru.
   *
   * Só para os testes que precisam ESCREVER uma linha torta — o
   * que o repositório, por definição, não deixa fazer. Ver o teste
   * da cor inválida.
   */
  readonly db: AgentDatabase;
}

function harness(): Captured {
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

  const dungeons = new DungeonsRepository(db, silent);
  const events = new WorldEventsRepository(db, silent);
  const sent: string[] = [];

  const sync = new DungeonSync({
    dungeons,
    events,
    servers: {
      ids: () => [SERVER],
      contextOf: () => ({
        rcon: {
          isConnected: true,
          send: async (command: string) => {
            sent.push(command);
            return Promise.resolve('');
          },
        },
      }),
    },
    // `dataDirOf` nulo faz o materializador não escrever nada: o
    // que este teste mede é o COMANDO, não o disco.
    materializer: new BlueprintMaterializer({
      blueprints: new DungeonBlueprintsRepository(db, silent),
      servers: { ids: () => [SERVER], dataDirOf: () => null },
      logger: silent,
    }),
    logger: silent,
  });

  return { sync, dungeons, sent, db };
}

/** O JSON que viajou dentro do `origemz.dungeon.sync <base64>`. */
function decode(command: string): { dungeons: Record<string, unknown>[] } {
  const payload = command.slice(command.indexOf(' ') + 1);

  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
    dungeons: Record<string, unknown>[];
  };
}

describe('os campos das quatro frentes atravessam o banco', () => {
  it('nada se perde entre a escrita e a leitura', () => {
    const { dungeons } = harness();

    const saved = dungeons.save(FULL);

    // A comparação é do objeto inteiro, e não campo a campo: um
    // campo novo que alguém acrescentar ao schema e esquecer no
    // INSERT falha aqui sem ninguém precisar lembrar de testá-lo.
    expect(saved.structure).toEqual(FULL.structure);
    expect(saved.lock).toEqual(FULL.lock);
    expect(saved.access).toEqual(FULL.access);
    expect(saved.protection).toEqual(FULL.protection);
    expect(saved.respawn).toEqual(FULL.respawn);
    expect(saved.corridor).toEqual(FULL.corridor);
    expect(saved.npc).toEqual(FULL.npc);
    expect(saved.rooms).toEqual(FULL.rooms);
  });

  it('o bloco de IA guarda só o que foi dito — ausente não vira zero', () => {
    const { dungeons } = harness();

    const saved = dungeons.save(FULL);
    const room = saved.rooms[0];

    if (room === undefined) throw new Error('a sala sumiu');

    // A sala falou de três campos. Os outros dezesseis NÃO podem
    // voltar como 0: é o que faz a herança campo a campo existir.
    expect(Object.keys(room.ai).sort()).toEqual(['aimConeScale', 'fireInterval', 'holdPosition']);
    expect(room.ai.visionRadius).toBeUndefined();
  });
});

describe('os campos das quatro frentes atravessam o sync', () => {
  it('cada um deles chega ao comando de RCON', async () => {
    const { sync, dungeons, sent } = harness();

    dungeons.save(FULL);

    expect(await sync.push(SERVER, 'teste')).toBe(true);

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    const dungeon = decode(command).dungeons[0];

    if (dungeon === undefined) throw new Error('a masmorra não viajou');

    expect(dungeon.structure).toEqual(FULL.structure);
    expect(dungeon.lock).toEqual(FULL.lock);
    expect(dungeon.respawn).toEqual(FULL.respawn);

    // Quem escolheu fechar a masmorra tem de ver a escolha chegar ao
    // jogo INTEIRA: o modo e o nome da permissão. Um `leanAccess`
    // que cortasse o nome deixaria o plugin cair na permissão dele,
    // e a masmorra abriria para o grupo errado sem uma linha de
    // aviso.
    expect(dungeon.access).toEqual(FULL.access);
    expect(dungeon.protection).toEqual(FULL.protection);

    const corridor = dungeon.corridor as Record<string, unknown>;
    const npc = dungeon.npc as Record<string, unknown>;
    const rooms = dungeon.rooms as Record<string, unknown>[];
    const room = rooms[0];

    if (room === undefined) throw new Error('a sala não viajou');

    // A linha da tabela viaja SEM o que já é o padrão do plugin —
    // `weight` 10, `skin` 0, `blueprint`/`guaranteed` falsos e
    // `condition` 0. São ~55 bytes por linha, e é o que faz caber
    // sete masmorras em vez de cinco.
    expect(corridor.table).toEqual({
      mode: 'add',
      rolls: { min: 2, max: 4 },
      entries: [{ shortname: 'scrap', amount: { min: 10, max: 50 }, weight: 40 }],
    });
    expect(corridor.ai).toEqual(FULL.corridor.ai);

    expect(npc.loot).toEqual({
      mode: 'replace',
      rolls: { min: 1, max: 1 },
      entries: [
        { shortname: 'cloth', amount: { min: 5, max: 5 }, guaranteed: true, condition: 0.5 },
      ],
    });
    expect(npc.ai).toEqual(FULL.npc.ai);

    expect(room.door).toBe('garage');
    expect(room.wideDoor).toBe('double_toptier');
    expect(room.wideDoorCellsPerDoor).toBe(6);
    expect(room.grade).toEqual(FULL.rooms[0]?.grade);
    expect(room.ai).toEqual(FULL.rooms[0]?.ai);

    // A linha da tabela guarda só o que não é padrão — mas o que
    // NÃO é padrão tem de estar lá inteiro.
    expect(room.table).toEqual({
      mode: 'replace',
      rolls: { min: 3, max: 3 },
      entries: [
        { shortname: 'rifle.ak', amount: { min: 1, max: 1 }, blueprint: true, skin: 12_345 },
      ],
    });
  });

  it('o que está no padrão do plugin NÃO viaja', async () => {
    // ####  É ISTO QUE PAGA O TETO DE 50 KB  ####
    //
    // Uma receita de fábrica não mexeu em nada das três frentes.
    // Se ela mandasse `structure`, `lock`, três tabelas vazias e
    // cinco blocos de IA vazios, seriam ~400 bytes por masmorra
    // gastos para dizer "faça o que você já faria".
    const { sync, dungeons, sent } = harness();

    const factory = FACTORY_RECIPES[0];

    if (factory === undefined) throw new Error('sem receita de fábrica');

    dungeons.save(factory);

    await sync.push(SERVER, 'teste');

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    const dungeon = decode(command).dungeons[0];

    if (dungeon === undefined) throw new Error('a masmorra não viajou');

    expect(dungeon.structure).toBeUndefined();
    expect(dungeon.lock).toBeUndefined();

    // `everyone` e a proteção ligada são o `new AccessSpec()` e o
    // `new ProtectionSpec()` do C#. Mandá-los seria gastar ~200
    // bytes por masmorra para pedir o que o plugin já faz.
    expect(dungeon.access).toBeUndefined();
    expect(dungeon.protection).toBeUndefined();
    expect((dungeon.npc as Record<string, unknown>).ai).toBeUndefined();
    expect((dungeon.npc as Record<string, unknown>).loot).toBeUndefined();
    expect((dungeon.corridor as Record<string, unknown>).table).toBeUndefined();

    const room = (dungeon.rooms as Record<string, unknown>[])[0];

    if (room === undefined) throw new Error('a sala não viajou');

    expect(room.table).toBeUndefined();
    expect(room.ai).toBeUndefined();
    expect(room.grade).toBeUndefined();
    expect(room.wideDoor).toBeUndefined();
    expect(room.wideDoorCellsPerDoor).toBeUndefined();

    // O respawn é a EXCEÇÃO, e ela é de propósito: ausente e
    // `enabled: false` não são a mesma coisa no plugin — ausente
    // deixa o refresh do prefab de pé, e a caixa se repõe sozinha.
    expect(dungeon.respawn).toEqual({ enabled: false });
  });

  it('quem entra e a proteção custam ZERO no padrão, e o teto não se mexe', async () => {
    // ####  MEÇA O PAYLOAD DEPOIS DE MEXER  ####
    //
    // MEDIDO em 09/09/2026 pelo comando que o `push` monta, com a
    // receita de fábrica "normal": 1.773 bytes no padrão, +48 só
    // com `whoEnters: permission`, +200 com os dois blocos inteiros
    // fora do padrão.
    //
    // O teste guarda a ORDEM DE GRANDEZA, e não o número exato: um
    // campo novo nestes dois blocos que passe disso estoura AQUI, e
    // não num plugin que recebeu meia masmorra.
    const base = FACTORY_RECIPES[1];

    if (base === undefined) throw new Error('sem receita de fábrica');

    async function bytesOf(patch: Record<string, unknown>, count = 1): Promise<number> {
      const { sync, dungeons, sent } = harness();

      for (let index = 0; index < count; index += 1) {
        dungeons.save(
          dungeonInputSchema.parse({ ...base, ...patch, id: `masmorra-${String(index)}` }),
        );
      }

      await sync.push(SERVER, 'medição');

      // O `push` RECUSA o envio acima do teto: nada enviado quer
      // dizer que estourou.
      return sent[0]?.length ?? Number.POSITIVE_INFINITY;
    }

    const OFF_DEFAULT = {
      access: { whoEnters: 'permission', enterPermission: 'origemz.vip.diamante' },
      protection: { enabled: false, allowAdmin: false, warnOnAttempt: false },
    };

    const atDefault = await bytesOf({});

    expect(await bytesOf({ access: { whoEnters: 'permission' } })).toBeLessThanOrEqual(
      atDefault + 64,
    );
    expect(await bytesOf(OFF_DEFAULT)).toBeLessThanOrEqual(atDefault + 256);

    // As ~29 que cabiam antes desta frente continuam cabendo — é o
    // que significa "no padrão não viaja".
    expect(await bytesOf({}, 29)).toBeLessThan(DUNGEON_SYNC_MAX_BYTES);

    // E mesmo um servidor em que TODA masmorra fechou a entrada e
    // desligou a proteção continua longe do teto.
    expect(await bytesOf(OFF_DEFAULT, 25)).toBeLessThan(DUNGEON_SYNC_MAX_BYTES);
  });

  it('as quatro receitas de fábrica cabem folgadas no comando', async () => {
    const { sync, dungeons, sent } = harness();

    for (const recipe of FACTORY_RECIPES) dungeons.save(recipe);

    await sync.push(SERVER, 'teste');

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    expect(command.length).toBeLessThan(DUNGEON_SYNC_MAX_BYTES);
  });
});

// ============================================================
//  A entrada parou de distribuir arsenal.
//
//  ####  O DEFEITO QUE ISTO TRANCA  ####
//
//  MEDIDO em 09/09/2026, apontado pelo dono: as plantas de entrada
//  do acervo trazem armas dentro das caixas, e o construtor as
//  copiava fielmente. A `entrance2` — a entrada das duas masmorras
//  cadastradas — traz uma M249: toda vez que uma delas nascia, uma
//  M249 nascia junto na superfície.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §7.
// ============================================================

describe('o que a casinha da entrada carrega', () => {
  it('nasce sem nada, inclusive numa masmorra gravada antes do campo existir', () => {
    const { dungeons } = harness();

    // `FACTORY_RECIPES` são o que o admin duplica, e nenhuma delas
    // menciona o campo: elas têm de valer 'none' também.
    const recipe = FACTORY_RECIPES[0];

    if (recipe === undefined) throw new Error('sem receita de fábrica');

    expect(recipe.entranceItems).toBe('none');

    const saved = dungeons.save(recipe);

    expect(saved.entranceItems).toBe('none');
  });

  it('a escolha atravessa o banco', () => {
    const { dungeons } = harness();

    for (const mode of ['none', 'unarmed', 'all'] as const) {
      const saved = dungeons.save(
        dungeonInputSchema.parse({ ...FULL, id: `com-${mode}`, entranceItems: mode }),
      );

      expect(saved.entranceItems).toBe(mode);
      expect(dungeons.get(`com-${mode}`)?.entranceItems).toBe(mode);
    }
  });

  it('só viaja ao plugin quando não é o padrão', async () => {
    const { sync, dungeons, sent } = harness();

    dungeons.save(dungeonInputSchema.parse({ ...FULL, id: 'limpa', entranceItems: 'none' }));
    dungeons.save(dungeonInputSchema.parse({ ...FULL, id: 'armada', entranceItems: 'all' }));

    await sync.push(SERVER, 'teste');

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    const payload = decode(command);
    const limpa = payload.dungeons.find((entry) => entry.id === 'limpa');
    const armada = payload.dungeons.find((entry) => entry.id === 'armada');

    // O padrão é o mesmo dos dois lados do fio, então ele não paga
    // byte nenhum do teto de 50 KB — é o corte do `leanAccess`.
    expect(limpa?.entranceItems).toBeUndefined();
    expect(armada?.entranceItems).toBe('all');
  });

  it('recusa um modo que ninguém implementou', () => {
    expect(() =>
      dungeonInputSchema.parse({ ...FULL, id: 'torta', entranceItems: 'somente-arma' }),
    ).toThrow();
  });
});

// ============================================================
//  O mapa e o chat.
//
//  ####  O QUE ESTE BLOCO PROTEGE  ####
//
//  MEDIDO em 09/09/2026, a pedido do dono: a masmorra não marcava
//  nada no mapa e não falava com ninguém fora dela. O plugin não
//  tinha uma linha de MapMarker, e o único caminho de fala
//  alcançava só quem já estava lá dentro.
//
//  Agora os dois blocos existem — e o que se prova aqui é que eles
//  atravessam o banco e o fio, porque um campo que para no
//  repositório é o pior desfecho: o admin configura, a tela mostra
//  de volta, e o jogo ignora.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §3.
// ============================================================

describe('o marcador e o anúncio', () => {
  it('nascem ligados, com os padrões do plugin', () => {
    const recipe = FACTORY_RECIPES[0];

    if (recipe === undefined) throw new Error('sem receita de fábrica');

    expect(recipe.marker).toEqual({
      enabled: true,
      label: 'Masmorra',
      color: '#ff0000',
      alpha: 0.55,
      radius: 0.5,
    });

    expect(recipe.announce).toEqual({
      enabled: true,
      onBuild: '',
      onEnd: '',
      showGrid: true,
    });
  });

  it('atravessam o banco', () => {
    const { dungeons } = harness();

    const saved = dungeons.save(
      dungeonInputSchema.parse({
        ...FULL,
        id: 'anunciada',
        marker: { enabled: true, label: 'O Labirinto', color: '#00ff88', alpha: 0.9, radius: 2.5 },
        announce: {
          enabled: true,
          onBuild: 'O Labirinto abriu em {grid}!',
          onEnd: 'Acabou.',
          showGrid: false,
        },
      }),
    );

    expect(saved.marker.label).toBe('O Labirinto');
    expect(saved.marker.color).toBe('#00ff88');
    expect(saved.marker.alpha).toBe(0.9);
    expect(saved.marker.radius).toBe(2.5);

    const read = dungeons.get('anunciada');

    expect(read?.announce.onBuild).toBe('O Labirinto abriu em {grid}!');
    expect(read?.announce.showGrid).toBe(false);
  });

  it('uma linha torta no banco vira o padrão, e não derruba a leitura', () => {
    const { dungeons, db } = harness();

    dungeons.save(dungeonInputSchema.parse({ ...FULL, id: 'torta' }));

    // O que um banco editado à mão — ou restaurado de uma versão
    // mais velha — pode conter. O repositório nunca escreveria isto.
    db.prepare(
      `UPDATE dungeons
          SET marker_color = 'vermelho', marker_alpha = 9, marker_radius = -3
        WHERE id = 'torta'`,
    ).run();

    const read = dungeons.get('torta');

    // Vira o padrão, e a masmorra continua legível: é a mesma regra
    // de toda coluna torta deste repositório.
    expect(read?.marker.color).toBe('#ff0000');
    expect(read?.marker.alpha).toBe(1);
    expect(read?.marker.radius).toBe(0.1);
    expect(read?.name).toBe(FULL.name);
  });

  it('só o que não é padrão viaja ao plugin', async () => {
    const { sync, dungeons, sent } = harness();

    dungeons.save(dungeonInputSchema.parse({ ...FULL, id: 'padrao' }));
    dungeons.save(
      dungeonInputSchema.parse({
        ...FULL,
        id: 'gritona',
        marker: { enabled: true, label: 'Evento', color: '#00ff88', alpha: 0.55, radius: 0.5 },
        announce: { enabled: true, onBuild: 'Abriu em {grid}', onEnd: '', showGrid: true },
      }),
    );
    dungeons.save(
      dungeonInputSchema.parse({
        ...FULL,
        id: 'muda',
        marker: { enabled: false, label: 'Masmorra', color: '#ff0000', alpha: 0.55, radius: 0.5 },
        announce: { enabled: false, onBuild: '', onEnd: '', showGrid: true },
      }),
    );

    await sync.push(SERVER, 'teste');

    const command = sent[0];

    if (command === undefined) throw new Error('nada foi enviado');

    const payload = decode(command);
    const find = (id: string) => payload.dungeons.find((entry) => entry.id === id);

    // No padrão dos dois lados do fio, o bloco não paga byte nenhum
    // do teto de 50 KB — é o mesmo corte do `leanAccess`.
    expect(find('padrao')?.marker).toBeUndefined();
    expect(find('padrao')?.announce).toBeUndefined();

    // Fora do padrão, viaja só o campo que mudou.
    expect(find('gritona')?.marker).toEqual({ enabled: true, label: 'Evento', color: '#00ff88' });
    expect(find('gritona')?.announce).toEqual({ enabled: true, onBuild: 'Abriu em {grid}' });

    // Desligado viaja SOZINHO: os outros campos não são lidos
    // quando não há marcador nem fala para configurar.
    expect(find('muda')?.marker).toEqual({ enabled: false });
    expect(find('muda')?.announce).toEqual({ enabled: false });
  });

  it('recusa uma cor que não é hexadecimal', () => {
    expect(() =>
      dungeonInputSchema.parse({ ...FULL, id: 'colorida', marker: { color: 'vermelho' } }),
    ).toThrow();
  });
});
