# OrigemZWorkshop — levantamento

> **Revogado em parte, 16/09/2026 (noite).** O dono desfez a decisão do §6 ("o item já
> nasce com a skin") e a do §6.1 (o kit carimba). A skin agora é escolhida pelo jogador —
> caixa `/skin`, coleções e acessos. O desenho vigente está em
> [01-CAIXA-E-COLECOES.md](01-CAIXA-E-COLECOES.md). O resto deste levantamento continua valendo.

**Isto ainda não é uma especificação.** É o que o dono pediu em 16/09/2026 mais o que foi
MEDIDO no mesmo dia — no decompilado do jogo e no próprio repositório. O que aqui está
marcado como MEDIDO tem data e procedência; o resto está marcado como **não medido**, e
quem implementar vai ter de medir antes de confiar.

Quem lê isto: quem for escrever o `OrigemZWorkshop.cs` e as camadas do agente que o
alimentam. E quem for publicar a arte no Steam Workshop, porque metade das restrições
desta feature está do lado de fora do nosso código.

---

## 1. O que o dono pediu

Palavras dele, 16/09/2026:

> "Vamos ter que criar o .cs para integração Workshop para nós colocarmos nossas skins no
> jogo. Tipo a pedra padrão do jogo, para nós colocarmos uma do nosso com nossa skin
> (lembrando que terá logo e tem que estar protegido pelo modo streamer)."

Perguntado de onde vem a arte, ele escolheu:

> "Vamos publicar no Steam Workshop"

Ou seja: **a OrigemZ publica os itens na oficina do Rust, e o plugin só aplica o workshop
id.** O plugin é catálogo mais aplicador — ele não cria arte, não hospeda arte e não
converte nada. Ele carimba um número.

Perguntado o que "protegido pelo modo streamer" significa:

> "eu falo uma skin específica etc.. podemos remover de aparecer no modo streamer como a
> skin da pedra por exemplo"

Ou seja: **o admin marca skins específicas como escondidas no modo streamer.** Não é o
catálogo inteiro que some; é skin a skin.

E três decisões tomadas no mesmo dia, depois das primeiras perguntas:

| Pergunta | Decisão do dono, 16/09/2026 |
|---|---|
| Como o jogador aplica a skin? | **Não aplica. O item já nasce com ela** — automático, sem menu e sem comando |
| Quem tem direito a ela? | **Por permissão do Oxide, skin a skin** — não é para todos, e não é amarrado ao VIP |
| O catálogo é por servidor ou da rede? | **Um só para a rede toda** |

Cada uma dessas três tem seção própria abaixo (§6, §7, §8), porque cada uma muda o
desenho.

---

## 2. O que o jogo dá — medido, não suposto

MEDIDO em 16/09/2026, por decompilação do
`Servers/server01/RustDedicated_Data/Managed/Assembly-CSharp.dll` (protocolo de rede
**288**).

### 2.1 A skin de item é um número, e quem desenha é o cliente

```text
  agente grava o workshop id no catálogo
        ↓
  plugin escreve o número em  item.skin  (UInt64)
        ↓
  o servidor manda o número pela rede — e só o número
        ↓
  o CLIENTE do jogador baixa o modelo do Workshop por esse id
        ↓
  quem não baixou, vê o item vanilla
```

O servidor nunca serve o modelo nem a textura. Ele não tem os bytes da arte e não há
caminho pelo qual ele os mande. **É por isso que a arte precisa estar publicada no Steam
Workshop** — não é preferência, é o único jeito de o modelo chegar ao cliente.

### 2.2 Não existe whitelist server-side de skinID de item

MEDIDO. O servidor aceita **qualquer `ulong`** em `item.skin` e em `entity.skinID`. Não há
validação, não há lista de permitidos, não há erro. Um id que não corresponde a nada
publicado simplesmente não desenha arte nenhuma — o item fica com a aparência vanilla, e o
número continua lá, servindo de marca.

Consequência prática: **o agente nunca vai saber, pelo servidor, se a arte existe.** O
cadastro aceita o número que o admin digitar. A conferência é humana, no jogo.

### 2.3 `ItemSkinDirectory` — o que existe nesta build, e o que não existe

| Membro | Existe? |
|---|---|
| `ItemSkinDirectory.skins` (`Skin[]`) | sim |
| `ItemSkinDirectory.ForItem(ItemDefinition)` | sim |
| `ItemSkinDirectory.FindByInventoryDefinitionId(int)` | sim |
| `struct Skin { int id; int itemid; string name; bool isSkin; SteamInventoryItem invItem }` | sim |
| `ItemDefinition.skins` (`ItemSkinDirectory.Skin[]`) | sim — `ItemDefinition.cs:213`, preenchido em `:468` por `ItemSkinDirectory.ForItem(this)` |
| `ItemDefinition.skins2` (`IPlayerItemDefinition[]`) | sim — `ItemDefinition.cs:240` |
| `ItemDefinition.FindSkin(int itemID, int skinID)` | sim — `ItemDefinition.cs:390`, estático |
| **`ItemSkinDirectory.Find(...)`** | **NÃO existe nesta versão** — o nome é `FindByInventoryDefinitionId` |

O `ItemSkinDirectory.Find` aparece em exemplo de plugin de terceiro pela internet afora.
Código que o chamar **não compila aqui**. Verifique no `pluginlint` (§9.6) antes de copiar
qualquer coisa de fora.

**Correção de 16/09/2026.** Este quadro afirmava que `ItemDefinition.skins` não existia.
Existe, e a própria `PlayerInventory.GiveDefaultItemWithSkin` a usa (`PlayerInventory.cs:1713`).
Conferido no decompilado. Quem for atrás daquela tabela tropeçaria.

Um detalhe útil de `skins2` (`ItemDefinition.cs:251`): ele filtra
`PlatformService.Instance.ItemDefinitions` por `ItemShortName` e `WorkshopId != 0` — ou seja,
é a lista das skins de **Workshop** de um item, e não a de skins de loja. Não medimos se ela
está populada num servidor headless.

### 2.4 Posse de skin pelo jogador é do Steam, e o atalho é de desenvolvedor

MEDIDO: `SteamInventory.HasItem(int itemid)` e
`PlayerBlueprints.CheckSkinOwnership(int skinItemId, BasePlayer player)` decidem se o
jogador possui a skin. Ambos são curto-circuitados por `BasePlayer.DefaultSkinAccess` e
`BasePlayer.AllSkinsUnlocked`, que vêm de `GetSkinsAccessLevel()` — e esse é
**developer-only**: lê o convar de cliente `client.skins_access`.

Ou seja: **não dá para "liberar todas as skins" para o servidor por esse caminho.** Ele
existe para a Facepunch, não para nós. O direito de uso da nossa skin é o do §7 — permissão
do Oxide —, e não posse no inventário Steam.

---

## 3. O modo streamer do jogo não esconde imagem — quem esconde é o nosso

Esta é a restrição que mais muda o desenho, e ela contraria a leitura intuitiva do pedido
do dono.

### 3.1 O modo streamer do Rust é 100% do cliente

MEDIDO em 16/09/2026, no mesmo decompilado:

- **`global.streamermode` não é ConVar registrada.** Não aparece em `ConsoleGen.cs` nem em
  nenhum arquivo de `ConVar/`. O servidor não a tem, não a lê e não a escreve.
- **`IsStreamer` não existe em nenhum assembly.**
- O servidor só consegue **ler o que o cliente reporta**:
  `player.net.connection.info.GetBool("global.streamermode")`. Ver
  `NameHelper.GetPlayerNameStreamSafe` e `BasePlayer.GiveItem`, que faz
  `GetInfoBool("global.streamermode", false)`.
- O que o modo streamer do jogo esconde: **só nomes** — de jogador, de item, de cadáver e
  de troféu de caveira. **Não esconde placa, não esconde imagem, não esconde textura e não
  esconde cor de construção.**

Então "esconder a skin no modo streamer do jogo" não é uma chave que o Rust nos dê. Ela não
existe.

### 3.2 A limitação que decorre disso: skin é estado do item, não da visão

MEDIDO, e é o ponto a não esquecer: **o `skinID` viaja no item, e todo mundo que olha o
mesmo item vê a mesma coisa.**

Não dá para mostrar a skin com a logo para um jogador e a vanilla para outro **olhando o
mesmo item**. O que dá para fazer é agir **por portador**:

```text
  jogador NÃO está em modo streamer
        ↓
  o item que nasce na mão dele leva  skinID = <workshop id>
        ↓
  todo mundo à volta vê a skin com a logo

  jogador ESTÁ em modo streamer
        ↓
  o item que nasce na mão dele leva  skinID = 0
        ↓
  todo mundo à volta vê a pedra vanilla — inclusive ele
```

A proteção é **do portador, não do espectador**. O streamer não vê a logo nos itens *dele*;
a logo continua existindo nos itens dos outros jogadores que estiverem no campo de visão
dele. Isso é o máximo que a rede do Rust permite, e precisa ser dito ao dono antes de a
tela do painel prometer outra coisa.

**Não medido:** o que acontece com um item que o jogador **já tem** quando ele liga o
`/streamer` no meio da partida. Trocar `item.skin` de um item vivo e chamar `MarkDirty` é
o que o SkinBox faz há anos, mas **não foi medido neste projeto** — nem o efeito, nem o
custo de rede, nem o que acontece com o item dentro de uma caixa ou no chão.

### 3.3 O gancho certo é o modo streamer da OrigemZ, que já existe

O projeto **já tem um modo streamer próprio**, e ele é outra coisa: o jogador liga com
`/streamer`, o plugin alterna na hora e o agente grava.

MEDIDO no repositório, 16/09/2026:

| Onde | O quê |
|---|---|
| `Plugins/OrigemZUI.cs:3528-3533` | o bloco "O MODO STREAMER" — as duas chaves e por que o plugin decide |
| `Plugins/OrigemZUI.cs:3552` | `origemz.streamer.config` — o comando pelo qual o agente manda a lista |
| `Plugins/OrigemZUI.cs:3561` | a classe `StreamerState` |
| `Plugins/OrigemZUI.cs:3619-3624` | `StreamerHidesLogo(player)` |
| `Plugins/OrigemZUI.cs:3626-3631` | `StreamerHidesAds(player)` |
| `core/src/db/streamer-repository.ts` | quem pode usar, e quem está ligado |
| `core/src/game/streamer-sync.ts` | a carga que desce para o plugin |
| `core/src/types/streamer.ts` | o contrato |

**É este o gancho que a feature deve usar**, e não o convar do jogo. A pergunta que o
plugin do Workshop faz antes de carimbar a skin é a mesma que o `StreamerHidesLogo` já
responde: *este jogador está escondendo a logo agora?*

Duas coisas a herdar junto:

1. **O plugin decide, não o agente.** Uma frase começada por `/` nunca chega ao agente
   (vira `OnPlayerCommand` e morre no plugin), e o jogador está ao vivo — esperar uma ida e
   volta pelo console faria o comando parecer mudo na tela de quem está transmitindo.
2. **O estado do streamer vive em dois plugins.** Hoje ele mora no `OrigemZUI`. O
   `OrigemZWorkshop` vai precisar dele. Decidir cedo se lê por `Interface.Oxide` /
   `plugins.Find("OrigemZUI")`, se recebe a mesma carga do agente por um `sync` próprio, ou
   se o carimbo mora dentro do `OrigemZUI`. **Duas cópias da lista de streamers em dois
   plugins é a pior das três** — divergem no primeiro reload.

---

## 4. A arte é publicada por nós no Steam Workshop — e esse lado não foi medido

Decisão do dono: a OrigemZ publica. O que o repositório sabe sobre isso:

- **Do lado do jogo, nada muda.** O plugin lida com um `ulong`. Se a arte foi aprovada,
  rejeitada, é pública ou é oculta, o servidor não sabe e não pergunta (§2.2).
- **Uma pesquisa anterior do projeto já tocou nisto:**
  `Docs/CustomItem/01-PESQUISA-ITEM-CUSTOM.md` — §3.5 mediu que **104 de 1266 itens do jogo
  aceitam skin**, e o §4.3 de lá trata de publicar a arte com a logo. Esse documento é de
  outra frente e **não foi re-medido hoje**; leia-o antes de escolher os itens base do §11.

**Não medido, e precisa ser antes de a primeira skin subir:**

- o fluxo de publicação da Facepunch (aprovação, prazo, se o item precisa ser aceito no jogo
  ou basta estar publicado para o cliente baixar);
- se uma skin **não aprovada** é baixada pelo cliente pelo id;
- se a lista dos 104 itens que aceitam skin vale para skin publicada por nós ou só para as
  do jogo. A pedra do exemplo do dono — `stones` — **não foi conferida nessa lista**.

Nenhuma dessas é pergunta de código. São perguntas de Steam, e a resposta vem de publicar
uma e olhar.

---

## 5. Metade disto já existe no projeto: o item custom

MEDIDO no repositório, 16/09/2026. Antes de escrever tabela nova, saiba o que já está de pé:

| Peça | Onde | O que faz |
|---|---|---|
| Catálogo | `custom_items`, migração **41** (`core/src/db/migrations.ts:3163`) | item custom = item base do jogo + uma marca |
| A marca | `UNIQUE (base_shortname, skin_id)` | `skin_id` é **TEXT**, porque é `UInt64` e não cabe no inteiro com sinal do SQLite |
| A trava | `CHECK (skin_id <> '0' AND skin_id <> '')` | skin 0 é indistinguível de item comum, e num item sem skins derruba o jogador pelo caminho do CUI |
| Em que servidores vale | `custom_item_servers (item_id, server_id)` | sem linha nenhuma = em nenhum servidor |
| Repositório | `core/src/db/custom-items-repository.ts` | leia o cabeçalho inteiro |
| Carga para o jogo | `core/src/game/custom-items-sync.ts` | `item.clear` → `item.set` por item, em ordem |
| Plugin | `Plugins/OrigemZItems.cs` | nome, descrição e ícone por marca |
| Rota e tela | `core/src/http/routes/custom-items.ts`, `panel/src/app/itens` | o cadastro |

**A forma do dado é a mesma** que a do catálogo do Workshop: um id nosso, um item base, um
número de skin, e em que servidores vale.

Isto **não é uma pergunta ao dono** — é uma decisão técnica de quem implementar, e ela
precisa ser tomada na primeira hora: *o catálogo do Workshop é uma tabela nova, ou é a
`custom_items` com colunas novas?* Os argumentos dos dois lados:

- **Uma tabela só:** a marca é a mesma, o `UNIQUE (base, skin)` já impede duas definições
  brigando pelo mesmo par, e o sync já existe. O que falta é permissão por skin (§7) e a
  marca de "esconde no streamer" (§3).
- **Tabela nova:** o item custom é um item **nosso** com nome, ícone e ação próprios; a skin
  do Workshop é o item **do jogo** com outra aparência. Misturar os dois faz o painel mostrar
  uma tela com metade dos campos sempre vazios.

Escolha uma e escreva o porquê no cabeçalho do arquivo. O que não vale é descobrir na
metade.

---

## 6. ~~A skin não se aplica: o item já nasce com ela~~ — REVOGADO

> Ver [01-CAIXA-E-COLECOES.md](01-CAIXA-E-COLECOES.md). O texto abaixo fica como histórico.

**Decisão do dono, 16/09/2026.** O jogador não aplica nada. Não há menu de skin, não há
comando de aplicar, não há caixa de skin ao segurar o item. É automático: onde o jogo daria
a pedra vanilla, ele dá a pedra da OrigemZ.

Isso confirma a frase original — *"a pedra padrão do jogo, para nós colocarmos uma do nosso
com nossa skin"*.

A consequência técnica é direta: **a feature vive num hook de criação/entrega de item.** Ela
não tem interface no jogo; o que ela tem é um ponto por onde todo item passa antes de chegar
à mão do jogador, e nesse ponto ela decide o `skinID`.

**Qual hook é esse ainda não foi medido.** Os candidatos, e por que nenhum é óbvio:

| Candidato | A dúvida |
|---|---|
| `OnItemCraftFinished` | pega o que o jogador craftou, e só isso |
| `OnItemAddedToContainer` | dispara muito, inclusive ao mover item dentro da mochila |
| `OnPlayerRespawn` / kit inicial | pega o que nasce com o jogador |
| `CanStackItem` / `OnItemSplit` | a skin muda o empilhamento? não medido |
| gather / `OnDispenserGather` | a pedra do exemplo do dono vem de bater em rocha |

E as perguntas que decidem entre eles, nenhuma medida:

- item que **já existe** no mundo (no chão, na caixa, no baú de outro jogador) é alcançado, ou
  só o que nasce dali para a frente?
- item com skin **empilha** com o mesmo item sem skin? Se não, um jogador com permissão
  acaba com duas pilhas de pedra na mochila — e isso é um bug visível no primeiro dia.
- o carimbo custa quanto por item, num servidor cheio, quando todo mundo está minerando?

Este é o item que sobra em aberto (§11). É a primeira coisa a medir, e mede-se com plugin
descartável no `server01`, não lendo o decompilado.

### 6.1 E o kit também carimba — decisão do dono, 16/09/2026

Perguntado se a skin da OrigemZ tem de valer nos itens do kit, ele escolheu:

> "Sim — o agente carimba no kit. O catálogo do Workshop passa a alimentar o loadout... Uma
> fonte só escrevendo a skin, sem duas frentes brigando pelo mesmo campo."

Sem isto a feature seria quase inerte: o `OrigemZPlayer.cs:262` cancela o
`OnDefaultItemsReceive` de quem tem kit, e com isso o `OnDefaultItemsReceived` — onde o
`OrigemZWorkshop` carimba — nunca dispara. Quase todo mundo nasce com kit.

**Onde a skin é preenchida: no jogo, não no agente.** MEDIDO em 16/09/2026, e é o que decide
entre os dois caminhos possíveis:

| O que foi medido | Onde |
|---|---|
| O loadout é por **grupo/nível**, nunca por jogador | `core/src/loadouts/sync.ts:120-140` (`buildLoadoutPayload`) |
| Ele viaja numa carga só, que o plugin guarda em cache | `LOADOUT_SYNC_COMMAND = 'origemz.loadout.sync'` |
| O consumidor pergunta por nível | `Plugins/OrigemZPlayer.cs:1022` (`ReadLoadout(tier)`) |
| **O agente não tem espelho de permissão do Oxide** | nenhuma tabela em `core/src/db/migrations.ts`; a única leitura é ao vivo por RCON, em `core/src/oxide/permissions.ts:167` (`oxide.show user <id>`) |

Ou seja: o agente **não sabe** a permissão do jogador sem uma ida ao RCON por jogador — e o
lugar onde ela faria falta (a montagem do kit) nem existe por jogador. Preencher o `skinId`
no agente daria a skin ao **grupo inteiro**, com permissão ou sem, e não teria como honrar o
modo streamer, que é estado ao vivo.

Então o kit **pergunta**: o `OrigemZPlayer` consulta o hook `GetWorkshopSkin(steamId,
shortname)` do `OrigemZWorkshop` ao criar cada item, e a permissão é resolvida onde ela
vive. O agente continua dono do catálogo; o plugin é a cópia de leitura.

**Uma fonte só escreve `item.skin`**, e a garantia é do jogo, não de combinação entre
plugins: com kit, a entrega de fábrica é cancelada e o `OnDefaultItemsReceived` nunca roda;
sem kit, ela roda inteira e o kit não existe. Os dois nunca tocam o mesmo item.

**`skinId` preenchido à mão no loadout tem precedência.** O catálogo só preenche o que está
vazio: o que o admin digitou é escolha explícita; o catálogo é o padrão da casa.

---

## 7. O direito é por permissão, uma por skin

**Decisão do dono, 16/09/2026.** Cada entrada do catálogo tem a **sua própria permissão do
Oxide**, no padrão `origemzworkshop.<algo>`.

- **Não é amarrado ao `OrigemZVip`.** A feature não conhece VIP.
- **Não é liberado para todos por padrão.** Sem permissão, o item nasce vanilla.

O ganho é que isso serve os três casos sem acoplar a feature a nenhum deles: o admin dá a
permissão ao grupo de VIP, ou ao vencedor de um evento, ou a um jogador só como brinde. O
Oxide já sabe fazer as três, e nenhuma delas vira código nosso.

O padrão de registro já está no repositório — `permission.RegisterPermission(perm, this)` em
`Plugins/OrigemZDungeon.cs:592-593` e, para permissão que vem do agente e é registrada na
carga, `Plugins/OrigemZUI.cs:3377`. **Este segundo é o caso aqui:** a permissão nasce do
cadastro, então ela é registrada quando o catálogo desce, e não no `Init`.

**Não medido:** o que o plugin faz quando a permissão é revogada de um jogador que já tem o
item com a skin na mochila. O mais simples é não fazer nada — a skin fica —, mas é uma
decisão, e ela precisa estar escrita.

---

## 8. O catálogo é um só para a rede — e já existe precedente

**Decisão do dono, 16/09/2026:** o catálogo é global, não por servidor.

O briefing desta tarefa avisava que isso contrariaria o padrão dominante do agente. **Fui
conferir, e não contraria:** MEDIDO em `core/src/db/migrations.ts`, 16/09/2026.

| Tabela | Tem `server_id`? |
|---|---|
| `custom_items` (migração 41) | **não** — é global |
| `items` (migração 07, o espelho do catálogo do jogo) | **não** — é global |
| `custom_item_servers` (migração 41) | é a **junção**: `(item_id, server_id)`, com `ON DELETE CASCADE` dos dois lados |
| `kit_servers` (migração 12) | a junção original, de onde a de cima foi copiada |

Ou seja: **esta não é a primeira tabela global do agente.** O padrão já existe e tem nome —
catálogo global mais tabela de junção dizendo em que servidores cada linha vale. O comentário
da migração 41 explica a regra que vem junto, e ela deve ser herdada:

> Sem linha nenhuma = em nenhum servidor. Um item recém-cadastrado que já valesse em tudo
> entraria em produção sem ninguém mandar.

Então o desenho fica:

```text
  workshop_skins           (global — sem server_id)
        ↓
  workshop_skin_servers    (skin_id, server_id)  ← quem decide onde vale
        ↓
  o push desce para CADA servidor conectado, com a lista dele
```

As duas consequências a registrar:

1. **A tabela do catálogo não tem `server_id`, e por isso não tem
   `REFERENCES servers(id) ON DELETE CASCADE`.** A junção tem. Apagar um servidor não pode
   apagar a skin do catálogo.
2. **O push do catálogo vai para todos os servidores conectados**, cada um recebendo a fatia
   que a junção lhe dá. O `custom-items-sync.ts` já faz exatamente isso — copie o desenho,
   inclusive a ordem `clear` antes de `set`.

**Em aberto de forma benigna:** se o dono quiser que "global" signifique *sem junção
nenhuma, vale em tudo, sempre*, é uma tabela a menos. Mas isso contraria a regra citada
acima, que existe para evitar entrada em produção sem ninguém mandar. Comece com a junção.

---

## 9. O molde do projeto que esta feature segue

Tudo MEDIDO no repositório em 16/09/2026. Nada disto é opcional — é como as outras seis
frentes deste agente já funcionam.

### 9.1 O plugin

`[Info("OrigemZWorkshop", "OrigemZ", "0.1.0")]` mais `[Description(...)]`.

- `CovalencePlugin` + `[Command("origemz.workshop")]` quando os verbos são subcomandos de um
  comando só;
- `RustPlugin` + `[ConsoleCommand]` quando cada verbo é próprio e só de RCON.

**`[ConsoleCommand]` NÃO funciona em `CovalencePlugin`.** Compila, carrega, e o comando
simplesmente não existe — o sintoma é `RCON_TIMEOUT`, que não aponta para lugar nenhum.

**Teto de linguagem: C# 6.** O compilador do Oxide para aí. Sem interpolação com `$@`, sem
expressão-corpo em propriedade com get/set, sem `out var`, sem *pattern matching*. Ver
`Plugins/OrigemZImages.cs:58-60`.

### 9.2 O canal plugin ↔ agente: não existe HTTP

É o console via WebRCON, nos dois sentidos.

```text
  agente → plugin
    rcon.send("origemz.workshop.sync {json}")
        ↓
    resposta SÍNCRONA por player.Reply(json)   ← não sai no console; vem casada no POST

  plugin → agente
    Puts("#OZWORKSHOP#" + json)
        ↓
    o agente casa por marcador no stream do console
```

**Marcadores já ocupados** (MEDIDO por varredura em `Plugins/*.cs` e `core/src`, 16/09/2026):
`#OZADSREQ#`, `#OZAREQ#`, `#OZBAL#`, `#OZBUY#`, `#OZCHATCMD#`, `#OZDUNGEON#`, `#OZKOTH#`,
`#OZPEVT#`, `#OZQUEST#`, `#OZQUESTNPC#`, `#OZSTAT#`, `#OZSTREAMER#`, `#OZTEAM#`, `#OZUIREQ#`.

**Livre, e reservado para esta feature: `#OZWORKSHOP#`** — a varredura não achou nenhuma
ocorrência dele no repositório.

### 9.3 O segredo, e a regra de ouro do console

- **Todo push do plugin — menos o `ready` do boot — carrega um segredo** que o agente entrega
  no `sync`. Sem ele, um jogador digita o marcador no chat e forja evento. Ver
  `core/src/game/koth.ts` e `core/test/koth.test.ts:17-18`.
- **Nenhum comando RCON sai de dentro do gancho de linha de console.** A linha volta e
  dispara de novo. Ver `core/src/game/koth.ts:22-26`.
- **`Puts` de dentro do handler entra na resposta casada do comando.** Um aviso disparado no
  mesmo frame vira `{"ok":true,…}#OZ…{…}`, que não é JSON, e o agente não consegue ler o que
  ele mesmo mandou fazer. Se precisar gritar, grite num `timer.Once`.

### 9.4 Payload grande

Vai em Base64 por `core/src/game/plugin-push.ts` (`encodePushPayload` / `buildPushCommand`),
com teto `MAX_PUSH_BYTES = 50_000` — porque o parser de console do Rust come aspas.

Para um catálogo de skins o `custom-items-sync.ts` mostra a alternativa: `clear` seguido de
um `set` por linha, quando o conjunto passa do frame com poucas dezenas de itens.

### 9.5 Banco

Migrações todas em `core/src/db/migrations.ts`, arquivo único. **O último id usado é 94**
(`koth-deliveries`, linha 7917) — **a próxima é a 95**. E as regras da casa:

- datas em **epoch ms**;
- booleano é `INTEGER 0/1` **com CHECK**;
- toda coluna de servidor referencia `servers(id) ON DELETE CASCADE` — aqui, só na junção
  (§8);
- comentário de migração em **ASCII sem acento e sem crase**: o SQL mora num template
  literal, e uma crase fecha a string.
- **nunca edite uma migração que já rodou.** O SQLite aplica cada número uma vez só; coluna
  nova é migração nova. Ver o comentário da 042.

### 9.6 Rotas, painel e validação

- Rotas em `core/src/http/routes/`, autenticação por `preHandler` global no prefixo `/api`
  (sessão por cookie mais CSRF, ou `Authorization: Bearer`).
- **Zod na borda E dentro do repositório.**
- Painel: Next.js com export estático, tudo `'use client'`, cliente HTTP único em
  `panel/src/lib/api.ts`, formulário puro que **não faz fetch** — quem chama a API é o pai.
- Navegação: `panel/src/components/sidebar.tsx` para catálogo (é onde esta entra);
  `panel/src/lib/events/families.ts` é para evento, e esta não é.

### 9.7 Validar o `.cs` sem subir servidor

```text
dotnet build core/scripts/pluginlint/pluginlint.csproj -p:PluginFile="...\OrigemZWorkshop.cs" -v q --nologo
```

Dois segundos. É o que pega o `ItemSkinDirectory.Find` que não existe (§2.3) antes de o
servidor pegar.

---

## 10. As camadas a criar

Espelhando o KOTH, que é a frente completa mais recente. A coluna da direita é o arquivo a
ler antes de escrever o seu.

| Camada | Arquivo a criar | O modelo a copiar |
|---|---|---|
| Plugin | `Plugins/OrigemZWorkshop.cs` | `Plugins/OrigemZItems.cs` (marca por `(base, skin)`) e `Plugins/OrigemZKoth.cs` (segredo e push) |
| Contrato | `core/src/types/workshop.ts` | `core/src/types/koth.ts` |
| Migração **95** | bloco em `core/src/db/migrations.ts` | a **41** (`CUSTOM_ITEMS_SCHEMA`), pelo catálogo global mais junção |
| Repositório | `core/src/db/workshop-repository.ts` | `core/src/db/custom-items-repository.ts` |
| Serviço / sync | `core/src/game/workshop.ts` | `core/src/game/custom-items-sync.ts` (a carga) e `core/src/game/koth.ts` (o push com segredo) |
| Rotas | `core/src/http/routes/workshop.ts` | `core/src/http/routes/custom-items.ts` |
| Teste | `core/test/workshop.test.ts` | `core/test/koth.test.ts` — ele já mostra como o segredo é testado |
| Client do painel | bloco em `panel/src/lib/api.ts` | os blocos `kothArenas` / itens custom |
| Página | `panel/src/app/workshop/page.tsx` | `panel/src/app/itens` |
| Componentes | formulário de cadastro, lista, marca de "esconde no streamer" | `panel/src/components/streamer-card.tsx` |
| Navegação | entrada em `panel/src/components/sidebar.tsx` | as entradas de catálogo já lá |

O que **não** tem camada nova: o modo streamer (§3.3) — ele já existe inteiro, dos dois
lados. A feature consome; não reimplementa.

---

## 11. Em aberto

Duas coisas, e só duas. As três perguntas que estavam aqui na primeira versão foram
respondidas pelo dono em 16/09/2026 e viraram os §6, §7 e §8.

**1. Quais itens entram no catálogo.** A pedra é o exemplo do dono — *"tipo a pedra padrão do
jogo"* —, não a lista. A lista não existe. Antes de pedi-la, tenha na mão o que o §4 diz: só
parte dos itens do jogo aceita skin, e a pedra não foi conferida nessa lista. A pergunta ao
dono fica melhor assim: *quais itens você quer com a logo, em ordem de prioridade?* — e a
resposta técnica de quais são possíveis vem depois, medida.

**2. Qual hook do jogo é o ponto certo para carimbar a skin no item que nasce.** Os
candidatos e as perguntas estão no §6. Isto **não é pergunta ao dono** — é a primeira
medição a fazer, com plugin descartável no `server01`. Enquanto ela não for feita, não há
como estimar a feature: dependendo do hook, ela é trinta linhas ou é um problema de
empilhamento.

---

## O que não está aqui

**Skin de bloco de construção.** É um caminho **completamente diferente** da API, e ele não
passa pelo `ItemSkinDirectory` nem pelo Workshop. MEDIDO em 16/09/2026:
`Construction.GetGrade(grade, skinID)` procura um `ConstructionGrade` **dentro do próprio
prefab** cujo `gradeBase.skin == skinID`; se não achar, devolve o `defaultGrade` **em
silêncio**. As skins de bloco desta build são um conjunto fechado e do jogo: twigs, wood,
stone, metal, toptier, adobe, shipping_container, brutalist, brick, jungle, crypt, frontier,
gingerbread, space_station. **Não dá para publicar uma nossa no Workshop e usá-la como grade
de parede.** Se o dono pedir "a parede com a nossa cara", a conversa é outra e começa por
aqui.

**A arte das bandeiras da masmorra.** É outra frente, em andamento, e ela usa placa e
textura — não `skinID`. Ver `Docs/KOTH/DECISOES-DO-DONO.md` §5 para a parte da bandeira do
território, que tem a mesma natureza.

**O fluxo de publicação no Steam.** Está fora do código e fora desta pasta até alguém
publicar a primeira e medir o que acontece (§4).
