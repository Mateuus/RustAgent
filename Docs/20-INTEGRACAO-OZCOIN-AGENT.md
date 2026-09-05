# 20 — Integração OzCoin: o RustAgent e o site OrigemZ

> **O que este documento é.** O manual de implementação do lado **RustAgent** da
> integração com o site OrigemZ: o saldo de OzCoin passa a morar no site, a loja
> in-game passa a cobrar lá, o que o jogador compra no site passa a ser entregue
> dentro do jogo, e a loja do agente passa a ser visível no painel do site. Ele
> traz o contrato campo a campo, o código novo em esqueleto, o diff dos arquivos
> alterados, as migrações, as variáveis de ambiente, os testes obrigatórios e a
> ordem de implementação. Depois de lê-lo, dá para escrever o código inteiro sem
> abrir mais nada.
>
> **O que este documento NÃO é.** Não é relato de coisa construída. Do lado do
> RustAgent, **nada disto existe na árvore** — o que existe é uma `RemoteWallet`
> que fala com um servidor que nunca respondeu. Do lado do site, quatro rotas
> deste contrato **precisam ser criadas** e uma precisa de três ajustes aditivos;
> esse trabalho é de outro documento e de outra pessoa. O apêndice separa, item a
> item, o que foi **medido no código**, o que foi **conferido em documentação** e
> o que é **projeto**.
>
> **Convenção de nomes.** Identificadores, campos de payload, comandos e nomes de
> arquivo em inglês; comentário, texto de tela e mensagem ao operador em
> português — a regra da casa (`core/src/logger.ts:4-5`). As duas exceções são
> `moedas` e `observacao`: elas são **contrato de terceiro**, o site as expõe
> assim, e renomeá-las quebraria a integração. Elas atravessam a fronteira do
> RustAgent num ponto só — `core/src/store/site-client.ts` — e daí para dentro o
> nome é nosso.
>
> **Etiqueta do contrato em uso: `oz-rust/7`** (04/09/2026). Ela está aqui, no
> alto, de propósito: é a PRIMEIRA ocorrência da string neste arquivo, e é ela
> que o `grep -Eom1 'oz-rust/[0-9]+'` da §23 devolve quando alguém compara os
> dois manuais. As menções a `oz-rust/6` e anteriores, mais abaixo, são
> **histórico** — o que mudou em cada etiqueta, e não onde estamos.

---

## 0 — Índice

| § | Assunto |
|---|---|
| [1](#1--em-uma-página) | Em uma página: o que muda, para quem, e o que **não** muda |
| [2](#2--o-contrato-em-uma-frase-e-o-desenho-do-canal) | O contrato em uma frase, e o desenho do canal |
| [3](#3--as-20-divergências-entre-a-remotewallet-e-o-site-real) | As 20 divergências entre a `RemoteWallet` e o site real |
| [4](#4--o-protocolo-de-dinheiro-os-cinco-desfechos) | O protocolo de dinheiro: os cinco desfechos |
| [5](#5--o-contrato-http-que-o-agent-consome) | O contrato HTTP que o agent consome, endpoint por endpoint |
| [6](#6--a-convenção-de-referenceid) | A convenção de `referenceId` |
| [7](#7--identidade-do-jogador) | Identidade do jogador |
| [8](#8--a-classe-sitewallet) | A classe `SiteWallet` |
| [9](#9--beacon-e-pareamento) | Beacon e pareamento |
| [10](#10--a-fila-de-entregas) | A fila de entregas (o que foi comprado no site) |
| [11](#11--reconciliação-do-unknown) | Reconciliação do `unknown` |
| [12](#12--estorno) | Estorno |
| [13](#13--push-do-catálogo-da-loja-in-game) | Push do catálogo da loja in-game |
| [14](#14--todas-as-mudanças-de-código-arquivo-por-arquivo) | Todas as mudanças de código, arquivo por arquivo |
| [15](#15--migrations-novas) | Migrations novas |
| [16](#16--variáveis-de-ambiente) | Variáveis de ambiente |
| [17](#17--segurança) | Segurança |
| [18](#18--observabilidade) | Observabilidade |
| [19](#19--testes) | Testes |
| [20](#20--ordem-de-implementação) | Ordem de implementação |
| [21](#21--critérios-de-aceite) | Critérios de aceite |
| [22](#22--perguntas-para-o-dono) | Perguntas para o dono (treze) |
| [23](#23--ponto-de-sincronia-com-o-manual-do-site) | **Ponto de sincronia com o manual do site** — a tabela que os dois documentos têm de ter idêntica |
| [—](#apêndice--o-que-foi-medido-o-que-foi-conferido-e-o-que-é-projeto) | Apêndice: medido × conferido × projeto |
| [—](#fontes) | Fontes |

---

## 1 — Em uma página

### 1.1 O que muda

**O dono do saldo deixa de ser o agente e passa a ser o site.** Hoje o OzCoin de
um jogador de Rust mora em `wallets.balance`, no SQLite do agente
(`core/src/db/migrations.ts:1355-1366`). Depois desta integração ele mora em
`users.ep_balance`, no Postgres do site, e o agente só consulta e movimenta lá.

Cinco coisas passam a existir no RustAgent:

| # | O quê | Onde |
|---|---|---|
| 1 | **`SiteWallet`** — a terceira implementação de `Wallet`, que fala `/api/agent/ozcoins/*` | `core/src/store/site-wallet.ts` (novo) |
| 2 | **Beacon** — o agente se anuncia ao site a cada 10 s e sabe dizer se está pareado | `core/src/site/beacon.ts` (novo) |
| 3 | **Fila de entregas** — o que o jogador comprou no site é puxado e entregue no jogo | `core/src/site/deliveries.ts` (novo) |
| 4 | **Reconciliação** — um relógio que fecha compras presas em `charge-unknown`, com prova | `core/src/store/settle.ts` (novo) |
| 5 | **Espelho do catálogo** — a loja in-game aparece no painel do site | `core/src/store/catalog-mirror.ts` (novo) |

E uma coisa **deixa** de existir: a `RemoteWallet` (`core/src/store/wallet.ts:144-311`,
com o banner de seção, a interface de opções e a constante de timeout)
é aposentada. Ela fala um contrato que nenhum servidor jamais respondeu, e não
tem um único teste.

### 1.2 Para quem

| Quem | O que ele nota |
|---|---|
| **O jogador dentro do Rust** | o número do cabeçalho passa a ser o mesmo do site; comprar OZ é no site; a frase de saldo insuficiente vira a **frase do site**, crua, com o caminho para comprar |
| **O jogador no site** | o que ele resgatar do inventário escolhendo um servidor de Rust chega no jogo — hoje não chega |
| **O admin no painel do agente** | uma tela nova de pareamento (`/api/site/status`), o extrato local marcado como HISTÓRICO, e o lançamento manual recusado com `409 WALLET_IS_REMOTE` (isso **já** acontece: `core/src/http/routes/store.ts:483-491`) |
| **O admin no painel do site** | a loja in-game do Rust aparece, somente leitura |
| **O suporte** | uma compra presa passa a ter estado próprio (`charge-unknown`), um botão (`.../settle`) e um relógio que a resolve sozinha na maioria das vezes |

### 1.3 O que NÃO muda

Isto é tão importante quanto a lista de cima, porque é o que impede a integração
de virar reescrita.

- **A interface `Wallet` continua sendo a fronteira.** Ela ganha dois desfechos
  novos e uma assinatura de entrada em objeto, mas continua sendo o único lugar
  onde alguém precisa saber de onde vem o dinheiro
  (`core/src/store/wallet.ts:1-13`).
- **A ordem da compra continua a mesma:** conferir espaço (só veículo) → cobrar →
  entregar → estornar se a entrega falhar. É o que
  `core/src/store/service.ts:14-39` já documenta, e é a ordem que "erra para o
  lado que tem conserto".
- **O veículo continua sendo a exceção conferida antes do débito**
  (`core/src/store/service.ts:240-250`).
- **O preço continua não passando pelo cliente.** A ação do CUI carrega
  `offerId` e `quantity`; o preço sai do banco do agente
  (`core/src/game/ui-store-screens.ts:1049-1051`).
- **O catálogo da loja in-game continua sendo do agente.** O site recebe um
  espelho somente-leitura. Migrar a propriedade do preço para o site é fase 2 —
  ver §22, pergunta 1.
- **O saldo local não é migrado.** `wallets` congela e vira histórico. É a
  decisão que o código já tomou por escrito
  (`core/src/store/wallet.ts:22-24`, `core/src/config.ts:236-238`): *"são
  carteiras diferentes, e somar uma na outra sem alguém mandar seria inventar
  dinheiro"*.
- **Nenhuma rota existente do agente muda de forma.** `GET /api/store/purchases`
  ganha um valor a mais no enum de `state` e dois campos no corpo;
  `POST /api/servers/:id/store/buy` ganha um status HTTP a mais (202). Nada é
  removido.
- **O site nunca chama o RustAgent.** Nenhuma porta nova é aberta na máquina do
  agente, nenhum HMAC precisa ser verificado, e o `AGENT_API_TOKEN` do agente
  continua sem sair daqui.

### 1.4 O interruptor

`SITE_BASE_URL` vazio = **nada disto acontece**: carteira local, sem beacon, sem
fila, sem espelho. Preenchido = o site é o dono. A virada é uma variável e um
restart, exatamente como `core/src/config.ts:233-241` já promete. É também o
botão de rollback do §20.

---

## 2 — O contrato em uma frase, e o desenho do canal

### 2.1 A frase

> **O site OrigemZ é o dono do dinheiro; o RustAgent é o dono do jogo. O canal é
> sempre `https://<site>/api/agent/*` com `Authorization: Bearer <SITE_TOKEN>` e
> `X-Server-Id: <SITE_SERVER_ID>`, e ele é sempre iniciado pelo agent.**

### 2.2 O desenho

```
   MÁQUINA DO SERVIDOR DE RUST                        SITE OrigemZ
   ┌──────────────────────────────┐                   ┌──────────────────────┐
   │  RustAgent (Node, :8787)     │                   │  Express + Postgres  │
   │                              │                   │                      │
   │  beacon        ──── 10 s ───────── POST ────────▶ /api/agent/beacon     │
   │  SiteWallet    ── no clique ────── GET/POST ────▶ /api/agent/ozcoins/*  │
   │  deliveries    ──── 15 s ───────── GET/POST ────▶ /api/agent/deliveries/*│
   │  settle        ──── 60 s ───────── GET ─────────▶ /api/agent/ozcoins/   │
   │                              │                   │            transaction│
   │  catalog       ──── 60 s ───────── GET/POST ────▶ /api/agent/shop/mirror│
   │                              │                   │                      │
   │        ◀── NADA ENTRA POR AQUI ──                │                      │
   └──────────────────────────────┘                   └──────────────────────┘
              │  RCON
              ▼
   RustDedicated + OrigemZAgent/OrigemZUI/OrigemZVip
```

Cinco relógios, todos saindo. Nenhuma entrada.

### 2.3 Por que o agent chama e o site nunca chama

O padrão que o site já tem com o DayZ e o Conan é bidirecional: o agente chama
`/api/agent/*` com bearer simples, e o site chama o agente de volta com HMAC. A
segunda direção **não sobrevive ao Rust**, por três razões medidas no código do
site:

**1. `agents.base_url` é fixada no PRIMEIRO beacon e nunca mais atualizada.**
`F:/Projects/OrigemZSite/ad_oz_backend/src/modules/agent-public/agent-public.routes.ts:113`
faz `baseUrl: agent.baseUrl || baseUrl` dentro do bloco `if (!created)`. Um IP
residencial que mude quebra o canal para sempre; o conserto é apagar a linha do
agent e deixá-lo se registrar de novo.

**2. O endereço é HTTP puro, montado do IP do socket.**
`agent-public.routes.ts:68`: `` const baseUrl = `http://${ip}:${Number(port) || 7001}` ``.
Sem TLS, sem hostname, e atrás do NAT de uma conexão residencial.

**3. A entrega no Rust exige o jogador ONLINE e VIVO.** O comando de entrega é
`origemz.give`, e ele responde `{"ok":false,"error":"PLAYER_NOT_FOUND"}`,
`PLAYER_DEAD` ou `PLAYER_SLEEPING` — os três medidos e traduzidos em
`core/src/kits/service.ts:646-667`. Um push síncrono chega quando o site quer,
não quando o jogador está lá; e não existe lugar nenhum, no desenho de push, onde
a tarefa espere.

Com **pull**, os três somem: o agente não precisa ser alcançável pela internet, o
endereço dele deixa de importar, e quem decide a hora da entrega é quem sabe se o
jogador está no servidor — o agente, que tem o `PresenceTracker`
(`core/src/players/presence.ts:164`).

O preço do pull é uma rota nova no site (a fila de pendências) e ele é barato. O
caminho de push fica registrado como fase 3 em §22, pergunta 3, com o custo
inteiro escrito.

### 2.4 O que o agente ganha de brinde

- O `AGENT_API_TOKEN` do agente **nunca é dado ao site**. Hoje, no fluxo do DayZ,
  o admin cola dois segredos do agente no site (`bearer` e `hmac`); aqui só o
  site gera segredo, e ele é colado no `.env` do agente.
- Nenhuma porta a mais aberta. `AGENT_HOST=127.0.0.1` continua servindo, e a
  recusa de exposição de `core/src/config.ts:731-753` continua valendo.
- Zero verificação de HMAC para escrever, testar e manter.
---

## 3 — As 20 divergências entre a `RemoteWallet` e o site real

Esta é a seção central do documento. A `RemoteWallet` de
`core/src/store/wallet.ts:177-311` foi escrita contra um contrato **imaginado**:
`GET/POST {base}/wallet/{steamId}[/debit|/credit]`, `Idempotency-Key` no header,
409 para saldo insuficiente. Nenhum servidor jamais respondeu essas rotas. O site
real tem `/api/agent/ozcoins/*` **em produção**, com DayZ e Conan, com lock de
linha, ledger auditado e tratamento de corrida no `23505`.

**O agent se adapta.** Criar `/wallet/{steamId}` no site seria uma segunda porta
para o mesmo ledger — exatamente a "duas verdades sobre débito" que
`F:/Projects/OrigemZSite/ad_oz_backend/src/modules/agent-private/ozCoinsMutation.ts:11-15`
foi escrito para eliminar. E foi para isso que a interface `Wallet` existe: a
troca de dialeto é a troca de UMA classe.

### 3.1 O quadro inteiro

| # | Divergência | Gravidade | Onde ela morre |
|---|---|---|---|
| [D1](#d1--o-caminho-das-rotas) | O caminho das rotas | **fatal** | 404 em toda chamada |
| [D2](#d2--x-server-id-não-é-mandado) | `X-Server-Id` não é mandado | **fatal** | 400 `MISSING_SERVER_ID` em toda chamada |
| [D3](#d3--idempotência-header-vs-campo-do-corpo) | Idempotência: header vs campo do corpo | **fatal** | 400 `referenceId obrigatório` |
| [D4](#d4--a-referência-não-tem-prefixo) | A referência não tem prefixo | **silenciosa, e a pior** | item de graça, resposta de sucesso |
| [D5](#d5--o-sufixo-do-estorno-é-credit-e-não-refund) | Sufixo do estorno `:credit` × `:refund` | média | teto de 120 chars mal dimensionado |
| [D6](#d6--saldo-insuficiente-é-422-e-409-significa-outra-coisa) | Saldo insuficiente: 409 × 422 | **fatal e invertida** | o desfecho mais perigoso lido ao contrário |
| [D7](#d7--o-saldo-vem-como-string-e-o-campo-não-é-balance) | O saldo vem como STRING, e não em `balance` | **fatal, silenciosa** | todo saldo lido como 0 |
| [D8](#d8--o-campo-ok-não-existe-e-ninguém-o-lê) | O campo `ok` não existe (e ninguém o lê) | baixa | divergência silenciosa |
| [D9](#d9--a-consulta-de-saldo-é-query-e-não-path) | Consulta de saldo: path × query | **fatal, silenciosa** | saldo 0 para todo mundo |
| [D10](#d10--400-de-validação-vira-retentável) | 400 de validação vira retentável | alta | retry eterno de pedido que nunca passa |
| [D11](#d11--401403404-de-pareamento-são-indistinguíveis-de-site-lento) | 401/403/404 = "site lento" | alta | loja "sem saldo" quando é pareamento quebrado |
| [D12](#d12--timeout-é-tratado-como-não-cobrou) | Timeout tratado como "não cobrou" | **a mais cara** | jogador cobrado e sem item, sem ninguém conferindo |
| [D13](#d13--saldo-desconhecido-vira-zero) | Saldo desconhecido vira ZERO | alta | modal esconde o botão de comprar |
| [D14](#d14--o-que-foi-comprado-não-chega-ao-ledger) | `productId` não chega ao ledger | alta | guard de replay cego |
| [D15](#d15--não-existe-teto-por-transação) | Sem teto por transação | alta | precedente medido: 60 milhões de OZ |
| [D16](#d16--o-timeout-não-é-escolhido-ele-é-derivado-do-plugin) | Timeout de 5 s no caminho do clique | média | menu travado, e `unknown` demais |
| [D17](#d17--um-middleware-global-do-site-mata-o-request) | `validateBalanceChange` mata o request | armadilha | 403 sem `error_code` que ninguém entende |
| [D18](#d18--reason-não-existe-no-site) | `reason` não existe no site | média | extrato do jogador sem texto |
| [D19](#d19--a-carteira-remota-não-tem-fetchimpl-nem-teste) | Sem `fetchImpl`, sem teste | alta | protocolo de dinheiro sem cobertura |
| [D20](#d20--exists-saiu-do-contrato) | `exists` **saiu do contrato** (era sempre `true`) | ✅ resolvida em `oz-rust/6` | ramificação por campo que nunca era falso |

### D1 — O caminho das rotas

**O que o agent assume.** `GET {base}/wallet/{steamId}`,
`POST {base}/wallet/{steamId}/debit`, `POST {base}/wallet/{steamId}/credit`
(`core/src/store/wallet.ts:165-176`, montados em `:192` e `:228`).

**O que o site faz.** `GET /api/agent/ozcoins/balance`,
`POST /api/agent/ozcoins/credit`, `POST /api/agent/ozcoins/debit` — as três
declaradas em
`F:/Projects/OrigemZSite/ad_oz_backend/src/modules/agent-private/agent-private.routes.ts:20-22`.
Nada no site responde `/wallet/*`, e nunca respondeu.

**Efeito prático se ficar como está.** 404 em toda chamada. `#move` cai no ramo
`!response.ok` (`wallet.ts:254-266`) e devolve `unavailable`; `StoreService.buy`
fecha a compra como `failed` com `WALLET_UNAVAILABLE` (`service.ts:294-298`). A
loja não funciona nunca, e a mensagem ao jogador é "A carteira não respondeu.
Tente de novo em instantes." — para sempre.

**Resolução.** `SiteWallet` (§8) monta `/api/agent/ozcoins/...`. A `RemoteWallet`
é apagada.

### D2 — `X-Server-Id` não é mandado

**O que o agent assume.** Que basta o bearer. Os dois lugares que montam headers
(`wallet.ts:230-234` e `:280`) mandam só `Authorization` (e `Content-Type` +
`Idempotency-Key` no POST).

**O que o site faz.** `authenticateAgent` **exige** o serverId em `X-Server-Id`,
`?serverId=` ou `body.serverId`, e recusa sem ele com
`400 { error, error_code: 'MISSING_SERVER_ID' }`
(`authenticateAgent.ts:43-51`). Ele é aplicado a TODAS as rotas do módulo
(`agent-private.routes.ts:17`).

**Efeito prático se ficar como está.** Toda chamada morre em 400 antes de chegar
ao controller. Como todo 4xx que não é 409 vira `unavailable` (D10), o sintoma é
idêntico ao do D1.

**Resolução.** `SiteWallet` e todo o resto mandam `X-Server-Id: <SITE_SERVER_ID>`
em cada requisição, num ponto único (`core/src/site/client.ts`, §14.2).

### D3 — Idempotência: header vs campo do corpo

**O que o agent assume.** `Idempotency-Key: <reference>` no header
(`wallet.ts:233`), com o corpo `{ amount, reason }` (`wallet.ts:235`).

**O que o site faz.** Ignora o header. A chave é `referenceId`, **no corpo**,
3..120 chars (`ozCoinsMutation.ts:29-30, 71-75`), e é ela que carrega o `UNIQUE`
global do ledger (`models/OzCoinTransaction.ts:13`).

**Efeito prático se ficar como está.** `400 { error: 'referenceId obrigatório
(3..120 chars)' }` (`agent-ozcoins.controller.ts:75-77`). E, se um dia o corpo
passasse sem `referenceId` por outro caminho, **não haveria idempotência
nenhuma** — dois cliques cobrariam duas vezes.

**Resolução.** O `reference` da compra vai no corpo, como `referenceId`. O header
`Idempotency-Key` deixa de ser enviado ao site: no RustAgent ele continua
existindo, mas para outra coisa (a idempotência da ENTREGA — ver §10.4 e
`Docs/06-API.md:1399-1420`). São duas perguntas diferentes: `referenceId`
responde *"esse dinheiro já saiu?"*; `Idempotency-Key` responde *"esse comando já
rodou?"*. Nenhuma responde pela outra.

### D4 — A referência não tem prefixo

**O que o agent assume.** Que o `purchaseId` puro serve como chave. Ele é
`` `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` ``
(`core/src/store/service.ts:163-165`) — cerca de 14 caracteres — e é passado
direto como `reference` (`service.ts:281-286`).

**O que o site faz.** `ozcoin_transactions.reference_id` é
`STRING(120), allowNull: false, unique: true` — **único na tabela inteira, entre
todos os jogos** (`models/OzCoinTransaction.ts:13`). DayZ, Conan e Rust dividem o
mesmo espaço de nomes.

**Efeito prático se ficar como está.** Uma colisão com uma referência do DayZ ou
do Conan faz o site achar a transação ANTIGA no lookup
(`agent-ozcoins.controller.ts:80-83`) e devolver `idempotentResponseOf(existing)`
— `{ success: true, idempotent: true, ... }`, HTTP 200. O débito **desta** compra
nunca acontece, o agente lê sucesso, entrega o item, e o jogador leva de graça. É
a falha mais silenciosa do contrato inteiro: ela se parece com um dia normal.

**Resolução.** `rust:<serverId>:loja:<purchaseId>`, com teto de 113 chars e
`sha256` quando não couber. §6 inteiro é sobre isso.

### D5 — O sufixo do estorno é `:credit`, e não `:refund`

**O que o agent assume.** `` `${reference}:credit` `` (`wallet.ts:211-216`), com
o porquê certo escrito ao lado: usar a mesma chave faria o site tratar o estorno
como repetição do débito.

**O que o site faz.** A convenção viva é `<referenceId>:refund` — é o que o
agente do Conan usa (`ad_oz_conan_backend/services/store_checkout.py:105`) e o
que o relatório e o hábito operacional esperam.

**Efeito prático se ficar como está.** Funciona, mas diverge: o teto de 120 chars
foi dimensionado sobre `:refund` (7 chars) e `:credit` também tem 7, então o
tamanho não quebra — o que quebra é a leitura humana e qualquer consulta que
procure `:refund` no ledger.

**Resolução.** `:refund`. É o precedente vivo, e é sobre ele que o teto de 113
chars da compra é calculado (§6).

### D6 — Saldo insuficiente é 422, e 409 significa outra coisa

**O que o agent assume.** 409 = saldo insuficiente. Está escrito como contrato no
próprio código (`wallet.ts:172-176`) e implementado em `wallet.ts:245-252`.

**O que o site faz.** Saldo insuficiente é **422**. `applyOzMutation` lança um
erro com `err.status = 422` e a frase pronta
(`ozCoinsMutation.ts:164-169`), e o controller a repassa com
`res.status(err.status || 500).json({ error: err.message })`
(`agent-ozcoins.controller.ts:113`) — **sem `error_code`** no `/ozcoins/debit`.
No `/shop/purchase` o mesmo caso sai com
`error_code: 'INSUFFICIENT_BALANCE'` (`agent-shop.controller.ts:454-456`).

E o 409 do site significa **reuso de `referenceId`**:
`REFERENCE_ID_REUSED`, `REFERENCE_ID_AMOUNT_MISMATCH`,
`REFERENCE_ID_PRODUCT_MISMATCH` (`agent-shop.controller.ts:255-287`) e
`PRODUCT_LEFT_CATALOG_AFTER_CHARGE` (`:350-354`). Em três dos quatro, o corpo
traz `charged` — **o dinheiro já saiu**.

**Efeito prático se ficar como está.** O desfecho mais perigoso do protocolo é
lido ao contrário: o agente veria "saldo insuficiente" onde o site disse "já
cobrei; não gere id novo", diria ao jogador que ele não tem dinheiro, e a compra
fecharia como `failed` com o dinheiro fora da conta dele.

**Resolução.** 422 → `insufficient`. 409 → `rejected`, com `charged` guardado na
compra para conferência humana, e **nunca** um id novo (§4 e §11.4).

### D7 — O saldo vem como STRING, e o campo não é `balance`

**O que o agent assume.** `body.balance` como `number`, com `Math.trunc`
(`wallet.ts:250` e `:272`).

**O que o site faz.** Devolve `moedas`, `before`, `after` e `amount` como
**string**; só `transactionId` (e `charged`, no 409) são número. Ver o corpo
fresco em `agent-ozcoins.controller.ts:101-110` e o de replay em
`ozCoinsMutation.ts:92-103`. **`balance` não existe em resposta nenhuma.**

**Efeito prático se ficar como está.** `typeof body.balance === 'number'` é falso
sempre, então `#move` cai no `?? 0` e devolve `{ status: 'ok', balance: 0 }`
(`wallet.ts:268-273`). Todo débito bem-sucedido seria lido como "o jogador ficou
com zero" — e é esse zero que iria para o cabeçalho do CUI e para o modal.

**Resolução.** A tradução acontece num ponto só, na fronteira: `moedas` →
`balance`, com `Number()` e `Math.trunc`. E **nunca comparar string com string**:
`"300" > "1500"` é verdadeiro em ordem lexicográfica, e foi essa a razão de o
agente do Conan ter uma `parse_moedas` própria
(`ad_oz_conan_backend/services/site_integration.py:376-388`).

### D8 — O campo `ok` não existe (e ninguém o lê)

**O que o agent assume.** O contrato escrito em `wallet.ts:169-170` promete
`{ ok, balance }`.

**O que o site faz.** Devolve `success: true` e, no replay, `idempotent: true`.
Nunca `ok`.

**Efeito prático se ficar como está.** Nenhum, porque o código do agente **não lê
`ok`** — ele lê só `balance` (`wallet.ts:268-273`). A divergência é silenciosa, e
o dano dela é o do D7: 200 sem `balance` vira "saldo zero" em vez de erro. Um
site que respondesse `200 { ok: true }` faria a loja acreditar que o jogador
ficou zerado.

**Resolução.** `SiteWallet` exige `success === true` para classificar como `ok`.
Um 200 que não traga isso é **`unknown`**, não `ok`: um 200 que não dá para
entender pode ter cobrado.

### D9 — A consulta de saldo é query, e não path

**O que o agent assume.** `GET /wallet/{steamId}` e uma resposta com `balance`
(`wallet.ts:192-204`).

**O que o site faz.** `GET /api/agent/ozcoins/balance?steamId=<17 dígitos>` e
responde `{ steamid, moedas }` (`agent-ozcoins.controller.ts:40-63`). Havia um
terceiro campo, `exists`; ele saiu do contrato em `oz-rust/6` — ver D20.

**Efeito prático se ficar como está.** `getBalance` cai no ramo de erro
(`wallet.ts:194-202`) e devolve `balance: 0` para todo mundo, **em silêncio** —
com um `logger.warn` que ninguém lê às três da manhã.

**Resolução.** Query string, e `moedas` traduzido na fronteira.

### D10 — 400 de validação vira retentável

**O que o agent assume.** Qualquer `!ok` que não seja 409 é `unavailable`
(`wallet.ts:254-266`) — e `unavailable` é, pela doutrina do próprio arquivo
(`wallet.ts:27-32`), o estado **RETENTÁVEL**.

**O que o site faz.** Devolve 400 para `steamId` inválido, `amount` não-inteiro
ou não-positivo, e `referenceId` fora de 3..120
(`agent-ozcoins.controller.ts:68-77`). Nenhum deles melhora com o tempo.

**Efeito prático se ficar como está.** Retry eterno de um pedido que nunca vai
passar, contra um canal que **não tem rate-limit**
(`middleware/securityMiddleware.ts:30-36`). Um defeito nosso vira carga no
Postgres do site.

**Resolução.** 400 → `rejected`: nunca repetir com o mesmo corpo, logar em
`error`, mostrar na tela de status, e dizer ao jogador "A loja está com um
problema. Avise a administração."

### D11 — 401/403/404 de pareamento são indistinguíveis de "site lento"

**O que o agent assume.** Nada — todos caem no mesmo `unavailable`.

**O que o site faz.** Distingue, e escreveu por quê:
`MISSING_BEARER` (401), `BEARER_MISMATCH` (401), `AGENT_NOT_FOUND` (404) e
`AGENT_NOT_ACTIVE` (403), cada um com `error_code` estável. O docblock de
`authenticateAgent.ts:18-23` é explícito: *"O painel do Conan foi instruído a
RAMIFICAR PELO `error_code` — 403 é 'loja indisponível', nunca 'loja vazia'; 401
é 'não repetir em loop'."*

**Efeito prático se ficar como está.** Token rotacionado no site, agente ainda
`pending`, e site fora do ar produzem o mesmo sintoma: o botão de comprar para de
funcionar, sem nada que diga qual dos três é. O Conan pagou horas de diagnóstico
nisso — um 403 da borda Cloudflare lido como "agente banido", procurando um ban
numa tabela vazia.

**Resolução.** `unavailable` **com o motivo separado**: `pairing` (401/403/404),
`throttled` (429) ou `network`. Em `pairing`, o agente marca o pareamento como
quebrado, **para de tentar débitos** e volta a beaconar; e
`GET /api/site/status` (§9.6) separa `lastBeaconError` de `wallet.lastError`
para que as três causas tenham três telas.

### D12 — Timeout é tratado como "não cobrou"

**O que o agent assume.** Exceção de rede ou timeout → `unavailable`
(`wallet.ts:237-243`) → `StoreService.buy` fecha a compra como `failed` com
`WALLET_UNAVAILABLE` (`service.ts:294-298`) e devolve
`{ status: 'wallet-unavailable' }`. Nada é entregue, nada é estornado, e nada
volta para conferir.

**O que o site faz.** Pode ter cobrado. `applyOzMutation` grava saldo e ledger na
mesma transação (`ozCoinsMutation.ts:147-192`); se a resposta se perder no
caminho — ou se o `AbortController` do agente cortar em 5 s enquanto o commit
acontece — o dinheiro saiu e o agente não sabe. Pior: `authenticateAgent` e
`balance` são `async` **sem try/catch** (`authenticateAgent.ts:36-71`,
`agent-ozcoins.controller.ts:40-63`); com Express 4, uma promise rejeitada nesses
pontos não chega no error handler — o request **pendura** até o abort do agente.

**Efeito prático se ficar como está.** O jogador paga e não recebe, e não existe
nenhum relógio, nenhuma tela e nenhum botão que volte a conferir. É a divergência
mais cara do documento.

**Resolução.** Nasce o quinto desfecho, `unknown` (§4), o estado
`charge-unknown` em `store_purchases` (§15), a rota de prova
`GET /api/agent/ozcoins/transaction` (§5.6) e o relógio de reconciliação (§11).
`unknown` é o único desfecho que **não fecha a compra**.

### D13 — Saldo desconhecido vira ZERO

**O que o agent assume.** Que devolver 0 na consulta é degradação aceitável, e o
comentário explica bem: *"derrubar a vitrine porque o site piscou seria punir
quem só queria olhar"* (`wallet.ts:194-202`).

**O que o site faz.** Nada de errado — o problema é do lado do agente, e ele
piora com o dialeto novo: com o D9 no lugar, **toda** leitura cairia nesse ramo.

**Efeito prático se ficar como está.** O modal desenha
`affordable = balance === null || balance >= total`
(`core/src/game/ui-store-screens.ts:718`) e, com `balance = 0`, `canBuy` fica
falso: o botão **CONFIRMAR COMPRA não é desenhado** e no lugar dele aparece um
painel morto dizendo "SALDO INSUFICIENTE"
(`ui-store-screens.ts:1038-1074`). É o oposto exato do que
`core/src/game/ui-store-bridge.ts:110-118` mandou fazer: *"escondê-lo diria 'você
não tem dinheiro', que é diferente de 'não consegui perguntar'"*.

**Resolução.** `WalletBalance.balance` passa a ser `number | null`, e `null`
significa **"não perguntei"**. A tela já sabe lidar com isso — `affordable` já
trata `balance === null` como "deixa tentar" (`ui-store-screens.ts:718`). O que
faltava era a carteira saber dizer `null`.

### D14 — O que foi comprado não chega ao ledger

**O que o agent assume.** Que `reason` basta para identificar a compra.

**O que o site faz.** `/ozcoins/debit` grava `product_id = NULL`: o controller
chama `applyOzMutation` sem o parâmetro (`agent-ozcoins.controller.ts:86-94`),
embora o helper **já o aceite** (`ozCoinsMutation.ts:130-134`, e a gravação em
`:188`).

**Efeito prático se ficar como está.** O requisito "informar ao site o que foi
comprado" não é atendido, e o guard `REFERENCE_ID_PRODUCT_MISMATCH` fica cego. O
incidente que motivou a coluna está escrito em
`ad_oz_backend/migrate_ozcoin_tx_product_id.ts:9-13`: com quatro produtos a 10 OZ,
`direction` + `steam_id` + `amount` batiam, o site respondia `idempotent: true`, e
o painel **entregava B tendo cobrado A**.

**Resolução.** O agente passa a mandar `productId: offer.id` no débito da loja
— e o site passa a repassá-lo ao helper (ajuste 1 do §5.4). É aditivo: o DayZ não
manda o campo, e o comportamento dele fica byte a byte igual
(`ozCoinsMutation.ts:130-134` diz isso por escrito).

### D15 — Não existe teto por transação

**O que o agent assume.** Nada. `total = offer.price * units`
(`core/src/store/service.ts:253`), com `units = Math.max(1, Math.trunc(quantity))`
(`:252`). A rota HTTP aceita `quantity` até 1000 (`http/routes/store.ts:220-224`),
o schema do clique aceita até 1000, e a tela limita a 100
(`ui-store-screens.ts:184`).

**O que o site faz.** Também não impõe teto: só recusa o que passar do saldo
(`ozCoinsMutation.ts:164-169`). E `users.ep_balance` é `INTEGER` de 32 bits
(`models/User.ts:48-53`) enquanto `amount`/`before_balance`/`after_balance` no
ledger são `BIGINT` — o saldo estoura antes do ledger, sem mensagem própria.

**Efeito prático se ficar como está.** Um preço editado errado, ou um `quantity`
por rota, debita o que o jogador tiver. No painel do Conan essa exata combinação
debitou **60 milhões de OZ** numa requisição.

**Resolução.** `STORE_MAX_OZ_PER_PURCHASE` (default 100 000), aplicado **no
agente**, ANTES de qualquer chamada ao site (§17.1). Quem impõe teto é quem tem o
teto — e o site não tem.

### D16 — O timeout não é escolhido: ele é derivado do plugin

**O que o agent assume.** `DEFAULT_TIMEOUT_MS = 5_000` (`wallet.ts:163`), e
`index.ts:487-491` constrói a `RemoteWallet` **sem** `timeoutMs` — então em
produção o teto é 5 s, com **uma tentativa só, sem retry** (`wallet.ts:291-302`).

**O que o site faz.** Pode pendurar (D12). E a borda (Cloudflare → Nginx → Node,
`ad_oz_backend/server.ts` com `trust proxy = 2`) acrescenta latência própria.

**Efeito prático se ficar como está.** O plugin `OrigemZUI` arma um timeout de
**8 s** por compra (`Plugins/OrigemZUI.cs:183`) e, ao estourar, manda o jogador
conferir o inventário em vez de tentar de novo — de propósito, "que seria
arriscar pagar duas vezes". Mas o `FailBuy` dele **zera o `PendingBuyId` e
remove o `_pendingBuys`** (`OrigemZUI.cs:2075-2077`): o botão volta a funcionar
com a compra ainda em voo. Os 5 s da carteira **mais** o `origemz.give` **mais**
o RCON cabem perigosamente perto desses 8 s — e quem estoura primeiro é o
plugin, porque o relógio dele começa no clique.

**Resolução.** `SITE_TIMEOUT_MS`, default **5000** — **derivado**, não escolhido:
`SITE_TIMEOUT_MS + 2000 ≤ RequestTimeoutSeconds × 1000`, com o orçamento inteiro
escrito no §16.2. E o desfecho de um estouro passa a ser `unknown` (que tem
conserto) e não `failed` (que não tem).

### D17 — Um middleware global do site mata o request

**O que o agent assume.** Que o corpo `{ amount, reason }` é inofensivo.

**O que o site faz.** `validateBalanceChange`
(`middleware/securityMiddleware.ts:193-202`) responde
`403 { error: 'Operação não permitida' }` — **sem `error_code`** — se o corpo
tiver `balance`, `ozBalance` ou `epBalance` como valor primitivo. E ele roda
antes das rotas de `/api/agent`.

**Efeito prático se ficar como está.** O corpo atual passa. Mas qualquer campo
novo com um desses três nomes vira um 403 que não se parece com nada — e, com o
D11 no lugar, seria lido como "agent não ativo".

**Resolução.** O corpo do débito e do crédito **nunca** carrega um campo chamado
`balance`, `ozBalance` ou `epBalance`. Está escrito no cabeçalho do
`core/src/site/client.ts` (§14.2) para quem for acrescentar campo depois. E o
`sanitizeInput` do site (`securityMiddleware.ts:175-185`) faz `.trim()` em todo
campo string de primeiro nível: `referenceId` e `observacao` chegam já aparados,
então o agente não deve mandar espaço significativo neles.

### D18 — `reason` não existe no site

**O que o agent assume.** `{ amount, reason }` (`wallet.ts:235`), com
`` reason = `store:${offer.name} x${units}` `` (`service.ts:285`).

**O que o site faz.** Lê `{ steamId, amount, referenceId, observacao }`
(`agent-ozcoins.controller.ts:66`). `reason` é descartado.

**Efeito prático se ficar como está.** O extrato do jogador no site fica **sem
texto** — some justamente a linha que o suporte lê. `observacao` é o campo que
aparece em `GET /api/users/me/ozcoin-transactions`.

**Resolução.** `reason` → `observacao` na fronteira, com o texto em **português**
e voltado ao jogador: `Loja in-game: <oferta> x<n>` na compra e
`Estorno: entrega falhou (<código>)` no estorno. Truncado em 500 pelo site, nunca
recusado (`ozCoinsMutation.ts:77-80`) — mas o agente trunca antes, para o que o
jogador lê ser o que o agente escreveu.

**Um aviso de formato:** o extrato do site consolida numa linha só toda transação
de crédito cuja `observacao` seja **exatamente** `Recompensa: tempo online`
(`ad_oz_backend/routes/ozcoin-history.ts:13, 42-61`). Nenhum texto do RustAgent
pode ser essa frase.

### D19 — A carteira remota não tem `fetchImpl` nem teste

**O que o agent assume.** O `fetch` global, direto (`wallet.ts:298`).

**O que o site faz.** Irrelevante — o problema é do agente.

**Efeito prático se ficar como está.** Não existe um único teste de
`RemoteWallet` (o nome não aparece em `core/test/`), e não há como escrever um: o
projeto proíbe teste que fale com a internet. O protocolo de cinco desfechos —
justamente o que decide se um jogador perde dinheiro — ficaria sem cobertura.

**Resolução.** `SiteWallet` nasce com `fetchImpl` injetável, no molde exato do
`RustMapsClient` (`core/src/wipe/rustmaps.ts:181` e `:210`), e §19 lista os
casos que precisam existir.

### D20 — `exists` saiu do contrato

**O que o agent assume.** Nada; a armadilha era para quem escrevesse a tela
depois.

**O que o site fazia.** `GET /ozcoins/balance` faz `User.findOrCreate` com
`username: 'Player_' + steamId.slice(-4)` e `ozBalance: 0`
(`agent-ozcoins.controller.ts:48-55`) e **depois** respondia `exists: true` —
literal, não calculado. A conta é criada pela própria consulta.

**Efeito prático se tivesse ficado.** Qualquer lógica do tipo "se não existe
conta, convide a se cadastrar" ramificaria por um campo que nunca é falso. E, de
quebra, abrir a loja povoa `users` com contas-fantasma de saldo zero — é o
comportamento existente do DayZ, mas o volume do Rust é outro.

✅ **RESOLVIDA em 04/09/2026, sob a etiqueta `oz-rust/6`.** O dono escolheu a
saída mais barata da H58 do backlog do site: **remover o campo**. A resposta de
`GET /ozcoins/balance` tem hoje **duas chaves**, `{ steamid, moedas }`.

**O que muda deste lado: NADA.** `SiteClient.balance()` nunca leu
`result.body.exists` — ele **sintetiza** o campo
(`core/src/site/client.ts:177` devolve `{ balance: toInteger(body.moedas),
exists: true }`), e o `SiteWallet` nem olha para ele. Foi essa a razão de a
remoção ser barata. ⚠️ Se um dia o `BalanceBody` deste repositório perder o campo
sintético, o `expect` do caso `ozcoins-balance` em
`contracts/oz-rust-fixtures.json` cai junto.

⚠️ **O `findOrCreate` FICA.** Ele é o caminho de carteira compartilhado com o
**DayZ em produção**, que conta com o stub para creditar quem nunca logou no
site. A leitura continua escrevendo em duas tabelas, e isso segue registrado como
dívida aberta (H58) no `docs/BACKLOG.md` do site. Quem não tem OZ continua caindo
em 422 com a frase pronta, e é essa frase que o jogador lê. Ver §7.

---

## 4 — O protocolo de dinheiro: os cinco desfechos

### 4.1 A união fechada

```ts
// core/src/store/wallet.ts

/**
 * O resultado de mexer no saldo.
 *
 * ####  CINCO DESFECHOS, E NÃO TRÊS  ####
 *
 * O site tem cinco famílias de resposta, e colapsá-las produz erro
 * caro. `insufficient` é resposta ao jogador; `rejected` é defeito
 * nosso; `unavailable` é retentável DEPOIS de reparear; e `unknown`
 * é o único que NÃO fecha a compra — ele significa "pode ter
 * cobrado", e só a prova do §11 o resolve.
 */
export type WalletChange =
  /** Cobrou (ou já tinha cobrado, no replay). `balance` é o saldo DEPOIS. */
  | {
      readonly status: 'ok';
      readonly balance: number;
      /** O id da linha no ledger do site. `null` no replay — o site não o repete. */
      readonly transactionId: string | null;
      /** `true` quando o site respondeu `idempotent`. */
      readonly replayed: boolean;
    }
  /** Não tem. NADA foi cobrado. `message` é a frase do SITE, crua. */
  | { readonly status: 'insufficient'; readonly balance: number; readonly message: string }
  /**
   * O site recusou o PEDIDO. Nada foi cobrado AGORA — mas se
   * `charged` vier preenchido, o dinheiro saiu numa cobrança
   * anterior com esta mesma referência.
   *
   * NUNCA repetir com o mesmo corpo, e NUNCA gerar id novo.
   */
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly reason: string;
      readonly charged: number | null;
    }
  /** Não deu para falar com o site. NADA foi cobrado. */
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      /** `pairing` para de tentar e volta a beaconar. Ver §9.5. */
      readonly cause: 'pairing' | 'throttled' | 'network';
    }
  /** PODE TER COBRADO. Não entrega, não estorna, não fecha. Ver §11. */
  | { readonly status: 'unknown'; readonly reason: string };
```

### 4.2 A tabela de tradução

Esta tabela é o coração do `SiteWallet`. Ela é a mesma para `/ozcoins/debit` e
`/ozcoins/credit` — o handler do site é literalmente compartilhado
(`agent-ozcoins.controller.ts:117-118`).

| HTTP | `error_code` (ou corpo) | Desfecho | Cobrou? | O agent repete? |
|---|---|---|---|---|
| 200 | `success:true`, sem `idempotent` | `ok` | **sim, agora** | não |
| 200 | `success:true`, `idempotent:true` | `ok` (replay) | **sim, antes** | não |
| 200 | corpo sem `success:true` | `unknown` | **talvez** | sim, depois de perguntar |
| 400 | `MISSING_SERVER_ID` | `unavailable` / `pairing` | não | não — é `.env` errado |
| 400 | `INVALID_STEAM_ID` / `INVALID_AMOUNT` / `INVALID_REFERENCE_ID` (nas rotas de dinheiro, §5.4 e §5.5) | `rejected` | não | **nunca com o mesmo corpo** |
| 400 | `INVALID_PRODUCT_ID` | `rejected` | não | **nunca com o mesmo corpo** — o `offer.id` passou de 100 chars |
| 400 | sem código nenhum (o site ainda não subiu o ajuste 3 do §5.4) | `rejected` | não | **nunca com o mesmo corpo** |
| 400 | `INVALID_STEAM_ID` / `INVALID_REFERENCE_ID` **na rota de prova** (§5.6) | **`unprovable`** — desfecho TERMINAL da reconciliação, e **não** `rejected` nem `unknown` | **talvez** | **não**: uma referência gravada torta produz 400 para sempre, e o settler bateria todo minuto num pedido que nunca passa (§11.4). É o recorte que o `proveCharge` do §8.3 implementa |
| 400 | `INVALID_CURSOR` (só na fila, §5.7) | **descarta o `cursor` e recomeça a varredura do começo da fila** | — | sim, **sem `cursor`** — e nunca com o mesmo. Ver a observação 7 |
| 400 | `INVALID_ACK_BODY` (só no ACK, §5.8) | `rejected` | — | não com o mesmo corpo: o lote saiu vazio ou com mais de 50; parta-o em 50 |
| 400 | `INVALID_ACK_STATUS` (só no ACK, §5.8) | `rejected` | — | não com o mesmo corpo — **o lote INTEIRO foi recusado** e nenhum dos ACKs entrou. É defeito de contrato, e vale alarme (§18.4) |
| 400 | `SHOP_GAME_NOT_SUPPORTED` (só no espelho, §5.9 e §5.10) | `rejected` | — | não: o conserto é no cadastro do site (`servers.game` deste `serverId` não é `rust`), não no corpo |
| 400 | `MIRROR_INVALID_VERSION` (só no espelho, §5.9) | `rejected` | — | não com o mesmo corpo: a `version` não é 64 hex, e é defeito NOSSO. Grava `lastPushError` e espera a `version` mudar |
| 400 | `MIRROR_INVALID_BODY` (só no espelho, §5.9) | `rejected` | — | não com o mesmo corpo: `categories`/`offers` fora de forma, oferta sem `id`, ou `price` que não é inteiro ≥ 0. É o erro mais provável de um espelho mal montado, e reenviar é laço |
| 401 | `MISSING_BEARER` | `unavailable` / `pairing` | não | não em laço — re-beacon |
| 401 | `BEARER_MISMATCH` | `unavailable` / `pairing` | não | não em laço — re-beacon |
| 401 | `BEACON_SIGNATURE_MISSING` / `BEACON_TIMESTAMP_INVALID` / `BEACON_NO_CREDENTIALS` / `BEACON_SIGNATURE_MISMATCH` | `unavailable` / `pairing` | não | **só aparecem no beacon** — ver §9.5 |
| 403 | `AGENT_NOT_ACTIVE` | `unavailable` / `pairing` | não | não — falta o humano ativar |
| 403 | `AGENT_IP_NOT_ALLOWED` | `unavailable` / `pairing` | não | não em laço — o IP mudou; conserto é na allowlist do site (§17.3) |
| 403 | corpo em TEXTO com `error code: 1010` | `unavailable` / `network` | não | sim, com `User-Agent` próprio |
| 403 | corpo JSON com a chave `banId` (`{ error: 'agent banido', banId, … }`) — **só o beacon responde isto** (§5.2) | **dois eixos, e os dois valem**: no beacon, `pairing.status = 'banned'` e o agente **PARA de beaconar**; no dinheiro, `unavailable` — com o pareamento fora de `active`, a loja responde INDISPONÍVEL ao jogador (§9.5) | não | **não, nunca**: insistir não conserta ban |
| 403 | `Operação não permitida`, sem código | `rejected` / `FORBIDDEN_FIELD` | não | não — é corpo nosso torto (D17); reconhecido pela FRASE, porque é só o que o site manda |
| 404 | `AGENT_NOT_FOUND` | `unavailable` / `pairing` | não | não — `serverId` errado ou não cadastrado |
| 404 | `REFERENCE_NOT_FOUND` (só na rota de prova) | prova de **não-cobrança** | não | — ver §5.6 e §11.4 |
| 404 | `REFERENCE_NOT_MINE` (só na rota de prova) | `unprovable` — **não é prova de nada**: a linha existe e não é desta identidade | **talvez** | **não em laço**: sai da reconciliação e vai para conferência humana (§5.6, §11.4) |
| 409 | `REFERENCE_ID_REUSED` | `rejected` | não (id alheio) | **nunca** |
| 409 | `REFERENCE_ID_AMOUNT_MISMATCH` | `rejected` + `charged` | **sim, antes** | **nunca** |
| 409 | `REFERENCE_ID_PRODUCT_MISMATCH` | `rejected` + `charged` | **sim, antes** | **nunca** |
| 413 | `MIRROR_TOO_LARGE` (só no espelho) | `rejected` | — | não — reduza o catálogo (§5.9) |
| 422 | `INSUFFICIENT_BALANCE` + `balance`, `required`, `missing` (**numbers**) | `insufficient` | não | não, até o jogador comprar OZ |
| 429 | `AGENT_RATE_LIMITED` | `unavailable` / `throttled` | não | sim, com recuo |
| 4xx | **qualquer `error_code` que o agente não conheça** | `unavailable` / `network` | não | sim, com recuo — ver a observação 4 |
| 500 | `OZ_MUTATION_FAILED` | `unknown` | **talvez** | sim, depois de perguntar |
| 500 | `TRANSACTION_LOOKUP_FAILED` (só na rota de prova, §5.6) | `unknown` — a prova **não foi obtida**; a compra segue `charge-unknown` | **talvez** | sim, na volta seguinte do settler. **Não** é `unprovable`, que é terminal |
| 500 | `ACK_FAILED` (só no ACK, §5.8) | o lote **não foi gravado** | — | sim: reenviar o lote inteiro é seguro, e é para isso que o ACK é idempotente (§5.8) |
| 500 | `MIRROR_STORE_FAILED` (só no espelho, §5.9) | retentável — grava `lastPushError` | — | sim, na volta seguinte do relógio de 60 s (§13.3). Não é `unknown`: o espelho não mexe em dinheiro |
| 5xx | qualquer outro | `unknown` | **talvez** | sim, depois de perguntar |
| — | `AbortError` (timeout do agente) | `unknown` | **talvez** | sim, depois de perguntar |
| — | erro de rede / DNS / TLS | `unknown` | **talvez** | sim, depois de perguntar |

Sete observações que a tabela não cabe:

1. **Um 422 no `/ozcoins/credit` é impossível na prática** (crédito não fica sem
   saldo), mas o handler é compartilhado. Se acontecer, classifique como
   `rejected` — um crédito recusado por saldo é defeito, não desfecho.
2. **`ok` com `replayed: true` significa "já foi cobrado", NUNCA "já foi
   entregue".** O site não tem como saber da entrega. Está escrito assim no
   próprio site (`agent-shop.controller.ts:394-397`), e é a distinção que faz o
   §10.4 existir.
3. **Um 409 com `charged` é o caso mais perigoso do documento.** O dinheiro saiu,
   a compra não pode ser refeita, e gerar um id novo cobraria de novo. Ele fecha
   como `failed` com o valor cobrado gravado, e vai para conferência humana.
4. **`rejected` é reservado ao que o agente RECONHECE como defeito dele.** Um
   4xx com `error_code` que não está nesta tabela vira `unavailable` /
   `network`, e não `rejected`. A razão é assimétrica e vale escrever: errar para
   `unavailable` custa uma espera; errar para `rejected` **fecha a compra como
   `failed` para sempre**, porque `rejected` significa "nunca repita". No dia em
   que o site criar um código novo — e ele vai criar, `AGENT_IP_NOT_ALLOWED` e
   `AGENT_RATE_LIMITED` nasceram assim —, o agente recua em vez de matar cada
   compra tentada, uma por uma, em silêncio.
5. **Os campos numéricos do 422 são LIDOS, e o `balance` deles é o do site.**
   `balance`, `required` e `missing` chegam como `number` (não como string, ao
   contrário do resto do dinheiro do site). O `insufficient` do agente carrega
   `balance: number | null` — `null` quando o site é uma versão anterior ao
   ajuste 4 do §5.4, **nunca zero**. Zero é uma afirmação sobre o dinheiro de
   alguém (D13).
6. **O agente não pode assumir que os ajustes do §5.4 já subiram.** Enquanto não
   subirem, o 422 vem sem `error_code` e sem os três números, e continua sendo
   `insufficient` — a classificação é por **status**, e o `error_code` só refina.
   Vale para os cinco ajustes.
7. **As linhas das rotas 5 a 9 NÃO produzem `WalletChange`, e é por isso que
   elas precisavam estar aqui mesmo assim.** São **treze linhas**:
   `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_MINE` e a linha dos dois 400 da **rota
   de prova**; `INVALID_CURSOR` na
   **fila**; `INVALID_ACK_BODY`, `INVALID_ACK_STATUS` e `ACK_FAILED` no **ACK**;
   `SHOP_GAME_NOT_SUPPORTED`, `MIRROR_INVALID_VERSION`, `MIRROR_INVALID_BODY`,
   `MIRROR_TOO_LARGE` e `MIRROR_STORE_FAILED` no **espelho**; e
   `TRANSACTION_LOOKUP_FAILED`, que é da prova. Nenhum desses caminhos mexe em
   dinheiro: eles devolvem `SiteResult` — ou, na rota de prova,
   `ChargeProofResult` (§8.3) —, e não um dos cinco desfechos do §4.1.

   **Esta tabela é o classificador ÚNICO do canal, e essa frase só é verdadeira
   se ela estiver completa.** Um código que não esteja aqui cai na regra da
   observação 4 (`unavailable` / `network`, retentável com recuo) — ele não é
   "tratado por padrão", é tratado **por acidente**. Para a maioria o acidente
   custa uma espera; para dois deles, não:

   - **`INVALID_CURSOR` é um laço eterno**: o agente repetiria a mesma rodada com
     o mesmo `cursor` recusado, a cada 15 s, para sempre, e a fila inteira
     pararia atrás dele. O tratamento certo não é "esperar", e sim **jogar o
     cursor fora** (§5.7, §10.2);
   - **os dois 400 da rota de prova são TERMINAIS**, e não retentáveis: como
     `unavailable` eles poriam o settler batendo todo minuto, até o teto do
     §11.1, contra uma referência gravada torta que nenhuma retentativa
     endireita. O desfecho é `unprovable` — sai do laço e vai para gente
     (§5.6, §11.4).

   **Três destas linhas estavam escritas só no §5.9** — `MIRROR_INVALID_VERSION`,
   `MIRROR_INVALID_BODY` e `MIRROR_STORE_FAILED` —, **e o recorte da rota de
   prova, só no §5.6 e no `proveCharge` do §8.3.** Estar na prosa e faltar aqui é
   o mesmo defeito que faltar nos dois lugares, porque é **esta** tabela que o
   `SiteClient` implementa.

### 4.3 Por que `unknown` precisa nascer, e por que hoje ele não existe

Hoje existem três desfechos (`core/src/store/wallet.ts:57-60`) e cinco valores de
`store_purchases.state` (`core/src/db/migrations.ts:1310-1311`), e **nenhum dos
dois conjuntos tem lugar para "não sei se cobrou"**.

O caminho de hoje, passo a passo, quando o site cobra e a resposta se perde:

```
wallet.ts:237-243   catch (error) → { status: 'unavailable', reason: err.message }
service.ts:294-298  unavailable  → #finish(..., 'failed', 'WALLET_UNAVAILABLE')
service.ts:297      retorna { status: 'wallet-unavailable' }
store.ts:722-734    wallet-unavailable → HTTP 503
service.ts:511-514  frase: "A carteira não respondeu. Tente de novo em instantes."
```

A compra **fechou**. O jogador leu "tente de novo", o dinheiro saiu, o item não
saiu, e a linha em `store_purchases` diz `failed` — que é o mesmo estado de
"saldo insuficiente" e de "estorno falhou". Nada volta a olhar aquela linha.

`unknown` corta esse fluxo em dois lugares:

- na carteira, timeout e 5xx deixam de virar `unavailable`;
- no serviço, `unknown` **não chama `#finish`** com um estado terminal: ele grava
  `charge-unknown`, **não entrega e não estorna**, e devolve
  `{ status: 'charge-unknown' }`.

E aí a compra vira responsabilidade do relógio do §11, que a resolve com prova —
no molde exato do `conanDeliveryGuard` do site, cuja invariante está escrita em
três arquivos: **na dúvida, PRESERVA**.

### 4.4 Onde cada desfecho muda comportamento

Hoje a distinção `insufficient` × `unavailable` já muda comportamento em cinco
pontos (`wallet.ts:245-266`, `wallet.ts:124-140`, `service.ts:288-298`,
`service.ts:497-514`, `store.ts:697-734`). Os cinco desfechos passam a mudar em
**sete**:

| Ponto | `ok` | `insufficient` | `rejected` | `unavailable` | `unknown` |
|---|---|---|---|---|---|
| `store_purchases.state` | `debited`→`delivered` | `failed` | `failed` | `failed` | **`charge-unknown`** |
| `store_purchases.error` | `null` | `INSUFFICIENT_FUNDS` | `CHARGE_REJECTED: <code>` | `WALLET_UNAVAILABLE` | `CHARGE_UNKNOWN` |
| Entrega | acontece | não | não | não | **não** |
| Estorno | só se a entrega falhar | não | não | não | **não** |
| `PurchaseOutcome` | `ok` | `insufficient` | `charge-rejected` | `wallet-unavailable` | `charge-unknown` |
| HTTP em `/store/buy` | 200 | 409 | 502 | 503 | **202** |
| Frase ao jogador | "Compra concluída" | a frase do SITE + o caminho | "problema; avise a administração" | "não respondeu; tente em instantes" | **"pode ter sido cobrada; confira em instantes"** |

O 202 é deliberado e é o único status novo: **nem 200** (metade dos clientes HTTP
leria como sucesso, e é por isso que `store.ts:565-569` já recusa 200 para
desfecho ruim) **nem 5xx** (que convida a repetir — e repetir aqui é cobrar de
novo quem talvez já tenha pago).
---

## 5 — O contrato HTTP que o agent consome

### 5.1 O que vale para todas

**Base.** `SITE_BASE_URL` é a **origem** — esquema e host, sem caminho. O cliente
acrescenta `/api/agent/...`. Uma barra final é removida na leitura, como
`core/src/config.ts:699-703` já faz hoje.

```bash
# O valor real vem do .env do agente. Confirme com o dono qual host
# serve /api/agent em produção — ver §22, pergunta 10.
SITE_BASE_URL="https://origemznetwork.com"
SITE_TOKEN="<o bearer que o site gerou no activate>"
# ####  OS VALORES DE EXEMPLO SÃO OS DO §23.2  ####
#
# Eles são os MESMOS nos dois manuais, de propósito: um curl copiado
# de um documento tem de rodar contra o outro lado sem edição.
# `SITE_SERVER_ID` é o id NO SITE (RUST01); o servidor local de
# `Configs\` se chama rust-pvp1, e são coisas diferentes (§22.10).
SITE_SERVER_ID="RUST01"
STEAM_ID="76561198000000000"
```

**Headers de toda rota autenticada** (as nove abaixo, mais o retrato do servidor
da §23.8, mais as quatro de comando e config da §23.10 — menos o beacon):

| Header | Valor | Por quê |
|---|---|---|
| `Authorization` | `Bearer ${SITE_TOKEN}` | comparado contra `agents.bearerHash` com `timingSafeEqual` (`authenticateAgent.ts:64-66`) |
| `X-Server-Id` | `${SITE_SERVER_ID}` | **obrigatório**; sem ele é 400 `MISSING_SERVER_ID` (`authenticateAgent.ts:46-51`) |
| `Content-Type` | `application/json` | só nos POST |
| `Accept` | `application/json` | |
| `User-Agent` | `OrigemZ-Rust-Agent/<versão>` | a borda recusa famílias genéricas de cliente HTTP com um 403 de corpo em TEXTO contendo `error code: 1010`, que não é ban (§17.5) |

**Cinco fatos que valem para tudo:**

1. **`steamId` é sempre string de 17 dígitos**, nos dois lados. O site valida com
   `/^\d{17}$/` (`ozCoinsMutation.ts:28, 67-69`) e o agente com o mesmo padrão
   (`core/src/bans/rust-bans.ts:54`, via `assertSteamId` em
   `core/src/bans/service.ts:677-687`). SteamID64 passa de 2^53 e não sobrevive a
   um `number` de JS.
2. **Dinheiro vai como número inteiro e volta como string.** `amount` sai
   `number` (o site faz `Number.isInteger(amt) && amt > 0`,
   `agent-ozcoins.controller.ts:71-74`) e `moedas`/`before`/`after`/`amount`
   voltam string (`ozCoinsMutation.ts:92-103`, `agent-ozcoins.controller.ts:104-107`).
3. **`amount` é sempre POSITIVO.** O sentido é da rota, nunca do sinal.
4. **O corpo nunca carrega um campo chamado `balance`, `ozBalance` ou
   `epBalance`** — o middleware global do site mata o request com 403 sem código
   (D17).
5. **Nenhuma resposta de erro do site é confiável como JSON.** Um 403 da borda
   vem em texto puro. Todo parse é defensivo: falhou, o corpo é `null` e a
   classificação usa só o status.

**Timeout.** `SITE_TIMEOUT_MS`, default 5000, por `AbortController` — no molde de
`core/src/wipe/rustmaps.ts:348-384`. Uma tentativa por chamada no caminho do
clique; o retry mora nos relógios, nunca dentro da compra.

---

### 5.2 `POST /api/agent/beacon` — o batimento

**Status:** JÁ EXISTE.
`F:/Projects/OrigemZSite/ad_oz_backend/src/modules/agent-public/agent-public.routes.ts:38-140`.

**Auth:** nenhuma. Esta é a única rota sem bearer — é o primeiro contato. A única
barreira é `findBan(ip, mac)` (`:15-21, 53-61`).

**Corpo.** O router do beacon declara um limite de 8 KB
(`agent-public.routes.ts:34`), mas ele é **letra morta**: o parser global de
`ad_oz_backend/server.ts:206` (`express.json({ limit: '10mb' })`) roda antes,
consome o corpo, e o body-parser do router pula quando `req._body` já está
setado. O corpo do beacon é pequeno **por disciplina nossa**, não por imposição
do site — a mesma observação vale para o limite de 64 KB do espelho.

| Campo | Tipo | Obrigatório | Nota |
|---|---|---|---|
| `serverId` | string ≤ 50 chars | **sim** | casa por string **EXATA**, maiúsculas incluídas |
| `port` | number | não (default 7001) | a porta do agente — 8787 |
| `version` | string | não (default `'unknown'`) | a versão do RustAgent |
| `mac` | string | não | vira `trim().toLowerCase()` no site |
| `capabilities` | string[] | não | só strings de 1..30 chars, cortado em 20 itens (`:45-47`) |

**Nunca mande IP.** O site usa o IP do socket (`:49`, `getRealIp`). Mandar um
seria dar-lhe um endereço que ele já tem e que ele fixa para sempre (§2.3).

As `capabilities` do Rust, e o que cada uma declara:

| Capability | Significa |
|---|---|
| `ozcoins` | este agente movimenta OzCoin pelo `/api/agent/ozcoins/*` |
| `shop` | este agente tem loja in-game própria e empurra o espelho dela |
| `deliver_item` | este agente sabe entregar item dentro do jogo |
| `players_online` | este agente sabe dizer quem está conectado |
| `pull_delivery` | **este agente PUXA a fila de entregas; não me chame** |

`deliver_item` é o nome que o painel do Conan já usa e que o site já reconhece
ao lado de `inventory_delivery` (do DayZ) — inventar um terceiro nome faria o
site não reconhecer nada. `pull_delivery` é novo e é a bandeira que diz ao site
para enfileirar em vez de chamar.

**Resposta 200:**

```json
{
  "ok": true,
  "registered": false,
  "status": "pending",
  "serverExists": true,
  "resolvedViaAlias": false,
  "currentServerId": "RUST01",
  "message": "Beacon recebido. status=pending"
}
```

**Erros:** `400 { error: 'serverId obrigatório (string ≤50 chars)' }`;
`403 { error: 'agent banido', banId, reason, bannedAt }` (ban de verdade);
`500 { error }`.

**curl:**

```bash
curl -sS -X POST "$SITE_BASE_URL/api/agent/beacon" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0' \
  -d '{
        "serverId": "RUST01",
        "port": 8787,
        "version": "1.0.0",
        "mac": "a4-bb-6d-11-22-33",
        "capabilities": ["ozcoins","shop","deliver_item","players_online","pull_delivery"]
      }'
```

**Ajuste recomendado (aditivo, do lado do site):** aceitar
`X-Agent-Signature: <hex>` = `HMAC-SHA256(SITE_TOKEN, "<serverId>|<timestamp>")`
mais `X-Agent-Timestamp: <epoch em segundos>`, com janela de ±120 s, e **recusar
o update quando `agent.status === 'active'` E `agent.requires_signed_beacon` for
`true`, e a assinatura não vier ou não conferir**. Hoje o bloco `if (!created)`
(`agent-public.routes.ts:106-119`) sobrescreve `beaconIp`, `beaconPort`,
`lastVersion` e `capabilities` de um agente **em produção** sem credencial
nenhuma. Ver §9.4 e §22, pergunta 7.

**As DUAS condições, e não só a primeira.** A coluna
`agents.requires_signed_beacon` (`BOOLEAN NOT NULL DEFAULT false`, §10.3 do
manual do site) é o que torna a mudança aditiva: `agents` é uma tabela
**compartilhada** entre DayZ, Conan e Rust, e todos eles são `status = 'active'`.
Quem implementar só `status === 'active'` passa a exigir assinatura **do beacon
do DayZ**, que nunca assinou nada — e a consequência não é "o DayZ perde o
beacon": o beacon recusado para de atualizar `lastBeaconAt`,
`serverDelegatesToAgent` (`inventory.service.ts:70-84`) passa a devolver `false`
e **a entrega de inventário do DayZ para de funcionar**.

---

### 5.3 `GET /api/agent/ozcoins/balance` — o saldo

**Status:** JÁ EXISTE, sem mudança.
`agent-ozcoins.controller.ts:40-63` (rota em `agent-private.routes.ts:20`).

**Query:** `steamId` — exatamente 17 dígitos.

**Resposta 200:**

| Campo | Tipo | Nota |
|---|---|---|
| `steamid` | string | minúsculo, e é o mesmo que foi enviado |
| `moedas` | **string** | o saldo, inteiro serializado como texto |

⚠️ **SÃO DUAS CHAVES, e eram três.** O campo `exists` **saiu do contrato em
`oz-rust/6`** (04/09/2026). Ele era o literal `true`, nunca calculado, e só podia
ser verdade porque o `findOrCreate` da própria consulta acabava de criar a conta —
ver §7.2. **Nada quebrou deste lado:** o `SiteClient` nunca leu o campo do site,
ele o **sintetiza** (`core/src/site/client.ts:177`).

**Erros:** `400 { error: 'steamId inválido (esperado 17 dígitos)' }` — **sem
`error_code`** (`:42-44`). Os erros de pareamento vêm do middleware, com código.
Não há try/catch: uma queda do Postgres não devolve 500, ela **pendura** o
request até o abort do agente (D12).

**curl:**

```bash
curl -sS "$SITE_BASE_URL/api/agent/ozcoins/balance?steamId=$STEAM_ID" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'Accept: application/json' \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0'
# 200 {"steamid":"76561198000000000","moedas":"500"}
```

**Efeito colateral que o agente precisa conhecer:** esta consulta **cria** a
conta do jogador no site se ela não existir (`:48-55`). Abrir a loja com o
servidor cheio povoa `users` com contas `Player_XXXX` de saldo zero. É o
comportamento existente do DayZ; o volume do Rust é outro. Por isso a grade da
loja **não** consulta saldo — só o modal
(`core/src/game/ui-store-bridge.ts:96-102`), e isso não muda.

---

### 5.4 `POST /api/agent/ozcoins/debit` — a cobrança

**Status:** **AJUSTAR** — cinco mudanças, todas aditivas, todas do lado do site.
`agent-ozcoins.controller.ts:65-115` (a máquina em `ozCoinsMutation.ts:121-206`).

**Corpo:**

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `steamId` | string | **sim** | 17 dígitos |
| `amount` | number | **sim** | inteiro **positivo**; sem teto do lado do site (D15) |
| `referenceId` | string | **sim** | 3..120 chars; aqui, 3..113 (§6) |
| `observacao` | string | não | truncada em 500 pelo site, nunca recusada |
| `productId` | string | **não (NOVO)** | ≤ 100 chars; o `offerId` do agente |

**Resposta 200 — cobrança fresca** (`:101-110`):

```json
{
  "success": true,
  "steamid": "76561198000000000",
  "moedas": "250",
  "before": "500",
  "after": "250",
  "amount": "250",
  "direction": "debit",
  "transactionId": 918273
}
```

**Resposta 200 — replay** (`ozCoinsMutation.ts:92-103`, via `:80-83`):

```json
{
  "success": true,
  "idempotent": true,
  "steamid": "76561198000000000",
  "moedas": "250",
  "before": "500",
  "after": "250",
  "amount": "250",
  "direction": "debit"
}
```

Três diferenças que importam: o replay **tem** `idempotent: true`, **não tem**
`transactionId`, e os números saem da linha **gravada**, nunca do pedido novo. E
`idempotent: true` quer dizer **já foi cobrado**, nunca "já foi entregue".

**Todos os erros:**

| HTTP | Corpo | Quando |
|---|---|---|
| 400 | `{ error: 'steamId inválido (esperado 17 dígitos)', error_code: 'INVALID_STEAM_ID' }` | hoje **sem** o código (`:68-70`); com o ajuste 3 ele passa a vir |
| 400 | `{ error: 'amount inválido (inteiro positivo)', error_code: 'INVALID_AMOUNT' }` | idem (`:72-74`) |
| 400 | `{ error: 'referenceId obrigatório (3..120 chars)', error_code: 'INVALID_REFERENCE_ID' }` | idem (`:75-77`) |
| 400 | `{ error, error_code: 'INVALID_PRODUCT_ID' }` | **NOVO** (ajuste 1) — `productId` acima de 100 chars. Ver a régua do `offer.id` no §14.11(c) |
| 400 | `{ error, error_code: 'MISSING_SERVER_ID' }` | do middleware (`authenticateAgent.ts:46-51`) |
| 401 | `{ error, error_code: 'MISSING_BEARER' }` | `authenticateAgent.ts:38-40` |
| 401 | `{ error, error_code: 'BEARER_MISMATCH' }` | `authenticateAgent.ts:64-66` |
| 403 | `{ error, error_code: 'AGENT_NOT_ACTIVE' }` | `!isEnabled \|\| status !== 'active' \|\| !bearerHash` (`:57-62`) |
| 403 | `{ error: 'Operação não permitida' }` | sem código; corpo com `balance`/`ozBalance`/`epBalance` (D17) |
| 403 | texto puro com `error code: 1010` | a borda recusou o `User-Agent` — **não é ban** |
| 404 | `{ error, error_code: 'AGENT_NOT_FOUND' }` | `authenticateAgent.ts:53-56` |
| 409 | `{ error, error_code: 'REFERENCE_ID_REUSED' }` | **NOVO** (ajuste 2) — id de outro jogador ou de um crédito |
| 409 | `{ error, error_code: 'REFERENCE_ID_AMOUNT_MISMATCH', charged: <number> }` | **NOVO** — mesmo id, valor diferente. **O dinheiro saiu** |
| 409 | `{ error, error_code: 'REFERENCE_ID_PRODUCT_MISMATCH', charged: <number> }` | **NOVO** — mesmo id, produto diferente. **O dinheiro saiu** |
| 422 | `{ error: 'Saldo insuficiente. Voce tem 0 OZ, o item custa 250 OZ (faltam 250).', error_code: 'INSUFFICIENT_BALANCE', balance: 0, required: 250, missing: 250 }` | **ajuste 4**: hoje sai só com `error` (`ozCoinsMutation.ts:164-169` → `:113`). `balance`, `required` e `missing` são **number**, não string |
| 500 | `{ error: <err.message>, error_code: 'OZ_MUTATION_FAILED' }` | **ajuste 5**: hoje sai só com `error`, e ele vaza a mensagem do erro real (`:112-113`) |

**Os cinco ajustes pedidos ao site** (nenhum quebra DayZ nem Conan):

1. **Repassar `productId`.** Desestruturar o campo em `:66` e passá-lo em
   `:86-94`. O helper **já o aceita** — `ozCoinsMutation.ts:130-134` diz por
   escrito que ele é opcional e que sem ele o comportamento antigo fica idêntico
   byte a byte. Sem esse ajuste, o requisito "informar o que foi comprado" não
   tem caminho e o guard de replay por produto fica cego (D14).
2. **Aplicar o guard de replay quando `productId` vier.** `referenceMismatch`
   já existe (`agent-shop.controller.ts:255-287`) e **não é exportado**: extraia-o
   para um módulo compartilhado e chame-o no `mutate` logo depois do lookup de
   `:80-83`. Copiá-lo criaria a segunda verdade que `ozCoinsMutation.ts:11-15`
   foi escrito para eliminar. Sem `productId` no pedido, o comportamento fica
   exatamente o de hoje.
3. **Acrescentar `error_code` às validações de entrada.** As três de `:68-77`
   devolvem só `{ error }`. Com código (`INVALID_STEAM_ID`, `INVALID_AMOUNT`,
   `INVALID_REFERENCE_ID`, mais `INVALID_PRODUCT_ID` para o campo novo) o agente
   pode ramificar como o painel do Conan já faz. É aditivo — o DayZ só usa a
   frase.
4. **Estruturar o 422.** Acrescentar `error_code: 'INSUFFICIENT_BALANCE'` e os
   três números — `balance` (o saldo de agora), `required` (o preço) e `missing`
   (a diferença) — como **number**. Hoje o agente só tem a frase, e uma frase não
   dá para comparar: sem os números, o `insufficient` do agente carregaria um
   saldo inventado, e a única alternativa honesta seria `null`. Com eles, o
   `PurchaseOutcome.insufficient.balance` passa a dizer a verdade sobre o
   dinheiro de alguém.
5. **Acrescentar `error_code: 'OZ_MUTATION_FAILED'` ao 500.** Ele não muda a
   classificação (todo 5xx já é `unknown`), mas separa "o site quebrou de
   verdade" de "a borda devolveu HTML" na tela de diagnóstico e no log — e é a
   diferença entre procurar no lugar certo e procurar na hora errada.

**O agente funciona sem os cinco?** Sim, com perdas nomeadas: sem (1) o ledger
grava `product_id = NULL`; sem (2) não há guard por produto; sem (3) todo 400
vira o mesmo `rejected` genérico; sem (4) o `insufficient` carrega
`balance: null` e a tela mostra só a frase do site; sem (5) o 500 fica sem nome
no log. Nenhuma delas impede a fase 1.

**E o agente NÃO PODE assumir que eles já foram feitos.** Ela manda `productId`
sempre (campo desconhecido é ignorado por um Express que não o desestrutura),
classifica 400 sem `error_code` como `rejected`, e classifica **422 sem código
como `insufficient` do mesmo jeito** — a decisão é pelo status, e o `error_code`
só refina. Um agente que exigisse `INSUFFICIENT_BALANCE` para reconhecer saldo
insuficiente pararia de funcionar contra o site de hoje.

**curl:**

```bash
curl -sS -X POST "$SITE_BASE_URL/api/agent/ozcoins/debit" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0' \
  -d "{
        \"steamId\": \"$STEAM_ID\",
        \"amount\": 250,
        \"referenceId\": \"rust:$SITE_SERVER_ID:loja:p2n8x4q9zk1a\",
        \"observacao\": \"Loja in-game: Kit Metal x1\",
        \"productId\": \"kit-metal\"
      }"
```

---

### 5.5 `POST /api/agent/ozcoins/credit` — o estorno

**Status:** JÁ EXISTE, sem mudança no site.
Mesmo handler do débito (`agent-ozcoins.controller.ts:65-115`, exportado em
`:117-118`; rota em `agent-private.routes.ts:21`).

**Corpo:** idêntico ao do débito. `amount` continua **positivo** — o sentido é da
rota. `productId` **não** é enviado no estorno: estorno não é venda de produto, e
uma linha de crédito com `product_id` preenchido confundiria o guard de replay.

| Campo | Valor no estorno |
|---|---|
| `steamId` | o mesmo da compra |
| `amount` | `purchase.totalPrice`, inteiro positivo |
| `referenceId` | `<referenceId da compra>:refund` — **nunca** a mesma referência |
| `observacao` | `Estorno: entrega falhou (<código do plugin>)` |

**Resposta 200:** igual à do débito, com `direction: 'credit'`. O replay traz
`idempotent: true` e não traz `transactionId`.

**A diferença que organiza o §12:** repetir o estorno com a MESMA referência é
**seguro** e é a resposta certa para timeout — o oposto do débito. O site devolve
`idempotent: true` e não credita de novo.

**curl:**

```bash
curl -sS -X POST "$SITE_BASE_URL/api/agent/ozcoins/credit" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0' \
  -d "{
        \"steamId\": \"$STEAM_ID\",
        \"amount\": 250,
        \"referenceId\": \"rust:$SITE_SERVER_ID:loja:p2n8x4q9zk1a:refund\",
        \"observacao\": \"Estorno: entrega falhou (INVENTORY_FULL)\"
      }"
```

---

### 5.6 `GET /api/agent/ozcoins/transaction` — a PROVA

**Status:** **CRIAR** no site. Não existe nada equivalente hoje.

É o análogo exato do `GET /server/<sid>/api/transactions?request_id=` do painel
do Conan, que é a única coisa que destrava um item preso em `processing` no
`conanDeliveryGuard` do site. Sem ela, fechar um `charge-unknown` exige repetir o
débito — o que é seguro para o dinheiro (o `referenceId` é idempotente) mas
**cobra agora** o jogador que já fechou o jogo e desistiu.

**Query:** `referenceId` (3..120) e `steamId` (17 dígitos), **os dois
obrigatórios**.

**Resposta 200 — a transação existe:**

```json
{
  "found": true,
  "transactionId": 918273,
  "steamid": "76561198000000000",
  "serverId": "RUST01",
  "direction": "debit",
  "amount": "250",
  "before": "500",
  "after": "250",
  "productId": "kit-metal",
  "observacao": "Loja in-game: Kit Metal x1",
  "createdAt": "2026-09-02T14:03:11.412Z"
}
```

**Resposta 404 — a linha não é desta identidade. São DOIS códigos, e o corpo é o
mesmo byte a byte:**

```json
{ "found": false, "error": "Nenhuma transação com esse referenceId neste servidor.", "error_code": "REFERENCE_NOT_FOUND" }
```

```json
{ "found": false, "error": "Nenhuma transação com esse referenceId neste servidor.", "error_code": "REFERENCE_NOT_MINE" }
```

A frase tem o **"neste servidor"** de propósito: a busca é escopada pelo
`X-Server-Id` que o próprio agente mandou, e omiti-lo convida a ler o 404 como
"nunca foi cobrado em lugar nenhum". Os dois corpos são idênticos aos da §6.2 do
manual do site — se algum dia divergirem, o teste de contrato do §19 é o que
acusa.

**Resposta 400 — a pergunta estava torta:**

```json
{ "error": "steamId inválido (esperado 17 dígitos)", "error_code": "INVALID_STEAM_ID" }
{ "error": "referenceId obrigatório (3..120 chars)", "error_code": "INVALID_REFERENCE_ID" }
```

Estes dois **não** são retentáveis: uma referência gravada torta produz 400 para
sempre. Ver o desfecho `unprovable` no §11.4 — sem ele o settler fica batendo
todo minuto num pedido que nunca vai passar.

**Resposta 500 — a consulta quebrou do lado do site:**

```json
{ "error": "Erro ao consultar a transação.", "error_code": "TRANSACTION_LOOKUP_FAILED" }
```

Este 500 é o oposto exato dos dois 400 acima, e confundi-los custa dinheiro nas
duas direções. O 400 é **terminal**: a pergunta está torta e nenhuma retentativa
a endireita, então a compra sai do laço como `unprovable`. O 500 é
**retentável**: a pergunta estava certa e o site é que não respondeu, então a
prova simplesmente **não foi obtida** — a compra continua `charge-unknown` e o
settler pergunta de novo na volta seguinte (§11.1). Ler o 500 como `unprovable`
mandaria para conferência humana uma compra que a próxima tentativa resolveria
sozinha; ler o 400 como retentável poria o settler batendo para sempre. Os dois
estão na tabela fechada do §4.2.

**Este 404 é a prova de que nada foi cobrado — com UMA ressalva, e ela é grande.**
É ele que permite cancelar uma compra indeterminada sem cobrar ninguém.

**Implementação do lado do site**, em uma frase: leitura pura, sem efeito
colateral — `OzCoinTransaction.findOne({ where: { referenceId } })` mais duas
conferências, `tx.steamId === steamId` e `tx.serverId === req.serverId`. Falhando
qualquer uma, **não** conte nada sobre a transação alheia. É a mesma defesa que
`agent-shop.controller.ts:339-341` já escreve: sem ela a rota vira um oráculo de
"quanto foi cobrado de fulano", e o `referenceId` é global entre os jogos.

####  MAS "NÃO É SUA" NÃO É "NÃO EXISTE"  ####

**Ajuste ACEITO pelo site**, e ele é de dinheiro: os dois casos têm códigos
diferentes, mesmo devolvendo o mesmo 404 e o mesmo silêncio sobre os dados.
O manual do site especifica os três casos na §6.2 e o controller na §6.4 — e o
custo lá foi **uma linha**, o objeto de erro virando dois.

| Situação | Status | `error_code` | O que o agente conclui |
|---|---|---|---|
| não há linha nenhuma com essa referência | 404 | `REFERENCE_NOT_FOUND` | **nada foi cobrado**. É prova |
| a linha existe, mas o `steamId` não confere | 404 | `REFERENCE_NOT_MINE` | **não sei**. `unprovable`: não decide nada e vai para conferência humana |
| a linha existe, mas o `serverId` não confere | 404 | `REFERENCE_NOT_MINE` | idem — e é o caso do repareamento, o mais caro dos três |

O **corpo** dos dois é byte a byte o mesmo — mesma frase, sem `transactionId`,
sem `amount` e sem `steamid`. Ele não conta nada sobre a transação alheia,
exatamente como antes. A única coisa que o segundo código acrescenta é **parar de
mentir para o agente**.

**E o agente não pode tratar `REFERENCE_NOT_MINE` como 4xx desconhecido.** A
regra do §4.2 ("4xx com código que o agente não conheça → `unavailable` /
`network`, retentável com recuo") é a certa para códigos novos — mas aqui ela
poria o settler batendo no site todo minuto até o teto do §11.1, contra um 404
que nunca vai mudar. Por isso o código está **na tabela fechada do §4.2**, com
desfecho `unprovable`, e o `proveCharge` do §8.3 tem um ramo próprio para ele.

**Por que isso importa.** Um `SITE_SERVER_ID` trocado (repareamento, correção de
caixa alta — §22.10 avisa que `rust01` e `RUST01` são dois) transforma cobranças
**reais** em "nunca aconteceu": a referência antiga carrega o `serverId` de
ontem, a conferência `tx.serverId === req.serverId` falha, e o agente fecha a
compra com `CHARGE_NEVER_HAPPENED` com o dinheiro do jogador fora da conta. Ver
§11.4 e §20.6.

**Precisa de rate-limit por `serverId`.** O canal `/api/agent` é isento do
`globalLimiter` (`middleware/securityMiddleware.ts:30-36`) e este é o endpoint de
um laço de reconciliação.

**curl:**

```bash
curl -sS -G "$SITE_BASE_URL/api/agent/ozcoins/transaction" \
  --data-urlencode "referenceId=rust:$SITE_SERVER_ID:loja:p2n8x4q9zk1a" \
  --data-urlencode "steamId=$STEAM_ID" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0'
```

---

### 5.7 `GET /api/agent/deliveries/pending` — a fila

**Status:** **CRIAR** no site. Não há precedente nenhum: no DayZ e no Conan a
entrega é sempre PUSH do site.

**Query:** `limit` (1..100, default 50 — **o agent manda 50**) e `cursor`
(opcional, **opaco**: é o `next` da página anterior, e o agent nunca o parseia).
A fila já sai filtrada pelo `serverId` do header, por `status = 'pending'` e por
prazo não vencido — e **ordenada por `id ASC`**, do mais antigo para o mais novo
(§8.6 do manual do site).

`limit` acima do teto **não é recusado**: o site o clampa para
`AGENT_DELIVERY_PAGE_MAX` (100). Não existe 400 por `limit`.

**Resposta 200:**

```json
{
  "ok": true,
  "deliveries": [
    {
      "id": "DLV-9f3a1c2b7e04",
      "steamId": "76561198000000000",
      "kind": "item",
      "payload": { "items": [{ "shortname": "metal.refined", "amount": 100, "skinId": "0" }] },
      "sourceRef": "ITM-4b81c9e2a017",
      "attempts": 2,
      "createdAt": "2026-09-01T14:03:11.000Z",
      "expiresAt": "2026-10-01T14:03:11.000Z"
    }
  ],
  "next": null
}
```

> **Este é o MESMO objeto canônico que o §8.6 do manual do site mostra**, campo a
> campo — `DLV-9f3a1c2b7e04`, `attempts: 2`, os mesmos dois carimbos. A única
> diferença deliberada é o `next`: aqui ele é `null` porque o exemplo mostra a
> **última** página; lá ele repete o `deliveryId` porque o exemplo ensina a
> **paginação**. Qualquer outra divergência entre os dois corpos é defeito, não
> escolha — e a §23.2 é onde ela se conserta.
>
> O mesmo `DLV-9f3a1c2b7e04` reaparece no §21.7 do manual do site com
> `attempts: 3` e `lastReason: 'PLAYER_NOT_FOUND'`. Não é contradição: é a tela
> do admin olhando a **mesma tarefa um instante depois**, já com a terceira
> tentativa registrada. `createdAt` e `expiresAt` são iguais nos três lugares,
> porque esses não mudam.

**O vocabulário do `payload`, por `kind`.** Este é o contrato de entrega do Rust,
e ele existe porque o site **não tem** um: `services/deliveryTypes.ts` conhece
DayZ, SCUM e Conan, e `getGamePlugin` faz **fallback silencioso para DayZ**. O
site precisa aprender estes cinco formatos — **todos ativos desde 04/09/2026**,
ver a caixa logo abaixo —, e o agente precisa recusar tudo o que não for
exatamente um deles.

| `kind` | `payload` | Comando que o agente executa |
|---|---|---|
| `item` | `{ items: [{ shortname, amount, skinId }] }`, exatamente 1 item | `origemz.give <steamId> <shortname> <amount> <skinId> auto` |
| `kit` | `{ items: [{ shortname, amount, skinId }] }`, 1..40 itens | um `origemz.give` por item, em sequência |
| `vip` | `{ tier: string, days: number \| null }` | `vips.grant({ steamId, tier, expiresAt, origin:'loja', createdBy:'site' })` |
| `vehicle` | `{ prefab: string, fuel: number }` | `origemz.vehicle.spawn <steamId> <prefab> <fuel>` |
| `vip_revoke` | `{ tier: string }` | `vips.revoke(steamId, tier, 'site')` — e **nenhum comando de console**: quem sai do grupo sai pelo `apply` do `vips`, ou na reconciliação da próxima conexão |

**`vip_revoke` é o único que não entrega nada, e ele difere em três pontos**
(`core/src/site/deliveries.ts`, `#revokeVip`):

| Ponto | Entrega | `vip_revoke` |
|---|---|---|
| portão de presença | exige o jogador online (§10.3) | **não exige** — e o `kind: 'vip'` também não, desde 04/09/2026: quem manda no VIP é a tabela do agente. O caso mais comum de uma revogação é justamente quem parou de jogar; com o portão, ela ficaria `deferred` até o TTL de 30 dias enquanto o VIP estornado continuava valendo |
| linha órfã em `reserved` | vira `indeterminate` e **não reexecuta** (§10.4) | **reexecuta**: o medo do indeterminado é entregar duas vezes, e tirar o VIP duas vezes não tira nada na segunda |
| alvo que não existe | `failed` | **`delivered`**, sem `reason`: o estado que o site pediu já vale — ver §5.8 e a §3 do `Docs\27` |

####  A FASE 2 CHEGOU EM 04/09/2026: `kind: 'vip'` É OPERAÇÃO NORMAL  ####

**O site ligou o resgate de VIP de Rust** (`Docs\25` e `Docs\26` §3): ele
registrou o reconciliador, e as tarefas `kind: 'vip'` passaram a nascer de
resgate de jogador. A partir daí:

- **`kind: 'vip'` na fila não é mais defeito**, e o oitavo alarme do §18.4 está
  DESARMADO. Ele existia porque um `vip` só podia chegar por engano de cadastro;
  agora ele chega porque alguém comprou;
- **`kind: 'vip_revoke'` nasceu junto**, e é o que fecha o ciclo: estorno,
  chargeback, ban e o vencimento que a varredura do site percorre a cada minuto.
  Sem ele, revogar do lado de lá não tinha caminho até aqui — o VIP só sumia
  quando o relógio DESTE agente o expirasse;
- **`days: null` continua no contrato e nada no site o produz**: VIP vitalício
  não é vendável por lá nesta fase (o `expires_at` de lá é `NOT NULL`). O `null`
  continua saindo daqui, no espelho, e é lá que a divergência
  "vitalício aqui, com prazo lá" aparece.

O parágrafo abaixo é o estado ANTERIOR, guardado porque explica por que o
`CHECK`, o ramo do `planOfPayload` e a régua de `tier` já existiam antes de
qualquer tarefa chegar — e porque nada disso precisou nascer às pressas no dia
em que o site ligou a venda.

**Os quatro `kind` não eram igualmente ativos, e este documento tratava-os como
se fossem.** O manual do site decidiu por escrito (§11.4 e §23.3 de lá) que
`rust_vip` fica **fora** de `DELIVERY_TYPES_BY_GAME`, de
`DELIVERY_BY_KIND_BY_GAME` e de `DELIVERY_HANDLER`, e que `vip` fica fora de
`ITEM_KINDS_BY_GAME.rust`. Consequência direta: **nada no site consegue criar uma
tarefa `kind: 'vip'`** — nem o admin cadastrando um produto, nem o jogador
resgatando. Na fase 1 este `kind` **nunca chega em `/deliveries/pending`**.

O motivo é do site e é bom: a lei escrita de lá é que jogo sem reconciliação de
VIP não vende VIP. Com `rust_vip` registrado e sem reconciliador, o jogador
receberia o nível no jogo e **nenhum `UserVipGrant` nasceria** — o site não
saberia que ele tem VIP, nem quando vence.

**O que o agente faz com isso: nada, e é de propósito.**

| Continua existindo | Por quê |
|---|---|
| `'vip'` no vocabulário de `kind` e no `CHECK` da coluna do site | é **reserva** para a fase 2; relaxar um `CHECK` depois é uma migração a mais por nada |
| o ramo `vip` do `planOfPayload` (§14.6) e o `vips.grant` do `#deliver` | o caminho é o **mesmo** da compra in-game (§14.6), que está viva hoje e vende VIP pela loja local |
| a régua de `tier` e `days`, e o `UNKNOWN_VIP_TIER` | idem — a loja local os usa todo dia |

**O que mudava era só o que se devia ESPERAR:** um `kind: 'vip'` chegando pela
fila na fase 1 era **sinal de defeito do lado do site**, não operação normal. O
agente não o recusava por isso — executá-lo é o comportamento certo, e o caminho
estava testado —, mas era alarme, e o alarme foi desarmado em 04/09/2026, quando
o reconciliador do site subiu (§18.4).

**Se o dono decidir vender VIP de Rust pelo site**, o preço está escrito na §11.3
do manual do site: registrar um reconciliador de VIP de Rust, preencher
`vipTransport` em `gamePlugins`, e **só então** reabrir os quatro mapas. É
decisão de produto, e é a pergunta §22.5 deste documento — cuja resposta
recomendada é (a), *"VIP do Rust é vendido só in-game na fase 1"*, e é ela que o
site já implementou.

Réguas de cada campo, e elas são as do agente porque é ele quem executa. **Elas
são o contrato**: quem monta o payload do outro lado precisa das mesmas, ou
enfileira tarefa que já nasce recusada.

| Campo | Régua | De onde ela vem |
|---|---|---|
| `id` | string **opaca**, 1..64 chars, `/^[A-Za-z0-9._:-]+$/` | é do site (`DLV-<12 hex>`). O agente **nunca a parseia**: ela é só a chave primária de `site_deliveries` |
| `sourceRef` | string opaca, ≤ 64 chars, ou `null` | é o `inventory_items.item_ref` do site — `ITM-<12 hex>` para item avulso e **`KIT-<12 hex>`** para o item-kit (§23.2). Idem: opaca aqui. **O contrato aceita `null` e nada nesta fase o produz**: a coluna de lá é `NOT NULL` porque `item_ref` também é (`models/InventoryItem.ts:32`, §8.2 do manual do site), e a daqui é nulável só para não recusar um contrato que aceita. É a mesma nota do `expiresAt`, e ela precisa estar escrita nos dois: sem ela, nulável de um lado e `NOT NULL` do outro parece defeito de um dos dois |
| `expiresAt` | ISO, ou `null` | **o contrato aceita `null` e nada nesta fase o produz**: o site preenche sempre, com `now + AGENT_DELIVERY_TTL_DAYS` (§8.5 e §23.3 do manual do site). Mesma nota do `sourceRef`, pelo mesmo motivo |
| `shortname` | `/^[A-Za-z0-9._-]+$/`, 1..64 chars | `core/src/loadouts/items.ts:82-85` — é o que vai para a linha de comando do console, e um espaço ali fatiaria o comando |
| `amount` | inteiro **1..100 000** | `core/src/loadouts/items.ts:86` — `z.number().int().min(1).max(100_000)`. É a régua que o agente **já aplica** ao item de jogo |
| `skinId` | **string** de dígitos, `/^\d+$/`, ≤ 20 chars. `"0"` = sem skin | `core/src/loadouts/items.ts:87-92` |
| `tier` | 1..32 chars, normalizado para minúsculo | `core/src/vip/service.ts:799` devolve `UNKNOWN_VIP_TIER` para nível que nenhum servidor conhece |
| `days` | inteiro 1..3650, ou `null` para vitalício | dez anos é o teto que separa "vitalício" de dedo escorregado |
| `prefab` | `/^[a-z0-9._-]{1,64}$/` — o nome curto (`minicopter`, `rowboat`) **ou** o nome exato do jogo (`sedantest.entity`). **O ponto é legal.** Nunca `/`, nunca a extensão `.prefab` | o alfabeto vem da comparação do plugin (`Plugins/OrigemZAgent.cs:1160`); a preferência pelo nome curto vem de `core/src/db/store-repository.ts:111` e `core/src/http/routes/store.ts:171`: *"o caminho completo muda quando a Facepunch move um arquivo"* |
| `fuel` | inteiro 0..1000 | |
| cardinalidade | `item` = **exatamente 1** item; `kit` = 1..40 itens | um `item` com dois itens é um kit mal cadastrado, e 40 é o teto de um inventário que ainda cabe |

####  DOIS CAMPOS ONDE OS DOIS DOCUMENTOS PRECISAM CASAR  ####

**`skinId` é STRING, e não number.** Skin de workshop passa de 2^53: em `number`
ela volta **arredondada**, e o jogador receberia a arma com OUTRA skin, ou com
nenhuma, sem erro em lugar nenhum. Não é preferência — é a decisão que o código
do agente já tomou e da qual ele depende hoje:
`core/src/loadouts/items.ts:87-92` valida
`z.string().trim().regex(/^\d*$/).max(20).default('0')`, o cabeçalho `:16` diz
`####  O skinId É STRING  ####`, e a coluna do banco é `skin_id TEXT NOT NULL
DEFAULT '0'` (`core/src/db/migrations.ts:1305`).

**`prefab` é o NOME CURTO — e o PONTO É LEGAL.** Esta linha já esteve errada
neste documento, e o erro era o inverso do que parecia: o alfabeto que ela
publicava, `/^[a-z0-9_-]{1,64}$/`, **proibia o ponto**, e com ele proibia a única
forma de pedir alguns veículos.

Medido em `Plugins/OrigemZAgent.cs:1129-1174` (`ResolveVehiclePrefab`). O plugin
percorre `GameManifest.Current.entities`, joga fora a pasta e a extensão
`.prefab` de cada caminho (`:1156-1158`) e aceita o nome em duas passadas — exato
primeiro, prefixo depois:

```cs
if (file == needle || file == needle + ".entity")   // :1160  -> devolve na hora
...
if (byPrefix == null && file.StartsWith(needle))    // :1167  -> guarda o 1º parecido
```

Ou seja: para um arquivo `minicopter.entity.prefab`, **`minicopter` resolve** (bate
por `needle + ".entity"`) **e `minicopter.entity` também resolve** (bate exato). A
afirmação anterior — *"o jogo recusa; é um `failed` que devolve o veículo pago,
toda vez, para sempre"* — **é falsa**, e o que a tornava verdadeira era o próprio
regex deste documento: o schema vivo do agente não tem alfabeto nenhum
(`core/src/http/routes/store.ts:147`, `z.string().trim().min(1).max(64)`), então
quem recusava `minicopter.entity` era a régua inventada aqui, não o jogo.

####  PROIBIR O PONTO CUSTAVA O VEÍCULO CERTO  ####

`sedan` é **ambíguo**, e as duas medições estão escritas no plugin: o cabeçalho do
`origemz.vehicle.resolve` (`:969-981`) registra que `sedan` resolveu para
`sedanrail.entity` — o **vagão de trilho** — e *"o jogador pagou por um carro que
nasceu e não servia para nada"*; o comentário do `HandleVehicleSpawn`
(`:1064-1070`) registra a outra, `sedantest.entity`. Quem desempata é a passada de
PREFIXO (`:1167`), que devolve o primeiro que **começa** igual e depende da ordem
do manifesto — quer dizer, de nada que a gente controle.

A saída é escrever o **nome exato**, e o nome exato dos veículos tem ponto. O
comando `origemz.vehicle.resolve <nome>` existe exatamente para isso, e o
cabeçalho dele diz com todas as letras: *"para quem monta a oferta escolher pelo
nome exato em vez de torcer para o mais curto ganhar"*. Um alfabeto sem ponto
torna esse conselho **incadastrável**: o site recusaria `sedantest.entity` no
resgate com 400, e a única oferta de sedan possível seria a que nasce vagão.

####  O QUE CONTINUA PROIBIDO, E POR QUÊ  ####

| Forma | Desfecho | Por quê |
|---|---|---|
| `assets/content/vehicles/minicopter/minicopter.entity` | `VEHICLE_NOT_FOUND` (`:1074`) → ACK `failed` / `VEHICLE_VEHICLE_NOT_FOUND` | a comparação é contra o **basename** — a pasta é cortada em `:1156-1157`. Caminho nenhum casa, nem exato nem por prefixo |
| `minicopter.entity.prefab` | idem | a extensão é cortada **antes** da comparação (`:1158`), então o `.prefab` sobra e nada bate |

Por isso o `/` fica fora do alfabeto e o sufixo `.prefab` fica proibido por
escrito — o regex sozinho não o pega, já que ponto e letras são legais.

**A recomendação continua sendo o nome curto** quando ele é inequívoco, e a razão
é a de sempre: *"o caminho completo muda quando a Facepunch move um arquivo"*
(`core/src/db/store-repository.ts:111`). Mas recomendação não é régua: quem
**valida** recusando o ponto recusa junto o nome exato, que é a ferramenta que
existe para o caso caro.

Se o manual do site emitir `number` no `skinId` ou o caminho longo no `prefab`,
**os dois documentos estão errados até alguém reconciliar** — e o lado que cede é
o do site, porque o do agente tem evidência de código. Ver §23.

**Payload que não passar na validação NÃO é executado**: vira ACK `failed` com
`reason = 'PAYLOAD_INVALID'`, e o item volta para `available` no site. É melhor
o jogador resgatar de novo do que o agente adivinhar o que o site quis dizer.

**Enquanto os dois documentos não estiverem reconciliados**, e só enquanto,
`skinId` pode ser lido com
`z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String)`.
Isso é **remendo, não contrato**: ele salva a fase 1 de uma fila 100% recusada,
e some no commit em que o site passar a emitir string. Escreva-o com essa frase
ao lado, ou ele vira permanente.

**Cadência.** 15 s (`SITE_DELIVERY_POLL_MS`), e **imediatamente** quando um
jogador conecta — o `PresenceTracker` já dá esse gancho.

####  O `next` PRECISA SER LIDO, E A RODADA PRECISA PAGINAR  ####

**Uma página só não basta, e o buraco não estava escrito em nenhum dos dois
manuais.** Ele se monta com três fatos que, sozinhos, estão certos:

1. o site serve **só** `status = 'pending'`, **ordenado por `id ASC`** — do mais
   antigo para o mais novo (§8.6 do manual do site);
2. um ACK `deferred` **mantém a tarefa em `pending`** e só incrementa `attempts`
   (§8.3 do manual do site): ela **não sai da fila**, e volta na página seguinte;
3. `deferred` **não tem teto** — ausência de jogador não é falha (§10.6).

Junte os três: **cinquenta tarefas de jogadores que sumiram ocupam a primeira
página por até `AGENT_DELIVERY_TTL_DAYS` (30 dias), e a tarefa nº 51 nunca é
vista.** Quem comprou hoje espera o prazo inteiro dos que vieram antes. O sintoma
é o pior possível — a fila "está funcionando", os ACKs saem, o log não acusa
nada, e um item pago simplesmente nunca chega.

**A regra, e ela é do agent.** O site não precisa mudar nem a ordenação nem o
filtro; a caixa do §10.2 mostra por quê, e o que aconteceria se mudasse.

| Situação | O que a rodada faz |
|---|---|
| a página veio com `next: "<id>"` | processa, ACKa e **pede a próxima com `?cursor=<next>`** |
| a página veio com `next: null` | acabou a fila: processa, ACKa, **zera o cursor guardado** e encerra a rodada — a próxima começa do topo |
| já foram `DELIVERY_MAX_PAGES_PER_ROUND` páginas (**5**) | encerra a rodada e **guarda o último `next`**. A rodada seguinte **continua dali**, e não do começo |
| alguém **conectou** (`wake()`, §10.7) | a rodada começa **do topo, com o cursor zerado** — a cabeça da fila é exatamente onde moram os `PLAYER_OFFLINE`, e acabou de entrar gente |
| `400 INVALID_CURSOR` | **joga o cursor fora e recomeça a rodada do topo**, uma vez por rodada — ver a caixa abaixo |

**O cursor guardado entre rodadas é o que impede a inanição da cauda.** Com teto
e sem ele, toda rodada varreria as mesmas 250 primeiras tarefas e a de nº 251
continuaria invisível — o mesmo defeito, um degrau acima. Como o `id` do site é
`BIGSERIAL` e a ordem é `ASC`, **tarefa nova nasce no FIM**: continuar de onde
parou caminha *na direção* das tarefas novas, nunca ao contrário.

**A conta que fixa o teto em cinco páginas**, e ela é a do rate limit do outro
lado (`AGENT_RATE_LIMIT_PER_SERVER = 240` req/min por `serverId`, §13.1 do manual
do site):

```
por rodada :  ate 5 GET /deliveries/pending  +  ate 5 POST /deliveries/ack   = 10
por minuto :  10 x 4 rodadas                                                 = 40 req/min
pico total :  40 (fila) + 50 (settler em recuperacao) + 1 (espelho)          = 91 req/min
folga      :  240 / 91  ~=  2,6x
```

E o alcance: 250 tarefas por rodada, 1 000 por minuto. Uma fila represada de
5 000 tarefas é varrida inteira em **cinco minutos**, não em trinta dias.

**Não é variável de ambiente, e é de propósito.** `DELIVERY_MAX_PAGES_PER_ROUND`
mora como constante em `core/src/site/deliveries.ts` (§14.6), no mesmo lugar de
`DEFERRABLE`. Ele é derivado do rate limit do outro lado, e não do gosto de quem
opera: subi-lo sem subir `AGENT_RATE_LIMIT_PER_SERVER` troca fila parada por
`429` no meio da varredura.

**Erros desta rota:**

| HTTP | `error_code` | Quando | O laço faz |
|---|---|---|---|
| 400 | `INVALID_CURSOR` | o `cursor` não resolve para nenhuma linha **deste** `serverId` — o site o traduz para a PK com o `server_id` na cláusula (§8.6 do manual do site) | **descarta o cursor e recomeça a rodada do topo**, uma vez. Um segundo `INVALID_CURSOR` na mesma rodada encerra a rodada com `logger.error` |
| 429 | `AGENT_RATE_LIMITED` | a rodada apertou o teto | recua; a rodada seguinte pega o resto de onde parou |
| 4xx | qualquer outro | — | a regra do §4.2: `unavailable` / `network`, com recuo, e **sem** descartar o cursor |

####  `INVALID_CURSOR` TRATADO COMO "SITE INDISPONÍVEL" É UM LAÇO ETERNO  ####

Esta é a única linha desta seção que **precisa** de tratamento próprio, e é a
única em que a regra geral do §4.2 (*"4xx desconhecido → `unavailable`,
retentável com recuo"*) produz um defeito em vez de uma espera. `unavailable`
significa *"tente de novo igualzinho, daqui a pouco"* — e "igualzinho", aqui,
inclui **o mesmo cursor que o site acabou de recusar**. A cada 15 s, para
sempre, contra um 400 que nunca vai mudar; e como a rodada morre no primeiro
request, **nenhuma tarefa é entregue enquanto isso**. A fila para inteira, em
silêncio, por um cursor velho.

Quando um `cursor` deixa de resolver? Quando a tarefa que o gerou saiu de
`pending` — foi entregue, expirou, ou foi para `review`. Ou seja: **é um estado
esperado**, e não um acidente. O conserto é jogar fora a única coisa que está
errada — o cursor — e recomeçar do topo, que é sempre um lugar válido.

**curl** (a primeira página, e a continuação):

```bash
curl -sS "$SITE_BASE_URL/api/agent/deliveries/pending?limit=50" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0'

curl -sS "$SITE_BASE_URL/api/agent/deliveries/pending?limit=50&cursor=DLV-9f3a1c2b7e04" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0'
```

---

### 5.8 `POST /api/agent/deliveries/ack` — a prova da entrega

**Status:** **CRIAR** no site.

**Corpo:** lote de até 50.

```json
{
  "deliveries": [
    { "id": "DLV-9f3a1c2b7e04", "status": "delivered", "at": "2026-09-02T14:00:00.000Z" },
    { "id": "DLV-1c77a0b93de5", "status": "deferred", "reason": "PLAYER_SLEEPING", "at": "2026-09-02T14:00:00.000Z" },
    { "id": "DLV-6ba2f10c48d7", "status": "failed", "reason": "ITEM_NOT_FOUND", "at": "2026-09-02T14:00:00.000Z" },
    { "id": "DLV-04e9c5183ba6", "status": "deferred", "reason": "AGENT_INDETERMINATE", "at": "2026-09-02T14:00:00.000Z" }
  ]
}
```

| Campo | Tipo | Nota |
|---|---|---|
| `id` | string | o `deliveryId` que veio na fila |
| `status` | `'delivered' \| 'failed' \| 'deferred'` | **três, e só três** — ver a semântica abaixo |
| `reason` | string ≤ 200 | o **código cru**, da lista fechada abaixo — nunca a frase |
| `at` | ISO | o relógio do agente |

**A semântica dos três status é o ponto todo:**

| Status | O que o site faz | Quando o agente usa |
|---|---|---|
| `delivered` | finaliza: `inventory_item` → `delivered` + `deliveredAt`. **Irreversível** | o comando respondeu `{"ok":true}` |
| `failed` | falha **DEFINITIVA**: devolve o item para `available` | o erro não melhora sozinho |
| `deferred` | **mantém pendente**, `attempts++`, item segue em `processing` | não deu **agora**; vai dar depois |
| `deferred` **com `reason: 'AGENT_INDETERMINATE'`** | **estaciona**: o site move a tarefa de `pending` para `review`, o item **fica** em `processing`, a tarefa **sai da fila** e a varredura de expiração **não a toca** | o agente **não sabe** se o comando saiu (§10.4) |

Sem `deferred`, um item pago voltaria para `available` só porque o jogador estava
dormindo — e é exatamente o furo que o guard do SCUM do site documenta.
"Não entreguei" e "ainda não" são coisas diferentes, e a segunda não pode ser
dita com a palavra da primeira.

####  A LISTA FECHADA DE `reason`, E O ACK DE CADA UM  ####

Ela é **fechada** de propósito: é ela que a tela de operação do site traduz para
português, e um código fora dela aparece cru para quem está de plantão. São
**dezoito linhas**, e elas têm três origens medidas:

- os **oito primeiros** são a lista inteira do `origemz.give`, traduzida em
  `core/src/kits/service.ts:646-667`;
- os **dois de veículo** nascem do `origemz.vehicle.spawn`
  (`Plugins/OrigemZAgent.cs:1046-1120`), e o `#deliver` prefixa o código cru com
  `VEHICLE_` antes de deixá-lo sair (`core/src/store/service.ts:381`) — é por
  isso que a resposta `{"error":"NO_SPACE"}` do plugin chega no fio como
  `VEHICLE_NO_SPACE`;
- os **oito restantes** nascem no próprio agente, antes ou em volta do comando.

| `reason` | ACK | Por quê |
|---|---|---|
| `PLAYER_NOT_FOUND` | `deferred` | o jogador saiu antes da entrega; ele volta amanhã |
| `PLAYER_DEAD` | `deferred` | ele precisa renascer para receber |
| `PLAYER_SLEEPING` | `deferred` | idem |
| `INVENTORY_FULL` | `deferred` | com `auto` o item cai no chão; se nem isso deu, o mundo estava cheio — tente de novo |
| `DROP_FAILED` | `deferred` | não deu para largar no chão **agora** |
| `ITEM_NOT_FOUND` | `failed` | o jogo não conhece este shortname. Não melhora sozinho |
| `TOO_MANY_STACKS` | `failed` | a quantidade daria pilhas demais: é o catálogo que está errado |
| `INVALID_AMOUNT` | `failed` | a quantidade está fora da faixa do jogo: idem |
| `PLAYER_OFFLINE` | `deferred` | a presença disse que ele não está aqui (§10.3) |
| `PRESENCE_UNAVAILABLE` | `deferred` | não deu para **perguntar** quem está online. Nada é tentado às cegas |
| `RCON_UNAVAILABLE` | `deferred` | o agente não está conectado ao RCON daquele servidor |
| `PAYLOAD_INVALID` | `failed` | o payload não passou na régua do §5.7 |
| `UNKNOWN_VIP_TIER` | `failed` | nenhum servidor conhece esse `tier` (`core/src/vip/service.ts:799`) |
| `GIVE_UNREADABLE` | `failed` | o `origemz.give` respondeu algo que não é JSON, ou sem `error` legível (`core/src/store/service.ts:362`) |
| `VEHICLE_NO_SPACE` | `deferred` | não cabe veículo onde ele está — ele sai da base e tenta de novo |
| `VEHICLE_*` (qualquer outro) | `failed` | o `#deliver` prefixa o código do plugin de veículo com `VEHICLE_`; o resto não melhora sozinho |
| `VIP_GRANTER_UNAVAILABLE` | `failed` | tarefa de VIP num agente sem o concessor ligado (`core/src/store/service.ts:390`) |
| `AGENT_INDETERMINATE` | `deferred` | o processo morreu entre o comando e o ACK. **Não sabemos** — e o site move a tarefa para `review` |

**Nada fora desta lista sai daqui.** O mapeamento é uma constante e uma função,
não prosa — ver §14.6, `DEFERRABLE` e `ackOf`.

####  O INDETERMINADO CABE EM `deferred`, E O `reason` É QUE O CARREGA  ####

**Esta era a divergência mais cara entre os dois manuais, e ela está fechada:
são TRÊS valores no fio, e o quarto (`review`) não existe.** O agente tem um
desfecho que os três status parecem não cobrir: *"o processo morreu entre o
`origemz.give` e o ACK; o comando PODE ter saído"* (§10.4). Se ele simplesmente
não ACKar, a tarefa fica `pending` no site, com `expires_at` intocado, até o
relógio de expiração devolvê-la a `available` em `AGENT_DELIVERY_TTL_DAYS`. O
jogador resgata de novo, o site cria tarefa nova com `delivery_id` novo, o agente
não tem memória dela, e entrega. **Item duplicado, uma cobrança** — exatamente a
invariante "na dúvida, PRESERVA" invertida.

O buraco fecha **dentro** dos três valores: o agente ACKa
`{ "status": "deferred", "reason": "AGENT_INDETERMINATE" }`, e o site reage ao
`reason`, não a um status novo. Do lado de lá (§8.3 do manual do site):

- a tarefa sai de `pending` e vira **`review`**, com `last_reason` gravado;
- o `inventory_item` **fica** em `processing` — não volta para `available`;
- a tarefa **some de `/deliveries/pending`**: o agente não a vê mais, e não há
  como entregá-la duas vezes por essa via;
- a varredura de expiração **nunca toca `review`**, e ainda carrega o cinto de
  segurança `last_reason <> 'AGENT_INDETERMINATE'` (§8.9 do manual do site) para
  o caso de a tarefa ter ficado em `pending` por qualquer outro motivo;
- a saída é humana: **Reprocessar** ou **Liberar** (§21.8 do manual do site).

**Por que o quarto valor foi descartado, e ele chegou a estar escrito aqui.**
Um `status: 'review'` no fio custaria versionar os dois lados no MESMO instante:
o site recusa qualquer valor fora dos três com **400 `INVALID_ACK_STATUS` para o
lote inteiro** (§8.7 do manual do site, regra 6), então um único ACK
indeterminado num lote de 50 derrubaria os outros 49 — e o desfecho seria
justamente o que o §10.4 existe para impedir. `AGENT_INDETERMINATE` custa uma
palavra reservada num campo que já viaja, é ignorado por qualquer versão antiga
do site, e ainda ganha o cinto de segurança da varredura. **`AGENT_INDETERMINATE`
é o único `reason` que o site INTERPRETA**; todos os outros são texto de
diagnóstico.

**E o `attempts` NÃO sobe neste ACK.** Este `deferred` não é um adiamento: a
linha do site grava `last_reason` e `last_attempt_at` e vai direto para `review`,
sem incrementar o contador (§8.3 do manual do site). O agente não deve esperar
`attempts + 1` na próxima leitura — a tarefa nem volta a aparecer em
`/deliveries/pending`.

**Resposta 200:**

```json
{ "ok": true, "applied": 3, "unknown": ["DLV-0000deadbeef"] }
```

####  `unknown` NÃO SIGNIFICA "NÃO ACONTECEU"  ####

`unknown` traz os ids que o site não reconhece **naquele momento**: não existem,
são de outro `server_id`, **ou já estão em estado terminal por outro caminho** —
e um `delivered` reACKado cai exatamente nesse último caso.

**A regra do site, literal e com a exceção que ela tem** (§8.7 do manual do site,
regras 2 e 3-bis): *"tarefa em estado terminal (`delivered`, `failed`) entra em
`unknown`, sem erro — com a ÚNICA exceção da regra 3-bis"*. Tarefa em
`needs_admin` **também** entra em `unknown`, porque o agente nunca a recebeu: ela
não sai em `/deliveries/pending`, e um ACK sobre ela só pode ser ruído. Tarefa em
`review`, ao contrário, **aceita** ACK — ela saiu da fila com o agente ainda
podendo ter um desfecho a contar.

####  A REGRA 3-BIS: `delivered` VENCE `expired`  ####

**Este documento parafraseava a regra de lá como *"tarefa que não é `pending`
(nem `review`) entra em `unknown`"*, e a paráfrase estava errada** — ela apagava a
exceção inteira. O efeito prático deste lado é **nulo**: o id volta em `applied`,
e não em `unknown`. E é justamente por isso que a paráfrase errada era cara — ela
é a que alguém copia para montar o dublê da rota de ACK, e um dublê que devolva
esse `delivered` em `unknown` faz o teste passar contra um site imaginário.

A exceção existe por causa de uma janela real: o relógio de expiração do site roda
a cada 5 minutos e o agente pode estar no meio de um `origemz.give`. Uma tarefa
pode expirar **entre o pull e o ACK**, e ao expirar o `inventory_item` volta para
`available` (§8.9 do manual do site). Se o ACK `delivered` chegasse depois disso e
o site o descartasse em `unknown`, o jogador teria **recebido no jogo e ainda
poderia resgatar de novo**: entrega dupla, uma cobrança.

Então, do lado de lá:

- um ACK **`delivered`** sobre tarefa `expired` **é aplicado**: a tarefa vira
  `delivered` e o `inventory_item` volta para `delivered`, com
  `where: { id, status: 'available' }` — se o item já saiu de `available` por
  outro caminho, a tarefa fecha mesmo assim e o item não é tocado;
- **`failed` e `deferred` sobre `expired` continuam caindo em `unknown`**: só a
  **prova de entrega** justifica reabrir o que o relógio fechou.

Deste lado não nasce ramo novo — o id vem em `applied` e a linha local fecha como
sempre. O que nasce é a obrigação de o dublê dizer a mesma coisa que o site.

Então o agente **não pode** tratar `unknown` como "esqueça esta linha". Ele
separa por **estado local**:

| Estado local do id que voltou em `unknown` | O que o agente faz |
|---|---|
| `reserved` ou `indeterminate` | vira `expired` e sai do cache — a tarefa não é mais nossa |
| `delivered` ou `failed` | **marca `acked_at` e MANTÉM a linha.** Nunca `forget` |

A segunda linha é a que preserva o comprovante. A migração 036 existe para
responder *"o site diz que entregou; entregou mesmo?"* meses depois — e apagar a
linha no primeiro reACK jogaria fora justamente a resposta.

**ACK repetido do mesmo desfecho não muda nada no site** (`applied` não o conta),
e é isso que torna seguro reenviar um lote inteiro depois de um timeout. Mas
**ele volta em `unknown`**, e isso *não* quer dizer que a entrega não aconteceu.

**Erros desta rota — e o primeiro deles é o único do documento que derruba
quarenta e nove entregas boas junto com uma ruim:**

| HTTP | `error_code` | Quando | O laço faz |
|---|---|---|---|
| 400 | `INVALID_ACK_BODY` | `deliveries` ausente, não-array, **vazio**, ou com **mais de 50** itens | não reenvia o mesmo corpo: parte a lista em lotes de 50. Um lote vazio nunca deve sair daqui — é defeito do laço, não do site |
| 400 | `INVALID_ACK_STATUS` | algum `status` fora de `delivered \| failed \| deferred` | **o lote INTEIRO foi recusado**: nenhum dos até 50 desfechos entrou, e as 50 tarefas continuam `pending` do lado de lá. Não reenviar o mesmo corpo, e **alarme** (§18.4) — é defeito de contrato, e o único jeito de ele aparecer é alguém ter reintroduzido um quarto valor |
| 500 | `ACK_FAILED` | erro real do lado do site | o lote **não foi gravado**. Reenviar o lote inteiro na volta seguinte é seguro, e é exatamente para isso que o ACK é idempotente |

**Nenhum destes três apaga linha local.** A linha em `site_deliveries` só ganha
`acked_at` quando o site confirma (§10.2, passo 4); enquanto o ACK não passa, ela
continua aberta e volta no lote seguinte. Um ACK perdido custa uma volta de 15 s;
uma linha apagada cedo demais custa o comprovante da entrega (§15.2).

**curl:**

```bash
curl -sS -X POST "$SITE_BASE_URL/api/agent/deliveries/ack" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0' \
  -d '{"deliveries":[{"id":"DLV-9f3a1c2b7e04","status":"delivered","at":"2026-09-02T14:00:00.000Z"}]}'
```

---

### 5.9 `POST /api/agent/shop/mirror` — o espelho do catálogo

**Status:** **CRIAR** no site. O desenho existente é o inverso (o site monta, o
agente puxa com ETag), então a rota, a tabela e a tela do painel são novas.

**Corpo** (teto de 2 MiB, recusado ANTES de sair do agente):

```json
{
  "version": "9f2c…64 hex…a1",
  "generatedAt": "2026-09-02T14:00:00.000Z",
  "currency": "OZ",
  "categories": [
    { "id": "kits", "name": "Kits", "position": 1, "enabled": true }
  ],
  "offers": [
    {
      "id": "kit-metal",
      "categoryId": "kits",
      "kind": "kit",
      "name": "Kit Metal",
      "price": 250,
      "oldPrice": 400,
      "badge": "PROMO",
      "position": 1,
      "enabled": true,
      "icon": { "shortname": "metal.refined", "itemId": 69511070, "skinId": "0" },
      "itemCount": 6,
      "perks": []
    }
  ]
}
```

`oldPrice` e `badge` são **anuláveis**: uma oferta sem promoção manda
`"oldPrice": null` e `"badge": null`. O exemplo acima carrega os dois preenchidos
de propósito — é o caso que exercita o campo, e é o mesmo objeto que aparece na
§9.2 e na §21.4 do manual do site, byte a byte (§23.2).

**O que NÃO viaja:** os `items[]` da entrega. O que o Rust spawna é receita do
agente. Vazar isso daria ao painel do site — e a qualquer um que leia a resposta
dele — a receita da entrega, e é a mesma lei que o catálogo do Conan aplica ao
não expor `delivery` para o cliente do jogo.

**Resposta 200:** `{ "ok": true, "accepted": true, "version": "9f2c…", "storedAt": "…" }`

**Erros — cinco, e o agente trata cada um de um jeito:**

| HTTP | `error_code` | Quando | O `CatalogMirror` faz |
|---|---|---|---|
| 400 | `MIRROR_INVALID_VERSION` | `version` não é 64 hex | grava `lastPushError` e **não reenvia igual**: é defeito nosso |
| 400 | `MIRROR_INVALID_BODY` | `categories`/`offers` não são array, oferta sem `id`, `price` não inteiro ≥ 0 | idem — **é o erro mais provável de um espelho mal montado**, e reenviar o mesmo corpo é laço |
| 400 | `SHOP_GAME_NOT_SUPPORTED` | o `serverId` autenticado **não é de um servidor de Rust** no site: o controller resolve `servers.game` na entrada e recusa o que não for `rust` (§9.2 do manual do site) | grava `lastPushError` e **para de empurrar até a `version` mudar**. Reenviar não adianta: o conserto é no **cadastro** do site, não no corpo — é o mesmo `game` que o §22.10 avisa que precisa existir antes de qualquer coisa |
| 413 | `MIRROR_TOO_LARGE` | corpo acima de 2 MiB | idem, e o agente já devia ter recusado ANTES de sair (§13.3) |
| 500 | `MIRROR_STORE_FAILED` | erro real do lado do site | grava `lastPushError` e **tenta no próximo minuto**: é retentável |

Os cinco aparecem crus em `catalog.lastPushError` no `GET /api/site/status`
(§9.6) — é ali que alguém descobre por que o painel do site mostra a loja de
ontem. `SHOP_GAME_NOT_SUPPORTED` é o que aparece quando o `Server` do site existe
mas nasceu com `game` errado, e ele é **indistinguível de "a loja não sincroniza"
sem essa tela**: a mesma trava por jogo que o `requireConanServer`
(`agent-shop.controller.ts:47-63`) já aplica do outro lado.

**Snapshot SUBSTITUI, nunca faz merge.** Produto que sumiu do espelho saiu da
loja, não foi esquecido — merge deixaria produto apagado à venda para sempre.

**curl:**

```bash
curl -sS -X POST "$SITE_BASE_URL/api/agent/shop/mirror" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0' \
  --data-binary @mirror.json
```

---

### 5.10 `GET /api/agent/shop/mirror/version` — a pergunta barata

**Status:** **CRIAR** no site.

**Sem parâmetros.** Resposta:

```json
{ "ok": true, "version": "9f2c…64 hex…a1", "updatedAt": "2026-09-02T14:00:00.000Z" }
```

`version: null` = o site não tem espelho nenhum deste servidor.

Existe para o agente não reenviar 2 MiB a cada volta do relógio. Espelha o par
`/shop/version` + `/shop/catalog` do Conan, com a direção invertida.

**Um erro, e é o mesmo da rota irmã:** `400 SHOP_GAME_NOT_SUPPORTED` quando o
`serverId` autenticado não é de um servidor de Rust. Ele é a **primeira** coisa
que o agente vê quando o cadastro do site está errado, porque esta rota roda
antes do push — e por isso vale ler o `error_code` aqui em vez de tratar todo 400
como "não tem espelho ainda". `version: null` significa *"nunca me mandaram
espelho"*; `SHOP_GAME_NOT_SUPPORTED` significa *"você não devia estar falando
comigo"*, e as duas leituras levam a lugares opostos.

**curl:**

```bash
curl -sS "$SITE_BASE_URL/api/agent/shop/mirror/version" \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H "X-Server-Id: $SITE_SERVER_ID" \
  -H 'User-Agent: OrigemZ-Rust-Agent/1.0'
```

---

### 5.11 O que o agent NÃO consome, e por quê

| Rota do site | Por que o Rust não a chama |
|---|---|
| `POST /api/agent/shop/purchase` | travada em `conanexiles` por `requireConanServer` (`agent-shop.controller.ts:47-63`): um bearer de Rust alcança a rota e toma `400 SHOP_GAME_NOT_SUPPORTED`. E ela exige que o **site** seja dono do catálogo — fase 2 (§22, pergunta 1) |
| `GET /api/agent/shop/version` e `/shop/catalog` | mesma trava, e a direção é a inversa da nossa: quem tem catálogo aqui é o agente |
| `POST /api/agent/vip/grant` | travada em `dayz`; é migração de VIP legado do mod SIG_Vip, não concessão |
| `/api/agent/cosmetics/*` | skins e sets do site; o Rust não tem esse inventário |

Nenhuma delas some, nenhuma delas muda. Elas estão listadas para que ninguém
gaste uma tarde descobrindo a trava sozinho.

---

## 6 — A convenção de `referenceId`

### 6.1 O formato

```
compra   rust:<serverId>:loja:<purchaseId>
estorno  rust:<serverId>:loja:<purchaseId>:refund
```

E, em geral, `rust:<serverId>:<escopo>:<chave>` — o mesmo formato que o agente do
Conan usa (`conan:<serverId>:<escopo>:<chave>`), trocando só o jogo. Escopos
previstos: `loja` (compra in-game) e, se um dia existir, `entrega` (o par de
dinheiro de uma entrega vinda do site — hoje ela não move dinheiro).

### 6.2 Por que o prefixo não é enfeite

`ozcoin_transactions.reference_id` é `UNIQUE` na tabela **inteira**, entre todos
os jogos (`models/OzCoinTransaction.ts:13`). O `purchaseId` que o agente gera
hoje tem cerca de 14 caracteres e nenhuma marca de origem
(`core/src/store/service.ts:163-165`).

Uma colisão com o DayZ ou o Conan não dá erro. Ela faz o site achar a transação
alheia no lookup (`agent-ozcoins.controller.ts:80-83`) e devolver
`{ success: true, idempotent: true, ... }` com HTTP 200. O agente lê sucesso,
entrega o item, e o débito **desta** compra nunca aconteceu. O jogador leva o
item de graça, e a resposta parece um dia normal.

Há ainda dois prefixos do site que **não podem** ser tocados, porque outro código
faz parse deles:

- `admin-%` é **excluído** do relatório de Receita OZ
  (`ad_oz_backend/services/statsService.ts` e `admin-system.controller.ts`);
- `slotpkg:%` é fatiado por `split(':')[2]` para virar o `pkgId` de um relatório.

O prefixo `rust:` não colide com nenhum dos dois, e é por isso que ele começa com
o nome do jogo e não com o do servidor.

### 6.3 O teto: 120 no total, 113 na compra

```ts
export const REFERENCE_MAX_CHARS = 120;              // o limite do site
export const REFUND_SUFFIX = ':refund';              // 7 chars
export const PURCHASE_REFERENCE_MAX_CHARS = 113;     // 120 - 7
```

Os 7 reservados vêm de uma dor medida no Conan: um `referenceId` de 115 chars
**passa** na compra e faz o **estorno** tomar 400 — no único caminho em que o
jogador já pagou e não recebeu nada. O teto da compra existe para que o estorno
sempre caiba.

### 6.4 O fallback: sha256, nunca corte de cauda

```ts
// core/src/store/reference.ts

import { createHash } from 'node:crypto';

/**
 * A referência de uma movimentação de OZ no site.
 *
 * ####  O PREFIXO NÃO É ENFEITE  ####
 *
 * `reference_id` é ÚNICO na tabela inteira do site, entre DayZ,
 * Conan e Rust. Sem `rust:<serverId>:`, uma colisão devolve a
 * transação ALHEIA com `idempotent: true` — e o débito desta compra
 * nunca acontece: o jogador leva o item de graça e a resposta parece
 * sucesso.
 *
 * ####  QUANDO NÃO CABE, A CHAVE VIRA HASH — NUNCA UM CORTE  ####
 *
 * Cortar a cauda foi o bug que o painel do Conan pagou: a chave de
 * uma linha de pedido TERMINA com o índice dela (`:0`, `:1`), e o
 * corte tira justamente esse índice. Todas as linhas passavam a
 * mandar a MESMA referência, o site respondia `200 idempotent`, e o
 * painel entregava de novo — dois itens, uma cobrança.
 */
export function buildReference(serverId: string, scope: string, key: string): string {
  const prefix = `rust:${serverId}:${scope}:`;
  const full = `${prefix}${key}`;

  if (full.length <= PURCHASE_REFERENCE_MAX_CHARS) {
    return full;
  }

  // Determinístico: a mesma chave produz sempre a mesma referência,
  // e é isso que mantém a idempotência viva do outro lado do corte.
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);

  return `${prefix}${digest}`;
}

/** A referência do estorno. Ver §12: repetir com ela é SEGURO. */
export function refundReferenceOf(reference: string): string {
  return `${reference}${REFUND_SUFFIX}`;
}
```

**A conta que garante que o hash sempre cabe:** `SITE_SERVER_ID` é limitado a 50
chars pelo próprio site (`agent-public.routes.ts:41-43`), e o agente recusa subir
com mais que isso (§16). Com o escopo mais longo previsto (`entrega`, 7 chars), o
prefixo tem no máximo `5 + 50 + 1 + 7 + 1 = 64` chars; somado ao digest de 32,
dá 96 — dentro dos 113. Não existe entrada que estoure.

### 6.5 O que muda no código de hoje

Hoje o `reference` passado à carteira é o `purchaseId` cru
(`core/src/store/service.ts:281-286`) e o estorno deriva `:credit` dentro da
carteira (`core/src/store/wallet.ts:211-216`). Depois:

- `StoreService.buy` monta `reference = buildReference(siteServerId, 'loja', purchaseId)`
  e **grava a referência na linha da compra** (coluna nova `reference`,
  migração 035). Sem ela gravada, uma mudança futura na convenção deixaria o
  histórico irreconciliável contra o ledger do site.
- `SiteWallet.credit` deriva `:refund`, não `:credit`.
- A `LocalWallet` continua recebendo a mesma `reference` e a grava em
  `wallet_entries.reference` como sempre — para ela o formato é opaco.

---

## 7 — Identidade do jogador

### 7.1 `steamId`: 17 dígitos, string, dos dois lados

Uma única régua, e ela já existe nos dois repositórios:

| Onde | Como |
|---|---|
| RustAgent, borda HTTP | `assertSteamId(steamId)` → `ApiError('INVALID_STEAM_ID', …, 400)` (`core/src/bans/service.ts:677-687`) |
| RustAgent, padrão | `STEAM_ID_PATTERN = /^\d{17}$/` (`core/src/bans/rust-bans.ts:54`) |
| RustAgent, do plugin | validado por zod nos três schemas de transporte do CUI |
| Site | `STEAM_ID_PATTERN = /^\d{17}$/` (`ozCoinsMutation.ts:28`) |

O `steamId` **nunca vem de argumento** no caminho do jogo: no clique ele sai da
conexão do jogador, e o `serverId` sai da conexão RCON por onde a linha chegou.
Isso não muda, e é o que impede alguém de comprar no saldo de outro.

### 7.2 O stub criado por `findOrCreate`, e por que `exists` saiu do contrato

Um jogador de Rust que nunca abriu o site é o caso **mais comum**, e o site já o
resolve — de um jeito que precisa ser **entendido, não consertado**.

Nas duas rotas, o site faz:

```js
// agent-ozcoins.controller.ts:48-55 (balance) e ozCoinsMutation.ts:151-160 (mutate)
const [user] = await User.findOrCreate({
  where: { steamId },
  defaults: { steamId, username: 'Player_' + steamId.slice(-4), ozBalance: 0 }
});
```

A conta nasce **na própria consulta**. Era por isso que `exists: true` estava
escrito literalmente na resposta — não era calculado, e nunca seria `false`.

✅ **E foi por isso que o campo SAIU, em `oz-rust/6` (04/09/2026).** A resposta
tem hoje **duas chaves**: `{ steamid, moedas }`. Um campo constante convida o
próximo cliente a ramificar por algo que nunca é falso, e o dono preferiu removê-lo
a fazê-lo mentir menos. **O `findOrCreate` continua** — o DayZ em produção depende
dele.

**Consequências para o agente, e as três são regras:**

1. **Não existe `exists` para ramificar.** O `SiteWallet` nunca leu o campo, e o
   `SiteClient` o **sintetiza** (`core/src/site/client.ts:177`) — foi essa
   indireção que fez a remoção no site não custar nada aqui. Uma tela do tipo
   "você ainda não tem conta, cadastre-se" ramificaria por algo que nunca
   acontece, e agora nem chega no fio.
2. **Todo débito de quem nunca comprou OZ cai em 422.** `ozBalance: 0` menos
   qualquer preço dá `after < 0`, e `ozCoinsMutation.ts:164-169` lança 422 com a
   frase pronta. Isso é o desenho, não um defeito: **OZ se compra no site**.
3. **A consulta de saldo cria linha.** Por isso a grade da loja não consulta
   saldo — só o modal (`core/src/game/ui-store-bridge.ts:96-102`). Manter esse
   comportamento deixou de ser só economia de rede: agora ele também segura o
   volume de contas-fantasma.

### 7.3 O que a loja mostra para quem tem 0 OZ

A frase vem do **site**, crua, e o agente acrescenta o caminho:

```
Saldo insuficiente. Voce tem 0 OZ, o item custa 250 OZ (faltam 250).
Compre OzCoins no site OrigemZ.
```

A primeira linha é literalmente o `err.message` de `ozCoinsMutation.ts:166`
(sem acento em "Voce" — é assim que o site escreve, e reescrever criaria duas
versões da mesma história para o suporte). A segunda é do agente.

Isso **muda** `describePurchase` (`core/src/store/service.ts:505-509`), que hoje
monta a frase inteira sozinha:

```
antes:  `Saldo insuficiente: são ${price} OZ e você tem ${balance}.`
depois: outcome.message + '\nCompre OzCoins no site OrigemZ.'
```

E o porquê da mudança é o mesmo porquê do comentário que já está lá
(`service.ts:489-493`, *"Ela é montada AQUI, e não no plugin"*): a frase tem de
ser montada onde está a informação. Quando o dono do saldo é o site, é ele que
sabe quanto falta — inclusive depois de uma compra que aconteceu no site enquanto
o jogador olhava o modal.

**A `LocalWallet` continua montando a frase equivalente**, com o mesmo formato,
para que o desfecho `insufficient` tenha sempre um `message` e o `describePurchase`
não precise de um `if` (§8.4).

### 7.4 O saldo local vira histórico

Com `SITE_BASE_URL` preenchida:

- `wallets` e `wallet_entries` **param de ser escritos** pela loja — a
  `LocalWallet` nem é construída.
- `GET /api/players/:steamId/wallet` continua devolvendo `entries` do banco
  **local**, e eles são **história**. O comentário em
  `core/src/http/routes/store.ts:455-458` já avisa; a tela do painel precisa
  dizer isso em voz alta, senão o suporte compara dois extratos e conclui que um
  está errado. O extrato **de verdade** de quem tem carteira remota é o do site.
- `POST /api/players/:steamId/wallet` continua recusando com
  `409 WALLET_IS_REMOTE` (`store.ts:483-491`). Esse comportamento já está certo e
  não muda; só a mensagem ganha o caminho da tela do site.
---

## 8 — A classe `SiteWallet`

### 8.1 O desenho em três camadas

```
   StoreService ─┐
   settle.ts   ──┼──▶  Wallet (interface)  ◀── LocalWallet   (SQLite)
   ui-store    ──┘            ▲
                              └────────────  SiteWallet     ──▶ SiteClient ──▶ HTTP
                                             (traduz o                (headers,
                                              dialeto)                 timeout,
                                                                       parse)
```

Três camadas, e cada uma com um motivo:

- **`SiteClient`** (`core/src/site/client.ts`) é transporte **e é a fronteira do
  vocabulário**. Ele sabe de headers, de `AbortController`, de `User-Agent`, de
  JSON que não dá para ler, e é o **único** lugar do RustAgent onde os nomes
  `moedas` e `observacao` aparecem. Ele não sabe o que é uma compra.
- **`SiteWallet`** (`core/src/store/site-wallet.ts`) é tradução de protocolo:
  status HTTP + `error_code` → um dos cinco `WalletChange`. Ele não sabe o que é
  um `fetch`, e **não sabe que existe um campo chamado `moedas`**.
- **`StoreService`** continua sem saber de nenhum dos dois.

####  ONDE `moedas` VIRA `balance`, EXATAMENTE  ####

Na **saída** do `SiteClient`, e em lugar nenhum mais. `client.balance()` devolve
`{ balance: number | null; exists: boolean }`, e `client.mutate()` devolve
`{ success, idempotent, balance, before, after, amount, transactionId }` — todos
já com os nomes da casa, e os de dinheiro já convertidos de string para inteiro
pelo `toInteger` que mora **lá**.

Isso não é organização: é o que faz o critério de aceite do §21.1 poder ser um
`grep`. Se a tradução acontecesse na carteira, `moedas` apareceria em dois
arquivos, e a partir daí ninguém sabe qual usar — que é exatamente a regra de
`ozCoinsMutation.ts:11-15`, do outro lado do fio.

O corpo de **erro** continua cru (`Record<string, unknown>`): `charged` e
`balance` do 422 e do 409 já têm o nome da casa, e um parse estruturado de erro
seria uma segunda verdade sobre o que o site pode mandar quando quebra.

Separar as duas primeiras não é gosto: o `SiteClient` também serve ao beacon, à
fila de entregas e ao espelho do catálogo, que não têm nada a ver com carteira.
Se o transporte morasse na carteira, o beacon dependeria da carteira.

### 8.2 O que muda na interface `Wallet`

```ts
// core/src/store/wallet.ts   — antes → depois

// ---- WalletBalance ----
- readonly balance: number;
+ /**
+  * `null` = NÃO CONSEGUI PERGUNTAR, e isso é diferente de zero.
+  *
+  * O modal já sabe lidar com `null`: `affordable = balance === null ||
+  * balance >= total` (ui-store-screens.ts:718) deixa o botão de comprar
+  * no lugar. Com zero ele o esconde e diz SALDO INSUFICIENTE a quem tem
+  * dinheiro — que é o oposto do que ui-store-bridge.ts:110-118 mandou.
+  */
+ readonly balance: number | null;

// ---- WalletChange ----   (a união inteira do §4.1)
- | { status: 'ok'; balance }
- | { status: 'insufficient'; balance }
- | { status: 'unavailable'; reason }
+ | { status: 'ok'; balance; transactionId; replayed }
+ | { status: 'insufficient'; balance; message }
+ | { status: 'rejected'; code; reason; charged }
+ | { status: 'unavailable'; reason; cause }
+ | { status: 'unknown'; reason }

// ---- os dois métodos ----
- debit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange>;
- credit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange>;
+ debit(input: WalletMoveInput): Promise<WalletChange>;
+ credit(input: WalletMoveInput): Promise<WalletChange>;
```

**Por que o objeto em vez de um quinto parâmetro posicional.** O débito passa a
carregar `productId`, e `debit(steamId, total, reference, reason, offer.id)` é
uma chamada que ninguém lê. A casa já prefere objeto quando a chamada tem mais de
três coisas — `createPurchase({...}, now)`
(`core/src/db/store-repository.ts:638-641`), `vips.grant({...})`
(`core/src/store/service.ts:92-101`), `recordAction({...})`
(`core/src/store/service.ts:472-478`). **Alternativa descartada:** manter os
quatro posicionais e acrescentar um quinto opcional. Custa menos hoje e cobra
depois, no dia em que aparecer o sexto.

```ts
export interface WalletMoveInput {
  readonly steamId: string;
  /** Sempre POSITIVO. O sentido é do MÉTODO, nunca do sinal. */
  readonly amount: number;
  /** A referência da compra, já no formato do §6. */
  readonly reference: string;
  /**
   * O texto que o JOGADOR lê no extrato. Português, sem jargão.
   *
   * Vira `observacao` na fronteira — o nome é do contrato do site.
   */
  readonly reason: string;
  /**
   * O que foi comprado. Ausente = não é venda de catálogo.
   *
   * Ele é o que faz o site conseguir dizer O QUE aquele débito pagou,
   * e o que habilita o guard de replay por produto. Estorno NÃO manda.
   */
  readonly productId?: string | undefined;
}
```

E a `LocalWallet` (`core/src/store/wallet.ts:104-142`) muda em três linhas: passa
a receber o objeto, a devolver `message` no `insufficient` e a nunca devolver
`balance: null` (o banco local sempre responde).

### 8.3 O arquivo novo, por inteiro

```ts
// ============================================================
//  site-wallet.ts  -  a carteira do SITE OrigemZ.
//
//  ####  O SITE É O DONO DO DINHEIRO  ####
//
//  Esta é a terceira implementação de `Wallet`, e a única que fala
//  com alguém de fora. A `LocalWallet` continua existindo para quem
//  não ligou a integração; a `RemoteWallet` foi aposentada porque
//  falava um contrato que nenhum servidor jamais respondeu.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO SÓ TRADUZ PROTOCOLO  ####
//
//  Ele não sabe o que é `fetch` (isso é do `SiteClient`) e não sabe
//  o que é uma compra (isso é do `StoreService`). O que ele sabe é
//  transformar "HTTP 422 com uma frase" em `insufficient`, e
//  "timeout" em `unknown`.
//
//  ####  CINCO DESFECHOS, E O QUINTO É O QUE FALTAVA  ####
//
//  `unknown` significa PODE TER COBRADO. Ele nasce de timeout, de
//  erro de rede, de 5xx e de um 200 que não deu para entender — e é
//  o único que não fecha a compra. Sem ele, uma resposta perdida no
//  caminho deixa o jogador cobrado e sem item, e nada volta a
//  conferir. Ver Docs\20 §4 e §11.
//
//  ####  409 NÃO É SALDO INSUFICIENTE  ####
//
//  No site, 409 é reuso de `referenceId`, e em três dos quatro
//  códigos ele vem com `charged` — o dinheiro JÁ SAIU. Saldo
//  insuficiente é 422. Ler um pelo outro inverteria o desfecho mais
//  perigoso do protocolo.
// ============================================================

import type { Logger } from '../logger.js';
import type { SiteClient, SiteResult } from '../site/client.js';
import { refundReferenceOf } from './reference.js';
import type {
  ChargeProofResult,
  ChargeProver,
  Wallet,
  WalletBalance,
  WalletChange,
  WalletMoveInput,
} from './wallet.js';

// ####  `ChargeProver` E `ChargeProofResult` MORAM EM `wallet.ts`  ####
//
// Eles são o CONTRATO da prova, não a implementação dela — e
// `StoreService` precisa do tipo para declarar a dep `proof`
// (§14.11b). Se eles morassem aqui, `service.ts` teria de importar
// `site-wallet.js`, e o §8.1 deixaria de ser verdade: a loja
// passaria a saber que existe um site. Mesma fronteira de `Wallet`,
// pela mesma razão. A declaração está em §14.10.

export interface SiteWalletOptions {
  readonly client: SiteClient;
  readonly logger?: Logger | undefined;
  /**
   * Chamado quando uma resposta diz que o PAREAMENTO quebrou.
   *
   * É o que faz o agente descobrir em segundos — e não em minutos —
   * que o token foi rotacionado: o `SiteBeacon` marca o pareamento
   * como suspeito e força uma batida. Opcional porque o teste da
   * carteira não constrói beacon nenhum. Ver §9.5 e §14.15.
   */
  readonly onPairingSuspect?: ((reason: string) => void) | undefined;
}

export class SiteWallet implements Wallet, ChargeProver {
  readonly source = 'remote' as const;
  readonly #client: SiteClient;
  readonly #logger: Logger | undefined;
  readonly #onPairingSuspect: ((reason: string) => void) | undefined;
  // A saúde da carteira, para `GET /api/site/status` (§9.6). Ela
  // mora aqui porque é aqui que as respostas passam — e uma segunda
  // contagem em outro lugar discordaria desta no primeiro erro.
  #lastOkAt: number | null = null;
  #lastError: string | null = null;

  constructor(options: SiteWalletOptions) {
    this.#client = options.client;
    this.#logger = options.logger;
    this.#onPairingSuspect = options.onPairingSuspect;
  }

  /** O que a tela de status mostra. Nunca inclui segredo. */
  get health(): { readonly lastOkAt: number | null; readonly lastError: string | null } {
    return { lastOkAt: this.#lastOkAt, lastError: this.#lastError };
  }

  /**
   * O saldo, ou `null` quando não deu para perguntar.
   *
   * `null` e não zero: a vitrine continua abrindo (é a razão do
   * comportamento antigo), mas o modal para de dizer SALDO
   * INSUFICIENTE a quem tem dinheiro.
   *
   * `exists` da resposta é IGNORADO de propósito: ele é sempre
   * `true`, porque o `findOrCreate` do site cria a conta na própria
   * consulta (agent-ozcoins.controller.ts:48-61).
   */

> ⚠️ **ESTE COMENTÁRIO ESTÁ DEFASADO NO CÓDIGO, e a listagem acima é cópia fiel
> dele.** Desde `oz-rust/6` (04/09/2026) **a resposta do site não traz `exists`
> nenhum** — não há o que ignorar. O `SiteWallet` continua correto porque nunca
> leu o campo; quem o produz é o `SiteClient`, que o sintetiza. **Pendência do
> lado do agent:** reescrever o comentário de `core/src/store/site-wallet.ts:104`
> e decidir se `BalanceBody.exists` continua existindo como campo sintético.
  async getBalance(steamId: string): Promise<WalletBalance> {
    const result = await this.#client.balance(steamId);

    if (!result.ok) {
      this.#lastError = result.reason;
      this.#logger?.warn(
        { steamId, status: result.status, code: result.code },
        'site wallet did not answer the balance',
      );

      return { steamId, balance: null, source: this.source };
    }

    // Já vem `balance`, inteiro, traduzido no `SiteClient`. Ver §8.1.
    const { balance } = result.body;

    if (balance === null) {
      this.#lastError = 'o site respondeu um saldo que não é inteiro';
      this.#logger?.warn({ steamId }, 'site wallet answered a balance that is not an integer');

      return { steamId, balance: null, source: this.source };
    }

    this.#lastOkAt = Date.now();
    this.#lastError = null;

    return { steamId, balance, source: this.source };
  }

  debit(input: WalletMoveInput): Promise<WalletChange> {
    return this.#move('debit', input, input.reference);
  }

  /**
   * Devolve ao saldo.
   *
   * ####  A CHAVE DO ESTORNO É `:refund`, E ELA É DERIVADA AQUI  ####
   *
   * Usando a MESMA referência do débito, o site trataria o crédito
   * como replay do débito, responderia `idempotent: true` e NÃO
   * creditaria — o jogador ficaria sem o item E sem o dinheiro, com
   * uma resposta de sucesso. Ver §12.
   */
  credit(input: WalletMoveInput): Promise<WalletChange> {
    // Estorno não é venda de catálogo: `productId` fica de fora, ou
    // o guard de replay do site passaria a ver um crédito onde
    // espera uma compra.
    return this.#move('credit', { ...input, productId: undefined }, refundReferenceOf(input.reference));
  }

  async proveCharge(input: {
    readonly reference: string;
    readonly steamId: string;
  }): Promise<ChargeProofResult> {
    const result = await this.#client.transaction(input.reference, input.steamId);

    if (result.ok) {
      return {
        status: 'charged',
        amount: result.body.amount ?? 0,
        transactionId: result.body.transactionId,
        productId: result.body.productId,
      };
    }

    // ####  SÓ `REFERENCE_NOT_FOUND` É PROVA  ####
    //
    // O site devolve 404 com o MESMO CORPO para três casos — não
    // existe, é de outro jogador, é de outro servidor —, mas com
    // DOIS códigos (§5.6, e §6.2/§6.3 do manual do site). Só o
    // primeiro prova que nada foi cobrado. Ler os outros dois como
    // prova transformaria uma cobrança REAL em "nunca aconteceu"
    // toda vez que o `SITE_SERVER_ID` mudasse — e fecharia a compra
    // com o dinheiro do jogador fora da conta.
    if (result.status === 404 && result.code === 'REFERENCE_NOT_FOUND') {
      return { status: 'not-charged' };
    }

    // ####  `REFERENCE_NOT_MINE` É TERMINAL, E NÃO `unknown`  ####
    //
    // A linha EXISTE e não é desta identidade. Nem prova de
    // cobrança, nem prova de não-cobrança — e nenhuma retentativa
    // muda isso, porque o `referenceId` e o `steamId` gravados não
    // mudam sozinhos. Devolver `unknown` aqui poria o settler
    // batendo no site todo minuto até o teto do §11.1, contra um
    // canal que a §5.6 acabou de limitar. Sai do laço e vai para
    // gente (§11.4).
    if (result.status === 404 && result.code === 'REFERENCE_NOT_MINE') {
      return { status: 'unprovable', reason: 'REFERENCE_NOT_MINE' };
    }

    // 400 é PERMANENTE: a referência ou o steamId gravados não
    // passam na régua do site, e nenhuma retentativa muda isso.
    // Sem este ramo o settler bate todo minuto, para sempre, num
    // pedido que nunca vai passar — contra um canal sem rate-limit.
    if (result.status === 400) {
      return { status: 'unprovable', reason: result.code ?? result.reason };
    }

    if (PAIRING_CODES.has(result.code ?? '')) {
      this.#onPairingSuspect?.(result.code ?? 'PAIRING');
    }

    return { status: 'unknown', reason: result.reason };
  }

  // ------------------------------------------------------------
  //  A tradução — a tabela do §4.2, em código
  // ------------------------------------------------------------

  async #move(
    direction: 'debit' | 'credit',
    input: WalletMoveInput,
    referenceId: string,
  ): Promise<WalletChange> {
    const result = await this.#client.mutate(direction, {
      steamId: input.steamId,
      // Sempre positivo e inteiro: o sentido é da ROTA.
      amount: Math.abs(Math.trunc(input.amount)),
      referenceId,
      reason: input.reason,
      ...(input.productId === undefined ? {} : { productId: input.productId }),
    });

    if (result.ok) {
      // `balance`, `transactionId` e `idempotent` já vêm com o nome
      // da casa e com o tipo certo — a tradução é do `SiteClient`.
      const { balance } = result.body;

      if (balance === null || result.body.success !== true) {
        // 200 que não dá para entender PODE TER COBRADO. Nunca `ok`.
        return {
          status: 'unknown',
          reason: 'o site respondeu 200 com um corpo que não dá para ler',
        };
      }

      this.#lastOkAt = Date.now();
      this.#lastError = null;

      return {
        status: 'ok',
        balance,
        transactionId: result.body.transactionId,
        // ####  `replayed` FALA DA COBRANÇA, NÃO DO SALDO  ####
        //
        // Num replay, `balance` é o saldo NO MOMENTO DA COBRANÇA
        // ORIGINAL — o site devolve `String(tx.afterBalance)` da
        // linha gravada (`ozCoinsMutation.ts:92-103`), que pode ser
        // de horas atrás. Ele serve para conferência, NUNCA para a
        // tela: quem for exibir saldo relê com `getBalance`. É a
        // regra 5 do §17.6.
        replayed: result.body.idempotent === true,
      };
    }

    return this.#classify(direction, result);
  }

  #classify(direction: 'debit' | 'credit', result: SiteResult<never> & { ok: false }): WalletChange {
    const { status, code, reason, body } = result;

    this.#lastError = reason;

    // Sem status = não chegou no site: timeout, DNS, TLS, cabo. Pode
    // ter cobrado se o corte foi na VOLTA, e é por isso que isto é
    // `unknown` e não `unavailable`.
    if (status === null) {
      return { status: 'unknown', reason };
    }

    if (status >= 500) {
      return { status: 'unknown', reason };
    }

    if (status === 429) {
      return { status: 'unavailable', reason, cause: 'throttled' };
    }

    if (PAIRING_CODES.has(code ?? '')) {
      // O beacon precisa saber AGORA: é assim que o agente descobre
      // em segundos, e não em minutos, que o token foi rotacionado
      // ou que o IP saiu da allowlist. Ver §9.5.
      this.#onPairingSuspect?.(code ?? 'PAIRING');

      return { status: 'unavailable', reason, cause: 'pairing' };
    }

    // O 403 da BORDA, em texto puro. Não é ban e não é pareamento: é
    // o User-Agent recusado. Ver §17.5.
    if (status === 403 && code === null && /error code: 1010/i.test(reason)) {
      return { status: 'unavailable', reason, cause: 'network' };
    }

    if (status === 422) {
      // Num crédito isto é impossível (crédito não fica sem saldo).
      // Se acontecer, é defeito — e defeito não se repete.
      if (direction === 'credit') {
        return { status: 'rejected', code: 'CREDIT_422', reason, charged: null };
      }

      return {
        status: 'insufficient',
        // ####  NUNCA ZERO  ####
        //
        // O 422 do site traz `balance`, `required` e `missing` como
        // NUMBER (§5.4, ajuste 4). `null` quando o site é anterior a
        // esse ajuste — e `null` é "não perguntei", que é diferente
        // de "não tem". Um `0` fixo aqui viajaria até o corpo do 409
        // de `/store/buy` e até o painel, dizendo a um jogador com
        // dinheiro que ele está zerado. É o pecado do D13, de volta
        // pela porta dos fundos.
        balance: typeof body?.balance === 'number' ? Math.trunc(body.balance) : null,
        // A FRASE DO SITE, CRUA. Ver §7.3.
        message: reason,
      };
    }

    // 409 = reuso de referenceId. `charged` preenchido = O DINHEIRO
    // SAIU numa cobrança anterior com esta mesma chave.
    if (status === 409) {
      return {
        status: 'rejected',
        code: code ?? 'REFERENCE_ID_REUSED',
        reason,
        charged: typeof body?.charged === 'number' ? Math.trunc(body.charged) : null,
      };
    }

    // Os 4xx que o agente RECONHECE como defeito dele.
    if (REJECTED_CODES.has(code ?? '')) {
      return { status: 'rejected', code: code ?? 'BAD_REQUEST', reason, charged: null };
    }

    // ####  4xx DESCONHECIDO RECUA; NÃO DESISTE  ####
    //
    // `rejected` significa "nunca repita", e ele FECHA a compra como
    // `failed`, para sempre. Um código que o agente não conhece não
    // pode carregar esse peso: no dia em que o site criar um novo —
    // e ele vai criar, `AGENT_IP_NOT_ALLOWED` e `AGENT_RATE_LIMITED`
    // nasceram assim depois deste arquivo — a escolha errada mata
    // cada compra tentada, uma por uma, em silêncio. Errar para
    // `unavailable` custa uma espera; errar para `rejected` custa a
    // loja. Ver a observação 4 do §4.2.
    if (status === 400 && code === null) {
      // 400 SEM código nenhum é o corpo torto de HOJE (o site ainda
      // não subiu o ajuste 3 do §5.4): defeito nosso, com certeza.
      return { status: 'rejected', code: 'BAD_REQUEST', reason, charged: null };
    }

    // O 403 do middleware global do site (D17): o corpo levava um
    // campo chamado `balance`, `ozBalance` ou `epBalance`. Ele não
    // tem `error_code` e nunca vai ter — é defeito NOSSO, e repetir
    // o mesmo corpo dá o mesmo 403 para sempre. É a única exceção
    // `rejected` sem código além do 400 acima, e ela é reconhecida
    // pela FRASE porque é só o que o site manda.
    if (status === 403 && code === null && /opera[çc][ãa]o n[ãa]o permitida/i.test(reason)) {
      return { status: 'rejected', code: 'FORBIDDEN_FIELD', reason, charged: null };
    }

    this.#logger?.warn(
      { status, code },
      'site answered a 4xx with an error_code this agent does not know; backing off',
    );

    return { status: 'unavailable', reason, cause: 'network' };
  }
}

/**
 * Os códigos que significam "o pareamento está quebrado". Ver §9.5.
 *
 * Todos eles: (a) viram `unavailable` / `pairing`, (b) fazem a loja
 * responder INDISPONÍVEL em vez de fechar a compra, e (c) acordam o
 * beacon por `onPairingSuspect`.
 */
const PAIRING_CODES = new Set([
  'MISSING_BEARER',
  'BEARER_MISMATCH',
  'AGENT_NOT_ACTIVE',
  'AGENT_NOT_FOUND',
  'MISSING_SERVER_ID',
  // O IP saiu da allowlist do site. NÃO é defeito do pedido: é
  // pareamento, e o conserto é no admin do site (§17.3). Sem esta
  // linha, um IP residencial que troque fecharia cada compra como
  // `failed`, uma por uma, sem retentativa e sem alarme.
  'AGENT_IP_NOT_ALLOWED',
  // Só aparecem na resposta do beacon, mas moram aqui porque a
  // classificação é a mesma e uma segunda lista discordaria desta.
  'BEACON_SIGNATURE_MISSING',
  'BEACON_TIMESTAMP_INVALID',
  'BEACON_NO_CREDENTIALS',
  'BEACON_SIGNATURE_MISMATCH',
]);

/**
 * Os 4xx que são defeito NOSSO, e por isso nunca se repetem com o
 * mesmo corpo. Lista FECHADA: o que não está aqui recua.
 */
const REJECTED_CODES = new Set([
  'INVALID_STEAM_ID',
  'INVALID_AMOUNT',
  'INVALID_REFERENCE_ID',
  'INVALID_PRODUCT_ID',
  'REFERENCE_ID_REUSED',
  'REFERENCE_ID_AMOUNT_MISMATCH',
  'REFERENCE_ID_PRODUCT_MISMATCH',
]);
```

**O `toInteger` não mora mais aqui.** Ele foi para `core/src/site/client.ts`,
junto da tradução de `moedas` → `balance` — é lá que a string do site vira
inteiro, e é por isso que este arquivo lê `result.body.balance` e não
`result.body.moedas`. Ver §8.1 e §14.2.

### 8.4 A `LocalWallet` continua, e ganha a mesma frase

```ts
// core/src/store/wallet.ts — LocalWallet.debit, antes → depois

- debit(steamId: string, amount: number, reference: string, reason: string): Promise<WalletChange> {
-   const balance = this.#store.change(steamId, -Math.abs(amount), reference, reason);
-   return Promise.resolve(
-     balance === null
-       ? { status: 'insufficient', balance: this.#store.getBalance(steamId) }
-       : { status: 'ok', balance },
-   );
- }
+ debit(input: WalletMoveInput): Promise<WalletChange> {
+   const balance = this.#store.change(
+     input.steamId, -Math.abs(input.amount), input.reference, input.reason,
+   );
+
+   if (balance !== null) {
+     // A carteira local É o ledger: não há id de transação para dar,
+     // e nunca há replay.
+     return Promise.resolve({ status: 'ok', balance, transactionId: null, replayed: false });
+   }
+
+   const current = this.#store.getBalance(input.steamId);
+
+   // A MESMA frase do site, no MESMO formato. Assim `describePurchase`
+   // não precisa de um `if` para saber quem é o dono do saldo — e o
+   // suporte não lê duas versões da mesma história.
+   return Promise.resolve({
+     status: 'insufficient',
+     balance: current,
+     message:
+       `Saldo insuficiente. Voce tem ${String(current)} OZ, o item custa ` +
+       `${String(Math.abs(Math.trunc(input.amount)))} OZ ` +
+       `(faltam ${String(Math.abs(Math.trunc(input.amount)) - current)}).`,
+   });
+ }
```

`LocalWallet.credit` muda só a assinatura e o formato do `ok`; o `null` continua
virando `unavailable` com a mesma razão escrita em `wallet.ts:133-135`.

### 8.5 A aposentadoria da `RemoteWallet`

**O bloco inteiro (`core/src/store/wallet.ts:144-311`) é apagado** — o banner de
seção `A CARTEIRA REMOTA` (`:144-146`), `RemoteWalletOptions` (`:148`),
`DEFAULT_TIMEOUT_MS` (`:163`) e a classe `RemoteWallet` (`:177`) até o fim do
arquivo. Não é depreciação: é remoção, e o arquivo passa a terminar em `:142`,
no fim da `LocalWallet`.

**A faixa da REMOÇÃO é `:144-311`, e é essa que as três seções de mudança citam**
(§1.1, §8.5, §14.10). Começar em `:177` deixaria a interface e a constante
órfãs; começar em `:148` deixaria o banner de seção apontando para nada. O §3
cita `:177-311` de propósito: lá o assunto é a **classe**, não o bloco a
apagar.

**Por quê.** Ela fala um contrato imaginado (§3, D1 a D9), não tem um único
teste, e chama o `fetch` global — então não dá para testar sem rede, e o projeto
proíbe teste que fale com a internet. Manter as duas lado a lado significaria
manter dois dialetos vivos, e o segundo seria escolhido por engano no primeiro
dia em que alguém preenchesse a variável antiga.

**O que sobrevive dela.** As três ideias que estavam certas, e todas migram para
o `SiteWallet`: (1) uma interface, escolha única na inicialização; (2) "não tem"
e "não consegui perguntar" são coisas diferentes; (3) chave derivada no crédito.
O cabeçalho doutrinário de `wallet.ts:1-39` **fica**, atualizado para dizer
"três implementações" e para explicar os cinco desfechos.

**Alternativa descartada:** manter `RemoteWallet` e fazer o site criar
`/wallet/{steamId}` como alias. Descartada por escrito em `ozCoinsMutation.ts:11-15`
— duas portas para o mesmo ledger divergem no primeiro ajuste de régua (limite
diário, conta bloqueada), e o 409 do site já significa outra coisa.

---

## 9 — Beacon e pareamento

### 9.1 O módulo novo

`core/src/site/beacon.ts`, no molde do `VipExpiryWatcher`
(`core/src/vip/expiry-watcher.ts:64-130`): `start()` liga o `setInterval`, chama
`unref()` para não segurar o processo, dispara **uma rodada no boot** e protege
contra sobreposição com um `#running`.

```ts
// ============================================================
//  beacon.ts  -  o agente se anuncia ao site, e sabe dizer se
//  está pareado.
//
//  ####  ELE É A ÚNICA CHAMADA QUE NÃO PRECISA DE TOKEN  ####
//
//  É o primeiro contato: o site cria a linha em `agents` como
//  `pending`, e um HUMANO ativa colando o token no admin. Enquanto
//  isso não acontece, a loja fica INDISPONÍVEL — nunca "saldo 0",
//  que é o erro que faz o jogador achar que perdeu dinheiro.
//
//  ####  O ESTADO QUE ELE GUARDA É A PRIMEIRA TELA DO DIAGNÓSTICO  ####
//
//  "o agente está pending", "o token foi rotacionado" e "o site
//  está fora do ar" produzem o MESMO sintoma para o jogador: o
//  botão de comprar para de funcionar. Sem separar as três, cada
//  ocorrência custa uma tarde. Ver GET /api/site/status.
// ============================================================

export type SitePairingStatus = 'unknown' | 'pending' | 'active' | 'banned' | 'orphan';

export interface SitePairing {
  readonly status: SitePairingStatus;
  /** O que o site respondeu, em português, para a tela. */
  readonly message: string | null;
  readonly lastBeaconAt: number | null;
  readonly lastBeaconError: string | null;
  /** `false` = o `Server` não existe no site com esse id. */
  readonly serverExists: boolean | null;
  /** Diferente do nosso = o site reatribuiu o agente. */
  readonly currentServerId: string | null;
}

export class SiteBeacon { /* start(), stop(), beatNow(), get pairing() */ }
```

### 9.2 O payload e a cadência

Exatamente o do §5.2. `SITE_BEACON_INTERVAL_MS`, default **10 000**, com clamp
`5 000..300 000` na leitura da configuração.

**O teto de 300 s não é gosto:** o site considera um agente "online" quando
`status === 'active'` **e** `lastBeaconAt` está nos últimos **5 minutos**. Um
intervalo maior que isso faria o agente parecer morto entre um beacon e outro.

**O piso de 5 s** existe porque o canal `/api/agent` não tem rate-limit e o
beacon é a chamada mais frequente do agente.

### 9.3 As capabilities, e por que essas cinco

`['ozcoins','shop','deliver_item','players_online','pull_delivery']`.

Duas armadilhas do lado do site, medidas:

1. **`capabilities` vazio MANTÉM as anteriores** (`agent-public.routes.ts:115-117`).
   Não existe forma de o agente **remover** uma capability por beacon. Se um dia
   uma delas deixar de ser verdade, o conserto é no admin do site.
2. **O vocabulário é ad-hoc, sem enum.** O site reconhece `inventory_delivery`
   (DayZ) e `deliver_item` (Conan) como "sabe entregar". Um nome novo não é
   reconhecido por consumidor nenhum — por isso o Rust usa `deliver_item`, e não
   inventa um terceiro.

### 9.4 A assinatura do beacon de agente ativo

**O problema, medido.** O beacon não tem autenticação nenhuma, e o bloco
`if (!created)` (`agent-public.routes.ts:106-119`) atualiza `beaconIp`,
`beaconPort`, `beaconMac`, `lastVersion` e `capabilities` **sem checar
credencial**. Quem souber — ou adivinhar — um `serverId` sobrescreve os dados de
um agente em produção. Para o Conan isso é tolerável porque a `baseUrl` fica
congelada; para o Rust, que usa `capabilities` para declarar o que sabe entregar,
é uma superfície de mentira.

**A defesa, e ela é barata e aditiva:**

```
X-Agent-Timestamp: <epoch em segundos>
X-Agent-Signature: HMAC-SHA256(SITE_TOKEN, `${serverId}|${timestamp}`)  em hex
```

Janela de ±120 s — o mesmo `TIMESTAMP_TOLERANCE_SEC` que o site já usa no
sentido inverso.

**A regra do lado do site tem DUAS condições, e escrever só a primeira quebra
produção:**

```js
const mustVerify = agent.status === 'active' && agent.requiresSignedBeacon === true;
```

`agents.requires_signed_beacon` é uma coluna nova, `BOOLEAN NOT NULL DEFAULT
false`, e **só** o `/activate` de Rust a liga (§10.3 e §10.4 do manual do site).
Enquanto `pending`, o beacon entra sem assinatura de qualquer jeito — é o
primeiro contato, e ainda não há token.

####  POR QUE A SEGUNDA CONDIÇÃO NÃO É ZELO  ####

Uma versão anterior desta seção dizia só *"quando `agent.status === 'active'`"*,
e implementada ao pé da letra ela é **catástrofe, não regressão**: a tabela
`agents` é **compartilhada** entre DayZ, Conan e Rust, e os agentes deles também
são `active`. Sem a coluna, o site passaria a exigir assinatura de quem nunca
assinou — o beacon do DayZ tomaria `401 BEACON_SIGNATURE_MISSING`, `lastBeaconAt`
congelaria, `serverDelegatesToAgent` (`inventory.service.ts:70-84`) viraria
`false` e **a entrega de inventário do DayZ pararia**. É jogo de terceiro
quebrando por uma linha de um documento sobre Rust.

A coluna também é o que faz a defesa se **auto-desligar** em todo caminho de
despareamento sem editar nenhum deles: `POST /api/agent/invalidate` e o
`reassign` do admin gravam `status: 'pending'`, e `mustVerify` vira falso
sozinho.

DayZ e Conan, com a coluna em `false` para sempre, continuam entrando exatamente
como hoje.

**Do lado do agente:** o beacon assina **quando tem `SITE_TOKEN`**, sempre — não
condicionado ao status conhecido, para que o primeiro beacon depois de o admin
ativar já venha assinado. Sem token, manda sem assinatura.

**Se o dono recusar a assinatura** (§22, pergunta 7), nada no agente quebra: o
header vira ruído ignorado pelo site. Escreva-o mesmo assim.

### 9.5 O que fazer em cada resposta

| Resposta do site | `pairing.status` | O que o agente faz |
|---|---|---|
| 200 `status: 'active'`, `serverExists: true` | `active` | tudo ligado: carteira, fila, espelho |
| 200 `status: 'pending'` | `pending` | **loja INDISPONÍVEL**; sem débito, sem fila, sem espelho; continua beaconando |
| 200 `serverExists: false` | `orphan` | idem `pending`, e a tela mostra "o `Server` não existe no site com esse id" |
| 200 `currentServerId` ≠ o nosso | (mantém) | **alarme na tela**: o site reatribuiu o agente; alguém tem de trocar `SITE_SERVER_ID` |
| **401** com `error_code` começando em `BEACON_` | `pending` | **o site parou de aceitar as batidas.** Para de cobrar, guarda o código CRU em `lastBeaconError`, mostra na tela e **continua beaconando, assinado**. Ver abaixo |
| 403 JSON `{ error: 'agent banido', banId, … }` | `banned` | **para de beaconar** e mostra o motivo. Insistir não conserta ban |
| 403 texto com `error code: 1010` | (mantém) | **não é ban**: é a borda recusando o `User-Agent`. Loga, mostra na tela, continua |
| 403 qualquer outro | (mantém) | **trata como borda**, conservador: continua beaconando e mostra o corpo cru na tela |
| 400 `serverId obrigatório` | (mantém) | defeito de configuração; loga em `error` e mostra na tela |
| 5xx / timeout / rede | (mantém) | guarda em `lastBeaconError` e tenta na próxima volta. Não muda o status: um soluço do site não desfaz um pareamento |

####  COMO SEPARAR AS TRÊS FAMÍLIAS DE 403, EM UM LUGAR SÓ  ####

A regra estava espalhada por §8.3, §9.5 e §17.5. Ela é esta, e é a única:

1. corpo que **parseia como JSON e tem a chave `banId`** → **ban de verdade**;
2. corpo que **não parseia como JSON** e contém `error code: 1010` → **borda**;
3. **qualquer outro 403** → trata como borda. Conservador de propósito: parar de
   beaconar por engano deixa o agente invisível para o site, e ninguém descobre
   por quê.

O `error_code` não serve aqui: o beacon é a única rota do site que **não** tem
`error_code` em resposta nenhuma (§5.2). É por isso que o `SiteClient` guarda o
**texto** da resposta, e não só o status.

**Os quatro `BEACON_*`**, e todos são 401 (o site os define em
`beaconSignature.ts`):

| `error_code` | Significa | O que dizer na tela |
|---|---|---|
| `BEACON_SIGNATURE_MISSING` | faltou `X-Agent-Signature` ou `X-Agent-Timestamp` | "o agente está sem `SITE_TOKEN`; cole o token e reinicie" |
| `BEACON_TIMESTAMP_INVALID` | `timestamp` fora de ±120 s | "o relógio desta máquina está fora de hora" |
| `BEACON_NO_CREDENTIALS` | o site não consegue decifrar o bearer dele | "**o agente precisa ser reativado no site**" |
| `BEACON_SIGNATURE_MISMATCH` | a assinatura não confere | "o `SITE_TOKEN` não é o que o site espera; rotacione" |

Eles estão em `PAIRING_CODES` (§8.3) pela mesma razão dos outros cinco — e um
401 do beacon **não** derruba o `lastBeaconAt` antigo em silêncio: ele grava o
erro, e é `lastBeaconError` que a tela mostra.

**A regra que amarra tudo:** enquanto `pairing.status !== 'active'`, a loja
in-game responde **INDISPONÍVEL** ao jogador — nunca "saldo 0" e nunca "saldo
insuficiente". É a mesma lei que o site escreveu para o painel do Conan em
`authenticateAgent.ts:18-23`. **O ponto de implementação dela está no §14.11(b)**
— `StoreServiceDeps.ready` — e não em prosa espalhada: uma lei sem lugar no
código é uma lei que ninguém escreve.

E o caminho inverso: quando um débito volta com
`unavailable / cause: 'pairing'`, o `SiteBeacon` é notificado por
`SiteWalletOptions.onPairingSuspect` (§8.3), marca o pareamento como suspeito e
**força um beacon imediato**. É assim que o agente descobre em segundos, e não em
minutos, que o token foi rotacionado.

**O debounce do `suspect` é 5 s**, e ele tem número por um motivo: uma rajada de
compras contra um token rotacionado chamaria `suspect` uma vez por compra, e sem
freio isso vira um beacon por clique — exatamente o laço que o piso de 5 s do
`SITE_BEACON_INTERVAL_MS` existe para impedir (§9.2).

### 9.6 As duas rotas locais

Arquivo novo `core/src/http/routes/site.ts`, registrado no escopo `/api`.

**`GET /api/site/status`** — a primeira tela que alguém abre quando "a loja
parou":

```json
{
  "ok": true,
  "paired": true,
  "status": "active",
  "baseUrl": "https://origemznetwork.com",
  "serverId": "RUST01",
  "localServerId": "rust-pvp1",
  "hasToken": true,
  "lastBeaconAt": "2026-09-02T14:00:03.001Z",
  "lastBeaconError": null,
  "lastBeaconErrorCode": null,
  "wallet": { "source": "remote", "lastOkAt": "2026-09-02T13:59:41.000Z", "lastError": null },
  "deliveries": {
    "reserved": 0, "indeterminate": 0, "deferredLastPoll": 2,
    "lastPollAt": "2026-09-02T14:00:01.000Z", "lastAckAt": "2026-09-02T14:00:01.400Z"
  },
  "catalog": { "version": "9f2c…", "mirroredVersion": "9f2c…", "lastPushAt": "…", "lastPushError": null },
  "purchases": { "pendingOrphan": 0, "chargeUnknown": 0, "unprovable": 0, "stuck": 1 }
}
```

**De onde vem cada número** — e este parágrafo existe porque a primeira versão
deste corpo pedia campos que peça nenhuma sabia calcular:

| Campo | Fonte |
|---|---|
| `status`, `lastBeaconAt`, `lastBeaconError` | `SiteBeacon.pairing` (§9.1). Com `SITE_BASE_URL` vazia não há beacon: a rota responde `status: 'unknown'` e os três `null` |
| `lastBeaconErrorCode` | o `error_code` cru da última resposta ruim do beacon — é ele que separa `BEACON_NO_CREDENTIALS` de `AGENT_IP_NOT_ALLOWED` de "o site caiu". **Sete causas, sete nomes**; sem este campo a tela volta a ter um sintoma só |
| `wallet.lastOkAt` / `lastError` | `SiteWallet.health` (§8.3). Com a carteira local, `source: 'local'` e os dois `null` |
| `deliveries.reserved` / `indeterminate` | `SiteDeliveriesRepository.countByState(...)` — são **estados que existem** na tabela (§14.5) |
| `deliveries.deferredLastPoll` | contador **em memória** da última rodada do `SiteDeliveries`. Não é estado de banco: `deferred` é um ACK, não uma linha |
| `catalog.*` | `CatalogMirror.status` (§14.8) |
| `purchases.pendingOrphan` | `countPurchasesByState('pending')` com mais de 5 min — a compra que morreu antes do débito (§11.3) |
| `purchases.chargeUnknown` | `countPurchasesByState('charge-unknown')` (§14.12) |
| `purchases.unprovable` | `failed` com `error` começando em `CHARGE_UNPROVABLE` — as que saíram do laço e esperam gente |
| `purchases.stuck` | o `stats().stuck` de sempre, agora somando `failed` + `charge-unknown` (§14.12) |

**Não existe `deliveries.pending`.** A fila pendente é do **site**, não do agente:
o agente só conhece as tarefas que ele já puxou. Um número aqui seria uma
estimativa apresentada como fato.

**`POST /api/site/beacon`** — força um beacon agora, sem esperar os 10 s. Existe
por conveniência de operação: encurta o laço "ativei no site → quando é que ele
percebe?" para um clique. Responde `{ ok: true, status, message }`.

**O contrato de erro das duas** — porque o painel (§14.19) vai consumi-las e
precisa saber o que fazer:

| Situação | Status | Corpo |
|---|---|---|
| tudo bem | 200 | o de cima |
| `SITE_BASE_URL` vazia | **200** | `{ ok: true, paired: false, status: 'unknown', … }` — **não** 404, e **não** 503. Quem abre esta tela está tentando descobrir por que a integração não subiu |
| sem `AGENT_API_TOKEN` nem sessão | 401 | o corpo padrão de `core/src/http/error-response.ts`, como toda rota de `/api` |
| o beacon forçado falhou | 200 | `{ ok: true, status, message }` com o motivo — falhar em beaconar **não** é erro HTTP desta rota |

As duas ficam no escopo `/api`, autenticado por `AGENT_API_TOKEN` ou pela sessão
do painel, como todas as outras (`core/src/http/server.ts`). Nenhuma delas
devolve o `SITE_TOKEN`, nem parte dele: `hasToken` responde **se** há token,
nunca **qual**.

---

## 10 — A fila de entregas

### 10.1 O que ela resolve

O site trata **comprar** e **entregar** como dois atos separados, e isso não
muda: `POST /api/shop/buy` debita, cria a `Order` como `paid` e grava
`inventory_items` — **nada toca o jogo**. A entrega só acontece quando o jogador
abre o inventário do site, escolhe o servidor e resgata
(`POST /api/inventory/:id/redeem`).

Para o Rust, o handler desse resgate **não chama o agente**: ele enfileira. E o
agente puxa.

### 10.2 O laço, passo a passo

```
a cada SITE_DELIVERY_POLL_MS (15 s), e ao ver um jogador conectar:

 0. de onde a rodada comeca:
      wake()   (alguem conectou) -> do TOPO, com o cursor guardado ZERADO
      relogio                    -> do `next` guardado na rodada anterior;
                                    se nao houver, do topo
 1. GET /api/agent/deliveries/pending?limit=50[&cursor=<next>]
      400 INVALID_CURSOR -> descarta o cursor e refaz o passo 1 do TOPO,
                            UMA vez por rodada (a segunda encerra a rodada)
 2. para cada tarefa:
      a) já existe linha local com esse id?
           delivered     -> reACKa 'delivered' e segue
           failed        -> reACKa 'failed' e segue
           reserved      -> PROMOVE para 'indeterminate' e ACKa
                            'deferred' + reason 'AGENT_INDETERMINATE'. Ver 10.4
           indeterminate -> reACKa 'deferred' + 'AGENT_INDETERMINATE' e segue
      b) o payload passa na validação do §5.7?
           não -> ACK 'failed' com reason 'PAYLOAD_INVALID'
      c) o servidor local (SITE_LOCAL_SERVER_ID) está no ar?
           não -> ACK 'deferred', reason 'RCON_UNAVAILABLE'. Ver 10.8
      d) o jogador está online?
           null (não deu para perguntar) -> ACK 'deferred', reason 'PRESENCE_UNAVAILABLE'
           false                          -> ACK 'deferred', reason 'PLAYER_OFFLINE'
      e) RESERVA a linha local (state 'reserved') ANTES de qualquer comando
      f) executa por RCON, pelo MESMO caminho da compra in-game (§10.5)
      g) grava 'delivered' ou 'failed' com o código cru, por `ackOf` (§14.6)
 3. POST /api/agent/deliveries/ack com o lote DESTA PAGINA (ate 50)
 4. os ids que voltarem em `unknown` são tratados por ESTADO LOCAL (§5.8):
      reserved / indeterminate -> viram 'expired' e saem do cache
      delivered / failed       -> só marcam `acked_at`. A LINHA FICA
 5. tem mais pagina?
      next === null                             -> zera o cursor guardado.
                                                   Fim da rodada
      ja foram DELIVERY_MAX_PAGES_PER_ROUND (5) -> GUARDA o `next`.
                                                   Fim da rodada
      senao                                     -> cursor = next, volta ao 1
```

**Sobre (a): reACKar é de propósito, e o `unknown` que volta é esperado.**
Reenviar um desfecho já enviado não muda nada no site (`applied` não o conta),
e é isso que torna seguro repetir um lote depois de um timeout. O id volta em
`unknown` — e, para uma linha local `delivered`, isso **não** significa que a
entrega não aconteceu. Ver §5.8.

**A ordem de (d) e (e) é o ponto todo**, e é a lição que o agente do Conan pagou:
a reserva acontece **antes** do comando, não depois. Um agente que caia entre o
`origemz.give` e o ACK reencontra a tarefa na próxima página; sem a reserva, ele
entregaria de novo — item duplicado, uma cobrança.

**Sobre o passo 5: sem ele, a fila trava na cabeça.** O raciocínio inteiro, com
os três fatos que o produzem e a conta que fixa o teto em cinco páginas, está no
§5.7. Aqui basta a consequência: **um `GET` só por rodada entrega os cinquenta
primeiros da fila para sempre**, porque `deferred` não tira ninguém de `pending`
e a ordem é `id ASC`. O laço que não lê o `next` não está "simples": ele está
errado, e o sintoma é silencioso.

####  POR QUE O SITE NÃO MUDA A ORDENAÇÃO NEM O FILTRO  ####

A leitura óbvia deste defeito é *"então o site deveria servir primeiro quem nunca
foi tentado"*. Foi conferido, e **não**: as três formas de fazer isso do lado de
lá custam mais do que consertam.

| Alternativa no site | Por que foi descartada |
|---|---|
| ordenar por `attempts ASC` (ou `last_attempt_at NULLS FIRST`) antes do `id` | **quebra o cursor.** A paginação do site é *keyset*: ele resolve o `cursor` para a PK e continua com `id > :pk ORDER BY id ASC` (§8.6 do manual do site). A chave de ordenação precisa ser **imutável durante a caminhada** — e `attempts` e `last_attempt_at` mudam a **cada ACK `deferred`**, isto é, o tempo todo. Linhas passariam a pular ou a repetir dentro da mesma varredura, e a tarefa pulada é justamente a que ninguém vê |
| esconder por um tempo a tarefa recém-tentada (*cooldown*) | **mata o gatilho por conexão.** A tarefa que o jogador que acabou de entrar está esperando é, por definição, a que foi adiada com `PLAYER_OFFLINE` há alguns segundos — exatamente a que o cooldown esconderia. O §10.7 existe para entregar *no minuto em que ele abre o inventário*; com cooldown, ele entregaria um cooldown depois |
| servir só as `attempts = 0` numa página à parte | mesma quebra do keyset da primeira linha, com uma rota a mais para manter |

**O que o site tem de estável é justamente o que o torna paginável:** `id` é
`BIGSERIAL`, só cresce, e nunca é reescrito. Trocar isso por uma ordem "mais
inteligente" trocaria um defeito visível (a cauda espera) por um invisível (a
linha pulada). O conserto certo é do lado que tem estado para guardar o cursor —
este.

**O que muda do lado do site é uma conta, não uma consulta:** com a varredura, o
pico do canal sai de ~60 para ~91 req/min por servidor, e o piso recomendado de
`AGENT_RATE_LIMIT_PER_SERVER` sobe de 120 para **180** (§13.1 do manual do site).

### 10.3 A presença, e por que ela vem antes — e para quem ela NÃO vem

> **Ela vale para `item`, `kit` e `vehicle`, e para mais nenhum.** As duas
> tarefas de VIP (`vip` e `vip_revoke`) pulam este portão inteiro desde
> 04/09/2026. VIP não é inventário: é uma linha na tabela do agente, e o grupo
> do Oxide é o **reflexo** dela — quem o aplica em quem estava fora é o
> `OnPlayerConnected` do OrigemZVip (`Plugins/OrigemZVip.cs:191`), comparando o
> jogador com o estado que o agente já empurrou.
>
> Esperar ali custava caro e calado: o VIP comprado ficava `deferred` no site e
> **invisível na tela de VIPs do painel** até o jogador entrar; se ele demorasse
> mais que o TTL de 30 dias, o site devolvia ao inventário um VIP pago. E o
> prazo do `UserVipGrant` de lá corria o tempo todo — os dois lados divergiam
> desde o primeiro dia. Conceder na hora é o que **alinha os prazos**: os 30
> dias contam do resgate nos dois bancos.

Item, kit e veículo entram em **inventário**, e inventário só existe para quem
está conectado. O agente já tem essa resposta, e já tem a distinção certa: o
gancho de presença dos kits (`core/src/index.ts:687-704`) devolve
`readonly string[] | null`, onde **`null` = não deu para perguntar** e é
diferente de lista vazia.

| Presença | ACK | Por quê |
|---|---|---|
| lista contém o `steamId` | segue para (d) | |
| lista não contém | `deferred` / `PLAYER_OFFLINE` | ele volta amanhã; o item é dele |
| `null` (RCON fora, lista ilegível) | `deferred` / `PRESENCE_UNAVAILABLE` | **nada é tentado às cegas** |

E mesmo "online" não basta: um jogador **conectado porém morto** faz o
`origemz.give` responder `PLAYER_DEAD` — medido, e traduzido em
`core/src/kits/service.ts:646-667` junto com `PLAYER_SLEEPING`. Por isso a
presença é filtro, e o desfecho de verdade vem do comando.

### 10.4 A tabela local de idempotência

`site_deliveries` (migração 036, §15.2). Cinco estados, e cada um responde uma
pergunta diferente:

| `state` | Significa | O agente ACKa? |
|---|---|---|
| `reserved` | o comando **vai sair** ou **saiu e não sabemos** | não, enquanto está aqui |
| `delivered` | `{"ok":true}` do plugin | `delivered` |
| `failed` | falha definitiva, com o código cru | `failed` |
| `indeterminate` | o agente caiu no meio: **não sabemos se o comando saiu** | `deferred` / `AGENT_INDETERMINATE` |
| `expired` | o site devolveu o id em `unknown` e a linha não era terminal | não |

####  POR QUE O ESTADO LOCAL SE CHAMA `indeterminate`, E NÃO `review`  ####

**Porque `review` é o nome de um estado do SITE, e ele nunca atravessa o fio.**
Do lado de lá, `review` é o status para onde o site move a tarefa quando recebe
`deferred` + `AGENT_INDETERMINATE` — mesmo sentido do nosso `indeterminate`, mas
em outro banco, com outra contagem e outra tela. Chamar a linha local de `review`
faria as duas contagens (`deliveries.indeterminate` no §9.6, `review` no painel
do site) parecerem a mesma coisa; elas não são, por duas razões: uma tarefa que o site já
liberou pela mão de um admin some de `review` lá e continua `indeterminate` aqui
até o `unknown` do próximo ACK; e o site tem um **segundo** estado humano,
`needs_admin` (a tarefa que falhou `FAILED_MAX` vezes), que **nunca sai em
`/deliveries/pending`** e que o agente, portanto, nunca vê. A tela de lá conta
uma população maior que a daqui por construção, e sempre contará (§23.6).

**E o fio não carrega nenhum dos dois nomes.** O que viaja é
`status: 'deferred'` com `reason: 'AGENT_INDETERMINATE'` (§5.8): três valores de
ACK, e só três. O nome do estado é assunto de cada banco; o `reason` é o
contrato.

####  `indeterminate` É O ESTADO QUE PRESERVA — MAS ELE PRECISA SER DITO  ####

Uma linha `reserved` encontrada numa volta seguinte significa que o processo
morreu entre a reserva e o desfecho, e não há como saber se o comando saiu.
Reexecutar entregaria duas vezes; ACKar `failed` devolveria ao site um item que
talvez esteja no chão do jogador. A linha local vira `indeterminate` e aparece em
`GET /api/site/status` para um humano decidir.

**E o agente ACKa `deferred` com `reason: 'AGENT_INDETERMINATE'`.** Esta é a
correção mais cara deste documento, e vale escrever o que a versão anterior dizia
e por que ela estava errada:

> *"Então o agente **não faz nada**: a tarefa fica pendente no site (o item segue
> em `processing`, preservado)."*

**Ela não fica preservada.** Do outro lado, a tarefa continua `pending` com o
`expires_at` intocado, e o relógio de expiração do site varre `pending` vencido a
cada 5 minutos, marca `expired` e devolve o `inventory_item` para `available`. Em
`AGENT_DELIVERY_TTL_DAYS` (30), o jogador resgata de novo, o site cria tarefa
nova com `delivery_id` novo, o agente não tem memória dela — e entrega. **Item
duplicado, uma cobrança**, pelo caminho que existia justamente para impedir isso.

Não ACKar não é preservar: é **deixar o outro lado decidir sozinho, daqui a
trinta dias, sem a informação que só nós temos**. O ACK `deferred` +
`AGENT_INDETERMINATE` é o que fecha o ciclo: o site tira a tarefa de `pending` e
a põe em `review`, o item **fica** em `processing`, e a varredura de expiração —
que filtra `status = 'pending'` e ainda exige
`last_reason <> 'AGENT_INDETERMINATE'` — não a alcança por nenhum dos dois
caminhos.

É a mesma invariante que o site escreveu em três arquivos: **na dúvida,
preserva** — nunca devolver item que pode ter saído. Preservar, aqui, é falar.

### 10.5 A entrega em si

O mesmo caminho da compra in-game, e não um segundo. Os comandos são os que já
existem em `core/src/store/service.ts:57-64`:

| `kind` | Comandos |
|---|---|
| `item`, `kit` | um `origemz.give <steamId> <shortname> <amount> <skinId> auto` por item |
| `vehicle` | `origemz.vehicle.spawn <steamId> <prefab> <fuel>` |
| `vip` | `vips.grant({ steamId, tier, expiresAt, origin: 'loja', createdBy: 'site' })` |

`auto` é o modo que tenta o inventário e **joga no chão o que não couber** — com
`inventory`, quem estivesse de mochila cheia receberia `INVENTORY_FULL` e o item
comprado sumiria. Inventário cheio, portanto, **não é falha**.

Três decisões herdadas do fluxo de compra e mantidas:

1. **Um kit são várias entregas em sequência**, e uma pode falhar depois de as
   outras passarem. Aqui, ao contrário da compra, **não há estorno**: o dinheiro
   já é do site e o item é do site. Entrega parcial vira `failed` com o código do
   item que faltou, e o site devolve o `inventory_item` para `available` — o
   jogador resgata de novo. O que ele já recebeu, recebeu.
2. **VIP nasce pelo `VipList`**, e não por um segundo caminho. Um segundo caminho
   seria um VIP comprado que nunca expira.
3. **Nada disto pode lançar para cima**: o laço roda num relógio, e um `throw`
   ali pararia a fila em silêncio.

### 10.6 Retry, expiração e teto de tentativas

| Situação | Quem resolve | Regra |
|---|---|---|
| jogador ausente | o agente, a cada volta | `deferred`, sem teto: ausência não é falha |
| RCON fora | o agente | `deferred` para o lote inteiro |
| falha definitiva (`ITEM_NOT_FOUND`, `PAYLOAD_INVALID`) | o site | `failed` → item volta para `available` |
| tarefa velha demais | **o site** | expira em `AGENT_DELIVERY_TTL_DAYS` (recomendado: 30) e devolve o item para `available` — mas um ACK `delivered` que chegue **depois** disso ainda é aplicado (a regra **3-bis**, §5.8): `failed` e `deferred` sobre `expired`, não |
| tentativas demais com `failed` | **o site** | teto de 5 → conferência humana, e **não** devolve o item automaticamente |
| indeterminado | o agente | ACK `deferred` + `reason: 'AGENT_INDETERMINATE'`: o site move a tarefa de `pending` para `review`, o item fica em `processing`, e a expiração não a toca (§5.8, §10.4) |
| o servidor local está parado, desabilitado ou sumiu de `Configs\` | o agente | `deferred` / `RCON_UNAVAILABLE`, **sem teto** — ver §10.8 |
| fila represada na cabeça (50 `deferred` velhos escondendo a tarefa nº 51) | **o agente** | pagina até `next: null` ou até 5 páginas por rodada, e continua de onde parou na rodada seguinte (§5.7, §10.2) |

**Por que o teto de `failed` não devolve o item sozinho:** devolver e o agente
ter entregado é entrega dupla. Preferir a conferência humana aqui custa uma
mensagem no Discord; a alternativa custa item.

####  O QUE `attempts` CONTA, DEPOIS DA VARREDURA  ####

`agent_deliveries.attempts` sobe **um por ACK `deferred`** (§8.3 do manual do
site), e um ACK `deferred` sai a cada rodada em que a tarefa aparece numa página.
Com a varredura do §5.7 isso é **quatro por minuto**, e a tarefa de um jogador
que sumiu por trinta dias chega a seis dígitos sem que nada esteja errado.

Então, escrito nos dois documentos para ninguém tirar conclusão do número: o
`attempts` é **"quantas voltas viram esta tarefa e não deram conta"**, e não
"quantas vezes o comando foi executado" — na maioria dessas voltas o agente nem
chega a falar com o RCON, porque para no filtro de presença do §10.3. Quem
precisa de *"desde quando esta tarefa está travada"* lê `last_attempt_at` e
`created_at`, nunca `attempts`.

O teto que **decide** alguma coisa continua sendo o de `failed` (`FAILED_MAX`, 5,
por `source_ref`), e ele não conta `deferred` — se contasse, a varredura mandaria
para conferência humana toda tarefa de jogador ausente em quinze segundos.

### 10.7 O gatilho por conexão

O `PresenceTracker` já detecta quem entrou: `PresenceSyncResult.joined`
(`core/src/players/presence.ts:147-152`) carrega os `steamId` que apareceram
naquela varredura, e `syncAll()` (`:311`) já devolve
`readonly PresenceSyncResult[]`. O laço de entregas ganha um gancho: quando a
varredura reportar `joined`, dispare **uma** rodada de pull imediata, com
debounce de 2 s para não abrir dez rodadas quando dez pessoas entram juntas.

**E essa rodada começa do TOPO da fila, com o cursor guardado zerado** (§5.7).
Não é detalhe: a cabeça da fila é onde moram as tarefas adiadas com
`PLAYER_OFFLINE`, e acabou de entrar exatamente uma das pessoas que faltavam.
Continuar do meio da varredura entregaria a tarefa dele quando a volta chegasse
lá — que é o atraso que este gancho existe para não ter.

**O gancho NÃO existe hoje, e é preciso escrevê-lo.** `PresenceWatcher.sweep()`
(`core/src/players/presence.ts:418-427`) é `Promise<void>` e **descarta** o
retorno de `syncAll()`; o `joined` morre dentro do tracker. Por isso
`core/src/players/presence.ts` entra no mapa do §14.0 como **ALTERADO**:

```ts
  export interface PresenceWatcherOptions {
    /* … */
+   /**
+    * Alguém CONECTOU nesta varredura.
+    *
+    * Existe para a fila de entregas acordar na hora certa (Docs\20
+    * §10.7): o item pago é entregue no minuto em que o jogador
+    * abre o inventário, e não até 15 s depois. Opcional — sem a
+    * integração com o site, ninguém o passa.
+    */
+   readonly onJoined?: ((serverId: string, steamIds: readonly string[]) => void) | undefined;
  }

  async sweep(): Promise<void> {
-   await this.#tracker.syncAll();
+   const results = await this.#tracker.syncAll();
+
+   for (const result of results) {
+     if (result.joined.length === 0) {
+       continue;
+     }
+
+     try {
+       this.#onJoined?.(result.serverId, result.joined);
+     } catch (error) {
+       // O gancho é conveniência. Um erro nele NÃO pode derrubar a
+       // varredura de presença, que é quem conta tempo de jogo.
+       this.#logger.warn({ err: toError(error) }, 'presence onJoined hook failed');
+     }
+   }
  }
```

E, no §14.15, `onJoined: () => siteDeliveries?.wake()`.

Sem isso, `SiteDeliveries.wake()` (§14.6) nunca é chamado, e um jogador que entra
logo depois de um poll espera até 15 s pelo item que ele já pagou — justamente no
minuto em que ele está olhando o inventário, que é a razão escrita desta seção.

---

### 10.8 O servidor local que recebe, e quando ele não está lá

`SITE_LOCAL_SERVER_ID` diz **qual servidor de `Configs\`** recebe o que foi
comprado no site (§16.1). Ele pode não estar disponível na hora do pull por três
motivos, e o desfecho é o mesmo nos três:

| Situação | ACK | Por quê |
|---|---|---|
| o servidor existe mas o RCON está fora | `deferred` / `RCON_UNAVAILABLE` | ele volta; a tarefa é dele |
| o servidor está desabilitado no supervisor | `deferred` / `RCON_UNAVAILABLE` | idem — desabilitar não é apagar |
| o id **sumiu de `Configs\`** | `deferred` / `RCON_UNAVAILABLE`, **e um `logger.error` por rodada** | ver abaixo |

**Por que `deferred` e não `failed` nos três.** `failed` devolve o item para
`available` no site, e o jogador resgata de novo — **no mesmo servidor morto**,
porque a escolha do servidor é dele e o site não sabe que o agente daqui está
capenga. O laço seria: resgata, falha, volta, resgata. `deferred` mantém o item
em `processing` e a tarefa esperando, que é a verdade: *ainda não*.

**O terceiro caso ganha alarme** porque ele não se conserta sozinho: um
`SITE_LOCAL_SERVER_ID` apontando para um servidor que não existe mais é
configuração errada, e o boot só o pega no restart seguinte (§14.14). Enquanto
isso a fila inteira fica em `deferred` sem que ninguém saiba por quê — que é o
pior jeito de uma fila parar.

---

## 11 — Reconciliação do `unknown`

### 11.1 O relógio

`core/src/store/settle.ts` — `PurchaseSettler`, no mesmo molde de watcher do §9.1.
`SITE_SETTLE_INTERVAL_MS`, default **60 000**, no molde dos guards do site.

Ele varre no máximo **50 compras por rodada** — o canal `/api/agent` não tem
rate-limit, e a consulta é sempre por referência, nunca uma listagem.

####  E ELE DESISTE  ####

Um relógio que tenta "no próximo minuto" **para sempre** não é resiliência: é um
gerador de carga. Com a rota de prova respondendo 400 (referência gravada torta)
ou 403 (IP fora da allowlist), a compra nunca sai do laço, o alarme de
"indeterminada velha" (§18.4) dispara e nunca cala, e o settler queima até 50
requisições por minuto contra um pedido que jamais vai passar — num canal que o
próprio §5.6 lembra não ter freio (`securityMiddleware.ts:30-36` isenta
`/api/agent` do `globalLimiter`).

**Dois tetos, e os dois são por compra:**

| Constante | Valor | O que acontece ao estourar |
|---|---|---|
| `SETTLE_MAX_ATTEMPTS` | **60** rodadas | a compra sai do laço automático |
| `SETTLE_MAX_AGE_MS` | **6 h** desde o `created_at` | idem, o que vier primeiro |

Ao estourar, a compra vira `failed` com
`error = 'CHARGE_UNPROVABLE: <motivo> after <n> attempts'`, entra no contador
`purchases.unprovable` do §9.6, dispara o alarme e **espera gente**. O botão do
§11.6 continua funcionando: um humano que consertou o site ou a allowlist manda
tentar de novo, uma vez, sem esperar o relógio.

O contador de tentativas mora numa coluna própria — `settle_attempts INTEGER NOT
NULL DEFAULT 0` na migração 035 — e não em memória: um restart do agente não pode
zerar o teto, ou o laço volta a ser eterno na primeira queda.

### 11.2 A margem de 90 segundos, e por que ela existe

**Só entram na varredura compras com mais de 90 s.**

O motivo é exato: o agente aborta em 5 s (`SITE_TIMEOUT_MS`), mas o site pode
continuar processando. Reconciliar dentro dessa janela veria "nenhuma linha"
enquanto a transação ainda está em voo — e cancelaria uma compra que estava
prestes a ser cobrada. É a janela da decisão errada, e ela é a adaptação do
`MIN_AGE_MS` de 2 minutos que o `conanDeliveryGuard` do site usa pela mesma razão.

### 11.3 O que a varredura pega

A tabela abaixo prescreve **idades diferentes** para cada estado e um filtro por
`error`. Um `@cutoff` só não expressa isso: com 90 s, todo `debited` de 91 s
entraria (contra os 5 min) e **todo** `failed` entraria — inclusive os de
`INSUFFICIENT_FUNDS`, e o settler passaria a reprocessar toda compra recusada por
saldo. A consulta precisa dos predicados por extenso:

```sql
SELECT * FROM store_purchases
 WHERE (state = 'pending'         AND updated_at <= @orphanCutoff)
    OR (state = 'charge-unknown'  AND updated_at <= @unknownCutoff)
    OR (state = 'debited'         AND updated_at <= @debitedCutoff)
    OR (state = 'failed'
        AND error LIKE 'REFUND_RETRYABLE%'
        AND updated_at <= @unknownCutoff)
 ORDER BY updated_at ASC
 LIMIT 50
```

| Estado | Idade mínima | O que o settler faz |
|---|---|---|
| `pending` | **5 min** (`orphanCutoff`) | **a compra órfã** — ver abaixo |
| `charge-unknown` | 90 s (`unknownCutoff`) | pergunta a prova (§11.4) |
| `debited` | 5 min (`debitedCutoff`) | **não reentrega às cegas** — vai para conferência humana, com o comando exato registrado |
| `failed` com `error` começando em `REFUND_RETRYABLE` | 90 s | **repete o estorno** com a MESMA chave `:refund` — repetir crédito é seguro |
| `failed` com `error` começando em `REFUND_REJECTED` | — | **não entra.** O site recusou o crédito por defeito de contrato; repetir é laço eterno. Conferência humana (§12.4) |
| `failed` com `error` começando em `CHARGE_UNPROVABLE` | — | não entra; já saiu do laço por teto (§11.1) |
| `failed` por outros motivos | — | não entra; já está fechada |

####  A COMPRA `pending` ÓRFÃ, QUE NINGUÉM OLHAVA  ####

`StoreService.buy` grava `state='pending'` **antes** de chamar a carteira
(`core/src/store/service.ts:257-280`), e isso é de propósito: a linha existe
antes de o dinheiro se mexer, então nenhuma cobrança acontece sem registro. Mas
se o agente reiniciar entre `createPurchase` e o retorno do débito — o cenário
"o agente reinicia no meio de uma compra", que o §4.3 diz ter fechado —, a linha
fica `pending` **para sempre**, e o dinheiro pode ter saído.

Na versão anterior desta consulta, `pending` não entrava na varredura, não
contava em `stats.stuck` e não tinha alarme. Era o buraco de sempre, com um nome
novo. O índice já previa isso: `idx_store_purchases_stuck` inclui `'pending'`
(§15.1).

O tratamento é o do `charge-unknown`, com uma ramificação a mais:

| `reference` da linha | O settler faz |
|---|---|
| preenchida | trata como `charge-unknown`: pergunta a prova pela referência gravada |
| `NULL` (a compra morreu antes de gravar, ou é anterior à 035) | fecha como `failed` com `error='CHARGE_UNKNOWN_NO_REFERENCE'` e **alarma**. Sem referência não há o que perguntar — e deixá-la muda é o mesmo que não ter estado |

### 11.4 Como uma compra sai de indeterminada

```
GET /api/agent/ozcoins/transaction?referenceId=<ref>&steamId=<id>
```

| Resposta | Significa | O settler faz |
|---|---|---|
| 200 `found: true`, e a linha tem `delivery` | **o dinheiro saiu** | grava `state='debited'` + `site_transaction_id`, e retoma o fluxo normal: entrega o **plano congelado**; se a entrega falhar, estorna com `<ref>:refund` |
| 200 `found: true`, e `delivery IS NULL` | o dinheiro saiu e **não sabemos o que prometemos** | `state='debited'`, `error='PLAN_MISSING'`, alarme e conferência humana. **Não entrega nada** — ver abaixo |
| 404 `REFERENCE_NOT_FOUND` | **nada foi cobrado** | `state='failed'`, `error='CHARGE_NEVER_HAPPENED'`. O jogador não perdeu nada, e **nenhuma cobrança é feita agora** |
| 404 `REFERENCE_NOT_MINE` | a linha existe e **não é nossa** | **não decide nada, e sai do laço**: `state='failed'`, `error='CHARGE_UNPROVABLE: REFERENCE_NOT_MINE'`, alarme. Ver §5.6 |
| 400 `INVALID_STEAM_ID` / `INVALID_REFERENCE_ID` | a pergunta é inválida **para sempre** | `state='failed'`, `error='CHARGE_UNPROVABLE: <code>'`, alarme e conferência humana — **nunca um débito novo** |
| 403 / 429 / 5xx / timeout | não sei | **não decide nada**. Conta uma tentativa, e o relógio tenta no próximo minuto — até o teto do §11.1 |

As duas últimas linhas são a invariante: **na dúvida, preserva.** E a
penúltima é a que impede a preservação de virar laço: *"na dúvida, preserva"* não
é *"na dúvida, bate no site para sempre"*.

####  DUAS RECUSAS QUE O SETTLER FAZ ANTES DE PERGUNTAR  ####

**1. O `serverId` embutido na referência tem de ser o de agora.** A referência é
`rust:<serverId>:loja:<purchaseId>` (§6.1), e o `serverId` dela é o de **quando a
compra foi feita**. Se ele não casar com o `SITE_SERVER_ID` atual, a rota de
prova vai responder 404 — porque a conferência `tx.serverId === req.serverId`
falha — e o agente concluiria "nunca aconteceu" para uma cobrança **real**. O
settler nem pergunta: fecha com `CHARGE_UNPROVABLE: SERVER_ID_CHANGED` e alarma.
Ver §20.6.

**2. A linha é RECLAMADA antes de agir.** O relógio e o botão do §11.6 chamam a
mesma função — e nada impede que os dois estejam sobre a **mesma compra** ao
mesmo tempo: o `#running` de §14.7 protege contra duas rodadas do relógio, não
contra o relógio e um humano clicando. Duas execuções concorrentes de `settle`
sobre um `charge-unknown` produziriam duas provas 200, duas gravações de
`debited` e **duas entregas** — item duplicado, uma cobrança.

A reivindicação é um compare-and-set, e ela é barata:

```sql
UPDATE store_purchases
   SET settling_at = @now, updated_at = @now
 WHERE server_id = @serverId AND id = @id
   AND state = @expectedState
   AND (settling_at IS NULL OR settling_at <= @staleClaim)
```

Zero linhas afetadas = **outro já pegou**, e a chamada devolve `outcome: null`
sem tocar em nada. O `staleClaim` (`@now - 5 min`) existe para um agente que
morra no meio do settle não deixar a compra reivindicada para sempre.

`settling_at INTEGER` é coluna, e não um sexto valor no CHECK de `state`, por uma
razão: um estado a mais mudaria o enum público de `GET /api/store/purchases` e a
tela do painel, e "estou olhando esta linha agora" não é um desfecho de compra —
é um cadeado.

**De onde vem a receita da entrega.** A compra guarda o que ia ser entregue, num
campo `delivery` gravado na criação (coluna nova, migração 035). Sem ele, o
settler teria de reler `store_offers` — e uma oferta editada entre a compra e a
reconciliação entregaria **outra coisa**, cobrada com o preço de ontem.
**Alternativa descartada:** reler a oferta e recusar se `unitPrice` e `offerName`
divergirem. Funciona, mas transforma toda edição de catálogo numa compra presa a
mais, e não cobre o caso da oferta apagada.

**Como ela é LIDA**, porque gravar sem dizer como se lê é meio contrato:

```ts
// core/src/store/service.ts — junto de `DeliveryPlan` (§14.11d)

const deliveryPlanSchema = z.object({
  items: z.array(offerItemSchema).max(40).default([]),
  vehicle: offerVehicleSchema.nullable().default(null),
  vip: offerVipSchema.nullable().default(null),
  // Congelado como 1 desde a 035: o plano JÁ está multiplicado.
  units: z.number().int().min(1).max(1000).default(1),
});

/**
 * `null` em dois casos, e os dois são LEGÍTIMOS:
 *
 *   - compra anterior à migração 035 (o `INSERT … SELECT` grava NULL);
 *   - compra feita com a carteira LOCAL, antes da virada.
 *
 * Um JSON que não passa no schema também vira `null` — e `null` NÃO
 * é "entregue o que der": é "não sei o que prometi", e o desfecho
 * dele está na tabela acima.
 */
export function planFromJson(raw: string | null): DeliveryPlan | null {
  if (raw === null) {
    return null;
  }

  try {
    return deliveryPlanSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
```

### 11.5 O fallback, se a rota de prova não existir

Se o dono recusar criar `GET /api/agent/ozcoins/transaction` (§22, pergunta 6),
o único caminho é **repetir o débito com o MESMO `referenceId`**:

- é seguro para o dinheiro **NA CHAVE**: o site devolve `idempotent: true` se já
  tinha cobrado com aquele `referenceId`, e não cobra duas vezes por ele;
- é **caro para o jogador**: se não tinha cobrado, cobra **agora** — possivelmente
  minutos depois, de alguém que já fechou o jogo e desistiu.

####  "IDEMPOTENTE NA CHAVE" NÃO É "IDEMPOTENTE NA COMPRA"  ####

E é aqui que a frase acima quase mente. O `referenceId` é derivado de um
`purchaseId` **novo a cada tentativa**
(`core/src/store/service.ts:163-165`): duas tentativas do mesmo jogador pelo
mesmo item produzem **duas chaves diferentes**. Se o jogador já recomprou — e ele
provavelmente recomprou, porque o plugin liberou o botão dele no timeout —, o
redébito da referência antiga cobra o **mesmo item de novo**, com cada cobrança
perfeitamente idempotente na própria chave.

Por isso o default é `0`, e por isso ele **só deve ser ligado depois** de a trava
de compra em voo existir (§14.11c). Ligá-lo antes é somar as duas falhas.

**E o desfecho `insufficient` no redébito precisa estar escrito**, senão o laço
volta: o jogador foi cobrado pela recompra e não tem saldo para a antiga. Nesse
caso a compra fecha como `failed` com
`error='CHARGE_NEVER_HAPPENED_NO_FUNDS'` e vai para conferência humana — **nunca**
para retry. Um saldo que não deu agora não vai dar no minuto seguinte, e tentar é
transformar a reconciliação num cobrador.

Por isso a consulta de prova é recomendada, e por isso o fallback fica atrás de
uma variável (`SITE_SETTLE_FALLBACK_REDEBIT`, default `0`).

### 11.6 O botão

`POST /api/servers/:id/store/purchases/:purchaseId/settle`, sem corpo:

```json
{ "ok": true, "outcome": "delivered", "message": "A cobrança existia; o item foi entregue." }
```

`outcome` é `'delivered' | 'refunded' | 'cancelled' | 'review' | null` — os cinco
valores de `SettleOutcome` (§14.7), e são **os mesmos** nos dois lugares:

| `outcome` | Significa | `state` que ficou |
|---|---|---|
| `delivered` | a cobrança existia e o item foi entregue | `delivered` |
| `refunded` | a cobrança existia, a entrega falhou, o valor voltou | `refunded` |
| `cancelled` | a prova disse que **nada** foi cobrado | `failed` / `CHARGE_NEVER_HAPPENED` |
| `review` | saiu do laço automático e **espera gente** | `failed` / `CHARGE_UNPROVABLE:…`, ou `debited` / `PLAN_MISSING` |
| `null` | **sem desfecho**: o site não respondeu, é cedo demais, ou outro já reivindicou | não mudou |

`review` não é um `state`: ele é o que a **chamada** devolve quando a compra saiu
do laço. O CHECK da 035 continua com seis valores — `pending`, `debited`,
`delivered`, `refunded`, `failed`, `charge-unknown` —, e quem responde "isto
precisa de gente" é a dupla `state='failed'` + `error` começando em
`CHARGE_UNPROVABLE`. Um sétimo estado mudaria o enum público de
`GET /api/store/purchases` e a tela do painel por causa de uma informação que já
cabe no `error`.

**A rota e o relógio chamam a MESMA função** — `StoreService.settle(...)`. Dois
códigos que decidem a mesma coisa discordam no primeiro ajuste, e o dia em que
discordarem é o dia em que alguém for cobrado duas vezes. É a lição do
`reconcileInventoryItem` do site, que é exatamente o botão do guard automático.

---

## 12 — Estorno

### 12.1 Quando

Só num caso: **a entrega falhou DEPOIS de o dinheiro sair.** Ou seja, a partir de
`state='debited'`. Nunca a partir de `charge-unknown` — lá não há prova de que
alguém foi cobrado, e estornar sem cobrança cria dinheiro.

O caminho já existe e não muda de forma
(`core/src/store/service.ts:415-459`): `#deliver` lança com o código cru do
plugin, `#refund` credita, e o desfecho vira `refunded` ou `failed`.

### 12.2 Com que referência

`<referenceId da compra>:refund`, derivado dentro do `SiteWallet.credit`
(§8.3).

**O que aconteceria com a mesma referência do débito:** o site veria o
`referenceId` no lookup (`agent-ozcoins.controller.ts:80-83`), responderia
`idempotent: true` com os números do **débito**, e **não creditaria**. O agente
leria sucesso e gravaria `refunded`. O jogador ficaria sem o item **e** sem o
dinheiro, com uma resposta de sucesso em todo lugar que alguém fosse olhar. É a
falha mais cara que o sufixo evita, e é por isso que ele é derivado na carteira e
não montado por quem chama.

**O que aconteceria com o sufixo cortado por tamanho:** a compra passaria e o
estorno tomaria 400 — no único caminho em que o jogador já pagou e não recebeu
nada. É por isso que a compra é limitada a 113 chars (§6.3).

### 12.3 O texto do extrato

```
observacao: "Estorno: entrega falhou (INVENTORY_FULL)"
```

O código cru entre parênteses, em inglês, porque é o que o suporte procura no log
do agente; a frase em volta em português, porque é o jogador que a lê no extrato
do site.

### 12.4 Se o estorno também falhar

| Desfecho do crédito | `state` | `error` | O que acontece depois |
|---|---|---|---|
| `ok` | `refunded` | o motivo da falha de entrega | nada; a compra fechou |
| `unknown` (timeout, 5xx) | `failed` | `REFUND_RETRYABLE: <motivo>` | **o settler repete o crédito com a MESMA chave**, a cada rodada, até o teto do §11.1 |
| `unavailable` | `failed` | `REFUND_RETRYABLE: <motivo>` | idem |
| `rejected` (400/409) | `failed` | `REFUND_REJECTED: <código>` | **não repete**: é defeito de contrato. Alarme e conferência humana |
| `insufficient` | impossível | `REFUND_REJECTED: CREDIT_422` | se acontecer, é defeito; trate como `rejected` |

####  POR QUE DOIS PREFIXOS, E NÃO UM  ####

A versão anterior desta tabela gravava `DELIVERY_AND_REFUND_FAILED: <motivo>` nos
**quatro** casos ruins, e a varredura do §11.3 selecionava a linha exatamente por
esse prefixo. O settler não tinha como distinguir o estorno que **deve** ser
repetido do que **nunca** deve — o estado gravado era idêntico. Resultado: o
relógio repetiria para sempre, a cada rodada, um crédito que o site já recusou
por defeito de contrato, contra um canal sem rate-limit
(`securityMiddleware.ts:30-36`).

Dois prefixos resolvem sem nenhuma coluna nova:

- **`REFUND_RETRYABLE:`** entra na varredura. Repetir um crédito com a mesma
  chave `:refund` é seguro — o site devolve `idempotent: true` e não credita duas
  vezes.
- **`REFUND_REJECTED:`** **não** entra. Ele vai para a tela de conferência e para
  o alarme, e só sai de lá pela mão de alguém.

A frase antiga continua no log (`compra PRESA: debitada, não entregue e não
estornada`), porque é por ela que o suporte procura. O que muda é o que fica
**gravado na linha**, que é o que o relógio lê.

O `logger.error('compra PRESA: debitada, não entregue e não estornada')` de
`core/src/store/service.ts:448-451` continua, e ganha o `reference` no objeto de
log — sem ele, ninguém consegue procurar a linha no ledger do site.

### 12.5 As duas coisas que o estorno NÃO faz

1. **Timeout na ENTREGA nunca estorna.** Reexecutar `origemz.give` é idempotente
   do lado errado — entregaria duas vezes. A compra vai para `failed` com o
   motivo, e um humano decide. Estornar aqui deixaria o jogador com o item **e**
   com o dinheiro.
2. **Entrega parcial de um kit estorna o valor INTEIRO**, e o jogador fica com
   parte dos itens. É erro para o lado do jogador, de propósito: não existe tomar
   de volta um item que pode ter sido usado, guardado ou dropado no segundo
   seguinte. Está escrito assim em `core/src/store/service.ts:334-347` e não
   muda.

---

## 13 — Push do catálogo da loja in-game

### 13.1 O que viaja

O espelho é **somente leitura** do lado do site: categorias e ofertas, com preço,
ícone, etiqueta e ordem. O corpo inteiro está no §5.9.

**O que NÃO viaja, e por quê:**

| Campo | Por que fica |
|---|---|
| `offer.items[]` | é a **receita da entrega**. O painel do site não precisa dela para vender, e vazá-la daria a receita a quem lesse a resposta |
| `offer.vip` / `offer.vehicle` | mesma razão: `tier`, `days`, `prefab` e `fuel` são execução |
| a carteira, o histórico, o `steamId` de quem comprou | o espelho é de **catálogo**, não de vendas |

No lugar dos itens vai `itemCount: number` — que é o que a vitrine do painel
precisa para dizer "kit com 8 itens".

### 13.2 O versionamento

```ts
version = sha256(stableStringify(corpo SEM `version` e SEM `generatedAt`))
```

**`generatedAt` fica FORA da conta.** Se entrasse, a `version` mudaria a cada
montagem, o espelho seria empurrado a cada volta do relógio e 2 MiB atravessariam
a internet por nada.

**`stableStringify` ordena CHAVE de objeto, nunca elemento de array** — ordem de
array é conteúdo. As ofertas saem do banco com
`ORDER BY position ASC, name COLLATE NOCASE`
(`core/src/db/store-repository.ts:428-438`), então a ordem já é determinística —
não acrescente uma ordenação em JS por cima dela, ou duas verdades sobre a ordem
passam a existir.

O agente guarda a última versão **confirmada pelo site** em `meta`, com as chaves
`site.catalog.mirrored_version` e `site.catalog.mirrored_at` — a mesma tabela
key/value que o catálogo de itens já usa (`core/src/db/items-repository.ts:386-404`).
Nenhuma migração nova é necessária para isso.

### 13.3 Quando pular

```
a cada 60 s (DEFAULT_MIRROR_INTERVAL_MS) e 2 s depois de cada edição
(MIRROR_DEBOUNCE_MS) — as duas são CONSTANTES, não variáveis de ambiente:

 1. monta o payload e calcula a version local
 2. version local == mirrored_version guardada?  -> não faz nada
 3. GET /api/agent/shop/mirror/version           -> reconfere com o site
 4. iguais?                                       -> grava mirrored_version e para
 5. diferentes -> POST /api/agent/shop/mirror com o snapshot inteiro
 6. 2xx -> grava mirrored_version e mirrored_at
    erro -> grava lastPushError e tenta no próximo minuto
```

####  OS DOIS NÚMEROS SÃO CONSTANTES, E NÃO VARIÁVEL DE `.env`  ####

`DEFAULT_MIRROR_INTERVAL_MS = 60_000` e `MIRROR_DEBOUNCE_MS = 2_000` moram em
`core/src/store/catalog-mirror.ts` (§14.8). **A única variável de ambiente do
espelho é `SITE_CATALOG_PUSH_ENABLED`** — as doze do §16.1 são todas as que
existem, e nenhuma outra do espelho está no `.env.example` do §16.4 nem é lida no
§14.14.

**Este trecho já citou `SITE_CATALOG_PUSH_INTERVAL_MS` como se fosse `.env`**, e
esse nome não existe em lugar nenhum: nem na tabela do §16.1, nem no
`.env.example`, nem na leitura do §14.14. É exatamente o defeito que o §16.1
registra ter consertado em `SITE_SETTLE_FALLBACK_REDEBIT` e
`STORE_MAX_OZ_PER_PURCHASE` — variável declarada num canto e sem linha de leitura
em canto nenhum —, só que pelo lado pior: aqui quem fosse implementar iria
procurar o campo em `config.site`, não achar, e **inventar** um. Se um dia a
cadência precisar virar variável de verdade, o preço está escrito e são quatro
lugares: a tabela do §16.1, o `.env.example` do §16.4, a leitura do §14.14 e o
default do §14.8.

**O relógio de 60 s NÃO pode ser desligado**, e aqui está a diferença mais
importante em relação ao catálogo do Conan: lá o push é otimização e o **poll do
agente** é a garantia de convergência. Aqui a direção é invertida e **não há poll
do outro lado** — o relógio *é* a convergência. Um push que falha não alarma, não
bloqueia a loja in-game e não derruba o save da oferta; ele só deixa
`lastPushError` preenchido.

**Mutex com bit de sujo.** Uma rodada em voo e, no máximo, uma pendente. Sem ele,
três saves em dois segundos abrem três rodadas concorrentes, e a ordem de chegada
na rede deixa de casar com a ordem de gravação — a tela diria V3 com o painel
mostrando V2.

**Teto de 2 MiB, conferido ANTES de sair**, com o código `MIRROR_TOO_LARGE` na
tela do agente. Truncar seria pior: meio catálogo no painel é uma mentira mais
cara que catálogo velho.

**Se o site responder 2xx com uma `version` diferente da nossa: ignore.** Só a
`mirrored_version` que o agente gravou manda.

### 13.4 Quem dispara a edição

As **seis** rotas que mexem no catálogo (`core/src/http/routes/store.ts` tem 14
ao todo; estas são as únicas que mudam categoria ou oferta):
`POST /store/categories` (:238), `PUT /store/categories/:id` (:256),
`DELETE /store/categories/:id` (:273), `POST /store/offers` (:313),
`PUT /store/offers/:id` (:335), `DELETE /store/offers/:id` (:359) — e mais nada.
Cada uma chama `catalogMirror.notifyChanged()` **sem `await` e dentro de
try/catch**: uma falha de push não pode desfazer uma edição que já foi gravada.

`SITE_CATALOG_PUSH_ENABLED=0` desliga o espelho inteiro. Com ele desligado, a
loja in-game continua funcionando e o painel do site simplesmente não enxerga a
loja do Rust.
---

## 14 — Todas as mudanças de código, arquivo por arquivo

### 14.0 O mapa

| # | Arquivo | O quê |
|---|---|---|
| 14.1 | `core/src/store/reference.ts` | **NOVO** — a convenção de `referenceId` |
| 14.2 | `core/src/site/client.ts` | **NOVO** — o transporte, e a única fronteira de `moedas`/`observacao` |
| 14.3 | `core/src/store/site-wallet.ts` | **NOVO** — a terceira `Wallet` (arquivo inteiro no §8.3) |
| 14.4 | `core/src/site/beacon.ts` | **NOVO** — o batimento e o estado de pareamento |
| 14.5 | `core/src/db/site-deliveries-repository.ts` | **NOVO** — a idempotência local da entrega |
| 14.6 | `core/src/site/deliveries.ts` | **NOVO** — o laço de pull e ACK |
| 14.7 | `core/src/store/settle.ts` | **NOVO** — o relógio da reconciliação |
| 14.8 | `core/src/store/catalog-mirror.ts` | **NOVO** — o espelho do catálogo |
| 14.9 | `core/src/http/routes/site.ts` | **NOVO** — `/api/site/status` e `/api/site/beacon` |
| 14.10 | `core/src/store/wallet.ts` | **ALTERADO** — a união, a entrada em objeto, e `RemoteWallet` apagada |
| 14.11 | `core/src/store/service.ts` | **ALTERADO** — cinco desfechos, `reference`, `delivery`, `settle` |
| 14.12 | `core/src/db/store-repository.ts` | **ALTERADO** — o estado novo e três colunas |
| 14.13 | `core/src/db/migrations.ts` | **ALTERADO** — as migrações 035 e 036 (§15) |
| 14.14 | `core/src/config.ts` | **ALTERADO** — o bloco `site` |
| 14.15 | `core/src/index.ts` | **ALTERADO** — a montagem e os quatro relógios |
| 14.16 | `core/src/http/routes/store.ts` | **ALTERADO** — 202, `settle`, enum e corpo |
| 14.17 | `core/src/http/server.ts` | **ALTERADO** — uma opção e um `registerSiteRoutes` |
| 14.18 | `core/src/game/ui-store-bridge.ts` | **ALTERADO** — `balance` que já pode ser `null` |
| 14.19 | `panel/src/lib/api.ts` e `panel/src/app/jogador/page.tsx` | **ALTERADO** — `balance: number \| null` |
| 14.20 | `.env.example`, `Docs/README.md`, `README.md` | **ALTERADO** — documentação |
| 14.21 | `core/src/site/mac.ts` | **NOVO** — `primaryMac()`, o endereço que o beacon manda |
| 14.22 | `core/src/db/meta-repository.ts` | **NOVO** — a tabela `meta` como repositório reusável |
| 14.23 | `core/src/players/presence.ts` | **ALTERADO** — o gancho `onJoined` (§10.7) |
| 14.24 | `core/test/store.test.ts` | **ALTERADO** — o dublê de `Wallet` que a união nova quebra |
| — | `core/src/game/ui-store-screens.ts` | **NÃO MUDA** — ver 14.18 |

**As quatro últimas linhas não são detalhe.** As três primeiras são chamadas pelo
código deste documento e **não existem na árvore**
(`grep -rn "primaryMac\|metaRepository\|onJoined" core/src` devolve zero), e a
quarta é a única coisa que impede o `npm test -w core` de ficar verde na fase 2.
Quem implementar sem elas trava — e, no caso do `primaryMac`, inventar errado
significa mandar o MAC de uma interface virtual para o site, que o grava em
`beaconMac` e o usa em `findBan`.

**Regra de arquivo compartilhado**, do `Docs/17-FRENTES-WIPE-E-MENSAGENS.md:39-58`:
`migrations.ts`, `http/server.ts`, `index.ts` e `panel/src/lib/api.ts` se tocam
**por anexação, no fim do bloco existente**. Não reordene imports, não reformate.
A reordenação é o que transforma duas linhas somadas num conflito de trinta.

---

### 14.1 `core/src/store/reference.ts` — NOVO

O arquivo inteiro está no §6.4. Ele exporta `REFERENCE_MAX_CHARS`,
`REFUND_SUFFIX`, `PURCHASE_REFERENCE_MAX_CHARS`, `buildReference` e
`refundReferenceOf`. Nenhuma dependência além de `node:crypto` — é uma função
pura, e por isso é o teste mais barato do §19.

---

### 14.2 `core/src/site/client.ts` — NOVO

```ts
// ============================================================
//  client.ts  -  o transporte até o site OrigemZ.
//
//  ####  ESTE É O ÚNICO ARQUIVO QUE FALA `moedas` E `observacao` ####
//
//  Os dois nomes são do CONTRATO DO SITE — ele os expõe assim, e
//  renomeá-los quebraria a integração. Daqui para dentro do
//  RustAgent eles viram `balance` e `reason`, e nenhum outro
//  arquivo precisa saber que a outra grafia existe. Um segundo
//  lugar que traduzisse os mesmos campos seria o começo de um
//  arquivo bilíngue, e a partir daí ninguém sabe qual usar.
//
//  ------------------------------------------------------------
//  ####  NADA AQUI LANÇA POR CAUSA DA REDE  ####
//
//  Toda falha vira um `SiteResult` com `ok: false`. Quem chama
//  roda dentro de um relógio ou no caminho de um jogador que
//  clicou, e um `throw` nos dois lugares é um laço morto ou um
//  menu travado. É a mesma disciplina do RustMapsClient.
//
//  ####  O CORPO NUNCA CARREGA `balance`, `ozBalance` NEM `epBalance` ####
//
//  O site tem um middleware GLOBAL (`validateBalanceChange`) que
//  responde 403 `{error:'Operação não permitida'}` SEM `error_code`
//  quando um desses três nomes aparece no corpo como valor
//  primitivo. Quem for acrescentar campo aqui: nenhum deles.
//
//  ####  O User-Agent NÃO É ENFEITE  ####
//
//  A borda do site recusa famílias genéricas de cliente HTTP com um
//  403 de corpo em TEXTO PURO contendo `error code: 1010`. Ele se
//  parece com um ban e não é um — no painel do Conan isso custou
//  horas procurando ban numa tabela vazia.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

export const SITE_DEFAULT_TIMEOUT_MS = 5_000;

/** O desfecho de UMA conversa com o site. Ver Docs\20 §4.2. */
export type SiteResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      /** `null` = não chegou no site (timeout, DNS, TLS, cabo). */
      readonly status: number | null;
      /** O `error_code` do site, quando ele veio. */
      readonly code: string | null;
      /** A frase do site, ou a do erro de rede. Vai para log e tela. */
      readonly reason: string;
      /** O corpo, quando deu para ler. Carrega `charged` nos 409. */
      readonly body: Record<string, unknown> | null;
    };

export interface SiteClientOptions {
  /** A ORIGEM do site, sem caminho e sem barra no fim. */
  readonly baseUrl: string;
  /** Vazio = o agente ainda não foi ativado; só o beacon sai. */
  readonly token: string;
  readonly serverId: string;
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger | undefined;
  /** Injetável para o teste não sair na rede. Ver core/test/fixtures/LEIA-ME.md. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export class SiteClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #serverId: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: SiteClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#serverId = options.serverId;
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs ?? SITE_DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** Há token? Sem ele, só o beacon fala com o site. */
  get authenticated(): boolean {
    return this.#token !== '';
  }

  get serverId(): string {
    return this.#serverId;
  }

  // ---- beacon (sem bearer e sem X-Server-Id) ----------------

  /**
   * O batimento. Ele NÃO passa pelo `#call`, e isso é deliberado.
   *
   * ####  A ÚNICA ROTA SEM `Authorization` E SEM `X-Server-Id`  ####
   *
   * O `serverId` vai no CORPO, e o site não o lê do header nesta
   * rota (`agent-public.routes.ts:39-47`). Mandar o header não
   * quebraria nada — mas o critério do §21.1 fala de "toda chamada
   * autenticada", e o beacon não é uma delas: um teste escrito
   * contra o `#call` fixaria o comportamento errado.
   *
   * O que ele leva, e só isto: `Accept`, `User-Agent`,
   * `Content-Type` e — quando há token — os dois headers de
   * assinatura do §9.4.
   */
  async beacon(input: {
    readonly port: number;
    readonly version: string;
    readonly mac: string;
    readonly capabilities: readonly string[];
    /** Ver §9.4. Ausente quando não há token. */
    readonly signature?: { readonly timestamp: number; readonly value: string };
  }): Promise<SiteResult<BeaconBody>> {
    return this.#send('POST', '/api/agent/beacon', {
      body: {
        serverId: this.#serverId,
        port: input.port,
        version: input.version,
        mac: input.mac,
        capabilities: input.capabilities,
      },
      auth: false,
      headers:
        input.signature === undefined
          ? {}
          : {
              'X-Agent-Timestamp': String(input.signature.timestamp),
              'X-Agent-Signature': input.signature.value,
            },
    });
  }

  // ---- carteira --------------------------------------------

  async balance(steamId: string): Promise<SiteResult<BalanceBody>> {
    // `URLSearchParams` também aqui: `transaction()` já o usa, e
    // duas formas de montar a mesma query no arquivo que este
    // documento chama de "ponto único" é o começo da terceira.
    const query = new URLSearchParams({ steamId });
    const result = await this.#call('GET', `/api/agent/ozcoins/balance?${query.toString()}`);

    // ####  AQUI `moedas` VIRA `balance`, E SÓ AQUI  ####
    return result.ok
      ? { ...result, body: { balance: toInteger(result.body.moedas), exists: true } }
      : result;
  }

  /**
   * O débito e o crédito. `reason` vira `observacao` AQUI, e é o
   * único lugar onde isso acontece.
   */
  mutate(
    direction: 'debit' | 'credit',
    input: {
      readonly steamId: string;
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      readonly productId?: string;
    },
  ): Promise<SiteResult<MutationBody>> {
    // Daqui para baixo os nomes dos campos são do contrato do site.
    return this.#call('POST', `/api/agent/ozcoins/${direction}`, {
      steamId: input.steamId,
      amount: input.amount,
      referenceId: input.referenceId,
      observacao: input.reason.slice(0, 500),
      ...(input.productId === undefined ? {} : { productId: input.productId }),
    });
  }

  async transaction(
    referenceId: string,
    steamId: string,
  ): Promise<SiteResult<TransactionBody>> {
    const query = new URLSearchParams({ referenceId, steamId });
    const result = await this.#call('GET', `/api/agent/ozcoins/transaction?${query.toString()}`);

    return result.ok
      ? {
          ...result,
          body: {
            found: result.body.found === true,
            transactionId: idOf(result.body.transactionId),
            amount: toInteger(result.body.amount),
            productId: typeof result.body.productId === 'string' ? result.body.productId : null,
          },
        }
      : result;
  }

  // ---- entregas --------------------------------------------

  /**
   * Uma PÁGINA da fila. Quem caminha por elas é o `SiteDeliveries`
   * (§14.6), não este arquivo — aqui só o transporte.
   *
   * ####  `cursor` É OPACO, E O 400 DELE TEM DONO  ####
   *
   * O corpo devolve `next: string | null`, e `next` é o
   * `delivery_id` da última linha da página. Ignorá-lo é o defeito
   * do §5.7: as 50 primeiras tarefas da fila são servidas para
   * sempre e a de nº 51 nunca aparece.
   *
   * `400 INVALID_CURSOR` chega aqui como `SiteResult` com
   * `code: 'INVALID_CURSOR'`, e **quem o trata é o laço**: ele joga
   * o cursor fora e recomeça do topo. Se ele caísse na regra do 4xx
   * desconhecido (`unavailable`, retentável IGUAL), o agente
   * repetiria o mesmo cursor recusado a cada 15 s, para sempre.
   */
  pendingDeliveries(limit: number, cursor?: string): Promise<SiteResult<PendingBody>> {
    const query = new URLSearchParams({ limit: String(limit) });

    if (cursor !== undefined) {
      query.set('cursor', cursor);
    }

    return this.#call('GET', `/api/agent/deliveries/pending?${query.toString()}`);
  }

  ackDeliveries(acks: readonly DeliveryAck[]): Promise<SiteResult<AckBody>> {
    return this.#call('POST', '/api/agent/deliveries/ack', { deliveries: acks });
  }

  // ---- catálogo --------------------------------------------

  mirrorVersion(): Promise<SiteResult<MirrorVersionBody>> {
    return this.#call('GET', '/api/agent/shop/mirror/version');
  }

  pushMirror(payload: unknown): Promise<SiteResult<MirrorBody>> {
    return this.#call('POST', '/api/agent/shop/mirror', payload);
  }

  // ------------------------------------------------------------

  /** Uma chamada AUTENTICADA: bearer + `X-Server-Id`. */
  #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<SiteResult<never>> {
    return this.#send(method, path, body === undefined ? { auth: true } : { body, auth: true });
  }

  async #send(
    method: 'GET' | 'POST',
    path: string,
    options: {
      readonly body?: unknown;
      /** `false` = beacon: sem `Authorization` e sem `X-Server-Id`. */
      readonly auth: boolean;
      /** Os headers do §9.4, e nada mais. */
      readonly headers?: Record<string, string>;
    },
  ): Promise<SiteResult<never>> {
    const { body } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.#userAgent,
          // O beacon é a exceção, e ela é explícita: sem bearer e
          // sem `X-Server-Id`, que viaja no corpo. Ver `beacon()`.
          ...(options.auth && this.#token !== ''
            ? { Authorization: `Bearer ${this.#token}` }
            : {}),
          ...(options.auth ? { 'X-Server-Id': this.#serverId } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const cause = toError(error);

      // `status: null` é o sinal de "não chegou lá", e é ele que a
      // carteira lê para devolver `unknown` em vez de `unavailable`.
      return {
        ok: false,
        status: null,
        code: null,
        reason:
          cause.name === 'AbortError'
            ? `o site não respondeu em ${String(Math.round(this.#timeoutMs / 1000))} s`
            : cause.message,
        body: null,
      };
    } finally {
      clearTimeout(timer);
    }

    // Leitura DEFENSIVA: um 403 da borda vem em texto puro, e um
    // `json()` que estoure aqui viraria exceção onde só pode haver
    // desfecho.
    const text = await response.text().catch(() => '');
    const parsed = safeJson(text);

    if (response.ok) {
      return { ok: true, status: response.status, body: (parsed ?? {}) as never };
    }

    return {
      ok: false,
      status: response.status,
      code: typeof parsed?.error_code === 'string' ? parsed.error_code : null,
      reason:
        typeof parsed?.error === 'string'
          ? parsed.error
          : `o site respondeu ${String(response.status)} ${text.slice(0, 200)}`,
      body: parsed,
    };
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * O dinheiro do site chega como STRING, e comparar string com
 * string é ordem lexicográfica: `"300" > "1500"` seria verdadeiro.
 *
 * `null` = não é um inteiro. Nunca zero, que é uma afirmação.
 *
 * Ele mora AQUI, e não na carteira, porque é aqui que o dialeto do
 * site acaba. Ver §8.1.
 */
function toInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value.trim());

  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** O `transactionId` do site é BIGINT: guarde como TEXTO. */
function idOf(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

// ============================================================
//  OS CORPOS, POR EXTENSO
//
//  ####  TUDO OPCIONAL, DE PROPÓSITO  ####
//
//  Estes tipos descrevem o que o site MANDA, não o que ele promete.
//  Um campo obrigatório aqui viraria `undefined` em runtime no dia
//  em que o site mudasse, e o TypeScript não avisaria — ele acredita
//  no cast. Por isso o parse é defensivo em quem lê: a carteira
//  checa `success !== true` e `balance === null` antes de chamar
//  qualquer coisa de `ok` (§8.3).
// ============================================================

/** `POST /beacon` — §5.2. */
export interface BeaconBody {
  readonly ok?: boolean;
  readonly registered?: boolean;
  readonly status?: 'pending' | 'active' | 'banned' | string;
  readonly serverExists?: boolean;
  readonly resolvedViaAlias?: boolean;
  readonly currentServerId?: string;
  readonly message?: string;
}

/** `GET /ozcoins/balance` — JÁ TRADUZIDO. Ver §8.1. */
export interface BalanceBody {
  /** `null` = o site não devolveu um inteiro. NUNCA zero. */
  readonly balance: number | null;
  /** Sempre `true` no site. Nunca ramifique por ele — §7.2. */
  readonly exists: boolean;
}
```

> ⚠️ **`exists` AQUI É SINTÉTICO desde `oz-rust/6`.** O site parou de mandá-lo
> (04/09/2026); quem o carimba é `client.balance()`, que devolve `exists: true`
> fixo. O tipo continua honesto sobre o que o `SiteClient` entrega — e desonesto
> sobre o que o fio traz. **Pendência do lado do agent:** ou o campo sai do
> `BalanceBody` (e o `expect` do caso `ozcoins-balance` em
> `contracts/oz-rust-fixtures.json` sai junto), ou o comentário passa a dizer que
> ele é carimbado aqui e não recebido.

```ts

/** `POST /ozcoins/debit|credit` — JÁ TRADUZIDO. */
export interface MutationBody {
  readonly success?: boolean;
  /** `true` = já tinha sido cobrado. NUNCA "já foi entregue". */
  readonly idempotent?: boolean;
  /** O saldo DEPOIS. Num replay, o de ONTEM — ver §8.3. */
  readonly balance: number | null;
  readonly before: number | null;
  readonly after: number | null;
  readonly amount: number | null;
  readonly direction?: 'debit' | 'credit';
  /** Ausente no replay: o site não repete o id. TEXTO (BIGINT). */
  readonly transactionId: string | null;
}

/** `GET /ozcoins/transaction` — JÁ TRADUZIDO. §5.6. */
export interface TransactionBody {
  readonly found: boolean;
  readonly transactionId: string | null;
  readonly amount: number | null;
  readonly productId: string | null;
}

/** Uma tarefa da fila, como o site a manda. §5.7. */
export interface PendingDeliveryBody {
  readonly id?: string;
  readonly steamId?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly sourceRef?: string | null;
  readonly attempts?: number;
  readonly createdAt?: string;
  readonly expiresAt?: string | null;
}

/** `GET /deliveries/pending`. */
export interface PendingBody {
  readonly ok?: boolean;
  readonly deliveries?: readonly PendingDeliveryBody[];
  readonly next?: string | null;
}

/** Um ACK, como o agente o manda. §5.8. */
export interface DeliveryAck {
  readonly id: string;
  /**
   * TRÊS valores, e só três.
   *
   * ####  NÃO EXISTE UM QUARTO  ####
   *
   * O site responde 400 `INVALID_ACK_STATUS` PARA O LOTE INTEIRO a
   * qualquer valor fora destes (§8.7 do manual do site, regra 6):
   * um ACK torto num lote de 50 derrubaria os outros 49. O
   * indeterminado do §10.4 viaja como `deferred` com
   * `reason: 'AGENT_INDETERMINATE'`, que é o único `reason` que o
   * site interpreta.
   */
  readonly status: 'delivered' | 'failed' | 'deferred';
  readonly reason?: string;
  readonly at: string;
}

/** `POST /deliveries/ack`. */
export interface AckBody {
  readonly ok?: boolean;
  readonly applied?: number;
  /** Ver §5.8: NÃO significa "não aconteceu". */
  readonly unknown?: readonly string[];
}

/** `GET /shop/mirror/version`. `version: null` = não há espelho. */
export interface MirrorVersionBody {
  readonly ok?: boolean;
  readonly version?: string | null;
  readonly updatedAt?: string | null;
}

/** `POST /shop/mirror`. */
export interface MirrorBody {
  readonly ok?: boolean;
  readonly accepted?: boolean;
  readonly version?: string;
  readonly storedAt?: string;
}
```

**Detalhe do `beacon()`:** ele é o único método que **não passa pelo `#call`** —
sai sem `Authorization` e sem `X-Server-Id` (o `serverId` viaja no corpo), e é o
único que continua funcionando com o agente `pending`. E ele **não** monta a
assinatura sozinho: quem a monta é o `SiteBeacon`, porque só ele sabe o relógio
da rodada e o token. O `#send` aceita `headers` extras justamente por causa dele
— é por ali que `X-Agent-Timestamp` e `X-Agent-Signature` chegam ao fio.

---

### 14.3 `core/src/store/site-wallet.ts` — NOVO

**O arquivo inteiro está no §8.3**, com o cabeçalho doutrinário, os cinco
desfechos, `PAIRING_CODES`, `REJECTED_CODES` e `proveCharge`. Ele não é repetido
aqui para não haver duas versões do mesmo arquivo neste documento — a numeração
existe para que o mapa do §14.0 tenha um destino para cada linha.

---

### 14.4 `core/src/site/beacon.ts` — NOVO

```ts
// (o cabeçalho doutrinário está no §9.1)

import { createHmac } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { SiteClient } from './client.js';

export const DEFAULT_BEACON_INTERVAL_MS = 10_000;
export const MIN_BEACON_INTERVAL_MS = 5_000;
/** O site considera "online" quem beaconou nos últimos 5 min. */
export const MAX_BEACON_INTERVAL_MS = 300_000;

export const RUST_CAPABILITIES = [
  'ozcoins',
  'shop',
  'deliver_item',
  'players_online',
  'pull_delivery',
] as const;

export interface SiteBeaconOptions {
  readonly client: SiteClient;
  readonly token: string;
  readonly port: number;
  readonly version: string;
  readonly mac: string;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class SiteBeacon {
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #pairing: SitePairing = {
    status: 'unknown',
    message: null,
    lastBeaconAt: null,
    lastBeaconError: null,
    serverExists: null,
    currentServerId: null,
  };

  get pairing(): SitePairing {
    return this.#pairing;
  }

  /** Só com `active` a loja cobra. Ver §9.5. */
  get ready(): boolean {
    return this.#pairing.status === 'active';
  }

  start(): void { /* setInterval + unref + uma rodada no boot, molde do VipExpiryWatcher */ }
  stop(): void { /* clearInterval */ }

  /**
   * Uma batida. NUNCA lança: um erro aqui é rotina, e derrubar o
   * relógio deixaria o pareamento parado para sempre — em silêncio,
   * que é o pior jeito de um relógio falhar.
   */
  async beat(): Promise<SitePairing> { /* … */ }

  /**
   * Alguém viu um código de `PAIRING_CODES` numa rota autenticada:
   * o pareamento pode ter quebrado. Força uma batida AGORA.
   *
   * ####  DEBOUNCE DE 5 s, E ELE TEM NÚMERO POR UM MOTIVO  ####
   *
   * Quem chama é o `SiteWallet` (`onPairingSuspect`, §8.3), uma vez
   * por resposta ruim. Uma rajada de compras contra um token
   * rotacionado viraria um beacon por clique — o laço que o piso de
   * 5 s do `SITE_BEACON_INTERVAL_MS` existe para impedir (§9.2). O
   * debounce é o mesmo número, pela mesma razão.
   *
   * Nunca lança, e nunca `await`: quem chama está no caminho de um
   * jogador que clicou.
   */
  suspect(reason: string): void { /* debounce 5 s + beat() sem await */ }

  /**
   * HMAC-SHA256 do bearer sobre `serverId|timestamp`, em hex.
   *
   * Aditiva: um site que ainda não a exija ignora o header. Ver §9.4
   * e Docs\20 §22, pergunta 7.
   */
  #sign(timestamp: number): string {
    return createHmac('sha256', this.#token)
      .update(`${this.#client.serverId}|${String(timestamp)}`)
      .digest('hex');
  }
}
```

---

### 14.5 `core/src/db/site-deliveries-repository.ts` — NOVO

```ts
// ============================================================
//  site-deliveries-repository.ts  -  a idempotência da ENTREGA.
//
//  ####  A RESERVA ACONTECE ANTES DO COMANDO, NUNCA DEPOIS  ####
//
//  Um agente que caia entre o `origemz.give` e o ACK reencontra a
//  tarefa na próxima página do site. Sem a reserva, ele entregaria
//  de novo — item duplicado, uma cobrança. Com ela, a linha órfã
//  em `reserved` diz "o comando pode ter saído" e a tarefa vai para
//  conferência humana em vez de ser reexecutada.
//
//  ####  `indeterminate` NÃO REEXECUTA — E ACKA `deferred`  ####
//
//  Reexecutar entrega duas vezes; ACKar `failed` devolve ao site um
//  item que talvez esteja no chão do jogador. Mas NÃO ACKar também
//  não serve: a tarefa fica `pending` no site e a varredura de
//  expiração a devolve ao inventário em 30 dias, sozinha, sem saber
//  o que só nós sabemos (Docs\20 §10.4).
//
//  Então ele ACKa `deferred` com `reason: 'AGENT_INDETERMINATE'`:
//  o site move a tarefa de `pending` para `review`, o item FICA em
//  `processing`, e a expiração não a alcança. Na dúvida, PRESERVA —
//  e preservar, aqui, é falar.
//
//  ####  O NOME É `indeterminate` PORQUE `review` É DO SITE  ####
//
//  Lá, `review` é o estado para onde o site move a tarefa ao ler
//  esse `reason` — mesmo sentido, banco diferente, contagem
//  diferente. Duas telas mostram as duas contagens lado a lado, e
//  com o mesmo nome alguém concluiria que uma está errada. O FIO
//  não carrega nenhum dos dois nomes: carrega `deferred`.
// ============================================================

import type { AgentDatabase } from './database.js';

export type SiteDeliveryState =
  | 'reserved'
  | 'delivered'
  | 'failed'
  /** O agente caiu no meio. ACKa `deferred`/`AGENT_INDETERMINATE`. */
  | 'indeterminate'
  /** O site devolveu o id em `unknown` e a linha NÃO era terminal. */
  | 'expired';

export interface SiteDeliveryRow {
  readonly id: string;
  readonly serverId: string;
  readonly steamId: string;
  readonly kind: 'item' | 'kit' | 'vip' | 'vehicle';
  /** O payload como veio do site, em JSON. */
  readonly payload: string;
  readonly sourceRef: string | null;
  readonly state: SiteDeliveryState;
  readonly reason: string | null;
  readonly attempts: number;
  readonly ackedAt: number | null;
  readonly reservedAt: number;
  readonly updatedAt: number;
}

export class SiteDeliveriesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  get(id: string): SiteDeliveryRow | null { /* … */ }

  /**
   * Reserva a tarefa. `false` = alguém já reservou.
   *
   * INSERT puro, e não `INSERT OR IGNORE`: quem decide a corrida é a
   * chave primária, e é dela que sai a resposta honesta "já estava
   * reservada". Um `OR IGNORE` esconderia a colisão.
   */
  reserve(input: Omit<SiteDeliveryRow, 'state' | 'reason' | 'ackedAt' | 'updatedAt' | 'attempts'>): boolean { /* … */ }

  finish(id: string, state: SiteDeliveryState, reason: string | null, now?: number): void { /* … */ }
  markAcked(id: string, now?: number): void { /* … */ }
  countByState(state: SiteDeliveryState): number { /* … */ }

  /**
   * Um id que o site devolveu em `unknown`.
   *
   * ####  ELE SÓ APAGA O QUE NÃO É TERMINAL  ####
   *
   * `unknown` NÃO significa "não aconteceu": um `delivered`
   * reACKado volta ali, porque o site põe em `unknown` toda tarefa
   * que já saiu de `pending` (§5.8). Apagar a linha no primeiro
   * reACK jogaria fora justamente o comprovante que esta tabela
   * existe para guardar — a resposta de "o site diz que entregou;
   * entregou mesmo?", meses depois.
   *
   *   reserved / indeterminate -> vira `expired`
   *   delivered / failed       -> só `acked_at`. A LINHA FICA
   */
  settleUnknown(ids: readonly string[], now?: number): void { /* … */ }
}
```

---

### 14.6 `core/src/site/deliveries.ts` — NOVO

```ts
// ============================================================
//  deliveries.ts  -  o que foi comprado NO SITE chega no jogo.
//
//  ####  QUEM PUXA É O AGENTE  ####
//
//  A entrega no Rust exige o jogador ONLINE e VIVO, e só quem está
//  na máquina sabe disso. Um push do site chegaria na hora errada,
//  e não haveria lugar nenhum onde a tarefa esperasse.
//
//  ####  TRÊS DESFECHOS, E `deferred` É O QUE PRESERVA  ####
//
//    delivered  entregou. Fecha no site.
//    failed     falha DEFINITIVA. O item volta para o inventário.
//    deferred   NÃO DEU AGORA. A tarefa continua pendente.
//
//  Sem `deferred`, um item pago voltaria para `available` só porque
//  o jogador estava dormindo. "Não entreguei" e "ainda não" são
//  coisas diferentes.
//
//  ####  NADA AQUI LANÇA  ####
//
//  Roda num relógio. Um `throw` para a fila em silêncio.
// ============================================================

export interface DeliveryTask {
  readonly id: string;
  readonly steamId: string;
  readonly kind: 'item' | 'kit' | 'vip' | 'vehicle';
  readonly payload: DeliveryPayload;
  readonly sourceRef: string | null;
  readonly attempts: number;
}

/** O vocabulário do §5.7, validado por zod na fronteira. */
export type DeliveryPayload =
  | { readonly items: readonly { shortname: string; amount: number; skinId: string }[] }
  | { readonly tier: string; readonly days: number | null }
  | { readonly prefab: string; readonly fuel: number };

export interface SiteDeliveriesOptions {
  readonly client: SiteClient;
  readonly repository: SiteDeliveriesRepository;
  /** O servidor local que recebe. Ver §22, pergunta 10. */
  readonly serverId: string;
  /** `null` = não deu para perguntar, e é DIFERENTE de lista vazia. */
  readonly presence: { online(serverId: string): Promise<readonly string[] | null> };
  /** O MESMO caminho de entrega da compra in-game, e não um segundo. */
  readonly deliver: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly task: DeliveryTask;
  }) => Promise<void>;
  readonly logger: Logger;
  readonly pollMs?: number;
}

/**
 * Quantas tarefas cabem numa página. O site aceita até
 * `AGENT_DELIVERY_PAGE_MAX` (100) e CLAMPA o que passar — nunca
 * recusa —, mas 50 é o que o agente pede: é o mesmo teto do lote de
 * ACK, então cada página vira exatamente um `POST /deliveries/ack`.
 */
const DELIVERY_PAGE_LIMIT = 50;

/**
 * Quantas páginas uma rodada varre antes de parar e guardar o lugar.
 *
 * ####  ELE NÃO É VARIÁVEL DE AMBIENTE  ####
 *
 * Ele é derivado do rate limit do SITE, e não do gosto de quem
 * opera: 5 páginas x (1 GET + 1 ACK) x 4 rodadas por minuto = 40
 * req/min, que somados ao pico do settler (50) e ao espelho (1) dão
 * ~91 contra os 240 de `AGENT_RATE_LIMIT_PER_SERVER` (§5.7).
 * Subi-lo sem subir o teto do outro lado troca fila parada por 429
 * no meio da varredura.
 */
const DELIVERY_MAX_PAGES_PER_ROUND = 5;

export class SiteDeliveries {
  /**
   * Onde a próxima rodada do RELÓGIO recomeça.
   *
   * `null` = do topo. Preenchido quando uma rodada bateu no teto de
   * páginas — e é ele que impede a inanição da cauda: sem guardar o
   * lugar, toda rodada varreria as mesmas 250 primeiras tarefas e a
   * de nº 251 continuaria invisível (§5.7).
   *
   * Zerado em três situações: `next: null` (acabou a fila),
   * `wake()` (alguém conectou — a rodada dele começa do topo), e
   * `400 INVALID_CURSOR` (o site não reconhece mais este cursor).
   */
  #cursor: string | null = null;

  start(): void { /* relógio + unref + rodada no boot */ }
  stop(): void { /* … */ }
  /**
   * Chamada quando alguém CONECTA, com debounce de 2 s. Ver §10.7.
   * Zera `#cursor`: a tarefa que essa pessoa espera está na CABEÇA
   * da fila, que é onde ficam os `PLAYER_OFFLINE`.
   */
  wake(): void { /* … */ }
  /**
   * Uma rodada: o laço do §10.2, caminhando pelas páginas até
   * `next === null` ou até `DELIVERY_MAX_PAGES_PER_ROUND`.
   *
   * `400 INVALID_CURSOR` é o ÚNICO erro desta rota com tratamento
   * próprio: zera `#cursor` e refaz a página do topo, UMA vez por
   * rodada. Um segundo na mesma rodada encerra a rodada com
   * `logger.error` — duas recusas seguidas não são um cursor velho,
   * são outra coisa, e insistir é laço.
   *
   * Nunca lança.
   */
  async poll(): Promise<void> { /* … */ }
}

// ============================================================
//  A CLASSIFICAÇÃO DO DESFECHO
//
//  ####  UMA CONSTANTE E UMA FUNÇÃO, NUNCA PROSA  ####
//
//  A tabela do §5.8 é a explicação; ISTO é a verdade. Um `switch`
//  espalhado pelo laço divergiria da tabela no primeiro código novo
//  que o plugin devolvesse.
// ============================================================

/**
 * O que MELHORA SOZINHO. Tudo o que não está aqui é `failed`.
 *
 * O default é `failed` de propósito: `failed` devolve o item para
 * `available` e o jogador resgata de novo, o que é ruim mas visível.
 * Um `deferred` errado deixa a tarefa presa e invisível até o TTL.
 */
const DEFERRABLE = new Set([
  // Os do `origemz.give` (core/src/kits/service.ts:646-667).
  'PLAYER_NOT_FOUND',
  'PLAYER_DEAD',
  'PLAYER_SLEEPING',
  'INVENTORY_FULL',
  'DROP_FAILED',
  // Os do agente, antes do comando.
  'PLAYER_OFFLINE',
  'PRESENCE_UNAVAILABLE',
  'RCON_UNAVAILABLE',
  // O veículo que não cabe onde ele está: ele sai da base e volta.
  'VEHICLE_NO_SPACE',
]);

/**
 * O erro de uma entrega vira um dos ACKs do §5.8.
 *
 * ####  O CÓDIGO VEM DO `ApiError`, NÃO DA MENSAGEM  ####
 *
 * `RCON_UNAVAILABLE` é o caso que ensina isto: quando o RCON está
 * fora, `#deliver` fala com o `disconnectedRcon`, que rejeita com um
 * `ApiError` cujo `.message` é a FRASE EM PORTUGUÊS — *"O agente não
 * está conectado ao RCON do servidor X"* (core/src/ops/service.ts:68-80).
 * Quem ler `error.message`, como o `#deliver` de hoje faz, classifica
 * isso como falha desconhecida e manda `failed` DEFINITIVO: o item
 * pago volta ao inventário porque o RCON piscou.
 *
 * Por isso a ordem é: `ApiError.code` primeiro, mensagem depois.
 */
export function ackOf(error: unknown): {
  readonly status: 'failed' | 'deferred';
  readonly reason: string;
} {
  const code = error instanceof ApiError ? error.code : toError(error).message;
  // O `#deliver` prefixa o código do plugin de veículo com
  // `VEHICLE_` (core/src/store/service.ts:381). `VEHICLE_NO_SPACE`
  // está no set; o resto dos `VEHICLE_*` é falha definitiva.
  const reason = code.slice(0, 200);

  return DEFERRABLE.has(reason) ? { status: 'deferred', reason } : { status: 'failed', reason };
}

/**
 * O vocabulário da FILA (§5.7) vira o PLANO da entrega (§14.11d).
 *
 * ####  `units` É SEMPRE 1  ####
 *
 * O `#deliver` multiplica `item.amount * units` (service.ts:354) e
 * `days * units` (service.ts:401), porque numa compra in-game o
 * jogador escolhe a quantidade. Aqui não: o `amount` que veio da
 * fila JÁ É o total, e o `days` JÁ É o prazo. Passar `units` com
 * qualquer outro valor entregaria o dobro, o triplo, o que for.
 *
 * O que não é usado vai `null`, e não `undefined`: a coluna
 * `delivery` guarda JSON, e `undefined` some na serialização.
 */
export function planOfPayload(
  kind: DeliveryTask['kind'],
  payload: DeliveryPayload,
  now: number,
): DeliveryPlan { /* … */ }
```

| `kind` | `items` | `vehicle` | `vip` | `units` |
|---|---|---|---|---|
| `item` | o único item do payload | `null` | `null` | 1 |
| `kit` | os 1..40 itens, na ordem | `null` | `null` | 1 |
| `vehicle` | `[]` | `{ prefab, fuel }` | `null` | 1 |
| `vip` | `[]` | `null` | `{ tier, expiresAt: days === null ? null : now + days * 86_400_000 }` | 1 |

> **A linha `vip` desta tabela é CÓDIGO MORTO na fase 1 — e fica.** Nada no site
> cria tarefa desse `kind` (§5.7, e §11.4 do manual do site): `rust_vip` está
> fora dos quatro mapas de entrega de lá. Escreva o ramo, teste o ramo, **não o
> apague**: o caminho de execução por baixo dele é o mesmo que a compra in-game
> usa hoje, e o `kind` é reserva de contrato para a fase 2. O que não vale é
> **contar** com ele: uma tarefa `vip` vinda da fila, hoje, é defeito do site.

O `expiresAt` é calculado **aqui**, na fronteira, e não lá dentro: `days` é o
vocabulário do site e `expiresAt` é o do `VipList`. Traduzir num ponto só é a
mesma disciplina de `moedas` → `balance` (§8.1).

---

### 14.7 `core/src/store/settle.ts` — NOVO

```ts
// ============================================================
//  settle.ts  -  o relógio que fecha compra presa, com PROVA.
//
//  ####  NA DÚVIDA, PRESERVA  ####
//
//  Três desfechos e um deles é NENHUM. Site inalcançável não
//  decide nada: a compra segue presa e o minuto seguinte tenta de
//  novo. Decidir sem prova é o que produz entrega dupla.
//
//  ####  A MARGEM DE 90 s  ####
//
//  O agente aborta em 5 s (`SITE_TIMEOUT_MS`, §11.2), mas o site
//  pode continuar processando. Reconciliar dentro dessa janela veria
//  "nenhuma linha" enquanto a transação ainda está em voo — e
//  cancelaria uma compra prestes a ser cobrada.
//
//  ####  O RELÓGIO E O BOTÃO CHAMAM A MESMA FUNÇÃO  ####
//
//  `StoreService.settle`. Dois códigos que decidem a mesma coisa
//  discordam no primeiro ajuste, e o dia em que discordarem é o dia
//  em que alguém é cobrado duas vezes.
// ============================================================

export const DEFAULT_SETTLE_INTERVAL_MS = 60_000;
/** `charge-unknown` e o estorno retentável entram com 90 s. */
export const SETTLE_MIN_AGE_MS = 90_000;
/** `debited` e `pending` órfão entram com 5 min — §11.3. */
export const SETTLE_DEBITED_MIN_AGE_MS = 300_000;
export const SETTLE_ORPHAN_MIN_AGE_MS = 300_000;
/** Os dois tetos que fazem o relógio DESISTIR — §11.1. */
export const SETTLE_MAX_ATTEMPTS = 60;
export const SETTLE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
/** A reivindicação da linha expira em 5 min — §11.4. */
export const SETTLE_CLAIM_TTL_MS = 300_000;
export const SETTLE_BATCH = 50;

/**
 * O que UMA chamada de settle decidiu. Os cinco valores são os
 * mesmos do §11.6, e `review` é o "saiu do laço e espera gente".
 *
 * ####  `review` NÃO É UM `state`  ####
 *
 * O CHECK da migração 035 tem seis valores, e nenhum deles é
 * `review`: quem responde "isto precisa de gente" é
 * `state='failed'` com `error` começando em `CHARGE_UNPROVABLE`, ou
 * `state='debited'` com `error='PLAN_MISSING'`. Um sétimo estado
 * mudaria o enum público de `GET /api/store/purchases` e a tela do
 * painel por causa de algo que já cabe no `error`.
 */
export type SettleOutcome = 'delivered' | 'refunded' | 'cancelled' | 'review' | null;

export class PurchaseSettler {
  start(): void { /* … */ }
  stop(): void { /* … */ }
  /** Uma varredura. Nunca lança. */
  async sweep(now?: number): Promise<void> { /* a consulta do §11.3 */ }
}
```

---

### 14.8 `core/src/store/catalog-mirror.ts` — NOVO

```ts
// ============================================================
//  catalog-mirror.ts  -  a loja in-game vista pelo painel do site.
//
//  ####  SNAPSHOT SUBSTITUI, NUNCA MESCLA  ####
//
//  Produto que sumiu do espelho SAIU DA LOJA, não foi esquecido. Um
//  merge deixaria produto apagado à venda para sempre.
//
//  ####  `generatedAt` FICA FORA DO HASH  ####
//
//  Se entrasse, a version mudaria a cada montagem e 2 MiB
//  atravessariam a internet a cada volta do relógio, por nada.
//
//  ####  AQUI O RELÓGIO É A CONVERGÊNCIA  ####
//
//  No catálogo do Conan o push é otimização e o POLL do agente é a
//  garantia. Aqui a direção é invertida e não há poll do outro
//  lado: desligar o relógio de 60 s é aceitar catálogo velho para
//  sempre.
//
//  ####  A RECEITA DA ENTREGA NÃO VIAJA  ####
//
//  `offer.items[]`, `vip` e `vehicle` ficam. O painel precisa VER a
//  loja para vender, não precisa saber como o item nasce.
// ============================================================

export const MIRROR_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MIRROR_INTERVAL_MS = 60_000;
export const MIRROR_DEBOUNCE_MS = 2_000;

export function buildMirror(repository: StoreRepository): MirrorPayload { /* … */ }

/** sha256 do corpo canônico SEM `version` e SEM `generatedAt`. */
export function versionOf(payload: Omit<MirrorPayload, 'version' | 'generatedAt'>): string { /* … */ }

/**
 * JSON com as CHAVES de objeto ordenadas.
 *
 * Elemento de array NÃO é ordenado: ordem de array é conteúdo, e
 * reordenar aqui esconderia uma mudança de posição de oferta.
 */
export function stableStringify(value: unknown): string { /* … */ }

export class CatalogMirror {
  start(): void { /* … */ }
  stop(): void { /* … */ }
  /** Chamada pelas 6 rotas de edição do §13.4, SEM await e dentro de try/catch. */
  notifyChanged(): void { /* debounce 2 s + bit de sujo */ }
  async push(): Promise<void> { /* o laço do §13.3; nunca lança */ }

  /**
   * O que `GET /api/site/status` mostra (§9.6).
   *
   * Getter, e não quatro campos públicos: quem lê é uma rota HTTP, e
   * um objeto congelado por chamada é o que impede a tela de pegar
   * `version` de uma rodada e `mirroredVersion` da seguinte.
   */
  get status(): {
    /** A `version` do catálogo de AGORA, recalculada na hora. */
    readonly version: string;
    /** A última que o SITE confirmou. `null` = ele nunca aceitou. */
    readonly mirroredVersion: string | null;
    readonly lastPushAt: number | null;
    /** O `error_code` cru do §5.9. `null` = o último push foi bem. */
    readonly lastPushError: string | null;
  } { /* … */ }
}
```

---

### 14.9 `core/src/http/routes/site.ts` — NOVO

```ts
// ============================================================
//  routes/site.ts  -  o pareamento com o site OrigemZ.
//
//      GET  /site/status   o pareamento visto pelo agente
//      POST /site/beacon   força uma batida agora
//
//  ####  ESTA É A PRIMEIRA TELA DE "A LOJA PAROU"  ####
//
//  "o agente está pending", "o token foi rotacionado" e "o site
//  está fora do ar" produzem o mesmo sintoma para o jogador. Sem
//  separar as três, cada ocorrência custa uma tarde.
//
//  ####  O TOKEN NUNCA SAI DAQUI  ####
//
//  `/site/status` responde SE há token, nunca QUAL. Nada nesta rota
//  imprime segredo, nem parte dele.
// ============================================================

export interface SiteRoutesDeps {
  /**
   * `null` com `SITE_BASE_URL` vazia — o §14.15 não constrói beacon
   * nenhum nesse caso, e a rota PRECISA continuar respondendo. Quem
   * a abre está tentando descobrir por que a integração não subiu.
   */
  readonly beacon: SiteBeacon | null;
  readonly deliveries: SiteDeliveries | null;
  readonly siteDeliveriesRepository: SiteDeliveriesRepository | null;
  readonly catalog: CatalogMirror | null;
  readonly wallet: Wallet;
  /** A saúde da carteira do site. `null` com a carteira local. */
  readonly walletHealth: (() => { lastOkAt: number | null; lastError: string | null }) | null;
  readonly purchases: StoreRepository;
  readonly baseUrl: string;
  readonly serverId: string;
  readonly localServerId: string;
  /** SE há token, nunca QUAL. Ver §17.4. */
  readonly hasToken: boolean;
}

export function registerSiteRoutes(app: FastifyInstance, deps: SiteRoutesDeps): void {
  app.get('/site/status', async () => ({ ok: true, /* o corpo do §9.6 */ }));

  app.post('/site/beacon', async () => {
    const pairing = await deps.beacon.beat();

    return { ok: true, status: pairing.status, message: pairing.message };
  });
}
```

**Com `SITE_BASE_URL` vazia, as duas rotas continuam registradas** e respondem
`{ ok: true, paired: false, status: 'unknown', ... }`. Não registrá-las faria
`GET /api/site/status` responder 404 justamente para quem está tentando
descobrir por que a integração não subiu.

---

### 14.10 `core/src/store/wallet.ts` — ALTERADO

| O que | Como |
|---|---|
| cabeçalho | "duas fontes" → **três implementações**; acrescentar o bloco `####  CINCO DESFECHOS  ####` |
| `WalletBalance.balance` | `number` → `number \| null` |
| `WalletChange` | a união do §4.1 |
| `WalletMoveInput` | interface nova |
| `Wallet.debit` / `.credit` | passam a receber o objeto |
| `LocalWallet` | assinatura nova + `message` no `insufficient` (§8.4) |
| `ChargeProver` e `ChargeProofResult` | **novos, e moram AQUI** — ver abaixo |
| banner `A CARTEIRA REMOTA`, `RemoteWalletOptions`, `DEFAULT_TIMEOUT_MS`, `RemoteWallet` | **apagados** (`:144-311`); o arquivo passa a terminar em `:142` |
| import de `toError` (`:42`) | some junto — os dois usos dele (`:238`, `:285`) estão dentro da `RemoteWallet` |

**Por que a prova mora em `wallet.ts`, e não em `site-wallet.ts`:**

```ts
+ /** A prova de que uma referência já cobrou. Ver Docs\20 §11. */
+ export type ChargeProofResult =
+   /** A transação existe: o dinheiro SAIU. */
+   | {
+       readonly status: 'charged';
+       readonly amount: number;
+       readonly transactionId: string | null;
+       readonly productId: string | null;
+     }
+   /** 404 `REFERENCE_NOT_FOUND`: NADA foi cobrado. É prova. */
+   | { readonly status: 'not-charged' }
+   /** A pergunta é inválida PARA SEMPRE. Sai do laço. Ver §11.4. */
+   | { readonly status: 'unprovable'; readonly reason: string }
+   /** Não deu para perguntar. NÃO decide nada — "na dúvida, preserva". */
+   | { readonly status: 'unknown'; readonly reason: string };
+
+ /**
+  * Quem sabe provar se uma cobrança aconteceu.
+  *
+  * ####  ELA MORA NA MESMA FRONTEIRA QUE `Wallet`  ####
+  *
+  * `StoreService` precisa DESTE TIPO para declarar a dep `proof`
+  * (§14.11b). Se ele morasse em `site-wallet.ts`, `service.ts`
+  * teria de importar o arquivo do site — e o §8.1 deixaria de ser
+  * verdade: a loja passaria a saber que existe um site. Interface
+  * própria, e não um método a mais em `Wallet`, porque a
+  * `LocalWallet` não tem o que provar: ela É o ledger.
+  */
+ export interface ChargeProver {
+   proveCharge(input: {
+     readonly reference: string;
+     readonly steamId: string;
+   }): Promise<ChargeProofResult>;
+ }
```

---

### 14.11 `core/src/store/service.ts` — ALTERADO

**(a) `PurchaseOutcome` ganha três ramos:**

```ts
  | { readonly status: 'insufficient'; readonly balance: number; readonly price: number;
+     readonly message: string }
+ /** Passou do teto do agente. NADA foi cobrado, e nem foi tentado. */
+ | { readonly status: 'over-limit'; readonly price: number; readonly limit: number }
+ /** O site recusou o PEDIDO. Defeito nosso — nunca repetir igual. */
+ | { readonly status: 'charge-rejected'; readonly purchase: StorePurchase;
+     readonly code: string; readonly reason: string; readonly charged: number | null }
+ /** PODE TER COBRADO. Não entregou, não estornou, NÃO fechou. */
+ | { readonly status: 'charge-unknown'; readonly purchase: StorePurchase; readonly reason: string }
```

**(b) `StoreServiceDeps` ganha três campos:**

```ts
+ /**
+  * A referência que vai ao site. Ausente = o `purchaseId` cru, que
+  * é o que a carteira LOCAL sempre usou.
+  *
+  * Injetada, e não montada aqui, porque quem conhece o `serverId`
+  * DO SITE é a configuração — este arquivo não deve aprender que
+  * existe um site.
+  */
+ readonly newReference?: (purchaseId: string) => string;
+ /** Teto de OZ por compra. Ausente = sem teto. Ver §17.1. */
+ readonly maxOzPerPurchase?: number;
+ /**
+  * Quem sabe provar uma cobrança. Ausente = sem reconciliação.
+  *
+  * O tipo vem de `./wallet.js`, e não de `./site-wallet.js` — ver
+  * §14.10. Este arquivo continua sem saber que existe um site.
+  */
+ readonly proof?: ChargeProver | undefined;
+ /**
+  * A loja está pronta para cobrar? Ausente = sempre pronta.
+  *
+  * ####  O PONTO DE IMPLEMENTAÇÃO DO "INDISPONÍVEL"  ####
+  *
+  * O §9.5 e o §21.4 dizem três vezes que, enquanto o pareamento
+  * não é `active`, a loja responde INDISPONÍVEL — nunca "saldo 0"
+  * e nunca "saldo insuficiente". Esta é a linha onde isso vira
+  * código. Sem ela, a lei existia em prosa e em critério de aceite,
+  * e em nenhum arquivo.
+  *
+  * Uma função, e não um booleano: o pareamento muda a cada 10 s, e
+  * um valor lido na construção seria o de quando o agente subiu.
+  * `index.ts` passa `() => siteBeacon?.ready ?? true` — sem site,
+  * `undefined`, e a loja local funciona como sempre.
+  */
+ readonly ready?: (() => boolean) | undefined;
```

**(c) `buy` — o teto, a referência e os dois desfechos novos:**

```ts
+   // ####  A LOJA SÓ COBRA QUANDO ESTÁ PRONTA  ####
+   //
+   // PRIMEIRA checagem do método, antes até do `getOffer`: enquanto
+   // o pareamento não é `active`, todo débito tomaria 401/403 e
+   // viraria `unavailable`. Dizer INDISPONÍVEL na entrada é honesto;
+   // deixar passar e mostrar a frase da carteira faz o jogador ler
+   // "saldo" onde o problema é pareamento. Ver §9.5.
+   if (this.#deps.ready !== undefined && !this.#deps.ready()) {
+     return { status: 'store-unavailable' };
+   }
+
    const units = Math.max(1, Math.trunc(input.quantity));
    const total = offer.price * units;
+
+   // ####  UMA COMPRA EM VOO POR JOGADOR  ####
+   //
+   // O `referenceId` protege ESTA TENTATIVA de sair duas vezes; ele
+   // NÃO protege o jogador de comprar duas vezes, porque cada
+   // tentativa gera um `purchaseId` novo (:163-165) e, portanto,
+   // uma chave nova. A única barreira que existia era o
+   // `PendingBuyId` do plugin — e o `FailBuy` dele o zera no
+   // timeout de 8 s (Plugins/OrigemZUI.cs:2075), liberando o botão
+   // com a primeira compra ainda em voo. Ver §17.6, regra 6.
+   const open = this.#deps.repository.findOpenPurchase(
+     input.serverId, input.steamId, this.#now() - IN_FLIGHT_WINDOW_MS,
+   );
+
+   if (open !== null) {
+     return { status: 'already-in-flight', purchase: open };
+   }
+
+   // ####  O TETO É DO AGENTE, PORQUE O SITE NÃO TEM  ####
+   //
+   // Ele só recusa o que passa do saldo. Um preço editado errado, ou
+   // um `quantity` que veio por rota, debita o que o jogador tiver.
+   if (this.#maxOz > 0 && total > this.#maxOz) {
+     return { status: 'over-limit', price: total, limit: this.#maxOz };
+   }
+
    const purchaseId = this.#newId();
+   const reference = this.#newReference(purchaseId);
+   const plan = planOf(offer, units);
+
+   // O site valida `productId` com teto de 100 chars e devolve 400
+   // `INVALID_PRODUCT_ID` acima disso (§5.4) — um `rejected`, que
+   // FECHA a compra. O `offer.id` do agente não tem teto declarado
+   // em lugar nenhum, então o limite seria descoberto em produção,
+   // por um admin que só cadastrou uma oferta com id comprido.
+   const productId = offer.id.length <= 100 ? offer.id : undefined;

    const purchase = this.#deps.repository.createPurchase({
      id: purchaseId,
      /* … os campos de hoje … */
+     reference,
+     siteTransactionId: null,
+     // O que ia ser entregue, congelado. Ver (d).
+     delivery: JSON.stringify(plan),
    }, this.#now());

-   const debit = await this.#deps.wallet.debit(
-     input.steamId, total, purchaseId, `store:${offer.name} x${String(units)}`,
-   );
+   const debit = await this.#deps.wallet.debit({
+     steamId: input.steamId,
+     amount: total,
+     reference,
+     // Português, e voltado ao JOGADOR: é isto que ele lê no extrato
+     // do site. `store:` era log, não texto de gente.
+     reason: `Loja in-game: ${offer.name} x${String(units)}`,
+     ...(productId === undefined ? {} : { productId }),
+   });

    if (debit.status === 'insufficient') {
      this.#finish(input.serverId, purchaseId, 'failed', 'INSUFFICIENT_FUNDS');
-     return { status: 'insufficient', balance: debit.balance, price: total };
+     // `debit.balance` é `number | null`: `null` quando o site é
+     // anterior ao ajuste 4 do §5.4. NUNCA zero — ver D13.
+     return { status: 'insufficient', balance: debit.balance, price: total,
+              message: debit.message };
    }

+   if (debit.status === 'rejected') {
+     // NUNCA gerar id novo, NUNCA repetir. `charged` preenchido
+     // significa que o dinheiro saiu numa cobrança anterior com esta
+     // mesma chave — isso é conferência humana, não retry.
+     this.#finish(input.serverId, purchaseId, 'failed',
+       `CHARGE_REJECTED: ${debit.code}${debit.charged === null ? '' : ` charged=${String(debit.charged)}`}`);
+     this.#deps.logger.error(
+       { purchaseId, reference, steamId: input.steamId, code: debit.code, charged: debit.charged },
+       'site refused the charge',
+     );
+     return { status: 'charge-rejected', purchase: this.#reread(input.serverId, purchaseId, purchase),
+              code: debit.code, reason: debit.reason, charged: debit.charged };
+   }

+   if (debit.status === 'unknown') {
+     // ####  O ÚNICO DESFECHO QUE NÃO FECHA A COMPRA  ####
+     //
+     // Nada é entregue e nada é estornado: não sabemos se cobrou.
+     // Quem decide é o relógio do settle, com PROVA.
+     this.#finish(input.serverId, purchaseId, 'charge-unknown', 'CHARGE_UNKNOWN');
+     this.#deps.logger.warn(
+       { purchaseId, reference, steamId: input.steamId, total, reason: debit.reason },
+       'charge outcome is unknown; purchase left open for reconciliation',
+     );
+     return { status: 'charge-unknown', purchase: this.#reread(input.serverId, purchaseId, purchase),
+              reason: debit.reason };
+   }

    if (debit.status === 'unavailable') {
      this.#finish(input.serverId, purchaseId, 'failed', 'WALLET_UNAVAILABLE');
      return { status: 'wallet-unavailable', reason: debit.reason };
    }

-   this.#finish(input.serverId, purchaseId, 'debited');
+   this.#finish(input.serverId, purchaseId, 'debited', null, debit.transactionId);
```

**Duas peças que esse diff usa e que não existem hoje:**

```ts
+ /** Quanto tempo uma compra aberta bloqueia a próxima do mesmo jogador. */
+ const IN_FLIGHT_WINDOW_MS = 5 * 60 * 1_000;
+
+ /**
+  * Relê a compra depois de mexer no estado, com fallback.
+  *
+  * O padrão já existe inline em três lugares (`:329`, `:433`,
+  * `:455`); os desfechos novos seriam o quarto e o quinto. Uma
+  * função com nome, e os três de hoje passam a chamá-la.
+  */
+ #reread(serverId: string, id: string, fallback: StorePurchase): StorePurchase {
+   return this.#deps.repository.getPurchase(serverId, id) ?? fallback;
+ }
```

E **`#finish` ganha um quinto parâmetro** (`core/src/store/service.ts:461` tem
quatro hoje):

```ts
- #finish(serverId: string, id: string, state: PurchaseState, error: string | null = null): void
+ #finish(
+   serverId: string,
+   id: string,
+   state: PurchaseState,
+   error: string | null = null,
+   /** Só na transição para `debited`. Ver a nota do §14.12. */
+   siteTransactionId: string | null = null,
+ ): void
```

O `PurchaseOutcome` ganha, além dos três ramos do item (a), mais dois:

```ts
+ /** O pareamento não está `active`: a loja NÃO cobra. Ver §9.5. */
+ | { readonly status: 'store-unavailable' }
+ /** Já há compra aberta deste jogador. NADA foi cobrado. Ver §17.6. */
+ | { readonly status: 'already-in-flight'; readonly purchase: StorePurchase }
```

**(d) `#deliver` passa a receber um PLANO, e não a oferta:**

```ts
- async #deliver(input: BuyInput, offer: StoreOffer, units: number): Promise<void>
+ async #deliver(serverId: string, steamId: string, plan: DeliveryPlan): Promise<void>
```

```ts
/**
 * O que uma compra promete entregar, congelado no momento da compra.
 *
 * ####  POR QUE ELE É GRAVADO, E NÃO RELIDO DA OFERTA  ####
 *
 * A reconciliação (§11) pode entregar minutos ou horas depois. Se
 * ela relesse `store_offers`, uma oferta editada no meio entregaria
 * OUTRA COISA, cobrada com o preço de ontem — e uma oferta apagada
 * não entregaria nada. O plano gravado é o que a compra prometeu, e
 * é ele que vale.
 */
export interface DeliveryPlan {
  readonly items: readonly OfferItem[];
  readonly vehicle: OfferVehicle | null;
  readonly vip: OfferVip | null;
  readonly units: number;
}

export function planOf(offer: StoreOffer, units: number): DeliveryPlan { /* … */ }
```

**(d.1) `deliverPlan` — o método público, e é ele que a fila do site chama:**

```ts
/**
 * Entrega um plano. É o MESMO caminho da compra in-game.
 *
 * ####  UM LUGAR SÓ MANDA `origemz.give`  ####
 *
 * A fila do §10 e a compra do §14.11(c) precisam do mesmo comando,
 * do mesmo `auto`, do mesmo tratamento de veículo e do mesmo
 * `vips.grant`. Dois caminhos divergiriam no primeiro ajuste — e o
 * ajuste que só um dos dois recebesse apareceria como "às vezes o
 * item vem sem skin".
 *
 * LANÇA com o código CRU do plugin (ou o `ApiError` do RCON): quem
 * chama traduz para ACK com `ackOf` (§14.6). Ela não devolve
 * desfecho porque a compra e a fila fecham de jeitos diferentes.
 */
async deliverPlan(serverId: string, steamId: string, plan: DeliveryPlan): Promise<void>
```

E `#deliver` passa a ser um **wrapper** dela — não uma segunda cópia:

```ts
- async #deliver(serverId: string, steamId: string, plan: DeliveryPlan): Promise<void>
+ async #deliver(serverId: string, steamId: string, plan: DeliveryPlan): Promise<void> {
+   return this.deliverPlan(serverId, steamId, plan);
+ }
```

A conversão do vocabulário da fila (§5.7) para `DeliveryPlan` **não mora aqui**:
ela é `planOfPayload` (§14.6), na fronteira do site, junto de `ackOf`. Este
arquivo não aprende que existe um site.

**(e) `#refund` — o objeto e o `reason` em português:**

```ts
-   const refund = await this.#deps.wallet.credit(
-     purchase.steamId, purchase.totalPrice, purchase.id, `refund:${purchase.id}`,
-   );
+   const refund = await this.#deps.wallet.credit({
+     steamId: purchase.steamId,
+     amount: purchase.totalPrice,
+     // A referência da COMPRA. O sufixo `:refund` é derivado dentro
+     // da carteira — ver §12.2 para o que a mesma chave causaria.
+     reference: purchase.reference ?? purchase.id,
+     reason: `Estorno: entrega falhou (${cause.message})`,
+   });
```

E o `logger.error('compra PRESA…')` de `:448-451` ganha `reference` no objeto —
sem ela, ninguém acha a linha no ledger do site.

**(f) `settle` — o método novo, e ele é público:**

```ts
/**
 * Fecha uma compra presa, com prova.
 *
 * É a MESMA função que o relógio e o botão chamam. Ver §11.
 */
async settle(input: { readonly serverId: string; readonly purchaseId: string }): Promise<SettleOutcome>
```

**(g) `describePurchase` — cinco frases novas:**

```ts
    case 'insufficient':
-     return `Saldo insuficiente: são ${…} OZ e você tem ${…}.`;
+     // A frase vem do DONO DO SALDO, crua. O agente só acrescenta o
+     // caminho — inventar texto quando o site já mandou o certo
+     // daria ao suporte duas versões da mesma história.
+     return `${outcome.message}\nCompre OzCoins no site OrigemZ.`;

+   case 'over-limit':
+     return (
+       `Esta compra passa do limite de ${outcome.limit.toLocaleString('pt-BR')} OZ por vez. ` +
+       'Compre em partes, ou fale com a administração.'
+     );
+
+   case 'charge-rejected':
+     // Sem detalhe técnico: o jogador não resolve um 409, e o código
+     // inteiro já está no log e na tela de compras presas.
+     return 'A loja está com um problema. Avise a administração.';
+
+   case 'charge-unknown':
+     // NÃO convida a tentar de novo: tentar aqui é arriscar pagar
+     // duas vezes. Manda CONFERIR — é a mesma escolha que o plugin
+     // faz no timeout dele.
+     return 'A cobrança pode ter acontecido. Confira seu saldo e seu inventário em instantes.';
+
+   case 'store-unavailable':
+     // ####  A PALAVRA "SALDO" NÃO PODE APARECER AQUI  ####
+     //
+     // É o critério de aceite do §21.4, e é a razão do desfecho
+     // existir: pareamento quebrado e bolso vazio produzem o mesmo
+     // botão morto, e o jogador que lê "saldo" acha que perdeu
+     // dinheiro.
+     return 'A loja está indisponível agora. Tente de novo em instantes.';
+
+   case 'already-in-flight':
+     return 'Você tem uma compra em andamento. Aguarde ou confira seu inventário.';
```

E o mapa do §14.16(c) ganha as duas: `store-unavailable` → `STORE_UNAVAILABLE`
/ **503**, `already-in-flight` → `PURCHASE_IN_FLIGHT` / **409**.

---

### 14.12 `core/src/db/store-repository.ts` — ALTERADO

```ts
- export type PurchaseState = 'pending' | 'debited' | 'delivered' | 'refunded' | 'failed';
+ /** Ver o CHECK da migração 035 para o que cada estado significa. */
+ export type PurchaseState =
+   | 'pending'
+   | 'debited'
+   | 'delivered'
+   | 'refunded'
+   | 'failed'
+   /** PODE TER COBRADO. O único que não é terminal. Ver Docs\20 §4. */
+   | 'charge-unknown';

  export interface StorePurchase {
    /* … */
+   /** O `referenceId` mandado ao site. `null` = compra anterior à 035. */
+   readonly reference: string | null;
+   /** O id da linha no ledger do site. TEXTO: o BIGINT dele passa de 2^53. */
+   readonly siteTransactionId: string | null;
+   /** O que ia ser entregue, em JSON. Ver §14.11(d). */
+   readonly delivery: string | null;
  }
```

- `createPurchase` grava as **cinco** colunas novas (`reference`,
  `site_transaction_id`, `delivery`, `settle_attempts`, `settling_at`).
- `toPurchase` mapeia as cinco.
- **`setPurchaseState` ganha um sexto parâmetro opcional `siteTransactionId`** —
  e ele **só escreve quando é passado**:

```ts
  setPurchaseState(
    serverId: string,
    id: string,
    state: PurchaseState,
    error: string | null = null,
    now = Date.now(),
+   siteTransactionId: string | null = null,
  ): void {
    this.#db
      .prepare(
        `UPDATE store_purchases
            SET state = @state,
                error = @error,
                updated_at = @now,
-               ...
+               -- ####  COALESCE, E NÃO ATRIBUIÇÃO DIRETA  ####
+               --
+               -- A transição `debited` grava o id; a SEGUINTE
+               -- (`delivered`) não o tem, e um `= @siteTransactionId`
+               -- cru APAGARIA a prova que acabou de ser gravada —
+               -- justamente a chave que liga esta compra ao ledger
+               -- do site, e a única coisa que responde "eu paguei e
+               -- não recebi" meses depois.
+               site_transaction_id = COALESCE(@siteTransactionId, site_transaction_id)
          WHERE server_id = @serverId AND id = @id`,
      )
-     .run({ serverId, id, state, error, now });
+     .run({ serverId, id, state, error, now, siteTransactionId });
  }
```
- **`stats()` muda numa linha e é importante:**

```ts
-     stuck: one(`SELECT count(*) AS value FROM store_purchases WHERE state = 'failed'`),
+     // `charge-unknown` conta como presa: é dinheiro que pode ter
+     // saído sem item. E ela some sozinha quando o settle a resolve —
+     // ao contrário de `failed`, que fica.
+     stuck: one(
+       `SELECT count(*) AS value FROM store_purchases
+         WHERE state IN ('failed', 'charge-unknown')`,
+     ),
```

- **quatro métodos novos:**

```ts
+ /**
+  * A varredura do §11.3.
+  *
+  * TRÊS cutoffs, e não um: a tabela do §11.3 prescreve 90 s para
+  * `charge-unknown` e 5 min para `debited` e para o `pending`
+  * órfão. Com um cutoff só, um `debited` de 91 s entraria — e o
+  * settler mandaria para conferência humana uma compra que ainda
+  * está sendo entregue.
+  */
+ listStuck(input: {
+   readonly unknownCutoff: number;
+   readonly debitedCutoff: number;
+   readonly orphanCutoff: number;
+   readonly limit: number;
+ }): readonly StorePurchase[];
+
+ /** A trava do §17.6, regra 6: há compra aberta deste jogador? */
+ findOpenPurchase(serverId: string, steamId: string, since: number): StorePurchase | null;
+
+ /** Para `GET /api/site/status` (§9.6). */
+ countPurchasesByState(state: PurchaseState, olderThan?: number): number;
+
+ /** A reivindicação do §11.4: compare-and-set em `settling_at`. */
+ claimForSettle(serverId: string, id: string, expected: PurchaseState, now: number): boolean;
```

`findOpenPurchase` procura `state IN ('pending','debited','charge-unknown')` do
mesmo `(server_id, steam_id)` com `created_at >= @since`, e usa o índice
`idx_store_purchases_stuck` da 035.

---

### 14.13 `core/src/db/migrations.ts` — ALTERADO

**As migrações 035 e 036 e as duas linhas do array estão no §15**, por extenso e
com o cabeçalho doutrinário de cada uma. A numeração existe aqui para que o mapa
do §14.0 tenha um destino para cada linha — e para lembrar a regra de arquivo
compartilhado: `migrations.ts` se toca **por anexação, no fim do array**, e o
número reservado é 035/036, não 033/034 (§15.0).

---

### 14.14 `core/src/config.ts` — ALTERADO

```ts
  readonly store: {
    /** Base da API do site, sem barra no fim. Vazio = local. */
    readonly walletUrl: string;
    readonly walletToken: string;
+   /** Teto de OZ por compra, aplicado ANTES de chamar o site. */
+   readonly maxOzPerPurchase: number;
  };
+ /**
+  * A integração com o site OrigemZ.
+  *
+  * ####  `baseUrl` VAZIA DESLIGA TUDO  ####
+  *
+  * Sem ela: carteira LOCAL, sem beacon, sem fila de entregas, sem
+  * espelho de catálogo. É o interruptor único da virada, e o botão
+  * de rollback — ver Docs\20 §20.
+  */
+ readonly site: {
+   /** A ORIGEM do site, sem caminho e sem barra no fim. */
+   readonly baseUrl: string;
+   /** Vazio com `baseUrl` preenchida = modo pending: beacona e não cobra. */
+   readonly token: string;
+   /** Casa por string EXATA no site, maiúsculas incluídas. */
+   readonly serverId: string;
+   /** O servidor LOCAL que recebe as entregas puxadas. */
+   readonly localServerId: string;
+   readonly timeoutMs: number;
+   readonly beaconIntervalMs: number;
+   readonly deliveryPollMs: number;
+   readonly settleIntervalMs: number;
+   readonly catalogPushEnabled: boolean;
+   readonly userAgent: string;
+   /** Fecha `charge-unknown` repetindo o débito. Ver §11.5. */
+   readonly settleFallbackRedebit: boolean;
+ };
```

**Três peças que o bloco abaixo usa e que NÃO existem em `config.ts` hoje.**
Sem elas o arquivo não compila, e nenhuma delas está no mapa do §14.0 por
descuido — elas estão aqui:

```ts
+ /**
+  * Prende um número entre dois limites.
+  *
+  * Vai junto de `intFromEnv` (`core/src/config.ts:144`), por
+  * anexação. `grep -rn "clamp" core/src/config.ts core/src/util.ts`
+  * devolve zero hoje: não existe função com esse nome no agente.
+  */
+ function clamp(value: number, min: number, max: number): number {
+   return Math.min(max, Math.max(min, value));
+ }
```

```ts
+ // core/src/version.ts — NOVO, e são duas linhas.
+ //
+ // A versão do agente é `const VERSION = '1.0.0'` declarada DENTRO
+ // de core/src/index.ts:112, sem export — `config.ts` não a
+ // alcança. Um literal repetido aqui seria a segunda verdade sobre
+ // a versão, e ela apareceria no `User-Agent` de toda chamada ao
+ // site enquanto o `index.ts` já tivesse subido para a seguinte.
+ export const VERSION = '1.0.0';
```

`index.ts:112` passa a importar dessa constante em vez de declarar a própria.

```ts
+ /**
+  * `STORE_MAX_OZ_PER_PURCHASE` precisa de leitura PRÓPRIA.
+  *
+  * `intFromEnv` recusa `0` ("precisa ser um inteiro positivo",
+  * `config.ts:144-156`), e `0` é documentado como SEM TETO (§16.1).
+  * Passar por ele derrubaria o boot de quem escreveu a linha que o
+  * próprio `.env.example` sugere.
+  */
+ function limitFromEnv(raw: string | undefined, fallback: number): number {
+   if (raw === undefined || raw.trim() === '') {
+     return fallback;
+   }
+
+   const value = Number(raw);
+
+   if (!Number.isInteger(value) || value < 0) {
+     throw new Error(`STORE_MAX_OZ_PER_PURCHASE precisa ser 0 ou um inteiro positivo (recebi "${raw}")`);
+   }
+
+   return value;
+ }
```

E, dentro de `loadConfig`, no mesmo estilo de `config.ts:699-705`:

```ts
+     site: (() => {
+       // A barra final sai AQUI, e não em quem monta a URL — a mesma
+       // razão do bloco `store` logo acima.
+       const legacy = (merged.STORE_WALLET_URL ?? '').trim().replace(/\/+$/, '');
+       const baseUrl = ((merged.SITE_BASE_URL ?? '').trim() || legacy).replace(/\/+$/, '');
+
+       if (baseUrl !== '' && /\/api$/i.test(baseUrl)) {
+         throw new Error(
+           'SITE_BASE_URL é a ORIGEM do site (https://exemplo.com), sem o /api no fim — ' +
+             'o agente acrescenta /api/agent/... sozinho.',
+         );
+       }
+
+       const serverId = (merged.SITE_SERVER_ID ?? '').trim();
+
+       if (baseUrl !== '' && serverId === '') {
+         // Um agente no ar sem saber quem é produziria 400
+         // MISSING_SERVER_ID em toda compra, e o sintoma seria
+         // "a loja parou" — não "faltou configurar".
+         throw new Error('SITE_SERVER_ID é obrigatório quando SITE_BASE_URL está preenchida');
+       }
+
+       if (serverId.length > 50) {
+         throw new Error('SITE_SERVER_ID passa de 50 chars, que é o limite do site');
+       }
+
+       return {
+         baseUrl,
+         token: ((merged.SITE_TOKEN ?? '').trim() || (merged.STORE_WALLET_TOKEN ?? '').trim()),
+         serverId,
+         localServerId: (merged.SITE_LOCAL_SERVER_ID ?? '').trim(),
+         timeoutMs: intFromEnv(merged.SITE_TIMEOUT_MS, 5_000, 'SITE_TIMEOUT_MS'),
+         beaconIntervalMs: clamp(
+           intFromEnv(merged.SITE_BEACON_INTERVAL_MS, 10_000, 'SITE_BEACON_INTERVAL_MS'),
+           5_000, 300_000,
+         ),
+         deliveryPollMs: Math.max(
+           5_000, intFromEnv(merged.SITE_DELIVERY_POLL_MS, 15_000, 'SITE_DELIVERY_POLL_MS'),
+         ),
+         settleIntervalMs: intFromEnv(merged.SITE_SETTLE_INTERVAL_MS, 60_000, 'SITE_SETTLE_INTERVAL_MS'),
+         catalogPushEnabled: boolFromEnv(merged.SITE_CATALOG_PUSH_ENABLED, true),
+         userAgent: (merged.SITE_USER_AGENT ?? '').trim() || `OrigemZ-Rust-Agent/${VERSION}`,
+         settleFallbackRedebit: boolFromEnv(merged.SITE_SETTLE_FALLBACK_REDEBIT, false),
+       };
+     })(),
```

E no bloco `store`, que hoje declara `maxOzPerPurchase` no tipo e não o lê:

```ts
      store: {
        walletUrl: /* … */,
        walletToken: /* … */,
+       maxOzPerPurchase: limitFromEnv(merged.STORE_MAX_OZ_PER_PURCHASE, 100_000),
      },
```

####  `localServerId`: A RESOLUÇÃO E O LUGAR DELA  ####

Vazio é o normal quando só existe um servidor em `Configs\`. Com dois ou mais e a
variável vazia, o boot **recusa** — porque entregar no servidor errado é entregar
no lugar errado, e adivinhar aqui seria escolher por conta própria onde o item de
alguém aparece.

**A checagem NÃO cabe em `assertSafeExposure`.** Ela recebe só o `AgentConfig`
(`core/src/config.ts:731`) e é chamada em `:714`, **antes** de
`loadServers(paths)` em `:716`. Naquele ponto a lista de servidores ainda não foi
lida — quem seguisse o texto anterior escreveria uma checagem sem como saber
quantos servidores existem.

Ela é uma função **nova**, `assertSiteBinding(agent, servers)`, chamada em
`loadConfig` **depois** de `loadServers` e antes do `return` de `:718`:

```ts
  assertSafeExposure(agent);

  const { servers, rejected } = loadServers(paths);

+ // A ordem importa: esta checagem precisa da LISTA de servidores,
+ // e ela só existe a partir daqui.
+ const siteLocalServerId = assertSiteBinding(agent, servers);

- return { agent, servers, rejected };
+ return { agent, servers, rejected, siteLocalServerId };
}

/**
 * Onde as entregas puxadas do site aterrissam.
 *
 * Devolve o id RESOLVIDO — e é por isso que ela devolve algo em vez
 * de só lançar: `agent.site.localServerId` é `readonly`, e a regra
 * "vazio = o único que existir" produz um valor que alguém precisa
 * guardar. Ele entra em `LoadedConfig` (`config.ts:369-374`), ao
 * lado de `servers`, porque é dali que ele foi derivado.
 */
function assertSiteBinding(
  agent: AgentConfig,
  servers: readonly ServerConfig[],
): string {
  // Sem integração, não há o que amarrar.
  if (agent.site.baseUrl === '') {
    return '';
  }

  const declared = agent.site.localServerId;

  if (declared !== '') {
    if (!servers.some((server) => server.id === declared)) {
      throw new ConfigError(
        `SITE_LOCAL_SERVER_ID="${declared}" não existe em Configs\. ` +
          `Servidores disponíveis: ${servers.map((s) => s.id).join(', ') || '(nenhum)'}.`,
      );
    }

    return declared;
  }

  if (servers.length === 1) {
    // O caso normal: um servidor só, e ele é o destino óbvio.
    return servers[0].id;
  }

  throw new ConfigError(
    `SITE_LOCAL_SERVER_ID é obrigatório com ${String(servers.length)} servidores em Configs\ — ` +
      `entregar no servidor errado é entregar no lugar errado. ` +
      `Escolha um: ${servers.map((s) => s.id).join(', ')}.`,
  );
}
```

A mensagem lista os ids **de propósito**: uma `ConfigError` que diz "é
obrigatório" e nada mais manda o admin abrir `Configs\` para descobrir o que
digitar.

---

### 14.15 `core/src/index.ts` — ALTERADO

O bloco da carteira (`:474-498`) vira:

```ts
  const storeRepository = new StoreRepository(db);
  const walletsRepository = new WalletsRepository(db);
+ const siteDeliveriesRepository = new SiteDeliveriesRepository(db);

+ // ####  A INTEGRAÇÃO COM O SITE É UM INTERRUPTOR SÓ  ####
+ //
+ // `SITE_BASE_URL` vazia: nada disto nasce, e o agente é o mesmo de
+ // antes. Preenchida: o site é o dono do saldo, e os quatro relógios
+ // abaixo passam a existir.
+ const siteClient =
+   agent.site.baseUrl === ''
+     ? null
+     : new SiteClient({
+         baseUrl: agent.site.baseUrl,
+         token: agent.site.token,
+         serverId: agent.site.serverId,
+         userAgent: agent.site.userAgent,
+         timeoutMs: agent.site.timeoutMs,
+         logger,
+       });

- const wallet: Wallet =
-   agent.store.walletUrl === ''
-     ? new LocalWallet(walletsRepository)
-     : new RemoteWallet({ … });
+ // ####  O BEACON NASCE ANTES DA CARTEIRA  ####
+ //
+ // A carteira precisa avisá-lo quando um débito volta com
+ // `cause: 'pairing'` (§9.5), e a ordem inversa deixaria o
+ // `onPairingSuspect` sem ninguém para chamar.
+ const siteBeacon =
+   siteClient === null
+     ? null
+     : new SiteBeacon({
+         client: siteClient, token: agent.site.token, port: agent.port,
+         version: VERSION, mac: primaryMac(), logger,
+         intervalMs: agent.site.beaconIntervalMs,
+       });
+
+ // ####  SEM TOKEN, O CLIENTE EXISTE E A CARTEIRA NÃO  ####
+ //
+ // É o Degrau 1 do §20.3, e ele PRECISA desta condição: com
+ // `SITE_BASE_URL` preenchida e `SITE_TOKEN` vazio, o `SiteClient`
+ // existe (o beacon precisa dele, e é a única rota sem bearer), mas
+ // a CARTEIRA continua local. Sem a segunda metade da condição,
+ // todo débito sairia sem `Authorization`, tomaria 401
+ // `MISSING_BEARER` e a loja in-game ficaria morta para todos os
+ // jogadores durante um passo que o documento vende como inócuo.
+ //
+ // `siteClient.authenticated` foi escrito exatamente para esta
+ // pergunta — este é o lugar que o lê.
+ const siteWallet =
+   siteClient === null || !siteClient.authenticated
+     ? null
+     : new SiteWallet({
+         client: siteClient,
+         logger,
+         onPairingSuspect: (reason) => siteBeacon?.suspect(reason),
+       });
+ const wallet: Wallet = siteWallet ?? new LocalWallet(walletsRepository);
+
+ if (siteClient !== null && siteWallet === null) {
+   logger.warn(
+     { site: agent.site.baseUrl },
+     'SITE_BASE_URL is set and SITE_TOKEN is empty: beaconing only, wallet stays LOCAL',
+   );
+ }

  logger.info(
-   { source: wallet.source, url: … },
+   { source: wallet.source, site: agent.site.baseUrl === '' ? null : agent.site.baseUrl,
+     serverId: agent.site.serverId === '' ? null : agent.site.serverId },
    wallet.source === 'local'
      ? 'a carteira é a LOCAL (o banco do agente)'
      : 'a carteira é a REMOTA (o site externo é o dono do saldo)',
  );

  const store = new StoreService({
    repository: storeRepository,
    wallet,
    servers: supervisor,
    vips,
    logger,
    history: directory,
+   maxOzPerPurchase: agent.store.maxOzPerPurchase,
+   // Sem site, `undefined` — e a loja local funciona como sempre.
+   ...(siteBeacon === null ? {} : { ready: () => siteBeacon.ready }),
+   // Sem site, a referência é o `purchaseId` cru — que é o que a
+   // carteira LOCAL sempre gravou em `wallet_entries.reference`.
+   newReference:
+     siteClient === null
+       ? (id) => id
+       : (id) => buildReference(agent.site.serverId, 'loja', id),
+   ...(siteWallet === null ? {} : { proof: siteWallet }),
  });
```

E, depois da loja, os quatro relógios — cada um com o `stop()` acrescentado ao
desligamento de `index.ts:1230-1257`, **junto dos outros e pela mesma razão**:
uma rodada que começasse agora falaria com um supervisor já parado.

```ts
+ let siteDeliveries: SiteDeliveries | null = null;
+ let siteSettler: PurchaseSettler | null = null;
+ let catalogMirror: CatalogMirror | null = null;
+
+ if (siteBeacon !== null) {
+   siteBeacon.start();
+ }
+
+ if (siteClient !== null && siteWallet !== null) {
+   siteDeliveries = new SiteDeliveries({
+     client: siteClient, repository: siteDeliveriesRepository,
+     serverId: siteLocalServerId, presence: { online: onlineSteamIdsOf },
+     deliver: deliverFromSite, logger, pollMs: agent.site.deliveryPollMs,
+   });
+   siteDeliveries.start();
+
+   // A dep se chama `service` nos DOIS lugares — a rota do §14.16(d)
+   // chama `deps.service.settle(...)`, e um nome diferente aqui
+   // deixaria o critério do §21.6 sem como ser conferido.
+   siteSettler = new PurchaseSettler({ service: store, repository: storeRepository,
+     logger, intervalMs: agent.site.settleIntervalMs });
+   siteSettler.start();
+
+   if (agent.site.catalogPushEnabled) {
+     catalogMirror = new CatalogMirror({ client: siteClient, repository: storeRepository,
+       meta: metaRepository, logger });
+     catalogMirror.start();
+   }
+ }
+
+ // O gancho do §10.7: a fila acorda quando alguém conecta.
+ presenceWatcher = new PresenceWatcher({
+   tracker, logger, intervalMs: /* … */,
+   ...(siteDeliveries === null ? {} : { onJoined: () => siteDeliveries?.wake() }),
+ });
```

**Quatro nomes deste bloco, e nenhum deles é óbvio:**

- **`siteLocalServerId`** vem de `LoadedConfig`, resolvido por `assertSiteBinding`
  (§14.14). Ele **não** é `agent.site.localServerId`: aquele pode estar vazio, e
  este é o id já resolvido para "o único que existir".
- **`onlineSteamIdsOf`** é o gancho dos kits (`index.ts:687-704`) extraído para
  uma função nomeada e reusado pelos dois. **Ele não é o `onlineOf` de
  `index.ts:811`**, que é outra coisa: aquele devolve `Promise<number | null>` —
  uma **contagem**, para as variáveis de mensagem — e continua onde está. Dois
  nomes iguais com tipos diferentes no mesmo arquivo é o começo de um bug de
  leitura.
- **`primaryMac()`** é novo: `core/src/site/mac.ts` (§14.21).
- **`metaRepository`** é novo: `core/src/db/meta-repository.ts` (§14.22).

`deliverFromSite` chama o **mesmo** caminho de entrega da compra, e ele é fino de
propósito:

```ts
+ const deliverFromSite = async (input: {
+   readonly serverId: string;
+   readonly steamId: string;
+   readonly task: DeliveryTask;
+ }): Promise<void> => {
+   // A tradução do vocabulário da fila para o plano mora na
+   // fronteira do site (§14.6), e a execução mora na loja (§14.11
+   // d.1). Aqui não há regra nenhuma: só o encontro dos dois.
+   await store.deliverPlan(
+     input.serverId,
+     input.steamId,
+     planOfPayload(input.task.kind, input.task.payload, Date.now()),
+   );
+ };
```

Assim existe **um** lugar que manda `origemz.give` — o `deliverPlan` do §14.11 —
e um lugar que traduz o payload do site, o `planOfPayload` do §14.6.

---

### 14.16 `core/src/http/routes/store.ts` — ALTERADO

**(a) o enum do histórico** (`:205-210`):

```ts
- state: z.enum(['pending', 'debited', 'delivered', 'refunded', 'failed']).optional(),
+ state: z
+   .enum(['pending', 'debited', 'delivered', 'refunded', 'failed', 'charge-unknown'])
+   .optional(),
```

**(b) o 202 na compra** (antes do `throw` de `:565-569`).

**A assinatura do handler muda**, e sem isso o `reply` não existe: a rota é
`app.post('/servers/:id/store/buy', async (request) => {` (`store.ts:529`). Ela
passa a ser `async (request, reply) =>`, como as de POST de categoria e oferta já
são (`store.ts:238` e `:313`).

E o corpo do 202 é o **mesmo formato de erro do resto da casa** — o de
`core/src/http/error-response.ts`, que é o que `ApiError` produz — com `purchase`
como campo extra. Duas formas de erro na mesma rota é o começo de um cliente com
dois parsers:

```ts
+   if (outcome.status === 'charge-unknown') {
+     // ####  202: ACEITO E NÃO TERMINADO  ####
+     //
+     // Nem 200 (metade dos clientes HTTP leria como sucesso) nem 5xx
+     // (que convida a repetir — e repetir aqui é cobrar de novo quem
+     // talvez já tenha pago). O `purchase` vai junto para quem
+     // chamou poder acompanhar.
+     return reply.code(202).send({
+       // Os três primeiros campos são os de `error-response.ts`, e
+       // nesta ordem: um cliente que já lê erro desta API lê este.
+       ok: false,
+       error: 'CHARGE_UNKNOWN',
+       message,
+       // O extra, e é ele que permite acompanhar.
+       purchase: toPurchaseView(outcome.purchase),
+     });
+   }
```

**(c) o mapa de status** (`:697-734`):

```ts
  function errorCodeOf(status: string): string {
    switch (status) {
      /* … */
+     case 'over-limit':        return 'OVER_PURCHASE_LIMIT';
+     case 'charge-rejected':   return 'CHARGE_REJECTED';
+     case 'charge-unknown':    return 'CHARGE_UNKNOWN';
+     case 'store-unavailable': return 'STORE_UNAVAILABLE';
+     case 'already-in-flight': return 'PURCHASE_IN_FLIGHT';
      default:                return 'DELIVERY_FAILED';
    }
  }

  function httpStatusOf(status: string): number {
    switch (status) {
      /* … */
+     case 'over-limit':        return 409;
+     // 502: o pedido do CHAMADOR estava certo; quem recusou foi o
+     // site, por um defeito do contrato entre nós e ele.
+     case 'charge-rejected':   return 502;
+     case 'charge-unknown':    return 202;
+     // 503: a loja existe e não está pronta. É o mesmo status que
+     // `wallet-unavailable` usa, e pela mesma razão — "tente de
+     // novo em instantes" é a verdade nos dois.
+     case 'store-unavailable': return 503;
+     // 409: conflito com um estado que já existe. Não é erro do
+     // pedido nem do site: é o jogador clicando duas vezes.
+     case 'already-in-flight': return 409;
      default:                return 502;
    }
  }
```

**(d) a rota nova de settle**, logo depois de `/servers/:id/store/buy`:

```ts
+ /**
+  * Força a reconciliação de UMA compra presa.
+  *
+  * É o botão que o relógio de 60 s tem no braço, e ele chama a MESMA
+  * função — `StoreService.settle`. Dois códigos que decidem isto
+  * discordariam no primeiro ajuste.
+  */
+ app.post('/servers/:id/store/purchases/:purchaseId/settle', async (request) => {
+   const { id, purchaseId } = settleParams.parse(request.params);
+
+   assertServer(deps, id);
+
+   const outcome = await deps.service.settle({ serverId: id, purchaseId });
+
+   return { ok: true, outcome, message: describeSettle(outcome) };
+ });
```

**(e) o comentário mentiroso de `:518-527`**, que hoje diz que a rota
`POST /servers/:id/store/buy` "EXISTE PARA O SITE":

```
antes:  "Esta rota é para quem compra pelo site e para o teste manual
         — e ela cobra do MESMO jeito, pelo mesmo serviço."

depois: "####  ELA NÃO É O CAMINHO DA COMPRA FEITA NO SITE  ####

         Ela COBRA. Usá-la para entregar o que o site já vendeu
         cobraria o jogador duas vezes. O que o site vendeu chega
         pela fila de entregas (Docs\20 §10), que não move dinheiro.

         Esta rota existe para o teste manual e para uma venda que o
         AGENTE deve cobrar."
```

**E ela CONTINUA existindo com o site ligado**, protegida como está: ela passa
pelo mesmo `StoreService.buy`, e portanto pela trava de compra em voo, pelo teto
de OZ e pelo `ready` do §14.11. Bloqueá-la seria tirar do suporte o único jeito
de reproduzir uma compra sem entrar no jogo. O que muda é o comentário — porque
"esta rota é para quem compra pelo site" convidava, por escrito, a usá-la para
entregar o que o site já vendeu, **cobrando o jogador duas vezes**.

**(f) a mensagem do `WALLET_IS_REMOTE`** (`:483-491`) ganha o caminho da tela do
site. O 409 não muda.

**(g) `GET /players/:steamId/wallet`** passa a devolver `balance: number | null`
e o comentário de `:455-458` ganha uma frase: *"e `entries` é o extrato LOCAL —
compras feitas no site não aparecem nele."*

---

### 14.17 `core/src/http/server.ts` — ALTERADO

Três linhas, todas por anexação:

```ts
+ import { registerSiteRoutes, type SiteRoutesDeps } from './routes/site.js';
```

```ts
    readonly store: Omit<StoreRoutesDeps, 'supervisor'>;
+   /** O pareamento com o site OrigemZ. Ver Docs\20 §9.6. */
+   readonly site: SiteRoutesDeps;
```

```ts
      registerStoreRoutes(api, { ...options.store, supervisor: options.supervisor });
+     registerSiteRoutes(api, options.site);
```

---

### 14.18 `core/src/game/ui-store-bridge.ts` — ALTERADO

Três linhas, e são as três que consomem `getBalance`:

```ts
- balance = (await options.wallet.getBalance(steamId)).balance;
+ balance = (await options.wallet.getBalance(steamId)).balance;   // agora já é `number | null`
```

O tipo local `let balance: number | null = null` (`:101`, `:221`) **já estava
certo** — o que faltava era a carteira saber dizer `null`. O `catch` continua,
porque um `throw` inesperado não pode derrubar o modal.

No cabeçalho (`:313-315`), `balance.toLocaleString('pt-BR')` passa a ser
condicionado:

```ts
- values[BALANCE_ELEMENT_SUFFIX] = balance.toLocaleString('pt-BR');
+ // Sem saldo, o traço continua: melhor não dizer nada do que dizer
+ // zero para quem tem dinheiro. É a mesma razão do `catch` abaixo.
+ if (balance !== null) {
+   values[BALANCE_ELEMENT_SUFFIX] = balance.toLocaleString('pt-BR');
+ }
```

**`core/src/game/ui-store-screens.ts` NÃO MUDA.** `affordable = balance === null || balance >= total`
(`:718`) já trata `null` como "deixa tentar", e `buildResultScreen` já aceita
`balance: number | null`. O arquivo foi escrito para este dia.

---

### 14.19 O painel

`panel/src/lib/api.ts:1058-1069`:

```ts
  export interface WalletView {
    steamId: string;
-   balance: number;
+   /** `null` = a carteira não respondeu. NÃO é zero. */
+   balance: number | null;
    source: 'local' | 'remote';
    entries: WalletEntry[];
  }
```

E, no fim do arquivo (regra de anexação), os tipos e métodos de
`GET /api/site/status`, `POST /api/site/beacon` e
`POST /api/servers/:id/store/purchases/:id/settle`.

`panel/src/app/jogador/page.tsx:954`:

```tsx
- {wallet.balance.toLocaleString('pt-BR')} OZ
+ {wallet.balance === null ? '—' : `${wallet.balance.toLocaleString('pt-BR')} OZ`}
```

O travessão, e não zero: é a regra escrita do repositório — *ausente vira
travessão, nunca zero*.

---

### 14.20 A documentação

- **`.env.example`**: o bloco novo do §16.4, no fim, antes do bloco `LOG`. O
  arquivo é escrito **sem acentos** (é a convenção dele); mantenha.
- **`Docs/README.md`**: uma linha na tabela dos documentos de fase
  (`README.md:57-61`).
- **`README.md` da raiz**: uma linha na lista de `:58-72`.
- **`Docs/06-API.md`**: a seção "O que não existe nesta API" (`:1620-1624`) cita
  `loja` como inexistente e já estava desatualizada antes deste trabalho.
  Acrescente as rotas novas ao documento e corrija a lista **no mesmo commit** —
  é a regra da casa: a referência muda no commit que muda o comportamento.

---

### 14.21 `core/src/site/mac.ts` — NOVO

```ts
// ============================================================
//  mac.ts  -  o endereço físico que o beacon manda.
//
//  ####  O SITE GRAVA ISTO, E DEPOIS BANE POR ELE  ####
//
//  O beacon manda `mac`, o site o normaliza
//  (`trim().toLowerCase()`), grava em `agents.beaconMac` e o usa em
//  `findBan(ip, mac)`. Mandar o MAC de uma interface VIRTUAL — uma
//  ponte de Docker, um adaptador de VPN, um loopback — significa
//  gravar no site uma identidade que muda quando o Docker sobe, e
//  banir por ela é banir a máquina errada.
//
//  ####  VAZIO É UMA RESPOSTA VÁLIDA  ####
//
//  O campo é opcional no beacon (§5.2). Uma string vazia é melhor
//  que um MAC inventado: ela diz "não sei", e o site continua
//  usando o IP.
// ============================================================

import { networkInterfaces } from 'node:os';

const EMPTY_MAC = '00:00:00:00:00:00';

/**
 * A primeira interface NÃO interna com MAC de verdade.
 *
 * `''` quando não houver nenhuma. Não lança, nunca: ele roda no
 * boot, e uma máquina sem placa de rede reconhecível não pode
 * impedir o agente de subir.
 */
export function primaryMac(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.mac !== EMPTY_MAC && address.mac !== '') {
        return address.mac.toLowerCase();
      }
    }
  }

  return '';
}
```

---

### 14.22 `core/src/db/meta-repository.ts` — NOVO

A `version` confirmada do espelho mora na tabela `meta` (§15.4), e o padrão de
leitura e escrita **já existe** — só que como métodos **privados** dentro de
`ItemsRepository` (`core/src/db/items-repository.ts:386-404`, `#readMeta` e
`#writeMeta`). `grep -rn "metaRepository\|MetaRepository" core/src` devolve zero:
não há repositório reusável.

**A escolha é extrair, não copiar.** `#readMeta`/`#writeMeta` saem de
`items-repository.ts` para `MetaRepository`, e `ItemsRepository` passa a
**receber uma instância** dela. Copiar as duas consultas criaria duas verdades
sobre a mesma tabela — e a segunda seria a que esquece o `updated_at`.

```ts
// ============================================================
//  meta-repository.ts  -  a tabela key/value do agente.
//
//  Uma linha por chave, e a chave é o nome inteiro do fato:
//  `items.catalog.version`, `site.catalog.mirrored_version`.
//  Prefixo por assunto, para que um `SELECT` com `LIKE` mostre um
//  assunto de cada vez.
// ============================================================

export class MetaRepository {
  read(key: string): string | null { /* … */ }
  write(key: string, value: string, now?: number): void { /* … */ }
  /** Duas chaves numa transação: a version e o `_at` dela. */
  writeMany(entries: Readonly<Record<string, string>>, now?: number): void { /* … */ }
}
```

Nenhuma migração é necessária: `meta` nasceu na 001
(`core/src/db/migrations.ts:179-183`).

---

### 14.23 `core/src/players/presence.ts` — ALTERADO

O gancho `onJoined` do §10.7, por extenso lá. Três linhas de mudança, e uma delas
é a que faz `SiteDeliveries.wake()` existir para alguém chamar.

`PresenceTracker.syncAll()` **já devolve** `readonly PresenceSyncResult[]`
(`:311`) e `PresenceSyncResult.joined` **já existe** (`:147-152`) — o que falta é
`PresenceWatcher.sweep()` (`:418-427`) parar de descartar o retorno.

---

### 14.24 `core/test/store.test.ts` — ALTERADO

**É a única coisa da fase 2 que impede o `npm test -w core` de ficar verde**, e o
mapa de arquivos não a listava.

`brokenWallet` (`core/test/store.test.ts:305-311`) implementa `Wallet` à mão, com
métodos **posicionais** e um `{ status: 'ok', balance: 500 }` que, na união nova,
está sem `transactionId` e sem `replayed`:

```ts
  const brokenWallet: Wallet = {
    source: 'local',
    getBalance: (steamId) => Promise.resolve({ steamId, balance: 1000, source: 'local' }),
-   debit: (): Promise<WalletChange> => Promise.resolve({ status: 'ok', balance: 500 }),
+   debit: (): Promise<WalletChange> =>
+     Promise.resolve({ status: 'ok', balance: 500, transactionId: null, replayed: false }),
    credit: (): Promise<WalletChange> =>
      Promise.resolve({ status: 'unavailable', reason: 'a carteira sumiu' }),
  };
```

`credit` não muda: `unavailable` ganhou `cause`, mas ele é opcional na leitura do
serviço — confira, e se o TypeScript reclamar, acrescente `cause: 'network'`. O
teste em volta (`'e o estorno também falha, o estado vira "failed"'`) continua
valendo palavra por palavra: ele é justamente o que prova que o desfecho mais
caro do documento não regrediu.

---

## 15 — Migrations novas

### 15.0 Os números estão RESERVADOS

A última migração aplicada hoje é a **32** (`wipe-plugin-data-globstar`,
`core/src/db/migrations.ts:2706`). Esta frente reserva **035** e **036**, por
escrito, aqui:

| Número | Nome | O que faz |
|---|---|---|
| 035 | `store-purchase-charge-unknown` | recria `store_purchases` com o estado novo e três colunas |
| 036 | `site-deliveries` | a tabela de idempotência da entrega puxada |
| 037 | `site-commands` | o dedup do comando que o site enfileira (`Docs/22`) |

####  POR QUE NÃO 033 E 034  ####

**Porque a 033 já é de outra frente, e ela escreveu primeiro.**
`Docs/19-PESQUISA-RANKING.md:142-143` diz, por escrito, *"a última migração
aplicada é a **032**; a primeira livre para o ranking é a **033**"*, e
`Docs/19:1170` detalha o conteúdo dela: `stat_periods`, `player_stats`,
`stat_batches`. As duas frentes vivem na mesma árvore e as duas estavam prontas
para escrever `{ id: 33, ... }`.

O quadro de reservas, para que ninguém precise adivinhar de novo:

| Número | Frente | Documento |
|---|---|---|
| 033 | ranking de jogadores | `Docs/19-PESQUISA-RANKING.md` |
| 034 | **reservada à frente do ranking** (folga: o esquema dela pode crescer) | `Docs/19` |
| 035 | `store-purchase-charge-unknown` | **este documento** |
| 036 | `site-deliveries` | **este documento** |
| 037 | `site-commands` | `Docs/22-COMANDOS-E-CONFIG-DO-SITE.md` |

**Ninguém usa um número que não é seu**, mesmo que o vizinho ainda não tenha
começado. Duas frentes que olham o arquivo e escrevem "33" dão **merge limpo e
banco quebrado**: o SQLite aplica a primeira e ignora a segunda para sempre,
porque o número já consta em `schema_migrations`
(`core/src/db/migrations.ts:2737-2741`). E o custo aqui não é abstrato: se a do
ranking chegar primeiro, `store_purchases` fica **sem** `charge-unknown` no
CHECK e **sem** as colunas `reference` / `site_transaction_id` / `delivery` — e
`createPurchase` estoura em **toda** compra, em produção, com a integração de
dinheiro ligada. É a regra do `Docs/17-FRENTES-WIPE-E-MENSAGENS.md:19-37`, e a
reserva só vale quando está escrita nos **dois** documentos: quem mexer em
`Docs/19` precisa ver esta tabela, e quem mexer aqui precisa ver a de lá.

E a outra regra, do mesmo lugar: **nunca edite uma migração já aplicada.**
`runMigrations` pula todo id que já consta na tabela de controle
(`core/src/db/migrations.ts:2737-2741`), então o texto novo valeria só para
bancos que ainda não a rodaram. O conserto de uma migração aplicada é uma
migração **nova**, do tipo `run`, que pergunta ao `pragma_table_info` o que
falta — é o que a 030 faz (`migrations.ts:2475-2495`).

### 15.1 Migração 035 — o estado que faltava

**Por que recriar a tabela inteira.** O SQLite **não altera um CHECK no lugar**.
Acrescentar `charge-unknown` a `store_purchases.state` exige o procedimento que
as migrações 014, 017 e 018 já usam: RENAME, CREATE, `INSERT … SELECT` **com o
`id` copiado explicitamente**, DROP, e recriar os índices **depois** do DROP
(o RENAME leva os índices junto, com os nomes originais — criar um índice de
mesmo nome antes do DROP falharia).

```ts
// ------------------------------------------------------------
//  035 — a compra que PODE ter sido cobrada
//
//  ####  TRÊS ESTADOS NÃO COBREM CINCO DESFECHOS  ####
//
//  Quando o site cobra e a resposta se perde no caminho, a compra
//  de hoje fecha como `failed` — o mesmo estado de "não tinha
//  saldo" e de "o estorno falhou". O jogador pagou, não recebeu, e
//  nada no sistema volta para conferir.
//
//  `charge-unknown` é o único estado NÃO TERMINAL da tabela: ele
//  significa "não sei se cobrou", nada foi entregue e nada foi
//  estornado, e é o relógio da reconciliação que o resolve — com
//  PROVA, consultando o site pela referência. Ver Docs\20 §4 e §11.
//
//  ####  A REFERÊNCIA PRECISA FICAR GRAVADA  ####
//
//  Ela é a única chave que liga esta linha ao ledger do site. Hoje
//  ela é DERIVADA do `id` da compra; no dia em que a convenção
//  mudar, todo o histórico anterior deixa de ser reconciliável — e
//  a pergunta "eu paguei e não recebi" chega meses depois.
//
//  ####  O QUE IA SER ENTREGUE FICA CONGELADO NA LINHA  ####
//
//  A reconciliação pode entregar horas depois. Se ela relesse
//  `store_offers`, uma oferta editada no meio entregaria OUTRA
//  COISA, cobrada com o preço de ontem — e uma oferta apagada não
//  entregaria nada. O plano gravado é o que a compra prometeu.
//
//  ####  O SQLite NÃO ALTERA UM CHECK NO LUGAR  ####
//
//  Por isso a tabela é recriada, com o `id` copiado EXPLICITAMENTE:
//  ele é a chave que o extrato, o log e o site já conhecem, e
//  renumerar aqui reescreveria o comprovante de compras antigas.
// ------------------------------------------------------------
const STORE_PURCHASE_CHARGE_UNKNOWN_SCHEMA = `
ALTER TABLE store_purchases RENAME TO store_purchases_015;

CREATE TABLE store_purchases (
  id        TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  steam_id  TEXT NOT NULL,

  offer_id    TEXT NOT NULL,
  offer_name  TEXT NOT NULL,
  shortname   TEXT NOT NULL,
  skin_id     TEXT NOT NULL DEFAULT '0',
  amount      INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,
  total_price INTEGER NOT NULL,

  --   'pending'         nasceu, e nada de dinheiro aconteceu ainda
  --   'debited'         o dinheiro SAIU; falta entregar
  --   'delivered'       acabou bem
  --   'refunded'        a entrega falhou e o valor voltou
  --   'failed'          precisa de gente
  --   'charge-unknown'  PODE TER COBRADO — o único não terminal
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'debited', 'delivered', 'refunded', 'failed', 'charge-unknown')),
  error TEXT,

  -- O \`referenceId\` mandado ao site. NULL nas compras anteriores a
  -- esta migração, e nas de quem usa a carteira LOCAL.
  reference TEXT,

  -- O id da linha no ledger do site. TEXTO, e não INTEGER: lá ele é
  -- BIGINT, e ninguém faz conta com ele deste lado.
  site_transaction_id TEXT,

  -- O que esta compra prometeu entregar, em JSON. Ver o cabeçalho.
  --
  -- Ele é LIDO por \`planFromJson\` (§11.4), e NULL é resposta
  -- legítima em dois casos: compra anterior a esta migração (o
  -- \`INSERT … SELECT\` abaixo grava NULL) e compra feita com a
  -- carteira LOCAL. NULL não é "entregue o que der".
  delivery TEXT,

  -- Quantas rodadas de reconciliação esta compra já custou.
  --
  -- Coluna, e não contador em memória: um restart do agente não pode
  -- zerar o teto, ou o laço volta a ser eterno na primeira queda.
  -- Ver Docs\20 §11.1.
  settle_attempts INTEGER NOT NULL DEFAULT 0,

  -- Quem está olhando esta linha AGORA, em epoch ms. NULL = ninguém.
  --
  -- É a reivindicação do §11.4: o relógio e o botão chamam a mesma
  -- função, e nada impede que os dois estejam sobre a MESMA compra —
  -- o \`#running\` protege contra duas rodadas do relógio, não contra
  -- o relógio e um humano clicando. Duas execuções concorrentes
  -- produziriam duas entregas para uma cobrança.
  --
  -- Coluna, e NÃO um sétimo valor no CHECK: "estou olhando isto
  -- agora" é um cadeado, não um desfecho de compra, e um estado a
  -- mais mudaria o enum público de GET /api/store/purchases.
  settling_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- O \`id\` vai EXPLÍCITO na lista: ele é o comprovante.
INSERT INTO store_purchases
  (id, server_id, steam_id, offer_id, offer_name, shortname, skin_id, amount,
   unit_price, total_price, state, error, reference, site_transaction_id, delivery,
   settle_attempts, settling_at, created_at, updated_at)
SELECT
   id, server_id, steam_id, offer_id, offer_name, shortname, skin_id, amount,
   unit_price, total_price, state, error, NULL, NULL, NULL,
   0, NULL, created_at, updated_at
  FROM store_purchases_015;

DROP TABLE store_purchases_015;

CREATE INDEX idx_store_purchases_player ON store_purchases (steam_id, created_at DESC);

-- "O que travou?" — a tela das compras presas. \`charge-unknown\` entra
-- aqui: ela é dinheiro que pode ter saído sem item, e é a pergunta
-- mais urgente que esta tabela responde.
CREATE INDEX idx_store_purchases_stuck ON store_purchases (created_at DESC)
  WHERE state IN ('pending', 'debited', 'failed', 'charge-unknown');

CREATE INDEX idx_store_purchases_server ON store_purchases (server_id, created_at DESC);

-- "Este jogador já tem compra aberta?" — a trava do §17.6, regra 6,
-- consultada em TODA compra, antes de qualquer cobrança. PARCIAL
-- pelos três estados abertos: as fechadas são a maioria e não
-- interessam a esta pergunta.
CREATE INDEX idx_store_purchases_open ON store_purchases (server_id, steam_id, created_at DESC)
  WHERE state IN ('pending', 'debited', 'charge-unknown');

-- A referência é ÚNICA do lado do site; ela tem de ser única aqui
-- também, ou duas compras locais mandariam a mesma chave e a segunda
-- levaria o item de graça. PARCIAL porque NULL é o normal de quem
-- usa a carteira local — e no SQLite dois NULL são DISTINTOS, então
-- sem o \`WHERE\` o índice não impediria nada e ainda cresceria à toa.
CREATE UNIQUE INDEX idx_store_purchases_reference ON store_purchases (reference)
  WHERE reference IS NOT NULL;
`;
```

### 15.2 Migração 036 — a fila de entregas do site

```ts
// ------------------------------------------------------------
//  036 — a idempotência da entrega puxada do site
//
//  ####  A RESERVA ACONTECE ANTES DO COMANDO  ####
//
//  Um agente que caia entre o \`origemz.give\` e o ACK reencontra a
//  tarefa na próxima página do site. Sem esta tabela ele entregaria
//  DE NOVO — item duplicado, uma cobrança. Com ela, a linha órfã em
//  \`reserved\` diz "o comando pode ter saído", e a tarefa vai para
//  conferência humana em vez de ser reexecutada.
//
//  ####  SEM CHAVE ESTRANGEIRA PARA \`servers\`  ####
//
//  Mesma razão de \`store_purchases\` (ver a 015): apagar um servidor
//  não pode apagar o comprovante de uma entrega. A pergunta "o site
//  diz que entregou; entregou mesmo?" chega meses depois, às vezes
//  de um servidor que já não existe.
//
//  ####  \`indeterminate\` É UM ESTADO, E NÃO UM ERRO  ####
//
//  Reexecutar entrega duas vezes; ACKar \`failed\` devolve ao site um
//  item que talvez esteja no chão do jogador. Na dúvida, PRESERVA —
//  e preservar é ACKar \`deferred\` com \`reason: 'AGENT_INDETERMINATE'\`,
//  para o site tirar a tarefa de \`pending\`, pô-la em \`review\` e a
//  expiração de 30 dias não a alcançar (Docs\\20 §10.4).
//
//  ####  O NOME É \`indeterminate\` PORQUE \`review\` É DO SITE  ####
//
//  Lá, \`review\` é o estado para onde o site move a tarefa ao ler
//  esse \`reason\`. Duas máquinas de estado, dois bancos, e duas telas
//  mostrando as duas contagens: o mesmo nome faria alguém concluir
//  que uma está errada. A palavra do FIO não é nem \`review\` nem
//  \`indeterminate\`: é \`deferred\` + \`AGENT_INDETERMINATE\`.
// ------------------------------------------------------------
const SITE_DELIVERIES_SCHEMA = `
CREATE TABLE site_deliveries (
  -- O \`deliveryId\` que o site mandou. É ele que torna a entrega
  -- idempotente, e é por isso que ele é a chave primária.
  id TEXT PRIMARY KEY,

  server_id TEXT NOT NULL,
  steam_id  TEXT NOT NULL,

  kind TEXT NOT NULL CHECK (kind IN ('item', 'kit', 'vip', 'vehicle')),

  -- O payload como veio do site, em JSON, DEPOIS de validado. Ele
  -- fica guardado para que uma conferência humana consiga dizer o
  -- que era para ter saído, sem depender de o site ainda ter a fila.
  payload TEXT NOT NULL,

  -- O \`itemRef\`/\`orderId\` do site, para o suporte cruzar os dois lados.
  source_ref TEXT,

  --   'reserved'       o comando vai sair, ou saiu e não sabemos
  --   'delivered'      o plugin respondeu ok
  --   'failed'         falha DEFINITIVA, com o código cru
  --   'indeterminate'  o agente caiu no meio; ACKa 'deferred'
  --                    com reason 'AGENT_INDETERMINATE'
  --   'expired'        o site devolveu o id em \`unknown\` no ACK,
  --                    e a linha NÃO era terminal
  state TEXT NOT NULL
    CHECK (state IN ('reserved', 'delivered', 'failed', 'indeterminate', 'expired')),

  -- O código CRU do plugin (PLAYER_DEAD, INVENTORY_FULL...), não a
  -- frase: é o que o suporte procura no log.
  reason TEXT,

  attempts INTEGER NOT NULL DEFAULT 0,

  reserved_at INTEGER NOT NULL,
  -- NULL = o site ainda não recebeu o desfecho desta linha.
  acked_at    INTEGER,
  updated_at  INTEGER NOT NULL
);

-- "O que ainda não foi confirmado ao site?" — a pergunta do laço.
-- PARCIAL: as confirmadas são a esmagadora maioria e não interessam.
CREATE INDEX idx_site_deliveries_open ON site_deliveries (updated_at DESC)
  WHERE acked_at IS NULL;

-- "O que este jogador recebeu do site?" — o suporte e a ficha.
CREATE INDEX idx_site_deliveries_player ON site_deliveries (steam_id, reserved_at DESC);
`;
```

### 15.3 As duas linhas do array

No fim de `MIGRATIONS` (`core/src/db/migrations.ts:2655-2707`), **por anexação**:

```ts
  { id: 32, name: 'wipe-plugin-data-globstar', run: rewriteLegacyPluginDataPatterns },
+ // 035 e 036 são da frente da integração com o site OrigemZ
+ // (Docs\20). A 033 e a 034 são do ranking (Docs\19) — ver §15.0.
+ // A 035 RECRIA `store_purchases`: ela precisa rodar depois de
+ // toda migração que toque essa tabela.
+ { id: 35, name: 'store-purchase-charge-unknown', sql: STORE_PURCHASE_CHARGE_UNKNOWN_SCHEMA },
+ { id: 36, name: 'site-deliveries', sql: SITE_DELIVERIES_SCHEMA },
];
```

**E nada além disso.** `TARGET_SCHEMA` e `MIN_SCHEMA` são derivados da lista por
`reduce` (`core/src/db/schema-version.ts:59-73`) — não há constante para
atualizar.

### 15.4 O que NÃO precisa de migração

- **A versão do espelho do catálogo** mora na tabela `meta`
  (`key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL`,
  criada na migração 001, `core/src/db/migrations.ts:179-183`), com as chaves
  `site.catalog.mirrored_version` e `site.catalog.mirrored_at`. O padrão de
  leitura e escrita já existe em `core/src/db/items-repository.ts:386-404`.
- **O estado do pareamento** é derivado do último beacon e vive em memória. Ele
  não sobrevive a um restart de propósito: um pareamento gravado que estivesse
  errado seria pior que nenhum, porque o boot seguinte confiaria nele por até
  10 s antes da primeira batida.
- **`wallets` e `wallet_entries` não mudam.** Elas congelam e viram histórico.

---

## 16 — Variáveis de ambiente

### 16.1 As novas

| Nome | Tipo | Default | Efeito |
|---|---|---|---|
| `SITE_BASE_URL` | string (origem, sem `/api`) | `''` | **o interruptor**. Vazio = carteira local e integração desligada. Preenchido = o site é o dono do saldo, e nascem o beacon, a fila, a reconciliação e o espelho. Barra final removida na leitura |
| `SITE_TOKEN` | string | `''` | o bearer. Com `SITE_BASE_URL` preenchida e este vazio, o agente **sobe em modo pending**: beacona e não cobra |
| `SITE_SERVER_ID` | string ≤ 50 | `''` | o `serverId` cadastrado no site. Casa por string **EXATA**. Vazio com `SITE_BASE_URL` preenchida **derruba o boot** |
| `SITE_LOCAL_SERVER_ID` | string | `''` | o servidor de `Configs\` que recebe as entregas puxadas. Vazio com mais de um servidor **derruba o boot** |
| `SITE_TIMEOUT_MS` | int > 0 | `5000` | teto de espera por resposta no caminho de quem clicou. **Derivado do timeout do plugin, não escolhido** — §16.2 |
| `SITE_BEACON_INTERVAL_MS` | int > 0 | `10000` | cadência do batimento; **clamp 5000..300000** |
| `SITE_DELIVERY_POLL_MS` | int > 0 | `15000` | cadência do pull da fila; **mínimo 5000** |
| `SITE_SETTLE_INTERVAL_MS` | int > 0 | `60000` | cadência da reconciliação |
| `SITE_CATALOG_PUSH_ENABLED` | bool | `1` | liga o espelho do catálogo |
| `SITE_USER_AGENT` | string | `OrigemZ-Rust-Agent/<versão>` | o `User-Agent` das chamadas |
| `SITE_SETTLE_FALLBACK_REDEBIT` | bool | `0` | fecha `charge-unknown` repetindo o débito quando a rota de prova não existe. **Cobra quem desistiu** — ver §11.5 |
| `STORE_MAX_OZ_PER_PURCHASE` | int ≥ 0 | `100000` | teto de OZ por compra, **no agente**. `0` = sem teto. Leitura própria: `intFromEnv` recusa `0` (§14.14) |

As doze estão em `config.site` (dez) e em `config.store` (duas) — e as doze são
**lidas** no §14.14. Duas delas, `SITE_SETTLE_FALLBACK_REDEBIT` e
`STORE_MAX_OZ_PER_PURCHASE`, estavam declaradas nesta tabela e no `.env.example`
sem uma linha de leitura em lugar nenhum; quem implementasse teria de inventar o
nome do campo.

### 16.2 Os três defaults que têm número por um motivo

- **`SITE_TIMEOUT_MS = 5000`, e ele é DERIVADO.** O plugin `OrigemZUI` arma um
  timeout de **8 s** por compra (`Plugins/OrigemZUI.cs:183`,
  `RequestTimeoutSeconds = 8f`) e, ao estourar, manda o jogador **conferir o
  inventário** em vez de tentar de novo — de propósito, porque tentar seria
  arriscar pagar duas vezes.

  **Uma versão anterior deste documento pedia 8000 aqui, e a justificativa era
  falsa.** Ela dizia que 8000 punha "o abort do agente ANTES do abort do plugin".
  Não põe: os dois são 8 s, e **o relógio do plugin começa primeiro** — ele arma
  o timer no clique (`OrigemZUI.cs:2008`), e o agente só arma o `AbortController`
  depois de a linha atravessar o RCON e chegar ao `StoreService`. Em toda resposta
  lenta do site o plugin dispara antes, e o `FailBuy` dele **zera o `PendingBuyId`
  e remove o `_pendingBuys`** (`OrigemZUI.cs:2075-2077`): o botão volta a
  funcionar com a primeira compra ainda em voo. O jogador lê "BuyTimeout", navega
  de volta e compra de novo — segundo `purchaseId`, segundo `referenceId`,
  **segunda cobrança**.

  O orçamento, escrito como soma, porque é assim que ele tem de ser conferido:

  | Parcela | Valor | Nota |
  |---|---|---|
  | RCON, ida e volta do `#OZBUY#` até o `StoreService` | ~200 ms | a linha de console e o parse |
  | **`SITE_TIMEOUT_MS`** | **5 000 ms** | o único teto que ESTE documento escolhe |
  | entrega: `origemz.give` (ou `vehicle.spawn`) + resposta | ~1 000 ms | um kit de 40 itens é 40 comandos em sequência |
  | resposta ao plugin (`origemz.ui.buyresult`) | ~200 ms | |
  | **folga** | ~1 600 ms | |
  | **total** | **< 8 000 ms** | o teto do plugin |

  **A regra que fica:** `SITE_TIMEOUT_MS + 2000 ≤ RequestTimeoutSeconds × 1000`.
  Mexer numa das duas exige recalcular a outra — e é por isso que o número do
  plugin está citado com arquivo e linha, e não de cabeça.
- **`SITE_BEACON_INTERVAL_MS = 10000`, clamp `5000..300000`.** O teto vem do
  site: ele considera "online" quem beaconou nos **últimos 5 minutos**. O piso
  vem do canal: `/api/agent` não tem rate-limit.
- **`STORE_MAX_OZ_PER_PURCHASE = 100000`.** É o valor que o painel do Conan
  adotou depois de um débito de 60 milhões de OZ numa requisição. Quem quiser
  vender acima disso muda a variável conscientemente.

### 16.3 A renomeação, e o fallback

`STORE_WALLET_URL` e `STORE_WALLET_TOKEN` decidem hoje local × remoto
(`core/src/config.ts:699-705`, `core/src/index.ts:484-491`) e **nunca estiveram
no `.env.example`** — quem quisesse ligar a carteira remota só descobriria a
variável lendo `config.ts`.

**A recomendação é renomear**, porque a mesma base passa a servir beacon,
carteira, entregas e catálogo: o nome "wallet" descreveria um terço do que a
variável faz.

**A regra do fallback, e ela tem três partes:**

1. `SITE_BASE_URL` vazia e `STORE_WALLET_URL` preenchida → o agente usa a antiga
   e **loga um `warn` no boot** dizendo o nome novo. Idem para
   `SITE_TOKEN` / `STORE_WALLET_TOKEN`.
2. As duas preenchidas → **a nova ganha**, sem erro. Um boot que recusasse aqui
   deixaria o agente parado por causa de uma linha esquecida no `.env`.
3. Se o valor de qualquer uma das duas terminar em `/api`, o boot **recusa** com
   uma `ConfigError` que diz exatamente o que pôr. É o único caso em que o
   fallback derruba o processo, e o motivo é que o valor antigo tinha outra
   semântica: ele era a base à qual a `RemoteWallet` acrescentava `/wallet/...`.
   Um `https://site/api` herdado montaria `https://site/api/api/agent/...` e o
   sintoma seria 404 em tudo — "a loja parou", de novo.

O fallback vale **por uma versão**. Depois disso as duas antigas somem, e a
remoção é uma linha.

### 16.4 As linhas para o `.env.example`

O arquivo é escrito **sem acentos** (é a convenção dele — veja qualquer bloco de
`.env.example:1-174`). Mantenha.

```dosini
# ------------------------------------------------------------
#  SITE OrigemZ  -  a integracao de OzCoin
#
#  ####  ISTO E O INTERRUPTOR DA VIRADA  ####
#
#  SITE_BASE_URL vazia: o saldo mora no banco DESTE agente, e nada
#  fala com o site. Preenchida: o SITE passa a ser o dono do saldo,
#  a loja in-game cobra la, o que o jogador compra no site e
#  entregue aqui dentro, e o painel do site enxerga esta loja.
#
#  A virada e preencher e reiniciar. O saldo local NAO e migrado:
#  sao carteiras diferentes, e somar uma na outra sem alguem mandar
#  seria inventar dinheiro.
#
#  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md.
# ------------------------------------------------------------

# A ORIGEM do site, sem /api no fim e sem barra final.
# Ex.: https://origemznetwork.com
SITE_BASE_URL=

# O bearer que o SITE gera quando o admin ativa o agente la.
# Com SITE_BASE_URL preenchida e este vazio, o agente SOBE assim
# mesmo, em modo pending: ele beacona e nao cobra nada.
SITE_TOKEN=

# O id do servidor CADASTRADO NO SITE. Ele casa por texto EXATO,
# maiusculas incluidas: "server01" e "SERVER01" sao dois.
# Obrigatorio quando SITE_BASE_URL esta preenchida.
SITE_SERVER_ID=

# Qual servidor de Configs\ recebe o que foi comprado no site.
# Vazio = o unico que existir. Com dois ou mais, e obrigatorio.
SITE_LOCAL_SERVER_ID=

# Teto de espera por resposta do site no caminho de um jogador que
# clicou. 5000 nao e chute: o plugin da loja desiste em 8 s
# (Plugins\OrigemZUI.cs:183) e, ao desistir, LIBERA O BOTAO com a
# compra ainda em voo. O agente precisa desistir antes dele, com
# folga para a entrega. A regra e SITE_TIMEOUT_MS + 2000 <= 8000.
# Ver Docs\20 secao 16.2.
SITE_TIMEOUT_MS=5000

# Cadencia do batimento. O site considera "online" quem beaconou
# nos ultimos 5 min. Aceita de 5000 a 300000.
SITE_BEACON_INTERVAL_MS=10000

# Cadencia do pull da fila de entregas. Minimo 5000: o canal do
# agente nao tem limite de requisicao do lado do site, e um laco
# apertado aqui satura o banco DELE.
SITE_DELIVERY_POLL_MS=15000

# Cadencia da reconciliacao de compras presas.
SITE_SETTLE_INTERVAL_MS=60000

# 1 = empurra o espelho da loja in-game para o painel do site.
# 0 = a loja continua funcionando e o painel do site nao a ve.
SITE_CATALOG_PUSH_ENABLED=1

# O User-Agent das chamadas. Vazio = OrigemZ-Rust-Agent/<versao>.
# Ele existe porque a borda do site recusa clientes HTTP genericos
# com um 403 de corpo em texto puro que se parece com um ban.
SITE_USER_AGENT=

# 1 = quando a rota de prova do site nao existir, fecha uma compra
# indeterminada REPETINDO o debito com a mesma referencia.
# E seguro para o dinheiro e CARO para o jogador: se nada tinha
# sido cobrado, cobra agora, de alguem que ja saiu. Deixe 0.
SITE_SETTLE_FALLBACK_REDEBIT=0


# ------------------------------------------------------------
#  LOJA  -  o teto de uma compra
#
#  O SITE NAO IMPOE TETO NENHUM: ele so recusa o que passa do
#  saldo. Quem impoe e o agente, e e por isso que esta linha
#  existe. Num painel irmao, a falta dela debitou 60 milhoes de OZ
#  numa requisicao so.
#
#  0 = sem teto.
# ------------------------------------------------------------
STORE_MAX_OZ_PER_PURCHASE=100000
```

### 16.5 O que o site precisa (para o outro documento)

Nenhuma variável **nova** é obrigatória do lado do site: o canal `/api/agent` já
está montado, `AGENT_MASTER_KEY` já cifra o bearer e o `serverId` já vem do
header. As de ajuste fino das rotas novas:

| Nome | Default | Para quê |
|---|---|---|
| `AGENT_DELIVERY_PAGE_MAX` | `100` | teto de `limit` em `/deliveries/pending`. `limit` acima do teto é **clampado**, nunca recusado — não existe 400 por `limit` (§5.7) |
| `AGENT_DELIVERY_TTL_DAYS` | `30` | dias que uma tarefa espera antes de expirar e devolver o item para `available` |
| `AGENT_DELIVERY_MAX_RESPONSE_BYTES` | `1048576` | teto do corpo da **resposta** de `/deliveries/pending`, em bytes. Estourou, o site devolve **menos linhas** e recalcula o `next` — **nunca** 413. É transparente para o agente, e é justamente por isso que ele precisa paginar (§5.7): uma página encurtada é indistinguível de uma página cheia |
| `AGENT_SHOP_MIRROR_MAX_BYTES` | `2097152` | teto do corpo do espelho. O parser global do site aceita 10 MB — o limite de 64 KB declarado no router de `agent-private` é letra morta —, então este teto precisa ser explícito no controller |
| `AGENT_RATE_LIMIT_PER_SERVER` | `240` (req/min por `serverId`) | limite nas cinco rotas novas. Não existe hoje. **O piso recomendado é 180**, e não 120: com a varredura de páginas do §5.7 o pico do canal passa de ~60 para ~91 req/min por servidor (§13.1 do manual do site) |

**As CINCO precisam entrar nos DOIS `.env` versionados do backend**
(`.env.development.example` e `.env.production.example`), com comentário, no
molde do §16.4 — e o critério de aceite global da §15 do manual do site cobra
exatamente as cinco. Sem isso, produção sobe com `AGENT_DELIVERY_TTL_DAYS`
indefinido e o `expires_at` de toda tarefa vira `NULL` ou `NaN`.

*(Este documento já disse "as quatro" e omitia `AGENT_DELIVERY_MAX_RESPONSE_BYTES`
— a variável existe, tem default e é cobrada do outro lado; a lista de lá
sempre teve cinco. Duas listas com contagens diferentes é o começo de um `.env`
que sobe faltando uma linha.)*

####  E O QUE MAIS O SITE PRECISA FAZER, EM UMA LISTA  ####

Não são variáveis: são mudanças de contrato que este documento **pede** e das
quais ele depende. A lista existe para que ninguém precise garimpá-las no meio
das seções.

| # | O quê | Onde está escrito | Sem isso |
|---|---|---|---|
| 1 | repassar `productId` no `/ozcoins/debit` | §5.4, ajuste 1 | o ledger grava `product_id = NULL` |
| 2 | aplicar o guard de replay por produto | §5.4, ajuste 2 | não há guard por produto |
| 3 | `error_code` nas validações de entrada | §5.4, ajuste 3 | todo 400 vira o mesmo `rejected` |
| 4 | **estruturar o 422**: `INSUFFICIENT_BALANCE` + `balance`/`required`/`missing` (**number**) | §5.4, ajuste 4 | o `insufficient` do agente carrega `balance: null` |
| 5 | `error_code: 'OZ_MUTATION_FAILED'` no 500 | §5.4, ajuste 5 | o 500 fica sem nome no log |
| 6 | criar `GET /ozcoins/transaction` | §5.6 | não há prova; o único caminho é redebitar (§11.5) |
| 7 | **`REFERENCE_NOT_MINE` separado de `REFERENCE_NOT_FOUND`** na rota de prova — **aceito**, e escrito nas §6.2/§6.3/§6.4 do manual do site | §5.6 | cobrança real vira "nunca aconteceu" na troca de `serverId` |
| 8 | criar `/deliveries/pending` e `/deliveries/ack` | §5.7, §5.8 | não há fila |
| 9 | **interpretar `reason: 'AGENT_INDETERMINATE'`** num ACK `deferred`: mover a tarefa para `review` e **tirá-la de `/pending`**, com a varredura filtrando `status='pending' AND last_reason <> 'AGENT_INDETERMINATE'` | §5.8, §10.4 | **entrega dupla em 30 dias** |
| 10 | `skinId` como **string de dígitos** no payload | §5.7, §23.3 | toda entrega de item e kit vira `PAYLOAD_INVALID` |
| 11 | `prefab` no alfabeto `/^[a-z0-9._-]{1,64}$/` — **o ponto é legal**, e `.prefab` e `/` não | §5.7, §23.3 | o resgate recusa com 400 o **nome exato** de um veículo ambíguo, e o `sedan` certo fica incadastrável (§5.7) |
| 12 | validar as réguas do §5.7 **no resgate**, com 400 | §23.3 | tarefa enfileirada que nunca vai ser executada |
| 13 | criar `/shop/mirror` e `/shop/mirror/version` | §5.9, §5.10 | o painel do site não vê a loja |
| 14 | ~~um caminho de admin para liberar entrega em `review`~~ **FEITO** — `POST /api/admin/rust/deliveries/:deliveryId/release`, especificado na §21.8 do manual do site | §22.13, §23.7 | (era: conciliação de entrega só por SQL) |
| 15 | decidir se a allowlist de IP vale para **todas** as rotas ou nenhuma | §17.3 | o agente cobra e para de conferir |

Os itens 9, 10 e 11 são os que **quebram a fase 1 inteira** se não forem feitos.
Os outros degradam.

---

## 17 — Segurança

### 17.1 O teto de OZ por compra

**Onde:** em `StoreService.buy`, **antes** de `createPurchase` e antes de
qualquer chamada ao site. Não na borda HTTP, não no plugin — os dois são
contornáveis; o serviço não.

**Por quê aqui e não no site:** o site não impõe teto nenhum, e mudá-lo é
trabalho de outro repositório. O agente é quem conhece o preço e a quantidade, e
é ele que tem o defeito possível: `total = offer.price * units`, com `units`
vindo de uma rota que aceita até 1000 (`core/src/http/routes/store.ts:220-224`) e
de uma tela que limita a 100 (`core/src/game/ui-store-screens.ts:184`) — dois
limites diferentes para a mesma conta.

O desfecho é `over-limit`, e ele **não cria linha de compra** e **não fala com o
site**: nada aconteceu, então nada precisa ser registrado como se tivesse
acontecido.

### 17.2 Timeouts, e o que cada um protege

| Onde | Valor | Protege de |
|---|---|---|
| `SITE_TIMEOUT_MS` | **5 s** | um site que pendura (`authenticateAgent` é `async` sem try/catch) travar o menu do jogador — **e o plugin liberar o botão com a compra em voo** |
| beacon | o mesmo `SITE_TIMEOUT_MS` | um beacon lento segurar o relógio |
| pull de entregas | o mesmo | uma página lenta empilhar rodadas |
| `#running` em cada relógio | — | duas rodadas concorrentes do mesmo laço |
| `claimForSettle` (`settling_at`) | 5 min | o relógio e o botão agirem sobre a **mesma** compra (§11.4) |
| `SETTLE_MIN_AGE_MS` | 90 s | reconciliar dentro da janela da entrega dupla |
| `SETTLE_MAX_ATTEMPTS` / `SETTLE_MAX_AGE_MS` | 60 / 6 h | o settler virar um gerador de carga contra um pedido que nunca passa (§11.1) |
| `SETTLE_BATCH` | 50 | saturar o Postgres do site num canal sem rate-limit |
| `IN_FLIGHT_WINDOW_MS` | 5 min | o mesmo jogador abrir duas compras (§17.6, regra 6) |

####  O ORÇAMENTO DA COMPRA, COMO SOMA  ####

O único número que **este** documento escolhe é o `SITE_TIMEOUT_MS`. Os outros
são dados, e o teto é do plugin:

```
   plugin (8 000 ms, OrigemZUI.cs:183)
 = RCON ida+volta (~200)
 + SITE_TIMEOUT_MS (5 000)      <- o único que escolhemos
 + entrega: give/spawn (~1 000)
 + resposta ao plugin (~200)
 + folga (~1 600)
```

**Mexer numa parcela obriga a recalcular as outras.** É por isso que o número do
plugin aparece com arquivo e linha em três lugares deste documento, e nunca de
cabeça: o dia em que alguém subir `RequestTimeoutSeconds` para 12 s sem mexer
aqui é o dia em que a folga vira 5 600 ms desperdiçados; o dia em que alguém o
baixar para 6 s sem mexer aqui é o dia em que toda compra lenta vira cobrança
dupla.

**Sem retry dentro do clique.** Uma tentativa por chamada no caminho da compra; o
retry mora nos relógios. Um retry ali estouraria o orçamento acima e
transformaria um site lento num menu travado — e, pior, num botão liberado.

### 17.3 A allowlist

`core/src/http/ip-allowlist.ts` e `core/src/http/network-guard.ts` existem no
código e **não estão montados em lugar nenhum** — o único import de
`ip-allowlist` é o próprio `network-guard.ts`, e `AGENT_ALLOWED_IPS` /
`AGENT_ALLOWED_HOSTS` não são lidos por `config.ts`. `Docs/04-PLANO-DE-MIGRACAO.md`
os marca como cópia de outro projeto.

**Este documento não os liga**, e a razão é o desenho: no modelo de pull **nada
entra** do site, então não há origem externa a filtrar. A porta do agente
continua em `127.0.0.1` e continua protegida por `AGENT_API_TOKEN` e pela sessão
do painel.

####  DO OUTRO LADO, ELA DEIXA DE SER LETRA MORTA  ####

`agents.ipAllowlist` é gravada pelo site e, **hoje**, nunca lida por ele. Isso
muda: o manual do site liga o guard `assertAllowedIp` nas **rotas novas** —
`/ozcoins/transaction`, `/deliveries/pending`, `/deliveries/ack`, `/shop/mirror`
e `/shop/mirror/version` —, com `403 AGENT_IP_NOT_ALLOWED`. Lista vazia continua
significando "sem restrição".

**O que isso obriga o agente a fazer**, e sem o quê o desenho fica pior do que
estava:

1. `AGENT_IP_NOT_ALLOWED` entra em `PAIRING_CODES` (§8.3). **Já entrou** — a
   linha está lá, com o comentário do porquê. Sem ela o código cairia no ramo
   final do `#classify`, viraria `rejected` — *"defeito nosso, nunca repetir"* —
   e cada compra tentada fecharia como `failed`, uma por uma, sem retentativa e
   sem alarme de pareamento. **A ordem importa e é contrato:** este código
   precisa estar aqui **antes** de a allowlist ser ligada em qualquer servidor. O
   §13.2 do manual do site registra a mesma dependência do lado de lá — ela era o
   terceiro argumento dele contra ligar a allowlist na fase 1, e caiu; os outros
   dois (IP residencial dinâmico, e o `/ozcoins/debit` de fora do guard)
   continuam de pé.
2. Ele entra na tabela do §4.2 como `unavailable` / `pairing`.
3. `lastBeaconErrorCode` no `GET /api/site/status` (§9.6) mostra o código cru,
   para "o IP saiu da lista" não virar mais uma causa indistinguível das outras.

**E há uma incoerência do outro lado que este documento registra sem poder
consertar:** a allowlist guarda só as rotas **novas**. O `/ozcoins/debit` é
antigo e fica de fora. Numa troca de IP residencial — o cenário que o próprio
manual do site adverte —, o agente **continua cobrando** e para de conferir: a
fila de entregas e a reconciliação de `charge-unknown` morrem em silêncio. Cobrar
sem conferir é a pior metade das duas. A recomendação, escrita para quem decidir
do lado de lá: ou o guard vale para **todas** as rotas do agente, ou não vale
para nenhuma na fase 1.

Se o dono escolher o caminho de push (§22, pergunta 3), montar os dois guards
**locais** (`ip-allowlist.ts` e `network-guard.ts`) passa a ser pré-requisito, e
aí eles saem do limbo.

### 17.4 O que nunca sai da máquina

| Segredo | Onde vive | Sai? |
|---|---|---|
| `AGENT_API_TOKEN` | `.env` do agente | **nunca**. O site não o recebe, não o guarda e não o usa |
| `PANEL_PASSWORD_HASH` | `.env` | nunca |
| senha de RCON | `Configs\<id>.ini` | nunca |
| `RUSTMAPS_API_KEY` | `.env` | só no header `X-API-Key` do rustmaps.com |
| `SITE_TOKEN` | `.env` | **só** no header `Authorization` das chamadas ao site, e como chave do HMAC do beacon (nunca em claro) |

`GET /api/site/status` responde **se** há token, nunca **qual**. E o `redact` do
logger (`REDACTED_PATHS`, `core/src/logger.ts:20-30`) já censura `token`,
`authorization` e `headers.authorization` — os headers do `SiteClient` caem nessa
rede. Confira que o campo novo se chame `token` ou `authorization`, e não algo
fora da lista.

####  O RAIO DE UM BEARER VAZADO  ####

Isto precisa estar escrito, porque nenhum dos dois manuais o dizia e a superfície
cresce com o Rust entrando.

**`X-Server-Id` NÃO é autorização.** O `applyOzMutation` do site recebe o
`serverId` apenas para **gravar** na linha do ledger; ele não escopa nada por
servidor. Na prática: **qualquer agent com bearer válido — o do DayZ, o do Conan,
o de outro servidor de Rust — pode debitar ou creditar QUALQUER `steamId` por
QUALQUER valor.** O `serverId` é rastreabilidade, não permissão.

O que decorre disso, e é operação, não teoria:

| Regra | Por quê |
|---|---|
| o bearer do Rust é **rotacionado separadamente** | ele não compartilha destino com o do DayZ |
| **nunca** reusar bearer entre servidores | um vazamento vira N servidores |
| `agents.bearer_enc` é segredo de **nível ledger**, não de nível servidor | o raio dele é `users.ep_balance` inteiro |
| um bearer vazado é **incidente de dinheiro**, não de configuração | a resposta é imediata |

**Como invalidar, e a ordem importa.** `POST /api/agent/invalidate` exige o
bearer **atual** — se ele vazou **e** o atacante já o rotacionou, essa porta está
fechada para o dono. O caminho que resta é apagar o pareamento pelo admin do site
(`DELETE .../agent`) e reativar o agente do zero, colando um `SITE_TOKEN` novo. É
o §20.5 inteiro de novo, e é por isso que ele está escrito passo a passo.

Fechar o escopo de verdade — restringir `/ozcoins/*` ao conjunto de jogadores
vistos naquele `serverId` — mudaria DayZ e Conan junto, e por isso é pergunta ao
dono (§22), não decisão deste documento.

### 17.5 O 403 que parece ban e não é

Duas famílias de 403 chegam do site, e tratá-las igual custou horas de
diagnóstico no painel do Conan:

| Corpo | Significa | O agente faz |
|---|---|---|
| JSON `{ error: 'agent banido', banId, reason, bannedAt }` | ban de verdade, por IP ou MAC | **para de beaconar** e mostra o motivo |
| TEXTO PURO contendo `error code: 1010` | a **borda** recusou o `User-Agent` | continua, com `SITE_USER_AGENT` próprio, e mostra o aviso |
| JSON `{ error, error_code: 'AGENT_NOT_ACTIVE' }` | falta o humano ativar no site | `pending`: loja indisponível |
| JSON `{ error: 'Operação não permitida' }`, sem código | um campo proibido no corpo (D17) | `rejected`: defeito nosso |

Por isso o `SiteClient` guarda **o texto** da resposta, e não só o status.

### 17.6 O que o agente nunca faz com o dinheiro

Seis regras, e nenhuma tem exceção:

1. **Nunca gera um `referenceId` novo para uma compra que já foi tentada.** Se o
   site disse 409 com `charged`, o dinheiro saiu — um id novo cobraria de novo.
2. **Nunca repete um débito com o mesmo corpo depois de um `rejected`.**
3. **Nunca estorna a partir de `charge-unknown`.** Sem prova de cobrança, um
   crédito cria dinheiro.
4. **Nunca reentrega às cegas.** `debited` parado há mais de 5 minutos vai para
   conferência humana, não para um segundo `origemz.give`.
5. **Nunca deduz o saldo do desfecho.** Ele é **relido** do dono do saldo — é o
   que `core/src/game/ui-store-bridge.ts:217-220` já manda fazer, e ficou mais
   verdadeiro agora que outra compra pode ter acontecido no site no meio. Isso
   vale em dobro para um `ok` com `replayed: true`: ali o `balance` é o saldo
   **no momento da cobrança original** (`String(tx.afterBalance)` da linha
   gravada, `ozCoinsMutation.ts:92-103`), que pode ser de horas atrás. Ele serve
   para conferência, nunca para a tela.
6. **Nunca abre uma segunda compra para o mesmo `(serverId, steamId)`** enquanto
   houver linha em `pending`, `debited` ou `charge-unknown` com menos de 5 min.

####  A REGRA 6 É A QUE FALTAVA, E ELA É A PERDA MAIS COMUM  ####

O `referenceId` responde *"esta MESMA tentativa já saiu?"*. Ele **não** responde
*"este jogador já pagou por isto?"* — e o documento chegou a vendê-lo como se
respondesse (D3: *"dois cliques cobrariam duas vezes"*). Não é verdade: cada
tentativa gera um `purchaseId` novo (`core/src/store/service.ts:163-165`) e,
portanto, uma chave nova. Duas tentativas do mesmo jogador pelo mesmo item são
**duas cobranças perfeitamente idempotentes**, cada uma na própria chave.

A única barreira que existia era o `PendingBuyId` do plugin — e o `FailBuy` dele
a solta no timeout (`Plugins/OrigemZUI.cs:2075`), com a primeira compra ainda em
voo. Some a isso o `SITE_SETTLE_FALLBACK_REDEBIT` (§11.5) e o mesmo jogador pode
ser cobrado **três vezes** pelo mesmo item: a compra travada em `charge-unknown`,
a recompra manual, e o redébito do settler.

A trava vive em `StoreService.buy`, antes de `createPurchase` (§14.11c) — não na
borda HTTP e não no plugin, pela mesma razão do teto de OZ: os dois são
contornáveis, e o serviço não.

---

## 18 — Observabilidade

### 18.1 A régua de nível

Mensagem de log em **inglês**; comentário e texto de tela em português — é a
regra escrita em `core/src/logger.ts:4-5`. E `toError(value)`
(`core/src/util.ts:13-21`) antes de mandar qualquer `catch` ao logger.

| Nível | Quando | Exemplos desta integração |
|---|---|---|
| `error` | dinheiro parado, ou defeito de contrato | `compra PRESA`, `site refused the charge` (409), `charge stuck for human review` |
| `warn` | o mundo não colaborou, e há conserto automático | `charge outcome is unknown`, `site wallet did not answer the balance`, `beacon failed`, `catalog mirror push failed` |
| `info` | mudança de estado que alguém quer ver | `wallet source chosen`, `site pairing became active`, `delivery pulled from site`, `catalog mirror accepted` |
| `debug` | rotina, alto volume | `beacon ok`, `delivery queue empty`, `catalog version unchanged` |

**Um beacon que dá certo é `debug`, não `info`.** A cada 10 s, `info` afogaria o
log em seis linhas por minuto que ninguém lê — e afogar o log é o mesmo que não
ter log.

**A exceção herdada, e ela fica.** `logger.error('compra PRESA: debitada, não
entregue e não estornada')` (`core/src/store/service.ts:448-451`) está em
português, contra a régua. Ela é **anterior** à régua e o suporte já a procura
assim: trocá-la agora quebraria o `grep` de quem está de plantão. Ela continua, e
ganha o `reference` no objeto de log (§12.4). **Toda linha NOVA desta integração é
em inglês** — as da tabela acima são.

### 18.2 Os campos obrigatórios

Toda linha que fala de dinheiro carrega, no objeto:

```ts
{ purchaseId, reference, steamId, serverId, total }
```

**`reference` é o campo que não pode faltar.** Sem ela, ninguém acha a linha
correspondente no ledger do site, e a conciliação vira busca por horário.

Toda linha que fala de entrega carrega:

```ts
{ deliveryId, steamId, serverId, kind, sourceRef }
```

`sourceRef` é o `itemRef` do site: é ele que cruza os dois lados na hora em que
alguém pergunta "o site diz que entregou; entregou mesmo?".

**Nunca logue:** `SITE_TOKEN`, o header `Authorization`, o corpo inteiro de uma
resposta do site (ele pode carregar saldo de terceiro num 409 mal formado).

### 18.3 Como saber que a integração está viva

Em ordem de custo, do mais barato ao mais caro:

1. **`GET /api/site/status`** — a única tela que separa as três causas do mesmo
   sintoma. Se `paired: true` e `status: 'active'`, o pareamento está de pé.
2. **`lastBeaconAt`** com menos de 30 s. Mais que isso: ou o relógio parou, ou o
   site não responde — e `lastBeaconError` diz qual.
3. **`wallet.lastOkAt`** — a última vez que uma chamada de carteira voltou 2xx.
   Ele é o que distingue "o beacon vai mas o token não serve" de "tudo bem".
4. **`purchases.chargeUnknown`** — deve ser **0** em regime. Um número que sobe e
   não desce significa que o settle não está resolvendo: ou a rota de prova não
   existe, ou o site não responde.
5. **`deliveries.indeterminate`** — deve ser **0**. Cada unidade aqui é uma
   entrega que ninguém sabe se aconteceu, e ela **não se resolve sozinha**. Ela
   já foi ACKada como `deferred` + `AGENT_INDETERMINATE`, e o site a moveu para
   `review`, então o item está preservado em `processing` dos dois lados — mas
   continua esperando gente.
6. **`purchases.pendingOrphan`** e **`purchases.unprovable`** — os dois devem ser
   **0**. O primeiro é uma compra que morreu antes do débito; o segundo é uma que
   saiu do laço de reconciliação por teto. Nenhum dos dois some sozinho.
7. **`catalog.mirroredVersion === catalog.version`** — iguais, o painel do site
   mostra a loja de agora.

### 18.4 Os alarmes que valem a pena (eram oito; sete seguem de pé)

| Alarme | Condição | Por quê |
|---|---|---|
| **compra presa** | `state='failed'` com `error` começando em `REFUND_RETRYABLE` ou `REFUND_REJECTED` | pagou, não recebeu, não estornou |
| **indeterminada velha** | `charge-unknown` com mais de 10 min | o settle não está conseguindo decidir |
| **saiu do laço** | `state='failed'` com `error` começando em `CHARGE_UNPROVABLE`, ou `debited` com `PLAN_MISSING` | o relógio desistiu (§11.1); só sai daí pela mão de alguém |
| **compra órfã** | `state='pending'` com mais de 5 min | o agente morreu entre a criação e o débito — e o dinheiro pode ter saído (§11.3) |
| **entrega indeterminada** | `deliveries.indeterminate > 0` | precisa de gente, e não some sozinha |
| **pareamento caído** | `status !== 'active'` por mais de 5 min | a loja está indisponível e o jogador não sabe por quê. `lastBeaconErrorCode` diz **qual** das sete causas |
| **defeito de contrato** | o site respondeu `INVALID_ACK_STATUS`, `INVALID_ACK_BODY` ou `SHOP_GAME_NOT_SUPPORTED`, **ou** um `INVALID_CURSOR` apareceu duas vezes na mesma rodada | nenhum destes se conserta esperando, e todos são silenciosos: o `INVALID_ACK_STATUS` derruba **50 desfechos de uma vez** e as tarefas simplesmente continuam `pending` do outro lado, como se o agente nunca as tivesse visto (§5.8) |
| ~~**`kind: 'vip'` veio da fila**~~ | — | **DESARMADO em 04/09/2026.** Ele valia enquanto `rust_vip` estava fora dos quatro mapas de entrega do site: um `vip` na fila só podia ser cadastro mexido **sem** o reconciliador junto. O site registrou o reconciliador e ligou o resgate (§5.7, `Docs\25` e `Docs\26` §3) — a tarefa `vip` virou operação normal, e mantê-lo tocaria todo dia. Alarme que toca todo dia é o que ninguém mais lê |

O contador `stats.stuck` (`core/src/db/store-repository.ts`) passa a somar
`failed` **e** `charge-unknown` (§14.12). Uma indisponibilidade prolongada da
carteira infla esse número — hoje `WALLET_UNAVAILABLE` grava `failed`, e com os
cinco desfechos separados o número passa a significar de verdade "coisas que
precisam de gente".

---

## 19 — Testes

### 19.1 O molde da casa

- **Vitest**, `npm test -w core`, arquivos em `core/test/**/*.test.ts`.
- **Banco em memória com o schema REAL**: `openDatabase({ file: MEMORY_DATABASE })`
  + `runMigrations(db)`. Zero mock de SQL.
- **`describe`/`it` em português**, dizendo o comportamento, não o método.
- **Nada de `vi.fn` / `vi.mock`.** Dublês são objetos literais escritos à mão —
  `fakeRcon` (`core/test/store.test.ts:66-97`), `brokenWallet` (`:305-311`).
- **`fetch` é dublado por INJEÇÃO, nunca por monkey-patch do global**:
  `fakeFetch(responses)` devolvendo `{ impl, calls }`, passado como `fetchImpl`
  (`core/test/rustmaps.test.ts:75-103`, `:148-150`).
- **Nenhum teste sai da máquina.** Um teste que depende de um serviço de fora
  falha no CI por um motivo que não é o dele.
- **Relógio e gerador de id injetados**: `now: () => NOW`, `newId` determinístico
  (`core/test/store.test.ts:152-161`).

### 19.2 Os casos que PRECISAM existir

**`core/test/site-wallet.test.ts` — o protocolo de dinheiro** (18 casos):

| # | Caso | O que ele prova |
|---|---|---|
| 1 | 200 `success:true` → `ok`, com `balance` lido de `moedas` **string** | D7 e D8 |
| 2 | 200 `idempotent:true` → `ok` com `replayed:true` e `transactionId: null` | replay não é entrega |
| 3 | 200 sem `success` → **`unknown`**, nunca `ok` | um 200 ilegível pode ter cobrado |
| 4 | 422 → `insufficient`, com a **frase do site** em `message` | D6 e §7.3 |
| 5 | 409 `REFERENCE_ID_AMOUNT_MISMATCH` com `charged` → `rejected` com `charged` | D6 |
| 6 | 400 sem `error_code` → `rejected`, **não** `unavailable` | D10 |
| 7 | 401 `BEARER_MISMATCH` → `unavailable` / `pairing` | D11 |
| 8 | 403 `AGENT_NOT_ACTIVE` → `unavailable` / `pairing` | D11 |
| 9 | 403 texto com `error code: 1010` → `unavailable` / `network`, **não** ban | §17.5 |
| 10 | 500 → **`unknown`** | D12 |
| 11 | `AbortError` (timeout) → **`unknown`** | D12 |
| 12 | `getBalance` que falha → `balance: null`, **nunca 0** | D13 |
| 13 | 422 **com** `balance`/`required`/`missing` → o `balance` do desfecho é o do site | §5.4, ajuste 4 |
| 14 | 422 **sem** eles → `balance: null`, **nunca 0** | D13, e o §21.2 |
| 15 | `403 AGENT_IP_NOT_ALLOWED` → `unavailable` / `pairing`, e `onPairingSuspect` é chamado **uma** vez | §17.3 |
| 16 | `400 CODIGO_QUE_NAO_EXISTE` → `unavailable` / `network`, **nunca** `rejected` | §4.2, observação 4 |
| 17 | `proveCharge` com `400 INVALID_REFERENCE_ID` → `unprovable`; com `404 REFERENCE_NOT_MINE` → **`unprovable`** (terminal, nunca `unknown`); só `404 REFERENCE_NOT_FOUND` → `not-charged` | §5.6 e §11.4 |
| 18 | `proveCharge` com `500 TRANSACTION_LOOKUP_FAILED` → **`unknown`**, e a compra **continua** em `charge-unknown` — nunca `unprovable`, que é terminal e mandaria para conferência humana o que a volta seguinte resolve | §5.6 e §4.2 |

**`core/test/site-reference.test.ts` — a convenção** (5 casos):

| # | Caso |
|---|---|
| 1 | `buildReference('pvp1','loja','p1')` = `rust:pvp1:loja:p1` |
| 2 | chave que estoura 113 chars vira `sha256(chave)[:32]`, e o **prefixo continua inteiro** |
| 3 | o hash é **determinístico**: duas chamadas com a mesma chave dão a mesma referência |
| 4 | `refundReferenceOf(ref)` = `<ref>:refund`, e o total nunca passa de 120 |
| 5 | uma referência de 113 chars mais `:refund` dá exatamente 120 |

**`core/test/store-charge.test.ts` — a compra com os cinco desfechos** (10 casos):

| # | Caso | O que ele prova |
|---|---|---|
| 1 | `unknown` no débito → `state='charge-unknown'`, **nenhum `origemz.give`**, **nenhum crédito** | §4.3 |
| 2 | `rejected` no débito → `state='failed'`, `error` contém o código, nada entregue | §4.4 |
| 3 | `over-limit` → **nenhuma linha de compra criada** e **nenhuma chamada ao site** | §17.1 |
| 4 | o débito leva `productId = offer.id` e `reference` no formato do §6 | D14 e D4 |
| 5 | o estorno usa `<ref>:refund`, e **nunca** a referência da compra | §12.2 |
| 6 | corrida: duas compras do mesmo milissegundo geram referências diferentes | o índice único da 035 |
| 7 | replay: o mesmo `referenceId` mandado duas vezes debita **uma** vez | idempotência **da chave** |
| 8 | `ready()` devolvendo `false` → `store-unavailable`, **sem ler a oferta** e sem chamar a carteira; a frase **não** contém "saldo" | §9.5, §21.4 |
| 9 | segundo `buy` do mesmo jogador com compra aberta → `already-in-flight`, **nenhuma linha nova** | §17.6, regra 6 |
| 10 | `offer.id` de 101 chars → o débito sai **sem** `productId` | §5.4 |

**`core/test/site-deliveries.test.ts` — a fila** (16 casos):

| # | Caso |
|---|---|
| 1 | jogador offline → ACK `deferred`, **nenhum comando**, **nenhuma reserva** |
| 2 | presença `null` (RCON fora) → ACK `deferred` com `PRESENCE_UNAVAILABLE` |
| 3 | jogador online → reserva **antes** do comando, entrega, ACK `delivered` |
| 4 | tarefa já `delivered` localmente → ACK de novo e **nenhum comando** |
| 5 | tarefa órfã em `reserved` → vira `indeterminate`, ACKa **`deferred` + `reason: 'AGENT_INDETERMINATE'`** e **não reexecuta** |
| 6 | payload fora do vocabulário → ACK `failed` com `PAYLOAD_INVALID`, sem comando — **um caso por régua** do §5.7 |
| 7 | `unknown` com a linha local `delivered` → a linha **fica**; com `reserved` → vira `expired` |
| 8 | `ApiError('RCON_UNAVAILABLE', <frase em português>)` → ACK **`deferred`**, e não `failed` |
| 9 | `planOfPayload` de um `kit` de 3 itens → `units: 1`, e três `origemz.give` com o `amount` exato |
| 10 | fixture com `"id": "DLV-9f3a1c2b7e04"` e `"sourceRef": "ITM-4b81c9e2a017"` — os formatos que o site **realmente** emite |
| 11 | **nenhum ACK do lote carrega `status` fora de `delivered\|failed\|deferred`** — o teste inspeciona o corpo enviado ao dublê do `SiteClient`. Um quarto valor vale 400 `INVALID_ACK_STATUS` para o LOTE INTEIRO no site, e derruba as outras 49 entregas (§5.8) |
| 12 | `VEHICLE_NO_SPACE` (o `NO_SPACE` do plugin com o prefixo do `#deliver`) → ACK **`deferred`**; qualquer outro `VEHICLE_*` → ACK `failed`. É a linha da lista fechada que o manual do site chegou a negar (§23.4) |
| 13 | página com `next: "DLV-…"` → a rodada pede a **segunda** página com `?cursor=DLV-…`; página com `next: null` → **exatamente um** `GET`. O teste conta as chamadas do dublê, não o efeito |
| 14 | **300 tarefas `deferred`, 50 por página** → a rodada varre **5** páginas e para; a rodada **seguinte** começa em `?cursor=<o next da 5ª>`, e **não** do topo. É o teste que prova que a tarefa nº 251 é vista (§5.7) |
| 15 | `400 INVALID_CURSOR` → a rodada refaz a página **sem `cursor`**, **uma** vez; um segundo `INVALID_CURSOR` na mesma rodada **encerra a rodada** — o teste falha se o mesmo cursor recusado sair duas vezes no dublê |
| 16 | `wake()` depois de uma rodada que parou no teto → o `GET` sai **sem `cursor`**. E um ACK que volta `400 INVALID_ACK_BODY` ou `500 ACK_FAILED` **não carimba `acked_at`** em linha nenhuma: o lote inteiro volta na rodada seguinte (§5.8) |

**`core/test/settle.test.ts` — a reconciliação** (9 casos):

| # | Caso |
|---|---|
| 1 | prova 200 `found:true` → `debited`, entrega e fecha `delivered` |
| 2 | prova 404 → `failed` com `CHARGE_NEVER_HAPPENED`, **sem cobrar nada** |
| 3 | prova indisponível → `outcome: null` e a compra **segue** em `charge-unknown` |
| 4 | compra com menos de 90 s **não entra** na varredura; `debited` com menos de 5 min também não |
| 5 | `failed` com `REFUND_RETRYABLE` → repete o crédito com a **mesma** chave; com `REFUND_REJECTED` → **não** entra |
| 6 | **duas chamadas concorrentes** de `settle` sobre a mesma compra produzem **uma** entrega |
| 7 | `pending` com mais de 5 min entra; com `reference` nula, fecha como `CHARGE_UNKNOWN_NO_REFERENCE` |
| 8 | depois de `SETTLE_MAX_ATTEMPTS`, a compra **sai** da varredura e vira `CHARGE_UNPROVABLE` |
| 9 | prova 200 com `delivery IS NULL` → `PLAN_MISSING`, **sem entregar nada** |

**`core/test/store.test.ts` — o que já existia** (alterado, §14.24):

| # | Caso |
|---|---|
| — | `brokenWallet` passa a devolver `{ status:'ok', balance:500, transactionId:null, replayed:false }`. É a **única** coisa que impede o `npm test -w core` de ficar verde na fase 2 |

### 19.3 Um teste escrito por inteiro

```ts
// ============================================================
//  site-wallet.test.ts  -  o protocolo de dinheiro, SEM INTERNET.
//
//  Todo `fetch` deste arquivo é um dublê. Nenhuma linha aqui sai da
//  máquina — um teste que depende de um serviço de fora falha no CI
//  por um motivo que não é o dele, e passa a atestar a saúde alheia
//  em vez do nosso código. Ver core/test/fixtures/LEIA-ME.md.
//
//  O que este arquivo guarda:
//
//    1. o saldo do site vem como STRING, e vira número inteiro;
//    2. 200 sem `success` é `unknown` — nunca `ok`;
//    3. 422 é SALDO INSUFICIENTE, e a frase mostrada é a DO SITE;
//    4. 409 é REUSO DE REFERÊNCIA, e `charged` diz que o dinheiro
//       já saiu — o contrário do que a carteira antiga assumia;
//    5. 400 é defeito NOSSO: `rejected`, e não algo a repetir;
//    6. 401/403 de pareamento não são "site lento";
//    7. timeout e 5xx são `unknown`: PODE TER COBRADO;
//    8. saldo que não deu para ler é `null`, e nunca zero.
// ============================================================

import { describe, expect, it } from 'vitest';

import { SiteClient } from '../src/site/client.js';
import { createLogger } from '../src/logger.js';
import { SiteWallet } from '../src/store/site-wallet.js';

const STEAM_ID = '76561198000000000';
const SERVER_ID = 'RUST01';
const REFERENCE = `rust:${SERVER_ID}:loja:p1`;

const silent = createLogger({ log: { level: 'silent', pretty: false } });

/** O que o dublê de `fetch` devolve numa chamada. */
interface Canned {
  readonly status: number;
  readonly body?: unknown;
  /** Corpo em TEXTO PURO — é como a borda do site responde o 1010. */
  readonly text?: string;
  /** Estourar em vez de responder: é o "sem rede" e o timeout. */
  readonly throws?: Error;
}

interface FakeFetch {
  readonly impl: typeof globalThis.fetch;
  readonly calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[];
}

/**
 * O `fetch` de mentira.
 *
 * Recebe a fila de respostas na ordem em que devem sair; a última se
 * repete, para o teste não ter de contar quantas chamadas houve.
 */
function fakeFetch(responses: readonly Canned[]): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  let at = 0;

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const canned = responses[Math.min(at, responses.length - 1)] ?? { status: 500 };

    at += 1;

    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });

    if (canned.throws !== undefined) {
      return Promise.reject(canned.throws);
    }

    if (canned.text !== undefined) {
      return Promise.resolve(
        new Response(canned.text, {
          status: canned.status,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    }

    return Promise.resolve(
      new Response(canned.body === undefined ? null : JSON.stringify(canned.body), {
        status: canned.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

function walletWith(responses: readonly Canned[]): { wallet: SiteWallet; fetch: FakeFetch } {
  const fetch = fakeFetch(responses);

  const wallet = new SiteWallet({
    client: new SiteClient({
      baseUrl: 'https://site.example',
      token: 'tok',
      serverId: SERVER_ID,
      userAgent: 'OrigemZ-Rust-Agent/teste',
      logger: silent,
      fetchImpl: fetch.impl,
    }),
    logger: silent,
  });

  return { wallet, fetch };
}

/** O corpo do débito, sem o que muda entre os testes. */
function debitInput(): Parameters<SiteWallet['debit']>[0] {
  return {
    steamId: STEAM_ID,
    amount: 250,
    reference: REFERENCE,
    reason: 'Loja in-game: Kit Metal x1',
    productId: 'kit-metal',
  };
}

describe('o débito', () => {
  it('lê o saldo que vem como STRING e devolve inteiro', async () => {
    const { wallet, fetch } = walletWith([
      {
        status: 200,
        body: {
          success: true,
          steamid: STEAM_ID,
          moedas: '250',
          before: '500',
          after: '250',
          amount: '250',
          direction: 'debit',
          transactionId: 918273,
        },
      },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('ok');

    if (change.status === 'ok') {
      // `moedas`, e não `balance`: o campo que a carteira antiga lia
      // não existe em resposta nenhuma do site.
      expect(change.balance).toBe(250);
      expect(change.replayed).toBe(false);
      expect(change.transactionId).toBe('918273');
    }

    // O corpo tem de levar `referenceId` (não um header
    // `Idempotency-Key`) e `productId`; e `reason` vira `observacao`.
    expect(fetch.calls[0]?.url).toBe('https://site.example/api/agent/ozcoins/debit');
    expect(fetch.calls[0]?.body).toEqual({
      steamId: STEAM_ID,
      amount: 250,
      referenceId: REFERENCE,
      observacao: 'Loja in-game: Kit Metal x1',
      productId: 'kit-metal',
    });
    // Sem `X-Server-Id` toda chamada morreria em 400 MISSING_SERVER_ID.
    expect(fetch.calls[0]?.headers['X-Server-Id']).toBe(SERVER_ID);
  });

  it('200 sem "success" é INDETERMINADO, e nunca sucesso', async () => {
    // Um 200 que não dá para entender PODE TER COBRADO. Ler isto como
    // `ok` entregaria o item sem saber se o dinheiro saiu.
    const { wallet } = walletWith([{ status: 200, body: { ok: true } }]);

    expect((await wallet.debit(debitInput())).status).toBe('unknown');
  });

  it('422 é saldo insuficiente, e a frase mostrada é a DO SITE', async () => {
    const message = 'Saldo insuficiente. Voce tem 0 OZ, o item custa 250 OZ (faltam 250).';
    const { wallet } = walletWith([{ status: 422, body: { error: message } }]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('insufficient');

    if (change.status === 'insufficient') {
      // Crua: o jogador lê a conta que o DONO DO SALDO fez.
      expect(change.message).toBe(message);
    }
  });

  it('409 é reuso de referência — e "charged" diz que o dinheiro JÁ SAIU', async () => {
    // ####  ESTE É O DESFECHO QUE A CARTEIRA ANTIGA LIA AO CONTRÁRIO ####
    //
    // Ela tratava 409 como "saldo insuficiente". Aqui ele significa o
    // oposto: houve cobrança. Gerar um id novo cobraria de novo.
    const { wallet } = walletWith([
      {
        status: 409,
        body: {
          error: 'Esse referenceId já foi usado numa cobrança de 250 OZ…',
          error_code: 'REFERENCE_ID_AMOUNT_MISMATCH',
          charged: 250,
        },
      },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('rejected');

    if (change.status === 'rejected') {
      expect(change.code).toBe('REFERENCE_ID_AMOUNT_MISMATCH');
      expect(change.charged).toBe(250);
    }
  });

  it('400 de validação é defeito NOSSO, e não algo a repetir', async () => {
    const { wallet } = walletWith([
      { status: 400, body: { error: 'referenceId obrigatório (3..120 chars)' } },
    ]);

    // `unavailable` seria retentável, e o agente repetiria para sempre
    // um pedido que nunca vai passar — contra um canal sem rate-limit.
    expect((await wallet.debit(debitInput())).status).toBe('rejected');
  });

  it('401 de pareamento não é "site lento"', async () => {
    const { wallet } = walletWith([
      { status: 401, body: { error: 'Bearer não confere', error_code: 'BEARER_MISMATCH' } },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      // `pairing` é o que faz a loja dizer INDISPONÍVEL e o beacon
      // voltar a bater, em vez de o agente insistir em laço.
      expect(change.cause).toBe('pairing');
    }
  });

  it('403 da borda com "error code: 1010" NÃO é ban', async () => {
    const { wallet } = walletWith([
      { status: 403, text: 'error code: 1010' },
    ]);

    const change = await wallet.debit(debitInput());

    expect(change.status).toBe('unavailable');

    if (change.status === 'unavailable') {
      expect(change.cause).toBe('network');
    }
  });

  it('timeout e 5xx são INDETERMINADOS: pode ter cobrado', async () => {
    const abort = new Error('The operation was aborted');

    abort.name = 'AbortError';

    const timeout = walletWith([{ status: 0, throws: abort }]);
    const server = walletWith([{ status: 502, text: 'Bad Gateway' }]);

    // ####  O DESFECHO QUE HOJE NÃO EXISTE  ####
    //
    // Os dois viravam `unavailable`, a compra fechava como `failed` e
    // ninguém voltava a conferir. Como `unknown`, ela fica aberta e o
    // relógio da reconciliação a resolve com prova.
    expect((await timeout.wallet.debit(debitInput())).status).toBe('unknown');
    expect((await server.wallet.debit(debitInput())).status).toBe('unknown');
  });
});

describe('o estorno', () => {
  it('usa a referência da compra com ":refund", e nunca a mesma', async () => {
    // Com a MESMA chave, o site trataria o crédito como replay do
    // débito, responderia `idempotent: true` e NÃO creditaria — o
    // jogador ficaria sem o item E sem o dinheiro.
    const { wallet, fetch } = walletWith([
      { status: 200, body: { success: true, moedas: '500', direction: 'credit' } },
    ]);

    await wallet.credit({
      steamId: STEAM_ID,
      amount: 250,
      reference: REFERENCE,
      reason: 'Estorno: entrega falhou (INVENTORY_FULL)',
    });

    expect(fetch.calls[0]?.url).toBe('https://site.example/api/agent/ozcoins/credit');
    expect((fetch.calls[0]?.body as { referenceId: string }).referenceId)
      .toBe(`${REFERENCE}:refund`);
    // Estorno não é venda de catálogo: sem `productId`, ou o guard de
    // replay do site veria um crédito onde espera uma compra.
    expect(fetch.calls[0]?.body).not.toHaveProperty('productId');
  });
});

describe('o saldo', () => {
  it('quando não dá para ler, é null — e nunca zero', async () => {
    // Zero é uma AFIRMAÇÃO sobre o dinheiro de alguém. Com ele, o
    // modal esconde o botão de comprar e diz SALDO INSUFICIENTE a
    // quem tem dinheiro — o oposto do que a loja mandou fazer.
    const { wallet } = walletWith([{ status: 500, text: 'boom' }]);

    expect((await wallet.getBalance(STEAM_ID)).balance).toBeNull();
  });
});
```

### 19.4 O que os testes NÃO cobrem, e é honesto dizer

- **Nada foi rodado contra o site de verdade.** Todo teste deste documento fala
  com um dublê que devolve o que este documento diz que o site responde. O
  primeiro contato com o servidor real é a fase 0 do §20.
- **O plugin `OrigemZUI.cs` não é compilado por nenhum teste.** O caminho do
  clique é exercitado a partir de `StoreService.buy` para baixo.
- **A rota de prova e as de entrega não existem ainda no site.** Os testes de
  §11 e §10 exercitam o agente contra o contrato escrito aqui — se o site for
  entregue diferente, os testes passam e a integração falha. É o risco número um
  do apêndice.
---

## 20 — Ordem de implementação

### 20.1 A regra que ordena tudo

**Nada do que está nas fases 1 a 3 muda o comportamento de produção**, porque
`SITE_BASE_URL` continua vazia e o agente continua com a carteira local. A
primeira fase que muda alguma coisa para o jogador é a 4, e ela é uma variável de
ambiente e um restart.

E o **commit zero** de cada fase é o contrato: o tipo, o schema ou o cabeçalho
antes do código que os usa. É a regra do
`Docs/17-FRENTES-WIPE-E-MENSAGENS.md` §0.3, e ela existe porque duas pessoas que
combinam o contrato depois combinam duas coisas diferentes.

### 20.2 As fases

| Fase | O que entra | Muda produção? | Pronto quando |
|---|---|---|---|
| **0** | o contrato acordado com o dono do site: host de `/api/agent`, `serverId`, e as quatro rotas novas escritas do lado de lá | não | as §22.1, §22.2, §22.6, §22.10 respondidas; `curl` do §5.3 devolve 200 |
| **1** | `reference.ts`, `SiteClient`, `SiteWallet`, migrações 035 e 036, `config.site`, `.env.example` | **não** | `npm test -w core` verde, incluindo `site-wallet.test.ts` e `site-reference.test.ts` |
| **2** | os cinco desfechos: `WalletChange`, `PurchaseOutcome`, `StoreService.buy`, `DeliveryPlan`, o 202, o mapa de status, a trava de compra em voo, `core/test/store.test.ts` | **quase não** — ver a nota abaixo | `store-charge.test.ts` verde, `npm test -w core` verde; a loja local funciona igual |
| **3** | `SiteBeacon`, `GET /api/site/status`, `POST /api/site/beacon`, a tela do painel | **não** (só beacona) | `SITE_BASE_URL` preenchida sem token → status `pending`, `GET /api/players/:id/wallet` responde `source: 'local'` |
| **4** | `PurchaseSettler`, `StoreService.settle` e a rota `.../settle` | **não** (com a carteira local, `unknown` e `rejected` nunca acontecem) | uma compra forçada a `charge-unknown` num teste é resolvida sozinha em 90 s |
| **5** | **A VIRADA.** O admin ativa no site, cola `SITE_TOKEN`, reinicia | **SIM** | uma compra in-game debita no site e o extrato do jogador mostra a linha |
| **6** | `SiteDeliveries`, `SiteDeliveriesRepository`, o gancho de presença | sim | um resgate no site aparece no jogo em até 15 s |
| **7** | `CatalogMirror` | sim | o painel do site mostra a loja do Rust, e a `version` bate |

####  POR QUE O SETTLER VEM ANTES DA VIRADA  ####

Numa versão anterior desta tabela a VIRADA era a fase 4 e o `PurchaseSettler` era
a 5. **Havia uma janela entre elas em que ninguém resolvia uma compra presa.**
`charge-unknown` passa a ser produzido na fase 2 e é, por desenho, *"o único
desfecho que NÃO fecha a compra"* — nessa janela, um timeout deixaria o jogador
cobrado, sem item, com a compra aberta, **sem relógio e sem botão**. É exatamente
o cenário que os §4, §11 e §12 existem para eliminar.

O settler não custa nada antes da virada: com a carteira local, `unknown` e
`rejected` nunca acontecem, e a varredura roda a cada 60 s sobre zero linhas.

####  A FASE 2 MUDA PRODUÇÃO EM UMA COISA, E ELA É DE DINHEIRO  ####

A tabela dizia "não muda produção" e isso é verdade para os desfechos. Mas a fase
2 inclui `StoreService.buy`, e o teto `STORE_MAX_OZ_PER_PURCHASE` (default
100 000, §16.1) é aplicado **no agente**, antes de qualquer carteira. Uma loja que
hoje vende uma oferta cara — ou uma compra de 100 unidades de um item de 1 500 OZ
— passa a ser recusada com `over-limit` **no dia do deploy**, com a carteira
local, sem ninguém ter ligado nada.

**Confira antes de subir a fase 2:**

```sql
SELECT max(total_price) AS maior FROM store_purchases;
```

Se o maior já registrado passar de 100 000, escolha conscientemente: suba o teto
no `.env` ou aceite a recusa. O mesmo vale para a **trava de compra em voo**
(§17.6, regra 6): um jogador com uma compra travada em `failed` antigo não é
afetado, mas um em `pending` órfão de antes da 035 seria — e é por isso que a
varredura do §11.3 inclui `pending` desde a fase 4.

### 20.3 O que dá para ligar sem quebrar produção

Três degraus, e é bom subi-los um por vez:

**Degrau 1 — o agente fala, e não cobra.** `SITE_BASE_URL` preenchida,
`SITE_TOKEN` **vazio**. O agente beacona, aparece no admin do site como
`pending`, e a carteira continua **local**: nenhuma compra sai da máquina. Este
degrau prova a rede, o DNS, o TLS, o `User-Agent` e o `serverId` — quatro coisas
que erram no primeiro dia, e nenhuma delas custa uma compra.

**Isto só é verdade por causa de UMA linha do §14.15**, e ela é fácil de perder:
`siteWallet` só nasce quando `siteClient !== null` **e**
`siteClient.authenticated`. Sem a segunda metade, a carteira do site nasceria
junto com o cliente, todo débito sairia sem `Authorization`, tomaria 401
`MISSING_BEARER` → `unavailable`/`pairing`, e **a loja in-game ficaria morta para
todos os jogadores** durante o degrau que existe justamente para não custar nada.
O boot loga um `warn` dizendo isso em voz alta.

**Como conferir que o degrau está certo:** `GET /api/players/<steamId>/wallet`
responde `source: 'local'`, e `GET /api/site/status` responde
`status: 'pending'` com `hasToken: false`. Os dois juntos, ou o degrau não é
inócuo.

**Degrau 2 — o agente cobra, e não entrega o que veio do site.**
`SITE_TOKEN` colado, `SITE_DELIVERY_POLL_MS` sem efeito porque a fase 6 ainda não
existe. A loja in-game cobra no site. A fila fica para depois.

**Degrau 3 — o resto.** Reconciliação, fila, espelho.

### 20.4 A feature flag de rollback

**`SITE_BASE_URL=` (vazia) e reiniciar.** Isso é tudo.

O que acontece:

| O quê | Depois do rollback |
|---|---|
| a carteira | volta a ser a `LocalWallet`, sobre `wallets` |
| beacon, fila, settle, espelho | não são construídos |
| `GET /api/site/status` | responde `paired: false`, `status: 'unknown'` |
| compras em `charge-unknown` | **ficam paradas** — o settler não roda sem site, e `POST .../settle` responde `outcome: null` (ver abaixo) |
| entregas em `reserved` | ficam paradas. **Nunca foram ACKadas, então o site as expira** em `AGENT_DELIVERY_TTL_DAYS` e devolve o item a `available` — e o agente pode tê-las entregado. Ver §10.4 |
| entregas em `indeterminate` | **preservadas**: elas já foram ACKadas como `deferred` + `AGENT_INDETERMINATE`, o site as moveu para `review`, e ele não expira `review` |
| o saldo do jogador no jogo | volta a ser o do banco local, **que está congelado desde a virada** |

**A última linha é o custo real do rollback**, e ela precisa ser dita em voz
alta: o saldo local é o de antes da virada. Quem comprou OZ no site depois disso
verá o número antigo. Por isso o rollback é uma decisão de operação, não um
"desliga e liga" — e por isso ele não deve ficar mais de algumas horas ligado.

**O que `POST .../settle` responde depois do rollback.** Sem `SITE_BASE_URL`, o
§14.15 não constrói `SiteClient`, logo não constrói `SiteWallet`, logo
`StoreServiceDeps.proof` fica `undefined` — a rota existe e **não tem como
decidir nada**. Ela responde **200** com:

```json
{ "ok": true, "outcome": null,
  "message": "A integração com o site está desligada (SITE_BASE_URL vazia): não há como provar a cobrança." }
```

**200 e não 500**, e a razão é a mesma da rota de status: quem clica ali está
tentando entender o estado, e um 500 diria "quebrou" onde o certo é "desligado".

**Antes de esvaziar `SITE_BASE_URL`, drene.** Compras em `charge-unknown` e em
`debited` ficam sem quem as resolva, e entregas em `reserved` viram item
duplicado em 30 dias. O procedimento está no §20.6 — ele vale para o rollback
tanto quanto para a troca de `SITE_SERVER_ID`.

**O rollback parcial que existe e é barato:** `SITE_CATALOG_PUSH_ENABLED=0`
desliga só o espelho. A loja continua funcionando; o painel do site só para de
enxergá-la.

### 20.5 O que fazer no dia da virada, em ordem

0. Confira que a fase 4 subiu: `GET /api/site/status` responde
   `purchases.chargeUnknown` e a rota `POST .../settle` existe. **Sem as duas,
   não vire** — uma compra presa nesta noite não teria como ser resolvida.
1. `SITE_BASE_URL` e `SITE_SERVER_ID` no `.env`, `SITE_TOKEN` vazio. Reiniciar.
2. `GET /api/site/status` → `status: 'pending'`, `hasToken: false`, e
   `GET /api/players/<steamId>/wallet` → `source: 'local'`. Se vier `orphan`, o
   `Server` não existe no site com esse id: **pare aqui**.
3. No admin do site, ativar o agente e copiar o token. A rota é
   `POST /api/admin/rust/servers/:serverId/activate`, na aba **`rust-servers`**
   — **não** é o `/activate` genérico de agents, que exige `bearer` + `hmac` e
   faz um ping assinado no agente que o Rust não responde (e reverte em 502).

   ####  A JANELA ENTRE 3 E 4, E ELA ASSUSTA  ####

   O site liga `status: 'active'` **e** `requiresSignedBeacon: true` no mesmo
   update. A partir desse instante ele **exige beacon assinado** — e o agente
   ainda está sem `SITE_TOKEN`, então ainda manda sem assinatura (§9.4). Cada
   batida de 10 s nessa janela toma `401 BEACON_SIGNATURE_MISSING`,
   `lastBeaconAt` congela, e a tela do site mostra 🔴 SEM BEACON no minuto
   seguinte à ativação.

   **Isso é esperado e não é falha.** Mas o passo 4 tem de acontecer em **menos
   de 5 minutos**, ou o site passa a considerar o agente offline.
4. `SITE_TOKEN` no `.env`. Reiniciar — **antes de 5 minutos**.
5. `POST /api/site/beacon` → `status: 'active'`, `lastBeaconError: null`.
6. `GET /api/players/<steamId>/wallet` de um jogador conhecido → `source: 'remote'`
   e o saldo **do site**.
7. Uma compra de teste, com a oferta mais barata que existir, num jogador seu.
8. Conferir a linha no extrato do jogador no site: `observacao` legível,
   `reference_id` no formato do §6.
9. Só então avisar os jogadores.

---

### 20.6 Trocar o `SITE_SERVER_ID` (ou desligar) com compras abertas

**Não troque com compra aberta.** A referência é
`rust:<serverId>:loja:<purchaseId>` e o `serverId` dela é o de **quando a compra
foi feita**. Depois da troca, a rota de prova responde 404 para essas compras —
porque a conferência `tx.serverId === req.serverId` falha — e o settler
concluiria "nunca aconteceu" para cobranças **reais** (§5.6, §11.4).

O procedimento, em ordem:

1. **Pare de vender.** `SITE_CATALOG_PUSH_ENABLED=0` não basta; o jeito honesto é
   avisar e esperar, ou desabilitar as ofertas.
2. **Drene.** Espere `GET /api/site/status` responder
   `purchases.chargeUnknown: 0`, `purchases.pendingOrphan: 0` e
   `deliveries.reserved: 0`. Force com `POST .../settle` o que não sair sozinho.
3. **Resolva o que sobrou à mão.** Toda compra que ainda estiver aberta precisa
   de decisão humana **antes** da troca, com o extrato do site aberto ao lado.
4. **Só então** troque `SITE_SERVER_ID` e reinicie.
5. Depois da troca, o settler **recusa** concluir qualquer compra cuja
   `reference` carregue o `serverId` antigo: ela fecha com
   `CHARGE_UNPROVABLE: SERVER_ID_CHANGED` e alarma (§11.4). É a rede de
   segurança, não o plano.

**A caixa alta conta.** `rust01` e `RUST01` são dois `serverId` diferentes para o
site (§22.10), e trocar a caixa é trocar o id.

---

## 21 — Critérios de aceite

Uma lista verificável, item a item. Cada linha é uma coisa que dá para conferir
sem opinião.

### 21.1 Contrato e transporte

- [ ] Toda chamada **autenticada** leva `Authorization`, `X-Server-Id`, `Accept` e
      `User-Agent` — provado no teste, olhando `fetch.calls[0].headers`.
- [ ] **O beacon NÃO é uma delas**: ele sai sem `Authorization` e sem
      `X-Server-Id` (o `serverId` viaja no corpo), e com `X-Agent-Timestamp` e
      `X-Agent-Signature` quando há token.
- [ ] Nenhum corpo enviado contém `balance`, `ozBalance` ou `epBalance`.
- [ ] O header `Idempotency-Key` **não** é enviado ao site.
- [ ] `moedas` e `observacao` aparecem em **exatamente um** arquivo do RustAgent:
      `core/src/site/client.ts` (`grep -rn "moedas\|observacao" core/src` devolve
      só esse arquivo).
- [ ] `SITE_TIMEOUT_MS` é respeitado: uma resposta que demore mais vira
      `unknown`, e o teste prova com um `AbortError`.
- [ ] `SITE_TIMEOUT_MS + 2000 ≤ RequestTimeoutSeconds × 1000` — o orçamento do
      §16.2. Confira o número do plugin em `Plugins/OrigemZUI.cs:183`, não de
      cabeça.
- [ ] Nenhum arquivo novo chama o `fetch` global: todos aceitam `fetchImpl`.

### 21.2 O protocolo de dinheiro

- [ ] `WalletChange` tem **cinco** ramos, e o `switch` de `StoreService.buy` trata
      os cinco (o TypeScript prova: um ramo esquecido é erro de tipo).
- [ ] 422 → `insufficient`, e a frase mostrada ao jogador é **a do site**.
- [ ] 422 com `balance`, `required` e `missing` → o `balance` do desfecho é **o
      do site**; 422 sem eles → `balance: null`. **Nunca zero, nos dois casos.**
- [ ] 409 → `rejected`, **nunca** `insufficient`, e `charged` é preservado.
- [ ] 400 com código conhecido → `rejected`, **nunca** `unavailable`.
- [ ] **4xx com `error_code` DESCONHECIDO → `unavailable` / `network`**, nunca
      `rejected`. É a regra que salva o futuro (§4.2, observação 4).
- [ ] `403 AGENT_IP_NOT_ALLOWED` → `unavailable` / `pairing`, e o beacon é
      acordado por `onPairingSuspect`.
- [ ] 401/403/404 de pareamento → `unavailable` com `cause: 'pairing'`.
- [ ] Timeout e 5xx → `unknown`.
- [ ] Um 200 sem `success: true` → `unknown`.
- [ ] `getBalance` que falha → `balance: null`. O critério antigo era
      `grep -n "balance: 0" core/src/store/` não achar nada — e ele **reprovava o
      código deste próprio documento**, que gravava `balance: 0` no ramo 422 do
      `#classify`. O critério certo é o de cima, mais este:
      `grep -rn "balance: 0" core/src` não acha nada **fora de teste**.
- [ ] Um `ok` com `replayed: true` **não** alimenta a tela: o saldo mostrado ao
      jogador vem de um `getBalance` novo (§17.6, regra 5).

### 21.3 A compra

- [ ] `charge-unknown` **não entrega** e **não estorna**: o teste conta os
      comandos RCON e eles são zero.
- [ ] `charge-unknown` responde **202** em `POST /api/servers/:id/store/buy`.
- [ ] `over-limit` não cria linha em `store_purchases` e não chama o site.
- [ ] O débito leva `productId = offer.id`.
- [ ] O `referenceId` enviado casa `/^rust:[^:]{1,50}:loja:.{1,}$/` e tem no
      máximo 113 chars.
- [ ] O estorno usa `<ref>:refund` e **não** leva `productId`.
- [ ] Um segundo `buy` do mesmo `(serverId, steamId)` com uma compra aberta há
      menos de 5 min responde `already-in-flight`, **sem** criar linha e **sem**
      chamar a carteira (§17.6, regra 6).
- [ ] Um `offer.id` de mais de 100 chars **não** vai no `productId` — o débito
      sai sem o campo em vez de tomar `400 INVALID_PRODUCT_ID`.
- [ ] `store_purchases.reference` é gravada em toda compra feita com o site
      ligado, e o índice único da 035 impede duas iguais.
- [ ] `store_purchases.delivery` é gravada com o plano da entrega.

### 21.4 O pareamento

- [ ] Com `SITE_BASE_URL` vazia, o agente sobe exatamente como hoje: mesma
      carteira, mesmos logs, nenhum relógio novo.
- [ ] Com `SITE_BASE_URL` preenchida e `SITE_SERVER_ID` vazio, o boot **recusa**
      com uma `ConfigError` que diz o que fazer.
- [ ] Com `SITE_BASE_URL` terminando em `/api`, o boot **recusa**.
- [ ] Com dois servidores em `Configs\` e `SITE_LOCAL_SERVER_ID` vazio, o boot
      **recusa**, com os ids disponíveis na mensagem — e a checagem roda **depois**
      de `loadServers`, em `assertSiteBinding` (§14.14).
- [ ] Com **um** servidor e a variável vazia, o boot sobe e o id resolvido é o
      desse servidor.
- [ ] Com `SITE_LOCAL_SERVER_ID` apontando para um id que não existe em
      `Configs\`, o boot **recusa**.
- [ ] Com `SITE_BASE_URL` preenchida e `SITE_TOKEN` **vazio**,
      `GET /api/players/:id/wallet` responde `source: 'local'` e nenhum débito
      sai da máquina (§20.3, Degrau 1).
- [ ] Enquanto `status !== 'active'`, `StoreService.buy` devolve
      `store-unavailable` **antes** de ler a oferta, o HTTP é **503**, e o texto
      mostrado ao jogador **não** contém "saldo".
- [ ] Um 403 com corpo em texto contendo `error code: 1010` **não** para o
      beacon.
- [ ] Um 403 com `{ error: 'agent banido' }` **para** o beacon.
- [ ] `GET /api/site/status` não devolve o token nem parte dele
      (`grep` da resposta pelo valor do token não acha nada).

### 21.5 A fila de entregas

- [ ] Jogador offline → ACK `deferred`, e **zero** comandos RCON.
- [ ] Presença `null` → ACK `deferred`, e **zero** comandos RCON.
- [ ] A linha em `site_deliveries` existe **antes** de o comando sair (o teste
      inspeciona o banco de dentro do dublê de RCON).
- [ ] Uma tarefa já `delivered` localmente não executa comando de novo.
- [ ] Uma tarefa órfã em `reserved` vira `indeterminate`, **não** é reexecutada,
      e é ACKada como `deferred` com `reason: 'AGENT_INDETERMINATE'` — o corpo
      do ACK **nunca** carrega um quarto `status` (§10.4).
- [ ] Um id que volta em `unknown` com a linha local `delivered` **mantém a
      linha**; com a linha local `reserved`, vira `expired` (§5.8).
- [ ] **O dublê da rota de ACK implementa a regra 3-bis** (§5.8): um `delivered`
      sobre tarefa que o site já expirou volta em **`applied`**, e **não** em
      `unknown` — só `failed` e `deferred` sobre `expired` caem em `unknown`. Um
      dublê escrito a partir da paráfrase antiga (*"tarefa que não é `pending`
      entra em `unknown`"*) faz o teste passar contra um site que não existe.
- [ ] Payload fora do vocabulário do §5.7 → ACK `failed` com `PAYLOAD_INVALID`,
      sem comando. Um teste por régua: `amount` 0 e 100 001, `kit` com 41 itens,
      `days` 0 e 3651, `fuel` -1 e 1001, `shortname` com espaço, `prefab` com
      `/` e `prefab` terminado em `.prefab`, `skinId` não numérico. **`prefab`
      com `.entity` PASSA** — é nome válido, e o teste que o recusava recusava o
      contrato (§5.7).
- [ ] `RCON_UNAVAILABLE` chega como `deferred`, e **não** como falha desconhecida
      — o teste rejeita com um `ApiError('RCON_UNAVAILABLE', <frase em
      português>)` e prova que `ackOf` leu o `code`, não a `message`.
- [ ] `planOfPayload` devolve `units: 1` em todos os quatro `kind`, e o
      `origemz.give` sai com o `amount` exato do payload. **O caso `vip` entra no
      teste mesmo sendo código morto na fase 1** (§5.7): ele é o único guardião
      de um ramo que ninguém vai exercitar em produção até a fase 2, e ramo não
      exercitado sem teste apodrece calado.
- [ ] **A rodada lê o `next`.** Com uma fila de 300 tarefas e páginas de 50, uma
      rodada faz **5** `GET` (o teto `DELIVERY_MAX_PAGES_PER_ROUND`) e a rodada
      seguinte começa no `cursor` guardado, **não** no topo. Com `next: null`, a
      rodada faz **um** `GET` e zera o cursor guardado.
- [ ] `400 INVALID_CURSOR` faz a rodada **descartar o cursor** e refazer a página
      do topo, **uma** vez — e o mesmo cursor recusado **nunca** é enviado duas
      vezes. Tratá-lo como `unavailable` é o laço eterno do §5.7.
- [ ] `wake()` (conexão de jogador) dispara uma rodada com o cursor **zerado**.
- [ ] `400 INVALID_ACK_STATUS` e `400 INVALID_ACK_BODY` **não** carimbam
      `acked_at` em nenhuma linha local, e o lote volta inteiro na rodada
      seguinte.

### 21.6 A reconciliação

- [ ] Uma compra em `charge-unknown` com menos de 90 s **não entra** na varredura.
- [ ] Prova 200 → a compra é entregue e vira `delivered`.
- [ ] Prova 404 → a compra vira `failed` com `CHARGE_NEVER_HAPPENED`, **sem
      nenhuma chamada de débito**.
- [ ] Prova `400 INVALID_REFERENCE_ID` → a compra sai do laço com
      `CHARGE_UNPROVABLE`, e **não** é varrida de novo.
- [ ] Prova `500 TRANSACTION_LOOKUP_FAILED` → a compra **continua** em
      `charge-unknown` e é varrida de novo no minuto seguinte. O 500 é
      retentável; o 400 é terminal, e trocá-los custa nos dois sentidos (§5.6).
- [ ] Uma compra em `pending` há mais de 5 min **entra** na varredura; com
      `reference` nula, fecha como `CHARGE_UNKNOWN_NO_REFERENCE` (§11.3).
- [ ] Uma compra em `failed` com `error` começando em `REFUND_REJECTED` **não**
      entra na varredura; com `REFUND_RETRYABLE`, entra (§12.4).
- [ ] Duas chamadas concorrentes de `settle` sobre a **mesma** compra produzem
      **uma** entrega — a segunda devolve `outcome: null` por não ter conseguido
      a reivindicação (§11.4).
- [ ] Depois de `SETTLE_MAX_ATTEMPTS`, a compra sai da varredura e entra em
      `purchases.unprovable`.
- [ ] Site inalcançável → `outcome: null`, e o estado **não muda**.
- [ ] A rota `POST .../settle` e o relógio chamam a mesma função:
      `grep -rn "\.settle(" core/src/http core/src/store` devolve **exatamente
      duas** chamadas — uma em `http/routes/store.ts` e uma em `store/settle.ts`
      — e nenhuma delas reimplementa a decisão.

      *(O critério antigo, `grep -c "service.settle(" core/src` = 2, não podia
      passar: a rota chama `deps.service.settle(...)` e o relógio recebia a loja
      com o nome `store`, então o grep devolveria 1. O §14.15 agora usa
      `service` nos dois lugares, e o grep acima confere os dois de qualquer
      jeito.)*

### 21.7 O catálogo

- [ ] A `version` não muda entre duas montagens seguidas do mesmo catálogo.
- [ ] Editar uma oferta muda a `version`.
- [ ] O payload **não** contém `items`, `vip` nem `vehicle` de nenhuma oferta.
- [ ] Um payload acima de 2 MiB é recusado **antes** de sair.
- [ ] Três edições em dois segundos produzem **um** push, e o último estado.

### 21.8 O painel e a documentação

- [ ] `GET /api/players/:steamId/wallet` com a carteira remota fora do ar
      devolve `balance: null`, e o painel mostra `—`.
- [ ] A tela do jogador diz, em texto, que o extrato local é histórico.
- [ ] `POST /api/players/:steamId/wallet` continua respondendo
      `409 WALLET_IS_REMOTE`.
- [ ] `.env.example` tem as doze variáveis do §16.1, e as doze são **lidas** no
      §14.14 (nenhuma declarada sem leitura). **E não existe uma décima terceira
      citada em prosa:** a cadência do espelho é a **constante**
      `DEFAULT_MIRROR_INTERVAL_MS` (§13.3, §14.8), e não
      `SITE_CATALOG_PUSH_INTERVAL_MS` — nome que este documento chegou a usar
      como se fosse `.env` e que não existe em tabela, em `.env.example` nem em
      leitura nenhuma.
- [ ] A tabela do §23 deste documento e a tabela equivalente do manual do site
      são **idênticas, campo a campo**.
- [ ] **A etiqueta de versão do contrato é a MESMA string nos dois arquivos**, e
      isso se confere sem opinião — a etiqueta em uso é a **primeira** ocorrência
      de `oz-rust/<n>` em cada arquivo, que em ambos é a do cabeçalho do §23:

      ```
      grep -Eom1 'oz-rust/[0-9]+' Docs/20-INTEGRACAO-OZCOIN-AGENT.md
      grep -Eom1 'oz-rust/[0-9]+' <site>/docs/mateuus/rust/docs/INTEGRACAO-OZCOIN-RUST.md
      ```

      **As duas linhas têm de imprimir a mesma string.** Hoje imprimem
      `oz-rust/5`. O critério antigo — *"as duas citam a mesma versão"* — não era
      verificável: um lado dizia `CONTRATO v1` e o outro `oz-rust/1`, e nenhum
      `grep` casa as duas.

      `CONTRATO v1` sobrevive neste documento **só como nota histórica** (aqui e
      na caixa do §23), e é de propósito: apagar o registro é o jeito mais rápido
      de alguém reintroduzir a string em seis meses. O que não pode existir é uma
      **segunda etiqueta em uso** — se `grep -Eom1 'oz-rust/[0-9]+'` devolver
      strings diferentes, alguém mexeu num lado só.
- [ ] `Docs/README.md` e `README.md` listam este documento.
- [ ] `Docs/06-API.md` descreve as rotas novas e não diz mais que a loja não
      existe.

---

## 22 — Perguntas para o dono

### 22.0 Antes: o que já está DECIDIDO

Estas onze não são perguntas. Elas são decisões tomadas, com o porquê e a
alternativa descartada escritos na seção indicada. Estão aqui para que ninguém as
reabra por engano.

| # | Decisão | Onde ela é argumentada |
|---|---|---|
| 1 | A integração é **sempre iniciada pelo agent**; o site nunca chama o RustAgent | §2.3 |
| 2 | **O agent se adapta ao site.** Nasce `SiteWallet`; a `RemoteWallet` é aposentada | §3, §8.5 |
| 3 | `WalletChange` passa de três para **cinco** desfechos | §4 |
| 4 | A fase 1 cobra por `/ozcoins/debit` + `productId`, e não por `/shop/purchase` | §5.4, §5.11 |
| 5 | `referenceId` = `rust:<serverId>:loja:<purchaseId>`, teto 113, `sha256` no excedente | §6 |
| 6 | O que foi comprado no site é entregue por **PULL**, com ACK | §10 |
| 7 | Nasce `GET /api/agent/ozcoins/transaction` — leitura pura, a prova | §5.6, §11 |
| 8 | O catálogo é do **agent**; o site recebe espelho somente-leitura | §13 |
| 9 | A ordem é: espaço → cobrar → entregar → estornar. Timeout na entrega **nunca** estorna; timeout no débito **nunca** fecha | §4.4, §12.5 |
| 10 | O saldo local **não** é migrado: congela e vira histórico | §7.4 |
| 11 | O plano da entrega é **congelado** na linha da compra | §11.4, §14.11(d) |

### 22.1 Quem é dono do preço e do catálogo da loja in-game?

**Opções.** (a) **O AGENT**, com espelho somente-leitura no site: o painel vê e o
site vende pelos mesmos ids. (b) **O SITE**, no padrão Conan: exige um
`rustShopCatalog`, entrada em `gamePlugins`/`deliveryTypes`, `item_catalog`
povoado com os `shortname` do Rust, e migrar a administração da loja para o
painel do site.

**Recomendação:** (a) na fase 1. O contrato deste documento é escrito para que
(b) seja a troca de uma implementação de precificação, e não uma reescrita.

**Impacto de escolher (b) agora:** a integração inteira trava atrás de um
catálogo que ainda não existe. Só o agent sabe quais `shortname` existem naquele
servidor (ele lê `origemz.items` do jogo), quais `prefab` de veículo o servidor
aceita e quais tiers o `OrigemZVip.json` declara. O argumento clássico contra (a)
— *"software de terceiro não decide quanto se tira de um saldo comprado com
cartão"* — **não se aplica**: o RustAgent é do mesmo dono e roda com bearer
próprio.

**Este documento já implementou (a).** Mudar para (b) invalida §13 inteiro e
troca §5.4 por `/shop/purchase`.

### 22.2 Como o Rust cobra na fase 1?

**Opções.** (a) `/ozcoins/debit` acrescido de `productId` opcional e do guard de
replay. (b) Esperar o `/shop/purchase` generalizado.

**Recomendação:** (a). É a mudança menor no site — o helper `applyOzMutation`
**já aceita** o parâmetro (`ozCoinsMutation.ts:130-134`), o controller só não o
passa. É aditiva para o DayZ, e destrava o requisito "informar o que foi
comprado" imediatamente.

**Impacto de (b):** `requireConanServer` (`agent-shop.controller.ts:47-63`)
recusa qualquer `Server.game` diferente de `conanexiles` com
`400 SHOP_GAME_NOT_SUPPORTED`. Sem generalizar a trava **e** escrever o catálogo,
o Rust só recebe erro.

**Este documento já implementou (a).**

### 22.3 Push ou pull para entregar o que foi comprado no site?

**Opções.** (a) **PULL**: o agent puxa a fila e confirma com ACK. (b) **PUSH**: o
site chama o agent com HMAC, e o agent implementa a verificação inteira
(`X-Timestamp` ±120 s, `X-Nonce` **nunca visto antes**, em cache LRU,
`X-Signature` sobre `METHOD|path|ts|nonce|sha256(body)` com o corpo canonizado,
mais allowlist de IP). São **cinco** campos no payload assinado, e o `nonce` é um
deles — o `agentClient.ts` do site monta exatamente
`` `${method.toUpperCase()}|${path}|${timestamp}|${nonce}|${bodyHash}` ``.
Omitir o `nonce` da descrição subestimaria o trabalho, que é justamente o
argumento de custo desta seção.

**Recomendação:** (a), com folga. As três razões estão no §2.3, e são medidas no
código do site.

**Impacto de (b):** o agent precisa abrir uma porta na internet e implementar a
verificação de HMAC inteira; o site precisa alcançar um IP residencial atrás de
NAT por HTTP puro; e a entrega vai falhar sempre que o jogador estiver offline,
**sem lugar nenhum onde a tarefa espere**. Os 409/503 dela teriam de significar
"guarde e tente de novo", o que reinventa a fila do lado errado.

**Este documento já implementou (a).** (b) é a fase 3, se um dia o site precisar
mandar algo em tempo real.

### 22.4 O saldo local já acumulado na virada

**Opções.** (a) **Congela** e vira histórico — a rota de lançamento manual já
recusa com `409 WALLET_IS_REMOTE`. (b) É **exportado e creditado** no site num
evento único, com tabela de tracking e clamp de negativo. (c) É **zerado**.

**Recomendação:** (a) por padrão, com um relatório exportável para o dono decidir
(b) caso a caso.

**Impacto de (b) automático:** seria um evento de dinheiro disparado por uma
variável de ambiente, sem aprovação, sem trilha e sem reversão. E há precedente
de custo: a importação de OzCoin legado do site precisou de tabela de tracking e
clamp de negativo, e deixou linhas **sem contrapartida no ledger** que causam
drift até hoje.

**Este documento já implementou (a).** Escolher (b) é um trabalho separado, com
documento próprio.

### 22.5 O Rust vai vender VIP pelo site?

**Opções.** (a) VIP do Rust é vendido **só in-game** na fase 1. (b) O site
também vende VIP de Rust.

**Recomendação:** (a). In-game o agent já é dono do ciclo inteiro — relógio de
vencimento, reaplicação de grupo, extensão sobre o vencimento e não sobre hoje.

**Impacto de (b):** a lei escrita do site é que **jogo sem reconciliação não pode
vender VIP**, porque o grant nasce `active` antes de o jogo confirmar. Escolher
(b) obriga a registrar um reconciliador de VIP e um `vipTransport` do lado do
site — trabalho que não está neste documento.

**Este documento suporta (b) parcialmente:** o `kind: 'vip'` da fila de entregas
(§5.7) já existe e funciona. O que falta é do lado do site.

**O site respondeu (a) em 2026 e virou para (b) em 04/09/2026.** A §11.4 do
manual dele deixava `rust_vip` fora de `DELIVERY_TYPES_BY_GAME`, de
`DELIVERY_BY_KIND_BY_GAME`, de `DELIVERY_HANDLER` e de `ITEM_KINDS_BY_GAME.rust`
— nada lá criava tarefa desse `kind`, e o ramo `vip` da fila era código morto
escrito e testado. **Isso acabou:** o reconciliador subiu, o resgate foi ligado
(`Docs\25`, `Docs\26` §3) e a revogação ganhou caminho próprio
(`kind: 'vip_revoke'`, §5.7). A pergunta está **fechada em (b)**, o oitavo
alarme do §18.4 foi desarmado, e o que restou de decisão de produto é o preço e
o catálogo — não o transporte.

### 22.6 Sufixo do estorno: `:credit` ou `:refund`?

**Opções.** (a) `:refund` — o precedente vivo do site e do agente do Conan.
(b) `:credit` — o que a `RemoteWallet` deriva hoje (`wallet.ts:211-216`).

**Recomendação:** (a). É o que os relatórios e o hábito operacional já esperam, e
é sobre ele que o teto de 113 chars da compra foi dimensionado.

**Impacto de (b):** nenhum tecnicamente (os dois têm 7 chars), mas cria uma
segunda convenção para a mesma coisa entre dois jogos do mesmo dono, e qualquer
consulta que procure `:refund` no ledger perde o Rust.

**Este documento já implementou (a).** Mudar é uma constante.

### 22.7 O beacon de agente ativo passa a exigir assinatura?

**Opções.** (a) **Sim** — HMAC-SHA256 do bearer sobre `serverId|timestamp`,
janela ±120 s, no header `X-Agent-Signature`, exigido apenas quando
`status === 'active'` **e** `agents.requires_signed_beacon === true` — as **duas**
condições, porque `agents` é compartilhada com DayZ e Conan e exigir de todo
mundo derruba a entrega de inventário do DayZ (§9.4). (b) **Não**, por
consistência com o que já existe.

**Recomendação:** (a). Hoje qualquer um que saiba (ou adivinhe) um `serverId`
sobrescreve `beaconIp`, `beaconPort`, `lastVersion` e `capabilities` de um agente
**em produção**, sem credencial nenhuma (`agent-public.routes.ts:106-119`). Para
o Conan isso é tolerável porque a `baseUrl` fica congelada; para o Rust, que usa
`capabilities` para declarar o que sabe entregar, é uma superfície de mentira.

**Impacto de (b):** o header vira ruído ignorado, e nada no agente quebra. O
custo é aceitar que a linha do agente no site é editável por quem souber o id.

**É a única decisão desta lista que exige trabalho do lado do site para valer.**
O agente manda a assinatura de qualquer jeito (§9.4).

### 22.8 Expiração e teto de tentativas da fila de entregas

**A pergunta.** Quantos dias uma tarefa espera um jogador que sumiu, e quantas
tentativas antes de virar conferência humana?

**Recomendação:** **30 dias** de validade; **sem teto** de tentativas enquanto o
desfecho for `deferred` (jogador ausente **não é falha**); teto de **5** para
`failed`. Ao expirar, o item volta para `available` no site — **nunca some**.

**Impacto de errar para menos:** um jogador que viajou duas semanas perde o item
que pagou. **Para mais:** a fila cresce para sempre e o item fica preso em
`processing`, fora do radar de qualquer relatório.

**Isto é decisão do SITE**, não do agente: quem expira e quem conta tentativas é
a fila, e ela mora lá. O agente só precisa saber que `expiresAt` pode vir `null`.

### 22.9 Teto de OZ por transação no agente

**A pergunta.** Qual valor para `STORE_MAX_OZ_PER_PURCHASE`?

**Recomendação:** **100 000 OZ** por compra — o mesmo valor que o painel do Conan
adotou depois de um débito de 60 milhões de OZ numa requisição.

**Impacto de deixar sem teto (`0`):** o site não impõe nenhum, e só recusa o que
passa do saldo. Um preço editado errado ou um `quantity` vindo por rota debita o
que o jogador tiver. E `users.ep_balance` é `INTEGER` de 32 bits enquanto o
ledger é `BIGINT` — o saldo estoura antes do ledger, sem mensagem própria.

**Impacto de um teto baixo demais:** a oferta mais cara da loja para de ser
vendável, e o jogador lê "passa do limite" sem entender.

**Este documento já implementou 100 000 como default**, e a variável existe para
o dono mudar conscientemente.

### 22.10 O `serverId`, o jogo `rust` no site, e o servidor local que recebe

**São três perguntas amarradas, e todas precisam de resposta antes da fase 4.**

**(a) Existe a linha `games.id = 'rust'` no banco de produção do site?** Com que
`route`, `is_active` e `enabled_menus`? Um comentário no código do site afirma
que "Rust e Zomboid já estão lá", mas **não há seed nem migration no
repositório** — isso precisa ser conferido no banco, não no código.

**(b) Qual é o `serverId` de cada servidor de Rust no site?** Ele casa por string
**EXATA**, maiúsculas incluídas: um `server01` local contra um `SERVER01`
cadastrado é `404 AGENT_NOT_FOUND`, e a mensagem **não diz** que é diferença de
caixa. O `id` local do RustAgent vem do nome do arquivo `Configs\<id>.ini` e é
sempre minúsculo (`SERVER_ID_PATTERN`, `core/src/config.ts:78`) — então os dois
**não são o mesmo campo**, e é por isso que `SITE_SERVER_ID` existe separado.

**(c) Um agente, quantos servidores?** O site modela **um agente por `Server`**,
com um bearer por linha de `agents`. O RustAgent administra **N** servidores de
Rust num processo só. Fase 1 pareia **um**: `SITE_SERVER_ID` identifica o
pareamento e `SITE_LOCAL_SERVER_ID` diz qual servidor de `Configs\` recebe as
entregas.

**Recomendação:** parear um servidor na fase 1, e escolher **qual**. O
`SiteClient` já nasce recebendo `{ baseUrl, serverId, token }` no construtor, de
modo que suportar N pareamentos depois é um `Map<localServerId, SiteClient>` — a
troca de uma linha na montagem, não uma reescrita.

**Impacto de adiar:** com N servidores e um pareamento só, o `server_id` do
ledger do site será sempre o mesmo, e o relatório por servidor do site não
separará as vendas. É uma perda de granularidade, não de dinheiro.

**Não existe plugin `rust` em `services/gamePlugins.ts` do site** (só `dayz`,
`scum`, `conanexiles`), e `getGamePlugin` faz **fallback silencioso para DayZ**.
Um `Server` com `game='rust'` herdaria comportamento de DayZ em toda a cadeia de
inventário e VIP até alguém registrar o plugin. Isso é pré-requisito da fase 6, e
é trabalho do lado do site.

### 22.11 O nome das variáveis de ambiente

**Opções.** (a) **Renomear** `STORE_WALLET_URL`/`STORE_WALLET_TOKEN` para
`SITE_BASE_URL`/`SITE_TOKEN`, aceitando as antigas como fallback por uma versão.
(b) Manter os nomes atuais.

**Recomendação:** (a). A mesma base passa a servir beacon, carteira, entregas e
catálogo — o nome "wallet" descreveria um terço do que a variável faz. E as duas
antigas **nunca estiveram no `.env.example`**, então não há `.env` documentado
para quebrar.

**Impacto:** um `.env` de produção que já tenha `STORE_WALLET_URL` preenchida
continua funcionando, com um `warn` no boot — **exceto** se o valor terminar em
`/api`, caso em que o boot recusa com a mensagem que ensina o valor certo (§16.3).

**Este documento já implementou (a) com o fallback.**

---

### 22.12 O bearer de um agent move o saldo de qualquer jogador. Fecha-se isso?

**O fato, medido.** `applyOzMutation` no site **não escopa nada por servidor**: o
`serverId` entra na linha do ledger para rastreabilidade e não restringe alcance.
Qualquer agent com bearer válido — o do DayZ, o do Conan, o de outro servidor de
Rust — pode debitar ou creditar **qualquer** `steamId` por **qualquer** valor.
`X-Server-Id` é identidade, não autorização (§17.4).

Isso não é novo, e não é do Rust. O que o Rust muda é o **número de bearers
vivos** com poder total sobre `users.ep_balance`.

**Opções.** (a) **Deixar como está** e tratar o bearer como segredo de nível
ledger: rotação separada por servidor, nunca reuso, e resposta de incidente
escrita. (b) **Escopar** `/ozcoins/*` ao conjunto de jogadores já vistos naquele
`serverId`. (c) Escopar por **teto de valor** por agent.

**Recomendação:** (a) para a fase 1, com o §17.4 escrito. (b) é a resposta certa
a longo prazo e **muda DayZ e Conan junto** — um jogador que compre OZ no site e
resgate num servidor onde nunca entrou passaria a ser recusado, e isso é decisão
de produto, não de infraestrutura.

**Impacto de não decidir:** nenhum hoje; o custo aparece no dia de um vazamento,
e aí ele é o ledger inteiro.

---

### 22.13 Como um humano libera uma entrega parada em `review`? — RESPONDIDA

**O fato, medido, e ele continua valendo.** Os dois manuais afirmavam que "o
botão de restaurar que já existe" resolve. **Ele não resolve.** O `reconcile` do
admin do site despacha por um mapa que só conhece `conanexiles` e `scum` (400
para o resto, `admin-vip.controller.ts:973-976`), e o `restoreInventoryItem`
exige `item.deletedAt` (`:1004-1010`). Nenhum dos dois toca um item de Rust
parado em `processing`.

**A pergunta foi respondida, e a rota EXISTE no manual do site.** A opção
recomendada aqui era (a) — criar a rota —, e é ela que a §21.8 do manual do site
especifica: `POST /api/admin/rust/deliveries/:deliveryId/release`, permissão
`rust-deliveries`, é a ação **Liberar** da §20.4 de lá.

| O que | Como está especificado na §21.8 do manual do site |
|---|---|
| O que ela faz | **numa transação**: marca a tarefa `failed` com `last_reason = 'ADMIN_RELEASED'` e `settled_at = NOW()`, e devolve o `inventory_item` para `available` com `redeemedAt = null` |
| A guarda | `where: { id, status: 'processing' }` — se o item já saiu de `processing` por outro caminho, a tarefa fecha mesmo assim e o item **não** é tocado |
| 200 | `{ "ok": true, "released": true, "itemReturned": true }`; `itemReturned` é `false` quando o `where` não casou |
| 400 | `DELIVERY_NOT_RELEASABLE` — o `status` atual não é `review` nem `needs_admin` |
| 404 | a entrega não existe |
| 500 | `RELEASE_FAILED` |
| Auditoria | `auditLog('ADMIN_RUST_DELIVERY_RELEASE', req.user.id, { deliveryId, previousStatus })` |

**Por que só `review` e `needs_admin`**, na razão escrita de lá: em `failed` e
`expired` o item **já voltou** sozinho; em `pending` e `deferred` a entrega está
viva e liberar seria decidir no lugar do agente; em `delivered` há prova, e prova
não se desfaz.

**O que isso muda deste lado: nada de código, e uma coisa de operação.** O agente
não chama essa rota e nem a conhece — ela é do painel do site. O efeito que ele
sente é indireto e vale escrever: uma tarefa liberada por admin **some de
`/deliveries/pending`** e nunca volta, enquanto a linha local dela continua
`indeterminate` aqui até o `unknown` do ACK seguinte (§10.4). As duas contagens
não têm de bater por construção, e isso já está na §23.6.

**A opção (c) — SQL manual — deixou de ser o plano.** Ela continua sendo o
procedimento de emergência se a rota não estiver no ar no dia da virada, e
continua valendo o motivo de ela ser ruim: um `UPDATE` em produção feito de
memória, às duas da manhã, é a pior ferramenta possível para o caso em que
ninguém sabe se o item saiu.

---

## 23 — Ponto de sincronia com o manual do site

> ## Contrato `oz-rust/7`
>
> Esta seção precisa ser **idêntica, campo a campo**, à seção equivalente de
> `F:/Projects/OrigemZSite/docs/mateuus/rust/docs/INTEGRACAO-OZCOIN-RUST.md` (o manual do site).
> **Se um campo divergir entre os dois documentos, os dois estão errados até
> alguém reconciliar** — não existe "o meu está certo".
>
> **A etiqueta de versão do contrato é `oz-rust/7`**, e os dois documentos a
> citam com essa string exata. Quem mudar qualquer coisa desta seção sobe a
> etiqueta **nos dois arquivos, no mesmo commit**. Sem a etiqueta não há como
> olhar um lado só e saber se ele está em dia — foi por essa fresta que `skinId`
> (string × number), `prefab` (nome curto × caminho) e o vocabulário de `reason`
> divergiram sem ninguém notar.
>
> **A carência acabou.** Enquanto nenhum dos dois lados tinha código no ar,
> `oz-rust/1` foi rascunho vivo e reconciliar os dois manuais NÃO subia a versão —
> não existia implementação para ficar defasada. **Hoje existe código no ar dos
> dois lados**, então toda mudança desta seção sobe a etiqueta nos dois arquivos,
> no mesmo commit.
>
> **O que mudou em `oz-rust/7`:** três coisas, e as três são **aditivas** — quem
> fala a `/6` continua entendido. (c) Nasceu o **espelho do catálogo de itens do
> jogo**: `POST /api/agent/items/mirror`, `GET /api/agent/items/mirror/version` e
> `POST /api/agent/items/images` (as rotas 19, 20 e 21). É o único espelho que
> carrega IMAGEM — os ícones não existem no servidor dedicado, só na instalação
> do cliente do Rust, e o agente é a única ponta que pode entregá-los. Detalhe no
> `Docs/29` e em `core/src/game/items-mirror.ts`. (a) O espelho de VIP passou a levar **`tiers[]`**
> junto dos `vips[]`, DENTRO do hash da `version`, para o cadastro de produto do
> site escolher o nível em vez de digitá-lo. (b) Nasceu o **`kind: 'vip_revoke'`**
> na fila de entregas, com `payload: { tier }` — o caminho do estorno, do
> chargeback, do ban e do vencimento que o site varre a cada minuto. A etiqueta
> subiu apesar de nada quebrar porque **um `kind` novo na fila é exatamente o
> tipo de coisa que alguém precisa conseguir datar depois**. Detalhe nos
> `Docs/26`, `Docs/27` e `Docs/28`, e nas §5.7 e §10.3.
>
> **O que mudou em `oz-rust/6`:** o campo **`exists` SAIU** da resposta de
> `GET /ozcoins/balance` (rota 2). Ela agora tem **duas chaves**: `{ steamid, moedas }`. É a
> decisão do dono sobre a **H58** do backlog do site — a mais barata das três saídas. O campo
> era o literal `true`, nunca calculado, e só podia ser verdade porque o `findOrCreate` da
> própria consulta acabava de criar a conta; a sonda de 04/09/2026 o mediu perguntando o saldo
> de um SteamID inexistente. Detalhe em **D20** e na **§7.2**.
>
> ⚠️ **Esta é a primeira etiqueta que REMOVE algo do fio**, e por isso ela subiu apesar de
> nenhum código deste lado ler o campo: o `SiteClient` o **sintetiza**
> (`core/src/site/client.ts:177` devolve `{ balance, exists: true }` traduzido de `moedas`) e
> nunca o leu da resposta. Foi essa indireção que fez a remoção não custar nada aqui.
>
> ⚠️ **Duas pendências ficaram DESTE lado, e nenhuma é urgente:** o comentário de
> `core/src/store/site-wallet.ts:104` ainda diz que o campo *"é ignorado de propósito"* (não há
> mais o que ignorar), e `BalanceBody.exists` continua no tipo como campo **sintético** —
> honesto sobre o que o `SiteClient` entrega, desonesto sobre o que o fio traz. Decidir se ele
> sai leva junto o `expect` do caso `ozcoins-balance` em `contracts/oz-rust-fixtures.json`.
>
> ⚠️ **O `findOrCreate` do site NÃO saiu, e a H58 continua aberta.** A leitura ainda escreve em
> duas tabelas, e o DayZ em produção depende disso para creditar quem nunca logou no site.
> **Nada mais mudou no fio:** os três valores de ACK de entrega, o vocabulário de `reason`, o
> payload de entrega, os `error_code` e a convenção de `referenceId` continuam byte a byte como
> estavam.
>
> ⚠️ **A reserva de etiquetas se moveu uma casa.** As `/6`, `/7` e `/8` estavam reservadas para
> as quatro áreas de config avançada; a `/6` foi gasta aqui, e as reservadas passam a ser
> **`/7`, `/8` e `/9`**. Reserva é conveniência de planejamento; a etiqueta é o que diz se o fio
> mudou, e quando os dois conflitam quem cede é a reserva.
>
> **O que mudou em `oz-rust/5`:** a **reconciliação** do que estava fora dos manuais — o
> `desired` da rota 13 passou de oito para **23 campos** (a tela de configuração inteira), e
> nasceram as **rotas 15 e 16**, o canal de config de rede (`store`, `kits`, `vips`). O corpo
> está na subseção **"A tela inteira e a config de rede (Lote 4)"**, idêntico nos dois
> manuais. Nada do que já atravessava o fio foi alterado: os três valores de ACK de entrega, o
> vocabulário de `reason`, o payload de entrega, os `error_code` e a convenção de
> `referenceId` continuam byte a byte como estavam.
>
> ✅ **E esta é a primeira etiqueta com o canal MEDIDO.** Em 04/09/2026 o cliente real do
> agent falou com o dev pela primeira vez (`npm run site:probe -w core`), e o que ele achou
> está em `F:/Projects/RustAgent/contracts/oz-rust-fixtures.json` — o arquivo de fixtures que
> os dois lados pediam, agora consumido pelos testes do agent. **Três divergências
> apareceram na primeira rodada**, e nenhuma delas teria sido pega por teste nenhum dos dois
> lados: `version: 0` como sentinela de "não há config" (o ACK dela volta
> `400 CONFIG_INVALID_VERSION`); o ACK de comando respondendo `results[]` onde o manual
> descrevia `unknown[]`; e o **304 que nunca acontece** — o dev responde 200 com
> `Cache-Control: no-store` mesmo com `If-None-Match` idêntico. As três estão em
> `F:/Projects/RustAgent/Docs/21-STATUS-PARA-O-AGENTE-DO-SITE.md` §9, com o que cada lado faz
> a respeito.
>
> **O que mudou em `oz-rust/4`:** o `desired` da rota 13 ganhou o **oitavo campo — `autoUpdate`**, e
> ele é o único que **não** é do `.ini`. Nenhuma rota nova, nenhuma `version` nova, nenhum ACK novo:
> ele viaja no **mesmo** `desired`, na **mesma** `version`, e é ACKado com ela. É **tri-estado**
> (chave ausente · `false` · `true`), **não** entra em `RESTART_KEYS` e **não** é risco de wipe.
> ⚠️ **Quem o aplica do lado do agent NÃO é o `updateSettings` do `.ini` — é o caminho de
> `/steam-update`**; quem procurar o valor no `.ini` e não achar vai concluir que a gravação se
> perdeu. Nada do que já atravessava o fio foi alterado.
>
> ✅ **A reivindicação concorrente do `Docs/23-CONFIG-PELO-SITE.md` foi RESOLVIDA em
> 04/09/2026:** o conteúdo dele (os campos da rota 13 e as rotas 15/16) está reconciliado nos
> dois manuais, na subseção do Lote 4, e a etiqueta subiu para `oz-rust/5` nos dois no mesmo
> commit. O cabeçalho daquele documento foi corrigido junto. A etiqueta é dos manuais, não de
> quem a reivindica primeiro — é isso que a torna verificável por `grep`.
>
> **O que mudou em `oz-rust/3`:** nasceram as **rotas 11 a 14** — a **fila de
> comandos** (`/commands/claim` + `/commands/ack`) e a **config desejada**
> (`/server/config` + `/server/config/ack`), o Lote 3 (§23.10) — e a tabela de
> rotas do contrato passou de dez para **quatorze** (§23.9). Nada do que já
> atravessava o fio foi alterado: os três valores de ACK **de entrega**, o
> vocabulário de `reason` **de entrega**, o payload de entrega, os `error_code`
> das dez rotas anteriores e a convenção de `referenceId` continuam byte a byte
> como estavam. **O ACK de COMANDO é outro vocabulário, em outra rota** — quatro
> `status` e dez `reason` próprios —, e confundir os dois é o primeiro erro que
> este lote pode produzir.
>
> ✅ **As rotas 11-14 existem hoje nos DOIS lados** — quando `oz-rust/3` foi carimbada, não existiam
> em nenhum, e a etiqueta subiu porque **o contrato é anterior às duas implementações**, que é a
> única forma de elas nascerem casadas. Em 04/09/2026 o estado é: no **site**,
> `agent-commands.controller.ts` e `agent-server-config.controller.ts`, com os models
> `RustAgentCommand` e `RustServerConfig` e as migrations `migrate_rust_agent_commands.ts` e
> `migrate_rust_server_configs.ts`; no **agent**, `core/src/site/commands.ts` e
> `core/src/site/config.ts`. ⚠️ **Nenhuma linha de uma ponta falou com a outra ainda** — os testes
> dos dois lados falam com dublês, e é esse o risco número um que continua de pé.
>
> O manual de implementação deste lado é o **`Docs/22-COMANDOS-E-CONFIG-DO-SITE.md`**.
>
> **O que mudou em `oz-rust/2`:** nasceu a **décima rota** —
> `POST /api/agent/server/status`, o retrato do servidor que este agent empurra a
> cada 30 s (§23.8). Nada do que já atravessava o fio foi alterado: os três
> valores de ACK, o vocabulário de `reason`, o payload de entrega, os `error_code`
> das nove rotas anteriores e a convenção de `referenceId` continuam byte a byte
> como estavam.
>
> **O changelog de `oz-rust/1` mora na §23 do manual do site**, e fica lá: uma
> lista só, num lugar só. Duplicá-lo aqui garantiria que um dos dois envelhecesse.
>
> ####  ESTE DOCUMENTO JÁ DISSE `CONTRATO v1` AQUI  ####
>
> Era outra string para a mesma coisa, e o preço não era estético: o critério de
> aceite do §21.8 (*"as duas citam a mesma versão do contrato"*) **reprovava com
> os dois lados corretos**, porque `CONTRATO v1` e `oz-rust/1` não se casam em
> `grep` nenhum. Uma etiqueta que só um humano atento consegue comparar não é
> etiqueta de versão — é decoração.

Ela existe porque `skinId`, `prefab` e o vocabulário de `reason` divergiram entre
os dois manuais sem que ninguém notasse — e as três divergências só apareceriam
no **primeiro resgate real**, como item que nunca chega.

### 23.1 Quem manda em cada campo

Quando os dois documentos discordam, o desempate não é por opinião. É esta
tabela:

| Assunto | Quem manda | Por quê |
|---|---|---|
| formato dos **ids** (`deliveryId`, `sourceRef`) | **o site** | é ele que os gera |
| **tipo e régua** dos campos de entrega (`skinId`, `prefab`, `amount`, …) | **o agent** | é ele que executa, e as réguas já existem no código dele |
| **códigos de erro** HTTP (`error_code`) | **o site** | é ele que os emite |
| **vocabulário de `reason`** do ACK | **o agent** | é o plugin do jogo que os produz |
| **estados** de cada lado | cada um o seu | são bancos diferentes; só o ACK atravessa o fio |

### 23.2 Os valores de exemplo, e eles são os MESMOS nos dois

Um `curl` copiado de um documento tem de rodar contra o outro lado. Por isso os
exemplos não são livres:

| O quê | Valor canônico |
|---|---|
| `serverId` (no site) | `RUST01` (maiúsculo — `rust01` é outro id) |
| `serverId` local do agent (em `Configs\`) | `rust-pvp1` — **só o agent o conhece**; o site nunca o vê |
| `steamId` | `76561198000000000` |
| `productId` / `offerId` | `kit-metal` |
| a oferta | `Kit Metal`, categoria `kits`, `price` 250, `oldPrice` 400, `badge` `PROMO`, `kind` `kit`, `itemCount` 6 |
| `referenceId` de compra | `rust:RUST01:loja:p2n8x4q9zk1a` |
| `referenceId` de estorno | `rust:RUST01:loja:p2n8x4q9zk1a:refund` |
| `observacao` | `Loja in-game: Kit Metal x1` |
| saldo do exemplo | `500` antes da compra, `250` depois — `before` `"500"`, `after` `"250"`, `amount` `"250"` |
| `transactionId` | `918273` |
| `deliveryId` | `DLV-9f3a1c2b7e04` |
| `sourceRef` | `ITM-4b81c9e2a017` |
| `shortname` | `metal.refined` (`itemId` 69511070, `amount` 100, `skinId` `"0"`) |
| `prefab` | `minicopter` |
| `User-Agent` | `OrigemZ-Rust-Agent/<versão>` |

**Formatos**, e o agent os trata como **opacos**: `deliveryId` casa
`/^DLV-[0-9a-f]{12}$/` e `sourceRef` casa
`/^(ITM|KIT)-[0-9a-f]{12}$/` — **o prefixo tem DOIS valores, e isso foi medido, não
escolhido**: o site gera `ITM-` para item avulso e `KIT-` para o item-kit, com a
mesma função (`newItemRef`, `shop-purchase.controller.ts:34-36`, chamada com
`'ITM'` em `:449` e `:675` e com `'KIT'` em `:356`; mais o `ITM-` literal de
`:431` e de `admin-vip.controller.ts:850`), e os doze hex minúsculos saem de
`crypto.randomBytes(6).toString('hex')` nos dois casos. Uma régua `/^ITM-/` — que
é a que o outro manual publicava — **recusa o `sourceRef` de toda tarefa
`kind: 'kit'`**, porque o item-kit do inventário do site nasce com o prefixo
`KIT-`; a linha da tabela acima traz `ITM-` porque o exemplo canônico da fila é um
`kind: 'item'` (§5.7). O agent valida
só tamanho e alfabeto (§5.7) — amarrar o formato aqui criaria uma segunda verdade
sobre um id que não é dele.

####  ESTA TABELA JÁ FOI FALSA, E A PROMESSA ERA A DO OUTRO DOCUMENTO  ####

A §23.6 do manual do site promete que *"todo `curl` deste documento e do manual do
agent usa ESTE jogo de valores"*. Ela era **falsa**: este documento usava
`rifle.ak`, uma oferta `Assault Rifle` de 500 na categoria `cat-armas` e a
`observacao` `Loja in-game: Assault Rifle x1`; o outro usava `metal.refined`,
`Kit Metal` de 250 em `kits` e `Loja in-game: Kit Metal x1`. Os `curl` dos dois
documentos **não eram executáveis um contra o outro**, e todo dublê e todo
fixture escrito a partir de um lado usava ids que o outro nunca produz.

Venceu o jogo do site — não por hierarquia, mas porque ele já estava na seção que
faz a promessa, e porque `kit-metal` chamar-se `Kit Metal` (e não `Assault
Rifle`) é o único dos dois em que o `productId` e o nome batem. Um exemplo em que
o id diz "kit de metal" e o nome diz "fuzil" é uma pegadinha esperando alguém
copiar metade.

**O SALDO sobreviveu àquela reconciliação, e agora não sobrevive.** Depois de
`kit-metal` e `metal.refined` casarem, o 200 da rota de prova ainda saía daqui com
`before` `"1500"` / `after` `"1250"` e de lá com `"500"` / `"250"` — e o mesmo par
errado estava no 200 do débito, no do replay, no `curl` do saldo e nos dublês do
§19.3. Os ids batiam e só o dinheiro não, que é o suficiente para um dublê montado
a partir deste documento falhar contra o site. Venceu o jogo do outro lado, pelo
mesmo motivo dos outros catorze, e o saldo virou **linha da tabela acima**: valor
canônico que não está na tabela é valor canônico que volta a divergir.

### 23.3 O payload de entrega, campo a campo

```
item / kit   { "items": [ { "shortname": string,
                            "amount": int 1..100000,
                            "skinId": string de dígitos, "0" = sem skin } ] }
             item = exatamente 1; kit = 1..40
vip          { "tier": string 1..32, "days": int 1..3650 | null }
             RESERVA DE CONTRATO: nada no site cria este kind na fase 1
vehicle      { "prefab": string, /^[a-z0-9._-]{1,64}$/ — nome curto
                         (minicopter) ou exato (sedantest.entity),
               "fuel": int 0..1000 }
```

**Os três campos onde os manuais divergiram, e a decisão:**

| Campo | Decisão | Evidência |
|---|---|---|
| `skinId` | **STRING de dígitos**, nunca number | `core/src/loadouts/items.ts:87-92`; skin de workshop passa de 2^53 |
| `prefab` | `/^[a-z0-9._-]{1,64}$/` — **o ponto é legal**. Nome curto (`minicopter`) **ou** exato (`sedantest.entity`); nunca `/`, nunca `.prefab` | `Plugins/OrigemZAgent.cs:1160` (a comparação do plugin: `file == needle \|\| file == needle + ".entity"`); `core/src/db/store-repository.ts:111` (por que o curto é o **recomendado**) |
| `amount` | **1..100 000**, não 1..1 000 000 | `core/src/loadouts/items.ts:86` |

O lado que **monta** o payload valida as mesmas réguas e **recusa no resgate**,
com 400, o que não couber. Enfileirar uma tarefa que o agent vai recusar é
prometer entrega que não acontece — e o jogador só descobre tentando.

### 23.4 O vocabulário de `reason`, fechado

Estes são **todos** os valores que podem sair no `reason` de um ACK. A tela de
operação do site traduz esta lista; o que não estiver nela aparece cru para quem
está de plantão.

| `reason` | ACK | Origem |
|---|---|---|
| `PLAYER_NOT_FOUND` | `deferred` | `origemz.give` |
| `PLAYER_DEAD` | `deferred` | `origemz.give` |
| `PLAYER_SLEEPING` | `deferred` | `origemz.give` |
| `INVENTORY_FULL` | `deferred` | `origemz.give` |
| `DROP_FAILED` | `deferred` | `origemz.give` |
| `ITEM_NOT_FOUND` | `failed` | `origemz.give` |
| `TOO_MANY_STACKS` | `failed` | `origemz.give` |
| `INVALID_AMOUNT` | `failed` | `origemz.give` |
| `PLAYER_OFFLINE` | `deferred` | o agent, antes do comando |
| `PRESENCE_UNAVAILABLE` | `deferred` | o agent |
| `RCON_UNAVAILABLE` | `deferred` | o agent |
| `PAYLOAD_INVALID` | `failed` | o agent |
| `UNKNOWN_VIP_TIER` | `failed` | `core/src/vip/service.ts:799` |
| `GIVE_UNREADABLE` | `failed` | o agent, quando o `origemz.give` responde algo ilegível (`core/src/store/service.ts:362`) |
| `VEHICLE_NO_SPACE` | `deferred` | `origemz.vehicle.spawn` (`NO_SPACE` + prefixo) |
| `VEHICLE_*` (outros) | `failed` | `origemz.vehicle.spawn` (idem) |
| `VIP_GRANTER_UNAVAILABLE` | `failed` | o agent (`core/src/store/service.ts:390`) |
| `AGENT_INDETERMINATE` | `deferred` | o agent — e é o **único** `reason` que o site interpreta: ele move a tarefa para `review` |

São **dezoito linhas**. Os oito primeiros são **a lista inteira** do
`origemz.give`, medida em `core/src/kits/service.ts:646-667`.

**As duas linhas de veículo existem, e foram medidas.** O
`origemz.vehicle.spawn` devolve `NO_SPACE`, `VEHICLE_NOT_FOUND`,
`PLAYER_NOT_FOUND`, `INVALID_ARGS` e `INTERNAL_ERROR`
(`Plugins/OrigemZAgent.cs:1046-1120`), e o `#deliver` **prefixa o código cru com
`VEHICLE_`** antes de deixá-lo sair (`core/src/store/service.ts:381`) — daí
`VEHICLE_NO_SPACE`, e daí também o duplo prefixo `VEHICLE_VEHICLE_NOT_FOUND`,
que é feio e é o que sai. Uma versão anterior do manual do site afirmava que
`VEHICLE_NO_SPACE` "não existe"; ela estava errada, e o preço do erro era a
coluna **Motivo** mostrando código cru na falha mais comum de veículo.

**`GIVE_UNREADABLE` também existe** (`core/src/store/service.ts:362`): é o que o
`#deliver` lança quando a resposta do `origemz.give` não é JSON ou não traz
`error` legível. **`RCON_DOWN`, esse não existe** — o código de RCON fora é
`RCON_UNAVAILABLE`; `RCON_DOWN` só aparece na prévia de wipe
(`core/src/wipe/preview.ts:405`), que não é caminho de entrega.

### 23.5 A tabela de tradução de erro

É a do §4.2 deste documento, e ela é a mesma do lado de lá. As linhas em que os
dois manuais **discordavam**, e a decisão:

| Status | `error_code` | Decisão | Por quê |
|---|---|---|---|
| 400 | `MISSING_SERVER_ID` | **`unavailable` / `pairing`** | vem do middleware de autenticação, a mesma família de 401/403/404 que os dois lados já tratam como pareamento. `rejected` fecharia a compra como falha e mostraria "avise a administração" onde o certo é INDISPONÍVEL e re-beacon |
| 403 | `AGENT_IP_NOT_ALLOWED` | `unavailable` / `pairing` | o IP mudou; o conserto é na allowlist |
| 429 | `AGENT_RATE_LIMITED` | `unavailable` / `throttled` | recuar, não desistir |
| 422 | `INSUFFICIENT_BALANCE` | `insufficient` **+ `balance`, `required`, `missing` como number** | ver §5.4, ajuste 4 |
| 500 | `OZ_MUTATION_FAILED` | `unknown` | pode ter cobrado |
| 4xx | **qualquer código desconhecido** | `unavailable` / `network` | `rejected` fecha a compra para sempre; um código novo não pode carregar esse peso |
| 400 | `INVALID_CURSOR` (rota 6) | **descarta o cursor e recomeça do topo** | é o único código do canal em que a regra do 4xx desconhecido produz um **laço eterno** em vez de uma espera: o agent repetiria o mesmo cursor recusado a cada 15 s, e a fila inteira pararia atrás dele (§5.7) |
| 400 | `INVALID_ACK_BODY` / `INVALID_ACK_STATUS` (rota 7) | `rejected` | o `INVALID_ACK_STATUS` recusa o **lote inteiro**: 50 desfechos perdidos por um valor fora dos três. É o guarda que torna o quarto valor de ACK impossível (§5.8) |
| 400 | `SHOP_GAME_NOT_SUPPORTED` (rotas 8 e 9) | `rejected` | o `serverId` autenticado não é de um servidor de Rust. O conserto é no **cadastro** do site, não no corpo |
| 500 | `TRANSACTION_LOOKUP_FAILED` (rota 5) | `unknown` | a prova não foi obtida; a compra segue `charge-unknown` e o settler volta. **Não** é `unprovable`, que é terminal |
| 500 | `ACK_FAILED` (rota 7) | o lote não foi gravado | reenviar o lote inteiro é seguro — o ACK é idempotente |
| 400 | `MIRROR_INVALID_VERSION` / `MIRROR_INVALID_BODY` (rota 8) | `rejected` | defeito NOSSO: a `version` não é 64 hex, ou o corpo não tem a forma. Reenviar o mesmo corpo é laço (§5.9) |
| 500 | `MIRROR_STORE_FAILED` (rota 8) | retentável no laço seguinte | o site quebrou ao gravar; o relógio de 60 s volta (§13.3). **Não** é `unknown`: o espelho não mexe em dinheiro |
| 400 | `INVALID_STEAM_ID` / `INVALID_REFERENCE_ID` (rota 5) | **`unprovable`** | nesta rota os 400 são **terminais de reconciliação**, e não `rejected`: a referência gravada torta produz 400 para sempre, e o settler bateria eternamente (§5.6, §11.4) |

**Seis destes códigos existiam só no manual do site**, e três — os do espelho —
existiam **aqui**, no §5.9, mas **fora** da tabela do §4.2. É o mesmo defeito, e
não um defeito menor: quem implementa o classificador implementa a **tabela**, não
a prosa da seção da rota. O último item da lista acima não é código nenhum, e sim
um **recorte**: na rota 5, os dois 400 já conhecidos deixam de ser `rejected` e
viram `unprovable`.

Enquanto qualquer um deles ficasse de fora, ele cairia na regra do 4xx/5xx
desconhecido. Para a maioria isso é só uma espera; para `INVALID_CURSOR` é a fila
parada para sempre, e para os dois 400 da rota 5 é o settler batendo todo minuto
num pedido que nunca vai passar. A tabela do §4.2 é o **classificador único** do
canal, e um código que não está nela não é "tratado por padrão" — é tratado por
acidente.

### 23.6 O que atravessa o fio, e o que não

**Atravessa:** os **três** valores de ACK (`delivered`, `failed`, `deferred` — e
não há um quarto), o `reason` da §23.4, o payload da §23.3, os `error_code` da
§23.5 e o `cursor`/`next` da fila (§5.7), que é **opaco** dos dois lados.

**Não atravessa:** os estados internos. O agent tem **cinco** em
`site_deliveries` — `reserved | delivered | failed | indeterminate | expired` — e
o site tem **seis** em `agent_deliveries`:
`pending | delivered | failed | expired | review | needs_admin` (§8.2 e §8.3 do
manual do site). São **máquinas de estado independentes, em bancos diferentes**,
e as palavras que coincidem precisam ser lidas com cuidado:

| Palavra | No agent | No site |
|---|---|---|
| `review` | **não existe como estado local nem como valor de ACK.** O estado local equivalente chama-se `indeterminate` | a tarefa que o agent ACKou com `deferred` + `AGENT_INDETERMINATE`, e **só** ela. **Mesmo sentido do `indeterminate` daqui** — *"pode ter saído"* |
| `review` (de novo) | o `SettleOutcome` da rota de settle (§11.6) devolve a string `'review'` para dizer "esta COMPRA saiu do laço" — é **dinheiro, não entrega**, e não atravessa o fio | — |
| **`needs_admin`** | **não existe, e o agent nunca o vê**: a tarefa nasce nesse estado no próprio site e não é servida em `/deliveries/pending` | *"o mesmo item já falhou `FAILED_MAX` (5) vezes; alguém precisa olhar"*. Item continua em `processing`, e o relógio não o toca |
| `pending` | não existe: o que ainda não foi tentado não tem linha local nenhuma (a linha nasce na **reserva**, §10.2 passo (e)) | a fila propriamente dita — e **um ACK `deferred` a mantém aqui**, com `attempts++` |
| `expired` | o site devolveu o id em `unknown` e a linha não era terminal | o TTL venceu e o item voltou para `available` — e **`delivered` ainda vence `expired`** (regra 3-bis, §5.8 e §8.7 do manual do site): o ACK de entrega chegado depois da expiração é aplicado, e volta em `applied` |
| `failed` | falha definitiva da entrega | idem, e o item volta para `available` |

####  O ARGUMENTO DO NOME `indeterminate` MUDOU, E CONTINUA DE PÉ  ####

**Este documento já disse que `review`, no site, era "a tarefa que falhou 5
vezes".** Não é mais: o site **renomeou** esse estado para `needs_admin`
justamente para desfazer a colisão, e hoje `review` quer dizer a **mesma coisa**
nos dois lados (§8.3 do manual do site). O argumento antigo — *"são coisas
diferentes com o mesmo nome"* — morreu com a renomeação, e deixá-lo escrito seria
sustentar uma decisão certa com um motivo falso.

O nome local continua sendo `indeterminate`, e agora por três razões que a
renomeação **não** desfez:

1. **As duas contagens não têm de bater, por construção.** Uma tarefa que um
   admin liberou pela §21.8 do manual do site sai de `review` **lá** e continua
   `indeterminate` **aqui**, até o `unknown` do ACK seguinte fechá-la. Duas telas
   com o mesmo rótulo e números diferentes é diagnóstico errado às três da manhã.
2. **O site tem um segundo estado humano que o agent nunca vê.** `needs_admin`
   não sai em `/deliveries/pending`, então a população de "tarefas paradas
   esperando gente" do lado de lá é **maior** que a daqui — e sempre será.
3. **O fio não carrega nenhum dos dois nomes.** O que viaja é
   `status: 'deferred'` com `reason: 'AGENT_INDETERMINATE'` (§23.4). O nome do
   estado é assunto de cada banco; o `reason` é o contrato.

### 23.7 O que ainda NÃO tem contrato, e é honesto dizer

**Três** coisas que este documento pediu ao outro lado **já foram decididas**, e
ficam registradas aqui — riscadas, não apagadas — para que ninguém reabra a
discussão lendo uma versão antiga:

- ~~**O quarto valor de ACK (`review`).**~~ **DECIDIDO: não existe.** O fio
  carrega três valores, e o indeterminado viaja como `deferred` +
  `reason: 'AGENT_INDETERMINATE'` (§5.8, §10.4). O site move a tarefa para
  `review`, tira-a de `/pending` e ainda filtra
  `last_reason <> 'AGENT_INDETERMINATE'` na varredura de expiração — o mesmo
  buraco fechado, com cinto de segurança. O agent cedeu porque a solução do site
  não exige versionar os dois lados no mesmo instante.
- ~~**`REFERENCE_NOT_MINE`.**~~ **DECIDIDO: o site cria o código.** Custo medido:
  uma linha no controller da rota de prova (§6.4 do manual do site). Ele é
  devolvido quando a linha existe mas o `steamId` ou o `serverId` não conferem, e
  o agent o trata como `unprovable` (§5.6, §11.4). Sem ele, "é de outro jogador"
  chegaria como prova de que nada foi cobrado — a leitura que perde dinheiro.

- ~~**Falta especificar um caminho de admin para uma entrega parada em
  `review`/`processing`.**~~ **RESOLVIDO: o site especificou a rota.** A premissa continua certa —
  o `reconcile` do site despacha por um mapa que só conhece `conanexiles` e
  `scum`, o `restoreInventoryItem` exige `deletedAt`, e nenhum dos dois toca um
  item de Rust em `processing` —, mas a rota **existe**:
  `POST /api/admin/rust/deliveries/:deliveryId/release`, especificada na §21.8 do
  manual do site com corpo, os quatro desfechos, a guarda
  `where: { id, status: 'processing' }`, o `auditLog` e a tela da §20.4. A
  conciliação de entregas **não** é mais "manual, por SQL": o SQL virou o plano
  de emergência, e está dito assim no §22.13. Só `review` e `needs_admin` são
  liberáveis — os outros quatro estados ou já devolveram o item, ou ainda estão
  vivos, ou têm prova.

Sobra **uma** coisa como risco escrito, e ela não é de contrato: é de prova.

**Não há um teste que prove que os dois documentos concordam**, e essa é a maior
fragilidade que sobra. O artefato que a resolveria é um arquivo de **fixtures
compartilhado** — os corpos de requisição e resposta das quatorze rotas, versionado
num lugar só e consumido pelos testes dos dois repositórios. Enquanto ele não
existir, `skinId` string × number e o alfabeto de `prefab` continuam
podendo divergir sem que nenhum teste acuse.

### 23.8 O retrato do servidor — `POST /api/agent/server/status` (Lote 2)

> **Direção, como todo o resto deste canal: o agent empurra, o site nunca chama.** Não existe rota
> de leitura do lado do agent para o site consultar. Quem sabe o estado do processo é quem roda na
> máquina dele, e a `base_url` fixada no primeiro beacon é HTTP puro deduzido do IP do socket,
> atrás de NAT residencial. **Isto é telemetria**: nenhum desfecho desta rota pode mexer em loja,
> carteira ou entrega.

```
POST /api/agent/server/status
Authorization: Bearer <o bearer daquele servidor>
X-Server-Id: <o serverId no site>          (STRING EXATA, maiúsculas incluídas)
Content-Type: application/json
User-Agent: OrigemZ-Rust-Agent/<versão>
```

**Cadência: 30 s**, uma batida por pareamento, mais uma no boot do agent (o site sabe do servidor no
primeiro segundo, não no trigésimo). Do lado do agent, `SITE_STATUS_INTERVAL_MS` (default 30 000,
piso 10 s, teto 300 s) e `SITE_STATUS_PUSH_ENABLED`. **Carga: +2 req/min por servidor pareado.**

**Limitador PRÓPRIO, 30/min por `serverId`** — instância separada do limitador de 240/min das outras
rotas. Cada limitador tem contador próprio, e a separação é o ponto: um laço de status mal escrito
não pode gastar a cota da **fila de entregas**, que carrega item que o jogador já pagou. O teto é 30
e não 12 por causa do pico durante uma `operation` (o agent empurra a cada mudança de progresso —
até ~20 num update — mais o laço de 30 s por baixo).

**Um retrato por `serverId`, e o retrato SUBSTITUI.** A PK é o `server_id`, a gravação é upsert e
**não há histórico nem série temporal**. Não é economia de disco: a lista guarda QUEM estava online,
e acumular isso ao longo do tempo é rastreamento de presença com retenção indefinida. Aqui só existe
o AGORA.

#### O corpo, por extenso

```json
{
  "at": "2026-09-03T14:00:00.000Z",
  "agent":  { "version": "1.0.0", "uptimeSeconds": 3600, "health": "ok" },
  "server": {
    "running": true, "pid": 4812, "installed": true,
    "hostname": "OrigemZ Rust #1", "map": "Procedural Map",
    "worldSize": 3500, "seed": 1234567, "maxPlayers": 200,
    "rcon": { "connected": true, "state": "connected" }
  },
  "players": {
    "online": 2, "max": 200, "source": "plugin",
    "list": [
      { "steamId": "76561198000000000", "name": "Bob", "isAlive": true,  "isSleeping": false },
      { "steamId": "76561198000000001", "name": "Ana", "isAlive": null,  "isSleeping": null  }
    ]
  },
  "build":   { "installed": "17242398", "published": "17242398", "updateAvailable": false,
               "checkedAt": "2026-09-03T13:40:00.000Z", "autoUpdate": true },
  "machine": { "hostname": "RUSTHOST", "platform": "win32",
               "cpu": { "model": "AMD Ryzen 9 5950X", "cores": 32, "speedMhz": 3400 },
               "memory": { "total": 68719476736, "free": 21474836480 },
               "disk":   { "total": 1000204886016, "free": 412316860416 },
               "uptimeSeconds": 864000, "load1": null },
  "operation": { "id": "op_7f2c", "kind": "server-update", "status": "running",
                 "progress": 42, "message": "baixando 4,2 GB" },
  "kinds": ["server-install","server-update","server-start","server-stop","server-restart",
            "server-auto-update","oxide-install","wipe-run"]
}
```

**Resposta 200:** `{ "ok": true, "accepted": true, "receivedAt": "<ISO do relógio do SITE>" }`.

#### Campo a campo, e o que o site faz com cada um

| Campo | Tipo real | O que o site faz |
|---|---|---|
| `at` | ISO 8601 — **o relógio do AGENT** | diagnóstico. Fora de ±10 min do relógio do site é **descartado** (`generatedAt: null`) e a linha carrega `agentClockSkewed: true`. **Não serve para ordenar** contra o relógio do site — o carimbo autoritativo é o `receivedAt`, do site |
| `agent.version` | string | ≤32 chars |
| `agent.uptimeSeconds` | number | inteiro, 0..2^31-1 |
| `agent.health` | **`ok` \| `degraded`** | `degraded` = o jogo está no ar e o agent não fala com ele. Servidor parado **não** é `degraded`: quem o parou foi um humano |
| `server.running` / `installed` | boolean | booleano estrito (a string `"true"` não liga nada) |
| `server.pid` | number \| null | 0..4194304 |
| `server.hostname` | string | ≤120 |
| `server.map` | string | cortado em 64 no agent, coluna de 80 no site. **A coluna se chama `map_name`**; o nome do contrato continua `map` |
| `server.worldSize` / `seed` | number | `worldSize` 0..100000; `seed` é **int32** (fora da faixa vira `null`, nunca estoura o INSERT) |
| `server.maxPlayers` | number | ver `players.max` abaixo — **uma** verdade só |
| **`server.rcon`** | objeto **ou `null`** | `null` = servidor desligado **não tem contexto de RCON**. `rcon.state: null` é *sem contexto*, **não** "desconectado" — a tela mostra "—". `connected` é derivado do `state` quando ele vem |
| `players.online` | number | 0..10000, e clampado em `max` quando `max > 0` |
| `players.max` | number | **vence** `server.maxPlayers`; o banco guarda **uma** coluna. Duas colunas discordariam no primeiro push em que só uma viesse |
| **`players.source`** | **`plugin` \| `nativo` \| `unavailable`** | string sanitizada, **sem enum fechado** — enum estrito aqui derruba batida legítima no dia em que o vocabulário crescer. `nativo` está em português: é o `playerlist` do Rust, e o nome é antigo no domínio do agent |
| `players.list[]` | opcional | **até 300** entradas; acima disso a lista é cortada e a linha carrega `playersTruncated`. Entrada com `steamId` que não case `/^7656119\d{10}$/` é **descartada** (não convertida) |
| `players.list[].steamId` | **string** | SteamID64 passa de 2^53: como número já chega corrompido do `JSON.parse`, antes de qualquer coluna |
| `players.list[].name` | string | ≤64 |
| **`isAlive` / `isSleeping`** | **`true` \| `false` \| `null`** | **tri-state.** `null` na fonte `nativo`, que não sabe. Colapsar em `false` transformaria "não sei se está vivo" em "está morto" |
| `build` | objeto ou `null` | `installed`/`published` são **strings de dígitos** (build id da Steam passa de 2^53); os três — `installed`, `published`, `checkedAt` — **podem ser `null`**: jogo não instalado, ou o vigia ainda sem primeira consulta. **O agent NUNCA força consulta à Steam para montar o retrato** |
| `machine.cpu` | objeto | `model`/`cores`/`speedMhz`. **Não existe CPU%** — ver abaixo |
| `machine.memory` | `{total, free}` | bytes, exatos até 2^53 |
| **`machine.disk`** | `{total, free}` | **`{total:0, free:0}` = ILEGÍVEL** (disco de rede, contêiner), **não** disco cheio. O site guarda como veio e expõe `disk.readable` na rota admin: sem esse flag, "0 livre de 0" desenha uma barra 100% vermelha e o admin sai procurar um disco cheio que não existe |
| **`machine.load1`** | number \| **`null`** | **`null` SEMPRE no Windows** (o `loadavg` de lá é `[0,0,0]`, e devolver isso seria inventar medida) |
| `operation` | objeto ou `null` | **`null` é o estado NORMAL** (nada rodando), não falta de dado. `status` hoje é **sempre `running`**; `progress` pode ser `null`; `message` é truncada em **300** |
| **`kinds`** | string[] | até **8** valores hoje: `server-install`, `server-update`, `server-start`, `server-stop`, `server-restart`, `server-auto-update`, `oxide-install`, `wipe-run`. Sem jogo em disco vem só `["server-install"]`. **O site valida FORMA, não VALOR** (slug minúsculo, dedup, teto 16): a lista é do agent e vai crescer, e uma allowlist de valor faria a ação nova sumir do painel na versão seguinte, sem erro nenhum. **`kinds` NUNCA autoriza nada** — é o menu que a tela pode desenhar; quem autoriza executar são as capabilities, no servidor |

#### NÃO EXISTE CPU EM PORCENTAGEM

Ela exige duas leituras separadas no tempo (`os.cpus()` dá tempo acumulado desde o boot), e uma
leitura só produziria a média desde que a máquina ligou — número que não muda e que ninguém sabe
interpretar. **Decisão escrita do lado do agent** (`core/src/http/routes/system.ts:10-18`, repetida
em `core/src/util/machine.ts`). O campo `machine.cpu.usagePct` sai **`null` sempre** da rota admin, e
a tela mostra "—". Um `0%` inventado seria pior que a ausência: pareceria um servidor ocioso.

#### POSIÇÃO DE JOGADOR NUNCA SOBE

A rota de jogadores do agent devolve `position` e `grid` quando o plugin está ligado, e **ela para
ali**. Posição viva de terceiro é intel de raid. Os dois lados montam a linha **campo a campo, os
mesmos quatro campos**, e nenhum dos dois usa espalhamento (`...player`): um espalhamento escrito por
conveniência levaria a posição junto — sem erro, sem teste vermelho, e sem ninguém perceber até
alguém do outro lado descobrir onde a base de um jogador está. **Não relaxe isto para "só o grid":
grid é posição.**

E `isAlive`/`isSleeping` são a **mesma classe de dado**, não detalhe cosmético: em Rust, "o Fulano
está dormindo agora" é o gatilho de raid — o corpo está parado dentro da base. No site eles saem sob
a mesma capability que os nomes (`rust-players`, que **nasce desligada**), e a rota admin devolve
`listAvailable` / `listVisible` separados para que "não tenho permissão", "o agent não mandou lista"
e "não tem ninguém online" não fiquem indistinguíveis na tela.

#### Os tetos, e por que o 413 é caminho vivo

| Teto | Valor | Onde |
|---|---|---|
| corpo **sem** lista | **8 KB** | conferido **no controller** do site e, antes de sair, no agent |
| orçamento por entrada da lista | **+200 B** por jogador | o teto **escala com o tamanho REAL da lista**, não com a mera presença dela |
| corpo **com** lista | **64 KB** (teto absoluto) | idem |
| lista de jogadores | **300** entradas | acima disso corta e marca `playersTruncated` |
| tamanho real medido | **~1 KB** sem lista · **~35 KB** com os 300 do teto | ~113 B por entrada — os 200 B de orçamento são quase o dobro, de propósito |

O teto é conferido **no controller**, não no `express.json({limit})` do router: o app já parseou com
um limite maior, e o do router é letra morta. E ele escala com a lista porque um `"players":{"list":[]}`
de dois caracteres não pode comprar os 64 KB inteiros — se comprasse, o teto efetivo para qualquer
remetente seria sempre o maior, e os 8 KB do corpo sem lista viravam letra morta.

**O 413 é caminho vivo, não teórico, e tem consequência combinada:** ao receber 413 o agent **tira a
lista por 10 minutos** e depois volta a mandá-la. Um teto apertado demais não derruba o retrato — ele
**apaga os nomes por 10 min, em silêncio**, e a aba Status fica com a contagem e sem a lista sem
ninguém entender por quê. **Se for mexer nesses números, mexa para cima.**

Do lado do agent a ordem é uma só: tenta com a lista, cai para o retrato sem ela, e **desiste** quando
nem o retrato pelado cabe. **A contagem é o que não pode faltar** — `online`/`max` são obrigatórios, a
`list` é opcional. Perder o número por causa do tamanho da lista seria trocar o essencial pelo
acessório.

#### A tabela de respostas

| Status | `error_code` | Significa | O que o agent faz |
|---|---|---|---|
| **200** | — | `{ok, accepted:true, receivedAt}` | segue |
| **200** | — | **`{ok:true, accepted:false, reason:'STALE_SNAPSHOT'}`** | **não é erro e NÃO se retenta.** Um push que travou na rede chegou depois do seguinte; o site recusou porque o `generatedAt` deste é anterior ao do último gravado. Um 4xx/5xx aqui faria o agent reenviar para sempre o retrato que acabou de ser recusado por velho |
| 400 | `STATUS_GAME_NOT_SUPPORTED` | este `serverId` não é de Rust (a tabela `agents` é compartilhada com DayZ e Conan e **não tem coluna de jogo**) | defeito de cadastro |
| 400 | `STATUS_INVALID_BODY` | o corpo não é um objeto, ou não é serializável | defeito nosso |
| **401 / 403 / 404** | de pareamento | bearer, `serverId` ou ativação | `unavailable`/`pairing`: **acorda o beacon** (que tem freio próprio de 5 s) e mostra na tela de pareamento. Este laço **não** retenta por conta própria — os 30 s são a espera |
| **404** | **sem `error_code`** | **o Lote 2 do site ainda não subiu** | **NÃO acorda o beacon** — o pareamento está inteiro, e um `suspect` a cada 30 s por servidor faria o beacon bater sem motivo até o dia em que a rota nascesse. Só uma linha de log, com freio de repetição de 10 min |
| 403 | corpo em **TEXTO PURO** com `error code: 1010` | a **borda** recusou o `User-Agent` | **não é ban**, não é pareamento. Continua |
| **413** | `STATUS_TOO_LARGE` | o corpo estourou o teto | **tira a lista por 10 min** e segue mandando a contagem. Ver o bloco acima |
| 429 | `AGENT_RATE_LIMITED` | cota do limitador próprio | recua; a volta seguinte tenta de novo |
| **5xx** | `STATUS_STORE_FAILED` | falha ao gravar | a volta seguinte tenta. **Nada é retentado na hora**: um retrato não vale um laço apertado contra o site |
| timeout / DNS / TLS | — | rede | idem |

#### As regras que amarram esta rota

1. **Campo ausente ou `null` NUNCA pode virar 400.** Um schema exigente quebra o laço de 30 s **em
   silêncio**, e o sintoma que chega ao dono é *"a aba Status congelou"* — que não se parece em nada
   com a causa. O site **clampa e descarta** valor fora de faixa, e **ignora chave que não conhece**.
   É o oposto deliberado da regra do ACK de entregas, onde valor fora do vocabulário **é** 400: lá o
   valor decide o destino de um item pago; aqui decide um pixel.
2. **Chave desconhecida é ignorada, não recusada.** Um agent que ganhou um campo novo numa versão
   mais nova não pode ver o laço inteiro morrer com 400. A gravação é por **allowlist** — o que este
   contrato não nomeia simplesmente não entra na linha — e a leitura admin também: nada de
   `toJSON()`, senão uma coluna nova vazaria sozinha para todo mundo que tem a aba.
3. **`0` nunca substitui medida ausente.** `players.online: 0` com `source: 'unavailable'` é "não deu
   para perguntar" (o site expõe isso como `players.onlineKnown`); `disk {total:0, free:0}` é
   ilegível (o site expõe `disk.readable`); `load1: null` e `cpu.usagePct: null` são "não medido".
   Ausência de medida tem que continuar parecendo ausência de medida, para a tela desenhar "—".
4. **Nenhum campo `balance`, `ozBalance` ou `epBalance`, em nível nenhum do corpo.** Um middleware
   global do site responde **403 sem `error_code`** e o request morre antes do controller — do lado
   do agent esse 403 é indistinguível de "fui despareado". Os dois lados têm rede contra isso.
5. **O carimbo que vale é o do SITE.** `receivedAt` é a única coisa que distingue *"o servidor está
   offline"* (retrato **fresco** dizendo `running:false`) de *"o agent parou de falar"* (retrato
   **velho** dizendo qualquer coisa) — as duas coisas parecem iguais na tela sem ele, e levam a
   lugares opostos.

---

### 23.9 As quatorze rotas

| # | Método · caminho | Estado | Request | Response 200 |
|---|---|---|---|---|
| 1 | `POST /beacon` | existe | `{ serverId, port, version, mac, capabilities[] }` + (se ativo) `X-Agent-Timestamp`, `X-Agent-Signature` | `{ ok, registered, status, serverExists, resolvedViaAlias, currentServerId, message }` |
| 2 | `GET /ozcoins/balance?steamId=` | existe | query `steamId` (17 dígitos) | `{ steamid, moedas }` — **duas chaves**; o `exists` saiu em `oz-rust/6` (D20) |
| 3 | `POST /ozcoins/debit` | existe | `{ steamId, amount, referenceId, observacao?, productId? }` | fresco: `{ success, steamid, moedas, before, after, amount, direction:'debit', transactionId }` · replay: `{ success, idempotent:true, steamid, moedas, before, after, amount, direction }` |
| 4 | `POST /ozcoins/credit` | existe | `{ steamId, amount, referenceId, observacao? }` | igual ao 3, com `direction:'credit'` |
| 5 | `GET /ozcoins/transaction?referenceId=&steamId=` | existe | query, ambos obrigatórios | `{ found:true, transactionId, steamid, serverId, direction, amount, before, after, productId, observacao, createdAt }` |
| 6 | `GET /deliveries/pending?limit=&cursor=` | existe | query opcional | `{ ok:true, deliveries:[…], next }` |
| 7 | `POST /deliveries/ack` | existe | `{ deliveries:[{ id, status, reason?, at }] }` (1..50) | `{ ok:true, applied, unknown:[…] }` |
| 8 | `POST /shop/mirror` | existe | `{ version, generatedAt, currency, categories[], offers[] }` (≤2 MiB) | `{ ok:true, accepted:true, version, storedAt }` |
| 9 | `GET /shop/mirror/version` | existe | — | `{ ok:true, version, updatedAt }` |
| 10 | `POST /server/status` | existe (Lote 2) | o retrato inteiro — `{ at, agent, server, players, build, machine, operation, kinds }`; 8 KB + 200 B por jogador, teto 64 KB | `{ ok:true, accepted:true, receivedAt }` · retrato velho: `{ ok:true, accepted:false, reason:'STALE_SNAPSHOT', receivedAt }` |
| **11** | `POST /commands/claim` | **medido 04/09** | `{ limit? }` (aceito e **clampado em 1**) | `{ ok:true, commands:[{ id, kind, params, issuedAt, expiresAt, ttlMs, leaseToken }], maxPerClaim }` |
| **12** | `POST /commands/ack` | **medido 04/09** | `{ commands:[{ id, leaseToken, status, reason?, operationId?, at }] }` (1..10) | `{ ok:true, results:[{ commandId, applied, status, outcome }] }` — **uma linha por entrada, NÃO `{applied, unknown[]}`** (ver a ERRATA abaixo) |
| **13** | `GET /server/config` | **medido 04/09** | — (`If-None-Match` opcional) | `{ ok:true, version, desired:{…}\|null, restartRequiring:[…] }` · **304** sem corpo. `version:0` + `desired:null` = nada declarado; `Cache-Control: no-store` |
| **14** | `POST /server/config/ack` | **medido 04/09** | `{ version, applied, requiresRestart:[], errors:[{field, code}] }` — `version` inteiro **≥ 1** | `{ ok:true, recorded, currentVersion }` · `version:0` ⇒ **400 `CONFIG_INVALID_VERSION`** |

> ####  ERRATA DE 04/09/2026 — AS LINHAS 11 A 14 FORAM CORRIGIDAS CONTRA O CÓDIGO  ####
>
> A linha 12 dizia `{ ok:true, applied, unknown:[…] }` — que é a resposta do ACK de **ENTREGA**
> (linha 7), copiada para cá quando o Lote 3 foi escrito, antes de existir código dos dois lados.
> **O site nunca respondeu isso nesta rota.** A linha 14 dizia `{ ok:true, accepted:true }` e o que
> atravessa é `{ ok:true, recorded, currentVersion }`. A primeira sonda real
> (`npm run site:probe -w core`, 04/09/2026) mediu as duas, e o **código é o árbitro**.
>
> **A etiqueta NÃO subiu, e é decisão:** ela marca mudança **no fio**, e aqui nenhum byte mudou — o
> que mudou foi o manual parar de mentir. Subi-la mandaria os dois lados procurarem uma alteração de
> comportamento que não existe, e as etiquetas `/7`, `/8` e `/9` estão reservadas para as quatro
> áreas de config avançada. **Quem precisa saber se a sua cópia destas quatro linhas está em dia não
> olha a etiqueta — olha `contracts/oz-rust-fixtures.json`**, que carrega os corpos `observed` e é o
> árbitro destas células desde esta data.
>
> As três divergências, com a decisão de cada uma, estão por extenso no **§23.10 do manual do site**
> (`docs/mateuus/rust/docs/INTEGRACAO-OZCOIN-RUST.md`) e resumidas no `Docs/21` §9.
>
> ⚠️ **Duas consequências práticas para este repositório:**
> 1. **`leaseToken` é `/^[0-9a-f]{32}$/`** — 32 hex, gerados pelo site
>    (`rustCommandQueue.newLeaseToken`). A fixture `manual` do claim traz `"b7c1cafe"` (8 chars); um
>    ACK com um token desse formato volta `outcome: 'invalid_lease'` e **a linha não fecha**. O
>    formato do `leaseToken` é do **site** pela regra de desempate do §23.1 — regere aquela fixture.
> 2. **O `outcome` de `results[]` é vocabulário fechado:** `applied` · `invalid_lease` · `stale` ·
>    `not_found` · `invalid_id` · `invalid_status` · `invalid_entry`. No `invalid_entry` o
>    `commandId` vem **`null`** — quem consumir `results[]` precisa tolerar.

> **A rota 10 é TELEMETRIA e tem limitador PRÓPRIO (30/min), separado dos 240/min das rotas 3-9.**
> Contador separado é o ponto: um laço de status mal escrito não pode gastar a cota da fila de
> entregas, que carrega item que o jogador já pagou. Campo a campo na seção do **retrato do
> servidor**, nos dois manuais.

> **As rotas 11-14 são do Lote 3 e EXISTEM nos dois lados desde 04/09/2026** — no site,
> `agent-commands.controller.ts` e `agent-server-config.controller.ts`; no agent,
> `core/src/site/commands.ts` e `core/src/site/config.ts`. ⚠️ **As duas pontas nunca falaram uma com
> a outra**: os testes dos dois lados falam com dublês. Elas nasceram contra este contrato, escrito
> antes das duas, e é essa a única defesa contra o que já aconteceu com `skinId` e `prefab`.

### 23.10 Comandos e config vindos do site (Lote 3)

> **AS DUAS PONTAS EXISTEM, E NUNCA FALARAM UMA COM A OUTRA.** Em 04/09/2026 o site tem as quatro
> rotas e o agent tem os dois laços — mas **todo teste dos dois lados fala com um dublê**. O
> contrato foi escrito **antes** do código de propósito, e é a única defesa que sobrou depois de
> `skinId` e `prefab`: se as duas implementações divergirem, os testes dos dois lados passam e a
> integração falha. **O manual do agent é
> `F:/Projects/RustAgent/Docs/22-COMANDOS-E-CONFIG-DO-SITE.md`**, e é lá que mora o porquê
> estendido de cada regra abaixo.

**Direção, como todo o resto deste canal: o agent puxa, o site nunca chama.** As duas coisas que
nascem aqui são um **laço de comandos** (10 s) e um **laço de config** (30 s, ou por `ETag`), os
dois saindo da máquina do agent. Nenhuma porta nova é aberta lá.

#### Os headers e a cadência

Idênticos aos das outras rotas autenticadas — `Authorization: Bearer <bearer daquele servidor>`,
`X-Server-Id: <serverId>` (string exata), `Accept`, `User-Agent: OrigemZ-Rust-Agent/<versão>` e
`Content-Type` nos POST.

| Laço | Intervalo | Por quê |
|---|---|---|
| `commands/claim` | **10 s** | é o teto do critério de aceite ("de *enfileirado* a *executando* em ≤10 s") |
| `server/config` | **30 s**, junto do laço de status, **ou** por `ETag` | config é estado, não tarefa: ninguém está esperando na frente da tela |

**Carga: +6 req/min por servidor pareado.** As quatro rotas ficam sob o limitador de 240/min por
`serverId` das rotas 3-9 — **não** sob o de telemetria da rota 10: comando é ação de admin, e não
pode disputar cota com um laço de status.

#### As quatro rotas, campo a campo

```
POST /api/agent/commands/claim        { "limit": 5 }
  → { ok, commands: [ { id: "CMD-9f3a1c2b7e04", kind, params, issuedAt, expiresAt, ttlMs, leaseToken } ] }

POST /api/agent/commands/ack          { "commands": [ { id, leaseToken, status, reason?, operationId?, at } ] }
  status ∈ accepted | executed | failed | refused          (lote 1..10)
  reason FECHADO: OPERATION_NOT_ALLOWED, SERVER_RUNNING, SERVER_NOT_RUNNING, RCON_UNAVAILABLE,
                  RCON_TIMEOUT, NOT_INSTALLED, SERVER_DISABLED, COMMAND_EXPIRED, AGENT_BUSY, UNKNOWN_KIND

GET  /api/agent/server/config         → { ok, version: 7, desired: { name, hostname, description,
                                          maxPlayers, map, worldSize, seed,
                                          autoUpdate } }                          (ETag/304)
POST /api/agent/server/config/ack     { version, applied, requiresRestart: [], errors: [{field, code}] }
```

| Campo | Tipo | Regra |
|---|---|---|
| `id` | string | `/^CMD-[0-9a-f]{12}$/` — mesmo formato de `DLV-`. **Quem gera é o site** — a regra de desempate diz que formato de id é dele |
| `kind` | string | **um dos três** da allowlist abaixo. Qualquer outro ⇒ `refused` + `UNKNOWN_KIND` |
| `params` | object | objeto, possivelmente vazio. Chave desconhecida é ignorada, nunca recusada. **Ainda não está fechado** — ver o fim desta seção |
| `issuedAt` | ISO 8601 | quando o admin clicou. Diagnóstico |
| `expiresAt` | ISO 8601 | prazo **absoluto**, relógio do site |
| `ttlMs` | number | o **mesmo** prazo, relativo. Existe por causa do `clock skew` |
| `leaseToken` | string | opaco dos dois lados. **Volta no ACK**, e só ele fecha a linha |
| `status` | enum | `accepted` · `executed` · `failed` · `refused` — e **não há um quinto** |
| `reason` | string? | **obrigatório** em `refused`, opcional em `failed`. Fora da lista fechada é **400** |
| `operationId` | string? | o id da `operation` local do agent — é o que liga a linha do site ao log de lá |
| `version` | number | inteiro que só cresce, por servidor. Igual à última aplicada ⇒ nada a fazer |
| `desired` | object | **campo ausente = "o site não opina sobre ele"**. Não é `null`, não é "apague". **Oito chaves** desde a onda 1 — ver o quadro do `autoUpdate` |
| `desired.autoUpdate` | boolean? | **ausente ≠ `false`.** Ausente = o site não gerencia (mantenha o seu); `false` = **desligue**. Único campo de `desired` que **não** vai pelo `updateSettings` |
| `applied` | boolean | `true` se a gravação aconteceu, mesmo com algum campo em `errors[]` |
| `requiresRestart` | string[] | **exatamente o que o `updateSettings` do agent devolveu**, nunca uma lista escrita à mão |
| `errors` | `{field, code}[]` | um por campo que não entrou. O resto entrou |

**`commands: []` é a resposta normal** do claim — é o que 99% das rodadas devolvem. Não é erro, não
acende nada na tela e não acorda o beacon.

#### As dez regras, e por que cada uma existe

1. **`/claim` NÃO é leitura.** A linha sai da fila no próprio pull, com o `leaseToken`. Puxar duas
   vezes **não** devolve o mesmo comando — é o que torna o desenho *at-most-once*. Um `GET`
   idempotente aqui reiniciaria o servidor duas vezes a cada retry de rede.
2. **O `leaseToken` volta no ACK.** ACK sem ele, ou com token velho, é descartado como `unknown` e a
   linha não muda de estado. O token é a prova de que quem ACKa é quem puxou — e o `id` aparece no
   log e na tela.
3. **Comando expirado NÃO executa.** `expiresAt < agora` ⇒ ACK `refused` + `COMMAND_EXPIRED`. O site
   também filtra antes de entregar, mas **dois relógios é o certo**; e o agent tem um teto local
   próprio (*"não executo o que puxei há mais de 60 s"*), porque entre o claim e o RCON há backoff
   real. O caso que isso mata: o admin clica, nada acontece, ele resolve de outro jeito, e quarenta
   minutos depois o comando velho reinicia um servidor cheio.
4. **Um comando por vez, por servidor.** Operação já rodando ⇒ ACK `refused` + `AGENT_BUSY`, e
   **nunca** enfileirar localmente. A fila é do site — é lá que ela é visível, cancelável e
   auditada. Uma segunda fila dentro do agent some no `pm2 restart` e ressuscita ordem que o admin
   já desistiu de dar.
5. **`kind` desconhecido ⇒ ACK `refused` + `UNKNOWN_KIND`**, nunca ignorar em silêncio. Sem o ACK o
   comando fica pendurado até expirar e o admin não sabe por quê — que é exatamente o sintoma de
   site novo contra agent velho.
6. **Duas batidas: `accepted` no claim, `executed`/`failed` no desfecho.** Sem o `accepted`, o
   painel não distingue *"o agent não viu"* de *"está rodando"* — os dois parecem "enfileirado" e
   levam a lugares opostos.
7. ⚠️ **Dedup local persistente.** O agent grava o `commandId` **em disco antes de executar** e
   recusa id já visto. Sem isso, o *at-most-once* do site não sobrevive a um agent que puxou,
   executou o `server-restart`, caiu junto com o servidor e voltou sem ter ACKado.
8. **O agent nunca re-executa por conta própria.** Comando puxado é comando consumido; falhou, ACK
   `failed` e acabou. Quem tenta de novo é o admin, gerando um `CMD-…` novo. Retry local transforma
   "reiniciar uma vez" em "reiniciar até dar certo".
9. **`clock skew` é fato, não hipótese.** O site manda `expiresAt` absoluto **e** `ttlMs` relativo, e
   o agent usa **o menor**. O beacon já convive com ±120 s de tolerância e o retrato descarta `at`
   fora de ±10 min: skew de minutos entre as duas máquinas é medido, não hipotético.
10. **Config é ESTADO, não tarefa — sem TTL.** Compare `version`, aplique pelo caminho que o
    `PATCH /api/servers/:id` do agent já usa, e ACKe **aquela** versão com o `requiresRestart` real
    que o `updateSettings` devolve (`core/src/http/routes/servers.ts:235`). Campo que falhar vai em
    `errors[]`, e a config **não** é reaplicada em laço. Comando envelhece; config não — dar TTL a
    ela faria um servidor voltar sozinho para uma config antiga porque um ACK se perdeu.

> ####  `requiresRestart` NÃO É COSMÉTICO  ####
>
> Dos oito campos de `desired`, **seis** estão na `RESTART_KEYS` do agent (`hostname`,
> `description`, `map`, `seed`, `worldSize`, `maxPlayers`); ficam de fora `name` e `autoUpdate`.
> Quase toda gravação vinda do site volta com `requiresRestart` não-vazio, e a tela do site precisa
> dizer **"gravado, vale no próximo start"** — senão o admin lê "salvo", olha o servidor no ar com o
> mapa antigo, e conclui que não funcionou.

#### `autoUpdate` — o oitavo campo, e o único que não é do `.ini` (onda 1, 04/09/2026)

Primeira das quatro áreas que o dono escolheu ampliar, e a mais barata — ela é o **molde** das
próximas (wipe, plugins/oxide, admins/bans/mensagens).

> ####  ELE NÃO ESTÁ NO `.ini`, E QUEM PROCURAR LÁ VAI CONCLUIR QUE QUEBROU  ####
>
> Os outros sete campos de `desired` são gravados pelo `updateSettings` do agent
> (`PATCH /api/servers/:id`). **`autoUpdate` não.** Do lado do agent quem o aplica é o caminho de
> **`/steam-update`** — ligar ou desligar a atualização automática do servidor. Abrir o `.ini`
> procurando o valor e não achar **não** é sintoma de gravação perdida: ele mora noutro lugar.
>
> **Para o contrato do site a diferença é INDIFERENTE, e isso é decisão, não descuido.** O campo
> viaja no **mesmo `desired`**, na **mesma `version`**, e o agent **ACKa a mesma `version`** — sem
> rota nova, sem segundo versionamento, sem segundo ACK. Um canal separado só porque o destino do
> valor é outro arquivo criaria **duas verdades** sobre "em que versão este servidor está", que é
> exatamente o que o versionamento único existe para evitar.

**Ausente, `false` e `true` são TRÊS estados, e num booleano dois deles se parecem:**

| No `desired` | Quer dizer | O agent faz |
|---|---|---|
| chave **ausente** | o site **não gerencia** este campo | mantém o que já tem |
| `false` | o site gerencia, e manda **DESLIGAR** | desliga a atualização automática |
| `true` | o site gerencia, e manda ligar | liga |

🔴 **Colapsar ausente e `false` é o defeito específico deste tipo**, porque `false` parece ausência
em quase toda checagem escrita às pressas (`if (v)`, `v || x`, um `filter(Boolean)`). Se isso
acontecer, **declarar a config de um servidor desliga o auto-update de quem só queria acertar o
`hostname`** — e o sintoma chega semanas depois, com o servidor numa versão velha do Rust e os
jogadores sem conseguir entrar, sem ninguém ligar o defeito a uma edição de nome. Do lado do site a
distinção está travada em `tests/rustServerConfigAutoUpdate.test.ts`; **o agent precisa da mesma
disciplina na leitura.**

Ele **não exige restart** (não entra na `RESTART_KEYS`: o valor novo vale na próxima checagem de
atualização) e **não é risco de wipe** (não pede `confirmWipe`).

**A validação recusa coerção, e o motivo cabe numa linha:** passam só `true`/`false` (booleano) e as
strings **exatas** `'true'`/`'false'`. `0`, `1`, `'0'`, `'1'`, `'sim'`, `'on'` e `'yes'` são
recusados com `NOT_A_BOOLEAN`, porque **`Boolean('false') === true`** — coagir **inverteria a ordem
do admin**, e a inversão é silenciosa. Para **parar de gerenciar** o campo, mande `null`, `''` ou
omita a chave: os três significam ausência; **`false` não**.

**O bloco `fields` da config no painel ganhou a chave `types`** — `string` | `integer` | `enum` |
`boolean`. Ela nasceu com este campo e não é decoração: até aqui dava para inferir o controle da
tela pelo `limits` (`maxChars` ⇒ texto, `min`/`max` ⇒ número, `map` ⇒ `<select>`). **Um booleano não
tem faixa e não aparece em `limits`** — a inferência antiga o desenharia como caixa de texto, o
admin digitaria "sim", e levaria `NOT_A_BOOLEAN`.

**Este campo é o que a etiqueta `oz-rust/4` carimba**, nos dois manuais, no mesmo commit.

#### A allowlist tem TRÊS kinds, e o agent conhece OITO

`server-start` · `server-stop` · `server-restart` — **e mais nada**, por decisão do dono em
**03/09/2026**.

O agent conhece **oito** (`core/src/ops/operations.ts`): os outros cinco — `server-install`,
`server-update`, `server-auto-update`, `oxide-install` e `wipe-run` — continuam existindo **só no
painel local dele**, e nenhum deles atravessa este canal.

> ####  `wipe-run` E RCON CRU NUNCA VIRÃO POR AQUI  ####
>
> **Nunca.** `wipe-run` apaga o mundo, e nem dentro do agent ele se dispara pela rota genérica de
> operações: a pré-condição de lá exige o `identity` **digitado** e uma `Idempotency-Key`, e uma
> rota remota não tem como exigir nenhuma das duas. **RCON cru também não** — "execute este texto
> no meu servidor" é execução remota arbitrária com outro nome. O que atravessa é um `kind` de uma
> lista fechada de três, e nada mais.
>
> E o `kinds` que a rota 10 traz **nunca autorizou nada**: é o menu que a tela pode desenhar. Se
> alguém escrever `if (kinds.includes('wipe-run')) permitir(...)`, o defeito está nessa linha.

#### O que o site NÃO faz, e não vai fazer: chamar o agent

As três razões, medidas no código do site, e repetidas aqui para quem ler só esta seção não propor
webhook de novo:

1. **`agents.base_url` é fixada no PRIMEIRO beacon e nunca mais atualizada** —
   `agent-public.routes.ts:113` faz `baseUrl: agent.baseUrl || baseUrl` dentro do `if (!created)`.
   Um IP residencial que mude quebra o canal para sempre.
2. **O endereço é HTTP puro montado do IP do socket** — `agent-public.routes.ts:68`. Sem TLS, sem
   hostname.
3. **A máquina fica atrás do NAT de uma conexão residencial.** Nada entra.

Um push por comando falharia sempre, e o sintoma seria *"o botão Reiniciar não faz nada"*, sem nada
dizendo por quê.

#### Critério de aceite — os três, verificáveis

1. Um **restart** disparado no painel do site sai de *enfileirado* em **≤10 s** e chega a
   *concluído*, com um `operationId` que existe no `GET /api/operations/<id>` do agent.
2. Um comando **deixado expirar** volta `refused`/`COMMAND_EXPIRED` e **não** reinicia o servidor
   quando o agent voltar.
3. Uma config gravada com **`map` novo** volta `applied: true` com `requiresRestart: ["map"]`, e o
   mundo carregado **não** muda de mapa.

#### O que ainda NÃO tem contrato

- **Os `params` de cada kind.** Em especial o **`force` do `server-stop`**: no agent ele existe e
  **MATA o processo**, perdendo tudo desde o último save automático. Enquanto ninguém decidir, o
  agent trata `params.force` como ausente, e quem quiser matar o processo faz isso no painel local.
- **O que o site faz com um comando que ficou sem ACK** (expira? vira `needs_admin`?). É decisão
  dele, e não muda uma linha do lado do agent — mas muda o que o admin vê.
- **Os `error_code` específicos das rotas 11-14.** As famílias de autenticação e o 429 valem aqui
  como em todas as outras; os códigos próprios nascem com a implementação e, até lá, caem na regra
  de ouro: **4xx com código desconhecido é `unavailable`, não `rejected`**.

### 23.11 A tela inteira e a config de rede (Lote 4)

**Lote 4.** Duas coisas nasceram em 04/09/2026: (1) o `desired` da **rota 13** deixou de
ter oito campos e passou a ter **a tela de configuração inteira** — 23 campos; (2) nasceu
um canal de **config de rede**, com as **rotas 15 e 16**, por onde a **loja**, os **kits**
e o **VIP** vêm do site.

O manual de implementação do lado do agent é o
`F:/Projects/RustAgent/Docs/23-CONFIG-PELO-SITE.md`; o que está aqui é o **contrato**, e
onde os dois discordarem, este manda.

⚠️ **Nenhuma linha de uma ponta falou com a outra nestas duas frentes.** Em 04/09/2026 uma
sonda do cliente real contra o dev respondeu **404 nas rotas 15 e 16** (elas não existem lá
ainda) e `version: 0, desired: null` na rota 13 — o site ainda não tem config gravada para
o servidor pareado. As fixtures do que foi medido estão em
`F:/Projects/RustAgent/contracts/oz-rust-fixtures.json`.

#### As duas rotas novas

| # | Rota | Quem chama | Cadência |
|---|---|---|---|
| 15 | `GET /api/agent/config/:domain` | agent | 60 s |
| 16 | `POST /api/agent/config/:domain/ack` | agent | por versão aplicada |

`:domain` é um de **`store`**, **`kits`**, **`vips`**. Os headers são os mesmos de toda
rota autenticada. A tabela das rotas 1–14 não muda: estas duas se somam a ela, e a próxima
rota nova é a **17**.

#### Rota 13 — os 23 campos do `desired`

Campo **ausente** = "o site não opina sobre ele". Não é `null` e não é "apague": um
`desired` que venha só com `hostname` muda `hostname` e mais nada.

| Campo | Tipo | Régua | Restart? |
|---|---|---|---|
| `name` | string | 1–80, sem quebra de linha | **não** — é só o rótulo do painel |
| `hostname` | string | 1–120 | sim |
| `description` | string | 0–500 (`""` tira) | sim |
| `url` | string | 0–300 (`""` não envia nada ao jogo) | sim |
| `headerImage` | string | 0–300 (`""` idem) | sim |
| `map` | enum | `Procedural Map` · `Barren` · `HapisIsland` · `Craggy Island` | sim |
| `worldSize` | int | 1000–6000 | sim |
| `seed` | int | 0–2147483647 | sim |
| `levelUrl` | string | 0–500. Preenchido = mapa custom; `""` volta ao procedural | sim |
| `maxPlayers` | int | 1–1000 | sim |
| `saveInterval` | int | 30–86400 (segundos) | sim |
| `identity` | string | `^[a-z][a-z0-9-]{1,30}$` | sim — **e é mundo novo** |
| `gamePort` | int | 1–65535 | sim |
| `queryPort` | int | 1–65535 | sim |
| `appPort` | int | 1–65535 | sim |
| `rconPort` | int | 1–65535 | sim |
| `rconPassword` | string | 8–200, **sem** `/` `\` `?` `#` nem espaço | sim |
| `steamAppId` | string | `^\d{1,10}$` (`258550` é o dedicado do Rust) | sim |
| `steamLogin` | string | `^[A-Za-z0-9_.-]{1,64}$` (`anonymous`) | sim |
| `steamBranch` | string | 0–64 (`""` = pública; `-beta staging`) | sim |
| `consoleWindow` | boolean | — | sim |
| `enabled` | boolean | — | **não** — vale na hora |
| `autoUpdate` | boolean | — | **não** — vale na rodada seguinte do vigia |

**Vinte dos vinte e três pedem restart**, e isso é **informação, não falha**: é o que faz o
painel do site dizer "gravado, vale no próximo start" em vez de "salvo". O
`requiresRestart` do ACK é o **retorno real** da gravação, nunca uma lista escrita à mão —
e é por isso que ele é do **jogo**, e não do agent: não existe campo para dizer "reinicie o
agente", e nenhum destes 23 precisa disso.

#### Os cinco avisos da rota 13

> ####  `identity` É MUNDO NOVO  ####
>
> Ela é a pasta dos saves. Trocá-la faz o próximo start carregar um **mundo vazio** — o
> antigo continua em disco, sem ninguém dentro. Não é `wipe-run` (nada é apagado), mas o
> jogador não distingue os dois. **A tela do site precisa perguntar duas vezes antes de
> gravar este campo.**

> ####  `rconPassword` É SEGREDO DE EXECUÇÃO  ####
>
> Com `RCON_WEB=1`, quem tem esta senha executa **qualquer** comando naquele servidor. Ela
> atravessa por decisão do dono, e o canal é TLS até a borda do site — mas o valor fica
> **gravado lá**. Duas consequências: (a) ela merece o mesmo tratamento do bearer no
> cadastro; (b) o agent **nunca devolve** a senha gravada, então uma rotação feita no
> painel local invalida em silêncio a que o site tem.

> ####  `enabled: false` DESLIGA O CUIDADO, NÃO O CANAL  ####
>
> `false` faz o agent parar de cuidar daquele servidor: sem RCON, sem vigia, fora da
> conferência de portas. **Tem volta pelo site**: o laço de config nasce do *pareamento*,
> não do `enabled`. `true` num servidor sem o jogo em disco falha com
> `SERVER_NOT_INSTALLED` em `errors[]`.

> ####  `autoUpdate` É TRI-ESTADO, E COLAPSAR DOIS DELES CUSTA O SERVIDOR  ####
>
> | Valor | Significa |
> |---|---|
> | campo **ausente** | o site **não gerencia** — vale o padrão da máquina (`STEAM_AUTO_UPDATE`) |
> | `false` | gerenciado e **desligado** |
> | `true` | gerenciado e **ligado** |
>
> Uma coluna que nasça `NOT NULL DEFAULT false` do lado do site colapsa os dois primeiros:
> o admin abre a tela para acertar o **hostname**, grava, e o `desired` sai carregando um
> `autoUpdate: false` que ninguém escolheu. **E o sintoma não aparece na hora** — ele
> aparece semanas depois, quando a Facepunch publica e o servidor passa a recusar todo
> mundo com "versão incompatível". A coluna é **nullable**, e `null` **não entra** no
> `desired`.
>
> Só `boolean` passa: a string `"false"` volta como `INVALID_VALUE`, e nunca é coagida —
> `Boolean("false")` é `true`.
>
> ⚠️ **Quem o aplica do lado do agent NÃO é o `updateSettings` do `.ini`** — ele não é
> campo do `.ini` e não está em `RESTART_KEYS`. Quem o aplica é o caminho de
> `/steam-update`: a opinião é gravada **por servidor**, sobrevive ao restart do agent e
> vale na rodada seguinte do vigia. Quem procurar o valor no `.ini` e não achar vai concluir
> que a gravação se perdeu.
>
> A confirmação de que a opinião pegou já viaja: `build.autoUpdate` no retrato de 30 s
> (rota 10). **Não nasça uma rota para ler o build** — seriam duas fontes para o mesmo
> número, e elas divergiriam na primeira vez que uma delas falhasse.

> ####  O PAREAMENTO NÃO ATRAVESSA, E NUNCA VAI  ####
>
> `siteServerId` e `siteToken` mandados no `desired` voltam em `errors[]` com
> **`FIELD_NOT_REMOTELY_WRITABLE`** — diferente de `UNKNOWN_FIELD` de propósito: o site
> precisa distinguir "agente velho, campo novo" de "o agente conhece e recusa por desenho".
> Eles são o que faz o agent falar com o site, e um valor errado gravado por este canal
> derrubaria o canal que o gravou. O conserto seria presencial.

#### Os códigos de `errors[]` da rota 13

| `code` | Quando |
|---|---|
| `UNKNOWN_FIELD` | o agent não conhece o campo — **site novo contra agent velho** |
| `INVALID_VALUE` | o campo existe e o valor não passa na régua |
| `FIELD_NOT_REMOTELY_WRITABLE` | o agent conhece e recusa por esta via |
| *(o código cru do agent)* | a **gravação** falhou: `PORT_BLOCK_TAKEN`, `SERVER_NOT_INSTALLED`, `UNKNOWN_SERVER`, `WRITE_FAILED` |

#### Rotas 15 e 16 — o corpo

```json
GET /api/agent/config/store
{ "ok": true, "version": 12, "desired": { "categories": [ … ], "offers": [ … ] } }

POST /api/agent/config/store/ack
{ "version": 12,
  "applied": true,
  "errors": [ { "field": "offers[capacete]", "code": "UNKNOWN_REFERENCE" } ],
  "stats": { "categories": 4, "offers": 37, "categoriesRemoved": 1, "offersRemoved": 2 } }
```

| Campo | Tipo | Regra |
|---|---|---|
| `version` | number | inteiro que **só cresce**, por assunto. Igual à última aplicada ⇒ nada a fazer |
| `desired` | object | a forma é de cada assunto |
| `applied` | boolean | `true` = alguma coisa entrou, mesmo com linha em `errors[]` |
| `errors` | `{field, code}[]` | uma por linha que não entrou. O resto entrou |
| `stats` | `Record<string, number>` | contagens do assunto — **é o que separa "entrou" de "entrou tudo"** |

`ETag`/`304` como na rota 13: recomendado, não obrigatório.

Códigos de `errors[]` deste canal: `INVALID_SHAPE` (o corpo não tem a forma do assunto — e
aí **nada** é aplicado), `INVALID_VALUE`, `UNKNOWN_REFERENCE` (a linha aponta para outra que
não veio no snapshot), `WRITE_FAILED`, e os crus do assunto `vips` (`VIP_UNKNOWN_TIER`,
`VIP_ALREADY_EXPIRED`, `INVALID_STEAM_ID`).

> ####  O CANAL DE REDE É DO AGENT, NÃO DO SERVIDOR  ####
>
> As tabelas da loja **não têm `server_id`**: a loja é UMA, e todos os servidores daquele
> agent mostram a mesma vitrine. O mesmo vale para os kits da rede e para o VIP, que é da
> conta do jogador. Por isso o agent puxa os três assuntos **uma vez só**, pelo bearer de
> **um** dos servidores pareados. **O site precisa responder o mesmo conteúdo em qualquer
> `Server` daquele agent.** Dois `Server` com catálogos diferentes = uma loja que muda
> sozinha a cada minuto.

#### Assunto `store` — a loja

`{ "categories": [...], "offers": [...] }`. As duas chaves vêm **sempre**: um `desired` em
que falte uma delas é recusado **inteiro** com `INVALID_SHAPE`, e nada é gravado — com
snapshot substitutivo, um `categories: []` mandado por engano apagaria a loja de todo mundo.

**Categoria:** `id` (1–64, **do site**) · `name` (1–48) · `position` (0–999) · `enabled`.

**Oferta:** `id` (1–64, do site) · `categoryId` (**precisa existir em `categories` do MESMO
snapshot**, senão `UNKNOWN_REFERENCE`) · `kind` (`item`·`bundle`·`vip`·`vehicle`) · `name`
(1–64) · `price` (0–100000000, OZCoin **inteiro**) · `oldPrice` (int·null, **maior** que
`price`) · `position` · `enabled` · `badge` (`promo`·`novo`·`destaque`·null) · `icon`
(`{shortname, itemId, skinId}`) · `items` (até 40 `{shortname, itemId, skinId, amount}`,
`amount` 1–1000000) · `perks` (até 20, 120 chars cada) · `vip` (`{tier, days}`, `days: null`
= vitalício) · `vehicle` (`{prefab, fuel}`).

**`skinId` é STRING de dígitos** e **`prefab` usa `/^[a-z0-9._-]{1,64}$/`, com o ponto
legal** — as duas réguas de sempre, e as duas que já divergiram uma vez.

As quatro coerências: `kind: "vip"` **exige** `vip`; `kind: "vehicle"` exige `vehicle`;
`bundle` exige **um** item no mínimo; `item` exige **exatamente um**.

> ####  LINHA DE FORA ⇒ NADA É APAGADO NAQUELA VERSÃO  ####
>
> Se **qualquer** linha do snapshot cair na régua, o agent grava o que passou e **não
> remove nada** — `categoriesRemoved` e `offersRemoved` voltam `0`. A versão seguinte, já
> corrigida, é que limpa. O caso que isto mata é o pior deste canal: um defeito de
> serialização do outro lado invalida as quarenta ofertas de uma vez e **a loja inteira
> some**, com um ACK dizendo `applied: true`.

`stats`: `categories` · `offers` · `categoriesRemoved` · `offersRemoved`. Remover uma
categoria leva as ofertas dela junto, em cascata.

#### Assunto `kits` — os kits da rede

`{ "kits": [...] }`. Ausente ⇒ `INVALID_SHAPE`; `kits: []` **apaga todos**.

`slug` (`^[a-z0-9][a-z0-9-]*$`, 1–48 — **é a chave**, e não um id: o id é AUTOINCREMENT
daquela máquina) · `name` (1–64) · `description` (≤400·null) · `category` (≤32·null) ·
`kind` (`compra`·`resgate`·`cooldown`) · `priceCents` (int·null, **centavos**, obrigatório
e > 0 em `compra`) · `cooldownSeconds` (1–31536000, obrigatório em `cooldown`) ·
`wipeDelaySeconds` (1–2592000) · `requiredTier` (string·null) · `items` (até 60
`{slot, shortname, amount, skinId, position}`; `slot` é `wear`·`belt`·`main`, `position`
0–47, `shortname` em `[A-Za-z0-9._-]`) · `enabled` · `servers` (**os `SITE_SERVER_ID`**).

Dois kits com o mesmo `slug` no mesmo snapshot: o segundo vira `INVALID_VALUE`. Um
`servers[]` que não casa com pareamento nenhum vira `UNKNOWN_REFERENCE` em
`kits[<slug>].servers[<id>]` — **o kit entra sem aquele servidor**, e o snapshot continua
íntegro (é erro de linha, não de lista).

`stats`: `created` · `updated` · `removed`.

#### Assunto `vips` — e ele **não** é snapshot

```json
{ "grants":      [ { "steamId": "76561198123456789", "tier": "gold", "expiresAt": "2026-10-01T00:00:00.000Z" } ],
  "revocations": [ { "steamId": "76561198987654321", "tier": "silver" } ] }
```

> ####  O QUE NÃO ESTÁ NAS DUAS LISTAS NÃO É TOCADO  ####
>
> A loja e os kits são catálogo. **VIP não é** — é um benefício de uma conta, concedido de
> três lugares: a compra in-game, a mão de um admin no painel local, e a reconciliação que
> **adota** quem já estava no grupo do plugin. Um snapshot revogaria os dois últimos toda
> vez que o site montasse a lista sem eles, e ninguém repara num benefício que some. Por
> isso o `desired` traz **verbos**.

As duas chaves são **opcionais** (lista ausente = "nada a fazer"); uma delas presente e não
sendo array ⇒ `INVALID_SHAPE` no assunto inteiro.

- `steamId`: **SteamID64, 17 dígitos, sempre TEXTO**. Um número JSON aqui passa de 2^53 e o
  VIP vai para a conta errada, sem erro no caminho.
- `tier`: 1–32, comparado em minúsculas, precisa existir num `OrigemZVip.json` daquele
  agent — senão `VIP_UNKNOWN_TIER`.
- `expiresAt`: **obrigatório em `grants`**; `null` é como se diz "vitalício", de propósito.
  Ausente ⇒ `INVALID_SHAPE` naquela linha — um campo esquecido viraria VIP eterno de graça.

`grants` renova (estende) e aplica na hora em quem estiver no ar; `revocations` revoga e a
linha **fica** no banco com `revoked_at`. Revogar o que já venceu **não é falha**: conta em
`stats.alreadyRevoked` e não vai para `errors[]`.

`stats`: `granted` · `revoked` · `alreadyRevoked`.

#### As nove regras que o site precisa cumprir

1. **`version` é inteiro, ≥ 1, e só cresce — por assunto.** `store`, `kits`, `vips` e a
   config de servidor têm contadores **independentes**. Versão ≤ à última aplicada ⇒ o agent
   não faz nada. *(O agent trata `version < 1` como "não há config": é o sentinela que o
   próprio site usa hoje, e o ACK de uma versão zero volta
   `400 CONFIG_INVALID_VERSION`.)*
2. **Um snapshot com erro é um snapshot que não limpa.** ACK com `errors[]` e `…Removed: 0`
   é exatamente isso, de propósito.
3. **Uma versão nova por edição, e não por montagem.** Não gere `version` de um relógio nem
   de um `updated_at` que muda sozinho: o catálogo inteiro atravessaria a internet a cada
   minuto, e o agent reescreveria a loja a cada volta.
4. **O ACK é a fonte da verdade sobre o que entrou.** `applied: true` com `errors: []` é o
   único desfecho em que **tudo** entrou; com `errors[]`, use o `stats`.
5. **Não deduza o `desired` a partir do espelho que o agent empurra.** O espelho é
   **retrato**, não intenção: montar o próximo `desired` a partir dele e bumpar a versão põe
   os dois lados num ping-pong que reescreve a loja para sempre.
6. **Responda o mesmo conteúdo em todos os `Server` de um agent.**
7. **`UNKNOWN_FIELD` é sinal de versão, não de bug** — site novo contra agent velho. Mostre
   a versão do agent ao lado: ela já viaja no `User-Agent` e no retrato periódico.
8. **Nunca mande `siteServerId` nem `siteToken` no `desired`.**
9. **Trate `rconPassword` como segredo de execução.** Ela não volta em `GET` nenhum do
   agent — nem agora, nem depois.

#### Os três critérios de aceite

1. **A tela inteira atravessa.** Gravar `hostname`, `worldSize`, `saveInterval`, `gamePort`
   e `enabled` no site e ver, em ≤30 s, o `.ini` com os cinco valores e um ACK com
   `applied: true` e `requiresRestart` com os quatro que pedem restart.
2. **O snapshot da loja substitui.** Publicar 3 categorias e 10 ofertas, ver a vitrine
   in-game com exatamente isso; publicar de novo sem uma oferta e vê-la sumir, com
   `stats.offersRemoved: 1`.
3. **O VIP não dobra.** Mandar um `grant` de 30 dias, derrubar o agent **antes** do ACK,
   subir de novo, e conferir que o vencimento continua 30 dias — e que o site recebe o ACK
   daquela versão sem uma segunda concessão.

#### O que continua fora, e por quê

`wipe-run` e o RCON cru (execução remota arbitrária com outro nome), a **agenda de wipe**,
os **loadouts** (não têm chave estável exposta ao site), `siteServerId`/`siteToken`, e os
**plugins**/Oxide (reescrevem arquivos com o servidor parado). As quatro áreas que o dono
aprovou trazer para dentro estão no
`F:/Projects/RustAgent/Docs/23-CONFIG-AVANCADA-DO-SITE.md`, com as etiquetas `/6`, `/7` e
`/9` reservadas para elas (a `/6` foi gasta em 04/09/2026 com a remoção do campo
`exists` do saldo, onde um byte mudou no fio de verdade).

---

## Apêndice — o que foi medido, o que foi conferido e o que é projeto

Todo documento deste repositório diz em voz alta o que não foi validado. Este
também.

### Medido no código, lido linha a linha

- Tudo o que está no §3 sobre a `RemoteWallet`: os caminhos, os headers, o
  tratamento de 409, o `balance` que não existe, o `fetch` global, a ausência de
  teste. `core/src/store/wallet.ts` inteiro.
- A ordem da compra, os estados, o estorno e as frases:
  `core/src/store/service.ts` inteiro.
- O CHECK de `store_purchases`, os índices e o molde de recriação de tabela:
  `core/src/db/migrations.ts:1296-1327`, `:1402-1432`, `:1454-1480`.
- O contrato do site em `/ozcoins/*`: os campos, os tipos, os status, o
  `findOrCreate`, o 422, o `productId` que o helper aceita e o controller não
  passa, o `idempotentResponseOf` sem `transactionId`.
  `agent-ozcoins.controller.ts` e `ozCoinsMutation.ts` inteiros.
- `authenticateAgent` e os cinco `error_code` dele.
- O beacon: o `baseUrl` fixado no primeiro, o HTTP puro do IP do socket, o
  `if (!created)` sem credencial, o `capabilities` que só cresce.
  `agent-public.routes.ts:38-140`.
- `reference_id VARCHAR(120) UNIQUE` global: `models/OzCoinTransaction.ts:13`.
- `validateBalanceChange`, `sanitizeInput` e a isenção de rate-limit do
  `/api/agent`: `middleware/securityMiddleware.ts:19-37`, `:175-202`.
- `referenceMismatch` e os quatro 409 com `charged`:
  `agent-shop.controller.ts:255-287`, `:339-361`.
- O modal que esconde o botão com saldo zero e o aceita com `null`:
  `core/src/game/ui-store-screens.ts:718`, `:1038-1074`.

### Conferido em documentação e em relato, não medido aqui

- O incidente do débito de 60 milhões de OZ no painel do Conan (§22.9).
- O bug do corte de cauda do `referenceId` que fazia todas as linhas de um pedido
  mandarem a mesma referência (§6.4).
- O 403 `error code: 1010` da borda recusando `User-Agent` genérico (§17.5).
- O timeout de 8 s do plugin `OrigemZUI` e a mensagem que manda conferir em vez
  de tentar de novo (§16.2).
- O `MIN_AGE_MS` de 2 min do `conanDeliveryGuard` do site, adaptado aqui para
  90 s (§11.2).

### Projeto — não existe, e nada disto foi rodado

- **As cinco rotas novas do site** (`/ozcoins/transaction`,
  `/deliveries/pending`, `/deliveries/ack`, `/shop/mirror` + `/mirror/version`).
  Elas são a **dependência de bloqueio** deste documento: sem elas, as fases 5, 6
  e 7 não existem.
- **Os três ajustes no `/ozcoins/debit`** (§5.4).
- **Todo o código do lado do agente descrito aqui.** Nenhuma linha está na
  árvore.
- **A assinatura do beacon** (§9.4) — o agente pode mandá-la hoje; o site ainda
  não a exige.
- **Nada foi testado contra o site de produção.** O `curl` do §5.3 é o primeiro
  contato, e ele é o critério de saída da fase 0.
- **O plugin `.cs` não foi tocado nem recompilado.** Nada nesta integração exige
  isso — e é de propósito: a frase que o jogador lê é montada no agente, não no
  plugin.

### O risco número um

**Se as rotas novas do site forem entregues com um contrato diferente do que está
no §5, os testes do §19 passam e a integração falha.** Eles falam com um dublê
que devolve o que este documento diz. A defesa é a fase 0: o contrato acordado
**antes** do código, e um `curl` de verdade contra cada rota nova assim que ela
existir.

---

## Fontes

Tudo abaixo foi aberto e lido para escrever este documento.

**RustAgent — `F:/Projects/RustAgent`**

| Arquivo | Para quê |
|---|---|
| `core/src/store/wallet.ts` | a interface, as duas implementações, o contrato imaginado |
| `core/src/store/service.ts` | a ordem da compra, o estorno, as frases |
| `core/src/db/wallets-repository.ts` | a carteira local e a transação única |
| `core/src/db/store-repository.ts` | `PurchaseState`, `createPurchase`, `stats`, `listPurchases` |
| `core/src/db/migrations.ts` | o molde de migração, a 015/016/017/018, a lista |
| `core/src/db/items-repository.ts` | o padrão de leitura e escrita em `meta` |
| `core/src/db/schema-version.ts` | `TARGET_SCHEMA` e `MIN_SCHEMA` derivados |
| `core/src/config.ts` | os helpers de `.env`, o bloco `store`, `assertSafeExposure` |
| `core/src/index.ts` | a montagem, a escolha da carteira, os relógios, o desligamento |
| `core/src/http/routes/store.ts` | as 14 rotas de loja e carteira, o mapa de status |
| `core/src/http/routes/health.ts` | o `/health` sem autenticação |
| `core/src/http/server.ts` | o escopo `/api` e o registro de rotas |
| `core/src/http/error-response.ts` | `ApiError` e o corpo de erro |
| `core/src/game/ui-store-bridge.ts` | o modal, o cabeçalho, o saldo relido |
| `core/src/game/ui-store-screens.ts` | `affordable`, `canBuy`, `MAX_QUANTITY` |
| `core/src/kits/service.ts` | os oito códigos de erro do `origemz.give` |
| `core/src/vip/service.ts` e `core/src/vip/expiry-watcher.ts` | o molde de relógio |
| `core/src/wipe/rustmaps.ts` | o molde de cliente HTTP com `fetchImpl` |
| `core/src/players/presence.ts` | o `PresenceTracker` |
| `core/src/bans/service.ts`, `core/src/bans/rust-bans.ts` | `assertSteamId` |
| `core/src/logger.ts`, `core/src/util.ts` | o `redact` e o `toError` |
| `core/test/store.test.ts`, `core/test/rustmaps.test.ts`, `core/test/migrations.test.ts` | o molde de teste |
| `.env.example`, `Docs/README.md`, `README.md`, `Docs/06-API.md`, `Docs/17-FRENTES-WIPE-E-MENSAGENS.md`, `Docs/19-PESQUISA-RANKING.md` | as convenções e o molde de documento |

**Site OrigemZ — `F:/Projects/OrigemZSite/ad_oz_backend`**

| Arquivo | Para quê |
|---|---|
| `src/modules/agent-private/agent-ozcoins.controller.ts` | `balance`, `credit`, `debit` |
| `src/modules/agent-private/ozCoinsMutation.ts` | a máquina do saldo, o 422, o 23505 |
| `src/modules/agent-private/authenticateAgent.ts` | os cinco `error_code` |
| `src/modules/agent-private/agent-private.routes.ts` | as 13 rotas do canal privado |
| `src/modules/agent-private/agent-shop.controller.ts` | `referenceMismatch`, os 409 com `charged`, `requireConanServer` |
| `src/modules/agent-public/agent-public.routes.ts` | o beacon |
| `models/OzCoinTransaction.ts`, `models/User.ts` | `reference_id` único global, `ep_balance` |
| `middleware/securityMiddleware.ts` | rate-limit isento, `validateBalanceChange`, `sanitizeInput` |
| `routes/ozcoin-history.ts` | o extrato do jogador e a consolidação por texto |
