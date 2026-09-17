// ============================================================
//  A construção feita à mão, as skins e o visual do aviso.
//
//  Pedidos do dono em 16/09/2026. O que este arquivo trava:
//
//    - a leitura de uma exportação REAL do CopyPaste (ver
//      `fixtures/LEIA-ME.md`): três marcadores, e o que fica de fora;
//    - o reprocesso que nunca duplica ponto e nunca passa por cima do
//      que o admin mudou;
//    - a régua de espaço (piso, parede, altura, móvel);
//    - os cinco degraus — schema, coluna, repositório, sync, rota —
//      dos campos novos, que é onde campo de configuração costuma
//      morrer calado.
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { DungeonBlueprintsRepository } from '../src/db/dungeon-blueprints-repository.js';
import { DungeonLayoutsRepository } from '../src/db/dungeon-layouts-repository.js';
import { DungeonsRepository } from '../src/db/dungeons-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import {
  analyzeBody,
  BODY_MARKER_PREFABS,
  checkBodyPoints,
  markerId,
  mergeBodyPoints,
  roleOfPrefab,
  type BodyAnalysis,
} from '../src/dungeons/body.js';
import { BlueprintMaterializer } from '../src/dungeons/materializer.js';
import { DungeonSync } from '../src/dungeons/sync.js';
import { BUILDING_SKINS, isSkinCompatible, skinsForGrade } from '../src/game/building-skins.js';
import { DUNGEON_SYNC_MAX_BYTES } from '../src/game/dungeon-contract.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerDungeonRoutes } from '../src/http/routes/dungeons.js';
import { dungeonInputSchema, type BodyPointInput } from '../src/types/dungeons.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';

/** A exportação real. Ver `fixtures/LEIA-ME.md`. */
const REAL_EXPORT = readFileSync(join(import.meta.dirname, 'fixtures', 'dungeon-body-copypaste.json'), 'utf8');
const REAL_ENTITIES = (JSON.parse(REAL_EXPORT) as { entities: unknown[] }).entities;

function realAnalysis(): BodyAnalysis {
  return analyzeBody(REAL_ENTITIES);
}

describe('a exportação real do CopyPaste, lida como corpo', () => {
  it('acha os três marcadores, com posição e giro em graus', () => {
    const analysis = realAnalysis();

    expect(analysis.rotationInRadians).toBe(true);
    expect(analysis.markers.npc).toHaveLength(2);
    expect(analysis.markers.crate).toHaveLength(2);
    expect(analysis.markers.arrival).toHaveLength(1);

    const tree = analysis.markers.arrival[0];

    expect(tree?.x).toBe(0);
    expect(tree?.z).toBe(0);
    // 1,570796 rad no arquivo.
    expect(tree?.yaw).toBeCloseTo(90, 1);
  });

  it('conta o que fica de fora — e o NPC nem veio no arquivo', () => {
    const analysis = realAnalysis();

    expect(analysis.roles.npc).toBe(0);
    expect(analysis.roles.loot).toBe(1);
    expect(analysis.roles.hostile).toBe(1);
    expect(analysis.roles.lock).toBe(1);
    expect(analysis.inventoriesWithItems).toBe(1);
    expect(analysis.warnings.join(' ')).toContain('caixa de loot');
    expect(analysis.warnings.join(' ')).toContain('fechadura');
    expect(analysis.warnings.join(' ')).toContain('itens dentro');
  });

  it('guarda as peças de construção para a prévia e para a régua', () => {
    const shapes = realAnalysis().pieces.reduce<Record<string, number>>((count, piece) => {
      count[piece.shape] = (count[piece.shape] ?? 0) + 1;
      return count;
    }, {});

    expect(shapes).toEqual({ foundation: 6, floor: 6, wall: 11, doorway: 1 });
  });
});

describe('o papel de cada prefab', () => {
  it('os três marcadores, e só eles', () => {
    expect(roleOfPrefab(BODY_MARKER_PREFABS.npc)).toBe('marker');
    expect(roleOfPrefab(BODY_MARKER_PREFABS.crate)).toBe('marker');
    expect(roleOfPrefab(BODY_MARKER_PREFABS.arrival)).toBe('marker');

    // Mesma pasta, outro item (`woodcross`): MEDIDO no jogo.
    expect(roleOfPrefab('assets/prefabs/misc/halloween/deployablegravestone/gravestone.wood.deployed.prefab')).toBe('deployable');
    expect(roleOfPrefab('assets/prefabs/misc/xmas/xmastree/xmas_tree_a.deployed.prefab')).toBe('deployable');
  });

  it('o que o evento controla fica de fora', () => {
    expect(roleOfPrefab('assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab')).toBe('npc');
    expect(roleOfPrefab('assets/bundled/prefabs/radtown/crate_elite.prefab')).toBe('loot');
    expect(roleOfPrefab('assets/prefabs/npc/autoturret/autoturret_deployed.prefab')).toBe('hostile');
    expect(roleOfPrefab('assets/prefabs/deployable/landmine/landmine.prefab')).toBe('hostile');
    expect(roleOfPrefab('assets/prefabs/locks/keypad/lock.code.prefab')).toBe('lock');
    expect(roleOfPrefab('assets/prefabs/weapons/m249/m249.entity.prefab')).toBe('weapon');
    expect(roleOfPrefab('assets/content/vehicles/modularcar/car_chassis_2module.entity.prefab')).toBe('vehicle');
  });

  it('o resto sobe', () => {
    expect(roleOfPrefab('assets/prefabs/building core/wall/wall.prefab')).toBe('structure');
    expect(roleOfPrefab('assets/prefabs/building/door.hinged/door.hinged.metal.prefab')).toBe('attachment');
    expect(roleOfPrefab('assets/prefabs/deployable/large wood storage/box.wooden.large.prefab')).toBe('deployable');
    expect(roleOfPrefab('assets/algo/novo.prefab')).toBe('unknown');
  });
});

describe('juntar os marcadores aos pontos', () => {
  it('a primeira leitura cria um ponto por lápide e por vela, e a chegada da árvore', () => {
    const merged = mergeBodyPoints(realAnalysis(), { points: [], arrival: null });

    expect(merged.added).toBe(4);
    expect(merged.points.filter((point) => point.kind === 'npc')).toHaveLength(2);
    expect(merged.points.filter((point) => point.kind === 'crate')).toHaveLength(2);
    expect(merged.arrivalState).toBe('marker');
    expect(merged.arrival).toMatchObject({ x: 0, z: 0, source: 'marker' });
  });

  it('reler a mesma planta não duplica nada', () => {
    const analysis = realAnalysis();
    const first = mergeBodyPoints(analysis, { points: [], arrival: null });
    const second = mergeBodyPoints(analysis, { points: first.points, arrival: first.arrival });

    expect(second.added).toBe(0);
    expect(second.kept).toBe(4);
    expect(second.removed).toBe(0);
    expect(second.points).toEqual(first.points);
  });

  it('o que o admin mudou sobrevive ao reprocesso, e o ponto manual também', () => {
    const analysis = realAnalysis();
    const first = mergeBodyPoints(analysis, { points: [], arrival: null });
    const edited = first.points.map((point, index): BodyPointInput =>
      index === 0 ? { ...point, label: 'Chefe', profile: 'red', amount: 3, x: point.x + 0.4 } : point,
    );
    const manual: BodyPointInput = {
      id: 'p-manual1',
      kind: 'crate',
      label: 'Arsenal',
      x: 1,
      y: 0,
      z: 1,
      yaw: 0,
      profile: 'corridor',
      amount: 1,
      prefab: '',
      source: 'manual',
    };

    const again = mergeBodyPoints(analysis, { points: [...edited, manual], arrival: first.arrival });

    expect(again.points).toHaveLength(5);
    expect(again.points[0]).toMatchObject({ label: 'Chefe', profile: 'red', amount: 3 });
    expect(again.points[0]?.x).toBeCloseTo((first.points[0]?.x ?? 0) + 0.4);
    expect(again.points.find((point) => point.id === 'p-manual1')).toEqual(manual);
    expect(again.manual).toBe(1);
  });

  it('o marcador que sumiu leva o ponto dele junto', () => {
    const analysis = realAnalysis();
    const first = mergeBodyPoints(analysis, { points: [], arrival: null });
    const ghost: BodyPointInput = { ...(first.points[0] as BodyPointInput), id: markerId('npc', 99, 0, 99) };
    const again = mergeBodyPoints(analysis, { points: [...first.points, ghost], arrival: first.arrival });

    expect(again.removed).toBe(1);
    expect(again.points.some((point) => point.id === ghost.id)).toBe(false);
  });

  it('a chegada escolhida à mão não é trocada pela árvore', () => {
    const manual = { x: 3, y: 0, z: 0, yaw: 45, source: 'manual' as const };
    const merged = mergeBodyPoints(realAnalysis(), { points: [], arrival: manual });

    expect(merged.arrival).toEqual(manual);
    expect(merged.arrivalState).toBe('manual');
  });

  it('sem árvore, ou com duas, a chegada fica em branco — o admin escolhe', () => {
    const withoutTree = REAL_ENTITIES.filter(
      (node) => (node as { prefabname?: string }).prefabname !== BODY_MARKER_PREFABS.arrival,
    );
    const tree = REAL_ENTITIES.find(
      (node) => (node as { prefabname?: string }).prefabname === BODY_MARKER_PREFABS.arrival,
    ) as Record<string, unknown>;
    const twoTrees = [...REAL_ENTITIES, { ...tree, pos: { x: '6', y: '0', z: '3' } }];

    const none = mergeBodyPoints(analyzeBody(withoutTree), { points: [], arrival: null });
    const two = mergeBodyPoints(analyzeBody(twoTrees), { points: [], arrival: null });

    expect(none.arrival).toBeNull();
    expect(none.arrivalState).toBe('missing');
    expect(two.arrival).toBeNull();
    expect(two.arrivalState).toBe('ambiguous');
  });
});

describe('cabe alguém ali?', () => {
  const point = (x: number, y: number, z: number, kind: 'npc' | 'crate' = 'npc'): BodyPointInput => ({
    id: 'p-teste',
    kind,
    label: '',
    x,
    y,
    z,
    yaw: 0,
    profile: 'green',
    amount: 1,
    prefab: '',
    source: 'manual',
  });

  it('a chegada da árvore passa', () => {
    const analysis = realAnalysis();
    const merged = mergeBodyPoints(analysis, { points: [], arrival: null });

    expect(checkBodyPoints(analysis, [], merged.arrival)).toEqual([]);
  });

  it('fora da construção, sem piso, dentro da parede e em cima de móvel', () => {
    const analysis = realAnalysis();
    const codes = (x: number, y: number, z: number): string[] =>
      checkBodyPoints(analysis, [point(x, y, z)], null).map((problem) => problem.code);

    expect(codes(30, 0, 30)).toEqual(['outside']);
    expect(codes(3, 2, 0)).toEqual(['no_floor']);
    // A divisória cheia fica em x = 1,5, de z = 1,5 a 4,5.
    expect(codes(1.55, 0, 3)).toEqual(['inside_wall']);
    // O vão da porta fica em x = 1,5, z = 0: dá para atravessar.
    expect(codes(1.5, 0, 0)).toEqual([]);
    // A caixa grande de madeira está em (3,6; 3,9).
    expect(codes(3.5, 0, 3.8)).toEqual(['on_prop']);
  });

  it('um piso baixo em cima tira a altura', () => {
    const analysis: BodyAnalysis = {
      ...realAnalysis(),
      pieces: [
        { shape: 'foundation', x: 0, y: 0, z: 0, yaw: 0, grade: 2, skin: 0 },
        { shape: 'floor', x: 0, y: 1.2, z: 0, yaw: 0, grade: 2, skin: 0 },
      ],
      props: [],
      bounds: { min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 3, z: 3 } },
    };

    expect(checkBodyPoints(analysis, [point(0, 0, 0)], null).map((problem) => problem.code)).toEqual(['no_headroom']);
    // Uma caixa baixa cabe onde o inimigo não cabe.
    expect(checkBodyPoints(analysis, [point(0, 0, 0, 'crate')], null)).toEqual([]);
  });
});

describe('as skins de construção', () => {
  it('o catálogo é o medido no jogo', () => {
    expect(BUILDING_SKINS.map((skin) => skin.id).sort()).toEqual(
      [10220, 10221, 10223, 10225, 10232, 10326, 10430, 10472].sort(),
    );
    expect(skinsForGrade('twigs')).toEqual([]);
    expect(skinsForGrade('metal').map((skin) => skin.key)).toEqual(['shipping_container']);
  });

  it('só o par que o jogo conhece passa', () => {
    expect(isSkinCompatible('stone', 0)).toBe(true);
    expect(isSkinCompatible('stone', 10223)).toBe(true);
    expect(isSkinCompatible('stone', 10221)).toBe(false);
    expect(isSkinCompatible('twigs', 10232)).toBe(false);
  });

  it('a régua recusa a skin do material errado, com a frase', () => {
    const result = dungeonInputSchema.safeParse({
      id: 'errada',
      name: 'Errada',
      structure: { foundation: 'stone', wall: 'stone', ceiling: 'stone', wallSkin: 10221 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('não existe para parede de pedra');
  });
});

describe('a régua do modo construção', () => {
  const base = {
    id: 'cripta',
    name: 'Cripta',
    mode: 'construction' as const,
  };

  it('pede o corpo e a chegada', () => {
    const withoutBody = dungeonInputSchema.safeParse(base);
    const withoutArrival = dungeonInputSchema.safeParse({ ...base, body: { blueprint: 'corpo' } });

    expect(withoutBody.error?.issues[0]?.path).toEqual(['body']);
    expect(withoutArrival.error?.issues[0]?.path).toEqual(['body', 'arrival']);
  });

  it('recusa dois pontos com o mesmo id', () => {
    const point = { id: 'mg-1', kind: 'npc', x: 0, y: 0, z: 0 };
    const result = dungeonInputSchema.safeParse({
      ...base,
      body: { blueprint: 'corpo', arrival: { x: 0, y: 0, z: 0 }, points: [point, point] },
    });

    expect(result.error?.issues[0]?.message).toContain('mesmo id');
  });

  it('as fechaduras das cores não se aplicam: não há porta gerada', () => {
    const result = dungeonInputSchema.safeParse({
      ...base,
      body: { blueprint: 'corpo', arrival: { x: 0, y: 0, z: 0 } },
      lock: { carrier: 'none' },
      rooms: [{ key: 'red', color: 'red', locked: true }],
    });

    expect(result.success).toBe(true);
  });
});

function world() {
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
  const blueprints = new DungeonBlueprintsRepository(db, silent);
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
    materializer: new BlueprintMaterializer({
      blueprints,
      servers: { ids: () => [SERVER], dataDirOf: () => null },
      logger: silent,
    }),
    logger: silent,
  });

  return { db, dungeons, blueprints, events, sync, sent };
}

function decode(command: string): { dungeons: Record<string, unknown>[] } {
  return JSON.parse(Buffer.from(command.slice(command.indexOf(' ') + 1), 'base64').toString('utf8')) as {
    dungeons: Record<string, unknown>[];
  };
}

/** Uma masmorra de construção pronta, com tudo que é novo fora do padrão. */
function cripta() {
  const merged = mergeBodyPoints(realAnalysis(), { points: [], arrival: null });

  return dungeonInputSchema.parse({
    id: 'cripta',
    name: 'Cripta Velha',
    mode: 'construction',
    grid: ['E#'],
    body: {
      blueprint: 'corpo-real',
      arrival: merged.arrival,
      points: merged.points.map((point, index) => (index === 0 ? { ...point, profile: 'red', amount: 2, prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab' } : point)),
    },
    structure: { foundation: 'stone', wall: 'metal', ceiling: 'toptier', foundationSkin: 10472, wallSkin: 10221, ceilingSkin: 10430 },
    corridor: { grade: { foundation: 'wood', wall: 'wood', ceiling: 'wood', wallSkin: 10232 } },
    rooms: [{ key: 'red', color: 'red', grade: { foundation: 'stone', wall: 'stone', ceiling: 'stone', wallSkin: 10326 } }],
    announce: { tag: '[CRIPTA]', tagColor: '#C43F2C', color: '#eeeeee', size: 18, onBuild: 'A [vermelho]{nome}[/] abriu!' },
  });
}

describe('os campos novos atravessam o banco', () => {
  it('modo, corpo, skins e visual voltam iguais', () => {
    const { dungeons } = world();
    const input = cripta();
    const saved = dungeons.save(input);

    expect(saved.mode).toBe('construction');
    expect(saved.body).toEqual(input.body);
    expect(saved.structure).toEqual(input.structure);
    expect(saved.corridor.grade).toEqual(input.corridor.grade);
    expect(saved.rooms[0]?.grade).toEqual(input.rooms[0]?.grade);
    expect(saved.announce).toEqual(input.announce);
  });

  it('o `mode` do banco continua no CHECK antigo, e voltar ao desenho não perde nada', () => {
    const { db, dungeons } = world();
    const input = cripta();

    dungeons.save(input);

    const row = db.prepare('SELECT mode, construction FROM dungeons WHERE id = ?').get('cripta') as {
      mode: string;
      construction: number;
    };

    expect(row).toEqual({ mode: 'blueprint', construction: 1 });

    const back = dungeons.save({ ...input, mode: 'blueprint' });

    expect(back.mode).toBe('blueprint');
    expect(back.grid).toEqual(['E#']);
    expect(back.body).toEqual(input.body);
  });

  it('a lista diz qual é o corpo, e quem usa a planta como corpo não a deixa sumir', () => {
    const { dungeons } = world();

    dungeons.save(cripta());

    expect(dungeons.list()[0]?.bodyBlueprint).toBe('corpo-real');
    expect(dungeons.usersOfBlueprint('corpo-real')).toEqual(['cripta']);
    expect(dungeons.bodyUsersOfBlueprint('corpo-real')).toEqual(['cripta']);
  });

  it('a planta grava a contagem dos marcadores', () => {
    const { blueprints } = world();
    const saved = blueprints.save({ id: 'corpo-real', name: 'Corpo', kind: 'base', content: REAL_EXPORT, origin: 'import' });

    expect(saved.ok && saved.blueprint.markers).toEqual({ npc: 2, crate: 2, arrival: 1 });
  });
});

describe('os campos novos chegam ao comando', () => {
  it('o corpo viaja enxuto, e só no modo construção', async () => {
    const { dungeons, sync, sent } = world();

    dungeons.save(cripta());
    dungeons.save({ ...cripta(), id: 'desenho', mode: 'blueprint' });

    await sync.push(SERVER, 'teste');

    const payload = decode(sent[0] ?? '');
    const [construction, drawing] = ['cripta', 'desenho'].map((id) => payload.dungeons.find((d) => d.id === id));
    const body = construction?.body as { blueprint: string; arrival: Record<string, number>; points: Record<string, unknown>[] };

    expect(construction?.mode).toBe('construction');
    expect(construction?.name).toBe('Cripta Velha');
    expect(body.blueprint).toBe('corpo-real');
    // O CopyPaste gravou y = -0,00496; no fio vai o centímetro.
    expect(body.arrival).toEqual({ x: 0, y: 0, z: 0, r: 90 });
    expect(body.points[0]).toMatchObject({ k: 'npc', p: 'red', a: 2, f: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab' });
    // Perfil verde, uma peça e sem prefab são o padrão: não viajam.
    expect(Object.keys(body.points[3] ?? {}).sort()).toEqual(['k', 'x', 'y', 'z'].concat(body.points[3]?.r === undefined ? [] : ['r']).sort());
    expect(drawing?.body).toBeUndefined();
  });

  it('a skin zero não viaja; a escolhida, sim', async () => {
    const { dungeons, sync, sent } = world();

    dungeons.save(cripta());
    await sync.push(SERVER, 'teste');

    const payload = decode(sent[0] ?? '').dungeons[0] as Record<string, Record<string, unknown>>;

    expect(payload.structure).toEqual({
      foundation: 'stone',
      wall: 'metal',
      ceiling: 'toptier',
      foundationSkin: 10472,
      wallSkin: 10221,
      ceilingSkin: 10430,
    });
    expect((payload.corridor as { grade?: unknown }).grade).toEqual({ foundation: 'wood', wall: 'wood', ceiling: 'wood', wallSkin: 10232 });
  });

  it('o visual do aviso viaja', async () => {
    const { dungeons, sync, sent } = world();

    dungeons.save(cripta());
    await sync.push(SERVER, 'teste');

    expect(decode(sent[0] ?? '').dungeons[0]?.announce).toEqual({
      enabled: true,
      onBuild: 'A [vermelho]{nome}[/] abriu!',
      tag: '[CRIPTA]',
      tagColor: '#C43F2C',
      color: '#eeeeee',
      size: 18,
    });
  });

  it('cento e vinte pontos cabem no orçamento, com folga para outras masmorras', async () => {
    const { dungeons, sync, sent } = world();
    const points = Array.from({ length: 120 }, (_, index): BodyPointInput => ({
      id: `p-${String(index)}`,
      kind: index % 2 === 0 ? 'npc' : 'crate',
      label: `Ponto ${String(index)}`,
      x: 123.45 + index,
      y: -3.21,
      z: -234.56 - index,
      yaw: 271.5,
      profile: 'corridor',
      amount: 8,
      prefab: 'assets/bundled/prefabs/radtown/crate_normal_2.prefab',
      source: 'manual',
    }));

    dungeons.save({ ...cripta(), body: { blueprint: 'corpo-real', arrival: { x: 0, y: 0, z: 0, yaw: 0, source: 'manual' }, points } });
    await sync.push(SERVER, 'teste');

    const bytes = Buffer.byteLength(sent[0] ?? '', 'utf8');

    // Medido em 17/09/2026: ~24 KB com todo campo no pior caso.
    expect(bytes).toBeLessThan(DUNGEON_SYNC_MAX_BYTES / 2);
  });
});

describe('as rotas do corpo', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function routes() {
    const state = world();
    const instance = Fastify({ logger: false });

    instance.setErrorHandler(async (error, _request, reply) => {
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

    await instance.register(async (api) => {
      registerDungeonRoutes(api, {
        dungeons: state.dungeons,
        blueprints: state.blueprints,
        layouts: new DungeonLayoutsRepository(state.db, silent),
        events: state.events,
      });
    });

    await instance.ready();
    app = instance;

    return { app: instance, ...state };
  }

  it('o upload de um corpo devolve o relatório dos marcadores', async () => {
    const { app: api } = await routes();
    const response = await api.inject({
      method: 'POST',
      url: '/dungeon-blueprints',
      payload: { id: 'corpo-real', kind: 'base', content: REAL_EXPORT },
    });
    const body = response.json<{ body: { markers: Record<string, number>; warnings: string[] } }>();

    expect(response.statusCode).toBe(201);
    expect(body.body.markers).toEqual({ npc: 2, crate: 2, arrival: 1 });
    expect(body.body.warnings.length).toBeGreaterThan(0);
  });

  it('o scan junta os pontos sem duplicar, e aponta o que não cabe', async () => {
    const { app: api } = await routes();

    await api.inject({ method: 'POST', url: '/dungeon-blueprints', payload: { id: 'corpo-real', kind: 'base', content: REAL_EXPORT } });

    const first = (await api.inject({ method: 'POST', url: '/dungeon-blueprints/corpo-real/body-scan', payload: {} })).json<{
      merged: { points: BodyPointInput[]; arrival: unknown; added: number };
      problems: { id: string; code: string }[];
    }>();

    expect(first.merged.added).toBe(4);

    const second = (
      await api.inject({
        method: 'POST',
        url: '/dungeon-blueprints/corpo-real/body-scan',
        payload: { points: first.merged.points, arrival: first.merged.arrival },
      })
    ).json<{ merged: { points: unknown[]; added: number } }>();

    expect(second.merged.added).toBe(0);
    expect(second.merged.points).toHaveLength(4);

    // A lápide que caiu dentro da caixa de madeira é apontada.
    expect(first.problems.some((problem) => problem.code === 'on_prop')).toBe(true);
  });

  it('o papel da planta muda, e virar entrada exige o alçapão', async () => {
    const { app: api } = await routes();

    await api.inject({ method: 'POST', url: '/dungeon-blueprints', payload: { id: 'corpo-real', kind: 'base', content: REAL_EXPORT } });

    const refused = await api.inject({ method: 'PATCH', url: '/dungeon-blueprints/corpo-real', payload: { kind: 'entrance' } });
    const renamed = await api.inject({ method: 'PATCH', url: '/dungeon-blueprints/corpo-real', payload: { name: 'Cripta' } });

    expect(refused.statusCode).toBe(422);
    expect(renamed.json<{ blueprint: { name: string; kind: string } }>().blueprint).toMatchObject({ name: 'Cripta', kind: 'base' });
  });

  it('a masmorra com chegada sem chão não se grava', async () => {
    const { app: api } = await routes();

    await api.inject({ method: 'POST', url: '/dungeon-blueprints', payload: { id: 'corpo-real', kind: 'base', content: REAL_EXPORT } });

    const floating = await api.inject({
      method: 'POST',
      url: '/dungeons',
      payload: { ...cripta(), body: { blueprint: 'corpo-real', arrival: { x: 3, y: 2, z: 0 }, points: [] } },
    });
    const good = await api.inject({ method: 'POST', url: '/dungeons', payload: cripta() });

    expect(floating.statusCode).toBe(422);
    expect(floating.json<{ error: string }>().error).toBe('BODY_ARRIVAL_INVALID');
    expect(good.statusCode).toBe(201);

    const remove = await api.inject({ method: 'DELETE', url: '/dungeon-blueprints/corpo-real' });

    expect(remove.statusCode).toBe(409);
    expect(remove.json<{ message: string }>().message).toContain('corpo');
  });

  it('o corpo tem de existir no acervo', async () => {
    const { app: api } = await routes();
    const response = await api.inject({ method: 'POST', url: '/dungeons', payload: cripta() });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe('BLUEPRINT_MISSING');
  });
});

describe('as plantas de antes da 099', () => {
  it('ganham a contagem dos marcadores uma vez, no boot', () => {
    const { db, blueprints } = world();

    blueprints.save({ id: 'corpo-real', name: 'Corpo', kind: 'base', content: REAL_EXPORT, origin: 'import' });
    db.prepare('UPDATE dungeon_blueprints SET markers = NULL').run();

    expect(blueprints.summary('corpo-real')?.markers).toBeNull();
    expect(blueprints.backfillMarkers()).toBe(1);
    expect(blueprints.summary('corpo-real')?.markers).toEqual({ npc: 2, crate: 2, arrival: 1 });
    expect(blueprints.backfillMarkers()).toBe(0);
  });
});

describe('a pé, da chegada até o ponto', () => {
  const crate = (id: string, x: number, z: number): BodyPointInput => ({
    id,
    kind: 'crate',
    label: '',
    x,
    y: 0,
    z,
    yaw: 0,
    profile: 'green',
    amount: 1,
    prefab: '',
    source: 'manual',
  });
  const arrival = { x: 0, y: 0, z: 0, yaw: 0, source: 'manual' as const };

  it('na exportação real, a porta do meio deixa tudo alcançável', () => {
    const problems = checkBodyPoints(realAnalysis(), [crate('p-a', 6, 0), crate('p-b', 6, 3)], arrival);

    expect(problems.filter((problem) => problem.code === 'unreachable')).toEqual([]);
  });

  it('trocar a porta por parede, e fechar a passagem de cima, lacra os dois cômodos do fundo', () => {
    const real = realAnalysis();
    const sealed: BodyAnalysis = {
      ...real,
      props: [],
      pieces: [
        ...real.pieces.map((piece) => (piece.shape === 'doorway' ? { ...piece, shape: 'wall' as const } : piece)),
        // Entre (0,0) e (0,1): parede deitada, comprimento em x.
        { shape: 'wall', x: 0, y: 0, z: 1.5, yaw: 90, grade: 2, skin: 0 },
      ],
    };

    const codes = checkBodyPoints(sealed, [crate('p-a', 6, 0), crate('p-b', 0, 3)], arrival).map(
      (problem) => `${problem.id}:${problem.code}`,
    );

    expect(codes).toEqual(['p-a:unreachable', 'p-b:unreachable']);
  });

  it('com triângulo no andar, a régua não opina', () => {
    const real = realAnalysis();
    const odd: BodyAnalysis = {
      ...real,
      props: [],
      pieces: [...real.pieces, { shape: 'floor-triangle', x: 9, y: 0, z: 0, yaw: 0, grade: 2, skin: 0 }],
    };

    expect(checkBodyPoints(odd, [crate('p-a', 6, 0)], arrival).filter((p) => p.code === 'unreachable')).toEqual([]);
  });
});
