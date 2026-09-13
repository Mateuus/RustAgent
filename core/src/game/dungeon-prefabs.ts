// ============================================================
//  dungeon-prefabs.ts  -  as caixas e os inimigos que o admin
//  escolhe na tela da masmorra, por NOME.
//
//  ####  O CAMINHO COMPLETO NÃO É PEDIDO A NINGUÉM  ####
//
//  Até aqui a caixa de uma cor de sala era cadastrada assim:
//
//      assets/bundled/prefabs/radtown/crate_normal.prefab
//
//  digitado à mão, num campo de texto. Três coisas estão erradas
//  nisso, e as três já custaram caro em outros lugares deste
//  projeto:
//
//    1. errar uma letra não avisa ninguém. O `CreateEntity`
//       devolve `null` EM SILÊNCIO, o construtor pula a peça com
//       um aviso no console do servidor — que o admin não lê — e a
//       sala nasce vazia;
//    2. `crate_normal` é a caixa MILITAR e `crate_normal_2` é a
//       comum. Ninguém acerta isso de cabeça, e o nome do arquivo
//       diz o contrário do que a peça é;
//    3. "caixa de munição" mora em `radtown/underwater_labs/`, que
//       é o último lugar onde alguém iria procurar.
//
//  ####  E ELE CONTINUA SENDO O QUE VIAJA  ####
//
//  O plugin recebe e usa o caminho completo, como sempre: o que
//  esta lista faz é OFERECER um nome no lugar dele. Um prefab que
//  não está aqui funciona igual — a régua do schema continua sendo
//  "parece caminho de asset", e não "está nesta lista". O Rust
//  ganha contêiner a cada update, e uma lista fechada viraria uma
//  migração por wipe.
//
//  ####  DE ONDE SAIU CADA CAMINHO  ####
//
//  TODOS conferidos, um a um, contra o
//  `Servers/server01/Bundles/AssetSceneManifest.json` deste
//  projeto (16.358 assets, 29 cenas) em 13/09/2026. O que está
//  aqui existe naquele build, com este nome e nesta pasta.
//
//  Nenhum foi inventado, e é a mesma regra do
//  `game/loot-containers.ts`: um prefab que não existe produz uma
//  escolha que nunca acontece, em silêncio — o pior defeito que
//  uma ferramenta de configuração pode ter.
//
//  As maiúsculas do manifest foram passadas para minúscula porque
//  é assim que o `StringPool` do jogo guarda os caminhos, e é
//  assim que as seis constantes do `OrigemZDungeon.cs` já estavam
//  escritas.
// ============================================================

/** Uma peça do catálogo, como a tela a mostra. */
export interface DungeonPrefabEntry {
  /** O caminho completo. É o que viaja até o plugin. */
  readonly prefab: string;
  /** O que o admin lê. */
  readonly label: string;
  /** Um dos grupos abaixo, na ordem em que a tela os desenha. */
  readonly group: string;
  /**
   * O que aquela escolha significa no jogo, quando não é óbvio.
   *
   * Existe para o barril e para o armário: os dois parecem caixa
   * na tela e se comportam de um jeito que surpreende (o barril
   * não abre com E; o armário nasce vazio). Ver §4 de
   * `Docs/OrigemZDurgeon/frentes/loot.md`.
   */
  readonly hint?: string;
}

// ------------------------------------------------------------
//  AS CAIXAS
// ------------------------------------------------------------

export const DUNGEON_CRATE_GROUPS = [
  'As mais usadas',
  'Caixas comuns',
  'Caixas de risco',
  'Barris e lixo',
  'Guardados (nascem vazios)',
] as const;

/**
 * O catálogo de contêineres da masmorra.
 *
 * Curto de propósito: são os que alguém de fato põe numa masmorra.
 * Os exóticos (as caixas de satélite, as sazonais, os nove
 * `roadsign`) ficam fora da OFERTA — quem precisar de um digita o
 * caminho, e ele funciona igual.
 *
 * A ordem dos grupos é a do risco, como no `loot-containers.ts`, e
 * o primeiro grupo existe para o primeiro minuto: são as cinco que
 * o pedido de 13/09/2026 nomeia, na ordem em que ele as nomeia.
 */
export const DUNGEON_CRATES: readonly DungeonPrefabEntry[] = [
  // ---- As cinco do pedido, mais a de código ----
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_normal_2.prefab',
    label: 'Caixa comum',
    group: 'As mais usadas',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_normal.prefab',
    label: 'Caixa militar',
    group: 'As mais usadas',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_elite.prefab',
    label: 'Caixa de elite',
    group: 'As mais usadas',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/underwater_labs/crate_ammunition.prefab',
    label: 'Caixa de munição',
    group: 'As mais usadas',
  },
  {
    prefab: 'assets/prefabs/npc/m2bradley/bradley_crate.prefab',
    label: 'Caixa do Bradley',
    group: 'As mais usadas',
  },
  {
    prefab: 'assets/prefabs/npc/patrol helicopter/heli_crate.prefab',
    label: 'Caixa do helicóptero',
    group: 'As mais usadas',
  },

  // ---- Radtown baixo ----
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_basic.prefab',
    label: 'Caixa básica',
    group: 'Caixas comuns',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_tools.prefab',
    label: 'Caixa de ferramentas',
    group: 'Caixas comuns',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_mine.prefab',
    label: 'Caixa de mina',
    group: 'Caixas comuns',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_shore.prefab',
    label: 'Caixa de praia',
    group: 'Caixas comuns',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/foodbox.prefab',
    label: 'Caixa de comida',
    group: 'Caixas comuns',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_normal_2_food.prefab',
    label: 'Caixa comum (comida)',
    group: 'Caixas comuns',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_normal_2_medical.prefab',
    label: 'Caixa comum (remédio)',
    group: 'Caixas comuns',
  },

  // ---- Radtown alto e evento ----
  {
    prefab: 'assets/bundled/prefabs/radtown/underwater_labs/crate_medical.prefab',
    label: 'Caixa médica (laboratório)',
    group: 'Caixas de risco',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/underwater_labs/crate_fuel.prefab',
    label: 'Caixa de combustível',
    group: 'Caixas de risco',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_underwater_basic.prefab',
    label: 'Caixa submersa (comum)',
    group: 'Caixas de risco',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/crate_underwater_advanced.prefab',
    label: 'Caixa submersa (boa)',
    group: 'Caixas de risco',
  },
  {
    prefab: 'assets/prefabs/deployable/chinooklockedcrate/codelockedhackablecrate.prefab',
    label: 'Caixa de código (hackável)',
    group: 'Caixas de risco',
    hint: 'Ela abre com os 15 minutos de hack, e não com E. Numa masmorra de evento curto, o tempo pode não caber.',
  },
  {
    prefab: 'assets/prefabs/misc/supply drop/supply_drop.prefab',
    label: 'Airdrop',
    group: 'Caixas de risco',
  },

  // ---- Barris ----
  {
    prefab: 'assets/bundled/prefabs/radtown/loot_barrel_1.prefab',
    label: 'Barril (pequeno)',
    group: 'Barris e lixo',
    hint: 'Barril não abre com E: o loot só sai quando ele se parte. O construtor já libera dano nele.',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/loot_barrel_2.prefab',
    label: 'Barril (grande)',
    group: 'Barris e lixo',
    hint: 'Barril não abre com E: o loot só sai quando ele se parte. O construtor já libera dano nele.',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/oil_barrel.prefab',
    label: 'Barril de óleo',
    group: 'Barris e lixo',
    hint: 'Barril não abre com E: o loot só sai quando ele se parte. O construtor já libera dano nele.',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/loot_trash.prefab',
    label: 'Lixo',
    group: 'Barris e lixo',
  },
  {
    prefab: 'assets/bundled/prefabs/radtown/minecart.prefab',
    label: 'Vagonete',
    group: 'Barris e lixo',
  },

  // ---- O que NÃO se enche sozinho ----
  //
  // `StorageContainer` nasce vazio e não repopula: sem uma tabela
  // de loot, o armário da sala vermelha é um armário vazio. Não é
  // defeito, é o que o Rust faz — e é por isso que estes cinco
  // moram num grupo com o aviso no nome.
  {
    prefab: 'assets/prefabs/deployable/woodenbox/woodbox_deployed.prefab',
    label: 'Caixa de madeira',
    group: 'Guardados (nascem vazios)',
    hint: 'Nasce VAZIA: sem tabela de loot, ela fica vazia para sempre.',
  },
  {
    prefab: 'assets/prefabs/deployable/large wood storage/box.wooden.large.prefab',
    label: 'Caixa de madeira grande',
    group: 'Guardados (nascem vazios)',
    hint: 'Nasce VAZIA: sem tabela de loot, ela fica vazia para sempre.',
  },
  {
    prefab: 'assets/prefabs/deployable/locker/locker.deployed.prefab',
    label: 'Armário',
    group: 'Guardados (nascem vazios)',
    hint: 'Nasce vazio, e cada linha dele só aceita a peça daquela linha: é o lugar de roupa e arma, e o resto entra torto.',
  },
  {
    prefab: 'assets/prefabs/deployable/small stash/small_stash_deployed.prefab',
    label: 'Esconderijo',
    group: 'Guardados (nascem vazios)',
    hint: 'Nasce vazio, e fica quase invisível no chão. Bom para prêmio escondido, ruim para loot de passagem.',
  },
  {
    prefab: 'assets/prefabs/misc/item drop/item_drop_backpack.prefab',
    label: 'Mochila largada',
    group: 'Guardados (nascem vazios)',
    hint: 'Nasce vazia e SOME sozinha com o tempo, como o saco de quem morreu.',
  },
];

/** A caixa de quem não escolheu nenhuma. É a mesma do construtor. */
export const DEFAULT_DUNGEON_CRATE = 'assets/bundled/prefabs/radtown/crate_normal.prefab';

// ------------------------------------------------------------
//  OS INIMIGOS
// ------------------------------------------------------------

/**
 * Os cientistas que a masmorra sabe erguer.
 *
 * ####  TODOS SÃO `ScientistNPC`, E ISSO É A TRAVA  ####
 *
 * A IA da masmorra é um componente nosso (`DungeonNpcAi`) pregado
 * num `ScientistNPC`, e o `OnEntityTakeDamage(ScientistNPC, …)` é
 * quem impede o inimigo de matar o colega. Um `TunnelDweller` ou um
 * `scarecrow` compilaria, nasceria — e nasceria BURRO: sem o
 * componente, sem coleira e sem a proteção do fogo amigo.
 *
 * Então a oferta é a pasta `Scientist/` do manifest, e só ela. O
 * que muda de um para o outro é a ROUPA, a vida do prefab e a arma
 * que ele já traz; a vida, o dano e o comportamento continuam
 * vindo da masmorra e da cor da sala, por cima.
 *
 * Ficaram de fora os de torre e de veículo (`cargo_turret_*`,
 * `ch47_gunner`, `ptboat`, `rhib`): eles nascem esperando o
 * veículo deles e ficam plantados olhando para o nada.
 */
export const DUNGEON_NPC_GROUPS = ['Guardas', 'Patrulha', 'De evento'] as const;

export const DUNGEON_NPCS: readonly DungeonPrefabEntry[] = [
  // ---- Guardas: os que fazem sentido parados numa sala ----
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab',
    label: 'Cientista pesado',
    group: 'Guardas',
    hint: 'O padrão da masmorra: blindado, com muita vida de prefab.',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_full_any.prefab',
    label: 'Cientista completo (arma sorteada)',
    group: 'Guardas',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_full_lr300.prefab',
    label: 'Cientista com LR-300',
    group: 'Guardas',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_full_mp5.prefab',
    label: 'Cientista com MP5',
    group: 'Guardas',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_full_shotgun.prefab',
    label: 'Cientista com escopeta',
    group: 'Guardas',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_full_pistol.prefab',
    label: 'Cientista com pistola',
    group: 'Guardas',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_junkpile_pistol.prefab',
    label: 'Cientista de lixão (fraco)',
    group: 'Guardas',
    hint: 'O mais fraco do jogo: bom para encher corredor sem matar quem acabou de descer.',
  },

  // ---- Patrulha: a roupa de fora ----
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_roam.prefab',
    label: 'Cientista de ronda',
    group: 'Patrulha',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_patrol.prefab',
    label: 'Cientista de patrulha',
    group: 'Patrulha',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_patrol_arctic.prefab',
    label: 'Cientista de patrulha (ártico)',
    group: 'Patrulha',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_oilrig.prefab',
    label: 'Cientista da plataforma',
    group: 'Patrulha',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_cargo.prefab',
    label: 'Cientista do cargo',
    group: 'Patrulha',
  },

  // ---- De evento: os duros ----
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_bradley.prefab',
    label: 'Cientista do Bradley',
    group: 'De evento',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_bradley_heavy.prefab',
    label: 'Cientista do Bradley (pesado)',
    group: 'De evento',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_excavator.prefab',
    label: 'Cientista da escavadeira',
    group: 'De evento',
  },
  {
    prefab: 'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_arena.prefab',
    label: 'Cientista de arena',
    group: 'De evento',
  },
];

/** O inimigo de quem não escolheu nenhum. É o mesmo do construtor. */
export const DEFAULT_DUNGEON_NPC =
  'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab';

/**
 * O nome amigável de um prefab, ou o próprio caminho.
 *
 * Serve às frases do agente — um aviso de validação que diz
 * "assets/bundled/prefabs/radtown/crate_elite.prefab" faz o admin
 * reler duas vezes para entender que é a caixa de elite.
 */
export function dungeonPrefabLabel(prefab: string): string {
  const found = [...DUNGEON_CRATES, ...DUNGEON_NPCS].find((entry) => entry.prefab === prefab);

  return found?.label ?? prefab;
}
