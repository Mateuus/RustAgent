// ============================================================
//  wipe-blueprints.test.ts  -  quem recomeça sabendo o quê.
//
//  O que este arquivo guarda, e cada item é uma regra que já foi
//  escrita em Docs\17 ("as regras que não se negociam"):
//
//    1. o snapshot é DE TODO MUNDO, e o direito é conferido na
//       DEVOLUÇÃO — quem venceu o VIP entre o wipe e a entrega não
//       recebe, e quem COMPROU depois recebe;
//    2. o snapshot vale para o wipe seguinte, e só ele: um
//       snapshot novo expira as devoluções que não saíram;
//    3. a devolução é idempotente por (snapshot, jogador) — entrar
//       e sair três vezes não devolve três vezes, e não devolve
//       zero;
//    4. a página que não cabe no RCON é RECUSADA INTEIRA, e o
//       agente refaz o pedido menor: um BP pela metade parece ter
//       funcionado, e é o pior desfecho possível;
//    5. falhar o snapshot NÃO cancela o wipe — o mundo zera na hora
//       marcada, e o log diz que a política caiu para `wipe`;
//    6. a régua por bancada recorta o que volta, e o jogador leva o
//       melhor dos níveis que tem;
//    7. o `.cs` tem os dois comandos, e o pedaço novo dele é ASCII
//       puro (o compilador do Oxide não é o problema; o arquivo
//       aberto em outra máquina é).
//
//  Nada aqui fala com um servidor de Rust: o RCON é falso e
//  responde o que o plugin responderia.
// ============================================================

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { ServerConfig } from '../src/config.js';
import { BpRepository } from '../src/db/bp-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { registerWipeBlueprintRoutes } from '../src/http/routes/wipe-blueprints.js';
import { registerWipeMapsRoutes } from '../src/http/routes/wipe-maps.js';
import { registerWipeRoutes } from '../src/http/routes/wipe.js';
import { Operation } from '../src/ops/operations.js';
import type { OpsRcon } from '../src/ops/service.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import {
  BP_RESTORE_MAX_PLAYERS,
  BlueprintService,
  DEFAULT_BP_SETTINGS,
  bestRuleOf,
  itemsForRule,
  ruleScore,
  type BpSettings,
  type BpVips,
} from '../src/wipe/blueprints.js';
import { WipeRunner, type WipeServerControl, type WipeServers } from '../src/wipe/run.js';

const SERVER = 'pvp1';
const IDENTITY = 'pvp1';

/** Dois jogadores: um gold, um sem VIP. É o aceite do doc 17. */
const GOLD = '76561198000000001';
const SEM_VIP = '76561198000000002';

const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------
//  §1  A RÉGUA — função pura, sem banco e sem jogo
// ------------------------------------------------------------

describe('a régua por nível', () => {
  it('o jogador leva o MELHOR dos níveis que tem', () => {
    // Quem comprou bronze e ganhou gold não pode ser rebaixado pela
    // ordem em que os níveis aparecem na lista.
    const best = bestRuleOf(DEFAULT_BP_SETTINGS, ['bronze', 'gold']);

    expect(best?.tier).toBe('gold');
    expect(best?.rule.mode).toBe('all');
  });

  it('nível que a régua não conhece não dá direito nenhum', () => {
    expect(bestRuleOf(DEFAULT_BP_SETTINGS, ['diamante'])).toBeNull();
    expect(bestRuleOf(DEFAULT_BP_SETTINGS, [])).toBeNull();
  });

  it('`none` é o mesmo que não ter nível', () => {
    const settings: BpSettings = {
      ...DEFAULT_BP_SETTINGS,
      tiers: { bronze: { mode: 'none', bench: 1 } },
    };

    expect(bestRuleOf(settings, ['bronze'])).toBeNull();
  });

  it('`all` é sempre mais generosa que qualquer bancada', () => {
    expect(ruleScore({ mode: 'all', bench: 1 })).toBeGreaterThan(ruleScore({ mode: 'bench', bench: 3 }));
    expect(ruleScore({ mode: 'bench', bench: 2 })).toBeGreaterThan(ruleScore({ mode: 'none', bench: 3 }));
  });

  it('a bancada recorta: até a 1 não leva o que exige a 2', () => {
    const bench = new Map([
      [10, 0],
      [20, 1],
      [30, 2],
      [40, 3],
    ]);

    const benchOf = (itemId: number): number => bench.get(itemId) ?? 0;
    const items = [10, 20, 30, 40];

    expect(itemsForRule({ mode: 'bench', bench: 1 }, items, benchOf)).toEqual([10, 20]);
    expect(itemsForRule({ mode: 'bench', bench: 2 }, items, benchOf)).toEqual([10, 20, 30]);
    expect(itemsForRule({ mode: 'all', bench: 1 }, items, benchOf)).toEqual(items);
    expect(itemsForRule({ mode: 'none', bench: 3 }, items, benchOf)).toEqual([]);
  });

  it('item que o mapa de bancadas não conhece vale ZERO, e não infinito', () => {
    // Ausência = "não exige bancada". A leitura contrária faria um
    // item novo do jogo sumir da devolução de todo mundo, em
    // silêncio.
    expect(itemsForRule({ mode: 'bench', bench: 1 }, [99], () => 0)).toEqual([99]);
  });
});

// ------------------------------------------------------------
//  §2  O BANCO
// ------------------------------------------------------------

function db(): AgentDatabase {
  const database = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(database);

  new ServersRepository(database).create({
    id: SERVER,
    name: 'PVP 1',
    identity: IDENTITY,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'C:\\nao-existe',
  });

  return database;
}

describe('o repositório de blueprints', () => {
  it('sem configuração, vale o padrão de Docs\\16 §14', () => {
    const repository = new BpRepository(db());
    const settings = repository.getSettings(SERVER);

    expect(settings.tiers.bronze).toEqual({ mode: 'bench', bench: 1 });
    expect(settings.tiers.silver).toEqual({ mode: 'bench', bench: 2 });
    expect(settings.tiers.gold).toEqual({ mode: 'all', bench: 3 });
    expect(settings.delayHours).toBe(0);
  });

  it('grava a régua e a lê de volta', () => {
    const repository = new BpRepository(db());

    const saved = repository.saveSettings(SERVER, {
      tiers: { bronze: { mode: 'none', bench: 1 }, gold: { mode: 'bench', bench: 2 } },
      delayHours: 3,
    });

    expect(saved.tiers.gold).toEqual({ mode: 'bench', bench: 2 });
    expect(saved.delayHours).toBe(3);
  });

  it('configuração ilegível vira o PADRÃO, e não uma exceção', () => {
    const database = db();
    const repository = new BpRepository(database);

    database
      .prepare(
        `INSERT INTO wipe_settings (server_id, key, value, updated_at)
              VALUES (@s, 'bp.tiers', '{isso nao e json', 0)`,
      )
      .run({ s: SERVER });

    // Ela é lida no meio de um wipe e no meio de uma devolução:
    // derrubar qualquer um dos dois por causa de uma linha de
    // configuração seria trocar um problema pequeno por um grande.
    expect(repository.getSettings(SERVER).tiers.gold?.mode).toBe('all');
  });

  it('um snapshot novo EXPIRA as devoluções que não saíram', () => {
    const repository = new BpRepository(db());

    repository.replaceSnapshot(
      SERVER,
      { wipeRunId: null, entries: [{ steamId: GOLD, items: [1, 2] }], benches: new Map() },
      1_000,
    );

    expect(repository.enqueueRestores(SERVER, null, 1_000, 1_000)).toBe(1);

    repository.replaceSnapshot(
      SERVER,
      { wipeRunId: null, entries: [{ steamId: GOLD, items: [3] }], benches: new Map() },
      2_000,
    );

    // A linha NÃO some: "ninguém entrou para receber" é exatamente
    // o que alguém vai querer ler depois.
    expect(repository.counters(SERVER).expired).toBe(1);
    expect(repository.counters(SERVER).pending).toBe(0);
    expect(repository.snapshotOf(SERVER, GOLD)?.items).toEqual([3]);
  });

  it('enfileirar duas vezes não duplica a fila', () => {
    const repository = new BpRepository(db());

    repository.replaceSnapshot(
      SERVER,
      {
        wipeRunId: null,
        entries: [
          { steamId: GOLD, items: [1] },
          { steamId: SEM_VIP, items: [2] },
        ],
        benches: new Map(),
      },
      1_000,
    );

    expect(repository.enqueueRestores(SERVER, null, 5_000, 1_000)).toBe(2);
    // A retomada de um wipe chama de novo. O índice único é quem
    // recusa, e não um `if` que alguém pode esquecer.
    expect(repository.enqueueRestores(SERVER, null, 5_000, 1_000)).toBe(0);
    expect(repository.counters(SERVER).pending).toBe(2);
  });

  it('a fila é a do snapshot DAQUELA execução, e não de um antigo', () => {
    const repository = new BpRepository(db());

    // O admin tirou um snapshot na mão dias antes, para conferir o
    // caminho. O snapshot do wipe, depois, FALHOU.
    repository.replaceSnapshot(
      SERVER,
      { wipeRunId: null, entries: [{ steamId: GOLD, items: [1] }], benches: new Map() },
      1_000,
    );

    // Sem o filtro por execução, a fila abriria em cima do
    // snapshot de segunda-feira e devolveria a todo mundo — com o
    // log da execução dizendo que a política tinha caído para
    // `wipe`. Duas verdades sobre o mesmo wipe.
    expect(repository.enqueueRestores(SERVER, 7, 1_000, 1_000)).toBe(0);
    expect(repository.enqueueRestores(SERVER, null, 1_000, 1_000)).toBe(1);
  });

  it('a devolução com atraso só aparece depois da hora', () => {
    const repository = new BpRepository(db());

    repository.replaceSnapshot(
      SERVER,
      { wipeRunId: null, entries: [{ steamId: GOLD, items: [1] }], benches: new Map() },
      1_000,
    );

    repository.enqueueRestores(SERVER, null, 10_000, 1_000);

    expect(repository.dueRestores(SERVER, 9_999, 10)).toHaveLength(0);
    expect(repository.dueRestores(SERVER, 10_000, 10)).toHaveLength(1);
  });

  it('quem está online entra na CONSULTA, e não num filtro depois dela', () => {
    const repository = new BpRepository(db());

    repository.replaceSnapshot(
      SERVER,
      {
        wipeRunId: null,
        entries: [
          // O que sumiu do jogo vem PRIMEIRO na fila, por id.
          { steamId: SEM_VIP, items: [1] },
          { steamId: GOLD, items: [2] },
        ],
        benches: new Map(),
      },
      1_000,
    );

    repository.enqueueRestores(SERVER, null, 1_000, 1_000);

    // Com teto de uma linha por rodada e o filtro aplicado DEPOIS,
    // a única linha lida seria a de quem não volta mais — e quem
    // está jogando nunca receberia, para sempre.
    const due = repository.dueRestores(SERVER, 2_000, 1, [GOLD]);

    expect(due.map((restore) => restore.steamId)).toEqual([GOLD]);
    // E ninguém online é lista vazia, e não a fila inteira.
    expect(repository.dueRestores(SERVER, 2_000, 10, [])).toHaveLength(0);
  });

  it('a bancada vem do plugin e sobrevive ao servidor parado', () => {
    const repository = new BpRepository(db());

    repository.replaceSnapshot(
      SERVER,
      {
        wipeRunId: null,
        entries: [{ steamId: GOLD, items: [7] }],
        benches: new Map([[7, 3]]),
      },
      1_000,
    );

    expect(repository.benchOf(SERVER, 7)).toBe(3);
    // Item que ninguém mediu não exige bancada.
    expect(repository.benchOf(SERVER, 8)).toBe(0);
  });
});

// ------------------------------------------------------------
//  §3  O PLUGIN, DE MENTIRA
// ------------------------------------------------------------

interface FakePlugin extends OpsRcon {
  /** Os payloads de `origemz.bp.restore`, já decodificados. */
  readonly restored: Record<string, number[]>[];
  readonly exports: { readonly offset: number; readonly limit: number }[];
}

/**
 * Um RCON que responde como o `OrigemZAgent` responderia.
 *
 * `pages` é a base de jogadores; `maxPerPage` simula o frame do
 * WebRCON: pedir mais que isso devolve `PAYLOAD_TOO_LARGE`, que é
 * o que o plugin faz em vez de cortar a resposta.
 */
function fakePlugin(options: {
  readonly players: readonly { readonly steamId: string; readonly items: readonly number[] }[];
  readonly benches?: Readonly<Record<string, number>>;
  readonly maxPerPage?: number;
  readonly exportError?: string;
  /** Quem o plugin NÃO conseguiu aplicar na hora (ficou na fila dele). */
  readonly queued?: readonly string[];
  readonly restoreError?: string;
}): FakePlugin {
  const restored: Record<string, number[]>[] = [];
  const exports: { offset: number; limit: number }[] = [];

  return {
    isConnected: true,
    restored,
    exports,
    send: (command: string) => {
      if (command.startsWith('origemz.bp.export')) {
        const [, rawOffset, rawLimit] = command.split(' ');
        const offset = Number(rawOffset);
        const limit = Number(rawLimit);

        exports.push({ offset, limit });

        if (options.exportError !== undefined) {
          return Promise.resolve(`{"ok":false,"error":"${options.exportError}"}`);
        }

        if (limit > (options.maxPerPage ?? 1_000)) {
          return Promise.resolve('{"ok":false,"error":"PAYLOAD_TOO_LARGE"}');
        }

        return Promise.resolve(
          JSON.stringify({
            ok: true,
            count: options.players.length,
            offset,
            limit,
            players: options.players.slice(offset, offset + limit),
            benches: options.benches ?? {},
          }),
        );
      }

      if (command.startsWith('origemz.bp.restore')) {
        const encoded = command.slice('origemz.bp.restore '.length);
        const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
          readonly players: Record<string, number[]>;
        };

        restored.push(payload.players);

        if (options.restoreError !== undefined) {
          return Promise.resolve(`{"ok":false,"error":"${options.restoreError}"}`);
        }

        const pending = (options.queued ?? []).filter((id) => id in payload.players);

        return Promise.resolve(
          JSON.stringify({
            ok: true,
            players: Object.keys(payload.players).length,
            applied: Object.keys(payload.players).length - pending.length,
            queued: pending.length,
            items: Object.values(payload.players).reduce((sum, list) => sum + list.length, 0),
            dropped: 0,
            pending,
          }),
        );
      }

      return Promise.resolve('{"ok":false,"error":"UNKNOWN"}');
    },
  };
}

/** O VIP da rede, reduzido ao que a devolução pergunta. */
function fakeVips(grants: Readonly<Record<string, readonly string[]>>): BpVips {
  return {
    activeOf: (steamId) => (grants[steamId] ?? []).map((tier) => ({ tier })),
  };
}

function service(options: {
  readonly repository: BpRepository;
  readonly rcon: OpsRcon | null;
  readonly vips: BpVips;
  readonly online?: readonly string[] | null;
}): BlueprintService {
  return new BlueprintService({
    repository: options.repository,
    vips: options.vips,
    servers: { ids: () => [SERVER], rconOf: () => options.rcon },
    online: () => Promise.resolve(options.online === undefined ? [] : options.online),
  });
}

// ------------------------------------------------------------
//  §4  O SNAPSHOT
// ------------------------------------------------------------

describe('o snapshot, antes de o mundo ser apagado', () => {
  it('pagina até o fim e guarda TODO MUNDO, VIP ou não', async () => {
    const repository = new BpRepository(db());

    const plugin = fakePlugin({
      players: [
        { steamId: GOLD, items: [1, 2] },
        { steamId: SEM_VIP, items: [3] },
      ],
      benches: { '2': 2 },
      maxPerPage: 1,
    });

    const result = await service({ repository, rcon: plugin, vips: fakeVips({}) }).snapshot({
      serverId: SERVER,
      wipeRunId: null,
    });

    expect(result.players).toBe(2);
    expect(result.items).toBe(3);

    // O de quem NÃO é VIP também está guardado: quem comprar VIP no
    // dia seguinte ao wipe precisa ter o que restaurar.
    expect(repository.snapshotOf(SERVER, SEM_VIP)?.items).toEqual([3]);
    expect(repository.benchOf(SERVER, 2)).toBe(2);
  });

  it('página grande demais é RECUSADA INTEIRA, e o agente pede menor', async () => {
    const repository = new BpRepository(db());

    const plugin = fakePlugin({
      players: [
        { steamId: GOLD, items: [1] },
        { steamId: SEM_VIP, items: [2] },
      ],
      // Só cabem 6 por página; o padrão pede 25.
      maxPerPage: 6,
    });

    const result = await service({ repository, rcon: plugin, vips: fakeVips({}) }).snapshot({
      serverId: SERVER,
      wipeRunId: null,
    });

    expect(result.shrunkPages).toBeGreaterThan(0);
    // E ninguém foi pulado no caminho: o offset só anda quando a
    // página vem.
    expect(result.players).toBe(2);
    expect(plugin.exports[0]).toEqual({ offset: 0, limit: 25 });
    expect(plugin.exports.some((page) => page.limit <= 6)).toBe(true);
  });

  it('o plugin que recusa derruba o snapshot INTEIRO, e não grava metade', async () => {
    const repository = new BpRepository(db());

    const plugin = fakePlugin({
      players: [{ steamId: GOLD, items: [1] }],
      exportError: 'INTERNAL_ERROR',
    });

    await expect(
      service({ repository, rcon: plugin, vips: fakeVips({}) }).snapshot({
        serverId: SERVER,
        wipeRunId: null,
      }),
    ).rejects.toThrow(/INTERNAL_ERROR/);

    // Um snapshot pela metade seria aceito como completo, e o wipe
    // apagaria os blueprints achando que guardou uma cópia.
    expect(repository.lastSnapshot(SERVER)).toBeNull();
  });

  it('sem RCON não há snapshot — e isso é um erro, não um vazio', async () => {
    const repository = new BpRepository(db());

    await expect(
      service({ repository, rcon: null, vips: fakeVips({}) }).snapshot({
        serverId: SERVER,
        wipeRunId: null,
      }),
    ).rejects.toThrow(/RCON/);
  });
});

// ------------------------------------------------------------
//  §5  A DEVOLUÇÃO
// ------------------------------------------------------------

/** Um servidor com snapshot tirado e a fila aberta. */
function ready(options: {
  readonly grants: Readonly<Record<string, readonly string[]>>;
  readonly online?: readonly string[] | null;
  readonly queued?: readonly string[];
  readonly restoreError?: string;
  readonly delayHours?: number;
  readonly wipeAt?: number;
}): {
  readonly repository: BpRepository;
  readonly plugin: FakePlugin;
  readonly blueprints: BlueprintService;
} {
  const repository = new BpRepository(db());

  repository.saveSettings(SERVER, {
    ...DEFAULT_BP_SETTINGS,
    delayHours: options.delayHours ?? 0,
  });

  repository.replaceSnapshot(
    SERVER,
    {
      wipeRunId: null,
      entries: [
        { steamId: GOLD, items: [10, 20, 30] },
        { steamId: SEM_VIP, items: [10] },
      ],
      // 10 não exige bancada, 20 exige a 1, 30 exige a 3.
      benches: new Map([
        [20, 1],
        [30, 3],
      ]),
    },
    1_000,
  );

  const plugin = fakePlugin({
    players: [],
    queued: options.queued ?? [],
    ...(options.restoreError === undefined ? {} : { restoreError: options.restoreError }),
  });

  const blueprints = service({
    repository,
    rcon: plugin,
    vips: fakeVips(options.grants),
    ...(options.online === undefined ? {} : { online: options.online }),
  });

  blueprints.enqueue({
    serverId: SERVER,
    wipeRunId: null,
    wipeAt: options.wipeAt ?? 1_000,
    now: 1_000,
  });

  return { repository, plugin, blueprints };
}

describe('a devolução, no login e contra o VIP vigente', () => {
  it('o gold recebe tudo; quem não tem VIP não recebe nada', async () => {
    const s = ready({ grants: { [GOLD]: ['gold'] }, online: [GOLD, SEM_VIP] });

    await s.blueprints.deliverDue(SERVER, 2_000);

    expect(s.plugin.restored).toHaveLength(1);
    expect(s.plugin.restored[0]).toEqual({ [GOLD]: [10, 20, 30] });
    // A linha de quem não tem direito CONTINUA pendente: ele pode
    // comprar VIP amanhã, e o snapshot vale até o wipe seguinte.
    expect(s.repository.counters(SERVER)).toMatchObject({ applied: 1, pending: 1 });
  });

  it('a régua do bronze recorta pela bancada', async () => {
    const s = ready({ grants: { [GOLD]: ['bronze'] }, online: [GOLD] });

    await s.blueprints.deliverDue(SERVER, 2_000);

    // 30 exige a bancada 3, e o bronze só volta até a 1.
    expect(s.plugin.restored[0]).toEqual({ [GOLD]: [10, 20] });
  });

  it('VIP que venceu ENTRE o snapshot e a entrega não recebe', async () => {
    const s = ready({ grants: {}, online: [GOLD] });

    await s.blueprints.deliverDue(SERVER, 2_000);

    expect(s.plugin.restored).toHaveLength(0);
    expect(s.repository.counters(SERVER).pending).toBe(2);
  });

  it('quem COMPRA VIP depois do wipe ainda recebe', async () => {
    const s = ready({ grants: {}, online: [SEM_VIP] });

    await s.blueprints.deliverDue(SERVER, 2_000);
    expect(s.plugin.restored).toHaveLength(0);

    // O suporte concede o VIP, e a volta seguinte do relógio entrega.
    const comprou = ready({ grants: { [SEM_VIP]: ['silver'] }, online: [SEM_VIP] });

    await comprou.blueprints.deliverDue(SERVER, 2_000);

    expect(comprou.plugin.restored[0]).toEqual({ [SEM_VIP]: [10] });
  });

  it('quem entra e sai três vezes recebe UMA vez', async () => {
    const s = ready({ grants: { [GOLD]: ['gold'] }, online: [GOLD] });

    await s.blueprints.deliverDue(SERVER, 2_000);
    await s.blueprints.deliverDue(SERVER, 3_000);
    await s.blueprints.deliverDue(SERVER, 4_000);

    expect(s.plugin.restored).toHaveLength(1);
    expect(s.repository.counters(SERVER).applied).toBe(1);
  });

  it('quem está OFFLINE não consome a fila', async () => {
    // `Unlock` precisa do BasePlayer carregado: mandar para quem
    // está fora deixaria a lista na fila volátil do plugin, e um
    // oxide.reload a apagaria com o agente marcando como entregue.
    const s = ready({ grants: { [GOLD]: ['gold'] }, online: [] });

    await s.blueprints.deliverDue(SERVER, 2_000);

    expect(s.plugin.restored).toHaveLength(0);
    expect(s.repository.counters(SERVER).pending).toBe(2);
  });

  it('"não deu para perguntar quem está online" também não consome', async () => {
    const s = ready({ grants: { [GOLD]: ['gold'] }, online: null });

    await s.blueprints.deliverDue(SERVER, 2_000);

    expect(s.plugin.restored).toHaveLength(0);
    expect(s.repository.counters(SERVER).pending).toBe(2);
  });

  it('o que o plugin pôs na FILA DELE continua devido', async () => {
    const s = ready({ grants: { [GOLD]: ['gold'] }, online: [GOLD], queued: [GOLD] });

    await s.blueprints.deliverDue(SERVER, 2_000);

    // O comando saiu (`sent`), mas ninguém confirmou a aplicação: a
    // fila do plugin é volátil, e o agente insiste.
    expect(s.repository.counters(SERVER)).toMatchObject({ sent: 1, applied: 0 });
  });

  it('com atraso de 1 h, a devolução não sai na hora do wipe', async () => {
    const hora = 60 * 60 * 1_000;
    const s = ready({
      grants: { [GOLD]: ['gold'] },
      online: [GOLD],
      delayHours: 1,
      wipeAt: 1_000,
    });

    await s.blueprints.deliverDue(SERVER, 1_000);
    expect(s.plugin.restored).toHaveLength(0);

    await s.blueprints.deliverDue(SERVER, 1_000 + hora);
    expect(s.plugin.restored[0]).toEqual({ [GOLD]: [10, 20, 30] });
  });

  it('o que o plugin recusa sempre vira `failed`, e não tentativa eterna', async () => {
    const s = ready({
      grants: { [GOLD]: ['gold'] },
      online: [GOLD],
      restoreError: 'INVALID_ARGS',
    });

    // Uma linha reenviada a cada trinta segundos até o wipe
    // seguinte encheria o log de ruído e esconderia o resto.
    for (let volta = 0; volta < 8; volta += 1) {
      await s.blueprints.deliverDue(SERVER, 2_000 + volta);
    }

    expect(s.repository.counters(SERVER).failed).toBe(1);
  });

  it('o relógio NUNCA lança, mesmo com o plugin recusando', async () => {
    const s = ready({
      grants: { [GOLD]: ['gold'] },
      online: [GOLD],
      restoreError: 'INVALID_ARGS',
    });

    await expect(s.blueprints.sweep(2_000)).resolves.toBeUndefined();
    expect(s.repository.counters(SERVER).applied).toBe(0);
  });

  it('a devolução na mão explica por que não devolveu', async () => {
    const s = ready({ grants: {}, online: [GOLD] });

    const semVip = await s.blueprints.restoreOne({ serverId: SERVER, steamId: GOLD });

    expect(semVip.sent).toBe(0);
    expect(semVip.message).toContain('VIP');

    // E o `force` é o botão do suporte: devolve o snapshot inteiro.
    const forcado = await s.blueprints.restoreOne({
      serverId: SERVER,
      steamId: GOLD,
      force: true,
    });

    expect(forcado.sent).toBe(3);
  });
});

// ------------------------------------------------------------
//  §6  O WIPE NÃO PARA POR CAUSA DISTO
// ------------------------------------------------------------

describe('falhar o snapshot não cancela o wipe', () => {
  it('o mundo zera na hora marcada, e o log diz que a política caiu', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rustagent-bp-'));

    temporary.push(root);

    const installDir = join(root, 'servidor');
    const saveDir = join(installDir, 'server', IDENTITY);

    await mkdir(saveDir, { recursive: true });
    await writeFile(join(saveDir, 'proceduralmap.4000.12345.287.map'), 'mundo');
    await writeFile(join(saveDir, 'player.blueprints.16.db'), 'bp');

    const database = db();
    const runs = new WipeRunsRepository(database);

    runs.saveExecSettings(SERVER, {
      ...runs.getExecSettings(SERVER),
      announce: { ...runs.getExecSettings(SERVER).announce, offsetsMinutes: [] },
      drain: { enabled: false, waitMinutes: 0, force: false },
      backup: { enabled: false, keep: 3 },
    });

    const config = {
      id: SERVER,
      identity: IDENTITY,
      level: 'Procedural Map',
      seed: 12_345,
      worldSize: 4000,
      paths: { installDir, backupsDir: join(root, 'backups') },
    } as unknown as ServerConfig;

    const servers: WipeServers = { configOf: () => config, updateSettings: () => [] };

    const control: WipeServerControl & { running: boolean } = {
      running: true,
      isRunning: () => Promise.resolve(control.running),
      stop: () => {
        control.running = false;
        return Promise.resolve();
      },
      start: () => {
        control.running = true;
        return Promise.resolve();
      },
      online: () => Promise.resolve(0),
      rconConnected: true,
    };

    const runner = new WipeRunner({
      runs,
      wipes: new WipesRepository(database),
      schedule: new WipeScheduleRepository(database),
      mapPool: new MapPoolRepository(database),
      servers,
      world: { forget: () => undefined, saveCreatedAt: () => Promise.resolve(2_000) },
      blueprints: {
        snapshot: () => Promise.reject(new Error('o plugin nao respondeu')),
        enqueue: () => 0,
      },
    });

    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe_except_vip' });
    const operation = new Operation('wipe-run', SERVER);

    const finished = await runner.run({ serverId: SERVER, runId: run.id, operation, control });

    // O wipe TERMINOU: um wipe travado porque o export não
    // respondeu é pior que um wipe sem devolução.
    expect(finished.status).toBe('done');

    const log = operation
      .logFrom(0)
      .map((line) => line.text)
      .join('\n');

    expect(log).toContain('snapshot de blueprints FALHOU');
    expect(log).toContain('cai para "wipe"');
    // E o pós-wipe diz, na linha do passo, que não havia o que
    // devolver.
    expect(log).toContain('política deste run caiu para "wipe"');
  });
});

// ------------------------------------------------------------
//  §7  O QUE RODA DENTRO DO JOGO
// ------------------------------------------------------------

const PLUGIN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'Plugins',
  'OrigemZAgent.cs',
);

/** O trecho do `.cs` que é desta frente. */
async function pluginTail(): Promise<string> {
  const source = await readFile(PLUGIN_PATH, 'utf8');
  const start = source.indexOf('BLUEPRINTS QUE SOBREVIVEM AO WIPE');

  expect(start).toBeGreaterThan(0);

  return source.slice(start);
}

describe('os dois comandos dentro do jogo', () => {
  it('estão declarados no OrigemZAgent.cs', async () => {
    const source = await readFile(PLUGIN_PATH, 'utf8');

    expect(source).toContain('private const string BpExportCommand = "origemz.bp.export";');
    expect(source).toContain('private const string BpRestoreCommand = "origemz.bp.restore";');
    expect(source).toContain('[ConsoleCommand(BpExportCommand)]');
    expect(source).toContain('[ConsoleCommand(BpRestoreCommand)]');
    // A devolução é NO LOGIN: `UnlockList` exige o BasePlayer
    // carregado.
    expect(source).toContain('private void OnPlayerConnected(BasePlayer player)');
  });

  it('o teto do lote do agente é o MESMO do campo `pending` do plugin', async () => {
    const tail = await pluginTail();

    // O agente marca como entregue quem ficou de FORA de
    // `pending`. Se o plugin cortasse a lista, os nomes que
    // sobrassem apareceriam como entregues sem terem recebido nada.
    expect(tail).toContain(`private const int MaxBpPendingReported = ${String(BP_RESTORE_MAX_PLAYERS)};`);
  });

  it('o pedaço novo é ASCII puro', async () => {
    const tail = await pluginTail();
    const foreign = [...tail].filter((char) => char.codePointAt(0)! > 127);

    // O compilador do Oxide lê o arquivo com a codificação da
    // máquina: um travessão vira lixo no log de quem administra o
    // servidor, e um acento dentro de string vira pergunta no chat.
    expect(foreign).toEqual([]);
  });

  it('não usa sintaxe acima de C# 6', async () => {
    const tail = await pluginTail();

    // O compilador em tempo de execução do Oxide para no C# 6, e o
    // erro sai longe da causa. As quatro que mais escapam:
    expect(tail).not.toMatch(/\bout var\b/);
    expect(tail).not.toMatch(/\bis \w+ [a-z]\w*\s*\)/);
    expect(tail).not.toMatch(/=>\s*$/m);
    expect(tail).not.toMatch(/\$"/);
  });

  it('o agente e o plugin usam o MESMO nome de comando', async () => {
    const source = await readFile(PLUGIN_PATH, 'utf8');
    const agente = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wipe', 'blueprints.ts'),
      'utf8',
    );

    for (const command of ['origemz.bp.export', 'origemz.bp.restore']) {
      expect(source).toContain(command);
      expect(agente).toContain(command);
    }
  });
});

// ------------------------------------------------------------
//  §8  A ÁRVORE DE ROTAS
// ------------------------------------------------------------

describe('as rotas de blueprint na mesma árvore das outras do wipe', () => {
  it('sobem juntas sob /api, sem caminho repetido nem parâmetro divergente', async () => {
    const database = db();
    const app = Fastify();
    const repository = new BpRepository(database);

    const supervisor = {
      ids: () => [SERVER],
      configOf: () => ({ id: SERVER }),
      contextOf: () => null,
    } as unknown as ServerSupervisor;

    void app.register(
      async (api) => {
        registerWipeRoutes(api, { repository: new WipeScheduleRepository(database), supervisor });
        registerWipeMapsRoutes(api, { repository: new MapPoolRepository(database), supervisor });
        registerWipeBlueprintRoutes(api, {
          repository,
          service: service({ repository, rcon: null, vips: fakeVips({}) }),
          supervisor,
        });

        return Promise.resolve();
      },
      { prefix: '/api' },
    );

    // O `ready()` É o teste: é nele que o find-my-way monta a
    // árvore e recusa colisão.
    await expect(app.ready()).resolves.toBeDefined();

    const resposta = await app.inject(`/api/servers/${SERVER}/wipe/blueprints`);

    expect(resposta.statusCode).toBe(200);
    // Com o banco recém-criado a tela abre: nenhum snapshot ainda,
    // e a régua no padrão.
    expect(resposta.json<{ snapshot: unknown }>().snapshot).toBeNull();

    // E o snapshot pedido com o servidor fora do ar é 503 com a
    // frase, e não um snapshot vazio.
    const semRcon = await app.inject({
      method: 'POST',
      url: `/api/servers/${SERVER}/wipe/blueprints/snapshot`,
      payload: {},
    });

    expect(semRcon.statusCode).toBe(503);

    await app.close();
    database.close();
  });
});
