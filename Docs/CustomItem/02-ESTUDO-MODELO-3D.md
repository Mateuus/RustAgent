# ESTUDO — modelo 3D próprio no Rust

> **A pergunta que este documento responde**, nas palavras do dono:
>
> > *"O jogo hoje usa uma sacola como padrão para itens quando ele não tem o
> > modelo 3D; o nosso item pode pegar um 3D de algum outro item que já tem no
> > jogo. Mas quero um estudo se conseguimos usar 3D nosso sem fazer mod. (Se
> > não for, tudo bem, seguimos.)"*
>
> **A resposta curta é não**, e este documento existe para mostrar **por que**
> não — com prova tirada do binário do jogo instalado aqui, e não de fórum. A
> segunda metade mostra o que **dá**, que é bastante, e onde a identidade visual
> da Bleik Store pode morar mesmo assim.
>
> Documento irmão: [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md).

---

## Índice

| § | Assunto |
|---|---|
| [1](#1--a-resposta-em-uma-página) | A resposta em uma página |
| [2](#2--a-sacola-o-que-ela-é-de-fato) | A sacola: o que ela é de fato |
| [3](#3--as-três-provas-de-que-3d-próprio-não-dá) | As três provas de que 3D próprio não dá |
| [4](#4--o-que-dá-pegar-o-3d-de-outro-item) | O que dá: pegar o 3D de outro item |
| [5](#5--as-quatro-camadas-de-aparência-que-temos) | As quatro camadas de aparência que temos |
| [6](#6--e-aqueles-servidores-que-parecem-ter-coisas-novas) | E aqueles servidores que "parecem ter coisas novas"? |
| [7](#7--o-veredito) | O veredito |
| [8](#8--medido-conferido-não-medido) | Medido, conferido, não medido |

---

## 1 — A resposta em uma página

### 1.1 A frase

> **O Rust não tem canal para o servidor mandar geometria ao cliente.**
> Toda malha 3D que um jogador vê já estava no disco dele antes de ele
> conectar. Um servidor só pode **escolher** entre as malhas que o jogador já
> tem — nunca acrescentar uma.

### 1.2 Por que isso é uma barreira de arquitetura, e não uma limitação de API

O Rust distribui arte em **AssetBundles** da Unity, gerados junto com o build do
jogo e versionados com ele. Medido nesta instalação:

```
Servers/server01/Bundles/
  items/          1266 arquivos .json    1,6 MB   ← o DADO do item
  shared/         bundles da Unity       4,4 GB   ← a ARTE
  maps/                                  341 MB
  Bundles         (AssetBundle UnityFS, Unity 6000.3.15)
```

Essa separação é o desenho inteiro em duas linhas: **o dado do item é texto e
pesa 1,6 MB; a arte é binário e pesa 4,4 GB.** O servidor manda dado. A arte já
está do outro lado, ou não está — e nada no protocolo a transporta.

Um modelo nosso teria que entrar naqueles 4,4 GB **na máquina de cada jogador**.
Isso é, por definição, modificar o cliente. É o que o dono chamou de "fazer mod",
e é justamente o que ele quer evitar.

### 1.3 O que muda com isso

Nada trava. O item custom continua inteiro:

| O que se quer | Dá? | Como |
|---|---|---|
| forma 3D de troféu | **sim** | usar a taça que o jogo já tem (§4) |
| nome "Troféu Bleik Store" | **sim** | campo `name`, viaja na rede |
| a logo da Bleik no objeto | **sim, com ressalva** | skin não aprovada, §5.3 |
| **malha 3D desenhada por nós** | **não** | §3 |
| ícone próprio no inventário | **quase** | §5.4 |

---

## 2 — A sacola: o que ela é de fato

O dono observou certo — a sacola existe e aparece. Vale precisar o que ela é,
porque o nome sugere um mecanismo que não é bem o que acontece.

**Medido:** varrendo as strings do `Assembly-CSharp.dll`, existe **um único**
prefab de "item drop" no jogo inteiro:

```
assets/prefabs/misc/item drop/item_drop_backpack.prefab
```

É a mochila que aparece quando **um monte de itens cai junto** — o jogador
morre, um baú é destruído, um corpo despawna. O jogo não desenha trinta objetos
espalhados; ele desenha um saco e põe tudo dentro.

**O que ela não é:** ela não é um "modelo padrão para item sem 3D". Cada item
tem o seu, no campo `worldModelPrefab` da `ItemDefinition` (§4.1). O que a
sacola faz é **agrupar**, não **substituir**.

> **A confusão é compreensível e o efeito prático é o mesmo:** quem vê uma
> sacola no chão está vendo o jogo desistir de desenhar objeto por objeto. E se
> um item chegasse ao mundo sem malha definida, o resultado seria pior que uma
> sacola: seria nada — o mesmo destino do item com `itemid` desconhecido (§3.1).

**O que não consegui medir, e por que:** o comportamento exato do jogo diante de
um `worldModelPrefab` vazio. A razão está no §3.2 — esses prefabs são
referenciados por **GUID**, não por caminho de texto, então eles simplesmente
não aparecem como string no binário para eu ler. É uma lacuna honesta, e ela não
muda nenhuma conclusão: nós nunca vamos criar um item sem malha, porque todo item
nosso empresta a malha de um item do jogo.

---

## 3 — As três provas de que 3D próprio não dá

Cada uma sozinha já fecha a questão. Juntas, não sobra dúvida.

### 3.1 Prova 1 — o cliente descarta o que não conhece

Um item chega ao cliente como uma mensagem cujo campo `itemid` (`Int32`) serve
para **procurar a definição na instalação dele**. Se a procura falha, o item não
entra. O jogo diz isso em voz alta — **medido, string literal no
`Assembly-CSharp.dll`**:

```
Load invalid item id {0} from item {1} (no ItemDefinition found)
```

> Um item que o cliente não conhece **não renderiza errado: não chega.** E se
> nem o *item* pode ser novo, a *malha* dele muito menos.

### 3.2 Prova 2 — a malha é um GUID, e o GUID aponta para o disco do jogador

O campo que guarda o modelo 3D de um item é `worldModelPrefab`, do tipo
`GameObjectRef`. **Medido** — a estrutura inteira do `GameObjectRef`, por
reflexão sobre o assembly:

```
GameObjectRef : ResourceRef<GameObject>
  guid           String
  _cachedObject  GameObject
```

**Dois campos, e um deles é cache.** A referência a um modelo 3D no Rust é
**uma string de GUID** — um ponteiro para dentro do AssetBundle do jogador.

Isso é o mecanismo inteiro, e ele responde as duas metades da pergunta de uma
vez:

- **trocar o GUID por outro que o jogador já tem** → funciona. É o §4;
- **inventar um GUID** → aponta para nada. Não há erro elegante; há ausência.

### 3.3 Prova 3 — skin é textura, não geometria

A saída que sempre ocorre a quem pergunta é "então a gente faz uma skin". Ela
não resolve, e a fonte é primária — a **wiki da própria Facepunch**, na página
de criação de skins:

> Skins afetam **apenas texturas**, não geometria. As orientações são de manter
> a textura em potência de dois (256×256, 512×512, 1024×1024) e, na dúvida, do
> mesmo tamanho da original.

Uma skin é **tinta sobre a malha que já existe**. Um troféu skinado continua com
o formato de troféu; ganha as cores e a arte. É útil (§5.3), mas não é 3D novo.

### 3.4 E o que a comunidade diz

Convergente e sem exceção, nas duas comunidades de modding do jogo:

> *"Não há como enviar modelos novos ao cliente a partir do servidor. Acrescentar
> modelos novos ao jogo não é possível sem uma modificação de cliente."*
>
> *"Oxide é uma API puramente do lado do servidor; ela só interage com o cliente
> na medida em que o Rust permite. Os jogadores conectam com o cliente padrão,
> sem download nenhum."*

---

## 4 — O que dá: pegar o 3D de outro item

Esta é a metade boa, e é exatamente o que o dono já tinha intuído.

### 4.1 O mecanismo

A `ItemDefinition` tem dois campos de modelo — **medidos** por reflexão:

```
worldModelPrefab      GameObjectRef        a malha, por GUID
worldModelOverrides   OverrideWorldModel[] trocas condicionais
```

E o `OverrideWorldModel` guarda:

```
worldModel     GameObjectRef
minStackSize   Int32
```

> **Leia o que isso quer dizer:** o jogo **já troca a malha de um item conforme
> a quantidade empilhada**. Uma unidade parece uma coisa; cinco parecem outra. O
> mecanismo de "este item usa aquela malha ali" **é nativo e está em uso**.

### 4.2 As duas maneiras de usar isso

| | Como | Custo | Risco |
|---|---|---|---|
| **A — escolher o item base** | o item custom nasce como `trophy`, e pronto | zero | **nenhum** |
| **B — trocar o `worldModelPrefab`** | apontar o GUID da definição para outra malha do jogo | plugin | **alto** — a `ItemDefinition` é do jogo; a troca vale para **todo** `trophy` do servidor |

**A recomendação é a A, e sem hesitação.** É a mesma armadilha que o
`01-PESQUISA` documenta duas vezes (§3.5 dele, e §5.3 sobre a super bandagem):
*a `ItemDefinition` é do jogo, e mexer nela vale para todos.* Trocar a malha do
`trophy` mudaria o troféu do Twitch de quem o tivesse.

> **Na prática:** "pegar o 3D de outro item" quer dizer **escolher outro item
> base**. É uma linha na tabela `custom_items`, é reversível, e não afeta
> ninguém.

### 4.3 O catálogo é grande, e é seu

São **1259 malhas** já instaladas na máquina de cada jogador. Para um troféu, o
jogo oferece taça, caveira, ovo dourado, presente, estátua. Para uma "super
bandagem", oferece a bandagem. Para uma medalha, oferece as três de troféu.

A escolha é de produto, não de engenharia — e o `01-PESQUISA` §13, Q6 põe o
trilema do troféu (forma × logo × empilhamento) na mesa do dono.

---

## 5 — As quatro camadas de aparência que temos

Ordenadas de "custo zero" a "custo real". As três primeiras não dependem de
ninguém de fora.

### 5.1 O nome — grátis, e mais forte do que parece

O campo `name` **viaja na rede** (medido em `ProtoBuf.Item`). Sobrescrevê-lo é
uma atribuição, e o jogador lê **"Troféu Bleik Store"** ao passar o mouse.

> Não subestime esta camada. Num jogo em que todo mundo vê os mesmos 1259 itens,
> **o nome é o que diz que aquilo é seu.**

### 5.2 A escolha do corpo — grátis

Escolher `trophy` em vez de `xmas.present.medium` é a diferença entre uma taça e
um presente de Natal. Custa uma linha e decide a leitura do objeto (§4.2).

### 5.3 A skin — a logo de verdade, com duas ressalvas

É aqui que a Bleik Store pode aparecer no objeto. Uma skin publicada no workshop
troca a textura do item, e o cliente a baixa.

**Ressalva 1 — ela precisa ser NÃO aprovada, e este ponto está em disputa.**
Desde 7 de agosto de 2025 a Facepunch proíbe servidor dar skin paga a quem não a
possui, sob pena de delisting. Skin aprovada é skin vendida, logo paga, logo
proibida — e a faixa que sobrou é a das **não aprovadas**, com as quais o
SkinBox continua funcionando.

> **Mas o `TROFEU_BLEIK_STORE.md` §2.2 afirma o contrário** — que o cliente só
> baixa skin aprovada, e que a não aprovada aparece como o item sem skin. As
> duas versões, a evidência de cada uma e o teste que decide estão em
> `01-PESQUISA` §4.4. **Nenhuma das duas está medida**, e nenhuma fatia do
> projeto depende de qual vence.

**Ressalva 2 — o item base precisa aceitar skin, e a maioria não aceita.**
Medido nos 1266 JSONs de `Bundles/items/`: **104 têm `HasSkins: true`**, 1162
não. E, entre os troféus, **só o `skull.trophy`**.

> **Consequência prática:** a logo e a forma de taça são, hoje, **mutuamente
> exclusivas**. Ver `01-PESQUISA` §3.5 e §13, Q6.

### 5.4 O ícone — **confirmado**, e é o melhor caminho para a logo

> Esta seção dizia "não foi medido como ele se usa". **Agora foi** — o dono
> baixou o código-fonte da `CustomItemDefinitions` e a resposta estava lá.

Medido em `ProtoBuf.Item` e na classe `Item`, existe um campo que quase ninguém
menciona:

```
iconImageId    UInt32
```

Ele **viaja na rede** junto com o item. E a biblioteca mostra exatamente como se
preenche — é uma linha:

```csharp
uint iconId = FileStorage.server.Store(pngBytes, FileStorage.Type.png, default);
```

`FileStorage` é o mesmo mecanismo que placas e fotos usam para mostrar arte
arbitrária sem asset novo. **O servidor manda o PNG; o cliente desenha.**

> **É o melhor caminho para a logo da Bleik Store, e por larga margem:**
>
> | | skin (§5.3) | **ícone (`iconImageId`)** |
> |---|---|---|
> | precisa de workshop? | sim | **não** |
> | precisa de aprovação? | é o ponto em disputa | **não** |
> | risco de delisting? | é preciso ter cuidado | **nenhum** |
> | exige `HasSkins: true` no base? | **sim** — só 104 de 1266 | **não** |
> | onde aparece | slot **e** objeto 3D | **só no slot** |
>
> A skin ganha em um ponto — ela pinta o objeto na mão do jogador. O ícone ganha
> em todos os outros, e **não depende de ninguém de fora**.

**E o cliente baixa uma vez só.** O que viaja no item é o **CRC** — quatro
bytes. O cliente pede os bytes na primeira vez que encontra um CRC desconhecido,
guarda em disco, e nunca mais. E como o CRC **nasce do conteúdo**
(`FileStorage.Store` devolve o hash), trocar a logo é substituir o PNG: não há
versão a incrementar nem cache a limpar. O caminho inteiro, com os tetos
medidos, está em `01-PESQUISA` §10.3.2 e §10.3.3.

> **O canal já existe nesta casa.** `Assets/ui/*.png` → `origemz.ui.image` →
> `FileStorage` → `{img:chave}` roda hoje, para o ícone do OZCoin no menu. O
> ícone de item custom **não precisa de canal novo, só de uma chave nova**.

**A ressalva:** isso vem junto com adotar a `CustomItemDefinitions`, que é uma
dependência crítica — a avaliação inteira está em `01-PESQUISA` §3.6.4.

---

## 6 — E aqueles servidores que "parecem ter coisas novas"?

Vale responder, porque a pergunta volta sempre: existem servidores com dungeons,
bosses, NPCs e eventos que o Rust não tem. Como?

**Nenhum deles acrescentou geometria.** Todos recombinam o que já está no
cliente:

| O que parece | O que é |
|---|---|
| um boss novo | um NPC do jogo com vida, dano e nome mudados |
| uma dungeon | prefabs de monumento existentes, montados em outro lugar |
| um item mágico | item do jogo com nome, skin e hooks |
| uma arma custom | arma do jogo com projétil, cadência e dano mudados |

> É por isso que o Rust modded tem uma "cara" reconhecível: **todo servidor
> desenha com as mesmas peças.** O que distingue um servidor bom não é ter peças
> que os outros não têm — é o arranjo, a regra e o nome.

---

## 7 — O veredito

**Modelo 3D próprio sem modificar o cliente: não.** Três provas independentes,
duas delas medidas no binário do jogo que está instalado nesta máquina.

**E, como o dono já previu: tudo bem, seguimos.** Nada no Troféu Bleik nem no
item custom depende disso. O que segue:

1. **o item custom nasce escolhendo o corpo** entre 1259 malhas prontas — é o
   `base_shortname` da tabela `custom_items` (`01-PESQUISA` §7.1);
2. **a identidade vem do nome**, que é grátis e viaja na rede;
3. **a logo tem dois caminhos**, e os dois merecem ser testados antes de se
   escolher: a **skin não aprovada** (§5.3, com as duas ressalvas) e o
   **`iconImageId`** (§5.4, que pode ser melhor e ninguém investigou);
4. **o trilema do troféu** — forma, logo ou empilhamento, escolha dois — vai
   para o dono em `01-PESQUISA` §13, Q6.

> **A conclusão que vale guardar:** o limite não é o Rust ser fechado. É que a
> arte do jogo vive **do lado do jogador**, e o servidor conversa com ele em
> texto. Todo o desenho do item custom sai daí — e sai inteiro.

---

## 8 — Medido, conferido, não medido

### Medido aqui, em 05/09/2026

| Fato | Onde |
|---|---|
| `GameObjectRef` tem dois campos, e um é `guid` (String) | `Assembly-CSharp.dll`, reflexão |
| `Load invalid item id … (no ItemDefinition found)` | `Assembly-CSharp.dll`, string |
| `worldModelPrefab` e `worldModelOverrides` na `ItemDefinition` | idem |
| `OverrideWorldModel` = `worldModel` + `minStackSize` | idem |
| `iconImageId` (`UInt32`) viaja na rede | `ProtoBuf.Item`, `Rust.Data.dll` |
| `name` e `text` viajam na rede | idem |
| `item_drop_backpack.prefab` é o único prefab de item drop | `Assembly-CSharp.dll`, string |
| 104 de 1266 itens têm `HasSkins: true` | `Bundles/items/*.json` |
| dado do item: 1,6 MB · arte: 4,4 GB | `Bundles/` do `server01` |
| bundles são UnityFS, Unity 6000.3.15 | cabeçalho do arquivo `Bundles` |

### Conferido em fonte externa

| Fato | Fonte | Confiança |
|---|---|---|
| skin afeta textura, não geometria | wiki da Facepunch | **alta** — primária |
| não há como enviar modelo do servidor ao cliente | uMod, Oxide (2 tópicos) | **alta** — convergente |
| Oxide é puramente server-side | Oxide/uMod | **alta** |
| a regra de skin paga (07/08/2025) | uMod, GamingHQ, HNCRust | **média** — a primária deu 404 |

### **Não** medido — e é isto que falta

| O quê | Por que não deu | Como fechar |
|---|---|---|
| o que o jogo faz com `worldModelPrefab` vazio | os prefabs são GUID, não string legível | ler o IL de `Item.CreateWorldObject` |
| ~~como o `iconImageId` é escrito~~ | — | **fechado**: `FileStorage.server.Store` (§5.4) |
| ~~se o `skinId` sobrevive em item `HasSkins: false`~~ | — | **fechado e MEDIDO em 05/09/2026**: sobrevive. Ver `01-PESQUISA` §13, Q3 |
| se o **cliente desenha** o `iconImageId` no slot | precisa de um cliente conectado | entrar no `server01` e olhar o item |
| se o cliente baixa skin não aprovada hoje | idem | deixou de bloquear: a arte vai pelo ícone |

---

## Fontes

- [Rust Wiki — Creating Skins](https://wiki.facepunch.com/rust/Creating_Skins)
- [uMod — Adding new custom models, like weapon, vehicles or player?](https://umod.org/community/rust/24417-adding-new-custom-models-like-weapon-vehicles-or-player)
- [uMod — Client side modding?](https://umod.org/community/general-support/33905-client-side-modding)
- [Oxide — 3D modelling for Rust and for developing plugins?](https://oxidemod.org/threads/3d-modelling-for-rust-and-for-developing-plugins.16293/)
- [GitHub — OxideMod/Oxide.Rust](https://github.com/OxideMod/Oxide.Rust)
