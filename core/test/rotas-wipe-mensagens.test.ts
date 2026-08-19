// ============================================================
//  rotas-wipe-mensagens.test.ts  -  a ARVORE DE ROTAS sobe junta.
//
//  ####  POR QUE ESTE TESTE EXISTE  ####
//
//  As tres frentes desta onda (a agenda do wipe, a fila de mapas e
//  as mensagens) foram construidas em arvores separadas, e cada uma
//  registrou rotas sob o MESMO prefixo `/api`. Nenhuma delas subiu
//  um Fastify: o repositorio testa repositorio e funcao pura.
//
//  A consequencia e uma classe de defeito que so aparece DEPOIS do
//  merge, e que nao aparece no typecheck: duas frentes declarando o
//  mesmo caminho, ou o mesmo lugar da URL com nomes de parametro
//  diferentes (`/servers/:id/...` de um lado e `/servers/:serverId/...`
//  do outro). O `find-my-way` recusa as duas coisas em
//  `app.ready()` - ou seja, na SUBIDA do agente, e nao aqui.
//
//  Este teste faz a subida acontecer no CI. Ele nao confere regra
//  de negocio nenhuma: quem faz isso sao os testes de cada frente.
//  Ele responde uma pergunta so, e ela e da integracao - "as rotas
//  de todas as frentes cabem na mesma arvore?".
//
//  ####  E POR QUE ELE PERGUNTA COM O BANCO VAZIO  ####
//
//  Porque e assim que a tela abre na primeira vez. Um 500 aqui
//  seria a tela de wipe quebrando no dia da instalacao, antes de
//  alguem ter agendado coisa alguma.
// ============================================================

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { MessagesRepository } from '../src/db/messages-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import { registerMessageRoutes } from '../src/http/routes/messages.js';
import { registerWipeMapsRoutes } from '../src/http/routes/wipe-maps.js';
import { registerWipeRoutes } from '../src/http/routes/wipe.js';
import { MessagesService } from '../src/messages/service.js';
import { VariableRegistry } from '../src/messages/variables.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';

const SERVER = 'pvp1';

/**
 * O supervisor, reduzido ao que estas rotas perguntam a ele.
 *
 * As tres so chamam `ids()`, e so para dizer "esse servidor nao
 * existe" com a lista dos que existem. Montar o supervisor de
 * verdade traria processo, RCON e disco para um teste que fala de
 * roteamento.
 */
const supervisor = { ids: () => [SERVER] } as unknown as ServerSupervisor;

function buildApi() {
  const db = openDatabase({ file: MEMORY_DATABASE });
  runMigrations(db);

  const app = Fastify();
  const messagesRepository = new MessagesRepository(db);
  const variables = new VariableRegistry();

  const service = new MessagesService({
    repository: messagesRepository,
    // Nada aqui fala com o jogo: as rotas exercitadas so LEEM.
    broadcaster: { send: () => Promise.resolve({ sent: 0, via: 'say' as const }) },
    variables,
    servers: { ids: () => [SERVER], contextOf: () => null },
    presence: { online: () => Promise.resolve(null) },
  });

  void app.register(
    async (api) => {
      registerWipeRoutes(api, { repository: new WipeScheduleRepository(db), supervisor });
      registerWipeMapsRoutes(api, { repository: new MapPoolRepository(db), supervisor });
      registerMessageRoutes(api, { repository: messagesRepository, service, variables, supervisor });

      return Promise.resolve();
    },
    { prefix: '/api' },
  );

  return { app, db };
}

describe('as rotas do wipe e das mensagens, na mesma arvore', () => {
  it('sobem juntas sob /api, sem caminho repetido nem parametro divergente', async () => {
    const { app, db } = buildApi();

    // O `ready()` E o teste: e nele que o find-my-way monta a
    // arvore e recusa colisao. Um `expect` depois seria tarde.
    await expect(app.ready()).resolves.toBeDefined();

    const rotas = app.printRoutes({ commonPrefix: false });

    expect(rotas).toContain('/api/servers/:id/wipe/settings');
    expect(rotas).toContain('/api/servers/:id/wipe/plans');
    expect(rotas).toContain('/api/servers/:id/wipe/maps');
    expect(rotas).toContain('/api/messages');

    await app.close();
    db.close();
  });

  it('com o banco recem-criado, as tres telas abrem em vez de dar 500', async () => {
    const { app, db } = buildApi();
    await app.ready();

    const settings = await app.inject(`/api/servers/${SERVER}/wipe/settings`);
    const plans = await app.inject(`/api/servers/${SERVER}/wipe/plans`);
    const maps = await app.inject(`/api/servers/${SERVER}/wipe/maps`);
    const messages = await app.inject('/api/messages');

    expect([settings.statusCode, plans.statusCode, maps.statusCode, messages.statusCode]).toEqual([
      200, 200, 200, 200,
    ]);

    // O `now` da agenda e o relogio do AGENTE, e a tela conta a
    // regressiva a partir dele. Sem ele a contagem usaria o relogio
    // do navegador, que e de quem esta olhando, e nao de quem vai
    // parar o servidor.
    expect(settings.json<{ now: number }>().now).toBeGreaterThan(0);

    // Fila vazia responde "vou sortear", e nao "nao ha mapa": a
    // diferenca e entre um wipe travado e um que resolve sozinho.
    expect(maps.json<{ next: unknown; willDraw: boolean }>()).toMatchObject({
      next: null,
      willDraw: true,
    });

    await app.close();
    db.close();
  });

  it('servidor que nao existe e recusado pelas rotas de servidor', async () => {
    const { app, db } = buildApi();
    await app.ready();

    const settings = await app.inject('/api/servers/naoexiste/wipe/settings');
    const maps = await app.inject('/api/servers/naoexiste/wipe/maps');

    expect(settings.statusCode).toBe(404);
    expect(maps.statusCode).toBe(404);

    await app.close();
    db.close();
  });
});
