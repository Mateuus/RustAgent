// ============================================================
//  loot-containers.ts  -  as caixas que o admin escolhe na tela.
//
//  ####  ELA É UM CATÁLOGO PARA A TELA, NÃO UMA TRAVA  ####
//
//  O plugin não consulta esta lista: ele compara o
//  `ShortPrefabName` da entidade com o que a regra guarda. Uma
//  regra que aponte para um prefab que não está aqui funciona
//  igual — o que ela não tem é um nome amigável na tela.
//
//  E é por isso que a rota NÃO recusa o que não está nesta lista.
//  O Rust ganha container a cada update, e recusar um prefab novo
//  seria travar o admin por causa do envelhecimento de uma lista
//  nossa. O catálogo existe para OFERECER, não para proibir.
//
//  ####  DE ONDE SAIU CADA NOME  ####
//
//  Os marcados com `manifest` foram conferidos, um a um, contra
//  `Servers/server01/Bundles/AssetSceneManifest.json` — o
//  `<nome>.prefab` está lá. Os marcados com `estudo` vêm das
//  medições de `Docs/CustomItem/04` §2.4/§6.4 e `05` §2.3/§2.4,
//  que leram os bundles com UnityPy e o servidor no ar; eles não
//  aparecem no manifest porque ele só lista prefab de CENA.
//
//  Nenhum nome aqui foi inventado. Um prefab que não existe
//  produziria uma regra que nunca dispara — em silêncio, que é o
//  pior defeito que uma ferramenta de configuração pode ter.
//
//  ####  A ORDEM DOS GRUPOS É A DO RISCO  ####
//
//  Do farm de rota para o evento. É a leitura do
//  `Docs/CustomItem/04` §6.4: o valor da mecânica é o risco, e a
//  recomendação de lá é ficar FORA dos 400 barris de estrada — que
//  por isso aparecem, mas por último em intenção e primeiro em
//  ordem, porque é assim que o admin os reconhece.
// ============================================================

/** Um container, como a tela o mostra. */
export interface LootContainerEntry {
  /** O `ShortPrefabName`. É o que viaja até o plugin. */
  readonly prefab: string;
  /** O que o admin lê. */
  readonly label: string;
  /** Um dos grupos abaixo. */
  readonly group: string;
}

/**
 * Os grupos, na ordem em que a tela os desenha.
 *
 * São os do `Docs/CustomItem/05` §8.2, e não uma invenção: o admin
 * pensa "quero mexer na caixa de elite", nunca "quero mexer na
 * `LootSpawn.RadTownElite`".
 */
export const LOOT_CONTAINER_GROUPS = [
  'Barris e lixo',
  'Caixas comuns',
  // ####  "DE RISCO", E NÃO "BOAS"  ####
  //
  // O rótulo mudou em 06/09/2026 para casar com o do painel
  // (`CONTAINER_GROUPS`, em components/loot/containers.ts). O
  // painel aceita o grupo da API quando ele bate com o `id` OU com
  // o `label` de um grupo dele, e cai no palpite por nome de
  // prefab quando não bate. "Caixas boas" não batia com nada, e o
  // agrupamento que vinha daqui era jogado fora em silêncio.
  'Caixas de risco',
  'Eventos',
  'Missão e tutorial',
  'Sazonais',
  'Outros',
] as const;

/**
 * O catálogo.
 *
 * Curto de propósito: são os containers que alguém de fato quer
 * usar, e não os 105 do build. Os exóticos (os 9 `roadsign`, as
 * caixas de teste) ficam de fora da OFERTA — quem precisar de um
 * deles digita o prefab, e a regra funciona igual.
 */
export const LOOT_CONTAINERS: readonly LootContainerEntry[] = [
  // ---- Barris e lixo — o farm de rota ----
  { prefab: 'loot_barrel_1', label: 'Barril (pequeno)', group: 'Barris e lixo' }, // manifest
  { prefab: 'loot_barrel_2', label: 'Barril (grande)', group: 'Barris e lixo' }, // manifest
  { prefab: 'oil_barrel', label: 'Barril de óleo', group: 'Barris e lixo' }, // manifest
  { prefab: 'loot_trash', label: 'Lixo', group: 'Barris e lixo' }, // manifest
  { prefab: 'trash-pile-1', label: 'Pilha de lixo', group: 'Barris e lixo' }, // estudo (04 §2.4)
  { prefab: 'minecart', label: 'Vagonete', group: 'Barris e lixo' }, // manifest

  // ---- Caixas comuns — radtown baixo ----
  { prefab: 'crate_basic', label: 'Caixa básica', group: 'Caixas comuns' }, // manifest
  { prefab: 'crate_basic_jungle', label: 'Caixa básica (selva)', group: 'Caixas comuns' }, // manifest
  { prefab: 'crate_shore', label: 'Caixa de praia', group: 'Caixas comuns' }, // manifest
  { prefab: 'foodbox', label: 'Caixa de comida', group: 'Caixas comuns' }, // manifest
  { prefab: 'crate_tools', label: 'Caixa de ferramentas', group: 'Caixas comuns' }, // manifest
  { prefab: 'crate_mine', label: 'Caixa de mina', group: 'Caixas comuns' }, // manifest

  // ---- Caixas boas — radtown médio e alto ----
  { prefab: 'crate_normal', label: 'Caixa militar', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_normal_2', label: 'Caixa comum', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_normal_2_food', label: 'Caixa comum (comida)', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_normal_2_medical', label: 'Caixa comum (remédio)', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_elite', label: 'Caixa de elite', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_underwater_basic', label: 'Caixa submersa (comum)', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_underwater_advanced', label: 'Caixa submersa (boa)', group: 'Caixas de risco' }, // manifest
  { prefab: 'crate_cannons', label: 'Caixa de canhões', group: 'Caixas de risco' }, // manifest

  // ---- Eventos — o risco de verdade ----
  { prefab: 'heli_crate', label: 'Caixa do helicóptero', group: 'Eventos' }, // manifest
  { prefab: 'bradley_crate', label: 'Caixa do Bradley', group: 'Eventos' }, // manifest
  { prefab: 'supply_drop', label: 'Airdrop', group: 'Eventos' }, // manifest
  { prefab: 'codelockedhackablecrate', label: 'Caixa de código', group: 'Eventos' }, // estudo (05 §2.4)
  { prefab: 'satellite_crate_1', label: 'Caixa da satélite (1)', group: 'Eventos' }, // manifest
  { prefab: 'satellite_crate_2', label: 'Caixa da satélite (2)', group: 'Eventos' }, // manifest
  { prefab: 'satellite_crate_3', label: 'Caixa da satélite (3)', group: 'Eventos' }, // manifest

  // ---- Missão e tutorial ----
  { prefab: 'missionstash', label: 'Esconderijo de missão', group: 'Missão e tutorial' }, // estudo (05 §8.2)
  { prefab: 'tacklebox', label: 'Caixa de pesca', group: 'Missão e tutorial' }, // estudo (05 §8.2)
  { prefab: 'crate_elite_tutorial', label: 'Caixa de elite (tutorial)', group: 'Missão e tutorial' }, // manifest

  // ---- Sazonal ----
  { prefab: 'giftbox_loot', label: 'Presente de Natal', group: 'Sazonais' }, // manifest
  { prefab: 'stocking_large_deployed', label: 'Meia de Natal (grande)', group: 'Sazonais' }, // manifest
  { prefab: 'xmastunnellootbox', label: 'Caixa do túnel de Natal', group: 'Sazonais' }, // estudo (05 §8.2)

  // ============================================================
  //  Os 32 abaixo entraram em 06/09/2026, e a fonte deles é outra
  //
  //  ####  ELES SAÍRAM DO `LootTables.json` DO PRÓPRIO SERVIDOR  ####
  //
  //  O BetterLoot, ao carregar pela primeira vez, varre os prefabs
  //  do jogo e gera a tabela de loot de cada um a partir do loot
  //  NATIVO daquele build (Docs/CustomItem/06 §2.6). O arquivo que
  //  ele produziu no `server01` tem 111 chaves, das quais 71 são
  //  contêiner de verdade — 31 são corpo de cientista e 9 são as
  //  chaves sintéticas `unwrap/`, que são o que sai ao ABRIR um
  //  presente, e não o que nasce numa caixa no mapa.
  //
  //  Ou seja: são nomes MEDIDOS no servidor, e não conferidos num
  //  manifest — a mesma régua dos marcados com `estudo`. A cópia
  //  está em `Backups/server01/betterloot-config-inicial-*`.
  //
  //  ####  POR QUE A LISTA CRESCEU DE 33 PARA 65  ####
  //
  //  Porque a de 33 estava escondendo dois terços do mundo. O
  //  admin que procurasse a caixa de munição dos laboratórios não a
  //  encontrava, e nada na tela dizia que ela existe — que é
  //  exatamente o defeito que o cabeçalho deste arquivo diz ser o
  //  pior de uma ferramenta de configuração.
  //
  //  ####  E POR QUE OS DEZ `dm *` FICARAM DE FORA  ####
  //
  //  `dm ammo`, `dm c4`, `dm tier1 lootbox` e os outros sete têm
  //  ESPAÇO no `ShortPrefabName`, e o `CONTAINER_PREFAB` lá embaixo
  //  não o aceita — o nome viaja num comando de console do Rust,
  //  onde espaço separa argumentos. Oferecê-los seria oferecer o
  //  que a criação de regra recusa na linha seguinte.
  // ============================================================

  // ---- Barris e lixo ----
  //
  // Os de `autospawn/` usam HÍFEN e os de `radtown/` usam
  // sublinhado: são prefabs distintos com o mesmo papel no mapa, e
  // sem a origem no rótulo ninguém sabe qual está editando.
  { prefab: 'loot-barrel-1', label: 'Barril de estrada 1 (autospawn)', group: 'Barris e lixo' },
  { prefab: 'loot-barrel-2', label: 'Barril de estrada 2 (autospawn)', group: 'Barris e lixo' },
  { prefab: 'roadsign1', label: 'Placa de estrada 1', group: 'Barris e lixo' },
  { prefab: 'roadsign2', label: 'Placa de estrada 2', group: 'Barris e lixo' },
  { prefab: 'roadsign3', label: 'Placa de estrada 3', group: 'Barris e lixo' },
  { prefab: 'roadsign4', label: 'Placa de estrada 4', group: 'Barris e lixo' },
  { prefab: 'roadsign5', label: 'Placa de estrada 5', group: 'Barris e lixo' },
  { prefab: 'roadsign6', label: 'Placa de estrada 6', group: 'Barris e lixo' },
  { prefab: 'roadsign7', label: 'Placa de estrada 7', group: 'Barris e lixo' },
  { prefab: 'roadsign8', label: 'Placa de estrada 8', group: 'Barris e lixo' },
  { prefab: 'roadsign9', label: 'Placa de estrada 9', group: 'Barris e lixo' },

  // ---- Caixas comuns ----
  //
  // As cinco reservas de comida moram em `misc/food cache/` — a
  // PASTA tem espaço, mas o nome curto não, e é o nome curto que
  // viaja.
  { prefab: 'food_cache_001', label: 'Reserva de comida 1', group: 'Caixas comuns' },
  { prefab: 'food_cache_002', label: 'Reserva de comida 2', group: 'Caixas comuns' },
  { prefab: 'food_cache_003', label: 'Reserva de comida 3', group: 'Caixas comuns' },
  { prefab: 'food_cache_004', label: 'Reserva de comida 4', group: 'Caixas comuns' },
  { prefab: 'food_cache_005', label: 'Reserva de comida 5', group: 'Caixas comuns' },
  { prefab: 'vehicle_parts', label: 'Peças de veículo', group: 'Caixas comuns' },
  {
    prefab: 'vehicle_parts_advanced',
    label: 'Peças de veículo avançadas',
    group: 'Caixas comuns',
  },

  // ---- Caixas de risco — os laboratórios submersos ----
  //
  // Cinco nomes curtos aqui já existem em `radtown/`
  // (`crate_elite`, `crate_normal`, `crate_normal_2`,
  // `crate_tools`, `vehicle_parts`) e por isso NÃO se repetem: a
  // regra casa por `ShortPrefabName`, e duas linhas com o mesmo
  // nome seriam duas ofertas para a mesma coisa. Só os sete
  // exclusivos dos labs entram.
  { prefab: 'crate_ammunition', label: 'Caixa de munição (labs)', group: 'Caixas de risco' },
  { prefab: 'crate_food_1', label: 'Caixa de comida 1 (labs)', group: 'Caixas de risco' },
  { prefab: 'crate_food_2', label: 'Caixa de comida 2 (labs)', group: 'Caixas de risco' },
  { prefab: 'crate_fuel', label: 'Caixa de combustível (labs)', group: 'Caixas de risco' },
  { prefab: 'crate_medical', label: 'Caixa médica (labs)', group: 'Caixas de risco' },
  { prefab: 'tech_parts_1', label: 'Peças eletrônicas 1 (labs)', group: 'Caixas de risco' },
  { prefab: 'tech_parts_2', label: 'Peças eletrônicas 2 (labs)', group: 'Caixas de risco' },

  // ---- Eventos ----
  //
  // As três caixas da antena aparecem no arquivo com o sufixo
  // `.entity`, e são OUTRO prefab: o `satellite_crate_1` sem
  // sufixo, que já está lá em cima, veio do manifest. Os dois
  // convivem porque o estudo viu um e o servidor vê o outro, e
  // esconder qualquer um deles seria decidir qual está certo sem
  // ter medido.
  {
    prefab: 'satellite_crate_1.entity',
    label: 'Caixa da antena 1',
    group: 'Eventos',
  },
  {
    prefab: 'satellite_crate_2.entity',
    label: 'Caixa da antena 2',
    group: 'Eventos',
  },
  {
    prefab: 'satellite_crate_3.entity',
    label: 'Caixa da antena 3',
    group: 'Eventos',
  },
  {
    prefab: 'codelockedhackablecrate_oilrig',
    label: 'Caixa travada (plataforma)',
    group: 'Eventos',
  },
  {
    prefab: 'codelockedhackablecrate_ghostship',
    label: 'Caixa travada (navio fantasma)',
    group: 'Eventos',
  },
  { prefab: 'ptboat.deepsea', label: 'Barco de patrulha (mar profundo)', group: 'Eventos' },
  { prefab: 'rhib.deepsea', label: 'Bote (mar profundo)', group: 'Eventos' },
];

/**
 * A régua de um `ShortPrefabName`.
 *
 * Ela existe porque o nome viaja num comando de console do Rust,
 * onde espaço separa argumentos — e dentro de um JSON que o plugin
 * lê. O que passa aqui é o que o próprio jogo usa: minúscula,
 * dígito, sublinhado, hífen e ponto.
 *
 * Note que ela NÃO confere se o prefab existe: ver o cabeçalho.
 */
export const CONTAINER_PREFAB = /^[a-z0-9][a-z0-9._-]{0,79}$/;
