// ============================================================
//  quests-requires.test.ts
//
//  Quem pode VER a missão.
//
//  O campo era um requisito só (`vip:ouro`) e virou lista em
//  14/09/2026, a pedido do dono: "vai selecionando e ativando", e
//  quem tiver QUALQUER um dos escolhidos vê.
//
//  O que estes testes seguram é a retrocompatibilidade — todo
//  cadastro que já existe atravessa a leitura nova sem mudar de
//  significado — e o OR, que é a regra que o dono escolheu.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { createLogger } from '../src/logger.js';
import { formatRequires, parseRequires } from '../src/quests/requires.js';
import { QuestsService } from '../src/quests/service.js';
import { questInputSchema } from '../src/types/quests.js';

describe('a leitura do campo', () => {
  it('um requisito só continua sendo um requisito só', () => {
    // A propriedade que permite esta mudança não ter migração.
    expect(parseRequires('vip:ouro')).toEqual(['vip:ouro']);
  });

  it('a lista vem separada por vírgula, sem espaço sobrando', () => {
    expect(parseRequires('vip:ouro, vip:bronze')).toEqual(['vip:ouro', 'vip:bronze']);
  });

  it('nada escolhido é lista vazia — de todas as formas de nada', () => {
    // Tratá-las diferente faria uma quest sumir do menu por causa
    // de um espaço.
    expect(parseRequires(null)).toEqual([]);
    expect(parseRequires('')).toEqual([]);
    expect(parseRequires('  ')).toEqual([]);
    expect(parseRequires(',,')).toEqual([]);
  });

  it('o mesmo requisito duas vezes conta uma', () => {
    expect(parseRequires('vip:ouro,vip:ouro')).toEqual(['vip:ouro']);
  });

  it('a volta para a coluna é a ida ao contrário', () => {
    expect(formatRequires(['vip:ouro', 'vip:bronze'])).toBe('vip:ouro,vip:bronze');
    // Lista vazia é `null`, e não string vazia: é `null` que a
    // coluna guarda para "todo mundo vê".
    expect(formatRequires([])).toBeNull();
    expect(formatRequires(['  '])).toBeNull();
  });
});

describe('quem entra na quest trancada', () => {
  const NOW = 1_757_000_000_000;
  const FULANO = '76561198000000001';
  const logger = createLogger({ log: { level: 'silent', pretty: false } });

  let db: AgentDatabase;
  let repository: QuestsRepository;

  /** As perguntas que o provedor recebeu, na ordem. */
  let perguntas: string[];

  function serviceWith(tiers: readonly string[]): QuestsService {
    return new QuestsService({
      repository,
      logger,
      permissions: {
        can: ({ requires }) => {
          perguntas.push(requires);

          return tiers.some((tier) => requires === `vip:${tier}`);
        },
      },
      now: () => NOW,
    });
  }

  function seed(requires: string | null): void {
    repository.create(
      'trancada',
      questInputSchema.parse({
        title: 'Trancada',
        category: 'diaria',
        requires,
        objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 10 }],
        rewards: [],
      }),
      NOW,
    );
  }

  beforeEach(() => {
    db = openDatabase({ file: MEMORY_DATABASE });
    runMigrations(db);

    new ServersRepository(db).create({
      id: 'pvp1',
      name: 'PVP1',
      identity: 'pvp1',
      enabled: true,
      gamePort: 28015,
      rconPort: 28016,
      queryPort: 28017,
      appPort: 28082,
      rconHost: '127.0.0.1',
      installDir: 'Servers/pvp1',
    });

    repository = new QuestsRepository(db);
    perguntas = [];
  });

  it('com dois requisitos, ter UM basta', async () => {
    seed('vip:ouro,vip:bronze');

    const offers = await serviceWith(['bronze']).offersFor({ serverId: 'pvp1', steamId: FULANO });

    expect(offers[0]?.block).toBeNull();
  });

  it('não ter nenhum deles tranca', async () => {
    seed('vip:ouro,vip:bronze');

    const offers = await serviceWith(['prata']).offersFor({ serverId: 'pvp1', steamId: FULANO });

    expect(offers[0]?.block?.code).toBe('QUEST_LOCKED');
    // As duas foram perguntadas antes de trancar: parar na primeira
    // recusa esconderia o segundo caminho de entrada.
    expect(perguntas).toEqual(['vip:ouro', 'vip:bronze']);
  });

  it('para de perguntar no primeiro SIM', async () => {
    seed('vip:ouro,vip:bronze');

    await serviceWith(['ouro']).offersFor({ serverId: 'pvp1', steamId: FULANO });

    // Um provedor que vá à rede não pode ser consultado três vezes
    // quando a primeira já respondeu.
    expect(perguntas).toEqual(['vip:ouro']);
  });

  it('sem requisito, ninguém é perguntado', async () => {
    seed(null);

    const offers = await serviceWith([]).offersFor({ serverId: 'pvp1', steamId: FULANO });

    expect(offers[0]?.block).toBeNull();
    expect(perguntas).toEqual([]);
  });

  it('o cadastro antigo, de um requisito só, continua valendo', async () => {
    seed('vip:ouro');

    expect(
      (await serviceWith(['ouro']).offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block,
    ).toBeNull();

    perguntas = [];

    expect(
      (await serviceWith(['bronze']).offersFor({ serverId: 'pvp1', steamId: FULANO }))[0]?.block
        ?.code,
    ).toBe('QUEST_LOCKED');
  });

  it('sem provedor de permissões, a quest com requisito fica TRANCADA', async () => {
    seed('vip:ouro');

    const service = new QuestsService({ repository, logger, now: () => NOW });
    const offers = await service.offersFor({ serverId: 'pvp1', steamId: FULANO });

    // Liberar o que não se sabe conferir entregaria a quest de VIP
    // para todo mundo.
    expect(offers[0]?.block?.code).toBe('QUEST_LOCKED');
  });
});
