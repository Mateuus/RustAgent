# OrigemZWorkshop — o vestiário

O jogador vê a skin **no próprio personagem** antes de escolher, monta **presets** (conjuntos
"item → skin") e liga o **AUTO**, que já entrega com a skin do preset todo item que entra no
inventário — inclusive o kit de nascimento.

Para quem vai testar no jogo e para quem mexer no `Plugins/OrigemZWorkshop.cs` (seção §16).
Versão do plugin: **0.7.0**.

---

## 1. O pedido

Palavras do dono, 19/09/2026:

> "O que não temos é um vestuário para o usuário visualizar a skin no personagem dele. Estava
> pensando aproveitar para ele criar loadout e preset, e nisso já aplicar as skins automático no
> loadout dele, claro, se tiver ativado. E nisso nós pegaríamos o 2D do personagem do inventário,
> ou colocamos na página skins mesmo ou você cria uma nova e coloca no botão no inventário. Isso
> você vai decidir."

E depois: *"o plugin skin tem algo parecido, pode ajudar"* — o `Docs/Skins/Skins.cs` (misticos).
Foi dele que veio a peça que faltava (§3).

**Como li "loadout" e "preset":**

- **Preset** é um conjunto nomeado de escolhas "este item → esta skin". O jogador tem até 5.
- **Loadout** é o kit que o `OrigemZPlayer` entrega ao nascer. O jogador **não** monta os itens
  do kit (isso é do servidor, pelo painel); o que ele controla é a **skin** com que esses itens
  chegam. É o AUTO que faz isso (§4.3).

Se "loadout" queria dizer outra coisa — o jogador escolher *quais itens* recebe —, é outra feature,
e ela mexe em economia, não em skin.

---

## 2. A decisão: tela nova, ao lado do inventário

| Opção | Por que não |
|---|---|
| Desenhar o personagem na página de skins | O CUI não desenha modelo 3D. Não existe componente para isso: o "2D do personagem" que o jogador vê é o modelo que o **cliente** renderiza na tela de inventário. |
| Pôr a prévia dentro da página de skins | A página é tela cheia na camada `Overall` e cobre o inventário. Para ver o personagem, ela teria de sumir. |
| **Uma tela nova pendurada no inventário** | O personagem continua à esquerda, vivo, e cada troca aparece nele na hora. **Escolhida.** |

**O vestiário mora no lugar do painel de saque**, à direita do inventário: 420 × 524 na base
1280×720, na camada `Overlay`. Ele abre por três caminhos:

1. o botão **VESTIÁRIO** do inventário, ao lado do SKINS;
2. o botão **VESTIÁRIO** no cabeçalho do menu de skins (o menu fecha e o inventário abre);
3. `/vestiario` no chat.

Clicar no botão com o vestiário aberto, ou digitar `/vestiario` de novo, fecha.

---

## 3. A peça emprestada do plugin Skins: o saque virtual

Duas coisas pareciam impossíveis:

- abrir o inventário **pelo servidor** (para o `/vestiario` funcionar do chat);
- saber quando o jogador **fecha** o inventário. A camada `Inventory` some sem avisar ninguém
  (memória: *a camada do CUI só o cliente resolve*), e sem esse aviso a prova de uma skin
  bloqueada não teria hora certa para acabar.

O `Skins.cs` resolve as duas com um **saque de um contêiner vazio, tendo o próprio jogador como
fonte** (`ContainerController.Show`):

```text
loot.Clear()                          encerra o saque anterior
loot.PositionChecks = false
loot.entitySource  = player           o próprio jogador é a "caixa"
loot.AddContainer(contêiner vazio)    capacidade 0, NoItemInput
loot.SendImmediate()
player.ClientRPC("RPC_OpenLootPanel", "generic")   → o cliente abre o inventário
```

**Medido no decompilado do server01 em 19/09/2026** (`ilspycmd` no `Assembly-CSharp.dll`):

- `PlayerLoot.Clear` chama `OnPlayerLootEnd(PlayerLoot)`. É o aviso de "fechou o inventário":
  quem fecha o inventário durante um saque manda o comando de console `inventory.endloot`
  (`ConVar/Inventory.cs`), que é um `loot.Clear()`. Abrir outra caixa também passa por ele — o
  `StartLootingEntity` começa com `Clear()` —, e morrer (`EndLooting`), dormir e desconectar
  também.
- `PlayerLoot.Check` derruba o saque se `entitySource.CanBeLooted(player)` for falso, e
  `BasePlayer.CanBeLooted` **recusa o próprio jogador**, a menos que o hook
  `CanLootPlayer(target, looter)` devolva `true`. O plugin devolve `true` só enquanto o vestiário
  daquele jogador está aberto.

O que **não** foi medido (sem cliente): como o painel `generic` com capacidade 0 aparece. Ele fica
atrás do vestiário, que é opaco e está na camada `Overlay`.

---

## 4. O que o jogador faz

```text
┌─ VESTIÁRIO ─ o boneco ao lado mostra o que você veste ─── X ┐
│ [Preset 1] [Inverno] [PvP]  [+]                              │
│ [ Inverno__________ ] [VESTIR] [AUTO: SIM] [APAGAR]          │
│ SEUS ITENS                                   skin no preset  │
│ ▌▣ Hoodie             Vestindo                         ▣     │
│  ▣ Assault Rifle      Barra 1                          ▣     │
│  ▣ Rock               Na mão                           —     │
│  ▣ L96 Rifle          Não está com você                ▣     │
│ SKINS · HOODIE                                               │
│ ┌────┐┌────┐┌────┐┌────┐┌────┐                               │
│ │Padr││Bras││Gelo││ 🔒 ││ 🔒 │   ← as suas primeiro,         │
│ └────┘└────┘└────┘└────┘└────┘     as bloqueadas depois      │
│ "Brasa" vestida e guardada no preset "Inverno".              │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 A lista de itens

Sem repetir item, nesta ordem:

1. o que ele **veste** (é o que o boneco mostra);
2. o da mão, a barra, o inventário e a mochila vestida;
3. o que está no preset e ele não carrega ("No preset");
4. os itens em que ele **tem** alguma skin e não carrega ("Não está com você").

Os dois últimos existem para **montar o preset antes de ter o item**: a AK que vem no kit do
próximo nascimento. À direita de cada linha, a skin que o preset guarda para aquele item, ou "—".

**Só entra item que não empilha** (`stackable ≤ 1`). Skin diferente não empilha (armadilha 1 do
cabeçalho do plugin): um preset com skin de madeira pintaria cada pilha colhida, e a colheita
seguinte, que nasce sem skin, não juntaria mais com ela. Skin de item que empilha continua no menu
de skins, aplicada à mão.

**Variante de DLC não é pintada pelo vestiário.** Convertê-la no item base (02 §6.4) é decisão do
jogador, no menu de skins — nunca efeito colateral de um preset.

### 4.2 A grade de skins

"Padrão" primeiro; depois as skins que ele **pode usar**; depois as **bloqueadas**. As marcas da
célula:

| Marca | Quer dizer |
|---|---|
| borda **oliva** | é a skin que o preset guarda para este item ("Padrão" com borda = o item está fora do preset) |
| faixa **vermelha** no topo | é o que o item está vestindo agora |
| borda **âmbar** | está sendo provada |
| cadeado cinza | bloqueada: não é dele |
| cadeado **âmbar** | trancada pela Steam (DLC ou loja), 02 §3.1 |

A dica do mouse diz o nome inteiro, a raridade e o que o clique faz.

**O clique:**

| Na célula | Acontece |
|---|---|
| **Padrão** | o item sai do preset e todas as cópias que ele carrega voltam ao visual de fábrica |
| skin que ele **pode usar** | todas as cópias que ele carrega vestem a skin, e ela fica **guardada no preset ativo** |
| skin **bloqueada** | **prova** (§5) |
| skin de **DLC** que ele não tem | recusa com a frase do 02 §3.1. Não há prova |

"Pode usar" é a regra do 02 §3, sem exceção: posse viva, skin da casa, e a Steam por cima de tudo.
Com o `/streamer` ligado, skin com logo é **guardada** e não vestida, pelo mesmo `_strippedByPlayer`
do menu de skins (02 §6.3).

### 4.3 Presets e o AUTO

- **Abas:** até **5** presets. Clicar numa aba a torna ativa **e a veste** no que ele carrega.
  O **+** cria um preset vazio.
- **Nome:** o campo à esquerda (`InputField` com `needsKeyboard`; memória: *como o jogador digita
  dentro do menu*). Escreve e aperta Enter. Até 20 caracteres; `<`, `>` e aspas são descartados.
- **VESTIR:** veste o preset inteiro no que ele carrega agora.
- **APAGAR:** apaga o preset ativo. **Não despinta nada:** os itens continuam com a skin que estão.
  O último preset não se apaga.
- **AUTO:** ligado, **todo item que entra no inventário dele recebe a skin do preset ativo** — o
  kit ao nascer, o craft, o saque, o que ele pega do chão. Ligar também veste o preset na hora.

**Como o AUTO decide**, item a item:

1. o item entrou num contêiner do jogador (barra, roupa, inventário ou mochila vestida);
2. não empilha e não é variante de DLC;
3. o preset ativo tem skin para aquele shortname, a skin ainda está no catálogo e ele ainda pode
   usá-la (posse vencida = pula, sem apagar do preset: a posse pode voltar);
4. **o item ainda não foi decidido.** Cada item é olhado **uma vez**. Sem isso, mover a arma da
   barra para o inventário a repintaria — e desfaria a skin que o jogador escolheu à mão no menu
   de skins. Aplicar pelo menu de skins também marca o item como decidido.

A skin vai no **frame seguinte**, uma vez por jogador: pintar no meio do movimento do item é
pedir problema. Ligar o AUTO marca o inventário atual como decidido — ele passa a cuidar do que
**entrar** dali para frente.

**Sem mudança no `OrigemZPlayer`.** O kit entra pelo `GiveItem`, que dispara
`OnItemAddedToContainer` como qualquer outro item. O AUTO pega o kit do mesmo jeito que pega o
craft.

**E o que o jogador escolheu na bancada** (a skin da conta Steam dele, no craft) é trocado pelo
preset, se o preset tiver skin para aquele item. É o que "AUTO ligado" significa.

---

## 5. Provar uma skin bloqueada

É a vitrine: o jogador vê no próprio boneco o que está à venda no site.

- Clicar numa skin bloqueada a veste por **20 s** (`WardrobePreviewSeconds`, de 5 a 120) no item
  que aparece melhor: a peça **vestida**, senão a da mão, senão a primeira da barra ou do
  inventário. A mensagem diz onde comprar (`storeUrl` do catálogo).
- O rodapé vira uma faixa âmbar, *"PROVANDO "…" · volta em N s"*, com o botão **TIRAR**.
- Sem nenhum item daquele tipo, recusa: *"Para provar, você precisa estar com um(a) …"*. O
  vestiário não cria item para provar.

### 5.1 A prova nunca fica com o jogador

Ela é desfeita — a skin original volta — em qualquer um destes:

| Quando | Quem desfaz |
|---|---|
| o tempo acabou | `timer` da prova |
| escolheu outra skin, trocou de preset, VESTIR, AUTO | o próprio comando, antes de agir |
| fechou o inventário (ou abriu outra caixa) | `OnPlayerLootEnd` → `CloseWardrobe` |
| **o item saiu do contêiner** — largou, guardou numa caixa, mudou de casa | `OnItemRemovedFromContainer`, que roda com `item.parent` já nulo e **antes** de o item chegar ao destino |
| morreu, caiu ferido, desconectou | `OnPlayerDeath`, `OnPlayerWound`, `OnPlayerDisconnected` |
| o plugin foi descarregado | `Unload`, inclusive para quem está dormindo |
| **o servidor caiu no meio** | a skin original de cada item em prova fica em `oxide/data/OrigemZWorkshop/previews.json`, gravada **antes** de pintar; o boot procura cada item no inventário do dono (acordado ou dormindo) e devolve. Dono que não está no servidor na hora do boot **continua no arquivo**, e a prova é desfeita quando ele conectar (`RetryLeftoverPreviews` no `OnPlayerConnected`) |

A linha do "item saiu do contêiner" é a tranca que pega o resto: qualquer caminho pelo qual a
prova pudesse ir parar em outro lugar passa por ela.

### 5.2 O que não se prova

- **Skin oficial do Rust** (DLC ou loja Steam) que ele não tem. Provar é exatamente o empréstimo
  que a Facepunch proíbe (memória: *a Facepunch proíbe conceder DLC*). A célula mostra o cadeado
  âmbar e a frase do 02 §3.1.
- **Skin com logo** (`hideInStreamer`) com o `/streamer` ligado: ela apareceria na transmissão.
- Com a posse ainda **sincronizando** (02 §5.3): "não sei" não vira "bloqueada".

---

## 6. Onde fica cada coisa

| O quê | Onde |
|---|---|
| código | `Plugins/OrigemZWorkshop.cs`, **§16 O VESTIÁRIO**, mais os ganchos em §3 (boot, fim, morte, desconexão), o `MarkSeen` no `TryApply` (§8) e o atalho no `BuildHead` (§13) |
| presets | `oxide/data/OrigemZWorkshop/wardrobe.json` — `steamId → { active, auto, presets: [{ name, skins: { shortname: workshopId } }] }` |
| provas em curso | `oxide/data/OrigemZWorkshop/previews.json` — `uid do item → { steamId, original }` |
| ícone do botão | `Assets/menu-icons/icon-hanger.png`, embutido em base64 (`IconPng["hanger"]`), 64×64 branco sobre transparente, como os outros |

**O preset é deste servidor**, e não da rede. A favorita subiu para o agente para valer na rede
(02 §4.5); o preset pode seguir o mesmo caminho — uma tabela no agente e uma carga por jogador,
como a posse —, mas isso é migração de banco, rota e painel, e não era o que o pedido precisava
para existir. Até lá, quem troca de servidor monta o preset de novo.

O preset guarda o **workshop id**, e não o id do catálogo: ele sobrevive a recadastrar a skin. Na
hora de usar, a skin é conferida contra o catálogo **e** contra o shortname.

### 6.1 Config (`oxide/config/OrigemZWorkshop.json`)

| Chave | Padrão | Para quê |
|---|---|---|
| `WardrobeButton` | `true` | o botão VESTIÁRIO no inventário. O `/vestiario` funciona com ele desligado |
| `WardrobeButtonOffsetMin` / `Max` | `240 -38` / `316 -17` | à direita do SKINS, com as âncoras dele (`InventoryButtonAnchorMin/Max`). Estimado pela captura do dono: o CLÃ começa por volta de 318 |
| `WardrobeAnchorMin` / `Max` | `1 0.5` / `1 0.5` | a caixa, presa ao meio da borda direita |
| `WardrobeOffsetMin` / `Max` | `-436 -262` / `-16 262` | 420 × 524, com 16 de margem à direita |
| `WardrobePreviewSeconds` | `20` | a duração da prova (5 a 120) |

**A posição da caixa e a do botão não foram vistas no jogo.** Se encavalarem com o inventário, é
só mexer nestas chaves e recarregar o plugin.

### 6.2 Comandos

Todos os da tela levam o **token da sessão** e são recusados em silêncio sem ele, como os do menu
de skins (03 §5). Um a cada 80 ms; uma troca de skin a cada meio segundo (a mesma trava do
APLICAR). Abrir e fechar (`open`, `close`, `/vestiario`) não têm token e têm cota própria: um a
cada meio segundo — abrir custa um saque, um contêiner e a tela inteira.

| Comando | Argumentos |
|---|---|
| `/vestiario` | abre; de novo, fecha |
| `origemz.wardrobe.open` | nenhum (os dois botões). Com o vestiário aberto, fecha |
| `origemz.wardrobe.close` | nenhum |
| `origemz.wardrobe.item` | `token shortname` |
| `origemz.wardrobe.pick` | `token idDaSkin` (0 = Padrão) |
| `origemz.wardrobe.preset` | `token índice` |
| `origemz.wardrobe.new` / `.delete` / `.dress` / `.auto` / `.stop` | `token` |
| `origemz.wardrobe.name` | `token texto…` (texto cru do campo) |
| `origemz.wardrobe.bytes` | nenhum — só servidor/RCON ou admin |

---

## 7. Bytes

`origemz.wardrobe.bytes` monta cada região no pior caso, com o **mesmo código do redesenho**.
Medido no server01 em 19/09/2026, com a 0.7.0:

| Região | Bytes | Pior caso |
|---|---|---|
| raiz (moldura, título, X) | 1.660 | — |
| cabeçalho (abas, nome, botões) | 5.343 | 4 presets de nome longo |
| lista de itens | 30.071 | 20 linhas (`WardrobeRowsMax`), todas com skin no preset |
| grade de skins | 46.662 | 30 células (`WardrobeCellsMax`), lendárias, bloqueadas, com cadeado e dica |
| rodapé | 1.377 | faixa da prova |
| **abertura** | **85.113** | vai em 3 `AddUI` de até 40.000 (o `Pack` divide elemento por elemento) |

Os tetos de 20 linhas e 30 células são **de bytes, não de tela**: a primeira medição, com 30 e 40,
deu 116 KB na abertura. Com o catálogo de hoje (1 skin) a tela inteira é uma fração disso.

O atalho VESTIÁRIO no cabeçalho do menu de skins custou **+585 bytes** ali (3.053 → 3.638); a
abertura do menu de skins foi de 30.296 para 30.881, abaixo do teto de 40.000.

---

## 8. O que foi validado, e o que falta

**Feito, fora do jogo (19/09/2026):**

- `pluginlint` com 0 erros (e provado que ele pega erro de verdade: um erro plantado deu CS0029).
- As assinaturas dos quatro hooks novos conferidas no decompilado: `OnItemAddedToContainer` e
  `OnItemRemovedFromContainer` (`ItemContainer`, `this, item`), `OnPlayerLootEnd` (`PlayerLoot`) e
  `CanLootPlayer` (`this, player` = alvo, quem saqueia). O `pluginlint` não pega hook com assinatura
  errada.
- **Compilado e carregado no server01** pelo Oxide de verdade: `OrigemZWorkshop v0.7.0`, sem erro
  no console.
- `origemz.wardrobe.bytes` e `origemz.skins.bytes` rodados lá (§7).
- Revisão independente (`ecc:csharp-reviewer`). Ela achou um defeito **crítico**, já corrigido: o
  boot regravava o `previews.json` vazio mesmo quando não tinha conseguido desfazer uma prova (dono
  fora do servidor) — a prova ficaria com o jogador para sempre. **Provado no server01** com uma
  entrada de um steamId fictício: ela sobreviveu a duas recargas, com o aviso "1 prova(s) de uma
  queda esperam o dono conectar". Também corrigidos: a cota do abrir/fechar e o `Unload` fechando
  o vestiário de quem não está na lista de ativos. Ficou de fora, de propósito: o `previews.json`
  é gravado na hora a cada prova (e não com atraso, como o `wardrobe.json`), porque é justamente a
  gravação que protege contra a queda.

**Nada disso mostra a tela.** O dono estava conectado no server01 durante o trabalho, mas o
vestiário **não** foi aberto nele nem o inventário dele foi tocado: abrir o vestiário abre o
inventário do jogador e pinta item de verdade.

### 8.1 Roteiro de teste no jogo

Preparação: no server01, um jogador com **uma skin na posse** (painel ou `/skin give`) de um item
que ele **veste** (uma roupa) e uma skin **que ele não tem**, do mesmo item.

| # | O que fazer | O que tem de acontecer |
|---|---|---|
| 1 | Abrir o inventário (Tab) | o botão **VESTIÁRIO** aparece ao lado do SKINS, sem encavalar com o CLÃ |
| 2 | Clicar em VESTIÁRIO | o painel abre à direita, **sem cobrir** o personagem nem a grade do inventário. Se cobrir: §6.1 |
| 3 | Fechar o inventário e digitar `/vestiario` | o inventário **abre sozinho**, com o vestiário ao lado |
| 4 | Escolher a roupa vestida e clicar na skin que ele tem | o **boneco** troca na hora; a célula ganha borda oliva e faixa vermelha; a linha ganha a skin à direita |
| 5 | Clicar numa skin **bloqueada** | o boneco a veste; faixa âmbar "PROVANDO… volta em 20 s" |
| 6 | Esperar 20 s | volta à skin de antes, sozinha |
| 7 | Provar de novo e **fechar o inventário** | a prova some na hora |
| 8 | Provar de novo e **arrastar a peça para fora** (largar no chão) | o item no chão está com a skin **de antes** |
| 9 | Criar um preset (+), dar nome no campo e apertar Enter | a aba mostra o nome |
| 10 | Ligar **AUTO**, morrer e renascer | o kit chega com a skin do preset nos itens que o preset tem |
| 11 | Com o AUTO ligado, craftar ou pegar do chão um item do preset | chega com a skin |
| 12 | Aplicar outra skin pelo **menu de skins** num item e depois movê-lo de casa | o AUTO **não** o repinta |
| 13 | No menu de skins (`/skins`), clicar em VESTIÁRIO no cabeçalho | o menu fecha, o inventário abre com o vestiário |
| 14 | Abrir uma caixa com o vestiário aberto | o vestiário fecha e a caixa abre normalmente |
| 15 | Campo do nome: escrever com o inventário aberto | as teclas vão para o campo, e não para o personagem |

O 2, o 3 e o 15 são as incógnitas de verdade — posição, o painel `generic` vazio, e o teclado
dentro do inventário. O resto é lógica que o servidor já executa hoje no menu de skins.
