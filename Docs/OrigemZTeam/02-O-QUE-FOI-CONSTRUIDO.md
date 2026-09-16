# A aba EQUIPE — o que foi construído em 15/09/2026

Este documento fecha o [01](01-A-ABA-EQUIPE-DO-MENU.md), que era a especificação. Aqui está o
que existe no código, o que foi decidido no caminho, **e o que ainda não foi medido no jogo**.

Quem lê isto: quem for mexer na tela depois — e quem for testá-la com o jogo aberto, que é a
única forma de fechar as três perguntas do §5.

---

## 1. O caminho inteiro, como ele ficou

```
  jogador digita /equipe, /team, ou clica na aba EQUIPE
        ↓
  OrigemZUI.cs:  #OZUIREQ#{"screenId":"tela-equipe","steamId":"765…"}
        ↓
  ui-sync.ts → index.ts → teamScreens(input)
        ↓
  ui-team-screen.ts   monta a tela COM O CARGO de quem abriu
        ↓                (teamsService.teamOf → RCON → o jogo)
  ui-cui.ts → RCON → o plugin desenha
```

E o caminho de volta, quando ele clica ou aperta Enter:

```
  botão            origemz.ui.act   <token> <actionId>
  campo de texto   origemz.ui.input <token> <actionId> <o que ele escreveu>
        ↓
  OrigemZUI.Resolve  — token da sessão, a ação está NA TELA de agora, permissão
        ↓
  #OZBUY#{…,"value":"Alcateia do Norte"}
        ↓
  index.ts → runTeamAction  — relê a equipe, confere o cargo, e AÍ age
        ↓
  TeamsService → origemz.team … → o jogo
```

**A permissão é conferida duas vezes, de propósito.** Uma para decidir que botão desenhar,
outra antes de agir — as duas contra a mesma tabela (`TEAM_POWERS_BY_RANK`). O endereço de um
botão é digitável no F1: quem nunca viu o botão de expulsar pode mandar o clique dele.

E **quem clicou nunca vem do clique**: sai da conexão, no plugin. O que viaja no endereço é o
ALVO, e ele só vale se estiver na mesma equipe de quem pediu.

### Os arquivos

| Arquivo | O que é dele |
|---|---|
| `core/src/game/ui-team-screen.ts` | a tela, a sidebar, as confirmações, `withTeamTab` |
| `core/src/types/teams.ts` | `TEAM_POWERS_BY_RANK`, `rankCan`, `rankOutranks` |
| `core/src/index.ts` | `runTeamAction` — onde a permissão é cobrada |
| `core/src/game/ui-preset-main-menu.ts` | a aba na barra e os atalhos `/equipe`, `/team` |
| `core/test/ui-team-screen.test.ts` | 29 testes: cargos, endereço, geometria, orçamento |

---

## 2. O campo de texto — o que é novo no modelo

O dono pediu para o nome ser digitado **dentro do menu**, e não por comando de chat. O modelo
tinha quatro tipos de elemento (`panel`, `label`, `button`, `image`) e nenhum aceitava
digitação. Agora tem cinco.

### O que foi preciso

1. **`ui-document.ts`** — o tipo `input`, com a ação restrita a `store.buy` (é a única com
   caminho de volta ao agente);
2. **`ui-cui.ts`** — a conversão para `UnityEngine.UI.InputField`, com `needsKeyboard: true`.
   **Sem esse campo o jogo não solta o teclado do personagem**: o campo aparece, aceita o
   clique, pisca o cursor, e não escreve nada;
3. **`OrigemZUI.cs`** — o comando `origemz.ui.input`, separado do `origemz.ui.act` porque o
   que vem depois do endereço é texto livre (e afrouxar o `CmdAct` para caber um nome com
   espaço enfraqueceria a validação de todo clique do menu);
4. **o painel** — o editor SABE desenhar um `input`, mas não o oferece na paleta: um campo
   criado à mão nasceria inútil, porque a ação dele precisa do agente.

### Três coisas que o campo faz e não são óbvias

- **O cliente anexa o texto CRU ao comando.** Sem aspas, sem escape. Um nome com espaço chega
  partido em vários argumentos, e é o `RestOfLine` que os remonta — lendo por
  `arg.GetString(i)`, nunca por `arg.Args`, que é `Facepunch.StringView[]` e vira lixo em
  silêncio num `string.Join`.
- **O JSON do aviso escapa o texto com `JsonConvert.ToString`.** Concatenar à mão seria o bug
  mais fácil deste arquivo: um nome com uma aspa dupla quebraria a linha inteira, e o agente
  descartaria junto a compra de outra pessoa que viesse no mesmo frame.
- **Ele não tem placeholder.** O CUI tem (`placeholderId`, apontando para outro elemento), e
  seriam dois elementos amarrados por id para dizer o que a linha de instrução ao lado já diz.

---

## 3. O menu estava cheio — e o conserto foi de raiz

A aba não coube. A carga inicial do menu viaja num frame de RCON (**teto de 50.000 bytes**) e
estava em **47.668**; a aba custa 1.820. Sobrariam 512 bytes — 1%.

As saídas estavam na mesa (é o mesmo dilema registrado em `test/ui-home-screen.test.ts`), e o
dono escolheu a estrutural: **consertar o que estava caro**.

### O que estava caro

O "você está aqui" da barra — o botão que fica vermelho na aba aberta — viajava como **dois
elementos CUI completos por botão de navegação**, com `command`, `text`, `fontSize`, `font` e
`align` repetidos em todos. Onze botões: **4.795 bytes**. E o mesmo bloco ia de novo em **cada
tela servida**.

Tudo isso para dizer uma coisa: qual deles está aceso.

### Como ficou

O agente manda uma **tabela** (`navStates`), uma vez, no documento:

```json
{"id":"nav-equipe","on":"tela-equipe","color":"0.76 0.25 0.17 1","textColor":"1 1 1 1"}
```

E cada tela manda só o endereço que conta como "você está aqui" (`activeId`). Quem pinta é o
plugin, copiando os componentes do **shell que ele mesmo desenhou** — as cores do estado
normal ele já tem.

| | antes | depois |
|---|---|---|
| carga do menu | 49.488 | **44.484** |
| folga contra o teto | 512 (1%) | **5.516 (11%)** |
| por tela servida | +4.795 crus | +20 |

O campo `updates` continua no protocolo, vazio: um plugin anterior a esta mudança ainda o lê,
e um array vazio é o que faz ele não destacar nada em vez de quebrar.

**O risco desta troca é silencioso.** Se a tabela sair errada, nenhuma aba acende — e isso não
derruba nada, não aparece em log, e só se vê abrindo o jogo. Por isso ela tem teste
(`ui-menu-shell.test.ts`), e por isso ela está na lista do §5.

---

## 4. Duas armadilhas que custaram tempo aqui

### O upgrade do documento só roda UMA vez

`withTeamTab` acrescenta a aba ao menu já gravado, no boot. Ele começava recusando o documento
que já tivesse a `tela-equipe` — o que parece certo e não é.

**ACONTECEU no server01:** o agente subiu com uma versão que ainda não tinha os atalhos, gravou
a aba, e a versão seguinte viu a tela no lugar e desistiu. O menu ficou com o botão EQUIPE e
sem `/equipe`, **para sempre**.

O conserto é olhar as duas coisas separadamente, em vez de tratar a tela como prova de que o
resto foi feito. Vale para qualquer upgrade deste tipo — e o `withDiscordScreen` e o
`withStreamerTab` têm o mesmo desenho, com o mesmo risco.

### Editar `core/src` com o agente em `tsx watch` derruba o WebRCON

Ele não volta sozinho: o sintoma é `1006` em laço, e o `server-restart` normal **falha** ("o
RCON não responde e force não foi pedido"). O que funciona é `{"kind":"server-restart","force":true}`,
e ele leva ~2 minutos para o RCON voltar.

Agrupe as edições. E confira quantos agentes estão em watch: três instâncias disputando o
mesmo RCON e o mesmo banco é um ambiente em que nada se mede.

---

## 5. O que AINDA NÃO FOI MEDIDO — precisa do jogo aberto

Isto não é ressalva de rodapé: são três perguntas abertas, e as três só o cliente do Rust
responde. O CUI **não se confere daqui** — o servidor manda o JSON e quem o desenha é o
jogador.

O que já está provado: o `OrigemZUI.cs` compila e carrega no server01; o documento gravado tem
a aba, a tela e os dois atalhos; o `origemz.team list` responde com as equipes reais; e a carga
cabe no frame com 5.516 bytes de folga.

### 1. O campo de texto aceita digitação e o Enter volta com ela?

**É a pergunta principal, e ela nunca foi respondida neste projeto.** O `OrigemZQueue.cs` já
usa um `InputField`, mas o dele é `ReadOnly` — serve para copiar uma URL, e nunca exercitou o
caminho de volta.

Como testar: abrir `/equipe` como **líder**, clicar no campo do nome, digitar e apertar Enter.

- Se o chat responder "A equipe agora se chama X" → o caminho inteiro funciona.
- Se o campo não aceitar tecla → o `needsKeyboard` não bastou.
- Se aceitar e o Enter não fizer nada → o `command` do InputField não volta com o texto, e o
  plano B é o comando de chat (`/equipe nome <x>`), que custa um `[ChatCommand]` no
  `OrigemZTeam.cs`.

Com `origemz.ui.debug 1` ligado, o console mostra `input: eq-nome-a -> [o que chegou]`.

### 2. A barra continua acendendo a aba aberta?

O mecanismo mudou por inteiro (§3). Navegue entre três ou quatro abas e confira que a aberta
fica vermelha e a anterior apaga. **Se nenhuma acender, é aqui.**

Vale conferir também com um jogador **sem** o modo streamer liberado: a barra dele não tem o
botão CONFIG, e o `PushNavUpdate` precisa pular o que não está na tela dele.

### 3. A tela cabe, e os botões estão onde deveriam?

A geometria tem teste, mas contra medidas calculadas — não contra o que o cliente desenha.
Olhar: a lista de membros com a equipe cheia (8), o botão SAIR no rodapé, e os três botões da
linha de um membro sem se sobrepor.

---

## 6. O que sobrou de fora

- **Convite pela tela.** É do menu nativo do Rust, de propósito — um segundo sistema de convite
  ao lado do primeiro seriam duas filas para a mesma porta.
- **A lista completa numa equipe maior que a tela.** Ela corta e diz "e mais N — a lista
  completa está no painel". Paginar aqui custaria uma família de endereços para um caso que o
  `maxTeamSize` padrão (8) não produz.
- **O KOTH.** A aba tem uma coluna com um item só justamente para o placar por equipe entrar
  nela sem redesenhar nada.
