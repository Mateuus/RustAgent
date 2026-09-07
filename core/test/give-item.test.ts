// ============================================================
//  give-item.test.ts  -  o admin pondo um item na mão de alguém.
//
//  ####  O QUE ESTE ARQUIVO GUARDA  ####
//
//    1. o comando que sai no RCON é o `origemz.give` com os CINCO
//       argumentos posicionais, na ordem do plugin — um argumento
//       a menos e ele responde `INVALID_ARGS`;
//    2. o que não coube no inventário é DITO ("3 no chão"), e não
//       escondido atrás de um sucesso liso;
//    3. a entrega entra na ficha do jogador com `kind = 'item'`, e
//       essa linha só existe por causa da migração 040 — sem ela o
//       CHECK derruba o INSERT e a rota responde 500 DEPOIS de o
//       item já estar no inventário;
//    4. a recusa do plugin vira status HTTP com significado: 409
//       para "tente daqui a pouco" (morto, dormindo, cheio) e 400
//       para "conserte o pedido" — e nada é gravado na ficha;
//    5. silêncio do console é 502, e não sucesso: comando que o
//       Oxide não carregou não produz erro, produz NADA;
//    6. shortname com espaço é recusado na BORDA, sem gastar
//       comando — ele fatiaria a linha do console e a entrega
//       faria outra coisa, em silêncio.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { BanList } from '../src/bans/service.js';
import { BansRepository } from '../src/db/bans-repository.js';
import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { PlayersRepository } from '../src/db/players-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import type { MonumentReader } from '../src/game/monuments.js';
import type { PlayersReader } from '../src/game/players.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import { registerAdminRoutes } from '../src/http/routes/admin.js';
import { createLogger } from '../src/logger.js';
import { PlayerDirectory } from '../src/players/service.js';
import type { ServerContext } from '../src/servers/context.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';

const SERVER = 'pvp1';
/** Dígitos até o fim: um SteamID que sobrevive a um `Number()` não prova nada. */
const STEAM_ID = '76561198123456789';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface Harness {
  readonly app: FastifyInstance;
  readonly directory: PlayerDirectory;
  /** Tudo o que foi mandado ao console, na ordem. */
  readonly sent: string[];
}

let harness: Harness;

/**
 * Monta a rota sobre um console que responde o que o teste mandar.
 *
 * `answer` é função para poder mudar entre chamadas; `connected`
 * separa "não perguntei" de "perguntei e não gostei".
 */
function build(answer: (command: string) => string, connected = true): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // A linha em `servers` não é decoração: `player_events` tem
  // chave estrangeira para lá, com o pragma ligado.
  new ServersRepository(db).create({
    id: SERVER,
    name: SERVER,
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_018,
    installDir: `F:\\Servers\\${SERVER}`,
  });

  const repository = new PlayersRepository(db);
  const directory = new PlayerDirectory({
    repository,
    bans: new BanList({
      repository: new BansRepository(db),
      servers: { ids: () => [SERVER], contextOf: () => null },
      logger: silent,
    }),
  });

  const sent: string[] = [];
  const context = {
    rcon: {
      isConnected: connected,
      send: (command: string) => {
        sent.push(command);

        return Promise.resolve(answer(command));
      },
    },
    console: { pushLocal: () => undefined },
  } as unknown as ServerContext;

  const supervisor = {
    contextOf: () => context,
    configOf: () => ({ worldSize: 4000 }),
    ids: () => [SERVER],
  } as unknown as ServerSupervisor;

  const app = Fastify();

  // Em produção quem registra o tradutor de erro é o `buildServer`.
  // Aqui ele é repetido porque o que se testa é justamente o CÓDIGO
  // e o STATUS de cada recusa.
  app.setErrorHandler(async (error, _request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    // O corpo recusado pelo Zod é 400 em produção. Sem este ramo,
    // um shortname com espaço viraria 500 aqui e o teste da borda
    // conferiria o erro do framework, não a régua.
    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);

      return reply.status(response.statusCode).send(response.body);
    }

    throw error;
  });

  registerAdminRoutes(app, {
    supervisor,
    // A rota de entrega não lê a lista nem os monumentos.
    players: {} as unknown as PlayersReader,
    monuments: {} as unknown as MonumentReader,
    history: directory,
  });

  return { app, directory, sent };
}

/** `POST .../give` com o corpo que o teste quiser. */
function give(body: Record<string, unknown>): Promise<{ statusCode: number; json: () => never }> {
  return harness.app.inject({
    method: 'POST',
    url: `/servers/${SERVER}/players/${STEAM_ID}/give`,
    payload: body,
  }) as never;
}

/** As linhas da ficha daquele jogador. */
function fichaDe(): readonly { kind: string; detail: string | null }[] {
  return harness.directory.timeline(STEAM_ID).events;
}

describe('dar item a um jogador pelo painel', () => {
  beforeEach(() => {
    harness = build(() => '{"ok":true,"delivered":"inventory","given":500,"dropped":0}');
  });

  it('manda o origemz.give com os cinco argumentos, na ordem do plugin', async () => {
    const response = await give({ shortname: 'wood', amount: 500 });

    expect(response.statusCode).toBe(200);
    // O `skinId` e o `mode` não foram enviados pela tela: os
    // padrões da borda é que os completam. Um comando com quatro
    // argumentos volta `INVALID_ARGS`.
    expect(harness.sent).toEqual([`origemz.give ${STEAM_ID} wood 500 0 auto`]);
  });

  it('diz o que caiu no chão em vez de responder um sucesso liso', async () => {
    harness = build(() => '{"ok":true,"delivered":"mixed","given":497,"dropped":3}');

    const response = await give({ shortname: 'wood', amount: 500 });
    const body = response.json() as unknown as { given: number; dropped: number; message: string };

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ given: 497, dropped: 3 });
    // Item no chão é item de quem chegar primeiro: quem entregou
    // precisa saber disso na hora, e não pelo relato do jogador.
    expect(body.message).toContain('3 no chão');
  });

  it('grava a entrega na ficha do jogador — é a migração 040 valendo', async () => {
    await give({ shortname: 'explosive.timed', amount: 4, skinId: '3080', mode: 'auto' });

    const events = fichaDe();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('item');
    expect(events[0]?.detail).toBe('4x explosive.timed (skin 3080)');
  });

  it('a recusa do plugin vira status com significado, e a ficha fica limpa', async () => {
    harness = build(() => '{"ok":false,"error":"PLAYER_DEAD"}');

    const response = await give({ shortname: 'wood', amount: 10 });
    const body = response.json() as unknown as { error: string; message: string };

    // 409 e não 400: o pedido está certo, o jogo é que não aceita
    // AGORA. Mandar conferir a quantidade seria a resposta errada.
    expect(response.statusCode).toBe(409);
    expect(body.error).toBe('PLAYER_DEAD');
    expect(body.message).toContain('renascer');
    expect(fichaDe()).toHaveLength(0);
  });

  it('pedido impossível é 400, e o jogador ausente é 404', async () => {
    harness = build(() => '{"ok":false,"error":"TOO_MANY_STACKS"}');
    expect((await give({ shortname: 'rifle.ak', amount: 900 })).statusCode).toBe(400);

    harness = build(() => '{"ok":false,"error":"PLAYER_NOT_FOUND"}');
    expect((await give({ shortname: 'wood', amount: 10 })).statusCode).toBe(404);
  });

  it('silêncio do console é 502, e nunca sucesso', async () => {
    // O console do Rust não reclama de um comando que não conhece:
    // ele se cala. Foi assim que a aba Jogadores morreu em
    // 04/09/2026 — ver players-fonte.test.ts.
    harness = build(() => '');

    const response = await give({ shortname: 'wood', amount: 10 });

    expect(response.statusCode).toBe(502);
    expect((response.json() as unknown as { error: string }).error).toBe(
      'PLUGIN_INVALID_RESPONSE',
    );
  });

  it('shortname com espaço é recusado na borda, sem gastar comando', async () => {
    const response = await give({ shortname: 'wood 999', amount: 1 });

    expect(response.statusCode).toBe(400);
    // O ponto do teste: o RCON nem foi tocado. Uma linha de console
    // com espaço no meio do shortname faria o parser do Rust ler
    // "999" como a quantidade — e a entrega faria outra coisa.
    expect(harness.sent).toEqual([]);
  });

  it('a quantidade acima do teto do plugin não vira comando', async () => {
    const response = await give({ shortname: 'wood', amount: 100_001 });

    expect(response.statusCode).toBe(400);
    expect(harness.sent).toEqual([]);
  });

  it('sem RCON é 503 — parado não é "recusado"', async () => {
    harness = build(() => '', false);

    expect((await give({ shortname: 'wood', amount: 1 })).statusCode).toBe(503);
  });
});
