// ============================================================
//  rankings-stat-events.test.ts  -  as promessas da ponte
//  item -> ponto, que ninguém confere olhando.
//
//  ####  O QUE ESTAVA QUEBRADO ATÉ 05/09/2026  ####
//
//  O `OrigemZItems` convertia o item, gravava a conversão numa
//  fila em disco, destruía o item e gritava `#OZSTAT#{…}` no
//  console. **Nenhuma linha de TypeScript escutava.** O jogador
//  via o troféu sumir e o número não mexer — e o item não volta.
//
//  O que este arquivo guarda:
//
//    1. a linha `#OZSTAT#` SOMA no período aberto e deixa rastro
//       em `stat_events` — sem a segunda metade, "o jogador diz
//       que ganhou 3 e só contou 1" não tem resposta;
//    2. a MESMA linha duas vezes soma UMA. E a segunda não é erro:
//       ela é o desenho (push + fila), e um log de alarme ali
//       ensinaria a ignorar o log;
//    3. `contract` diferente de 1 é RECUSADO e não soma nada — e
//       de propósito não recebe `ack`: o evento fica na fila do
//       plugin até um agente que o entenda;
//    4. linha malformada não lança. O `onConsoleLine` é o stream
//       do servidor inteiro (`servers/context.ts:51-65`);
//    5. a linha que não é nossa sai na PRIMEIRA comparação —
//       este gancho recebe centenas de linhas por minuto;
//    6. o `ack` sai DEPOIS da gravação, e com os ids do lote;
//    7. o mesmo evento pelo push E pela fila de pendentes soma
//       uma vez — é a recuperação que impede a perda quando o
//       RCON estava fora no instante da conversão;
//    8. métrica sem ranking cadastrado SOMA (e avisa): recusar
//       perderia o ponto para sempre, porque o item já morreu.
//
//  Banco em memória, migrações reais: é o que permite provar a
//  idempotência do `INSERT OR IGNORE`, que é justamente a promessa
//  que um mock não teria.
// ============================================================

import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { RankingsRepository } from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import type { Logger } from '../src/logger.js';
import {
  ACK_COMMAND,
  buildPendingCommand,
  chunkByLength,
  EVENT_MARKER,
  PENDING_COMMAND,
  PENDING_PAGE_LIMIT,
  PENDING_TOO_LARGE,
  StatEventsConsumer,
} from '../src/rankings/stat-events.js';

/** O troféu do briefing, com a métrica que o catálogo semeia. */
const TROPHY_METRIC = 'trophy.bleik';
const FULANO = '76561198000000001';

/**
 * O segredo desta "subida do agente".
 *
 * Em produção é um `randomUUID()` sorteado no boot e empurrado ao
 * plugin no `origemz.item.clear`. Aqui ele é fixo para o teste
 * poder forjar a linha com e sem ele.
 */
const SECRET = 'b0a1c2d3-e4f5-4a6b-8c9d-0e1f2a3b4c5d';

/** O debounce do `ack` nos testes, e a espera com folga. */
const ACK_MS = 5;
const AFTER_ACK_MS = 80;

interface LogLine {
  readonly level: number;
  readonly msg: string;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: RankingsRepository;
  readonly logs: LogLine[];
  readonly logger: Logger;
}

let harness: Harness;

/**
 * Um RCON de mentira, que guarda o que foi mandado.
 *
 * O `onSend` existe para provar ORDEM: é dentro dele que o teste
 * do `ack` olha o banco e confere que a gravação já aconteceu.
 */
class FakeRcon {
  isConnected = true;
  readonly sent: string[] = [];
  /** O que responder, por prefixo de comando. */
  readonly replies = new Map<string, string>();
  onSend: ((command: string) => void) | null = null;
  /** O prefixo do comando que deve falhar, como um RCON que caiu. */
  failOn: string | null = null;
  /**
   * A resposta CALCULADA, para quando a tabela de prefixos não
   * basta — a paginação, em que a resposta depende do `offset` e do
   * `limit` que vieram na linha. `null` = deixa a tabela responder.
   */
  reply: ((command: string) => string | null) | null = null;

  send(command: string): Promise<string> {
    this.sent.push(command);
    this.onSend?.(command);

    if (this.failOn !== null && command.startsWith(this.failOn)) {
      return Promise.reject(new Error('o RCON caiu no meio'));
    }

    const computed = this.reply === null ? null : this.reply(command);

    if (computed !== null) {
      return Promise.resolve(computed);
    }

    for (const [prefix, reply] of this.replies) {
      if (command.startsWith(prefix)) {
        return Promise.resolve(reply);
      }
    }

    return Promise.resolve('{"ok":true,"pending":0}');
  }
}

/** Um evento como o plugin o serializa. Ver `StatEvent`, no .cs. */
function pointsEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: 1,
    kind: 'points',
    eventId: `${FULANO}-1757088123456-4821`,
    steamId: FULANO,
    name: 'Fulano',
    metric: TROPHY_METRIC,
    amount: 3,
    source: 'item:trofeu-bleik',
    at: 1_757_088_123,
    ...overrides,
  };
}

/**
 * A linha como ela chega do console.
 *
 * O `Puts` do Oxide carimba o nome do plugin na frente — e é por
 * isso que o consumidor procura o marcador em vez de exigir que a
 * linha comece com ele.
 *
 * ####  O SEGREDO ENTRA NA LINHA, E NÃO NO EVENTO  ####
 *
 * É o que o plugin faz: o `FlushQueue` serializa a conversão e
 * injeta o `secret` no JObject na hora de emitir, para que ele não
 * vá parar no arquivo da fila nem na resposta do
 * `origemz.item.pending`. Daí ele entrar aqui, e não no
 * `pointsEvent`.
 */
function line(event: Record<string, unknown>, secret: string | null = SECRET): string {
  const payload = secret === null ? event : { ...event, secret };

  return `[OrigemZItems] ${EVENT_MARKER}${JSON.stringify(payload)}`;
}

function settle(ms = AFTER_ACK_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * O consumidor, já ligado a dois servidores de mentira.
 *
 * `secret: null` monta um agente SEM segredo configurado — e não
 * `undefined`, que o valor padrão do parâmetro substituiria pelo
 * `SECRET` sem ninguém perceber.
 */
function consumerHarness(secret: string | null = SECRET): {
  readonly consumer: StatEventsConsumer;
  readonly pvp1: FakeRcon;
  readonly pvp2: FakeRcon;
} {
  const pvp1 = new FakeRcon();
  const pvp2 = new FakeRcon();

  const consumer = new StatEventsConsumer({
    repository: harness.repository,
    servers: {
      ids: () => ['pvp1', 'pvp2'],
      contextOf: (id) => {
        if (id === 'pvp1') {
          return { rcon: pvp1 };
        }

        return id === 'pvp2' ? { rcon: pvp2 } : null;
      },
    },
    logger: harness.logger,
    // O mesmo valor que o `CustomItemsSync` empurra ao plugin. Sem
    // ele, nenhuma linha de console é aceita — ver `#authentic`.
    secret: secret ?? undefined,
    ackMs: ACK_MS,
  });

  return { consumer, pvp1, pvp2 };
}

/** Quanto o jogador tem da métrica no período `season` aberto. */
function seasonValue(serverId: string, metric: string, steamId: string): number {
  const period = harness.repository.openPeriodOf(serverId, 'season');

  if (period === null) {
    return 0;
  }

  const entry = harness.repository
    .topOf({ periodId: period.id, metric, limit: 10, offset: 0 })
    .entries.find((row) => row.steamId === steamId);

  return entry?.value ?? 0;
}

/** As linhas de `stat_events`, que são a auditoria. */
function storedEvents(): { event_id: string; via: string; amount: number; metric: string }[] {
  return harness.db.prepare('SELECT event_id, via, amount, metric FROM stat_events').all() as {
    event_id: string;
    via: string;
    amount: number;
    metric: string;
  }[];
}

/** Os comandos de `ack` que saíram, e só eles. */
function ackCommands(rcon: FakeRcon): string[] {
  return rcon.sent.filter((command) => command.startsWith(ACK_COMMAND));
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  // As portas são únicas no banco: dois servidores de teste
  // precisam de faixas diferentes, como em produção.
  for (const [index, id] of ['pvp1', 'pvp2'].entries()) {
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

  // ####  O LOG É PARTE DA PROMESSA, ENTÃO ELE É MEDIDO  ####
  //
  // "Já vi este evento" é o caso NORMAL da via dupla, e um `error`
  // ali viraria alarme no funcionamento certo. Um logger silencioso
  // não provaria isso — este grava tudo e os testes conferem.
  const logs: LogLine[] = [];

  const logger = pino(
    { level: 'debug' },
    {
      write(chunk: string): void {
        logs.push(JSON.parse(chunk) as LogLine);
      },
    },
  );

  harness = { db, repository: new RankingsRepository(db), logs, logger };
});

// ------------------------------------------------------------
//  O push
// ------------------------------------------------------------

describe('o evento que chega pelo console', () => {
  it('soma no período aberto e deixa rastro em `stat_events`', () => {
    const { consumer } = consumerHarness();

    expect(consumer.handleLine('pvp1', line(pointsEvent()))).toBe('applied');

    // O ponto entrou nos três períodos abertos — o `applyEvent`
    // abre wipe, season e lifetime na primeira coleta.
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(3);

    // E a auditoria, que é a segunda metade da promessa: sem esta
    // linha, "ganhei 3 troféus e só contou 1" é a palavra de um
    // contra a do outro.
    const stored = storedEvents();

    expect(stored).toHaveLength(1);
    expect(stored[0]?.amount).toBe(3);
    expect(stored[0]?.metric).toBe(TROPHY_METRIC);
    // `via` é por qual caminho ele chegou PRIMEIRO.
    expect(stored[0]?.via).toBe('push');

    consumer.stop();
  });

  it('a MESMA linha duas vezes soma uma vez só, e a segunda não é erro', () => {
    const { consumer } = consumerHarness();
    const raw = line(pointsEvent());

    expect(consumer.handleLine('pvp1', raw)).toBe('applied');
    expect(consumer.handleLine('pvp1', raw)).toBe('duplicated');

    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(3);
    expect(storedEvents()).toHaveLength(1);

    // ####  E ISTO É METADE DA PROMESSA  ####
    //
    // O mesmo evento chegar duas vezes é o DESENHO (push + fila), e
    // não uma falha. Um `error` aqui alarmaria no funcionamento
    // certo — e alarme que toca sempre é alarme que se desliga.
    expect(harness.logs.filter((log) => log.level >= 50)).toEqual([]);

    consumer.stop();
  });

  it('recusa `contract` diferente de 1, e NÃO soma nada', () => {
    const { consumer } = consumerHarness();

    expect(consumer.handleLine('pvp1', line(pointsEvent({ contract: 2 })))).toBe('refused');

    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(0);
    expect(storedEvents()).toEqual([]);

    consumer.stop();
  });

  it('não confirma o que recusou — o evento fica na fila do plugin', async () => {
    const { consumer, pvp1 } = consumerHarness();

    consumer.handleLine('pvp1', line(pointsEvent({ contract: 2 })));

    await settle();

    // ####  RECUSAR E CONFIRMAR PERDERIA O PONTO PARA SEMPRE  ####
    //
    // `contract` diferente é "este agente é velho demais", e não
    // "este evento é lixo". Confirmar faria o plugin esquecer uma
    // conversão que a próxima versão saberia aplicar — e o item que
    // a originou já foi destruído.
    expect(ackCommands(pvp1)).toEqual([]);

    consumer.stop();
  });

  it('não lança com linha malformada, e o console segue', () => {
    const { consumer } = consumerHarness();

    expect(() => {
      // Marcada, mas não é JSON.
      consumer.handleLine('pvp1', `[OrigemZItems] ${EVENT_MARKER}{isto não é json`);
      // JSON, mas não é objeto.
      consumer.handleLine('pvp1', `[OrigemZItems] ${EVENT_MARKER}[]`);
      // Objeto, mas sem nada do contrato.
      consumer.handleLine('pvp1', `[OrigemZItems] ${EVENT_MARKER}{}`);
      // Campos do contrato com o tipo errado.
      consumer.handleLine('pvp1', line(pointsEvent({ amount: 'três' })));
      // `steamId` que não é um SteamID64 — lixo aqui viraria uma
      // linha de ranking que nunca casa com jogador nenhum.
      consumer.handleLine('pvp1', line(pointsEvent({ steamId: 'eu' })));
      // `at` em MILISSEGUNDOS, que é o disfarce mais provável.
      consumer.handleLine('pvp1', line(pointsEvent({ at: 1_757_088_123_456 })));
    }).not.toThrow();

    expect(storedEvents()).toEqual([]);

    // E a linha boa logo depois ainda entra: uma malformada não
    // pode envenenar o consumidor.
    expect(consumer.handleLine('pvp1', line(pointsEvent()))).toBe('applied');

    consumer.stop();
  });

  it('ignora barato a linha que não é nossa', () => {
    const { consumer } = consumerHarness();

    for (const noise of [
      '[CHAT] Mateuus: bom dia',
      'Saved 34,145 ents, serialization 12ms',
      '[OrigemZItems] #OZAREQ#items',
      `${ACK_COMMAND} ${FULANO}-1757088123456-4821`,
    ]) {
      expect(consumer.handleLine('pvp1', noise)).toBe('ignored');
    }

    expect(storedEvents()).toEqual([]);
    // Nem um período foi aberto: "ignorado" quer dizer que nada
    // aconteceu, e não que aconteceu e não somou.
    expect(harness.repository.openPeriodOf('pvp1', 'season')).toBeNull();

    consumer.stop();
  });

  it('recusa o `#OZSTAT#` que um jogador digitou no chat', () => {
    const { consumer } = consumerHarness();

    const forged = JSON.stringify(pointsEvent({ eventId: 'forjado', amount: 9_999 }));

    // ####  ESTE É O ATAQUE, E ELE É BARATO DE TENTAR  ####
    //
    // O `onConsoleLine` recebe TODA linha do servidor, e o chat
    // está entre elas. Sem a âncora, digitar o payload no chat
    // concederia pontos a si mesmo — o `steamId` do atacante é o
    // dele mesmo, e nada no contrato prova quem falou.
    for (const forgery of [
      `[CHAT] Fulano: ${EVENT_MARKER}${forged}`,
      `[ChatPlugin] Fulano diz: ${EVENT_MARKER}${forged}`,
      `Fulano: ${EVENT_MARKER}${forged}`,
      `algum log qualquer ${EVENT_MARKER}${forged}`,
    ]) {
      expect(consumer.handleLine('pvp1', forgery)).toBe('ignored');
    }

    expect(storedEvents()).toEqual([]);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(0);

    // E a linha de verdade — com o carimbo que o `Puts` do Oxide
    // põe, ou sem carimbo nenhum — continua passando. Ela leva o
    // segredo desta subida, que é o que o forjador não tem.
    const authentic = JSON.stringify({
      ...pointsEvent({ eventId: 'legitimo', amount: 3 }),
      secret: SECRET,
    });

    expect(consumer.handleLine('pvp1', `${EVENT_MARKER}${authentic}`)).toBe('applied');

    consumer.stop();
  });

  it('soma na métrica que nenhum ranking declara, e avisa uma vez só', () => {
    const { consumer } = consumerHarness();

    // ####  A DECISÃO: ACEITAR  ####
    //
    // Recusar perderia o ponto para SEMPRE — quando o evento chega,
    // o item já foi destruído. E o caso é comum: o admin cadastra o
    // item custom antes de criar o ranking que exibe a métrica, em
    // duas telas diferentes do painel.
    const first = pointsEvent({ metric: 'dungeon.bosses', eventId: 'a-1' });
    const second = pointsEvent({ metric: 'dungeon.bosses', eventId: 'a-2' });

    expect(consumer.handleLine('pvp1', line(first))).toBe('applied');
    expect(consumer.handleLine('pvp1', line(second))).toBe('applied');

    expect(seasonValue('pvp1', 'dungeon.bosses', FULANO)).toBe(6);

    // O aviso vale uma vez POR MÉTRICA. Cem troféus virariam cem
    // linhas iguais e ensinariam a ignorar o log.
    const warnings = harness.logs.filter(
      (log) => log.level === 40 && log.msg.includes('nenhum ranking declara'),
    );

    expect(warnings).toHaveLength(1);

    consumer.stop();
  });

  it('o `record` vira `player_records`, e não soma no contador', () => {
    const { consumer } = consumerHarness();

    const record = {
      contract: 1,
      kind: 'record',
      eventId: 'r-1',
      steamId: FULANO,
      name: 'Fulano',
      metric: 'shot.distance',
      value: 412.73,
      source: 'plugin',
      at: 1_757_088_123,
      detail: { weapon: 'rifle.bolt', headshot: true },
    };

    expect(consumer.handleLine('pvp1', line(record))).toBe('applied');
    // O mesmo recorde de novo não vira uma segunda linha: a
    // idempotência dele é o `batchId` derivado do `eventId`.
    expect(consumer.handleLine('pvp1', line(record))).toBe('duplicated');

    const period = harness.repository.openPeriodOf('pvp1', 'wipe');

    expect(period).not.toBeNull();

    const rows = harness.repository.topRecordsOf({
      periodId: period?.id ?? 0,
      metric: 'shot.distance',
      limit: 10,
      offset: 0,
    });

    expect(rows.entries).toHaveLength(1);
    expect(rows.entries[0]?.value).toBeCloseTo(412.73, 2);

    // E ele NÃO entrou no contador: recorde substitui o melhor, não
    // acumula.
    expect(seasonValue('pvp1', 'shot.distance', FULANO)).toBe(0);

    consumer.stop();
  });
});

// ------------------------------------------------------------
//  O `ack`
// ------------------------------------------------------------

describe('a confirmação ao plugin', () => {
  it('sai DEPOIS da gravação, e com os ids do lote', async () => {
    const { consumer, pvp1, pvp2 } = consumerHarness();

    // ####  A ORDEM É A PROMESSA  ####
    //
    // O `ack` faz o plugin ESQUECER a conversão. Mandá-lo antes do
    // COMMIT trocaria um ponto garantido por um ponto que o banco
    // ainda podia recusar — e o item que o originou já morreu.
    let storedWhenAcked = -1;

    pvp1.onSend = (command) => {
      if (command.startsWith(ACK_COMMAND)) {
        storedWhenAcked = storedEvents().length;
      }
    };

    consumer.handleLine('pvp1', line(pointsEvent({ eventId: 'a-1' })));
    consumer.handleLine('pvp1', line(pointsEvent({ eventId: 'a-2' })));

    // Nada saiu ainda: o gancho de console NÃO manda RCON. Ver
    // `index.ts:309-319` — o laço já aconteceu neste projeto.
    expect(pvp1.sent).toEqual([]);

    await settle();

    // Um comando só, com os dois ids: o `FlushQueue` do plugin
    // reenvia a fila inteira a cada conversão, e um comando por
    // evento seria N vezes o mesmo trabalho.
    expect(ackCommands(pvp1)).toEqual([`${ACK_COMMAND} a-1 a-2`]);
    expect(storedWhenAcked).toBe(2);

    // E o servidor que não recebeu evento nenhum não recebe
    // comando nenhum.
    expect(pvp2.sent).toEqual([]);

    consumer.stop();
  });

  it('confirma também o que já estava gravado', async () => {
    const { consumer, pvp1 } = consumerHarness();
    const raw = line(pointsEvent({ eventId: 'a-1' }));

    consumer.handleLine('pvp1', raw);

    await settle();

    consumer.handleLine('pvp1', raw);

    await settle();

    // ####  SEM ISTO A FILA DO PLUGIN NUNCA ESVAZIARIA  ####
    //
    // A duplicata chega porque o plugin ainda tem a conversão na
    // fila dele. Não confirmá-la de novo a deixaria lá para sempre,
    // reenviada a cada conversão nova — até o teto de 5.000.
    expect(ackCommands(pvp1)).toEqual([`${ACK_COMMAND} a-1`, `${ACK_COMMAND} a-1`]);

    consumer.stop();
  });

  it('sem RCON os ids ficam guardados, e saem na rodada seguinte', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.isConnected = false;

    consumer.handleLine('pvp1', line(pointsEvent({ eventId: 'a-1' })));

    await settle();

    expect(pvp1.sent).toEqual([]);
    // O ponto está gravado: o `ack` é sobre a fila do PLUGIN, e
    // não sobre o ponto.
    expect(storedEvents()).toHaveLength(1);

    pvp1.isConnected = true;

    expect(await consumer.drainAcks('pvp1')).toBe(1);
    expect(ackCommands(pvp1)).toEqual([`${ACK_COMMAND} a-1`]);

    consumer.stop();
  });

  it('o `ack` que falha devolve os ids para a próxima rodada', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.failOn = ACK_COMMAND;

    consumer.handleLine('pvp1', line(pointsEvent({ eventId: 'a-1' })));

    await settle();

    expect(ackCommands(pvp1)).toHaveLength(1);

    pvp1.failOn = null;

    // O id não se perdeu: ele voltou para a fila quando o envio
    // falhou, e a rodada seguinte o leva.
    expect(await consumer.drainAcks('pvp1')).toBe(1);
    expect(ackCommands(pvp1)).toHaveLength(2);

    consumer.stop();
  });

  it('quebra o lote grande em comandos que cabem no frame', () => {
    const ids = Array.from({ length: 300 }, (_, index) => `${FULANO}-1757088123456-${index}`);
    const batches = chunkByLength(ids, 200);

    // Nenhum id se perde: um que ficasse de fora deixaria a
    // conversão presa na fila do plugin para sempre.
    expect(batches.flat()).toEqual(ids);

    for (const batch of batches) {
      expect(batch.join(' ').length).toBeLessThanOrEqual(200);
    }

    // E um id sozinho maior que o teto ainda sai — cortá-lo
    // produziria uma confirmação de um id que não existe.
    expect(chunkByLength(['x'.repeat(50)], 10)).toEqual([['x'.repeat(50)]]);
  });
});

// ------------------------------------------------------------
//  A recuperação: a fila que ficou no plugin
// ------------------------------------------------------------

describe('a fila de pendentes do plugin', () => {
  it('aplica o que ficou e confirma o lote', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.replies.set(
      PENDING_COMMAND,
      JSON.stringify({
        ok: true,
        count: 2,
        pending: [pointsEvent({ eventId: 'p-1' }), pointsEvent({ eventId: 'p-2', amount: 5 })],
      }),
    );

    const result = await consumer.sweep('pvp1', 'teste');

    expect(result.skipped).toBeNull();
    expect(result.found).toBe(2);
    expect(result.applied).toBe(2);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(8);

    // O `via` diz por qual caminho ele chegou PRIMEIRO — e o
    // primeiro, aqui, foi a fila.
    expect(storedEvents().every((event) => event.via === 'flush')).toBe(true);

    expect(ackCommands(pvp1)).toEqual([`${ACK_COMMAND} p-1 p-2`]);

    consumer.stop();
  });

  it('o mesmo evento pelo push e depois pela fila soma UMA vez', async () => {
    const { consumer, pvp1 } = consumerHarness();
    const event = pointsEvent({ eventId: 'p-1' });

    // ####  É ESTE O CASO QUE A VIA DUPLA EXISTE PARA COBRIR  ####
    //
    // O push dá o "agora"; a fila dá o "garantido". O plugin segura
    // a conversão até o `ack`, então o evento que já entrou pelo
    // push VOLTA na varredura — e não pode dobrar o ponto.
    expect(consumer.handleLine('pvp1', line(event))).toBe('applied');

    pvp1.replies.set(PENDING_COMMAND, JSON.stringify({ ok: true, count: 1, pending: [event] }));

    const result = await consumer.sweep('pvp1', 'rcon-connected');

    expect(result.applied).toBe(0);
    expect(result.duplicated).toBe(1);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(3);
    expect(storedEvents()).toHaveLength(1);
    // E ele foi confirmado de novo: só o `ack` esvazia a fila do
    // plugin.
    expect(ackCommands(pvp1).at(-1)).toBe(`${ACK_COMMAND} p-1`);

    consumer.stop();
  });

  it('um evento fora do contrato não descarta os outros da fila', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.replies.set(
      PENDING_COMMAND,
      JSON.stringify({
        ok: true,
        count: 3,
        pending: [
          pointsEvent({ eventId: 'p-1' }),
          pointsEvent({ eventId: 'p-2', contract: 99 }),
          pointsEvent({ eventId: 'p-3', amount: 4 }),
        ],
      }),
    );

    const result = await consumer.sweep('pvp1', 'teste');

    expect(result.applied).toBe(2);
    expect(result.refused).toBe(1);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(7);

    // O recusado NÃO é confirmado: ele fica na fila do plugin até
    // um agente que entenda o contrato dele.
    expect(ackCommands(pvp1)).toEqual([`${ACK_COMMAND} p-1 p-3`]);

    consumer.stop();
  });

  it('resposta vazia é comando inexistente, e não fila vazia', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.replies.set(PENDING_COMMAND, '');

    const result = await consumer.sweep('pvp1', 'teste');

    // ####  MEDIDO NESTE PROJETO  ####
    //
    // O console do Rust não reclama de um comando que não conhece —
    // ele apenas não responde (`game/players.ts:430-440`). Tratar
    // isso como "a fila está vazia" esconderia o plugin desligado.
    expect(result.skipped).toContain('não respondeu');
    expect(result.found).toBe(0);

    consumer.stop();
  });

  it('sem RCON é `skipped`, e não derruba nada', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.isConnected = false;

    const result = await consumer.sweep('pvp1', 'teste');

    expect(result.skipped).toBe('o RCON está fora do ar');
    expect(pvp1.sent).toEqual([]);

    consumer.stop();
  });

  it('resposta fora do contrato não vira fila vazia', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.replies.set(PENDING_COMMAND, '{"ok":false,"error":"INTERNAL_ERROR"}');

    const result = await consumer.sweep('pvp1', 'teste');

    expect(result.skipped).toBe('a resposta não bate com o contrato');
    expect(storedEvents()).toEqual([]);

    consumer.stop();
  });

  it('varre todos os servidores, e um que falha não segura o outro', async () => {
    const { consumer, pvp1, pvp2 } = consumerHarness();

    pvp1.isConnected = false;
    pvp2.replies.set(
      PENDING_COMMAND,
      JSON.stringify({ ok: true, count: 1, pending: [pointsEvent({ eventId: 'p-9' })] }),
    );

    const results = await consumer.sweepAll('boot');

    expect(results).toHaveLength(2);
    expect(results[0]?.skipped).toBe('o RCON está fora do ar');
    expect(results[1]?.applied).toBe(1);
    expect(seasonValue('pvp2', TROPHY_METRIC, FULANO)).toBe(3);

    consumer.stop();
  });
});

// ------------------------------------------------------------
//  O segredo
// ------------------------------------------------------------

describe('o segredo que separa o plugin da boca de um jogador', () => {
  it('a linha CARIMBADA que a âncora deixa passar não passa sem o segredo', () => {
    const { consumer } = consumerHarness();

    const forged = JSON.stringify(pointsEvent({ eventId: 'forjado', amount: 9_999 }));

    // ####  ESTE É O BURACO QUE A ÂNCORA NÃO FECHA  ####
    //
    // `PLUGIN_LINE` exige o marcador no começo, atrás no máximo do
    // carimbo do Oxide — e é exatamente essa forma que um plugin de
    // chat de terceiros produz quando imprime a mensagem CRUA com
    // `Puts`: `[ChatDeluxe] #OZSTAT#{…}`. Servidores de Rust vivem
    // cheios deles, e um ranking com prêmio real não pode depender
    // de nenhum estar instalado.
    for (const forgery of [
      `[ChatDeluxe] ${EVENT_MARKER}${forged}`,
      `[BetterChat] ${EVENT_MARKER}${forged}`,
    ]) {
      expect(consumer.handleLine('pvp1', forgery)).toBe('ignored');
    }

    expect(storedEvents()).toEqual([]);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(0);

    consumer.stop();
  });

  it('segredo errado não soma — e não faz barulho no log', () => {
    const { consumer } = consumerHarness();

    expect(consumer.handleLine('pvp1', line(pointsEvent(), 'segredo-de-outro'))).toBe('ignored');

    expect(storedEvents()).toEqual([]);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(0);

    // ####  O ALARME SERIA DE QUEM FORJA, E NÃO NOSSO  ####
    //
    // Um `warn` por linha daria a quem digita no chat o poder de
    // encher o log do servidor de graça — e log que enche é log que
    // se para de ler. O registro fica em `debug`, para quem for
    // investigar.
    expect(harness.logs.filter((log) => log.level >= 40)).toEqual([]);
    expect(
      harness.logs.filter((log) => log.level === 20 && log.msg.includes('sem o segredo')),
    ).toHaveLength(1);

    consumer.stop();
  });

  it('linha sem o campo `secret` é ignorada', () => {
    const { consumer } = consumerHarness();

    // O plugin ANTIGO — o que emitia sem segredo nenhum — cai aqui.
    // Ignorar é o certo: o evento continua na fila em disco dele, e
    // a varredura do `origemz.item.pending` o recolhe.
    expect(consumer.handleLine('pvp1', line(pointsEvent(), null))).toBe('ignored');

    expect(storedEvents()).toEqual([]);

    consumer.stop();
  });

  it('com o segredo certo, soma como sempre somou', () => {
    const { consumer } = consumerHarness();

    expect(consumer.handleLine('pvp1', line(pointsEvent()))).toBe('applied');

    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(3);
    expect(storedEvents()).toHaveLength(1);

    consumer.stop();
  });

  it('sem segredo configurado, o console não é aceito — mas a fila ainda recolhe', async () => {
    const { consumer, pvp1 } = consumerHarness(null);

    // ####  FAIL-CLOSED, E ELE NÃO PERDE PONTO  ####
    //
    // É o mesmo desenho do `ui-sync`: sem segredo, a porta fica
    // fechada. E o que fecha não é um beco: o plugin segura a
    // conversão na fila em disco até o `ack`, e a varredura a traz
    // por um canal que ninguém forja — a resposta do NOSSO comando.
    expect(consumer.handleLine('pvp1', line(pointsEvent({ eventId: 'p-1' })))).toBe('ignored');
    expect(storedEvents()).toEqual([]);

    pvp1.replies.set(
      PENDING_COMMAND,
      JSON.stringify({
        ok: true,
        count: 1,
        offset: 0,
        limit: PENDING_PAGE_LIMIT,
        pending: [pointsEvent({ eventId: 'p-1' })],
      }),
    );

    const result = await consumer.sweep('pvp1', 'teste');

    expect(result.applied).toBe(1);
    expect(seasonValue('pvp1', TROPHY_METRIC, FULANO)).toBe(3);

    consumer.stop();
  });
});

// ------------------------------------------------------------
//  A paginação da fila de pendentes
// ------------------------------------------------------------

/** Uma fila de N eventos, como o plugin a devolveria. */
function queueOf(size: number): Record<string, unknown>[] {
  return Array.from({ length: size }, (_unused, index) =>
    pointsEvent({ eventId: `p-${String(index + 1)}`, amount: 1 }),
  );
}

/** Os `origemz.item.pending` que saíram, na ordem. */
function pendingCommands(rcon: FakeRcon): string[] {
  return rcon.sent.filter((command) => command.startsWith(PENDING_COMMAND));
}

describe('a paginação do `origemz.item.pending`', () => {
  it('pede a primeira página com offset 0 e o limite do contrato', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.replies.set(
      PENDING_COMMAND,
      JSON.stringify({ ok: true, count: 0, offset: 0, limit: PENDING_PAGE_LIMIT, pending: [] }),
    );

    await consumer.sweep('pvp1', 'teste');

    expect(pendingCommands(pvp1)).toEqual([buildPendingCommand(0, PENDING_PAGE_LIMIT)]);

    consumer.stop();
  });

  it('`PAYLOAD_TOO_LARGE` reduz a janela pela metade e NÃO avança o offset', async () => {
    const { consumer, pvp1 } = consumerHarness();
    const queue = queueOf(3);

    pvp1.reply = (command) => {
      if (!command.startsWith(PENDING_COMMAND)) {
        return null;
      }

      const parts = command.split(' ');
      const offset = Number(parts[1]);
      const limit = Number(parts[2]);

      // Este plugin de mentira só consegue montar 25 por vez.
      if (limit > 25) {
        return JSON.stringify({ ok: false, error: PENDING_TOO_LARGE });
      }

      return JSON.stringify({
        ok: true,
        count: queue.length,
        offset,
        limit,
        pending: queue.slice(offset, offset + limit),
      });
    };

    const result = await consumer.sweep('pvp1', 'teste');

    // ####  O OFFSET NÃO ANDA ENQUANTO A JANELA ENCOLHE  ####
    //
    // Avançar aqui pularia justamente os eventos que não couberam —
    // e cada um deles é uma conversão cujo item já foi destruído.
    expect(pendingCommands(pvp1)).toEqual([
      buildPendingCommand(0, 100),
      buildPendingCommand(0, 50),
      buildPendingCommand(0, 25),
    ]);

    expect(result.applied).toBe(3);
    expect(result.found).toBe(3);
    expect(storedEvents()).toHaveLength(3);

    consumer.stop();
  });

  it('página menor que o `limit` NÃO é fim de lista — o fim é o `count`', async () => {
    const { consumer, pvp1 } = consumerHarness();

    // O plugin normaliza o limite pedido (100) para 2, e a primeira
    // página vem com UM evento só. Quem parasse aí somaria 1 de 4 —
    // e os outros três ficariam presos na fila para sempre, porque a
    // varredura seguinte pararia no mesmo lugar.
    const pages = new Map<number, Record<string, unknown>[]>([
      [0, [pointsEvent({ eventId: 'p-1', amount: 1 })]],
      [2, [pointsEvent({ eventId: 'p-3', amount: 1 }), pointsEvent({ eventId: 'p-4', amount: 1 })]],
      [4, [pointsEvent({ eventId: 'p-5', amount: 1 })]],
    ]);

    pvp1.reply = (command) => {
      if (!command.startsWith(PENDING_COMMAND)) {
        return null;
      }

      const offset = Number(command.split(' ')[1]);

      return JSON.stringify({
        ok: true,
        count: 5,
        offset,
        // O limite APLICADO, menor que o pedido: é por ele que o
        // agente anda. Andar pelo pedido (100) pularia a fila
        // inteira depois da primeira página.
        limit: 2,
        pending: pages.get(offset) ?? [],
      });
    };

    const result = await consumer.sweep('pvp1', 'teste');

    // O PEDIDO continua sendo o do contrato — quem encolhe a janela
    // é só o `PAYLOAD_TOO_LARGE`. O que o `limit` devolvido governa
    // é o AVANÇO: 0 → 2 → 4, e não 0 → 100.
    expect(pendingCommands(pvp1)).toEqual([
      buildPendingCommand(0, PENDING_PAGE_LIMIT),
      buildPendingCommand(2, PENDING_PAGE_LIMIT),
      buildPendingCommand(4, PENDING_PAGE_LIMIT),
    ]);

    expect(result.found).toBe(5);
    expect(result.applied).toBe(4);
    expect(storedEvents()).toHaveLength(4);

    consumer.stop();
  });

  it('desiste quando um evento sozinho não cabe, e diz por quê', async () => {
    const { consumer, pvp1 } = consumerHarness();

    pvp1.replies.set(PENDING_COMMAND, JSON.stringify({ ok: false, error: PENDING_TOO_LARGE }));

    const result = await consumer.sweep('pvp1', 'teste');

    // 100 → 50 → 25 → 12 → 6 → 3 → 1, e aí para: um evento maior
    // que o frame é corrupção, não volume, e girar para sempre
    // seria pior que parar dizendo onde travou.
    expect(pendingCommands(pvp1)).toEqual([
      buildPendingCommand(0, 100),
      buildPendingCommand(0, 50),
      buildPendingCommand(0, 25),
      buildPendingCommand(0, 12),
      buildPendingCommand(0, 6),
      buildPendingCommand(0, 3),
      buildPendingCommand(0, 1),
    ]);

    expect(result.skipped).toContain('não cabe sozinho');
    expect(result.applied).toBe(0);

    consumer.stop();
  });

  it('o plugin sem paginação — sem `offset` nem `limit` — continua sendo lido', async () => {
    const { consumer, pvp1 } = consumerHarness();

    // ####  DEPLOY PELA METADE É O CASO NORMAL  ####
    //
    // O agente sobe antes de alguém recarregar o `.cs` em cada
    // servidor. Recusar a resposta antiga descartaria a única cópia
    // dos pontos já convertidos, e o item que os originou já morreu.
    pvp1.replies.set(PENDING_COMMAND, JSON.stringify({ ok: true, count: 2, pending: queueOf(2) }));

    const result = await consumer.sweep('pvp1', 'teste');

    // Uma página só: sem `limit` na resposta, quem avança é o
    // tamanho do que veio — e ele já cobriu o `count`.
    expect(pendingCommands(pvp1)).toHaveLength(1);
    expect(result.applied).toBe(2);
    expect(result.skipped).toBeNull();

    consumer.stop();
  });
});
