// ============================================================
//  messages-routes.test.ts  -  o que a borda recusa.
//
//  `app.inject()`: nenhuma porta aberta, banco em memória.
//
//  O que este arquivo guarda:
//
//    1. o gatilho é EXCLUSIVO, e cada um cobra só o que é dele —
//       uma mensagem de rodízio não precisa de ritmo próprio;
//    2. rodízio sem grupo e comando sem comando são recusados na
//       gravação, e não descobertos semanas depois como "ela nunca
//       sai";
//    3. dois comandos iguais NO MESMO servidor são recusados; em
//       servidores diferentes, não — é o caso normal de uma rede;
//    4. gravar uma mensagem de comando PUBLICA o comando na hora;
//    5. trocar a ordem do grupo recomeça o ciclo; mexer no nome,
//       não;
//    6. remover o grupo NÃO apaga as mensagens dele.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MessagesRepository } from '../src/db/messages-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { PluginBroadcaster } from '../src/game/broadcast.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import { registerMessageRoutes } from '../src/http/routes/messages.js';
import { createLogger } from '../src/logger.js';
import { MessagesService } from '../src/messages/service.js';
import { VariableRegistry, registerCoreVariables } from '../src/messages/variables.js';

const SERVER = 'pvp1';
const OTHER = 'pve1';
const SILENT = createLogger({ log: { level: 'silent', pretty: false } });

interface Harness {
  readonly app: FastifyInstance;
  readonly db: AgentDatabase;
  readonly repository: MessagesRepository;
  /** Os gatilhos de sincronização que a rota pediu. */
  readonly synced: string[];
}

let harness: Harness | null = null;

async function buildHarness(): Promise<Harness> {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: id,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }

  const repository = new MessagesRepository(db);
  const variables = new VariableRegistry({ logger: SILENT });

  registerCoreVariables(variables, {
    nameOf: (id) => id,
    slotsOf: () => 300,
    onlineOf: () => Promise.resolve(0),
  });

  // O RCON fica DESLIGADO: estas rotas são de cadastro, e nenhuma
  // delas precisa falar com o jogo para responder.
  const rcon = { isConnected: false, send: (): Promise<string> => Promise.resolve('') };
  const context = {
    ids: () => [SERVER, OTHER],
    contextOf: (id: string) => (id === SERVER || id === OTHER ? { rcon } : null),
  };

  const service = new MessagesService({
    repository,
    broadcaster: new PluginBroadcaster({ servers: context, logger: SILENT }),
    variables,
    servers: context,
    presence: { online: () => Promise.resolve(0) },
    logger: SILENT,
  });

  const synced: string[] = [];
  const app = Fastify({ logger: false });

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

  await app.register(async (api) => {
    registerMessageRoutes(api, {
      repository,
      service,
      variables,
      supervisor: context as never,
      commands: {
        syncAll: (trigger: string): Promise<void> => {
          synced.push(trigger);
          return Promise.resolve();
        },
      },
    });
  });

  await app.ready();

  harness = { app, db, repository, synced };

  return harness;
}

afterEach(async () => {
  if (harness !== null) {
    await harness.app.close();
    harness.db.close();
    harness = null;
  }
});

async function post(app: FastifyInstance, url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, payload });
}

// ------------------------------------------------------------
//  O GATILHO
// ------------------------------------------------------------

describe('o gatilho da mensagem', () => {
  it('a agendada continua sendo o padrão de quem não escolhe nada', async () => {
    const { app } = await buildHarness();

    const response = await post(app, '/messages', {
      name: 'Discord',
      text: 'Entre no Discord',
      scheduleKind: 'interval',
      everySeconds: 1800,
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as { message: { trigger: string; nextAt: string | null } };

    expect(body.message.trigger).toBe('schedule');
    expect(body.message.nextAt).not.toBeNull();
  });

  it('a de rodízio NÃO precisa de ritmo próprio, e não ganha horário', async () => {
    const { app } = await buildHarness();

    const group = await post(app, '/messages/groups', { name: 'Dicas', everySeconds: 300 });
    const groupId = (group.json() as { group: { id: number } }).group.id;

    const response = await post(app, '/messages', {
      name: 'Dica 1',
      text: 'Use /kit',
      trigger: 'rotation',
      groupId,
      // Sem `everySeconds`: cobrar um intervalo aqui obrigaria o
      // admin a inventar um número que nunca seria lido.
      scheduleKind: 'interval',
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as { message: { nextAt: string | null; schedule: string } };

    // ####  SEM HORÁRIO PRÓPRIO  ####
    //
    // Um `next_at` gravado aqui faria a consulta do relógio enxergar
    // a mensagem, e ela sairia sozinha, fora de qualquer rodízio.
    expect(body.message.nextAt).toBeNull();
    expect(body.message.schedule).toBe('rodízio');
  });

  it('rodízio sem grupo é recusado na gravação', async () => {
    const { app } = await buildHarness();

    const response = await post(app, '/messages', {
      name: 'Dica',
      text: 'Use /kit',
      trigger: 'rotation',
      scheduleKind: 'interval',
      everySeconds: 1800,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'MESSAGE_INVALID_SCHEDULE' });
  });

  it('grupo que não existe é 404, e não uma mensagem órfã em silêncio', async () => {
    const { app } = await buildHarness();

    const response = await post(app, '/messages', {
      name: 'Dica',
      text: 'Use /kit',
      trigger: 'rotation',
      groupId: 999,
      scheduleKind: 'interval',
      everySeconds: 1800,
    });

    expect(response.statusCode).toBe(404);
  });

  it('comando sem comando é recusado', async () => {
    const { app } = await buildHarness();

    const response = await post(app, '/messages', {
      name: 'Pop',
      text: 'Agora tem {online}',
      trigger: 'command',
      scheduleKind: 'interval',
      everySeconds: 1800,
    });

    expect(response.statusCode).toBe(422);
  });

  it('comando com espaço é recusado: o Oxide corta no primeiro espaço', async () => {
    const { app } = await buildHarness();

    const response = await post(app, '/messages', {
      name: 'Pop',
      text: 'oi',
      trigger: 'command',
      command: 'ver pop',
      scheduleKind: 'interval',
      everySeconds: 1800,
    });

    expect(response.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------
//  O COMANDO
// ------------------------------------------------------------

describe('o comando de chat', () => {
  async function createCommand(
    app: FastifyInstance,
    over: Record<string, unknown> = {},
  ) {
    return post(app, '/messages', {
      name: 'População',
      text: 'Agora tem {online}/{max}',
      trigger: 'command',
      command: 'pop',
      scheduleKind: 'interval',
      everySeconds: 1800,
      ...over,
    });
  }

  it('gravar PUBLICA o comando no plugin, na hora', async () => {
    const { app, synced } = await buildHarness();

    expect((await createCommand(app)).statusCode).toBe(201);

    // Sem isto, o `/pop` recém-criado só passaria a responder na
    // próxima reconexão do RCON — e o admin concluiria que a
    // gravação não funcionou.
    expect(synced).toContain('mensagem-criada');
  });

  it('remover republica, para o comando voltar a ser desconhecido', async () => {
    const { app, synced } = await buildHarness();

    const created = await createCommand(app);
    const id = (created.json() as { message: { id: number } }).message.id;

    await app.inject({ method: 'DELETE', url: `/messages/${String(id)}` });

    expect(synced).toContain('mensagem-removida');
  });

  it('dois iguais no MESMO servidor são recusados, dizendo de quem é', async () => {
    const { app } = await buildHarness();

    await createCommand(app, { targets: [SERVER] });

    const second = await createCommand(app, { name: 'Outra', targets: [SERVER] });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'MESSAGE_COMMAND_TAKEN' });
    expect((second.json() as { message: string }).message).toContain('População');
  });

  it('dois iguais em servidores DIFERENTES convivem', async () => {
    const { app } = await buildHarness();

    await createCommand(app, { targets: [SERVER] });

    // ####  ESTE É O CASO NORMAL DE UMA REDE  ####
    //
    // A mesma frase, com os números de cada servidor. Recusar aqui
    // obrigaria o admin a inventar `/pop1` e `/pop2`.
    const second = await createCommand(app, { name: 'Outra', targets: [OTHER] });

    expect(second.statusCode).toBe(201);
  });

  it('o de alvo VAZIO colide com qualquer outro: vazio quer dizer todos', async () => {
    const { app } = await buildHarness();

    await createCommand(app, { targets: [] });

    const second = await createCommand(app, { name: 'Outra', targets: [SERVER] });

    expect(second.statusCode).toBe(409);
  });

  it('a mensagem DESLIGADA não ocupa o comando', async () => {
    const { app } = await buildHarness();

    await createCommand(app, { targets: [SERVER], enabled: false });

    // Desligar é justamente como se troca qual das duas responde ao
    // `/pop` — sem apagar a antiga e perder o texto dela.
    expect((await createCommand(app, { name: 'Outra', targets: [SERVER] })).statusCode).toBe(201);
  });

  it('editar a própria mensagem não colide com ela mesma', async () => {
    const { app } = await buildHarness();

    const created = await createCommand(app, { targets: [SERVER] });
    const id = (created.json() as { message: { id: number } }).message.id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/messages/${String(id)}`,
      payload: { text: 'Agora tem {online} de {max}' },
    });

    expect(patch.statusCode).toBe(200);
  });
});

// ------------------------------------------------------------
//  O GRUPO
// ------------------------------------------------------------

describe('o grupo de rodízio', () => {
  async function createGroup(app: FastifyInstance, over: Record<string, unknown> = {}) {
    return post(app, '/messages/groups', { name: 'Dicas', everySeconds: 300, ...over });
  }

  it('nasce com horário e com a frase pronta da coluna REPETE', async () => {
    const { app } = await buildHarness();

    const response = await createGroup(app, { order: 'random', everySeconds: 600 });

    expect(response.statusCode).toBe(201);

    const body = response.json() as { group: { schedule: string; nextAt: string | null } };

    expect(body.group.schedule).toBe('a cada 10 min, embaralhado');
    expect(body.group.nextAt).not.toBeNull();
  });

  it('um rodízio de 30 em 30 segundos é recusado: vira ruído', async () => {
    const { app } = await buildHarness();

    expect((await createGroup(app, { everySeconds: 30 })).statusCode).toBe(400);
  });

  it('trocar a ORDEM recomeça o ciclo; mexer no nome, não', async () => {
    const { app, repository } = await buildHarness();

    const created = await createGroup(app, { order: 'fixed' });
    const id = (created.json() as { group: { id: number } }).group.id;

    // Um ciclo em andamento, como o relógio o deixaria.
    repository.markGroupSent(id, 7, [3, 9], Date.now(), Date.now() + 300_000);

    await app.inject({
      method: 'PATCH',
      url: `/messages/groups/${String(id)}`,
      payload: { name: 'Dicas do servidor' },
    });

    expect(repository.getGroup(id)?.lastMessageId).toBe(7);

    await app.inject({
      method: 'PATCH',
      url: `/messages/groups/${String(id)}`,
      payload: { order: 'random' },
    });

    // A ordem fixa continua DEPOIS da última que saiu, e continuar
    // de uma frase sorteada seria começar no meio.
    expect(repository.getGroup(id)?.lastMessageId).toBeNull();
    expect(repository.getGroup(id)?.deck).toEqual([]);
  });

  it('remover o grupo NÃO apaga as mensagens dele', async () => {
    const { app, repository } = await buildHarness();

    const created = await createGroup(app);
    const groupId = (created.json() as { group: { id: number } }).group.id;

    await post(app, '/messages', {
      name: 'Dica 1',
      text: 'Use /kit',
      trigger: 'rotation',
      groupId,
      scheduleKind: 'interval',
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/messages/groups/${String(groupId)}`,
    });

    expect(removed.statusCode).toBe(200);
    // A frase diz quantas ficaram órfãs: é esse número que faz
    // alguém mudar de ideia.
    expect((removed.json() as { detail: string }).detail).toContain('1 mensagem(ns)');

    const survivors = repository.list();

    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.groupId).toBeNull();
  });

  it('a lista traz mensagens e grupos na MESMA resposta', async () => {
    const { app } = await buildHarness();

    await createGroup(app);

    const response = await app.inject({ method: 'GET', url: '/messages' });
    const body = response.json() as { messages: unknown[]; groups: unknown[] };

    expect(body.groups).toHaveLength(1);
    expect(body.messages).toHaveLength(0);
  });

  it('testar um grupo vazio diz que ele não tem o que dizer', async () => {
    const { app } = await buildHarness();

    const created = await createGroup(app);
    const id = (created.json() as { group: { id: number } }).group.id;

    const response = await post(app, `/messages/groups/${String(id)}/test`, {});

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'MESSAGE_GROUP_EMPTY' });
  });
});
