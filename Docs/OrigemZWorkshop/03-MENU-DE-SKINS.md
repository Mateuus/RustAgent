# OrigemZWorkshop — o menu de skins

A tela do [02-SKINS-DO-JOGADOR.md](02-SKINS-DO-JOGADOR.md). É para quem vai desenhá-la no
plugin (frente D do [05](05-PLANO-E-FRENTES.md)).

As imagens que o dono mandou em 17/09/2026 (a tela de crafting do Rust e um protótipo "SKINS")
são **referência de layout**. O que vale é o que está escrito aqui.

---

## 1. Quem desenha: o plugin, não o agente

**Decisão técnica, 17/09/2026.** As telas do menu principal são montadas pelo agente e servidas
por `#OZUIREQ` (`core/src/game/ui-*.ts`), e cada clique volta ao agente. Esta tela **não** segue
esse caminho. Ela é desenhada pelo `OrigemZWorkshop.cs`, como a grade da caixa de hoje
(`DrawBox`, `:1600-1770`).

Os motivos:

| Pelo agente | Pelo plugin |
|---|---|
| cada clique (categoria, página, skin, busca) é uma ida e volta por RCON | cada clique redesenha na hora |
| o agente não sabe o inventário vivo; teria de pedir `origemz.player.inventory` a cada tela | o plugin **é** o servidor: o inventário está na mão |
| o catálogo e a posse precisariam ser relidos no banco | o plugin já tem os dois em memória (02 §5) |
| a tela tem de caber num frame de 50.000 bytes inteira | o plugin redesenha **só a região que mudou** (§6) |
| aplicar a skin precisa voltar ao plugin de qualquer jeito | aplicar é local |

**O preço:** o visual não sai de graça do `ui-widgets.ts`. O plugin copia os **tokens**
(§2) e as medidas da moldura. Isso é aceitável porque a tela é uma só.

> **Confirmado no jogo em 17/09/2026, com o dono no server01 (v0.4.0).** A abertura sai em
> **três** `AddUI` (cerca de 30, 32 e 8 KB — §8.4), ou seja: pelo caminho do agente, com o
> teto de 50.000 num frame, ela não caberia inteira. A coluna da direita da tabela é o que
> está de pé.
>
> **Os ícones da tela também são nossos.** Nenhum sprite do jogo se confirmou (os bundles do
> servidor são compactados, e um caminho errado desenha um quadrado branco), então os cinco
> ícones do cabeçalho e a estrela das favoritas são PNG de 64×64 nossos, guardados em
> `Assets/menu-icons/` e embutidos em base64 no plugin. No boot eles vão para o `FileStorage`
> e o CUI os pede pelo CRC (memória: *o FileStorage indexa por conteúdo*). O CUI os tinge,
> então eles são brancos sobre transparente. Sem CRC (FileStorage ainda vazio), cada um cai
> para uma letra.

**Como o menu principal chega aqui:** uma aba **SKINS** no `ui-preset-main-menu.ts` com ação
`chat` → `/skins`. O menu principal fecha e este abre. Custa cerca de 970 bytes na carga
inicial (memória: *onde estão os bytes do menu*); confira que a carga continua abaixo de
50.000.

> **Feito (frente F, 17/09/2026).** A aba fica logo depois de KITS e custou **1.024 bytes**: a
> carga inicial foi de **44.508** para **45.532** (trava do teste: 47.800). O código é
> `core/src/game/ui-skins-tab.ts`; o §7.2 conta a ligação entre os dois plugins.

---

## 2. Visual — os tokens do menu

Copiados de `core/src/game/ui-widgets.ts:26-48` (objeto `C`). **Se um dia mudarem lá, mudam
aqui.** Deixe um comentário no C# apontando a origem.

| Token | Valor | Uso |
|---|---|---|
| bg | `#0F0F0F` | fundo da janela |
| surface | `#1B1B1B` | painéis |
| surface2 | `#262626` | células, item de lista |
| border | `#2E2E2E` | divisórias |
| text | `#E8E8E8` | texto |
| muted | `#9A9A9A` | texto secundário, "não obtida" |
| rust | `#C43F2C` | acento (título, item ativo, botão principal) |
| olive | (ver `C`) | "obtida", "aplicada" |
| amber | (ver `C`) | prazo acabando, avisos |

- **Véu de fundo:** `#000000D1` com `assets/content/ui/uibackgroundblur.mat`
  (`ui-preset-main-menu.ts:132-133`).
- **Fontes:** `RobotoCondensed-Bold.ttf` para títulos e botões, `RobotoCondensed-Regular.ttf`
  para o resto.
- **Título:** faixa com acento vermelho de 2 px, como o `titleBar` (`ui-widgets.ts:404`).
- **Raridade:** borda de 2 px na célula. As cores ficam a critério de quem desenhar; deixe-as
  numa tabela só no C#. `common` fica sem borda.

---

## 3. Layout

Tela cheia, na camada **`Overall`** (a mesma do menu principal), com `NeedsCursor`. Medidas
em proporção de **1280×720** (a base de `ui-geometry.ts:80`). Traduza para âncoras
(`AnchorMin`/`AnchorMax`) para escalar com a resolução.

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ▌SKINS                                 3 de 41 obtidas   [ só as minhas ]         ✕  │ 52
├───────────────────┬────────────────────────────────────┬─────────────────────────────┤
│ ▸ TODAS        41 │  ┌─────┐┌─────┐┌─────┐┌─────┐      │  ┌───────┐  AK BRASA        │
│ ▾ ARMAS        23 │  │ ▣   ││ ▣   ││ ▣🔒 ││ ▣🔒 │      │  │  ▣    │  AK-47 · Épica   │
│   ▣ AK-47   2/8   │  │Padr.││Brasa││Gelo ││Areia│      │  └───────┘  ● Obtida         │
│   ▣ L96     0/4   │  └─────┘└─────┘└─────┘└─────┘      │  Descrição da skin em até    │
│   ▣ MP5     1/3   │  ┌─────┐┌─────┐┌─────┐┌─────┐      │  três linhas…                │
│   ▣ Pistola 0/2   │  │     ││     ││     ││     │      │  Permanente                  │
│   ‹  1 / 2  ›     │  └─────┘└─────┘└─────┘└─────┘      ├─────────────────────────────┤
│ ▸ ROUPAS       12 │  ┌─────┐┌─────┐┌─────┐┌─────┐      │  APLICAR EM                  │
│ ▸ FERRAMENTAS   4 │  │     ││     ││     ││     │      │  ┌──┐ AK-47  barra 1  ▮▮▮▯ 30│
│ ▸ CONSTRUÇÃO    2 │  └─────┘└─────┘└─────┘└─────┘      │  └──┘ ● aplicada             │
│                   │      ‹ ANTERIOR   1 / 2   PRÓXIMA ›│  ┌──┐ AK-47  mochila  ▮▮▯▯ 0 │
│                   │  ┌──────────────────────────────┐  │  └──┘                        │
│                   │  │ Pesquisar skin…              │  │           ‹ 1 / 1 ›          │
│                   │  └──────────────────────────────┘  │  [        APLICAR          ] │
├───────────────────┴────────────────────────────────────┴─────────────────────────────┤
│ Aplicar não gasta a skin · Durabilidade, munição e conteúdo continuam iguais          │ 28
└──────────────────────────────────────────────────────────────────────────────────────┘
     210 px                         ~560 px                          ~430 px
```

### 3.1 Cabeçalho

- título **SKINS** com acento;
- contador "`N` de `M` obtidas" (considera só o que existe neste servidor);
- alternador **só as minhas** (filtra a grade e a lateral para posse + skins da casa);
- **✕** fecha. Repetir `/skins` com o menu aberto também fecha (o mesmo comportamento do menu
  principal, `OrigemZUI.cs:1072-1083`);
- se o `/streamer` do jogador está ligado, uma faixa âmbar: *"Modo streamer ligado: skins com
  logo ficam escondidas até você desligar."*

### 3.2 Barra lateral — categorias em sanfona

- **TODAS** no topo, e em seguida só as categorias **que têm alguma skin neste servidor**, na
  ordem da tabela abaixo. Cada linha mostra a contagem de skins.
- Clicar numa categoria **abre-a no lugar** e fecha a que estava aberta. Os itens aparecem
  embaixo dela, com ícone vanilla (`ItemId`, sem skin), nome e "obtidas/total".
- Categoria com mais itens do que cabem abre com **paginação própria** (`‹ 1 / 2 ›`) dentro da
  sanfona. Isso segue o modelo da coluna do ranking, que já pagina a própria lateral
  (`ui-ranking-screen.ts:779`).
- O item ativo é **painel** com acento, e não botão (o mesmo cuidado de
  `ui-ranking-screen.ts:1169`).

| `ItemCategory` | Rótulo |
|---|---|
| Weapon | ARMAS |
| Attire | ROUPAS |
| Tool | FERRAMENTAS |
| Construction | CONSTRUÇÃO |
| Items | ITENS |
| Traps | ARMADILHAS |
| Electrical | ELÉTRICA |
| Medical | MEDICAMENTOS |
| Ammunition | MUNIÇÃO |
| Resources | RECURSOS |
| Food | COMIDA |
| Fun | DIVERSÃO |
| Misc (e qualquer outra) | OUTROS |

`ItemCategory` MEDIDO no decompilado em 17/09/2026. `All`, `Common`, `Search` e `Favourite`
são categorias de tela do jogo, não de item, e não aparecem aqui.

### 3.3 Grade de skins

- **4 colunas × 3 linhas = 12 por página.** A **primeira célula da primeira página** é sempre
  **Padrão** (skin 0) do item ativo.
- Com **TODAS** ou com pesquisa, a grade mistura itens; a célula mostra o nome do item em
  segunda linha.
- Ordem: `sort` do catálogo, depois nome.
- Paginação: `‹ ANTERIOR  1 / 2  PRÓXIMA ›`; nas pontas, o botão fica apagado (`deadButton`,
  `ui-widgets.ts:237`).

**A célula:**

```text
┌────────────┐
│    ▣       │  ícone: CuiImageComponent { ItemId, SkinId } — o cliente desenha a arte
│   🔒       │  cadeado no canto, se bloqueada
│ Brasa      │  nome (1 linha, cortado)
│ Obtida     │  estado
└────────────┘
```

| Estado | Texto | Visual |
|---|---|---|
| aplicada no item selecionado em "Aplicar em" | **Aplicada** | fundo com acento, borda olive |
| possui | **Obtida** (ou **Expira em 3d**, em âmbar, se faltar ≤ 7 dias) | normal |
| skin da casa | **Grátis** | normal |
| não possui | **Bloqueada** | ícone esmaecido + cadeado |
| "não sei" (02 §5.3) | **Sincronizando** | cadeado cinza |
| skin 0 | **Padrão** | normal |

**Armadilha MEDIDA** (`ui-cui.ts:198`): `SkinId = 0` num item sem skins **derruba o jogador**.
Para a célula **Padrão**, omita o `SkinId`; não mande 0.

**Ícone esmaecido:** o `CuiImageComponent` aceita `Color`. Use um tom com alpha (por exemplo
`1 1 1 0.35`) e ponha o cadeado por cima.

> **Decidido na v0.3.0 (frente D, 17/09/2026): o cadeado é desenhado com três painéis** (arco,
> vão do arco e corpo). O `lock.png` não se confirma daqui: as DLLs do server01 citam só
> `assets/icons/close.png`, `device_add.png`, `embrella.png`, `explosion_sprite.png`,
> `facepunch.png` e `fun.png`, e os sprites moram nos bundles do cliente. Um sprite que não
> existe desenha um quadrado branco.
>
> **MEDIDO em 17/09/2026, com o dono no jogo: a medição 0.5 está encerrada, e o resultado é
> "não há sprite".** Os painéis ficam. O que a tela precisava de figura — os ícones do
> cabeçalho e a estrela — virou PNG nosso no `FileStorage` (§1).

> **Mudou na v0.4.0 (17/09/2026): a grade ROLA.** Medido no jogo, com o dono: a barra vertical
> aparece à direita e a grade rola sem derrubar o cliente (§8.1). O que isso muda aqui:
>
> - as **4 colunas** continuam, e as 3 linhas deixaram de ser o teto: a área rolável leva até
>   **48 células** por página (`ScrollPageSize`). Acima disso o paginador `‹ ANTERIOR 1 / 2
>   PRÓXIMA ›` volta a aparecer embaixo, porque cada célula custa ~2,3 KB e uma grade sem teto
>   num `AddUI` não foi medida;
> - a janela passou de 1200 para **1240 px** de largura: a barra cobria a quarta coluna;
> - quem desenha dentro da área deixa `ScrollGutter` (16 px) livre à direita, e `ScrollInset`
>   (2 px) em cima e embaixo — sem ele, a borda de seleção da primeira linha era recortada;
> - `origemz.skins.scroll 0` desliga a grade rolável (e a lateral) na hora, sem recarregar o
>   plugin, se algum cliente reclamar.
>
> A **célula da favorita** leva a estrela âmbar no canto de cima à esquerda, com a dica *"Favorita:
> ela aparece em FAVORITOS, no topo da lateral"*.

### 3.4 Pesquisa

- É um `InputField` abaixo da grade, com `needsKeyboard` (memória: *como o jogador digita dentro
  do menu*). O cliente anexa o texto cru ao comando:
  `origemz.skins.search <token> <texto…>`.
- Procura sem acento e sem diferença de maiúscula em três lugares: o `label` da skin, o
  `displayName` do item e o `shortname`.
- **Nome do item em pt-BR** (memória: *o servidor tem a tradução do jogo*): se o agente passar a
  mandar o nome traduzido no catálogo, a busca usa também. Não é pré-requisito.
- Com texto preenchido, a lateral marca **TODAS** e a grade mostra os resultados. Um **✕** no
  campo limpa.
- Mínimo de 2 caracteres; menos do que isso limpa o filtro.
- **Não há busca a cada tecla:** o texto chega quando o campo perde o foco ou quando o jogador
  aperta Enter. A pesquisa é o único ponto em que isso importa.

### 3.5 Detalhe da skin (direita, em cima)

Ícone grande, nome, item + raridade, estado e prazo, e a descrição (até 3 linhas). Se estiver
bloqueada: *"Disponível na loja: `storeUrl`"* (02 §5.1). **Sem link clicável**: o CUI não abre
navegador. Se faltar `storeUrl`, mostre só *"Disponível na loja do site"*.

> **A "Skin de temporada" (v0.4.0, 17/09/2026).** Entre o prazo e a descrição, uma linha em
> **âmbar**: *"Skin de temporada: pode sair da posse no próximo wipe"*. Ela aparece para
> **qualquer** acesso — quem ainda não a tem precisa saber disso **antes** de comprar. Na
> **célula** da grade, a mesma frase vira **dica** (tooltip), e ali **só para quem a possui**:
> numa skin da casa não há posse para sair, e numa bloqueada o aviso seria sobre algo que ele
> não tem. É informação, e só: nada no jogo muda por causa da marca (02 §4.6).

### 3.6 "Aplicar em" (direita, embaixo)

- Lista **as instâncias daquele item que o jogador tem**, na ordem: mão, barra, roupa,
  principal, e dentro da mochila vestida.
- Cada linha mostra: ícone com a skin atual, onde está ("barra 1", "roupa", "inventário",
  "mochila"), uma barra de condição (`condition / maxCondition`), munição no pente se for arma,
  e "aplicada" se já está com a skin escolhida.
- **4 linhas por página**, com paginação.
- **Pré-seleção:** o item da mão, se for desse shortname; senão, o primeiro da lista.
- **Nenhuma instância:** *"Você não tem um(a) `<item>` no inventário."* O botão fica apagado.
- **APLICAR** fica apagado quando a skin está bloqueada, já aplicada na linha escolhida, ou não
  há linha. O texto do botão acompanha: **APLICAR**, **JÁ APLICADA**, **BLOQUEADA**.
- **Depois de aplicar:** redesenha "Aplicar em" e a célula, e mostra por 2 s a faixa *"Skin
  aplicada."*.

**Por que não uma grade com o inventário inteiro**, como no protótipo: ela não ajuda a escolher
e custa caro. 37 casas com ícone são ~110 elementos, uns 43 KB pela régua da memória *quanto
custa um elemento do CUI*. A lista filtrada pelo item faz o mesmo trabalho com 4 linhas.

> **Mudou na v0.4.0 (17/09/2026): a lista ROLA.** O ScrollView foi medido no jogo (§8.1) e a
> mesma receita vale aqui. A área continua do tamanho de **4 linhas** — é o espaço que existe
> embaixo do detalhe —, e o que passa disso se alcança rolando, até **40 alvos**
> (`TargetsScrollMax`) de uma vez. O paginador só aparece quando a rolagem está desligada
> (`origemz.skins.scroll 0`), e aí valem as 4 linhas por página desta seção. A barra
> auto-esconde: com 4 alvos ou menos, não há barra na tela. As medidas de folga são as do
> §3.3 (`ScrollGutter` e `ScrollInset`).

#### A variante de DLC/loja na lista (v0.5.0)

A lista passa a incluir as **variantes de DLC/loja** do item — a Crystal Assault Rifle Diamond
(`rifle.ak.glass`) aparece quando a skin escolhida é de `rifle.ak`. A regra e o porquê estão em
**02 §6.4**; aqui é só o que a tela faz.

- **O lugar ganha o sufixo " · variante"**: "Barra 3 · variante", "Inventário · variante". A
  cor do lugar continua a mesma (o `WhereColor` olha o prefixo), e o rótulo passou de 160 para
  200 px de largura para "Inventário · variante" caber sem cortar.
- **O ícone continua o do item real** — a arte da variante, não a da base. O jogador precisa
  reconhecer no menu a arma que está vendo no inventário.
- **Uma variante nunca sai "aplicada"**, em nenhuma linha e em nenhuma célula da grade, nem com
  o **Padrão** escolhido: o visual dela é a definição do item, não o campo `skin`. Por isso o
  botão continua **APLICAR** (e não **JÁ APLICADA**) — é o caminho de volta para a arma
  original.
- **Sem pré-seleção de skin** quando o provável alvo é uma variante: a escolha fica no
  **Padrão**, que é justamente a troca que ela precisa oferecer.
- **Depois de aplicar numa variante** a faixa diz o que aconteceu com o item, porque a
  definição dele mudou: *"Visual padrão aplicado: o item voltou a ser um(a) Assault Rifle."* ou
  *"Skin aplicada: o item passou a ser um(a) Assault Rifle."*.
- **Se a conversão não conseguir devolver o item ao lugar de antes**, a faixa recusa sem perder
  nada: *"O item foi convertido, mas não voltou para o lugar de antes: confira o inventário e
  aplique de novo."*

#### Roteiro de teste ao vivo — a variante (v0.5.0)

Nada disso dá para provar sem cliente: o menu é CUI e a conversão mexe em item de verdade. O
roteiro abaixo é o que fecha os oito critérios de aceite de **02 §6.4**.

Preparação: uma skin de `rifle.ak` **na posse** do jogador de teste (não vale admin — o
privilégio está desligado, 02 §3), uma variante de AK (`rifle.ak.glass` ou outra das 9) e uma
AK padrão no inventário ao mesmo tempo.

| # | O que fazer | O que tem de acontecer | Critério |
|---|---|---|---|
| 1 | Com a variante no inventário, abrir o menu e escolher a skin de `rifle.ak` | a variante aparece no "Aplicar em", com " · variante" no lugar e o ícone da Crystal Diamond | 1 |
| 2 | Escolher a linha da variante e a célula **Padrão** | o botão fica **APLICAR** (não "JÁ APLICADA"); aplicar devolve uma **Assault Rifle** comum | 2 |
| 3 | Repetir com uma **skin** em vez do Padrão | a arma vira AK com a skin escolhida | 2 |
| 4 | Antes de converter, deixar a arma com condição parcial, pente cheio de um tipo de munição escolhido e um acessório (mira/silenciador) | depois da troca: mesma condição, **mesmo tipo** e **mesma quantidade** de munição, acessório no lugar | 3 |
| 5 | Fechar o menu, deslogar e reconectar | o item continua o convertido, com tudo do passo 4 | 4 |
| 6 | Com a AK padrão **e** a variante no inventário, aplicar na variante | só a variante muda; a AK padrão fica intacta, na posição dela | 5 |
| 7 | Repetir o 2 com a arma **na mão** | a mão não fica vazia nem com o modelo antigo; o jogador segue segurando a arma convertida | 3 |
| 8 | Repetir o 2 com a variante **dentro de uma mochila vestida** | o item volta para a mochila, na mesma casa | 3 |
| 9 | Repetir o 2 com uma variante **de outra categoria** (roupa, capacete) | o mesmo comportamento; a peça vestida continua vestida | 6 |
| 10 | Tentar aplicar numa variante cuja base não aceita skin do Workshop | recusa clara, e o item **não** é convertido | 7 |
| 11 | Tentar aplicar uma skin **bloqueada** (sem posse) numa variante | recusa "Você ainda não tem esta skin"; nada é convertido | 8 |
| 12 | Com o `/streamer` ligado, aplicar numa variante uma skin com `hideInStreamer` | converte, o item fica com skin 0 e a faixa diz que a skin aparece ao desligar; desligar o modo veste a skin no item **novo** | 8 |

---

## 4. Como o menu abre

| Entrada | Pré-seleção |
|---|---|
| `/skins`, `/skin` | categoria e item **do que está na mão**, se aceita skin e tem alguma no catálogo; senão, TODAS |
| `/skin <palavra>` | pesquisa preenchida com a palavra (02 §7) |
| aba **SKINS** do menu principal | igual ao `/skins` |
| botão no inventário | igual ao `/skins` — **A MEDIR** (§8) |

**O item "selecionado no inventário" o servidor não vê.** A seleção de casa no inventário é
estado do cliente: não chega RPC nenhum ao servidor quando o jogador clica numa casa. O que o
servidor sabe é o **item ativo** (`player.GetActiveItem()`), o da mão. É esse que pré-seleciona.

### 4.1 O botão no inventário

A ideia é um botão pequeno **SKINS** pendurado na camada **`Inventory`** do cliente. A memória
*a camada do CUI só o cliente resolve* diz que `Inventory` **some quando o inventário fecha**,
e é exatamente o que se quer aqui. O plugin o adiciona quando o jogador conecta e quando
renasce, e o cliente o mostra só com o inventário aberto.

- O `UI_LAYERS` do agente (`core/src/types/ui-document.ts:82`) **não oferece `Inventory` de
  propósito**, mas isso vale para o editor de telas. Um elemento desenhado pelo plugin em C# não
  passa por ali.
- **Posição:** livre de sobrepor os botões do jogo (CLÃ, CONTATOS, INVENTÁRIO no topo da tela de
  inventário/crafting). Precisa ser vista no cliente.
- **A MEDIR** (§8): se o elemento sobrevive a abrir e fechar o inventário várias vezes, e se o
  clique funciona com o cursor do inventário.

**Se a camada `Inventory` não servir**, a alternativa é não ter botão: o `/skins` e a aba do
menu cobrem o caso. **Não pendure o botão em `Hud`/`Overlay`**, porque ele ficaria na tela o
tempo todo.

> **Na v0.3.0 o botão está implementado, mas vem desligado.** Ele fica atrás de
> `"InventoryButton": false` em `oxide/config/OrigemZWorkshop.json`, até a medição 0.2 ser
> feita. Ligado, ele é desenhado:
> - em `OnServerInitialized`, para os online;
> - 3 s depois de `OnPlayerConnected`;
> - em `OnPlayerRespawned`.
>
> O elemento se chama `OZSkins.InvBtn` e leva `destroyUi` com o próprio nome. O comando é
> `origemz.skins.open`. A posição é estimada: ancorado no pé da tela, centro, em
> `-572 18` → `-482 46`, à esquerda da barra. Ela fica na config
> (`InventoryButtonOffsetMin`/`InventoryButtonOffsetMax`), para ser ajustada sem mexer no
> código.

---

## 5. Os comandos da tela

Todos com o **token da sessão** do jogador, gerado ao abrir e descartado ao fechar, como o
`origemz.ui.act` do `OrigemZUI`. Comando com token errado é ignorado **em silêncio**.

| Comando | Argumentos |
|---|---|
| `origemz.skins.close` | `token` |
| `origemz.skins.cat` | `token categoria [página]` |
| `origemz.skins.item` | `token shortname` |
| `origemz.skins.page` | `token página` |
| `origemz.skins.pick` | `token idDaSkin` (0 = Padrão) |
| `origemz.skins.target` | `token uidDoItem` |
| `origemz.skins.targets` | `token página` |
| `origemz.skins.mine` | `token 0\|1` |
| `origemz.skins.search` | `token texto…` (texto cru, remontado com `GetString`, como o `RestOfLine` do `OrigemZUI.cs:2470`) |
| `origemz.skins.apply` | `token` (aplica a skin escolhida na instância escolhida) |

**Acrescentados na v0.3.0:**

| Comando | Argumentos | Por quê |
|---|---|---|
| `origemz.skins.open` | nenhum | o botão do inventário (§4.1). Não tem token porque é a abertura que cria o token |
| `origemz.skins.close` | `token` **opcional** | fechar a própria tela é sempre seguro, e é a saída de quem ficou com o menu preso (pelo F1) |
| `origemz.skins.search` | só o `token` | limpa a pesquisa. É o que o **X** do campo manda |
| `origemz.skins.bytes` | nenhum | só servidor/RCON ou admin: mede o pior caso de cada região (§6) |

No `origemz.skins.cat`, a categoria `all` é TODAS. Com `página`, e a categoria já aberta, só a
lateral muda.

- São `[ConsoleCommand]` chamados **pelo cliente**, então `arg.Connection` **não** é nulo.
  Esse é o inverso dos comandos do agente, que recusam conexão. Se o plugin continuar como
  `RustPlugin`, `[ConsoleCommand]` funciona (memória: *[ConsoleCommand] não funciona em
  CovalencePlugin*).
- **Nenhum argumento é confiável.** O `uid` do alvo passa pela conferência do 02 §6.2; a skin
  passa pelo §3 do 02.
- **O estado da tela mora no plugin**, por jogador: categoria, página da lateral, item, página
  da grade, skin, alvo, filtro e pesquisa. Os comandos só mudam esse estado e pedem o redesenho.

**Acrescentados na v0.4.0 (17/09/2026):**

| Comando | Argumentos | Por quê |
|---|---|---|
| `origemz.skins.fav` | `token idDaSkin` | marca e desmarca a favorita (a nota abaixo) |
| `origemz.skins.sort` | `token 0\|1` | a ordem da grade: `0` é a do catálogo, `1` é por raridade (Lendária primeiro). É o par de ícones do cabeçalho, ao lado do "só as minhas" |
| `origemz.skins.scroll` | `0\|1` (opcional) | liga e desliga a grade **e** a lateral roláveis na hora, grava na config e redesenha quem estiver com o menu aberto. Sem argumento, só responde o estado. **Não tem token:** é servidor, RCON ou admin, e é a saída se o ScrollView der problema em algum cliente |

O `sort` e o `mine` viraram **só ícone** no cabeçalho, com a dica no mouse (pedido do dono em
17/09/2026): os dois alternadores escritos ocupavam a faixa inteira.

> **Mudou na v0.4.0: `origemz.skins.fav` (17/09/2026).** Os argumentos são os mesmos
> (`token idDaSkin`), mas a favorita deixou de ser do plugin: ela é **do agente**, e vale na
> **rede** (02 §4.5). O comando agora:
>
> 1. muda o conjunto em memória e redesenha **na hora** (otimista: a tela tem de responder no
>    mesmo frame);
> 2. grita `#OZWORKSHOP#{"kind":"fav",…,"on":true|false}` para o agente (02 §5.4);
> 3. **não grava o `favorites.json`** — quem o reescreve é a chegada de uma carga.
>
> O agente grava e reenvia a posse+favoritas, e **essa carga é a verdade**. No teto de 200 o
> plugin mostra a frase na faixa de "Aplicar em" e não grita; se o **agente** recusar, a carga
> forçada que volta desfaz o otimismo.

---

## 6. Desenho por regiões

A tela tem **cinco regiões**, cada uma com um `CuiPanel` raiz de **nome fixo**:

```text
OZSkins            (a janela: véu, moldura, cabeçalho, rodapé)   — desenhada ao abrir
OZSkins.Side       (lateral)                                     — muda com cat/página da lateral/filtro
OZSkins.Grid       (grade + paginação + pesquisa)                — muda com item/página/filtro/pesquisa/aplicar
OZSkins.Detail     (detalhe)                                     — muda com pick
OZSkins.Targets    (aplicar em + botão)                          — muda com pick/target/aplicar
```

Cada comando destrói e redesenha **só as regiões afetadas**: `DestroyUI` da raiz da região e
depois `AddUI`. Abrir desenha as cinco.

**Estimativa**, pela régua de ~390 bytes por elemento:

| Região | Elementos (aprox.) | Bytes |
|---|---|---|
| Janela | 15 | ~6 KB |
| Lateral (1 categoria aberta, 8 itens) | 45 | ~18 KB |
| Grade (12 células × 4 + paginação + busca) | 60 | ~23 KB |
| Detalhe | 10 | ~4 KB |
| Aplicar em (4 linhas × 6 + paginação + botão) | 30 | ~12 KB |
| **Abrir (tudo)** | **~160** | **~63 KB** |

**Cuidado com a abertura:** ~63 KB num `AddUI` só é mais do que o frame que o projeto já mediu
como seguro para o transporte do agente (50.000). Aqui o caminho é outro (o RPC do servidor
direto para o cliente, sem RCON). **Ele foi medido no jogo em 17/09/2026 e aguenta: a abertura
sai em três envios de ~30, 32 e 8 KB** (§8.4). O teto curto abaixo continua valendo por decisão,
e não por desconhecimento. Por isso, **abra em dois `AddUI`**:
janela, lateral e detalhe num; grade e "Aplicar em" no outro, no mesmo frame. Cada um fica
abaixo de 40 KB. O teste do plano (05) mede os bytes de cada região com um helper que
serializa o `CuiElementContainer`.

### 6.1 Como ficou na v0.3.0 (frente D, 17/09/2026)

**São seis regiões, e não cinco.** A parte **viva** do cabeçalho virou `OZSkins.Head`: o
contador "N de M obtidas", o alternador "só as minhas" e a faixa do modo streamer. O contador
muda quando a posse chega, e sem essa separação a janela inteira teria de ser redesenhada por
causa dele.

```text
OZSkins            véu (Overall, NeedsCursor)        — só na abertura
OZSkins.Win        janela 1200×640, título, X, rodapé, divisórias
OZSkins.Head       contador, "só as minhas", faixa do streamer
OZSkins.Side / .Grid / .Detail / .Targets            — como acima
```

- Cada raiz de região leva **`destroyUi` com o próprio nome**: o cliente troca a velha pela nova
  no mesmo RPC, sem `DestroyUI` à parte e sem piscar. O agente já usa esse campo em produção
  (`ui-cui.ts:436`).
- A raiz do `Head` cobre só a faixa entre o título e o **X**. A raiz de uma região bloqueia
  clique onde está, e uma raiz redesenhada vai para cima das irmãs.
- Só recebe **nome** o elemento que tem filho. Os outros vão sem nome, e isso economiza bytes.
- A abertura vai nos **dois `AddUI`** desta seção: janela + cabeçalho + lateral + detalhe, e
  depois grade + "aplicar em". Os redesenhos parciais usam os mesmos dois grupos, e um grupo
  que passe de 40.000 bytes é quebrado em mais de um.
- A lateral pagina a categoria aberta com **3 a 8 itens por página**. O número depende de
  quantas categorias aparecem, para tudo caber nos 560 px sem ScrollView.

**Medido** em 17/09/2026, fora do servidor. O `OrigemZWorkshop.MeasureWorstCase()` (o mesmo
código do `origemz.skins.bytes`) foi compilado com as DLLs do server01 num executável net48 e
rodado. O cenário é o pior caso: as 13 categorias à mostra com a primeira aberta e 8 itens de
nome longo, 12 células lendárias, bloqueadas e de grade misturada, pesquisa de 37
caracteres, descrição de 280 caracteres e 4 alvos com condição, munição e "Aplicada".

| Região | Bytes |
|---|---|
| Janela | 2.821 |
| Cabeçalho | 1.327 |
| Lateral | 20.519 |
| Grade | 27.779 |
| Detalhe | 2.834 |
| Aplicar em | 8.318 |
| **1º `AddUI` da abertura** | **27.498** |
| **2º `AddUI` da abertura** | **36.096** |

Todas as regiões ficam abaixo de 40 KB. **O `AddUI` de ~36 KB direto pelo plugin continua sendo
a medição 0.4** (§8).

---

## 7. Casos da tela

| Situação | Comportamento |
|---|---|
| jogador morre, cai ferido ou desconecta com o menu aberto | fecha o menu e descarta a sessão (`OnPlayerDeath`, `OnPlayerWound`, `OnPlayerDisconnected`) |
| plugin descarregado | `DestroyUI` de `OZSkins` e do botão do inventário para todos os online |
| catálogo novo chega com o menu aberto | redesenha as cinco regiões; se a skin ou o item escolhido sumiram, volta para TODAS |
| posse nova chega com o menu aberto | redesenha lateral, grade e detalhe (a skin pode ter perdido o cadeado agora mesmo — **é o momento em que o jogador comprou no site e está olhando**) |
| o item escolhido em "Aplicar em" sumiu (largou, trocou, usou) | na hora de aplicar, recusa com *"Esse item não está mais com você."* e redesenha a lista |
| o jogador abre o menu principal | o `OrigemZUI` (0.1.1) chama `CloseSkinsMenu` antes de desenhar: o de skins fecha e o principal abre. Ao abrir o de skins, o `OrigemZWorkshop` chama `CloseMainMenu`. **Um aberto por vez**, nos dois sentidos (§7.1 e §7.2) |

### 7.1 A ligação com o `OrigemZUI`, na v0.3.0

O `OrigemZWorkshop` expõe dois hooks públicos:

| Hook | Para quê |
|---|---|
| `void CloseSkinsMenu(BasePlayer player)` | fecha o menu de skins e descarta a sessão. **É o que a frente F deve chamar** quando o menu principal abre: `Interface.CallHook("CloseSkinsMenu", player)` |
| `bool IsSkinsMenuOpen(BasePlayer player)` | diz se o menu de skins está aberto |

**O outro sentido.** Ao abrir, o menu de skins chama primeiro `CloseMainMenu(BasePlayer)` no
`OrigemZUI`. Se a chamada devolver nulo (um `OrigemZUI` anterior à 0.1.1), ele roda o
`origemz.ui.close <steamId>` de servidor, com `Option.Server.Quiet()`. Esse comando destrói a
raiz pelo nome e descarta a sessão do menu principal.

Morte, ferimento e desconexão fecham o menu (`OnPlayerDeath`, `OnPlayerWound`,
`OnPlayerDisconnected`). O `Unload` destrói `OZSkins` e o botão do inventário para todos os
online, e grava a posse pendente. Sem a caixa não existe item "emprestado": nada precisa ser
devolvido.

### 7.2 O lado do `OrigemZUI` — feito na frente F (v0.1.1, 17/09/2026)

| Peça | O que faz |
|---|---|
| `bool CloseMainMenu(BasePlayer player)` (`[HookMethod]`, público) | se há sessão do menu principal, roda o mesmo `Close` do botão de fechar (destrói a raiz e o aviso de carregando, descarta a sessão) e devolve `true`; sem menu aberto, não faz nada e devolve `false`. **Nunca devolve nulo**: o Workshop lê nulo como "hook inexistente" e cairia no comando de console. Não chama o `CloseSkinsMenu` de volta |
| `[PluginReference] Plugin OrigemZWorkshop` | dependência mole, como a do `OrigemZImages`: sem o plugin, nada é chamado e o menu abre igual |
| `Open(...)` | na **abertura** (quando o shell ainda não foi desenhado), chama `OrigemZWorkshop.Call("CloseSkinsMenu", player)` antes de desenhar. Não chama a cada troca de aba. Sem log: o `Open` roda dentro do handler de comando, e o que se imprime ali entra na resposta (memória: *o Puts entra na resposta do comando*) |

**O caminho da aba SKINS, de ponta a ponta:** clique → `origemz.ui.act` → ação `chat` → o
`OrigemZUI` manda `chat.say /skins` **como o jogador** → o `/skins` do Workshop abre o menu
dele → `CloseMainMenu` fecha o principal. O comando da ação leva a barra: sem ela, a palavra
sairia no chat como mensagem.

**O menu já gravado recebe a aba no boot** (`withSkinsTab`, chamado em `core/src/index.ts`
junto dos outros upgrades de documento). Como a aba não tem tela, o marcador de "já passou" é o
próprio botão: o id `nav-skins` **ou** qualquer botão com ação `chat` para `/skins` (o que
respeita a aba renomeada no editor). Onde ela entra: depois de KITS; sem KITS, antes do
DISCORD/CONFIG; sem nenhum deles, no fim da barra. **Limitação conhecida:** o admin que apagar
a aba a vê voltar no boot seguinte, porque o documento não tem campo para marcar "migração
feita". Para escondê-la, troque o comando do botão em vez de apagá-lo. Nenhuma migração de
banco foi criada.

---

## 8. A fase 0 — o que foi medido no jogo, e o que falta

**Medido em 17/09/2026, com o dono conectado no server01, contra o `OrigemZWorkshop` 0.4.0.**
Quatro dos seis itens estão fechados; **dois continuam abertos** (3 e 6), e nenhum código
depende deles.

| # | O quê | Situação |
|---|---|---|
| 1 | ScrollView | **FUNCIONA** (17/09/2026) |
| 2 | botão na camada `Inventory` | **FUNCIONA** (17/09/2026) |
| 3 | roupa e mochila vestidas vistas por OUTRO jogador | **PENDENTE** |
| 4 | `AddUI` grande direto pelo plugin | **FUNCIONA** (17/09/2026) |
| 5 | o sprite do cadeado | **ENCERRADO: não há sprite** (17/09/2026) |
| 6 | a janela em 21:9 | **PENDENTE** |

### 8.1 ScrollView — funciona

A grade rolou **90 células** com a barra vertical à direita, e o cliente **não caiu**. O
`RPC Error in AddUI` do projeto anterior (`core/src/types/ui-document.ts:23-36`) não voltou, e
o que mudou foi a receita, não o cliente: ela está no `ScrollArea` do `Plugins/OrigemZWorkshop.cs`
e é o que deve ser copiado em qualquer outra tela.

- `CuiScrollViewComponent` do Oxide 2.0.7716, com o `contentTransform` **completo**: o conteúdo
  ancorado no topo e crescendo para baixo por **âncora mínima negativa** (uma fração da área
  visível, para tudo continuar relativo), e `OffsetMin`/`OffsetMax` em `"0 0"`.
- `verticalScrollbar` presente, **com as cores** (alça, destaque, pressionado e trilha). Foi
  emitido junto desde a primeira tentativa; não se mediu se ele é obrigatório.
- `MovementType = Clamped`, com inércia.

**Duas armadilhas, as duas medidas na tela:**

1. **A barra ocupa a borda direita da área**, por cima do que estiver ali. Ela cobria a quarta
   coluna de células, e a janela teve de crescer de 1200 para 1240 px. Quem desenha dentro de
   uma área rolável reserva `ScrollGutter` (16 px) à direita.
2. **O conteúdo é recortado na borda**, e a borda de seleção (2 px) da primeira linha sumia. Daí
   o `ScrollInset` (2 px) no topo e no pé do conteúdo.

**Onde vale:** na **grade** (§3.3), na **lateral** (§3.2) e no **"Aplicar em"** (§3.6) — as três
usam o mesmo `ScrollArea`. A grade guarda um teto de 48 células por página, e o "Aplicar em" de
40 alvos, por causa dos bytes, e não do ScrollView. O `origemz.skins.scroll 0` desliga tudo na
hora se algum outro cliente reclamar.

### 8.2 O botão na camada `Inventory` — funciona

O `OZSkins.InvBtn` aparece **só com o inventário aberto** — a camada `Inventory` é do cliente e
some quando ele fecha —, e o **clique abre o menu** com o cursor do inventário. Ele sobrevive a
abrir e fechar o inventário.

Está ligado por config (`"InventoryButton"` em `oxide/config/OrigemZWorkshop.json`), e o lugar é
**ao lado do botão MISSÕES do próprio jogo**, no alto à esquerda, da mesma altura — pedido do
dono. As quatro âncoras ficam na config
(`InventoryButtonAnchorMin`/`Max`, `InventoryButtonOffsetMin`/`Max`), para o encavalamento se
resolver sem mexer no código.

### 8.3 Roupa e mochila vestidas, vistas por outro jogador — PENDENTE

Só a **arma na mão** foi vista, e pelo **próprio dono**. Falta o que o item 0.3 do
[05](05-PLANO-E-FRENTES.md) §2 pede de verdade: a **roupa** e a **mochila vestidas** trocando de
skin no lugar, **olhadas por um segundo jogador**. Sem um segundo cliente na hora, não se mediu —
e não se deduz. Fica aberto.

### 8.4 `AddUI` grande direto pelo plugin — funciona

A abertura sai em **três envios**, de cerca de **30, 32 e 8 KB**, e a tela chega inteira. Quem
divide é o `Pack`, com teto de 40.000 bytes por `AddUI` (`AddUiByteLimit`); a grade rolável, com
mais células, é o que fez o segundo grupo estourar e virar dois. O caminho é o RPC do servidor
direto para o cliente, sem RCON, e ele **não** tem o teto de 50.000 do transporte do agente.

Quem mede é o `origemz.skins.bytes`: ele monta cada região no pior caso e responde o tamanho de
cada uma e dos grupos da abertura, **com o mesmo código do `Redraw`** — por isso o número dele é
o número que vai pela rede. A tabela do §6.1 é a leitura anterior, de antes da grade rolável.

### 8.5 O sprite do cadeado — encerrado, e a resposta é "não há"

Nenhum sprite do jogo foi confirmado: os bundles do servidor são compactados, e um caminho que
não existe desenha um quadrado branco. O cadeado continua desenhado com **três painéis** (§3.3),
e o resto do que a tela precisava de figura — os cinco ícones do cabeçalho e a estrela das
favoritas — é **PNG nosso**, de `Assets/menu-icons/`, guardado no `FileStorage` no boot e pedido
pelo CRC (§1).

### 8.6 A janela em 21:9 — PENDENTE

A janela é toda em âncoras relativas (`AnchorMin`/`AnchorMax` com margem, nunca tamanho fixo), e
em **16:9** ela está certa na tela do dono. **21:9 não foi olhado.** Fica aberto.

---

A régua para conferir sem abrir o jogo continua sendo o console (memória: *como validar mudança
de menu sem abrir o jogo*). Mas o que falta (3 e 6) **só se confirma olhando a tela**, e isso é
com o dono — o 3 precisa de um segundo jogador, e o 6, de um monitor ultrawide.
