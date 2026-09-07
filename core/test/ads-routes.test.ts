// ============================================================
//  Testes das rotas do OVERLAY DE PROPAGANDAS.
//
//  Um Fastify com AS ROTAS DE PROPAGANDA e nada mais, com
//  `app.inject()`: nenhuma porta aberta, banco em memória com o
//  schema real. É o desenho do `betterloot.test.ts` ao lado — a
//  alternativa, subir o `buildServer` inteiro, obrigaria cada
//  teste de propaganda a montar as trinta dependências do agente
//  para exercitar quinze rotas.
//
//  O que NÃO é coberto aqui, por consequência: o token. Auth é do
//  `buildServer`, tem teste próprio, e repeti-lo aqui não diria
//  nada sobre propaganda.
//
//  ------------------------------------------------------------
//  O QUE ESTES TESTES PROTEGEM, E NÃO É ÓBVIO
//
//  1. TROCAR A URL INVALIDA O CACHE. Sem isso, mudar o endereço
//     deixa a propaganda mostrando a imagem ANTIGA — a chave no
//     FileStorage continua válida, e ninguém entende por que a
//     troca não pegou.
//
//  2. O PUT É PARCIAL, mas `null` NÃO é "não mandei". Apagar a
//     data de fim é mandar `null`, e um `??` no lugar errado
//     transformaria isso em "mantenha a data" — a campanha de
//     Natal ficaria no ar em janeiro.
//
//  3. `adsPerCycle: 0` significa TODAS. Um `??` engoliria o zero
//     e o admin não conseguiria escolher essa opção.
//
//  4. O SERVIDOR PARADO NAO IMPEDE CONFIGURAR. Cadastrar campanha
//     é trabalho de madrugada, com tudo desligado. O RCON destes
//     testes está SEMPRE fora do ar, e é isso que as gravações
//     provam ao passar mesmo assim.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { AdsRepository } from '../src/db/ads-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { AdsSync } from '../src/game/ads-sync.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import { registerAdsRoutes } from '../src/http/routes/ads.js';

/** O servidor destes testes. */
const SERVER = 'devserver';

/** O prefixo de toda rota daqui. Escrito uma vez. */
const ADS = `/servers/${SERVER}/ads`;

const silent = pino({ level: 'silent' });

interface Harness {
  readonly app: FastifyInstance;
  readonly db: AgentDatabase;
  readonly ads: AdsRepository;
  readonly sync: AdsSync;
  readonly sent: string[];
}

let harness: Harness | null = null;

async function buildHarness(): Promise<Harness> {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  // A linha em `servers` não é decoração: `ads` e `ads_settings`
  // apontam para lá, e o pragma de chave estrangeira está ligado.
  servers.create({
    id: SERVER,
    name: 'Dev',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\devserver',
  });

  const ads = new AdsRepository(db);
  const sent: string[] = [];

  // ####  DESCONECTADO, DE PROPOSITO  ####
  //
  // As gravações não podem depender do jogo, e é isso que este
  // `false` prova. As rotas que SÓ existem para falar com o
  // servidor (`show`, `hide`, `test`) respondem 503 por causa
  // dele — que é o comportamento certo, e tem teste próprio lá
  // embaixo.
  const rcon = {
    isConnected: false,
    send: (command: string): Promise<string> => {
      sent.push(command);
      return Promise.resolve('');
    },
  };

  const supervisor = {
    contextOf: (id: string) => (id === SERVER ? { rcon } : null),
  };

  const sync = new AdsSync({
    ads,
    servers: { ids: () => [SERVER], contextOf: supervisor.contextOf },
    logger: silent,
  });

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
    registerAdsRoutes(api, { ads, sync, servers, supervisor });
  });

  await app.ready();

  harness = { app, db, ads, sync, sent };
  return harness;
}

afterEach(async () => {
  if (harness !== null) {
    harness.sync.stop();
    await harness.app.close();
    harness.db.close();
    harness = null;
  }
});

async function createAd(app: FastifyInstance, body: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: ADS,
    payload: {
      name: 'Plano VIP',
      imageUrl: 'https://exemplo.com/ads/vip.png',
      ...body,
    },
  });

  return response;
}

// ------------------------------------------------------------
//  GET
// ------------------------------------------------------------

describe('GET /servers/:id/ads', () => {
  it('banco vazio devolve lista vazia, o ajuste padrão e a prévia', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({ method: 'GET', url: ADS });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(body.ads).toEqual([]);

    // ####  NASCE DESLIGADO  ####
    //
    // Um agente recém-instalado não põe painel na tela de
    // ninguém. Se este teste começar a falhar, alguém mudou o
    // padrão da migração — e todo servidor que atualizar passa a
    // mostrar propaganda sem ninguém ter pedido.
    expect((body.settings as { enabled: boolean }).enabled).toBe(false);

    // A prévia vem junto: a tela precisa dela para desenhar, e
    // ela é derivada do ajuste que acabou de sair daqui.
    expect(body.timeline).toBeDefined();
  });

  it('o servidor que não existe é 404, e não erro de chave estrangeira', async () => {
    // Sem o `assertServer` da rota, um id errado só apareceria na
    // gravação — como violação de FK, erro 500 com o texto do
    // SQLite, que não diz o que fazer.
    const { app } = await buildHarness();
    const response = await app.inject({ method: 'GET', url: '/servers/naoexiste/ads' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('UNKNOWN_SERVER');
  });
});

// ------------------------------------------------------------
//  CADASTRO
// ------------------------------------------------------------

describe('POST /servers/:id/ads', () => {
  it('cadastra com os padrões e nasce PENDENTE de imagem', async () => {
    const { app } = await buildHarness();

    const response = await createAd(app);
    const ad = (response.json() as { ad: Record<string, unknown> }).ad;

    expect(response.statusCode).toBe(201);
    expect(ad.name).toBe('Plano VIP');
    expect(ad.enabled).toBe(true);
    expect(ad.fit).toBe('cover');
    // A imagem ainda não foi baixada: até isso acontecer, ela não
    // entra no ciclo.
    expect(ad.imageStatus).toBe('pending');
    expect(ad.live).toBe(false);
  });

  it('recusa endereço que não é http(s)', async () => {
    const { app } = await buildHarness();

    // ####  ISTO E SEGURANCA  ####
    //
    // O agente BAIXA este endereço. Aceitar `file://` deixaria
    // quem tem o token ler o disco da máquina do servidor pela
    // API.
    for (const url of ['file:///c:/windows/win.ini', 'ftp://exemplo.com/a.png', 'não-é-url']) {
      const response = await createAd(app, { imageUrl: url });
      expect(response.statusCode).toBe(400);
    }
  });

  it('recusa campo desconhecido em vez de ignorá-lo', async () => {
    const { app } = await buildHarness();

    const response = await createAd(app, { objectFit: 'cover' });
    expect(response.statusCode).toBe(400);
  });

  it('aceita a janela de exibição inteira', async () => {
    const { app } = await buildHarness();

    const response = await createAd(app, {
      startDate: '2026-12-01',
      endDate: '2026-12-25',
      startTime: '20:00',
      endTime: '23:59',
      daysOfWeek: [5, 6, 0],
      permission: 'origemz.vip',
    });

    const ad = (response.json() as { ad: Record<string, unknown> }).ad;

    expect(response.statusCode).toBe(201);
    expect(ad.daysOfWeek).toEqual([0, 5, 6]);
    expect(ad.startTime).toBe('20:00');
  });

  it('recusa hora e data malformadas', async () => {
    const { app } = await buildHarness();

    expect((await createAd(app, { startTime: '25:00' })).statusCode).toBe(400);
    expect((await createAd(app, { startDate: '01/12/2026' })).statusCode).toBe(400);
    expect((await createAd(app, { daysOfWeek: [7] })).statusCode).toBe(400);
  });
});

// ------------------------------------------------------------
//  EDIÇÃO
// ------------------------------------------------------------

describe('PUT /servers/:id/ads/:id', () => {
  it('trocar a URL INVALIDA o cache da imagem', async () => {
    const { app, ads } = await buildHarness();

    const created = (await createAd(app)).json() as { ad: { id: string } };

    // Simula uma imagem já preparada.
    ads.markImage(SERVER, created.ad.id, {
      status: 'ready',
      key: 'adabc123abc12',
      sha: 'abc',
      bytes: 1000,
      width: 600,
      height: 200,
    });

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/${created.ad.id}`,
      payload: { imageUrl: 'https://exemplo.com/ads/OUTRA.png' },
    });

    const ad = (response.json() as { ad: Record<string, unknown> }).ad;

    // Sem isto, a propaganda continuaria mostrando a imagem
    // ANTIGA — a chave no FileStorage ainda é válida.
    expect(ad.imageStatus).toBe('pending');
    expect(ad.imageKey).toBeNull();
  });

  it('editar OUTRO campo NÃO invalida o cache', async () => {
    const { app, ads } = await buildHarness();

    const created = (await createAd(app)).json() as { ad: { id: string } };

    ads.markImage(SERVER, created.ad.id, {
      status: 'ready',
      key: 'adabc123abc12',
      sha: 'abc',
      bytes: 1000,
      width: 600,
      height: 200,
    });

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/${created.ad.id}`,
      payload: { name: 'Outro nome' },
    });

    const ad = (response.json() as { ad: Record<string, unknown> }).ad;

    // Rebaixar a imagem a cada renomeação seria trabalho de rede
    // por nada.
    expect(ad.imageStatus).toBe('ready');
    expect(ad.imageKey).toBe('adabc123abc12');
  });

  it('`null` APAGA a data, e ausente mantém', async () => {
    const { app } = await buildHarness();

    const created = (await createAd(app, { endDate: '2026-12-25' })).json() as {
      ad: { id: string };
    };

    const mantem = await app.inject({
      method: 'PUT',
      url: `${ADS}/${created.ad.id}`,
      payload: { name: 'Natal' },
    });

    expect((mantem.json() as { ad: { endDate: string | null } }).ad.endDate).toBe('2026-12-25');

    const apaga = await app.inject({
      method: 'PUT',
      url: `${ADS}/${created.ad.id}`,
      payload: { endDate: null },
    });

    // Se isto virar '2026-12-25', a campanha de Natal fica no ar
    // em janeiro.
    expect((apaga.json() as { ad: { endDate: string | null } }).ad.endDate).toBeNull();
  });

  it('id que não existe é 404', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/nao-existe`,
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------
//  ORDEM, CÓPIA E REMOÇÃO
// ------------------------------------------------------------

describe('a lista', () => {
  it('reordena na ordem dos ids recebidos', async () => {
    const { app } = await buildHarness();

    const a = (await createAd(app, { name: 'A' })).json() as { ad: { id: string } };
    const b = (await createAd(app, { name: 'B' })).json() as { ad: { id: string } };
    const c = (await createAd(app, { name: 'C' })).json() as { ad: { id: string } };

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/reorder`,
      payload: { ids: [c.ad.id, a.ad.id, b.ad.id] },
    });

    const nomes = (response.json() as { ads: { name: string }[] }).ads.map((ad) => ad.name);
    expect(nomes).toEqual(['C', 'A', 'B']);
  });

  it('a cópia nasce DESLIGADA', async () => {
    const { app } = await buildHarness();

    const created = (await createAd(app)).json() as { ad: { id: string } };

    const response = await app.inject({
      method: 'POST',
      url: `${ADS}/${created.ad.id}/duplicate`,
    });

    const copy = (response.json() as { ad: Record<string, unknown> }).ad;

    expect(response.statusCode).toBe(201);
    expect(copy.name).toBe('Plano VIP (cópia)');
    // Ligada, ela entraria no rodízio no mesmo instante e a mesma
    // imagem apareceria duas vezes por ciclo.
    expect(copy.enabled).toBe(false);
  });

  it('apaga', async () => {
    const { app } = await buildHarness();

    const created = (await createAd(app)).json() as { ad: { id: string } };

    const response = await app.inject({
      method: 'DELETE',
      url: `${ADS}/${created.ad.id}`,
    });

    expect(response.statusCode).toBe(200);

    const lista = await app.inject({ method: 'GET', url: ADS });
    expect((lista.json() as { ads: unknown[] }).ads).toEqual([]);
  });
});

// ------------------------------------------------------------
//  O AJUSTE
// ------------------------------------------------------------

describe('PUT /servers/:id/ads/settings', () => {
  it('grava o que veio e mantém o resto', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/settings`,
      payload: { enabled: true, panelWidth: 480 },
    });

    const settings = (response.json() as { settings: Record<string, unknown> }).settings;

    expect(settings.enabled).toBe(true);
    expect(settings.panelWidth).toBe(480);
    // Não mandado, não mexido.
    expect(settings.panelHeight).toBe(120);
  });

  it('`adsPerCycle: 0` significa TODAS, e o zero precisa passar', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/settings`,
      payload: { adsPerCycle: 0 },
    });

    // Um `??` no repositório devolveria o padrão (3) aqui, e o
    // admin não conseguiria escolher "todas".
    expect((response.json() as { settings: { adsPerCycle: number } }).settings.adsPerCycle).toBe(0);
  });

  it('a prévia volta junto, já com o ajuste novo', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'PUT',
      url: `${ADS}/settings`,
      payload: { openingMs: 1000, animationFps: 10 },
    });

    const timeline = (response.json() as { timeline: { opening: { durationMs: number } } })
      .timeline;

    expect(timeline.opening.durationMs).toBe(1000);
  });

  it('a prévia responde sem SALVAR nada', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: `${ADS}/preview`,
      payload: { panelWidth: 800, openingMs: 1200 },
    });

    const body = response.json() as {
      settings: { panelWidth: number };
      timeline: { opening: { durationMs: number } };
    };

    expect(response.statusCode).toBe(200);
    expect(body.settings.panelWidth).toBe(800);
    expect(body.timeline.opening.durationMs).toBe(1200);

    // O banco continua com o valor de antes: mover um controle
    // deslizante não pode gravar nada — cada gravação reenvia a
    // configuração ao servidor de Rust.
    const saved = await app.inject({ method: 'GET', url: ADS });
    expect((saved.json() as { settings: { panelWidth: number } }).settings.panelWidth).toBe(360);
  });

  it('a prévia sem corpo devolve o ajuste salvo', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: `${ADS}/preview`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as { settings: { panelWidth: number } }).settings.panelWidth,
    ).toBe(360);
  });

  it('recusa valores fora dos limites', async () => {
    const { app } = await buildHarness();

    const tentativas = [
      { intervalSeconds: 5 },
      { logoFps: 60 },
      { animationFps: 120 },
      { panelWidth: 5000 },
      { logoOpacity: 2 },
      // ####  `Inventory` SAIU DAQUI EM 07/09/2026  ####
      //
      // Ela era recusada porque um MENU pendurado nela sumiria com
      // o inventario. Para o OVERLAY isso deixou de ser acidente e
      // virou o recurso: e o unico jeito de "a propaganda so
      // aparece no inventario". Ver ADS_SCREEN_LAYERS.
      //
      // O que continua recusado e o que o jogo NAO conhece — e e
      // isso que a linha abaixo guarda.
      { layer: 'NaoExisteNoJogo' },
    ];

    for (const payload of tentativas) {
      const response = await app.inject({
        method: 'PUT',
        url: `${ADS}/settings`,
        payload,
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it('aceita as camadas que somem junto com a tela do jogo', async () => {
    // O oposto do caso acima, e o motivo de ele ter mudado: sao
    // estas tres que fazem o overlay aparecer so numa tela.
    const { app } = await buildHarness();

    for (const layer of ['Inventory', 'Crafting', 'Map']) {
      const response = await app.inject({
        method: 'PUT',
        url: `${ADS}/settings`,
        payload: { layer },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ settings: { layer: string } }>().settings.layer).toBe(layer);
    }
  });
});

// ------------------------------------------------------------
//  OS BOTÕES QUE FALAM COM O JOGO
// ------------------------------------------------------------

describe('as rotas de teste', () => {
  it('sem RCON, respondem 503 em vez de fingir', async () => {
    const { app } = await buildHarness();

    // O harness monta o servidor SEM `rcon` no bloco de ads.
    const response = await app.inject({ method: 'POST', url: `${ADS}/show` });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toBe('RCON_UNAVAILABLE');
  });

  it('testar uma propaganda sem imagem é recusado ANTES de ir ao jogo', async () => {
    const { app } = await buildHarness();

    const created = (await createAd(app)).json() as { ad: { id: string } };

    const response = await app.inject({
      method: 'POST',
      url: `${ADS}/${created.ad.id}/test`,
    });

    // Mandar assim desenharia um retângulo vazio, e quem clicou
    // concluiria que a animação está quebrada.
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('AD_NOT_PLAYABLE');
  });

  it('steamId malformado é 400', async () => {
    const { app } = await buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: `${ADS}/show`,
      payload: { steamId: '123' },
    });

    expect(response.statusCode).toBe(400);
  });
});
