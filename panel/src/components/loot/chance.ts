// ============================================================
//  chance.ts  -  o que "0,0001" produz no mundo.
//
//  ####  É AQUI QUE O ADMIN SE PERDE  ####
//
//  A chance de uma regra é um número por CONTAINER POPULADO. Ela
//  não diz nada sozinha: `0.0001` pode ser "um por mês" num
//  container raro e "três por dia" num barril de estrada, e a
//  diferença inteira mora no denominador — quantos containers
//  daqueles o mapa popula por dia.
//
//  Um editor de loot que mostra só o número cru transfere essa
//  conta para a cabeça de quem está na frente da tela, e ninguém
//  a faz. O concorrente vende exatamente isto como recurso
//  central (Docs/CustomItem/05 §7.1: "visualize rolls para
//  balancear wipes mais rápido").
//
//  ####  O DENOMINADOR É ESTIMATIVA, E ISSO PRECISA SER DITO  ####
//
//  O número de containers populados por dia NÃO É MEDIDO em lugar
//  nenhum — o 05 §9.6 registra isso como buraco aberto, e o 04
//  §6.3 estima entre 1.000 e 5.000 para a rede inteira, a partir
//  dos 400 containers de mundo aberto que o `spawn.report` do
//  server01 mediu vivos.
//
//  Por isso a tela mostra o denominador como um campo que o admin
//  mexe, e não como um fato: a projeção é honesta sobre o que ela
//  supõe. É também para isso que existe o modo de MEDIÇÃO — ele
//  responde o denominador com o servidor no ar, em vez de supor.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React e nada de rede: é o que os testes do painel
//  alcançam (`panel/test/loot-chance.test.ts`). A aritmética que
//  traduz a chance é a parte que erra em silêncio — uma conta
//  errada aqui não quebra tela nenhuma, só faz o admin soltar mil
//  troféus por dia achando que soltou dois por semana.
// ============================================================

/**
 * O palpite de partida para "quantos destes o mapa popula por dia".
 *
 * 400 é o número de containers de mundo aberto que o
 * `spawn.report true loot` mediu vivos no server01 (04 §6.3) — o
 * único número desta conta que veio de medição. Ele é o PALPITE,
 * não a resposta: o giro (quantas vezes por dia esses 400 são
 * repostos) continua sem medição.
 */
export const CONTAINERS_PER_DAY_START = 400;

/**
 * Os degraus do seletor rápido.
 *
 * São os da tabela do 04 §6.3, que é a que o estudo usou para
 * chegar em "1 em 7.000 dá 2 por semana".
 */
export const CONTAINERS_PER_DAY_PRESETS: readonly number[] = [400, 1_000, 2_000, 5_000];

/** Abaixo disto, "uma semana em cada N" deixa de dizer algo útil. */
const DRY_SPELL_FLOOR = 0.005;

export interface ChanceProjection {
  /** Quantos por dia, sem teto nenhum. */
  readonly perDay: number;
  readonly perWeek: number;
  /** O que o teto diário deixa passar. `null` = regra sem teto. */
  readonly cappedPerDay: number | null;
  readonly cappedPerWeek: number | null;
  /** O teto está cortando de fato — e não só existindo. */
  readonly capped: boolean;
  /** Horas entre um e o seguinte, em média. `null` se não sai nenhum. */
  readonly hoursBetween: number | null;
  /**
   * A chance de a semana passar em branco.
   *
   * Poisson com λ = quantos por semana. O 04 §6.3 já avisou por
   * que isso precisa estar na tela ANTES: com 2 por semana, uma
   * semana em cada sete não sai nada — e a pergunta "o spawn raro
   * está quebrado?" chega na primeira semana seca.
   *
   * O teto não entra no λ de propósito: ele corta a cauda alta,
   * não muda a chance de sair zero.
   */
  readonly drySpellOdds: number;
  /** "uma semana em cada N". `null` quando a semana seca é rara demais. */
  readonly drySpellOneIn: number | null;
}

/** Um número positivo digitado por gente: "5.000", "5000", "0,5". */
export function parseCount(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');

  if (cleaned === '') {
    return null;
  }

  const value = Number(cleaned);

  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A chance como "uma em N". `null` quando a chance não faz sentido. */
export function oneInFromChance(chance: number | null): number | null {
  if (chance === null || !Number.isFinite(chance) || chance <= 0 || chance > 1) {
    return null;
  }

  return 1 / chance;
}

/** O caminho de volta: o admin digita N, e a regra guarda a chance. */
export function chanceFromOneIn(oneIn: number | null): number | null {
  if (oneIn === null || !Number.isFinite(oneIn) || oneIn < 1) {
    return null;
  }

  return 1 / oneIn;
}

/**
 * O que a chance produz, com o denominador suposto.
 *
 * `null` quando falta um dos dois: uma projeção com denominador
 * ausente seria um número inventado, e a regra da casa é travessão
 * — nunca zero.
 */
export function projectChance(input: {
  readonly chance: number | null;
  readonly containersPerDay: number | null;
  readonly dailyCap: number | null;
}): ChanceProjection | null {
  const { chance, containersPerDay, dailyCap } = input;

  if (chance === null || !Number.isFinite(chance) || chance <= 0 || chance > 1) {
    return null;
  }

  if (containersPerDay === null || !Number.isFinite(containersPerDay) || containersPerDay <= 0) {
    return null;
  }

  const perDay = chance * containersPerDay;
  const perWeek = perDay * 7;

  const hasCap = dailyCap !== null && Number.isFinite(dailyCap) && dailyCap > 0;
  const cappedPerDay = hasCap ? Math.min(perDay, dailyCap) : null;
  const effectivePerDay = cappedPerDay ?? perDay;

  const drySpellOdds = Math.exp(-perWeek);

  return {
    perDay,
    perWeek,
    cappedPerDay,
    cappedPerWeek: cappedPerDay === null ? null : cappedPerDay * 7,
    // Uma folga pequena para não anunciar "o teto corta" quando
    // ele empata com a projeção por erro de ponto flutuante.
    capped: cappedPerDay !== null && cappedPerDay < perDay - 1e-9,
    hoursBetween: effectivePerDay > 0 ? 24 / effectivePerDay : null,
    drySpellOdds,
    drySpellOneIn: drySpellOdds >= DRY_SPELL_FLOOR ? 1 / drySpellOdds : null,
  };
}

/**
 * Um número aproximado, do jeito que se lê em voz alta.
 *
 * Quem lê "≈ 2,0000 por semana" desconfia da precisão que a conta
 * não tem — e ela não tem mesmo: o denominador é um palpite.
 */
export function formatApprox(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }

  if (value >= 10) {
    return Math.round(value).toLocaleString('pt-BR');
  }

  if (value >= 1) {
    return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  }

  return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/**
 * A frase central da tela: "≈ 2 por semana".
 *
 * ####  A UNIDADE MUDA COM A ORDEM DE GRANDEZA  ####
 *
 * "0,3 por semana" e "12 por semana" são os dois ilegíveis — o
 * primeiro vira "1 por mês" e o segundo "2 por dia". A unidade
 * certa é a que põe o número entre 1 e 10, porque é essa a faixa
 * em que uma pessoa consegue julgar se é muito ou pouco.
 */
export function formatRate(perWeek: number): string {
  if (!Number.isFinite(perWeek) || perWeek <= 0) {
    return '—';
  }

  if (perWeek >= 7) {
    return `≈ ${formatApprox(perWeek / 7)} por dia`;
  }

  if (perWeek >= 1) {
    return `≈ ${formatApprox(perWeek)} por semana`;
  }

  // Mês de 30 dias, e não de 4 semanas: é o mês que o admin pensa.
  const perMonth = (perWeek / 7) * 30;

  if (perMonth >= 1) {
    return `≈ ${formatApprox(perMonth)} por mês`;
  }

  return 'menos de 1 por mês';
}

/** "a cada 3 h", "a cada 2 dias". `null` vira travessão em cima. */
export function formatInterval(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) {
    return '—';
  }

  if (hours < 48) {
    return `a cada ${formatApprox(hours)} h`;
  }

  return `a cada ${formatApprox(hours / 24)} dias`;
}

/**
 * A média do que veio, ignorando o que não veio.
 *
 * ####  DIA SEM DADO NÃO É DIA COM ZERO  ####
 *
 * Um `null` na contagem é "o agente não sabe" — a regra pode ter
 * sido criada ontem, ou o servidor passou o dia fora do ar.
 * Somá-lo como zero puxaria a média para baixo e faria a regra
 * parecer mais rara do que é, que é justo o erro que leva alguém
 * a subir a chance sem precisar.
 */
export function averageOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));

  if (known.length === 0) {
    return null;
  }

  return known.reduce((total, value) => total + value, 0) / known.length;
}

/**
 * Quantos contêineres por dia a contagem IMPLICA.
 *
 * É o número que ninguém tinha: com a chance conhecida e os
 * sorteios contados, o denominador sai por divisão. É para isto
 * que o modo de medição existe — ele responde com o servidor no
 * ar o que o estudo só conseguiu estimar (05 §9.6).
 */
export function impliedContainersPerDay(
  rollsPerDay: number | null,
  chance: number | null,
): number | null {
  if (rollsPerDay === null || chance === null || chance <= 0 || !Number.isFinite(rollsPerDay)) {
    return null;
  }

  return rollsPerDay / chance;
}

/**
 * A frase inteira, para a lista — onde não cabe um bloco.
 *
 * Ela é montada aqui, e não no JSX, porque é a que o teste guarda:
 * uma lista que descrevesse a chance de um jeito e o formulário de
 * outro faria o admin desconfiar dos dois.
 */
export function describeChance(input: {
  readonly chance: number | null;
  readonly containersPerDay: number | null;
  readonly dailyCap: number | null;
}): string {
  const oneIn = oneInFromChance(input.chance);

  if (oneIn === null) {
    return '—';
  }

  const projection = projectChance(input);
  const head = `1 em ${formatApprox(oneIn)}`;

  if (projection === null) {
    return head;
  }

  const rate = formatRate(projection.capped ? (projection.cappedPerWeek ?? 0) : projection.perWeek);

  return `${head} · ${rate}`;
}
