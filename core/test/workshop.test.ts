// ============================================================
//  O catálogo de skins do Steam Workshop, do lado do agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Esta feature falha CALADA por natureza: o servidor aceita
//  qualquer `ulong` em `item.skin` e nunca reclama (MEDIDO, §2.2 do
//  levantamento). Um catálogo errado não derruba nada — o item
//  simplesmente nasce vanilla, e ninguém descobre até um jogador
//  perguntar por que não recebeu a pedra com a logo.
//
//  Os casos abaixo são os que produzem esse silêncio:
//
//    aviso forjado          um jogador digita `#OZWORKSHOP#` no
//                           chat e o agente acredita nele
//    catálogo grande demais  o comando é truncado e o plugin troca
//                           um cache bom por meio catálogo que ele
//                           acredita ser completo
//    skin fora do UInt64    o número é aceito no cadastro, vira
//                           outro número na rede e não desenha
//                           arte nenhuma
//    skin desligada no push  o admin desligou a skin no painel e o
//                           item continua nascendo com ela
//    junção ignorada        a skin de um servidor desce em todos,
//                           ou não desce em nenhum
//    streamer esquecido     o `/streamer` liga e a logo continua
//                           nascendo na mão de quem está no ar
//    comando de dentro do gancho  a linha volta pelo console e o
//                           agente entra em laço com ele mesmo
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { StreamerRepository } from '../src/db/streamer-repository.js';
import { WorkshopSkinsRepository } from '../src/db/workshop-repository.js';
import { decodePushPayload, MAX_PUSH_BYTES } from '../src/game/plugin-push.js';
import {
  WorkshopCommandError,
  WorkshopService,
  WORKSHOP_MARKER,
  WORKSHOP_SYNC,
} from '../src/game/workshop.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerWorkshopRoutes } from '../src/http/routes/workshop.js';
import { STREAMER_MARKER } from '../src/types/streamer-transport.js';
import {
  normalizePermission,
  workshopSkinBodySchema,
  type WorkshopPayload,
  type WorkshopSkinInput,
} from '../src/types/workshop.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const OTHER = 'server02';

interface Harness {
  readonly service: WorkshopService;
  readonly skins: WorkshopSkinsRepository;
  readonly streamers: StreamerRepository;
  /** Todo comando que saiu pelo RCON, na ordem. */
  readonly sent: string[];
  /** Prefixo do comando -> a resposta que o "plugin" dá. */
  readonly replies: Map<string, string>;
  connected: boolean;
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: `Dev ${String(index + 1)}`,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }

  const skins = new WorkshopSkinsRepository(db);
  const streamers = new StreamerRepository(db);

  const state: Harness = {
    service: null as unknown as WorkshopService,
    skins,
    streamers,
    sent: [],
    replies: new Map([
      [WORKSHOP_SYNC, JSON.stringify({ ok: true, count: 0 })],
      ['origemz.workshop.status', JSON.stringify({ ok: true, skins: 0, streamers: 0 })],
    ]),
    connected: true,
  };

  const rcon = {
    get isConnected() {
      return state.connected;
    },
    send: (command: string) => {
      state.sent.push(command);

      for (const [prefix, reply] of state.replies) {
        if (command.startsWith(prefix)) return Promise.resolve(reply);
      }

      return Promise.resolve('');
    },
  };

  const service = new WorkshopService({
    skins,
    streamers,
    servers: {
      ids: () => [SERVER, OTHER],
      contextOf: () => ({ rcon }),
    },
    logger: silent,
  });

  return Object.assign(state, { service });
}

/** Um cadastro completo, pelo mesmo caminho que a rota usa. */
function input(patch: Record<string, unknown> = {}): WorkshopSkinInput {
  return workshopSkinBodySchema.parse({
    label: 'Pedra OrigemZ',
    shortname: 'rock',
    skinId: '3071657601',
    servers: [SERVER],
    ...patch,
  });
}

/** A carga do último `sync` que saiu naquele servidor. */
function lastPayload(h: Harness): WorkshopPayload {
  const command = [...h.sent].reverse().find((line) => line.startsWith(WORKSHOP_SYNC));

  if (command === undefined) throw new Error('nenhum sync saiu');

  return decodePushPayload(command.slice(WORKSHOP_SYNC.length + 1)) as WorkshopPayload;
}

/** O segredo desta sessão, lido do comando que saiu. */
async function grabSecret(h: Harness): Promise<string> {
  await h.service.sync(SERVER, 'manual');

  return lastPayload(h).secret;
}

/** Deixa os relógios de `syncSoon` (1 s) dispararem. */
async function waitForSoon(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

// ============================================================
//  A RÉGUA DO CADASTRO
// ============================================================

describe('a marca', () => {
  it('skin acima do teto de UInt64 é recusada', () => {
    const h = harness();

    // 20 dígitos, e maior que 18446744073709551615. Ele passa na
    // régua de formato e morre no teto — que é justamente o caso
    // que um regex sozinho deixaria entrar.
    expect(() => h.skins.add(input({ skinId: '99999999999999999999' }))).toThrow();

    // E o teto EXATO passa: uma régua que recusa o maior id
    // possível recusaria arte legítima.
    expect(h.skins.add(input({ skinId: '18446744073709551615' })).skinId).toBe(
      '18446744073709551615',
    );
  });

  it('skin zero, vazia ou com zero à esquerda é recusada', () => {
    const h = harness();

    // Zero é indistinguível de item comum, e num item sem skins
    // derruba o jogador pelo caminho do CUI.
    expect(() => h.skins.add(input({ skinId: '0' }))).toThrow();
    expect(() => h.skins.add(input({ skinId: '' }))).toThrow();
    // Dois textos para o mesmo número furariam o índice único.
    expect(() => h.skins.add(input({ skinId: '0307' }))).toThrow();
  });

  it('a mesma marca duas vezes é recusada pelo banco', () => {
    const h = harness();

    h.skins.add(input());

    // Mesmo item, mesma skin, outro nome e outra permissão: o que
    // colide é a MARCA, e é ela que o plugin usa para saber o que
    // está vendo.
    expect(() =>
      h.skins.add(input({ label: 'Outra pedra', permission: 'origemzworkshop.outra' })),
    ).toThrow();
  });

  it('duas skins não dividem a mesma permissão', () => {
    const h = harness();

    h.skins.add(input());

    expect(() =>
      h.skins.add(
        input({ label: 'Machado', shortname: 'hatchet', skinId: '999', permission: 'Pedra OrigemZ' }),
      ),
    ).toThrow();
  });
});

describe('a permissão', () => {
  it('nasce do nome quando o painel a omite', () => {
    // "Pedra OrigemZ" vira `origemzworkshop.pedra-origemz`: quem
    // digita a permissão à mão em toda skin erra uma letra e
    // descobre semanas depois.
    expect(input().permission).toBe('origemzworkshop.pedra-origemz');
  });

  it('o prefixo entra uma vez só, venha ele ou não', () => {
    expect(normalizePermission('pedra')).toBe('origemzworkshop.pedra');
    expect(normalizePermission('origemzworkshop.pedra')).toBe('origemzworkshop.pedra');
    // Idempotente: o repositório revalida o que já gravou, e uma
    // segunda passada não pode dobrar o prefixo.
    expect(normalizePermission(normalizePermission('Pedra'))).toBe('origemzworkshop.pedra');
  });

  it('acento e espaço somem: ela atravessa o console do Rust', () => {
    // O espaço separa argumentos no parser de console, e o acento
    // depende do encoding dele.
    expect(normalizePermission('Pedra Sagrada')).toBe('origemzworkshop.pedra-sagrada');
    expect(normalizePermission('Troféu')).toBe('origemzworkshop.trofeu');
  });
});

// ============================================================
//  O QUE DESCE PARA O JOGO
// ============================================================

describe('a carga', () => {
  it('leva a marca, a permissão e a régua de streamer', async () => {
    const h = harness();

    h.skins.add(input({ hideInStreamer: true }));

    await h.service.sync(SERVER, 'manual');

    const payload = lastPayload(h);

    expect(payload.skins).toHaveLength(1);
    expect(payload.skins[0]).toMatchObject({
      shortname: 'rock',
      // TEXTO, e não número: 20 dígitos não cabem no `number` do JS
      // sem perder precisão.
      skinId: '3071657601',
      permission: 'origemzworkshop.pedra-origemz',
      hideInStreamer: true,
      enabled: true,
    });
  });

  it('a skin DESLIGADA não vai no push', async () => {
    const h = harness();

    h.skins.add(input({ label: 'Pedra', enabled: true }));
    h.skins.add(input({ label: 'Machado', shortname: 'hatchet', skinId: '42', enabled: false }));

    await h.service.sync(SERVER, 'manual');

    const payload = lastPayload(h);

    // Desligar é o que tira a skin de circulação sem perder a marca
    // — e se ela continuasse descendo, o botão do painel não faria
    // nada e ninguém saberia por quê.
    expect(payload.skins.map((skin) => skin.shortname)).toEqual(['rock']);
    // A linha continua no catálogo: desligar não é apagar.
    expect(h.skins.list()).toHaveLength(2);
  });

  it('a junção decide quem recebe o quê', async () => {
    const h = harness();

    h.skins.add(input({ label: 'So do um', servers: [SERVER] }));
    h.skins.add(input({ label: 'So do dois', shortname: 'hatchet', skinId: '42', servers: [OTHER] }));
    h.skins.add(
      input({ label: 'Dos dois', shortname: 'pickaxe', skinId: '43', servers: [SERVER, OTHER] }),
    );
    // Sem servidor nenhum: cadastrada e em lugar nenhum. É a regra
    // herdada da migração 041 — uma skin recém-cadastrada que já
    // valesse em tudo entraria em produção sem ninguém mandar.
    h.skins.add(input({ label: 'De ninguem', shortname: 'spear.wooden', skinId: '44', servers: [] }));

    await h.service.sync(SERVER, 'manual');
    const first = lastPayload(h).skins.map((skin) => skin.shortname).sort();

    await h.service.sync(OTHER, 'manual');
    const second = lastPayload(h).skins.map((skin) => skin.shortname).sort();

    expect(first).toEqual(['pickaxe', 'rock']);
    expect(second).toEqual(['hatchet', 'pickaxe']);
  });

  it('o `setServers` muda onde ela vale sem tocar no resto', async () => {
    const h = harness();

    const skin = h.skins.add(input({ servers: [SERVER] }));

    expect(h.skins.setServers(skin.id, [OTHER])).toEqual([OTHER]);

    await h.service.sync(SERVER, 'manual');
    expect(lastPayload(h).skins).toHaveLength(0);

    await h.service.sync(OTHER, 'manual');
    expect(lastPayload(h).skins).toHaveLength(1);
    // E o cadastro continua o mesmo: a tela do servidor marca uma
    // caixa, e não reescreve a skin.
    expect(h.skins.get(skin.id)?.label).toBe('Pedra OrigemZ');
  });

  it('apagar a skin a tira do push — e do catálogo', async () => {
    const h = harness();

    const skin = h.skins.add(input());

    expect(h.skins.remove(skin.id)).toBe(true);

    await h.service.sync(SERVER, 'manual');

    // A cascata levou a junção junto: sem ela, o `listForServer`
    // devolveria uma linha que não existe mais.
    expect(lastPayload(h).skins).toHaveLength(0);
    expect(h.skins.list()).toHaveLength(0);
  });

  it('catálogo acima de 50 KB é recusado INTEIRO, e nada sai', async () => {
    const h = harness();

    // ####  MEIO CATÁLOGO É PIOR QUE CATÁLOGO VELHO  ####
    //
    // O plugin substitui o cache inteiro ao aplicar. Um comando
    // truncado o faria trocar uma lista boa por uma incompleta que
    // ele acredita ser completa — jogadores perdendo a skin, e
    // nada no log dizendo por quê.
    for (let index = 0; index < 500; index += 1) {
      h.skins.add(
        input({
          label: `Skin numero ${String(index)} com nome comprido para encher o frame`,
          shortname: `item.numero.${String(index)}`,
          skinId: String(3_000_000_000 + index),
          permission: `permissao-numero-${String(index)}`,
        }),
      );
    }

    const outcome = await h.service.sync(SERVER, 'manual');

    expect(outcome.status).toBe('pushed');
    expect(outcome.status === 'pushed' && outcome.outcome.status).toBe('refused');
    expect(
      outcome.status === 'pushed' && outcome.outcome.status === 'refused' && outcome.outcome.bytes,
    ).toBeGreaterThan(MAX_PUSH_BYTES);

    // O que importa: NENHUM comando saiu. O plugin fica com o que
    // tinha (velho, mas íntegro).
    expect(h.sent.filter((line) => line.startsWith(WORKSHOP_SYNC))).toHaveLength(0);
  });

  it('sem RCON não é erro: ele é pulado e reenviado depois', async () => {
    const h = harness();

    h.skins.add(input());
    h.connected = false;

    const outcome = await h.service.sync(SERVER, 'manual');

    expect(outcome.status).toBe('skipped');
    expect(h.sent).toHaveLength(0);
  });

  it('não reenvia o que não mudou, mas reenvia para quem acabou de subir', async () => {
    const h = harness();

    h.skins.add(input());

    await h.service.sync(SERVER, 'manual');
    expect(await h.service.sync(SERVER, 'manual')).toEqual({ status: 'unchanged' });

    // O plugin que acabou de subir NÃO tem carga nenhuma: um
    // "não mudou nada" o deixaria vazio até alguém editar a tela.
    expect((await h.service.sync(SERVER, 'plugin-requested')).status).toBe('pushed');
  });
});

// ============================================================
//  O MODO STREAMER
// ============================================================

describe('os streamers', () => {
  it('só quem está LIBERADO, LIGADO e escondendo a logo entra na lista', async () => {
    const h = harness();

    h.skins.add(input());

    // Liberado e no ar, escondendo a logo: é ele.
    h.streamers.save('76561190000000001', { allowed: true, active: true, hideLogo: true });
    // Liberado, mas fora do ar.
    h.streamers.save('76561190000000002', { allowed: true, active: false, hideLogo: true });
    // No ar, mas escondendo só a propaganda — o acordo de quem
    // divulga o servidor é manter a logo.
    h.streamers.save('76561190000000003', { allowed: true, active: true, hideLogo: false });
    // Ligou sem liberação: o plugin está com a lista velha.
    h.streamers.save('76561190000000004', { allowed: false, active: true, hideLogo: true });

    await h.service.sync(SERVER, 'manual');

    expect(lastPayload(h).streamers).toEqual(['76561190000000001']);
  });

  it('o `/streamer` de um jogador reenvia o catálogo — e por um relógio', async () => {
    const h = harness();

    h.skins.add(input());
    h.streamers.save('76561190000000001', { allowed: true, active: false, hideLogo: true });

    await h.service.sync(SERVER, 'manual');
    expect(lastPayload(h).streamers).toEqual([]);

    // Ele ligou. Quem grava é o StreamerSync, no mesmo gancho de
    // console; aqui simulamos a escrita e a linha.
    h.streamers.save('76561190000000001', { active: true });

    const antes = h.sent.length;

    h.service.handleLine(
      SERVER,
      `[OrigemZUI] ${STREAMER_MARKER}{"steamId":"76561190000000001","on":true}`,
    );

    // ####  NADA SAI DE DENTRO DO GANCHO  ####
    //
    // Um comando mandado daqui imprime no console, a linha volta e
    // dispara de novo. O envio sai do relógio.
    expect(h.sent).toHaveLength(antes);

    await waitForSoon();

    expect(lastPayload(h).streamers).toEqual(['76561190000000001']);
  });
});

// ============================================================
//  O SEGREDO
// ============================================================

describe('o segredo', () => {
  it('desce dentro do sync', async () => {
    const h = harness();

    const secret = await grabSecret(h);

    expect(secret).not.toBe('');
  });

  it('o `ready` vem SEM segredo e faz o catálogo descer', async () => {
    const h = harness();

    h.skins.add(input());

    const antes = h.sent.length;

    h.service.handleLine(SERVER, `[OrigemZ Workshop] ${WORKSHOP_MARKER}{"kind":"ready"}`);

    // De novo: nada sai de dentro do gancho.
    expect(h.sent).toHaveLength(antes);

    await waitForSoon();

    expect(lastPayload(h).skins).toHaveLength(1);
  });

  it('aviso com segredo forjado é DESCARTADO', async () => {
    const h = harness();

    await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ Workshop] ${WORKSHOP_MARKER}{"kind":"applied","count":99,"secret":"chutei"}`,
    );

    // O agente não acredita: se acreditasse, a tela diria que o
    // plugin tem 99 skins de pé porque alguém digitou isso.
    expect(h.service.appliedCount(SERVER)).toBeNull();
  });

  it('com o segredo certo, o aviso vale', async () => {
    const h = harness();

    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ Workshop] ${WORKSHOP_MARKER}{"kind":"applied","count":3,"secret":"${secret}"}`,
    );

    expect(h.service.appliedCount(SERVER)).toBe(3);
  });

  it('a linha de CHAT não passa, nem com o segredo certo', async () => {
    const h = harness();

    const secret = await grabSecret(h);

    // O nome de quem falou vem antes do marcador, e a âncora do
    // regex exige o marcador no começo (depois de no máximo dois
    // prefixos entre colchetes). Sem isso, qualquer jogador
    // forjaria um aviso digitando no chat.
    h.service.handleLine(
      SERVER,
      `[CHAT] Fulano: ${WORKSHOP_MARKER}{"kind":"applied","count":99,"secret":"${secret}"}`,
    );

    expect(h.service.appliedCount(SERVER)).toBeNull();
  });

  it('linha quebrada não derruba o agente', () => {
    const h = harness();

    expect(() => {
      h.service.handleLine(SERVER, `[OrigemZ Workshop] ${WORKSHOP_MARKER}{isto nao e json`);
      h.service.handleLine(SERVER, `[OrigemZ Workshop] ${WORKSHOP_MARKER}`);
      h.service.handleLine(SERVER, `[OrigemZ Workshop] ${WORKSHOP_MARKER}"so um texto"`);
      h.service.handleLine(SERVER, 'uma linha qualquer do console');
    }).not.toThrow();
  });
});

// ============================================================
//  PERGUNTAR AO JOGO
// ============================================================

describe('o status', () => {
  it('lê o que o plugin responde', async () => {
    const h = harness();

    h.replies.set(
      'origemz.workshop.status',
      JSON.stringify({ ok: true, skins: 7, streamers: 2 }),
    );

    expect(await h.service.status(SERVER)).toEqual({ skins: 7, streamers: 2 });
  });

  it('servidor sem RCON vira erro com nome, e não resposta vazia', async () => {
    const h = harness();

    h.connected = false;

    await expect(h.service.status(SERVER)).rejects.toBeInstanceOf(WorkshopCommandError);
  });

  it('plugin ausente (resposta vazia) não vira "zero skins"', async () => {
    const h = harness();

    h.replies.delete('origemz.workshop.status');

    // "O plugin não está carregado" e "o plugin tem zero skins" são
    // respostas diferentes, e confundi-las esconderia um plugin que
    // nem subiu.
    await expect(h.service.status(SERVER)).rejects.toMatchObject({ reason: 'no_plugin' });
  });

  it('a resposta suja de `Puts` ainda é lida', async () => {
    const h = harness();

    // MEDIDO no projeto: um `Puts` disparado no frame do comando
    // entra na resposta casada do RCON. O plugin já tira o aviso do
    // frame; esta é a segunda tranca.
    h.replies.set(
      'origemz.workshop.status',
      `${WORKSHOP_MARKER}{"kind":"ready"}\n${JSON.stringify({ ok: true, skins: 1, streamers: 0 })}`,
    );

    expect(await h.service.status(SERVER)).toEqual({ skins: 1, streamers: 0 });
  });
});

// ============================================================
//  A BORDA HTTP
//
//  As conferências que o banco NÃO faz. Elas moram na rota
//  porque a frase que o admin lê precisa dizer QUAL linha já usa
//  a marca — e porque a régua do item base mora no catálogo do
//  jogo, que o banco desta feature não referencia.
// ============================================================

async function routes(): Promise<{
  readonly app: FastifyInstance;
  readonly skins: WorkshopSkinsRepository;
}> {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const items = new ItemsRepository(db);
  const servers = new ServersRepository(db);
  const skins = new WorkshopSkinsRepository(db);

  // O catálogo do jogo. `rock` é o exemplo do dono -- a pedra.
  items.replace({
    items: [
      {
        shortname: 'rock',
        displayName: 'Rock',
        itemId: 963906841,
        category: 'Tool',
        maxStack: 1,
        hasCondition: false,
      },
      {
        shortname: 'hatchet',
        displayName: 'Hatchet',
        itemId: -1469578201,
        category: 'Tool',
        maxStack: 1,
        hasCondition: true,
      },
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: `Dev ${String(index + 1)}`,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }

  const app = Fastify();

  // O mesmo tratamento do servidor real (http/server.ts). Sem a
  // linha do ZodError, uma recusa de validação viria como 500 e o
  // teste passaria a medir o handler do teste, e não a rota.
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
      // Sem `workshop`: o cadastro tem de funcionar com todos os
      // servidores parados, e é essa a promessa que estes testes
      // guardam.
      registerWorkshopRoutes(api, { repository: skins, items, servers });
    },
    { prefix: '/api' },
  );

  return { app, skins };
}

/** O corpo que a tela manda. A permissão vai OMITIDA de propósito. */
function body(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { label: 'Pedra OrigemZ', shortname: 'rock', skinId: '3071657601', servers: [SERVER], ...patch };
}

describe('a rota do catálogo', () => {
  it('cadastra, e a permissão volta pronta', async () => {
    const { app } = await routes();

    const created = await app.inject({ method: 'POST', url: '/api/workshop/skins', payload: body() });

    expect(created.statusCode).toBe(201);
    expect(created.json().skin).toMatchObject({
      shortname: 'rock',
      skinId: '3071657601',
      permission: 'origemzworkshop.pedra-origemz',
      servers: [SERVER],
    });
  });

  it('item que o jogo não tem é recusado no CADASTRO', async () => {
    const { app } = await routes();

    // O servidor aceita qualquer `ulong` em `item.skin` e não
    // reclama de nada: sem esta conferência, o engano só
    // apareceria dias depois, com o item nascendo vanilla.
    const response = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ shortname: 'pedra-inventada' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('UNKNOWN_BASE_ITEM');
  });

  it('duas skins LIGADAS no mesmo item e no mesmo servidor: 409', async () => {
    const { app } = await routes();

    await app.inject({ method: 'POST', url: '/api/workshop/skins', payload: body() });

    // O plugin indexa por shortname e recusaria a segunda com
    // `duplicate_shortname` -- e o motivo ficaria enterrado no
    // `message` do push, longe de quem cadastrou.
    const clash = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ label: 'Pedra de Evento', skinId: '3071657602' }),
    });

    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe('DUPLICATE_ITEM');
  });

  it('trocar a arte é possível: a velha desligada não atrapalha', async () => {
    const { app } = await routes();

    await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ enabled: false }),
    });

    const nova = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ label: 'Pedra nova', skinId: '3071657602' }),
    });

    expect(nova.statusCode).toBe(201);
  });

  it('a mesma pedra em servidores DIFERENTES convive', async () => {
    const { app } = await routes();

    await app.inject({ method: 'POST', url: '/api/workshop/skins', payload: body() });

    const outra = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ label: 'Pedra do dois', skinId: '3071657602', servers: [OTHER] }),
    });

    expect(outra.statusCode).toBe(201);
  });

  it('servidor que não existe é recusado, e não vira ligação órfã', async () => {
    const { app } = await routes();

    const response = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ servers: ['server99'] }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('UNKNOWN_SERVER');
  });

  it('skin fora da faixa de UInt64 é recusada na BORDA, com 400', async () => {
    const { app } = await routes();

    const response = await app.inject({
      method: 'POST',
      url: '/api/workshop/skins',
      payload: body({ skinId: '99999999999999999999' }),
    });

    // 400 do zod, e não 500 do CHECK do banco: a frase precisa
    // chegar à tela de quem digitou.
    expect(response.statusCode).toBe(400);
  });

  it('o disparo manual de sync avisa quando não há canal com o jogo', async () => {
    const { app } = await routes();

    const response = await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/workshop/sync` });

    // 503 com nome, e não 200 mentindo que mandou.
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('WORKSHOP_UNAVAILABLE');
  });
});
