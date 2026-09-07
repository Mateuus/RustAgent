# 04 — O ITEM CUSTOM NO LOOT DO JOGO

> **O que este documento é.** O estudo de **como um item custom entra na tabela
> de loot do Rust** e de **como fazê-lo ser raro de verdade** — medido no
> binário do jogo deste servidor e conferido, ao vivo, contra o `server01` no
> ar. O caso concreto é o **Troféu Bleik Store**, o item
> `(discord.trophy, skin 1552602728526292)` que já está cadastrado e que, ao ser
> pego, some e vira ponto no ranking.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. **Nenhuma
> linha de injeção em loot existe na árvore hoje.** Nada foi copiado para
> `oxide/plugins`, nada foi alterado no código, e nenhum comando que muda o
> mundo foi executado — o dono estava jogando durante a medição.
>
> **De onde ele parte, e por que ele contradiz o ponto de partida.** O
> [`../TrofeuBleik/TROFEU_BLEIK_STORE.md`](../TrofeuBleik/TROFEU_BLEIK_STORE.md)
> **§6.5** abriu o assunto em meia página, sem medir nada. Ele acertou a
> intenção e errou o mecanismo em três pontos, e cada um deles está apontado com
> a medição ao lado (§1.3). Referências àquele documento aparecem como
> **[T§6.5]**.
>
> **A quem ele se liga.** A marca `(base_shortname, skin_id)` e as três
> identidades estão em [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md)
> (**[P§3]**). A ação `points` e o evento `#OZSTAT#` estão em
> [`03-ACAO-PONTOS-DE-RANKING.md`](03-ACAO-PONTOS-DE-RANKING.md) (**[A§8]**). O
> estado atual do plugin é `Plugins/OrigemZItems.cs`.

**Escrito em 06/09/2026**, contra o `Assembly-CSharp.dll` de
`Servers/server01/RustDedicated_Data/Managed` e contra o `server01` **no ar**
(mapa procedural, seed `1509704652`, worldsize `4000`, 91 FPS na hora da
medição).

---

## Índice

- [§0 — O pedido do dono](#0--o-pedido-do-dono)
- [§1 — Sumário executivo](#1--sumário-executivo)
- [§2 — Como a tabela de loot funciona de verdade](#2--como-a-tabela-de-loot-funciona-de-verdade)
- [§3 — Os pontos de entrada, e o que cada um custa](#3--os-pontos-de-entrada-e-o-que-cada-um-custa)
- [§4 — A pergunta que decide tudo: o item sai com a skin?](#4--a-pergunta-que-decide-tudo-o-item-sai-com-a-skin)
- [§5 — Persistência](#5--persistência)
- [§6 — Raridade que se sustenta](#6--raridade-que-se-sustenta)
- [§7 — Integridade e auditoria](#7--integridade-e-auditoria)
- [§8 — O anúncio](#8--o-anúncio)
- [§9 — O que NÃO dá](#9--o-que-não-dá)
- [§10 — O plano em fatias](#10--o-plano-em-fatias)
- [§11 — Medido, conferido, projeto](#11--medido-conferido-projeto)
- [§12 — Perguntas em aberto para o dono](#12--perguntas-em-aberto-para-o-dono)

---

## 0 — O pedido do dono

> Preservado sem edição. É a fonte; tudo que vem depois é leitura dela.

*"Faça um estudo: como o item pode entrar no drop e ser raro de drop."*

O caso concreto é o Troféu Bleik Store. Ele deve passar a aparecer no loot do
jogo, **raramente**.

---

## 1 — Sumário executivo

### 1.1 A leitura em uma frase

> **A tabela de loot do Rust não sabe carimbar skin — e sem skin o troféu não é
> o nosso troféu.**
> Foi **medido** que todo item nascido de uma `LootSpawn` sai com `skin = 0`, e
> que a estrutura que descreve o item na tabela (`ItemAmount`) **não tem campo
> de skin para preencher**. Portanto o caminho "editar a tabela de loot" não
> produz um item custom: produz um Discord Trophy comum, que o plugin não
> reconhece, que não vira ponto e que o jogador lê como lixo. **O item custom
> tem de ser criado por nós, em código, no gancho certo** — e o gancho existe,
> chama-se `OnLootSpawn`, e está neste build.

### 1.2 As sete decisões que o pedido força

**1. O item entra pelo `OnLootSpawn`, não pela tabela.** O hook **existe** neste
build — medido em duas chamadas dentro do `Assembly-CSharp.dll` (§3.2). Ele é o
único ponto que cobre o nascimento **e** o refresh do container, e o único em
que nós criamos o `Item` com as nossas mãos — e portanto com a nossa skin.

**2. Editar o `ScriptableObject` da tabela está descartado, e não por
elegância.** Está descartado porque **não funciona**: `LootSpawn.SpawnIntoContainer`
chama `ItemManager.Create(def, amount, 0uL, true, 0uL)` — a skin é literal zero
no IL (§4.1). Uma `ItemAmountRanged` colocada na tabela produziria
`discord.trophy` sem marca (§4.2).

**3. `CanPopulateLoot` e `OnContainerPopulate` NÃO EXISTEM.** Foram varridos os
**788 pontos de chamada de hook** do `Assembly-CSharp.dll`, que dão **685 nomes
distintos**. Nenhum é `CanPopulateLoot`; nenhum é `OnContainerPopulate` (§3.3).
Quem escrever plugin contra esses nomes escreve código que nunca roda.

**4. A raridade não cabe na tabela nativa, e isso é um limite do tipo do
campo.** `LootSpawn.Entry.weight` é **`Int32`**, e o sorteio é
`Random.Range(0, total)` — a menor probabilidade que uma entrada nova pode ter é
`1/(total+1)`. Para a ordem de raridade que o **[T§6.5]** pede (1 a 3 por
servidor por **semana**), seria preciso um total da ordem de **dez mil** — ou
seja, inflar todos os pesos de uma tabela que é do jogo. Em código, o mesmo
número é um `if` (§6.2).

**5. O `[T§6.5]` errou em três pontos, e o terceiro é o que doía.** Ele diz
*"tecnicamente é o mais fácil"*, cita `OnLootSpawn` **ou** edição de
`LootContainer` como equivalentes, e não menciona a skin. Os três estão medidos
e corrigidos no §1.3.

**6. O buraco do boot já mordeu este projeto, e aqui ele volta pior.** Medido:
`OnEntitySpawned` é chamado **depois** de `ServerInit()`, e `ServerInit()` é
quem popula o loot (§5.4). O `OnLootSpawn` dispara **antes** — mas dispara para
o mapa inteiro de barris **antes de o cadastro chegar ao plugin**, que só é
pedido no `OnServerInitialized` (`Plugins/OrigemZItems.cs:424-431`). Injetar
nesse instante é injetar com o índice vazio. A saída é barata e está no §5.4.

**7. A procedência não pode ser deduzida na conversão — ela precisa viajar no
item.** Quando o jogador pega o troféu, o plugin só vê a marca; ele não sabe se
aquilo veio da loja, do admin ou do barril. **Mas o Rust tem um campo de
procedência dentro do próprio item** — `Item.ownershipShares`, com `username` e
`reason`, que **é salvo em disco e viaja na rede** (medido em `Item::Save`). E
este plugin **já escreve nele** (`OrigemZItems.cs:1166-1199`). É ali que a
etiqueta do loot deve morar (§7).

### 1.3 Onde o `[T§6.5]` errou — a tabela da contestação

| O `[T§6.5]` diz | O que foi medido | Onde |
|---|---|---|
| *"Tecnicamente é o mais fácil"* | é o **mais caro** dos caminhos de emissão do troféu: exige criar item em código, distinguir container, sobreviver ao boot e respeitar um teto — quatro problemas que o `origemz.give` não tem | §3.6, §5.4 |
| *"`OnLootSpawn` / edição de `LootContainer`"*, como se fossem alternativas equivalentes | **não são.** O hook funciona; a edição de tabela **não produz o item com skin**, e portanto não produz o nosso item | §4 |
| *"com peso mínimo"* | **peso mínimo não é raro.** `weight` é `Int32`; o mínimo alcançável é `1/(total+1)`, e o total de uma tabela do jogo é da ordem de dezenas | §6.2 |
| *"teto global por dia"* | **certo, e insuficiente sozinho** — mas pelo motivo oposto ao que ele dá: com teto e sem cooldown, o troféu vira prêmio de quem acorda cedo | §6.4 |
| *"só em zona de risco"* | **certo, e agora é executável**: o filtro é o `ShortPrefabName` do container, e os prefabs de mundo aberto estão medidos por nome e por contagem | §6.4, §2.4 |
| *"anúncio no chat"* | **certo, e é barato** — o transporte já existe e é único (`core/src/game/broadcast.ts:157`) | §8 |
| *"1 a 3 por servidor por semana"* | **a ordem de grandeza se sustenta**, e agora tem conta: com 2 000 aberturas/dia é `p ≈ 1/7 000` | §6.3 |

### 1.4 A tabela-resumo

| Pergunta | Resposta curta | Onde |
|---|---|---|
| Como a tabela de loot funciona? | `LootSpawn` (ScriptableObject) → sorteio por peso → `ItemManager.Create` | §2 |
| Quais hooks existem? | `OnLootSpawn` (2 chamadas), `OnEntitySpawned`, `OnLootEntity`, `OnItemAddedToContainer`, `OnContainerDropItems` | §3.1 |
| `CanPopulateLoot` existe? | **não.** Nem `OnContainerPopulate` | §3.3 |
| O item sai com a skin? | **da tabela, não.** `skin = 0` é literal no IL | §4.1 |
| O `ApplyIdentity` alcança o item do loot? | **não**, porque o `Match` sai em `skin == 0` | §4.3 |
| Onde carimbar a skin? | **na criação**, dentro do nosso código, no `OnLootSpawn` | §4.4 |
| Sobrevive a `oxide.reload`? | o **item** sim (a skin fica gravada no `Item`); a **injeção futura** para até recarregar | §5.1 |
| Sobrevive a restart? | sim — e o loot **não é repopulado** no restart, o que é bom | §5.2 |
| Quantos barris tem o mapa? | **400** na população `loot`, medido ao vivo. Mais 800 junkpiles | §2.4 |
| Que probabilidade dá 2 por semana? | `≈ 1/7 000` por container aberto, com 2 000 aberturas/dia | §6.3 |
| Dá para auditar de onde veio o ponto? | sim, se a procedência viajar no `ownershipShares` | §7 |
| O que falta de diagnóstico? | um comando que imprima a tabela de loot de um prefab **por RCON** — não existe | §9.5 |

---

## 2 — Como a tabela de loot funciona de verdade

> **Método.** Tudo nesta seção foi lido do IL de
> `Servers/server01/RustDedicated_Data/Managed/Assembly-CSharp.dll` com o
> desmontador que outra frente deixou pronto no scratchpad
> (`iltype`, modos `--types`, `--xref` e dump por tipo). Onde o texto disser
> "medido", o método está nomeado. Nenhuma dessas estruturas está em fonte
> pública verificável — a wiki da Facepunch não documenta `LootSpawn`.

### 2.1 As quatro peças, e só quatro

O sistema inteiro de loot do Rust cabe em quatro tipos. Medidos, com os campos
exatos:

```
LootSpawn : UnityEngine.ScriptableObject
  items                      ItemAmountRanged[]     o que pode sair daqui
  subSpawn                   Entry[]                as sub-tabelas, com peso
  allowedItems               ItemAmountRanged[]     cache filtrado por era
  allowedSubSpawn            Entry[]                cache filtrado por era
  era                        Era                    a era do ultimo filtro
  lastGameModeFilterApplied  Int32

LootSpawn.Entry : System.ValueType          (struct)
  category        LootSpawn      a sub-tabela para onde o sorteio desce
  weight          Int32          <- O PESO. Int32, e isso decide o §6.2
  extraSpawns     Int32          quantas vezes A MAIS ela roda quando sai
  restrictedEras  Era[]

ItemAmount : System.Object
  itemDef      ItemDefinition
  amount       Single
  startAmount  Single
  ignoreInTutorial  Boolean
  isBP         Boolean
  --- NAO EXISTE campo de skin. Ver §4.2.

ItemAmountRanged : ItemAmount
  maxAmount    Single
  GetAmount() => maxAmount > 0 && maxAmount > amount
                   ? Random.Range(amount, maxAmount)
                   : amount

LootSpawnSlot : System.ValueType            (struct)
  definition            LootSpawn
  numberToSpawn         Int32
  probability           Single    <- FLOAT. Ver §6.2 e §9.3
  onlyWithLoadoutNamed  String
  eras                  Era[]
```

E o dono das quatro:

```
LootContainer : StorageContainer
  lootDefinition            LootSpawn        a tabela deste container
  LootSpawnSlots            LootSpawnSlot[]  a alternativa a ela
  maxDefinitionsToSpawn     Int32
  initialLootSpawn          Boolean   (default TRUE,  medido no .ctor)
  destroyOnEmpty            Boolean   (default TRUE,  medido no .ctor)
  minSecondsBetweenRefresh  Single    (default 0f,    medido no .ctor)
  maxSecondsBetweenRefresh  Single    (default 0f,    medido no .ctor)
  scrapAmount               Int32
  HasBeenLooted             Boolean
  FirstLooterId             UInt64
  isRestoringFromSave       Boolean   <- decide o §5.2
```

### 2.2 O sorteio, linha a linha

Medido em `LootSpawn::SubCategoryIntoContainer` e `LootSpawn::SpawnIntoContainer`.
Em pseudocódigo fiel ao IL:

```csharp
// LootSpawn.SubCategoryIntoContainer — a escolha da SUB-TABELA
int total = allowedSubSpawn.Sum(e => e.weight + e.RuntimeWeightBonus());
int roll  = Random.Range(0, total);          // exclusivo no topo
int acc   = 0;
for (int i = 0; i < allowedSubSpawn.Length; i++)
{
    if (allowedSubSpawn[i].category == null) continue;
    acc += allowedSubSpawn[i].weight + allowedSubSpawn[i].RuntimeWeightBonus();
    if (roll < acc)
    {
        // roda 1 + extraSpawns vezes na sub-tabela escolhida
        for (int k = 0; k <= allowedSubSpawn[i].extraSpawns; k++)
            allowedSubSpawn[i].category.SpawnIntoContainer(container, share, overflow);
        return;
    }
}
Debug.LogWarning("SubCategoryIntoContainer ... randomWeight < totalWeight. "
               + "This should never happen!");
```

> **A regra que sai daí, e é a única que importa para a raridade:**
> **P(uma entrada) = peso_dela / soma_dos_pesos.** Nada mais. Não há "chance
> percentual" em lugar nenhum da estrutura — só inteiros somados.

E a folha, quando a tabela tem `items` em vez de `subSpawn`:

```csharp
// LootSpawn.SpawnIntoContainer — a criacao do ITEM
foreach (ItemAmount ia in allowedItems)
{
    int amount = (int)ia.GetAmount();     // ItemAmountRanged sorteia aqui
    ItemDefinition def = ia.itemDef;
    int guard = 0;
    do {
        guard++;
        Item item = ItemManager.Create(
            def,
            Mathf.Max(1, Mathf.Min(amount, stackable)),
            0uL,          // <====== A SKIN. ZERO. Ver §4.1.
            true,         // isServer
            0uL);         // attachment
        amount -= item.amount;
        item.OnVirginSpawn(null);
        if (ItemOwnershipShare.IsValid(share))
            item.SetItemOwnership(share.username, share.reason);   // ver §7.2
        if (!item.MoveToContainer(container, -1, true, false, null, true))
            if (overflow == null || !item.MoveToContainer(overflow, ...))
                { drop ou item.Remove(); }
    } while (amount > 0 && guard < 32);   // 0x20 no IL
}
```

**Três coisas a guardar desse trecho.**

1. **`ItemManager.Create` recebe a skin como terceiro parâmetro, e o loot passa
   `0uL`.** Medido: `ItemManager::Create(ItemDefinition, Int32 amount,
   UInt64 skin, Boolean isServer, UInt64 attachment)`, com
   `skin → Item::skin` (`stfld Item::skin` logo após `ldarg.2`).
2. **`MoveToContainer` termina em `ItemContainer::Insert`, e é ali que o
   `OnItemAddedToContainer` dispara** — logo, o hook que o plugin já usa
   **também vê os itens do loot**. Ele só não os reconhece, pelo motivo do §4.3.
3. **O guard de 32 iterações** existe porque um item com `stackable = 1` e
   `amount = 1000` daria mil voltas. Para o troféu (`stackable: 1`, medido em
   `Bundles/items/discord.trophy.json`) isso significa: **um por vez**.

### 2.3 De onde o container chama tudo isso

```
LootContainer.ServerInit()
  if (initialLootSpawn && !isRestoringFromSave)  ->  SpawnLoot()

LootContainer.SpawnLoot()
  1. if (IsDestroyed) return;
  2. if (inventory == null) { Debug.Log("CONTACT DEVELOPERS!..."); return; }
  3. inventory.Clear();  ItemManager.DoRemoves(0);
  4. if (Interface.CallHook("OnLootSpawn", this) != null) return;   <==== O HOOK
  5. PopulateLoot();
  6. CancelLootRefreshCountdown();
     if (shouldRefreshContents) StartLootRefreshCountdown();

LootContainer.PopulateLoot()          (virtual, NAO chama hook nenhum)
  FillLoot(inventory, lootDefinition, maxDefinitionsToSpawn, LootSpawnSlots);
  se SpawnType for 3 ou 2: sorteia condicao de cada item
                           (foundCondition.fractionMin..fractionMax)
  GenerateScrap();
  HasBeenLooted = false;  FirstLooterId = 0;

LootContainer.FillLoot(inv, definition, numToSpawn, slots)   (static)
  se slots existe E tem elementos:
      para cada slot:
          se a era do servidor nao esta em slot.eras -> pula
          repete numberToSpawn vezes:
              se Random.Range(0f, 1f) <= slot.probability
                  slot.definition.SpawnIntoContainer(inv, share, null)
      RETORNA AQUI                        <==== ver a armadilha do §9.3
  senao, se definition != null:
      repete numToSpawn vezes:
          definition.SpawnIntoContainer(inv, share, null)
```

> #### &nbsp;&nbsp;A ARMADILHA QUE O `FillLoot` ESCONDE&nbsp;&nbsp; ####
>
> **O ramo dos slots termina com `ret`.** Um container que hoje popula pelo
> `lootDefinition` e que ganhasse **um** `LootSpawnSlot` novo passaria a popular
> **só por ele** — o `lootDefinition` inteiro deixaria de rodar. O barril
> deixaria de ter loot, e o defeito apareceria como *"depois do plugin novo os
> barris estão vazios"*, sem nada no log. É por isso que a via
> "acrescentar um slot" **não é** a via barata que ela parece (§9.3).

### 2.4 Os números do `server01`, medidos ao vivo

Medido por RCON no `server01` no ar, em 06/09/2026 (comandos read-only:
`spawn.report`, `spawn.report true loot`, `spawn.scalars`, `players`,
`server.fps`):

| População | Contagem | Prefabs |
|---|---:|---|
| `loot` (`autospawn/resource/loot`) | **400 / 400** | `loot-barrel-1` **133**, `loot-barrel-2` **134**, `trash-pile-1` **133** |
| `junkpiles` | **800 / 800** | — |
| `junkpiles_water` | 127 / 128 | — |
| `ores` | 1 566 | — |
| `divesites` | 128 | — |

E os escalares que governam esses alvos, na hora da medição (1 jogador online):

```
spawn.scalars
  Player Fraction     0
  Player Excess       0
  Population Rate     0.5
  Population Density  0.5
  Group Rate          1

spawn.min_density = 0.5   spawn.max_density = 1   spawn.player_base = 100
spawn.tick_populations = 60      spawn.population_cap_rate = 300
```

> **A leitura:** os 400 containers de mundo aberto são o alvo na **densidade
> mínima** (0,5). Com o servidor em `player_base = 100` a densidade vai a 1,0, e
> o alvo dobra para a ordem de **800**. **Isto é leitura da fórmula declarada
> nos convars, não medição direta** — não dá para medir com 1 jogador online.

**O que estes números NÃO cobrem, e é preciso dizer:** os containers de
**monumento** (as `crate_normal`, `crate_elite`, os barris dentro de
monumentos) **não são população** — são prefabs fixos do mapa e não aparecem no
`spawn.report`. **Não existe comando de RCON que os conte** (§9.5). Toda conta
do §6 que envolva "aberturas por dia" está marcada como estimativa por causa
disso.

---

## 3 — Os pontos de entrada, e o que cada um custa

### 3.1 Primeiro, a lista de hooks que este build realmente tem

> #### &nbsp;&nbsp;POR QUE ESTA MEDIÇÃO PRECISA VIR ANTES DE TUDO&nbsp;&nbsp; ####
>
> Porque os hooks do Oxide **não moram no Oxide**. Foi verificado: a string
> `OnLootSpawn` **não aparece em nenhum dos oito assemblies `Oxide.*.dll`** deste
> servidor. Ela aparece dentro do `Assembly-CSharp.dll`, como argumento de
> `Oxide.Core.Interface::CallHook` — porque o patcher do Oxide **injeta as
> chamadas no binário do jogo**.
>
> **Consequência:** a lista de hooks disponíveis é exatamente a lista de strings
> passadas a `CallHook` neste `Assembly-CSharp.dll`. Ela é **medível**, e foi
> medida: **788 pontos de chamada**, **685 nomes distintos** (90 deles com
> prefixo `Can`). Um hook que não está nessa lista **não existe neste build**, e
> um plugin que o declare compila, carrega e nunca roda — em silêncio.

Os que tocam loot, com o método que os chama:

| Hook | Onde é chamado | Cancelável? |
|---|---|---|
| `OnLootSpawn` | `LootContainer::SpawnLoot` **e** `LootFill::DelayFill` | **sim** — retorno não-nulo aborta a população |
| `OnEntitySpawned` | `BaseNetworkable::Spawn` | **não** — o retorno é descartado (`pop`) |
| `OnLootEntity` | `PlayerLoot::StartLootingEntity` | — |
| `CanLootEntity` | 8 lugares, incl. `StorageContainer::PlayerOpenLoot` | sim |
| `OnItemAddedToContainer` | `ItemContainer::Insert` | **não** — retorno descartado (`pop`) |
| `OnContainerDropItems` | `DropUtil::DropItems` | **sim** |
| `OnCorpsePopulate` | `NPCPlayer::CreateCorpse`, `Rust.Ai.Gen2.State_Dead::StartRagdoll` | sim |
| `OnCrateSpawned` | `BradleyAPC::OnDied`, `PatrolHelicopter::OnDied` | — |
| `OnCargoShipSpawnCrate` | `CargoShip::RespawnLoot` | — |
| `OnXmasLootDistribute` | `XMasRefill::ServerInit` | — |
| `OnFreeableContainerRelease` / `Released` | `FreeableLootContainer::Release` | — |

### 3.2 `OnLootSpawn` — existe, e tem DUAS assinaturas

Medido, literal, dentro de `LootContainer::SpawnLoot`:

```
ldstr  "OnLootSpawn"
ldarg.0                                   ; this  ->  LootContainer
call   Oxide.Core.Interface::CallHook
ldnull
beq.s  <continua>                          ; se != null, RETORNA
ret
```

E, com o mesmo nome, dentro de `LootFill::DelayFill`:

```
ldstr  "OnLootSpawn"
ldarg.0                                   ; this  ->  LootFill  (nao e LootContainer!)
call   Oxide.Core.Interface::CallHook
```

> #### &nbsp;&nbsp;A ASSINATURA REAL, E A PEGADINHA DELA&nbsp;&nbsp; ####
>
> ```csharp
> object OnLootSpawn(LootContainer container)   // de LootContainer.SpawnLoot
> object OnLootSpawn(LootFill fill)             // de LootFill.DelayFill
> ```
>
> **É o mesmo nome com dois tipos de argumento.** O `LootFill` é um
> `BaseMonoBehaviour` que carrega um `StorageContainer` e uma `LootDefinition`
> própria — ele é o caminho de containers que **não** herdam de `LootContainer`.
>
> O plugin deve declarar **as duas** (via sobrecarga com `[HookMethod]`), ou
> declarar só a de `LootContainer` **sabendo** que os containers preenchidos por
> `LootFill` ficam de fora. Para o troféu isso não é perda: os alvos de zona de
> risco são `LootContainer`. **Não medido:** como exatamente o Oxide despacha
> quando o tipo não bate — é comportamento do `Oxide.Core`, não do jogo.

**Três propriedades do hook que decidem o desenho:**

**(a) Ele dispara ANTES do `PopulateLoot()`, com o inventário JÁ LIMPO.** A
ordem no `SpawnLoot` é `Clear()` → `DoRemoves()` → hook → `PopulateLoot()`.
Portanto **não dá para "olhar o que caiu e acrescentar"** dentro do hook: nesse
instante o container está vazio.

**(b) Cancelar significa container vazio, não "container sem a nossa
interferência".** Se o plugin devolver não-nulo, o `SpawnLoot` retorna
imediatamente e **`PopulateLoot()` nunca roda**. O barril fica sem loot nenhum.
**Cancelar o `OnLootSpawn` para injetar o troféu seria trocar o loot do barril
pelo troféu** — e é quase certo que quem o fizer não perceba, porque o troféu
aparece e o resto some sem erro.

**(c) A saída correta é não cancelar e agendar.** O padrão que o resto deste
plugin já usa (`NextTick`, em `OrigemZItems.cs:1272` e `:1475`):

```csharp
// A acao roda DEPOIS do PopulateLoot: o hook devolve null (nao cancela),
// e o NextTick cai no fim do frame, com o container ja preenchido.
private object OnLootSpawn(LootContainer container)
{
    if (_byMark.Count == 0) return null;      // saida mais barata, ver §5.4
    if (!ShouldTryInject(container)) return null;
    LootContainer captured = container;
    NextTick(delegate { TryInjectRare(captured); });
    return null;                              // NUNCA nao-nulo aqui
}
```

### 3.3 `CanPopulateLoot` e `OnContainerPopulate` — não existem

Varridos os 685 nomes: **zero ocorrências** de `CanPopulateLoot`,
`OnContainerPopulate` e `OnPopulateLoot`. Os únicos nomes com "Populate" no
build são `OnCorpsePopulate` (duas chamadas, ambas para corpo de NPC).

E `LootContainer::PopulateLoot` — que é `virtual` — **não chama hook nenhum**:
foi lido inteiro, e o único `CallHook` do caminho está no `SpawnLoot`, um nível
acima.

> **Isto vale ser dito com todas as letras:** plugins publicados na comunidade
> usam `CanPopulateLoot`. Neste build ele **não existe**. Um plugin que dependa
> dele carrega sem erro e nunca é chamado — o pior tipo de falha, porque parece
> "não deu certo" em vez de "não está lá".

### 3.4 `OnEntitySpawned` — chega tarde demais para o loot

Medido em `BaseNetworkable::Spawn`, na ordem exata:

```
SpawnShared()
net = Net.sv.CreateNetworkable()
creationFrame = Time.frameCount
PreInitShared()
InitShared()
ServerInit()                     <==== o LootContainer POPULA O LOOT AQUI
PostInitShared()
UpdateNetworkGroup()
ServerInitPostNetworkGroupAssign()
isSpawned = true
CallHook("OnEntitySpawned", this)  ; retorno DESCARTADO (pop)
SendNetworkUpdateImmediate()
```

> **Consequência dupla, e as duas importam:**
>
> **Boa** — quando o `OnEntitySpawned` dispara para um `LootContainer`, o
> container **já está cheio**, e o hook ainda roda **antes** do
> `SendNetworkUpdateImmediate()`. Injetar ali chega ao cliente no **primeiro
> pacote**, sem piscar. É exatamente o argumento que o
> `OrigemZItems.cs:1379-1381` já usa para o `WorldItem`.
>
> **Ruim** — ele **não cobre o refresh**. Um container que repopula pelo
> `StartLootRefreshCountdown` chama `SpawnLoot()` de novo, e `OnEntitySpawned`
> não dispara uma segunda vez. Só o `OnLootSpawn` cobre os dois.

### 3.5 Editar o `ScriptableObject` da tabela — como se faria, e por que não se faz

**O caminho existe e é acessível de plugin.** Medido em
`ConVar.Server::clear_loot_spawn_cache`, que é o próprio jogo enumerando todas
as tabelas de loot do servidor:

```csharp
GameManager.server.preProcessed.prefabList.Values
    .Select(prefab => prefab.GetComponent<LootContainer>())
    .Where(c => c != null)
    .ToArray()
    // depois: .Select(c => c.lootDefinition)
    //         .Concat(.SelectMany(c => c.LootSpawnSlots).Select(s => s.definition))
    // e ClearCache() em cada uma
```

Isto é ouro para diagnóstico: **um plugin pode achar todas as `LootSpawn` do
servidor sem precisar de nenhuma entidade no mundo, e antes de o mapa nascer.**

Mas para **injetar** o item ele não serve, por três razões medidas:

1. **A skin.** É o §4 inteiro, e sozinho já encerra o assunto.
2. **O cache se refaz.** `LootSpawn::EnsureFilterUpdated` recalcula
   `allowedItems` e `allowedSubSpawn` a partir de `items` e `subSpawn` sempre que
   a era do servidor ou o game mode mudam, ou quando `allowedSubSpawn` está
   nulo. E `LootSpawn::ClearCache` zera os dois — e é chamado pelo convar
   `server.clear_loot_spawn_cache`, **que qualquer admin pode digitar**. Editar
   `allowedItems` é escrever num cache; editar `items` é escrever na fonte, e é o
   que sobreviveria. Quem não souber a diferença escreve no lugar errado e o
   defeito aparece dias depois.
3. **É global e invisível.** `LootSpawn` é um `ScriptableObject` **compartilhado
   entre todos os containers que apontam para ele**. É a mesma proibição que o
   **[P§5.3]** já escreveu para a `ItemDefinition`: *nunca altere a definição;
   sempre intercepte*. Vale igual aqui.

### 3.6 A tabela comparativa dos cinco caminhos

| Caminho | Existe? | Sai com skin? | Cobre refresh? | Custo por evento | Veredito |
|---|---|---|---|---|---|
| **`OnLootSpawn` + `NextTick`** | **sim** (2 chamadas) | **sim** — nós criamos o `Item` | **sim** | um `int` lido por container populado | **recomendado** |
| `OnEntitySpawned` em `LootContainer` | sim | sim | **não** | dispara para **toda** entidade que nasce | complemento, não substituto |
| `CanPopulateLoot` | **não existe** | — | — | — | descartado: não está no build |
| `OnContainerPopulate` / `PopulateLoot` | **não existe** como hook | — | — | — | descartado: não está no build |
| Editar o `ScriptableObject` | sim, alcançável | **NÃO** | sim | zero em runtime | **descartado — não produz o item** |
| Acrescentar `LootSpawnSlot` | sim | **NÃO** | sim | zero | **descartado — e quebra o loot do container (§2.3)** |

---

## 4 — A pergunta que decide tudo: o item sai com a skin?

> Esta seção existe porque a resposta **inverte a recomendação óbvia**. Ela é a
> razão pela qual o §3.6 descarta dois caminhos que, de fora, pareciam os mais
> baratos.

### 4.1 Medido: o loot cria o item com `skin = 0`, e é literal

O IL de `LootSpawn::SpawnIntoContainer`, no ponto exato da criação:

```
ldloc.s  4          ; ItemDefinition def
...                 ; Mathf.Max(1, Mathf.Min(amount, stackable))
ldc.i4.0
conv.u8             ; ------> 0uL   : o parametro `skin`
ldc.i4.1            ; isServer = true
ldc.i4.0
conv.u8             ; ------> 0uL   : o parametro `attachment`
call     ItemManager::Create
```

E a assinatura de destino, medida em `ItemManager::Create`, com o que cada
argumento vira:

```
ItemManager.Create(ItemDefinition template,   // -> Item.info
                   Int32          amount,     // -> Item.amount
                   UInt64         skin,       // -> Item.skin      <== ZERO
                   Boolean        isServer,   // -> Item.isServer
                   UInt64         attachment) // -> Item.attachment
```

**Não há caminho alternativo.** Foi verificado que `GenerateScrap` usa a mesma
chamada com o mesmo `0uL`, e que o único ponto do `Create` que mexe em skin é
`ItemManager::TrySkinChangeItem(ref template, ref skin)`, que **retorna
imediatamente quando `skin == 0`**.

### 4.2 E a tabela não teria onde guardar a skin, nem que quisesse

Os campos de `ItemAmount` foram medidos e são cinco: `itemDef`, `amount`,
`startAmount`, `ignoreInTutorial`, `isBP`. `ItemAmountRanged` acrescenta um:
`maxAmount`.

> **Nenhum deles é skin.** A estrutura que descreve "o que pode sair desta
> tabela" **não tem o conceito**. Isso não é uma omissão do nosso lado: a tabela
> de loot do Rust nasceu para distribuir itens do jogo, e item do jogo não tem
> skin de servidor.
>
> **Portanto o caminho "editar a tabela" está fechado por construção, não por
> política.** Não existe valor a preencher.

### 4.3 O `ApplyIdentity` que já temos NÃO alcança esse item

O `Match` do plugin (`Plugins/OrigemZItems.cs:1048-1065`) é, na íntegra, isto:

```csharp
private CustomItem Match(Item item)
{
    if (item == null || item.info == null) return null;
    if (item.skin == 0UL) return null;                 // <==== AQUI
    CustomItem found;
    return _byMark.TryGetValue(MarkOf(item.info.itemid, item.skin), out found)
        ? found : null;
}
```

E o `ApplyIdentity` (`:1089-1140`) só é chamado depois de o `Match` devolver
algo.

> **O encadeamento inteiro, e ele fecha um ciclo:**
> a tabela cria com `skin = 0` → o `Match` sai em `skin == 0` → o
> `ApplyIdentity` nunca roda → o item fica com o nome *"Discord Trophy"*, a
> descrição *"A companion that reminds you of your youth"* e **nenhuma ação**.
>
> O `ConvertToPoints` (`:2578`) também nunca é chamado, porque ele depende do
> mesmo `Match`. **O jogador acha um item inútil, e o ranking não recebe nada.**
> É exatamente o cenário que o **[P§3.4]** descreveu como "a armadilha do
> `skinId = 0`", só que vindo do outro lado: lá o risco era premiar um item do
> jogo; aqui é **não premiar o nosso**.

**E não adianta afrouxar o `Match`.** Fazê-lo aceitar `skin == 0` para
`discord.trophy` reabre a armadilha do **[P§3.4]** inteira: um jogador que já
tivesse um Discord Trophy legítimo no baú veria o servidor convertê-lo em ponto.
O `skin == 0` é a saída barata do caminho quente **e** a garantia de correção —
mexer nela é caro nos dois eixos.

### 4.4 Onde a skin PODE ser carimbada — as três janelas, e a única boa

| Janela | Como seria | Veredito |
|---|---|---|
| **Na criação, no nosso código** (`OnLootSpawn` + `NextTick`) | `ItemManager.CreateByItemID(1494014226, 1, 1552602728526292UL)` e `MoveToContainer` | **é esta.** A marca nasce com o item; o `OnItemAddedToContainer` do próprio `Insert` já chama `ApplyIdentity` sozinho |
| **Depois, no `OnItemAddedToContainer`**, carimbando `item.skin` num `discord.trophy` de skin 0 | mudar `Item.skin` na mão e `MarkDirty()` | **não.** Não há como distinguir o troféu que a tabela criou do Discord Trophy que o jogo distribui em evento — é a armadilha do **[P§3.4]** com outro nome |
| **Depois, no `OnLootEntity`**, ao abrir o container | varrer e carimbar | **não**, pelo mesmo motivo, e ainda perde o item que foi destruído com o barril antes de alguém abrir |

O código da janela boa, e ele é curto porque tudo que ele precisa já existe:

```csharp
// A marca nasce COM o item. Nada de carimbar depois: um discord.trophy
// de skin 0 pode ser do jogo, e o §4.3 explica por que isso e' fatal.
private void TryInjectRare(LootContainer container)
{
    if (container == null || container.IsDestroyed) return;
    ItemContainer inv = container.inventory;
    if (inv == null) return;

    Item item = ItemManager.CreateByItemID(custom.BaseItemId, 1, custom.SkinId);
    if (item == null) return;

    // Ver §7.2: a procedencia viaja no item, porque o
    // OnItemAddedToContainer nao tem como saber de onde ele veio.
    item.SetItemOwnership(OriginLabel, OriginLoot);

    if (!item.MoveToContainer(inv, -1, true, false, null, true))
    {
        item.Remove();   // barril cheio: some, e nao conta no teto
        return;
    }
    // O ApplyIdentity NAO precisa ser chamado aqui: o MoveToContainer
    // termina em ItemContainer.Insert, que dispara o
    // OnItemAddedToContainer — e o hook que ja existe faz o resto.
}
```

> **O detalhe que faz a diferença de custo:** `MoveToContainer` → `Insert` →
> `CallHook("OnItemAddedToContainer")` foi **medido** no IL do
> `ItemContainer::Insert`. O nome, o ícone e a descrição do troféu injetado
> saem do caminho que o plugin **já tem**, sem uma linha nova. E como
> `container.playerOwner` é nulo num barril, o `ConsumeOnPickup` do
> `OrigemZItems.cs:1251-1256` **não** dispara — o troféu fica no barril até
> alguém pegá-lo, que é o comportamento certo.

### 4.5 O que viaja, e o que não

Medido em `Item::Save` — os campos da instância que vão para o `ProtoBuf.Item`
(e, portanto, para o cliente **e** para o save em disco):

| Campo do `Item` | Vai para | Serve a |
|---|---|---|
| `skin` (`UInt64`) | `skinid` | **a marca** |
| `name` (`String`) | `name` | o nome que o jogador lê |
| `text` (`String`) | `text` | hipótese em teste (`OrigemZItems.cs:1107-1121`) |
| `iconImageId` (`UInt32`) | `iconImageId` | o ícone do slot |
| `ownershipShares` | `ownership` (`username`, `reason`, `amount`) | **a procedência (§7)** |

> **É por isso que o item injetado sobrevive a tudo sem depender de plugin
> carregado** — a marca não está numa tabela nossa em memória, está gravada no
> item, e o jogo a salva e a transmite por nós. É a mesma tese do **[P§3.3]**,
> agora medida do lado do loot.

---

## 5 — Persistência

### 5.1 `oxide.reload` — o item fica; a injeção para

| O que | Sobrevive? | Por quê |
|---|---|---|
| o troféu **já injetado**, num barril ou num baú | **sim** | `Item.skin` é do item, e o `Item::Save` o grava |
| o **nome e o ícone** dele | **volta** quando o plugin recarrega | o `Unload` limpa `_items`/`_byMark`/`_icons` (`OrigemZItems.cs:451-473`), e o agente reenvia |
| a **injeção futura** | **para** até o cadastro voltar | o `OnLootSpawn` sai em `_byMark.Count == 0` |
| o **teto e o cooldown** | **depende de onde morarem** — ver o quadro abaixo | |

> #### &nbsp;&nbsp;O TETO NÃO PODE MORAR SÓ NA MEMÓRIA DO PLUGIN&nbsp;&nbsp; ####
>
> Um `oxide.reload` no meio do dia zeraria o contador e o teto diário viraria
> "teto por carga do plugin". Numa madrugada de três reloads, o dia rende três
> vezes o teto — e ninguém percebe, porque nada quebrou.
>
> É o mesmo raciocínio que já obrigou a **fila de pontos** a gravar em disco
> (`OrigemZItems.cs:17-27`), com a mesma justificativa: *cadastro perdido o
> agente remanda; o que não volta é o que já aconteceu no mundo.*
>
> **Proposta:** o teto e o cooldown moram **no agente**, na tabela do ranking,
> e o plugin pergunta. Isso custa uma ida ao RCON por injeção candidata — e a
> injeção candidata é rara **por definição**. A alternativa (contador no
> `oxide/data` do plugin, como a fila) é aceitável, mas perde a visão de rede:
> com seis servidores, "teto por servidor" e "teto da rede" deixam de ser a
> mesma pergunta. Ver §12, Q3.

### 5.2 Restart — e a boa notícia é que o loot **não** é repopulado

Medido, e é o par de linhas que decide:

```
LootContainer.PreServerLoad()   ->  isRestoringFromSave = true
LootContainer.ServerInit()      ->  if (initialLootSpawn && !isRestoringFromSave)
                                        SpawnLoot();
```

E o `LootContainer::Load`, quando `info.fromDisk`:

```csharp
if (shouldRefreshContents)          // = min > 0 && max > 0
{
    if (msg.lootContainer != null)
        StartLootRefreshCountdown(msg.lootContainer.countdownTimeRemaining);
    else if (initialLootSpawn)
        StartLootRefreshCountdown(null);   // sorteia novo intervalo
}
```

> **Leitura:** ao restaurar de save, o container **não** repopula — ele traz o
> conteúdo que estava lá (é um `StorageContainer`, e o inventário é salvo), e
> só o **cronômetro** de refresh é retomado. O log do `server01` confirma a
> escala do save: *"Saved 66,820 ents"*.
>
> **Consequência boa para o troféu:** um troféu injetado num barril **está no
> save**. Reiniciar o servidor não o apaga e não o duplica. E — importante para
> o teto — **restart não é uma nova rodada de sorteio**: o mapa inteiro não
> repopula, então não há risco de o boot gastar o teto do dia de uma vez.
>
> **Consequência ruim:** o troféu que ninguém achou **fica lá para sempre**,
> acumulando pelas semanas. O `destroyOnEmpty = true` (default medido no
> `.ctor`) só destrói o container quando ele é esvaziado; um barril nunca aberto
> guarda o troféu até o wipe. Isso é argumento para **contar o emitido, não só o
> sorteado** (§7.3).

### 5.3 Wipe — tudo recomeça, e é o único ponto em que o mapa inteiro sorteia

No wipe o save vai embora, o mundo nasce do zero, e **todos** os containers
passam por `ServerInit()` com `isRestoringFromSave = false` → `SpawnLoot()` →
`OnLootSpawn`.

**São 400 containers de população `loot`, mais os junkpiles, mais os de
monumento** — a ordem de grandeza é de **milhares de chamadas do hook em poucos
segundos**. Duas consequências:

1. **o custo do hook precisa ser um `int` lido**, como o `OnEntitySpawned` já
   faz (`OrigemZItems.cs:1406-1409`). Qualquer coisa mais cara aparece como
   tempo de boot;
2. **o teto diário tem de estar armado antes**, ou o wipe gasta a semana inteira
   no primeiro minuto. O que salva é o §5.4: no boot o cadastro **ainda não
   chegou**, e o hook sai cedo. **O acidente vira defesa** — mas por acaso, e
   por isso ele precisa virar regra explícita.

### 5.4 O buraco do boot — o mesmo que já mordeu este projeto

O plugin já registrou o problema, medido, no comentário do `OnEntitySpawned`
(`OrigemZItems.cs:1371-1376`):

> *"o cadastro só chega ao plugin depois do `OnServerInitialized` (ver
> `RequestSync`), e todo o loot que nasceu até lá — o mapa inteiro de barris —
> entrou nos containers com o `_byMark` ainda vazio."*

Confirmado nesta sessão, dos dois lados:

- **no plugin:** `OnServerInitialized` chama `RequestSync()`
  (`OrigemZItems.cs:424-431`), que é um `Puts(RequestMarker + RequestItems)`
  (`:476-479`) — ou seja, o cadastro **é pedido**, e chega depois, pelo RCON;
- **no jogo:** `BaseNetworkable::Spawn` chama `ServerInit()` (que popula) muito
  antes de qualquer `OnServerInitialized`.

> #### &nbsp;&nbsp;AQUI O BURACO NÃO É DEFEITO — É A ÚNICA COISA QUE SEGURA O WIPE&nbsp;&nbsp; ####
>
> No boot, `_byMark.Count == 0`, o `OnLootSpawn` sai na primeira linha, e
> **nenhum dos milhares de containers do mapa recebe troféu**. Isso é
> exatamente o que se quer: o wipe não deve emitir nada.
>
> **Mas apoiar-se num acidente é o que faz o defeito voltar em 2027.** A regra
> deve ser escrita, não herdada:
>
> **Regra proposta:** *o `OnLootSpawn` só injeta com o servidor **quente** — ou
> seja, depois de o cadastro ter chegado **e** de decorrido um carência mínimo
> desde o boot.* A carência resolve o caso em que o cadastro chega rápido e o
> mapa ainda está nascendo. Um valor da ordem de **5 minutos** basta; ele é
> pequeno demais para custar emissão (o alvo é 2 por semana) e grande o bastante
> para cobrir o boot inteiro.
>
> **E ela tem um efeito colateral bom:** o container que nasce **durante o
> jogo** — a população `loot` repõe barris destruídos, com
> `spawn.tick_populations = 60` — passa pelo `OnLootSpawn` com o servidor já
> quente. **É esse o caminho pelo qual o troféu deve nascer**, e não o wipe.

### 5.5 O refresh — o segundo caminho, e ele é fraco neste build

`LootContainer::get_shouldRefreshContents` é
`minSecondsBetweenRefresh > 0f && maxSecondsBetweenRefresh > 0f`, e os dois
nascem em **`0f`** no `.ctor` — o default é **não refazer o loot**. Os prefabs
podem sobrescrever, e alguns o fazem (é o que dá sentido ao
`countdownTimeRemaining` salvo).

**Não medido:** quais prefabs sobrescrevem, e com que valores. Esses números
vivem nos `ScriptableObject`/prefabs dos bundles, e **não há comando de RCON que
os imprima** (§9.5). Para o troféu isso não bloqueia nada — o caminho principal
é o nascimento do container, não o refresh —, mas significa que **não se pode
afirmar** que "o barril refaz o loot a cada X minutos".

---

## 6 — Raridade que se sustenta

### 6.1 O erro de raciocínio que a probabilidade sozinha esconde

O **[T§6.5]** já viu o problema — *"um jogador com rota de farm otimizada
transforma raro em constante"* — e a intuição está certa. O que falta é o
número que mostra **por quê**.

Probabilidade por container é uma taxa **por evento**. Quem controla o número de
eventos é o jogador, não o servidor. Dobrar a rota dobra a emissão; um clã de
dez pessoas farmando estrada multiplica por dez. **A probabilidade fixa entrega
o controle da economia a quem mais joga** — que é exatamente o oposto do que
"raro" quer dizer.

Um teto, sozinho, tem o defeito espelhado: ele transforma o troféu em **prêmio
de fuso horário**. Com teto de 1 por dia e sem mais nada, quem estiver on às
6 da manhã leva; quem joga à noite nunca vê um.

> **A regra que sai daí:** a raridade precisa de **um mecanismo que limita a
> taxa** (a probabilidade) **e de um que limita o total** (o teto). Nenhum dos
> dois serve sozinho, e é por isso que a recomendação do §6.4 é uma combinação e
> não uma escolha.

### 6.2 A granularidade que a tabela nativa NÃO tem

> #### &nbsp;&nbsp;`weight` É `Int32`, E ISSO ENCERRA A VIA DA TABELA&nbsp;&nbsp; ####
>
> Medido: `LootSpawn.Entry.weight` é `Int32`, e o sorteio é
> `Random.Range(0, total)` com `total = soma dos pesos` (§2.2).
>
> A menor probabilidade que uma entrada **nova** pode ter é, portanto,
> **`1/(total + 1)`** — com `weight = 1`, o menor inteiro positivo.
>
> Para `p ≈ 1/7 000` (§6.3), seria preciso que a tabela somasse ~7 000. Uma
> tabela de loot do Rust soma dezenas ou poucas centenas — **não medido**
> exatamente (os pesos vivem nos `ScriptableObject` dos bundles, e não há comando
> que os imprima, §9.5), mas a conclusão não depende do valor: **se o total for
> menor que o alvo, alcançar o alvo exige multiplicar todos os pesos
> existentes**, ou seja, reescrever uma tabela que é do jogo, em todos os
> containers que a compartilham.
>
> **Em código, o mesmo número é `if (Random.value < 0.00014)`.** Ajustável pelo
> painel, por servidor, sem tocar em nada do jogo.

O único campo do sistema nativo com granularidade fina é
**`LootSpawnSlot.probability`, que é `Single`** — e ele está fora de alcance
pelo motivo do §2.3: acrescentar um slot a um container que hoje popula por
`lootDefinition` **desliga o `lootDefinition`**.

### 6.3 Os números — e o denominador certo não é o que parece

> #### &nbsp;&nbsp;O SORTEIO ACONTECE NA POPULAÇÃO, NÃO NA ABERTURA&nbsp;&nbsp; ####
>
> Com o `OnLootSpawn`, o denominador da probabilidade é **containers populados
> por dia**, não "barris abertos por dia". São coisas diferentes — mas, **em
> regime estacionário, elas convergem**: a população `loot` do `server01` se
> mantém em **400/400** (medido), e ela só repõe o que foi destruído. Barril
> destruído é barril que alguém abriu. Logo, no equilíbrio,
> **containers populados por dia ≈ containers abertos por dia**.
>
> Isso é bom porque o número é **medível de dentro** — um contador de chamadas
> do `OnLootSpawn` por hora responde exatamente o denominador (§9.5).

A conta é uma divisão. Para um alvo `A` de troféus por semana e `N` containers
populados por dia:

```
p = (A / 7) / N
```

| `N` (containers/dia) | `A` = 1/sem | `A` = 2/sem | `A` = 3/sem |
|---:|---|---|---|
| 500 | 1 em 3 500 | 1 em 1 750 | 1 em 1 167 |
| 1 000 | 1 em 7 000 | 1 em 3 500 | 1 em 2 333 |
| **2 000** | 1 em 14 000 | **1 em 7 000** | 1 em 4 667 |
| 5 000 | 1 em 35 000 | 1 em 17 500 | 1 em 11 667 |
| 10 000 | 1 em 70 000 | 1 em 35 000 | 1 em 23 333 |

**De onde vem o `N`, e o que é medido e o que é estimativa:**

| Peça | Valor | Origem |
|---|---|---|
| containers de mundo aberto vivos | **400** (133 + 134 + 133) | **medido** por RCON, `spawn.report true loot` |
| junkpiles vivos | **800** | **medido**, `spawn.report` |
| containers de monumento | **desconhecido** | **não medível** — não são população (§2.4) |
| densidade atual | **0,5** (mínima, 1 jogador) | **medido**, `spawn.scalars` |
| densidade com servidor cheio | 1,0 | leitura de `spawn.min_density` / `max_density` / `player_base` |
| giro (quantas vezes por dia os 400 são repostos) | **não medido** | é o que o contador do §9.5 responderia |
| **`N` estimado** | **1 000 a 5 000** | **ESTIMATIVA**, e ela é o elo fraco desta seção |

> **Sendo honesto sobre a estimativa:** ela vem de supor que os 400 containers
> de mundo aberto giram de 2 a 12 vezes por dia num servidor com dezenas de
> jogadores, mais os junkpiles, mais os de monumento. **Não foi medida**, e não
> podia ser: com um jogador online e sem instrumentação, o giro é zero.
>
> **A recomendação prática que isso força:** a primeira semana no ar roda com o
> contador ligado e a probabilidade **calibrada depois**, não antes. Um valor de
> partida de `p = 1/5 000` erra por um fator de 2 a 5 — e errar para **mais raro**
> é o erro certo a cometer.

**A variância também precisa ser dita.** Com `A = 2` por semana, a emissão é um
processo de Poisson com `λ = 2`:

| Semana com… | Probabilidade |
|---|---|
| **nenhum** troféu | **13,5 %** |
| 1 ou 2 | 54,1 % |
| 3 ou 4 | 27,1 % |
| **5 ou mais** | **5,3 %** |
| 6 ou mais | 1,7 % |

> Uma semana em sete não sai troféu nenhum. **Isso não é defeito** — é o que
> "raro" significa. Mas é preciso que o dono saiba disso **antes**, porque a
> pergunta *"o spawn raro está quebrado?"* vai aparecer na primeira semana seca.

### 6.4 A combinação recomendada, com números

Quatro camadas. Cada uma cobre o buraco que a anterior deixa.

| # | Camada | Valor de partida | O que ela impede |
|---|---|---|---|
| 1 | **probabilidade por container** | `1 / 5 000` | que a emissão dependa do estoque |
| 2 | **filtro por tipo de container** | só zona de risco (lista abaixo) | que o troféu vire recompensa de farm de estrada |
| 3 | **teto por servidor / dia** | **1** | a cauda do Poisson e o dia em que a sorte estoura |
| 4 | **teto por servidor / semana** | **3** | que sete dias de sorte virem uma temporada |

**A camada 2, executável.** Os prefabs de container deste build, medidos em
`Servers/server01/Bundles/AssetSceneManifest.json`. O filtro é o
`ShortPrefabName` da entidade:

| Grupo | `ShortPrefabName` | Recomendação |
|---|---|---|
| mundo aberto | `loot_barrel_1`, `loot_barrel_2`, `oil_barrel`, `loot_trash`, `minecart` | **fora** — é o farm de rota |
| radtown baixo | `crate_basic`, `crate_basic_jungle`, `crate_shore`, `foodbox`, `crate_tools` | fora |
| radtown médio | `crate_normal`, `crate_normal_2`, `crate_normal_2_food`, `crate_normal_2_medical`, `crate_mine`, `crate_cannons` | **candidato** |
| radtown alto | `crate_elite`, `crate_underwater_basic`, `crate_underwater_advanced` | **dentro** |
| evento | `heli_crate`, `bradley_crate`, `supply_drop` | **dentro** — e o **[T§8.2]** já tem regra para airdrop |

> **Por que `crate_elite` e não o barril** — é literalmente o pedido do
> **[T§6.5]**: *"o valor da mecânica é o risco, não o loot"*. E tem um efeito
> aritmético: os `crate_elite` são muito menos numerosos que os 400 barris, e
> isso **derruba o `N`** — o que permite uma probabilidade **maior** (mais
> perceptível como mecânica) para o mesmo alvo semanal.
>
> **Não medido:** quantos `crate_elite` existem neste mapa. Eles não são
> população, e o comando que os contaria não existe (§9.5).

### 6.5 O cooldown por jogador — e por que ele NÃO cabe no `OnLootSpawn`

O **[T§6.5]** não pediu cooldown por jogador; este estudo o considerou e
**precisa registrar por que ele não entra na via recomendada**:

> **No instante do `OnLootSpawn` não existe jogador.** O container é populado
> pelo mundo, sozinho, muitas vezes longe de qualquer um. Não há a quem aplicar
> um cooldown.

Existe uma via alternativa em que ele caberia:

| | **Via A — na população** (`OnLootSpawn`) | **Via B — na abertura** (`OnLootEntity`) |
|---|---|---|
| quando o troféu nasce | quando o container nasce | quando alguém abre o container |
| há jogador? | **não** | **sim** |
| cooldown por jogador | **impossível** | possível |
| denominador da probabilidade | containers populados | **aberturas** — o número que se quer |
| troféu que ninguém acha | fica no barril até o wipe | não existe |
| barril destruído com explosivo | espalha o troféu no chão (`DropUtil.DropItems` → `OnContainerDropItems`, medido) | não emite nada |
| repetição no mesmo container | não há | precisa de guarda — e ela existe: `LootContainer.HasBeenLooted` e `FirstLooterId` (medidos) |
| o troféu "aparece" na cara do jogador | não | **sim, e não foi medido se sem piscar** |

> **A honestidade sobre a Via B:** o `OnLootEntity` dispara **antes** de o
> container entrar na lista do `PlayerLoot` — isso está medido e registrado no
> próprio plugin (`OrigemZItems.cs:1467-1472`), que por isso usa `NextTick`.
> **Não foi medido** se um item inserido nesse intervalo chega junto do primeiro
> pacote do painel ou se o jogador vê o slot preencher. Se vir, a mecânica fica
> visivelmente artificial — e aí a Via A é melhor mesmo perdendo o cooldown.
>
> **É a pergunta Q1 do §12, e ela é bloqueante.**

---

## 7 — Integridade e auditoria

### 7.1 O problema, exatamente

A `source` do evento `#OZSTAT#` é hoje `item:<id do item custom>` — está fixado
no **[A§8.1]** e validado no agente por
`core/src/rankings/stat-events.ts:271-275`:

```ts
const sourceSchema = z.string().min(1).max(120)
  .regex(/^[a-z][a-z0-9._-]*(:[a-zA-Z0-9._-]+)?$/,
         'A procedência é `familia` ou `familia:id`.');
```

E a auditoria que ela sustenta é o `GROUP BY day, metric, source` de
`core/src/db/rankings-repository.ts:1536-1544`.

> **O problema é que a `source` é montada no instante da CONVERSÃO, e ali o
> plugin não sabe de onde o item veio.** O `ConvertToPoints`
> (`OrigemZItems.cs:2578`) recebe um `Item` que carrega a marca — e a marca é a
> mesma para o troféu comprado na loja, para o que o admin deu e para o que caiu
> do `crate_elite`. **Três procedências, um `source`.**
>
> Sem resolver isso, a pergunta *"de onde vieram os 400 pontos do primeiro
> colocado?"* passa a ter uma resposta só, `item:trofeu-bleik-store`, que é
> verdadeira e inútil.

### 7.2 A solução: a procedência viaja DENTRO do item

Foi medido que o Rust tem um campo para isso, e que ele atravessa tudo:

```
ItemOwnershipShare : System.ValueType   (struct)
  username  String
  reason    String
  amount    Int32
  IsValid() => !string.IsNullOrEmpty(reason)

Item.SetItemOwnership(string username, string reason)
Item.Save() -> ProtoBuf.Item.ownership { username, reason, amount }
```

**E o próprio loot já o usa:** `LootSpawn::SpawnIntoContainer` chama
`item.SetItemOwnership(share.username, share.reason)` quando o
`ItemOwnershipShare` recebido é válido, e `LootContainer::OnStartBeingLooted`
carimba ownership em todos os itens do container quando alguém o abre.

**E este plugin já escreve nele**, com um rótulo próprio:
`ApplyDescription` (`OrigemZItems.cs:1166-1199`) grava
`username = "SOBRE O ITEM"` (`:1209`) e `reason = a descrição`, e usa o
`username` como marca de idempotência para não empilhar a mesma frase.

> **Proposta:** o troféu injetado no loot ganha **uma segunda linha de
> ownership**, com um rótulo reservado:
>
> ```csharp
> private const string OriginLabel = "ORIGEM";     // o rotulo, e a marca
> private const string OriginLoot  = "loot";       // o valor
> ```
>
> Na conversão, o `ConvertToPoints` lê essa linha e monta a `source`. Ela
> sobrevive ao restart e ao `oxide.reload` porque está **no item**, não numa
> tabela do plugin — que é a mesma razão pela qual a skin é a marca (**[P§3.3]**).

**Duas ressalvas honestas, e a segunda pede decisão do dono:**

1. **o rótulo é visível ao jogador.** O `ownership` é desenhado no painel do
   item — é justamente por isso que o `ApplyDescription` o usa. Uma linha
   `ORIGEM: loot` aparece para quem olhar. Pode ser bom (dá sabor) ou ruim
   (revela a mecânica);
2. **`ownershipShares` não é campo nosso.** Se um dia a Facepunch mudar o que
   escreve ali, ou se o `OnStartBeingLooted` sobrescrever a lista, a etiqueta se
   perde. O efeito de perder é **degradação, não erro**: sem a linha, a `source`
   cai no padrão `item:<id>` de hoje. É a forma certa de falhar.

### 7.3 O formato da `source`, e a divergência com o **[A§8.1]**

Duas formas cabem no regex do agente sem uma linha de código novo:

| Forma | Exemplo | A favor | Contra |
|---|---|---|---|
| **família nova** | `loot:trofeu-bleik-store` | separa limpo no `GROUP BY`; a coluna nasceu "aberta no banco, fechada no zod" (`core/src/db/migrations.ts:3539-3541`) | **diverge do [A§8.1]**, que fixa `item:<id>` |
| sufixo no id | `item:trofeu-bleik-store-loot` | não muda a família | polui o id; quebra qualquer consulta que case `source = 'item:' || id` |

> **Recomendação:** a **família nova**, `loot:<id>`. Ela é o que o comentário da
> migração já previa (*"De onde veio: `item:trofeu-bleik`, `dungeon`,
> `admin`"*), e mantém a métrica única — o troféu do loot e o da loja somam no
> mesmo `trophy.bleik`, que é o que o ranking quer.
>
> **Mas é uma divergência com um documento fechado, e por isso vai como pergunta
> Q2 ao dono (§12), não como decisão tomada aqui.**

### 7.4 A conferência que o teto exige: sorteado ≠ emitido

O teto do §6.4 conta **sorteios**. O ranking conta **conversões**. Os dois
números **não batem**, e a diferença tem explicação:

```
sorteados     >=   achados     >=   convertidos
   |                 |                  |
   |                 |                  +-- o jogador pegou: vira ponto
   |                 +-- alguem abriu o container
   +-- o plugin injetou
```

O troféu que ficou num barril que ninguém abriu até o wipe **conta no teto e não
conta no ranking**. Numa semana de `A = 2` isso pode significar zero pontos com
dois sorteios gastos.

> **Proposta:** o plugin emite um evento de diagnóstico **no sorteio**, e o
> agente guarda os dois números. A conferência `sorteados × convertidos` é a
> mesma que o **[T§8.2]** já pede para *"emitidos × convertidos"* — é a mesma
> conta, um elo antes. Sem ela, o teto é uma caixa-preta: não dá para saber se
> "não saiu troféu" é sorte ruim ou defeito.

---

## 8 — O anúncio

### 8.1 Vale a pena? Sim — e o custo é quase zero

O **[T§6.5]** pede *"anúncio no chat quando cair"*, e o **[T§11]** já aponta o
canal. O levantamento confirma que **nada precisa ser construído**:

| Peça | Onde | Estado |
|---|---|---|
| comando do plugin | `origemz.chat.broadcast <base64 do JSON>` (`Plugins/OrigemZChat.cs:131`, `:1373-1374`) | **existe** |
| resposta | `{"ok":true,"sent":N}` (`OrigemZChat.cs:1428`) | existe |
| transporte no agente | `PluginBroadcaster` (`core/src/game/broadcast.ts:157`), comando em `:108`, montagem em `:220` | **existe e é único** |
| fallback | `say` sem cor (`broadcast.ts:297`) | existe |
| agendador | `MessagesService.speak({ serverId, text, tag, tagColor })` (`core/src/messages/service.ts:258`) | **existe** |
| payload | `text`, `tag`, `tagColor`, `color`, `size`, `steamId` (`OrigemZChat.cs:2055-2075`) | existe |

**O custo por anúncio** é uma linha de RCON, e ele acontece **2 a 3 vezes por
semana**. Comparado com o `MESSAGES_TICK_MS = 30_000` do agendador
(`service.ts:57`), que roda 2 880 vezes por dia, é ruído.

### 8.2 Quando anunciar — e a resposta não é "quando cair"

> #### &nbsp;&nbsp;ANUNCIAR NO SORTEIO ENTREGA O MAPA&nbsp;&nbsp; ####
>
> Se o anúncio sair no instante da injeção, ele diz que existe um troféu **num
> container que ninguém abriu ainda**. Num servidor com radar de admin e
> jogadores atentos, isso vira corrida — e o troféu vira prêmio de quem estava
> mais perto, não de quem correu o risco.
>
> Pior: com a Via A (§6.5), o container pode nascer longe de todo mundo e ficar
> semanas fechado. O anúncio teria mentido.

**Proposta — dois momentos, com finalidades diferentes:**

| Momento | Onde | Público | Texto |
|---|---|---|---|
| **sorteio** | log do agente + evento de diagnóstico (§7.4) | ninguém | é auditoria, não anúncio |
| **conversão** | chat do servidor, `MessagesService.speak` | todos | *"Fulano encontrou um Troféu Bleik Store."* |

O gancho do segundo já existe: o `ConvertToPoints` é o ponto onde o ponto é
creditado, e o **[A§9]** já desenha um **recibo ao jogador** ali. O anúncio de
servidor é o mesmo evento, com outro alcance.

> **A escolha de não dizer onde caiu é deliberada** e é o que o **[T§6.5]** quis
> dizer com *"é um evento de servidor, não um achado particular"*: o valor está
> em **todos saberem que aconteceu**, não em saberem onde.

---

## 9 — O que NÃO dá

> Esta seção vale mais que uma recomendação, porque cada linha dela é um dia de
> trabalho que alguém não vai perder.

### 9.1 Pôr o item custom na tabela de loot — **não dá**

Não é difícil: **é impossível**. `ItemAmount` não tem campo de skin (§4.2), e
`LootSpawn.SpawnIntoContainer` passa `0uL` literal para `ItemManager.Create`
(§4.1). O que a tabela produziria é um `discord.trophy` do jogo, que o `Match`
descarta em `item.skin == 0` (§4.3).

**E não adianta "carimbar depois"**: o item da tabela é indistinguível do
Discord Trophy que o próprio jogo distribui, e reconhecê-lo pela ausência de
skin reabre a armadilha do **[P§3.4]** por inteiro.

### 9.2 Usar `CanPopulateLoot` ou `OnContainerPopulate` — **não existem**

Zero ocorrências nos 685 nomes de hook deste build (§3.3). Um plugin que os
declare **carrega sem erro e nunca é chamado**. Se alguém copiar um plugin da
comunidade que os use, ele vai parecer "não funcionar" em vez de "não estar lá",
e a depuração vai para o lugar errado.

### 9.3 Acrescentar um `LootSpawnSlot` para ganhar granularidade — **quebra o container**

`LootSpawnSlot.probability` é `Single` e resolveria o §6.2 de graça. Mas
`LootContainer::FillLoot` **retorna** depois de processar os slots: um container
que hoje popula por `lootDefinition` e que ganhasse um slot passaria a popular
**só por ele**, e o loot original sumiria (§2.3).

Fazer direito exigiria reconstruir o `lootDefinition` como um slot de
`probability = 1` mais o nosso — em **todos** os prefabs afetados, e refazendo
isso a cada update do Rust que mexer nas tabelas. **Não vale, e o §4 já tinha
descartado por outro motivo.**

### 9.4 Cancelar o `OnLootSpawn` para "assumir" a população — **dá, e é armadilha**

Funciona: retorno não-nulo aborta. Mas o inventário **já foi limpo** antes do
hook, e `PopulateLoot()` **nunca roda** — o container fica com o troféu e mais
nada. O defeito aparece como *"depois do plugin novo os crates só têm o
troféu"*, e só depois de alguém abrir um. **A via correta é não cancelar e
agendar (§3.2c).**

### 9.5 Os comandos de diagnóstico que **não existem** — e que este estudo sentiu falta

Todos foram procurados nos ~2 229 comandos e convars deste build (`find spawn`,
`find loot`, `find report`, `find count` por RCON) e **não estão lá**:

| O que faltou | Por que faltou | O que existe, e por que não serve |
|---|---|---|
| imprimir a **tabela de loot** de um prefab (os pesos!) | é o número que falta no §6.2 | `spawn.simulate_loot` — **exige jogador**: testado por RCON, respondeu literalmente `Must be called from player`. E ele **não é simulação**: o IL mostra `Clear()` + `PopulateLoot()` no container real |
| **contar** `LootContainer` no mundo, por prefab | é o `N` do §6.3 | `spawn.report` só cobre **populações**; os de monumento são prefabs fixos do mapa |
| contar `crate_elite` vivos | decide a probabilidade da camada 2 (§6.4) | idem |
| medir o **giro** (containers populados por hora) | é o denominador do §6.3 | nada nativo |
| `global.report` por RCON | daria contagem de entidades | **testado: não devolve nada pelo RCON** — imprime só no console do servidor |

> **A recomendação, e ela é uma linha de plugin, não um comando novo do jogo:**
> um contador de chamadas do `OnLootSpawn`, agrupado por `ShortPrefabName`,
> exposto no `origemz.item.diag` que **já existe**
> (`Plugins/OrigemZItems.cs:148`, `:2788-2789`). Ele responde o `N`, responde
> "quantos `crate_elite` populam por dia" e responde as duas de graça, porque o
> hook já vai estar lá.
>
> **Este estudo não o criou** — o pedido foi explícito em não alterar código. Ele
> fica registrado aqui como a primeira coisa a construir na Fatia 1 (§10).

### 9.6 Harmony patching no caminho do loot — **dá, e não se deve**

`0Harmony.dll` está presente e a `CustomItemDefinitions` já faz patching pesado
(**[P§3.6.4]**). Patchar `LootContainer.PopulateLoot` daria controle total.

**Não se deve**, e o motivo é o mesmo que o **[P§3.6.5]** já registrou: é
exatamente o tipo de código que um update do Rust quebra, e a memória desta casa
já anotou que *o Oxide atrasa atrás do Steam* — o dia em que o patch quebrar é o
dia em que o servidor não sobe. **Com o `OnLootSpawn` disponível e suficiente,
patchar é pagar risco por nada.**

### 9.7 Uma nota sobre o `skinId` e o `TrySkinChangeItem` — medido, e sem risco

`ItemManager::Create` chama `TrySkinChangeItem(ref template, ref skin)` antes de
tudo. Medido: se `skin != 0`, ele procura
`ItemSkinDirectory.FindByInventoryDefinitionId((int)skin)` e, se achar uma skin
com `Redirect`, **troca o item e zera a skin**.

O `(int)` é um truncamento: `1552602728526292` vira `2115793364`. **Não foi
medido** se esse id existe no `ItemSkinDirectory` — é improvável, e o efeito de
uma colisão seria visível na hora (o item sairia como outro item, sem marca).
Fica registrado como **risco conhecido, considerado e não medido**, e como mais
um argumento para o teste de fumaça da Fatia 1 (§10).

---

## 10 — O plano em fatias

Cada fatia é entregável sozinha, e nenhuma depende de decisão que ainda não foi
tomada — exceto onde está dito.

| # | Fatia | O que entrega | Depende de |
|---|---|---|---|
| **1** | **medir antes de emitir** | `OnLootSpawn` só conta e agrupa por `ShortPrefabName`; o número sai no `origemz.item.diag`. **Nada é injetado.** Roda uma semana | nada |
| **2** | **a injeção, desligada** | `TryInjectRare` completo (§4.4), com probabilidade **zero** e um comando de admin que força um sorteio. Prova que o item nasce com nome, ícone e marca | 1 |
| **3** | **a raridade** | probabilidade calibrada com o `N` da fatia 1, filtro por prefab, teto dia/semana | 2, **Q1**, **Q4** |
| **4** | **a procedência** | a linha `ORIGEM` no ownership, a `source` no evento, a conferência sorteado × convertido | 3, **Q2**, **Q6** |
| **5** | **o anúncio** | `MessagesService.speak` na conversão | 4 |

> **Por que a fatia 1 vem antes de tudo, e não é preguiça:** sem o `N` medido, a
> probabilidade do §6.4 é um chute com fator de erro de 5. Uma semana de contagem
> custa uma semana e resolve o único número que este estudo **não conseguiu
> medir**.
>
> **E ela é barata:** o hook, o comando de diagnóstico e o padrão de saída
> antecipada já existem no plugin. É acrescentar um `Dictionary<string, int>` e
> uma linha no `diag`.

**Antes da fatia 2, um teste de fumaça de dez minutos**, no `server01`, que
responde três coisas de uma vez:

1. `origemz.give` do troféu (que já funciona) → o item chega com nome e marca?
2. `TryInjectRare` forçado num `crate_normal` → o troféu aparece **com nome** no
   painel do container, ou aparece como *"Discord Trophy"*?
3. o mesmo troféu, depois de um `oxide.reload` e de um restart → a marca fica?

Se (2) mostrar *"Discord Trophy"*, a hipótese do §4.4 caiu e o
`OnItemAddedToContainer` não está vestindo o item dentro de container sem dono —
e aí o `ApplyIdentity` precisa ser chamado explicitamente no `TryInjectRare`.
**É o único ponto do desenho que depende de uma hipótese não medida.**

---

## 11 — Medido, conferido, projeto

> A separação é obrigatória nesta casa, e é o que impede alguém de construir
> sobre suposição. **Nada abaixo da linha "PROJETO" foi validado.**

### 11.1 MEDIDO — no IL do `Assembly-CSharp.dll` deste servidor

Método: desmontador `iltype` (scratchpad desta sessão, herdado de outra frente),
modos `--types`, `--xref`, dump por tipo, e um modo `--hooks` acrescentado numa
**cópia** do desmontador — a original não foi tocada, porque outra frente a
estava usando.

| O que | Onde, no IL |
|---|---|
| campos e métodos de `LootSpawn`, `LootSpawn.Entry`, `ItemAmount`, `ItemAmountRanged`, `LootSpawnSlot`, `LootContainer`, `LootFill` | dump por tipo |
| o sorteio ponderado `P = peso / total`, com `Random.Range(0, total)` | `LootSpawn::SubCategoryIntoContainer` |
| `1 + extraSpawns` execuções da sub-tabela sorteada | idem |
| **`ItemManager.Create(def, amount, 0uL, true, 0uL)` — a skin é literal zero** | `LootSpawn::SpawnIntoContainer` |
| a assinatura `Create(ItemDefinition, Int32, UInt64 skin, Boolean, UInt64)` e `skin → Item.skin` | `ItemManager::Create` |
| **`ItemAmount` não tem campo de skin** (5 campos, nenhum é skin) | dump por tipo |
| o guard de 32 iterações do laço de criação | `LootSpawn::SpawnIntoContainer` |
| a ordem `Clear` → `DoRemoves` → **hook** → `PopulateLoot` | `LootContainer::SpawnLoot` |
| **`OnLootSpawn` existe, com duas assinaturas** (`LootContainer` e `LootFill`) | `LootContainer::SpawnLoot`, `LootFill::DelayFill` |
| **788 pontos de chamada de hook, 685 nomes distintos** | varredura de `Interface::CallHook` |
| **`CanPopulateLoot` e `OnContainerPopulate` não existem** | idem |
| `OnEntitySpawned` roda **depois** de `ServerInit()` e o retorno é descartado | `BaseNetworkable::Spawn` |
| `OnItemAddedToContainer` é chamado no fim de `Insert` e o retorno é descartado | `ItemContainer::Insert` |
| `OnContainerDropItems` é cancelável, e o barril quebrado usa `Item.CreateWorldObject` | `DropUtil::DropItems` |
| o ramo de slots do `FillLoot` **retorna** e desliga o `lootDefinition` | `LootContainer::FillLoot` |
| `Random.Range(0f,1f)` comparado com `slot.probability`, `numberToSpawn` vezes | idem |
| `ServerInit` pula `SpawnLoot` quando `isRestoringFromSave` | `LootContainer::ServerInit`, `::PreServerLoad` |
| `Load` só retoma o cronômetro de refresh | `LootContainer::Load` |
| defaults do container: `destroyOnEmpty=true`, `initialLootSpawn=true`, `min/maxSecondsBetweenRefresh=0f` | `LootContainer::.ctor` |
| `shouldRefreshContents = min > 0 && max > 0` | `LootContainer::get_shouldRefreshContents` |
| `Item.Save` copia `skin`, `name`, `text`, `iconImageId` e `ownershipShares` para o protobuf | `Item::Save` |
| `ItemOwnershipShare { username, reason, amount }` e `IsValid = !IsNullOrEmpty(reason)` | dump por tipo |
| o loot carimba ownership; abrir o container também carimba | `LootSpawn::SpawnIntoContainer`, `LootContainer::OnStartBeingLooted` |
| `EnsureFilterUpdated` recalcula `allowedItems` de `items`; `ClearCache` zera os dois | `LootSpawn::EnsureFilterUpdated`, `::ClearCache` |
| o caminho para enumerar **todas** as `LootSpawn`: `GameManager.server.preProcessed.prefabList` | `ConVar.Server::clear_loot_spawn_cache` |
| `spawn.simulate_loot` exige jogador e **repopula o container real** | `ConVar.Spawn::simulate_loot` |
| `TrySkinChangeItem` retorna cedo quando `skin == 0`; com skin, pode redirecionar item | `ItemManager::TrySkinChangeItem` |
| os hooks **não estão** em nenhum `Oxide.*.dll` — são `CallHook` compilados no jogo | busca nos 8 assemblies |

### 11.2 MEDIDO — no `server01` ao vivo, por RCON (só leitura)

Método: cliente WebSocket em Node (`ws` de `node_modules`), lendo host, porta e
senha de `Configs/server01.ini`. **Nenhum comando que altera o mundo foi
executado** — o dono estava jogando.

| Comando | Resultado |
|---|---|
| `server.fps` | 91 FPS |
| `players` | 1 online (o dono) |
| `spawn.report` | `loot` **400/400**; `junkpiles` 800/800; `junkpiles_water` 127/128; `ores` 1566; `divesites` 128 |
| `spawn.report true loot` | `loot-barrel-1` **133**, `loot-barrel-2` **134**, `trash-pile-1` **133** |
| `spawn.scalars` | Rate 0,5 · Density 0,5 · Group Rate 1 · Player Fraction 0 |
| `find spawn` / `find loot` / `find report` / `find count` | o inventário de convars e comandos deste build |
| `spawn.simulate_loot 10` | **`Must be called from player`** |
| `global.report` | **não devolve nada pelo RCON** |
| `origemz.item.list` | **o troféu já está cadastrado neste servidor**: `{"id":"trofeu-bleik-store","base":"discord.trophy","baseItemId":1494014226,"skin":"1552602728526292","action":"points","iconCrc":0}` |
| `origemz.item.diag` | `INVALID_ARGS` — ele exige argumento |

### 11.3 MEDIDO — em arquivos do repositório e da instalação

| O que | Onde |
|---|---|
| `discord.trophy`: `itemid 1494014226`, `stackable 1`, `rarity "None"`, `HasSkins false` | `Servers/server01/Bundles/items/discord.trophy.json` |
| os prefabs de container de loot deste build (`loot_barrel_1/2`, `oil_barrel`, `crate_normal*`, `crate_elite`, `crate_underwater_*`, `foodbox`, `crate_basic`, `crate_mine`, `crate_shore`, `crate_tools`, `crate_cannons`, `loot_trash`, `minecart`, `heli_crate`, `bradley_crate`, `supply_drop`) | `Servers/server01/Bundles/AssetSceneManifest.json` |
| `Match` sai em `item.skin == 0UL` | `Plugins/OrigemZItems.cs:1057-1060` |
| `ApplyIdentity` escreve `name`, `iconImageId`, `text` e chama `MarkDirty` | `Plugins/OrigemZItems.cs:1089-1140` |
| `ApplyDescription` já usa `ownershipShares` com rótulo `"SOBRE O ITEM"` | `Plugins/OrigemZItems.cs:1166-1199`, `:1209` |
| `OnItemAddedToContainer` só converte com `container.playerOwner` não nulo e não-NPC | `Plugins/OrigemZItems.cs:1251-1256` |
| `OnEntitySpawned` sai em `_byMark.Count == 0` | `Plugins/OrigemZItems.cs:1406-1409` |
| `OnLootEntity` usa `NextTick` porque o hook precede o `AddContainer` | `Plugins/OrigemZItems.cs:1467-1475` |
| o cadastro só é pedido no `OnServerInitialized`, via `Puts` marcado | `Plugins/OrigemZItems.cs:424-431`, `:476-479` |
| `Unload` limpa `_items`, `_byMark`, `_icons` | `Plugins/OrigemZItems.cs:451-473` |
| o regex da `source` do agente | `core/src/rankings/stat-events.ts:271-275` |
| a auditoria `GROUP BY day, metric, source` | `core/src/db/rankings-repository.ts:1536-1544` |
| a coluna `source` nasceu "aberta no banco, fechada no zod" | `core/src/db/migrations.ts:3539-3541` |
| `origemz.chat.broadcast <base64>` e a resposta `{"ok":true,"sent":N}` | `Plugins/OrigemZChat.cs:131`, `:1373-1374`, `:1428`, `:2055-2075` |
| `PluginBroadcaster`, comando e montagem do payload | `core/src/game/broadcast.ts:108`, `:157`, `:220`, `:297` |
| `MessagesService.speak` e o tick de 30 s | `core/src/messages/service.ts:57`, `:258` |
| o `[T§6.5]` inteiro, contestado no §1.3 | `Docs/TrofeuBleik/TROFEU_BLEIK_STORE.md:878-894` |
| o `[T§6.5]` classifica o esforço do spawn raro como "mínimo" | `Docs/TrofeuBleik/TROFEU_BLEIK_STORE.md:809` |
| a métrica separada `trophy.bleik.rare` que o troféu previu | `Docs/TrofeuBleik/TROFEU_BLEIK_STORE.md:721` |
| o formato do `#OZSTAT#` e o `source: item:<id>` | `Docs/CustomItem/03-ACAO-PONTOS-DE-RANKING.md:420-429` |

### 11.4 CONFERIDO — lido de fonte externa, não medido aqui

| Afirmação | Fonte | Nota |
|---|---|---|
| o Oxide despacha hooks por nome **e** compatibilidade de tipos dos parâmetros, e não invoca quando o tipo não bate | documentação e comportamento conhecido do uMod/Oxide | **não verificado neste build.** É o que sustenta a ressalva do §3.2 sobre `OnLootSpawn(LootFill)` |
| plugins da comunidade usam `CanPopulateLoot` | páginas de plugins de loot | é o motivo de o §9.2 existir; **neste build o hook não está lá**, e isso **foi** medido |

**E o que NÃO tem fonte, e por isso está marcado como estimativa:** quantos
containers um servidor com dezenas de jogadores gira por dia (o `N` do §6.3).
Não foi lido de fonte nenhuma e não foi medido — é aritmética de cenário, e a
fatia 1 do §10 existe para substituí-la por medição.

### 11.5 PROJETO — proposto aqui, e **não validado**

| Proposta | Onde | Risco se estiver errada |
|---|---|---|
| injetar no `OnLootSpawn` + `NextTick`, sem cancelar | §3.2c, §4.4 | baixo — o padrão `NextTick` já é usado duas vezes no plugin |
| o `OnItemAddedToContainer` veste o item injetado sozinho, sem `ApplyIdentity` explícito | §4.4 | **médio, e é a única hipótese de que o desenho depende.** O teste de fumaça do §10 a responde |
| carência de ~5 min desde o boot antes de injetar | §5.4 | baixo |
| probabilidade de partida `1/5 000`, teto 1/dia e 3/semana | §6.4 | **alto em calibração, nulo em correção** — erra o volume, não quebra nada |
| filtrar por `ShortPrefabName`, só zona de risco | §6.4 | baixo |
| a procedência viajar em `ownershipShares` com rótulo `ORIGEM` | §7.2 | médio — depende de o jogo não sobrescrever a lista |
| a `source` virar `loot:<id>` | §7.3 | **diverge do [A§8.1]** — precisa da Q2 |
| teto e cooldown morarem no agente | §5.1 | médio — custa uma ida ao RCON por sorteio |
| anunciar na **conversão**, não no sorteio | §8.2 | baixo |
| a Via B (`OnLootEntity`) como alternativa com cooldown por jogador | §6.5 | **não medida** — o item pode aparecer piscando |
| o contador de `OnLootSpawn` no `origemz.item.diag` | §9.5, §10 | baixo |

---

## 12 — Perguntas em aberto para o dono

### Q1 — Via A ou Via B? ✅ **RESPONDIDA em 06/09/2026: as duas, combinadas**

> **A decisão do dono:** o sorteio acontece na **Via A** (`OnLootSpawn`), que é
> onde dá para inserir o item **já com a skin** — a única coisa que faz dele o
> nosso item (§4). A **Via B** (`OnLootEntity`) entra só como **portão**: é lá
> que existe jogador, e portanto é lá que o teto e o cooldown por pessoa podem
> ser aplicados.
>
> ####  A ARMADILHA QUE ESSA COMBINAÇÃO CRIA, E QUE PRECISA SER ESCRITA  ####
>
> Duas vias decidindo a mesma coisa é como as regras divergem. Para que isso
> **não** aconteça aqui, a divisão precisa ser de responsabilidade, e não de
> opinião:
>
> - a Via A decide **se nasce** — probabilidade, tipo de container, orçamento do
>   dia. É a única que cria o item;
> - a Via B **nunca cria nada**. Ela só decide **se aquele jogador pode levar**
>   — e, quando não pode, o item **permanece no container** para o próximo, em
>   vez de ser destruído. Destruí-lo gastaria o orçamento sem que ninguém
>   tivesse ganhado nada.
>
> Escrito de outro jeito: **a Via B não é uma segunda chance de sortear, é um
> filtro sobre o que a Via A já sorteou.** Se um dia alguém precisar mudar a
> raridade, há um lugar só para mexer.

O texto abaixo é o que sustentou a decisão.

O troféu deve nascer **quando o container nasce** (Via A, `OnLootSpawn`) ou
**quando alguém abre o container** (Via B, `OnLootEntity`)?

| | Via A | Via B |
|---|---|---|
| o troféu existe no mundo mesmo sem ninguém achar | sim | não |
| cooldown por jogador | **impossível** | possível |
| barril explodido espalha o troféu no chão | sim | não |
| risco de o jogador **ver** o item aparecer | não | **sim, não medido** |

**Bloqueia** as fatias 3 em diante: as duas vias têm código diferente e
denominadores diferentes.

### Q2 — A `source` do loot ✅ **RESPONDIDA em 06/09/2026: mantém `item:<id>`**

> **A decisão do dono:** o contrato do **[A§8.1]** fica como está. Nada muda no
> que já foi combinado e implementado, e o loot não ganha família própria.
>
> **A consequência, dita em voz alta:** a auditoria **não distingue** o ponto que
> veio de um barril do que veio da loja ou da mão do admin. A pergunta *"de onde
> vieram os 400 pontos do primeiro colocado?"* continua respondendo "de itens" —
> e não "340 da loja, 60 de barril".
>
> ####  E EXISTE UMA SAÍDA QUE NÃO MEXE NO CONTRATO  ####
>
> O §7.3 mediu que o Rust guarda `Item.ownershipShares` (`username` / `reason`),
> que é **salvo e transmitido** — e este plugin **já usa** esse campo para a
> descrição do item. Uma linha `ORIGEM: loot` gravada ali viaja com o item até a
> conversão, sem tocar em `source` nenhuma.
>
> Isso deixa a distinção **disponível** para o dia em que ela for pedida, ao
> custo de uma linha, e sem quebrar o contrato hoje. Fica registrado como
> caminho, não como decisão — a decisão é a de cima.

O texto abaixo é o que sustentou a decisão.

O **[A§8.1]** fixa `source = item:<id>`. Para a auditoria distinguir "veio da
loja" de "caiu do crate", a proposta era uma família nova, `loot:<id>` (§7.3).

### Q3 — Onde mora o teto: no agente ou no `oxide/data` do plugin?

No agente, o teto é da **rede** e sobrevive a tudo, mas custa uma ida ao RCON
por sorteio. No plugin, é local, mais barato, e some se o arquivo for apagado.
**Com um servidor só, os dois funcionam; com seis, a pergunta muda de sentido**
(§5.1).

### Q4 — Em quais containers? ✅ **SUPERADA em 06/09/2026: o admin escolhe, no painel**

> **A decisão do dono foi maior que a pergunta.** Em vez de fixar uma lista
> de containers neste documento, ele pediu **uma aba de loot no painel**: o
> agente extrai a configuração do jogo, ele edita e acrescenta o que quiser.
>
> Isso muda a natureza do trabalho e resolve, de quebra, a barreira do §4: se
> a configuração é **nossa**, aplicada pelo **nosso** plugin, ela pode carregar
> skin — e item custom no loot deixa de ser um truque para virar uso normal.
>
> O estudo dessa feature é o `05-EDITOR-DE-LOOT.md`. A pergunta abaixo fica
> como registro do que se sabia antes dela.

O texto abaixo é o que sustentou a decisão.

### Q4 — Em quais containers? **(BLOQUEANTE para a fatia 3)**

A recomendação é `crate_elite`, `crate_underwater_*`, `crate_normal*`,
`heli_crate`, `bradley_crate` e `supply_drop` — e **fora** os 400 barris de
estrada (§6.4). Confere com a intenção de *"só em zona de risco"*?

Um detalhe que decide junto: **quanto mais restrito o filtro, mais alta pode ser
a probabilidade** para o mesmo alvo semanal — e uma probabilidade mais alta é
uma mecânica que os jogadores **percebem** existir.

### Q5 — A semana seca ✅ **RESPONDIDA em 06/09/2026: aceitar o zero**

> **A decisão do dono:** sem piso. Uma semana sem troféu nenhum é o que "raro"
> significa — e é isso que faz o achado valer alguma coisa quando acontece.
>
> O piso foi recusado pelo motivo certo: ele **deixa de ser aleatório**. Vira um
> agendamento disfarçado, e os jogadores descobrem o padrão — "se não caiu
> essa semana, semana que vem cai" — que é o oposto de surpresa.

O texto abaixo é o que sustentou a decisão.

### Q5 — O alvo é mesmo 1 a 3 por semana? E o que fazer na semana seca?

Com `A = 2`, **13,5 % das semanas não têm troféu nenhum** (§6.3). Isso é
aceitável, ou o desenho precisa de um piso ("se a semana fechar em zero, o
próximo sorteio é garantido")?

Um piso é implementável e barato, mas ele **deixa de ser aleatório** — vira um
agendamento disfarçado. Vale a pena?

### Q6 — A linha `ORIGEM: loot` pode ficar visível ao jogador?

A procedência precisa viajar no item, e o lugar medido é o `ownershipShares` —
que o cliente **desenha no painel do item** (§7.2). Ela pode aparecer, ou
precisa ser escondida? (Escondê-la exigiria outro campo, e os que sobram já
estão em uso.)

### Q7 — O ranking ✅ **RESPONDIDA em 06/09/2026: métrica única**

> **A decisão do dono:** um ranking só, `trophy.bleik`, e o troféu vale o mesmo
> venha de onde vier. Isso **revoga** o `trophy.bleik.rare` que o
> `TROFEU_BLEIK_STORE.md:721` previa.
>
> Duas métricas dariam dois pódios para premiar — e com 2 troféus por semana o
> segundo teria três linhas, uma lista que quase sempre estaria vazia.

O texto abaixo é o que sustentou a decisão.

### Q7 — O troféu do loot soma no mesmo ranking do troféu da loja?

O **[T§6.5]** previu uma métrica separada, `trophy.bleik.rare`
(`TROFEU_BLEIK_STORE.md:721`). Este estudo recomenda **métrica única**
(`trophy.bleik`) com `source` diferente — assim o ranking é um só e a auditoria
continua separando.

Duas métricas dariam dois rankings, e um deles teria dois nomes por semana.

### Q8 — Medir antes de soltar ✅ **RESPONDIDA em 06/09/2026: sim, uma semana**

> **A decisão do dono:** a primeira fatia conta quantos containers nascem e são
> abertos de verdade neste servidor, **sem criar nada**. É o que troca a
> estimativa de 1.000–5.000 containers/dia do §6.3 por um número medido.
>
> Sem ela, a probabilidade de partida é um chute — e um chute que erra para
> mais raro, que é o erro menos ruim, mas ainda é um chute.

O texto abaixo é o que sustentou a decisão.

### Q8 — A fatia 1 (uma semana só contando, sem emitir nada) está autorizada?

Ela é o que substitui a estimativa do §6.3 por número. Sem ela, a probabilidade
de partida é um chute — que erra para mais raro, o que é o erro certo, mas ainda
é um chute.

---

## Referências

- [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md) — a marca
  `(base_shortname, skin_id)`, as três identidades, o portão da Facepunch
- [`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md) — por que o modelo é sempre
  emprestado
- [`03-ACAO-PONTOS-DE-RANKING.md`](03-ACAO-PONTOS-DE-RANKING.md) — a ação
  `points`, o `#OZSTAT#`, o ACK e a fila
- [`../TrofeuBleik/TROFEU_BLEIK_STORE.md`](../TrofeuBleik/TROFEU_BLEIK_STORE.md)
  — o briefing do troféu; **§6.5** é o ponto de partida deste estudo
- [`../Ranking/20-PLANO-E-CONTRATOS.md`](../Ranking/20-PLANO-E-CONTRATOS.md) — o
  esquema, os comandos e as rotas do ranking
- `Plugins/OrigemZItems.cs` — o plugin, e o único lugar onde a injeção vai morar
