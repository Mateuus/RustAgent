# 19 — Pesquisa: o RANKING

> **O que este documento é.** Uma pesquisa técnica sobre como construir o
> ranking (leaderboard) do RustAgent: de onde vem cada número, por onde ele
> viaja, onde ele é guardado, como ele é somado por servidor e pela rede, e o
> que quebra em cada uma dessas quatro etapas. Ele termina numa **proposta de
> desenho** — com esquema de banco, contrato de plugin, rotas e fórmulas — e
> num plano de implementação em fatias.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. Nenhuma
> linha do que está aqui existe na árvore. Nada foi compilado, nada foi medido
> contra servidor de verdade. O §15 separa, item a item, o que foi **medido**,
> o que foi **conferido** e o que é **projeto**.

---

## Índice

| § | Assunto |
|---|---|
| [1](#1--sumário-executivo) | Sumário executivo: a decisão em uma página |
| [2](#2--o-estado-de-hoje-no-repositório) | O estado de hoje no repositório |
| [3](#3--o-que-o-jogo-entrega-e-por-onde) | O que o jogo entrega, e por onde |
| [4](#4--farm-de-mineração) | Farm de mineração |
| [5](#5--farm-de-explosivo) | Farm de explosivo |
| [6](#6--kd) | K/D |
| [7](#7--long-shot) | Long shot |
| [8](#8--volume-transporte-e-perda) | Volume, transporte e perda |
| [9](#9--o-modelo-de-dados-no-agente) | O modelo de dados no agente |
| [10](#10--a-api) | A API |
| [11](#11--as-telas) | As telas (painel e jogo) |
| [12](#12--pontuação-janelas-e-temporadas) | Pontuação, janelas e temporadas |
| [13](#13--anti-abuso-e-integridade) | Anti-abuso e integridade |
| [14](#14--o-que-o-mercado-faz) | O que o mercado faz (benchmark) |
| [15](#15--riscos-e-o-que-não-foi-validado) | Riscos e o que **não** foi validado |
| [16](#16--plano-de-implementação) | Plano de implementação |
| [17](#17--fontes) | Fontes |

---

## 1 — Sumário executivo

### 1.1 O pedido

Quatro rankings, guardados **no agente**, visíveis em dois escopos:

| Ranking | Pergunta que ele responde |
|---|---|
| **Farm de mineração** | quem tirou mais minério do chão |
| **Farm de explosivo** | quem produziu mais poder de raid |
| **Kill / K/D** | quem mata mais, e quem morre menos |
| **Long shot** | quem deu o tiro mais longe |

E dois escopos: **por servidor** (`pvp1` tem o ranking dele) e **global** (a
soma da rede). A janela de tempo é uma terceira dimensão que o pedido não cita
mas que o produto exige — ver §12.

### 1.2 As cinco conclusões que mandam no desenho

**1. O RCON não entrega nada disso.** `playerlist` dá quem está online;
`serverinfo` dá o mundo; `chat.tail` dá a conversa. Kills, minério e distância
de tiro **não existem em comando nenhum**. O `combatlog`, que teria metade da
resposta, **não funciona por RCON** — só pelo console F1 do jogo
([Corrosion Hour][ch-combatlog]). Ou seja: **ou o plugin coleta, ou não há
ranking.** Isso não é opinião nova — é o que o [`06-API.md`][api] já diz na
seção "o que não existe nesta API".

**2. O dado nasce em hook, e hook de coleta é de altíssima frequência.**
`OnDispenserGather` dispara **a cada golpe de picareta** ([OxideMod][ox-gather]).
Mandar um evento de RCON por golpe é inviável: cem jogadores farmando produzem
milhares de linhas por minuto, num transporte cujo teto de frame foi **medido em
~70 KB** neste projeto (ver `core/src/game/plugin-push.ts`). **O plugin agrega;
o agente busca o agregado.** Esta é a decisão estrutural do documento inteiro
(§8).

**3. Contador e feito são coisas diferentes, e pedem tabelas diferentes.**
"Enxofre minerado" é um número que só cresce — cabe num contador. "O tiro de
412 m com a Bolt Action na cabeça do Fulano, às 21h04, no G12" é um **fato com
testemunho**, e um contador o destrói. O ranking de long shot é do segundo
tipo; os outros três são do primeiro (§9).

**4. Somar servidores só é honesto entre servidores comparáveis.** Um servidor
5x e um servidor 1x produzem números que não se comparam: o ranking global de
mineração seria a lista de quem jogou no servidor de maior taxa. O global
precisa ou **normalizar pela taxa de coleta**, ou **restringir-se às métricas
que não dependem dela** (K/D e long shot). O §12.4 propõe as duas saídas e
recomenda uma.

**5. O ranking é a superfície de abuso mais óbvia que este projeto já teve.**
Kill farming com alt, dupla contando explosivo dado pela loja, tiro "longo"
depois de um teleporte do painel. Nenhuma dessas some sozinha, e todas fazem a
tela mentir. O §13 lista os sinais e recomenda o que o mercado faz: **marcar e
mandar para revisão humana, nunca punir sozinho.**

### 1.3 A tabela-resumo

| Ranking | Fonte (hook) | Unidade | Frequência do evento | Onde ele erra |
|---|---|---|---|---|
| Mineração | `OnDispenserGather` + `OnDispenserBonus` + `OnCollectiblePickup` | unidades de minério bruto, e um índice ponderado | **altíssima** (por golpe) | quarry/excavator sem dono; taxa de coleta; fundição contada duas vezes |
| Explosivo | `OnItemCraftFinished` (+ `OnExplosiveThrown`, `OnRocketLaunched`) | **enxofre equivalente** (SEQ) | baixa | item vindo da loja/kit/`give`; craft cancelado; tabela de custo desatualizada |
| K/D | `OnPlayerDeath` / `OnEntityDeath` | kills, deaths, e um K/D com encolhimento | média | NPC, armadilha, queda, fome, suicídio, team kill, sleeper |
| Long shot | `OnPlayerDeath` (`HitInfo`) | metros | baixa | ricochete, teleporte, arma explosiva, admin em noclip |

---

## 2 — O estado de hoje no repositório

Antes de propor, o que já existe — porque metade do trabalho está feito e a
outra metade tem dono declarado.

### 2.1 O que já está pronto e vai ser usado

| Peça | Onde | Para que serve ao ranking |
|---|---|---|
| Base de jogadores que **sobrevive ao wipe** | migração 006, tabela `players` | é a identidade que o ranking soma; `first_seen` é o "jogador desde" |
| Presença e **tempo jogado** por servidor | `player_servers.played_seconds`, `core/src/players/presence.ts` | o denominador de "kills por hora" e o corte de amostra mínima |
| Histórico de **mundos** (wipes) detectados | migração 025 (`wipes`), `core/src/db/wipes-repository.ts` | é a âncora da temporada: `save_created_at` delimita o período |
| Contrato **versionável** agente↔plugin | `core/src/game/plugin-contract.ts` | onde o formato do ranking vai morar |
| Empurrar estado ao plugin (base64, teto, desfecho) | `core/src/game/plugin-push.ts` | o caminho de volta, já resolvido |
| Paginação de payload grande vindo do plugin | `origemz.bp.export` (`Plugins/OrigemZAgent.cs`) | o molde exato do `stats.flush` (§8.5) |
| Evento espontâneo do plugin, por marcador | `#OZPEVT#` em `Plugins/OrigemZPlayer.cs`, canal `log` do `RconClient` | o caminho dos eventos raros (§8.4) |
| A tela do jogo | `core/src/game/ui-preset-main-menu.ts:320` | **já existe** um item `RANKING` no menu, com a dica "O ranking de jogadores entra aqui." |

### 2.2 O que a documentação já decidiu, e continua valendo

- **[`06-API.md`][api]:** *"O ranking fica de fora porque depende de kills e
  tempo MEDIDOS, e construí-lo sobre exemplo seria fixar uma regra de pontuação
  em cima de números falsos. O que existe é onde guardar o que ele vai somar."*
- **[`13-BRIEFING-JOGADORES.md`][brief13]:** *"O caminho para tornar real: um
  comando novo no `OrigemZPlayer` que reporte eventos (morte, kill) por hook do
  Oxide, no mesmo contrato dos que já existem."*
- **[`09-ROADMAP.md`][roadmap]:** a base de jogadores *"sobrevive ao wipe, que é
  o que permite ranking de três meses num servidor que zera o mundo toda
  semana"*.

Este documento é a continuação direta dessas três frases. Ele não as revoga.

### 2.3 O que **não** existe

Nenhuma tabela de estatística, nenhum contador, nenhum hook de coleta em plugin
nenhum, nenhuma rota. A tela do jogo é um placeholder e a aba do painel é mock
rotulado. A última migração aplicada é a **032**; a primeira livre para o
ranking é a **033**.

---

## 3 — O que o jogo entrega, e por onde

### 3.1 O que o RCON dá — e é pouco

| Comando | O que traz | Serve ao ranking? |
|---|---|---|
| `playerlist` | steamId, nome, ping, tempo conectado, vida, **endereço IP** | só presença |
| `serverinfo` | jogadores, mundo, `SaveCreatedTime` | delimita a temporada |
| `chat.tail` | histórico de chat | não |
| `combatlog <player>` | os últimos ~100 eventos de combate daquele jogador | **não atravessa o RCON** ([Corrosion Hour][ch-combatlog]) |

O `combatlog` merece o parágrafo porque ele é a armadilha bonita desta
pesquisa: ele existe, ele tem exatamente o dado de PvP que o K/D quer, e ele é
inalcançável do lado de fora do jogo. Ele também é **por jogador**, **limitado a
`combatlogsize` entradas** e **volátil** — mesmo que atravessasse, seria uma
janela de minutos, não uma base de temporada.

### 3.2 O que só existe em hook do Oxide

Os hooks abaixo são os relevantes. As assinaturas vieram da documentação do
OxideMod ([docs.oxidemod.com][ox-hooks]) e os **tipos foram conferidos contra o
`Assembly-CSharp.dll` da instalação em disco** (`Servers\server01\`, build
`24793074`) — ver §15 para o que essa conferência prova e o que ela não prova.

#### Coleta (categoria `resource`, 23 hooks)

```csharp
// Dispara a CADA golpe que rende recurso — árvore, pedra, minério, carcaça.
private object OnDispenserGather(ResourceDispenser instance, BasePlayer entity, Item item)

// O bônus do último golpe (o "acabamento" do nó).
private object OnDispenserBonus(ResourceDispenser instance, BasePlayer player, Item item)

// O minério/cogumelo/madeira de SUPERFÍCIE, apanhado com a mão.
private object OnCollectiblePickup(CollectibleEntity instance, BasePlayer receiver, bool eat)

// A quarry produzindo. ATENÇÃO: NÃO TEM BasePlayer.
private object OnQuarryGather(MiningQuarry quarry, Item item)

// A excavator do Giant Excavator Pit. Também sem jogador direto.
private object OnExcavatorGather(...)
```

`ResourceDispenser.gatherType` é o enum que separa o que foi coletado:
**`Tree`**, **`Ore`**, **`Flesh`** ([exemplos de uso][gm-src]). É ele que
transforma "coletou" em "**minerou**".

#### Morte e dano (categorias `entity` e `player`)

```csharp
private object OnPlayerDeath(BasePlayer instance, HitInfo info)   // dispara em BasePlayer::Die
private void   OnEntityDeath(BaseCombatEntity entity, HitInfo info)
private object OnEntityTakeDamage(BaseCombatEntity entity, HitInfo info)
```

#### Craft (categoria `item`, 64 hooks)

```csharp
private void OnItemCraftFinished(ItemCraftTask task, Item item, ItemCrafter instance)
// item.info.shortname · item.amount · task.amount · task.workbenchEntity
```

#### Explosivos e disparo (categoria `weapon`, 25 hooks)

```csharp
private void OnExplosiveThrown(BasePlayer player, BaseEntity entity)   // C4, satchel, beancan
private void OnExplosiveDropped(BasePlayer player, BaseEntity entity)
private void OnRocketLaunched(BasePlayer player, BaseEntity entity)
private void OnWeaponFired(BaseProjectile projectile, BasePlayer player,
                           ItemModProjectile mod, ProtoBuf.ProjectileShoot projectiles)
```

#### O `HitInfo`, que é onde mora quase tudo do PvP

Campos relevantes ([discussão de referência][umod-hitinfo]):

| Campo | Tipo | O que é |
|---|---|---|
| `Initiator` / `InitiatorPlayer` | `BaseEntity` / `BasePlayer` | quem causou |
| `HitEntity` | `BaseEntity` | quem levou |
| `Weapon` / `WeaponPrefab` | `AttackEntity` / `BaseEntity` | a arma |
| `HitBone` | `uint` | o osso; vira nome com `StringPool.Get(info.HitBone)` |
| `isHeadshot` | `bool` | headshot |
| `ProjectileDistance` | `float` | **a distância percorrida pelo projétil** — `(firedProjectile.position − firedProjectile.initialPosition).magnitude` |
| `HitPositionWorld` | `Vector3` | onde a bala bateu |
| `damageTypes` | `DamageTypeList` | por onde o dano veio (`Explosion`, `Bullet`, `Fall`…) |

Todos esses símbolos **estão presentes** no `Assembly-CSharp.dll` desta
instalação — conferência de presença, feita direto no assembly.

### 3.3 A regra de ouro do transporte, e por que ela vale aqui

O projeto já pagou por essa lição uma vez, e ela está escrita no
`core/src/game/chat.ts`: a primeira versão do chat lia as linhas de log do RCON
e **ficou vazia** no primeiro servidor de verdade, porque um plugin de chat
cancela a mensagem original e a reemite formatada — o formato passou a ser de
**outra pessoa**.

A conclusão que o ranking herda:

> **Ler linha de log só é seguro quando o formato é NOSSO.**

O marcador `#OZPEVT#` do `OrigemZPlayer` é nosso: nasce num `Puts` do nosso
plugin, com JSON de uma linha e um prefixo que ninguém mais usa. Um evento de
ranking pode viajar por esse caminho **pelo mesmo motivo**, e só por ele. O que
está proibido, para sempre, é derivar ranking de mensagens do `DeathNotes`, do
console do jogo ou de qualquer texto que o config de um terceiro possa
reescrever.

---

## 4 — Farm de mineração

### 4.1 A definição, dita antes da implementação

> **Mineração** é o minério bruto que o jogador **tirou do mundo com as próprias
> mãos**, naquele servidor, naquela temporada.

Cada palavra dessa frase corta um caso:

- **minério bruto** — `stones`, `metal.ore`, `sulfur.ore`, `hq.metal.ore`.
  Madeira e tecido **não entram** (são coleta, não mineração); carne também não
  (`Flesh`);
- **tirou do mundo** — fundir minério em forno **não conta**: o metal fundido é
  o mesmo minério contado outra vez. Comprar na loja também não;
- **com as próprias mãos** — quarry e excavator são renda passiva e vão para um
  contador separado (§4.4);
- **naquele servidor / naquela temporada** — o número é sempre de um par
  (servidor, período). O global é soma, e soma tem regra (§12.4).

### 4.2 Os hooks, e o que cada um cobre

| Origem no jogo | Hook | Observação |
|---|---|---|
| Golpe em nó de minério | `OnDispenserGather` com `gatherType == Ore` | o grosso do volume |
| Acabamento do nó | `OnDispenserBonus` | é um segundo evento, e some se ignorado |
| Minério de superfície | `OnCollectiblePickup` | não passa pelo dispenser |
| Quarry | `OnQuarryGather` | **sem `BasePlayer`** |
| Excavator | `OnExcavatorGather` | comunitário |

O `item` que chega no hook já traz `item.info.shortname` e `item.amount` — é
dali que sai o número, e não de uma tabela nossa de "quanto um nó rende".

### 4.3 Sete armadilhas, e o que fazer com cada uma

**1. `OnDispenserGather` dispara por golpe.** Não é um evento por nó: é um por
acerto que rende. Cem jogadores em pico produzem milhares por minuto, e o hook
já é conhecido por peso quando muitos plugins o assinam ([relatos de erro e
custo][cf-gather-fail]). **Consequência de desenho: o nosso handler soma num
dicionário em memória e volta. Nada de I/O, nada de `Puts`, nada de LINQ dentro
dele.**

**2. `OnDispenserBonus` é um evento à parte.** Ignorá-lo perde o acabamento de
cada nó — o erro fica pequeno por nó e grande no mês.

**3. Retorno não-nulo CANCELA.** Os dois hooks de coleta são canceláveis: o
nosso handler é **puramente observador** e devolve `null` sempre. Um `return
true` distraído tira o minério do jogador.

**4. Não zere `item.amount`.** Documentado pela comunidade: `item.amount = 0`
ainda concede 1 ([uMod][umod-amount]). Não é o nosso caso — mas é a prova de que
o hook tem efeito colateral, e reforça a regra 3.

**5. A taxa de coleta infla o número.** Um `GatherManager` a 5x faz o mesmo
esforço render cinco vezes mais. Para o ranking **daquele servidor** isso é
justo (todos jogam com a mesma taxa); para o **global**, não. Guarde o que o
jogador recebeu (`item.amount`) **e** registre a taxa vigente do servidor no
período — sem o segundo número, o global não tem como se corrigir depois.

**6. Item devolvido não é item ganho.** Não há devolução na coleta, mas há na
recuperação de recurso (`OnItemRecycle`) e no craft cancelado. Nada disso entra
em mineração — mas entra em explosivo (§5.4), e a regra é a mesma: **conte a
concessão, e só ela**.

**7. NPC também "gathera".** O `entity` do hook é `BasePlayer`, e um NPC é um
`BasePlayer` com `userID` que **não é SteamID64**. O `IsNpc` vem antes de
qualquer coisa — é exatamente o cuidado que o `OrigemZPlayer.OnPlayerDeath` já
toma hoje.

### 4.4 Quarry e excavator: por que ficam de fora do ranking pessoal

`OnQuarryGather(MiningQuarry quarry, Item item)` **não recebe jogador**
([OxideMod][ox-quarry]). Daria para atribuir pelo `OwnerID` da quarry, e o
resultado seria enganoso de três formas: a quarry rende com o dono offline,
rende para o time inteiro, e uma quarry num servidor com muito diesel vira
primeiro lugar sem ninguém ter batido uma picareta.

**Proposta:** os contadores `quarry.ore` e `excavator.ore` existem, são
gravados, e **não entram no índice de mineração**. Aparecem na ficha do jogador
como "renda passiva". Quem quiser um ranking de quarry tem os dados; o ranking
de *farm* continua sendo de quem farmou.

### 4.5 A unidade e o índice

Contadores brutos, um por recurso — sempre em unidades do jogo:

```
ore.stones · ore.metal · ore.sulfur · ore.hqm
```

E um índice composto, que é o que a tela ordena:

```
mining_score = 1×stones + 2×metal + 3×sulfur + 25×hqm
```

**De onde saem os pesos.** Da escassez relativa no mundo e do uso: enxofre é o
recurso da guerra, HQM é o gargalo do endgame e sai em quantidade uma ordem de
grandeza menor por nó. Os números acima são um **ponto de partida
configurável**, não uma verdade: o peso vive no config do servidor, e mudar o
peso **não pode reescrever o passado** — ver §12.5.

**Por que um índice, e não quatro rankings.** Porque "quem farmou mais" com
quatro listas é quatro perguntas, e o jogador só faz uma. As quatro listas
continuam existindo como filtro.

---

## 5 — Farm de explosivo

Este é o ranking com mais escolha de produto e menos consenso no mercado. Ele
precisa de definição antes de código.

### 5.1 Três definições possíveis

| Definição | Mede | Problema |
|---|---|---|
| (a) **Explosivo craftado** | produção | não distingue quem craftou de quem usou; conta o C4 que ficou na caixa |
| (b) **Explosivo detonado** | uso | perde quem produz para o time; conta o satchel jogado no chão |
| (c) **Enxofre farmado** | insumo | já é o ranking de mineração; contaria duas vezes |

### 5.2 A recomendação

**Métrica principal: poder explosivo produzido, medido em enxofre equivalente
(SEQ), a partir do `OnItemCraftFinished`.**
**Métrica secundária: explosivos detonados, a partir de `OnExplosiveThrown` e
`OnRocketLaunched`.**

O SEQ existe para responder uma coisa que "quantidade de itens" não responde:
40 beancans não valem 1 C4. Convertendo tudo para o insumo comum — enxofre — a
lista passa a ordenar **poder de raid**, que é a pergunta real.

### 5.3 O SEQ sai do jogo, e não de uma tabela nossa

**####  A TABELA DE CUSTO NÃO PODE SER HARDCODED  ####**

A Facepunch mexe em custo de blueprint entre updates, e as fontes públicas já
divergem entre si **hoje**: para o satchel, uma calculadora diz **300** de
enxofre e outra **480** ([XGamingServer][xgs-sulfur], [Rustly][rustly-sulfur]) —
divergência que provavelmente vem de contar, ou não, a pólvora de forma
recursiva. Uma constante nossa nasceria errada e envelheceria calada.

**O certo é derivar em runtime**, no plugin, do próprio blueprint do jogo:

```
seq(item) = soma, sobre os ingredientes do blueprint:
              ingrediente == "sulfur"     -> quantidade
              ingrediente tem blueprint   -> seq(ingrediente) × quantidade   (recursivo)
              caso contrário              -> 0
```

Assim `gunpowder` resolve para enxofre + carvão, e o C4 herda o custo real
daquele servidor — inclusive se o servidor mexeu no custo. O plugin calcula uma
vez no `OnServerInitialized`, memoiza, e reporta o SEQ junto com o contador de
itens. Ordem de grandeza para conferência (referência pública, 2026): foguete
≈ 1 400, C4 ≈ 2 200 (+20 tech trash), munição explosiva 5.56 ≈ 25 por bala
([XGamingServer][xgs-raid]).

### 5.4 As armadilhas

**1. Nem todo explosivo no inventário foi farmado.** Loja, kit, VIP, `give` do
painel, drop de Bradley/heli, compra em vending machine. Contar isso faria o
ranking de "farm" premiar quem **comprou**. O `OnItemCraftFinished` já resolve
90% (só conta o que passou pela bancada); o resto — se um dia alguém contar
posse — exigiria origem por item, que o jogo não dá de graça.

**2. Craft cancelado devolve os ingredientes.** `OnItemCraftCancelled` existe.
Como contamos no **`Finished`**, o cancelado nunca entrou — mas é a razão de
**não** usar `OnItemCraft`, que dispara no início.

**3. `OnExplosiveThrown` cobre o arremesso, não o dano.** Satchel que não
grudou, C4 jogado no chão, beancan que rolou: todos contam como "detonado" e
nenhum abriu parede. Por isso a métrica de uso é **secundária**, e vem sempre
acompanhada, na tela, de "estruturas destruídas" quando ela existir.

**4. Raid de verdade é `OnEntityTakeDamage` com `damageTypes` de explosão em
`BuildingBlock`.** É uma terceira métrica ("estruturas destruídas"), de volume
médio-alto, e ela é **opcional na primeira fatia** — plugins dedicados a isso
(o [Raid Tracker][umod-raidtracker]) existem porque o assunto é grande sozinho.

**5. Munição explosiva é explosivo.** `ammo.rifle.explosive` custa enxofre e
abre porta. Ela entra no SEQ como qualquer outro item — o que reforça a regra do
§5.3: a lista de "o que é explosivo" é **derivada do blueprint** (tem enxofre na
árvore ⇒ é explosivo), e não uma lista nossa que esquece um item novo no
próximo update.

---

## 6 — K/D

### 6.1 A definição

> **Kill** é a morte de um jogador **desperto**, causada por outro jogador, que
> não seja companheiro de time, e que não seja ele mesmo.
> **Death**, para efeito de K/D, é a morte causada por outro jogador.

E, ao lado, contadores separados que **não entram no K/D**: `pve.kills` (NPC,
animal, heli, Bradley), `env.deaths` (queda, fome, frio, afogamento, fogo),
`suicides`, `team.kills`, `sleeper.kills`.

**Por que separar em vez de somar.** Um K/D que inclui NPC vira ranking de quem
farma scientist. Um K/D que inclui queda pune quem explora. E um K/D que inclui
sleeper premia quem anda com machado por base vazia — que é exatamente o
comportamento que a comunidade chama de inflar estatística (§13).

### 6.2 A atribuição, caso a caso

No `OnPlayerDeath(BasePlayer victim, HitInfo info)`:

| Situação | Como reconhecer | Decisão |
|---|---|---|
| PvP limpo | `info.InitiatorPlayer` é jogador real e ≠ vítima | kill + death |
| Suicídio | `Initiator == victim`, ou `damageTypes` de suicídio | `suicides`; nada no K/D |
| Ambiente | sem `InitiatorPlayer`; `damageTypes` `Fall`/`Hunger`/`Cold`/`Drowned` | `env.deaths` |
| NPC matou | `Initiator` é NPC | `env.deaths` (ou `pve.deaths`) |
| Vítima é NPC | `victim.IsNpc` | `pve.kills` do atacante; a vítima **não existe** na base |
| Armadilha | `Initiator` é `AutoTurret`/`GunTrap` | kill do **dono** da armadilha, marcado como `trap.kill` |
| Team kill | atacante e vítima no mesmo time (`RelationshipManager`) | `team.kills`; **fora** do K/D |
| Sleeper | `victim.IsSleeping()` no momento | `sleeper.kills`; **fora** do K/D |
| Wounded → morte | a morte vem depois do `OnPlayerWound` | vale o **último** atacante; é o que o jogo já resolve no `HitInfo` |

**A regra que vale para todas:** `IsNpc` é a primeira linha, e o `userID` de um
NPC **não é SteamID64**. Gravar um NPC como jogador enche a base de gente que
não existe — cuidado que o `OrigemZPlayer` já documenta hoje.

### 6.3 O K/D bruto engana, e a correção é conhecida

Com amostra pequena, o topo de qualquer lista de razão é ocupado por quem jogou
pouco: um jogador com 3 kills e 0 mortes tem K/D infinito. A correção padrão é
**encolhimento bayesiano** (*shrinkage*): somar "votos fantasma" na média global
([Bhayani][bayes-blog], [Algolia][algolia-bayes]).

Aplicado ao K/D:

```
kd_score = (kills + C × m) / (deaths + C)

  m = K/D médio da população naquele período (≈ 1,0 por construção)
  C = "mortes fantasma" — a força do encolhimento
```

Com `C = 10`: 3 kills / 0 mortes vira `(3 + 10)/(0 + 10) = 1,3` — plausível. E
400 kills / 300 mortes vira `1,32`, praticamente o bruto (`1,33`): com amostra
grande, o prior desaparece. É exatamente o comportamento desejado.

**Além disso**, dois cortes de exibição:

- **mínimo de amostra** para aparecer (ex.: 10 mortes *ou* 20 kills) — quem não
  atingiu aparece na ficha, não no pódio;
- **kills por hora**, usando `player_servers.played_seconds` que **já existe**.
  É a métrica que responde "quem é perigoso", enquanto o K/D responde "quem
  sobrevive".

### 6.4 O que o K/D não vai medir, e é bom dizer

Dano causado, precisão, headshot ratio e distância média são cinco linhas a mais
no mesmo hook e podem entrar depois. Ficam fora da primeira fatia porque
`OnEntityTakeDamage` é hook de volume alto — e a fatia 1 já vai medir o custo
dos hooks de coleta.

---

## 7 — Long shot

### 7.1 As duas distâncias, e por que elas divergem

Existem **duas** respostas para "de quantos metros foi o tiro":

| Medida | O que é | Como se obtém |
|---|---|---|
| `HitInfo.ProjectileDistance` | o caminho **percorrido pelo projétil** | campo do `HitInfo`: `(position − initialPosition).magnitude` |
| distância atirador↔vítima | a linha reta entre os dois | `Vector3.Distance`, que é o que o **DeathNotes** usa: `victim.entity.Distance(attacker.entity.transform.position)` ([fonte][dn-src]) |

Elas divergem quando a bala ricocheteia, quando atravessa, quando o atirador se
move entre o disparo e o impacto — e quando alguém tenta fraudar.

### 7.2 A recomendação: registrar as duas, ranquear por uma, validar com a outra

```
shot_distance = Vector3.Distance(attacker, victim)   // é ela que vai ao ranking
ratio         = ProjectileDistance / shot_distance   // é ele que valida
```

- `ratio` próximo de 1 ⇒ tiro em linha, íntegro;
- `ratio` bem acima de 1 ⇒ ricochete / trajetória longa ⇒ **não é recorde**;
  guarda-se o evento marcado como suspeito;
- `ratio` bem **abaixo** de 1 ⇒ os dois pontos não estavam separados no
  disparo: teletransporte, `HitInfo` reconstruído, plugin de terceiro.

O ranking usa a distância reta porque é a que o jogador entende e a que qualquer
print do jogo confirma. O `ProjectileDistance` fica no registro como prova.

### 7.3 O filtro de elegibilidade

Um recorde só vale se **todas** forem verdadeiras:

1. a vítima é jogador real (`!IsNpc`) e **não estava dormindo**;
2. atacante ≠ vítima, e não são do mesmo time;
3. a arma é **de projétil** (`info.IsProjectile()` / `Weapon is BaseProjectile`)
   — explosivo, fogo, armadilha e melee **não fazem long shot**;
4. o atacante não estava em modo admin (noclip/vanish) no instante do disparo;
5. a distância está abaixo de um **teto de plausibilidade** configurável
   (sugestão: 1 000 m). Acima disso é registro suspeito, não recorde;
6. a distância está acima de um **piso** (sugestão: 25 m), para o ranking não
   ser poluído por tiro de corredor.

Categorias sugeridas, porque um arco e uma L96 não competem: `bolt`
(bolt-action/L96/M39), `semi`/`auto` (rifles), `bow` (arco/besta), `other`. O
ranking padrão é o geral; a categoria é filtro.

### 7.4 O que se guarda de um recorde

Long shot **não é contador**: é um fato, e um fato sem testemunho não se defende
quando alguém contesta. O registro leva:

```
steamId · serverId · periodId · distância · ratio · arma · munição · headshot ·
vítima (steamId + nome no dia) · grid (o gridLabel de game/grid.ts) ·
posição do atirador e da vítima · quando · wipeId
```

**Guarda-se o melhor**, e um **top N** por período (sugestão: 50). Guardar todo
tiro seria guardar o jogo inteiro; guardar só o melhor tira a lista de quem faz
o pódio.

**Por que o máximo, e não a média.** A média de distância é uma métrica de
estilo de jogo (sniper × shotgun), não de proeza. "Long shot" é recorde, e
recorde é máximo.

---

## 8 — Volume, transporte e perda

### 8.1 A conta que decide o desenho

Um jogador farmando bate ~1 golpe por segundo. Com 100 jogadores e um terço
deles farmando:

```
33 jogadores × 60 golpes/min ≈ 2 000 eventos/min ≈ 33 eventos/s
```

Cada evento como linha de console JSON custaria ~120 bytes ⇒ **~4 KB/s de
console, para sempre**, atravessando o mesmo WebRCON que serve o painel, o chat
e as operações de wipe.

**É inviável, e o motivo não é o tamanho: é a natureza do canal.** O WebRCON não
negocia frame, não tem backpressure e não tem entrega garantida. Perder frame
ali é perder minério de alguém, em silêncio.

### 8.2 O desenho: o plugin agrega, o agente busca

```
   HOOK                    PLUGIN (memória)                 AGENTE
  golpe  ──►  soma em Dictionary<steamId, Counters>
  golpe  ──►  soma
  golpe  ──►  soma
                    ┌───────────────────────────────┐
                    │ a cada N s: grava snapshot     │
                    │ no data file do Oxide          │
                    └───────────────────────────────┘
                                      ▲
             origemz.stats.flush ─────┘        (o agente PERGUNTA,
                    │                           a cada 60 s)
                    ▼
             {"ok":true,"contract":1,"batchId":"…","seq":41,
              "count":312,"offset":0,"limit":100,
              "players":[…],"records":[…]}
                    │
                    ▼
             o agente aplica no SQLite, em UMA transação
                    │
                    ▼
             origemz.stats.ack <batchId>   ──►  só AQUI o plugin zera
```

**As cinco propriedades desse desenho:**

1. **O volume desaparece.** Mil golpes viram uma linha por jogador por minuto.
2. **A perda é recuperável.** O plugin só zera o buffer depois do `ack`. RCON
   caiu no meio? O próximo `flush` traz o mesmo lote.
3. **A duplicata é inofensiva.** O `batchId` é gravado numa tabela; lote
   repetido é **ignorado** (§9.4). É o mesmo raciocínio da `Idempotency-Key` que
   o `POST /wipe/runs` já exige.
4. **Reload do plugin não perde o dia.** O snapshot periódico no data file do
   Oxide é o que sobrevive a um `oxide.reload` — no máximo se perdem os segundos
   desde o último snapshot.
5. **Nada disso pesa no hook.** O hook só soma em memória.

### 8.3 O que "perder" significa em cada ponto

| Falha | O que se perde | Por quê |
|---|---|---|
| Agente reinicia | nada | o plugin segura até o `ack` |
| RCON cai | nada | idem |
| `oxide.reload` | os segundos desde o último snapshot | buffer volátil por natureza |
| Servidor cai duro | idem | idem |
| Plugin desativado num servidor | tudo daquele servidor — e **isso precisa aparecer na tela** | "sem dados" ≠ "zero" |

A última linha é a regra que o projeto inteiro já segue, e que aqui volta a
valer: **"zero jogadores" e "não consegui perguntar" são respostas diferentes**
(`plugin-contract.ts`). Uma tabela de ranking vazia porque o plugin caiu **não
pode** parecer um servidor sem farm.

### 8.4 Os eventos raros vão por push, e por que isso não contradiz o acima

Kill e long shot são de volume baixo (dezenas por hora, não milhares por minuto)
e têm valor **imediato**: anunciar no chat "Fulano acertou de 412 m" é metade da
graça. Esses podem sair na hora, pelo caminho que já existe — um marcador nosso,
JSON de uma linha, lido no evento `log` do `RconClient` (`#OZSTAT#`, irmão do
`#OZPEVT#`).

**E continuam entrando no `flush` também.** O push é o caminho rápido; o pull é o
que garante. A duplicata é resolvida por `eventId` — o agente ignora o que já
viu. Sem essa dupla via, um frame de chat perdido viraria um recorde perdido.

### 8.5 O molde do `flush` já existe

O `origemz.bp.export` do `OrigemZAgent.cs` resolveu este problema inteiro para os
blueprints, e o `stats.flush` deve **copiar o desenho**:

- `count` é o **total**, não o tamanho da página;
- `offset` e `limit` voltam **já normalizados** (quem pede 5 000 recebe 100 e
  **vê** isso na resposta);
- a página pode vir com menos itens que o `limit` sem significar fim de lista —
  **quem avança é o `limit`, nunca `players.length`**;
- teto de bytes por resposta abaixo do frame medido (60 KB lá; o mesmo aqui);
- resposta em **uma linha só**, achada por `firstJsonLine`;
- resposta fora do contrato ⇒ `PLUGIN_INVALID_RESPONSE`, **nunca** lista vazia.

E o contrato nasce **versionado**, como o [`09-ROADMAP.md`][roadmap] pede para a
Fase 2: um campo `contract: 1` na resposta, e o agente recusando o que não
entende.

---

## 9 — O modelo de dados no agente

### 9.1 O princípio

> **Contador agregado por (jogador, servidor, período) — não evento cru.**
> A exceção é o recorde, que é fato e precisa de testemunho.

Guardar o evento cru custaria dezenas de milhões de linhas por wipe num SQLite
que hoje tem dezenas de milhares, para responder perguntas que ninguém faz. O
que se perde com a agregação: "quando exatamente ele minerou". O que se ganha:
um banco que continua abrindo em milissegundos.

### 9.2 O esquema proposto (migração **033**)

```sql
-- ----------------------------------------------------------
--  stat_periods — a JANELA de um ranking.
--
--  Um período é (servidor, tipo, começo). O tipo 'wipe' aponta
--  para a linha de `wipes` que o criou: é assim que o ranking
--  sabe que aquele mundo acabou sem depender de relógio.
--
--  'lifetime' é UM período por servidor, sem fim — o que
--  responde à promessa do 09-ROADMAP: o ranking sobrevive ao
--  wipe porque o JOGADOR sobrevive ao wipe.
-- ----------------------------------------------------------
CREATE TABLE stat_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('wipe','season','lifetime')),
  -- A linha de `wipes` que abriu este período. NULL em 'lifetime'.
  wipe_id INTEGER REFERENCES wipes(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  -- NULL = ainda aberto. É a coluna que a consulta do "agora" usa.
  ended_at INTEGER,
  label TEXT
);

-- Um período aberto por (servidor, tipo), e o banco garante isso.
CREATE UNIQUE INDEX idx_stat_periods_open
  ON stat_periods (server_id, kind) WHERE ended_at IS NULL;

-- ----------------------------------------------------------
--  player_stats — o contador.
--
--  ####  POR QUE (metric TEXT, value INTEGER) E NÃO UMA COLUNA
--        POR MÉTRICA  ####
--
--  Porque a lista de métricas CRESCE: começamos com quatro
--  rankings e o mercado já mede 178 coisas. Coluna por métrica é
--  uma migração por ideia, e uma tabela com sessenta colunas
--  quase todas em zero.
--
--  O custo é conhecido: não dá para somar duas métricas numa
--  expressão SQL simples, e o índice precisa começar por
--  (period_id, metric). As consultas do ranking são exatamente
--  essas — "top N de UMA métrica num período" — então o formato
--  serve à pergunta que existe.
-- ----------------------------------------------------------
CREATE TABLE player_stats (
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  -- 'ore.sulfur', 'explosive.seq', 'pvp.kills', 'pvp.deaths', …
  metric TEXT NOT NULL,
  -- Sempre INTEIRO e sempre MONOTÔNICO: só cresce, e cresce por
  -- soma de lote. Guardar float aqui abriria a porta para
  -- arredondamento acumulado em milhões de somas.
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (period_id, steam_id, metric)
);

-- A consulta do ranking: top N de uma métrica num período.
CREATE INDEX idx_player_stats_rank
  ON player_stats (period_id, metric, value DESC);

-- A consulta da ficha: tudo daquele jogador.
CREATE INDEX idx_player_stats_player ON player_stats (steam_id, metric);

-- ----------------------------------------------------------
--  player_records — o FATO, com testemunho.
--
--  O long shot mora aqui. Um contador diria "412"; esta tabela
--  diz com que arma, em quem, onde e quando — que é o que se
--  mostra quando alguém contesta o recorde.
-- ----------------------------------------------------------
CREATE TABLE player_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  -- 'shot.distance' hoje; 'raid.biggest' amanhã.
  metric TEXT NOT NULL,
  -- REAL aqui, ao contrário de player_stats: distância é medida,
  -- não contagem, e 412.73 é a informação.
  value REAL NOT NULL,
  at INTEGER NOT NULL,
  -- O testemunho, em JSON: arma, munição, headshot, vítima, grid,
  -- posições, ratio de validação. É para LER, não para filtrar —
  -- por isso uma coluna, e não dez.
  detail TEXT,
  -- 'ok' | 'suspect' | 'void'. Suspeito é GRAVADO e não entra no
  -- pódio; apagar seria perder o rastro da fraude.
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','suspect','void'))
);

CREATE INDEX idx_player_records_rank
  ON player_records (period_id, metric, value DESC) WHERE status = 'ok';

-- ----------------------------------------------------------
--  stat_batches — a idempotência do §8.2.
--
--  Sem ela, um `ack` perdido faria o mesmo lote entrar duas
--  vezes, e o contador de alguém dobraria sem nada no log.
-- ----------------------------------------------------------
CREATE TABLE stat_batches (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  events INTEGER NOT NULL,
  PRIMARY KEY (server_id, batch_id)
);

CREATE INDEX idx_stat_batches_recent ON stat_batches (server_id, applied_at DESC);

-- ----------------------------------------------------------
--  stat_adjustments — quem mexeu no número, e por quê.
--
--  Zerar a estatística de um suspeito é AÇÃO ADMINISTRATIVA, e
--  ação administrativa sem autor é o que não se consegue
--  explicar depois. Mesma razão da `store_audit` (migração 021).
-- ----------------------------------------------------------
CREATE TABLE stat_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  metric TEXT,
  -- 'reset' | 'set' | 'void_record'
  action TEXT NOT NULL,
  old_value INTEGER,
  new_value INTEGER,
  actor TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);
```

### 9.3 Ordem de grandeza

Com 500 jogadores ativos e 25 métricas por período:

```
500 × 25 = 12 500 linhas por período de wipe, por servidor
5 servidores × 12 wipes/ano ≈ 750 000 linhas/ano
```

Menos de 50 MB com índices. **É pequeno.** O que seria grande é o evento cru — e
é por isso que ele não existe.

### 9.4 O caminho de escrita, inteiro

```
flush → valida contrato (zod) → batchId já em stat_batches?
                                   sim → IGNORA (e loga em debug)
                                   não → transação:
                                          UPSERT em player_stats   (value = value + delta)
                                          INSERT em player_records (só se bater o recorde)
                                          INSERT em stat_batches
                                 → ack ao plugin
```

Uma transação por lote — e não uma por jogador. O SQLite com WAL faz isso em
milissegundos; mil transações separadas fariam disso um problema.

### 9.5 O global

**Não existe tabela de global.** O ranking de rede é uma **consulta** sobre os
períodos abertos de todos os servidores:

```sql
SELECT ps.steam_id, SUM(ps.value) AS total
  FROM player_stats ps
  JOIN stat_periods sp ON sp.id = ps.period_id
 WHERE ps.metric = ?
   AND sp.kind = ?
   AND sp.ended_at IS NULL
 GROUP BY ps.steam_id
 ORDER BY total DESC
 LIMIT ? OFFSET ?;
```

**Por que não materializar.** Porque uma tabela global é uma **segunda fonte para
o mesmo fato**, e o [`02-ARQUITETURA.md`](02-ARQUITETURA.md) já diz o que
acontece com a segunda fonte: ela diverge no primeiro ajuste. Se a consulta
ficar lenta — e ela não vai, com os volumes do §9.3 — o caminho é um cache com
prazo, não uma tabela paralela.

**A ressalva de honestidade:** somar servidores de taxas diferentes é somar
laranja com maçã. Ver §12.4.

---

## 10 — A API

No padrão do [`06-API.md`][api]: tudo sob `/api`, paginado desde a primeira
versão, erro em português nascido no módulo da regra.

```
GET  /api/rankings/metrics
     o catálogo: id, rótulo, unidade, se entra no global, direção da ordem

GET  /api/rankings?metric=&scope=global|server&serverId=&period=wipe|season|lifetime
                  &limit=&offset=
     a lista, paginada

GET  /api/rankings/records?metric=shot.distance&scope=&serverId=&period=&limit=
     os recordes, com o testemunho

GET  /api/players/:steamId/rankings
     as posições DELE: por métrica, por escopo, com o total e a colocação

POST /api/servers/:id/rankings/flush
     força um ciclo agora (o relógio já faz sozinho). 202

POST /api/rankings/:steamId/reset
     { metric?, periodId?, reason }  — zera, com autor, e grava em
     stat_adjustments. Exige CSRF, como todo método que muda estado
```

**Três campos que toda resposta de ranking carrega**, e que existem por causa do
§8.3:

| Campo | Para quê |
|---|---|
| `measuredSince` | desde quando aquele número é medido. Sem ele, um ranking que começou ontem parece um ranking de sempre |
| `coverage` | quais servidores do escopo tinham o plugin ativo no período. É o que impede "o pvp2 está zerado" de parecer "ninguém farmou no pvp2" |
| `updatedAt` | do último `flush` aplicado |

**Códigos de erro novos**, no formato da tabela do `06-API.md`:

| Código | HTTP | Quando |
|---|---|---|
| `RANKING_METRIC_UNKNOWN` | 400 | métrica que não está no catálogo |
| `RANKING_PERIOD_NOT_FOUND` | 404 | período inexistente, ou de outro servidor |
| `RANKING_NOT_MEASURED` | 409 | o escopo pedido nunca teve coleta ativa |
| `PLUGIN_INVALID_RESPONSE` | 502 | já existe; o `flush` fora do contrato cai aqui |

---

## 11 — As telas

### 11.1 No painel

Uma aba **RANKING** na barra lateral (rede) e uma sub-aba no servidor. Colunas:
posição, jogador, valor — e, o que quase todo leaderboard de Rust esquece, **a
data desde quando aquilo é medido**.

Regras que já são do projeto e valem aqui:

- **ausente vira travessão, nunca zero** (`panel/src/lib/format.ts`);
- **mock é rotulado na tela** — enquanto a coleta não existir, a aba diz que é
  exemplo;
- **paginado desde a primeira versão.**

### 11.2 No jogo (CUI)

O item `ranking` **já está reservado** no menu principal
(`ui-preset-main-menu.ts:320`, hoje com a dica "O ranking de jogadores entra
aqui."). O que cabe lá:

- **top 10**, não top 100 — o teto do frame do RCON é medido e a carga inicial
  do menu já é apertada (é a razão de o cabeçalho ser `shell`);
- **a linha do próprio jogador**, sempre, mesmo fora do top: é a única
  informação que ele realmente foi ver;
- **abas por métrica** (MINERAÇÃO · EXPLOSIVO · K/D · TIRO), reusando o padrão de
  sub-abas que a tela CALENDÁRIO já tem;
- **atualização por período**, não em tempo real. Um ranking que se redesenha a
  cada kill é um menu piscando — o CUI redesenha a tela inteira ao trocar.

### 11.3 O anúncio no chat

O long shot é o único que ganha anúncio automático ("Fulano acertou de 412 m com
Bolt Action"), porque é evento raro e é o que faz o ranking existir na cabeça de
quem joga. Sai pelo agendador de mensagens que a Fase 6 já entregou — **não** por
um `Puts` novo do plugin.

---

## 12 — Pontuação, janelas e temporadas

### 12.1 As três janelas

| Janela | Começa | Termina | Para que serve |
|---|---|---|---|
| **wipe** | quando `wipes.save_created_at` muda | no próximo wipe | a disputa da semana; é onde a maioria olha |
| **season** | por configuração (mês, trimestre) | idem | a premiação |
| **lifetime** | na primeira coleta | nunca | a promessa do roadmap: o ranking de três meses num servidor que zera toda semana |

**A âncora já existe e é confiável.** O `WipeClock` (`core/src/game/wipe.ts`) lê o
`SaveCreatedTime` do `serverinfo` e grava em `wipes` — inclusive quando o wipe
foi feito à mão, com o agente parado. É o que garante que a temporada fecha pelo
**mundo que realmente nasceu**, e não pelo que uma execução relatou.

### 12.2 O fechamento

Quando um mundo novo aparece: fecha o período `wipe` aberto (`ended_at`), abre o
próximo, e **congela um snapshot** dos primeiros colocados. O congelamento não é
otimização — é para a tela "campeões do wipe passado" continuar respondendo
depois que os pesos mudarem (§12.5).

### 12.3 Quatro listas, e um score opcional

Os quatro rankings pedidos são **quatro listas independentes**, e assim devem
ficar. Se um dia alguém quiser "o melhor jogador do servidor", a composição
honesta é por **percentil**, nunca por soma de valores brutos:

```
overall = 0,30×pct(mining) + 0,25×pct(explosive) + 0,30×pct(kd) + 0,15×pct(shot)
```

Percentil porque os quatro têm escalas incomparáveis (milhões de minério × K/D de
1,4). Somar valores brutos faria o ranking geral ser o ranking de mineração com
ruído.

### 12.4 O global, e a armadilha da taxa

Somar `pvp1` (1x) com `farm3` (5x) num ranking de mineração produz uma lista
ordenada por **em que servidor a pessoa jogou**. Duas saídas:

**(a) Normalizar** — dividir pelo multiplicador vigente do servidor no período.
Correto na intenção, frágil na prática: a taxa muda no meio do wipe, plugins
mudam por permissão (VIP com gather maior), e o número normalizado deixa de bater
com o do servidor.

**(b) Restringir** — o ranking global existe só para as métricas que não dependem
da taxa: **K/D, kills, long shot** e explosivos **detonados**. Mineração e SEQ
produzido ficam **por servidor**.

**Recomendação: (b) por padrão, com (a) como opção declarada na tela** ("global
normalizado" como filtro explícito, dizendo que é estimativa). É a saída honesta:
um número que se explica em uma frase vale mais que um número "correto" que
ninguém consegue conferir.

### 12.5 Mudar o peso não reescreve o passado

Os pesos do §4.5 e da §12.3 vivem em config. Quando alguém muda um peso, os
**contadores não mudam** — eles são unidades do jogo. O que muda é o índice
calculado na leitura. Por isso o snapshot do §12.2 guarda o **valor calculado**
junto com a versão dos pesos: sem isso, o campeão de março mudaria em maio.

### 12.6 Empates

Ordem de desempate, fixa: (1) o valor; (2) quem chegou primeiro àquele valor —
`updated_at` ascendente; (3) `steam_id`, para a ordenação ser **determinística**
entre páginas. Sem o terceiro critério, dois jogadores empatados trocam de lugar
entre a página 1 e a página 2, e um deles simplesmente some da lista.

---

## 13 — Anti-abuso e integridade

### 13.1 Os cinco abusos, e o sinal de cada um

| Abuso | Como é feito | Sinal detectável |
|---|---|---|
| **Kill farming com alt** | conta secundária morrendo de propósito | pares de kills muito repetidos entre os mesmos dois steamIds; vítima com `played_seconds` mínimo; intervalo entre kills curto e regular |
| **Sleeper farming** | matar dormindo em base vazia | `victim.IsSleeping()` — já excluído do K/D por definição (§6.1) |
| **Explosivo comprado** | contar item da loja como farm | contamos `OnItemCraftFinished`, não posse (§5.4) |
| **Long shot fabricado** | teleporte, noclip, plugin de terceiro | `ratio` fora da faixa (§7.2); teleporte do painel já é registrado em `player_events` |
| **Farm com privilégio** | VIP com gather maior no ranking geral | a taxa efetiva por jogador é conhecida no plugin e pode acompanhar o lote |

### 13.2 A política

**Marcar e mandar para revisão humana. Nunca punir sozinho.** É o que os
servidores maduros fazem: as estatísticas suspeitas são sinalizadas e **o admin
decide**, sem auto-ban ([RustFront][rf-cheaters]). Um ranking que bane sozinho
erra em público, com o jogador errado.

Na prática: um `status = 'suspect'` no recorde, um marcador na linha da lista, e o
`POST /api/rankings/:steamId/reset` com **autor e motivo obrigatórios** (§9.2).
Zerar é reversível na conversa porque ficou registrado quem zerou.

### 13.3 O que o ranking **não** deve fazer

- **não expõe IP.** `players.last_ip` existe e é anulável (com o plugin ativo ele
  nem é preenchido). Ele serve à investigação, não à tela pública;
- **não vira prova de cheat.** Estatística anômala é motivo para olhar, não para
  concluir;
- **não some com o wipe.** Recorde e contador de temporada continuam existindo
  depois que o mundo zerou — é o ponto do §12.1.

---

## 14 — O que o mercado faz

Levantamento dos plugins e serviços que resolvem partes deste problema. Serve
para dois fins: não reinventar formato, e saber o que **não** copiar.

| Solução | O que resolve | Armazenamento | O que aproveitamos |
|---|---|---|---|
| [**Player Ranks**][cf-playerranks] (Codefling) | 30+ métricas: PVPKills, PVPDistance, HeadShots, KDR, recursos, construção; GUI com stats pessoais e leaderboard | data file, SQLite ou **MySQL** | a **lista de categorias** — é o conjunto que o público já espera; e a ideia de *snapshot* de leaderboard para uso web |
| [**Statistics DB**][umod-statsdb] (uMod) | serve estatísticas a **outros plugins** | — | o desenho de "quem coleta não é quem mostra" |
| [**Kill Records**][umod-killrecords] (uMod) | kills por entidade, com SQL e UI de leaderboard | SQL | o recorte "kill por tipo de entidade" |
| [**Top KDR**][umod-topkdr] · [**KDR Scoreboard**][umod-kdrsb] · [**KDR GUI**][umod-kdrgui] | K/D e placar dentro do jogo | data file | o mínimo que o jogador espera ver |
| [**Ultimate Leaderboard**][cf-ultimate] (Codefling) | leaderboard por wipe **e** global, prêmios pós-wipe, editor web | **JSON, SQLite ou MySQL** | a separação **pós-wipe × global**, que é a nossa §12.1 |
| [**Premium Leaderboard**][cf-premium] | leaderboard multi-servidor com MySQL e nome de servidor configurável | MySQL | a modelagem multi-servidor |
| [**SimpleStats**][cf-simplestats] · [**Rust Web Leaderboards**][cf-webboards] | leaderboard web agregando **vários servidores**, wipe após wipe | web + SFTP/SQL | a expectativa de comparar jogadores entre servidores |
| [**MStats**][gh-mstats] (GitHub) | log de estatísticas para MySQL | MySQL | referência aberta de esquema |
| [**RankEval**][rankeval] (serviço) | **178+ métricas em 12 pilares**, 160+ servidores, score de clã que soma os 8 melhores membros e **sobrevive ao wipe** | SaaS | a ideia de **lifetime que sobrevive ao wipe**, e de pilares em vez de lista solta |
| [**Raid Tracker**][umod-raidtracker] | raid por explosivo/arma/fogo, para investigação | data file | o recorte de raid, se um dia entrar |

### 14.1 Por que não instalar um pronto

Três razões, na ordem:

1. **O dado precisa morar no agente.** O ranking de rede é a soma de vários
   servidores; um plugin por servidor guarda no data file **dele**, e o global
   viraria um agregador de arquivos — que é exatamente o que o
   `02-ARQUITETURA.md` chama de segunda fonte;
2. **A tela do jogo já é nossa.** O item `RANKING` está no `ui-preset-main-menu` e
   o menu é um documento CUI do agente. Um plugin de terceiro traria a UI dele,
   com a paleta dele, por cima da nossa;
3. **O contrato agente↔plugin já existe e é versionado.** Adotar um plugin de
   terceiro é adotar o formato de saída dele — o que o §3.3 proíbe.

O que **se aproveita** é o mapa de métricas: a lista do Player Ranks e os pilares
do RankEval dizem, de graça, o que o público de Rust espera ver numa tela de
ranking.

---

## 15 — Riscos e o que **não** foi validado

Escrito em voz alta, como o `09-ROADMAP.md` faz, porque quem pegar isto depois
precisa saber antes de prometer a alguém que funciona.

### 15.1 O que foi **medido** nesta pesquisa

- os **símbolos existem** no `Assembly-CSharp.dll` da instalação em disco
  (`Servers\server01\`, build `24793074`): `ResourceDispenser`,
  `CollectibleEntity`, `MiningQuarry`, `ExcavatorArm`, `SurveyCharge`,
  `ItemCrafter`, `ThrownWeapon`, `TimedExplosive`, `GatherType`,
  `ProjectileDistance`, `HitPositionWorld`, `isHeadshot`, `HitBone`, `boneArea`,
  `InitiatorPlayer`, `WeaponPrefab`;
- o repositório **não tem** nenhuma tabela, rota, hook ou tela de ranking hoje
  (busca por `rank`/`leaderboard` em `Docs/`, `core/src`, `panel/src`,
  `Plugins/`);
- a última migração aplicada é a **032**.

### 15.2 O que foi **conferido em documentação**, e não em execução

As assinaturas dos hooks vieram da documentação do OxideMod e de código público
de plugins. **Conferir nome não é compilar** — é a mesma ressalva que o
`09-ROADMAP.md` faz sobre o plugin da Fase 6, e ela continua valendo aqui.

### 15.3 Os riscos abertos

| Risco | Consequência | Mitigação |
|---|---|---|
| Nenhum plugin foi compilado (não há Oxide.Compiler nesta máquina) | uma assinatura errada só aparece no servidor | a fatia 1 é pequena de propósito: um hook, um contador |
| Assinatura muda com update do jogo | o hook para de ser chamado, **em silêncio** | um contador de "hooks recebidos" no `flush`; zero durante uma hora com gente online é alarme |
| Custo de CPU dos hooks de coleta com 100+ jogadores | queda de FPS do servidor | medir antes de expandir; o handler é uma soma em dicionário |
| Custo de explosivo divergente entre fontes (300 × 480 para satchel) | SEQ errado | derivar do blueprint em runtime (§5.3) |
| Servidor com plugin desligado | ranking parcial parecendo completo | `coverage` na resposta (§10) |
| Taxa de coleta diferente entre servidores | global desonesto | §12.4 |

---

## 16 — Plano de implementação

Seis fatias, em ordem de dependência. Cada uma entrega algo que se olha na tela —
e a primeira existe para **medir o custo antes de aumentar o escopo**.

### Fatia 1 — Um contador, ponta a ponta

- no plugin: `OnDispenserGather` com `gatherType == Ore`, somando em memória;
- `origemz.stats.flush` / `origemz.stats.ack`, no molde do `bp.export`;
- migração **033** com `stat_periods`, `player_stats`, `stat_batches`;
- o relógio do agente puxando a cada 60 s;
- `GET /api/rankings?metric=ore.sulfur`.

**Pronto quando:** minerar enxofre num servidor de teste move o número na API, e
derrubar o RCON no meio de um ciclo **não perde** o lote.

### Fatia 2 — Mineração completa

`OnDispenserBonus`, `OnCollectiblePickup`, os quatro minérios, o índice
ponderado, quarry/excavator em contador separado.

**Pronto quando:** o total do jogador bate com o inventário dele numa sessão
controlada.

### Fatia 3 — K/D

`OnPlayerDeath` com a matriz de atribuição do §6.2, os contadores separados, o
K/D com encolhimento e o corte de amostra.

**Pronto quando:** as nove situações da tabela do §6.2 produzem, cada uma, o
contador certo num teste.

### Fatia 4 — Long shot

`player_records`, o filtro de elegibilidade, o `ratio` de validação, o anúncio no
chat pelo agendador.

**Pronto quando:** um tiro de bolt registra distância, arma e grid; um tiro depois
de teleporte entra como `suspect`.

### Fatia 5 — Explosivo

SEQ derivado do blueprint, `OnItemCraftFinished`, explosivos detonados.

**Pronto quando:** craftar 1 C4 soma o SEQ que o blueprint **daquele servidor**
manda, e não uma constante nossa.

### Fatia 6 — As telas e a temporada

Aba no painel, tela `tela-ranking` no CUI, fechamento de período no wipe,
snapshot dos campeões, `coverage` e `measuredSince` em toda resposta.

**Pronto quando:** um wipe fecha o período, congela o pódio, e a tela do jogo
mostra o top 10 com a linha do próprio jogador.

### Fora de escopo, declarado

Dano/precisão/headshot ratio, ranking de clã, ranking de raid por estrutura
destruída, prêmios automáticos por posição, exportação web pública. Todos cabem
no modelo do §9 sem migração nova — **são métricas, e métrica é linha, não
coluna.**

---

## 17 — Fontes

**Documentação de hooks e API do jogo**

- [OxideMod — índice de hooks][ox-hooks] (categorias: resource 23, entity 103, item 64, player 152, weapon 25)
- [OxideMod — `OnDispenserGather`][ox-gather]
- [OxideMod — `OnQuarryGather`][ox-quarry]
- [OxideMod — `OnCollectiblePickup`][ox-collect]
- [OxideMod — `OnPlayerDeath`][ox-death]
- [OxideMod — `OnItemCraftFinished`][ox-craft]
- [uMod — API do Rust][umod-api] · [uMod — guia de hooks][umod-hooks]
- [uMod — discussão sobre os campos do `HitInfo`][umod-hitinfo]
- [uMod — `item.amount = 0` ainda concede 1][umod-amount]
- [Carbon — referência de hooks][carbon-hooks]

**Código de referência**

- [DeathNotes — como a distância do abate é calculada][dn-src]
- [GatherManager — uso de `gatherType`][gm-src]
- [MStats — estatísticas para MySQL][gh-mstats]

**Plugins e serviços de ranking**

- [Player Ranks (Codefling)][cf-playerranks] · [Ultimate Leaderboard][cf-ultimate] · [Premium Leaderboard][cf-premium] · [SimpleStats][cf-simplestats] · [Rust Web Leaderboards][cf-webboards]
- [Statistics DB][umod-statsdb] · [Kill Records][umod-killrecords] · [Top KDR][umod-topkdr] · [KDR Scoreboard][umod-kdrsb] · [KDR GUI][umod-kdrgui] · [Raid Tracker][umod-raidtracker]
- [RankEval — 178+ métricas, score que sobrevive ao wipe][rankeval]

**Regras do jogo e custos**

- [Corrosion Hour — o comando `combatlog` (e que ele não vai por RCON)][ch-combatlog]
- [XGamingServer — calculadora de enxofre][xgs-sulfur] · [calculadora de raid][xgs-raid]
- [Rustly — custo em enxofre por explosivo][rustly-sulfur]
- [Codefling — relatos de falha e custo no `OnDispenserGather`][cf-gather-fail]

**Estatística**

- [Bayesian averages — a fórmula do encolhimento][bayes-blog]
- [Algolia — média bayesiana em ranking][algolia-bayes]

**Integridade**

- [RustFront — o que funciona contra trapaça: revisão humana, sem auto-ban][rf-cheaters]

**Documentos internos citados**

- [`02-ARQUITETURA.md`](02-ARQUITETURA.md) — camadas, fonte da verdade
- [`06-API.md`][api] — o padrão das rotas e o "o que não existe nesta API"
- [`09-ROADMAP.md`][roadmap] — as fases e o que não foi validado
- [`13-BRIEFING-JOGADORES.md`][brief13] — o mock rotulado e o caminho para o real
- [`16-PLANO-WIPE-CALENDARIO-MENSAGENS.md`](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md) — a barra do menu com `RANKING`

[api]: 06-API.md
[roadmap]: 09-ROADMAP.md
[brief13]: 13-BRIEFING-JOGADORES.md
[ox-hooks]: https://docs.oxidemod.com/hooks/
[ox-gather]: https://docs.oxidemod.com/hooks/resource/OnDispenserGather
[ox-quarry]: https://docs.oxidemod.com/hooks/resource/OnQuarryGather
[ox-collect]: https://docs.oxidemod.com/hooks/resource/OnCollectiblePickup
[ox-death]: https://docs.oxidemod.com/hooks/player/OnPlayerDeath
[ox-craft]: https://docs.oxidemod.com/hooks/item/OnItemCraftFinished
[umod-api]: https://umod.org/documentation/games/rust
[umod-hooks]: https://umod.org/guides/the-basics/hooks
[umod-hitinfo]: https://umod.org/community/rust/14325-detailed-hitinfo-explanation
[umod-amount]: https://umod.org/community/rust/37197-ondispensergather-itemamount-set-to-zero-always-gives-at-least-1-of-the-gathered-resource
[carbon-hooks]: https://carbonmod.gg/references/hooks/
[dn-src]: https://github.com/Calytic/oxideplugins/blob/master/rust/DeathNotes.cs
[gm-src]: https://github.com/Calytic/oxideplugins/blob/master/rust/GatherManager.cs
[gh-mstats]: https://github.com/Limmek/MStats-for-rust
[cf-playerranks]: https://codefling.com/plugins/player-ranks
[cf-ultimate]: https://codefling.com/plugins/ultimate-leaderboard-web-editor
[cf-premium]: https://codefling.com/plugins/premium-leaderboard
[cf-simplestats]: https://codefling.com/tools/simplestats-web-leaderboard
[cf-webboards]: https://codefling.com/tools/rust-web-leaderboards-plug-and-play
[cf-gather-fail]: https://codefling.com/files/support/4376-failed-to-call-hook-ondispensergather/
[umod-statsdb]: https://umod.org/plugins/statistics-db
[umod-killrecords]: https://umod.org/plugins/kill-records
[umod-topkdr]: https://umod.org/plugins/top-kdr
[umod-kdrsb]: https://umod.org/plugins/kdr-scoreboard
[umod-kdrgui]: https://umod.org/plugins/kdr-gui
[umod-raidtracker]: https://umod.org/plugins/raid-tracker
[rankeval]: https://rankeval.gg/
[ch-combatlog]: https://www.corrosionhour.com/rust-combat-log-command/
[xgs-sulfur]: https://xgamingserver.com/tools/rust/sulfur-calculator
[xgs-raid]: https://xgamingserver.com/tools/rust/raid-calculator
[rustly-sulfur]: https://rustly.com/calculators/sulfur-calculator/
[bayes-blog]: https://arpitbhayani.me/blogs/bayesian-average/
[algolia-bayes]: https://www.algolia.com/doc/guides/managing-results/must-do/custom-ranking/how-to/bayesian-average
[rf-cheaters]: https://rustfront.com/guides/rust-servers-without-cheaters
