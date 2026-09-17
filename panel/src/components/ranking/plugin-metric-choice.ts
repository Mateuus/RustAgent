// ============================================================
//  plugin-metric-choice.ts  -  a métrica que o PLUGIN sabe contar,
//  do lado do painel.
//
//  O ranking "Madeira" (`farm.madeira`, origem plugin) salvava e
//  ficava em zero: nenhum hook alimenta aquela chave. A porta de
//  verdade é `core/src/rankings/plugin-metrics.ts`, que recusa ao
//  salvar; esta cópia é a OFERTA — o aviso aparece enquanto o admin
//  digita, e não só depois do clique.
//
//  Mesma regra das duas cópias do `ranking-choice.ts`: a porta
//  manda, e o teste de cada lado guarda a sua.
// ============================================================

/** As chaves que o `OrigemZAgent` emite sozinho. */
export const FIXED_PLUGIN_METRICS: readonly string[] = [
  'ore.total',
  'ore.sulfur',
  'ore.metal',
  'ore.stone',
  'ore.hqm',
  'pvp.kills',
  'pvp.deaths',
  'pve.kills',
  'pve.deaths',
  'env.deaths',
  'suicides',
  'team.kills',
  'team.deaths',
  'sleeper.kills',
  'sleeper.deaths',
  'trap.kills',
  'trap.deaths',
  'shot.distance',
  'explosive.seq',
];

export const GATHER_METRIC_PREFIX = 'gather.';

/** O que o admin escreve → o shortname do jogo. Só para sugerir. */
const GATHER_WORDS: Readonly<Record<string, string>> = {
  madeira: 'wood',
  lenha: 'wood',
  wood: 'wood',
  pedra: 'stones',
  pedras: 'stones',
  stone: 'stones',
  stones: 'stones',
  enxofre: 'sulfur.ore',
  sulfur: 'sulfur.ore',
  metal: 'metal.ore',
  ferro: 'metal.ore',
  hqm: 'hq.metal.ore',
  tecido: 'cloth',
  pano: 'cloth',
  cloth: 'cloth',
  couro: 'leather',
  leather: 'leather',
  gordura: 'fat.animal',
  osso: 'bone.fragments',
  ossos: 'bone.fragments',
};

export interface PluginMetricCheck {
  /** O plugin conta esta chave? */
  readonly ok: boolean;
  /** A chave que provavelmente se quis dizer. `null` = sem palpite. */
  readonly suggestion: string | null;
}

/** O shortname que uma métrica de coleta pede. `null` = não é uma. */
export function gatherShortnameOf(metric: string): string | null {
  if (!metric.startsWith(GATHER_METRIC_PREFIX)) {
    return null;
  }

  const shortname = metric.slice(GATHER_METRIC_PREFIX.length);

  return /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(shortname) ? shortname : null;
}

export function checkPluginMetric(metric: string): PluginMetricCheck {
  const value = metric.trim();

  if (FIXED_PLUGIN_METRICS.includes(value) || gatherShortnameOf(value) !== null) {
    return { ok: true, suggestion: null };
  }

  const guess = GATHER_WORDS[value.split('.').pop() ?? ''];

  return {
    ok: false,
    suggestion: guess === undefined ? null : `${GATHER_METRIC_PREFIX}${guess}`,
  };
}
