// ============================================================
//  quests-collector.test.ts  -  o relógio e o canal do "agora".
//
//  O que este arquivo guarda:
//
//    1. o `ack` sai DEPOIS de aplicar. Confirmar antes troca uma
//       duplicata inofensiva por uma perda silenciosa;
//    2. a página que não cabe faz o `limit` cair pela metade E o
//       `offset` FICAR PARADO — avançar perderia as linhas dela;
//    3. resposta ilegível NUNCA vira "ninguém progrediu": o lote
//       fica no plugin, sem `ack`, e volta na rodada seguinte;
//    4. o `watch` só desce quando o catálogo MUDA — um comando de
//       RCON por minuto por servidor para dizer a mesma coisa é o
//       que ele evita;
//    5. `lootEnabled: false` esvazia a lista de loot, e é ela vazia
//       que desliga o hook mais quente do jogo;
//    6. o `sweep` NUNCA lança: servidor parado e plugin quebrado
//       são rotina, e uma exceção pararia a coleta para sempre;
//    7. o recalculo dos derivados roda para quem está ONLINE — é a
//       dependência que a frente B pediu por escrito;
//    8. o push com segredo errado é ignorado EM SILÊNCIO: o chat
//       passa pelo mesmo cano, e alguém testando o marcador não
//       pode encher o log.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { parseQuestPush, QUEST_EVENT_MARKER } from '../src/game/quests-contract.js';
import { createLogger } from '../src/logger.js';
import { QuestCollector, type QuestCollectorRcon } from '../src/quests/collector.js';
import { QuestEvents } from '../src/quests/events.js';
import { NPC_MARKER, parseNpcLine, QuestNpcSync } from '../src/quests/npc-sync.js';
import { QuestsService } from '../src/quests/service.js';
import { questInputSchema, type QuestDraft } from '../src/types/quests.js';

const logger = createLogger({ log: { level: 'silent', pretty: false } });
const SECRET = 'segredo-de-teste';
const FULANO = '76561198000000001';

interface Harness {
  readonly repository: QuestsRepository;
  service: QuestsService;
  readonly sent: string[];
  /** O roteiro de respostas, na ordem em que os comandos chegam. */
  replies: (command: string) => string;
  online: readonly string[] | null;
  /** O relógio, para os testes que rodam duas varreduras seguidas. */
  now: number;
}

let h: Harness;

function quest(overrides: Partial<QuestDraft> = {}): ReturnType<typeof questInputSchema.parse> {
  return questInputSchema.parse({
    title: 'Minerador',
    objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 5000 }],
    rewards: [],
    ...overrides,
  });
}

function collector(): QuestCollector {
  const rcon: QuestCollectorRcon = {
    isConnected: true,
    send: (command: string) => {
      h.sent.push(command);

      return Promise.resolve(h.replies(command));
    },
  };

  return new QuestCollector({
    repository: h.repository,
    service: h.service,
    servers: { ids: () => ['pvp1'], contextOf: () => ({ rcon }) },
    presence: { online: () => Promise.resolve(h.online) },
    logger,
    secret: SECRET,
    // O relógio é do teste: sem ele, a segunda varredura seria
    // pulada pelo `flushSeconds` — que é justamente o que o teste
    // do ritmo prova.
    now: () => h.now,
  });
}

/** Uma resposta de `flush` bem formada. */
function flushReply(
  batchId: string,
  entries: readonly { pq: number; seq: number; delta: number }[],
  total = entries.length,
): string {
  return JSON.stringify({ ok: true, contract: 1, batchId, entries, total });
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'PVP1',
    identity: 'pvp1',
    enabled: true,
    gamePort: 28015,
    rconPort: 28016,
    queryPort: 28017,
    appPort: 28082,
    rconHost: '127.0.0.1',
    installDir: 'Servers/pvp1',
  });

  const repository = new QuestsRepository(db);

  h = {
    repository,
    service: new QuestsService({ repository, logger }),
    sent: [],
    replies: () => flushReply('b1', []),
    online: [],
    now: 1_757_000_000_000,
  };
});

// ------------------------------------------------------------
//  O CATÁLOGO
// ------------------------------------------------------------

describe('o catálogo que desce ao plugin', () => {
  it('só é mandado quando MUDA', async () => {
    h.repository.create('minerador', quest());

    const sweeper = collector();

    await sweeper.sweep();
    const first = h.sent.filter((command) => command.startsWith('origemz.quest.watch')).length;

    h.now += 120_000;
    await sweeper.sweep();
    const second = h.sent.filter((command) => command.startsWith('origemz.quest.watch')).length;

    // Um comando de RCON por minuto por servidor para dizer a mesma
    // coisa é o que isto evita.
    expect(first).toBe(1);
    expect(second).toBe(1);

    // Uma quest nova muda o catálogo.
    h.repository.create('cacador', quest({ title: 'Caçador', objectives: [{ seq: 0, kind: 'kill', target: 'bear', amount: 3 }] }));
    h.now += 120_000;
    await sweeper.sweep();

    expect(h.sent.filter((command) => command.startsWith('origemz.quest.watch'))).toHaveLength(2);
  });

  it('o `forget` força o reenvio — é o caminho do `#OZAREQ#`', async () => {
    h.repository.create('minerador', quest());

    const sweeper = collector();

    await sweeper.sweep();
    sweeper.forget('pvp1');
    h.now += 120_000;
    await sweeper.sweep();

    expect(h.sent.filter((command) => command.startsWith('origemz.quest.watch'))).toHaveLength(2);
  });

  it('carrega o segredo e a normalização das criaturas', async () => {
    h.repository.create(
      'cacador',
      quest({ objectives: [{ seq: 0, kind: 'kill', target: 'scientist', amount: 3 }] }),
    );

    await collector().sweep();

    const watch = h.sent.find((command) => command.startsWith('origemz.quest.watch')) ?? '';
    const payload = JSON.parse(
      Buffer.from(watch.split(' ')[1] as string, 'base64').toString('utf8'),
    ) as { secret: string; watch: Record<string, string[]>; alias: Record<string, string> };

    expect(payload.secret).toBe(SECRET);
    expect(payload.watch.kill).toEqual(['scientist']);
    // A tabela mora no agente: uma criatura nova do Rust não pode
    // exigir um release de plugin.
    expect(payload.alias.scientistnpc_heavy).toBe('scientist');
  });

  it('`lootEnabled: false` esvazia a lista de loot', async () => {
    h.repository.create(
      'saqueador',
      quest({ objectives: [{ seq: 0, kind: 'loot', target: 'scrap', amount: 100 }] }),
    );
    h.repository.saveSettings('pvp1', {
      maxActive: 0,
      enabled: true,
      flushSeconds: 60,
      lootEnabled: false,
      resetAtMinute: 0,
    });

    await collector().sweep();

    const watch = h.sent.find((command) => command.startsWith('origemz.quest.watch')) ?? '';
    const payload = JSON.parse(
      Buffer.from(watch.split(' ')[1] as string, 'base64').toString('utf8'),
    ) as { watch: Record<string, string[]> };

    // É a lista VAZIA que faz o plugin não registrar
    // `OnItemAddedToContainer` — o hook mais quente do jogo.
    expect(payload.watch.loot).toBeUndefined();
  });
});

// ------------------------------------------------------------
//  O LOTE
// ------------------------------------------------------------

describe('o lote', () => {
  let playerQuestId: number;

  beforeEach(async () => {
    h.repository.create('minerador', quest());

    playerQuestId = (
      await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' })
    ).playerQuestId;
  });

  it('aplica e confirma DEPOIS', async () => {
    h.replies = (command) =>
      command.startsWith('origemz.quest.flush')
        ? flushReply('lote-1', [{ pq: playerQuestId, seq: 0, delta: 1200 }])
        : '{"ok":true}';

    await collector().sweep();

    expect(h.repository.attempt(playerQuestId)?.progress[0]).toBe(1200);

    const flushAt = h.sent.findIndex((command) => command.startsWith('origemz.quest.flush'));
    const ackAt = h.sent.findIndex((command) => command.startsWith('origemz.quest.ack'));

    // Confirmar ANTES de gravar troca uma duplicata inofensiva —
    // que o `batchId` recusa — por uma perda silenciosa.
    expect(ackAt).toBeGreaterThan(flushAt);
    expect(h.sent[ackAt]).toBe('origemz.quest.ack lote-1');
  });

  it('conclui o que fechou, sem esperar o push', async () => {
    h.replies = (command) =>
      command.startsWith('origemz.quest.flush')
        ? flushReply('lote-1', [{ pq: playerQuestId, seq: 0, delta: 5000 }])
        : '{"ok":true}';

    await collector().sweep();

    expect(h.repository.attempt(playerQuestId)?.status).toBe('completed');
  });

  it('a página que não cabe faz o `limit` cair e o `offset` FICAR', async () => {
    let calls = 0;

    h.replies = (command) => {
      if (!command.startsWith('origemz.quest.flush')) {
        return '{"ok":true}';
      }

      calls += 1;

      return calls === 1
        ? '{"ok":false,"error":"PAYLOAD_TOO_LARGE"}'
        : flushReply('lote-1', [{ pq: playerQuestId, seq: 0, delta: 10 }]);
    };

    await collector().sweep();

    const flushes = h.sent.filter((command) => command.startsWith('origemz.quest.flush'));

    expect(flushes).toHaveLength(2);
    // O offset NÃO avançou: avançar perderia as linhas da página
    // que não coube.
    expect(flushes[0]).toBe('origemz.quest.flush 0 100 segredo-de-teste');
    expect(flushes[1]).toBe('origemz.quest.flush 0 50 segredo-de-teste');
  });

  it('pagina até o fim quando o `total` é maior que a página', async () => {
    h.replies = (command) => {
      if (!command.startsWith('origemz.quest.flush')) {
        return '{"ok":true}';
      }

      const offset = Number(command.split(' ')[1]);

      return offset === 0
        ? flushReply('lote-1', [{ pq: playerQuestId, seq: 0, delta: 100 }], 2)
        : flushReply('lote-1', [{ pq: playerQuestId, seq: 0, delta: 200 }], 2);
    };

    await collector().sweep();

    expect(h.sent.filter((command) => command.startsWith('origemz.quest.flush'))).toHaveLength(2);
    expect(h.repository.attempt(playerQuestId)?.progress[0]).toBe(300);
  });

  it('resposta ilegível NÃO vira "ninguém progrediu" — e não confirma', async () => {
    h.replies = (command) =>
      command.startsWith('origemz.quest.flush') ? 'isto não é json' : '{"ok":true}';

    const results = await collector().sweep();

    // "Não consegui perguntar" e "ninguém progrediu" são respostas
    // diferentes, e a segunda não pode se disfarçar da primeira.
    expect(results[0]?.status).toBe('failed');
    // Sem `ack`, o lote fica no plugin e volta na rodada seguinte.
    expect(h.sent.some((command) => command.startsWith('origemz.quest.ack'))).toBe(false);
  });

  it('o mesmo lote duas vezes soma UMA vez', async () => {
    h.replies = (command) =>
      command.startsWith('origemz.quest.flush')
        ? flushReply('lote-mesmo', [{ pq: playerQuestId, seq: 0, delta: 700 }])
        : '{"ok":true}';

    const sweeper = collector();

    await sweeper.sweep();
    h.now += 120_000;
    await sweeper.sweep();

    // O `ack` pode se perder depois do commit. Sem o
    // `quest_batches`, o lote dobraria o progresso de todo mundo.
    expect(h.repository.attempt(playerQuestId)?.progress[0]).toBe(700);
  });
});

// ------------------------------------------------------------
//  O QUE NÃO PODE PARAR
// ------------------------------------------------------------

describe('a rodada nunca para a coleta', () => {
  it('servidor sem RCON é `skipped`, e não erro', async () => {
    const sweeper = new QuestCollector({
      repository: h.repository,
      service: h.service,
      servers: { ids: () => ['pvp1'], contextOf: () => null },
      presence: { online: () => Promise.resolve([]) },
      logger,
      secret: SECRET,
    });

    const results = await sweeper.sweep();

    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'sem RCON' });
  });

  it('o módulo desligado no servidor nem pergunta', async () => {
    h.repository.saveSettings('pvp1', {
      maxActive: 0,
      enabled: false,
      flushSeconds: 60,
      lootEnabled: true,
      resetAtMinute: 0,
    });

    const results = await collector().sweep();

    expect(results[0]?.status).toBe('skipped');
    expect(h.sent).toEqual([]);
  });

  it('o RCON que estoura vira `failed`, e não exceção', async () => {
    const sweeper = new QuestCollector({
      repository: h.repository,
      service: h.service,
      servers: {
        ids: () => ['pvp1'],
        contextOf: () => ({
          rcon: { isConnected: true, send: () => Promise.reject(new Error('caiu')) },
        }),
      },
      presence: { online: () => Promise.resolve([]) },
      logger,
      secret: SECRET,
    });

    // Uma exceção que escapasse pararia a coleta para sempre, em
    // silêncio — o pior jeito de um relógio falhar.
    await expect(sweeper.sweep()).resolves.toMatchObject([{ status: 'failed' }]);
  });
});

// ------------------------------------------------------------
//  OS DERIVADOS
// ------------------------------------------------------------

describe('o recálculo dos derivados', () => {
  it('roda para quem está ONLINE — a dependência que a frente B pediu', async () => {
    const totals = new Map<string, number>([['time.played', 0]]);

    const service = new QuestsService({
      repository: h.repository,
      logger,
      stats: { totalOf: (_server, _steam, metric) => totals.get(metric) ?? 0 },
    });

    h.service = service;
    h.repository.create(
      'presenca',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 60 }] }),
    );

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'presenca',
    });

    h.online = [FULANO];
    totals.set('time.played', 1800);

    await collector().sweep();

    // Sem esta chamada, "fique 60 minutos online" de quem nunca
    // abre o menu ficaria em zero PARA SEMPRE.
    expect(h.repository.attempt(view.playerQuestId)?.progress[0]).toBe(30);
  });

  it('presence `null` não recalcula nada — é diferente de "ninguém online"', async () => {
    h.online = null;

    const results = await collector().sweep();

    expect(results[0]?.refreshed).toBe(0);
  });
});

// ------------------------------------------------------------
//  O PUSH
// ------------------------------------------------------------

describe('o canal do "agora"', () => {
  function push(overrides: Record<string, unknown> = {}): string {
    return `${QUEST_EVENT_MARKER}${JSON.stringify({
      contract: 1,
      secret: SECRET,
      eventId: 'pvp1-42',
      kind: 'complete',
      steamId: FULANO,
      pq: 1,
      ...overrides,
    })}`;
  }

  it('o segredo errado é ignorado EM SILÊNCIO', () => {
    // O chat dos jogadores passa por este mesmo cano. Sem o
    // segredo, digitar o marcador seria concluir a própria missão —
    // e alguém testando não pode encher o log de alarme.
    expect(parseQuestPush(push({ secret: 'chutei' }), SECRET)).toBeNull();
    expect(parseQuestPush(push(), SECRET)).not.toBeNull();
  });

  it('JSON quebrado e linha sem marcador não derrubam nada', () => {
    expect(parseQuestPush(`${QUEST_EVENT_MARKER}{quebrado`, SECRET)).toBeNull();
    expect(parseQuestPush('[CHAT] Fulano: oi', SECRET)).toBeNull();
  });

  it('o push que o agente não sustenta não conclui nada', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    const events = new QuestEvents({ service: h.service, logger, secret: SECRET });
    const handled = events.handleLine('pvp1', push({ pq: view.playerQuestId }));

    // A linha era nossa (por isso `true`), mas o contador do agente
    // não sustenta a conclusão — e ela NÃO acontece.
    expect(handled).toBe(true);
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('active');

    events.stop();
  });

  // ####  O "AGORA" NAO PODE VIRAR "ATE UM MINUTO"  ####
  //
  // MEDIDO no servidor em 07/09/2026: o jogador matou o terceiro
  // cientista, o plugin gritou a conclusão, o agente recusou —
  // porque o contador dele ainda estava em 1 — e a quest só fechou
  // 78 segundos depois, no lote do relógio. Do lado de quem joga,
  // "matei o último e não aconteceu nada".
  //
  // A recusa está certa. O que estava errado era esperar o relógio
  // depois dela: o número que falta está no plugin, a uma ida de
  // RCON.
  it('o push que o agente não sustenta MANDA BUSCAR o número', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    const asked: string[] = [];
    const events = new QuestEvents({
      service: h.service,
      logger,
      secret: SECRET,
      flushNow: (serverId) => asked.push(serverId),
    });

    events.handleLine('pvp1', push({ pq: view.playerQuestId }));

    expect(asked).toEqual(['pvp1']);

    events.stop();
  });

  it('a segunda chegada do mesmo fato NÃO manda buscar de novo', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    // O lote já fechou a tentativa: o push que chega depois é a
    // segunda cópia do mesmo fato, de propósito. Uma ida ao RCON
    // aqui seria à toa.
    h.repository.setProgress(view.playerQuestId, 0, 5000);
    h.service.reportCompletion({ playerQuestId: view.playerQuestId });

    const asked: string[] = [];
    const events = new QuestEvents({
      service: h.service,
      logger,
      secret: SECRET,
      flushNow: (serverId) => asked.push(serverId),
    });

    events.handleLine('pvp1', push({ pq: view.playerQuestId }));

    expect(asked).toEqual([]);

    events.stop();
  });

  it('o recibo NÃO sai de dentro do gancho', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    h.repository.setProgress(view.playerQuestId, 0, 5000);

    const tell = vi.fn((_server: string, _steam: string, _message: string) =>
      Promise.resolve(),
    );
    const events = new QuestEvents({
      service: h.service,
      logger,
      secret: SECRET,
      chat: { tell },
      replyDelayMs: 1,
    });

    events.handleLine('pvp1', push({ pq: view.playerQuestId }));

    // A conclusão é IMEDIATA (SQLite não fala com o jogo)…
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('completed');
    // …mas o comando ao jogo espera o relógio. Um comando mandado
    // de dentro do `onConsoleLine` volta pelo mesmo caminho e
    // dispara de novo — o paredão que este projeto já viveu.
    expect(tell).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tell).toHaveBeenCalledOnce();
    expect(tell.mock.calls[0]?.[2]).toContain('Minerador');

    events.stop();
  });

  it('o `progress` não escreve nada — o número vem no lote', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    const events = new QuestEvents({ service: h.service, logger, secret: SECRET });

    events.handleLine('pvp1', push({ kind: 'progress', pq: view.playerQuestId }));

    // Um `INSERT` a cada pedra minerada seria caro e inútil: o marco
    // existe para o recibo.
    expect(h.repository.events({ steamId: FULANO, kind: 'progress' })).toEqual([]);

    events.stop();
  });
});

// ------------------------------------------------------------
//  O RITMO
// ------------------------------------------------------------

describe('o flush sob demanda', () => {
  it('`flushNow` ignora a vez do servidor, e a rodada seguinte volta ao ritmo', async () => {
    h.repository.create('minerador', quest());

    const sweeper = collector();

    // A primeira rodada marca a vez dele.
    await sweeper.sweep();
    const first = h.sent.length;

    // A segunda, dentro do intervalo, é pulada.
    await sweeper.sweep();
    expect(h.sent.length).toBe(first);

    // `flushNow` limpa a guarda DAQUELE servidor e vai.
    const result = await sweeper.flushNow('pvp1');

    expect(result.status).toBe('applied');
    expect(h.sent.length).toBeGreaterThan(first);

    // E o relógio volta ao normal: a rodada seguinte é pulada de
    // novo, senão um push transformaria o intervalo em zero.
    const after = h.sent.length;

    await sweeper.sweep();
    expect(h.sent.length).toBe(after);
  });
});

describe('o `flushSeconds` de cada servidor', () => {
  it('vale de verdade: a segunda rodada dentro do intervalo é pulada', async () => {
    h.repository.create('minerador', quest());
    h.repository.saveSettings('pvp1', {
      maxActive: 0,
      enabled: true,
      flushSeconds: 120,
      lootEnabled: true,
      resetAtMinute: 0,
    });

    const sweeper = collector();

    const first = await sweeper.sweep();
    const second = await sweeper.sweep();

    // Um campo no painel que não faz nada é pior que campo nenhum.
    expect(first[0]?.status).toBe('applied');
    expect(second[0]).toMatchObject({ status: 'skipped', reason: 'ainda não é a vez dele' });
  });
});

// ------------------------------------------------------------
//  OS NPCs
// ------------------------------------------------------------

describe('os NPCs', () => {
  function sync(
    open?: (input: { serverId: string; steamId: string; screenId: string }) => Promise<void>,
  ) {
    const rcon: QuestCollectorRcon = {
      isConnected: true,
      send: (command: string) => {
        h.sent.push(command);

        return Promise.resolve('{"ok":true}');
      },
    };

    return new QuestNpcSync({
      repository: h.repository,
      servers: { ids: () => ['pvp1'], contextOf: () => ({ rcon }) },
      logger,
      secret: SECRET,
      openScreen: open === undefined ? undefined : (input) => open(input),
    });
  }

  function npcLine(body: Record<string, unknown>): string {
    return `${NPC_MARKER}${JSON.stringify({ contract: 1, secret: SECRET, ...body })}`;
  }

  it('o `/questnpc add` cadastra o NPC na posição do admin', () => {
    const handled = sync().handleLine(
      'pvp1',
      npcLine({ kind: 'add', name: 'Velho do Outpost', x: 120.5, y: 10, z: -430.25, rotation: 90 }),
    );

    expect(handled).toBe(true);

    const npc = h.repository.getNpc('velho-do-outpost');

    expect(npc).toMatchObject({ serverId: 'pvp1', x: 120.5, z: -430.25, rotation: 90 });
    // O prefab e o raio saem dos padrões do contrato — medidos, não
    // chutados. E o padrão é o boneco que FALA: o prompt "TALK" do
    // jogo é do `NPCTalking`, e o `bandit_shopkeeper` de antes não
    // era um. Ver a migração 077.
    expect(npc?.prefab).toContain('bandit_conversationalist');
  });

  it('o `/questnpc move` TRAZ o NPC, e não cria um segundo', () => {
    h.repository.createNpc('velho', {
      serverId: 'pvp1',
      name: 'Velho',
      kind: 'quest',
      x: 1,
      y: 1,
      z: 1,
      rotation: 0,
      prefab: 'p',
      mapMarker: false,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });

    const handled = sync().handleLine(
      'pvp1',
      npcLine({ kind: 'move', npcId: 'velho', x: 500, y: 20, z: -80, rotation: 270 }),
    );

    expect(handled).toBe(true);
    expect(h.repository.getNpc('velho')).toMatchObject({ x: 500, z: -80, rotation: 270 });
    // O painel mandava usar o `add` de novo, e o admin terminava
    // com "velho" e "velho-2". Este é o teste dessa diferença.
    expect(h.repository.getNpc('velho-2')).toBeNull();
  });

  it('o `move` de outro servidor não mexe no NPC daqui', () => {
    h.repository.createNpc('velho', {
      serverId: 'pvp1',
      name: 'Velho',
      kind: 'quest',
      x: 1,
      y: 1,
      z: 1,
      rotation: 0,
      prefab: 'p',
      mapMarker: false,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });

    sync().handleLine(
      'pvp2',
      npcLine({ kind: 'move', npcId: 'velho', x: 500, y: 20, z: -80, rotation: 270 }),
    );

    expect(h.repository.getNpc('velho')).toMatchObject({ x: 1, z: 1 });
  });

  it('o `/questnpc remove` apaga o NPC e deixa a quest dele de pé', () => {
    h.repository.createNpc('velho', {
      serverId: 'pvp1',
      name: 'Velho',
      kind: 'quest',
      x: 1,
      y: 1,
      z: 1,
      rotation: 0,
      prefab: 'p',
      mapMarker: false,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });
    h.repository.create(
      'do-npc',
      questInputSchema.parse({
        title: 'Do NPC',
        npcId: 'velho',
        objectives: [{ seq: 0, kind: 'kill', target: 'bear', amount: 1 }],
      }),
    );

    expect(sync().handleLine('pvp1', npcLine({ kind: 'remove', npcId: 'velho' }))).toBe(true);

    expect(h.repository.getNpc('velho')).toBeNull();
    // O progresso de quem estava fazendo não pode ir junto: a quest
    // órfã volta ao menu. É a mesma regra da rota do painel.
    expect(h.repository.get('do-npc')).not.toBeNull();
  });

  it('desce `clear` e um `set` por NPC — e só quando muda', async () => {
    h.repository.createNpc('velho', {
      serverId: 'pvp1',
      name: 'Velho',
      kind: 'quest',
      x: 1,
      y: 2,
      z: 3,
      rotation: 0,
      prefab: 'assets/prefabs/npc/bandit/shopkeepers/bandit_shopkeeper.prefab',
      mapMarker: true,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });

    const npcSync = sync();

    await npcSync.push('pvp1');
    await npcSync.push('pvp1');

    // O `clear` primeiro: sem ele, um NPC apagado no painel ficaria
    // no mundo para sempre.
    expect(h.sent[0]).toBe('origemz.quest.npc.clear');
    expect(h.sent[1]).toContain('origemz.quest.npc.set');
    // A segunda rodada não repete: o mundo já está igual ao banco.
    expect(h.sent).toHaveLength(2);
  });

  it('o USE abre a tela DAQUELE NPC, e por um relógio', async () => {
    h.repository.createNpc('velho', {
      serverId: 'pvp1',
      name: 'Velho',
      kind: 'quest',
      x: 1,
      y: 2,
      z: 3,
      rotation: 0,
      prefab: 'p',
      mapMarker: false,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });

    const opened: { serverId: string; steamId: string; screenId: string }[] = [];

    sync((input) => {
      opened.push(input);

      return Promise.resolve();
    }).handleLine('pvp1', npcLine({ kind: 'use', steamId: FULANO, npcId: 'velho' }));

    // Nenhum comando sai da pilha do gancho de console: o laço de
    // RCON que este projeto já viveu.
    expect(opened).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(opened[0]).toMatchObject({
      serverId: 'pvp1',
      steamId: FULANO,
      screenId: 'tela-missoes:npc:velho',
    });
  });

  it('o USE num NPC de OUTRO servidor não abre nada', async () => {
    h.repository.createNpc('velho', {
      serverId: 'pvp1',
      name: 'Velho',
      kind: 'quest',
      x: 1,
      y: 2,
      z: 3,
      rotation: 0,
      prefab: 'p',
      mapMarker: false,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });

    const opened: unknown[] = [];

    // É a conferência que a ida a mais paga: uma linha forjada não
    // abre a tela de outro mundo.
    sync((input) => {
      opened.push(input);

      return Promise.resolve();
    }).handleLine('pvp2', npcLine({ kind: 'use', steamId: FULANO, npcId: 'velho' }));

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(opened).toEqual([]);
  });

  it('o segredo errado e a linha torta são ignorados em silêncio', () => {
    expect(parseNpcLine(`${NPC_MARKER}{"contract":1,"secret":"chutei","kind":"use"}`, SECRET)).toBeNull();
    expect(parseNpcLine(`${NPC_MARKER}{quebrado`, SECRET)).toBeNull();
    expect(parseNpcLine('[CHAT] Fulano: oi', SECRET)).toBeNull();
    // Sem nome, não vira NPC: um boneco sem nome no mapa não diz
    // nada a ninguém.
    expect(
      parseNpcLine(npcLine({ kind: 'add', name: '  ', x: 1, y: 1, z: 1, rotation: 0 }), SECRET),
    ).toBeNull();
  });

  it('dois NPCs com o mesmo nome ganham sufixo', () => {
    const npcSync = sync();
    const line = npcLine({ kind: 'add', name: 'Velho', x: 1, y: 1, z: 1, rotation: 0 });

    npcSync.handleLine('pvp1', line);
    npcSync.handleLine('pvp1', line);

    expect(h.repository.getNpc('velho')).not.toBeNull();
    expect(h.repository.getNpc('velho-2')).not.toBeNull();
  });
});

// ------------------------------------------------------------
//  A ENTREGA
// ------------------------------------------------------------

describe('a quest de entrega', () => {
  const ORIGEM = { x: 100, z: 200 };
  const DESTINO = { x: 400, z: 600 };

  function npc(id: string, x: number, z: number, serverId = 'pvp1') {
    h.repository.createNpc(id, {
      serverId,
      name: id,
      kind: 'quest',
      x,
      y: 10,
      z,
      rotation: 0,
      prefab: 'p',
      mapMarker: false,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });
  }

  async function entrega(): Promise<number> {
    npc('outpost', ORIGEM.x, ORIGEM.z);
    npc('bandit', DESTINO.x, DESTINO.z);

    h.repository.create(
      'correio',
      questInputSchema.parse({
        title: 'Correio',
        npcId: 'outpost',
        objectives: [{ seq: 0, kind: 'deliver', target: 'bandit', amount: 1 }],
        rewards: [{ kind: 'coins', perMeter: 0.5, min: 50, max: 2000 }],
      }),
    );

    // A quest tem NPC de origem, e desde 11/09/2026 quem tem NPC só
    // se pega no balcão. Aqui o jogador falou com ele.
    h.service.noteNpcTalk({ serverId: 'pvp1', steamId: FULANO, npcId: 'outpost' });

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'correio',
    });

    return view.playerQuestId;
  }

  function deliverPush(pq: number, npcId: string, meters = 40_000): string {
    return `${QUEST_EVENT_MARKER}${JSON.stringify({
      contract: 1,
      secret: SECRET,
      eventId: `${String(pq)}:deliver:${npcId}`,
      kind: 'deliver',
      steamId: FULANO,
      pq,
      npcId,
      meters,
    })}`;
  }

  it('o pacote no NPC certo conclui a missão', async () => {
    const pq = await entrega();
    const events = new QuestEvents({ service: h.service, logger, secret: SECRET });

    expect(events.handleLine('pvp1', deliverPush(pq, 'bandit'))).toBe(true);

    // A entrega é o único objetivo que não CONTA: ela marca.
    expect(h.repository.attempt(pq)?.progress[0]).toBe(1);
    expect(h.repository.attempt(pq)?.status).toBe('completed');

    events.stop();
  });

  it('o pacote no NPC ERRADO não marca nada', async () => {
    const pq = await entrega();

    npc('outro', 900, 900);

    const events = new QuestEvents({ service: h.service, logger, secret: SECRET });

    // O jogador apertou USE num NPC que é destino de outra missão.
    // Não é erro — e não pode fechar esta.
    events.handleLine('pvp1', deliverPush(pq, 'outro'));

    expect(h.repository.attempt(pq)?.status).toBe('active');
    expect(h.repository.attempt(pq)?.progress[0]).toBe(0);

    events.stop();
  });

  it('entregar duas vezes conta uma', async () => {
    const pq = await entrega();
    const events = new QuestEvents({ service: h.service, logger, secret: SECRET });

    events.handleLine('pvp1', deliverPush(pq, 'bandit'));
    events.handleLine('pvp1', deliverPush(pq, 'bandit'));

    expect(h.repository.attempt(pq)?.progress[0]).toBe(1);
    expect(h.repository.events({ kind: 'progress' })).toHaveLength(1);

    events.stop();
  });

  it('um `meters` absurdo NÃO impede a entrega', async () => {
    const pq = await entrega();
    const events = new QuestEvents({ service: h.service, logger, secret: SECRET });

    // 40 km é maior que qualquer mapa do Rust. Um campo que o
    // agente IGNORA não pode ter poder de veto sobre o que ele usa:
    // sem o `.catch()` do schema, o push inteiro era recusado e a
    // entrega simplesmente não acontecia.
    events.handleLine('pvp1', deliverPush(pq, 'bandit', 40_000));

    expect(h.repository.attempt(pq)?.status).toBe('completed');

    events.stop();
  });

  it('a distância é MEDIDA pelo agente, e o `meters` do plugin é ignorado', async () => {
    const pq = await entrega();

    // 300 no X, 400 no Z: o triângulo 3-4-5, e a hipotenusa é 500.
    // O push dizia 40.000 m — um cliente adulterado seria pago por
    // 40 km.
    expect(h.service.deliveryDistanceOf(pq)).toBe(500);
  });

  it('a recompensa por metro usa a distância medida', async () => {
    const pq = await entrega();
    const paid: (number | undefined)[] = [];

    const service = new QuestsService({
      repository: h.repository,
      logger,
      rewards: {
        deliver: (input: { distanceMeters?: number; rewards: readonly unknown[] }) => {
          paid.push(input.distanceMeters);

          return Promise.resolve(
            input.rewards.map(() => ({ kind: 'coins' as const, ok: true, code: null, message: 'ok' })),
          );
        },
      } as never,
    });

    h.repository.setProgress(pq, 0, 1);
    service.reportCompletion({ playerQuestId: pq });
    await service.claim({ playerQuestId: pq });

    // 500 m, e não os 40.000 que o plugin mandou.
    expect(paid).toEqual([500]);
  });

  it('sem o NPC de origem, a distância é `null` — e a recompensa FALHA', async () => {
    const pq = await entrega();

    // O admin apagou o NPC de origem depois de a missão começar.
    h.repository.removeNpc('outpost');

    // `null` e não zero: pagar zero em silêncio faria a missão
    // aparecer como entregue sem o jogador ter o que reclamar.
    expect(h.service.deliveryDistanceOf(pq)).toBeNull();
  });

  it('a missão que não é de entrega não tem distância', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    expect(h.service.deliveryDistanceOf(view.playerQuestId)).toBeNull();
  });
});

// ------------------------------------------------------------
//  O QUE O JOGADOR PERSEGUE
// ------------------------------------------------------------

describe('o `assign`', () => {
  it('desce para quem está online — sem ele o plugin não conta NADA', async () => {
    h.repository.create('minerador', quest());

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    h.online = [FULANO];
    await collector().sweep();

    const assign = h.sent.find((command) => command.startsWith('origemz.quest.assign'));

    expect(assign, 'o assign não saiu: o plugin nunca saberia o que contar').toBeDefined();

    const payload = JSON.parse(
      Buffer.from((assign ?? '').split(' ')[2] as string, 'base64').toString('utf8'),
    ) as { quests: { pq: number; objectives: { kind: string; target: string; need: number }[] }[] };

    expect(payload.quests).toHaveLength(1);
    expect(payload.quests[0]?.pq).toBe(view.playerQuestId);
    expect(payload.quests[0]?.objectives[0]).toMatchObject({
      kind: 'gather',
      target: 'sulfur.ore',
      need: 5000,
    });
  });

  it('não repete o mesmo `assign` a cada rodada', async () => {
    h.repository.create('minerador', quest());
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    h.online = [FULANO];

    const sweeper = collector();

    await sweeper.sweep();
    h.now += 120_000;
    await sweeper.sweep();

    // Num servidor de 150 jogadores, repetir seria 150 comandos de
    // RCON por rodada para dizer o que já foi dito.
    expect(h.sent.filter((command) => command.startsWith('origemz.quest.assign'))).toHaveLength(1);
  });

  it('NÃO manda o que o plugin não tem como contar', async () => {
    h.repository.create(
      'presenca',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 60 }] }),
    );
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'presenca' });

    h.online = [FULANO];
    await collector().sweep();

    const assign = h.sent.find((command) => command.startsWith('origemz.quest.assign'));
    const payload = JSON.parse(
      Buffer.from((assign ?? '').split(' ')[2] as string, 'base64').toString('utf8'),
    ) as { quests: unknown[] };

    // Pedir ao plugin que conte tempo online seria pedir o que ele
    // não sabe. A missão existe, conta e conclui — só não passa por
    // lá.
    expect(payload.quests).toEqual([]);
  });

  it('quem saiu é esquecido no plugin', async () => {
    h.repository.create('minerador', quest());
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    h.online = [FULANO];

    const sweeper = collector();

    await sweeper.sweep();

    h.online = [];
    h.now += 120_000;
    await sweeper.sweep();

    expect(h.sent).toContain(`origemz.quest.forget ${FULANO}`);
  });

  it('a missão automática abre e desce na MESMA rodada', async () => {
    h.repository.create('diaria', quest({ autoAccept: true }));

    h.online = [FULANO];
    await collector().sweep();

    // Inverter a ordem faria a diária de hoje só chegar ao plugin na
    // rodada seguinte — quinze segundos em que minerar não contava.
    expect(h.repository.liveCountFor('pvp1', FULANO)).toBe(1);
    expect(h.sent.some((command) => command.startsWith('origemz.quest.assign'))).toBe(true);
  });
});

// ------------------------------------------------------------
//  O QUE A MISSÃO COBRA
// ------------------------------------------------------------

describe('o `consume`', () => {
  async function pedido(consumer?: {
    take: () => Promise<{ complete: boolean; missing?: string }>;
  }) {
    h.repository.create(
      'pedido',
      questInputSchema.parse({
        title: 'Pedido de scrap',
        objectives: [{ seq: 0, kind: 'gather', target: 'scrap', amount: 500, consume: true }],
        rewards: [],
      }),
    );

    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: consumer as never,
      rewards: { deliver: () => Promise.resolve([]) } as never,
    });

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'pedido',
    });

    h.repository.setProgress(view.playerQuestId, 0, 500);
    service.reportCompletion({ playerQuestId: view.playerQuestId });

    return { service, playerQuestId: view.playerQuestId };
  }

  it('tira os itens ANTES do prêmio', async () => {
    const taken: unknown[] = [];
    const { service, playerQuestId } = await pedido({
      take: (...args: unknown[]) => {
        taken.push(args[0]);

        return Promise.resolve({ complete: true });
      },
    } as never);

    await service.claim({ playerQuestId });

    expect(taken[0]).toMatchObject({
      steamId: FULANO,
      items: [{ shortname: 'scrap', amount: 500 }],
    });
    expect(h.repository.attempt(playerQuestId)?.status).toBe('claimed');
  });

  it('faltou item: o resgate PARA, e a missão continua pronta', async () => {
    const { service, playerQuestId } = await pedido({
      take: () => Promise.resolve({ complete: false, missing: 'Faltam 200 de scrap.' }),
    });

    await expect(service.claim({ playerQuestId })).rejects.toMatchObject({
      code: 'QUEST_CONSUME_INCOMPLETE',
    });

    // Entregar o prêmio sem cobrar o material daria os dois.
    expect(h.repository.attempt(playerQuestId)?.status).toBe('completed');
  });

  it('sem quem recolha, o resgate falha em vez de dar os dois', async () => {
    const { service, playerQuestId } = await pedido(undefined);

    await expect(service.claim({ playerQuestId })).rejects.toMatchObject({
      code: 'QUEST_CONSUME_UNAVAILABLE',
    });
    expect(h.repository.attempt(playerQuestId)?.status).toBe('completed');
  });

  it('missão SEM `consume` não chama ninguém', async () => {
    h.repository.create('minerador', quest());

    const take = vi.fn(() => Promise.resolve({ complete: true }));
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: { take } as never,
      rewards: { deliver: () => Promise.resolve([]) } as never,
    });

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    h.repository.setProgress(view.playerQuestId, 0, 5000);
    service.reportCompletion({ playerQuestId: view.playerQuestId });
    await service.claim({ playerQuestId: view.playerQuestId });

    expect(take).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
//  O PLUGIN QUE ESQUECEU
// ------------------------------------------------------------

describe('o `#OZAREQ#quests`', () => {
  it('faz o catálogo e o `assign` voltarem, mesmo já tendo sido mandados', async () => {
    h.repository.create('minerador', quest());
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    h.online = [FULANO];

    const sweeper = collector();

    await sweeper.sweep();

    const antes = h.sent.length;

    // Um `oxide.reload` esvaziou o cache do plugin SEM derrubar o
    // RCON — para o agente, nada aconteceu. Sem este grito, nada
    // seria contado até o jogador aceitar uma missão nova.
    expect(sweeper.handleLine('pvp1', '#OZAREQ#quests')).toBe(true);

    h.now += 120_000;
    await sweeper.sweep();

    expect(h.sent.length).toBeGreaterThan(antes);
    expect(
      h.sent.slice(antes).some((command) => command.startsWith('origemz.quest.watch')),
    ).toBe(true);
    expect(
      h.sent.slice(antes).some((command) => command.startsWith('origemz.quest.assign')),
    ).toBe(true);
  });

  it('a linha que não é o pedido passa direto', () => {
    const sweeper = collector();

    expect(sweeper.handleLine('pvp1', '#OZAREQ#items')).toBe(false);
    expect(sweeper.handleLine('pvp1', '[CHAT] Fulano: oi')).toBe(false);
  });
});
