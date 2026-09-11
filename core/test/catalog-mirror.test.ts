// ============================================================
//  catalog-mirror.test.ts  -  a loja vista pelo painel do site.
//
//  O que este arquivo guarda:
//
//    1. a `version` NÃO muda entre duas montagens iguais — se
//       mudasse, o catálogo inteiro atravessaria a rede a cada
//       volta do relógio;
//    2. editar uma oferta MUDA a version;
//    3. a RECEITA da entrega não viaja (`items`, `vip`, `vehicle`);
//    4. o snapshot vai para os N pareamentos, e cada um guarda a
//       própria versão confirmada.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { StoreRepository, type StoreOfferInput } from '../src/db/store-repository.js';
import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import { CatalogMirror, buildMirror, stableStringify } from '../src/store/catalog-mirror.js';

const NOW = 1_700_000_000_000;
const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Call {
  readonly url: string;
  readonly body: unknown;
}

function fakeFetch(responses: readonly { status: number; body?: unknown }[]): {
  impl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let at = 0;

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const canned = responses[Math.min(at, responses.length - 1)] ?? { status: 500 };

    at += 1;
    calls.push({
      url: String(url),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });

    return Promise.resolve(
      new Response(JSON.stringify(canned.body ?? { ok: true }), {
        status: canned.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

function offer(over: Partial<StoreOfferInput> = {}): StoreOfferInput {
  return {
    categoryId: 'kits',
    // `bundle` é como a loja chama um kit: o `kind` do CHECK.
    kind: 'bundle',
    name: 'Kit Metal',
    price: 250,
    position: 1,
    enabled: true,
    icon: { shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', file: null },
    items: [
      { shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', amount: 100 },
      { shortname: 'stones', itemId: 1, skinId: '0', amount: 500 },
    ],
    vip: null,
    vehicle: null,
    badge: 'promo',
    oldPrice: 400,
    perks: [],
    ...over,
  };
}

function catalog(): StoreRepository {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const repository = new StoreRepository(db);

  repository.saveCategory('kits', { name: 'Kits', position: 1, enabled: true }, NOW);
  repository.saveOffer('kit-metal', offer(), NOW);

  return repository;
}

describe('o snapshot', () => {
  it('a version não muda entre duas montagens do mesmo catálogo', () => {
    // Se mudasse, o espelho seria empurrado a cada volta do relógio e
    // o catálogo inteiro atravessaria a internet por nada.
    const repository = catalog();

    expect(buildMirror(repository, NOW).version).toBe(
      buildMirror(repository, NOW + 999_999).version,
    );
  });

  it('editar uma oferta MUDA a version', () => {
    const repository = catalog();
    const before = buildMirror(repository, NOW).version;

    repository.saveOffer('kit-metal', offer({ price: 300 }), NOW);

    expect(buildMirror(repository, NOW).version).not.toBe(before);
  });

  it('a RECEITA da entrega não viaja', () => {
    // O painel precisa VER a loja para vender, não precisa saber como
    // o item nasce — e vazar isso daria a receita a quem lesse a
    // resposta dele.
    const { payload } = buildMirror(catalog(), NOW);
    const raw = JSON.stringify(payload);

    expect(raw).not.toContain('metal.refined"},{'); // nenhum items[]
    expect(payload.offers[0]).not.toHaveProperty('items');
    expect(payload.offers[0]).not.toHaveProperty('vip');
    expect(payload.offers[0]).not.toHaveProperty('vehicle');
    // No lugar deles, a contagem: é o que a vitrine precisa para
    // dizer "kit com 2 itens".
    expect(payload.offers[0]?.itemCount).toBe(2);
    // E o que a vitrine mostra continua indo.
    expect(payload.offers[0]?.oldPrice).toBe(400);
    expect(payload.offers[0]?.badge).toBe('promo');
  });

  it('ordena CHAVE de objeto, e nunca elemento de array', () => {
    // Ordem de array é conteúdo: reordenar aqui esconderia uma
    // mudança de posição de oferta.
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('o push', () => {
  it('vai para os N pareamentos, e cada um guarda a própria versão', async () => {
    const db = openDatabase({ file: MEMORY_DATABASE });

    runMigrations(db);

    const repository = new StoreRepository(db);

    repository.saveCategory('kits', { name: 'Kits', position: 1, enabled: true }, NOW);
    repository.saveOffer('kit-metal', offer(), NOW);

    const meta = new MetaRepository(db);
    // version (404) + push, para cada um dos dois pareamentos.
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
    ]);

    const client = (serverId: string): SiteClient =>
      new SiteClient({
        baseUrl: 'https://site.example',
        token: 'tok',
        serverId,
        userAgent: 'teste',
        logger: silent,
        fetchImpl: fetch.impl,
      });

    const mirror = new CatalogMirror({
      clients: new Map([
        ['pvp1', client('RUST01')],
        ['pve', client('RUST02')],
      ]),
      repository,
      meta,
      logger: silent,
      now: () => NOW,
    });

    await mirror.push();

    const pushes = fetch.calls.filter((call) => call.url.endsWith('/shop/mirror'));

    expect(pushes).toHaveLength(2);

    const version = buildMirror(repository, NOW).version;

    expect(meta.read('site.catalog.mirrored_version.pvp1')).toBe(version);
    expect(meta.read('site.catalog.mirrored_version.pve')).toBe(version);

    // A segunda rodada não manda nada: a versão já bate.
    await mirror.push();

    expect(fetch.calls.filter((call) => call.url.endsWith('/shop/mirror'))).toHaveLength(2);
  });

  it('um push recusado guarda o motivo e NÃO derruba nada', async () => {
    const db = openDatabase({ file: MEMORY_DATABASE });

    runMigrations(db);

    const repository = new StoreRepository(db);

    repository.saveCategory('kits', { name: 'Kits', position: 1, enabled: true }, NOW);

    const meta = new MetaRepository(db);
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null } },
      {
        status: 400,
        body: { error: 'este servidor não é de Rust', error_code: 'SHOP_GAME_NOT_SUPPORTED' },
      },
    ]);

    const mirror = new CatalogMirror({
      clients: new Map([
        [
          'pvp1',
          new SiteClient({
            baseUrl: 'https://site.example',
            token: 'tok',
            serverId: 'RUST01',
            userAgent: 'teste',
            logger: silent,
            fetchImpl: fetch.impl,
          }),
        ],
      ]),
      repository,
      meta,
      logger: silent,
      now: () => NOW,
    });

    await expect(mirror.push()).resolves.toBeUndefined();

    // O código CRU fica na tela: é ele que diz que o conserto é no
    // CADASTRO do site, e não no corpo.
    expect(mirror.status.lastPushError).toBe('SHOP_GAME_NOT_SUPPORTED');
    // E a versão NÃO é gravada: o site não a aceitou.
    expect(meta.read('site.catalog.mirrored_version.pvp1')).toBeNull();
  });
});
