// ============================================================
//  rankings-repository.test.ts  -  as promessas do ranking que
//  ninguém confere olhando.
//
//  O que este arquivo guarda:
//
//    1. o mesmo LOTE aplicado duas vezes soma UMA vez — sem isso,
//       um `ack` perdido dobra o contador de todo mundo e nada no
//       log diz por quê;
//    2. o mesmo EVENTO chegando pelo push E pelo lote soma UMA
//       vez. São dois caminhos de propósito, e o `batchId` não
//       desempata: as duas chegadas estão em lotes diferentes;
//    3. um lote com jogador NOVO não derruba a transação. A FK
//       para `players` cobra isso, e pagá-la errado perde o lote
//       de TODO MUNDO por causa de um recém-chegado;
//    4. o empate produz a MESMA ordem entre a página 1 e a 2 — o
//       defeito clássico de paginação sem ordem total, em que um
//       jogador some da lista;
//    5. fechar o período congela o pódio, abre o seguinte, e o
//       índice único parcial impede dois abertos;
//    6. apagar um ranking `builtin` é recusado;
//    7. `window` decide qual virada zera a disputa de cada
//       ranking — o pedido do dono de 05/09/2026.
//
//  Banco em memória, migrações reais: é o que permite provar o
//  índice único parcial e a FK, que são justamente as promessas
//  que o mock não teria.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  RankingsRepository,
  type RankingInput,
  type StatBatchInput,
} from '../src/db/rankings-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { isApiError } from '../src/http/error-response.js';
import { gameLabelOf } from '../src/rankings/service.js';

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: RankingsRepository;
}

let harness: Harness;

const NOW = 1_757_000_000_000;

/** Um lote como o plugin manda, com o que cada teste precisa. */
function batch(overrides: Partial<StatBatchInput> = {}): StatBatchInput {
  return {
    serverId: 'pvp1',
    batchId: 'pvp1-1757088123-41',
    seq: 41,
    players: [
      { steamId: '76561198000000001', name: 'Fulano', metrics: { 'pvp.kills': 3 } },
      { steamId: '76561198000000002', name: 'Beltrano', metrics: { 'pvp.kills': 5 } },
    ],
    ...overrides,
  };
}

function trophyRanking(overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    id: 'trofeu-bleik',
    metric: 'trophy.bleik',
    label: 'Troféu Bleik',
    unit: 'troféus',
    description: 'Pegue o troféu e ele vira ponto.',
    source: 'item',
    valueKind: 'counter',
    direction: 'desc',
    window: 'season',
    globalEligible: true,
    enabled: true,
    sortOrder: 100,
    ...overrides,
  };
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

  harness = { db, repository: new RankingsRepository(db) };
});

// ------------------------------------------------------------
//  O catálogo semeado
// ------------------------------------------------------------

describe('o catálogo que nasce semeado', () => {
  it('traz os onze rankings fixos, com a janela de cada um', () => {
    const list = harness.repository.list();

    expect(list).toHaveLength(11);
    expect(list.every((item) => item.builtin)).toBe(true);

    // O critério do §4: farm zera com o mundo, PvP atravessa o
    // wipe, tempo online é de sempre.
    expect(harness.repository.getByMetric('pvp.kills')?.window).toBe('season');
    expect(harness.repository.getByMetric('ore.sulfur')?.window).toBe('wipe');
    expect(harness.repository.getByMetric('shot.distance')?.window).toBe('wipe');
    expect(harness.repository.getByMetric('time.played')?.window).toBe('lifetime');

    // Minério e explosivo não somam na rede: um servidor 5x
    // ordenaria a lista por em que servidor a pessoa jogou.
    expect(harness.repository.getByMetric('ore.total')?.globalEligible).toBe(false);
    expect(harness.repository.getByMetric('pvp.kills')?.globalEligible).toBe(true);
  });

  it('recusa apagar um `builtin`, e apaga o que o admin criou', () => {
    expect(() => harness.repository.remove('abates')).toThrowError(/não pode ser apagado/);

    try {
      harness.repository.remove('abates');
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('RANKING_BUILTIN_LOCKED');
    }

    // O dinâmico é a MESMA linha, e sai sem discussão.
    harness.repository.create(trophyRanking(), NOW);
    expect(harness.repository.remove('trofeu-bleik')).toBe(true);
    expect(harness.repository.get('trofeu-bleik')).toBeNull();
  });

  it('recusa dois rankings sobre a mesma métrica', () => {
    harness.repository.create(trophyRanking(), NOW);

    try {
      harness.repository.create(trophyRanking({ id: 'outro', metric: 'trophy.bleik' }), NOW);
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('RANKING_METRIC_TAKEN');
    }
  });

  it('não deixa um `builtin` trocar de métrica, porque o número ficaria órfão', () => {
    const abates = harness.repository.get('abates');

    expect(abates).not.toBeNull();

    try {
      harness.repository.update(
        'abates',
        { ...abates!, metric: 'pvp.outra' },
        NOW,
      );
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('RANKING_BUILTIN_LOCKED');
    }

    // Mudar o rótulo e a janela continua sendo uso normal.
    const renamed = harness.repository.update('abates', { ...abates!, label: 'Kills', window: 'wipe' }, NOW);

    expect(renamed?.label).toBe('Kills');
    expect(renamed?.window).toBe('wipe');
    expect(renamed?.metric).toBe('pvp.kills');
  });
});

// ------------------------------------------------------------
//  O nome curto, o menu do jogo e a ordem
// ------------------------------------------------------------

describe('o nome que a aba do jogo mostra', () => {
  it('nome curto em branco cai no `label` — e não vira aba vazia', () => {
    // ####  `''` E `NULL` SÃO A MESMA INTENÇÃO  ####
    //
    // O painel manda string vazia quando o campo é apagado. Se ela
    // fosse guardada como está, a aba do jogo ficaria sem texto
    // nenhum e a consulta que testa `IS NULL` acertaria metade das
    // linhas.
    const salvo = harness.repository.create(
      trophyRanking({ shortLabel: '   ' }),
      NOW,
    );

    expect(salvo.shortLabel).toBeNull();
    expect(gameLabelOf(salvo)).toBe('Troféu Bleik');

    const curto = harness.repository.update(
      'trofeu-bleik',
      trophyRanking({ shortLabel: '  Bleik  ' }),
      NOW,
    );

    // E o que tem nome curto usa o curto na aba, com o inteiro
    // intacto para o painel e o site.
    expect(curto?.shortLabel).toBe('Bleik');
    expect(curto?.label).toBe('Troféu Bleik');
    expect(gameLabelOf(curto!)).toBe('Bleik');
  });

  it('escondido do menu do jogo, o ranking CONTINUA no catálogo do painel', () => {
    // Não é o mesmo que desligar: o número segue sendo contado, e
    // o painel e o site continuam mostrando. O que muda é uma aba
    // a menos numa tela onde cabem poucas.
    harness.repository.create(trophyRanking({ showInGame: false }), NOW);

    const doJogo = harness.repository.list({ enabledOnly: true, inGameOnly: true });
    const doPainel = harness.repository.list();

    expect(doJogo.some((item) => item.id === 'trofeu-bleik')).toBe(false);
    expect(doPainel.some((item) => item.id === 'trofeu-bleik')).toBe(true);
    expect(harness.repository.get('trofeu-bleik')?.showInGame).toBe(false);

    // Os semeados continuam no menu: o padrão da coluna é 1.
    expect(doJogo.every((item) => item.showInGame)).toBe(true);
    expect(doJogo).toHaveLength(doPainel.length - 1);
  });

  it('um ranking novo nasce aparecendo no jogo', () => {
    expect(harness.repository.create(trophyRanking(), NOW).showInGame).toBe(true);
  });
});

describe('a ordem do catálogo', () => {
  /** Os ids do catálogo, na ordem em que a tela os desenharia. */
  const ordem = (): readonly string[] => harness.repository.list().map((item) => item.id);

  it('a lista inteira reescreve `sort_order` de 10 em 10', () => {
    const invertida = [...ordem()].reverse();

    const salvos = harness.repository.reorder(invertida, NOW);

    expect(salvos.map((item) => item.id)).toEqual(invertida);
    expect(ordem()).toEqual(invertida);
    expect(salvos.map((item) => item.sortOrder)).toEqual(
      invertida.map((_id, index) => (index + 1) * 10),
    );
  });

  it('uma lista PARCIAL é recusada: os ausentes ficariam com ordem indefinida', () => {
    const antes = ordem();

    try {
      harness.repository.reorder(antes.slice(0, 3), NOW);
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('RANKING_ORDER_MISMATCH');
    }

    // E nada foi movido: a transação não deixa meia ordem gravada.
    expect(ordem()).toEqual(antes);
  });

  it('um id que não existe é recusado, e o mesmo id duas vezes também', () => {
    const antes = ordem();

    for (const lista of [
      [...antes, 'nao-existe'],
      [antes[0]!, ...antes],
    ]) {
      try {
        harness.repository.reorder(lista, NOW);
        expect.unreachable('deveria ter recusado');
      } catch (error) {
        expect(isApiError(error) && error.code).toBe('RANKING_ORDER_MISMATCH');
      }
    }

    expect(ordem()).toEqual(antes);
  });

  it('quem não mudou de lugar não é carimbado de novo', () => {
    // `updated_at` responde "quando ESTA definição mudou". Mover o
    // vizinho não é uma mudança nesta — e uma tela de arrastar
    // reescreveria o carimbo de onze rankings a cada solta.
    const antes = ordem();
    const primeiro = harness.repository.get(antes[0]!);

    // A ordem que já é a ordem: nada tem por que mudar.
    harness.repository.reorder(antes, NOW + 5_000);

    expect(harness.repository.get(antes[0]!)?.updatedAt).toBe(primeiro?.updatedAt);
  });

  it('um ranking sem ordem declarada entra no FIM, e não no meio', () => {
    // Um ranking novo que caísse entre dois já existentes mudaria
    // a coluna do menu do jogo de quem não pediu nada.
    const criado = harness.repository.create(trophyRanking(), NOW);

    expect(ordem().at(-1)).toBe('trofeu-bleik');
    expect(criado.sortOrder).toBeGreaterThan(
      Math.max(...harness.repository.list().map((item) => item.sortOrder).filter((v) => v !== criado.sortOrder)),
    );
  });

  it('editar um ranking NÃO mexe na ordem — ela é do arrasto', () => {
    // O cenário real: a tela carrega, alguém arrasta, e só então
    // clica em "desligar" num formulário que ainda tem a ordem
    // antiga. Sem esta garantia, o clique desfaria o arrasto sem
    // ninguém ter tocado em ordem nenhuma.
    harness.repository.create(trophyRanking(), NOW);

    const invertida = [...ordem()].reverse();
    harness.repository.reorder(invertida, NOW + 1_000);

    const depoisDoArrasto = harness.repository.get('trofeu-bleik')!;
    // `sortOrder` sai de propósito: é o formulário do painel, que
    // não manda a ordem — é justamente isso que este teste prova.
    const {
      id,
      sortOrder,
      builtin: _builtin,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...campos
    } = depoisDoArrasto;

    harness.repository.update('trofeu-bleik', { ...campos, id, enabled: false }, NOW + 2_000);

    expect(harness.repository.get('trofeu-bleik')?.sortOrder).toBe(sortOrder);
    expect(ordem()).toEqual(invertida);
  });
});

// ------------------------------------------------------------
//  As duas idempotências
// ------------------------------------------------------------

describe('a idempotência do lote', () => {
  it('o mesmo `batchId` aplicado duas vezes soma UMA vez', () => {
    const first = harness.repository.applyBatch(batch(), NOW);

    expect(first.applied).toBe(true);
    expect(first.periodIds).toHaveLength(3);

    const again = harness.repository.applyBatch(batch(), NOW + 1_000);

    expect(again.applied).toBe(false);

    const period = harness.repository.openPeriodOf('pvp1', 'season');
    const top = harness.repository.topOf({
      periodId: period!.id,
      metric: 'pvp.kills',
      limit: 10,
      offset: 0,
    });

    expect(top.entries.map((entry) => entry.value)).toEqual([5, 3]);
  });

  it('um lote NOVO continua somando por cima do anterior', () => {
    harness.repository.applyBatch(batch(), NOW);
    harness.repository.applyBatch(batch({ batchId: 'pvp1-1757088183-42', seq: 42 }), NOW + 60_000);

    const period = harness.repository.openPeriodOf('pvp1', 'season');

    expect(
      harness.repository.topOf({ periodId: period!.id, metric: 'pvp.kills', limit: 10, offset: 0 })
        .entries[0]?.value,
    ).toBe(10);
  });

  it('o mesmo `eventId` chegando por push e por lote soma UMA vez', () => {
    const event = {
      eventId: '76561198000000009-1757088123-4',
      serverId: 'pvp1',
      steamId: '76561198000000009',
      name: 'Ciclano',
      metric: 'trophy.bleik',
      amount: 3,
      source: 'item:trofeu-bleik',
      at: 1_757_088_123,
    };

    // O push dá o "agora": o recibo no chat tem que ser na hora.
    const push = harness.repository.applyEvent({ ...event, via: 'push' }, NOW);

    expect(push.applied).toBe(true);

    // Sessenta segundos depois, o lote traz o MESMO evento — é o
    // caminho "garantido", e ele chega em outro `batchId`.
    const flush = harness.repository.applyBatch(
      batch({ batchId: 'pvp1-outro', seq: 42, players: [], events: [event] }),
      NOW + 60_000,
    );

    expect(flush.applied).toBe(true);
    expect(flush.eventsApplied).toBe(0);

    const period = harness.repository.openPeriodOf('pvp1', 'season');
    const top = harness.repository.topOf({
      periodId: period!.id,
      metric: 'trophy.bleik',
      limit: 10,
      offset: 0,
    });

    expect(top.entries).toHaveLength(1);
    expect(top.entries[0]?.value).toBe(3);
  });
});

// ------------------------------------------------------------
//  A chave estrangeira
// ------------------------------------------------------------

describe('o jogador que o agente nunca viu', () => {
  it('um lote com steamId novo NÃO quebra a FK, e o lote inteiro entra', () => {
    // O banco tem a FK ligada — sem o `INSERT OR IGNORE INTO
    // players`, esta chamada estouraria e levaria junto o lote de
    // todo mundo.
    expect(harness.db.pragma('foreign_keys', { simple: true })).toBe(1);

    const applied = harness.repository.applyBatch(
      batch({
        players: [
          { steamId: '76561198000000001', name: 'Fulano', metrics: { 'pvp.kills': 3 } },
          { steamId: '76561198999999999', name: 'RecemChegado', metrics: { 'pvp.kills': 9 } },
        ],
      }),
      NOW,
    );

    expect(applied.applied).toBe(true);

    const player = harness.db
      .prepare('SELECT steam_id, name FROM players WHERE steam_id = @id')
      .get({ id: '76561198999999999' }) as { steam_id: string; name: string } | undefined;

    expect(player?.name).toBe('RecemChegado');

    const period = harness.repository.openPeriodOf('pvp1', 'season');

    expect(
      harness.repository.topOf({ periodId: period!.id, metric: 'pvp.kills', limit: 10, offset: 0 })
        .entries[0]?.steamId,
    ).toBe('76561198999999999');
  });
});

// ------------------------------------------------------------
//  A paginação
// ------------------------------------------------------------

describe('o desempate de três critérios', () => {
  it('o empate produz a MESMA ordem entre a página 1 e a página 2', () => {
    // Seis jogadores com o MESMO valor e o MESMO `updated_at`: é o
    // caso em que uma ordenação sem critério total troca linhas
    // entre as páginas e some com um jogador.
    const players = Array.from({ length: 6 }, (_, index) => ({
      steamId: `7656119800000000${String(index)}`,
      name: `Jogador ${String(index)}`,
      metrics: { 'pvp.kills': 7 },
    }));

    harness.repository.applyBatch(batch({ players }), NOW);

    const period = harness.repository.openPeriodOf('pvp1', 'season');

    const first = harness.repository.topOf({
      periodId: period!.id,
      metric: 'pvp.kills',
      limit: 3,
      offset: 0,
    });

    const second = harness.repository.topOf({
      periodId: period!.id,
      metric: 'pvp.kills',
      limit: 3,
      offset: 3,
    });

    const seen = [...first.entries, ...second.entries].map((entry) => entry.steamId);

    // Ninguém repetido e ninguém faltando: as duas páginas somam a
    // lista inteira.
    expect(new Set(seen).size).toBe(6);
    expect(first.total).toBe(6);
    expect([...seen].sort()).toEqual(players.map((player) => player.steamId).sort());

    // E as posições continuam contínuas entre as páginas.
    expect(first.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(second.entries.map((entry) => entry.position)).toEqual([4, 5, 6]);
  });

  it('a colocação da ficha bate com a da lista', () => {
    harness.repository.applyBatch(
      batch({
        players: [
          { steamId: '76561198000000001', name: 'A', metrics: { 'pvp.kills': 10 } },
          { steamId: '76561198000000002', name: 'B', metrics: { 'pvp.kills': 7 } },
          { steamId: '76561198000000003', name: 'C', metrics: { 'pvp.kills': 7 } },
        ],
      }),
      NOW,
    );

    const period = harness.repository.openPeriodOf('pvp1', 'season');
    const top = harness.repository.topOf({
      periodId: period!.id,
      metric: 'pvp.kills',
      limit: 10,
      offset: 0,
    });

    for (const entry of top.entries) {
      const mine = harness.repository.positionOf({
        steamId: entry.steamId,
        periodId: period!.id,
        metric: 'pvp.kills',
      });

      expect(mine?.position).toBe(entry.position);
    }
  });
});

// ------------------------------------------------------------
//  A virada
// ------------------------------------------------------------

describe('a virada de período', () => {
  it('congela o pódio, abre o seguinte, e o número novo começa do zero', () => {
    harness.repository.applyBatch(batch(), NOW);

    const before = harness.repository.openPeriodOf('pvp1', 'season');
    const rolled = harness.repository.rollPeriod({
      periodId: before!.id,
      snapshotSize: 50,
      nextLabel: 'Temporada seguinte',
      at: NOW + 3_600_000,
    });

    expect(rolled.closed.id).toBe(before!.id);
    expect(rolled.closed.endedAt).toBe(NOW + 3_600_000);
    expect(rolled.opened.id).not.toBe(before!.id);
    expect(rolled.opened.endedAt).toBeNull();
    expect(rolled.frozen).toBeGreaterThan(0);

    // O pódio de ontem continua sendo o pódio de ontem.
    const podium = harness.repository.snapshotOf(before!.id, 'pvp.kills');

    expect(podium.map((row) => row.value)).toEqual([5, 3]);
    expect(podium[0]?.displayName).toBe('Beltrano');

    // E a disputa nova começa vazia.
    expect(
      harness.repository.topOf({
        periodId: rolled.opened.id,
        metric: 'pvp.kills',
        limit: 10,
        offset: 0,
      }).total,
    ).toBe(0);
  });

  it('o índice único parcial impede dois períodos abertos do mesmo tipo', () => {
    harness.repository.ensureOpenPeriods('pvp1', 'monthly', NOW);

    expect(() => harness.repository.openPeriod({ serverId: 'pvp1', kind: 'season' }, NOW)).toThrow();

    const open = harness.db
      .prepare(
        `SELECT count(*) AS total FROM stat_periods
          WHERE server_id = 'pvp1' AND kind = 'season' AND ended_at IS NULL`,
      )
      .get() as { total: number };

    expect(open.total).toBe(1);
  });

  it('o "de sempre" não vira, e a recusa tem nome', () => {
    const lifetime = harness.repository.ensureOpenPeriod(
      { serverId: 'pvp1', kind: 'lifetime' },
      NOW,
    );

    try {
      harness.repository.rollPeriod({ periodId: lifetime.id, snapshotSize: 10, at: NOW });
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('RANKING_PERIOD_LIFETIME');
    }
  });

  it('fechar um período já fechado é recusado com nome', () => {
    const period = harness.repository.ensureOpenPeriod({ serverId: 'pvp1', kind: 'season' }, NOW);

    harness.repository.closePeriod(period.id, NOW + 1_000);

    try {
      harness.repository.closePeriod(period.id, NOW + 2_000);
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('RANKING_PERIOD_CLOSED');
    }
  });

  it('virar a temporada NÃO zera a disputa de quem tem `window` de wipe ou lifetime', () => {
    // O mesmo lote soma nas TRÊS janelas — é a escrita, e ela não
    // muda. O que a `window` decide é qual delas a tela abre.
    harness.repository.applyBatch(
      batch({
        players: [
          {
            steamId: '76561198000000001',
            name: 'Fulano',
            metrics: { 'pvp.kills': 3, 'ore.sulfur': 1_200, 'time.played': 900 },
          },
        ],
      }),
      NOW,
    );

    const season = harness.repository.openPeriodOf('pvp1', 'season');
    const wipe = harness.repository.openPeriodOf('pvp1', 'wipe');
    const lifetime = harness.repository.openPeriodOf('pvp1', 'lifetime');

    harness.repository.rollPeriod({ periodId: season!.id, snapshotSize: 50, at: NOW + 1_000 });

    const seasonAfter = harness.repository.openPeriodOf('pvp1', 'season');

    // A disputa de PvP (window = season) recomeça...
    expect(
      harness.repository.topOf({
        periodId: seasonAfter!.id,
        metric: 'pvp.kills',
        limit: 10,
        offset: 0,
      }).total,
    ).toBe(0);

    // ...e a do farm e a de sempre continuam de pé, intocadas.
    expect(
      harness.repository.topOf({ periodId: wipe!.id, metric: 'ore.sulfur', limit: 10, offset: 0 })
        .entries[0]?.value,
    ).toBe(1_200);

    expect(
      harness.repository.topOf({
        periodId: lifetime!.id,
        metric: 'time.played',
        limit: 10,
        offset: 0,
      }).entries[0]?.value,
    ).toBe(900);

    expect(harness.repository.openPeriodOf('pvp1', 'wipe')?.id).toBe(wipe!.id);
    expect(harness.repository.openPeriodOf('pvp1', 'lifetime')?.id).toBe(lifetime!.id);
  });
});

// ------------------------------------------------------------
//  A configuração e o ajuste
// ------------------------------------------------------------

describe('a janela por servidor', () => {
  it('sem linha valem os padrões do código, e gravar não mexe no período em curso', () => {
    const defaults = harness.repository.settingsOf('pvp1');

    expect(defaults.seasonMode).toBe('monthly');
    expect(defaults.snapshotSize).toBe(50);
    expect(defaults.seasonOnWipe).toBe(false);
    expect(defaults.updatedAt).toBeNull();

    const open = harness.repository.ensureOpenPeriod({ serverId: 'pvp1', kind: 'season', seasonMode: 'monthly' }, NOW);

    const saved = harness.repository.saveSettings(
      'pvp1',
      { seasonMode: 'quarterly', seasonOnWipe: true, snapshotSize: 10 },
      NOW,
    );

    expect(saved.seasonMode).toBe('quarterly');
    expect(saved.seasonOnWipe).toBe(true);

    // A temporada em curso continua dizendo que é mensal: mudar a
    // configuração não reescreve o passado.
    expect(harness.repository.getPeriod(open.id)?.seasonMode).toBe('monthly');
  });

  it('zerar um jogador grava quem mexeu e qual era o número', () => {
    harness.repository.applyBatch(batch(), NOW);

    const period = harness.repository.openPeriodOf('pvp1', 'season');

    const zeroed = harness.repository.resetPlayer(
      {
        periodId: period!.id,
        steamId: '76561198000000002',
        actor: 'admin',
        reason: 'suspeita de macro',
      },
      NOW + 1_000,
    );

    expect(zeroed).toBe(1);

    const row = harness.db
      .prepare('SELECT metric, old_value, new_value, actor, reason FROM stat_adjustments')
      .get() as {
      metric: string;
      old_value: number;
      new_value: number;
      actor: string;
      reason: string;
    };

    expect(row).toMatchObject({
      metric: 'pvp.kills',
      old_value: 5,
      new_value: 0,
      actor: 'admin',
      reason: 'suspeita de macro',
    });
  });

  it('o período que nasce de um push respeita a configuração, e não o padrão', () => {
    // O cenário é real e é o pior deles: um evento de push pode ser
    // a PRIMEIRA coisa que um servidor registra, antes de o coletor
    // ter aberto período nenhum. Se a temporada nascesse com o modo
    // padrão, ela viraria na data errada — e `season_mode`, que é o
    // registro histórico de como a janela estava configurada,
    // guardaria uma mentira que ninguém reescreve depois.
    harness.repository.saveSettings('pvp2', { seasonMode: 'biweekly' }, NOW);

    harness.repository.applyEvent(
      {
        eventId: '76561198000000009-1757088123-7',
        serverId: 'pvp2',
        steamId: '76561198000000009',
        name: 'Ciclano',
        metric: 'trophy.bleik',
        amount: 1,
        source: 'item:trofeu-bleik',
        at: 1_757_088_123,
        // Por qual dos dois canais ele chegou primeiro. `applyEvent`
        // é o caminho do push, e o campo é obrigatório: é ele que
        // responde "por onde este ponto entrou" na auditoria.
        via: 'push',
      },
      NOW,
    );

    expect(harness.repository.openPeriodOf('pvp2', 'season')?.seasonMode).toBe('biweekly');
  });

  it('o período que nasce de um lote sem modo declarado também respeita a configuração', () => {
    harness.repository.saveSettings('pvp2', { seasonMode: 'quarterly' }, NOW);

    harness.repository.applyBatch(batch({ serverId: 'pvp2', batchId: 'pvp2-1757088123-1' }), NOW);

    expect(harness.repository.openPeriodOf('pvp2', 'season')?.seasonMode).toBe('quarterly');
  });
});

// ------------------------------------------------------------
//  Os recordes
// ------------------------------------------------------------

describe('o fato com testemunho', () => {
  it('guarda o melhor de cada jogador, com a arma junto, e ignora o que não bate o recorde', () => {
    harness.repository.applyBatch(
      batch({
        players: [],
        records: [
          {
            steamId: '76561198000000001',
            name: 'Fulano',
            metric: 'shot.distance',
            value: 412.73,
            at: 1_757_088_100,
            detail: { weapon: 'rifle.bolt', headshot: true, grid: 'G12' },
          },
        ],
      }),
      NOW,
    );

    // Um tiro PIOR, num lote seguinte: ele não vira linha nova.
    harness.repository.applyBatch(
      batch({
        batchId: 'pvp1-outro',
        seq: 42,
        players: [],
        records: [
          {
            steamId: '76561198000000001',
            metric: 'shot.distance',
            value: 100,
            at: 1_757_088_200,
          },
        ],
      }),
      NOW + 60_000,
    );

    const period = harness.repository.openPeriodOf('pvp1', 'wipe');
    const top = harness.repository.topRecordsOf({
      periodId: period!.id,
      metric: 'shot.distance',
      limit: 10,
      offset: 0,
    });

    expect(top.entries).toHaveLength(1);
    expect(top.entries[0]?.value).toBeCloseTo(412.73, 2);
    expect(top.entries[0]?.detail).toMatchObject({ weapon: 'rifle.bolt', grid: 'G12' });
  });
});

// ------------------------------------------------------------
//  A soma da rede
// ------------------------------------------------------------

describe('a soma da rede', () => {
  it('soma os períodos ABERTOS dos servidores, e a colocação bate com a lista', () => {
    harness.repository.applyBatch(
      batch({
        players: [{ steamId: '76561198000000001', name: 'Fulano', metrics: { 'pvp.kills': 3 } }],
      }),
      NOW,
    );

    harness.repository.applyBatch(
      batch({
        serverId: 'pvp2',
        batchId: 'pvp2-1',
        players: [
          { steamId: '76561198000000001', name: 'Fulano', metrics: { 'pvp.kills': 4 } },
          { steamId: '76561198000000002', name: 'Beltrano', metrics: { 'pvp.kills': 6 } },
        ],
      }),
      NOW + 1_000,
    );

    const top = harness.repository.globalTop({
      metric: 'pvp.kills',
      kind: 'season',
      limit: 10,
      offset: 0,
    });

    expect(top.entries.map((entry) => [entry.steamId, entry.value])).toEqual([
      ['76561198000000001', 7],
      ['76561198000000002', 6],
    ]);

    expect(
      harness.repository.globalPositionOf({
        steamId: '76561198000000002',
        metric: 'pvp.kills',
        kind: 'season',
      })?.position,
    ).toBe(2);
  });
});
