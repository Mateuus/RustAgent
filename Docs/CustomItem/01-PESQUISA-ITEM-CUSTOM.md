# ITEM CUSTOM — a pesquisa

> **O que este documento é.** O levantamento completo do que é preciso para o
> painel **criar itens que o jogo não tem**: o que o Rust permite de verdade, o
> que a Facepunch passou a proibir, como um item custom guarda identidade,
> aparência e **ação**, e como ele atravessa agente, plugin, painel e site.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. **Nada de
> item custom existe na árvore hoje.** O que existe e vai ser reaproveitado está
> marcado como *medido* no §12; o resto é projeto.
>
> **O estudo do modelo 3D saiu daqui.** Ele foi pedido em separado e está em
> [`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md). Este documento usa as
> conclusões de lá e não as repete.
>
> **A quem ele se liga.** O primeiro sistema a consumir item custom é o
> [Troféu Bleik Store](../TrofeuBleik/TROFEU_BLEIK_STORE.md), e os pontos que o
> troféu gera moram no ranking desenhado em
> [`Docs/Ranking/19-PESQUISA-RANKING.md`](../Ranking/19-PESQUISA-RANKING.md).
> Referências aparecem como **[T§2]** (troféu) e **[R§9]** (ranking).

---

## Índice

| § | Assunto |
|---|---|
| [0](#0--o-pedido-do-dono) | O pedido do dono, preservado |
| [1](#1--sumário-executivo) | Sumário executivo: a leitura em uma página |
| [2](#2--o-estado-de-hoje-medido) | O estado de hoje, medido |
| [3](#3--as-três-identidades-que-o-rust-permite) | As três identidades que o Rust permite |
| [4](#4--o-portão-da-facepunch) | O portão da Facepunch (agosto/2025) |
| [5](#5--a-ação-o-que-um-item-custom-pode-fazer) | A ação: o que um item custom pode fazer |
| [6](#6--os-pontos-virtuais) | Os pontos virtuais |
| [7](#7--o-modelo-de-dados) | O modelo de dados |
| [8](#8--a-aba-itens-as-três-separações) | A aba /itens: as três separações |
| [9](#9--a-api-o-painel-e-o-site) | A API, o painel e o site |
| [10](#10--o-lado-do-plugin) | O lado do plugin |
| [11](#11--o-plano-em-fatias) | O plano em fatias |
| [12](#12--medido-conferido-projeto) | Medido, conferido, projeto |
| [13](#13--perguntas-em-aberto-para-o-dono) | Perguntas em aberto para o dono |

---

## 0 — O pedido do dono

> Preservado sem edição. É a fonte; tudo que vem depois é leitura dela.

Temos a aba `/itens` — vamos ter uma separação de categoria e também o servidor
que está ativo aquele item.

E também uma separação **item padrão**, que é do jogo, e **item custom**, que
são itens criados por nós e podem ser criados aqui no painel.

O primeiro sistema que vai usar o item custom é o Troféu Bleik.

O site vai poder pegar esse item (já pega).

O item vai ter algum tipo de ação, tipo ação de cura. Podemos copiar o que o
sistema já faz — tipo a bandagem, que cura — e aí o admin pode criar uma super
bandagem.

Um sistema que dá pontos virtuais (coisa que o Troféu Bleik precisa), então o
item pode ser super customizado.

Uma coisa que você vai verificar e colocar em um `.md` separado, que é o estudo
de item 3D. O jogo hoje usa uma sacola como padrão para itens quando ele não tem
o modelo 3D; o nosso item pode pegar um 3D de algum outro item que já tem no
jogo. Mas quero um estudo se conseguimos usar 3D nosso sem fazer mod. (Se não
for, tudo bem, seguimos.)

---

## 1 — Sumário executivo

### 1.1 A leitura em uma frase

> **Um item custom no Rust não é um item novo: é um item do jogo com uma
> identidade nossa colada por cima.**
> O corpo é sempre emprestado — a malha, o ícone, o slot, o peso. O que é nosso
> é o **nome**, a **regra** e o **efeito**. O trabalho de engenharia não está em
> criar o item; está em **fazer a identidade nossa sobreviver** ao restart, ao
> wipe e ao dia em que o plugin não carregar.

### 1.2 As oito decisões que o pedido força

**1. O item custom é uma linha nossa, e o item do jogo é uma leitura.** Eles não
podem morar na mesma tabela. A `items` é um **espelho**: ela é apagada e
reescrita conforme o jogo muda, e um item nosso dentro dela sumiria no primeiro
update que o admin não acompanhasse. Item custom mora em `custom_items`, tabela
nossa, que **nada apaga sozinho** (§7.1).

**2. A chave de um item custom é o par `(item base, marca)`.** Não existe
"itemid novo" que o jogo aceite — foi **medido** no binário do próprio jogo, e a
prova está no §3.3. O que identifica um troféu Bleik dentro de um `trophy`
comum é o `skinId` que ele carrega, ou o nome, ou os dois. A escolha tem
consequência e está no §3.4.

**3. A "ação" não é código nosso: é o vocabulário do jogo.** Foram **medidos
109 `ItemMod`** no `Assembly-CSharp.dll` deste servidor — cura, veneno,
radiação, sangramento, abrir caixa, dar XP, virar entidade. A super bandagem
não se escreve: **se configura**, com os mesmos oito efeitos que a bandagem
comum usa (§5.2). Isso é o que torna o item "super customizado" sem virar um
motor de scripting.

**4. Existe um portão de conformidade que não existia quando o troféu foi
desenhado.** Desde **7 de agosto de 2025** a Facepunch proíbe servidor dar a um
jogador skin ou DLC que ele não possui, sob pena de **delisting** ou coisa pior.
Isso **inverte** a recomendação do troféu **[T§2.4]**: a skin com a logo da
Bleik não deve ser aprovada pela Facepunch — ela deve ser **deliberadamente não
aprovada**, que é justamente a faixa que continua permitida (§4).

**5. O "servidor ativo" tem dois significados, e só um deles é novo.** Para o
item do jogo, o catálogo é da rede inteira e não tem dono: ele é lido do
**primeiro servidor no ar** (`item-catalog.ts:342`) e vale para todos. Para o
item custom, "em quais servidores ele existe" é uma escolha nossa — e o padrão
da casa para isso já está pronto em quatro tabelas (`kit_servers`,
`ban_servers`, `server_ui`, `message_targets`). Ver §8.2.

**6. O item custom precisa de um dono no boot, ou ele não existe.** A biblioteca
que a comunidade usa para isso (`CustomItemDefinitions`) tem um comportamento
documentado que decide o desenho: **descarregado o plugin, os itens perdem os
`ItemMod` e o item vira carvão.** Um item que depende de plugin carregado é um
item que some no `oxide.reload`. O §3.6 explica por que a recomendação é **não
depender dela** na primeira fatia.

**7. O ponto virtual não é do item: é do ranking.** O item **emite**; quem soma
é o agente, na `player_stats` que a pesquisa de ranking já desenhou **[R§9.2]**.
Um contador dentro do plugin do item morreria no primeiro recompile — foi o
mesmo raciocínio que o troféu já fez **[T§1.2]**. O §6 amarra os dois.

**8. Criar item no painel não pode ser criar item no jogo.** São dois tempos: o
admin **cadastra** (grava a linha, sem nenhum servidor no ar — é a razão de a
tela `/itens` existir), e o agente **empurra** o cadastro para os servidores
ligados quando eles sobem. Sem essa separação, cadastrar item vira operação de
madrugada com o servidor no ar, que é exatamente o que esta tela nasceu para
evitar.

### 1.3 A tabela-resumo

| Pergunta | Resposta curta | Onde |
|---|---|---|
| Dá para criar item que o jogo não tem? | Não. Dá para **marcar** um item do jogo como nosso | §3 |
| O que identifica o item nosso? | `skinId`, ou nome, ou os dois | §3.4 |
| Dá para ter a logo no item? | Sim — skin **não aprovada** no workshop | §4.3 |
| Dá para modelo 3D próprio? | Não, e a prova está no binário | [02](02-ESTUDO-MODELO-3D.md) |
| Dá para fazer uma super bandagem? | Sim, com os 8 efeitos nativos | §5.2 |
| Dá para o item dar pontos? | Sim, mas quem soma é o agente | §6 |
| Onde o item custom mora? | `custom_items` + `custom_item_servers` (041) | §7.1 |
| O site já pega? | O catálogo do jogo, sim. O custom precisa de campo novo | §9.3 |
| O que quebra primeiro? | Item custom sem `skinId` fica indistinguível do nativo | §3.4 |
| Quantos itens aceitam skin? | **104 de 1266** — e só um troféu | §3.5 |

---

## 2 — O estado de hoje, medido

Tudo nesta seção foi **lido da árvore ou do banco**, não estimado.

### 2.1 O catálogo do jogo já está inteiro e funcionando

| Peça | Onde | O que faz |
|---|---|---|
| tabela `items` | migração **007**, `db/migrations.ts:736` | 1259 itens, chave `shortname` |
| leitura do jogo | `game/item-catalog.ts` | `origemz.items`, invalidação por protocolo |
| repositório | `db/items-repository.ts` | lista, filtra, conta categorias |
| rotas | `http/routes/items.ts` | `GET /items`, `/items/categories`, `/items/:shortname`, `POST /items/refresh` |
| tela | `panel/src/app/itens/page.tsx` | tabela, busca, filtro de categoria, paginação |
| ícones | `panel/scripts/build-item-icons.mjs` | pacote gerado offline, versionado |
| espelho para o site | `game/items-mirror.ts` | push do catálogo + imagens, de hora em hora |
| entrega | `origemz.give` (`plugin-contract.ts:240`) | fatia por `max_stack`, modo `auto` |

**O catálogo tem 1259 itens em 14 categorias**, medido em `data/rustagent.db`:

| Categoria | Itens | | Categoria | Itens |
|---|---:|---|---|---:|
| Items | 258 | | Component | 68 |
| Attire | 176 | | Tool | 52 |
| Food | 159 | | Resources | 51 |
| Weapon | 110 | | Ammunition | 45 |
| Electrical | 94 | | Traps | 9 |
| Misc | 80 | | Medical | 6 |
| Fun | 76 | | | |
| Construction | 75 | | | |

Essas 14 são exatamente as categorias **nativas** do jogo — medido no enum
`ItemCategory` do `Assembly-CSharp.dll`, que tem 18 valores, dos quais quatro
(`All`, `Common`, `Search`, `Favourite`) são filtros de interface e não
aparecem em item nenhum.

> **Consequência para o §8:** a categoria de um item custom **não precisa ser**
> uma dessas. Ela pode ser nossa — e provavelmente deve, porque "Troféu" não é
> `Misc`.

### 2.2 O `skinId` já atravessa o sistema inteiro

Isto é o que torna a fatia 1 barata, e foi medido em 25 pontos do `core`:

- **o contrato de entrega já o carrega:** `origemz.give <steamId> <shortname>
  <amount> <skinId> <mode>` (`plugin-contract.ts:252`);
- **a loja já o grava:** `store_offer_items.skin_id` (migração 015);
- **o kit já o grava:** `[{ slot, shortname, amount, skinId, position }]`
  (migração 011, `migrations.ts:969`);
- **o CUI já o desenha:** `ui-cui.ts:329` põe `skinid` no elemento de imagem
  quando ele não é zero;
- **a tela de kits já o mostra:** `ui-kits-screen.ts:482`.

> **Ou seja:** um item custom identificado por `skinId` **já é entregável, já é
> vendável na loja, já cabe num kit e já aparece no menu do jogo** — sem uma
> linha de código novo nesses caminhos. O que falta é o **cadastro**.

### 2.3 O padrão "em quais servidores isto vale" já existe, quatro vezes

Medido em `data/rustagent.db`: das 43 tabelas, 24 têm `server_id`. Quatro delas
são tabelas de junção com exatamente a forma de que o item custom precisa:

```sql
CREATE TABLE kit_servers (
  kit_id    INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (kit_id, server_id)
);
CREATE INDEX idx_kit_servers_server ON kit_servers (server_id);
```

O índice existe porque a chave primária começa pelo `kit_id`, e a pergunta da
tela do servidor é a **outra**: "quais kits este servidor oferece?". O
`custom_item_servers` copia isso inteiro (§7.2), inclusive o índice e o motivo.

### 2.4 O que **não** existe

- nenhuma tabela, rota, tela ou comando de item custom;
- nenhum campo que distinga item nosso de item do jogo — hoje, se um item
  custom fosse entregue, ele apareceria na `/itens` como um `trophy` qualquer;
- a `items` **não guarda de qual servidor a leitura veio** — o
  `describe()` da rota (`routes/items.ts`) devolve `source: 'servidor' |
  'banco'`, e nada mais. Com um servidor só isso não incomoda; com seis, a tela
  diz "conferido com o servidor" sem dizer qual (§8.3);
- o espelho para o site (`items-mirror.ts`) manda o catálogo do jogo e nada
  além dele.

### 2.5 O número da migração está apertado — e há uma armadilha

Medido em `migrations.ts:3117`: a última aplicada é a **040**. Mas **033 e 034
estão reservadas ao ranking** (`Docs/Ranking/19` §9.2), com a reserva escrita
no próprio array:

```
// 035 e 036 sao da frente da integracao com o site OrigemZ
// (Docs\20). A 033 e a 034 sao do ranking (Docs\19), e o numero
// reservado esta escrito nos DOIS documentos: duas frentes que
// escrevam 33 dao merge limpo e banco quebrado, porque o SQLite
// aplica a primeira e ignora a segunda para sempre.
```

> **Portanto o item custom reserva a 041 e a 042**, e esta reserva precisa
> aparecer **também** no `Docs/17 §0.1`, que é onde a regra da casa manda
> registrar. Sem isso a reserva não vale.

---

## 3 — As três identidades que o Rust permite

### 3.1 A pergunta que decide tudo

Um item no Rust chega ao jogador pela rede. O que o cliente recebe é uma
mensagem com estes campos — **medido** em `ProtoBuf.Item`, no `Rust.Data.dll`
deste servidor:

| Campo | Tipo | Serve para |
|---|---|---|
| `itemid` | `Int32` | achar a definição **no cliente** |
| `amount` | `Int32` | quantidade |
| `skinid` | `UInt64` | a skin |
| `name` | `String` | **nome customizado** |
| `text` | `String` | texto livre |
| `iconImageId` | `UInt32` | id de imagem de ícone |
| `flags`, `slot`, `contents`, `conditionData`, … | | o resto |

Três desses campos são a matéria-prima de um item custom: **`itemid`**,
**`skinid`** e **`name`**. A pergunta é qual deles pode ser nosso.

### 3.2 Identidade A — `itemid` próprio (o caminho que não existe)

É o que "criar um item novo" quer dizer, e é o que **não funciona**.

O `itemid` serve para o cliente achar a `ItemDefinition` **na instalação dele**.
Um número que só o servidor conhece não acha nada. E o jogo não falha em
silêncio: a mensagem de erro está literalmente no binário, medida no
`Assembly-CSharp.dll`:

```
Load invalid item id {0} from item {1} (no ItemDefinition found)
```

> **Um `itemid` inventado pelo servidor é descartado.** Não renderiza errado —
> não chega.

**A biblioteca da comunidade não contorna isso; ela contorna a outra metade.**
A extensão `CustomItemDefinitions` (0xF, gratuita, v2.5.4, 31,2 mil downloads)
exige um campo **`parentItemId` obrigatório** em toda definição custom. Esse
campo é a confissão do mecanismo: o item tem identidade nossa **no servidor** e
se apresenta ao cliente como o **pai**. Ela não cria um item que o cliente
conhece; ela dá nome, categoria e `ItemMod` próprios a um item que o cliente já
tinha.

### 3.3 Identidade B — `skinid` próprio (o caminho recomendado)

O `skinid` é um `UInt64` que **viaja na rede e é aceito sem lookup local**. É
por ele que o jogo distingue uma AK comum de uma AK skinada, e é o campo que
todo o nosso sistema já carrega (§2.2).

Um item custom, então, é: **item base do jogo + `skinId` nosso**.

| O que | Vem de |
|---|---|
| a malha 3D, o slot, o peso, o empilhamento | o item base |
| a arte (se houver skin) | o `skinId` |
| o nome que o jogador lê | o campo `name`, sobrescrito |
| a regra, o efeito, o preço, o servidor | **a nossa tabela** |

**O `skinId` é a chave porque ele sobrevive a tudo.** Ele vai no `give`, é
gravado no item, volta no inventário, aparece no CUI e atravessa restart e
wipe **sem depender de plugin nenhum carregado**. É a única marca que o próprio
jogo carrega por nós.

### 3.4 A armadilha do `skinId = 0`

Um item custom **sem** `skinId` é indistinguível de um item comum. Isso não é
um detalhe estético: é o que decide se o Troféu Bleik pode ser contado.

Imagine o troféu como `trophy` com `skinId = 0`. Um jogador que já tenha um
`trophy` do Twitch no baú vê o servidor convertê-lo em ponto — porque não há
como o plugin saber que aquele não é nosso. **O sistema passa a premiar um item
que o jogo distribui.**

| Marca | Distingue? | Custo | Veredito |
|---|---|---|---|
| `skinId` nosso, ≠ 0 | **sim, sempre** | publicar uma skin (§4.3) | **recomendado** |
| só o `name` | frágil | zero | o `name` é sobrescrevível e some no drop |
| item base exclusivo | sim, se ninguém mais usar | escolher um item que o jogo não distribui | aceitável como paliativo |

> **Decisão proposta:** todo item custom **nasce com um `skinId` obrigatório e
> único**, e o cadastro **recusa** `skinId = 0`. É uma regra de uma linha na
> validação que evita a classe inteira de defeito.
>
> Um `skinId` que não corresponda a skin publicada nenhuma **continua servindo
> de marca** — o jogo simplesmente não desenha skin, e o item fica com a
> aparência do item base. Isso quer dizer que a fatia 1 **não depende de
> publicar nada no workshop**: o número é a marca, a arte vem depois.

### 3.5 A restrição que só apareceu na medição: **8% dos itens aceitam skin**

Esta seção existe porque a medição contrariou o que a leitura das fontes fazia
supor, e o desenho mudou por causa dela.

O servidor guarda a ficha de cada item em `Bundles/items/<shortname>.json` —
1266 arquivos, 1,6 MB. É o **dado** do item, separado da **arte** (que está nos
4,4 GB de `Bundles/shared/`). A ficha do troféu, inteira:

```json
{"itemid":975983052,"shortname":"trophy","Name":"Twitch Rivals Trophy",
 "Description":"A trophy dedicated to the survivors of Rust Twitch Rivals",
 "Category":"Items","stackable":1,"ItemType":"Generic","AmountType":"Count",
 "condition":{"enabled":false,"max":0.0,"repairable":false},
 "Parent":0,"isWearable":false,"isHoldable":true,"isUsable":true,
 "HasSkins":false}
```

O último campo é o que importa. Varridos os 1266:

| | Itens |
|---|---:|
| `HasSkins: true` | **104** |
| `HasSkins: false` | 1162 |

**Oito por cento.** E a distribuição não ajuda quem quer um troféu:

| Categoria | Quantos aceitam skin |
|---|---:|
| Attire | 31 |
| Items | 17 |
| Weapon | 16 |
| Fun | 11 |
| Construction | 11 |
| Tool | 9 |
| Electrical | 7 |
| Traps · Misc | 1 · 1 |

**Cruzando com os candidatos a troféu** (a tabela do **[T§2.3]**), o resultado é
duro:

| `shortname` | Aceita skin? | Empilha |
|---|---|---:|
| `trophy` (Twitch Rivals) | **não** | 1 |
| `trophy2023` | **não** | 1 |
| `discord.trophy` | **não** | 1 |
| `fishtrophy` | **não** | 1 |
| `huntingtrophylarge` / `small` | **não** | 1 |
| **`skull.trophy`** | **SIM** | 1 |
| `easter.goldegg` / `silveregg` / `bronzeegg` | não | 10 |
| `xmas.present.medium` | não | 5 |
| `sign.artistcanvas.s` | não | 5 |

> **`skull.trophy` é o único troféu do jogo que aceita skin.** E nenhum item que
> aceita skin e empilha acima de 1 tem forma de troféu — os que empilham são
> cadeira, luminária, parede e vaso de planta.

**O que isto muda, e o que não muda:**

- **não muda a marca.** O campo `skin` é da **instância** do item, não da
  definição — é `Item.skin` (`UInt64`), medido na classe `Item`. Gravar um
  número ali é o que o SkinBox faz há anos. `HasSkins` diz que **existem skins
  registradas** para aquele item, não que o campo aceita valor. Um `skinId` nosso
  num `trophy` deve continuar sendo marca válida, sem desenhar arte nenhuma;
- **muda a arte.** Se a logo da Bleik precisa aparecer no objeto, o item base
  **tem de estar entre os 104** — e, se precisar ter forma de troféu, o conjunto
  tem **um elemento**: `skull.trophy`;
- **muda a ordem das perguntas ao dono.** A escolha do item base deixa de ser
  estética e passa a ser um trilema (§13, Q6).

> **A parte que ainda não é medida, e precisa ser:** que o campo `skin`
> **sobrevive** num item com `HasSkins: false` — isto é, que o jogo não zera o
> valor ao gravar, ao dropar ou ao recarregar o save. Toda a §3.4 se apoia
> nisso. **É um teste de dez minutos no `server01`** (entregar com `skinId`,
> reler o inventário) e é a coisa mais importante a medir antes da Fatia 1.
> Ver §13, Q3.

### 3.6 Identidade C — `CustomItemDefinitions`, **lido linha a linha**

> Esta seção mudou depois de o dono baixar o código-fonte. O que estava aqui
> antes vinha da página do Codefling e **subestimava a biblioteca**. O que segue
> é medido em [`CustomItemDefinitions.cs`](CustomItemDefinitions.cs), v2.5.4,
> 2169 linhas, e no exemplo oficial
> [`simpleexampleofitemcreation.cs`](simpleexampleofitemcreation.cs).

#### 3.6.1 O mecanismo, que é mais esperto do que a página deixa ver

A pergunta do §3.2 era: *como o cliente exibe um item cujo `itemid` ele não
conhece?* A resposta está no `ProtoWriteToStream` da biblioteca — ela **patcha a
escrita do protobuf** e reescreve cada pacote **por conexão**, antes de ele sair:

```csharp
private static void Handle(ProtoBuf.UpdateItem __instance, BufferStream stream)
{
    Connection connection = GetConnection(stream);
    if (connection == null) return;
    Mutate.ToClientSide(__instance, connection);   // ← troca o itemid pelo do PAI
}
```

E o `Mutate.Item` guarda cinco dicionários, indexados pelo nosso `itemid`:

```csharp
public static Dictionary<int, int>              ItemId;            // → itemid do pai
public static Dictionary<int, ulong>            SkinId;
public static Dictionary<int, uint>             IconId;            // ← o icone
public static Dictionary<int, Translate.Phrase> NamePhrase;
public static Dictionary<int, Translate.Phrase> DescriptionPhrase;
```

> **Ou seja: a tese do §3.2 estava certa e agora está medida.** O item tem
> identidade nossa **no servidor**, e sai para o cliente como o **pai**, com
> nome, ícone e skin trocados no caminho. O `itemid` custom nunca cruza a rede.

#### 3.6.2 A descoberta que muda o projeto: **o ícone é nosso**

Esta é a linha mais importante do arquivo inteiro:

```csharp
fallbackItemIcon = FileStorage.server.Store(
    Convert.FromBase64String("iVBORw0KGgo…"),   // um PNG
    FileStorage.Type.png, default);              // devolve um uint
```

`FileStorage.server.Store(bytes, png)` devolve o `uint` que vai no campo
**`iconImageId`** — aquele que eu tinha achado em `ProtoBuf.Item` sem saber para
que servia ([`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md) §5.4). O DTO o
expõe como `iconFileId`.

> **O servidor pode mandar um PNG arbitrário como ícone de item.** Sem workshop,
> sem aprovação da Facepunch, sem depender de o item base ter `HasSkins: true`.
>
> **É o caminho para a logo da Bleik Store no slot do inventário** — e ele
> contradiz o `[T§2.2]`, que dá isso como *"só por skin aprovada"*. A medição
> vence a suposição.

#### 3.6.3 O que o DTO aceita — o cadastro inteiro

```csharp
public class ItemDefinitionDto {
    public int    parentItemId;        // obrigatório — o corpo emprestado
    public string shortname;           // obrigatório — único
    public int?   itemId;              // default: shortname.GetHashCode()
    public uint   iconFileId;          // ← o PNG do §3.6.2
    public Translate.Phrase defaultName;         // multilíngue
    public Translate.Phrase defaultDescription;  // multilíngue
    public ulong  defaultSkinId;
    public int?   maxStackSize;        // ← POR ITEM
    public ItemCategory? category;
    public ItemDefinition.Flag flags;
    public ItemMod[] itemMods;         // ← inclusive os NOSSOS
    public bool   repairable, craftable, defaultBlueprintUnlocked;
    public List<ItemAmount> blueprintIngredients;
    public int    workbenchLevelRequired;
    public List<(Phrase label, Phrase text)> staticOwnerships;
}
```

Três linhas merecem destaque:

**`maxStackSize` é por item.** Resolve o problema do `[T§2.7]` sem plugin de
stack global — é a pergunta 4 da via D, e a resposta é sim (§11.6).

**`itemMods` aceita classe nossa.** O exemplo oficial herda `ItemMod` e escreve
comportamento em C#:

```csharp
private class ItemModTest : ItemMod {
    public override void ModInit() { … }
    public override void OnItemCreated(Item item) { … }
    public override void OnAttacked(Item item, HitInfo info) { … }
}
```

> Isso vai além do §5.1: não é só **configurar** os 109 mods do jogo — é
> **escrever** um. E dá para reaproveitar os do pai:
> `PARENT_DEFINITION.GetComponent<ItemModEntity>()`.

**`staticOwnerships` é o truque da descrição.** Não existe campo de descrição na
rede, então a biblioteca injeta o texto no bloco de *ownership* (o "quem te deu
isto") — `AddOwnership(item, label, text)`. Funciona, e é bom saber que é um
desvio, não um campo.

#### 3.6.4 O risco real, medido — e ele não é "vira carvão"

A página do Codefling sugere que o item vira carvão quando o plugin sai. **O
código diz outra coisa, e a diferença importa.** Há dois cenários, e só um é
grave:

| Quem sai | O que acontece | Gravidade |
|---|---|---|
| **o plugin que registrou o item** | `OnItemDefinitionBroken` clona a definição do **pai** (via `parentMap`, que é **persistido em disco**), remove os `ItemMod` e segue. O item continua no baú, inerte, e volta ao normal quando o plugin recarrega | **baixa** — recuperável |
| **a própria `CustomItemDefinitions`** | sem o `Item_Load_Patch`, o `itemid` custom não acha definição — e cai no descarte do §3.2 | **alta** |

O fallback declarado, quando nem o pai é conhecido, é
`batteringram.head.repair` — não carvão.

> **A leitura honesta:** a dependência não é frágil, é **crítica**. Enquanto a
> biblioteca estiver carregada, os itens sobrevivem a `oxide.reload` do nosso
> plugin, a restart e a wipe. Se ela sair — desinstalada, quebrada por um update
> do Rust, incompatível numa versão nova —, **os itens custom somem dos
> inventários**.
>
> E o custo dela é alto em outro eixo: ela faz Harmony patching em `Item.Load`,
> em `ClientRPC`, no `VendingMachine`, no `PlayerBlueprints` e na **serialização
> de rede**. É exatamente o tipo de código que um update do jogo quebra —
> e a memória da casa já registra que *o Oxide atrasa atrás do Steam*.

#### 3.6.5 A decisão, revista

**A Fatia 1 continua sem a biblioteca** — mas por um motivo diferente do que
estava escrito aqui antes.

Não é que a biblioteca seja ruim: ela é boa, e resolve coisas que o `skinId`
sozinho não resolve. É que **a Fatia 1 não precisa dela**: cadastrar, ligar por
servidor e entregar já funcionam com `(item base, skinId)` e o `origemz.give`
que existe. Adotá-la de saída seria pagar a dependência crítica do §3.6.4 antes
de ter qualquer coisa de pé.

> **Decisão proposta:** o modelo de dados do §7.1 nasce **compatível com as
> duas**. `base_shortname` é o `parentItemId`; `skin_id` é o `defaultSkinId`; a
> `action` é o que vira `itemMods`. **Adotar a biblioteca depois é preencher
> campos, não migrar tabela.**
>
> E a Fatia 5 muda de conteúdo: em vez de *"publicar a skin com a logo"*, ela
> passa a ser **"adotar a CID e mandar o PNG da logo como `iconFileId`"** — que
> não depende de aprovação de ninguém, não esbarra no `HasSkins` e não corre o
> risco de delisting do §4.

---

## 4 — O portão da Facepunch

### 4.1 O que mudou, e quando

Em **16 de julho de 2025** a Facepunch publicou novas diretrizes para servidores,
com prazo de adaptação até **7 de agosto de 2025** (o force wipe daquele mês).
A regra, em uma frase: **servidor não pode dar ao jogador acesso a DLC ou skin
paga que ele não possui**.

| Item | O que diz |
|---|---|
| **O que fica proibido** | conceder skin paga ou DLC a quem não comprou; burlar a checagem de posse |
| **A sanção** | delisting do navegador de servidores — e, em caso grave ou repetido, ban de jogo |
| **A exceção** | servidores de teste declarados |
| **O efeito prático** | o SkinBox como era acabou: ~98% das skins que ele oferecia são "aprovadas em jogo" e saíram |

> **Nota de honestidade:** as três fontes que sustentam esta seção são
> secundárias (uMod, GamingHQ, HNCRust) e **convergentes**. A página oficial das
> diretrizes não respondeu nas URLs testadas (`facepunch.com/legal/…`,
> `wiki.facepunch.com/rust/server-guidelines` — todas 404 em 05/09/2026).
> **Antes de publicar qualquer skin, alguém precisa ler a fonte primária.** É a
> pergunta Q4 do §13.

### 4.2 Por que isto importa para um item custom

Porque a tentação óbvia — "pega o `skinId` daquela skin bonita da loja" — é
**exatamente o que a regra proíbe**. Um troféu entregue com o `skinId` de uma
skin vendida é o servidor dando skin paga a quem não comprou.

> **Regra proposta, para valer no cadastro:** o `skinId` de um item custom é
> **sempre de skin nossa ou de skin não aprovada**. Nunca de skin da loja. E a
> tela de cadastro precisa dizer isso, com a razão, no lugar onde o campo é
> preenchido — porque quem cadastra em 2027 não vai ter lido este documento.

### 4.3 A inversão que isto provoca no Troféu Bleik

O documento do troféu **[T§2.4]** trata a skin com a logo como "condicionada à
aprovação da Facepunch" e a classifica como melhoria futura, porque *"o cliente
só baixa skins que a Facepunch aprovou"*.

**Isso está de cabeça para baixo depois de agosto de 2025.**

| | Skin **aprovada** | Skin **não aprovada** |
|---|---|---|
| É vendida na loja? | sim | não |
| É "paga"? | sim | **não** |
| Pode ser dada pelo servidor? | **não, é o que a regra proíbe** | **sim** |
| O cliente baixa? | sim | **sim** — é o que o SkinBox faz hoje |

A faixa que sobrou para servidores é **justamente a das skins não aprovadas**.
Existe hoje coleção pública no Steam Workshop dedicada a elas, e o próprio
SkinBox ganhou opção de config para filtrar "só aprovadas que o jogador possui,
mais as não aprovadas".

> **Consequência boa, e vale dizer com todas as letras:** a logo da Bleik Store
> **pode existir no troféu**. O caminho é publicar a skin no workshop e **não
> buscar aprovação** — o oposto do que o `[T§2.4]` recomendava. Isso não é uma
> brecha; é a faixa que a Facepunch deixou aberta de propósito para conteúdo de
> servidor.
>
### 4.4 A divergência com o documento do Troféu, dita abertamente

Os dois documentos discordam num ponto, e vale expor a discordância em vez de
enterrá-la numa nota.

| | `TROFEU_BLEIK_STORE.md` **[T§2.2]** e **[T§2.4]** | este documento (§4.3) |
|---|---|---|
| skin **aprovada** | é o que funciona; é o portão a vencer | funciona, mas **é proibida** desde 08/2025 |
| skin **não aprovada** | *"aparece como o item sem skin"* | funciona, e **é a faixa permitida** |
| veredito | via B é melhoria futura, bloqueada pela Facepunch | via B é viável, e o bloqueio é o oposto do descrito |

**Nenhum dos dois está medido.** O que cada lado tem:

- **o troféu** apoia-se no comportamento historicamente conhecido — e ele era
  verdade: discussões de 2016–2017 registram cliente **caindo** ao tentar baixar
  skin não aprovada;
- **este documento** apoia-se em fontes de 2025–2026 que descrevem o efeito da
  regra nova: o SkinBox sobreviveu **exatamente** por passar a usar skins não
  aprovadas, existe coleção pública dedicada a elas, e o plugin ganhou config
  para separar "aprovadas que o jogador possui" de "não aprovadas".

**A leitura que concilia as duas:** o comportamento do cliente **mudou** em
algum ponto entre 2017 e 2025 — o que é consistente com a Facepunch ter fechado
a porta das pagas e deixado a das não aprovadas aberta de propósito, para não
matar o conteúdo de servidor junto.

> **Nem uma nem outra versão deve ser tratada como fato até o teste.** O jogo
> tem `workshop.print_approved_skins` e `workshop.skinnables` como comandos de
> console (medido no binário), o que confirma que existe uma noção de lista
> aprovada embutida — e não diz o que acontece fora dela.
>
> **O teste que decide leva dez minutos** e está no §13, Q3. Enquanto ele não
> for feito, o `[T§2.4]` e este §4.3 ficam ambos marcados como hipótese, e
> **nenhuma fatia depende de qual das duas vence** — a arte é a Fatia 5, e ela é
> a última justamente por isso.

---

## 5 — A ação: o que um item custom pode fazer

### 5.1 O vocabulário é do jogo, e ele é grande

Foram medidos **109 `ItemMod`** no `Assembly-CSharp.dll` do `server01`. Um
`ItemMod` é um componente que se pendura numa `ItemDefinition` e dá a ela um
comportamento. É assim que a bandagem cura, que o keycard abre porta, que a
roupa veste.

Os que interessam a um item custom, agrupados pelo que o admin quer fazer:

| O admin quer… | `ItemMod` | Observação |
|---|---|---|
| **curar, alimentar, envenenar** | `ItemModConsumable` + `ItemModConsume` | é a bandagem. Ver §5.2 |
| **dar pontos ao usar** | `ItemModXPWhenUsed` | `xpPerUnit` e `unitSize`. Ver §6.3 |
| **abrir e sortear prêmio** | `ItemModOpenLootBag`, `ItemModUnwrap` | é o presente de Natal |
| **desgastar/recuperar durabilidade** | `ItemModAlterCondition` | `conditionChange` |
| **virar entidade no mundo** | `ItemModEntity`, `ItemModDeployable` | é o deployable |
| **ser vestido** | `ItemModWearable` | proteção, peso, oclusão |
| **virar opção no botão direito** | `ItemModMenuOption` | `commandName`, `isPrimaryOption` |
| **mostrar texto no painel do item** | `ItemModGenericInfo`, `ItemModInfoEntry` | é onde a explicação cabe |
| **dar oxigênio, virar rádio, tocar som** | `ItemModGiveOxygen`, `ItemModRFListener`, `ItemModSound` | |

### 5.2 A super bandagem, exatamente

O pedido do dono — *"copiar o que o sistema já faz, tipo a bandagem, e o admin
cria uma super bandagem"* — cai inteiro dentro de uma estrutura só. Medido:

```
ItemModConsumable
  amountToConsume          Int32     quantas unidades somem por uso
  conditionFractionToLose  Single
  effects                  List<ConsumableEffect>
  modifiers                List<...>

ItemModConsumable.ConsumableEffect
  type                 MetabolismAttribute.Type
  amount               Single      quanto
  time                 Single      em quanto tempo (0 = na hora)
  onlyIfHealthLessThan Single      só se a vida estiver abaixo disto
```

E os **oito tipos de efeito** que o `type` aceita — a lista inteira, medida no
enum `MetabolismAttribute.Type`:

> `Calories` · `Hydration` · `Heartrate` · `Poison` · `Radiation` ·
> `Bleeding` · `Health` · `HealthOverTime`

Uma bandagem comum é `Bleeding` negativo + um pouco de `Health`. **A super
bandagem é a mesma estrutura com números maiores** — e, se o admin quiser, com
`Radiation` negativo junto, virando bandagem-antirradiação.

> **É por isso que "o item pode ser super customizado" é verdade sem virar um
> motor de scripting.** O admin não escreve comportamento: ele preenche uma
> lista de `(efeito, quantidade, tempo)`. São oito verbos, e o jogo executa.

### 5.3 O ponto onde a ação encosta na identidade

Há uma emenda a fazer aqui, e ela é a parte mais delicada do desenho.

Os `ItemMod` moram na **`ItemDefinition`**, que é do **jogo** — não do item.
Mudar o `ItemModConsumable` do `bandage` muda **toda** bandagem do servidor, não
só a nossa. É o mesmo defeito que o troféu já identificou no `max_stack`
**[T§2.7]**: *"o valor vive na `ItemDefinition`, que é do jogo, e alterá-lo vale
para todo `trophy` do servidor"*.

Então a super bandagem **não pode** ser feita mexendo na definição da bandagem.
Ela é feita assim:

1. o item nasce como `bandage` com o nosso `skinId`;
2. o plugin **intercepta o uso** (`OnItemUse` / `OnHealingItemUse` do Oxide);
3. se o `skinId` for o nosso, ele **cancela o efeito padrão e aplica o nosso**,
   lido da tabela;
4. se não for, ele não faz nada — e a bandagem comum continua comum.

> **A regra que resume:** *nunca altere a `ItemDefinition`; sempre intercepte o
> uso e decida pelo `skinId`.* Mexer na definição é global e invisível; o hook é
> local e explícito. E é o mesmo padrão que o plugin já usa em toda parte.

---

### 5.4 As **ações do menu** — "Beber conteúdo", "Largar"

Quando o jogador clica com o botão direito num item, aparece um menu com ações:
*Beber conteúdo*, *Largar*, *Vestir*, *Estudar*. A pergunta natural é se dá para
pôr uma ação nossa ali.

**A resposta tem duas metades, e a segunda salva a primeira.**

#### 5.4.1 Criar uma opção nova no menu: **não**

O menu é montado **pelo cliente**, a partir dos `ItemModMenuOption` da
`ItemDefinition`. Medida a estrutura dele:

```
ItemModMenuOption : ItemMod
  commandName                  String              o comando que vai ao servidor
  actionTarget                 ItemMod
  option                       BaseEntity.Menu.Option
  isPrimaryOption              Boolean             é a ação do clique-esquerdo?
  showDisabled                 Boolean
  disabledTooltipDescription   DisabledTooltipOption
```

E o `BaseEntity.Menu.Option`, que é o que desenha a linha:

```
BaseEntity.Menu.Option
  name                 Phrase     ← frase localizada, do cliente
  description          Phrase     ← idem
  icon                 Sprite     ← asset do cliente
  order                Int32
  usableWhileWounded   Boolean
```

> **`Sprite` e `Phrase` são assets do cliente.** É a mesma barreira do
> [`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md) §3.2, pelo mesmo motivo: o
> rótulo e o ícone da opção teriam de existir na instalação do jogador. Uma
> opção "Converter em ponto" com ícone próprio **não tem como chegar lá**.

#### 5.4.2 Interceptar uma opção existente: **sim, e é um hook só**

O Oxide expõe exatamente isto:

```csharp
object OnItemAction(Item item, string action, BasePlayer player)
```

Ele dispara **antes** da ação acontecer, recebe o **nome** da ação como string
(`"drop"`, `"consume"`, `"unwrap"`, `"study"`…) e **cancela** quando o plugin
devolve algo diferente de `null`.

> **Isso é exatamente a segunda hipótese do dono** — *"ou usar uma função e algum
> plugin nosso detecta"* — e ela é melhor que a primeira, porque não depende de
> nada do lado do jogador.

O padrão fica:

```csharp
// A acao vem do menu do cliente; o filtro e o skinId, como em todo
// o resto do sistema (§3.4). Devolver nao-nulo CANCELA a acao
// original — e e assim que "Beber conteudo" vira outra coisa
// quando o galao e nosso.
private object OnItemAction(Item item, string action, BasePlayer player)
{
    CustomMark mark = MarkOf(item);
    if (mark == null) return null;            // nao e nosso: segue o jogo

    if (!mark.Actions.TryGetValue(action, out CustomAction custom))
        return null;                          // e nosso, mas esta acao nao foi
                                              // redefinida: segue o jogo

    RunCustomAction(player, item, custom);
    return true;                              // cancela a original
}
```

#### 5.4.3 O que isso permite de verdade

O rótulo continua sendo o do jogo — mas **o que acontece ao clicar é nosso**:

| O jogador lê | O que o jogo faria | O que podemos fazer |
|---|---|---|
| *Beber conteúdo* | repõe 500 ml de sede | curar, dar pontos, teleportar, abrir um menu |
| *Largar* | joga no chão | **recusar**, com uma frase no chat |
| *Estudar* | aprende o blueprint | dar um kit, conceder VIP |
| *Desembrulhar* | abre o presente | sortear da nossa tabela |

> **A limitação honesta:** o rótulo mente um pouco. Um item nosso cuja ação
> *"Beber conteúdo"* concede pontos vai ler *"Beber conteúdo"*. Duas defesas, e
> as duas são baratas:
>
> 1. **escolher o item base pela ação que ele já tem** — se a ação desejada é
>    curar, o base é a bandagem, e o rótulo *"Usar"* já está certo;
> 2. **a descrição do item**, que é nossa e aparece no painel lateral (foi ali
>    que o galão da captura explicou o que faz). É onde se diz o que a ação
>    realmente faz.

#### 5.4.4 A terceira via, que já existe nesta casa

Há um caminho que não passa pelo menu do jogo e não tem nenhuma dessas
limitações: **o CUI**. A interface que o agente já desenha
(`core/src/game/ui-cui.ts`, `ui-preset-main-menu.ts`) aceita botão com **texto
nosso, ícone nosso e comando nosso** — e o `[T§2.5]` já recomenda o CUI como o
lugar onde a medalha da Bleik aparece de verdade.

> **Portanto, em ordem de preferência:**
> **1.** ação própria no **CUI**, quando ela merece tela; **2.** `OnItemAction`
> sequestrando a opção certa, quando o gesto natural é no inventário;
> **3.** opção nova no menu do jogo — **não existe**, e não vale insistir.

---

## 6 — Os pontos virtuais

### 6.1 O que o dono pediu, e o que ele já tem

O pedido — *"um sistema que dá pontos virtuais (coisa que o Troféu Bleik
precisa)"* — **já está desenhado em dois documentos**, e a única coisa que falta
é ligá-lo ao item.

| Peça | Onde está | Estado |
|---|---|---|
| a tabela de pontos `player_stats` | ranking, **[R§9.2]**, migração 033 | desenhada, não construída |
| o lote idempotente `stat_batches` | ranking, **[R§9.2]** | desenhada, não construída |
| o estorno com autor e motivo `stat_adjustments` | ranking, **[R§9.2]** | desenhada, não construída |
| a regra 1 troféu = 1 ponto | troféu, **[T§3.1]** | decidida |
| a fila do plugin quando o RCON cai | troféu, **[T§3.5]** | decidida |

> **Portanto o §6 não inventa nada.** Ele diz apenas **como o item custom
> alcança essas peças** — e a resposta é: pelo mesmo caminho que o troféu já
> desenhou, com o item custom entrando no lugar do "item nativo renomeado" que
> o **[T§2.4]** recomendava.

### 6.2 A regra que o item custom acrescenta

Um item custom pode declarar, no cadastro, que **conceder pontos é a ação
dele**:

| Campo | O que é |
|---|---|
| `points_metric` | qual métrica do ranking recebe (`trophy.bleik`) |
| `points_per_unit` | quantos pontos por unidade (1) |
| `points_consumes` | o item some ao conceder? (sim, para o troféu) |

Com esses três campos, **o Troféu Bleik deixa de ser um sistema e vira uma
linha na tabela de itens custom**. E o segundo item que der pontos — uma
"medalha de evento", digamos — não custa código nenhum.

### 6.3 Por que não usar o `ItemModXPWhenUsed` do jogo

Existe um `ItemMod` nativo que dá XP ao usar (`xpPerUnit`, `unitSize`) e a
tentação é grande. Três razões para não:

1. **o XP do Rust não é o nosso ponto.** Ele alimenta um sistema de progressão
   do próprio jogo, que a rede não usa e não controla;
2. **ele mora na `ItemDefinition`** — e cai na proibição do §5.3;
3. **e, sobretudo, ele não é auditável.** O ranking precisa de lote idempotente,
   estorno com autor e conferência de emitidos × convertidos **[T§8.2]**. Um
   contador dentro do jogo não dá nenhuma das três.

> O `ItemModXPWhenUsed` fica registrado aqui como **medido e descartado**, com o
> motivo — para ninguém precisar redescobri-lo.

---

## 7 — O modelo de dados

### 7.1 `custom_items` — migração **041**

O princípio, e ele é o mesmo da migração 007: **item do jogo é leitura, item
nosso é escrita.** Duas naturezas, duas tabelas. A `items` continua sendo
apagada e reescrita a cada varredura; a `custom_items` nunca é tocada por
varredura nenhuma.

```sql
CREATE TABLE custom_items (
  -- Nosso, e estável. É o que o site e a loja guardam.
  id            TEXT PRIMARY KEY,

  -- O que o jogador lê. Sobrescreve o nome do item base no
  -- campo `name` do protocolo (medido em ProtoBuf.Item).
  display_name  TEXT NOT NULL,

  -- ####  A MARCA  ####
  --
  -- O par (base_shortname, skin_id) é o que distingue este item
  -- de um item comum DENTRO DO JOGO. O `skin_id` NUNCA é '0' —
  -- ver a §3.4: sem ele, o plugin não tem como saber que aquele
  -- trophy no inventário é nosso, e passaria a premiar o item
  -- que o próprio jogo distribui.
  --
  -- TEXT e não INTEGER: é um UInt64 na rede, e ele não cabe no
  -- inteiro com sinal do SQLite. É a mesma escolha que
  -- store_offer_items.skin_id já fez.
  base_shortname TEXT NOT NULL REFERENCES items(shortname),
  skin_id        TEXT NOT NULL CHECK (skin_id <> '0'),

  -- Nossa, e livre. As 14 do jogo não têm "Troféu", e forçar
  -- este item dentro de `Misc` esconderia dele a única coisa que
  -- o descreve.
  category      TEXT NOT NULL,

  description   TEXT,

  -- ####  O ICONE DO SLOT  ####
  --
  -- O nome do arquivo em Assets/items/, ou NULL para "usa o icone
  -- do item base". NULL e o padrao, e ele e um padrao BOM: o
  -- jogador ja reconhece o icone do item do jogo.
  --
  -- Nao e o PNG: e o NOME do arquivo em Assets/. O agente le os
  -- bytes e os manda pelo canal que JA EXISTE
  -- (`origemz.ui.image <chave> <base64>`), e o plugin os guarda no
  -- FileStorage do servidor, que devolve um CRC. Ver a §10.3.2.
  --
  -- O CRC nao e gravado aqui de proposito: ele nasce do outro
  -- lado, muda quando o PNG muda, e guarda-lo seria uma segunda
  -- verdade sobre a mesma imagem — a mesma razao pela qual
  -- ui-images.ts deixa o CRC so no plugin.
  --
  -- So tem efeito com a CustomItemDefinitions carregada (§3.6.2).
  -- Sem ela a coluna fica gravada e inerte, o que e de proposito:
  -- adotar a biblioteca depois nao deve pedir recadastro.
  icon_file     TEXT,

  -- ####  O EMPILHAMENTO  ####
  --
  -- NULL = herda o do item base, que e o comportamento sem a
  -- biblioteca. Preenchido, so vale COM ela — e ai vale so para
  -- este item, porque a definicao custom e uma COPIA da do pai
  -- (§11.6, pergunta 4). E a saida limpa para o stack de 5 do
  -- briefing do trofeu, que o [T§2.7] procurava.
  max_stack     INTEGER CHECK (max_stack IS NULL OR max_stack > 0),

  -- ####  A ACAO  ####
  --
  -- JSON, e não colunas. A razão é a mesma da `ui_documents`
  -- (migração 008): a forma da ação MUDA com o tipo dela, e uma
  -- coluna por efeito possível daria uma tabela larga cheia de
  -- NULL que ninguém consulta.
  --
  --   {"kind":"none"}
  --   {"kind":"consume","effects":[{"type":"Health","amount":40,"time":0}],
  --    "consumes":1}
  --   {"kind":"points","metric":"trophy.bleik","perUnit":1,"consumes":true}
  --
  -- Quem valida é o zod na borda HTTP, não o banco: a regra de
  -- um efeito é longa demais para um CHECK, e um CHECK que
  -- entende metade dela é pior que nenhum.
  action        TEXT NOT NULL DEFAULT '{"kind":"none"}',

  -- Desligado NÃO é apagado. Um item desligado não é entregue,
  -- mas continua existindo no inventário de quem já o tem — e
  -- continua sendo reconhecido pelo plugin, senão o troféu de
  -- alguém viraria lixo por causa de um clique no painel.
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- A marca precisa ser única, senão dois itens custom disputam o
-- mesmo par e o plugin não tem como decidir qual dos dois é.
CREATE UNIQUE INDEX idx_custom_items_mark
  ON custom_items (base_shortname, skin_id);

CREATE INDEX idx_custom_items_category ON custom_items (category);
```

**Três escolhas que merecem o porquê:**

1. **`base_shortname` referencia `items`.** Um item custom em cima de um
   `shortname` que o jogo não tem é um item que nunca vai ser entregue. A
   referência pega isso no cadastro, e não na entrega — que é dias depois, com o
   jogador esperando.

2. **`skin_id` recusa `'0'` no próprio banco.** É a regra do §3.4, e ela vale a
   pena estar em dois lugares: o `CHECK` pega o caminho que esquecer de validar.

3. **`action` é JSON e a validação é do zod.** Mesmo raciocínio da migração 008,
   que já resolveu essa discussão para as interfaces do jogo.

### 7.2 `custom_item_servers` — a parte do "servidor ativo"

Cópia direta do `kit_servers` (§2.3), inclusive o índice e o motivo dele:

```sql
CREATE TABLE custom_item_servers (
  item_id   TEXT NOT NULL REFERENCES custom_items(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, server_id)
);

-- "Quais itens custom este servidor tem?" é a pergunta da tela do
-- servidor e a que o plugin faz no boot. A chave primária começa
-- por item_id, então filtrar só pela segunda coluna não teria por
-- onde entrar.
CREATE INDEX idx_custom_item_servers_server
  ON custom_item_servers (server_id);
```

**Sem linha nenhuma = em nenhum servidor.** É o contrário do `kit_servers`?
Não — é o mesmo. E é a escolha certa: um item recém-cadastrado que já valesse em
tudo entraria em produção sem ninguém mandar.

### 7.3 O que **não** entra na migração 041

- **contador de pontos.** Ele é do ranking, migração 033 **[R§9.2]**. Duas
  tabelas de ponto seriam duas verdades sobre o mesmo número;
- **o histórico de quem recebeu.** Já existe: `player_events` ganhou "recebeu um
  item do admin" na migração 040, e a entrega de item custom passa pelo mesmo
  `origemz.give`;
- **a imagem do item.** Ícone é do painel (`build-item-icons.mjs`), e a arte é
  da skin. Um blob no banco seria uma terceira fonte.

---

## 8 — A aba `/itens`: as três separações

O dono pediu três cortes na tela. Eles têm dificuldades muito diferentes, e vale
separar antes de desenhar.

| O corte | Dificuldade | Por quê |
|---|---|---|
| **por categoria** | **já existe** | filtro montado, `GET /items/categories` respondendo |
| **padrão × custom** | **fácil, e é o corte principal** | duas tabelas, uma união na leitura |
| **por servidor** | **fácil no custom, honesto no padrão** | §8.2 e §8.3 |

### 8.1 Padrão × custom: o corte que manda

Este é o corte que muda a tela, e ele deve vir **antes** dos outros dois na
hierarquia visual — porque as duas naturezas respondem a perguntas diferentes:

> **"quais itens o jogo tem?"** é consulta. **"quais itens nós criamos?"** é
> administração.

A proposta é **uma tela, duas abas**, e não duas telas:

```
ITENS
┌──────────────┬──────────────────┐
│ DO JOGO 1259 │ NOSSOS        3  │   ← as duas naturezas
└──────────────┴──────────────────┘
   busca ▸ categoria ▸ servidor ▸ [+ CRIAR ITEM]
```

**Por que uma tela só.** Porque quem cadastra um item custom acabou de procurar
o item base — e o `base_shortname` é escolhido no mesmo catálogo que a outra aba
mostra. Separar em duas telas obrigaria a ir e voltar para cadastrar um item.

**Por que abas e não filtro.** Porque as colunas divergem: item do jogo tem
"empilha" e "tem condição"; item nosso tem "base", "skin", "ação" e "servidores".
Um filtro numa tabela só deixaria metade das colunas vazias em metade das linhas.

**O botão de criar só aparece na aba "nossos"** — pela mesma razão de o
"Atualizar agora" só valer com servidor no ar: botão que não se aplica ao que
está na tela é botão que parece quebrado.

### 8.2 Por servidor, no item custom: direto

`custom_item_servers` responde exatamente isso. Na tabela, uma coluna com os
nomes dos servidores; no cadastro, uma lista de caixas de seleção — igual à do
kit, que já existe (`kit-dialog.tsx`).

### 8.3 Por servidor, no item do jogo: a resposta honesta

Aqui é preciso ter cuidado para não construir uma mentira.

**O catálogo do jogo não é por servidor.** Ele é lido do **primeiro servidor no
ar** (`item-catalog.ts:342`, `#firstOnline()`) e vale para a rede toda. E isso
está certo: os itens são da versão do Rust, não do servidor — dois servidores na
mesma versão têm exatamente os mesmos 1259 itens.

Uma coluna "servidor" na aba do jogo, então, seria ou sempre igual (ruído) ou
inventada (mentira).

**O que falta de verdade é outra coisa, e ela é útil:** a tela diz *"conferido
com o servidor"* sem dizer **qual**. Com um servidor, ninguém sente; com seis —
e com um deles numa versão atrasada, o que a memória da casa registra como
comum quando o Oxide atrasa atrás do Steam — a frase esconde a única informação
que importaria.

> **Proposta:** a `items` ganha **`scanned_from`** (o `serverId` da varredura
> que a preencheu) e a rota devolve isso no `describe()`. A tela passa a dizer:
>
> > ● conferido com **Craggy Island** · Protocolo 2633.288.1 · lido ontem
>
> É uma coluna, um campo na resposta e três palavras na tela. E responde à
> pergunta que o dono fez sem fingir um recorte que não existe.

### 8.4 A tela de cadastro

O que ela precisa ter, em ordem de importância:

1. **o item base**, escolhido no combobox que já existe (`item-combobox.tsx`) —
   com o ícone, para o admin ver o corpo que está emprestando;
2. **o nome** que o jogador vai ler;
3. **a marca (`skinId`)**, com o aviso do §4.2 escrito ali: *"skin nossa ou não
   aprovada. Nunca skin da loja — servidor que entrega skin paga a quem não
   comprou é delistado."*;
4. **a categoria**, livre, com as existentes sugeridas;
5. **a ação**, num seletor de três: nenhuma · efeito · pontos. E o formulário
   muda conforme a escolha (§5.2 e §6.2);
6. **os servidores**, caixas de seleção;
7. **a prévia**: como o item vai aparecer, com o ícone do base e o nome nosso.

> **A prévia não é enfeite.** Ela é o único lugar em que o admin descobre, antes
> de gravar, que o "Troféu Bleik Store" que ele acabou de criar tem cara de
> presente de Natal.

---

## 9 — A API, o painel e o site

### 9.1 As rotas novas

Seguem a forma das rotas de kit e de loja, que já existem:

```
GET    /api/custom-items              a lista, com filtro de servidor e categoria
GET    /api/custom-items/:id          um item
POST   /api/custom-items              cadastra
PATCH  /api/custom-items/:id          altera
DELETE /api/custom-items/:id          apaga  (ver §9.2)
POST   /api/custom-items/:id/give     entrega a um jogador
```

E uma emenda na rota que já existe, sem quebrar ninguém:

```
GET    /api/items?kind=game|custom|all      'game' é o padrão de hoje
```

> **`kind=game` como padrão** é o que mantém o site e o painel funcionando sem
> alteração no dia em que a rota mudar. Quem quiser o novo pede por ele.

### 9.2 Apagar item custom precisa de trava

Um item custom apagado deixa órfãos em três lugares: o inventário de quem já o
tem, os kits que o listam e as ofertas da loja. É o mesmo problema que a
migração 007 já resolveu para item do jogo — *"item que sumiu do jogo não é
apagado, e isso não é preguiça: um kit montado no mês passado aponta para ele"*.

> **Proposta:** `DELETE` **recusa** enquanto houver kit ou oferta apontando, e
> diz quais. Para tirar de circulação existe o `enabled = 0`, que já está na
> tabela e não deixa órfão nenhum.

### 9.3 O site: o que ele já pega e o que falta

O dono disse que *"o site já pega"* — e ele pega **o catálogo do jogo**. Medido
em `game/items-mirror.ts`: um push do snapshot inteiro, de hora em hora, mais as
imagens em lotes de 50, com invalidação por hash.

**O item custom não cabe nesse espelho como está**, por uma razão de contrato:
o snapshot do site é fechado por `shortname`, e a régua de admissão dele
(`SHORTNAME_ADMIT`, copiada no nosso lado de propósito) **reprova o push inteiro
com 400** se um nome sair da régua. Um item custom com id nosso entraria como
shortname inválido e derrubaria o espelho todo.

Duas saídas, e a recomendação:

| Saída | Como | Custo |
|---|---|---|
| **A — campo novo no espelho** | o item custom viaja como `{shortname: base, skinId, customId, name}` | pede mudança no lado do site |
| **B — espelho próprio** | `custom-items-mirror.ts`, mesmo molde, rota nova | nada muda no site até ele querer |

> **Recomendada: a B.** O molde já existe e é bom (hash, lote, backoff de 404), e
> ela **não arrisca o espelho que funciona**. O site consome quando quiser; até
> lá, nada quebra. E há um documento a escrever para o agente do site, na mesma
> série do `Docs/29` e `Docs/31` — que é como as duas pontas se falam nesta casa.

---

## 10 — O lado do plugin

### 10.1 O que o plugin precisa saber, e como ele fica sabendo

O plugin precisa de uma coisa só: **a lista de marcas ativas naquele servidor** —
os pares `(itemId do base, skinId)` e, para cada um, a ação.

O caminho já existe e não é preciso inventar: é o mesmo pelo qual o kit e o
loadout chegam ao plugin hoje. E o plugin **pede** quando esquece — o mecanismo
está documentado em `OrigemZAgent.cs:174-193`, escrito depois de um
`oxide.reload` ter esvaziado o cache de kits e feito jogadores nascerem sem nada.

> **A regra que isso impõe:** o item custom entra pelo **mesmo pedido de
> sincronização** que já existe. Um canal próprio teria o mesmo defeito, e
> alguém o descobriria do mesmo jeito — com um jogador reclamando.

### 10.2 Os dois hooks, e nada além

```csharp
// 1. O USO — a super bandagem, o troféu, o que consome.
//    Decide pelo skinId: se nao for nosso, nao faz nada, e a
//    bandagem comum continua comum. NUNCA altere a
//    ItemDefinition: ela e do jogo, e mexer nela vale para todo
//    bandage do servidor. Ver a §5.3.
private object OnItemUse(Item item, int amount)
{
    CustomMark mark = MarkOf(item);   // (item.info.itemid, item.skin)
    if (mark == null) return null;    // nao e nosso: segue o jogo
    return ApplyAction(item, mark, amount);
}

// 2. A ENTRADA — so para item cuja acao e "converter ao receber",
//    que hoje e so o trofeu. Ver [T§3.3] para os quatro portoes
//    de entrada e por que um NextTick e obrigatorio aqui.
private void OnItemAddedToContainer(ItemContainer container, Item item)
{
    // ...
}
```

> **Dois hooks cobrem o pedido inteiro.** O resto — entregar, empilhar, dropar —
> já é feito pelo `origemz.give`, que fatia por `max_stack` e cai para o chão
> quando não cabe (`OrigemZAgent.cs:1420-1425`).

### 10.3 O cadastro é **dinâmico**, e isso decide quatro coisas

O item custom nasce no painel, em runtime — ninguém vai editar `.cs` para criar
um troféu. Isso não é detalhe de conforto: são duas exigências de arquitetura.

#### 10.3.1 O registro tem de ser em laço, não em código

O exemplo oficial da biblioteca registra **um** item, escrito à mão:

```csharp
CustomItemDefinitions.Call<ItemDefinition>("Register", new {
    shortname = "test.demoitem", parentItemId = …, maxStackSize = 1, …
}, this);
```

O nosso registra **os que o agente mandou**:

```csharp
// O cadastro vem do agente, e nao do arquivo. Um item novo no
// painel e uma linha a mais nesta lista — sem recompilar nada.
foreach (CustomItemSpec spec in SpecsFromAgent)
{
    CustomItemDefinitions.Call<ItemDefinition>("Register", new {
        shortname     = spec.Shortname,
        parentItemId  = spec.BaseItemId,
        maxStackSize  = spec.MaxStack,
        category      = spec.Category,
        defaultName   = spec.DisplayName,
        iconFileId    = spec.IconFileId,     // ver 10.3.2
        itemMods      = ModsFor(spec),
    }, this);
}
```

**A ordem importa e tem uma armadilha.** O `Register` precisa acontecer **depois**
de o agente ter mandado a lista, e a lista chega pelo canal do §10.1 — que é
assíncrono. Somado ao `OnCIDLoaded` da biblioteca, são **três** eventos que
precisam ter acontecido antes do primeiro registro:

| Evento | De quem |
|---|---|
| `OnServerInitialized` | do jogo |
| `OnCIDLoaded` | da biblioteca |
| a lista de specs | do agente |

> **Registrar antes dos três é registrar item pela metade.** E o modo de falhar
> é o pior possível: o item existe com o nome errado, ou não existe, e ninguém
> percebe até um jogador reclamar. O padrão da casa para isto já existe e está
> em `OrigemZAgent.cs:174-193` — **o plugin PEDE quando esquece**, e o agente
> responde empurrando o estado. O registro de item custom entra nesse mesmo
> pedido.

#### 10.3.2 O PNG do ícone: **o caminho inteiro já existe nesta casa**

> Esta seção recomendava entregar o PNG **por disco**, argumentando que o RCON
> teria de fatiar. **Estava errada**, e o próprio repositório tem a refutação:
> o canal por RCON já está implementado, medido e em uso — em duas versões.

**Como a imagem chega ao jogo, ponta a ponta.** Nada disto é projeto: os quatro
passos existem e rodam hoje, para o ícone do OZCoin no menu.

```
 1. o admin põe o PNG          →  Assets/ui/ozcoin.png
 2. o agente lê e manda        →  origemz.ui.image <chave> <base64>   (RCON)
 3. o plugin guarda            →  FileStorage.server.Store(bytes, png) → CRC
 4. a tela referencia          →  {img:ozcoin}, e o plugin troca pelo CRC
```

O mecanismo está documentado em `core/src/game/ui-images.ts`, e o cabeçalho de
lá já explica por que este é o único dos três modos do CUI que serve:

> *"**sprite** — asset do jogo, só o que a Facepunch já pôs lá. **url** — o
> cliente baixa; exigiria a imagem publicada num endereço que todo jogador
> alcance, e o agente escuta em 127.0.0.1. **png** — um CRC do FileStorage do
> servidor. É este."*

**Os dois comandos, e quando usar cada um** — medidos em `OrigemZUI.cs`:

| Comando | Para quê | Teto |
|---|---|---|
| `origemz.ui.image <chave> <base64>` | uma linha só | **45.000** caracteres de base64 ≈ 33 KB de PNG |
| `origemz.ads.image.begin/.part/.end` | imagem grande, fatiada | 128 pedaços de ~27 KB ≈ 3,4 MB (o agente corta em 1,5 MB) |

E o porquê do fatiamento está escrito no plugin, com o número medido:

> *"O frame do WebRCON aguenta ~50 KB, e base64 infla o arquivo em 4/3. Uma
> propaganda de 600×200 não cabe num comando só — o `origemz.ui.image` serve ao
> ícone de 17 KB do menu e não a isto."*

> **Para ícone de item, o comando de uma linha basta e sobra.** Um ícone de
> 128×128 pesa ~17 KB — medido, e é o que o menu já usa. **O item custom não
> precisa de canal novo: precisa de uma chave nova no canal que existe.**

**A regra que o plugin já aplica e que vale repetir:** meio arquivo nunca vira
imagem. O `end` confere a contagem antes de guardar, porque um PNG cortado é um
arquivo inválido — *"e o sintoma seria um quadrado vazio sem nada dizer por
quê"*.

#### 10.3.3 O cliente baixa **uma vez** — e o CRC é o que garante isso

Esta é a pergunta do dono, e a resposta é sim. O mecanismo tem três partes, e a
elegância está na terceira:

**1. O que viaja no item é o número, não a imagem.** O campo `iconImageId` é um
`UInt32` — **quatro bytes**. Um baú com 30 troféus manda 30 números, nunca 30
PNGs.

**2. O cliente só pede o que não tem.** Ao encontrar um CRC desconhecido, ele
faz um `FileRequest` pelo canal do próprio jogo e o servidor devolve os bytes do
`FileStorage`. Isso acontece **uma vez por cliente, por imagem**.

**3. E o número é o *hash do conteúdo*.** Medido na assinatura:

```csharp
Store(byte[] data, Type type, NetworkableId entityID, UInt32 numID) -> UInt32   // devolve o CRC
Get  (UInt32 crc,  Type type, NetworkableId entityID, UInt32 numID) -> byte[]
```

> **É por isso que o cache funciona sozinho, e é a parte que vale entender:** o
> identificador **nasce do conteúdo**. Imagem igual → mesmo CRC → o cliente
> reusa o que tem. Imagem trocada → CRC diferente → ele baixa a nova, sem
> ninguém precisar invalidar nada.
>
> **Trocar a logo da Bleik é substituir o PNG.** Não há versão para incrementar,
> nem cache para limpar, nem jogador que fique vendo a arte velha. O
> versionamento é uma consequência do desenho, não uma funcionalidade a
> construir.

**Onde o cache do cliente vive:** em disco, na instalação do jogador — é o que
se deduz do procedimento que a comunidade usa para consertar placas que não
carregam: *apagar os arquivos de `Cache`/`Image` da pasta do jogo e reverificar
pelo Steam*. **Isso é conferido, não medido**: o código de cache é `#if CLIENT` e
não existe no servidor dedicado, então não deu para ler aqui.

**As três consequências práticas:**

| | |
|---|---|
| **custo por jogador** | o PNG do ícone **uma vez na vida**, não por sessão |
| **custo por item entregue** | 4 bytes |
| **o que pesa de verdade** | o envio agente → plugin, que é **uma vez por boot do servidor** — e a memória do CRC é só o mapa chave→número (`origemz.ads.clearcache` esquece o mapa; *"os bytes continuam no FileStorage"*) |

> **Conclusão para o desenho:** o ícone custom **não tem custo recorrente**. Isso
> derruba a última objeção prática contra dar ícone próprio a todo item custom —
> e reforça o §3.6.2: a logo no slot é o melhor caminho para a marca aparecer.

#### 10.3.4 O corpo neutro: **medido, e não era o que parecia**

O corpo emprestado **traz os hábitos dele junto**, e essa é a regra que mais
custa caro neste sistema. Ela já mordeu duas vezes:

1. o primeiro Troféu Bleik nasceu **colocável no chão** — o `trophy` tem
   `ItemModEntity`, e ninguém pediu isso;
2. a **sacola**, que parecia o corpo neutro óbvio, **abre e sorteia loot**.

**O `origemz.item.inspect` existe por causa disso.** Ele lê os `ItemMod` de um
item do jogo e responde antes de o item custom existir — porque a ficha que o
servidor guarda em `Bundles/items/*.json` **não distingue**: `trophy` e
`bandage` têm exatamente os mesmos campos.

**Medido no `server01`, em 05/09/2026:**

| Item | `mods` | O que herda |
|---|---|---|
| `halloween.lootbag.small` | `ItemModUpgrade`, `ItemModOpenLootBag` | **abre e dá loot**; 10 viram uma média |
| `xmas.present.small` | `ItemModUpgrade`, `ItemModUnwrap` | **desembrulha** |
| `trophy` · `bandage` · `skull.trophy` | `ItemModEntity` | vira entidade (é o que torna o troféu colocável) |
| `easter.goldegg` | `ItemModCrackOpen` | quebra ao abrir |
| `head.bag` | `ItemModHead` | é a cabeça de alguém |

**Varridos 182 itens de `Misc`, `Items`, `Component` e `Resources` com stack ≥ 5:
31 não têm mod nenhum.** E entre eles há uma família inteira que serve:

> **as ID Tags** — `dogtagneutral`, `blueidtag`, `greenidtag`, `redidtag`,
> `grayidtag`, `lavenderidtag`, `mintidtag`, `orangeidtag`, `pinkidtag`,
> `purpleidtag` — **plaquetas de metal, stack 5000, zero comportamento**.

> **Por isso o padrão do cadastro é `dogtagneutral`.** Forma de plaqueta (o mais
> perto de uma medalha que o jogo tem), nada herdado, e nove cores irmãs para
> quando um segundo item custom precisar se distinguir do primeiro **na
> prateleira**, e não só no nome.
>
> **E a lição que fica maior que a escolha:** antes de adotar um item base novo,
> rode o `inspect`. O que ele faz sozinho é o que o item custom vai fazer sem
> ninguém ter pedido.

#### 10.3.5 O padrão quando o admin não escolhe nada

O dono pediu que o ícone caia no **saco** quando nada for escolhido, e que dê
para escolher o 3D de outro item. Os dois são a mesma decisão, tomada em dois
campos independentes da `custom_items`:

| Campo | Se preenchido | Se vazio |
|---|---|---|
| `base_shortname` | **o corpo 3D** é o daquele item | — (é obrigatório) |
| `icon_file` | o PNG nosso vira o ícone do slot | **o ícone do item base**, que é o que o jogador já conhece |

> **Vale ser exato sobre o "saco", porque ele é duas coisas diferentes**
> ([`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md) §2):
>
> - **no chão**, o que aparece é a malha do item base — nunca um saco genérico. O
>   `item_drop_backpack` só entra quando **vários** itens caem juntos;
> - **no slot**, o ícone é o do item base, salvo se mandarmos um PNG.
>
> Então "cair no saco" é o comportamento **do item base escolhido**, e a saída é
> a mesma nos dois casos: **escolher bem o `base_shortname`**. É de graça, é
> reversível, e é a primeira coisa que a tela de cadastro deve deixar óbvio —
> daí a prévia do §8.4.

### 10.4 O que o plugin **não** faz

- **não guarda ponto.** Ele emite; quem soma é o agente **[T§1.2]**;
- **não decide a regra.** A ação vem da tabela, e o plugin a executa;
- **não cria `ItemDefinition`.** Ver §3.6.

---

## 11 — O plano em fatias

Cada fatia entrega algo utilizável sozinho. Nenhuma delas depende de skin
publicada, de aprovação de terceiro ou de biblioteca externa.

### Fatia 1 — o item existe e é entregável

> Migração **041**. `custom_items` + `custom_item_servers`. Repositório, rotas de
> CRUD, e a aba "Nossos" na `/itens` com o cadastro. A entrega usa o
> `origemz.give` que já existe, passando o nosso `skinId`.

**Ao fim dela:** o admin cria o "Troféu Bleik Store", marca em quais servidores
ele vale, e entrega um a alguém pelo painel. O jogador vê uma taça com o nome
certo. **Nenhum plugin novo foi escrito.**

### Fatia 2 — o plugin reconhece a marca

> O pedido de sincronização passa a levar as marcas ativas. O `OnItemUse`
> decide pelo `skinId`. A ação `consume` (§5.2) funciona: a super bandagem cura o
> que o admin mandou.

**Ao fim dela:** o item custom **faz** alguma coisa.

### Fatia 3 — os pontos

> Depende da migração **033** do ranking **[R§9.2]** estar de pé. A ação
> `points` passa a emitir; o agente soma com lote idempotente; a ficha do
> jogador mostra.

**Ao fim dela:** o Troféu Bleik funciona ponta a ponta — o que hoje é o
`TROFEU_BLEIK_STORE.md` inteiro, menos a dungeon e as missões.

### Fatia 4 — o site

> `custom-items-mirror.ts` (§9.3) e o documento para o agente do site.

### Fatia 5 — a arte

> A skin com a logo, publicada e **não aprovada** (§4.3). É trocar uma constante:
> o `skin_id` da linha. **Nada do que veio antes depende disto.**

> **A ordem não é negociável nas três primeiras.** A 2 sem a 1 não tem o que
> reconhecer; a 3 sem a 033 do ranking não tem onde somar. A 4 e a 5 podem vir
> em qualquer momento depois da 1.

### 11.6 As cinco perguntas que o Troféu Bleik faz a este documento

O `TROFEU_BLEIK_STORE.md` **[T§2.4]** abriu uma "via D" para o sistema de item
custom e deixou cinco perguntas escritas, com a observação de que aquele §2 deve
ser revisto quando este documento existir. Aqui estão as respostas.

**1 — "Ele troca o ícone do slot sem depender de skin aprovada?"**

**Sim. Medido no código-fonte da biblioteca, e é a melhor notícia da pesquisa.**

O campo `iconImageId` (`UInt32`) viaja na rede junto com o item, e a
`CustomItemDefinitions` o preenche com o retorno de:

```csharp
FileStorage.server.Store(pngBytes, FileStorage.Type.png, default)  // → uint
```

> **O servidor manda o PNG.** Sem workshop, sem aprovação da Facepunch, sem
> depender de o item base ter `HasSkins: true` — e portanto **sem nenhum dos
> riscos do §4**. A logo da Bleik Store pode estar no slot do inventário.
>
> Isso **contradiz o `[T§2.2]`**, que registra o ícone como *"só por skin
> aprovada"*. O detalhe do mecanismo está no §3.6.2, e o caminho do PNG até o
> plugin no §10.3.2.

**Duas ressalvas honestas:** exige adotar a biblioteca (§3.6.4 e §3.6.5), e é
**ícone 2D no slot** — a malha 3D na mão do jogador continua sendo a do item
base. A recomendação do `[T§2.5]` — a medalha em alta fidelidade no CUI —
**continua valendo** e não compete com esta: uma resolve o slot, a outra a tela.

**2 — "O item custom sobrevive a `oxide.reload` e a restart do servidor?"**

**Sim — e a resposta depende de qual das duas identidades o item usa.**

| | Fatia 1: `(item base, skinId)` | Com a `CustomItemDefinitions` |
|---|---|---|
| `oxide.reload` do **nosso** plugin | **intacto** — as duas metades são gravadas pelo jogo, nada nosso precisa estar carregado | **sobrevive inerte**: vira o pai sem os `ItemMod`, e volta ao normal quando o plugin recarrega |
| restart / wipe | **intacto** | **intacto** — o `parentMap` é persistido em disco |
| a **biblioteca** sair | não se aplica | **os itens somem** — sem o `Item_Load_Patch`, o `itemid` custom não acha definição e cai no descarte do §3.2 |

> A avaliação anterior desta pergunta dizia "vira carvão" e vinha da página do
> Codefling. **O código diz outra coisa** (§3.6.4): o fallback declarado é
> `batteringram.head.repair`, e ele só entra quando nem o pai é conhecido.
>
> **A ressalva que fica de pé é outra, e é mais séria:** adotar a biblioteca é
> adotar uma **dependência crítica**. Ela sobrevive bem ao nosso reload; o que
> não sobrevive é ela mesma sair — e ela faz Harmony patching na serialização
> de rede, que é o tipo de código que um update do Rust quebra. É por isso que a
> Fatia 1 não a usa (§3.6.5), e não porque os itens virariam carvão.

**3 — "Como ele identifica o item — `skinId`, `item.name` ou campo próprio?
Isso decide o filtro do hook de conversão."**

**Pelo `skinId`, e ele é obrigatório e único.** A tabela recusa `'0'` no próprio
`CHECK` (§7.1), e há um índice único sobre `(base_shortname, skin_id)`.

O filtro do hook do `[T§3.3]` fica, então:

```csharp
// A marca e o par (itemid do base, skin). O nome NAO serve de
// filtro: ele e sobrescrivivel e nao sobrevive a todos os
// caminhos. Ver a §3.4 da pesquisa de item custom.
if (item.info.itemid != TrophyBaseItemId) return;
if (item.skin != TrophySkinId) return;
```

> **E há um brinde que só apareceu ao cruzar os dois documentos.** O `[T§2.6]`
> registra um crash **medido** que derruba o jogador do servidor: `skinid: 0`
> num item sem skins faz o `FirstOrDefault` do cliente devolver o default do
> struct — cujo `id` também é 0 —, o `if` passa, e o `skin.invItem` nulo estoura.
>
> **Com `skinId` obrigatoriamente diferente de zero, a comparação
> `0 == <nosso skinId>` é falsa e o caminho do crash não é tomado.** A regra que
> nasceu para o item ser distinguível **também fecha essa porta**. As duas
> defesas do `[T§2.6]` continuam necessárias — esta é uma terceira, de graça.

**4 — "Ele já resolve `max_stack` por item, sem plugin de stack global?"**

**Sem a biblioteca, não. Com ela, sim** — e essa era a saída limpa que o
`[T§2.7]` procurava.

O DTO tem o campo, e o exemplo oficial o usa:

```csharp
public int? maxStackSize;      // no ItemDefinitionDto
maxStackSize = 1,              // no exemplo oficial
```

Como a definição custom é **uma cópia** da do pai, mexer no `maxStackSize` dela
**não toca no item do jogo** — o `trophy` de todo mundo continua empilhando 1.
É exatamente a distinção do §5.3 (nunca altere a `ItemDefinition` do jogo)
respeitada por construção.

> **Portanto o stack de 5 do briefing deixa de ser um problema**, se a
> biblioteca entrar. Sem ela, a saída continua sendo a do `[T§2.7]`: trocar o
> item base. Nos dois casos o `origemz.give` já fatia pelo stack correto, sem
> código novo.

**5 — "O `origemz.give` consegue entregar um item dele, ou é preciso comando
novo?"**

**Consegue, hoje, sem uma linha de código nova.** O contrato já tem o campo:

```
origemz.give <steamId> <shortname> <amount> <skinId> <mode>
```

O item custom entrega `base_shortname` no `<shortname>` e `skin_id` no
`<skinId>`. É por isso que a **Fatia 1 termina com um item entregável sem
plugin novo** — o cano já existe e é o mesmo da loja
(`core/src/store/service.ts:725`).

> **A conclusão para o `[T§2.4]`:** a via D **não substitui** a via A — ela a
> **formaliza**. O que o troféu chamava de "item nativo renomeado com `skinId`
> configurável" é exatamente o que a `custom_items` guarda, com a diferença de
> que passa a ser cadastrável no painel, ligável por servidor e reutilizável
> pelo segundo item que vier. A recomendação (a) da **Q7** do troféu — *começar
> pela via A e revisar depois* — **continua certa**, e a revisão é barata:
> o `shortname` e o `skinId` viram uma linha de tabela.
>
> **Com uma emenda que a medição impõe:** a via A propõe `trophy` com
> `skinId = 0`, e este documento **recusa `skinId = 0`** — pela distinguibilidade
> (§3.4) e pelo crash do `[T§2.6]`. A via A deve nascer já com um `skinId` nosso,
> mesmo que nenhuma arte exista ainda.

---

## 12 — Medido, conferido, projeto

**A regra da casa:** o que foi lido da árvore, do banco ou do binário é
**medido**. O que veio de fonte externa é **conferido**, com a fonte. O resto é
**projeto** — e projeto não vira relato.

### Medido (lido aqui, em 05/09/2026)

| Fato | Onde |
|---|---|
| 1259 itens, 14 categorias | `data/rustagent.db`, tabela `items` |
| **104 de 1266 itens aceitam skin** | `Bundles/items/*.json`, campo `HasSkins` |
| `skull.trophy` é o único troféu skinável | idem |
| a ficha do item é JSON (1,6 MB); a arte é bundle (4,4 GB) | `Bundles/` do `server01` |
| os campos que viajam ao cliente | `ProtoBuf.Item`, `Rust.Data.dll` |
| `Load invalid item id … (no ItemDefinition found)` | `Assembly-CSharp.dll` |
| `GameObjectRef` é só um `guid` (String) | `Assembly-CSharp.dll` |
| 109 `ItemMod` no jogo | `Assembly-CSharp.dll` |
| os 8 efeitos de consumo | enum `MetabolismAttribute.Type` |
| as 18 `ItemCategory` (14 em uso) | enum `ItemCategory` |
| `item_drop_backpack.prefab` | `Assembly-CSharp.dll` |
| `workshop.print_approved_skins`, `workshop.skinnables` | `Assembly-CSharp.dll` |
| `FileStorage.Store(…) → UInt32` **é o CRC do conteúdo**; `Get(crc, …)` recupera | `FileStorage`, `Assembly-CSharp.dll` |
| os tipos aceitos: `png`, `jpg`, `ogg`, `sculpt` | enum `FileStorage.Type` |
| o canal agente→jogo para imagem **já existe e roda** | `game/ui-images.ts` + `OrigemZUI.cs:670` |
| teto de uma linha: **45.000** caracteres de base64 (~33 KB) | `UI_IMAGE_MAX_BYTES` |
| o WebRCON aguenta ~50 KB por frame; base64 infla 4/3 | `OrigemZUI.cs:2513-2520` |
| imagem grande vai fatiada: 128 × ~27 KB ≈ 3,4 MB | `origemz.ads.image.begin/.part/.end` |
| um ícone de 128×128 pesa ~17 KB | `ui-images.ts` |
| `OnItemAction(item, action, player)` intercepta o menu | uMod (conferido) |
| o menu do item é `Sprite` + `Phrase` — assets do cliente | `BaseEntity.Menu.Option` |
| o `skinId` atravessa give, loja, kit e CUI | 25 pontos em `core/src` |
| a última migração é a 040; 033/034 reservadas | `db/migrations.ts:3117` |
| o catálogo lê do primeiro servidor no ar | `game/item-catalog.ts:342` |
| `kit_servers` é o molde do "em quais servidores" | `db/migrations.ts:1035` |
| um servidor cadastrado hoje (`server01`) | `data/rustagent.db`, tabela `servers` |

### Medido **no servidor rodando** (05/09/2026, `server01`, via RCON)

Estes não vieram de leitura: vieram do `Plugins/OrigemZItems.cs` carregado num
Rust de verdade, com o `origemz.item.diag`.

| Fato | Evidência |
|---|---|
| **o `skinId` sobrevive em item com `HasSkins: false`** | `trophy` + skin 3000000001 → `skinSurvived: true` |
| o nome custom gruda na instância | `nameApplied: true` |
| o `iconImageId` aceita o CRC na instância | `iconApplied: true` |
| `FileStorage.server.Store` funciona pelo nosso plugin | 24.917 bytes → `crc 3569266776` |
| um PNG de 96×96 da arte real cabe numa linha de RCON | 33.224 caracteres de base64 |
| um PNG de 128×128 da arte real **não** cabe | 43.450 bytes > o teto de 33.000 |
| o plugin compila em C# 5 e carrega no Oxide | `oxide.plugins` lista `OrigemZItems (0.1.0)` |

> **A ressalva que falta, e ela importa:** `iconApplied: true` diz que o campo
> foi **escrito no servidor**. Que o **cliente desenha** aquele PNG no slot
> ainda não foi visto por ninguém — para isso é preciso um cliente conectado.
> É o próximo teste, e o único que sobrou entre nós e a arte no inventário.

### Medido no código-fonte da biblioteca

Lido em [`CustomItemDefinitions.cs`](CustomItemDefinitions.cs) v2.5.4 (2169
linhas) e em [`simpleexampleofitemcreation.cs`](simpleexampleofitemcreation.cs),
ambos baixados pelo dono nesta sessão:

| Fato | Onde |
|---|---|
| o item sai para o cliente **como o pai** — patch na escrita do protobuf | `ProtoWriteToStream`, `Mutate.ToClientSide` |
| **o ícone é um PNG do servidor**: `FileStorage.server.Store(…) → iconImageId` | linha 1889, e `Dictionaries.IconId` |
| `maxStackSize` é **por item** | `ItemDefinitionDto`, e o exemplo oficial |
| dá para escrever `ItemMod` próprio em C# | `class ItemModTest : ItemMod`, no exemplo |
| a descrição custom é injetada como *ownership* | `Mutate.Item.Description` → `AddOwnership` |
| o `itemId` default é `shortname.GetHashCode()` | `ItemDefinitionDto.FillEmptyValues` |
| plugin fornecedor fora → item vira **o pai**, sem `ItemMod` | `OnItemDefinitionBroken`, `parentMap` persistido |
| o fallback é `batteringram.head.repair`, **não carvão** | linha 32 |
| a biblioteca fora → o item **é descartado** no load | ausência do `Item_Load_Patch` + §3.2 |

### Conferido (fonte externa, com a fonte)

| Fato | Fonte | Confiança |
|---|---|---|
| não há como enviar modelo 3D ao cliente | uMod, Oxide (§ver doc 02) | **alta** — três fontes |
| skin do workshop é textura, não malha | wiki da Facepunch | **alta** — fonte primária |
| `OnItemAction(item, action, player)` existe e cancela | uMod | **alta** — usado em plugins públicos |
| ~~item vira carvão quando o plugin sai~~ | Codefling | **refutado** pelo código — ver acima |
| a regra de DLC/skin paga, 07/08/2025 | uMod, GamingHQ, HNCRust | **média** — a primária deu 404 |
| skin não aprovada continua permitida | as mesmas três | **média** |
| o cliente **baixa** skin não aprovada | as mesmas três | **em disputa** — ver §4.4 |

> **Nota sobre o §4, depois da leitura do código:** a descoberta do ícone por
> `FileStorage` (§3.6.2) **tira a urgência da disputa do §4.4**. Se a logo pode
> ir pelo ícone, a skin deixa de ser o único caminho para a marca aparecer — e
> a pergunta "aprovada ou não aprovada?" deixa de bloquear qualquer coisa.

### Projeto (nada disto existe)

Tudo do §7 ao §11: as tabelas, as rotas, as telas, os hooks, as fatias.

---

## 13 — Perguntas em aberto para o dono

**Q1 — A categoria do item custom é livre ou é uma das 14 do jogo?**
A proposta é livre (§7.1), porque "Troféu" não é `Misc`. Mas categoria livre
significa que dois admins criam "Trofeu" e "Troféus" e a tela mostra duas. A
alternativa é uma lista fechada que só o dono edita. **Recomendo livre com
sugestão das existentes** — é o comportamento do campo de categoria de kit, que
já está de pé.

**Q2 — Quando o admin cria um item custom, ele escolhe o `skinId` ou o agente
sorteia?**
Escolher exige que ele tenha publicado a skin. Sortear (um número alto e não
usado) faz o item funcionar hoje, com aparência do base, e deixa a arte para
depois — que é o que a Fatia 5 assume. **Recomendo sortear com opção de
digitar.**

**Q3 — ~~Alguém consegue rodar os dois testes no `server01`?~~ RESPONDIDA.**

O primeiro teste **foi rodado em 05/09/2026**, no `server01` com o servidor no
ar, pelo `origemz.item.diag` do `Plugins/OrigemZItems.cs`. A resposta do
servidor, na íntegra:

```json
{"ok":true,"id":"trofeu-teste","base":"trophy","baseItemId":975983052,
 "definitionHasSkins":false,
 "skinRequested":"3000000001","skinAfterCreate":"3000000001",
 "skinFinal":"3000000001","skinSurvived":true,
 "iconCrc":3569266776,"iconApplied":true,"nameApplied":true}
```

> **O `skinId` SOBREVIVE num item com `HasSkins: false`.** O `trophy` não aceita
> skins — e guardou os 3000000001 mesmo assim. **A marca do §3.4 está medida, e
> o modelo de dados do §7.1 se apoia em chão firme.**

O segundo teste — se o cliente baixa skin **não aprovada** — continua aberto,
porque exige um cliente conectado. Mas ele **deixou de bloquear qualquer
coisa**: com o ícone por `FileStorage` funcionando (§3.6.2, e agora medido), a
arte do item não depende mais de skin nenhuma.

**Q6 — Qual é o corpo do Troféu Bleik? O trilema — que a biblioteca dissolve.**

A medição do §3.5 tinha fechado o cerco: não existe item que seja troféu **e**
aceite skin **e** empilhe. Escolha duas:

| Se o que importa é… | O item | O que se perde |
|---|---|---|
| **a forma de troféu** | `trophy` (taça dourada) | a logo — nunca terá skin |
| **a logo da Bleik** | `skull.trophy` | é troféu de caveira, categoria `Fun` |
| **empilhar 5** | `xmas.present.medium` | é um presente, e não aceita skin |

**Com a `CustomItemDefinitions`, o trilema deixa de existir.** As três coisas
passam a ser campos independentes:

| O que se quer | Como | Depende de `HasSkins`? |
|---|---|---|
| forma de taça | `parentItemId = trophy` | não |
| a logo no slot | `iconFileId` = o PNG da medalha (§3.6.2) | **não** |
| empilhar 5 | `maxStackSize = 5` (§11.6, pergunta 4) | não |

> **A pergunta ao dono muda de assunto.** Não é mais *"qual das três você abre
> mão?"*, é: **"vale adotar a `CustomItemDefinitions` para ter as três?"** — e o
> preço está no §3.6.4: uma dependência crítica que faz Harmony patching na
> serialização de rede, num jogo que atualiza toda quinta-feira.
>
> **Recomendo separar as duas decisões.** A Fatia 1 nasce sem a biblioteca, com
> `trophy` renomeado e `skinId` nosso — e isso já põe o troféu de pé. A adoção
> vira uma decisão própria, tomada depois, com o sistema funcionando e sem
> pressa. O §7.1 já deixa as colunas prontas para ela.

**Q4 — Quem lê a fonte primária das diretrizes da Facepunch?**
As URLs testadas deram 404 (§4.1). A regra existe — três fontes convergem —, mas
uma decisão de negócio com risco de delisting não deveria se apoiar em
jornalismo. Vale achar o texto oficial antes da Fatia 5.

**Q5 — O item custom entra na loja do site?**
O modelo comporta (`store_offer_items` já tem `skin_id`), mas ninguém pediu. Se
a intenção é vender troféu — o que **muda o desenho do ranking**, porque o
troféu é a métrica que dinheiro não compra **[T§3.1]** —, isso precisa ser dito
antes da Fatia 4.

---

## Referências no projeto

- [`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md) — o estudo de 3D, pedido em
  separado. As provas de por que malha própria não dá, e as quatro camadas de
  aparência que temos
- [`Docs/TrofeuBleik/TROFEU_BLEIK_STORE.md`](../TrofeuBleik/TROFEU_BLEIK_STORE.md)
  — o primeiro consumidor. **[T§n]** neste documento aponta para lá. As cinco
  perguntas da via D dele estão respondidas no §11.6, e o §2 dele **pede
  revisão** agora que este documento existe
- [`Docs/Ranking/19-PESQUISA-RANKING.md`](../Ranking/19-PESQUISA-RANKING.md) —
  onde os pontos moram. **[R§n]** aponta para lá
- [`Docs/17-FRENTES-WIPE-E-MENSAGENS.md`](../17-FRENTES-WIPE-E-MENSAGENS.md) §0.1
  — a regra de reserva de número de migração. **A reserva da 041/042 precisa ser
  registrada lá para valer** (§2.5)
- `core/src/db/migrations.ts` — o mecanismo de migração e a numeração reservada
- `core/src/db/items-repository.ts` · `core/src/game/item-catalog.ts` — o
  catálogo do jogo, a leitura e a invalidação por protocolo
- `core/src/http/routes/items.ts` — o molde das rotas novas
- `core/src/game/items-mirror.ts` — o espelho para o site, e o molde do §9.3
- `core/src/game/plugin-contract.ts` — o `origemz.give` e o campo `skinId`
- `core/src/game/ui-cui.ts` — o `skinIdOf` e o crash do `skinid: 0` (**[T§2.6]**)
- `panel/src/app/itens/page.tsx` — a tela a mudar (§8)
- `panel/src/components/item-combobox.tsx` — o seletor de item base (§8.4)
- `Plugins/OrigemZAgent.cs` — o `give`, o fatiamento por stack, e o pedido de
  sincronização do §10.1
- `Servers/server01/Bundles/items/*.json` — a ficha de cada item, com o
  `HasSkins` do §3.5

## Fontes

- [uMod — Rust API](https://umod.org/documentation/games/rust)
- [uMod — Adding new custom models, like weapon, vehicles or player?](https://umod.org/community/rust/24417-adding-new-custom-models-like-weapon-vehicles-or-player)
- [uMod — Big change coming to servers](https://umod.org/community/rust/56533-big-change-coming-to-servers)
- [Codefling — Custom Item Definitions](https://codefling.com/extensions/custom-item-definitions)
- [Codefling — Custom Item Manager](https://codefling.com/plugins/custom-item-manager)
- [Rust Wiki — Creating Skins](https://wiki.facepunch.com/rust/Creating_Skins)
- [Rust Wiki — Getting Your Skin Accepted](https://wiki.facepunch.com/rust/Getting_Skin_Accepted)
- [GamingHQ — Facepunch Enforces New Restrictions on Rust Skins and DLCs](https://gaminghq.eu/2025/07/18/facepunch-restricts-rust-skins-dlc-community-servers/)
- [HNCRust — Facepunch's New TOS 2025](https://hncrust.com/facepunchs-new-tos-2025/)
- [CHAOS — SkinBox](https://chaoscode.io/resources/skinbox.17/)
