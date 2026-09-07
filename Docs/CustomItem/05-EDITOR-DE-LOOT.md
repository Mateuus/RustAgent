# 05 — O EDITOR DE LOOT NO PAINEL

> **O que este documento é.** A **medição do tamanho do problema** e a
> **proposta de desenho** para a feature que o dono pediu em 06/09/2026: uma
> parte do painel onde o admin **extrai a configuração de loot do jogo e a
> edita**. Todos os números do §2 foram tirados dos bundles deste servidor e do
> `server01` no ar; o método de cada um está nomeado ao lado.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. **Nenhuma
> linha de editor de loot existe na árvore hoje** — nem no agente, nem no
> painel, nem no plugin. Nada foi alterado no código e nenhum plugin foi
> copiado. Um comando de RCON que escreve **foi executado por engano** e está
> declarado no §11.2, com o efeito medido.
>
> **De onde ele parte.** O [`04-ITEM-NO-LOOT-DO-JOGO.md`](04-ITEM-NO-LOOT-DO-JOGO.md),
> de hoje, mediu que **a tabela nativa não carrega skin** — `ItemAmount` não tem
> o campo e `LootSpawn.SpawnIntoContainer` passa `0uL` literal ao
> `ItemManager.Create`. Referências a ele aparecem como **[L§n]**. Este
> documento **confirma essa medição e contesta duas outras** do mesmo estudo
> (§1.3), agora que as tabelas foram abertas e lidas.
>
> **A quem ele se liga.** A marca `(base_shortname, skin_id)` está em
> [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md) (**[P§n]**). A ação
> `points` está em [`03-ACAO-PONTOS-DE-RANKING.md`](03-ACAO-PONTOS-DE-RANKING.md)
> (**[A§n]**). O padrão de tabela por servidor é o de `custom_item_servers`
> (migração 041) e `kit_servers` (012).

**Escrito em 06/09/2026**, contra os bundles de
`Servers/server01/Bundles/shared/` (5,0 GB, lidos com UnityPy), contra o
`Assembly-CSharp.dll` de `Servers/server01/RustDedicated_Data/Managed` e contra
o `server01` **no ar** (1 jogador — o dono —, 75 FPS na hora da medição).

---

## Índice

- [§0 — O pedido do dono](#0--o-pedido-do-dono)
- [§1 — Sumário executivo](#1--sumário-executivo)
- [§2 — O tamanho do problema, medido](#2--o-tamanho-do-problema-medido)
- [§3 — O que dá para extrair, por onde, e se cabe no cano](#3--o-que-dá-para-extrair-por-onde-e-se-cabe-no-cano)
- [§4 — Substituir ou complementar](#4--substituir-ou-complementar)
- [§5 — Onde a configuração mora](#5--onde-a-configuração-mora)
- [§6 — Por servidor](#6--por-servidor)
- [§7 — O que o mercado já faz](#7--o-que-o-mercado-já-faz)
- [§8 — A tela](#8--a-tela)
- [§9 — O que quebra](#9--o-que-quebra)
- [§10 — O caminho mínimo](#10--o-caminho-mínimo)
- [§11 — Medido, conferido, projeto](#11--medido-conferido-projeto)
- [§12 — Perguntas em aberto para o dono](#12--perguntas-em-aberto-para-o-dono)

---

## 0 — O pedido do dono

> Preservado sem edição. É a fonte; tudo que vem depois é leitura dela.

*"Vamos ter que ter uma parte no painel como loot. Aí nós cria a configuração
que nós quer. Então vamos ter que fazer nossa própria configuração do loot, nós
extrai a do jogo e edita como quer."*

O caso concreto que originou o pedido é pôr o **Troféu Bleik Store** no loot,
raramente. Mas o pedido é maior que o caso: ele quer **uma configuração de loot
nossa**, editável pelo painel. Um pedido complementar, do mesmo dia, acrescenta
o critério de qualidade: o painel tem de ser *"totalmente fácil para o admin
configurar e achar as categorias certas"*.

---

## 1 — Sumário executivo

### 1.1 A leitura em uma frase

> **O problema é pequeno o bastante para caber numa tela, e a configuração do
> jogo é boa demais para ser jogada fora.**
> Foi **medido**: o loot inteiro deste build são **1.321 tabelas** e **3.011
> entradas**, mas o que os containers realmente alcançam são **650 tabelas** e
> **1.396 entradas** — e o admin nunca vai olhar mais que **105 containers**,
> dos quais **43 tabelas de topo** distintas. Isso é uma tela, não um produto.
> Por isso a recomendação é **complementar**, não substituir: o jogo continua
> populando, e nós acrescentamos, removemos e ajustamos por cima — sem herdar a
> obrigação de manter uma cópia de 1.396 linhas que envelhece a cada update.

### 1.2 As seis decisões que o pedido força

**1. Complementar, não substituir.** Está no §4, com o custo dos dois lados.
O argumento decisivo não é preguiça: substituir obriga a reimplementar
`FillLoot`, `PopulateLoot`, o sorteio de condição e o `GenerateScrap` — e
**medido**, 34 dos 105 containers têm `scrapAmount > 0` (até 25 no
`crate_elite`); esquecer isso é o servidor perder scrap em silêncio.

**2. A configuração é uma lista de REGRAS, não uma cópia da tabela.** É a
consequência da 1. Uma regra é *"no `crate_elite`, acrescente `trofeu-bleik-store`
com chance 1/5000"* ou *"no `loot_barrel_1`, remova `wood`"*. **Uma regra ocupa
uma linha; a cópia ocupa 1.396.** É também o que faz a configuração sobreviver
ao update do Rust: o que não foi tocado continua sendo o do jogo.

**3. O item custom só entra por regra nossa — e isso já estava medido.** O
**[L§4]** provou que a tabela nativa cria com `skin = 0`. Nada aqui muda isso.
A diferença é que, com o editor, o troféu deixa de ser um caso especial: ele
vira **uma linha na mesma lista** onde o admin também tira o `wood` do barril.

**4. A configuração mora no banco do agente.** É a fonte de verdade do projeto,
e o `oxide/data` do plugin é cópia de trabalho descartável. **Uma migração
basta** — duas tabelas, no molde exato de `custom_items` + `custom_item_servers`
(§5).

**5. Por servidor, sim — e com o padrão da casa, mas com uma diferença.** O
`kit_servers` (012) e o `custom_item_servers` (041) são junções puras de duas
colunas, sem override. Loot **precisa de override por servidor** (a mesma regra
com chance diferente num servidor 5x), e o precedente para isso existe:
`player_servers` (`core/src/db/migrations.ts:593-624`) é junção **com payload**.
Ver §6.

**6. A tela navega por CONTAINER, e mostra probabilidade ao lado do peso.** É a
lição do mercado (§7) e é o que a medição sustenta: são **105 containers** e
**43 tabelas de topo**, mas **650 tabelas** — navegar pela tabela perderia o
admin no terceiro nível. Ver §8.

### 1.3 Onde este estudo CONTESTA o `04` — a tabela da correção

O **[L§n]** foi escrito sem conseguir abrir as tabelas (elas são
`ScriptableObject` dentro de bundles). Agora foram abertas, e dois pontos dele
precisam ser corrigidos. **O ponto principal dele continua de pé**: skin, não.

| O `04` diz | O que foi medido agora | Onde |
|---|---|---|
| **[L§4]** *"a tabela cria com `skin = 0`; o caminho está fechado por construção"* | **confirmado, e nada aqui o contradiz.** `ItemAmount` tem 5 campos e nenhum é skin | §3.4 |
| **[L§6.2]** *"uma tabela de loot do Rust soma dezenas ou poucas centenas — **não medido***" | **medido: a soma vai de 100 a 11.400.** A `WorkbenchTier_2` soma **9.600** — uma entrada nova de peso 1 nela vale **0,0104 %**, que é exatamente a ordem de raridade que o `04` queria. **A granularidade do peso não era o bloqueio**; o bloqueio era só a skin | §2.5 |
| **[L§9.3]** *"acrescentar um `LootSpawnSlot` quebra o container"* | **verdade em 69 containers, FALSO em 35.** Medido: **35 dos 105 já populam por slots**, e neles a armadilha do `FillLoot` não existe — o `lootDefinition` já está morto. E o jogo **já usa** `probability` fina ali: o menor valor em uso é **`0.01f`** | §2.4 |
| **[L§5.5]** *"o default é não refazer o loot; **não medido** quais prefabs sobrescrevem"* | **medido: 71 dos 105 têm refresh finito e ligado**, tipicamente **3600/7200 s**. O `loot_barrel_1` refaz o loot a cada 1–2 h | §2.6 |

> #### &nbsp;&nbsp;A CONSEQUÊNCIA DA TERCEIRA LINHA, E ELA É GRANDE&nbsp;&nbsp; ####
>
> Se **35 containers já populam por `LootSpawnSlots`** — e entre eles estão
> justamente o `crate_normal`, o `crate_normal_2`, o `crate_elite` e o
> `supply_drop` —, então **existe um caminho nativo com granularidade de `float`
> que não quebra nada nesses 35**. Ele continua **não resolvendo a skin**, e por
> isso não serve para o troféu. Mas serve para **tudo o mais que o editor faz**:
> acrescentar um item do jogo, mudar quantidade, mudar chance.
>
> **Isto não muda a recomendação do §4** (o plugin ainda faz o trabalho em
> runtime, porque só ele carimba skin e só ele é reversível). Muda o que se pode
> dizer com honestidade sobre o custo do caminho alternativo — e o `04` foi
> categórico demais.

### 1.4 A tabela-resumo

| Pergunta | Resposta curta | Onde |
|---|---|---|
| Quantas `LootSpawn` existem? | **1.321** no build; **650** alcançáveis por container | §2.2 |
| Quantas entradas no total? | **3.011** (1.232 `items` + 1.779 `subSpawn`); **1.396** no alcançável | §2.2 |
| Quantos containers? | **105** prefabs, **101** nomes distintos, **43** tabelas de topo | §2.3 |
| Quão fundo o `subSpawn` desce? | **5 níveis** (o pior é a `LootSpawn.RadTownElite`) | §2.2 |
| Dá para extrair de dentro do servidor? | **sim**, e o jogo mostra como (`clear_loot_spawn_cache`) | §3.2 |
| O JSON cabe num frame de RCON? | **não. 78,8 KB medidos** contra teto de 50 KB. Precisa paginar | §3.3 |
| Substituir ou complementar? | **complementar** | §4 |
| Quanto ocupa no banco? | uma regra é uma linha. A cópia inteira seriam **~164 KB por servidor** | §5.3 |
| Quantas migrações? | **uma**, com duas tabelas | §5.2 |
| Vale por servidor? | **sim**, e com override — diferente do padrão de kits | §6 |
| Algum plugin de terceiro toca loot? | **não.** `AdminRadar` e `AdminPanel`: zero ocorrências | §9.4 |
| Qual é a menor fatia útil? | acrescentar item nosso a containers escolhidos, com peso | §10 |

---

## 2 — O tamanho do problema, medido

> **Método.** As `LootSpawn` são `ScriptableObject` e **não aparecem no
> `AssetSceneManifest.json`** — ele só lista `.prefab` e `.fbx` (16.358 assets,
> conferido). Elas moram dentro dos bundles binários. Foram lidas com
> **UnityPy 1.25.3** (instalado num venv do scratchpad, fora do projeto) sobre
> `Servers/server01/Bundles/shared/content.bundle` (1,2 GB),
> `assetscenes.bundle` (452 MB) e `items.preload.bundle` (8 MB). Os bundles
> carregam **typetree**, então os campos saem com o nome real — nada aqui é
> deduzido de deslocamento binário.
>
> **O que NÃO foi lido:** `monuments.bundle` (3,0 GB). O UnityPy abriu e
> devolveu **zero objetos**. Está registrado como limite no §11.3.

### 2.1 Onde as tabelas moram

Varredura de strings nos 5,0 GB de bundles: **10.252 caminhos `.asset` únicos**.
Agrupados por pasta, o primeiro lugar é inequívoco:

| Pasta | Arquivos `.asset` |
|---|---:|
| **`assets/content/properties/lootspawn`** | **1.265** |
| `assets/content/sound/music` | 527 |
| `assets/content/sound/sounddefinitions` | 385 |

E, dentro dela:

| Subpasta | Tabelas | O que é |
|---|---:|---|
| `generated/` | **871** | as folhas automáticas: 815 de **um item só** + 52 de raridade×categoria + 4 de raridade |
| `collections/` | **84** | **os "vários itens juntos"** — `ak47 with ammo`, `bow and arrow`, `chainsaw with fuel` |
| `deathmatchloot/` | 75 | as tabelas `DM.*` |
| `halloween/` | 38 | sazonal |
| `electric/` | 32 | |
| `componentloot/` | 27 | |
| (raiz) | **46** | **as de topo**: `lootspawn.barrel`, `lootspawn.radtownelite`, `lootspawn.supplydrop`… |
| outras 10 subpastas | 82 | ammo, armor, workbenchupgrades, airdrop, vehicles, tools, scientistdrops, supermarketfreezer, barreljunk, rareparts, basicweapons |

> **A `collections/` merece um parágrafo.** O AlphaLoot vende como recurso
> avançado a capacidade de *"spawnar vários itens juntos — um rifle com
> munição"* (§7). **O Rust já tem isso, nativo, com 84 tabelas prontas**, e uma
> delas se chama literalmente `ak47 with ammo`. Qualquer coisa que o nosso
> editor faça nesse terreno precisa saber que o mecanismo é **uma `LootSpawn`
> com vários `items` e nenhum `subSpawn`** — não um tipo especial de entrada.

### 2.2 Os números da árvore

| Medida | Valor | Como foi medido |
|---|---:|---|
| `LootSpawn` únicas no build | **1.321** | objetos com `items` **e** `subSpawn` no typetree |
| entradas `items` (`ItemAmountRanged`) | **1.232** | soma de `len(items)` |
| entradas `subSpawn` (`Entry`, com peso) | **1.779** | soma de `len(subSpawn)` |
| **entradas no total** | **3.011** | |
| tabelas **alcançáveis** a partir dos 105 containers | **650** | busca em profundidade pelos `subSpawn`, com PPtr resolvidos |
| entradas alcançáveis | **1.396** | 678 `items` + 718 `subSpawn` |
| **itens distintos** que o loot alcançável pode produzir | **429** | shortnames resolvidos |
| itens distintos citados em **alguma** tabela | **784** | de **1.259** no catálogo do jogo |
| profundidade máxima da árvore | **5 níveis** | `LootSpawn.RadTownElite` |
| `subSpawn` que resolvem para uma tabela existente | **1.779 de 1.779** | a árvore está íntegra, sem ponteiro solto |

E a distribuição — que é o número que decide se a tela é viável:

| Tamanho da tabela | Quantas |
|---|---:|
| 0 entradas | 28 |
| **1 entrada** | **1.004** |
| 2 a 5 | 210 |
| 6 a 20 | 64 |
| 21 ou mais | **15** |

> **A leitura, e ela é a boa notícia deste documento:** **76 % das tabelas têm
> uma entrada só.** Elas são as folhas geradas (`generated/items/...`), que
> existem só para dar um nó à árvore. **O admin não precisa vê-las como
> tabelas** — para ele, `generated/items/weapon/rifle.ak.asset` é o item
> `rifle.ak`, e nada mais. Achatando essas folhas, **o que sobra para editar são
> ~317 tabelas de verdade**, das quais **43 são as de topo**.
>
> A maior tabela do build é a `Workbench_Experiment_Tier_2`: **114 `subSpawn`**,
> soma de pesos **11.400**. É a tech tree, não o loot de container.

### 2.3 Os containers — a unidade que o admin navega

| Medida | Valor |
|---|---:|
| prefabs com componente `LootContainer` | **105** |
| nomes de prefab distintos | **101** |
| tabelas de topo distintas (por `lootDefinition`) | **43** |
| tabelas de topo distintas (incluindo `LootSpawnSlots`) | **93** |
| `LootSpawnSlot` no total | **263** |
| referências de topo, com repetição | **356** |

O servidor confirma a ordem de grandeza pelo seu próprio lado. O convar
`server.clear_loot_spawn_cache` é o jogo enumerando as tabelas de topo de todos
os prefabs registrados, e ele respondeu:

```
Cleared 329 loot spawn caches
```

> **329 (servidor) contra 356 (bundles), e a diferença é explicável.** O IL de
> `ConVar.Server::clear_loot_spawn_cache` mostra `Select` → `Where` → `Concat` →
> `Where` → `ToArray`, e a mensagem imprime `.Length` do array — ou seja,
> **com repetição e sem `Distinct`**, igual à minha conta. As duas divergem
> porque o servidor enumera o `prefabList` dele (que não tem prefabs
> client-only) e usa `GetComponent<LootContainer>()`, que pega o componente **na
> raiz do prefab**, enquanto a minha varredura pega o componente onde ele
> estiver. **Dois métodos independentes, 8 % de diferença** — é a confirmação
> que se pode ter sem escrever um plugin.

### 2.4 Como cada container popula — e por que isso corrige o `04`

`LootContainer::FillLoot` tem dois ramos, e **o ramo dos slots termina em
`ret`** (medido no `04`, §2.3). Portanto, num container que tenha os dois, o
`lootDefinition` **nunca roda**. Quantos são:

| Como popula | Containers | Consequência |
|---|---:|---|
| só `lootDefinition` | **69** | a armadilha do `04` §9.3 vale aqui: pôr um slot desliga a tabela |
| só `LootSpawnSlots` | **11** | acrescentar slot é seguro |
| **ambos** | **24** | o `lootDefinition` é **código morto**; acrescentar slot é seguro |
| nenhum dos dois | 1 | |

E os slots, que são o mecanismo com granularidade fina:

| Medida | Valor |
|---|---:|
| slots por container | mín. 1 · **mediana 5** · máx. **21** (`codelockedhackablecrate`) |
| valores distintos de `probability` | 21 |
| slots com `probability` abaixo de 5 % | **17** |
| **o menor valor em uso pelo próprio jogo** | **`0.01f`** (1 %) |
| slots desligados (`numberToSpawn == 0`) | 4 |
| slots com era declarada | 23 de 263 |

Os quatro containers que mais importam para o pedido, medidos um a um:

```
loot_barrel_1.prefab      popula por lootDefinition   maxDef=1  scrap=2
   LootSpawn.Barrel: 0 items, 3 subSpawn, soma de pesos = 100

crate_normal.prefab       popula por SLOTS            maxDef=1  scrap=8
   lootDefinition = LootSpawn.RadTown1 (3 subSpawn, soma 140)  <-- MORTO
   8 slots:  1.00 -> LootSpawn.Components.Tier3
             0.40 -> WorkbenchTier_2
             0.01 -> supply.signal          <-- o proprio jogo usa 1 %
             0.05 -> LargeBackpack
             0.05 -> MetalPlateInsert
             0.10 -> basicblueprintfragmentloot_single
             0.05 -> WorkbenchUpgrades.Medium
             0.06 -> HeavyFuse

crate_elite.prefab        popula por SLOTS            maxDef=2  scrap=25
   lootDefinition = LootSpawn.RadTownElite (2 subSpawn, soma 110)  <-- MORTO
   7 slots:  1.00 x1 -> LootSpawn.RadTown1
             1.00 x2 -> LootSpawn.RadTownElite
             0.65    -> Collection.Weapons
             0.20    -> MLRSAmmo
             0.10    -> advanceblueprintfragmentlootsingle
             0.075   -> WorkbenchUpgrades.High
             0.10    -> BallisticArmor

supply_drop.prefab        popula por SLOTS            maxDef=8  scrap=0
   15 slots (ResourceRoll, ArmorRoll x2, GunRoll, Ammo x3, ToolRoll,
             MedievalRoll, basicblueprintfragmentloot, BallisticArmor...)
```

> #### &nbsp;&nbsp;O ADMIN QUE EDITAR A `LootSpawn.RadTown1` NÃO MEXE NO `crate_normal`&nbsp;&nbsp; ####
>
> Está medido acima: o `crate_normal` **tem** um `lootDefinition` apontando para
> a `LootSpawn.RadTown1`, e esse ponteiro **não é executado**, porque o container
> tem 8 slots e o `FillLoot` retorna no ramo dos slots.
>
> **Uma tela que mostrasse "crate_normal → LootSpawn.RadTown1" estaria mentindo
> para o admin**, e a mentira só apareceria dias depois, como *"editei e não
> mudou nada"*. A tela **precisa** resolver qual ramo está vivo antes de
> desenhar — é uma regra de exibição, não um detalhe. Ver §8.3.

### 2.5 A granularidade do peso — o número que faltava ao `04`

`LootSpawn.Entry.weight` é `Int32` e o sorteio é `P = peso / soma` (**[L§2.2]**).
O `04` não conseguiu medir as somas e supôs *"dezenas ou poucas centenas"*.
Medido, elas variam duas ordens de grandeza:

| Tabela de topo | Entradas | Soma dos pesos | Menor `P` de uma entrada nova (`weight = 1`) |
|---|---:|---:|---|
| `WorkbenchTier_2` | 96 | **9.600** | **0,0104 %** |
| `WorkbenchTier_1` | 90 | 9.000 | 0,0111 % |
| `WorkbenchTier_0` | 31 | 3.100 | 0,0322 % |
| `LootSpawn.Components.Tier3` | 6 | 600 | 0,166 % |
| `LootSpawn.Hackcrate` | 10 | 260 | 0,383 % |
| `HeliLoot` | 7 | 200 | 0,498 % |
| `LootSpawn.BlackBox` | 5 | 170 | 0,585 % |
| **`LootSpawn.Barrel`** | **3** | **100** | **0,990 %** |

Estatística sobre as 201 tabelas com `subSpawn`: soma **mínima 0**, **mediana
160**, **máxima 11.400**. Pesos individuais: mínimo **0** (4 entradas
desligadas), mediana **100**, máximo **400**.

> **A leitura honesta:** o `04` estava certo sobre o **barril** — 1/101 é o piso
> ali, e isso é longe do 1/7.000 que ele queria. E estava errado como
> generalização: nas tabelas de workbench o piso já é 1/10.000. **Mas nada disso
> muda a conclusão dele**, porque o bloqueio do troféu nunca foi a
> granularidade: era a skin. O que muda é o **argumento**, e argumento errado
> apodrece.

### 2.6 O refresh, agora medido

O `04` mediu que `minSecondsBetweenRefresh` nasce em `0f` no `.ctor` e registrou
como **não medido** quais prefabs sobrescrevem. Medido nos 105:

| Refresh | Containers |
|---|---:|
| **finito e > 0** | **71** |
| infinito (`inf`) | 30 |
| zero (nunca) | 4 |

Os valores típicos: **3600 / 7200 s** (1 a 2 h) na maioria; **900 / 1800 s** no
`trash-pile-1` e no `foodbox`; **1800 / 3600 s** no `oil_barrel` e no
`loot_component_test`.

> **Consequência direta para a feature:** o `OnLootSpawn` de um barril **não
> dispara uma vez só** — ele dispara de novo a cada 1–2 h de vida do container.
> Qualquer conta de "quantas vezes por dia a nossa regra roda" precisa dessa
> segunda fonte, e ela é grande: 400 barris vivos com refresh de 1,5 h dão da
> ordem de **6.400 populações por dia** só de barril, sem ninguém abrir nada.
> **Isto é aritmética sobre um número medido, não medição** — o giro real
> depende de destruição e reposição, e continua sendo o que a Fatia 1 do
> **[L§10]** existe para medir.

---

## 3 — O que dá para extrair, por onde, e se cabe no cano

### 3.1 As três fontes possíveis, e qual serve para quê

| Fonte | Alcança | Custo | Serve para |
|---|---|---|---|
| **bundles do servidor**, lidos fora do jogo (o que este estudo fez) | tudo o que está nos bundles lidos | offline, minutos, zero risco | **semear o catálogo uma vez**; não serve de fonte viva |
| **memória do servidor**, por comando de plugin | exatamente o que o servidor carregou, com era e game mode aplicados | uma varredura no boot | **a fonte certa**, e é a que o §3.2 desenha |
| painel do jogo / tentativa e erro | nada de estrutural | caro | não serve |

### 3.2 O caminho de dentro do servidor existe, e o jogo mostra qual é

O **[L§3.5]** já tinha achado a porta; agora ela está confirmada com o IL na mão.
`ConVar.Server::clear_loot_spawn_cache` faz, em LINQ:

```
GameManager.server.preProcessed.prefabList.Values
    .Select(prefab => prefab.GetComponent<LootContainer>())
    .Where(c => c != null)
    .ToArray()
    .Select(c => c.lootDefinition)
    .Concat( .SelectMany(c => c.LootSpawnSlots).Select(s => s.definition) )
    .Where(d => d != null)
    .ToArray()
    -> foreach: LootSpawn.ClearCache()
    -> ReplyWith(string.Format("Cleared {0} loot spawn caches", array.Length))
```

> **Um plugin nosso pode fazer exatamente isto, trocando o `ClearCache()` por um
> `Serialize()`** — e obtém, **sem precisar de nenhuma entidade no mundo e antes
> de o mapa nascer**, o mapa completo `prefab -> tabela de topo -> subárvore`.
> É a fonte certa porque ela reflete **o que este servidor carregou**, incluindo
> o que a era e o game mode filtraram.

**O que o dump precisa carregar por entrada**, para a tela do §8 não precisar de
uma segunda fonte:

| Campo | De onde | Por quê |
|---|---|---|
| `ShortPrefabName` do container | `LootContainer` | é a unidade de navegação (§8.2) |
| qual ramo está vivo (`slots` ou `lootDefinition`) | `LootSpawnSlots.Length > 0` | senão a tela mente (§2.4) |
| `maxDefinitionsToSpawn`, `scrapAmount` | `LootContainer` | o admin precisa saber quantas rodadas e quanto scrap |
| nome da tabela, `items[]`, `subSpawn[]` | `LootSpawn` | a árvore |
| `weight`, `extraSpawns` por `Entry` | `LootSpawn.Entry` | a probabilidade efetiva |
| `itemDef.shortname`, `amount`, `maxAmount` | `ItemAmountRanged` | **89 entradas têm faixa** (`maxAmount > amount`), medido |
| `probability`, `numberToSpawn` por slot | `LootSpawnSlot` | é onde mora a granularidade fina |

### 3.3 O transporte — e ele NÃO cabe num frame

Os tetos, medidos no repositório:

| Constante | Valor | Onde |
|---|---:|---|
| `MAX_PUSH_BYTES` | **50.000** | `core/src/game/plugin-push.ts:70` |
| medido atravessando íntegro no projeto anterior | ~70 KB | comentário em `plugin-push.ts:56-69` |
| `MaxBpExportBytes` | 60.000 | `Plugins/OrigemZAgent.cs:3652` |
| `MaxPendingBytes` | 60.000 | `Plugins/OrigemZItems.cs:341` |

E o tamanho do que se quer transportar, **medido** serializando o dump real:

| O que | JSON compacto |
|---|---:|
| as 1.321 tabelas, tudo | **151,9 KB** |
| **as 650 alcançáveis, com shortnames resolvidos** | **78,8 KB** |
| as 650 alcançáveis, sem resolver shortname | 70,2 KB |

> #### &nbsp;&nbsp;78,8 KB CONTRA 50 KB: PAGINAR NÃO É OPCIONAL&nbsp;&nbsp; ####
>
> E não adianta cortar campo: mesmo a versão mais magra que ainda serve para
> desenhar a tela passa de 70 KB. **O export precisa de paginação**, e o molde
> está pronto e medido: o `origemz.bp.export`.
>
> **O padrão dele, em `core/src/wipe/blueprints.ts`:**
> - comando `origemz.bp.export <offset> <limit>` (`:242-244`), `limit` padrão
>   **25**, máximo **100** (`:193-194`);
> - a resposta traz `count` = **o total**, não o tamanho da página (`:207-225`);
> - quando não cabe, o plugin devolve `PAYLOAD_TOO_LARGE` (`:205`) e o agente
>   **divide o limite por dois sem avançar o offset** (`:393-435`);
> - o offset avança pelo **`limit` que voltou**, não pelo pedido.
>
> **Os dois detalhes que valem copiar são exatamente esses dois últimos.** Um
> export de loot tem páginas de tamanho muito desigual — a `Workbench_Experiment_Tier_2`
> sozinha tem 114 entradas, e a mediana é 1 —, então o backoff não é teoria: ele
> vai disparar.
>
> **A unidade de paginação recomendada é o CONTAINER**, não a tabela: são 105, o
> número é estável, e cada página vira uma linha de tela pronta. Uma página de
> 10 containers com a subárvore junta fica na ordem de 8 KB — com folga
> confortável dentro dos 50 KB.

**O caminho inverso — mandar a configuração ao plugin — não precisa disso.** Ele
manda **regras**, não a tabela (§1.2, decisão 2), e o padrão que serve é o do
`custom-items-sync`: `clear` seguido de um `set` por regra
(`core/src/game/custom-items-sync.ts:16-27`, `:348-350`). O comentário daquele
arquivo já explica por que N comandos ganham de um payload único quando cada
item traz texto livre — vale igual aqui.

### 3.4 O que o dump NÃO resolve, e continua não resolvendo

**A skin.** Está medido no **[L§4]** e nada aqui muda: `ItemAmount` tem cinco
campos e nenhum é skin; `SpawnIntoContainer` passa `0uL` literal. **Extrair a
tabela e devolvê-la editada não faz o Troféu Bleik nascer no barril** — faz
nascer um `discord.trophy` sem marca, que o `Match`
(`Plugins/OrigemZItems.cs:1057-1060`) descarta.

> **Por isso o editor não é um editor de `ScriptableObject`.** Ele é um editor de
> **regras que o nosso plugin aplica em runtime** — e é justamente por serem
> nossas que elas podem carregar skin, ao contrário de qualquer coisa que a
> tabela nativa consiga expressar.

---

## 4 — Substituir ou complementar

> A pergunta que define a feature. As duas foram medidas; a recomendação vem com
> o custo de cada uma.

### 4.1 O que cada uma significa, em mecanismo

| | **Substituir** | **Complementar** |
|---|---|---|
| o hook | `OnLootSpawn` devolve **não-nulo** — o `PopulateLoot()` nunca roda | `OnLootSpawn` devolve **null** e agenda `NextTick` — o jogo popula, nós ajustamos depois |
| quem enche o container | **nós** | o jogo |
| o que precisa existir no banco | **a tabela inteira**: 650 tabelas, 1.396 entradas, por servidor | **só as regras**: uma linha por decisão do admin |
| o que acontece num update do Rust | a nossa cópia **congela**; a do jogo muda e ninguém percebe | o que não foi tocado **acompanha o jogo, de graça** |
| erro do admin | pode **esvaziar os barris do mapa** | pode acrescentar item demais num container |
| reversível? | não — desligar o plugin muda o loot inteiro | **sim** — desligar o plugin devolve o loot do jogo |

### 4.2 O custo de substituir, item por item — e é maior do que parece

Substituir não é "escrever os itens no container". É reimplementar o
`PopulateLoot`, cujo conteúdo está medido no **[L§2.3]**:

| Peça que precisaria ser refeita | Evidência de que ela importa |
|---|---|
| o sorteio ponderado com `1 + extraSpawns` | 1.779 `Entry` medidas |
| os `LootSpawnSlots` com `probability` e `numberToSpawn` | **263 slots** em 35 containers |
| `maxDefinitionsToSpawn` (quantas rodadas na tabela) | vai de 0 a 8 nos 105 |
| o sorteio de **condição** do item (`fractionMin..fractionMax`, `SpawnType` 2 ou 3) | está no `PopulateLoot`, e nenhum plugin o herda de graça |
| **`GenerateScrap()`** | **34 dos 105 têm `scrapAmount > 0`**, até **25** no `crate_elite` |
| `HasBeenLooted = false` e `FirstLooterId = 0` | são o que o `clanScoreEventForFirstLooter` usa |
| o filtro de **era** (`restrictedEras`, `eras` do slot) | 15 `Entry` + 23 slots os declaram |
| o guard de 32 iterações do laço de criação | itens de `stackable` baixo |

> #### &nbsp;&nbsp;O DEFEITO QUE SUBSTITUIR PRODUZ É O PIOR TIPO&nbsp;&nbsp; ####
>
> Ele é **silencioso e tardio**. Se a nossa reimplementação esquecer o scrap, o
> servidor passa a dar 0 scrap por `crate_elite` em vez de 25 — e ninguém abre
> um ticket dizendo *"o scrap sumiu"*; os jogadores dizem *"o servidor está
> ruim"*, seis semanas depois.
>
> Se ela esquecer o filtro de era, o loot de Halloween (**38 tabelas medidas**)
> passa a sair em março.
>
> E se um erro do admin zerar uma tabela, **os 400 barris do mapa ficam vazios**,
> e o sintoma aparece só quando alguém abrir o primeiro — o `04` já descreveu
> essa armadilha no §9.4, e ela vale igual aqui.

### 4.3 O custo de complementar — e ele também precisa ser dito

Complementar não é grátis:

1. **O item é criado e destruído.** Remover `wood` do barril significa deixar o
   `ItemManager.Create` rodar e depois chamar `Remove()`. É desperdício de um
   objeto por container populado — irrelevante em custo, mas é preciso saber que
   é assim.
2. **"Trocar a chance de um item" não tem tradução direta.** Numa tabela nativa,
   mudar o peso do `wood` muda a probabilidade de **todos** os outros
   (`P = peso / soma`). Complementando, a operação honesta é *"remova
   `wood` em 70 % das vezes"* — que **não é a mesma coisa** e precisa ser dita
   assim na tela, ou o admin vai achar que ajustou o peso.
3. **O `OnLootSpawn` dispara com o inventário vazio** (medido, **[L§3.2a]**).
   Toda regra que olha o que caiu **tem de rodar no `NextTick`** — o padrão que
   o plugin já usa em `OrigemZItems.cs:1272` e `:1475`.
4. **O custo por container populado deixa de ser zero.** Com refresh de 1–2 h em
   71 containers (§2.6), a rotina roda milhares de vezes por dia. Ela precisa
   sair cedo quando não há regra para aquele prefab — um `Dictionary` indexado
   por `ShortPrefabName`, no molde do `_byMark.Count == 0` que o plugin já usa
   (`OrigemZItems.cs:1406-1409`).

### 4.4 A recomendação

> #### &nbsp;&nbsp;COMPLEMENTAR — E O MOTIVO NÃO É SEGURANÇA, É O UPDATE&nbsp;&nbsp; ####
>
> Segurança é o argumento óbvio, e ele é verdadeiro: um erro em "complementar"
> estraga um container; em "substituir", estraga o mapa. Mas o argumento que
> decide é outro, e é econômico.
>
> **A tabela do jogo é um ativo que a Facepunch mantém de graça.** São 1.396
> entradas alcançáveis, balanceadas, com filtro de era e conteúdo sazonal — 38
> tabelas de Halloween que aparecem e somem sozinhas. Substituir é **assumir a
> manutenção disso**, e assumir em silêncio: no dia em que a Facepunch mexer no
> loot, o nosso servidor simplesmente não muda, e não há erro nenhum para
> avisar.
>
> **Existe um mercado inteiro que prova esse custo.** Codefling e Payhip vendem
> configurações prontas de 2x, 3x, 5x e 10x (§7). Ninguém vende o que é barato
> de fazer.
>
> **Complementar mantém a Facepunch trabalhando para nós** e nos deixa mexer só
> onde quisemos mexer. E, para o único caso em que substituir é de fato
> necessário — um container que o servidor queira reinventar por inteiro —, o
> desenho deixa a porta: uma regra do tipo **"esvaziar antes"** por container,
> que é a substituição feita **explicitamente, num container só, e com aviso na
> tela**. Ver §8.5 e a pergunta Q3.

---

## 5 — Onde a configuração mora

### 5.1 A resposta, e o motivo

**No banco do agente.** O `oxide/data` do plugin é cópia de trabalho
descartável, e a razão já está escrita na casa: o **[L§5.1]** registrou que
*"cadastro perdido o agente remanda; o que não volta é o que já aconteceu no
mundo"*. Uma configuração de loot é cadastro puro — nada dela é fato consumado.

O que **não** pode morar só no plugin é a contagem de emissões (o teto do
**[L§6.4]**), pelo motivo que aquele documento já deu: um `oxide.reload` no meio
do dia zeraria o contador. Isso continua sendo a pergunta Q3 do `04` e não é
reaberto aqui.

### 5.2 Uma migração, duas tabelas

O molde é literal — o comentário da migração 041 diz, sobre
`custom_item_servers`, que ela é *"cópia do `kit_servers` (012), inclusive o
índice"* (`core/src/db/migrations.ts:3257-3258`).

Estado atual do arquivo: **4.303 linhas**, **44 migrações** (ids 1 a 8 e 10 a
45), última é a **045** (`items-consumable`, `:4245`). O runner aplica cada id
**uma vez, para sempre**, uma transação por passo (`:4259-4303`) — então a
próxima é a **046**.

O esqueleto proposto (**não validado**, é projeto):

```sql
-- 046: as regras de loot, e em quais servidores cada uma vale.

CREATE TABLE loot_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,               -- o que o admin lê na lista
  container     TEXT NOT NULL,               -- ShortPrefabName, ou '*'
  kind          TEXT NOT NULL
                CHECK (kind IN ('add', 'remove', 'clear')),
  item_ref      TEXT,                        -- shortname OU id de custom_items
  item_kind     TEXT NOT NULL DEFAULT 'game'
                CHECK (item_kind IN ('game', 'custom')),
  amount_min    INTEGER,
  amount_max    INTEGER,
  chance        REAL NOT NULL DEFAULT 1.0
                CHECK (chance > 0 AND chance <= 1),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_loot_rules_container ON loot_rules (container);

-- Junção COM payload, como player_servers (593-624) e ao contrario de
-- kit_servers (012) e custom_item_servers (041). O porque esta no §6.
CREATE TABLE loot_rule_servers (
  rule_id    INTEGER NOT NULL REFERENCES loot_rules(id) ON DELETE CASCADE,
  server_id  TEXT    NOT NULL REFERENCES servers(id)    ON DELETE CASCADE,
  chance     REAL,        -- NULL = usa o da regra
  amount_min INTEGER,     -- NULL = usa o da regra
  amount_max INTEGER,     -- NULL = usa o da regra
  PRIMARY KEY (rule_id, server_id)
);

CREATE INDEX idx_loot_rule_servers_server ON loot_rule_servers (server_id);
```

**O que NÃO entra no banco:** a tabela extraída do jogo. Ela é **cache**, não
cadastro — ela se refaz a cada boot e envelhece a cada update. Se for preciso
guardá-la para desenhar a tela sem o servidor no ar, o lugar é um cache
com carimbo de data, não uma tabela de domínio. Ver a pergunta Q2.

### 5.3 Quanto ocupa

| Cenário | Linhas | Tamanho |
|---|---:|---:|
| **regras** (o recomendado): 20 a 50 regras é uma configuração agressiva | **~50** | **< 10 KB** |
| a **cópia da tabela do jogo**, se o §4 tivesse ido para "substituir" | **1.396 por servidor** | **~164 KB por servidor** |
| a mesma cópia, com 6 servidores | 8.376 | ~1 MB |

> Os ~164 KB são `1.396 × ~120 bytes/linha` em SQLite — **estimativa de
> tamanho de linha, não medição**. O 1.396 é medido; o 120 é a ordem de
> grandeza usual para uma linha com meia dúzia de colunas curtas mais índice.
> A conclusão não depende da precisão: **1 MB de dados que envelhecem sozinhos
> é pior que 10 KB que não envelhecem**, e nenhum dos dois é um problema de
> disco.

---

## 6 — Por servidor

### 6.1 Sim — e o padrão da casa quase serve

O padrão está fixado em dois lugares e é literalmente o mesmo:

```sql
-- kit_servers        (012, core/src/db/migrations.ts:1035-1044)
-- custom_item_servers (041, core/src/db/migrations.ts:3264-3271)
CREATE TABLE <coisa>_servers (
  <coisa>_id ... REFERENCES <coisa>(id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (<coisa>_id, server_id)
);
CREATE INDEX idx_<coisa>_servers_server ON <coisa>_servers (server_id);
```

Três propriedades desse padrão, todas confirmadas na leitura:

1. **Uma linha por (recurso, servidor)** — a associação é a presença da linha.
2. **Sem coluna de "ativo" na junção.** O `enabled` mora na tabela do recurso e
   é **global**; "ligado neste servidor" é ter a linha.
3. **Sem override de campo nenhum.** É associação pura.
4. **Sem linha = em nenhum servidor** — declarado no comentário da 041
   (`:3262-3263`). Não existe default "vale em tudo".

E o padrão de escrita é **delete-all-then-insert** dentro da transação de
`create`/`update` (`core/src/db/custom-items-repository.ts:353-368`), porque o
`update` é PUT total e não PATCH.

### 6.2 A diferença que loot obriga

> #### &nbsp;&nbsp;LOOT PRECISA DE OVERRIDE, E O PADRÃO PURO NÃO O TEM&nbsp;&nbsp; ####
>
> Um kit ou um item custom é o mesmo objeto em todo servidor onde existe: o
> mesmo preço, os mesmos itens. Por isso a junção pura basta.
>
> **Loot não é.** A mesma regra — *"acrescente `metal.refined` ao `crate_elite`"*
> — quer quantidade **diferente** num servidor 5x e num servidor vanilla. É o
> caso de uso central de um editor de loot: **é para isso que o mercado vende
> configurações de 2x, 3x, 5x e 10x** (§7). Sem override, o admin cria a mesma
> regra cinco vezes com nomes diferentes, e a lista vira lixo em duas semanas.
>
> **E o precedente existe na casa**, então isto não é inventar padrão:
> `player_servers` (`core/src/db/migrations.ts:593-624`) tem PK
> `(server_id, steam_id)` **e sete colunas de dados por servidor**. A junção com
> payload já é um molde deste repositório.
>
> **A regra de leitura proposta:** coluna `NULL` na junção significa *"usa o
> valor da regra"*. Isso preserva o caso comum (uma regra, todos os servidores,
> um valor) sem custo, e deixa o override para quem precisar. É a pergunta Q4.

---

## 7 — O que o mercado já faz

> Esta seção existe porque **o problema não é novo**, e ignorar quem já o
> resolveu é começar pagando de novo. Nada aqui foi medido por mim — é leitura
> de páginas de produto, e está marcado como tal no §11.4.

### 7.1 Os quatro produtos, e o que cada um ensina

| Produto | O que é | O que vale copiar |
|---|---|---|
| **AlphaLoot** (`chaoscode.io/resources/alphaloot.13`) | o plugin pago dominante | **o vocabulário** (§7.2) e o conceito de perfil "avançado" |
| **Looty Editor** (`looty.cc/alphaloot`) | editor visual web, em beta | *"profiles group items with weights"*; e a promessa que ele vende: **visualizar rolls** para *"balancear wipes mais rápido"* |
| **AlphaLoot Profile Editor** (`chaoscode.io/resources/alphaloot-profile-editor.183`) | outro editor visual | lê **os bundles do cliente do Rust** para montar a lista de itens, *"garantindo acesso aos itens disponíveis sem precisar atualizar o editor"* |
| **Codefling / Payhip** | vendem **configurações prontas** de 2x, 3x, 5x, 10x | o fato de existirem |

### 7.2 O vocabulário, e por que adotá-lo

O AlphaLoot fixou dois termos que os admins de Rust já conhecem:

| Termo dele | Significa | O nosso equivalente |
|---|---|---|
| **Loot Table** | o arquivo inteiro, com os perfis de todos os containers (`default_loottable.json`) | a configuração de um servidor |
| **Loot Profile** | a configuração de **um** container (`oxide/data/AlphaLoot/LootProfiles/`) | as regras que apontam para um `ShortPrefabName` |

> **Adotar isso é barato e paga.** Um admin que já mexeu com AlphaLoot abre a
> nossa tela e reconhece o mapa. Um admin que nunca mexeu vai ler tutorial de
> AlphaLoot no YouTube de qualquer jeito — é o que existe. **Inventar um terceiro
> vocabulário é fazer o nosso painel competir com a documentação alheia.**

### 7.3 O que eles resolvem e o nosso desenho não — dito com todas as letras

**1. Perfil avançado: vários itens juntos.** O exemplo da documentação do
AlphaLoot é *"um rifle com munição"*. **O nosso desenho de regra
(`add`/`remove`/`clear`) não expressa isso** — uma regra acrescenta um item.

Duas coisas a dizer sobre isso:

- **o Rust já resolve nativamente**, e melhor: são as **84 tabelas de
  `collections/`** medidas no §2.1, e uma delas se chama `ak47 with ammo`. Uma
  regra `add` que aponte para uma *collection* em vez de um item entrega o
  recurso sem inventar estrutura;
- **mas isso é projeto, não medição.** Não foi verificado se um plugin consegue
  invocar `LootSpawn.SpawnIntoContainer` de uma collection num container
  arbitrário. É a pergunta Q5, e ela **não é bloqueante para a fatia mínima**.

**2. Simulação de rolls.** O Looty vende isso como diferencial, e com razão —
§8.4 concorda e transforma em requisito. **O nosso desenho consegue simular a
parte que é nossa** (as regras), mas **não consegue simular a parte que é do
jogo** sem reimplementar o sorteio de `FillLoot` no painel. Duas saídas, e as
duas são projeto:

- simular **só o efeito das nossas regras** ("nesta caixa, o troféu sai 1 vez a
  cada 5.000"), que é honesto e barato;
- ou pedir a simulação ao **servidor**, que é quem tem a tabela — um comando de
  plugin que rode N sorteios em memória e devolva a contagem. **Isto não pode
  ser o `spawn.simulate_loot` nativo**: o **[L§9.5]** mediu que ele exige jogador
  e que **repopula o container real** — ele não é simulação.

**3. Ler os bundles para montar a lista de itens.** O AlphaLoot Profile Editor
faz isso; **nós já resolvemos melhor e está pronto**. O catálogo vem do servidor
por `origemz.items` (`core/src/game/item-catalog.ts:87`, páginas de 250) e mora
na tabela `items` — **1.259 itens**, conferido contra o dump dos bundles, que
achou os mesmos 1.259. O picker já existe:
`panel/src/components/item-picker-dialog.tsx` (204 linhas, grade de ícones,
busca, filtro por categoria, `PAGE_SIZE = 120`).

> **Ou seja: das três coisas que o mercado faz, uma nós já fazemos melhor, uma
> (simulação) precisa entrar no desenho, e uma (itens agrupados) tem resposta
> nativa que ainda não foi verificada.**

---

## 8 — A tela

> Descrita, não implementada. O critério do dono é *"totalmente fácil para o
> admin configurar e achar as categorias certas"*, e as três lições do §7 são o
> que traduz isso em decisões.

### 8.1 Onde ela mora

A tela de itens já tem duas abas — *"Do jogo"* e *"Nossos"* — em
`panel/src/app/itens/page.tsx:77-97`, e o comentário daquele arquivo
(`:66-77`) explica por que elas ficam juntas: *"separar obrigaria a ir e voltar
para cadastrar um"*. **Loot é uma terceira página, não uma terceira aba** — o
objeto que ela edita não é um item, é um container. A aba certa para o item
custom continua sendo "Nossos"; o que a página de loot faz é **usar** o item
que já está lá.

### 8.2 A navegação: container primeiro

> #### &nbsp;&nbsp;A UNIDADE É O CONTAINER, E A MEDIÇÃO CONCORDA COM O MERCADO&nbsp;&nbsp; ####
>
> O admin pensa *"quero mexer na caixa de elite"*, nunca *"quero mexer na
> `LootSpawn.RadTownElite`"*. E os números dizem a mesma coisa: são **105
> containers** contra **650 tabelas alcançáveis**. Navegar por tabela é oferecer
> ao admin uma lista seis vezes maior, cheia de nomes que ele nunca ouviu, dos
> quais **1.004 têm uma entrada só** e existem apenas para dar um nó na árvore.

A tela de entrada é **uma lista de containers**, agrupada pelo que o admin
reconhece:

| Grupo | Containers | Exemplos medidos |
|---|---|---|
| **Barris e lixo** | mundo aberto, rota de farm | `loot_barrel_1`, `loot_barrel_2`, `trash-pile-1`, `oil_barrel`, `loot_trash`, `minecart` |
| **Caixas comuns** | radtown baixo | `crate_basic`, `crate_shore`, `foodbox`, `crate_tools`, `crate_mine` |
| **Caixas boas** | radtown médio/alto | `crate_normal`, `crate_normal_2`, `crate_elite`, `crate_underwater_basic`, `crate_underwater_advanced` |
| **Eventos** | | `heli_crate`, `bradley_crate`, `supply_drop`, `codelockedhackablecrate`, `satellite_crate_1..3` |
| **Missão e tutorial** | | `missionstash`, `tacklebox`, `crate_elite_tutorial`, `loot-barrel-tutorial` |
| **Sazonal** | | `giftbox_loot`, `stocking_large_deployed`, `xmastunnellootbox` |

Cada linha mostra, sem clicar: **nome amigável**, `ShortPrefabName`, **quantas
regras nossas** já existem ali, e o **refresh** (que 71 dos 105 têm, §2.6).

### 8.3 A tela do container — e a regra que impede a tela de mentir

Ao abrir um container, três blocos:

**Bloco 1 — o que o jogo põe aqui (só leitura).** A árvore extraída, achatada
para o que o admin entende. Duas regras de exibição, ambas obrigatórias:

> **(a) Resolver o ramo vivo antes de desenhar.** Medido no §2.4: **24
> containers têm `lootDefinition` E slots**, e nesses o `lootDefinition` é
> código morto. A tela **não pode** mostrá-lo. Mostrar seria produzir o pior
> defeito possível de uma ferramenta de configuração: o admin edita, salva,
> e nada acontece.
>
> **(b) Achatar as folhas de um item.** As **1.004 tabelas de uma entrada** não
> são tabelas para o admin — são itens. `generated/items/weapon/rifle.ak.asset`
> deve aparecer como **`rifle.ak`**, com o ícone que o catálogo já tem.

Com essas duas, o `crate_elite` — que tem 7 slots, profundidade 5 e a maior
subárvore dos containers de interesse — vira uma lista de **duas dezenas de
linhas**, não de centenas.

**Bloco 2 — as nossas regras.** A lista editável. É o único bloco que escreve.

**Bloco 3 — a prévia.** O §8.4.

### 8.4 Peso, probabilidade e a prévia

> #### &nbsp;&nbsp;PESO NÃO É PROBABILIDADE, E A TELA PRECISA MOSTRAR AS DUAS&nbsp;&nbsp; ####
>
> `P = peso / soma` (**[L§2.2]**), e a soma é do **conjunto**. Consequência que
> pega todo mundo: **mudar um peso muda a probabilidade de todos os outros.**
> Um admin que sobe o peso do `metal.refined` de 20 para 40 na `LootSpawn.Barrel`
> (soma medida: **100**) não dobrou a chance dele — levou a soma a 120 e
> **derrubou a chance de todo o resto em 17 %**, sem ter tocado em nada disso.
>
> **A tela mostra o peso digitável e a porcentagem ao lado, recalculada ao
> vivo** — e, quando um peso muda, ela precisa mostrar **as porcentagens que se
> moveram**, não só a que foi editada. Sem isso, a tela é uma armadilha
> educada.

E a prévia, que o mercado vende como o recurso central e não como extra:

**"Abrindo 100 destas caixas, sai isto"** — uma lista de itens com contagem
esperada. Nas nossas regras, ela é aritmética simples (`chance × 100`) e não
depende de nada externo. Na parte do jogo, ela depende do §7.3 e é a pergunta
Q5.

> **Por que a prévia não é enfeite:** ninguém raciocina sobre "peso 47 numa soma
> de 830". A prévia é o que transforma a tela de **editor de números** em
> **ferramenta de balanceamento** — e é literalmente o que o concorrente cobra
> por.

### 8.5 A regra de esvaziar, e o aviso que ela obriga

A regra `clear` (§5.2) é a substituição feita explicitamente num container só.
Ela é a válvula para o caso legítimo — *"neste crate eu quero o meu loot e mais
nada"* — e é perigosa exatamente pelos motivos do §4.2.

> **A tela precisa tratá-la como destrutiva:** confirmação separada, aviso do
> tipo *"este container deixa de receber o loot do jogo, inclusive o que for
> acrescentado em updates futuros"*, e um marcador visível na lista de
> containers. **O padrão de confirmação já existe** — o `ConfirmButton` que o
> `panel/src/components/custom-items-panel.tsx` usa para apagar.

### 8.6 Como o item custom entra

Pelo picker que já existe. A regra `add` tem dois modos — **item do jogo**
(`item_kind = 'game'`, `item_ref` = shortname, vindo do catálogo de 1.259) e
**item nosso** (`item_kind = 'custom'`, `item_ref` = id de `custom_items`).

> **O Troféu Bleik deixa de ser um caso especial.** Ele vira uma linha:
> *"`crate_elite` · acrescentar · Troféu Bleik Store · chance 1/5000"*. Todo o
> desenho de raridade do **[L§6.4]** — teto por dia, teto por semana, carência
> desde o boot, filtro por prefab — continua valendo e continua morando no
> plugin; o que muda é que **o admin passa a enxergar e ajustar a chance sem
> pedir para ninguém**.

---

## 9 — O que quebra

### 9.1 O buraco do boot — o mesmo, e aqui ele é pior

O **[L§5.4]** mediu: `BaseNetworkable::Spawn` chama `ServerInit()` (que popula o
loot) muito antes de qualquer `OnServerInitialized`, e o plugin só **pede** o
cadastro no `OnServerInitialized` (`Plugins/OrigemZItems.cs:424-431`, `:476-479`).
**O mapa nasce antes de a configuração chegar.**

Para o troféu, o `04` observou que isso **é uma defesa por acidente**: com o
índice vazio, nada é injetado no wipe.

> #### &nbsp;&nbsp;PARA O EDITOR DE LOOT, O MESMO ACIDENTE É UM DEFEITO&nbsp;&nbsp; ####
>
> Uma regra que **remove** `wood` do barril, ou que **esvazia** um crate, tem de
> valer desde o primeiro container do wipe. Se ela chegar tarde, **os primeiros
> milhares de containers do mapa nascem com o loot errado** — e ficam assim, ou
> até o refresh (1–2 h em 71 dos 105, §2.6), ou até o wipe seguinte nos outros
> 34.
>
> O sintoma seria *"a configuração não pegou na primeira hora"*, o que é
> praticamente indetectável e destrói a confiança na ferramenta.
>
> **Três saídas, e nenhuma foi validada:**
>
> | Saída | Custo | Risco |
> |---|---|---|
> | o plugin guarda a última configuração no `oxide/data` e a usa no boot, antes de o agente responder | um arquivo | a configuração do boot pode estar desatualizada por um ciclo |
> | o plugin **segura** a população até o agente responder (cancelar `OnLootSpawn` e repopular no `NextTick`) | alto | cancelar é a armadilha do **[L§9.4]**; um erro deixa o mapa vazio |
> | aceitar o buraco e documentar que a regra vale "a partir do próximo refresh" | zero | é mentir por omissão numa ferramenta de admin |
>
> **A primeira é a única com custo aceitável**, e é a mesma solução que a fila de
> pontos já usa (`OrigemZItems.cs:17-27`). É a pergunta Q1, e ela é
> **bloqueante**.

### 9.2 Reload

| O que | Sobrevive? |
|---|---|
| o loot **já dentro** dos containers | **sim** — é `StorageContainer`, e o inventário é salvo |
| a aplicação de regras futuras | **para** até o agente reenviar |
| a configuração | está no banco do agente — **volta sozinha** |

O `Unload` do plugin já limpa os índices (`OrigemZItems.cs:451-473`) e o agente
reenvia. O padrão de reenvio existe e é fire-and-forget
(`void deps.sync?.pushAll(...)`, `core/src/http/routes/custom-items.ts:491`,
`:512`, `:535`).

### 9.3 Restart e wipe

**Restart:** medido no **[L§5.2]** — `PreServerLoad` põe `isRestoringFromSave =
true` e o `ServerInit` **pula** o `SpawnLoot()`. O container volta com o que
tinha; só o cronômetro de refresh é retomado. **Nenhuma regra roda no restart**,
e isso é bom: mudar a configuração não reescreve o mundo que já existe.

> **Mas isso tem um lado que a tela precisa dizer:** depois de salvar uma regra,
> **os containers que já existem no mapa não mudam**. A regra vale para o que
> nascer e para o que refazer o loot. Num servidor no meio do wipe, isso é
> 1–2 h para 71 containers e **até o próximo wipe** para os outros 34. Sem esse
> aviso na tela, o admin salva, entra no jogo, abre um barril e conclui que a
> ferramenta não funciona.

**Wipe:** é o único momento em que o mapa inteiro sorteia — **milhares de
chamadas do hook em poucos segundos** (**[L§5.3]**). Duas exigências: a rotina
tem de sair barato quando não há regra para o prefab, e a configuração tem de
estar carregada (§9.1).

### 9.4 Plugins de terceiro — medido, e o resultado é bom

Os **11 plugins carregados** no `server01`, por `oxide.plugins`:

```
AdminHammer 1.13.1 · Admin No Loot 0.1.3 · Admin Panel 1.4.8 (nivex)
Admin Radar 5.4.3 (nivex) · OrigemZAgent · OrigemZVip · OrigemZQueue
OrigemZPlayer · OrigemZChat · OrigemZUI · OrigemZItems
```

Varredura por `OnLootSpawn|LootSpawn|lootDefinition|PopulateLoot|LootContainer|CanLootEntity|OnLootEntity|LootSpawnSlot`
em `Servers/server01/oxide/plugins/`:

| Plugin | Resultado |
|---|---|
| **AdminRadar.cs** (259 KB) | **zero ocorrências** |
| **AdminPanel.cs** (30 KB) | **zero ocorrências** |
| AdminHammer.cs | zero ocorrências |
| **AdminNoLoot.cs** | duas: `CanLootEntity(BasePlayer, DroppedItemContainer)` (`:77`) e `CanLootEntity(BasePlayer, LootableCorpse)` (`:92`) |

> **Conclusão: não há conflito.** O `AdminNoLoot` intercepta **abrir** mochila
> caída e corpo — não toca `LootContainer`, não toca população, e não passa por
> `OnLootSpawn`. **Os dois plugins do `nivex` que o pedido mandou conferir não
> tocam loot em nenhuma linha.**

### 9.5 Update do Rust

É aqui que a decisão do §4 se paga, e vale ver os dois cenários lado a lado:

| O que acontece | Se tivéssemos **substituído** | Tendo **complementado** |
|---|---|---|
| a Facepunch acrescenta um item ao `crate_elite` | o nosso servidor **não o recebe**, e ninguém percebe | recebe, de graça |
| a Facepunch **remove** um item | continuamos distribuindo um item que saiu do jogo | some sozinho |
| um `ShortPrefabName` muda de nome | a cópia inteira daquele container vira lixo silencioso | **a regra deixa de casar** — e isso é detectável |
| a Halloween liga (38 tabelas medidas) | não liga | liga |

> **O terceiro caso é o único em que "complementar" também quebra**, e ele tem
> conserto barato: o agente compara os `ShortPrefabName` do dump novo com os das
> regras e **avisa na tela** quais regras deixaram de casar. É o mesmo padrão do
> `baseMissing` que o `custom-items-repository.ts` já usa quando o item base some
> numa versão do Rust (`LEFT JOIN items`).

### 9.6 O que continua não medido

| O que | Por que importa | Por que não foi medido |
|---|---|---|
| o `monuments.bundle` (3,0 GB) | pode ter prefabs de container próprios | UnityPy abriu e devolveu **zero objetos** |
| quantos `crate_elite` existem no mapa | decide a probabilidade | não são população; **não há comando de RCON que os conte** (**[L§9.5]**) |
| o **giro** (containers populados por hora) | é o denominador de qualquer probabilidade | nada nativo mede; é a Fatia 1 do **[L§10]** |
| quantas entradas mudam por update do Rust | quantificaria o custo de "substituir" | precisaria de dois builds; só há um aqui |
| se um plugin consegue invocar uma `collection` num container arbitrário | decide o §7.3, item 1 | exigiria escrever código, o que este estudo não faz |

---

## 10 — O caminho mínimo

### 10.1 A menor fatia que já entrega valor

> **Fatia 1 — acrescentar item nosso a containers escolhidos, com chance.**
>
> Uma tabela `loot_rules` só com `kind = 'add'`. Uma tela que lista os **105
> containers** e deixa acrescentar item com chance. Um comando de plugin que
> aplica no `OnLootSpawn` + `NextTick`, sem cancelar.

**Por que esta e não outra:** ela é o pedido do dono original (o troféu no loot)
**generalizado ao mínimo custo**, e ela não precisa de nada do §3 — **não precisa
extrair a tabela do jogo**. O admin escolhe o container numa lista fixa e o item
no picker que já existe. Sem dump, sem paginação, sem árvore, sem prévia.

**O que ela deixa de fora, e é preciso dizer:**

| Fica de fora | Consequência |
|---|---|
| **ver o que o jogo já põe** no container | o admin acrescenta às cegas — sabe o que entrou, não o que já estava |
| `remove` e `clear` | não dá para tirar nada, só pôr |
| a **prévia** | a chance é um número sem tradução ("1/5000" não vira "1 por semana") |
| override por servidor | a mesma chance em todos os servidores onde a regra vale |
| a extração das 650 tabelas | é o §3 inteiro, e é o que custa |
| a correção do buraco do boot (§9.1) | tolerável **só** porque `add` não estraga nada se chegar tarde — chega menos troféu no primeiro minuto, e mais nada |

> **A última linha é o que faz esta ser a fatia certa.** Uma regra `add` que
> chega tarde **erra para menos**, e errar para menos é o erro seguro. Uma regra
> `remove` ou `clear` que chega tarde erra para **mais** — o loot que devia ter
> sumido é distribuído. Por isso `remove` e `clear` **não podem** entrar antes de
> o §9.1 estar resolvido.

### 10.2 As fatias seguintes

| # | Fatia | Entrega | Depende de |
|---|---|---|---|
| **1** | `add` com chance, por container | o troféu no loot, ajustável pelo painel | nada |
| **2** | **o dump** (`origemz.loot.export`, paginado por container) | a tela passa a mostrar o que o jogo põe | **Q2** |
| **3** | a **prévia** das nossas regras | "1/5000" vira "1 por semana" | 1 |
| **4** | `remove` e `clear`, com aviso | tirar item, esvaziar container | **Q1** (o boot) |
| **5** | override por servidor | 5x e vanilla na mesma regra | **Q4** |
| **6** | simulação com a tabela do jogo | o que o Looty vende | 2, **Q5** |

> **A fatia 2 é a que muda a natureza do produto**, e é também a mais cara: são
> os 78,8 KB, a paginação com backoff, o resolvedor de ramo vivo e o achatamento
> das 1.004 folhas. **Nada da fatia 1 depende dela** — e isso é deliberado, para
> que a primeira entrega não fique atrás da mais difícil.

---

## 11 — Medido, conferido, projeto

> A separação é obrigatória nesta casa. **Nada abaixo da linha "PROJETO" foi
> validado.**

### 11.1 MEDIDO — nos bundles deste servidor

Método: **UnityPy 1.25.3**, instalado num venv dentro do scratchpad desta sessão
(fora do projeto, nada foi instalado no ambiente do usuário nem no servidor).
Lidos com typetree: `Servers/server01/Bundles/shared/content.bundle`,
`assetscenes.bundle`, `items.preload.bundle`. Os PPtr foram resolvidos
respeitando `m_FileID` contra a tabela de `externals` de cada arquivo
serializado.

| O que | Valor |
|---|---|
| `LootSpawn` únicas no build | **1.321** |
| entradas `items` / `subSpawn` / total | **1.232 / 1.779 / 3.011** |
| tabelas alcançáveis a partir dos containers | **650** |
| entradas alcançáveis | **1.396** (678 + 718) |
| itens distintos no loot alcançável | **429** |
| itens distintos citados em qualquer tabela | **784** de **1.259** |
| `subSpawn` que resolvem para tabela existente | **1.779 de 1.779** |
| profundidade máxima da árvore | **5** (`LootSpawn.RadTownElite`) |
| distribuição: 0 / 1 / 2-5 / 6-20 / 21+ entradas | **28 / 1.004 / 210 / 64 / 15** |
| maior tabela | `Workbench_Experiment_Tier_2`: 114 `subSpawn`, soma 11.400 |
| prefabs com `LootContainer` | **105** (101 nomes distintos) |
| tabelas de topo: por `lootDefinition` / incluindo slots | **43 / 93** |
| `LootSpawnSlot` no total | **263** |
| referências de topo com repetição | **356** |
| como populam: só `lootDefinition` / só slots / **ambos** / nenhum | **69 / 11 / 24 / 1** |
| `probability` dos slots: menor em uso / abaixo de 5 % | **`0.01f` / 17 slots** |
| slots desligados (`numberToSpawn == 0`) | 4 |
| somas de peso: mín / mediana / máx | **0 / 160 / 11.400** |
| pesos individuais: mín / mediana / máx | **0 / 100 / 400** |
| `Entry` com peso 0 (desligadas) | 4 |
| refresh: finito>0 / infinito / zero | **71 / 30 / 4** |
| `scrapAmount > 0` | **34 de 105** (máx. **25**, no `crate_elite`) |
| `ItemAmountRanged` com faixa (`maxAmount > amount`) | **89** |
| `Entry` com `restrictedEras` / slots com era | **15 de 1.779 / 23 de 263** |
| caminhos `.asset` únicos nos 5,0 GB de bundles | **10.252** |
| `.asset` em `assets/content/properties/lootspawn` | **1.265** |
| subpastas: `generated` / `collections` / `deathmatchloot` / raiz | **871 / 84 / 75 / 46** |
| `AssetSceneManifest.json`: assets listados, e só de dois tipos | **16.358** (16.283 `.prefab` + 75 `.fbx`) — **nenhuma `LootSpawn`** |
| JSON compacto: tudo / alcançável com shortname / sem shortname | **151,9 / 78,8 / 70,2 KB** |

Os quatro containers de interesse, medidos entrada por entrada, estão
transcritos no §2.4.

### 11.2 MEDIDO — no `server01` ao vivo, por RCON

Método: cliente WebSocket em Node (`ws` de `node_modules`), lendo host, porta e
senha de `Configs/server01.ini`.

| Comando | Resultado |
|---|---|
| `server.fps` | 75 FPS |
| `players` | 1 online (o dono) |
| `oxide.version` | Oxide.Rust 2.0.7683, branch master |
| `oxide.plugins` | **11 plugins** (lista no §9.4) |
| `find loot` | **24 convars** e **12 comandos** — inclusive `entity.spawnlootfrom`, `spawn.respawnloot_all/_lookingat/_radius`, `deepsea.printloot`, `spawn.loot_population_test` |
| `find lootspawn` | **vazio** — não existe comando com esse nome |
| `server.clear_loot_spawn_cache` | **`Cleared 329 loot spawn caches`** |

> #### &nbsp;&nbsp;DECLARAÇÃO: UM COMANDO QUE ESCREVE FOI EXECUTADO&nbsp;&nbsp; ####
>
> O pedido era **só leitura**. O `server.clear_loot_spawn_cache` foi executado
> junto de duas buscas `find`, por descuido meu — o nome estava na lista de
> convars e foi enfileirado sem que eu separasse os que escrevem.
>
> **O efeito, medido no IL e declarado aqui:** ele chama
> `LootSpawn.ClearCache()`, que zera `allowedItems` e `allowedSubSpawn` — os dois
> **caches** do filtro de era. `LootSpawn::EnsureFilterUpdated` os reconstrói a
> partir de `items` e `subSpawn` na próxima população de cada tabela.
>
> **Nenhum container foi repopulado. Nenhum item mudou. Nada foi salvo em
> disco.** O custo é uma reconstrução de filtro por tabela, na primeira vez que
> cada uma for usada de novo. É por isso que o próprio jogo expõe o comando a
> qualquer admin.
>
> Fica registrado porque **medição só vale se o método for confessável**, e
> porque o número que ele devolveu (329) é usado no §2.3.

### 11.3 MEDIDO — em arquivos do repositório

| O que | Onde |
|---|---|
| `MAX_PUSH_BYTES = 50_000`, e o comentário do teto medido de ~70 KB | `core/src/game/plugin-push.ts:70`, `:56-69` |
| `MaxBpExportBytes = 60000` | `Plugins/OrigemZAgent.cs:3652` |
| `MaxPendingBytes = 60000` | `Plugins/OrigemZItems.cs:341` |
| `origemz.bp.export <offset> <limit>`, default 25 / máx 100 | `core/src/wipe/blueprints.ts:242-244`, `:193-194` |
| o backoff pela metade sem avançar offset, e o avanço pelo `limit` da resposta | `core/src/wipe/blueprints.ts:393-435` |
| `PAYLOAD_TOO_LARGE` | `core/src/wipe/blueprints.ts:205` |
| `custom-items-sync`: sem paginação, `clear` + um `set` por item, e o porquê | `core/src/game/custom-items-sync.ts:16-27`, `:58`, `:91`, `:348-350` |
| `origemz.items`, páginas de 250 (máx. 500) | `core/src/game/item-catalog.ts:87`, `:90-91`, `:455` |
| migração **041**: `custom_items` + `custom_item_servers`, na mesma migração | `core/src/db/migrations.ts:3163-3272`, registro em `:4223` |
| o comentário *"cópia do `kit_servers` (012), inclusive o índice"* | `core/src/db/migrations.ts:3257-3258` |
| *"sem linha nenhuma = em nenhum servidor"* | `core/src/db/migrations.ts:3262-3263` |
| migração **012**: `kits` + `kit_servers` | `core/src/db/migrations.ts:998-1045`, registro em `:4154` |
| `player_servers` — junção **com payload**, o precedente do §6.2 | `core/src/db/migrations.ts:593-624` |
| 4.303 linhas, 44 migrações (1-8 e 10-45), última é a 045 | `core/src/db/migrations.ts:4140-4246`, `:4245` |
| o runner: uma transação por passo, cada id uma vez para sempre | `core/src/db/migrations.ts:4259-4303` |
| `#replaceServers`: delete-all-then-insert na transação | `core/src/db/custom-items-repository.ts:353-368` |
| `listForServer` é a única leitura que filtra `enabled = 1` | `core/src/db/custom-items-repository.ts:182-196` |
| o guard único de `/api`, e por que as rotas recebem `api` e não a raiz | `core/src/http/server.ts:378-388`, `:383-385` |
| o sync fire-and-forget nas mutações | `core/src/http/routes/custom-items.ts:491`, `:512`, `:535` |
| as duas abas da tela de itens, e por que ficam juntas | `panel/src/app/itens/page.tsx:66-77`, `:77-97` |
| o picker de item base: grade, busca, `PAGE_SIZE = 120` | `panel/src/components/item-picker-dialog.tsx` (204 linhas) |
| o `ConfirmButton` de apagar | `panel/src/components/custom-items-panel.tsx` (313 linhas) |
| `AdminRadar` e `AdminPanel`: zero ocorrências de qualquer símbolo de loot | `Servers/server01/oxide/plugins/AdminRadar.cs`, `AdminPanel.cs` |
| `AdminNoLoot`: `CanLootEntity` só para mochila caída e corpo | `Servers/server01/oxide/plugins/AdminNoLoot.cs:77`, `:92` |
| o `NextTick` como padrão do plugin | `Plugins/OrigemZItems.cs:1272`, `:1475` |
| a saída barata por índice vazio | `Plugins/OrigemZItems.cs:1406-1409` |
| o cadastro só é pedido no `OnServerInitialized` | `Plugins/OrigemZItems.cs:424-431`, `:476-479` |
| a fila de pontos grava em disco, e por quê | `Plugins/OrigemZItems.cs:17-27` |
| o `Match` sai em `skin == 0` | `Plugins/OrigemZItems.cs:1057-1060` |

### 11.4 CONFERIDO — lido de fonte externa, não medido aqui

| Afirmação | Fonte |
|---|---|
| **AlphaLoot**: *Loot Table* é o arquivo inteiro; *Loot Profile* é a config de um container; ficam em `oxide/data/AlphaLoot/LootProfiles/`, com `default_loottable.json` | `chaoscode.io/resources/alphaloot.13` |
| **AlphaLoot**: perfil "avançado" permite spawnar vários itens juntos (o exemplo é *"um rifle com munição"*) | idem |
| **Looty Editor**: editor visual web em beta; *"profiles group items with weights"*; vende **visualizar rolls** para *"balancear wipes mais rápido"* | `looty.cc/alphaloot` |
| **AlphaLoot Profile Editor**: lê os **bundles do cliente do Rust** para montar a lista de itens | `chaoscode.io/resources/alphaloot-profile-editor.183` |
| **Codefling / Payhip** vendem configurações prontas de 2x, 3x, 5x e 10x | Codefling, Payhip |

**E o que NÃO tem fonte:** nenhuma dessas páginas foi aberta por mim nesta
sessão — elas chegaram como insumo de pesquisa de mercado do coordenador. As
conclusões do §7 são leitura desse insumo, não verificação independente.

### 11.5 PROJETO — proposto aqui, e **não validado**

| Proposta | Onde | Risco se estiver errada |
|---|---|---|
| **complementar** em vez de substituir | §4 | baixo — é a opção reversível; se estiver errada, perde-se controle, não se quebra nada |
| a configuração ser **regras**, não cópia da tabela | §1.2, §5.2 | médio — se o admin quiser reescrever tabelas inteiras, o modelo não expressa, e a saída é a regra `clear` |
| o esqueleto SQL da migração 046 | §5.2 | baixo — é o molde da 041 com colunas a mais |
| a junção **com payload** (override por servidor) | §6.2 | médio — foge do padrão de kits/itens custom, ainda que siga `player_servers` |
| paginar o export **por container** | §3.3 | baixo — o molde do `bp.export` é medido e conhecido |
| o plugin guardar a configuração no `oxide/data` para o boot | §9.1 | **médio, e é o ponto que mais depende de decisão** — ver Q1 |
| a tela resolver o **ramo vivo** antes de desenhar | §8.3 | **baixo em implementação, alto em consequência** — sem isso a tela mente |
| achatar as 1.004 folhas de um item | §8.3 | baixo |
| a prévia "abrindo 100 caixas" | §8.4 | baixo para as nossas regras; **não resolvido** para a parte do jogo |
| usar as 84 `collections/` para "vários itens juntos" | §7.3 | **não verificado** — Q5 |
| adotar o vocabulário do AlphaLoot | §7.2 | baixo |
| detectar `ShortPrefabName` que sumiu num update e avisar na tela | §9.5 | baixo — é o padrão `baseMissing` que já existe |
| a fatia mínima ser `add` com chance | §10.1 | baixo |
| `remove` e `clear` só depois de o §9.1 estar resolvido | §10.1 | **é a regra que impede o defeito silencioso** |

---

## 12 — Perguntas em aberto para o dono

### Q1 — A configuração no primeiro minuto do wipe ✅ **RESPONDIDA em 06/09/2026**

> **A decisão do dono: o plugin guarda a configuração em disco e a aplica desde
> a primeira caixa do boot.**
>
> ####  É A SEGUNDA EXCEÇÃO À REGRA DO PLUGIN DESCARTÁVEL, E A RAZÃO É A MESMA  ####
>
> O cabeçalho do `OrigemZItems.cs` diz que o estado dele é cópia de trabalho
> descartável, porque o agente sempre o remanda. A fila de conversões já abriu
> uma exceção a isso, e pelo motivo certo: **o que ela guarda não pode ser
> reconstruído** — o item que a originou já foi destruído.
>
> Aqui vale o mesmo: o loot do boot **acontece uma vez**. Uma regra que chega
> depois não volta atrás — as caixas já nasceram. E, ao contrário do `add`, que
> erra para menos, o `remove` que chega tarde **distribui o loot que devia ter
> sumido, sem sintoma nenhum**.
>
> Escreva a exceção no cabeçalho do plugin, ao lado da regra que ela excetua e
> da outra exceção. Duas exceções sem explicação viram "a regra não vale".
>
> **Consequência:** `remove` e `clear` deixam de estar bloqueados, e podem entrar
> quando o dono pedir. A fatia 1 continua sendo só `add` (Q2).

O texto abaixo é o que sustentou a decisão.

### Q1 — A configuração precisa valer no primeiro minuto do wipe? **(BLOQUEANTE para `remove` e `clear`)**

O mapa nasce **antes** de o plugin receber a configuração (§9.1, medido). Para
`add` isso só significa "chega menos coisa no começo". Para `remove` e `clear`
significa **o loot que devia ter sumido é distribuído**, e o sintoma é
indetectável.

A saída barata é o plugin guardar a última configuração em `oxide/data` e usá-la
no boot — a mesma solução que a fila de pontos já usa. **Custo:** um arquivo, e
a possibilidade de o boot rodar com a configuração de um ciclo atrás.

**Vale a pena, ou `remove`/`clear` ficam de fora até que exista uma solução
melhor?**

### Q2 — Quando extrair a tabela do jogo ✅ **RESPONDIDA em 06/09/2026: depois**

> **A decisão do dono:** a primeira entrega é só **acrescentar item, com chance,
> por contêiner**. Ver o que o jogo já põe em cada caixa fica para depois.
>
> O que isso compra: o troféu entra no loot **sem** o dump paginado, sem o
> resolvedor da árvore de cinco níveis e sem o backoff — que é justamente a parte
> cara e a que **não é necessária** para pôr um item no mundo.
>
> O que isso custa, dito antes que alguém descubra na tela: o admin acrescenta
> **às cegas**. Ele escolhe a caixa de elite e uma chance, mas não vê o que já
> está lá dentro nem o quanto aquilo pesa. Para `add` isso é tolerado, porque a
> chance da nossa regra **não depende** da tabela do jogo — ela é sorteada por
> fora. No dia em que `remove` existir, deixa de ser tolerado.

O texto abaixo é o que sustentou a decisão.

### Q2 — Extrair a tabela do jogo entra em qual momento?

A extração (§3) é o que faz a tela mostrar *"o que o jogo já põe aqui"*. Ela é a
fatia 2, custa a paginação com backoff, o resolvedor de ramo vivo e o achatamento
das folhas — e **nada da fatia 1 depende dela**.

**A fatia 1 sozinha já serve, ou a tela sem "o que o jogo põe" é inútil na
prática?** É a pergunta que decide se a primeira entrega é de uma semana ou de
um mês.

### Q3 — A regra de **esvaziar** container existe?

Ela é a substituição feita explicitamente, num container só (§8.5). É poderosa e
é a única forma de dizer *"neste crate eu quero só o meu loot"*. E é a única
regra do desenho que pode deixar um container **vazio** se o admin errar.

**Ela entra, com aviso e confirmação separada? Ou fica fora até a ferramenta ter
rodagem?**

### Q4 — Override por servidor: agora ou depois?

O padrão da casa (kits 012, itens custom 041) é junção pura, sem override. Loot
quer override — é o caso "a mesma regra, quantidade diferente no 5x" (§6.2). O
precedente existe (`player_servers`), mas é uma diferença deliberada de padrão.

**Vale acrescentar as colunas de override já na migração 046** (elas custam
`NULL` quando não usadas), **ou a primeira versão é junção pura como as
outras?**

Acrescentar depois é uma migração a mais; acrescentar agora é três colunas que
podem nunca ser usadas.

### Q5 — "Vários itens juntos" é requisito?

O AlphaLoot vende isso como recurso avançado — *"um rifle com munição"*. O Rust
tem **84 tabelas de `collections/`** prontas, e uma delas se chama `ak47 with
ammo` (§2.1). Uma regra que aponte para uma *collection* entregaria o recurso
sem inventar estrutura, **mas não foi verificado** se um plugin consegue invocar
uma collection num container arbitrário (§7.3).

**É um requisito, ou o admin pode viver criando uma regra por item?**

### Q6 — A simulação simula o quê?

A prévia das **nossas regras** é aritmética e sai barato (§8.4). Simular a
tabela **do jogo** — que é o que o Looty vende — exige ou reimplementar o
sorteio no painel, ou um comando de plugin que rode N sorteios em memória.

**A prévia "1/5000 vira 1 por semana" já resolve o que o dono quis dizer com
"fácil de configurar", ou ele quer ver a caixa aberta 100 vezes?**

### Q7 — Quais containers aparecem na primeira versão?

São **105** (§2.3), e vários são exóticos: `missionstash`, `tacklebox`,
`stocking_large_deployed`, `xmastunnellootbox`, os 9 `roadsign`.

Mostrar todos é uma lista longa; mostrar 20 é esconder coisa que alguém vai
querer.

**A recomendação é mostrar todos, agrupados como no §8.2, com os grupos raros
colapsados por padrão.** Confere?

---

## Referências

- [`04-ITEM-NO-LOOT-DO-JOGO.md`](04-ITEM-NO-LOOT-DO-JOGO.md) — o mecanismo do
  loot, o `OnLootSpawn`, e a medição de que a tabela nativa não carrega skin.
  **É o documento que este contesta em dois pontos (§1.3) e confirma no
  principal**
- [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md) — a marca
  `(base_shortname, skin_id)` e as três identidades
- [`03-ACAO-PONTOS-DE-RANKING.md`](03-ACAO-PONTOS-DE-RANKING.md) — a ação
  `points`, o `#OZSTAT#` e o contrato da `source`
- [`../TrofeuBleik/TROFEU_BLEIK_STORE.md`](../TrofeuBleik/TROFEU_BLEIK_STORE.md)
  — o briefing do troféu
- `core/src/db/migrations.ts` — as migrações 012 e 041, e o molde da 046
- `core/src/wipe/blueprints.ts` — o molde de paginação com backoff
- `core/src/game/custom-items-sync.ts` — o molde de push por comando
- `Plugins/OrigemZItems.cs` — onde a aplicação das regras vai morar
