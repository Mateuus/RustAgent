# Paredes no lugar, masmorra longe do metrô, corpo feito à mão, skins e o aviso com visual

**Pedido do dono em 16/09/2026.** Duas correções (as plantas desenhadas e o
interior escuro) e quatro recursos: mensagens com visual, skins de construção,
construção feita no jogo como corpo da masmorra e os três marcadores.

Este documento diz **o que existia, o que estava incompleto e o que foi
criado**, o que foi **medido** no `server01`, as decisões que não são óbvias e
— no §9 — o que ainda depende de alguém dentro do jogo.

> **As duas correções tinham causas diferentes, e as duas foram medidas.** As
> paredes erradas vinham de um eixo de rotação que ninguém girava; o interior
> escuro, do poço de uma entrada do metrô que a masmorra atravessava. A altura
> final nunca dependeu do ponto escolhido: pico e baixada ficam a -90.

---

## Onde isto está — 17/09/2026

| # | pedido | estado | o que passou a existir |
|---|---|---|---|
| §1 | plantas desenhadas com parede errada | **corrigido e medido** | a fundação nasce girada com a masmorra |
| §2 | interior escuro | **causa medida e corrigida** | `SettleDepth`: a masmorra desce quando cruza túnel, peça do mundo, terreno ou água |
| §3 | mensagens de surgimento e fim com visual | **feito** | `announce.tag/tagColor/color/size`, prévia no painel, entrega pelo OrigemZChat |
| §4 | skins de construção em "Salas e loot" | **feito e medido** | catálogo do jogo, `*Skin` em todo bloco de material |
| §5 | construção do jogo como corpo | **feito e medido** | modo `construction`, `body`, leitura do JSON, colagem a -90 |
| §6 | os três marcadores | **feito e medido** | lápide, velas grandes e árvore de Natal |

**Migração:** `099 dungeon-body-skins-announce`. As ids 096 a 098 estão
ocupadas em outras branches; a 099 é a primeira livre em todas.

**Nada muda para quem não mexer em nada.** Skin zero é o bloco de sempre;
visual vazio é a linha simples de sempre; o modo continua `recipe` ou
`blueprint` até alguém escolher `construction`.

---

## 0. O inventário que veio antes do código

| área | o que existia | o que estava incompleto | o que foi criado |
|---|---|---|---|
| desenho → jogo | `LayoutFromGrid`, `GridExitYaw`, paredes filhas da fundação | a fundação nascia com a rotação do MUNDO | fundação com `LookRotation(forward)` |
| profundidade | `origin.y = config.baseDepth` (-90), fixo | nenhuma conferência do que existe a -90 | `SettleDepth` / `DepthConflict` |
| seta da entrada (painel) | `nextFacing` | nunca voltava ao automático | compara com o automático |
| anúncio | `announce.onBuild/onEnd/showGrid`, `player.ChatMessage` | sem tag, cor, tamanho nem prévia; `{nome}` era o slug | visual, prévia, OrigemZChat, `{nome}` = nome |
| material | `structure`, `rooms[].grade`, `corridor.grade`; `PrepareBlock` já aplicava skin de PLANTA | peça gerada nunca recebia skin | `foundationSkin/wallSkin/ceilingSkin` |
| biblioteca | `kind: 'entrance'|'base'` pelo nome do arquivo; `base` aparecia como "masmorra" | **nada** usava `base`; não havia como trocar o papel | `PATCH` do papel, contagem de marcadores, relatório no upload |
| corpo | — | não existia caminho que colasse planta a -90 | modo `construction`, `BuildBody`, `PasteRole.Body` |
| marcadores | — | — | `dungeons/body.ts` + `IsBodyMarker` |
| falhas | `FAILURE_REASONS` | o plugin mandava `build_error`, que a lista não tinha: a run nunca fechava | `build_error` na lista |

---

## 1. As paredes das plantas desenhadas

### A causa, medida

O construtor põe cada fundação em `origin + right·x + forward·z`, com `right` e
`forward` girados pelo ponto de nascimento **e** pela saída do `E`
(`GridExitYaw`). A posição girava. A **rotação** da fundação, não: ela nascia
em `R0`, a do mundo.

Parede, vão e teto nascem como FILHOS da fundação, em `localPosition` ±1,5 nos
eixos locais dela. Com a fundação parada no eixo do mundo, a parede da vizinha
"à direita no desenho" caía à direita **no mundo**.

Medido no server01 com o "Labirinto" (496 arestas que pedem parede), parede
por parede (`ozprobe.pieces` + `walls.mjs`, no scratchpad da sessão):

| giro do ponto | antes | depois |
|---|---|---|
| 90° (o ponto de dev) | 496/496 | 496/496 |
| 0° | **122/496**, 374 faltando, 228 fora do lugar | 496/496 |
| 45° | **0/496** (todas fora da grade) | 496/496 |
| 217° | — | 496/496 |

No giro 0°, a entrada perdia a parede de trás (`0,-1|0,0`) e ganhava uma entre
o `E` e o corredor (`0,0|1,0`): **é exatamente o defeito relatado.**

### Por que o preset "funcionava"

O ponto de dev tem `yaw: 90`, e o "Labirinto" sai do `E` para a direita
(`GridExitYaw` = 90). Os dois giros se anulam, e o `forward` volta a ser o norte
do mundo. Um preset cujo `E` sai para cima (`GridExitYaw` = 0) num ponto de
yaw 0 também acerta. Qualquer outra combinação — a seta clicada, um ponto com
outro yaw — quebrava.

### A correção

`cellRotation = Quaternion.LookRotation(forward, up)`, que tem +z em `forward` e
+x em `Cross(up, forward)` — o mesmo `right` do construtor.

`core/test/dungeon-paredes-giradas.test.ts` porta a conta do C# e cobra os
quatro lados de saída e os quatro traçados de fábrica em oito giros; o controle
negativo reproduz o defeito antigo.

### A seta que não voltava

`nextFacing` recebia a seta já com a escolha aplicada, e `escolha + 90` nunca é
igual à escolha: o automático nunca voltava, e o `entranceFacing` ficava
gravado. Agora ela compara com o automático. Com a fundação girada, um
`entranceFacing` gravado não quebra mais nada — ele só gira o desenho.

---

## 2. A escuridão

### A hipótese da profundidade, conferida

A altura final **não depende do ponto**: `origin.y = config.baseDepth`, absoluto.
Medido: a mesma planta no pico do mapa (980, 110, terreno a 133 m) e no ponto de
dev (terreno a 22 m) tem o alçapão de saída em **-87,25** nos dois.

O que muda ao trocar de ponto é o **x/z**.

### O que existe a -90

`ozprobe.band -90.5 -84`: dos 3.273 volumes de ambiente do mundo, **15** cruzam a
faixa da masmorra. São os poços das entradas do metrô —
`entrance_bunker_a/b/c/d`, `harbor_1/2`, `airfield_1`, `military_tunnel_1`,
`excavator_1`, `ferry_terminal_1`, `trainyard_1`, `apartments_complex_1` —, cada
um com uns 30×30 m e cem metros de altura, de -113 a -13, tipo
`TrainTunnels` (alguns também `SpatiallyAware`).

O volume diz ao **cliente** que ali é túnel. A luz é do cliente e o servidor não
a calcula (a propriedade do volume nem vem preenchida no servidor), então o que
foi medido daqui é a **sobreposição**: construída sobre o poço dos apartamentos,
a chegada ficava dentro do `placeholder_volume` do monumento; no ponto de dev,
em volume nenhum.

Também descartado: água. O fundo do mar deste mapa não passa de -50, e
`WaterLevel` não considera água um ponto abaixo do terreno.

### A correção

`SettleDepth`, antes de erguer: para cada célula (ou peça, no corpo importado),
uma caixa em volta do piso é conferida contra

1. volume de ambiente que não seja só `Outdoor`;
2. peça sólida do mundo, construção ou deployable (a camada
   `Prevent_Building` ficou de fora: a do `apartments_complex_1` desce além de
   -180 e cobre o ponto de dev, onde a masmorra sempre foi clara);
3. o terreno por cima do teto;
4. água.

Com conflito, a masmorra desce de 30 em 30 m (até -210 com a config padrão;
`ValidBounds` aceita até -500). Sem espaço em nenhuma, `no_position`, com a
frase de quem estava no caminho. Descendo, o plugin avisa no console, na
resposta do comando e no `built` (`depth`, `depthNote`), e o agente registra
`a masmorra desceu`.

| ponto | antes | depois |
|---|---|---|
| dev (-1100, 968) | -90 | -90 |
| apartamentos (-1122, 1062) | -90, dentro do poço | **-120** |
| aeroporto (228, -48) | -90, dentro do poço | **-120** |
| escavadeira (1205, 456) | -90, dentro do poço | **-120** |

---

## 3. As mensagens de surgimento e fim

- **Campos:** `announce.tag`, `tagColor`, `color` e `size`, com as mesmas
  regras das mensagens do servidor. O texto vai até 300 caracteres e aceita a
  marcação `[verde]…[/]`.
- **Variáveis:** `{nome}` é o NOME da masmorra (era o slug) e `{grid}` é a grade
  do mapa. Sem `{grid}` na frase e com a grade ligada, ela entra no fim, como
  antes.
- **Entrega:** com visual escolhido ou com marcação no texto, o plugin chama
  `origemz.chat.broadcast` do OrigemZChat **de dentro do servidor**, então o
  aviso sai mesmo com o agente fora do ar. Sem nada escolhido, é o
  `ChatMessage` de sempre. Sem OrigemZChat, a marcação é retirada e a frase
  sai simples.
- **O tique seguinte.** MEDIDO: chamado dentro do `ozdungeon stop`, o
  `ReplyWith` do OrigemZChat virava a resposta do stop. O anúncio agora sai no
  `NextTick`; durante o descarregamento do plugin, vai pela linha simples.
- **Prévia:** `panel/src/lib/dungeon-announcement.ts`, a mesma conta do
  `AnnouncementText` do plugin.

Medido no server01: `[OrigemZChat] [anuncio] [MASMORRA] A Cripta de Teste
abriu em G6!` e `... fechou. (G6)`.

---

## 4. As skins de construção

### O catálogo é do jogo

`PrefabAttribute.server.Find<Construction>(id).grades` devolve os pares (grade,
skin) de cada peça. As seis que a masmorra usa devolveram a mesma lista:

| material | skins |
|---|---|
| palha | nenhuma |
| madeira | frontier (10232) |
| pedra | adobe (10220), brick (10223), brutalist (10225), jungle (10326), crypt (10472) |
| metal | shipping_container (10221) |
| blindado | space_station (10430) |

A `gingerbread` (madeira, 2) existe com `enabledInStandalone = false` e não é
oferecida. O catálogo mora em `core/src/game/building-skins.ts`, com espelho no
painel e teste de igualdade.

### A regra

- **Onde:** `foundationSkin`, `wallSkin` e `ceilingSkin` em todo bloco de
  material — o da masmorra, o do corredor e o de cada cor.
- **Herança:** a skin vem do MESMO conjunto que o material (`GradeSetOf`). A
  sala que herda o material herda a skin; a que tem material próprio usa a dela.
- **Parede de dois donos:** vence o grau mais forte, com a skin do lado
  vencedor. No empate, vence a sala.
- **Validação:** a régua recusa o par que o jogo não tem, com a frase. O plugin,
  por segurança, descarta a skin e mantém o material (`skinRejected`).
- **Plantas importadas:** entrada e corpo mantêm as skins do arquivo; nada as
  sobrescreve.

Medido no server01 (masmorra `ozteste-skins`, peça por peça):

- corredor de madeira com frontier;
- sala vermelha de metal com contêiner;
- sala verde blindada com estação espacial;
- sala azul herdando o `structure`: adobe no piso, brick na parede e brutalist
  no teto;
- no corpo importado, as skins do arquivo (10223 e 10221) chegaram intactas.

---

## 5. A construção feita no jogo como corpo

### O fluxo do admin

1. Construir a masmorra no Rust.
2. Pôr os marcadores (§6).
3. Salvar com o CopyPaste (`/copy <nome>`). É o `Docs/CopyPaste.cs`, o mesmo
   das entradas e do KOTH.
4. Subir o `.json` na biblioteca, como **corpo da masmorra**. O papel agora se
   escolhe no upload e pode ser trocado depois. A resposta já diz quantos
   marcadores foram achados e o que não será importado.
5. Na masmorra, escolher o modo **construção** e a planta de corpo. A entrada
   continua sendo escolhida no passo dela.
6. Conferir a chegada e os pontos. Cada ponto aponta para um **perfil** — sala
   verde, azul, vermelha ou corredor —, e o conteúdo (inimigo, caixas, tabela,
   OZCoin, IA) vem do cadastro desse perfil no passo "Salas e loot".
7. Salvar. A definição fica na masmorra e serve a todo evento futuro.

### O que o agente faz

`core/src/dungeons/body.ts`:

- **`analyzeBody`** lê o JSON e acha os marcadores (só os soltos: marcador
  encaixado em outra peça é avisado e ignorado). Classifica cada entidade
  (estrutura, acessório, móvel, marcador, NPC, loot, hostil, veículo,
  fechadura, arma, desconhecida), guarda as peças de construção para a prévia e
  para a régua, e escreve os avisos.
- **`mergeBodyPoints`** junta os marcadores aos pontos do rascunho. O ponto de
  marcador tem id derivado da **posição do marcador** (`markerId`), então
  reprocessar a mesma planta não duplica. As mudanças do admin sobrevivem, o
  ponto manual fica, e o ponto cujo marcador sumiu sai. A chegada manual nunca
  é trocada pela árvore.
- **`checkBodyPoints`** usa a geometria medida das peças. Os códigos são:
  - `outside`: fora da construção;
  - `no_floor`: sem piso embaixo;
  - `inside_floor`: dentro de uma fundação;
  - `no_headroom`: sem altura;
  - `inside_wall`: dentro ou colado na parede. O vão da porta e o do quadro
    deixam passar.
  - `on_prop`: em cima de um móvel.

Rotas novas:

| rota | faz |
|---|---|
| `POST /dungeon-blueprints/:id/body-scan` | análise, pontos juntados e problemas |
| `PATCH /dungeon-blueprints/:id` | nome e papel |

A gravação da masmorra recusa a **chegada** sem piso (`BODY_ARRIVAL_INVALID`),
que é o único ponto que prende uma pessoa; os outros problemas são aviso. Apagar
uma planta usada como corpo é recusado, como já era para a entrada.

### O que o plugin faz

`BuildBody`, na seção "O CORPO IMPORTADO":

1. **O giro.** A planta gira para que o olhar da árvore aponte para a frente da
   casinha: `spin = yaw do comando − yaw da árvore`.
2. **A profundidade.** Cada peça de construção vira uma caixa na régua do
   `SettleDepth`, com altura relativa à chegada: o porão e o segundo andar
   também são conferidos.
3. **A colagem.** O papel `PasteRole.Body` pula os marcadores e recusa, pelo
   TIPO da entidade:
   - `BasePlayer`/`BaseNpc`;
   - `LootContainer`/`DroppedItemContainer`;
   - armadilhas e torres;
   - `BaseLock`;
   - `HeldEntity`/`WorldItem`;
   - `BaseVehicle`.

   Não traz item de inventário nenhum, não converte alçapão e não pinta
   bandeira. A conta de cada peça é a mesma da entrada:
   `bodyOrigin + bodySpin * local`.
4. **Meio segundo depois**, com a física registrada:
   - a chegada é conferida com uma cápsula de jogador. Se estiver presa, é
     afastada até 1 m; sem saída, `no_position` com a frase;
   - o alçapão de subir nasce sob o teto que fica sobre a chegada, com a luz ao
     lado;
   - cada ponto nasce pelo mesmo caminho das masmorras de células:
     `SpawnNpcAt` e `SpawnContainerAt`. Várias peças no mesmo ponto ganham o
     anel do `SpotInRing`, e peça sem espaço é pulada com a frase no console.
5. `FinishBuild` — o mesmo fim de toda masmorra: alçapões, mapa, anúncio e
   `built`, com os números do corpo.

O respawn não muda: inimigo morto não volta, e caixa só volta com o `respawn`
ligado.

### Medido no server01

Usei uma exportação **real** do CopyPaste 4.3.0: a construção de teste foi
colada e copiada de volta pelo próprio plugin, e está em
`core/test/fixtures/dungeon-body-copypaste.json`.

- **Colagem:** 26 de 34 peças; os 5 marcadores viraram pontos. Ficaram de fora
  1 caixa de loot, 1 mina e 1 fechadura, e 1 caixa subiu sem o item.
- **Conteúdo:** 3 inimigos e 2 caixas, cada um na posição convertida (conferida
  coordenada a coordenada) e com o perfil certo (a caixa do ponto vermelho é a
  `crate_elite` da cor vermelha).
- **Chegada e saída:** o alçapão de descida leva à chegada; o de subida, à
  casinha.
- **Giros:** 0°, 30°, 137° e 250°.
- **Poço do metrô:** a masmorra desceu para -120.
- **O NPC do arquivo** nem chegou à exportação: o CopyPaste não copia NPC.

---

## 6. Os marcadores

| marcador | item | id | prefab no JSON (medido) | vira |
|---|---|---|---|---|
| Gravestone | `gravestone` | 809199956 | `…/deployablegravestone/gravestone.stone.deployed.prefab` | ponto de inimigo |
| Large Candle Set | `largecandles` | -489848205 | `…/halloween/candles/largecandleset.prefab` | ponto de caixa |
| Christmas Tree | `xmas.tree` | 794443127 | `…/xmas/xmastree/xmas_tree.deployed.prefab` | chegada e referência da entrada |

- **Cada item tem um prefab.** A `gravestone.wood.deployed`, na mesma pasta, é
  outro item (`woodcross`, 699075597) e **não** é marcador. A
  `xmas_tree_a.deployed` não é posta por item nenhum.
- **Os itens dos marcadores não contam.** Os enfeites dentro da árvore, por
  exemplo, não viram ponto nem sobem.
- **Árvore de menos ou de mais.** Sem árvore, ou com mais de uma, a chegada fica
  em branco e o painel pede a escolha — nunca uma escolha silenciosa. A régua
  não salva o modo construção sem chegada.
- **A árvore define a chegada ao descer.** Ela não mexe no respawn de quem
  morre.

---

## 7. Os achados de passagem

| achado | efeito | correção |
|---|---|---|
| a entrada mínima colava a planta com o nome da masmorra | medido: o corpo "ozteste-corpo" subiu na superfície, e a masmorra falhou com `no_hatch` | com receita e sem entrada, a entrada é sempre a mínima |
| `build_error` fora de `FAILURE_REASONS` | o `failed` era recusado pelo parser e a run ficava aberta | o motivo entrou na lista, com frase |
| `origemz.chat.broadcast` dentro do `stop` | a resposta do stop virava `{"ok":true,"sent":1}` | o anúncio sai no tique seguinte |
| empurrão nos eixos do mundo | num cômodo girado, afastar "para trás" podia ir para a parede | os empurrões seguem os eixos da construção |
| `timeOfDay` | viaja até o plugin e ninguém o lê | **não mexido**; registrado aqui |

---

## 8. O que foi medido daqui

- **Plugin:** `pluginlint` sobre o `OrigemZDungeon.cs`, 0 erros.
- **Core:**
  - 2.772 testes passando;
  - 34 novos em `dungeon-corpo.test.ts` e 9 em `dungeon-paredes-giradas.test.ts`;
  - o `wipe-preview.test.ts` falhou uma vez na suíte inteira e passa isolado
    (intermitente, não tocado);
  - lint limpo;
  - o typecheck de testes tem 45 erros que **já existiam** na `main`, nenhum
    novo.
- **Painel:** ver a entrega do painel no PR.
- **Servidor:** `server01`, com uma sonda descartável (`OzDungeonProbe`) e o
  `CopyPaste.cs`. O payload de teste foi montado num banco em memória
  (`core/scripts/dungeon-live-payload.ts`); o banco de desenvolvimento não
  recebeu a migração 099.

---

## 9. O que só o jogo prova

1. **A luz.** O que foi medido é que a masmorra deixou de cruzar o volume de
   túnel. Que o interior fica claro, só um cliente vê. Confira no mesmo ponto
   em que ela escureceu.
2. **Uma exportação feita À MÃO**, com os três marcadores postos por um
   jogador. A do teste foi gerada pelo CopyPaste a partir de uma construção
   montada.
3. **O teleporte até a chegada.** Descer e subir: a posição do alvo foi lida no
   `HatchLink`, mas ninguém foi teleportado.
4. **O visual das skins** nas peças geradas. O servidor confirma o `skinID` e o
   grau; a textura é do cliente.
5. **A cor da marcação no chat** (`[vermelho]…[/]`). O console mostra a frase; a
   cor é do cliente.
6. **O prêmio das caixas dos pontos** (OZCoin): mesmo caminho das masmorras de
   células, sem teste de abertura aqui.
