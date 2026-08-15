// ============================================================
//  vips.test.ts  -  as promessas do VIP que ninguém confere
//  olhando.
//
//  O que este arquivo guarda:
//
//    1. RENOVAR SOMA SOBRE O VENCIMENTO, e não sobre hoje — quem
//       renova antes não pode perder dias;
//    2. um VIP vencido é revogado pelo relógio, SAI DO GRUPO do
//       Oxide e some do payload — e rodar o relógio duas vezes não
//       faz nada demais;
//    3. dois VIPs ativos do mesmo nível para o mesmo jogador são
//       recusados pelo índice;
//    4. a reconciliação ADOTA quem já estava no grupo, e tira quem
//       a tabela mandou tirar;
//    5. o SteamID atravessa a API e o payload sem perder dígito.
//
//  Banco em memória e um RCON de mentira que se comporta como o
//  servidor: guarda os grupos do Oxide, responde ao
//  `oxide.show group`, aplica o `origemz.vip.apply` com a MESMA
//  regra do plugin (só o nível mais alto fica) e decodifica o
//  base64 do `origemz.vip.sync`. É o que permite testar a cadeia
//  inteira sem servidor de Rust nenhum.
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { extendExpiry, VipsRepository } from '../src/db/vips-repository.js';
import { decodePushPayload } from '../src/game/plugin-push.js';
import { isApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import { VipExpiryWatcher } from '../src/vip/expiry-watcher.js';
import { VipList } from '../src/vip/service.js';

/** Um SteamID64 com dígitos até o fim. Ver o último `describe`. */
const STEAM_ID = '76561198123456789';
const OTHER_ID = '76561198000000001';

const DAY = 86_400_000;

/** O payload que o plugin recebeu, já decodificado. */
interface VipPayload {
  readonly players: Record<string, { tier: string; expiresAt: string | null }[]>;
}

/** O servidor de mentira: os grupos dele, e o que ele recebeu. */
interface FakeServer {
  /** grupo -> quem está dentro. */
  readonly groups: Map<string, Set<string>>;
  readonly commands: string[];
  /** O último `origemz.vip.sync` que chegou. */
  lastVipPayload: VipPayload | null;
  connected: boolean;
  /** O `OrigemZVip` está carregado aqui? Ver o `origemz.vip.apply`. */
  hasVipPlugin: boolean;
  /** Onde mora o `oxide\config` deste servidor. */
  readonly configDir: string;
}

/** Os três níveis do `server01`, medidos no servidor de verdade. */
const LEVELS = [
  { Tier: 'bronze', Grupo: 'origemz.vip.bronze', Titulo: 'VIP Bronze', Rank: 10, GrupoPai: '' },
  {
    Tier: 'silver',
    Grupo: 'origemz.vip.silver',
    Titulo: 'VIP Prata',
    Rank: 20,
    GrupoPai: 'origemz.vip.bronze',
  },
  {
    Tier: 'gold',
    Grupo: 'origemz.vip.gold',
    Titulo: 'VIP Ouro',
    Rank: 30,
    GrupoPai: 'origemz.vip.silver',
  },
];

let tempRoot: string;

function makeServer(): FakeServer {
  const configDir = join(mkdtempSync(join(tempRoot, 'srv-')), 'oxide', 'config');

  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'OrigemZVip.json'), JSON.stringify({ Niveis: LEVELS }), 'utf8');

  return {
    groups: new Map(LEVELS.map((level) => [level.Grupo, new Set<string>()])),
    commands: [],
    lastVipPayload: null,
    connected: true,
    hasVipPlugin: true,
    configDir,
  };
}

/**
 * Um RCON que se comporta como o servidor.
 *
 * O `origemz.vip.apply` aplica a MESMA regra do `SyncPlayer` do
 * plugin: o jogador fica no grupo do nível mais alto que o cache
 * conhece, e sai dos outros. Sem isso o teste provaria só que o
 * comando saiu — e o que se quer saber é se o jogador acabou no
 * grupo certo.
 */
function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      const show = /^oxide\.show group (\S+)$/.exec(command);

      if (show !== null) {
        const members = [...(server.groups.get(show[1] ?? '') ?? [])];

        return Promise.resolve(
          `Group '${show[1] ?? ''}' players:\n` +
            (members.length === 0 ? 'No players currently in group' : members.join('\n')) +
            `\n\nGroup '${show[1] ?? ''}' permissions:\nNo permissions currently granted`,
        );
      }

      const usergroup = /^oxide\.usergroup (add|remove) (\d{17}) (\S+)$/.exec(command);

      if (usergroup !== null) {
        const group = server.groups.get(usergroup[3] ?? '');

        if (group === undefined) {
          return Promise.resolve(`Group '${usergroup[3] ?? ''}' doesn't exist`);
        }

        if (usergroup[1] === 'add') {
          group.add(usergroup[2] ?? '');
        } else {
          group.delete(usergroup[2] ?? '');
        }

        return Promise.resolve('');
      }

      const sync = /^origemz\.vip\.sync (\S+)$/.exec(command);

      if (sync !== null) {
        server.lastVipPayload = decodePushPayload(sync[1] ?? '') as VipPayload;

        return Promise.resolve(
          JSON.stringify({
            ok: true,
            players: Object.keys(server.lastVipPayload.players).length,
          }),
        );
      }

      const apply = /^origemz\.vip\.apply (\d{17})$/.exec(command);

      if (apply !== null) {
        if (!server.hasVipPlugin) {
          // É o que o console responde a um comando que ninguém
          // registrou. O agente cai para o caminho do Oxide.
          return Promise.resolve(`Command '${command}' not found`);
        }

        const steamId = apply[1] ?? '';
        const grants = server.lastVipPayload?.players[steamId] ?? [];
        const best = LEVELS.filter((level) =>
          grants.some((grant) => grant.tier === level.Tier),
        ).sort((left, right) => right.Rank - left.Rank)[0];

        for (const level of LEVELS) {
          const group = server.groups.get(level.Grupo);

          if (group === undefined) {
            continue;
          }

          if (best !== undefined && level.Grupo === best.Grupo) {
            group.add(steamId);
          } else {
            group.delete(steamId);
          }
        }

        return Promise.resolve(
          JSON.stringify({ ok: true, steamId, tier: best?.Tier ?? null, added: 1, removed: 2 }),
        );
      }

      return Promise.resolve('');
    },
  };
}

interface Harness {
  readonly vips: VipList;
  readonly repository: VipsRepository;
  readonly db: AgentDatabase;
  readonly servers: Map<string, FakeServer>;
}

let harness: Harness;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'rustagent-vips-'));

  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const serversRepository = new ServersRepository(db);
  const servers = new Map<string, FakeServer>();
  let nextPort = 28_015;

  for (const id of ['pvp1', 'pvp2']) {
    serversRepository.create({
      id,
      name: id,
      identity: id,
      gamePort: nextPort,
      rconPort: nextPort + 1,
      queryPort: nextPort + 2,
      appPort: nextPort + 3,
      installDir: `F:\\Servers\\${id}`,
    });

    nextPort += 100;
    servers.set(id, makeServer());
  }

  const repository = new VipsRepository(db);

  harness = {
    repository,
    db,
    servers,
    vips: new VipList({
      repository,
      servers: {
        ids: () => [...servers.keys()].sort(),
        contextOf: (id) => {
          const server = servers.get(id);

          return server === undefined ? null : { rcon: fakeRcon(server) };
        },
        configOf: (id) => {
          const server = servers.get(id);

          return server === undefined ? null : { paths: { oxideConfigDir: server.configDir } };
        },
      },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('renovar soma sobre o VENCIMENTO', () => {
  it('quem renova com 20 dias pela frente fica com 50, e não com 30', () => {
    const agora = Date.now();

    // A regra inteira cabe numa função pura, e é ela que a
    // renovação usa. O teste da função vem antes do teste do
    // caminho porque é aqui que o erro custa dinheiro.
    expect(extendExpiry(agora + 20 * DAY, agora + 30 * DAY, agora)).toBe(agora + 50 * DAY);
  });

  it('e pelo caminho de verdade, com o banco no meio', async () => {
    const agora = Date.now();

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: agora + 20 * DAY,
      origin: 'loja',
      createdBy: 'admin',
    });

    const renovado = await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: Date.now() + 30 * DAY,
      origin: 'loja',
      createdBy: 'admin',
    });

    expect(renovado.outcome).toBe('extended');

    const expiresAt = Date.parse(renovado.vip.expiresAt ?? '');

    // 50 dias, com uma folga de um minuto para o relógio andar
    // entre as duas chamadas.
    expect(expiresAt).toBeGreaterThan(agora + 50 * DAY - 60_000);
    expect(expiresAt).toBeLessThan(agora + 50 * DAY + 60_000);

    // E continua sendo UMA linha: renovar estende, não duplica.
    expect(harness.repository.historyOf(STEAM_ID)).toHaveLength(1);
  });

  it('renovar um que já venceu recomeça de hoje, sem devolver o tempo perdido', () => {
    const agora = Date.now();

    expect(extendExpiry(agora - DAY, agora + 30 * DAY, agora)).toBe(agora + 30 * DAY);
  });

  it('vitalício não é rebaixado por uma compra com data', () => {
    expect(extendExpiry(null, Date.now() + 30 * DAY, Date.now())).toBeNull();
  });

  it('e uma compra vitalícia PROMOVE quem tinha data', () => {
    expect(extendExpiry(Date.now() + 5 * DAY, null, Date.now())).toBeNull();
  });
});

describe('um VIP ativo por (jogador, nível)', () => {
  it('o índice único recusa a segunda linha aberta', () => {
    harness.repository.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'painel',
      createdBy: 'admin',
    });

    // O `grant` do repositório ESTENDE em vez de inserir — é o que
    // impede o índice de estourar. Provamos que ele estende:
    expect(
      harness.repository.grant({
        steamId: STEAM_ID,
        tier: 'gold',
        expiresAt: null,
        origin: 'painel',
        createdBy: 'admin',
      }).outcome,
    ).toBe('extended');

    // E que o banco recusaria mesmo, se alguém tentasse por fora.
    expect(() =>
      harness.db
        .prepare(
          `INSERT INTO vips (steam_id, tier, expires_at, origin, created_at)
           VALUES (@steam_id, 'gold', NULL, 'painel', 1)`,
        )
        .run({ steam_id: STEAM_ID }),
    ).toThrow();
  });

  it('mas aceita conceder de novo depois de revogar, e o histórico fica', async () => {
    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'loja',
      createdBy: 'admin',
    });

    await harness.vips.revoke(STEAM_ID, 'gold', 'admin');

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'loja',
      createdBy: 'admin',
    });

    const historico = harness.repository.historyOf(STEAM_ID);

    // Duas linhas: a revogada e a ativa. Revogar NÃO apaga.
    expect(historico).toHaveLength(2);
    expect(historico.filter((vip) => vip.revokedAt === null)).toHaveLength(1);
  });
});

describe('o nível vem do OrigemZVip.json', () => {
  it('a lista de níveis conhecidos sai do config de cada servidor', async () => {
    const tiers = await harness.vips.knownTiers();

    expect([...tiers.keys()].sort()).toEqual(['bronze', 'gold', 'silver']);
    expect(tiers.get('gold')?.group).toBe('origemz.vip.gold');
    // Os dois servidores declaram os mesmos três níveis.
    expect(tiers.get('gold')?.servers).toEqual(['pvp1', 'pvp2']);
  });

  it('e um nível que nenhum servidor conhece é recusado', async () => {
    await expect(
      harness.vips.grant({
        steamId: STEAM_ID,
        tier: 'diamante',
        expiresAt: null,
        origin: 'loja',
        createdBy: 'admin',
      }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'UNKNOWN_VIP_TIER');
  });
});

describe('conceder põe no grupo e empurra o estado', () => {
  it('o jogador entra no grupo do nível, nos dois servidores', async () => {
    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'loja',
      createdBy: 'admin',
    });

    for (const server of harness.servers.values()) {
      expect(server.groups.get('origemz.vip.gold')?.has(STEAM_ID)).toBe(true);
      // Só o nível MAIS ALTO: os outros dois ficam vazios.
      expect(server.groups.get('origemz.vip.silver')?.has(STEAM_ID)).toBe(false);
      expect(server.lastVipPayload?.players[STEAM_ID]?.[0]?.tier).toBe('gold');
    }
  });

  it('e sem o OrigemZVip o agente faz o mesmo pelos grupos do Oxide', async () => {
    const pvp1 = harness.servers.get('pvp1');

    if (pvp1 !== undefined) {
      pvp1.hasVipPlugin = false;
    }

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'silver',
      expiresAt: null,
      origin: 'painel',
      createdBy: 'admin',
    });

    expect(pvp1?.groups.get('origemz.vip.silver')?.has(STEAM_ID)).toBe(true);
    // O caminho de reserva usa o módulo do Oxide, com o nome do
    // grupo lido do config — nunca montado na mão.
    expect(pvp1?.commands).toContain(`oxide.usergroup add ${STEAM_ID} origemz.vip.silver`);
  });
});

describe('o prazo', () => {
  it('um VIP vencido é revogado pelo relógio, sai do grupo e some do payload', async () => {
    const agora = Date.now();

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: agora + 60_000,
      origin: 'loja',
      createdBy: 'admin',
    });

    const pvp1 = harness.servers.get('pvp1');

    expect(pvp1?.groups.get('origemz.vip.gold')?.has(STEAM_ID)).toBe(true);

    // O relógio, um minuto e um segundo depois.
    const vencidos = await harness.vips.sweepExpired(agora + 61_000);

    expect(vencidos.map((vip) => vip.steamId)).toEqual([STEAM_ID]);
    expect(pvp1?.groups.get('origemz.vip.gold')?.has(STEAM_ID)).toBe(false);
    // E o payload que ficou no plugin não tem mais o jogador.
    expect(pvp1?.lastVipPayload?.players[STEAM_ID]).toBeUndefined();

    const linha = harness.repository.latestOf(STEAM_ID, 'gold');

    // Revogado pelo RELÓGIO: `revoked_at` preenchido e `revoked_by`
    // nulo. É a assinatura de "ninguém revogou, o prazo acabou".
    expect(linha?.revokedAt).not.toBeNull();
    expect(linha?.revokedBy).toBeNull();
  });

  it('e rodar o relógio duas vezes não faz nada demais', async () => {
    const agora = Date.now();

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: agora + 60_000,
      origin: 'loja',
      createdBy: 'admin',
    });

    expect(await harness.vips.sweepExpired(agora + 61_000)).toHaveLength(1);
    // A segunda passada não encontra vencido nenhum: a primeira já
    // os fechou. É a propriedade que permite o relógio bater a cada
    // minuto para sempre.
    expect(await harness.vips.sweepExpired(agora + 62_000)).toHaveLength(0);

    expect(harness.repository.historyOf(STEAM_ID)).toHaveLength(1);
  });

  it('o relógio nunca lança, mesmo com os servidores fora do ar', async () => {
    const agora = Date.now();

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: agora + 60_000,
      origin: 'loja',
      createdBy: 'admin',
    });

    for (const server of harness.servers.values()) {
      server.connected = false;
    }

    const watcher = new VipExpiryWatcher({
      vips: harness.vips,
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    });

    // A linha é revogada mesmo sem ninguém para avisar: o grupo é
    // conferido na reconciliação da próxima conexão.
    await expect(watcher.sweep()).resolves.toBeUndefined();
  });

  it('recusa um VIP que já nasce vencido', async () => {
    await expect(
      harness.vips.grant({
        steamId: STEAM_ID,
        tier: 'gold',
        expiresAt: Date.now() - 1_000,
        origin: 'loja',
        createdBy: 'admin',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'VIP_ALREADY_EXPIRED',
    );
  });
});

describe('a reconciliação', () => {
  it('adota quem já estava no grupo e o agente não conhecia', async () => {
    const pvp1 = harness.servers.get('pvp1');

    // Alguém pôs o jogador no grupo à mão, antes de o agente
    // chegar. Aquilo foi decisão de alguém.
    pvp1?.groups.get('origemz.vip.gold')?.add(OTHER_ID);

    const resultado = await harness.vips.reconcile('pvp1');

    expect(resultado.adopted).toEqual([OTHER_ID]);
    // Ele CONTINUA no grupo: adotar não é mexer no Oxide.
    expect(pvp1?.groups.get('origemz.vip.gold')?.has(OTHER_ID)).toBe(true);

    const adotado = harness.repository.latestOf(OTHER_ID, 'gold');

    expect(adotado?.origin).toBe('adotado');
    // Vitalício: o agente não sabe que prazo alguém combinou por
    // fora, e inventar uma data faria o relógio tirar sozinho um
    // benefício que ele não deu.
    expect(adotado?.expiresAt).toBeNull();
  });

  it('tira do grupo quem a tabela revogou com o servidor fora do ar', async () => {
    const pvp1 = harness.servers.get('pvp1');

    await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'loja',
      createdBy: 'admin',
    });

    // O servidor cai ANTES da revogação: a saída do grupo não chega
    // nele.
    if (pvp1 !== undefined) {
      pvp1.connected = false;
    }

    await harness.vips.revoke(STEAM_ID, 'gold', 'admin');

    if (pvp1 !== undefined) {
      pvp1.connected = true;
    }

    expect(pvp1?.groups.get('origemz.vip.gold')?.has(STEAM_ID)).toBe(true);

    const resultado = await harness.vips.reconcile('pvp1');

    expect(resultado.removed).toEqual([STEAM_ID]);
    expect(resultado.adopted).toEqual([]);
    expect(pvp1?.groups.get('origemz.vip.gold')?.has(STEAM_ID)).toBe(false);
  });

  it('não age quando o RCON está fora do ar', async () => {
    const pvp1 = harness.servers.get('pvp1');

    if (pvp1 !== undefined) {
      pvp1.connected = false;
      pvp1.commands.length = 0;
    }

    const resultado = await harness.vips.reconcile('pvp1');

    expect(resultado.skipped).not.toBeNull();
    expect(pvp1?.commands).toEqual([]);
  });
});

describe('o SteamID atravessa a API e o payload sem perder dígito', () => {
  it('ida e volta pelo JSON, com 17 dígitos', async () => {
    const { vip } = await harness.vips.grant({
      steamId: STEAM_ID,
      tier: 'gold',
      expiresAt: null,
      origin: 'loja',
      createdBy: 'admin',
    });

    // É exatamente o que o Fastify faz com o corpo da resposta.
    const doJson = JSON.parse(JSON.stringify(vip)) as { steamId: unknown };

    expect(doJson.steamId).toBe(STEAM_ID);
    expect(typeof doJson.steamId).toBe('string');

    // E o payload que atravessou o base64 até o plugin carrega o id
    // inteiro: é o último ponto onde ele poderia se perder.
    expect(Object.keys(harness.servers.get('pvp1')?.lastVipPayload?.players ?? {})).toEqual([
      STEAM_ID,
    ]);

    // A prova de por que ele é string em toda parte: como número, o
    // mesmo id volta arredondado.
    expect(String(Number(STEAM_ID))).not.toBe(STEAM_ID);
  });

  it('recusa o que não é SteamID64', async () => {
    await expect(
      harness.vips.grant({
        steamId: '12345',
        tier: 'gold',
        expiresAt: null,
        origin: 'loja',
        createdBy: 'admin',
      }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'INVALID_STEAM_ID');
  });
});
