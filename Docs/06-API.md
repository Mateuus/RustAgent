# 06 — API (Fase 1)

Base: `http://127.0.0.1:8787`. Formato: JSON, sempre com `ok` no corpo.

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
| `INTERNAL_ERROR` | 500 | inesperado (detalhes só no log) |

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

---

## Comando de RCON

`POST /api/servers/:id/rcon` `{"command":"playerlist"}` → a resposta crua.

É o canivete que evita inventar rota para cada coisa do jogo. Ele **não** é
"comando arbitrário na máquina": o comando vai para o servidor de Rust pelo
RCON, exatamente como o console web faz — e quem tem a senha do RCON já podia
fazer isso.

---

## O que **não** existe nesta API

Ditas em voz alta, para ninguém procurar: entrega de item (`give`),
idempotência, jogadores persistidos, VIP, loja, admins, wipe, propagandas,
webhooks, auto-update do agente. Ver [09-ROADMAP.md](09-ROADMAP.md).
