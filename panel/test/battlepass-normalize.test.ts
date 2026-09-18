// ============================================================
//  Testes do normalize.ts do Passe de Batalha.
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  O tipo do painel não valida a resposta: `lib/api.ts:143` é um
//  cast, e um campo que o agente omitir vira TypeError no render —
//  a página inteira cai com "This page couldn't load". O passe tem
//  quatro frentes construindo ao mesmo tempo (o XP, a compra, o
//  plugin e a skin), e um painel publicado antes de uma delas é o
//  caso normal, não a exceção.
//
//  Os casos são os quatro que o 05 §7 pede — campo omitido vira
//  padrão, enum desconhecido vira `null`, booleano ausente cai no
//  lado seguro, id grande continua texto — mais a lógica pura que
//  esta tela usa para decidir o que dizer: a curva, a estimativa de
//  quanto tempo leva a trilha, e as linhas da aba XP.
//
//  O ambiente é node, SEM jsdom (vitest.config.mts:4): o que tem
//  teste aqui é a LÓGICA; componente React é verificado pelo
//  typecheck e olhando a tela.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_XP_CURVE,
  buildXpRows,
  caveatOf,
  daysInPeriod,
  daysLeftInPeriod,
  describeReward,
  estimateTrack,
  isKnownRewardKind,
  levelCost,
  nextPeriodOf,
  periodLabel,
  safeAuditEntry,
  safeCellState,
  safeCurve,
  safeEntitlement,
  safeLane,
  safeOverview,
  safePlayerTrack,
  safeProgressList,
  safeRewards,
  safeSeason,
  safeSeasonState,
  safeSeasons,
  safeTrackCell,
  safeTrackCells,
  safeXpRule,
  safeXpRules,
  safeXpSources,
  upcomingPeriods,
  xpToReach,
} from '@/components/battlepass/normalize';
import type { BattlePassXpCurve, BattlePassXpRule, BattlePassXpSource } from '@/lib/api';

describe('safeSeason', () => {
  it('preenche a temporada inteira quando o agente manda só o id', () => {
    const season = safeSeason({ id: 3 });

    expect(season.period).toBe('');
    expect(season.label).toBe('');
    expect(season.levels).toBe(1);
    expect(season.xpCurve).toEqual(DEFAULT_XP_CURVE);
    expect(season.servers).toEqual([]);
    expect(season.description).toBeNull();
    expect(season.createdBy).toBeNull();
  });

  it('as três chaves ausentes caem no lado seguro: desligadas', () => {
    // Lado seguro é o que NÃO promete nada ao jogador: faixa que
    // não veio não aparece, e retroativo que não veio não promete
    // os níveis passados a quem comprar.
    const season = safeSeason({ id: 1 });

    expect(season.freeLane).toBe(false);
    expect(season.paidLane).toBe(false);
    expect(season.retroactive).toBe(false);

    const ligada = safeSeason({ id: 1, freeLane: true, paidLane: true, retroactive: true });

    expect(ligada.freeLane).toBe(true);
    expect(ligada.paidLane).toBe(true);
    expect(ligada.retroactive).toBe(true);

    // `1` não é `true`: um número onde se esperava booleano é sinal
    // de contrato divergindo, e o lado seguro continua valendo.
    expect(safeSeason({ id: 1, paidLane: 1 }).paidLane).toBe(false);
  });

  it('estado desconhecido vira null em vez de virar um palpite', () => {
    expect(safeSeasonState('active')).toBe('active');
    expect(safeSeasonState('publicada')).toBeNull();
    expect(safeSeasonState(undefined)).toBeNull();
    expect(safeSeason({ id: 1, state: 'archived' }).state).toBeNull();
  });

  it('lista ausente vira lista vazia', () => {
    expect(safeSeasons(undefined)).toEqual([]);
    expect(safeSeasons(null)).toEqual([]);
    expect(safeSeasons([{ id: 1 }]).length).toBe(1);
  });
});

describe('safeCurve', () => {
  it('curva desconhecida cai na do agente, e não em null', () => {
    // `null` aqui viraria o TypeError que este arquivo existe para
    // evitar: a tela precisa de uma curva para desenhar a trilha.
    expect(safeCurve({ kind: 'exponencial', base: 2 })).toEqual(DEFAULT_XP_CURVE);
    expect(safeCurve(undefined)).toEqual(DEFAULT_XP_CURVE);
    expect(safeCurve({ kind: 'flat' })).toEqual({ kind: 'flat', perLevel: 1000 });
  });

  it('mantém os três formatos, com os campos que faltam no padrão', () => {
    expect(safeCurve({ kind: 'linear', base: 500 })).toEqual({
      kind: 'linear',
      base: 500,
      step: 0,
    });
    expect(safeCurve({ kind: 'table', steps: [10, '20', null] })).toEqual({
      kind: 'table',
      steps: [10, 0, 0],
    });
    expect(safeCurve({ kind: 'table' })).toEqual({ kind: 'table', steps: [] });
  });
});

describe('a conta da curva', () => {
  it('o nível 1 é de graça, e o acumulado é a soma dos degraus', () => {
    const flat = { kind: 'flat', perLevel: 1000 } as const;

    expect(levelCost(flat, 1)).toBe(0);
    expect(xpToReach(flat, 1)).toBe(0);
    expect(xpToReach(flat, 30)).toBe(29_000);
  });

  it('a crescente soma o passo a cada degrau', () => {
    const linear = { kind: 'linear', base: 500, step: 100 } as const;

    expect(levelCost(linear, 2)).toBe(500);
    expect(levelCost(linear, 3)).toBe(600);
    // 29 degraus: 500 + 600 + ... + 3300.
    expect(xpToReach(linear, 30)).toBe(55_100);
  });

  it('a desenhada à mão usa um valor por degrau, e zero fora da lista', () => {
    const table: BattlePassXpCurve = { kind: 'table', steps: [100, 200] };

    expect(xpToReach(table, 3)).toBe(300);
    // O quarto degrau não existe na lista: ele não custa nada, em
    // vez de quebrar a conta.
    expect(xpToReach(table, 8)).toBe(300);
  });
});

describe('safeRewards', () => {
  it('normaliza os tipos conhecidos campo a campo', () => {
    const rewards = safeRewards([
      { kind: 'item', shortname: 'stones' },
      { kind: 'coins' },
      { kind: 'skin', shortname: 'rifle.ak', skinId: '18446744073709551615' },
    ]);

    expect(rewards[0]).toEqual({ kind: 'item', shortname: 'stones', amount: 1, skinId: '0' });
    expect(rewards[1]).toEqual({ kind: 'coins', amount: null, perMeter: null, min: null, max: null });
    // O id do Workshop passa de 2^53: ele continua TEXTO.
    expect(rewards[2]).toEqual({
      kind: 'skin',
      shortname: 'rifle.ak',
      skinId: '18446744073709551615',
      days: null,
    });
  });

  it('PRESERVA a recompensa de tipo desconhecido em vez de apagá-la', () => {
    // A frente B traz `kind: 'xp'`. Um painel mais velho que a
    // descartasse a apagaria de verdade no primeiro salvamento da
    // casa — o PUT da trilha manda a lista INTEIRA.
    const rewards = safeRewards([{ kind: 'xp', amount: 500 }]);

    expect(rewards.length).toBe(1);
    expect(rewards[0]).toEqual({ kind: 'xp', amount: 500 });
    expect(isKnownRewardKind('xp')).toBe(false);
    expect(isKnownRewardKind('skin')).toBe(true);
    expect(describeReward(rewards[0]!)).toContain('não sabe editar');
  });

  it('descarta o que não é recompensa, e a lista ausente vira vazia', () => {
    expect(safeRewards([null, 'stones', 42, {}])).toEqual([]);
    expect(safeRewards(undefined)).toEqual([]);
  });
});

describe('safeTrackCell', () => {
  it('casa sem faixa (ou sem nível) é descartada: ela não tem lugar na grade', () => {
    expect(safeTrackCell({ level: 3, lane: 'gold' })).toBeNull();
    expect(safeTrackCell({ lane: 'free' })).toBeNull();
    expect(safeTrackCell({ level: 0, lane: 'free' })).toBeNull();
    expect(safeTrackCells([{ level: 1, lane: 'free' }, { level: 2, lane: 'bronze' }]).length).toBe(1);
    expect(safeLane('paid')).toBe('paid');
    expect(safeLane('free ')).toBeNull();
  });

  it('marco ausente é "não é marco", e a casa sem recompensa é legítima', () => {
    const cell = safeTrackCell({ level: 7, lane: 'paid' });

    expect(cell?.milestone).toBe(false);
    expect(cell?.rewards).toEqual([]);
    expect(cell?.seasonId).toBe(0);
  });

  it('estado de casa desconhecido cai em "trancada"', () => {
    // O lado seguro: a tela nunca promete que alguém pode levar uma
    // recompensa por causa de um campo que não veio.
    expect(safeCellState(undefined)).toBe('locked');
    expect(safeCellState('unavailable')).toBe('locked');
    expect(safeCellState('available')).toBe('available');
  });
});

describe('safeXpRule', () => {
  it('regra sem o campo `enabled` NÃO paga XP', () => {
    const rule = safeXpRule({ source: 'pvp.kills', amount: 50 });

    expect(rule.enabled).toBe(false);
    expect(rule.dailyCap).toBeNull();
    expect(rule.label).toBeNull();
  });

  it('teto ausente é "sem teto", e não zero', () => {
    // Um zero inventado aqui fecharia a torneira sem ninguém pedir.
    expect(safeXpRule({ source: 'a' }).dailyCap).toBeNull();
    expect(safeXpRule({ source: 'a', dailyCap: 100 }).dailyCap).toBe(100);
  });

  it('regra sem fonte some: ela não teria como ser ligada', () => {
    expect(safeXpRules([{ amount: 10 }, { source: 'quest.completed' }]).length).toBe(1);
    expect(safeXpRules(undefined)).toEqual([]);
  });
});

describe('o cardápio de fontes', () => {
  it('fonte sem chave é descartada, e o rótulo vazio vira a chave', () => {
    const sources = safeXpSources([{ label: 'Sem chave' }, { source: 'quest.completed' }]);

    expect(sources.length).toBe(1);
    expect(sources[0]?.label).toBe('quest.completed');
    expect(sources[0]?.recommended).toBe(false);
  });

  it('avisa sobre as fontes com pegadinha mesmo sem o aviso do agente', () => {
    const sleeper = caveatOf({
      source: 'sleeper.kills',
      label: 'Matar dormindo',
      hint: null,
      warning: null,
      recommended: false,
      feed: 'batch',
    });
    const gather = caveatOf({
      source: 'gather.stone',
      label: 'Farmar pedra',
      hint: null,
      warning: null,
      recommended: false,
      feed: 'batch',
    });

    expect(sleeper).toContain('machado');
    expect(gather).toContain('ranking');
    expect(
      caveatOf({
        source: 'quest.completed',
        label: 'Missão',
        hint: null,
        warning: null,
        recommended: false,
        feed: 'batch',
      }),
    ).toBeNull();
  });

  it('o aviso do agente vence o que o painel já sabia', () => {
    const warning = caveatOf({
      source: 'sleeper.kills',
      label: 'Matar dormindo',
      hint: null,
      warning: 'Medido em 20/09: dobra o XP de quem farma base vazia.',
      recommended: false,
      feed: 'batch',
    });

    expect(warning).toBe('Medido em 20/09: dobra o XP de quem farma base vazia.');
  });
});

describe('buildXpRows', () => {
  const source = (key: string): BattlePassXpSource => ({
    source: key,
    label: key.toUpperCase(),
    hint: null,
    warning: null,
    recommended: false,
    feed: 'batch',
  });

  const rule = (key: string): BattlePassXpRule => ({
    seasonId: 1,
    source: key,
    enabled: true,
    amount: 10,
    dailyCap: null,
    label: null,
    updatedAt: '',
  });

  it('mantém a ordem do cardápio e casa a regra gravada com a fonte', () => {
    const rows = buildXpRows([source('quest.completed'), source('pvp.kills')], [rule('pvp.kills')]);

    expect(rows.map((row) => row.source)).toEqual(['quest.completed', 'pvp.kills']);
    expect(rows[0]?.rule).toBeNull();
    expect(rows[1]?.rule?.amount).toBe(10);
    expect(rows[1]?.orphan).toBe(false);
  });

  it('regra fora do cardápio NÃO some: ela vai para o fim, marcada como órfã', () => {
    // Ela continua valendo no agente — sumir da tela seria XP sendo
    // pago por uma fonte que o painel decidiu não mostrar.
    const rows = buildXpRows([source('quest.completed')], [rule('ore.sulfur')]);

    expect(rows.length).toBe(2);
    expect(rows[1]?.source).toBe('ore.sulfur');
    expect(rows[1]?.orphan).toBe(true);
  });

  it('sem cardápio nenhum, sobram exatamente as regras gravadas', () => {
    const rows = buildXpRows([], [rule('sleeper.kills')]);

    expect(rows.length).toBe(1);
    expect(rows[0]?.orphan).toBe(true);
    // A pegadinha continua sendo denunciada pela chave da fonte.
    expect(rows[0]?.warning).toContain('machado');
  });
});

describe('estimateTrack', () => {
  const rule = (
    source: string,
    amount: number,
    dailyCap: number | null,
    enabled = true,
  ): BattlePassXpRule => ({
    seasonId: 1,
    source,
    enabled,
    amount,
    dailyCap,
    label: null,
    updatedAt: '',
  });

  it('soma os tetos diários e diz em quantos dias a trilha termina', () => {
    const estimate = estimateTrack({
      curve: { kind: 'flat', perLevel: 1000 },
      levels: 31,
      rules: [rule('quest.completed', 800, 600), rule('pvp.kills', 50, 400)],
      period: '2026-10',
    });

    expect(estimate.totalXp).toBe(30_000);
    expect(estimate.dailyXp).toBe(1000);
    expect(estimate.days).toBe(30);
    expect(estimate.monthDays).toBe(31);
    // 30 de 31 dias: termina, mas em cima da hora.
    expect(estimate.verdict).toBe('tight');
  });

  it('acusa a temporada que NÃO dá para terminar dentro do mês', () => {
    const estimate = estimateTrack({
      curve: { kind: 'flat', perLevel: 5000 },
      levels: 31,
      rules: [rule('quest.completed', 800, 1000)],
      period: '2026-11',
    });

    expect(estimate.days).toBe(150);
    expect(estimate.verdict).toBe('overrun');
  });

  it('a folga de uma semana é o alvo', () => {
    const estimate = estimateTrack({
      curve: { kind: 'flat', perLevel: 1000 },
      levels: 11,
      rules: [rule('quest.completed', 500, 1000)],
      period: '2026-10',
    });

    expect(estimate.days).toBe(10);
    expect(estimate.verdict).toBe('ok');
  });

  it('fonte desligada ou pagando zero não entra na conta', () => {
    const estimate = estimateTrack({
      curve: { kind: 'flat', perLevel: 1000 },
      levels: 10,
      rules: [rule('a', 0, 500), rule('b', 100, 500, false)],
      period: '2026-10',
    });

    expect(estimate.paying).toBe(0);
    expect(estimate.dailyXp).toBe(0);
    expect(estimate.days).toBeNull();
    expect(estimate.verdict).toBe('unknown');
  });

  it('fonte sem teto é contada à parte: ela só encurta o prazo', () => {
    const estimate = estimateTrack({
      curve: { kind: 'flat', perLevel: 1000 },
      levels: 10,
      rules: [rule('a', 100, null), rule('b', 100, null)],
      period: '2026-10',
    });

    expect(estimate.paying).toBe(2);
    expect(estimate.uncapped).toBe(2);
    expect(estimate.days).toBeNull();
    expect(estimate.verdict).toBe('unknown');
  });
});

describe('o calendário da temporada', () => {
  it('o período vira mês por extenso, e o que não é período volta como veio', () => {
    expect(periodLabel('2026-10')).toBe('outubro de 2026');
    expect(periodLabel('2026-13')).toBe('2026-13');
    expect(periodLabel('')).toBe('—');
  });

  it('o mês seguinte atravessa o ano', () => {
    expect(nextPeriodOf('2026-10')).toBe('2026-11');
    expect(nextPeriodOf('2026-12')).toBe('2027-01');
  });

  it('sabe quantos dias o mês tem, inclusive em ano bissexto', () => {
    expect(daysInPeriod('2026-02')).toBe(28);
    expect(daysInPeriod('2028-02')).toBe(29);
    expect(daysInPeriod('2026-10')).toBe(31);
    expect(daysInPeriod('outubro')).toBeNull();
  });

  it('conta os dias que faltam para fechar, e nunca devolve negativo', () => {
    const now = new Date(2026, 9, 20, 12, 0, 0).getTime();

    expect(daysLeftInPeriod('2026-10', now)).toBe(12);
    // A temporada de setembro já passou: zero, e não um número
    // negativo que a tela mostraria como "-31 dias".
    expect(daysLeftInPeriod('2026-09', now)).toBe(0);
    expect(daysLeftInPeriod('', now)).toBeNull();
  });

  it('oferece os próximos meses a partir do de hoje', () => {
    const periods = upcomingPeriods(3, new Date(2026, 10, 15).getTime());

    expect(periods).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});

describe('o direito e o progresso', () => {
  it('SteamID64 continua texto, sem arredondar', () => {
    const rows = safeProgressList([{ steamId: '76561198000000001', xp: 10 }]);

    expect(rows[0]?.steamId).toBe('76561198000000001');
    // O nível alcançado começa em 1: quem nasce já está no primeiro.
    expect(rows[0]?.level).toBe(1);
  });

  it('"vale" se recalcula pela data da revogação quando o campo falta', () => {
    expect(safeEntitlement({ id: 1 }).active).toBe(true);
    expect(safeEntitlement({ id: 1, revokedAt: '2026-10-05T00:00:00.000Z' }).active).toBe(false);
    expect(safeEntitlement({ id: 1, revokedAt: null, active: false }).active).toBe(false);
  });

  it('a trilha do jogador sem o campo `paid` NÃO promete a faixa paga', () => {
    const track = safePlayerTrack({ serverId: 'pvp1', steamId: '7656119800000000x' });

    expect(track.paid).toBe(false);
    expect(track.unseen).toBe(false);
    expect(track.season).toBeNull();
    expect(track.cells).toEqual([]);
    expect(track.pending).toEqual([]);
    expect(track.progress.level).toBe(1);
    expect(track.progress.neededForNext).toBeNull();
  });
});

describe('a visão geral e o registro', () => {
  it('a visão geral aguenta vir sem temporada nenhuma', () => {
    const overview = safeOverview({ serverId: 'pvp1', period: '2026-10' });

    expect(overview.season).toBeNull();
    expect(overview.next).toBeNull();
    expect(overview.owners).toBe(0);
    expect(overview.players).toBe(0);
  });

  it('origem desconhecida no registro cai em "painel", e o detalhe vira objeto', () => {
    const entry = safeAuditEntry({ id: 1, source: 'discord', detail: 'texto solto' });

    expect(entry.source).toBe('panel');
    expect(entry.detail).toEqual({});
    expect(entry.serverId).toBeNull();
    expect(entry.steamId).toBeNull();
  });
});
