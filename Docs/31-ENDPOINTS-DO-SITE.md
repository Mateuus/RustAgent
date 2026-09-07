# 31 — Os endpoints do site: o canal `/api/agent` e o que ele espera

> **Para quem é.** Quem implementa o RustAgent e precisa falar com o OrigemZSite.
>
> **O que ele diz.** Quais rotas existem no canal, quais são do Rust, como autenticar, quais
> limites valem de verdade, e o ciclo de vida completo de uma entrega.
>
> **O que ele NÃO é.** Não é referência campo a campo de cada corpo — essa já existe e está
> mapeada na §8. E não é a API do painel local: **`06-API.md` é o painel do agent
> (`127.0.0.1:8787`), não o site.** É o engano mais comum de quem chega.
>
> **Data:** 05/09/2026 · **Contrato:** `oz-rust/7`
>
> **Árbitro em caso de conflito**, nesta ordem:
> `contracts/oz-rust-fixtures.json` (corpos medidos) > `Docs/20` §23 > este documento.
> Este doc não é fonte da verdade — ele é a porta de entrada e o mapa.

---

## 0 — Índice

| § | Assunto |
|---|---|
| 1 | A regra maior: mão única |
| 2 | O mapa em uma tela |
| 3 | As 33 rotas em três baldes |
| 4 | Autenticação |
| 5 | Limites: rate limit e tamanho de corpo |
| 6 | Ciclo de vida de uma entrega |
| 7 | Idempotência: a chave de cada caminho |
| 8 | Onde está o detalhe campo a campo |
| 9 | O que nesta pasta está obsoleto |
| 10 | Lacunas e divergências conhecidas |
| 11 | Checklist de implementação |

---

## 1 — A regra maior: mão única

```
####  O SITE NUNCA CHAMA O AGENT. O AGENT SEMPRE CHAMA O SITE.  ####
```

Não é convenção, é ausência de código: uma varredura por `fetch(` / `axios` nos serviços de Rust,
nos controllers do canal e nos controllers de admin do site devolve **zero**. O cliente de saída do
projeto (`services/agentClient.ts`) existe, mas todos os seus consumidores são de DayZ e Conan.

A prova mais forte está no VIP: em `services/workers/vipDeliveryWorker.ts`, o ramo do Rust **não
chama o agent** — ele enfileira em `agent_deliveries` e espera. E `services/gamePlugins.ts` declara
para o Rust `itemCatalogSource: 'agent_push_mirror'`.

**O que isso molda:** tudo é PULL ou PUSH partindo de você. Entrega é fila que você puxa. Catálogo
de itens é snapshot que você empurra. Loja in-game é espelho que você empurra. Config é um
`desired` que você busca e confirma.

**Se você está procurando "o endpoint onde o site me avisa", ele não existe — e não é esquecimento.**

---

## 2 — O mapa em uma tela

| | |
|---|---|
| Base | `https://<site>/api/agent` |
| Rotas no prefixo | **33** — 3 públicas + 30 autenticadas |
| Que o Rust usa hoje | **21** (20 privadas + o beacon) |
| Disponíveis e ainda não usadas | **2** — `/invalidate` e `/self-delete` (§3, balde C) |
| De outros jogos, ignore | **10** (§3, balde B) |
| Auth | `Authorization: Bearer <TOKEN>` + `X-Server-Id: <SERVER_ID>` |
| HMAC | **Não existe.** Ficou para a v2. Só o beacon tem assinatura, e é outro mecanismo |
| Content-Type | `application/json` obrigatório nos POST |
| Teto de corpo | **10 MB** — o `64kb` que aparece no router é letra morta, e isso foi testado (§5.2) |
| Erros | Ramifique por **`error_code`**, nunca pela frase de `error` |

---

## 3 — As 33 rotas em três baldes

### Balde A — do Rust. Implemente.

| # | Rota | Finalidade |
|---|---|---|
| 1 | `POST /beacon` | pareamento (público, assinado) |
| 5 | `GET /ozcoins/transaction` | consulta de transação |
| 6 | `GET /deliveries/pending` | **puxa a fila de entregas** |
| 7 | `POST /deliveries/ack` | **confirma o que entregou** |
| 8 | `POST /shop/mirror` | empurra o espelho da loja in-game |
| 9 | `GET /shop/mirror/version` | pergunta barata: mudou? |
| 10 | `POST /server/status` | retrato do servidor (~30 s) |
| 11 | `POST /commands/claim` | reserva comandos da fila |
| 12 | `POST /commands/ack` | confirma comandos |
| 13 | `GET /server/config` | config desejada do servidor |
| 14 | `POST /server/config/ack` | confirma a config aplicada |
| 15 | `GET /config/:domain` | config de rede (`store` · `kits` · `vips`) |
| 16 | `POST /config/:domain/ack` | confirma o domínio aplicado |
| 17 | `POST /vip/mirror` | espelho de VIP |
| 18 | `GET /vip/mirror/version` | mudou? |
| 19 | `POST /items/mirror` | **empurra o catálogo de itens do jogo** |
| 20 | `GET /items/mirror/version` | mudou? |
| 21 | `POST /items/images` | empurra ícones (lote) |

Todas, menos o beacon e as duas de `deliveries`, têm **`requireRustServer`**: se o `X-Server-Id`
não for de um servidor Rust, respondem **400** com um `error_code` terminado em
`_GAME_NOT_SUPPORTED`.

⚠️ **`/deliveries/pending` e `/deliveries/ack` não têm essa trava** — é divergência conhecida e está
anotada no código do site. Elas filtram por `serverId` e nada mais. Para você é inócuo (a fila
daquele servidor é sua), mas **não espere `*_GAME_NOT_SUPPORTED` delas**.

### Balde B — existem no canal, são de outro jogo. Ignore.

| Rota | Dono | O código recusa Rust? |
|---|---|---|
| `POST /vip/grant` | DayZ | **Sim** — 400 `VIP_MIGRATION_GAME_NOT_SUPPORTED` |
| `GET /shop/version` | Conan | **Sim** — 400 `SHOP_GAME_NOT_SUPPORTED` |
| `GET /shop/catalog` | Conan | **Sim** |
| `POST /shop/purchase` | Conan | **Sim** |
| `GET /cosmetics/inventory` | DayZ | **Não** — ver aviso |
| `GET /cosmetics/list` | DayZ | **Não** |
| `POST /cosmetics/grant` | DayZ | **Não** |
| `POST /cosmetics/revoke` | DayZ | **Não** |
| `POST /cosmetics/purchase` | DayZ | **Não** |
| `GET /cosmetics/export` | DayZ | **Não** |

⚠️ **As 6 de `cosmetics/*` não são bloqueadas — são apenas não usadas.** O controller não tem trava
de jogo nenhuma, então um agent de Rust autenticado recebe resposta normalmente. O que as exclui é
o fluxo: elas substituem JSONs dos **mods do DayZ**, e o site declara para o Rust
`isCosmeticDeliveryType: () => false`. **Não implemente.**

⚠️ **`POST /vip/grant` engana pelo nome: não é o VIP do Rust.** O VIP de Rust anda por duas outras
portas — a fila de entregas (`kind: "vip"` e `"vip_revoke"`) e a config de rede (`:domain = vips`).

### Balde C — genéricas. Você usa, com ressalva.

| # | Rota | Ressalva |
|---|---|---|
| 2 | `GET /ozcoins/balance` | (a) (b) (c) |
| 3 | `POST /ozcoins/debit` | (a) (b) (c) **(d)** |
| 4 | `POST /ozcoins/credit` | (a) (b) (c) |
| — | `POST /invalidate` | (e) — existe, você ainda não chama |
| — | `POST /self-delete` | (e) — existe, você ainda não chama |

- **(a)** Sem trava de jogo — rodam em produção com o DayZ também.
- **(b)** **Sem rate limit nenhum** (§5.1).
- **(c)** **A carteira é global do jogador, não por jogo.** O `referenceId` é UNIQUE no site
  inteiro, então colisão com uma referência do DayZ é possível. **Prefixe sempre as suas** — o
  padrão medido é `rust:RUST01:loja:<aleatorio>`.
- **(d)** 🔴 **`debit` confia no `amount` que você mandar.** Ela não consulta preço nenhum. Ou seja:
  **no Rust, quem é dono do preço é o agent, não o site.** É diferente do `shop/purchase` do Conan,
  que tira o preço do catálogo.
- **(e)** Genéricas de agent, sem trava de jogo. Funcionam; use com cuidado.

---

## 4 — Autenticação

**Rotas privadas** — os dois headers, sempre:

```http
Authorization: Bearer SEU_TOKEN_AQUI
X-Server-Id: RUST01
Content-Type: application/json
```

O site compara o token contra um hash guardado, com comparação time-safe. **Não há HMAC** — o
código diz textualmente que ficou para a v2. Se alguma doc desta pasta promete assinatura em rota
privada, ela está desatualizada.

**O beacon é o único com assinatura própria**, e é público (não leva Bearer). Ele é o mecanismo de
pareamento: o agent se anuncia, e o admin ativa colando o token no painel.

> Todos os valores de token, id e hash neste documento são **fictícios**. Nunca cole credencial real
> em documentação.

---

## 5 — Limites: rate limit e tamanho de corpo

### 5.1 Rate limit — 7 contadores, e 13 rotas sem contador nenhum

`/api/agent` é **isento do limitador global** do site. O único freio é o que está montado rota a
rota. Todos os buckets: **janela de 60 s**, **chave = `serverId`** (não o IP), contadores
independentes que não somam entre si.

| Teto/min | Cobre |
|---|---|
| **240** | `ozcoins/transaction`, `deliveries/pending`, `deliveries/ack`, `shop/mirror`, `shop/mirror/version` |
| **30** | `server/status` |
| **60** | `commands/claim`, `server/config`, `server/config/ack` |
| **120** | **só** `commands/ack` — o dobro, e a assimetria é deliberada |
| **60** | `config/:domain`, `config/:domain/ack` |
| **60** | `vip/mirror`, `vip/mirror/version` |
| **60** | `items/mirror`, `items/mirror/version`, `items/images` |

O 429 devolve `{"error": "...", "error_code": "AGENT_RATE_LIMITED"}` mais headers `RateLimit-*`.
**Não há `Retry-After` configurado explicitamente** — use `RateLimit-Reset`.

```
####  429 É TRANSITÓRIO. RECUE E TENTE NA VOLTA SEGUINTE — NUNCA DESCARTE A TAREFA.  ####
```

🔴 **As 13 rotas pré-Rust não têm bucket** (`ozcoins/balance|credit|debit`, `cosmetics/*`,
`vip/grant`, `shop/version|catalog|purchase`). Como o canal é isento do limitador global, ali **não
existe teto**. Note a assimetria: `ozcoins/transaction` **é** limitada, mas `balance`, `credit` e
`debit` **não são**. Não presuma simetria.

### 5.2 Tamanho de corpo — o teto de 64 KB é letra morta

O router privado declara `express.json({ limit: '64kb' })`. **Ele não limita nada**, e isso foi
verificado com requisição real, não por leitura de código:

| Corpo enviado | Resposta |
|---|---|
| 200 KB | **401** — passou pelo parser, parou na autenticação |
| 11 MB | **413** `request entity too large` |

A causa: o site monta um `express.json({ limit: '10mb' })` global **antes** das rotas do agent. O
body-parser marca o request como já lido, e o segundo parser é ignorado. **O teto real do canal é
10 MB.**

Isso importa muito para `items/mirror` e `items/images`: **os ícones em base64 passam**. Não
escreva fatiamento por causa dos 64 KB.

**Mas cada rota confere o seu próprio teto no controller, e esses valem:**

| Rota | Teto próprio |
|---|---|
| `items/mirror` | 1 MiB · 1 a 3000 itens · **snapshot inteiro, não fatiável** |
| `items/images` | 512 KB · lote de 1 a 50 · cada `data` ≤ 64 KB em string, ≤ 32 KB decodificado |

**Como saber de onde veio o 413:** com `error_code` é régua da rota; **sem `error_code`, é o parser
global**.

**Ícones, a conta real:** um ícone típico do Rust tem ~1,7 KB, então 50 cabem em ~115 KB
tranquilamente. No pior caso legal (32 KB por arquivo), o teto de 512 KB do corpo morde antes do
lote de 50 — cabem ~11. **Dimensione pelo tamanho do corpo, não pela contagem.** O site responde
quanto ainda falta em `missingImages[]` / `missingImageCount`; use isso para fechar o laço.

⚠️ **O site valida os bytes, não o `contentType`.** O ícone precisa ser WebP de verdade — PNG é
recusado mesmo declarando `image/webp`.

---

## 6 — Ciclo de vida de uma entrega

É a peça central do canal. Se só uma seção for lida, que seja esta.

### 6.1 Os seis estados

```
                 ┌──────────► delivered    (ACK "delivered")
                 │
   pending ──────┼──────────► failed       (ACK "failed")
                 │
                 ├──────────► expired      (TTL venceu, item volta ao jogador)
                 │
                 ├──────────► review       (ACK "deferred" + reason AGENT_INDETERMINATE)
                 │
                 └──────────► needs_admin  (5 falhas no mesmo source_ref)
```

```
####  SÃO SEIS ESTADOS, NÃO QUATRO. TRATAR SÓ 4 DEIXA TAREFA PRESA.  ####
```

- **`review`** é a saída honesta para "não sei se entreguei". A tarefa sai da fila com o item
  preservado, **sem** incrementar `attempts`, e o relógio de expiração **nunca mais a toca**.
- **`needs_admin`** é o freio contra laço infinito: cinco falhas no mesmo item e um humano decide.

### 6.2 TTL e `attempts`

- **TTL de 30 dias**, gravado em `expires_at` na criação. Exceções: `vip_revoke` e `needs_admin`
  nascem **sem** prazo.
- **`attempts` sobe +1 apenas no ACK `deferred` comum.** Não sobe em `delivered`, `failed`,
  `AGENT_INDETERMINATE`, nem em tarefa já em `review`.

```
####  attempts CONTA VOLTAS SUAS, NÃO EXECUÇÕES.  ####
```

Um jogador ausente por 30 dias leva o contador a seis dígitos sem nada de errado. **Nunca use
`attempts` como alarme, ordenação ou filtro.**

⚠️ **E o contador do site é o ÚNICO que existe** — medido em 05/09/2026 e registrado no
[34](34-CONFIRMACAO-DO-EVENTO-DE-CONCLUSAO.md) §1.1. No RustAgent, o portão de presença roda
**antes** da reserva: um `PLAYER_OFFLINE` volta sem tocar o banco local, de propósito. Uma entrega
real acumulou **429 `attempts` no site** e **`attempts: 1` no agent** — as voltas são do agent, mas
quem as conta é o site.

**Consequência prática, e ela já causou um diagnóstico errado:** ao investigar uma entrega lenta,
o número de voltas só existe do lado do site. Quem olhar só o banco do agent vai ver uma tentativa
e concluir que o agente esteve desligado — foi exatamente o que aconteceu, e a conclusão era falsa.

### 6.3 `delivered` vence `expired`

Se o ACK de entrega chegar depois de a tarefa ter expirado, **o `delivered` ainda ganha**. É a única
exceção da regra de estado terminal, e a razão é direta: o item entrou no jogo, então não pode ser
devolvido ao jogador de novo — seria duplicata.

### 6.4 Como você puxa

`GET /deliveries/pending` — **sem lock e sem claim**, de propósito.

- `limit` default 50, teto 100. Valor acima do teto é **clampado**, não recusado.
- Cursor opaco, escopado ao seu `serverId`.
- Teto de corpo de 1 MiB que **encurta a página** em vez de devolver erro.

```
####  A FILA É at-least-once. A IDEMPOTÊNCIA É SUA.  ####
```

Se você morrer entre puxar e dar ACK, a tarefa **volta** na próxima volta. Isso é desenho, não
falha: melhor entregar duas vezes do que perder.

### 6.5 O que você recebe

`kind` ∈ `item` · `kit` · `vip` · `vehicle` · `vip_revoke`
`id` no formato `DLV-` + 12 hex.

Exemplo real, medido em 05/09/2026 — kit com 5 AK + 500 munição, ACK em 8 segundos:

```json
{
  "id": "DLV-5b9cf2b0731a",
  "kind": "kit",
  "payload": {
    "items": [
      { "shortname": "rifle.ak",   "amount": 5,   "skinId": "0" },
      { "shortname": "ammo.rifle", "amount": 500, "skinId": "0" }
    ]
  }
}
```

⚠️ **`skinId` está SEMPRE presente e é STRING**, normalizado para `"0"` quando não há skin. Escreva
o parser esperando os três campos.

### 6.6 O ACK

```json
{ "deliveries": [
    { "id": "DLV-9f3a1c2b7e04", "status": "delivered", "at": "2026-09-04T14:00:00.000Z" },
    { "id": "DLV-1c77a0b93de5", "status": "deferred",  "reason": "PLAYER_SLEEPING" },
    { "id": "DLV-04e9c5183ba6", "status": "deferred",  "reason": "AGENT_INDETERMINATE" }
] }
```

- **Lote de 1 a 50.** Fora disso: 400 `INVALID_ACK_BODY`.
- **`status` ∈ `delivered` · `failed` · `deferred`, e só.** Um quarto valor **derruba o lote
  inteiro** com 400 `INVALID_ACK_STATUS`.
- `reason` é texto livre, truncado em 200 chars. **Um único valor tem significado semântico:
  `AGENT_INDETERMINATE`**, que manda a tarefa para `review`.
- `at` é auditoria sua — quem carimba o horário oficial é o relógio do site.

**Resposta, sempre 200 quando o lote é bem-formado:**

```json
{ "ok": true, "applied": 2, "unknown": ["DLV-04e9c5183ba6"] }
```

⚠️ **`unknown` NÃO significa "não foi entregue".** Significa "não pude aplicar neste request": id
inexistente, id de outro servidor, ou ACK sobre estado já terminal. **Se um id seu voltar em
`unknown` e a sua linha local disser `delivered`, carimbe como confirmado e mantenha a linha.** É o
que o site espera.

---

## 7 — Idempotência: a chave de cada caminho

| Caminho | Chave de dedupe |
|---|---|
| Fila de entregas | o `id` (`DLV-…`). Repetir ACK é seguro: o segundo cai em `unknown` |
| `GET /pending` | leitura pura, repetir não tem efeito |
| Movimento de OZ Coins | `referenceId`, **UNIQUE no site inteiro** — prefixe com `rust:<serverId>:` |
| `kind: vip` | trava extra: uma tarefa aberta por concessão. Duplicata seria prazo pago em dobro |
| `vip_revoke` | dedupe por `grant:<id>` |
| Espelhos (loja/VIP/itens) | `version` — pergunte antes de empurrar |

Do lado do site existe uma invariante de banco: **no máximo uma tarefa aberta por item**. Não é
unique total de propósito — item que voltou ao jogador por falha definitiva pode ser resgatado de
novo.

---

## 8 — Onde está o detalhe campo a campo

Este doc é o mapa. O corpo de cada rota já está escrito:

| Assunto | Onde |
|---|---|
| Rotas 1-9 campo a campo, headers, timeouts | `Docs/20` §5 |
| Desfechos do dinheiro, `referenceId`, reconciliação, estorno | `Docs/20` §4, §6, §11, §12 |
| Contrato e regra de sincronia (`oz-rust/7`) | `Docs/20` §23 |
| Rotas 11-14 e as regras de *at-most-once* | `Docs/22` |
| Rotas 15-16 e os 23 campos do `desired` | `Docs/23-CONFIG-PELO-SITE.md` |
| Rotas 19-21 (corpo, limites, correções) | `Docs/29` |
| Variáveis de ambiente do canal | `Docs/20` §16 |
| **Corpos medidos — o árbitro** | `contracts/oz-rust-fixtures.json` |

**Rotas 17-18 (`vip/mirror`) não têm referência campo a campo em lugar nenhum** — nem aqui, nem no
repositório do site. Ver §10.

---

## 9 — O que nesta pasta está obsoleto

Verificado contra o código do site em 05/09/2026. **Não confie nestes trechos:**

| Onde | Afirma | Realidade |
|---|---|---|
| `Docs/20`, cabeçalho | *"Do lado do RustAgent, nada disto existe na árvore"* | Existem `site-wallet.ts`, `settle.ts`, `catalog-mirror.ts`, `beacon.ts`, `client.ts` e mais seis módulos. O corpo do doc traz ✅ por toda parte — **é o cabeçalho que ficou para trás** |
| `Docs/20` §23.9 | *"As quatorze rotas"* | São 21 as do contrato. A seção está sete atrás |
| `Docs/20` §23.7 | descreve as fixtures como inexistentes | `contracts/oz-rust-fixtures.json` existe, e a errata da §23.9 já o elege árbitro. Duas mensagens opostas na mesma seção |
| `Docs/21`, cabeçalho | *"o backend não começou, `admin-rust.controller.ts` não existe"* | Existe, com 21 rotas de painel admin. **É o doc mais perigoso da pasta**, porque o título promete "status" |
| `Docs/22`, cabeçalho | *"não havia `commands/claim` nem `server/config` no ar"* | Datado de 03/09; existem e foram medidos em 04/09 |
| `contracts/README.md` | *"as 16 rotas do canal"* | As fixtures cobrem 16; faltam 5 (§10) |

Este documento **não conserta** esses arquivos — apenas avisa. Corrigi-los é trabalho à parte.

---

## 10 — Lacunas e divergências conhecidas

**Cinco rotas sem fixture, e são as mesmas cinco sem referência campo a campo:**
`vip/mirror`, `vip/mirror/version`, `items/mirror`, `items/mirror/version`, `items/images`.

**O buraco de documentação e o de contrato medido são o mesmo buraco.** Ali o contrato nunca foi
sondado — trate com desconfiança e meça antes de assumir.

**Duas fixtures existentes vão quebrar quem copiar** (ambas marcadas `manual`, então nenhum teste as
reprova):

| Fixture | Mostra | O código exige |
|---|---|---|
| `leaseToken` | `"b7c1cafe"` (8 chars) | `^[0-9a-f]{32}$` — copiar dá `invalid_lease` e o comando nunca fecha |
| resposta de `commands/ack` | `{applied, unknown[]}` | **`results[]`** — a outra forma é a do ACK de *entrega* |

**Outras divergências medidas:**

- `exists` saiu da resposta de `GET /ozcoins/balance` — desserializador estrito quebra.
- O **304 do `GET /server/config` não acontece** (a resposta é `no-store`, por causa da senha de
  RCON). Guarde o ETag fora do cache HTTP.
- `reason` fora da lista fechada **não** dá 400 no ACK de comando: vira `UNRECOGNIZED:<valor>`.

**Limites do desenho atual — não são bugs, mas você precisa saber:**

- **Não existe fatiamento** para catálogo acima de 3000 itens ou 1 MiB.
- **`ozcoins/debit` confia no `amount`** — o site não valida preço no Rust.
- **VIP vitalício não passa pela fila** (`RUST_VIP_LIFETIME_UNSUPPORTED`): o prazo é obrigatório.
  Vitalício só pelo canal de config de rede.

---

## 11 — Checklist de implementação

A ordem que funciona, cada passo apoiado no anterior:

1. **Pareamento** — `POST /beacon`; o admin ativa colando o token no painel.
2. **Guarde `Bearer` + `X-Server-Id`** e mande os dois headers em toda rota privada.
3. **Trate `error_code`, nunca a frase.** Classifique cada um como transitório (recua e repete) ou
   permanente (não repita): 429 e 5xx são transitórios; 400 de contrato é permanente.
4. **Fila de entregas** (`pending` → executar → `ack`), laço de ~15 s. Trate os **seis** estados,
   idempotência pelo `id`, e `unknown` como "já resolvido", não como falha.
5. **Retrato do servidor** (`server/status`), ~30 s.
6. **Espelhos** (loja, VIP, itens): pergunte `version` antes de empurrar snapshot.
7. **Ícones** em lotes dimensionados pelo corpo, fechando o laço por `missingImages[]`.
8. **Comandos e config**: `claim` → aplicar → `ack`, respeitando o *at-most-once* do `Docs/22`.
9. **OZ Coins**: prefixe todo `referenceId` com `rust:<serverId>:`.

---

*Escrito em 05/09/2026 a partir do código do site, não de documentação anterior. Onde este documento
discordar de outro desta pasta, verifique contra `contracts/oz-rust-fixtures.json` e contra o código
— foi assim que as divergências da §9 e da §10 apareceram.*
