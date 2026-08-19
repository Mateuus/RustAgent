# 16 — Plano: WIPE, calendário e mensagens agendadas

> **Este é o documento de PROJETO.** Ele responde *o que vamos construir e por
> quê*. Quem vai construir recebe [17-FRENTES-WIPE-E-MENSAGENS.md](17-FRENTES-WIPE-E-MENSAGENS.md),
> que fatia isto em frentes independentes para vários agentes tocarem ao mesmo
> tempo.

Escrito em 2026-08-18. As seções §2 e §4 são **fato medido nesta árvore**; da
§5 em diante é **proposta**, e o que depende de decisão sua está reunido na
§14.

Três coisas entram, e elas se encaixam:

```
   WIPE          o agente passa a MANDAR no ciclo de vida do mundo:
                 agenda, avisa, derruba, apaga, troca o mapa, sobe.

   CALENDÁRIO    a agenda vira tela — no painel e DENTRO DO JOGO,
                 na página que hoje diz "entram aqui".

   MENSAGENS     um agendador de falas do servidor, na barra lateral.
                 O wipe é o primeiro cliente dele, e não o dono.
```

---

## 1. O pedido, em três frases

1. Uma aba **WIPE** na página do servidor, com sub-abas para configurar tudo —
   e o agente fazendo o wipe inteiro sozinho, avisando o tempo que falta.
2. O **calendário** do `/menu` in-game (hoje um lugar vazio que diz *"Wipes e
   eventos programados entram aqui"*) passa a mostrar o que foi agendado.
3. Um item **Mensagens** na barra lateral: crio uma mensagem, digo de quanto em
   quanto tempo ela sai (7 dias, horas, minutos), e o agente a executa no
   servidor pelo `OrigemZChat`.

**Eventos** ficam para depois — mas a tabela nasce desenhada nesta fase (§12),
porque o calendário in-game vai ler os dois, e descobrir isso depois custaria
uma migração e uma tela refeitas.

---

## 2. O que já existe nesta árvore

Nada aqui é para reescrever. É a lista do que a implementação **reaproveita**,
com o arquivo, para ninguém construir uma segunda versão do que já funciona.

| Peça | Onde | O que ela já resolve |
|---|---|---|
| **Quando foi o último wipe** | [core/src/game/wipe.ts](../core/src/game/wipe.ts) | `WipeClock` lê `SaveCreatedTime` do `serverinfo`, com parse explícito do formato americano e cache invalidado na reconexão do RCON |
| **Parar / subir / atualizar** | [core/src/ops/service.ts](../core/src/ops/service.ts) | trava por recurso, log linha a linha com cursor, cancelamento por árvore de processo, `quit` pelo RCON que salva antes de sair |
| **Contagem regressiva no chat** | `ops/service.ts` — `#countdown` / `#say` | o `server-auto-update` já avisa "reinício em 15 min" e vai diminuindo. O wipe usa o mesmo padrão |
| **Escrever a configuração do servidor** | [core/src/servers/supervisor.ts](../core/src/servers/supervisor.ts) — `updateSettings` | grava `SERVER_LEVEL`, `SERVER_SEED`, `SERVER_WORLDSIZE` no `Configs\<id>.ini` preservando comentários, e relê o arquivo depois |
| **A linha de comando do jogo** | [core/src/ops/server-process.ts](../core/src/ops/server-process.ts) | monta `+server.level +server.seed +server.worldsize` a partir do config |
| **Quem está online** | [core/src/players/presence.ts](../core/src/players/presence.ts) | `PresenceTracker`, com relógio próprio |
| **Falar com o chat** | [Plugins/OrigemZChat.cs](../Plugins/OrigemZChat.cs) | `origemz.chat.broadcast <base64>` → `{"ok":true,"sent":N}` |
| **Tela do jogo montada na hora** | [core/src/game/ui-kits-screen.ts](../core/src/game/ui-kits-screen.ts) + `ui-sync.ts` (`generatedScreens`) | o padrão de tela **gerada**, `volatile: true`, que o calendário in-game vai copiar |
| **O lugar vazio no menu** | [core/src/game/ui-preset-main-menu.ts](../core/src/game/ui-preset-main-menu.ts) | a nav já tem `calendario` e `eventos`, e a home já tem o cartão `WIPE` |
| **Bloqueio pós-wipe de kit** | [core/src/db/kits-repository.ts](../core/src/db/kits-repository.ts) — `wipe_delay_seconds` | já consome a hora do wipe. Quando o agente passar a executar o wipe, isso passa a funcionar sozinho |

> **####  A MAIOR DIFERENÇA PARA O AGENTE ANTIGO  ####**
>
> Lá, trocar o mapa do próximo wipe era o problema difícil: quem escrevia
> `SERVER_SEED` era um `.bat` fora do repositório, e o plano antigo gastava uma
> seção inteira (§5.4) inventando um `server.wipe.ini` para o agente não
> estragar o arquivo do humano.
>
> **Aqui isso já é do agente.** `supervisor.updateSettings({ map, seed,
> worldSize })` grava no `.ini`, e `server-process.ts` monta a linha de comando a
> partir dele. Aplicar o mapa do wipe é uma chamada de função, e o passo
> `configurar` da execução é o passo mais curto de todos.

---

## 3. O que vem do agente antigo

`F:\Projects\Rust` tem o sistema pela metade — calendário e fila de mapas
prontos, execução nunca escrita. **Portar não é copiar**: as convenções desta
árvore mudaram (datas em epoch ms `INTEGER`, repositórios com `serverId` na
assinatura, erros com código).

| Lá | O que é | Como entra aqui |
|---|---|---|
| `Docs/OrigemZWipe/PLANO.md` | 43 KB de pesquisa sobre a mecânica do wipe, com as fontes | **é a fonte deste documento** — leia antes de discordar de qualquer decisão daqui |
| `core/src/wipe/schedule.ts` | cálculo puro: forçado, cadência com fuso IANA, três políticas de colisão. Sem banco, sem relógio próprio | **porta quase inteiro** — é o arquivo mais bem resolvido dos dois projetos |
| `core/src/wipe/save-files.ts` | quais arquivos apagar por tipo de wipe | porta, e **reconfere contra `Servers\server01\server\server01\`** (§4) |
| `core/src/wipe/preview.ts` | "o que este wipe vai apagar", lendo o disco | porta |
| `core/src/wipe/server-ini.ts` | escrever seed/level no `.ini` | **descarta** — `supervisor.updateSettings` já faz |
| `core/src/db/wipe-schedule-repository.ts` | agenda materializada, com `generated_for` (o que faz *adiar* ser adiar) | porta o mecanismo |
| `core/src/db/wipes-repository.ts` | histórico de mundos detectados | porta como `wipes` |
| `core/src/http/routes/wipe.ts`, `wipe-maps.ts` | as rotas | porta o desenho, reescreve o corpo |
| `panel/src/components/wipe-page.tsx` | 1.350 linhas de tela: Geral, Agenda, Mapas | porta o desenho; os componentes e o CSS são outros |
| `core/src/game/announcements.ts` | o rodízio de frases a cada N segundos | **inspiração, não porte** — o que queremos é mais que um rodízio (§10) |
| `core/src/db/announcements-repository.ts` | as frases, `position` de 10 em 10, `sent_count` | porta o padrão de posição e de contador |

---

## 4. O que um wipe é, mecanicamente

Não existe comando `wipe` no Rust. Um wipe é **apagar arquivo com o servidor
parado**, e qual arquivo você apaga define o *tipo*.

Medido nesta máquina, em `Servers\server01\server\server01\`:

```
proceduralmap.4000.12345.287.map      o terreno
proceduralmap.4000.12345.287.sav      o mundo salvo: bases, caixas
proceduralmap.4000.12345.287.sav.1    saves anteriores (rotação do jogo)
proceduralmap.4000.12345.287.sav.2
player.blueprints.16.db   (+ -wal)    o que cada jogador pesquisou
player.deaths.16.db       (+ -wal)    a tela de morte
player.identities.16.db   (+ -wal)    SteamID <-> nome
player.states.287.db      (+ -wal)    estado entre sessões
player.tokens.db          (+ -wal)
clans.287.db              (+ -wal)    dado de PLUGIN dentro da pasta do save
command_history / companion.id / cfg
```

| Arquivo | map wipe | BP wipe | full wipe |
|---|---|---|---|
| `proceduralmap.*` (`.map`, `.sav`, `.sav.N`) | **apaga** | apaga | apaga |
| `sv.files.*.db` | **apaga** | apaga | apaga |
| `player.deaths.*.db` | **apaga** | apaga | apaga |
| `player.blueprints.*.db` | mantém | **apaga** | apaga |
| `player.states.*.db` | opcional | opcional | apaga |
| `player.identities.*.db` | mantém | mantém | mantém |
| `clans.*.db` e `oxide\data\*` | mantém | mantém | **lista explícita** |

Três coisas que quebram na prática, e como o plano trata cada uma:

1. **`-wal` acompanha o `.db`.** Apagar `player.blueprints.16.db` e deixar o
   `-wal` deixa o SQLite reconstruir parte do que você apagou. O glob é por
   **prefixo**, nunca por nome exato.
2. **O número no nome é a versão do FORMATO, não um contador nosso.** Repare que
   aqui convivem `16` e `287`. Quando a Facepunch muda o formato, o servidor cria
   o arquivo com o número seguinte e **ignora o antigo** — por isso o glob nunca
   pode ser um nome fixo.
3. **O servidor precisa estar PARADO.** O Rust mantém os arquivos abertos e
   reescreve no próximo `saveinterval` o que você removeu.

E uma quarta, que é o motivo de o wipe ser uma operação e não um comando:
**convar de mundo só é lida no boot.** Não existe trocar mapa a quente. O wipe é
obrigatoriamente *parar → apagar → reconfigurar → subir*.

---

## 5. As duas fontes de verdade do calendário

> **####  ESTA É A SEÇÃO QUE MANDA NO RESTO  ####**

```
   NOSSA                                  DA FACEPUNCH
   cadência configurável                  1ª quinta do mês, 19:00 UTC
   a cada N dias, no horário              não é opcional: o protocolo
   que o dono escolher                    muda e o save antigo não carrega
```

**O forçado nunca é pulado.** Ele não é escolha nossa — sem zerar, o servidor
não sobe com o mundo antigo. Por isso não existe botão de desligá-lo, e `DELETE`
num plano forçado é recusado com explicação.

**Force wipe ≠ BP wipe.** A atualização mensal apaga o mapa; blueprints só caem
quando a Facepunch mexe no sistema de itens — 1 a 2 vezes por ano, anunciado no
devblog. Nascer com "apagar BP no forçado" faria o agente endurecer o jogo além
do que o próprio jogo faz.

**As datas são derivadas, nunca uma tabela.** "Primeira quinta às 19:00 UTC" são
dez linhas e valem para sempre; um array de datas chumbadas envelhece em silêncio
— no dia em que ele acaba, o agente para de agendar e ninguém percebe até o wipe
não acontecer.

### Quando os dois colidem

Cadência de 7 dias ancorada no domingo com o forçado numa quinta = **dois wipes
em quatro dias**, e o segundo pega uma base de dois dias. Três políticas:

| Política | O que faz | Para quem |
|---|---|---|
| `ignorar` | os dois acontecem | servidor que quer caos |
| **`reancorar`** *(padrão)* | o forçado vira o novo marco zero da cadência | quase todo mundo |
| `absorver` | wipe de cadência dentro de N horas do forçado é **cancelado** | cadência longa (15/30 dias) |

O wipe absorvido **continua na lista**, marcado. Uma agenda com um buraco não
explica por que terça não vai ter wipe.

---

## 6. A arquitetura: quatro camadas

```
  ┌────────────────────────────────────────────────────────────┐
  │  CALENDÁRIO     o que vai acontecer, e quando              │
  │  cadência + forçado + colisão  ->  wipe_plans              │
  └───────────────────────────┬────────────────────────────────┘
                              │  o plano vira execução
  ┌───────────────────────────▼────────────────────────────────┐
  │  EXECUÇÃO       uma operação com passos, retomável         │
  │  avisar > esvaziar > parar > backup > apagar >             │
  │  configurar > subir > pós-wipe                             │
  └───────────────────────────┬────────────────────────────────┘
                              │  o mundo novo aparece
  ┌───────────────────────────▼────────────────────────────────┐
  │  DETECÇÃO       a conferência independente                 │
  │  WipeClock lê SaveCreatedTime — JÁ EXISTE                  │
  └───────────────────────────┬────────────────────────────────┘
                              │  e todo mundo fica sabendo
  ┌───────────────────────────▼────────────────────────────────┐
  │  DIVULGAÇÃO     mensagens no chat, calendário no painel    │
  │  e a tela CALENDÁRIO dentro do jogo                        │
  └────────────────────────────────────────────────────────────┘
```

A camada de **detecção já está pronta e não muda**. Ela é o que permite dizer
*"a execução relatou sucesso e o `SaveCreatedTime` não mudou"* sem acreditar no
relatório da própria execução.

### Por que o scheduler mora no agente, e não num plugin

No dia do wipe forçado o servidor é atualizado, e **o Oxide pode ainda não ter
build compatível**. Nessa janela nenhum plugin carrega. Um scheduler dentro do
jogo não roda exatamente no dia em que o wipe é obrigatório.

O agente é um processo separado, que já sobe e derruba o servidor. Ele funciona
com o Oxide quebrado, com o servidor fora do ar e durante o download do SteamCMD.
**O scheduler mora nele.** O plugin entra só onde o agente não alcança: ler e
devolver blueprint de jogador, e desenhar tela dentro do jogo.

### O wipe é uma operação, e não um comando

Entra um `OperationKind` novo — `wipe-run` — em
[core/src/ops/operations.ts](../core/src/ops/operations.ts). Ele herda de graça a
trava por recurso, o log com cursor, o cancelamento e o arquivo em
`Logs\<servidor>\ops\`.

**Mas as operações de hoje vivem em memória** (`MAX_HISTORY = 20`, e somem no
`pm2 restart`). Um wipe não pode: ele precisa responder *"o que aconteceu no wipe
do dia 6"* semanas depois, e precisa **retomar do passo que falhou**. Daí
`wipe_runs` e `wipe_run_steps` no banco, com `operation_id` amarrando ao registro
em memória enquanto ele existe.

**Cada passo é idempotente.** Apagar num diretório já limpo é sucesso, não erro —
é o que torna a retomada segura. "Rodar tudo de novo" no meio de um wipe
significa apagar um mundo que já é o novo.

### `server-restart` não serve

Ele é *parar e subir*. O wipe é *parar, mexer no disco, e só então subir* — e
entre as duas metades está a parte que não pode ser interrompida. Empilhar isso
no restart transformaria uma operação simples numa com dois modos.

---

## 7. Modelo de dados

Migrações numeradas em [core/src/db/migrations.ts](../core/src/db/migrations.ts)
— a última aplicada é a **22** (`spawn-status`). **Os números abaixo estão
reservados por frente** (ver doc 17): duas frentes escrevendo a migração 23 é o
único conflito que dá merge limpo e banco quebrado.

### 23 — a agenda  *(Frente A)*

```sql
wipe_settings          -- chave/valor POR SERVIDOR, versionável
  server_id, key, value, updated_at
  PRIMARY KEY (server_id, key)

wipe_plans             -- o calendário MATERIALIZADO
  id, server_id, scheduled_at, kind('cadence'|'forced'|'manual'),
  bp_policy('keep'|'wipe'|'wipe_except_vip'),
  map_source('pool'|'random'|'fixed'|'keep'), map_pool_id,
  status('planned'|'running'|'done'|'skipped'|'failed'|'absorbed'),
  absorbed_by, generated_for, pinned, note, created_at, updated_at
```

Datas em **epoch ms `INTEGER` (UTC)**, como no resto do banco. Horário local é
texto `'HH:MM'` mais a zona IANA — nunca um instante com fuso embutido.

> **`generated_for` é o que faz *adiar* ser adiar.** Sem ela, mover um wipe
> deixaria a data original vaga, a reconciliação a recriaria, e o servidor teria
> **dois** wipes. Ela guarda o instante que a regra teria gerado; `pinned` diz
> que um humano mexeu e que a reconciliação não deve tocar.

**A agenda é materializada, e não calculada na hora.** Um wipe agendado é algo
que se edita (adiar, trocar a política, trocar o mapa) — e não dá para editar o
resultado de uma função. O agente materializa ~90 dias e reconcilia quando a
configuração muda, preservando o que foi editado à mão e **nunca tocando no
passado**.

### 24 — a fila de mapas  *(Frente C, colunas do RustMaps consumidas pela H)*

```sql
map_pool
  id, server_id, position, kind('procedural'|'custom'),
  seed, world_size, level, level_url,
  rustmaps_id, staging, preview_url, thumb_url, monuments(json),
  status('draft'|'generating'|'ready'|'used'|'failed'),
  last_error, used_at, created_at
  -- índice único PARCIAL (server_id, seed, world_size) WHERE status <> 'used'
```

O índice parcial é a regra escrita em SQL: a mesma seed não pode estar duas vezes
*esperando* (isso é sempre um Ctrl+V repetido), mas **pode** ser reprisada meses
depois, que é escolha legítima.

### 25 — as execuções  *(Frente D)*

```sql
wipe_runs
  id, server_id, plan_id, operation_id, kind, bp_policy,
  started_at, finished_at, status, backup_path,
  map_before(json), map_after(json),
  save_created_before, save_created_after, message

wipe_run_steps
  run_id, step, status('pending'|'running'|'done'|'failed'|'skipped'),
  started_at, finished_at, message
  PRIMARY KEY (run_id, step)

wipes                  -- o histórico de MUNDOS detectados
  id, server_id, save_created_at, level, seed, world_size,
  detected_at, wipe_run_id
```

`wipes` é a costura: quando o `WipeClock` vê um `SaveCreatedTime` novo, a
execução se amarra ao mundo que ela criou. É o que permite responder *"o wipe do
dia 6 gerou este mundo, com esta seed, e durou 11 minutos"* sem inventar
correlação por horário.

### 26 — as mensagens  *(Frente E)*

```sql
messages               -- DE REDE, como VIPs, kits e loja
  id, name, text, enabled, position,
  schedule_kind('interval'|'daily'|'weekly'|'once'),
  every_seconds,                 -- interval
  time_of_day,                   -- daily/weekly: 'HH:MM'
  weekdays,                      -- weekly: '1,4'  (0 = domingo)
  run_at,                        -- once: epoch ms
  time_zone,                     -- IANA, ex.: 'America/Sao_Paulo'
  window_from, window_to,        -- 'HH:MM' ou NULL = a qualquer hora
  only_with_players, min_players,
  tag, tag_color, color, size,
  last_sent_at, next_at, sent_count,
  created_at, updated_at

message_targets        -- sem linha nenhuma = TODOS os servidores
  message_id, server_id
  PRIMARY KEY (message_id, server_id)

message_log            -- "essa mensagem está mesmo aparecendo?"
  id, message_id, server_id, at, players, ok, error
```

### 27 — os eventos  *(§12: fica para depois — a tabela nasce agora)*

```sql
events
  id, server_id, name, kind, starts_at, ends_at,
  description, image_url, enabled, created_at
```

### 28 — os blueprints que sobrevivem  *(Frente I)*

```sql
bp_snapshots           -- o que cada jogador sabia ANTES do wipe
  id, server_id, wipe_run_id, steam_id, items(json), item_count, created_at
  -- índice (server_id, wipe_run_id, steam_id)

bp_restores            -- o que ainda é devido a alguém
  id, server_id, snapshot_id, steam_id, tier, items(json),
  release_at,                       -- 0 = na hora; senão, N horas após o wipe
  state('pending'|'sent'|'applied'|'expired'|'failed'),
  sent_at, applied_at, error
```

> **O snapshot é de TODO MUNDO; quem recebe de volta é decidido depois.** Salvar
> só de quem é VIP criaria o caso em que alguém compra VIP no dia seguinte ao
> wipe e não tem o que restaurar. O direito é conferido **na hora de restaurar**,
> contra o VIP vigente naquele momento.
>
> **E o snapshot tem prazo: vale para o wipe seguinte, e só ele.** Restaurar o BP
> de três wipes atrás é ressuscitar vantagem que ninguém lembra ter dado.

---

## 8. As rotas

O padrão é o do projeto: erro com código, `202` para trabalho longo,
`Idempotency-Key` no que não pode acontecer duas vezes.

```
   A AGENDA                                                    Frente
   GET    /api/servers/:id/wipe/settings                          A
   PUT    /api/servers/:id/wipe/settings                          A
   GET    /api/servers/:id/wipe/plans?from=&to=                   A
   POST   /api/servers/:id/wipe/plans          manual             A
   PATCH  /api/servers/:id/wipe/plans/:planId  adiar, política    A
   DELETE /api/servers/:id/wipe/plans/:planId  pular              A  (forçado recusa)
   GET    /api/servers/:id/wipe/preview        o que vai apagar   D

   A FILA DE MAPAS
   GET    /api/servers/:id/wipe/maps                              C
   POST   /api/servers/:id/wipe/maps                              C
   POST   /api/servers/:id/wipe/maps/reorder                      C
   POST   /api/servers/:id/wipe/maps/random    sortear            C
   DELETE /api/servers/:id/wipe/maps/:mapId                       C
   POST   /api/servers/:id/wipe/maps/:mapId/generate  RustMaps    H
   GET    /api/wipe/rustmaps/status            chave, plano, cota H

   OS BLUEPRINTS
   GET    /api/servers/:id/wipe/blueprints     snapshot + régua   I
   POST   /api/servers/:id/wipe/blueprints/snapshot  tirar agora  I
   POST   /api/servers/:id/wipe/blueprints/restore   um jogador   I

   O FULL WIPE
   GET    /api/servers/:id/wipe/plugin-data    o que existe em disco   D

   A EXECUÇÃO
   POST   /api/servers/:id/wipe/runs           WIPAR AGORA        D
   GET    /api/servers/:id/wipe/runs           histórico          D
   GET    /api/servers/:id/wipe/runs/:runId    passos + log       D
   POST   /api/servers/:id/wipe/runs/:runId/resume                D
   POST   /api/servers/:id/wipe/runs/:runId/cancel                D

   O FUTURO (o que o jogador vê)
   GET    /api/servers/:id/wipe/upcoming       admin: tudo        A
   GET    /api/servers/:id/wipe/upcoming/me?steamId=  pelo tier   G

   AS MENSAGENS  (de rede)
   GET    /api/messages                                           E
   POST   /api/messages                                           E
   PATCH  /api/messages/:messageId                                E
   DELETE /api/messages/:messageId                                E
   POST   /api/messages/:messageId/test        manda agora        E
   GET    /api/messages/:messageId/log                            E
   POST   /api/chat/broadcast                  uma fala avulsa    E
```

> **`POST /wipe/runs` é a única rota do agente que apaga o trabalho de todos os
> jogadores.** Ela leva `Idempotency-Key` **e** confirmação explícita no corpo —
> não um `?force=true`, mas o `identity` do servidor digitado, como o GitHub faz
> para apagar repositório. Um duplo-clique no painel não pode zerar o servidor
> duas vezes.

---

## 9. As telas

### 9.1 A aba WIPE, na página do servidor

Entra em [panel/src/app/servidor/page.tsx](../panel/src/app/servidor/page.tsx),
no array `TABS`, **entre Menu e Configurações** — é a última coisa que mexe no
que o jogador vive, antes das telas de operador. Ícone `CalendarClock`.

```
 ← todos os servidores

 server01                                                    ● NO AR
 O melhor PVP do Brasil | Wipe quinta

 Visão │ Administração │ Console │ Operações │ Plugins │ Menu │ WIPE │ Config.
                                                              ══════
 ┌ Geral ─ Agenda ─ Mapas ─ Blueprints ─ Configuração ─ Execução ─────────┐
```

Seis sub-abas, e cada uma responde uma pergunta diferente:

| Sub-aba | Pergunta que ela responde | Frente |
|---|---|---|
| **Geral** | "quando é o próximo, e o que ele leva?" | B |
| **Agenda** | "com que frequência, a partir de quando, e o que já está marcado?" | B |
| **Mapas** | "qual mundo entra no lugar, e como ele é?" | C + H |
| **Blueprints** | "quem recomeça sabendo o quê?" | I |
| **Configuração** | "como o agente executa — avisa, espera, faz backup, apaga o quê?" | D |
| **Execução** | "o que aconteceu, passo a passo — e como retomo o que falhou?" | D |

#### Geral

```
 ┌─ PRÓXIMO WIPE ───────────────────────────┬─ O QUE ELE LEVA ─────────────┐
 │                                          │  ✔  mapa e construções       │
 │        06d 04h 12m 33s                   │  ✔  tela de morte            │
 │                                          │  ✔  arquivos enviados        │
 │   quinta, 03/09/2026 · 16:00 (BRT)       │  ✘  blueprints — MANTIDOS    │
 │   cadência de 7 dias                     │  ✘  dados de plugin          │
 │                                          │                              │
 │   MAPA   procedural · 4000 · seed 18422  │  backup antes: SIM (mantém 3)│
 │          [ ver prévia ]                  │  ~1.2 GB → Backups\server01\ │
 └──────────────────────────────────────────┴──────────────────────────────┘

 ┌─ FORÇADO (Facepunch) ────────────────────┬─ ESTADO ─────────────────────┐
 │  01/10/2026 · 16:00 BRT (19:00 UTC)      │  RCON        ● conectado     │
 │  primeira quinta do mês                  │  jogadores   7 online        │
 │  o agente atualiza o Rust antes          │  disco       412 GB livres   │
 │  blueprints: MANTIDOS                    │  relógio     ok (±0,4 s)     │
 └──────────────────────────────────────────┴──────────────────────────────┘

     [ WIPAR AGORA ]      [ adiar 24 h ]      [ pular este ]
       ↑ pede o identity digitado
```

A contagem regressiva sai do **relógio do agente**: toda resposta traz `now`, e a
tela corrige a diferença para o relógio local. Um navegador adiantado em dez
minutos mostraria "faltam 3 min" para um wipe que ainda tem uma hora.

**A lista do que vai apagar vem ANTES do botão**, e não depois de clicar. Ela é
lida do disco (`GET /wipe/preview`) — não é um texto fixo dizendo o que *deveria*
estar lá.

#### Agenda

```
 ┌─ CADÊNCIA ──────────────────────────────────────────────────────────────┐
 │  (•) ligada        ( ) desligada — só o forçado aparece                 │
 │                                                                         │
 │  a cada [  7 ] dias      atalhos:  1  2  3  4  6  8  12  15  30         │
 │  às  [ 16:00 ]  no fuso [ America/Sao_Paulo        ▾ ]                  │
 │  contando a partir de [ 03/09/2026 ]                                    │
 │                                                                         │
 │  blueprints da cadência:  (•) mantidos  ( ) apagados  ( ) só VIP mantém │
 │  blueprints do forçado:   (•) mantidos  ( ) apagados  ( ) só VIP mantém │
 ├─ QUANDO OS DOIS CAEM JUNTOS ────────────────────────────────────────────┤
 │  (•) reancorar — o forçado vira o novo marco zero                       │
 │  ( ) absorver  — cancela o da cadência dentro de [ 24 ] h               │
 │  ( ) ignorar   — os dois acontecem                                      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─ SETEMBRO 2026 ───────────────────────────  ‹  hoje  ›  ────────────────┐
 │   dom    seg    ter    qua    qui    sex    sáb                         │
 │                  1      2    ▌3▐     4      5                           │
 │    6      7      8      9    ▌10▐    11     12                          │
 │   13     14     15     16    ▌17▐    18     19                          │
 │   20     21     22     23    ▌24▐    25     26                          │
 │   27     28     29     30                                               │
 │                                                                         │
 │   ▌▐ cadência    ▓▓ forçado    ░░ manual    ×  absorvido                │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─ OS PRÓXIMOS 90 DIAS ───────────────────────────────────────────────────┐
 │  qui 03/09  16:00   cadência   BP mantidos   mapa #1     [adiar][pular] │
 │  qui 10/09  16:00   cadência   BP mantidos   sorteia     [adiar][pular] │
 │  qui 17/09  16:00   cadência   BP mantidos   sorteia     [adiar][pular] │
 │  qui 01/10  16:00   FORÇADO    BP mantidos   procedural  [adiar]        │
 │  qui 08/10  16:00   cadência   BP mantidos   sorteia     [adiar][pular] │
 └─────────────────────────────────────────────────────────────────────────┘
     [ + wipe manual ]
```

**O calendário em grade é o que o pedido chama de "módulo de calendário".** Ele é
um componente do painel (`panel/src/components/wipe/calendar-month.tsx`), e é o
**mesmo** componente que a tela de eventos vai usar depois — por isso ele recebe
uma lista de marcações genéricas (`{ at, kind, label, tone }`), e não "uma lista
de wipes".

#### Mapas

```
 ┌─ A FILA ────────────────────────────────────────────────────────────────┐
 │  ┌────────┐                                                             │
 │  │ ▞▚▞▚▞▚ │  #1   procedural · 4000 · seed 18422                        │
 │  │ ▚▞▚▞▚▞ │       12 monumentos · Launch Site, Airfield, Water…         │
 │  └────────┘       ✔ pronta (RustMaps)          [abrir ↗]  ▲▼  [ × ]     │
 │  ┌────────┐                                                             │
 │  │ ⏳     │  #2   procedural · 3500 · seed 90173                        │
 │  │        │       gerando… 3º na fila do RustMaps        ▲▼  [ × ]      │
 │  └────────┘                                                             │
 │  ┌────────┐                                                             │
 │  │  ⛰    │  #3   Barren · 3000                                         │
 │  └────────┘       sem prévia (mapa fixo)                ▲▼  [ × ]       │
 └─────────────────────────────────────────────────────────────────────────┘
      [ + colar seed ]  [ sortear uma ]  [ colar link do RustMaps ]
      fila vazia = o agente sorteia

 ┌─ RUSTMAPS ──────────────────────────────────────────────────────────────┐
 │  chave  ●●●●●●●●  ✔ válida        plano: premium     cota: 38/100 hoje  │
 │  [x] gerar a prévia sozinho ao adicionar uma seed                       │
 │  [x] usar STAGING quando o mapa for para um wipe FORÇADO                │
 │      ⚠ mapa gerado antes do forçado pode não servir depois dele         │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─ JÁ JOGADOS ────────────────────────────────────────────────────────────┐
 │  14/08/2026   4000   seed 12345    11 dias no ar                        │
 └─────────────────────────────────────────────────────────────────────────┘
```

- o wipe consome **a primeira entrada `ready`** e a marca `used`;
- fila vazia → o agente **sorteia** e usa. Um wipe nunca é bloqueado por falta de
  curadoria;
- seed já jogada nos últimos seis wipes entra com aviso — não é recusa; é evitar
  que o admin descubra a repetição no dia do wipe;
- **mapa custom (`server.levelurl`) entra, com trava.** Ele exige um arquivo que
  exista, seja baixável e seja compatível com a versão do jogo. Então: o agente
  confere a URL (`HEAD`: responde? é `.map`? qual o tamanho?) **antes** de aceitar
  na fila, e uma entrada `custom` **não pode ser consumida por wipe forçado** a
  menos que o admin marque `compatível com a versão nova` na mão. Aceitar a URL
  sem isso faria o admin achar que o próximo wipe está resolvido, e o servidor
  não subiria na madrugada.

> **####  `SERVER_LEVELURL` NÃO EXISTE HOJE  ####**
>
> A linha de comando montada em `ops/server-process.ts` tem `+server.level`,
> `+server.seed` e `+server.worldsize`, e o `.ini` não tem a chave da URL. Mapa
> custom exige acrescentar **`SERVER_LEVELURL`** em quatro lugares: o
> `server.example.ini`, o `ServerConfig` de `core/src/config.ts`, o `KEY_OF` de
> `supervisor.updateSettings` e o `buildArgs` de `server-process.ts`. É a única
> mudança desta fase fora do escopo "wipe", e ela é da **Frente C**.

#### O staging, e por que ele é a parte difícil do RustMaps

A atualização mensal muda a geração do mundo. Um `.map` gerado na versão de hoje
**pode não ser compatível** com o binário de amanhã. O RustMaps resolve isso com
o branch **staging**: mapas de staging são gerados contra a versão que *vai*
entrar, e só servem **depois** do force wipe — o RustMaps promove staging a
padrão cerca de 1 h antes dele.

Consequência dura, e ela está na tela:

- **wipe da cadência** (mesmo protocolo): pré-gerar é seguro;
- **wipe forçado**: ou o mapa é procedural (seguro sempre), ou o custom precisa
  ser gerado em `staging` — e antes disso ele nem existe.

Por isso `rustmaps.staging` **liga sozinho** quando a entrada da fila está
apontada para um plano `forced`, e a tela diz por quê.

#### Blueprints

A política mais delicada do sistema, e a que o jogador mais pergunta.

```
 ┌─ O QUE ACONTECE COM O QUE O JOGADOR APRENDEU ───────────────────────────┐
 │  na cadência:  ( ) mantém tudo   ( ) apaga tudo   (•) só quem tem VIP   │
 │  no forçado:   (•) mantém tudo   ( ) apaga tudo   ( ) só quem tem VIP   │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─ A RÉGUA POR NÍVEL ─────────────────────────────────────────────────────┐
 │  bronze   ( ) nada    (•) até a bancada [ 1 ▾ ]   ( ) tudo              │
 │  silver   ( ) nada    (•) até a bancada [ 2 ▾ ]   ( ) tudo              │
 │  gold     ( ) nada    ( ) até a bancada [   ▾ ]   (•) tudo              │
 │                                                                         │
 │  devolver [ 0 ] horas depois do wipe    0 = assim que ele entrar        │
 │  ⚠ com atraso, a corrida inicial acontece sem a vantagem                │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─ O ÚLTIMO SNAPSHOT ─────────────────────────────────────────────────────┐
 │  tirado em 14/08 15:58, antes do wipe #3                                │
 │  312 jogadores · 41.208 itens · 2,1 MB                                  │
 │  devolvidos até agora: 27 de 41 com direito                             │
 │                                       [ tirar um snapshot agora ]       │
 ├─ DEVOLVER NA MÃO ───────────────────────────────────────────────────────┤
 │  jogador [ 7656119…            🔍 ]              [ devolver os BPs ]    │
 └─────────────────────────────────────────────────────────────────────────┘
```

**Preservar por arquivo não funciona**, e é por isso que existe snapshot:
`player.blueprints.<n>.db` é **um arquivo só, de todos os jogadores** — não há
como apagar "os BPs de quem não é VIP" recortando arquivo. Pior: quando a
Facepunch muda o formato, o número muda e o arquivo antigo é ignorado inteiro —
a preservação por arquivo evapora justamente no wipe mais importante do ano.

> **####  ISTO MUDA O JOGO PARA QUEM NÃO PAGOU  ####**
>
> Um VIP que começa o wipe sabendo fazer AK contra um novato que precisa de
> scrap não é diferença cosmética — é o item mais forte do jogo na primeira hora.
> Vender isso é decisão de negócio legítima, e muitos servidores vendem. A régua
> por nível e o atraso em horas existem para dosar: são as duas manoplas que
> separam "vantagem" de "servidor decidido no primeiro dia".

#### Configuração

```
 ┌─ AVISOS ANTES ──────────────────────────────────────────────────────────┐
 │  avisar em:  [24 h ×] [6 h ×] [1 h ×] [15 min ×] [5 min ×] [1 min ×]  + │
 │  texto:  [ O wipe é em {wipe.faltam}. Salve o que der.              ]   │
 │  aparência: tag [ WIPE ] cor [#ff4444] texto [#ffffff] tamanho [ 15 ]   │
 │                                              [ testar no chat agora ]   │
 ├─ ESVAZIAR O SERVIDOR ───────────────────────────────────────────────────┤
 │  [x] avisar e esperar a saída, até [ 5 ] minutos                        │
 │  [ ] matar o processo se o RCON não responder  (perde o save da hora)   │
 ├─ BACKUP ────────────────────────────────────────────────────────────────┤
 │  [x] copiar o save antes de apagar     manter os [ 3 ] últimos          │
 │      destino: Backups\server01\wipe-<data>.zip                          │
 │      ⚠ o agente confere o espaço em disco ANTES de parar o servidor     │
 ├─ DADOS DE PLUGIN (full wipe) ───────────────────────────────────────────┤
 │  [x] apagar dados de plugin — e SÓ o que estiver marcado abaixo         │
 │                                                                         │
 │      o que existe hoje em disco:            (lido de verdade da pasta)  │
 │      [x] clans.287.db                  1,2 MB   alterado hoje 14:02     │
 │      [x] player.states.287.db          8,4 MB   alterado hoje 14:02     │
 │      [ ] oxide\data\OrigemZVip.json     122 KB  alterado 12/08          │
 │      [ ] oxide\data\Economics.json       88 KB  alterado hoje 09:11     │
 │      [ ] oxide\data\OrigemZStore.json    31 KB  alterado 10/08          │
 │                                                       [ recarregar ]    │
 │      ⚠ nunca é "apagar tudo": o VIP que alguém pagou mora aí            │
 ├─ DEPOIS DE SUBIR ───────────────────────────────────────────────────────┤
 │  [x] atualizar o Rust antes do wipe forçado                             │
 │  [x] esperar o Oxide compatível antes de liberar (teto [ 30 ] min)      │
 │  [x] ressincronizar VIP, loadouts, kits e catálogo                      │
 │  [x] anunciar o mundo novo no chat                                      │
 └─────────────────────────────────────────────────────────────────────────┘
```

#### Execução

```
 ┌─ EM ANDAMENTO ──────────────────────────────────────────────────────────┐
 │  wipe #4 · cadência · iniciado 16:00:03                                 │
 │                                                                         │
 │  ✔ avisar         16:00:03   6 avisos, o último 1 min antes             │
 │  ✔ esvaziar       16:00:20   7 jogadores saíram (0 restantes)           │
 │  ✔ parar          16:00:41   quit pelo RCON — o mundo foi salvo         │
 │  ✔ backup         16:01:55   1,2 GB → Backups\server01\wipe-…zip        │
 │  ⏳ apagar         16:02:00   proceduralmap.4000.12345.287.*             │
 │  ○ configurar                 seed 18422 · 4000 · Procedural Map        │
 │  ○ subir                                                                │
 │  ○ pós-wipe                                                             │
 │                                                                         │
 │                          [ cancelar ]              [ ver o log ▾ ]      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─ HISTÓRICO ─────────────────────────────────────────────────────────────┐
 │  #3  14/08 16:00  cadência  ✔ 11 min   seed 12345  BP mantidos          │
 │  #2  07/08 16:00  FORÇADO   ✘ falhou em "subir"    [ retomar ]          │
 └─────────────────────────────────────────────────────────────────────────┘
```

**Retomar existe porque o wipe falha no meio de verdade** — o SteamCMD trava, o
Oxide não compila, o servidor não sobe. Com os passos gravados, o painel oferece
*retomar do passo X*; sem eles, a única saída seria rodar tudo de novo, que no
meio de um wipe significa apagar um mundo que já é o novo.

### 9.2 Mensagens, na barra lateral

Entra em [panel/src/components/sidebar.tsx](../panel/src/components/sidebar.tsx),
no array `NAV`, **entre Loja e Interface**. Ícone `Megaphone`.

É de **rede**, como VIPs, Kits e Loja: escrevo a mensagem uma vez e escolho em
quais servidores ela sai.

```
 MENSAGENS                                            [ + nova mensagem ]
 O que o servidor fala sozinho: avisos, convites e lembretes

 ┌─────┬───────────────┬────────────────────────────┬──────────┬───────────┐
 │  ●  │ NOME          │ TEXTO                      │ REPETE   │ PRÓXIMA   │
 ├─────┼───────────────┼────────────────────────────┼──────────┼───────────┤
 │  ●  │ Discord       │ Entre no nosso Discord: …  │ 30 min   │ em 12 min │
 │  ●  │ Seja VIP      │ VIP tem kit, fila e cor …  │ 45 min   │ em 3 min  │
 │  ●  │ Wipe          │ O wipe é em {wipe.faltam}  │ 2 h      │ em 1h 04m │
 │  ○  │ Regras        │ Sem racismo, sem cheat …   │ 1 h      │ desligada │
 │  ●  │ Manutenção    │ Manutenção às 03:00        │ 1× 25/08 │ 25/08 02h │
 └─────┴───────────────┴────────────────────────────┴──────────┴───────────┘
        ↑ clique liga/desliga                    ↑ o mouse mostra onde sai
```

O editor:

```
 ┌ NOVA MENSAGEM ──────────────────────────────────────────────────────────┐
 │  Nome    [ Discord                                                  ]   │
 │  Texto   [ Entre no nosso Discord: discord.gg/origemz               ]   │
 │          38/512    variáveis: {servidor} {online} {max} {wipe.faltam}   │
 │                               {wipe.quando} {wipe.mapa} {wipe.bp}      │
 │                                                                         │
 │  QUANDO                                                                 │
 │   (•) a cada        [ 30 ]  [ minutos ▾ ]     minutos / horas / dias    │
 │   ( ) todo dia às   [ 20:00 ]                                           │
 │   ( ) toda          [ quinta ▾ ]  às  [ 16:00 ]                         │
 │   ( ) uma vez em    [ 25/08/2026 ]  às  [ 02:00 ]                       │
 │   fuso  [ America/Sao_Paulo ▾ ]                                         │
 │                                                                         │
 │  SÓ ENTRE  [ 10:00 ]  e  [ 23:00 ]        (vazio = a qualquer hora)     │
 │  [x] só quando houver pelo menos [ 1 ] jogador online                   │
 │                                                                         │
 │  ONDE   (•) todos os servidores                                         │
 │         ( ) escolher:  [x] server01   [ ] pve01                         │
 │                                                                         │
 │  APARÊNCIA   tag [ AVISO ]  cor da tag [#ffcc00]                        │
 │              texto [#ffffff]  tamanho [ 14 ]                            │
 │              prévia:   [AVISO] Entre no nosso Discord: discord.gg/…     │
 │                                                                         │
 │                        [ testar agora ]     [ cancelar ]   [ salvar ]   │
 └─────────────────────────────────────────────────────────────────────────┘
```

**"A cada 7 dias" é uma repetição de verdade, e não `604800` segundos.** A
diferença aparece na semana em que o fuso muda de offset — a contagem é em dias
de calendário, com o mesmo cuidado do `schedule.ts` do wipe. Os dois compartilham
as funções de fuso.

### 9.3 O calendário dentro do jogo

Hoje, `ui-preset-main-menu.ts` reserva a página e escreve *"Wipes e eventos
programados entram aqui"*. Ela passa a ser uma **tela gerada** — como a de KITS —
montada no clique, com `volatile: true`:

```
 ┌ HOME ─ LOJA ─ CALENDÁRIO ─ EVENTOS ─ REGRAS ─ KITS ─ RANKING ───────────┐
 │                ══════════                                               │
 │                                                                         │
 │   ▌ PRÓXIMO WIPE                                                        │
 │   ┌───────────────────────────────────────────────────────────────┐     │
 │   │   QUINTA, 03/09        16:00                                  │     │
 │   │   faltam  6d 04h                                              │     │
 │   │                                                               │     │
 │   │   MAPA        procedural · 4000                               │     │
 │   │   BLUEPRINTS  você mantém o que aprendeu                      │     │
 │   └───────────────────────────────────────────────────────────────┘     │
 │                                                                         │
 │   ▌ DEPOIS                                                              │
 │   ┌───────────────────────────────────────────────────────────────┐     │
 │   │   10/09  16:00    semanal      BP mantidos                    │     │
 │   │   17/09  16:00    semanal      BP mantidos                    │     │
 │   │   01/10  16:00    FORÇADO      BP mantidos                    │     │
 │   └───────────────────────────────────────────────────────────────┘     │
 │                                                                         │
 │   ▌ O MAPA DO PRÓXIMO WIPE           🔒 VIP PRATA vê a imagem           │
 └─────────────────────────────────────────────────────────────────────────┘
```

**VIP vê o futuro** — é produto, e vem de graça da fila de mapas: `silver`
conhece o próximo mapa, `gold` conhece os três próximos. E **mostrar a seed é
diferente de mostrar a imagem**: com a seed o jogador abre o RustMaps e estuda
cada monumento dias antes; com a imagem ele vê a forma. São duas chaves separadas
de propósito.

---

## 10. Mensagens: o motor de agendamento

O agente antigo tinha um rodízio: uma lista de frases e um intervalo único para
todas. O pedido aqui é outro — **cada mensagem tem o seu próprio ritmo**.

```
   ANTIGO                              AQUI
   um intervalo, N frases              N mensagens, cada uma com o seu ritmo
   rodízio sequencial/aleatório        cada uma sabe quando é a próxima
   por servidor                        de rede, com alvo por servidor
   texto fixo                          texto com variáveis resolvidas no envio
```

### O relógio

Um `setInterval` de **30 segundos** por processo (não por mensagem, não por
servidor): ele acorda, pergunta ao banco quem está vencida, e manda. Trinta
segundos é o atraso máximo entre "deu a hora" e "saiu no chat" — e criar um timer
por mensagem seria recriar todos eles a cada gravação na tela.

Regras que o código impõe, todas herdadas de erros já cometidos no projeto
antigo:

- **nunca lança.** Rodando num `setInterval`, uma exceção sem dono mataria o laço
  e as mensagens parariam em silêncio — o pior desfecho para algo cuja única
  evidência de funcionamento é aparecer no chat;
- **RCON offline não consome o horário.** `next_at` fica como está, e a próxima
  volta tenta de novo quando o servidor voltar;
- **servidor vazio não consome o horário** (quando `only_with_players`). Assim o
  primeiro jogador que entrar recebe a mensagem logo, em vez de esperar meia hora
  porque o contador correu sozinho num servidor sem ninguém;
- **`last_sent_at` só é gravado DEPOIS da entrega.** Uma mensagem que o RCON
  recusou não pode aparecer na tela como enviada;
- **a janela pode virar a meia-noite.** "Das 22:00 às 02:00" é pedido normal, e
  com a comparação ingênua (`de <= agora && agora <= ate`) ela nunca seria
  verdadeira: o admin escreveria o horário certo e a mensagem não sairia nunca,
  sem nada dizer por quê.

### As variáveis

Resolvidas no agente, no instante do envio, por provedores registrados:

| Variável | Vem de | Exemplo |
|---|---|---|
| `{servidor}` | config do servidor | `server01` |
| `{online}` / `{max}` | `PresenceTracker` | `7` / `100` |
| `{wipe.faltam}` | a agenda (§7) | `6 dias e 4 horas` |
| `{wipe.quando}` | a agenda | `quinta, 03/09 às 16:00` |
| `{wipe.mapa}` | a fila de mapas | `procedural 4000` |
| `{wipe.bp}` | a política do plano | `mantidos` |

**Variável desconhecida fica literal, e não vira vazio.** `{wipe.faltan}` no chat
é feio e o admin conserta em dez segundos; uma frase que perde metade em silêncio
ele descobre semanas depois — ou nunca.

### O transporte

Uma peça só, compartilhada: `core/src/game/broadcast.ts`.

```
   Broadcaster.send({ serverId, text, tag, tagColor, color, size, steamId? })
      │
      ├─ plugin OrigemZChat carregado?
      │     sim  ->  origemz.chat.broadcast <base64 do JSON>  ->  {"ok":true,"sent":N}
      │     não  ->  say "<texto sem cor>"                    ->  sent desconhecido
      └─ devolve { sent, via }
```

**Base64 não é enfeite.** Medido neste ecossistema: JSON cru pelo RCON chega ao
plugin com as aspas comidas — o parser de console do Rust trata token entre aspas
como argumento citado e as remove. Base64 não tem aspas, espaço nem chave.

O fallback para `say` existe porque nem todo servidor terá o `OrigemZChat`
carregado, e uma mensagem sem cor é melhor que silêncio.

---

## 11. A ponte: os avisos de wipe são mensagens

Duas coisas parecidas, e elas **não** são a mesma:

| | Avisos do wipe | Mensagens do admin |
|---|---|---|
| Quem cria | o sistema, a partir dos offsets | uma pessoa, na tela |
| Quando saem | T-24h, T-6h, … T-1min de um wipe | no ritmo que ela escolheu |
| Onde moram | `wipe_settings` | `messages` |
| Como saem | **o mesmo `Broadcaster`** | **o mesmo `Broadcaster`** |

O admin **também** pode criar uma mensagem sua com `{wipe.faltam}` dentro — e é
exatamente isso que o pedido descreve ("nossos mods vão usar isso também para
agendar mensagem de wipe"). Os dois caminhos coexistem: um é automático e
garantido; o outro é editorial.

> **####  O QUE NÃO PODE ACONTECER  ####**
>
> O módulo de mensagens **não pode saber o que é um wipe**, e o módulo de wipe
> **não pode reimplementar envio de chat**. O que os liga são duas interfaces
> pequenas: o `Broadcaster` (transporte) e o provedor de variáveis `{wipe.*}`
> (leitura). Sem essa disciplina, uma frente trava a outra — e é ela que permite
> as duas serem construídas em paralelo.

---

## 12. Eventos — o esboço

Fora do escopo desta fase, **menos a tabela** (migração 27) e o formato de
marcação que o componente de calendário consome. O motivo é concreto: a tela
`EVENTOS` do menu in-game e a grade do calendário do painel vão ler wipes e
eventos juntos, e descobrir isso depois custaria refazer os dois.

O que fica escrito agora, e só isso:

- um evento é `{ nome, quando, até quando, descrição, imagem }`;
- ele aparece no calendário do painel e na tela do jogo, com cor própria;
- ele **não executa nada** — não há operação de evento. Quem faz o evento
  acontecer é um plugin ou uma pessoa.

---

## 13. Os casos chatos, e o que fazer

| Caso | Sem tratamento | Tratamento |
|---|---|---|
| Oxide não atualizou no forçado | o servidor sobe **sem plugin nenhum**; jogadores entram num "vanilla" com o banco do agente esperando plugin | esperar o build compatível antes de liberar, com teto e aviso na tela |
| Jogadores online na hora | perdem o que estavam fazendo sem aviso | esvaziar: anunciar, esperar, e só então `quit` (que salva antes de sair) |
| Disco cheio no backup | o wipe falha **com o servidor já parado** | conferir espaço **antes** de parar; podar o backup mais antigo |
| Mapa não decidido | wipe bloqueado por falta de curadoria | fila vazia → sorteia, e registra que sorteou |
| Wipe rodando durante um build de plugin | build contra assemblies trocando | a trava por recurso do `OperationsService` já resolve |
| Relógio do host errado | wipe na hora errada | comparar com o forçado calculado e avisar divergência > 1 min |
| Dois wipes em 4 dias | jogador perde base de 2 dias | política de colisão, padrão `reancorar` |
| Wipe manual e agendado juntos | dois runs | trava do `OperationsService` + o manual **reancora** a cadência |
| `save` pendente na hora de parar | perde minutos de jogo | `quit` pelo RCON salva; `force` só quando o RCON não responde, e com o aviso na tela |
| Execução morre no meio (`pm2 restart`) | run "rodando" para sempre | no boot, run `running` sem operação viva vira `failed` com "o agente reiniciou" — e oferece retomar |
| Mensagem com `{wipe.faltam}` num servidor sem agenda | frase quebrada | o provedor devolve "sem wipe agendado", nunca vazio |
| Duas telas editando a fila de mapas | ordem que ninguém pediu | `reorder` recebe a fila **inteira**, e não "mova para cima" |
| RustMaps fora do ar na hora do wipe | fila sem prévia, e o wipe travado esperando imagem | **prévia é enfeite**: sem ela o wipe usa a seed do mesmo jeito, e registra por quê |
| Mapa custom que não baixa | o servidor não sobe, e o mundo velho já foi apagado | validar a URL **antes** do passo `parar`, nunca depois — e recusar custom em forçado sem a marcação explícita |
| Snapshot de BP grande demais para o RCON | payload cortada, e um BP pela metade que *parece* ter funcionado | export **paginado**, e recusa inteira em vez de corte — a mesma disciplina do `origemz.vip.sync` |
| VIP venceu entre o snapshot e a devolução | devolve vantagem a quem já não paga | o direito é conferido **na devolução**, contra o VIP vigente naquele instante |
| Jogador com direito nunca mais entra | pendência eterna na fila de devolução | o snapshot vale para **o wipe seguinte, e só ele**; depois disso expira |

---

## 14. As decisões, já tomadas

**Nada fica de fora nesta fase.** As três coisas que a primeira versão deste
plano propunha adiar — blueprints por VIP, full wipe e RustMaps — **entram**, e
cada uma ganhou a sua frente (§15).

| # | Decisão | O que ela custa, e onde |
|---|---|---|
| 1 | **O wipe é por servidor** (aba do servidor); a **mensagem é de rede** (barra lateral, com alvo por servidor) | — |
| 2 | **Blueprints por VIP ENTRA.** `wipe_except_vip` funciona: snapshot antes do wipe, devolução por nível, com atraso configurável | exige comandos novos no plugin (`origemz.bp.export` / `origemz.bp.restore`) — **Frente I**, a única com C# |
| 3 | **Full wipe ENTRA.** Dados de plugin são apagados por **lista explícita**, montada do que existe de verdade em disco | uma rota que lista `oxide\data` e os `.db` da pasta do save — **Frente D** |
| 4 | **RustMaps ENTRA.** Prévia em imagem, geração sob demanda, poll, staging automático no forçado, e **mapa custom com validação de URL** | chave de API no `.env`, cliente com poll, e `SERVER_LEVELURL` acrescentado em quatro lugares — **Frentes H e C** |
| 5 | **Discord/webhook fica de fora**: o aviso sai no chat do jogo | se houver webhook, é um destino a mais no `Broadcaster` — não muda nada do resto |
| 6 | O `identity` digitado é a confirmação do "wipar agora" | qualquer confirmação mais fraca (um "tem certeza?") permite zerar por duplo-clique |
| 7 | Fuso padrão `America/Sao_Paulo`, dado gravado sempre em **epoch ms UTC** | não é negociável: é o que impede o wipe deslizar uma hora sozinho |

### O que ainda precisa de resposta sua — e não bloqueia ninguém

| Pergunta | Onde ela aparece | Padrão enquanto não houver resposta |
|---|---|---|
| Qual plano do RustMaps temos? O gerador custom exige premium | Frente H | a tela mostra o plano que a chave responde, e desabilita o que ele não permite |
| Quanto de BP cada nível leva de volta, e com quanto atraso? | Frente I | `bronze` bancada 1, `silver` bancada 2, `gold` tudo, atraso 0 h — editável na tela |
| Quais arquivos de `oxide\data` somem no full wipe? | Frente D | **nenhum** vem marcado; a lista mostra o que existe e o admin escolhe |

---

## 15. A ordem, e quem faz o quê

| # | Etapa | Entrega visível | Frente | Depende de |
|---|---|---|---|---|
| 0 | Os tipos compartilhados | as frentes compilam umas contra as outras | **0** | — |
| 1 | Calendário: forçado + cadência + colisão + `wipe_plans` | `GET /wipe/plans` responde certo | **A** | 0 |
| 2 | Aba WIPE com Geral e Agenda (leitura + configuração) | o admin vê a contagem regressiva | **B** | 0 |
| 3 | Fila de mapas + sub-aba Mapas + `SERVER_LEVELURL` | o próximo mapa é escolhido | **C** | 0 |
| 4 | Mensagens: motor, rotas, tela | o servidor fala sozinho | **E** | 0 |
| 5 | **Execução**: `wipe-run`, backup, purge, full wipe, configurar, subir | **o wipe acontece sozinho** | **D** | A, C |
| 6 | Sub-aba Execução com passos e log | acompanhar e retomar | **D** | 5 |
| 7 | Avisos de wipe pelo `Broadcaster` + variáveis `{wipe.*}` | o jogador sabe do wipe | **F** | A, E |
| 8 | Tela CALENDÁRIO no jogo | o jogador vê no `/menu` | **G** | A |
| 9 | RustMaps: prévia, geração, poll, staging | o mapa tem cara antes de entrar | **H** | C |
| 10 | Blueprints por VIP: plugin, snapshot, devolução | o VIP recomeça sabendo | **I** | A, D |
| 11 | Eventos | — | — | 8 |

**A etapa 5 é a linha divisória.** Até ela, o sistema *informa*; a partir dela,
ele *apaga arquivo*. Ela entra com o backup pronto no mesmo commit — e não
"depois".

O detalhamento de cada frente, com os arquivos que ela cria e toca, as zonas de
conflito entre elas e o critério de aceite, está em
[17-FRENTES-WIPE-E-MENSAGENS.md](17-FRENTES-WIPE-E-MENSAGENS.md).

---

## Fontes

A pesquisa de mecânica (quais arquivos apagar, o horário do forçado, o que o
force wipe leva e o que não leva, o comportamento do RustMaps e do staging) está
inteira em `F:\Projects\Rust\Docs\OrigemZWipe\PLANO.md`, com os links. Ela **não
foi repetida aqui** — o que este documento acrescenta é a checagem contra esta
árvore: os arquivos medidos em `Servers\server01\server\server01\` (§4) e as
peças que já existem no agente atual (§2).
