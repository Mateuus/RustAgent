# 01 — O ORIGEMZDUNGEON: plano e contratos

> **Estado:** plano aprovado em 08/09/2026, construção não começou.
> **Base de partida:** `Docs/OrigemZDurgeon/DungeonBases-1.3.4.cs` — o
> *Dungeon Bases* 1.3.4, já com o gerador procedural que alguém enxertou.
> **Plantas que já temos:** `Docs/OrigemZDurgeon/Dungeons/*.json` — 7 arquivos,
> formato CopyPaste, de 42 a 584 peças.

---

## Índice

| § | Assunto |
|---|---|
| [0](#0--o-pedido-do-dono-e-as-quatro-decisões) | O pedido do dono, e as quatro decisões |
| [1](#1--o-que-a-base-ensina-e-as-seis-coisas-dela-que-não-servem) | O que a base ensina, e as seis coisas dela que não servem |
| [2](#2--o-nome-e-a-divisão-origemzevents--origemzdungeon) | O nome, e a divisão OrigemZEvents / OrigemZDungeon |
| [3](#3--o-modelo-que-sustenta-o-desenho-a-célula-de-3-metros) | O modelo que sustenta o desenho: a célula de 3 metros |
| [4](#4--os-dois-modos-de-autoria-receita-e-planta) | Os dois modos de autoria: receita e planta |
| [5](#5--o-acervo-de-plantas-o-json-sai-do-disco-e-vai-para-o-painel) | O acervo de plantas: o JSON sai do disco e vai para o painel |
| [6](#6--o-esquema-migrações-057-a-061) | O esquema: migrações 057 a 061 |
| [7](#7--o-contrato-agente--plugin) | O contrato agente ↔ plugin |
| [8](#8--o-comando-no-jogo-e-o-fluxo-de-construir-onde-eu-estou) | O comando no jogo, e o fluxo de "construir onde eu estou" |
| [9](#9--o-ciclo-de-vida-evento-e-permanente) | O ciclo de vida: evento e permanente |
| [10](#10--a-api) | A API |
| [11](#11--o-painel-as-telas) | O painel: as telas |
| [12](#12--a-ajuda-o-passo-a-passo-e-o--que-abre-modal) | A ajuda: o passo a passo e o (?) que abre modal |
| [13](#13--as-frentes-em-ordem-de-dependência) | As frentes, em ordem de dependência |
| [14](#14--como-validar-sem-quebrar-o-server01) | Como validar sem quebrar o server01 |
| [15](#15--o-que-fica-de-fora-e-por-quê) | O que fica de fora, e por quê |

---

## 0 — O pedido do dono, e as quatro decisões

### 0.1 O pedido

> "O nosso objetivo é criar o OrigemZDungeon, que será parte do OrigemZEvents.
> Vamos usar nossa base completa `DungeonBases.cs` — vamos atualizar e criar um
> novo através desse nosso. Objetivo: a criação e edição se completam pelo
> painel. Quando criar uma nova dungeon, o painel manda o comando para ele
> digitar lá no jogo, e ele constrói a dungeon estando no jogo, pelo painel."

Três frases, e cada uma decide uma coisa:

1. **`OrigemZDungeon` é plugin novo**, escrito a partir do *Dungeon Bases* — não
   um patch nele. O 1.3.4 é a fonte de peças, como o `Quests.cs` foi para o
   OrigemZQuests (ver `Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md` §2);
2. **o painel é a fonte da verdade.** Nenhuma dungeon nasce de um JSON de
   config editado à mão. O que existe está no banco do agente, e o plugin é
   quem executa;
3. **o jogo é onde se escolhe o lugar.** O painel não tem como saber que aquela
   encosta ali é bonita. Quem sabe é o admin de pé no mapa — então o painel
   produz um comando, e o comando carrega a dungeon inteira até onde ele está.

### 0.2 As quatro decisões, tomadas em 08/09/2026

| # | Pergunta | Escolha |
|---|---|---|
| 1 | O que o admin monta no painel? | **Receita *e* planta.** Dois modos, um construtor só |
| 2 | O que é o OrigemZEvents? | **Um guarda-chuva a desenhar agora.** A dungeon é o primeiro inquilino |
| 3 | O que fazer com o CopyPaste? | **Ler o formato nós mesmos.** Os JSONs viram acervo do painel |
| 4 | A dungeon nasce e morre? | **Evento *e* permanente.** Mesma dungeon, dois modos de vida |

A decisão 3 merece a frase do dono inteira, porque ela é mais forte que a opção
que eu ofereci: *"nós vamos ter o nosso sistema, pronto, o JSON lá — então os
JSONs irão ficar em nosso painel."* Não é só "não dependa do CopyPaste". É **o
arquivo sai do disco do servidor e vira linha no banco do agente**. Ver §5.

### 0.3 O que a medição do terreno encontrou antes de uma linha ser escrita

Sete coisas, todas verificadas nesta máquina em 08/09/2026:

1. **O CopyPaste não está instalado.** `Servers/server01/oxide/plugins/` tem 14
   plugins e nenhum deles é o CopyPaste. O *Dungeon Bases* chama
   `CopyPaste?.Call("TryPasteFromVector3", …)` com `?.` — ou seja, hoje, neste
   servidor, **a entrada simplesmente não é colada** e o evento morre no
   `"No hatch found"`. A decisão 3 não é preferência: é o que falta para o
   plugin funcionar aqui;
2. **as 7 plantas existem e são pequenas.** 42 a 584 entidades. A maior
   (`#dung#entrance1`) tem 584 peças e 512 KB de JSON — cabe em uma linha de
   banco sem cerimônia;
3. **o gerador procedural já está lá**, enxertado no 1.3.4: `Layout()`,
   `GenerateBaseInternal()`, `GenerateBaseAtByTier()` e quatro tiers
   (`easy`/`normal`/`hard`/`nightmare`) no `ConfigData`. É código que funciona e
   que a receita do painel vai comandar em vez de substituir;
4. **tudo é `EnableSaving(false)`.** Doze chamadas. Nada da dungeon entra no
   save do mundo — o que decide como o modo permanente tem de ser feito (§9.3);
5. **o painel não tem tooltip.** `panel/src/components/ui/` tem nove
   componentes e nenhum deles é um `(?)`. O `Info` do lucide aparece 19 vezes,
   sempre como enfeite de bloco, nunca clicável. O passo a passo que o dono
   pediu é peça nova do design system (§12);
6. **a última migração é a 56** (`wipe-run-cancel-requested`). As nossas são
   057 a 061;
7. **o painel já tem mapa clicável** (`panel/src/components/map-view.tsx`), com
   projeção correta de `x`/`z` e zoom. Ele já sabe desenhar um ponto no mundo —
   é onde a dungeon permanente vai aparecer, de graça.

---

## 1 — O que a base ensina, e as seis coisas dela que não servem

### 1.1 O truque que sustenta tudo: a dungeon mora a 90 metros abaixo do mundo

Esta é **a** ideia do *Dungeon Bases*, e ela é boa demais para ser trocada:

```
        superfície                    y ≈ 3
   ┌────────────────┐
   │    ENTRADA     │   uma casinha colada no mapa, com um alçapão
   └────────┬───────┘
            │  o alçapão não desce: ele TELEPORTA
            ▼
   ┌────────────────┐
   │    A DUNGEON   │   y = -90, longe de tudo, invisível do mapa
   └────────────────┘
```

`EventStartPos()` (linha 2360) põe a base em
`new Vector3(position.x, offsetY - 90, position.z)`. `InitHatch()` (linha 719)
pega os **dois** alçapões — o da entrada e o da dungeon —, descobre qual está
mais alto e emparelha os dois: descer por um te cospe no outro.

Por que isso é bom, e não gambiarra:

- **não colide com nada.** A -90 m não há terreno, monumento, metrô nem base de
  jogador. O gerador pode desenhar 30 salas sem consultar o mundo;
- **o mapa não muda.** Quem sobrevoa vê uma casinha, não um buraco;
- **fechar a dungeon é matar um alçapão.** Não há porta para trancar do lado de
  fora, não há muro para escalar. Quem está dentro fica dentro.

A única coisa que o modelo cobra é que **o par de alçapões tem de existir**, e é
por isso que o plugin fica 60 segundos girando um timer à espera de
`hatchPair.Count == 2` antes de declarar o evento no ar. Herdamos isso.

### 1.2 O gerador procedural, e o modelo de células

`Layout(int target)` (linha 3825) devolve quatro coisas, e elas são o vocabulário
inteiro do sistema:

| Nome | Tipo | O que é |
|---|---|---|
| `cells` | `HashSet<(int,int)>` | quais quadrados do grid existem |
| `owner` | `Dictionary<(int,int), int>` | de quem é cada quadrado: `-1` = corredor, `0..n` = sala *n* |
| `doors` | `List<((int,int),(int,int))>` | os pares (célula-da-sala, célula-do-corredor) onde há porta |
| `corrPairs` | `List<((int,int),(int,int))>` | a espinha do corredor, que tem **duas** células de largura |

E o desenho vira mundo por três regras de três linhas cada:

- **uma célula = uma fundação**, e o passo do grid é 3 m
  (`origin + right * (x * 3) + fwd * (z * 3)`);
- **entre duas células vizinhas há parede**, a menos que as duas sejam da mesma
  sala — aí a parede morre e as duas viram um cômodo só;
- **na fronteira sala↔corredor a parede vira porta** quando o par está em
  `doors`.

**Isto é exatamente um editor de grid.** O painel não precisa inventar formato:
ele desenha `cells` + `owner` + `doors` e manda. Ver §4.2.

### 1.3 As seis coisas do 1.3.4 que não vêm

1. **O `ConfigData` de 160 propriedades.** Ele é o painel do plugin, e nós temos
   um painel de verdade. Fica só o mínimo operacional (§7.4);
2. **`dungbase_start` com args posicionais adivinhados.** O comando de hoje
   tenta parsear `float` em cada argumento para descobrir se você mandou
   coordenada, nome de entrada, nome de base ou `procedural_hard` — e falha
   calado. O nosso comando tem um argumento: o slug (§8);
3. **a dependência de CopyPaste** (decisão 3);
4. **as mensagens em inglês e russo** hardcoded no `LoadDefaultMessages`. As
   nossas saem do painel, em pt-BR, como todo o resto do OrigemZ;
5. **o `[AutoPatch]` de Harmony no `ScientistNPC.displayName`.** Ele existe para
   dar nome ao NPC e faz isso patcheando o getter do jogo com uma sentinela
   (`"#Scientist1818"`). É frágil a cada update do Rust. O `OrigemZAgent` já
   nomeia NPC por outro caminho — reusamos o dele;
6. **`Configuration.blacklistedZones` gravado pelo comando `dungbase_addblack`.**
   Zona proibida é dado do painel, com nome e raio, e desenhada no mapa (§11.4).

O que **vem**, e vem quase inteiro: `Layout`, `GenerateBaseInternal`,
`InitHatch`, `ReplaceHatch`, `ReplaceDoor`, `ReplaceFuseBox`, `ReplaceCardReader`,
`SetupTurret`, `InitNPC`, `ConnectIO`, `LinkCode` e o desenho de radiação/fecho
do fim do evento. São ~2.000 linhas de código que já funciona.

---

## 2 — O nome, e a divisão OrigemZEvents / OrigemZDungeon

### 2.1 Uma observação sobre a grafia

A pasta se chama `OrigemZDurgeon` e o dono escreveu assim duas vezes. **"Durgeon"
não é palavra em inglês** — é *dungeon*. A regra do dono
(`~/.claude/rules/codigo-em-ingles.md`) manda todo identificador em inglês, e o
nome do plugin é o identificador mais permanente que existe: ele vira nome de
arquivo, nome de classe, prefixo de comando de console, chave de config e nome de
permissão.

Este documento usa **`OrigemZDungeon`**. Trocar é um `sed` enquanto nada foi
escrito; depois de o plugin estar no ar em três servidores, é migração. A pasta
`Docs/OrigemZDurgeon/` fica como está — renomear pasta de doc quebra link.

### 2.2 O guarda-chuva, e o que mora nele

`OrigemZEvents` é a camada comum a **todo** evento do servidor. A dungeon é o
primeiro inquilino; o segundo — convoy, cargo, raid base, o que for — não pode
reescrever agenda, marcador e anúncio de novo.

O que é do **Events** (vale para qualquer evento):

| Assunto | O que ele resolve |
|---|---|
| Agenda | de quanto em quanto tempo, janela mínima/máxima, mínimo de gente online |
| Exclusão | dois eventos não nascem juntos; um evento não nasce durante o wipe |
| Marcador | o círculo no mapa, cor, raio, nome, contagem regressiva |
| Anúncio | o que o servidor fala ao começar, ao faltar N minutos, ao acabar |
| Dono e time | quem pegou o evento, se o time entra junto, o que acontece se ele sai |
| Zona proibida | onde nenhum evento nasce (perto de base de jogador, monumento…) |
| Auditoria | nasceu quando, onde, quem entrou, quem levou, morreu como |

O que é da **Dungeon** (só dela):

geometria, salas, corredores, alçapão, NPC dentro de sala, loot de sala,
radiação de fim, o par de alçapões, o teleporte.

### 2.3 E isso é um plugin ou dois?

**Dois arquivos, um deles com API.** `OrigemZEvents.cs` é o dono da agenda e do
marcador e expõe hooks; `OrigemZDungeon.cs` se registra nele:

```csharp
// OrigemZDungeon.cs
[PluginReference] Plugin OrigemZEvents;

void OnServerInitialized()
{
    OrigemZEvents?.Call("RegisterEvent", "dungeon", this);
}

// chamado pelo Events quando a agenda dele decidiu que é a hora
object OnEventStart(string eventId, Vector3 position) { … }
object OnEventStop(string eventId, string reason) { … }
```

A alternativa — um arquivo só — economiza um `[PluginReference]` hoje e cobra o
preço no segundo evento, que é o momento em que ninguém quer pagar. É a mesma
razão pela qual `OrigemZItems` não mora dentro do `OrigemZAgent`.

**Ordem de construção:** o Events nasce **magro**, com o que a dungeon usa e nada
mais. Guarda-chuva desenhado para eventos imaginários é o jeito clássico de
errar a forma.

---

## 3 — O modelo que sustenta o desenho: a célula de 3 metros

Tudo neste sistema — o editor do painel, o JSON no banco, o gerador no jogo — fala
a mesma língua: **o grid de células de 3 metros**, de `Layout()`.

```
    z
    ▲
  3 │  .  .  ┌──────┐  .          . = vazio
    │        │  A   │             ▓ = corredor
  2 │  .  ▓  │  A   │  .          A,B = salas (letra = id)
    │        └──╥───┘
  1 │  .  ▓  ▓  ▓  ▓  ▓           ╥ = porta (fronteira sala↔corredor)
    │     ║
  0 │  E  ▓  .  ┌───┐  .          E = entrada (célula 0,0, sempre)
    │           │ B │
 -1 │  .  ▓  .  └───┘  .
    └───────────────────────► x
      0  1  2  3  4  5
```

Três invariantes que valem em todo lugar do sistema:

1. **a célula `(0,0)` é o lobby da entrada.** É onde o alçapão de descida cai. O
   `Layout()` já reserva ela e a `(0,1)` (`if ((cc.Item1 == 0 && cc.Item2 == 0) …
   continue`), e a planta do painel também reserva;
2. **corredor tem 2 células de largura.** `corrPairs` é uma lista de *pares*, não
   de células. Um corredor de 1 célula parece certo no editor e vira um cano
   claustrofóbico no jogo — a base já aprendeu isso;
3. **sala é um retângulo.** `RoomTypes` no 1.3.4 são `1×2, 2×2, 3×1, 3×2, 3×3`.
   A planta do painel permite qualquer retângulo até 6×6; o que não permite é
   sala em L, porque a regra "parede morre entre células da mesma sala" produz
   geometria válida só para retângulos.

E a **cor da sala** (verde / azul / vermelha) não é decoração: ela é o *tier de
conteúdo* daquela sala — quantos NPCs, que loot, que porta. No 1.3.4 isso vem do
`DifficultyConfig`; aqui vem do painel, por sala ou por receita.

---

## 4 — Os dois modos de autoria: receita e planta

O dono escolheu os dois. Eles não são dois sistemas: são **duas maneiras de
produzir a mesma estrutura** (`cells` + `owner` + `doors`), e daí para baixo o
código é um só.

```
   RECEITA                          PLANTA
   (parâmetros)                     (grid desenhado)
        │                                 │
        │  Layout(count) no jogo          │  vem pronta do painel
        ▼                                 ▼
   ┌─────────────────────────────────────────────┐
   │   cells + owner + doors + corrPairs         │   ← a estrutura
   └─────────────────────────────────────────────┘
                        │
                        ▼
   ┌─────────────────────────────────────────────┐
   │   GenerateBaseInternal(): funda, ergue,      │   ← o construtor,
   │   abre portas, tranca, popula, ilumina       │      um só
   └─────────────────────────────────────────────┘
```

### 4.1 A receita

É o que o 1.3.4 já faz, com os parâmetros saindo do painel em vez do JSON de
config. Cada nascimento sorteia um layout novo.

```jsonc
{
  "mode": "recipe",
  "size": { "min": 12, "max": 18 },          // salas, não células
  "rooms": {
    "green":  { "weight": 50, "npc": [0,1], "loot": [1,1], "crates": ["crate_normal","crate_normal_2"] },
    "blue":   { "weight": 35, "npc": [1,2], "loot": [1,2], "crates": ["crate_normal"] },
    "red":    { "weight": 15, "npc": [3,5], "loot": [2,3], "crates": ["crate_normal","crate_elite"] }
  },
  "corridor": { "npcDensity": 20, "lootDensity": 10, "crates": ["crate_tools","crate_basic"] },
  "npc": { "health": [120,180], "damageScale": 1.5, "weapons": ["rifle.ak","rifle.lr300","shotgun.spas12"] }
}
```

Os quatro tiers do 1.3.4 (`easy`/`normal`/`hard`/`nightmare`) entram como
**receitas de fábrica**, criadas pela migração 057. O admin duplica e mexe.

### 4.2 A planta

O grid desenhado, célula a célula. É o modo de "quero uma sala assim, aqui".

```jsonc
{
  "mode": "blueprint",
  // Uma string por linha de z, do MAIOR para o menor — a ordem em
  // que um mapa é lido, com o norte em cima. Um caractere por
  // célula: '.' vazio, '#' corredor, 'E' entrada, e G/B/R para a
  // COR da sala.
  //
  // ####  A LETRA É A COR, E NÃO O NÚMERO DA SALA  ####
  //
  // MEDIDO em 09/09/2026: com uma letra por sala (A, B, C…), a cor
  // se perdia — o formato não a carregava, e todo desenho reaberto
  // ou sorteado voltava inteiro em verde.
  //
  // Quem separa "duas salas vermelhas" de "uma vermelha grande"
  // continua sendo o preenchimento por vizinhança, no construtor.
  // O arquivo guarda o que o admin PINTOU; o agrupamento é
  // derivado, e derivado não se guarda.
  "grid": [
    "..GGG.....",
    "..GGG.####",
    ".###....#.",
    "E#..RR..#.",
    ".#..RR..#."
  ],
  "rooms": {
    "A": { "color": "red",   "npc": 4, "crates": ["crate_elite"], "door": "toptier" },
    "B": { "color": "green", "npc": 0, "crates": ["crate_normal"], "door": "wood" }
  },
  "doors": [ { "room": "A", "at": [3,4] }, { "room": "B", "at": [4,0] } ]
}
```

**Por que grid de texto e não lista de objetos:** uma dungeon de 20×20 tem 400
células. Como lista de `{x,z,kind}` são 400 objetos e ~20 KB; como 20 strings de
20 caracteres são 400 bytes, e um humano abre o JSON e **vê a dungeon**. O custo
é um parse de 6 linhas nas duas pontas.

**Validação, e onde ela mora:** as regras moram em `core/src/dungeons/layout.ts`
(`checkLayout`), e o painel tem o porte fiel delas em `lib/dungeon-layout.ts`. O
plugin **também** valida ao receber — não por desconfiança, mas porque um `.cs`
que assume grid válido explode com `NullReferenceException` no meio da construção
e deixa meia dungeon de pé.

São seis defeitos, e **nenhum deles dá erro no jogo** — é essa a razão de o
verificador existir. O servidor constrói o que foi mandado e não reclama de nada:

| o defeito | o que o jogador vê |
|---|---|
| sala que não encosta em corredor | um cômodo perfeito em que ninguém entra |
| entrada ilhada | ele desce o alçapão e cai num quadrado fechado — o evento acaba ali |
| corredor que não chega à entrada | um pedaço da dungeon que nunca é visitado |
| sala de 1 célula com corredor em 3 lados | um cômodo sem parede |
| célula solta | um bloco flutuando no meio do nada |
| sem `E`, ou com dois | o alçapão não tem onde cuspir, ou cospe em um só |

### 4.2.1 O acervo de traçados — o desenho vira objeto (09/09/2026)

Pedido do dono, verbatim: *"nós temos plantas então ao criar masmorra pode criar
planta prontas e outra coisa planta desenhada pode virar uma planta pronta.
outra coisa em plantas podemos ver o desenho da dungeon"*.

O problema que ele apontou: um desenho de vinte minutos morava na coluna `grid`
de **uma** masmorra. Servia àquela e a mais nenhuma, e a segunda começava do grid
em branco outra vez.

A partir daqui o traçado é um objeto por si — tabela `dungeon_layouts` (migração
061), acervo próprio, rotas `/dungeon-layouts`. E o ciclo fecha:

```
  planta pronta  ->  carrega no editor  ->  edita  ->  salva como planta
        ^                                                      |
        +------------------------------------------------------+
```

Três decisões que este acervo carrega:

1. **Carregar COPIA, não referencia.** O traçado escolhido vira o `grid` daquela
   masmorra. Referenciar faria uma edição no acervo mudar, sem aviso, uma
   masmorra que já está no ar — e apagar do acervo quebraria as que partiram
   dali. Por isso `DELETE /dungeon-layouts/:id` **não** tem a trava
   `BLUEPRINT_IN_USE` que a planta de entrada tem.

2. **Um traçado com defeito é GRAVADO, e marcado.** É o oposto da regra do
   `no_hatch`, e a diferença é o que cada coisa é: uma planta de entrada sem
   alçapão está pronta e não funciona; um traçado é rascunho por definição, e
   recusar o de quem ia consertar a sala depois do almoço perderia o trabalho
   dele. `problem_count` é coluna, o selo aparece na grade e as frases aparecem
   ao abrir.

3. **A lista TRAZ o desenho** — o inverso da regra do acervo de plantas, e pela
   mesma razão que a criou. Lá o `content` tem meio megabyte e nunca entra na
   listagem; aqui o desenho inteiro tem algumas centenas de bytes, e é dele que
   a **miniatura** vive. Uma lista de traçados sem os traçados seria uma lista
   de nomes, e escolher pela forma é justamente o que ela existe para permitir.

**Os dois acervos não se misturam.** Uma `dungeon_blueprints` guarda peças com
posição, que o plugin **cola**; um `dungeon_layouts` guarda células, que o plugin
**constrói**. Na mesma tabela, o materializador escreveria um desenho no disco
como se fosse planta de colar, e o CopyPaste não saberia ler o arquivo. Na tela
eles aparecem juntos, em duas seções da aba Plantas, porque para quem usa os dois
são "plantas".

**Quatro traçados de fábrica** vêm no produto — corredor reto, cruz, espinha,
serpente —, e eles moram em `types/dungeon-layouts.ts` e não em `Assets/`: são
quarenta linhas de texto, não megabytes. Os quatro passam limpos no verificador,
e o teste cobra isso: um traçado de fábrica com defeito seria o pior lugar
possível para um, porque é o que o admin copia achando que é o certo.

### 4.2.2 O construtor lê o desenho — medido no jogo em 09/09/2026

Até aqui o modo planta **só existia no painel**. O admin desenhava, via a
prévia, salvava — e o jogo sorteava um traçado qualquer assim mesmo, porque
`GenerateRooms` só sabia chamar `BuildLayout`. O `spec.grid` chegava ao plugin
e não era lido por ninguém.

`LayoutFromGrid` fecha isso, e três decisões dele merecem registro:

1. **A translação é pelo `E`, e não pelo canto.** A `(0,0)` é a origem da
   masmorra: o ponto que o alçapão conhece, e para onde ele teleporta quem
   desce. O desenho chega com o `E` em qualquer lugar das linhas — ele foi
   recortado pelo editor. Alinhar pelo canto poria a chegada dentro de uma
   sala, ou no vazio.

2. **Toda adjacência sala↔corredor vira porta**, e não uma por sala como no
   sorteio. É o que o editor promete ao admin enquanto ele desenha, e é o que a
   verificação dele assume quando avisa que um cômodo de uma célula com corredor
   em três lados nasce sem parede.

3. **A cor vem do desenho e entra no cache de `RoomColor` antes dos pesos.** Um
   admin que pintou a sala de vermelho não quer que os pesos da receita a
   repintem de verde.

**A medição, no server01:**

| desenho | células | peças no jogo |
|---|---|---|
| cruz | 40 | 219 |
| corredor reto | 34 | 192 |

A diferença medida — 27 peças — é **exatamente** a que a geometria prevê
(40×2+78+14 contra 34×2+67+10). E duas construções do mesmo desenho deram 219
as duas vezes: o modo planta sai igual, que é o que ele promete.

### 4.2.3 A entrada mínima existia no painel e não no jogo

O painel oferece *"Entrada mínima — gerada por código: uma laje, um alçapão e
uma luz"* como a opção **padrão**, e escolhê-la produzia `blueprint_missing` no
jogo: sem `spec.entrance`, o plugin caía de volta para "procure uma planta com o
nome da masmorra", que ninguém tinha. **Quem aceitasse o padrão via a masmorra
falhar** — o caminho mais provável de todos.

`BuildMinimalEntrance` a constrói. A laje fica **enterrada** a um andar, e o vão
no teto dela nasce rente ao terreno: uma boca de esgoto. Uma fundação apoiada na
superfície poria o alçapão a um metro do chão, e o jogador teria de pular para
alcançá-lo.

Medido: 151 peças com a entrada mínima contra 192 com a `entrance2` (42 peças),
para o mesmo desenho.

### 4.2.4 Três defeitos que só um jogador dentro do jogo encontra

Em 09/09/2026 o dono entrou na masmorra pela primeira vez. Os três defeitos
abaixo apareceram nos primeiros dez minutos, e **nenhum deles aparece contando
peças**: a masmorra sobe, o número fecha, e o problema só existe para quem está
lá dentro.

**1. O corredor era uma fileira de cubículos lacrados.** A regra da parede dizia
"não erga se os dois lados são a mesma sala" — e terminava em `&& mine >= 0`. O
corredor tem dono `-1`, então o teste nunca passava para ele: nascia parede
entre **cada par** de células de corredor. Quem descia o alçapão caía dentro de
um cubo de 3×3 metros sem saída.

A correção é tirar o `>= 0`: dono igual dos dois lados quer dizer "não há
parede", e isso vale para sala com sala **e** corredor com corredor. Medido: a
cruz caiu de 219 para 191 peças, e 28 é exatamente o número de paredes
corredor-corredor que a geometria previa.

**2. O alçapão cuspia dentro da parede.** O destino da descida era
`down * 2 - forward * 1.5`, e uma célula tem 3 metros — um metro e meio a partir
do centro é a linha da parede. O log foi direto ao ponto:

```
Mateuus was killed by Suicide at (-1271.00, -89.12, 962.50)
```

com a origem em `z=964`. A célula (0,0) é a única que pode não ter vizinha atrás
— o corredor sai dela para a frente —, então o desvio apontava para a parede em
toda masmorra desenhada. Agora a chegada é o **centro** da célula, e a subida
devolve o jogador **sobre** a tampa em vez de ao lado dela.

**3. Construir na água era aceito.** `GroundAt` devolve o fundo do mar como se
fosse chão; o comentário dele já dizia isso e delegava a escolha a "quem vê o
mapa". Com coordenada explícita — que é como o painel constrói — não há ninguém
vendo mapa nenhum.

Medido em (-1330, 871): chão em y=6.9, água em y=9.2, **2,3 m de profundidade**.
Era um rio, e rios ficam acima do nível do mar, então o `y` positivo não
denunciava nada. `no_position` já era um dos oito motivos de falha do plano, com
"água" na descrição: existia no documento e não no código.

De quebra nasceu o `ozdungeon onde <x> <z>`, que responde antes de construir:

```
E7 (-1330, 871) · chão y=6.9 · água y=9.2 · profundidade 2.3 m · NÃO SERVE: é água
```

É o que o painel precisa para não mandar ninguém a um ponto que ele nunca viu.

### 4.3 O terceiro modo, que sai de graça: capturar

Não estava nas quatro decisões, mas cai no colo: se sabemos **ler** o formato
CopyPaste (§5), sabemos **escrever**. Então:

```
/ozdungeon capturar bunker-vermelho 40
```

lê tudo num raio de 40 m em volta do admin, monta o JSON e manda para o painel.
É como as 7 plantas existentes viraram arquivo, e é o caminho de quem prefere
construir com o martelo a desenhar num grid.

Ele entra na **frente F**, depois que tudo funciona — mas o formato já nasce
preparado para ele.

---

## 5 — O acervo de plantas: o JSON sai do disco e vai para o painel

A decisão 3, na frase do dono: *"nós vamos ter o nosso sistema, pronto, o JSON lá
— então os JSONs irão ficar em nosso painel."*

### 5.1 O que muda de lugar

| Hoje | Depois |
|---|---|
| `oxide/data/copypaste/#dung#base2.json` no disco de cada servidor | uma linha em `dungeon_blueprints`, no banco do agente |
| copiado à mão de servidor para servidor | o painel escolhe em quais servidores vale |
| o CopyPaste lê e cola | o `OrigemZDungeon` recebe pelo console e cola |
| editar = abrir o JSON no bloco de notas | editar = a tela do painel |

### 5.2 O formato, que já conhecemos

As 7 plantas são CopyPaste puro, e ele é simples:

```jsonc
{
  "default":  { "position": {"x","y","z"}, "rotationy": "317.45", "rotationdiff": "0.15" },
  "protocol": { … },
  "entities": [
    { "prefabname": "assets/prefabs/building core/floor/floor.prefab",
      "pos":  {"x":"-0.24","y":"2.90","z":"2.19"},     // relativo ao centro
      "rot":  {"x":"…","y":"5.38","z":"…"},            // euler
      "grade": 3, "skinid": 0, "ownerid": 765…,
      "flags": { "Reserved2": true },
      "items": [ { "id": 69511070, "amount": 368, "position": 0, … } ] }
  ]
}
```

Números como **string** (é o CopyPaste que faz isso), posição **relativa** ao
centro do paste, e uma rotação global no `default`. Nada disso é difícil — é
`float.Parse` com `CultureInfo.InvariantCulture` e uma multiplicação de
quaternion.

### 5.3 O nosso leitor, e as sete armadilhas que ele tem de conhecer

`OrigemZDungeon.cs` ganha um leitor de ~250 linhas. As cinco primeiras
armadilhas estão visíveis no que o 1.3.4 faz **depois** do paste do CopyPaste,
em `BaseInit()` (linha 1466); as duas últimas só apareceram **medindo as sete
plantas**, em 08/09/2026, e cada uma delas produziria uma masmorra que sobe
bonita e não funciona:

1. **`InvariantCulture` obrigatório.** `"3.515838"` num Windows pt-BR sem
   invariante vira `3515838`. A dungeon nasce a 3,5 milhões de metros de altura;
2. **grade e estabilidade.** `BuildingBlock` precisa de `blockDefinition`,
   `SetGrade`, `AttachToBuilding` e `buildingID` **antes** do `Spawn()`, ou o
   prédio despenca por instabilidade — é o que `InitBlock()` (linha 3810) faz;
3. **`EnableSaving(false)` em tudo.** Ver §9.3;
4. **a ordem importa.** Fundação antes de parede, parede antes de porta, porta
   antes de fechadura. O 1.3.4 resolve isso com `NextTick()` entre as fases; nós
   fazemos igual, mais um `yield` a cada 25 entidades para não travar o tick com
   584 peças;
5. **containers com `items`.** O `StorageContainer` precisa existir e ter
   inventário inicializado antes de receber item. E o item cujo `id` não existe
   mais (Rust remove itens) tem de ser **pulado com aviso**, nunca `null` no
   inventário;

6. **existe um `children[]`, e ele é fácil de não ver.** A fechadura de uma
   porta NÃO está em `entities`: está em `children` da porta, com
   `parentbone: "lock"` e o `code` dentro. Um leitor que só percorra `entities`
   cola portas sem fechadura e alçapões sem código — e nada no arquivo denuncia
   a falta. Foi assim que a primeira versão do leitor passou;

7. **o alçapão é marcado por convenção, e são DUAS.** A planta não tem campo
   "aqui vai o alçapão". Ela marca o lugar com uma peça combinada:

   | Marca | Onde | O que é |
   |---|---|---|
   | `floor.ladder.hatch` + fechadura de código `0707` | `base2`, `base3`, `base4` | o alçapão da masmorra |
   | `planter.large` com fertilizante 1 no slot 0 e 999 no slot 5 | `entrance2`, `entrance3`, `entrance4` | o alçapão da entrada |

   A segunda parece arbitrária e não é: um alçapão de verdade na planta seria
   colado como alçapão comum, e o construtor teria de adivinhar qual dos vários
   é *o* alçapão. Um vaso com 999 fertilizantes não acontece por acaso.

   **Um leitor que só conheça a primeira convenção falha com `no_hatch` em
   três das quatro entradas herdadas** — e falha 60 segundos depois de o
   jogador ver a casinha de pé.

   **Cada planta tem exatamente UMA marca** — medido nas sete. E isso não é
   sorte: a `entrance1` tem *dois* alçapões e *seis* vasos, e só um deles
   carrega a marca. A convenção é precisa de propósito; se qualquer alçapão
   servisse, o construtor teria de adivinhar qual é a porta de entrada.

   Ainda assim, o par não é "os dois mais distantes em `y`", e sim **um campo
   para cada**: o de cima vem da planta, o de baixo é sempre o que nós erguemos
   no teto do lobby. O desempate por altura fica como defesa para uma planta
   futura com duas marcas;

8. **a marca do alçapão MORRE antes de você usá-la.** Guardar a `BaseEntity` da
   marca e convertê-la depois funciona para o vaso e **falha para o hatch**: um
   `floor.ladder.hatch` colado solto precisa de um vão para se encaixar, e a
   planta traz o vão como outra peça, que nasce depois. O jogo o destrói em
   algum tick no meio das 226 — e `ConvertToHatch` cai no `IsDestroyed` e sai
   calado.

   O sintoma é perverso: o log dizia **"1 marca de alçapão"** e nenhum alçapão
   nascia. As três `entrance*` funcionavam (vaso é *deployable*, fica de pé em
   qualquer lugar) e as três `base*` não.

   A correção é guardar a **pose** — posição, rotação e que tipo de marca era —
   no instante da colagem, e nunca a entidade. A tampa nasce onde a marca
   esteve, tenha ela sobrevivido ou não;

9. **uma peça que estoura não pode derrubar a planta.** A `entrance4` traz um
   carro modular de três módulos, um sofá com assentos e um armário. Com o
   `try/catch` em volta do lote, **uma** delas matava as 114 e a planta inteira
   voltava como `blueprint_invalid` — com 113 peças perfeitamente boas junto.

   O `try/catch` é **por peça**. Uma planta é um monte de peças independentes:
   a que não sobe é uma cadeira que faltou, não uma masmorra perdida. E veículo
   é pulado de propósito — carro só existe montado, e um carro a 90 metros de
   profundidade não ia a lugar nenhum.

### 5.4 O tamanho, e o transporte — que não é o RCON

584 entidades = 512 KB de JSON. Isso **não** atravessa o console do RCON, e não
chega perto: o teto medido do frame é ~70 KB, o `plugin-push.ts` já corta em
50 KB, e `ui-images.ts` corta imagem em 45.000 caracteres de base64 (~33 KB).
Não existe chunking em lugar nenhum do projeto, e inventá-lo aqui seria
construir a peça mais frágil do sistema para um problema que não precisa dela.

**A planta não viaja pelo console. Ela viaja pelo disco.**

O agente e os servidores de Rust rodam **na mesma máquina** — é a premissa do
projeto inteiro (`Docs/README.md`) — e o agente já escreve em `oxide/data/` por
um módulo com dono: `core/src/oxide/data-files.ts`, com trava de `..`, backup
antes de toda escrita e caminho calculado por `pluginDataPath()`.

```
   painel ──PUT──► agente ──grava linha──► dungeon_blueprints  (a verdade)
                      │
                      └──materializa──► Servers/<id>/oxide/data/
                                          OrigemZDungeon/blueprints/<slug>.json
                                                    ▲
   jogo ── /ozdungeon build bunker ──► OrigemZDungeon ┘  (lê do próprio disco)
```

Três consequências que valem escrever:

1. **o banco é a verdade, o arquivo é a cópia de trabalho.** Salvar no painel
   grava a linha e reescreve o arquivo nos servidores onde aquela dungeon vale.
   Um arquivo apagado à mão volta no próximo save ou no boot;
2. **o comando leva o slug, nunca o conteúdo.** `/ozdungeon build bunker` tem
   26 bytes, e o mesmo comando funciona para uma planta de 42 peças e para uma
   de 5.000;
3. **`Backups/<id>/oxide-data/` já cobre o desfazer**, porque
   `backupPluginDataFile()` roda antes de toda escrita. Não precisamos de
   histórico de versões da planta na frente A.

O RCON continua sendo o caminho de **tudo que é pequeno**: mandar construir,
mandar parar, avisar que a config mudou, receber o "terminei". Ver §7.

---

## 6 — O esquema: migrações 057 a 061

A última migração hoje é a **56** (`wipe-run-cancel-requested`). Quatro
migrações novas, e a divisão delas segue a do OrigemZQuests: uma por assunto,
para que uma delas poder ser adiada não trave as outras.

| # | Nome | O que nasce |
|---|---|---|
| 057 | `events-core` | `events`, `event_servers`, `event_zones` — o guarda-chuva |
| 058 | `dungeons-core` | `dungeons`, `dungeon_rooms` — a receita e a planta |
| 059 | `dungeons-blueprints` | `dungeon_blueprints` — as plantas capturadas/importadas |
| 060 | `event_runs` | `event_runs`, `event_run_players` — o que aconteceu |

### 6.1 `events` — o evento, do ponto de vista da agenda

Um evento é "uma coisa que nasce no mundo, dura, e some". A dungeon é `kind =
'dungeon'`; o próximo é outro `kind`.

```sql
CREATE TABLE events (
  -- Slug. É o que o comando de console leva e o que a URL guarda.
  id TEXT PRIMARY KEY,

  -- 'dungeon' hoje. É TEXTO LIVRE, como quests.category: um
  -- evento novo não pode ser uma migração.
  kind TEXT NOT NULL DEFAULT 'dungeon',

  name TEXT NOT NULL,
  description TEXT,

  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,

  -- ####  COMO ELE NASCE  ####
  --   'schedule'  — o agendador sorteia, dentro da janela
  --   'manual'    — só por comando/botão do painel
  --   'permanent' — plantado à mão e fica até o wipe (§9.3)
  spawn_mode TEXT NOT NULL DEFAULT 'schedule'
    CHECK (spawn_mode IN ('schedule','manual','permanent')),

  -- A janela do sorteio, em segundos. Herda o desenho do 1.3.4:
  -- sorteia um número entre os dois e conta.
  interval_min INTEGER NOT NULL DEFAULT 3600,
  interval_max INTEGER NOT NULL DEFAULT 7200,

  -- Quanto ele dura depois de no ar, em segundos. Ignorado quando
  -- spawn_mode = 'permanent'.
  duration_min INTEGER NOT NULL DEFAULT 2000,
  duration_max INTEGER NOT NULL DEFAULT 3000,

  -- Abaixo disso o agendador ADIA em vez de nascer. Evento para
  -- ninguém é loot de graça para o primeiro que logar.
  min_online INTEGER NOT NULL DEFAULT 1,

  -- 1 = a próxima contagem só começa quando este acabar. É o
  -- 'afterTime' do 1.3.4.
  count_after_end INTEGER NOT NULL DEFAULT 0 CHECK (count_after_end IN (0,1)),

  -- ####  QUEM ENTRA  ####
  --   'anyone'  — qualquer um
  --   'owner'   — só quem chegou primeiro
  --   'team'    — o dono e o time dele
  access TEXT NOT NULL DEFAULT 'team' CHECK (access IN ('anyone','owner','team')),

  -- Segundos que o dono pode ficar deslogado antes de perder a
  -- posse. 1.3.4 usa 300.
  owner_grace_seconds INTEGER NOT NULL DEFAULT 300,

  -- ####  O MARCADOR  ####
  marker_enabled INTEGER NOT NULL DEFAULT 1 CHECK (marker_enabled IN (0,1)),
  marker_label TEXT NOT NULL DEFAULT 'Dungeon',
  marker_color TEXT NOT NULL DEFAULT '#ff0000',
  marker_alpha REAL NOT NULL DEFAULT 0.55,
  marker_radius REAL NOT NULL DEFAULT 0.5,
  marker_show_owner INTEGER NOT NULL DEFAULT 1 CHECK (marker_show_owner IN (0,1)),
  marker_show_time INTEGER NOT NULL DEFAULT 1 CHECK (marker_show_time IN (0,1)),

  -- ####  O QUE ELE FALA  ####
  --
  -- NULL = usa a frase padrão do agente. Aceita a marcação de chat
  -- do projeto (game/chat-markup.ts), como as mensagens.
  msg_start TEXT,
  msg_location TEXT,
  msg_warning TEXT,
  msg_end TEXT,
  msg_denied TEXT,

  -- Segundos ANTES do fim em que cada coisa acontece.
  warn_before INTEGER NOT NULL DEFAULT 300,
  radiation_before INTEGER NOT NULL DEFAULT 180,
  -- Segundos DEPOIS do fim até a entrada ser destruída.
  destroy_after INTEGER NOT NULL DEFAULT 60,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**`event_servers`** é `(event_id, server_id)`, igual a `quest_servers`: o evento
é da rede, e cada servidor liga o que quiser. **`event_zones`** guarda as zonas
proibidas — `(server_id, x, z, radius, label)` — que hoje são um `Vector3` numa
lista de config onde o `y` foi sequestrado para guardar o raio.

### 6.2 `dungeons` — a receita e a planta

```sql
CREATE TABLE dungeons (
  id TEXT PRIMARY KEY,                       -- slug: 'bunker-vermelho'
  name TEXT NOT NULL,
  description TEXT,

  -- ####  O MODO DE AUTORIA  ####  (§4)
  --   'recipe'    — parâmetros; o jogo sorteia o layout
  --   'blueprint' — grid desenhado; sai sempre igual
  mode TEXT NOT NULL DEFAULT 'recipe' CHECK (mode IN ('recipe','blueprint')),

  -- ####  A ENTRADA  ####
  --
  -- A casinha da superfície: o slug de uma linha de
  -- dungeon_blueprints. NULL = a entrada mínima gerada por código
  -- (uma laje, um alçapão, uma luz) — o que faz uma dungeon
  -- funcionar sem nenhuma planta importada.
  entrance_blueprint TEXT,

  -- ####  MODO 'recipe'  ####
  size_min INTEGER NOT NULL DEFAULT 10,       -- em SALAS
  size_max INTEGER NOT NULL DEFAULT 15,
  -- Os pesos das cores. Não precisam somar 100: são pesos.
  weight_green INTEGER NOT NULL DEFAULT 60,
  weight_blue  INTEGER NOT NULL DEFAULT 30,
  weight_red   INTEGER NOT NULL DEFAULT 10,
  corridor_npc_density INTEGER NOT NULL DEFAULT 20,
  corridor_loot_density INTEGER NOT NULL DEFAULT 10,
  -- JSON: array de shortname de caixa.
  corridor_crates TEXT NOT NULL DEFAULT '[]',

  -- ####  MODO 'blueprint'  ####
  --
  -- O grid, no formato de §4.2. NULL quando mode='recipe'.
  -- Validado na leitura pelo mesmo schema da rota — linha
  -- ilegível é DESCARTADA com aviso, como em ui_documents.
  grid TEXT,

  -- ####  O NPC  ####  (vale nos dois modos)
  npc_health_min REAL NOT NULL DEFAULT 100,
  npc_health_max REAL NOT NULL DEFAULT 150,
  npc_damage_scale REAL NOT NULL DEFAULT 1.0,
  npc_weapons TEXT NOT NULL DEFAULT '[]',     -- JSON: shortnames
  npc_names TEXT NOT NULL DEFAULT '[]',       -- JSON: nomes sorteados

  -- Segundos. -1 = não mexe na hora do dia de quem entra.
  -- O 1.3.4 usa 0 (meia-noite) para deixar a dungeon escura.
  time_of_day REAL NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**`dungeon_rooms`** é a tabela do conteúdo por cor — três linhas por dungeon no
modo receita (`green`/`blue`/`red`), e uma por sala nomeada no modo planta:

```sql
CREATE TABLE dungeon_rooms (
  dungeon_id TEXT NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,
  -- 'green'|'blue'|'red' no modo receita; 'A','B','C'… no modo planta.
  room_key TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'green' CHECK (color IN ('green','blue','red')),
  npc_min INTEGER NOT NULL DEFAULT 0,
  npc_max INTEGER NOT NULL DEFAULT 1,
  loot_min INTEGER NOT NULL DEFAULT 1,
  loot_max INTEGER NOT NULL DEFAULT 1,
  crates TEXT NOT NULL DEFAULT '[]',          -- JSON: prefabs de caixa
  -- 'wood'|'metal'|'toptier'. É o que a cor significa no jogo:
  -- a porta que o jogador encontra.
  door TEXT NOT NULL DEFAULT 'wood' CHECK (door IN ('wood','metal','toptier')),
  -- 1 = a porta tem fechadura com código, e o código cai de um NPC.
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  PRIMARY KEY (dungeon_id, room_key)
);
```

### 6.3 `dungeon_blueprints` — as plantas

```sql
CREATE TABLE dungeon_blueprints (
  id TEXT PRIMARY KEY,                        -- slug: 'entrance-bunker'
  name TEXT NOT NULL,

  -- 'entrance' | 'base'. A entrada é colada na SUPERFÍCIE; a base,
  -- a -90. Marcar isso evita o erro que o 1.3.4 só descobre 60
  -- segundos depois, no "No hatch found".
  kind TEXT NOT NULL DEFAULT 'entrance' CHECK (kind IN ('entrance','base')),

  -- O JSON no formato de §5.2, inteiro. A maior das 7 existentes
  -- tem 512 KB — o SQLite guarda TEXT sem teto prático.
  content TEXT NOT NULL,

  -- Derivados, gravados na escrita para a lista do painel não
  -- precisar abrir 500 KB para dizer "584 peças".
  entity_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  -- 1 = tem par de alçapão. Sem isso a dungeon não abre.
  has_hatch INTEGER NOT NULL DEFAULT 0 CHECK (has_hatch IN (0,1)),

  -- 'import' (veio de arquivo) | 'capture' (§4.3) | 'builtin'.
  origin TEXT NOT NULL DEFAULT 'import',

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

A migração 059 **importa as 7 plantas de `Docs/OrigemZDurgeon/Dungeons/`** como
`origin = 'builtin'`. É o que faz o sistema já nascer com conteúdo.

### 6.4 `event_runs` — o que aconteceu

Uma linha por nascimento. É a auditoria, e é ela que responde "por que o evento
não nasceu ontem" — que é a pergunta cara.

```sql
CREATE TABLE event_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  dungeon_id TEXT,

  --  'scheduled'  esperando a hora
  --  'spawning'   mandou construir, esperando o "terminei"
  --  'active'     no ar
  --  'closing'    avisou, radiação subindo
  --  'ended'      acabou bem
  --  'failed'     não conseguiu nascer (e failure_reason diz por quê)
  --  'cancelled'  o admin parou
  status TEXT NOT NULL,
  failure_reason TEXT,

  pos_x REAL, pos_z REAL, grid TEXT,          -- 'G14', para a linha do painel
  owner_steam_id TEXT,
  entered_count INTEGER NOT NULL DEFAULT 0,

  scheduled_for INTEGER,
  started_at INTEGER,
  ended_at INTEGER
);
```

**`event_run_players`** é `(run_id, steam_id, entered_at, left_at, died)` — quem
entrou. É o que a ficha do jogador vai ler, do mesmo jeito que lê as quests.

---

## 7 — O contrato agente ↔ plugin

Vale aqui, inteira, a regra de ouro de `core/src/game/plugin-contract.ts`: **o
plugin responde JSON em UMA ÚNICA LINHA**, e mudar qualquer coisa de um lado
exige mudar o outro junto. Resposta que não bate com o schema é RECUSADA — nunca
tratada como sucesso.

### 7.1 Os comandos, do agente para o plugin

| Comando | O que faz |
|---|---|
| `origemz.dungeon.sync <base64>` | empurra o estado: dungeons ligadas, zonas, textos. **Estado completo, nunca delta** |
| `origemz.dungeon.build <slug> [x] [z]` | constrói agora. Sem coordenada, usa o sorteio; com, usa aquele ponto |
| `origemz.dungeon.build.here <slug> <steamId>` | constrói **onde aquele jogador está**. É o comando do §8 |
| `origemz.dungeon.stop <runId> [reason]` | encerra o que está no ar |
| `origemz.dungeon.status` | o que existe agora: no ar? onde? quem dentro? |
| `origemz.dungeon.capture <slug> <steamId> <radius>` | lê o mundo em volta e devolve a planta (frente F) |

O `sync` segue `plugin-push.ts` à risca: **base64**, porque o parser de console
do Rust come as aspas de token citado — está medido e documentado lá. E o
payload é o **estado completo**: quem sumiu do JSON perde o efeito no instante
em que o comando é aplicado, e é isso que faz "apaguei no painel" chegar ao jogo.

### 7.2 O que o plugin manda de volta

Duas naturezas, e elas usam caminhos diferentes:

**Resposta a comando** — uma linha de JSON, casada com o comando que a pediu:

```json
{"ok":true,"runId":41,"slug":"bunker-vermelho","x":1420.5,"z":-310.2,"grid":"K7","entities":312,"ms":4180}
```

**Evento espontâneo** — o plugin avisa que algo aconteceu sem ninguém ter
perguntado. Vai pelo stream de log, com marcador, como o `#OZQUEST#` das quests:

```
#OZDUNGEON#{"kind":"entered","runId":41,"steamId":"7656…","at":1757354200}
#OZDUNGEON#{"kind":"owner","runId":41,"steamId":"7656…"}
#OZDUNGEON#{"kind":"ended","runId":41,"reason":"timeout","entered":4}
#OZDUNGEON#{"kind":"failed","runId":41,"reason":"no_hatch"}
```

O agente lê no mesmo handler de stream do `ui-sync`, e vale a regra de lá: **nada
ali pode lançar**, porque a exceção subiria por um caminho que ninguém trata e
levaria junto o resto do stream.

#### O evento emitido DENTRO de um comando não chega — medido em 09/09/2026

E é a armadilha mais cara desta seção, porque falha em silêncio.

`ozdungeon stop` pelo RCON derrubava a masmorra, o plugin emitia o `ended`… e a
linha saía na **resposta casada do comando** — aquela que volta no POST `/rcon`
e some do buffer. O agente, que escuta o *stream*, nunca a via. A run ficava
`active` no banco **para sempre**: o painel dizendo "1 masmorra no ar" com o
chão vazio, e nada no sistema consertando isso sozinho.

Tudo que o plugin escreve enquanto um comando roda é engolido pela resposta
dele, inclusive o `Puts` com marcador. A correção é **emitir fora do comando**:

```csharp
NextTick(() => Puts(line));
```

A exceção é o `Unload`: ali não existe próximo tick — o plugin já não existe
quando ele chegaria —, então a linha tem de sair síncrona. É para essa
distinção, e só para ela, que o plugin carrega um campo `unloading`.

### 7.3 Os oito motivos de falha, nomeados

Um evento que não nasce tem de dizer por quê, **com o mesmo nome nos dois lados**.
Sem isso o painel mostra "falhou" e alguém abre o log do servidor.

| Código | O que aconteceu |
|---|---|
| `no_position` | o sorteio não achou lugar livre (todas as tentativas caíram em zona proibida, água ou perto de base) |
| `no_hatch` | construiu, mas o par de alçapões não apareceu. É o erro do 1.3.4 |
| `blueprint_missing` | o arquivo da planta não estava no disco daquele servidor |
| `blueprint_invalid` | o JSON estava lá e não é uma planta |
| `too_few_online` | menos gente online que `min_online` |
| `already_active` | já tem um evento no ar e o `events` não deixa dois |
| `wipe_window` | o wipe está em curso ou a menos de X minutos |
| `build_timeout` | passou de 60 s construindo e não terminou |

### 7.4 O que sobra no `oxide/config/OrigemZDungeon.json`

Quase nada, e de propósito. **Cinco chaves**, todas sobre a máquina e nenhuma
sobre o jogo:

```jsonc
{
  "Agent marker prefix": "#OZDUNGEON#",
  "Base depth (Y)": -90,
  "Entities per tick": 25,          // o freio do §5.3.4
  "Build timeout (seconds)": 60,
  "Debug log": false
}
```

Tudo o mais — que dungeon existe, quanto dura, o que ela fala, quantos NPCs — vem
do `sync`. Um admin que edite este arquivo não consegue mudar o jogo, e é
exatamente isso que se quer: **uma fonte de verdade, e ela é o painel**.

### 7.5 A resposta casada e o stream são caminhos diferentes — medido

Um `[Command]` do Covalence chamado pelo console responde **casado**: o
`player.Reply` volta como resposta do próprio comando de RCON.

```
POST /api/servers/server01/rcon  {"command":"ozdungeon status"}
→ {"ok":true,"response":"Masmorra 'base4' · 486 peças · 0 dentro · … · entrada em K8"}
```

E há uma consequência que confunde quem depura: **a linha casada NÃO aparece no
buffer de console**. Ela foi consumida como resposta. Um `Reply` seguido de
outro deixa o segundo no stream e o primeiro só na resposta — foi assim que,
aqui, `ozdungeon lista` pareceu "responder metade".

Isso decide o desenho da frente C, e ele já é o do §7.2:

| O quê | Como volta | Por quê |
|---|---|---|
| `status`, `lista`, validações | **casada**, na resposta do comando | a pergunta tem resposta imediata |
| `built`, `failed`, `entered`, `ended` | **stream**, com `#OZDUNGEON#` | a construção termina segundos depois; não há comando esperando |

Um agente que esperasse a construção na resposta casada tomaria `RCON_TIMEOUT`
em 5 s enquanto a masmorra subia bem — e é por isso que o marcador existe.

---

## 8 — O comando no jogo, e o fluxo de "construir onde eu estou"

É o pedido do dono, literal: *"o painel manda o comando para ele digitar lá no
jogo e ele constrói a dungeon estando no jogo, pelo painel"*.

### 8.1 O fluxo, do botão ao chão

```
 PAINEL                          JOGO                        AGENTE
   │
   │ 1. admin salva a dungeon
   │    "Bunker Vermelho"
   ├──────────────────────────────────────────────► grava + materializa
   │                                                 o arquivo no disco
   │ 2. a tela mostra, grande:
   │    ┌──────────────────────────────┐
   │    │  /ozdungeon build bunker-verm│ [copiar]
   │    └──────────────────────────────┘
   │
   │ 3. admin entra no jogo, anda até o lugar,
   │    olha para a direção que quer, cola o comando
   │                    │
   │                    ├──────────────────────────► o plugin lê a posição
   │                    │                            e a direção DELE
   │                    │
   │                    │  4. "Construindo…" no chat
   │                    │     entrada colada na superfície
   │                    │     base construída a -90
   │                    │     alçapões emparelhados
   │                    │
   │                    └──#OZDUNGEON#{"kind":"built"…}──►
   │                                                   grava event_run
   │ 5. a tela atualiza sozinha: ◄──────────────────────┘
   │    "No ar em K7, desde 19:42"
```

O passo 3 é o único que não é no painel, e **não pode ser**: só quem está de pé
no mapa sabe que aquela encosta é boa.

### 8.2 Os comandos de chat, e por que são poucos

| Comando | Quem usa |
|---|---|
| `/ozdungeon build <slug>` | constrói aqui, onde estou, olhando para onde olho |
| `/ozdungeon stop` | derruba o que está no ar neste servidor |
| `/ozdungeon tp` | me leva até a entrada (o admin não quer andar 900 m) |
| `/ozdungeon capturar <slug> <raio>` | salva o que construí (frente F) |
| `/ozdungeon` | lista o que dá para construir, com o slug de cada um |

Todos exigem `origemzdungeon.admin` — permissão do Oxide, concedida pelo painel
como todas as outras.

**Um argumento, e ele é o slug.** O `dungbase_start` do 1.3.4 aceita entrada,
base, `procedural_hard` e três coordenadas na mesma linha, adivinhando qual é
qual com `float.TryParse` em cada token. Quando erra, não diz nada. O comando
novo tem um argumento porque **o resto já está no painel** — é o ganho inteiro
de ter um painel.

### 8.3 A direção importa, e é de graça

`GenerateBaseAt(origin, forward, size)` já aceita a direção. O plugin passa
`player.eyes.HeadForward()` achatado no plano: **a dungeon cresce para onde o
admin está olhando**. Custa uma linha e dá controle real sobre um mapa apertado.

### 8.4 E o botão "construir agora" do painel?

Existe, e ele é outra coisa: manda `origemz.dungeon.build <slug>` **sem
coordenada**, e o plugin sorteia o lugar como o agendador faria. É o botão de
"quero ver funcionando", não o de posicionar.

Quando o admin está online, o painel oferece os dois — e o segundo botão diz
**"Construir onde o Fulano está"**, porque o painel sabe quem está online
(`origemz.players` já devolve a posição de cada um — ver a memória do projeto).
Aí nem o copiar-e-colar é preciso.

---

## 9 — O ciclo de vida: evento e permanente

Decisão 4: a mesma dungeon serve aos dois. O que muda é o `spawn_mode` do
`events`, e o que ele liga ou desliga.

### 9.1 Modo evento

O do 1.3.4, e ele funciona:

```
  sorteia a hora ──► nasce ──► alguém entra e vira DONO ──► joga
                                                             │
        ┌────────────────────────────────────────────────────┘
        ▼
  falta warn_before:      aviso no chat, o mapa mostra a contagem
  falta radiation_before: a radiação sobe lá dentro
  fim:                    portas fecham, quem está dentro fica preso
  + destroy_after:        tudo é apagado, marcador some
```

Os quatro números são do painel. A radiação existe para **empurrar sem matar de
surpresa** — quem ignorou dois avisos e um contador na tela escolheu ficar.

### 9.2 Modo permanente

A dungeon é plantada uma vez e fica. Muda:

- **não há dono nem time.** `access` cai para `anyone` — uma masmorra fixa que
  só o primeiro pode entrar é uma masmorra que ninguém visita;
- **não há fim, radiação nem fecho.** Os quatro números viram inertes;
- **o loot volta.** Uma dungeon permanente vazia é decoração; então as caixas
  respawnam num intervalo (`respawn_seconds`, do painel), como um monumento;
- **o marcador é fixo** — sem contagem regressiva, com o nome dela;
- **ela morre no wipe**, junto com o mundo. É a única coisa que a derruba.

### 9.3 O problema que o `EnableSaving(false)` cria, e a solução

**Nada da dungeon entra no save do mundo.** São doze `EnableSaving(false)` no
1.3.4, e eles não são acidente: entidades salvas viram lixo permanente no
`.sav`, wipe após wipe.

Então uma dungeon permanente **não sobrevive a um restart por si só**. Ela
sobrevive porque é **reconstruída**, e o agente é quem se lembra:

```
   restart do servidor
        │
        ▼
   plugin sobe, manda #OZDUNGEON#{"kind":"ready"}
        │
        ▼
   agente lê event_runs: "a run 41 está 'active' e é permanente"
        │
        ▼
   origemz.dungeon.rebuild 41   →  reconstrói na mesma posição,
                                    com a mesma seed
```

A **seed** é o que faz o modo receita reconstruir *igual*: `event_runs` guarda
`seed INTEGER`, e `Layout()` passa a receber `System.Random(seed)` em vez de
`new System.Random()`. Sem isso, a dungeon permanente vira outra a cada restart —
e um jogador que decorou o caminho até a sala vermelha volta a um lugar
diferente.

**Isto vale também para o modo evento**, e resolve de graça o bug que o 1.3.4
contorna com `saveEvent` + `SaveDungeonData()` + `LoadData()`: em vez de
serializar 300 entidades, guardamos um inteiro. É a mesma lição do
`wipe/recover.ts` — o estado que sobrevive ao restart mora no banco do agente,
nunca na memória do processo.

> **Nota:** hoje o `Layout()` usa `new System.Random()` sem semente em três
> lugares (`rng`, `rngDoor`, `boxRng`) e mais alguns dentro do
> `GenerateBaseInternal`. Todos passam a receber a mesma semente. É mudança
> mecânica, mas tem de ser **completa** — um `Random` sem semente que sobre faz
> a reconstrução divergir em algum detalhe, e o bug aparece um mês depois como
> "sumiu uma caixa".

---

## 10 — A API

Segue a divisão do `routes/quests.ts`: a regra mora no serviço, a rota valida a
borda e traduz. Datas em **epoch ms**, como as quests — quem lê faz conta de
tempo.

### 10.1 Os eventos

```
GET    /events                        a lista, com filtro por kind
GET    /events/:id                    um evento inteiro
POST   /events                        cria. 201
PUT    /events/:id                    edita
DELETE /events/:id                    apaga
PUT    /events/:id/servers            em quais servidores ele vale

GET    /events/runs                   o histórico, com filtro
GET    /events/runs/:id               uma run, com quem entrou
POST   /events/:id/start              nasce agora (sorteia o lugar)
POST   /events/:id/start-at           nasce em x,z
POST   /events/runs/:id/stop          encerra
```

### 10.2 As dungeons

```
GET    /dungeons                      a lista
GET    /dungeons/:id                  uma inteira, com as salas
POST   /dungeons                      cria. 201
PUT    /dungeons/:id                  edita
POST   /dungeons/:id/duplicate        duplica. 201
DELETE /dungeons/:id                  apaga
POST   /dungeons/:id/validate         valida a planta SEM salvar
GET    /dungeons/:id/command          o comando para colar no jogo
GET    /dungeons/:id/runs             o que aconteceu com ela — é o
                                      olho do assistente (§12.1.1)
```

O `/validate` é o que faz o editor de planta dizer *"a sala C não tem porta"*
enquanto o admin desenha, sem gravar nada.

**`/runs` é a rota que faz o passo ⑥ terminar sozinho.** Ela aceita
`?serverId=` e `?since=` (epoch ms) e devolve o que nasceu daquela dungeon
depois daquele instante — vazio enquanto o admin ainda não colou o comando,
uma linha quando ele colou. O painel a chama a cada dois segundos **só
enquanto o passo está aberto**, e para no primeiro resultado.

Sem `since`, o assistente celebraria a construção de ontem.

### 10.3 As plantas

```
GET    /dungeon-blueprints                 a lista (sem o content!)
GET    /dungeon-blueprints/:id             uma, com o content
POST   /dungeon-blueprints                 sobe um JSON. 201
DELETE /dungeon-blueprints/:id
GET    /dungeon-blueprints/:id/download    baixa o JSON
```

**A lista não devolve `content`.** Sete plantas somam 1,1 MB — uma listagem que
carregasse tudo faria o painel baixar isso a cada abertura de tela, para mostrar
sete nomes.

### 10.3.1 Os traçados desenhados

```
GET    /dungeon-layouts                    a lista — COM o desenho de cada um
GET    /dungeon-layouts/:id                um, com as frases do verificador
POST   /dungeon-layouts                    salva. 201 se novo, 200 se substituiu
DELETE /dungeon-layouts/:id                sem trava: carregar COPIA (§4.2.1)
```

**Aqui a lista TRAZ o conteúdo, e não é incoerência.** A regra de cima existe
porque uma planta do CopyPaste tem meio megabyte; um desenho tem algumas centenas
de bytes, e é dele que a miniatura da tela vive. Ver §4.2.1.

**O POST grava o defeituoso** e devolve `problems` com as frases. Um traçado é
rascunho; o que não pode é o admin não saber.

### 10.4 As três regras que nascem na rota

Como no `quests.ts`, elas existem aqui porque só a rota tem os dados para vê-las:

1. **`DUNGEON_IN_USE`** — apagar uma dungeon que está no ar agora, ou que um
   evento ligado referencia;
2. **`BLUEPRINT_IN_USE`** — apagar uma planta que uma dungeon usa como entrada;
3. **`BLUEPRINT_NO_HATCH`** — subir uma planta de entrada sem alçapão. Ela
   *pareceria* funcionar e falharia 60 segundos depois, no jogo, com
   `no_hatch` — que é o pior lugar para descobrir.

---

## 11 — O painel: as telas

### 11.0 O estudo, antes de uma linha de tela

Pedido do dono, em 09/09/2026: *"quando chegar no painel tem que ser bem
detalhado e trabalhado, um design e construção agradável, não de qualquer
jeito — faça estudo"*.

#### Quem usa, e quando

O admin, sozinho, depois de um wipe, querendo pôr uma masmorra nova no mapa
antes de os jogadores entrarem. **Ele não leu documentação nenhuma** e não vai
ler. O que ele tem é a tela.

#### O que a tela responde, nesta ordem

| # | A pergunta | O que responde |
|---|---|---|
| 1 | O que existe? | a lista de masmorras, com o que cada uma é |
| 2 | Tem alguma no ar agora? | o cartão de estado vivo, no topo |
| 3 | Como faço uma? | o botão, e a trilha de seis passos |
| 4 | Isso que montei vai dar o quê? | **a prévia ao vivo** |
| 5 | Funcionou? | o assistente que detecta (§12.1.1) |
| 6 | Por que não funcionou? | o histórico, com o motivo em português |

#### As cinco armadilhas deste domínio

Cada uma delas produz uma tela ruim se ignorada, e nenhuma é óbvia:

1. **São trinta campos.** Numa tela só, ninguém preenche o décimo. → a trilha de
   seis passos (§12.1);

2. **Os números não significam nada sozinhos.** "Densidade de NPC no corredor:
   20" é um número sem tradução; o admin mexe nele por tentativa e erro, wipe
   após wipe. → **a prévia ao vivo** traduz: *"≈ 15 salas, ~45 células, ~14 NPCs
   e 22 caixas"*. É a mesma lição que o editor de loot já pagou
   (`chance-explainer.tsx`);

3. **O vão entre o painel e o jogo.** O admin salva e nada acontece na tela dele
   — a masmorra só existe depois de alguém digitar um comando lá dentro. → o
   passo ⑥ que **fica olhando** e termina sozinho;

4. **A planta sem alçapão sobe bonita.** O erro só aparece 60 segundos depois,
   no jogo. → o selo de alçapão em cada linha do acervo, e a recusa no upload
   com a frase que ensina onde fica a marca;

5. **A cor da sala é o tier, não decoração.** Verde/azul/vermelha é a única
   linguagem que o jogador aprende sem ler nada. Três campos numéricos soltos
   perdem isso. → a **barra de proporção**, colorida, ao lado dos pesos.

#### A ideia que amarra: a prévia usa o algoritmo do jogo

A peça central da tela é uma **prévia ao vivo**, ao lado dos controles, que
desenha uma masmorra de exemplo com aqueles parâmetros:

```
   ┌─ O QUE ISSO PRODUZ ────────────────────────┐
   │   . . A A A . . . . .                      │
   │   . . A A A . # # # #     ≈ 15 salas       │
   │   . # # # . . . . # .     ~78 células      │
   │   E # . . B B . . # .     ~260 blocos      │
   │   . # . . B B . . # .                      │
   │                            ●●●●●●○○○○      │
   │   [sortear outra]          9 verdes        │
   │                            5 azuis         │
   │                            1 vermelha      │
   └────────────────────────────────────────────┘
```

**E ela não é uma aproximação.** É o `BuildLayout` do `OrigemZDungeon.cs`
portado para TypeScript — o mesmo corredor que serpenteia, as mesmas salas
penduradas, as mesmas invariantes. O admin vê a masmorra que vai nascer, e não
um desenho decorativo.

O código já existe em rascunho (`core/scripts/pluginlint/layout-check.mjs`, que
roda 300 sorteios cobrando as invariantes). Aqui ele vira
`panel/src/lib/dungeon-layout.ts`, e o §14.4 continua valendo: **as duas pontas
são compiladas separadamente, e nada as amarra além do comentário.**

#### O que o design system já decide, e não se discute

Lido de `panel/src/app/globals.css`, que é rigoroso e documentado:

- **cantos retos** (a escala inteira foi redefinida para 2–4px, justamente para
  um `rounded-full` copiado de algum exemplo não virar pílula);
- **barra vertical em `--rust-red`** marcando o começo de todo bloco, no lugar
  de sombra ou canto;
- **superfícies quase pretas**, bordas de 1px, tabelas densas;
- **`--rust-red` mede 3.74:1 e NÃO serve para texto corrido.** Aviso é texto em
  `--text` com ícone e borda coloridos. Vale para toda mensagem desta tela;
- **identidade nunca por cor sozinha.** A sala vermelha tem a cor *e* o rótulo;
  a barra de proporção tem a cor *e* o número.

#### O que fica de fora desta frente, e por quê

O **editor de grid** (desenhar célula a célula) é a frente E: ele é a peça mais
cara da parte visual, e sem ele já dá para criar masmorra procedural pelo painel
inteiro. A prévia desta frente é o alicerce dele — o mesmo SVG, o mesmo
`dungeon-layout.ts`, só que somente-leitura.

### 11.1 Onde ele entra na navegação

Item novo na sidebar, entre **Loot** e **Missões** — os três são "o que a casa
põe no mundo":

```
  Loot        o que a casa acrescenta às caixas
  Eventos     o que a casa faz nascer no mapa      ← novo
  Missões     o que a casa dá para fazer
```

`href: '/eventos/'`, ícone `Swords`, hint: *"O que nasce no mapa sozinho:
dungeons, quando, onde, e o que se leva de lá"*.

### 11.2 As quatro abas

| Aba | A pergunta que ela responde |
|---|---|
| **Eventos** | o que existe, quando nasce, o que fala |
| **Dungeons** | como cada uma é por dentro — é onde mora o editor |
| **Plantas** | o acervo de peças prontas: entradas e bases |
| **Histórico** | o que nasceu, onde, quem entrou, o que falhou |

### 11.3 O editor de dungeon

Um `Dialog` grande, como o `quest-dialog.tsx` (817 linhas — este será maior),
dividido em passos (§12.1). O corpo muda com o `mode`:

**Modo receita** — controles e uma frase que traduz o que eles produzem, no
espírito do `chance-explainer.tsx`:

```
   Tamanho   [──────●───────]  12 a 18 salas

   ┌ O que isso produz ───────────────────────────────────┐
   │  ≈ 15 salas, ~45 células, uns 260 blocos             │
   │  ≈ 9 verdes, 5 azuis, 1 vermelha                     │
   │  ≈ 14 NPCs e 22 caixas                               │
   │  Um grupo de 3 leva ~12 min para limpar              │
   └──────────────────────────────────────────────────────┘
```

Sem essa caixa, "peso vermelho: 15" é um número sem significado, e balancear
vira tentativa e erro de wipe em wipe — a lição que o editor de loot já pagou.

**Modo planta** — o grid, em SVG (pela mesma razão do `map-view.tsx`: cada
célula é um elemento de verdade, com hover, clique e leitor de tela de graça):

```
   ┌─────────────────────────────┐   Ferramenta:
   │ . . A A A . . . . .         │    ( ) apagar
   │ . . A A A . # # # #         │    (•) corredor
   │ . # # # . . . . # .         │    ( ) sala nova
   │ E # . . B B . . # .         │    ( ) porta
   │ . # . . B B . . # .         │
   └─────────────────────────────┘   Sala A  [vermelha ▾]
     arrastar pinta · scroll = zoom    4 NPCs · crate_elite
                                       porta toptier + código
```

E, ao lado, sempre: **o painel de validação ao vivo**, que chama
`POST /dungeons/:id/validate` a cada mudança (com debounce) e lista o que está
errado em português — *"a sala C não tem porta"*, *"o corredor não chega na
entrada"*, *"a sala B não é retângulo"*.

### 11.4 O mapa, e as zonas proibidas

A aba **Eventos** ganha o `MapView` que já existe, com duas camadas novas:

- **os eventos no ar**, como círculo pulsante — clicar abre a run;
- **as zonas proibidas**, como círculo vermelho translúcido. Criar uma é
  clicar no mapa e arrastar o raio.

Hoje isso é o comando `dungbase_addblack` executado de pé no lugar, gravando um
`Vector3` cujo `y` foi sequestrado para guardar o raio. Ver a zona no mapa é a
diferença entre configurar e adivinhar.

---

## 12 — A ajuda: o passo a passo e o (?) que abre modal

O dono pediu isto por escrito, e é a parte do plano que mais muda o produto:

> "no painel colocar um passo a passo com tooltip (?) — abre um modal explicando
> cada coisa. Deixar bem detalhado."

**O painel não tem nada disso hoje.** `panel/src/components/ui/` tem nove
componentes e nenhum é um `(?)`. Então isto não é "uma tela da dungeon": é
**peça nova do design system**, e ela nasce aqui porque aqui doeu primeiro — mas
serve a Loot, a Missões e a tudo que vier.

### 12.1 O passo a passo

O editor de dungeon é um formulário com trinta campos. Trinta campos numa tela
só é o jeito de garantir que ninguém preencha o décimo. Então ele é uma trilha
de **seis passos**, e cada passo cabe numa tela:

```
  ①──────②──────③──────④──────⑤──────⑥
  Nome   Como   Salas  NPCs   Entrada Onde e
         nasce  e loot        e saída quando

  ● feito   ◉ agora   ○ falta
```

Regras da trilha, e cada uma tem um porquê:

1. **dá para pular para frente.** Quem já conhece não quer clicar seis vezes.
   O passo incompleto fica marcado, não trancado;
2. **o passo com erro fica vermelho no trilho**, mesmo estando três passos
   atrás. Sem isso, "não consigo salvar" vira uma caça ao campo;
3. **salvar rascunho a qualquer momento.** Uma dungeon incompleta é
   `enabled = 0`, e não um formulário perdido;
4. **o passo ⑥ termina com o comando** — grande, com botão de copiar, e o
   "Construir onde o Fulano está" quando há admin online. O último passo do
   painel é o primeiro passo no jogo.

### 12.1.1 O passo ⑥ se resolve sozinho — o painel FICA OLHANDO

Pedido do dono, em 09/09/2026:

> "Tem que ser facilitado para criar dungeon via painel. O usuário cria; aí, se
> precisa do comando no jogo, o painel manda o admin digitar na posição — **e o
> painel detecta e faz o próximo passo**."

Isto muda o passo ⑥ de "aqui está o comando, boa sorte" para um passo que
**termina sozinho**. É a diferença entre uma instrução e um assistente.

```
  ⑥  Onde ela nasce
  ─────────────────────────────────────────────────────────

     Entre no jogo, vá até o lugar, olhe para onde a masmorra
     deve crescer e cole:

         ┌──────────────────────────────────┐
         │  /ozdungeon build bunker-vermelho│  [copiar]
         └──────────────────────────────────┘

     ⟳  Esperando você construir…                    [pular]

  ─────────────────────────────────────────────────────────
```

e, quatro segundos depois, sem ninguém clicar em nada:

```
     ✓  Construída em K7, às 19:42
        618 peças · 1.275 ms · alçapões ligados

        [ Ver no mapa ]   [ Derrubar ]   [ Concluir ]
```

**Como ele detecta, sem inventar transporte novo.** A cadeia inteira já existe:

```
  jogo ──/ozdungeon build──► plugin
                               │
                               │  #OZDUNGEON#{"kind":"built",…}
                               ▼
                          stream do console
                               │
                               ▼
                          agente  ──grava──►  world_event_runs
                               ▲
                               │  GET /dungeons/:id/runs?serverId=&since=
                          painel (a cada 2 s, só enquanto o passo ⑥ está aberto)
```

Quatro decisões que isso força, e cada uma tem um porquê:

1. **`since` é o momento em que o passo abriu.** Sem ele, o assistente
   celebraria a construção de ontem. O painel manda o relógio dele e o agente
   responde só o que veio depois;
2. **o polling só existe com o passo aberto**, e para no primeiro resultado.
   Um `setInterval` que sobrevive à navegação é o jeito clássico de o painel
   ficar batendo no agente para sempre;
3. **a falha também é um resultado.** `no_hatch` fecha a espera com a frase
   pronta e o botão de tentar de novo — não com o spinner girando até o admin
   desistir e abrir o console do servidor;
4. **`[pular]` existe.** Quem só quer salvar a receita e construir amanhã não
   pode ficar preso numa tela que espera um jogo aberto.

**Por que polling, e não WebSocket.** O painel inteiro já é polling — é assim
que o console e o mapa funcionam. Um canal novo para um passo de assistente
seria a peça mais frágil do sistema, mantida por causa de dois segundos de
latência que ninguém percebe.

### 12.1.2 A mesma detecção serve à aba Plantas

O acervo de plantas (§11.2) **já nasce cheio**: as sete que vieram com o
projeto são importadas no primeiro boot e aparecem lá, com peças, tamanho e o
selo de alçapão. Ver §5.1 e §6.3.

E a captura in-game (§4.3) usa exatamente o mesmo desenho:

```
     Digite no jogo, de pé onde você construiu:

         ┌────────────────────────────────────┐
         │  /ozdungeon capturar minha-entrada │  [copiar]
         └────────────────────────────────────┘

     ⟳  Esperando a captura…

     ✓  Recebida: 312 peças, com alçapão. [ Salvar no acervo ]
```

Uma cadeia, dois usos. O assistente que constrói e o que captura são a mesma
tela com um verbo diferente.

### 12.2 O `(?)`, e o que ele abre

Um componente novo, `panel/src/components/ui/help-tip.tsx`:

```tsx
<Label>
  Densidade de NPC no corredor
  <HelpTip topic="corridor-npc-density" />
</Label>
```

- **`<button>` de verdade**, não `<span title>`: `title` do navegador não abre
  no teclado, não abre no celular, e some sozinho em 5 segundos;
- **hover ou foco** mostra uma frase curta (uma linha, o resumo);
- **clique** abre o `Dialog` que já existe, com o texto longo;
- **`aria-label="Ajuda sobre …"`**, e o modal é o mesmo `<dialog>` nativo do
  projeto — Escape fecha, o foco fica preso dentro e volta para o `(?)` ao sair.

### 12.3 Onde os textos moram

Em **um** arquivo: `panel/src/lib/help/dungeons.tsx`. Não espalhados pelos
componentes.

```tsx
export const DUNGEON_HELP = {
  'corridor-npc-density': {
    title: 'Densidade de NPC no corredor',
    short: 'De cada 100 células de corredor, quantas ganham um NPC.',
    body: (
      <>
        <p>O corredor é o caminho entre as salas — …</p>
        <Example>20 num corredor de 60 células ≈ 12 NPCs pelo caminho.</Example>
        <Warn>Acima de 50 o corredor vira o desafio e as salas viram
        descanso — que é o contrário do que a cor da sala promete.</Warn>
      </>
    ),
  },
  …
} satisfies HelpTopics;
```

Três razões para o arquivo separado, e a terceira é a que decide:

1. o mesmo conceito aparece em três telas e tem de dizer a mesma coisa;
2. dá para revisar o texto de ajuda inteiro sem abrir seis componentes;
3. **é o que torna possível a tela de ajuda inteira** (§12.5) — um índice que
   se monta sozinho do registro.

### 12.4 O que cada verbete tem

Quatro partes, e nenhuma é opcional:

| Parte | Responde |
|---|---|
| **O que é** | em uma frase, sem jargão |
| **Um exemplo com número** | "20 num corredor de 60 células ≈ 12 NPCs" |
| **O que acontece se exagerar** | o limite prático, e o sintoma |
| **Com o que conversa** | "anda junto com o peso da sala vermelha" |

A terceira é a que falta em toda documentação de plugin de Rust, e é a que o
admin precisa às 2 da manhã. Um verbete sem ela é a etiqueta do campo escrita
por extenso.

### 12.5 As três camadas de ajuda

Elas existem porque são três perguntas diferentes:

| Camada | Onde | Responde |
|---|---|---|
| **Passo a passo** | no editor | "por onde eu começo?" |
| **`(?)` no campo** | ao lado do rótulo | "o que este número faz?" |
| **Guia da tela** | botão *Como funciona* no topo | "como isso tudo se encaixa?" |

O **guia** é um modal com a explicação inteira do sistema, com o desenho da
entrada e da dungeon a -90 (§1.1), e o fluxo do §8.1. Ele existe porque o modelo
"a dungeon mora embaixo do mundo e o alçapão teleporta" **não é adivinhável** — e
quem não entende isso não entende por que a entrada é uma planta separada.

### 12.6 O primeiro uso, e o que ele mostra sozinho

Quando não existe nenhuma dungeon, a aba não mostra uma tabela vazia. Mostra
três caminhos:

```
   Nenhuma dungeon ainda.

   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
   │  Começar de    │ │  Começar de    │ │  Desenhar do   │
   │  um pronto     │ │  uma receita   │ │  zero          │
   │                │ │                │ │                │
   │ 4 prontas:     │ │ escolha a      │ │ o editor de    │
   │ fácil…pesadelo │ │ dificuldade e  │ │ grid, célula   │
   │ Duplica e mexe │ │ ajuste         │ │ a célula       │
   └────────────────┘ └────────────────┘ └────────────────┘

              [ Como isso funciona? ]  ← o guia
```

O primeiro botão é o que faz o sistema ter valor no primeiro minuto: as quatro
receitas de fábrica da migração 057 são os tiers do 1.3.4, que já estão
balanceados.

---

## 13 — As frentes, em ordem de dependência

Sete frentes. As três primeiras são a linha reta até *"funcionou no jogo"*; as
outras quatro são valor por cima.

### Frente A — O plugin constrói pelo comando · **MEDIDA NO JOGO**

*Sem painel, sem banco, sem agente.* `OrigemZDungeon.cs` nasce com o que é
herdado do 1.3.4 (§1.3), mais o leitor de planta (§5.3), mais
`/ozdungeon build <slug>` lendo a planta de `oxide/data/`.

**Termina quando:** um `.json` posto à mão em
`oxide/data/OrigemZDungeon/blueprints/` vira dungeon no jogo, com alçapão
funcionando, pelo comando de chat.

É a frente que **prova o corte todo**, porque ela é a que pode falhar por
motivos que o plano não previu. Nada depende dela estar bonita — depende de ela
funcionar.

**O que está de pé (08/09/2026):**

| | |
|---|---|
| `Plugins/OrigemZDungeon.cs` | 1.606 linhas, compila limpo contra as DLLs do server01 |
| Comandos | `/ozdungeon [lista\|build\|stop\|tp\|status]`, chat e console |
| `build` por coordenada | `ozdungeon build <planta> <x> <z> [graus]` — antecipado da frente C, porque é o único jeito de conferir sem um cliente aberto |
| Leitor de planta | `entities` + `children` + `flags` + `items`, com `InvariantCulture` |
| As duas convenções de alçapão | §5.3.7, medidas nas sete plantas |
| Construtor procedural | `BuildLayout` + fundação/parede/porta/teto/luz, `EnableSaving(false)` em tudo |
| Alçapões | par ligado, teleporte com as pausas de anticheat |
| As 7 plantas | instaladas em `Servers/server01/oxide/data/OrigemZDungeon/blueprints/` |

**Medido no `server01`, em 08/09/2026 — as sete plantas, uma a uma:**

| Planta | Peças | Tempo | Grid |
|---|---|---|---|
| `entrance1` | 1.052 | 1.711 ms | F7 |
| `entrance2` | 390 | 1.057 ms | H7 |
| `entrance3` | 380 | 1.062 ms | J7 |
| `entrance4` | 489 | 1.155 ms | L7 |
| `base2` | 592 | 1.275 ms | N7 |
| `base3` | 526 | 1.190 ms | P7 |
| `base4` | 511 | 1.343 ms | R7 |

**7 de 7 sobem, ligam os alçapões e são derrubadas pelo `stop`.** O plugin
carrega no Oxide (`"OrigemZ Dungeon" (0.1.0)`), e cada construção emite a linha
`#OZDUNGEON#{"kind":"built",…}` que a frente C vai consumir.

**O que falta para fechar a frente:** um jogador descer pelo alçapão. Isso exige
um cliente de Rust aberto, e é a única coisa aqui que não dá para conferir do
console. As duas metades existem e estão ligadas (`alçapões ligados: superfície
y=51.9 ⇄ masmorra y=-87.0`); o que não foi exercitado é o `OnDoorOpened` e o
teleporte.

**Três defeitos que só o jogo revelou**, e nenhum deles apareceria em teste de
unidade — estão em §5.3.8, §5.3.9 e §7.5.

**O que ainda não vem** (e é de propósito, para a frente C): NPCs, loot,
turrets, card readers, fuse boxes, o fim do evento (radiação e fecho) e a cor
de sala — hoje toda porta nasce verde, porque quem decide a cor é a receita, e
a receita vem do painel.

### Frente B — O banco e a API · **PRONTA**

Migrações 057–060, repositórios, rotas (§10). Importa as 7 plantas. Sem tela e
sem plugin: testado por `core/test/`.

**O que está de pé (09/09/2026):**

| | |
|---|---|
| Migrações | 057 `world-events-core`, 058 `dungeons-core`, 059 `dungeon-blueprints`, 060 `world-event-runs` |
| A régua | `types/world-events.ts` e `types/dungeons.ts` — importada pela rota **e** pelo repositório |
| Repositórios | `dungeon-blueprints`, `dungeons`, `world-events` |
| Rotas | `/dungeons`, `/dungeon-blueprints`, `/world-events`, `/servers/:id/event-zones` |
| O olho do assistente | `GET /dungeons/:id/runs?serverId=&since=` (§12.1.1) |
| As 7 plantas | importadas sozinhas no primeiro boot, de `Assets/dungeons` |
| As 4 receitas de fábrica | `GET /dungeons/factory` — modelo para duplicar, e não linha no banco |
| Testes | 29 novos; a suíte inteira em 1.943 |

**Três armadilhas que este trabalho encontrou**, e que valem para o repositório
inteiro:

1. **`events` já existia** (migração 027, o calendário). Medido *antes* de
   aplicar; aplicar direto teria quebrado a migração no `CREATE TABLE`. Daí o
   prefixo `world_`;
2. **a ordem de declaração de um módulo derruba o agente, e o typecheck não a
   vê.** `FACTORY_RECIPES` chama uma função que lê constantes declaradas
   abaixo: compila limpo e explode no import com
   `Cannot access 'CORRIDOR_CRATES' before initialization` — no boot, antes de
   servir a primeira rota;
3. **`.default({})` em objeto aninhado não basta no Zod 4.** O default recebe o
   tipo de *saída*; quem quer "o objeto vazio, deixe os defaults internos
   agirem" usa `.prefault({})`.

### Frente C — O agente fala com o plugin · **MEDIDA NO JOGO**

`origemz.dungeon.sync` (base64, estado completo), o marcador `#OZDUNGEON#` no
stream, o materializador que escreve a planta no `oxide/data` do servidor certo,
e o `world_event_runs` sendo alimentado.

**Termina quando:** salvar no painel põe o arquivo no disco e o comando no jogo
funciona sem ninguém tocar em arquivo.

**Medido no `server01`, em 09/09/2026 — o ciclo inteiro:**

1. apaguei a pasta `oxide/data/OrigemZDungeon/` inteira;
2. o plugin recarregou, gritou `#OZDUNGEON#{"kind":"ready"}`;
3. o agente respondeu materializando **as sete plantas de volta** e empurrando
   o estado;
4. criei a masmorra `bunker` pelo painel, apontando para a planta `entrance2`;
5. `ozdungeon build bunker -1500 -1500` — **e não existe planta chamada
   `bunker`**. Ele só construiu porque recebeu a receita: 327 peças, 8 a 10
   salas, como o painel mandou;
6. a linha voltou **com o segredo**, e virou
   `run #1 active · grid D23` em `GET /dungeons/bunker/runs`.

O passo 5 é o que prova a frente: o comando no jogo passou a nomear **a
masmorra**, e é ela que sabe qual planta serve de entrada.

**Dois defeitos que só o jogo revelou:**

1. **`[ConsoleCommand]` NÃO REGISTRA NADA num `CovalencePlugin`.** O comando
   some sem erro — o console do Rust não reclama do que não conhece, ele apenas
   se cala — e o agente recebe `RCON_TIMEOUT` sobre um comando que nunca
   existiu. A forma do Covalence é `[Command]`, e ela atende console e chat;
2. **"cem masmorras cabem folgadas" era falso.** Eu escrevi isso no contrato e
   o teste mediu 74 KB, acima do teto de 50 KB. Cabem **cerca de 40**. O
   conserto óbvio, no dia em que apertar, é mandar a cada servidor só as
   masmorras dos eventos ligados nele.

### Frente D — A tela · **PRONTA**

As três abas, o editor de seis passos, o acervo de plantas, o histórico — e,
por decisão tomada durante a construção, **a ajuda junto** (o que era a frente
F). Separá-las produziria uma tela que seria reformada em seguida: trinta
campos sem `(?)` não são preenchíveis, e o dono pediu acabamento.

| | |
|---|---|
| `/eventos` | três abas, cartão do que está no ar, primeiro uso com três caminhos |
| Editor | trilha de seis passos, com a **prévia ao vivo** ao lado |
| `lib/dungeon-layout.ts` | o `BuildLayout` portado — a prévia usa o algoritmo do servidor |
| Acervo | as sete plantas, com selo de alçapão, e **vista de cima** de cada uma |
| `ui/help-tip.tsx`, `ui/steps.tsx` | peças novas do design system |
| `lib/help/dungeons.tsx` | 17 verbetes, cada um com exemplo e limite |

**Cinco defeitos que só apareceram olhando a tela**, e cada um vale a regra:

1. **O padding do wrapper.** Eu pus `p-4`; nenhuma outra tela tem. Dá para ver
   de relance com `/loot` e `/eventos` lado a lado;
2. **A trilha truncou os rótulos.** `flex-1` + `truncate` com seis passos num
   modal estreito virou `IDE… TA… SA… INI… EN… CO…`. Agora cada passo tem a
   largura que precisa e o trilho é que rola;
3. **O `Dialog` tem `w-[min(30rem,92vw)]` próprio**, e `max-w-5xl` não alarga
   nada quando a largura já é menor. Era a causa do defeito acima;
4. **O modal fechava sozinho ao editar.** Um `<select>` nativo, ao fechar,
   dispara um clique cujo `target` é o `<dialog>` — e o teste de "clicou no
   backdrop" o tratava como clique fora. Trinta campos iam junto. Daí o modo
   `guarded`: dois cliques fora, e o Escape não fecha;
5. **Os tooltips eram cortados.** Com `absolute`, o `overflow-y-auto` do corpo
   do modal os cortava, e um `(?)` perto da borda jogava metade do texto para
   fora da tela. Agora a bolha é `fixed` e a posição é medida, presa dentro da
   janela.

### Frente E — O editor de planta · **O PAINEL ESTÁ PRONTO**

Pedido do dono, em 09/09/2026: *"eu vi que colocou pixel aí — o admin pode
desenhar, de uma maneira fácil"*. Ele leu a prévia como uma tela de pixel art,
e estava certo: **é exatamente isso que ela é**.

`components/dungeons/dungeon-grid-editor.tsx`: uma tela de 24×24, cinco cores
(apagar, corredor, verde, azul, vermelha), pintura por arrasto, desfazer e
refazer. Duas decisões que fazem dele *fácil*:

- **as portas nascem sozinhas** onde uma sala encosta no corredor. A
  alternativa — uma ferramenta "porta" — só criaria um jeito novo de errar:
  desenhar o cômodo e esquecer a porta produz uma sala perfeita em que ninguém
  entra;
- **as salas se descobrem sozinhas.** O admin pinta COR; quem separa "duas
  salas vermelhas" de "uma vermelha grande" é o preenchimento por vizinhança na
  hora de salvar. Pedir para nomear cada cômodo transformaria um desenho de dois
  minutos num formulário.

E **sortear também é um jeito de começar**: o botão enche a tela com um traçado
do gerador, e dali o admin apaga, estica e repinta. Gerar é o primeiro traço de
desenhar — os dois caminhos que o dono pediu, no mesmo lugar.

**O verificador**, também pedido: quatro defeitos que **sobem normalmente no
jogo** e por isso precisam ser cobrados no desenho —

| O que | Por que não dá erro no servidor |
|---|---|
| sala que não encosta em corredor | ela é construída; simplesmente não tem porta |
| corredor que não chega à entrada | é construído; ninguém nunca chega lá |
| sala de uma célula com corredor em três lados | vira um cômodo quase sem parede |
| célula solta, sem vizinho | vira um bloco flutuando no meio do nada |

**O que falta para o modo planta funcionar de ponta a ponta:** o
`OrigemZDungeon.cs` ainda **não constrói a partir do grid** — o `GenerateRooms`
só sorteia. Ler o `grid` do sync e erguer aquelas células é a próxima peça, e é
pequena: o construtor já trabalha em células, é o `Layout()` que passa a vir
pronto em vez de sorteado.

### Frente F — A ajuda

O `HelpTip`, o `HelpDialog`, o passo a passo, o registro de textos, o guia, o
estado vazio (§12). **Ela é frente própria, e não "um detalhe da D"**, porque é
o que o dono pediu explicitamente e é o que costuma ser cortado quando vira
tarefa de rodapé de outra coisa.

### Frente G — O guarda-chuva e o permanente

O `OrigemZEvents.cs` de verdade (agenda, exclusão mútua, zona), o modo
permanente com seed e reconstrução no boot (§9.3), o respawn de loot, e a
captura in-game (§4.3).

**O menor corte que já vale a pena:** A + B + C + D. Dá uma dungeon procedural
criada e disparada pelo painel, com histórico. E, por dentro, ela já tem tudo
que a planta e o permanente precisam.

---

## 14 — Como validar sem quebrar o server01

### 14.1 As duas ferramentas, que agora existem

**`core/scripts/pluginlint/pluginlint.csproj`** — o plugin compila?

```
dotnet build core/scripts/pluginlint/pluginlint.csproj -p:PluginFile=<abs .cs>
```

Roslyn contra as DLLs reais do `server01`, em ~2 s, com arquivo e linha. Três
coisas que custaram meia hora para descobrir e estão no cabeçalho dele:
`net48` + `NoStdLib` (senão todo `ReadOnlySpan<>` do Rust dá CS7069);
Newtonsoft **só** via `Oxide.References` (senão 80× CS0433 em cada
`[JsonProperty]`); e `CovalencePlugin`/`InfoAttribute`/`CommandAttribute` moram
no **`Oxide.CSharp.dll`**, não no `Oxide.Core` — que é onde se procura.

**`core/scripts/pluginlint/layout-check.mjs`** — a masmorra faz sentido?

```
node core/scripts/pluginlint/layout-check.mjs 200
```

Porta o `BuildLayout` e cobra as quatro invariantes (entrada livre, toda sala
com porta, corredor conectado, toda porta alcançável) em N sorteios, desenhando
o grid em ASCII. Uma sala sem porta **não dá erro nenhum**: ela nasce, fica
bonita, e ninguém entra — descobrir isso no jogo exige alguém andando por 78
células. Em 08/09/2026: 200/200 íntegros.

### 14.2 O jogo de verdade, pelo agente

As duas ferramentas acima não provam que a masmorra sobe — e nenhuma delas
pegaria os defeitos §5.3.8 e §5.3.9, que são de comportamento do motor.

**Lançar o `RustDedicated.exe` direto falha** nesta máquina (`EPERM` no spawn,
pelos dois shells). Mas isso não importa, porque **subir servidor é o trabalho
do agente**:

```bash
TOKEN=<AGENT_API_TOKEN do .env>
API=http://localhost:8787/api

# sobe (RCON conectado em ~20 s)
curl -X POST $API/servers/server01/operations -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"kind":"server-start"}'

# está no ar?
curl -s http://localhost:8787/health

# manda comando (a resposta vem CASADA — ver §7.5)
curl -X POST $API/servers/server01/rcon -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"command":"ozdungeon build entrance2 500 500"}'

# o que o plugin falou depois (é onde o #OZDUNGEON# aparece)
curl -s "$API/servers/server01/console?fromLine=0" -H "Authorization: Bearer $TOKEN"
```

O ciclo inteiro — subir, construir, conferir, derrubar — leva ~40 s e não
precisa de cliente de jogo. **Ligue o `Log detalhado`** da config antes de
depurar: é ele que diz quantas marcas de alçapão a planta tinha, quantas peças
foram puladas e onde cada tampa nasceu. Sem ele, um `no_hatch` é mudo.

O que se espera ver, nesta ordem:

```
[debug] planta: 1 marca(s) de alçapão
[debug] alçapão em (500.7, 34.1, 495.4) (de um vaso)
[debug] entrada: 42 peças em (500.00, 33.90, 500.00)
[debug] masmorra: 78 células, 12 salas, 336 peças
[debug] link: entrada=(500.7, 34.1, 495.4) saída=(500.00, -87.00, 500.00)
[debug] alçapões ligados: superfície y=34.1 ⇄ masmorra y=-87.0
Masmorra 'entrance2' de pé: 378 peças em 1269 ms. A entrada está em Q10.
#OZDUNGEON#{"slug":"entrance2",…,"entities":378,"ms":1269,"kind":"built"}
```

**O que ainda não foi exercitado:** o `OnDoorOpened` e o teleporte. Isso precisa
de um jogador abrindo o alçapão, e é a última milha da frente A.

### 14.3 Três avisos que a memória deste projeto já pagou

1. **o `server01` é compartilhado**, e a instalação dele já esteve incompleta —
   falta de bundle mata o boot antes do RCON. O Oxide ainda **compila** os
   plugins nesse estado, então o erro de compilação aparece no log mesmo assim;
2. **assinatura de hook errada não dá erro**: o hook simplesmente nunca é
   chamado. `OnPlayerViolation(BasePlayer, AntiHackType)` é a assinatura que o
   1.3.4 usa em produção, e é a que herdamos — mas ela é a primeira coisa a
   conferir se ninguém levar kick nem for salvo dele;
3. **fixture inventada testa a imaginação.** As respostas do plugin usadas em
   teste do agente têm de vir de **captura real** do console, nunca de um JSON
   escrito à mão a partir deste documento.

### 14.4 O teste que só este sistema pede

**Reconstruir com a mesma semente produz a mesma masmorra.** Ele roda no agente,
comparando dois `Layout()` — o que exige o `Layout` portado para TypeScript.
Vale a pena por três motivos ao mesmo tempo: é o que faz o modo permanente
sobreviver a um restart (§9.3), é o que o editor de planta usa para
pré-visualizar uma receita, e é como o §11.3 mostra "≈ 15 salas, ~45 células"
sem ir ao jogo. O `layout-check.mjs` é o rascunho dele.

---

## 15 — O que fica de fora, e por quê

| Fora | Por quê |
|---|---|
| Dungeon com mais de um andar | `Layout()` é 2D. Andar é reescrever o gerador, e uma dungeon de 20 salas já leva 12 minutos |
| Boss com fase e barra de vida | É um sistema próprio. NPC forte na sala vermelha já entrega 80% |
| Puzzle (alavanca, cartão, sequência) | O 1.3.4 já tem cartão e código; puzzle desenhado no painel é outro editor |
| Fila para entrar na dungeon | O `OrigemZQueue` existe e é outro assunto. Se virar problema, ele resolve |
| Ranking de dungeon | Depois de `event_runs` existir, é uma consulta. Não antes |
| Dungeon no site | A tela do jogo e o painel primeiro. O site consome o que já estiver de pé |

---

## Apêndice A — Os arquivos que este plano cria e toca

**Já existe (frente A, 08/09/2026):**

```
Plugins/OrigemZDungeon.cs                    1.606 linhas, compila limpo
core/scripts/pluginlint/pluginlint.csproj    o .cs compila? (§14.1)
core/scripts/pluginlint/layout-check.mjs     a geometria fecha? (§14.1)
Servers/server01/oxide/data/OrigemZDungeon/blueprints/*.json   as 7 plantas
```

**Cria:**

```
Plugins/OrigemZEvents.cs
core/src/dungeons/service.ts
core/src/dungeons/blueprint.ts          o JSON do CopyPaste: peças com posição
core/src/dungeons/layout.ts             o traçado: células, salas e os 6 defeitos
core/src/db/dungeon-layouts-repository.ts   o acervo de traçados (§4.2.1)
core/src/types/dungeon-layouts.ts       a régua + os 4 traçados de fábrica
core/src/dungeons/materializer.ts       grava a planta no oxide/data
core/src/events/scheduler.ts
core/src/events/sync.ts                 o push (base64) e o stream (#OZDUNGEON#)
core/src/db/events-repository.ts
core/src/db/dungeons-repository.ts
core/src/http/routes/events.ts
core/src/http/routes/dungeons.ts
panel/src/app/eventos/page.tsx
panel/src/components/events/*.tsx
panel/src/components/dungeons/layout-thumb.tsx   a miniatura do traçado
panel/src/components/dungeons/layout-shelf.tsx   o acervo, na aba Plantas
panel/src/components/ui/help-tip.tsx    ← design system
panel/src/components/ui/steps.tsx       ← design system
panel/src/lib/help/dungeons.tsx
```

**Toca:**

```
core/src/db/migrations.ts               057 a 061
core/src/index.ts                       registra as rotas e o agendador
panel/src/components/sidebar.tsx        o item "Eventos"
panel/src/lib/api.ts                    os tipos e os fetch
Docs/README.md                          a linha deste documento
```

---

*Escrito em 08/09/2026, contra o `DungeonBases 1.3.4` medido nesta máquina.*

