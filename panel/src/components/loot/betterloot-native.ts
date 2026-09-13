// ============================================================
//  betterloot-native.ts  -  o que é do JOGO e o que é da casa.
//
//  ####  O ARQUIVO NÃO GUARDA ESSA DIFERENÇA  ####
//
//  `Ungrouped Items` é um dicionário só. O item que o BetterLoot
//  copiou do jogo no primeiro boot e o item que o admin pôs ontem
//  ficam lado a lado, sem marca nenhuma que os separe.
//
//  A separação que a tela mostra é CALCULADA aqui, cruzando a
//  tabela com a lista que o servidor respondeu ao vivo
//  (`origemz.loot.native`). Ela não é guardada em lugar nenhum — e
//  isso é uma escolha: uma marca gravada envelheceria no primeiro
//  update do Rust que mexesse no loot de uma caixa, e passaria a
//  mentir sem nenhum sintoma.
//
//  ####  O CASAMENTO É POR CHAVE EXATA  ####
//
//  E isso importa mais do que parece. A chave nativa nunca tem
//  sufixo: o gerador do plugin escreve `rifle.ak`. Quando alguém
//  põe uma segunda AK com skin própria, ela nasce `rifle.ak{1}`.
//
//  Casar pelo shortname base marcaria as DUAS como "do jogo" — e o
//  troféu da casa apareceria como item original do Rust, que é
//  exatamente o contrário do que ele é. Casando pela chave, a
//  primeira é do jogo e a segunda é da casa.
//
//  O sufixo `.blueprint` é o oposto: ele faz PARTE da chave dos
//  dois lados, porque o jogo distingue o item do projeto dele.
// ============================================================

import { NO_SKIN } from '@/components/item-choice';
import type {
  BetterLootEntry,
  BetterLootGuaranteedEntry,
  BetterLootNativeItem,
  BetterLootNativeTable,
  BetterLootTable,
} from '@/lib/api';

/** De onde veio aquela linha da caixa. */
export type EntryOrigin =
  /** Está na tabela e o jogo também a põe ali. */
  | 'game'
  /** Está na tabela e o jogo não põe: alguém acrescentou. */
  | 'added'
  /**
   * Não dá para dizer.
   *
   * É o estado com o servidor parado — e ele é um terceiro estado
   * de verdade, não um `false` disfarçado. Pintar tudo como "seu"
   * quando ninguém respondeu faria a tela afirmar o que não sabe.
   */
  | 'unknown';

/** Um item do jogo que a tabela não tem. */
export interface MissingNativeItem extends BetterLootNativeItem {
  /** Já existe garantido na caixa com essa chave? */
  readonly guaranteed: boolean;
}

/** O cruzamento entre a caixa aberta e o loot do jogo. */
export interface NativeComparison {
  /** `null` = ninguém respondeu ainda (servidor parado, ou plugin velho). */
  readonly native: BetterLootNativeTable | null;
  /** A origem de cada entrada, por CHAVE. */
  readonly originOf: (key: string) => EntryOrigin;
  /** Quantas entradas da caixa o jogo põe ali. */
  readonly fromGame: number;
  /** Quantas foram acrescentadas. */
  readonly added: number;
  /** O que o jogo põe e a caixa não tem. É o que o "trazer" traz. */
  readonly missing: readonly MissingNativeItem[];
}

/**
 * Cruza a caixa ABERTA (o rascunho, não o disco) com o loot do jogo.
 *
 * O rascunho de propósito: o admin que acabou de acrescentar um
 * item precisa vê-lo marcado como seu na hora, sem esperar
 * gravação nenhuma.
 */
export function compareWithNative(
  table: BetterLootTable,
  native: BetterLootNativeTable | null,
): NativeComparison {
  if (native === null) {
    return {
      native: null,
      originOf: () => 'unknown',
      fromGame: 0,
      added: 0,
      missing: [],
    };
  }

  const nativeItems = new Map(native.items.map((item) => [item.shortname, item]));
  const nativeGuaranteed = new Map(native.guaranteed.map((item) => [item.shortname, item]));

  // O garantido do jogo conta como "do jogo" também quando a caixa
  // o guarda entre os itens soltos, e vice-versa: o plugin move
  // entradas entre as duas listas sozinho (o item que sai de todos
  // os galhos vira garantido), e uma linha mudaria de cor por uma
  // decisão que não foi de ninguém.
  const origin = (key: string): EntryOrigin =>
    nativeItems.has(key) || nativeGuaranteed.has(key) ? 'game' : 'added';

  const taken = new Set<string>([
    ...table.items.map((entry) => entry.key),
    ...table.guaranteed.map((entry) => entry.key),
  ]);

  const missing: MissingNativeItem[] = [];

  for (const item of native.items) {
    if (!taken.has(item.shortname)) {
      missing.push({ ...item, guaranteed: false });
    }
  }

  for (const item of native.guaranteed) {
    if (!taken.has(item.shortname)) {
      missing.push({ ...item, guaranteed: true });
    }
  }

  let fromGame = 0;

  for (const entry of table.items) {
    if (origin(entry.key) === 'game') {
      fromGame += 1;
    }
  }

  return {
    native,
    originOf: origin,
    fromGame,
    added: table.items.length - fromGame,
    missing,
  };
}

/**
 * O que fazer com o loot do jogo.
 *
 * ####  DOIS MODOS, E ELES NÃO SÃO OPOSTOS  ####
 *
 * `fill` acrescenta o que falta e não toca em mais nada — é o que
 * adota uma caixa que alguém tinha deixado só com perfis, sem
 * desfazer o trabalho dela.
 *
 * `reset` devolve a caixa ao estado de fábrica: os itens passam a
 * ser exatamente os do jogo, e o que foi acrescentado sai. É
 * destrutivo de propósito, e a tela escreve isso por extenso antes.
 *
 * Nenhum dos dois mexe nos PERFIS. Eles são do outro arquivo e
 * continuam valendo — "combinar o padrão com perfis" é o caso
 * normal, e não uma exceção.
 */
export type NativeImportMode = 'fill' | 'reset';

/** O que a importação faria. A tela mostra isto ANTES de aplicar. */
export interface NativeImportOutcome {
  readonly mode: NativeImportMode;
  /** Entradas que entram. */
  readonly added: number;
  /** Entradas que saem. Só no `reset`. */
  readonly removed: number;
  /** Garantidos que entram. */
  readonly guaranteedAdded: number;
  /** O `Quanto sai` volta ao do jogo? Só no `reset`. */
  readonly settingsChanged: boolean;
  /** A caixa como ela ficaria. */
  readonly table: BetterLootTable;
}

/**
 * Traz o loot do jogo para a caixa.
 *
 * ####  O QUE JÁ ESTÁ NA CAIXA NÃO É TOCADO  ####
 *
 * Nem no `fill` nem no `reset`: quem sobrevive sobrevive COMO
 * ESTÁ, com a quantidade, a skin e o nome que alguém configurou.
 * Reescrever o mínimo e o máximo pelo valor do jogo apagaria em
 * silêncio o ajuste que é o motivo de o servidor existir — um 10x
 * viraria 1x sem ninguém pedir.
 *
 * O que o `reset` faz é REMOVER o que o jogo não põe, e trazer o
 * que falta. Quem quiser as quantidades do jogo de volta remove a
 * caixa inteira primeiro.
 */
export function importNative(
  table: BetterLootTable,
  native: BetterLootNativeTable,
  mode: NativeImportMode,
): NativeImportOutcome {
  const nativeItems = new Map(native.items.map((item) => [item.shortname, item]));
  const nativeGuaranteed = new Map(native.guaranteed.map((item) => [item.shortname, item]));

  const kept =
    mode === 'reset'
      ? table.items.filter(
          (entry) => nativeItems.has(entry.key) || nativeGuaranteed.has(entry.key),
        )
      : table.items;

  const keptGuaranteed =
    mode === 'reset'
      ? table.guaranteed.filter(
          (entry) => nativeItems.has(entry.key) || nativeGuaranteed.has(entry.key),
        )
      : table.guaranteed;

  const taken = new Set<string>([
    ...kept.map((entry) => entry.key),
    ...keptGuaranteed.map((entry) => entry.key),
  ]);

  const items = [...kept];
  const guaranteed = [...keptGuaranteed];

  for (const item of native.items) {
    if (taken.has(item.shortname)) {
      continue;
    }

    taken.add(item.shortname);
    items.push(entryOf(item));
  }

  for (const item of native.guaranteed) {
    if (taken.has(item.shortname)) {
      continue;
    }

    taken.add(item.shortname);
    guaranteed.push(guaranteedOf(item));
  }

  // ####  O "QUANTO SAI" SÓ VOLTA NO RESET  ####
  //
  // No `fill` a caixa continua entregando o que o admin mandou: ele
  // pediu os itens que faltavam, e não uma reconfiguração.
  //
  // O scrap não entra em caixa que não é contêiner: o plugin
  // responde zero para corpo de cientista e para presente, e gravar
  // esse zero apagaria um valor que alguém pôs ali de propósito.
  const settings =
    mode === 'reset'
      ? {
          ...table.itemSettings,
          minItems: native.slotsMin,
          maxItems: native.slotsMax,
          ...(native.source === 'container'
            ? { minScrap: native.scrap, maxScrap: native.scrap }
            : {}),
        }
      : table.itemSettings;

  return {
    mode,
    added: items.length - kept.length,
    removed: table.items.length - kept.length,
    guaranteedAdded: guaranteed.length - keptGuaranteed.length,
    settingsChanged: mode === 'reset' && !sameSettings(table.itemSettings, settings),
    table: {
      ...table,
      itemSettings: settings,
      items,
      guaranteed,
      itemCount: items.length,
      guaranteedCount: guaranteed.length,
    },
  };
}

/**
 * A entrada que nasce de um item do jogo.
 *
 * Os campos que o plugin decide sozinho vão nulos, como no
 * formulário de pôr item: `canConvertToBlueprint`, `durability` e
 * `hasWeaponProperties` são preenchidos pelo `scanEntry` ao
 * validar, e mandar palpite é mandar o que ele apaga na volta.
 */
function entryOf(item: BetterLootNativeItem): BetterLootEntry {
  return {
    // A chave é a do jogo, sem sufixo: é ela que faz a linha ser
    // reconhecida como "do jogo" na próxima comparação.
    key: item.shortname,
    shortname: item.shortname,
    displayName: null,
    skinId: NO_SKIN,
    customName: null,
    min: item.min,
    max: item.max,
    allowDuplicates: true,
    canConvertToBlueprint: null,
    durability: null,
    rarity: null,
    bonusItems: [],
    hasWeaponProperties: false,
  };
}

function guaranteedOf(item: BetterLootNativeItem): BetterLootGuaranteedEntry {
  return {
    key: item.shortname,
    shortname: item.shortname,
    displayName: null,
    skinId: NO_SKIN,
    customName: null,
    min: item.min,
    max: item.max,
  };
}

function sameSettings(
  before: BetterLootTable['itemSettings'],
  after: BetterLootTable['itemSettings'],
): boolean {
  return (
    before.minItems === after.minItems &&
    before.maxItems === after.maxItems &&
    before.minScrap === after.minScrap &&
    before.maxScrap === after.maxScrap
  );
}

/**
 * A caixa está adotada pelo BetterLoot?
 *
 * ####  OS DOIS INTERRUPTORES, NUMA PERGUNTA SÓ  ####
 *
 * O plugin exige `Is Prefab Enabled?` (no LootTables.json) E
 * `Watched Container Prefabs` (no BetterLoot.json). Qualquer um
 * deles desligado devolve a caixa ao loot do jogo.
 *
 * `watched: null` é "não há BetterLoot.json para consultar", e aí a
 * resposta é o que dá para saber: o `enabled`.
 */
export function isAdopted(table: {
  readonly enabled: boolean;
  readonly watched: boolean | null;
}): boolean {
  return table.enabled && table.watched !== false;
}

/**
 * Os dois interruptores discordam?
 *
 * É o estado que a tela precisa DENUNCIAR, e não só desenhar: ele
 * significa que o arquivo diz uma coisa e o servidor faz outra. A
 * causa comum é o `CheckWatchedPrefabs` do plugin, que cadastra
 * caixa nova como não-vigiada quando a configuração já existia.
 */
export function switchesDisagree(table: {
  readonly enabled: boolean;
  readonly watched: boolean | null;
}): boolean {
  return table.watched !== null && table.enabled !== table.watched;
}
