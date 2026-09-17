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

**Como o menu principal chega aqui:** uma aba **SKINS** no `ui-preset-main-menu.ts` com ação
`chat` → `/skins`. O menu principal fecha e este abre. Custa cerca de 970 bytes na carga
inicial (memória: *onde estão os bytes do menu*); confira que a carga continua abaixo de
50.000.

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
`1 1 1 0.35`) e ponha o cadeado por cima. O cadeado sai de um sprite do jogo (por exemplo
`assets/icons/lock.png`). **A MEDIR:** o caminho exato do sprite.

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

- São `[ConsoleCommand]` chamados **pelo cliente**, então `arg.Connection` **não** é nulo.
  Esse é o inverso dos comandos do agente, que recusam conexão. Se o plugin continuar como
  `RustPlugin`, `[ConsoleCommand]` funciona (memória: *[ConsoleCommand] não funciona em
  CovalencePlugin*).
- **Nenhum argumento é confiável.** O `uid` do alvo passa pela conferência do 02 §6.2; a skin
  passa pelo §3 do 02.
- **O estado da tela mora no plugin**, por jogador: categoria, página da lateral, item, página
  da grade, skin, alvo, filtro e pesquisa. Os comandos só mudam esse estado e pedem o redesenho.

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
direto para o cliente, sem RCON), mas **não foi medido**. Por isso, **abra em dois `AddUI`**:
janela, lateral e detalhe num; grade e "Aplicar em" no outro, no mesmo frame. Cada um fica
abaixo de 40 KB. O teste do plano (05) mede os bytes de cada região com um helper que
serializa o `CuiElementContainer`.

---

## 7. Casos da tela

| Situação | Comportamento |
|---|---|
| jogador morre, cai ferido ou desconecta com o menu aberto | fecha o menu e descarta a sessão (`OnPlayerDeath`, `OnPlayerWound`, `OnPlayerDisconnected`) |
| plugin descarregado | `DestroyUI` de `OZSkins` e do botão do inventário para todos os online |
| catálogo novo chega com o menu aberto | redesenha as cinco regiões; se a skin ou o item escolhido sumiram, volta para TODAS |
| posse nova chega com o menu aberto | redesenha lateral, grade e detalhe (a skin pode ter perdido o cadeado agora mesmo — **é o momento em que o jogador comprou no site e está olhando**) |
| o item escolhido em "Aplicar em" sumiu (largou, trocou, usou) | na hora de aplicar, recusa com *"Esse item não está mais com você."* e redesenha a lista |
| o jogador abre o menu principal | o `OrigemZUI` desenha por cima em `Overall`. **Feche o de skins** ao receber `/menu`, por um hook chamado pelo `OrigemZUI` ou por conferência simples: ao abrir um, o outro fecha |

---

## 8. A MEDIR na fase 0 (com um cliente de verdade)

1. **ScrollView.** O `Oxide.Rust.dll` 2.0.7716 do server01 traz `CuiScrollViewComponent`
   (`"UnityEngine.UI.ScrollView"`, com `contentTransform`, `vertical`, `movementType`,
   `verticalScrollbar`, etc.), `CuiScrollbar` e `CuiMaskComponent`. MEDIDO por decompilação em
   17/09/2026.
   - **Mas o projeto anterior derrubou o jogador** com `RPC Error in AddUI` ao emiti-lo
     (`core/src/types/ui-document.ts:23-36`), sem saber o que o cliente exigia junto.
   - O teste: plugin descartável, **só com o admin conectado**, emitindo o componente como o
     `CuiScrollViewComponent` do Oxide serializa. Isso inclui `contentTransform` completo e uma
     barra.
   - **Se passar:** a lateral e o "Aplicar em" podem rolar em vez de paginar. A grade continua
     paginada, porque foi pedida assim e é a região mais cara.
   - **Se falhar:** registre o JSON exato e o erro no comentário do `ui-document.ts`. Tudo
     continua paginado, e este documento já funciona assim.
2. **O botão na camada `Inventory`** (§4.1).
3. **Os três visuais do 02 §6.3:** roupa vestida, mochila vestida e arma na mão.
4. **`AddUI` de ~40 KB** direto pelo plugin (§6).
5. **O sprite do cadeado** (§3.3).
6. **A posição da tela** em 16:9 e em 21:9. Âncoras relativas bastam? A janela deve ter
   `AnchorMin`/`AnchorMax` com margem, não tamanho fixo.

A régua para conferir sem abrir o jogo continua sendo o console (memória: *como validar mudança
de menu sem abrir o jogo*). Mas os itens 1 a 3 **só se confirmam olhando a tela**, e isso é
com o dono.
