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

| Rota | |
|---|---|
| `GET /api/servers/:id/plugins` | os `.cs` em `oxide\plugins`, com tamanho e data |
| `POST /api/servers/:id/plugins` | envia um `.cs` (multipart) e recarrega |
| `DELETE /api/servers/:id/plugins/:name` | remove e descarrega |
| `POST /api/servers/:id/plugins/:name/reload` | só recarrega |

A resposta do envio traz o que o Oxide disse:

```json
{ "ok": true, "name": "MeuPlugin.cs", "bytes": 4211,
  "reload": { "sent": true, "output": "Loaded plugin MeuPlugin v1.0.0" } }
```

Se o Oxide recusou compilar, `ok` continua `true` (o arquivo **foi** gravado) e
`reload.output` traz o erro de compilação. São coisas diferentes, e misturá-las
faria o operador achar que o upload falhou.

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
