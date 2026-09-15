# A aba EQUIPE do `/menu` — especificação para implementação

**Para quem for implementar esta tela.** Ela é uma frente fechada: não depende do KOTH nem
dos eventos, e tudo de que ela precisa do lado do servidor **já existe e está em produção**.

O que já está pronto (não reescrever): o plugin `OrigemZTeam.cs`, o serviço
`core/src/game/teams.ts`, as rotas HTTP e a aba Equipes do painel. Ver
[00-LEVANTAMENTO.md](00-LEVANTAMENTO.md) para o que foi medido no jogo.

---

## 1. O que a tela é

Uma aba **EQUIPE** no menu que o jogador abre no jogo, com **sidebar à esquerda** (o padrão do
Ranking, das Missões e das Regras) e o conteúdo à direita.

O que o jogador faz nela:

| Ação | Quem pode | Já existe do lado do servidor? |
|---|---|---|
| Ver a equipe: nome, membros, quem está online, cargo de cada um | qualquer membro | sim |
| **Editar o nome** da equipe | líder (ver §5) | sim — `POST /servers/:id/teams/:teamId/name` |
| **Promover / rebaixar** um membro a oficial | líder | sim — `POST …/rank` |
| **Passar a liderança** | líder | sim — `POST …/leader` |
| **Expulsar** um membro | líder (e oficial? ver §5) | sim — `DELETE …/members/:steamId` |
| Sair da equipe | qualquer membro | **não** — o jogo já tem `leave`; ver §6 |

Quem **não está em equipe** vê a tela dizendo isso, e como entrar (o convite é do jogo, pelo
menu nativo). Não invente um sistema de convite paralelo: a equipe é do Rust.

---

## 2. Como uma tela do menu com dado vivo é feita neste projeto

**Não desenhe esta tela no editor do painel.** O editor serve para telas cujo conteúdo é fixo.
Esta muda por jogador (a equipe dele) e a cada segundo (quem está online), então ela é uma
**tela gerada**: o documento guarda só o ENDEREÇO, e o agente monta o conteúdo no clique.

O caminho inteiro, na ordem:

```
  jogador clica na aba
        ↓
  OrigemZUI.cs grita no console:  #OZUIREQ#{"screenId":"tela-equipe","steamId":"765…"}
        ↓
  core/src/game/ui-sync.ts  (handleLine → o bloco "TELA GERADA VEM PRIMEIRO")
        ↓
  core/src/index.ts  →  generatedScreens({ serverId, screenId, steamId, … })
        ↓
  o SEU construtor: core/src/game/ui-team-screen.ts
        ↓
  ui-cui.ts converte o modelo em CUI e o RCON devolve ao plugin
```

**O modelo a copiar é `core/src/game/ui-streamer-screen.ts`** — a tela mais nova, feita com
sidebar, gerada por jogador e volátil. Leia o cabeçalho dela inteiro antes de começar: ele
explica por que a coluna existe mesmo com um item só, e por que as medidas são copiadas das
outras telas em vez de reinventadas.

As medidas de coluna, cartão e espaçamento vêm de `ui-widgets.ts` e das telas vizinhas.
**Quatro telas com colunas parecidas mas não iguais é pior que uma só:** o olho nota a
diferença de 4 px e ninguém sabe qual é a certa.

### O que NÃO pode

- **`volatile: true` no pacote.** A tela mostra quem está online agora; em cache ela mente.
  (O plugin guarda telas por cinco minutos.)
- **`screenId` com `:` não pode ir para o documento.** O `uiDocumentSchema` recusa, e o menu
  some do jogo. Endereços com parâmetro (`tela-equipe:membro:765…`) só existem na tela que o
  agente monta no clique — ver §3.2 de `Docs/Interface/01-TELAS-DESENHADAS-EM-VEZ-DE-PROGRAMADAS.md`.
- **Nome de jogador é texto do jogador.** Renderize como texto seguro; não interprete marcação
  que veio dele.

---

## 3. De onde vêm os dados

Tudo de `core/src/game/teams.ts` (`TeamsService`), que já está instanciado no `index.ts` como
`teamsService`:

```ts
await teamsService.teamOf(serverId, steamId)   // a equipe DELE, ou null
await teamsService.snapshot(serverId)          // todas (não use nesta tela)
teamsService.settingsOf(serverId)              // { maxSize }
```

O que volta (`core/src/types/teams.ts`):

```ts
interface Team {
  teamId: string;      // TEXTO: é ulong e passa de 2^53
  name: string;        // vazio = ninguém batizou
  leader: string;      // SteamID
  leaderName: string;
  ageSeconds: number;  // NÃO é data: conta do boot do servidor
  members: TeamMember[];   // já vem ordenado: líder, oficiais, resto por nome
  officers: number;
}

interface TeamMember {
  steamId: string;
  name: string;
  online: boolean;
  leader: boolean;
  rank: 'leader' | 'officer' | 'member';
}
```

**A leitura pergunta ao JOGO a cada chamada**, por RCON. Isso é de propósito: a equipe muda a
cada convite aceito. Duas consequências para a tela:

1. ela **lança** quando o servidor não responde — trate e mostre um aviso, não uma tela vazia
   ("não consegui perguntar" e "você não tem equipe" são coisas diferentes);
2. não chame em laço. Uma leitura por abertura de tela.

---

## 4. As ações: como o clique vira mudança

**Regra do projeto, e ela não é negociável:** a ação é sempre do AGENTE. O botão do desenho
diz onde ele fica; o que ele faz é decidido no preenchimento. Ver §3.1 do documento de
interface.

Há dois caminhos possíveis, e o certo aqui é o segundo:

| Caminho | Quando usar |
|---|---|
| Ação `chat` — o botão roda um comando COMO O JOGADOR | quando já existe um comando de chat que faz a coisa (foi o que a tela do streamer usou) |
| **Ação própria, tratada no agente** | quando a ação precisa de permissão, validação ou de falar com o plugin — que é o caso aqui |

Siga o desenho da loja e das missões: a ação carrega um identificador, o agente resolve o
SteamID **pela conexão que clicou** (nunca por argumento), confere a permissão e chama o
`TeamsService`.

> As ações carregam o `offerId` e a quantidade que serão COBRADOS — se viessem do documento,
> um admin distraído (ou um documento adulterado) mudaria o preço de uma compra.
> — `ui-store-template.ts`

Vale igual aqui: se a ação carregasse "qual equipe" ou "qual jogador expulsar" sem
conferência, um pacote forjado expulsaria alguém de outro time.

### O que o agente precisa validar antes de agir

O `TeamsService` **já recusa** promover quem não é membro e mexer no cargo do líder. O que ele
**não** sabe é quem PEDIU — isso é da tela:

1. o SteamID que clicou está na equipe que a ação menciona?
2. ele tem cargo para isso? (§5)
3. o alvo está na mesma equipe?

---

## 5. Quem pode o quê — a decisão que falta

O cargo existe (`leader` / `officer` / `member`), e o que cada um PODE fazer **ainda não foi
decidido**. É a pergunta 2 do [00-LEVANTAMENTO.md](00-LEVANTAMENTO.md) §5.

A proposta abaixo é razoável e precisa ser confirmada com o dono antes de codar:

| Ação | Líder | Oficial | Membro |
|---|---|---|---|
| Ver a tela | sim | sim | sim |
| Renomear a equipe | sim | **a decidir** | não |
| Promover / rebaixar | sim | não | não |
| Passar a liderança | sim | não | não |
| Expulsar | sim | **a decidir** | não |
| Sair da equipe | sim (desfaz, se for o último) | sim | sim |

**Não invente a resposta.** Pergunte, e depois deixe a tabela escrita no código, num lugar só.

---

## 6. Sair da equipe

Não existe rota para isso hoje, e provavelmente não deve existir no painel — sair é do
jogador, não do admin. No jogo o Rust já tem o comando nativo, e o hook `OnTeamLeave` já chega
ao agente (o cargo é apagado).

Se a tela oferecer o botão, o caminho mais barato é a ação `chat` rodando o comando nativo
como o jogador — sem rota nova, sem comando nosso.

---

## 7. O que o servidor já garante (não reimplemente)

- **o nome persiste** no save do jogo e é sincronizado ao cliente (`teamName`);
- **o tamanho máximo** vem do convar oficial e o agente o reaplica no boot — ele NÃO persiste
  sozinho (medido: `server.writecfg` não o grava);
- **equipe desfeita apaga os cargos**, pelos dois caminhos (o comando e o último membro
  saindo);
- **quem vira líder perde o cargo gravado** — liderança é do jogo;
- **o líder do jogo ganha de qualquer linha do banco** na hora de montar a lista.

---

## 8. Armadilhas medidas neste projeto

Estas custaram tempo a quem veio antes. Ler antes de escrever:

1. **O `Puts` de um plugin entra na resposta casada do comando.** Se você mexer no
   `OrigemZTeam.cs` e fizer ele responder E gritar no mesmo frame, o JSON da resposta chega
   corrompido ao agente. O aviso sai num `timer.Once`. Ver `Push` no plugin e `cleanReply` no
   serviço.
2. **`[ConsoleCommand]` não funciona em `CovalencePlugin`.** Compila, carrega, e o comando não
   existe — o sintoma é timeout de RCON. Use `[Command]`.
3. **O CUI só o cliente resolve.** Não dá para conferir a tela sem abrir o jogo. O que dá para
   conferir daqui é que ela foi PEDIDA e SERVIDA: procure o `#OZUIREQ` no console
   (`GET /api/servers/:id/console?lines=…`).
4. **Cada elemento do CUI custa ~390 bytes** e o frame tem teto de 50.000. Uma lista de oito
   membros com quatro elementos cada já são ~13 KB — cabe, mas faça a conta antes de encher a
   tela de detalhe.
5. **Editar `core/src` com o agente em `tsx watch` reinicia o agente e derruba o WebRCON**, que
   não volta sozinho: só reiniciando o servidor de jogo. Agrupe as edições.

---

## 9. Por onde começar

1. Ler `ui-streamer-screen.ts` inteiro (é o modelo) e o §2 deste documento.
2. Perguntar ao dono a tabela do §5.
3. Escrever `core/src/game/ui-team-screen.ts` com o construtor e a sidebar; registrar o
   endereço em `generatedScreens` no `index.ts`, junto dos outros.
4. Pôr a aba no preset do menu (`ui-preset-main-menu.ts`), como o streamer fez.
5. Testar com o servidor de pé: abrir o menu no jogo, e conferir o `#OZUIREQ` no console.
