// ============================================================
//  O que o seletor de ranking da missão decide sozinho.
//
//  ####  O DEFEITO QUE TROUXE ESTE ARQUIVO  ####
//
//  O campo do ranking era texto livre. O dono escreveu
//  `quest.completed` — que parece o nome certo e não é ranking
//  nenhum —, a missão salvou, o jogador concluiu, os 50 OZCoin
//  caíram e os 5 pontos viraram pendência. Medido em 14/09/2026.
//
//  O que se prova aqui são as duas decisões do seletor: QUAIS
//  rankings ele oferece (que é onde "5 pontos em Metal" deixa de
//  ser escrevível) e como a busca acha o que o admin procura.
//
//  Componente React não é montado: o vitest do painel roda em node
//  puro, e é por isso que as decisões moram em `ranking-choice.ts`.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  eligibleRankings,
  isAwardable,
  matchesRanking,
  searchRankings,
} from '@/components/ranking/ranking-choice';
import type { RankingDefinition } from '@/lib/api';

function ranking(overrides: Partial<RankingDefinition>): RankingDefinition {
  return {
    id: 'trofeu-bleik',
    metric: 'trophy.bleik',
    label: 'Troféu Bleik Store',
    shortLabel: null,
    unit: null,
    description: null,
    source: 'item',
    valueKind: 'counter',
    direction: 'desc',
    window: 'season',
    globalEligible: true,
    builtin: false,
    enabled: true,
    showInGame: true,
    sortOrder: 10,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

const BLEIK = ranking({});
const METAL = ranking({ id: 'minerio-metal', metric: 'ore.metal', label: 'Metal', source: 'plugin' });
const TEMPO = ranking({
  id: 'tempo-online',
  metric: 'time.played',
  label: 'Tempo online',
  source: 'agent',
});
const KD = ranking({ id: 'kd', metric: 'pvp.kd', label: 'K/D', source: 'computed' });

const TODOS = [BLEIK, METAL, TEMPO, KD];

describe('quem pode RECEBER ponto de missão', () => {
  it('só o ranking concedido', () => {
    expect(isAwardable(BLEIK)).toBe(true);
    // Somar cinco à mão em "Metal" seria dizer que o jogador
    // minerou cinco de metal.
    expect(isAwardable(METAL)).toBe(false);
    expect(isAwardable(TEMPO)).toBe(false);
    // O K/D nem linha em `player_stats` tem.
    expect(isAwardable(KD)).toBe(false);
  });

  it('a recompensa oferece só esses; o objetivo oferece todos', () => {
    expect(eligibleRankings(TODOS, 'award')).toEqual([BLEIK]);
    // Ler é livre: "chegue a 1.000 de minério" é um objetivo
    // legítimo, e foi confundir os dois usos que produziu o defeito.
    expect(eligibleRankings(TODOS, 'read')).toEqual(TODOS);
  });

  it('a ordem do catálogo é preservada — ela é a do painel', () => {
    const lista = [METAL, BLEIK, ranking({ id: 'outro', metric: 'x.y', label: 'Outro' })];

    expect(eligibleRankings(lista, 'award').map((entry) => entry.id)).toEqual([
      'trofeu-bleik',
      'outro',
    ]);
  });
});

describe('a busca', () => {
  it('acha pelo nome que se lê', () => {
    expect(matchesRanking(BLEIK, 'bleik')).toBe(true);
    expect(matchesRanking(BLEIK, 'BLEIK')).toBe(true);
    expect(matchesRanking(METAL, 'bleik')).toBe(false);
  });

  it('acha pelo código que se grava', () => {
    // Quem já conhece a métrica digita ela — e os dois aparecem na
    // tela, lado a lado.
    expect(matchesRanking(BLEIK, 'trophy')).toBe(true);
    expect(matchesRanking(METAL, 'ore.')).toBe(true);
  });

  it('acha com acento e sem', () => {
    expect(matchesRanking(BLEIK, 'Troféu')).toBe(true);
  });

  it('busca vazia devolve tudo, e espaço em branco também', () => {
    expect(searchRankings(TODOS, '')).toEqual(TODOS);
    expect(searchRankings(TODOS, '   ')).toEqual(TODOS);
  });

  it('o que não casa fica de fora', () => {
    expect(searchRankings(TODOS, 'xyz')).toEqual([]);
  });
});
