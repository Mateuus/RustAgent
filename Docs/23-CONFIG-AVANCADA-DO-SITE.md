# 23b — Configuração avançada pelo site: as quatro áreas aprovadas

> **Para quem é.** Para quem escreve **deste lado** (o agent) e para quem escreve **do lado do
> site**. Ele é o pedido formal das **quatro áreas de configuração** que o dono aprovou trazer
> para o painel do site em **04/09/2026**, e o mapa do que falta de cada uma.
>
> **O que ele diz.** Por área: o que o agent **já tem** (com arquivo:linha), o que **falta**
> atravessar, as armadilhas já medidas e as perguntas que ninguém respondeu. As quatro áreas são
> as que o [`Docs/23-CONFIG-PELO-SITE.md`](23-CONFIG-PELO-SITE.md) §10 listava como *"o que
> continua fora"* — a decisão do dono é trazê-las para dentro.
>
> **O que ele NÃO é.** **Não é contrato.** Nenhuma das quatro áreas tem rota fechada, corpo
> fechado ou vocabulário de erro fechado. Ele também **não substitui** o
> [`Docs/22`](22-COMANDOS-E-CONFIG-DO-SITE.md) — é a continuação dele, e depende dele: a fila de
> comandos, a config desejada, a `version`, o `ETag` e o ACK são de lá, e não se repetem aqui.
>
> ####  NENHUMA DAS QUATRO ESTÁ IMPLEMENTADA **NESTE** REPOSITÓRIO  ####
>
> Zero linha de código das quatro áreas existe aqui em 04/09/2026 — e isso inclui a área 1, apesar
> de ela ser a mais barata. As áreas **2, 3 e 4 não existem em lado nenhum**: nem aqui, nem no
> site.
>
> **✅ A área 1 saiu, em 04/09/2026 — a assimetria acabou.** Enquanto este documento era escrito,
> o site tinha **terminado** a metade dele (`autoUpdate` como oitavo campo do `desired`, com a
> etiqueta `oz-rust/4` nos dois manuais) e **o par deste lado não existia**: o agent respondia
> `UNKNOWN_FIELD`, que era o desfecho correto e não uma falha. **Agora ele existe**, e a §3.5 conta
> a decisão e o que foi construído. As áreas **2, 3 e 4 continuam sem uma linha em lado nenhum**.
>
> **Data:** 04/09/2026 (a §3.5 e o §2.2, no fim do mesmo dia).
> **Contrato:** `oz-rust/6` (a `/5` foi a reconciliação desta área; a `/6` foi a remoção do
> campo `exists` do saldo, alheia a esta lista) — a etiqueta subiu nos dois manuais na reconciliação do
> `Docs/23-CONFIG-PELO-SITE.md`, e o `autoUpdate` entrou nela junto com os outros 22 campos. Ver
> §2.2, que diz quais números sobram para as áreas 2, 3 e 4.
> **Pré-requisito:** [`Docs/20`](20-INTEGRACAO-OZCOIN-AGENT.md) (o canal, o bearer, o
> `X-Server-Id`), [`Docs/22`](22-COMANDOS-E-CONFIG-DO-SITE.md) (comando × config, a `version`, o
> ACK) e [`Docs/23-CONFIG-PELO-SITE.md`](23-CONFIG-PELO-SITE.md) (os 23 campos, o canal de rede, o
> snapshot que substitui).
>
> ####  ⚠️ ESTE ARQUIVO DIVIDE O NÚMERO 23 COM OUTRO  ####
>
> Ele se chama `23-CONFIG-AVANCADA-DO-SITE.md`, e o número 23 já é do `23-CONFIG-PELO-SITE.md`.
> Renomear para `24-` é uma linha de `git mv` e **ninguém decidiu ainda** — até lá o README o
> indexa como **23b**, e este cabeçalho existe para que ninguém conclua que um dos dois é rascunho
> do outro. São documentos diferentes: o 23 descreve o que **já foi construído** deste lado; este
> descreve o que **não existe em lugar nenhum**.

---

## 0 — Índice

| § | Assunto |
|---|---|
| [1](#1--em-uma-página) | Em uma página: as quatro áreas e o estado de cada uma |
| [2](#2--as-quatro-regras-que-valem-para-as-quatro-áreas) | As **quatro regras** que valem para as quatro áreas |
| [3](#3--área-1--atualização-automática-e-build) | **Área 1** — atualização automática e build (**feita** — §3.5) |
| [4](#4--área-2--wipe-e-calendário) | **Área 2** — wipe e calendário |
| [5](#5--área-3--plugins-e-oxide) | **Área 3** — plugins e Oxide |
| [6](#6--área-4--admins-bans-e-mensagens) | **Área 4** — admins, bans e mensagens |
| [7](#7--as-perguntas-em-aberto) | As **perguntas em aberto** — registradas, não respondidas |
| [8](#8--ordem-recomendada-e-o-que-cada-área-destrava) | **Ordem recomendada** e o que cada área destrava |

**Vou mexer em…** auto-update → §3 · agenda de wipe → §4 · plugin ou permissão do Oxide → §5 ·
admin, ban ou mensagem → §6 · qualquer uma delas → **§2 antes de tudo**.

---

## 1 — Em uma página

| # | Área | O que o agent já tem | O que falta | Rota nova? |
|---|---|---|---|---|
| 1 | **Atualização automática e build** | ✅ **tudo** — o campo `autoUpdate` entrou em 04/09/2026, por servidor e sem reiniciar o agent (§3.5) | nada | **não** |
| 2 | **Wipe e calendário** | a **Fase 6 inteira**: 29 rotas, agendador de 30 s, reconciliação, blueprints por VIP | versionar a agenda e fazê-la atravessar como **estado** | sim |
| 3 | **Plugins e Oxide** | 12 rotas de plugin + 9 de Oxide, dependências resolvidas, config por plugin com backup | espelho do acervo, o desejado de "o que está ligado", e a config atravessando | sim (várias) |
| 4 | **Admins, bans e mensagens** | admins por RCON, bans com reconciliação, agendador de mensagens | três desenhos diferentes num pacote — ver §6 | sim (várias) |

**O que as quatro têm em comum:** nenhuma existe, nenhuma tem contrato, e **as quatro são
opinião do site sobre o estado da máquina** — não ordem pontual. A única peça de qualquer uma
delas que é *comando* é o **broadcast** (§6.3), e é por isso que ele é o único caso da §6 que não
cabe no molde do `desired`.

---

## 2 — As quatro regras que valem para as quatro áreas

### 2.1 O site NUNCA chama o agent

Repetido aqui — pela terceira vez em três documentos — porque quem ler **só este** vai propor um
webhook. As três razões continuam medidas no código do site:

1. **`agents.base_url` é fixada no PRIMEIRO beacon e nunca mais atualizada** —
   `agent-public.routes.ts:148` faz `baseUrl: agent.baseUrl || baseUrl` dentro do ramo de agent já
   existente. Um IP residencial que mude quebra o canal **para sempre**.
2. **O endereço é HTTP puro montado do IP do socket** — `` `http://${ip}:${port}` ``
   (`agent-public.routes.ts:71`). Sem TLS, sem hostname.
3. **A máquina fica atrás do NAT de uma conexão residencial.** Nada entra.

Logo, **toda área nova é uma das duas formas**, e nunca uma terceira:

| Forma | Quem inicia | Molde já pronto |
|---|---|---|
| **PUSH** — o agent empurra o retrato | agent | `POST /api/agent/server/status` (`core/src/site/status.ts`) |
| **PULL** — o agent puxa o desejado | agent | `GET /api/agent/server/config` (`core/src/site/config.ts`) e `GET /api/agent/config/:domain` (`core/src/site/domains.ts`) |

Um canal de push por parte do site falharia **sempre**, e o sintoma seria "o botão não faz nada" —
sem nada dizendo por quê.

### 2.2 A etiqueta de contrato sobe nos DOIS manuais, no mesmo commit

Regra do `Docs/20` §23: um `grep -Eom1 'oz-rust/[0-9]+'` nos dois manuais tem de devolver o mesmo
número.

> ####  A ETIQUETA EM USO É `oz-rust/6`, E ELA JÁ FOI RECONCILIADA  ####
>
> Medido em **04/09/2026**, depois da remoção do campo `exists` do saldo:
>
> ```
> grep -Eom1 'oz-rust/[0-9]+' Docs/20-INTEGRACAO-OZCOIN-AGENT.md                     → oz-rust/6
> grep -Eom1 'oz-rust/[0-9]+' <site>/docs/mateuus/rust/docs/INTEGRACAO-OZCOIN-RUST.md → oz-rust/6
> ```
>
> **`oz-rust/4` foi do `autoUpdate`** — a área 1 desta lista, então o oitavo campo do `desired`.
> **`oz-rust/5` é da reconciliação**: os 23 campos da rota 13 (o `autoUpdate` entre eles) e as
> rotas 15 e 16 chegaram ao §23 dos dois manuais, com o corpo idêntico byte a byte, no mesmo
> commit — `Docs/20` §23.11 e a §23.9 do manual do site.
>
> ⚠️ **`oz-rust/6` NÃO É DESTA LISTA, e por isso a reserva se moveu uma casa.** Ela foi gasta com
> a **remoção do campo `exists`** da rota 2 (`GET /ozcoins/balance`) — decisão do dono sobre a H58
> do backlog do site. Ali um byte MUDOU no fio, que é exatamente o caso em que a etiqueta tem de
> subir; reserva é conveniência de planejamento, e quando as duas conflitam quem cede é a reserva.
>
> Sobra então, para as áreas **2, 3 e 4** desta lista: **`/7`, `/8` e `/9`**. As **rotas** seguem
> a mesma contagem — 1–10 no `Docs/20`, 11–14 no `Docs/22`, 15–16 do canal de rede — então **a
> próxima rota nova é a 17**.

### 2.3 Nada de segredo no payload

Não atravessa o fio, em nenhuma das quatro áreas: senha de RCON de outro serviço, token de agent,
chave de API, caminho de arquivo que contenha credencial.

> ####  A EXCEÇÃO QUE JÁ EXISTE É EXCEÇÃO, NÃO PRECEDENTE  ####
>
> `rconPassword` atravessa hoje, por decisão do dono, com os avisos do `Docs/23` §2.2. Isso **não
> abre a porta** para o resto: cada segredo novo é uma decisão nova, e o teste é sempre o mesmo —
> *o valor fica gravado no banco do site*.
>
> **A área 3 traz o candidato mais perigoso e ele é fácil de não ver:** a config de um plugin é
> JSON arbitrário, e JSON arbitrário de plugin de Rust **contém webhook de Discord, chave de API
> de mapa e token de serviço de terceiro o tempo todo**. Se a config de plugin atravessar, ela
> atravessa segredo de terceiro junto — e isso precisa estar escrito **antes** de a primeira
> linha existir, não depois.

### 2.4 Cada área tem capability PRÓPRIA, e ela nasce desligada

**Não pendurar em `rust-config`.** Ela hoje já concede duas coisas (gravar config desejada **e**
enfileirar `start`/`stop`/`restart`) e está em `SENSITIVE_CAPABILITIES`
(`ad_oz_backend/src/modules/admin/adminPermissions.ts:82` e `:89`). Empilhar wipe, plugin e admin
de jogo nela é dar cinco poderes por uma caixa marcada.

Proposta de nomes, no molde das que já existem (`rust-servers`, `rust-deliveries`, `rust-players`,
`rust-status`, `rust-config`):

| Área | Capability | Sensível? | Por quê |
|---|---|---|---|
| 1 | `rust-update` | sim | desligar o auto-update deixa o servidor recusando todo mundo depois de um patch |
| 2 | `rust-wipe` | **sim** | mesmo sem a execução, mexer na agenda muda quando o mundo de todo mundo zera |
| 3 | `rust-plugins` | sim | ligar plugin é escrever arquivo e recarregar código no servidor |
| 4 | `rust-admins` / `rust-bans` / `rust-messages` | as duas primeiras, sim | são **três** domínios, e conceder `ownerid` não é a mesma coisa que agendar um aviso de chat |

**Todas nascem desligadas** — ninguém as tem até o root marcar a caixa. É a mesma regra de
`scum-map-admin` e `rust-players`.

---

## 3 — Área 1 — atualização automática e build

**Onda 1.** A mais barata das quatro: **nenhuma rota nova**, um campo no `desired` que já existe.

✅ **Feita em 04/09/2026, nos dois lados.** O site entregou a metade dele de manhã (contrato
`oz-rust/4`); o agent entregou a dele no fim do mesmo dia, e o contrato dos 23 campos ficou sob
`oz-rust/5`. **O que segue é o mapa de como ela foi feita** — as §3.1 a §3.4 descrevem o terreno, e
a §3.5 é a decisão.

### 3.1 O que o agent já tem

| Peça | Onde | Estado |
|---|---|---|
| O **vigia da Steam** — compara o build instalado com o publicado | `core/src/steam/update-watcher.ts:147` (classe), laço em `:160`, intervalo `STEAM_UPDATE_CHECK_INTERVAL_MS` (15 min) | pronto |
| Primeira conferência **60 s** depois do boot, não depois do intervalo inteiro | `update-watcher.ts:143` (`DEFAULT_FIRST_CHECK_DELAY_MS`) | pronto |
| O **ciclo automático** — derruba, atualiza, sobe, com **3 tentativas por build** e 1 h entre elas | `update-watcher.ts:347` (`#tryAutoUpdate`); a operação em `core/src/ops/service.ts:869` (`#autoUpdate`) | pronto |
| Leitura local do build | `GET /api/servers/:id/steam-update` (`core/src/http/routes/steam-updates.ts:49`) e `POST .../check` (`:63`) | pronto |
| O build **já viajando para o site** | `core/src/site/status.ts:236-246` — `build.installed`, `build.published`, `build.updateAvailable`, `build.checkedAt`, `build.autoUpdate` | **já atravessa** |
| O interruptor | `STEAM_AUTO_UPDATE`, lido **uma vez no boot** (`core/src/config.ts:889`) e entregue ao vigia em `core/src/index.ts:999` | **é o problema** |

### 3.2 O que faltava, e por onde ele tinha de entrar

**Um campo.** `autoUpdate: boolean` dentro do `desired` de `GET /api/agent/server/config` — mesma
rota, mesma `version`, mesmo `ETag`, mesmo ACK. **Rota nova: nenhuma.** *(Feito — §3.5. O que segue
é o raciocínio que levou até lá, e ele continua valendo como aviso para as outras três áreas.)*

> ####  QUEM APLICA NÃO É O `updateSettings`, E PROCURAR NO `.ini` É PERDER O DIA  ####
>
> `autoUpdate` **não é campo do `.ini`**. Ele não existe em `RESTART_KEYS`, não existe em `KEY_OF`
> e o `updateSettings` (`core/src/servers/supervisor.ts:544`) não o conhece.
>
> E o `updateSettings` **ignora em silêncio o que não conhece**: `if (key === undefined) continue`
> (`supervisor.ts:591`). Mandá-lo no patch devolveria `applied: true`, `errors: []` — e o site
> concluiria que a atualização automática está desligada quando ela continua ligada. É exatamente
> a armadilha já medida e escrita no cabeçalho de `core/src/site/config.ts:26-33`.
>
> **Quem aplica é o caminho de `/steam-update`** — o `SteamUpdateWatcher`. O molde a copiar é o do
> **`enabled`**, que também não passa pelo `updateSettings`: ele tem tratamento próprio dentro do
> `planOfDesired` (`core/src/site/config.ts:266-272`), é aplicado **depois** do patch
> (`config.ts:518-527`) e a razão está escrita em `config.ts:186-200`. `autoUpdate` é o mesmo
> caso, linha por linha.

**E falta o que não se vê:** hoje a flag é **imutável em runtime**. Ela é lida do env no boot,
entra no construtor do vigia (`index.ts:999`) e é devolvida como `#options.autoUpdate` em
`stateOf()` (`update-watcher.ts:249`). Não há setter, não há persistência. Aplicar a opinião do
site exige:

1. um jeito de trocá-la **sem reiniciar o agent** — senão o ACK teria de dizer "reinicie o
   agente", e **esse campo não existe**: o `requiresRestart` do contrato é do **jogo**, não do
   agent, e enfiar um valor de outro assunto nele quebra o significado da lista para todo mundo;
2. persistir a escolha, para ela sobreviver ao restart. O molde é a `version` aplicada, guardada
   pelo `MetaRepository` (`core/src/site/config.ts` já o importa).

> ####  A FLAG É DO AGENT, E O `desired` É DO SERVIDOR  ####
>
> `STEAM_AUTO_UPDATE` é **uma flag para a máquina inteira**: o vigia varre todos os servidores no
> mesmo laço (`update-watcher.ts:276-289`) lendo a **mesma** `#options.autoUpdate`. O `desired`,
> ao contrário, é **por servidor** — ele chega com `X-Server-Id`.
>
> Casar os dois sem decidir nada produz o pior desfecho: dois servidores do mesmo agent mandando
> opiniões diferentes, e o último a chegar ganhando — em silêncio, a cada 30 segundos.
>
> **Recomendação deste lado:** o agent ganha um override **por servidor**, e a flag do env vira o
> *default* de quem não tem opinião. É a leitura que casa com o resto do canal (tudo é por
> servidor) e com a realidade (branch e `appId` já são por servidor —
> `update-watcher.ts:232-233`). **Está na §7 como pergunta**, porque muda o modelo de dados dos
> dois lados.

### 3.3 As duas armadilhas do lado do site

> ####  `null` (NÃO GERENCIADO) ≠ `false` (GERENCIADO E DESLIGADO)  ####
>
> Campo ausente do `desired` significa **"o site não opina sobre ele"** — não é `null`, não é
> "apague", e **não é `false`** (`Docs/22` §2.4).
>
> Uma coluna que nasça `NOT NULL DEFAULT false` no banco do site colapsa os dois: o admin abre a
> tela para acertar o **hostname**, grava, e o `desired` sai carregando `autoUpdate: false` que
> ninguém escolheu. A atualização automática desliga.
>
> **E o sintoma não aparece na hora.** Ele aparece semanas depois, quando a Facepunch publica e o
> servidor passa a recusar todo mundo com "versão incompatível" — a essa altura ninguém liga uma
> coisa à outra. A coluna é **nullable**, e `null` **não entra** no `desired`.

> ####  NÃO CRIE ROTA PARA LER O BUILD  ####
>
> Ela já existe e já está no ar: o retrato de 30 s carrega `build.installed`, `build.published`,
> `build.updateAvailable`, `build.checkedAt` e `build.autoUpdate`
> (`core/src/site/status.ts:236-246`) — e o site **já os lê** hoje
> (`ad_oz_backend/src/modules/agent-private/agent-server-status.controller.ts:283`, exibidos em
> `ad_oz_frontend/src/pages/Admin/tabs/RustStatusTab.tsx:1374`).
>
> Uma rota de leitura de build seria uma segunda fonte para o mesmo número, e as duas divergiriam
> na primeira vez que uma delas falhasse.

### 3.4 O cruzamento que ninguém desenhou

O `Docs/09` §Fase 6, no fim, diz o que falta e não bloqueava nada: *"a integração com o
`server-auto-update` — a atualização mensal **normalmente** zera o mapa, e 'normalmente' é a
palavra certa: prometer wipe onde não há faz gente jogar fora a base à toa."*

Ligar o auto-update pelo site num servidor que tem **agenda de wipe** (área 2) é esse cruzamento.
Ele não bloqueia a onda 1 — mas quem fizer a onda 2 encontra o problema pronto.

---

### 3.5 A DECISÃO, e o que foi construído — 04/09/2026

**Decidido: implementar** — a saída (a) das duas que estavam na mesa. Recusar o campo por
desenho custaria mais do que aceitá-lo: o site já o manda, a tela dele já existe, e o desfecho de
"recusar" seria um `UNKNOWN_FIELD` eterno com o admin clicando num botão que não faz nada.

As três perguntas que travavam a §3.2 foram respondidas assim:

| Pergunta | Resposta | Onde |
|---|---|---|
| É **do agent** ou **do servidor**? (§7 #1) | **do servidor.** A flag do env vira o *padrão da máquina*; cada servidor pode ter opinião própria, gravada em `meta` na chave `steam.auto_update.<serverId>` | `core/src/steam/update-watcher.ts` — `autoUpdateFor()` e `setAutoUpdate()` |
| Como muda **sem reiniciar o agent**? (§7 #2) | a leitura é feita **na hora da decisão**, dentro do `check()` — não há valor cacheado em construtor. A rodada seguinte do vigia já usa o novo | `update-watcher.ts`, no ramo do `updateAvailable` |
| Como o site distingue **"gerenciado e desligado"** de **"não gerenciado"**? (§7 #10) | **três estados**: chave ausente ⇒ o padrão da máquina; `false` ⇒ desligado; `true` ⇒ ligado. Campo ausente do `desired` **não grava nada** | `core/src/site/config.ts` — `AUTO_UPDATE_FIELD` |

**A régua contra a coerção é a peça mais importante deste campo**, e ela é uma linha: só
`boolean` passa. A string `"false"` volta como `INVALID_VALUE`, porque `Boolean('false')` é
`true` — coagir aqui **ligaria** a atualização que o site pediu para desligar. Há um teste
com esse nome.

**O caminho de aplicação é o do `/steam-update`, e não o `updateSettings`** — exatamente como a
§3.2 previa. O `SiteConfig` chama `setAutoUpdate` **fora** do patch do `.ini`, no mesmo molde do
`enabled`; sem esse caminho montado, o campo volta em `errors[]` como
`FIELD_NOT_REMOTELY_WRITABLE`, e nunca `applied: true` em silêncio.

**A confirmação de que a opinião pegou já viajava:** `build.autoUpdate` no retrato de 30 s
(`core/src/site/status.ts`) passou a levar o valor **efetivo daquele servidor**, e não mais a flag
global. Nenhuma rota nova, dos dois lados.

O contrato está no §23.11 do `Docs/20` e na §23.9 do manual do site, com o corpo idêntico, sob a
etiqueta `oz-rust/5`.

### 3.6 O que a decisão deixou de fora

- **O painel local não ganhou botão.** A opinião por servidor se escreve pelo site ou some no
  `.env`; a tela local continua **mostrando** o valor efetivo (ela já lê o `stateOf`). Um segundo
  lugar de escrita é trabalho novo, e ninguém pediu.
- **`STEAM_AUTO_UPDATE` continua existindo e continua valendo** para quem não tem opinião gravada.
  Ela não foi aposentada: é o padrão da máquina, e é o que faz um servidor novo nascer com o
  comportamento que o dono escolheu na instalação.
- **O cruzamento com a agenda de wipe (§3.4) continua aberto.** Ligar o auto-update pelo site num
  servidor com agenda de wipe é o mesmo problema de antes — ele não bloqueava a onda 1 e continua
  não bloqueando.

---

## 4 — Área 2 — wipe e calendário

**A Fase 6 está inteira na árvore, e entregue** (`Docs/09` §Fase 6). Esta área não constrói wipe:
ela decide **como a agenda atravessa o fio**.

### 4.1 O que o agent já tem

| Grupo | Rotas | Onde | Executa? |
|---|---|---|---|
| **A agenda** | 10 — `GET/PUT /wipe/settings`, `GET /wipe/plans`, `GET /wipe/upcoming`, `POST/PATCH/DELETE /wipe/plans[/:id]`, `restore`, `purge`, `GET /wipe/upcoming/me` | `core/src/http/routes/wipe.ts:307`…`:606` | **não** — declarado em `wipe.ts:12-18` |
| **A fila de mapas** | 6 — listar, adicionar, sortear, reordenar, `versionOk`, remover | `core/src/http/routes/wipe-maps.ts:189`…`:365` | **não** |
| **A execução** | 9 — `preview`, `plugin-data`, `exec-settings` (GET/PUT), `runs` (histórico e detalhe), **`POST /runs`**, `resume`, `cancel` | `core/src/http/routes/wipe-runs.ts:135`…`:533` | **sim — duas delas** |
| **Os blueprints** | 4 — ler, settings, `snapshot`, `restore` | `core/src/http/routes/wipe-blueprints.ts:81`…`:164` | **não** — declarado em `:9` |

Mais o motor:

- **o agendador** — `WipeScheduler` (`core/src/wipe/scheduler.ts:87`), tick de **30 s**
  (`scheduler.ts:39`), que dispara **antes da hora** pelo maior offset de aviso
  (`scheduler.ts:213`); ligado em `core/src/index.ts:1651`;
- **a reconciliação** — `reconcile()` (`core/src/db/wipe-schedule-repository.ts:622`) refaz
  `wipe_plans` a partir do cálculo puro, **sem atropelar humano**: só toca linhas
  `kind != 'manual'`, `pinned = 0` e status reescrevível, e só no futuro
  (`wipe-schedule-repository.ts:637`, `:646-649`);
- **a cadência não é cron** — é `everyDays` + `timeOfDay` + `timeZone` IANA + `anchorAt`
  (`core/src/types/wipe.ts:73-92`), com o forçado da Facepunch **derivado**, nunca tabelado
  (`core/src/wipe/schedule.ts:76`, `:96`), e três saídas para a colisão: `reanchor`, `absorb`,
  `ignore` (`types/wipe.ts:63`).

### 4.2 O que falta

Um assunto novo de estado desejado para a **agenda** (settings + planos + fila de mapas), com
`version`, `ETag` e ACK — o molde do `Docs/22` §2.4/§2.5.

> ####  WIPE É ESTADO, NÃO COMANDO — E ISSO JÁ FOI DECIDIDO  ####
>
> A agenda **não entra na fila de comandos**. O argumento já está escrito, para a config, no
> cabeçalho de `core/src/site/config.ts:4-11`, e vale palavra por palavra aqui:
>
> > *"Um comando é uma ordem que ENVELHECE (…) Config é uma descrição do mundo (…) Dar TTL a ela
> > criaria um servidor que volta sozinho para uma config antiga porque o ACK se perdeu."*
>
> Uma agenda de wipe na fila de comandos obriga a escolher entre **um TTL curto**, que mata o
> agendamento antes de o agent puxar, e **um TTL longo**, que ressuscita um wipe cancelado três
> dias depois. As duas saídas são piores que o problema. **Estado desejado versionado, e o agent
> reconcilia.**

> ####  A AGENDA É POR SERVIDOR — O CANAL DE REDE DO `Docs/23` NÃO SERVE  ####
>
> `GET /api/agent/config/:domain` (`store`, `kits`, `vips`) é **do agente**: a §3.3 do `Docs/23`
> explica que as tabelas da loja não têm `server_id` porque a loja é UMA.
>
> A agenda de wipe é o oposto: ela é gravada **chave/valor por servidor**
> (`core/src/db/wipe-schedule-repository.ts:179-189`), e cada servidor tem cadência, fuso e fila
> de mapas próprios. Pendurar `wipe` naquele canal faz a agenda do `pvp1` valer no `pvp2` — e o
> sintoma é o mundo errado zerando.
>
> Ou ela vai pela **config de servidor** (rota 13, que já é por `X-Server-Id`), ou nasce um canal
> por servidor. **Está na §7.**

> ####  `/runs` É A QUE APAGA, E ELA NÃO VEM  ####
>
> **Duas** rotas apagam, não uma: `POST /servers/:id/wipe/runs` (`wipe-runs.ts:268`) e
> `POST /servers/:id/wipe/runs/:runId/resume` (`wipe-runs.ts:461`), que reabre a mesma operação e
> pode executar o passo `apagar` se ele não terminou.
>
> **Nenhuma das duas vem para o site**, e o motivo não é gosto: o `POST /runs` exige o `identity`
> **DIGITADO** no corpo e conferido contra o `config.identity`, com 400 `WIPE_IDENTITY_MISMATCH`
> (`wipe-runs.ts:295-303`), mais uma `Idempotency-Key` deduplicada em consulta **e** por índice
> único na corrida (`wipe-runs.ts:274-292`, `:384-402`). Uma rota remota **não tem como exigir a
> digitação** — e sem ela a proteção é decorativa.
>
> É a mesma decisão do `Docs/22` §4, onde o dono vetou `wipe-run` da allowlist de comandos.
> **O site gerencia a AGENDA; a execução continua sendo do agent, pelo calendário dele.**

### 4.3 As três armadilhas

> ####  O `now` DE TODA RESPOSTA É O RELÓGIO DO AGENT  ####
>
> A contagem regressiva sai dele, corrigida pela diferença para o relógio de quem olha — a razão
> está em `wipe.ts:33-38`. Ele é `Date.now()` do processo do agent, gerado no handler
> (`wipe.ts:258-262`, `wipe-runs.ts:174` e seguintes, `core/src/wipe/preview.ts:166`).
>
> **E há um buraco medido:** as **6 rotas de `wipe-maps.ts` não devolvem `now`** (`:198`, `:264`,
> `:301`, `:329`, `:357`, `:378`). É a única sub-área do wipe fora da convenção, e ela aparece na
> hora em que o site tentar mostrar a fila de mapas com prazo.

> ####  `pinned` E `generatedFor` SÃO A MARCA DE "HUMANO MEXEU"  ####
>
> `pinned` (`core/src/types/wipe.ts:347`) e `generatedFor` (`:345`) são o que faz a reconciliação
> **não** desfazer um adiamento feito à mão. Se o site virar dono da agenda, ele precisa de um
> conceito equivalente — senão a primeira versão que ele mandar apaga o que alguém ajustou no
> painel local, e o desfecho é o mesmo do snapshot da loja (`Docs/23` §1.2): **enquanto o site
> opinar, ele é o dono**. A diferença é que aqui o que se perde é a data em que o mundo zera.

> ####  NÃO HÁ `version` NEM `ETag` NA AGENDA HOJE, E NEM RECONCILIAÇÃO PERIÓDICA  ####
>
> Dois fatos que mudam o desenho:
>
> 1. **Nenhum token de concorrência existe** no domínio de wipe. `PUT /wipe/settings` recebe o
>    objeto inteiro e é last-write-wins: duas abas abertas se sobrescrevem em silêncio. A
>    `version` que o contrato pede **não existe de nenhum dos dois lados** — é trabalho novo aqui,
>    não só lá.
> 2. **`reconcile()` roda em dois momentos e mais nenhum:** no boot (`core/src/index.ts:1290`) e a
>    cada `PUT /wipe/settings` (`wipe.ts:337`). **Não há timer que reconcilie.** Um `desired` que
>    chegue pelo laço de 30 s e grave as settings sem chamar `reconcile` deixa a agenda
>    materializada **antiga** até o próximo boot — e a tela do site mostraria a data nova enquanto
>    o agendador dispara a velha.

### 4.4 O que não foi validado

`Docs/09` §Fase 6, *"O que NÃO foi validado"*, e continua verdade: **nenhum wipe foi executado
contra um servidor de Rust de verdade**; o plugin de blueprints **nunca foi compilado**; e a
tabela `events` (migração 27) existe sem nenhuma linha de código que a leia. O site pode mostrar a
agenda — **não pode prometer** que a execução funciona.

---

## 5 — Área 3 — plugins e Oxide

**A maior das quatro**, e a que mais toca disco.

### 5.1 O que o agent já tem

| Assunto | Rotas | O mecanismo real | Onde |
|---|---|---|---|
| **A biblioteca de rede** | `GET/POST /plugins`, `DELETE /plugins/:pluginId` | três lugares: `Plugins\` (rede), `Plugins\<id>\` (custom), `Servers\<id>\oxide\plugins\` (execução, **cópia derivada**) | `core/src/http/routes/plugins.ts:145`, `:147`, `:154`; modelo em `core/src/oxide/library.ts:5-22` |
| **O acervo de um servidor** | `GET/POST /servers/:id/plugins`, `PUT /servers/:id/plugins/:pluginId` | **ligar** = copiar o `.cs` + `oxide.reload`; **desligar** = `oxide.unload` **antes** do `rm` | `plugins.ts:189`, `:196`, `:220`; `library.ts:1105`, `:1180`; `core/src/oxide/plugins.ts:360` |
| **Dependências** | `POST /servers/:id/plugins/:pluginId/enable-with-deps` | DFS em **pós-ordem topológica**; ciclo → 409 `PLUGIN_DEPENDENCY_CYCLE`; faltante no acervo → 409 `PLUGIN_DEPENDENCY_MISSING` | `plugins.ts:347`; `library.ts:693`, `:718-734`, `:743-751` |
| **Config por plugin** | `GET/PUT/DELETE /servers/:id/plugin-configs[/:plugin]` | grava em `Servers\<id>\oxide\config\<Nome>.json`, com **backup obrigatório** e releitura do disco | `plugins.ts:278`, `:284`, `:303`, `:324`; `library.ts:1019` |
| **Grupos e permissões do Oxide** | 9 rotas (`GET /oxide`, `GET /oxide/permissions`, grupos, permissões, membros) | **100% RCON**: `oxide.group add/set/parent/remove`, `oxide.grant/revoke group`, `oxide.usergroup add/remove` | `core/src/http/routes/oxide.ts:169`…`:432`; `core/src/oxide/permissions.ts:212`…`:374` |

Detalhes que mudam o desenho de quem for espelhar:

- **Ligar/desligar não é `.disabled` e não é mover arquivo.** Não existe nenhuma ocorrência de
  `.disabled` no `core/src`. É copiar/apagar arquivo **mais** comando de console.
- **`oxide\config\` e `oxide\data\` NUNCA são tocados** ao ligar ou desligar plugin
  (`library.ts:25-31`, `:1177-1178`). Desligar um plugin **não** apaga a config dele — e remover
  da biblioteca, também não.
- **O estado de grupos e permissões mora em protobuf binário** (`oxide.groups.data`,
  `oxide.users.data`) que o próprio Oxide reescreve. O agent **não toca o arquivo**, por decisão
  explícita (`permissions.ts:4-16`) — tudo passa pelo console.
- **As dependências têm duas naturezas:** *dura* (`// Requires: X`, lida do source cru —
  `core/src/oxide/plugin-metadata.ts:84`) e *mole* (`[PluginReference]` — `:115-116`). Só a
  **dura** entra no `enable-with-deps` (`library.ts:740`); a mole vira aviso.
- **Os dois `GET` têm efeito colateral de escrita** — varrem a pasta e **adotam** `.cs` que já
  estava lá (`plugins.ts:140-144`, `:181-187`; `library.ts:1327`). Quem for espelhar precisa saber
  que "ler" muda o acervo.
- **Ordem de grandeza real hoje:** 10 plugins na biblioteca, ~932 KB somados, o maior com 259 KB.
  Dezenas, não centenas.

### 5.2 O plugin que não compila é um estado real — e o site precisa mostrá-lo

> ####  ELE JÁ É MODELADO, E MORA NA MEMÓRIA  ####
>
> Não há enum de status. O agent detecta por **heurística sobre a prosa do Oxide** — o Oxide não
> devolve código de erro — com a regex de `reloadFailed()` (`core/src/oxide/plugins.ts:176`), que
> reconhece `error CS\d+`, `Error while compiling`, `Failed to compile`, `Failed to load` e
> `Plugin .* failed`. **O que não casar responde `false` de propósito**: alarme falso mata a
> credibilidade do alarme verdadeiro.
>
> O resultado vira `lastReload { at, failed, output }` (`library.ts:154-160`), guardado num `Map`
> **em memória** com chave `serverId::plugin` (`library.ts:348`, escrito em `:1555`), e sai na
> view em `library.ts:458` — só para plugins **ligados**.
>
> **Duas consequências para o site:**
>
> 1. **Mostre, não esconda.** "Ligado" e "rodando" são coisas diferentes: o plugin está no
>    servidor, e o Oxide o recusou. Uma tela que só mostre o toggle verde mente. Há inclusive uma
>    **segunda via de diagnóstico independente** — o `GET /servers/:id/oxide` devolve o que o
>    Oxide **carregou de verdade** (`permissions.ts:605`), e a divergência entre as duas listas é
>    o diagnóstico (`oxide.ts:161-167`).
> 2. **Ele some no restart do agent**, e isso é deliberado (`library.ts:336-347`: *"um alarme
>    velho é pior que nenhum"*). Se o site guardar o último erro para sempre, ele reinventa
>    exatamente o problema que a decisão evitou.

### 5.3 O que falta, e a pergunta que este documento NÃO responde

Falta: o espelho do acervo (leitura, molde do espelho da loja), o desejado de **quais plugins
ficam ligados** por servidor, os grupos e permissões, e a config por plugin.

> ####  PERGUNTA EM ABERTO — COMO A CONFIG DE PLUGIN ATRAVESSA  ####
>
> **Este documento não responde, de propósito.** As duas saídas e o custo de cada uma:
>
> **(a) Opaca — o site guarda o texto e não opina** (molde do espelho da loja). Barato, honesto,
> e o admin edita JSON cru numa caixa de texto.
>
> **(b) O site valida.** Só dá para validar **sintaxe** — é exatamente o que o agent faz
> (`assertValidJson`, `core/src/oxide/plugin-config.ts:219`, que propaga a posição do parser de
> propósito). **Schema por plugin não existe em lugar nenhum**, e inventar um por plugin é
> trabalho sem fim para dezenas de plugins de terceiros que mudam sozinhos.
>
> **Em qualquer das duas, o teto de bytes é obrigatório e já tem número:** o agent recusa acima de
> **256 KB** com 400 `PLUGIN_CONFIG_TOO_LARGE` (`plugin-config.ts:74`, checado em
> `library.ts:1026-1033`), e o Fastify corta o corpo em 1 MB (`core/src/http/server.ts:275`). O
> site precisa do **mesmo** teto: sem ele, o site aceita, versiona, e o agent recusa a mesma
> versão em laço, para sempre.
>
> **E a pergunta de fundo, que é a mais difícil: quem é o dono do arquivo?** O plugin **reescreve
> a própria config ao carregar** (`SaveConfig()`) — é por isso que o agent **relê do disco depois
> de gravar** (`library.ts:1048`, razão em `:1012-1017`). Um snapshot do site que substitui apaga
> o que o plugin escreveu; um merge não existe e não vai existir. Ou o site é dono e aceita
> perder, ou a config não atravessa.
>
> **Registrada, não respondida.**

### 5.4 As duas armadilhas restantes

> ####  O `.cs` NÃO ATRAVESSA — O SITE OPINA SOBRE O QUE JÁ ESTÁ NA MÁQUINA  ####
>
> Ligar plugin é escrever código na máquina e mandar o servidor carregá-lo. É o assunto mais perto
> de "execução remota" das quatro áreas.
>
> O escopo aprovado aqui é **quais dos plugins que já estão em disco ficam ligados** — não upload
> de `.cs` pelo canal. O arquivo tem teto de 2 MB (`plugins.ts:55`) e passa por nove assinaturas
> de arquivo, byte zero e verificação de que parece C# (`plugins.ts:234`, `:285`); replicar isso
> do outro lado do fio é um projeto próprio. **Upload de plugin pelo site é outra decisão, e não
> está tomada.**

> ####  GRUPO DO OXIDE E VIP SÃO A MESMA COISA — E O VIP JÁ VEM DO SITE  ####
>
> O VIP deste projeto **é** um jogador dentro de um grupo do Oxide — `origemz.vip.bronze` →
> `silver` → `gold`, cada um herdando do anterior (`core/src/http/routes/oxide.ts:15-19`).
>
> E o assunto `vips` **já atravessa** pelo canal de rede do `Docs/23` §6. Uma rota nova que mexa
> em grupo do Oxide pelo site escreve **no mesmo lugar** que o outro canal escreve, por um caminho
> diferente, sem nenhum dos dois saber do outro. Quem desenhar a área 3 lê a §6 do `Docs/23`
> **antes** de tocar em grupos, ou constrói a segunda fonte de verdade com as próprias mãos.

---

## 6 — Área 4 — admins, bans e mensagens

**Três domínios diferentes num pacote**, e eles não compartilham desenho. A linha divisória:

| Assunto | É… | Molde |
|---|---|---|
| Admins de jogo | **estado** | `desired` versionado |
| Bans | **estado** | `desired` versionado — com a ressalva da adoção (§6.2) |
| Mensagens **agendadas** | **estado** | `desired` versionado |
| **Broadcast** ("fale isto agora") | **comando** | a fila do `Docs/22` — e a allowlist é fechada em três |

### 6.1 Admins — o agent lê o arquivo e manda comando

| O quê | Onde |
|---|---|
| `users.cfg` é **LIDO, e NUNCA escrito** | `core/src/game/admins.ts:11-21` (a regra), leitura em `:76` |
| Quem muda o estado é o **RCON**: `ownerid` / `moderatorid` | `admins.ts:157` (escolha do comando), `:162` (envio) |
| E o par: `removeowner` / `removemoderator` | `admins.ts:186` |
| Seguidos de `server.writecfg` | `admins.ts:203` |
| As três rotas | `GET` `core/src/http/routes/admin.ts:545`, `POST` `:568`, `DELETE .../:steamId?level=` `:596` |

O `?level` do `DELETE` é **obrigatório** (400 sem ele, `admin.ts:601-611`) porque **mandar o
comando errado não dá erro — não faz nada, que é pior** (`admins.ts:171-173`). E editar o
`users.cfg` à mão com o servidor no ar não adianta: o jogo reescreve o arquivo inteiro e a mudança
some sem erro, sem log e sem nada ligando uma coisa à outra.

> ####  NÃO HÁ TABELA DE ADMINS NEM NÍVEL DE PERMISSÃO DENTRO DO PAINEL DO AGENT  ####
>
> É a decisão **D5** (`Docs/03-DECISOES.md:110-118`), e ela é explícita: o painel entra com
> **usuário + senha de operador**, e *"o Steam OpenID, o PIN e os níveis por servidor **não** vêm
> agora"*. `player_admins` e a tabela de auditoria foram deixados de fora de propósito.
>
> Na árvore isso significa: um operador (`core/src/auth/operator.ts:107-109`), uma sessão **sem
> nenhum campo de papel** (`operator.ts:50-56`), e um guarda de `/api/*` que é **binário** —
> passou ou 401 (`core/src/http/auth.ts:73`). Não existe checagem de permissão por rota.
>
> O que existe é **autoria, não autorização**: `operatorOf(request)` (`admin.ts:113-119`) devolve
> o nome do operador — ou a string literal `'token de integração'`, quando veio por bearer.
>
> **Quem entra no painel do agent faz tudo.** A tela do site precisa saber disso, porque é a
> premissa que o desenho dela não pode contradizer.

> ####  ADMIN DE JOGO ≠ ADMIN DO SITE  ####
>
> Conceder `ownerid` pelo painel do site é **dar poder dentro do jogo a partir de outra base de
> identidade**. São dois sujeitos diferentes no mesmo ato: o alvo é um SteamID do jogo, quem
> concede é uma conta do site.
>
> **Três coisas precisam estar escritas ANTES de a rota existir:**
>
> 1. **Qual capability concede** — `rust-admins`, própria, sensível, nascendo desligada (§2.4).
>    Não é `rust-config`.
> 2. **Quem é o sujeito de cada metade**, e os dois no mesmo registro: o SteamID promovido **e** o
>    admin do site que apertou o botão.
> 3. **Onde fica a auditoria.** O agent grava autoria **só no log**
>    (`admin.ts:582-585`, `logger.warn` "admin promovido pelo painel") — não há tabela. O registro
>    que sobrevive tem de ser **do site**, e ele é a única prova de quem deu poder a quem.
>
> Sem as três, a rota é um caminho para escalar privilégio de uma base de identidade para outra
> sem rastro.

### 6.2 Bans — escopo, e a reconciliação que já existe

| O quê | Onde |
|---|---|
| As 5 rotas | `core/src/http/routes/bans.ts:73` (listar), `:85` (criar), `:118` (revogar), `:133` (por servidor), `:157` (sincronizar agora) |
| Escopo `network` × `servers` | `core/src/db/bans-repository.ts:41`, semântica em `:34-40` |
| **Ban `network` NÃO tem linha em `ban_servers`** — de propósito | `bans-repository.ts:11-13`: enumerar os servidores de hoje faria o ban deixar de valer no servidor de amanhã, **em silêncio** |
| A reconciliação, com **três** casos | `core/src/bans/service.ts:366`; os casos em `:9-14` |
| Disparada em **três** momentos | boot (`core/src/index.ts:365`), (re)conexão do RCON (`index.ts:264`), sob demanda (`bans.ts:157`) |
| Transporte: **`banid`, nunca `ban`** | `core/src/bans/rust-bans.ts:10-20` — o `ban` só age sobre quem está **conectado** e falha em silêncio com jogador offline |
| O prazo é **nosso** | `core/src/bans/expiry-watcher.ts:4-9` — o ban do Rust não tem vencimento; a varredura roda a cada 60 s (`:55`) |

> ####  A ADOÇÃO É O QUE UM SNAPSHOT QUEBRA  ####
>
> O terceiro caso da reconciliação é: **ban que existe no jogo e não na tabela é ADOTADO, nunca
> apagado** (`service.ts:450-469`, com `origin: 'adopted'`).
>
> O molde do snapshot que substitui (`Docs/23` §1.2 — *"o que sumiu dele sai"*) atropela isso: a
> primeira versão que o site mandar **remove todo ban adotado**, incluindo os que alguém aplicou
> pelo console do jogo. **Registrado na §7** — não há resposta óbvia, e as duas saídas (snapshot
> com exceção para `adopted`, ou canal incremental) mudam o contrato.

> ####  `steamId` É STRING, SEMPRE — DOS DOIS LADOS  ####
>
> `bans.ts:11-20` diz por quê: *"Um SteamID64 tem 17 dígitos e passa de 2^53: um `z.number()` aqui
> aceitaria o valor e o devolveria arredondado — o ban iria para a CONTA ERRADA."*
>
> Vale igual no site, e vale para o `desired` inteiro. `JSON.parse` do lado de lá tem exatamente o
> mesmo problema, e o sintoma é banir a pessoa errada.

### 6.3 Mensagens — e a única peça desta área que é comando

| O quê | Onde |
|---|---|
| As 8 rotas | `core/src/http/routes/messages.ts:199` (listar) … `:456` (**broadcast**) |
| **Mensagem é de REDE**, com lista de alvos; **lista vazia = todos** | `messages.ts:13-18` |
| Um `setInterval` por **processo**, de 30 s — não um por mensagem | `core/src/messages/service.ts:57`, `:160`; razão em `:2-12` |
| `tick()` **nunca lança** | `service.ts:193`; razão em `:15-24` — exceção sem dono mata o laço e as mensagens param **em silêncio** |
| RCON offline e servidor vazio **não consomem o horário** | `service.ts:26-33` |
| Transporte único: `Broadcaster` | `core/src/game/broadcast.ts:1-2` — *"A ÚNICA MANEIRA DE O SERVIDOR FALAR"*; segunda forma é proibida pelo `Docs/17` §10 |

**As réguas que precisam existir também no site**, porque o `desired` **não passa** pelo zod da
rota local:

- **texto ≤ 512 caracteres** — é o teto do frame do RCON (`messages.ts:122`);
- **cor em hex validado** (`hexColor`, `messages.ts:107-110`) — a trava contra injeção de
  `<color=…>` no chat;
- **intervalo entre 10 s e 30 dias** (`messages.ts:60-73`);
- **coerência do ritmo** — `interval` sem `everySeconds`, `weekly` sem dias, horário fora da
  janela: tudo 422 `MESSAGE_INVALID_SCHEDULE` (`messages.ts:572-643`).

> ####  BROADCAST É COMANDO; MENSAGEM AGENDADA É ESTADO  ####
>
> `POST /api/chat/broadcast` (`messages.ts:456`) é *"fale isto agora"* — **envelhece**. Ele não
> cabe no `desired`: uma versão que fique presa e chegue meia hora depois faz o servidor anunciar
> um evento que já acabou.
>
> Ele cabe na **fila de comandos** do `Docs/22`, como um `kind` novo. **E aí esbarra na
> allowlist**, que tem exatamente três entradas por decisão do dono de 03/09/2026 e é **fechada**
> (`Docs/22` §4; do lado do site, `ad_oz_backend/services/rustCommandQueue.ts`).
>
> Um `kind` de broadcast é uma **decisão do dono**, não um detalhe de implementação — e ela vem
> com a pergunta que a allowlist existe para fazer: quem manda o servidor falar, e o texto passa
> por qual régua antes? **Está na §7.**

---

## 7 — As perguntas em aberto

Registradas aqui porque **escrever "está definido" o que não está** é como as divergências de
`skinId` e `prefab` nasceram (`Docs/22` §9).

| # | Área | Pergunta | Por que ela trava o desenho |
|---|---|---|---|
| 1 | 1 | ~~`autoUpdate` é **do agent** ou **do servidor**?~~ | ✅ **RESPONDIDA em 04/09/2026: do servidor.** A flag do env virou o padrão da máquina, e cada servidor grava a sua opinião. Ver §3.5 |
| 2 | 1 | ~~Como a flag muda **sem reiniciar o agent**?~~ | ✅ **RESPONDIDA em 04/09/2026:** o vigia lê a opinião na hora de decidir, e ela mora em `meta` — vale na rodada seguinte e sobrevive ao restart. O `requiresRestart` continua sendo do **jogo**. Ver §3.5 |
| 3 | 2 | A agenda de wipe vai pela **config de servidor** (rota 13) ou por um **canal novo por servidor**? | o canal de rede do `Docs/23` é **do agente**; pendurar wipe nele faz a agenda de um servidor valer em outro |
| 4 | 2 | Quem grava `version` na agenda, já que ela **não existe hoje de nenhum dos dois lados**? | é trabalho novo aqui também, não só no site |
| 5 | 3 | Config de plugin: **opaca ou validada**? Qual o teto? E **quem é o dono**, o site ou o `SaveConfig()` do plugin? | §5.3. As três sub-perguntas mudam o contrato, e a terceira não tem resposta boa |
| 6 | 3 | Grupos do Oxide pelo site **colidem com o assunto `vips`** do `Docs/23` §6 — quem manda? | são o mesmo dado por dois caminhos que não se conhecem |
| 7 | 4 | Bans: **snapshot que substitui** ou **incremental**? E o que acontece com o ban **adotado**? | um snapshot apaga toda adoção na primeira versão (§6.2) |
| 8 | 4 | **Quem, no site, pode conceder `ownerid`** — e onde fica a auditoria que sobrevive? | §6.1. É escalada de privilégio entre bases de identidade diferentes |
| 9 | 4 | **Broadcast entra na allowlist de kinds?** | a allowlist é fechada em três por decisão do dono (03/09) — mexer nela é decisão dele, não do implementador |
| 10 | 2 e 3 | Como o site distingue **"gerenciado e desligado"** de **"não gerenciado"** em cada assunto novo? | é a armadilha do `null ≠ false` da §3.3, e ela reaparece em toda área. **Na área 1 a resposta já está tomada** (três estados, §3.5) e serve de molde para as outras |

---

## 8 — Ordem recomendada e o que cada área destrava

| Onda | Área | Custo | O que destrava | Depende de |
|---|---|---|---|---|
| **1** | ✅ Atualização automática e build | **feita em 04/09/2026** (§3.5) | o admin liga e desliga o auto-update sem SSH na máquina; o build já está na tela | — |
| **2** | Wipe e calendário | **médio** — a Fase 6 está pronta; o trabalho é versionar e atravessar | **a agenda de wipe visível ao jogador**, que é a coisa desta lista que mais gera visita ao site | a decisão da §7 #3 e a `version` da §7 #4 |
| **3** | Plugins e Oxide | **alto** — a maior das quatro | o painel de plugins de rede; o plugin que não compila aparecendo em vez de sumir | a resposta da §7 #5 e a leitura da §5.4 sobre VIP |
| **4** | Admins, bans e mensagens | **médio**, mas são **três** desenhos | moderação de rede num lugar só, e as mensagens agendadas gerenciadas de fora | a cadeia de permissão da §7 #8 escrita **antes** da rota |

### Uma observação sobre a ordem

Ela é a recomendação do dono e vale. Mas uma adjacência apareceu na verificação e merece estar
escrita: **o agendador de mensagens é quem avisa do wipe** — foi entregue **junto** com a Fase 6,
e por essa razão (`Docs/09` §Fase 6). A metade "mensagens" da área 4 é vizinha da área 2, não da
área 3.

Quem pegar a onda 2 decide se puxa as mensagens junto. Não é uma troca de ordem — é uma economia
que só existe se alguém enxergar na hora.

### E o que fazer com a assimetria da área 1

O site **terminou** a metade dele em 04/09/2026: `CONFIG_FIELDS` tem **oito** campos
(`ad_oz_backend/services/rustServerConfig.ts:46`), `FIELD_TYPES` diz à tela que `autoUpdate` é
booleano (`:58-66`), a validação recusa coerção (`cfgBool`, `:257-270`), e ausência é
`undefined`/`null`/`''` — **nunca `false`** (`:308`). A etiqueta `oz-rust/4` está carimbada nos
dois manuais.

**Este lado fez a parte dele no fim do mesmo dia** (§3.5), e a assimetria durou horas. O que ficou
escrito, porque vale para as três áreas que faltam: enquanto um par não existe, o desfecho é
`UNKNOWN_FIELD` em `errors[]`, e **isso é o comportamento correto** — é exatamente para isso que o
código existe (`Docs/23-CONFIG-PELO-SITE.md` §2.3: o site precisa distinguir "agente velho, campo
novo" de "o agente conhece e recusa por desenho"). Ninguém deve tratá-lo como bug, e ninguém deve
"consertá-lo" fazendo o agent aceitar em silêncio o que ele não aplica — isso seria devolver
`applied: true` por uma gravação que não aconteceu, que é a armadilha do `updateSettings` da §3.2
reinventada de propósito.

E o desenho do `false` do lado do site conferiu com o daqui: `cfgBool` recusa coerção e trata
`undefined`/`null`/`''` como ausência, **nunca `false`** — que é a mesma régua que o agent aplica
na fronteira dele.
