// ============================================================
//  betterloot.ts  -  o vocabulário do arquivo, traduzido para a tela.
//
//  ####  A CHAVE DO ARQUIVO É O CAMINHO INTEIRO DO PREFAB  ####
//
//  Não é `crate_elite`: é
//  `assets/bundled/prefabs/radtown/crate_elite.prefab`. Medido no
//  `LootTables.json` que o plugin gerou no server01 — 111 chaves,
//  todas assim, menos nove que não são caminho nenhum (ver
//  `unwrap/` abaixo).
//
//  Isso colide com o resto do painel, que fala `ShortPrefabName`
//  (`containers.ts`, `loot_rules.containers`). As duas chaves
//  convivem aqui de propósito: a do arquivo é a IDENTIDADE (é ela
//  que vai e volta na API), e a curta é só o que o admin lê e o que
//  casa com os apelidos que já existem.
//
//  ####  111 CHAVES, MAS SÓ 69 SÃO CAIXA  ####
//
//  Medido no arquivo real: 33 são NPC (`scientist*`, e mais o
//  helicóptero e o Bradley) e 9 são chaves sintéticas `unwrap/…`,
//  que são presentes e ovos — o que sai ao ABRIR o item, não o que
//  nasce numa caixa no mapa.
//
//  Jogar os três juntos numa lista só produziria uma tela em que
//  "scientist2.prefab" aparece do lado da caixa de elite, e o admin
//  não pensa em cientista como contêiner. Por isso a natureza vem
//  antes do grupo.
//
//  ####  CINCO NOMES CURTOS APARECEM DUAS VEZES  ####
//
//  Medido: `crate_elite`, `crate_normal`, `crate_normal_2`,
//  `crate_tools` e `vehicle_parts` existem em `radtown/` E em
//  `radtown/underwater_labs/`. São CAIXAS DIFERENTES, com tabelas
//  diferentes.
//
//  Uma tela que mostrasse "Caixa de elite" duas vezes seria pior
//  que inútil: o admin editaria a de baixo d'água achando que
//  mexeu na de radtown, e não haveria erro nenhum para avisar. Por
//  isso o rótulo carrega a origem entre parênteses.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React: é a parte que `panel/test/betterloot.test.ts`
//  alcança. Classificar errado aqui não quebra tela nenhuma — só
//  esconde a caixa que o admin veio procurar.
// ============================================================

import {
  CONTAINER_GROUPS,
  groupOfName,
  labelOfName,
  type ContainerGroupId,
} from '@/components/loot/containers';
import type { BetterLootTableSummary } from '@/lib/api';

/**
 * O que aquela chave é, antes de ser um grupo.
 *
 * `container` é caixa no mapa; `npc` é corpo de cientista (e as
 * caixas de heli/Bradley, que o plugin trata pelo mesmo caminho);
 * `unwrap` é o que sai ao abrir um presente ou um ovo.
 */
export type TableNature = 'container' | 'npc' | 'unwrap';

/** O prefixo que o plugin usa para presente e ovo (`UNWRAP_PREFIX`). */
const UNWRAP_PREFIX = 'unwrap/';

/**
 * Os caminhos que são NPC, e não caixa.
 *
 * `rust.ai/agents` pega os 33 cientistas de uma vez. As duas caixas
 * de evento entram por nome porque moram em `prefabs/npc/` — o
 * plugin as gera junto com os corpos, e o admin as procura entre os
 * eventos, não entre os cientistas. Por isso elas NÃO estão aqui:
 * a lista abaixo é só o que é corpo mesmo.
 */
const NPC_PATH_HINTS: readonly string[] = ['rust.ai/agents', '/npc/scientist', 'scientistnpc'];

/**
 * O que aquela chave é.
 *
 * A ordem importa: `unwrap/` nunca é caminho, então ele é testado
 * antes de qualquer coisa que procure barra.
 */
export function natureOfPrefab(prefab: string): TableNature {
  const key = prefab.trim().toLowerCase();

  if (key.startsWith(UNWRAP_PREFIX)) {
    return 'unwrap';
  }

  for (const hint of NPC_PATH_HINTS) {
    if (key.includes(hint)) {
      return 'npc';
    }
  }

  return 'container';
}

/**
 * O `ShortPrefabName` — o que o resto do painel fala.
 *
 * De `unwrap/xmas.present.large` sai `xmas.present.large`: ali o
 * que vem depois da barra é o SHORTNAME DO ITEM, e não um arquivo.
 */
export function shortPrefabOf(prefab: string): string {
  const key = prefab.trim();

  if (key.toLowerCase().startsWith(UNWRAP_PREFIX)) {
    return key.slice(UNWRAP_PREFIX.length);
  }

  const lastSlash = key.lastIndexOf('/');
  const file = lastSlash === -1 ? key : key.slice(lastSlash + 1);

  return file.toLowerCase().endsWith('.prefab') ? file.slice(0, -'.prefab'.length) : file;
}

/**
 * De onde aquela caixa veio, quando o nome curto não basta.
 *
 * `null` = não precisa de desempate. Só aparece no rótulo quando
 * duas caixas do arquivo dividem o mesmo nome curto — ver o
 * cabeçalho.
 */
function originOf(prefab: string): string | null {
  const key = prefab.trim().toLowerCase();

  if (key.includes('/underwater_labs/')) {
    return 'labs';
  }

  if (key.includes('/dmloot/')) {
    return 'deathmatch';
  }

  if (key.includes('/vehicles/boats/')) {
    return 'barco';
  }

  if (key.includes('/satellitecrash/')) {
    return 'antena';
  }

  if (key.includes('/food cache/')) {
    return 'esconderijo';
  }

  return null;
}

/** Os apelidos que o `containers.ts` não tem porque só o BetterLoot vê. */
const EXTRA_LABELS: Readonly<Record<string, string>> = {
  'crate_ammunition': 'Caixa de munição',
  'crate_food_1': 'Caixa de comida 1',
  'crate_food_2': 'Caixa de comida 2',
  'crate_fuel': 'Caixa de combustível',
  'crate_medical': 'Caixa médica',
  'tech_parts_1': 'Peças eletrônicas 1',
  'tech_parts_2': 'Peças eletrônicas 2',
  'vehicle_parts': 'Peças de veículo',
  'vehicle_parts_advanced': 'Peças de veículo avançadas',
  'food_cache_001': 'Reserva de comida 1',
  'food_cache_002': 'Reserva de comida 2',
  'food_cache_003': 'Reserva de comida 3',
  'food_cache_004': 'Reserva de comida 4',
  'food_cache_005': 'Reserva de comida 5',
  'codelockedhackablecrate_oilrig': 'Caixa travada (plataforma)',
  'codelockedhackablecrate_ghostship': 'Caixa travada (navio fantasma)',
  'ptboat.deepsea': 'Barco de patrulha (mar profundo)',
  'rhib.deepsea': 'Bote (mar profundo)',
  'satellite_crate_1.entity': 'Caixa da antena 1',
  'satellite_crate_2.entity': 'Caixa da antena 2',
  'satellite_crate_3.entity': 'Caixa da antena 3',
  'xmas.present.small': 'Presente pequeno',
  'xmas.present.medium': 'Presente médio',
  'xmas.present.large': 'Presente grande',
  'easter.bronzeegg': 'Ovo de bronze',
  'easter.silveregg': 'Ovo de prata',
  'easter.goldegg': 'Ovo de ouro',
  'halloween.lootbag.small': 'Saco de doces pequeno',
  'halloween.lootbag.medium': 'Saco de doces médio',
  'halloween.lootbag.large': 'Saco de doces grande',
  // Os barris de `autospawn/` usam HÍFEN, e os de `radtown/` usam
  // underscore. São prefabs distintos com o mesmo papel no mapa, e
  // o desempate por origem não os pega — os nomes curtos já são
  // diferentes. Sem apelido, um vira "Barril de estrada 1" e o
  // outro "Loot barrel 1", e ninguém sabe qual editar.
  'loot-barrel-1': 'Barril de estrada 1 (autospawn)',
  'loot-barrel-2': 'Barril de estrada 2 (autospawn)',
  roadsign1: 'Placa de estrada 1',
  roadsign2: 'Placa de estrada 2',
  roadsign3: 'Placa de estrada 3',
  roadsign4: 'Placa de estrada 4',
  roadsign5: 'Placa de estrada 5',
  roadsign6: 'Placa de estrada 6',
  roadsign7: 'Placa de estrada 7',
  roadsign8: 'Placa de estrada 8',
  roadsign9: 'Placa de estrada 9',
  'dm ammo': 'Munição',
  'dm c4': 'C4',
  'dm construction resources': 'Recursos de construção',
  'dm construction tools': 'Ferramentas de construção',
  'dm food': 'Comida',
  'dm medical': 'Remédios',
  'dm res': 'Recursos',
  'dm tier1 lootbox': 'Caixa nível 1',
  'dm tier2 lootbox': 'Caixa nível 2',
  'dm tier3 lootbox': 'Caixa nível 3',
  // Não são cientistas: o `npcLabelOf` abaixo os chamaria assim, e
  // o admin ajustaria o loot dos túneis achando que mexia na
  // radtown.
  npc_tunneldweller: 'Morador do túnel',
  npc_tunneldwellerspawned: 'Morador do túnel (invocado)',
  npc_underwaterdweller: 'Morador submerso',
  // A geração 2 dos cientistas divide o sufixo com a antiga
  // (`scientist2.heavy` e `scientistnpc_heavy`). Sem dizer qual é
  // qual, as duas linhas ficariam com o mesmo rótulo — e o
  // desempate genérico do `rowsOf` colaria o prefab no nome, que
  // funciona mas é feio de ler.
  scientist2: 'Cientista gen2',
  'scientist2.heavy': 'Cientista gen2 · pesado',
  'scientist2.shotgun': 'Cientista gen2 · escopeta',
};

/**
 * O grupo de um prefab que só o BetterLoot vê.
 *
 * ####  "OUTROS" NASCE FECHADO, E ISSO O TORNA UM SUMIÇO  ####
 *
 * Rodando a classificação contra as 111 chaves reais, 19 caíram em
 * "Outros" — as dez caixas de deathmatch, as cinco reservas de
 * comida, as peças de labs e os dois barcos do mar profundo. Todas
 * úteis, todas dentro de uma seção que nasce colapsada.
 *
 * O `containers.ts` não as conhece porque a lista dele veio dos
 * contêineres que o estudo mediu um a um, e essas não estavam lá.
 * Corrigir do lado de lá mexeria no arquivo de outra frente; aqui
 * é onde elas aparecem, e é aqui que elas são endereçadas.
 */
const SECTION_PATH_HINTS: readonly (readonly [string, string])[] = [
  // Deathmatch e labs têm seção própria: são dez e doze caixas de
  // contextos inteiros, e diluí-las nas comuns faria o admin
  // ajustar o loot do mundo aberto e mexer na arena sem perceber.
  ['/dmloot/', 'deathmatch'],
  ['/underwater_labs/', 'labs'],
  ['/vehicles/boats/', 'events'],
  ['/satellitecrash/', 'commonCrates'],
  ['/food cache/', 'commonCrates'],
  ['/roadsigns/', 'barrels'],
];

/**
 * O grupo de um prefab decidido pelo nome inteiro.
 *
 * As duas caixas de peças de veículo são as últimas que sobravam em
 * "Outros" na lista real — e "Outros" nasce fechado, o que faz de
 * um erro de classificação um sumiço.
 */
const SECTION_BY_SHORT_NAME: Readonly<Record<string, string>> = {
  vehicle_parts: 'commonCrates',
  vehicle_parts_advanced: 'commonCrates',
};

/** As seções que o `containers.ts` não tem, na posição em que entram. */
const EXTRA_SECTIONS: readonly {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly collapsed: boolean;
  /** Depois de qual grupo do `containers.ts` ela aparece. */
  readonly after: ContainerGroupId | null;
}[] = [
  {
    id: 'labs',
    label: 'Laboratórios submersos',
    hint: 'As caixas de dentro dos labs. Exigem mergulho, e o loot delas é o de risco alto.',
    collapsed: false,
    after: 'riskCrates',
  },
  {
    id: 'deathmatch',
    label: 'Arena (deathmatch)',
    hint: 'As caixas do modo deathmatch. Nada aqui aparece no mapa normal.',
    collapsed: true,
    after: null,
  },
  {
    id: 'npc',
    label: 'Corpos de NPC',
    hint: 'O que cai do cientista morto. O plugin trata pelo mesmo arquivo, mas não é caixa no mapa.',
    collapsed: true,
    after: null,
  },
  {
    id: 'unwrap',
    label: 'Presentes e ovos',
    hint: 'O que sai ao ABRIR o item na mão — presente de Natal, ovo de Páscoa, saco de doces. Não nasce no mapa.',
    collapsed: true,
    after: null,
  },
];

/**
 * Em que seção aquela chave entra.
 *
 * A natureza vem primeiro (corpo e presente não são caixa), depois
 * as pistas de caminho, e só então o agrupamento por nome que a aba
 * de contêineres ao lado já usa.
 */
export function sectionOfPrefab(prefab: string): string {
  const nature = natureOfPrefab(prefab);

  if (nature !== 'container') {
    return nature;
  }

  const key = prefab.trim().toLowerCase();

  for (const [hint, section] of SECTION_PATH_HINTS) {
    if (key.includes(hint)) {
      return section;
    }
  }

  const shortName = shortPrefabOf(prefab);

  return SECTION_BY_SHORT_NAME[shortName] ?? groupOfName(shortName);
}

/**
 * O nome que o admin lê, com a origem quando ela desempata.
 *
 * `duplicated` vem de quem viu a lista inteira: só quem conhece as
 * 111 chaves sabe que este nome curto se repete. Passar `false`
 * quando ele se repete produziria dois rótulos idênticos — ver o
 * cabeçalho.
 */
export function labelOfPrefab(prefab: string, duplicated = false): string {
  const short = shortPrefabOf(prefab);
  const base = EXTRA_LABELS[short] ?? npcLabelOf(short) ?? labelOfName(short);

  if (!duplicated) {
    return base;
  }

  const origin = originOf(prefab);

  return origin === null ? base : `${base} (${origin})`;
}

/**
 * O nome de um corpo de NPC, sem apelidar 31 cientistas um a um.
 *
 * `scientistnpc_cargo_turret_any` vira "Cientista · cargo turret
 * any". Continua técnico, e é a intenção: são 31 variantes que só
 * quem conhece o jogo distingue, e o nome curto fica ao lado. O que
 * o prefixo repetido fazia era gastar a largura da coluna dizendo
 * "cientista" trinta e uma vezes.
 */
function npcLabelOf(shortName: string): string | null {
  const match = /^(?:scientistnpc|scientist2|scientist)[_.]?(.*)$/.exec(shortName);

  if (match === null) {
    return null;
  }

  const rest = (match[1] ?? '').replace(/[_.]+/g, ' ').trim();

  return rest === '' ? 'Cientista' : `Cientista · ${rest}`;
}

/** Quais nomes curtos aparecem mais de uma vez na lista inteira. */
export function duplicatedShortNames(
  tables: readonly BetterLootTableSummary[],
): ReadonlySet<string> {
  const seen = new Map<string, number>();

  for (const table of tables) {
    const short = shortPrefabOf(table.prefab);

    seen.set(short, (seen.get(short) ?? 0) + 1);
  }

  const duplicated = new Set<string>();

  for (const [short, count] of seen) {
    if (count > 1) {
      duplicated.add(short);
    }
  }

  return duplicated;
}

/** Uma linha da coluna da esquerda, já com tudo o que ela mostra. */
export interface TableRow {
  readonly table: BetterLootTableSummary;
  readonly nature: TableNature;
  /** O nome amigável, já desempatado. */
  readonly label: string;
  readonly shortName: string;
  /** Em qual seção da lista ela cai. */
  readonly section: string;
}

export function rowOf(table: BetterLootTableSummary, duplicated: ReadonlySet<string>): TableRow {
  const shortName = shortPrefabOf(table.prefab);

  return {
    table,
    nature: natureOfPrefab(table.prefab),
    label: labelOfPrefab(table.prefab, duplicated.has(shortName)),
    shortName,
    section: sectionOfPrefab(table.prefab),
  };
}

/**
 * As linhas da lista, com os rótulos garantidamente distintos.
 *
 * ####  DUAS CAMADAS DE DESEMPATE, E A SEGUNDA É A REDE  ####
 *
 * A primeira usa a ORIGEM ("Caixa de elite (labs)"), que é o que o
 * admin entende. Ela resolve os cinco nomes curtos repetidos do
 * arquivo real — mas não resolve tudo: `scientist2.heavy` e
 * `scientistnpc_heavy` têm nomes curtos DIFERENTES e caem no mesmo
 * rótulo "Cientista · heavy".
 *
 * Aí entra a segunda, que acrescenta o nome curto. Ela é feia de
 * propósito: só aparece quando a primeira falhou, e duas linhas
 * idênticas numa lista de edição são pior que um rótulo feio — o
 * admin edita uma achando que é a outra, e nada avisa.
 */
export function rowsOf(tables: readonly BetterLootTableSummary[]): readonly TableRow[] {
  const duplicated = duplicatedShortNames(tables);
  const rows = tables.map((table) => rowOf(table, duplicated));

  const byLabel = new Map<string, number>();

  for (const row of rows) {
    byLabel.set(row.label, (byLabel.get(row.label) ?? 0) + 1);
  }

  return rows.map((row) =>
    (byLabel.get(row.label) ?? 0) > 1 ? { ...row, label: `${row.label} [${row.shortName}]` } : row,
  );
}

/** Uma seção da coluna da esquerda. */
export interface TableSection {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /**
   * Nasce fechada?
   *
   * Corpos de NPC, presentes e arena somam 51 das 111 chaves. Abertas,
   * elas afogam a caixa de elite; filtradas, sumiriam de vez — e
   * decidir pelo admin que ele nunca vai querer mexer no loot de
   * cientista é decidir demais. Fechada é o meio-termo: quem procura
   * abre, quem não procura nunca vê.
   */
  readonly collapsed: boolean;
  readonly rows: readonly TableRow[];
}

/**
 * As 111 chaves em seções, na ordem da tela.
 *
 * Os contêineres primeiro, pelos grupos que o `containers.ts` já
 * define — e que a aba de regras ao lado usa. Duas telas com dois
 * agrupamentos seria o mesmo mapa desenhado de dois jeitos, e é
 * assim que se perde a caixa.
 *
 * As seções que só o BetterLoot precisa entram onde fazem sentido:
 * labs logo depois das caixas de risco, o resto no fim.
 */
export function sectionsOf(tables: readonly BetterLootTableSummary[]): readonly TableSection[] {
  const rows = rowsOf(tables);

  const ordered: { id: string; label: string; hint: string; collapsed: boolean }[] = [];

  for (const group of CONTAINER_GROUPS) {
    ordered.push({
      id: group.id,
      label: group.label,
      hint: group.hint,
      collapsed: group.collapsed,
    });

    for (const extra of EXTRA_SECTIONS) {
      if (extra.after === group.id) {
        ordered.push(extra);
      }
    }
  }

  for (const extra of EXTRA_SECTIONS) {
    if (extra.after === null) {
      ordered.push(extra);
    }
  }

  const sections: TableSection[] = [];

  for (const candidate of ordered) {
    const inSection = rows
      .filter((row) => row.section === candidate.id)
      .sort((left, right) => left.label.localeCompare(right.label, 'pt-BR'));

    if (inSection.length > 0) {
      sections.push({ ...candidate, rows: inSection });
    }
  }

  return sections;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** A busca da coluna da esquerda: casa apelido, nome curto e caminho. */
export function matchesRow(row: TableRow, query: string): boolean {
  const needle = normalize(query.trim());

  if (needle === '') {
    return true;
  }

  return normalize([row.label, row.shortName, row.table.prefab].join(' ')).includes(needle);
}

/**
 * A chave de uma entrada nova, com o sufixo `{n}` quando precisa.
 *
 * ####  O SUFIXO É O QUE DEIXA O MESMO ITEM ENTRAR DUAS VEZES  ####
 *
 * O `Ungrouped Items` é um dicionário chaveado por shortname, e o
 * plugin tira `{\d+}` antes de resolver o item
 * (`UniqueTagREGEX`, BetterLoot.cs:416). Sem o sufixo, um catálogo
 * com dois troféus de skins diferentes teria de escolher um só —
 * a segunda entrada sobrescreveria a primeira em silêncio.
 *
 * O admin NUNCA vê isto: para ele são duas linhas com dois ícones.
 */
export function nextEntryKey(shortname: string, taken: readonly string[]): string {
  const base = shortname.trim();

  if (base === '') {
    return base;
  }

  const used = new Set(taken);

  if (!used.has(base)) {
    return base;
  }

  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${base}{${String(suffix)}}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return base;
}
