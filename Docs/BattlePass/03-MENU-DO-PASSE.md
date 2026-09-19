# Passe de Batalha — a tela no jogo

A trilha desenhada no CUI: onde ela nasce, como ela rola, quanto custa em bytes,
e o que a pesquisa nos jogos que já têm passe diz sobre cada pedaço dela.

Medido em 17/09/2026. O que não foi medido está marcado como **PENDENTE**, e
ninguém deduz.

---

## 1. A tela nasce no plugin — decisão do dono, 17/09/2026

Neste projeto quase todas as telas nascem no **agente**, em TypeScript
(`core/src/game/ui-*-screen.ts`): home, loja, missões, kits, ranking, time,
calendário, eventos. O `OrigemZUI` não sabe desenhar — está escrito no topo dele
(`Plugins/OrigemZUI.cs:14`): *"o agente manda a tela já como lista de CuiElement
pronta, e aqui só se troca o token da sessão e chama CuiHelper.AddUi"*.

**O menu de skins é a exceção**, montado em C# dentro do `OrigemZWorkshop.cs`. O
dono pediu que o passe siga por ali, e a escolha tem duas consequências
concretas a favor:

| | Tela no agente | **Tela no plugin (escolhido)** |
|---|---|---|
| ScrollView | não existe no modelo | **sim** — a trilha inteira rola |
| **tooltip** | não existe no modelo | **sim** — e o dono pediu um |
| teto por envio | ~50.000 em base64, sem checagem | 40.000 por `AddUI`, **dividido pelo `Pack`** |
| editável no painel `/interface` | sim | não |
| widgets prontos | `ui-widgets.ts` inteiro | reescrever em C# |
| plugin novo | não | **sim** |

O tooltip é o que fecha a conta: o dono pediu um ícone de caixa com aviso do que
ficou por receber (§6), e **tooltip só existe no plugin**
(`OrigemZWorkshop.cs:4194`). Pelo agente, esse pedido não teria como ser
atendido.

Nasce então `Plugins/OrigemZBattlePass.cs`, com o `OrigemZWorkshop.cs` como molde
linha a linha — inclusive a paleta, que **ele próprio copiou do
`ui-widgets.ts`** e marcou com um comentário (`:3974`). A cara continua sendo a
mesma do resto do menu.

---

## 2. O que a tela precisa mostrar

Da pesquisa nos sete jogos de referência (Fortnite, Apex, CoD, Valorant, Brawl
Stars, Rocket League, Halo), o que o jogador procura, nesta ordem:

1. **nome da temporada** e **quanto falta para acabar** — o contador regressivo é
   o que cria urgência;
2. **o nível atual e a barra de XP** para o próximo;
3. **se tem o passe pago**, e o botão de comprar se não tiver;
4. **a trilha**, com o nível atual em destaque;
5. **um botão de resgatar tudo**.

O item 5 não é conveniência: **fricção de resgate é a reclamação nº 1** dos
passes. A queixa literal que a pesquisa encontrou — *"after every game you have
to probably click 20 times just to claim all the season pass rewards"* — é
exatamente o que acontece com quem compra no nível 17.

---

## 3. O desenho

Janela de 1240×640 centrada na base 1280×720, como a do menu de skins, com
cabeçalho de 52 px e acento vermelho de 2 px.

```text
┌────────────────────────────────────────────────────────────────────────┐
│ ▌PASSE DE BATALHA · SETEMBRO 2026            faltam 13 dias    [📦²] [X]│
│ ▌NÍVEL 17   ████████████░░░░░░  2.400 / 3.000 XP                       │
│ ▌🔒 passe grátis              [ ATIVAR O PASSE POR 2.500 OZCOIN ]      │
├────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 ▲ │
│  │ NÍVEL 13 │ │ NÍVEL 14 │ │ NÍVEL 15 │ │ NÍVEL 16 │                 █ │
│  │ [img] ✓  │ │ [img] ✓  │ │ [img] !  │ │ [img] !  │                 █ │
│  │  scrap   │ │ madeira  │ │ enxofre  │ │   kit    │                 ░ │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────┤                 ░ │
│  │ [img] ✓  │ │ [img] 🔒 │ │ [img] 🔒 │ │ [img] 🔒 │                 ░ │
│  │  500 OZ  │ │  AK-47   │ │   kit    │ │ 1000 OZ  │                 ░ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                 ░ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 ░ │
│  │▛NÍVEL 17▟│ │ NÍVEL 18 │ │ NÍVEL 19 │ │ NÍVEL 20 │                 ░ │
│  │ [img] !  │ │ [img] 🔒 │ │ [img] 🔒 │ │ [img] 🔒 │                 ░ │
│  │   skin   │ │  scrap   │ │ madeira  │ │   kit    │                 ░ │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────┤                 ░ │
│  │ [img] 🔒 │ │ [img] 🔒 │ │ [img] 🔒 │ │ [img] 🔒 │                 ░ │
│  │   skin   │ │   kit    │ │ 2000 OZ  │ │  MARCO   │                 ▼ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘                   │
├────────────────────────────────────────────────────────────────────────┤
│                     [ RESGATAR TUDO (6) ]                              │
└────────────────────────────────────────────────────────────────────────┘
  ✓ resgatado   ! disponível   🔒 bloqueado   ▛▟ nível atual   📦² pendentes
```

Quatro colunas com rolagem vertical — é exatamente a grade do menu de skins, que
já roda com até 48 células. Em cada card, **a faixa de cima é a grátis e a de
baixo é a paga**: é o que o dono desenhou, e também o arranjo que o estudo de
caso do Hungry Shark World defende — grátis acima do premium, *"garantindo que
free players se sintam valorizados enquanto o conteúdo premium impulsiona a
conversão"*.

### 3.1 As cinco regras visuais que não se negociam

1. **Nunca só a cor.** Cadeado para bloqueado, ✓ para resgatado. É acessibilidade
   básica, e é a convenção que o jogador já leu em outros jogos.
2. **A recompensa paga aparece mesmo sem o passe** — apagada, com cadeado e
   selo. Cadeado sem conteúdo não vende nada; o gancho de conversão é o jogador
   ver o que está deixando na mesa. É o que o Neopets faz, e é deliberado.
3. **Só o nível atual tem moldura acesa**, e só ele tem botão primário.
4. **Vermelho é borda e acento, nunca texto.** No painel isso é regra escrita
   (`--rust-red` dá 3,74:1 de contraste); a mesma disciplina vale no CUI.
5. **Marco ganha destaque de tamanho**, não só de cor.

### 3.2 O XP no card, e o modal de detalhe — pedido do dono, 19/09/2026

Depois de ver o passe rodando, o dono pediu duas coisas: *"temos que mostrar o
xp para os níveis"* e *"talvez colocamos no card uma opção de abrir um modal
para saber mais detalhe, colocar (i)"*.

**Por que passou a importar.** A curva de XP virou progressiva (`linear`, base
500, passo 250): os degraus custam 500, 750, 1.000, 1.250… Um card que diz só
"NÍVEL 3" esconde justamente o que mudou — por que o nível 9 demora mais que o
2.

**Que número vai no card.** Há três, e eles respondem a perguntas diferentes:

| Número | Responde |
|---|---|
| custo do degrau | "quanto custa subir daqui para lá" |
| acumulado do nível | "qual é a marca deste degrau na régua" |
| **quanto falta** | **"quanto falta PARA ESTE, de onde eu estou"** |

No card vai o terceiro — é a pergunta que o dono escreveu, e é a única das três
que muda conforme quem olha. Nível já alcançado não tem "quanto falta": ali vai
o acumulado, em cinza, para a régua continuar comparável de card a card (500,
1.250, 2.250, 3.500…). Nível sem XP na carga não mostra nada: inventar um
número seria pior que a tarja de antes.

**Como o modal abre.** O alvo do clique é a **tarja do nível**, que já existia
como painel e virou botão — trocar `CuiImageComponent` por
`CuiButtonComponent` **não acrescenta elemento nenhum**, e com 22 níveis cada
elemento novo no card é multiplicado por 22. O `[i]` é um rótulo à direita da
tarja, e existe porque um clique sem marca visível é um clique que ninguém dá.
Clicar de novo na mesma tarja fecha; clicar em outra troca o conteúdo.

**O que o modal tem que o card não pode ter:** os três números do XP juntos
(com uma barra que mede *aquele degrau*, e não a temporada), o rótulo inteiro
da recompensa (o card corta em 34 caracteres), o estado de cada faixa por
extenso ao lado do selo, o motivo do cadeado como texto na tela — e o botão de
resgate, porque quem abriu o detalhe para decidir não deveria ter de fechá-lo
para agir.

---

## 4. A rolagem, e o orçamento de bytes

### 4.1 A receita do ScrollView

Está medida e funcionando em `OrigemZWorkshop.cs:4506` (`ScrollArea`):
`CuiScrollViewComponent` com `ContentTransform` ancorado no topo e âncora mínima
negativa, `MovementType = Clamped`, e a barra colorida. Duas folgas obrigatórias,
porque a barra cobre a borda e o conteúdo é recortado:

- `ScrollGutter = 16f` — a goteira onde a barra mora;
- `ScrollInset = 2f` — o respiro do conteúdo contra a borda.

### 4.2 Os bytes

A régua do projeto é **~390 bytes por elemento**, e a medição real do menu de
skins dá **~2.315 bytes por célula** (12 células = 27.779 bytes).

O card de um nível é mais rico que uma célula de skin — duas faixas, dois
ícones, dois estados —, então a conta de trabalho é **~3.000 bytes por nível**:

| Trilha | JSON | `AddUI` necessários |
|---|---|---|
| 20 níveis | ~60.000 | 2 |
| 30 níveis | ~90.000 | **3** |
| 40 níveis | ~120.000 | 4 |

O `Pack` (`OrigemZWorkshop.cs:3926`) corta a região em vários `AddUI` de até
`AddUiByteLimit = 40000` **sem nunca mandar filho antes do pai**. É o que o menu
de skins já faz na abertura: ao vivo, saiu em três envios (~30, 32 e 8 KB).

Uma temporada de 30 níveis cabe, com folga, em três envios. **Não há paginação a
escrever** — a rolagem resolve.

### 4.3 E os bytes medidos, em 17/09/2026

A estimativa acima era de trabalho; estes são os números do
`MeasureWorstCase()` do `OrigemZBattlePass.cs`, exposto como
`origemz.passe.bytes [níveis]`. O pior caso que ele monta é **toda faixa
cheia**, com rótulo longo, ícone, selo e dica, e a **caixa de pendências
aberta** e cheia:

| Trilha | JSON da trilha | `AddUI` na abertura |
|---|---|---|
| 20 níveis | 61.493 | 4 |
| 30 níveis | 91.970 | 5 |
| 40 níveis | 122.587 | 5 |

**3.065 bytes por nível** — a estimativa de ~3.000 estava certa. As regiões
fixas: janela 814, cabeçalho 4.399, rodapé 1.399; a caixa cheia (60 linhas),
36.580.

Dois ajustes que a medição obrigou, e que a régua não teria mostrado:

1. **a caixa também sai elemento por elemento** (`Parts()`, como a trilha). Ela
   cresce com a pendência, o `Pack` só corta **entre** arrays, e cheia ela
   chegava a 36,5 KB — a um passo dos 40.000 num envio só;
2. **a caixa desenha no máximo 60 linhas**, com "e mais N esperando" na última.
   O teto é do **desenho**, nunca da promessa: a pendência não tem prazo (02
   §6.4) e a lista pode crescer por meses.

Nenhum envio passa de 40.000 em nenhum dos três tamanhos
(`openUnderLimit: true`). Medido fora do servidor, compilando o `.cs` contra as
DLLs do `server01` — `MeasureWorstCase` é `public static` justamente para isso.

> **PENDENTE:** o que continua sem medição é a **tela**, não os bytes. Ninguém
> viu esta trilha num cliente ainda.

### 4.4 O que o XP no card e o `[i]` custaram — 19/09/2026

O dono vai subir a trilha para **22 níveis**, e cada elemento novo no card é
multiplicado por 22. A conta, do mesmo `MeasureWorstCase`, antes e depois de
§3.2:

| Trilha | JSON antes | JSON depois | `AddUI` antes | `AddUI` depois |
|---|---|---|---|---|
| 10 níveis | 32.838 | 39.372 | 3 | 3 |
| 20 níveis | 65.206 | 78.304 | 4 | 4 |
| **22 níveis** | **71.638** | **86.084** | **4** | **5** |
| 30 níveis | 97.643 | 117.380 | 5 | 5 |
| 40 níveis | 130.161 | 156.470 | 6 | 6 |

**3.256 → 3.912 bytes por nível** (+656, +20%), e `openUnderLimit: true` em
todos os tamanhos, até 60 níveis. Os 656 se repartem assim: a tarja virou botão
(nome + comando, ~80 bytes) e ganhou tooltip (~55); o texto do XP e o `[i]` são
**os dois únicos elementos novos** do card, ~260 cada.

O modal é região própria (`Region.Detail`, 8.403 bytes no pior caso) e só é
desenhado quando aberto: **a abertura do menu continua custando o que
custava**, mais o que os 22 cards engordaram.

---

## 5. O que copiar do `OrigemZWorkshop.cs`, peça por peça

O plugin novo não se inventa: ele se copia. As peças, com linha:

| Peça | Onde | Para quê |
|---|---|---|
| seis regiões com raiz nomeada | `:2466` | redesenhar só o que mudou |
| `MenuSession` + token | `:2489` | estado por jogador |
| porteiro do comando (token + cooldown 0,08 s) | `:2760` | **recusa em silêncio** o que não bate |
| `Redraw` → `Compute*` → `Build*` → `Pack` → `AddUi` | `:3902` | a única porta de desenho |
| `Canvas`/`Parts()` com nomes curtos | `:4091` | deixa o `Pack` cortar em qualquer ponto |
| `Box`/`Rect` sobre base 1280×720 | `:4076` | a janela escala com a resolução |
| `ScrollArea` | `:4506` | a rolagem (§4.1) |
| `CollectChunk` | `:745` | remonta a carga em pedaços; lote fora de ordem é descartado inteiro |
| `Push` por `timer.Once(0.1f)` | `:5413` | **nunca** `Puts` no frame do comando |
| `MeasureWorstCase()` | `:5101` | medir bytes sem servidor |
| tooltip | `:4194` | o aviso da caixa (§6) |
| `InputField` com `needsKeyboard` | `:4671` | se houver busca |

E a classe base: `RustPlugin`, com `[ConsoleCommand]` e `[ChatCommand]`. **Não**
`CovalencePlugin` — lá `[ConsoleCommand]` não registra nada, o plugin carrega
limpo e o comando simplesmente não existe, com o sintoma chegando como
`RCON_TIMEOUT`.

---

## 6. A caixa de pendências — pedido do dono

> *"Colocamos no menu do passe um ícone de uma caixa e tooltip avisando itens que
> não foram recebidos, com um ponto no ícone como se fosse uma notificação que
> ele não visualizou ainda."*

O ícone fica no cabeçalho, ao lado do X. Ele tem três estados:

| Estado | Desenho |
|---|---|
| nada pendente | ícone apagado, ou ausente |
| há pendências | ícone aceso **com o ponto de notificação** |
| já visto | ícone aceso, **sem** o ponto |

O ponto é a marca de "ainda não olhou", e some quando o jogador abre a caixa —
não quando ele recebe os itens. São duas coisas diferentes: *ter pendência* e
*saber que tem*.

O tooltip lista o que está esperando. Ele serve a **duas origens** de pendência,
e elas precisam ficar distinguíveis na lista:

1. **o que não coube na mochila** — o jogador resgatou, o inventário estava
   cheio, e a entrega ficou devendo (ver [02](02-O-PASSE-DO-JOGADOR.md) §6.2);
2. **o que sobrou da temporada anterior** — o dono decidiu que o não resgatado
   **é entregue no próximo login**, e não confiscado. A caixa é onde isso
   aparece.

A segunda é a que justifica o pedido: uma entrega silenciosa no login seria um
punhado de itens aparecendo do nada, sem nada explicando de onde vieram.

> **Em aberto:** o que acontece se o jogador nunca abrir a caixa. A pendência
> tem prazo? Recomendo que **não tenha** — ela já é o resultado de uma promessa
> feita, e um segundo prazo em cima dela seria confiscar duas vezes.

---

## 7. O card na home

A home tem quatro cards hoje: RANKING, LOJA, WIPE, MISSÕES. O passe é o quinto,
e **este pedaço é do agente** (`core/src/game/ui-home-screen.ts`), mesmo com a
tela do passe no plugin — a home continua sendo gerada onde sempre foi.

1. `HomeCards` + `HOME_CARD_TARGET.pass` + `CARD_ID.pass` (`:837`, `:845`, `:855`);
2. `CARD_ICON.pass` (`:1020`);
3. o recorte no `HomeView` e no `emptyHomeView()` — **determinístico, sem
   `Date.now()`**, porque o preset é comparado byte a byte (`:340`);
4. `readHomeView` ganha um bloco com **`try` próprio**, para o passe não derrubar
   a home (`:440`);
5. `passCard(view)` no molde de `questCard` (`:1586`);
6. `buildHomeScreen` empurra o card (`:1148`).

O card dispara o comando que o plugin registra — o mesmo caminho pelo qual o
botão SKINS abre o menu de skins.

### 7.1 Três armadilhas da home

**O quinto card aperta.** `columnRect` divide a largura por `shown.length`
(`:807`): com cinco cards, cada um fica com ~232 px de ~1.160. O bloco de oferta
da loja já usa ícone de 108 px. **Meça antes de desenhar.**

**O card não aparece em menu já gravado.** Se a home gravada já tem os slots, o
gerador usa o template, e `fillTemplate` **preenche o que existe e não cria o que
falta** (`ui-template.ts:136`). Duas saídas: resetar o preset — que **descarta a
edição do admin** — ou um upgrade idempotente no boot, no molde de
`withSkinsTab` (`ui-skins-tab.ts:275`). O upgrade é o caminho certo, e há uma
memória do projeto que diz por quê: *upgrade de documento só roda uma vez*, então
ampliá-lo depois nunca alcança quem já foi migrado.

**O liga/desliga por servidor sai de graça** para o card: esconder a tela no
`hidden` do vínculo tira a tela **e** o card, por poda transitiva. As chaves de
faixa grátis/paga precisam de config própria.

---

## 8. O ícone de cada recompensa

| Recompensa | Como | Custo |
|---|---|---|
| item do jogo | `CuiImageComponent{ItemId, SkinId}` | zero — o cliente já tem a arte |
| skin do Workshop | o mesmo, com o `skinId` da skin | zero |
| OzCoin / kit / arte própria | PNG no `FileStorage` pelo CRC, via `OrigemZImages` | um upload |

**`SkinId = 0` num item que não tem skins derruba o jogador** — registrado em
`core/src/game/ui-cui.ts:198` e repetido no cabeçalho do Workshop
(`OrigemZWorkshop.cs:119`). Omita o campo, não mande zero.

PNGs próprios do plugin (estrela, cadeado, caixa) vão embutidos em base64 e
gravados no `FileStorage` no `OnServerInitialized`, como o Workshop faz em
`StoreIcons` (`:1379`).

---

## 9. O limite legal que pesa sobre "skin como recompensa"

Desde **07/08/2025** as diretrizes de servidor da Facepunch dizem, literalmente:

> *"you must not grant access to any Facepunch DLC to players who have not
> validly purchased it"* … *"Servers may not bypass ownership checks or
> artificially enable Facepunch DLC."*

A sanção declarada é **delistagem do navegador de servidores**, podendo chegar a
banimento do jogo. O que **é** permitido: cobrar assinatura, aceitar doação,
vender *"cosmetic items, effects or enhancements"* e ter moeda própria.

**A decisão do dono, 17/09/2026: skin de DLC entra na trilha, e só quem tem a
DLC vai poder usá-la.**

É a leitura correta da regra. O que ela proíbe é *conceder acesso* a quem não
comprou e *burlar a checagem de posse* — e respeitar a checagem é justamente o
que ela pede. A skin aparece na trilha para todo mundo; quem não tem a DLC vê o
motivo e não a leva.

Na tela, isso tem um desenho certo e um errado:

- **certo:** a recompensa aparece, com um `deadButton` — o botão que não é botão
  e **diz por quê**. O jogador entende, e eventualmente compra a DLC;
- **errado:** esconder. O jogador acharia que o passe engoliu o prêmio dele.

E o nível **conta como resgatado**, para ele não ficar preso numa trilha que
nunca fecha.

> **PENDENTE — a sonda que vem antes.**
> `PlayerBlueprints.CheckSkinOwnership(int skinItemId, BasePlayer player)` existe
> e recebe um `BasePlayer`, então **parece** consultável no servidor. Mas o que o
> projeto mediu foi o caminho oposto — *liberar* skins, que é developer-only
> (`Docs/OrigemZWorkshop/00-LEVANTAMENTO.md` §2.4). **Consultar a posse ninguém
> testou.** É um plugin descartável de dez linhas, e ele vem antes de a primeira
> skin de DLC entrar numa trilha. Se não funcionar, a regra volta a ser a
> conservadora: só skin nossa do Workshop.
>
> E falta uma marca nova no cadastro da skin dizendo **se ela é DLC** — sem isso,
> ninguém sabe o que verificar.
>
> **Fonte:** [Community Server and Hosting Guidelines](https://facepunch.com/legal/servers).

---

## 10. Como validar sem abrir o jogo

```powershell
# 1. o plugin compila?  (sem subir servidor)
core/scripts/pluginlint/

# 2. os bytes cabem?
origemz.passe.bytes          # o MeasureWorstCase copiado do Workshop

# 3. a carga chegou ao plugin?
GET /api/servers/<id>/console?lines=60
```

O bearer é o `AGENT_API_TOKEN` do `.env`, que vale nas rotas `/api`. E a
armadilha de sempre: **a resposta de um comando volta casada no POST /rcon**, não
no console — procurar no console faz o comando parecer mudo.

---

## 11. As armadilhas do CUI, em uma lista

| O quê | Consequência |
|---|---|
| `Puts` no frame do comando | entra na resposta casada do RCON e **a quebra** |
| `[ConsoleCommand]` em `CovalencePlugin` | não registra; o sintoma chega como `RCON_TIMEOUT` |
| `SkinId = 0` em item sem skins | **derruba o jogador** |
| `InputField` sem `needsKeyboard` | não aceita tecla |
| ScrollView sem goteira/respiro | a barra cobre a borda e o conteúdo é recortado |
| painel transparente de tela cheia | engole o clique no Unity |
| `arg.Args` tratado como `string[]` | é `Facepunch.StringView[]`: compila, roda e devolve lixo em silêncio |
| quinto card na home | aperta as colunas para ~232 px |
| lote de carga fora de ordem | descartado inteiro — a cópia anterior sobrevive, e é o certo |
