// ============================================================
//  As skins do Workshop, do lado do agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Esta feature falha CALADA por natureza: o servidor aceita
//  qualquer `ulong` em `item.skin` e nunca reclama, e o menu mostra
//  cadeado no que o plugin não sabe. Os casos abaixo são os que
//  produzem esse silêncio:
//
//    migração que perde posse   um acesso de coleção que não vira
//                               posse, um grupo descartado sem
//                               registro, uma skin grátis que vira
//                               cadeado
//    duas regras de prazo       o painel soma, o site substitui
//    duas portas, duas regras   o painel confere a Steam e o
//                               `/skin add` do jogo não
//    aviso forjado              um jogador digita `#OZWORKSHOP#` no
//                               chat e se dá uma skin
//    carga grande demais        o frame é truncado e o plugin troca
//                               uma carga boa por meia
//    lista vazia não mandada    o plugin fica em "não sei" para
//                               sempre com quem não tem nada
//    comando de dentro do gancho  a linha volta pelo console e o
//                               agente entra em laço com ele mesmo
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StreamerRepository } from '../src/db/streamer-repository.js';
import { DAY_MS, renewedExpiry, WorkshopOwnedRepository } from '../src/db/workshop-owned-repository.js';
import { WorkshopSkinsRepository } from '../src/db/workshop-repository.js';
import { decodePushPayload, MAX_PUSH_BYTES } from '../src/game/plugin-push.js';
import type { WorkshopLookup, WorkshopLookupFn } from '../src/game/steam-workshop.js';
import {
  WORKSHOP_CHUNK_CHARS,
  WORKSHOP_MARKER,
  WORKSHOP_OWNED,
  WORKSHOP_REPLY,
  WORKSHOP_SYNC,
  WorkshopService,
} from '../src/game/workshop.js';
import { WorkshopCatalog, type WorkshopActor } from '../src/game/workshop-catalog.js';
import { ApiError, apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerPlayerRoutes } from '../src/http/routes/players.js';
import { registerWorkshopRoutes } from '../src/http/routes/workshop.js';
import type { PlayerDirectory } from '../src/players/service.js';
import { STREAMER_MARKER } from '../src/types/streamer-transport.js';
import {
  grantOwnershipInputSchema,
  workshopSkinBodySchema,
  workshopSkinInputSchema,
  type WorkshopOwnedPayload,
  type WorkshopPayload,
  type WorkshopSkinBody,
} from '../src/types/workshop.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const OTHER = 'server02';
const PLAYER = '76561190000000001';
const PLAYER_2 = '76561190000000002';
const PLAYER_3 = '76561190000000003';
const PANEL: WorkshopActor = { name: 'admin', source: 'panel' };
const T0 = 1_800_000_000_000;

/** O que a Steam respondeu para o 3802433262, MEDIDO em 16/09/2026. */
const FACEMASK: WorkshopLookup = {
  status: 'found',
  details: {
    workshopId: '3802433262',
    title: 'MetalFacemaskOrigemZ',
    previewUrl: 'https://images.steamusercontent.com/ugc/x/',
    appId: 252490,
    banned: false,
    tags: ['Metal Facemask'],
  },
};

interface SentCommand {
  readonly server: string;
  readonly command: string;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly service: WorkshopService;
  readonly catalog: WorkshopCatalog;
  readonly skins: WorkshopSkinsRepository;
  readonly owned: WorkshopOwnedRepository;
  readonly items: ItemsRepository;
  readonly servers: ServersRepository;
  readonly streamers: StreamerRepository;
  readonly meta: MetaRepository;
  /** Todo comando que saiu pelo RCON, na ordem, com o servidor. */
  readonly sent: SentCommand[];
  /** Workshop ID -> o que a "Steam" responde. Ausente = não existe. */
  readonly steam: Map<string, WorkshopLookup>;
  /** servidor -> quem está online. */
  readonly online: Map<string, string[]>;
  /** Quem teve a posse avisada pelo catálogo. */
  readonly ownershipChanged: string[];
  connected: boolean;
  now: number;
}

function seedServers(servers: ServersRepository): void {
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
}

function seedItems(items: ItemsRepository): void {
  const item = (shortname: string, displayName: string, itemId: number) => ({
    shortname,
    displayName,
    itemId,
    category: 'Attire',
    maxStack: 1,
    hasCondition: true,
  });

  items.replace({
    items: [
      item('metal.facemask', 'Metal Facemask', -194953424),
      item('hoodie', 'Hoodie', 1751045826),
      item('hatchet', 'Hatchet', -1469578201),
      item('rifle.ak', 'Assault Rifle', 1545779598),
      item('rock', 'Rock', 963906841),
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });
}

function harness(options: { storeUrl?: string } = {}): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);
  const items = new ItemsRepository(db);

  seedServers(servers);
  seedItems(items);

  const skins = new WorkshopSkinsRepository(db);
  const owned = new WorkshopOwnedRepository(db);
  const streamers = new StreamerRepository(db);
  const meta = new MetaRepository(db);
  const steam = new Map<string, WorkshopLookup>([['3802433262', FACEMASK]]);

  const lookup: WorkshopLookupFn = (id) => Promise.resolve(steam.get(id) ?? { status: 'not_found' });

  const state = {
    db,
    skins,
    owned,
    items,
    servers,
    streamers,
    meta,
    sent: [] as SentCommand[],
    steam,
    online: new Map<string, string[]>([
      [SERVER, []],
      [OTHER, []],
    ]),
    ownershipChanged: [] as string[],
    connected: true,
    now: T0,
  } as Omit<Harness, 'service' | 'catalog'> & { service: WorkshopService; catalog: WorkshopCatalog };

  const rconOf = (server: string) => ({
    get isConnected() {
      return state.connected;
    },
    send: (command: string) => {
      state.sent.push({ server, command });

      if (
        command.startsWith(WORKSHOP_SYNC) ||
        command.startsWith(WORKSHOP_OWNED) ||
        command.startsWith(WORKSHOP_REPLY)
      ) {
        return Promise.resolve(JSON.stringify({ ok: true }));
      }

      return Promise.resolve('');
    },
  });

  const rcons = new Map([
    [SERVER, rconOf(SERVER)],
    [OTHER, rconOf(OTHER)],
  ]);

  state.catalog = new WorkshopCatalog({
    skins,
    owned,
    items,
    serverIds: () => [SERVER, OTHER],
    lookup,
    onChange: () => undefined,
    onOwnershipChange: (steamId) => {
      state.ownershipChanged.push(steamId);
      state.service.handleOwnershipChanged(steamId);
    },
  });

  state.service = new WorkshopService({
    skins,
    owned,
    catalog: state.catalog,
    meta,
    streamers,
    servers: {
      ids: () => [SERVER, OTHER],
      contextOf: (id) => {
        const rcon = rcons.get(id);

        return rcon === undefined ? null : { rcon };
      },
      onlineOf: (id) => state.online.get(id) ?? [],
    },
    ...(options.storeUrl === undefined ? {} : { storeUrl: options.storeUrl }),
    logger: silent,
    now: () => state.now,
  });

  return state;
}

/** Um cadastro completo, pelo mesmo caminho que a rota usa. */
function body(patch: Record<string, unknown> = {}): WorkshopSkinBody {
  return workshopSkinBodySchema.parse({
    label: 'Máscara OrigemZ',
    shortname: 'metal.facemask',
    skinId: '3802433262',
    servers: [SERVER],
    ...patch,
  });
}

/** Grava direto no repositório, sem Steam. */
function addSkin(h: Harness, patch: Record<string, unknown> = {}) {
  return h.skins.add(workshopSkinInputSchema.parse({ ...body(), ...patch }), {
    source: 'panel',
    createdBy: 'teste',
    workshopTitle: null,
    previewUrl: null,
  });
}

/** Dá a posse direto no repositório, sem registro nem aviso. */
function give(h: Harness, steamId: string, skinRef: number, extra: { days?: number | null; expiresAt?: number | null } = {}) {
  return h.owned.grantOwnership(
    { steamId, skinRef, source: 'panel', createdBy: 'teste', ...extra },
    h.now,
  );
}

/** Remonta o último lote de um comando, juntando os pedaços. */
function lastBatch(h: Harness, prefix: string, server?: string): unknown {
  const commands = h.sent
    .filter((entry) => server === undefined || entry.server === server)
    .map((entry) => entry.command)
    .filter((line) => line.startsWith(`${prefix} `));
  const last = commands.at(-1);

  if (last === undefined) throw new Error(`nenhum ${prefix} saiu`);

  const tail = (line: string) => line.slice(prefix.length + 1).split(' ');
  const [batch, , total] = tail(last);
  const parts = commands
    .filter((line) => tail(line)[0] === batch)
    .slice(-Number(total))
    .map((line) => tail(line)[3] ?? '');

  return decodePushPayload(parts.join(''));
}

function lastPayload(h: Harness): WorkshopPayload {
  return lastBatch(h, WORKSHOP_SYNC) as WorkshopPayload;
}

function lastOwned(h: Harness, steamId: string, server?: string): WorkshopOwnedPayload {
  return lastBatch(h, `${WORKSHOP_OWNED} ${steamId}`, server) as WorkshopOwnedPayload;
}

function ownedCommands(h: Harness, steamId: string, server?: string): string[] {
  return h.sent
    .filter((entry) => server === undefined || entry.server === server)
    .map((entry) => entry.command)
    .filter((line) => line.startsWith(`${WORKSHOP_OWNED} ${steamId} `));
}

async function grabSecret(h: Harness): Promise<string> {
  await h.service.sync(SERVER, 'manual');

  return lastPayload(h).secret;
}

/** Deixa os relógios (1 s do sync, 0 do /skin add) dispararem. */
async function settle(ms = 1200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectApiError(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (cause) {
    expect(cause).toBeInstanceOf(ApiError);
    expect((cause as ApiError).code).toBe(code);
    return;
  }

  throw new Error(`esperava ${code}, e nada lançou`);
}

/** Um banco com todas as migrações MENOS as de `skip`. */
function databaseWithout(skip: (id: number) => boolean): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);

  for (const migration of MIGRATIONS.filter((m) => !skip(m.id))) {
    applyMigration(db, migration);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, 0)').run(migration.id, migration.name);
  }

  return db;
}

// ============================================================
//  AS MIGRAÇÕES
// ============================================================

describe('as migrações 096 e 097', () => {
  it('a skin da 095 atravessa as duas reconstruções sem perder linha nem servidor', () => {
    const db = databaseWithout((id) => id > 95);

    seedServers(new ServersRepository(db));

    // Como a 095 gravava: permissão obrigatória.
    db.prepare(
      `INSERT INTO workshop_skins
         (id, label, shortname, skin_id, permission, hide_in_streamer, enabled, created_at, updated_at)
       VALUES (7, 'Pedra', 'rock', '3071657601', 'origemzworkshop.pedra', 0, 1, 5, 6)`,
    ).run();
    db.prepare(`INSERT INTO workshop_skin_servers VALUES (7, ?), (7, ?)`).run(SERVER, OTHER);

    runMigrations(db);

    const skins = new WorkshopSkinsRepository(db);

    expect(skins.get(7)).toMatchObject({
      label: 'Pedra',
      shortname: 'rock',
      skinId: '3071657601',
      description: null,
      rarity: null,
      sort: 0,
      hideInStreamer: false,
      openToAll: false,
      source: 'panel',
      servers: [SERVER, OTHER],
      createdAt: 5,
    });
    expect(skins.get(7)).not.toHaveProperty('permission');

    // E a cascata continua de pé DEPOIS da reconstrução.
    skins.remove(7);
    expect(db.prepare('SELECT count(*) AS n FROM workshop_skin_servers').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  describe('a 097 com dados fabricados', () => {
    /**
     * Um banco de dev de verdade: 098 e 099 JÁ aplicadas, a 097 não.
     *
     *   skin 1  máscara, permissão vip, avulsa
     *   skin 2  moletom, na coleção "neve" (aberta e ligada)
     *   skin 3  AK, na "neve"
     *   skin 4  machado, na "fechada" (aberta, mas DESLIGADA)
     *   skin 5  pedra, na "vipcol" (permissão vip)
     *   coleção "vazia", sem skin nenhuma
     */
    function fabricated(): AgentDatabase {
      const db = databaseWithout((id) => id === 97);

      seedServers(new ServersRepository(db));

      db.exec(`
        INSERT INTO workshop_collections (id, slug, label, permission, open_to_all, enabled, created_at, updated_at) VALUES
          (1, 'neve', 'Neve', NULL, 1, 1, 1, 1),
          (2, 'fechada', 'Fechada', NULL, 1, 0, 1, 1),
          (3, 'vipcol', 'Vip', 'origemzworkshop.vip', 0, 1, 1, 1),
          (4, 'vazia', 'Vazia', 'origemzworkshop.vazia', 0, 1, 1, 1);

        INSERT INTO workshop_skins (id, label, shortname, skin_id, permission, collection_id, open_to_all, source, created_at, updated_at) VALUES
          (1, 'Máscara', 'metal.facemask', '11', 'origemzworkshop.vip', NULL, 0, 'panel', 1, 1),
          (2, 'Moletom', 'hoodie', '22', NULL, 1, 0, 'panel', 1, 1),
          (3, 'AK', 'rifle.ak', '33', NULL, 1, 0, 'game', 1, 1),
          (4, 'Machado', 'hatchet', '44', NULL, 2, 0, 'panel', 1, 1),
          (5, 'Pedra', 'rock', '55', NULL, 3, 0, 'panel', 1, 1);

        INSERT INTO workshop_skin_servers VALUES (1, '${SERVER}'), (3, '${OTHER}');

        INSERT INTO workshop_grants (id, subject_type, subject, target_type, skin_ref, collection_ref, expires_at, note, created_by, created_at, updated_at) VALUES
          (1, 'player', '${PLAYER}', 'skin', 1, NULL, NULL, 'compra antiga', 'admin', 100, 100),
          (2, 'player', '${PLAYER}', 'collection', NULL, 1, ${String(T0 + 1000)}, '', 'admin', 50, 50),
          (3, 'player', '${PLAYER}', 'skin', 2, NULL, ${String(T0 + 5000)}, '', NULL, 200, 200),
          (4, 'player', '${PLAYER_2}', 'skin', 3, NULL, NULL, '', 'admin', 10, 10),
          (5, 'player', '${PLAYER_2}', 'collection', NULL, 1, ${String(T0 + 1000)}, '', 'admin', 10, 10),
          (6, 'group', 'vip', 'skin', 1, NULL, NULL, '', 'admin', 10, 10),
          (7, 'group', 'vip', 'collection', NULL, 3, NULL, '', 'admin', 10, 10),
          (8, 'player', '${PLAYER_3}', 'collection', NULL, 4, NULL, '', 'admin', 10, 10),
          (9, 'player', 'Fulano', 'skin', 1, NULL, NULL, '', 'admin', 10, 10),
          (10, 'player', '${PLAYER_3}', 'skin', 1, NULL, ${String(T0 - 10)}, '', 'admin', 10, 10);

        INSERT INTO workshop_audit (at, actor, source, action, target, detail)
          VALUES (1, 'admin', 'panel', 'skin.create', 'skin #1', '{}');

        INSERT INTO site_deliveries (id, server_id, steam_id, kind, payload, state, reserved_at, updated_at)
          VALUES ('DLV-velha', '${SERVER}', '${PLAYER}', 'vip', '{}', 'delivered', 1, 1);
      `);

      return db;
    }

    it('roda sozinha num banco que já tem a 098 e a 099', () => {
      const db = fabricated();

      expect(runMigrations(db).map((migration) => migration.id)).toEqual([97]);
      expect(runMigrations(db)).toEqual([]);
    });

    it('acesso de jogador vira posse; coleção expande; permanente vence; entre prazos, o maior', () => {
      const db = fabricated();

      runMigrations(db);

      const owned = new WorkshopOwnedRepository(db);
      const rows = owned.listOwned({ limit: 100 }).owned.map((row) => ({
        steamId: row.steamId,
        skinRef: row.skinRef,
        expiresAt: row.expiresAt,
        source: row.source,
      }));

      expect(rows.sort((a, b) => (a.steamId + String(a.skinRef)).localeCompare(b.steamId + String(b.skinRef)))).toEqual([
        { steamId: PLAYER, skinRef: 1, expiresAt: null, source: 'migration' },
        // neve (T0+1000) e acesso direto (T0+5000): o maior.
        { steamId: PLAYER, skinRef: 2, expiresAt: T0 + 5000, source: 'migration' },
        // só pela neve.
        { steamId: PLAYER, skinRef: 3, expiresAt: T0 + 1000, source: 'migration' },
        { steamId: PLAYER_2, skinRef: 2, expiresAt: T0 + 1000, source: 'migration' },
        // permanente direto + neve com prazo: permanente vence.
        { steamId: PLAYER_2, skinRef: 3, expiresAt: null, source: 'migration' },
        // vencida atravessa com o mesmo prazo.
        { steamId: PLAYER_3, skinRef: 1, expiresAt: T0 - 10, source: 'migration' },
      ]);

      expect(owned.find(PLAYER, 1)).toMatchObject({ note: 'compra antiga', createdBy: 'admin', createdAt: 100 });
      // A mais antiga das origens fundidas.
      expect(owned.find(PLAYER, 2)).toMatchObject({ createdAt: 50, createdBy: 'admin' });
    });

    it('coleção aberta e LIGADA propaga o "para todos"; desligada não', () => {
      const db = fabricated();

      runMigrations(db);

      const skins = new WorkshopSkinsRepository(db);

      expect([1, 2, 3, 4, 5].map((id) => skins.get(id)?.openToAll)).toEqual([false, true, true, false, false]);
      expect(skins.get(3)).toMatchObject({ source: 'game', servers: [OTHER] });
      expect(skins.get(1)?.servers).toEqual([SERVER]);
    });

    it('grupo, permissão e coleção descartados ficam no registro', () => {
      const db = fabricated();

      runMigrations(db);

      const audit = new WorkshopOwnedRepository(db).audit({ limit: 100 });
      const byAction = (action: string) => audit.filter((entry) => entry.action === action);

      expect(byAction('migration.group-grant-dropped').map((e) => e.target).sort()).toEqual([
        'coleção "vipcol"',
        'skin #1 "Máscara" (metal.facemask)',
      ]);
      expect(byAction('migration.group-grant-dropped')[0]?.detail).toMatchObject({ subjectType: 'group', subject: 'vip' });

      expect(byAction('migration.permission-dropped').map((e) => [e.target, e.detail])).toEqual(
        expect.arrayContaining([
          ['origemzworkshop.vip', { skins: [1], collections: ['vipcol'] }],
          ['origemzworkshop.vazia', { skins: [], collections: ['vazia'] }],
        ]),
      );
      expect(byAction('migration.permission-dropped')).toHaveLength(2);

      expect(byAction('migration.collection-dropped')).toHaveLength(4);
      expect(byAction('migration.invalid-grant-dropped')).toHaveLength(1);

      const expanded = byAction('migration.collection-grant-expanded');

      expect(expanded).toHaveLength(3);
      // Coleção vazia: registrada, sem posse nenhuma.
      expect(expanded.find((e) => e.steamId === PLAYER_3)?.detail['skins']).toEqual([]);

      expect(byAction('migration.097')[0]?.detail).toEqual({
        grants: 10,
        owned: 6,
        collectionGrantsExpanded: 3,
        groupGrantsDropped: 2,
        invalidGrantsDropped: 1,
        permissionsDropped: 2,
        collectionsDropped: 4,
      });

      // O registro de antes continua lá.
      expect(byAction('skin.create')).toHaveLength(1);
    });

    it('as tabelas velhas somem, a cascata vale e os CHECKs novos aceitam o que devem', () => {
      const db = fabricated();

      runMigrations(db);

      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (row) => row.name,
      );

      expect(tables).not.toContain('workshop_grants');
      expect(tables).not.toContain('workshop_collections');
      expect(tables.filter((name) => /_09[67]$/.test(name))).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Apagar a skin leva a posse.
      new WorkshopSkinsRepository(db).remove(3);
      expect(new WorkshopOwnedRepository(db).listOwned({ skinRef: 3 }).owned).toEqual([]);

      // A fila do site: a entrega velha ficou, e o kind novo entra.
      expect(db.prepare(`SELECT kind FROM site_deliveries WHERE id = 'DLV-velha'`).get()).toEqual({ kind: 'vip' });
      db.prepare(
        `INSERT INTO site_deliveries (id, server_id, steam_id, kind, payload, state, reserved_at, updated_at)
         VALUES ('DLV-skin', ?, ?, 'skin', '{}', 'reserved', 1, 1), ('DLV-rev', ?, ?, 'skin_revoke', '{}', 'reserved', 1, 1)`,
      ).run(SERVER, PLAYER, SERVER, PLAYER);
      expect(() =>
        db.prepare(
          `INSERT INTO site_deliveries (id, server_id, steam_id, kind, payload, state, reserved_at, updated_at)
           VALUES ('DLV-x', ?, ?, 'caixa', '{}', 'reserved', 1, 1)`,
        ).run(SERVER, PLAYER),
      ).toThrow(/CHECK/);

      // O registro aceita a origem 'site'.
      new WorkshopOwnedRepository(db).log({ actor: 'site:order:1', source: 'site', action: 'site.delivered', target: 'x' });

      // A posse recusa SteamID torto e origem desconhecida.
      expect(() =>
        db.prepare(
          `INSERT INTO workshop_owned_skins (steam_id, skin_ref, source, created_by, created_at, updated_at)
           VALUES ('123', 1, 'panel', 'x', 1, 1)`,
        ).run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare(
          `INSERT INTO workshop_owned_skins (steam_id, skin_ref, source, created_by, created_at, updated_at)
           VALUES (?, 1, 'grupo', 'x', 1, 1)`,
        ).run(PLAYER_2),
      ).toThrow(/CHECK/);
    });

    it('num banco novo, sem nada, ela também passa', () => {
      const db = openDatabase({ file: MEMORY_DATABASE });

      expect(runMigrations(db).map((migration) => migration.id)).toContain(97);
      expect(new WorkshopOwnedRepository(db).audit({ limit: 5 })[0]).toMatchObject({
        action: 'migration.097',
        detail: { grants: 0, owned: 0 },
      });
    });
  });
});

// ============================================================
//  AS RÉGUAS
// ============================================================

describe('as réguas', () => {
  it('o Workshop ID nunca é zero, nunca tem zero à esquerda e cabe no UInt64', () => {
    const parse = (skinId: string) => workshopSkinBodySchema.safeParse({ ...body(), skinId }).success;

    expect(parse('0')).toBe(false);
    expect(parse('0307')).toBe(false);
    expect(parse('99999999999999999999')).toBe(false);
    expect(parse('18446744073709551615')).toBe(true);
  });

  it('descrição em branco é nula; raridade só da lista; sem permissão nem coleção', () => {
    expect(body({ description: '   ' }).description).toBeNull();
    expect(body({ description: 'Brasa viva' }).description).toBe('Brasa viva');
    expect(workshopSkinBodySchema.safeParse({ ...body(), description: 'x'.repeat(281) }).success).toBe(false);
    expect(body({ rarity: 'epic' }).rarity).toBe('epic');
    expect(body().rarity).toBeNull();
    expect(workshopSkinBodySchema.safeParse({ ...body(), rarity: 'mythic' }).success).toBe(false);
    expect(body({ sort: 5 }).sort).toBe(5);
    expect(body({ permission: 'vip', collectionId: 3 })).not.toHaveProperty('permission');
  });

  it('a posse exige SteamID64, e dias OU data — nunca os dois', () => {
    const parse = (patch: Record<string, unknown>) =>
      grantOwnershipInputSchema.safeParse({
        steamId: PLAYER,
        skinRef: 1,
        source: 'panel',
        createdBy: 'admin',
        ...patch,
      }).success;

    expect(parse({})).toBe(true);
    expect(parse({ days: 30 })).toBe(true);
    expect(parse({ expiresAt: T0 })).toBe(true);
    expect(parse({ days: 30, expiresAt: T0 })).toBe(false);
    expect(parse({ days: 0 })).toBe(false);
    expect(parse({ days: 3651 })).toBe(false);
    expect(parse({ steamId: 'Fulano' })).toBe(false);
    expect(parse({ source: 'group' })).toBe(false);
  });
});

// ============================================================
//  A TABELA DE RENOVAÇÃO (02 §4.2)
// ============================================================

describe('a tabela de renovação', () => {
  const now = T0;
  const live = { expiresAt: now + 10 * DAY_MS };
  const dead = { expiresAt: now - 1 };
  const forever = { expiresAt: null };

  it.each([
    ['nada + permanente', null, {}, null],
    ['nada + dias', null, { days: 7 }, now + 7 * DAY_MS],
    ['nada + data', null, { expiresAt: now + 5 }, now + 5],
    ['permanente + permanente', forever, {}, null],
    ['permanente + dias (nunca encurta)', forever, { days: 7 }, null],
    ['permanente + data (nunca encurta)', forever, { expiresAt: now + 5 }, null],
    ['prazo + permanente', live, {}, null],
    ['prazo + dias SOMA', live, { days: 7 }, now + 17 * DAY_MS],
    ['prazo + data menor não encurta', live, { expiresAt: now + DAY_MS }, now + 10 * DAY_MS],
    ['prazo + data maior estende', live, { expiresAt: now + 20 * DAY_MS }, now + 20 * DAY_MS],
    ['vencida + dias conta de agora', dead, { days: 7 }, now + 7 * DAY_MS],
    ['vencida + permanente', dead, {}, null],
    ['vencida + data', dead, { expiresAt: now + 5 }, now + 5],
  ] as const)('%s', (_label, current, request, expected) => {
    expect(renewedExpiry(current, request, now)).toBe(expected);
  });

  it('no banco: uma linha só por par, e a vencida renasce com quem deu agora', () => {
    const h = harness();
    const mask = addSkin(h);

    const first = give(h, PLAYER, mask.id, { days: 1 });

    expect(first.created).toBe(true);

    const summed = give(h, PLAYER, mask.id, { days: 2 });

    expect(summed.created).toBe(false);
    expect(summed.owned.expiresAt).toBe(T0 + 3 * DAY_MS);
    expect(summed.owned.id).toBe(first.owned.id);

    // Vence; dar de novo conta de agora e troca o autor.
    h.now = T0 + 4 * DAY_MS;

    const reborn = h.owned.grantOwnership(
      { steamId: PLAYER, skinRef: mask.id, days: 1, source: 'site', sourceRef: 'DLV-1', createdBy: 'site:order:9' },
      h.now,
    );

    expect(reborn).toMatchObject({ created: true, previous: { expiresAt: T0 + 3 * DAY_MS } });
    expect(reborn.owned).toMatchObject({
      expiresAt: h.now + DAY_MS,
      source: 'site',
      sourceRef: 'DLV-1',
      createdBy: 'site:order:9',
      createdAt: h.now,
    });

    // Permanente, e depois dias: continua permanente.
    give(h, PLAYER, mask.id);
    expect(give(h, PLAYER, mask.id, { days: 30 }).owned.expiresAt).toBeNull();

    expect(h.owned.listOwned({ steamId: PLAYER }).owned).toHaveLength(1);
  });

  it('prazo que já passou é recusado nas duas camadas', async () => {
    const h = harness();
    const mask = addSkin(h);

    expect(() => give(h, PLAYER, mask.id, { expiresAt: T0 - 1 })).toThrow(RangeError);
    await expectApiError(
      () =>
        h.catalog.grantOwnership(
          { steamId: PLAYER, skinRef: mask.id, expiresAt: T0 - 1, source: 'panel', createdBy: 'admin' },
          T0,
        ),
      'OWNED_ALREADY_EXPIRED',
    );
    await expectApiError(
      () =>
        h.catalog.grantOwnership(
          { steamId: PLAYER, skinRef: mask.id, days: 1, expiresAt: T0 + 5, source: 'panel', createdBy: 'admin' },
          T0,
        ),
      'INVALID_OWNERSHIP',
    );
    expect(h.owned.listOwned({ steamId: PLAYER }).owned).toHaveLength(0);
  });
});

// ============================================================
//  O CADASTRO — as mesmas regras nas duas portas
// ============================================================

describe('o cadastro', () => {
  it('confere a Steam e usa o título do Workshop quando o nome vem vazio', async () => {
    const h = harness();
    const { skin, warning } = await h.catalog.createSkin(body({ label: '' }), PANEL);

    expect(skin.label).toBe('MetalFacemaskOrigemZ');
    expect(skin.workshopTitle).toBe('MetalFacemaskOrigemZ');
    expect(skin.previewUrl).toContain('steamusercontent');
    expect(warning).toBeNull();
  });

  it('recusa o id que a Steam não conhece', async () => {
    const h = harness();

    await expectApiError(h.catalog.createSkin(body({ skinId: '1234567' }), PANEL), 'WORKSHOP_NOT_FOUND');
    expect(h.skins.list()).toHaveLength(0);
  });

  it('recusa a skin publicada para OUTRO item', async () => {
    const h = harness();

    // A tag da Steam diz "Metal Facemask"; colado no machado, não
    // desenha nada.
    await expectApiError(
      h.catalog.createSkin(body({ shortname: 'hatchet' }), PANEL),
      'WORKSHOP_OTHER_ITEM',
    );
  });

  it('Steam fora do ar não barra: entra, com aviso', async () => {
    const h = harness();

    h.steam.set('555', { status: 'unavailable', reason: 'timeout' });

    const { skin, warning } = await h.catalog.createSkin(body({ skinId: '555', label: '' }), PANEL);

    expect(warning).toContain('timeout');
    // Sem título, o nome sai do item.
    expect(skin.label).toBe('Metal Facemask 555');
  });

  it('recusa item que o jogo não tem e marca repetida', async () => {
    const h = harness();

    await expectApiError(h.catalog.createSkin(body({ shortname: 'pedra.magica' }), PANEL), 'UNKNOWN_BASE_ITEM');

    await h.catalog.createSkin(body(), PANEL);
    await expectApiError(h.catalog.createSkin(body({ label: 'Outra' }), PANEL), 'DUPLICATE_MARK');
  });

  it('várias skins do MESMO item convivem, na ordem do `sort` e depois do nome', async () => {
    const h = harness();

    h.steam.set('111', { status: 'unavailable', reason: 'x' });
    h.steam.set('222', { status: 'unavailable', reason: 'x' });

    await h.catalog.createSkin(body({ label: 'Zeta', sort: 0 }), PANEL);
    await h.catalog.createSkin(body({ skinId: '111', label: 'Alfa', sort: 0 }), PANEL);
    await h.catalog.createSkin(body({ skinId: '222', label: 'Primeira', sort: -1 }), PANEL);

    expect(h.skins.list().map((skin) => skin.label)).toEqual(['Primeira', 'Alfa', 'Zeta']);
    expect(h.catalog.findSkinByMark(' METAL.FACEMASK ', '111')?.label).toBe('Alfa');
    expect(h.catalog.findSkinByMark('metal.facemask', '999')).toBeNull();
  });

  it('registra quem cadastrou e de onde', async () => {
    const h = harness();

    await h.catalog.createSkin(body(), { name: 'jogo:Fulano', source: 'game', serverId: SERVER });

    const [entry] = h.owned.audit({ limit: 10 });

    expect(entry).toMatchObject({
      action: 'skin.create',
      actor: 'jogo:Fulano',
      source: 'game',
      serverId: SERVER,
    });
    expect(h.skins.list()[0]?.source).toBe('game');
  });

  it('a edição só consulta a Steam quando a marca muda, e grava descrição e raridade', async () => {
    const h = harness();
    const { skin } = await h.catalog.createSkin(body(), PANEL);

    // A Steam "cai" depois do cadastro: renomear continua valendo.
    h.steam.clear();

    const { skin: saved } = await h.catalog.updateSkin(
      skin.id,
      body({ label: 'Novo nome', description: 'Linda', rarity: 'legendary', sort: 3 }),
      PANEL,
    );

    expect(saved).toMatchObject({
      label: 'Novo nome',
      description: 'Linda',
      rarity: 'legendary',
      sort: 3,
      workshopTitle: 'MetalFacemaskOrigemZ',
    });

    const [entry] = h.owned.audit({ limit: 1 });

    expect(entry?.action).toBe('skin.update');
    expect(entry?.detail['changed']).toHaveProperty('rarity');
  });

  it('apagar a skin leva a posse e o registro diz de quem era', () => {
    const h = harness();
    const mask = addSkin(h);

    give(h, PLAYER, mask.id, { days: 3 });
    h.catalog.removeSkin(mask.id, PANEL);

    expect(h.owned.listOwned({ steamId: PLAYER }).owned).toHaveLength(0);
    expect(h.owned.audit({ limit: 1 })[0]?.detail['ownersRemoved']).toEqual([
      { steamId: PLAYER, expiresAt: T0 + 3 * DAY_MS, source: 'panel' },
    ]);
  });
});

// ============================================================
//  A POSSE — as regras
// ============================================================

describe('a posse', () => {
  it('dar registra, avisa e devolve a skin', () => {
    const h = harness();
    const mask = addSkin(h);

    const result = h.catalog.grantOwnership(
      { steamId: PLAYER, skinRef: mask.id, days: 30, source: 'site', sourceRef: 'DLV-5b9', createdBy: 'site:order:1234' },
      T0,
    );

    expect(result).toMatchObject({ created: true, skin: { id: mask.id }, owned: { expiresAt: T0 + 30 * DAY_MS } });
    expect(h.ownershipChanged).toEqual([PLAYER]);
    expect(h.owned.audit({ limit: 1, steamId: PLAYER })[0]).toMatchObject({
      action: 'owned.grant',
      source: 'site',
      actor: 'site:order:1234',
      detail: { sourceRef: 'DLV-5b9', days: 30, created: true, workshopId: '3802433262' },
    });
    h.service.stop();
  });

  it('skin desligada ou em servidor nenhum ainda recebe posse (o jogador pagou)', () => {
    const h = harness();
    const off = addSkin(h, { enabled: false, servers: [] });

    expect(
      h.catalog.grantOwnership({ steamId: PLAYER, skinRef: off.id, source: 'site', createdBy: 'site:x' }, T0).created,
    ).toBe(true);
    h.service.stop();
  });

  it('skin que não existe é 404', async () => {
    const h = harness();

    await expectApiError(
      () => h.catalog.grantOwnership({ steamId: PLAYER, skinRef: 99, source: 'panel', createdBy: 'admin' }),
      'WORKSHOP_SKIN_NOT_FOUND',
    );
  });

  it('tirar sem posse não é erro: devolve null, registra, e não avisa', () => {
    const h = harness();
    const mask = addSkin(h);

    expect(
      h.catalog.revokeOwnership({
        steamId: PLAYER,
        skinRef: mask.id,
        source: 'site',
        sourceRef: 'DLV-refund',
        createdBy: 'site:refund:1',
      }),
    ).toBeNull();
    expect(h.ownershipChanged).toEqual([]);
    expect(h.owned.audit({ limit: 1 })[0]).toMatchObject({
      action: 'owned.revoke',
      source: 'site',
      steamId: PLAYER,
      detail: { removed: false, sourceRef: 'DLV-refund' },
    });
  });

  it('tirar leva a linha inteira, qualquer que seja a origem', () => {
    const h = harness();
    const mask = addSkin(h);

    give(h, PLAYER, mask.id, { days: 10 });

    const removed = h.catalog.revokeOwnership({
      steamId: PLAYER,
      skinRef: mask.id,
      source: 'site',
      createdBy: 'site:refund:1',
    });

    expect(removed).toMatchObject({ steamId: PLAYER, source: 'panel' });
    expect(h.owned.find(PLAYER, mask.id)).toBeNull();
    expect(h.ownershipChanged).toEqual([PLAYER]);
    h.service.stop();
  });

  it('tirar pelo id: 404 quando não existe', async () => {
    const h = harness();
    const mask = addSkin(h);
    const { owned } = give(h, PLAYER, mask.id);

    expect(h.catalog.revokeOwnershipById(owned.id, PANEL).id).toBe(owned.id);
    await expectApiError(() => h.catalog.revokeOwnershipById(owned.id, PANEL), 'OWNED_NOT_FOUND');
    h.service.stop();
  });

  it('a lista pagina por cursor e filtra as vencidas', () => {
    const h = harness();
    const mask = addSkin(h);
    const ak = addSkin(h, { shortname: 'rifle.ak', skinId: '77', label: 'AK' });

    give(h, PLAYER, mask.id);
    give(h, PLAYER, ak.id, { expiresAt: T0 + 10 });
    give(h, PLAYER_2, mask.id);

    const first = h.owned.listOwned({ skinRef: mask.id, limit: 1 });

    expect(first.owned).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = h.owned.listOwned({ skinRef: mask.id, limit: 1, cursor: first.nextCursor ?? 0 });

    expect(second.owned).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.owned, ...second.owned].map((o) => o.steamId))).toEqual(new Set([PLAYER, PLAYER_2]));

    expect(h.owned.listOwned({ steamId: PLAYER, includeExpired: false }, T0 + 20).owned.map((o) => o.skinRef)).toEqual([
      mask.id,
    ]);
    expect(h.owned.liveOwnerCounts(T0 + 20).get(mask.id)).toBe(2);
    expect(h.owned.liveOwnerCounts(T0 + 20).get(ak.id)).toBeUndefined();
  });
});

// ============================================================
//  A CARGA DO CATÁLOGO
// ============================================================

describe('a carga do catálogo', () => {
  it('leva só as skins LIGADAS daquele servidor, sem coleção nem acesso', async () => {
    const h = harness();

    addSkin(h, { description: 'Brilha', rarity: 'rare', sort: 2 });
    addSkin(h, { skinId: '2', label: 'Desligada', enabled: false });
    addSkin(h, { skinId: '3', label: 'Do outro', servers: [OTHER] });
    addSkin(h, { skinId: '4', label: 'Casa', openToAll: true, sort: 1 });

    await h.service.sync(SERVER, 'manual');

    const payload = lastPayload(h);

    expect(Object.keys(payload).sort()).toEqual(['secret', 'skins', 'streamers']);
    expect(payload.skins).toEqual([
      { id: 4, label: 'Casa', shortname: 'metal.facemask', skinId: '4', sort: 1, openToAll: true, hideInStreamer: true },
      {
        id: 1,
        label: 'Máscara OrigemZ',
        shortname: 'metal.facemask',
        skinId: '3802433262',
        description: 'Brilha',
        rarity: 'rare',
        sort: 2,
        openToAll: false,
        hideInStreamer: true,
      },
    ]);
  });

  it('o endereço da loja só desce quando configurado', async () => {
    const h = harness({ storeUrl: ' origemz.com.br/skins ' });

    await h.service.sync(SERVER, 'manual');
    expect(lastPayload(h).storeUrl).toBe('origemz.com.br/skins');

    const blank = harness({ storeUrl: '' });

    await blank.service.sync(SERVER, 'manual');
    expect(lastPayload(blank)).not.toHaveProperty('storeUrl');
  });

  it('carga maior que o frame desce em pedaços que remontam o original', async () => {
    const h = harness();

    insertManySkins(h, 1500, [SERVER]);

    const outcome = await h.service.sync(SERVER, 'manual');
    const commands = h.sent.map((e) => e.command).filter((line) => line.startsWith(`${WORKSHOP_SYNC} `));

    expect(outcome).toMatchObject({ status: 'sent' });
    expect(commands.length).toBeGreaterThan(1);

    for (const [index, command] of commands.entries()) {
      const [, , part, total, piece] = command.split(' ');

      expect(Number(part)).toBe(index);
      expect(Number(total)).toBe(commands.length);
      expect((piece ?? '').length).toBeLessThanOrEqual(WORKSHOP_CHUNK_CHARS);
      expect(Buffer.byteLength(command)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    }

    expect(lastPayload(h).skins).toHaveLength(1500);
  });

  it('sem RCON é pulado; o que não mudou não sai; o forçado sai', async () => {
    const h = harness();

    addSkin(h);
    h.connected = false;
    expect((await h.service.sync(SERVER, 'manual')).status).toBe('skipped');

    h.connected = true;
    await h.service.sync(SERVER, 'manual');
    expect(await h.service.sync(SERVER, 'manual')).toEqual({ status: 'unchanged' });
    expect((await h.service.sync(SERVER, 'plugin-requested')).status).toBe('sent');
  });

  it('só quem está no ar ESCONDENDO A LOGO entra na lista de streamers', async () => {
    const h = harness();

    h.streamers.save(PLAYER, { allowed: true, active: true, hideLogo: true });
    h.streamers.save(PLAYER_2, { allowed: true, active: true, hideLogo: false });

    await h.service.sync(SERVER, 'manual');

    expect(lastPayload(h).streamers).toEqual([PLAYER]);
  });

  it('o `/streamer` reenvia a carga — por um relógio, nunca de dentro do gancho', async () => {
    const h = harness();

    await h.service.sync(SERVER, 'manual');

    h.streamers.save(PLAYER, { allowed: true, active: true, hideLogo: true });

    const before = h.sent.length;

    h.service.handleLine(SERVER, `[OrigemZUI] ${STREAMER_MARKER}{"steamId":"${PLAYER}","on":true}`);
    expect(h.sent).toHaveLength(before);

    await settle();

    expect(lastPayload(h).streamers).toEqual([PLAYER]);
    h.service.stop();
  });
});

/** Muitas skins de uma vez, por SQL: o `add` relê a junção a cada linha. */
function insertManySkins(h: Harness, count: number, servers: readonly string[]): number[] {
  const insert = h.db.prepare(
    `INSERT INTO workshop_skins (label, shortname, skin_id, created_at, updated_at)
     VALUES (?, 'hoodie', ?, 1, 1)`,
  );
  const link = h.db.prepare('INSERT INTO workshop_skin_servers VALUES (?, ?)');
  const ids: number[] = [];

  h.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = Number(insert.run(`Moletom número ${String(index)}`, String(900_000 + index)).lastInsertRowid);

      ids.push(id);

      for (const server of servers) link.run(id, server);
    }
  })();

  return ids;
}

// ============================================================
//  A CARGA DA POSSE
// ============================================================

describe('a carga da posse', () => {
  it('a lista VAZIA é mandada, com o steamId antes do lote', async () => {
    const h = harness();

    addSkin(h);

    const outcome = await h.service.syncOwned(SERVER, PLAYER, 'manual');
    const [command] = ownedCommands(h, PLAYER);

    expect(outcome).toMatchObject({ status: 'sent', parts: 1 });
    expect(command).toMatch(new RegExp(`^${WORKSHOP_OWNED.replace(/\./g, '\\.')} ${PLAYER} [0-9a-f]{12} 0 1 [A-Za-z0-9+/=]+$`));
    expect(lastOwned(h, PLAYER)).toEqual({ secret: expect.any(String), steamId: PLAYER, skins: [] });
  });

  it('só as vivas, só as do catálogo daquele servidor, e 0 = permanente', async () => {
    const h = harness();
    const mask = addSkin(h);
    const other = addSkin(h, { skinId: '8', label: 'Longe', servers: [OTHER] });
    const off = addSkin(h, { skinId: '9', label: 'Desligada', enabled: false });
    const timed = addSkin(h, { skinId: '10', label: 'Prazo' });
    const gone = addSkin(h, { skinId: '11', label: 'Vencida' });

    give(h, PLAYER, mask.id);
    give(h, PLAYER, other.id);
    give(h, PLAYER, off.id);
    give(h, PLAYER, timed.id, { expiresAt: T0 + 60_000 });
    give(h, PLAYER, gone.id, { expiresAt: T0 + 10 });

    h.now = T0 + 20;
    await h.service.syncOwned(SERVER, PLAYER, 'manual');

    expect(lastOwned(h, PLAYER, SERVER).skins).toEqual([
      { id: mask.id, expiresAt: 0 },
      { id: timed.id, expiresAt: T0 + 60_000 },
    ]);

    await h.service.syncOwned(OTHER, PLAYER, 'manual');
    expect(lastOwned(h, PLAYER, OTHER).skins).toEqual([{ id: other.id, expiresAt: 0 }]);
  });

  it('posse maior que o frame desce em pedaços que remontam o original', async () => {
    const h = harness();
    const ids = insertManySkins(h, 4000, [SERVER]);

    h.db.transaction(() => {
      for (const id of ids) give(h, PLAYER, id, { expiresAt: T0 + 1_000_000_000 + id });
    })();

    const outcome = await h.service.syncOwned(SERVER, PLAYER, 'manual');
    const commands = ownedCommands(h, PLAYER);

    expect(outcome).toMatchObject({ status: 'sent' });
    expect(commands.length).toBeGreaterThan(1);

    const batches = new Set<string>();

    for (const [index, command] of commands.entries()) {
      const [, steamId, batch, part, total, piece] = command.split(' ');

      expect(steamId).toBe(PLAYER);
      batches.add(batch ?? '');
      expect(Number(part)).toBe(index);
      expect(Number(total)).toBe(commands.length);
      expect((piece ?? '').length).toBeLessThanOrEqual(WORKSHOP_CHUNK_CHARS);
      expect(Buffer.byteLength(command)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    }

    expect(batches.size).toBe(1);
    expect(lastOwned(h, PLAYER).skins).toHaveLength(4000);
  });

  it('o que não mudou não sai de novo; o forçado sai', async () => {
    const h = harness();

    await h.service.syncOwned(SERVER, PLAYER, 'manual');
    expect(await h.service.syncOwned(SERVER, PLAYER, 'manual')).toEqual({ status: 'unchanged' });
    expect((await h.service.syncOwned(SERVER, PLAYER, 'player-joined', true)).status).toBe('sent');

    h.connected = false;
    expect((await h.service.syncOwned(SERVER, PLAYER, 'manual', true)).status).toBe('skipped');
  });

  it('quem entra recebe a posse — forçada, por relógio', async () => {
    const h = harness();
    const mask = addSkin(h);

    give(h, PLAYER, mask.id);
    await h.service.syncOwned(SERVER, PLAYER, 'manual');

    const before = ownedCommands(h, PLAYER).length;

    h.service.handlePlayersJoined(SERVER, [PLAYER, PLAYER_2]);
    expect(ownedCommands(h, PLAYER)).toHaveLength(before);

    await settle();

    // Forçada: a mesma carga sai de novo.
    expect(ownedCommands(h, PLAYER)).toHaveLength(before + 1);
    expect(lastOwned(h, PLAYER_2).skins).toEqual([]);
    h.service.stop();
  });

  it('a posse que muda desce em CADA servidor onde ele está, e só neles', async () => {
    const h = harness();
    const mask = addSkin(h, { servers: [SERVER, OTHER] });

    h.online.set(OTHER, [PLAYER]);

    h.catalog.grantOwnership({ steamId: PLAYER, skinRef: mask.id, source: 'panel', createdBy: 'admin' }, T0);
    // Offline em todo lugar: nada sai.
    h.catalog.grantOwnership({ steamId: PLAYER_2, skinRef: mask.id, source: 'panel', createdBy: 'admin' }, T0);

    await settle();

    expect(ownedCommands(h, PLAYER, SERVER)).toEqual([]);
    expect(lastOwned(h, PLAYER, OTHER).skins).toEqual([{ id: mask.id, expiresAt: 0 }]);
    expect(ownedCommands(h, PLAYER_2)).toEqual([]);

    // E tirar reenvia a lista, agora vazia.
    h.catalog.revokeOwnership({ steamId: PLAYER, skinRef: mask.id, source: 'panel', createdBy: 'admin' });
    await settle();
    expect(lastOwned(h, PLAYER, OTHER).skins).toEqual([]);
    h.service.stop();
  });

  it('o plugin que sobe recebe o catálogo e DEPOIS a posse de todos os online', async () => {
    const h = harness();
    const mask = addSkin(h);

    give(h, PLAYER, mask.id);
    h.online.set(SERVER, [PLAYER, PLAYER_2]);

    h.service.handleLine(SERVER, `[OrigemZWorkshop] ${WORKSHOP_MARKER}{"kind":"ready"}`);
    await settle();

    const commands = h.sent.filter((e) => e.server === SERVER).map((e) => e.command.split(' ')[0]);

    expect(commands).toEqual([WORKSHOP_SYNC, WORKSHOP_OWNED, WORKSHOP_OWNED]);
    expect(lastOwned(h, PLAYER).skins).toEqual([{ id: mask.id, expiresAt: 0 }]);
    expect(lastOwned(h, PLAYER_2).skins).toEqual([]);

    // E o RCON que volta faz o mesmo, forçado.
    h.service.handleRconConnected(SERVER);
    await settle();
    expect(h.sent.filter((e) => e.server === SERVER)).toHaveLength(6);
    h.service.stop();
  });

  it('uma skin nova no servidor chega à posse de quem já a tinha', async () => {
    const h = harness();
    const mask = addSkin(h, { servers: [] });

    give(h, PLAYER, mask.id);
    h.online.set(SERVER, [PLAYER]);

    await h.service.syncAll('startup');
    expect(lastOwned(h, PLAYER, SERVER).skins).toEqual([]);

    h.skins.setServers(mask.id, [SERVER]);
    h.service.handleCatalogChanged();
    await settle();

    expect(lastOwned(h, PLAYER, SERVER).skins).toEqual([{ id: mask.id, expiresAt: 0 }]);
    h.service.stop();
  });

  it('o vencimento reenvia SÓ quem venceu e fica registrado, inclusive com o agente parado', async () => {
    const h = harness();
    const mask = addSkin(h);

    give(h, PLAYER, mask.id, { expiresAt: T0 + 500 });
    give(h, PLAYER_2, mask.id);
    h.online.set(SERVER, [PLAYER, PLAYER_2]);

    // O relógio arma e grava "conferido até agora".
    h.service.scheduleExpiry();
    h.service.stop();

    // O agente "reinicia" depois do prazo.
    h.now += 10_000;

    const sent: SentCommand[] = [];
    const restarted = new WorkshopService({
      skins: h.skins,
      owned: h.owned,
      catalog: h.catalog,
      meta: h.meta,
      streamers: h.streamers,
      servers: {
        ids: () => [SERVER],
        contextOf: () => ({
          rcon: {
            isConnected: true,
            send: (command: string) => {
              sent.push({ server: SERVER, command });
              return Promise.resolve('{"ok":true}');
            },
          } as never,
        }),
        onlineOf: (id) => h.online.get(id) ?? [],
      },
      now: () => h.now,
    });

    restarted.scheduleExpiry();
    await settle();
    restarted.stop();

    const expired = h.owned.audit({ limit: 5, steamId: PLAYER }).filter((e) => e.action === 'owned.expired');

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ source: 'system', at: T0 + 500 });

    // Só o PLAYER, e com a lista vazia.
    expect(sent.map((e) => e.command.split(' ')[1])).toEqual([PLAYER]);
    expect(lastBatch({ sent } as unknown as Harness, `${WORKSHOP_OWNED} ${PLAYER}`)).toMatchObject({ skins: [] });
  });
});

// ============================================================
//  O /skin add E O /skin give DO JOGO
// ============================================================

describe('os comandos de admin no jogo', () => {
  function line(kind: 'add' | 'give', secret: string, patch: Record<string, unknown> = {}): string {
    return `[OrigemZWorkshop] ${WORKSHOP_MARKER}${JSON.stringify({
      kind,
      secret,
      requestId: 'req-1',
      steamId: PLAYER,
      playerName: 'Admin',
      shortname: 'metal.facemask',
      skinId: '3802433262',
      ...(kind === 'give' ? { targetSteamId: PLAYER_2, targetName: 'Fulano', days: 30 } : {}),
      ...patch,
    })}`;
  }

  function lastReply(h: Harness): Record<string, unknown> {
    const command = h.sent.map((e) => e.command).filter((l) => l.startsWith(WORKSHOP_REPLY)).at(-1);

    if (command === undefined) throw new Error('nenhuma resposta saiu');

    return decodePushPayload(command.slice(WORKSHOP_REPLY.length + 1)) as Record<string, unknown>;
  }

  it('add grava no MESMO catálogo do painel, só no servidor de onde veio, e responde', async () => {
    const h = harness();
    const secret = await grabSecret(h);
    const before = h.sent.length;

    h.service.handleLine(SERVER, line('add', secret));

    // Nada sai de dentro do gancho.
    expect(h.sent).toHaveLength(before);

    await settle(50);

    const [skin] = h.skins.list();

    expect(skin).toMatchObject({
      label: 'MetalFacemaskOrigemZ',
      shortname: 'metal.facemask',
      source: 'game',
      servers: [SERVER],
      createdBy: 'jogo:Admin (76561190000000001)',
    });
    expect(lastReply(h)).toMatchObject({ requestId: 'req-1', steamId: PLAYER, ok: true });
    h.service.stop();
  });

  it('a recusa do add volta ao admin com a frase, e fica no registro', async () => {
    const h = harness();
    const secret = await grabSecret(h);

    h.service.handleLine(SERVER, line('add', secret, { skinId: '404' }));
    await settle(50);

    expect(h.skins.list()).toHaveLength(0);
    expect(lastReply(h)).toMatchObject({ ok: false });
    expect(String(lastReply(h)['message'])).toContain('Steam');
    expect(h.owned.audit({ limit: 1 })[0]).toMatchObject({ action: 'game.add-refused', serverId: SERVER });
    h.service.stop();
  });

  it('give dá a posse pelo MESMO grantOwnership, e o jogador online recebe', async () => {
    const h = harness();
    const mask = addSkin(h);
    const secret = await grabSecret(h);

    h.online.set(SERVER, [PLAYER_2]);
    h.service.handleLine(SERVER, line('give', secret));
    await settle(50);

    expect(h.owned.find(PLAYER_2, mask.id)).toMatchObject({
      expiresAt: T0 + 30 * DAY_MS,
      source: 'game',
      createdBy: 'jogo:Admin (76561190000000001)',
    });
    expect(lastReply(h)).toMatchObject({ requestId: 'req-1', steamId: PLAYER, ok: true });
    expect(String(lastReply(h)['message'])).toContain('Fulano');
    expect(h.owned.audit({ limit: 1, steamId: PLAYER_2 })[0]).toMatchObject({
      action: 'owned.grant',
      source: 'game',
      serverId: SERVER,
    });

    await settle();
    expect(lastOwned(h, PLAYER_2, SERVER).skins).toEqual([{ id: mask.id, expiresAt: T0 + 30 * DAY_MS }]);
    h.service.stop();
  });

  it('give sem dias é permanente; give de skin que não existe volta recusado', async () => {
    const h = harness();
    const mask = addSkin(h);
    const secret = await grabSecret(h);

    h.service.handleLine(SERVER, line('give', secret, { days: null }));
    await settle(50);
    expect(h.owned.find(PLAYER_2, mask.id)?.expiresAt).toBeNull();
    expect(String(lastReply(h)['message'])).toContain('permanente');

    h.service.handleLine(SERVER, line('give', secret, { requestId: 'req-2', skinId: '999' }));
    await settle(50);
    expect(lastReply(h)).toMatchObject({ requestId: 'req-2', ok: false });
    expect(String(lastReply(h)['message'])).toContain('/skin add');
    expect(h.owned.audit({ limit: 1 })[0]).toMatchObject({ action: 'game.give-refused', serverId: SERVER });
    h.service.stop();
  });

  it('sem o segredo — um jogador digitando no chat — não faz nada', async () => {
    const h = harness();

    addSkin(h);
    await grabSecret(h);

    h.service.handleLine(SERVER, line('add', 'chute'));
    h.service.handleLine(SERVER, line('give', 'chute'));
    // E a linha de chat, com o nome antes do marcador, nem é lida.
    h.service.handleLine(SERVER, `[CHAT] Fulano: ${line('give', 'chute')}`);
    await settle(50);

    expect(h.skins.list()).toHaveLength(1);
    expect(h.owned.listOwned({ steamId: PLAYER_2 }).owned).toHaveLength(0);
    expect(h.sent.some((e) => e.command.startsWith(WORKSHOP_REPLY))).toBe(false);
  });

  it('o mesmo pedido duas vezes vira UMA escrita e UMA resposta; give fora do contrato é descartado', async () => {
    const h = harness();
    const mask = addSkin(h);
    const secret = await grabSecret(h);

    h.service.handleLine(SERVER, line('give', secret, { days: 1 }));
    h.service.handleLine(SERVER, line('give', secret, { days: 1 }));
    h.service.handleLine(SERVER, line('give', secret, { requestId: 'req-3', targetSteamId: 'Fulano' }));
    await settle(50);

    // Somaria dois dias se tivesse entrado duas vezes.
    expect(h.owned.find(PLAYER_2, mask.id)?.expiresAt).toBe(T0 + DAY_MS);
    expect(h.sent.filter((e) => e.command.startsWith(WORKSHOP_REPLY))).toHaveLength(1);
    h.service.stop();
  });
});

// ============================================================
//  AS ROTAS
// ============================================================

async function buildApp(h: Harness): Promise<FastifyInstance> {
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

  await app.register(
    async (api) => {
      // Sem `workshop`: o cadastro e a posse funcionam com os
      // servidores parados.
      registerWorkshopRoutes(api, {
        repository: h.skins,
        owned: h.owned,
        catalog: h.catalog,
        items: h.items,
        servers: h.servers,
        lookup: (id) => Promise.resolve(h.steam.get(id) ?? { status: 'not_found' }),
      });

      // Só a aba Skins da ficha é exercitada aqui.
      registerPlayerRoutes(api, {
        directory: {} as PlayerDirectory,
        streamer: h.streamers,
        streamerSync: null,
        skins: { repository: h.skins, owned: h.owned },
      });
    },
    { prefix: '/api' },
  );

  return app;
}

describe('as rotas', () => {
  it('o ciclo inteiro responde com os servidores parados', async () => {
    const h = harness();
    const app = await buildApp(h);

    const created = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: {
        shortname: 'metal.facemask',
        skinId: '3802433262',
        servers: [SERVER],
        description: 'A da casa',
        rarity: 'epic',
        sort: 4,
      },
    });

    expect(created.statusCode).toBe(201);

    const skin = created.json().skin as Record<string, unknown>;

    expect(skin).toMatchObject({
      label: 'MetalFacemaskOrigemZ',
      description: 'A da casa',
      rarity: 'epic',
      sort: 4,
      owners: 0,
    });
    expect(skin).not.toHaveProperty('permission');
    expect(skin).not.toHaveProperty('collectionId');

    const skinId = skin['id'] as number;

    const granted = await app.inject({
      method: 'POST',
      url: '/api/workshop/owned',
      payload: { steamId: PLAYER, skinId, days: 7, note: 'prêmio do evento' },
    });

    expect(granted.statusCode).toBe(201);
    expect(granted.json()).toMatchObject({
      created: true,
      owned: {
        steamId: PLAYER,
        skinId,
        expired: false,
        source: 'panel',
        note: 'prêmio do evento',
        skin: { label: 'MetalFacemaskOrigemZ', workshopId: '3802433262', rarity: 'epic' },
      },
    });

    const renewed = await app.inject({
      method: 'POST',
      url: '/api/workshop/owned',
      payload: { steamId: PLAYER, skinId, expiresAt: null },
    });

    expect(renewed.json()).toMatchObject({ created: false, owned: { expiresAt: null } });

    const listed = await app.inject({ method: 'GET', url: `/api/workshop/owned?steamId=${PLAYER}` });

    expect(listed.json()).toMatchObject({ count: 1, nextCursor: null });

    const skins = await app.inject({ method: 'GET', url: '/api/workshop/skins' });

    expect(skins.json().skins[0].owners).toBe(1);

    const ownedId = listed.json().owned[0].id as number;

    expect((await app.inject({ method: 'DELETE', url: `/api/workshop/owned/${String(ownedId)}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/workshop/owned/${String(ownedId)}` })).statusCode).toBe(404);

    const audit = await app.inject({ method: 'GET', url: `/api/workshop/audit?steamId=${PLAYER}` });

    expect(audit.json().entries.map((entry: { action: string }) => entry.action)).toEqual([
      'owned.revoke',
      'owned.grant',
      'owned.grant',
    ]);
  });

  it('a lista da posse exige steamId ou skinId, e recusa dias com data', async () => {
    const h = harness();
    const app = await buildApp(h);

    expect((await app.inject({ method: 'GET', url: '/api/workshop/owned' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/workshop/owned?skinId=1' })).statusCode).toBe(200);

    const both = await app.inject({
      method: 'POST',
      url: '/api/workshop/owned',
      payload: { steamId: PLAYER, skinId: 1, days: 3, expiresAt: new Date(T0).toISOString() },
    });

    expect(both.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/workshop/owned',
      payload: { steamId: PLAYER, skinId: 99 },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('WORKSHOP_SKIN_NOT_FOUND');
  });

  it('coleções e acessos não existem mais', async () => {
    const h = harness();
    const app = await buildApp(h);

    expect((await app.inject({ method: 'GET', url: '/api/workshop/collections' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/workshop/grants' })).statusCode).toBe(404);
  });

  it('a ficha do jogador separa a posse viva da vencida', async () => {
    const h = harness();
    const app = await buildApp(h);
    const mask = addSkin(h, { rarity: 'rare' });
    const ak = addSkin(h, { shortname: 'rifle.ak', skinId: '77', label: 'AK' });

    h.now = Date.now();
    give(h, PLAYER, mask.id);
    h.db
      .prepare(
        `INSERT INTO workshop_owned_skins (steam_id, skin_ref, expires_at, source, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'site', 'site:x', 1, 1)`,
      )
      .run(PLAYER, ak.id, 1000);

    const response = await app.inject({ method: 'GET', url: `/api/players/${PLAYER}/skins` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      steamId: PLAYER,
      live: [{ skinId: mask.id, expiresAt: null, skin: { label: 'Máscara OrigemZ', rarity: 'rare' } }],
      expired: [{ skinId: ak.id, source: 'site', expired: true, skin: { shortname: 'rifle.ak' } }],
    });

    const nobody = await app.inject({ method: 'GET', url: `/api/players/${PLAYER_3}/skins` });

    expect(nobody.json()).toMatchObject({ live: [], expired: [] });
    expect((await app.inject({ method: 'GET', url: '/api/players/123/skins' })).statusCode).toBe(400);
  });

  it('a consulta prévia sugere o item pela tag e julga o escolhido', async () => {
    const h = harness();
    const app = await buildApp(h);

    const response = await app.inject({
      method: 'GET',
      url: '/api/workshop/lookup/3802433262?shortname=hatchet',
    });

    expect(response.json()).toMatchObject({
      status: 'found',
      suggestedShortnames: ['metal.facemask'],
      verdict: { ok: false, code: 'WORKSHOP_OTHER_ITEM' },
    });
  });

  it('a recusa de regra chega com código e frase', async () => {
    const h = harness();
    const app = await buildApp(h);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: { shortname: 'metal.facemask', skinId: '1', servers: ['nao-existe'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('UNKNOWN_SERVER');
  });

  it('mandar a carga sem canal com o jogo é 503, e não silêncio', async () => {
    const h = harness();
    const app = await buildApp(h);

    const response = await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/workshop/sync` });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('WORKSHOP_UNAVAILABLE');
  });
});
