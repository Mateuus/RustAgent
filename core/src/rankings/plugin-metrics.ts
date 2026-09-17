// ============================================================
//  plugin-metrics.ts  -  as métricas que o PLUGIN sabe contar.
//
//  ####  O DEFEITO QUE TROUXE ESTE ARQUIVO  ####
//
//  Em 16/09/2026 o dono criou pelo painel o ranking "Madeira", com
//  métrica `farm.madeira` e origem "Plugin (hook do jogo)". Ligado,
//  visível no menu — e parado em zero depois de uma árvore inteira.
//
//  Nada estava quebrado: o `OrigemZAgent` só emite as chaves que
//  estão escritas no código dele, e `farm.madeira` não é uma delas.
//  O cadastro aceitava qualquer texto com origem "plugin", e o
//  ranking nascia sem ninguém para alimentá-lo.
//
//  Este arquivo é a lista do que o plugin conta, mais a família
//  aberta `gather.<shortname>`: essa o agente PEDE ao plugin a cada
//  rodada (ver `buildStatsFlushCommand`), e é por ela que madeira,
//  tecido e couro viram ranking sem código novo.
//
//  ####  DUAS CÓPIAS, DE PROPÓSITO  ####
//
//  As chaves fixas moram também em `Plugins/OrigemZAgent.cs`
//  (`Metric*`). Mudar uma exige mudar a outra — é o mesmo acordo do
//  `stats-contract.ts`, e o teste daqui guarda a lista.
// ============================================================

/**
 * As chaves que o `OrigemZAgent` emite sozinho.
 *
 * Minério e a matriz da morte são contadores; `shot.distance` é
 * recorde; `explosive.seq` é o custo em enxofre do explosivo.
 */
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

/** A família aberta: `gather.wood`, `gather.cloth`… */
export const GATHER_METRIC_PREFIX = 'gather.';

/**
 * O shortname que uma métrica de coleta pede. `null` = não é uma.
 *
 * O shortname pode ter ponto (`metal.ore`), então é tudo o que vem
 * depois do prefixo — e a régua de métrica da API já garante que
 * não há espaço nem vírgula nele, que são os separadores do
 * comando.
 */
export function gatherShortnameOf(metric: string): string | null {
  if (!metric.startsWith(GATHER_METRIC_PREFIX)) {
    return null;
  }

  const shortname = metric.slice(GATHER_METRIC_PREFIX.length);

  return /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(shortname) ? shortname : null;
}

/**
 * Os recursos que se colhem, pelo nome que o admin escreve.
 *
 * Só para SUGERIR a chave certa quando ele escreve `farm.madeira`.
 * Não é tradução do jogo — é o vocabulário de quem monta ranking.
 */
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

/**
 * Por que esta métrica não serve para um ranking de origem
 * "plugin". `null` = serve.
 *
 * A frase diz a chave certa quando dá para adivinhar — "indicar a
 * chave correta" foi o pedido —, e sempre diz como se faz.
 */
export function whyNotPluginMetric(metric: string): string | null {
  if (FIXED_PLUGIN_METRICS.includes(metric) || gatherShortnameOf(metric) !== null) {
    return null;
  }

  const lastWord = metric.split('.').pop() ?? '';
  const guess = GATHER_WORDS[lastWord];
  const hint =
    guess === undefined
      ? ''
      : ` Para contar ${lastWord}, a métrica é "${GATHER_METRIC_PREFIX}${guess}".`;

  return (
    `O plugin não conta "${metric}": nenhum hook do jogo alimenta essa chave, e o ranking ` +
    `ficaria parado em zero.${hint} Coleta de recurso usa "${GATHER_METRIC_PREFIX}<shortname do ` +
    `item>" (ex.: "${GATHER_METRIC_PREFIX}wood"); as outras chaves do plugin são ` +
    `${FIXED_PLUGIN_METRICS.join(', ')}.`
  );
}

/**
 * Os shortnames que o plugin deve vigiar, a partir do catálogo.
 *
 * Só os rankings LIGADOS: um desligado pediria ao plugin para
 * contar o que nenhuma tela mostra. Ordenados, para que a mesma
 * lista vire sempre o mesmo comando — e o plugin não logue uma
 * "troca" a cada rodada.
 */
export function gatherShortnamesOf(
  rankings: readonly { readonly metric: string; readonly source: string; readonly enabled: boolean }[],
): readonly string[] {
  const names = new Set<string>();

  for (const ranking of rankings) {
    if (!ranking.enabled || ranking.source !== 'plugin') {
      continue;
    }

    const shortname = gatherShortnameOf(ranking.metric);

    if (shortname !== null) {
      names.add(shortname);
    }
  }

  return [...names].sort();
}
