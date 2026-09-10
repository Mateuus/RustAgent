# As sete pendências da masmorra

**Levantadas pelo dono em 09/09/2026, olhando a tela.** Este documento separa
cada uma, diz o que existe hoje (medido, não suposto), o que falta, e o que
fazer. A ordem da lista é a ordem em que o dono falou; a ordem de execução
está no §9.

> **A descoberta que muda o tamanho do trabalho.** Metade disto **já está
> modelada no banco**. A tabela `world_events` (migração 058) tem
> `spawn_mode`, `interval_min/max`, `duration_min/max`, `min_online`,
> `marker_*` (sete colunas de marcador de mapa) e `msg_*` (cinco mensagens de
> chat). Nada disso tem rota, tela, agendador ou plugin do outro lado. O
> esquema foi escrito na frente do plano e o resto nunca veio.
>
> Ou seja: onde este documento diz "não existe", quase sempre quer dizer **"a
> coluna existe e ninguém a lê"** — o que é um trabalho muito menor que
> inventar do zero, e um risco maior de alguém achar que já funciona.

---

## Onde isto está — 09/09/2026

As sete foram implementadas na ordem do §9. O diagnóstico de cada uma
continua abaixo, porque é o que explica **por que** o conserto é esse.

| # | frente | estado | o que passou a existir |
|---|---|---|---|
| §6 | o editor cortava o labirinto | **feito** | a tela cresce até caber; a entrada deixou de ser cravada no centro. 241 de 241 células |
| §7 | entradas dropando armas | **feito** | `entranceItems` (`none`/`unarmed`/`all`), padrão **nada**; filtro no `FillContainer` |
| §1 | o botão ▶ | **feito** | `POST /dungeons/:id/build`, `DungeonSync.build`, botão **Erguer** na lista |
| §4 | pontos de nascimento | **feito** | tabela `dungeon_spawn_points`, aba **Onde nasce**, clique no mapa, `ozdungeon onde … json` |
| §3 | marcador e chat | **feito** | `CreateMarker`/`Broadcast` no plugin, passo **Mapa e chat** no editor |
| §2 | o agendador | **feito** | `DungeonScheduler`, `world_events.dungeon_id`, aba **Agenda** |
| §5 | as configs confusas | **feito** | o ✓ passou a significar "mexi aqui"; o rodapé fala do passo aberto; o modo subiu para o topo |

**O que NÃO foi feito, e é deliberado:** o marcador do 1.3.4 mostra o tempo
restante no rótulo (`Masmorra (12m30s)`). Isso exige o plugin saber a duração,
que hoje é do agendador — o `#close` do agente é quem derruba. Fica para
quando o plugin passar a receber a duração junto do comando.

**Duas coisas para conferir no jogo** (nenhuma dá para provar daqui):

1. o círculo aparece no mapa e some quando a masmorra fecha;
2. as caixas da casinha da `entrance2` nascem vazias — e o alçapão continua
   abrindo, porque a marca é lida do JSON e não do container.

---

## 1. Não há como ligar a masmorra pelo painel

> *"cadê a opção de ligar uma masmorra manualmente tipo um play?"*

### O que existe hoje

Nada. O único caminho para uma masmorra nascer é **o admin entrar no jogo e
colar um comando**. É o passo ⑥ do editor, e ele diz isso com todas as letras:

```
Onde ela nasce
Esta é a única parte que não dá para fazer daqui — e não é limitação, é o ponto.
Entre no jogo, vá até o lugar, olhe para a direção em que ela deve crescer, e cole:
/ozdungeon build visita
```

— [dungeon-dialog.tsx:1969](../../panel/src/components/dungeons/dungeon-dialog.tsx#L1969)

O painel copia a frase para a área de transferência e fica **esperando** o
admin fazer o trabalho ([WatchPanel](../../panel/src/components/dungeons/dungeon-dialog.tsx#L2036)),
sondando `/dungeons/:id/runs` de dois em dois segundos até uma linha aparecer.

### O que já está pronto e ninguém usa

O comando **aceita coordenadas pelo console**:

```
ozdungeon build <slug> <x> <z> [graus]
```

— [dungeon-contract.ts:54](../../core/src/game/dungeon-contract.ts#L54)

E o agente **já sabe mandar comando de masmorra por RCON**: `DungeonSync.demolish()`
manda `ozdungeon stop` e é chamada pela rota de parar
([sync.ts:210](../../core/src/dungeons/sync.ts#L210), [world-events.ts:127](../../core/src/http/routes/world-events.ts#L127)).
O caminho de ida existe inteiro. Falta o botão e a rota que o aciona.

### O que falta

| peça | onde |
|---|---|
| `DungeonSync.build(serverId, slug, x, z, yaw)` | `core/src/dungeons/sync.ts` |
| `POST /dungeons/:id/build` — corpo `{ serverId, x, z, yaw }` ou `{ serverId, spotId }` | `core/src/http/routes/dungeons.ts` |
| Botão ▶ na lista, e no passo ⑥ | `dungeon-list.tsx`, `dungeon-dialog.tsx` |

**A regra que a rota tem de cobrar:** só uma masmorra de pé por servidor. O
plugin já recusa a segunda (`already_active`), mas o painel precisa dizer isso
**antes**, com o nome da que está no chão — senão o admin clica em ▶ e nada
acontece, sem explicação.

**O que a rota NÃO pode fazer:** inventar sucesso. `demolish()` devolve
`false` quando o RCON está fora, e a rota de parar trata isso
([world-events.ts:140](../../core/src/http/routes/world-events.ts#L140)) —
por causa de um defeito medido em 09/09: o painel afirmava ter derrubado uma
masmorra que continuava de pé. A rota de subir herda a mesma disciplina: manda
primeiro, e só declara o que o servidor confirmou. A confirmação real é o
`built` que chega pelo stream `#OZDUNGEON#`, não a resposta do RCON.

### Como conferir

Clicar em ▶ com o server01 no ar → a masmorra sobe em segundos, o histórico
ganha uma linha `active`, e `ozdungeon status` no console mostra as peças.
Clicar com o servidor parado → a tela diz que não deu, e **não** aparece
nenhuma linha nova no histórico.

---

## 2. Não existe ativação automática nem agenda

> *"temos que fazer um sistema de ativação, sheduler etc.."*

### O que existe hoje

O esqueleto inteiro, sem o relógio.

A tabela `world_events` tem as colunas de agendamento — `spawn_mode`
(`schedule` | `manual` | `permanent`), `interval_min`/`interval_max` (a janela
do sorteio, em segundos), `duration_min`/`duration_max`, `min_online`,
`count_after_end`. A tabela `world_event_runs` tem o status `scheduled` e a
coluna `scheduled_for`. **Zero linhas em `world_events`**: nenhum evento foi
cadastrado porque não há tela para cadastrar.

A página de eventos já admite a falta, num comentário:

> *"A quarta aba do plano (a agenda dos eventos automáticos) chega com o
> agendador. Uma aba vazia hoje seria uma promessa que a tela não cumpre."*
> — [eventos/page.tsx:11](../../panel/src/app/eventos/page.tsx#L11)

### O molde já existe no projeto

`WipeScheduler` ([core/src/wipe/scheduler.ts](../../core/src/wipe/scheduler.ts))
é o relógio do wipe, e ele resolveu os três problemas que todo agendador tem:

1. **Mora no agente, não num plugin.** Plugin não roda com o Oxide quebrado.
2. **O tick nunca lança.** Uma exceção sem dono mata o `setInterval`, e a
   partir dali nada acontece — em silêncio, que é o pior desfecho de um
   relógio. Cada servidor num `try` próprio.
3. **Reentrância.** Uma volta que demora mais que o intervalo não pode
   atropelar a seguinte (`#ticking`).

O agendador de masmorra copia esse desenho. O que ele acrescenta:

- **sorteio dentro da janela** — o próximo nascimento é `agora + rand(interval_min, interval_max)`;
- **a regra do `min_online`** — abaixo do mínimo, **adia**, não pula. Evento
  para ninguém é loot de graça para o primeiro que logar;
- **`count_after_end`** — a próxima contagem só começa quando esta terminar;
- **a janela do wipe** — o contrato já tem o motivo de falha `wipe_window`.
  Uma masmorra que nasce dez minutos antes de o mapa ser trocado é lixo;
- **duração** — quem derruba é o agendador, no fim do `duration` sorteado,
  pelo mesmo `demolish()` do painel.

### O que falta

| peça | onde |
|---|---|
| `WorldEventScheduler` — o relógio | `core/src/dungeons/scheduler.ts` (novo) |
| Rotas de CRUD de `world_events` | `core/src/http/routes/world-events.ts` (só faltam as de escrita) |
| Aba **Agenda** na tela de eventos | `panel/src/app/eventos/page.tsx` |
| Retomada no boot | `core/src/index.ts` — ver §9.1 |

### A retomada, que é onde isto costuma quebrar

O wipe já pagou esse preço: reiniciar o agente matava a execução em curso, e
hoje o boot a retoma sozinha (memória `reiniciar-o-agente-mata-o-wipe`). O
agendador de masmorra nasce com a mesma regra: uma run `active` cuja duração
já venceu enquanto o agente estava fora é **encerrada no boot**, e as
`scheduled` vencidas disparam ou são reagendadas — nunca ficam paradas
esperando um tick que já passou.

---

## 3. Não sabemos se marca no mapa nem se avisa no chat — e não faz nem um nem outro

> *"Temos que verificar se está marcando no mapa e se alerta no chat."*

**Verificado. Não faz nenhum dos dois.**

### O mapa

`grep -n "MapMarker" Plugins/OrigemZDungeon.cs` → **nenhuma ocorrência**. O
plugin não cria marcador nenhum. A masmorra nasce invisível: quem não viu o
chat não tem como saber que ela existe, nem onde.

O banco tem as sete colunas (`marker_enabled`, `marker_label`, `marker_color`,
`marker_alpha`, `marker_radius`, `marker_show_owner`, `marker_show_time`) e
ninguém as lê.

**E o código de referência está no repositório.** `DungeonBases 1.3.4` faz
exatamente isto ([DungeonBases-1.3.4.cs:2708](DungeonBases-1.3.4.cs#L2708)):
dois prefabs empilhados —

```
assets/prefabs/tools/map/genericradiusmarker.prefab   → o círculo (raio, cor, alfa)
assets/prefabs/deployable/vendingmachine/vending_mapmarker.prefab  → o texto
```

O círculo é filho do marcador de vending, que é quem carrega o `markerShopName`
— o texto que aparece ao passar o mouse. O `VendingUpdate` reescreve esse nome
a cada tick para mostrar o tempo restante (`Masmorra (12m30s)`).

É **porte**, não invenção. As colunas do nosso banco são cópia campo a campo
da config do 1.3.4.

### O chat

Existe **um** caminho de fala, e ele só alcança quem já está lá dentro:

```csharp
/// <summary>Uma linha no chat de quem está lá dentro.</summary>
private void Announce(ActiveDungeon dungeon, string message)
{
    foreach (var id in dungeon.inside) { ... player.ChatMessage(message); }
}
```

— [OrigemZDungeon.cs:2727](../../Plugins/OrigemZDungeon.cs#L2727)

Usado uma vez: `"A porta da sala verde foi aberta."`. Não há
`ConsoleNetwork.BroadcastToAllClients`, não há `server.say`, não há nada que
alcance o servidor.

As cinco mensagens do banco (`msg_start`, `msg_location`, `msg_warning`,
`msg_end`, `msg_denied`) nunca saíram de lá — e elas já aceitam a marcação de
chat do projeto (`game/chat-markup.ts`), a mesma das mensagens automáticas.

### O que falta

| peça | onde |
|---|---|
| `CreateMarker()` / `UpdateMarker()` / `KillMarker()` | `Plugins/OrigemZDungeon.cs` |
| `MarkerSpec` e `MessagesSpec` no `DungeonSpec` do sync | plugin + `core/src/dungeons/sync.ts` |
| Broadcast no `built`, no aviso de fim e no fim | plugin |
| Campos na tela | novo passo/aba de "Anúncio" |

**O detalhe que decide se presta:** `msg_location` deve dizer a **grade**
(`E7`), não a coordenada. O plugin já calcula isso (`Grid(point)`) e o
histórico já grava (`world_event_runs.grid`). "A masmorra nasceu em E7" é
jogável; "(-1330, 871)" não é.

**A armadilha do marcador:** ele tem de morrer junto com a masmorra. O 1.3.4
mata os dois no `EventEnd` ([1.3.4:1390](DungeonBases-1.3.4.cs#L1390)). Um
marcador órfão fica no mapa até o wipe apontando para o nada — e como nada da
masmorra entra no save do mundo, ninguém consegue apagá-lo depois.

---

## 4. O admin não pode escolher onde ela nasce

> *"o admin pode definir posições que ela vai spawn. que ele determina e já sabe"*

### O que existe hoje

**O oposto exato.** Existe `world_event_zones`, e o cabeçalho do repositório a
descreve assim:

```
world_event_zones                    onde nada nasce
```

— [world-events-repository.ts:7](../../core/src/db/world-events-repository.ts#L7)

São zonas de **exclusão**: x, z, raio, e a promessa de que nada nasce dentro
delas. Elas têm rota (`GET/POST/DELETE /servers/:id/event-zones`), chegam ao
plugin pelo sync, e o plugin **as ignora** — só conta quantas recebeu:

```csharp
Puts("estado recebido: " + next.dungeons.Count + " masmorra(s), "
     + next.zones.Count + " zona(s) proibida(s)");
```

— [OrigemZDungeon.cs:4536](../../Plugins/OrigemZDungeon.cs#L4536)

Zero zonas cadastradas no banco. Zero tela.

### O que o dono quer é outra coisa

Ele quer **pontos de nascimento**: lugares que ele escolheu, olhando o mapa,
sabendo que servem — "aquela encosta com vista, longe das bases, perto da
estrada". Não uma área proibida: uma **lista de endereços bons**.

Isso é uma tabela nova, e ela precisa de mais que x/z:

| coluna | por quê |
|---|---|
| `label` | "Encosta do lago", "Atrás do aeroporto" — o admin escolhe pelo nome |
| `x`, `z` | onde |
| `yaw` | **para onde ela cresce.** Hoje isso vem de para onde o admin está olhando quando cola o comando; num ponto salvo, tem de estar salvo junto |
| `enabled` | desligar um ponto sem perdê-lo |
| `last_used_at` | para o sorteio não repetir o mesmo ponto duas vezes seguidas |
| `server_id` | o mapa é de um servidor; o ponto morre com o wipe do mapa |

**A regra do wipe:** um ponto é de um mapa. Trocou o mapa, os pontos viraram
mentira — e uma masmorra que nasce dentro de uma rocha é o defeito que o dono
já pagou uma vez ("a entrada nasceu dentro de um rio, e ele morreu no instante
em que o teleporte o levou até lá", [OrigemZDungeon.cs:740](../../Plugins/OrigemZDungeon.cs#L740)).
Então: ou os pontos são apagados no wipe, ou são marcados como "de outro mapa"
e a tela cobra revalidação. **Apagar é mais honesto.**

### A ferramenta que já existe para validar

`ozdungeon onde <x> <z>` responde se um ponto serve:

```
E7 (-1330, 871) · chão em y=12.4 · água em y=0.0 · profundidade 0.0 m · serve
```

Ela nasceu justamente desse acidente. **A tela de pontos tem de usá-la**: ao
salvar um ponto, o agente pergunta ao servidor se aquele chão serve, e o painel
mostra a resposta. Um ponto salvo sem essa checagem é uma armadilha guardada.

### O que falta

| peça | onde |
|---|---|
| Tabela `dungeon_spawn_points` + migração | `core/src/db/migrations.ts` |
| Repositório + rotas `GET/POST/PUT/DELETE /servers/:id/spawn-points` | `core/src/db/`, `core/src/http/routes/` |
| Validação via `ozdungeon onde` na escrita | rota |
| Tela: clicar no mapa para marcar | reusar `components/map-view.tsx` |
| Uso no ▶ (§1) e no agendador (§2) | ambos |

---

## 5. A tela de configuração está confusa

> *"as config está muito confusa IMG 3"*

### O que a tela é hoje

Um diálogo de **seis passos** e ~2.560 linhas
([dungeon-dialog.tsx](../../panel/src/components/dungeons/dungeon-dialog.tsx)):

```
① Identidade  ② Desenho/Tamanho  ③ Salas e loot  ④ Inimigos  ⑤ Entrada e acesso  ⑥ Construir
```

### Os três defeitos que a captura mostra

**a) Todos os passos aparecem com ✓ verde, inclusive os que ninguém abriu.**

O `done` de quatro dos seis passos é literalmente `true` cravado:

```js
{ id: 'tamanho',   label: …,             done: true },
{ id: 'inimigos',  label: 'Inimigos',    done: true },
{ id: 'entrada',   label: 'Entrada e acesso', done: true },
```

— [dungeon-dialog.tsx:336-342](../../panel/src/components/dungeons/dungeon-dialog.tsx#L336)

Um ✓ que aparece sempre não informa nada. Pior: ele diz "está pronto" sobre um
passo em branco. O selo tem de significar **"eu mexi aqui"** ou **"isto tem
valor válido e não-padrão"** — ou não existir.

**b) O rodapé fala do passo ⑥ enquanto você está no ①.**

> *"Salva. O jogo já recebeu — falta escolher onde ela nasce, no passo
> Construir."*

Correto e fora de hora: quem está escolhendo o nome não tem o que fazer com
essa frase, e ela ocupa o lugar onde deveria estar o que fazer **agora**.

**c) O passo ① mistura três assuntos.**

Nome e identificador (identidade) · Receita ou planta (a decisão mais
importante da masmorra, e a que muda os passos seguintes) · um cartão de
explicação genérica ("A masmorra fica 90 metros abaixo do mundo").

O modo é o que reconfigura a tela inteira — o passo ② vira "Desenho" ou
"Tamanho" conforme ele. Escondê-lo embaixo de dois campos de texto é enterrar a
bifurcação.

### A proposta

1. **O ✓ passa a significar uma coisa só**: o passo tem informação além do
   padrão de fábrica. Passo intocado fica cinza. Passo com problema fica
   âmbar — já existe (`problem`), mas some debaixo do verde.
2. **O rodapé fala do passo aberto**, e do próximo. A frase sobre o ⑥ mora no ⑥.
3. **A escolha do modo sobe para o topo do ①**, antes do nome, com o efeito
   dito em uma linha ("o servidor sorteia" × "você desenha").
4. **A explicação genérica sai do fluxo** e vira o "Como funciona" que já
   existe no cabeçalho da página.
5. **Os passos ganham as pendências novas**: com §1–§4 implantados, aparecem
   "Onde nasce" (pontos) e "Anúncio" (mapa + chat). Seis passos viram sete ou
   oito — o que reforça que a arrumação vem **antes**, e não depois.

Isto é a única frente sem um "certo" objetivo. **Faço a proposta acima em tela
e o dono aprova ou corta.**

---

## 6. Escolher o LABIRINTO corrompe o desenho

> *"IMG3 quando escolho labirito fica todo bugado."*

**É um defeito, e está medido.** De 241 células do traçado, o editor mostra
**84**. As outras 157 — 65% do desenho — são descartadas em silêncio.

### A causa

O editor tem uma tela fixa de 24×24 e **a entrada cravada no centro** (12,12):

```js
const SIZE = 24;
/** O centro da tela é a entrada. */
const ENTRANCE = { x: Math.floor(SIZE / 2), z: Math.floor(SIZE / 2) };
```

— [dungeon-grid-editor.tsx:105](../../panel/src/components/dungeons/dungeon-grid-editor.tsx#L105)

Ao carregar um traçado, `fromRows()` procura o `E` e alinha o desenho **por
ele**, para que caia no centro:

```js
offsetX = ENTRANCE.x - column;
offsetZ = ENTRANCE.z - (height - 1 - index);
```

— [dungeon-grid-editor.tsx:589](../../panel/src/components/dungeons/dungeon-grid-editor.tsx#L589)

O labirinto tem 23×23 **com a entrada no canto superior esquerdo** (linha 1,
coluna 1). A conta dá:

```
offsetX = 12 - 1  = 11
offsetZ = 12 - 21 = -9      ← negativo
```

Com `offsetZ = -9`, as nove linhas de baixo caem em `z` negativo e
`canvas[z]` é `undefined` → **a linha inteira é jogada fora**. Com
`offsetX = 11`, as colunas a partir da 13 caem em `x ≥ 24` → **descartadas**.

Sobra o quadrante superior-esquerdo, 14 linhas × 13 colunas, encostado no canto
direito de baixo da tela — que é exatamente o que a captura mostra, incluindo o
rodapé:

```
84 células · 3 sala(s)
50 célula(s) de corredor não chegam na entrada: essa parte fica ilhada.
```

Simulei a função sobre o traçado do banco: **84 células, 3 salas**. Bate com o
pixel.

### O defeito debaixo do defeito

**O que a tela mostra e o que é salvo divergem.** O editor só emite
`onChange` quando alguém pinta. Carregar um traçado não emite nada — então
`draft.grid` continua com o desenho **inteiro** (241 células) enquanto a tela
mostra a versão mutilada. Salvar sem tocar em nada grava o traçado completo;
tocar em uma célula grava a versão de 84.

Ou seja, o mesmo clique produz dois resultados diferentes conforme o admin
tenha ou não encostado no grid. Este é o pedaço mais perigoso da pendência.

### Por que a entrada está no centro, e por que ela não precisa estar

Nada no jogo exige isso. O plugin translada tudo para o `E` cair em (0,0):

```csharp
// 1) Onde está o E. Ver o cabeçalho: tudo é transladado para que ele caia em (0,0).
offsetX = -column;
offsetZ = -(rows.Count - 1 - index);
```

— [OrigemZDungeon.cs:1505](../../Plugins/OrigemZDungeon.cs#L1505)

A entrada pode estar em qualquer célula do desenho. O centro é uma conveniência
do editor que virou uma trava.

### O conserto

1. **`fromRows` deixa de cortar.** Se o desenho não cabe alinhado pela
   entrada, ele é **encaixado** — a entrada sai do centro e vai para onde o
   desenho couber. A entrada é uma célula como as outras, e o editor a marca
   em amarelo em vez de fixá-la em (12,12).
2. **Desenho maior que a tela é recusado com uma frase**, nunca cortado calado.
   O limite real é o do plugin: `MaxGridCells = 600`
   ([OrigemZDungeon.cs:1495](../../Plugins/OrigemZDungeon.cs#L1495)) e 64×64
   no schema. Se 24×24 fica pequeno, a tela cresce até 32×32 — 1.024 células,
   ainda abaixo do teto do schema, e o teto de 600 células **pintadas**
   continua sendo cobrado pelo verificador.
3. **Carregar um traçado emite `onChange`** com o que a tela realmente mostra.
   Fim da divergência.
4. **O gerador ("Sortear um traçado") passa a produzir desenhos que cabem** —
   ou a tela cresce até caber o que ele produz. Hoje ele gera 23×23 com a
   entrada no canto, o que garante o corte.

### Como conferir

Abrir o labirinto → a tela mostra 241 células e 12 salas, o mesmo da
miniatura. Salvar, reabrir, comparar: idêntico. Construir no jogo e andar até o
fim de um corredor que hoje é cortado.

---

## 7. As entradas dropam armas

> *"as entrandas tem que parar de dropar armas"*

**Confirmado, e é pior do que parece.**

### O que as plantas de entrada carregam

O plugin copia os itens gravados no JSON da planta para dentro dos containers
dela ([FillContainer, OrigemZDungeon.cs:4002](../../Plugins/OrigemZDungeon.cs#L4002)).
Resolvi os `itemid` das quatro plantas contra o catálogo do banco:

| planta | o arsenal que ela traz |
|---|---|
| **entrance1** | AK, LR-300, M249, MP5, Thompson, SKS, M39, Spas-12 ×2, M4 Shotgun ×2, Pump Shotgun, Custom SMG, Handmade SMG, M92, Python, Prototype 17, Revolver, F1, **200 explosives**, 400 gunpowder, **1.000 scrap**, 998 HQM, óculos de visão noturna, roadsign completo |
| **entrance2** | **M249** |
| **entrance3** | **Minigun + Rocket Launcher** |
| **entrance4** | Compound Bow, Crossbow, Machete, Longsword, Mace, Baseball Bat, Salvaged Cleaver, 983 HQM |

A `entrance2` é a entrada das **duas** masmorras cadastradas hoje (`visita` e
`labirinto`). Toda vez que uma delas nasce, uma M249 nasce junto na superfície.

Isso não é loot desenhado: é o entulho de quem copiou a construção com as
caixas cheias, em outro servidor, e exportou. Passou a valer como conteúdo por
acidente.

### O conserto

O `FillContainer` ganha um filtro, e o padrão é **não copiar**. Três níveis:

| modo | o que entra |
|---|---|
| `nada` (padrão) | nenhum item da planta |
| `sem-armas` | tudo menos `Weapon`, `Ammunition` e explosivos |
| `tudo` | o de hoje, para quem desenhou a planta de propósito |

**A armadilha:** o fertilizante **não pode ser filtrado por acidente**. A marca
do alçapão é *"um `planter.large` com 1 fertilizante no slot 0 e 999 no slot
5"*. Mas ela é lida do **JSON**, não do container montado
([IsEntranceHatchMarker, OrigemZDungeon.cs:3883](../../Plugins/OrigemZDungeon.cs#L3883)) —
e o vaso marcado é morto e convertido em alçapão logo depois. Então filtrar os
itens **não** quebra a detecção. Vale um teste explícito, porque o sintoma
seria "a masmorra parou de abrir" e a causa estaria a 500 linhas dali.

**Onde a escolha mora:** é uma configuração da masmorra
(`entrance.keepBlueprintItems`), não do plugin — a mesma planta pode ser
entrada de duas masmorras com regras diferentes. Vai no sync como campo do
`DungeonSpec`.

### Como conferir

Subir a `visita` (que usa a `entrance2`) e abrir cada caixa da casinha: vazias.
Descer o alçapão: a masmorra abre — a marca continua funcionando.

---

## 8. O que este documento NÃO cobre

Levantado no caminho, e fora do que o dono pediu:

- **As zonas de exclusão chegam ao plugin e ele as ignora** (§4). Elas têm
  rota e sync, e nenhum efeito. Ou passam a valer, ou saem.
- ~~**`world_events` não tem rota de escrita.**~~ **Errei aqui**: elas
  existem desde a 057 (`POST`/`PUT`/`DELETE /world-events`). O que faltava era
  a coluna `dungeon_id` — a tabela dizia QUANDO um evento acontece e não tinha
  onde guardar O QUE acontece.
- **A masmorra não sobrevive a um restart do servidor de jogo.** Nada dela
  entra no save (`EnableSaving(false)`); a coluna `world_event_runs.seed`
  existe justamente para reconstruí-la idêntica, e ninguém a usa. Uma masmorra
  `permanent` sem isso é uma masmorra que some no primeiro restart.

---

## 9. A ordem de execução

Do que destrava mais para o que depende dos outros:

| # | frente | tamanho | depende de |
|---|---|---|---|
| 1 | **§6** o editor corta o labirinto | pequeno | — |
| 2 | **§7** entradas dropando armas | pequeno | — |
| 3 | **§1** o botão ▶ | médio | — |
| 4 | **§4** pontos de nascimento | médio | §1 |
| 5 | **§3** marcador de mapa + chat | médio | — |
| 6 | **§2** o agendador | grande | §1, §3, §4 |
| 7 | **§5** arrumar as configs | médio | todas (a tela muda com elas) |

§1 e §2 são a mesma máquina vista de dois lados: **quem manda construir**. O
botão é o gatilho manual; o agendador é o gatilho por relógio. Fazer o botão
primeiro deixa o caminho todo — RCON, confirmação, histórico — testado à mão
antes de um relógio começar a puxá-lo sozinho às três da manhã.

### 9.1 O que não pode ser esquecido no caminho

- **O agente reinicia.** O wipe já aprendeu isso do jeito caro. Toda run com
  duração pendente tem de ser retomada ou encerrada no boot.
- **O plugin recompila.** `[Command]`, nunca `[ConsoleCommand]` — em
  `CovalencePlugin` o segundo compila, carrega e não registra nada, e o
  sintoma é `RCON_TIMEOUT`.
- **A resposta do comando vem casada.** O `Reply` volta no POST /rcon e some
  do buffer do console; procurar no console faz o comando parecer mudo.
- **O plugin daqui não é o de produção.** O agente de produção roda em outra
  máquina; validar `.cs` sem servidor é `core/scripts/pluginlint/`.

---

## 10. A entrada virada: por que errei três vezes

**09/09/2026, com o dono dentro do jogo.** Ele apontou uma coisa só — "a
entrada está virada ao lado contrário do corredor, 90 graus" — e eu precisei de
três tentativas para acertar. Este parágrafo existe para que a quarta não
aconteça.

### O defeito de verdade

Duas construções, um único `forward`:

- **A casinha** é colada apontando para o `forward` — a direção que o ponto de
  nascimento manda.
- **A masmorra** usa esse mesmo `forward` como o eixo **Z** do desenho, e o
  `right` (o `forward` girado 90°) como o eixo **X**.

No traçado "Labirinto", o `E` tem o corredor à **direita** (`.E##…`) — ou seja,
no eixo X. O corredor saía exatamente noventa graus fora de onde a casinha
olhava.

Nada estava errado isoladamente. Eram dois sistemas de coordenadas que ninguém
tinha juntado.

### As três tentativas, e o que cada erro ensinou

**1ª — girei a rotação das plantas.** Descobri que o CopyPaste grava rotação em
**radianos** e o plugin lia como **graus**; consertei, e a casinha parou de
nascer desmontada. Era um defeito real e independente — mas **não era o que ele
tinha apontado**. Eu tinha achado um bug e presumido que era *o* bug.

*A lição:* achar um defeito verdadeiro no caminho não é o mesmo que responder à
pergunta. Devia ter confirmado o sintoma antes de comemorar a causa.

**2ª — girei o jogador.** Interpretei "ao entrar está virado" como a direção do
olhar de quem desce, e fiz o teleporte virar o jogador para o corredor. Isso
também era verdade — o `Teleport` do Rust move o corpo e não toca no olhar —,
e também não era o pedido.

*A lição:* eu estava lendo capturas de tela e **adivinhando**, com os dados na
mão. A altura do jogador (`y = -89.9` contra o piso em `-87.25`) e a bússola da
foto estavam disponíveis o tempo todo; bastava medir antes de escrever código.
Só fui medir na terceira.

**3ª — girei a casinha.** Alinhava a casinha ao corredor e piorava o resto: a
porta passava a apontar para qualquer lado do terreno, e quem descia continuava
chegando de lado.

*A lição:* quando duas coisas estão desalinhadas, existe uma peça **certa** para
girar, e as outras duas produzem um resultado que parece bom de um ângulo só.

### O que ficou

Gira a **masmorra**. O desenho continua idêntico — corredores, salas e portas no
mesmo lugar —, só o norte dele muda; e o corredor passa a sair para onde a
casinha aponta, que é para onde quem desce olha. Uma peça, os dois problemas.

### Por que demorou: não havia como verificar

O ciclo inteiro — escrever, compilar, instalar no servidor, erguer, o dono
entrar e olhar — era o único jeito de saber se tinha funcionado. Três voltas
disso.

`core/test/dungeon-alinhamento.test.ts` fecha essa porta. Ele prova a
invariante para os cinco traçados de fábrica e para o "Labirinto":

> escolhida uma direção qualquer para a casinha, depois do giro do construtor o
> corredor sai **exatamente** naquela direção.

E trava a ordem de procura (frente, direita, esquerda, trás), que é o que decide
qual saída o jogador vê quando a entrada tem mais de uma.

**O que ele NÃO cobre, e é honesto dizer:** a conta vive em três lugares — o
construtor em C#, a seta do editor em TSX e o teste. As duas primeiras são
compiladas separadamente e não podem importar uma da outra, como já acontece com
o `checkLayout`. Mudar o C# sem mudar o teste passa despercebido. O teste trava a
**regra**, não as duas implementações dela.

### A seta, e por que ela virou um controle

Enquanto a masmorra não girava, uma seta na célula da entrada seria uma
descrição útil: "o corredor sai por aqui". Depois do conserto ela virou uma
meia-verdade — descrevia o desenho, e o jogo já girava.

Então ela deixou de descrever e passou a **decidir**: clicar gira um quarto de
volta, e a quarta volta devolve o automático. É a coluna `entrance_facing` da
migração 071, e o construtor a respeita por cima do automático.

