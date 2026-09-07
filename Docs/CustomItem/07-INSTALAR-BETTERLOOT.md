# 07 — INSTALAR O BETTERLOOT: O PROCEDIMENTO, E A AUDITORIA QUE FECHOU A LISTA

> **O que este documento é.** O **procedimento de instalação** do BetterLoot com
> o `OrigemZLootRefresh`, executado em produção no `server01` em 06/09/2026 com
> o dono jogando, e a **auditoria completa** do que o plugin deixa de fazer
> quando cancela o `OnLootSpawn` — feita desmontando o `PopulateLoot()` e o
> `SpawnLoot()` inteiros e conferindo efeito por efeito contra a fonte dele.
>
> **O que este documento NÃO é.** Não é a substituição do
> [`06-INTEGRACAO-BETTERLOOT.md`](06-INTEGRACAO-BETTERLOOT.md), que continua
> sendo o estudo. Este é a operação e a lista fechada.
>
> **O estado em que o servidor ficou** (07/09/2026, 00h20 UTC).
> `OrigemZLootRefresh` **ligado** (da biblioteca) e agora consertando **três**
> efeitos, `OrigemZLootDiag` ligado, **BetterLoot desligado** e fora da pasta do
> servidor. Censo final: **6116 contêineres, `armed_pct=100.0`, `looted=0`,
> `full_no_free_slot=1276`** — todos os três dentro da faixa de um servidor que
> nunca viu o plugin.

---

## 0 — A lista fechada: tudo que o `OnLootSpawn` cancelado leva junto

> #### &nbsp;&nbsp;POR QUE ESTA TABELA EXISTE&nbsp;&nbsp; ####
>
> Até 06/09/2026 a conversa era "três defeitos e talvez mais". Um "talvez mais"
> não deixa ninguém decidir nada. Esta seção desmontou o `LootContainer::SpawnLoot`
> e o `LootContainer::PopulateLoot` **inteiros**, listou cada campo escrito e
> cada método chamado, e conferiu um por um contra `BetterLoot.cs`. O que sobrou
> é uma lista **fechada**: não há quarto defeito escondido no `PopulateLoot`,
> porque o `PopulateLoot` tem cinco efeitos e os cinco estão abaixo.

### 0.1 `LootContainer::SpawnLoot()` — o método que contém o hook

O IL, na ordem exata:

```
S1  if (IsDestroyed) return;
S2  if (inventory == null) { Debug.Log("CONTACT DEVELOPERS!..."); return; }
S3  inventory.Clear();
S4  ItemManager.DoRemoves(false);
S5  if (Interface.CallHook("OnLootSpawn", this) != null) return;   <-- o corte
S6  PopulateLoot();
S7  CancelLootRefreshCountdown();
S8  if (shouldRefreshContents) StartLootRefreshCountdown(null);
```

| # | efeito | cai com o hook? | o BetterLoot refaz? | consequência | consertável do nosso lado? |
|---|---|---|---|---|---|
| S3 | `inventory.Clear()` | **não** — roda antes | faz um segundo `Clear()` | **é este `Clear()` que acende `HasBeenLooted`** — o dano começa antes de qualquer plugin | n/a |
| S4 | `ItemManager.DoRemoves(false)` | não | — | — | n/a |
| S6 | `PopulateLoot()` | **sim** | ver §0.2 | ver §0.2 | ver §0.2 |
| S7 | `CancelLootRefreshCountdown()` | **sim** | não | **nenhuma isolada**: o `StartLootRefreshCountdown` começa chamando o `Cancel` (lido no IL), então rearmar já cobre | não precisa |
| S8 | `StartLootRefreshCountdown(null)` | **sim** | não | contêiner **nunca mais repopula** | **sim — feito** |

### 0.2 `LootContainer::PopulateLoot()` — desmontado inteiro

Cinco efeitos, e só cinco:

```
P1  FillLoot(inventory, lootDefinition, maxDefinitionsToSpawn, LootSpawnSlots);
P2  if (SpawnType == TOWN || SpawnType == ROADSIDE)
        foreach (item in inventory.itemList)
            if (item.hasCondition)
                item.condition = Random.Range(foundCondition.fractionMin,
                                              foundCondition.fractionMax) * condition.max;
P3  GenerateScrap();
P4  HasBeenLooted = false;
P5  FirstLooterId  = 0;
```

| # | efeito | o BetterLoot refaz? | consequência se não | consertável do nosso lado? |
|---|---|---|---|---|
| P1 | enche o inventário | **sim**, com a tabela própria | — | — |
| P2 | desgasta o item de cidade/estrada | **não** — ele aplica `Item Durability` (padrão **100/100**) a *todo* item com condição, em *todo* prefab | loot de `TOWN`/`ROADSIDE` sai **novo** em vez de gasto. É diferença de balanceamento, não de estado | sim, mas **é escolha do plugin**: mexer nisso é discordar do BetterLoot, não consertá-lo |
| P3 | gera o scrap | **sim** (`MinScrap`/`MaxScrap` nascem do `loot.scrapAmount` na autogeração) | — | — |
| P4 | `HasBeenLooted = false` | **NÃO** | **junkpiles despawnam** — 47 % do mundo em 6 min; e os puzzles de monumento **deixam de pausar** | **sim — feito** |
| P5 | `FirstLooterId = 0` | **NÃO** | depois da 1ª repopulação o contêiner nunca mais dá `AddClanScore` nem marca `SetItemOwnership` nos itens novos | **sim — feito** |

> **Como se sabe que a lista de leitores está completa.** Uma varredura de IL em
> todo o `Assembly-CSharp.dll` atrás de `ldfld`/`stfld` desses campos. `HasBeenLooted`
> tem **dois** leitores no jogo inteiro — `JunkPile::SpawnGroupsEmpty` e
> `PuzzleReset::HasPuzzleBeenPartialLooted` —, e **um** escritor que a apaga:
> o `PopulateLoot`. `FirstLooterId` tem três leitores: `OnStartBeingLooted`,
> `ResetState` e `Azure::OnEntityDestroyed` (telemetria da Facepunch).

### 0.3 Os sub-efeitos do `FillLoot` e do `LootSpawn::SpawnIntoContainer`

O `FillLoot` é estático e não escreve estado nenhum no contêiner — ele só cria
item. Ainda assim, o que ele faz **ao criar** vale conferir, porque o BetterLoot
cria os itens dele por conta própria:

| # | efeito do nativo | o BetterLoot refaz? | consequência |
|---|---|---|---|
| F1 | filtra `LootSpawnSlot.eras` contra `Server.Era` **em tempo de execução** | **congelado**: a tabela nasce da leitura do loot nativo naquele dia | mudar a era do servidor não muda mais o loot; é preciso regerar a tabela |
| F2 | `LootSpawn::EnsureFilterUpdated` (era + game mode ativo) | idem F1 | idem F1 |
| F3 | `spawnAsBlueprint` → cria `blueprintbase` com `blueprintTarget` | **sim** | — |
| F4 | limita o stack a `Mathf.Min(def.stackable, container.maxStackSize)` | **não** | stack acima do limite quando o contêiner tem `maxStackSize > 0`. Sem efeito nos prefabs deste servidor, que usam 0 (sem limite) |
| F5 | `item.OnVirginSpawn()` | **sim** (`BetterLoot.cs:1499`, `:1539`, `:2826`, `:2981`) | — |
| F6 | `SetItemOwnership` se o `ItemOwnershipShare` for válido | n/a — o `FillLoot` passa um share **inválido** | nenhuma |
| F7 | `MoveToContainer` → overflow → drop → `Remove` | **sim** (`:2647-2663`) | — |

### 0.4 O que o BetterLoot **acrescenta** — e que não é omissão

Isto não é efeito perdido; é efeito novo. Entra na lista porque quebra coisa
nossa do mesmo jeito:

| # | o que ele faz | consequência | consertável? |
|---|---|---|---|
| B1 | `container.capacity = itemList.Count` ao fim de cada população (`BetterLoot.cs:2666`) | **nenhum plugin insere item depois**. Medido: 40 de 40 contêineres recusaram um item pela mesma chamada que o `OrigemZItems::InjectLoot` usa. E **não sai quando o plugin sai** | sim, e com exatidão (`origemz.loot.diag capacity`) — mas **não automaticamente**, ver §3.5 |
| B2 | `FixLoot()` destrói contêineres empilhados | perda **permanente** (75 no 1º teste) | evitável pela config — ver §2.3 |

---

## 1 — O defeito que quase matou a adoção: metade dos contêineres do mundo

> #### &nbsp;&nbsp;MEDIDO AO VIVO, NÃO DEDUZIDO&nbsp;&nbsp; ####
>
> | Momento | Contêineres no mundo |
> |---|---|
> | antes de tudo | **6042** |
> | 1 min depois de o BetterLoot subir | 6090 |
> | 5 min depois | 3835 |
> | 6 min depois | **3211** — queda de **47 %** |
> | BetterLoot descarregado | 3794 → 4245 → 4558 → 5206 → 5860 |
> | 8 min depois de ele sair | **6166** — recuperado sozinho |
>
> Isto aconteceu com **`Remove Stacked Containers = false`** e com o
> `OrigemZLootRefresh` ativo e funcionando (30/30). **Não é o efeito conhecido
> dos contêineres empilhados** — o `FixLoot` não rodou, e o log prova (nenhuma
> das duas linhas que ele sempre escreve apareceu).
>
> **Consertado em 07/09/2026.** A mesma instalação, com o remendo do §1.3,
> ficou estável: ver a medição em §1.4.

### 1.1 A causa, elo por elo

Cada elo foi medido; nenhum é dedução.

| # | O elo | Onde foi medido |
|---|---|---|
| 1 | O BetterLoot limpa o contêiner antes de encher: `container.capacity = 36; container.Clear();` | `BetterLoot.cs:2351-2353`, no `PopulateContainer` com `clearContainer = true` (o default de `:2334`, e o caminho do `OnLootSpawn` em `:2335`) |
| 2 | **Toda remoção de item marca o contêiner como saqueado.** `LootContainer::OnItemAddedOrRemoved(item, bAdded)`, 19 bytes de IL: `if (bAdded) return; this.HasBeenLooted = true;` | IL, RVA `0x1f6ea0` |
| 3 | Quem desmarca é o `PopulateLoot()` nativo — e ele é **pulado**, porque o `OnLootSpawn` do BetterLoot devolve `true` | IL, RVA `0x1f70b4`; `BetterLoot.cs:1626` |
| 4 | **Um JunkPile despawna quando todos os `LootContainer` dos spawngroups dele têm `HasBeenLooted == true`** | IL de `JunkPile::SpawnGroupsEmpty`: `ldfld HasBeenLooted` dentro do laço sobre `SpawnInstances` |

O `UpdateInternals` do BetterLoot popula **o mundo inteiro de uma vez** no load
(`Populated (6041) supported loot containers`, no log). Ou seja: no primeiro
segundo, os 6041 contêineres passam a mentir que já foram saqueados, e os
junkpiles vão morrendo nos ciclos seguintes, levando as caixas junto.

**O padrão bate com a causa.** Caíram os prefabs que vivem em junkpile e
monumento — `loot_barrel_1` (1064 → 247), `loot_barrel_2` (1103 → 241),
`oil_barrel` (390 → 82), `vehicle_parts` (308 → 20), `crate_tools` (320 → 103).
Ficaram intactos os de mundo aberto puro — `roadsign*`, `trash-pile-1`,
`loot-barrel-1/2` do `autospawn/resource/loot`, `beehive.natural`, `crate_mine`.

### 1.2 O que isso significa para quem for instalar

**O dano é transitório**: o SpawnHandler repõe tudo em ~8 min depois que o
plugin sai. **Mas ele é permanente enquanto o plugin está no ar** — o servidor
opera com metade dos contêineres, e nada aparece no log.

### 1.3 O conserto, e o que ele descobriu no caminho

O `OrigemZLootRefresh` passou a devolver **os três** efeitos de estado, e não só
o cronômetro. Mas o conserto óbvio — `HasBeenLooted = false` no mesmo `NextTick`
do rearme — **não teria funcionado sozinho**, e o motivo é a descoberta que
faltava:

> #### &nbsp;&nbsp;O HOOK NÃO VÊ A POPULAÇÃO QUE CAUSA O ESTRAGO&nbsp;&nbsp; ####
>
> O `UpdateInternals` do BetterLoot popula o mundo inteiro no `NextTick` do
> próprio load chamando o `PopulateContainer` dele **diretamente**
> (`BetterLoot.cs:2697-2706`). Isso não passa pelo `LootContainer::SpawnLoot`
> e, portanto, **não dispara o `OnLootSpawn`**.
>
> Ou seja: nas 6027 populações do boot o nosso hook **não é chamado nenhuma
> vez**, e são exatamente elas que marcam o mundo todo de uma vez. Um conserto
> só-no-hook teria consertado o regime permanente e deixado passar a causa da
> queda de 47 %.
>
> Medido no log do servidor, 07/09/2026:
>
> ```
> 21:02 [BetterLoot] Populated (6027) supported loot containers.
> 21:02 [OrigemZLootRefresh] sweep: entities=92417 containers=6095 refreshable=6095
>                            healed=0 unmarked=6002 marked_but_empty=0 ms=9.9
> ```
>
> **`healed=0` e `unmarked=6002` na mesma linha.** É o retrato exato do defeito:
> o `UpdateInternals` **não** derruba cronômetro (ele não passa pelo `SpawnLoot`,
> que é quem cancela) e marca **tudo**. Por isso o remendo antigo, que só olhava
> o cronômetro, achava o boot saudável enquanto o mundo caía.

Daí o conserto ter duas camadas:

| camada | o que cobre | como |
|---|---|---|
| **hook + `NextTick`** | toda população que passa pelo `SpawnLoot` — o regime permanente | limpa marca e `FirstLooterId`, rearma cronômetro. **Exato**: naquele instante o contêiner acabou de ser enchido, e `HasBeenLooted = false` é literalmente a penúltima linha do `PopulateLoot` |
| **sweep automático** | o `UpdateInternals`, que o hook não vê | dispara 10 s depois de **qualquer** plugin carregar (`OnPluginLoaded`), com *debounce* por geração para não varrer 13 vezes no boot |

> **A trava do sweep, e por que ela é diferente da do hook.** No hook sabemos
> que houve população. No sweep, não: um contêiner marcado pode ter sido
> esvaziado por um jogador de verdade. Então **o sweep só limpa a marca de
> contêiner que tem item dentro** — `marked_but_empty` na saída é quantos ele
> deixou em paz de propósito.
>
> E mesmo se errasse: o `JunkPile::TimeOut` despawna o junkpile
> **incondicionalmente** (lido no IL — ele só adia enquanto houver jogador
> perto). O `SpawnGroupsEmpty` é o atalho "já foi saqueado, pode ir antes", não
> a única saída. Ou seja, **não há acúmulo possível de junkpile** por causa
> deste remendo; o pior caso é um junkpile viver até o timeout.

### 1.4 A prova: o mundo com o BetterLoot ligado e o conserto agindo

Três séries, o mesmo servidor, o mesmo dia, o dono jogando nas três.

| série | amostras | contêineres | amplitude | veredito |
|---|---|---|---|---|
| **base**, sem BetterLoot | 9 / 8 min | 6149 · 5644 · 5748 · 5852 · 5897 · 5905 · 5836 · 5845 · 5903 | **505** (8,2 %) | oscila sem direção |
| **BetterLoot sem o conserto** (06/09) | 4 / 6 min | 6042 · 6090 · 3835 · **3211** | **2879** (47 %) | queda **monotônica** |
| **BetterLoot com o conserto** (07/09) | 15 / 11 min | 6100 · 6143 · 6171 · 6173 · 6180 · 6182 · 6182 · 6182 · 6178 · 6181 · 6181 · 6177 · 6171 · 6157 · 6122 | **82** (1,3 %) | **estável** |

> #### &nbsp;&nbsp;COMO SE DISTINGUE A OSCILAÇÃO DA QUEDA&nbsp;&nbsp; ####
>
> O total oscila sozinho pelo ciclo de spawn do jogo, então "caiu" não basta.
> Quatro critérios separam os casos, e os quatro batem:
>
> 1. **Amplitude.** A oscilação natural mediu **505** contêineres de pico a vale.
>    A queda mediu **2879** — quase **6×** o maior movimento natural observado.
> 2. **Direção.** A base sobe e desce sem tendência (desce, sobe, sobe, sobe,
>    sobe, desce, sobe, sobe). A queda é **monotônica**: cada amostra abaixo da
>    anterior, sem uma única recuperação em 6 min.
> 3. **Onde a série mora.** Com o conserto, o **pior** ponto (6100) ficou acima
>    de **8 dos 9** pontos da linha de base, e a amplitude caiu para 82 — a série
>    consertada é **6× mais estável que a própria base**. Não é "não caiu": é
>    "não se mexeu".
> 4. **A causa medida junto com o efeito.** Esta é a que decide, e é o que o
>    censo novo trouxe: **`looted=`**, o número de contêineres com a marca
>    presa. Sem o conserto ele vai a ~6000 no primeiro segundo — o
>    `unmarked=6002` do sweep é literalmente esse número. Com o conserto ficou
>    em **`looted=0` nas 15 amostras**, do primeiro ao último minuto.
>
> O item 4 é o que torna a prova barata **e repetível**: não é preciso derrubar o
> mundo de novo para mostrar que o remendo funciona — basta mostrar que **a causa
> não existe mais**, e o censo mede a causa diretamente. Quem repetir isto num
> segundo servidor não precisa arriscar 47 % do mapa para saber a resposta.

E os contadores do próprio remendo, no mesmo período:

```
spawns=46  already_armed=1  rearmed=45  unmarked=42  first_looter_reset=0
```

Ou seja: sob o BetterLoot, **98 % das populações perdem o cronômetro e a marca**,
e as duas coisas são devolvidas. `first_looter_reset=0` porque quem repopula no
regime é barril de mundo aberto, que ninguém abriu ainda — o campo só sobe em
contêiner que já teve um primeiro saqueador.

Custo medido: **9,9 ms** para o sweep varrer 92 417 entidades, e **3,9 µs por
população** no caminho do hook.

### 1.5 A prova de que o remendo não inventa trabalho

A pergunta que sempre volta sobre remendo: *e quando o plugin que causava o
problema sai — ele fica mexendo em contêiner à toa?*

Medido no mesmo contador, antes e depois do `oxide.unload BetterLoot`:

| janela | Δ spawns | Δ already_armed | Δ rearmed | Δ unmarked | precisou de conserto |
|---|---|---|---|---|---|
| **com o BetterLoot no ar** (6 min) | +288 | **+6** | **+282** | **+207** | **97,9 %** |
| **depois que ele saiu** (20 min) | +1497 | **+1492** | **+5** | **+5** | **0,3 %** |

**O resultado se inverte no minuto em que o plugin sai.** Com ele no ar, 97,9 %
das populações perdiam o cronômetro e eram consertadas; sem ele, 99,7 % já vêm
corretas e o remendo não encosta em nada — é o `PopulateLoot` nativo fazendo o
trabalho dele, e o remendo enxergando isso e saindo de perto.

> Essa é também a forma de saber que o remendo **virou desnecessário** — no dia
> em que o BetterLoot for embora de vez, `rearmed` e `unmarked` param de subir e
> o `already_armed` acompanha o `spawns`. Nada mais precisa ser desinstalado.

---

## 2 — O procedimento, na ordem

Vale quando o bloqueio do §1 estiver resolvido. A ordem **não** é preferência:
cada passo existe por causa de um jeito medido de estragar o servidor.

### 2.1 Censo antes, e guarde o número

```
origemz.loot.diag
```

Guarde `containers=` e `armed_pct_of_refreshable=`. Sem esse número não há como
afirmar depois que nada foi perdido — e o §1 mostra que a perda é justamente o
que ninguém percebe.

### 2.2 O conserto PRIMEIRO — e confirme que carregou

```
copie Plugins/OrigemZLootRefresh.cs  ->  Servers/<id>/oxide/plugins/
oxide.load OrigemZLootRefresh
origemz.loot.refresh          -> tem de dizer  estado=ativo
```

**Ele precisa estar de pé antes de o BetterLoot começar a cancelar hooks.** Um
contêiner populado no intervalo entre um e outro nasce sem cronômetro e não se
conserta sozinho: ninguém mais vai chamar `SpawnLoot` nele. (O `sweep` de boot
do próprio plugin recolhe os órfãos, mas só quando ele sobe — não depois.)

Num servidor sem plugin que cancele o hook, `estado=ativo` com `rearmed=0` é o
resultado certo: ele não toca em nada.

### 2.3 A configuração ANTES do plugin

> #### &nbsp;&nbsp;`Remove Stacked Containers = false`, E ANTES DO PRIMEIRO BOOT&nbsp;&nbsp; ####
>
> Com `true` — que é o **default** do plugin — ele **destrói contêineres
> empilhados, e isso não volta**. Foram 75 no primeiro teste de 06/09/2026.
>
> O `FixLoot` roda no `NextTick` do load (`BetterLoot.cs:2698-2699`), ou seja,
> **milissegundos depois** de o `.cs` entrar na pasta. Escrever a configuração
> "logo em seguida" não é rápido o bastante.

Escreva `Servers/<id>/oxide/config/BetterLoot.json` **antes** de copiar o `.cs`:

```json
{
  "General Configuration": {
    "Remove Stacked Containers": false
  }
}
```

**Um arquivo parcial basta**, e isto é medido: `LoadConfig` desserializa em cima
dos defaults do construtor e o `MaybeUpdateConfigDict` (`:377-407`) só
*acrescenta* de volta o que faltava. O que você escreveu é respeitado; o resto
nasce com o padrão.

### 2.4 O plugin, e a autogeração

```
copie Plugins/<id>/BetterLoot.cs  ->  Servers/<id>/oxide/plugins/
oxide.load BetterLoot
```

No `oxide/logs/oxide_<data>.txt` a autogeração terminou quando aparecerem, nesta
ordem:

```
[BetterLoot] Saved LootTables.json
[BetterLoot] Using 'N' active of 'M' supported container types
[BetterLoot] Updating internals ...
Loaded plugin BetterLoot v4.4.0
[BetterLoot] Populated (N) supported loot containers.
```

**Confira que NÃO apareceu** `Removed N stacked LootContainer`. Se apareceu, a
configuração do §2.3 chegou tarde e o estrago já está feito.

A tabela nasce com ~2,6 MB e 111 prefabs, gerada do loot nativo daquele servidor.

### 2.5 A prova de que o conserto está agindo

**Duas medidas, e as duas são obrigatórias.** Uma sozinha engana.

```
origemz.loot.diag arm 30
origemz.loot.diag read
```

Tem de dar **`armed_after=30`** e `VEREDITO: REFRESH INTACTO`.

> **Por que não o `probe` de um comando só.** Ele lê o resultado no mesmo frame
> do `SpawnLoot`, e o conserto age no `NextTick` — o `probe` dá "REFRESH MORTO"
> com o conserto ativo e funcionando. O par `arm`/`read` põe vários frames entre
> a pergunta e a resposta. O cabeçalho do `OrigemZLootDiag.cs` conta a história.

E o contador, **antes e depois** do par:

```
origemz.loot.refresh
```

Com o BetterLoot ativo, o padrão certo é `rearmed` subir **na mesma medida que
`spawns`**, com `already_armed` **parado**. Foi o que se mediu em 06/09/2026:

| | spawns | already_armed | rearmed |
|---|---|---|---|
| antes do par | 169 | 78 | 91 |
| depois do par | 231 | **78** | 153 |
| delta | **+62** | **0** | **+62** |

Ou seja: **100 % das populações sob o BetterLoot perdem o cronômetro, e 100 %
delas são rearmadas pelo conserto.**

**Se der `armed_after=0`, reverta na hora** — `oxide.unload BetterLoot` — e não
siga adiante.

### 2.5.1 E a segunda prova, que é a que o §1 custou a achar

O par `arm`/`read` mede **o cronômetro**. Ele não vê a marca de saqueado — e foi
a marca que derrubou metade do mundo em 06/09/2026 enquanto o cronômetro
mostrava 30/30. As duas medidas abaixo são **obrigatórias**:

```
origemz.loot.diag
```

> **`looted=` tem de ser 0** (ou perto). Qualquer número na casa dos milhares é o
> defeito do §1 acontecendo agora, e o servidor perde contêiner enquanto você lê.

E no log do Oxide, logo depois de o BetterLoot carregar, as duas linhas têm de
aparecer **em par**:

```
[BetterLoot] Populated (N) supported loot containers.
[OrigemZLootRefresh] sweep: ... unmarked=N-ish marked_but_empty=0 ...
```

**Se a linha do sweep não apareceu**, o remendo do `OrigemZLootRefresh` não está
na versão que conserta a marca (ele grita só quando encontra o que consertar, e
no boot com o BetterLoot ele sempre encontra). Confira que
`origemz.loot.refresh` mostra a linha `unmarked=` — versão sem ela é a antiga.

### 2.6 Censo final, sempre com `heal` antes

```
origemz.loot.diag heal
origemz.loot.diag
```

O `heal` recolhe qualquer órfão nascido no intervalo entre um passo e outro;
`healed=0` é o resultado que se quer. O censo tem de fechar em
`armed_pct_of_refreshable=100.0`, `looted=0`, e `containers=` não pode ter
caído **fora da faixa da oscilação natural** — que neste servidor mediu
**5644 a 6149** em 8 min sem plugin nenhum. Um número dentro dessa faixa é
ruído; abaixo dela, e caindo a cada leitura, é o §1.

**Rode o `heal` antes de encerrar, sempre** — inclusive quando tudo deu certo, e
principalmente quando alguém rodou `arm` e esqueceu o `read`.

### 2.6.1 E, ao DESINSTALAR, mais um comando

```
oxide.unload BetterLoot
origemz.loot.diag capacity     <-- este
origemz.loot.diag heal
origemz.loot.diag
```

O `capacity` devolve a capacidade que o BetterLoot fechou e que **não volta
sozinha** — nem descarregando o plugin, nem esperando o contêiner repopular.
Ver §3.5. Sem ele o servidor fica com ~99 % dos contêineres recusando qualquer
inserção, e é um estado que atravessa o restart do plugin.

### 2.7 Guarde a configuração que nasceu

O BetterLoot nasce com a tabela autogerada, e ela é o retrato do loot **daquele**
servidor naquele build do jogo. Copie os quatro arquivos para
`Backups/<id>/betterloot-config-inicial-<data>/`:

```
oxide/config/BetterLoot.json
oxide/data/BetterLoot/LootTables.json
oxide/data/BetterLoot/LootGroups.json
oxide/data/BetterLoot/Blacklist.json
```

Do 06/09/2026 há duas cópias: `betterloot-gerado-2026-09-06_19-35-21`
(com `Remove Stacked Containers = true`, do primeiro teste) e
`betterloot-config-inicial-2026-09-06_20-21` (**a boa**, com `false`).

---

## 3 — Quando o contador de rearmes parar de subir

É o sinal de que o remendo ficou mudo, e ele tem **três causas possíveis**. O
próprio `origemz.loot.refresh` distingue as três:

| O que a saída diz | O que aconteceu | O que fazer |
|---|---|---|
| `estado=DESLIGADO (actionSpawnLoot ...)` | um update do Rust renomeou o membro privado que o plugin alcança por reflexão | conferir os nomes no `Assembly-CSharp.dll` e corrigir o `ResolveReflection`. **Enquanto isso, tire o BetterLoot do ar** — sem o conserto ele degrada o servidor em silêncio |
| `estado=ativo`, `spawns` parado | o hook não está mais sendo chamado: o plugin caiu, ou não está na pasta | `oxide.plugins` e `oxide.load OrigemZLootRefresh` |
| `estado=ativo`, `spawns` sobe e `rearmed=0` com `already_armed` subindo junto | **está tudo bem** — ninguém está cancelando o `OnLootSpawn`. É o resultado esperado num servidor **sem** BetterLoot | nada |

> **A confusão que a terceira linha evita.** `rearmed=0` parece defeito e é o
> contrário: é o remendo dizendo que não há o que remendar. O que separa "não
> precisa" de "não está funcionando" é o `already_armed`: se ele sobe junto com
> `spawns`, o plugin está vendo as populações e achando todas armadas.

E, independente do contador, a pergunta final é sempre o censo:

```
origemz.loot.diag
```

`armed_pct_of_refreshable` abaixo de 100 % é contêiner parado no mundo. O
`origemz.loot.refresh sweep` (ou o `heal` do diag) recolhe.

### 3.1 Quando o contador de marcas parar de subir

Mesma lógica, campo diferente. `unmarked` é o conserto do §1, e ele tem uma
leitura a mais que o `rearmed` não tem:

| O que a saída diz | O que aconteceu | O que fazer |
|---|---|---|
| `unmarked` sobe junto com `spawns` | **normal com o BetterLoot no ar** — 98 % das populações perdem a marca e as 98 % são devolvidas | nada |
| `unmarked=0` com `spawns` subindo | **normal SEM plugin que cancele** — o `PopulateLoot` nativo roda e limpa a marca sozinho | nada |
| `unmarked=0`, `spawns` subindo, **e `looted=` no censo subindo** | o remendo está mudo enquanto o dano acontece. É a combinação que não pode existir | `oxide.unload BetterLoot`, e confira a versão do `OrigemZLootRefresh` |
| `marked_but_empty` alto no sweep | contêineres marcados **e vazios** — o sweep os deixou em paz de propósito (podem ser saques legítimos). Se for às centenas com o BetterLoot no ar, o `UpdateInternals` populou e alguém esvaziou tudo em seguida | investigar antes de mexer; não force |

> **O par que decide é `unmarked` + `looted`.** O primeiro é quanto o remendo
> trabalhou; o segundo é quanto sobrou por consertar. `looted=0` com `unmarked`
> subindo é o retrato de saúde sob o BetterLoot.

---

## 3.5 — A capacidade: consertável, mas de propósito não automático

> #### &nbsp;&nbsp;MEDIDO: 40 DE 40 CONTÊINERES RECUSAM O ITEM&nbsp;&nbsp; ####
>
> ```
> origemz.loot.diag insert 40
>
> amostra=40 coube=0 recusado=40 sem_slot_livre_antes=40 falhou_criar=0
> VEREDITO: CAPACIDADE FECHADA - 40 de 40 recusaram o item.
> ```
>
> A sonda faz **exatamente** a chamada que o `OrigemZItems::InjectLoot` faz —
> `MoveToContainer(inventory, -1, true, false, null, true)` — com um item barato,
> e desfaz em seguida. E o censo mostra o mesmo em escala: contêineres sem slot
> livre saltaram de **1723 de 6100 (28 %)** para **6106 de 6181 (98,8 %)** no
> minuto em que o BetterLoot subiu.

**A consequência é concreta, não hipotética.** O `OrigemZItems` já tem a Via A
implementada e rodando: o `OnLootSpawn` sorteia e o `InjectLoot` insere o troféu
no `NextTick`. Com o BetterLoot no ar, **essa via morre em silêncio** — o
`MoveToContainer` falha, o `LootRefund` devolve o orçamento do dia, e nem o
contador acusa (`Spawned` volta a zero). Ninguém veria nada no log.

### O dano NÃO sai quando o plugin sai

> #### &nbsp;&nbsp;MEDIDO: DESCARREGAR O BETTERLOOT NÃO DEVOLVE A CAPACIDADE&nbsp;&nbsp; ####
>
> | momento | `full_no_free_slot` | sonda |
> |---|---|---|
> | antes do BetterLoot | 1723 de 6100 (28 %) | — |
> | com o BetterLoot no ar | 6106 de 6181 (98,8 %) | 0 de 40 aceitaram |
> | **depois do `oxide.unload`** | **6072 de 6149 (98,7 %)** | **0 de 40 aceitaram** |
>
> Nada desfaz: o `PopulateLoot` nativo não mexe em `capacity`, e o
> `CreateInventory` — que é quem a define — só roda quando a entidade nasce. É a
> mesma família dos órfãos de cronômetro: **um estado que sobrevive à remoção do
> plugin e não se conserta sozinho**.

**Mas ele é reversível com exatidão**, e o IL diz por quê:

```
StorageContainer::CreateInventory:
    ...
    inventory.ServerInitialize(null, this.inventorySlots)
```

A capacidade original vem de `StorageContainer.inventorySlots`, um campo **do
prefab** que o BetterLoot nunca escreve — ele só mexe no `capacity` do
`ItemContainer`. Então dá para restaurar o valor certo de cada contêiner, e não
chutar 36 para todos.

```
origemz.loot.diag capacity
```

Medido no `server01` em 07/09/2026, logo depois de descarregar o plugin:

```
scanned=6083 repaired=4631 already_ok=1452 sem_inventorySlots=0 slots_devolvidos=19630
```

E a sonda logo em seguida: **38 de 40 aceitaram** (contra 0 de 40 antes). As 2
recusas são contêineres que o `FillLoot` nativo encheu — a linha de base normal.

> **O comando não roda sozinho, e é de propósito.** Fechar a capacidade é escolha
> do BetterLoot; desfazê-la a cada população seria brigar com ele a cada
> contêiner. O `capacity` existe para **o depois** — quando o plugin sai e o
> servidor fica com o mundo inteiro fechado. **Rode-o sempre que descarregar o
> BetterLoot**, junto com o `heal`.

### Por que ele NÃO entrou no `OrigemZLootRefresh`

**Porque não é um efeito perdido; é uma escolha do BetterLoot.** Os outros três
defeitos são coisas que o `PopulateLoot` fazia e ninguém refez. Este é o
contrário: é uma linha que o BetterLoot **acrescenta de propósito**
(`capacity = itemList.Count`, `BetterLoot.cs:2666`), e a intenção aparece nos
comentários dele nos outros dois lugares onde mexe em capacidade —
`container.capacity = 36; // For viewing purposes`. Ele fecha a capacidade para
o jogador ver uma caixa justa, sem slots vazios.

Devolver a capacidade no `OrigemZLootRefresh` mudaria **a aparência de todo
contêiner do servidor** para desfazer uma decisão estética de um plugin de
terceiro. Isso não é consertar, é discordar — e um plugin chamado
"LootRefresh" não é o lugar de discordar.

### Onde o conserto pertence, se o dono quiser a Via A

Em quem insere. Uma linha no `OrigemZItems::InjectLoot`, antes do
`MoveToContainer`:

```csharp
// O BetterLoot fecha capacity = itemList.Count ao fim de cada
// populacao. Abrir UM slot devolve o espaco de que este item
// precisa sem desfazer a caixa justa que o plugin quis.
if (inventory.capacity <= inventory.itemList.Count)
{
    inventory.capacity = inventory.itemList.Count + 1;
}
```

Isso abre um slot **só quando há item a inserir**, e só naquele contêiner — o
custo estético fica restrito aos contêineres que de fato ganharam um troféu.

> **Mas a saída mais barata continua sendo a que o dono já escolheu**: pôr o
> troféu **na tabela do BetterLoot**. Aí ele nasce junto com o resto do loot,
> dentro da contagem de itens do plugin, e a capacidade nunca é problema. A Via
> A do `OrigemZItems` só volta a fazer falta se o troféu precisar de regra que a
> tabela do BetterLoot não expressa — teto diário, por exemplo.

---

## 3.6 — O que NÃO é consertável do nosso lado

Fechando a lista com todas as letras — é a informação que decide se o BetterLoot
continua:

| o quê | por que não dá | quanto dói |
|---|---|---|
| **P2 — o desgaste do item de cidade/estrada** | Não é omissão de estado: o BetterLoot tem um sistema próprio de durabilidade (`Item Durability`, padrão 100/100 por item) e ele **roda**. Sobrescrever a condição depois seria brigar com o plugin a cada população, e a tabela dele deixaria de descrever o que sai da caixa | **baixo, e é balanceamento**: loot de `TOWN`/`ROADSIDE` sai novo em vez de gasto. Quem quiser o desgaste ajusta `Item Durability` na tabela — o plugin expõe isso |
| **F1/F2 — o filtro de era em tempo de execução** | A tabela do BetterLoot é um **retrato** do loot nativo do dia em que foi gerada. Não há como fazê-la reagir a `Server.Era` sem regerar | **baixo**: só importa em servidor que troca de era. Se trocar, regere a tabela (§2.7) |
| **F4 — o teto de stack por contêiner** | O BetterLoot cria o item com a quantidade da tabela e não consulta `container.maxStackSize` | **nenhum neste servidor**: os prefabs daqui usam `maxStackSize = 0` (sem limite), então o clamp nativo também não agiria |
| **B2 — os contêineres empilhados destruídos** | O `FixLoot` roda no `NextTick` do load; quando dá para reagir, já foi | **alto, e permanente** — mas **100 % evitável** pela config, e a config já está certa (§2.3) |

> **B1 não está nesta tabela**, e é a correção mais importante do dia: a
> capacidade *é* consertável, e com exatidão — ver §3.5. O que se decidiu foi
> **onde** consertar, não *se* dá.

**Nada nesta lista bloqueia a adoção.** O que bloqueava — a marca de saqueado —
está consertado e medido. O que sobra é balanceamento (ajustável na tabela do
próprio plugin), uma limitação de servidor que troca de era, um clamp sem efeito
aqui, e um risco que a configuração já neutraliza.

---

## 4 — O que ficou no acervo, e por quê

| Plugin | Onde | Estado | Por quê |
|---|---|---|---|
| `OrigemZLootRefresh` | **biblioteca** (`Plugins/`) | ligado no `server01` | o defeito que ele conserta não é do `server01`: é de qualquer servidor onde um plugin cancele o `OnLootSpawn`. Na biblioteca, ele atravessa o wipe e aparece para os outros servidores |
| `OrigemZLootDiag` | custom (`Plugins/server01/`) | ligado | ferramenta de medição, não de operação. Não faz sentido na tela de rede |
| `BetterLoot` | custom (`Plugins/server01/`) | **desligado** | ver abaixo — mas o motivo mudou: o §1 deixou de ser bloqueio |

> #### &nbsp;&nbsp;POR QUE O BETTERLOOT ENTROU NO ACERVO MESMO SENDO DE TERCEIRO&nbsp;&nbsp; ####
>
> Porque o acervo não é uma lista de coisas aprovadas — é onde o agente guarda o
> `.cs` que aquele servidor pode ligar, e é o que sobrevive ao wipe. Deixá-lo só
> no disco do servidor era o mundo de antes do `PluginLibrary`.
>
> Ele entrou como **custom do `server01`**, e não na biblioteca, por dois
> motivos que continuam de pé: é **de terceiro sem licença** (§8.2 do `06`) e
> está **em estudo**. Custom é exatamente isso — *"o teste que não vai para os
> outros"*, como diz o cabeçalho do `core/src/oxide/library.ts`.
>
> **O terceiro motivo caiu.** Até 06/09/2026 o §1 deste documento era razão para
> ninguém ligá-lo por engano. Em 07/09/2026 o defeito foi consertado e medido: a
> mesma instalação rodou 11 min com o mundo estável. O que segura o BetterLoot
> hoje é só a decisão do dono sobre quando adotá-lo — não um defeito aberto.
>
> **Desligado, ele não corre.** O `.cs` não está em
> `Servers/server01/oxide/plugins/`, e a adoção só liga o que está na pasta.

A configuração dele **não** foi apagada do servidor: `oxide/config/BetterLoot.json`
(com `Remove Stacked Containers = false`) e `oxide/data/BetterLoot/` continuam
lá. É a política do projeto — *"desligar não pode custar a configuração"* — e
aqui ela também é proteção: no dia em que alguém religar o plugin, a chave que
destrói contêineres já está em `false`.
