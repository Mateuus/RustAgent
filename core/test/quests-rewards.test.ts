// ============================================================
//  quests-rewards.test.ts  -  o que a quest DÁ.
//
//  O que este arquivo guarda:
//
//    1. uma falha NÃO derruba as outras. "Faltou espaço para a AK"
//       não pode virar "não recebi nada" — e o admin reentregando
//       quatro coisas em vez de uma;
//    2. nada aqui LANÇA. Quem chamou já comitou o `claimed`, e uma
//       exceção deixaria a quest resgatada sem registro do erro;
//    3. a referência da moeda e o `eventId` do ponto são ESTÁVEIS:
//       é o que faz o botão "reentregar" do painel não creditar
//       duas vezes;
//    4. `perMeter` sem distância medida FALHA, em vez de pagar
//       zero em silêncio;
//    5. dependência ausente vira pendência visível, e não sumiço.
// ============================================================

import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../src/logger.js';
import {
  QuestRewardService,
  type DeliverRewardsInput,
  type QuestItemCatalog,
  type QuestItemDelivery,
  type QuestKits,
  type QuestPoints,
  type QuestWallet,
} from '../src/quests/rewards.js';
import { questRewardSchema, type QuestReward } from '../src/types/quests.js';

/**
 * Os parâmetros de cada dependência, pelo nome.
 *
 * `vi.fn(() => …)` sem parâmetro declarado infere uma tupla VAZIA
 * de argumentos, e aí `mock.calls[0][0]` não compila. Declarar o
 * tipo aqui é o que deixa a asserção ler o argumento de verdade em
 * vez de um `as` que esconderia uma mudança de assinatura.
 */
type CreditInput = Parameters<QuestWallet['credit']>[0];
type DeliverPlan = Parameters<QuestItemDelivery['deliverPlan']>[2];
type ClaimInput = Parameters<QuestKits['claim']>[0];
type PointsInput = Parameters<QuestPoints['applyEvent']>[0];

const logger = createLogger({ log: { level: 'silent', pretty: false } });
const NOW = 1_757_000_000_000;
const FULANO = '76561198000000001';

/** Passa pelo zod: é assim que a recompensa chega em produção. */
function reward(value: unknown): QuestReward {
  return questRewardSchema.parse(value);
}

function input(rewards: readonly QuestReward[], extra: Partial<DeliverRewardsInput> = {}) {
  return {
    serverId: 'RUST01',
    steamId: FULANO,
    questId: 'minerador',
    attempt: 3,
    questTitle: 'Minerador',
    rewards,
    ...extra,
  };
}

function build(parts: {
  readonly delivery?: QuestItemDelivery;
  readonly wallet?: QuestWallet;
  readonly kits?: QuestKits;
  readonly points?: QuestPoints;
  /** `null` = o catálogo não conhece nada. Ver o teste do ITEM_UNKNOWN. */
  readonly catalog?: QuestItemCatalog | null;
}) {
  return new QuestRewardService({
    logger,
    delivery: parts.delivery,
    // Por padrão o catálogo conhece tudo: a maioria dos testes é
    // sobre outra coisa, e um `itemId` ausente faria o item falhar
    // por um motivo que não é o do teste.
    catalog: parts.catalog === null ? undefined : (parts.catalog ?? { itemIdOf: () => 1 }),
    wallet: parts.wallet === undefined ? undefined : () => parts.wallet as QuestWallet,
    kits: parts.kits,
    points: parts.points,
    now: () => NOW,
  });
}

const okWallet: QuestWallet = { credit: () => Promise.resolve({ status: 'ok' }) };
const okDelivery: QuestItemDelivery = { deliverPlan: () => Promise.resolve() };
const okPoints: QuestPoints = { applyEvent: () => ({ applied: true }) };

// ------------------------------------------------------------

describe('uma falha não derruba as outras', () => {
  it('o item falha por inventário cheio e os coins são creditados assim mesmo', async () => {
    const credit = vi.fn((_move: CreditInput) => Promise.resolve({ status: 'ok' }));
    const service = build({
      delivery: { deliverPlan: () => Promise.reject(new Error('INVENTORY_FULL')) },
      wallet: { credit },
    });

    const outcomes = await service.deliver(
      input([
        reward({ kind: 'item', shortname: 'rifle.ak', amount: 1 }),
        reward({ kind: 'coins', amount: 500 }),
      ]),
    );

    // Abortar no primeiro erro transformaria "faltou espaço para a
    // AK" em "não recebi nada".
    expect(outcomes[0]).toMatchObject({ kind: 'item', ok: false, code: 'INVENTORY_FULL' });
    expect(outcomes[1]).toMatchObject({ kind: 'coins', ok: true });
    expect(credit).toHaveBeenCalledOnce();
  });

  it('nunca lança, nem quando quem entrega estoura de um jeito estranho', async () => {
    const service = build({
      delivery: {
        deliverPlan: () => {
          throw 'isto nem é um Error';
        },
      },
    });

    // Uma exceção aqui, depois do commit do `claimed`, seria uma
    // quest resgatada sem nenhum registro do que deu errado.
    const outcomes = await service.deliver(
      input([reward({ kind: 'item', shortname: 'rifle.ak', amount: 1 })]),
    );

    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.message).toContain('administrador');
  });
});

// ------------------------------------------------------------

describe('o item e o VIP', () => {
  it('vão pelo MESMO `deliverPlan`, cada um no seu campo', async () => {
    const deliverPlan = vi.fn((_server: string, _steam: string, _plan: DeliverPlan) =>
      Promise.resolve(),
    );
    const service = build({ delivery: { deliverPlan } });

    await service.deliver(
      input([
        reward({ kind: 'item', shortname: 'rifle.ak', amount: 2, skinId: '3120436264' }),
        reward({ kind: 'vip', tier: 'ouro', days: 7 }),
      ]),
    );

    expect(deliverPlan).toHaveBeenCalledTimes(2);
    expect(deliverPlan.mock.calls[0]?.[2]).toMatchObject({
      items: [{ shortname: 'rifle.ak', amount: 2, skinId: '3120436264' }],
      vip: null,
      units: 1,
    });
    // Duas portas para o mesmo benefício divergiriam na primeira
    // mudança de regra do VIP.
    expect(deliverPlan.mock.calls[1]?.[2]).toMatchObject({
      items: [],
      vip: { tier: 'ouro', days: 7 },
    });
  });
});

// ------------------------------------------------------------

describe('a moeda', () => {
  it('a referência é estável — é o que torna o retry seguro', async () => {
    const credit = vi.fn((_move: CreditInput) => Promise.resolve({ status: 'ok' }));
    const service = build({ wallet: { credit } });
    const rewards = [reward({ kind: 'coins', amount: 500 })];

    await service.deliver(input(rewards));
    await service.deliver(input(rewards));

    const first = credit.mock.calls[0]?.[0];
    const second = credit.mock.calls[1]?.[0];

    // O botão de reentregar do painel manda a mesma referência, e a
    // carteira do site responde `idempotent` em vez de creditar de
    // novo. É o único dos cinco tipos com essa proteção.
    expect(first?.reference).toBe(second?.reference);
    expect(first?.reference).toContain('rust:RUST01:quest:');
    expect(first?.reference).toContain('minerador:3:0');
  });

  it('duas recompensas de moeda na mesma quest têm referências diferentes', async () => {
    const credit = vi.fn((_move: CreditInput) => Promise.resolve({ status: 'ok' }));
    const service = build({ wallet: { credit } });

    await service.deliver(
      input([reward({ kind: 'coins', amount: 100 }), reward({ kind: 'coins', amount: 200 })]),
    );

    const a = credit.mock.calls[0]?.[0].reference;
    const b = credit.mock.calls[1]?.[0].reference;

    // Sem a posição na chave, as duas mandariam a MESMA referência
    // e a segunda voltaria `idempotent` — o jogador receberia
    // metade. É o bug que o painel do Conan pagou.
    expect(a).not.toBe(b);
  });

  it('tentativas diferentes da mesma quest não colidem', async () => {
    const credit = vi.fn((_move: CreditInput) => Promise.resolve({ status: 'ok' }));
    const service = build({ wallet: { credit } });
    const rewards = [reward({ kind: 'coins', amount: 500 })];

    await service.deliver(input(rewards, { attempt: 3 }));
    await service.deliver(input(rewards, { attempt: 4 }));

    // A diária de hoje e a de ontem são a mesma quest. Sem o
    // `attempt` na chave, a de hoje voltaria `idempotent`.
    expect(credit.mock.calls[0]?.[0].reference).not.toBe(credit.mock.calls[1]?.[0].reference);
  });

  it('`perMeter` sem distância FALHA, em vez de pagar zero', async () => {
    const service = build({ wallet: okWallet });

    const outcomes = await service.deliver(
      input([reward({ kind: 'coins', perMeter: 0.5, min: 50, max: 2000 })]),
    );

    // Pagar zero em silêncio seria pior: a quest apareceria como
    // entregue e o jogador não teria o que reclamar de concreto.
    expect(outcomes[0]).toMatchObject({ ok: false, code: 'QUEST_DISTANCE_UNKNOWN' });
  });

  it('`perMeter` respeita o piso e o teto', async () => {
    const credit = vi.fn((_move: CreditInput) => Promise.resolve({ status: 'ok' }));
    const service = build({ wallet: { credit } });
    const coins = reward({ kind: 'coins', perMeter: 0.5, min: 50, max: 2000 });

    await service.deliver(input([coins], { distanceMeters: 1200 }));
    await service.deliver(input([coins], { distanceMeters: 10 }));
    await service.deliver(input([coins], { distanceMeters: 100_000 }));

    const amounts = credit.mock.calls.map((call) => call[0].amount);

    // 1200 x 0,5 = 600; o piso segura os 5 e o teto segura os
    // 50.000 — uma entrega entre NPCs distantes num mapa de 6 km
    // pagaria um número que ninguém escolheu.
    expect(amounts).toEqual([600, 50, 2000]);
  });

  it('a carteira que não responde vira pendência com o código dela', async () => {
    const service = build({
      wallet: { credit: () => Promise.resolve({ status: 'unknown', message: 'sem resposta' }) },
    });

    const outcomes = await service.deliver(input([reward({ kind: 'coins', amount: 500 })]));

    expect(outcomes[0]).toMatchObject({
      ok: false,
      code: 'WALLET_UNKNOWN',
      message: 'sem resposta',
    });
  });
});

// ------------------------------------------------------------

describe('o kit', () => {
  it('é achado pelo `slug`, e o id local nunca sai daqui', async () => {
    const claim = vi.fn((_claim: ClaimInput) => Promise.resolve({ status: 'entregue' }));
    const service = build({
      kits: { list: () => [{ id: 42, slug: 'starter', name: 'Inicial' }], claim },
    });

    const outcomes = await service.deliver(input([reward({ kind: 'kit', slug: 'starter' })]));

    expect(claim).toHaveBeenCalledWith({
      kitId: 42,
      steamId: FULANO,
      serverId: 'RUST01',
      actor: 'quest',
    });
    expect(outcomes[0]).toMatchObject({ ok: true, message: 'Kit Inicial entregue.' });
  });

  it('kit apagado depois da promessa vira pendência nomeada', async () => {
    const service = build({ kits: { list: () => [], claim: () => Promise.resolve({ status: 'x' }) } });

    // O snapshot guardou a promessa; o kit não existe mais para
    // cumpri-la.
    const outcomes = await service.deliver(input([reward({ kind: 'kit', slug: 'sumido' })]));

    expect(outcomes[0]).toMatchObject({ ok: false, code: 'KIT_NOT_FOUND' });
    expect(outcomes[0]?.message).toContain('sumido');
  });

  it('o kit que recusa entrega passa a frase de quem recusou', async () => {
    const service = build({
      kits: {
        list: () => [{ id: 1, slug: 'starter', name: 'Inicial' }],
        claim: () => Promise.resolve({ status: 'recusado', detail: 'Você já pegou este kit.' }),
      },
    });

    const outcomes = await service.deliver(input([reward({ kind: 'kit', slug: 'starter' })]));

    expect(outcomes[0]).toMatchObject({ ok: false, message: 'Você já pegou este kit.' });
  });
});

// ------------------------------------------------------------

describe('os pontos', () => {
  it('o `eventId` é estável, e o retry cai no INSERT OR IGNORE', async () => {
    const applyEvent = vi.fn((_event: PointsInput) => ({ applied: true }));
    const service = build({ points: { applyEvent } });

    await service.deliver(input([reward({ kind: 'points', metric: 'quest.completed', amount: 1 })]));

    expect(applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'quest:minerador:3:0',
        metric: 'quest.completed',
        amount: 1,
        source: 'quest',
        // Segundos: é a unidade da coluna `at` de `stat_events`.
        // Errar isso desloca o evento para 1970 sem erro no
        // caminho.
        at: Math.floor(NOW / 1000),
      }),
    );
  });

  it('"já tinha somado" NÃO é falha — é o retry funcionando', async () => {
    const service = build({ points: { applyEvent: () => ({ applied: false }) } });

    const outcomes = await service.deliver(
      input([reward({ kind: 'points', metric: 'quest.completed', amount: 1 })]),
    );

    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.message).toContain('já tinham sido somados');
  });
});

// ------------------------------------------------------------

describe('a dependência ausente', () => {
  it('vira pendência visível, e não sumiço', async () => {
    const service = build({ catalog: null });

    const outcomes = await service.deliver(
      input([
        reward({ kind: 'item', shortname: 'rifle.ak', amount: 1 }),
        reward({ kind: 'coins', amount: 1 }),
        reward({ kind: 'kit', slug: 'starter' }),
        reward({ kind: 'points', metric: 'quest.completed', amount: 1 }),
        reward({ kind: 'vip', tier: 'ouro', days: 1 }),
      ]),
    );

    // Uma quest que promete kit num agente sem o serviço de kits
    // precisa aparecer como algo a resolver — não como entregue.
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((item) => !item.ok)).toBe(true);
    expect(new Set(outcomes.map((item) => item.code))).toEqual(
      new Set(['QUEST_REWARD_UNAVAILABLE']),
    );
  });

  it('e as que TÊM caminho continuam saindo', async () => {
    const service = build({ wallet: okWallet, points: okPoints, delivery: okDelivery });

    const outcomes = await service.deliver(
      input([
        reward({ kind: 'coins', amount: 10 }),
        reward({ kind: 'kit', slug: 'starter' }),
        reward({ kind: 'points', metric: 'quest.completed', amount: 1 }),
      ]),
    );

    expect(outcomes.map((item) => item.ok)).toEqual([true, false, true]);
  });
});

// ------------------------------------------------------------

describe('a lista vazia', () => {
  it('uma quest sem recompensa não é erro', async () => {
    const service = build({});

    // Existe quest que só destrava a próxima da cadeia.
    await expect(service.deliver(input([]))).resolves.toEqual([]);
  });
});

// ------------------------------------------------------------

describe('o item que sumiu do jogo', () => {
  it('vira pendência COM O NOME, e não um `give` que o plugin recusa', async () => {
    const deliverPlan = vi.fn((_s: string, _p: string, _plan: DeliverPlan) => Promise.resolve());
    const service = build({
      delivery: { deliverPlan },
      catalog: { itemIdOf: () => null },
    });

    const outcomes = await service.deliver(
      input([reward({ kind: 'item', shortname: 'item.que.sumiu', amount: 1 })]),
    );

    // O Rust removeu o item numa atualização, ou o admin digitou
    // errado. Sem esta checagem, o `give` sairia e o plugin
    // recusaria — e o motivo não apareceria em lugar nenhum.
    expect(outcomes[0]).toMatchObject({ ok: false, code: 'ITEM_UNKNOWN' });
    expect(outcomes[0]?.message).toContain('item.que.sumiu');
    expect(deliverPlan).not.toHaveBeenCalled();
  });

  it('o VIP não depende do catálogo — ele não é um item', async () => {
    const deliverPlan = vi.fn((_s: string, _p: string, _plan: DeliverPlan) => Promise.resolve());
    const service = build({ delivery: { deliverPlan }, catalog: { itemIdOf: () => null } });

    const outcomes = await service.deliver(input([reward({ kind: 'vip', tier: 'ouro', days: 7 })]));

    expect(outcomes[0]?.ok).toBe(true);
    expect(deliverPlan).toHaveBeenCalledOnce();
  });
});
