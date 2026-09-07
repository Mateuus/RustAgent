// ============================================================
//  ui.test.ts  -  as promessas da interface que falham em
//  SILÊNCIO no cliente.
//
//  ####  É POR ISTO QUE A CONVERSÃO MORA NO AGENTE  ####
//
//  Nenhuma das armadilhas abaixo dá erro no jogo. O campo com nome
//  errado é ignorado, a cor em hex vira preto transparente, o
//  botão sem o segundo elemento sai vazio — e a carga acima do
//  teto do RCON simplesmente não chega. Aqui elas têm teste; em C#
//  não teriam, porque não há servidor de Rust no CI.
//
//  O que este arquivo guarda:
//
//    1. a carga inicial do Menu Principal CABE no teto do RCON;
//    2. converter o mesmo documento duas vezes dá o mesmo
//       resultado, byte a byte;
//    3. um documento inválido é recusado ANTES de virar comando;
//    4. um botão são DOIS elementos, e a cor vai em floats;
//    5. o que o servidor esconde não chega ao jogo;
//    6. a revisão aplicada só é carimbada depois de o envio dar
//       certo.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { UiDocumentsRepository } from '../src/db/ui-documents-repository.js';
import {
  collectScreenActions,
  cuiColor,
  ROOT_NAME,
  screenContentToCui,
  screenToCui,
  shellToCui,
  type CuiElement,
} from '../src/game/ui-cui.js';
import { buildKitsScreen } from '../src/game/ui-kits-screen.js';
import type { KitOfferView } from '../src/kits/service.js';
import { buildMainMenu, MAIN_MENU_SLUG } from '../src/game/ui-preset-main-menu.js';
import { UiSync } from '../src/game/ui-sync.js';
import { apiErrorToResponse, isApiError, zodErrorToResponse } from '../src/http/error-response.js';
import { registerUiRoutes } from '../src/http/routes/ui.js';
import { createLogger } from '../src/logger.js';
import {
  applyHidden,
  findDocumentProblems,
  walkElements,
  type UiDocument,
  type UiElement,
} from '../src/types/ui-document.js';
import {
  encodeUiDocPayload,
  toDocumentPayload,
  toGeneratedScreenBundle,
  UI_DOC_MAX_BYTES,
  UI_REQUEST_MARKER,
} from '../src/types/ui-transport.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

/** O "servidor": ele só guarda o que recebeu. */
interface FakeServer {
  connected: boolean;
  readonly sent: string[];
  /** O RCON recusa o comando. */
  broken: boolean;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: UiDocumentsRepository;
  readonly server: FakeServer;
  readonly sync: UiSync;
  readonly app: FastifyInstance;
}

let harness: Harness;

beforeEach(async () => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // A linha em `servers` não é decoração: `server_ui` aponta para
  // lá, e o pragma de chave estrangeira está ligado.
  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'PVP 1',
    identity: 'pvp1',
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const server: FakeServer = { connected: true, sent: [], broken: false };
  const repository = new UiDocumentsRepository(db, silent);

  const sync = new UiSync({
    repository,
    servers: {
      ids: () => ['pvp1'],
      contextOf: (id) =>
        id === 'pvp1'
          ? {
              rcon: {
                get isConnected() {
                  return server.connected;
                },
                send: (command: string) => {
                  if (server.broken) {
                    return Promise.reject(new Error('o servidor recusou o comando'));
                  }

                  server.sent.push(command);

                  return Promise.resolve('{"ok":true,"documents":1}');
                },
              },
            }
          : null,
    },
    logger: silent,
  });

  const app = Fastify();

  app.setErrorHandler(async (error, _request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR', message: String(error) });
  });

  await app.register(
    async (api) => {
      registerUiRoutes(api, { repository, sync, servers: { ids: () => ['pvp1'] } });
    },
    { prefix: '/api' },
  );

  harness = { db, repository, server, sync, app };
});

// ------------------------------------------------------------
//  O TETO DO RCON
// ------------------------------------------------------------

describe('a carga inicial do Menu Principal', () => {
  /**
   * ####  ESTE É O TESTE QUE MAIS IMPORTA DO ARQUIVO  ####
   *
   * MEDIDO no projeto anterior: o menu inteiro (7 telas, 142
   * elementos) dava 52.280 bytes, ou 69.708 em base64, contra os
   * ~50.000 do frame do WebRCON. O primeiro menu real já não
   * cabia.
   *
   * O que faz caber é a forma da carga: só os metadados mais a
   * tela de ENTRADA viajam, e o cabeçalho — que antes era repetido
   * em cada tela — vira shell, mandado uma vez só.
   *
   * Se alguém puser conteúdo demais na tela de entrada, ou desfizer
   * o shell, é AQUI que o projeto descobre — e não com o menu
   * silenciosamente sumido do jogo.
   */
  it('cabe no teto do RCON', () => {
    const encoded = encodeUiDocPayload({ documents: [toDocumentPayload(buildMainMenu())] });

    expect(encoded.length).toBeLessThanOrEqual(UI_DOC_MAX_BYTES);
  });

  it('passa nas regras que o schema não expressa', () => {
    // Botão que navega para tela apagada, id repetido, slot que
    // não é do shell: nada disso um schema pega, e cada um quebra
    // o menu de um jeito diferente no jogo.
    expect(findDocumentProblems(buildMainMenu())).toEqual([]);
  });

  // ####  `/quest` É UM ATALHO, E NÃO UM SEGUNDO MENU  ####
  //
  // A primeira versão das missões clonou o menu inteiro — mesmo
  // shell, mesmas onze telas — só para responder a outro comando.
  // O servidor recebia duas cópias pelo RCON e o admin via dois
  // "Menu" na tela de Interface. Este teste é o que impede a volta
  // disso sem alguém perceber.
  it('o `/quest` abre este mesmo menu, direto em MISSÕES', () => {
    const menu = buildMainMenu();

    expect(menu.shortcuts).toEqual([{ command: 'quest', screenId: 'tela-missoes' }]);
    // E a tela existe: um atalho para uma tela apagada abriria o
    // menu num "carregando" que nunca termina.
    expect(menu.screens.some((screen) => screen.id === 'tela-missoes')).toBe(true);
    // O atalho viaja ao plugin. Sem isto ele não registra o
    // comando, e `/quest` volta a ser "unknown command".
    expect(toDocumentPayload(menu).shortcuts).toEqual([
      { command: 'quest', screenId: 'tela-missoes' },
    ]);
  });

  it('um atalho para tela inexistente é recusado', () => {
    const broken = { ...buildMainMenu(), shortcuts: [{ command: 'x', screenId: 'tela-sumida' }] };

    expect(findDocumentProblems(broken)).toEqual([
      { message: expect.stringContaining('tela-sumida') as unknown as string },
    ]);
  });

  /**
   * ####  UM PAINEL TRANSPARENTE POR CIMA ENGOLE OS CLIQUES  ####
   *
   * Aconteceu: o slot de modal estava no shell, cobrindo a tela
   * inteira com alpha 0. No Unity isso NÃO desliga o raycast — o
   * menu abriu bonito no jogo e nenhum botão respondeu, nem o de
   * fechar. O jogador ficou preso com o cursor liberado.
   *
   * Quem cria esse contêiner é o PLUGIN, e só enquanto há um modal
   * aberto (ver `ModalContainerJson` em OrigemZUI.cs). O campo do
   * documento é apenas o NOME que ele usa.
   *
   * O teste olha o que de fato vai ao jogo — o CUI do shell — e
   * não o modelo: é lá que o elemento apareceria.
   */
  it('não desenha o slot de modal no cabeçalho', () => {
    const document = buildMainMenu();
    const shell = shellToCui(document);

    expect(document.modalSlotId).not.toBeNull();
    expect(shell.some((element) => element.name === `${ROOT_NAME}.${document.modalSlotId ?? ''}`)).toBe(
      false,
    );
  });

  /**
   * O mesmo perigo, na forma geral: nada do cabeçalho pode cobrir
   * os botões dele.
   *
   * Depois do slot de conteúdo, no shell, só cabe o que é menor que
   * a tela. Um elemento esticado ali fica POR CIMA de tudo o que
   * veio antes — inclusive da navegação.
   */
  it('não tem nada esticado no cabeçalho depois do slot de conteúdo', () => {
    const document = buildMainMenu();

    const stretched = (element: { rect: { anchorMin: { x: number }; anchorMax: { x: number } } }) =>
      element.rect.anchorMin.x === 0 && element.rect.anchorMax.x === 1;

    for (const { element } of walkElements(document.shell)) {
      if (element.id === document.contentSlotId) {
        continue;
      }

      // Os irmãos do slot de conteúdo, DEPOIS dele, não podem
      // esticar sobre a tela toda.
      const siblings = document.shell.flatMap((top) => top.children);
      const slotIndex = siblings.findIndex((item) => item.id === document.contentSlotId);
      const index = siblings.findIndex((item) => item.id === element.id);

      if (slotIndex >= 0 && index > slotIndex) {
        expect(stretched(element)).toBe(false);
      }
    }
  });

  it('é determinístico: montá-lo duas vezes dá o mesmo documento', () => {
    // É o que permite comparar o preset com o que está gravado, e
    // o que torna o número do teste acima estável.
    expect(JSON.stringify(buildMainMenu())).toBe(JSON.stringify(buildMainMenu()));
  });
});

// ------------------------------------------------------------
//  A CONVERSÃO
// ------------------------------------------------------------

describe('modelo -> CUI', () => {
  it('converter duas vezes dá o mesmo resultado', () => {
    const document = buildMainMenu();
    const screen = document.screens[0];

    if (screen === undefined) {
      throw new Error('o preset precisa ter ao menos uma tela');
    }

    expect(JSON.stringify(screenToCui(document, screen))).toBe(
      JSON.stringify(screenToCui(document, screen)),
    );
  });

  it('manda a cor em FLOATS, e não em hex', () => {
    // O CUI não entende `#C43F2C`. Mandar hex não dá erro: o
    // cliente lê zero em tudo e desenha um retângulo preto
    // transparente.
    expect(cuiColor('#C43F2C')).toBe('0.769 0.247 0.173 1');
    expect(cuiColor('#00000000')).toBe('0 0 0 0');
    // Sem alfa, opaco.
    expect(cuiColor('#FFFFFF')).toBe('1 1 1 1');
  });

  it('emite DOIS elementos por botão', () => {
    // O `CuiButtonComponent` não tem texto. Sem o segundo
    // elemento, o botão sai VAZIO no jogo, sem erro nenhum.
    const document = buildMainMenu();
    const entry = document.screens.find((screen) => screen.id === document.entryScreenId);

    if (entry === undefined) {
      throw new Error('o preset precisa ter a tela de entrada');
    }

    const cui = screenToCui(document, entry);
    const buttons = cui.filter((element) =>
      element.components.some((component) => component.type === 'UnityEngine.UI.Button'),
    );

    expect(buttons.length).toBeGreaterThan(0);

    for (const button of buttons) {
      expect(cui.some((element) => element.name === `${button.name}.text`)).toBe(true);
    }
  });

  it('usa os nomes de campo MINÚSCULOS do RectTransform', () => {
    // `anchorMin` em vez de `anchormin` é ignorado em silêncio pelo
    // cliente, e o elemento nasce ocupando o pai inteiro.
    const document = buildMainMenu();
    const entry = document.screens.find((screen) => screen.id === document.entryScreenId);

    if (entry === undefined) {
      throw new Error('o preset precisa ter a tela de entrada');
    }

    const rect = screenToCui(document, entry)
      .flatMap((element) => element.components)
      .find((component) => component.type === 'RectTransform');

    expect(rect).toBeDefined();
    expect(Object.keys(rect ?? {})).toContain('anchormin');
    expect(Object.keys(rect ?? {})).not.toContain('anchorMin');
  });

  it('o botão carrega um ENDEREÇO, nunca a intenção', () => {
    // `origemz.ui.act <token> <actionId>` é digitável no F1 por
    // qualquer jogador. Se ele carregasse o comando a executar,
    // seria um distribuidor de item grátis.
    const document = buildMainMenu();
    const entry = document.screens.find((screen) => screen.id === document.entryScreenId);

    if (entry === undefined) {
      throw new Error('o preset precisa ter a tela de entrada');
    }

    const commands = screenToCui(document, entry)
      .flatMap((element) => element.components)
      .filter((component) => component.type === 'UnityEngine.UI.Button')
      .map((component) => String(component.command));

    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      expect(command).toMatch(/^origemz\.ui\.act \{token\} [a-z0-9_-]+$/i);
    }
  });
});

// ------------------------------------------------------------
//  O QUE O SERVIDOR ESCONDE
// ------------------------------------------------------------

describe('o que este servidor esconde', () => {
  it('some do documento, com os filhos junto', () => {
    const document = buildMainMenu();
    const view = applyHidden(document, ['nav-loja', 'tela-loja']);

    expect(view.screens.some((screen) => screen.id === 'tela-loja')).toBe(false);
    expect(JSON.stringify(view.shell)).not.toContain('nav-loja');
    // E o resto continua inteiro.
    expect(view.screens.length).toBe(document.screens.length - 1);
  });

  it('NUNCA esconde a tela de entrada', () => {
    // Sem tela de entrada o menu não abriria, e o jogador ficaria
    // com um comando que não faz nada.
    const document = buildMainMenu();
    const view = applyHidden(document, [document.entryScreenId]);

    expect(view.screens.some((screen) => screen.id === document.entryScreenId)).toBe(true);
  });
});

// ------------------------------------------------------------
//  E O CABEÇALHO SE FECHA
// ------------------------------------------------------------

/** O retângulo do elemento, procurado na árvore inteira. */
function rectOf(document: UiDocument, id: string): UiElement['rect'] {
  for (const { element } of walkElements(document.shell)) {
    if (element.id === id) {
      return element.rect;
    }
  }

  throw new Error(`O elemento "${id}" não está no cabeçalho.`);
}

describe('o cabeçalho depois da poda', () => {
  it('fecha o vão dos botões escondidos', () => {
    const document = buildMainMenu();

    // Onde cada um começava, antes de EVENTOS e REGRAS saírem.
    const eventos = rectOf(document, 'nav-eventos').offsetMin.x;
    const kits = rectOf(document, 'nav-kits').offsetMin.x;
    const calendario = rectOf(document, 'nav-calendario');
    const gap = kits - rectOf(document, 'nav-regras').offsetMax.x;

    const view = applyHidden(document, ['tela-eventos', 'tela-regras']);

    // KITS assume o lugar de EVENTOS: o vão dos dois sumiu.
    expect(rectOf(view, 'nav-kits').offsetMin.x).toBe(eventos);
    // E o respiro entre ele e o vizinho é o mesmo de sempre — não
    // um encosto nem o buraco de antes.
    expect(rectOf(view, 'nav-kits').offsetMin.x - calendario.offsetMax.x).toBe(gap);

    // Quem estava ANTES do vão não se mexeu.
    expect(rectOf(view, 'nav-calendario')).toEqual(calendario);

    // A largura de cada botão é a mesma: a fila desliza, não estica.
    const largura = (rect: UiElement['rect']): number => rect.offsetMax.x - rect.offsetMin.x;

    expect(largura(rectOf(view, 'nav-kits'))).toBe(largura(rectOf(document, 'nav-kits')));
  });

  it('não mexe em ninguém quando quem sai é a ponta da fila', () => {
    const document = buildMainMenu();
    // DISCORD é o último da barra: tirá-lo só a encurta.
    const view = applyHidden(document, ['nav-discord']);

    for (const id of ['nav-home', 'nav-loja', 'nav-missoes']) {
      expect(rectOf(view, id)).toEqual(rectOf(document, id));
    }
  });

  it('deixa quieto quem não está numa fila', () => {
    const document = buildMainMenu();
    // O X mora sozinho no trilho dele, ancorado à direita.
    const view = applyHidden(document, ['nav-eventos', 'tela-eventos']);

    for (const id of ['btn-fechar', 'coin-value', 'vip-tier', 'conteudo']) {
      expect(rectOf(view, id)).toEqual(rectOf(document, id));
    }
  });

  it('a fila presa à direita fecha o vão para a direita', () => {
    // A barra do cabeçalho gruda na esquerda; uma fila ancorada na
    // borda oposta precisa fechar para o outro lado, ou ela se
    // descola da borda que o desenho escolheu.
    const trilho = (x: number, width: number): UiElement['rect'] => ({
      anchorMin: { x: 1, y: 0.5 },
      anchorMax: { x: 1, y: 0.5 },
      offsetMin: { x, y: -10 },
      offsetMax: { x: x + width, y: 10 },
    });

    const base = buildMainMenu();
    const document: UiDocument = {
      ...base,
      shell: [
        {
          id: 'direita-a',
          name: 'A',
          type: 'label',
          rect: trilho(-300, 80),
          children: [],
          text: 'A',
          fontSize: 12,
          font: 'RobotoCondensed-Bold.ttf',
          color: '#FFFFFFFF',
          align: 'MiddleCenter',
        },
        {
          id: 'direita-b',
          name: 'B',
          type: 'label',
          rect: trilho(-210, 80),
          children: [],
          text: 'B',
          fontSize: 12,
          font: 'RobotoCondensed-Bold.ttf',
          color: '#FFFFFFFF',
          align: 'MiddleCenter',
        },
        {
          id: 'direita-c',
          name: 'C',
          type: 'label',
          rect: trilho(-120, 80),
          children: [],
          text: 'C',
          fontSize: 12,
          font: 'RobotoCondensed-Bold.ttf',
          color: '#FFFFFFFF',
          align: 'MiddleCenter',
        },
        ...base.shell,
      ],
    };

    const view = applyHidden(document, ['direita-b']);

    // C não se mexe (é o mais próximo da borda) e A escorrega para
    // o lugar que era de B.
    expect(rectOf(view, 'direita-c')).toEqual(rectOf(document, 'direita-c'));
    expect(rectOf(view, 'direita-a').offsetMin.x).toBe(-210);
    expect(rectOf(view, 'direita-a').offsetMax.x).toBe(-130);
  });
});

// ------------------------------------------------------------
//  AS ROTAS
// ------------------------------------------------------------

describe('as rotas de interface', () => {
  it('cria o Menu Principal a partir do modelo', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ui/documents',
      payload: { preset: MAIN_MENU_SLUG },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as { document: { slug: string; revision: number } };

    expect(body.document.slug).toBe(MAIN_MENU_SLUG);
    expect(body.document.revision).toBe(1);
  });

  it('recusa um documento inválido ANTES de ele virar comando', async () => {
    const document = buildMainMenu();
    const entry = document.screens[0];

    if (entry === undefined) {
      throw new Error('o preset precisa ter ao menos uma tela');
    }

    harness.repository.create(document);

    // Um botão que leva a uma tela que não existe. O schema não
    // pega isto: é regra do documento INTEIRO.
    const invalid = {
      ...document,
      screens: [
        {
          ...entry,
          elements: [
            {
              id: 'botao-quebrado',
              name: 'Quebrado',
              type: 'button',
              rect: {
                anchorMin: { x: 0, y: 0 },
                anchorMax: { x: 1, y: 1 },
                offsetMin: { x: 0, y: 0 },
                offsetMax: { x: 0, y: 0 },
              },
              children: [],
              color: '#FFFFFF',
              sprite: null,
              text: 'x',
              fontSize: 12,
              font: 'RobotoCondensed-Bold.ttf',
              textColor: '#FFFFFF',
              align: 'MiddleCenter',
              action: { id: 'acao-quebrada', kind: 'navigate', screenId: 'tela-que-nao-existe' },
            },
          ],
        },
        ...document.screens.slice(1),
      ],
    };

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/ui/documents/1',
      payload: { document: invalid },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('UI_DOCUMENT_INVALID');

    // E nada foi enviado ao servidor: o comando nem chegou a ser
    // montado.
    expect(harness.server.sent).toEqual([]);
  });

  it('recusa uma cor fora de formato', async () => {
    const document = buildMainMenu();

    harness.repository.create(document);

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/ui/documents/1',
      payload: { document: { ...document, shell: [{ ...document.shell[0], color: 'vermelho' }] } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('o preview converte sem tocar em servidor nenhum', async () => {
    harness.repository.create(buildMainMenu());
    harness.server.connected = false;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ui/documents/1/preview',
      payload: {},
    });

    const body = response.json() as {
      cui: CuiElement[];
      payload: { bytes: number; limit: number; fits: boolean };
    };

    expect(response.statusCode).toBe(200);
    expect(body.cui.length).toBeGreaterThan(0);
    // E ele já responde à pergunta que o editor precisa fazer antes
    // de o menu chegar ao jogo.
    expect(body.payload.fits).toBe(true);
    expect(body.payload.limit).toBe(UI_DOC_MAX_BYTES);
  });

  it('sobe a revisão a cada gravação', async () => {
    const document = buildMainMenu();

    harness.repository.create(document);

    await harness.app.inject({ method: 'PUT', url: '/api/ui/documents/1', payload: { document } });

    expect(harness.repository.get(1)?.revision).toBe(2);
  });

  it('recusa trocar o identificador numa edição', async () => {
    harness.repository.create(buildMainMenu());

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/ui/documents/1',
      payload: { document: { ...buildMainMenu(), id: 'outro-menu' } },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('UI_DOCUMENT_ID_MISMATCH');
  });

  // ----------------------------------------------------------
  //  A SEGUNDA INTERFACE
  //
  //  ####  O COMANDO REPETIDO É O ÚNICO ERRO INVISÍVEL AQUI  ####
  //
  //  Identificador repetido já dava 409. Comando repetido não dava
  //  nada: o documento entrava no banco, subia a revisão, chegava
  //  ao servidor — e no jogo o `/menu` abria UM dos dois, porque o
  //  plugin resolve o comando num mapa só. O outro não some da
  //  lista do painel; ele só nunca abre.
  // ----------------------------------------------------------
  it('recusa uma segunda interface com o mesmo comando de chat', async () => {
    harness.repository.create(buildMainMenu());

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ui/documents',
      payload: {
        document: { ...buildMainMenu(), id: 'menu-vip', name: 'Menu VIP' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('UI_COMMAND_EXISTS');
  });

  it('aceita a segunda interface quando o comando é outro', async () => {
    harness.repository.create(buildMainMenu());

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ui/documents',
      payload: {
        document: {
          ...buildMainMenu(),
          id: 'menu-vip',
          name: 'Menu VIP',
          command: 'vip',
          // Sem os atalhos: eles ocupam nome global, e a cópia que
          // os levasse junto colidiria no `/quest` do original. É a
          // mesma limpeza que o diálogo de copiar faz no painel.
          shortcuts: [],
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect((response.json() as { document: { slug: string } }).document.slug).toBe('menu-vip');
  });

  it('não acusa o documento de repetir o próprio comando ao salvar', async () => {
    harness.repository.create(buildMainMenu());

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/ui/documents/1',
      payload: { document: { ...buildMainMenu(), name: 'Menu Principal (2)' } },
    });

    expect(response.statusCode).toBe(200);
  });

  // ####  O ATALHO OCUPA O MESMO NOME GLOBAL  ####
  //
  // `/quest` nao e o `command` de documento nenhum: e um atalho do
  // Menu Principal, e o plugin o poe no MESMO mapa `_byCommand`.
  // Uma interface nova pedindo `quest` ficaria inalcancavel do
  // mesmo jeito, e o resumo da listagem nao mostra atalho.
  it('recusa um comando que e ATALHO de outra interface', async () => {
    harness.repository.create(buildMainMenu());

    const atalho = buildMainMenu().shortcuts[0]?.command ?? 'quest';

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/ui/documents',
      payload: {
        document: {
          ...buildMainMenu(),
          id: 'menu-vip',
          name: 'Menu VIP',
          command: atalho,
          shortcuts: [],
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('UI_COMMAND_EXISTS');
  });

  it('a lista de modelos diz o que cada um produz', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/ui/presets' });

    expect(response.statusCode).toBe(200);

    const { presets } = response.json() as {
      presets: { preset: string; id: string; name: string; command: string; screens: number }[];
    };

    const menu = presets.find((item) => item.preset === MAIN_MENU_SLUG);

    // O painel monta o seletor com isto. Uma lista de slugs o
    // obrigaria a inventar o nome — e a errá-lo no dia em que o
    // preset mudar.
    expect(menu?.id).toBe(MAIN_MENU_SLUG);
    expect(menu?.command).toBe(buildMainMenu().command);
    expect(menu?.screens).toBe(buildMainMenu().screens.length);
  });
});

// ------------------------------------------------------------
//  O TRANSPORTE
// ------------------------------------------------------------

describe('o envio ao servidor', () => {
  beforeEach(() => {
    harness.repository.create(buildMainMenu());
    harness.repository.setBinding('pvp1', 1, { enabled: true, hidden: [] });
  });

  it('manda a carga e carimba a revisão aplicada', async () => {
    const outcome = await harness.sync.push('pvp1', 'manual');

    expect(outcome.status).toBe('sent');
    expect(harness.server.sent[0]).toMatch(/^origemz\.ui\.doc /);
    expect(harness.repository.bindingsOf('pvp1')[0]?.appliedRevision).toBe(1);
  });

  it('NÃO carimba a revisão quando o envio falha', async () => {
    harness.server.broken = true;

    const outcome = await harness.sync.push('pvp1', 'manual');

    expect(outcome.status).toBe('failed');
    // Carimbar antes faria a tela dizer que está tudo em dia num
    // servidor que não recebeu nada.
    expect(harness.repository.bindingsOf('pvp1')[0]?.appliedRevision).toBeNull();
  });

  it('não manda nada com o servidor parado, e diz por quê', async () => {
    harness.server.connected = false;

    const outcome = await harness.sync.push('pvp1', 'manual');

    expect(outcome.status).toBe('skipped');
    expect(harness.server.sent).toEqual([]);
  });

  it('serve UMA tela quando o plugin pede', async () => {
    await harness.sync.push('pvp1', 'manual');
    harness.server.sent.length = 0;

    harness.sync.handleLine(
      'pvp1',
      `[OrigemZUI] ${UI_REQUEST_MARKER}{"requestId":"r1","documentId":"${MAIN_MENU_SLUG}","screenId":"tela-kits"}`,
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.server.sent[0]).toMatch(/^origemz\.ui\.screen /);
  });

  it('responde ERRO quando a tela não existe, em vez de silêncio', async () => {
    // O jogador está com um aviso de carregando na tela. Sem
    // resposta, ele fica lá até o timeout do plugin.
    harness.sync.handleLine(
      'pvp1',
      `[OrigemZUI] ${UI_REQUEST_MARKER}{"requestId":"r2","documentId":"${MAIN_MENU_SLUG}","screenId":"nao-existe"}`,
    );

    await new Promise((resolve) => setImmediate(resolve));

    const sent = harness.server.sent.at(-1) ?? '';

    expect(sent).toMatch(/^origemz\.ui\.screen /);
    expect(Buffer.from(sent.split(' ')[1] ?? '', 'base64').toString('utf8')).toContain(
      'SCREEN_NOT_FOUND',
    );
  });

  it('ignora uma linha com o marcador que NÃO veio do plugin', () => {
    // O agente lê o console inteiro, e isso inclui o chat dos
    // jogadores. Sem o controle de origem, alguém digitando o
    // marcador forjaria um pedido.
    harness.sync.handleLine(
      'pvp1',
      `[CHAT] Mateuus: ${UI_REQUEST_MARKER}{"requestId":"x","documentId":"${MAIN_MENU_SLUG}","screenId":"tela-kits"}`,
    );

    expect(harness.server.sent).toEqual([]);
  });

  it('não manda ao jogo o que este servidor esconde', async () => {
    harness.repository.setBinding('pvp1', 1, { enabled: true, hidden: ['nav-loja', 'tela-loja'] });

    await harness.sync.push('pvp1', 'manual');

    const encoded = harness.server.sent[0]?.split(' ')[1] ?? '';
    const json = Buffer.from(encoded, 'base64').toString('utf8');

    expect(json).not.toContain('nav-loja');
    expect(json).not.toContain('tela-loja');
    // E o que não foi escondido continua lá.
    expect(json).toContain('nav-kits');
  });
});

// ------------------------------------------------------------
//  A PÁGINA DE KITS, MONTADA DO BANCO
// ------------------------------------------------------------

describe('a página de kits', () => {
  const offer = (over: Partial<KitOfferView> = {}): KitOfferView =>
    ({
      id: 1,
      slug: 'kit-inicial',
      name: 'Kit Inicial',
      description: null,
      kind: 'resgate',
      priceCents: null,
      cooldownSeconds: null,
      requiredTier: null,
      items: [{ slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0 }],
      enabled: true,
      servers: ['pvp1'],
      claimCount: 0,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
      category: null,
      available: true,
      reason: null,
      nextAt: null,
      lastClaimedAt: null,
      myClaims: 0,
      ...over,
    }) as KitOfferView;

  const grid = (offers: readonly KitOfferView[]) =>
    buildKitsScreen({ offers, target: { kind: 'grid', category: null, page: 0 } });

  /** O catálogo de itens, para o ícone e o nome bonito. */
  const itemOf = (shortname: string): { itemId: number; displayName: string } | null =>
    shortname === 'rifle.ak' ? { itemId: 1_545_779_598, displayName: 'Assault Rifle' } : null;

  it('o card PERGUNTA antes de resgatar; quem cobra é a confirmação', () => {
    // ####  UM RESGATE ÚNICO É IRREVERSÍVEL  ####
    //
    // O botão fica num card pequeno, ao lado de outros sete. Sem a
    // confirmação, um clique errado gasta a única chance.
    const screen = grid([offer()]);
    const actions = collectScreenActions(screen);

    expect(actions['pedir-kit-inicial']).toEqual({
      kind: 'modal.open',
      screenId: 'ozkit:kit-inicial:confirmar',
    });

    // Nada na GRADE cobra: o `store.buy` não existe aqui.
    expect(Object.values(actions).map((action) => action.kind)).not.toContain('store.buy');

    const confirm = buildKitsScreen({
      offers: [offer()],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'confirmar' },
    });

    // É AQUI, e em nenhum outro lugar, que o resgate acontece.
    expect(collectScreenActions(confirm)['pegar-kit-inicial']).toEqual({
      kind: 'store.buy',
      offerId: 'kit-inicial',
      quantity: 1,
    });

    const commands = screenContentToCui(buildMainMenu(), confirm)
      .flatMap((element) => element.components)
      .filter((component) => component.type === 'UnityEngine.UI.Button')
      .map((component) => String(component.command));

    // O botão carrega um ENDEREÇO. O slug vai na tabela de ações,
    // não no comando.
    expect(commands).toContain('origemz.ui.act {token} pegar-kit-inicial');
  });

  it('a confirmação diz o que a REGRA custa, e não só "tem certeza?"', () => {
    const unico = buildKitsScreen({
      offers: [offer()],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'confirmar' },
    });

    const espera = buildKitsScreen({
      offers: [offer({ kind: 'cooldown', cooldownSeconds: 7200 })],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'confirmar' },
    });

    expect(JSON.stringify(screenContentToCui(buildMainMenu(), unico))).toContain('resgate ÚNICO');
    expect(JSON.stringify(screenContentToCui(buildMainMenu(), espera))).toContain('volta em 2 h');
  });

  it('separa os kits por categoria, e só mostra abas quando há mais de uma', () => {
    const uma = grid([offer(), offer({ slug: 'kit-b', name: 'Kit B' })]);

    // Uma aba solitária ocuparia trinta pixels para dizer o que a
    // tela toda já diz.
    expect(JSON.stringify(screenContentToCui(buildMainMenu(), uma))).not.toContain('GERAL');

    const duas = grid([
      offer({ category: 'Iniciante' }),
      offer({ slug: 'kit-vip', name: 'Kit VIP', category: 'VIP' }),
    ]);

    const actions = collectScreenActions(duas);
    const json = JSON.stringify(screenContentToCui(buildMainMenu(), duas));

    expect(json).toContain('INICIANTE');
    expect(json).toContain('VIP');

    // A aba é um ENDEREÇO com o slug da categoria — nem o nome cru
    // (que levaria acento e espaço), nem o índice (que apontaria para
    // outra aba assim que alguém criasse uma).
    expect(Object.values(actions)).toContainEqual({
      kind: 'navigate',
      screenId: 'tela-kits:vip',
    });
  });

  it('mostra QUANTO FALTA quando o kit está em cooldown', () => {
    // Um botão que recusa depois do clique faz o jogador clicar três
    // vezes antes de desconfiar — e a frase da API ("o kit X é de
    // resgate único, e 7656… já o pegou em…") não cabe num card.
    const screen = grid([
      offer({
        kind: 'cooldown',
        cooldownSeconds: 86_400,
        available: false,
        reason: 'a frase comprida do painel',
        nextAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      }),
    ]);

    const json = JSON.stringify(screenContentToCui(buildMainMenu(), screen));

    expect(json).toContain('EM 2 H');
    expect(json).not.toContain('a frase comprida do painel');

    // Nenhum botão de compra: o único clicável é o "i".
    expect(Object.values(collectScreenActions(screen)).map((action) => action.kind)).not.toContain(
      'store.buy',
    );
  });

  it('o resgate único já usado diz JÁ PEGOU', () => {
    const screen = grid([offer({ available: false, lastClaimedAt: '2026-08-01T00:00:00.000Z' })]);

    expect(JSON.stringify(screenContentToCui(buildMainMenu(), screen))).toContain('JÁ PEGOU');
  });

  it('pagina depois de oito kits, em vez de sumir com o resto', () => {
    const many = Array.from({ length: 9 }, (_unused, index) =>
      offer({ slug: `kit-${String(index)}`, name: `Kit ${String(index)}` }),
    );

    const json = JSON.stringify(screenContentToCui(buildMainMenu(), grid(many)));

    expect(json).toContain('1 / 2');
  });

  it('o "i" abre o modal, e as abas são ENDEREÇOS', () => {
    const screen = grid([offer()]);
    const actions = collectScreenActions(screen);

    expect(actions['akkit-inicialinfo']).toEqual({
      kind: 'modal.open',
      screenId: 'ozkit:kit-inicial',
    });

    // E o modal traz as duas abas, com a inativa levando à outra.
    const info = buildKitsScreen({
      offers: [offer()],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'geral' },
      itemOf,
    });

    expect(Object.values(collectScreenActions(info))).toContainEqual({
      kind: 'modal.open',
      screenId: 'ozkit:kit-inicial:itens',
    });
  });

  it('a aba GERAL responde "quando peguei?" e "quantas vezes?"', () => {
    const info = buildKitsScreen({
      offers: [
        offer({
          kind: 'cooldown',
          cooldownSeconds: 86_400,
          myClaims: 3,
          lastClaimedAt: '2026-08-10T15:30:00.000Z',
        }),
      ],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'geral' },
    });

    const json = JSON.stringify(screenContentToCui(buildMainMenu(), info));

    expect(json).toContain('Você já pegou 3 vezes');
    expect(json).toContain('Última vez');
  });

  it('a aba ITENS mostra o ícone do jogo, e não o shortname', () => {
    const info = buildKitsScreen({
      offers: [offer()],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'itens' },
      itemOf,
    });

    const json = JSON.stringify(screenContentToCui(buildMainMenu(), info));

    expect(json).toContain('Assault Rifle');
    // O ícone vem do JOGO, pelo itemId — sem download, sem URL.
    expect(json).toContain('"itemid":1545779598');
  });

  it('a aba ITENS pagina o kit comprido, em vez de parar em "e mais 7..."', () => {
    // ####  VISTO NO JOGO  ####
    //
    // Um kit de treze itens mostrava seis e "- e mais 7...", e ali
    // acabava: o jogador ficava sabendo que existiam mais sete e sem
    // nenhuma forma de ver QUAIS — dentro da aba a que ele foi
    // exatamente para isso.
    const many = Array.from({ length: 13 }, (_unused, index) => ({
      slot: 'belt',
      shortname: `item-${String(index)}`,
      amount: 1,
      skinId: '0',
      position: index,
    })) as KitOfferView['items'];

    const nomes = (shortname: string): { itemId: number; displayName: string } => ({
      itemId: 100 + Number(shortname.split('-')[1] ?? '0'),
      displayName: `Item ${shortname.split('-')[1] ?? ''}`,
    });

    const primeira = buildKitsScreen({
      offers: [offer({ items: many })],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'itens' },
      itemOf: nomes,
    });

    const jsonPrimeira = JSON.stringify(screenContentToCui(buildMainMenu(), primeira));

    expect(jsonPrimeira).not.toContain('e mais');
    expect(jsonPrimeira).toContain('1 / 2');
    expect(jsonPrimeira).toContain('Item 0');
    // A sétima linha é um ITEM, e não uma contagem no lugar dele.
    expect(jsonPrimeira).toContain('Item 6');

    // A seta é um ENDEREÇO, como as abas: `modal.open` no mesmo modal
    // com o número no fim.
    expect(Object.values(collectScreenActions(primeira))).toContainEqual({
      kind: 'modal.open',
      screenId: 'ozkit:kit-inicial:itens:1',
    });

    const segunda = buildKitsScreen({
      offers: [offer({ items: many })],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'itens', page: 1 },
      itemOf: nomes,
    });

    // ####  O ID QUE VOLTA É O ID QUE FOI PEDIDO  ####
    //
    // O plugin descarta a tela cujo id não bate com o que ele pediu,
    // e o "carregando" fica preso até o timeout: a seta pareceria
    // não funcionar.
    expect(segunda.id).toBe('ozkit:kit-inicial:itens:1');

    const jsonSegunda = JSON.stringify(screenContentToCui(buildMainMenu(), segunda));

    // E o décimo terceiro item, que antes não existia para o jogador,
    // está na tela.
    expect(jsonSegunda).toContain('Item 12');
    expect(jsonSegunda).toContain('2 / 2');
    // A volta também: ninguém entra numa página sem saída.
    expect(Object.values(collectScreenActions(segunda))).toContainEqual({
      kind: 'modal.open',
      screenId: 'ozkit:kit-inicial:itens',
    });
  });

  it('a aba GERAL pagina do mesmo jeito, e não corta a última linha', () => {
    const info = buildKitsScreen({
      offers: [
        offer({
          kind: 'cooldown',
          cooldownSeconds: 86_400,
          description: 'Um kit de reposição para quem acabou de morrer.',
          requiredTier: 'gold',
          myClaims: 4,
          lastClaimedAt: '2026-08-10T15:30:00.000Z',
          nextAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'geral' },
    });

    const json = JSON.stringify(screenContentToCui(buildMainMenu(), info));

    // Cinco linhas cabem nas sete da área: a aba não pagina por
    // paginar. O que ela NÃO faz é sumir com a última em silêncio.
    expect(json).not.toContain('e mais');
    expect(json).toContain('Você pode pegar de novo em 1 h');
  });

  it('uma página que não existe mais mostra a última, e não uma tela vazia', () => {
    // O admin tirou itens do kit depois que o jogador abriu o menu.
    const info = buildKitsScreen({
      offers: [offer()],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'itens', page: 9 },
      itemOf,
    });

    expect(JSON.stringify(screenContentToCui(buildMainMenu(), info))).toContain('Assault Rifle');
  });

  it('sem catálogo lido, a lista mostra o shortname e NÃO finge um ícone', () => {
    const info = buildKitsScreen({
      offers: [offer()],
      target: { kind: 'info', slug: 'kit-inicial', tab: 'itens' },
    });

    const json = JSON.stringify(screenContentToCui(buildMainMenu(), info));

    expect(json).toContain('rifle.ak');
    expect(json).not.toContain('"itemid"');
  });

  it('a tela gerada é volátil: o plugin não pode guardá-la', () => {
    // Ela mostra "EM 2 H" e quem já pegou o quê. Em cache, mostraria
    // isso para sempre.
    const document = buildMainMenu();
    const bundle = toGeneratedScreenBundle(document, grid([offer()]), 'tela-kits');

    expect(bundle.volatile).toBe(true);
    // E o SHELL entra na tabela de ações: sem isso o plugin recusaria
    // o clique em HOME enquanto o jogador estivesse aqui.
    expect(Object.keys(bundle.actions)).toContain('ir-home');
  });

  /**
   * ####  ASPAS DUPLAS CHEGAM ESCAPADAS NA TELA  ####
   *
   * MEDIDO no jogo: o motivo de um kit apareceu como
   *
   *     O kit \"Kit Inicial\" é de resgate único
   *
   * com as barras à mostra. O `CuiHelper.AddUi` manda o JSON como
   * ARGUMENTO de um comando de console, e essa serialização escapa as
   * aspas de novo — o cliente desfaz uma camada só.
   *
   * A troca por aspas tipográficas acontece na EMISSÃO, para valer
   * também no que o admin digitar no editor.
   */
  it('não deixa aspas retas chegarem ao cliente', () => {
    const screen = grid([offer({ name: 'Kit "Inicial"' })]);
    const json = JSON.stringify(screenContentToCui(buildMainMenu(), screen));

    // No JSON serializado, uma aspa reta apareceria como `\"`.
    expect(json).not.toContain('\\\\"');
    expect(json).toContain('Kit “Inicial”');
  });
});
