# 23 — Configurar pelo site: o `.ini` inteiro, a loja, os kits e o VIP

> **Para quem é.** Para quem escreve o **lado do site** OrigemZ. Ele diz o que o agente passou a
> aceitar vindo de lá, campo a campo, e o que o site precisa expor para que isso aconteça.
>
> **O que ele diz.** Duas coisas nasceram em 04/09/2026: (1) a config desejada de servidor — a
> rota 13 do `Docs/22` — deixou de ter sete campos e passou a ter **a tela de configuração
> inteira**; (2) um canal novo, de **config de rede**, com duas rotas (`GET
> /api/agent/config/:domain` e `POST /api/agent/config/:domain/ack`) por onde a **loja**, os
> **kits** e o **VIP** podem vir do site.
>
> **O que ele NÃO é.** Não é relato de coisa testada contra o site. **O lado do agente existe e
> está verde** — 986 testes, typecheck e lint limpos (§9) —, mas **nenhuma linha dele falou com o
> servidor de vocês**: todo teste daqui fala com um dublê que devolve o que este documento diz que
> o site responde. Se as rotas nascerem com outro contrato, os testes daqui passam e a integração
> falha. É o mesmo risco número um do `Docs/21` e do `Docs/22`, e ele continua de pé.
>
> **Data:** 04/09/2026.
> **Contrato:** `oz-rust/5` — a rota **13 ampliada** (23 campos, com o `autoUpdate`), mais as rotas
> **15 e 16**.
> ✅ **Reconciliado em 04/09/2026.** O conteúdo deste documento — os campos da rota 13 e o canal de
> config de rede — foi levado para o §23 dos **dois** manuais, com o corpo idêntico byte a byte
> (`Docs/20` §23.11 e a §23.9 do manual do site), e a etiqueta subiu para `oz-rust/5` nos dois no
> mesmo commit. Confere-se com `grep -Eom1 'oz-rust/[0-9]+'` nos dois arquivos. **A etiqueta é dos
> manuais, não de quem a reivindica primeiro** — daqui em diante, quem mudar qualquer coisa deste
> assunto muda lá, e este documento continua sendo o manual de implementação do lado do agent.
> **Pré-requisito:** o `Docs/20` (o canal, o bearer, o `X-Server-Id`) e o `Docs/22` (a config de
> servidor, a `version`, o `ETag`, o ACK). Este documento não os repete.

---

## 0 — Índice

| § | Assunto |
|---|---|
| [1](#1--em-uma-página) | Em uma página |
| [2](#2--a-config-de-servidor-agora-é-a-tela-inteira) | A config de **servidor**: agora é a tela inteira |
| [3](#3--o-canal-novo-config-de-rede) | O canal novo: **config de rede** |
| [4](#4--assunto-store--a-loja) | Assunto `store` — a loja |
| [5](#5--assunto-kits--os-kits-da-rede) | Assunto `kits` — os kits da rede |
| [6](#6--assunto-vips--conceder-e-revogar) | Assunto `vips` — conceder e revogar |
| [7](#7--as-nove-regras-que-o-site-precisa-cumprir) | As **nove regras** que o site precisa cumprir |
| [8](#8--critérios-de-aceite) | Critérios de aceite |
| [9](#9--o-que-foi-construído-deste-lado) | O que foi construído deste lado |
| [10](#10--o-que-continua-fora) | O que continua **fora** |

---

## 1 — Em uma página

### 1.1 O que nasce

| # | O quê | Rota | Cadência | Onde mora aqui |
|---|---|---|---|---|
| 1 | **Config de servidor ampliada** — de 7 para **21 campos do `.ini`**, mais `enabled` e `autoUpdate` | `GET /api/agent/server/config` (a mesma) | 30 s | `core/src/site/config.ts` |
| 2 | **Config de rede** — loja, kits e VIP | `GET /api/agent/config/:domain` + `POST /api/agent/config/:domain/ack` | 60 s | `core/src/site/domains.ts` |

Continua valendo tudo do `Docs/22`: **quem puxa é o agente**, o site não chama esta máquina e não
vai chamar (§5 de lá — o `agents.base_url` é fixado no primeiro beacon, é HTTP puro montado do IP
do socket, e a máquina está atrás de NAT residencial).

### 1.2 A mudança de fundo, dita em voz alta

Até aqui, tudo o que vinha do site **acrescentava**: uma entrega, um comando, um campo do `.ini`.
O assunto de rede **substitui**:

> ####  O SNAPSHOT É A LOJA INTEIRA, E O QUE SUMIU DELE SAI  ####
>
> Não há merge. Uma oferta que não veio no `desired` é uma oferta **removida** — junto com a
> categoria que não veio, e com os kits que não vieram. É a mesma regra do espelho que já sai
> daqui (`store/catalog-mirror.ts`), e ela existe porque a alternativa é pior: um merge deixaria
> produto apagado à venda para sempre.
>
> A consequência prática: **enquanto o site opinar sobre um assunto, ele é o dono daquele
> assunto.** Editar pelo painel local continua funcionando e continua valendo — até a próxima
> versão vinda do site, que reescreve tudo. Quem não quiser isso não liga o interruptor.

### 1.3 Os interruptores

| Chave | Padrão | O que faz |
|---|---|---|
| `SITE_BASE_URL` | vazia | vazia = nada da integração acontece |
| `SITE_CONFIG_PULL_ENABLED` | `1` | a config de **servidor** |
| `SITE_DOMAIN_PULL_ENABLED` | **`0`** | a config de **rede** (loja, kits, VIP) |
| `SITE_DOMAINS` | vazia (= todos) | quais assuntos: `store`, `kits`, `vips` |

> ####  O CANAL DE REDE NASCE DESLIGADO, E É O ÚNICO ASSIM  ####
>
> Porque ele substitui. Ligado por padrão, a primeira versão do site apagaria a loja de quem
> atualizou o agente sem ler nada. Ligar é uma decisão de quem opera a máquina — e o `.env.example`
> diz isso com todas as letras.

---

## 2 — A config de servidor: agora é a tela inteira

A rota, o corpo, o `ETag`, a `version` e o ACK são **os mesmos do `Docs/22` §2.4 e §2.5**. O que
mudou é a lista de campos que o agente aceita dentro de `desired`.

### 2.1 Os campos

Campo **ausente** = "o site não opina sobre ele". Não é `null` e não é "apague": um `desired` que
venha só com `hostname` muda `hostname` e mais nada.

| Campo | Tipo | Régua | Precisa de restart? |
|---|---|---|---|
| `name` | string | 1–80 chars, sem quebra de linha | **não** — é só o rótulo do painel |
| `hostname` | string | 1–120 | sim |
| `description` | string | 0–500 (`""` tira a descrição) | sim |
| `url` | string | 0–300 (`""` não envia nada ao jogo) | sim |
| `headerImage` | string | 0–300 (`""` idem) | sim |
| `map` | enum | `Procedural Map` · `Barren` · `HapisIsland` · `Craggy Island` | sim |
| `worldSize` | int | 1000–6000 | sim |
| `seed` | int | 0–2147483647 | sim |
| `levelUrl` | string | 0–500. Preenchido = mapa custom baixado no boot; `""` volta ao procedural | sim |
| `maxPlayers` | int | 1–1000 | sim |
| `saveInterval` | int | 30–86400 (segundos) | sim |
| `identity` | string | `^[a-z][a-z0-9-]{1,30}$` | sim — **e leia o aviso abaixo** |
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

**Vinte e três campos, e vinte deles pedem restart.** Isso é **informação, não falha**: é o que faz
o painel do site dizer "gravado, vale no próximo start" em vez de "salvo" — com o admin concluindo
que não funcionou porque o mapa não mudou. O `requiresRestart` do ACK é o **retorno real** do
`updateSettings`, nunca uma lista escrita à mão.

### 2.2 Os cinco avisos

> ####  `identity` É MUNDO NOVO  ####
>
> Ela é a pasta dos saves. Trocá-la faz o próximo start carregar um **mundo vazio** — o antigo
> continua em disco, sem ninguém dentro. Não é `wipe-run` (nada é apagado), mas o jogador não
> distingue os dois. **A tela do site precisa perguntar duas vezes antes de gravar este campo.**

> ####  `rconPassword` É SEGREDO DE EXECUÇÃO  ####
>
> Com `RCON_WEB=1`, quem tem esta senha executa **qualquer** comando naquele servidor. Ela
> atravessa o canal por decisão do dono, e o canal é TLS até a borda de vocês — mas o valor fica
> **gravado aí**. Duas consequências: (a) ela merece o mesmo tratamento do bearer no cadastro de
> vocês; (b) o agente **nunca devolve** a senha gravada, então uma rotação feita no painel local
> invalida silenciosamente a que o site tem — o site só descobre quando gravar de novo.

> ####  `enabled: false` DESLIGA O CUIDADO, NÃO O CANAL  ####
>
> `false` faz o agente parar de cuidar daquele servidor: sem RCON, sem vigia, fora da conferência
> de portas. **Tem volta pelo site**: o laço de config nasce do *pareamento*, não do `enabled`, e
> um servidor desligado continua puxando config. `true` num servidor sem o jogo em disco falha com
> `SERVER_NOT_INSTALLED` em `errors[]`.

> ####  `autoUpdate` É TRI-ESTADO, E NÃO É CAMPO DO `.ini`  ####
>
> Chave **ausente** = o site não gerencia (vale o `STEAM_AUTO_UPDATE` da máquina); `false` =
> gerenciado e desligado; `true` = gerenciado e ligado. Colapsar os dois primeiros — uma coluna
> `NOT NULL DEFAULT false` do lado de lá — faz uma gravação de `hostname` desligar a atualização
> automática de quem não pediu, e o sintoma só aparece semanas depois, quando a Facepunch publica e
> o servidor passa a recusar todo mundo.
>
> Só `boolean` passa: a string `"false"` é `INVALID_VALUE`, e nunca coagida (`Boolean('false')` é
> `true`).
>
> **Quem o aplica aqui não é o `updateSettings`** — ele não é campo do `.ini` e não está em
> `RESTART_KEYS`. Quem aplica é o vigia da Steam (`core/src/steam/update-watcher.ts`), que grava a
> opinião **por servidor** na tabela `meta`; ela vale na rodada seguinte, sem reiniciar o agente, e
> sobrevive ao restart. A confirmação de que pegou é o `build.autoUpdate` do retrato de 30 s.

> ####  O PAREAMENTO NÃO ATRAVESSA, E NUNCA VAI  ####
>
> `siteServerId` e `siteToken` mandados no `desired` voltam em `errors[]` com o código
> **`FIELD_NOT_REMOTELY_WRITABLE`** — que é diferente de `UNKNOWN_FIELD` de propósito: o site
> precisa distinguir "agente velho, campo novo" de "o agente conhece e recusa por desenho". O
> motivo: eles são o que faz o agente falar com o site, e um valor errado gravado por este canal
> derrubaria o canal que o gravou. O conserto seria presencial, no painel local.

### 2.3 Os códigos de `errors[]`

| `code` | Quando |
|---|---|
| `UNKNOWN_FIELD` | o agente não conhece o campo — **site novo contra agente velho** |
| `INVALID_VALUE` | o campo existe e o valor não passa na régua da tabela acima |
| `FIELD_NOT_REMOTELY_WRITABLE` | o agente conhece e recusa por esta via (§2.2) |
| *(o código cru do agente)* | a **gravação** é que falhou: `PORT_BLOCK_TAKEN`, `SERVER_NOT_INSTALLED`, `UNKNOWN_SERVER`, `WRITE_FAILED` |

`PORT_BLOCK_TAKEN` é o mais provável na prática: ele quer dizer que a porta pedida já é de **outro
servidor deste mesmo agente**. A mensagem daqui explica, e o `code` é o que o site exibe.

---

## 3 — O canal novo: config de rede

### 3.1 As duas rotas

Os headers são os **mesmos** de todas as rotas autenticadas (`Docs/20` §5.1): `Authorization:
Bearer <bearer daquele servidor>`, `X-Server-Id`, `Accept: application/json`, `User-Agent:
OrigemZ-Rust-Agent/<versão>`.

```
GET  /api/agent/config/:domain          →  { ok, version, desired }   (+ ETag / 304)
POST /api/agent/config/:domain/ack      ←  { version, applied, errors[], stats{} }
```

`:domain` é um de **`store`**, **`kits`**, **`vips`**.

```json
GET /api/agent/config/store
{
  "ok": true,
  "version": 12,
  "desired": { "categories": [ … ], "offers": [ … ] }
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `version` | number | inteiro que **só cresce**, por assunto. Igual à última aplicada ⇒ nada a fazer |
| `desired` | object | a forma é de cada assunto — §4, §5 e §6 |

**`ETag` / `304`:** igual à config de servidor. O agente guarda o `ETag` e manda `If-None-Match` na
volta seguinte; um **304 sem corpo** é o desfecho normal e barato. Recomendado, não obrigatório.

O ACK:

```json
POST /api/agent/config/store/ack
{
  "version": 12,
  "applied": true,
  "errors": [ { "field": "offers[capacete]", "code": "UNKNOWN_REFERENCE" } ],
  "stats": { "categories": 4, "offers": 37, "categoriesRemoved": 1, "offersRemoved": 2 }
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `version` | number | a versão que este ACK fecha. **Sempre a que veio no `GET`** |
| `applied` | boolean | `true` = alguma coisa entrou, mesmo com linha em `errors[]` |
| `errors` | `{field, code}[]` | uma por linha que não entrou. O resto entrou |
| `stats` | `Record<string, number>` | contagens do assunto. **É o que separa "entrou" de "entrou tudo"** |

> ####  `stats` NÃO É ENFEITE  ####
>
> Um snapshot de 40 ofertas que entra inteiro e um que entra pela metade produzem o **mesmo**
> `applied: true`. Sem a contagem na tela de vocês, "a loja está estranha" não tem primeira
> pergunta.

### 3.2 Os códigos de `errors[]` deste canal

| `code` | Quando |
|---|---|
| `INVALID_SHAPE` | o corpo não tem a forma do assunto — e aí **nada** é aplicado |
| `INVALID_VALUE` | aquela linha não passa na régua do painel local |
| `UNKNOWN_REFERENCE` | a linha aponta para outra que não veio no snapshot (uma categoria, um servidor) |
| `WRITE_FAILED` | a gravação daquela linha falhou |
| *(o código cru do agente)* | no assunto `vips`: `VIP_UNKNOWN_TIER`, `VIP_ALREADY_EXPIRED`, `INVALID_STEAM_ID` |

### 3.3 Este canal é do AGENTE, não do servidor

> ####  UM AGENTE, UMA LOJA  ####
>
> As tabelas da loja **não têm `server_id`**: a loja é UMA, e todos os servidores daquele agente
> mostram a mesma vitrine. O mesmo vale para os kits da rede e para o VIP, que é da conta do
> jogador.
>
> Por isso o agente puxa estes três assuntos **uma vez só**, pelo bearer de **um** dos servidores
> pareados (o primeiro em ordem de id local). **O site precisa responder o mesmo conteúdo em
> qualquer `Server` daquele agente.** Se dois `Server` do mesmo agente responderem catálogos
> diferentes, o resultado é indefinido — e o sintoma seria uma loja que muda sozinha a cada minuto.
>
> Se vocês modelam a loja **por servidor** do lado de lá, a saída é a mesma: responder, para todos
> os `Server` de um agente, o catálogo daquele agente.

---

## 4 — Assunto `store` — a loja

### 4.1 A forma

```json
{
  "categories": [
    { "id": "armas", "name": "Armas", "position": 0, "enabled": true }
  ],
  "offers": [
    {
      "id": "ak-1",
      "categoryId": "armas",
      "kind": "item",
      "name": "AK-47",
      "price": 250,
      "oldPrice": 400,
      "position": 0,
      "enabled": true,
      "badge": "promo",
      "icon": { "shortname": "rifle.ak", "itemId": 1545779598, "skinId": "0" },
      "items": [
        { "shortname": "rifle.ak", "itemId": 1545779598, "skinId": "0", "amount": 1 }
      ],
      "perks": [],
      "vip": null,
      "vehicle": null
    }
  ]
}
```

> ####  AS DUAS CHAVES VÊM SEMPRE, E COMPLETAS  ####
>
> Um `desired` em que falte `categories` **ou** `offers` é recusado **inteiro**, com
> `INVALID_SHAPE`, e nada é gravado. O motivo é aritmético: com snapshot substitutivo, um
> `categories: []` mandado por engano apagaria a loja de todo mundo — e o ACK diria `applied:
> true`.

### 4.2 Categoria

| Campo | Tipo | Régua |
|---|---|---|
| `id` | string | 1–64 chars. **Quem gera é o site** — igual ao `DLV-` e ao `CMD-`. É por ele que a versão seguinte encontra a mesma linha |
| `name` | string | 1–48 |
| `position` | int | 0–999 (padrão `0`) |
| `enabled` | boolean | padrão `true` |

### 4.3 Oferta

| Campo | Tipo | Régua |
|---|---|---|
| `id` | string | 1–64, do site |
| `categoryId` | string | **precisa existir em `categories` do MESMO snapshot** — senão `UNKNOWN_REFERENCE` |
| `kind` | enum | `item` · `bundle` · `vip` · `vehicle` |
| `name` | string | 1–64 |
| `price` | int | 0–100000000, em **OZCoin inteiro** |
| `oldPrice` | int·null | precisa ser **maior** que `price` (ele é riscado ao lado) |
| `position` | int | 0–999 |
| `enabled` | boolean | padrão `true` |
| `badge` | enum·null | `promo` · `novo` · `destaque` |
| `icon` | object | `{shortname, itemId, skinId}` — `skinId` é **string** de dígitos |
| `items` | array | até 40 `{shortname, itemId, skinId, amount}`; `amount` 1–1000000 |
| `perks` | string[] | até 20, cada uma até 120 chars |
| `vip` | object·null | `{tier, days}` — `days` `null` = vitalício |
| `vehicle` | object·null | `{prefab, fuel}` |

As quatro coerências, herdadas literalmente da rota local (a régua é o **mesmo objeto zod**, não
uma cópia):

- `kind: "vip"` **exige** `vip` — senão cobraria e não daria nada;
- `kind: "vehicle"` **exige** `vehicle`;
- `kind: "bundle"` exige pelo menos **um** item;
- `kind: "item"` exige **exatamente um** item.

> ####  A RECEITA DA ENTREGA VIAJA NESTA DIREÇÃO  ####
>
> O espelho que **sai** daqui (`POST /api/agent/store/mirror`) não leva `items[]`, `vip` nem
> `vehicle`: o painel do site precisa **ver** a loja, não saber como o item nasce. Mas para
> **mandar** uma oferta o site precisa dizer o que ela entrega — e por isso o `desired` tem os três
> campos que o espelho esconde.

### 4.4 Só um snapshot **íntegro** remove

> ####  LINHA DE FORA ⇒ NADA É APAGADO NAQUELA VERSÃO  ####
>
> Se **qualquer** linha do snapshot cair na régua (`INVALID_VALUE`, `UNKNOWN_REFERENCE`), o agente
> grava o que passou e **não remove nada** — `categoriesRemoved` e `offersRemoved` voltam `0`. A
> versão seguinte, já corrigida, é que faz a limpeza.
>
> O caso que isto mata é o pior deste canal: um defeito de serialização do outro lado invalida as
> quarenta ofertas de uma vez, o snapshot chega "vazio" para efeito de comparação, e **a loja
> inteira some** — com um ACK dizendo `applied: true` e quarenta erros que ninguém leu a tempo.
>
> Em `kits` vale o mesmo, com uma exceção: o `servers[]` que não casou é erro **de linha**, não de
> lista — aquele kit entrou, o snapshot continua íntegro, e a limpeza acontece.

### 4.5 `stats` do assunto `store`

`categories` · `offers` (quantas foram gravadas) · `categoriesRemoved` · `offersRemoved`.

Remover uma categoria **leva as ofertas dela junto**, em cascata. Isso é comportamento do banco
daqui, e é o que já acontece pelo painel local.

---

## 5 — Assunto `kits` — os kits da rede

### 5.1 A forma

```json
{
  "kits": [
    {
      "slug": "kit-inicial",
      "name": "Kit Inicial",
      "description": "Para quem acabou de entrar",
      "category": "Começo",
      "kind": "resgate",
      "cooldownSeconds": null,
      "useLimit": 1,
      "useResetOn": "never",
      "wipeDelaySeconds": null,
      "requiredTier": null,
      "requiredTierExact": false,
      "items": [
        { "slot": "belt", "shortname": "rifle.ak", "amount": 1, "skinId": "0", "position": 0 }
      ],
      "enabled": true,
      "servers": ["RUST01"]
    }
  ]
}
```

`kits` ausente ⇒ `INVALID_SHAPE`, e nada é tocado. `kits: []` **apaga todos** — é a mesma regra da
loja, e é por isso que a ausência não é tratada como lista vazia.

| Campo | Tipo | Régua |
|---|---|---|
| `slug` | string | `^[a-z0-9][a-z0-9-]*$`, 1–48. **É a chave**: ver o aviso abaixo |
| `name` | string | 1–64 |
| `description` | string·null | até 400 |
| `category` | string·null | até 32 — é a aba dentro do jogo |
| `kind` | enum | `resgate` · `cooldown`. **`compra` saiu** — ver o aviso abaixo |
| `cooldownSeconds` | int·null | 1–31536000. Obrigatório quando `kind: "cooldown"` |
| `useLimit` | int·null | 1–10000 — quantas vezes cada jogador leva. Só em `resgate`; ausente = 1, que é o resgate único de sempre. Em `cooldown` tem de ser `null` |
| `useResetOn` | enum | `never` (padrão) · `wipe` · `full-wipe` — quando a conta de usos zera |
| `wipeDelaySeconds` | int·null | 1–2592000 — segundos depois do wipe em que o kit fica bloqueado |
| `requiredTier` | string·null | o nível de VIP exigido; `null` = qualquer um |
| `requiredTierExact` | boolean | padrão `false` (aquele nível **ou mais alto**). `true` = SÓ aquele — o Ouro não pega o kit do Bronze. Com `requiredTier: null` é `INVALID_VALUE` |
| `items` | array | até 60 `{slot, shortname, amount, skinId, position}` |
| `enabled` | boolean | padrão `true` |
| `servers` | string[] | **os `SITE_SERVER_ID`** — ver o aviso |

`slot` é `wear` · `belt` · `main`; `position` é 0–47; `shortname` usa `[A-Za-z0-9._-]` (ele vai para
a linha de comando do console do jogo, e um espaço fatiaria o comando).

> ####  KIT NÃO SE COMPRA MAIS  ####
>
> O `kind: "compra"` e o `priceCents` saíram em 07/09/2026 (migrações 052 e 054). Quem vende na
> rede é a LOJA, que tem vitrine, categoria e carteira — o kit com preço era uma segunda vitrine.
> Um snapshot que ainda mande `kind: "compra"` ou o campo `priceCents` recebe `INVALID_VALUE`
> **naquela linha**, e o kit não entra; o resto do snapshot entra normalmente. Os kits de compra
> que existiam viraram resgate único, sem preço.

> ####  A CHAVE É O `slug`, E NÃO UM ID  ####
>
> O id do kit é um inteiro AUTOINCREMENT desta máquina: o site não o conhece, e não deveria. O
> `slug` é o identificador estável — é o que a rota local já trata como tal, e é o que sobrevive a
> um kit apagado e recriado. Dois kits com o mesmo `slug` no mesmo snapshot: o segundo vira
> `INVALID_VALUE`.

> ####  `servers[]` VEM COM O ID DO SITE  ####
>
> O agente traduz `SITE_SERVER_ID` → id local, na fronteira. Um id que não casa com pareamento
> nenhum vira `UNKNOWN_REFERENCE` no campo `kits[<slug>].servers[<id>]`: **o kit entra sem aquele
> servidor**, e o site vê qual foi. Kit com `servers: []` existe e não é oferecido em lugar nenhum
> — o que é uma configuração legítima, e a mensagem da rota local já diz isso.

### 5.2 `stats` do assunto `kits`

`created` · `updated` · `removed`.

---

## 6 — Assunto `vips` — conceder e revogar

### 6.1 Este assunto **não** é snapshot, e é o único assim

```json
{
  "grants": [
    { "steamId": "76561198123456789", "tier": "gold", "expiresAt": "2026-10-01T00:00:00.000Z" }
  ],
  "revocations": [
    { "steamId": "76561198987654321", "tier": "silver" }
  ]
}
```

> ####  O QUE NÃO ESTÁ NAS DUAS LISTAS NÃO É TOCADO  ####
>
> A loja e os kits são catálogo: o site manda a lista inteira e o que sumiu sai. **VIP não é
> catálogo** — é um benefício de uma conta, concedido de três lugares diferentes: a compra na loja
> in-game (que vira entrega `vip`), a mão de um admin no painel local, e a reconciliação que
> **adota** quem já estava no grupo do plugin.
>
> Um snapshot aqui revogaria os dois últimos toda vez que o site montasse a lista sem eles — e
> ninguém repara num benefício que some, até o jogador reclamar. Por isso o `desired` traz
> **verbos**.

As duas chaves são **opcionais**: aqui, lista ausente quer dizer "nada a conceder", e não "revogue
tudo". Se uma delas vier e não for um array, o assunto inteiro é `INVALID_SHAPE`.

| Campo | Tipo | Regra |
|---|---|---|
| `steamId` | string | **SteamID64, 17 dígitos, sempre texto**. Um número JSON aqui passa de 2^53 e o VIP iria para a conta errada, sem erro no caminho |
| `tier` | string | 1–32. Comparado em minúsculas. Precisa existir em algum `OrigemZVip.json` deste agente — senão `VIP_UNKNOWN_TIER` |
| `expiresAt` | ISO 8601 · null | **obrigatório em `grants`**; `null` = vitalício, de propósito |

> ####  `expiresAt` AUSENTE NÃO É VITALÍCIO — É ERRO  ####
>
> Ele **tem** de vir, e `null` é como se diz "vitalício" de propósito. A mesma regra do `POST
> /vips` local. O motivo é o preço do engano: um campo esquecido viraria VIP eterno de graça, e
> ninguém repara num benefício que sobra. Ausente ⇒ `INVALID_SHAPE` naquela linha, e a concessão
> não acontece.

### 6.2 O que o agente faz com cada verbo

- **`grants`** → `grant` com `origin: "loja"` e `createdBy: "site"`. Conceder de novo **renova**
  (estende o vencimento) e aplica no jogador que estiver no ar, na hora.
- **`revocations`** → `revoke`. A linha **fica** no banco, com `revoked_at` — apagar destruiria
  "quem já foi VIP, de onde veio e quem tirou".

> ####  REVOGAR O QUE JÁ VENCEU NÃO É FALHA  ####
>
> `VIP_NOT_FOUND` é o desfecho de "o vencimento chegou primeiro", e ele é comum: o relógio local
> vence o VIP às 3h, o site manda a revogação às 3h05. O estado desejado é o que já vale. Ele conta
> em `stats.alreadyRevoked` e **não** vai para `errors[]`.

### 6.3 `stats` do assunto `vips`

`granted` · `revoked` · `alreadyRevoked`.

### 6.4 A `version` é o que impede o VIP de dobrar

Sem ela, um `grant` reenviado (porque o ACK se perdeu) **estenderia o vencimento de novo**, e um
VIP de 30 dias viraria um de 60. A versão aplicada é gravada em disco antes do ACK, na mesma
transação — e sobrevive a um `pm2 restart`.

---

## 7 — As nove regras que o site precisa cumprir

Cada uma existe porque a alternativa já custou alguma coisa em algum lugar deste sistema.

### 1. `version` é inteiro e só cresce, **por assunto**

`store`, `kits`, `vips` e a config de servidor têm contadores **independentes**. Versão menor ou
igual à última aplicada ⇒ o agente não faz nada e o laço termina ali.

*Por quê:* é o que torna a config idempotente sem TTL. Um contador compartilhado faria uma edição
de kit invalidar a versão da loja e reescrever o catálogo inteiro por nada.

### 2. Um snapshot com erro é um snapshot que não limpa

Ver §4.4. Se o ACK trouxer `errors[]` e `…Removed: 0`, **é isso que aconteceu**: o agente segurou
as remoções de propósito. Corrija a linha e publique uma versão nova.

### 3. Uma versão nova por edição, e **não** por montagem

Não gere `version` a partir de um relógio ou de um `updated_at` que muda sozinho.

*Por quê:* é o defeito que o espelho daqui já evita mantendo `generatedAt` fora do hash. Uma versão
que muda a cada montagem faz o catálogo inteiro atravessar a internet a cada minuto — e, pior, faz
o agente reescrever a loja a cada volta.

### 4. O ACK é a fonte da verdade sobre o que entrou

`applied: true` com `errors: []` é o único desfecho em que **tudo** entrou. Com `errors[]` não
vazio, use o `stats` para saber quanto.

*Por quê:* sem isso, "gravei no site e o servidor não mudou" não tem primeira pergunta.

### 5. Não deduza o `desired` a partir do espelho que o agente empurra

O agente continua empurrando o catálogo daqui (`POST /api/agent/store/mirror`). Esse espelho é
**retrato**, não intenção: se o site montar o próximo `desired` a partir dele e bumpar a versão, os
dois lados entram num ping-pong que reescreve a loja para sempre.

*Por quê:* é o único laço infinito possível neste desenho, e ele é fácil de criar sem querer.

### 6. Responda o mesmo conteúdo em todos os `Server` de um agente

Ver §3.3. O agente puxa por um pareamento só.

### 7. `errors[]` de campo desconhecido é sinal de versão, não de bug

`UNKNOWN_FIELD` (config de servidor) quer dizer **site novo contra agente velho**. Mostre a versão
do agente ao lado — ela já viaja no `User-Agent` e no retrato periódico.

### 8. Nunca mande `siteServerId` nem `siteToken` no `desired`

Eles voltam com `FIELD_NOT_REMOTELY_WRITABLE`. O pareamento se troca no painel local, na máquina.

### 9. Trate `rconPassword` como segredo de execução

Ver §2.2. Ela não volta em `GET` nenhum deste agente — nem agora, nem depois.

---

## 8 — Critérios de aceite

Três, verificáveis, e nenhum deles depende de olhar código:

1. **A tela inteira atravessa.** Gravar `hostname`, `worldSize`, `saveInterval`, `gamePort` e
   `enabled` no site, e ver, em ≤30 s: o `.ini` daqui com os cinco valores, e um ACK com
   `applied: true` e `requiresRestart` contendo os quatro que pedem restart (todos menos
   `enabled`).
2. **O snapshot da loja substitui.** Publicar um catálogo de 3 categorias e 10 ofertas, ver a
   vitrine in-game com exatamente isso; publicar de novo sem uma oferta, e vê-la sumir — com
   `stats.offersRemoved: 1` no ACK.
3. **O VIP não dobra.** Mandar um `grant` de 30 dias, derrubar o agente **antes** de o ACK sair
   (`pm2 stop`), subir de novo, e conferir que o vencimento continua a 30 dias — e que o site
   recebe o ACK daquela versão sem uma segunda concessão.

---

## 9 — O que foi construído deste lado

| Arquivo | O quê |
|---|---|
| `core/src/site/config.ts` | os 23 campos, a régua de cada um, o `enabled` e o `autoUpdate` pelos caminhos próprios, e os dois campos recusados |
| `core/src/site/domains.ts` | o laço genérico: `version`, `ETag`, ACK em disco, um relógio por assunto |
| `core/src/site/appliers/store.ts` | o snapshot da loja, com a régua da rota local |
| `core/src/site/appliers/kits.ts` | o snapshot dos kits, casado por `slug`, com a tradução de `servers[]` |
| `core/src/site/appliers/vips.ts` | os verbos do VIP |
| `core/src/site/client.ts` | `domainConfig()` e `ackDomainConfig()` |
| `core/src/http/routes/site.ts` | `GET /api/site/status` passou a dizer **quais assuntos o site está escrevendo** |
| `core/src/index.ts` | um laço por assunto, por **um** pareamento; desligado por padrão |
| `.env.example` | `SITE_DOMAIN_PULL_ENABLED`, `SITE_DOMAIN_INTERVAL_MS`, `SITE_DOMAINS` |

**1055 testes verdes** (15 em `core/test/site-domains.test.ts`, 12 em
`core/test/site-config.test.ts`, 6 em `core/test/steam-auto-update.test.ts` e 13 em
`core/test/site-fixtures.test.ts`), typecheck e lint limpos.

### 9.1 As decisões que valem discussão

1. **O canal de rede nasce desligado.** Ver §1.3. Se vocês preferirem o contrário, é uma linha —
   mas ela precisa vir com o cadastro do outro lado pronto.
2. **VIP com verbos, e não snapshot.** Ver §6.1. É a única saída que não revoga o que o painel
   local concedeu.
3. **Um laço por agente, não por servidor.** Ver §3.3.
4. **A régua é importada da rota local, não copiada.** `storeCategoryBody`, `storeOfferBody` e
   `kitBody` são os mesmos objetos zod que o painel usa. Uma segunda régua para a mesma tabela é
   uma régua que vai divergir, e a que ficar mais frouxa é a que grava.

---

## 10 — O que continua fora

| O quê | Por quê |
|---|---|
| `wipe-run` e o RCON cru | `Docs/22` §4. **Nunca** vêm por este canal: são execução remota arbitrária com outro nome |
| A **agenda de wipe** (calendário, mensagens, blueprints) | não é `.ini` e não é catálogo: é outro modelo de dados, e pede contrato próprio. Continua só no painel local |
| Os **loadouts** | mesma razão dos kits, mas eles ainda não têm chave estável exposta ao site. Se fizerem falta, é o mesmo desenho da §5 |
| `siteServerId` / `siteToken` | §2.2 |
| Os **plugins** e o **Oxide** | reescrevem arquivos com o servidor parado; é operação de quem está na máquina |

---

## 11 — Perguntas que este documento não responde

1. **Vocês modelam a loja por `Server` ou por agente?** Se for por `Server`, a §3.3 vira trabalho
   de vocês: responder o catálogo do agente em todos os `Server` dele.
2. **O painel do site vai mostrar `requiresRestart` e `stats`?** Sem isso, o admin grava e conclui
   que não funcionou — é o defeito que os dois campos existem para evitar.
3. **Quem pode gravar `identity` e `rconPassword` aí?** Aqui os dois são gravados por qualquer
   `desired`; a régua de **quem** manda é de vocês.
