// ============================================================
//  site-domains.test.ts  -  a loja, os kits e o VIP vindos do site.
//
//  O que este arquivo guarda:
//
//    1. o snapshot da loja SUBSTITUI: o que sumiu dele sai da
//       vitrine, e o ACK conta quantos entraram e quantos saíram;
//    2. um snapshot sem `categories` ou sem `offers` é recusado
//       INTEIRO — meia loja apagaria a de todo mundo;
//    3. a oferta que aponta para uma categoria fora do snapshot não
//       entra, e o site vê qual foi;
//    4. o kit é casado por `slug`, e o `servers[]` chega com o id do
//       SITE — traduzido aqui, na fronteira;
//    5. VIP não é snapshot: o que não está em `grants` nem em
//       `revocations` NÃO é tocado;
//    6. revogar o que já venceu não é falha;
//    7. a mesma versão não é reaplicada, nem depois de um restart —
//       é o que impede um `grant` reenviado de estender o VIP duas
//       vezes.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { KitsRepository } from '../src/db/kits-repository.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StoreRepository } from '../src/db/store-repository.js';
import { ApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import { kitsApplier } from '../src/site/appliers/kits.js';
import { storeApplier } from '../src/site/appliers/store.js';
import { vipsApplier } from '../src/site/appliers/vips.js';
import { SiteClient } from '../src/site/client.js';
import {
  DOMAIN_ACK_KEY,
  DOMAIN_ETAG_KEY,
  DOMAIN_VERSION_KEY,
  SiteDomainConfig,
  type DomainApplier,
} from '../src/site/domains.js';
import type { VipList } from '../src/vip/service.js';

const NOW = 1_700_000_000_000;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Canned {
  readonly status: number;
  readonly body?: unknown;
  readonly etag?: string;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly ifNoneMatch: string | null;
}

function fakeFetch(routes: { readonly get?: readonly Canned[]; readonly ack?: readonly Canned[] }): {
  impl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const at = { get: 0, ack: 0 };

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const route = href.endsWith('/ack') ? 'ack' : 'get';
    const queue = routes[route] ?? [];
    const canned = queue[Math.min(at[route], queue.length - 1)] ?? { status: 200, body: { ok: true } };

    at[route] += 1;
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      ifNoneMatch: ((init?.headers ?? {}) as Record<string, string>)['If-None-Match'] ?? null,
    });

    return Promise.resolve(
      new Response(canned.status === 304 || canned.body === undefined ? null : JSON.stringify(canned.body), {
        status: canned.status,
        headers: {
          'content-type': 'application/json',
          ...(canned.etag === undefined ? {} : { etag: canned.etag }),
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

function client(impl: typeof globalThis.fetch): SiteClient {
  return new SiteClient({
    baseUrl: 'https://site.example',
    token: 'tok',
    serverId: 'RUST01',
    userAgent: 'OrigemZ-Rust-Agent/teste',
    logger: silent,
    fetchImpl: impl,
  });
}

function meta(): MetaRepository {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  return new MetaRepository(db);
}

function repositories(): { store: StoreRepository; kits: KitsRepository } {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // O vínculo kit-servidor tem chave estrangeira: sem a linha do
  // servidor, o kit nem chega a ser gravado. É o mesmo motivo pelo
  // qual a rota local confere `servers[]` antes de chamar o
  // repositório.
  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'PVP 1',
    identity: 'pvp1',
    gamePort: 28015,
    rconPort: 28016,
    queryPort: 28017,
    appPort: 28082,
    installDir: 'Servers/pvp1',
  });

  return { store: new StoreRepository(db), kits: new KitsRepository(db) };
}

/** Uma oferta mínima que passa na régua da rota local. */
function offer(id: string, categoryId: string, name: string): Record<string, unknown> {
  return {
    id,
    categoryId,
    kind: 'item',
    name,
    price: 100,
    icon: { shortname: 'rifle.ak', itemId: 1545779598, skinId: '0' },
    items: [{ shortname: 'rifle.ak', itemId: 1545779598, skinId: '0', amount: 1 }],
  };
}

function loopOf<W>(
  applier: DomainApplier<W>,
  routes: { readonly get?: readonly Canned[]; readonly ack?: readonly Canned[] },
  store = meta(),
): { loop: SiteDomainConfig<W>; calls: Call[]; meta: MetaRepository } {
  const fetch = fakeFetch(routes);

  return {
    loop: new SiteDomainConfig({
      client: client(fetch.impl),
      meta: store,
      applier,
      logger: silent,
      now: () => NOW,
    }),
    calls: fetch.calls,
    meta: store,
  };
}

function acks(calls: readonly Call[]): readonly Record<string, unknown>[] {
  return calls.filter((call) => call.url.endsWith('/ack')).map((call) => call.body as Record<string, unknown>);
}

describe('a loja que vem do site', () => {
  it('substitui: o que sumiu do snapshot sai da vitrine', async () => {
    const { store } = repositories();

    // A loja de antes tem duas categorias; o snapshot traz uma.
    store.saveCategory('antiga', { name: 'Antiga', position: 0, enabled: true });
    store.saveOffer('velha', {
      categoryId: 'antiga',
      kind: 'item',
      name: 'Velha',
      price: 10,
      oldPrice: null,
      position: 0,
      enabled: true,
      badge: null,
      icon: { shortname: 'wood', itemId: -151838493, skinId: '0' },
      items: [{ shortname: 'wood', itemId: -151838493, skinId: '0', amount: 1 }],
      perks: [],
      vip: null,
      vehicle: null,
    });

    const test = loopOf(storeApplier({ repository: store, now: () => NOW }), {
      get: [
        {
          status: 200,
          etag: 'W/"loja-3"',
          body: {
            ok: true,
            version: 3,
            desired: {
              categories: [{ id: 'armas', name: 'Armas', position: 1, enabled: true }],
              offers: [offer('ak', 'armas', 'AK')],
            },
          },
        },
      ],
    });

    await test.loop.pull();

    expect(store.listCategories().map((category) => category.id)).toEqual(['armas']);
    expect(store.listOffers().map((row) => row.id)).toEqual(['ak']);
    expect(acks(test.calls)).toEqual([
      {
        version: 3,
        applied: true,
        errors: [],
        // A contagem é o que separa "entrou" de "entrou tudo".
        stats: { categories: 1, offers: 1, categoriesRemoved: 1, offersRemoved: 1 },
      },
    ]);
    expect(test.meta.read(`${DOMAIN_VERSION_KEY}.store`)).toBe('3');
    expect(test.meta.read(`${DOMAIN_ETAG_KEY}.store`)).toBe('W/"loja-3"');
    expect(test.meta.read(`${DOMAIN_ACK_KEY}.store`)).toBeNull();
  });

  it('meia loja é recusada inteira: sem `offers` nada é apagado', async () => {
    const { store } = repositories();

    store.saveCategory('antiga', { name: 'Antiga', position: 0, enabled: true });

    const test = loopOf(storeApplier({ repository: store }), {
      get: [
        {
          status: 200,
          body: { ok: true, version: 4, desired: { categories: [] } },
        },
      ],
    });

    await test.loop.pull();

    // A categoria continua lá: um `desired` sem uma das duas chaves
    // apagaria a loja de todo mundo com `applied: true`.
    expect(store.listCategories()).toHaveLength(1);
    expect(acks(test.calls)).toEqual([
      {
        version: 4,
        applied: false,
        errors: [{ field: 'store', code: 'INVALID_SHAPE' }],
        stats: {},
      },
    ]);
  });

  it('a oferta órfã não entra, e o resto da loja entra', async () => {
    const { store } = repositories();
    const test = loopOf(storeApplier({ repository: store }), {
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 5,
            desired: {
              categories: [{ id: 'armas', name: 'Armas', position: 0, enabled: true }],
              offers: [offer('ak', 'armas', 'AK'), offer('capacete', 'roupas', 'Capacete')],
            },
          },
        },
      ],
    });

    await test.loop.pull();

    expect(store.listOffers().map((row) => row.id)).toEqual(['ak']);
    expect(acks(test.calls)[0]).toMatchObject({
      applied: true,
      errors: [{ field: 'offers[capacete]', code: 'UNKNOWN_REFERENCE' }],
    });
  });

  it('snapshot com linha inválida grava o que passou e NÃO apaga nada', async () => {
    const { store } = repositories();

    store.saveCategory('antiga', { name: 'Antiga', position: 0, enabled: true });

    const test = loopOf(storeApplier({ repository: store }), {
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 6,
            desired: {
              categories: [
                { id: 'armas', name: 'Armas', position: 0, enabled: true },
                // Sem `name`: a régua da rota local recusa.
                { id: 'roupas', position: 1 },
              ],
              offers: [],
            },
          },
        },
      ],
    });

    await test.loop.pull();

    // ####  O CASO QUE ESTA REGRA MATA  ####
    //
    // Um defeito de serialização do outro lado invalidaria as
    // quarenta ofertas de uma vez, o snapshot chegaria "vazio" para
    // efeito de comparação, e a loja inteira sumiria — com um ACK
    // dizendo `applied: true`. Enquanto houver linha de fora, nada é
    // removido: a versão seguinte, já corrigida, é que limpa.
    expect(store.listCategories().map((row) => row.id).sort()).toEqual(['antiga', 'armas']);
    expect(acks(test.calls)[0]).toMatchObject({
      applied: true,
      errors: [{ field: 'categories[roupas]', code: 'INVALID_VALUE' }],
      stats: { categories: 1, offers: 0, categoriesRemoved: 0, offersRemoved: 0 },
    });
  });

  it('a mesma versão não é reaplicada: config é estado, não tarefa', async () => {
    const { store } = repositories();
    const shared = meta();

    shared.write(`${DOMAIN_VERSION_KEY}.store`, '9', NOW);

    const test = loopOf(
      storeApplier({ repository: store }),
      {
        get: [
          {
            status: 200,
            body: { ok: true, version: 9, desired: { categories: [], offers: [] } },
          },
        ],
      },
      shared,
    );

    await test.loop.pull();

    // Nada foi apagado, e nenhum ACK foi mandado: a versão 9 já
    // tinha sido fechada.
    expect(acks(test.calls)).toEqual([]);
  });
});

describe('os kits que vêm do site', () => {
  it('casa pelo slug e traduz o servidor do site para o id local', async () => {
    const { kits } = repositories();
    const test = loopOf(
      kitsApplier({
        repository: kits,
        localServerId: (siteServerId) => (siteServerId === 'RUST01' ? 'pvp1' : null),
      }),
      {
        get: [
          {
            status: 200,
            body: {
              ok: true,
              version: 2,
              desired: {
                kits: [
                  {
                    slug: 'kit-inicial',
                    name: 'Kit Inicial',
                    kind: 'resgate',
                    useLimit: null,
                    useResetOn: 'never' as const,
                    items: [
                      { slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0 },
                    ],
                    servers: ['RUST01', 'RUST99'],
                  },
                ],
              },
            },
          },
        ],
      },
    );

    await test.loop.pull();

    const saved = kits.getBySlug('kit-inicial');

    expect(saved?.servers).toEqual(['pvp1']);
    // O servidor que não casa com pareamento nenhum não some em
    // silêncio: o kit entra sem ele, e o site vê qual foi.
    expect(acks(test.calls)[0]).toMatchObject({
      applied: true,
      errors: [{ field: 'kits[kit-inicial].servers[RUST99]', code: 'UNKNOWN_REFERENCE' }],
      stats: { created: 1, updated: 0, removed: 0 },
    });
  });

  it('kit que sumiu do snapshot é kit removido', async () => {
    const { kits } = repositories();

    kits.create({
      slug: 'antigo',
      name: 'Antigo',
      description: null,
      category: null,
      kind: 'resgate',
      useLimit: null,
      useResetOn: 'never' as const,
      cooldownSeconds: null,
      wipeDelaySeconds: null,
      requiredTier: null,
      requiredTierExact: false,
      items: [{ slot: 'main', shortname: 'wood', amount: 1, skinId: '0', position: 0 }],
      enabled: true,
      servers: [],
    });

    const test = loopOf(
      kitsApplier({ repository: kits, localServerId: () => null }),
      { get: [{ status: 200, body: { ok: true, version: 3, desired: { kits: [] } } }] },
    );

    await test.loop.pull();

    expect(kits.list()).toHaveLength(0);
    expect(acks(test.calls)[0]).toMatchObject({ stats: { created: 0, updated: 0, removed: 1 } });
  });

  it('o servidor que não casou não impede a limpeza: o kit entrou inteiro', async () => {
    const { kits } = repositories();

    kits.create({
      slug: 'antigo',
      name: 'Antigo',
      description: null,
      category: null,
      kind: 'resgate',
      useLimit: null,
      useResetOn: 'never' as const,
      cooldownSeconds: null,
      wipeDelaySeconds: null,
      requiredTier: null,
      requiredTierExact: false,
      items: [{ slot: 'main', shortname: 'wood', amount: 1, skinId: '0', position: 0 }],
      enabled: true,
      servers: [],
    });

    const test = loopOf(
      kitsApplier({ repository: kits, localServerId: () => null }),
      {
        get: [
          {
            status: 200,
            body: {
              ok: true,
              version: 4,
              desired: {
                kits: [
                  {
                    slug: 'novo',
                    name: 'Novo',
                    kind: 'resgate',
                    useLimit: null,
                    useResetOn: 'never' as const,
                    items: [
                      { slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0 },
                    ],
                    servers: ['RUST99'],
                  },
                ],
              },
            },
          },
        ],
      },
    );

    await test.loop.pull();

    // O `UNKNOWN_REFERENCE` é de uma linha que ENTROU: a lista está
    // completa, e o kit antigo sai.
    expect(kits.list().map((kit) => kit.slug)).toEqual(['novo']);
    expect(acks(test.calls)[0]).toMatchObject({ stats: { created: 1, updated: 0, removed: 1 } });
  });
});

describe('o VIP que vem do site', () => {
  /** O `VipList` visto pelo aplicador, e só ele. */
  function fakeVips(behaviour: {
    readonly onGrant?: (input: { steamId: string; tier: string }) => void;
    readonly onRevoke?: (steamId: string, tier: string) => void;
  }): {
    vips: VipList;
    granted: { steamId: string; tier: string; expiresAt: number | null; origin: string }[];
    revoked: string[];
  } {
    const granted: { steamId: string; tier: string; expiresAt: number | null; origin: string }[] = [];
    const revoked: string[] = [];

    const vips = {
      grant: (input: {
        steamId: string;
        tier: string;
        expiresAt: number | null;
        origin: string;
      }): Promise<unknown> => {
        behaviour.onGrant?.(input);
        granted.push(input);

        return Promise.resolve({});
      },
      revoke: (steamId: string, tier: string): Promise<unknown> => {
        behaviour.onRevoke?.(steamId, tier);
        revoked.push(`${steamId}:${tier}`);

        return Promise.resolve({});
      },
    } as unknown as VipList;

    return { vips, granted, revoked };
  }

  it('concede e revoga o que veio, e não toca no resto', async () => {
    const fake = fakeVips({});
    const test = loopOf(vipsApplier({ vips: fake.vips }), {
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 1,
            desired: {
              grants: [
                {
                  steamId: '76561198123456789',
                  tier: 'gold',
                  expiresAt: '2026-10-01T00:00:00.000Z',
                },
              ],
              revocations: [{ steamId: '76561198987654321', tier: 'silver' }],
            },
          },
        },
      ],
    });

    await test.loop.pull();

    expect(fake.granted).toEqual([
      {
        steamId: '76561198123456789',
        tier: 'gold',
        expiresAt: Date.parse('2026-10-01T00:00:00.000Z'),
        origin: 'loja',
        createdBy: 'site',
      },
    ]);
    expect(fake.revoked).toEqual(['76561198987654321:silver']);
    expect(acks(test.calls)[0]).toMatchObject({
      applied: true,
      stats: { granted: 1, revoked: 1, alreadyRevoked: 0 },
    });
  });

  it('`expiresAt` ausente é recusado: VIP eterno de graça não se descobre sozinho', async () => {
    const fake = fakeVips({});
    const test = loopOf(vipsApplier({ vips: fake.vips }), {
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 2,
            desired: { grants: [{ steamId: '76561198123456789', tier: 'gold' }] },
          },
        },
      ],
    });

    await test.loop.pull();

    expect(fake.granted).toEqual([]);
    expect(acks(test.calls)[0]).toMatchObject({
      errors: [{ field: 'grants[76561198123456789:gold]', code: 'INVALID_SHAPE' }],
    });
  });

  it('revogar o que já venceu não é falha', async () => {
    const fake = fakeVips({
      onRevoke: () => {
        throw new ApiError('VIP_NOT_FOUND', 'não tem VIP ativo', 404);
      },
    });
    const test = loopOf(vipsApplier({ vips: fake.vips }), {
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 3,
            desired: { revocations: [{ steamId: '76561198123456789', tier: 'gold' }] },
          },
        },
      ],
    });

    await test.loop.pull();

    // O estado desejado é o que já vale. Chamar isso de falha faria
    // o admin caçar um problema que não existe.
    expect(acks(test.calls)[0]).toMatchObject({
      applied: true,
      errors: [],
      stats: { granted: 0, revoked: 0, alreadyRevoked: 1 },
    });
  });

  it('o nível que nenhum servidor conhece sobe com o código real do agente', async () => {
    const fake = fakeVips({
      onGrant: () => {
        throw new ApiError('VIP_UNKNOWN_TIER', 'nenhum servidor conhece esse nível', 400);
      },
    });
    const test = loopOf(vipsApplier({ vips: fake.vips }), {
      get: [
        {
          status: 200,
          body: {
            ok: true,
            version: 4,
            desired: {
              grants: [{ steamId: '76561198123456789', tier: 'platina', expiresAt: null }],
            },
          },
        },
      ],
    });

    await test.loop.pull();

    expect(acks(test.calls)[0]).toMatchObject({
      applied: false,
      errors: [{ field: 'grants[76561198123456789:platina]', code: 'VIP_UNKNOWN_TIER' }],
    });
  });
});

describe('o laço', () => {
  it('manda If-None-Match na volta seguinte, e o 304 não aplica nada', async () => {
    const { store } = repositories();
    const shared = meta();
    const test = loopOf(
      storeApplier({ repository: store }),
      {
        get: [
          {
            status: 200,
            etag: 'W/"loja-1"',
            body: {
              ok: true,
              version: 1,
              desired: {
                categories: [{ id: 'armas', name: 'Armas', position: 0, enabled: true }],
                offers: [],
              },
            },
          },
          { status: 304 },
        ],
      },
      shared,
    );

    await test.loop.pull();
    await test.loop.pull();

    const gets = test.calls.filter((call) => !call.url.endsWith('/ack'));

    expect(gets[0]?.ifNoneMatch).toBeNull();
    expect(gets[1]?.ifNoneMatch).toBe('W/"loja-1"');
    // Um ACK só: o 304 não fecha versão nenhuma.
    expect(acks(test.calls)).toHaveLength(1);
  });

  it('o ACK que não passou volta na volta seguinte', async () => {
    const { store } = repositories();
    const shared = meta();
    const test = loopOf(
      storeApplier({ repository: store }),
      {
        get: [
          {
            status: 200,
            body: { ok: true, version: 7, desired: { categories: [], offers: [] } },
          },
          { status: 304 },
        ],
        ack: [{ status: 503, body: { ok: false } }, { status: 200, body: { ok: true } }],
      },
      shared,
    );

    await test.loop.pull();

    // Guardado em disco: só o sucesso o apaga.
    expect(shared.read(`${DOMAIN_ACK_KEY}.store`)).not.toBeNull();

    await test.loop.pull();

    expect(acks(test.calls)).toHaveLength(2);
    expect(shared.read(`${DOMAIN_ACK_KEY}.store`)).toBeNull();
  });

  it('a rota que ainda não existe do outro lado não derruba o laço', async () => {
    const { store } = repositories();
    const test = loopOf(storeApplier({ repository: store }), {
      get: [{ status: 404, body: undefined }],
    });

    await test.loop.pull();

    expect(test.loop.health.appliedVersion).toBeNull();
    expect(test.loop.health.lastError).not.toBeNull();
  });
});
