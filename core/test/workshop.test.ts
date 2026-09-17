// ============================================================
//  As skins do Workshop, do lado do agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Esta feature falha CALADA por natureza: o servidor aceita
//  qualquer `ulong` em `item.skin` e nunca reclama. Os casos abaixo
//  são os que produzem esse silêncio — ou, pior, um cadastro que
//  aparece numa porta e não na outra:
//
//    migração que perde dado   as skins e as ligações de servidor
//                              da 095 somem na reconstrução
//    duas portas, duas regras  o painel confere a Steam e o
//                              `/skin add` do jogo não
//    aviso forjado             um jogador digita `#OZWORKSHOP#` no
//                              chat e cadastra uma skin
//    carga grande demais       o frame é truncado e o plugin troca
//                              uma carga boa por meia
//    acesso vencido na carga   o jogador continua pintando depois
//                              do prazo
//    coleção ambígua           duas máscaras na "neve", e o
//                              `/skin neve` escolhe uma ao acaso
//    comando de dentro do gancho  a linha volta pelo console e o
//                              agente entra em laço com ele mesmo
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
import { WorkshopAccessRepository } from '../src/db/workshop-access-repository.js';
import { WorkshopSkinsRepository } from '../src/db/workshop-repository.js';
import { decodePushPayload, MAX_PUSH_BYTES } from '../src/game/plugin-push.js';
import type { WorkshopLookup, WorkshopLookupFn } from '../src/game/steam-workshop.js';
import {
  WORKSHOP_CHUNK_CHARS,
  WORKSHOP_MARKER,
  WORKSHOP_REPLY,
  WORKSHOP_SYNC,
  WorkshopService,
} from '../src/game/workshop.js';
import { WorkshopCatalog, type WorkshopActor } from '../src/game/workshop-catalog.js';
import { ApiError, apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerWorkshopRoutes } from '../src/http/routes/workshop.js';
import { STREAMER_MARKER } from '../src/types/streamer-transport.js';
import {
  collectionSlugSchema,
  normalizePermission,
  workshopGrantBodySchema,
  workshopSkinBodySchema,
  workshopSkinInputSchema,
  type WorkshopPayload,
  type WorkshopSkinBody,
} from '../src/types/workshop.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const OTHER = 'server02';
const PLAYER = '76561190000000001';
const PANEL: WorkshopActor = { name: 'admin', source: 'panel' };

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

interface Harness {
  readonly db: AgentDatabase;
  readonly service: WorkshopService;
  readonly catalog: WorkshopCatalog;
  readonly skins: WorkshopSkinsRepository;
  readonly access: WorkshopAccessRepository;
  readonly items: ItemsRepository;
  readonly servers: ServersRepository;
  readonly streamers: StreamerRepository;
  readonly meta: MetaRepository;
  /** Todo comando que saiu pelo RCON, na ordem. */
  readonly sent: string[];
  /** Workshop ID -> o que a "Steam" responde. Ausente = não existe. */
  readonly steam: Map<string, WorkshopLookup>;
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
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);
  const items = new ItemsRepository(db);

  seedServers(servers);
  seedItems(items);

  const skins = new WorkshopSkinsRepository(db);
  const access = new WorkshopAccessRepository(db);
  const streamers = new StreamerRepository(db);
  const meta = new MetaRepository(db);
  const steam = new Map<string, WorkshopLookup>([['3802433262', FACEMASK]]);

  const lookup: WorkshopLookupFn = (id) => Promise.resolve(steam.get(id) ?? { status: 'not_found' });

  const state = {
    db,
    skins,
    access,
    items,
    servers,
    streamers,
    meta,
    sent: [] as string[],
    steam,
    connected: true,
    now: 1_800_000_000_000,
  } as Omit<Harness, 'service' | 'catalog'> & { service: WorkshopService; catalog: WorkshopCatalog };

  const rcon = {
    get isConnected() {
      return state.connected;
    },
    send: (command: string) => {
      state.sent.push(command);

      if (command.startsWith(WORKSHOP_SYNC) || command.startsWith(WORKSHOP_REPLY)) {
        return Promise.resolve(JSON.stringify({ ok: true }));
      }

      return Promise.resolve('');
    },
  };

  state.catalog = new WorkshopCatalog({
    skins,
    access,
    items,
    serverIds: () => [SERVER, OTHER],
    lookup,
    onChange: () => undefined,
  });

  state.service = new WorkshopService({
    skins,
    access,
    catalog: state.catalog,
    meta,
    streamers,
    servers: { ids: () => [SERVER, OTHER], contextOf: () => ({ rcon }) },
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

/** Remonta a última carga que saiu, juntando os pedaços. */
function lastPayload(h: Harness): WorkshopPayload {
  const commands = h.sent.filter((line) => line.startsWith(`${WORKSHOP_SYNC} `));
  const last = commands.at(-1);

  if (last === undefined) throw new Error('nenhum sync saiu');

  const [, batch, , total] = last.split(' ');
  const parts = commands
    .filter((line) => line.split(' ')[1] === batch)
    .slice(-Number(total))
    .map((line) => line.split(' ')[4] ?? '');

  return decodePushPayload(parts.join('')) as WorkshopPayload;
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

// ============================================================
//  A MIGRAÇÃO 096
// ============================================================

describe('a migração 096', () => {
  it('reconstrói as skins sem perder linha nem ligação de servidor', () => {
    const db = openDatabase({ file: MEMORY_DATABASE });

    db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);

    for (const migration of MIGRATIONS.filter((m) => m.id <= 95)) {
      applyMigration(db, migration);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, 0)').run(migration.id, migration.name);
    }

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
    const skin = skins.get(7);

    expect(skin).toMatchObject({
      label: 'Pedra',
      shortname: 'rock',
      skinId: '3071657601',
      permission: 'origemzworkshop.pedra',
      hideInStreamer: false,
      collectionId: null,
      openToAll: false,
      source: 'panel',
      servers: [SERVER, OTHER],
      createdAt: 5,
    });

    // E a cascata continua de pé DEPOIS da reconstrução.
    skins.remove(7);
    expect(db.prepare('SELECT count(*) AS n FROM workshop_skin_servers').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
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

  it('a permissão é opcional, e quando vem é normalizada', () => {
    expect(body({ permission: '' }).permission).toBeNull();
    expect(body({ permission: null }).permission).toBeNull();
    expect(body({ permission: 'VIP Ouro' }).permission).toBe('origemzworkshop.vip-ouro');
    expect(normalizePermission(normalizePermission('vip'))).toBe('origemzworkshop.vip');
  });

  it('a coleção não pode ter o nome de um subcomando do /skin', () => {
    expect(collectionSlugSchema.safeParse('neve').success).toBe(true);
    expect(collectionSlugSchema.safeParse('Neve').success).toBe(true);
    expect(collectionSlugSchema.safeParse('add').success).toBe(false);
    expect(collectionSlugSchema.safeParse('ajuda').success).toBe(false);
    expect(collectionSlugSchema.safeParse('com espaço').success).toBe(false);
  });

  it('o acesso de jogador exige SteamID64, e o de grupo, um nome do Oxide', () => {
    const grant = (subjectType: string, subject: string) =>
      workshopGrantBodySchema.safeParse({ subjectType, subject, targetType: 'skin', targetId: 1 });

    expect(grant('player', PLAYER).success).toBe(true);
    expect(grant('player', 'Fulano').success).toBe(false);
    expect(grant('group', 'VIP').success).toBe(true);
    expect(grant('group', 'vip ouro').success).toBe(false);
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

  it('várias skins do MESMO item convivem — o jogador escolhe na caixa', async () => {
    const h = harness();

    h.steam.set('111', { status: 'unavailable', reason: 'x' });

    await h.catalog.createSkin(body(), PANEL);
    await h.catalog.createSkin(body({ skinId: '111', label: 'Máscara 2' }), PANEL);

    expect(h.skins.list().map((skin) => skin.skinId).sort()).toEqual(['111', '3802433262']);
  });

  it('registra quem cadastrou e de onde', async () => {
    const h = harness();

    await h.catalog.createSkin(body(), { name: 'jogo:Fulano', source: 'game', serverId: SERVER });

    const [entry] = h.access.audit({ limit: 10 });

    expect(entry).toMatchObject({
      action: 'skin.create',
      actor: 'jogo:Fulano',
      source: 'game',
      serverId: SERVER,
    });
    expect(h.skins.list()[0]?.source).toBe('game');
  });

  it('a edição só consulta a Steam quando a marca muda', async () => {
    const h = harness();
    const { skin } = await h.catalog.createSkin(body(), PANEL);

    // A Steam "cai" depois do cadastro: renomear continua valendo.
    h.steam.clear();

    const { skin: saved } = await h.catalog.updateSkin(skin.id, body({ label: 'Novo nome' }), PANEL);

    expect(saved.label).toBe('Novo nome');
    expect(saved.workshopTitle).toBe('MetalFacemaskOrigemZ');

    const [entry] = h.access.audit({ limit: 1 });

    expect(entry?.action).toBe('skin.update');
    expect(entry?.detail['changed']).toHaveProperty('label');
  });
});

// ============================================================
//  AS COLEÇÕES
// ============================================================

describe('as coleções', () => {
  it('cabe uma skin por item em cada coleção', async () => {
    const h = harness();
    const neve = h.catalog.createCollection(
      { slug: 'neve', label: 'Neve', permission: null, openToAll: false, enabled: true },
      PANEL,
    );

    const mask1 = addSkin(h);
    const mask2 = addSkin(h, { skinId: '222', label: 'Máscara 2' });
    const hoodie = addSkin(h, { shortname: 'hoodie', skinId: '333', label: 'Moletom' });

    await expectApiError(
      () => h.catalog.setCollectionSkins(neve.id, [mask1.id, mask2.id], PANEL),
      'COLLECTION_ITEM_TAKEN',
    );

    // A recusa não deixou a coleção pela metade.
    expect(h.skins.skinsOfCollection(neve.id)).toHaveLength(0);

    const saved = h.catalog.setCollectionSkins(neve.id, [mask1.id, hoodie.id], PANEL);

    expect(saved.map((skin) => skin.shortname).sort()).toEqual(['hoodie', 'metal.facemask']);

    // E pelo formulário da skin também.
    await expectApiError(
      h.catalog.updateSkin(mask2.id, body({ skinId: '222', label: 'Máscara 2', collectionId: neve.id }), PANEL),
      'COLLECTION_ITEM_TAKEN',
    );
  });

  it('apagar a coleção SOLTA as skins, e não as apaga', () => {
    const h = harness();
    const neve = h.catalog.createCollection(
      { slug: 'neve', label: 'Neve', permission: null, openToAll: false, enabled: true },
      PANEL,
    );
    const mask = addSkin(h, { collectionId: neve.id });

    h.access.upsertGrant(
      { subjectType: 'player', subject: PLAYER, targetType: 'collection', targetId: neve.id, expiresAt: null, note: '' },
      null,
    );

    h.catalog.removeCollection(neve.id, PANEL);

    expect(h.skins.get(mask.id)?.collectionId).toBeNull();
    // O acesso caiu na cascata — e o registro diz de quem era.
    expect(h.access.listGrants()).toHaveLength(0);
    expect(h.access.audit({ limit: 1 })[0]?.detail['grantsRemoved']).toEqual([`player:${PLAYER}`]);
  });

  it('o nome do comando é único', async () => {
    const h = harness();
    const input = { slug: 'neve', label: 'Neve', permission: null, openToAll: false, enabled: true };

    h.catalog.createCollection(input, PANEL);
    await expectApiError(() => h.catalog.createCollection(input, PANEL), 'DUPLICATE_COLLECTION');
  });
});

// ============================================================
//  OS ACESSOS
// ============================================================

describe('os acessos', () => {
  it('liberar de novo RENOVA, e não empilha', () => {
    const h = harness();
    const mask = addSkin(h);
    const grant = (expiresAt: number | null) =>
      h.catalog.grant(
        workshopGrantBodySchema.parse({
          subjectType: 'player',
          subject: PLAYER,
          targetType: 'skin',
          targetId: mask.id,
          expiresAt,
        }),
        PANEL,
        h.now,
      );

    grant(h.now + 1000);
    grant(null);

    const grants = h.access.listGrants({ subject: PLAYER });

    expect(grants).toHaveLength(1);
    expect(grants[0]?.expiresAt).toBeNull();
    expect(h.access.audit({ limit: 10, steamId: PLAYER }).map((entry) => entry.action)).toEqual([
      'grant.update',
      'grant.create',
    ]);
  });

  it('recusa prazo que já passou', async () => {
    const h = harness();
    const mask = addSkin(h);

    await expectApiError(
      () =>
        h.catalog.grant(
          workshopGrantBodySchema.parse({
            subjectType: 'player',
            subject: PLAYER,
            targetType: 'skin',
            targetId: mask.id,
            expiresAt: h.now - 1,
          }),
          PANEL,
          h.now,
        ),
      'GRANT_ALREADY_EXPIRED',
    );
  });

  it('acesso para skin que não existe é recusado', async () => {
    const h = harness();

    await expectApiError(
      () =>
        h.catalog.grant(
          workshopGrantBodySchema.parse({
            subjectType: 'group',
            subject: 'vip',
            targetType: 'collection',
            targetId: 99,
          }),
          PANEL,
        ),
      'WORKSHOP_COLLECTION_NOT_FOUND',
    );
  });

  it('o vencimento fica registrado, inclusive o que venceu com o agente parado', () => {
    const h = harness();
    const mask = addSkin(h);

    h.access.upsertGrant(
      { subjectType: 'player', subject: PLAYER, targetType: 'skin', targetId: mask.id, expiresAt: h.now + 500, note: '' },
      'admin',
      h.now,
    );

    // O relógio arma e grava "conferido até agora".
    h.service.scheduleExpiry();
    h.service.stop();

    // O agente "reinicia" depois do prazo.
    h.now += 10_000;

    const restarted = new WorkshopService({
      skins: h.skins,
      access: h.access,
      catalog: h.catalog,
      meta: h.meta,
      streamers: h.streamers,
      servers: { ids: () => [], contextOf: () => null },
      now: () => h.now,
    });

    restarted.scheduleExpiry();
    restarted.stop();

    const expired = h.access.audit({ limit: 5, steamId: PLAYER }).filter((e) => e.action === 'grant.expire');

    expect(expired).toHaveLength(1);
    expect(expired[0]?.source).toBe('system');
  });
});

// ============================================================
//  A CARGA
// ============================================================

describe('a carga', () => {
  it('leva só as skins LIGADAS daquele servidor', async () => {
    const h = harness();

    addSkin(h);
    addSkin(h, { skinId: '2', label: 'Desligada', enabled: false });
    addSkin(h, { skinId: '3', label: 'Do outro', servers: [OTHER] });

    await h.service.sync(SERVER, 'manual');

    expect(lastPayload(h).skins.map((skin) => skin.label)).toEqual(['Máscara OrigemZ']);
  });

  it('coleção só desce onde tem skin, e acesso só desce vivo e para o que desceu', async () => {
    const h = harness();
    const neve = h.skins.addCollection(
      { slug: 'neve', label: 'Neve', permission: null, openToAll: false, enabled: true },
      null,
    );
    const vazia = h.skins.addCollection(
      { slug: 'vazia', label: 'Vazia', permission: null, openToAll: false, enabled: true },
      null,
    );
    const mask = addSkin(h, { collectionId: neve.id });
    const elsewhere = addSkin(h, { skinId: '9', label: 'Longe', servers: [OTHER] });

    const grant = (targetType: 'skin' | 'collection', targetId: number, expiresAt: number | null) =>
      h.access.upsertGrant(
        { subjectType: 'player', subject: PLAYER, targetType, targetId, expiresAt, note: '' },
        null,
        h.now - 10,
      );

    grant('skin', mask.id, null);
    grant('collection', neve.id, h.now + 60_000);
    grant('skin', elsewhere.id, null); // a skin não está neste servidor
    grant('collection', vazia.id, null); // a coleção não desce aqui
    h.access.upsertGrant(
      { subjectType: 'group', subject: 'vip', targetType: 'skin', targetId: mask.id, expiresAt: h.now - 1, note: '' },
      null,
      h.now - 10,
    );

    await h.service.sync(SERVER, 'manual');

    const payload = lastPayload(h);

    expect(payload.collections.map((c) => c.slug)).toEqual(['neve']);
    expect(payload.skins[0]?.collectionId).toBe(neve.id);
    expect(payload.grants).toEqual([
      { subjectType: 'player', subject: PLAYER, targetType: 'collection', targetId: neve.id, expiresAt: h.now + 60_000 },
      { subjectType: 'player', subject: PLAYER, targetType: 'skin', targetId: mask.id, expiresAt: null },
    ].sort((a, b) => (a.targetType < b.targetType ? -1 : 1)));
  });

  it('carga maior que o frame desce em pedaços que remontam o original', async () => {
    const h = harness();

    addSkin(h);

    for (let index = 0; index < 1500; index += 1) {
      h.access.upsertGrant(
        {
          subjectType: 'player',
          subject: `7656119${String(index).padStart(10, '0')}`,
          targetType: 'skin',
          targetId: 1,
          expiresAt: null,
          note: '',
        },
        null,
      );
    }

    const outcome = await h.service.sync(SERVER, 'manual');
    const commands = h.sent.filter((line) => line.startsWith(`${WORKSHOP_SYNC} `));

    expect(outcome).toMatchObject({ status: 'sent' });
    expect(commands.length).toBeGreaterThan(1);

    for (const [index, command] of commands.entries()) {
      const [, , part, total, piece] = command.split(' ');

      expect(Number(part)).toBe(index);
      expect(Number(total)).toBe(commands.length);
      expect((piece ?? '').length).toBeLessThanOrEqual(WORKSHOP_CHUNK_CHARS);
      expect(Buffer.byteLength(command)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    }

    expect(lastPayload(h).grants).toHaveLength(1500);
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
    h.streamers.save('76561190000000002', { allowed: true, active: true, hideLogo: false });

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

// ============================================================
//  O /skin add DO JOGO
// ============================================================

describe('o /skin add do jogo', () => {
  function addLine(secret: string, patch: Record<string, unknown> = {}): string {
    return `[OrigemZWorkshop] ${WORKSHOP_MARKER}${JSON.stringify({
      kind: 'add',
      secret,
      requestId: 'req-1',
      steamId: PLAYER,
      playerName: 'Fulano',
      shortname: 'metal.facemask',
      skinId: '3802433262',
      ...patch,
    })}`;
  }

  function lastReply(h: Harness): Record<string, unknown> {
    const command = h.sent.filter((line) => line.startsWith(WORKSHOP_REPLY)).at(-1);

    if (command === undefined) throw new Error('nenhuma resposta saiu');

    return decodePushPayload(command.slice(WORKSHOP_REPLY.length + 1)) as Record<string, unknown>;
  }

  it('grava no MESMO catálogo do painel, só no servidor de onde veio, e responde', async () => {
    const h = harness();
    const secret = await grabSecret(h);
    const before = h.sent.length;

    h.service.handleLine(SERVER, addLine(secret));

    // Nada sai de dentro do gancho.
    expect(h.sent).toHaveLength(before);

    await settle(50);

    const [skin] = h.skins.list();

    expect(skin).toMatchObject({
      label: 'MetalFacemaskOrigemZ',
      shortname: 'metal.facemask',
      source: 'game',
      servers: [SERVER],
      createdBy: 'jogo:Fulano (76561190000000001)',
    });
    expect(lastReply(h)).toMatchObject({ requestId: 'req-1', steamId: PLAYER, ok: true });
    h.service.stop();
  });

  it('a recusa volta ao admin com a frase, e fica no registro', async () => {
    const h = harness();
    const secret = await grabSecret(h);

    h.service.handleLine(SERVER, addLine(secret, { skinId: '404' }));
    await settle(50);

    expect(h.skins.list()).toHaveLength(0);
    expect(lastReply(h)).toMatchObject({ ok: false });
    expect(String(lastReply(h)['message'])).toContain('Steam');
    expect(h.access.audit({ limit: 1 })[0]).toMatchObject({ action: 'game.add-refused', serverId: SERVER });
    h.service.stop();
  });

  it('sem o segredo — um jogador digitando no chat — não cadastra nada', async () => {
    const h = harness();

    await grabSecret(h);

    h.service.handleLine(SERVER, addLine('chute'));
    // E a linha de chat, com o nome antes do marcador, nem é lida.
    h.service.handleLine(SERVER, `[CHAT] Fulano: ${addLine('chute')}`);
    await settle(50);

    expect(h.skins.list()).toHaveLength(0);
    expect(h.sent.some((line) => line.startsWith(WORKSHOP_REPLY))).toBe(false);
  });

  it('o mesmo pedido duas vezes vira UM cadastro e UMA resposta', async () => {
    const h = harness();
    const secret = await grabSecret(h);

    h.service.handleLine(SERVER, addLine(secret));
    h.service.handleLine(SERVER, addLine(secret));
    await settle(50);

    expect(h.skins.list()).toHaveLength(1);
    expect(h.sent.filter((line) => line.startsWith(WORKSHOP_REPLY))).toHaveLength(1);
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
      // Sem `workshop`: o cadastro funciona com os servidores parados.
      registerWorkshopRoutes(api, {
        repository: h.skins,
        access: h.access,
        catalog: h.catalog,
        items: h.items,
        servers: h.servers,
        lookup: (id) => Promise.resolve(h.steam.get(id) ?? { status: 'not_found' }),
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
      payload: { shortname: 'metal.facemask', skinId: '3802433262', servers: [SERVER] },
    });

    expect(created.statusCode).toBe(201);

    const skin = created.json().skin as { id: number; label: string; permission: string | null };

    expect(skin.label).toBe('MetalFacemaskOrigemZ');
    expect(skin.permission).toBeNull();

    const collection = await app.inject({
      method: 'POST',
      url: '/api/workshop/collections',
      payload: { slug: 'Neve', label: 'Neve 2026', permission: 'neve' },
    });

    expect(collection.statusCode).toBe(201);
    expect(collection.json().collection).toMatchObject({ slug: 'neve', permission: 'origemzworkshop.neve' });

    const collectionId = collection.json().collection.id as number;

    const linked = await app.inject({
      method: 'PUT',
      url: `/api/workshop/collections/${String(collectionId)}/skins`,
      payload: { skinIds: [skin.id] },
    });

    expect(linked.statusCode).toBe(200);

    const granted = await app.inject({
      method: 'POST',
      url: '/api/workshop/grants',
      payload: {
        subjectType: 'player',
        subject: PLAYER,
        targetType: 'collection',
        targetId: collectionId,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    expect(granted.statusCode).toBe(201);
    expect(granted.json().grant).toMatchObject({ targetLabel: '/skin neve — Neve 2026', expired: false });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/workshop/grants?subjectType=player&subject=${PLAYER}`,
    });

    expect(listed.json().count).toBe(1);

    const grantId = listed.json().grants[0].id as number;

    expect((await app.inject({ method: 'DELETE', url: `/api/workshop/grants/${String(grantId)}` })).statusCode).toBe(200);

    const audit = await app.inject({ method: 'GET', url: `/api/workshop/audit?steamId=${PLAYER}` });

    expect(audit.json().entries.map((entry: { action: string }) => entry.action)).toEqual([
      'grant.revoke',
      'grant.create',
    ]);
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
