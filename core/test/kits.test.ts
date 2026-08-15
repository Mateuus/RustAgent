// ============================================================
//  kits.test.ts  -  as regras da loja, e o que fica gravado quando
//  a entrega não acontece.
//
//  O que este arquivo guarda:
//
//    1. resgate único recusa a segunda vez;
//    2. cooldown recusa antes da hora e aceita depois — com o
//       relógio INJETADO, sem `sleep` no teste;
//    3. um claim que falha fica gravado como `falhou`, com o
//       motivo, e NÃO queima o resgate de quem não recebeu nada;
//    4. jogador offline é recusa, e a frase diz o que fazer;
//    5. o nível exigido aceita quem tem um nível MAIS ALTO.
//
//  O relógio é injetado do jeito mais simples que existe: o
//  `claimed_at` da linha é reescrito para o passado, e o "agora"
//  das regras continua sendo o de verdade. Assim não há timer, nem
//  espera, nem relógio falso a limpar depois.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { KitsRepository, type KitInput } from '../src/db/kits-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { VipsRepository } from '../src/db/vips-repository.js';
import { isApiError } from '../src/http/error-response.js';
import { KitStore } from '../src/kits/service.js';
import type { LoadoutItem } from '../src/loadouts/items.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';

const STEAM_ID = '76561198123456789';
const OTHER_ID = '76561198000000001';
const HOUR = 3_600_000;

const LEVELS = [
  { Tier: 'bronze', Grupo: 'origemz.vip.bronze', Rank: 10, GrupoPai: '' },
  { Tier: 'gold', Grupo: 'origemz.vip.gold', Rank: 30, GrupoPai: 'origemz.vip.bronze' },
];

interface FakeServer {
  readonly commands: string[];
  connected: boolean;
  /** Quem está dentro do servidor agora. `null` = não deu para ler. */
  online: string[] | null;
  /** O `origemz.give` vai aceitar? Ver o teste da entrega que falha. */
  acceptsGive: boolean;
  readonly configDir: string;
}

let tempRoot: string;

function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      if (!command.startsWith('origemz.give ')) {
        return Promise.resolve('');
      }

      if (!server.acceptsGive) {
        // O código que o plugin devolve quando o jogador saiu entre
        // a conferência e a entrega.
        return Promise.resolve(JSON.stringify({ ok: false, error: 'PLAYER_NOT_FOUND' }));
      }

      return Promise.resolve(
        JSON.stringify({ ok: true, delivered: 'inventory', given: 1, dropped: 0 }),
      );
    },
  };
}

interface Harness {
  readonly db: AgentDatabase;
  readonly kits: KitsRepository;
  readonly vips: VipsRepository;
  readonly store: KitStore;
  readonly server: FakeServer;
}

let harness: Harness;

const ITEMS: readonly LoadoutItem[] = [
  { slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0 },
];

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rustagent-kits-'));

  const configDir = join(tempRoot, 'oxide', 'config');

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'OrigemZVip.json'), JSON.stringify({ Niveis: LEVELS }), 'utf8');

  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'pvp1',
    identity: 'pvp1',
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const server: FakeServer = {
    commands: [],
    connected: true,
    online: [STEAM_ID],
    acceptsGive: true,
    configDir,
  };

  const kits = new KitsRepository(db);
  const vips = new VipsRepository(db);

  harness = {
    db,
    kits,
    vips,
    server,
    store: new KitStore({
      repository: kits,
      vips,
      servers: {
        ids: () => ['pvp1'],
        contextOf: () => ({ rcon: fakeRcon(server) }),
        configOf: () => ({ paths: { oxideConfigDir: configDir } }),
      },
      presence: { online: () => Promise.resolve(server.online) },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Um kit qualquer, com o tipo e os extras que o teste pedir. */
function createKit(overrides: Partial<KitInput> = {}) {
  return harness.kits.create({
    slug: 'kit-teste',
    name: 'Kit de teste',
    description: null,
    kind: 'resgate',
    priceCents: null,
    cooldownSeconds: null,
    requiredTier: null,
    items: ITEMS,
    enabled: true,
    servers: ['pvp1'],
    ...overrides,
  });
}

describe('resgate único', () => {
  it('entrega na primeira vez e recusa na segunda', async () => {
    const kit = createKit();

    const primeira = await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    expect(primeira.status).toBe('entregue');
    expect(primeira.delivered).toBe(1);
    expect(harness.server.commands).toContain(`origemz.give ${STEAM_ID} rifle.ak 1 0 auto`);

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'KIT_ALREADY_CLAIMED',
    );
  });

  it('e a vitrine já diz que ele não pode, com o motivo', async () => {
    const kit = createKit();

    await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    const oferta = (await harness.store.listForServer('pvp1', STEAM_ID))[0];

    // A tela e a rota precisam responder a MESMA coisa: uma tela
    // que oferece o botão e uma rota que recusa é o pior
    // desencontro possível.
    expect(oferta?.available).toBe(false);
    expect(oferta?.reason).toContain('resgate único');
  });
});

describe('cooldown', () => {
  it('recusa antes da hora e aceita depois', async () => {
    const kit = createKit({ slug: 'kit-diario', kind: 'cooldown', cooldownSeconds: 6 * 3600 });

    await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    // Antes da hora: recusa, e a frase diz QUANDO ele volta.
    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'KIT_ON_COOLDOWN');

    // O relógio anda: o claim é reescrito para sete horas atrás. É
    // o mesmo que esperar, sem esperar.
    harness.db
      .prepare('UPDATE kit_claims SET claimed_at = @at WHERE kit_id = @kit')
      .run({ at: Date.now() - 7 * HOUR, kit: kit.id });

    const segunda = await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    expect(segunda.status).toBe('entregue');
  });

  it('e a espera aparece na vitrine, com a data de volta', async () => {
    const kit = createKit({ slug: 'kit-diario', kind: 'cooldown', cooldownSeconds: 6 * 3600 });

    await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    const oferta = (await harness.store.listForServer('pvp1', STEAM_ID))[0];

    expect(oferta?.available).toBe(false);
    expect(oferta?.nextAt).not.toBeNull();
  });
});

describe('a entrega que não acontece', () => {
  it('fica gravada como falhou, com o motivo', async () => {
    const kit = createKit();

    harness.server.acceptsGive = false;

    const resultado = await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    expect(resultado.status).toBe('falhou');
    expect(resultado.delivered).toBe(0);
    // O motivo vem do plugin e sobrevive até o histórico: é a
    // pergunta que o suporte recebe. E ele chega TRADUZIDO —
    // "PLAYER_NOT_FOUND" não diz o que fazer.
    expect(resultado.detail).toContain('saiu do servidor');

    const claim = harness.kits.claim(resultado.claimId);

    expect(claim?.status).toBe('falhou');
    expect(claim?.detail).toContain('rifle.ak');
  });

  it('e NÃO queima o resgate único de quem não recebeu nada', async () => {
    const kit = createKit();

    harness.server.acceptsGive = false;

    await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    harness.server.acceptsGive = true;

    // A segunda tentativa é aceita: a primeira não chegou ao
    // jogador, e queimar a única chance dele seria cobrar por uma
    // entrega que não houve.
    const segunda = await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    expect(segunda.status).toBe('entregue');

    // As duas linhas ficam no histórico — a que falhou também.
    expect(harness.kits.claimsOf(kit.id, { limit: 10, offset: 0 }).total).toBe(2);
  });

  it('a falha não conta como resgate na contagem do kit', async () => {
    const kit = createKit({ kind: 'compra', priceCents: 1990 });

    harness.server.acceptsGive = false;

    await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    // "Quantas vezes este kit foi resgatado" conta só o que chegou
    // ao jogador.
    expect(harness.kits.get(kit.id)?.claimCount).toBe(0);
  });
});

describe('o jogador precisa estar dentro do servidor', () => {
  it('offline é recusa, e a frase diz o que fazer', async () => {
    const kit = createKit();

    harness.server.online = [];

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isApiError(error) &&
        error.code === 'PLAYER_OFFLINE' &&
        error.message.includes('entre no servidor'),
    );

    // E nada foi gravado: a recusa não é uma tentativa de entrega.
    expect(harness.kits.claimsOf(kit.id, { limit: 10, offset: 0 }).total).toBe(0);
  });

  it('e "não consegui perguntar" é diferente de "está fora"', async () => {
    const kit = createKit();

    harness.server.online = null;

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'PRESENCE_UNAVAILABLE',
    );
  });

  it('sem RCON a entrega é recusada antes de qualquer comando', async () => {
    const kit = createKit();

    harness.server.connected = false;

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'RCON_UNAVAILABLE');

    expect(harness.server.commands).toEqual([]);
  });
});

describe('o nível exigido', () => {
  it('recusa quem não tem o nível', async () => {
    const kit = createKit({ requiredTier: 'gold' });

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'KIT_TIER_REQUIRED');
  });

  it('e aceita quem tem um nível MAIS ALTO', async () => {
    const kit = createKit({ requiredTier: 'bronze' });

    harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'loja',
      createdBy: 'admin',
    });

    // A ordem vem do `Rank` do OrigemZVip.json — a mesma tabela que
    // o plugin usa no `HasVipTier`.
    const resultado = await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    expect(resultado.status).toBe('entregue');
  });

  it('um VIP vencido não vale como nível', async () => {
    const kit = createKit({ requiredTier: 'gold' });

    harness.vips.grant(
      {
        steamId: STEAM_ID,
        tier: 'gold',
        expiresAt: Date.now() - 1_000,
        origin: 'loja',
        createdBy: 'admin',
      },
      Date.now() - 10_000,
    );

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'KIT_TIER_REQUIRED');
  });
});

describe('o kit é da rede, e cada servidor decide se o oferece', () => {
  it('um kit que não é oferecido aqui não é entregue aqui', async () => {
    const kit = createKit({ servers: [] });

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: STEAM_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'KIT_NOT_OFFERED_HERE',
    );
  });

  it('e um kit desligado some da entrega, sem perder o histórico', async () => {
    const kit = createKit();

    await harness.store.claim({
      kitId: kit.id,
      steamId: STEAM_ID,
      serverId: 'pvp1',
      actor: 'admin',
    });

    harness.kits.update(kit.id, {
      slug: kit.slug,
      name: kit.name,
      description: null,
      kind: 'compra',
      priceCents: 1990,
      cooldownSeconds: null,
      requiredTier: null,
      items: ITEMS,
      enabled: false,
      servers: ['pvp1'],
    });

    harness.server.online = [OTHER_ID];

    await expect(
      harness.store.claim({ kitId: kit.id, steamId: OTHER_ID, serverId: 'pvp1', actor: 'admin' }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'KIT_DISABLED');

    // O histórico do que já foi entregue continua lá.
    expect(harness.kits.get(kit.id)?.claimCount).toBe(1);
  });
});
