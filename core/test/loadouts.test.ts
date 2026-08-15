// ============================================================
//  loadouts.test.ts  -  o que o jogo recebe, e o que ele deixa de
//  receber.
//
//  O que este arquivo guarda:
//
//    1. o payload é o ESTADO COMPLETO: apagar um loadout faz o
//       grupo sumir do JSON empurrado — é assim que "apaguei"
//       chega ao jogo;
//    2. o apelido do nível viaja junto com o nome do grupo, porque
//       quem consome o kit pergunta por NÍVEL (`gold`), e não por
//       grupo (`origemz.vip.gold`);
//    3. o `default` vira `normal`, que é como o OrigemZPlayer chama
//       quem não é VIP nem admin;
//    4. loadout DESLIGADO não vai, e continua guardado;
//    5. o `skinId` sobrevive à ida e volta pelo base64 sem perder
//       dígito;
//    6. payload grande demais é recusado INTEIRO — nada é cortado.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { LoadoutsRepository } from '../src/db/loadouts-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { decodePushPayload } from '../src/game/plugin-push.js';
import type { LoadoutItem } from '../src/loadouts/items.js';
import { buildLoadoutPayload, LoadoutSync } from '../src/loadouts/sync.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';

/**
 * Uma skin com dígitos até o fim, ACIMA de 2^53.
 *
 * O campo é `ulong` do lado do jogo, e é com um valor destes que a
 * garantia se prova: em ponto flutuante ele volta arredondado, e o
 * jogador receberia a arma com outra skin — ou com nenhuma. Uma
 * skin de dez dígitos sobreviveria a um `Number()` por acidente, e
 * o teste não provaria nada.
 */
const SKIN_ID = '3049798513674321987';

const LEVELS = [
  { Tier: 'bronze', Grupo: 'origemz.vip.bronze', Rank: 10, GrupoPai: '' },
  { Tier: 'gold', Grupo: 'origemz.vip.gold', Rank: 30, GrupoPai: 'origemz.vip.bronze' },
];

interface LoadoutPayload {
  readonly tiers: Record<string, LoadoutItem[]>;
}

interface FakeServer {
  readonly commands: string[];
  lastPayload: LoadoutPayload | null;
  connected: boolean;
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

      const sync = /^origemz\.loadout\.sync (\S+)$/.exec(command);

      if (sync === null) {
        return Promise.resolve('');
      }

      server.lastPayload = decodePushPayload(sync[1] ?? '') as LoadoutPayload;

      const tiers = Object.keys(server.lastPayload.tiers).length;
      const items = Object.values(server.lastPayload.tiers).reduce(
        (sum, list) => sum + list.length,
        0,
      );

      return Promise.resolve(JSON.stringify({ ok: true, tiers, items }));
    },
  };
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: LoadoutsRepository;
  readonly sync: LoadoutSync;
  readonly server: FakeServer;
}

let harness: Harness;

function item(overrides: Partial<LoadoutItem> = {}): LoadoutItem {
  return { slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0, ...overrides };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rustagent-loadouts-'));

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

  const server: FakeServer = { commands: [], lastPayload: null, connected: true, configDir };
  const repository = new LoadoutsRepository(db);

  harness = {
    db,
    repository,
    server,
    sync: new LoadoutSync({
      repository,
      servers: {
        ids: () => ['pvp1'],
        contextOf: () => ({ rcon: fakeRcon(server) }),
        configOf: () => ({ paths: { oxideConfigDir: configDir } }),
      },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('o payload é o estado COMPLETO', () => {
  it('apagar um loadout faz o grupo sumir do JSON empurrado', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      items: [item()],
      enabled: true,
      updatedBy: 'admin',
    });

    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.bronze',
      items: [item({ shortname: 'rock' })],
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    expect(Object.keys(harness.server.lastPayload?.tiers ?? {}).sort()).toEqual([
      'bronze',
      'gold',
      'origemz.vip.bronze',
      'origemz.vip.gold',
    ]);

    // Agora apaga um deles.
    expect(harness.repository.remove('pvp1', 'origemz.vip.gold')).toBe(true);

    await harness.sync.push('pvp1', 'teste');

    // O grupo apagado NÃO está mais no payload — nem pelo nome do
    // grupo, nem pelo apelido do nível. É isso que faz o plugin
    // trocar o cache inteiro e o nível ficar sem kit.
    expect(Object.keys(harness.server.lastPayload?.tiers ?? {}).sort()).toEqual([
      'bronze',
      'origemz.vip.bronze',
    ]);
  });

  it('e um loadout DESLIGADO não vai, mas continua guardado', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      items: [item()],
      enabled: false,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    expect(harness.server.lastPayload?.tiers).toEqual({});
    // Guardado: é o "tira do ar sem perder meia hora de montagem".
    expect(harness.repository.get('pvp1', 'origemz.vip.gold')?.items).toHaveLength(1);
  });

  it('grupo sem item nenhum também não entra', () => {
    const payload = buildLoadoutPayload(
      [
        {
          id: 1,
          serverId: 'pvp1',
          groupName: 'origemz.vip.gold',
          items: [],
          enabled: true,
          updatedAt: 1,
          updatedBy: null,
        },
      ],
      [],
    );

    // Ausência é como "sem kit" viaja. Uma lista vazia diria a
    // mesma coisa ocupando espaço num comando que tem teto.
    expect(payload.tiers).toEqual({});
  });
});

describe('a chave do payload', () => {
  it('leva o nome do grupo E o apelido do nível', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      items: [item()],
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    const tiers = harness.server.lastPayload?.tiers ?? {};

    // O nome do grupo é a identidade do loadout no agente...
    expect(tiers['origemz.vip.gold']).toHaveLength(1);
    // ...e o apelido é o que o OrigemZPlayer pergunta ao hub
    // (`GetLoadout("gold")`). Sem ele, o kit nunca chegaria ao
    // jogador.
    expect(tiers.gold).toHaveLength(1);
  });

  it('o `default` vira `normal`, que é como o jogo chama quem não é VIP', () => {
    const payload = buildLoadoutPayload(
      [
        {
          id: 1,
          serverId: 'pvp1',
          groupName: 'default',
          items: [item()],
          enabled: true,
          updatedAt: 1,
          updatedBy: null,
        },
      ],
      [],
    );

    expect(Object.keys(payload.tiers).sort()).toEqual(['default', 'normal']);
  });

  it('e o apelido não rouba o lugar de um grupo que existe de verdade', () => {
    const payload = buildLoadoutPayload(
      [
        {
          id: 1,
          serverId: 'pvp1',
          groupName: 'default',
          items: [item({ shortname: 'rock' })],
          enabled: true,
          updatedAt: 1,
          updatedBy: null,
        },
        {
          id: 2,
          serverId: 'pvp1',
          groupName: 'normal',
          items: [item({ shortname: 'torch' })],
          enabled: true,
          updatedAt: 1,
          updatedBy: null,
        },
      ],
      [],
    );

    // Existe um grupo chamado `normal` com kit próprio: é o dele
    // que vale, e o apelido do `default` não o sobrescreve.
    expect(payload.tiers.normal?.[0]?.shortname).toBe('torch');
    expect(payload.tiers.default?.[0]?.shortname).toBe('rock');
  });

  it('um grupo que não é nível de VIP vai só com o nome dele', () => {
    const payload = buildLoadoutPayload(
      [
        {
          id: 1,
          serverId: 'pvp1',
          groupName: 'evento.natal',
          items: [item()],
          enabled: true,
          updatedAt: 1,
          updatedBy: null,
        },
      ],
      [{ tier: 'gold', group: 'origemz.vip.gold', title: null, rank: 30, parentGroup: null }],
    );

    expect(Object.keys(payload.tiers)).toEqual(['evento.natal']);
  });
});

describe('o skinId atravessa o base64 sem perder dígito', () => {
  it('ida e volta, com os 16 dígitos', async () => {
    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      items: [item({ skinId: SKIN_ID })],
      enabled: true,
      updatedBy: 'admin',
    });

    await harness.sync.push('pvp1', 'teste');

    const entregue = harness.server.lastPayload?.tiers.gold?.[0];

    expect(entregue?.skinId).toBe(SKIN_ID);
    expect(typeof entregue?.skinId).toBe('string');

    // A prova de por que ele é string: como número, volta outro.
    expect(String(Number(SKIN_ID))).not.toBe(SKIN_ID);
  });
});

describe('o teto do payload', () => {
  it('recusa INTEIRO em vez de cortar, e o servidor fica com o que tinha', async () => {
    // Quarenta grupos com o teto de itens cada: o suficiente para
    // passar do limite de bytes do comando.
    for (let index = 0; index < 40; index += 1) {
      harness.repository.save({
        serverId: 'pvp1',
        groupName: `evento.numero${String(index)}`,
        items: Array.from({ length: 60 }, (_, position) => ({
          slot: 'main' as const,
          shortname: 'metal.refined.ore.longname',
          amount: 1000,
          skinId: SKIN_ID,
          position,
        })),
        enabled: true,
        updatedBy: 'admin',
      });
    }

    const resultado = await harness.sync.push('pvp1', 'teste');

    expect(resultado.skipped).toContain('NADA foi enviado');
    // Nenhum comando de sincronização saiu: meio payload faria o
    // plugin trocar um cache íntegro por um incompleto.
    expect(harness.server.commands).toEqual([]);
    expect(harness.server.lastPayload).toBeNull();
  });
});

describe('sem RCON', () => {
  it('a rodada é adiada, e a resposta diz por quê', async () => {
    harness.server.connected = false;

    harness.repository.save({
      serverId: 'pvp1',
      groupName: 'origemz.vip.gold',
      items: [item()],
      enabled: true,
      updatedBy: 'admin',
    });

    const resultado = await harness.sync.push('pvp1', 'teste');

    expect(resultado.skipped).not.toBeNull();
    expect(harness.server.commands).toEqual([]);
  });
});
