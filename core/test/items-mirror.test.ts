// ============================================================
//  items-mirror.test.ts  -  o catálogo de itens do jogo, contado
//  ao site, e as imagens junto.
//
//  O que este arquivo guarda:
//
//    1. o shortname com ESPAÇO viaja — `mini fridge` é item de
//       verdade, e a régua que o recusasse perderia o item, não só
//       o ícone;
//    2. a condição de "nada a fazer" é E, e não OU: version igual
//       com imagem faltando ainda manda. Sem isso, um bootstrap de
//       imagens que morre no meio nunca é retomado;
//    3. o site diz o que falta, e só isso é enviado — em lotes;
//    4. `INVALID_SHORTNAME` é PERMANENTE: reenviar seria o laço
//       infinito que o contrato existe para evitar;
//    5. um 404 recua em vez de insistir.
//
//  Nada aqui sai da máquina: o `fetch` é um dublê, e os ícones
//  moram num diretório temporário.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ItemsSiteMirror, buildItemsMirror, canBeFile } from '../src/game/items-mirror.js';
import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';

const NOW = 1_700_000_000_000;
const silent = createLogger({ log: { level: 'silent', pretty: false } });

/** Um WebP de mentira, com a assinatura RIFF que o site confere. */
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
  Buffer.from('conteudo-de-teste'),
]);

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** O site de mentira: responde na ordem, e guarda o que recebeu. */
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
      method: init?.method ?? 'GET',
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

let tempRoot: string;
let iconDir: string;
let db: AgentDatabase;
let repository: ItemsRepository;
let meta: MetaRepository;

/** Quatro itens, um deles com ESPAÇO no shortname. */
const SCAN = [
  { shortname: 'rifle.ak', displayName: 'Assault Rifle', itemId: 1545779598, category: 'Weapon', maxStack: 1, hasCondition: true },
  { shortname: 'wood', displayName: 'Wood', itemId: -151838493, category: 'Resources', maxStack: 1000, hasCondition: false },
  { shortname: 'mini fridge', displayName: 'Mini Fridge', itemId: 1024486167, category: 'Items', maxStack: 1, hasCondition: false },
  { shortname: '2module.car', displayName: 'Car Chassis', itemId: -866121090, category: 'Fun', maxStack: 1, hasCondition: false },
];

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rustagent-items-'));
  iconDir = join(tempRoot, 'item-icons');

  mkdirSync(iconDir, { recursive: true });

  // Três dos quatro têm ícone. `wood` fica sem, de propósito: item
  // sem PNG no cliente é estado esperado, não erro.
  for (const name of ['rifle.ak', 'mini fridge', '2module.car']) {
    writeFileSync(join(iconDir, `${name}.webp`), WEBP);
  }

  db = openDatabase({ file: MEMORY_DATABASE });
  runMigrations(db);

  repository = new ItemsRepository(db);
  meta = new MetaRepository(db);

  repository.replace({ items: SCAN, protocol: '2633.288.1', source: 'rcon', at: NOW });
});

afterEach(() => {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function mirror(fetchImpl: typeof globalThis.fetch): ItemsSiteMirror {
  return new ItemsSiteMirror({
    clients: new Map([
      [
        'server01',
        new SiteClient({
          baseUrl: 'https://site.example',
          token: 'tok',
          serverId: 'RUST01',
          userAgent: 'OrigemZ-Rust-Agent/teste',
          logger: silent,
          fetchImpl,
        }),
      ],
    ]),
    repository,
    meta,
    iconDirs: [iconDir],
    logger: silent,
    now: () => NOW,
  });
}

/** Só as chamadas de imagem, com os shortnames de cada lote. */
function imageBatches(calls: readonly Call[]): string[][] {
  return calls
    .filter((call) => call.url.endsWith('/items/images'))
    .map((call) =>
      ((call.body as { images: { shortname: string }[] }).images ?? []).map(
        (image) => image.shortname,
      ),
    );
}

describe('o corpo do espelho', () => {
  it('o shortname com ESPAÇO viaja: `mini fridge` é item de verdade', async () => {
    // A régua que recusasse espaço perderia o ITEM, não só o ícone
    // — e são quatro deles no jogo. Ver Docs\29 §3.1.
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 0 } },
      { status: 200, body: { ok: true, accepted: true, count: 4, missingImages: [] } },
    ]);

    await mirror(fetch.impl).push();

    const pushed = fetch.calls.find((call) => call.url.endsWith('/items/mirror'));
    const items = (pushed?.body as { items: { shortname: string }[] }).items;

    expect(items.map((item) => item.shortname)).toContain('mini fridge');
    // E em ordem, senão duas leituras do mesmo estado dariam duas
    // versions e o catálogo atravessaria a rede a cada rodada.
    expect(items.map((item) => item.shortname)).toEqual([
      '2module.car',
      'mini fridge',
      'rifle.ak',
      'wood',
    ]);
  });

  it('o item sem ícone viaja com imageSha null, e isso não é erro', async () => {
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 0 } },
      { status: 200, body: { ok: true, accepted: true, missingImages: [] } },
    ]);

    await mirror(fetch.impl).push();

    const pushed = fetch.calls.find((call) => call.url.endsWith('/items/mirror'));
    const items = (pushed?.body as { items: { shortname: string; imageSha: string | null }[] }).items;

    expect(items.find((item) => item.shortname === 'wood')?.imageSha).toBeNull();
    expect(items.find((item) => item.shortname === 'rifle.ak')?.imageSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a version não muda entre duas montagens do mesmo estado', () => {
    const entries = [
      { shortname: 'wood', displayName: 'Wood', itemId: 1, category: 'x', maxStack: 1, hasCondition: false, removed: false, imageSha: null },
    ];

    expect(buildItemsMirror(entries, '2633', NOW).version).toBe(
      buildItemsMirror(entries, '2633', NOW + 60_000).version,
    );
  });

  it('espaço nas PONTAS não pode virar arquivo, mas o do meio pode', () => {
    // No Windows o espaço no fim é apagado na criação do arquivo, e
    // gravaríamos com um nome procurando por outro para sempre.
    expect(canBeFile('mini fridge')).toBe(true);
    expect(canBeFile('mini fridge ')).toBe(false);
    expect(canBeFile('Rifle.AK')).toBe(false);
  });
});

describe('a version e as imagens', () => {
  it('version igual COM imagem faltando ainda manda: a regra é E, não OU', async () => {
    // O bootstrap de imagens que morre no meio deixa a version já
    // gravada do outro lado. Com OU, as que faltam nunca mais
    // seriam pedidas — catálogo meio ilustrado para sempre.
    const version = buildItemsMirror(
      [
        { shortname: '2module.car', displayName: 'Car Chassis', itemId: -866121090, category: 'Fun', maxStack: 1, hasCondition: false, removed: false, imageSha: null },
      ],
      '2633.288.1',
      NOW,
    ).version;

    const fetch = fakeFetch([
      // A version que o site tem NÃO importa aqui: o que decide é a
      // contagem de imagens.
      { status: 200, body: { ok: true, version, missingImageCount: 3 } },
      { status: 200, body: { ok: true, accepted: true, missingImages: ['rifle.ak'], missingImageCount: 1 } },
      { status: 200, body: { ok: true, stored: 1, urls: {}, rejected: [] } },
      { status: 200, body: { ok: true, accepted: true, missingImages: [], missingImageCount: 0 } },
    ]);

    await mirror(fetch.impl).push();

    expect(imageBatches(fetch.calls)).toEqual([['rifle.ak']]);
  });

  it('version igual e nada faltando: não sai NADA além da pergunta', async () => {
    const first = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 0 } },
      { status: 200, body: { ok: true, accepted: true, missingImages: [] } },
    ]);

    const subject = mirror(first.impl);

    await subject.push();

    const version = subject.status.version;
    const second = fakeFetch([{ status: 200, body: { ok: true, version, missingImageCount: 0 } }]);
    const quiet = mirror(second.impl);

    await quiet.push();

    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.url).toContain('/items/mirror/version');
  });
});

describe('as imagens que o site pede', () => {
  it('só o que veio em missingImages é enviado, e o que não tem ícone fica de fora', async () => {
    // `wood` está na lista do site e NÃO tem ícone aqui: ele
    // simplesmente não vai. Item sem PNG no cliente é normal.
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 3 } },
      {
        status: 200,
        body: {
          ok: true,
          accepted: true,
          missingImages: ['rifle.ak', 'wood', 'mini fridge'],
          missingImageCount: 3,
        },
      },
      { status: 200, body: { ok: true, stored: 2, urls: {}, rejected: [] } },
      { status: 200, body: { ok: true, accepted: true, missingImages: [], missingImageCount: 0 } },
    ]);

    await mirror(fetch.impl).push();

    expect(imageBatches(fetch.calls)).toEqual([['rifle.ak', 'mini fridge']]);

    const batch = fetch.calls.find((call) => call.url.endsWith('/items/images'));
    const images = (batch?.body as { images: { sha256: string; contentType: string; data: string }[] })
      .images;

    expect(images[0]?.contentType).toBe('image/webp');
    expect(images[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // O binário viaja em base64, e volta a ser o mesmo arquivo.
    expect(Buffer.from(images[0]?.data ?? '', 'base64').equals(WEBP)).toBe(true);
  });

  it('INVALID_SHORTNAME é PERMANENTE: aquele nome não volta a ser enviado', async () => {
    // Sem isto: manda, o site recusa, o site continua pedindo,
    // manda de novo. Para sempre. Ver Docs\29 §3.3.
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 2 } },
      {
        status: 200,
        body: { ok: true, accepted: true, missingImages: ['rifle.ak', 'mini fridge'], missingImageCount: 2 },
      },
      {
        status: 200,
        body: {
          ok: true,
          stored: 1,
          urls: {},
          rejected: [{ shortname: 'mini fridge', reason: 'INVALID_SHORTNAME' }],
        },
      },
      // O site ainda pede os dois — e o agente manda só um.
      {
        status: 200,
        body: { ok: true, accepted: true, missingImages: ['rifle.ak', 'mini fridge'], missingImageCount: 2 },
      },
      { status: 200, body: { ok: true, stored: 1, urls: {}, rejected: [] } },
      { status: 200, body: { ok: true, accepted: true, missingImages: [], missingImageCount: 0 } },
    ]);

    await mirror(fetch.impl).push();

    const batches = imageBatches(fetch.calls);

    expect(batches[0]).toEqual(['rifle.ak', 'mini fridge']);
    // Da segunda em diante, o recusado não viaja mais.
    for (const batch of batches.slice(1)) {
      expect(batch).not.toContain('mini fridge');
    }
  });

  it('as outras recusas NÃO são permanentes', async () => {
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 1 } },
      { status: 200, body: { ok: true, accepted: true, missingImages: ['rifle.ak'], missingImageCount: 1 } },
      {
        status: 200,
        body: { ok: true, stored: 0, urls: {}, rejected: [{ shortname: 'rifle.ak', reason: 'WRITE_FAILED' }] },
      },
    ]);

    const subject = mirror(fetch.impl);

    await subject.push();

    const again = fakeFetch([
      { status: 200, body: { ok: true, version: null, missingImageCount: 1 } },
      { status: 200, body: { ok: true, accepted: true, missingImages: ['rifle.ak'], missingImageCount: 1 } },
      { status: 200, body: { ok: true, stored: 1, urls: {}, rejected: [] } },
      { status: 200, body: { ok: true, accepted: true, missingImages: [], missingImageCount: 0 } },
    ]);

    await mirror(again.impl).push();

    expect(imageBatches(again.calls)[0]).toEqual(['rifle.ak']);
  });
});

describe('o site que ainda não tem a rota', () => {
  it('um 404 RECUA, e o diagnóstico separa isso de defeito', async () => {
    const fetch = fakeFetch([{ status: 404, body: { error: 'Not Found' } }]);
    const subject = mirror(fetch.impl);

    await subject.push();

    const first = fetch.calls.length;

    expect(subject.status.routeMissing).toBe(true);
    expect(subject.status.lastPushError).toBe('ITEMS_MIRROR_ROUTE_MISSING');

    // Dentro da janela, não bate de novo.
    await subject.push();

    expect(fetch.calls).toHaveLength(first);
  });
});
