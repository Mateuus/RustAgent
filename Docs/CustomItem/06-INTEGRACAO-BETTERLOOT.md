# 06 — A INTEGRAÇÃO COM O BETTERLOOT

> **O que este documento é.** A **medição do BetterLoot** e a **proposta de
> desenho** para a decisão que o dono tomou em 06/09/2026: o painel do RustAgent
> passa a configurar **todo o loot do jogo** — e faz isso **editando a
> configuração do BetterLoot**, em vez de construirmos um motor de loot próprio.
> Todos os números do §2, §3 e §4 saíram do fonte do plugin e do
> `Assembly-CSharp.dll` deste servidor; o método de cada um está nomeado ao lado.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. **O
> BetterLoot não está instalado em lugar nenhum deste projeto** — grep por
> `BetterLoot` no repositório inteiro: zero ocorrências. O fonte foi baixado para
> o scratchpad desta sessão e lido lá; nada foi copiado para `oxide/plugins`,
> nada foi instalado, nenhum comando foi executado no `server01` (que estava no
> ar, com o dono jogando). Nenhuma linha de código do projeto foi alterada.
>
> **De onde ele parte.** O [`05-EDITOR-DE-LOOT.md`](05-EDITOR-DE-LOOT.md), de
> hoje, mediu o terreno que o BetterLoot substitui: 1.321 `LootSpawn`, 105
> containers, 5 níveis, 34 containers com scrap, 71 com refresh. Referências a
> ele aparecem como **[E§n]**. O [`04-ITEM-NO-LOOT-DO-JOGO.md`](04-ITEM-NO-LOOT-DO-JOGO.md)
> mediu que a tabela nativa não carrega skin — **[L§n]**. Este documento
> **confirma o `04` no principal e derruba a recomendação central do `05`**
> (§1.4), porque a decisão do dono a tornou obsoleta.
>
> **A quem ele se liga.** A marca `(base_shortname, skin_id)` está em
> [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md) (**[P§n]**). A fatia
> de loot que **já existe na árvore** — migração 048, repositório, rotas, painel
> e os hooks no `OrigemZItems.cs` — é o assunto do §7.
>
> **LEIA ISTO ANTES DE INSTALAR.** O
> [`07-INSTALAR-BETTERLOOT.md`](07-INSTALAR-BETTERLOOT.md) é a instalação deste
> plugin em produção, tentada em 06/09/2026 e **revertida**: ele traz um
> **terceiro** efeito colateral não documentado, medido ao vivo e mais grave que
> os dois deste estudo — o mundo perde metade dos contêineres enquanto o plugin
> está no ar. O procedimento de instalação, a ordem dos passos e a prova de que o
> conserto de refresh está agindo estão todos lá.

**Escrito em 06/09/2026**, contra o fonte `BetterLoot.cs` v4.4.0 (3.405 linhas)
do repositório `magic-services-co/Better-Loot`, contra o
`Assembly-CSharp.dll` de `Servers/server01/RustDedicated_Data/Managed` lido com
`dnfile`, e contra a árvore do RustAgent no estado desta sessão.

> **ATALHO PARA DECIDIR HOJE.** Quatro seções bastam, nesta ordem:
> **[§1.2](#12-a-pergunta-que-decide-tudo-respondida-primeiro)** — a resposta do
> skin, que é a pergunta que decide tudo · **[§2](#2--os-quatro-arquivos-medidos-no-fonte)** —
> os quatro JSONs, no nível de *"dá para gerar isto do painel"* ·
> **[§8](#8--o-risco-da-dependência-sem-maquiar)** — o veredito sobre a
> dependência, sem suavizar · **[§12](#12--perguntas-ao-dono)** — as perguntas,
> com **Q1 e Q2 bloqueantes**.
>
> E, se for ler uma quinta: **[§11.7](#117-o-que-continua-não-medido)** — o que
> **não** foi confirmado, e por quê. Duas coisas grandes deste estudo (§4.3 e
> §4.4) são medição de fonte e de IL, **não teste ao vivo** — o plugin não está
> instalado em lugar nenhum. A Fatia 1 do §10.1 existe para fechar as duas em
> uma tarde.

---

## Índice

- [§0 — A decisão do dono](#0--a-decisão-do-dono)
- [§1 — Sumário executivo](#1--sumário-executivo)
- [§2 — Os quatro arquivos, medidos no fonte](#2--os-quatro-arquivos-medidos-no-fonte)
- [§3 — Skin e nome custom: a resposta longa](#3--skin-e-nome-custom-a-resposta-longa)
- [§4 — A API para outros plugins, e o que ela não resolve](#4--a-api-para-outros-plugins-e-o-que-ela-não-resolve)
- [§5 — Como a configuração chega ao plugin](#5--como-a-configuração-chega-ao-plugin)
- [§6 — Onde a configuração mora do nosso lado](#6--onde-a-configuração-mora-do-nosso-lado)
- [§7 — O que fazer com o que já existe](#7--o-que-fazer-com-o-que-já-existe)
- [§8 — O risco da dependência, sem maquiar](#8--o-risco-da-dependência-sem-maquiar)
- [§9 — A tela](#9--a-tela)
- [§10 — O caminho em fatias](#10--o-caminho-em-fatias)
- [§11 — Medido, conferido, projeto](#11--medido-conferido-projeto)
- [§12 — Perguntas ao dono](#12--perguntas-ao-dono)

---

## 0 — A decisão do dono

> Preservada sem edição. É a fonte; tudo que vem depois é leitura dela.

O dono viu o **Looty** (`looty.cc/betterloot`) e decidiu: **o painel do RustAgent
vai configurar TODO o loot do jogo, não só o item custom** — aumentar loot, mexer
em min/max de itens, scrap, blueprints, multiplicadores 2x/5x/10x, remover lixo,
grupos. E escolheu a estratégia: **o nosso painel edita a configuração do
BetterLoot**, em vez de construirmos um motor de loot próprio.

O Looty **não é um plugin** — é um editor web para o BetterLoot. O que ele produz
são os JSONs que o plugin lê. É esse papel que o nosso painel vai assumir, com a
vantagem de já estar do lado do servidor.

---

## 1 — Sumário executivo

### 1.1 A leitura em uma frase

> **A decisão do dono funciona, e funciona melhor do que o `05` supunha — mas ela
> compra um plugin com três surpresas medidas, e duas delas mudam o desenho.**
>
> O BetterLoot **carrega skin e nome customizado por entrada** (§3), o que
> resolve o Troféu Bleik pelo caminho do próprio plugin e derruba a última razão
> de o loot ser um caso especial. Ele **autogera** a tabela inteira a partir do
> loot nativo no primeiro boot, o que nos dá de graça o dump que o **[E§3]**
> orçou como a fatia mais cara do projeto. E ele **substitui** o loot em vez de
> complementá-lo — o que é a escolha oposta à do **[E§4]**, e traz consigo dois
> efeitos que o README não menciona: **o container fica sem slot livre** (§4.3) e
> **o cronômetro de refresh do jogo para de ser iniciado** (§4.4).

### 1.2 A pergunta que decide tudo, respondida primeiro

> #### &nbsp;&nbsp;SIM — O BETTERLOOT SUPORTA `skinId` E NOME CUSTOMIZADO POR ENTRADA&nbsp;&nbsp; ####
>
> **Medido no fonte, não na página de marketing.** A classe base de toda entrada
> de tabela é a `LootEntrySettings`, e os dois primeiros campos dela são:
>
> ```csharp
> // BetterLoot.cs:1221-1227
> public class LootEntrySettings
> {
>     [JsonProperty("Skin ID (0 = default)")]
>     public ulong SkinId = 0;
>
>     [JsonProperty("Display Name (empty = none)")]
>     public string? DisplayName = string.Empty;
> ```
>
> E eles são **aplicados de verdade**, em quatro caminhos independentes de
> criação de item:
>
> | Onde | Linha | Como |
> |---|---|---|
> | item de grupo (`LootGroups.json`) | `:1204` | `ItemManager.CreateByPartialName(name, amount, entry.Value.Amount.SkinId)` |
> | item avulso, seleção plana | `:2816` | `item.skin = lootEntry.SkinId;` |
> | item avulso, seleção por raridade | `:2973` | `item.skin = lootEntry.SkinId;` |
> | item garantido (`Guaranteed Items`) | `:2557` | `ItemManager.CreateByName(name, amount, gItemEntry.Value.SkinId)` |
> | item bônus (`Bonus Items`) | `:1532` | `ItemManager.CreateByName(name, amount, _bonusItemEntry.SkinId)` |
>
> O nome sai pelo `ApplyAllProperties` (`:1246-1259`):
> `if (!string.IsNullOrWhiteSpace(DisplayName)) item.name = DisplayName;`
>
> **Consequência direta:** o Troféu Bleik pode nascer no loot **sem uma linha de
> código nosso** — basta uma entrada no `LootTables.json` com o `Skin ID` da
> marca. O `Match` do `OrigemZItems.cs` (que sai em `skin == 0`) encontra a marca
> e faz o resto.
>
> **E há um detalhe que fecha o caso.** As chaves das tabelas passam por
> `UniqueTagREGEX = new Regex(@"\{\d+\}")` (`:416`), que é removido antes de
> resolver o shortname (`:1201`, `:2480`, `:2540`). Isso significa que
> `discord.trophy{1}` e `discord.trophy{2}` são **duas entradas distintas do
> mesmo item base**, cada uma com a sua skin. **O mesmo item pode aparecer várias
> vezes na mesma caixa com skins diferentes** — que é exatamente o que um
> catálogo de itens custom precisa.

### 1.3 As decisões que o pedido força

**1. O troféu entra pelo BetterLoot; o hook do `OrigemZItems` não morre, mas muda
de papel.** O plugin de terceiro passa a ser a via normal de "pôr item no loot".
O nosso hook fica com o que o BetterLoot **não tem**: teto por dia, cooldown por
jogador, modo `measuring` e a telemetria que alimenta a tela. Ver §3.5 e §7.

**2. Adotar o BetterLoot é adotar SUBSTITUIÇÃO, e isso precisa ser dito.** O
`OnLootSpawn` dele devolve `true` (`BetterLoot.cs:1626`), o que faz o
`LootContainer.SpawnLoot` **retornar** — medido no IL (§4.4). O **[E§4]**
recomendou complementar, com nove itens de custo. Esse custo **não desapareceu**:
ele foi terceirizado, e o §4.4 mostra os dois itens da lista que o BetterLoot
**não** cobre.

**3. O JSON não é a fonte de verdade e o banco também não é uma cópia dele.** O
plugin **reescreve os quatro arquivos depois de carregá-los** (`:780`), removendo
tabelas inválidas, ajustando attachments e completando campos. O que se escreve
não é o que fica no disco. A recomendação do §6 é **espelho**: o banco guarda a
intenção do admin; o JSON é derivado e **relido depois de aplicado**, exatamente
como o `PluginLibrary.configWrite` já faz para qualquer plugin
(`core/src/oxide/library.ts:1106`).

**4. O trabalho que já está na árvore não é rascunho — está ligado de ponta a
ponta.** Migração 048 aplicada, repositório de 590 linhas, seis rotas, nove
componentes de painel, três comandos de console e dois hooks implementados no
`OrigemZItems.cs`. **Nada disso é órfão** e nada disso vira lixo com a mudança de
estratégia — mas parte muda de papel. Ver §7.

**5. A dependência é frágil e precisa ser assumida de olhos abertos.** Repositório
com **6 commits**, **1 estrela**, **1 mês de idade** e **nenhuma licença**. O plano
B existe e é barato, mas só porque a fatia 1 do §10 o preserva de graça. Ver §8.

**6. A nossa tela ganha do Looty em três pontos concretos**, e nenhum deles é
estética: o catálogo vem do servidor de verdade e não de bundles baixados; a
aplicação é um `writeFile` + `oxide.reload` em vez de baixar-e-subir arquivo; e
a medição do que a regra fez no mundo já existe no banco. Ver §9.3.

### 1.4 Onde este estudo DERRUBA o `05` — a tabela da correção

O **[E§4]** foi escrito antes da decisão do dono e recomendou **complementar**,
com o argumento de que a tabela do jogo é um ativo que a Facepunch mantém de
graça. A decisão do dono escolheu o caminho oposto. Não é contradição: é uma
premissa nova. Mas três afirmações daquele documento **precisam ser corrigidas**.

| O `05` diz | O que foi medido agora | Onde |
|---|---|---|
| **[E§1.2]** *"a configuração é uma lista de REGRAS, não uma cópia da tabela — uma regra ocupa uma linha; a cópia ocupa 1.396"* | **a cópia deixou de ser cara.** O BetterLoot **autogera** a tabela inteira a partir do loot nativo no primeiro boot (`:1834-2049`), lendo `LootSpawnSlots` e `lootDefinition` do prefab. A cópia não é digitada — ela nasce pronta | §2.6 |
| **[E§3.3]** *"78,8 KB contra 50 KB: paginar não é opcional"* | **o transporte deixou de existir.** A configuração não viaja por RCON: ela é um **arquivo no disco**, e o agente já tem acesso ao disco do servidor. O teto de 50 KB do `plugin-push.ts:70` é irrelevante aqui | §5 |
| **[E§4.4]** *"complementar — e o motivo não é segurança, é o update"* | **continua verdadeiro, e agora é um custo assumido.** Adotar o BetterLoot é congelar a tabela do jogo naquele prefab. O §8.3 diz o que isso custa num update do Rust, e a resposta não é confortável | §4.4, §8.3 |

> #### &nbsp;&nbsp;E UMA COISA QUE O `05` ACERTOU E VALE REPETIR&nbsp;&nbsp; ####
>
> O **[E§8.4]** disse que *"peso não é probabilidade, e a tela precisa mostrar as
> duas"*. No BetterLoot o problema **muda de forma mas não some**: as
> probabilidades dele são percentuais **cumulativos** (`ProbalisticRNG`,
> `:832-863`), somados numa lista e sorteados por busca binária. Um item com
> `"Item Probability (1-100)": 30` num grupo de dez itens **não tem 30 % de
> chance** — ele tem 30 dividido pela soma dos dez. A tela tem exatamente o mesmo
> dever de mostrar a porcentagem efetiva ao lado do número digitado, e pelo mesmo
> motivo.

### 1.5 A tabela-resumo

| Pergunta | Resposta curta | Onde |
|---|---|---|
| O BetterLoot suporta skin por entrada? | **sim**, `ulong SkinId`, aplicado em 5 caminhos | §3 |
| E nome customizado? | **sim**, `string DisplayName` | §3.1 |
| Dá para o mesmo item aparecer 2x com skins diferentes? | **sim**, pelo sufixo `{n}` na chave | §3.3 |
| Quantos arquivos, e onde? | **4**: um em `oxide/config`, três em `oxide/data/BetterLoot` | §2.1 |
| Ele complementa ou substitui? | **substitui** — `OnLootSpawn` devolve `true` | §4.4 |
| A API deixa o nosso plugin acrescentar sem cancelar? | **não pelo caminho óbvio** — o container fica sem slot livre | §4.3 |
| Dá para coexistir por container? | **sim**, e por três chaves independentes | §4.5 |
| Escrever o arquivo basta para aplicar? | **não** — precisa de `oxide.reload BetterLoot` | §5.3 |
| O projeto já sabe escrever em `oxide/config`? | **sim**, com backup obrigatório e releitura | §5.2 |
| E em `oxide/data`? | **não** — seria o primeiro caso do projeto | §5.2 |
| Onde a configuração mora? | **banco como intenção, JSON como espelho relido** | §6.3 |
| A migração 048 muda? | **não.** Ela continua descrevendo o que ela descreve | §7.5 |
| O que fica órfão do trabalho atual? | **quase nada** — um arquivo muda de dono | §7.4 |
| Licença do plugin? | **nenhuma.** Nem arquivo, nem cabeçalho | §8.2 |
| Qual é a menor fatia útil? | ligar o BetterLoot e **ler** o que ele gerou | §10 |

---

## 2 — Os quatro arquivos, medidos no fonte

> **Método.** `git clone --depth 50 https://github.com/magic-services-co/Better-Loot`
> para o scratchpad desta sessão. O repositório tem **dois arquivos**:
> `BetterLoot.cs` (150.242 bytes, 3.405 linhas) e `README.md`. A versão declarada
> é `[Info("BetterLoot", "MagicServices.co // TGWA", "4.4.0")]` (`:25`). Todas as
> estruturas abaixo foram lidas das classes `[JsonProperty]` do fonte — **não do
> README**, que está desatualizado em relação ao código (§2.2).

### 2.1 Onde eles moram, e quem os lê

| Arquivo | Caminho | Classe | Carregado em |
|---|---|---|---|
| **`BetterLoot.json`** | `oxide/config` | `PluginConfig` (`:113`) | `LoadConfig` (`:316`) |
| **`LootTables.json`** | `oxide/data/BetterLoot` | `LootTableData` (`:521`) | `Loaded()` (`:420`) |
| **`Blacklist.json`** | `oxide/data/BetterLoot` | `StoredBlacklist` (`:529`) | `Loaded()` (`:419`) |
| **`LootGroups.json`** | `oxide/data/BetterLoot` | `LootGroupsData` (`:536`) | `Loaded()` (`:421`) |

O caminho dos três de dados sai de
`Interface.Oxide.DataFileSystem.ReadObject<T>("BetterLoot" + separador + fileName)`
(`:767`), o que produz a subpasta `BetterLoot` dentro de `oxide/data`. O
precedente de subpasta já existe neste projeto: `oxide/data/OrigemZItems/` (com
`pending.json`), criada pelo nosso próprio plugin.

### 2.2 `BetterLoot.json` — a configuração global

Quatro blocos, todos com nome legível (`:113-121`). **Os nomes abaixo são os do
código v4.4.0**; o README do repositório ainda mostra os nomes de uma versão
anterior — `"Blueprint Probability"` e `"Watched Prefabs"` são hoje **chaves
legadas de migração** (`:131` e `:153`), lidas mas não escritas.

```json
{
  "Chat Configuration": {
    "Chat Message Prefix": "[<color=#00ff00>BetterLoot</color>]",
    "Chat Message Icon SteamID (0 = None)": 0
  },
  "General Configuration": {
    "Blueprint Weight (0.0 = min bias, 1.0 = max bias, 0.5 = balanced)": 0.11,
    "Log Updates On Load": true,
    "Remove Stacked Containers": true,
    "Only update prefab list on wipe day": false,
    "Auto enable new prefabs found on wipe": true,
    "Watched Container Prefabs (true = monitor container loot, false = disabled)": {
      "assets/bundled/prefabs/radtown/crate_normal.prefab": true,
      "assets/bundled/prefabs/radtown/crate_elite.prefab": true,
      "assets/bundled/prefabs/radtown/loot_barrel_1.prefab": false,
      "unwrap/xmas.present.large": true
    }
  },
  "Loot Configuration": {
    "Enable Hammer Hit Loot Cycle": false,
    "Hammer Loot Cycle Time": 3.0,
    "Loot Multiplier": 1,
    "Scrap Multipler": 1,
    "Allow duplicate items": true,
    "Enable logging for item attachments auto balancing operations": false,
    "Always allow duplicate items from bonus items list (if set, will override 'Allow duplicate items option')": true,
    "Enable Blueprint Conversion": true,
    "Allow Duplicate Blueprints": false,
    "Enable Loot Pool Locking System": true
  },
  "Loot Groups Configuration": {
    "Enable creation of example loot group on load?": true,
    "Enable auto profile probability balancing?": true,
    "Always allow duplicate items from loot groups (if true overrides 'Allow duplicate items option')": true,
    "Allowed probablity difference to select neighbour during duplicate item resolution.": 10
  }
}
```

Campos e tipos, medidos em `:125-209`:

| Chave | Tipo C# | Default | Linha |
|---|---|---|---|
| `Blueprint Weight (...)` | `double` | `0.11` | `:127-128` |
| `Log Updates On Load` | `bool` | `true` | `:141-142` |
| `Remove Stacked Containers` | `bool` | `true` | `:143-144` |
| `Only update prefab list on wipe day` | `bool` | `false` | `:145-146` |
| `Auto enable new prefabs found on wipe` | `bool` | `true` | `:147-148` |
| **`Watched Container Prefabs (...)`** | **`Dictionary<string, bool>`** | `{}` | `:149-150` |
| `Enable Hammer Hit Loot Cycle` | `bool` | `false` | `:170-171` |
| `Hammer Loot Cycle Time` | `double` | `3.0` | `:172-173` |
| **`Loot Multiplier`** | **`int`** | `1` | `:174-175` |
| **`Scrap Multipler`** *(erro de grafia no original)* | **`int`** | `1` | `:176-177` |
| `Allow duplicate items` | `bool` | `true` | `:178-179` |
| `Enable Blueprint Conversion` | `bool` | `true` | `:184-185` |
| `Allow Duplicate Blueprints` | `bool` | `false` | `:186-187` |
| `Enable Loot Pool Locking System` | `bool` | `true` | `:188-189` |
| `Allowed probablity difference (...)` | `double` | `10` | `:208-209` |

> #### &nbsp;&nbsp;OS MULTIPLICADORES 2x/5x/10x SÃO DUAS LINHAS, E SÃO GLOBAIS&nbsp;&nbsp; ####
>
> O dono citou "multiplicadores 2x/5x/10x" como um dos itens do pedido. No
> BetterLoot eles são `Loot Multiplier` e `Scrap Multipler`, ambos `int`,
> aplicados em três pontos: `:1532` (itens bônus), `:2815` e `:2972` (itens
> avulsos) para o loot, e `:2585` para o scrap.
>
> **Duas coisas que a tela precisa dizer, porque nenhuma das duas é óbvia:**
>
> 1. **Eles multiplicam a QUANTIDADE, não a chance.** Um `crate_elite` com
>    multiplicador 5 não dá cinco vezes mais itens — dá os mesmos itens com
>    quantidade cinco vezes maior. Quem controla "quantos itens saem" é o
>    `Minimum/Maximum Amount of Items` **por container** (`:925-929`).
> 2. **Eles são `int` e globais.** Não existe multiplicador por container e não
>    existe 1,5x. Um servidor que queira 2x nos barris e 1x no resto **não usa
>    esta chave** — usa os `Item Minimum` / `Item Maximum` de cada entrada.
>
> É por isso que o §9.2 propõe que a tela ofereça o multiplicador **em dois
> lugares distintos**, com nomes diferentes, em vez de um controle só.

**O merge é a favor de quem escreve.** `MaybeUpdateConfigDict` (`:377-407`)
percorre as chaves do default e **preenche o que faltar** no arquivo lido,
salvando de volta se mudou (`:322-327`). Consequência prática: **um
`BetterLoot.json` parcial funciona** — dá para escrever só `Loot Configuration`
e deixar o plugin completar o resto. É o oposto dos três arquivos de dados, que
são substituídos por inteiro.

### 2.3 `LootTables.json` — a tabela por prefab

É o arquivo grande e é onde mora a decisão do admin. Estrutura, de `:521-527`
e `:872-983`:

```jsonc
{
  "LootTables": {
    "assets/bundled/prefabs/radtown/crate_elite.prefab": {
      "Is Prefab Enabled?": true,
      "Loot Profiles": [
        {
          "Group Enabled?": true,
          "Loot Profile Name": "armas_boas",
          "Loot Profile Probability (1% - 100%)": 30.0,
          "Max Items From Profile (0 = unlimited)": 1
        }
      ],
      "Enable Loot Pool Locking": false,
      "Select ungrouped items ignoring rarity bias": false,
      "Guaranteed Items": {
        "scrap": {
          "Skin ID (0 = default)": 0,
          "Display Name (empty = none)": "",
          "Item Minimum": 10,
          "Item Maximum": 25
        }
      },
      "Ungrouped Items": {
        "metal.refined": {
          "Skin ID (0 = default)": 0,
          "Display Name (empty = none)": "",
          "Item Minimum": 2,
          "Item Maximum": 8,
          "Allow Duplicates": true,
          "Bonus Items": {}
        },
        "discord.trophy{1}": {
          "Skin ID (0 = default)": 3403269092,
          "Display Name (empty = none)": "Troféu Bleik Store",
          "Item Minimum": 1,
          "Item Maximum": 1,
          "Allow Duplicates": false,
          "Bonus Items": {}
        },
        "rifle.ak": {
          "Skin ID (0 = default)": 0,
          "Display Name (empty = none)": "",
          "Item Minimum": 1,
          "Item Maximum": 1,
          "Can Convert To Blueprint": true,
          "Item Durability": { "Minimum Durability": 10, "Maximum Durability": 60 },
          "Item Properties": {
            "Ammunition Settings": {
              "Ammo Item Shortname": "ammo.rifle",
              "Minimum Amount": 0,
              "Maximum Amount": 30
            },
            "Weapon Attachments": {
              "Minimum Mod Amount": 1,
              "Maximum Mod Amount": 2,
              "Available Attachments": {
                "weapon.mod.holosight": { "Spawn Probability (0%-100%)": 50.0 }
              }
            }
          },
          "Allow Duplicates": true,
          "Bonus Items": {}
        }
      },
      "Item Settings": {
        "Minimum Amount of Items": 3,
        "Maximum Amount of Items": 6,
        "Minimum Scrap Amount": 25,
        "Maximum Scrap Amount": 25,
        "Minimum Blueprints": 0,
        "Maximum Blueprints": 1,
        "Bonus Items Contribute to Item Count": false,
        "Guaranteed Items Contribute to Item Count": true
      }
    }
  }
}
```

**Nota sobre o exemplo:** ele é **derivado das classes**, não copiado de um
arquivo real — o plugin não está instalado em lugar nenhum aqui, então não há
`LootTables.json` de verdade para transcrever. Os nomes de chave e os tipos são
medidos; os **valores** são ilustrativos. O `skin_id` do troféu é o do briefing.

Os campos, tabela por tabela:

**Raiz — `PrefabLoot`** (`:872-895`):

| Chave | Tipo | O que é |
|---|---|---|
| `Is Prefab Enabled?` | `bool` | **desligado devolve o container ao loot nativo** (§4.5) |
| `Loot Profiles` | `List<LootProfileImport>` | os grupos importados, com probabilidade |
| `Enable Loot Pool Locking` | `bool` | trava o sorteio num perfil só por container |
| `Select ungrouped items ignoring rarity bias` | `bool` | seleção plana em vez de enviesada por raridade |
| `Guaranteed Items` | `Dictionary<string, LootEntrySettings>` | **saem sempre**, sem sorteio (`:2537-2565`) |
| `Ungrouped Items` | `Dictionary<string, LootEntry>` | o corpo da tabela |
| `Item Settings` | `ItemProperties` | quantos itens, quanto scrap, quantos blueprints |

**`Loot Profiles[]` — `LootProfileImport`** (`:904-911`): `Group Enabled?`
(`bool`), `Loot Profile Name` (`string`, aponta para uma chave de
`LootGroups.json`), `Loot Profile Probability (1% - 100%)` (`double`),
`Max Items From Profile (0 = unlimited)` (`int`).

**`Item Settings` — `ItemProperties`** (`:925-947`): `Minimum/Maximum Amount of
Items` (`int`), `Minimum/Maximum Scrap Amount` (`int`), `Minimum/Maximum
Blueprints` (`int`), `Bonus Items Contribute to Item Count` (`bool`),
`Guaranteed Items Contribute to Item Count` (`bool`). Há duas chaves legadas
lidas e não escritas — `Scrap Amount` e `Max Blueprints` (`:953-956`).

**A entrada — `LootEntry : LootEntrySettings`** (`:1221-1245`, `:1507-1513`):

| Chave | Tipo | Nota |
|---|---|---|
| `Skin ID (0 = default)` | `ulong` | **§3** |
| `Display Name (empty = none)` | `string` | **§3** |
| `Item Minimum` / `Item Maximum` | `int` | multiplicados pelo `Loot Multiplier` |
| `Can Convert To Blueprint` | `bool?` | **omitido quando `null`**; o plugin o preenche sozinho conforme o item seja pesquisável (`:2076-2085`) |
| `Item Durability` | objeto ou ausente | `Minimum/Maximum Durability` (`:1344-1348`), em **porcentagem** (`ChangeConditionPercentage`, `:1256`) |
| `Item Properties` | objeto ou ausente | só para armas; ver abaixo |
| `Allow Duplicates` | `bool` | só existe no nível de topo da entrada (`:1511-1512`) |
| `Bonus Items` | `Dictionary<string, LootEntrySettings>` | itens que saem **junto** com este |

> **`Bonus Items` é a resposta nativa à pergunta Q5 do `05`.** O **[E§7.3]**
> perguntou se "vários itens juntos" — *um rifle com munição* — exigiria
> estrutura nova, e deixou como não verificado. **Está verificado: o BetterLoot
> tem o recurso** (`CreateBonusItems`, `:1521-1541`), e cada item bônus carrega a
> própria skin e o próprio nome. Não precisa das 84 `collections/` do jogo.

**`Item Properties` — `ItemEntrySettings`** (`:1355-1416`), só para armas:
`Ammunition Settings` com `Ammo Item Shortname`, `Minimum/Maximum Amount` ou
`Spawn Probability` (a serialização é condicional, `:1382-1384` — arma de tiro
único serializa a probabilidade; arma com carregador serializa min/máx), e
`Weapon Attachments` com `Minimum/Maximum Mod Amount` e
`Available Attachments` (dicionário de shortname para
`{ "Spawn Probability (0%-100%)", "Durability" }`).

> #### &nbsp;&nbsp;A CHAVE DO `LootTables.json` É O CAMINHO COMPLETO DO PREFAB&nbsp;&nbsp; ####
>
> Não é o `ShortPrefabName`. É `assets/bundled/prefabs/radtown/crate_elite.prefab`.
> Medido em dois lugares: as chaves de `Watched Prefabs` vêm de
> `GameManifest.Current.prefabProperties[].name` (`:267-272`), e o hook consulta
> `_config.Generic.WatchedPrefabs.TryGetValue(container.PrefabName, ...)`
> (`:1622`) — `PrefabName`, não `ShortPrefabName`.
>
> **Isto colide com o vocabulário do projeto.** O nosso `_lootByContainer` do
> `OrigemZItems.cs:537` é indexado por `container.ShortPrefabName` (`:3233`), e a
> lista de 33 containers do `core/src/game/loot-containers.ts:39-46` guarda
> `prefab: 'crate_elite'`. **São duas chaves diferentes para a mesma coisa**, e a
> tela vai precisar das duas: a nossa, para as regras que já existem; a do
> BetterLoot, para o arquivo.
>
> Há um terceiro formato, e ele não é caminho nenhum: as caixas de presente e
> ovos entram por chaves sintéticas `unwrap/<shortname>` (`UNWRAP_PREFIX`,
> `:37`; `ToUnwrapKey`, `:299-300`). A tela precisa saber que `unwrap/` não é
> pasta.

### 2.4 `LootGroups.json` — os grupos reutilizáveis

O menor dos três, e o que dá reuso entre containers. Estrutura (`:536-546`,
`:1137-1167`):

```jsonc
{
  "Loot Groups": {
    "armas_boas": {
      "Enabled?": true,
      "Guaranteed Items": {},
      "Item List": {
        "rifle.ak": {
          "Item Probability (1-100)": 10.0,
          "Item Amount": {
            "Skin ID (0 = default)": 0,
            "Display Name (empty = none)": "",
            "Item Minimum": 1,
            "Item Maximum": 1,
            "Allow Duplicates": true,
            "Bonus Items": {
              "ammo.rifle": {
                "Skin ID (0 = default)": 0,
                "Display Name (empty = none)": "",
                "Item Minimum": 30,
                "Item Maximum": 60
              }
            }
          }
        }
      }
    }
  }
}
```

`LootProfile` (`:1137-1146`): `Enabled?` (`bool`), `Guaranteed Items`
(`Dictionary<string, LootEntrySettings>`), `Item List`
(`Dictionary<string, LootRNG>`). E `LootRNG` (`:1154-1160`):
`Item Probability (1-100)` (`double`) e `Item Amount` (um `LootEntry` inteiro —
com skin, nome, bônus e tudo).

O grupo é referenciado por **nome** a partir do `Loot Profiles` do container, e
um mesmo grupo serve N containers. **É a estrutura que o pedido do dono chamou de
"grupos".**

O plugin cria um `example_group` sozinho quando o arquivo nasce (`:538-542`) e o
importa no primeiro container da tabela (`:643-652`), a menos que
`Enable creation of example loot group on load?` seja `false`.

### 2.5 `Blacklist.json` — a lista de banidos

O mais simples dos quatro (`:529-534`):

```json
{ "ItemList": [ "wood", "stones" ] }
```

`HashSet<string>` de shortnames. **É o "remover lixo" do pedido do dono** — e o
mecanismo importa: o item **é criado e só depois descartado**
(`:2491-2495`), exatamente a mesma ineficiência que o **[E§4.3]** apontou como
custo de complementar. O item nunca chega ao container.

Ele é **global ao servidor**, não por container: o `Contains` roda dentro do laço
de qualquer container (`:2491`). Para banir um item só de um container, o caminho
é tirá-lo do `Ungrouped Items` daquela tabela.

Comandos próprios: `/blacklist additem <shortname>` e
`/blacklist deleteitem <shortname>` (`:3212`), com permissão `BetterLoot.admin`.

### 2.6 O que o plugin FAZ com os arquivos depois de ler — e isso muda o desenho

> #### &nbsp;&nbsp;ELE AUTOGERA A TABELA INTEIRA A PARTIR DO LOOT NATIVO&nbsp;&nbsp; ####
>
> `LoadAllContainers` (`:1834-2049`) percorre os `Watched Prefabs` e, para cada
> prefab que **não** tem entrada no `LootTables.json`, monta uma do zero: acha o
> prefab (`GameManager.server.FindPrefab`, `:1885`), lê os `LootSpawnSlots` ou o
> `lootDefinition` (`:1973-2026`), desce a árvore de `subSpawn` respeitando o
> filtro de era (`IsSelectableLootEntry`, `:1672-1675`), achata em
> `Ungrouped Items`, promove a `Guaranteed Items` o que sai sempre
> (`GetGuaranteedLootItems`, `:1678-1698`), e copia `scrapAmount` do container
> para `Minimum/Maximum Scrap Amount` (`:2000-2001`).
>
> **Isto é a Fatia 2 do [E§10.2] entregue de graça.** Aquele documento orçou o
> dump da tabela do jogo — 78,8 KB, paginação com backoff, resolvedor de ramo
> vivo, achatamento das 1.004 folhas — como *"a que muda a natureza do produto, e
> também a mais cara"*. **O BetterLoot já faz isso**, do lado do servidor, com a
> tabela que aquele servidor realmente carregou, e grava o resultado num arquivo
> que o agente sabe ler.
>
> **E ele resolve, sozinho, a armadilha do [E§2.4]:** o ramo morto. Quando um
> container tem `LootSpawnSlots` **e** `lootDefinition`, o `FillLoot` nativo
> ignora o segundo — e uma tela que o mostrasse estaria mentindo. O
> `LoadAllContainers` testa os slots primeiro (`:1969-1978`, `:2016-2027`) e só
> cai no `lootDefinition` quando não há slots. **A tabela que ele gera já é o ramo
> vivo.**

Três outras coisas que ele faz, e todas importam para o §6:

**1. Ele reescreve o arquivo logo depois de ler.** `LoadFile` termina em
`SaveFile(fileName, validator, ref loadVar)` (`:780`). Não é condicional.

**2. Ele valida e MODIFICA as entradas.** `scanEntry` (`:2061-2166`) remove
attachments incompatíveis com a arma (`:2140-2145`), apaga o objeto
`Item Properties` de item que não é arma (`:2110-2119`), preenche ou apaga
`Can Convert To Blueprint` conforme o item seja pesquisável (`:2076-2085`), e
cria `Item Durability` para itens com condição (`:2096-2101`). Item que não
existe vira aviso no console e **fica no arquivo sem gerar nada** (`:2068-2073`).

**3. Ele apaga tabelas cujo prefab não existe mais.** `:2192-2200` remove a
entrada e loga `Removed Invalid Loot Table`. É a defesa contra update do Rust —
e é também o que faz um arquivo escrito à mão perder linhas em silêncio.

> **A consequência para o §6, e ela é a que decide:** o que se escreve **não é o
> que fica no disco**. Qualquer desenho que trate o JSON como fonte de verdade
> vai divergir do banco na primeira vez que o plugin carregar. O projeto já
> conhece esse problema e já o resolveu para `oxide/config`: o
> `PluginLibrary.configWrite` **relê o arquivo do disco depois de aplicar**
> (`core/src/oxide/library.ts:1106`), justamente porque *"o plugin faz
> `SaveConfig()` e reescreve"* (comentário em `core/src/oxide/plugin-config.ts:16-28`).

---

## 3 — Skin e nome custom: a resposta longa

### 3.1 Os dois campos, e onde eles valem

Já estão no §1.2. O que falta é o alcance: **`LootEntrySettings` é a classe base
de toda entrada de qualquer nível**, e por isso os dois campos aparecem em cinco
lugares diferentes do arquivo:

| Lugar | Classe | Linha |
|---|---|---|
| item avulso de container | `LootEntry` (herda) | `:1507` |
| item garantido de container | `LootEntrySettings` | `:888-889` |
| item de grupo | `LootRNG.Amount` é `LootEntry` | `:1158-1159` |
| item garantido de grupo | `LootEntrySettings` | `:1142-1143` |
| item bônus (em qualquer um dos anteriores) | `LootEntrySettings` | `:1510-1511` |

### 3.2 A aplicação, medida caminho por caminho

O `ApplyAllProperties(Item item)` (`:1246-1259`) é chamado em **todos** os
caminhos de criação e faz, nesta ordem: `ApplyAmmo`, `ApplyAttachments`, o nome
(`item.name = DisplayName` se não for vazio), a durabilidade
(`ChangeConditionPercentage`), e `item.MarkDirty()`.

A skin **não** passa por ele: ela é aplicada antes, ou no construtor do item
(`:1204`, `:1532`, `:2557`) ou por atribuição direta (`:2816`, `:2973`). Nos dois
casos ela está no item **antes** de qualquer `MoveToContainer`.

> **Isto é o que importa para nós.** O `Match` do `OrigemZItems.cs` reconhece um
> item custom pela marca `(base_shortname, skin_id)` e **sai em `skin == 0`**. Um
> item que o BetterLoot criou com `SkinId` preenchido **casa com a marca** — e
> tudo que o nosso plugin faz por cima da marca (o ícone, o nome, a ação
> `points`, o `#OZSTAT#`) continua funcionando sem alteração nenhuma.

### 3.3 A chave repetida — o mesmo item, várias skins

`UniqueTagREGEX = new Regex(@"\{\d+\}", RegexOptions.Compiled)` (`:416`), aplicado
com `.Replace(key, string.Empty)` antes de resolver o shortname em `:1201`,
`:2480`, `:2540` e `:2069`.

Consequência: as chaves `discord.trophy`, `discord.trophy{1}` e
`discord.trophy{2}` são **três entradas independentes** que resolvem para o mesmo
`ItemDefinition` — cada uma com a sua skin, o seu nome, a sua quantidade e a sua
probabilidade.

> **Sem isso, o BetterLoot não serviria para item custom.** O `LootTables.json` é
> um dicionário chaveado por shortname; sem o sufixo, um catálogo com cinco
> troféus de skins diferentes teria de escolher um só. **Com ele, o nosso
> catálogo inteiro cabe numa caixa.**
>
> A tela precisa gerar esses sufixos sozinha e **nunca** mostrá-los ao admin: para
> ele, são cinco linhas com cinco ícones diferentes.

### 3.4 O que isso faz com o Troféu Bleik

O caso que originou toda esta frente (**[L]**, **[E]**) fica assim:

| | Como estava desenhado | Com o BetterLoot |
|---|---|---|
| quem cria o item | `InjectLoot` do `OrigemZItems.cs:3334`, no `NextTick` | o BetterLoot, dentro do `OnLootSpawn` |
| quem carimba a skin | nós | o plugin, pelo `Skin ID` da entrada |
| onde a raridade é configurada | `loot_rules.chance`, no nosso banco | `Item Probability` da entrada, no `LootTables.json` |
| quem garante o teto do dia | nós (`daily_cap`) | **ninguém** |
| quem mede o que aconteceu | nós (`loot_rule_hits`) | **ninguém** |

### 3.5 O que o BetterLoot NÃO dá — e é por isso que o nosso hook sobrevive

Varredura no fonte por cada capacidade que a migração 048 descreve:

| Capacidade | No BetterLoot? | Evidência |
|---|---|---|
| skin por entrada | **sim** | `:1223-1224` |
| nome customizado | **sim** | `:1226-1227` |
| quantidade min/máx | **sim** | `:1229-1232` |
| probabilidade por item | **sim** | `:1156-1157` |
| item garantido | **sim** | `:888`, `:2537-2565` |
| itens que saem juntos | **sim** | `Bonus Items`, `:1510` |
| **teto por dia** (`daily_cap`) | **não** | zero ocorrências de contador diário |
| **cooldown por jogador** | **não** | o plugin não conhece jogador na população |
| **modo `measuring`** (contar sem criar) | **não** | não há caminho que sorteie e não crie |
| **telemetria** (rolls / hits / spawned) | **não** | nenhum contador é persistido |
| **por servidor** | **não** | é um arquivo por servidor, sem noção de conjunto |
| **histórico e desfazer** | **não** | um `.bak`, sobrescrito a cada backup (`:711-712`) |

> #### &nbsp;&nbsp;A DIVISÃO DE TRABALHO QUE ISSO DESENHA&nbsp;&nbsp; ####
>
> **O BetterLoot é o motor; o nosso lado é o governo.** Ele sabe encher uma caixa
> com skin e nome — e não sabe dizer *"no máximo três por dia"*, *"não para o
> mesmo jogador duas vezes na semana"*, *"conte por uma semana antes de soltar"*
> nem *"quantos saíram ontem"*.
>
> Isso não é um defeito dele: é o escopo dele. E é exatamente o que o
> `OrigemZItems.cs` já implementa (§7.2). **As duas peças são complementares, e a
> pergunta do §4 é se elas conseguem trabalhar na mesma caixa.**

---

## 4 — A API para outros plugins, e o que ela não resolve

### 4.1 Os dois hooks, medidos onde são chamados

O README anuncia dois hooks. Medidos no fonte, eles são chamados em **três**
lugares:

```csharp
// BetterLoot.cs:2299   — corpo de NPC
if (Interface.CallHook("ShouldBLPopulate_NPC", npc.playerSteamID) != null)
    return false;

// BetterLoot.cs:2307   — LootContainer (o caso que nos interessa)
if (container is null || container.IsDestroyed ||
    Interface.CallHook("ShouldBLPopulate_Container", container.net.ID.Value) != null)
    return false;

// BetterLoot.cs:2321   — LootFill / RHIB do Deep Sea
if (lootFill.GetComponent<RHIB>() is not RHIB rHIB ||
    Interface.CallHook("ShouldBLPopulate_Container", rHIB.net.ID) != null)
    return false;
```

### 4.2 O que a documentação erra, e importa

O README diz *"Return true/false to cancel loot population"*. **Está errado nos
dois sentidos**, e cada erro tem consequência:

**1. Não é `true`/`false` — é nulo/não-nulo.** O teste é `!= null`. Devolver
`false` **cancela** tanto quanto devolver `true`. Um plugin que escrevesse
`return allowed;` com `allowed = false` para "deixe popular" produziria o oposto
do que quis. É a mesma armadilha que o `OnLootSpawn` do Rust tem, e que o
`OrigemZItems.cs:3190-3202` documenta no próprio corpo.

**2. "Cancel loot population" não deixa a caixa vazia.** Quando
`PopulateContainer` devolve `false`, o `OnLootSpawn` do BetterLoot devolve `null`
(`:1620-1628`), e aí o `SpawnLoot` do jogo **segue para o `PopulateLoot()`
nativo**. Ou seja: **cancelar o BetterLoot devolve o container ao loot vanilla**,
não a container nenhum. É uma boa notícia e vale explicitar, porque o nome do
hook sugere o contrário.

**3. O tipo do argumento é inconsistente.** Em `:2307` viaja um `ulong`
(`net.ID.Value`); em `:2321`, um `NetworkableId` (`net.ID`, sem `.Value`). O
Oxide casa hooks por assinatura, então um método
`object ShouldBLPopulate_Container(ulong id)` **não casa** com a chamada do RHIB.
Na prática não nos afeta — o RHIB é o barco do Deep Sea —, mas é o tipo de coisa
que faz um plugin "funcionar em tudo menos numa caixa" e ninguém achar o motivo.

**4. O hook entrega um id, não a entidade.** Para saber qual prefab é aquele
container, o nosso plugin precisaria de
`BaseNetworkable.serverEntities.Find(...)` a cada população — e o **[E§2.6]**
mediu que isso é **da ordem de 6.400 populações por dia só de barril**. É custo
por chamada onde hoje há a leitura de um dicionário.

### 4.3 A armadilha da capacidade — o achado que muda o desenho

> #### &nbsp;&nbsp;UM CONTAINER QUE O BETTERLOOT POPULOU FICA SEM SLOT LIVRE&nbsp;&nbsp; ####
>
> **Medido no fonte do plugin.** A última coisa que o `PopulateContainer` faz,
> antes de devolver `true`, é encolher a capacidade do container para o número
> exato de itens que ele pôs:
>
> ```csharp
> // BetterLoot.cs:2665-2666
> if (clearContainer)
>     container.capacity = container.itemList.Count;
> ```
>
> (`clearContainer` é `true` no caminho do `OnLootSpawn` — `:2335`.)
>
> **Medido no IL do jogo**, com `dnfile` sobre o `Assembly-CSharp.dll` deste
> servidor:
>
> - `ItemContainer` tem o campo `capacity` (é um dos 22 campos do tipo);
> - `ItemContainer::IsFull` (RVA `0x256c88`) compara, nos **dois** ramos,
>   `itemList.get_Count()` contra `capacity` — o teste de partida é
>   `Count >= capacity`;
> - `Item::MoveToContainer` (RVA `0x25499c`, 1.590 bytes de IL) **lê `capacity`
>   duas vezes**, e a segunda leitura governa o laço que procura slot: o índice é
>   incrementado e comparado com `capacity` num `blt.s` de volta ao começo do
>   laço.
>
> **A consequência é direta e silenciosa.** O `InjectLoot` do nosso plugin faz:
>
> ```csharp
> // Plugins/OrigemZItems.cs:3379
> if (!item.MoveToContainer(inventory, -1, true, false, null, true))
> ```
>
> Com `capacity == itemList.Count`, **não existe slot livre**, o `MoveToContainer`
> devolve `false`, e o código cai no ramo de desistência (`:3380-3387`): o item é
> removido e o orçamento do dia é devolvido.
>
> **O sintoma seria o pior possível:** a tela mostraria `rolls` e `hits` subindo
> normalmente, `spawned` sempre voltando a zero, e **nenhum troféu no mundo** —
> sem erro, sem log, sem nada para procurar. Exatamente o defeito silencioso e
> tardio que o **[E§4.2]** descreve.
>
> **O único caminho que ainda funcionaria** é empilhar sobre um item de mesma
> definição já presente na caixa (`MoveToContainer` com `allowStack = true`
> procura `FindItemsByItemID` antes de procurar slot). Para um item raro, isso
> não acontece na prática — e para o troféu, empilhar seria errado de qualquer
> jeito.
>
> **Isto não foi testado ao vivo**, porque o BetterLoot não está instalado. É
> medição de duas fontes independentes (o fonte do plugin e o IL do jogo) e uma
> dedução de uma linha entre elas.

### 4.4 O segundo efeito não documentado: o refresh de loot morre

> #### &nbsp;&nbsp;CANCELAR O `OnLootSpawn` TAMBÉM CANCELA O CRONÔMETRO DE REFRESH&nbsp;&nbsp; ####
>
> **Medido no IL de `LootContainer::SpawnLoot`** (RVA `0x1f6f5c`, 96 bytes). A
> sequência inteira, decodificada:
>
> ```
> if (IsDestroyed) return;
> if (inventory == null) { Log(...); return; }
> inventory.Clear();
> DoRemoves(false);
> if (Interface.CallHook("OnLootSpawn", this) != null) return;   <-- aqui
> PopulateLoot();
> CancelLootRefreshCountdown();
> if (shouldRefreshContents) StartLootRefreshCountdown(null);
> ```
>
> O `return` do hook fica **antes** das três últimas linhas. E `PopulateLoot`
> (RVA `0x1f70b4`) faz mais do que encher a caixa:
>
> ```
> inventory.FillLoot(lootDefinition, maxDefinitionsToSpawn, LootSpawnSlots);
> if (SpawnType == 5 || SpawnType == 2)  // sorteio de condição dos itens
>     foreach (item in inventory.itemList) if (item.hasCondition)
>         item.condition = Range(info.foundCondition.fractionMin,
>                                info.foundCondition.fractionMax) * info.condition.max;
> GenerateScrap();
> HasBeenLooted = false;
> FirstLooterId = 0;
> ```
>
> Cruzando com o que o BetterLoot repõe:
>
> | O que o cancelamento pula | O BetterLoot repõe? |
> |---|---|
> | `FillLoot` — a tabela nativa | **sim**, é o ponto |
> | sorteio de condição dos itens | **parcialmente** — só onde o admin preencher `Item Durability` (`:1255-1256`) |
> | `GenerateScrap()` | **sim** — `Minimum/Maximum Scrap Amount` por container, autogerado de `scrapAmount` (`:2000-2001`) |
> | `HasBeenLooted = false` / `FirstLooterId = 0` | **não** |
> | `CancelLootRefreshCountdown()` | **não** |
> | **`StartLootRefreshCountdown()`** | **não** |
>
> **A última linha é a grave.** Medido: `StartLootRefreshCountdown` (RVA
> `0x1f6fc8`) faz `Invoke(actionSpawnLoot, currentLootCountdownLength)`, e
> `actionSpawnLoot` (RVA `0x1f6cf0`) é um delegate para o próprio `SpawnLoot`. Uma
> varredura em todo o `Assembly-CSharp.dll` por quem chama
> `StartLootRefreshCountdown` devolveu **quatro** chamadores:
> `LootContainer::SpawnLoot`, `LootContainer::Load`,
> `RespawnableLootFridge::AdvanceRefreshCycle` e `RespawnableLootFridge::Load`.
>
> Para um `LootContainer` comum, portanto, **só há dois caminhos**: o `SpawnLoot`
> (pulado) e o `Load(fromDisk)` da restauração do save (RVA `0x1f7594`).
>
> **O efeito líquido:** num prefab gerenciado pelo BetterLoot, o container nasce
> (`ServerInit` chama `SpawnLoot`, RVA `0x1f6df4`), o hook cancela, e **nenhum
> cronômetro é iniciado**. O container nunca refaz o loot. Depois de um restart,
> o `Load` reinicia o cronômetro; quando ele dispara, chama `SpawnLoot`, o hook
> cancela de novo, e nenhum cronômetro novo nasce. **Na prática: no máximo um
> refresh por restart de servidor.**
>
> **O tamanho disso, com o número do [E§2.6]:** **71 dos 105 containers** têm
> refresh finito, tipicamente de **3600 a 7200 s**. Os barris de mundo aberto
> refazem o loot a cada 1 a 2 h. Com o BetterLoot ativo neles, isso **para**.
>
> Um servidor de wipe semanal com restart diário troca "barril refaz a cada 90
> min" por "barril refaz uma vez por dia". **Isso muda a rota de farm do
> servidor**, e não está escrito em lugar nenhum da documentação do plugin.
>
> **Duas ressalvas honestas.** Primeira: não testei ao vivo — é IL mais fonte.
> Segunda: pode ser que a comunidade conviva bem com isso porque servidores
> modded costumam ter mais containers e wipes curtos. **Mas quem decide isso é o
> dono, e ele precisa do número antes.** É a pergunta **Q1**, e ela é bloqueante.

### 4.5 Coexistir por container: as três chaves, e o que cada uma faz

A boa notícia do §4.2 tem consequência prática: **o escopo do BetterLoot é
ajustável por prefab, por três chaves independentes**, e qualquer uma delas
devolve o container ao loot nativo.

| Chave | Onde | Efeito quando desligada |
|---|---|---|
| `Watched Container Prefabs[caminho] = false` | `BetterLoot.json` (`:1622`) | o hook devolve `null` **imediatamente** — custo zero |
| `Is Prefab Enabled? = false` | `LootTables.json` (`:2343`) | `PopulateContainer` devolve `false` — o loot nativo roda |
| `ShouldBLPopulate_Container` devolve não-nulo | o nosso plugin (`:2307`) | idem, mas decidido **em runtime, por container** |

> #### &nbsp;&nbsp;E É ASSIM QUE AS DUAS PEÇAS CONVIVEM SEM CONTAR O TROFÉU DUAS VEZES&nbsp;&nbsp; ####
>
> A pergunta do pedido era como evitar que o troféu saia por dois caminhos. **A
> resposta é que ele não deve ter dois caminhos, e a escolha é por container.**
>
> São **três desenhos possíveis**, e eles não são equivalentes:
>
> **(a) O troféu entra só pelo BetterLoot.** A entrada `discord.trophy{1}` com
> `Skin ID` vai para o `Ungrouped Items` dos containers escolhidos, e a nossa
> regra de loot para aquele prefab é **desligada**. Ganha: uma fonte só, zero
> risco de dobrar, zero custo por população. Perde: **teto por dia, cooldown por
> jogador, modo `measuring` e a medição inteira** (§3.5).
>
> **(b) O troféu entra só pelo nosso hook, e o BetterLoot não vigia aquele
> prefab.** Ganha: tudo do §3.5 continua valendo, e o `InjectLoot` funciona
> porque o container tem `capacity` normal. Perde: naquele container o loot
> continua sendo o vanilla — nada de multiplicador, blueprints ou "remover lixo".
>
> **(c) Os dois no mesmo container.** É o que a armadilha do §4.3 impede pelo
> caminho ingênuo. Para funcionar, o `InjectLoot` teria de **abrir espaço antes
> de mover** — ler `inventory.capacity`, incrementar, mover, e deixar a
> capacidade maior. É de uma linha, mas é uma linha que mexe num campo que o
> plugin de terceiro acabou de escrever, e o resultado é uma caixa com um slot a
> mais do que o BetterLoot pretendia.
>
> **A recomendação é (a) para o loot comum e (b) para o item medido.** Concreto:
> o BetterLoot vigia os containers de farm, onde o valor está no volume e na
> configuração; os containers onde o item raro precisa de teto e medição — que
> são poucos — ficam fora do `Watched Prefabs`, com o loot nativo mais o nosso
> hook. **O admin não escolhe isso item a item: ele escolhe container a
> container**, e a tela mostra de quem é cada caixa.
>
> **(c) fica registrada como possível, e não recomendada para a primeira
> versão.** Ela é a pergunta **Q2**.

---

## 5 — Como a configuração chega ao plugin

### 5.1 Os caminhos no disco

O agente já resolve a pasta de cada servidor em `resolveServerPaths`
(`core/src/config.ts:587-599`), que devolve `pluginsDir` (`:594`) e
`oxideConfigDir` (`:595`). **Não há helper para `oxide/data`** — quem precisa dele
o monta à mão, como o wipe faz em `core/src/wipe/plugin-data.ts:330`.

Os quatro alvos, a partir de `installDir`:

| Arquivo | A partir de |
|---|---|
| `BetterLoot.json` | `oxideConfigDir` — **já existe** |
| `LootTables.json`, `LootGroups.json`, `Blacklist.json` | `installDir` + `oxide` + `data` + `BetterLoot` — **novo** |

O `server01` tem a árvore completa (`oxide` com `config`, `data`, `lang`, `logs`,
`plugins`), 8 configs e 11 plugins — e **nenhum BetterLoot** em nenhum dos dois.

### 5.2 O que o projeto já sabe fazer, e o que é território novo

**`oxide/config/BetterLoot.json` é gravável hoje, sem uma linha de código nova.**
A cadeia existe e está testada:

`PUT /api/servers/:id/plugin-configs/BetterLoot`
(`core/src/http/routes/plugins.ts:303`) chama `PluginLibrary.configWrite`
(`core/src/oxide/library.ts:1077-1107`), que faz, nesta ordem:

| Passo | Onde |
|---|---|
| 1. teto de bytes (`MAX_CONFIG_BYTES = 256 KB`) | `library.ts:1084-1091`, const em `plugin-config.ts:74` |
| 2. `assertValidJson` — nada vai ao disco sem `JSON.parse` | `library.ts:1093`, `plugin-config.ts:219-240` |
| 3. **backup obrigatório** — e falha no backup **aborta a escrita** | `library.ts:1095`, `plugin-config.ts:253-299` (`:284-296`) |
| 4. `writePluginConfig`, com trava dupla anti-traversal | `library.ts:1097`, `plugin-config.ts:302-319`, caminho em `:99-123` |
| 5. `oxide.reload`, **só se o plugin estiver ligado ali** | `library.ts:1099`, `:1147-1160` |
| 6. **relê do disco** — porque o plugin reescreve | `library.ts:1106` |

**`oxide/data/BetterLoot/*.json` é o primeiro caso do projeto.** A política atual
está escrita no código: *"`oxide/config/<Nome>.json` e `oxide/data/` NÃO são
tocados"* (`core/src/oxide/library.ts:27` e `:1236`). Grep exaustivo confirma:
nenhum `writeFile` aponta para `oxide/data` além do `mkdir` da instalação do
Oxide (`core/src/oxide/install.ts:277-279`).

> **O que isso custa, e é pouco:** um `oxideDataDir` em `resolveServerPaths`
> (`config.ts:587`), e um módulo espelhando `plugin-config.ts` — **a mesma trava
> dupla de caminho, o mesmo `assertValidJson`, o mesmo backup-antes-de-gravar**.
> Copiar o molde não é preguiça: é o que garante que o arquivo novo herde as três
> defesas que o antigo já tem.

### 5.3 Como o BetterLoot recarrega — e escrever o arquivo não basta

Os três arquivos de dados são lidos **uma vez**, no `Loaded()` (`:413-422`), e a
tabela é construída no `OnServerInitialized` (`:424-440`) via `InitLootSystem`
(`:442-467`). **Não existe comando que releia o arquivo do disco.**

O inventário completo dos caminhos de recarga:

| Caminho | Relê o arquivo do disco? |
|---|---|
| `oxide.reload BetterLoot` | **sim** — `Loaded()` roda de novo |
| `/looty <id>` ou `looty <id>` por RCON (`:3003`, `:3021`) | **não** — baixa de `looty.cc/api/fetch-loot-table` (`:3054`), substitui em memória e **grava por cima** do nosso arquivo |
| `/bl-restore` (`:3180`, `:3199`) | **não** — restaura o `.bak` e chama `InitLootSystem(true)` (`:3218`) |
| `/bl-backup` (`:3176`, `:3195`) | não recarrega nada |
| `/blacklist additem` (`:3212`) | edita em memória e salva |

**Portanto: escrever o arquivo e dar `oxide.reload BetterLoot`.** É exatamente o
passo 5 do `configWrite`, e a função já existe:
`reloadPlugin(rcon, 'BetterLoot')` em `core/src/oxide/plugins.ts:322-324`, com
detecção de falha de compilação em `:176-184`.

> #### &nbsp;&nbsp;E O COMANDO `looty` É UMA PORTA QUE PRECISA FICAR FECHADA&nbsp;&nbsp; ####
>
> O `[ConsoleCommand("looty")]` exige `arg.IsRcon` (`:3023-3027`) — ou seja, **o
> nosso agente pode chamá-lo**. E ele faz uma requisição HTTP a `looty.cc` e
> sobrescreve `LootTables.json` e `LootGroups.json` com o que voltar (`:3110`,
> `:3146`).
>
> **Isto é uma segunda fonte de verdade, operada por um terceiro.** Se alguém com
> permissão `BetterLoot.admin` rodar `/looty <id>` no chat do jogo, a
> configuração que o painel escreveu é substituída, e o nosso banco passa a
> descrever um arquivo que não existe mais.
>
> A defesa é barata e é a mesma de sempre: **o agente relê o arquivo depois de
> aplicar** (§5.4) e a tela mostra quando o disco divergiu do banco. É o mesmo
> padrão do `appliedSha` que a biblioteca de plugins já usa
> (`core/src/oxide/library.ts:498`, `:600`). É a pergunta **Q4**.

### 5.4 O ciclo completo proposto

**Projeto, não medido.** Sete passos, e cada um tem molde no repositório:

| # | Passo | Molde |
|---|---|---|
| 1 | conferir que o BetterLoot está carregado ali | `oxideRuntime.pluginOf(serverId, 'BetterLoot')?.loaded`, `core/src/oxide/runtime.ts:241` |
| 2 | ler o estado atual dos quatro arquivos | novo, molde de `plugin-config.ts` |
| 3 | derivar o JSON a partir do banco | novo |
| 4 | fazer backup dos quatro | `backupPluginConfig`, `plugin-config.ts:253` |
| 5 | escrever os quatro | `writePluginConfig`, `plugin-config.ts:302` |
| 6 | `oxide.reload BetterLoot` | `reloadPlugin`, `plugins.ts:322` |
| 7 | **reler do disco e guardar o que o plugin deixou** | `library.ts:1106` |

O passo 7 não é zelo: é o que torna a tela honesta. Sem ele, o admin vê o que
pediu, e não o que o servidor tem.

### 5.5 O que o wipe faz com esses arquivos — e é preciso decidir antes

O full wipe já enxerga `oxide/data`: `core/src/wipe/plugin-data.ts:330` varre a
pasta até **3 níveis** (`MAX_OXIDE_DEPTH`, `:204`) e lista **só `.json`**
(`:393-402`). A remoção é em `core/src/wipe/run.ts:777`, com backup em zip antes
(`:625-662`).

> **Consequência imediata:** no dia em que o painel escrever
> `oxide/data/BetterLoot/LootTables.json`, ele **aparece sozinho** na tela de full
> wipe, como candidato a apagar. E a política daquele módulo é explícita —
> *"NUNCA `del *.json`"* (`plugin-data.ts:5-13`), nada vem marcado por padrão.
>
> Mesmo assim, **apagar aquele arquivo no wipe seria um desastre discreto**: o
> BetterLoot o regeneraria do loot nativo no boot seguinte, e toda a configuração
> do admin sumiria sem erro nenhum. A tela de wipe precisa **marcar esse arquivo
> como "gerado pelo painel, não apague"**, ou o agente precisa reescrevê-lo
> depois do wipe. É a pergunta **Q5**.

---

## 6 — Onde a configuração mora do nosso lado

### 6.1 As duas opções, com o custo de cada uma

| | **O JSON é a verdade** (nós só editamos) | **O banco é a verdade** (o JSON é derivado) |
|---|---|---|
| como o painel lê | lê o arquivo do servidor a cada abertura | lê o banco |
| como o painel escreve | reescreve o arquivo | grava no banco e **aplica** |
| desfazer | só o `.bak` do plugin, um nível, sobrescrito | histórico completo, se houver tabela para isso |
| comparar dois servidores | abrir dois arquivos | uma consulta |
| um servidor fora do ar | **não dá para editar** | edita e aplica quando voltar |
| divergência | impossível por construção | **possível, e precisa ser detectada** |
| custo | quase zero | uma migração e um derivador |

### 6.2 O fato que decide, e ele não estava na pergunta

> #### &nbsp;&nbsp;"O JSON É A VERDADE" NÃO É UMA OPÇÃO DISPONÍVEL&nbsp;&nbsp; ####
>
> Ela pressupõe que o arquivo que se escreve é o arquivo que fica. **Não é.**
> Medido no §2.6: o plugin reescreve os quatro arquivos depois de ler (`:780`),
> apaga tabelas de prefab inexistente (`:2192-2200`), remove attachments
> incompatíveis (`:2140-2145`), preenche e apaga `Can Convert To Blueprint`
> (`:2076-2085`) e cria `Item Durability` onde falta (`:2096-2101`).
>
> E há mais três escritores no mesmo arquivo: o comando `/looty` (§5.3), o
> `/bl-restore`, e o `/blacklist`.
>
> **Um arquivo com quatro escritores, um dos quais reescreve tudo a cada boot, não
> é fonte de verdade — é um efeito.** O que se pode fazer com ele é observá-lo.

### 6.3 A recomendação: espelho, não cópia nem fonte

> #### &nbsp;&nbsp;O BANCO GUARDA A INTENÇÃO; O DISCO GUARDA O EFEITO; A TELA MOSTRA OS DOIS&nbsp;&nbsp; ####
>
> **O banco guarda o que o admin pediu** — a intenção, versionável, comparável
> entre servidores, editável com o servidor fora do ar.
>
> **O disco guarda o que o plugin aceitou.** Depois de aplicar, o agente relê e
> guarda o resultado num **cache com carimbo de data** — não numa tabela de
> domínio. É a mesma distinção que o **[E§5.2]** fez para a tabela extraída do
> jogo: *"ela é cache, não cadastro"*.
>
> **A tela mostra a diferença quando ela existir.** *"Você pediu `rifle.ak` com
> mira holográfica; o plugin removeu a mira porque ela não cabe nessa arma."*
> Sem isso, o admin edita, salva, e a mira some sem explicação — e ele conclui que
> o painel não funciona.
>
> **O precedente é literal e está a três arquivos de distância.** O
> `PluginLibrary.configWrite` já faz exatamente isso para qualquer plugin: escreve,
> recarrega e **relê do disco** (`core/src/oxide/library.ts:1106`), com o comentário
> em `core/src/oxide/plugin-config.ts:16-28` explicando o porquê. **Não é padrão
> novo — é o padrão da casa aplicado a um arquivo a mais.**

### 6.4 O custo, dito inteiro

Não é grátis, e as três parcelas são:

**1. Um derivador.** Uma função que transforma as linhas do banco no JSON do
BetterLoot. Ela precisa conhecer os nomes de chave do §2 — e **eles mudam entre
versões do plugin** (`"Blueprint Probability"` virou
`"Blueprint Weight (...)"` na 4.2.1; `"Watched Prefabs"` virou
`"Watched Container Prefabs (...)"` na 4.1.7). **O derivador é a superfície de
quebra da dependência** (§8.3).

**2. Uma migração.** Duas tabelas, no molde da 041: uma de configuração por
container e uma de junção com servidor. Elas **não** substituem a 048 (§7.5).

**3. A detecção de divergência.** Ler o disco, comparar, mostrar. É o passo 7 do
§5.4 mais uma tela.

> **E uma parcela que NÃO se paga, e vale dizer:** não é preciso guardar a
> tabela do jogo. O BetterLoot a autogera (§2.6). O que o banco guarda é a
> **diferença** entre o que o plugin gerou e o que o admin quis — e o **[E§5.3]**
> já mediu que isso é a diferença entre ~10 KB e ~164 KB por servidor.

---

## 7 — O que fazer com o que já existe

### 7.1 A correção de premissa: a fatia não está interrompida

O pedido descreveu a migração 048 e os quatro arquivos de `core/` como *"uma
fatia que foi interrompida"*. **Medido na árvore desta sessão: ela está completa e
ligada de ponta a ponta.** Não há um único arquivo órfão.

A cadeia, verificada arquivo por arquivo:

```
core/src/db/migrations.ts:4987        { id: 48, name: 'loot-rules', sql: LOOT_RULES_SCHEMA }
  -> core/src/db/loot-rules-repository.ts     590 linhas, as 3 tabelas lidas E escritas
      -> core/src/index.ts:559                new LootRulesRepository(db)
          -> core/src/http/server.ts:501      registerLootRoutes(api, ...)   [prefixo /api em :626]
          -> core/src/game/custom-items-sync.ts:562, :593   origemz.loot.clear / origemz.loot.set
          -> core/src/game/loot-stats.ts:82   origemz.loot.stats, relógio de 60 s (index.ts:1424)
  -> Plugins/OrigemZItems.cs:2997, :3083, :3139   os três comandos
  -> Plugins/OrigemZItems.cs:3222 OnLootSpawn  +  :1673 OnLootEntity
  -> panel/src/lib/api.ts:4030-4062   seis funções, uma por rota
      -> panel/src/app/loot/page.tsx:55  (300 linhas, duas abas)
          -> panel/src/components/sidebar.tsx:154   href '/loot/'
```

Números: **590** linhas de repositório, **416** de rotas, **277** de coletor,
**129** de catálogo de containers, **300** de página e **2.937** distribuídas em
**nove** componentes em `panel/src/components/loot/`. Testes: **três** arquivos no
painel (`panel/test/loot-*.test.ts`, 453 linhas, 53 casos) e **nenhum** no
`core/`.

### 7.2 O que aproveita, e aproveita inteiro

| O que | Por que sobrevive |
|---|---|
| **a migração 048 e as três tabelas** | elas descrevem teto por dia, cooldown, modo `measuring` e telemetria — **exatamente o que o BetterLoot não tem** (§3.5) |
| **`core/src/db/loot-rules-repository.ts`** | mesma razão; nada nele fala de BetterLoot nem de tabela do jogo |
| **`core/src/game/loot-stats.ts`** e o comando `origemz.loot.stats` | a medição continua sendo nossa, e continua sendo o único número real sobre o que aconteceu no mundo |
| **`OnLootSpawn` e `InjectLoot` do `OrigemZItems.cs`** | é o desenho (b) do §4.5 — a via do item medido, nos containers que o BetterLoot não vigia. **Com uma ressalva: o §4.3** |
| **`OnLootEntity` (a Via B) e o cooldown por jogador** | o BetterLoot não conhece jogador; isto não tem substituto |
| **`panel/src/components/loot/chance.ts`** (301 linhas) | a tradução de "1/5000" em "1 por semana" é o que o **[E§8.4]** pediu, e ela vale igual para uma probabilidade do BetterLoot |
| **`panel/src/components/loot/containers.ts`** (386 linhas, 8 grupos) | a taxonomia de containers é a mesma; muda a **chave**, não o agrupamento |
| **as seis rotas e as seis funções de `api.ts`** | nada nelas presume o motor |

### 7.3 O que vira outra coisa

| O que | No que vira |
|---|---|
| **`core/src/game/loot-containers.ts`** (33 containers, chaveado por `ShortPrefabName`) | **precisa de uma segunda chave**: o caminho completo do prefab (§2.3). A lista estática vira, ou uma lista com dois campos, ou o índice do que o BetterLoot gerou |
| **a lista de containers da tela** | deixa de ser 33 escolhidos à mão e passa a ser **o que o `LootTables.json` daquele servidor tem** — que é o que o BetterLoot vigia de verdade |
| **`panel/src/app/loot/page.tsx`**, hoje com duas abas (`regras`, `conteineres`) | ganha a terceira dimensão: por container, **de quem é aquela caixa** — do BetterLoot, do jogo, ou das nossas regras |
| **a duplicação de taxonomia** entre `loot-containers.ts:55` (6 grupos em português) e `panel/.../containers.ts:36` (8 ids em inglês) | ela era tolerável com uma lista fixa; com a lista vindo do servidor, **a fonte passa a ser uma só** |

### 7.4 O que fica órfão

**Quase nada, e é preciso dizer isso com clareza porque a expectativa era outra.**

| O que | Por quê |
|---|---|
| nada em `core/` | nenhum arquivo perde a razão de existir |
| nada no plugin | os três comandos e os dois hooks continuam sendo a via do item medido |
| **um risco, não um arquivo:** o `InjectLoot` em container gerenciado | pela armadilha do §4.3, ele **falha em silêncio**. Ou o container fica fora do BetterLoot (desenho **b**), ou o `InjectLoot` ganha a linha que abre espaço (desenho **c**) |

> #### &nbsp;&nbsp;A LEITURA HONESTA DESTE PARÁGRAFO&nbsp;&nbsp; ####
>
> O trabalho que está na árvore **não foi desperdiçado pela mudança de
> estratégia** — mas ele também **não é o que o dono pediu agora**. Ele entrega
> *"pôr um item nosso no loot, com teto e medição"*. O pedido de hoje é
> *"configurar todo o loot do jogo"*.
>
> São duas features, e a segunda não contém a primeira. O que este documento
> propõe é que elas **fiquem lado a lado**, com a fronteira desenhada por
> container (§4.5) — e não que uma substitua a outra.

### 7.5 A migração 048 fica exatamente como está

> **Nenhuma migração aplicada é editada. A 043 existe por causa desse erro.**
>
> A 048 já está no banco de produção. Ela descreve `loot_rules`,
> `loot_rule_servers` e `loot_rule_hits`, e **as três continuam descrevendo
> exatamente o que descreviam**: as regras de item custom com teto, cooldown, modo
> e medição. Nada nelas menciona BetterLoot, e nada nelas fica errado.
>
> A configuração do BetterLoot é **outra coisa** e pede **outra migração** — a
> próxima livre. O comentário dela deve dizer, com todas as letras, **por que são
> duas** e não uma: porque uma governa o item raro medido, e a outra governa o
> loot do servidor inteiro. Sem essa frase, alguém vai tentar fundir as duas em
> seis meses.

---

## 8 — O risco da dependência, sem maquiar

> Esta seção existe porque o dono precisa decidir de olhos abertos. Nada aqui é
> suavizado.

### 8.1 Os números, medidos na API do GitHub

| Medida | `magic-services-co/Better-Loot` (o atual) | `TGWA0/BetterLoot-UMod` (o anterior) |
|---|---|---|
| criado em | **01/08/2026** | 30/12/2025 |
| último push | 01/09/2026 | 08/08/2026 |
| **arquivado?** | não | **sim** |
| **estrelas** | **1** | 3 |
| forks | 1 | — |
| issues abertas | 0 | — |
| **commits** | **6** | — |
| contribuidores | 3 (`MrDaviddddd`, `TGWA0`, `vinnij`, 2 commits cada) | — |
| **licença** | **nenhuma** | **nenhuma** |
| arquivos no repositório | **2** (`BetterLoot.cs`, `README.md`) | — |

O histórico inteiro, seis linhas:

```
2026-09-01  Merge pull request #1 from vinnij/main
2026-08-31  Update BetterLoot to version 4.4.0 this version include all my other changes
2026-08-15  Improve blueprint selection and retry mechanism
2026-08-08  v4.3.0 - Holiday containers + satellite crates + guaranteed items overhaul
2026-08-01  Initial
2026-08-01  Initial commit
```

> **Um mês de idade, seis commits, uma estrela — e 3.405 linhas de código que
> decidem o loot inteiro do servidor.** O plugin é bem escrito (usa `Pool`,
> `PooledList`, tem migração de config versionada, backup automático e tratamento
> de erro em cima do IO). O problema não é a qualidade do que está escrito: é
> **quantas pessoas o mantêm**.

### 8.2 A licença — e este é o pior item da lista

> #### &nbsp;&nbsp;NÃO HÁ LICENÇA. NENHUMA.&nbsp;&nbsp; ####
>
> Medido em três lugares: a API do GitHub devolve `"license": null` para os dois
> repositórios; não existe arquivo `LICENSE` (o repositório tem **dois arquivos**);
> e não há cabeçalho de licença no `.cs` (grep por `license|copyright|MIT|GPL|all
> rights reserved`: zero ocorrências relevantes).
>
> **Código publicado sem licença é "todos os direitos reservados" por padrão.** O
> autor mantém o copyright integral. Publicar no GitHub concede o direito de ver e
> de fazer fork **dentro** do GitHub — e nada além disso.
>
> **O que isso permite:** baixar e rodar o plugin no nosso servidor. Isso é o uso
> normal, e é o que todo servidor de Rust faz com todo plugin do uMod.
>
> **O que isso NÃO permite, e é onde o plano B esbarra:** manter uma cópia
> modificada nossa; redistribuir; incorporar trechos dele em código nosso.
> **Exatamente as três coisas que se faria se o plugin morresse.**
>
> Ou seja: **o plano B mais óbvio — "se ele parar, a gente mantém um fork" — é o
> que a ausência de licença bloqueia.** O plano B que sobra é o do §8.4, e ele é
> mais caro.

### 8.3 O que quebra, e como

**Um update do Rust.** O plugin toca superfície larga do jogo: `LootContainer`,
`LootFill`, `LootSpawn`, `ItemModUnwrap`, `ScientistNPC2`, `RHIB`,
`ItemManager`, `GameManifest`, `Rust.Ai.Gen2`. Ele tem um `try/catch` no
`OnServerInitialized` que **descarrega o próprio plugin** se a inicialização
falhar (`:436-439`) — o que é a coisa certa a fazer e também significa que, num
update ruim, **o servidor volta ao loot vanilla sem aviso na nossa tela**.

**Uma mudança de nome de chave.** Já aconteceu duas vezes em quatro meses:
`"Blueprint Probability"` virou `"Blueprint Weight (...)"` (migração 4.2.1,
`:131`), e `"Watched Prefabs"` virou
`"Watched Container Prefabs (...)"` (migração 4.1.7, `:153`). O plugin migra
sozinho o **arquivo dele**; ele não migra o **nosso derivador**, que escreve as
chaves pelo nome. **Uma versão nova pode fazer o nosso painel escrever um arquivo
que o plugin lê e descarta em silêncio.**

**Uma mudança de formato de arquivo.** Já aconteceu: o README diz, em letras
próprias, que *"Old loot table files are **not compatible** with V4"* e manda
converter no `looty.cc/converter`. Uma V5 pode fazer o mesmo.

**O autor parar.** É o cenário mais provável dos quatro, e o único sem sintoma
técnico. Um repositório de 1 estrela e 6 commits mantido por três pessoas em
tempo livre não tem por que continuar existindo.

### 8.4 O plano B, e ele precisa ser preservado de propósito

| Plano | Custo | O que impede |
|---|---|---|
| **manter um fork nosso** | baixo | **a licença** (§8.2) |
| **trocar por outro plugin** (AlphaLoot, pago) | médio — outro formato de arquivo, outro derivador | nada, mas é dinheiro e é outro terceiro |
| **voltar ao desenho do `05`** — complementar, com o nosso hook | **já está construído** (§7.1) | nada |
| **escrever o nosso motor de loot** | alto — os nove itens do **[E§4.2]** | nada, mas é o que a decisão de hoje quis evitar |

> #### &nbsp;&nbsp;O TERCEIRO PLANO É O ÚNICO QUE JÁ EXISTE, E ELE PRECISA SER MANTIDO VIVO&nbsp;&nbsp; ####
>
> A fatia do §7.1 — migração, repositório, rotas, painel e os dois hooks — é o
> plano B **já pago**. Se o BetterLoot morrer amanhã, o servidor volta ao loot
> vanilla mais as nossas regras, e o item custom continua saindo com teto e
> medição. Perde-se a configuração do loot geral; não se perde o produto.
>
> **Isso só continua verdadeiro enquanto aquele caminho não apodrecer.** Se a
> primeira fatia da nova frente arrancar o `InjectLoot` ou desligar o
> `OnLootSpawn` do `OrigemZItems.cs`, o plano B some junto — e ninguém vai
> perceber até precisar dele.
>
> **A recomendação é explícita: não desligar nada do que existe.** O custo de
> manter é o de um hook que sai cedo quando o dicionário está vazio
> (`OrigemZItems.cs:3227-3230`). É perto de zero. O custo de recriar, depois de
> apagado, é o §7.1 inteiro de novo.

### 8.5 O veredito

> **A decisão é defensável, e eu a tomaria também — mas ela é uma aposta, e a
> aposta é numa pessoa, não num software.**
>
> **O que a justifica:** o BetterLoot entrega hoje, de graça, coisas que este
> projeto orçou como caras — a extração da tabela do jogo (**[E§3]**), a resolução
> do ramo vivo (**[E§2.4]**), o vocabulário de grupos, os multiplicadores, os
> attachments, os itens que saem juntos — e entrega **com skin**, que é o que
> nenhum caminho nativo dá (**[L§4]**). Escrever isso do zero é o §4.2 do `05`
> inteiro, e é mais do que uma frente de trabalho.
>
> **O que ela custa, e não se pode dizer que é pouco:** o loot de um servidor de
> produção passa a depender de 3.405 linhas de um repositório de um mês, sem
> licença, com uma estrela. Duas coisas que ele faz — encolher a capacidade do
> container (§4.3) e matar o cronômetro de refresh (§4.4) — **não estão
> documentadas em lugar nenhum** e só apareceram porque o fonte foi lido linha a
> linha. **É razoável supor que haja mais.**
>
> **A mitigação que torna a aposta aceitável é uma só:** o escopo é ajustável por
> container (§4.5), e o plano B já está construído (§8.4). Se o dono aceitar isso,
> a decisão é sólida. Se a primeira fatia apagar o caminho antigo para "limpar",
> a decisão vira irreversível — e aí ela deixa de ser defensável.

---

## 9 — A tela

> Descrita, não implementada. A referência é o Looty, que o dono mostrou; o
> critério é o mesmo do **[E§8]**: *"totalmente fácil para o admin configurar e
> achar as categorias certas"*.

### 9.1 O que o Looty faz — a leitura do que o dono mostrou

Três colunas: containers com busca à esquerda (categoria embaixo do nome), o
container selecionado no centro (min/máx de itens, blueprints, scrap, os toggles,
multiplicadores 2x/5x/10x, "remover lixo", perfis associados) e categorias de
itens à direita.

**O desenho de três colunas está certo e deve ser copiado**, porque ele espelha a
estrutura do arquivo: `LootTables.json` é chaveado por container (esquerda), cada
valor tem `Item Settings` e `Loot Profiles` (centro), e o `Ungrouped Items` é
preenchido a partir do catálogo (direita).

**Uma correção ao que a coluna do meio sugere.** Os multiplicadores 2x/5x/10x do
BetterLoot são **globais e inteiros**, não por container (§2.2). Um controle de
multiplicador dentro da tela de um container **mentiria**, do mesmo jeito que a
tela que mostrasse o ramo morto mentiria no **[E§8.3]**. Ou ele sobe para uma
faixa de configuração do servidor, ou o controle por container edita os `Item
Minimum` / `Item Maximum` das entradas — e aí precisa dizer isso.

### 9.2 A nossa versão

**Uma página, três colunas, e uma faixa de servidor no topo.**

**A faixa do topo — o que é global.** `Loot Multiplier`, `Scrap Multipler`,
`Blueprint Weight`, `Enable Blueprint Conversion`, e o estado do plugin naquele
servidor (carregado, versão, quando foi aplicado). É onde os 2x/5x/10x moram de
verdade, com o aviso de que valem para o servidor inteiro.

**A coluna da esquerda — os containers.** Busca por nome, categoria embaixo, e
**três marcadores por linha** que o Looty não tem como ter:

| Marcador | O que diz |
|---|---|
| de quem é a caixa | **BetterLoot** · **jogo** (não vigiado) · **jogo + regra nossa** |
| quantas regras nossas apontam para ela | do `loot_rules.containers` |
| se o disco divergiu do banco | do passo 7 do §5.4 |

**A coluna do meio — o container.** `Minimum/Maximum Amount of Items`,
`Minimum/Maximum Scrap Amount`, `Minimum/Maximum Blueprints`, os quatro toggles
(`Is Prefab Enabled?`, `Enable Loot Pool Locking`, `Select ungrouped items
ignoring rarity bias`, e os dois "contribuem para a contagem"), os `Loot
Profiles` associados com a probabilidade de cada um, e a lista de `Ungrouped
Items` com probabilidade, min/máx e skin.

**A coluna da direita — o catálogo.** O `item-picker-dialog.tsx` que já existe
(204 linhas, grade de ícones, busca, filtro por categoria, `PAGE_SIZE = 120`), com
uma aba a mais: **os nossos itens custom**, que entram com o `Skin ID` já
preenchido.

**E duas telas que não são colunas:** os **grupos** (`LootGroups.json`), que são
reutilizáveis e por isso não cabem dentro de um container; e a **lista de
banidos** (`Blacklist.json`), que é uma lista simples e global.

### 9.3 O que dá para fazer melhor que o Looty — e por que

> #### &nbsp;&nbsp;TRÊS VANTAGENS, E NENHUMA DELAS É ESTÉTICA&nbsp;&nbsp; ####
>
> **1. O catálogo vem do servidor de verdade.** O Looty e o *AlphaLoot Profile
> Editor* leem os bundles do cliente do Rust para montar a lista de itens. **Nós
> já temos algo melhor e está pronto:** o catálogo vem do próprio servidor por
> `origemz.items` (`core/src/game/item-catalog.ts:87`, páginas de 250) e mora na
> tabela `items` — **1.259 itens**, conferidos contra o dump dos bundles no
> **[E§7.3]**, que achou os mesmos 1.259. Um item que a Facepunch acrescentar
> aparece na nossa tela **no boot seguinte**, sem ninguém atualizar editor nenhum.
>
> **2. A lista de containers é a daquele servidor.** O Looty tem de trabalhar com
> uma lista genérica. Nós lemos o `LootTables.json` que o BetterLoot **gerou
> naquele servidor** (§2.6) — com os prefabs que aquele build tem, o filtro de era
> já aplicado e o ramo vivo já resolvido. **A tela não mostra caixa que não
> existe, e não esconde caixa que existe.**
>
> **3. Aplicar é um `writeFile` e um `oxide.reload`.** O fluxo do Looty é
> *baixar → `/looty <id>` → o servidor busca em `looty.cc`*. O nosso é escrever
> quatro arquivos e recarregar — **sem HTTP para fora, sem id, sem intermediário,
> e com backup obrigatório antes** (`plugin-config.ts:284-296`). Um servidor sem
> internet de saída continua configurável.
>
> **E uma quarta, que é a nossa e mais ninguém tem:** **a medição do que
> aconteceu**. O `loot_rule_hits` (migração 048) guarda `rolls`, `hits`,
> `spawned` e `blocked` por dia, coletados a cada 60 s
> (`core/src/game/loot-stats.ts:91`). O Looty mostra o que **deveria** sair; nós
> podemos mostrar o que **saiu**. Isso hoje vale só para as nossas regras — mas é
> a base para responder *"a chance de 1/5000 está dando quantos por semana?"*, que
> é a pergunta que o admin realmente tem.
>
> **O que NÃO dá para fazer melhor, e é honesto dizer:** simular o sorteio do
> BetterLoot exigiria reimplementar o `ProbalisticRNG` (`:832-863`), o
> `MightyRNG`, o `UngroupedFlatSelect` e o *loot pool locking* no painel — que é
> reescrever o motor para prever o motor. A saída barata e honesta é a
> aritmética: *"probabilidade efetiva desta entrada = a dela dividida pela soma do
> conjunto"*, mostrada ao lado do número digitado (§1.4). É a pergunta **Q6**.

### 9.4 O vocabulário

O **[E§7.2]** recomendou adotar os termos do AlphaLoot. **Isso muda:** se a
ferramenta edita o BetterLoot, o vocabulário tem de ser o do BetterLoot, ou o
admin não consegue seguir nenhum tutorial nem pedir ajuda no Discord deles.

| Termo do BetterLoot | Onde vive | Como chamar na tela |
|---|---|---|
| **Loot Table** | uma entrada de `LootTables.json` | *a caixa* / *o container* |
| **Loot Profile** / **Loot Group** | uma entrada de `LootGroups.json` | *grupo* |
| **Ungrouped Items** | os itens avulsos da caixa | *itens da caixa* |
| **Guaranteed Items** | os que saem sempre | *itens garantidos* |
| **Bonus Items** | os que saem junto de outro | *itens que vêm junto* |
| **Watched Prefabs** | quem o plugin gerencia | *caixas gerenciadas* |

> O plugin usa **"Loot Profile"** e **"Loot Group"** para a mesma coisa — a classe
> é `LootProfile` (`:1137`), o arquivo é `LootGroups.json`, e o campo que a
> importa é `Loot Profile Name` (`:906`). **A tela deve escolher um** e ficar com
> ele, ou reproduz a confusão do original.

---

## 10 — O caminho em fatias

### 10.1 A primeira fatia, e ela entrega valor sozinha

> **Fatia 1 — instalar o BetterLoot num servidor e LER o que ele gerou.**
>
> Sem escrever nada. O agente instala o plugin pelo caminho que já existe
> (`installPlugin`, `core/src/oxide/plugins.ts:337`), o plugin autogera o
> `LootTables.json` a partir do loot nativo (§2.6), e o painel **lê e mostra**:
> as caixas daquele servidor, o que cada uma põe, quanto scrap, quantos
> blueprints, quantos itens.

**Por que esta e não outra.** Ela entrega, sozinha, **exatamente o que o
[E§10.2] chamou de Fatia 2 e orçou como a mais cara do projeto** — *"a tela passa
a mostrar o que o jogo põe"*. E entrega com risco de leitura: nada é escrito, e
desligar o plugin devolve o servidor ao que era.

**E ela é a fatia que decide a Q1.** Com o plugin rodando num servidor de teste,
as duas medições que faltam saem em uma tarde: o refresh para mesmo (§4.4)? A
capacidade fica encolhida (§4.3)? **São as duas perguntas que este estudo não
pôde responder por não ter o plugin instalado, e a Fatia 1 as responde de graça.**

**O que ela deixa de fora:**

| Fica de fora | Consequência |
|---|---|
| escrever qualquer coisa | é só leitura — o admin vê e não muda |
| a migração da configuração | o banco ainda não guarda nada disto |
| os grupos e a blacklist | ficam para a fatia 3 |
| a convivência com as nossas regras | o servidor de teste não precisa dela |

### 10.2 As fatias seguintes

| # | Fatia | Entrega | Depende de |
|---|---|---|---|
| **1** | instalar e **ler** o `LootTables.json` gerado | a tela que o `05` orçou como a mais cara | nada |
| **2** | escrever `BetterLoot.json` (a faixa global: multiplicadores, blueprints) | os 2x/5x/10x do pedido | 1 — e usa **só** o que já existe em `oxide/config` (§5.2) |
| **3** | escrever `LootTables.json` — itens, min/máx, scrap, skin | o pedido inteiro, e o troféu pelo BetterLoot | 2, **Q3** (onde a config mora) |
| **4** | `LootGroups.json` e `Blacklist.json` | grupos e "remover lixo" | 3 |
| **5** | a fronteira por container: de quem é cada caixa | a convivência do §4.5 | 3, **Q2** |
| **6** | detecção de divergência disco/banco | a tela deixa de mentir quando alguém roda `/looty` | 3, **Q4** |

> **A Fatia 2 é deliberadamente a segunda, e não a terceira.** Ela é a única que
> escreve **sem território novo**: `oxide/config/BetterLoot.json` passa pelo
> `configWrite` que já existe, com backup, validação, reload e releitura
> (`core/src/oxide/library.ts:1077-1107`). **É a menor escrita possível com a
> maior rede de segurança já montada** — e ela entrega um item do pedido do dono
> (os multiplicadores) por si só.
>
> A Fatia 3 é a que abre `oxide/data` (§5.2) e a que exige decidir a Q3. Separar
> as duas é o que impede que a primeira escrita do projeto num diretório novo
> aconteça no mesmo dia em que a primeira configuração de loot é aplicada.

---

## 11 — Medido, conferido, projeto

> A separação é obrigatória nesta casa. **Nada abaixo da linha "PROJETO" foi
> validado.**

### 11.1 MEDIDO — no fonte do BetterLoot

Método: `git clone --depth 50 https://github.com/magic-services-co/Better-Loot`
para o scratchpad desta sessão. **Nada foi copiado para `oxide/plugins` e nada
foi instalado.** Versão `4.4.0`, 3.405 linhas, 150.242 bytes.

| O que | Onde |
|---|---|
| `[Info("BetterLoot", "MagicServices.co // TGWA", "4.4.0")]` | `:25` |
| **`SkinId` (`ulong`) e `DisplayName` (`string`) na classe base de toda entrada** | `:1221-1227` |
| a skin aplicada, cinco caminhos | `:1204`, `:1532`, `:2557`, `:2816`, `:2973` |
| o nome aplicado (`ApplyAllProperties`) | `:1246-1259`, o `item.name` em `:1254-1255` |
| `UniqueTagREGEX = @"\{\d+\}"`, removido antes de resolver o shortname | `:416`; uso em `:1201`, `:2069`, `:2480`, `:2540` |
| `OnLootSpawn(LootContainer)` **devolve `true`** quando popula | `:1620-1628` (o `return true` em `:1626`) |
| `OnLootSpawn(LootFill)`, `OnCorpsePopulate`, `OnItemUnwrap` | `:1609-1618`, `:1631-1632`, `:1634-1653` |
| `ShouldBLPopulate_NPC` — o teste é `!= null` | `:2299` |
| `ShouldBLPopulate_Container` — `ulong` num caso, `NetworkableId` no outro | `:2307` (com `.Value`) e `:2321` (sem) |
| `PopulateContainer` devolve `false` se a tabela não existe ou `!Enabled` | `:2343-2344` |
| **`container.capacity = container.itemList.Count`** no fim da população | **`:2665-2666`** |
| `container.capacity = 36` no começo | `:2352-2353` |
| scrap: min/máx por container, item id `-932201673`, vezes `ScrapMultiplier` | `:2568-2585` |
| `LootMultiplier` aplicado à quantidade | `:1532`, `:2815`, `:2972` |
| conversão para blueprint | `:2588-2643` |
| **`LoadAllContainers` autogera a tabela do loot nativo** | `:1834-2049` |
| `GetLootSpawn` desce a árvore respeitando era | `:1701-1755`; `IsSelectableLootEntry` `:1672-1675` |
| `scrapAmount` do container copiado para min/máx de scrap | `:2000-2001` |
| `GetGuaranteedLootItems` — a interseção dos ramos vira item garantido | `:1678-1698` |
| `scanEntry` valida e **modifica** a entrada | `:2061-2166` |
| tabela de prefab inexistente é **removida** do arquivo | `:2192-2200` |
| `LoadFile` termina em `SaveFile` — **o plugin reescreve o que leu** | `:759-781` (o `SaveFile` em `:780`) |
| caminho dos dados: `BetterLoot` + separador + nome | `:767`, `:795` |
| `BakDataFile` — um `.bak`, sobrescrito | `:689-748` (o `File.Delete` do `.bak` em `:711`) |
| `Loaded()` carrega os três arquivos; `OnServerInitialized` monta a tabela | `:413-422`, `:424-440`, `InitLootSystem` `:442-467` |
| `MaybeUpdateConfigDict` — **merge**: chave ausente é preenchida | `:377-407` |
| chaves legadas migradas: `Blueprint Probability`, `Watched Prefabs` | `:131`, `:153`, `:953-956` |
| `WatchedPrefabs` é `Dictionary<string, bool>` chaveado por **caminho de prefab** | `:149-150`; origem em `:267-272` (`GameManifest.Current.prefabProperties`) |
| o hook consulta `container.PrefabName`, não `ShortPrefabName` | `:1622` |
| `unwrap/<shortname>` como chave sintética | `:37`, `:299-300` |
| comandos: `looty`, `bl-backup`, `bl-restore`, `blacklist` | `:3003`, `:3021`, `:3176`, `:3180`, `:3195`, `:3199`, `:3212` |
| `looty` por console exige `arg.IsRcon` | `:3023-3027` |
| `looty` baixa de `looty.cc/api/fetch-loot-table?id=` e grava por cima | `:3054`, `:3110`, `:3146`, `InitLootSystem(true)` em `:3161` |
| `bl-restore` restaura o `.bak` e reinicializa | `:3218` (via `BakDataFile` `:745`) |
| a blacklist descarta o item **depois** de criado | `:2491-2495` |
| `Bonus Items` — itens que saem junto, cada um com skin | `:1510`, `CreateBonusItems` `:1521-1541` |
| `ProbalisticRNG` — probabilidades **cumulativas**, busca binária | `:832-863` |
| `try/catch` no `OnServerInitialized` **descarrega o plugin** em erro | `:436-439` |

### 11.2 MEDIDO — no `Assembly-CSharp.dll` deste servidor

Método: `dnfile` **0.18.0**, instalado num venv dentro do scratchpad desta sessão
(fora do projeto; nada instalado no ambiente do usuário nem no servidor). Lido:
`Servers/server01/RustDedicated_Data/Managed/Assembly-CSharp.dll`. Os corpos de
método foram extraídos pelo RVA e os tokens de campo e método resolvidos contra
as tabelas `Field`, `MethodDef` e `MemberRef`.

| O que | Resultado |
|---|---|
| `LootContainer::SpawnLoot` (RVA `0x1f6f5c`, 96 bytes de IL) | `Clear` → `DoRemoves` → **`CallHook("OnLootSpawn")`, e não-nulo faz `ret`** → `PopulateLoot` → `CancelLootRefreshCountdown` → `StartLootRefreshCountdown` |
| `LootContainer::PopulateLoot` (RVA `0x1f70b4`, 202 bytes) | `FillLoot` → sorteio de condição se `SpawnType` é 2 ou 5 → `GenerateScrap` → `HasBeenLooted = false` → `FirstLooterId = 0` |
| `LootContainer::GenerateScrap` (RVA `0x1f719c`) | sai se `scrapAmount <= 0`; cria e `MoveToContainer`, com `Drop` se não couber |
| `LootContainer::ServerInit` (RVA `0x1f6df4`) | `if (initialLootSpawn && !isRestoringFromSave) SpawnLoot()` |
| `LootContainer::PostServerLoad` (RVA `0x1f6f18`) | **não toca em loot** |
| `LootContainer::Load` (RVA `0x1f7594`) | se `fromDisk` e `shouldRefreshContents`, chama `StartLootRefreshCountdown` |
| `LootContainer::StartLootRefreshCountdown` (RVA `0x1f6fc8`) | `Invoke(actionSpawnLoot, currentLootCountdownLength)` |
| `LootContainer::get_actionSpawnLoot` (RVA `0x1f6cf0`) | o delegate aponta para **`SpawnLoot`** |
| `LootContainer::get_shouldRefreshContents` (RVA `0x1f6c9c`) | `minSecondsBetweenRefresh > 0 && maxSecondsBetweenRefresh > 0` |
| **quem chama `StartLootRefreshCountdown`** (varredura no assembly inteiro) | **quatro**: `LootContainer::SpawnLoot`, `LootContainer::Load`, `RespawnableLootFridge::AdvanceRefreshCycle`, `RespawnableLootFridge::Load` |
| quem chama `SpawnLoot` | `LootContainer::ServerInit`, `XMasRefill::DistributeLoot`, `Stocking::SpawnLoot`, `Spawn::respawnloot_lookingat`, `_radius`, `_all` |
| `ItemContainer` — 22 campos, e **`capacity` é um deles** | — |
| `ItemContainer::IsFull` (RVA `0x256c88`) | nos dois ramos, o teste de partida é `itemList.Count` contra `capacity` |
| **`Item::MoveToContainer`** (RVA `0x25499c`, 1.590 bytes) | **lê `capacity` duas vezes**; a segunda governa o laço de busca de slot (`blt.s` de volta ao começo) |
| `ItemContainer::SlotTaken` (RVA `0x257064`) | `GetSlot(slot) != null`, com o hook `slotIsReserved` antes |

### 11.3 MEDIDO — na API do GitHub

Método: `curl` contra `api.github.com`, sem token.

| O que | Valor |
|---|---|
| `magic-services-co/Better-Loot`: criado / push / arquivado | 01/08/2026 / 01/09/2026 / não |
| estrelas / forks / issues abertas / commits / contribuidores | **1 / 1 / 0 / 6 / 3** |
| **licença** | **`null`** |
| arquivos no repositório | **2** (`BetterLoot.cs`, `README.md`) |
| `TGWA0/BetterLoot-UMod`: criado / push / arquivado / estrelas / licença | 30/12/2025 / 08/08/2026 / **sim** / 3 / **`null`** |
| grep por licença no `.cs` | **zero** ocorrências relevantes |

### 11.4 MEDIDO — em arquivos deste repositório

| O que | Onde |
|---|---|
| migração **048** registrada, `{ id: 48, name: 'loot-rules' }` | `core/src/db/migrations.ts:4987`; schema em `:4730-4864` |
| `loot_rules` / `loot_rule_servers` / `loot_rule_hits` | `core/src/db/migrations.ts:4731`, `:4809`, `:4840` |
| `LootRulesRepository`, 590 linhas, as 3 tabelas lidas e escritas | `core/src/db/loot-rules-repository.ts:159` |
| instanciado no boot | `core/src/index.ts:559` |
| `registerLootRoutes`, 6 rotas | `core/src/http/routes/loot.ts:146`; registro em `core/src/http/server.ts:501`; prefixo `/api` em `:626` |
| `origemz.loot.clear` / `origemz.loot.set` | `core/src/game/custom-items-sync.ts:125`, `:128`; envio em `:562`, `:593` |
| `origemz.loot.stats`, relógio de 60 s | `core/src/game/loot-stats.ts:82`, `:91`; `start()` em `core/src/index.ts:1424` |
| 33 containers estáticos, chaveados por `ShortPrefabName`, em 6 grupos | `core/src/game/loot-containers.ts:39-46`, `:55-62`, `:72-117` |
| taxonomia duplicada no painel: 8 ids em inglês | `panel/src/components/loot/containers.ts:36`, `:162` |
| `OnLootSpawn` do nosso plugin — **nunca cancela**, injeta no `NextTick` | `Plugins/OrigemZItems.cs:3222`, o `return null` em `:3299` |
| **`InjectLoot` e o `MoveToContainer` que a capacidade bloqueia** | `Plugins/OrigemZItems.cs:3334`, `:3379`; a desistência em `:3380-3387` |
| índice por `ShortPrefabName` | `Plugins/OrigemZItems.cs:537`, consulta em `:3233` |
| os três comandos de console do plugin | `Plugins/OrigemZItems.cs:2997`, `:3083`, `:3139` |
| `resolveServerPaths`, `pluginsDir`, `oxideConfigDir` — e **nenhum** `oxideDataDir` | `core/src/config.ts:587-599` (`:594`, `:595`) |
| `PluginLibrary.configWrite` — 6 passos, com **releitura do disco** | `core/src/oxide/library.ts:1077-1107` (`:1106`) |
| `writePluginConfig`, `pluginConfigPath` (trava dupla), `assertValidJson` | `core/src/oxide/plugin-config.ts:302`, `:99-123`, `:219-240` |
| backup obrigatório — falha no backup **aborta a escrita** | `core/src/oxide/plugin-config.ts:253-299`, `:284-296` |
| `MAX_CONFIG_BYTES = 256 KB` | `core/src/oxide/plugin-config.ts:74` |
| *"o plugin faz `SaveConfig()` e reescreve"* | `core/src/oxide/plugin-config.ts:16-28` |
| **política atual: `oxide/data` NÃO é tocado** | `core/src/oxide/library.ts:27`, `:1236` |
| `reloadPlugin(rcon, plugin)` e a detecção de falha de compilação | `core/src/oxide/plugins.ts:322-324`, `:176-184` |
| `installPlugin` com validação em camadas e sha256 | `core/src/oxide/plugins.ts:337-357`, `:285-301`; `sha256Of` em `core/src/oxide/plugin-metadata.ts:231` |
| o wipe varre `oxide/data`, 3 níveis, só `.json` | `core/src/wipe/plugin-data.ts:330`, `:204`, `:393-402`; *"NUNCA `del *.json`"* em `:5-13` |
| remoção no wipe, com backup em zip antes | `core/src/wipe/run.ts:777`, `:625-662` |
| `readOxideRuntime` / `pluginOf` — saber se o BetterLoot está carregado | `core/src/oxide/runtime.ts:131`, `:241` |
| `MAX_PUSH_BYTES = 50_000` (irrelevante aqui, e por quê) | `core/src/game/plugin-push.ts:70` |
| catálogo de 1.259 itens, por `origemz.items`, páginas de 250 | `core/src/game/item-catalog.ts:87` |
| o picker de item, 204 linhas, `PAGE_SIZE = 120` | `panel/src/components/item-picker-dialog.tsx` |
| a página de loot e a entrada na barra lateral | `panel/src/app/loot/page.tsx:55`; `panel/src/components/sidebar.tsx:154` |
| **grep por `BetterLoot` no repositório inteiro** | **zero ocorrências** |
| `Servers/server01/oxide/plugins` — 11 plugins, **nenhum BetterLoot** | conferido no disco |
| `Servers/server01/oxide/data/OrigemZItems/` — o precedente de subpasta | conferido no disco |

### 11.5 CONFERIDO — lido, não medido

| Afirmação | Fonte |
|---|---|
| o Looty é um **editor web para o BetterLoot**, não um plugin | `README.md` do repositório, seção *Web Configuration* |
| ele edita *"Loot tables, Loot groups, item rng, skins, attachments and more"* | idem — **e a parte de skins e attachments foi confirmada no fonte** (§3, §2.3) |
| tabelas antigas *"are **not compatible** with V4"*; conversor em `looty.cc/converter` | idem, seção *Converting your Old Loot Tables* |
| o fluxo oficial é *Download → Download via Command → `/looty {id}`* | idem, seção *Automatic Upload* |
| a API é *"return true/false to cancel loot population"* | idem, seção *Developer API* — **e está errado nos dois sentidos** (§4.2) |
| o layout de três colunas do Looty | descrição do dono no pedido; **a página não foi aberta nesta sessão** |
| o AlphaLoot e o mercado de configurações 2x/3x/5x/10x | **[E§7]**, que já os registrou como não medidos |

### 11.6 PROJETO — proposto aqui, e **não validado**

| Proposta | Onde | Risco se estiver errada |
|---|---|---|
| o troféu entrar **pelo BetterLoot** nos containers gerenciados | §3.4, §4.5(a) | baixo — a skin está medida; o que se perde é teto e medição |
| a fronteira ser **por container** (a) para farm, (b) para o item medido | §4.5 | **médio** — é a decisão central do desenho, e depende da Q2 |
| o `InjectLoot` **não** ser usado em container gerenciado | §4.3, §7.4 | **baixo em implementação, alto em consequência** — sem isso o troféu some em silêncio |
| **banco = intenção, disco = efeito, tela mostra os dois** | §6.3 | baixo — é o padrão do `configWrite`, aplicado a um arquivo a mais |
| `oxideDataDir` em `resolveServerPaths` + módulo espelhando `plugin-config.ts` | §5.2 | baixo — é cópia de molde testado |
| escrever os quatro arquivos e dar `oxide.reload BetterLoot` | §5.3, §5.4 | baixo — medido que não há outro caminho de recarga |
| **reler do disco depois de aplicar** | §5.4 passo 7, §6.3 | **baixo em custo, alto em consequência** — sem isso a tela mente |
| a migração 048 **fica como está**; a configuração do BetterLoot pede outra | §7.5 | baixo — é a regra da casa |
| **não desligar o caminho antigo**, porque ele é o plano B já pago | §8.4 | **este é o item que torna a decisão reversível** |
| a Fatia 1 ser instalar e **só ler** | §10.1 | baixo — e é a fatia que responde a Q1 de graça |
| a Fatia 2 escrever só `oxide/config`, antes de abrir `oxide/data` | §10.2 | baixo |
| a tela com faixa global + três colunas + marcador de dono da caixa | §9.2 | baixo |
| mostrar a **probabilidade efetiva** ao lado da digitada | §1.4, §9.3 | baixo — é a lição do **[E§8.4]** traduzida |
| adotar o vocabulário do **BetterLoot**, não o do AlphaLoot | §9.4 | baixo — e corrige o **[E§7.2]** |

### 11.7 O que continua NÃO medido

| O que | Por que importa | Por que não foi medido |
|---|---|---|
| **se o refresh de loot para mesmo** (§4.4) | muda a rota de farm do servidor inteiro | é IL mais fonte; **exigiria o plugin instalado e rodando** |
| **se o `InjectLoot` falha mesmo** em container gerenciado (§4.3) | decide se (c) do §4.5 é viável | idem |
| quantos dos 105 containers o BetterLoot vigia por padrão | o escopo real da substituição | o filtro de nomes está em `:232-260`, mas depende do `GameManifest` daquele build |
| o tamanho real do `LootTables.json` gerado | decide se ele passa dos 256 KB de `MAX_CONFIG_BYTES` — **e ele mora em `oxide/data`, que não tem esse teto** | idem |
| se `HasBeenLooted`/`FirstLooterId` não zerados quebram algo | o `clanScoreEventForFirstLooter` os usa | exigiria o plugin rodando |
| se a versão 4.4.0 tem defeito conhecido | o repositório tem 0 issues abertas — o que não é bom sinal nem mau | o suporte é por Discord, não por issue |
| qual é a versão do BetterLoot que o Looty escreve hoje | um descompasso entre editor e plugin quebraria o arquivo | `looty.cc` não foi aberto nesta sessão |

---

## 12 — Perguntas ao dono

### Q1 — O refresh de loot ✅ **RESPONDIDA em 06/09/2026: medir antes de decidir**

> **A decisão do dono:** instalar o BetterLoot e **observar** se os contêineres
> repopulam, antes de aceitar ou recusar a integração.
>
> É a decisão certa pelo motivo certo: o achado do §4 veio de leitura de IL
> (`SpawnLoot` retorna antes do `StartLootRefreshCountdown`), e **nada disso foi
> visto rodando**. Um comportamento que muda a economia do servidor inteiro não
> se decide por leitura de bytecode.
>
> **Onde:** no `server01` mesmo (Q7), em horário combinado com o dono — não há
> segundo servidor, e criar um custa o download do Rust dedicado.

O texto abaixo é o que sustentou a decisão.

### Q1 — O refresh de loot pode parar? **(BLOQUEANTE)**

**Medido no IL (§4.4):** cancelar o `OnLootSpawn` — que é o que o BetterLoot faz —
pula o `StartLootRefreshCountdown`. E esse é o único caminho que inicia o
cronômetro num container novo. **Na prática, um prefab gerenciado pelo BetterLoot
refaz o loot no máximo uma vez por restart do servidor**, contra os **1 a 2 h**
que **71 dos 105 containers** têm hoje (**[E§2.6]**).

Isso muda a rota de farm: barris e caixas param de reciclar sozinhos.

**Três saídas, e nenhuma foi validada:**

| Saída | Custo | Risco |
|---|---|---|
| aceitar, e compensar com mais loot por caixa | zero | muda a economia do servidor de um jeito que só aparece em duas semanas |
| deixar os containers de farm **fora** do BetterLoot (§4.5) | zero em código | o pedido do dono era configurar **todo** o loot |
| o nosso plugin reiniciar o cronômetro no `NextTick` depois do BetterLoot | uma linha, mas mexe em campo de terceiro | um erro aqui repopula caixa a esmo |

**A recomendação é a Fatia 1 (§10.1): instalar num servidor de teste e MEDIR
antes de decidir.** É a única das três perguntas deste documento que uma tarde
resolve.

**Isto entra em produção sabendo do efeito, ou o BetterLoot fica só nos
containers onde o refresh não importa?**

### Q2 — A fronteira entre os dois motores ✅ **RESPONDIDA em 06/09/2026**

> **A decisão do dono: o troféu entra pela tabela do BetterLoot**, com skin, e o
> nosso plugin cuida do resto. Nada de disputar a mesma caixa.
>
> ####  O QUE ISSO CUSTA, E PRECISA SER DITO ANTES DE ALGUÉM NOTAR  ####
>
> O BetterLoot **não tem** teto por dia, cooldown por jogador, modo de medição
> nem telemetria. Entregando o troféu a ele, a raridade passa a ser **só** a
> probabilidade da tabela dele — e o controle que a frente de loot construiu
> (`loot_rules`, `loot_rule_hits`, o modo `measuring`) **deixa de valer para o
> troféu**, embora continue de pé para qualquer outro item.
>
> Em particular, some o teto por dia que o `04 §6` recomendou para impedir que
> uma rota de farm otimizada transforme "raro" em "constante". Se isso incomodar
> depois de medido, o caminho de volta é a opção (b): tirar os contêineres do
> troféu da gestão do BetterLoot pela API dele, e devolver o controle ao nosso
> hook. Nada precisa ser desfeito para isso.

O texto abaixo é o que sustentou a decisão.

### Q2 — Os dois motores na mesma caixa: entra ou não? **(BLOQUEANTE para o troféu)**

**Medido (§4.3):** um container que o BetterLoot populou fica com
`capacity == itemList.Count` — sem slot livre. O nosso `InjectLoot` falha ali, em
silêncio, com `rolls` e `hits` subindo e `spawned` sempre voltando a zero.

São três desenhos (§4.5), e eles não são equivalentes:

- **(a)** o troféu entra pelo BetterLoot — **perde teto por dia, cooldown por
  jogador, modo `measuring` e a medição inteira**;
- **(b)** o container fica fora do BetterLoot — o troféu mantém tudo, mas aquela
  caixa não recebe configuração de loot nenhuma;
- **(c)** os dois na mesma caixa — exige o `InjectLoot` abrir espaço antes de
  mover, mexendo num campo que o plugin de terceiro acabou de escrever.

**A recomendação é (a) para o loot comum e (b) para o item medido**, com a
fronteira desenhada container a container e visível na tela.

**Confere? Ou o teto por dia e a medição são inegociáveis, e aí (c) precisa
entrar no orçamento?**

### Q3 — A configuração mora no banco ou no arquivo?

O §6 recomenda **banco como intenção, disco como efeito**, com releitura depois
de aplicar — o padrão que o `configWrite` já usa. Isso permite desfazer, comparar
servidores e editar com o servidor fora do ar.

O custo é um derivador (que é a superfície de quebra da dependência, §8.3), uma
migração e a detecção de divergência.

A alternativa — editar o arquivo direto — é mais barata e **não diverge nunca**,
mas perde histórico, perde comparação e **não funciona com o servidor parado**.

**Vale o custo, ou a primeira versão edita o arquivo direto e o banco entra
depois?**

### Q4 — O comando `/looty` fica ligado?

Medido (§5.3): quem tiver `BetterLoot.admin` pode rodar `/looty <id>` no chat e
**substituir a configuração inteira** por uma baixada de `looty.cc`. O nosso banco
passaria a descrever um arquivo que não existe mais.

**Três saídas:** deixar ligado e detectar a divergência (Fatia 6); tirar a
permissão `BetterLoot.admin` de todo mundo; ou deixar ligado de propósito, como
uma porta de emergência para quando o painel estiver fora.

**A recomendação é a primeira** — detectar em vez de proibir, que é o que o
`appliedSha` já faz para plugins. **Confere?**

### Q5 — O `LootTables.json` pode ser apagado num wipe?

Medido (§5.5): o full wipe já enxerga qualquer `.json` em `oxide/data` até três
níveis, e o arquivo do BetterLoot apareceria sozinho na tela como candidato a
apagar. Nada vem marcado por padrão — mas se alguém marcar, **a configuração
inteira do loot some sem erro nenhum**, regenerada do loot nativo no boot
seguinte.

**A tela de wipe marca esse arquivo como "gerado pelo painel"? Ou o agente
reescreve depois do wipe? Ou os dois?**

### Q6 — A prévia mostra o quê?

O §9.3 diz o que dá e o que não dá: a **probabilidade efetiva** de cada entrada
(a dela dividida pela soma do conjunto) é aritmética e sai barato; simular o
sorteio do BetterLoot exigiria reimplementar quatro rotinas dele no painel.

E há uma terceira coisa, que é só nossa: o `loot_rule_hits` já guarda o que
**saiu** no mundo, por dia — mas só para as nossas regras.

**A porcentagem ao lado do número já resolve o "fácil de configurar", ou o dono
quer ver a caixa aberta 100 vezes como o Looty promete?**

### Q7 — Em qual servidor a Fatia 1 roda?

O `server01` está no ar com o dono jogando, e o BetterLoot **não** está instalado
lá. A Fatia 1 (§10.1) exige instalar o plugin em algum lugar e deixá-lo gerar o
`LootTables.json`.

**Sobe num servidor de teste separado, ou o `server01` serve depois de o dono
sair?** Vale lembrar que a Fatia 1 é só leitura para nós — mas **para o servidor
ela não é**: o BetterLoot passa a gerenciar o loot no minuto em que carregar, com
os dois efeitos da Q1 e da Q2.

---

## Referências

- [`05-EDITOR-DE-LOOT.md`](05-EDITOR-DE-LOOT.md) — o terreno que o BetterLoot
  substitui: 1.321 `LootSpawn`, 105 containers, 34 com scrap, 71 com refresh.
  **É o documento cuja recomendação central (§4, complementar) esta decisão
  derruba, e cujo orçamento da Fatia 2 o BetterLoot entrega de graça**
- [`04-ITEM-NO-LOOT-DO-JOGO.md`](04-ITEM-NO-LOOT-DO-JOGO.md) — o mecanismo do
  loot e a medição de que a tabela nativa não carrega skin. **Confirmado, e agora
  contornado por fora**
- [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md) — a marca
  `(base_shortname, skin_id)`, que é o que faz o `Skin ID` do BetterLoot bastar
- `core/src/db/migrations.ts` — a migração 048, que **fica como está**
- `core/src/oxide/library.ts` e `core/src/oxide/plugin-config.ts` — o molde de
  escrever, recarregar e **reler** um arquivo de plugin
- `core/src/wipe/plugin-data.ts` — quem já enxerga `oxide/data`
- `Plugins/OrigemZItems.cs` — o `OnLootSpawn` que nunca cancela, o `InjectLoot`
  que a capacidade bloqueia, e o plano B já construído
- `https://github.com/magic-services-co/Better-Loot` — o fonte lido, v4.4.0,
  **sem licença**
