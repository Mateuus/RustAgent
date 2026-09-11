// ============================================================
//  custom-items.test.ts  -  as promessas do item custom que
//  ninguém confere olhando.
//
//  O que este arquivo guarda:
//
//    1. a MARCA é única — duas definições com o mesmo par
//       (base, skin) deixariam o plugin sem critério para escolher
//       qual dos dois itens ele está vendo;
//    2. skin '0' é recusada. Dois motivos independentes, e o
//       segundo DERRUBA O JOGADOR do servidor pelo caminho do CUI;
//    3. o item base precisa existir no catálogo do jogo — conferir
//       no cadastro é a diferença entre falhar agora e falhar dias
//       depois, na entrega, com o jogador esperando;
//    4. o `id` sai do NOME e NÃO muda quando o nome muda: renomear
//       não pode quebrar o kit que aponta para o item;
//    5. o PUT reescreve os servidores INTEIROS — quem desmarcou um
//       na tela espera que ele saia;
//    6. desligar não apaga, e apagar leva as ligações junto;
//    7. o item base que sumiu do jogo aparece MARCADO, e não some;
//    8. a ação atravessa o banco e volta inteira;
//    9. e o CADASTRO CHEGA AO PLUGIN — o elo que faltava até
//       05/09/2026: o plugin pedia (`#OZAREQ#items`) e ninguém
//       respondia. Ver Docs\CustomItem\03 §6.
//
//  Banco em memória: é o que permite testar o cadastro inteiro sem
//  servidor de Rust nenhum — que é justamente a promessa da tela.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  CustomItemsRepository,
  slugify,
  type CustomItemInput,
} from '../src/db/custom-items-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import {
  apiErrorToResponse,
  isApiError,
  zodErrorToResponse,
} from '../src/http/error-response.js';
import {
  CLEAR_COMMAND,
  CustomItemsSync,
  itemIconKey,
  REQUEST_LINE,
  SET_COMMAND,
  type RankingLabels,
} from '../src/game/custom-items-sync.js';
import { ImageLibrary } from '../src/game/image-library.js';
import { registerCustomItemRoutes } from '../src/http/routes/custom-items.js';
import { createLogger } from '../src/logger.js';

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: CustomItemsRepository;
  readonly app: FastifyInstance;
}

let harness: Harness;

/** O troféu, que é o primeiro item custom que este projeto terá. */
function trofeu(overrides: Partial<CustomItemInput> = {}): CustomItemInput {
  return {
    displayName: 'Troféu Bleik Store',
    baseShortname: 'trophy',
    skinId: '3000000001',
    category: 'Troféus',
    description: 'Prêmio da temporada.',
    iconFile: null,
    maxStack: null,
    deployable: false,
    consumeOnPickup: false,
    action: { kind: 'none' },
    message: null,
    enabled: true,
    servers: ['pvp1'],
    ...overrides,
  };
}

beforeEach(async () => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const items = new ItemsRepository(db);
  const servers = new ServersRepository(db);
  const repository = new CustomItemsRepository(db);

  // O catálogo do jogo, com os dois itens de que os testes
  // precisam. `trophy` é o real, com o item_id MEDIDO no servidor.
  items.replace({
    items: [
      {
        shortname: 'trophy',
        displayName: 'Twitch Rivals Trophy',
        itemId: 975983052,
        category: 'Items',
        maxStack: 1,
        hasCondition: false,
        // MEDIDO: o troféu é decorativo. Não tem
        // `ItemModConsumable`, e por isso "usar" não existe nele —
        // é o item que torna a armadilha do "só ao usar" real.
        consumable: false,
      },
      {
        shortname: 'bandage',
        displayName: 'Bandage',
        itemId: -2072273936,
        category: 'Medical',
        maxStack: 3,
        hasCondition: false,
        consumable: true,
      },
      {
        shortname: 'sticks',
        displayName: 'Sticks',
        itemId: -1090916276,
        category: 'Resources',
        maxStack: 1000,
        hasCondition: false,
        // Sem o campo: é como um plugin ANTERIOR a 06/09/2026
        // responde ao `origemz.items`. Vira `null` na tabela, que é
        // "ninguém perguntou" — e não "não é consumível".
      },
    ],
    protocol: '2633.288.1',
    at: 1_000,
  });

  servers.create({
    id: 'pvp1',
    name: 'PVP 1',
    identity: 'pvp1',
    enabled: true,
    gamePort: 28015,
    rconPort: 28016,
    queryPort: 28017,
    appPort: 28082,
    rconHost: '127.0.0.1',
    installDir: 'Servers/pvp1',
  });

  const app = Fastify();

  // O mesmo tratamento do servidor real (http/server.ts:310). Sem
  // a linha do ZodError, uma recusa de validação viria como 500 e o
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
      registerCustomItemRoutes(api, { repository, items, servers });
    },
    { prefix: '/api' },
  );

  harness = { db, repository, app };
});

// ------------------------------------------------------------
//  A marca
// ------------------------------------------------------------

describe('a marca do item', () => {
  it('recusa duas definições com o MESMO par (base, skin)', async () => {
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu(),
    });

    expect(first.statusCode).toBe(201);

    const clash = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      // Outro nome, MESMA marca. É o caso que deixaria o plugin sem
      // critério para escolher qual dos dois está vendo.
      payload: trofeu({ displayName: 'Medalha de Evento' }),
    });

    expect(clash.statusCode).toBe(409);
    expect(clash.json<{ error: string }>().error).toBe('DUPLICATE_MARK');
  });

  it('aceita a mesma skin em item base DIFERENTE', async () => {
    await harness.app.inject({ method: 'POST', url: '/api/custom-items', payload: trofeu() });

    // A marca é o PAR. A mesma skin numa bandagem é outro item, e o
    // plugin distingue os dois sem ambiguidade.
    const other = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({ displayName: 'Super Bandagem', baseShortname: 'bandage' }),
    });

    expect(other.statusCode).toBe(201);
  });

  it('recusa skin ZERO', async () => {
    // Skin 0 é indistinguível de item comum — e, num item sem
    // skins, ela DERRUBA o jogador do servidor pelo caminho do CUI.
    // Ver Docs\TrofeuBleik §2.6.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({ skinId: '0' }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('recusa item base que o jogo não tem', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({ baseShortname: 'nao.existe' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('UNKNOWN_BASE_ITEM');
  });

  it('recusa servidor que não existe', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({ servers: ['pvp1', 'fantasma'] }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('UNKNOWN_SERVER');
  });
});

// ------------------------------------------------------------
//  O identificador
// ------------------------------------------------------------

describe('o id', () => {
  it('sai do nome, sem acento nem maiúscula', () => {
    expect(slugify('Troféu Bleik Store')).toBe('trofeu-bleik-store');
    expect(slugify('  Super   Bandagem!  ')).toBe('super-bandagem');
    // Nome só de símbolos deixaria o id vazio, e um id vazio
    // colidiria com o próximo nome só de símbolos.
    expect(slugify('★★★')).toBe('item');
  });

  it('NÃO muda quando o nome muda', () => {
    const created = harness.repository.create(trofeu());

    expect(created.id).toBe('trofeu-bleik-store');

    const renamed = harness.repository.update(created.id, trofeu({ displayName: 'Outro Nome' }));

    // Renomear não pode quebrar o kit, a oferta e a marca gravada
    // no item que já está no inventário de alguém.
    expect(renamed?.id).toBe('trofeu-bleik-store');
    expect(renamed?.displayName).toBe('Outro Nome');
  });

  it('não colide quando dois itens têm o mesmo nome', () => {
    const first = harness.repository.create(trofeu());
    const second = harness.repository.create(trofeu({ skinId: '3000000002' }));

    expect(first.id).toBe('trofeu-bleik-store');
    // O sufixo é feio de propósito: ele avisa quem cadastrou que já
    // existe um item com aquele nome.
    expect(second.id).toBe('trofeu-bleik-store-2');
  });
});

// ------------------------------------------------------------
//  Os servidores
// ------------------------------------------------------------

describe('os servidores do item', () => {
  it('o PUT reescreve a lista INTEIRA', async () => {
    harness.repository.create(trofeu());

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/custom-items/trofeu-bleik-store',
      payload: trofeu({ servers: [] }),
    });

    expect(response.statusCode).toBe(200);
    // Quem desmarcou o servidor na tela espera que ele saia. Um
    // merge parcial deixaria a ligação de pé.
    expect(harness.repository.get('trofeu-bleik-store')?.servers).toEqual([]);
  });

  it('o servidor só enxerga o que está LIGADO nele', () => {
    harness.repository.create(trofeu());
    harness.repository.create(
      trofeu({ displayName: 'Desligado', skinId: '3000000009', enabled: false }),
    );

    const forServer = harness.repository.listForServer('pvp1');

    expect(forServer).toHaveLength(1);
    expect(forServer[0]?.displayName).toBe('Troféu Bleik Store');
  });
});

// ------------------------------------------------------------
//  Desligar, apagar e o item base que some
// ------------------------------------------------------------

describe('o ciclo de vida', () => {
  it('desligar NÃO apaga', async () => {
    harness.repository.create(trofeu());

    await harness.app.inject({
      method: 'PUT',
      url: '/api/custom-items/trofeu-bleik-store',
      payload: trofeu({ enabled: false }),
    });

    // A linha continua: quem já tem o troféu no baú precisa que o
    // plugin continue reconhecendo a marca.
    expect(harness.repository.get('trofeu-bleik-store')?.enabled).toBe(false);
  });

  it('apagar leva as ligações de servidor junto', () => {
    harness.repository.create(trofeu());

    expect(harness.repository.remove('trofeu-bleik-store')).toBe(true);

    const orphans = harness.db
      .prepare('SELECT count(*) AS total FROM custom_item_servers')
      .get() as { total: number };

    expect(orphans.total).toBe(0);
  });

  it('marca o item cujo BASE sumiu do jogo, e não o apaga', () => {
    harness.repository.create(trofeu());
    expect(harness.repository.get('trofeu-bleik-store')?.baseMissing).toBe(false);

    // Um update do Rust em que o `trophy` deixa de existir.
    //
    // ####  A VARREDURA NÃO APAGA: ELA MARCA  ####
    //
    // A `items` guarda o item que saiu do jogo de propósito (ver a
    // migração 007), e quem responde "ainda existe?" são as duas
    // datas. Por isso o teste refaz a varredura SEM o troféu, em
    // vez de apagar a linha — apagar é o que nunca acontece.
    const items = new ItemsRepository(harness.db);

    items.replace({
      items: [
        {
          shortname: 'bandage',
          displayName: 'Bandage',
          itemId: -2072273936,
          category: 'Medical',
          maxStack: 3,
          hasCondition: false,
        },
      ],
      protocol: '2700.0.0',
      at: 2_000,
    });

    const item = harness.repository.get('trofeu-bleik-store');

    // A linha continua, e agora avisa. Um item custom em cima de um
    // shortname que o Rust não tem mais nunca vai ser entregue — e
    // a tela precisa dizer isso antes de alguém tentar.
    expect(item).not.toBeNull();
    expect(item?.baseMissing).toBe(true);
  });
});

// ------------------------------------------------------------
//  A ação
// ------------------------------------------------------------

describe('a ação', () => {
  it('atravessa o banco e volta inteira', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        displayName: 'Super Bandagem',
        baseShortname: 'bandage',
        skinId: '3000000003',
        action: {
          kind: 'consume',
          trigger: 'use',
          consumes: 1,
          effects: [
            { type: 'Health', amount: 40 },
            { type: 'Bleeding', amount: -100 },
          ],
        },
      }),
    });

    expect(response.statusCode).toBe(201);

    const saved = harness.repository.get('super-bandagem');

    expect(saved?.action.kind).toBe('consume');
    expect(saved?.action.effects).toHaveLength(2);
    // O negativo é o que ESTANCA o sangramento: se o JSON perdesse
    // o sinal no caminho, a bandagem passaria a sangrar o jogador.
    expect(saved?.action.effects?.[1]?.amount).toBe(-100);
  });

  it('recusa um tipo de efeito que o jogo não tem', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        skinId: '3000000004',
        action: {
          kind: 'consume',
          trigger: 'use',
          consumes: 1,
          // Os oito tipos são MEDIDOS no enum do jogo. Um nono só
          // falharia dentro do Rust, em silêncio, com o jogador
          // achando que o item está quebrado.
          effects: [{ type: 'Mana', amount: 10 }],
        },
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('recusa uma ação de uso SEM efeito nenhum', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        skinId: '3000000005',
        action: { kind: 'consume', trigger: 'use', consumes: 1, effects: [] },
      }),
    });

    expect(response.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------
//  O momento da conversão, e a armadilha que ele abre
// ------------------------------------------------------------
//
//  ####  "SÓ AO USAR" NÃO EXISTE EM TODO ITEM  ####
//
//  O `OnItemUse` do Oxide só dispara em quem tem
//  `ItemModConsumable`, e o menu do botão direito é montado pelo
//  CLIENTE a partir da `ItemDefinition` — nenhum plugin acrescenta
//  opção nele. Um troféu configurado para esperar o uso fica
//  INERTE: o jogador pega, clica, e nada acontece.
//
//  Estes testes guardam a recusa no cadastro, que é o único
//  momento em que alguém está olhando.

describe('o momento da conversão', () => {
  it('recusa "ao usar" quando o item base NÃO é consumível', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        skinId: '3000000010',
        consumeOnPickup: false,
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1 },
      }),
    });

    expect(response.statusCode).toBe(400);

    const body = response.json() as { error: string; message: string };

    expect(body.error).toBe('BASE_ITEM_NOT_CONSUMABLE');
    // A frase precisa dizer O QUE FAZER, e não só que deu errado.
    expect(body.message).toContain('Assim que cair no inventário');
  });

  it('aceita "ao usar" quando o item base é consumível', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        displayName: 'Bala do Ranking',
        baseShortname: 'bandage',
        skinId: '3000000011',
        consumeOnPickup: false,
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 2 },
      }),
    });

    expect(response.statusCode).toBe(201);
  });

  it('aceita "ao usar" quando o catálogo ainda NÃO sabe responder', async () => {
    // `sticks` veio de um plugin anterior ao campo `consumable`, e
    // a coluna ficou nula. Recusar por FALTA de dado quebraria a
    // promessa de que o cadastro funciona com tudo parado — e o
    // plugin ainda avisa no log se a combinação chegar lá.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        displayName: 'Graveto Premiado',
        baseShortname: 'sticks',
        skinId: '3000000012',
        consumeOnPickup: false,
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1 },
      }),
    });

    expect(response.statusCode).toBe(201);
  });

  it('o item base NÃO consumível continua valendo no modo de pegada', async () => {
    // É o Troféu Bleik como ele nasceu: o item some ao entrar, e
    // "usar" nunca precisa existir.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        skinId: '3000000013',
        consumeOnPickup: true,
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1 },
      }),
    });

    expect(response.statusCode).toBe(201);
  });

  it('a COLUNA manda: o `action.onPickup` é gravado como espelho dela', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/custom-items',
      payload: trofeu({
        displayName: 'Espelho',
        baseShortname: 'bandage',
        skinId: '3000000014',
        consumeOnPickup: false,
        // O painel de antes mandava `true` (o default do zod) ao
        // lado de `consumeOnPickup: false`. Sem o espelho, quem
        // lesse o JSON concluiria o oposto do que o jogo faz.
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1, onPickup: true },
      }),
    });

    const saved = harness.repository.get('espelho');

    expect(saved?.consumeOnPickup).toBe(false);
    expect(saved?.action.onPickup).toBe(false);
  });
});

// ------------------------------------------------------------
//  O elo que faltava: o cadastro chegando ao plugin
// ------------------------------------------------------------
//
//  ####  ATE 05/09/2026 NINGUEM ESCUTAVA O PLUGIN  ####
//
//  O `OrigemZItems` grita `#OZAREQ#items` quando sobe, e nenhuma
//  linha de TypeScript respondia. O item existia no banco, aparecia
//  no painel, era entregue com a skin certa - e o plugin nunca
//  soube que ele existe. Ver Docs\CustomItem\03 §6.
//
//  Estes quatro testes guardam as quatro promessas do elo:
//  ele responde ao pedido, ele ignora o resto do console, ele nao
//  quebra sem RCON, e o que ele manda leva a acao inteira.

/** Um RCON de mentira, que guarda o que foi mandado. */
class FakeRcon {
  isConnected = true;
  readonly sent: string[] = [];
  reply = '{"ok":true}';

  send(command: string): Promise<string> {
    this.sent.push(command);
    return Promise.resolve(this.reply);
  }
}

/** O debounce do `invalidate`, com folga para o relogio do Windows. */
const AFTER_DEBOUNCE_MS = 400;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, AFTER_DEBOUNCE_MS));
}

function syncHarness(rankings?: RankingLabels): {
  readonly sync: CustomItemsSync;
  readonly pvp1: FakeRcon;
  readonly pvp2: FakeRcon;
} {
  const pvp1 = new FakeRcon();
  const pvp2 = new FakeRcon();

  const sync = new CustomItemsSync({
    repository: harness.repository,
    servers: {
      ids: () => ['pvp1', 'pvp2'],
      contextOf: (id) => {
        if (id === 'pvp1') {
          return { rcon: pvp1 };
        }

        return id === 'pvp2' ? { rcon: pvp2 } : null;
      },
    },
    // Ausente na maioria dos testes de propósito: a definição tem de
    // chegar ao jogo com ou sem catálogo de rankings.
    ...(rankings === undefined ? {} : { rankings }),
    logger: createLogger({ log: { level: 'silent', pretty: false } }),
  });

  return { sync, pvp1, pvp2 };
}

describe('o cadastro chegando ao plugin', () => {
  it('responde ao `#OZAREQ#items` daquele servidor, e SÓ dele', async () => {
    const { sync, pvp1, pvp2 } = syncHarness();

    // A linha vem como o Oxide a imprime: o `Puts` carimba o nome
    // do plugin na frente.
    sync.handleLine('pvp1', `[OrigemZItems] ${REQUEST_LINE}`);

    await settle();

    // O `clear` primeiro é o que faz um item apagado no painel
    // sumir do jogo.
    expect(pvp1.sent[0]).toBe(CLEAR_COMMAND);
    // E o servidor que não pediu nada não recebe nada: um `clear`
    // ali esvaziaria o cache de quem estava bem.
    expect(pvp2.sent).toEqual([]);

    sync.stop();
  });

  it('ignora a linha que não é nossa, e não lança', async () => {
    const { sync, pvp1 } = syncHarness();

    // O gancho recebe TODA linha do console — centenas por minuto
    // num servidor cheio.
    expect(() => {
      sync.handleLine('pvp1', '[CHAT] Mateuus: bom dia');
      sync.handleLine('pvp1', 'Saved 34,145 ents, serialization 12ms');
      // O marcador de outro assunto, do mesmo plugin.
      sync.handleLine('pvp1', '[OrigemZAgent] #OZAREQ#kits');
      // E o ECO do nosso próprio comando: se ele contasse como
      // pedido, o laço do §11.6 se fecharia sozinho.
      sync.handleLine('pvp1', `${SET_COMMAND} {"message":"${REQUEST_LINE}"}`);
    }).not.toThrow();

    await settle();

    expect(pvp1.sent).toEqual([]);

    sync.stop();
  });

  it('sem RCON é `skipped`, e não derruba nada', async () => {
    const { sync, pvp1 } = syncHarness();

    pvp1.isConnected = false;

    const result = await sync.push('pvp1', 'teste');

    // Servidor parado é o caso NORMAL: metade da lista costuma
    // estar fora. Erro aqui viraria alarme que se aprende a
    // ignorar — e o cadastro sobe sozinho na reconexão.
    expect(result.skipped).not.toBeNull();
    expect(result.sent).toBe(0);
    expect(pvp1.sent).toEqual([]);

    sync.stop();
  });

  it('leva o `consumeOnPickup` e o bloco `points` até o plugin', async () => {
    harness.repository.create(
      trofeu({
        displayName: 'Troféu Bleik Store',
        baseShortname: 'trophy',
        skinId: '3000000042',
        consumeOnPickup: true,
        maxStack: null,
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 3, onPickup: true },
      }),
    );

    const { sync, pvp1 } = syncHarness();

    await sync.push('pvp1', 'teste');

    const set = pvp1.sent.find((command) => command.startsWith(SET_COMMAND)) ?? '';
    const body = JSON.parse(set.slice(SET_COMMAND.length + 1)) as Record<string, unknown>;

    expect(body.consumeOnPickup).toBe(true);
    expect(body.action).toEqual({ kind: 'points', metric: 'trophy.bleik', perUnit: 3 });
    // ####  O CAMPO NULO NÃO VIAJA  ####
    //
    // MEDIDO: `"maxStack":null` estoura o `ParseItem` com "Can not
    // convert Null to Int32" e o item inteiro é recusado. E
    // `max_stack` é nulo na maioria dos cadastros.
    expect(set).not.toContain('null');
    // O `onPickup` fica de fora: quem decide o "quando" é a COLUNA,
    // e o `ParseAction` do plugin nem lê esse campo. Ver §3.2.
    expect(set).not.toContain('onPickup');

    sync.stop();
  });
});

// ------------------------------------------------------------
//  O ícone, que ficava no disco do agente
// ------------------------------------------------------------
//
//  ####  ATÉ 11/09/2026 O PNG NUNCA SAÍA DE `Assets\items`  ####
//
//  O painel gravava o arquivo e o nome; o plugin tinha comandos para
//  recebê-lo. Nenhuma linha daqui os ligava, e o troféu aparecia no
//  jogo com o ícone da taça.

describe('o ícone do item chegando ao OrigemZImages', () => {
  it('sobe com a chave `item.<id>`, ANTES do cadastro', async () => {
    const created = harness.repository.create(trofeu({ iconFile: 'trofeu.png' }));
    const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const pvp1 = new FakeRcon();
    const lidos: string[] = [];

    // O plugin ainda não tem nada.
    pvp1.send = (command: string): Promise<string> => {
      pvp1.sent.push(command);
      return Promise.resolve(
        command === 'origemz.image.list' ? '{"ok":true,"ready":true,"images":{}}' : '{"ok":true}',
      );
    };

    const sync = new CustomItemsSync({
      repository: harness.repository,
      servers: { ids: () => ['pvp1'], contextOf: (id) => (id === 'pvp1' ? { rcon: pvp1 } : null) },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
      icons: {
        library: new ImageLibrary(),
        read: (file) => {
          lidos.push(file);
          return file === 'trofeu.png' ? icon : null;
        },
      },
    });

    await sync.push('pvp1', 'teste');

    const begin = pvp1.sent.findIndex((line) => line.startsWith('origemz.image.begin '));
    const clear = pvp1.sent.findIndex((line) => line.startsWith(CLEAR_COMMAND));

    expect(lidos).toEqual(['trofeu.png']);
    expect(pvp1.sent[begin]?.split(' ')[1]).toBe(itemIconKey(created.id));
    // Quando o `set` chegar e o plugin vestir o item, o CRC já está lá.
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(clear);

    sync.stop();
  });

  it('o ícone TIRADO no painel é esquecido no jogo', async () => {
    const created = harness.repository.create(trofeu());

    const pvp1 = new FakeRcon();

    // O OrigemZImages ainda tem o ícone de quando o item tinha um — a
    // tabela dele sobrevive a reload e a restart.
    pvp1.send = (command: string): Promise<string> => {
      pvp1.sent.push(command);
      return Promise.resolve(
        command === 'origemz.image.list'
          ? JSON.stringify({ ok: true, ready: true, images: { [itemIconKey(created.id)]: 'aa' } })
          : '{"ok":true}',
      );
    };

    const sync = new CustomItemsSync({
      repository: harness.repository,
      servers: { ids: () => ['pvp1'], contextOf: (id) => (id === 'pvp1' ? { rcon: pvp1 } : null) },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
      icons: { library: new ImageLibrary(), read: () => null },
    });

    await sync.push('pvp1', 'teste');

    // Sem isto o plugin continuaria vestindo o troféu com a arte velha.
    expect(pvp1.sent).toContain(`origemz.image.forget ${itemIconKey(created.id)}`);
    expect(pvp1.sent.some((line) => line.startsWith('origemz.image.begin'))).toBe(false);

    sync.stop();
  });
});


// ------------------------------------------------------------
//  O rótulo do ranking, que o plugin não tem como saber
// ------------------------------------------------------------

describe('o rótulo do ranking na definição', () => {
  it('viaja no `set`, para o `{ranking}` da mensagem virar um nome', async () => {
    harness.repository.create(
      trofeu({
        skinId: '3000000020',
        consumeOnPickup: true,
        message: 'Você ganhou {pontos} {item}! Vale no {ranking}. {total}',
        action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1 },
      }),
    );

    const { sync, pvp1 } = syncHarness({
      getByMetric: (metric) =>
        metric === 'trophy.bleik' ? { label: 'Troféu Bleik Store' } : null,
    });

    await sync.push('pvp1', 'teste');

    const set = pvp1.sent.find((command) => command.startsWith(SET_COMMAND)) ?? '';
    const body = JSON.parse(set.slice(SET_COMMAND.length + 1)) as {
      action: Record<string, unknown>;
    };

    // A MÉTRICA é o protocolo e continua indo; o rótulo é só para a
    // tela do jogador.
    expect(body.action.metric).toBe('trophy.bleik');
    expect(body.action.ranking).toBe('Troféu Bleik Store');

    sync.stop();
  });

  it('o cadastro cujo ranking sumiu continua chegando ao jogo, sem o rótulo', async () => {
    harness.repository.create(
      trofeu({
        skinId: '3000000021',
        consumeOnPickup: true,
        action: { kind: 'points', metric: 'metrica.orfa', perUnit: 1 },
      }),
    );

    const { sync, pvp1 } = syncHarness({ getByMetric: () => null });

    const result = await sync.push('pvp1', 'teste');

    // A identidade do item (nome, ícone) não depende do ranking:
    // segurar a definição por causa do rótulo tiraria o nome do
    // item do jogo junto.
    expect(result.sent).toBe(1);

    const set = pvp1.sent.find((command) => command.startsWith(SET_COMMAND)) ?? '';

    expect(set).not.toContain('"ranking"');

    sync.stop();
  });
});
