// ============================================================
//  catalog-status.test.ts  -  "não envia o catálogo há 22 h" é
//  defeito, ou é o certo?
//
//  ####  O CHAMADO QUE ISTO EXISTE PARA ENCERRAR  ####
//
//  Veio assim: *"O agent está online mas não envia o catálogo há
//  22 h. Confira SITE_CATALOG_PUSH_ENABLED no .env dele e a tela de
//  status do próprio agent."*
//
//  As duas pistas estavam erradas, e não por culpa de quem
//  escreveu. A flag estava ligada; a tela de status não falava de
//  catálogo. A resposta só saiu abrindo o banco à mão e comparando
//  o hash do catálogo com o gravado — eram iguais. Ninguém tinha
//  mexido na loja em 22 h, e o push só sai quando a `version` muda.
//
//  O que faltava não era conserto, era um campo. `inSync` é ele:
//
//    inSync=true   silêncio legítimo, por mais longo que seja
//    inSync=false  há mudança presa, e `reason` diz por quê
//
//  ####  E AS DUAS AUSÊNCIAS QUE PARECEM A MESMA  ####
//
//  O espelho não nasce em dois casos, e o sintoma externo é
//  idêntico — integração ligada, beacon `active`, catálogo velho
//  para sempre:
//
//    SITE_CATALOG_PUSH_ENABLED=0     alguém desligou
//    nenhuma carteira remota         não há para quem mandar
//
//  Cada um pede um conserto diferente, então cada um tem um texto.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { StoreRepository, type StoreOfferInput } from '../src/db/store-repository.js';
import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import { CatalogMirror, buildMirror } from '../src/store/catalog-mirror.js';

const NOW = 1_700_000_000_000;
const silent = createLogger({ log: { level: 'silent', pretty: false } });

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
    items: [{ shortname: 'metal.refined', itemId: 69_511_070, skinId: '0', amount: 100 }],
    vip: null,
    vehicle: null,
    badge: 'promo',
    oldPrice: 400,
    perks: [],
    ...over,
  };
}

function cenario(): { repository: StoreRepository; meta: MetaRepository } {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const repository = new StoreRepository(db);

  repository.saveCategory('kits', { name: 'Kits', position: 1, enabled: true }, NOW);
  repository.saveOffer('kit-metal', offer(), NOW);

  return { repository, meta: new MetaRepository(db) };
}

function fakeFetch(): { impl: typeof fetch } {
  let n = 0;

  const impl = ((): Promise<Response> => {
    n += 1;

    // Ímpar = a pergunta barata de versão; par = o push.
    const body = n % 2 === 1 ? { ok: true, version: null } : { ok: true, accepted: true };

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;

  return { impl };
}

function mirrorDe(repository: StoreRepository, meta: MetaRepository): CatalogMirror {
  return new CatalogMirror({
    clients: new Map([
      [
        'server01',
        new SiteClient({
          baseUrl: 'https://site.example',
          token: 'tok',
          serverId: 'RUST01',
          userAgent: 'teste',
          logger: silent,
          fetchImpl: fakeFetch().impl,
        }),
      ],
    ]),
    repository,
    meta,
    logger: silent,
    now: () => NOW,
  });
}

describe('o estado do espelho responde "é defeito?"', () => {
  it('catálogo nunca enviado: inSync falso, e ninguém confirmou versão nenhuma', () => {
    const { repository, meta } = cenario();
    const status = mirrorDe(repository, meta).status;

    expect(status.inSync).toBe(false);
    expect(status.mirrored).toEqual([{ serverId: 'server01', version: null, at: null }]);
    expect(status.lastPushAt).toBeNull();
  });

  // ####  O CASO DAS 22 HORAS  ####
  //
  // Tudo confirmado e nada saindo. É o estado NORMAL de uma loja
  // que ninguém edita — e o que foi confundido com defeito.
  it('depois do push, o silêncio fica em dia: inSync verdadeiro', async () => {
    const { repository, meta } = cenario();
    const mirror = mirrorDe(repository, meta);

    await mirror.push();

    const status = mirror.status;

    expect(status.inSync).toBe(true);
    expect(status.mirrored[0]?.version).toBe(status.version);
    expect(status.mirrored[0]?.at).toBe(NOW);
    expect(status.lastPushError).toBeNull();
  });

  it('mexer na loja derruba o inSync na hora — é o que separa os dois casos', async () => {
    const { repository, meta } = cenario();
    const mirror = mirrorDe(repository, meta);

    await mirror.push();
    expect(mirror.status.inSync).toBe(true);

    // Um preço novo muda o hash, e o espelho passa a dever push.
    repository.saveOffer('kit-metal', offer({ price: 999 }), NOW);

    const status = mirror.status;

    expect(status.inSync).toBe(false);
    expect(status.version).toBe(buildMirror(repository, NOW).version);
    // A versão confirmada continua sendo a ANTIGA — é o que prova
    // que a diferença está no site, e não no cálculo local.
    expect(status.mirrored[0]?.version).not.toBe(status.version);
  });

  // O carimbo é gravado como texto. Um valor ilegível não pode
  // virar NaN: a tela sabe desenhar "não sei quando", e não sabe
  // desenhar NaN.
  it('carimbo ilegível vira null, e não NaN', () => {
    const { repository, meta } = cenario();

    meta.writeMany({ 'site.catalog.mirrored_at.server01': 'ontem' }, NOW);

    expect(mirrorDe(repository, meta).status.mirrored[0]?.at).toBeNull();
  });

  it('a version não muda com o relógio — senão o push sairia a cada minuto', () => {
    const { repository, meta } = cenario();
    const mirror = mirrorDe(repository, meta);

    const agora = mirror.status.version;

    expect(buildMirror(repository, NOW + 86_400_000).version).toBe(agora);
  });
});
