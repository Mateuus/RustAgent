// ============================================================
//  vip-site-mirror.test.ts  -  quem tem VIP no jogo, contado ao site.
//
//  O que este arquivo guarda:
//
//    1. a `version` NÃO muda entre duas montagens do mesmo estado —
//       nem quando a ORDEM de leitura do banco muda;
//    2. o tempo SOZINHO muda a version, porque um VIP que venceu
//       sai do retrato. É a diferença para o catálogo, e é o motivo
//       de o relógio não poder ser desligado;
//    3. revogado e vencido NÃO viajam;
//    4. o retrato vai para os N pareamentos, e cada um guarda a
//       própria versão confirmada;
//    5. um 404 RECUA em vez de insistir — a rota do outro lado
//       ainda não existe, e ela não nasce em um minuto;
//    6. os NÍVEIS declarados viajam junto e DENTRO do hash: mexer no
//       OrigemZVip.json sozinho invalida o retrato.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { VipsRepository } from '../src/db/vips-repository.js';
import { createLogger } from '../src/logger.js';
import { SiteClient } from '../src/site/client.js';
import {
  VipSiteMirror,
  buildVipMirror,
  normalizeTiers,
  MIRROR_404_BACKOFF_MS,
  VIP_MIRROR_MAX_TIERS,
} from '../src/vip/site-mirror.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
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

function open(): { repository: VipsRepository; meta: MetaRepository } {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  return { repository: new VipsRepository(db), meta: new MetaRepository(db) };
}

function grant(
  repository: VipsRepository,
  steamId: string,
  over: { tier?: string; expiresAt?: number | null } = {},
): void {
  repository.grant(
    {
      steamId,
      tier: over.tier ?? 'bronze',
      expiresAt: over.expiresAt === undefined ? NOW + 30 * DAY : over.expiresAt,
      origin: 'loja',
      createdBy: 'loja',
    },
    NOW,
  );
}

const client = (serverId: string, fetchImpl: typeof globalThis.fetch): SiteClient =>
  new SiteClient({
    baseUrl: 'https://site.example',
    token: 'tok',
    serverId,
    userAgent: 'teste',
    logger: silent,
    fetchImpl,
  });

describe('o retrato', () => {
  it('a version não muda entre duas montagens do mesmo estado', () => {
    // Se mudasse, o retrato inteiro atravessaria a rede a cada volta
    // do relógio, para sempre.
    const { repository } = open();

    grant(repository, '76561198000000001');
    grant(repository, '76561198000000002');

    expect(buildVipMirror(repository, NOW).version).toBe(
      buildVipMirror(repository, NOW).version,
    );
  });

  it('a ordem em que os VIPs foram concedidos NÃO muda a version', () => {
    // O retrato é um CONJUNTO: ordem nenhuma significa coisa alguma
    // nele. Mas o hash é sensível a ela — sem ordenar, duas leituras
    // do mesmo estado produziriam duas versions.
    const a = open();
    const b = open();

    grant(a.repository, '76561198000000001');
    grant(a.repository, '76561198000000002');

    grant(b.repository, '76561198000000002');
    grant(b.repository, '76561198000000001');

    expect(buildVipMirror(a.repository, NOW).version).toBe(
      buildVipMirror(b.repository, NOW).version,
    );
  });

  it('o TEMPO sozinho muda a version: quem venceu sai do retrato', () => {
    // Esta é a diferença para o catálogo, e o motivo de o relógio do
    // espelho ser garantia e não otimização: ninguém edita nada, e
    // mesmo assim o que o site precisa saber mudou.
    const { repository } = open();

    grant(repository, '76561198000000001', { expiresAt: NOW + DAY });

    const before = buildVipMirror(repository, NOW);

    expect(before.payload.vips).toHaveLength(1);

    const after = buildVipMirror(repository, NOW + 2 * DAY);

    expect(after.payload.vips).toHaveLength(0);
    expect(after.version).not.toBe(before.version);
  });

  it('o vitalício viaja com expiresAt null, e o prazo em ISO', () => {
    const { repository } = open();

    grant(repository, '76561198000000001', { expiresAt: null });
    grant(repository, '76561198000000002', { expiresAt: NOW + DAY, tier: 'gold' });

    const { payload } = buildVipMirror(repository, NOW);
    const forever = payload.vips.find((vip) => vip.steamId === '76561198000000001');
    const timed = payload.vips.find((vip) => vip.steamId === '76561198000000002');

    expect(forever?.expiresAt).toBeNull();
    // ISO, e não epoch ms: é o vocabulário do site, e a tradução
    // acontece na fronteira.
    expect(timed?.expiresAt).toBe(new Date(NOW + DAY).toISOString());
    expect(timed?.tier).toBe('gold');
    expect(timed?.origin).toBe('loja');
  });

  it('o REVOGADO não viaja', () => {
    // O retrato SUBSTITUI do outro lado. Mandar quem perdeu o VIP
    // faria o site continuar cobrando fila e tag de quem não tem.
    const { repository } = open();

    grant(repository, '76561198000000001');
    grant(repository, '76561198000000002');
    repository.revoke('76561198000000001', 'bronze', 'admin');

    const { payload } = buildVipMirror(repository, NOW);

    expect(payload.vips).toHaveLength(1);
    expect(payload.vips[0]?.steamId).toBe('76561198000000002');
  });

  it('a ADOÇÃO viaja com a origem, e é o que o site não sabe sozinho', () => {
    // Um VIP que o agente encontrou no grupo do Oxide não veio de
    // venda nenhuma. Sem este campo, o site veria um VIP a mais e
    // não teria como distinguir "alguém deu à mão" de "meu grant
    // sumiu".
    const { repository } = open();

    repository.grant(
      {
        steamId: '76561198000000003',
        tier: 'gold',
        expiresAt: null,
        origin: 'adotado',
        createdBy: null,
      },
      NOW,
    );

    expect(buildVipMirror(repository, NOW).payload.vips[0]?.origin).toBe('adotado');
  });

  it('o generatedAt fica FORA do hash', () => {
    const { repository } = open();

    grant(repository, '76561198000000001', { expiresAt: null });

    const early = buildVipMirror(repository, NOW);
    const late = buildVipMirror(repository, NOW + 60_000);

    expect(late.version).toBe(early.version);
    expect(late.payload.generatedAt).not.toBe(early.payload.generatedAt);
  });
});

describe('o push', () => {
  it('vai para os N pareamentos, e cada um guarda a própria versão', async () => {
    const { repository, meta } = open();

    grant(repository, '76561198000000001');

    // version (sem espelho) + push, para cada um dos dois.
    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
    ]);

    const mirror = new VipSiteMirror({
      clients: new Map([
        ['pvp1', client('RUST01', fetch.impl)],
        ['pve', client('RUST02', fetch.impl)],
      ]),
      repository,
      meta,
      logger: silent,
      now: () => NOW,
    });

    await mirror.push();

    expect(fetch.calls.filter((call) => call.url.endsWith('/vip/mirror'))).toHaveLength(2);

    const version = buildVipMirror(repository, NOW).version;

    expect(meta.read('site.vip.mirrored_version.pvp1')).toBe(version);
    expect(meta.read('site.vip.mirrored_version.pve')).toBe(version);

    // A segunda rodada não manda nada: a versão já bate.
    await mirror.push();

    expect(fetch.calls.filter((call) => call.url.endsWith('/vip/mirror'))).toHaveLength(2);
  });

  it('um 404 RECUA em vez de insistir', async () => {
    // Enquanto o Lote de VIP não subir do outro lado, isto tomaria
    // 404 a cada rodada, por servidor — e o log de quem opera viraria
    // uma coluna só de uma linha repetida.
    const { repository, meta } = open();

    grant(repository, '76561198000000001');

    const fetch = fakeFetch([{ status: 404, body: { error: 'Not Found' } }]);
    let now = NOW;

    const mirror = new VipSiteMirror({
      clients: new Map([['pvp1', client('RUST01', fetch.impl)]]),
      repository,
      meta,
      logger: silent,
      now: () => now,
    });

    await mirror.push();

    const first = fetch.calls.length;

    expect(first).toBeGreaterThan(0);
    expect(mirror.status.routeMissing).toBe(true);
    // E o diagnóstico separa "a rota não existe" de "o push quebrou".
    expect(mirror.status.lastPushError).toBe('VIP_MIRROR_ROUTE_MISSING');

    // Dentro da janela: não bate de novo.
    now = NOW + MIRROR_404_BACKOFF_MS - 1;
    await mirror.push();

    expect(fetch.calls).toHaveLength(first);

    // Passada a janela, tenta outra vez — a rota pode ter nascido.
    now = NOW + MIRROR_404_BACKOFF_MS + 1;
    await mirror.push();

    expect(fetch.calls.length).toBeGreaterThan(first);
  });

  it('o site já ter a versão dispensa o corpo inteiro', async () => {
    const { repository, meta } = open();

    grant(repository, '76561198000000001');

    const version = buildVipMirror(repository, NOW).version;
    const fetch = fakeFetch([{ status: 200, body: { ok: true, version } }]);

    const mirror = new VipSiteMirror({
      clients: new Map([['pvp1', client('RUST01', fetch.impl)]]),
      repository,
      meta,
      logger: silent,
      now: () => NOW,
    });

    await mirror.push();

    expect(fetch.calls.filter((call) => call.url.endsWith('/vip/mirror'))).toHaveLength(0);
    expect(meta.read('site.vip.mirrored_version.pvp1')).toBe(version);
  });

  it('inSync fica falso enquanto UM destino estiver atrasado', async () => {
    // Com N pareamentos, "quase todos em dia" é o estado que faz um
    // painel mostrar VIP que já venceu enquanto os outros já sabem.
    const { repository, meta } = open();

    grant(repository, '76561198000000001');

    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
      { status: 500, body: { error: 'boom' } },
    ]);

    const mirror = new VipSiteMirror({
      clients: new Map([
        ['pvp1', client('RUST01', fetch.impl)],
        ['pve', client('RUST02', fetch.impl)],
      ]),
      repository,
      meta,
      logger: silent,
      now: () => NOW,
    });

    await mirror.push();

    expect(mirror.status.inSync).toBe(false);
    expect(mirror.status.count).toBe(1);
  });
});

describe('os níveis que viajam com o retrato', () => {
  it('vão minúsculos, sem repetição e em ordem', () => {
    // A ordem não é enfeite: o hash é sensível a ela, e dois
    // servidores declarando os mesmos níveis em ordens diferentes
    // produziriam duas versions para o mesmo estado.
    const { repository } = open();

    const { payload } = buildVipMirror(repository, NOW, [' GOLD ', 'bronze', 'gold', '']);

    expect(payload.tiers).toEqual(['bronze', 'gold']);
  });

  it('lista vazia é resposta legítima, e o campo existe assim mesmo', () => {
    // "O OrigemZVip.json não declara nível nenhum aqui" é diferente
    // de campo ausente: é o que faz o cadastro do site mostrar o
    // aviso em vez de abrir um campo de texto livre.
    const { repository } = open();

    expect(buildVipMirror(repository, NOW).payload.tiers).toEqual([]);
  });

  it('o teto do site é respeitado AQUI, porque um 400 derruba o corpo inteiro', () => {
    const many = Array.from({ length: VIP_MIRROR_MAX_TIERS + 10 }, (_, at) => `t${String(at).padStart(3, '0')}`);

    expect(normalizeTiers(many)).toHaveLength(VIP_MIRROR_MAX_TIERS);
  });

  it('mexer SÓ nos níveis muda a version', () => {
    // É o ponto do campo estar dentro do hash: um nível novo chega
    // ao site na volta seguinte, e não quando algum jogador ganhar
    // VIP — que seria tarde demais, porque é justamente o nível
    // novo que o admin quer cadastrar.
    const { repository } = open();

    grant(repository, '76561198000000001');

    const before = buildVipMirror(repository, NOW, ['bronze']);
    const after = buildVipMirror(repository, NOW, ['bronze', 'gold']);

    expect(after.version).not.toBe(before.version);
  });

  it('o push lê os níveis UMA vez e os manda no corpo', async () => {
    const { repository, meta } = open();

    grant(repository, '76561198000000001');

    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
    ]);
    let reads = 0;

    const mirror = new VipSiteMirror({
      clients: new Map([['pvp1', client('RUST01', fetch.impl)]]),
      repository,
      meta,
      tiers: (): Promise<readonly string[]> => {
        reads += 1;

        return Promise.resolve(['gold', 'bronze']);
      },
      logger: silent,
      now: () => NOW,
    });

    await mirror.push();

    const pushed = fetch.calls.find((call) => call.url.endsWith('/vip/mirror'));

    expect((pushed?.body as { tiers: string[] }).tiers).toEqual(['bronze', 'gold']);
    expect(reads).toBe(1);
    // E a tela de diagnóstico enxerga a mesma lista, sem ler disco.
    expect(mirror.status.version).toBe(buildVipMirror(repository, NOW, ['bronze', 'gold']).version);
  });

  it('falha de leitura MANTÉM a última lista, em vez de mandar vazia', async () => {
    // Mandar [] porque o disco piscou faria o cadastro do site
    // perder os níveis e cair no campo de texto livre.
    const { repository, meta } = open();

    grant(repository, '76561198000000001');

    const fetch = fakeFetch([
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
      { status: 200, body: { ok: true, version: null } },
      { status: 200, body: { ok: true, accepted: true } },
    ]);
    let broken = false;

    const mirror = new VipSiteMirror({
      clients: new Map([['pvp1', client('RUST01', fetch.impl)]]),
      repository,
      meta,
      tiers: (): Promise<readonly string[]> =>
        broken ? Promise.reject(new Error('EBUSY')) : Promise.resolve(['bronze']),
      logger: silent,
      now: () => NOW,
    });

    await mirror.push();

    broken = true;
    // Um VIP a mais para o retrato mudar e o push acontecer de novo.
    grant(repository, '76561198000000002');
    await mirror.push();

    const bodies = fetch.calls
      .filter((call) => call.url.endsWith('/vip/mirror'))
      .map((call) => (call.body as { tiers: string[] }).tiers);

    expect(bodies).toEqual([['bronze'], ['bronze']]);
  });
});
