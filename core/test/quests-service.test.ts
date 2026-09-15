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
  type QuestPlaytimeSource,
  type QuestsServiceDeps,
  type QuestStatsSource,
} from '../src/quests/service.js';
import type { DeliverRewardsInput, RewardOutcome } from '../src/quests/rewards.js';
import {
  questInputSchema,
  questNpcInputSchema,
  type QuestDraft,
  type QuestInput,
} from '../src/types/quests.js';

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

/**
 * Um `playtime` que o teste controla.
 *
 * Em produção quem o satisfaz é o `player_servers`, com a sessão
 * aberta somada — ver `PlayersRepository.onlineSecondsOf`.
 */
class FakePlaytime implements QuestPlaytimeSource {
  readonly seconds = new Map<string, number>();

  secondsOf(serverId: string, steamId: string): number {
    return this.seconds.get(`${serverId}:${steamId}`) ?? 0;
  }

  set(value: number, serverId = 'pvp1', steamId = FULANO): void {
    this.seconds.set(`${serverId}:${steamId}`, value);
  }
}

/**
 * Um entregador que registra o que lhe pediram e obedece ao roteiro.
 *
 * ####  ELE HONRA O `only` E O `index`, COMO O DE VERDADE  ####
 *
 * Os dois são o contrato do retry seletivo: o `only` diz quais
 * posições entregar, e o `index` de volta é o que o serviço grava.
 * Um fake que ignorasse os dois deixaria os testes verdes sobre um
 * comportamento que não existe.
 */
class FakeRewards {
  readonly calls: DeliverRewardsInput[] = [];
  outcome: (input: DeliverRewardsInput) => readonly RewardOutcome[] = (input) =>
    input.rewards.map((reward, index) => ({
      index,
      kind: reward.kind,
      ok: true,
      code: null,
      message: 'ok',
    }));

  deliver(input: DeliverRewardsInput): Promise<readonly RewardOutcome[]> {
    this.calls.push(input);

    const todos = this.outcome(input);

    return Promise.resolve(
      input.only === undefined
        ? todos
        : todos.filter((item) => item.index !== undefined && input.only?.has(item.index) === true),
    );
  }
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: QuestsRepository;
  readonly stats: FakeStats;
  readonly playtime: FakePlaytime;
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
  readonly playtime?: QuestPlaytimeSource | undefined;
  readonly rewards?: FakeRewards | undefined;
  readonly items?: { displayNameOf: (shortname: string) => string | null };
} = {}): QuestsService {
  return new QuestsService({
    repository: h.repository,
    logger,
    stats: options.stats ?? h.stats,
    playtime: 'playtime' in options ? options.playtime : h.playtime,
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
    playtime: new FakePlaytime(),
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
    // Ele já estava online há uma hora QUANDO ACEITOU. Esta hora é
    // a linha de partida, e não progresso.
    h.playtime.set(3600);
    h.repository.create(
      'presenca',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 60 }] }),
      NOW,
    );

    await accept('presenca');

    // A fonte é em SEGUNDOS; o objetivo é em minutos, que é o que o
    // admin digita no painel.
    h.playtime.set(3600 + 1800);
    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(30);
  });

  it('o contador anda com a sessão ABERTA, sem ninguém empurrar', async () => {
    // ####  O DEFEITO QUE ESTE TESTE FIXA  ####
    //
    // Antes de 14/09/2026 o `playtime` lia `time.played` do
    // ranking, que é a diferença do `played_seconds` entre duas
    // rodadas — e aquela coluna só cresce quando a sessão FECHA. O
    // jogador passava a sessão inteira em 0/90 e o número só
    // pulava depois de ele desconectar.
    h.repository.create(
      'vigilia',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 90 }] }),
      NOW,
    );

    await accept('vigilia');

    for (const [minutes, expected] of [
      [1, 1],
      [2, 2],
      [45, 45],
    ] as const) {
      h.playtime.set(minutes * 60);
      h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

      expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(
        expected,
      );
    }
  });

  it('o recálculo CONCLUI a missão de tempo online, e avisa', async () => {
    // ####  O SEGUNDO DEFEITO, E O PIOR DELES  ####
    //
    // O `#completeIfDone` só era chamado pelo push e pelo lote do
    // plugin — e o plugin não conta `playtime`. O número chegava a
    // 90/90 e a tentativa ficava `active` para sempre: sem aviso no
    // chat, sem resgate.
    const avisos: { readonly questId: string; readonly title: string }[] = [];

    h.service = new QuestsService({
      repository: h.repository,
      logger,
      stats: h.stats,
      playtime: h.playtime,
      rewards: h.rewards as never,
      onCompleted: (input) => avisos.push({ questId: input.questId, title: input.title }),
      now: () => h.now,
    });

    h.repository.create(
      'vigilia',
      quest({ title: 'Turno da Vigília', objectives: [{ seq: 0, kind: 'playtime', amount: 90 }] }),
      NOW,
    );

    const id = await accept('vigilia');

    h.playtime.set(90 * 60);
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    expect(h.repository.attempt(id)?.status).toBe('completed');
    expect(avisos).toEqual([{ questId: 'vigilia', title: 'Turno da Vigília' }]);

    // E uma conclusão, uma linha: o ciclo do coletor chama isto a
    // cada 15 s, e um aviso por rodada encheria o chat do jogador.
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });
    expect(avisos).toHaveLength(1);
  });

  it('o tempo já contado sobrevive à queda do total', async () => {
    // Entre a saída do jogador e a consolidação da sessão, a fonte
    // pode devolver um número MENOR do que o que já está gravado —
    // e um reset de admin no ranking faz o mesmo com o `metric`.
    // "Reconectar não apaga o tempo já contabilizado" é pedido do
    // dono; aqui ele vira regra.
    h.repository.create(
      'vigilia',
      quest({ objectives: [{ seq: 0, kind: 'playtime', amount: 90 }] }),
      NOW,
    );

    await accept('vigilia');

    h.playtime.set(40 * 60);
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    h.playtime.set(0);
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(40);

    // E volta a andar de onde parou quando a fonte se recompõe.
    h.playtime.set(41 * 60);
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    expect(h.service.liveFor({ serverId: 'pvp1', steamId: FULANO })[0]?.objectives[0]?.have).toBe(41);
  });

  it('a missão que repete começa a contar do zero a cada tentativa', async () => {
    // O tempo online é um total que nunca zera. Quem garante que a
    // diária de amanhã não nasce concluída é o baseline da NOVA
    // tentativa — e é por isso que ele é lido no aceite, e não uma
    // vez só por jogador.
    h.repository.create(
      'vigilia',
      quest({
        repeatMode: 'cooldown',
        cooldownSeconds: 3600,
        objectives: [{ seq: 0, kind: 'playtime', amount: 90 }],
      }),
      NOW,
    );

    h.playtime.set(10 * 3600);

    const primeira = await accept('vigilia');

    h.playtime.set(10 * 3600 + 90 * 60);
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    expect(h.repository.attempt(primeira)?.status).toBe('completed');

    await h.service.claim({ playerQuestId: primeira });

    h.now = NOW + 3_600_001;

    const segunda = await accept('vigilia');

    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    expect(h.repository.attempt(segunda)?.progress[0] ?? 0).toBe(0);

    // E ela anda como a primeira, dali para a frente.
    h.playtime.set(10 * 3600 + 90 * 60 + 5 * 60);
    h.service.refreshDerived({ serverId: 'pvp1', steamId: FULANO });

    expect(h.repository.attempt(segunda)?.progress[0]).toBe(5);
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

  it('o menu mostra a do NPC bloqueada; a tela dele mostra só a dele', async () => {
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

    // O menu é o cartaz: as duas aparecem, e a do NPC vem com o
    // "fale com" no lugar do botão. Antes de 11/09/2026 ela sumia,
    // e o jogador lia "Disponíveis: 0" com missão cadastrada.
    const menu = await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO });

    expect(menu.map((i) => i.quest.id)).toEqual(['no-menu', 'no-npc']);
    expect(menu.find((i) => i.quest.id === 'no-menu')?.block).toBeNull();
    expect(menu.find((i) => i.quest.id === 'no-npc')?.block?.reason).toContain('Fale com Velho');

    // A tela do NPC é o balcão: só o que ELE oferece.
    expect(
      (await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO, npcId: 'velho' })).map(
        (i) => i.quest.id,
      ),
    ).toEqual(['no-npc']);
  });

  it('quem falou com o NPC pode aceitar; quem não falou, não', async () => {
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
    h.repository.create('no-npc', quest({ npcId: 'velho' }), NOW);

    // ####  A TESTEMUNHA NÃO É O CLIQUE  ####
    //
    // O alvo do botão chega do jogo e pode ser forjado. Quem diz
    // que o jogador esteve no balcão é o empurrão do plugin, que
    // mediu a distância lá.
    await expect(
      h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'no-npc' }),
    ).rejects.toThrow(/Fale com Velho/);

    h.service.noteNpcTalk({ serverId: 'pvp1', steamId: FULANO, npcId: 'velho' });

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'no-npc',
    });

    expect(view.questId).toBe('no-npc');
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
  });

  it('a reentrega NÃO reprocessa o que já saiu', async () => {
    // ####  O DEFEITO QUE ESTE TESTE FIXA  ####
    //
    // O botão reprocessava as cinco recompensas. Moeda e ponto
    // aguentavam pela idempotência que têm na ponta; item, kit e
    // VIP saíam de novo, e ninguém percebia até o jogador contar.
    const id = await accept();

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    expect(h.rewards.calls).toHaveLength(1);

    const result = await h.service.retryRewards({ playerQuestId: id, actor: 'dono' });

    // Nada pendente: o entregador nem é chamado.
    expect(h.rewards.calls).toHaveLength(1);
    expect(result.pending).toBe(false);
    // E o quadro volta como está gravado — a mensagem é a da
    // entrega que aconteceu, e não uma inventada agora.
    expect(result.outcomes[0]).toMatchObject({ index: 0, ok: true, message: 'ok' });
  });

  it('a reentrega manda SÓ a posição que falhou', async () => {
    h.repository.create(
      'premiada',
      quest({
        rewards: [
          { kind: 'coins', amount: 50 },
          { kind: 'points', metric: 'trophy.bleik', amount: 5 },
        ],
      }),
      NOW,
    );

    // O caso do dono, na letra: os 50 OZCoin entram e os 5 pontos
    // não, porque o ranking não existia.
    h.rewards.outcome = (input) =>
      input.rewards.map((reward, index) => ({
        index,
        kind: reward.kind,
        ok: reward.kind !== 'points',
        code: reward.kind === 'points' ? 'RANKING_METRIC_UNKNOWN' : null,
        message: reward.kind === 'points' ? 'o ranking não existe' : 'ok',
      }));

    const id = await accept('premiada');

    bump(id, 5000);

    expect((await h.service.claim({ playerQuestId: id })).pending).toBe(true);

    // O admin conserta o cadastro; daqui em diante tudo sai.
    h.rewards.outcome = (input) =>
      input.rewards.map((reward, index) => ({
        index,
        kind: reward.kind,
        ok: true,
        code: null,
        message: 'ok',
      }));

    const result = await h.service.retryRewards({ playerQuestId: id, actor: 'dono' });

    // A moeda NÃO foi remandada: o `only` levou só a posição 1.
    expect([...(h.rewards.calls[1]?.only ?? [])]).toEqual([1]);
    expect(result.pending).toBe(false);
    // E o quadro devolvido é o completo — a tela do painel mostra a
    // missão inteira, e não só o que acabou de ser reprocessado.
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]).toMatchObject({ index: 0, kind: 'coins', ok: true });
    expect(result.outcomes[1]).toMatchObject({ index: 1, kind: 'points', ok: true });
  });

  it('o que falhou DE NOVO continua pendente, e só ele', async () => {
    h.repository.create(
      'premiada',
      quest({
        rewards: [
          { kind: 'coins', amount: 50 },
          { kind: 'points', metric: 'trophy.bleik', amount: 5 },
        ],
      }),
      NOW,
    );

    h.rewards.outcome = (input) =>
      input.rewards.map((reward, index) => ({
        index,
        kind: reward.kind,
        ok: reward.kind !== 'points',
        code: reward.kind === 'points' ? 'RANKING_METRIC_UNKNOWN' : null,
        message: 'roteiro',
      }));

    const id = await accept('premiada');

    bump(id, 5000);
    await h.service.claim({ playerQuestId: id });

    // O admin clica sem ter consertado nada.
    const primeira = await h.service.retryRewards({ playerQuestId: id, actor: 'dono' });

    expect(primeira.pending).toBe(true);

    // E de novo: o recorte continua o mesmo, e a moeda nunca volta
    // a ser mandada.
    const segunda = await h.service.retryRewards({ playerQuestId: id, actor: 'dono' });

    expect(segunda.pending).toBe(true);
    expect([...(h.rewards.calls[1]?.only ?? [])]).toEqual([1]);
    expect([...(h.rewards.calls[2]?.only ?? [])]).toEqual([1]);
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
        item: null,
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
        item: null,
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
        item: null,
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

    // O número entra direto, e não pelo recálculo: desde 14/09/2026
    // o próprio recálculo conclui o que fecha, e a tentativa já
    // chegaria `completed` ao push. O que se prova aqui é outra
    // coisa — que QUANDO é o push que conclui, o `eventId` dele vai
    // para a auditoria.
    h.repository.setProgress(id, 0, 5, NOW);

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

  it('perde o "fale com" quando o NPC dela é apagado', async () => {
    npc('velho');
    h.repository.create('do-npc', quest({ npcId: 'velho' }), NOW);

    // Com o NPC de pé, ela aparece no menu BLOQUEADA: o menu é o
    // cartaz, o boneco é o balcão.
    const antes = await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO });

    expect(antes.map((i) => i.quest.id)).toEqual(['do-npc']);
    expect(antes[0]?.block?.code).toBe('QUEST_NEEDS_NPC');

    h.repository.removeNpc('velho');

    // Sem o NPC, não há a quem mandar o jogador falar: ela vira uma
    // quest de menu como outra qualquer. Ficar pedindo conversa com
    // um boneco que não existe seria a mesma coisa que sumir.
    const depois = await h.service.offersFor({ serverId: 'pvp1', steamId: FULANO });

    expect(depois.map((i) => i.quest.id)).toEqual(['do-npc']);
    expect(depois[0]?.block).toBeNull();
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

// ------------------------------------------------------------
//  O BALCÃO: ENTREGAR O QUE SE TEM
// ------------------------------------------------------------

describe('a entrega no balcão do NPC', () => {
  function comEstoque(estoque: Record<string, number>) {
    const tirado: { shortname: string; amount: number }[] = [];

    return {
      tirado,
      consumer: {
        take: (input: {
          items: readonly { shortname: string; amount: number }[];
          partial?: boolean;
        }) => {
          const taken = input.items.map((item) => {
            const have = estoque[item.shortname] ?? 0;
            const amount = input.partial === true ? Math.min(have, item.amount) : item.amount;

            if (input.partial === true) {
              estoque[item.shortname] = have - amount;
              tirado.push({ shortname: item.shortname, amount });
            }

            return { shortname: item.shortname, amount };
          });

          const complete = taken.every((item, index) => item.amount >= input.items[index]!.amount);

          return Promise.resolve({ complete, taken });
        },
      },
    };
  }

  it('tira o que o jogador tem e soma ao contador, sem exigir tudo', async () => {
    const estoque = comEstoque({ stones: 30 });
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: estoque.consumer,
    });

    h.repository.create(
      'muro',
      questInputSchema.parse({
        title: 'Muro',
        objectives: [{ seq: 0, kind: 'gather', target: 'stones', amount: 300 }],
      }),
    );

    const view = await service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'muro' });

    const entregue = await service.turnIn({ playerQuestId: view.playerQuestId, steamId: FULANO });

    expect(entregue).toEqual([{ shortname: 'stones', amount: 30 }]);

    const depois = h.repository.attempt(view.playerQuestId);

    expect(depois?.progress[0]).toBe(30);
    // O que saiu da mochila fica marcado: é o que o resgate não
    // pode cobrar de novo.
    expect(depois?.paid[0]).toBe(30);
    expect(depois?.status).toBe('active');
  });

  it('a segunda viagem soma, e a que fecha conclui a missão', async () => {
    const estoque = comEstoque({ stones: 200 });
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: estoque.consumer,
    });

    h.repository.create(
      'muro',
      questInputSchema.parse({
        title: 'Muro',
        objectives: [{ seq: 0, kind: 'gather', target: 'stones', amount: 300 }],
      }),
    );

    const view = await service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'muro' });

    await service.turnIn({ playerQuestId: view.playerQuestId, steamId: FULANO });
    expect(h.repository.attempt(view.playerQuestId)?.progress[0]).toBe(200);

    // Ele volta com mais do que falta: a mochila tem 500, e a
    // missão só pode levar as 100 que restam.
    const segunda = comEstoque({ stones: 500 });
    const service2 = new QuestsService({
      repository: h.repository,
      logger,
      consumer: segunda.consumer,
    });

    await service2.turnIn({ playerQuestId: view.playerQuestId, steamId: FULANO });

    expect(segunda.tirado).toEqual([{ shortname: 'stones', amount: 100 }]);

    const depois = h.repository.attempt(view.playerQuestId);

    expect(depois?.progress[0]).toBe(300);
    expect(depois?.paid[0]).toBe(300);
    expect(depois?.status).toBe('completed');
  });

  it('o que foi entregue no balcão não é cobrado de novo no resgate', async () => {
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: comEstoque({ stones: 300 }).consumer,
      // O dublê entrega a lista vazia e nada mais: este teste é sobre
      // o que o balcão já cobrou, e não sobre recompensa. O `as` é o
      // mesmo dos outros dublês deste arquivo — a classe real tem
      // campos privados, e um objeto literal nunca os satisfaz.
      rewards: { deliver: () => Promise.resolve([]) } as unknown as QuestsServiceDeps['rewards'],
    });

    h.repository.create(
      'muro',
      questInputSchema.parse({
        title: 'Muro',
        objectives: [
          { seq: 0, kind: 'gather', target: 'stones', amount: 300, consume: true },
        ],
      }),
    );

    const view = await service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'muro' });

    await service.turnIn({ playerQuestId: view.playerQuestId, steamId: FULANO });

    // A mochila está vazia agora. Sem a marca do que foi pago, o
    // resgate cobraria 300 pedras que o jogador acabou de entregar.
    const result = await service.claim({ playerQuestId: view.playerQuestId });

    expect(result.playerQuestId).toBe(view.playerQuestId);
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('claimed');
  });
});

// ============================================================
//  A ENCOMENDA
//
//  A entrega nasceu como CORREIO: chegar ao boneco concluia, e o
//  que a recompensa pagava era a distancia. Desde 13/09/2026 ela
//  pode cobrar uma COISA -- "consiga um cartao verde e entregue ao
//  NPC" --, e a diferenca entre os dois modos e o `item` do
//  objetivo.
//
//  O que estes testes seguram: a encomenda sai da mochila NO
//  DESTINO, e so nele; e chegar de maos vazias nao paga nada.
// ============================================================
describe('a encomenda: a entrega que cobra um item', () => {
  const CARTAO = 'keycard_green';

  function boneco(id: string, name: string): void {
    h.repository.createNpc(
      id,
      questNpcInputSchema.parse({ serverId: 'pvp1', name, x: 10, y: 5, z: 20 }),
      NOW,
    );
  }

  /** Um consumidor de mentira, com a mochila que o teste escolheu. */
  function comMochila(mochila: Record<string, number>) {
    const tirado: { shortname: string; amount: number }[] = [];

    return {
      tirado,
      consumer: {
        take: (input: {
          items: readonly { shortname: string; amount: number }[];
          partial?: boolean;
        }) => {
          const taken = input.items.map((item) => {
            const have = mochila[item.shortname] ?? 0;
            const amount = Math.min(have, item.amount);

            mochila[item.shortname] = have - amount;
            tirado.push({ shortname: item.shortname, amount });

            return { shortname: item.shortname, amount };
          });

          return Promise.resolve({
            complete: taken.every((item, index) => item.amount >= input.items[index]!.amount),
            taken,
          });
        },
      },
    };
  }

  function comEncomenda(amount = 1): void {
    boneco('mateus', 'Mateus');

    h.repository.create(
      'cartao-verde',
      questInputSchema.parse({
        title: 'O cartao verde',
        objectives: [{ seq: 0, kind: 'deliver', target: 'mateus', item: CARTAO, amount }],
      }),
      NOW,
    );
  }

  it('o item sai da mochila no destino, e a missao fecha', async () => {
    const mochila = comMochila({ [CARTAO]: 1 });
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: mochila.consumer,
      now: () => h.now,
    });

    comEncomenda();

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'cartao-verde',
    });

    const entregue = await service.turnIn({
      playerQuestId: view.playerQuestId,
      steamId: FULANO,
      npcId: 'mateus',
    });

    expect(entregue).toEqual([{ shortname: CARTAO, amount: 1 }]);

    const depois = h.repository.attempt(view.playerQuestId);

    expect(depois?.progress[0]).toBe(1);
    expect(depois?.status).toBe('completed');
  });

  it('no boneco errado nao sai nada da mochila', async () => {
    const mochila = comMochila({ [CARTAO]: 1 });
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: mochila.consumer,
      now: () => h.now,
    });

    comEncomenda();
    boneco('bia', 'Bia');

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'cartao-verde',
    });

    // A Bia nao e o destino: o cartao continua no bolso, e o
    // contador nao anda.
    expect(
      await service.turnIn({
        playerQuestId: view.playerQuestId,
        steamId: FULANO,
        npcId: 'bia',
      }),
    ).toEqual([]);

    expect(mochila.tirado).toEqual([]);
    expect(h.repository.attempt(view.playerQuestId)?.progress[0] ?? 0).toBe(0);
  });

  it('a entrega parcial soma, e a viagem que fecha conclui', async () => {
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: comMochila({ [CARTAO]: 2 }).consumer,
      now: () => h.now,
    });

    comEncomenda(3);

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'cartao-verde',
    });

    await service.turnIn({ playerQuestId: view.playerQuestId, steamId: FULANO, npcId: 'mateus' });

    expect(h.repository.attempt(view.playerQuestId)?.progress[0]).toBe(2);
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('active');

    // Ele volta com mais do que falta: a mochila tem 5, e a missao
    // so pode levar o 1 que resta.
    const segunda = comMochila({ [CARTAO]: 5 });
    const service2 = new QuestsService({
      repository: h.repository,
      logger,
      consumer: segunda.consumer,
      now: () => h.now,
    });

    await service2.turnIn({ playerQuestId: view.playerQuestId, steamId: FULANO, npcId: 'mateus' });

    expect(segunda.tirado).toEqual([{ shortname: CARTAO, amount: 1 }]);
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('completed');
  });

  it('chegar ao NPC nao paga a encomenda', async () => {
    const service = new QuestsService({
      repository: h.repository,
      logger,
      consumer: comMochila({ [CARTAO]: 1 }).consumer,
      now: () => h.now,
    });

    comEncomenda();

    const view = await service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'cartao-verde',
    });

    // ####  ISTO E O QUE SEPARA O CORREIO DA ENCOMENDA  ####
    //
    // O push da chegada e o mesmo dos dois; num servidor com o
    // plugin velho ele continua vindo. Se ele marcasse, a missao
    // fecharia com o cartao ainda no bolso.
    expect(service.reportDelivery({ playerQuestId: view.playerQuestId, npcId: 'mateus' })).toBe(
      false,
    );

    expect(h.repository.attempt(view.playerQuestId)?.progress[0] ?? 0).toBe(0);
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('active');
  });

  it('o correio sem item continua fechando com a chegada', async () => {
    boneco('zev', 'Zev');
    boneco('ferreiro', 'Ferreiro');

    h.repository.create(
      'correio',
      questInputSchema.parse({
        title: 'Leve isto ao ferreiro',
        npcId: 'zev',
        objectives: [{ seq: 0, kind: 'deliver', target: 'ferreiro', amount: 1 }],
      }),
      NOW,
    );

    // `force` porque a quest tem NPC de origem, e o aceite normal
    // exige a testemunha de que ele esteve no balcao -- o que este
    // teste nao esta medindo.
    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'correio',
      force: true,
    });

    expect(h.service.reportDelivery({ playerQuestId: view.playerQuestId, npcId: 'ferreiro' })).toBe(
      true,
    );

    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('completed');
  });

  it('a frase diz o que ele carrega, e chama o boneco pelo nome', () => {
    // O NPC existe no banco: o nome do destino sai DELE, e nao do
    // catalogo de itens -- onde um id de boneco nunca estaria.
    boneco('mateus', 'Mateus, o Ferreiro');

    const service = build({
      items: { displayNameOf: (shortname) => (shortname === CARTAO ? 'Cartao Verde' : null) },
    });

    expect(
      service.describeObjective({
        seq: 0,
        kind: 'deliver',
        target: 'mateus',
        metric: null,
        item: CARTAO,
        amount: 1,
        label: null,
        consume: false,
      }),
    ).toBe('Entregar 1 Cartao Verde para Mateus, o Ferreiro');

    // Sem item, a frase antiga fica de pe: o que viaja e figurado.
    expect(
      service.describeObjective({
        seq: 0,
        kind: 'deliver',
        target: 'mateus',
        metric: null,
        item: null,
        amount: 1,
        label: null,
        consume: false,
      }),
    ).toBe('Entregar o pacote para Mateus, o Ferreiro');
  });

  it('o cadastro recusa item fora da entrega, e cobra origem so do correio', () => {
    // Um `item` num objetivo de matar nao teria o que tirar da
    // mochila -- e ficaria gravado parecendo que vale.
    expect(() =>
      questInputSchema.parse({
        title: 'Errada',
        objectives: [{ seq: 0, kind: 'kill', target: 'scientist', item: CARTAO, amount: 1 }],
      }),
    ).toThrow();

    // O correio mede um trajeto: sem origem nao ha o que medir.
    expect(() =>
      questInputSchema.parse({
        title: 'Correio sem origem',
        objectives: [{ seq: 0, kind: 'deliver', target: 'mateus', amount: 1 }],
      }),
    ).toThrow();

    // A encomenda comeca no menu sem problema nenhum: o que ela
    // pede e o item, e nao a caminhada.
    expect(() =>
      questInputSchema.parse({
        title: 'Encomenda do menu',
        objectives: [{ seq: 0, kind: 'deliver', target: 'mateus', item: CARTAO, amount: 1 }],
      }),
    ).not.toThrow();
  });
});
