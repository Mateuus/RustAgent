// ============================================================
//  containers.ts  -  o eixo da tela: o container.
//
//  ####  O ADMIN PENSA "CAIXA DE ELITE", NUNCA "crate_elite"  ####
//
//  E muito menos "LootSpawn.RadTownElite". O Docs/CustomItem/05
//  §8.2 chegou nisso pela medição: são 105 containers contra 650
//  tabelas alcançáveis, e navegar por tabela ofereceria uma lista
//  seis vezes maior, cheia de nomes que ninguém ouviu.
//
//  Então a navegação é por container, e o container aparece com o
//  nome que o admin reconhece — com o `ShortPrefabName` ao lado,
//  em fonte de código. Os dois juntos, e não um dos dois: o nome
//  amigável é NOSSO (pode estar errado, e o prefab desmente), e o
//  prefab é o que o plugin casa de verdade.
//
//  ####  O AGRUPAMENTO É DO PAINEL ENQUANTO A API NÃO O TROUXER  ####
//
//  `GET /api/loot/containers` pode devolver `group` e `label`
//  preenchidos; quando devolve, eles mandam. Enquanto não
//  devolvem, quem agrupa é este arquivo — pelo nome do prefab,
//  com a tabela de grupos do 05 §8.2. Uma tela sem agrupamento
//  seria uma lista de 105 nomes crus, que é exatamente o que o
//  dono pediu para não acontecer.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React: é a parte que `panel/test/loot-containers.test.ts`
//  alcança. Classificar errado não quebra tela nenhuma — só
//  esconde a caixa de elite dentro de "Outros", onde ninguém a
//  procura.
// ============================================================

import type { LootContainerInfo } from '@/lib/api';

export type ContainerGroupId =
  | 'barrels'
  | 'commonCrates'
  | 'riskCrates'
  | 'events'
  | 'bodies'
  | 'missions'
  | 'seasonal'
  | 'other';

export interface ContainerGroup {
  readonly id: ContainerGroupId;
  readonly label: string;
  readonly hint: string;
  /**
   * Nasce fechado.
   *
   * É a recomendação do 05 §12 Q7: mostrar todos os containers,
   * agrupados, com os raros colapsados. Esconder os exóticos da
   * lista seria decidir pelo admin que ele nunca vai querer o
   * `tacklebox`; deixá-los abertos afogaria a caixa de elite.
   */
  readonly collapsed: boolean;
}

/** A ordem é a da tela — do que se mexe todo dia ao que quase nunca. */
export const CONTAINER_GROUPS: readonly ContainerGroup[] = [
  {
    id: 'riskCrates',
    label: 'Caixas de risco',
    hint: 'Radtown médio e alto: é onde o jogador paga com risco pelo que pega.',
    collapsed: false,
  },
  {
    id: 'events',
    label: 'Eventos',
    hint: 'Helicóptero, Bradley, airdrop e a caixa travada. Poucas por dia, e todo mundo vê quem pegou.',
    collapsed: false,
  },
  {
    id: 'commonCrates',
    label: 'Caixas comuns',
    hint: 'Radtown baixo e praia: muitas, fáceis, de rota.',
    collapsed: false,
  },
  {
    id: 'barrels',
    label: 'Barris e lixo',
    hint: 'Mundo aberto. São os mais numerosos do mapa — o que cai aqui vira farm de estrada.',
    collapsed: false,
  },
  {
    id: 'bodies',
    label: 'Corpos e mochilas',
    hint: 'O que fica no chão depois que alguém morre.',
    collapsed: true,
  },
  {
    id: 'missions',
    label: 'Missão e tutorial',
    hint: 'Esconderijos de missão e as caixas do tutorial.',
    collapsed: true,
  },
  {
    id: 'seasonal',
    label: 'Sazonais',
    hint: 'Só existem no mapa enquanto o evento do jogo está ligado.',
    collapsed: true,
  },
  {
    id: 'other',
    label: 'Outros',
    hint: 'O que o painel não soube classificar. O prefab continua valendo — o que falta é o apelido.',
    collapsed: true,
  },
];

/**
 * Nome amigável por prefab.
 *
 * ####  ESTES APELIDOS SÃO NOSSOS, E PODEM ESTAR ERRADOS  ####
 *
 * Eles vieram do vocabulário que os admins de Rust já usam, e não
 * de leitura do jogo. É por isso que a tela mostra SEMPRE o
 * `ShortPrefabName` junto: quando o apelido estiver errado, quem
 * conhece o prefab vê o erro na hora, em vez de escolher a caixa
 * trocada e descobrir no wipe seguinte.
 */
const CONTAINER_LABELS: Readonly<Record<string, string>> = {
  loot_barrel_1: 'Barril de estrada 1',
  loot_barrel_2: 'Barril de estrada 2',
  oil_barrel: 'Barril de óleo',
  loot_trash: 'Lixo',
  'trash-pile-1': 'Pilha de lixo',
  minecart: 'Vagonete',
  crate_basic: 'Caixa comum',
  crate_basic_jungle: 'Caixa comum (selva)',
  crate_shore: 'Caixa de praia',
  foodbox: 'Caixa de comida',
  crate_tools: 'Caixa de ferramentas',
  crate_mine: 'Caixa de mina',
  crate_normal: 'Caixa militar',
  crate_normal_2: 'Caixa de madeira',
  crate_normal_2_food: 'Caixa de madeira (comida)',
  crate_normal_2_medical: 'Caixa de madeira (médica)',
  crate_elite: 'Caixa de elite',
  crate_underwater_basic: 'Caixa submersa comum',
  crate_underwater_advanced: 'Caixa submersa avançada',
  crate_cannons: 'Caixa de canhões',
  heli_crate: 'Caixa do helicóptero',
  bradley_crate: 'Caixa do Bradley',
  supply_drop: 'Airdrop',
  codelockedhackablecrate: 'Caixa travada (hackeável)',
  satellite_crate_1: 'Caixa da antena 1',
  satellite_crate_2: 'Caixa da antena 2',
  satellite_crate_3: 'Caixa da antena 3',
  missionstash: 'Esconderijo de missão',
  tacklebox: 'Caixa de pesca',
  crate_elite_tutorial: 'Caixa de elite (tutorial)',
  'loot-barrel-tutorial': 'Barril (tutorial)',
  giftbox_loot: 'Caixa de presente',
  stocking_large_deployed: 'Meia de Natal (grande)',
  xmastunnellootbox: 'Caixa do túnel de Natal',
};

/** Prefabs cujo grupo é decidido pelo nome inteiro, e não por pedaço. */
const CONTAINER_GROUP_BY_NAME: Readonly<Record<string, ContainerGroupId>> = {
  loot_barrel_1: 'barrels',
  loot_barrel_2: 'barrels',
  oil_barrel: 'barrels',
  loot_trash: 'barrels',
  'trash-pile-1': 'barrels',
  minecart: 'barrels',
  crate_basic: 'commonCrates',
  crate_basic_jungle: 'commonCrates',
  crate_shore: 'commonCrates',
  foodbox: 'commonCrates',
  crate_tools: 'commonCrates',
  crate_mine: 'commonCrates',
  crate_normal: 'riskCrates',
  crate_normal_2: 'riskCrates',
  crate_normal_2_food: 'riskCrates',
  crate_normal_2_medical: 'riskCrates',
  crate_elite: 'riskCrates',
  crate_underwater_basic: 'riskCrates',
  crate_underwater_advanced: 'riskCrates',
  crate_cannons: 'riskCrates',
  heli_crate: 'events',
  bradley_crate: 'events',
  supply_drop: 'events',
  codelockedhackablecrate: 'events',
  satellite_crate_1: 'events',
  satellite_crate_2: 'events',
  satellite_crate_3: 'events',
  missionstash: 'missions',
  tacklebox: 'missions',
};

/**
 * Pedaços de nome que decidem o grupo do que não está na tabela.
 *
 * A ordem importa: `crate_elite_tutorial` é tutorial ANTES de ser
 * caixa de elite, e um servidor que quisesse premiar o tutorial
 * escolheria o prefab pelo nome inteiro de qualquer jeito.
 */
const GROUP_HINTS: readonly (readonly [string, ContainerGroupId])[] = [
  ['tutorial', 'missions'],
  ['mission', 'missions'],
  ['xmas', 'seasonal'],
  ['stocking', 'seasonal'],
  ['giftbox', 'seasonal'],
  ['halloween', 'seasonal'],
  ['easter', 'seasonal'],
  ['pumpkin', 'seasonal'],
  ['corpse', 'bodies'],
  ['body', 'bodies'],
  ['backpack', 'bodies'],
  ['heli', 'events'],
  ['bradley', 'events'],
  ['supply', 'events'],
  ['hackable', 'events'],
  ['elite', 'riskCrates'],
  ['underwater', 'riskCrates'],
  ['barrel', 'barrels'],
  ['trash', 'barrels'],
  ['roadsign', 'barrels'],
  ['junk', 'barrels'],
  ['crate', 'commonCrates'],
  ['box', 'commonCrates'],
];

function normalize(text: string): string {
  // O intervalo vai ESCAPADO, como no `item-choice.ts`: U+0300 a
  // U+036F são os acentos que o NFD solta ao lado da letra, e
  // escrevê-los literalmente deixaria um acento solto no
  // código-fonte — invisível na revisão e apagável por qualquer
  // editor.
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** O grupo de um prefab, quando o agente não disse qual é. */
export function groupOfName(name: string): ContainerGroupId {
  const key = name.trim();
  const exact = CONTAINER_GROUP_BY_NAME[key];

  if (exact !== undefined) {
    return exact;
  }

  const needle = normalize(key);

  for (const [hint, group] of GROUP_HINTS) {
    if (needle.includes(hint)) {
      return group;
    }
  }

  return 'other';
}

/**
 * O grupo de um container, com o do agente na frente.
 *
 * Se o agente mandar um grupo que o painel conhece — pelo id ou
 * pelo rótulo —, é ele que vale: quem tem o dump do jogo sabe
 * mais que a nossa tabela de apelidos. Um grupo desconhecido cai
 * na heurística do nome em vez de virar uma seção órfã.
 */
export function groupOf(container: LootContainerInfo): ContainerGroupId {
  if (container.group !== null && container.group.trim() !== '') {
    const needle = normalize(container.group);
    const known = CONTAINER_GROUPS.find(
      (group) => normalize(group.id) === needle || normalize(group.label) === needle,
    );

    if (known !== undefined) {
      return known.id;
    }
  }

  return groupOfName(container.name);
}

/**
 * O apelido de um prefab desconhecido.
 *
 * `crate_ammunition_military` vira "Crate ammunition military" —
 * feio, mas legível, e o prefab continua ao lado. Melhor que
 * mostrar só o prefab cru, que é o que o dono pediu para evitar.
 */
function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (words === '') {
    return name;
  }

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** O nome que o admin lê. O do agente manda; depois o nosso; depois o prefab. */
export function labelOf(container: LootContainerInfo): string {
  if (container.label !== null && container.label.trim() !== '') {
    return container.label;
  }

  return CONTAINER_LABELS[container.name.trim()] ?? humanize(container.name);
}

/** O mesmo, para quem só tem o prefab guardado na regra. */
export function labelOfName(name: string): string {
  return CONTAINER_LABELS[name.trim()] ?? humanize(name);
}

export interface ContainerSection {
  readonly group: ContainerGroup;
  readonly containers: readonly LootContainerInfo[];
}

/**
 * Os containers em seções, na ordem da tela.
 *
 * Grupo sem nenhum container não vira seção vazia: uma tela com
 * sete títulos e três listas parece quebrada.
 */
export function groupContainers(
  containers: readonly LootContainerInfo[],
): readonly ContainerSection[] {
  const sections: ContainerSection[] = [];

  for (const group of CONTAINER_GROUPS) {
    const inGroup = containers
      .filter((container) => groupOf(container) === group.id)
      .slice()
      .sort((left, right) => labelOf(left).localeCompare(labelOf(right), 'pt-BR'));

    if (inGroup.length > 0) {
      sections.push({ group, containers: inGroup });
    }
  }

  return sections;
}

/** A busca do seletor: casa apelido, prefab e nome do grupo. */
export function matchesContainer(container: LootContainerInfo, query: string): boolean {
  const needle = normalize(query.trim());

  if (needle === '') {
    return true;
  }

  const group = CONTAINER_GROUPS.find((entry) => entry.id === groupOf(container));
  const haystack = normalize(
    [container.name, labelOf(container), group?.label ?? ''].join(' '),
  );

  return haystack.includes(needle);
}

/**
 * A lista que a tela usa quando o agente não responde qual é.
 *
 * ####  ELA É DO PAINEL, E A TELA DIZ ISSO EM VOZ ALTA  ####
 *
 * São os containers nomeados no 05 §8.2 e no 04 §6.4 — os que o
 * estudo mediu um a um. NÃO são os 105 do build: se o plugin
 * aceitar um prefab que não está aqui, ele não aparece, e a única
 * forma de acrescentá-lo é a rota `/api/loot/containers` passar a
 * responder.
 *
 * Existe porque uma tela de cadastro sem lista de containers não é
 * uma tela degradada: é uma tela inútil. Com a lista local o admin
 * cadastra a regra da caixa de elite hoje, e o aviso em cima diz
 * de onde veio a lista.
 */
export const FALLBACK_CONTAINERS: readonly LootContainerInfo[] = Object.keys(
  CONTAINER_GROUP_BY_NAME,
).map((name) => ({
  name,
  label: null,
  group: null,
  // Nenhum refresh é afirmado aqui: 71 dos 105 têm um, mas qual é
  // o de cada prefab é coisa que só o agente sabe. Inventar
  // "3600" seria dizer ao admin que a regra volta a valer de hora
  // em hora sem ter medido isso.
  refreshSeconds: null,
}));
