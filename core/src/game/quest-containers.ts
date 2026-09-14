// ============================================================
//  quest-containers.ts  -  o que "saquear caixas" alcança.
//
//  ####  O OBJETIVO `loot` CONTA ITEM; ESTE CONTA CAIXA  ####
//
//  São perguntas diferentes, e por isso são objetivos diferentes.
//  `loot` é "pegue 200 de scrap, de onde quiser" — o alvo dele é um
//  shortname de ITEM. `container` é "saqueie 20 barris" — o alvo é
//  o CONTÊINER, e o que vem dentro não importa.
//
//  Pedido do dono em 14/09/2026: "os barris e contêineres
//  encontrados nas estradas não aparecem como opções de alvo" —
//  porque não havia como pedi-los: o editor só oferecia item.
//
//  ####  O SELETOR É PREFAB OU CATEGORIA, E A CATEGORIA É VIVA  ####
//
//  Um objetivo guarda uma LISTA de seletores, e cada um é uma de
//  duas coisas:
//
//    `crate_elite`   um `ShortPrefabName`, exatamente aquele
//    `@barrel`       uma categoria — todo barril do catálogo
//
//  A categoria não é gravada expandida de propósito. Um barril novo
//  do Rust entra no catálogo e as missões de "qualquer barril" já
//  cadastradas passam a alcançá-lo, sem ninguém reeditar nada — a
//  mesma razão pela qual o `CREATURE_ALIASES` mora no agente e não
//  no C#.
//
//  ####  A FAMÍLIA SAI DO GRUPO, MENOS ONDE O GRUPO MENTE  ####
//
//  O catálogo já agrupa por como o admin pensa, e "Barris e lixo"
//  é o único grupo que mistura duas coisas: os cinco barris de
//  verdade e o entulho de estrada (lixo, placa, vagonete). A lista
//  de exceção abaixo é essa diferença, e ela é curta porque é a
//  única.
//
//  Ver `game/loot-containers.ts` para a proveniência de cada
//  prefab, e Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §5.8.
// ============================================================

import { LOOT_CONTAINERS } from './loot-containers.js';

/**
 * O que um contêiner é, para quem cadastra a missão.
 *
 *   barrel  se quebra para saquear
 *   crate   se abre para saquear
 *   debris  nem um nem outro: lixo, placa, vagonete
 *
 * `debris` existe para não mentir. Uma placa de estrada não é uma
 * caixa, e enfiá-la em "qualquer caixa" faria a missão contar o que
 * o jogador não reconhece como caixa nenhuma.
 */
export type QuestContainerFamily = 'barrel' | 'crate' | 'debris';

/**
 * O grupo do catálogo que mistura barril com entulho.
 *
 * É o único — os outros seis são todos de caixa.
 */
const BARREL_GROUP = 'Barris e lixo';

/**
 * O que está no grupo dos barris SEM ser barril.
 *
 * Um prefab novo naquele grupo nasce como barril, que é o caso
 * comum; o entulho é o que precisa ser dito.
 */
const DEBRIS: ReadonlySet<string> = new Set([
  'loot_trash',
  'trash-pile-1',
  'minecart',
  'roadsign1',
  'roadsign2',
  'roadsign3',
  'roadsign4',
  'roadsign5',
  'roadsign6',
  'roadsign7',
  'roadsign8',
  'roadsign9',
]);

/** A que família um prefab do catálogo pertence. */
export function containerFamilyOf(prefab: string): QuestContainerFamily {
  const entry = LOOT_CONTAINERS.find((item) => item.prefab === prefab);

  if (entry === undefined || entry.group !== BARREL_GROUP) {
    // ####  O QUE NÃO ESTÁ NO CATÁLOGO É CAIXA  ####
    //
    // O cadastro aceita prefab digitado à mão (ver o cabeçalho de
    // `loot-containers.ts`: o catálogo OFERECE, não proíbe), e um
    // prefab de fora não tem grupo para consultar. "Caixa" é o
    // palpite que erra menos — e ele só afeta quem usa categoria,
    // porque o prefab digitado casa por si mesmo.
    return 'crate';
  }

  return DEBRIS.has(prefab) ? 'debris' : 'barrel';
}

/** Uma categoria, como o editor a oferece. */
export interface QuestContainerCategory {
  /** O seletor gravado no objetivo. Começa com `@`. */
  readonly id: string;
  readonly label: string;
  /**
   * O nome no PLURAL, para a frase do objetivo.
   *
   * ####  "SAQUEAR 20 QUALQUER BARRIL" NÃO SE LÊ  ####
   *
   * O rótulo é escrito para o editor, onde ele responde "o que este
   * botão seleciona?". Na tela do jogo a frase é outra — "Saquear 20
   * barris" —, e enfiar o rótulo do editor ali produzia uma linha
   * que ninguém escreveria à mão.
   */
  readonly plural: string;
  /** O que ela alcança, em uma frase. */
  readonly hint: string;
  /** As famílias que ela cobre. */
  readonly families: readonly QuestContainerFamily[];
}

/**
 * As três categorias do pedido, e nada além.
 *
 * Uma por grupo do catálogo seria tentador e seria pior: "qualquer
 * caixa de evento" é uma missão que fecha quando o helicóptero cai,
 * e não quando o jogador joga. As três abaixo são as que descrevem
 * uma ROTA, que é o que uma missão de saque pede.
 */
export const QUEST_CONTAINER_CATEGORIES: readonly QuestContainerCategory[] = [
  {
    id: '@barrel',
    label: 'Qualquer barril',
    plural: 'barris',
    hint: 'Os barris de estrada e o de óleo — os que se quebram.',
    families: ['barrel'],
  },
  {
    id: '@crate',
    label: 'Qualquer caixa',
    plural: 'caixas',
    hint: 'Toda caixa do catálogo, da básica à de elite — as que se abrem.',
    families: ['crate'],
  },
  {
    id: '@any',
    label: 'Qualquer contêiner de loot',
    plural: 'contêineres',
    hint: 'Barril, caixa e o entulho de estrada. É a rota inteira.',
    families: ['barrel', 'crate', 'debris'],
  },
];

/** `true` se o seletor é categoria, e não prefab. */
export function isContainerCategory(selector: string): boolean {
  return selector.startsWith('@');
}

/**
 * A régua de um seletor.
 *
 * Ou uma das categorias conhecidas, ou um `ShortPrefabName`. A
 * segunda metade é a mesma do `CONTAINER_PREFAB` de
 * `loot-containers.ts`, e pela mesma razão: o nome viaja num
 * comando de console do Rust, onde espaço separa argumentos.
 */
export function isValidContainerSelector(selector: string): boolean {
  if (isContainerCategory(selector)) {
    return QUEST_CONTAINER_CATEGORIES.some((category) => category.id === selector);
  }

  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(selector);
}

/**
 * Os prefabs que uma categoria alcança HOJE.
 *
 * Vazio para um `@` desconhecido — quem chama trata isso como
 * "nenhum prefab", e não como erro: o zod já recusou o cadastro, e
 * uma linha velha no banco não pode derrubar a rodada.
 */
export function containersOfCategory(categoryId: string): readonly string[] {
  const category = QUEST_CONTAINER_CATEGORIES.find((item) => item.id === categoryId);

  if (category === undefined) {
    return [];
  }

  return LOOT_CONTAINERS.filter((entry) =>
    category.families.includes(containerFamilyOf(entry.prefab)),
  ).map((entry) => entry.prefab);
}

/**
 * Os seletores viram a lista de prefabs que o plugin observa.
 *
 * ####  ELA SÓ SERVE AO CATÁLOGO DO `watch`  ####
 *
 * O `assign` manda o seletor CRU — é o plugin que resolve `@barrel`
 * contra os conjuntos que desceram no `watch`. Expandir no assign
 * mandaria 65 prefabs por objetivo por jogador, num comando de
 * console; expandir aqui manda a lista uma vez, por servidor.
 *
 * Ordenada e sem repetição: o catálogo é comparado por string
 * (`#sent`, no coletor), e duas ordens diferentes do mesmo conjunto
 * fariam o `watch` sair de novo a cada rodada.
 */
export function expandContainerSelectors(selectors: readonly string[]): readonly string[] {
  const prefabs = new Set<string>();

  for (const selector of selectors) {
    if (isContainerCategory(selector)) {
      for (const prefab of containersOfCategory(selector)) {
        prefabs.add(prefab);
      }

      continue;
    }

    prefabs.add(selector);
  }

  return [...prefabs].sort();
}

/**
 * Os conjuntos que descem no `watch`, das categorias EM USO.
 *
 * Só as usadas: mandar as três sempre custaria ~1,5 KB de comando
 * a um servidor que não tem missão de saque nenhuma.
 */
export function containerSetsOf(
  selectors: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const sets: Record<string, readonly string[]> = {};

  for (const selector of selectors) {
    if (isContainerCategory(selector) && sets[selector] === undefined) {
      sets[selector] = containersOfCategory(selector);
    }
  }

  return sets;
}

/** O nome que uma pessoa lê, de um prefab. */
export function containerLabelOf(prefab: string): string {
  return LOOT_CONTAINERS.find((entry) => entry.prefab === prefab)?.label ?? prefab;
}

/**
 * A lista de alvos vira a frase do objetivo.
 *
 * ####  TRÊS NOMES CABEM NUMA LINHA; DEZ NÃO  ####
 *
 * "Saquear 20 Barril (grande), Caixa militar ou Caixa de elite" se
 * lê. Com dez alvos a frase vira um parágrafo dentro de um botão, e
 * o número — que é o que o jogador procura — some no meio. A partir
 * do quarto, o texto passa a contar QUANTOS tipos são, e a lista
 * inteira continua no editor, onde ela foi escolhida.
 *
 * O `label` próprio do objetivo sobrescreve isto: é a escotilha
 * para a missão que quer dizer "Limpeza da Estrada" e pronto.
 */
export function describeContainerSelectors(selectors: readonly string[]): string {
  if (selectors.length === 0) {
    return 'contêineres';
  }

  const category = QUEST_CONTAINER_CATEGORIES.find((item) => item.id === selectors[0]);

  if (selectors.length === 1 && category !== undefined) {
    return category.plural;
  }

  const names = selectors.map((selector) => {
    const known = QUEST_CONTAINER_CATEGORIES.find((item) => item.id === selector);

    return known === undefined ? containerLabelOf(selector) : known.plural;
  });

  if (names.length > 3) {
    return `${names.length} tipos de contêiner`;
  }

  const last = names[names.length - 1] ?? 'contêineres';

  return names.length === 1 ? last : `${names.slice(0, -1).join(', ')} ou ${last}`;
}

/**
 * O catálogo do editor: as categorias e os contêineres, agrupados.
 *
 * Montado aqui, e não no painel, porque o painel não pode ter uma
 * segunda opinião sobre o que é barril — se tivesse, a tela
 * ofereceria "qualquer barril" contando uma coisa e o agente
 * contaria outra.
 */
export function questContainerCatalog(): {
  readonly categories: readonly QuestContainerCategory[];
  readonly containers: readonly {
    readonly prefab: string;
    readonly label: string;
    readonly group: string;
    readonly family: QuestContainerFamily;
  }[];
} {
  return {
    categories: QUEST_CONTAINER_CATEGORIES,
    containers: LOOT_CONTAINERS.map((entry) => ({
      prefab: entry.prefab,
      label: entry.label,
      group: entry.group,
      family: containerFamilyOf(entry.prefab),
    })),
  };
}
