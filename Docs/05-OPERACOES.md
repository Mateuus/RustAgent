# 05 — Operações

Este é o documento do coração do produto: o que acontece de verdade quando
alguém clica em **Instalar**, **Iniciar**, **Parar** ou **Atualizar**.

---

## O SteamCMD é um só, para a máquina inteira

`SteamCMD\steamcmd.exe`, na raiz do projeto. Não há um por servidor.

São ~300 MB de cliente mais um cache de catálogo; duplicá-lo por servidor
gastaria disco para criar o problema de dois processos disputando o mesmo lock
do Steam. **O que muda por servidor é o `+force_install_dir`.**

### Garantir o SteamCMD (`steam/steamcmd.ts`)

Roda sozinho, antes de qualquer instalação, e é idempotente:

1. `SteamCMD\steamcmd.exe` existe? Se sim, pula para o passo 4.
2. baixa `https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip`;
3. extrai em `SteamCMD\`, apaga o zip, confere que o `.exe` apareceu;
4. roda `steamcmd.exe +quit` uma vez — é o auto-update do próprio cliente, e na
   primeira vez demora alguns minutos. **Isso é normal e precisa aparecer no
   log da tela**, senão parece travado.

Falha de rede aqui é erro de operação com mensagem própria: "não consegui
baixar o SteamCMD (…). Confira a conexão da máquina." — e não um stack trace.

---

## `server-install` — instalar é a mesma coisa que atualizar

O SteamCMD faz as duas: baixa os ~6 GB na primeira vez e aplica a diferença nas
seguintes. Por isso a operação é uma só, e a **primeira execução dela é a
instalação**.

```
  1. garantir o SteamCMD                       (acima)
  2. criar Servers\<id>\ e Logs\<id>\
  3. steamcmd.exe +force_install_dir "<Servers\id>"
                  +login <STEAM_LOGIN>
                  +app_update <STEAM_APPID> <branch> validate
                  +quit
  4. conferir Servers\<id>\RustDedicated.exe
  5. instalar o Oxide por cima                 (adiante)
  6. gravar o build instalado no cache
```

AppID, login e branch saem da seção `[SteamCMD]` do `Configs\<id>.ini` —
`STEAM_APPID=258550`, `STEAM_LOGIN=anonymous`, `STEAM_BRANCH` vazio para
`public`.

### As recusas, antes de qualquer download

| Recusa | Código | Por quê |
|---|---|---|
| servidor no ar | 409 `SERVER_RUNNING` | o SteamCMD reescreve arquivos que o processo mantém abertos |
| já há operação com o SteamCMD | 409 `OPERATION_IN_PROGRESS` | um lock só; dois `app_update` deixam a pasta pela metade |
| disco cheio | 409 `NOT_ENOUGH_DISK` | conferido antes: ~12 GB livres para a primeira instalação |
| `serverId` desconhecido | 404 | — |

Todas acontecem **antes** do `202`. Depois do `202`, o que sai é log.

### O log

O SteamCMD imprime dezenas de milhares de linhas, e a maioria é progresso
(`Update state (0x61) downloading, progress: 42.15`). O agente:

- transcreve tudo para o log da operação, mantendo as **últimas 2000 linhas**;
- conta em `droppedLines` quantas descartou;
- extrai o **percentual** dessas linhas de progresso e o publica em
  `operation.progress`, para a tela ter uma barra em vez de um paredão de texto;
- grava o log inteiro, sem corte, em `Logs\<id>\steamcmd-<carimbo>.log`.

Uma instalação pode passar de uma hora. O timeout da operação é generoso
(3 horas) e existe só para não deixar um processo travado segurando a trava
para sempre.

---

## O Oxide

Todo `app_update` **sobrescreve** os assemblies do Oxide em
`RustDedicated_Data\Managed`. Por isso a reinstalação do Oxide é parte da
operação de instalar/atualizar, e não um passo que alguém precisa lembrar.

As pastas `oxide\plugins`, `config`, `data` e `lang` **não** são perdidas — só
os assemblies do loader.

```
  1. recusar se o RustDedicated.exe estiver rodando
  2. backup de Servers\<id>\oxide\  ->  Backups\<id>\oxide-<carimbo>\
  3. descobrir a release:
       GET api.github.com/repos/OxideMod/Oxide.Rust/releases/latest
       asset "Oxide.Rust.zip"
       (falhou? URL direta: /releases/latest/download/Oxide.Rust.zip)
  4. baixar para um temporário, extrair
  5. copiar a árvore por cima de Servers\<id>\  (sobrescrevendo)
  6. conferir os quatro assemblies em RustDedicated_Data\Managed:
       Oxide.Core.dll  Oxide.Rust.dll  Oxide.CSharp.dll  Oxide.Common.dll
  7. criar oxide\{plugins,config,data,lang,logs} se não existirem
```

> **A pasta `oxide\` não vem no zip.** Quem a cria é o próprio Oxide, no
> primeiro boot do servidor. A ausência dela logo após instalar é o estado
> normal, nunca um erro. Criamos a árvore para que dê para largar um plugin em
> `oxide\plugins` **antes** de subir o servidor pela primeira vez.

O passo 6 é o que decide se a instalação deu certo. Só ele.

---

## `server-start` — subir o servidor

```
  1. conferir Servers\<id>\RustDedicated.exe                  senão: 409
  2. conferir que ele não está JÁ rodando                     senão: 409
  3. conferir as quatro portas livres NA MÁQUINA              senão: 409
  4. criar Logs\<id>\
  5. spawn destacado:
       Servers\<id>\RustDedicated.exe -batchmode -nographics
         +server.hostname     "<SERVER_HOSTNAME>"
         +server.identity     "<SERVER_IDENTITY>"
         +server.description  "<SERVER_DESCRIPTION>"
         +server.level        "<SERVER_LEVEL>"
         +server.seed          <SERVER_SEED>
         +server.worldsize     <SERVER_WORLDSIZE>
         +server.maxplayers    <SERVER_MAXPLAYERS>
         +server.port          <SERVER_PORT>
         +server.queryport     <SERVER_QUERYPORT>
         +server.saveinterval  <SERVER_SAVEINTERVAL>
         +rcon.port            <RCON_PORT>
         +rcon.password       "<RCON_PASSWORD>"
         +rcon.web             1
         [+app.port <SERVER_APPPORT>]  [+server.url ...]  [+server.headerimage ...]
         -logfile "Logs\<id>\server-<identity>.log"
       cwd = Servers\<id>       detached = true      stdio = ignore
  6. esperar o RCON responder (até SERVER_START_TIMEOUT_MS, padrão 15 min)
```

Três coisas que a lista acima esconde e importam:

**O `cwd` é obrigatório.** O jogo grava arquivos relativos ao diretório de
trabalho. Sem ele, saves e configs iriam para a pasta do agente.

**O caminho do executável é absoluto.** Chamado pelo nome, ele só é encontrado
quando o processo pai procura no diretório atual — busca que está desligada em
parte dos ambientes (`NoDefaultCurrentDirectoryInExePath`, herdada sem avisar).
O sintoma é cruel: funciona a partir do Explorer e falha a partir do serviço,
com o executável ali na pasta.

**"Subiu" é o RCON responder.** Gerar um mapa procedural leva minutos, e o
processo existe durante todo esse tempo sem aceitar ninguém. Enquanto o RCON
não responde, o estado na tela é *iniciando*, com o tempo decorrido — não
*no ar*, e não *erro*.

**O `rcon.web` é sempre 1.** O agente fala WebRCON; o RCON binário antigo não
serve. O `.ini` traz `RCON_WEB=1` e o agente recusa subir um servidor com 0.

---

## `server-stop` — parar salvando o mundo

```
  1. RCON conectado?
       sim  ->  `server.save`, esperar; depois `quit`
       não  ->  409 RCON_UNAVAILABLE   (a menos que force: true)
  2. esperar o processo sumir (até 2 min)
  3. ainda vivo?  ->  taskkill /PID <pid> /T /F
```

`quit` pelo RCON é o **único** jeito de parar salvando. `force: true` mata o
processo e perde tudo desde o último `server.saveinterval` — é o botão para
quando o servidor travou, e a tela diz isso com essas palavras.

---

## `server-update` e `server-auto-update`

`server-update` é o `server-install` com o servidor obrigatoriamente parado.

`server-auto-update` é o ciclo inteiro numa operação só, e é o que o agente
dispara **sozinho** quando a Facepunch publica um build novo:

```
  1. avisa no chat  (abertura + marcos em 15/10/5/3/2/1 min, 30 s, 10 s)
  2. server.save
  3. quit  (encerramento limpo)
  4. o SteamCMD + o Oxide     (= server-install)
  5. confere o buildid que ficou em disco
  6. sobe e espera o RCON responder
```

- **servidor já parado** pula direto para o passo 4;
- **nenhum jogador online** encurta a contagem para 1 minuto;
- **cancelar durante a contagem** avisa no chat que foi adiado, e nada cai;
- **sem RCON com o servidor no ar**, recusa: não dá para avisar ninguém nem
  encerrar salvando. Uma atualização não vale o mundo de todo mundo desde o
  último save. `force: true` passa por cima;
- **a atualização falhar não deixa o servidor fora do ar.** Quem o derrubou fomos
  nós; ele volta com o build antigo, a operação consta como **falhou** e o painel
  mostra o motivo. "Desatualizado" é ruim, "sumiu da lista" é pior.

`STEAM_AUTO_UPDATE=1` (o padrão) é o que faz o passo 1 começar sozinho. Com `0`,
o build novo só aparece no painel e a operação espera um clique.

### Como o agente sabe que há atualização

A primeira conferência sai **um minuto depois do agente subir** — antes ela só
saía depois do intervalo inteiro, e um servidor recém-ligado passava quinze
minutos desatualizado com o painel sem nada a mostrar. Depois disso, de 15 em 15
minutos ele compara duas coisas:

| | de onde sai | o que é |
|---|---|---|
| **instalado** | `Servers\<id>\steamapps\appmanifest_258550.acf` | o `buildid` que o SteamCMD gravou no fim do último download |
| **publicado** | `steamcmd +app_info_print 258550` | o `buildid` do branch, direto do catálogo da Steam |

A consulta leva ~4 s, **não baixa nada** e é segura com o servidor no ar. Ela
cede a vez quando há qualquer operação rodando: `app_info_print` e `app_update`
disputam o mesmo lock do SteamCMD.

> **Por que não usar o `Protocol` do `serverinfo`:** ele exige o servidor no ar
> — e é justamente com ele parado que mais interessa saber se há update
> pendente. E as correções semanais mudam o build sem mudar o protocolo: o
> servidor ficaria desatualizado em silêncio.

Três travas que impedem o pior:

- **três tentativas por build, uma hora entre elas.** Um update que falha deixa
  o build velho instalado, e a rodada seguinte veria a mesma diferença — sem a
  trava, o servidor seria derrubado a cada 15 minutos, para sempre;
- **instalação inexistente não é "atualização".** Numa máquina onde o jogo
  ainda não foi baixado, `updateAvailable` é `false`. Instalar pela primeira vez
  é um clique de quem monta, não algo a disparar sozinho de madrugada;
- **falhar em perguntar ≠ estar em dia.** Uma consulta que não foi vira
  `lastError` no estado, e a tela mostra em vermelho em vez de afirmar que está
  tudo certo.

### Como o agente sabe que a atualização deu certo

Nem pelo código de saída do SteamCMD (ele sai 7/8 em execuções boas), nem pelo
`RustDedicated.exe` existir — numa **atualização** ele já existe desde antes, e
foi assim que um job abortado passou por instalação boa, ganhou o Oxide, subiu o
servidor e anunciou "jogo instalado" com o build velho em disco:

```
 Update state (0x3) reconfiguring, progress: 0.00 (0 / 0)
Error! App '258550' state is 0x486 after update job.
[SteamCMD] terminou com código 8
```

São duas conferências, e as duas precisam passar:

1. **a linha de erro do SteamCMD.** `Error! App '...' state is 0x...` significa
   que o job terminou e o app continua fora de ordem. O agente traduz o campo de
   bits (`0x486` = instalado por completo + atualização pendente + arquivos
   corrompidos + atualização começada e não terminada), **tenta de novo até três
   vezes** apagando `steamapps\downloading\<appid>` entre elas, e só então
   desiste — com uma mensagem que diz o espaço livre no disco e o que conferir.
   O que ele **não** apaga é o `appmanifest` nem os arquivos do jogo: isso
   trocaria uma atualização de 300 MB por uma reinstalação de 25 GB;
2. **o `buildid` que sobrou no manifest.** Tem que ser o publicado. Quando o
   vigia dispara a operação ele passa o build que acabou de ver; num clique pelo
   painel, o agente pergunta à Steam no fim (~4 s). Não conseguir perguntar não
   reprova nada — fica registrado no log da operação.

Um servidor de build velho não fica lento: ele **recusa todos os jogadores**, em
silêncio. Por isso essa diferença é falha da operação, e não um aviso.

---

## A trava: uma operação por recurso

Não é "uma operação por máquina" — é por **recurso nomeado**:

| Recurso | Quem disputa |
|---|---|
| `steamcmd` | `server-install`, `server-update`, `server-auto-update`, a consulta do vigia |
| `disk:<id>` | qualquer coisa que escreva em `Servers\<id>\` (Oxide, plugins) |
| `server:<id>` | start, stop, restart daquele servidor |

Assim, subir o `pvp1` enquanto o `pve` está instalando **não** é bloqueado, e
duas instalações **são**. A recusa diz quem está segurando o quê:

```json
{ "ok": false, "error": "OPERATION_IN_PROGRESS",
  "message": "O SteamCMD já está ocupado com a operação server-install do servidor pve (começou há 4 min)." }
```

---

## Como se acompanha uma operação

```
POST /api/servers/pvp1/operations   {"kind":"server-install"}
  -> 202  { "ok": true, "operationId": "op_7f3a…" }

GET /api/operations/op_7f3a…?fromLine=0
  -> { "status":"running", "progress": 42.15,
       "lines":[{"n":0,"at":"2026-08-14T18:22:01.014Z","text":"[SteamCMD] baixando…"}],
       "nextLine": 128, "droppedLines": 0 }
```

O painel repete a chamada com `fromLine=nextLine`. O histórico guarda as **20
últimas** operações em memória e some quando o agente reinicia: não é registro
de auditoria, é o que aconteceu nesta sessão.

---

## Plugins (a parte genérica)

O agente não conhece plugin nenhum. Ele sabe onde eles moram e como pedir para
o Oxide recarregar.

| Ação | O que faz |
|---|---|
| listar | lê `Servers\<id>\oxide\plugins\*.cs`, com tamanho e data |
| instalar | grava o `.cs` enviado, e roda `oxide.reload <Nome>` pelo RCON |
| remover | apaga o `.cs`, e roda `oxide.unload <Nome>` |
| recarregar | só o `oxide.reload <Nome>` |

Duas travas, e as duas são de segurança, não de zelo:

- **o nome do arquivo passa por regex estrito** (`^[A-Za-z0-9_.-]+\.cs$`) e o
  caminho final é conferido contra a pasta de plugins daquele servidor. Um
  `..\..\RustDedicated_Data\Managed\Oxide.Core.dll` no nome do upload
  substituiria um assembly do loader;
- **o conteúdo precisa começar como C#** e caber no limite (256 KB). Não é
  antivírus — é o que impede que um upload errado vire um arquivo que o Oxide
  tenta compilar para sempre, enchendo o log.

O plugin que falha ao compilar aparece no log do Oxide, e o agente devolve
essas linhas na resposta do `install` — senão o operador clica, não vê nada
mudar e não descobre por quê.
