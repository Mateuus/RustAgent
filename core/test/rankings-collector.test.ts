// ============================================================
//  rankings-collector.test.ts  -  o caminho PULL do ranking.
//
//  O que este arquivo guarda, e cada item é uma regra do
//  Docs/Ranking/20-PLANO-E-CONTRATOS.md §6 e §8:
//
//    1. o CICLO: flush → apply → ack, e o replay depois de um
//       `ack` perdido soma UMA vez só — sem isso, uma queda de
//       RCON no fim do ciclo dobra o contador de todo mundo;
//    2. `PAYLOAD_TOO_LARGE` reduz a janela pela METADE e NÃO
//       avança o offset; e abandona o ciclo inteiro em `limit = 1`
//       em vez de aplicar meio lote;
//    3. página menor que o `limit` NÃO é fim de lista — o fim é o
//       `count`, e parar no tamanho do array perderia páginas;
//    4. o tempo online é DELTA: a primeira rodada soma zero (só
//       semeia a marca), a segunda soma a diferença, e um delta
//       negativo soma zero;
//    5. um mundo novo detectado grava em `wipes` e vira as
//       janelas — é o buraco do §5.2, em que um wipe feito à mão
//       nunca era registrado;
//    6. servidor sem o plugin não vira erro, e a rodada segue para
//       o próximo;
//    7. o `.cs` tem os dois comandos, o pedaço novo é ASCII puro e
//       não usa sintaxe acima de C# 6.
//
//  Nada aqui fala com um servidor de Rust: o RCON é falso e
//  responde o que o plugin responderia.
// ============================================================

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { PlayersRepository } from '../src/db/players-repository.js';
import { RankingsRepository } from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { STATS_COMMANDS, STATS_CONTRACT } from '../src/game/stats-contract.js';
import type { OpsRcon } from '../src/ops/service.js';
import {
  StatsCollector,
  collectStatsBatch,
  mergePlayers,
  TIME_PLAYED_METRIC,
  type StatsCollectorDeps,
} from '../src/rankings/collector.js';

const SERVER = 'pvp1';
const OTHER = 'pvp2';
const FULANO = '76561198000000001';
const BELTRANO = '76561198000000002';

const NOW = 1_757_000_000_000;

interface Harness {
  readonly db: AgentDatabase;
  readonly rankings: RankingsRepository;
  readonly wipes: WipesRepository;
  readonly players: PlayersRepository;
}

let harness: Harness;

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: id.toUpperCase(),
      identity: id,
      enabled: true,
      gamePort: 28015 + index * 10,
      rconPort: 28016 + index * 10,
      queryPort: 28017 + index * 10,
      appPort: 28082 + index * 10,
      rconHost: '127.0.0.1',
      installDir: `Servers/${id}`,
    });
  }

  harness = {
    db,
    rankings: new RankingsRepository(db),
    wipes: new WipesRepository(db),
    players: new PlayersRepository(db),
  };
});

// ------------------------------------------------------------
//  O RCON de mentira
// ------------------------------------------------------------

interface FakePlayer {
  readonly steamId: string;
  readonly name?: string;
  readonly metrics: Readonly<Record<string, number>>;
}

/** O plugin, como ele responderia — inclusive quando recusa. */
class FakePlugin {
  readonly sent: string[] = [];

  /** O lote pendente, congelado. `null` = ninguém pediu ainda. */
  #pending: { batchId: string; seq: number; players: FakePlayer[] } | null = null;

  #open: FakePlayer[];
  #seq: number;

  /** Acima de quantos jogadores por página a resposta "não cabe". */
  #maxPerPage: number;

  /** Quantos `ack` chegaram — e quantos foram engolidos. */
  acks: string[] = [];
  ackFails = 0;

  constructor(players: FakePlayer[], options: { maxPerPage?: number; seq?: number } = {}) {
    this.#open = players;
    this.#maxPerPage = options.maxPerPage ?? Number.POSITIVE_INFINITY;
    this.#seq = options.seq ?? 40;
  }

  /** O que ainda está no buffer aberto (o que chegou depois do freeze). */
  push(player: FakePlayer): void {
    this.#open.push(player);
  }

  get pendingId(): string | null {
    return this.#pending?.batchId ?? null;
  }

  rcon(): OpsRcon {
    return {
      isConnected: true,
      send: (command: string) => Promise.resolve(this.#handle(command)),
    };
  }

  #handle(command: string): string {
    this.sent.push(command);

    const parts = command.trim().split(/\s+/);

    if (parts[0] === STATS_COMMANDS.ack) {
      return this.#ack(parts[1] ?? '');
    }

    if (parts[0] !== STATS_COMMANDS.flush) {
      return '';
    }

    return this.#flush(Number(parts[1] ?? '0'), Number(parts[2] ?? '100'));
  }

  #flush(offset: number, limit: number): string {
    if (offset === 0 && this.#pending === null) {
      this.#seq += 1;
      this.#pending = {
        batchId: `${SERVER}-1757088123-${String(this.#seq)}`,
        seq: this.#seq,
        players: this.#open,
      };
      this.#open = [];
    }

    const batch = this.#pending;

    if (batch === null) {
      return JSON.stringify({ ok: false, error: 'NO_BATCH' });
    }

    const page = batch.players.slice(offset, offset + limit);

    if (page.length > this.#maxPerPage) {
      // O plugin recusa a página INTEIRA — nunca meia resposta.
      return JSON.stringify({ ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }

    return JSON.stringify({
      ok: true,
      contract: STATS_CONTRACT,
      batchId: batch.batchId,
      seq: batch.seq,
      count: batch.players.length,
      offset,
      limit,
      // Quem não tem métrica não entra no array — é justamente o
      // que faz uma página vir menor que o `limit` sem que a lista
      // tenha acabado.
      players: page.filter((player) => Object.keys(player.metrics).length > 0),
      records: [],
      events: [],
    });
  }

  #ack(batchId: string): string {
    if (this.ackFails > 0) {
      this.ackFails -= 1;
      throw new Error('o RCON caiu antes do ack');
    }

    this.acks.push(batchId);

    if (this.#pending === null || this.#pending.batchId !== batchId) {
      return JSON.stringify({ ok: false, error: 'NO_BATCH' });
    }

    const done = this.#pending;

    this.#pending = null;

    return JSON.stringify({
      ok: true,
      contract: STATS_CONTRACT,
      batchId: done.batchId,
      seq: done.seq,
      players: done.players.length,
    });
  }
}

function collector(
  plugin: FakePlugin | null,
  over: Partial<StatsCollectorDeps> = {},
): StatsCollector {
  return new StatsCollector({
    repository: harness.rankings,
    wipes: harness.wipes,
    players: harness.players,
    servers: {
      ids: () => [SERVER],
      rconOf: () => plugin?.rcon() ?? null,
    },
    pluginLoaded: () => true,
    worldAt: () => Promise.resolve(null),
    ...over,
  });
}

/** Quanto aquele jogador tem daquela métrica na janela `wipe`. */
function valueOf(serverId: string, steamId: string, metric: string): number {
  const period = harness.rankings.openPeriodOf(serverId, 'wipe');

  if (period === null) {
    return 0;
  }

  const row = harness.db
    .prepare(
      `SELECT value FROM player_stats
        WHERE period_id = @period_id AND steam_id = @steam_id AND metric = @metric`,
    )
    .get({ period_id: period.id, steam_id: steamId, metric }) as { value: number } | undefined;

  return row?.value ?? 0;
}

// ------------------------------------------------------------
//  §1  O CICLO, E O `ack` PERDIDO
// ------------------------------------------------------------

describe('o ciclo flush → apply → ack', () => {
  it('soma o lote, confirma depois do COMMIT e não soma de novo no replay', async () => {
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 120, 'ore.total': 120 } },
    ]);

    const round = await collector(plugin).collect(SERVER, NOW);

    expect(round.status).toBe('ok');
    expect(round.applied).toBe(true);
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(120);

    // O `ack` sai DEPOIS do COMMIT, e por isso é a última coisa na
    // conversa com o plugin.
    expect(plugin.sent.at(-1)).toBe(`${STATS_COMMANDS.ack} ${String(round.batchId)}`);
    expect(plugin.acks).toEqual([round.batchId]);
  });

  it('o ack perdido devolve o MESMO lote, e o contador não dobra', async () => {
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 120 } },
    ]);

    // O RCON cai entre o COMMIT e a confirmação: o número já está
    // gravado, e o plugin continua segurando o lote.
    plugin.ackFails = 1;

    const first = await collector(plugin).collect(SERVER, NOW);

    expect(first.applied).toBe(true);
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(120);
    expect(plugin.pendingId).toBe(first.batchId);

    // A rodada seguinte recebe o MESMO batchId. É o `stat_batches`
    // que o reconhece — sem ele, o minério de todo mundo dobraria.
    const second = await collector(plugin).collect(SERVER, NOW + 60_000);

    expect(second.batchId).toBe(first.batchId);
    expect(second.applied).toBe(false);
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(120);

    // E o `ack` sai de novo: uma confirmação repetida é barata, um
    // lote pendente para sempre não é.
    expect(plugin.pendingId).toBeNull();
  });

  it('a rodada VAZIA também deixa batimento — é o que o `coverage` lê', async () => {
    const plugin = new FakePlugin([]);

    expect(harness.rankings.lastBatchAt([SERVER])).toBeNull();

    const round = await collector(plugin).collect(SERVER, NOW);

    expect(round.playersApplied).toBe(0);

    // Sem esta linha, um servidor tranquilo de madrugada apareceria
    // na tela como coleta parada — e "sem dados" acusaria o plugin
    // de estar fora quando ele está de pé.
    expect(harness.rankings.lastBatchAt([SERVER])).toBe(NOW);
  });

  it('o lote congela: o que chega no meio do ciclo fica para o próximo', async () => {
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 100 } },
    ]);

    const first = await collector(plugin).collect(SERVER, NOW);

    // Alguém minerou DEPOIS do congelamento.
    plugin.push({ steamId: BELTRANO, name: 'Beltrano', metrics: { 'ore.sulfur': 50 } });

    const second = await collector(plugin).collect(SERVER, NOW + 60_000);

    expect(second.batchId).not.toBe(first.batchId);
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(100);
    expect(valueOf(SERVER, BELTRANO, 'ore.sulfur')).toBe(50);
  });
});

// ------------------------------------------------------------
//  §2  A JANELA QUE ENCOLHE
// ------------------------------------------------------------

describe('a página que não cabe no frame', () => {
  it('reduz o limit pela METADE e NÃO avança o offset', async () => {
    const players: FakePlayer[] = Array.from({ length: 30 }, (_, index) => ({
      steamId: `76561198000000${String(100 + index)}`,
      name: `J${String(index)}`,
      metrics: { 'ore.stone': index + 1 },
    }));

    // O plugin só aceita 25 por página; o agente começa pedindo 100.
    const plugin = new FakePlugin(players, { maxPerPage: 25 });
    const batch = await collectStatsBatch(plugin.rcon(), 100);

    expect(batch.players).toHaveLength(30);
    expect(batch.shrunkPages).toBeGreaterThan(0);

    const flushes = plugin.sent
      .filter((line) => line.startsWith(STATS_COMMANDS.flush))
      .map((line) => line.split(/\s+/).slice(1).map(Number));

    // 100 recusado → 50 recusado → 25 aceito, TUDO no offset 0.
    expect(flushes.slice(0, 3)).toEqual([
      [0, 100],
      [0, 50],
      [0, 25],
    ]);

    // E o offset só andou depois de uma página caber.
    expect(flushes[3]).toEqual([25, 25]);
  });

  it('abandona o ciclo INTEIRO quando nem `limit = 1` cabe', async () => {
    const plugin = new FakePlugin(
      [{ steamId: FULANO, name: 'Fulano', metrics: { 'ore.stone': 1 } }],
      { maxPerPage: 0 },
    );

    // Meio lote seria confirmado como completo, e o resto do
    // minério iria embora no `ack` sem nada no log.
    await expect(collectStatsBatch(plugin.rcon(), 4)).rejects.toThrow(/abandonado inteiro/);
  });

  it('a rodada que abandona não confirma nada: o lote continua pendente', async () => {
    const plugin = new FakePlugin(
      [{ steamId: FULANO, name: 'Fulano', metrics: { 'ore.stone': 1 } }],
      { maxPerPage: 0 },
    );

    await expect(collector(plugin).collect(SERVER, NOW)).rejects.toThrow();

    expect(plugin.acks).toEqual([]);
    expect(plugin.pendingId).not.toBeNull();
  });

  it('o sweep engole a falha de um servidor e segue', async () => {
    const plugin = new FakePlugin(
      [{ steamId: FULANO, name: 'Fulano', metrics: { 'ore.stone': 1 } }],
      { maxPerPage: 0 },
    );

    // Uma exceção que escapasse pararia a coleta para sempre, em
    // silêncio — o pior jeito de um relógio falhar.
    await expect(collector(plugin).sweep()).resolves.toBeUndefined();
  });
});

// ------------------------------------------------------------
//  §3  PÁGINA MENOR QUE O `limit` NÃO É FIM DE LISTA
// ------------------------------------------------------------

describe('o fim da paginação', () => {
  it('é o `count`, e não o tamanho do array que voltou', async () => {
    // Quem não tem métrica não entra no array `players`: seria um
    // objeto de trinta bytes para dizer "nada". A primeira página
    // volta com UM jogador de dois pedidos, e isso NÃO é o fim.
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.metal': 10 } },
      { steamId: BELTRANO, name: 'Vazio', metrics: {} },
      { steamId: '76561198000000003', name: 'Ciclano', metrics: { 'ore.metal': 7 } },
    ]);

    const batch = await collectStatsBatch(plugin.rcon(), 2);

    // Página 1 = [Fulano] (um só, de dois pedidos); página 2 =
    // [Ciclano]. Parar na página 1 perderia o terceiro.
    expect(batch.players.map((player) => player.steamId)).toEqual([FULANO, '76561198000000003']);

    const flushes = plugin.sent.filter((line) => line.startsWith(STATS_COMMANDS.flush));

    expect(flushes).toEqual([
      `${STATS_COMMANDS.flush} 0 2`,
      `${STATS_COMMANDS.flush} 2 2`,
    ]);
  });

  it('avança pelo `limit` que VOLTOU, e não pelo pedido', async () => {
    const players: FakePlayer[] = Array.from({ length: 5 }, (_, index) => ({
      steamId: `76561198000000${String(200 + index)}`,
      metrics: { 'ore.hqm': 1 },
    }));

    // O plugin normaliza qualquer pedido para 2 por página.
    const rcon: OpsRcon = {
      isConnected: true,
      send: (command: string) => {
        const [, rawOffset] = command.trim().split(/\s+/);
        const offset = Number(rawOffset ?? '0');

        return Promise.resolve(
          JSON.stringify({
            ok: true,
            contract: STATS_CONTRACT,
            batchId: 'pvp1-1-1',
            seq: 1,
            count: players.length,
            offset,
            limit: 2,
            players: players.slice(offset, offset + 2),
            records: [],
            events: [],
          }),
        );
      },
    };

    // Pedindo 5000 e recebendo 2, avançar 5000 pularia jogador.
    const batch = await collectStatsBatch(rcon, 5000);

    expect(batch.players).toHaveLength(5);
  });
});

// ------------------------------------------------------------
//  §4  O TEMPO ONLINE É DELTA
// ------------------------------------------------------------

describe('o tempo online', () => {
  /** Escreve `played_seconds` direto, como a presença faria. */
  function played(steamId: string, seconds: number): void {
    harness.db
      .prepare(
        `INSERT INTO players (steam_id, name, first_seen, last_seen, created_at, updated_at)
              VALUES (@steam_id, '', @now, @now, @now, @now)
         ON CONFLICT (steam_id) DO NOTHING`,
      )
      .run({ steam_id: steamId, now: NOW });

    harness.db
      .prepare(
        `INSERT INTO player_servers (server_id, steam_id, first_seen, last_seen, sessions, played_seconds)
              VALUES (@server_id, @steam_id, @now, @now, 1, @seconds)
         ON CONFLICT (server_id, steam_id) DO UPDATE SET played_seconds = @seconds`,
      )
      .run({ server_id: SERVER, steam_id: steamId, now: NOW, seconds });
  }

  it('a primeira rodada soma ZERO — ela só semeia a marca', async () => {
    played(FULANO, 3600);

    const plugin = new FakePlugin([]);
    const round = await collector(plugin).collect(SERVER, NOW);

    // Copiar o acumulado daria o total de sempre em toda temporada.
    expect(round.timePlayers).toBe(0);
    expect(valueOf(SERVER, FULANO, TIME_PLAYED_METRIC)).toBe(0);
  });

  it('a segunda rodada soma o DELTA', async () => {
    played(FULANO, 3600);

    const plugin = new FakePlugin([]);
    const collect = collector(plugin);

    await collect.collect(SERVER, NOW);

    played(FULANO, 3900);

    const round = await collect.collect(SERVER, NOW + 60_000);

    expect(round.timePlayers).toBe(1);
    expect(valueOf(SERVER, FULANO, TIME_PLAYED_METRIC)).toBe(300);
  });

  it('delta NEGATIVO soma zero e a marca é regravada no valor menor', async () => {
    played(FULANO, 3600);

    const plugin = new FakePlugin([]);
    const collect = collector(plugin);

    await collect.collect(SERVER, NOW);

    // A base foi recriada, ou o jogador foi removido e voltou.
    played(FULANO, 100);

    const dropped = await collect.collect(SERVER, NOW + 60_000);

    expect(dropped.timePlayers).toBe(0);
    expect(valueOf(SERVER, FULANO, TIME_PLAYED_METRIC)).toBe(0);

    // E a marca desceu junto: sem isso, o jogador ficaria sem
    // contar tempo até passar de novo dos 3600 segundos antigos.
    played(FULANO, 160);

    await collect.collect(SERVER, NOW + 120_000);

    expect(valueOf(SERVER, FULANO, TIME_PLAYED_METRIC)).toBe(60);
  });

  it('o replay de um lote NÃO adianta a marca — os segundos voltam na rodada seguinte', async () => {
    played(FULANO, 3600);

    const plugin = new FakePlugin([]);
    const collect = collector(plugin);

    await collect.collect(SERVER, NOW);

    // O `ack` se perde na rodada em que houve delta.
    played(FULANO, 3660);
    plugin.ackFails = 1;

    await collect.collect(SERVER, NOW + 60_000);

    expect(valueOf(SERVER, FULANO, TIME_PLAYED_METRIC)).toBe(60);

    // A rodada seguinte recebe o MESMO lote (applied: false). Se a
    // marca tivesse andado, estes 60 s seriam contados duas vezes;
    // como ela não andou, o valor continua o mesmo.
    const replay = await collect.collect(SERVER, NOW + 120_000);

    expect(replay.applied).toBe(false);
    expect(valueOf(SERVER, FULANO, TIME_PLAYED_METRIC)).toBe(60);
  });

  it('mergePlayers junta os segundos ao jogador que já veio no lote', () => {
    const merged = mergePlayers(
      [{ steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 10 } }],
      new Map([
        [FULANO, 60],
        [BELTRANO, 120],
      ]),
    );

    expect(merged).toHaveLength(2);
    expect(merged.find((player) => player.steamId === FULANO)?.metrics).toEqual({
      'ore.sulfur': 10,
      [TIME_PLAYED_METRIC]: 60,
    });
    expect(merged.find((player) => player.steamId === BELTRANO)?.metrics).toEqual({
      [TIME_PLAYED_METRIC]: 120,
    });
  });
});

// ------------------------------------------------------------
//  §5  O MUNDO NOVO
// ------------------------------------------------------------

describe('o wipe detectado pelo sweep', () => {
  const OLD_WORLD = 1_756_000_000_000;
  const NEW_WORLD = 1_757_500_000_000;

  it('o PRIMEIRO mundo visto é gravado, e as janelas NÃO viram', async () => {
    const plugin = new FakePlugin([]);
    const round = await collector(plugin, {
      worldAt: () => Promise.resolve(OLD_WORLD),
    }).collect(SERVER, NOW);

    // A linha existe — senão o histórico nasceria com um buraco.
    expect(harness.wipes.latest(SERVER)?.saveCreatedAt).toBe(OLD_WORLD);

    // Mas virar aqui fecharia, no primeiro sweep de cada
    // instalação, um período que tinha acabado de abrir.
    expect(round.wipeDetected).toBe(false);
    expect(round.rolled).toBe(0);
  });

  it('um mundo NOVO grava em `wipes` e vira a janela do wipe', async () => {
    const plugin = new FakePlugin([]);
    let world = OLD_WORLD;

    const collect = collector(plugin, { worldAt: () => Promise.resolve(world) });

    await collect.collect(SERVER, NOW);

    const before = harness.rankings.openPeriodOf(SERVER, 'wipe');

    // Alguém wipou À MÃO: nenhuma execução passou pelo agente.
    world = NEW_WORLD;

    const round = await collect.collect(SERVER, NOW + 60_000);

    expect(round.wipeDetected).toBe(true);
    expect(round.rolled).toBeGreaterThan(0);

    // A linha nova existe, e sem execução — é o §5.2 inteiro.
    const recorded = harness.wipes.latest(SERVER);

    expect(recorded?.saveCreatedAt).toBe(NEW_WORLD);
    expect(recorded?.wipeRunId).toBeNull();

    // E a janela virou, ancorada NAQUELE mundo.
    const after = harness.rankings.openPeriodOf(SERVER, 'wipe');

    expect(after?.id).not.toBe(before?.id);
    expect(after?.wipeId).toBe(recorded?.id);
  });

  it('vira UMA vez por mundo, mesmo com o `pos-wipe` chegando depois', async () => {
    const plugin = new FakePlugin([]);
    let world = OLD_WORLD;

    const collect = collector(plugin, { worldAt: () => Promise.resolve(world) });

    await collect.collect(SERVER, NOW);

    world = NEW_WORLD;

    await collect.collect(SERVER, NOW + 60_000);

    const turned = harness.rankings.openPeriodOf(SERVER, 'wipe');
    const wipeId = harness.wipes.latest(SERVER)?.id ?? null;

    // O passo `pos-wipe` da execução chega DEPOIS, olhando para o
    // mesmo mundo. Uma segunda virada congelaria um pódio vazio por
    // cima do que a primeira acabou de gravar.
    collect.rollOnWipe({ serverId: SERVER, wipeId, wipeRunId: null });

    expect(harness.rankings.openPeriodOf(SERVER, 'wipe')?.id).toBe(turned?.id);
  });

  it('a temporada vira junto quando `season_on_wipe` está ligado', async () => {
    harness.rankings.saveSettings(SERVER, { seasonMode: 'monthly', seasonOnWipe: true }, NOW);

    const plugin = new FakePlugin([]);
    let world = OLD_WORLD;

    const collect = collector(plugin, { worldAt: () => Promise.resolve(world) });

    await collect.collect(SERVER, NOW);

    const season = harness.rankings.openPeriodOf(SERVER, 'season');

    world = NEW_WORLD;

    await collect.collect(SERVER, NOW + 60_000);

    expect(harness.rankings.openPeriodOf(SERVER, 'season')?.id).not.toBe(season?.id);
  });

  it('não saber a hora do mundo não é "não mudou": a rodada segue sem decidir', async () => {
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 5 } },
    ]);

    const round = await collector(plugin, {
      worldAt: () => Promise.reject(new Error('RCON fora')),
    }).collect(SERVER, NOW);

    expect(round.wipeDetected).toBe(false);
    expect(harness.wipes.latest(SERVER)).toBeNull();
    // E o minério do minuto continuou sendo coletado.
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(5);
  });
});

// ------------------------------------------------------------
//  §5.1  A DECISÃO DAQUELA EXECUÇÃO
// ------------------------------------------------------------

describe('a caixa de três estados da execução de wipe', () => {
  /** Uma execução de wipe com a decisão pedida. */
  function runWith(openRankingSeason: boolean | null): number {
    const runs = new WipeRunsRepository(harness.db);

    const created = runs.create(
      SERVER,
      { kind: 'manual', bpPolicy: 'keep', openRankingSeason },
      NOW,
    );

    // A coluna atravessa a ida e a volta — é o que a F5 precisa
    // para desenhar a caixa com o estado certo.
    expect(runs.get(SERVER, created.id)?.openRankingSeason).toBe(openRankingSeason);

    return created.id;
  }

  it('`null` na execução deixa a configuração do servidor valer', () => {
    harness.rankings.saveSettings(SERVER, { seasonMode: 'monthly', seasonOnWipe: true }, NOW);
    harness.rankings.ensureOpenPeriods(SERVER, 'monthly', NOW);

    const season = harness.rankings.openPeriodOf(SERVER, 'season');
    const wipe = harness.wipes.record(SERVER, { saveCreatedAt: NOW }, NOW);

    collector(null).rollOnWipe({
      serverId: SERVER,
      wipeId: wipe.id,
      wipeRunId: runWith(null),
      now: NOW,
    });

    expect(harness.rankings.openPeriodOf(SERVER, 'season')?.id).not.toBe(season?.id);
  });

  it('`false` na execução VENCE a configuração que manda abrir', () => {
    harness.rankings.saveSettings(SERVER, { seasonMode: 'monthly', seasonOnWipe: true }, NOW);
    harness.rankings.ensureOpenPeriods(SERVER, 'monthly', NOW);

    const season = harness.rankings.openPeriodOf(SERVER, 'season');
    const wipe = harness.wipes.record(SERVER, { saveCreatedAt: NOW }, NOW);

    // "Não decidi" e "decidi que não" são respostas diferentes, e
    // é a segunda que está aqui.
    collector(null).rollOnWipe({
      serverId: SERVER,
      wipeId: wipe.id,
      wipeRunId: runWith(false),
      now: NOW,
    });

    expect(harness.rankings.openPeriodOf(SERVER, 'season')?.id).toBe(season?.id);

    // E a janela do wipe virou assim mesmo: quem zera com o mundo
    // não depende da decisão sobre a temporada.
    expect(harness.rankings.openPeriodOf(SERVER, 'wipe')?.wipeId).toBe(wipe.id);
  });

  it('`true` na execução abre temporada mesmo com a configuração desligada', () => {
    harness.rankings.saveSettings(SERVER, { seasonMode: 'monthly', seasonOnWipe: false }, NOW);
    harness.rankings.ensureOpenPeriods(SERVER, 'monthly', NOW);

    const season = harness.rankings.openPeriodOf(SERVER, 'season');
    const wipe = harness.wipes.record(SERVER, { saveCreatedAt: NOW }, NOW);

    collector(null).rollOnWipe({
      serverId: SERVER,
      wipeId: wipe.id,
      wipeRunId: runWith(true),
      now: NOW,
    });

    expect(harness.rankings.openPeriodOf(SERVER, 'season')?.id).not.toBe(season?.id);
  });
});

// ------------------------------------------------------------
//  §6  O SERVIDOR SEM PLUGIN
// ------------------------------------------------------------

describe('o servidor que não tem o plugin', () => {
  it('não vira erro, e a rodada segue para o próximo', async () => {
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 9 } },
    ]);

    const collect = new StatsCollector({
      repository: harness.rankings,
      wipes: harness.wipes,
      players: harness.players,
      servers: {
        ids: () => [OTHER, SERVER],
        rconOf: () => plugin.rcon(),
      },
      // O Oxide CONFIRMA que o `.cs` não está de pé no primeiro.
      pluginLoaded: (serverId) => serverId !== OTHER,
      worldAt: () => Promise.resolve(null),
    });

    await collect.sweep();

    expect(collect.statusOf(OTHER)).toBe('not-loaded');
    expect(collect.statusOf(SERVER)).toBe('ok');

    // "Sem dados" não é "zero": nada foi escrito para o servidor
    // sem plugin, e o outro coletou normalmente.
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(9);
    expect(plugin.sent.every((line) => !line.includes(OTHER))).toBe(true);
  });

  it('sem RCON a rodada é `no-answer`, e nada é gravado', async () => {
    const collect = collector(null);

    await collect.sweep();

    expect(collect.statusOf(SERVER)).toBe('no-answer');
    expect(harness.rankings.openPeriodOf(SERVER, 'wipe')).toBeNull();
  });

  it('"ainda não sei" NÃO é "não está carregado": a rodada tenta assim mesmo', async () => {
    const plugin = new FakePlugin([
      { steamId: FULANO, name: 'Fulano', metrics: { 'ore.sulfur': 4 } },
    ]);

    // O Oxide ainda não foi lido — é o primeiro minuto do boot.
    const round = await collector(plugin, { pluginLoaded: () => null }).collect(SERVER, NOW);

    expect(round.status).toBe('ok');
    expect(valueOf(SERVER, FULANO, 'ore.sulfur')).toBe(4);
  });
});

// ------------------------------------------------------------
//  §7  OS DOIS LADOS DO CONTRATO
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
  const start = source.indexOf('//  A COLETA DE ESTATISTICA  (origemz.stats.flush / ack)');

  expect(start).toBeGreaterThan(0);

  return source.slice(start);
}

describe('a coleta dentro do jogo', () => {
  it('os dois comandos estão declarados no OrigemZAgent.cs', async () => {
    const source = await readFile(PLUGIN_PATH, 'utf8');

    expect(source).toContain('private const string StatsFlushCommand = "origemz.stats.flush";');
    expect(source).toContain('private const string StatsAckCommand = "origemz.stats.ack";');
    expect(source).toContain('[ConsoleCommand(StatsFlushCommand)]');
    expect(source).toContain('[ConsoleCommand(StatsAckCommand)]');
  });

  it('a Fatia 1 escuta os três hooks de minério, e nenhum deles devolve valor', async () => {
    const tail = await pluginTail();

    // `void` é o único retorno seguro: um hook de coleta que
    // devolvesse não-null CANCELARIA a ação no jogo.
    expect(tail).toContain(
      'private void OnDispenserGather(ResourceDispenser dispenser, BaseEntity entity, Item item)',
    );
    expect(tail).toContain(
      'private void OnDispenserBonus(ResourceDispenser dispenser, BasePlayer player, Item item)',
    );
    expect(tail).toContain(
      'private void OnCollectiblePickup(CollectibleEntity collectible, BasePlayer player, bool eat)',
    );

    // Só minério: quarry e excavator ficam de fora por AUSÊNCIA —
    // os hooks deles não são declarados em lugar nenhum.
    expect(tail).toContain('ResourceDispenser.GatherType.Ore');
    expect(tail).not.toMatch(/private void OnQuarryGather/);
    expect(tail).not.toMatch(/private void OnExcavatorGather/);

    for (const shortname of ['sulfur.ore', 'metal.ore', 'stones', 'hq.metal.ore']) {
      expect(tail).toContain(`"${shortname}"`);
    }
  });

  it('o lote congela e só o `ack` descarta', async () => {
    const tail = await pluginTail();

    // O congelamento acontece no offset 0 e SÓ quando não há
    // pendente: é isso que devolve o mesmo lote depois de uma queda.
    expect(tail).toContain('if (offset == 0 && _statsPending == null)');
    expect(tail).toContain('_statsPending = FreezeStatsBuffer();');

    // E o único lugar em que o pendente volta a ser nulo é o ack.
    const discards = tail.match(/_statsPending = null;/g) ?? [];

    expect(discards).toHaveLength(1);
  });

  it('o pedaço novo é ASCII puro', async () => {
    const tail = await pluginTail();
    const foreign = [...tail].filter((char) => (char.codePointAt(0) ?? 0) > 127);

    // O compilador do Oxide lê o arquivo com a codificação da
    // máquina: um travessão vira lixo no log de quem administra o
    // servidor, e um acento dentro de string vira pergunta no chat.
    expect(foreign).toEqual([]);
  });

  it('não usa sintaxe acima de C# 6', async () => {
    const tail = await pluginTail();

    expect(tail).not.toMatch(/\bout var\b/);
    expect(tail).not.toMatch(/\bis \w+ [a-z]\w*\s*\)/);
    expect(tail).not.toMatch(/=>\s*$/m);
    expect(tail).not.toMatch(/\$"/);
    expect(tail).not.toMatch(/\?\./);
  });

  it('o agente e o plugin usam os MESMOS nomes de comando e o mesmo contrato', async () => {
    const source = await readFile(PLUGIN_PATH, 'utf8');
    const agente = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'game', 'stats-contract.ts'),
      'utf8',
    );

    for (const command of [STATS_COMMANDS.flush, STATS_COMMANDS.ack]) {
      expect(source).toContain(command);
      expect(agente).toContain(command);
    }

    // A versão do contrato é duplicada de propósito, e as duas
    // pontas mudam JUNTAS.
    expect(source).toContain(
      `private const int StatsContractVersion = ${String(STATS_CONTRACT)};`,
    );
  });

  it('os limites do agente são os mesmos do plugin', async () => {
    const source = await readFile(PLUGIN_PATH, 'utf8');
    const { STATS_FLUSH_DEFAULT_LIMIT, STATS_FLUSH_MAX_LIMIT, STATS_FLUSH_MAX_BYTES } =
      await import('../src/game/stats-contract.js');

    expect(source).toContain(
      `private const int DefaultStatsLimit = ${String(STATS_FLUSH_DEFAULT_LIMIT)};`,
    );
    expect(source).toContain(`private const int MaxStatsLimit = ${String(STATS_FLUSH_MAX_LIMIT)};`);
    expect(source).toContain(
      `private const int MaxStatsFlushBytes = ${String(STATS_FLUSH_MAX_BYTES)};`,
    );
  });
});
