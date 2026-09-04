# 22 — Comandos e config vindos do site: o que o agent precisa implementar

> **Para quem é.** Para quem vai escrever, **neste repositório**, as duas pontas que faltam do
> canal com o site OrigemZ: a **fila de comandos** (o admin clica "Reiniciar" no painel do site e
> o servidor reinicia) e a **config desejada** (o admin grava mapa, seed, hostname no site e o
> `.ini` daqui passa a ter esses valores).
>
> **O que ele diz.** O contrato inteiro das quatro rotas novas, campo a campo, mais as dez regras
> que o agent tem de cumprir para que o desenho seja *at-most-once* de verdade. Depois de lê-lo dá
> para escrever o código sem abrir o repositório do site.
>
> **O que ele NÃO é.** Não é relato de coisa testada contra o site. **As duas pontas deste lado
> existem e estão verdes** — `core/src/site/commands.ts` e `core/src/site/config.ts`, 963 testes,
> typecheck e lint limpos (ver §10) —, mas **nenhuma linha delas falou com o servidor de vocês**:
> todo teste daqui fala com um dublê que devolve o que este documento diz que o site responde. Do
> lado do site, as quatro rotas **estavam sendo escritas em paralelo** a este documento: não havia
> `commands/claim` nem `server/config` no ar em 03/09/2026, e o critério de aceite da §8 é o que
> decide quando houver. É o mesmo risco número um do `Docs/21`, e ele continua de pé: se as rotas
> nascerem com outro contrato, os testes daqui passam e a integração falha.
>
> **Data:** 03/09/2026 (implementação do lado agent: 03/09/2026).
> **Contrato:** `oz-rust/3` — as rotas **11 a 14**.
>
> ####  A CONFIG DE SERVIDOR DESTE DOCUMENTO FICOU MENOR QUE A REAL  ####
>
> Em 04/09/2026 os **sete** campos da §2.4 viraram **vinte e dois** — a tela de configuração
> inteira, incluindo portas, senha de RCON, SteamCMD, `identity` e `enabled` —, e nasceu um canal
> novo para a **loja, os kits e o VIP**. O contrato daqui continua valendo palavra por palavra; o
> que mudou está no **[`Docs/23`](23-CONFIG-PELO-SITE.md)**, e é ele que a implementação segue.

---

## 0 — Índice

| § | Assunto |
|---|---|
| [1](#1--em-uma-página) | Em uma página: o que nasce, e o que continua igual |
| [2](#2--o-contrato-byte-a-byte) | O contrato, byte a byte — as quatro rotas |
| [3](#3--as-dez-regras-que-o-agent-precisa-cumprir) | As **dez regras**, cada uma com o porquê |
| [4](#4--a-allowlist-tem-três-kinds-e-este-agent-conhece-oito) | A allowlist tem **três** kinds, e este agent conhece **oito** |
| [5](#5--o-site-não-chama-o-agent-e-não-vai-chamar) | O site **não** chama o agent, e não vai chamar |
| [6](#6--onde-isso-encaixa-no-código-de-hoje) | Onde isso encaixa no código de hoje |
| [7](#7--a-tradução-de-erro-o-código-interno-não-é-o-reason-do-contrato) | A tradução de erro: o código interno **não** é o `reason` do contrato |
| [8](#8--critérios-de-aceite) | Critérios de aceite — verificáveis, os três |
| [9](#9--o-que-ainda-não-tem-contrato) | O que ainda **não** tem contrato |
| [10](#10--o-que-foi-construído) | O que foi construído — arquivos, decisões e o que ficou de fora |

---

## 1 — Em uma página

### 1.1 O que nasce

| # | O quê | Cadência | Onde mora |
|---|---|---|---|
| 1 | **Fila de comandos** — o agent puxa o que o admin enfileirou no site e executa | **10 s** | `core/src/site/commands.ts` (novo) |
| 2 | **Config desejada** — o site guarda o que o servidor *deveria* ser; o agent converge | junto do laço de status (**30 s**), ou por `ETag` | `core/src/site/config.ts` (novo) |

São **dois relógios a mais saindo daqui**, e nenhuma porta nova entrando. O canal continua sendo
`https://<site>/api/agent/*` com `Authorization: Bearer` + `X-Server-Id`, sempre iniciado por este
agent — igual ao beacon, à carteira, à fila de entregas e ao retrato.

### 1.2 O que NÃO muda

- **A trava de operação continua sendo a do `ops/service.ts`.** Um comando do site vira uma
  `operation` normal, com o mesmo `operationId`, o mesmo log e a mesma trava por recurso. Não
  existe caminho paralelo de execução.
- **A config continua sendo gravada pelo mesmo `updateSettings`** que o `PATCH /api/servers/:id`
  já usa (`core/src/http/routes/servers.ts:235`). Uma segunda maneira de escrever o `.ini` é a
  última coisa que este trabalho pode criar.
- **O painel local continua mandando em tudo o que o site não manda.** Os cinco kinds fora da
  allowlist, o wipe e o RCON cru continuam existindo **só aqui** — §4.
- **Nada disto toca dinheiro.** Comando e config não mexem em carteira, loja ou entrega. Um
  desfecho errado aqui derruba servidor; não cobra ninguém.

### 1.3 O interruptor

O mesmo de sempre: `SITE_BASE_URL` vazio = nada disto acontece. Um servidor sem pareamento não
puxa comando nem config.

---

## 2 — O contrato, byte a byte

### 2.1 O que vale para as quatro

**Headers idênticos aos das outras rotas autenticadas** (§5.1 do `Docs/20`):

```
Authorization: Bearer <o bearer daquele servidor>
X-Server-Id: <o SITE_SERVER_ID daquele servidor>   (STRING EXATA, maiúsculas incluídas)
Accept: application/json
User-Agent: OrigemZ-Rust-Agent/<versão>
Content-Type: application/json                      (só nos POST)
```

**Cadência sugerida:**

| Laço | Intervalo | Por quê este número |
|---|---|---|
| `commands/claim` | **10 s** | é o teto do critério de aceite: "de *enfileirado* a *executando* em ≤10 s". Mais rápido gasta cota por nada; mais devagar faz o admin clicar duas vezes |
| `server/config` | **30 s**, colado no laço de status, **ou** por `ETag` | config é estado, não tarefa: ninguém está esperando na frente da tela. Com `ETag`, a volta que não mudou nada custa um **304** e zero corpo |

**Carga:** +6 req/min por servidor pareado (6 do claim; a config viaja de carona no laço de 30 s ou
custa 2/min a mais se tiver laço próprio). O limitador do canal é por `serverId`, então o teto por
linha continua o mesmo — o que cresce é o total no Postgres do site.

> ####  ACK É PARTE DO LAÇO, NÃO UM EXTRA  ####
>
> Cada rodada do claim que trouxer comando gera **pelo menos dois** `POST /commands/ack`: um
> `accepted` na hora, e um `executed`/`failed` no desfecho (regra 6). Uma implementação que só
> ACKa no fim faz o painel do site mostrar "enfileirado" durante um `server-restart` inteiro, e o
> admin conclui que não funcionou.

### 2.2 `POST /api/agent/commands/claim` — puxar

```json
POST /api/agent/commands/claim
{ "limit": 5 }
```

```json
{
  "ok": true,
  "commands": [
    {
      "id": "CMD-9f3a1c2b7e04",
      "kind": "server-restart",
      "params": {},
      "issuedAt": "2026-09-03T14:00:00.000Z",
      "expiresAt": "2026-09-03T14:02:00.000Z",
      "ttlMs": 120000,
      "leaseToken": "b7c1…"
    }
  ]
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `limit` | number? | 1..10, default do site. Pedir mais que isso não traz mais |
| `id` | string | `/^CMD-[0-9a-f]{12}$/` — mesmo formato de `DLV-`. **Quem gera é o site** (§23.1 do `Docs/20`: formato de id é dele) |
| `kind` | string | **um dos três** da §4. Qualquer outro valor ⇒ regra 5 |
| `params` | object | objeto, possivelmente vazio. **Chave que o agent não conhece é ignorada, nunca recusada** — e ver a §9, porque `params` ainda não está fechado |
| `issuedAt` | ISO 8601 | quando o admin clicou. Diagnóstico |
| `expiresAt` | ISO 8601 | **absoluto**, relógio do site |
| `ttlMs` | number | o **mesmo** prazo, relativo. Existe por causa da regra 9 |
| `leaseToken` | string | opaco. Volta no ACK, e só ele fecha a linha (regra 2) |

**`commands: []` é a resposta normal** — é o que 99% das rodadas devolvem. Não é erro, não acende
nada na tela, não acorda o beacon.

### 2.3 `POST /api/agent/commands/ack` — dizer o que aconteceu

```json
POST /api/agent/commands/ack
{
  "commands": [
    { "id": "CMD-9f3a1c2b7e04", "leaseToken": "b7c1…", "status": "accepted",
      "at": "2026-09-03T14:00:01.000Z" },
    { "id": "CMD-9f3a1c2b7e04", "leaseToken": "b7c1…", "status": "executed",
      "operationId": "op_7f2c", "at": "2026-09-03T14:00:46.000Z" }
  ]
}
```

**Lote de 1 a 10.** (A fila de **entregas** aceita 50; esta aceita 10, e a diferença é proposital:
comando é raro e caro, entrega é comum e barata.)

| Campo | Tipo | Regra |
|---|---|---|
| `id` | string | o `CMD-…` que veio no claim |
| `leaseToken` | string | **obrigatório**. Sem ele, ou com token velho, a linha volta em `unknown` |
| `status` | enum | `accepted` · `executed` · `failed` · `refused` — **e não há um quinto** |
| `reason` | string? | **obrigatório** em `refused`; opcional em `failed`. Vocabulário fechado abaixo |
| `operationId` | string? | o id da `operation` local. É o que liga o que o site mostra ao log daqui |
| `at` | ISO 8601 | relógio do agent. Diagnóstico — quem ordena é o carimbo do site |

**O vocabulário FECHADO de `reason`** — dez valores, e nenhum a mais:

| `reason` | Quando |
|---|---|
| `OPERATION_NOT_ALLOWED` | o kind é conhecido, mas este agent não o executa por esta via |
| `SERVER_RUNNING` | pediram para subir o que já está no ar |
| `SERVER_NOT_RUNNING` | pediram para parar/reiniciar o que não está no ar |
| `RCON_UNAVAILABLE` | o processo está no ar e o RCON não responde — sem ele não dá para encerrar salvando |
| `RCON_TIMEOUT` | o comando foi mandado e a resposta não veio |
| `NOT_INSTALLED` | o jogo não está em disco |
| `SERVER_DISABLED` | o agent não cuida deste servidor (desabilitado no `.ini`) |
| `COMMAND_EXPIRED` | regra 3 |
| `AGENT_BUSY` | regra 4 |
| `UNKNOWN_KIND` | regra 5 |

⚠️ **Nenhum destes é o código interno do agent.** Ver §7 — a tradução é obrigatória e é onde este
trabalho vai errar se ninguém escrever a tabela.

### 2.4 `GET /api/agent/server/config` — o que o servidor deveria ser

```json
{
  "ok": true,
  "version": 7,
  "desired": {
    "name": "rust-pvp1",
    "hostname": "OrigemZ Rust #1",
    "description": "Servidor PvP da OrigemZ",
    "maxPlayers": 200,
    "map": "Procedural Map",
    "worldSize": 3500,
    "seed": 1234567
  }
}
```

**`version` é um inteiro que só cresce**, por servidor. É o que diz se há trabalho a fazer:
`version` igual à última aplicada ⇒ **nada a fazer**, e o laço termina ali.

**`ETag` / `304`:** o site carimba a resposta com `ETag`; o agent guarda e manda `If-None-Match` na
volta seguinte. Um **304 sem corpo** é o desfecho normal e barato. Suportar `ETag` é recomendado,
não obrigatório — comparar `version` já basta para a correção; o `ETag` economiza o corpo.

**Campo ausente = "o site não opina sobre ele".** Não é `null`, não é "apague". Um `desired` que
venha só com `hostname` muda `hostname` e mais nada.

### 2.5 `POST /api/agent/server/config/ack` — o que foi feito

```json
POST /api/agent/server/config/ack
{
  "version": 7,
  "applied": true,
  "requiresRestart": ["map", "worldSize", "seed"],
  "errors": []
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `version` | number | a versão que este ACK fecha. **Sempre a que veio no `GET`**, nunca a "atual" |
| `applied` | boolean | `true` se a gravação aconteceu, mesmo com algum campo em `errors[]` |
| `requiresRestart` | string[] | **exatamente o que `updateSettings` devolveu** — não uma lista escrita à mão |
| `errors` | `{field, code}[]` | um por campo que não entrou. O resto entrou |

> ####  `requiresRestart` É MEDIDO, NUNCA ESCRITO À MÃO  ####
>
> `supervisor.updateSettings()` (`core/src/servers/supervisor.ts:544`) devolve `string[]` com os
> nomes de campo — **da API, não do `.ini`** — que só valem no próximo start. A lista vem de
> `ServerSupervisor.RESTART_KEYS` (`:496`), e ela já responde a pergunta certa.
>
> **Dos sete campos da config desejada, SEIS estão em `RESTART_KEYS`:** `hostname`, `description`,
> `map`, `seed`, `worldSize`, `maxPlayers`. Só `name` não está. Ou seja: quase toda gravação vinda
> do site volta com `requiresRestart` não-vazio, e isso é **informação, não falha** — é o que faz o
> painel do site dizer "gravado, vale no próximo start" em vez de "salvo" (e o admin concluir que
> não funcionou porque o mapa não mudou).

---

## 3 — As dez regras que o agent precisa cumprir

Cada uma existe porque a alternativa já custou alguma coisa em algum lugar deste sistema.

### 1. `/claim` NÃO é leitura

A linha **sai da fila no próprio pull**, com o `leaseToken` carimbado nela. Puxar duas vezes **não**
devolve o mesmo comando.

*Por quê:* é o que torna o desenho *at-most-once*. Se `/claim` fosse um `GET` idempotente, dois
laços do mesmo agent — ou um retry de rede — reiniciariam o servidor duas vezes, e a segunda cai em
cima de gente que acabou de entrar.

### 2. O `leaseToken` volta no ACK

ACK **sem** `leaseToken`, ou com um token de uma reivindicação anterior, é descartado como
`unknown`. A linha não muda de estado.

*Por quê:* o token é a prova de que quem está ACKando é quem puxou. Sem ele, qualquer ACK com um
`CMD-…` adivinhado fecharia a linha — e o `id` sai no log e na tela do painel do site.

### 3. Comando expirado NÃO executa

`expiresAt < agora` ⇒ **não execute**; ACK `refused` + `COMMAND_EXPIRED`.

*Por quê:* o site também filtra o expirado antes de entregar, mas **dois relógios é o certo**. Entre
o `claim` e o RCON há backoff real: uma conexão de RCON que falha, um retry, um lock de operação
segurando. Por isso o agent precisa de um **teto local próprio** por cima do `expiresAt`:

> *"não executo o que puxei há mais de 60 s"* — mesmo que o `expiresAt` ainda permita.

O caso que isso mata é o pior de todos: o admin clica "Reiniciar", nada acontece, ele resolve o
problema de outro jeito, e **quarenta minutos depois** o comando velho reinicia um servidor cheio.

### 4. Um comando por vez, por servidor

Operação já rodando ⇒ ACK `refused` + `AGENT_BUSY`. **Nunca enfileire localmente.**

*Por quê:* a fila é do site — é lá que ela é visível, cancelável e auditada. Uma segunda fila aqui
dentro é uma fila que ninguém vê, que some no `pm2 restart`, e que ressuscita ordens que o admin já
desistiu de dar. A trava por recurso do `ops/service.ts` continua sendo a autoridade; este canal só
a respeita e diz por quê.

### 5. `kind` desconhecido ⇒ `refused` + `UNKNOWN_KIND`

**Nunca ignore em silêncio.**

*Por quê:* o comando ignorado fica pendurado até expirar, e o admin não sabe por quê — vê
"enfileirado" por dois minutos e depois "expirado", sem causa. Com o ACK, ele vê na hora que este
agent não conhece aquele kind, que é exatamente o sintoma de **site novo contra agent velho**.

### 6. Duas batidas: `accepted` no claim, `executed`/`failed` no desfecho

*Por quê:* sem o `accepted`, o painel do site não distingue **"o agent não viu"** de **"está
rodando"** — os dois parecem "enfileirado" na tela, e levam a lugares opostos: o primeiro é
diagnóstico de pareamento, o segundo é esperar. O `operationId` no `executed` é o que liga a linha
do site ao log local.

### 7. ⚠️ Dedup local PERSISTENTE — grave em disco ANTES de executar

Grave o `commandId` **em disco** (SQLite, junto do resto) **antes** de mandar o comando, e recuse um
id já visto.

> ####  ISTO É O QUE FAZ O *AT-MOST-ONCE* SOBREVIVER A UM RESTART  ####
>
> Sem esta linha, o desenho inteiro tem um buraco: o agent puxa `CMD-…`, executa o `server-restart`,
> e **o processo do agent cai junto** — antes do ACK. Ele volta, o site não recebeu ACK nenhum, e o
> que acontece depois depende de uma decisão do site que o agent não controla. Com o id em disco, o
> agent sabe que já executou aquilo e ACKa, em vez de repetir. Memória não serve: `pm2 restart`
> apaga.

### 8. O agent nunca re-executa por conta própria

Comando puxado é comando **consumido**. Falhou? ACK `failed` com `reason`, e acabou. Quem decide
tentar de novo é o admin, no site, gerando um `CMD-…` novo.

*Por quê:* um retry local transforma "reiniciar uma vez" em "reiniciar até dar certo", que é a forma
mais rápida conhecida de derrubar um servidor em laço.

### 9. `clock skew` é fato, não hipótese

O site manda `expiresAt` **absoluto** e `ttlMs` **relativo**. **Use o menor dos dois**:

```
prazo = min(expiresAt − relógio_local, agora_local + ttlMs, agora_local + 60_000)
```

*Por quê:* o beacon já convive com uma tolerância de **±120 s** entre os dois relógios, e o retrato
do servidor descarta um `at` fora de ±10 min marcando `agentClockSkewed`. Ou seja: skew de minutos
entre esta máquina e o site **é medido, e acontece**. Confiar só no `expiresAt` faz um relógio
atrasado executar comando vencido; confiar só no `ttlMs` faz uma resposta que demorou na rede valer
mais do que devia. O menor dos dois resolve os dois casos.

### 10. Config é ESTADO, não tarefa — e não tem TTL

Compare `version`; se for nova, aplique pelo caminho que o `PATCH /api/servers/:id` já usa
(`supervisor.updateSettings`, `core/src/http/routes/servers.ts:235`) e ACKe **aquela** versão, com o
`requiresRestart` **real** que o `updateSettings` devolveu. Campo que falhar vai em `errors[]`, e a
config **não** é reaplicada em laço.

*Por quê:* comando é uma ordem que envelhece — "reinicie agora" perde o sentido em dois minutos.
Config é uma descrição do mundo — "este servidor tem 200 slots" continua verdade amanhã. Dar TTL a
ela criaria um servidor que volta sozinho para uma config antiga porque o ACK se perdeu; e
reaplicar em laço um campo que falha grava o `.ini` a cada 30 s, para sempre.

> ####  ARMADILHA MEDIDA: `updateSettings` IGNORA CAMPO QUE NÃO CONHECE  ####
>
> `supervisor.updateSettings()` percorre o patch e faz `if (key === undefined) continue`
> (`core/src/servers/supervisor.ts:591`) — **campo desconhecido não gera erro; ele desaparece**. Um
> `desired` com um campo que este agent não sabe gravar volta `applied: true`, `errors: []`, e o
> site conclui que a config está valendo. **O agent tem de conferir o `desired` contra a lista de
> campos que ele grava ANTES de chamar `updateSettings`**, e mandar o que sobrou em `errors[]`.

---

## 4 — A allowlist tem TRÊS kinds, e este agent conhece OITO

**A allowlist do site tem exatamente três**, por decisão do dono em **03/09/2026**:

| `kind` | O que faz |
|---|---|
| `server-start` | sobe o servidor |
| `server-stop` | derruba salvando |
| `server-restart` | derruba e sobe |

**Este agent conhece oito** (`core/src/ops/operations.ts:22-42`). Os **cinco** que sobram continuam
existindo — e continuam disparáveis — **só pelo painel local**:

| `kind` | Por que não vem pelo site |
|---|---|
| `server-install` | baixa 6 GB e reescreve a pasta; é operação de quem está na máquina |
| `server-update` | idem, e tem caminho próprio com aviso aos jogadores |
| `server-auto-update` | é agendamento local, não ordem pontual |
| `oxide-install` | reescreve arquivos com o servidor parado |
| `wipe-run` | **apaga o mundo** |

> ####  `wipe-run` E RCON CRU NUNCA VIRÃO POR ESTE CANAL  ####
>
> **Nunca.** `wipe-run` não se dispara nem por `POST /operations` aqui dentro: a pré-condição em
> `core/src/ops/service.ts:302-320` recusa qualquer chamada que não venha de `POST /wipe/runs`, que
> por sua vez exige o `identity` **digitado** e uma `Idempotency-Key`. Uma rota remota não tem como
> exigir nenhuma das duas. **E RCON cru também não vem** — "execute este texto no meu servidor" é
> execução remota arbitrária com outro nome; o que atravessa este canal é um `kind` de uma lista
> fechada, e nada mais.
>
> Quem implementar o lado de cá **não deve** aceitar um kind fora dos três só porque o agent sabe
> executá-lo. A regra 5 existe para isso: kind fora da lista é `refused` + `UNKNOWN_KIND`.

**E o `kinds` do retrato nunca autorizou nada.** O `POST /api/agent/server/status` manda a lista dos
oito (`core/src/site/status.ts`) para o site desenhar o menu. Se alguém do outro lado escrever
`if (kinds.includes('wipe-run')) permitir(...)`, o defeito está nessa linha — e a allowlist de três
é a defesa.

---

## 5 — O site NÃO chama o agent, e não vai chamar

Repetido aqui porque quem ler **só este documento** vai ser tentado a propor um webhook — "seria tão
mais simples o site avisar quando tem comando". As três razões estão medidas no código do site e
continuam de pé:

1. **`agents.base_url` é fixada no PRIMEIRO beacon e nunca mais atualizada.** O site faz
   `baseUrl: agent.baseUrl || baseUrl` dentro do `if (!created)` (`agent-public.routes.ts:113`). Um
   IP residencial que mude quebra o canal **para sempre**; o conserto é apagar a linha do agent e
   deixá-lo se registrar de novo.
2. **O endereço é HTTP puro montado do IP do socket** — `http://<ip>:<porta>`
   (`agent-public.routes.ts:68`). Sem TLS e sem hostname.
3. **A máquina fica atrás do NAT de uma conexão residencial.** Nada entra.

Um canal de push por comando falharia **sempre**, e o sintoma seria "o botão Reiniciar não faz nada"
— sem nada dizendo por quê. O pull de 10 s custa 6 req/min e não tem nenhuma dessas três condições.

---

## 6 — Onde isso encaixa no código de hoje

Nada abaixo existe; é o mapa de onde as peças novas se encostam no que já está aqui.

| Peça nova | Se apoia em | Que já faz |
|---|---|---|
| o laço do claim | `core/src/site/deliveries.ts` | o molde inteiro de laço-que-puxa: cliente injetável, validação do que chega, ACK em lote, paginação |
| o executor | `core/src/ops/service.ts` | as pré-condições (`:255-300`) e o `start({ kind })` que devolve a operação |
| o `operationId` do ACK | `core/src/ops/operations.ts` | o registro, o log incremental e a trava por recurso |
| o laço da config | `core/src/site/status.ts` | já tem o relógio de 30 s por pareamento, o `health` e o tratamento das famílias de 403 |
| a gravação da config | `core/src/servers/supervisor.ts:544` (`updateSettings`) | a tradução campo→`.ini` num lugar só, a escrita única e o `requiresRestart` |
| o dedup persistente | `core/src/db/migrations.ts` | o molde de migração numerada; a tabela nova é uma linha por `commandId` visto |
| os headers e o transporte | `core/src/site/client.ts` | o `SiteClient`, com `fetchImpl` injetável e os headers do §5.1 |

---

## 7 — A tradução de erro: o código interno NÃO é o `reason` do contrato

Esta é a armadilha mais provável deste trabalho, e ela é **medida**: os códigos que o
`ops/service.ts` lança **não** são os `reason` do contrato. Dois deles têm nomes diferentes para a
mesma coisa, e um `catch` que repasse `err.code` cru manda para o site um valor fora do vocabulário
fechado.

| Situação | `ApiError` que sai daqui | `reason` do contrato |
|---|---|---|
| `server-start` com o servidor no ar | `SERVER_ALREADY_RUNNING` (`ops/service.ts:271`) | **`SERVER_RUNNING`** |
| `server-stop`/`restart` com o servidor parado | `SERVER_NOT_RUNNING` (`:279`) | `SERVER_NOT_RUNNING` |
| RCON mudo no stop | `RCON_UNAVAILABLE` (`:292`) | `RCON_UNAVAILABLE` |
| comando sem resposta | `RCON_TIMEOUT` (`rcon/errors.ts:10`, `:39`) | `RCON_TIMEOUT` |
| jogo fora do disco | `SERVER_NOT_INSTALLED` (`servers/supervisor.ts:469`) | **`NOT_INSTALLED`** |
| servidor desabilitado no `.ini` | — | `SERVER_DISABLED` |

**A tradução mora num ponto só**, no módulo novo, e o que não estiver no mapa vira `failed` **sem**
`reason` — nunca um `reason` inventado. Um valor fora do vocabulário fechado é 400 do lado do site,
e um 400 num ACK deixa a linha pendurada.

---

## 8 — Critérios de aceite

Os três são verificáveis por uma pessoa, com um relógio, contra o site de dev.

### 8.1 O caminho feliz

**Um `server-restart` disparado no painel do site sai de *enfileirado* em ≤10 s e chega a
*concluído*.**

Como conferir: clique em Reiniciar no painel do site, com o servidor no ar. Em ≤10 s a linha vira
*executando* (é o ACK `accepted`). Quando o servidor voltar, ela vira *concluído* (ACK `executed`) e
carrega um `operationId` que existe em `GET /api/operations/<id>` **deste** agent, com o log da
operação.

### 8.2 O expirado NÃO executa

**Um comando deixado expirar volta `refused`/`COMMAND_EXPIRED` e NÃO reinicia o servidor quando o
agent voltar.**

Como conferir: pare o agent. Dispare um restart no painel. Espere o comando expirar. Suba o agent. O
servidor **não** pode reiniciar, e a linha no site tem de mostrar `refused` com `COMMAND_EXPIRED` —
não "expirado sem resposta". Este é o teste que prova a regra 3 e o teto local de 60 s ao mesmo
tempo.

### 8.3 A config volta com o `requiresRestart` real

**Uma config gravada com `map` novo volta `applied: true` com `requiresRestart: ["map"]`.**

Como conferir: grave um mapa diferente na tela de config do site. Na volta seguinte do laço, o
`.ini` daqui tem o `SERVER_LEVEL` novo, o ACK carrega `applied: true` e `requiresRestart` contendo
`"map"`, e o painel do site diz que só vale no próximo start. O mundo carregado **não** muda de mapa
— e é justamente isso que a lista serve para dizer.

> **Um quarto, que não é de contrato mas fecha o desenho:** matar o agent **entre** o comando e o
> ACK, subir de novo, e conferir que o servidor **não** reinicia uma segunda vez. É a regra 7, e é a
> única que um teste de unidade não pega.

---

## 9 — O que ainda NÃO tem contrato

Registrado aqui porque escrever "está definido" o que não está é como as divergências de `skinId` e
`prefab` nasceram.

1. **Os `params` de cada kind.** O contrato diz que `params` é um objeto; **não diz o que vai dentro
   de cada um dos três kinds**. Para `server-start` e `server-restart`, hoje, vazio basta. O caso que
   precisa de resposta é o **`force` do `server-stop`**: aqui dentro ele existe
   (`ops/service.ts:286-297`) e ele **MATA o processo**, perdendo tudo desde o último save
   automático. Enquanto ninguém decidir, **o agent trata `params.force` como ausente** — um
   `RCON_UNAVAILABLE` vira `refused`, e quem quiser matar o processo faz isso no painel local,
   olhando para a máquina.
2. **O que o site faz com um comando que ficou sem ACK.** É decisão dele (expira? vira
   `needs_admin`?), e ela não muda uma linha deste lado — mas muda o que o admin vê, e vale estar
   escrito no manual do site.
3. **`error_code` das rotas 11-14.** As famílias de autenticação (400/401/403/404 de pareamento, 429
   `AGENT_RATE_LIMITED`, os dois 403 que não são ban) valem aqui como em todas as outras rotas do
   canal — a tabela do §23.5 do `Docs/20` continua sendo a lista fechada. Os códigos **específicos**
   destas quatro rotas nascem com a implementação do site e, até lá, caem na regra de ouro: **4xx com
   código desconhecido é `unavailable`, não `rejected`** — recuar, nunca fechar.

---

## 10 — O que foi construído

Escrito **depois** da implementação, em 03/09/2026, e só com o que está no código.

### 10.1 As peças

| Arquivo | O que é |
|---|---|
| `core/src/site/commands.ts` | o laço do claim: allowlist, prazos, dedup, tradução de erro, os dois ACKs |
| `core/src/site/config.ts` | o laço da config: `version`, `ETag`, a régua dos sete campos, o ACK |
| `core/src/db/site-commands-repository.ts` | o dedup persistente — `claim`, `finish`, `listClaimed`, `listUnacked` |
| `core/src/db/migrations.ts` | migração **037** `site-commands` (reserva registrada no `Docs/20` §15.0) |
| `core/src/site/client.ts` | as quatro rotas novas e o `ETag` no `SiteResult` |
| `core/src/db/meta-repository.ts` | `clear()`, para a pendência de ACK deixar de existir quando ela deixa de existir |
| `core/src/config.ts`, `.env.example` | `SITE_COMMANDS_ENABLED`, `SITE_COMMAND_POLL_MS`, `SITE_CONFIG_PULL_ENABLED`, `SITE_CONFIG_INTERVAL_MS` |
| `core/src/index.ts` | um laço de cada, por pareamento, ligado depois do supervisor e parado no shutdown |
| `core/test/site-commands.test.ts`, `core/test/site-config.test.ts` | 39 casos; a suíte inteira foi de 902 para **963** |

Nada foi duplicado: o comando vira `operationsOf(id).start({ kind })` — a mesma trava, o mesmo
log, o mesmo `operationId` do painel local — e a config passa pelo mesmo
`supervisor.updateSettings` do `PATCH /api/servers/:id`.

### 10.2 As quatro decisões que este documento deixou em aberto

| Decisão | Qual foi | Por quê |
|---|---|---|
| **`limit` do claim** | **1** por rodada | pedir 5 não é de graça: enquanto o primeiro roda, o excedente vira `AGENT_BUSY` — uma recusa que o **admin** tem de desfazer clicando de novo. Deixado na fila do site, o mesmo comando é entregue 10 s depois e **executa**. O agente ainda trata o lote maior, e o excedente é recusado com `AGENT_BUSY`, que é verdade |
| **De quando conta o teto de 60 s** | do instante da **resposta do claim** | ancorado em "agora", ele andaria junto com o relógio: a cada checagem o prazo se renovaria, e o teto **nunca cortaria nada**. O `ttlMs` conta do mesmo instante, pela mesma razão |
| **`errors[].code` da config** | `UNKNOWN_FIELD`, `INVALID_VALUE`, e o **código cru do `ApiError`** quando a gravação inteira falha | o contrato não fecha vocabulário para este campo (ao contrário do `reason`, que é fechado). Quando a escrita falha, o nome que interessa é o do erro real — `PORT_IN_USE` diz o que `WRITE_FAILED` não diria |
| **`NOT_INSTALLED`** | conferido **antes** do disparo | sem jogo em disco, `kinds()` devolve só `server-install`, e o erro que sairia seria `OPERATION_NOT_ALLOWED` — verdade que não diz nada a quem está do outro lado |

### 10.3 As três coisas que este lado NÃO faz

1. **Não re-executa.** Comando puxado é comando consumido, inclusive o que ficou em `claimed`
   depois de uma queda: na subida ele vira `indeterminate`, ACKa `failed` **sem** `reason` e nunca
   mais roda.
2. **Não inventa `reason`.** O que não está no mapa da §7 vira `failed` sem `reason` — e é por isso
   que a operação que falha carrega o `operationId` em vez de uma tradução da frase em português.
   Há uma peneira final imediatamente antes do fio (`sanitizeAck`): um `reason` fora do vocabulário
   — que só chegaria ali vindo de uma linha gravada por uma versão anterior — vira `failed` sem
   `reason`, porque um valor inválido é 400 **para o lote**, e aí o desfecho de um comando some por
   causa do carimbo de outro.
3. **Não reaplica config em laço.** A versão é gravada mesmo quando a gravação **falha**; sem isso o
   `.ini` seria reescrito a cada 30 s, para sempre, por um campo que nunca vai entrar.

### 10.4 O que continua faltando

- **As quatro rotas do site.** Enquanto elas não existirem, os dois laços tomam **404 sem
  `error_code`** e o registram uma vez a cada 10 minutos, por servidor — não acordam o beacon, não
  acendem nada e não custam nada além de 8 req/min por pareamento.
- **Os três critérios da §8**, que só uma pessoa com um relógio e o site de dev fecha.
- **A tela de diagnóstico.** `GET /api/site/status` ainda não mostra a saúde destes dois laços; a
  pergunta "por que o botão Reiniciar não fez nada?" continua se respondendo pelo log do agente.
- **`params`** (§9.1): enquanto ninguém decidir, `params.force` é tratado como **ausente**.

---

## Fontes

Tudo abaixo foi aberto e lido para escrever este documento.

**RustAgent — `F:/Projects/RustAgent`**

| Arquivo | Para quê |
|---|---|
| `core/src/ops/operations.ts` | os oito `OPERATION_KINDS`, a trava e o registro |
| `core/src/ops/service.ts` | as pré-condições, os `ApiError` de cada recusa, as duas recusas do wipe |
| `core/src/servers/supervisor.ts` | `updateSettings`, `RESTART_KEYS`, o `KEY_OF` e o `continue` do campo desconhecido |
| `core/src/http/routes/servers.ts` | o `PATCH /servers/:id`, o `patchSchema` e o uso do `requiresRestart` |
| `core/src/rcon/errors.ts` | `RCON_TIMEOUT` |
| `core/src/site/status.ts`, `core/src/site/deliveries.ts`, `core/src/site/client.ts` | os laços que já existem, e o molde dos novos |
| `Docs/20-INTEGRACAO-OZCOIN-AGENT.md`, `Docs/21-STATUS-PARA-O-AGENTE-DO-SITE.md` | o contrato, os headers, a tabela de tradução de erro |

**Site OrigemZ — `F:/Projects/OrigemZSite/ad_oz_backend`**

| Arquivo | Para quê |
|---|---|
| `src/modules/agent-public/agent-public.routes.ts` | as três razões do pull (`:68`, `:113`) |
| `src/modules/admin/adminPermissions.ts` | `rust-config` e `rust-players` em `SENSITIVE_CAPABILITIES` (`:89`) |
| `src/modules/admin/admin.routes.ts` | o bloco `/rust/*` de hoje — e a ausência de qualquer rota de comando ou config |
