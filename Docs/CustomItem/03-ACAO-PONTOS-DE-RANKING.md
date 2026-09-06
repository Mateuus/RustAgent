# 03 — A ação `points`: o item que vira ponto no ranking

> **Para quem é este documento.** Para quem for construir, no lado do item
> custom, a ação *"dar pontos ao ranking"*. Ele responde a três perguntas, nesta
> ordem: **o que já está pronto** (mais do que parece), **o que falta**, e **como
> a peça que falta se encaixa** sem quebrar o que existe.
>
> **A fonte do outro lado** é [`../Ranking/20-PLANO-E-CONTRATOS.md`](../Ranking/20-PLANO-E-CONTRATOS.md),
> que fecha o esquema, os comandos e as rotas do ranking. Quando este documento
> citar formato de dado que atravessa a fronteira, ele **repete** aquele — e,
> se um dia divergirem, aquele vale.

**Escrito em 05/09/2026**, contra o repositório com a migração **042** aplicada.

---

## Índice

- [§1 — O pedido, e a frase que resume o desenho](#1--o-pedido-e-a-frase-que-resume-o-desenho)
- [§2 — O que já existe (e não precisa ser feito de novo)](#2--o-que-já-existe-e-não-precisa-ser-feito-de-novo)
- [§3 — O contrato da ação `points`](#3--o-contrato-da-ação-points)
- [§4 — Onde os pontos vão parar](#4--onde-os-pontos-vão-parar)
- [§5 — A ordem do trabalho: o ranking nasce antes do item](#5--a-ordem-do-trabalho-o-ranking-nasce-antes-do-item)
- [§6 — O elo que falta: o cadastro nunca chega ao plugin](#6--o-elo-que-falta-o-cadastro-nunca-chega-ao-plugin)
- [§7 — A conversão, no plugin](#7--a-conversão-no-plugin)
- [§8 — O evento que sai do plugin](#8--o-evento-que-sai-do-plugin)
- [§9 — O recibo ao jogador](#9--o-recibo-ao-jogador)
- [§10 — O painel](#10--o-painel)
- [§11 — As sete armadilhas, cada uma já medida](#11--as-sete-armadilhas-cada-uma-já-medida)
- [§12 — Pronto quando](#12--pronto-quando)

---

## 1 — O pedido, e a frase que resume o desenho

O dono pediu, em 05/09/2026:

> *"Vamos ter os ranking fixo como kill, tempo online etc. Mas também vamos ter o
> dinâmico, onde nós criar um ranking tipo Troféu Bleik, que é uma contagem
> quando o usuário acha um item no jogo: assim que ele pega, o item some e vira
> um ponto no ranking. **A quantidade de pontos será configurada no item.**"*

E, sobre a ordem: *"primeiro criar o módulo dinâmico Troféu Bleik, e no item lá
vai escolher 'adicionar pontos ao ranking', que é o tipo de ação do item."*

**A frase que resume o desenho inteiro:**

> **O item não é uma coisa: é um recibo.**
> Ele nasce, é visto por alguns segundos e morre, deixando atrás de si um número
> que só cresce. O trabalho não está no item — está em **garantir que cada item
> emitido vire exatamente os pontos que ele vale, uma vez só**, mesmo quando o
> servidor cai no meio da conversão.

E a consequência que economiza o projeto inteiro:

> **O Troféu Bleik não é um sistema. É uma linha na tabela de itens custom
> apontando para uma linha na tabela de rankings.** O segundo item que der
> pontos — uma medalha de evento, um ponto de missão — não custa código nenhum.

---

## 2 — O que já existe (e não precisa ser feito de novo)

> Esta seção existe porque **metade do trabalho está pronta**, e começar do zero
> seria escrever a segunda versão de coisas que já funcionam.

### 2.1 No banco

| Peça | Onde | Estado |
|---|---|---|
| `custom_items.action` — JSON, **sem `CHECK`** | `core/src/db/migrations.ts:3236` (migração 041) | pronto. **Um `kind` novo não pede migração** |
| `custom_items.consume_on_pickup` | migração **042** | pronto — é o "quando" |
| `custom_items.message` — a frase no chat | migração 041 | pronto |
| A marca `(base_shortname, skin_id)`, única | `idx_custom_items_mark`, `migrations.ts:3252` | pronto |
| `custom_item_servers` — em quais servidores vale | migração 041 | pronto |

> **Por que `action` é JSON e não colunas** (o comentário está em
> `migrations.ts:3218-3236`): a forma da ação **muda com o tipo dela**. Uma
> coluna por efeito possível daria uma tabela larga cheia de `NULL` que ninguém
> consulta. É a mesma razão da `ui_documents` (migração 008).
>
> **A consequência boa:** acrescentar `kind: "points"` **não toca o banco**.

### 2.2 No agente

| Peça | Onde | Estado |
|---|---|---|
| O tipo `CustomItemAction` com a variante `points` | `core/src/db/custom-items-repository.ts:33-50` | **já escrito** |
| O zod da borda, `discriminatedUnion('kind', …)` com `points` | `core/src/http/routes/custom-items.ts:100-133` | **já escrito** |
| `consumeOnPickup` no corpo da rota | `custom-items.ts:163` | pronto |
| `listForServer(serverId)` — só `enabled = 1`, só daquele servidor | `custom-items-repository.ts:182-195` | pronto, e é o que a sincronização vai usar |
| CRUD completo (`GET/POST/PUT/DELETE /api/custom-items`) | `custom-items.ts:264-400` | pronto |
| Entrega física do item pelo painel | `admin.ts:282` → `players.ts:494` → `origemz.give` | pronto |

O comentário em `custom-items.ts:117-120` já antecipa esta frente: a `metric`
ainda **não** é validada contra lista *porque o ranking é a migração 033*.
Quando o ranking existir, ela passa a ser.

### 2.3 No painel

| Peça | Onde |
|---|---|
| O `<select>` de tipo de ação, com "Pontos de ranking" | `panel/src/components/custom-item-dialog.tsx:852` |
| Os campos Ranking / Pontos por unidade | `custom-item-dialog.tsx:743-809` |
| O checkbox "Executar a ação assim que cair no inventário" | `custom-item-dialog.tsx:724-733` |
| O tipo espelhado | `panel/src/lib/api.ts:1280-1287` |

### 2.4 No plugin

| Peça | Onde | Estado |
|---|---|---|
| A marca `MarkOf(itemid, skin)` e o índice `_byMark` | `Plugins/OrigemZItems.cs:721-725`, `:214` | pronto |
| `OnItemAddedToContainer` — o hook de entrada | `OrigemZItems.cs:913` | **existe e já filtra por marca** |
| `OnItemUse`, `OnItemAction` | `:1154`, `:1118` | prontos |
| `RunAction` | `:1189` | existe, mas **só entende `consume`** (`:1196`) |
| `origemz.item.set / clear / list` | `:287`, `:436`, `:462` | prontos |

### 2.5 O resumo honesto

**O que falta é menos do que parece, e não é onde se espera.** Não falta modelo
de dados, não falta validação, não falta tela de cadastro. Falta:

1. **o ranking existir** (é a frente F1 do `20-PLANO-E-CONTRATOS.md`);
2. **o cadastro chegar ao plugin** (§6 — e este é o achado grave);
3. **o plugin converter e avisar** (§7 e §8).

---

## 3 — O contrato da ação `points`

### 3.1 A forma, exata

```json
{
  "kind": "points",
  "metric": "trophy.bleik",
  "perUnit": 1,
  "onPickup": true
}
```

| Campo | Tipo | Regra | Por que existe |
|---|---|---|---|
| `kind` | `"points"` | discriminante | é o que separa esta ação de `none` e `consume` |
| `metric` | string | `^[a-z][a-z0-9]*(\.[a-z0-9]+)*$` | a chave em `player_stats`. **Precisa existir em `rankings.metric`** |
| `perUnit` | int | 1 a 10 000 | **é o "a quantidade de pontos configurada no item"** do pedido |
| `onPickup` | bool | default `true` | converte ao entrar no inventário, em vez de esperar o uso |

O zod disso **já está escrito** em `core/src/http/routes/custom-items.ts:121-132`.
Não reescreva: **acrescente** a validação de que `metric` existe no catálogo
(§3.3).

### 3.2 `onPickup` e `consume_on_pickup`: duas coisas parecidas que não são a mesma

Isto confunde na primeira leitura, e o comentário da migração 042
(`migrations.ts:3284-3307`) já explica o corte:

> *"A ação diz **o QUE** acontece (somar ponto, curar); esta coluna diz **QUANDO**."*

| | Onde mora | O que decide |
|---|---|---|
| `consume_on_pickup` | **coluna** da tabela | se a ação — **qualquer** ação — dispara na entrada do inventário |
| `action.onPickup` | **campo** do JSON | o mesmo, mas só para `points` |

**São redundantes, e essa redundância é uma dívida a quitar nesta frente.**

**A recomendação:** a **coluna manda**. `action.onPickup` continua sendo aceito
pelo zod (não quebra o painel nem cadastros já gravados), mas quem decide o
momento da conversão é `consume_on_pickup` — porque a pergunta "quando" vale para
todo tipo de ação, e enfiá-la dentro de cada `kind` obrigaria a repeti-la em
cada tipo novo e a esquecê-la em um deles.

Ao gravar, **espelhe**: um cadastro com `action.onPickup = true` grava
`consume_on_pickup = 1`. Deixe isso escrito no código, em uma linha, com o
motivo — senão a próxima pessoa vai achar que é bug.

### 3.3 A validação que passa a existir

Hoje `metric` é validada **só na forma**. Com o ranking de pé, ela passa a ser
validada **no conteúdo**:

```
metric que não existe em `rankings`  →  400 RANKING_METRIC_UNKNOWN
```

E a recíproca, do outro lado: **apagar um ranking para o qual um item aponta**
deve falhar com `409 RANKING_IN_USE`. Um item que concede pontos a uma métrica
que não existe mais converteria o item em nada — o jogador perde o item e não
ganha ponto, que é o pior desfecho possível.

> Esta é a mesma trava que `custom-items.ts:411-418` já aplica para a marca
> duplicada: a frase de erro diz **qual** item colidiu, não só que colidiu.

---

## 4 — Onde os pontos vão parar

**Não há tabela de troféu.** O ponto entra em `player_stats`, que é a tabela do
ranking (migração 033), como mais uma linha:

```sql
-- Nao ha DDL nova. Isto e um INSERT no esquema da migracao 033.
INSERT INTO player_stats (period_id, steam_id, metric, value, updated_at)
VALUES (?, ?, 'trophy.bleik', ?, ?)
ON CONFLICT (period_id, steam_id, metric)
DO UPDATE SET value = value + excluded.value,
              updated_at = excluded.updated_at;
```

E o evento que o originou entra em `stat_events`, com `event_id` único — que é o
que impede o ponto de ser contado duas vezes quando ele chega pelos dois
caminhos (§8).

**A `source` do evento** é `item:<id do item custom>` — por exemplo
`item:trofeu-bleik`. É esse campo que responde, meses depois, *"de onde vieram os
400 pontos do primeiro colocado?"* sem guardar evento cru de tudo.

---

## 5 — A ordem do trabalho: o ranking nasce antes do item

O dono foi explícito: *"primeiro criar o módulo dinâmico Troféu Bleik, e no item
lá vai escolher adicionar pontos ao ranking"*.

Isso não é só preferência de fluxo de tela — é dependência dura:

```
1. o admin cria o RANKING no painel
     id: trofeu-bleik
     metric: trophy.bleik
     label: "Troféu Bleik Store"
     unit: "troféus"
     source: item          ← diz ao painel que este ranking é alimentado por item
     value_kind: counter
     global_eligible: 1    ← o troféu é imune à taxa do servidor; o global é honesto
                │
                ▼
2. o admin cria o ITEM custom
     display_name: "Troféu Bleik Store"
     base_shortname: trophy     (ou o que o §2 do 01-PESQUISA recomendar)
     skin_id: <a marca>
     consume_on_pickup: 1
     action: {"kind":"points","metric":"trophy.bleik","perUnit":1,"onPickup":true}
     message: "🏆 Troféu Bleik Store! Você agora tem {total} pontos."
                │
                ▼
3. o item é entregue (painel, loja, kit, dungeon, evento)
                │
                ▼
4. o jogador pega → o item some → o ponto entra
```

**O passo 1 é uma linha em `rankings` criada pelo painel** — sem código, sem
migração, sem deploy. É exatamente o que "ranking dinâmico" significa.

---

## 6 — O elo que falta: o cadastro nunca chega ao plugin

> **Este é o achado mais importante deste documento, e ele não estava escrito em
> lugar nenhum. Medido em 05/09/2026.**

### 6.1 O que foi medido

O plugin pede a lista de itens quando sobe:

```csharp
// Plugins/OrigemZItems.cs:269-272
Puts("#OZAREQ#" + "items");
```

E **ninguém escuta**:

- o único consumidor de linha de console no agente é `uiSync.handleLine`
  (`core/src/index.ts:320-322`), que reconhece `#OZUIREQ#`, `#OZBUY#` e `#OZBAL#`;
- **nenhuma linha de TypeScript envia `origemz.item.set`** (verificado por busca
  em `core/src`).

**Consequência:** o item custom existe no banco, aparece no painel, é entregável
pelo `origemz.give` com a skin certa — e o plugin **nunca soube que ele existe**.
Sem isso, `Match()` não acha a marca, `ApplyIdentity` não roda, e a conversão em
ponto não tem como acontecer.

### 6.2 O que construir

Um `core/src/game/custom-items-sync.ts`, no molde dos `sync` que já rodam no
gancho `rcon-connected` (`core/src/index.ts:295-301`, ao lado de
`loadoutSync`/`spawnStatusSync`):

**a) Empurrar, em dois momentos:** ao conectar o RCON, e quando o cadastro muda
(criar, editar, apagar, ligar/desligar servidor).

```
origemz.item.clear                          ← o "esqueça tudo" (OrigemZItems.cs:436)
origemz.item.set <json>                     ← um por item de listForServer(serverId)
```

**b) Responder ao pedido:** reconhecer `#OZAREQ#items` no `onConsoleLine` e
mandar a mesma sequência. **Este é o caminho que salva o `oxide.reload`** — a
mesma lição que `OrigemZAgent.cs:174-193` registra, escrita depois de um reload
ter esvaziado o cache de kits e feito jogadores nascerem sem nada.

**c) O JSON precisa crescer.** Hoje `ParseItem` (`OrigemZItems.cs:1677`) e
`ParseAction` (`:1729`) não leem `consumeOnPickup` nem o bloco `points`. Os dois
lados mudam juntos — é a regra do cabeçalho do `OrigemZAgent.cs:1-12`.

> **⚠️ E há um laço a evitar, já vivido neste projeto** (`index.ts:309-319`): o
> `onConsoleLine` recebe **toda** linha de console. Um `sync` chamado de dentro
> dele imprime no console, a linha volta pelo mesmo caminho e dispara de novo.
> Responda ao `#OZAREQ#` **fora** do caminho síncrono do gancho.

---

## 7 — A conversão, no plugin

### 7.1 Os quatro portões, e a regra única que os cobre

Um item chega às mãos de um jogador de quatro maneiras, e um plugin que só cobre
a primeira deixa três buracos:

| # | Como chega | Cuidado |
|---|---|---|
| 1 | `origemz.give`, dungeon, missão — **nasce no inventário** | o hook também dispara para container sem dono |
| 2 | dentro de uma **caixa de loot** (barril, airdrop) | o hook dispara **na caixa** primeiro; não converter lá |
| 3 | **no chão**, dropado ou de spawn raro | pegar do chão é entrar no inventário |
| 4 | dado por **outro jogador**, ou tirado de um corpo | soma zero: quem recebe converte, quem deu não converteu |

**A regra que cobre os quatro:** *converte quando, e somente quando, o item passa
a estar num container cujo dono é um `BasePlayer` real, não NPC.*

```csharp
private void OnItemAddedToContainer(ItemContainer container, Item item)
{
    if (item == null || item.info == null) return;

    CustomMark mark = MarkOf(item);
    if (mark == null || !mark.ConsumeOnPickup) return;

    BasePlayer owner = container.playerOwner;
    if (owner == null || owner.IsNpc) return;

    // O amount e lido AGORA: depois do NextTick o item pode ter
    // sido movido, e ler la daria a quantidade errada.
    int amount = item.amount;

    // Converter DENTRO deste hook mexe no container que o jogo
    // esta percorrendo neste instante. Um NextTick custa ~16 ms
    // e evita comportamento indefinido.
    NextTick(() => ConvertToPoints(owner, item, mark, amount));
}
```

### 7.2 A ordem de escrita, que não é a intuitiva

```csharp
// A ORDEM IMPORTA, e ela nao e a intuitiva.
//
// Destruir o item primeiro e emitir depois parece mais limpo,
// mas abre uma janela em que o trofeu nao existe como item NEM
// como ponto: o jogador perde a conquista e ninguem fica
// sabendo - nem ele, nem o log.
//
// Gravar na fila ANTES da destruicao troca esse risco por outro
// muito menor: uma queda entre a fila e a destruicao faz o
// trofeu ser contado com o item ainda na mao. Um item orfao e
// visivel; um ponto perdido nao e.
_queue.Add(record);      // 1. persiste  (data file do Oxide)
SaveQueue();             // 2. grava em disco
item.Remove();           // 3. destroi   <- irreversivel
EmitStatEvent(record);   // 4. tenta o push (pode falhar sem dano)
```

A fila é reenviada em `OnServerInitialized` e esvaziada só quando o agente
confirma.

> **Isto contraria a regra atual do `OrigemZItems.cs`** (cabeçalho `:9-15`: *o
> estado é cópia de trabalho em memória, descartável*). **A exceção é deliberada
> e vale só para esta fila:** o cadastro continua descartável, porque o agente o
> remanda; a fila de conversões **não pode** ser, porque o item que a originou já
> não existe. Escreva a exceção no cabeçalho, ao lado da regra que ela excetua —
> senão ela vira "alguém não leu o cabeçalho".

### 7.3 A conta dos pontos

```
pontos = amount (unidades do item)  ×  perUnit (configurado no item)
```

Um stack de 3 troféus com `perUnit = 1` dá **3**. Um item de evento com
`perUnit = 5` pego em 2 unidades dá **10**.

**Um evento por conversão, não um por unidade.** Um `NextTick` que emite 5 linhas
para um stack de 5 gasta cinco vezes o canal e cria cinco chances de perda, para
representar uma coisa só que aconteceu.

### 7.4 As três proibições, e a que não precisa existir

O briefing do troféu proíbe **guardar**, **dropar** e **transferir**. Com a
conversão na entrada, as três se resolvem sozinhas: não há o que dropar, porque
o item já não existe.

A defesa em profundidade custa pouco e cobre o caso em que a conversão falha e o
item sobrevive: `CanAcceptItem` recusando container que não seja o inventário do
jogador, e `CanMoveItem` recusando destino `worldmodel`.

> **Transferir não precisa ser perfeito**, e vale dizer por quê: transferir não é
> exploit, é troca de soma zero. Quem recebe converte; quem deu não converteu. O
> total da rede não muda. **O que precisa ser perfeito é a emissão, não a
> circulação.**

---

## 8 — O evento que sai do plugin

### 8.1 A forma

Uma linha no console, marcador colado no JSON — o irmão do `#OZPEVT#` que o
`OrigemZPlayer` já usa:

```
#OZSTAT#{"contract":1,"kind":"points","eventId":"7656…-1757088123-4","steamId":"7656…","name":"Fulano","metric":"trophy.bleik","amount":3,"source":"item:trofeu-bleik","at":1757088123}
```

| Campo | Nota |
|---|---|
| `eventId` | `steamId-epochSegundos-contador`. **É a chave da idempotência** |
| `amount` | **já multiplicado** por `perUnit`. O peso pode mudar amanhã; o ponto concedido é fato |
| `source` | `item:<id do item custom>` |
| `at` | epoch em **segundos**, relógio do servidor de jogo |

O contrato completo, com os outros `kind`, está no
[`../Ranking/20-PLANO-E-CONTRATOS.md §7`](../Ranking/20-PLANO-E-CONTRATOS.md#7--o-contrato-do-evento-ozstat).

### 8.2 O mesmo evento vai pelos dois caminhos, de propósito

```
push  (#OZSTAT#)  ─►  o AGORA      — o recibo no chat tem que ser na hora
lote  (stats.flush) ►  o GARANTIDO  — push é como UDP: perdeu o frame, perdeu o ponto
```

A duplicata é resolvida pelo `eventId`: o agente ignora o que já viu. **Sem a
dupla via, um frame de chat perdido viraria um prêmio de temporada perdido.**

Portanto: o evento convertido **continua no buffer** do plugin até o `ack` do
lote, mesmo tendo saído no push.

### 8.3 A armadilha do `Puts`, que aqui é quase certa de acontecer

**Medida neste projeto**, em `Plugins/OrigemZPlayer.cs:463-484`: um `Puts` dentro
de um hook *disparado por comando* sai com o mesmo Identifier e vira **a resposta
daquele comando**.

O caminho que ativa isso aqui é o mais comum de todos:

```
origemz.give  →  o item entra no inventario  →  o hook converte  →  Puts(#OZSTAT#…)
```

Sem adiamento, **o `give` morre com `PLUGIN_INVALID_RESPONSE` e o ponto nunca
chega** — os dois de uma vez.

```csharp
// NAO E ESTILO: e a correcao de um bug ja medido neste projeto.
// Ver OrigemZPlayer.cs:463-484.
timer.Once(0f, () => Puts(EventMarker + json));
```

---

## 9 — O recibo ao jogador

**Converter em silêncio é o pior desfecho possível.** O jogador vê um item
aparecer e sumir, e a conclusão natural dele é *"o servidor comeu meu prêmio"*.

O mínimo aceitável, em ordem de custo:

1. **mensagem no chat**, nomeada e com o total —
   `custom_items.message` **já existe** e o plugin já a usa
   (`OrigemZItems.cs:1208-1211`). Ela deve aceitar dois marcadores:
   `{pontos}` (quantos entraram agora) e `{total}` (quantos ele tem na
   temporada);
2. **efeito e som** no momento da conversão — reforça que foi de propósito, e
   não um bug;
3. **a tela do ranking no jogo** — o botão `RANKING` já está no menu
   (`core/src/game/ui-preset-main-menu.ts:320`), e a frente F6 do plano o
   preenche.

> **`{total}` tem um custo, e ele precisa ser decidido.** O plugin não conhece o
> total — quem soma é o agente. Duas saídas: (a) a mensagem imediata mostra só
> `{pontos}` e o total aparece na tela do menu; (b) o agente devolve o total ao
> plugin no `ack`, e a mensagem sai depois.
>
> **Recomendada: (a).** Ela não acrescenta uma ida e volta ao caminho crítico, e
> o jogador que quer o total abre o menu — onde o número está sempre certo.

---

## 10 — O painel

### 10.1 A dívida a quitar

`RANKING_METRICS` em `panel/src/components/custom-item-dialog.tsx:187` é uma
lista fixa de três métricas de exemplo, com um comentário datado dizendo:

> *"**ESBOÇO** … Esta lista existe para o cadastro do item poder ser terminado
> hoje, e ela **SAI daqui quando o ranking chegar** — a fonte passa a ser ele."*

**O ranking chegou. Ela sai**, e o `<select>` passa a ler
`GET /api/rankings/metrics` — filtrando por `enabled = 1`, mostrando `label` ao
usuário e mandando `metric` no corpo.

Some também o aviso *"O ranking ainda não existe"* de `:902`.

### 10.2 O que a tela precisa ganhar

- **um atalho de "criar ranking"** ao lado do `<select>`, quando nenhum ranking
  serve. Sem ele, o admin precisa sair do cadastro do item, ir à aba Ranking,
  criar, e voltar — e vai perder o que digitou;
- **a coluna "Ação" da lista de itens** (`custom-items-panel.tsx:205-209`) hoje
  mostra `—` para tudo que não é `consume`. Ela passa a mostrar
  *"+1 em Troféu Bleik Store"*;
- **o campo de pontos** deve deixar claro que ele multiplica por unidade:
  o rótulo *"Pontos por unidade"* já diz isso, e a dica deve dar o exemplo do
  stack de 3.

---

## 11 — As sete armadilhas, cada uma já medida

> Nenhuma delas é hipótese. Cada linha custou um incidente neste projeto ou está
> medida no código do jogo.

| # | Armadilha | Onde foi medida | O que fazer |
|---|---|---|---|
| 1 | `Puts` em hook disparado por comando **vira a resposta do comando** — e mata o `give` junto | `OrigemZPlayer.cs:463-484` | `timer.Once(0f, …)` sempre |
| 2 | Remover item **dentro** do hook de adição mexe na coleção que o jogo está iterando | comportamento do Oxide | `NextTick`, com o `amount` lido antes |
| 3 | O hook de adição dispara **na caixa de loot** antes de disparar no jogador | §7.1 | exigir `container.playerOwner != null && !owner.IsNpc` |
| 4 | Destruir antes de registrar abre uma janela em que o ponto **não existe em lugar nenhum** | `TROFEU_BLEIK_STORE.md §3.5` | fila → `SaveQueue()` → `Remove()` → emitir |
| 5 | Um `oxide.reload` esvazia o cache do plugin, e ninguém percebe até um jogador reclamar | `OrigemZAgent.cs:174-193` | o plugin **pede** (`#OZAREQ#`); o agente **precisa responder** (§6) |
| 6 | O gancho de console recebe **toda** linha; imprimir de dentro dele **entra em laço** | `core/src/index.ts:309-319` | não mande RCON de dentro do `onConsoleLine` |
| 7 | `item.amount = 0` ainda **concede 1** no Rust | `01-PESQUISA-ITEM-CUSTOM.md`, fontes | recusar `amount <= 0` explicitamente, e não confiar no jogo |

E uma oitava, que é de produto e não de código:

| 8 | Um multiplicador de VIP no ponto faria a **premiação da temporada ser vendida na loja** | `TROFEU_BLEIK_STORE.md §3.1` | `perUnit` é do **item**, nunca do jogador. Sem bônus, sem evento de dobro |

---

## 12 — Pronto quando

A frente do item está pronta quando estas cinco frases forem verdade **num
servidor rodando**, não num teste:

1. o admin cria o ranking "Troféu Bleik Store" no painel, **sem deploy**, e ele
   aparece no `<select>` do cadastro de item;
2. o admin cria o item apontando para ele com `perUnit = 1` e
   `consume_on_pickup = 1`, e o plugin **passa a reconhecê-lo sem reiniciar**
   (§6);
3. dar **3** pelo painel some com o item e soma **3** pontos — não 1, não 100 —,
   com o recibo no chat;
4. **derrubar o RCON no meio da conversão não perde o ponto**: ele chega quando o
   canal volta, e chega **uma vez só**;
5. `oxide.reload` no meio do expediente não faz o plugin esquecer o item — ele
   pede, e o agente responde.

> A quarta é a que prova o sistema. As outras quatro são o que faz alguém
> conseguir usá-lo.

---

## Referências

- [`../Ranking/20-PLANO-E-CONTRATOS.md`](../Ranking/20-PLANO-E-CONTRATOS.md) — o esquema, os comandos e as rotas do ranking
- [`../Ranking/19-PESQUISA-RANKING.md`](../Ranking/19-PESQUISA-RANKING.md) — por que o plugin agrega e o agente busca
- [`../TrofeuBleik/TROFEU_BLEIK_STORE.md`](../TrofeuBleik/TROFEU_BLEIK_STORE.md) — o briefing do dono e a economia do troféu
- [`01-PESQUISA-ITEM-CUSTOM.md`](01-PESQUISA-ITEM-CUSTOM.md) — a marca, a identidade e as ações do item custom
- [`02-ESTUDO-MODELO-3D.md`](02-ESTUDO-MODELO-3D.md) — por que a medalha aparece na interface, e não na malha
