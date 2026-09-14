// ============================================================
//  quests-containers.test.ts  -  saquear a CAIXA, e não o que vem
//  dentro dela.
//
//  O que este arquivo guarda:
//
//    1. `@barrel` alcança os cinco barris e NENHUMA caixa — se a
//       classificação escorregar, "Limpeza da Estrada" passa a
//       contar caixa de elite e ninguém percebe olhando a tela;
//    2. a categoria é gravada COMO CATEGORIA. Expandi-la no
//       cadastro congelaria o catálogo do dia em que a missão foi
//       escrita, e um contêiner novo do Rust nunca entraria nela;
//    3. o `watch` desce com os prefabs EXPANDIDOS (é o corte
//       rápido do plugin) e com os conjuntos ao lado (é o que
//       resolve a categoria lá). Sem os dois, ou o plugin conta o
//       mundo inteiro, ou não conta nada;
//    4. o `assign` manda o seletor CRU. Expandi-lo aqui mandaria 65
//       prefabs por objetivo, por jogador, por rodada;
//    5. um alvo a mais no objetivo NÃO cria um contador a mais —
//       é o "total compartilhado" do pedido, e é a diferença entre
//       20/20 e quatro contadores de cinco;
//    6. o zod recusa o que viraria um objetivo que nunca conta:
//       saque sem alvo, categoria inventada, lista pendurada num
//       objetivo que não é de saque;
//    7. o agente AVISA quando o plugin daquele servidor é mais
//       velho que a missão. O recurso é aditivo de propósito —
//       nada quebra —, e sem o aviso ele ficaria inerte em
//       silêncio, que é o pior desfecho possível.
//
//  Banco em memória e migrações reais, como os outros testes de
//  quests: a migração 084 recria a tabela, e um mock não provaria
//  que os objetivos antigos sobreviveram à cópia.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { LOOT_CONTAINERS } from '../src/game/loot-containers.js';
import {
  containerFamilyOf,
  containerSetsOf,
  containersOfCategory,
  describeContainerSelectors,
  expandContainerSelectors,
  isValidContainerSelector,
  questContainerCatalog,
} from '../src/game/quest-containers.js';
import { createLogger } from '../src/logger.js';
import { QuestCollector, type QuestCollectorRcon } from '../src/quests/collector.js';
import { QuestsService } from '../src/quests/service.js';
import { questInputSchema, type QuestDraft, type QuestInput } from '../src/types/quests.js';

const logger = createLogger({ log: { level: 'silent', pretty: false } });
const NOW = 1_757_000_000_000;
const FULANO = '76561198000000001';

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: QuestsRepository;
  readonly service: QuestsService;
  readonly sent: string[];
  /** O que o plugin responde ao `watch`. É o que o teste troca. */
  watchReply: string;
  readonly warnings: string[];
}

/** A resposta de um plugin desta versão. */
const WATCH_OK = JSON.stringify({
  ok: true,
  contract: 1,
  targets: 5,
  kinds: ['kill', 'gather', 'craft', 'loot', 'container', 'deliver'],
});

let h: Harness;

function quest(overrides: Partial<QuestDraft> = {}): QuestInput {
  return questInputSchema.parse({
    title: 'Limpeza da Estrada',
    category: 'diaria',
    objectives: [{ seq: 0, kind: 'container', targets: ['@barrel'], amount: 20 }],
    rewards: [],
    ...overrides,
  });
}

function collector(): QuestCollector {
  const rcon: QuestCollectorRcon = {
    isConnected: true,
    send: (command: string) => {
      h.sent.push(command);

      // Cada comando tem a resposta dele. Devolver a mesma para
      // todos faria o `flush` não parsear, a rodada inteira cair no
      // catch — e o teste provaria o caminho do erro achando que
      // provava o do sucesso.
      if (command.startsWith('origemz.quest.watch')) {
        return Promise.resolve(h.watchReply);
      }

      if (command.startsWith('origemz.quest.flush')) {
        return Promise.resolve(
          JSON.stringify({ ok: true, contract: 1, batchId: 'b1', entries: [], total: 0 }),
        );
      }

      return Promise.resolve(JSON.stringify({ ok: true, contract: 1 }));
    },
  };

  return new QuestCollector({
    repository: h.repository,
    service: h.service,
    servers: { ids: () => ['pvp1'], contextOf: () => ({ rcon }) },
    presence: { online: () => Promise.resolve([FULANO]) },
    // O logger de teste guarda o que foi avisado: o aviso do plugin
    // velho é uma PROMESSA deste módulo, e não um efeito colateral.
    logger: {
      ...logger,
      warn: (_meta: unknown, message?: string) => {
        h.warnings.push(message ?? '');
      },
    } as unknown as typeof logger,
    secret: 'segredo-de-teste',
    now: () => NOW,
  });
}

/** O payload de um comando `origemz.quest.*`, já decodificado. */
function payloadOf(command: string): Record<string, unknown> {
  const base64 = command.slice(command.lastIndexOf(' ') + 1);

  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
}

function lastCommand(prefix: string): string {
  const found = [...h.sent].reverse().find((command) => command.startsWith(prefix));

  if (found === undefined) {
    throw new Error(`nenhum comando "${prefix}" foi mandado`);
  }

  return found;
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  // Dois, porque uma das promessas é justamente que a quest de UM
  // servidor não obriga o outro a observar nada. As portas são
  // únicas no banco, como em produção.
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

  h = {
    db,
    repository,
    service: new QuestsService({ repository, logger }),
    sent: [],
    watchReply: WATCH_OK,
    warnings: [],
  };
});

// ------------------------------------------------------------
//  O CATÁLOGO
// ------------------------------------------------------------

describe('a família de um contêiner', () => {
  it('barril é barril, e caixa é caixa', () => {
    expect(containerFamilyOf('loot_barrel_1')).toBe('barrel');
    expect(containerFamilyOf('loot-barrel-2')).toBe('barrel');
    expect(containerFamilyOf('oil_barrel')).toBe('barrel');

    expect(containerFamilyOf('crate_elite')).toBe('crate');
    expect(containerFamilyOf('foodbox')).toBe('crate');
    expect(containerFamilyOf('heli_crate')).toBe('crate');
  });

  it('o entulho de estrada não é nem um nem outro', () => {
    // ####  A PLACA NÃO É UMA CAIXA  ####
    //
    // Ela mora no grupo "Barris e lixo" do catálogo, que é o único
    // grupo que mistura duas coisas. Enfiá-la em `@crate` faria
    // "qualquer caixa" contar o que ninguém chama de caixa.
    expect(containerFamilyOf('roadsign1')).toBe('debris');
    expect(containerFamilyOf('loot_trash')).toBe('debris');
    expect(containerFamilyOf('minecart')).toBe('debris');
  });

  it('o prefab digitado à mão vale como caixa', () => {
    // O cadastro aceita prefab fora do catálogo de propósito — ver
    // o cabeçalho de `loot-containers.ts`. Ele casa por si mesmo; a
    // família só decide se uma CATEGORIA o alcança.
    expect(containerFamilyOf('crate_inventado_do_futuro')).toBe('crate');
  });
});

describe('as categorias', () => {
  it('`@barrel` alcança os barris e nenhuma caixa', () => {
    const barris = containersOfCategory('@barrel');

    expect(barris).toContain('loot_barrel_1');
    expect(barris).toContain('oil_barrel');
    expect(barris).not.toContain('crate_elite');
    expect(barris).not.toContain('roadsign1');
  });

  it('`@crate` alcança as caixas e nenhum barril', () => {
    const caixas = containersOfCategory('@crate');

    expect(caixas).toContain('crate_elite');
    expect(caixas).toContain('crate_normal');
    expect(caixas).not.toContain('loot_barrel_1');
  });

  it('`@any` é a rota inteira: barril, caixa e entulho', () => {
    expect(containersOfCategory('@any')).toHaveLength(LOOT_CONTAINERS.length);
  });

  it('uma categoria que não existe alcança nada, e não explode', () => {
    // Uma linha velha no banco não pode derrubar a rodada do
    // coletor. O zod já recusa isto na entrada.
    expect(containersOfCategory('@inventada')).toEqual([]);
  });

  it('o seletor é conferido: categoria conhecida ou formato de prefab', () => {
    expect(isValidContainerSelector('@barrel')).toBe(true);
    expect(isValidContainerSelector('crate_elite')).toBe(true);
    expect(isValidContainerSelector('satellite_crate_1.entity')).toBe(true);

    expect(isValidContainerSelector('@inventada')).toBe(false);
    expect(isValidContainerSelector('dm ammo')).toBe(false);
    expect(isValidContainerSelector('CRATE_ELITE')).toBe(false);
  });
});

describe('a expansão', () => {
  it('não repete o prefab que já veio pela categoria', () => {
    const expandido = expandContainerSelectors(['@barrel', 'loot_barrel_1', 'crate_elite']);

    expect(expandido.filter((prefab) => prefab === 'loot_barrel_1')).toHaveLength(1);
    expect(expandido).toContain('crate_elite');
  });

  it('sai ordenada — é o que faz o `watch` não sair de novo à toa', () => {
    const uma = expandContainerSelectors(['@barrel', 'crate_elite']);
    const outra = expandContainerSelectors(['crate_elite', '@barrel']);

    expect(uma).toEqual(outra);
  });

  it('os conjuntos levam só as categorias EM USO', () => {
    expect(Object.keys(containerSetsOf(['@barrel', 'crate_elite']))).toEqual(['@barrel']);
    expect(containerSetsOf(['crate_elite'])).toEqual({});
  });
});

describe('a frase do objetivo', () => {
  it('a categoria sozinha vira o nome dela', () => {
    // "Saquear 20 qualquer barril" nao se le; "20 barris", sim.
    expect(describeContainerSelectors(['@barrel'])).toBe('barris');
    expect(describeContainerSelectors(['@any'])).toBe('contêineres');
  });

  it('até três alvos cabem na linha; do quarto em diante, vira contagem', () => {
    expect(describeContainerSelectors(['loot_barrel_1', 'crate_normal'])).toBe(
      'Barril (pequeno) ou Caixa militar',
    );

    // ####  DEZ NOMES NÃO CABEM NUM BOTÃO  ####
    //
    // E o número — que é o que o jogador procura — sumiria no meio
    // deles. A lista inteira continua no editor, onde ela foi
    // escolhida.
    expect(
      describeContainerSelectors(['loot_barrel_1', 'loot_barrel_2', 'oil_barrel', 'crate_normal']),
    ).toBe('4 tipos de contêiner');
  });

  it('o objetivo inteiro se lê sem "de" — aqui o número conta CAIXA', () => {
    const objective = quest().objectives[0]!;

    expect(h.service.describeObjective(objective)).toBe('Saquear 20 barris');
  });

  it('o catálogo do editor traz família, grupo e nome amigável', () => {
    const catalogo = questContainerCatalog();

    expect(catalogo.categories.map((item) => item.id)).toEqual(['@barrel', '@crate', '@any']);
    expect(catalogo.containers).toContainEqual({
      prefab: 'crate_elite',
      label: 'Caixa de elite',
      group: 'Caixas de risco',
      family: 'crate',
    });
  });
});

// ------------------------------------------------------------
//  O BANCO
// ------------------------------------------------------------

describe('a migração 084', () => {
  it('a coluna `targets` existe e o CHECK aceita "container"', () => {
    const colunas = (
      h.db.prepare(`SELECT name FROM pragma_table_info('quest_objectives')`).all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(colunas).toContain('targets');

    // Recriar a tabela sem os índices os teria perdido em silêncio,
    // e a consulta mais quente do módulo passaria a varrer tudo.
    const indices = (
      h.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quest_objectives'`)
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(indices).toContain('idx_quest_objectives_quest');
    expect(indices).toContain('idx_quest_objectives_watch');
  });

  it('os objetivos de sempre continuam gravando com alvo único', () => {
    h.repository.create(
      'minerador',
      quest({ objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 500 }] }),
      NOW,
    );

    const objective = h.repository.get('minerador')?.objectives[0];

    expect(objective?.target).toBe('sulfur.ore');
    expect(objective?.targets).toBeNull();
  });
});

describe('o que o banco guarda', () => {
  it('a categoria fica CATEGORIA, e não vira a lista do dia', () => {
    h.repository.create('estrada', quest(), NOW);

    // ####  ESTA É A PROMESSA DE VIDA LONGA DO RECURSO  ####
    //
    // Se o cadastro gravasse os cinco prefabs de hoje, um barril
    // novo do Rust — que entra no catálogo do agente numa linha —
    // nunca alcançaria as missões já escritas. E ninguém iria
    // reeditá-las, porque nada avisaria.
    expect(h.repository.get('estrada')?.objectives[0]?.targets).toEqual(['@barrel']);
  });

  it('vários alvos convivem no MESMO objetivo', () => {
    h.repository.create(
      'estrada',
      quest({
        objectives: [
          {
            seq: 0,
            kind: 'container',
            targets: ['loot_barrel_1', 'loot_barrel_2', 'oil_barrel', 'crate_normal_2'],
            amount: 20,
          },
        ],
      }),
      NOW,
    );

    const quests = h.repository.get('estrada');

    // Um contador só, e quatro tipos alimentando ele: é o "total
    // compartilhado" do pedido.
    expect(quests?.objectives).toHaveLength(1);
    expect(quests?.objectives[0]?.amount).toBe(20);
    expect(quests?.objectives[0]?.targets).toHaveLength(4);
  });

  it('o `watch` desce com os prefabs expandidos', () => {
    h.repository.create('estrada', quest(), NOW);

    const watch = h.repository.watchFor('pvp1');
    const containers = watch.filter((entry) => entry.kind === 'container').map((e) => e.target);

    expect(containers).toContain('loot_barrel_1');
    expect(containers).toContain('oil_barrel');
    // A CATEGORIA não desce no catálogo: ela não serve ao corte
    // rápido do plugin, que compara `ShortPrefabName`.
    expect(containers).not.toContain('@barrel');
  });

  it('e os seletores crus saem separados, para os conjuntos', () => {
    h.repository.create('estrada', quest(), NOW);

    expect(h.repository.containerSelectorsFor('pvp1')).toEqual(['@barrel']);
  });

  it('a quest desligada some das duas listas', () => {
    h.repository.create('estrada', quest({ enabled: false }), NOW);

    expect(h.repository.watchFor('pvp1')).toEqual([]);
    expect(h.repository.containerSelectorsFor('pvp1')).toEqual([]);
  });

  it('a quest de OUTRO servidor não obriga este a observar nada', () => {
    h.repository.create('estrada', quest({ servers: ['pvp2'] }), NOW);

    expect(h.repository.watchFor('pvp1')).toEqual([]);
  });
});

// ------------------------------------------------------------
//  O QUE DESCE AO PLUGIN
// ------------------------------------------------------------

describe('o catálogo que desce ao plugin', () => {
  it('leva os conjuntos das categorias, ao lado dos prefabs', async () => {
    h.repository.create('estrada', quest(), NOW);

    await collector().sweep();

    const payload = payloadOf(lastCommand('origemz.quest.watch'));
    const watch = payload.watch as Record<string, string[]>;
    const sets = payload.sets as Record<string, string[]>;

    expect(watch.container).toContain('loot_barrel_1');
    expect(sets['@barrel']).toContain('loot_barrel_1');
    expect(sets['@crate']).toBeUndefined();
  });

  it('um servidor sem missão de saque não paga por nada disto', async () => {
    h.repository.create(
      'minerador',
      quest({ objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 500 }] }),
      NOW,
    );

    await collector().sweep();

    const payload = payloadOf(lastCommand('origemz.quest.watch'));

    expect((payload.watch as Record<string, unknown>).container).toBeUndefined();
    expect(payload.sets).toEqual({});
  });

  it('o `assign` manda o seletor CRU, e não os 65 prefabs', async () => {
    h.repository.create('estrada', quest(), NOW);
    h.service.accept({ serverId: 'pvp1', steamId: FULANO, questId: 'estrada' });

    await collector().sweep();

    const payload = payloadOf(lastCommand('origemz.quest.assign'));
    const quests = payload.quests as { objectives: { targets?: string[]; label: string }[] }[];
    const objective = quests[0]?.objectives[0];

    expect(objective?.targets).toEqual(['@barrel']);
    // E o rótulo é o que uma pessoa lê — o `target` de um saque é
    // vazio, e "Ainda falta: 20 " era o que o balcão diria.
    expect(objective?.label).toBe('barris');
  });
});

// ------------------------------------------------------------
//  O PLUGIN VELHO
// ------------------------------------------------------------

describe('o aviso de plugin desatualizado', () => {
  it('avisa quando o plugin não diz que sabe contar saque', async () => {
    h.repository.create('estrada', quest(), NOW);

    // A resposta de um `OrigemZAgent.cs` anterior a 14/09/2026: sem
    // o campo `kinds`. Nada quebra — e é por isso que o aviso
    // precisa existir.
    h.watchReply = JSON.stringify({ ok: true, contract: 1, targets: 5 });

    await collector().sweep();

    expect(h.warnings.some((line) => line.includes('OrigemZAgent.cs'))).toBe(true);
  });

  it('avisa quando o plugin anuncia OUTROS tipos, mas não este', async () => {
    h.repository.create('estrada', quest(), NOW);
    h.watchReply = JSON.stringify({
      ok: true,
      contract: 1,
      kinds: ['kill', 'gather', 'craft', 'loot'],
    });

    await collector().sweep();

    expect(h.warnings.some((line) => line.includes('não conta saque'))).toBe(true);
  });

  it('cala a boca quando o plugin sabe contar', async () => {
    h.repository.create('estrada', quest(), NOW);

    await collector().sweep();

    expect(h.warnings).toEqual([]);
  });

  it('e cala a boca num servidor sem missão de saque, mesmo com plugin velho', async () => {
    h.repository.create(
      'minerador',
      quest({ objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 500 }] }),
      NOW,
    );

    h.watchReply = JSON.stringify({ ok: true, contract: 1, targets: 1 });

    await collector().sweep();

    expect(h.warnings).toEqual([]);
  });
});

// ------------------------------------------------------------
//  O QUE O ZOD RECUSA
// ------------------------------------------------------------

describe('o zod recusa no cadastro', () => {
  function erroDe(objective: Record<string, unknown>): string {
    const result = questInputSchema.safeParse({
      title: 'x',
      objectives: [objective],
      rewards: [],
    });

    return result.success ? '' : JSON.stringify(result.error.issues);
  }

  it('saque sem contêiner nenhum', () => {
    expect(erroDe({ seq: 0, kind: 'container', amount: 10 })).toContain(
      'precisa de pelo menos um contêiner',
    );
  });

  it('categoria inventada — seria um objetivo que nunca conta', () => {
    expect(erroDe({ seq: 0, kind: 'container', targets: ['@tudo'], amount: 10 })).toContain(
      'não é uma categoria de contêiner conhecida',
    );
  });

  it('prefab com espaço — ele viaja num comando de console', () => {
    expect(erroDe({ seq: 0, kind: 'container', targets: ['dm ammo'], amount: 10 })).toContain(
      'não parece um prefab',
    );
  });

  it('alvo único E lista no mesmo objetivo', () => {
    expect(
      erroDe({
        seq: 0,
        kind: 'container',
        target: 'crate_elite',
        targets: ['@barrel'],
        amount: 10,
      }),
    ).toContain('usa a lista de alvos');
  });

  it('lista pendurada num objetivo que não é de saque', () => {
    expect(
      erroDe({ seq: 0, kind: 'gather', target: 'sulfur.ore', targets: ['@barrel'], amount: 10 }),
    ).toContain('tem lista de alvos');
  });

  it('`consume` no saque — não há item nenhum para tirar da mochila', () => {
    expect(
      erroDe({ seq: 0, kind: 'container', targets: ['@barrel'], amount: 10, consume: true }),
    ).toContain('podem consumir os itens');
  });

  it('e aceita o que é legítimo', () => {
    expect(
      erroDe({ seq: 0, kind: 'container', targets: ['@barrel', 'crate_elite'], amount: 20 }),
    ).toBe('');
  });
});
