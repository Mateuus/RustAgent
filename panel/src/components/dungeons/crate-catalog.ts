// ============================================================
//  crate-catalog.ts  -  a caixa e o inimigo se escolhem por NOME.
//
//  ####  O ADMIN DIGITAVA O CAMINHO DO PREFAB  ####
//
//  Assim, na unha, num campo de texto:
//
//      assets/bundled/prefabs/radtown/crate_normal.prefab
//
//  E tres coisas estavam erradas nisso. Errar uma letra nao avisa
//  ninguem — o `CreateEntity` do jogo devolve null em silencio, o
//  construtor pula a peca com um aviso no console do servidor, e a
//  sala nasce vazia. `crate_normal` e a caixa MILITAR e
//  `crate_normal_2` e a comum, o que ninguem acerta de cabeca. E a
//  caixa de municao mora em `radtown/underwater_labs/`, o ultimo
//  lugar onde alguem procuraria.
//
//  Pedido do dono em 13/09/2026: *"adicionar um seletor com nome
//  amigavel e pesquisa"*.
//
//  ####  ESTE ARQUIVO E UM ESPELHO  ####
//
//  A fonte e `core/src/game/dungeon-prefabs.ts`, e todo caminho
//  daqui foi conferido, um a um, contra o
//  `Servers/server01/Bundles/AssetSceneManifest.json` (16.358
//  assets). `panel/test/dungeon-crate-catalog.test.ts` cobra que as
//  duas listas sejam identicas — divergir em silencio e como a tela
//  passa a oferecer uma caixa que o jogo nao tem.
//
//  Espelho, e nao uma rota: sao ~45 linhas que nao mudam entre
//  wipes, e busca-las por HTTP poria um estado de carregamento no
//  meio de um formulario que o admin abre para digitar um nome.
//
//  ####  E ELE E OFERTA, NUNCA TRAVA  ####
//
//  O campo aceita qualquer caminho de asset — e o pedido do dono
//  inclui "caixa personalizada" justamente por isso. O Rust ganha
//  conteiner a cada update, e uma lista fechada viraria uma
//  migracao por wipe.
// ============================================================

/** Uma peca do catalogo, como a tela a mostra. */
export interface DungeonPrefabEntry {
  /** O caminho completo. E o que viaja ate o plugin. */
  readonly prefab: string;
  /** O que o admin le. */
  readonly label: string;
  readonly group: string;
  /**
   * O que aquela escolha significa no jogo, quando nao e obvio.
   *
   * Existe para o barril e para o armario: os dois parecem caixa na
   * tela e se comportam de um jeito que surpreende — o barril nao
   * abre com E, o armario nasce vazio.
   */
  readonly hint?: string;
}

export const DUNGEON_CRATE_GROUPS = [
  'As mais usadas',
  'Caixas comuns',
  'Caixas de risco',
  'Barris e lixo',
  'Guardados (nascem vazios)',
] as const;

export const DUNGEON_CRATES: readonly DungeonPrefabEntry[] = [
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

/** A caixa de quem nao escolheu nenhuma. E a mesma do construtor. */
export const DEFAULT_DUNGEON_CRATE = 'assets/bundled/prefabs/radtown/crate_normal.prefab';

export const DUNGEON_NPC_GROUPS = ['Guardas', 'Patrulha', 'De evento'] as const;

/**
 * Os inimigos que a masmorra sabe erguer.
 *
 * TODOS sao `ScientistNPC`, e isso e a trava: a IA da masmorra e um
 * componente pregado nessa classe, e o hook que impede o inimigo de
 * matar o colega tambem. Um `TunnelDweller` nasceria burro, sem
 * coleira e matando os proprios.
 *
 * O que muda de um para o outro e a ROUPA, a vida do prefab e a arma
 * que ele ja traz; vida, dano e comportamento continuam vindo da
 * masmorra e da cor da sala, por cima.
 */
export const DUNGEON_NPCS: readonly DungeonPrefabEntry[] = [
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

/** O inimigo de quem nao escolheu nenhum. */
export const DEFAULT_DUNGEON_NPC =
  'assets/rust.ai/agents/npcplayer/humannpc/scientist/scientistnpc_heavy.prefab';

/** O nome amigavel de um prefab, ou o proprio caminho. */
export function dungeonPrefabLabel(prefab: string): string {
  const found = [...DUNGEON_CRATES, ...DUNGEON_NPCS].find((entry) => entry.prefab === prefab);

  return found?.label ?? prefab;
}

/**
 * As entradas que casam com o que foi digitado.
 *
 * Busca por NOME e por caminho: quem lembra "elite" acha a caixa, e
 * quem colou um prefab do log tambem. Sem acento na comparacao —
 * "municao" precisa achar "munição", porque e assim que a palavra
 * sai de um teclado no meio de um formulario.
 */
export function searchDungeonPrefabs(
  entries: readonly DungeonPrefabEntry[],
  query: string,
): readonly DungeonPrefabEntry[] {
  const needle = fold(query);

  if (needle === '') return entries;

  return entries.filter(
    (entry) => fold(entry.label).includes(needle) || entry.prefab.includes(needle),
  );
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
