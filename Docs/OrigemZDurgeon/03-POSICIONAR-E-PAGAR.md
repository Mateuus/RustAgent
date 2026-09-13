# Marcar as posições, escolher a caixa, guardar o código, vestir o corredor

**Quatro pedidos do dono em 13/09/2026.** Este documento diz o que passou a
existir, onde cada coisa mora, as decisões que não são óbvias e — no §6 — o que
**só o jogo prova**.

> **A frase que resume as quatro.** Elas têm o mesmo modo de falha: funcionam na
> tela e não acontecem no jogo. O admin marca a posição, salva, a tela mostra o
> marcador de volta — e o servidor sorteia como sempre fez, porque o campo parou
> no quarto degrau (schema, coluna, repositório, `sync`) e ninguém escreveu o
> quinto. Foi assim que `npc` e `crates` viajaram até o `DungeonSpec` e ficaram
> ali, sem leitor, até 09/09/2026.

---

## Onde isto está — 13/09/2026

| # | pedido | estado | o que passou a existir |
|---|---|---|---|
| §1 | posição de NPC e caixa no desenho | **feito** | `placements` na masmorra; dois pincéis na paleta do editor; `MarksIn`/`SpawnMarked` no plugin |
| §2 | caixa por nome, e loot por caixa | **feito** | `dungeon-prefabs.ts` (29 caixas + 16 inimigos, conferidos no manifest); `crateSpecSchema` com `table` e `coins`; `CrateFields` no painel |
| §3 | o código nunca atrás da própria porta | **feito** | `lock-route.ts` no agente, `PublicCells` no plugin, `onUndelivered: 'abort'` |
| §4 | material do corredor | **feito** | `corridor.grade`; o `GradeOf` do plugin passou a olhar a célula de corredor |

**Migração:** `080 dungeon-placements`. Ela pula o 79 de propósito — ver o
cabeçalho dela.

**Nada muda para quem não mexer em nada.** Lista de marcadores vazia é o sorteio
de sempre; `corridor.grade` nulo é herdar o material da masmorra; caixa sem
`table` usa a tabela da cor. As três são o estado de toda masmorra já gravada.

---

## 1. As posições, marcadas no desenho

> *"Atualmente, NPCs e caixas nascem aleatoriamente nas salas. Na aba Desenho,
> adicionar ferramentas para marcar manualmente."*

### O formato

`placements` é uma lista, e cada marcador tem cinco campos:

```json
{ "kind": "npc", "x": 3, "z": -2, "amount": 2, "prefab": "assets/…/scientistnpc_heavy.prefab" }
```

**A coordenada é em relação à ENTRADA, e não ao canto do desenho.** `(0,0)` é a
célula do `E` — a mesma origem que o `LayoutFromGrid` do plugin usa (ele
translada o desenho inteiro para que o `E` caia ali) e a mesma que o alçapão
conhece.

Ancorar no canto seria mais fácil de calcular e erraria sozinho: o editor
**recorta** as linhas vazias ao salvar, e um desenho que perde duas colunas à
esquerda deslocaria todo marcador duas células — para dentro da parede.

### A regra do fallback

**O marcador manda na sala dele, e naquele tipo.** Decidido com o dono entre
três leituras possíveis:

| leitura | o que faria | por que não |
|---|---|---|
| por sala e por tipo | **é esta** | permite marcar só a sala do chefe |
| global | um marcador desliga o sorteio na masmorra inteira | obriga a marcar tudo de uma vez |
| somar | o marcado nasce, e o sorteio continua por cima | entrega salas mais cheias do que a receita diz |

Na prática: marcar caixa numa sala desliga a faixa `loot` **dela**; os inimigos
da mesma sala continuam sorteados se ninguém marcou inimigo ali. O corredor
conta como uma unidade — marcador de caixa em qualquer célula dele desliga a
`lootDensity` do corredor inteiro, e não só daquela célula. Desligar célula a
célula daria uma densidade que continua espalhando caixa ao lado da que o admin
escolheu.

### Duas peças no mesmo ponto

`amount` vai até 8, e o construtor as espalha num **anel** (`SpotInRing`), com
raio crescendo com a lotação. O `SpotIn` de sempre sorteia ângulo e raio, e
sortear duas vezes dentro de um círculo de um metro põe as duas em cima uma da
outra — que é exatamente o defeito que o dono mediu dentro do labirinto em
09/09/2026 (*"está spawnando 3 NPC em cima do outro"*).

Acima de quatro elas ficam encostadas de qualquer jeito, e a tela diz isso na
linha do marcador.

### O que a régua recusa

- marcador numa célula que **não existe** no desenho (sem chão, a peça não
  nasce — e o `CreateEntity` falha em silêncio);
- marcador na **chegada do alçapão** (`(0,0)` e `(0,1)`): é onde o jogador
  materializa, e o construtor as mantém livres.

O editor evita os dois sozinho: apagar uma célula leva o marcador junto, e
carregar outro traçado limpa a lista. A régua existe para o que chega por API,
por captura in-game ou de um acervo que mudou embaixo.

---

## 2. A caixa se escolhe por nome, e cada uma pode ter o seu loot

> *"Atualmente, a caixa é cadastrada pelo caminho completo. Adicionar um seletor
> com nome amigável e pesquisa. Também deve ser possível selecionar uma caixa
> específica e personalizar seu conteúdo, incluindo quantidade e chance de
> OZCoins."*

### O catálogo

`core/src/game/dungeon-prefabs.ts`: 29 caixas e 16 inimigos, **todos conferidos
um a um** contra o `Servers/server01/Bundles/AssetSceneManifest.json` (16.358
assets, 29 cenas). O painel espelha a lista, e
`panel/test/dungeon-crate-catalog.test.ts` cobra que os dois sejam idênticos.

As cinco que o pedido nomeia, e o que elas são de fato:

| nome na tela | prefab | observação |
|---|---|---|
| Caixa comum | `radtown/crate_normal_2.prefab` | **não** é `crate_normal` |
| Caixa militar | `radtown/crate_normal.prefab` | o nome do arquivo diz o contrário do que a peça é |
| Caixa de elite | `radtown/crate_elite.prefab` | |
| Caixa de munição | `radtown/underwater_labs/crate_ammunition.prefab` | mora no último lugar onde alguém procuraria |
| Caixa do Bradley | `npc/m2bradley/bradley_crate.prefab` | |
| Caixa personalizada | o que o admin colar | a lista é **oferta**, nunca trava |

Os dois primeiros são a razão principal de o seletor existir: ninguém acerta
`crate_normal` × `crate_normal_2` de cabeça, e errar não avisa ninguém — o
prefab é pulado com um aviso no console do servidor, que o admin não lê, e a
sala nasce vazia.

### As três camadas de loot

```
a tabela do SERVIDOR      o BetterLoot continua valendo     (mode: 'server')
   ↑
a tabela da COR           "toda caixa desta sala tem…"      (rooms[].table)
   ↑
a tabela da CAIXA         "mas a de elite tem…"             (crates[].table)
```

Caixa nova nasce com `table: null` — herda a da cor. Os três modos são os
mesmos: a do servidor, acrescentar, substituir.

### Por que `crates` continua sendo uma lista de strings no fio

**Medido.** Mandar toda caixa como `{"prefab":"…"}` custa 12 bytes cada, a
receita de fábrica tem nove, e o teste que cobra o orçamento do comando de RCON
mostrou o efeito: as **29 masmorras que cabiam nos 50 KB deixaram de caber**.

Então o payload leva `crates: ["assets/…"]` como sempre, e o conteúdo próprio
viaja à parte, em `crateContents`, só para as caixas que têm algum. Quem não usa
o campo novo não paga por ele — é o mesmo princípio de todo `lean*` do
`sync.ts`.

Consequência: a chave é o **prefab**, e o schema recusa prefab repetido na
lista. Duas regras para `crate_elite` não teriam resposta certa (o construtor
sorteia por prefab), e quantas caixas nascem é a faixa da sala — a lista é de
TIPOS.

### O OZCoin não é um item dentro da caixa

Ele é **saldo**. O caminho inteiro:

```
 painel        crates[].coins = { amount: {min,max}, chance }
   │
 plugin        RollCoins no NASCIMENTO da caixa  →  LootSpot.coins
   │           OnLootEntity (primeira abertura)  →  #OZDUNGEON#{"kind":"coins",…}
   │
 agente        DungeonSync.#payCoins  →  Wallet.credit  →  recibo no chat
```

Quatro decisões que valem registrar:

1. **o sorteio é no nascimento, não na abertura.** Assim o respawn re-sorteia
   (cada caixa nova é uma chance nova) e duas pessoas abrindo a mesma caixa não
   produzem dois prêmios;
2. **`spot.coins` é zerado antes do `Report`.** Dois jogadores no mesmo tique, ou
   um abrindo e fechando cinco vezes, produzem UM prêmio — como o loot, que
   também é de quem chega primeiro;
3. **quem avisa o jogador é o agente, depois do crédito.** Uma frase do plugin
   sairia na hora e mentiria toda vez que o site da carteira estivesse fora;
4. **a chave da idempotência é `slug:netID`,** e o agente a prefixa com
   `rust:<servidor>:dungeon:`. A linha repetida credita uma vez, porque a
   carteira responde `idempotent` sobre a mesma referência.

Se o agente subiu sem carteira, o prêmio **não** é pago e o log diz isso. Não
pagar em silêncio seria pior: o admin configuraria, o jogador abriria a caixa, e
nada aconteceria em lugar nenhum.

---

## 3. O código nunca fica atrás da própria porta

> *"Quando uma porta estiver trancada, o código necessário não pode nascer
> dentro da sala protegida por ela. O sistema deve validar a rota antes de
> construir a Dungeon."*

### O que já existia, e o que passava

O construtor já se recusava a pôr o papel **dentro** da sala que ele abre
(`TakeCodeNote`: `entry.cells.Contains(cell)`). Isso resolve o caso óbvio e
deixa passar o que acontece:

```
   sala VERMELHA (trancada)   ← o código dela cai aqui
        ║
   sala AZUL (trancada)       ← e para chegar lá é preciso abrir esta,
        ║                       cujo código caiu na vermelha
     entrada
```

Nenhuma das duas guarda o próprio código, e as duas ficam lacradas **para
sempre**. O servidor constrói, a contagem de peças fecha, o evento sobe — e o
jogador dá voltas procurando um papel que não existe do lado de fora.

### A régua: zona pública

O portador nasce numa célula que se alcança da entrada **sem abrir porta
trancada nenhuma** — nem a da sala dele, nem a de outra. É um BFS com as salas
trancadas como parede, e ele roda em três lugares, de propósito:

| onde | quando | o que faz |
|---|---|---|
| `panel/src/lib/dungeon-layout.ts` | enquanto o admin desenha | mostra a frase no passo das salas |
| `core/src/dungeons/lock-route.ts` | `POST /dungeons/:id/build` | **recusa** o comando, no modo `abort` |
| `PublicCells` no plugin | com a masmorra de pé | decide onde o papel entra |

É mais severo que a letra do pedido, e é escolha. A alternativa é a **cadeia** —
o código da vermelha pode morar na azul, desde que o da azul esteja na zona
pública. Ela funciona e exige que o construtor ORDENE as fechaduras na hora de
distribuir os papéis, sabendo de antemão onde cada peça vai nascer. Ele não
sabe: as peças nascem em ordem sorteada, e o papel vai para a primeira que
aparece.

E o jogador não vê a cadeia. Ele vê duas portas com código e procura os papéis.
*"Todo papel está na parte aberta"* se explica numa linha.

### Impedir ou destrancar

`lock.onUndelivered` ganhou um terceiro valor:

| valor | o que faz |
|---|---|
| `unlock` | destranca a sala e ergue (**o padrão**: uma masmorra com uma porta aberta ainda é jogável) |
| `keep` | ergue com a sala lacrada — para o evento em que o admin abre na mão |
| `abort` | **não ergue.** `failed: code_unreachable` |

`abort` não é o padrão porque ele é o único destrutivo para o evento: uma
masmorra que não nasce no horário é um evento perdido, e o desenho continua
errado do mesmo jeito.

---

## 4. O material do corredor

> *"Na seção O Corredor, adicionar seleção independente de material para piso,
> parede e teto."*

`corridor.grade`, com os mesmos cinco níveis das salas (palha, madeira, pedra,
metal, blindado). `null` = herda o `structure` da masmorra, que é o que o
corredor sempre fez.

Anulável, e não um `prefault({})`, porque *"não escolhi"* e *"escolhi pedra"*
precisam ser distinguíveis: com o prefault, trocar o `structure` da masmorra
para metal deixaria o corredor em pedra sem ninguém ter pedido. Pelo mesmo
motivo, o `sync` **não** corta este bloco por ele ser igual ao padrão do plugin
— é a mesma regra do `grade` da sala.

No plugin, o `GradeOf` passou a distinguir três casos: célula de sala (usa o
`grade` da cor), célula de corredor (usa `corridor.grade`) e célula fora do
layout — a entrada mínima, que continua no `structure`, porque a casinha não é
corredor.

**A parede entre corredor e sala tem dois donos, e vence o lado mais forte**
(`WallGradeOf`, que já existia). Uma sala blindada não ganha parede de madeira
por encostar num corredor de madeira: o invasor entraria pelo lado barato, e a
escolha do admin viraria decoração.

---

## 5. O que foi medido daqui

- `dotnet build` do `pluginlint` sobre o `OrigemZDungeon.cs`: **0 erros**
  (os 40 avisos `CS0649` são os campos preenchidos por desserialização, e já
  existiam);
- `core`: 2.222 testes, 106 arquivos. 25 novos em
  `core/test/dungeon-posicionamento.test.ts`;
- `panel`: 349 testes, 23 arquivos. 7 novos no espelho do catálogo;
- typecheck e lint limpos nos dois pacotes; `next build --webpack` completo;
- os 45 caminhos de prefab do catálogo, conferidos contra o
  `AssetSceneManifest.json` do server01 por script.

---

## 6. O que só o jogo prova

Nada abaixo aparece em typecheck, lint ou contagem de peças. É a lista do §4 do
`frentes/README.md` aplicada a esta entrega.

1. **a peça nasce onde foi marcada.** A conversão de célula para metro passa por
   `origin + right*x + forward*z`, e um sinal trocado põe a masmorra espelhada.
   Marque um inimigo à direita da entrada e confira que ele está à direita;
2. **quatro caixas num ponto cabem no ponto.** O anel do `SpotInRing` foi
   calculado (raio 0,45 m + 0,08 por peça, teto 1,05 m), não medido no jogo;
3. **o prêmio em OZCoin chega ao saldo.** O caminho inteiro só fecha com um
   jogador abrindo a caixa: o `OnLootEntity` dispara, a linha atravessa o
   console, a carteira credita e o chat fala. Confira também que a SEGUNDA
   abertura da mesma caixa não paga de novo;
4. **a caixa de munição existe naquele build.** Ela está no manifest, mas o
   prefab de `underwater_labs` é o único do catálogo que nunca nasceu nesta
   masmorra;
5. **o corredor de madeira com as salas blindadas.** É o caso que o §4 promete,
   e o que prova é bater com o martelo nas duas paredes;
6. **a sala que `abort` recusa.** Desenhe a masmorra do §3 (duas trancadas em
   fila), ponha "não construir" e confira que o painel recusa **antes** de
   mandar o comando — e que o plugin recusa também, quando o comando vem de
   dentro do jogo.
