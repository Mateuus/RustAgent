# 06 — API

Base: `http://127.0.0.1:8787`. Formato: JSON, sempre com `ok` no corpo.

Este documento cobre as rotas da **Fase 1** e as do **wipe, calendário e
mensagens** (Fase 6). As rotas das fases do meio — administração, itens, kits,
VIP, loja — ainda não passaram por aqui; elas estão descritas nos briefings
[10](10-FASE-ADMINISTRACAO.md) a [15](15-BRIEFING-VIP-LOADOUTS-KITS.md).

---

## Dois jeitos de se identificar

| Quem | Como | Onde vale |
|---|---|---|
| **o painel** | cookie de sessão `HttpOnly` + header `X-CSRF-Token` | `/api/*` |
| **integração** (script, site) | `Authorization: Bearer <AGENT_API_TOKEN>` | `/api/*` |

A comparação do bearer é em tempo constante (SHA-256 dos dois lados +
`timingSafeEqual`) — comparar com `===` permitiria descobrir o token caractere
a caractere medindo o tempo de resposta. Falha é sempre `401`
`{"ok":false,"error":"UNAUTHORIZED"}`, sem distinguir "faltou header" de "token
errado".

Requisição com cookie **e** método que muda estado (POST/PATCH/DELETE) exige o
CSRF. Requisição com bearer não exige: ela não vem de um navegador com cookie.

---

## Erros

Formato único. Programe contra `error`; `message` pode mudar sem aviso.

```json
{ "ok": false, "error": "CODIGO", "message": "texto em português para humano" }
```

| Código | HTTP | Significado |
|---|---|---|
| `UNAUTHORIZED` | 401 | token/sessão ausente ou inválido |
| `CSRF_INVALID` | 403 | cookie sem o header correspondente |
| `INVALID_BODY` / `INVALID_PARAMS` | 400 | fora do schema (traz `issues`) |
| `UNKNOWN_SERVER` | 404 | não existe servidor com esse id |
| `SERVER_ID_TAKEN` / `SERVER_CONFIG_EXISTS` | 409 | o id, ou o `.ini`, já existem |
| `PORT_BLOCK_TAKEN` / `NO_FREE_PORT_BLOCK` | 409 | portas em conflito ou grade cheia |
| `SERVER_NOT_INSTALLED` | 409 | não há `RustDedicated.exe` em disco |
| `SERVER_RUNNING` / `SERVER_ALREADY_RUNNING` | 409 | o processo está no ar |
| `SERVER_NOT_OPERATED` | 409 | o servidor existe, mas o agente não cuida dele |
| `OPERATION_IN_PROGRESS` | 409 | a trava do recurso está com outra operação |
| `OPERATION_NOT_ALLOWED` | 409 | aquela operação não vale nesse estado |
| `PORT_IN_USE` | 409 | a porta já está ocupada na máquina |
| `RCON_UNAVAILABLE` | 503 | sem conexão com aquele servidor de Rust |
| `RCON_TIMEOUT` | 504 | comando enviado, resposta não voltou |
| `INVALID_STEAM_ID` | 400 | não é um SteamID64 de 17 dígitos |
| `PLAYER_NOT_FOUND` | 404 | este agente nunca viu esse SteamID |
| `BAN_ALREADY_ACTIVE` | 409 | já há banimento ativo para aquele SteamID |
| `BAN_NOT_FOUND` | 404 | não há banimento ativo para revogar |
| `BAN_WITHOUT_SERVERS` | 400 | escopo `servers` sem dizer em quais |
| `BAN_ALREADY_EXPIRED` | 400 | a data de vencimento já passou |
| `PLUGIN_INVALID_RESPONSE` | 502 | o plugin respondeu fora do contrato |
| `OXIDE_GROUP_NOT_FOUND` | 404 | o Oxide não conhece aquele grupo |
| `OXIDE_PERMISSION_NOT_FOUND` | 404 | nenhum plugin registrou aquela permissão |
| `OXIDE_PLAYER_NOT_FOUND` | 404 | o Oxide nunca viu aquele jogador ali |
| `OXIDE_INVALID_NAME` / `OXIDE_INVALID_PARENT` | 400 | nome fora de formato, ou herança circular |
| `OXIDE_COMMAND_REFUSED` | 502 | o console respondeu com o uso do comando |
| `INTERNAL_ERROR` | 500 | inesperado (detalhes só no log) |

Os do **wipe** e das **mensagens** (Fase 6), no mesmo formato:

| Código | HTTP | Significado |
|---|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_TOO_LONG` | 400 | falta a `Idempotency-Key` no `POST /wipe/runs`, ou ela passa de 200 caracteres |
| `WIPE_IDENTITY_MISMATCH` | 400 | o `identity` digitado não é o daquele servidor |
| `WIPE_SCHEDULE_IN_THE_PAST` | 400 | wipe marcado — ou movido — para um instante que já passou |
| `WIPE_SCHEDULE_CONFLICT` | 409 | já existe outro wipe naquele mesmo instante |
| `WIPE_PLAN_NOT_FOUND` / `UNKNOWN_WIPE_PLAN` | 404 | não existe wipe marcado com aquele id |
| `WIPE_PLAN_NOT_EDITABLE` | 409 | ele já aconteceu, ou está acontecendo |
| `WIPE_FORCED_DATE_IS_FIXED` | 409 | a data do forçado é da Facepunch; só a política dele muda |
| `WIPE_FORCED_CANNOT_BE_SKIPPED` | 409 | o forçado acontece com ou sem o agente |
| `UNKNOWN_WIPE_RUN` | 404 | não existe execução de wipe com aquele id |
| `WIPE_ALREADY_RUNNING` / `WIPE_ALREADY_DONE` | 409 | não se retoma o que está em curso, nem o que terminou |
| `SERVER_NOT_MANAGED` | 409 | o servidor existe, mas está com `SERVER_ENABLED=0` |
| `NO_DISK_SPACE` | 409 | impedimento do `preview`, recusado **antes** do 202 |
| `MAP_NOT_FOUND` | 404 | aquela entrada não está na fila de mapas |
| `MAP_ALREADY_USED` / `MAP_ALREADY_QUEUED` | 409 | o mundo já foi jogado, ou já está na fila |
| `MAP_NOT_CUSTOM` | 409 | `versionOk` só existe em mapa custom |
| `INVALID_SEED` / `INVALID_WORLD_SIZE` / `MAP_URL_REQUIRED` | 400 | seed fora de formato, tamanho fora da faixa, custom sem `.map` |
| `DUPLICATED_ID` / `INCOMPLETE_ORDER` | 400 | o `reorder` não recebeu a fila **inteira** |
| `MAP_URL_INVALID` / `MAP_URL_NOT_A_MAP` / `MAP_URL_UNREACHABLE` / `MAP_URL_TOO_BIG` | 422 | o corpo está certo; o arquivo do outro lado é que não serve |
| `COULD_NOT_PICK_SEED` | 500 | o sorteio esgotou as tentativas |
| `MESSAGE_NOT_FOUND` | 404 | não existe mensagem com aquele id |
| `MESSAGE_NO_TARGET` | 409 | os alvos apontam para servidores que não existem mais |
| `MESSAGE_INVALID_SCHEDULE` / `MESSAGE_INVALID_TIMEZONE` | 422 | ritmo incoerente, ou fuso desconhecido neste runtime |
| `SERVER_NOT_FOUND` | 404 | id desconhecido em `targets` ou no `broadcast` |

---

## `GET /health` — sem autenticação

```json
{ "ok": true, "status": "ok", "version": "1.0.0",
  "startedAt": "2026-08-14T12:00:00.000Z", "uptimeSeconds": 3600,
  "servers": [
    { "id": "pvp1", "enabled": true,  "rcon": { "connected": true,  "state": "connected" } },
    { "id": "pve",  "enabled": false, "rcon": null }
  ] }
```

Responde **200 mesmo com RCON desconectado** (aí `status` vira `"degraded"`). O
processo do agente está saudável; o servidor de jogo é que pode estar
reiniciando. Devolver 503 aqui faria o PM2 reiniciar o agente durante um wipe.

---

## Sessão

| Rota | O que faz |
|---|---|
| `POST /auth/login` | `{user, password}` → cookie de sessão + `csrfToken` |
| `POST /auth/logout` | encerra |
| `GET /auth/session` | quem está logado, ou 401 |

Bloqueio progressivo por tentativa errada, e a resposta não diz se o usuário
existe.

---

## Servidores

### `GET /api/servers`

```json
{ "ok": true,
  "servers": [{
    "id": "pvp1", "name": "PVP 1", "identity": "pvp1",
    "enabled": true, "installed": true, "running": true,
    "hostname": "OrigemZ | PVP x5", "map": "Procedural Map",
    "worldSize": 4000, "seed": 1337, "maxPlayers": 200,
    "ports": { "game": 28015, "rcon": 28016, "query": 28017, "app": 28082 },
    "portBlock": 0,
    "rcon": { "connected": true, "state": "connected" },
    "players": { "online": 42, "max": 200, "at": "2026-08-14T18:20:00.000Z" },
    "build": { "installed": "24253458", "published": "24253458", "updateAvailable": false }
  }],
  "suggestedPortBlock": { "index": 1, "game": 28115, "rcon": 28116, "query": 28117, "app": 28182 } }
```

`suggestedPortBlock` existe para o formulário mostrar as portas **enquanto** a
pessoa digita o nome, antes de qualquer criação.

### `POST /api/servers`

```json
{ "id": "pvp2", "name": "PVP 2", "hostname": "OrigemZ | PVP 2",
  "map": "Procedural Map", "worldSize": 4000, "maxPlayers": 200,
  "rconPassword": "…", "seed": 1337, "identity": "pvp2", "portBlock": 1 }
```

Escreve `Configs\pvp2.ini` e a linha na tabela. **Não instala nada** e o
servidor nasce desligado. Corpo em modo estrito: campo desconhecido é `400`.

`rconPassword` não pode conter `/ \ ? #` nem espaço — a senha viaja no caminho
da URL do WebRCON (`ws://host:porta/SENHA`) e o Rust compara o caminho cru.

### `GET /api/servers/:id` · `PATCH /api/servers/:id` · `DELETE /api/servers/:id`

`PATCH {"enabled": true}` é o "operar este servidor": monta o contexto, sobe o
RCON e grava `SERVER_ENABLED=1` no `.ini`. Não reinicia o agente e não sobe o
jogo.

`PATCH` aceita ainda `name`, `hostname`, `map`, `worldSize`, `seed`,
`maxPlayers`, `description` — grava no `.ini` e avisa, na resposta, o que só
vale no próximo start (`"requiresRestart": ["map","worldSize"]`).

`DELETE` remove o cadastro e o `.ini`. **Não apaga `Servers\<id>\`** — dezenas
de GB não somem por um clique; a resposta diz onde a pasta ficou.

---

## Operações

| Rota | |
|---|---|
| `GET /api/servers/:id/operations` | histórico + `kinds` (o que aquele servidor aceita agora) |
| `POST /api/servers/:id/operations` | dispara. **202** |
| `GET /api/operations/:opId?fromLine=N` | log incremental |
| `POST /api/operations/:opId/cancel` | cancela o que for cancelável |

Corpo do POST:

```json
{ "kind": "server-install" }
{ "kind": "server-stop", "force": false }
{ "kind": "server-auto-update", "countdownMinutes": 15 }
```

`kinds` na resposta do GET é o que a tela usa para desenhar os botões — um
servidor sem jogo em disco devolve `["server-install"]`, e mais nada.

Resposta do log:

```json
{ "ok": true, "operation": {
    "id": "op_7f3a", "kind": "server-install", "serverId": "pvp1",
    "status": "running", "progress": 42.15,
    "startedAt": "2026-08-14T18:22:00.000Z", "finishedAt": null,
    "lines": [ { "n": 128, "at": "2026-08-14T18:24:11.007Z", "text": "…" } ],
    "nextLine": 129, "droppedLines": 0 } }
```

---

## Steam / builds

| Rota | |
|---|---|
| `GET /api/servers/:id/steam-update` | o último retrato (não consulta a Steam) |
| `POST /api/servers/:id/steam-update/check` | pergunta agora |

```json
{ "ok": true, "appId": "258550", "branch": "public",
  "installed": "24253458", "published": "24587531", "updateAvailable": true,
  "checkedAt": "2026-08-14T18:00:00.000Z", "lastError": null,
  "autoUpdate": true, "attemptsForThisBuild": 0 }
```

---

## Plugins

Dois lugares, e eles respondem perguntas diferentes:

```
  /api/plugins               a BIBLIOTECA do agente — um .cs, uma vez,
                             disponível para todo servidor

  /api/servers/:id/plugins   o acervo DAQUELE servidor: a biblioteca
                             mais os plugins custom dele, e o que
                             está ligado
```

**O upload existe nos dois, e significa coisas diferentes.** `POST /api/plugins`
entra para a biblioteca — qualquer servidor pode ligar. `POST
/api/servers/:id/plugins` entra como **custom** daquele servidor, e nenhum outro
o enxerga: é o `.cs` do evento de um fim de semana, o teste que não vai para os
demais. Mandá-lo para a biblioteca de todos seria poluir a tela de rede com o
experimento de um servidor.

**Copiar o arquivo na pasta também vale.** O agente varre `Plugins\` (biblioteca)
e `Plugins\<id>\` (customs) no boot e a cada abertura das telas de plugin: um
`.cs` que apareceu ali entra para o acervo sozinho, e um que foi editado tem a
versão relida. Quem tem trinta plugins num repositório os copia de uma vez —
clicar trinta vezes para dizer ao agente o que já está no disco dele é trabalho
inventado.

O caminho inverso não existe: arquivo **removido** da pasta não apaga a linha. A
remoção derrubaria junto, por cascata, o registro de quem ativou o quê, e um
`.cs` movido por engano custaria a configuração de vários servidores. Quem
remove é o `DELETE`, com confirmação.

### A biblioteca

| Rota | |
|---|---|
| `GET /api/plugins` | a biblioteca, com versão, autor e em que servidores cada um está ativo |
| `POST /api/plugins` | envia um `.cs` (multipart, campo `file`) |
| `DELETE /api/plugins/:pluginId?force=1` | tira do acervo e de todos os servidores |

`:pluginId` é **número**. O nome não serve como chave: a biblioteca pode ter um
`Kits` e o `pvp1` ter outro, custom, com conteúdo diferente — uma rota por nome
seria ambígua justamente no caso que o custom existe para permitir.

```json
{ "ok": true, "plugins": [
  { "id": 7, "name": "OrigemZPlayer", "file": "OrigemZPlayer.cs",
    "serverId": null,
    "title": "Origem Z Player", "author": "OrigemZ", "version": "1.2.3",
    "description": "Expõe posição e estado dos jogadores",
    "bytes": 18432, "sha256": "a1b2c3…",
    "addedAt": "2026-08-14T18:00:00.000Z",
    "updatedAt": "2026-08-14T18:00:00.000Z",
    "servers": ["pvp1", "pvp2"] }
] }
```

`serverId` é `null` na biblioteca e traz o id do dono num custom. O `GET
/api/plugins` **só lista a biblioteca**: os customs aparecem no acervo do
servidor deles.

`title`, `author`, `version` e `description` saem do `[Info(...)]` e do
`[Description(...)]` do próprio arquivo, por regex. São **anuláveis**: plugin de
uso interno costuma não declarar, e inventar um metadado é pior que não ter —
ninguém confere o que parece certo.

**Enviar não é aplicar.** O `POST` deixa a biblioteca em dia e não mexe em
servidor nenhum; `pendingServers` diz quem ficou na versão anterior:

```json
{ "ok": true, "plugin": { "…": "…" }, "pendingServers": ["pvp1"],
  "message": "Plugin gravado na biblioteca. pvp1 ainda está na versão anterior…" }
```

O `DELETE` **sem** `force` com servidores usando responde `409 PLUGIN_IN_USE` —
e a mensagem diz **quais**. É essa frase que a confirmação da tela mostra: "2
servidores" obrigaria a ir procurar quem são.

### O acervo daquele servidor

| Rota | |
|---|---|
| `GET /api/servers/:id/plugins` | a biblioteca + os customs dele, com `enabled`, `updateAvailable` e `blockedBy` |
| `POST /api/servers/:id/plugins` | envia um `.cs` **custom** deste servidor (multipart, campo `file`) |
| `PUT /api/servers/:id/plugins/:pluginId` | `{ "enabled": true \| false }` — liga, desliga e aplica |
| `POST /api/servers/:id/plugins/:pluginId/reload` | só recarrega, sem recopiar |

O `GET` **adota**: um `.cs` que alguém copiou à mão para `oxide\plugins` entra
para o acervo e nasce com `enabled: true`. Vira **custom daquele servidor** — um
arquivo solto na pasta de um servidor é dele até prova em contrário, e mandá-lo
para a biblioteca de todos seria decidir por quem não pediu. A exceção é o nome
já existir no acervo: aí a linha se liga ao que existe, sem duplicar. Nada é
apagado — aquele plugin foi decisão de alguém, e o agente é que acabou de
chegar.

```json
{ "ok": true, "pluginsDir": "F:\\…\\Servers\\pvp1\\oxide\\plugins",
  "plugins": [
    { "id": 7, "name": "OrigemZPlayer", "serverId": null, "version": "1.2.3",
      "enabled": true, "appliedSha": "9f8e7d…",
      "appliedAt": "2026-08-14T18:05:00.000Z",
      "updateAvailable": true, "blockedBy": null, "…": "…" },
    { "id": 12, "name": "MeuEvento", "serverId": "pvp1", "version": "0.1.0",
      "enabled": false, "appliedSha": null, "appliedAt": null,
      "updateAvailable": false, "blockedBy": null, "…": "…" }
  ] }
```

A lista traz ligados e desligados: quem separa "disponíveis" de "ativos" é a
tela, pelo `enabled`. Sem os desligados não haveria como ligar nada.

`updateAvailable` é `appliedSha ≠ sha256`: o que está em disco naquele servidor
difere do que o acervo tem. Desligado nunca é `true` — não há arquivo lá para
estar velho.

`blockedBy` (`"biblioteca"`, `"custom"` ou `null`) é o **homônimo já ligado**
ali. A biblioteca pode ter um `Kits` e o servidor um `Kits` custom; os dois
gravam `Kits.cs` no mesmo caminho e o Oxide carrega um só, então ligar o segundo
responde `409 PLUGIN_NAME_TAKEN` dizendo de onde vem o que está no caminho. A
tela usa o campo para desabilitar o botão *antes* do clique.

Ligar um custom de OUTRO servidor responde `403 PLUGIN_NOT_AVAILABLE`.

### As dependências entre plugins

O agente lê do próprio `.cs` de quem cada plugin depende, e devolve em dois
campos porque são dois mecanismos com consequências diferentes:

| No arquivo | Campo | O que acontece sem a dependência |
|---|---|---|
| `// Requires: X` | `requires` | o Oxide **não carrega** o plugin |
| `[PluginReference] private Plugin X;` | `references` | carrega e roda, com a parte que usava o `X` morta |

O `// Requires:` não é comentário nosso: é diretiva do próprio Oxide, lida por
ele para adiar o carregamento. Três dos plugins `OrigemZ*` começam com
`// Requires: OrigemZAgent`.

Disso saem os dois campos por servidor:

- **`missingRequires`** — dependências duras que não estão ligadas ali. Ligar
  assim mesmo é **permitido** (o Oxide segura o plugin até elas aparecerem), e a
  resposta do `PUT` avisa. O que não pode é a tela dizer "ativo" e nada
  acontecer no jogo, sem explicação.
- **`dependents`** — `{ hard, soft }`: quem **depende deste** e está ligado ali.

Desligar um plugin com dependentes responde **`409 PLUGIN_HAS_DEPENDENTS`**
dizendo quem cai junto e quem fica degradado. Para confirmar, repita com
`?force=1`. A recusa é o padrão porque o estrago acontece longe: quem tira o
`OrigemZAgent` vê "plugin removido" e mais nada, enquanto os outros três somem
do ar — e o sintoma aparece no jogo, sem nada ligando uma coisa à outra.

`PUT { "enabled": true }` num plugin **já ligado** é como se aplica a
atualização: recopia do acervo e recarrega. Uma rota separada para isso seria um
segundo caminho para copiar-e-recarregar, e os dois divergiriam no primeiro
ajuste.

`PUT { "enabled": false }` descarrega, apaga o `.cs` daquele servidor e
**preserva** `oxide\config\<Nome>.json` e `oxide\data\`. Desligar para testar e
voltar atrás não pode custar a configuração do plugin.

A resposta traz o que o Oxide disse:

```json
{ "ok": true, "plugin": { "…": "…" },
  "reload": { "sent": true, "output": "Loaded plugin OrigemZPlayer v1.2.3" },
  "message": "OrigemZPlayer aplicado e recarregado…" }
```

Se o Oxide recusou compilar, `ok` continua `true` (o arquivo **foi** gravado) e
`reload.output` traz o erro de compilação. São coisas diferentes, e misturá-las
faria o operador achar que a ação falhou. Com o servidor parado, `sent` é
`false` e o plugin carrega no próximo start — o que também não é erro.

### `POST /api/servers/:id/plugins/:pluginId/enable-with-deps`

Liga o plugin **e** as dependências duras que faltam, na ordem topológica —
dependência primeiro.

Uma rota, e não a tela chamando o `PUT` várias vezes: a ordem é regra, e no
navegador ela não teria teste. E a ordem não é detalhe — o Oxide segura um
plugin cujo `// Requires:` não está carregado e o solta sozinho quando a
dependência aparece, então ligar na ordem errada "funciona" com um intervalo em
que o servidor está com metade do conjunto no ar.

```json
{ "ok": true, "plugin": { "…": "…" },
  "enabled": ["OrigemZAgent", "OrigemZVip"],
  "alreadyEnabled": ["OrigemZUI"],
  "reloads": [{ "plugin": "OrigemZAgent", "sent": true, "output": "Loaded plugin…" }],
  "message": "Ligados nesta ordem: OrigemZAgent → OrigemZVip…" }
```

Duas recusas, ambas `409`:

- **`PLUGIN_DEPENDENCY_CYCLE`** — dois plugins que se declaram um ao outro. A
  mensagem diz quem está no círculo (`A → B → A`), porque nenhuma ordem de
  carregamento resolve: o `// Requires:` de um deles está errado e o `.cs`
  precisa ser corrigido.
- **`PLUGIN_DEPENDENCY_MISSING`** — a dependência não está na biblioteca nem nos
  customs daquele servidor. Ligar o que não existe não é uma opção a oferecer.

Só as dependências **duras** entram. O `[PluginReference]` é mole — o plugin
carrega e roda sem ela —, e arrastar junto o que o `.cs` apenas menciona ligaria
coisa que ninguém pediu.

### `POST /api/servers/:id/plugins/copy-from`

Corpo: `{ "from": "server01" }`. Liga aqui o mesmo conjunto que aquele servidor
usa, cada um com as dependências na ordem certa.

**O conjunto é um servidor que já funciona.** Cadastrar "conjuntos" no banco
seria uma segunda fonte para o mesmo fato: no dia em que o servidor de verdade
ganhasse o sétimo plugin, a lista salva continuaria com seis, e o servidor novo
nasceria faltando um.

```json
{ "ok": true, "from": "server01",
  "enabled": ["OrigemZAgent", "OrigemZVip"],
  "alreadyEnabled": ["OrigemZUI"],
  "skipped": [{ "plugin": "MeuEvento",
                "reason": "\"MeuEvento\" é custom de \"server01\" e não existe no acervo deste servidor…" }],
  "message": "Ligados aqui: … 1 não vieram…" }
```

O `skipped` é a parte que importa: sem ele, o servidor novo nasce faltando
plugin e ninguém fica sabendo. Um plugin que falha **não segura os outros** —
abortar no meio deixaria metade do conjunto ligada e nenhuma lista do que
faltou.

A **configuração não vem junto**: ela é daquele servidor. Copiar `oxide\config`
levaria o preço do VIP e a mensagem de boas-vindas de um servidor para o outro.

Copiar de si mesmo responde `400 INVALID_COPY_SOURCE`.

### O plugin que não compila

Cada plugin ligado traz o desfecho do último `oxide.reload` dele **naquele
servidor**:

```json
"lastReload": { "at": "2026-08-14T20:31:00.000Z", "failed": true,
                "output": "Error while compiling: OrigemZVip.cs(214,13): error CS0103…" }
```

`failed` é o agente lendo a resposta do Oxide — que não devolve código de erro,
devolve prosa (`error CS0103` é o compilador da Microsoft; o resto são frases do
loader). O que ele não reconhece vira `false` de propósito: um alarme falso na
linha faria ninguém acreditar no verdadeiro.

O campo é `null` para plugin desligado e para quem não foi recarregado desde que
o agente subiu. O dado mora **em memória** e morre com o processo: ele afirma "o
Oxide respondeu isto agora há pouco", e guardá-lo entre reinícios faria a tela
mostrar, dias depois, o erro de um arquivo já corrigido.

É o que permite a tela dizer **"está no servidor, mas não está rodando"** na
linha do plugin. Antes, isso só existia dentro do `reload.output` da resposta de
quem clicou — e quem não clicou nunca via.

### A configuração de cada plugin

`oxide\config\<Nome>.json`, o arquivo que o **plugin** cria no primeiro
carregamento com os padrões dele. Quatro rotas:

```
GET    /api/servers/:id/plugin-configs            o que há na pasta
GET    /api/servers/:id/plugin-configs/:plugin    o JSON de hoje
PUT    /api/servers/:id/plugin-configs/:plugin    grava e recarrega
DELETE /api/servers/:id/plugin-configs/:plugin    apaga: o plugin recria
```

**A chave é o NOME, e não o `:pluginId`** — contra a regra do resto desta seção,
e de propósito. A config mora do lado do jogo e sobrevive ao plugin: desligar
não a apaga, remover do acervo não a apaga. Uma rota por id não conseguiria
abrir a config do plugin que saiu do acervo, que é justamente a que alguém vai
procurar para recuperar horas de ajuste.

Pela mesma razão, **a lista vem da pasta**, e não do banco:

```json
{ "ok": true, "configDir": "F:\\…\\Servers\\server01\\oxide\\config",
  "configs": [{ "plugin": "OrigemZVip", "file": "OrigemZVip.json",
                "bytes": 503, "modifiedAt": "2026-08-14T…",
                "title": "Origem Z Vip", "inStore": true, "enabled": true }] }
```

`inStore: false` é a config **órfã** — o `.json` de um plugin que saiu. Ela
aparece de propósito.

O `PUT` recebe `{ "text": "…" }` e faz, nesta ordem:

1. **confere o JSON** — o que não passa responde `400 INVALID_PLUGIN_CONFIG` com
   a posição do erro, e o arquivo em disco não muda. O Oxide não carrega um
   plugin com a config quebrada, e o erro dele sairia no console do jogo, longe
   de quem clicou;
2. **copia** o que estava lá para `Backups\<id>\oxide-config\<Nome>-<epoch>.json`
   — falhar aqui interrompe a escrita (`500 PLUGIN_CONFIG_BACKUP_FAILED`);
3. grava;
4. **recarrega, se o plugin estiver ligado ali**. De um plugin que aquele
   servidor não usa, o `oxide.reload` só encheria o console com um erro que não
   é erro;
5. **relê do disco.**

O passo 5 não é zelo: vários plugins chamam `SaveConfig()` ao carregar e
reescrevem a própria config normalizando o que leram. O `config` da resposta é o
que ficou em disco **depois** do reload — devolver o texto enviado faria a tela
afirmar uma coisa que o arquivo não diz mais.

O `DELETE` é o "voltar ao padrão": copia, apaga, recarrega. Com o plugin
carregado, ele recria o arquivo na hora; desligado, `config` volta `null` e o
arquivo nasce quando alguém o ligar.

O nome passa por `pluginConfigPath`, irmão do `pluginPath` — sem ele, um
`..\..\..\Configs\server01.ini` reescreveria o arquivo que decide em que porta o
servidor sobe (`400 INVALID_PLUGIN_NAME`). O teto do texto é 256 KB, abaixo do
`bodyLimit` de 1 MB do Fastify, para que a recusa seja a nossa, em português, e
não um 413 em inglês.

---

## Administração

A aba **Administração** de um servidor. Três famílias de rota, e uma ausência
deliberada: os **atalhos de comando** não têm rota própria — eles reaproveitam o
`POST /api/servers/:id/rcon`, adiante. Inventar vinte endpoints para o que o
canivete já faz seria vinte lugares para manter em dia.

Todas exigem que o agente esteja **cuidando** daquele servidor: sem `ServerContext`
não há RCON, e a resposta é `409 SERVER_NOT_OPERATED` — diferente de `404
UNKNOWN_SERVER`, que é id que não existe. São recusas com causas diferentes, e o
que resolve cada uma é outra coisa.

### Quem está online

| Rota | |
|---|---|
| `GET /api/servers/:id/players` | a lista, com a fonte declarada |
| `POST /api/servers/:id/players/:steamId/kick` | `{ "reason": "…" }` (opcional) |

**A fonte não é escolha de quem chama.** Com o `OrigemZAgent` ligado naquele
servidor, o agente usa `origemz.players`, que dá posição, vida, ping, tempo de
conexão e se o jogador está vivo ou dormindo. Sem ele, cai para o `playerlist`
nativo — que não tem posição nem estado. A resposta diz qual foi usada:

```json
{ "ok": true, "source": "plugin", "total": 42,
  "plugin": { "name": "OrigemZAgent", "id": 7, "enabled": true },
  "missing": [],
  "world": { "size": 4000, "cellSize": 146.3, "cols": 28, "rows": 28 },
  "players": [
    { "steamId": "76561198000000000", "name": "Fulano",
      "health": 87.5, "isAlive": true, "isSleeping": false,
      "ping": 42, "connectedSeconds": 900,
      "position": { "x": 120.5, "y": 32.1, "z": -840.2 },
      "grid": "I3" } ]
}
```

**`grid` é calculado pelo agente**, e não pela tela: a constante da grade
(`146.3` unidades por célula, a mesma que o jogo usa para desenhar o mapa) tem um
dono só. `G12` é como jogador e admin falam de posição — `(120.5, -840.2)` obriga
a traduzir. `null` sem posição, ou seja, sempre que a fonte for o `playerlist`.

**`world`** acompanha porque é o que o Map View precisa para desenhar: a projeção
depende do `size`, e as letras/números das células do `cellSize`. Note que
`cellSize` **não** deriva do `size` — mundos de 3000 e 6000 têm células iguais e
quantidades diferentes delas, que é por que a última coluna do mapa do jogo é
sempre mais estreita.

A falta anda nos dois sentidos: o `playerlist` traz o **endereço** do jogador, e
o plugin não — daí o `ip` na linha, e o `missing: ["ip"]` com a fonte do plugin.
É de lá que sai o último IP da ficha do jogador.

Com `"source": "nativo"`, `position`, `isAlive` e `isSleeping` vêm **`null`** e
`missing` os enumera. Nunca `0` nem `false`: um "morto" inventado é pior que um
campo vazio. `plugin.id` é o que a tela usa para oferecer **ligar** o plugin sem
sair da aba; `null` significa que ele nem está no acervo daquele servidor.

**Resposta fora do contrato o agente recusa.** O plugin promete um JSON de uma
linha; vindo outra coisa é `502 PLUGIN_INVALID_RESPONSE`, e não um `catch`
silencioso que devolve lista vazia. "Zero jogadores" e "não consegui perguntar"
são respostas diferentes, e a segunda não pode se disfarçar da primeira.

O `kick` age sobre quem está **conectado** — expulsar é tirar da partida agora,
não impedir de voltar. Para impedir, o caminho é a BanList.

### A imagem do mapa

| Rota | |
|---|---|
| `GET /api/servers/:id/map` | o que existe em disco. **Não renderiza** |
| `GET /api/servers/:id/map/image` | o PNG |
| `POST /api/servers/:id/map/render` | força o desenho |

**A imagem não vem de fora.** O caminho óbvio seria o RustMaps — chave de API,
seed, e uma dependência externa no meio de uma tela que precisa funcionar num
dedicado sem internet liberada. O servidor sabe fazer isso sozinho:
`world.rendermap` é um comando do próprio Rust que grava um PNG de alta resolução
ao lado da instalação, em `Servers\<id>\map_<worldSize>_<seed>.png`.

**Ela é desenhada uma vez por mundo, e o agente cuida disso.** O render acontece
quando o RCON conecta e não há imagem para aquele mundo — o que dá exatamente o
ciclo certo:

| | |
|---|---|
| primeira subida do mapa novo | desenha (e é o melhor momento: servidor recém-subido, ninguém dentro para sentir o engasgo) |
| toda subida seguinte | o arquivo existe, não faz nada |
| wipe | a seed muda, o **nome** muda, o arquivo não existe, e o desenho refaz sozinho |

Não há cache para invalidar nem imagem de outro mapa aparecendo por engano: quem
responde "esta imagem é deste mundo?" é o nome do arquivo.

MEDIDO neste servidor: ~17,5 MB de PNG, e o comando passa dos cinco segundos do
timeout de RCON. Por isso o `POST` responde assim que o comando **sai** — esperar
pelo fim transformaria um desenho que aconteceu num erro na tela. Quem chamou
descobre que terminou pelo `GET /map` passando a dizer `available: true`.

O `POST` existe para o que o automático não cobre: a imagem apagada com o
servidor já no ar, a que saiu corrompida, o mapa customizado que mudou sem mudar
a seed.

```json
{ "ok": true, "available": true,
  "path": "F:\\…\\Servers\\server01\\map_4000_12345.png",
  "bytes": 18370560, "generatedAt": "2026-08-14T21:13:16.322Z",
  "worldSize": 4000, "seed": 12345,
  "url": "/api/servers/server01/map/image" }
```

`url` é o caminho **da rota**, e não o do disco: o painel roda no navegador e não
alcança `F:\…`. Servir o arquivo pelo agente é também o que evita expor uma pasta
inteira da instalação — e o caminho nunca vem da requisição, é montado a partir
do `.ini` daquele servidor.

O PNG sai com `Cache-Control: private, max-age=86400, immutable`. Ele pode: o
nome do arquivo carrega tamanho e seed, então a imagem de um mundo nunca muda, e
o wipe troca a URL.

### Chat

| Rota | |
|---|---|
| `GET /api/servers/:id/chat?limit=100` | as últimas mensagens |
| `POST /api/servers/:id/chat` | `{ "message": "…" }` — sai como `say` |

**A fonte é o histórico do JOGO (`chat.tail`), e não um buffer do agente.** A
primeira versão disto guardava as linhas de chat que passavam pelo evento de log
do RCON, e ficou **vazia** no primeiro servidor de verdade — pelo motivo que
torna a lição útil:

um plugin de chat (`OrigemZChat`, portado do BetterChat) **cancela** a mensagem
original no `OnPlayerChat` para reenviá-la formatada, com tag e cor. Cancelada a
original, o servidor deixa de emitir o frame `Type: "Chat"` do WebRCON. O que
sobra no console é um `Puts` do plugin, cujo texto **o dono do servidor
configura** — decorá-lo seria quebrar no dia em que alguém editasse o config.

O `chat.tail` é alimentado nos dois caminhos: o do jogo e o `Chat.Record` que um
plugin bem-comportado chama justamente para não sumir das ferramentas de admin.
E ele traz o que um buffer não traz: o histórico **sobrevive ao reinício do
agente**.

```json
{ "ok": true, "connected": true,
  "lines": [ { "at": "2026-08-14T18:24:11.007Z",
               "steamId": "76561198000000000", "name": "Fulano",
               "tag": "[VIP OURO]", "color": "#ffd700",
               "text": "alguem viu o helicoptero?", "channel": "global" } ] }
```

**Sem cursor, de propósito:** a resposta é uma *janela* das últimas `limit`
mensagens, substituída inteira a cada leitura. Um cursor incremental pressuporia
que o agente é dono do histórico — e o dono é o jogo, que guarda o que foi dito
antes de o agente subir.

**`tag` e `color` vêm de dentro da mensagem.** Com um plugin de chat no caminho,
o campo `Message` do histórico vem RENDERIZADO no formato que o dono configurou
(`{Title} {Username}: {Message}`), ou seja `"[VIP OURO] Fulano: oi"`. O agente
corta no `<nome>:`: o que vem antes é a tag, o que vem depois é o texto. Sem esse
corte a tela escreveria "Fulano: [VIP OURO] Fulano: oi", já que o nome tem coluna
própria. Num servidor sem plugin de chat, `tag` é `null` e o texto vai inteiro.

`color` é conferido contra `#hex` ou um nome de cor antes de sair — ele vem do
config de um plugin e vai para o `style` da tela, e sem a trava seria um caminho
para injetar CSS.

`channel` é `global`, `equipe`, `servidor`, `cartas` ou `local`. A distinção
importa: uma mensagem de equipe lida como global faz quem administra achar que o
combinado foi dito para todo mundo.

`steamId` é `null` nas mensagens do próprio servidor (o `say`, o aviso de
atualização) — o histórico traz `"0"` ali, e devolvê-lo faria a tela oferecer
banir uma conta que não existe.

No `POST`, aspas e `<color>` são **removidos**: o `say` do Rust quebra com aspas
no meio, e o rich text deixaria qualquer texto se passar por mensagem de admin. A
mensagem enviada **não** é guardada deste lado: o próprio jogo a registra no
histórico, e é de lá que a leitura seguinte a traz.

### Admins

| Rota | |
|---|---|
| `GET /api/servers/:id/admins` | lê o `users.cfg` |
| `POST /api/servers/:id/admins` | `{ "steamId", "name"?, "level": "owner" \| "moderator" }` |
| `DELETE /api/servers/:id/admins/:steamId?level=owner` | rebaixa |

**O arquivo é lido, e nunca escrito.** `Servers\<id>\server\<identity>\cfg\users.cfg`
é reescrito **inteiro** pelo jogo a cada `server.writecfg`, a partir do que ele
tem em memória — editá-lo com o servidor no ar perde a mudança em silêncio. Quem
muda o estado é o comando pelo RCON (`ownerid`, `moderatorid`, `removeowner`,
`removemoderator`), e é o que o `POST` e o `DELETE` fazem, com um
`server.writecfg` em seguida.

Arquivo ausente **não é erro**: é o estado de um servidor que nunca subiu, e a
resposta traz `"source": "ausente"` com uma frase dizendo isso.

O `level` no `DELETE` **não é opcional**: `removeowner` não tira um moderador, e
mandar o comando errado não dá erro — não faz nada. Sem ele a resposta é
`400 INVALID_PARAMS`.

---

## Banimentos

Duas famílias, porque são dois assuntos:

```
  /api/bans                a lista do AGENTE — a fonte
  /api/servers/:id/bans    o que vale NAQUELE servidor, e de onde veio
```

O Rust não tem banlist remota: existe o `bans.cfg` de cada servidor, e nada os
liga. Aqui o banimento é **estado do agente**, e cada `bans.cfg` é espelho.

**`steamId` é string em toda a API** — no parâmetro de rota, no corpo, no zod e
na resposta. Um SteamID64 tem 17 dígitos e passa de 2^53: em número ele volta
arredondado, e o banimento iria para a **conta errada**, sem erro nenhum no
caminho.

### A lista global

| Rota | |
|---|---|
| `GET /api/bans?active=1&q=<busca>` | a lista, com os ids dos servidores |
| `POST /api/bans` | bane. **201** |
| `DELETE /api/bans/:steamId` | **revoga** — não apaga a linha |

```json
{ "steamId": "76561198000000000", "name": "Fulano", "reason": "uso de cheat",
  "scope": "network", "expiresAt": "2026-08-21T18:00:00.000Z" }
```

`scope` tem dois valores, e a diferença só aparece meses depois:

| | Vale em | Enumera |
|---|---|---|
| `network` | **todo** servidor, inclusive nos que ainda vão ser criados | ninguém |
| `servers` | só nos listados em `servers[]` | esses |

**Por que `network` não é uma lista com todos os servidores.** A lista seria a de
hoje. No dia em que o `pvp3` for cadastrado, todo ban de rede feito antes dele
deixaria de valer lá — em silêncio, e a descoberta seria o banido jogando. Um
`scope: "servers"` sem `servers[]` responde `400 BAN_WITHOUT_SERVERS`.

`expiresAt` é ISO-8601, e `null` (ou ausente) é permanente. **O prazo é nosso**:
o ban do Rust não tem vencimento, e quem solta na data é um relógio do agente
(intervalo de 1 min, `unref()` no timer, uma rodada por vez). Uma data que já
passou responde `400 BAN_ALREADY_EXPIRED` — um ban que nasce vencido sumiria
sozinho na rodada seguinte.

**Um banimento ativo por SteamID.** O segundo responde `409 BAN_ALREADY_ACTIVE`
dizendo desde quando e por quê o primeiro vale: dois ativos não teriam resposta
para "qual motivo vale?" nem para "revogar fecha qual?".

**Gravado não é o mesmo que aplicado.** A linha existe a partir do `POST`; o
`banid` só chega aos servidores que estão no ar. A resposta separa os dois, e a
`message` diz que o resto entra na reconciliação do próximo start:

```json
{ "ok": true, "ban": { "…": "…" },
  "applied": ["pvp1"], "pending": ["pve"],
  "message": "Banimento gravado e aplicado em pvp1. pve não estava no ar…" }
```

**`DELETE` revoga, não apaga.** A linha fica com `revokedAt` e `revokedBy` — é o
que responde à segunda discussão sobre o mesmo jogador. `active=1` no `GET`
filtra por "não revogado", e **não** por "não vencido": um ban que passou da data
continua valendo no jogo até o relógio passar por ele, e escondê-lo faria a tela
dizer que o jogador está solto enquanto o `bans.cfg` ainda o segura. O campo
`expired` existe para a tela poder dizer "vencido, saindo".

### O que vale naquele servidor

| Rota | |
|---|---|
| `GET /api/servers/:id/bans` | com a origem de cada linha, e o estado do RCON |
| `POST /api/servers/:id/bans/sync` | reconcilia agora |

`source` diz de onde a linha vem, do ponto de vista daquele servidor:

| | |
|---|---|
| `rede` | vale em todos, inclusive nos que ainda vão nascer |
| `especifico` | alguém o aplicou a este servidor |
| `adotado` | estava no `bans.cfg` daqui quando o agente chegou |

### A reconciliação

Ela acontece sozinha em **três momentos** — quando o agente sobe, quando um
servidor é ligado e quando o RCON reconecta. Os três têm a mesma causa: é quando
o agente volta a alcançar o servidor, e portanto quando os dois lados podem ter
divergido sem ninguém ver. O `POST .../sync` só antecipa isso.

| Situação | O que o agente faz |
|---|---|
| na tabela, não no servidor | `banid <steamid> "<nome>" "<motivo>"` |
| no servidor, não na tabela | **adota** (`origin: "adopted"`) — nunca apaga |
| ativo em outro servidor, e presente aqui | estende o alcance para cá |
| revogado (ou vencido) na tabela, ainda no servidor | `unban` |

Depois do lote, **`server.writecfg`**: sem ele o `bans.cfg` só é gravado quando o
servidor decidir, e um crash perde tudo.

É **`banid`, nunca `ban`** — o `ban` só age sobre quem está conectado, e a
maioria dos banimentos por sincronização é de gente offline.

**Ela nunca age sobre um palpite.** Não conseguir ler o `banlist` (RCON fora,
resposta em formato desconhecido) **adia** a rodada, e a resposta diz por quê em
`skipped`. Supor lista vazia ali faria o agente reaplicar tudo a cada rodada:

```json
{ "ok": true, "serverId": "pvp1",
  "applied": ["76561198000000000"], "removed": [], "adopted": [], "extended": [],
  "skipped": null,
  "message": "1 banimento(s) aplicado(s)." }
```

---

## Oxide: grupos e permissões

```
  GET    /api/servers/:id/oxide              o framework em si
  GET    /api/servers/:id/oxide/permissions  grupos e permissões
  POST   /api/servers/:id/oxide/groups                   cria
  PATCH  /api/servers/:id/oxide/groups/:group            título, rank, pai
  DELETE /api/servers/:id/oxide/groups/:group            apaga
  POST   /api/servers/:id/oxide/groups/:group/permissions        concede
  DELETE /api/servers/:id/oxide/groups/:group/permissions/:perm  revoga
  POST   /api/servers/:id/oxide/groups/:group/members            põe alguém
  DELETE /api/servers/:id/oxide/groups/:group/members/:steamId   tira
```

**Grupo é o que dá poder no Rust modado.** Um VIP é um jogador dentro de
`origemz.vip.gold`, que herda de `silver`, que herda de `bronze` — hierarquia que
o `OrigemZVip` cria sozinho ao carregar, a partir do config dele. O que não
existia era como ver quem está dentro dela e o que cada nível concede sem
digitar `oxide.show` no Console e ler prosa em inglês.

**O arquivo não é editado, nunca.** O estado mora em `oxide\data\*.data`,
protobuf que o próprio Oxide reescreve — mesma regra do `users.cfg`: quem muda é
o comando pelo RCON, e o agente manda `oxide.save` depois de cada mudança.

```json
{ "ok": true, "connected": true, "truncated": 0,
  "groups": [
    { "name": "origemz.vip.gold",
      "members": [ { "steamId": "76561198123456789", "name": "Fulano" } ],
      "permissions": ["loja.desconto"],
      "parents": ["origemz.vip.silver", "origemz.vip.bronze"],
      "inherited": [ { "group": "origemz.vip.silver", "permissions": ["fila.prioridade"] } ] } ],
  "permissions": ["oxide.plugins", "origemzchat.admin"] }
```

`parents` sai das seções `Parent group '…'` que o `oxide.show group` imprime: o
console não anuncia o pai, ele lista as permissões dele. É a única forma de ver
a herança sem abrir o protobuf.

**Ler responde 200 mesmo com o servidor parado** (`connected: false` e uma
frase); **agir exige o RCON de pé** (`503`). Não existe enfileirar concessão de
permissão: uma que "vai acontecer depois" é uma que ninguém confere.

**A permissão precisa existir antes.** Quem as registra é o plugin, ao carregar
— o `oxide.grant` recusa o que ninguém registrou, e por isso a tela oferece uma
lista em vez de um campo de texto.

**O console não devolve título nem rank**: ele só os aceita. O `PATCH` grava os
dois, e a tela avisa que os campos começam vazios por isso.

`GET /oxide` traz a versão, os plugins **carregados** (`oxide.plugins` — o que o
Oxide compilou de verdade, que é diferente do acervo do agente) e o
`oxide.config.json` do framework, em leitura: ele é lido no START do servidor, e
gravá-lo com o jogo no ar não teria efeito até o próximo boot.

Não há rota para conceder permissão **direto a um jogador**. Ela existe no Oxide
e é o que faz um servidor virar uma colcha de retalhos que ninguém audita — quem
dá poder é o grupo. As permissões soltas de alguém continuam visíveis na
leitura, para que dê para descobrir que existem.

---

## Jogadores

```
  /api/servers/:id/players   quem está CONECTADO agora (acima, em Administração)
  /api/players               quem já JOGOU na rede — a base do agente
```

As duas precisam existir, e confundi-las é o erro caro: a primeira é estado do
servidor, lido do RCON a cada chamada e inexistente com o jogo fora do ar; a
segunda é do agente, mora no SQLite e sobrevive ao wipe e ao reinício. Um
`/api/players` que devolvesse conectados esvaziaria sozinho de madrugada — e não
haveria onde responder "quem é este SteamID que foi banido em março?".

**`steamId` é string em toda a API**, pela mesma razão dos banimentos: 17
dígitos passam de 2^53, e em número a ficha volta a ser de outra pessoa.

| Rota | |
|---|---|
| `GET /api/players?q=&online=1&limit=&offset=` | a lista, **paginada** |
| `GET /api/players/:steamId` | a ficha |
| `GET /api/players/:steamId/servers` | onde ele joga, e desde quando |
| `GET /api/players/:steamId/events?limit=` | o histórico dele |

**A listagem é paginada desde a primeira versão.** Uma rede com meses de vida
tem dezenas de milhares de jogadores, e uma rota que devolve tudo é a que um dia
derruba o agente. `total` vem junto — sem ele a tela não sabe se há página
seguinte; `count` é o que veio nesta página. O teto de `limit` é 200.

```json
{ "ok": true, "count": 1, "total": 12480, "limit": 50, "offset": 0,
  "players": [
    { "steamId": "76561198123456789", "name": "Fulano",
      "firstSeen": "2026-05-10T20:00:00.000Z",
      "lastSeen": "2026-08-14T23:37:05.553Z",
      "online": true, "onlineOn": ["pvp1"], "lastServerId": "pvp1",
      "banned": false } ] }
```

A ficha **junta** o que já existe em vez de duplicar:

```json
{ "ok": true,
  "player": { "steamId": "76561198123456789", "name": "Fulano",
              "firstSeen": "…", "lastSeen": "…", "lastIp": null,
              "online": true, "known": true },
  "ban": { "…": "o ban ATIVO, vindo da BanList. null se não há" },
  "servers": [ { "serverId": "pvp1", "firstSeen": "…", "lastSeen": "…",
                 "online": true, "joinedAt": "…", "leftAt": null,
                 "leaveReason": null, "sessions": 42,
                 "playedSeconds": 187200 } ] }
```

O `ban` sai da tabela `bans`, e **não** de uma coluna em `players`: duas fontes
para "ele está banido?" divergem no primeiro ajuste, e a que divergiria é a
cópia.

`known: false` é a ficha de quem o agente **nunca viu jogar** — o ban por
SteamID de alguém offline, ou o adotado de um `bans.cfg`. Ela responde `200` com
as datas nulas, porque é justamente a ficha que se procura depois de banir um id
que nunca entrou. O `404 PLAYER_NOT_FOUND` fica reservado para o que ele
significa: este SteamID nunca passou por este agente, em canto nenhum.

`lastIp` é anulável de propósito: quem traz endereço é o `playerlist` nativo, e
o `origemz.players` não — um IP inventado é pior que um campo vazio.

### A presença: como o agente sabe quem está online

Por **varredura**, e não por linha de log: a cada 15 s ele compara quem o
servidor lista com quem a tabela diz estar dentro. Quem apareceu, entrou; quem
sumiu, saiu. O texto de uma linha de log tem dono — e o dono não somos nós, como
o chat já ensinou.

A hora da entrada vem do `connectedSeconds` que as duas fontes de jogadores já
trazem, e não do relógio do agente. É isso que faz a reconciliação do boot
deixar de ser um caso especial: ela é a primeira varredura. Sem ela, um agente
reiniciado com gente dentro deixaria sessões abertas para sempre e o tempo
jogado explodiria.

| Situação | O que o agente faz |
|---|---|
| na lista, sem sessão aberta | abre a sessão na hora em que ela **começou** |
| sessão aberta, fora da lista | fecha no **último instante em que o jogador foi visto** |
| na lista, e conectou depois da sessão aberta | reconectou sem o agente ver: fecha aquela e abre outra |
| não deu para ler a lista | **adia** — supor lista vazia fecharia a sessão de todo mundo |

O tempo jogado é somado no **fechamento**, e fechar duas vezes não dobra o
número. Um jogador dormindo continua conectado no Rust e continua online aqui:
"sem posição" não é "offline".

### O histórico

```json
{ "ok": true,
  "events": [ { "at": "…", "kind": "kick", "serverId": "pvp1",
                "actor": "mateus", "detail": "insulto no chat" } ],
  "sample": { "measured": false, "label": "exemplo — ainda não é medido",
              "note": "Kill e morte ainda não existem…",
              "events": [ { "at": "…", "kind": "kill", "…": "…" } ] } }
```

`kind` é `join`, `leave`, `kick`, `teleport`, `ban` ou `unban`. Os dois últimos
**não são gravados**: eles são lidos da tabela `bans` na hora da resposta, com
quem aplicou e quem revogou. Um ban de rede vem com `serverId: null` — ele não é
de servidor nenhum.

**`sample` é a estrutura do que ainda não é medido**, e vem num campo separado
de propósito. Kill e morte não existem hoje: perguntamos ao servidor
(`find kill`, `find death`, `find stats`) e o RCON só oferece o `combatlog` do
próprio jogador; o plugin ainda não os coleta. Mock misturado com dado é a única
coisa pior que não ter o dado — por isso `measured: false` e a frase que
explica.

---

## Wipe

```
  /api/servers/:id/wipe/settings    QUANDO ele zera, e o que o wipe leva
  /api/servers/:id/wipe/plans       a agenda materializada, wipe a wipe
  /api/servers/:id/wipe/maps        em QUE MUNDO ele volta
  /api/servers/:id/wipe/blueprints  quem recomeça sabendo o quê
  /api/servers/:id/wipe/preview     o que vai apagar, lido do disco
  /api/servers/:id/wipe/runs        A EXECUÇÃO — a única rota que apaga
  /api/servers/:id/wipe/upcoming    o que vem por aí (e o recorte do jogador)
  /api/wipe/rustmaps/status         a chave do RustMaps, sem mostrá-la
```

**Só `/runs` executa.** As outras dizem quando o wipe é, o que ele leva e o que
ele apagaria; nenhuma delas para servidor, apaga arquivo ou manda RCON. É a
separação que permite abrir a tela de wipe com o servidor cheio de gente.

**Toda resposta de wipe traz `now`, e ele é o relógio DO AGENTE.** A contagem
regressiva da tela sai dele, corrigida pela diferença para o relógio local: um
navegador adiantado em dez minutos mostraria "faltam 3 min" para um wipe que
ainda tem uma hora.

**A seed é string em toda a API**, pela mesma razão do `steamId`: ela é
transportada, comparada e exibida — nunca somada —, e em número um `.0` aparece
no meio do caminho.

### A agenda

| Rota | |
|---|---|
| `GET /api/servers/:id/wipe/settings` | a cadência, o forçado e a colisão |
| `PUT /api/servers/:id/wipe/settings` | grava **e** reconcilia, na mesma resposta |
| `GET /api/servers/:id/wipe/plans?from=&to=` | a agenda; sem `from`, começa **agora** |
| `POST /api/servers/:id/wipe/plans` | marca um wipe à mão. **201** |
| `PATCH /api/servers/:id/wipe/plans/:planId` | adiar, política, mapa, nota |
| `DELETE /api/servers/:id/wipe/plans/:planId` | **pula** — e não apaga |
| `GET /api/servers/:id/wipe/upcoming?limit=` | os próximos, para o cartão da tela |
| `GET /api/servers/:id/wipe/upcoming/me?steamId=&limit=` | a agenda recortada pelo VIP |

O corpo do `PUT` é a configuração **inteira**. PUT, e não PATCH: a tela edita a
cadência num formulário só, e um merge parcial abriria a pergunta "o que
acontece com o que não veio?" — cuja única resposta segura seria não mexer, o
oposto do que espera quem acabou de desligar a cadência.

```json
{ "cadence": { "enabled": true, "everyDays": 7, "anchorAt": 1754000000000,
               "timeOfDay": "16:00", "timeZone": "America/Sao_Paulo",
               "bpPolicy": "keep" },
  "forced": { "bpPolicy": "wipe" },
  "collision": { "policy": "absorb", "windowHours": 48 } }
```

| Campo | |
|---|---|
| `bpPolicy` | `keep`, `wipe` ou `wipe_except_vip` |
| `collision.policy` | `reanchor` (o forçado vira o novo marco zero), `absorb` (o de cadência perto dele é cancelado), `ignore` (os dois acontecem) |
| `cadence.everyDays` | 1 a 365 — acima disso não é cadência, é um wipe à mão |
| `collision.windowHours` | 0 a 168, e só vale no `absorb` |

O `forced` não tem `enabled`: ele acontece com ou sem nós, e a única escolha é o
que ele leva. `timeZone` é conferido contra o **runtime**, e não contra uma lista
nossa — a base de zonas do ICU muda com a versão do Node, e uma lista escrita à
mão passaria a recusar zona que o próprio agente sabe calcular.

O `PUT` grava, reconcilia e devolve a agenda recalculada (`reconciled` e
`plans`): gravar sem reconciliar deixaria a tela mostrando a cadência nova ao
lado das datas antigas, sem o admin saber qual das duas o agente vai obedecer.

Toda resposta de agenda carrega o mesmo bloco:

```json
{ "ok": true, "now": 1755600000000, "nextForcedAt": 1756494000000,
  "next": { "id": 12, "serverId": "pvp1", "kind": "cadence", "status": "planned",
            "scheduledAt": 1755612000000, "bpPolicy": "keep",
            "mapSource": "pool", "mapPoolId": null, "note": null } }
```

**`next` e `nextForcedAt` podem divergir, e é por isso que os dois vêm**: o
próximo wipe pode ser um da cadência, três semanas antes do forçado, e sem os
dois números a tela não consegue dizer "próximo wipe em 3 dias — e o forçado, em
26". O forçado sai do **cálculo** (primeira quinta do mês, 19:00 UTC), e não da
tabela: assim ele aparece mesmo num servidor cuja agenda nunca foi
materializada.

`kind` é `cadence`, `forced` ou `manual`. `status` é `planned`, `running`,
`done`, `skipped`, `failed` ou `absorbed` — o absorvido continua na lista,
marcado, porque uma agenda com um buraco não explica por que terça não vai ter
wipe.

**O forçado não se pula nem se move.** `DELETE` nele responde
`409 WIPE_FORCED_CANNOT_BE_SKIPPED`, e mudar o `scheduledAt` dele responde
`409 WIPE_FORCED_DATE_IS_FIXED`. Não é teimosia: a atualização mensal do Rust
muda o protocolo e invalida o save do mundo, e o servidor não sobe com o mundo
antigo. O que dá para escolher é o que ele leva.

**`DELETE` num wipe de cadência não o tira da lista**: ele fica `skipped`, e a
resposta devolve o plano. Some de verdade só o que foi marcado à mão — e aí
`plan` vem `null`, porque nada o recria.

O corpo do `POST /wipe/plans` — e o do `PATCH`, que é parcial e exige pelo menos
um campo:

```json
{ "scheduledAt": 1755612000000, "bpPolicy": "keep",
  "mapSource": "pool", "mapPoolId": null, "note": "wipe de aniversário" }
```

`mapSource` é `pool` (a fila decide), `random` (a **mesma** fila — o sorteio só
acontece quando ela não tem nada utilizável, exatamente como no `pool`), `fixed`
(a entrada apontada por `mapPoolId`) ou `keep` (não troca o mundo). **`random`
não pula a curadoria**: com fila cheia ele consome a cabeça dela, e quem marca
essa etiqueta está dizendo "não me importo com qual mundo vem", e não "ignore a
fila".

**`keep` num wipe FORÇADO só vale para mundo procedural.** Marcá-lo num servidor
cujo `.ini` aponta um `.map` custom sem a marca de compatibilidade responde
`409 WIPE_KEEP_IN_FORCED`: o forçado troca o binário do jogo, e o arquivo gerado
na versão de ontem pode não carregar na de hoje. Para manter mesmo assim, marque
o `.map` de agora como compatível (`PATCH /wipe/maps/:mapId` com
`{ "versionOk": true }`) — a
marca vale para a fila e para o mundo que já subiu. Um wipe marcado
à mão nasce `manual` e **`pinned`**: a reconciliação não o apaga, e ele não é
recalculado quando a cadência muda — e todo `PATCH` liga o `pinned`, senão adiar
o wipe de sábado duraria até a próxima reconciliação. Marcar para um instante que
já passou responde `400 WIPE_SCHEDULE_IN_THE_PAST`; dois wipes no mesmo instante,
`409 WIPE_SCHEDULE_CONFLICT` — eles seriam uma parada de servidor contada duas
vezes, e o `UNIQUE` do banco recusaria com um 500 sem explicação. Editar um wipe
que já aconteceu responde `409 WIPE_PLAN_NOT_EDITABLE`.

#### O que UM JOGADOR pode ver do futuro

`/upcoming/me` **não** é o `/upcoming` com um filtro na tela. O corte acontece no
mesmo `buildPlayerCalendar` que desenha a tela CALENDÁRIO dentro do jogo: dois
recortes, um por caminho, dariam duas respostas para a mesma pergunta — e a que
vaza seria descoberta por quem tem interesse em vazá-la.

| Quem pergunta | O que volta |
|---|---|
| sem `?steamId=`, sem VIP, ou bronze | a data e a política de blueprint |
| silver | + o mapa do próximo wipe, **sem a seed** |
| gold | + os três próximos mundos da fila |

```json
{ "ok": true, "now": 1755600000000, "timeZone": "America/Sao_Paulo",
  "tier": "silver", "mapsAllowed": 1,
  "next": { "…": "o cartão grande" },
  "wipes": [ { "…": "o resto da agenda, sem repetir o next" } ],
  "maps": [ { "…": "a fila atrás do próximo, sem seed" } ],
  "nextForcedAt": 1756494000000 }
```

Sem `steamId` a resposta é a de quem não tem VIP: negar por falta de identidade é
a saída conservadora. E qual **é** o próximo wipe vem do mesmo cálculo que o
`{wipe.faltam}` do chat usa — uma segunda conta aqui faria a rota do jogador
responder um wipe e o chat responder outro.

### A fila de mapas

| Rota | |
|---|---|
| `GET /api/servers/:id/wipe/maps` | a fila em ordem, com `next` e `willDraw` |
| `POST /api/servers/:id/wipe/maps` | põe um mundo na fila. **201** |
| `POST /api/servers/:id/wipe/maps/random` | sorteia uma seed e a enfileira. **201** |
| `POST /api/servers/:id/wipe/maps/reorder` | a ordem **inteira** |
| `PATCH /api/servers/:id/wipe/maps/:mapId` | a marca `versionOk` do mapa custom |
| `DELETE /api/servers/:id/wipe/maps/:mapId` | tira da fila |

```json
{ "kind": "procedural", "seed": "123456", "worldSize": 3500,
  "level": "Procedural Map", "levelUrl": null, "versionOk": false, "note": null }
```

`seed` ausente ou `null` **sorteia** — é o mesmo sorteio que a execução usa
quando a fila está vazia, e ele evita o que já está prometido na fila **e** o que
os últimos wipes usaram. Um `custom` sem `levelUrl`, e um `procedural` com um,
são recusados no schema: os dois o banco aceitaria, e os dois apareceriam depois
como "o servidor não subiu depois do wipe".

**A URL do mapa custom é conferida na borda, antes de a linha existir.** Um
`HEAD` pergunta se ela responde, se termina em `.map` e qual o tamanho. O passo
`apagar` é irreversível — descobrir que a URL não responde depois dele é ficar
com o mundo velho apagado e o novo inexistente. A recusa é **422**, e não 400: o
corpo está bem formado; o que não serve é o arquivo do outro lado.

**`warnings` no 201 não é erro.** `SEED_ALREADY_PLAYED` não impede nada, mas
quase sempre é engano — e um 201 mudo faria o admin descobrir a repetição no dia
do wipe. O 201 traz também `drawn`, dizendo se a seed veio da mão ou do sorteio:
a tela não pode anunciar como escolha do admin um número que o agente tirou
sozinho.

**`reorder` recebe a lista INTEIRA**, e não um "mova para cima": com duas telas
abertas, um "para cima" de cada uma produz uma ordem que nenhuma das duas pediu.
Id de fora da fila responde `404 MAP_NOT_FOUND`, id repetido `400 DUPLICATED_ID`
e lista incompleta `400 INCOMPLETE_ORDER`.

**`versionOk` é decisão de gente**, e é o que libera um `.map` para um wipe
**forçado**: o agente não tem como saber se aquele arquivo carrega no binário de
amanhã. `PATCH` num procedural responde `409 MAP_NOT_CUSTOM`.

**Fila vazia não trava wipe.** `willDraw: true` diz que o agente vai sortear — a
resposta explica isso em vez de deixar a tela concluir que o wipe está parado.
`status` de uma entrada é `draft`, `generating`, `ready`, `used` ou `failed`.

### A prévia do RustMaps

| Rota | |
|---|---|
| `GET /api/wipe/rustmaps/status?refresh=1` | a chave serve? qual plano, quanta cota |
| `POST /api/servers/:id/wipe/maps/:mapId/generate` | pede a prévia daquela entrada |

**A chave não sai daqui.** `RUSTMAPS_API_KEY` vive no `.env`, e o status responde
só *válida/inválida*, o plano e a cota. Nem prefixo, nem últimos quatro dígitos:
uma chave que aparece na tela aparece também no print que alguém cola no Discord.
Sem `?refresh=1` a resposta vem do último retrato — a tela recarrega sozinha, e
perguntar ao RustMaps a cada abertura gastaria cota para redesenhar o mesmo
cadeado.

**Nenhuma das duas pode segurar um wipe.** O `POST` responde **200** mesmo com o
RustMaps fora do ar; o que muda é `outcome` e a frase. Num mundo procedural a
seed **é** o mapa, e a imagem é enfeite — um 5xx aqui faria a tela pintar de
vermelho uma fila perfeitamente utilizável. As duas únicas recusas são de quem
chamou: `404 MAP_NOT_FOUND` e `409 MAP_ALREADY_USED`.

`announcedRateLimit` é o teto que a API **anuncia**, e está marcado assim de
propósito: ninguém o mediu com uma chave de verdade. Ver
[09-ROADMAP.md](09-ROADMAP.md).

### Blueprints que sobrevivem ao wipe

| Rota | |
|---|---|
| `GET /api/servers/:id/wipe/blueprints` | a régua, o último snapshot e os contadores |
| `PUT /api/servers/:id/wipe/blueprints/settings` | a régua |
| `POST /api/servers/:id/wipe/blueprints/snapshot` | tira um agora |
| `POST /api/servers/:id/wipe/blueprints/restore` | devolve a **um** jogador |

**Nenhuma delas apaga nada.** O snapshot **lê** o que o jogo sabe e grava no
banco do agente; a devolução **ensina** de volta. Quem apaga blueprint é o passo
`apagar` da execução.

O snapshot é **lógico**, e não uma cópia de arquivo: `player.blueprints.<n>.db` é
um arquivo só, de todos os jogadores, e não há como recortar "os BPs de quem não
é VIP". Por isso ele **exige o servidor no ar** — quem lê é o `OrigemZAgent`
dentro do jogo. Com o RCON fora a resposta é `503 RCON_UNAVAILABLE`, e não um
snapshot vazio, que o wipe seguinte trataria como "ninguém sabia nada" e
apagaria tudo com o agente achando que guardou uma cópia.

```json
{ "tiers": { "bronze": { "mode": "bench", "bench": 1 },
             "silver": { "mode": "bench", "bench": 2 },
             "gold":   { "mode": "all",   "bench": 3 } },
  "delayHours": 0 }
```

`mode` é `none` (recomeça do zero), `bench` (tudo até aquela bancada, 1 a 3) ou
`all`. O nome do nível é **texto livre**: ele vem do `OrigemZVip.json` daquele
servidor, e um `enum` aqui recusaria um nível que o dono do servidor criou. Quem
tem dois níveis leva o do melhor deles. `delayHours` vai até 168 — acima disso o
snapshot já expirou —, e com atraso a corrida inicial acontece sem a vantagem.

O snapshot é de **todo mundo**; quem recebe de volta é decidido **na devolução**,
contra o VIP vigente naquele instante. Salvar só de VIP quebraria quem compra VIP
no dia seguinte ao wipe. E ele vale para o wipe **seguinte, e só ele**.

```json
{ "ok": true, "now": 1755600000000,
  "settings": { "…": "a régua acima" },
  "snapshot": { "players": 240, "items": 31840,
                "createdAt": 1755500000000, "wipeRunId": 7 },
  "counters": { "pending": 12, "sent": 220, "applied": 218,
                "expired": 0, "failed": 2 } }
```

`POST .../restore` leva `{ "steamId": "…", "force": false }`. `force: true`
devolve o snapshot inteiro mesmo sem VIP — é o botão do suporte. A devolução
acontece no **login** do jogador, e é idempotente por `(steamId, snapshot)`:
quem entra e sai três vezes não recebe três vezes, e não recebe zero.

### O que o wipe vai apagar

| Rota | |
|---|---|
| `GET /api/servers/:id/wipe/preview` | os arquivos, do disco, com impedimentos e avisos |
| `GET /api/servers/:id/wipe/plugin-data` | o que o *full wipe* levaria além disso |

O `preview` não escreve nada, e por isso é seguro de chamar a cada abertura de
tela — inclusive com o servidor no ar e cheio de gente. Ele devolve o mundo de
hoje, o mundo que entra (`nextMap`), a pasta do save classificada, o espaço do
backup e duas listas:

| | |
|---|---|
| `blockers` | o que **recusa** o `POST /wipe/runs`, com 409 |
| `warnings` | o que precisa ser dito e não impede nada |

Hoje há **um** impedimento, `NO_DISK_SPACE`, e os avisos `NO_SAVE_FOLDER`,
`MAP_KEPT`, `KEEP_REFUSED_IN_FORCED`, `EMPTY_MAP_POOL`, `PINNED_MAP_UNUSABLE`,
`BACKUP_DISABLED`, `BLUEPRINTS_WIPED`, `FULL_WIPE_WITHOUT_LIST`,
`PLUGIN_DATA_MISSING` e `RCON_DOWN`.

**A prévia descreve a execução EM CURSO, quando há uma.** O relógio marca o
plano `running` ao criar a execução, com a antecedência do maior offset de aviso
(1440 min, no padrão): nas 24 h que antecedem todo wipe agendado é esse o plano
que vale, e é ele que sai em `plan` — a mesma ordem do `{wipe.faltam}` do chat e
da tela CALENDÁRIO. Sem isso a tela descrevia o wipe da semana que vem: outro
mundo, outra `bpPolicy` e, com ela, outra classificação dos arquivos do save.

`KEEP_REFUSED_IN_FORCED` sai quando o plano manda **manter** o mundo, o wipe é o
forçado e o mundo de agora é um `.map` custom sem a marca de compatibilidade: o
wipe acontece, o mundo sai da fila, e a frase diz por que a ordem do admin não
valeu. A agenda recusa gravar isso (`409 WIPE_KEEP_IN_FORCED`), e este aviso é
para os planos gravados antes da trava e para o servidor que virou mapa custom
depois de o plano ser marcado.

**`nextMap` é a MESMA decisão que a execução vai consumir** — o `mapOfPlan` de
`core/src/wipe/next-wipe.ts` —, e não "a cabeça da fila". Ele é `null` nos dois
mundos que não saem da fila, e o aviso que acompanha diz qual é: `MAP_KEPT`, o
plano `keep`, que mantém o mapa de agora sem tocar na fila, e `EMPTY_MAP_POOL`,
a seed que o agente sorteia porque nada na fila serve. `PINNED_MAP_UNUSABLE` sai
quando o plano é `fixed` e a entrada apontada não vai subir (sumiu, já foi
consumida, ainda está gerando, ou é `.map` custom sem a marca de versão num wipe
forçado): o wipe acontece com a fila, e a frase diz por quê.

**O espaço é conferido aqui porque aqui o servidor ainda está no ar.** Descobrir
o disco cheio no passo `backup` seria descobrir com o servidor já parado, os
jogadores fora e uma operação que não dá para abandonar nem concluir.

### Como o agente executa

| Rota | |
|---|---|
| `GET /api/servers/:id/wipe/exec-settings` | os avisos, o esvaziamento, o backup, o full wipe e o pós-wipe |
| `PUT /api/servers/:id/wipe/exec-settings` | grava a configuração inteira |

```json
{ "announce": { "offsetsMinutes": [1440, 360, 60, 15, 5, 1],
                "text": "WIPE em {wipe.faltam}. Guardem o que puderem…",
                "tag": "WIPE", "tagColor": "#ff4444",
                "color": "#ffffff", "size": 15 },
  "drain": { "enabled": true, "waitMinutes": 5, "force": false },
  "backup": { "enabled": true, "keep": 3 },
  "pluginData": { "enabled": false, "patterns": [] },
  "post": { "resync": true, "announce": true,
            "announceText": "Mundo novo no ar! Boa sorte a todos." } }
```

Os offsets vão do maior para o menor, até 2880 min (dois dias), no máximo 12.
Cada padrão de `pluginData` é um caminho relativo à pasta do servidor; cabem 200,
e o teto existe para uma lista colada de fora não virar uma varredura de disco a
cada requisição.

**A lista do full wipe nasce vazia, e isso não é esquecimento**: o
`OrigemZVip.json` é o VIP que alguém pagou, e nenhum padrão nosso pode marcá-lo
sozinho.

### A execução

| Rota | |
|---|---|
| `POST /api/servers/:id/wipe/runs` | **WIPAR AGORA**. `202` — ou `200`, se a chave repetir |
| `GET /api/servers/:id/wipe/runs?limit=` | o histórico, com os mundos que já rodaram |
| `GET /api/servers/:id/wipe/runs/:runId?fromLine=` | os passos e o log |
| `POST /api/servers/:id/wipe/runs/:runId/resume` | retoma do passo que falhou. `202` |
| `POST /api/servers/:id/wipe/runs/:runId/cancel` | pede a parada |

> **`POST /wipe/runs` é a única rota do agente que apaga o trabalho de todos os
> jogadores.** Ela exige **duas** coisas, e as duas são necessárias.

| A trava | Onde | O que ela impede |
|---|---|---|
| `Idempotency-Key` | header, **obrigatório** | o duplo-clique zerar o servidor duas vezes |
| `identity` | no corpo, **digitado** | o clique distraído que vence qualquer "tem certeza?" |

A chave é gravada na linha, com índice único: a segunda chamada com a mesma chave
recebe **200 e a MESMA execução**, e não uma nova. Duas requisições chegando
juntas não se enxergam na consulta — quem as separa é o índice do banco, e a
resposta ali é a mesma. Não mandar o header responde
`400 IDEMPOTENCY_KEY_REQUIRED`: gerar uma chave aqui quando o cliente não manda
seria escrever uma chave diferente a cada requisição, ou seja, exatamente o
duplo-clique que ela existe para impedir, com a aparência de estar protegido.

O `identity` é o `SERVER_IDENTITY` daquele servidor, digitado por inteiro. Ele
**não** é um `?force=true`: é a confirmação forte que o GitHub usa para apagar
repositório, e o motivo é o mesmo. Errar responde `400 WIPE_IDENTITY_MISMATCH`.

```json
{ "identity": "pvp1", "planId": 12, "bpPolicy": "wipe_except_vip",
  "fullWipe": false, "at": 1755612000000 }
```

`planId` ausente é o WIPAR AGORA, que não consome plano nenhum. `at` no futuro faz
o passo `avisar` cumprir os offsets antes de qualquer coisa acontecer — é o
"wipar daqui a 15 min" com a contagem no chat. `bpPolicy` ausente cai no do
plano; sem plano, em `keep`.

**As recusas acontecem com o servidor ainda no ar.** Disco cheio vira 409 aqui,
antes do 202 — e não no passo `backup`, que roda com o servidor já parado.

A resposta é `202` com `run` e `operationId`. Os oito passos são `avisar`,
`esvaziar`, `parar`, `backup`, `apagar`, `configurar`, `subir` e `pos-wipe`; o
`status` da execução é `running`, `done`, `failed` ou `cancelled`.

**O log é da OPERAÇÃO, e ela vive em memória.** Depois de um `pm2 restart` ele
some, e o que sobra são os passos, que estão no banco. A resposta diz qual dos
dois casos é (`live`), para a tela não mostrar um console vazio como se fosse
silêncio. `fromLine` é o cursor, e `nextLine` volta com ele.

**Retomar não roda tudo de novo.** Os passos já `done` são pulados: "de novo" no
meio de um wipe significaria apagar um mundo que já é o novo. Retomar uma
execução em curso responde `409 WIPE_ALREADY_RUNNING`; uma que terminou,
`409 WIPE_ALREADY_DONE`.

**Cancelar não desfaz.** Ele pede a parada; o que já foi apagado continua
apagado — e por isso a resposta diz em que passo ela estava. Quem cancela um wipe
no meio precisa saber se o servidor ficou sem mundo.

---

## Mensagens

```
  /api/messages        o que o servidor fala sozinho — a lista da REDE
  /api/chat/broadcast  uma fala avulsa, agora
```

**A mensagem é de rede**, como VIP, kit e loja. Por isso não existe
`/api/servers/:id/messages`: escreve-se uma vez e escolhe-se em quais servidores
ela sai, na lista `targets`. **Lista vazia = todos** — pela mesma razão do
`scope: "network"` dos banimentos.

| Rota | |
|---|---|
| `GET /api/messages` | a lista, e os nomes de variável que o agente sabe trocar |
| `POST /api/messages` | cria. **201** |
| `PATCH /api/messages/:messageId` | edita **o que veio**, e só isso |
| `DELETE /api/messages/:messageId` | remove, e o log vai junto |
| `POST /api/messages/reorder` | a ordem da lista, inteira |
| `POST /api/messages/:messageId/test` | manda **agora**, sem mexer no relógio |
| `GET /api/messages/:messageId/log?limit=` | saiu mesmo? |
| `POST /api/chat/broadcast` | uma fala avulsa |

A lista traz junto `variables.names` e `variables.namespaces`, e eles vêm do
**registro** do agente, não de uma constante do painel: quem registra `{wipe.*}`
é outra parte do código, e uma lista escrita à mão no painel ficaria mentindo no
dia em que ela mudasse.

**A cor de um TRECHO vai dentro do `text`.** O campo `color` pinta a fala
inteira; para destacar um pedaço existe a marcação, com nome da paleta ou
hexadecimal:

```
"text": "Agora tem [verde]{online}[/]/{max}"
"text": "Wipe [#ff0000]HOJE[/] às 16h"
```

A paleta é `branco`, `preto`, `cinza`, `vermelho`, `laranja`, `amarelo`,
`dourado`, `verde`, `ciano`, `azul`, `roxo` e `rosa`. `[/]` fecha, e **abrir a
mesma cor de novo também fecha** — `Agora tem [azul]{online}[azul]/{max}` sai
como se espera, que é como quase todo mundo escreve na primeira tentativa. Cor
aberta e não fechada vale até o fim daquela fala, e nunca além dela.

Colchete que **não é cor** — `[AVISO]`, `[BR]`, `[1x]` — sai literal, pela mesma
razão da variável desconhecida: comê-lo apagaria em silêncio a tag que o admin
digitou. Rich text (`<color=…>`) no `text` continua sendo **removido**: quem
converte a marcação é o `OrigemZChat`, depois da faxina, e só depois de
reconhecer a cor. Sem o plugin no servidor a fala sai pelo `say` do jogo, e aí
os marcadores são retirados — o `say` não tem cor nenhuma, e `[verde]` na tela
seria pior que a frase sem destaque.

```json
{ "name": "Discord", "text": "Entre no nosso Discord!",
  "enabled": true, "scheduleKind": "interval", "everySeconds": 1800,
  "timeOfDay": null, "weekdays": [], "runAt": null,
  "timeZone": "America/Sao_Paulo", "windowFrom": "10:00", "windowTo": "23:00",
  "onlyWithPlayers": true, "minPlayers": 1,
  "tag": "AVISO", "tagColor": "#ffcc00", "color": "#ffffff", "size": 15,
  "targets": ["pvp1"] }
```

| `scheduleKind` | O que ele exige |
|---|---|
| `interval` | `everySeconds`, de 10 s a 30 dias |
| `daily` | `timeOfDay`, em `HH:MM` |
| `weekly` | `timeOfDay` **e** pelo menos um dia em `weekdays` (0 = domingo) |
| `once` | `runAt`, em ISO-8601 com fuso |

**As quatro formas ficam honestas na borda.** Cada combinação faltante é um
pedido que o **banco aceitaria** (as colunas são anuláveis) e que o admin
descobriria como "a mensagem nunca sai" — o pior defeito possível numa mensagem,
porque não parece defeito. A recusa é `422 MESSAGE_INVALID_SCHEDULE`, com a frase
que diz o que preencher. A janela de horário é um **par**: um lado só é
configuração pela metade, e um `timeOfDay` fora da janela ("todo dia às 03:00,
mas só entre 10:00 e 23:00") é uma mensagem que nunca sairia. Fuso desconhecido
neste runtime responde `422 MESSAGE_INVALID_TIMEZONE`.

**As datas viajam em ISO e o banco guarda epoch ms**, como o `expiresAt` do VIP:
`runAt`, `nextAt`, `lastSentAt`, `createdAt` e `updatedAt` saem em ISO-8601. A
resposta traz também `position`, `sentCount` e `schedule` — a frase pronta que a
coluna REPETE da tela mostra. `nextAt: null` é uma mensagem sem próxima saída.

**`PATCH`, e não `PUT`** — diferente dos kits, e por um motivo concreto: a lista
liga e desliga uma mensagem com **um clique**, e mandar o corpo inteiro para
trocar um booleano faria a tela reenviar o texto e o ritmo a cada clique, com a
chance de sobrescrever o que outra aba acabou de gravar. Em troca, a coerência é
conferida no **resultado da mistura**, e não no que chegou: trocar só o
`scheduleKind` para `weekly` deixaria a mensagem sem dia nenhum marcado.

**`nextAt` não vem do corpo.** Ele é estado do relógio, e é sempre recalculado
pelo agente — uma tela que pudesse mandá-lo empurraria uma mensagem para daqui a
um ano sem ninguém entender por quê. E consertar uma vírgula **não** zera o
relógio: só recalcula quem mexeu no ritmo (`scheduleKind`, `everySeconds`,
`timeOfDay`, `weekdays`, `runAt`, `timeZone`), e sempre ao **religar** — uma
mensagem desligada há semanas tem um horário de semanas atrás, que sairia na
volta seguinte sem ninguém pedir.

**Testar não pode adiar.** O `POST .../test` manda agora e **não** toca no
`nextAt`: se o teste consumisse o horário, conferir a mensagem seria mudá-la, e
quem clicasse duas vezes empurraria a próxima saída para daqui a uma hora sem
saber. A resposta traz o texto **já resolvido**, por servidor — é o que responde
"o `{wipe.faltam}` está pegando?" sem entrar no jogo:

```json
{ "ok": true,
  "reports": [ { "serverId": "pvp1", "ok": true, "players": 37, "via": "plugin",
                 "text": "WIPE em 2 h 15 min…", "error": null } ],
  "detail": "Saiu em pvp1. O horário da próxima saída continua o mesmo." }
```

**O log traz as linhas que FALHARAM também**, com o motivo: um log só de sucessos
responde "sim" justamente quando a resposta é "não". Uma mensagem cujos alvos
apontam para servidores que não existem mais responde `409 MESSAGE_NO_TARGET` no
teste — e um `targets` com id desconhecido responde `404 SERVER_NOT_FOUND` já na
gravação, porque uma mensagem apontando para o nada seria indistinguível de uma
bem configurada na tela.

**`reorder` recebe a fila completa**, como o da fila de mapas, e pela mesma razão.

**Remover apaga o histórico junto**, pela cascata. Quem quer calar preservando o
histórico **desliga** (`enabled: false`) — e é isso que a frase da resposta diz.

### `POST /api/chat/broadcast`

A fala avulsa, pelo **mesmo transporte** das agendadas: é por aqui que um site
externo, ou um plugin, faz o servidor falar. Ela não monta comando nenhum — uma
segunda forma de mandar texto ao chat é exatamente o que esta fase existe para
não ter.

```json
{ "serverId": "pvp1", "text": "Servidor reiniciando em 5 min",
  "tag": "AVISO", "tagColor": "#ffcc00", "color": "#ffffff", "size": 15,
  "steamId": "76561198000000000" }
```

`steamId` ausente fala para todo mundo que está online. A resposta diz por onde
saiu: `via: "plugin"` traz em `sent` quantos receberam; `via: "say"` é o caminho
do próprio jogo, sem cor, e aí o jogo **não** diz quantos receberam.

**As cores são conferidas** (`#rgb` a `#rrggbbaa`). Elas vão para o `<color=…>`
do jogo e para o `style` da prévia na tela; sem a conferência, o campo seria um
caminho para injetar marcação. O texto vai até 512 caracteres: o comando viaja
pelo RCON, e dez mil caracteres viram um frame que chega truncado ao plugin — um
aviso pela metade, que **parece** ter funcionado.

---

## Comando de RCON

`POST /api/servers/:id/rcon` `{"command":"playerlist"}` → a resposta crua.

É o canivete que evita inventar rota para cada coisa do jogo. Ele **não** é
"comando arbitrário na máquina": o comando vai para o servidor de Rust pelo
RCON, exatamente como o console web faz — e quem tem a senha do RCON já podia
fazer isso.

---

## O que **não** existe nesta API

Ditas em voz alta, para ninguém procurar: entrega de item (`give`), **ranking**,
kills e mortes (ver o `sample` acima), VIP, loja, propagandas (o overlay CUI),
webhooks, auto-update do agente. Ver [09-ROADMAP.md](09-ROADMAP.md).

> **Wipe, calendário e mensagens saíram desta lista na Fase 6** — as rotas estão
> nas duas seções acima. A **idempotência** também: o `POST /wipe/runs` a exige.
> O resto da lista é da Fase 1 e não foi revisto nesta passada.

O ranking fica de fora porque depende de kills e tempo MEDIDOS, e construí-lo
sobre exemplo seria fixar uma regra de pontuação em cima de números falsos. O
que existe é onde guardar o que ele vai somar.

Os **admins** existem, mas só como comando: o agente lê o `users.cfg` e manda
`ownerid`/`moderatorid`. Não há tabela de administradores, e nenhum nível de
permissão dentro do painel — quem entra nele faz tudo. Ver
[03-DECISOES.md](03-DECISOES.md), D5.
