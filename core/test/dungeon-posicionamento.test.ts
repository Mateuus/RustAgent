// ============================================================
//  Marcar onde cada peça nasce, o conteúdo de cada caixa, o
//  material do corredor e a rota do código.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Quatro pedidos do dono de 13/09/2026, e os quatro têm o mesmo
//  modo de falha: eles FUNCIONAM na tela e não acontecem no jogo.
//  O admin marca a posição, salva, a tela mostra o marcador de
//  volta — e o servidor sorteia como sempre fez, porque o campo
//  parou no quarto degrau (schema, coluna, repositório, `sync`).
//
//  Então cada teste aqui percorre os degraus de uma vez: grava,
//  lê de volta e confere que o campo atravessou o base64 do
//  comando de RCON.
//
//  ####  E UM DELES PROTEGE DINHEIRO  ####
//
//  O prêmio em OZCoin de uma caixa vira `Wallet.credit`, e a linha
//  do plugin pode chegar duas vezes (um `oxide.reload` no meio, um
//  retry). O teste da referência estável é o que separa "creditou
//  uma vez" de "deu dinheiro de graça".
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { checkLockRoute } from '../src/dungeons/lock-route.js';
import { BlueprintMaterializer } from '../src/dungeons/materializer.js';
import { DungeonSync, type DungeonSyncWallet } from '../src/dungeons/sync.js';
import { DUNGEON_EVENT_MARKER } from '../src/game/dungeon-contract.js';
import { DUNGEON_CRATES, DUNGEON_NPCS } from '../src/game/dungeon-prefabs.js';
import { dungeonInputSchema } from '../src/types/dungeons.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

const CRATE_NORMAL = 'assets/bundled/prefabs/radtown/crate_normal.prefab';
const CRATE_ELITE = 'assets/bundled/prefabs/radtown/crate_elite.prefab';
const NPC_HEAVY = 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab';

/**
 * Um desenho com uma sala vermelha no fundo de um corredor.
 *
 *     . R R .
 *     . # # .
 *     . E # .
 *
 * A vermelha encosta no corredor, o corredor chega na entrada, e
 * nada flutua — ele passa no `checkLayout`.
 */
const GRID = ['.RR.', '.##.', '.E#.'];

interface Credited {
  readonly steamId: string;
  readonly amount: number;
  readonly reference: string;
  readonly reason: string;
}

function harness(options: { readonly walletStatus?: string } = {}) {
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
  const sent: string[] = [];
  const credited: Credited[] = [];
  const told: { readonly steamId: string; readonly message: string }[] = [];

  const wallet: DungeonSyncWallet = {
    credit: (input) => {
      credited.push(input);

      return Promise.resolve({ status: options.walletStatus ?? 'ok' });
    },
  };

  const sync = new DungeonSync({
    dungeons,
    events: new WorldEventsRepository(db, silent),
    servers: {
      ids: () => [SERVER],
      contextOf: () => ({
        rcon: {
          isConnected: true,
          send: (command: string) => {
            sent.push(command);
            return Promise.resolve('');
          },
        },
      }),
    },
    materializer: new BlueprintMaterializer({
      blueprints: new DungeonBlueprintsRepository(db, silent),
      servers: { ids: () => [SERVER], dataDirOf: () => null },
      logger: silent,
    }),
    logger: silent,
    wallet: () => wallet,
    tell: (_serverId, steamId, message) => {
      told.push({ steamId, message });
      return Promise.resolve();
    },
  });

  return { sync, dungeons, sent, credited, told };
}

/** O JSON que viajou dentro do `origemz.dungeon.sync <base64>`. */
function decode(command: string): { dungeons: Record<string, unknown>[] } {
  const payload = command.slice(command.indexOf(' ') + 1);

  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
    dungeons: Record<string, unknown>[];
  };
}

/**
 * O segredo desta subida do agente, lido do comando que ele mandou.
 *
 * Ele é privado (`#secret`) e sorteado por subida: é o que separa o
 * grito do plugin de alguém digitando o marcador no chat. O teste o
 * alcança pelo único lugar em que ele viaja — o payload do `sync`.
 */
function secretOf(sent: readonly string[]): string {
  const first = sent[0];

  if (first === undefined) throw new Error('nada foi enviado: sem segredo para forjar a linha');

  const payload = first.slice(first.indexOf(' ') + 1);
  const { secret } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
    readonly secret: string;
  };

  return secret;
}

// ------------------------------------------------------------
//  §1  A CAIXA COM CONTEÚDO PRÓPRIO
// ------------------------------------------------------------

describe('a caixa cadastrada carrega o conteúdo dela', () => {
  it('a lista antiga de caminhos continua entrando', () => {
    // Toda masmorra gravada antes de 13/09/2026 tem `crates` como
    // lista de STRINGS. Se o schema as recusasse, o primeiro PUT do
    // painel numa masmorra antiga falharia — e o `preprocess` existe
    // exatamente para que não haja migração de dados.
    const parsed = dungeonInputSchema.parse({
      id: 'antiga',
      name: 'A de antes',
      rooms: [{ key: 'red', color: 'red', crates: [CRATE_NORMAL, CRATE_ELITE] }],
      corridor: { crates: [CRATE_NORMAL] },
    });

    expect(parsed.rooms[0]?.crates).toEqual([
      { prefab: CRATE_NORMAL, table: null, coins: null },
      { prefab: CRATE_ELITE, table: null, coins: null },
    ]);
    expect(parsed.corridor.crates[0]?.prefab).toBe(CRATE_NORMAL);
  });

  it('o mesmo prefab duas vezes é recusado, e a frase diz por quê', () => {
    const result = dungeonInputSchema.safeParse({
      id: 'repetida',
      name: 'Duas de elite',
      rooms: [{ key: 'red', color: 'red', crates: [CRATE_ELITE, CRATE_ELITE] }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('já está na lista');
  });

  it('a tabela e o OZCoin de uma caixa atravessam o banco', () => {
    const { dungeons } = harness();

    const input = dungeonInputSchema.parse({
      id: 'com-premio',
      name: 'A que paga',
      rooms: [
        {
          key: 'red',
          color: 'red',
          crates: [
            { prefab: CRATE_NORMAL },
            {
              prefab: CRATE_ELITE,
              table: {
                mode: 'replace',
                rolls: { min: 1, max: 1 },
                entries: [{ shortname: 'rifle.ak', amount: { min: 1, max: 1 } }],
              },
              coins: { amount: { min: 500, max: 1500 }, chance: 25 },
            },
          ],
        },
      ],
    });

    const saved = dungeons.save(input);
    const crates = saved.rooms[0]?.crates ?? [];

    // A comparação é do objeto inteiro: um campo novo que alguém
    // acrescente ao `crateSpecSchema` e esqueça no JSON da coluna
    // falha aqui sem ninguém lembrar de testá-lo.
    expect(crates).toEqual(input.rooms[0]?.crates);
    expect(crates[0]?.table).toBeNull();
    expect(crates[1]?.coins?.chance).toBe(25);
  });

  it('a caixa simples viaja como texto; só a que tem conteúdo vira objeto', async () => {
    const { dungeons, sync, sent } = harness();

    dungeons.save(
      dungeonInputSchema.parse({
        id: 'mista',
        name: 'Uma simples e uma com prêmio',
        rooms: [
          {
            key: 'red',
            color: 'red',
            crates: [
              { prefab: CRATE_NORMAL },
              { prefab: CRATE_ELITE, coins: { amount: { min: 100, max: 100 }, chance: 100 } },
            ],
          },
        ],
      }),
    );

    await sync.push(SERVER, 'teste');

    const first = sent[0];

    if (first === undefined) throw new Error('nada foi enviado');

    const room = (decode(first).dungeons[0]?.rooms as Record<string, unknown>[])[0];

    // ####  O ORÇAMENTO DO COMANDO É O MOTIVO DESTE TESTE  ####
    //
    // MEDIDO: mandar toda caixa como `{"prefab":…}` custa 12 bytes
    // cada, a receita de fábrica tem nove, e as 29 masmorras que
    // cabiam nos 50 KB deixaram de caber. Quem não usa conteúdo
    // próprio não pode pagar por ele.
    expect(room?.crates).toEqual([CRATE_NORMAL, CRATE_ELITE]);

    const contents = room?.crateContents as Record<string, unknown>[] | undefined;

    expect(contents).toHaveLength(1);
    expect(contents?.[0]?.prefab).toBe(CRATE_ELITE);
    // `chance: 100` é o padrão do plugin, e não viaja.
    expect(JSON.stringify(contents?.[0])).not.toContain('chance');
  });

  it('sem conteúdo próprio, o campo não viaja', async () => {
    const { dungeons, sync, sent } = harness();

    dungeons.save(
      dungeonInputSchema.parse({
        id: 'simples',
        name: 'Só caixas comuns',
        rooms: [{ key: 'red', color: 'red', crates: [CRATE_NORMAL] }],
      }),
    );

    await sync.push(SERVER, 'teste');

    const first = sent[0];

    if (first === undefined) throw new Error('nada foi enviado');

    expect(first).not.toContain('crateContents');
    expect(JSON.stringify(decode(first))).not.toContain('crateContents');
  });
});

// ------------------------------------------------------------
//  §2  OS MARCADORES DO DESENHO
// ------------------------------------------------------------

describe('o desenho marca onde cada peça nasce', () => {
  it('vazio é o sorteio de sempre, e não viaja', async () => {
    const { dungeons, sync, sent } = harness();

    dungeons.save(dungeonInputSchema.parse({ id: 'sorteada', name: 'Sem marcador' }));

    await sync.push(SERVER, 'teste');

    const first = sent[0];

    if (first === undefined) throw new Error('nada foi enviado');

    expect(JSON.stringify(decode(first))).not.toContain('placements');
  });

  it('o marcador atravessa o banco e o comando, com tipo e quantidade', async () => {
    const { dungeons, sync, sent } = harness();

    const input = dungeonInputSchema.parse({
      id: 'marcada',
      name: 'Com posições',
      mode: 'blueprint',
      grid: GRID,
      placements: [
        // A entrada do GRID está em (1,0) das linhas; o marcador é em
        // coordenada de ENTRADA, então (1,1) é a célula de corredor
        // logo ao lado — dentro do desenho.
        { kind: 'npc', x: 1, z: 1, amount: 2, prefab: NPC_HEAVY },
        { kind: 'crate', x: 0, z: 2 },
      ],
    });

    const saved = dungeons.save(input);

    expect(saved.placements).toEqual(input.placements);

    await sync.push(SERVER, 'teste');

    const first = sent[0];

    if (first === undefined) throw new Error('nada foi enviado');

    const marks = decode(first).dungeons[0]?.placements as Record<string, unknown>[];

    expect(marks).toHaveLength(2);
    expect(marks[0]).toEqual({ kind: 'npc', x: 1, z: 1, amount: 2, prefab: NPC_HEAVY });
    // `amount: 1` e prefab vazio são o caso comum, e não viajam.
    expect(marks[1]).toEqual({ kind: 'crate', x: 0, z: 2 });
  });

  it('marcador numa célula que não existe no desenho é recusado', () => {
    const result = dungeonInputSchema.safeParse({
      id: 'fora',
      name: 'Marcador no vazio',
      mode: 'blueprint',
      grid: GRID,
      // (9,9) não existe no desenho: sem chão ali, a peça não nasce.
      placements: [{ kind: 'crate', x: 9, z: 9 }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('não existe no desenho');
  });

  it('marcador na chegada do alçapão é recusado', () => {
    const result = dungeonInputSchema.safeParse({
      id: 'na-chegada',
      name: 'Inimigo em cima do jogador',
      mode: 'blueprint',
      grid: GRID,
      placements: [{ kind: 'npc', x: 0, z: 0 }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('chegada do alçapão');
  });

  it('marcador de inimigo basta para o código sair do corredor sem densidade', () => {
    // Sem o marcador, esta masmorra é recusada: o código sai de um
    // NPC de corredor e a densidade é zero. Com ele, o guarda existe
    // — e é exatamente a masmorra que o pedido descreve.
    const result = dungeonInputSchema.safeParse({
      id: 'guarda-marcado',
      name: 'O guarda do código',
      mode: 'blueprint',
      grid: GRID,
      corridor: { npcDensity: 0 },
      rooms: [{ key: 'red', color: 'red', locked: true }],
      placements: [{ kind: 'npc', x: 1, z: 1 }],
    });

    expect(result.success).toBe(true);
  });
});

// ------------------------------------------------------------
//  §3  O MATERIAL DO CORREDOR
// ------------------------------------------------------------

describe('o corredor tem material próprio', () => {
  it('`null` é herdar, e os três níveis atravessam o banco', () => {
    const { dungeons } = harness();

    const herda = dungeons.save(dungeonInputSchema.parse({ id: 'herda', name: 'Herda' }));

    expect(herda.corridor.grade).toBeNull();

    const proprio = dungeons.save(
      dungeonInputSchema.parse({
        id: 'proprio',
        name: 'Corredor de madeira',
        structure: { foundation: 'toptier', wall: 'toptier', ceiling: 'toptier' },
        corridor: { grade: { foundation: 'wood', wall: 'wood', ceiling: 'stone' } },
      }),
    );

    expect(proprio.corridor.grade).toEqual({
      foundation: 'wood',
      wall: 'wood',
      ceiling: 'stone',
    });
  });

  it('o grade do corredor NÃO é cortado por ser igual ao padrão do plugin', async () => {
    const { dungeons, sync, sent } = harness();

    dungeons.save(
      dungeonInputSchema.parse({
        id: 'pedra',
        name: 'Corredor de pedra numa masmorra de metal',
        structure: { foundation: 'metal', wall: 'metal', ceiling: 'metal' },
        // Pedra é o padrão do plugin. Se o `sync` cortasse por isso,
        // o corredor herdaria o METAL da masmorra — o oposto do que
        // o admin escolheu.
        corridor: { grade: { foundation: 'stone', wall: 'stone', ceiling: 'stone' } },
      }),
    );

    await sync.push(SERVER, 'teste');

    const first = sent[0];

    if (first === undefined) throw new Error('nada foi enviado');

    const corridor = decode(first).dungeons[0]?.corridor as Record<string, unknown>;

    expect(corridor.grade).toEqual({ foundation: 'stone', wall: 'stone', ceiling: 'stone' });
  });
});

// ------------------------------------------------------------
//  §4  O CÓDIGO NUNCA FICA ATRÁS DA PRÓPRIA PORTA
// ------------------------------------------------------------

describe('a rota do código', () => {
  const base = {
    lock: { enabled: true, carrier: 'npc' as const, carrierScope: 'corridor' as const },
    corridor: { npcDensity: 20, lootDensity: 10 },
    placements: [],
  };

  it('fecha quando há corredor público com inimigo', () => {
    const route = checkLockRoute(GRID, {
      ...base,
      rooms: [{ color: 'red', locked: true, npc: { max: 2 }, loot: { max: 2 } }],
    });

    expect(route.problems).toEqual([]);
    expect(route.lockedRooms).toBe(1);
    expect(route.carrierCells).toBeGreaterThan(0);
  });

  it('não fecha quando TODO o corredor está atrás de uma porta trancada', () => {
    // A vermelha é a única saída da entrada: tudo o que vem depois
    // dela está atrás da porta que o código abre.
    //
    //     . # # .     o corredor do fundo
    //     . R R .     a sala trancada, no meio
    //     . E . .     a entrada
    const sealed = ['.##.', '.RR.', '.E..'];

    const route = checkLockRoute(sealed, {
      ...base,
      rooms: [{ color: 'red', locked: true, npc: { max: 2 }, loot: { max: 2 } }],
    });

    expect(route.problems).toHaveLength(1);
    expect(route.problems[0]).toContain('não teria onde nascer');
    expect(route.carrierCells).toBe(0);
  });

  it('duas salas trancadas em fila não trancam a masmorra em silêncio', () => {
    // O caso que a regra antiga deixava passar: nenhuma das duas
    // guarda o próprio código, e as duas ficam lacradas para sempre.
    //
    //     . R R .     a vermelha, no fundo
    //     . B B .     a azul, no caminho
    //     . E . .     a entrada
    const chain = ['.RR.', '.BB.', '.E..'];

    const route = checkLockRoute(chain, {
      ...base,
      // `anywhere` é o caso mais permissivo que existe: se nem ele
      // acha lugar, a masmorra está de fato lacrada.
      lock: { ...base.lock, carrierScope: 'anywhere' },
      rooms: [
        { color: 'red', locked: true, npc: { max: 2 }, loot: { max: 2 } },
        { color: 'blue', locked: true, npc: { max: 2 }, loot: { max: 2 } },
      ],
    });

    expect(route.problems).toHaveLength(1);
    expect(route.lockedRooms).toBe(2);
  });

  it('um marcador na zona pública salva a rota', () => {
    // Um corredor de uma célula ao lado da entrada, e o resto da
    // masmorra atrás da vermelha:
    //
    //     . # # .     o corredor do fundo, atrás da porta
    //     . R R .     a sala trancada
    //     . E # .     a entrada, e a célula pública ao lado dela
    const sealed = ['.##.', '.RR.', '.E#.'];

    const withoutMark = checkLockRoute(sealed, {
      ...base,
      // Densidade zero: sem o marcador não há portador nenhum, e a
      // única célula pública que sobra é a chegada do alçapão — onde
      // o construtor não põe nada.
      corridor: { npcDensity: 0, lootDensity: 0 },
      rooms: [{ color: 'red', locked: true, npc: { max: 2 }, loot: { max: 2 } }],
    });

    expect(withoutMark.problems).toHaveLength(1);

    const route = checkLockRoute(sealed, {
      ...base,
      corridor: { npcDensity: 0, lootDensity: 0 },
      rooms: [{ color: 'red', locked: true, npc: { max: 2 }, loot: { max: 2 } }],
      // Um passo a leste da entrada: a célula pública de corredor.
      placements: [{ kind: 'npc', x: 1, z: 0 }],
    });

    expect(route.problems).toEqual([]);
    expect(route.carrierCells).toBe(1);
  });

  it('sem sala trancada não há rota a validar', () => {
    const route = checkLockRoute(GRID, {
      ...base,
      rooms: [{ color: 'red', locked: false, npc: { max: 2 }, loot: { max: 2 } }],
    });

    expect(route.problems).toEqual([]);
    expect(route.lockedRooms).toBe(0);
  });
});

// ------------------------------------------------------------
//  §5  O PRÊMIO EM OZCOIN
// ------------------------------------------------------------

describe('o prêmio em OZCoin de uma caixa', () => {
  /** Manda a linha do plugin pelo mesmo caminho do console. */
  async function openCrate(
    over: { readonly sync: DungeonSync; readonly sent: string[] },
    body: Record<string, unknown>,
  ): Promise<void> {
    const line = { ...body, secret: secretOf(over.sent) };

    over.sync.handleLine(SERVER, `${DUNGEON_EVENT_MARKER}${JSON.stringify(line)}`);

    // O crédito é `void` dentro do gancho: ele acontece no microtask
    // seguinte. Sem esta volta, o teste leria a carteira antes.
    await Promise.resolve();
    await Promise.resolve();
  }

  it('credita na carteira e manda o recibo no chat', async () => {
    const over = harness();

    over.dungeons.save(dungeonInputSchema.parse({ id: 'paga', name: 'A que paga' }));
    await over.sync.push(SERVER, 'teste');

    await openCrate(over, {
      kind: 'coins',
      slug: 'paga',
      steamId: '76561198000000001',
      amount: 250,
      key: 'paga:12345',
      prefab: CRATE_ELITE,
    });

    expect(over.credited).toHaveLength(1);
    expect(over.credited[0]?.amount).toBe(250);
    expect(over.credited[0]?.steamId).toBe('76561198000000001');
    // O prefixo é do agente: ele depende do id do servidor NO SITE,
    // que o plugin não conhece. Ver `store/reference.ts`.
    expect(over.credited[0]?.reference).toBe(`rust:${SERVER}:dungeon:paga:12345`);
    expect(over.told[0]?.message).toContain('250');
  });

  it('a linha repetida não paga duas vezes: a referência é a mesma', async () => {
    const over = harness();

    over.dungeons.save(dungeonInputSchema.parse({ id: 'paga', name: 'A que paga' }));
    await over.sync.push(SERVER, 'teste');

    const line = {
      kind: 'coins',
      slug: 'paga',
      steamId: '76561198000000001',
      amount: 250,
      key: 'paga:12345',
    };

    await openCrate(over, line);
    await openCrate(over, line);

    // ####  A PROTEÇÃO NÃO É AQUI, E O TESTE DIZ ISSO  ####
    //
    // O agente chama a carteira as duas vezes, com a MESMA
    // referência — e é a carteira que responde `idempotent` em vez
    // de creditar de novo. O que este teste cobra é que a chave não
    // mude entre as duas linhas: sem isso, a proteção do outro lado
    // não teria em que se apoiar.
    expect(over.credited).toHaveLength(2);
    expect(over.credited[0]?.reference).toBe(over.credited[1]?.reference);
  });

  it('a carteira recusando não vira recibo no chat', async () => {
    const over = harness({ walletStatus: 'unavailable' });

    over.dungeons.save(dungeonInputSchema.parse({ id: 'paga', name: 'A que paga' }));
    await over.sync.push(SERVER, 'teste');

    await openCrate(over, {
      kind: 'coins',
      slug: 'paga',
      steamId: '76561198000000001',
      amount: 250,
      key: 'paga:12345',
    });

    // O jogador NÃO pode ler "+250 OZCoin" quando o saldo não mudou:
    // é o defeito que ninguém consegue diagnosticar de dentro do jogo.
    expect(over.credited).toHaveLength(1);
    expect(over.told).toHaveLength(0);
  });

  it('o `idempotent` da carteira é sucesso, e não repete o recibo', async () => {
    const over = harness({ walletStatus: 'idempotent' });

    over.dungeons.save(dungeonInputSchema.parse({ id: 'paga', name: 'A que paga' }));
    await over.sync.push(SERVER, 'teste');

    await openCrate(over, {
      kind: 'coins',
      slug: 'paga',
      steamId: '76561198000000001',
      amount: 250,
      key: 'paga:12345',
    });

    // O dinheiro já estava lá: é sucesso. Mas o segundo aviso seria
    // um segundo "+250" para quem recebeu uma vez.
    expect(over.credited).toHaveLength(1);
    expect(over.told).toHaveLength(0);
  });

  it('uma linha sem o segredo desta subida é ignorada', async () => {
    const over = harness();

    over.dungeons.save(dungeonInputSchema.parse({ id: 'paga', name: 'A que paga' }));
    await over.sync.push(SERVER, 'teste');

    // Alguém digitando o marcador no chat não pode inventar saldo.
    over.sync.handleLine(
      SERVER,
      `${DUNGEON_EVENT_MARKER}${JSON.stringify({
        kind: 'coins',
        secret: 'chute',
        slug: 'paga',
        steamId: '76561198000000001',
        amount: 1_000_000,
        key: 'paga:1',
      })}`,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(over.credited).toHaveLength(0);
  });
});

// ------------------------------------------------------------
//  §6  O CATÁLOGO DE PREFABS
// ------------------------------------------------------------

describe('o catálogo que a tela oferece', () => {
  it('todo caminho é de asset e termina em .prefab', () => {
    // A régua é a do `cratePrefabSchema`. Um caminho que não a passa
    // seria oferecido na tela e recusado pela rota — e o admin não
    // teria como saber qual dos dois está errado.
    for (const entry of [...DUNGEON_CRATES, ...DUNGEON_NPCS]) {
      expect(entry.prefab).toMatch(/^assets\/.+\.prefab$/u);
      expect(entry.label.length).toBeGreaterThan(2);
    }
  });

  it('nenhum prefab repetido, e nenhum nome repetido', () => {
    for (const list of [DUNGEON_CRATES, DUNGEON_NPCS]) {
      const prefabs = list.map((entry) => entry.prefab);
      const labels = list.map((entry) => entry.label);

      expect(new Set(prefabs).size).toBe(prefabs.length);
      // Dois nomes iguais na lista fazem o seletor mostrar a mesma
      // linha duas vezes, e escolher uma delas é sorte.
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('todo inimigo oferecido é um cientista', () => {
    // A IA da masmorra é um componente pregado num `ScientistNPC`, e
    // o hook que impede o inimigo de matar o colega também. Um
    // prefab de outra família nasceria burro — ver `DUNGEON_NPCS`.
    for (const entry of DUNGEON_NPCS) {
      expect(entry.prefab).toContain('/scientist/scientistnpc');
    }
  });
});
