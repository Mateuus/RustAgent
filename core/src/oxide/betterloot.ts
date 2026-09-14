// ============================================================
//  betterloot.ts  -  a configuração de loot do BetterLoot, lida
//  e escrita pelo agente.
//
//  ####  ESTE ARQUIVO EDITA A CONFIGURAÇÃO DE UM PLUGIN DE
//  ####  TERCEIRO
//
//  A decisão do dono (Docs/CustomItem/06 §0) é que o painel
//  configura TODO o loot do jogo editando os JSONs do BetterLoot,
//  em vez de construirmos um motor de loot. É o papel que o Looty
//  cumpre por fora do servidor; nós o cumprimos de dentro.
//
//  Os quatro arquivos, medidos (§2.1 daquele documento):
//
//      oxide/config/BetterLoot.json          os globais
//      oxide/data/BetterLoot/LootTables.json a tabela por prefab
//      oxide/data/BetterLoot/LootGroups.json os grupos
//      oxide/data/BetterLoot/Blacklist.json  os banidos
//
//  ------------------------------------------------------------
//  ####  O QUE SE ESCREVE NÃO É O QUE FICA NO DISCO  ####
//
//  O `scanEntry` do plugin (BetterLoot.cs:2061-2166) valida cada
//  entrada ao carregar e a MODIFICA: remove acessório incompatível
//  com a arma, apaga o bloco `Item Properties` de quem não é arma,
//  preenche ou apaga `Can Convert To Blueprint` conforme o item
//  seja pesquisável, e cria `Item Durability` para item com
//  condição. Depois de tudo isso ele reescreve o arquivo (`:780`,
//  não condicional).
//
//  Por isso o `save` daqui RELÊ o disco depois do reload e devolve
//  o que releu. É a mesma regra que o `PluginLibrary.configWrite`
//  já segue para `oxide/config` — devolver o que o operador enviou
//  faria a tela afirmar uma coisa que o arquivo não diz mais.
//
//  ####  E POR ISSO A EDIÇÃO É UM MERGE, NÃO UMA RESCRITA  ####
//
//  A tela não edita `Item Properties` e diz que não edita. Se o
//  agente montasse cada entrada do zero a partir do que a tela
//  mandou, a munição e os acessórios de toda arma da caixa
//  sumiriam no primeiro salvamento — sem erro, e só percebido no
//  jogo. O `applyTable` abaixo sobrescreve os campos que a tela
//  edita e PRESERVA o resto da entrada crua.
//
//  ####  A REVISÃO É DA CAIXA, E NÃO DO ARQUIVO  ####
//
//  Salvar substitui o `LootTables.json` INTEIRO: o plugin
//  serializa o dicionário todo, e não há merge do lado dele. Duas
//  telas abertas na MESMA caixa fariam a segunda apagar a primeira
//  em silêncio.
//
//  A defesa é o sha256 da ENTRADA daquele prefab
//  (`tableRevisionOf`): a tela devolve o que leu, e o agente recusa
//  quando aquela caixa mudou. É o mesmo papel do `appliedSha` da
//  biblioteca de plugins (library.ts:498) — e o mesmo motivo: um
//  estado do disco que ninguém conferiu é um estado que alguém
//  sobrescreve.
//
//  Ela já foi o sha do ARQUIVO, e isso estava errado de duas
//  maneiras: o `save` copia as outras 110 caixas do disco de agora
//  (logo duas telas em caixas diferentes nunca brigaram), e o
//  próprio plugin reescreve o arquivo ao recarregar — o que fazia
//  a SEGUNDA gravação da mesma caixa levar 409 sem ninguém ter
//  tocado em nada. Ver `waitForRewrite` para a outra metade do
//  conserto.
//
//  ####  2,53 MB NÃO CABEM NUMA RESPOSTA  ####
//
//  Medido no `server01`: 111 prefabs, 6.824 entradas. Por isso a
//  leitura tem dois níveis — `summaries()` devolve o resumo de
//  cada caixa (34,8 KB, medido) e `table()` devolve uma caixa
//  inteira. Mandar tudo junto seria megabytes para uma tela que
//  mostra uma caixa por vez.
//
//  ####  O PLUGIN PODE NÃO ESTAR LÁ  ####
//
//  E no `server01` de hoje ele não está: entrou no acervo como
//  custom e DESLIGADO, por ser de terceiro sem licença e por
//  derrubar metade dos contêineres do mundo enquanto está no ar
//  (Docs/CustomItem/07 §1). Tudo aqui responde com o arquivo
//  ausente — `configured: false` e a lista vazia —, nunca com
//  erro. A tela precisa saber dizer "não configurado"; um 404 ali
//  a faria parecer quebrada.
// ============================================================

import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { ItemRecord, ItemsRepository } from '../db/items-repository.js';
import { ApiError } from '../http/error-response.js';
import { toError } from '../util.js';
import {
  backupPluginConfig,
  pluginConfigPath,
  readPluginConfig,
  writePluginConfig,
} from './plugin-config.js';
import { reloadFailed } from './plugins.js';
import { sha256Of } from './plugin-metadata.js';
import {
  backupPluginDataFile,
  deletePluginDataFile,
  pluginDataPath,
  readPluginDataFile,
  writePluginDataFile,
} from './data-files.js';

/** O nome do plugin: a subpasta em `oxide/data` e o `oxide.reload`. */
export const BETTERLOOT_PLUGIN = 'BetterLoot';

/** Os três arquivos de dados, sem o `.json`. */
export const LOOT_TABLES_FILE = 'LootTables';
export const LOOT_GROUPS_FILE = 'LootGroups';
export const BLACKLIST_FILE = 'Blacklist';

/**
 * Teto do `LootTables.json` que o agente aceita gravar.
 *
 * O medido é 2,53 MB e o arquivo cresce com o número de itens do
 * jogo, não com o que o admin digita. 16 MB é folga de seis vezes
 * — e existe para que um arquivo corrompido (ou de outro plugin)
 * seja recusado aqui, e não depois de o `JSON.parse` comer a
 * memória do agente.
 */
export const MAX_LOOT_TABLES_BYTES = 16 * 1024 * 1024;

// ------------------------------------------------------------
//  O que a API entrega. Espelha panel/src/lib/api.ts.
// ------------------------------------------------------------

/** Um item que sai JUNTO com outro (`Bonus Items`). */
export interface BetterLootBonusItem {
  readonly key: string;
  readonly shortname: string;
  /** `'0'` = a skin do jogo. String porque no arquivo é `ulong`. */
  readonly skinId: string;
  readonly customName: string | null;
  readonly min: number;
  readonly max: number;
}

/** Um item que sai SEMPRE, sem sorteio (`Guaranteed Items`). */
export interface BetterLootGuaranteedEntry {
  readonly key: string;
  readonly shortname: string;
  /** O nome no catálogo do agente. `null` = ele não o conhece. */
  readonly displayName: string | null;
  readonly skinId: string;
  readonly customName: string | null;
  readonly min: number;
  readonly max: number;
}

/** Uma entrada de `Ungrouped Items` — o corpo da tabela. */
export interface BetterLootEntry {
  /** A CHAVE do arquivo. É a identidade, e pode ter sufixo `{n}`. */
  readonly key: string;
  /** A chave sem o sufixo — o item que o jogo conhece. */
  readonly shortname: string;
  readonly displayName: string | null;
  readonly skinId: string;
  readonly customName: string | null;
  readonly min: number;
  readonly max: number;
  readonly allowDuplicates: boolean;
  /** `null` = o plugin decide sozinho. */
  readonly canConvertToBlueprint: boolean | null;
  /** Em PORCENTAGEM da condição. `null` = o item não tem. */
  readonly durability: { readonly min: number; readonly max: number } | null;
  /**
   * A raridade do item NO JOGO.
   *
   * É ela que decide a chance — ver `db/items-repository.ts`. Sai
   * do NOSSO catálogo, e não do arquivo: o `LootTables.json` não
   * a tem. `null` = o agente não soube dizer, e a tela mostra
   * travessão.
   */
  readonly rarity: number | null;
  readonly bonusItems: readonly BetterLootBonusItem[];
  /** Tem `Item Properties`? A tela mostra, e não edita. */
  readonly hasWeaponProperties: boolean;
}

/** Quanto sai de cada coisa numa caixa (`Item Settings`). */
export interface BetterLootItemSettings {
  readonly minItems: number;
  readonly maxItems: number;
  readonly minScrap: number;
  readonly maxScrap: number;
  readonly minBlueprints: number;
  readonly maxBlueprints: number;
  readonly bonusItemsCountToTotal: boolean;
  readonly guaranteedItemsCountToTotal: boolean;
}

// ------------------------------------------------------------
//  Os PERFIS — o `LootGroups.json`
// ------------------------------------------------------------
//
//  ####  É O QUE O LOOTY CHAMA DE "LOOT PROFILE"  ####
//
//  Não é abstração de tela: um perfil é uma entrada do
//  `LootGroups.json`, a classe `LootProfile` do plugin
//  (`BetterLoot.cs:1137`), com três campos e nada mais — `Enabled?`,
//  `Guaranteed Items` e `Item List`.
//
//  ####  O PERFIL NÃO SABE EM QUE CAIXA ELE ENTRA  ####
//
//  Quem sabe é a CAIXA, no campo `Loot Profiles` do prefab lá no
//  `LootTables.json` (o `BetterLootProfileLink` abaixo). São dois
//  arquivos, e a associação mora no segundo. Por isso apagar um
//  perfil não limpa nada sozinho: as caixas continuam pedindo um
//  nome que não existe mais, e o plugin só resmunga no log
//  (`:1031`) e ignora. Ver `deleteProfile`.
//
//  ####  E A SOMA DAS PROBABILIDADES TEM DE DAR 100  ####
//
//  Se não der, o plugin REBALANCEIA sozinho no próximo load
//  (`:600`) e o admin vê números diferentes dos que digitou. A tela
//  precisa avisar antes; recusar seria pior, porque o meio de uma
//  edição é um lugar legítimo para a soma estar errada.

/** Um item dentro de um perfil: uma entrada de caixa, com peso. */
export interface BetterLootProfileItem extends BetterLootEntry {
  /** O peso dentro do perfil, de 1 a 100. A soma deve dar 100. */
  readonly probability: number;
}

/** A linha da lista de perfis. */
export interface BetterLootProfileSummary {
  readonly name: string;
  readonly enabled: boolean;
  readonly itemCount: number;
  readonly guaranteedCount: number;
  /** A soma das probabilidades. Diferente de 100, o plugin rebalanceia. */
  readonly probabilitySum: number;
  /**
   * Os prefabs que pedem este perfil, do `LootTables.json`.
   *
   * É o que a tela mostra antes de apagar. O Looty não diz isto —
   * ele apaga e desfaz a associação em silêncio.
   */
  readonly usedBy: readonly string[];
  /** A impressão DESTE perfil. É o que o PUT quer de volta. */
  readonly revision: string;
}

/** Um perfil inteiro. */
export interface BetterLootProfile {
  readonly name: string;
  readonly enabled: boolean;
  readonly guaranteed: readonly BetterLootGuaranteedEntry[];
  readonly items: readonly BetterLootProfileItem[];
}

/** Um grupo de `LootGroups.json` associado a uma caixa. */
export interface BetterLootProfileLink {
  readonly name: string;
  readonly enabled: boolean;
  readonly probability: number;
  /** `0` = sem limite. */
  readonly maxItems: number;
}

/** A linha da lista de caixas: o que cabe sem abrir a tabela. */
export interface BetterLootTableSummary {
  /** O caminho inteiro do prefab. É a identidade. */
  readonly prefab: string;
  /** `Is Prefab Enabled?`: o plugin PREENCHE esta caixa? */
  readonly enabled: boolean;
  /**
   * A caixa está na lista de vigia do `BetterLoot.json`?
   *
   * ####  SEM ELE, `enabled` NÃO QUER DIZER NADA  ####
   *
   * São dois interruptores em dois arquivos, e o plugin exige os
   * DOIS ligados para mexer na caixa. Este é o que decide se ele
   * chega a olhar (`OnLootSpawn`); o `enabled` acima, se ele
   * preenche. Ver `KEY_WATCHED`.
   *
   * `null` = não existe `BetterLoot.json` naquele servidor, e
   * portanto não há lista para consultar. É diferente de `false`,
   * que é "existe e esta caixa está fora dela".
   */
  readonly watched: boolean | null;
  readonly itemCount: number;
  readonly guaranteedCount: number;
  readonly profileCount: number;
  readonly itemSettings: BetterLootItemSettings;
}

/** A tabela de uma caixa, inteira. */
export interface BetterLootTable extends BetterLootTableSummary {
  readonly poolLocking: boolean;
  readonly ignoreRarityBias: boolean;
  readonly profiles: readonly BetterLootProfileLink[];
  readonly guaranteed: readonly BetterLootGuaranteedEntry[];
  readonly items: readonly BetterLootEntry[];
}

/** O que vale para o SERVIDOR INTEIRO (`BetterLoot.json`). */
export interface BetterLootGlobals {
  readonly lootMultiplier: number;
  readonly scrapMultiplier: number;
  readonly blueprintWeight: number;
  readonly blueprintConversion: boolean;
  readonly allowDuplicates: boolean;
  readonly poolLocking: boolean;
}

/**
 * O que a tela pode MUDAR nos globais.
 *
 * ####  QUATRO CAMPOS, E NÃO OS SEIS QUE SE LEEM  ####
 *
 * `allowDuplicates` e `poolLocking` são lidos e mostrados, mas não
 * entram aqui: eles mudam o SORTEIO (se o mesmo item pode sair duas
 * vezes, se a caixa trava num perfil), e não a escala do loot. O
 * pedido do dono é o multiplicador; oferecer os outros dois de
 * carona seria decidir por ele numa tela que ele abriu para outra
 * coisa.
 *
 * ####  E OS DOIS MULTIPLICADORES SÃO INTEIROS  ####
 *
 * Medido em `BetterLoot.cs:174-177`: `public int LootMultiplier` e
 * `public int ScrapMultiplier`. Aceitar `1.5` aqui gravaria um
 * decimal num campo que o Newtonsoft lê como `int` — e o que o
 * servidor faria com ele não é coisa que a tela possa prometer.
 */
export interface BetterLootGlobalsInput {
  readonly lootMultiplier: number;
  readonly scrapMultiplier: number;
  /** 0 a 1, como o arquivo guarda. A tela é que fala em %. */
  readonly blueprintWeight: number;
  readonly blueprintConversion: boolean;
}

/** O retrato do disco daquele servidor. */
export interface BetterLootStatus {
  /** Existe `LootTables.json`? `false` = o plugin nunca rodou ali. */
  readonly configured: boolean;
  /** Quando o agente leu o disco. `null` = não havia o que ler. */
  readonly readAt: string | null;
  /** O sha256 do `LootTables.json`. Ver o cabeçalho. */
  readonly revision: string | null;
  /**
   * O sha256 do `BetterLoot.json` — a revisão dos GLOBAIS.
   *
   * ####  DOIS ARQUIVOS, DUAS REVISÕES  ####
   *
   * A `revision` acima é da tabela; esta é da configuração. Usar
   * uma só faria o salvamento dos globais ser recusado toda vez que
   * alguém gravasse uma caixa — e vice-versa —, porque recarregar o
   * plugin reescreve o `LootTables.json` sozinho.
   *
   * `null` = o arquivo ainda não existe.
   */
  readonly configRevision: string | null;
  readonly globals: BetterLootGlobals | null;
  readonly blacklist: readonly string[];
  readonly tables: readonly BetterLootTableSummary[];
}

// ------------------------------------------------------------
//  A forma CRUA do arquivo. As chaves são do plugin.
// ------------------------------------------------------------
//
// Daqui para baixo os nomes são do BetterLoot, e não nossos: eles
// viajam num arquivo que OUTRO programa lê e reescreve. Renomear
// qualquer um deles quebraria a integração. A tradução acontece
// num ponto só — nas funções `toEntry`/`applyEntry` abaixo.

/** Um objeto JSON qualquer, como o `JSON.parse` o entrega. */
type RawObject = Record<string, unknown>;

const KEY_TABLES = 'LootTables';
const KEY_ENABLED = 'Is Prefab Enabled?';
const KEY_PROFILES = 'Loot Profiles';
const KEY_POOL_LOCKING = 'Enable Loot Pool Locking';
const KEY_IGNORE_RARITY = 'Select ungrouped items ignoring rarity bias';
const KEY_GUARANTEED = 'Guaranteed Items';
const KEY_UNGROUPED = 'Ungrouped Items';
const KEY_ITEM_SETTINGS = 'Item Settings';
const KEY_BONUS = 'Bonus Items';
const KEY_SKIN = 'Skin ID (0 = default)';
const KEY_CUSTOM_NAME = 'Display Name (empty = none)';
const KEY_MIN = 'Item Minimum';
const KEY_MAX = 'Item Maximum';
const KEY_ALLOW_DUPLICATES = 'Allow Duplicates';
const KEY_BLUEPRINT = 'Can Convert To Blueprint';
const KEY_DURABILITY = 'Item Durability';
const KEY_DURABILITY_MIN = 'Minimum Durability';
const KEY_DURABILITY_MAX = 'Maximum Durability';
const KEY_WEAPON_PROPERTIES = 'Item Properties';
/** O nome do perfil DENTRO do vínculo, na lista `Loot Profiles`. */
const KEY_PROFILE_NAME = 'Loot Profile Name';

/**
 * O sufixo que deixa o mesmo item entrar várias vezes.
 *
 * `UniqueTagREGEX` do plugin (`:416`), aplicado antes de resolver
 * o shortname. `discord.trophy{1}` e `discord.trophy{2}` são duas
 * entradas do mesmo item base, cada uma com a sua skin — é o que
 * faz um catálogo de itens nossos caber numa caixa só.
 */
const UNIQUE_TAG = /\{\d+\}/g;

/** A chave sem o sufixo: o shortname que o jogo conhece. */
export function shortnameOfKey(key: string): string {
  return key.replace(UNIQUE_TAG, '');
}

/**
 * O prefixo que o plugin usa para presente e ovo (`UNWRAP_PREFIX`).
 *
 * NÃO é pasta: `unwrap/xmas.present.large` é uma chave sintética, e
 * o que vem depois da barra é o SHORTNAME DO ITEM.
 */
const UNWRAP_PREFIX = 'unwrap/';

/**
 * Os caminhos que são corpo de NPC, e não caixa.
 *
 * `rust.ai/agents` pega os cientistas de uma vez. As caixas do
 * helicóptero e do Bradley moram em `prefabs/npc/` e NÃO entram
 * aqui: são caixa no mapa, e o admin as procura entre os eventos.
 */
const NPC_PATH_HINTS: readonly string[] = ['rust.ai/agents', '/npc/scientist', 'scientistnpc'];

/**
 * O que aquela chave é, antes de ser um grupo.
 *
 * Medido no `LootTables.json` do `server01`: das 111 chaves, 71 são
 * contêiner, 31 são corpo de cientista e 9 são `unwrap/`. Uma lista
 * que jogasse as três juntas poria "scientist2.prefab" ao lado da
 * caixa de elite — e ninguém pensa em cientista como contêiner.
 *
 * A ordem importa: `unwrap/` nunca é caminho, então ele é testado
 * antes de qualquer coisa que procure barra.
 */
export function natureOfPrefab(prefab: string): 'container' | 'npc' | 'unwrap' {
  const key = prefab.trim().toLowerCase();

  if (key.startsWith(UNWRAP_PREFIX)) {
    return 'unwrap';
  }

  return NPC_PATH_HINTS.some((hint) => key.includes(hint)) ? 'npc' : 'container';
}

/**
 * O `ShortPrefabName` — o que o resto do agente fala.
 *
 * A chave do arquivo é o caminho INTEIRO; a regra de loot e o
 * `_lootByContainer` do nosso plugin são indexados pelo nome curto.
 * São duas chaves para a mesma coisa, e esta função é a ponte.
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

// ------------------------------------------------------------
//  Leitura tolerante
// ------------------------------------------------------------
//
// O arquivo é escrito por outro programa e pode ter campo
// faltando (chaves legadas, versão anterior, item que o
// `scanEntry` ainda não visitou). Um `as` seco produziria
// `undefined` correndo solto pela resposta; estes ajudantes dão o
// default e seguem.

function asObject(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawObject)
    : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * O `Skin ID` como TEXTO.
 *
 * ####  ELE É `ulong` NO PLUGIN  ####
 *
 * Como número de JavaScript ele perderia precisão acima de 2^53 —
 * e a skin é comparada por igualdade com a marca do item custom,
 * onde um dígito errado é um item que não casa com nada. As skins
 * de hoje são da ordem de 3×10⁹ e cabem folgado, mas transportá-la
 * como texto tira a pergunta do caminho.
 */
function asSkinId(value: unknown): string {
  if (typeof value === 'string') {
    return /^\d+$/.test(value.trim()) ? value.trim() : '0';
  }

  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value).toString()
    : '0';
}

/** O `Display Name`: vazio no arquivo é "nenhum" na tela. */
function asCustomName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// ------------------------------------------------------------
//  Do arquivo para a tela
// ------------------------------------------------------------

function toItemSettings(raw: unknown): BetterLootItemSettings {
  const settings = asObject(raw) ?? {};

  return {
    minItems: asNumber(settings['Minimum Amount of Items'], 0),
    maxItems: asNumber(settings['Maximum Amount of Items'], 0),
    minScrap: asNumber(settings['Minimum Scrap Amount'], 0),
    maxScrap: asNumber(settings['Maximum Scrap Amount'], 0),
    minBlueprints: asNumber(settings['Minimum Blueprints'], 0),
    maxBlueprints: asNumber(settings['Maximum Blueprints'], 0),
    bonusItemsCountToTotal: asBoolean(settings['Bonus Items Contribute to Item Count'], false),
    guaranteedItemsCountToTotal: asBoolean(
      settings['Guaranteed Items Contribute to Item Count'],
      true,
    ),
  };
}

function toBonusItems(raw: unknown): readonly BetterLootBonusItem[] {
  const bonus = asObject(raw);

  if (bonus === null) {
    return [];
  }

  return Object.entries(bonus).map(([key, value]) => {
    const entry = asObject(value) ?? {};

    return {
      key,
      shortname: shortnameOfKey(key),
      skinId: asSkinId(entry[KEY_SKIN]),
      customName: asCustomName(entry[KEY_CUSTOM_NAME]),
      min: asNumber(entry[KEY_MIN], 1),
      max: asNumber(entry[KEY_MAX], 1),
    };
  });
}

function toGuaranteed(raw: unknown, catalog: ReadonlyMap<string, ItemRecord>): readonly BetterLootGuaranteedEntry[] {
  const guaranteed = asObject(raw);

  if (guaranteed === null) {
    return [];
  }

  return Object.entries(guaranteed).map(([key, value]) => {
    const entry = asObject(value) ?? {};
    const shortname = shortnameOfKey(key);

    return {
      key,
      shortname,
      displayName: catalog.get(shortname)?.displayName ?? null,
      skinId: asSkinId(entry[KEY_SKIN]),
      customName: asCustomName(entry[KEY_CUSTOM_NAME]),
      min: asNumber(entry[KEY_MIN], 1),
      max: asNumber(entry[KEY_MAX], 1),
    };
  });
}

function toEntries(
  raw: unknown,
  catalog: ReadonlyMap<string, ItemRecord>,
): readonly BetterLootEntry[] {
  const items = asObject(raw);

  if (items === null) {
    return [];
  }

  return Object.entries(items).map(([key, value]) => {
    const entry = asObject(value) ?? {};
    const shortname = shortnameOfKey(key);
    const item = catalog.get(shortname) ?? null;
    const durability = asObject(entry[KEY_DURABILITY]);

    return {
      key,
      shortname,
      displayName: item?.displayName ?? null,
      skinId: asSkinId(entry[KEY_SKIN]),
      customName: asCustomName(entry[KEY_CUSTOM_NAME]),
      min: asNumber(entry[KEY_MIN], 1),
      max: asNumber(entry[KEY_MAX], 1),
      allowDuplicates: asBoolean(entry[KEY_ALLOW_DUPLICATES], true),
      // O plugin OMITE a chave quando decide sozinho, e a ausência
      // é informação: `null` diz "ele resolve", que é diferente de
      // "não pode virar blueprint".
      canConvertToBlueprint:
        typeof entry[KEY_BLUEPRINT] === 'boolean' ? (entry[KEY_BLUEPRINT] as boolean) : null,
      durability:
        durability === null
          ? null
          : {
              min: asNumber(durability[KEY_DURABILITY_MIN], 100),
              max: asNumber(durability[KEY_DURABILITY_MAX], 100),
            },
      // A raridade vem do NOSSO catálogo — o arquivo não a tem.
      // `null` quando o item não está lá: a tela mostra travessão,
      // e a conta de porcentagem tira a linha do denominador em vez
      // de fingir um peso.
      rarity: item?.rarity ?? null,
      bonusItems: toBonusItems(entry[KEY_BONUS]),
      hasWeaponProperties: asObject(entry[KEY_WEAPON_PROPERTIES]) !== null,
    };
  });
}

function toSummary(
  prefab: string,
  raw: RawObject,
  watched: ReadonlyMap<string, boolean> | null,
): BetterLootTableSummary {
  return {
    prefab,
    enabled: asBoolean(raw[KEY_ENABLED], true),
    // Ausente da lista vale `false`, e não "não sei": é o que o
    // plugin faz. O `TryGetValue` dele falha e o hook sai sem
    // tocar na caixa — logo, para o jogo, ela não é vigiada.
    watched: watched === null ? null : (watched.get(prefab) ?? false),
    itemCount: Object.keys(asObject(raw[KEY_UNGROUPED]) ?? {}).length,
    guaranteedCount: Object.keys(asObject(raw[KEY_GUARANTEED]) ?? {}).length,
    profileCount: Array.isArray(raw[KEY_PROFILES]) ? (raw[KEY_PROFILES] as unknown[]).length : 0,
    itemSettings: toItemSettings(raw[KEY_ITEM_SETTINGS]),
  };
}

function toProfiles(raw: unknown): readonly BetterLootProfileLink[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return (raw as unknown[]).map((value) => {
    const profile = asObject(value) ?? {};

    return {
      name: typeof profile[KEY_PROFILE_NAME] === 'string' ? profile[KEY_PROFILE_NAME] : '',
      enabled: asBoolean(profile['Group Enabled?'], false),
      probability: asNumber(profile['Loot Profile Probability (1% - 100%)'], 0),
      maxItems: asNumber(profile['Max Items From Profile (0 = unlimited)'], 0),
    };
  });
}

function toTable(
  prefab: string,
  raw: RawObject,
  catalog: ReadonlyMap<string, ItemRecord>,
  watched: ReadonlyMap<string, boolean> | null,
): BetterLootTable {
  return {
    ...toSummary(prefab, raw, watched),
    poolLocking: asBoolean(raw[KEY_POOL_LOCKING], false),
    ignoreRarityBias: asBoolean(raw[KEY_IGNORE_RARITY], false),
    profiles: toProfiles(raw[KEY_PROFILES]),
    guaranteed: toGuaranteed(raw[KEY_GUARANTEED], catalog),
    items: toEntries(raw[KEY_UNGROUPED], catalog),
  };
}

/** Os globais, do `oxide/config/BetterLoot.json`. */
export function toGlobals(text: string): BetterLootGlobals | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Config quebrada não derruba a tela: a lista de caixas é a
    // parte que importa, e os globais viram `null` — que a tela já
    // sabe mostrar como travessão.
    return null;
  }

  const root = asObject(parsed);

  if (root === null) {
    return null;
  }

  const general = asObject(root['General Configuration']) ?? {};
  const loot = asObject(root['Loot Configuration']) ?? {};

  return {
    lootMultiplier: asNumber(loot['Loot Multiplier'], 1),
    // `Multipler`, sem o "i": é erro de grafia DO PLUGIN, e
    // consertá-lo aqui deixaria de encontrar a chave.
    scrapMultiplier: asNumber(loot['Scrap Multipler'], 1),
    blueprintWeight: asNumber(general[KEY_BLUEPRINT_WEIGHT], 0),
    blueprintConversion: asBoolean(loot['Enable Blueprint Conversion'], false),
    allowDuplicates: asBoolean(loot['Allow duplicate items'], true),
    poolLocking: asBoolean(loot['Enable Loot Pool Locking System'], false),
  };
}

/** A chave do peso de blueprint. Longa, e é assim no arquivo. */
const KEY_BLUEPRINT_WEIGHT =
  'Blueprint Weight (0.0 = min bias, 1.0 = max bias, 0.5 = balanced)';

/**
 * A chave da LISTA DE VIGIA, no `BetterLoot.json`.
 *
 * ####  É O SEGUNDO INTERRUPTOR, E É ELE QUE MANDA  ####
 *
 * `Is Prefab Enabled?`, no LootTables.json, decide se o plugin
 * PREENCHE a caixa. Este dicionário decide se ele CHEGA a olhar
 * para ela: `OnLootSpawn` (BetterLoot.cs:1620-1622) sai com `null`
 * quando o prefab está aqui como `false`, e o jogo entrega o loot
 * nativo — mesmo com `Is Prefab Enabled?` valendo `true`.
 *
 * A tela mostrava só o primeiro, e por isso podia afirmar
 * "BetterLoot" numa caixa que o servidor entregava do jogo.
 *
 * ####  E O PLUGIN CADASTRA CAIXA NOVA DESLIGADA  ####
 *
 * `CheckWatchedPrefabs` (BetterLoot.cs:216-272) roda a cada load e
 * acrescenta o que faltar com
 * `NewConfigGenerated || (NewSave && AutoEnableNewContainers)` —
 * ou seja, `false` sempre que a configuração já existia e não é dia
 * de wipe. Caixa que entrou num update depois da instalação fica em
 * "jogo" para sempre, até alguém editar este arquivo à mão. É o
 * caso que chegou como reclamação da `crate_elite`.
 */
const KEY_WATCHED = 'Watched Container Prefabs (true = monitor container loot, false = disabled)';

/**
 * A lista de vigia, do `BetterLoot.json`.
 *
 * `null` = não há arquivo de configuração para consultar, que é
 * diferente de "não vigia nada". A tela precisa da diferença: no
 * primeiro caso ela diz que o plugin nunca rodou ali; no segundo,
 * que a caixa está desligada.
 */
export function toWatched(text: string): ReadonlyMap<string, boolean> | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Mesma regra do `toGlobals`: config quebrada não derruba a
    // lista de caixas.
    return null;
  }

  const general = asObject(asObject(parsed)?.['General Configuration']);
  const watched = asObject(general?.[KEY_WATCHED]);

  if (watched === null) {
    return null;
  }

  const entries = new Map<string, boolean>();

  for (const [prefab, value] of Object.entries(watched)) {
    // Só booleano entra. Um valor de outro tipo ali é arquivo
    // corrompido, e o plugin o leria como `false` — mas adivinhar
    // por ele faria a tela afirmar um estado que ninguém escreveu.
    if (typeof value === 'boolean') {
      entries.set(prefab, value);
    }
  }

  return entries;
}

/**
 * Liga ou desliga UMA caixa na lista de vigia.
 *
 * ####  UMA CHAVE, E O RESTO COMO ESTAVA  ####
 *
 * Mesma regra do `applyGlobals`: o arquivo tem 111 chaves aqui
 * dentro e mais quatro blocos de configuração. Montá-lo do zero
 * devolveria tudo ligado — inclusive a caixa que o admin tinha
 * tirado de propósito.
 *
 * ####  E ELA NÃO TEM TRAVA DE REVISÃO  ####
 *
 * Ao contrário do `saveGlobals`, que grava quatro campos que a tela
 * editou junta. Aqui é UMA chave de um dicionário, e o merge
 * preserva as outras 110 — duas pessoas adotando caixas diferentes
 * nunca se atrapalham. Cobrar revisão faria a adoção de uma caixa
 * ser recusada porque alguém mexeu no multiplicador do servidor, o
 * que é recusar por nada.
 *
 * @throws {ApiError} 400 quando o arquivo do disco não é JSON de
 * objeto — sobrescrevê-lo apagaria a configuração que existe.
 */
export function applyWatched(
  text: string | null,
  prefab: string,
  watched: boolean,
  where: string,
): string {
  const root = text === null ? {} : parseConfigRoot(text, where);
  const general = asObject(root['General Configuration']) ?? {};
  const current = asObject(general[KEY_WATCHED]) ?? {};

  return JSON.stringify(
    {
      ...root,
      'General Configuration': {
        ...general,
        // Daqui pra baixo é o contrato do BetterLoot: o nome da
        // chave e o do prefab são dele.
        [KEY_WATCHED]: { ...current, [prefab]: watched },
      },
    },
    null,
    2,
  );
}

/**
 * Liga (ou desliga) VÁRIAS caixas de uma vez na lista de vigia.
 *
 * ####  ELE EXISTE PORQUE A ADOÇÃO EM MASSA É UMA ESCRITA SÓ  ####
 *
 * Chamar o `applyWatched` 111 vezes faria 111 backups e 111
 * gravações do mesmo arquivo de 10 KB, e cada uma com a chance de
 * o agente morrer no meio e deixar metade das caixas adotadas. O
 * `rebuild` decide o conjunto inteiro antes e grava uma vez.
 *
 * O merge é o mesmo do irmão: o que não está no mapa continua como
 * estava, e os outros blocos do arquivo não são tocados.
 *
 * @throws {ApiError} 400 quando o arquivo do disco não é JSON de
 * objeto.
 */
export function applyWatchedAll(
  text: string | null,
  watched: ReadonlyMap<string, boolean>,
  where: string,
): string {
  const root = text === null ? {} : parseConfigRoot(text, where);
  const general = asObject(root['General Configuration']) ?? {};
  const current = asObject(general[KEY_WATCHED]) ?? {};

  return JSON.stringify(
    {
      ...root,
      'General Configuration': {
        ...general,
        // Daqui pra baixo é o contrato do BetterLoot: o nome da
        // chave e o dos prefabs são dele.
        [KEY_WATCHED]: { ...current, ...Object.fromEntries(watched) },
      },
    },
    null,
    2,
  );
}

/**
 * Os quatro campos da tela SOBRE a configuração que está no disco.
 *
 * ####  O QUE NÃO ESTÁ AQUI FICA COMO ESTAVA  ####
 *
 * Mesma regra do `applyTable`, e o caso que dói é o mesmo tipo de
 * coisa: `Watched Container Prefabs` são 111 chaves que o plugin
 * varreu do mundo, e o admin pode ter desligado algumas. Montar o
 * arquivo do zero as devolveria todas ligadas, sem erro nenhum e
 * só percebido no jogo.
 *
 * @throws {ApiError} 400 quando o arquivo do disco não é JSON de
 * objeto. Sobrescrevê-lo apagaria a configuração que existe — e o
 * `backup` viria depois, tarde demais para quem lê a mensagem.
 */
export function applyGlobals(
  text: string | null,
  input: BetterLootGlobalsInput,
  where: string,
): string {
  const root = text === null ? {} : parseConfigRoot(text, where);
  const general = asObject(root['General Configuration']) ?? {};
  const loot = asObject(root['Loot Configuration']) ?? {};

  const next = {
    ...root,
    'General Configuration': {
      ...general,
      [KEY_BLUEPRINT_WEIGHT]: input.blueprintWeight,
    },
    // Daqui pra baixo é o contrato do BetterLoot: os nomes dos
    // campos são dele. `Multipler`, sem o "i", é erro de grafia DO
    // PLUGIN — consertá-lo aqui gravaria uma chave que ele não lê,
    // e o multiplicador de scrap voltaria a 1 no próximo load.
    'Loot Configuration': {
      ...loot,
      'Loot Multiplier': input.lootMultiplier,
      'Scrap Multipler': input.scrapMultiplier,
      'Enable Blueprint Conversion': input.blueprintConversion,
    },
  };

  // Duas casas, como o Newtonsoft escreve com `Formatting.Indented`
  // — manter o formato deixa o `diff` de um backup contra o outro
  // legível.
  return JSON.stringify(next, null, 2);
}

function parseConfigRoot(text: string, where: string): RawObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError(
      'BETTERLOOT_INVALID_CONFIG',
      `${where} não é um JSON válido (${toError(error).message}), e gravar por cima apagaria o ` +
        'que está lá. Nada foi alterado: conserte o arquivo, ou apague-o para o plugin criá-lo ' +
        'de novo no próximo carregamento.',
      400,
    );
  }

  const root = asObject(parsed);

  if (root === null) {
    throw new ApiError(
      'BETTERLOOT_INVALID_CONFIG',
      `${where} não tem um objeto na raiz. Nada foi alterado.`,
      400,
    );
  }

  return root;
}

/** Os shortnames banidos, do `Blacklist.json`. É global, não por caixa. */
export function toBlacklist(text: string): readonly string[] {
  try {
    const root = asObject(JSON.parse(text));
    const list = root?.['ItemList'];

    return Array.isArray(list) ? (list as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------
//  Da tela para o arquivo
// ------------------------------------------------------------

/**
 * Aplica a entrada da tela SOBRE a entrada crua.
 *
 * ####  O QUE NÃO ESTÁ AQUI FICA COMO ESTAVA  ####
 *
 * `Item Properties` é o caso que dói: a tela não o edita, e
 * montar a entrada do zero apagaria a munição e os acessórios de
 * toda arma da caixa. Entrada nova (que o arquivo ainda não tem)
 * nasce mínima e o `scanEntry` do plugin completa o resto no
 * próximo load — que é exatamente o que ele faz de qualquer jeito.
 */
function applyEntry(previous: RawObject | null, entry: BetterLootEntry): RawObject {
  const next: RawObject = { ...(previous ?? {}) };

  next[KEY_SKIN] = Number(entry.skinId);
  next[KEY_CUSTOM_NAME] = entry.customName ?? '';
  next[KEY_MIN] = entry.min;
  next[KEY_MAX] = entry.max;
  next[KEY_ALLOW_DUPLICATES] = entry.allowDuplicates;
  next[KEY_BONUS] = applyBonusItems(asObject(previous?.[KEY_BONUS]), entry.bonusItems);

  if (entry.canConvertToBlueprint === null) {
    // Apagar a chave é DIZER alguma coisa: é assim que o plugin
    // representa "eu decido". Gravar `false` seria uma afirmação
    // nossa sobre um item que ele conhece melhor.
    delete next[KEY_BLUEPRINT];
  } else {
    next[KEY_BLUEPRINT] = entry.canConvertToBlueprint;
  }

  if (entry.durability === null) {
    delete next[KEY_DURABILITY];
  } else {
    next[KEY_DURABILITY] = {
      [KEY_DURABILITY_MIN]: entry.durability.min,
      [KEY_DURABILITY_MAX]: entry.durability.max,
    };
  }

  return next;
}

function applyBonusItems(
  previous: RawObject | null,
  bonus: readonly BetterLootBonusItem[],
): RawObject {
  const next: RawObject = {};

  for (const item of bonus) {
    const before = asObject(previous?.[item.key]) ?? {};

    next[item.key] = {
      ...before,
      [KEY_SKIN]: Number(item.skinId),
      [KEY_CUSTOM_NAME]: item.customName ?? '',
      [KEY_MIN]: item.min,
      [KEY_MAX]: item.max,
    };
  }

  return next;
}

function applyGuaranteed(
  previous: RawObject | null,
  guaranteed: readonly BetterLootGuaranteedEntry[],
): RawObject {
  const next: RawObject = {};

  for (const item of guaranteed) {
    const before = asObject(previous?.[item.key]) ?? {};

    next[item.key] = {
      ...before,
      [KEY_SKIN]: Number(item.skinId),
      [KEY_CUSTOM_NAME]: item.customName ?? '',
      [KEY_MIN]: item.min,
      [KEY_MAX]: item.max,
    };
  }

  return next;
}

/**
 * A tabela da tela, aplicada sobre a tabela crua daquele prefab.
 *
 * Devolve o objeto novo — as entradas que a tela removeu somem, e
 * é isso que faz "tirei este item da caixa" chegar ao jogo.
 */
export function applyTable(previous: RawObject | null, table: BetterLootTable): RawObject {
  const before = previous ?? {};
  const beforeItems = asObject(before[KEY_UNGROUPED]);
  const items: RawObject = {};

  for (const entry of table.items) {
    items[entry.key] = applyEntry(asObject(beforeItems?.[entry.key]), entry);
  }

  return {
    ...before,
    [KEY_ENABLED]: table.enabled,
    [KEY_POOL_LOCKING]: table.poolLocking,
    [KEY_IGNORE_RARITY]: table.ignoreRarityBias,
    [KEY_PROFILES]: table.profiles.map((profile) => ({
      'Group Enabled?': profile.enabled,
      'Loot Profile Name': profile.name,
      'Loot Profile Probability (1% - 100%)': profile.probability,
      'Max Items From Profile (0 = unlimited)': profile.maxItems,
    })),
    [KEY_GUARANTEED]: applyGuaranteed(asObject(before[KEY_GUARANTEED]), table.guaranteed),
    [KEY_UNGROUPED]: items,
    [KEY_ITEM_SETTINGS]: {
      ...(asObject(before[KEY_ITEM_SETTINGS]) ?? {}),
      'Minimum Amount of Items': table.itemSettings.minItems,
      'Maximum Amount of Items': table.itemSettings.maxItems,
      'Minimum Scrap Amount': table.itemSettings.minScrap,
      'Maximum Scrap Amount': table.itemSettings.maxScrap,
      'Minimum Blueprints': table.itemSettings.minBlueprints,
      'Maximum Blueprints': table.itemSettings.maxBlueprints,
      'Bonus Items Contribute to Item Count': table.itemSettings.bonusItemsCountToTotal,
      'Guaranteed Items Contribute to Item Count': table.itemSettings.guaranteedItemsCountToTotal,
    },
  };
}

// ------------------------------------------------------------
//  O arquivo, aberto
// ------------------------------------------------------------

/** O `LootTables.json` lido, com a revisão que o identifica. */
export interface LootTablesFile {
  /** O sha256 do texto cru. É a `revision` da API. */
  readonly revision: string;
  /** `{ "<prefab>": {...} }`, cru. */
  readonly tables: Record<string, RawObject>;
  /** A raiz inteira, para preservar o que não conhecemos ao gravar. */
  readonly root: RawObject;
}

/**
 * Abre o `LootTables.json`.
 *
 * @throws {ApiError} 500 com o caminho quando o arquivo existe e
 * não é o que se espera. Um arquivo corrompido é problema de quem
 * administra, e a mensagem precisa dizer QUAL arquivo — a tela não
 * tem como adivinhar.
 */
export function parseLootTables(text: string, where: string): LootTablesFile {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError(
      'BETTERLOOT_INVALID_FILE',
      `${where} não é um JSON válido: ${error instanceof Error ? error.message : String(error)}. ` +
        'Nada foi alterado.',
      500,
    );
  }

  const root = asObject(parsed);
  const tables = asObject(root?.[KEY_TABLES]);

  if (root === null || tables === null) {
    throw new ApiError(
      'BETTERLOOT_INVALID_FILE',
      `${where} não tem o objeto "${KEY_TABLES}" que o BetterLoot escreve. Ou o arquivo é de ` +
        'outra coisa, ou ele foi editado à mão. Nada foi alterado.',
      500,
    );
  }

  const byPrefab: Record<string, RawObject> = {};

  for (const [prefab, value] of Object.entries(tables)) {
    const table = asObject(value);

    if (table !== null) {
      byPrefab[prefab] = table;
    }
  }

  return { revision: sha256Of(Buffer.from(text, 'utf8')), tables: byPrefab, root };
}

// ------------------------------------------------------------
//  O `LootGroups.json`, aberto
// ------------------------------------------------------------

const KEY_GROUPS = 'Loot Groups';
const KEY_GROUP_ENABLED = 'Enabled?';
const KEY_ITEM_LIST = 'Item List';
const KEY_ITEM_PROBABILITY = 'Item Probability (1-100)';
const KEY_ITEM_AMOUNT = 'Item Amount';

/** O `LootGroups.json` lido. */
export interface LootGroupsFile {
  readonly revision: string;
  /** `{ "<nome>": {...} }`, cru. */
  readonly groups: Record<string, RawObject>;
  /** A raiz inteira, para preservar o que não conhecemos ao gravar. */
  readonly root: RawObject;
}

/**
 * O arquivo vazio, para quando ele ainda não existe.
 *
 * ####  ELE NASCE DA GENTE, E ISSO É DIFERENTE DA TABELA  ####
 *
 * O `LootTables.json` o plugin gera sozinho varrendo o mundo — se
 * não existe, o admin precisa subir o servidor uma vez, e o agente
 * diz isso. O `LootGroups.json` não: ele é só a lista de perfis, e
 * uma lista vazia é um estado legítimo. Criar o primeiro perfil de
 * um servidor que nunca carregou o plugin tem de funcionar.
 */
function emptyLootGroups(): LootGroupsFile {
  const root: RawObject = { [KEY_GROUPS]: {} };

  return { revision: sha256Of(Buffer.from('', 'utf8')), groups: {}, root };
}

/** @throws {ApiError} 500 quando o arquivo existe e não é o esperado. */
export function parseLootGroups(text: string, where: string): LootGroupsFile {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError(
      'BETTERLOOT_INVALID_FILE',
      `${where} não é um JSON válido: ${error instanceof Error ? error.message : String(error)}. ` +
        'Nada foi alterado.',
      500,
    );
  }

  const root = asObject(parsed);
  const groups = asObject(root?.[KEY_GROUPS]);

  if (root === null || groups === null) {
    throw new ApiError(
      'BETTERLOOT_INVALID_FILE',
      `${where} não tem o objeto "${KEY_GROUPS}" que o BetterLoot escreve. Ou o arquivo é de ` +
        'outra coisa, ou ele foi editado à mão. Nada foi alterado.',
      500,
    );
  }

  const byName: Record<string, RawObject> = {};

  for (const [name, value] of Object.entries(groups)) {
    const group = asObject(value);

    if (group !== null) {
      byName[name] = group;
    }
  }

  return { revision: sha256Of(Buffer.from(text, 'utf8')), groups: byName, root };
}

/** A revisão de UM perfil. O mesmo motivo do `tableRevisionOf`. */
export function profileRevisionOf(raw: RawObject | null): string {
  return sha256Of(Buffer.from(JSON.stringify(raw ?? {}), 'utf8'));
}

/**
 * As probabilidades de um perfil, somadas.
 *
 * Sai do CRU porque a lista precisa dela sem montar cada item — são
 * 100 perfis possíveis, e cada um com o seu catálogo.
 */
function probabilitySumOf(raw: RawObject): number {
  const items = asObject(raw[KEY_ITEM_LIST]);

  if (items === null) {
    return 0;
  }

  let sum = 0;

  for (const value of Object.values(items)) {
    sum += asNumber(asObject(value)?.[KEY_ITEM_PROBABILITY], 0);
  }

  // Duas casas: a soma de decimais em ponto flutuante produz
  // 99.99999999999999, e a tela mostraria "incompleto" para um
  // perfil que está exato.
  return Math.round(sum * 100) / 100;
}

function toProfile(
  name: string,
  raw: RawObject,
  catalog: ReadonlyMap<string, ItemRecord>,
): BetterLootProfile {
  const items = asObject(raw[KEY_ITEM_LIST]) ?? {};

  return {
    name,
    // O plugin trata a ausência como LIGADO (`public bool Enabled =
    // true`), e a tela precisa mostrar o mesmo que o jogo faz.
    enabled: asBoolean(raw[KEY_GROUP_ENABLED], true),
    guaranteed: toGuaranteed(raw[KEY_GUARANTEED], catalog),
    items: Object.entries(items).map(([key, value]) => {
      const item = asObject(value) ?? {};

      // O item do perfil é uma entrada de caixa embrulhada: o que
      // está em `Item Amount` tem a MESMA forma de uma entrada de
      // `Ungrouped Items`. Por isso o `toEntries` é reaproveitado
      // inteiro — um segundo leitor divergiria do primeiro na
      // primeira vez que o plugin mudasse um campo.
      const [entry] = toEntries({ [key]: asObject(item[KEY_ITEM_AMOUNT]) ?? {} }, catalog);

      return {
        ...(entry as BetterLootEntry),
        probability: asNumber(item[KEY_ITEM_PROBABILITY], 0),
      };
    }),
  };
}

/**
 * O perfil da tela, aplicado sobre o perfil cru.
 *
 * PRESERVA o que a tela não edita — a mesma regra do `applyTable`,
 * e pelo mesmo motivo: o `scanEntry` também passa por aqui.
 */
export function applyProfile(previous: RawObject | null, profile: BetterLootProfile): RawObject {
  const before = previous ?? {};
  const beforeItems = asObject(before[KEY_ITEM_LIST]);
  const items: RawObject = {};

  for (const item of profile.items) {
    const beforeItem = asObject(beforeItems?.[item.key]);

    items[item.key] = {
      ...(beforeItem ?? {}),
      [KEY_ITEM_PROBABILITY]: item.probability,
      [KEY_ITEM_AMOUNT]: applyEntry(asObject(beforeItem?.[KEY_ITEM_AMOUNT]), item),
    };
  }

  return {
    ...before,
    [KEY_GROUP_ENABLED]: profile.enabled,
    [KEY_GUARANTEED]: applyGuaranteed(asObject(before[KEY_GUARANTEED]), profile.guaranteed),
    [KEY_ITEM_LIST]: items,
  };
}

/**
 * Troca o nome de um perfil dentro de UMA caixa crua.
 *
 * `to === null` = tirar a citação (é o que o `deleteProfile` faz);
 * um nome = renomear no lugar, preservando probabilidade, teto e o
 * liga/desliga daquela associação.
 */
function retargetProfileLinks(raw: RawObject, from: string, to: string | null): RawObject {
  const links = toProfiles(raw[KEY_PROFILES]);
  const next = to === null ? links.filter((link) => link.name !== from) : links;

  return {
    ...raw,
    [KEY_PROFILES]: next.map((link) => ({
      'Group Enabled?': link.enabled,
      'Loot Profile Name': link.name === from && to !== null ? to : link.name,
      'Loot Profile Probability (1% - 100%)': link.probability,
      'Max Items From Profile (0 = unlimited)': link.maxItems,
    })),
  };
}

/**
 * Em quais caixas cada perfil está.
 *
 * Uma varredura só do `LootTables.json` inteiro, e não uma por
 * perfil: são 111 prefabs, e perguntar perfil a perfil seria ler o
 * mesmo objeto cem vezes.
 */
function usageOfProfiles(tables: Record<string, RawObject>): ReadonlyMap<string, string[]> {
  const usage = new Map<string, string[]>();

  for (const [prefab, raw] of Object.entries(tables)) {
    for (const link of toProfiles(raw[KEY_PROFILES])) {
      if (link.name === '') {
        continue;
      }

      const list = usage.get(link.name);

      if (list === undefined) {
        usage.set(link.name, [prefab]);
      } else {
        list.push(prefab);
      }
    }
  }

  return usage;
}

/**
 * A revisão de UMA CAIXA.
 *
 * ####  POR QUE NÃO É O SHA DO ARQUIVO  ####
 *
 * O `save` faz merge POR PREFAB: ele relê o disco na hora de
 * gravar e troca só a caixa editada, preservando as outras 110.
 * Duas telas em caixas DIFERENTES nunca se atropelaram — e com a
 * revisão do arquivo inteiro a segunda levava 409 assim mesmo,
 * porque o arquivo mudou.
 *
 * O conflito que existe de verdade é um só: alguém mexeu NESTA
 * caixa entre a hora em que a tela a abriu e a hora em que ela
 * gravou. É esse que este sha vê.
 *
 * E ele é o que faz a reescrita do plugin parar de virar conflito:
 * o `scanEntry` mexe em campos de muitas caixas ao validar, mas se
 * não mexeu na que está aberta, a revisão dela continua valendo.
 *
 * Caixa que ainda não existe tem revisão do objeto vazio — e não
 * `null`: assim "a caixa apareceu no disco depois que abri" também
 * é um conflito, e não um salvamento silencioso por cima.
 */
export function tableRevisionOf(raw: RawObject | null): string {
  return sha256Of(Buffer.from(JSON.stringify(raw ?? {}), 'utf8'));
}

// ------------------------------------------------------------
//  A espera pela reescrita do plugin
// ------------------------------------------------------------
//
// ####  O `oxide.reload` VOLTA ANTES DE O PLUGIN TER RODADO  ####
//
// `rcon.send('oxide.reload BetterLoot')` responde quando o comando
// é DESPACHADO. O Oxide só então descarrega, recompila, chama
// `Init` — e é aí que o `scanEntry` valida as 6.824 entradas e
// REESCREVE o `LootTables.json` (`BetterLoot.cs:780`, não
// condicional).
//
// Sem esperar por isso, a releitura do `save` pega o arquivo que
// NÓS gravamos, e a revisão que a tela guarda nasce velha: um
// instante depois o disco é outro. O sintoma era o 409 na SEGUNDA
// gravação da mesma caixa, sem ninguém ter editado nada por fora.
//
// A espera é por sinal do disco, e não por tempo fixo: um `sleep`
// de dois segundos seria curto num servidor carregado e longo em
// todos os outros.

/**
 * Os três tempos da espera.
 *
 * ####  ELA DESISTE DE DUAS MANEIRAS, E DE PROPÓSITO  ####
 *
 * `graceMs` é a paciência ATÉ VER a primeira mudança: se o disco
 * não mexeu nesse tempo, o plugin não vai reescrever (não compilou,
 * a versão não reescreve, o servidor caiu no meio) e continuar
 * esperando não traria nada. `timeoutMs` é o teto de tudo, para o
 * caso de um arquivo que não para de mudar.
 *
 * Esperar aqui é conveniência: a gravação JÁ ACONTECEU quando se
 * chega neste ponto, e o pior que o teto causa é a tela mostrar a
 * caixa um instante antes de o plugin normalizá-la. Travar a
 * resposta por causa disso seria trocar um conflito falso por uma
 * tela pendurada.
 */
// ------------------------------------------------------------
//  ####  REFAZER A BASE  ####
//
//  O BetterLoot lê a tabela nativa do jogo UMA vez: quando cria a
//  entrada daquele prefab no `LootTables.json`
//  (`LoadAllContainers`, BetterLoot.cs:1833-2040). Dali em diante o
//  arquivo é a única verdade que ele conhece, e ele nunca regenera
//  sozinho.
//
//  A consequência aparece meses depois, e foi o que chegou como
//  reclamação: caixa que alguém deixou só com perfis perdeu a lista
//  de itens do jogo; caixa que entrou num update do Rust depois da
//  instalação ficou em "JOGO" para sempre; e não há como saber o
//  que ainda é do jogo naquele arquivo.
//
//  Consertar isso caixa a caixa é o que o editor já faz desde o
//  Docs/CustomItem/09 — e é retrabalho de 111 caixas. O `rebuild`
//  faz o contrário: manda o PLUGIN gerar a base outra vez, do jogo
//  de agora, e devolve por cima dela o que era da casa.
//
//  ####  A BASE NOVA VEM DO PLUGIN, E NÃO DE UM ARQUIVO NOSSO  ####
//
//  Guardar uma cópia "limpa" no repositório envelheceria no
//  primeiro update do Rust que mexesse em loot, e passaria a mentir
//  sem nenhum sintoma. O único gerador que nunca diverge do que o
//  servidor entrega é o próprio BetterLoot, lendo o jogo daquele
//  build. Ver `BetterLootEditor.rebuild`.
// ------------------------------------------------------------

/** O que o `rebuild` faz com a tabela que estava no disco. */
export type BetterLootRebuildMode = 'merge' | 'factory';

/** O que aconteceu com UMA caixa. */
export interface BetterLootRebuiltTable {
  readonly prefab: string;
  /** Quantos itens do jogo a base nova trouxe para ela. */
  readonly nativeItems: number;
  /** As chaves da casa que foram devolvidas à caixa. */
  readonly keptItems: readonly string[];
  /** As chaves da casa devolvidas à lista de garantidos. */
  readonly keptGuaranteed: readonly string[];
  /** Os perfis que continuaram ligados a ela. */
  readonly keptProfiles: readonly string[];
  /** Perfis que ela cita e que não existem no `LootGroups.json`. */
  readonly orphanProfiles: readonly string[];
  /** Ela estava em "JOGO" e passou a ser do BetterLoot. */
  readonly adopted: boolean;
  /** O prefab não existia na configuração anterior. */
  readonly fresh: boolean;
}

/** O que o `rebuild` fez, por extenso. É o que a tela mostra. */
export interface BetterLootRebuildReport {
  readonly mode: BetterLootRebuildMode;
  /** Caixas na base nova. */
  readonly tables: number;
  /** Itens do jogo que a base nova trouxe, somando todas. */
  readonly nativeItems: number;
  /** Itens da casa devolvidos, somando todas. */
  readonly keptItems: number;
  /** Vínculos com perfil devolvidos, somando todas. */
  readonly keptProfiles: number;
  /** Caixas que saíram de "JOGO". */
  readonly adopted: readonly string[];
  /** Prefabs que a configuração anterior não tinha. */
  readonly fresh: readonly string[];
  /**
   * Prefabs que existiam, que o plugin não gerou e que o jogo não
   * conhece mais.
   *
   * Caixa que saiu num update do Rust, ou entrada que alguém
   * escreveu à mão. Elas NÃO entram na base nova — e continuam no
   * backup, que é o único lugar onde ainda fazem sentido.
   */
  readonly dropped: readonly string[];
  /**
   * Prefabs que o plugin não gerou e que ficaram COMO ESTAVAM.
   *
   * ####  O CORPO DE CIENTISTA DESLIGADO É O CASO  ####
   *
   * O `LoadAllContainers` pula a geração de NPC cujo prefab está na
   * lista de vigia como `false` (BetterLoot.cs:1934-1941) — e só a
   * de NPC; contêiner e presente ele gera de qualquer jeito. Sem
   * esta lista, a entrada daquele NPC seria tratada como prefab
   * extinto e sumiria junto com o que alguém configurou nela.
   *
   * O que separa um do outro é a lista de vigia depois do reload: o
   * plugin REMOVE dela o prefab que o jogo não tem mais
   * (`:2040-2046`). Continuar lá é o que prova que ele existe.
   *
   * Adotar tudo antes de gerar (o caminho recomendado) esvazia esta
   * lista: com a vigia ligada, o NPC é gerado como qualquer caixa.
   */
  readonly preserved: readonly string[];
  /** Nomes de perfil citados por alguma caixa e que não existem. */
  readonly orphanProfiles: readonly string[];
  /** As caixas que têm algo a contar. Caixa intacta fica de fora. */
  readonly changed: readonly BetterLootRebuiltTable[];
}

/**
 * As chaves da caixa velha que a base nova NÃO tem.
 *
 * ####  É A DEFINIÇÃO DE "ITEM DA CASA", E ELA É POR CHAVE  ####
 *
 * A mesma do cruzamento da tela (Docs/CustomItem/09 §3.1): chave
 * exata, e não shortname. A chave nativa nunca tem sufixo
 * (`rifle.ak`), e a segunda AK com skin da casa nasce `rifle.ak{1}`
 * — casar pelo shortname base faria o troféu da casa passar por
 * item original do Rust e sumir no primeiro rebuild.
 *
 * As duas listas da base entram na conta porque o plugin move
 * entradas entre elas sozinho: o item que sai de todos os galhos
 * vira garantido. Olhar só uma faria o mesmo item ser devolvido
 * como "da casa" e aparecer duas vezes na caixa.
 */
function houseKeysOf(
  previous: RawObject | null,
  nativeItems: RawObject,
  nativeGuaranteed: RawObject,
): readonly [string, unknown][] {
  if (previous === null) {
    return [];
  }

  return Object.entries(previous).filter(
    ([key]) => !(key in nativeItems) && !(key in nativeGuaranteed),
  );
}

/** Os nomes de perfil de uma lista `Loot Profiles` crua. */
function profileNamesOf(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const names: string[] = [];

  for (const value of raw as unknown[]) {
    const name = asObject(value)?.[KEY_PROFILE_NAME];

    if (typeof name === 'string' && name !== '') {
      names.push(name);
    }
  }

  return names;
}

/**
 * A base nova, com o que era da casa devolvido por cima.
 *
 * ####  O QUE SOBREVIVE, E O QUE NÃO  ####
 *
 * | sobrevive | volta ao do jogo |
 * | --- | --- |
 * | item da casa (chave que o jogo não tem) | a lista de itens do jogo |
 * | garantido da casa | a quantidade de um item do jogo |
 * | os perfis ligados à caixa, com chance e teto | o "quanto sai" (itens, scrap, blueprints) |
 * | o travamento de pool e o "ignorar raridade" | |
 *
 * A quantidade editada de um item DO JOGO não sobrevive, e isso é
 * decisão do dono: um servidor que multiplicou 145 linhas à mão
 * volta ao 1x e reaplica o multiplicador, que é um clique. O
 * contrário — preservar cada mín./máx. — faria o "refazer a base"
 * devolver a mesma tabela torta de onde se veio.
 *
 * ####  NADA AQUI DUPLICA, POR CONSTRUÇÃO  ####
 *
 * Caixa, item e perfil são CHAVE de dicionário nos dois lados; o
 * que a base nova já tem não é devolvido, e o que ela não tem entra
 * uma vez só. Rodar duas vezes seguidas dá o mesmo arquivo — que é
 * o que o pedido chama de "repetir a importação sem duplicar".
 */
export function mergeRebuiltTables(
  previous: Record<string, RawObject>,
  baseline: Record<string, RawObject>,
  options: {
    /** Ligar `Is Prefab Enabled?` em toda caixa da base nova. */
    readonly adopt: boolean;
    /** Os perfis que existem no `LootGroups.json`, para achar órfão. */
    readonly profiles: ReadonlySet<string>;
    /**
     * Os prefabs que continuam na lista de vigia depois do reload.
     *
     * É o que separa "o jogo não tem mais este prefab" de "o plugin
     * não o gerou desta vez". Ver `preserved`.
     */
    readonly watched: ReadonlySet<string>;
  },
): { readonly tables: Record<string, RawObject>; readonly report: BetterLootRebuildReport } {
  const tables: Record<string, RawObject> = {};
  const changed: BetterLootRebuiltTable[] = [];
  const adopted: string[] = [];
  const fresh: string[] = [];
  const orphanProfiles = new Set<string>();

  let nativeItems = 0;
  let keptItems = 0;
  let keptProfiles = 0;

  for (const [prefab, base] of Object.entries(baseline)) {
    const old = previous[prefab] ?? null;
    const next: RawObject = { ...base };

    const baseUngrouped = asObject(base[KEY_UNGROUPED]) ?? {};
    const baseGuaranteed = asObject(base[KEY_GUARANTEED]) ?? {};

    const houseItems = houseKeysOf(asObject(old?.[KEY_UNGROUPED]), baseUngrouped, baseGuaranteed);
    const houseGuaranteed = houseKeysOf(
      asObject(old?.[KEY_GUARANTEED]),
      baseUngrouped,
      baseGuaranteed,
    );

    if (houseItems.length > 0) {
      next[KEY_UNGROUPED] = { ...baseUngrouped, ...Object.fromEntries(houseItems) };
    }

    if (houseGuaranteed.length > 0) {
      next[KEY_GUARANTEED] = { ...baseGuaranteed, ...Object.fromEntries(houseGuaranteed) };
    }

    // ####  O VÍNCULO COM O PERFIL É DA CASA, SEMPRE  ####
    //
    // O plugin gera a base com a lista vazia (e, num caso medido,
    // com o `example_group` que ele mesmo criou). Quem ligou perfil
    // numa caixa foi gente, e é o trabalho que mais custa refazer:
    // são treze perfis por caixa nos prints que abriram este
    // pedido. Caixa que a configuração anterior não tinha fica com
    // o que a base trouxe.
    const links = old === null ? base[KEY_PROFILES] : (old[KEY_PROFILES] ?? []);

    next[KEY_PROFILES] = links;

    const names = profileNamesOf(links);
    const orphans = names.filter((name) => !options.profiles.has(name));

    for (const name of orphans) {
      orphanProfiles.add(name);
    }

    // ####  A ADOÇÃO É METADE DA CONTA; A OUTRA ESTÁ NO OUTRO ARQUIVO  ####
    //
    // Aqui vai o `Is Prefab Enabled?`. O `Watched Container
    // Prefabs` é do `BetterLoot.json` e quem o grava é o `rebuild`,
    // no mesmo passo — desligado, ele devolve a caixa ao loot do
    // jogo mesmo com este `true`. Ver `KEY_WATCHED`.
    const wasEnabled = old === null ? null : asBoolean(old[KEY_ENABLED], false);
    const enabled = options.adopt ? true : (wasEnabled ?? asBoolean(base[KEY_ENABLED], true));

    next[KEY_ENABLED] = enabled;

    // Preferências da caixa que a base nova não tem como saber: o
    // plugin as gera no padrão dele. Não são "quanto sai" nem item,
    // e perdê-las em silêncio mudaria o sorteio de quem as ligou.
    if (old !== null) {
      next[KEY_POOL_LOCKING] = asBoolean(old[KEY_POOL_LOCKING], asBoolean(base[KEY_POOL_LOCKING], false));
      next[KEY_IGNORE_RARITY] = asBoolean(
        old[KEY_IGNORE_RARITY],
        asBoolean(base[KEY_IGNORE_RARITY], false),
      );
    }

    tables[prefab] = next;

    const becameAdopted = wasEnabled === false && enabled;

    if (becameAdopted) {
      adopted.push(prefab);
    }

    if (old === null) {
      fresh.push(prefab);
    }

    nativeItems += Object.keys(baseUngrouped).length;
    keptItems += houseItems.length + houseGuaranteed.length;
    keptProfiles += names.length;

    if (
      houseItems.length > 0 ||
      houseGuaranteed.length > 0 ||
      names.length > 0 ||
      becameAdopted ||
      old === null
    ) {
      changed.push({
        prefab,
        nativeItems: Object.keys(baseUngrouped).length,
        keptItems: houseItems.map(([key]) => key),
        keptGuaranteed: houseGuaranteed.map(([key]) => key),
        keptProfiles: names,
        orphanProfiles: orphans,
        adopted: becameAdopted,
        fresh: old === null,
      });
    }
  }

  // O que o plugin não gerou. Continuar na lista de vigia é o que
  // prova que o prefab existe — ver `preserved`.
  const dropped: string[] = [];
  const preserved: string[] = [];

  for (const prefab of Object.keys(previous)) {
    if (prefab in baseline) {
      continue;
    }

    if (options.watched.has(prefab)) {
      tables[prefab] = previous[prefab] as RawObject;
      preserved.push(prefab);
    } else {
      dropped.push(prefab);
    }
  }

  return {
    tables,
    report: {
      mode: 'merge',
      tables: Object.keys(tables).length,
      nativeItems,
      keptItems,
      keptProfiles,
      adopted,
      fresh,
      dropped,
      preserved,
      orphanProfiles: [...orphanProfiles],
      changed,
    },
  };
}

export interface RewriteWait {
  /** De quanto em quanto tempo o disco é perguntado. */
  readonly pollMs: number;
  /** Quanto tempo parado já conta como "acabou de escrever". */
  readonly quietMs: number;
  /** Quanto esperar pela PRIMEIRA mudança antes de desistir. */
  readonly graceMs: number;
  /** O teto de tudo. */
  readonly timeoutMs: number;
}

/**
 * Os tempos de produção.
 *
 * O `graceMs` de 2 s é o que separa "o Oxide ainda está
 * recompilando" de "não vem": o reload do BetterLoot no `server01`
 * leva menos que isso para começar a escrever, e um recompilar mais
 * lento que 2 s custa apenas a tela mostrar a caixa antes da
 * normalização — a revisão POR CAIXA já impede que isso vire
 * conflito na gravação seguinte.
 */
const PRODUCTION_REWRITE_WAIT: RewriteWait = {
  pollMs: 100,
  quietMs: 300,
  graceMs: 2_000,
  timeoutMs: 8_000,
};

/** O que identifica uma versão do arquivo sem lê-lo inteiro. */
interface FileMark {
  readonly mtimeMs: number;
  readonly size: number;
}

async function markOf(path: string): Promise<FileMark | null> {
  try {
    const info = await stat(path);

    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    // Sumiu no meio da reescrita, ou nunca esteve lá. Quem chama
    // trata os dois como "ainda não deu para saber".
    return null;
  }
}

function sameMark(a: FileMark, b: FileMark): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Espera o plugin reescrever o arquivo, e parar.
 *
 * Volta assim que o disco MUDOU em relação ao que gravamos e ficou
 * quieto por `REWRITE_QUIET_MS` — ou no teto, o que vier antes. A
 * exigência de ver a mudança é o que impede voltar cedo demais no
 * intervalo entre o `oxide.reload` e o `Init`.
 */
async function waitForRewrite(
  path: string,
  written: FileMark | null,
  wait: RewriteWait,
): Promise<void> {
  if (written === null || wait.timeoutMs <= 0) {
    return;
  }

  const started = Date.now();
  const deadline = started + wait.timeoutMs;
  let last = written;
  let changedAt: number | null = null;

  while (Date.now() < deadline) {
    await delay(wait.pollMs);

    const now = await markOf(path);

    if (now !== null && !sameMark(now, last)) {
      last = now;
      changedAt = Date.now();

      continue;
    }

    if (changedAt === null) {
      // Ainda não vimos o plugin mexer. Passada a paciência, ele
      // não vai mexer — e o disco já tem o que gravamos.
      if (Date.now() - started >= wait.graceMs) {
        return;
      }

      continue;
    }

    if (Date.now() - changedAt >= wait.quietMs) {
      return;
    }
  }
}

/**
 * A paciência do `rebuild`, que é outra ordem de grandeza.
 *
 * ####  AQUI NÃO É REESCREVER: É GERAR DO ZERO  ####
 *
 * O `LoadAllContainers` varre os prefabs do jogo, resolve a árvore
 * de `LootSpawn` de cada um e serializa 2,5 MB. O reload comum
 * reescreve o que já está na memória em menos de um segundo; este
 * passo é o boot do plugin inteiro, e desistir aos 2 s deixaria o
 * servidor sem `LootTables.json` por engano — que é o único estado
 * de verdade ruim desta operação.
 *
 * O `graceMs` é a espera ATÉ o arquivo nascer, e ele é generoso de
 * propósito: o Oxide ainda pode estar recompilando o plugin.
 */
const REBUILD_WAIT: RewriteWait = {
  pollMs: 200,
  quietMs: 1_000,
  graceMs: 30_000,
  timeoutMs: 120_000,
};

/**
 * Espera o arquivo NASCER, e parar de crescer.
 *
 * Irmão do `waitForRewrite`, para o caso em que o arquivo não
 * existe: `false` = ele não apareceu dentro do tempo, e quem chama
 * tem de devolver o backup.
 */
async function waitForBirth(path: string, wait: RewriteWait): Promise<boolean> {
  const started = Date.now();
  const deadline = started + wait.timeoutMs;
  let last: FileMark | null = null;
  let changedAt: number | null = null;

  while (Date.now() < deadline) {
    await delay(wait.pollMs);

    const now = await markOf(path);

    if (now === null) {
      // Ainda não nasceu. Passada a paciência, ele não vai nascer.
      if (Date.now() - started >= wait.graceMs) {
        return false;
      }

      continue;
    }

    if (last === null || !sameMark(now, last)) {
      last = now;
      changedAt = Date.now();

      continue;
    }

    if (changedAt !== null && Date.now() - changedAt >= wait.quietMs) {
      return true;
    }
  }

  return last !== null;
}

// ------------------------------------------------------------
//  O serviço
// ------------------------------------------------------------

/** As três pastas de um servidor que este editor toca. */
export interface BetterLootPaths {
  readonly oxideConfigDir: string;
  readonly oxideDataDir: string;
  readonly backupsDir: string;
}

/** O que o editor precisa saber dos servidores. E nada além. */
export interface BetterLootServers {
  /** `null` = não existe servidor com este id. */
  configOf(id: string): {
    readonly paths: {
      readonly oxideConfigDir: string;
      readonly oxideDataDir: string;
      readonly backupsDir: string;
    };
  } | null;
}

export interface BetterLootDeps {
  readonly servers: BetterLootServers;
  /** De onde sai a raridade e o nome de cada item. */
  readonly items: ItemsRepository;
  /**
   * Recarrega o plugin naquele servidor.
   *
   * `sent: false` = não deu para mandar (servidor parado, plugin
   * fora do ar). NÃO é erro: o arquivo está gravado, e o BetterLoot
   * o lê no próximo load. Recusar aqui obrigaria a subir o jogo
   * para editar loot — que é justamente o trabalho de madrugada.
   */
  readonly reload: (serverId: string) => Promise<{ readonly sent: boolean; readonly output: string | null }>;
  /**
   * Quanto esperar o plugin reescrever o arquivo depois do reload.
   *
   * Existe para o TESTE, e só: sem um Oxide de verdade do outro
   * lado ninguém reescreve nada, e cada gravação pagaria a espera
   * inteira à toa. Ver `waitForRewrite` para o que cada número
   * significa; omitido, valem os de produção.
   */
  readonly rewriteWait?: RewriteWait;
}

/** O que o `saveGlobals` devolve. Os globais vêm RELIDOS do disco. */
export interface BetterLootGlobalsSaveResult {
  /** O sha256 novo do `BetterLoot.json`. */
  readonly revision: string;
  /** `null` = o arquivo ficou ilegível. A tela mostra travessão. */
  readonly globals: BetterLootGlobals | null;
  /** Onde ficou a cópia da configuração anterior. `null` = não havia. */
  readonly backup: string | null;
  readonly reloaded: boolean;
  readonly reloadOutput: string | null;
}

/** O que o `save` devolve. A tabela vem RELIDA do disco. */
export interface BetterLootSaveResult {
  /** A revisão DESTA CAIXA, já com o que o plugin reescreveu. */
  readonly tableRevision: string;
  /** A do arquivo inteiro — para a lista, e não para gravar. */
  readonly fileRevision: string;
  readonly table: BetterLootTable;
  /**
   * A lista de vigia do `BetterLoot.json` foi mexida?
   *
   * A tela diz isso por extenso porque é a metade da adoção que
   * não está no arquivo que ela edita — e porque um `true` aqui
   * significa que o `configRevision` que a faixa de globais está
   * segurando ficou velho.
   */
  readonly watchedChanged: boolean;
  /** Onde ficou a cópia do arquivo anterior. `null` = não havia. */
  readonly backup: string | null;
  readonly reloaded: boolean;
  readonly reloadOutput: string | null;
}

/** O que o `rebuild` devolve. */
export interface BetterLootRebuildResult {
  readonly report: BetterLootRebuildReport;
  /** Onde ficaram as cópias dos três arquivos, antes de tudo. */
  readonly backups: readonly string[];
  /** A revisão do `LootTables.json` como ele ficou. */
  readonly revision: string;
  /** Caixas postas na lista de vigia do `BetterLoot.json`. */
  readonly watchedAdded: number;
  readonly reloaded: boolean;
  readonly reloadOutput: string | null;
}

export class BetterLootEditor {
  readonly #deps: BetterLootDeps;

  constructor(deps: BetterLootDeps) {
    this.#deps = deps;
  }

  #rewriteWait(): RewriteWait {
    return this.#deps.rewriteWait ?? PRODUCTION_REWRITE_WAIT;
  }

  /** A lista de caixas, os globais e a blacklist daquele servidor. */
  async status(serverId: string): Promise<BetterLootStatus> {
    const paths = this.#pathsOf(serverId);

    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);

    if (file === null) {
      // O plugin nunca rodou aqui. Não é erro: é o estado do
      // `server01` hoje, e a tela precisa poder dizer isso.
      return {
        configured: false,
        readAt: null,
        revision: null,
        configRevision: null,
        globals: null,
        blacklist: [],
        tables: [],
      };
    }

    const parsed = parseLootTables(file.text, this.#whereTables(serverId));

    const [config, blacklist] = await Promise.all([
      this.#readGlobals(paths.oxideConfigDir),
      this.#readBlacklist(paths.oxideDataDir),
    ]);

    return {
      configured: true,
      readAt: new Date().toISOString(),
      revision: parsed.revision,
      configRevision: config.revision,
      globals: config.globals,
      blacklist,
      // A ordem é a do arquivo, e o arquivo nasce na ordem em que o
      // plugin varreu os prefabs. Ordenar aqui seria escolher por
      // uma tela que já sabe agrupar e rotular sozinha.
      tables: Object.entries(parsed.tables).map(([prefab, raw]) =>
        toSummary(prefab, raw, config.watched),
      ),
    };
  }

  /**
   * Uma caixa inteira.
   *
   * A `tableRevision` que sai daqui é a que o PUT quer de volta —
   * ver `tableRevisionOf`. A do arquivo inteiro fica no `status`,
   * onde ela ainda diz alguma coisa (a lista mudou), e não serve
   * mais de trava para gravar caixa.
   */
  async table(
    serverId: string,
    prefab: string,
  ): Promise<{ readonly tableRevision: string; readonly table: BetterLootTable }> {
    const paths = this.#pathsOf(serverId);
    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);

    if (file === null) {
      throw this.#notConfigured(serverId);
    }

    const parsed = parseLootTables(file.text, this.#whereTables(serverId));
    const raw = parsed.tables[prefab];

    if (raw === undefined) {
      throw new ApiError(
        'BETTERLOOT_TABLE_NOT_FOUND',
        `A tabela de loot de "${prefab}" não está no LootTables.json de "${serverId}". A chave é ` +
          'o CAMINHO INTEIRO do prefab (assets/bundled/prefabs/...), e não o nome curto.',
        404,
      );
    }

    const config = await this.#readGlobals(paths.oxideConfigDir);

    return {
      tableRevision: tableRevisionOf(raw),
      table: toTable(prefab, raw, this.#catalog(), config.watched),
    };
  }

  /**
   * Grava a caixa, recarrega o plugin e RELÊ o disco.
   *
   * A ordem é toda a segurança disto:
   *
   *   1. ler o arquivo de agora e conferir a revisão — quem abriu
   *      a tela antes de outra pessoa gravar é recusado ANTES de
   *      qualquer escrita;
   *   2. copiar o que está lá para `Backups\<id>\oxide-data\`;
   *   3. gravar o arquivo inteiro, com a caixa editada no lugar;
   *   4. `oxide.reload BetterLoot`, se der;
   *   5. RELER do disco — o `scanEntry` reescreveu o que gravamos.
   */
  async save(
    serverId: string,
    input: { readonly baseRevision: string | null; readonly table: BetterLootTable },
  ): Promise<BetterLootSaveResult> {
    const paths = this.#pathsOf(serverId);
    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);

    if (file === null) {
      throw this.#notConfigured(serverId);
    }

    const current = parseLootTables(file.text, this.#whereTables(serverId));

    // ####  A REVISÃO É CONFERIDA ANTES DE TUDO  ####
    //
    // Salvar substitui o arquivo inteiro, mas o CONTEÚDO desta
    // caixa é a única parte que esta gravação decide — o resto é
    // copiado do disco de agora, logo abaixo. Por isso a conferência
    // é da caixa, e não do arquivo: duas telas na mesma caixa
    // continuam sendo pegas, e duas telas em caixas diferentes
    // param de brigar por nada.
    //
    // Ela também é o que faz a reescrita do próprio plugin deixar
    // de virar conflito. Ver `tableRevisionOf` e `waitForRewrite`.
    const currentRevision = tableRevisionOf(current.tables[input.table.prefab] ?? null);

    if (input.baseRevision !== null && input.baseRevision !== currentRevision) {
      throw new ApiError(
        'BETTERLOOT_STALE_REVISION',
        `A caixa "${input.table.prefab}" mudou no disco depois que esta tela a abriu — outra ` +
          'pessoa gravou, ou ela foi editada à mão. Nada foi alterado: recarregue a caixa e ' +
          'refaça a edição em cima do que está lá.',
        409,
      );
    }

    const next = {
      ...current.root,
      [KEY_TABLES]: {
        ...current.tables,
        [input.table.prefab]: applyTable(current.tables[input.table.prefab] ?? null, input.table),
      },
    };

    // Duas casas de indentação: é o que o Newtonsoft escreve com
    // `Formatting.Indented`, e manter o formato deixa o `diff` de
    // um backup contra o outro legível.
    const text = JSON.stringify(next, null, 2);

    if (Buffer.byteLength(text, 'utf8') > MAX_LOOT_TABLES_BYTES) {
      throw new ApiError(
        'BETTERLOOT_FILE_TOO_LARGE',
        `A tabela ficaria com ${String(
          Math.round(Buffer.byteLength(text, 'utf8') / 1024 / 1024),
        )} MB e o limite é ${String(MAX_LOOT_TABLES_BYTES / 1024 / 1024)} MB. Nada foi alterado.`,
        400,
      );
    }

    const backup = await backupPluginDataFile(
      paths.oxideDataDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
      Date.now(),
    );

    await writePluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE, text);

    const tablesPath = pluginDataPath(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);
    const written = await markOf(tablesPath);

    // ####  O SEGUNDO INTERRUPTOR VAI ANTES DO RELOAD  ####
    //
    // Ele mora no OUTRO arquivo (`BetterLoot.json`), e o plugin lê
    // os dois no mesmo carregamento. Gravá-lo depois do reload
    // faria a adoção da caixa só valer no reload SEGUINTE — e a
    // tela, relendo em seguida, mostraria a caixa adotada num
    // servidor que ainda entrega o loot do jogo.
    const watchedChanged = await this.#applyWatched(
      serverId,
      paths,
      input.table.prefab,
      input.table.watched,
    );

    const reload = await this.#deps.reload(serverId);

    // ####  ESPERAR O PLUGIN TERMINAR É PARTE DA GRAVAÇÃO  ####
    //
    // Só quando ele mandou o reload e o plugin compilou: servidor
    // parado não reescreve nada, e plugin que não compilou também
    // não. Esperar nesses dois casos seria segurar a tela por seis
    // segundos para reler o que já está na mão.
    if (reload.sent && !reloadFailed(reload.output)) {
      await waitForRewrite(tablesPath, written, this.#rewriteWait());
    }

    // ####  A RESPOSTA VEM DO DISCO, E NÃO DO QUE ENVIAMOS  ####
    //
    // O `scanEntry` reescreve durabilidade, propriedades e "pode
    // virar blueprint" ao validar. Devolver o rascunho faria a tela
    // mostrar ao admin o que ele pediu, e não o que o servidor tem.
    const after = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
    );

    if (after === null) {
      throw new ApiError(
        'BETTERLOOT_READ_BACK_FAILED',
        `Gravei ${this.#whereTables(serverId)} e ele sumiu na releitura. A cópia anterior está ` +
          `em ${backup ?? '(não havia arquivo para copiar)'}.`,
        500,
      );
    }

    const reread = parseLootTables(after.text, this.#whereTables(serverId));
    const raw = reread.tables[input.table.prefab] ?? null;

    // O `BetterLoot.json` também é reescrito pelo plugin ao
    // carregar (`MaybeUpdateConfigDict`), então a lista de vigia da
    // resposta é relida do disco pelo mesmo motivo da tabela.
    const config = await this.#readGlobals(paths.oxideConfigDir);

    return {
      // A revisão da caixa COMO ELA FICOU — depois do plugin. É
      // ela que o próximo "Gravar" desta mesma tela devolve, e é
      // por isso que a espera acima não é opcional.
      tableRevision: tableRevisionOf(raw),
      fileRevision: reread.revision,
      table:
        raw === null
          ? input.table
          : toTable(input.table.prefab, raw, this.#catalog(), config.watched),
      watchedChanged,
      backup,
      reloaded: reload.sent,
      reloadOutput: reload.output,
    };
  }

  /**
   * Refaz a base inteira, pelo próprio plugin.
   *
   * ####  OS PASSOS, E POR QUE NESTA ORDEM  ####
   *
   *   1. lê o que está no disco — é o que vai ser preservado;
   *   2. copia os três arquivos para `Backups\<id>\`;
   *   3. LIGA a lista de vigia, se for para adotar (ver abaixo);
   *   4. APAGA o `LootTables.json` (e o `LootGroups.json`, no
   *      `factory`);
   *   5. recarrega o plugin, que o gera de novo do jogo de agora;
   *   6. devolve por cima o que era da casa (`mergeRebuiltTables`);
   *   7. grava, completa a lista de vigia e recarrega outra vez,
   *      para o plugin validar o que foi escrito.
   *
   * ####  O PASSO 3 VEM ANTES DE GERAR, E NÃO DEPOIS  ####
   *
   * O `LoadAllContainers` percorre a LISTA DE VIGIA, e não o mundo:
   * prefab que não está lá não é gerado. Pior, ele pula a geração
   * de NPC cujo prefab está lá como `false` (BetterLoot.cs:1934) —
   * e é justamente a caixa marcada "JOGO" que este botão existe
   * para consertar. Adotar depois faria a base nova nascer sem
   * exatamente aquilo que se foi buscar.
   *
   * O passo 7 ainda é preciso porque o `CheckWatchedPrefabs` roda
   * no load e pode ACRESCENTAR prefab novo à lista, desligado.
   *
   * ####  O PASSO 4 É O ÚNICO CAMINHO QUE EXISTE  ####
   *
   * O BetterLoot não tem comando de "regenerar": ele só lê a tabela
   * nativa quando NÃO encontra a entrada ao carregar. Por isso o
   * arquivo sai da frente — e por isso o passo 2 não é opcional. Se
   * o reload não for, ou o plugin não gerar nada, o backup volta
   * para o lugar antes de esta função lançar.
   *
   * ####  E POR ISSO ELE EXIGE O SERVIDOR NO AR  ####
   *
   * É a segunda operação desta tela que exige (a outra é ler o loot
   * nativo de uma caixa). Todo o resto é disco. Quem gera a base é
   * o plugin, e plugin parado não gera nada.
   *
   * @throws {ApiError} 404 servidor desconhecido; 503 quando o
   * plugin não recarregou ou não gerou a base — e aí nada mudou.
   */
  async rebuild(
    serverId: string,
    input: { readonly mode: BetterLootRebuildMode; readonly adopt: boolean },
  ): Promise<BetterLootRebuildResult> {
    const paths = this.#pathsOf(serverId);
    const wait = this.#deps.rewriteWait ?? REBUILD_WAIT;
    const tablesPath = pluginDataPath(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);

    const beforeTables = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
    );
    const beforeGroups = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_GROUPS_FILE,
    );

    // O que vai ser devolvido por cima da base nova. Lido ANTES de
    // qualquer escrita: depois do passo 3 ele não existe mais em
    // lugar nenhum além do backup.
    const previous =
      beforeTables === null
        ? {}
        : parseLootTables(beforeTables.text, this.#whereTables(serverId)).tables;
    const profiles = new Set(
      beforeGroups === null
        ? []
        : Object.keys(parseLootGroups(beforeGroups.text, this.#whereGroups(serverId)).groups),
    );

    const at = Date.now();
    const backups: string[] = [];

    for (const file of [LOOT_TABLES_FILE, LOOT_GROUPS_FILE]) {
      const copy = await backupPluginDataFile(
        paths.oxideDataDir,
        paths.backupsDir,
        BETTERLOOT_PLUGIN,
        file,
        at,
      );

      if (copy !== null) {
        backups.push(copy);
      }
    }

    const beforeConfig = await readPluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN);
    const configCopy = await backupPluginConfig(
      paths.oxideConfigDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      at,
    );

    if (configCopy !== null) {
      backups.push(configCopy);
    }

    // ####  A VIGIA ANTES DE GERAR, E SÓ QUEM JÁ ESTÁ NELA  ####
    //
    // É ela que o `LoadAllContainers` percorre — ver o cabeçalho.
    // Acrescentar aqui os prefabs da TABELA velha seria tentador e
    // estaria errado: o `CheckWatchedPrefabs` mantém esta lista
    // sincronizada com o mundo, então prefab que está na tabela e
    // não está aqui é prefab que o jogo não tem mais. Ele voltaria
    // à lista só para o plugin removê-lo de novo no mesmo load — e,
    // no caminho, seria contado como caixa adotada.
    const watchedBefore = input.adopt
      ? await this.#adoptAll(
          serverId,
          paths,
          beforeConfig === null ? [] : [...(toWatched(beforeConfig.text)?.keys() ?? [])],
        )
      : 0;

    await deletePluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE);

    if (input.mode === 'factory') {
      // Os perfis também. É a diferença inteira entre os dois
      // modos, e o que o dono chamou de "zerar e editar do zero".
      await deletePluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);
    }

    const reload = await this.#deps.reload(serverId);
    const failed = reloadFailed(reload.output);
    const born = reload.sent && !failed ? await waitForBirth(tablesPath, wait) : false;

    if (!born) {
      await this.#restore(
        paths,
        [
          [LOOT_TABLES_FILE, beforeTables?.text ?? null],
          [LOOT_GROUPS_FILE, input.mode === 'factory' ? (beforeGroups?.text ?? null) : null],
        ],
        // A adoção do passo 3 também desfaz: "nada foi alterado"
        // precisa valer para os TRÊS arquivos, e não só para os
        // dois que a frase lembra.
        watchedBefore > 0 ? (beforeConfig?.text ?? null) : null,
      );

      throw new ApiError(
        'BETTERLOOT_REBUILD_FAILED',
        !reload.sent
          ? `Não deu para recarregar o BetterLoot em "${serverId}" — o servidor precisa estar no ` +
              'ar, porque quem gera a base nova é o plugin lendo o jogo. Os arquivos foram ' +
              `devolvidos como estavam; a cópia também está em ${backups[0] ?? '(não havia)'}.`
          : failed
            ? `O BetterLoot não recarregou em "${serverId}": ${(reload.output ?? '').trim().slice(0, 300)}. ` +
              'Os arquivos foram devolvidos como estavam.'
            : `O BetterLoot recarregou em "${serverId}" e não gerou o LootTables.json em ` +
              `${String(Math.round(wait.graceMs / 1000))} s. Os arquivos foram devolvidos como ` +
              'estavam — confira se o plugin está carregado e tente de novo.',
        503,
      );
    }

    const after = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
    );

    if (after === null) {
      await this.#restore(
        paths,
        [[LOOT_TABLES_FILE, beforeTables?.text ?? null]],
        watchedBefore > 0 ? (beforeConfig?.text ?? null) : null,
      );

      throw new ApiError(
        'BETTERLOOT_REBUILD_FAILED',
        `O BetterLoot gerou ${this.#whereTables(serverId)} e ele sumiu na leitura. Os arquivos ` +
          'foram devolvidos como estavam.',
        503,
      );
    }

    const baseline = parseLootTables(after.text, this.#whereTables(serverId));

    // A lista de vigia DEPOIS do reload: o plugin acabou de tirar
    // dela os prefabs que o jogo não tem mais, e é essa diferença
    // que separa "caixa extinta" de "caixa que ele não gerou".
    const afterConfig = await readPluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN);
    const stillWatched = new Set(
      afterConfig === null ? [] : [...(toWatched(afterConfig.text)?.keys() ?? [])],
    );

    // No `factory` nada é devolvido: a base nova é a resposta
    // inteira. O merge ainda passa por aqui porque é ele quem liga
    // o `Is Prefab Enabled?` de todas.
    const merged = mergeRebuiltTables(
      input.mode === 'factory' ? {} : previous,
      baseline.tables,
      {
        adopt: input.adopt,
        profiles: input.mode === 'factory' ? new Set<string>() : profiles,
        watched: stillWatched,
      },
    );

    const text = JSON.stringify({ ...baseline.root, [KEY_TABLES]: merged.tables }, null, 2);

    if (Buffer.byteLength(text, 'utf8') > MAX_LOOT_TABLES_BYTES) {
      await this.#restore(
        paths,
        [[LOOT_TABLES_FILE, beforeTables?.text ?? null]],
        watchedBefore > 0 ? (beforeConfig?.text ?? null) : null,
      );

      throw new ApiError(
        'BETTERLOOT_FILE_TOO_LARGE',
        `A base nova ficaria com ${String(
          Math.round(Buffer.byteLength(text, 'utf8') / 1024 / 1024),
        )} MB e o limite é ${String(MAX_LOOT_TABLES_BYTES / 1024 / 1024)} MB. Os arquivos foram ` +
          'devolvidos como estavam.',
        400,
      );
    }

    await writePluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE, text);

    const written = await markOf(tablesPath);

    // A vigia outra vez, agora com os prefabs que o plugin
    // ACRESCENTOU à lista ao carregar (`CheckWatchedPrefabs`) — ele
    // os cadastra desligados quando a configuração já existia. É o
    // que deixa a caixa nova gerenciável sem um segundo clique.
    const watchedAdded =
      watchedBefore +
      (input.adopt ? await this.#adoptAll(serverId, paths, Object.keys(merged.tables)) : 0);

    const settle = await this.#deps.reload(serverId);

    if (settle.sent && !reloadFailed(settle.output)) {
      await waitForRewrite(tablesPath, written, this.#rewriteWait());
    }

    const final = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
    );

    return {
      report:
        input.mode === 'factory'
          ? {
              ...merged.report,
              mode: 'factory',
              // No `factory` não existe "preservado" nem "adotado":
              // não havia de onde preservar, e toda caixa é nova por
              // definição. Contá-las encheria a tela de ruído.
              keptItems: 0,
              keptProfiles: 0,
              adopted: [],
              fresh: [],
              dropped: [],
              preserved: [],
              orphanProfiles: [],
              changed: [],
            }
          : merged.report,
      backups,
      revision:
        final === null
          ? baseline.revision
          : parseLootTables(final.text, this.#whereTables(serverId)).revision,
      watchedAdded,
      reloaded: settle.sent,
      reloadOutput: settle.output,
    };
  }

  /**
   * Devolve ao disco o que estava lá antes do `rebuild`.
   *
   * Só é chamado quando a operação abortou no meio. Texto `null` =
   * o arquivo não existia antes, e então não existir agora é o
   * estado certo.
   */
  async #restore(
    paths: BetterLootPaths,
    files: readonly (readonly [string, string | null])[],
    config: string | null,
  ): Promise<void> {
    for (const [file, text] of files) {
      if (text !== null) {
        await writePluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, file, text);
      }
    }

    if (config !== null) {
      await writePluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN, config);
    }
  }

  /**
   * Põe TODAS as caixas na lista de vigia, numa escrita só.
   *
   * Devolve quantas entraram. Zero = já estavam todas lá, e aí o
   * arquivo não é tocado — reescrevê-lo por nada mudaria o
   * `configRevision` que a faixa de globais está segurando.
   */
  async #adoptAll(
    serverId: string,
    paths: BetterLootPaths,
    prefabs: readonly string[],
  ): Promise<number> {
    const current = await readPluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN);
    const list = current === null ? null : toWatched(current.text);
    const missing = prefabs.filter((prefab) => (list?.get(prefab) ?? false) !== true);

    if (missing.length === 0) {
      return 0;
    }

    await backupPluginConfig(
      paths.oxideConfigDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      Date.now(),
    );

    await writePluginConfig(
      paths.oxideConfigDir,
      BETTERLOOT_PLUGIN,
      applyWatchedAll(
        current?.text ?? null,
        new Map(missing.map((prefab) => [prefab, true])),
        this.#whereConfig(serverId),
      ),
    );

    return missing.length;
  }

  /**
   * Põe (ou tira) a caixa da lista de vigia do `BetterLoot.json`.
   *
   * Devolve `true` se o arquivo mudou. Não mexer é o caminho
   * comum: o admin edita item numa caixa já adotada dezenas de
   * vezes para cada vez que ele adota uma.
   *
   * `watched: null` é "a tela não sabe" — ela leu de um servidor
   * sem `BetterLoot.json` — e nunca vira escrita.
   */
  async #applyWatched(
    serverId: string,
    paths: BetterLootPaths,
    prefab: string,
    watched: boolean | null,
  ): Promise<boolean> {
    if (watched === null) {
      return false;
    }

    const current = await readPluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN);
    const list = current === null ? null : toWatched(current.text);

    // Já está como se quer. Reescrever o arquivo por nada faria o
    // `configRevision` mudar e a faixa de globais, aberta na mesma
    // tela, recusar o próximo salvamento por um conflito que não
    // existiu.
    if (list !== null && (list.get(prefab) ?? false) === watched) {
      return false;
    }

    await backupPluginConfig(
      paths.oxideConfigDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      Date.now(),
    );

    await writePluginConfig(
      paths.oxideConfigDir,
      BETTERLOOT_PLUGIN,
      applyWatched(current?.text ?? null, prefab, watched, this.#whereConfig(serverId)),
    );

    return true;
  }

  // ----------------------------------------------------------
  //  Os PERFIS
  // ----------------------------------------------------------

  /**
   * A lista de perfis daquele servidor, com o uso de cada um.
   *
   * ####  ELA LÊ OS DOIS ARQUIVOS  ####
   *
   * O perfil está no `LootGroups.json`; QUEM O USA está no
   * `LootTables.json`. A tela precisa dos dois na mesma resposta
   * porque a pergunta que ela faz — "posso apagar este?" — não cabe
   * em nenhum dos arquivos sozinho.
   */
  async profiles(serverId: string): Promise<{
    readonly configured: boolean;
    readonly revision: string | null;
    readonly profiles: readonly BetterLootProfileSummary[];
  }> {
    const paths = this.#pathsOf(serverId);

    const [groupsFile, tablesFile] = await Promise.all([
      readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE),
      readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_TABLES_FILE),
    ]);

    // Arquivo ausente é lista vazia, e não erro: um servidor sem
    // perfil nenhum é o estado normal de quem nunca criou um.
    const parsed =
      groupsFile === null
        ? emptyLootGroups()
        : parseLootGroups(groupsFile.text, this.#whereGroups(serverId));

    const usage =
      tablesFile === null
        ? new Map<string, string[]>()
        : usageOfProfiles(parseLootTables(tablesFile.text, this.#whereTables(serverId)).tables);

    return {
      configured: groupsFile !== null,
      revision: groupsFile === null ? null : parsed.revision,
      profiles: Object.entries(parsed.groups).map(([name, raw]) => ({
        name,
        enabled: asBoolean(raw[KEY_GROUP_ENABLED], true),
        itemCount: Object.keys(asObject(raw[KEY_ITEM_LIST]) ?? {}).length,
        guaranteedCount: Object.keys(asObject(raw[KEY_GUARANTEED]) ?? {}).length,
        probabilitySum: probabilitySumOf(raw),
        usedBy: usage.get(name) ?? [],
        revision: profileRevisionOf(raw),
      })),
    };
  }

  /** Um perfil inteiro. */
  async profile(
    serverId: string,
    name: string,
  ): Promise<{ readonly revision: string; readonly profile: BetterLootProfile }> {
    const paths = this.#pathsOf(serverId);
    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);

    const parsed =
      file === null ? emptyLootGroups() : parseLootGroups(file.text, this.#whereGroups(serverId));

    const raw = parsed.groups[name];

    if (raw === undefined) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_NOT_FOUND',
        `O perfil de loot "${name}" não está no LootGroups.json de "${serverId}".`,
        404,
      );
    }

    return { revision: profileRevisionOf(raw), profile: toProfile(name, raw, this.#catalog()) };
  }

  /**
   * Cria ou grava um perfil.
   *
   * `baseRevision: null` = a tela está CRIANDO. Se já houver um
   * perfil com esse nome, é recusado — dois admins criando "armas"
   * ao mesmo tempo não podem virar um sobrescrevendo o outro.
   */
  async saveProfile(
    serverId: string,
    input: { readonly baseRevision: string | null; readonly profile: BetterLootProfile },
  ): Promise<{
    readonly revision: string;
    readonly profile: BetterLootProfile;
    readonly backup: string | null;
    readonly reloaded: boolean;
    readonly reloadOutput: string | null;
  }> {
    const paths = this.#pathsOf(serverId);
    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);

    const current =
      file === null ? emptyLootGroups() : parseLootGroups(file.text, this.#whereGroups(serverId));

    const before = current.groups[input.profile.name] ?? null;

    if (input.baseRevision === null && before !== null) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_EXISTS',
        `Já existe um perfil de loot chamado "${input.profile.name}" neste servidor. Escolha ` +
          'outro nome, ou abra o que está lá para editá-lo. Nada foi alterado.',
        409,
      );
    }

    if (input.baseRevision !== null && input.baseRevision !== profileRevisionOf(before)) {
      throw new ApiError(
        'BETTERLOOT_STALE_REVISION',
        `O perfil "${input.profile.name}" mudou no disco depois que esta tela o abriu — outra ` +
          'pessoa gravou, ou o próprio BetterLoot o rebalanceou ao carregar. Nada foi alterado: ' +
          'recarregue o perfil e refaça a edição em cima do que está lá.',
        409,
      );
    }

    const next = {
      ...current.root,
      [KEY_GROUPS]: {
        ...current.groups,
        [input.profile.name]: applyProfile(before, input.profile),
      },
    };

    return this.#writeGroups(serverId, paths, next, input.profile.name);
  }

  /**
   * Renomeia um perfil, e reescreve quem o cita.
   *
   * ####  O NOME É A CHAVE, E ELE MORA EM DOIS ARQUIVOS  ####
   *
   * No `LootGroups.json` ele é a CHAVE do dicionário; no
   * `LootTables.json` ele é citado por nome dentro do `Loot
   * Profiles` de cada caixa que sorteia daquele perfil. Trocar só o
   * primeiro deixaria toda caixa pedindo um perfil que não existe —
   * e o BetterLoot ignora a citação órfã em silêncio, resmungando
   * no log (`:1031`). O admin só descobriria abrindo a caixa.
   *
   * Por isso renomear NÃO é uma edição de campo: é uma operação que
   * atravessa os dois arquivos, e é ela que o botão "Renomear" da
   * tela chama.
   *
   * ####  A ORDEM DAS CHAVES É PRESERVADA  ####
   *
   * Renomear uma chave em JavaScript a joga para o fim do objeto. O
   * arquivo continuaria correto, mas o `diff` de um backup contra o
   * outro mostraria o dicionário inteiro remexido em vez da linha
   * que mudou — e é nesse diff que alguém confere o que foi feito.
   */
  async renameProfile(
    serverId: string,
    input: {
      readonly from: string;
      readonly to: string;
      readonly baseRevision: string | null;
    },
  ): Promise<{
    readonly revision: string;
    readonly profile: BetterLootProfile;
    /** As caixas cuja citação foi reescrita. */
    readonly retargeted: readonly string[];
    readonly backup: string | null;
    readonly reloaded: boolean;
    readonly reloadOutput: string | null;
  }> {
    const paths = this.#pathsOf(serverId);
    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);

    const current =
      file === null ? emptyLootGroups() : parseLootGroups(file.text, this.#whereGroups(serverId));

    const before = current.groups[input.from];

    if (before === undefined) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_NOT_FOUND',
        `O perfil de loot "${input.from}" não está no LootGroups.json de "${serverId}".`,
        404,
      );
    }

    if (input.to === input.from) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_SAME_NAME',
        `O perfil já se chama "${input.to}". Nada foi alterado.`,
        400,
      );
    }

    if (current.groups[input.to] !== undefined) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_EXISTS',
        `Já existe um perfil chamado "${input.to}" neste servidor. Renomear por cima dele juntaria ` +
          'os dois numa entrada só e apagaria o conteúdo de um. Escolha outro nome. Nada foi ' +
          'alterado.',
        409,
      );
    }

    if (input.baseRevision !== null && input.baseRevision !== profileRevisionOf(before)) {
      throw new ApiError(
        'BETTERLOOT_STALE_REVISION',
        `O perfil "${input.from}" mudou no disco depois que esta tela o abriu — outra pessoa ` +
          'gravou, ou o próprio BetterLoot o rebalanceou ao carregar. Nada foi alterado: ' +
          'recarregue o perfil e refaça a edição em cima do que está lá.',
        409,
      );
    }

    // A chave nova ocupa o LUGAR da antiga. Ver o cabeçalho.
    const groups: Record<string, RawObject> = {};

    for (const [name, raw] of Object.entries(current.groups)) {
      groups[name === input.from ? input.to : name] = raw;
    }

    const tablesFile = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
    );

    const tables =
      tablesFile === null ? null : parseLootTables(tablesFile.text, this.#whereTables(serverId));

    const usedBy = tables === null ? [] : (usageOfProfiles(tables.tables).get(input.from) ?? []);

    // ####  OS GRUPOS PRIMEIRO, E O RELOAD SÓ NO FIM  ####
    //
    // Recarregar entre as duas escritas faria o plugin ver, por um
    // instante, caixas pedindo o nome antigo que já não existe — e
    // ele reescreveria o arquivo em cima disso. Um reload só, depois
    // dos dois arquivos no lugar.
    const written = await this.#writeGroups(
      serverId,
      paths,
      { ...current.root, [KEY_GROUPS]: groups },
      input.to,
      { reload: usedBy.length === 0 },
    );

    if (usedBy.length === 0 || tables === null) {
      return {
        revision: written.revision,
        profile: written.profile,
        retargeted: [],
        backup: written.backup,
        reloaded: written.reloaded,
        reloadOutput: written.reloadOutput,
      };
    }

    const nextTables: Record<string, RawObject> = { ...tables.tables };

    for (const prefab of usedBy) {
      const raw = nextTables[prefab];

      if (raw !== undefined) {
        nextTables[prefab] = retargetProfileLinks(raw, input.from, input.to);
      }
    }

    const tablesBackup = await backupPluginDataFile(
      paths.oxideDataDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
      Date.now(),
    );

    await writePluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
      JSON.stringify({ ...tables.root, [KEY_TABLES]: nextTables }, null, 2),
    );

    const reload = await this.#deps.reload(serverId);

    // O perfil é RELIDO depois do reload, como em toda gravação
    // daqui: se o plugin rebalanceou ao carregar, é o rebalanceado
    // que a tela mostra.
    const after = await this.profile(serverId, input.to);

    return {
      revision: after.revision,
      profile: after.profile,
      retargeted: usedBy,
      backup: tablesBackup ?? written.backup,
      reloaded: reload.sent,
      reloadOutput: reload.output,
    };
  }

  /**
   * Apaga um perfil.
   *
   * ####  APAGAR SEM OLHAR AS CAIXAS É DEIXAR LIXO NO DISCO  ####
   *
   * A associação mora no `LootTables.json`, e o perfil apagado
   * continua sendo pedido lá. O plugin resmunga no log e ignora — o
   * admin só descobre que perdeu o ajuste quando abre a caixa.
   *
   * Por isso o `detach` é OBRIGATÓRIO quando o perfil está em uso:
   * sem ele, a resposta é 409 com os nomes das caixas, para a tela
   * poder perguntar antes. É o que o Looty não faz.
   */
  async deleteProfile(
    serverId: string,
    input: { readonly name: string; readonly detach: boolean },
  ): Promise<{
    readonly detached: readonly string[];
    readonly backup: string | null;
    readonly reloaded: boolean;
    readonly reloadOutput: string | null;
  }> {
    const paths = this.#pathsOf(serverId);
    const file = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);

    const current =
      file === null ? emptyLootGroups() : parseLootGroups(file.text, this.#whereGroups(serverId));

    if (current.groups[input.name] === undefined) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_NOT_FOUND',
        `O perfil de loot "${input.name}" não está no LootGroups.json de "${serverId}".`,
        404,
      );
    }

    const tablesFile = await readPluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
    );

    const tables =
      tablesFile === null
        ? null
        : parseLootTables(tablesFile.text, this.#whereTables(serverId));

    const usedBy = tables === null ? [] : (usageOfProfiles(tables.tables).get(input.name) ?? []);

    if (usedBy.length > 0 && !input.detach) {
      throw new ApiError(
        'BETTERLOOT_PROFILE_IN_USE',
        `O perfil "${input.name}" está em ${String(usedBy.length)} caixa(s): ` +
          `${usedBy.map((prefab) => shortPrefabOf(prefab)).join(', ')}. Apagá-lo deixaria essas ` +
          'caixas pedindo um perfil que não existe — o BetterLoot as ignora e o ajuste se perde. ' +
          'Nada foi alterado.',
        409,
      );
    }

    const groups = { ...current.groups };

    delete groups[input.name];

    const written = await this.#writeGroups(
      serverId,
      paths,
      { ...current.root, [KEY_GROUPS]: groups },
      input.name,
      // Um reload só no fim: as caixas ainda vão ser reescritas
      // logo abaixo, e recarregar duas vezes seguidas faria o
      // mundo perder contêineres duas vezes (Docs/CustomItem/07 §1).
      { reload: usedBy.length === 0 },
    );

    if (usedBy.length === 0 || tables === null) {
      return {
        detached: [],
        backup: written.backup,
        reloaded: written.reloaded,
        reloadOutput: written.reloadOutput,
      };
    }

    // ####  E AGORA AS CAIXAS  ####
    //
    // Tirar o nome de cada `Loot Profiles` é o que faz "apaguei o
    // perfil" ser verdade no jogo, e não só no arquivo dele.
    const nextTables: Record<string, RawObject> = { ...tables.tables };

    for (const prefab of usedBy) {
      const raw = nextTables[prefab];

      if (raw === undefined) {
        continue;
      }

      // `null` = tirar a citação. O mesmo helper do `renameProfile`:
      // dois trechos que montam o `Loot Profiles` divergiriam na
      // primeira vez que o plugin ganhasse um campo.
      nextTables[prefab] = retargetProfileLinks(raw, input.name, null);
    }

    const tablesBackup = await backupPluginDataFile(
      paths.oxideDataDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
      Date.now(),
    );

    await writePluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_TABLES_FILE,
      JSON.stringify({ ...tables.root, [KEY_TABLES]: nextTables }, null, 2),
    );

    const reload = await this.#deps.reload(serverId);

    return {
      detached: usedBy,
      backup: tablesBackup ?? written.backup,
      reloaded: reload.sent,
      reloadOutput: reload.output,
    };
  }

  /** Grava o `LootGroups.json`, recarrega e relê. */
  async #writeGroups(
    serverId: string,
    paths: BetterLootPaths,
    next: RawObject,
    name: string,
    options?: { readonly reload: boolean },
  ): Promise<{
    readonly revision: string;
    readonly profile: BetterLootProfile;
    readonly backup: string | null;
    readonly reloaded: boolean;
    readonly reloadOutput: string | null;
  }> {
    const backup = await backupPluginDataFile(
      paths.oxideDataDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      LOOT_GROUPS_FILE,
      Date.now(),
    );

    await writePluginDataFile(
      paths.oxideDataDir,
      BETTERLOOT_PLUGIN,
      LOOT_GROUPS_FILE,
      JSON.stringify(next, null, 2),
    );

    const groupsPath = pluginDataPath(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);
    const written = await markOf(groupsPath);

    const reload =
      options?.reload === false
        ? { sent: false, output: null }
        : await this.#deps.reload(serverId);

    // O plugin valida os perfis ao carregar e reescreve o arquivo
    // (`BetterLoot.cs:566-634`) — inclusive REBALANCEANDO as
    // probabilidades que não somam 100. A mesma corrida da tabela.
    if (reload.sent && !reloadFailed(reload.output)) {
      await waitForRewrite(groupsPath, written, this.#rewriteWait());
    }

    const after = await readPluginDataFile(paths.oxideDataDir, BETTERLOOT_PLUGIN, LOOT_GROUPS_FILE);

    const reread =
      after === null ? emptyLootGroups() : parseLootGroups(after.text, this.#whereGroups(serverId));

    const raw = reread.groups[name] ?? null;

    return {
      revision: profileRevisionOf(raw),
      // A resposta vem do disco: se o plugin rebalanceou, é o
      // rebalanceado que a tela mostra. Ver o `applyTable`.
      profile:
        raw === null
          ? { name, enabled: true, guaranteed: [], items: [] }
          : toProfile(name, raw, this.#catalog()),
      backup,
      reloaded: reload.sent,
      reloadOutput: reload.output,
    };
  }

  #whereGroups(serverId: string): string {
    return `o LootGroups.json do BetterLoot em "${serverId}"`;
  }

  /**
   * O catálogo do agente, indexado por shortname.
   *
   * Uma consulta só por requisição: são ~1250 linhas, e perguntar
   * item a item seria o N+1 desta tela — 145 consultas para abrir
   * uma caixa de elite.
   */
  #catalog(): ReadonlyMap<string, ItemRecord> {
    const { items } = this.#deps.items.list({ limit: 100_000, offset: 0 });

    return new Map(items.map((item) => [item.shortname, item]));
  }

  /**
   * Grava os globais e recarrega o plugin.
   *
   * ####  É UM MERGE, E NÃO UM ARQUIVO NOVO  ####
   *
   * O `BetterLoot.json` guarda, no mesmo arquivo, o dicionário
   * `Watched Container Prefabs` com as 111 chaves que o plugin
   * varreu do mundo. Montar a configuração do zero a partir dos
   * quatro campos da tela apagaria essa lista — e o plugin voltaria
   * a vigiar tudo no próximo load, incluindo a caixa que o admin
   * tinha tirado de propósito.
   *
   * ####  E O ARQUIVO PODE NÃO EXISTIR  ####
   *
   * Aí ele nasce PARCIAL, com só os dois blocos que a tela mexe. É
   * legítimo porque o `MaybeUpdateConfigDict` do plugin
   * (BetterLoot.cs:377-407) completa o que faltar ao carregar e
   * salva de volta — medido em Docs/CustomItem/06 §2.2. Recusar
   * aqui obrigaria a subir o servidor uma vez só para poder dizer
   * "2x" antes do primeiro boot.
   */
  async saveGlobals(
    serverId: string,
    input: {
      readonly baseRevision: string | null;
      readonly globals: BetterLootGlobalsInput;
    },
  ): Promise<BetterLootGlobalsSaveResult> {
    const paths = this.#pathsOf(serverId);
    const current = await readPluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN);
    const currentRevision =
      current === null ? null : sha256Of(Buffer.from(current.text, 'utf8'));

    // A mesma trava da tabela, e pelo mesmo motivo: quem abriu a
    // tela antes de outra pessoa gravar é recusado ANTES da
    // escrita. Ver `BetterLootStatus.configRevision`.
    if (input.baseRevision !== null && input.baseRevision !== currentRevision) {
      throw new ApiError(
        'BETTERLOOT_STALE_REVISION',
        'O BetterLoot.json mudou no disco depois que esta tela o abriu — outra pessoa gravou, ou ' +
          'o próprio plugin reescreveu a configuração ao carregar. Nada foi alterado: recarregue ' +
          'a tela e refaça o ajuste em cima do que está lá.',
        409,
      );
    }

    const text = applyGlobals(current?.text ?? null, input.globals, this.#whereConfig(serverId));

    const backup = await backupPluginConfig(
      paths.oxideConfigDir,
      paths.backupsDir,
      BETTERLOOT_PLUGIN,
      Date.now(),
    );

    await writePluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN, text);

    const configPath = pluginConfigPath(paths.oxideConfigDir, BETTERLOOT_PLUGIN);
    const written = await markOf(configPath);

    const reload = await this.#deps.reload(serverId);

    // O `MaybeUpdateConfigDict` completa a configuração e a grava
    // de volta DEPOIS que o reload já respondeu — a mesma corrida
    // da tabela, no outro arquivo. Ver `waitForRewrite`.
    if (reload.sent && !reloadFailed(reload.output)) {
      await waitForRewrite(configPath, written, this.#rewriteWait());
    }

    // ####  A RESPOSTA VEM DO DISCO  ####
    //
    // O plugin completa a configuração ao carregar e a reescreve.
    // Devolver o que enviamos faria a tela afirmar um arquivo que
    // já não é o do disco — a mesma regra do `save` da tabela.
    const after = await readPluginConfig(paths.oxideConfigDir, BETTERLOOT_PLUGIN);

    if (after === null) {
      throw new ApiError(
        'BETTERLOOT_READ_BACK_FAILED',
        `Gravei ${this.#whereConfig(serverId)} e ele sumiu na releitura. A cópia anterior está ` +
          `em ${backup ?? '(não havia arquivo para copiar)'}.`,
        500,
      );
    }

    return {
      revision: sha256Of(Buffer.from(after.text, 'utf8')),
      globals: toGlobals(after.text),
      backup,
      reloaded: reload.sent,
      reloadOutput: reload.output,
    };
  }

  async #readGlobals(oxideConfigDir: string): Promise<{
    readonly globals: BetterLootGlobals | null;
    readonly revision: string | null;
    /** A lista de vigia. `null` = não há arquivo. Ver `KEY_WATCHED`. */
    readonly watched: ReadonlyMap<string, boolean> | null;
  }> {
    const config = await readPluginConfig(oxideConfigDir, BETTERLOOT_PLUGIN);

    return config === null
      ? { globals: null, revision: null, watched: null }
      : {
          globals: toGlobals(config.text),
          revision: sha256Of(Buffer.from(config.text, 'utf8')),
          watched: toWatched(config.text),
        };
  }

  #whereConfig(serverId: string): string {
    return `o BetterLoot.json de "${serverId}"`;
  }

  async #readBlacklist(oxideDataDir: string): Promise<readonly string[]> {
    const file = await readPluginDataFile(oxideDataDir, BETTERLOOT_PLUGIN, BLACKLIST_FILE);

    return file === null ? [] : toBlacklist(file.text);
  }

  #whereTables(serverId: string): string {
    return `o LootTables.json do BetterLoot em "${serverId}"`;
  }

  #notConfigured(serverId: string): ApiError {
    return new ApiError(
      'BETTERLOOT_NOT_CONFIGURED',
      `O BetterLoot nunca rodou em "${serverId}": não existe oxide/data/BetterLoot/LootTables.json ` +
        'ali. A tabela nasce sozinha no primeiro carregamento do plugin, gerada do loot nativo ' +
        'daquele mapa.',
      409,
    );
  }

  #pathsOf(serverId: string): BetterLootPaths {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      throw new ApiError(
        'UNKNOWN_SERVER',
        `Não existe servidor com o id "${serverId}" neste agente.`,
        404,
      );
    }

    return config.paths;
  }
}
