// ============================================================
//  quests-routes.test.ts  -  as promessas da API das quests.
//
//  O que este arquivo guarda:
//
//    1. as TRÊS regras que nascem na borda, e que só ela pode ver:
//       o ciclo de pré-requisitos, a quest em uso e o NPC ausente;
//    2. apagar uma quest que gente está fazendo RECUSA COM
//       CONTAGEM — e o `force` é um segundo clique, não um
//       parâmetro escondido;
//    3. a ordem é reescrita INTEIRA: uma lista parcial é recusada,
//       porque os ausentes ficariam com a posição cruzada e o
//       defeito só apareceria na próxima abertura da tela;
//    4. `/quests/progress` exige um recorte. Sem ele, a consulta
//       varreria uma tabela que cresce com jogador × quest ×
//       tentativa;
//    5. a duplicata nasce DESLIGADA e sem a cadeia do original;
//    6. a rota não reescreve a frase do serviço: o bloqueio que a
//       lista mostra é o mesmo que o `grant` fura e que o `accept`
//       recusa.
//
//  Banco em memória, migrações reais, Fastify de verdade: é o que
//  permite testar a API inteira sem servidor de Rust nenhum — que é
//  justamente a promessa destas rotas.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerQuestRoutes } from '../src/http/routes/quests.js';
import { createLogger } from '../src/logger.js';
import type {
  DeliverRewardsInput,
  QuestRewardService,
  RewardOutcome,
} from '../src/quests/rewards.js';
import { QuestsService } from '../src/quests/service.js';
import { questInputSchema, type QuestDraft } from '../src/types/quests.js';

const FULANO = '76561198000000001';
const logger = createLogger({ log: { level: 'silent', pretty: false } });

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: QuestsRepository;
  readonly service: QuestsService;
  readonly app: FastifyInstance;
}

let h: Harness;

/** O corpo de uma quest, como o painel o manda. */
function body(overrides: Partial<QuestDraft> = {}): QuestDraft {
  return {
    title: 'Minerador',
    category: 'diaria',
    objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 5000 }],
    rewards: [{ kind: 'coins', amount: 500 }],
    ...overrides,
  };
}

/**
 * O corpo de um pedido de teste.
 *
 * `object` e não `unknown`: o `inject` do Fastify exige um payload
 * serializável, e `unknown` obrigaria um `as` em toda chamada — que
 * é justamente o que esconderia um corpo malformado.
 */
type Payload = Record<string, unknown>;

async function post(url: string, payload: Payload = {}) {
  return h.app.inject({ method: 'POST', url, payload });
}

async function put(url: string, payload: Payload) {
  return h.app.inject({ method: 'PUT', url, payload });
}

async function get(url: string) {
  return h.app.inject({ method: 'GET', url });
}

/** Cria direto no repositório, quando o teste não é sobre criar. */
function seed(id: string, overrides: Partial<QuestDraft> = {}) {
  return h.repository.create(id, questInputSchema.parse(body(overrides)));
}

beforeEach(async () => {
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

  const repository = new QuestsRepository(db);
  const service = new QuestsService({
    repository,
    logger,
    // Um entregador que sempre dá certo: este arquivo é sobre a
    // borda, e o desfecho da entrega tem teste próprio.
    rewards: {
      deliver: (input: DeliverRewardsInput): Promise<readonly RewardOutcome[]> =>
        Promise.resolve(
          input.rewards.map((reward) => ({
            kind: reward.kind,
            ok: true,
            code: null,
            message: 'ok',
          })),
        ),
    } as QuestRewardService,
  });

  const app = Fastify();

  // O mesmo tratamento do servidor real. Sem a linha do ZodError,
  // uma recusa de validação viria como 500 e o teste passaria a
  // medir o handler do teste, e não a rota.
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    if (isApiError(error)) {
      const response = apiErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR', message: String(error) });
  });

  await app.register(
    async (api) => {
      registerQuestRoutes(api, {
        repository,
        service,
        servers: { list: () => servers.list().map((server) => ({ id: server.id })) },
      });
    },
    { prefix: '' },
  );

  await app.ready();

  h = { db, repository, service, app };
});

// ------------------------------------------------------------
//  O catálogo
// ------------------------------------------------------------

describe('o catálogo', () => {
  it('cria com 201 e um id derivado do título', async () => {
    const response = await post('/quests', body({ title: 'Diária: Minerador' }));

    expect(response.statusCode).toBe(201);
    expect(response.json().quest.id).toBe('diaria-minerador');
  });

  it('o segundo com o mesmo nome ganha sufixo — e o sufixo é o aviso', async () => {
    await post('/quests', body({ title: 'Minerador' }));

    const second = await post('/quests', body({ title: 'Minerador' }));

    // Um hash aleatório esconderia de quem cadastrou que já existe
    // uma quest com aquele nome.
    expect(second.json().quest.id).toBe('minerador-2');
  });

  it('recusa servidor que não existe, dizendo QUAL', async () => {
    const response = await post('/quests', body({ servers: ['pvp1', 'nao-existe'] }));

    // A FK do banco recusaria de qualquer jeito, mas "FOREIGN KEY
    // constraint failed" não diz qual dos ids estava errado.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('QUEST_SERVER_UNKNOWN');
    expect(response.json().message).toContain('nao-existe');
  });

  it('a duplicata nasce desligada e sem a cadeia do original', async () => {
    seed('primeira');
    seed('segunda', { requiresQuest: 'primeira' });

    const response = await post('/quests/segunda/duplicate');
    const copy = response.json().quest;

    expect(response.statusCode).toBe(201);
    // Uma cópia no ar antes de alguém trocar o título apareceria
    // no jogo como duas quests iguais.
    expect(copy.enabled).toBe(false);
    // Herdar a cadeia em silêncio produz uma cópia que ninguém
    // consegue pegar e que parece quebrada.
    expect(copy.requiresQuest).toBeNull();
    expect(copy.objectives).toHaveLength(1);
  });

  it('a ordem é reescrita inteira, ou é recusada', async () => {
    seed('a');
    seed('b');
    seed('c');

    const partial = await put('/quests/order', { ids: ['c', 'a'] });

    expect(partial.statusCode).toBe(400);
    expect(partial.json().error).toBe('QUEST_ORDER_INCOMPLETE');
    // A frase precisa dizer quem faltou: sem isso, quem arrastou
    // não tem como consertar.
    expect(partial.json().message).toContain('b');

    const full = await put('/quests/order', { ids: ['c', 'a', 'b'] });

    expect(full.statusCode).toBe(200);
    expect(full.json().quests.map((q: { id: string }) => q.id)).toEqual(['c', 'a', 'b']);
  });

  it('lista por servidor com a MESMA consulta que o jogo usa', async () => {
    seed('geral', { servers: [] });
    seed('so-pvp2', { servers: ['pvp2'] });

    // Usar `listForServer` aqui é o que garante que o painel vê o
    // que o jogo vê — inclusive o "sem restrição vale em todos".
    expect((await get('/quests?serverId=pvp1')).json().quests.map((q: { id: string }) => q.id)).toEqual(
      ['geral'],
    );
    expect((await get('/quests?serverId=pvp2')).json().quests.map((q: { id: string }) => q.id)).toEqual(
      ['geral', 'so-pvp2'],
    );
  });
});

// ------------------------------------------------------------
//  As três regras da borda
// ------------------------------------------------------------

describe('o ciclo de pré-requisitos', () => {
  it('recusa a quest que exige a si mesma', async () => {
    seed('a');

    const response = await put('/quests/a', body({ requiresQuest: 'a' }));

    expect(response.json().error).toBe('QUEST_CYCLE');
  });

  it('recusa o ciclo de três — as três sumiriam para sempre', async () => {
    seed('a');
    seed('b', { requiresQuest: 'a' });
    seed('c', { requiresQuest: 'b' });

    // Fechar A → B → C → A faria cada uma dizer "conclua a
    // anterior primeiro", e a anterior diria o mesmo.
    const response = await put('/quests/a', body({ requiresQuest: 'c' }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('QUEST_CYCLE');
  });

  it('aceita a cadeia longa que não fecha', async () => {
    seed('a');
    seed('b', { requiresQuest: 'a' });

    expect((await put('/quests/b', body({ requiresQuest: 'a' }))).statusCode).toBe(200);
  });

  it('recusa exigir uma quest que não existe', async () => {
    const response = await post('/quests', body({ requiresQuest: 'fantasma' }));

    expect(response.json().error).toBe('QUEST_CHAIN_MISSING');
  });
});

describe('a quest em uso', () => {
  it('apagar com gente no meio recusa com a contagem', async () => {
    seed('minerador');
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    const response = await h.app.inject({ method: 'DELETE', url: '/quests/minerador' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('QUEST_IN_USE');
    // Quem clica precisa ver quantos são antes de confirmar.
    expect(response.json().message).toContain('1 jogador');
    expect(h.repository.get('minerador')).not.toBeNull();
  });

  it('o `force` é o segundo clique', async () => {
    seed('minerador');
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    const response = await h.app.inject({
      method: 'DELETE',
      url: '/quests/minerador?force=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().live).toBe(1);
    expect(h.repository.get('minerador')).toBeNull();
  });

  it('sem ninguém fazendo, apaga direto', async () => {
    seed('minerador');

    expect((await h.app.inject({ method: 'DELETE', url: '/quests/minerador' })).statusCode).toBe(200);
  });
});

describe('o NPC ausente', () => {
  it('recusa a quest presa a um NPC que não existe', async () => {
    const response = await post('/quests', body({ npcId: 'fantasma' }));

    // Ela não apareceria em lugar nenhum: nem no menu, por ter
    // NPC; nem no NPC, por ele não estar lá.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('QUEST_NPC_MISSING');
  });

  it('recusa a entrega cujo destino não existe', async () => {
    await post('/quests/npcs', { serverId: 'pvp1', name: 'Velho', x: 1, y: 2, z: 3 });

    const response = await post(
      '/quests',
      body({
        npcId: 'velho',
        objectives: [{ seq: 0, kind: 'deliver', target: 'ninguem', amount: 1 }],
      }),
    );

    expect(response.json().error).toBe('QUEST_NPC_MISSING');
  });

  it('recusa a combinação impossível: NPC de um servidor, quest presa a outro', async () => {
    await post('/quests/npcs', { serverId: 'pvp1', name: 'Velho', x: 1, y: 2, z: 3 });

    const response = await post('/quests', body({ npcId: 'velho', servers: ['pvp2'] }));

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('pvp1');
  });

  it('aceita quando o NPC existe e o servidor bate', async () => {
    await post('/quests/npcs', { serverId: 'pvp1', name: 'Velho', x: 1, y: 2, z: 3 });

    expect((await post('/quests', body({ npcId: 'velho', servers: ['pvp1'] }))).statusCode).toBe(201);
    // E a quest de rede (sem lista de servidores) também.
    expect((await post('/quests', body({ npcId: 'velho', title: 'Outra' }))).statusCode).toBe(201);
  });
});

// ------------------------------------------------------------
//  O progresso
// ------------------------------------------------------------

describe('o progresso', () => {
  beforeEach(() => {
    seed('minerador');
  });

  it('exige um recorte — sem ele varreria a tabela inteira', async () => {
    const response = await get('/quests/progress');

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('QUEST_PROGRESS_NO_FILTER');
  });

  it('filtra por jogador, por quest, por servidor e por estado', async () => {
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });
    await h.service.accept({ serverId: 'pvp2', steamId: FULANO, questId: 'minerador' });

    expect((await get(`/quests/progress?steamId=${FULANO}`)).json().progress).toHaveLength(2);
    expect(
      (await get(`/quests/progress?steamId=${FULANO}&serverId=pvp1`)).json().progress,
    ).toHaveLength(1);
    expect((await get('/quests/progress?questId=minerador')).json().progress).toHaveLength(2);
    expect(
      (await get('/quests/progress?questId=minerador&status=claimed')).json().progress,
    ).toHaveLength(0);
  });

  it('a resposta traz a frase do objetivo, e não só o número', async () => {
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    const row = (await get(`/quests/progress?steamId=${FULANO}`)).json().progress[0];

    // O mesmo corpo que a tela do jogo recebe: duas formas para a
    // mesma tentativa dariam duas contagens de progresso.
    expect(row.objectives[0]).toMatchObject({ have: 0, need: 5000, done: false });
    expect(row.objectives[0].label).toContain('Coletar');
    expect(row.serverId).toBe('pvp1');
  });

  it('ajustar o contador registra quem foi, e NÃO conclui sozinho', async () => {
    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    const response = await post(`/quests/progress/${String(view.playerQuestId)}/set`, {
      objectiveSeq: 0,
      value: 5000,
      actor: 'dono',
      reason: 'bug do plugin',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().quest.complete).toBe(true);
    // Duas portas para o mesmo estado divergiriam na primeira
    // mudança da regra de conclusão.
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('active');

    const events = h.repository.events({ kind: 'progress' });

    expect(events[0]?.actor).toBe('dono');
    expect(events[0]?.detail).toMatchObject({ reason: 'bug do plugin' });
  });

  it('o resgate pelo painel funciona depois do ajuste', async () => {
    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    await post(`/quests/progress/${String(view.playerQuestId)}/set`, {
      objectiveSeq: 0,
      value: 5000,
    });

    const response = await post(`/quests/progress/${String(view.playerQuestId)}/claim`, {
      actor: 'dono',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.pending).toBe(false);
    expect(h.repository.attempt(view.playerQuestId)?.status).toBe('claimed');
  });

  it('a tentativa que não existe é 404, e não 500', async () => {
    expect((await post('/quests/progress/9999/set', { objectiveSeq: 0, value: 1 })).statusCode).toBe(
      404,
    );
    expect((await post('/quests/progress/9999/cancel')).statusCode).toBe(404);
  });
});

// ------------------------------------------------------------
//  A borda não reescreve a regra
// ------------------------------------------------------------

describe('a rota não reescreve a frase do serviço', () => {
  it('o bloqueio que a lista mostra é o que o `grant` fura', async () => {
    seed('uma-vez', { repeatMode: 'once' });

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'uma-vez',
    });

    h.repository.setProgress(view.playerQuestId, 0, 5000);
    await h.service.claim({ playerQuestId: view.playerQuestId });

    const offers = (await get(`/quests/offers?serverId=pvp1&steamId=${FULANO}`)).json().offers;

    expect(offers[0].block.code).toBe('QUEST_ONCE_ONLY');

    // O suporte passa por cima: é para isso que o `grant` existe.
    const granted = await post('/quests/uma-vez/grant', {
      serverId: 'pvp1',
      steamId: FULANO,
      actor: 'dono',
    });

    expect(granted.statusCode).toBe(201);
  });

  it('a oferta carrega quando a quest volta', async () => {
    seed('diaria', { repeatMode: 'cooldown', cooldownSeconds: 3600 });

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'diaria',
    });

    h.repository.setProgress(view.playerQuestId, 0, 5000);
    await h.service.claim({ playerQuestId: view.playerQuestId });

    const offer = (await get(`/quests/offers?serverId=pvp1&steamId=${FULANO}`)).json().offers[0];

    expect(offer.block.code).toBe('QUEST_ON_COOLDOWN');
    expect(offer.availableAt).toBeGreaterThan(Date.now());
  });
});

// ------------------------------------------------------------
//  O wipe e a configuração
// ------------------------------------------------------------

describe('o wipe pelo painel', () => {
  it('recusa sem recorte, e exige um motivo', async () => {
    const semRecorte = await post('/quests/wipe', { actor: 'dono', reason: 'oops' });

    expect(semRecorte.json().error).toBe('QUEST_WIPE_TOO_BROAD');

    const semMotivo = await post('/quests/wipe', { serverId: 'pvp1', actor: 'dono' });

    // Zerar progresso sem dizer por quê é o que ninguém consegue
    // explicar depois.
    expect(semMotivo.statusCode).toBe(400);
  });

  it('zera e devolve quantos', async () => {
    seed('minerador');
    await h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'minerador' });

    const response = await post('/quests/wipe', {
      serverId: 'pvp1',
      actor: 'dono',
      reason: 'pediu no Discord',
    });

    expect(response.json().wiped).toBe(1);
    expect(h.repository.events({ kind: 'reset' })[0]?.actor).toBe('dono');
  });
});

describe('a configuração', () => {
  it('sem linha, cada servidor vem com o padrão', async () => {
    const settings = (await get('/quests/settings')).json().settings;

    expect(settings).toHaveLength(2);
    expect(settings[0]).toMatchObject({ maxActive: 0, enabled: true, updatedAt: null });
  });

  it('grava e recusa servidor desconhecido', async () => {
    const ok = await put('/quests/settings/pvp1', {
      maxActive: 3,
      enabled: true,
      flushSeconds: 120,
      lootEnabled: false,
      resetAtMinute: 180,
    });

    expect(ok.json().settings).toMatchObject({ maxActive: 3, lootEnabled: false });

    const bad = await put('/quests/settings/fantasma', { maxActive: 1 });

    expect(bad.json().error).toBe('QUEST_SERVER_UNKNOWN');
  });
});

// ------------------------------------------------------------
//  Os NPCs
// ------------------------------------------------------------

describe('os NPCs', () => {
  it('cria com 201, id derivado do nome e o prefab medido', async () => {
    const response = await post('/quests/npcs', {
      serverId: 'pvp1',
      name: 'Velho do Outpost',
      x: 120.5,
      y: 10,
      z: -430.25,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().npc.id).toBe('velho-do-outpost');
    expect(response.json().npc.prefab).toContain('bandit_shopkeeper');
  });

  it('a listagem diz quais quests dependem dele', async () => {
    await post('/quests/npcs', { serverId: 'pvp1', name: 'Velho', x: 1, y: 2, z: 3 });
    await post('/quests', body({ npcId: 'velho' }));

    expect((await get('/quests/npcs')).json().npcs[0].quests).toEqual(['minerador']);
  });

  it('apagar devolve as quests que ficaram órfãs', async () => {
    await post('/quests/npcs', { serverId: 'pvp1', name: 'Velho', x: 1, y: 2, z: 3 });
    await post('/quests', body({ npcId: 'velho' }));

    const response = await h.app.inject({ method: 'DELETE', url: '/quests/npcs/velho' });

    expect(response.json().orphaned).toEqual(['minerador']);
    // A quest volta a ser uma quest de menu, com o progresso de
    // quem estava fazendo intacto.
    expect(h.repository.get('minerador')).not.toBeNull();
  });

  it('o NPC que não existe é 404 nas duas rotas', async () => {
    expect(
      (await h.app.inject({ method: 'DELETE', url: '/quests/npcs/fantasma' })).statusCode,
    ).toBe(404);
    expect(
      (await put('/quests/npcs/fantasma', { serverId: 'pvp1', name: 'X', x: 1, y: 1, z: 1 }))
        .statusCode,
    ).toBe(404);
  });
});

// ------------------------------------------------------------
//  As pendências
// ------------------------------------------------------------

describe('as recompensas pendentes', () => {
  it('listam o que falhou, com a tentativa junto', async () => {
    seed('minerador');

    const view = await h.service.accept({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
    });

    h.repository.setProgress(view.playerQuestId, 0, 5000);
    h.repository.recordEvent({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
      attempt: 1,
      kind: 'reward_failed',
      detail: { kind: 'item', code: 'INVENTORY_FULL' },
      source: 'agent',
    });

    const pending = (await get('/quests/rewards/pending')).json().pending;

    expect(pending).toHaveLength(1);
    expect(pending[0].detail).toMatchObject({ code: 'INVENTORY_FULL' });
    expect(pending[0].attempt.questId).toBe('minerador');
  });

  it('a pendência de uma quest apagada continua listada', async () => {
    seed('minerador');
    h.repository.recordEvent({
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
      attempt: 1,
      kind: 'reward_failed',
      detail: { kind: 'kit', code: 'KIT_NOT_FOUND' },
      source: 'agent',
    });

    await h.app.inject({ method: 'DELETE', url: '/quests/minerador?force=true' });

    const pending = (await get('/quests/rewards/pending')).json().pending;

    // A linha da auditoria é justamente o que responde "o que
    // aconteceu com o meu prêmio?" — ela não pode sumir com a
    // quest.
    expect(pending).toHaveLength(1);
    expect(pending[0].attempt).toBeNull();
  });
});
