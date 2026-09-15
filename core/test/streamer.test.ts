// ============================================================
//  Testes do MODO STREAMER.
//
//  O que estes testes protegem, e não é óbvio:
//
//  1. LIGAR A LIVE NÃO APAGA O QUE O ADMIN ESCOLHEU. O jogador
//     grava `active`; as três chaves do "o que some" são de outro
//     dono, e um UPDATE que as reescrevesse devolveria a logo à
//     tela de quem acabou de tirá-la.
//
//  2. QUEM NÃO ESTÁ LIBERADO NÃO LIGA. A linha do console é o
//     jogo falando: ela pode vir de um plugin com a lista velha —
//     e o console também carrega o chat dos jogadores.
//
//  3. TIRAR A LIBERAÇÃO TIRA A LIVE JUNTO. Sem isso o jogador
//     ficaria com o overlay escondido para sempre: o comando que
//     o desligaria responde que ele não tem mais acesso.
//
//  4. A FALA DIRIGIDA NUNCA É SILENCIADA. "Sua compra caiu" é
//     resposta a algo que ele fez; engoli-la é perder a entrega,
//     e não poupar a transmissão.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StreamerRepository } from '../src/db/streamer-repository.js';
import { PluginBroadcaster } from '../src/game/broadcast.js';
import { StreamerSync } from '../src/game/streamer-sync.js';
import {
  buildStreamerScreen,
  STREAMER_TAB_ID,
  withStreamerTab,
} from '../src/game/ui-streamer-screen.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerPlayerRoutes } from '../src/http/routes/players.js';
import type { PlayerDirectory } from '../src/players/service.js';
import { defaultStreamerProfile } from '../src/types/streamer.js';
import type { UiDocument, UiElement } from '../src/types/ui-document.js';
import {
  STREAMER_MARKER,
  STREAMER_PUSH,
  isStreamerRequest,
  parseStreamerNotice,
  type StreamerPayload,
} from '../src/types/streamer-transport.js';

const SERVER = 'devserver';
const STREAMER = '76561198212421536';
const OUTRO = '76561198000000001';

const silent = undefined;

function createTestDatabase(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: SERVER,
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\devserver',
  });

  return db;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: StreamerRepository;
  readonly sync: StreamerSync;
  /** Os comandos que saíram pelo RCON de mentira. */
  readonly sent: string[];
}

let harness: Harness | null = null;

function buildHarness(options: { connected?: boolean } = {}): Harness {
  const db = createTestDatabase();
  const repository = new StreamerRepository(db);
  const sent: string[] = [];

  const sync = new StreamerSync({
    repository,
    servers: {
      ids: () => [SERVER],
      contextOf: (id: string) =>
        id === SERVER
          ? {
              rcon: {
                isConnected: options.connected ?? true,
                send: async (command: string) => {
                  sent.push(command);
                  return Promise.resolve('{"ok":true,"players":0}');
                },
              },
            }
          : null,
    },
    logger: silent,
  });

  harness = { db, repository, sync, sent };
  return harness;
}

afterEach(() => {
  if (harness !== null) {
    harness.sync.stop();
    harness.db.close();
    harness = null;
  }
});

/** O payload do último `origemz.streamer.config` que saiu. */
function lastPayload(sent: readonly string[]): StreamerPayload {
  const command = [...sent].reverse().find((line) => line.startsWith(STREAMER_PUSH));

  expect(command, 'nenhuma carga do modo streamer saiu').toBeDefined();

  const encoded = (command ?? '').slice(STREAMER_PUSH.length + 1);

  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as StreamerPayload;
}

// ------------------------------------------------------------
//  O BANCO
// ------------------------------------------------------------

describe('o perfil do streamer', () => {
  it('quem nunca foi liberado tem um perfil desligado, e não um erro', () => {
    const { repository } = buildHarness();

    const profile = repository.get(STREAMER);

    expect(profile.allowed).toBe(false);
    expect(profile.active).toBe(false);
    // As três nascem ligadas: elas só têm efeito com a liberação, e
    // quem libera um streamer quis esconder o overlay dele.
    expect(profile.hideLogo).toBe(true);
    expect(profile.hideAds).toBe(true);
    expect(profile.hideMessages).toBe(true);
    expect(profile.updatedAt).toBe(0);
  });

  it('ligar a live NÃO apaga o que o admin escolheu esconder', () => {
    const { repository } = buildHarness();

    repository.save(STREAMER, { allowed: true, hideLogo: true, hideAds: false });

    // O jogador, no jogo: só `active`.
    const depois = repository.save(STREAMER, { active: true });

    expect(depois.active).toBe(true);
    expect(depois.hideLogo).toBe(true);
    // A que o admin tinha DESMARCADO continua desmarcada.
    expect(depois.hideAds).toBe(false);
    expect(depois.allowed).toBe(true);
  });

  it('desligar a live preserva desde quando ela começou', () => {
    const { repository } = buildHarness();

    repository.save(STREAMER, { allowed: true });
    const ligado = repository.save(STREAMER, { active: true }, 1_000);

    expect(ligado.activatedAt).toBe(1_000);

    const desligado = repository.save(STREAMER, { active: false }, 2_000);

    expect(desligado.active).toBe(false);
    // A pergunta do suporte ("desde quando ele estava em live?")
    // continua tendo resposta depois que a live acaba.
    expect(desligado.activatedAt).toBe(1_000);
  });

  it('só os liberados entram nas listas', () => {
    const { repository } = buildHarness();

    repository.save(STREAMER, { allowed: true, active: true });
    repository.save(OUTRO, { allowed: false, active: true });

    expect(repository.allowed().map((p) => p.steamId)).toEqual([STREAMER]);
    expect(repository.active().map((p) => p.steamId)).toEqual([STREAMER]);
  });
});

// ------------------------------------------------------------
//  A CARGA QUE DESCE AO PLUGIN
// ------------------------------------------------------------

describe('a carga do modo streamer', () => {
  it('leva só os liberados, com o que cada um esconde', async () => {
    const { repository, sync, sent } = buildHarness();

    repository.save(STREAMER, { allowed: true, active: true, hideAds: false });
    repository.save(OUTRO, { allowed: false });

    await sync.push(SERVER, 'manual');

    const payload = lastPayload(sent);

    expect(payload.players).toHaveLength(1);
    expect(payload.players[0]).toEqual({
      id: STREAMER,
      on: true,
      logo: true,
      ads: false,
      chat: true,
    });
  });

  it('lista vazia É uma carga, e ela precisa sair', async () => {
    const { sync, sent } = buildHarness();

    await sync.push(SERVER, 'manual');

    // Sem ela o plugin ficaria com a lista de antes até o próximo
    // reinício — e alguém que perdeu a liberação seguiria com o
    // overlay escondido.
    expect(lastPayload(sent).players).toEqual([]);
  });

  it('não repete a mesma carga, mas repete quando o plugin pede', async () => {
    const { repository, sync, sent } = buildHarness();

    repository.save(STREAMER, { allowed: true });

    await sync.push(SERVER, 'manual');
    const primeira = sent.length;

    await sync.push(SERVER, 'manual');
    expect(sent.length, 'a carga igual foi reenviada à toa').toBe(primeira);

    // O plugin perdeu o cache: aqui o dedup não vale.
    await sync.push(SERVER, 'plugin-requested');
    expect(sent.length).toBe(primeira + 1);
  });

  it('sem RCON não envia, e não quebra', async () => {
    const { repository, sync, sent } = buildHarness({ connected: false });

    repository.save(STREAMER, { allowed: true });

    const outcome = await sync.push(SERVER, 'manual');

    expect(outcome.status).toBe('skipped');
    expect(sent).toEqual([]);
  });
});

// ------------------------------------------------------------
//  O QUE VOLTA DO JOGO
// ------------------------------------------------------------

describe('o /streamer do jogador', () => {
  it('a linha do plugin liga o modo no banco', () => {
    const { repository, sync } = buildHarness();

    repository.save(STREAMER, { allowed: true });

    sync.handleLine(
      SERVER,
      `[OrigemZUI] ${STREAMER_MARKER}{"steamId":"${STREAMER}","on":true,"name":"Cabeto"}`,
    );

    expect(repository.get(STREAMER).active).toBe(true);
  });

  it('quem NÃO está liberado não liga nada', () => {
    const { repository, sync } = buildHarness();

    sync.handleLine(SERVER, `[OrigemZUI] ${STREAMER_MARKER}{"steamId":"${STREAMER}","on":true}`);

    expect(repository.get(STREAMER).active).toBe(false);
  });

  it('a linha sem o prefixo do plugin é ignorada', () => {
    const { repository, sync } = buildHarness();

    repository.save(STREAMER, { allowed: true });

    // É o chat de um jogador aparecendo no console: o marcador está
    // lá, mas não no começo da linha.
    sync.handleLine(
      SERVER,
      `[CHAT] Cabeto: olha ${STREAMER_MARKER}{"steamId":"${STREAMER}","on":true}`,
    );

    expect(repository.get(STREAMER).active).toBe(false);
  });

  it('o marcador é reconhecido com e sem o prefixo do Oxide', () => {
    expect(parseStreamerNotice(`${STREAMER_MARKER}{"steamId":"1","on":false}`)?.active).toBe(false);
    expect(parseStreamerNotice(`[OrigemZUI] ${STREAMER_MARKER}{"steamId":"1","on":true}`)).not.toBe(
      null,
    );
    expect(parseStreamerNotice('linha qualquer do console')).toBe(null);
    expect(isStreamerRequest('[OrigemZUI] #OZAREQ#streamer')).toBe(true);
    expect(isStreamerRequest('#OZAREQ#items')).toBe(false);
  });
});

// ------------------------------------------------------------
//  O CHAT
// ------------------------------------------------------------

describe('o silêncio no chat', () => {
  function broadcasterFor(muted: readonly string[], sent: string[]) {
    return new PluginBroadcaster({
      servers: {
        contextOf: () => ({
          rcon: {
            isConnected: true,
            send: async (command: string) => {
              sent.push(command);
              return Promise.resolve('{"ok":true,"sent":3}');
            },
          },
        }),
      },
      mutedPlayers: () => muted,
    });
  }

  /** O payload do `origemz.chat.broadcast`, decodificado. */
  function payloadOf(command: string): Record<string, unknown> {
    const encoded = command.slice(command.indexOf(' ') + 1);
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
  }

  it('o anúncio global pula quem está em live', async () => {
    const sent: string[] = [];

    await broadcasterFor([STREAMER], sent).send({ serverId: SERVER, text: 'wipe em 15 min' });

    expect(payloadOf(sent[0] ?? '').skip).toEqual([STREAMER]);
  });

  it('o recado DIRIGIDO nunca é silenciado', async () => {
    const sent: string[] = [];

    await broadcasterFor([STREAMER], sent).send({
      serverId: SERVER,
      text: 'sua compra caiu',
      steamId: STREAMER,
    });

    // Ele está em live E é o destinatário: a fala tem de sair
    // inteira, porque é resposta a algo que ele fez.
    expect(payloadOf(sent[0] ?? '').skip).toEqual([]);
  });

  it('uma falha ao ler quem está em live não cala o servidor', async () => {
    const sent: string[] = [];

    const broadcaster = new PluginBroadcaster({
      servers: {
        contextOf: () => ({
          rcon: {
            isConnected: true,
            send: async (command: string) => {
              sent.push(command);
              return Promise.resolve('{"ok":true,"sent":1}');
            },
          },
        }),
      },
      mutedPlayers: () => {
        throw new Error('banco fora do ar');
      },
    });

    await broadcaster.send({ serverId: SERVER, text: 'servidor reiniciando' });

    expect(payloadOf(sent[0] ?? '').skip).toEqual([]);
  });
});

// ------------------------------------------------------------
//  A FICHA
// ------------------------------------------------------------

describe('a rota da ficha', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.close();
      app = null;
    }
  });

  async function buildApp(): Promise<{ app: FastifyInstance; repository: StreamerRepository }> {
    const { repository, sync } = buildHarness();

    const instance = Fastify({ logger: false });

    instance.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof ZodError) {
        const response = zodErrorToResponse(error);
        return reply.status(response.statusCode).send(response.body);
      }

      if (isApiError(error)) {
        const response = apiErrorToResponse(error);
        return reply.status(response.statusCode).send(response.body);
      }

      return reply.status(500).send({ ok: false, message: String(error) });
    });

    await instance.register(async (api) => {
      registerPlayerRoutes(api, {
        // As rotas do modo streamer não tocam no diretório; as
        // outras têm teste próprio.
        directory: {} as unknown as PlayerDirectory,
        streamer: repository,
        streamerSync: sync,
      });
    });

    await instance.ready();

    app = instance;
    return { app: instance, repository };
  }

  it('a ficha de quem nunca foi liberado responde 200', async () => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({ method: 'GET', url: `/players/${STREAMER}/streamer` });

    expect(response.statusCode).toBe(200);
    expect(response.json().streamer.allowed).toBe(false);
    // Nunca teve linha: a data vem nula, e não como 1970.
    expect(response.json().streamer.updatedAt).toBe(null);
  });

  it('tirar a liberação desliga a live junto', async () => {
    const { app: instance, repository } = await buildApp();

    repository.save(STREAMER, { allowed: true, active: true });

    const response = await instance.inject({
      method: 'PUT',
      url: `/players/${STREAMER}/streamer`,
      payload: { allowed: false },
    });

    expect(response.statusCode).toBe(200);
    // Sem isto ele ficaria com o overlay escondido para sempre: o
    // `/streamer` que o desligaria responde que não há acesso.
    expect(response.json().streamer.active).toBe(false);
    expect(repository.get(STREAMER).active).toBe(false);
  });

  it('salvar uma chave não mexe nas outras', async () => {
    const { app: instance, repository } = await buildApp();

    repository.save(STREAMER, { allowed: true, active: true, hideLogo: true, hideAds: true });

    await instance.inject({
      method: 'PUT',
      url: `/players/${STREAMER}/streamer`,
      payload: { hideAds: false },
    });

    const profile = repository.get(STREAMER);

    expect(profile.hideAds).toBe(false);
    expect(profile.hideLogo).toBe(true);
    expect(profile.active).toBe(true);
  });

  it('campo desconhecido é 400, e não algo ignorado em silêncio', async () => {
    const { app: instance } = await buildApp();

    const response = await instance.inject({
      method: 'PUT',
      url: `/players/${STREAMER}/streamer`,
      payload: { hideEverything: true },
    });

    expect(response.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------
//  A ABA DO MENU
// ------------------------------------------------------------

describe('a aba CONFIGURAÇÕES do menu', () => {
  /** Todo botão da tela, com o comando que ele roda. */
  function buttonsOf(elements: readonly UiElement[]): { id: string; command: string }[] {
    const out: { id: string; command: string }[] = [];

    const walk = (list: readonly UiElement[]): void => {
      for (const element of list) {
        if (element.type === 'button' && element.action.kind === 'chat') {
          out.push({ id: element.id, command: element.action.command });
        }

        walk(element.children);
      }
    };

    walk(elements);
    return out;
  }

  it('o liberado vê os quatro interruptores, e cada um roda o seu comando', () => {
    const screen = buildStreamerScreen({
      profile: { ...defaultStreamerProfile(STREAMER), allowed: true, active: true },
    });

    const commands = buttonsOf(screen.elements).map((entry) => entry.command);

    // O geral e os três itens. São `chat` de propósito: o mesmo
    // caminho de quem digita, e por isso a tela não precisa de
    // nenhuma ação nova do lado do plugin.
    expect(commands).toEqual(['/streamer', '/streamer logo', '/streamer ads', '/streamer chat']);
  });

  it('quem não foi liberado não tem botão nenhum para clicar', () => {
    const screen = buildStreamerScreen({ profile: defaultStreamerProfile(STREAMER) });

    expect(buttonsOf(screen.elements)).toEqual([]);
    // E a tela não fica vazia: ela diz o que fazer.
    expect(JSON.stringify(screen.elements)).toContain('liberado pela administração');
  });

  it('a carga diz ao plugin qual botão só os liberados enxergam', async () => {
    const { repository, sync, sent } = buildHarness();

    repository.save(STREAMER, { allowed: true });

    await sync.push(SERVER, 'manual');

    expect(lastPayload(sent).tab).toBe(STREAMER_TAB_ID);
  });
});

describe('o menu que já estava gravado', () => {
  /** Um documento com barra de navegação, como o preset monta. */
  function menuWithNav(): UiDocument {
    const navButton = (id: string, x: number): UiElement => ({
      id,
      name: id,
      type: 'button',
      rect: {
        anchorMin: { x: 0, y: 0.5 },
        anchorMax: { x: 0, y: 0.5 },
        offsetMin: { x, y: -12 },
        offsetMax: { x: x + 60, y: 12 },
      },
      color: '#1B1B1B',
      sprite: null,
      text: id.toUpperCase(),
      fontSize: 12,
      font: 'RobotoCondensed-Bold.ttf',
      textColor: '#E8E8E8',
      align: 'MiddleCenter',
      action: { id: `ir-${id}`, kind: 'navigate', screenId: `tela-${id}` },
      hoverColor: null,
      pressedColor: null,
      activeColor: null,
      activeTextColor: null,
      activeOnScreenId: null,
      children: [],
    });

    return {
      id: 'menu',
      slug: 'menu',
      name: 'Menu',
      command: 'menu',
      permission: null,
      layer: 'Overlay',
      cursor: true,
      blur: true,
      shortcuts: [],
      shell: [
        {
          id: 'barra',
          name: 'barra',
          type: 'panel',
          rect: {
            anchorMin: { x: 0, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 0, y: -40 },
            offsetMax: { x: 0, y: 0 },
          },
          color: '#1B1B1B',
          sprite: null,
          imageType: 'Simple',
          material: null,
          children: [navButton('nav-home', 0), navButton('nav-discord', 70)],
        },
      ],
      screens: [],
    } as unknown as UiDocument;
  }

  it('a aba entra depois do último botão da barra, copiando o vizinho', () => {
    const upgraded = withStreamerTab(menuWithNav());

    expect(upgraded).not.toBe(null);

    const bar = upgraded?.shell[0];
    const ids = bar?.children.map((child) => child.id);

    // Depois do DISCORD, e não no meio da barra.
    expect(ids).toEqual(['nav-home', 'nav-discord', STREAMER_TAB_ID]);

    const tab = bar?.children[2];

    // À direita do vizinho, nunca por cima dele.
    expect(tab?.rect.offsetMin.x).toBeGreaterThan(130);
    expect(upgraded?.screens.some((screen) => screen.id === 'tela-config')).toBe(true);
  });

  it('rodar duas vezes não duplica a aba', () => {
    const once = withStreamerTab(menuWithNav());

    expect(once).not.toBe(null);
    // O boot roda isto em TODO documento, a cada subida.
    expect(withStreamerTab(once as UiDocument)).toBe(null);
  });

  it('menu sem barra de navegação fica intocado', () => {
    const document = { ...menuWithNav(), shell: [] } as unknown as UiDocument;

    // Desenhar uma barra onde ninguém pediu seria escrever por cima
    // do trabalho de quem fez o menu.
    expect(withStreamerTab(document)).toBe(null);
  });
});
