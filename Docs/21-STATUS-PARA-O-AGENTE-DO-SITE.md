# 21 — O lado agent está pronto: o que isso muda para o site

> **Para quem é.** Para quem implementa o lado **site** da integração OzCoin, guiado por
> `F:/Projects/OrigemZSite/docs/mateuus/rust/docs/INTEGRACAO-OZCOIN-RUST.md`.
>
> **O que ele diz.** O lado **RustAgent está implementado e verde** — 886 testes, lint e
> build limpos. Este documento existe para responder três perguntas suas: *o contrato
> mudou?*, *o que eu preciso entregar?* e *o que exatamente o agente manda no fio?*
>
> **⚠️ Atualização de 04/09/2026 — o §9 é o que mudou.** Este documento nasceu dizendo
> *"nenhuma linha deste código falou com o servidor de vocês"*. **Falou.** A §9 conta o que
> a primeira sonda do cliente real contra o dev encontrou: o canal funciona, e **três
> divergências** apareceram na primeira rodada. O resto deste documento é de 02/09/2026 e
> continua valendo — leia o §9 primeiro.
>
> **O que ele NÃO era.** Todo teste daqui falava com um dublê que devolve o que o manual
> `Docs/20` diz que o site responde. Era o risco número um. Hoje existe
> `contracts/oz-rust-fixtures.json`, com os corpos **medidos**, consumido pelos testes deste
> repositório — e ainda por nenhum dos de vocês.
>
> **Onde estão as três frentes, em 02/09/2026.** O RustAgent está **pronto e verde**
> (890 testes). O painel do site, pelo relato de quem o fez, também (595 testes). O
> **backend — a Parte A — não começou**: `admin-rust.controller.ts` não existe, não há
> rotas `/api/admin/rust/*`, os modelos `AgentDelivery` e `AgentShopMirror` não existem,
> e `rust` não aparece em `gamePlugins.ts` nem em `deliveryTypes.ts`.
>
> **Dois dos três lados estão prontos e parados no mesmo lugar.** O que falta é uma
> coisa só, e ela é o gargalo de tudo.
>
> **Data:** 02/09/2026; §9 e o cabeçalho, 04/09/2026. **Contrato:** `oz-rust/5`.

---

## 1 — A resposta curta: o contrato NÃO mudou

**`oz-rust/1` continua valendo, byte a byte.** Nada do que atravessa o fio foi alterado:

| O que atravessa | Estado |
|---|---|
| Os **três** valores de ACK (`delivered`, `failed`, `deferred`) — e não há um quarto | intacto |
| O vocabulário fechado de `reason`, incluindo `AGENT_INDETERMINATE` | intacto |
| O payload de entrega (`skinId` **string**, `prefab` com **ponto legal**, `amount` 1..100 000) | intacto |
| Os `error_code` da tabela de tradução | intacto |
| `referenceId` = `rust:<serverId>:loja:<purchaseId>`, teto 113, `:refund` no estorno | intacto |
| O `cursor`/`next` da fila, opaco dos dois lados | intacto |

A regra do §23 diz que, a partir do primeiro commit de implementação, qualquer mudança
na seção do contrato sobe para `oz-rust/2` nos dois arquivos. **Esse commit aconteceu, e
a seção não mudou** — então a etiqueta continua `oz-rust/1` nos dois. Daqui em diante ela
vale de verdade: existe código que pode ficar para trás.

O que mudou foi **só do lado de cá**, e está na §2.

---

## 2 — A mudança que te afeta: N pareamentos, e não um

O manual §22.10(c) recomendava parear **um** servidor na fase 1. **O dono escolheu N
desde já.** Cada servidor de Rust é um `Server` seu, com bearer próprio, lido de
`Configs\<id>.ini` no agente.

**Isso não muda nenhum contrato** — cada pareamento fala o mesmo protocolo, com o próprio
`X-Server-Id` e o próprio bearer. Você já modela um agent por `Server`, então funciona sem
nenhuma linha nova. **Mas muda duas contas suas:**

| O quê | Antes | Agora |
|---|---|---|
| Bearers vivos por máquina de Rust | 1 | **N** (um por servidor de Rust daquele agente) |
| Pico de requisições contra o site | ~91 req/min | **~91 × N** — o `AGENT_RATE_LIMIT_PER_SERVER` é por `serverId`, então o teto por linha continua certo; o que cresce é o total no seu Postgres |
| `requires_signed_beacon` | uma linha | **uma por servidor**, ligada pelo `/activate` de cada um |

E uma coisa **sumiu**: o `SITE_LOCAL_SERVER_ID`. Com N pareamentos, a pergunta "qual
servidor local recebe esta entrega?" não existe — a fila veio do bearer daquele servidor,
então ela já sabe. Se o seu manual cita essa variável, ela pode sair.

---

## 2-bis — MUDANÇA DE FLUXO: quem gera o bearer

**O dono decidiu que quem gera o token é o PAINEL DO AGENTE, e o site confirma.** Isso
inverte o §2.4 do manual (*"aqui só o site gera segredo"*) — e a boa notícia é que **o
precedente já é seu**.

### Não é um pedido novo: é o que o Conan já faz

`admin-conan.controller.ts:196-215` está escrito assim, com todas as letras:

> `POST /api/admin/conan/servers/:serverId/activate  { token }`
> *"Ativa o painel colando o token que ele gerou no card «Acesso remoto & API»."*

Ele recebe `{ token }` no corpo, exige **mínimo de 16 caracteres**, e grava
`bearerHash: hashSecret(token)` + `bearerEnc: encrypt(token)`, com
`isEnabled: true, status: 'active'`. **O `/activate` do Rust é esse mesmo, e nada mais.**

### O que já está pronto deste lado

O painel do agente tem `POST /api/servers/:id/site/token`: ele sorteia
`randomBytes(32).toString('base64url')` — **43 caracteres**, bem acima do seu mínimo de 16
—, grava no `.ini` daquele servidor, e o devolve **uma única vez**. Nenhum `GET` do agente
devolve o token, nem agora nem depois. O admin copia da tela e cola no seu cadastro.

`base64url` de propósito: ele viaja num `Authorization: Bearer` e num `.ini` lido por um
`for /f` do cmd.exe, e nenhum dos dois gosta de `+`, `/` ou `=`.

### ####  A ARMADILHA: NÃO COPIE O TESTE DO CONAN  ####

O `activate` do Conan **grava e só depois testa de verdade, com rollback se o teste
falhar**. O teste é `GET /server/<sid>/playersOnline` — ou seja, **o site chama o painel de
volta**.

**Isso não funciona no Rust, e o desenho inteiro existe por causa disso.** As três razões
estão no §2.3 do manual e foram medidas no seu próprio código: `agents.base_url` é fixada
no primeiro beacon e nunca mais atualizada; o endereço é HTTP puro montado do IP do
socket; e a máquina fica atrás do NAT de uma conexão residencial. **Nada entra no
RustAgent.** Um `/activate` que tente o ping de volta vai falhar sempre, dar rollback
sempre, e o sintoma será "o token não ativa" — sem nada dizendo por quê.

**A confirmação que funciona é o beacon.** Grave o `bearerHash`, ponha `status: 'active'`,
e o próximo beacon (10 s) prova as três coisas de uma vez: o agente está vivo, o token
confere e o `serverId` existe. Se você ligar `requires_signed_beacon` junto, o beacon
assinado prova o bearer **sem nenhuma chamada de volta** — é o mesmo teste do Conan, feito
do lado certo.

### O que muda no seu lado, em uma linha

Onde o seu manual disser "o site gera o bearer e mostra na tela", leia "o site **recebe** o
bearer que o painel do agente gerou". O corpo é `{ token }`, como o do Conan.

---

## 3 — O que o site precisa entregar

Em ordem de gravidade. **Os três primeiros quebram a fase 1 inteira**; o resto degrada.

### Bloqueantes

| # | O quê | Sem isso |
|---|---|---|
| 1 | **Interpretar `reason: 'AGENT_INDETERMINATE'`** num ACK `deferred`: mover a tarefa de `pending` para `review`, deixar o `inventory_item` em `processing`, tirá-la de `/deliveries/pending`, e filtrar `status='pending' AND last_reason <> 'AGENT_INDETERMINATE'` na varredura de expiração | **entrega dupla em 30 dias.** O agente já ACKa assim hoje — está implementado e testado deste lado |
| 2 | **`skinId` como string de dígitos** no payload de entrega | **toda** entrega de item e kit vira `PAYLOAD_INVALID`. Meu schema recusa `number`, e o teste guarda isso |
| 3 | **`prefab` no alfabeto `/^[a-z0-9._-]{1,64}$/`** — o **ponto é legal** | o resgate recusa o **nome exato** de um veículo ambíguo, e o `sedan` certo fica incadastrável (`sedan` resolve para `sedanrail.entity`, o vagão de trilho) |

### As cinco rotas que não existiam

> ####  ✅ ELAS EXISTEM — MEDIDO EM 04/09/2026  ####
>
> Esta tabela é de 02/09/2026 e ficou vencida. A sonda da §9 falou com quatro das cinco e
> todas responderam (`/ozcoins/transaction`, `/deliveries/pending`, `/shop/mirror/version`,
> e o `/shop/mirror` está provado pelo espelho já gravado do lado de vocês). A única não
> exercitada é `/deliveries/ack`, e de propósito: uma sonda que ACKa fecha entrega de gente
> de verdade. A tabela fica como registro do que faltava.

Sem elas, o que já está escrito aqui não roda. A loja in-game **funciona sem as cinco** —
o que morre é reconciliação, fila e espelho.

| Rota | O agente já a consome em | Sem ela |
|---|---|---|
| `GET /api/agent/ozcoins/transaction` | `PurchaseSettler` (relógio de 60 s) + o botão `.../settle` | não há prova: uma compra indeterminada só fecha repetindo o débito, que **cobra quem já desistiu** |
| `GET /api/agent/deliveries/pending` | `SiteDeliveries`, a cada 15 s e ao ver alguém conectar | o que o jogador compra no site nunca chega no jogo |
| `POST /api/agent/deliveries/ack` | idem | idem |
| `POST /api/agent/shop/mirror` | `CatalogMirror`, a cada 60 s | o painel do site não vê a loja do Rust |
| `GET /api/agent/shop/mirror/version` | idem | 2 MiB atravessam a rede a cada volta do relógio |

### Os cinco ajustes no `/ozcoins/debit`

O agente **não assume que eles subiram** — ele funciona hoje, com perdas nomeadas.

| # | Ajuste | Sem ele |
|---|---|---|
| 1 | repassar `productId` ao `applyOzMutation` (o helper **já aceita**) | o ledger grava `product_id = NULL` |
| 2 | guard de replay por produto | o guard fica cego |
| 3 | `error_code` nas validações de entrada | todo 400 vira o mesmo `rejected` genérico |
| 4 | **estruturar o 422**: `INSUFFICIENT_BALANCE` + `balance`/`required`/`missing` como **number** | o `insufficient` do agente carrega `balance: null`, e a tela mostra só a frase |
| 5 | `error_code: 'OZ_MUTATION_FAILED'` no 500 | o 500 fica sem nome no log |

### Os dois que já foram aceitos

`REFERENCE_NOT_MINE` separado de `REFERENCE_NOT_FOUND` na rota de prova, e a rota
`POST /api/admin/rust/deliveries/:deliveryId/release`. **O agente já trata os dois** —
`REFERENCE_NOT_MINE` como `unprovable` (terminal, sai do laço), e a rota de release ele
nem conhece: o efeito dela chega como `unknown` no ACK seguinte.

---

## 4 — O que o agente MANDA, exatamente

Copiado do código, não do manual. Use para validar seus schemas.

### Headers de toda rota autenticada

```
Authorization: Bearer <o bearer daquele servidor>
X-Server-Id: <o SITE_SERVER_ID daquele servidor>
Accept: application/json
User-Agent: OrigemZ-Rust-Agent/1.0.0
Content-Type: application/json     (só nos POST)
```

**O `Idempotency-Key` NÃO é enviado** — a idempotência viaja no corpo, como `referenceId`.
Há um teste que falha se ele voltar.

### Débito

```json
POST /api/agent/ozcoins/debit
{
  "steamId": "76561198000000000",
  "amount": 250,
  "referenceId": "rust:RUST01:loja:p2n8x4q9zk1a",
  "observacao": "Loja in-game: Kit Metal x1",
  "productId": "kit-metal"
}
```

`amount` é **inteiro positivo** sempre — o sentido é da rota. `observacao` já vem
truncada em 500 daqui. `productId` é omitido quando o `offer.id` passa de 100 chars (sem
o campo a compra passa; com um id comprido ela tomaria 400 e fecharia).

**O corpo nunca carrega `balance`, `ozBalance` nem `epBalance`** — o `validateBalanceChange`
de vocês mataria o request com um 403 sem código.

### Estorno

Idêntico, em `/credit`, com `referenceId` = `<referência da compra>:refund` e **sem**
`productId`. Repetir com a mesma chave é seguro, e o agente conta com isso: é assim que
ele insiste num estorno que falhou por timeout.

### Beacon

```json
POST /api/agent/beacon
{
  "serverId": "RUST01",
  "port": 8787,
  "version": "1.0.0",
  "mac": "a4:bb:6d:11:22:33",
  "capabilities": ["ozcoins", "shop", "deliver_item", "players_online", "pull_delivery"]
}
```

Sem `Authorization` e **sem `X-Server-Id`** — o `serverId` vai no corpo. Com token, ele
leva `X-Agent-Timestamp` (epoch em **segundos**) e `X-Agent-Signature` =
`HMAC-SHA256(bearer, "<serverId>|<timestamp>")` em hex. **O agente assina sempre que tem
token**, mesmo que vocês ainda não exijam — se não exigirem, os dois headers são ruído.

**Nunca mandamos IP.** Ele é o do socket, e vocês o fixam no primeiro beacon.

### ACK de entrega

```json
POST /api/agent/deliveries/ack
{
  "deliveries": [
    { "id": "DLV-9f3a1c2b7e04", "status": "delivered", "at": "2026-09-02T14:00:00.000Z" },
    { "id": "DLV-1c77a0b93de5", "status": "deferred", "reason": "PLAYER_SLEEPING", "at": "…" },
    { "id": "DLV-04e9c5183ba6", "status": "deferred", "reason": "AGENT_INDETERMINATE", "at": "…" }
  ]
}
```

Até **50** por lote, um lote por página. Há um teste que percorre todos os ACKs enviados e
falha se algum `status` sair dos três.

**A lista fechada de `reason` que pode sair daqui**, medida no código:

- adiam (`deferred`): `PLAYER_NOT_FOUND`, `PLAYER_DEAD`, `PLAYER_SLEEPING`, `INVENTORY_FULL`,
  `DROP_FAILED`, `PLAYER_OFFLINE`, `PRESENCE_UNAVAILABLE`, `RCON_UNAVAILABLE`,
  `VEHICLE_NO_SPACE`, `AGENT_INDETERMINATE`;
- falham (`failed`): `ITEM_NOT_FOUND`, `TOO_MANY_STACKS`, `INVALID_AMOUNT`, `PAYLOAD_INVALID`,
  `UNKNOWN_VIP_TIER`, `GIVE_UNREADABLE`, `VIP_GRANTER_UNAVAILABLE`, e qualquer outro
  `VEHICLE_*`.

Note o duplo prefixo em `VEHICLE_VEHICLE_NOT_FOUND` — é feio e é o que sai: o agente
prefixa o código cru do plugin de veículo com `VEHICLE_`.

### Fila

`GET /api/agent/deliveries/pending?limit=50` e, na página seguinte, `&cursor=<next>`.
Até **5 páginas por rodada**, 4 rodadas por minuto. Uma rodada disparada por conexão de
jogador começa **do topo**, com o cursor zerado.

### Espelho

`POST /api/agent/shop/mirror` com o snapshot inteiro, recusado **aqui** acima de 2 MiB.
A `version` é `sha256` do corpo canônico **sem** `version` e **sem** `generatedAt` — se
`generatedAt` entrasse, o catálogo atravessaria a rede a cada minuto. `offer.items[]`,
`vip` e `vehicle` **não viajam**: no lugar deles vai `itemCount`.

---

## 5 — Como o agente lê as suas respostas

A tabela de tradução do §4.2 virou código, e é a **lista fechada** que decide tudo. Os
pontos onde uma escolha sua muda o desfecho:

| Você responde | O agente conclui |
|---|---|
| **422** | saldo insuficiente. A frase vai **crua** para o jogador |
| **409** | reuso de referência — e `charged` preenchido significa que **o dinheiro saiu**. A compra fecha e vai para conferência humana; ele **nunca** gera id novo |
| **400** com código conhecido, ou sem código nenhum | defeito nosso: `rejected`, e nunca repetido com o mesmo corpo |
| **400 com um `error_code` que o agente não conhece** | `unavailable` — ele **recua**, não desiste. É de propósito: no dia em que vocês criarem um código novo, errar para `rejected` mataria cada compra tentada, uma por uma, em silêncio |
| **401/403/404** de pareamento, e **403 `AGENT_IP_NOT_ALLOWED`** | `unavailable`/`pairing`: a loja diz INDISPONÍVEL, e o beacon é acordado na hora |
| **403** com corpo em texto contendo `error code: 1010` | a borda recusou o User-Agent. **Não é ban**, e o agente continua |
| **403** JSON com a chave `banId` | ban de verdade: ele **para de beaconar** |
| **5xx**, timeout, DNS, TLS | **`unknown`** — pode ter cobrado. A compra fica aberta e o relógio a resolve com prova |
| **200 sem `success: true`** | **`unknown`**, nunca sucesso: um 200 que não dá para entender pode ter cobrado |

Na rota de prova, dois recortes que custam dinheiro se saírem errados:

- **400** (`INVALID_STEAM_ID` / `INVALID_REFERENCE_ID`) é **terminal**: a compra sai do
  laço. Como retentável, o settler bateria todo minuto para sempre.
- **500** (`TRANSACTION_LOOKUP_FAILED`) é **retentável**: a compra continua indeterminada
  e a volta seguinte resolve. Como terminal, mandaria para conferência humana o que se
  resolveria sozinho.

---

## 6 — O que já está implementado aqui

| Peça | Arquivo | O que faz |
|---|---|---|
| `SiteClient` | `core/src/site/client.ts` | as 9 rotas, `fetchImpl` injetável, e o **único** lugar do repo que fala `moedas`/`observacao` |
| `SiteWallet` | `core/src/store/site-wallet.ts` | a tabela de tradução em código, com os cinco desfechos |
| `SiteBeacon` | `core/src/site/beacon.ts` | batimento de 10 s, HMAC, e as três famílias de 403 |
| `SiteDeliveries` | `core/src/site/deliveries.ts` | pull, validação, reserva-antes-do-comando, ACK e paginação |
| `PurchaseSettler` | `core/src/store/settle.ts` | o relógio de 60 s, com os dois tetos (60 rodadas / 6 h) |
| `CatalogMirror` | `core/src/store/catalog-mirror.ts` | um catálogo, N destinos, com versão por servidor |
| migrações **035/036** | `core/src/db/migrations.ts` | `charge-unknown` + `reference`/`site_transaction_id`/`delivery`; e `site_deliveries` |
| a tela do site | painel → servidor → **Config → Site OrigemZ** | três blocos: o **endereço** do site (global), o **pareamento** deste servidor (id + bearer, com o botão que GERA), e o **estado** — pareamento, último beacon com o `error_code` cru, saúde da carteira e compras presas |

E a `RemoteWallet` antiga foi **apagada** — ela falava `/wallet/{steamId}` com
`Idempotency-Key` no header e lia 409 como saldo insuficiente. Nenhum servidor jamais
respondeu isso.

---

## 7 — Como testamos juntos

O que eu **não posso** fazer daqui: o agente de produção roda noutra máquina, e nenhum
teste deste repositório fala com a internet.

1. **Você me diz quando uma rota nova estiver no ar no dev** (`https://devsite2.origemz.com`).
2. Eu rodo o `curl` do §5 do manual contra ela e comparo com o que meus dublês devolvem.
3. Onde divergir, **a §23.1 desempata**: formato dos ids é seu; tipo e régua dos campos de
   entrega é meu (as réguas já existem no código do agente); `error_code` é seu;
   vocabulário de `reason` é meu.

**O artefato que fecharia o buraco de verdade** — e que nenhum dos dois tinha — é um
arquivo de **fixtures compartilhado**: os corpos de requisição e resposta das rotas,
versionado num lugar só, consumido pelos testes dos dois repositórios.

✅ **Ele existe desde 04/09/2026:** `F:/Projects/RustAgent/contracts/oz-rust-fixtures.json`,
com o `README.md` ao lado explicando o pacto. Cada resposta traz um `origin`, e ele é a
coisa mais importante do arquivo: `observed` é **copiado de uma resposta real do dev**;
`manual` é o que a prosa descreve e **ninguém confirmou**. Os testes deste repositório já o
consomem (`core/test/site-fixtures.test.ts`, 13 casos que alimentam o `SiteClient` de
verdade com os corpos do arquivo). **Falta o lado de vocês consumi-lo.**

E os passos 1 e 2 acima aconteceram: **a §9 conta o que a primeira sonda achou.**

---

## 8 — Três perguntas que continuam sem resposta

Elas travam a **virada**, não o código — e nenhuma é derivável de repositório nenhum:

1. Existe a linha `games.id = 'rust'` no banco de **produção**? Não há seed nem migration
   dela no repositório — só um comentário afirmando que "Rust e Zomboid já estão lá".
2. Qual o `serverId` de cada servidor de Rust no site? Ele casa por texto **exato**,
   maiúsculas incluídas, e o 404 que a diferença produz não diz que ela é de caixa.
3. Qual host serve `/api/agent` em produção?

Há também uma **incoerência que registro sem poder consertar**: a allowlist de IP guarda
só as rotas **novas**. O `/ozcoins/debit` é antigo e fica de fora. Numa troca de IP
residencial, o agente **continua cobrando** e para de conferir — a fila e a reconciliação
morrem em silêncio. Cobrar sem conferir é a pior metade das duas. Ou o guard vale para
todas as rotas do agente, ou não vale para nenhuma na fase 1.

---

## 9 — O que a PRIMEIRA sonda contra o dev mostrou (04/09/2026)

O passo 1 da §7 aconteceu: em **04/09/2026** o cliente real deste agente — o mesmo
`SiteClient` de produção, com os mesmos headers, o mesmo timeout e o mesmo parsing — falou
com `https://devsite2.origemz.com`, pareado como `RUST01`. A ferramenta é
`npm run site:probe -w core`; ela grava os dois lados do fio e **nunca** debita, credita,
ACKa entrega alheia nem sobrescreve o espelho.

**Dezessete idas à rede. O canal funciona.** Beacon, retrato, fila de comandos, fila de
entregas, versão do espelho, saldo e prova de transação: todos responderam, e o que voltou
casa com o contrato. Os corpos estão em `contracts/oz-rust-fixtures.json`, marcados como
`observed`.

### 9.1 As três divergências

Nenhuma delas teria sido pega por teste nenhum dos dois lados. É exatamente o risco número
um, medido.

| # | O que o manual dizia | O que atravessa | Quem desempata (§23.1) | O que eu fiz |
|---|---|---|---|---|
| 1 | `version` é um inteiro que só cresce | **`version: 0` com `desired: null`** para servidor sem config — e o ACK dessa versão volta **`400 CONFIG_INVALID_VERSION`, "version precisa ser um inteiro ≥ 1"** | **você**: a régua da versão é do site | o agente passou a ler `version < 1` como **ausência**, e a ficar em silêncio no caso "sem config" |
| 2 | o ACK de comando responde `{ ok, applied, unknown[] }` | **`{ ok, results: [{ commandId, applied, status, outcome }] }`** | **você**: o formato da sua resposta é seu | o agente lê **as duas formas**; até ontem, uma recusa sua chegava aqui como sucesso, e o desfecho do comando sumia sem uma linha de log |
| 3 | `GET /server/config` responde **304** ao `If-None-Match` | **200 sempre**, com `Cache-Control: no-store`, mesmo com o `ETag` idêntico | **você** | nada: o ramo do 304 existe, está correto e é barato. O que não acontece é a economia — hoje o corpo inteiro atravessa a cada 30 s, por servidor |

**A nº 1 é a que quase custou caro.** Se um dia vier `version: 0` com um `desired`
preenchido, o agente de ontem aplicaria, gravaria a versão zero e o ACK dela tomaria 400 a
cada 30 segundos, para sempre — um laço que só pararia com alguém lendo log.

### 9.2 As duas ausências, e elas não são divergência

- **`GET /api/agent/config/:domain` e o ACK dele (rotas 15 e 16) não existem aí**: 404 HTML
  nos três assuntos (`store`, `kits`, `vips`). Deste lado está pronto e **desligado por
  padrão** (`SITE_DOMAIN_PULL_ENABLED=0`) — ver o §23.11 do `Docs/20`.
- **`GET /server/config` devolve `desired: null`** porque ninguém configurou o `RUST01` no
  site ainda. **O `desired` de verdade, com os 23 campos, continua sem ter sido visto por
  nenhum dos dois lados** — é a próxima coisa a sondar, e basta você gravar uma config lá.

### 9.3 Duas curiosidades que anotei sem mexer em nada

- **`restartRequiring`** vem no corpo de `GET /server/config`, com 20 campos. Ele é
  informativo e não é lido aqui: quem **mede** o `requiresRestart` é o agente, no retorno da
  gravação. Duas fontes para o mesmo fato divergem na primeira vez que uma delas errar.
- **`GET /ozcoins/balance` de um SteamID que não existe** devolve `{"moedas":"0","exists":true}`.
  O agente **ignora `exists` de propósito** desde sempre (`store/site-wallet.ts`), então não
  muda nada aqui — mas se alguma tela sua contar com esse campo para saber se a conta
  existe, ela está contando com um `true` constante.

### 9.4 O que fica combinado

1. As respostas marcadas `observed` no `contracts/oz-rust-fixtures.json` são **fato**, com
   data. As marcadas `manual` são o que a prosa diz e **ninguém confirmou** — cada uma é uma
   divergência esperando acontecer. Quem sondar e confirmar, troca o `origin`.
2. **Consuma o arquivo nos seus testes.** Enquanto ele for lido por um lado só, ele é
   documentação — não trava nada.
3. Grave uma config de servidor no dev e me avise: a próxima sonda compara o `desired` real,
   campo a campo, com a tabela do §23.11.
