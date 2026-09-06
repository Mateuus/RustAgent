# TROFÉU BLEIK STORE — o item que vira ponto

> **O que este documento é.** A especificação detalhada do Troféu Bleik Store:
> o que é o item dentro do Rust, como ele vira ponto, onde o ponto é guardado,
> de onde os troféus saem, o que impede que a conta seja fraudada e como a
> temporada é premiada. Ele parte do briefing do dono (§0, preservado palavra
> por palavra) e o traduz em decisões técnicas, contratos e um plano em fatias.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. **Nada
> disto existe na árvore hoje** — nem o item, nem a métrica, nem a dungeon, nem
> a missão diária. O que existe e vai ser reaproveitado está marcado como
> *medido* no §12; o resto é projeto.
>
> **Duas pendências vivas, para quem ler isto depois.**
> **(1)** A arte da medalha já existe —
> [`trofeu_bleik_store.png`](trofeu_bleik_store.png), nesta pasta — mas falta a
> versão de interface (§2.5).
> **(2)** Um **sistema de item custom** está sendo construído por outro agente
> em [`Docs/CustomItem/`](../CustomItem/); a pasta estava **vazia** em
> 05/09/2026. Quando o documento dele existir, **o §2 deste arquivo deve ser
> revisto** — e possivelmente a recomendação de item base muda. Nada de §3 em
> diante depende dessa escolha.
>
> **A quem ele se liga.** O troféu **não é um sistema de ranking novo** — é uma
> **métrica** dentro do ranking desenhado em
> [`Docs/Ranking/19-PESQUISA-RANKING.md`](../Ranking/19-PESQUISA-RANKING.md).
> Toda vez que este documento diz "o contador", "o período" ou "o lote", ele
> está falando de peças que aquele documento já desenhou. As referências
> aparecem como **[R§9]**, **[R§12]**, **[R§13]** — a seção correspondente da
> pesquisa de ranking.

---

## Índice

| § | Assunto |
|---|---|
| [0](#0--o-briefing-original) | O briefing original, preservado |
| [1](#1--sumário-executivo) | Sumário executivo: a leitura em uma página |
| [2](#2--o-item-físico) | O item físico: o que o Rust permite |
| [3](#3--a-conversão-do-item-ao-ponto) | A conversão: do item ao ponto |
| [4](#4--o-contrato-agente--plugin) | O contrato agente ↔ plugin |
| [5](#5--o-modelo-de-dados) | O modelo de dados |
| [6](#6--as-fontes-de-troféu) | As fontes de troféu |
| [7](#7--a-economia-da-temporada) | A economia da temporada |
| [8](#8--anti-abuso) | Anti-abuso |
| [9](#9--a-premiação) | A premiação |
| [10](#10--a-api-e-as-telas) | A API e as telas |
| [11](#11--plano-de-implementação) | Plano de implementação |
| [12](#12--medido-conferido-projeto) | Medido, conferido, projeto |
| [13](#13--perguntas-em-aberto-para-o-dono) | Perguntas em aberto para o dono |

---

## 0 — O briefing original

> Preservado sem edição. É a fonte; tudo que vem depois é leitura dela.

### 🏆 TROFÉU BLEIK STORE

O ideal é que o troféu seja um objeto físico em 3D.
O objeto deve possuir a logo da Bleik Store.
Nome do item: Troféu Bleik Store.
O item será stackável, com limite de 5 unidades por stack.

### 📊 SISTEMA DE RANKING

Ao obter um Troféu Bleik Store:

- O troféu será automaticamente removido do jogador.
- Cada troféu será convertido diretamente em pontos no ranking.
- 1 Troféu = 1 Ponto.
- Após contabilizado, o ponto será permanente e não poderá ser perdido.
- O jogador não poderá guardar, dropar ou transferir o troféu para outro
  jogador/local.
- O ranking será atualizado e poderá ser acompanhado diretamente pelo site.

Dessa forma, o item físico servirá apenas para representar a conquista antes de
ser convertido automaticamente em pontuação.

### 🎯 FORMAS DE CONSEGUIR TROFÉUS

**Eventos gerais do Rust.** Eventos e atividades já existentes poderão entregar
1 Troféu Bleik Store por vez. Exemplos: Airdrop, Monumentos, Keycards, outros
eventos relevantes do servidor.

**📋 Missões Diárias.** A ideia é disponibilizar entre 2 e 3 missões diárias,
dependendo das possibilidades do sistema. Cada missão concluída poderá entregar
🏆 1 Troféu Bleik Store.

**⚔️ Dungeon Bleik Store.** Será uma das principais formas de conquistar
troféus e o grande diferencial do sistema. Ao completar a Dungeon: mínimo 3
troféus, máximo 5 troféus.

**☢️ Spawn extremamente raro.** Caso seja tecnicamente possível, o Troféu Bleik
Store também poderá aparecer de forma extremamente rara em áreas de alto risco
do mapa. A intenção é criar aquele momento de surpresa onde o jogador encontra
um troféu durante a exploração, mas sem transformar essa mecânica em uma fonte
constante de pontos.

### 🎁 PREMIAÇÃO DO RANKING

Ao final da temporada:

- 🥇 **TOP 1** — Skin no valor de R$ XX + 5.000 OZCoins
- 🥈 **TOP 2** — VIP + 3.000 OZCoins
- 🥉 **TOP 3** — 2.000 OZCoins
- 🏅 **TOP 4 ao TOP 10** — 1.000 OZCoins

O objetivo é fazer com que os troféus incentivem os jogadores a participarem de
diferentes conteúdos do servidor durante toda a temporada, enquanto a Dungeon
Bleik Store permanece como uma das atividades mais importantes para quem quiser
disputar as primeiras posições.

---

## 1 — Sumário executivo

### 1.1 A leitura em uma frase

> **O Troféu Bleik Store não é um item: é um recibo.**
> Ele nasce, é visto por alguns segundos e morre, deixando atrás de si um
> número que só cresce. O trabalho de engenharia não está no item — está em
> **garantir que cada troféu emitido vire exatamente um ponto, uma vez só**,
> mesmo quando o servidor cai no meio da conversão.

### 1.2 As sete decisões que o pedido força

**1. O ponto mora no agente, não no plugin.** O plugin do jogo é reiniciado,
recompilado e sobrevive a wipe por sorte. A pontuação de uma temporada de três
meses não pode morar num arquivo `data/` de plugin. Ela mora onde a base de
jogadores já sobrevive ao wipe: no `rustagent.db` — na tabela `player_stats`
que a pesquisa de ranking já desenhou **[R§9.2]**.

**2. A conversão acontece no plugin, o registro acontece no agente.** São
coisas diferentes e o intervalo entre elas é onde os pontos se perdem. O plugin
remove o item **e emite um evento**; o agente recebe o evento **e soma**. Se o
RCON estiver caído no instante da conversão, o plugin **guarda em fila** e
reenvia — porque o item já foi destruído e não volta (§3.5).

**3. O troféu é a única métrica do ranking imune à taxa do servidor.** A
pesquisa mostrou que somar mineração entre um servidor 1x e um 5x produz uma
lista ordenada por "em que servidor a pessoa jogou" **[R§12.4]**. O troféu não
tem esse defeito: ele é **emitido por evento**, não coletado por golpe. Um
troféu em `pvp1` vale o mesmo que um troféu em `farm3`. **É a métrica mais
honesta para o ranking global da rede** — e é por isso que ela merece ser a
métrica de premiação.

**4. "Objeto 3D com a logo" tem um limite duro no Rust — mas a logo tem saída.**
Modelo 3D próprio não existe sem mod de cliente, e **a arte é uma medalha
circular** ([`trofeu_bleik_store.png`](trofeu_bleik_store.png)), forma que
**nenhum item do jogo tem**. A saída não é forçar a malha: é aceitar um item
nativo como representação e **mostrar a medalha de verdade na interface**, por
um pipeline de imagem que já funciona neste projeto (`Assets/ui/`). Há ainda uma
via D em construção — o sistema de item custom em [`Docs/CustomItem/`](../CustomItem/),
de outro agente — que pode substituir a recomendação. O §2 detalha as quatro.

**5. O stack de 5 é quase decorativo — e isso é bom.** Se o troféu é removido
no instante em que entra no inventário, **nunca existem dois no mesmo slot**. O
limite de 5 só passa a valer se a conversão for adiada. Foi **medido** no
catálogo deste agente que há itens com `max_stack = 5` nativo, caso o limite
vire regra dura (§2.4).

**6. O briefing tem um conflito interno, e ele é de produto.** "O item físico
servirá para representar a conquista" e "será automaticamente removido" se
anulam: um item removido em zero segundo nunca é visto. A recomendação é um
**atraso deliberado e curto** entre receber e converter (§3.5). É a pergunta
Q1 do §13.

**7. "Permanente e não pode ser perdido" não pode significar "imune a
correção".** O ponto não se perde por morte, drop, wipe ou troca de servidor —
é o que o dono pediu, e o modelo entrega. Mas fraude detectada precisa de
estorno, com autor e motivo, na `stat_adjustments` **[R§9.2]**. As duas coisas
convivem: **permanente para o jogo, corrigível pelo admin** (§5.5).

### 1.3 A tabela-resumo

| Pergunta | Resposta curta | Onde |
|---|---|---|
| O que é o item? | item nativo renomeado; a medalha aparece na **interface**, não na malha | §2 |
| A arte já existe? | sim — mas 87× acima do teto de imagem do CUI; precisa de uma versão de 256 px | §2.5 |
| Quem remove? | o plugin, no hook de entrada em container | §3.2 |
| Quem soma? | o agente, ao receber o evento | §4 |
| Onde o ponto mora? | `player_stats`, métrica `trophy.bleik`, migração 033 | §5.1 |
| E se o RCON cair? | fila no plugin + `batchId` idempotente no agente | §3.5, §4.3 |
| Quantos troféus circulam? | orçamento proposto: ~50/semana para o jogador dedicado | §7.1 |
| O que quebra primeiro? | a dungeon sem cooldown vira farm e achata o ranking | §7.2 |
| A premiação é automática? | OZCoins e VIP, sim; a skin de R$, não | §9 |

---

## 2 — O item físico

### 2.1 A arte já existe, e ela decide coisas

📎 [`trofeu_bleik_store.png`](trofeu_bleik_store.png) — nesta mesma pasta.
**Medido:** 1254 × 1254 px, 2.949.869 bytes, fundo transparente.

**O que a arte é:** uma **medalha circular**. Aro dourado com serrilha de moeda,
miolo azul com padrão de circuito, um **B** dourado em serifa no centro,
`TROFÉU` no arco superior e `BLEIKSTORE` no inferior, estrelas nas laterais.

Isso **não é um detalhe estético — é um requisito de forma**, e ele muda a
escolha do item base:

| A arte é | Então o item base ideal seria | E o Rust tem? |
|---|---|---|
| medalha / moeda circular | uma moeda, medalha ou disco | **não.** O jogo não tem item-moeda |
| dourada e brilhante | um objeto dourado | sim — `easter.goldegg` |
| um prêmio | uma taça | sim — `trophy`, mas **é taça, não medalha** |

> **A consequência, dita sem rodeio:** com item nativo, **a forma 3D e a arte
> não vão bater**. Ou o jogador segura uma taça (forma de prêmio, arte errada),
> ou um ovo dourado (cor certa, forma errada). É por isso que o §2.5 importa
> tanto: **é na interface que a medalha aparece como ela é** — e a interface é
> onde o jogador passa a maior parte do tempo olhando para o troféu.

### 2.2 "Objeto 3D com a logo": o que o Rust permite

| A metade do pedido | É possível? | Por quê |
|---|---|---|
| **objeto físico em 3D** | **sim, com item nativo** | o jogo tem itens cuja malha é um prêmio |
| **modelo 3D próprio (a medalha)** | **não** | malha custom exige que o **cliente** baixe o asset; servidor com Oxide não muda o cliente de ninguém |
| **nome "Troféu Bleik Store"** | **sim, trivial** | `item.name` no Oxide sobrescreve o nome daquele item |
| **a logo no ícone do inventário** | **só por skin aprovada** | o ícone do slot vem de `itemdef.iconSprite` ou de `skin.invItem.icon` — os dois são do cliente |
| **a logo na interface (CUI)** | **sim, e em alta fidelidade** | §2.5. É o caminho que já funciona neste projeto |

A confusão que vale desfazer de uma vez: **skin de workshop não é modelo 3D
custom.** A skin troca a *textura* sobre a malha do item base — um troféu
skinado continua com o formato de taça. E há um portão adicional: o cliente só
baixa skins que a **Facepunch aprovou**; uma skin publicada mas não aceita
aparece como o item sem skin.

### 2.3 Os candidatos, medidos no catálogo deste agente

Consultado o espelho de itens em `data/rustagent.db` (1259 itens, tabela
`items`, alimentada por `core/src/game/items-mirror.ts`). `item_id` e
`max_stack` são **medidos**, não estimados:

| `shortname` | Nome no jogo | `item_id` | `max_stack` | Forma vs. a arte |
|---|---|---|---|---|
| `trophy` | Twitch Rivals Trophy | `975983052` | **1** | taça sobre base — **é prêmio**, não é medalha |
| `trophy2023` | Twitch Rivals Trophy 2023 | `-901370585` | 1 | idem |
| `discord.trophy` | Discord Trophy | `1494014226` | 1 | idem |
| `easter.goldegg` | Gold Egg | `-1002156085` | **10** | dourado e brilhante; forma de ovo |
| `easter.silveregg` | Silver Egg | `1757265204` | 10 | o "prata", se um dia houver hierarquia |
| `xmas.present.medium` | Medium Present | `756517185` | **5** | **o único com stack 5 nativo** |
| `sign.artistcanvas.s` | Artist Canvas Small | `-946599131` | 5 | **aceita imagem arbitrária** — a via C |
| `skull.trophy` | Skull Trophy | `-769647921` | 1 | troféu de parede, temático demais |

Três coisas saltam da tabela:

- **os três troféus nativos têm `max_stack = 1`.** O "limite de 5 por stack" do
  briefing **não é o comportamento nativo** de nenhum deles (§2.7);
- **`xmas.present.medium` tem `max_stack = 5` exato** — coincidência útil se o
  stack virar requisito duro;
- **nenhum item do jogo é uma moeda.** A busca por moeda, medalha, disco, ficha
  e crachá no catálogo devolve apenas `discoball` e `discofloor`, que são outra
  coisa. A forma da arte não tem correspondente nativo.

### 2.4 As quatro vias

**Via A — item nativo renomeado.**
Base `trophy` (`975983052`), `skinId = 0`, `item.name = "Troféu Bleik Store"`.

- **ganha:** zero dependência externa, funciona no primeiro dia, sem custo;
- **abre mão de:** a forma da medalha e a logo no slot. A identidade vem do
  **nome**, e a arte aparece na interface (§2.5).

**Via B — skin de workshop com a arte.**
Mesma coisa, mais um `skinId` de skin publicada **e aprovada**.

- **ganha:** a logo no ícone do slot e na textura do objeto;
- **custa:** produzir, submeter e **depender da aprovação da Facepunch** — sem
  prazo e sem garantia. Depende também de o item base **aceitar** skins, o que
  os itens de evento (Twitch/Discord) tipicamente **não** fazem;
- **veredito:** melhoria futura, nunca bloqueio da fatia T1.

**Via C — superfície de imagem.**
`sign.artistcanvas.*` com a arte carregada por plugin de placa.

- **ganha:** a medalha exata, sem aprovação de ninguém;
- **abre mão de:** ser um prêmio. Um quadro é deployable, não troféu.

**Via D — o sistema de item custom da casa.** 🚧 **em construção por outro
agente**

Há uma frente paralela em [`Docs/CustomItem/`](../CustomItem/) construindo um
sistema de item customizado neste projeto. **Ela ainda não produziu documento**
— a pasta está vazia nesta sessão (05/09/2026), e o dono avisou que o `.md`
explicativo vem depois.

**Por que isso importa aqui:** se aquele sistema resolver ícone, nome e
comportamento de item de forma reaproveitável, **ele passa a ser a via
recomendada** e as vias A e B viram plano B. As perguntas a fazer ao documento
dele, quando existir:

1. ele troca o **ícone do slot** sem depender de skin aprovada?
2. o item custom sobrevive a `oxide.reload` e a restart do servidor?
3. como ele identifica o item — `skinId` reservado, `item.name`, ou um campo
   próprio? **Isso decide o filtro do hook de conversão do §3.3**;
4. ele já resolve `max_stack` por item, sem plugin de stack global (§2.7)?
5. o `origemz.give` consegue entregar um item dele, ou é preciso um comando
   novo (§2.8)?

> 📌 **Pendência de atualização.** Quando `Docs/CustomItem/*.md` existir, **este
> §2 deve ser revisado** — provavelmente para trocar a recomendação. As demais
> seções (§3 em diante) não dependem da via escolhida: elas tratam do que
> acontece **depois** que o item chega, e isso é igual nas quatro.

**Decisão proposta enquanto a via D não existe:** **via A**, com a arte na
interface (§2.5). O `shortname` e o `skinId` são **configuração, não código**
(§5.3) — trocar depois é mudar uma constante.

### 2.5 Onde a medalha aparece como ela é: a interface

Este é o caminho que **já funciona neste projeto** e que salva o pedido "o
objeto deve possuir a logo da Bleik Store": no CUI, a arte não é textura de
item — é **imagem**, e imagem arbitrária o servidor entrega.

O pipeline existe e está medido:

| Peça | Onde | O que faz |
|---|---|---|
| Pasta de assets | `Assets/ui/` | um PNG novo fica disponível no próximo envio, **sem recompilar** |
| Carga | `core/src/game/ui-images.ts:97` | lê os `.png`, converte para base64 |
| Referência no documento | `source: { kind: 'stored', key: 'trofeu_bleik_store' }` | a chave é o nome do arquivo sem extensão |
| Desenho | `ui-cui.ts` → `RawImage` com `png` = CRC do FileStorage | o plugin troca o lugar reservado pelo CRC na hora de desenhar |

**O teto, e ele é duro — medido em `ui-images.ts:87`:**

```
UI_IMAGE_MAX_BYTES = 45_000     (bytes de BASE64, nao do arquivo)
  ⇒ o PNG precisa caber em ~33 750 bytes
```

| Arquivo | Bytes | Em base64 | Contra o teto |
|---|---|---|---|
| `Assets/ui/ozcoin.png` (referência viva) | 17.593 | ~23.457 | **passa** |
| `trofeu_bleik_store.png` **como está** | 2.949.869 | ~3.933.159 | **87× acima. É recusado no carregamento** |

> **Ação concreta:** a arte precisa de uma versão de interface —
> **256 × 256 px** (ou 128 × 128), PNG com transparência, otimizada, em
> **≤ 33 KB**, salva como `Assets/ui/trofeu_bleik_store.png`. O arquivo de
> 1254 px fica onde está, como **original** para o site, o painel e material
> gráfico — lá não há teto de 45 KB.

Com isso, a medalha aparece **com a logo, na arte original**, em todos os
lugares que importam: o recibo da conversão, a tela de ranking no jogo, o
painel e o site. O que fica sendo aproximação é só a malha 3D na mão do jogador
— e é a parte que o Rust não deixa resolver.

### 2.6 A armadilha que derruba o jogador do servidor

**Medida e documentada neste projeto** (`core/src/game/ui-cui.ts:309-330`), e
ela morde exatamente quem for desenhar o troféu na interface pelo caminho de
item:

```
O cliente faz:
    var skin = itemdef.skins.FirstOrDefault(x => x.id == (int)requestedSkin);
    if (skin.id == (int)requestedSkin) c.sprite = skin.invItem.icon;

Com skinid 0 num item SEM skins, o FirstOrDefault devolve o default
do struct - cujo id e 0. O `if` passa, `skin.invItem` e null, e o
AddUI lanca NullReferenceException: O JOGADOR CAI DO SERVIDOR.
```

Os itens candidatos do §2.3 são **itens de evento**, e itens de evento
tipicamente **não têm skins**. Ou seja: desenhar o troféu no CUI como
`{ itemid: 975983052, skinid: 0 }` é a receita exata do crash.

**As duas saídas, e as duas estão certas:**

1. **omitir o campo `skinid`** quando ele for 0 — é o que `skinIdOf` já faz em
   `ui-cui.ts:328`, e o cliente cai no `itemdef.iconSprite`;
2. **melhor ainda: não desenhar por item.** Usar `kind: 'stored'` com a arte do
   §2.5. Além de não ter esse risco, mostra a **medalha de verdade** em vez do
   ícone da taça.

### 2.7 O stack de 5, e por que ele quase não importa

O briefing pede stack de 5. Três fatos, em ordem:

**1. Nenhum dos troféus nativos empilha.** Medido: `max_stack = 1` nos três.

**2. Mudar `max_stack` é global e invasivo.** O valor vive na `ItemDefinition`,
que é **do jogo**, não do item. Alterá-lo exige um plugin de stack
(`StackSizeController` e afins) e vale para **todo** `trophy` do servidor.
*(A pergunta 4 da via D, §2.4, existe para saber se o sistema de item custom já
resolve isso por item — que seria a saída limpa.)*

**3. E, sobretudo: com conversão imediata o stack nunca é exercido.** Se o
troféu é removido ao entrar no inventário, o segundo **nunca encontra o primeiro
no slot**. O limite de 5 descreve um estado que não chega a existir.

> **Portanto:** o stack de 5 só vira requisito real se a resposta à Q1 (§13) for
> "conversão adiada, com troféus visíveis acumulando". Nesse caso o caminho
> barato é **trocar o item base** por `xmas.present.medium` (stack 5 nativo,
> medido) em vez de instalar um plugin de stack para mudar um número global.

**O que já está resolvido:** o `origemz.give` **já fatia a entrega por
`max_stack`** — `Plugins/OrigemZAgent.cs:1420-1425` corta em pedaços de
`maxStack` e recusa com `TOO_MANY_STACKS` acima do teto. Qualquer que seja o
item escolhido, a entrega respeita o stack dele sem código novo.

### 2.8 O caminho de entrega já existe

Nada precisa ser inventado para **colocar** um troféu na mão de alguém:

```
origemz.give <steamId> <shortname> <amount> <skinId> <mode>
```

- definido em `core/src/game/plugin-contract.ts:240`;
- implementado em `Plugins/OrigemZAgent.cs:857`;
- o modo `auto` (`core/src/store/service.ts:84`) entrega no inventário e
  **dropa aos pés** o que não couber — resolve sozinho "inventário cheio na hora
  do prêmio";
- **um lugar só manda `give`** (`core/src/store/service.ts:725`), e o troféu
  deve entrar por esse mesmo lugar, não por um caminho paralelo.

Premiar com troféu, do lado do agente, **é uma chamada**. O trabalho novo está
em §3 e §4 — no que acontece **depois** que o item chega.

---

## 3 — A conversão: do item ao ponto

### 3.1 A regra, escrita para não ter interpretação

| Regra | Formulação exata |
|---|---|
| **Taxa** | 1 troféu = 1 ponto. Inteiro. Sem multiplicador, sem bônus de VIP, sem evento de dobro |
| **Momento** | no instante em que o item entra na posse do jogador (§3.3) |
| **Destino do item** | destruído. Não vai para lugar nenhum |
| **Destino do ponto** | `player_stats`, métrica `trophy.bleik`, somado no período aberto |
| **Reversibilidade pelo jogo** | nenhuma. Morte, wipe, troca de servidor, drop: o ponto fica |
| **Reversibilidade pelo admin** | existe, com autor e motivo, e fica registrada (§5.5) |
| **Escopo do ponto** | segue o jogador, não o servidor: `steam_id` é a chave |

**Por que taxa fixa e inteira, sem exceção.** Um multiplicador de VIP no
troféu faria a premiação da temporada ser vendida na loja. É a mesma armadilha
que a pesquisa de ranking apontou no farm com privilégio **[R§13.1]** — e aqui
ela é pior, porque o prêmio é real. **O troféu deve ser a métrica que dinheiro
não compra.**

### 3.2 Onde a conversão acontece — e por que no plugin

**No plugin.** Não há alternativa honesta:

- o agente **não vê** o inventário de ninguém em tempo real. Ele conversa por
  RCON, e o RCON não emite "fulano recebeu um item" **[R§3.1]**;
- fazer o agente **perguntar** de tempos em tempos criaria uma janela em que o
  troféu está no inventário e pode ser dropado ou trocado — exatamente o que o
  briefing proíbe;
- o hook do Oxide dispara **no instante** e no processo do jogo, que é onde a
  remoção é atômica em relação à entrada.

### 3.3 Os quatro portões de entrada

Um item pode chegar às mãos de um jogador por caminhos diferentes, e um plugin
que só cobre o primeiro deixa três buracos:

| # | Como o troféu chega | Hook que pega | Cuidado |
|---|---|---|---|
| 1 | `origemz.give`, missão, dungeon — nasce **no inventário** | `OnItemAddedToContainer` | filtrar `container.playerOwner != null` |
| 2 | dentro de uma **caixa de loot** (barril, airdrop, keycard) | também `OnItemAddedToContainer`, quando o jogador move para si | o hook dispara **na caixa** primeiro; não converter lá |
| 3 | **no chão**, dropado ou de spawn raro | `OnItemPickup` → cai no caso 1 | pegar do chão é entrar no inventário |
| 4 | dado por **outro jogador** ou tirado de um corpo | caso 1 de novo | o §3.4 explica por que isso não vira exploit |

**A regra única que cobre os quatro:** *converte quando, e somente quando, o
item passa a estar num container cujo dono é um `BasePlayer` real, não NPC.*
Tudo o mais é o mesmo caminho.

**A armadilha técnica que vale escrever no código.** Remover o item **dentro**
do próprio hook de adição mexe na coleção que o jogo está iterando. O padrão
seguro no Oxide é adiar um tick:

```csharp
// Converter DENTRO do OnItemAddedToContainer mexe no container
// que o jogo esta percorrendo neste instante. Um NextTick custa
// ~16 ms e evita o comportamento indefinido.
private void OnItemAddedToContainer(ItemContainer container, Item item)
{
    if (item == null || item.info == null) return;
    if (item.info.itemid != TrophyItemId) return;

    BasePlayer owner = container.playerOwner;
    if (owner == null || owner.IsNpc) return;

    // O amount e lido AGORA: depois do NextTick o item pode ter
    // sido movido, e ler la daria a quantidade errada.
    int amount = item.amount;

    NextTick(() => ConvertTrophy(owner, item, amount));
}
```

### 3.4 As três proibições — e a que não precisa existir

O briefing proíbe **guardar**, **dropar** e **transferir**. Com conversão
imediata, as três se resolvem sozinhas: não há o que dropar, porque o item já
não existe.

Ainda assim, a defesa em profundidade custa pouco e cobre o caso em que a
conversão falha e o item sobrevive:

| Proibição | Hook | O que devolver |
|---|---|---|
| guardar em caixa/armário | `CanAcceptItem(container, item, pos)` | `ItemContainer.CanAcceptResult.CannotAccept` quando o container **não** for o inventário do jogador |
| dropar no chão | `CanMoveItem(...)` | não-nulo quando o destino for `worldmodel` |
| transferir a outro jogador | coberto pelos dois de cima | — |

> **Observação importante:** a proibição de transferir **não precisa ser
> perfeita**, porque transferir troféu não é exploit — é troca de soma zero.
> Quem recebe converte, quem deu não converteu. O total da rede não muda. O que
> precisa ser perfeito é a **emissão** (§8), não a circulação.

### 3.5 A janela, e o que acontece quando ela falha

Este é o único ponto do sistema onde um ponto pode **sumir de verdade**:

```
 t0   o item entra no inventario
 t1   o plugin destroi o item              <-- irreversivel
 t2   o plugin emite o evento
 t3   o agente recebe e soma               <-- pode falhar
 t4   o agente confirma (ack)
```

Entre `t1` e `t3` o troféu não existe em lugar nenhum: nem como item, nem como
ponto. Se o RCON estiver caído em `t2`, o jogador perdeu a conquista e **não há
como saber**.

**As três defesas, em ordem de importância:**

**1. O plugin escreve antes de destruir.** A ordem correta é `registrar na fila
local` → `destruir o item` → `tentar emitir`. Assim uma queda entre a fila e a
emissão é recuperável: a fila persiste em `data/` do Oxide e é reenviada no
`OnServerInitialized`.

**2. O agente é idempotente.** Cada conversão carrega um `trophyId` único
(`steamId + timestamp + contador`). A tabela `stat_batches` **[R§9.2]** já
existe no desenho exatamente para isso: um `ack` perdido faria o mesmo evento
entrar duas vezes e **dobrar o ponto de alguém sem nada no log**.

**3. A auditoria fecha a conta.** Emitidos × convertidos, por dia, por servidor
(§8.2). É o que faz um buraco aparecer em vez de virar reclamação de jogador.

### 3.6 O recibo ao jogador

Converter em silêncio é o pior desfecho possível: o jogador vê um item aparecer
e sumir, e a conclusão natural dele é "o servidor comeu meu prêmio".

Mínimo aceitável, em ordem de custo:

1. **mensagem no chat**, nomeada, com o total: *"🏆 Troféu Bleik Store! Você
   agora tem 47 pontos na temporada."* — o `OrigemZChat` já existe;
2. **efeito e som** no momento da conversão — reforça que foi de propósito;
3. **a tela do ranking no jogo**, com a linha do próprio jogador. O item
   `RANKING` **já está no menu** do CUI (`core/src/game/ui-preset-main-menu.ts:320`),
   hoje com a dica *"O ranking de jogadores entra aqui."* — o troféu é o
   primeiro conteúdo que pode ocupar aquele espaço.

**E é aqui que a medalha aparece.** O recibo e a tela de ranking desenham
`source: { kind: 'stored', key: 'trofeu_bleik_store' }` (§2.5) — a arte
original, com a logo, em vez do ícone do item base. **Isso inverte a ordem de
importância do §2:** o jogador vê a taça por três segundos e a medalha todas as
vezes que abre o menu. A interface é onde o troféu tem a cara certa.

---

## 4 — O contrato agente ↔ plugin

### 4.1 As duas metades já existem, e nenhuma precisa ser inventada

A pesquisa de ranking desenhou dois caminhos de dado, por razões diferentes
**[R§8]**. O troféu usa **os dois**, e cabe nos dois sem alteração de desenho:

| Caminho | Como funciona | Serve ao troféu porque |
|---|---|---|
| **push** — evento espontâneo | linha JSON com marcador feio, lida no canal `log` do `RconClient` | a conversão é **rara** (dezenas/dia) e tem **valor imediato**: o recibo no chat e o número na tela têm que ser agora |
| **pull** — lote agregado | `origemz.stats.flush` → agente aplica → `origemz.stats.ack` | é o que **garante**. Push é UDP-como: perdeu o frame, perdeu o ponto |

O molde do push existe e está medido: `#OZPEVT#` em
`Plugins/OrigemZPlayer.cs:383`. O molde do pull existe e está medido:
`origemz.bp.export` em `Plugins/OrigemZAgent.cs`, com paginação, `count` total,
`offset`/`limit` normalizados e teto de bytes por frame.

### 4.2 O evento de conversão (push)

Marcador `#OZSTAT#` — o irmão do `#OZPEVT#` proposto em **[R§8.4]**. Uma linha,
sempre, porque o agente separa o stream por linha:

```
#OZSTAT#{"contract":1,"kind":"trophy","trophyId":"7656…-1757088123-4",
         "steamId":"7656…","name":"Fulano","amount":1,
         "source":"dungeon","at":1757088123}
```

| Campo | Tipo | Por que ele existe |
|---|---|---|
| `contract` | int | o agente recusa o que não entende, como o roadmap pede para a Fase 2 |
| `kind` | string | `"trophy"` hoje; o mesmo canal levará `kill` e `shot` amanhã |
| `trophyId` | string | **a chave da idempotência.** Sem ela, um reenvio da fila dobra o ponto |
| `steamId` | string | a identidade que sobrevive ao wipe |
| `name` | string | só para o log e o anúncio; **nunca** é a chave |
| `amount` | int | ≥ 1. A dungeon entrega 3-5 de uma vez e não deve virar 5 eventos |
| `source` | string | de onde veio (§5.3). É o campo que faz a auditoria do §8.2 existir |
| `at` | int | epoch em **segundos**, do relógio do servidor. Texto formatado exigiria que os dois lados concordassem sobre fuso — e eles não concordam |

**A armadilha já paga por outro plugin, e que se repete aqui.** O `EmitEvent` do
`OrigemZPlayer` adia um frame (`timer.Once(0f, …)`) porque um `Puts` dentro de
um hook **disparado por comando** vira a *resposta daquele comando*. O troféu
tem o mesmo risco: `origemz.give` → item entra → hook converte → `Puts`. Sem o
adiamento, o evento sai no lugar da resposta do `give`, e o desfecho é duplo —
**o give morre com `PLUGIN_INVALID_RESPONSE` e o ponto nunca chega**. Copiar o
`timer.Once(0f, …)` não é estilo: é a correção de um bug já medido neste
projeto.

### 4.3 O lote (pull)

Mesmo desenho de **[R§8.2]**, com o troféu como mais uma métrica:

```
origemz.stats.flush [offset] [limit]
  → {"ok":true,"contract":1,"batchId":"…","seq":41,
     "count":312,"offset":0,"limit":100,
     "players":[{"steamId":"7656…","metrics":{"trophy.bleik":3,
                 "trophy.bleik.dungeon":2,"trophy.bleik.daily":1}}],
     "records":[]}

origemz.stats.ack <batchId>
  → o plugin SÓ AQUI zera o buffer
```

As cinco propriedades continuam valendo sem mudança: o volume desaparece, a
perda é recuperável, a duplicata é inofensiva (`stat_batches`), o `oxide.reload`
custa segundos e o hook só soma em memória.

### 4.4 Por que os dois, e não um

| Só push | Só pull | Os dois |
|---|---|---|
| um frame de RCON perdido = ponto perdido, **sem rastro** | o jogador espera até 60 s para ver o ponto; o recibo chega frio | o push dá o **agora**, o pull dá o **garantido** |

A duplicata entre os dois caminhos é resolvida pelo mesmo `trophyId`: o agente
ignora o que já viu. **Sem a dupla via, um frame de chat perdido viraria um
prêmio de temporada perdido** — e num sistema cujo topo ganha R$, isso não é um
detalhe operacional.

### 4.5 A fila do plugin, escrita antes de destruir

O ponto do §3.5, agora como sequência de código:

```csharp
// A ORDEM IMPORTA, e ela nao e a intuitiva.
//
// Destruir o item primeiro e emitir depois parece mais limpo,
// mas abre uma janela em que o trofeu nao existe como item NEM
// como ponto. O jogador perde a conquista e ninguem fica
// sabendo - nem ele, nem o log.
//
// Gravar na fila ANTES da destruicao troca esse risco por outro
// muito menor: uma queda entre a fila e a destruicao faz o
// trofeu ser contado com o item ainda na mao. O
// OnServerInitialized reconcilia, e um item orfao e visivel;
// um ponto perdido nao e.
_queue.Add(record);      // 1. persiste  (data file do Oxide)
SaveQueue();             // 2. grava em disco
item.Remove();           // 3. destroi   <- irreversivel
EmitTrophyEvent(record); // 4. tenta o push (pode falhar sem dano)
```

---

## 5 — O modelo de dados

### 5.1 O troféu é uma métrica — e por isso não precisa de tabela nova

Esta é a conclusão mais economizadora do documento inteiro.

A pesquisa de ranking escolheu, deliberadamente, guardar estatística como
`(metric TEXT, value INTEGER)` em vez de uma coluna por métrica **[R§9.2]**. A
justificativa escrita lá era: *"a lista de métricas CRESCE (…) coluna por
métrica é uma migração por ideia"*. E a lista de "fora de escopo, declarado"
terminava com a frase que decide este caso:

> *"Todos cabem no modelo do §9 sem migração nova — **são métricas, e métrica é
> linha, não coluna**."*

**O Troféu Bleik Store é exatamente isso.** Ele entra em `player_stats` como
mais uma linha. Não há `trophies`, não há `trophy_events`, não há migração 034.

```sql
-- Nao ha DDL nova. Isto e um INSERT no esquema da migracao 033.
INSERT INTO player_stats (period_id, steam_id, metric, value, updated_at)
VALUES (?, ?, 'trophy.bleik', ?, ?)
ON CONFLICT (period_id, steam_id, metric)
DO UPDATE SET value = value + excluded.value,
              updated_at = excluded.updated_at;
```

**A dependência que isso cria, e que precisa ser dita em voz alta:** o troféu
**depende da migração 033 e da fatia 1 do ranking**. Ele não é uma frente
paralela que pode começar antes. Ver §11.

### 5.2 As métricas

Uma métrica de total e uma por fonte. As de fonte não são luxo — são o que
permite responder "de onde vieram os 400 pontos do primeiro colocado?" sem
guardar evento cru.

| Métrica | O que conta | Entra no ranking? |
|---|---|---|
| `trophy.bleik` | **o total.** É a métrica do ranking e do prêmio | **sim** — é a lista |
| `trophy.bleik.event` | vindos de airdrop/monumento/keycard | não; é diagnóstico |
| `trophy.bleik.daily` | vindos de missão diária | não |
| `trophy.bleik.dungeon` | vindos da Dungeon | não |
| `trophy.bleik.rare` | vindos do spawn raro | não |
| `trophy.bleik.admin` | dados à mão pelo painel | não — e **é o que se olha primeiro** numa contestação |

Invariante que a auditoria do §8.2 confere todo dia:

```
trophy.bleik == event + daily + dungeon + rare + admin
```

Uma diferença aqui **não é erro de arredondamento** — não há float. É evento
perdido, evento duplicado ou fonte não instrumentada. As três merecem alarme.

### 5.3 A procedência, e por que ela vale mais que o total

O `source` do evento (§4.2) é o campo mais barato e mais útil do sistema:

- **explica o ranking**: "o TOP 1 tem 380 pontos, 340 deles da dungeon" é uma
  frase que muda a decisão de balanceamento;
- **encontra a fonte quebrada**: se `trophy.bleik.daily` para de crescer numa
  terça, a missão diária quebrou naquele dia — e ninguém precisou reclamar;
- **é a prova na contestação**: quando o segundo colocado acusar o primeiro, a
  resposta é a distribuição por fonte, não a palavra do admin.

O conjunto de valores válidos é **fechado e validado no agente** (zod), como
todo contrato de plugin neste projeto. `source` desconhecido ⇒
`PLUGIN_INVALID_RESPONSE`, nunca "outros".

### 5.4 A temporada

O briefing diz "ao final da temporada" e não define temporada. O modelo já tem
a resposta, e ela é a de **[R§12.1]**:

| Janela | Quem fecha | Serve para |
|---|---|---|
| `wipe` | o `WipeClock`, quando `wipes.save_created_at` muda | a disputa da semana |
| **`season`** | **configuração** (mês, trimestre) | **a premiação deste documento** |
| `lifetime` | nunca | o "troféus de sempre" na ficha do jogador |

**A recomendação é `season`, e não `wipe`.** Um wipe semanal daria 12 premiações
por trimestre — e o prêmio do TOP 1 é uma skin comprada com dinheiro. Além
disso, o troféu tem a propriedade rara de **atravessar o wipe** sem virar
mentira: ele não depende do mundo, depende de o jogador ter feito a dungeon. Ver
§9.4 para o fechamento.

**O que já está resolvido e não precisa ser feito de novo:** o `WipeClock`
(`core/src/game/wipe.ts`) lê o `SaveCreatedTime` do `serverinfo` e grava em
`wipes` **mesmo quando o wipe foi feito à mão com o agente parado**. A
temporada, portanto, fecha pelo mundo que realmente nasceu — não pelo que uma
execução relatou.

### 5.5 A permanência, e o limite honesto dela

O briefing: *"o ponto será permanente e não poderá ser perdido"*.

**O que o modelo garante (e é o que o dono quis):**

| O jogador… | O ponto |
|---|---|
| morre | fica |
| é raidado | fica |
| dropa tudo | fica |
| troca de servidor | fica — a chave é `steam_id`, e `players` sobrevive ao wipe |
| some por um mês | fica |
| o mundo zera | fica, no `season` e no `lifetime` |

**O que o modelo não pode garantir, e a razão:** imunidade a correção. Se um bug
creditar 500 pontos, ou se um jogador for pego fraudando a dungeon, o número
precisa voltar. O caminho é o que **[R§13.2]** já definiu — `POST
/api/rankings/:steamId/reset` com **autor e motivo obrigatórios**, gravando em
`stat_adjustments`.

> A formulação honesta, e que deve aparecer na regra publicada aos jogadores:
> **"o ponto não se perde jogando"**. Correção administrativa de fraude ou de
> bug existe, é registrada e tem autor. Prometer imunidade absoluta é prometer
> que a fraude fica de pé — e num ranking que paga prêmio, é a promessa que
> menos se pode cumprir.

---

## 6 — As fontes de troféu

### 6.1 O quadro geral

| Fonte | Existe hoje? | Quem constrói | Volume | Dificuldade |
|---|---|---|---|---|
| Eventos gerais (airdrop, monumento, keycard) | **não** | plugin novo ou plugin de terceiro | médio | **baixa** |
| Missões diárias | **não** | plugin de missão (terceiro) + ponte | alto | média |
| Dungeon Bleik Store | **não** | **construção original** | alto | **alta** |
| Spawn raro | **não** | injeção na tabela de loot | mínimo | baixa |
| Painel (`origemz.give`) | **sim** | nada a fazer | — | zero |

Fica registrado, porque é fácil supor o contrário: **`grep` por
`dungeon|missao|mission|quest|daily` no `core/src` e em `Plugins/` não devolve
nada relacionado.** Nenhuma das quatro fontes existe. A quinta linha — dar
troféu pelo painel — é a única que funciona hoje, e é o que torna possível
**testar o ranking inteiro antes de qualquer uma delas existir** (§11, fatia T1).

### 6.2 Eventos gerais do Rust

O caminho barato: um hook por evento, com chance configurável.

| Evento | Hook do Oxide | Cuidado que ele impõe |
|---|---|---|
| Airdrop saqueado | `OnLootEntity` no `supply_drop` | **um airdrop, um troféu** — não um por jogador que abriu. A entidade precisa ser marcada como já paga |
| Heli / Bradley abatido | `OnEntityDeath` | quem leva? o último dano, o maior dano, ou o time? **É decisão de produto**, não técnica (Q3, §13) |
| Keycard usado | `OnCardSwipe` | por sala, com cooldown por jogador; senão é entrar e sair da sala |
| Monumento concluído | não há hook genérico | precisa de gatilho por monumento; é o mais caro dos quatro |

**A regra que atravessa todos:** *um evento paga uma vez.* A entidade ou a sala
carrega a marca de "já pagou", e a marca morre com ela. Sem isso, um airdrop com
oito jogadores em volta emite oito troféus e a economia da temporada é decidida
por quem chega primeiro no cargo.

### 6.3 Missões diárias

O briefing pede 2 a 3 por dia, 1 troféu cada.

**A recomendação é não construir um sistema de missões.** Já existem plugins de
quest maduros no ecossistema do Oxide, e a integração é uma linha: quando a
missão conclui, chame a mesma função de conversão. O trabalho da casa é a
**ponte**, não o sistema.

O que é da casa, em qualquer cenário:

- **o relógio do "diário"**: qual hora zera, e em que fuso. Sem fixar isso, um
  jogador em fuso diferente ganha um ciclo a mais. O projeto já tem precedente:
  `messages` guarda `time_of_day` como hora **local** (`migrations.ts:1917`);
- **o teto**: 3 missões/dia é o teto **por conta**, e ele é verificado no
  agente, não confiado ao plugin de terceiro (§8.1);
- **o `source`**: tudo que vier por essa ponte é `daily`, e a auditoria confere
  que `trophy.bleik.daily` de um jogador nunca cresce mais que 3 num dia.

### 6.4 A Dungeon Bleik Store

É a peça mais cara do documento inteiro, e a única que não tem molde no
projeto. O briefing a define pelo prêmio (3 a 5 troféus), não pela mecânica —
o que é a ordem certa de pensar, mas deixa tudo em aberto.

**As sete perguntas que precisam de resposta antes de uma linha de código:**

| # | Pergunta | Por que ela decide o desenho |
|---|---|---|
| 1 | Onde ela fica? monumento existente, zona no mapa, ou instância? | instância exige teleporte e um mapa próprio; zona é barata e disputada |
| 2 | Solo ou grupo? | muda o prêmio (3-5 **por jogador** ou **por conclusão**?) e muda o abuso |
| 3 | Qual o cooldown? | **é o número que decide a economia inteira** (§7.2) |
| 4 | O que acontece se o jogador morrer lá dentro? | perde o progresso, ou volta? Muda o risco percebido |
| 5 | Outros jogadores podem entrar e matar? | PvP dentro da dungeon transforma o prêmio em prêmio de PvP |
| 6 | O que decide 3 ou 5 troféus? | tempo, dano tomado, objetivos opcionais — precisa ser **medível**, não subjetivo |
| 7 | Quantas conclusões o servidor aguenta por hora? | é o teto de emissão da rede |

**A pergunta 3 é a que não pode ficar em aberto**, e o §7.2 mostra por quê.

**O que já dá para adiantar sem responder nada disso:** a dungeon paga pelo
mesmo caminho de todo o resto — a função de conversão com `source: "dungeon"`,
`amount: 3..5`. Do ponto de vista do ranking, **a dungeon é uma chamada de
função**. Toda a complexidade dela é de game design, não de integração.

### 6.5 O spawn raro

Tecnicamente é o mais fácil: injetar o troféu na tabela de loot de contêineres
de zona de risco (`OnLootSpawn` / edição de `LootContainer`), com peso mínimo.

**A regra que preserva a intenção do briefing** (*"sem transformar essa mecânica
em uma fonte constante de pontos"*):

- **teto global por dia**, no servidor, não só probabilidade por caixa. Sem
  teto, um jogador com rota de farm otimizada transforma raro em constante;
- **só em zona de risco** — o valor da mecânica é o risco, não o loot;
- **anúncio no chat** quando cair. É um evento de servidor, não um achado
  particular. É isso que cria o momento que o briefing descreve.

**Expectativa honesta de volume:** se a intenção é surpresa, o número certo é da
ordem de **1 a 3 por servidor por semana**, não por dia. Nessa escala o spawn
raro **não é fonte de ranking** — é sabor. E está certo que seja.

---

## 7 — A economia da temporada

> Esta seção é a única do documento que trabalha com números **inventados**.
> Eles existem para mostrar a forma da conta e onde ela quebra, não para serem
> a configuração final. O que não é inventado é o **método**.

### 7.1 A conta, com números de exemplo

Temporada de **4 semanas**. Um jogador dedicado, que joga todo dia:

| Fonte | Por dia | Por semana | Na temporada |
|---|---|---|---|
| Missões diárias (3 × 1) | 3 | 21 | 84 |
| Dungeon (4 em média, 1×/dia) | 4 | 28 | 112 |
| Eventos gerais | ~1 | 7 | 28 |
| Spawn raro | ~0 | ~0,3 | ~1 |
| **Total** | **8** | **56** | **~225** |

O jogador casual (3 dias por semana, sem dungeon todo dia):

| | Por semana | Na temporada |
|---|---|---|
| Casual | ~15 | ~60 |

**A razão dedicado/casual fica em ~3,7×.** É uma faixa saudável: o dedicado
ganha com folga, mas o casual não olha para uma lista onde o topo tem 40× o
número dele e desiste na primeira semana.

### 7.2 O risco que mata o sistema: a dungeon sem cooldown

Este é o único ponto do documento que **precisa** de decisão antes da
implementação.

Com dungeon de ~20 minutos e nenhum cooldown, uma sessão de 5 horas rende:

```
5 h ÷ 20 min = 15 conclusoes × 4 trofeus = 60 pontos POR SESSAO
```

Comparado com os **8 pontos/dia** do jogador dedicado da tabela acima, isso é
**7,5× em uma tarde**. E o desfecho é conhecido, porque é sempre o mesmo:

1. o ranking deixa de medir participação e passa a medir **horas seguidas de
   dungeon**;
2. todas as outras fontes viram ruído estatístico — as missões diárias e os
   eventos deixam de importar;
3. **o objetivo declarado do briefing se inverte.** O texto do dono diz, com
   todas as letras: *"fazer com que os troféus incentivem os jogadores a
   participarem de diferentes conteúdos do servidor"*. Sem cooldown, o troféu
   incentiva a participar de **um** conteúdo.

**A recomendação: cooldown por conta, e ele é a peça de balanceamento
principal.**

| Cooldown | Máx./dia | Peso da dungeon no total diário | Veredito |
|---|---|---|---|
| nenhum | ilimitado | ~100% | **quebra** |
| 6 h | 4 | ~67% | dominante, mas não único |
| 12 h | 2 | ~50% | equilibrado |
| **24 h** | **1** | **~50% do dedicado** | **recomendado** — bate com a tabela do §7.1 |

Com 24 h a dungeon continua sendo *"o grande diferencial"* que o briefing pede —
ela é a maior fonte isolada — sem ser a única que importa.

### 7.3 Os tetos, e por que eles vivem no agente

| Teto | Valor sugerido | Onde é verificado |
|---|---|---|
| Missões diárias por conta/dia | 3 | agente |
| Dungeon por conta/dia | 1 | plugin **e** agente |
| Eventos gerais por conta/dia | 10 | agente |
| Spawn raro por servidor/dia | 1 | plugin |
| **Total por conta/dia** | **~15** | **agente** — é o alarme, não o corte |

**Por que no agente, e não só no plugin.** O plugin é o lado que pode ser
substituído, reconfigurado por outro admin ou trocado por um plugin de terceiro
que não conhece a regra. O agente é o lado que guarda o número e paga o prêmio.
Quem paga confere.

E o teto total **não deve recusar em silêncio**: ele soma normalmente e
**levanta a bandeira**. Recusar o 16º troféu de um jogador legítimo (que fez um
evento a mais num dia atípico) custa mais caro que marcá-lo para revisão — que é
a política do §8.3, e é a mesma de **[R§13.2]**.

---

## 8 — Anti-abuso

### 8.1 Os seis abusos específicos do troféu

A pesquisa de ranking listou cinco abusos para as métricas de farm e PvP
**[R§13.1]**. O troféu tem outros, porque a superfície é outra: **aqui não se
frauda a medição, se frauda a emissão.**

| # | Abuso | Como é feito | Sinal detectável |
|---|---|---|---|
| 1 | **Evento pagando várias vezes** | oito jogadores saqueiam o mesmo airdrop | `trophy.bleik.event` de vários steamIds no mesmo segundo, mesma grid |
| 2 | **Dungeon em loop** | rodar sem cooldown, ou burlá-lo com relog | intervalo entre conclusões abaixo do cooldown; conclusões por hora acima do teto |
| 3 | **Dungeon com alt de carga** | alt entra no grupo só para multiplicar o prêmio | conta com `played_seconds` mínimo e `trophy.bleik.dungeon` alto; sempre nos mesmos grupos |
| 4 | **Missão diária falsa** | plugin de quest mal configurado, ou missão que se completa sozinha | `trophy.bleik.daily` > teto num dia; todos os jogadores concluindo no mesmo minuto |
| 5 | **Troféu dado por engano** | admin usa `origemz.give` sem saber que aquilo vira ponto | `trophy.bleik.admin` crescendo sem ordem de serviço |
| 6 | **Reenvio da fila do plugin** | falha de `ack` reenvia lote já aplicado | **não é abuso, é bug — e é o mais provável dos seis.** Sinal: `trophy.bleik` cresce sem evento novo no log |

O item 6 merece o destaque: **a fraude mais provável neste sistema é a que
ninguém comete.** Um `ack` perdido dobra o ponto de alguém em silêncio, e num
ranking premiado isso é indistinguível de trapaça. É por ele que o `trophyId`
existe (§4.2) e é por ele que a tabela `stat_batches` **[R§9.2]** não é
opcional.

### 8.2 A conta que precisa fechar

A auditoria não é relatório — é uma **conta diária que fecha ou não fecha**:

```
emitidos pelo plugin (fila + eventos)  ==  convertidos no agente
     e, dentro do agente:
trophy.bleik  ==  event + daily + dungeon + rare + admin
```

Um diagnóstico por tipo de diferença:

| Diferença | Provável causa | O que fazer |
|---|---|---|
| convertidos **<** emitidos | evento perdido entre `t1` e `t3` (§3.5) | o `flush` seguinte deve fechar; se não fechar, a fila do plugin não persistiu |
| convertidos **>** emitidos | reenvio aplicado duas vezes | `stat_batches` falhou — **para tudo e investiga**, é o pior caso |
| total **≠** soma das fontes | fonte não instrumentada, ou `source` inválido aceito | achar quem emite sem `source` |
| um jogador acima do teto diário | abuso 2, 3 ou 4 | marca para revisão; **não zera sozinho** |

### 8.3 A política, que é a mesma da casa

> **Marcar e mandar para revisão humana. Nunca punir sozinho.**

É o que **[R§13.2]** já decidiu para o ranking, é o que os servidores maduros
fazem, e aqui vale ainda mais: **um auto-ban errado num ranking premiado tira o
prêmio da pessoa certa em público.**

Na prática:

- um marcador na linha da lista, visível ao admin, invisível ao jogador;
- `POST /api/rankings/:steamId/reset` com **autor e motivo obrigatórios**,
  gravando em `stat_adjustments` **[R§9.2]**;
- e o que o §5.3 já entrega de graça: a distribuição por fonte como resposta à
  contestação.

**O que o troféu não deve fazer**, herdado de **[R§13.3]**: não expõe IP, não
vira prova de cheat (estatística anômala é motivo para olhar, não para
concluir), e não some com o wipe.

---

## 9 — A premiação

### 9.1 A tabela do dono, e o que cada linha custa para executar

| Posição | Prêmio | Executável hoje? | Como |
|---|---|---|---|
| 🥇 TOP 1 | Skin de R$ XX | **não** — §9.3 | fora do agente |
| 🥇 TOP 1 | 5.000 OZCoins | **sim** | `SiteWallet.credit()` |
| 🥈 TOP 2 | VIP | **sim** | `VipService.grant()` |
| 🥈 TOP 2 | 3.000 OZCoins | **sim** | idem |
| 🥉 TOP 3 | 2.000 OZCoins | **sim** | idem |
| 🏅 TOP 4–10 | 1.000 OZCoins cada | **sim** | idem |

**Custo total por temporada:** 5.000 + 3.000 + 2.000 + (7 × 1.000) = **17.000
OZCoins**, mais um VIP, mais a skin.

### 9.2 O que já é executável, e por quê

**OZCoins — `core/src/store/site-wallet.ts`.** O método `credit()` existe e vai
à carteira do site com `Idempotency-Key`. O campo `reference` (`wallet.ts:86`) é
o que torna o crédito **idempotente**, e o comentário no código explica a
armadilha exata que ele evita. Para a premiação, a `reference` deve ser
determinística:

```
season:<periodId>:rank:<posicao>:<steamId>
```

Assim, rodar o pagamento duas vezes por engano **não paga duas vezes** — o site
devolve o `after_balance` da linha original. Num pagamento de 17.000 OZCoins
disparado por um clique, essa propriedade não é conforto: é a diferença entre
um erro corrigível e um prejuízo.

**VIP — `core/src/vip/service.ts:299`.** `grant({ steamId, tier, expiresAt })`
recusa nível que não existe no `OrigemZVip.json` (`#assertKnownTier`) e recusa
`expiresAt` no passado. As duas coisas que dariam errado num prêmio de
temporada — "tier premiado não existe mais" e "VIP nasce vencido" — **já são
recusadas com erro claro**, não silenciosamente aceitas.

Duas decisões que ficam para o dono, porque são de produto (Q5, §13): **qual
tier** e **por quanto tempo**.

### 9.3 A skin de R$ XX — o único prêmio que o sistema não entrega

Vale ser direto, porque é a linha que costuma ser descoberta na véspera:

Uma skin de Rust "no valor de R$ XX" é um **item do inventário Steam**. Ela é
comprada no Steam Community Market e transferida por **Steam Trade**, entre duas
contas Steam. O agente não tem — e não deve ter — credencial de conta Steam para
negociar itens de mercado. Isso está fora do escopo dele por desenho, não por
falta de implementação.

Três saídas, em ordem de honestidade:

| Saída | Como funciona | Custo |
|---|---|---|
| **(a) entrega manual** | o admin compra e faz o trade | ~5 min de trabalho humano, 1× por temporada. **Recomendada** |
| **(b) skin de servidor** | `skinId` aplicado via skinbox — vale só nos servidores da rede | grátis e imediato, mas **não é o prêmio prometido** |
| **(c) equivalente em OZCoins** | R$ XX vira OZCoins ao câmbio da loja | automático; muda o prêmio |

**Recomendação: (a).** Uma vez por temporada, para uma pessoa. Automatizar
Steam Trade para pagar um prêmio por trimestre é construir a peça mais frágil do
sistema inteiro para economizar cinco minutos por temporada. O que **deve** ser
automatizado é a **notificação** ao admin: "a temporada fechou, o TOP 1 é o
fulano, e falta entregar a skin" — pendência aberta até alguém marcar como
entregue.

### 9.4 O fechamento, e por que o snapshot não é otimização

Quando a temporada fecha:

```
1. fecha o periodo             (stat_periods.ended_at = agora)
2. CONGELA o top 10            (snapshot, com a posicao e o valor)
3. abre o periodo seguinte
4. paga OZCoins e VIP          (reference deterministica, §9.2)
5. abre a pendencia da skin    (§9.3)
6. anuncia                     (chat, painel, site)
```

**O passo 2 é o que impede a discussão.** Sem congelar, a tela "campeões da
temporada passada" é uma **consulta viva** — e uma consulta viva muda quando um
ponto atrasado chega pelo `flush`, quando um estorno é aplicado ou quando os
critérios mudam. O campeão de março mudaria em maio. É o mesmo raciocínio de
**[R§12.2]**, e aqui ele tem consequência financeira.

**Empates.** A ordem de desempate é a de **[R§12.6]**, e ela precisa estar
publicada **antes** da temporada, não descoberta no empate:

1. o valor;
2. **quem chegou primeiro àquele valor** (`updated_at` ascendente) — quem fez o
   ponto antes leva;
3. `steam_id`, para a ordenação ser determinística entre páginas.

O critério 3 parece burocrático e não é: sem ele, dois jogadores empatados
trocam de lugar entre a página 1 e a página 2, e **um deles simplesmente some da
lista**.

---

## 10 — A API e as telas

### 10.1 A API: nenhuma rota nova

O troféu é uma métrica, então ele entra pelas rotas que **[R§10]** já desenhou:

```
GET /api/rankings/metrics
    → passa a listar 'trophy.bleik' (rótulo "Troféu Bleik Store",
      unidade "troféus", entra no global: SIM)

GET /api/rankings?metric=trophy.bleik&scope=global&period=season&limit=10
    → a lista da premiação

GET /api/players/:steamId/rankings
    → a posição do jogador, com a distribuição por fonte

POST /api/rankings/:steamId/reset
    → o estorno do §8.3, com autor e motivo
```

Os **três campos que toda resposta de ranking carrega** **[R§10]** ganham um
peso extra aqui, porque a premiação é real:

| Campo | Por que ele importa no troféu |
|---|---|
| `measuredSince` | "desde quando" é a defesa contra "eu jogava antes de vocês medirem" |
| `coverage` | um servidor com o plugin fora do ar aparece como **zero**, e zero parece "ninguém jogou". Numa temporada premiada, isso é uma reclamação legítima |
| `updatedAt` | o jogador precisa saber se o número que ele vê é de agora ou de dois minutos atrás |

Uma rota **nova**, e só uma, para o §8.2:

```
GET /api/rankings/trophies/audit?serverId=&from=&to=
    → emitidos × convertidos, por dia, por fonte, com as diferenças
      destacadas. É a tela que faz o bug 6 (§8.1) aparecer.
```

### 10.2 As telas

| Onde | O que mostra | Estado hoje |
|---|---|---|
| **Jogo (CUI)** | top 10 da temporada + a linha do próprio jogador + total | o item `RANKING` **já existe no menu** (`ui-preset-main-menu.ts:320`), como placeholder |
| **Painel** | a lista, a distribuição por fonte, os marcadores de suspeita, o botão de estorno, a auditoria do §8.2 | não existe |
| **Site** | a lista pública da temporada — é o que o briefing pede | do lado do site; o agente entrega por `/api/rankings` |
| **Chat** | o recibo (§3.6) e o anúncio do spawn raro | `OrigemZChat` existe |

**Uma regra para as três telas públicas:** a lista mostra `measuredSince` e
`coverage` **na própria tela**, não num tooltip. Um ranking premiado que não diz
desde quando mede é um ranking que vai ser contestado — e o custo de responder
uma contestação é maior que o custo de mostrar duas linhas a mais.

---

## 11 — Plano de implementação

### 11.1 A dependência que manda na ordem

```
                    migracao 033 + fatia 1 do ranking   [R§16]
                     (stat_periods, player_stats,
                      stat_batches, stats.flush/ack)
                                  │
                                  ▼
              ┌─────────── T1: o trofeu manual ───────────┐
              │  (o ranking inteiro, com give pelo painel) │
              └───────────────────────────────────────────┘
                                  │
        ┌─────────────┬───────────┴───────┬─────────────┐
        ▼             ▼                   ▼             ▼
    T2 eventos    T3 missoes          T4 dungeon    T5 spawn raro
        └─────────────┴───────────┬───────┴─────────────┘
                                  ▼
                        T6 temporada e premiacao
```

**O troféu não pode começar antes da fatia 1 do ranking.** Ele não tem onde
guardar o ponto. Isso não é atraso: a fatia 1 é pequena e entrega, sozinha, a
infraestrutura de contador, período, lote e idempotência.

### 11.2 As fatias

**T1 — O troféu manual, ponta a ponta**

O ranking completo, com a única fonte que já funciona hoje: `origemz.give` pelo
painel.

- escolher o item base e fixá-lo em config (§2.4) — via A enquanto a via D não
  existir;
- exportar a arte para `Assets/ui/trofeu_bleik_store.png` em ≤ 33 KB (§2.5);
- hook de conversão + fila persistente + `#OZSTAT#` (§3.3, §4.2, §4.5);
- `trophy.bleik` no catálogo de métricas; `source` validado (§5.2, §5.3);
- recibo no chat (§3.6);
- `GET /api/rankings?metric=trophy.bleik`.

**Pronto quando:** dar um troféu pelo painel move o número na API em segundos;
**derrubar o RCON no meio da conversão não perde o ponto**; e dar 10 troféus de
uma vez soma 10, não 1 nem 100.

> Esta fatia é a que **prova o sistema inteiro**. As quatro seguintes só trocam
> quem chama a função.

**T2 — Eventos gerais** (§6.2)
Airdrop e keycard primeiro — são os dois com hook direto. Monumento por último.

**Pronto quando:** um airdrop saqueado por 8 jogadores emite **um** troféu.

**T3 — Missões diárias** (§6.3)
A ponte para o plugin de quest, o relógio do "diário" e o teto no agente.

**Pronto quando:** o teto de 3/dia é respeitado mesmo se o plugin de quest
emitir 10, e a virada do dia acontece na hora local configurada.

**T4 — Dungeon** (§6.4)
Só depois das sete perguntas respondidas, e com o cooldown decidido (§7.2).

**Pronto quando:** concluir paga 3-5 com `source: "dungeon"`; o cooldown
sobrevive a relog; e o abuso 3 (alt de carga) aparece na auditoria.

**T5 — Spawn raro** (§6.5)
Injeção na tabela de loot, teto por servidor/dia, anúncio no chat.

**T6 — Temporada e premiação** (§9)
Fechamento, snapshot congelado, pagamento idempotente de OZCoins, `grant` de
VIP, pendência da skin, telas com `coverage` e `measuredSince`.

**Pronto quando:** fechar a temporada duas vezes por engano **não paga duas
vezes**; e a tela dos campeões continua igual depois de um estorno aplicado ao
período fechado.

### 11.3 Fora de escopo, declarado

Troféus de raridade diferente (bronze/prata/ouro valendo 1/3/5); troca de
troféus por itens na loja; ranking de clã por troféus; troféu como moeda;
temporadas paralelas com regras diferentes.

Todos cabem no modelo do §5 **sem migração nova** — são métricas, e métrica é
linha, não coluna. Ficam de fora porque **cada um deles muda a economia do §7**,
e a economia precisa de uma temporada medida antes de ser mexida.

---

## 12 — Medido, conferido, projeto

> A tabela que impede este documento de ser lido como relato de coisa pronta.

### 12.1 Medido — verificado nesta sessão, no repositório e no banco

| Fato | Onde foi medido |
|---|---|
| A arte é uma medalha circular, 1254 × 1254 px, 2.949.869 bytes | `Docs/TrofeuBleik/trofeu_bleik_store.png` |
| O jogo tem 3 itens com forma de troféu; todos com `max_stack = 1` | `data/rustagent.db`, tabela `items` (1259 linhas) |
| **Nenhum item do jogo é uma moeda ou medalha** | busca por moeda/medalha/disco/ficha/crachá no mesmo catálogo |
| O teto de imagem do CUI é 45.000 bytes de base64 (⇒ PNG ≤ ~33 KB) | `game/ui-images.ts:87` |
| A arte atual está **87× acima** desse teto | 2.949.869 B → ~3.933.159 B em base64 |
| A referência viva `Assets/ui/ozcoin.png` tem 17.593 B e passa | `Assets/ui/` |
| `skinid: 0` num item **sem skins** derruba o jogador do servidor | comentário **medido** em `game/ui-cui.ts:309-330` |
| A pasta `Docs/CustomItem/` existe e está **vazia** nesta sessão | `ls Docs/CustomItem/` em 05/09/2026 |
| `trophy` = Twitch Rivals Trophy, `item_id` `975983052` | idem |
| `xmas.present.medium` tem `max_stack = 5` nativo | idem |
| As molduras/placas (`sign.*frame*`, `sign.artistcanvas.*`) têm `max_stack = 5` | idem |
| `origemz.give <steamId> <shortname> <amount> <skinId> <mode>` existe e é usado | `plugin-contract.ts:240`, `OrigemZAgent.cs:857` |
| O `give` fatia por `max_stack` e recusa com `TOO_MANY_STACKS` | `OrigemZAgent.cs:1395-1425` |
| Um lugar só manda `give` (loja e fila do site compartilham) | `store/service.ts:725` |
| O evento espontâneo `#OZPEVT#` existe, com adiamento de um frame | `OrigemZPlayer.cs:383-484` |
| O `Puts` dentro de hook disparado por comando vira a resposta do comando | comentário **medido** em `OrigemZPlayer.cs:465-480` |
| `SiteWallet.credit()` existe, com `reference` idempotente | `store/site-wallet.ts:155`, `store/wallet.ts:86` |
| `VipService.grant()` recusa tier desconhecido e `expiresAt` no passado | `vip/service.ts:299-320` |
| O item `RANKING` já está no menu do CUI, como placeholder | `game/ui-preset-main-menu.ts:320` |
| **Não há** missão, quest ou dungeon no projeto | `grep` em `core/src` e `Plugins/` |

### 12.2 Conferido — lido da pesquisa de ranking, não re-verificado aqui

| Fato | Fonte |
|---|---|
| O RCON não entrega kill, minério nem distância | [R§1.2], [R§3.1] |
| O esquema da migração 033 (`stat_periods`, `player_stats`, `stat_batches`, `stat_adjustments`) | [R§9.2] |
| O desenho `flush`/`ack` com `batchId` idempotente | [R§8.2] |
| As três janelas (`wipe`, `season`, `lifetime`) e o `WipeClock` como âncora | [R§12.1] |
| A ordem de desempate | [R§12.6] |
| A política "marcar, nunca punir sozinho" | [R§13.2] |
| As rotas `/api/rankings/*` e os campos `measuredSince`/`coverage`/`updatedAt` | [R§10] |

### 12.3 Projeto — nada disto existe nem foi validado

Tudo o mais. Em particular, e vale nomear:

- o item, o hook de conversão, a fila do plugin, o `#OZSTAT#`;
- as métricas `trophy.bleik*` e a validação de `source`;
- as quatro fontes (§6) — **nenhuma delas existe**;
- **os números do §7 são inventados**, inclusive o cooldown recomendado. Eles
  mostram a forma da conta, não a configuração final;
- a auditoria do §8.2 e a rota `/api/rankings/trophies/audit`;
- o fechamento de temporada e o pagamento automático.

### 12.4 O que pode dar errado e este documento não cobre

- **o sistema de item custom** (§2.4, via D): está em construção em
  [`Docs/CustomItem/`](../CustomItem/), **a pasta estava vazia quando este
  documento foi escrito**, e ele pode mudar a recomendação do §2. As cinco
  perguntas a fazer ao documento dele estão listadas lá;
- **skin de workshop aprovada** (§2.4, via B): depende da Facepunch, sem prazo.
  O documento contorna, não resolve;
- **a versão de interface da arte** (§2.5): a de 1254 px **não carrega**. Até
  existir uma de ≤ 33 KB, o troféu não tem imagem na tela do jogo;
- **plugin de quest de terceiro**: a ponte do §6.3 supõe que ele tem um hook de
  conclusão. Isso **não foi verificado** em plugin nenhum;
- **a dungeon**: as sete perguntas do §6.4 são de game design. Nenhuma tem
  resposta aqui, e o custo de construção não foi estimado;
- **o servidor de teste local** (`Servers/server01`) sobe e compila plugins,
  mas **nada deste documento foi rodado nele**.

---

## 13 — Perguntas em aberto para o dono

> Oito perguntas. As três primeiras **bloqueiam** a implementação; as outras
> podem ser respondidas até a fatia T6.

### Q1 — A conversão é instantânea ou tem um atraso deliberado? 🔴 bloqueia

O briefing pede as duas coisas: *"removido automaticamente"* e *"o item físico
servirá para representar a conquista"*. Um item removido em zero segundo nunca é
visto — e aí o "objeto 3D com a logo" do §2 vira trabalho para nada.

| Opção | O jogador vê | Consequência |
|---|---|---|
| **(a) instantânea** | nada; só a mensagem | o item físico é decorativo. **O stack de 5 deixa de fazer sentido** |
| **(b) atraso curto (3-5 s)** | o troféu no slot, então ele some com efeito | **recomendada** — cumpre as duas metades do briefing |
| **(c) resgate manual** | acumula até clicar | cumpre o briefing melhor de todos, mas **reabre guardar/dropar/transferir** e exige o stack de 5 de verdade |

### Q2 — Qual o cooldown da Dungeon? 🔴 bloqueia

Sem resposta, a dungeon vira farm e o ranking deixa de medir participação (§7.2).
**Recomendado: 24 h por conta.**

### Q3 — A temporada é o `season` (mês/trimestre) ou o `wipe` (semana)? 🔴 bloqueia

Decide o fechamento, o snapshot e a frequência do prêmio. Wipe semanal = 12
premiações por trimestre, com uma skin comprada em cada. **Recomendado:
trimestral**, e o ranking do `wipe` existe em paralelo, sem prêmio.

### Q4 — O ranking premiado é por servidor ou global da rede?

O troféu é a única métrica imune à taxa de coleta (§1.2), então **o global é
honesto aqui** — ao contrário de mineração. Global premia a rede; por servidor
premia mais gente. **Recomendado: global**, com a lista por servidor visível
como filtro.

### Q5 — Qual tier de VIP e por quanto tempo, no TOP 2?

`VipService.grant()` precisa de `tier` (que exista no `OrigemZVip.json`) e
`expiresAt`.

### Q6 — A skin do TOP 1: entrega manual, skin de servidor ou equivalente em OZCoins?

As três estão no §9.3. **Recomendada: manual, com pendência aberta no painel.**

### Q7 — Qual item base — e esperamos o sistema de item custom?

O §2.4 recomenda `trophy` renomeado (via A) **enquanto a via D não existe**. Mas
há um sistema de item custom sendo construído em
[`Docs/CustomItem/`](../CustomItem/), por outro agente, e ele pode resolver
ícone, nome e stack de um jeito que torna a via A desnecessária.

| Opção | Consequência |
|---|---|
| **(a) via A agora, revisar depois** | T1 começa já; troca de item base é mudar uma constante. **Recomendada** |
| **(b) esperar a via D** | evita retrabalho no item, mas **T1 fica parado** — e T1 é o que prova o sistema inteiro |

Como o item base é **configuração** (§5.3) e todas as seções de §3 em diante
independem dele, (a) não cria dívida: quando o `.md` do CustomItem existir, o §2
é revisto e a constante muda.

### Q8 — A versão de 256 px da arte: quem gera?

O §2.5 pede `Assets/ui/trofeu_bleik_store.png` em ≤ 33 KB. É uma exportação, não
um redesenho — mas precisa sair da arte original, não de um upscale.

---

## Referências

- [`trofeu_bleik_store.png`](trofeu_bleik_store.png) — a arte original da
  medalha (1254 px). A versão de interface (≤ 33 KB) ainda não existe (§2.5)
- [`Docs/CustomItem/`](../CustomItem/) — 🚧 o sistema de item custom, em
  construção por outro agente. **Quando o `.md` dele existir, o §2 deve ser
  revisto** (as perguntas a fazer estão no §2.4, via D)
- [`Docs/Ranking/19-PESQUISA-RANKING.md`](../Ranking/19-PESQUISA-RANKING.md) —
  a pesquisa de ranking. **[R§n]** neste documento aponta para lá
- [`Docs/06-API.md`](../06-API.md) — o padrão das rotas e dos códigos de erro
- [`Docs/09-ROADMAP.md`](../09-ROADMAP.md) — a base de jogadores que sobrevive
  ao wipe, e o contrato versionado da Fase 2
- [`Docs/11-BRIEFING-PLUGINS.md`](../11-BRIEFING-PLUGINS.md) — o contrato
  agente ↔ plugin
- [`Docs/13-BRIEFING-JOGADORES.md`](../13-BRIEFING-JOGADORES.md) — os eventos
  por hook do Oxide
- `core/src/game/plugin-contract.ts` — `origemz.give` e o contrato versionado
- `core/src/game/ui-images.ts` — a pasta `Assets/ui/` e o teto de 45.000 bytes
- `core/src/game/ui-cui.ts` — o `RawImage` por chave e o crash do `skinid: 0`
- `core/src/store/site-wallet.ts` — o crédito idempotente de OZCoins
- `core/src/vip/service.ts` — a concessão de VIP
- `Plugins/OrigemZAgent.cs` — o `give`, o fatiamento por stack, o `bp.export`
- `Plugins/OrigemZPlayer.cs` — o `#OZPEVT#` e o adiamento de um frame
