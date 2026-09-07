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
//  ####  A REVISÃO  ####
//
//  Salvar substitui o `LootTables.json` INTEIRO: o plugin
//  serializa o dicionário todo, e não há merge do lado dele. Duas
//  telas abertas fariam a segunda apagar a primeira em silêncio.
//
//  A defesa é o sha256 do arquivo: a tela devolve o que leu, e o
//  agente recusa quando o disco mudou. É o mesmo papel do
//  `appliedSha` da biblioteca de plugins (library.ts:498) — e o
//  mesmo motivo: um estado do disco que ninguém conferiu é um
//  estado que alguém sobrescreve.
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

import type { ItemRecord, ItemsRepository } from '../db/items-repository.js';
import { ApiError } from '../http/error-response.js';
import { toError } from '../util.js';
import { backupPluginConfig, readPluginConfig, writePluginConfig } from './plugin-config.js';
import { sha256Of } from './plugin-metadata.js';
import {
  backupPluginDataFile,
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
  readonly enabled: boolean;
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

function toSummary(prefab: string, raw: RawObject): BetterLootTableSummary {
  return {
    prefab,
    enabled: asBoolean(raw[KEY_ENABLED], true),
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
      name: typeof profile['Loot Profile Name'] === 'string' ? profile['Loot Profile Name'] : '',
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
): BetterLootTable {
  return {
    ...toSummary(prefab, raw),
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
//  O serviço
// ------------------------------------------------------------

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
  readonly revision: string;
  readonly table: BetterLootTable;
  /** Onde ficou a cópia do arquivo anterior. `null` = não havia. */
  readonly backup: string | null;
  readonly reloaded: boolean;
  readonly reloadOutput: string | null;
}

export class BetterLootEditor {
  readonly #deps: BetterLootDeps;

  constructor(deps: BetterLootDeps) {
    this.#deps = deps;
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
      tables: Object.entries(parsed.tables).map(([prefab, raw]) => toSummary(prefab, raw)),
    };
  }

  /** Uma caixa inteira. */
  async table(
    serverId: string,
    prefab: string,
  ): Promise<{ readonly revision: string; readonly table: BetterLootTable }> {
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

    return { revision: parsed.revision, table: toTable(prefab, raw, this.#catalog()) };
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
    // Salvar substitui o arquivo INTEIRO. Sem esta conferência,
    // duas telas abertas na mesma caixa fariam a segunda apagar o
    // trabalho da primeira em silêncio — e "em silêncio" é o
    // problema, não "apagar".
    if (input.baseRevision !== null && input.baseRevision !== current.revision) {
      throw new ApiError(
        'BETTERLOOT_STALE_REVISION',
        'O LootTables.json mudou no disco depois que esta tela o abriu — outra pessoa gravou, ou ' +
          'o próprio BetterLoot reescreveu o arquivo ao recarregar. Nada foi alterado: recarregue ' +
          'a caixa e refaça a edição em cima do que está lá.',
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

    const reload = await this.#deps.reload(serverId);

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

    return {
      revision: reread.revision,
      table:
        raw === null
          ? input.table
          : toTable(input.table.prefab, raw, this.#catalog()),
      backup,
      reloaded: reload.sent,
      reloadOutput: reload.output,
    };
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

    const reload = await this.#deps.reload(serverId);

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

  async #readGlobals(
    oxideConfigDir: string,
  ): Promise<{ readonly globals: BetterLootGlobals | null; readonly revision: string | null }> {
    const config = await readPluginConfig(oxideConfigDir, BETTERLOOT_PLUGIN);

    return config === null
      ? { globals: null, revision: null }
      : { globals: toGlobals(config.text), revision: sha256Of(Buffer.from(config.text, 'utf8')) };
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

  #pathsOf(serverId: string): {
    readonly oxideConfigDir: string;
    readonly oxideDataDir: string;
    readonly backupsDir: string;
  } {
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
