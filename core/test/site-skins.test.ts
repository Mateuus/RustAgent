// ============================================================
//  site-skins.test.ts  -  a skin vendida no site vira posse, e o
//  catálogo de skins chega ao site.
//
//  Docs/OrigemZWorkshop/04. Cada linha da tabela de recusas do §3
//  tem um caso aqui, mais:
//
//    - `skin_revoke` sem posse é `delivered` (e reexecuta);
//    - a MESMA tarefa (`DLV`) repetida não dá a skin duas vezes;
//    - a linha órfã de `skin` vira AGENT_INDETERMINATE, porque dar de
//      novo SOMA o prazo;
//    - o espelho não empurra quando a `version` bate, e o 404 é um
//      `debug` por boot, não um aviso a cada volta.
//
//  Nada sai da máquina: o `fetch` é um dublê e o banco é de memória.
// ============================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { SiteDeliveriesRepository } from '../src/db/site-deliveries-repository.js';
import { DAY_MS, WorkshopOwnedRepository } from '../src/db/workshop-owned-repository.js';
import { WorkshopSkinsRepository } from '../src/db/workshop-repository.js';
import { WorkshopCatalog } from '../src/game/workshop-catalog.js';
import { createLogger, type Logger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import { SiteDeliveries, skinOfPayload, skinRevokeOfPayload } from '../src/site/deliveries.js';
import { createSkinDeliveryHandlers, type SkinDeliveryHandlers } from '../src/site/skin-deliveries.js';
import {
  buildSkinsMirror,
  skinCategoryOf,
  SkinsSiteMirror,
  type SkinMirrorEntry,
} from '../src/site/skins-mirror.js';
import { workshopSkinInputSchema } from '../src/types/workshop.js';

const SERVER = 'server01';
const OTHER = 'server02';
const STEAM_ID = '76561198000000000';
const WORKSHOP_ID = '3802433262';
const NOW = 1_800_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

// ============================================================
//  O dublê do site
// ============================================================

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Responder = (call: Call) => { readonly status: number; readonly body?: unknown };

function clientOf(responder: Responder, calls: Call[], serverId = 'RUST01'): SiteClient {
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET',
      path: new URL(String(url)).pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    };

    calls.push(call);

    const answer = responder(call);

    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return new SiteClient({
    baseUrl: 'https://site.example',
    token: 'tok',
    serverId,
    userAgent: 'OrigemZ-Rust-Agent/teste',
    logger: silent,
    fetchImpl,
  });
}

// ============================================================
//  O agente de mentira: banco, catálogo e fila
// ============================================================

function world() {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: `Dev ${String(index + 1)}`,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }

  const items = new ItemsRepository(db);

  items.replace({
    items: [
      { shortname: 'rifle.ak', displayName: 'Assault Rifle', itemId: 1, category: 'Weapon', maxStack: 1, hasCondition: true },
      { shortname: 'hoodie', displayName: 'Hoodie', itemId: 2, category: 'Attire', maxStack: 1, hasCondition: false },
      { shortname: 'gears', displayName: 'Gears', itemId: 3, category: 'Component', maxStack: 20, hasCondition: false },
    ],
    protocol: 'teste',
    at: 1,
  });

  const skins = new WorkshopSkinsRepository(db);
  const owned = new WorkshopOwnedRepository(db);
  const ownershipChanged: string[] = [];
  const catalog = new WorkshopCatalog({
    skins,
    owned,
    items,
    serverIds: () => [SERVER, OTHER],
    lookup: () => Promise.resolve({ status: 'not_found' }),
    onChange: () => undefined,
    onOwnershipChange: (steamId) => ownershipChanged.push(steamId),
  });

  const addSkin = (patch: Record<string, unknown> = {}) =>
    skins.add(
      workshopSkinInputSchema.parse({
        label: 'AK Brasa',
        shortname: 'rifle.ak',
        skinId: WORKSHOP_ID,
        servers: [SERVER],
        ...patch,
      }),
      { source: 'panel', createdBy: 'teste', workshopTitle: null, previewUrl: 'https://img.example/ak.png' },
    );

  return { db, items, skins, owned, catalog, ownershipChanged, addSkin };
}

type World = ReturnType<typeof world>;

function queueOf(
  w: World,
  pages: () => readonly unknown[],
  options: { handlers?: SkinDeliveryHandlers | null } = {},
) {
  const calls: Call[] = [];
  const repository = new SiteDeliveriesRepository(w.db);
  const handlers =
    options.handlers === undefined
      ? createSkinDeliveryHandlers({ catalog: w.catalog, audit: w.owned, now: () => NOW })
      : options.handlers;
  let presenceAsked = 0;

  const client = clientOf((call) => {
    if (call.path.endsWith('/deliveries/pending')) {
      return { status: 200, body: { ok: true, deliveries: pages(), next: null } };
    }

    return { status: 200, body: { ok: true, applied: 1, unknown: [] } };
  }, calls);

  const queue = new SiteDeliveries({
    client,
    repository,
    serverId: SERVER,
    presence: () => {
      presenceAsked += 1;

      // Ninguém online, e nem dá para perguntar: a skin não pode
      // depender disso.
      return Promise.resolve(null);
    },
    deliver: () => Promise.reject(new Error('a skin não passa pelo deliver')),
    ...(handlers === null ? {} : { grantSkin: handlers.grantSkin, revokeSkin: handlers.revokeSkin }),
    logger: silent,
    now: () => NOW,
  });

  const acks = (): { id: string; status: string; reason?: string }[] =>
    calls
      .filter((call) => call.path.endsWith('/deliveries/ack'))
      .flatMap((call) => (call.body as { deliveries: { id: string; status: string; reason?: string; at: string }[] }).deliveries)
      .map(({ at: _at, ...rest }) => rest);

  return { queue, repository, calls, acks, presenceAsked: () => presenceAsked };
}

function skinTask(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    id: 'DLV-5b9cf2b0731a',
    steamId: STEAM_ID,
    kind: 'skin',
    payload: { shortname: 'rifle.ak', workshopId: WORKSHOP_ID, days: null, ...payload },
    sourceRef: 'order:1234',
    ...over,
  };
}

function revokeTask(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    id: 'DLV-7c2e4f6a8b10',
    steamId: STEAM_ID,
    kind: 'skin_revoke',
    payload: { shortname: 'rifle.ak', workshopId: WORKSHOP_ID, ...payload },
    sourceRef: 'refund:1234',
    ...over,
  };
}

function actions(w: World): string[] {
  return w.owned
    .audit({ limit: 100 })
    .map((entry) => entry.action)
    // O resumo da 097 nasce em todo banco novo.
    .filter((action) => !action.startsWith('migration.'))
    .reverse();
}

// ============================================================
//  kind: skin
// ============================================================

describe('a entrega `skin`', () => {
  it('grava a posse permanente, registra, avisa e ACKa delivered — sem perguntar a presença', async () => {
    const w = world();
    const skin = w.addSkin();
    const q = queueOf(w, () => [skinTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'delivered' }]);
    expect(q.presenceAsked()).toBe(0);
    expect(q.repository.get('DLV-5b9cf2b0731a')?.state).toBe('delivered');

    const owned = w.owned.find(STEAM_ID, skin.id);

    expect(owned).toMatchObject({ expiresAt: null, source: 'site', sourceRef: 'DLV-5b9cf2b0731a', createdBy: 'site:order:1234' });
    expect(w.ownershipChanged).toEqual([STEAM_ID]);
    expect(actions(w)).toEqual(['owned.grant', 'site.delivered']);

    const delivered = w.owned.audit({ limit: 1 })[0];

    expect(delivered).toMatchObject({ source: 'site', steamId: STEAM_ID, serverId: SERVER });
    expect(delivered?.detail).toMatchObject({ deliveryId: 'DLV-5b9cf2b0731a', kind: 'skin', sourceRef: 'order:1234', created: true });
  });

  it.each([
    ['workshopId como número', { workshopId: 3802433262 }],
    ['workshopId com zero à esquerda', { workshopId: '03802433262' }],
    ['sem days (ausente NÃO é permanente)', { days: undefined }],
    ['days zero', { days: 0 }],
    ['days acima de 3650', { days: 3651 }],
    ['shortname com espaço', { shortname: 'rifle ak' }],
  ])('payload inválido (%s): failed PAYLOAD_INVALID, sem reserva', async (_name, payload) => {
    const w = world();

    w.addSkin();

    const q = queueOf(w, () => [skinTask({}, payload)]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'failed', reason: 'PAYLOAD_INVALID' }]);
    expect(q.repository.get('DLV-5b9cf2b0731a')).toBeNull();
    expect(w.owned.listOwned({ steamId: STEAM_ID }).owned).toEqual([]);
  });

  it('fora do catálogo: deferred SKIN_NOT_IN_CATALOG, solta a reserva, e passa quando o par volta', async () => {
    const w = world();
    const q = queueOf(w, () => [skinTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'deferred', reason: 'SKIN_NOT_IN_CATALOG' }]);
    expect(q.repository.get('DLV-5b9cf2b0731a')).toBeNull();

    const skin = w.addSkin();

    await q.queue.poll();

    expect(q.acks().at(-1)).toEqual({ id: 'DLV-5b9cf2b0731a', status: 'delivered' });
    expect(w.owned.find(STEAM_ID, skin.id)).not.toBeNull();
  });

  it('skin DESLIGADA: delivered, e a posse é gravada', async () => {
    const w = world();
    const skin = w.addSkin({ enabled: false });
    const q = queueOf(w, () => [skinTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'delivered' }]);
    expect(w.owned.find(STEAM_ID, skin.id)).not.toBeNull();
    expect(w.owned.audit({ limit: 1 })[0]?.detail).toMatchObject({ skinEnabled: false });
  });

  it('skin em NENHUM servidor: delivered, e a posse é gravada', async () => {
    const w = world();
    const skin = w.addSkin({ servers: [] });
    const q = queueOf(w, () => [skinTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'delivered' }]);
    expect(w.owned.find(STEAM_ID, skin.id)).not.toBeNull();
    expect(w.owned.audit({ limit: 1 })[0]?.detail).toMatchObject({ skinServers: [] });
  });

  it('duas compras de 30 dias SOMAM o prazo', async () => {
    const w = world();
    const skin = w.addSkin();
    let tasks = [skinTask({ id: 'DLV-000000000001' }, { days: 30 })];
    const q = queueOf(w, () => tasks);

    await q.queue.poll();
    tasks = [skinTask({ id: 'DLV-000000000002' }, { days: 30 })];
    await q.queue.poll();

    expect(w.owned.find(STEAM_ID, skin.id)?.expiresAt).toBe(NOW + 60 * DAY_MS);
  });

  it('a MESMA tarefa repetida reACKa delivered e não dá a skin de novo', async () => {
    const w = world();
    const skin = w.addSkin();
    const q = queueOf(w, () => [skinTask({}, { days: 30 })]);

    await q.queue.poll();
    await q.queue.poll();

    expect(q.acks()).toEqual([
      { id: 'DLV-5b9cf2b0731a', status: 'delivered' },
      { id: 'DLV-5b9cf2b0731a', status: 'delivered' },
    ]);
    expect(w.owned.find(STEAM_ID, skin.id)?.expiresAt).toBe(NOW + 30 * DAY_MS);
    expect(actions(w).filter((action) => action === 'owned.grant')).toHaveLength(1);
  });

  it('linha órfã de `skin`: AGENT_INDETERMINATE, sem executar', async () => {
    const w = world();
    const skin = w.addSkin();
    const q = queueOf(w, () => [skinTask()]);

    q.repository.reserve(
      { id: 'DLV-5b9cf2b0731a', serverId: SERVER, steamId: STEAM_ID, kind: 'skin', payload: '{}', sourceRef: null },
      NOW,
    );

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'deferred', reason: 'AGENT_INDETERMINATE' }]);
    expect(q.repository.get('DLV-5b9cf2b0731a')?.state).toBe('indeterminate');
    expect(w.owned.find(STEAM_ID, skin.id)).toBeNull();
  });

  it('erro de banco: não ACKa, a reserva fica, e a volta seguinte a manda para revisão', async () => {
    const w = world();

    w.addSkin();

    const q = queueOf(w, () => [skinTask()], {
      handlers: {
        grantSkin: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
        revokeSkin: () => ({ removed: false }),
      },
    });

    await q.queue.poll();

    expect(q.acks()).toEqual([]);
    expect(q.repository.get('DLV-5b9cf2b0731a')?.state).toBe('reserved');

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'deferred', reason: 'AGENT_INDETERMINATE' }]);
  });

  it('SteamID fora da régua da posse vira PAYLOAD_INVALID definitivo', async () => {
    const w = world();

    w.addSkin();

    const q = queueOf(w, () => [skinTask({ steamId: '12345678901234567' })]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-5b9cf2b0731a', status: 'failed', reason: 'PAYLOAD_INVALID' }]);
    expect(q.repository.get('DLV-5b9cf2b0731a')?.state).toBe('failed');
  });

  it('sem o catálogo ligado: failed SKIN_GRANTER_UNAVAILABLE', async () => {
    const w = world();
    const q = queueOf(w, () => [skinTask(), revokeTask()], { handlers: null });

    await q.queue.poll();

    expect(q.acks()).toEqual([
      { id: 'DLV-5b9cf2b0731a', status: 'failed', reason: 'SKIN_GRANTER_UNAVAILABLE' },
      { id: 'DLV-7c2e4f6a8b10', status: 'failed', reason: 'SKIN_GRANTER_UNAVAILABLE' },
    ]);
  });
});

// ============================================================
//  kind: skin_revoke
// ============================================================

describe('a entrega `skin_revoke`', () => {
  it('tira a posse, registra owned.revoke com o sourceRef e avisa', async () => {
    const w = world();
    const skin = w.addSkin();

    w.catalog.grantOwnership({ steamId: STEAM_ID, skinRef: skin.id, days: 30, source: 'panel', createdBy: 'admin' }, NOW);
    w.ownershipChanged.length = 0;

    const q = queueOf(w, () => [revokeTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-7c2e4f6a8b10', status: 'delivered' }]);
    expect(w.owned.find(STEAM_ID, skin.id)).toBeNull();
    expect(w.ownershipChanged).toEqual([STEAM_ID]);

    const [delivered, revoked] = w.owned.audit({ limit: 2 });

    expect(revoked).toMatchObject({ action: 'owned.revoke', source: 'site' });
    expect(revoked?.detail).toMatchObject({ removed: true, sourceRef: 'refund:1234', grantedBy: 'admin' });
    expect(delivered).toMatchObject({ action: 'site.delivered' });
    expect(delivered?.detail).toMatchObject({ kind: 'skin_revoke', removed: true });
  });

  it('sem posse para tirar: delivered, sem reason', async () => {
    const w = world();

    w.addSkin();

    const q = queueOf(w, () => [revokeTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-7c2e4f6a8b10', status: 'delivered' }]);
    expect(w.ownershipChanged).toEqual([]);
    expect(w.owned.audit({ limit: 1 })[0]?.detail).toMatchObject({ removed: false });
  });

  it('skin fora do catálogo: delivered (a posse caiu junto com ela)', async () => {
    const w = world();
    const q = queueOf(w, () => [revokeTask()]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-7c2e4f6a8b10', status: 'delivered' }]);
    expect(w.owned.audit({ limit: 1 })[0]?.detail).toMatchObject({ inCatalog: false, removed: false });
  });

  it('payload inválido: failed PAYLOAD_INVALID', async () => {
    const w = world();
    const q = queueOf(w, () => [revokeTask({}, { workshopId: 1 })]);

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-7c2e4f6a8b10', status: 'failed', reason: 'PAYLOAD_INVALID' }]);
  });

  it('linha órfã: REEXECUTA, porque tirar duas vezes não tira nada na segunda', async () => {
    const w = world();
    const skin = w.addSkin();

    w.catalog.grantOwnership({ steamId: STEAM_ID, skinRef: skin.id, source: 'panel', createdBy: 'admin' }, NOW);

    const q = queueOf(w, () => [revokeTask()]);

    q.repository.reserve(
      { id: 'DLV-7c2e4f6a8b10', serverId: SERVER, steamId: STEAM_ID, kind: 'skin_revoke', payload: '{}', sourceRef: null },
      NOW,
    );

    await q.queue.poll();

    expect(q.acks()).toEqual([{ id: 'DLV-7c2e4f6a8b10', status: 'delivered' }]);
    expect(w.owned.find(STEAM_ID, skin.id)).toBeNull();
    expect(q.repository.get('DLV-7c2e4f6a8b10')?.state).toBe('delivered');
  });
});

// ============================================================
//  As fixtures do contrato (PROPOSTA oz-rust/8)
// ============================================================

describe('as fixtures propostas de skin', () => {
  const fixtures = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '..', '..', 'contracts', 'oz-rust-fixtures.json'), 'utf8'),
  ) as {
    routes: Record<string, { responses: { origin: string; body?: { deliveries?: { kind: string; payload: unknown }[] } }[] }>;
  };

  const tasks = fixtures.routes['deliveries-pending']?.responses
    .filter((response) => response.origin === 'proposal')
    .flatMap((response) => response.body?.deliveries ?? []) ?? [];

  it('há um exemplo de cada kind novo', () => {
    expect(tasks.map((task) => task.kind).sort()).toEqual(['skin', 'skin_revoke']);
  });

  it('os payloads passam na régua do agente', () => {
    for (const task of tasks) {
      const parsed = task.kind === 'skin' ? skinOfPayload(task.payload) : skinRevokeOfPayload(task.payload);

      expect(parsed, task.kind).not.toBeNull();
    }
  });

  it('o corpo proposto do espelho é o que o agente monta', () => {
    const request = (fixtures.routes['skins-mirror'] as unknown as { request: { skins: SkinMirrorEntry[] } }).request;
    const rebuilt = buildSkinsMirror(request.skins);

    expect(rebuilt.skins).toEqual(request.skins);
    expect(Object.keys(rebuilt).sort()).toEqual(['skins', 'version']);
  });
});

// ============================================================
//  O espelho
// ============================================================

interface LogCall {
  readonly level: string;
  readonly message: string;
}

function spyLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: string) =>
    (_fields: unknown, message: string): void => {
      calls.push({ level, message });
    };

  return {
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } as unknown as Logger,
    calls,
  };
}

function mirrorOf(
  w: World,
  responders: ReadonlyMap<string, Responder>,
  options: { now?: () => number } = {},
) {
  const calls = new Map<string, Call[]>();
  const clients = new Map<string, SiteClient>();

  for (const [id, responder] of responders) {
    const list: Call[] = [];

    calls.set(id, list);
    clients.set(id, clientOf(responder, list, id === SERVER ? 'RUST01' : 'RUST02'));
  }

  const log = spyLogger();
  const mirror = new SkinsSiteMirror({
    clients,
    skins: w.skins,
    items: w.items,
    siteServerIdOf: (id) => (id === SERVER ? 'RUST01' : null),
    logger: log.logger,
    intervalMs: 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { mirror, calls, log };
}

describe('o espelho de skins', () => {
  it('monta o retrato da rede: categoria do espelho de itens, servidor pelo id do site, ordem estável', () => {
    const w = world();

    w.addSkin({ servers: [SERVER, OTHER], rarity: 'epic', description: 'Fogo.' });
    w.addSkin({ label: 'Engrenagem', shortname: 'gears', skinId: '12', servers: [] });
    w.addSkin({ label: 'Sem item', shortname: 'bota.inexistente', skinId: '99', openToAll: true });

    const { mirror } = mirrorOf(w, new Map());
    const snapshot = mirror.snapshot();

    expect(snapshot.skins.map((skin) => [skin.shortname, skin.category])).toEqual([
      ['bota.inexistente', 'misc'],
      ['gears', 'misc'],
      ['rifle.ak', 'weapon'],
    ]);
    expect(snapshot.skins[2]).toEqual({
      shortname: 'rifle.ak',
      workshopId: WORKSHOP_ID,
      label: 'AK Brasa',
      description: 'Fogo.',
      rarity: 'epic',
      category: 'weapon',
      previewUrl: 'https://img.example/ak.png',
      openToAll: false,
      enabled: true,
      // O server02 não está pareado: some.
      servers: ['RUST01'],
    });
    expect(snapshot.version).toMatch(/^[0-9a-f]{64}$/);
    expect(mirror.snapshot().version).toBe(snapshot.version);
    expect(buildSkinsMirror([...snapshot.skins].reverse()).version).toBe(snapshot.version);
  });

  it('a categoria desconhecida vira misc', () => {
    expect(skinCategoryOf('Attire')).toBe('attire');
    expect(skinCategoryOf('Component')).toBe('misc');
    expect(skinCategoryOf(undefined)).toBe('misc');
  });

  it('version igual: pergunta e NÃO empurra', async () => {
    const w = world();

    w.addSkin();

    const version = mirrorOf(w, new Map()).mirror.snapshot().version;
    const { mirror, calls } = mirrorOf(
      w,
      new Map([[SERVER, (): { status: number; body: unknown } => ({ status: 200, body: { ok: true, version } })]]),
    );

    await mirror.push();

    expect(calls.get(SERVER)?.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/agent/skins/mirror/version',
    ]);
  });

  it('version diferente: empurra o snapshot, por TODOS os pareamentos', async () => {
    const w = world();

    w.addSkin();

    const responder: Responder = (call) =>
      call.method === 'GET'
        ? { status: 200, body: { ok: true, version: null } }
        : { status: 200, body: { ok: true, accepted: true } };
    const { mirror, calls } = mirrorOf(
      w,
      new Map([
        [SERVER, responder],
        [OTHER, responder],
      ]),
    );

    await mirror.push();

    for (const id of [SERVER, OTHER]) {
      const list = calls.get(id) ?? [];

      expect(list.map((call) => `${call.method} ${call.path}`)).toEqual([
        'GET /api/agent/skins/mirror/version',
        'POST /api/agent/skins/mirror',
      ]);
      expect(list[1]?.body).toEqual(mirror.snapshot());
    }
  });

  it('catálogo vazio também vai: o site precisa tirar tudo da vitrine', async () => {
    const w = world();
    const { mirror, calls } = mirrorOf(
      w,
      new Map([[SERVER, (call: Call) => ({ status: 200, body: call.method === 'GET' ? { version: 'x' } : { ok: true } })]]),
    );

    await mirror.push();

    expect(calls.get(SERVER)?.[1]?.body).toMatchObject({ skins: [] });
  });

  it('404: um debug por boot, silêncio até a volta do relógio, e tenta de novo', async () => {
    const w = world();
    let now = NOW;
    const { mirror, calls, log } = mirrorOf(
      w,
      new Map([[SERVER, (): { status: number; body: unknown } => ({ status: 404, body: { error: 'Not found' } })]]),
      { now: () => now },
    );

    await mirror.push();
    // Um aviso de mudança logo depois não bate na porta de novo.
    now += 5_000;
    await mirror.push();

    expect(calls.get(SERVER)).toHaveLength(1);

    // A volta seguinte do relógio tenta, e continua quieta.
    now = NOW + 60_000;
    await mirror.push();

    expect(calls.get(SERVER)).toHaveLength(2);
    expect(log.calls.filter((call) => call.level === 'debug')).toHaveLength(1);
    expect(log.calls.filter((call) => call.level === 'warn' || call.level === 'error')).toEqual([]);
  });

  it('outro erro do site é aviso', async () => {
    const w = world();
    const { mirror, log } = mirrorOf(
      w,
      new Map([[SERVER, (): { status: number; body: unknown } => ({ status: 500, body: { error: 'boom' } })]]),
    );

    await mirror.push();

    expect(log.calls.filter((call) => call.level === 'warn')).toHaveLength(1);
  });
});
