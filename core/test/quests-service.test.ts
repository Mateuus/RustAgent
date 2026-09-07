// ============================================================
//  quests-service.test.ts  -  as REGRAS das quests.
//
//  O que este arquivo guarda:
//
//    1. a AUTORIDADE é do agente. O push do plugin que diz "fechou"
//       sem o número para sustentá-lo não conclui nada — sem isso,
//       um `oxide.reload` no meio do lote daria a recompensa a
//       partir de um contador esvaziado;
//    2. quem já tinha 4.000 abates NÃO conclui "mate 20" no
//       instante em que aceita. É a linha de partida do snapshot,
//       e é o defeito mais fácil de introduzir no módulo inteiro;
//    3. a tela e a rota concordam: o `accept` recusa exatamente o
//       que a lista mostrou como bloqueado;
//    4. o resgate marca ANTES de entregar, e a entrega que falha
//       não desfaz o resgate — vira pendência com dono e código;
//    5. a cadeia exige `claimed`, e não `completed`: parar antes do
//       resgate destravaria a próxima sem receber a anterior;
//    6. o cooldown vem da quest de HOJE, e o objetivo vem do
//       snapshot. São coisas diferentes de propósito;
//    7. a virada da diária conta dias de CALENDÁRIO — somar 24 h
//       erra na semana do horário de verão, uma hora numa direção
//       que ninguém percebe.
//
//  Banco em memória com as migrações reais, como no repositório: as
//  promessas que valem são as que sobrevivem ao SQL de verdade.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { createLogger } from '../src/logger.js';
import { isApiError } from '../src/http/error-response.js';
import {
  humanDelay,
  nextReset,
  QuestsService,
  type QuestStatsSource,
} from '../src/quests/service.js';
import type { DeliverRewardsInput, RewardOutcome } from '../src/quests/rewards.js';
import { questInputSchema, type QuestDraft, type QuestInput } from '../src/types/quests.js';

const NOW = 1_757_000_000_000;
const FULANO = '76561198000000001';

const logger = createLogger({ log: { level: 'silent', pretty: false } });

/** Um `stats` que o teste controla, métrica a métrica. */
class FakeStats implements QuestStatsSource {
  readonly totals = new Map<string, number>();

  totalOf(serverId: string, steamId: string, metric: string): number {
    return this.totals.get(`${serverId}:${steamId}:${metric}`) ?? 0;
  }

  set(metric: string, value: number, serverId = 'pvp1', steamId = FULANO): void {
    this.totals.set(`${serverId}:${steamId}:${metric}`, value);
  }
}

/** Um entregador que registra o que lhe pediram e obedece ao roteiro. */
class FakeRewards {
  readonly calls: DeliverRewardsInput[] = [];
  outcome: (input: DeliverRewardsInput) => readonly RewardOutcome[] = (input) =>
    input.rewards.map((reward) => ({ kind: reward.kind, ok: true, code: null, message: 'ok' }));

  deliver(input: DeliverRewardsInput): Promise<readonly RewardOutcome[]> {
    this.calls.push(input);

    return Promise.resolve(this.outcome(input));
  }
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: QuestsRepository;
  readonly stats: FakeStats;
  readonly rewards: FakeRewards;
  service: QuestsService;
  now: number;
}

let h: Harness;

function quest(overrides: Partial<QuestDraft> = {}): QuestInput {
  return questInputSchema.parse({
    title: 'Minerador',
    category: 'diaria',
    objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 5000 }],
    rewards: [{ kind: 'coins', amount: 500 }],
    ...overrides,
  });
}

/** Monta o serviço com as dependências que aquele teste quer. */
function build(options: {
  readonly permissions?: { can: () => boolean | Promise<boolean> };
  readonly stats?: QuestStatsSource;
  readonly rewards?: FakeRewards | undefined;
  readonly items?: { displayNameOf: (shortname: string) => string | null };
} = {}): QuestsService {
  return new QuestsService({
    repository: h.repository,
    logger,
    stats: options.stats ?? h.stats,
    rewards: 'rewards' in options ? (options.rewards as never) : (h.rewards as never),
    permissions: options.permissions,
    items: options.items,
    now: () => h.now,
  });
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

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

  h = {
    db,
    repository: new QuestsRepository(db),
    stats: new FakeStats(),
    rewards: new FakeRewards(),
    service: undefined as never,
    now: NOW,
  };

  h.service = build();
});

/** Aceita e devolve o id da tentativa. */
async function accept(questId = 'minerador', serverId = 'pvp1'): Promise<number> {
  const view = await h.service.accept({ serverId, steamId: FULANO, questId });

  return view.playerQuestId;
}

function bump(playerQuestId: number, delta: number, seq = 0, batchId = `b${String(Math.random())}`) {
  return h.service.applyBatch({
    serverId: 'pvp1',
    batchId,
    entries: [{ playerQuestId, objectiveSeq: seq, delta }],
  });
}

// ------------------------------------------------------------
//  A autoridade
// ------------------------------------------------------------

describe('a autoridade é do agente, e não do plugin', () => {
  beforeEach(() => {
    h.repository.create('minerador', quest(), NOW);
  });

  it('o push sem o número para sustentá-lo não conclui nada', async () => {
    const id = await accept();

    bump(id, 100);

    // Um `oxide.reload` esvaziou o cache do plugin e ele fechou com
    // um contador incompleto. Confiar nele daria a recompensa.
    expect(h.service.reportCompletion({ playerQuestId: id })).toBe(false);
    expect(h.repository.attempt(id)?.status).toBe('active');
  });

  it('o push com o número conclui, e a segunda chegada não reescreve a hora', async () => {
    const id = await accept();

    bump(id, 5000);
    h.now = NOW + 100;

    // O lote já concluiu junto com a aplicação; o push chega depois
    // e encontra o serviço feito. É o caso NORMAL deste desenho.
    expect(h.repository.attempt(id)?.status).toBe('completed');

    h.now = NOW + 9999;

    expect(h.service.reportCompletion({ playerQuestId: id })).toBe(false);
    expect(h.repository.attempt(id)?.completedAt).toBe(NOW);
  });

  it('o lote conclui o que fechou, sem esperar o push', async () => {
    const id = await accept();

    expect(bump(id, 4999).completed).toBe(0);
    expect(bump(id, 1).completed).toBe(1);
    expect(h.repository.attempt(id)?.status).toBe('completed');
  });

  it('o lote repetido não conclui duas vezes', async () => {
    const id = await accept();

    expect(bump(id, 5000, 0, 'mesmo').completed).toBe(1);
    expect(bump(id, 5000, 0, 'mesmo')).toEqual({ applied: false, completed: 0 });
  });

  it('com dois objetivos, só fecha quando os DOIS fecham', async () => {
    h.repository.create(
      'combo',
      quest({
        objectives: [
          { seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 100 },
          { seq: 1, kind: 'kill', target: 'scientist', amount: 5 },
        ],
      }),
      NOW,
    );

    const id = await accept('combo');

    bump(id, 100, 0);
    expect(h.repository.attempt(id)?.status).toBe('active');

    bump(id, 5, 1);
    expect(h.repository.attempt(id)?.status).toBe('completed');
  });
});

// ------------------------------------------------------------
//  A linha de partida
// ------------------------------------------------------------

describe('os objetivos que o plugin não conta', () => {
  it('quem já tinha 4.000 abates NÃO conclui "mate 20" ao aceitar', async () => {
    h.stats.set('pvp.kills', 4000);
    h.repository.create(
      'cacador',
      quest({ objectives: [{ seq: 0, kind: 'metric', metric: 'pvp.kills', amount: 20 }] }),
      NOW,
    );

    const id = await accept('cacador');

    // Sem a linha de partida no snapshot, o total acumulado faria a
    // quest concluir no instante do aceite. É o defeito mais fácil
    // de introduzir no módulo inteiro.
    expect(h.repository.attempt(id)?.snapshot.baselines).toEqual({ 0: 4000 });
    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]).toMatchObject(
      { have: 0, need: 20, done: false },
    );
  });

  it('o progresso é a subtração, e a quest fecha ao chegar lá', async () => {
    h.stats.set('pvp.kills', 4000);
    h.repository.create(
      'cacador',
      quest({ objectives: [{ seq: 0, kind: 'metric', metric: 'pvp.kills', amount: 20 }] }),
      NOW,
    );

    const id = await accept('cacador');

    h.stats.set('pvp.kills', 4012);
    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(12);

    h.stats.set('pvp.kills', 4020);
    h.service.liveFor({ serverId: 'pvp1', steamId: FULANO });
    h.service.reportCompletion({ playerQuestId: id });

    expect(h.repository.attempt(id)?.status).toBe('completed');
  });

  it('o progresso nunca anda para trás quando o admin zera o ranking', async () => {
    h.stats.set('pvp.kills', 4000);
    h.repository.create(
      'cacador',
      quest({ objectives: [{ seq: 0, kind: 'metric', metric: 'pvp.kills', amount: 20 }] }),
      NOW,
    );

    await accept('cacador');
    h.stats.set('pvp.kills', 0);

    // A subtração daria -4.000. O progresso PARA de andar, e é
    // isso que se quer: nunca um número negativo na tela.
    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(0);
  });

  it('`playtime` converte segundos em minutos num lugar só', async () => {
    h.stats.set('time.played', 3600);
    h.repository.create(
      'presenca',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 60 }] }),
      NOW,
    );

    const id = await accept('presenca');

    // `time.played` é em SEGUNDOS (rankings/collector.ts); o
    // objetivo é em minutos, que é o que o admin digita no painel.
    h.stats.set('time.played', 3600 + 1800);
    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(30);

    h.stats.set('time.played', 3600 + 3600);
    h.service.liveFor({ serverId: 'pvp1', steamId: FULANO });
    h.service.reportCompletion({ playerQuestId: id });

    expect(h.repository.attempt(id)?.status).toBe('completed');
  });

  it('sem `stats`, os derivados ficam parados em vez de derrubar a leitura', async () => {
    h.repository.create(
      'presenca',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 60 }] }),
      NOW,
    );

    const service = new QuestsService({ repository: h.repository, logger, now: () => h.now });

    await service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'presenca' });

    expect(service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(0);
  });
});

// ------------------------------------------------------------
//  A disponibilidade
// ------------------------------------------------------------

describe('quem pode pegar o quê', () => {
  it('a tela e a rota concordam: o que a lista bloqueia, o `accept` recusa', async () => {
    h.repository.create('uma-vez', quest({ repeatMode: 'once' }), NOW);

    const id = await accept('uma-vez');

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    const offer = (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).find(
      (item) => item.quest.id === 'uma-vez',
    );

    expect(offer?.block?.code).toBe('QUEST_ONCE_ONLY');

    // Uma tela que oferece o botão e uma rota que recusa é o pior
    // desencontro possível — é a lição que o KitsService documenta.
    try {
      await accept('uma-vez');
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('QUEST_ONCE_ONLY');
    }
  });

  it('a quest em andamento sai da lista das disponíveis', async () => {
    h.repository.create('minerador', quest(), NOW);
    await accept();

    // Aparecer nas duas abas daria dois botões para a mesma coisa,
    // e um deles recusaria.
    expect(await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).toEqual([]);
  });

  it('a cadeia exige `claimed`, e não `completed`', async () => {
    h.repository.create('primeira', quest({ title: 'Boas-vindas' }), NOW);
    h.repository.create('segunda', quest({ requiresQuest: 'primeira' }), NOW);

    const first = await accept('primeira');

    bump(first, 5000);
    expect(h.repository.attempt(first)?.status).toBe('completed');

    // Parar em `completed` destravaria a próxima sem receber a
    // recompensa da anterior — e o jogador voltaria para pegá-la
    // depois, fora de ordem.
    const blocked = (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).find(
      (item) => item.quest.id === 'segunda',
    );

    expect(blocked?.block).toMatchObject({ code: 'QUEST_NEEDS_PREVIOUS' });
    expect(blocked?.block?.reason).toContain('Boas-vindas');

    await h.service.claim({ playerQuestId: first });

    const freed = (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).find(
      (item) => item.quest.id === 'segunda',
    );

    expect(freed?.block).toBeNull();
  });

  it('o cooldown segura, e o relógio solta', async () => {
    h.repository.create(
      'diaria',
      quest({ repeatMode: 'cooldown', cooldownSeconds: 3600 }),
      NOW,
    );

    const id = await accept('diaria');

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    const blocked = (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0];

    expect(blocked?.block?.code).toBe('QUEST_ON_COOLDOWN');
    expect(blocked?.block?.reason).toContain('1h');
    expect(blocked?.availableAt).toBe(NOW + 3_600_000);

    h.now = NOW + 3_600_001;

    expect((await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block).toBeNull();
  });

  it('o teto conta só as vivas, e é por servidor', async () => {
    h.repository.saveSettings(
      'pvp1',
      { maxActive: 1, enabled: true, flushSeconds: 60, lootEnabled: true, resetAtMinute: 0 },
      NOW,
    );
    h.repository.create('a', quest(), NOW);
    h.repository.create('b', quest({ title: 'B' }), NOW);

    const first = await accept('a');

    expect(
      (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block?.code,
    ).toBe('QUEST_LIMIT_REACHED');

    // O mesmo jogador noutro mundo começa do zero.
    expect((await h.service.offersFor({ serverId: 'pvp2', steamId: FULANO }))[0]?.block).toBeNull();

    h.service.cancel({ playerQuestId: first });

    expect((await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block).toBeNull();
  });

  it('o cooldown é dito ANTES do teto — a frase mais útil ganha', async () => {
    h.repository.saveSettings(
      'pvp1',
      { maxActive: 1, enabled: true, flushSeconds: 60, lootEnabled: true, resetAtMinute: 0 },
      NOW,
    );
    h.repository.create('feita', quest({ repeatMode: 'cooldown', cooldownSeconds: 3600 }), NOW);
    h.repository.create('outra', quest({ title: 'Outra' }), NOW);

    const done = await accept('feita');

    bump(done, 5000);
    await h.service.claim({ playerQuestId: done });

    // Agora ele tem uma ativa ('outra' não; vamos abrir uma) e a
    // 'feita' em cooldown.
    await accept('outra');

    const offer = (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).find(
      (item) => item.quest.id === 'feita',
    );

    // "Você está no limite" sobre uma quest que ele nem poderia
    // pegar esconde o motivo de verdade.
    expect(offer?.block?.code).toBe('QUEST_ON_COOLDOWN');
  });

  it('sem quem confira o `requires`, a quest fica trancada — nunca aberta', async () => {
    h.repository.create('vip', quest({ requires: 'vip:ouro' }), NOW);

    const offer = (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0];

    // Liberar o que não se sabe conferir entregaria a quest de VIP
    // para todo mundo.
    expect(offer?.block?.code).toBe('QUEST_LOCKED');

    const permissive = build({ permissions: { can: () => true } });

    expect((await permissive.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block).toBeNull();
  });

  it('a janela de evento abre e fecha', async () => {
    h.repository.create(
      'natal',
      quest({ availableFrom: NOW + 1000, availableTo: NOW + 5000 }),
      NOW,
    );

    expect((await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block?.code).toBe(
      'QUEST_NOT_YET',
    );

    h.now = NOW + 2000;
    expect((await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block).toBeNull();

    h.now = NOW + 5000;
    expect((await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block?.code).toBe(
      'QUEST_EXPIRED',
    );
  });

  it('a lista do menu não traz as do NPC, e vice-versa', async () => {
    h.repository.createNpc(
      'velho',
      {
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
      },
      NOW,
    );
    h.repository.create('no-menu', quest(), NOW);
    h.repository.create('no-npc', quest({ title: 'No NPC', npcId: 'velho' }), NOW);

    expect(
      (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).map((i) => i.quest.id),
    ).toEqual(['no-menu']);

    expect(
      (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO, npcId: 'velho' })).map(
        (i) => i.quest.id,
      ),
    ).toEqual(['no-npc']);
  });

  it('o módulo desligado no servidor não oferece nada', async () => {
    h.repository.create('minerador', quest(), NOW);
    h.repository.saveSettings(
      'pvp1',
      { maxActive: 0, enabled: false, flushSeconds: 60, lootEnabled: true, resetAtMinute: 0 },
      NOW,
    );

    expect(await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).toEqual([]);
  });

  it('o `force` do painel passa por cima do bloqueio, mas não da duplicata', async () => {
    h.repository.create('uma-vez', quest({ repeatMode: 'once' }), NOW);

    const id = await accept('uma-vez');

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    // O suporte concede a quem não poderia pegá-la.
    await expect(
      h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'uma-vez', force: true }),
    ).resolves.toMatchObject({ questId: 'uma-vez' });

    // Mas a trava de integridade continua: dois contadores
    // paralelos da mesma coisa não.
    try {
      await h.service.accept({
        serverId: 'pvp1',
        steamId: FULANO,
        questId: 'uma-vez',
        force: true,
      });
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('QUEST_ALREADY_ACTIVE');
    }
  });
});

// ------------------------------------------------------------
//  O resgate
// ------------------------------------------------------------

describe('o resgate', () => {
  beforeEach(() => {
    h.repository.create('minerador', quest(), NOW);
  });

  it('recusa antes da conclusão', async () => {
    const id = await accept();

    await expect(h.service.claim({ playerQuestId: id })).rejects.toMatchObject({
      code: 'QUEST_NOT_COMPLETE',
    });
  });

  it('conclui na hora se ele fechou entre o último lote e o clique', async () => {
    h.stats.set('pvp.kills', 0);
    h.repository.create(
      'cacador',
      quest({ objectives: [{ seq: 0, kind: 'metric', metric: 'pvp.kills', amount: 5 }] }),
      NOW,
    );

    const id = await accept('cacador');

    h.stats.set('pvp.kills', 5);

    // Sem esta última chance, ele veria a barra cheia e o botão
    // recusando.
    await expect(h.service.claim({ playerQuestId: id })).resolves.toMatchObject({ pending: false });
  });

  it('entrega o que o snapshot prometeu, e só uma vez', async () => {
    const id = await accept();

    bump(id, 5000);

    const result = await h.service.claim({ playerQuestId: id });

    expect(result.pending).toBe(false);
    expect(h.rewards.calls).toHaveLength(1);
    expect(h.rewards.calls[0]?.rewards[0]).toMatchObject({ kind: 'coins', amount: 500 });

    await expect(h.service.claim({ playerQuestId: id })).rejects.toMatchObject({
      code: 'QUEST_ALREADY_CLAIMED',
    });
    expect(h.rewards.calls).toHaveLength(1);
  });

  it('a entrega que falha NÃO desfaz o resgate — vira pendência com código', async () => {
    const id = await accept();

    bump(id, 5000);
    h.rewards.outcome = () => [
      { kind: 'coins', ok: false, code: 'WALLET_UNKNOWN', message: 'sem resposta da carteira' },
    ];

    const result = await h.service.claim({ playerQuestId: id });

    // Entregar e depois marcar daria, numa queda no meio, um
    // jogador que recebeu duas vezes. Assim dá um jogador que
    // precisa de um clique do admin — e o painel mostra quem.
    expect(result.pending).toBe(true);
    expect(h.repository.attempt(id)?.status).toBe('claimed');

    const failures = h.repository.events({ kind: 'reward_failed' });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toMatchObject({ code: 'WALLET_UNKNOWN' });
  });

  it('uma pendência por recompensa, e não uma por resgate', async () => {
    h.repository.create(
      'multi',
      quest({
        rewards: [
          { kind: 'coins', amount: 100 },
          { kind: 'kit', slug: 'starter' },
        ],
      }),
      NOW,
    );

    const id = await accept('multi');

    bump(id, 5000);
    h.rewards.outcome = () => [
      { kind: 'coins', ok: true, code: null, message: 'ok' },
      { kind: 'kit', ok: false, code: 'KIT_NOT_FOUND', message: 'sumiu' },
    ];

    await h.service.claim({ playerQuestId: id });

    // "O kit falhou" e "os coins falharam" são pendências
    // diferentes, e o painel reentrega o que precisa.
    expect(h.repository.events({ kind: 'reward_failed' })).toHaveLength(1);
  });

  it('sem entregador, a quest fica resgatada e a recompensa vira pendência', async () => {
    const service = build({ rewards: undefined });
    const id = (await service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' }))
      .playerQuestId;

    bump(id, 5000);

    const result = await service.claim({ playerQuestId: id });

    expect(result.pending).toBe(true);
    expect(result.outcomes[0]?.code).toBe('QUEST_REWARD_UNAVAILABLE');
    expect(h.repository.attempt(id)?.status).toBe('claimed');
  });

  it('a reentrega só vale em quest já resgatada', async () => {
    const id = await accept();

    await expect(h.service.retryRewards({ playerQuestId: id, actor: 'dono' })).rejects.toMatchObject(
      { code: 'QUEST_NOT_CLAIMED' },
    );

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    await expect(
      h.service.retryRewards({ playerQuestId: id, actor: 'dono' }),
    ).resolves.toMatchObject({ pending: false });
    expect(h.rewards.calls).toHaveLength(2);
  });

  it('o cooldown vem da quest de HOJE, e o objetivo vem do snapshot', async () => {
    h.repository.create('editavel', quest({ repeatMode: 'cooldown', cooldownSeconds: 60 }), NOW);

    const id = await accept('editavel');

    // O admin muda as duas coisas depois do aceite.
    h.repository.update(
      'editavel',
      quest({
        repeatMode: 'cooldown',
        cooldownSeconds: 7200,
        objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 999_999 }],
      }),
      NOW,
    );

    // O objetivo é o contrato com quem já aceitou: 5.000.
    bump(id, 5000);
    expect(h.repository.attempt(id)?.status).toBe('completed');

    await h.service.claim({ playerQuestId: id });

    // Quando ela volta é decisão de operação, e vale para todos.
    expect(h.repository.attempt(id)?.cooldownUntil).toBe(NOW + 7_200_000);
  });

  it('quest apagada no meio: a tentativa vai junto, e o resgate recusa com código legível', async () => {
    const id = await accept();

    bump(id, 5000);
    h.db.prepare('DELETE FROM quests WHERE id = ?').run('minerador');

    // A FK de `player_quests` é ON DELETE CASCADE: apagar a quest
    // leva a tentativa e o progresso junto. É por isso que o ramo
    // `quest === null` do `claim` é defesa, e não um caso previsto
    // — o 404 chega antes dele.
    await expect(h.service.claim({ playerQuestId: id })).rejects.toMatchObject({
      code: 'QUEST_ATTEMPT_NOT_FOUND',
    });
  });
});

// ------------------------------------------------------------
//  O cancelamento
// ------------------------------------------------------------

describe('o cancelamento', () => {
  it('registra quem foi, porque a frase do painel depende disso', async () => {
    h.repository.create('minerador', quest(), NOW);

    const id = await accept();

    h.service.cancel({ playerQuestId: id, actor: 'dono', reason: 'pediu no Discord' });

    const events = h.repository.events({ kind: 'abandon' });

    expect(events[0]?.source).toBe('panel');
    expect(events[0]?.actor).toBe('dono');
    expect(events[0]?.detail).toEqual({ reason: 'pediu no Discord' });
  });

  it('sem autor, é o próprio jogador', async () => {
    h.repository.create('minerador', quest(), NOW);
    h.service.cancel({ playerQuestId: await accept() });

    expect(h.repository.events({ kind: 'abandon' })[0]?.source).toBe('agent');
  });

  it('cancelar o que não existe não estoura', () => {
    expect(h.service.cancel({ playerQuestId: 9999 })).toBe(false);
  });
});

// ------------------------------------------------------------
//  A frase
// ------------------------------------------------------------

describe('a frase do objetivo', () => {
  it('usa o nome bonito do catálogo do jogo', () => {
    const service = build({
      items: { displayNameOf: (shortname) => (shortname === 'sulfur.ore' ? 'Minério de Enxofre' : null) },
    });

    expect(
      service.describeObjective({
        seq: 0,
        kind: 'gather',
        target: 'sulfur.ore',
        metric: null,
        amount: 5000,
        label: null,
        consume: false,
      }),
    ).toBe('Coletar 5.000 de Minério de Enxofre');
  });

  it('cai no shortname quando o catálogo não conhece — nunca some', () => {
    expect(
      h.service.describeObjective({
        seq: 0,
        kind: 'kill',
        target: 'scientist',
        metric: null,
        amount: 20,
        label: null,
        consume: false,
      }),
    ).toBe('Matar 20 scientist');
  });

  it('o `label` sobrescreve tudo', () => {
    expect(
      h.service.describeObjective({
        seq: 0,
        kind: 'gather',
        target: 'sulfur.ore',
        metric: null,
        amount: 5000,
        label: 'Encher o baú de enxofre',
        consume: false,
      }),
    ).toBe('Encher o baú de enxofre');
  });

  it('o contador é capado na tela, e não no banco', async () => {
    h.repository.create('minerador', quest(), NOW);

    const id = await accept();

    // O lote pode trazer 300 de scrap para um objetivo de 250, e
    // "300 / 250" é feio sem ser mais informativo.
    bump(id, 6000);

    const view = h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0];

    expect(view?.objectives[0]).toMatchObject({ have: 5000, need: 5000, done: true });
    expect(h.repository.attempt(id)?.progress[0]).toBe(6000);
  });
});

// ------------------------------------------------------------
//  A aritmética de fuso
// ------------------------------------------------------------

describe('a virada da diária', () => {
  it('conta dias de CALENDÁRIO, e não 24 horas', () => {
    // Somar 86.400.000 erra na semana em que o horário de verão
    // muda, e o erro é de uma hora numa direção que ninguém
    // percebe até a diária virar às 23h ou à 1h.
    const meioDia = new Date(2026, 2, 10, 12, 0, 0, 0).getTime();
    const virada = nextReset(meioDia, 0, 1);
    const esperado = new Date(2026, 2, 11, 0, 0, 0, 0).getTime();

    expect(virada).toBe(esperado);
  });

  it('a virada de hoje ainda não passou: é ela, e não a de amanhã', () => {
    const madrugada = new Date(2026, 2, 10, 1, 0, 0, 0).getTime();
    // Reset às 03:00; ainda vai acontecer hoje.
    const virada = nextReset(madrugada, 180, 1);

    expect(virada).toBe(new Date(2026, 2, 10, 3, 0, 0, 0).getTime());
  });

  it('a virada de hoje já passou: vai para a de amanhã', () => {
    const tarde = new Date(2026, 2, 10, 15, 0, 0, 0).getTime();
    const virada = nextReset(tarde, 180, 1);

    expect(virada).toBe(new Date(2026, 2, 11, 3, 0, 0, 0).getTime());
  });

  it('a semanal anda sete dias', () => {
    const meioDia = new Date(2026, 2, 10, 12, 0, 0, 0).getTime();

    expect(nextReset(meioDia, 0, 7)).toBe(new Date(2026, 2, 17, 0, 0, 0, 0).getTime());
  });

  it('a diária usa o `resetAtMinute` daquele servidor', async () => {
    h.repository.create('diaria', quest({ repeatMode: 'daily' }), NOW);
    h.repository.saveSettings(
      'pvp1',
      { maxActive: 0, enabled: true, flushSeconds: 60, lootEnabled: true, resetAtMinute: 300 },
      NOW,
    );

    const id = await accept('diaria');

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    const until = h.repository.attempt(id)?.cooldownUntil ?? 0;

    expect(new Date(until).getHours()).toBe(5);
    expect(new Date(until).getMinutes()).toBe(0);
    expect(until).toBeGreaterThan(h.now);
  });
});

describe('humanDelay', () => {
  it('dá uma casa só — a tela do jogo tem pouca largura', () => {
    expect(humanDelay(30_000)).toBe('menos de um minuto');
    expect(humanDelay(12 * 60_000)).toBe('12min');
    expect(humanDelay(4 * 3_600_000)).toBe('4h');
    expect(humanDelay(3 * 86_400_000)).toBe('3 dias');
    expect(humanDelay(86_400_000)).toBe('1 dia');
  });
});

// ------------------------------------------------------------
//  O que o serviço registra
// ------------------------------------------------------------

describe('a auditoria que o serviço escreve', () => {
  it('conclusão pelo push carrega o `eventId` do plugin', async () => {
    h.repository.create(
      'cacador',
      quest({ objectives: [{ seq: 0, kind: 'metric', metric: 'pvp.kills', amount: 5 }] }),
      NOW,
    );

    const id = await accept('cacador');

    h.stats.set('pvp.kills', 5);
    h.service.liveFor({ serverId: 'pvp1', steamId: FULANO });

    expect(h.service.reportCompletion({ playerQuestId: id, eventId: 'pvp1-42' })).toBe(true);

    const done = h.repository.events({ kind: 'complete' });

    expect(done).toHaveLength(1);
    expect(done[0]?.eventId).toBe('pvp1-42');
    expect(done[0]?.source).toBe('plugin');
  });

  it('o mesmo `eventId` chegando de novo não vira segunda linha', async () => {
    h.repository.create('minerador', quest(), NOW);

    const id = await accept();

    bump(id, 5000);
    h.service.reportCompletion({ playerQuestId: id, eventId: 'pvp1-42' });
    h.service.reportCompletion({ playerQuestId: id, eventId: 'pvp1-42' });

    expect(h.repository.events({ kind: 'complete' })).toHaveLength(1);
  });
});

// ------------------------------------------------------------
//  O aceite automático
// ------------------------------------------------------------

describe('a quest que se aceita sozinha', () => {
  it('abre no connect, e só as marcadas', async () => {
    h.repository.create('diaria', quest({ autoAccept: true }), NOW);
    h.repository.create('manual', quest({ title: 'Manual' }), NOW);

    const opened = await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO });

    expect(opened.map((item) => item.questId)).toEqual(['diaria']);
  });

  it('chamada duas vezes não abre a mesma duas vezes', async () => {
    h.repository.create('diaria', quest({ autoAccept: true }), NOW);

    await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO });
    const again = await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO });

    // A que já está em andamento sai da lista das disponíveis, e é
    // isso que torna seguro chamar isto em todo `OnPlayerConnected`.
    expect(again).toEqual([]);
    expect(h.repository.liveCountFor('pvp1', FULANO)).toBe(1);
  });

  it('"não precisa clicar" não quer dizer "pode furar a fila"', async () => {
    h.repository.create(
      'diaria',
      quest({ autoAccept: true, repeatMode: 'cooldown', cooldownSeconds: 3600 }),
      NOW,
    );

    const id = await accept('diaria');

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    expect(await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO })).toEqual([]);

    h.now = NOW + 3_600_001;

    expect(await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO })).toHaveLength(1);
  });

  it('não abre quest de NPC — o NPC deixaria de ter função', async () => {
    h.repository.createNpc(
      'velho',
      {
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
      },
      NOW,
    );
    h.repository.create('no-npc', quest({ autoAccept: true, npcId: 'velho' }), NOW);

    expect(await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO })).toEqual([]);
  });

  it('o teto atingido não abre, e não estoura', async () => {
    h.repository.saveSettings(
      'pvp1',
      { maxActive: 1, enabled: true, flushSeconds: 60, lootEnabled: true, resetAtMinute: 0 },
      NOW,
    );
    h.repository.create('a', quest({ autoAccept: true }), NOW);
    h.repository.create('b', quest({ title: 'B', autoAccept: true }), NOW);

    expect(await h.service.autoAcceptFor({ serverId: 'pvp1', steamId: FULANO })).toHaveLength(1);
  });
});

// ------------------------------------------------------------
//  O AVISO DE QUE A LISTA VIVA MUDOU
// ------------------------------------------------------------

describe('o `onLiveChanged`', () => {
  it('avisa no aceite, no cancelamento e no resgate', async () => {
    const avisos: { serverId: string; steamId: string }[] = [];

    const service = new QuestsService({
      repository: h.repository,
      logger,
      rewards: h.rewards as never,
      onLiveChanged: (input) => avisos.push(input),
      now: () => h.now,
    });

    h.repository.create('minerador', quest(), NOW);

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    // Sem este aviso, o plugin só saberia da missão no ciclo
    // seguinte do coletor — quinze segundos em que o jogador
    // aceitou, foi minerar, e nada contou.
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toEqual({ serverId: 'pvp1', steamId: FULANO });

    h.repository.setProgress(view.playerQuestId, 0, 5000);
    service.reportCompletion({ playerQuestId: view.playerQuestId });
    await service.claim({ playerQuestId: view.playerQuestId });

    // No resgate também: a missão sai da lista viva, e o plugin
    // precisa parar de contar para ela.
    expect(avisos).toHaveLength(2);

    // Uma quest DIFERENTE: a de cima é `once`, e resgatada não
    // volta — que é justamente o que os testes de cooldown provam.
    h.repository.create('segunda', quest({ title: 'Segunda' }), NOW);

    const outra = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'segunda',
    });

    service.cancel({ playerQuestId: outra.playerQuestId });

    expect(avisos).toHaveLength(4);
  });

  it('sem o aviso montado, nada quebra', async () => {
    h.repository.create('minerador', quest(), NOW);

    await expect(accept()).resolves.toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------
//  O NPC QUE SUMIU
// ------------------------------------------------------------

describe('a quest órfã', () => {
  function npc(id: string, kind: 'quest' | 'delivery' = 'quest') {
    h.repository.createNpc(
      id,
      {
        serverId: 'pvp1',
        name: id,
        kind,
        x: 1,
        y: 1,
        z: 1,
        rotation: 0,
        prefab: 'p',
        mapMarker: false,
        useRadius: 3,
        enabled: true,
        wipePolicy: 'keep',
      },
      NOW,
    );
  }

  it('volta ao menu quando o NPC dela é apagado', async () => {
    npc('velho');
    h.repository.create('do-npc', quest({ npcId: 'velho' }), NOW);

    // Antes: só na tela do NPC.
    expect(await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).toEqual([]);

    h.repository.removeNpc('velho');

    // Depois: no menu. Ficar invisível para sempre — some do menu
    // por ter `npcId`, e do NPC que não existe — é pior.
    expect(
      (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO })).map((i) => i.quest.id),
    ).toEqual(['do-npc']);
  });

  it('um NPC de ENTREGA não oferece missão nenhuma', async () => {
    npc('bandit', 'delivery');
    h.repository.create('do-npc', quest({ npcId: 'bandit' }), NOW);

    // Ele existe para RECEBER o pacote. Uma vitrine ali confundiria
    // quem chegou para entregar.
    expect(
      await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO, npcId: 'bandit' }),
    ).toEqual([]);
  });

  it('a tela de um NPC que não existe vem vazia, e não com o menu', async () => {
    h.repository.create('no-menu', quest(), NOW);

    expect(
      await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO, npcId: 'fantasma' }),
    ).toEqual([]);
  });
});
