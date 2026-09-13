// ============================================================
//  quests-repository.test.ts  -  as promessas das quests que
//  ninguém confere olhando.
//
//  O que este arquivo guarda:
//
//    1. o mesmo LOTE aplicado duas vezes soma UMA vez — sem isso,
//       um `ack` perdido dobra o progresso de todo mundo e nada no
//       log diz por quê;
//    2. o mesmo EVENTO chegando pelo push E pelo lote vira UMA
//       linha. São dois caminhos de propósito, e o `batchId` não
//       desempata: as duas chegadas estão em lotes diferentes;
//    3. o lote NÃO ressuscita tentativa cancelada — ela morreu
//       entre o congelamento no plugin e a chegada aqui, e isso é
//       o caso normal, não defeito;
//    4. editar a quest não muda o que quem já está jogando
//       precisa fazer. É o snapshot, e é a lição que a loja pagou;
//    5. `complete` e `claim` são idempotentes, e a hora não é
//       reescrita pela segunda chegada;
//    6. cancelar e aceitar de novo abre uma tentativa NOVA, com o
//       contador do zero — sem isso a segunda diária começaria
//       feita;
//    7. a quest sem restrição de servidor vale em TODOS. Com
//       `JOIN` em vez de `NOT EXISTS`, ela sumiria de todos;
//    8. o `watch` não manda ao plugin o que ele não tem como
//       contar, e `loot` vazio é o que desliga o hook mais quente
//       do jogo;
//    9. zerar progresso sem recorte é recusado, e o histórico
//       sobrevive ao wipe;
//   10. o zod recusa no cadastro o que viraria um jogador travado
//       depois.
//
//  Banco em memória, migrações reais: é o que permite provar o
//  índice único parcial, a cascata e a FK — justamente as
//  promessas que um mock não teria.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { isApiError } from '../src/http/error-response.js';
import {
  DEFAULT_QUEST_SETTINGS,
  questInputSchema,
  questNpcInputSchema,
  type QuestDraft,
  type QuestInput,
  type QuestNpcDraft,
  type QuestSnapshot,
} from '../src/types/quests.js';

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: QuestsRepository;
}

let harness: Harness;

const NOW = 1_757_000_000_000;
const FULANO = '76561198000000001';
const BELTRANO = '76561198000000002';

/**
 * Uma quest como o painel a manda — já passada pelo zod, porque é
 * assim que ela chega ao repositório em produção. Um objeto
 * montado à mão aqui deixaria os `.default()` de fora e o teste
 * provaria um caminho que não existe.
 */
function quest(overrides: Partial<QuestDraft> = {}): QuestInput {
  return questInputSchema.parse({
    title: 'Minerador',
    description: 'Mine enxofre até doer.',
    category: 'diaria',
    objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 5000 }],
    rewards: [{ kind: 'coins', amount: 500 }],
    ...overrides,
  });
}

/** O que fica congelado no aceite. */
function snapshotOf(input: QuestInput): QuestSnapshot {
  return { title: input.title, objectives: input.objectives, rewards: input.rewards };
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  // As portas são únicas no banco: dois servidores de teste
  // precisam de faixas diferentes, como em produção.
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

  harness = { db, repository: new QuestsRepository(db) };
});

// ------------------------------------------------------------
//  As migrações
// ------------------------------------------------------------

describe('as migrações 046 e 047', () => {
  it('criam as nove tabelas do módulo', () => {
    const names = (
      harness.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND (name LIKE 'quest%' OR name LIKE 'player_quest%')
            ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(names).toEqual([
      'player_quest_progress',
      'player_quests',
      'quest_batches',
      'quest_events',
      'quest_npcs',
      'quest_objectives',
      'quest_rewards',
      'quest_servers',
      'quest_settings',
      'quests',
    ]);
  });

  it('deixa o módulo nascer vazio, e não semeado', () => {
    // O ranking nasce com onze rankings porque um servidor sem
    // ranking nenhum não tem o que mostrar. Quest é o oposto: uma
    // quest de exemplo apareceria no jogo, para jogadores de
    // verdade, no minuto seguinte à subida.
    expect(harness.repository.list()).toEqual([]);
    expect(harness.repository.listNpcs()).toEqual([]);
  });
});

// ------------------------------------------------------------
//  O catálogo
// ------------------------------------------------------------

describe('o catálogo', () => {
  it('grava a quest com objetivos, recompensas e servidores', () => {
    const saved = harness.repository.create(
      'minerador',
      quest({ servers: ['pvp1'], rewards: [{ kind: 'coins', amount: 500 }] }),
      NOW,
    );

    expect(saved.id).toBe('minerador');
    expect(saved.objectives).toHaveLength(1);
    expect(saved.objectives[0]?.target).toBe('sulfur.ore');
    expect(saved.rewards[0]).toEqual({
      kind: 'coins',
      amount: 500,
      perMeter: null,
      min: null,
      max: null,
    });
    expect(saved.servers).toEqual(['pvp1']);
  });

  it('recusa o mesmo id duas vezes', () => {
    harness.repository.create('minerador', quest(), NOW);

    try {
      harness.repository.create('minerador', quest(), NOW);
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('QUEST_ID_TAKEN');
    }
  });

  it('reescreve os filhos inteiros no update, sem deixar órfão', () => {
    harness.repository.create(
      'combo',
      quest({
        objectives: [
          { seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 5000 },
          { seq: 1, kind: 'kill', target: 'scientist', amount: 20 },
        ],
      }),
      NOW,
    );

    const updated = harness.repository.update(
      'combo',
      quest({ objectives: [{ seq: 0, kind: 'kill', target: 'bear', amount: 3 }], rewards: [] }),
      NOW,
    );

    expect(updated?.objectives).toHaveLength(1);
    expect(updated?.objectives[0]?.target).toBe('bear');
    expect(updated?.rewards).toEqual([]);

    // O DELETE + INSERT do `#replaceChildren` não pode deixar
    // linha da versão anterior para trás.
    const orphans = harness.db
      .prepare('SELECT count(*) AS total FROM quest_objectives WHERE quest_id = ?')
      .get('combo') as { total: number };

    expect(orphans.total).toBe(1);
  });

  it('a quest SEM restrição de servidor vale em todos; a com restrição, só na dela', () => {
    harness.repository.create('geral', quest({ servers: [] }), NOW);
    harness.repository.create('so-pvp2', quest({ servers: ['pvp2'] }), NOW);

    // O defeito que este teste existe para pegar: com `JOIN` em
    // vez de `NOT EXISTS`, a quest sem restrição — que é a maioria
    // — sumiria de TODOS os servidores.
    expect(harness.repository.listForServer('pvp1').map((item) => item.id)).toEqual(['geral']);
    expect(harness.repository.listForServer('pvp2').map((item) => item.id)).toEqual([
      'geral',
      'so-pvp2',
    ]);
  });

  it('não manda ao plugin o que ele não tem como contar', () => {
    harness.repository.create(
      'mista',
      quest({
        objectives: [
          { seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 100 },
          { seq: 1, kind: 'playtime', amount: 60 },
          { seq: 2, kind: 'metric', metric: 'shot.distance', amount: 300 },
        ],
      }),
      NOW,
    );

    const watch = harness.repository.watchFor('pvp1');

    // `playtime` e `metric` saem do lote que o ranking já traz. O
    // plugin não tem como contá-los, e mandá-los seria pedir a ele
    // o que ele não sabe.
    expect(watch).toEqual([{ kind: 'gather', target: 'sulfur.ore' }]);

    // E `loot` vazio é o que faz o plugin NÃO REGISTRAR o hook
    // mais quente do jogo. Se algum dia ele vier preenchido sem
    // haver quest de loot, o servidor paga por nada.
    expect(watch.some((entry) => entry.kind === 'loot')).toBe(false);
  });

  it('a quest desligada some do `watch` — o hook não conta o que ninguém persegue', () => {
    harness.repository.create('desligada', quest({ enabled: false }), NOW);

    expect(harness.repository.watchFor('pvp1')).toEqual([]);
  });

  it('reordena o catálogo e ignora id que já não existe', () => {
    harness.repository.create('a', quest({ sort: 0 }), NOW);
    harness.repository.create('b', quest({ sort: 1 }), NOW);

    // O 'c' foi apagado noutra aba depois de a tela carregar.
    // Derrubar a reordenação por causa dele custaria ao usuário o
    // arrasto que ele acabou de fazer.
    const changed = harness.repository.reorder(['b', 'c', 'a'], NOW);

    expect(changed).toBe(2);
    expect(harness.repository.list().map((item) => item.id)).toEqual(['b', 'a']);
  });
});

// ------------------------------------------------------------
//  A tentativa
// ------------------------------------------------------------

describe('a tentativa', () => {
  beforeEach(() => {
    harness.repository.create('minerador', quest(), NOW);
  });

  function accept(steamId = FULANO, questId = 'minerador'): number {
    return harness.repository.accept(
      {
        serverId: 'pvp1',
        steamId,
        playerName: 'Fulano',
        questId,
        snapshot: snapshotOf(quest()),
      },
      NOW,
    ).id;
  }

  it('nasce com o contador em zero, e não vazio', () => {
    const id = accept();
    const attempt = harness.repository.attempt(id);

    // A tela do jogo mostra "0 / 5.000" desde o primeiro segundo.
    // Sem a linha, ela teria de saber que ausência é zero — e a
    // barra de progresso não teria de onde nascer.
    expect(attempt?.progress).toEqual({ 0: 0 });
    expect(attempt?.attempt).toBe(1);
    expect(attempt?.status).toBe('active');
  });

  it('cria o jogador que ainda não existe, em vez de derrubar', () => {
    // A FK de `player_quests` para `players` cobra isso, e pagá-la
    // errado derrubaria o aceite de um recém-chegado — que é
    // exatamente quem mais aceita quest.
    expect(() => accept('76561198000000099')).not.toThrow();
  });

  it('recusa duas tentativas vivas da mesma quest', () => {
    accept();

    try {
      accept();
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      // Dois contadores paralelos da mesma coisa, e o `assign`
      // mandando os dois ao plugin.
      expect(isApiError(error) && error.code).toBe('QUEST_ALREADY_ACTIVE');
    }
  });

  it('cancelar e aceitar de novo abre a tentativa 2, do zero', () => {
    const first = accept();

    harness.repository.applyBatch(
      { serverId: 'pvp1', batchId: 'b1', entries: [{ playerQuestId: first, objectiveSeq: 0, delta: 4000 }] },
      NOW,
    );

    expect(harness.repository.attempt(first)?.progress[0]).toBe(4000);

    harness.repository.abandon(first);

    const second = accept();
    const attempt = harness.repository.attempt(second);

    expect(attempt?.attempt).toBe(2);
    // Sem a chave por TENTATIVA em `player_quest_progress`, a
    // segunda diária começaria com o contador da primeira — e
    // concluiria sozinha.
    expect(attempt?.progress).toEqual({ 0: 0 });

    // E o histórico da primeira fica: é ele que responde "quantas
    // vezes o Fulano fez a diária?".
    expect(harness.repository.historyOf(FULANO)).toHaveLength(2);
  });

  it('o snapshot NÃO muda quando a quest é editada no meio', () => {
    const id = accept();

    harness.repository.update(
      'minerador',
      quest({ objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 999_999 }] }),
      NOW + 1000,
    );

    // Quem já estava jogando continua precisando de 5.000. É a
    // lição que a loja pagou com o `DeliveryPlan` — e aqui é pior,
    // porque uma diária aceita às 8h é resgatada às 23h.
    expect(harness.repository.attempt(id)?.snapshot.objectives[0]?.amount).toBe(5000);
    expect(harness.repository.get('minerador')?.objectives[0]?.amount).toBe(999_999);
  });

  it('`complete` é idempotente e não reescreve a hora', () => {
    const id = accept();

    expect(harness.repository.complete(id, NOW + 100)).toBe(true);
    // O push e o lote trazem o mesmo fato de propósito. `false`
    // aqui é o caso NORMAL, não um erro.
    expect(harness.repository.complete(id, NOW + 9999)).toBe(false);
    expect(harness.repository.attempt(id)?.completedAt).toBe(NOW + 100);
  });

  it('`claim` só sai de `completed`', () => {
    const id = accept();

    // Resgatar sem ter concluído entregaria a recompensa a quem
    // não fez nada.
    expect(harness.repository.claim(id, null, NOW)).toBe(false);

    harness.repository.complete(id, NOW);

    expect(harness.repository.claim(id, NOW + 86_400_000, NOW + 10)).toBe(true);
    expect(harness.repository.claim(id, null, NOW + 20)).toBe(false);

    const attempt = harness.repository.attempt(id);

    expect(attempt?.status).toBe('claimed');
    expect(attempt?.cooldownUntil).toBe(NOW + 86_400_000);
  });

  it('conta as tentativas vivas para o teto, e ignora as terminadas', () => {
    harness.repository.create('segunda', quest({ title: 'Segunda' }), NOW);

    const first = accept();

    accept(FULANO, 'segunda');

    expect(harness.repository.liveCountFor('pvp1', FULANO)).toBe(2);

    harness.repository.abandon(first);

    expect(harness.repository.liveCountFor('pvp1', FULANO)).toBe(1);
    // O teto é por servidor: o mesmo jogador noutro mundo começa
    // do zero.
    expect(harness.repository.liveCountFor('pvp2', FULANO)).toBe(0);
  });

  it('apagar a quest leva as tentativas junto — e o `liveCountOf` avisa antes', () => {
    accept();
    accept(BELTRANO);

    expect(harness.repository.liveCountOf('minerador')).toBe(2);

    harness.repository.remove('minerador');

    expect(harness.repository.historyOf(FULANO)).toEqual([]);
  });
});

// ------------------------------------------------------------
//  O lote
// ------------------------------------------------------------

describe('o lote de progresso', () => {
  let playerQuestId: number;

  beforeEach(() => {
    harness.repository.create('minerador', quest(), NOW);

    playerQuestId = harness.repository.accept(
      {
        serverId: 'pvp1',
        steamId: FULANO,
        playerName: 'Fulano',
        questId: 'minerador',
        snapshot: snapshotOf(quest()),
      },
      NOW,
    ).id;
  });

  function batch(batchId: string, delta: number): void {
    harness.repository.applyBatch(
      { serverId: 'pvp1', batchId, entries: [{ playerQuestId, objectiveSeq: 0, delta }] },
      NOW,
    );
  }

  it('o mesmo lote aplicado duas vezes soma UMA vez', () => {
    batch('pvp1-1757088123-41', 1200);
    batch('pvp1-1757088123-41', 1200);

    // O `ack` pode se perder DEPOIS do commit, e então o mesmo
    // lote volta na rodada seguinte. Sem o `quest_batches`, ele
    // dobraria o progresso de todo mundo.
    expect(harness.repository.attempt(playerQuestId)?.progress[0]).toBe(1200);
  });

  it('diz que não aplicou, para quem chamou poder confirmar de novo', () => {
    const first = harness.repository.applyBatch(
      { serverId: 'pvp1', batchId: 'b1', entries: [{ playerQuestId, objectiveSeq: 0, delta: 10 }] },
      NOW,
    );
    const second = harness.repository.applyBatch(
      { serverId: 'pvp1', batchId: 'b1', entries: [{ playerQuestId, objectiveSeq: 0, delta: 10 }] },
      NOW,
    );

    expect(first).toEqual({ applied: true, entriesApplied: 1, playersTouched: 1 });
    // Uma confirmação repetida é barata; um lote em dobro não.
    expect(second.applied).toBe(false);
  });

  it('soma deltas, e não substitui', () => {
    batch('b1', 1000);
    batch('b2', 500);

    // Um lote com totais reescreveria o progresso a cada minuto — e
    // um lote reenviado apagaria o que veio depois dele.
    expect(harness.repository.attempt(playerQuestId)?.progress[0]).toBe(1500);
  });

  it('ignora delta zero e negativo', () => {
    batch('b1', 0);
    batch('b2', -50);

    expect(harness.repository.attempt(playerQuestId)?.progress[0]).toBe(0);
  });

  it('não ressuscita tentativa que morreu entre o congelamento e a chegada', () => {
    harness.repository.abandon(playerQuestId);

    const result = harness.repository.applyBatch(
      { serverId: 'pvp1', batchId: 'b1', entries: [{ playerQuestId, objectiveSeq: 0, delta: 900 }] },
      NOW,
    );

    // O jogador cancelou a quest depois de o plugin fechar o lote.
    // É o caso NORMAL deste desenho, não defeito — e somar nela
    // faria reaparecer um contador que ninguém vai ver.
    expect(result.entriesApplied).toBe(0);
    expect(harness.repository.attempt(playerQuestId)?.progress).toEqual({});
  });

  it('não conta para tentativa já `completed` — o lote atrasado não passa do alvo', () => {
    batch('b1', 5000);
    harness.repository.complete(playerQuestId, NOW);
    batch('b2', 800);

    expect(harness.repository.attempt(playerQuestId)?.progress[0]).toBe(5000);
  });

  it('o mesmo lote em servidores diferentes é aplicado nos dois', () => {
    const other = harness.repository.accept(
      {
        serverId: 'pvp2',
        steamId: FULANO,
        questId: 'minerador',
        snapshot: snapshotOf(quest()),
      },
      NOW,
    ).id;

    // O `batchId` é gerado pelo plugin de CADA servidor, e a chave
    // é (server_id, batch_id): uma colisão entre dois servidores
    // não pode perder o lote de um deles.
    harness.repository.applyBatch(
      { serverId: 'pvp1', batchId: 'mesmo-id', entries: [{ playerQuestId, objectiveSeq: 0, delta: 10 }] },
      NOW,
    );
    harness.repository.applyBatch(
      { serverId: 'pvp2', batchId: 'mesmo-id', entries: [{ playerQuestId: other, objectiveSeq: 0, delta: 20 }] },
      NOW,
    );

    expect(harness.repository.attempt(playerQuestId)?.progress[0]).toBe(10);
    expect(harness.repository.attempt(other)?.progress[0]).toBe(20);
  });
});

// ------------------------------------------------------------
//  A auditoria
// ------------------------------------------------------------

describe('a auditoria', () => {
  beforeEach(() => {
    harness.repository.create('minerador', quest(), NOW);
    harness.repository.accept(
      {
        serverId: 'pvp1',
        steamId: FULANO,
        questId: 'minerador',
        snapshot: snapshotOf(quest()),
      },
      NOW,
    );
  });

  it('registra o aceite sozinha', () => {
    const events = harness.repository.events({ steamId: FULANO });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('accept');
    expect(events[0]?.source).toBe('agent');
  });

  it('o mesmo `eventId` chegando pelo push e pelo lote vira UMA linha', () => {
    const event = {
      eventId: 'pvp1-42-complete',
      serverId: 'pvp1',
      steamId: FULANO,
      questId: 'minerador',
      attempt: 1,
      kind: 'complete',
      source: 'plugin',
    } as const;

    expect(harness.repository.recordEvent(event, NOW)).toBe(true);
    // "Já vi este" é o caso NORMAL deste desenho — nunca uma linha
    // de log de alarme.
    expect(harness.repository.recordEvent(event, NOW + 500)).toBe(false);

    expect(harness.repository.events({ kind: 'complete' })).toHaveLength(1);
  });

  it('guarda o detalhe como objeto, e uma linha ilegível não derruba a leitura', () => {
    harness.repository.recordEvent(
      {
        serverId: 'pvp1',
        steamId: FULANO,
        questId: 'minerador',
        attempt: 1,
        kind: 'reward_failed',
        detail: { code: 'INVENTORY_FULL' },
        source: 'agent',
      },
      NOW,
    );

    // JSON quebrado à mão: a coluna é escrita por nós, então um
    // valor ilegível ali é defeito nosso — e esconder as outras
    // linhas por causa dele seria pior.
    harness.db
      .prepare(
        `INSERT INTO quest_events
           (server_id, steam_id, quest_id, attempt, kind, detail, source, at)
         VALUES ('pvp1', ?, 'minerador', 1, 'progress', '{quebrado', 'plugin', ?)`,
      )
      .run(FULANO, NOW);

    const events = harness.repository.events({ steamId: FULANO });

    expect(events.find((item) => item.kind === 'reward_failed')?.detail).toEqual({
      code: 'INVENTORY_FULL',
    });
    expect(events.find((item) => item.kind === 'progress')?.detail).toBeNull();
  });
});

// ------------------------------------------------------------
//  O wipe
// ------------------------------------------------------------

describe('o wipe do progresso', () => {
  beforeEach(() => {
    harness.repository.create('zera', quest({ wipePolicy: 'reset' }), NOW);
    harness.repository.create('fica', quest({ title: 'Fica', wipePolicy: 'keep' }), NOW);

    for (const questId of ['zera', 'fica']) {
      harness.repository.accept(
        { serverId: 'pvp1', steamId: FULANO, questId, snapshot: snapshotOf(quest()) },
        NOW,
      );
      harness.repository.accept(
        { serverId: 'pvp2', steamId: FULANO, questId, snapshot: snapshotOf(quest()) },
        NOW,
      );
    }
  });

  it('recusa zerar sem recorte nenhum', () => {
    try {
      harness.repository.wipeProgress({ actor: 'dono', reason: 'oops' }, NOW);
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      // Zerar todos os jogadores de todos os servidores por um
      // corpo vazio é o tipo de acidente que não se desfaz.
      expect(isApiError(error) && error.code).toBe('QUEST_WIPE_TOO_BROAD');
    }
  });

  it('o wipe do mundo respeita o `wipe_policy` de cada quest', () => {
    const wiped = harness.repository.wipeProgress(
      { serverId: 'pvp1', actor: 'wipe', reason: 'wipe de 06/09', respectPolicy: true },
      NOW,
    );

    expect(wiped).toBe(1);

    const live = harness.repository.liveFor('pvp1', FULANO);

    expect(live.map((item) => item.questId)).toEqual(['fica']);
    // O outro mundo não é tocado: o progresso é POR SERVIDOR.
    expect(harness.repository.liveFor('pvp2', FULANO)).toHaveLength(2);
  });

  it('o botão do painel zera o que foi pedido, `keep` ou não', () => {
    // Quem clicou ali disse exatamente o que queria.
    const wiped = harness.repository.wipeProgress(
      { serverId: 'pvp1', questId: 'fica', actor: 'dono', reason: 'a pedido' },
      NOW,
    );

    expect(wiped).toBe(1);
    expect(harness.repository.liveFor('pvp1', FULANO).map((item) => item.questId)).toEqual(['zera']);
  });

  it('o histórico sobrevive, e o motivo fica gravado', () => {
    harness.repository.wipeProgress(
      { steamId: FULANO, actor: 'dono', reason: 'pediu no Discord' },
      NOW,
    );

    // Apagar a auditoria reescreveria o passado — e o ranking
    // "quests concluídas" atravessa o wipe.
    const resets = harness.repository.events({ steamId: FULANO, kind: 'reset' });

    expect(resets).toHaveLength(4);
    expect(resets[0]?.actor).toBe('dono');
    expect(resets[0]?.detail).toEqual({ reason: 'pediu no Discord' });

    expect(harness.repository.historyOf(FULANO)).toHaveLength(4);
    expect(harness.repository.liveFor('pvp1', FULANO)).toEqual([]);
  });
});

// ------------------------------------------------------------
//  A configuração
// ------------------------------------------------------------

describe('a configuração por servidor', () => {
  it('sem linha, valem os padrões do contrato', () => {
    // Um servidor criado depois da migração 046 fica sem linha, e
    // o código precisaria saber o padrão de qualquer jeito. Duas
    // fontes para a mesma resposta é o que o 02-ARQUITETURA proíbe.
    expect(harness.repository.settingsOf('pvp1')).toEqual(DEFAULT_QUEST_SETTINGS);
  });

  it('grava e relê, e a segunda gravação substitui a primeira', () => {
    harness.repository.saveSettings(
      'pvp1',
      { maxActive: 5, enabled: true, flushSeconds: 60, lootEnabled: true, resetAtMinute: 0 },
      NOW,
    );
    const saved = harness.repository.saveSettings(
      'pvp1',
      { maxActive: 3, enabled: true, flushSeconds: 120, lootEnabled: false, resetAtMinute: 180 },
      NOW + 10,
    );

    expect(saved.maxActive).toBe(3);
    expect(saved.lootEnabled).toBe(false);
    expect(saved.updatedAt).toBe(NOW + 10);
    // E o outro servidor continua no padrão.
    expect(harness.repository.settingsOf('pvp2')).toEqual(DEFAULT_QUEST_SETTINGS);
  });
});

// ------------------------------------------------------------
//  O NPC
// ------------------------------------------------------------

describe('o NPC', () => {
  function npc(overrides: Partial<QuestNpcDraft> = {}) {
    return questNpcInputSchema.parse({
      serverId: 'pvp1',
      name: 'Velho do Outpost',
      x: 120.5,
      y: 10,
      z: -430.25,
      ...overrides,
    });
  }

  it('nasce com o boneco que FALA e o marcador ligado', () => {
    const saved = harness.repository.createNpc('velho-do-outpost', npc(), NOW);

    // O prefab importa por um motivo só: o prompt "TALK" do jogo é
    // do `NPCTalking`. Com o `bandit_shopkeeper` de antes, o
    // jogador chegava perto e não via nada. Ver a migração 077.
    expect(saved.prefab).toContain('bandit_conversationalist');
    expect(saved.mapMarker).toBe(true);
    expect(saved.useRadius).toBe(3);
  });

  it('só o ligado é spawnado, e o desligado guarda a posição', () => {
    harness.repository.createNpc('ligado', npc(), NOW);
    harness.repository.createNpc('desligado', npc({ enabled: false }), NOW);

    expect(harness.repository.listNpcsToSpawn('pvp1').map((item) => item.id)).toEqual(['ligado']);
    // Apagar para desligar perderia a coordenada, que é a parte
    // cara de recuperar: ela só se consegue indo até lá no jogo.
    expect(harness.repository.getNpc('desligado')?.x).toBe(120.5);
  });

  it('apagar o NPC não apaga a quest dele', () => {
    harness.repository.createNpc('velho', npc(), NOW);
    harness.repository.create('entrega', quest({ npcId: 'velho' }), NOW);

    expect(harness.repository.questsOfNpc('velho')).toEqual(['entrega']);

    harness.repository.removeNpc('velho');

    // A quest volta a ser uma quest de menu, com o progresso de
    // quem estava fazendo intacto. Quem avisa o admin é a rota.
    expect(harness.repository.get('entrega')).not.toBeNull();
  });

  it('o wipe leva só os marcados como `remove`', () => {
    harness.repository.createNpc('monumento', npc({ wipePolicy: 'keep' }), NOW);
    harness.repository.createNpc('do-mapa', npc({ wipePolicy: 'remove' }), NOW);
    harness.repository.createNpc('do-outro', npc({ serverId: 'pvp2', wipePolicy: 'remove' }), NOW);

    expect(harness.repository.wipeNpcs('pvp1')).toBe(1);
    expect(harness.repository.listNpcs('pvp1').map((item) => item.id)).toEqual(['monumento']);
    expect(harness.repository.listNpcs('pvp2')).toHaveLength(1);
  });

  it('some junto com o servidor', () => {
    harness.repository.createNpc('velho', npc(), NOW);

    // A posição é de UM mundo: um X/Z do mapa de hoje não
    // significa nada em servidor nenhum depois que ele deixa de
    // existir.
    harness.db.prepare('DELETE FROM servers WHERE id = ?').run('pvp1');

    expect(harness.repository.listNpcs()).toEqual([]);
  });
});

// ------------------------------------------------------------
//  A régua
// ------------------------------------------------------------

describe('o zod recusa no cadastro o que travaria o jogador depois', () => {
  it('objetivo `metric` sem métrica', () => {
    expect(() => quest({ objectives: [{ seq: 0, kind: 'metric', amount: 10 }] })).toThrow();
  });

  it('objetivo `metric` com alvo — duas colunas dizendo de onde o número vem', () => {
    expect(() =>
      quest({ objectives: [{ seq: 0, kind: 'metric', metric: 'pvp.kills', target: 'bear', amount: 10 }] }),
    ).toThrow();
  });

  it('`consume` num objetivo de matar', () => {
    // Não teria o que retirar do inventário, e o resgate falharia
    // com uma frase sem sentido para quem jogou.
    expect(() =>
      quest({ objectives: [{ seq: 0, kind: 'kill', target: 'bear', amount: 3, consume: true }] }),
    ).toThrow();
  });

  it('objetivo de quantidade zero', () => {
    // A quest inteira viraria um botão de recompensa grátis.
    expect(() => quest({ objectives: [{ seq: 0, kind: 'kill', target: 'bear', amount: 0 }] })).toThrow();
  });

  it('dois objetivos com a mesma ordem', () => {
    expect(() =>
      quest({
        objectives: [
          { seq: 0, kind: 'kill', target: 'bear', amount: 1 },
          { seq: 0, kind: 'kill', target: 'wolf', amount: 1 },
        ],
      }),
    ).toThrow();
  });

  it('quest sem objetivo nenhum', () => {
    expect(() => quest({ objectives: [] })).toThrow();
  });

  it('entrega sem NPC de origem', () => {
    // O destino é o alvo do objetivo; a origem é o `npcId`. Sem
    // origem, a quest apareceria no menu sem que ninguém pudesse
    // concluí-la.
    expect(() =>
      quest({ objectives: [{ seq: 0, kind: 'deliver', target: 'bandit-town', amount: 1 }] }),
    ).toThrow();

    expect(() =>
      quest({
        npcId: 'outpost',
        objectives: [{ seq: 0, kind: 'deliver', target: 'bandit-town', amount: 1 }],
      }),
    ).not.toThrow();
  });

  it('modo `cooldown` sem tempo', () => {
    expect(() => quest({ repeatMode: 'cooldown', cooldownSeconds: 0 })).toThrow();
  });

  it('janela de evento que termina antes de começar', () => {
    expect(() => quest({ availableFrom: NOW + 1000, availableTo: NOW })).toThrow();
  });

  it('moeda com valor fixo E por metro — duas recompensas disfarçadas de uma', () => {
    expect(() => quest({ rewards: [{ kind: 'coins', amount: 100, perMeter: 0.5 }] })).toThrow();
    expect(() => quest({ rewards: [{ kind: 'coins' }] })).toThrow();
    expect(() => quest({ rewards: [{ kind: 'coins', perMeter: 0.5, min: 100, max: 50 }] })).toThrow();
  });
});

// ------------------------------------------------------------
//  O CONTRATO QUE O WIPE DO MUNDO USA
// ------------------------------------------------------------

describe('o que o wipe do mundo chama', () => {
  it('as duas chamadas existem com a forma que o `WipeRunner` espera', () => {
    // ####  ESTE TESTE EXISTE POR UM MOTIVO ESPECÍFICO  ####
    //
    // O `wipe/run.ts` declara uma interface MÍNIMA (`WipeQuests`) e
    // o `index.ts` a satisfaz com estes dois métodos. O TypeScript
    // garante a forma; o que ele NÃO garante é que eles continuem
    // fazendo o que o wipe precisa.
    //
    // A coluna `wipe_policy` das duas tabelas só existe por causa
    // desta ligação — e ela ficou quatro frentes sem ninguém
    // chamando.
    harness.repository.create('zera', quest({ wipePolicy: 'reset' }), NOW);
    harness.repository.create('fica', quest({ title: 'Fica', wipePolicy: 'keep' }), NOW);

    for (const questId of ['zera', 'fica']) {
      harness.repository.accept(
        { serverId: 'pvp1', steamId: FULANO, questId, snapshot: snapshotOf(quest()) },
        NOW,
      );
    }

    harness.repository.createNpc(
      'some',
      {
        serverId: 'pvp1',
        name: 'Some',
        kind: 'quest',
        x: 1,
        y: 1,
        z: 1,
        rotation: 0,
        prefab: 'p',
        mapMarker: false,
        useRadius: 3,
        enabled: true,
        wipePolicy: 'remove',
      },
      NOW,
    );

    const zeradas = harness.repository.wipeProgress(
      { serverId: 'pvp1', actor: 'wipe', reason: 'wipe do servidor', respectPolicy: true },
      NOW,
    );
    const npcs = harness.repository.wipeNpcs('pvp1');

    expect(zeradas).toBe(1);
    expect(npcs).toBe(1);

    // A que atravessa o wipe continua viva, com o progresso dela.
    expect(harness.repository.liveFor('pvp1', FULANO).map((item) => item.questId)).toEqual([
      'fica',
    ]);
  });
});
