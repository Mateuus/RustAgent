// ============================================================
//  rankings-pvp.test.ts  -  o que a coleta de PvP, tiro longo e
//  explosivo promete, e ninguém confere olhando.
//
//  ####  ESTE ARQUIVO TEM DUAS METADES, E ELAS PROVAM COISAS
//        DIFERENTES  ####
//
//  A decisão de "esta morte é um abate de quem?" mora no `.cs`, e
//  nenhum teste em TypeScript executa C#. Então:
//
//    METADE 1 — o AGENTE. Cada uma das nove situações do §6.2
//      chega como o plugin a mandaria, e o teste confere o
//      contador que ficou no banco. É o que prova que a matriz
//      atravessa inteira: da linha do lote até `player_stats`.
//
//    METADE 2 — o PLUGIN. O `.cs` é lido como texto e o teste
//      confere que cada linha da matriz existe lá, com o contador
//      certo e na ORDEM certa. Não é elegante, e é a única defesa
//      contra a divergência que ninguém veria: um dia alguém troca
//      `sleeper.kills` por `pvp.kills` no plugin e a metade 1
//      continua verde, porque ela testa o agente.
//
//  ------------------------------------------------------------
//  ####  O QUE ESTÁ GUARDADO AQUI  ####
//
//    1. as NOVE situações do §6.2, cada uma com o seu contador —
//       é o critério de pronto que a pesquisa nomeia;
//    2. `pvp.kd` NÃO tem linha em `player_stats`: ele é `computed`
//       e sai da divisão na leitura. Uma linha gravada ali seria
//       uma segunda verdade sobre um número que ainda vai mudar;
//    3. o recorde entra em `player_records` com o testemunho
//       inteiro — arma, munição, headshot, vítima, grid, as duas
//       posições e o `ratio`. Um fato sem testemunho não se
//       defende quando alguém contesta;
//    4. o tiro de `ratio` baixo (o teleporte do §7.2) entra como
//       `suspect`, é GRAVADO e NÃO aparece no pódio — apagar
//       perderia o rastro da fraude;
//    5. o MESMO recorde pelo push e pelo lote grava UMA linha. Os
//       dois caminhos existem de propósito (§7.1), e sem esta
//       promessa o pódio teria a mesma proeza duas vezes;
//    6. craft de item COMPRADO não soma SEQ — contamos craft, e
//       não posse (§5.4).
//
//  Banco em memória, migrações reais: é o que permite provar que
//  o recorde repetido não vira segunda linha, que é justamente a
//  promessa que um mock não teria.
// ============================================================

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { RankingsRepository } from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { buildStatsFlushCommand, STATS_COMMANDS } from '../src/game/stats-contract.js';
import type { Logger } from '../src/logger.js';
import { EVENT_MARKER, StatEventsConsumer } from '../src/rankings/stat-events.js';

const SERVER = 'pvp1';

/** O atirador, a vítima e o dono da turret. */
const CACADOR = '76561198000000001';
const PRESA = '76561198000000002';
const DONO = '76561198000000003';

const NOW = 1_757_000_000_000;
/** O mesmo instante, em segundos — é o relógio do servidor de jogo. */
const AT = Math.floor(NOW / 1000);

/** O segredo desta "subida do agente". Ver o `#authentic`. */
const SECRET = 'f8f8f8f8-1111-4222-8333-444455556666';

interface Harness {
  readonly db: AgentDatabase;
  readonly rankings: RankingsRepository;
  readonly logger: Logger;
}

let harness: Harness;

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'PVP1',
    identity: SERVER,
    enabled: true,
    gamePort: 28015,
    rconPort: 28016,
    queryPort: 28017,
    appPort: 28082,
    rconHost: '127.0.0.1',
    installDir: `Servers/${SERVER}`,
  });

  harness = {
    db,
    rankings: new RankingsRepository(db),
    logger: pino({ level: 'silent' }),
  };
});

// ------------------------------------------------------------
//  Atalhos
// ------------------------------------------------------------

interface BatchPlayer {
  readonly steamId: string;
  readonly name?: string | null;
  readonly metrics: Readonly<Record<string, number>>;
}

interface BatchRecord {
  readonly steamId: string;
  readonly name?: string | null;
  readonly metric: string;
  readonly value: number;
  readonly at: number;
  readonly status?: 'ok' | 'suspect';
  readonly detail?: unknown;
}

/** Um lote, como o `origemz.stats.flush` o entregaria. */
function applyBatch(
  players: readonly BatchPlayer[],
  records: readonly BatchRecord[] = [],
  batchId = 'pvp1-1757088123-41',
): void {
  harness.rankings.applyBatch(
    { serverId: SERVER, batchId, seq: 41, players, records },
    NOW,
  );
}

/** Quanto o jogador tem da métrica na janela `season`. */
function seasonValue(metric: string, steamId: string): number {
  const period = harness.rankings.openPeriodOf(SERVER, 'season');

  if (period === null) {
    return 0;
  }

  return (
    harness.rankings
      .topOf({ periodId: period.id, metric, limit: 20, offset: 0 })
      .entries.find((entry) => entry.steamId === steamId)?.value ?? 0
  );
}

/** O pódio do tiro longo na janela `wipe` — só o que é `ok`. */
function shotPodium(): readonly { steamId: string; value: number; detail: unknown }[] {
  const period = harness.rankings.openPeriodOf(SERVER, 'wipe');

  if (period === null) {
    return [];
  }

  return harness.rankings.topRecordsOf({
    periodId: period.id,
    metric: 'shot.distance',
    limit: 20,
    offset: 0,
  }).entries;
}

/**
 * As linhas cruas de `player_records`, `suspect` inclusive.
 *
 * ####  DE UMA JANELA SÓ, E ISSO É O PONTO  ####
 *
 * O `applyBatch` grava em TODAS as janelas abertas do servidor —
 * `wipe`, `season` e `lifetime` —, então o mesmo tiro produz três
 * linhas. Contar as três misturaria "o recorde entrou duas vezes"
 * com "o recorde entrou nas três janelas", que são coisas
 * diferentes e só uma delas é defeito.
 *
 * `wipe` porque é a janela que o catálogo semeia para o
 * `tiro-longo`: o recorde é uma história com lugar, e carregá-lo
 * para o mapa seguinte tira dele o que o torna interessante.
 */
function storedRecords(): { steam_id: string; value: number; status: string; detail: string }[] {
  const period = harness.rankings.openPeriodOf(SERVER, 'wipe');

  return harness.db
    .prepare(
      `SELECT steam_id, value, status, detail
         FROM player_records
        WHERE period_id = ?
        ORDER BY id`,
    )
    .all(period?.id ?? 0) as {
    steam_id: string;
    value: number;
    status: string;
    detail: string;
  }[];
}

/**
 * As métricas que sobraram em `player_stats`, na janela `season`.
 *
 * A mesma razão do `storedRecords`: sem o recorte por janela, um
 * abate apareceria como 3 — um por janela aberta.
 */
function storedMetrics(): { steam_id: string; metric: string; value: number }[] {
  const period = harness.rankings.openPeriodOf(SERVER, 'season');

  return harness.db
    .prepare(
      `SELECT steam_id, metric, value
         FROM player_stats
        WHERE period_id = ?
        ORDER BY steam_id, metric`,
    )
    .all(period?.id ?? 0) as { steam_id: string; metric: string; value: number }[];
}

/** O testemunho do §7.4, como o plugin o monta. */
function witness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    weapon: 'rifle.bolt',
    ammo: 'ammo.rifle',
    category: 'bolt',
    headshot: true,
    victim: PRESA,
    victimName: 'Presa',
    grid: 'G12',
    from: { x: -120.5, y: 32.1, z: 480.9 },
    to: { x: 180.2, y: 30.4, z: 200.7 },
    projectile: 415.1,
    ratio: 1.006,
    ...overrides,
  };
}

// ============================================================
//  METADE 1 — O AGENTE
// ============================================================

// ------------------------------------------------------------
//  §6.2  AS NOVE SITUAÇÕES
// ------------------------------------------------------------

describe('a matriz de atribuição da morte, situação por situação', () => {
  it('1. vítima é NPC: o atacante ganha `pve.kills`, e a vítima não existe', () => {
    // O plugin nem cria linha para um NPC: o `userID` dele não é
    // SteamID64, e gravá-lo encheria a base de gente que nunca vai
    // abrir a tela.
    applyBatch([{ steamId: CACADOR, name: 'Cacador', metrics: { 'pve.kills': 1 } }]);

    expect(seasonValue('pve.kills', CACADOR)).toBe(1);
    expect(seasonValue('pvp.kills', CACADOR)).toBe(0);
    expect(storedMetrics()).toEqual([{ steam_id: CACADOR, metric: 'pve.kills', value: 1 }]);
  });

  it('2. suicídio: conta `suicides` e NADA no K/D', () => {
    applyBatch([{ steamId: PRESA, name: 'Presa', metrics: { suicides: 1 } }]);

    expect(seasonValue('suicides', PRESA)).toBe(1);
    expect(seasonValue('pvp.deaths', PRESA)).toBe(0);
    expect(seasonValue('pvp.kills', PRESA)).toBe(0);
  });

  it('3. armadilha: o abate é do DONO, e a vítima leva `trap.deaths`', () => {
    // O par existe para o K/D continuar ancorado em 1,0 (§6.3):
    // uma morte de PvP sem o abate do outro lado puxaria a média da
    // população para baixo e desregularia o encolhimento de todos.
    applyBatch([
      { steamId: DONO, name: 'Dono', metrics: { 'trap.kills': 1 } },
      { steamId: PRESA, name: 'Presa', metrics: { 'trap.deaths': 1 } },
    ]);

    expect(seasonValue('trap.kills', DONO)).toBe(1);
    expect(seasonValue('trap.deaths', PRESA)).toBe(1);
    expect(seasonValue('pvp.kills', DONO)).toBe(0);
    expect(seasonValue('pvp.deaths', PRESA)).toBe(0);
  });

  it('4. NPC matou: `pve.deaths`, e não `env.deaths`', () => {
    applyBatch([{ steamId: PRESA, name: 'Presa', metrics: { 'pve.deaths': 1 } }]);

    expect(seasonValue('pve.deaths', PRESA)).toBe(1);
    expect(seasonValue('env.deaths', PRESA)).toBe(0);
    expect(seasonValue('pvp.deaths', PRESA)).toBe(0);
  });

  it('5. ambiente: queda, fome e afogamento caem em `env.deaths`', () => {
    // Três mortes ambientais no mesmo lote chegam SOMADAS: o lote é
    // delta, e o plugin já agregou o minuto inteiro.
    applyBatch([{ steamId: PRESA, name: 'Presa', metrics: { 'env.deaths': 3 } }]);

    expect(seasonValue('env.deaths', PRESA)).toBe(3);
    expect(seasonValue('pvp.deaths', PRESA)).toBe(0);
  });

  it('6. team kill: fora do K/D dos DOIS lados', () => {
    applyBatch([
      { steamId: CACADOR, name: 'Cacador', metrics: { 'team.kills': 1 } },
      { steamId: PRESA, name: 'Presa', metrics: { 'team.deaths': 1 } },
    ]);

    expect(seasonValue('team.kills', CACADOR)).toBe(1);
    expect(seasonValue('team.deaths', PRESA)).toBe(1);
    expect(seasonValue('pvp.kills', CACADOR)).toBe(0);
    expect(seasonValue('pvp.deaths', PRESA)).toBe(0);
  });

  it('7. sleeper: fora do K/D, para não premiar quem anda de machado por base vazia', () => {
    applyBatch([
      { steamId: CACADOR, name: 'Cacador', metrics: { 'sleeper.kills': 1 } },
      { steamId: PRESA, name: 'Presa', metrics: { 'sleeper.deaths': 1 } },
    ]);

    expect(seasonValue('sleeper.kills', CACADOR)).toBe(1);
    expect(seasonValue('sleeper.deaths', PRESA)).toBe(1);
    expect(seasonValue('pvp.kills', CACADOR)).toBe(0);
  });

  it('8. PvP limpo: `pvp.kills` de um lado e `pvp.deaths` do outro', () => {
    applyBatch([
      { steamId: CACADOR, name: 'Cacador', metrics: { 'pvp.kills': 1 } },
      { steamId: PRESA, name: 'Presa', metrics: { 'pvp.deaths': 1 } },
    ]);

    expect(seasonValue('pvp.kills', CACADOR)).toBe(1);
    expect(seasonValue('pvp.deaths', PRESA)).toBe(1);
  });

  it('9. wounded -> morte: vale o ÚLTIMO atacante, e ele conta como PvP limpo', () => {
    // Quem resolve isso é o `HitInfo` que o jogo entrega ao hook: a
    // morte que vem depois do `OnPlayerWound` carrega o último
    // atacante, e a linha 8 da matriz a atende sem código próprio.
    // O que chega ao agente é indistinguível de um PvP limpo — e é
    // exatamente isso que esta linha guarda.
    applyBatch([
      { steamId: CACADOR, name: 'Cacador', metrics: { 'pvp.kills': 1 } },
      { steamId: PRESA, name: 'Presa', metrics: { 'pvp.deaths': 1 } },
    ]);

    expect(storedMetrics()).toEqual([
      { steam_id: CACADOR, metric: 'pvp.kills', value: 1 },
      { steam_id: PRESA, metric: 'pvp.deaths', value: 1 },
    ]);
  });

  it('o K/D NÃO vira linha: ele é `computed` e sai da divisão na leitura', () => {
    applyBatch([
      { steamId: CACADOR, name: 'Cacador', metrics: { 'pvp.kills': 4 } },
      { steamId: PRESA, name: 'Presa', metrics: { 'pvp.deaths': 2 } },
    ]);

    const kd = harness.db
      .prepare(`SELECT count(*) AS total FROM player_stats WHERE metric = 'pvp.kd'`)
      .get() as { total: number };

    expect(kd.total).toBe(0);

    // E o catálogo semeado continua declarando quem ele é.
    expect(harness.rankings.getByMetric('pvp.kd')?.source).toBe('computed');
  });
});

// ------------------------------------------------------------
//  §7  O TIRO MAIS LONGO
// ------------------------------------------------------------

describe('o tiro mais longo', () => {
  it('entra em `player_records` com o testemunho inteiro', () => {
    applyBatch(
      [],
      [
        {
          steamId: CACADOR,
          name: 'Cacador',
          metric: 'shot.distance',
          value: 412.73,
          at: AT,
          status: 'ok',
          detail: witness(),
        },
      ],
    );

    const podium = shotPodium();

    expect(podium).toHaveLength(1);
    expect(podium[0]?.steamId).toBe(CACADOR);
    expect(podium[0]?.value).toBeCloseTo(412.73, 2);

    // §7.4: um fato sem testemunho não se defende quando alguém
    // contesta. Os campos são conferidos um a um de propósito —
    // perder UM deles não quebraria nada visivelmente, e o recorde
    // ficaria indefensável só no dia da reclamação.
    const detail = podium[0]?.detail as Record<string, unknown>;

    expect(detail['weapon']).toBe('rifle.bolt');
    expect(detail['ammo']).toBe('ammo.rifle');
    expect(detail['headshot']).toBe(true);
    expect(detail['victim']).toBe(PRESA);
    expect(detail['grid']).toBe('G12');
    expect(detail['from']).toEqual({ x: -120.5, y: 32.1, z: 480.9 });
    expect(detail['to']).toEqual({ x: 180.2, y: 30.4, z: 200.7 });
    expect(detail['ratio']).toBeCloseTo(1.006, 3);
    expect(detail['projectile']).toBeCloseTo(415.1, 1);
  });

  it('NÃO é contador: `shot.distance` não aparece em `player_stats`', () => {
    applyBatch(
      [],
      [
        {
          steamId: CACADOR,
          metric: 'shot.distance',
          value: 412.73,
          at: AT,
          detail: witness(),
        },
      ],
    );

    expect(storedMetrics()).toEqual([]);
    expect(seasonValue('shot.distance', CACADOR)).toBe(0);
  });

  it('o tiro depois de um teleporte entra como `suspect` e NÃO sobe ao pódio', () => {
    // §7.2: `ratio` bem abaixo de 1 quer dizer que os dois pontos
    // não estavam separados no instante do disparo — teleporte,
    // `HitInfo` reconstruído, plugin de terceiro. Quem decide isso é
    // o plugin, que é o único lado com as duas medidas na mão.
    applyBatch(
      [],
      [
        {
          steamId: CACADOR,
          name: 'Cacador',
          metric: 'shot.distance',
          value: 940.5,
          at: AT,
          status: 'suspect',
          detail: witness({ projectile: 12.4, ratio: 0.013, reason: 'teleporte' }),
        },
      ],
    );

    // GRAVADO: apagar seria perder o rastro da fraude (§2.3).
    const rows = storedRecords();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('suspect');
    expect(JSON.parse(rows[0]?.detail ?? '{}')['reason']).toBe('teleporte');

    // E FORA do pódio.
    expect(shotPodium()).toEqual([]);
  });

  it('o suspeito não esconde o recorde legítimo que veio no mesmo lote', () => {
    // O plugin guarda o melhor por (métrica, status) justamente por
    // isto: um tiro suspeito de 940 m e um legítimo de 412 m são
    // dois fatos, e o pódio é do segundo.
    applyBatch(
      [],
      [
        {
          steamId: CACADOR,
          metric: 'shot.distance',
          value: 940.5,
          at: AT,
          status: 'suspect',
          detail: witness({ ratio: 0.013, reason: 'teleporte' }),
        },
        {
          steamId: CACADOR,
          metric: 'shot.distance',
          value: 412.73,
          at: AT,
          status: 'ok',
          detail: witness(),
        },
      ],
    );

    const podium = shotPodium();

    expect(podium).toHaveLength(1);
    expect(podium[0]?.value).toBeCloseTo(412.73, 2);
    expect(storedRecords()).toHaveLength(2);
  });

  it('o MESMO recorde pelo push e pelo lote grava UMA linha', async () => {
    // Os dois caminhos existem de propósito (§7.1): o push dá o
    // "agora" e o lote dá o "garantido". Sem esta promessa, o pódio
    // teria a mesma proeza duas vezes — uma por caminho.
    const consumer = new StatEventsConsumer({
      repository: harness.rankings,
      servers: { ids: () => [SERVER], contextOf: () => null },
      logger: harness.logger,
      secret: SECRET,
      ackMs: 5,
    });

    const push = {
      contract: 1,
      kind: 'record',
      eventId: `${CACADOR}-${String(AT)}-1`,
      steamId: CACADOR,
      name: 'Cacador',
      metric: 'shot.distance',
      value: 412.73,
      status: 'ok',
      at: AT,
      detail: witness(),
      secret: SECRET,
    };

    consumer.handleLine(SERVER, `[OrigemZAgent] ${EVENT_MARKER}${JSON.stringify(push)}`);

    expect(storedRecords()).toHaveLength(1);

    // O mesmo tiro, agora no lote de 60 s.
    applyBatch(
      [],
      [
        {
          steamId: CACADOR,
          name: 'Cacador',
          metric: 'shot.distance',
          value: 412.73,
          at: AT,
          status: 'ok',
          detail: witness(),
        },
      ],
    );

    // Quem desempata é a comparação com o melhor do período: o lote
    // traz um valor que não SUPERA o que já está lá, e ele não vira
    // linha nova.
    expect(storedRecords()).toHaveLength(1);
    expect(shotPodium()).toHaveLength(1);

    // Deixa o `ack` adiado terminar antes do fim do teste.
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it('o MESMO tiro SUSPEITO pelos dois caminhos também grava UMA linha', () => {
    // ####  A COMPARAÇÃO É DENTRO DO MESMO `status`  ####
    //
    // Comparar o suspeito contra o melhor `ok` não o barraria nunca
    // — não há `ok` que o cubra —, e o mesmo tiro forjado chegando
    // pelo push e pelo lote viraria duas linhas. O rastro da fraude
    // vira log de repetição, que é o oposto do que ele serve.
    const suspect: BatchRecord = {
      steamId: CACADOR,
      metric: 'shot.distance',
      value: 940.5,
      at: AT,
      status: 'suspect',
      detail: witness({ ratio: 0.013, reason: 'teleporte' }),
    };

    applyBatch([], [suspect], 'lote-1');
    applyBatch([], [suspect], 'lote-2');

    expect(storedRecords()).toHaveLength(1);
    expect(storedRecords()[0]?.status).toBe('suspect');
  });

  it('um recorde MELHOR no lote seguinte vira linha nova', () => {
    applyBatch(
      [],
      [{ steamId: CACADOR, metric: 'shot.distance', value: 412.73, at: AT, detail: witness() }],
      'lote-1',
    );

    applyBatch(
      [],
      [{ steamId: CACADOR, metric: 'shot.distance', value: 501.2, at: AT, detail: witness() }],
      'lote-2',
    );

    expect(storedRecords()).toHaveLength(2);

    // E o pódio mostra o melhor, e não os dois.
    const podium = shotPodium();

    expect(podium).toHaveLength(1);
    expect(podium[0]?.value).toBeCloseTo(501.2, 2);
  });

  it('o recorde NÃO gera `origemz.item.ack`: ele fala com o plugin errado', async () => {
    // O `points` vem do `OrigemZItems`, que segura a conversão numa
    // fila em disco até alguém confirmar. O `record` vem do
    // `OrigemZAgent`, e lá não há fila: quem descarta o recorde é o
    // `origemz.stats.ack` do lote. Confirmar aqui mandaria um
    // comando de RCON por recorde a um plugin que nunca viu aquele
    // id.
    const sent: string[] = [];
    const rcon = {
      isConnected: true,
      send: (command: string) => {
        sent.push(command);

        return Promise.resolve('{"ok":true,"pending":0}');
      },
    };

    const consumer = new StatEventsConsumer({
      repository: harness.rankings,
      servers: { ids: () => [SERVER], contextOf: () => ({ rcon }) },
      logger: harness.logger,
      secret: SECRET,
      ackMs: 5,
    });

    const push = {
      contract: 1,
      kind: 'record',
      eventId: `${CACADOR}-${String(AT)}-1`,
      steamId: CACADOR,
      metric: 'shot.distance',
      value: 412.73,
      at: AT,
      detail: witness(),
      secret: SECRET,
    };

    expect(consumer.handleLine(SERVER, `${EVENT_MARKER}${JSON.stringify(push)}`)).toBe('applied');

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sent.filter((command) => command.startsWith('origemz.item.ack'))).toEqual([]);
    expect(storedRecords()).toHaveLength(1);
  });

  it('a linha de recorde sem o segredo é descartada em silêncio', () => {
    // Quem digitasse `#OZSTAT#{…}` no chat estaria mandando um
    // recorde direto ao agente — num ranking cujo primeiro lugar
    // ganha prêmio real.
    const consumer = new StatEventsConsumer({
      repository: harness.rankings,
      servers: { ids: () => [SERVER], contextOf: () => null },
      logger: harness.logger,
      secret: SECRET,
    });

    const forged = {
      contract: 1,
      kind: 'record',
      eventId: `${PRESA}-${String(AT)}-9`,
      steamId: PRESA,
      metric: 'shot.distance',
      value: 9999,
      at: AT,
    };

    consumer.handleLine(SERVER, `${EVENT_MARKER}${JSON.stringify(forged)}`);

    expect(storedRecords()).toEqual([]);
  });
});

// ------------------------------------------------------------
//  §5  O EXPLOSIVO
// ------------------------------------------------------------

describe('o poder de raid, em enxofre equivalente', () => {
  it('o craft soma `explosive.seq` na janela do wipe', () => {
    applyBatch([{ steamId: CACADOR, name: 'Cacador', metrics: { 'explosive.seq': 2200 } }]);

    const wipe = harness.rankings.openPeriodOf(SERVER, 'wipe');

    expect(wipe).not.toBeNull();

    const top = harness.rankings.topOf({
      periodId: wipe?.id ?? 0,
      metric: 'explosive.seq',
      limit: 5,
      offset: 0,
    });

    expect(top.entries[0]?.steamId).toBe(CACADOR);
    expect(top.entries[0]?.value).toBe(2200);
  });

  it('item comprado NÃO soma: o lote de quem só recebeu vem sem a métrica', () => {
    // §5.4(1): loja, kit, VIP, `give` do painel e drop de heli não
    // passam pela bancada, e o `OnItemCraftFinished` é o único
    // caminho que alimenta esta métrica. Do lado do agente, "não
    // craftou" é a AUSÊNCIA da métrica no lote — e é isso que esta
    // linha guarda: um lote sem ela não inventa zero nem linha.
    applyBatch([{ steamId: CACADOR, name: 'Cacador', metrics: { 'ore.sulfur': 1200 } }]);

    expect(seasonValue('explosive.seq', CACADOR)).toBe(0);
    expect(storedMetrics()).toEqual([
      { steam_id: CACADOR, metric: 'ore.sulfur', value: 1200 },
    ]);
  });
});

// ============================================================
//  METADE 2 — O PLUGIN
// ============================================================

const PLUGIN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'Plugins',
  'OrigemZAgent.cs',
);

/**
 * Os nomes de `JsonProperty` de uma classe do `.cs`, na ordem.
 *
 * O corpo vai da declaração da classe até a declaração seguinte —
 * as classes desta seção são irmãs e vizinhas, e nenhuma delas tem
 * classe aninhada dentro.
 */
function jsonPropertiesOf(source: string, className: string): string[] {
  const at = source.indexOf(`private class ${className}`);

  expect(at, `a classe ${className} sumiu do plugin`).toBeGreaterThan(0);

  const next = source.indexOf('private class ', at + 15);
  const body = source.slice(at, next < 0 ? source.length : next);

  return [...body.matchAll(/\[JsonProperty\("([^"]+)"\)\]/g)].map((match) => match[1] ?? '');
}

/** O trecho do `.cs` que é da coleta. */
async function pluginTail(): Promise<string> {
  const source = await readFile(PLUGIN_PATH, 'utf8');
  const start = source.indexOf('//  A COLETA DE ESTATISTICA  (origemz.stats.flush / ack)');

  expect(start).toBeGreaterThan(0);

  return source.slice(start);
}

describe('a coleta de PvP dentro do jogo', () => {
  it('o `OnPlayerDeath` é `void` — retorno não-nulo CANCELA a morte', async () => {
    const tail = await pluginTail();

    // MEDIDO com Mono.Cecil no `Assembly-CSharp.dll` deste servidor:
    // `BasePlayer::Die` faz `CallHook("OnPlayerDeath", this, info)` e
    // RETORNA sem chamar `BaseCombatEntity::Die` quando o retorno não
    // é nulo. O jogador ficaria vivo com vida zero.
    expect(tail).toContain('private void OnPlayerDeath(BasePlayer player, HitInfo info)');
    expect(tail).not.toMatch(/private object OnPlayerDeath/);
    expect(tail).not.toMatch(/private bool OnPlayerDeath/);
  });

  it('o `OnItemCraftFinished` tem os TRÊS parâmetros que o jogo passa', async () => {
    const tail = await pluginTail();

    // MEDIDO no mesmo assembly: `ItemCrafter::FinishCrafting` empilha
    // `task`, `item` e `this` antes do `CallHook`. Declarar dois
    // faria o Oxide não casar o hook, e a coleta ficaria muda sem
    // nenhum erro no log.
    expect(tail).toContain(
      'private void OnItemCraftFinished(ItemCraftTask task, Item item, ItemCrafter crafter)',
    );
  });

  it('as nove linhas da matriz estão no plugin, na ordem em que são testadas', async () => {
    const tail = await pluginTail();

    // A ORDEM importa: uma morte se encaixa em mais de uma linha com
    // frequência (o companheiro de time dormindo é team kill E
    // sleeper), e a primeira que casa vence. Trocar duas trocaria o
    // contador sem quebrar nada visivelmente.
    const order = [
      'LINHA 1: A VITIMA E NPC',
      'LINHA 2: SUICIDIO',
      'LINHA 3: ARMADILHA',
      'LINHA 4: NPC, HELI OU BRADLEY MATOU',
      'LINHA 5: AMBIENTE',
      'LINHA 6: TEAM KILL',
      'LINHA 7: SLEEPER',
      'LINHA 8: PVP LIMPO',
      'LINHA 9: E SO AQUI O TIRO LONGO PODE VALER',
    ];

    let cursor = -1;

    for (const marker of order) {
      const at = tail.indexOf(marker);

      expect(at, `a marca "${marker}" sumiu do plugin`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('cada situação tem a sua métrica declarada, e o K/D não tem nenhuma', async () => {
    const tail = await pluginTail();

    const metrics = [
      'pvp.kills',
      'pvp.deaths',
      'pve.kills',
      'pve.deaths',
      'env.deaths',
      'suicides',
      'team.kills',
      'team.deaths',
      'sleeper.kills',
      'sleeper.deaths',
      'trap.kills',
      'trap.deaths',
      'shot.distance',
      'explosive.seq',
    ];

    for (const metric of metrics) {
      expect(tail, `a métrica ${metric} sumiu do plugin`).toContain(`"${metric}"`);
    }

    // `pvp.kd` é `computed`: o plugin NÃO o manda, e uma linha dele
    // em `player_stats` seria uma segunda verdade sobre uma divisão
    // de dois números que ainda vão mudar.
    expect(tail).not.toContain('"pvp.kd"');
  });

  it('o NPC é a primeira pergunta, e o time não é comparado com zero', async () => {
    const tail = await pluginTail();

    // `IsNpc` antes de tudo: o `userID` de um NPC não é SteamID64, e
    // o `ScientistNPC` herda de `BasePlayer`.
    expect(tail).toContain('if (victim.IsNpc)');
    expect(tail).toContain('attacker == null || attacker.IsNpc');

    // `currentTeam == 0` é "sem time". Comparar 0 com 0 daria team
    // kill em todo PvP de servidor com times desligados.
    expect(tail).toContain('attacker.currentTeam != 0UL && attacker.currentTeam == victim.currentTeam');
  });

  it('o tiro longo mede as DUAS distâncias, e o `ratio` é quem valida', async () => {
    const tail = await pluginTail();

    // A linha reta ranqueia — é a que o jogador entende e a que
    // qualquer print do jogo confirma.
    expect(tail).toContain('float shot = Vector3.Distance(from, to);');
    // O caminho do projétil fica como prova.
    expect(tail).toContain('float projectile = info.ProjectileDistance;');
    expect(tail).toContain('projectile / shot');

    // As razões de suspeita do §7.2 e §7.3 — e cada uma tem nome
    // próprio de propósito: "o pódio está vazio" com o motivo
    // escrito na linha é diagnóstico; sem ele é caça de duas horas.
    for (const reason of [
      '"teto"',
      '"ricochete"',
      '"teleporte"',
      '"admin"',
      '"sem-projetil"',
    ]) {
      expect(tail).toContain(reason);
    }

    // Piso e teto do §7.3(5) e (6).
    expect(tail).toContain('private const float MinShotDistance = 25f;');
    expect(tail).toContain('private const float MaxShotDistance = 1000f;');

    // Explosivo, fogo e melee não fazem tiro longo.
    expect(tail).toContain('BaseProjectile weapon = info.Weapon as BaseProjectile;');
    expect(tail).toContain('info.IsProjectile()');

    // E o testemunho do §7.4 vai inteiro.
    for (const field of [
      '"weapon"',
      '"ammo"',
      '"headshot"',
      '"victim"',
      '"grid"',
      '"from"',
      '"to"',
      '"ratio"',
      '"projectile"',
    ]) {
      expect(tail).toContain(`detail[${field}]`);
    }
  });

  it('o recorde suspeito é MARCADO, e nunca descartado', async () => {
    const tail = await pluginTail();

    expect(tail).toContain('private const string RecordStatusSuspect = "suspect";');

    // E o plugin não anula nada: `void` é decisão de admin no
    // painel, e uma linha de console que pudesse anular recorde
    // tiraria essa decisão de quem deve tomá-la.
    expect(tail).not.toContain('"void"');
  });

  it('o SEQ é derivado do blueprint DAQUELE servidor, e não de uma tabela nossa', async () => {
    const tail = await pluginTail();

    // A recursão do §5.3, com o enxofre como folha.
    expect(tail).toContain('private const string SulfurShortname = "sulfur";');
    expect(tail).toContain('blueprint.GetIngredients()');
    expect(tail).toContain('ComputeSeqPerUnit(ingredient.itemDef, visiting, depth + 1)');
    expect(tail).toContain('blueprint.amountToCreate');

    // Nenhuma constante de custo nossa: nem 300, nem 480, nem 1400,
    // nem 2200 — os números que as calculadoras públicas divergem
    // entre si.
    expect(tail).not.toMatch(/=\s*(300|480|1400|2200)\s*[;,)]/);

    // Craft cancelado devolve os ingredientes, e o que voltou para a
    // caixa não foi produzido.
    expect(tail).toContain('if (task.cancelled)');

    // E o cache é montado FORA do hook.
    expect(tail).toContain('private void BuildSeqCache()');
  });

  it('não há hook de posse: só o que passou pela bancada conta', async () => {
    const tail = await pluginTail();

    // §5.4(1): loja, kit, VIP e `give` do painel entregam item sem
    // craft. A exclusão é por AUSÊNCIA — nenhum destes hooks existe
    // aqui, e é isso que impede o ranking de "farm" de premiar quem
    // comprou.
    for (const hook of [
      'OnItemAddedToContainer',
      'OnItemCraft(',
      'CanAcceptItem',
      'OnItemPickup',
    ]) {
      expect(tail, `o plugin passou a escutar ${hook}`).not.toContain(hook);
    }
  });

  it('todo hook de coleta é medido, e o `diag` responde com o número', async () => {
    const tail = await pluginTail();

    for (const hook of [
      'HookDispenserGather',
      'HookDispenserBonus',
      'HookCollectiblePickup',
      'HookPlayerDeath',
      'HookCraftFinished',
    ]) {
      expect(tail).toContain(`StatsHookStop(${hook}, started);`);
    }

    // Ticks do Stopwatch, e não `DateTime`: no Windows o
    // `DateTime.UtcNow` tem resolução de ~15 ms, e um hook de
    // microssegundos apareceria como zero para sempre.
    expect(tail).toContain('System.Diagnostics.Stopwatch.GetTimestamp()');
    expect(tail).toContain('System.Diagnostics.Stopwatch.Frequency');
    expect(tail).toContain('private const string StatsDiagCommand = "origemz.stats.diag";');
    expect(tail).toContain('[ConsoleCommand(StatsDiagCommand)]');
    expect(tail).toContain(STATS_COMMANDS.diag);
  });

  it('o push do recorde sai adiado, e só com o segredo', async () => {
    const tail = await pluginTail();

    // A armadilha JÁ MEDIDA neste projeto (`OrigemZPlayer.cs:463-484`):
    // um `Puts` dentro de um hook disparado por comando vira a
    // RESPOSTA daquele comando. E o caminho existe aqui:
    // `origemz.player.kill` -> `player.Die()` -> `OnPlayerDeath`.
    expect(tail).toContain('timer.Once(0f, delegate { Puts(line); });');

    // Sem segredo não se emite — e nada se perde: o recorde continua
    // no buffer e sai no lote, que é o caminho garantido.
    expect(tail).toContain('if (_statSecret.Length == 0)');
    expect(tail).toContain('private const string EventMarker = "#OZSTAT#";');
  });

  it('os campos que o plugin serializa são EXATAMENTE os que o agente lê', async () => {
    // ####  ESTE É O TESTE QUE PEGA A DIVERGÊNCIA CALADA  ####
    //
    // As duas pontas são compiladas separadamente e não há tipo
    // compartilhado. Um `JsonProperty` renomeado no `.cs` não quebra
    // compilação nenhuma: o zod do agente recusa a resposta inteira
    // e o sintoma é "o ranking parou", com o defeito a dois arquivos
    // de distância do sintoma.
    const source = await readFile(PLUGIN_PATH, 'utf8');

    expect(jsonPropertiesOf(source, 'StatsRecordInfo')).toEqual([
      'steamId',
      'name',
      'metric',
      'value',
      'at',
      'status',
      'detail',
    ]);

    // O push carrega três campos que o lote não tem — `contract`,
    // `kind` e `eventId` — e um que ele não PODE ter: o `secret`,
    // que viaja na linha do console e nunca no data file.
    expect(jsonPropertiesOf(source, 'StatRecordPush')).toEqual([
      'contract',
      'kind',
      'eventId',
      'steamId',
      'name',
      'metric',
      'value',
      'status',
      'at',
      'detail',
      'secret',
    ]);
  });

  it('o pedaço novo é ASCII puro e não usa sintaxe acima de C# 6', async () => {
    const tail = await pluginTail();
    const foreign = [...tail].filter((char) => (char.codePointAt(0) ?? 0) > 127);

    // O compilador do Oxide lê o arquivo com a codificação da
    // máquina: um travessão vira lixo no log de quem administra o
    // servidor.
    expect(foreign).toEqual([]);

    expect(tail).not.toMatch(/\bout var\b/);
    expect(tail).not.toMatch(/\bis \w+ [a-z]\w*\s*\)/);
    expect(tail).not.toMatch(/=>\s*$/m);
    expect(tail).not.toMatch(/\$"/);
    expect(tail).not.toMatch(/\?\./);
  });
});

// ------------------------------------------------------------
//  O SEGREDO NO `flush`
// ------------------------------------------------------------

describe('o segredo do canal, que viaja no `flush`', () => {
  it('vai como TERCEIRO argumento, e sem aspas', () => {
    // O parser de console do Rust COME as aspas de um token citado
    // (medido em `game/plugin-push.ts`), então o segredo vai cru —
    // como o `batchId` do `ack`.
    expect(buildStatsFlushCommand(0, 100, SECRET)).toBe(
      `${STATS_COMMANDS.flush} 0 100 ${SECRET}`,
    );
    expect(buildStatsFlushCommand(0, 100, SECRET)).not.toContain('"');
  });

  it('ausente, o comando sai com dois argumentos', () => {
    // É o mesmo comando que um admin digita à mão no console, e uma
    // digitação não pode desligar o push do plugin.
    expect(buildStatsFlushCommand(100, 250)).toBe(`${STATS_COMMANDS.flush} 100 250`);
    expect(buildStatsFlushCommand(0, 100, '')).toBe(`${STATS_COMMANDS.flush} 0 100`);
  });

  it('o plugin ignora o argumento vazio em vez de apagar o segredo', async () => {
    const tail = await pluginTail();

    expect(tail).toContain('if (secret.Length > 0)');
    expect(tail).toContain('_statSecret = secret;');
  });
});
