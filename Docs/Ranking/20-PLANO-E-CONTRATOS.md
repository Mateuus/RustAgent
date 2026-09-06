# 20 — O RANKING: plano e contratos

> **O que este documento é.** A pesquisa (`19-PESQUISA-RANKING.md`) decidiu *o
> que* medir e *por quê*. Este documento fecha *o formato exato* de cada peça —
> esquema, comando, marcador, rota — para que várias frentes possam construir em
> paralelo sem divergir.
>
> **Regra de leitura:** quando este documento e a pesquisa discordarem sobre uma
> forma concreta, **este vale**. A pesquisa foi escrita antes de o terreno ser
> medido, e três coisas mudaram (§0.2). Quando ele discordar sobre uma *razão*,
> a pesquisa vale — ela é o registro do porquê.

**Escrito em 05/09/2026.** Estado do repositório na hora da escrita: última
migração aplicada **042**; ids **033** e **034** vagos no array, reservados para
este trabalho desde a migração 035.

---

## Índice

- [§0 — O pedido do dono, e o que mudou desde a pesquisa](#0--o-pedido-do-dono-e-o-que-mudou-desde-a-pesquisa)
- [§1 — A ideia que sustenta o desenho: ranking é linha, não código](#1--a-ideia-que-sustenta-o-desenho-ranking-é-linha-não-código)
- [§2 — O esquema: migração 033](#2--o-esquema-migração-033)
- [§3 — O esquema: migração 034](#3--o-esquema-migração-034)
- [§4 — O catálogo de rankings que nasce semeado](#4--o-catálogo-de-rankings-que-nasce-semeado)
- [§5 — As janelas, e como um período fecha](#5--as-janelas-e-como-um-período-fecha)
- [§6 — O contrato do lote: `origemz.stats.flush` / `ack`](#6--o-contrato-do-lote-origemzstatsflush--ack)
- [§7 — O contrato do evento: `#OZSTAT#`](#7--o-contrato-do-evento-ozstat)
- [§8 — O caminho de escrita, inteiro](#8--o-caminho-de-escrita-inteiro)
- [§9 — A API](#9--a-api)
- [§10 — O painel](#10--o-painel)
- [§11 — A tela do jogo](#11--a-tela-do-jogo)
- [§12 — O site](#12--o-site)
- [§13 — O buraco que a medição encontrou: o item custom nunca chega ao plugin](#13--o-buraco-que-a-medição-encontrou-o-item-custom-nunca-chega-ao-plugin)
- [§14 — As frentes, e o que cada uma entrega](#14--as-frentes-e-o-que-cada-uma-entrega)
- [§15 — As armadilhas medidas neste projeto que valem aqui](#15--as-armadilhas-medidas-neste-projeto-que-valem-aqui)
- [§16 — Medido, conferido, projeto](#16--medido-conferido-projeto)

---

## 0 — O pedido do dono, e o que mudou desde a pesquisa

### 0.1 O pedido, em seis frases

1. O ranking mora **no nosso plugin** (a coleta) e no agente (o número), e o
   **site pega por endpoint**.
2. A janela é **configurável pelo admin**: por wipe, por 15 dias, por mês, por
   temporada.
3. O **histórico fica guardado** — a temporada passada continua consultável
   depois que a nova começa.
4. O ranking aparece **no jogo**, no `/menu`, com filtro — além do site.
5. Existem os **rankings fixos** (abates, tempo online, minério, explosivo, tiro
   longo) **e os dinâmicos**, criados pelo admin.
6. O primeiro dinâmico é o **Troféu Bleik**: um item que, ao ser pego, some e
   vira ponto. **Quantos pontos é configuração do item.**

### 0.2 As três coisas que a pesquisa não podia saber

A pesquisa foi escrita em 04/09. Entre ela e hoje, outra frente construiu o
sistema de item custom, e isso muda três parágrafos dela:

| A pesquisa dizia | O que está no disco hoje |
|---|---|
| "a primeira migração livre para o ranking é a **033**" | continua verdade — 033 e 034 estão vagas de propósito; a frente do item custom pulou para a 041 |
| §11.2: "reusando o padrão de sub-abas que a tela CALENDÁRIO já tem" | **a tela CALENDÁRIO não tem sub-abas.** O padrão real é `tabsRow` em `core/src/game/ui-widgets.ts:295`, usado por KITS e LOJA |
| o Troféu Bleik precisaria de um item nativo renomeado | o item custom **existe**, com `action` em JSON e a coluna `consume_on_pickup` (migração 042). A ação `points` **já está no zod e no painel**, esperando o ranking |

E uma quarta, que não é da pesquisa mas decide uma frente inteira: **a
sincronização agente → plugin de itens custom não existe** (§13).

---

## 1 — A ideia que sustenta o desenho: ranking é linha, não código

A pesquisa escolheu guardar estatística como `(metric TEXT, value INTEGER)` em
vez de uma coluna por métrica, e justificou: *"a lista de métricas CRESCE; coluna
por métrica é uma migração por ideia"*.

**O pedido do dono leva essa escolha ao seu destino natural.** Se a métrica é
uma linha, então **o ranking também pode ser uma linha** — e "fixo" e "dinâmico"
deixam de ser dois sistemas.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  rankings  (a DEFINIÇÃO — migração 034)                      │
   │                                                              │
   │   id            metric          label          source        │
   │   ───────────   ─────────────   ────────────   ──────────    │
   │   abates        pvp.kills       Abates         plugin    ◄── semeado
   │   tempo-online  time.played     Tempo online   agent     ◄── semeado
   │   trofeu-bleik  trophy.bleik    Troféu Bleik   item      ◄── o admin criou
   └──────────────────────────────────────────────────────────────┘
                              │
                              │  a mesma consulta serve os três
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  player_stats  (o NÚMERO — migração 033)                     │
   │     (period_id, steam_id, metric) → value                    │
   └──────────────────────────────────────────────────────────────┘
```

**A única diferença entre um ranking fixo e um dinâmico é a coluna `builtin`** —
que só decide se o botão "apagar" aparece no painel. A consulta, a tela, a rota,
o período e o histórico são os mesmos.

> **A consequência prática, e é ela que faz o pedido do dono caber:** criar o
> ranking do Troféu Bleik **não é escrever código**. É uma linha em `rankings` e
> um item custom apontando para ela. O segundo ranking dinâmico — uma "medalha
> de evento", um "ponto de missão" — custa zero.

---

## 2 — O esquema: migração 033

> **Nome:** `rankings-core`. **Id:** `33`. Entra no array `MIGRATIONS` de
> `core/src/db/migrations.ts` **na posição numérica**, entre a `{ id: 32 }`
> (`:3366`) e a `{ id: 35 }` (`:3375`) — o espaço já está reservado ali com um
> comentário.

### 2.1 `stat_periods` — a janela

```sql
-- ----------------------------------------------------------
--  stat_periods — a JANELA de um ranking.
--
--  Um período é (servidor, tipo, começo). O tipo 'wipe' aponta
--  para a linha de `wipes` que o criou: é assim que o ranking
--  sabe que aquele mundo acabou sem depender de relógio.
--
--  'lifetime' é UM período por servidor, sem fim — o que
--  responde à promessa do 09-ROADMAP: o ranking sobrevive ao
--  wipe porque o JOGADOR sobrevive ao wipe.
--
--  ####  POR QUE SÓ TRÊS TIPOS, SE O DONO PEDIU QUATRO  ####
--
--  O dono pediu wipe, 15 dias, mês e temporada. Isso NÃO são
--  quatro tipos de período: são quatro maneiras de FATIAR o
--  mesmo tipo. O `kind` diz o PAPEL da janela; o
--  `ranking_settings.season_mode` (034) diz o TAMANHO dela.
--
--  Fazer 'biweekly' e 'monthly' virarem `kind` daria dois
--  períodos abertos ao mesmo tempo no mesmo servidor, cada um
--  com um pódio diferente, e a tela teria de explicar qual é
--  "o" ranking. Com um `season` configurável, a resposta é
--  sempre uma.
-- ----------------------------------------------------------
CREATE TABLE stat_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('wipe','season','lifetime')),

  -- A linha de `wipes` que abriu este período. NULL em 'lifetime'
  -- e em 'season' que não acompanha wipe.
  wipe_id INTEGER REFERENCES wipes(id) ON DELETE SET NULL,

  started_at INTEGER NOT NULL,

  -- NULL = ainda aberto. É a coluna que a consulta do "agora" usa.
  ended_at INTEGER,

  -- Como o modo estava configurado QUANDO o período abriu. Mudar
  -- a configuração não reescreve o passado: a temporada de março
  -- continua dizendo que foi mensal, mesmo depois de virar
  -- trimestral em abril.
  season_mode TEXT,

  -- "Temporada de março", "Wipe de 05/09". Para a tela e para o
  -- histórico; nunca é chave.
  label TEXT
);

-- Um período aberto por (servidor, tipo), e o banco garante isso.
CREATE UNIQUE INDEX idx_stat_periods_open
  ON stat_periods (server_id, kind) WHERE ended_at IS NULL;

-- A consulta do histórico: "as temporadas deste servidor, da mais
-- nova para a mais velha".
CREATE INDEX idx_stat_periods_history
  ON stat_periods (server_id, kind, started_at DESC);
```

### 2.2 `player_stats` — o contador

```sql
-- ----------------------------------------------------------
--  player_stats — o contador.
--
--  ####  POR QUE (metric TEXT, value INTEGER) E NÃO UMA COLUNA
--        POR MÉTRICA  ####
--
--  Porque a lista de métricas CRESCE, e agora cresce em runtime:
--  o admin cria um ranking novo pelo painel (§3.1) e ele precisa
--  funcionar sem migração. Coluna por métrica tornaria o pedido
--  do dono impossível, não só caro.
--
--  O custo é conhecido: não dá para somar duas métricas numa
--  expressão SQL simples, e o índice precisa começar por
--  (period_id, metric). As consultas do ranking são exatamente
--  essas — "top N de UMA métrica num período".
-- ----------------------------------------------------------
CREATE TABLE player_stats (
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,

  -- 'ore.sulfur', 'explosive.seq', 'pvp.kills', 'trophy.bleik', …
  -- Formato: familia.nome, minúsculas. É o MESMO formato que o
  -- zod do item custom já exige em
  -- core/src/http/routes/custom-items.ts:121-132.
  metric TEXT NOT NULL,

  -- Sempre INTEIRO e sempre MONOTÔNICO: só cresce, e cresce por
  -- soma de lote. Guardar float aqui abriria a porta para
  -- arredondamento acumulado em milhões de somas.
  --
  -- Medida que não é inteira (distância de tiro) NÃO mora aqui:
  -- mora em player_records, que é o fato com testemunho.
  value INTEGER NOT NULL DEFAULT 0,

  updated_at INTEGER NOT NULL,
  PRIMARY KEY (period_id, steam_id, metric)
);

-- A consulta do ranking: top N de uma métrica num período.
CREATE INDEX idx_player_stats_rank
  ON player_stats (period_id, metric, value DESC);

-- A consulta da ficha: tudo daquele jogador.
CREATE INDEX idx_player_stats_player ON player_stats (steam_id, metric);
```

> **A FK para `players` cobra um preço, e ele precisa ser pago no lugar certo.**
> Um lote pode trazer um `steamId` que o agente nunca viu (jogador que entrou e
> farmou entre duas rodadas de presença). Somar antes de o jogador existir viola
> a FK e derruba a transação inteira — ou seja, **perde o lote de todo mundo**.
> A aplicação do lote **garante o jogador primeiro**, no mesmo `BEGIN`, com o
> mesmo `INSERT OR IGNORE INTO players` que `core/src/players/presence.ts` já
> usa. Não invente um caminho novo: reuse o repositório de jogadores.

### 2.3 `player_records` — o fato com testemunho

```sql
-- ----------------------------------------------------------
--  player_records — o FATO, com testemunho.
--
--  O tiro longo mora aqui. Um contador diria "412"; esta tabela
--  diz com que arma, em quem, onde e quando — que é o que se
--  mostra quando alguém contesta o recorde.
-- ----------------------------------------------------------
CREATE TABLE player_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,

  -- 'shot.distance' hoje; 'raid.biggest' amanhã.
  metric TEXT NOT NULL,

  -- REAL aqui, ao contrário de player_stats: distância é medida,
  -- não contagem, e 412.73 é a informação.
  value REAL NOT NULL,

  at INTEGER NOT NULL,

  -- O testemunho, em JSON: arma, munição, headshot, vítima, grid,
  -- posições, ratio de validação. É para LER, não para filtrar —
  -- por isso uma coluna, e não dez.
  detail TEXT,

  -- 'ok' | 'suspect' | 'void'. Suspeito é GRAVADO e não entra no
  -- pódio; apagar seria perder o rastro da fraude.
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','suspect','void'))
);

CREATE INDEX idx_player_records_rank
  ON player_records (period_id, metric, value DESC) WHERE status = 'ok';

CREATE INDEX idx_player_records_player ON player_records (steam_id, metric);
```

### 2.4 `stat_batches` e `stat_events` — as duas idempotências

São **duas**, porque há dois caminhos de dado (§6 e §7) e cada um erra de um
jeito.

```sql
-- ----------------------------------------------------------
--  stat_batches — a idempotência do LOTE.
--
--  Sem ela, um `ack` perdido faria o mesmo lote entrar duas
--  vezes, e o contador de alguém dobraria sem nada no log.
-- ----------------------------------------------------------
CREATE TABLE stat_batches (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  players INTEGER NOT NULL,
  events INTEGER NOT NULL,
  PRIMARY KEY (server_id, batch_id)
);

CREATE INDEX idx_stat_batches_recent ON stat_batches (server_id, applied_at DESC);

-- ----------------------------------------------------------
--  stat_events — a idempotência do EVENTO, e a auditoria.
--
--  ####  POR QUE ELA EXISTE, SE JÁ HÁ stat_batches  ####
--
--  Porque o troféu viaja pelos DOIS caminhos de propósito: o
--  push dá o "agora" (o recibo no chat tem que ser na hora), o
--  lote dá o "garantido". O mesmo ponto chega duas vezes, e o
--  batchId não ajuda — as duas chegadas estão em lotes
--  diferentes. Quem desempata é o eventId.
--
--  ####  E ELA PAGA UM SEGUNDO ALUGUEL  ####
--
--  Ela é a auditoria do §8.2 do documento do troféu: emitidos
--  × convertidos, por dia, por fonte. Sem esta tabela, "o
--  jogador diz que ganhou 3 troféus e só contou 1" não tem
--  resposta — só a palavra de um contra a do outro.
-- ----------------------------------------------------------
CREATE TABLE stat_events (
  -- Gerado pelo PLUGIN: steamId-epochSegundos-contador. Nunca
  -- pelo agente: o agente não sabe o que ele não recebeu.
  event_id TEXT PRIMARY KEY,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  metric TEXT NOT NULL,

  -- Quantos pontos este evento valeu. Já multiplicado: 3 troféus
  -- de 5 pontos chegam como 15, e não como 3 com um peso junto.
  -- O peso é configuração do ITEM e pode mudar amanhã; o ponto
  -- concedido é fato e não muda.
  amount INTEGER NOT NULL,

  -- De onde veio: 'item:trofeu-bleik', 'dungeon', 'admin'.
  -- Conjunto ABERTO no banco e FECHADO no zod da borda.
  source TEXT,

  -- Relógio do SERVIDOR DE JOGO, epoch em segundos.
  at INTEGER NOT NULL,

  -- Relógio do AGENTE. Os dois existem porque a diferença entre
  -- eles é o tamanho da janela de perda (§8.3).
  applied_at INTEGER NOT NULL,

  -- Por qual dos dois caminhos ele chegou PRIMEIRO.
  via TEXT NOT NULL CHECK (via IN ('push','flush'))
);

CREATE INDEX idx_stat_events_audit ON stat_events (server_id, metric, at DESC);
CREATE INDEX idx_stat_events_player ON stat_events (steam_id, at DESC);
```

### 2.5 `stat_adjustments` — quem mexeu no número

```sql
-- ----------------------------------------------------------
--  stat_adjustments — quem mexeu no número, e por quê.
--
--  Zerar a estatística de um suspeito é AÇÃO ADMINISTRATIVA, e
--  ação administrativa sem autor é o que não se consegue
--  explicar depois. Mesma razão da `store_audit` (migração 021).
-- ----------------------------------------------------------
CREATE TABLE stat_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  metric TEXT,
  action TEXT NOT NULL CHECK (action IN ('reset','set','void_record','grant')),
  old_value INTEGER,
  new_value INTEGER,
  actor TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX idx_stat_adjustments_player ON stat_adjustments (steam_id, at DESC);
```

---

## 3 — O esquema: migração 034

> **Nome:** `rankings-catalog`. **Id:** `34`.

### 3.1 `rankings` — a definição

```sql
-- ----------------------------------------------------------
--  rankings — a DEFINIÇÃO de um ranking.
--
--  ####  FIXO E DINÂMICO SÃO A MESMA LINHA  ####
--
--  Um ranking "fixo" (abates, tempo online) e um "dinâmico"
--  (Troféu Bleik) diferem em UMA coluna: `builtin`. Ela só
--  decide se o botão de apagar aparece no painel.
--
--  A alternativa — uma lista fixa em TypeScript e uma tabela só
--  para os do admin — daria duas fontes para a mesma pergunta
--  ("quais rankings existem?"), e a tela teria de concatenar as
--  duas em toda consulta. É a segunda fonte que o
--  02-ARQUITETURA já proíbe.
-- ----------------------------------------------------------
CREATE TABLE rankings (
  -- Slug estável. É o que a URL do painel e o site guardam.
  id TEXT PRIMARY KEY,

  -- A chave em player_stats. Única: dois rankings sobre a mesma
  -- métrica seriam a mesma lista com dois nomes.
  metric TEXT NOT NULL UNIQUE,

  label TEXT NOT NULL,

  -- "abates", "troféus", "metros". Vai na coluna da tela; NULL
  -- quando o número não tem unidade (K/D).
  unit TEXT,

  -- A frase que explica ao jogador o que ele precisa fazer para
  -- pontuar. Aparece na tela do jogo e no site.
  description TEXT,

  -- ####  DE ONDE O NÚMERO VEM  ####
  --   'plugin'   — hook do jogo, chega por flush/push
  --   'agent'    — o agente calcula e soma (tempo online)
  --   'item'     — a ação `points` de um item custom
  --   'computed' — não tem linha em player_stats; é derivado
  --                na leitura de outras métricas (K/D)
  source TEXT NOT NULL CHECK (source IN ('plugin','agent','item','computed')),

  -- 'counter' soma em player_stats; 'record' mora em
  -- player_records; 'ratio' é calculado.
  value_kind TEXT NOT NULL CHECK (value_kind IN ('counter','record','ratio')),

  direction TEXT NOT NULL DEFAULT 'desc' CHECK (direction IN ('desc','asc')),

  -- ####  EM QUE JANELA ESTE RANKING DISPUTA  ####
  --
  -- Decidido pelo dono em 05/09/2026, e é o que responde a
  -- "quero manter o ranking de abates e zerar o de minério".
  --
  -- Todo evento continua somando nas TRÊS janelas abertas — a
  -- escrita não muda. Esta coluna diz qual delas é a disputa
  -- daquele ranking: a que a tela abre por padrão, e a única
  -- cuja virada o zera aos olhos de quem joga.
  --
  --   'wipe'     — zera quando o mundo zera. É o farm: o minério
  --                daquele mapa não faz sentido no mapa seguinte
  --   'season'   — atravessa os wipes e só zera quando a
  --                temporada fecha. É onde mora a premiação
  --   'lifetime' — nunca zera
  --
  -- ####  POR QUE UMA COLUNA, E NÃO UMA TEMPORADA POR RANKING  ####
  --
  -- Porque uma temporada por ranking significaria calendários
  -- concorrentes no mesmo servidor — o troféu virando em março,
  -- os abates em abril — e a pergunta "em que temporada estamos?"
  -- deixaria de ter resposta. Com uma temporada só e esta coluna,
  -- cada ranking escolhe se ela o afeta, e a data é uma só.
  window TEXT NOT NULL DEFAULT 'season'
    CHECK (window IN ('wipe','season','lifetime')),

  -- ####  ENTRA NA SOMA DA REDE?  ####
  --
  -- 0 para minério e explosivo. Somar um servidor 1x com um 5x
  -- produz uma lista ordenada por EM QUE SERVIDOR a pessoa
  -- jogou — ver 19-PESQUISA §12.4. Abate, tempo, tiro e troféu
  -- não têm esse defeito.
  global_eligible INTEGER NOT NULL DEFAULT 1
    CHECK (global_eligible IN (0, 1)),

  -- 1 = veio semeado, o admin não apaga. 0 = o admin criou.
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),

  -- Desligado NÃO é apagado: o número continua lá, só sai das
  -- telas. Mesma regra do custom_items.enabled.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- A ordem das abas na tela do jogo e das linhas no painel.
  sort_order INTEGER NOT NULL DEFAULT 100,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_rankings_visible ON rankings (enabled, sort_order);
```

### 3.2 `ranking_settings` — a janela, por servidor

```sql
-- ----------------------------------------------------------
--  ranking_settings — o tamanho da temporada, POR SERVIDOR.
--
--  Decidido pelo dono em 05/09/2026: cada servidor tem a sua
--  janela. É o padrão que kits (012), VIP e itens custom (041)
--  já seguem — o que vale num servidor não vale nos outros por
--  padrão.
--
--  Sem linha = os padrões do código (season_mode 'monthly').
--  Não semeamos uma linha por servidor: um servidor criado
--  depois desta migração ficaria sem ela, e o código teria de
--  saber o padrão de qualquer jeito. Então o padrão mora num
--  lugar só, no código.
-- ----------------------------------------------------------
CREATE TABLE ranking_settings (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,

  --   'wipe'      — a temporada acompanha o mundo
  --   'biweekly'  — 15 dias corridos a partir da âncora
  --   'monthly'   — vira no dia 1
  --   'quarterly' — vira em 1/jan, 1/abr, 1/jul, 1/out
  --   'days'      — N dias corridos (season_days)
  --   'manual'    — só fecha pela rota, com autor
  season_mode TEXT NOT NULL DEFAULT 'monthly'
    CHECK (season_mode IN ('wipe','biweekly','monthly','quarterly','days','manual')),

  -- Só faz sentido em 'days', e o CHECK obriga que exista lá.
  season_days INTEGER CHECK (season_days IS NULL OR season_days > 0),

  -- Quando a contagem de 'biweekly'/'days' começou. NULL = a
  -- abertura do período atual serve de âncora.
  season_anchor_at INTEGER,

  -- ####  O WIPE ABRE TEMPORADA NOVA?  ####
  --
  -- Pedido do dono em 05/09/2026, e ele vale para os DOIS tipos
  -- de wipe: o que o agente executa e o que alguém fez à mão com
  -- o servidor na unha. A âncora é a mesma nos dois casos — um
  -- mundo novo apareceu (§5.2) —, e é justamente por isso que
  -- amarrar a temporada ao wipe funciona sem depender de o wipe
  -- ter passado pelo painel.
  --
  -- Isto NÃO é o mesmo que `season_mode = 'wipe'`. O modo diz
  -- que a temporada É o wipe (uma por mundo). Esta coluna diz que
  -- a temporada, seja ela mensal ou de 15 dias, TAMBÉM vira
  -- quando o mundo vira — o que é o que se quer quando a
  -- premiação acompanha o mapa sem ser semanal.
  season_on_wipe INTEGER NOT NULL DEFAULT 0
    CHECK (season_on_wipe IN (0, 1)),

  -- Quantas posições o pódio congela ao fechar (§5.4).
  snapshot_size INTEGER NOT NULL DEFAULT 50 CHECK (snapshot_size > 0),

  updated_at INTEGER NOT NULL,

  CHECK (season_mode <> 'days' OR season_days IS NOT NULL)
);
```

### 3.3 `ranking_snapshots` — o pódio congelado

```sql
-- ----------------------------------------------------------
--  ranking_snapshots — o HISTÓRICO.
--
--  ####  POR QUE CONGELAR, SE OS DADOS CONTINUAM NO BANCO  ####
--
--  Porque o pódio de março precisa continuar sendo o pódio de
--  março. Três coisas o mudariam depois:
--
--   1. um estorno de fraude aplicado ao período fechado;
--   2. um peso de índice que muda (o SEQ do explosivo, o
--      encolhimento do K/D);
--   3. um jogador apagado da base, que levaria a linha junto
--      pelo ON DELETE CASCADE.
--
--  Congelar não é otimização — é a única maneira de a tela
--  "campeões da temporada passada" responder a mesma coisa
--  amanhã. Ver 19-PESQUISA §12.2 e §12.5.
--
--  E é por isso que `display_name` é COPIADO aqui: o jogador
--  troca de nome, e o campeão de março tem que continuar
--  aparecendo com o nome que ele tinha quando ganhou.
-- ----------------------------------------------------------
CREATE TABLE ranking_snapshots (
  period_id INTEGER NOT NULL REFERENCES stat_periods(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  position INTEGER NOT NULL,
  steam_id TEXT NOT NULL,

  -- Congelado de propósito. Não é FK: o snapshot sobrevive ao
  -- jogador sair da base.
  display_name TEXT,

  -- REAL, e não INTEGER como em player_stats, porque aqui cabem
  -- as três formas: contador (inteiro exato até 2^53), recorde
  -- (412.73) e razão (K/D 1.42). Não há soma acontecendo nesta
  -- tabela — o valor entra uma vez e nunca mais muda —, então o
  -- motivo que proibiu float lá não vale aqui.
  value REAL NOT NULL,

  frozen_at INTEGER NOT NULL,
  PRIMARY KEY (period_id, metric, position)
);

-- "em quantas temporadas o Fulano ficou no pódio?"
CREATE INDEX idx_ranking_snapshots_player ON ranking_snapshots (steam_id, metric);
```

### 3.4 A opção na execução de wipe

O dono pediu que a virada da temporada seja **uma opção do wipe que já existe** —
inclusive do wipe forçado pelo painel. A configuração do §3.2 é a regra
permanente; esta coluna é a exceção **daquela execução**:

```sql
-- ----------------------------------------------------------
--  wipe_runs ganha a decisão sobre a temporada.
--
--  NULL  = herda `ranking_settings.season_on_wipe`
--  1     = esta execução abre temporada nova, mesmo que a
--          configuração diga que não
--  0     = esta execução NÃO abre, mesmo que a configuração
--          diga que sim
--
--  ####  POR QUE TRÊS ESTADOS, E NÃO UM BOOLEANO  ####
--
--  Porque "não decidi" e "decidi que não" são respostas
--  diferentes, e um booleano com default 0 transformaria toda
--  execução antiga — e toda execução em que ninguém tocou na
--  caixa — numa decisão explícita de NÃO virar a temporada. A
--  configuração do servidor deixaria de valer sem que ninguém
--  a tivesse mudado.
--
--  É a mesma distinção que `wipe_runs.wipe_run_id` já faz em
--  `wipes` (migração 025): NULL ali significa "wipe feito à
--  mão", e não "wipe da execução número zero".
-- ----------------------------------------------------------
ALTER TABLE wipe_runs
  ADD COLUMN open_ranking_season INTEGER
  CHECK (open_ranking_season IS NULL OR open_ranking_season IN (0, 1));
```

> **A ordem das migrações permite isto.** `wipe_runs` nasce na 025, e nenhuma
> migração posterior a recria — as três que a alteram (029, 030, 031) são todas
> anteriores à 034. Um `ALTER` aqui é seguro, e continua seguro em banco novo,
> porque o runner aplica por ordem de id.

**E a tela mostra o que vai acontecer, sem pedir para escolher de novo.** Quem
zera e quem não zera já está declarado em `rankings.window` (§3.1). A tela de
wipe **lista** — "vão zerar: Minério, Explosivo, Tiro mais longo" — e não repete
a pergunta. Repetir a decisão a cada wipe é como se perde a configuração: alguém
marca diferente uma vez, e ninguém descobre por que o ranking zerou.

---

## 4 — O catálogo de rankings que nasce semeado

A migração 034 **semeia** os rankings fixos. O dono confirmou os quatro grupos
em 05/09/2026.

| id | metric | label | unit | source | value_kind | global | **window** | ordem |
|---|---|---|---|---|---|---|---|---|
| `abates` | `pvp.kills` | Abates | abates | plugin | counter | 1 | `season` | 10 |
| `mortes` | `pvp.deaths` | Mortes | mortes | plugin | counter | 1 | `season` | 20 |
| `kd` | `pvp.kd` | K/D | — | computed | ratio | 1 | `season` | 30 |
| `tempo-online` | `time.played` | Tempo online | segundos | agent | counter | 1 | `lifetime` | 40 |
| `tiro-longo` | `shot.distance` | Tiro mais longo | metros | plugin | record | 1 | `wipe` | 50 |
| `minerio` | `ore.total` | Minério | unidades | plugin | counter | **0** | `wipe` | 60 |
| `minerio-enxofre` | `ore.sulfur` | Enxofre | unidades | plugin | counter | **0** | `wipe` | 61 |
| `minerio-metal` | `ore.metal` | Metal | unidades | plugin | counter | **0** | `wipe` | 62 |
| `minerio-pedra` | `ore.stone` | Pedra | unidades | plugin | counter | **0** | `wipe` | 63 |
| `minerio-hqm` | `ore.hqm` | Metal puro | unidades | plugin | counter | **0** | `wipe` | 64 |
| `explosivo` | `explosive.seq` | Poder de raid | enxofre eq. | plugin | counter | **0** | `wipe` | 70 |

Todos com `builtin = 1`.

**A `window` semeada é um padrão defensável, não uma decisão irreversível** — o
admin muda cada uma pelo painel. O critério do padrão:

- **farm zera com o mundo** (`wipe`). O minério daquele mapa não significa nada
  no mapa seguinte, e um ranking de minério que atravessa wipes vira o ranking
  de quem joga há mais tempo;
- **PvP atravessa o wipe** (`season`). A perícia do jogador não zerou porque o
  mapa zerou, e é aí que mora a premiação;
- **tempo online é de sempre** (`lifetime`). É a única métrica que só faz sentido
  acumulada — "jogador desde" é a informação;
- **o tiro mais longo é do mapa** (`wipe`). O recorde é uma história com lugar:
  *"412 m no G12 daquele mapa"*. Carregá-lo para o mapa seguinte tira dele o
  que o torna interessante.

**O Troféu Bleik e os demais dinâmicos nascem em `season`** — é a janela da
premiação, e é o que o documento do troféu pede.

**O que NÃO é semeado:** o Troféu Bleik. Ele é o primeiro ranking dinâmico, e o
dono o cria pelo painel — é justamente essa a demonstração de que o sistema
funciona sem código novo.

**Três notas sobre a tabela:**

1. **`pvp.kd` é `computed`** — não existe linha `pvp.kd` em `player_stats`. Ele é
   calculado na leitura, de `pvp.kills` e `pvp.deaths`, com o encolhimento e o
   corte de amostra do `19-PESQUISA §6.3`. Guardar um K/D somado seria guardar
   uma divisão de duas coisas que ainda vão mudar.
2. **`ore.total` é somado pelo plugin**, não pela API. O plugin já tem os quatro
   números na mão; somá-los na leitura obrigaria quatro consultas e uma soma que
   o SQL não faz bem neste formato (§2.2).
3. **`time.played` tem uma armadilha própria**, e ela está no §8.4.

---

## 5 — As janelas, e como um período fecha

### 5.1 Os três papéis

| `kind` | Abre | Fecha | Para que serve |
|---|---|---|---|
| `wipe` | quando um mundo novo é detectado | no mundo seguinte | a disputa da semana |
| `season` | conforme `season_mode` | idem | **a temporada premiada** |
| `lifetime` | na primeira coleta | nunca | "de sempre", na ficha do jogador |

Os três coexistem: um mesmo abate soma nos três períodos abertos daquele
servidor. Não há dedupe entre eles — são três contagens da mesma coisa em
janelas diferentes, e é isso que se quer.

### 5.2 Quando o `wipe` vira

A âncora é `wipes.save_created_at`, que vem do **servidor** e não do agente
(`core/src/game/wipe.ts:1-33`).

> **⚠️ A lacuna medida, e que esta frente precisa fechar.** `wipesRepository.record()`
> é chamado em **um único lugar** — `core/src/wipe/run.ts:1197`, o passo `#posWipe`.
> Um wipe feito **à mão**, com o agente rodando, **não cria linha em `wipes`** até
> a próxima execução de wipe passar por ali. Se o fechamento de período confiar só
> nisso, um wipe manual não fecha temporada nenhuma.
>
> **O conserto:** o mesmo sweep de 60 s do coletor (§6.4) compara
> `wipeClock.at(serverId, rcon)` com `wipesRepository.latest(serverId).saveCreatedAt`
> e grava a linha quando divergirem. O `WipeClock` já cacheia por 30 min, então o
> custo por rodada é próximo de zero. Isso **melhora o registro de wipes do projeto
> inteiro**, não só o ranking.

### 5.3 Quando a `season` vira

```
season_mode    a virada acontece quando…
─────────────  ─────────────────────────────────────────────────
wipe           um mundo novo é detectado (mesma âncora do §5.2)
biweekly       agora >= anchor + 15 dias
days           agora >= anchor + season_days dias
monthly        o mês local mudou desde started_at
quarterly      o trimestre local mudou desde started_at
manual         nunca sozinho; só por POST /api/rankings/periods/:id/close
```

**Fuso.** `monthly` e `quarterly` viram pela **hora local da máquina do agente**,
que é a mesma régua que o agendador de mensagens já usa. Não invente `TZ` nova:
um ranking que vira às 21h do dia 31 porque alguém pensou em UTC é um bug que
ninguém consegue explicar ao jogador.

**A âncora.** `biweekly` e `days` contam a partir de `season_anchor_at`; se ele
for `NULL`, a âncora é o `started_at` do período aberto. Trocar o modo **não
reabre** o período em curso — ele termina como estava e o modo novo vale para o
seguinte. É a mesma regra do `season_mode` gravado em `stat_periods` (§2.1).

**E há um segundo gatilho, independente do modo:** o wipe. Quando um mundo novo
é detectado (§5.2), a temporada **também** vira se

```
wipe_runs.open_ranking_season  (daquela execução, se houver)
  ?? ranking_settings.season_on_wipe
```

for verdadeiro. A execução manda; a configuração é o padrão; `NULL` na execução
significa "não decidi", e não "não" (§3.4).

> **Isto vale para o wipe feito à mão**, e é o ponto que faz o desenho valer a
> pena. Um wipe manual não tem `wipe_runs` — então cai direto na configuração do
> servidor, e a temporada vira do mesmo jeito. A âncora é o mundo, não o painel.

**Uma virada por mundo, e o banco garante.** Se o wipe abre temporada e o
calendário a venceria no mesmo minuto, ela vira **uma vez só**: o índice único
parcial `idx_stat_periods_open` recusa o segundo aberto, e o código trata isso
como "já virou", não como erro.

### 5.3.1 O que zera, e o que não zera

Este é o parágrafo que responde ao pedido do dono — *"escolhe o que vai zerar no
ranking"*.

| Vira o… | Zeram os rankings com `window` = | Continuam |
|---|---|---|
| **wipe** | `wipe` | `season`, `lifetime` |
| **temporada** | `season` | `wipe` (já zerou no mundo), `lifetime` |
| nada | — | todos |

**Zerar aqui não é apagar.** Os três períodos continuam abertos e recebendo todo
evento; o que muda é **qual deles a tela abre** para aquele ranking. O número
antigo não some — ele fica no período fechado, congelado no pódio (§5.4) e
consultável pelo histórico. É por isso que "zerar o ranking" nunca precisa de um
`DELETE`.

### 5.4 O que acontece na virada, em ordem

```
1. BEGIN
2. congela o pódio: para cada ranking habilitado, o top
   `snapshot_size` do período que está fechando entra em
   ranking_snapshots, com o nome do jogador copiado
3. stat_periods.ended_at = agora
4. abre o período seguinte (mesmo server_id, mesmo kind,
   season_mode atual, label calculado)
5. COMMIT
```

**Uma transação só.** Fechar sem abrir deixaria o servidor sem período aberto, e
o próximo lote chegaria sem onde somar — que é perder dado por causa de uma
falha de escrita. O índice único parcial `idx_stat_periods_open` garante que o
passo 4 nunca produz dois abertos.

**O `lifetime` não participa.** Ele nunca fecha e nunca congela.

---

## 6 — O contrato do lote: `origemz.stats.flush` / `ack`

> **O molde é o `origemz.bp.export`** (`Plugins/OrigemZAgent.cs:3632-3762`), e o
> consumidor a copiar é `fetchBpPage` + o laço de redução em
> `core/src/wipe/blueprints.ts:255-436`. Não invente forma nova: aquele desenho
> já pagou os erros.

### 6.1 O comando

```
origemz.stats.flush [offset] [limit]
```

Resposta de sucesso, **uma linha só**, sem indentação:

```json
{"ok":true,"contract":1,"batchId":"pvp1-1757088123-41","seq":41,
 "count":312,"offset":0,"limit":100,
 "players":[{"steamId":"7656…","name":"Fulano",
             "metrics":{"ore.sulfur":1200,"pvp.kills":3,"time.played":0}}],
 "records":[{"steamId":"7656…","metric":"shot.distance","value":412.73,
             "at":1757088100,"detail":{"weapon":"rifle.bolt","headshot":true,
             "victim":"7656…","grid":"G12"}}],
 "events":[{"eventId":"7656…-1757088123-4","steamId":"7656…","name":"Fulano",
            "metric":"trophy.bleik","amount":3,"source":"item:trofeu-bleik",
            "at":1757088123}]}
```

Erro:

```json
{"ok":false,"error":"PAYLOAD_TOO_LARGE"}
```

Códigos de erro do plugin: `INVALID_ARGS`, `PAYLOAD_TOO_LARGE`, `INTERNAL`,
`NO_BATCH` (ack de lote que não existe).

### 6.2 As seis regras da resposta, copiadas do `bp.export`

1. **`count` é o TOTAL**, não o tamanho da página.
2. **`offset` e `limit` voltam normalizados** — quem pede 5 000 recebe 100 e
   **vê** isso na resposta.
3. **Página menor que o `limit` não é fim de lista.** Quem avança é
   `offset += page.limit` (o `limit` que **voltou**), e o fim é `offset >= count`.
4. **Teto de bytes por resposta: 60 000.** Estourou, recusa **inteira** com
   `PAYLOAD_TOO_LARGE` — nunca meia resposta. O agente reduz o `limit` pela
   metade e pede de novo, sem avançar o `offset`; abandona o ciclo se chegar a
   `limit = 1` e ainda não couber.
5. **Uma linha só**, achada por `firstJsonLine` (`plugin-contract.ts:333`).
6. **`contract: 1`** na resposta. O agente recusa o que não entende com
   `PLUGIN_INVALID_RESPONSE`, nunca com lista vazia.

### 6.3 O lote congela — e é isso que impede o buraco

**A armadilha que este parágrafo evita:** se o plugin continuasse acumulando
enquanto o agente pagina, a página 2 seria de um conjunto diferente da página 1,
e o `count` mentiria. Jogadores entrariam e sairiam do meio da lista.

```
flush offset=0  ─► o plugin FECHA o buffer atual como "lote pendente"
                   (batchId, seq) e abre um buffer novo para os
                   golpes que continuam chegando

flush offset=100 ─► lê o MESMO lote pendente

ack <batchId>   ─► descarta o lote pendente. SÓ AQUI.

flush offset=0 com um lote pendente ainda não confirmado
                ─► devolve o MESMO lote, com o MESMO batchId.
                   É o que faz uma queda de RCON no meio do ciclo
                   não custar nada.
```

**`seq`** cresce a cada lote novo e serve para o log do agente perceber buraco
("recebi o 41 e o 43"). Ele **não** é usado para ordenar nem para descartar.

### 6.4 O ciclo do agente

Um relógio de **60 s**, no molde do `OxideRuntimeMonitor`
(`core/src/oxide/runtime.ts:177-317`): `#timer` + `#running`, `start()`
idempotente com `unref()` e uma primeira rodada no boot, `stop()` limpando o
timer, `sweep()` que **nunca lança** e itera servidor a servidor com try/catch
por servidor.

Por rodada, e nesta ordem:

```
1. o servidor tem RCON e o OrigemZAgent está carregado?  (§9.4, coverage)
      não → registra e passa ao próximo. NÃO é erro.
2. o mundo mudou?  (§5.2)  → grava em `wipes`, fecha e abre períodos
3. o período `season` venceu?  (§5.3)  → fecha e abre
4. soma o tempo online do intervalo  (§8.4)
5. pagina o `origemz.stats.flush` até o fim
6. aplica tudo numa transação só
7. `origemz.stats.ack <batchId>`
```

**O `ack` vem depois do `COMMIT`, sempre.** Confirmar antes de gravar troca uma
duplicata inofensiva por uma perda silenciosa.

---

## 7 — O contrato do evento: `#OZSTAT#`

### 7.1 Por que existe, se já há o lote

O lote roda a cada 60 s. Um jogador que pega o Troféu Bleik precisa ver o
recibo **agora** — esperar um minuto para o número mudar faz o prêmio parecer
quebrado. O push dá o *agora*; o lote dá o *garantido*.

Os dois carregam o mesmo `eventId`, e o agente ignora o que já viu (§2.4).

### 7.2 A forma

Uma linha no console do servidor, marcador colado no JSON:

```
#OZSTAT#{"contract":1,"kind":"points","eventId":"7656…-1757088123-4","steamId":"7656…","name":"Fulano","metric":"trophy.bleik","amount":3,"source":"item:trofeu-bleik","at":1757088123}
```

| Campo | Tipo | Por que existe |
|---|---|---|
| `contract` | int | o agente recusa o que não entende |
| `kind` | string | `points` \| `record`. O canal serve os dois |
| `eventId` | string | **a chave da idempotência.** Sem ela, o reenvio da fila dobra o ponto |
| `steamId` | string | a identidade que sobrevive ao wipe |
| `name` | string | só para o log e o anúncio; **nunca** é chave |
| `metric` | string | `familia.nome`, minúsculas |
| `amount` | int | ≥ 1, **já multiplicado** pelos pontos por unidade |
| `source` | string | a procedência (§2.4) |
| `at` | int | epoch **em segundos**, relógio do servidor de jogo |

Para `kind: "record"`, troque `amount` por `value` (número real) e acrescente
`detail` (objeto livre).

### 7.3 O lado do agente

O marcador entra em `core/src/index.ts:320`, junto do `uiSync.handleLine`. O
molde exato é o `UiSync` (`core/src/game/ui-sync.ts:411-440`): triagem barata
por `line.includes(...)`, `line.slice(at + marker.length).trim()`, `JSON.parse`,
zod, ação. **A função nunca lança** — o contrato de `servers/context.ts:51-65`
é explícito, e uma exceção ali derruba o processamento de console do servidor
inteiro.

> **⚠️ E há um laço a evitar, já vivido neste projeto** (`index.ts:309-319`):
> este gancho recebe **toda** linha de console. Qualquer coisa que imprima no
> console a partir dele volta pelo mesmo caminho e dispara de novo. Aplicar o
> evento é escrita em SQLite — não mande comando de RCON daqui.

### 7.4 A armadilha do `Puts` dentro de hook

**Medida neste projeto**, em `Plugins/OrigemZPlayer.cs:463-484`: um `Puts` dentro
de um hook *disparado por comando* sai com o mesmo Identifier do comando e vira
**a resposta daquele comando**.

O caminho que ativa isso aqui é direto: `origemz.give` → o item entra no
inventário → o hook converte → `Puts("#OZSTAT#…")`. Sem adiamento, **o `give`
morre com `PLUGIN_INVALID_RESPONSE` e o ponto nunca chega**.

```csharp
// NAO E ESTILO: e a correcao de um bug ja medido neste projeto.
// Ver OrigemZPlayer.cs:463-484.
timer.Once(0f, () => Puts(EventMarker + json));
```

---

## 8 — O caminho de escrita, inteiro

### 8.1 O lote

```
flush → zod (contract === 1?) → batchId já em stat_batches?
                                  sim → IGNORA, loga em debug, dá ack de novo
                                  não → BEGIN
                                         garante os jogadores em `players`
                                         UPSERT player_stats (value = value + delta)
                                         INSERT player_records (se bate o recorde)
                                         eventos: INSERT OR IGNORE stat_events
                                                  os que entraram somam em player_stats
                                         INSERT stat_batches
                                        COMMIT
                              → ack
```

**Uma transação por lote, não por jogador.** O SQLite com WAL faz isso em
milissegundos; mil transações separadas fariam disso um problema.

### 8.2 O push

```
#OZSTAT# → zod → INSERT OR IGNORE stat_events
                   0 linhas → já vi. Fim, sem log de erro.
                   1 linha  → soma em player_stats, no período aberto
```

O `INSERT OR IGNORE` **é** o teste de duplicata. Consultar antes e inserir depois
abriria uma corrida entre o push e o lote que chega no mesmo instante.

### 8.3 O que se perde em cada falha

| Falha | O que se perde | Por quê |
|---|---|---|
| Agente reinicia | nada | o plugin segura até o `ack` |
| RCON cai | nada | idem |
| `oxide.reload` | os segundos desde o último snapshot do buffer | buffer volátil por natureza |
| Servidor cai duro | idem | idem |
| Plugin desativado num servidor | tudo daquele servidor — **e isso precisa aparecer na tela** | "sem dados" ≠ "zero" |
| Item convertido com o RCON fora | **nada**, se a fila do plugin gravou antes de destruir | §13.3 |

### 8.4 A armadilha do tempo online

`player_servers.played_seconds` é **acumulado desde sempre**, por servidor. Ele
não sabe o que é período. Copiar o valor para `player_stats` daria o total de
sempre em toda temporada.

**O que fazer:** o coletor guarda o `played_seconds` lido na rodada anterior (em
memória, por servidor e jogador) e soma **a diferença** na métrica `time.played`
do período aberto.

**As três bordas que isso tem, e as três respostas:**

| Situação | O delta seria | O certo |
|---|---|---|
| primeira rodada depois de o agente subir | o total de sempre | **soma zero**; a rodada só semeia a marca d'água |
| `played_seconds` diminuiu (base recriada, jogador removido) | negativo | **soma zero** e regrava a marca |
| período fechou entre duas rodadas | o delta cairia todo no período novo | aceitável e declarado: o erro máximo é uma rodada de 60 s |

> Não guarde a marca d'água em tabela. Ela é estado de processo, vale 60 s, e
> uma tabela para ela seria uma segunda verdade sobre um número que já existe em
> `player_servers`.

---

## 9 — A API

Padrão do `06-API.md`: tudo sob `/api`, paginado desde a primeira versão, erro
com código em `SCREAMING_SNAKE` e frase em português nascida no módulo da regra.
O molde de arquivo é `core/src/http/routes/custom-items.ts`; o de paginação é
`core/src/http/routes/players.ts:50-79`.

### 9.1 As rotas

**Leitura — é o que o site consome (§12).**

```
GET /api/rankings/metrics
    o catálogo: id, metric, label, unit, description, source,
    valueKind, direction, globalEligible, builtin, enabled

GET /api/rankings?metric=&scope=server|global&serverId=&period=wipe|season|lifetime
                 &periodId=&limit=&offset=
    a lista, paginada. `periodId` sobrepõe `period` e é como se lê
    uma temporada FECHADA (aí a fonte é ranking_snapshots)

GET /api/rankings/records?metric=shot.distance&scope=&serverId=&period=&limit=
    os recordes, com o testemunho

GET /api/rankings/periods?serverId=&kind=&limit=&offset=
    o HISTÓRICO: os períodos, abertos e fechados, do mais novo ao
    mais velho

GET /api/rankings/periods/:id
    um período e o pódio congelado dele

GET /api/players/:steamId/rankings
    as posições DELE: por métrica, por escopo, com total e colocação

GET /api/rankings/audit?serverId=&metric=&from=&to=
    a conta do §2.4: eventos por dia, por fonte
```

**Configuração e ação — painel, exige sessão e CSRF.**

```
POST   /api/rankings/metrics            cria um ranking dinâmico. 201
PUT    /api/rankings/metrics/:id        edita
DELETE /api/rankings/metrics/:id        apaga

GET    /api/rankings/settings?serverId= a janela
PUT    /api/rankings/settings/:serverId configura a janela

POST   /api/rankings/periods/:id/close  fecha à mão. 200

POST   /api/servers/:id/rankings/season { label?, reason }
                                        fecha a temporada aberta e abre a
                                        seguinte, numa transação só. É o botão
                                        "abrir temporada nova agora" do §5.4.
                                        Idempotente por período: fechar a mesma
                                        duas vezes devolve RANKING_PERIOD_CLOSED,
                                        e NÃO abre uma terceira

POST   /api/servers/:id/rankings/flush  força um ciclo agora. 202
POST   /api/rankings/:steamId/reset     { metric?, periodId?, reason } — zera,
                                        com autor, e grava em stat_adjustments
```

### 9.2 Os três campos que toda resposta de lista carrega

| Campo | Para quê |
|---|---|
| `measuredSince` | desde quando aquilo é medido. Sem ele, um ranking que começou ontem parece um ranking de sempre |
| `coverage` | quais servidores do escopo tinham coleta ativa no período |
| `updatedAt` | do último lote aplicado |

**`coverage` não é um booleano.** O vocabulário já existe neste projeto, em
`core/src/game/players.ts:327-339`, e deve ser reusado:

```ts
coverage: {
  servers: [
    { serverId: 'pvp1', status: 'ok',         lastBatchAt: 1757088123 },
    { serverId: 'pvp2', status: 'not-loaded', lastBatchAt: null },
    { serverId: 'farm3', status: 'no-answer', lastBatchAt: 1757001000 },
  ],
}
```

- `ok` — o plugin respondeu na última rodada;
- `not-loaded` — o Oxide confirmou que o plugin não está carregado;
- `no-answer` — mandamos e ninguém respondeu.

A fonte dos dois últimos é o tripé já existente: `library.serverList()` (o `.cs`
está ligado?) + `oxideRuntime.pluginOf()` (o Oxide carregou?) + o resultado do
último `flush`.

### 9.3 As regras de ordenação, e por que a terceira existe

Ordem de desempate, fixa, nas três consultas de lista:

1. o **valor**, na `direction` do ranking;
2. **quem chegou primeiro** àquele valor — `updated_at` ascendente;
3. **`steam_id`** ascendente.

> **O terceiro critério não é preciosismo.** Sem ele, dois jogadores empatados
> trocam de lugar entre a página 1 e a página 2, e um deles **some da lista**. É
> o defeito clássico de paginação sem ordem total, e ele só aparece em produção.

### 9.4 Os códigos de erro novos

| Código | HTTP | Quando |
|---|---|---|
| `RANKING_NOT_FOUND` | 404 | ranking (definição) inexistente |
| `RANKING_METRIC_UNKNOWN` | 400 | métrica fora do catálogo |
| `RANKING_METRIC_TAKEN` | 409 | já existe ranking com aquela métrica |
| `RANKING_BUILTIN_LOCKED` | 409 | tentativa de apagar um `builtin` |
| `RANKING_IN_USE` | 409 | apagar um ranking para o qual um item custom aponta |
| `RANKING_PERIOD_NOT_FOUND` | 404 | período inexistente, ou de outro servidor |
| `RANKING_PERIOD_CLOSED` | 409 | fechar um período já fechado |
| `RANKING_NOT_MEASURED` | 409 | o escopo pedido nunca teve coleta ativa |
| `RANKING_SCOPE_INVALID` | 400 | `scope=global` numa métrica com `global_eligible = 0` |

`PLUGIN_INVALID_RESPONSE` (502) já existe e cobre o `flush` fora do contrato.

Acrescente todos à tabela de `Docs/06-API.md:38-97`.

---

## 10 — O painel

Aba **Ranking** na barra lateral (rede) e sub-aba no servidor.

- entrada em `panel/src/components/sidebar.tsx:61-147`, com barra no fim do
  `href` (`/ranking/`) por causa do `trailingSlash`;
- página em `panel/src/app/ranking/page.tsx`, copiando a forma de
  `panel/src/app/jogadores/page.tsx` — que é o exemplo canônico de tabela
  paginada com busca, filtro, os três `StateBlock` (erro/carregando/vazio) e o
  pager;
- sub-aba do servidor: `panel/src/app/servidor/page.tsx:44,68,266`.

**Quatro telas:**

1. **A lista** — seletor de ranking, escopo (rede / servidor), janela (wipe /
   temporada / de sempre), e o seletor de **temporada fechada** para o histórico.
   `measuredSince` e `coverage` **na tela**, não em tooltip.
2. **O histórico** — as temporadas fechadas, com o pódio congelado de cada uma.
3. **Os rankings** — criar, editar, ligar e desligar os dinâmicos, **e escolher a
   `window` de cada um** (§3.1). Os `builtin` aparecem com o botão de apagar
   ausente, não desabilitado — mas a `window` deles **é editável**, porque é
   configuração, não definição.
4. **A janela** — na aba do servidor: `season_mode`, `season_days`,
   `season_on_wipe`, `snapshot_size`, **quando a temporada atual vira**, e o
   botão "fechar e abrir nova agora".

**E uma caixa na tela de wipe** (`panel/src/app/servidor/`, na execução de wipe):
*"abrir temporada nova do ranking"*, em três estados — herdar a configuração do
servidor, forçar sim, forçar não. Ao lado dela, **a lista do que vai zerar**,
lida de `rankings.window`:

> Vão zerar neste wipe: Minério, Enxofre, Metal, Pedra, Metal puro, Poder de
> raid, Tiro mais longo.
> Continuam: Abates, Mortes, K/D, Tempo online, Troféu Bleik Store.

Mostrar, e não perguntar de novo (§3.4).

**Regras da casa que valem aqui:**

- **ausente vira travessão, nunca zero** — `panel/src/lib/format.ts`,
  `formatInteger` para valores, `formatWhen` para `measuredSince`;
- **paginado desde a primeira versão**;
- os tipos moram em `panel/src/lib/api.ts` (o painel duplica à mão os tipos do
  core, de propósito — não há pacote compartilhado).

**E uma dívida a quitar:** `RANKING_METRICS` em
`panel/src/components/custom-item-dialog.tsx:187` é um esboço com um comentário
dizendo que sai quando o ranking chegar. **Ele sai**, e o `<select>` passa a ler
`GET /api/rankings/metrics`.

---

## 11 — A tela do jogo

O botão **RANKING** já existe no menu (`core/src/game/ui-preset-main-menu.ts:320`,
hoje com a dica *"O ranking de jogadores entra aqui."*).

**O plugin não muda.** O `OrigemZUI.cs` é genérico: ele guarda o documento,
pede a tela que não tem em cache com `#OZUIREQ#` e desenha o que voltar. Uma
tela nova é um provedor **no agente**.

- arquivo novo: `core/src/game/ui-ranking-screen.ts`, no molde de
  `ui-kits-screen.ts` (que é o que tem sub-abas de verdade);
- endereço: `tela-ranking:<ranking>:<pagina>` — as abas **não guardam estado**,
  elas navegam (`ui-widgets.ts:284-293`);
- sub-abas com `tabsRow` (`ui-widgets.ts:295`); **a aba ativa vira `panel`, não
  `button`** — um botão que navega para onde já se está parece defeito;
- despacho em `core/src/index.ts:960-1017`, junto de loja/kits/calendário. Quem
  reconhece **família de endereços** vem antes de quem reconhece id exato.

**O que cabe na tela:**

- **top 10**, não top 100 — o teto do documento é 50 000 bytes
  (`core/src/types/ui-transport.ts:534`) e a carga inicial do menu já é apertada;
- **a linha do próprio jogador, sempre**, mesmo fora do top: é a única
  informação que ele foi ver;
- **abas por ranking**, lidas de `rankings` com `enabled = 1`, na `sort_order`;
- **paginação**, não rolagem — o `ScrollView` do CUI derruba o cliente;
- **o recorte acontece antes do desenho.** O que o jogador não pode ver **não
  atravessa o RCON** (`ui-calendar-screen.ts:24-36`).

---

## 12 — O site

**O site puxa; o agente não empurra.** É o que o dono pediu — *"endpoint para o
site pegar os ranking"* — e é o caminho mais barato: as rotas do §9.1 já
respondem a `Authorization: Bearer <AGENT_API_TOKEN>` **sem CSRF**
(`core/src/http/auth.ts:77-80`), que é exatamente o caso de uso "integração"
declarado ali.

Isso é o **contrário** do que a integração OZCoin faz (lá o agente é o cliente
HTTP do site, com espelhos de push em `core/src/vip/site-mirror.ts`). A
diferença é deliberada: ranking é leitura frequente de dado que muda devagar, e
espelhar seria manter uma segunda cópia para responder a mesma pergunta.

**O que o site precisa saber**, e que deve entrar num documento para o agente do
site quando esta frente terminar:

- as três rotas de leitura (`/metrics`, `/rankings`, `/periods`);
- que `measuredSince` e `coverage` **precisam aparecer na página** — um ranking
  premiado que não diz desde quando mede é um ranking que vai ser contestado;
- que a temporada fechada é lida por `periodId`, e o valor de lá é **congelado**:
  ele não muda mais, e pode ser cacheado sem prazo.

---

## 13 — O buraco que a medição encontrou: o item custom nunca chega ao plugin

> Isto não estava em documento nenhum, e sem ele o Troféu Bleik não funciona.

### 13.1 O que foi medido

O plugin `OrigemZItems.cs` pede a lista de itens no boot:

```csharp
// OrigemZItems.cs:269-272
Puts("#OZAREQ#" + "items");
```

**Ninguém escuta.** O único consumidor de linha de console no agente é o
`uiSync.handleLine` (`core/src/index.ts:320-322`), que reconhece `#OZUIREQ#`,
`#OZBUY#` e `#OZBAL#`. E nenhuma linha de TypeScript envia `origemz.item.set`.

Ou seja: **o cadastro de item custom existe no banco, aparece no painel, e nunca
atravessa para o servidor de jogo.**

### 13.2 O que falta

Um `core/src/game/custom-items-sync.ts`, no molde dos `sync` que já rodam no
gancho `rcon-connected` (`core/src/index.ts:295-301`):

1. ao conectar o RCON e ao mudar o cadastro: `origemz.item.clear`, depois um
   `origemz.item.set <json>` por item de `repository.listForServer(serverId)`;
2. no `onConsoleLine`: reconhecer `#OZAREQ#items` e responder com a mesma
   sequência — é o pedido que o plugin faz quando um `oxide.reload` esvaziou o
   cache dele;
3. o JSON precisa passar a carregar `consumeOnPickup` e o bloco `points`
   (`metric`, `perUnit`), que hoje o `ParseItem` (`OrigemZItems.cs:1677`) e o
   `ParseAction` (`:1729`) ignoram.

### 13.3 A ordem de escrita no plugin, que não é a intuitiva

Quando o item é convertido em ponto:

```csharp
// A ORDEM IMPORTA, e ela nao e a intuitiva.
//
// Destruir o item primeiro e emitir depois parece mais limpo,
// mas abre uma janela em que o trofeu nao existe como item NEM
// como ponto: o jogador perde a conquista e ninguem fica
// sabendo - nem ele, nem o log.
//
// Gravar na fila ANTES da destruicao troca esse risco por outro
// muito menor: uma queda entre a fila e a destruicao faz o
// trofeu ser contado com o item ainda na mao. Um item orfao e
// visivel; um ponto perdido nao e.
_queue.Add(record);      // 1. persiste  (data file do Oxide)
SaveQueue();             // 2. grava em disco
item.Remove();           // 3. destroi   <- irreversivel
EmitStatEvent(record);   // 4. tenta o push (pode falhar sem dano)
```

> **Isto contraria a regra atual do `OrigemZItems.cs`** (cabeçalho `:9-15`: o
> estado é cópia de trabalho em memória, descartável). A contradição é
> deliberada e vale para **esta fila apenas**: o cadastro continua descartável,
> porque o agente o remanda; a fila de conversões **não pode** ser descartável,
> porque o item que a originou já não existe. Escreva isso no cabeçalho, junto
> da regra que ela excetua.

### 13.4 Os quatro portões de entrada, e a regra única que os cobre

Um item chega às mãos de um jogador por caminhos diferentes: nascendo no
inventário pelo `origemz.give`, sendo tirado de uma caixa de loot, sendo pego do
chão, ou vindo de outro jogador.

**A regra que cobre os quatro:** *converte quando, e somente quando, o item
passa a estar num container cujo dono é um `BasePlayer` real, não NPC.*

```csharp
private void OnItemAddedToContainer(ItemContainer container, Item item)
{
    if (item == null || item.info == null) return;

    CustomMark mark = MarkOf(item);
    if (mark == null || !mark.ConsumeOnPickup) return;

    BasePlayer owner = container.playerOwner;
    if (owner == null || owner.IsNpc) return;

    // O amount e lido AGORA: depois do NextTick o item pode ter
    // sido movido, e ler la daria a quantidade errada.
    int amount = item.amount;

    // Converter DENTRO deste hook mexe no container que o jogo
    // esta percorrendo neste instante. Um NextTick custa ~16 ms
    // e evita o comportamento indefinido.
    NextTick(() => ConvertToPoints(owner, item, mark, amount));
}
```

---

## 14 — As frentes, e o que cada uma entrega

```
  ┌──────────────────────────────────────────────────────────┐
  │  F1  fundação: migrações 033/034, repositório, períodos  │  bloqueia tudo
  └──────────────────────────────────────────────────────────┘
                │
      ┌─────────┼─────────────────────┐
      ▼         ▼                     ▼
  ┌───────┐ ┌──────────────┐ ┌──────────────────┐
  │F2 API │ │F3 coleta     │ │F4 item → ponto   │
  │       │ │  plugin↔ag.  │ │  (§13)           │
  └───────┘ └──────────────┘ └──────────────────┘
      │            │                  │
      └────────────┴──────┬───────────┘
                          ▼
              ┌───────────────────────┐
              │F5 painel   F6 tela do │
              │            jogo       │
              └───────────────────────┘
```

| # | Frente | Território | Pronta quando |
|---|---|---|---|
| **F1** | fundação | `db/migrations.ts`, `db/rankings-repository.ts`, `rankings/*` | as migrações rodam, o repositório soma um lote em transação e o período fecha congelando o pódio — tudo com teste |
| **F2** | API | `http/routes/rankings.ts`, `http/server.ts`, `Docs/06-API.md` | as rotas do §9 respondem, com `coverage`, `measuredSince` e desempate estável entre páginas |
| **F3** | coleta | `game/stats-contract.ts`, `rankings/collector.ts`, `index.ts`, `wipe/run.ts`, `Plugins/OrigemZAgent.cs`, `Plugins/OrigemZPlayer.cs` | minerar move o número em ≤ 60 s; derrubar o RCON no meio de um ciclo **não perde** o lote; um abate conta uma vez só; **um wipe — do painel ou à mão — abre a temporada quando a configuração manda, e uma vez só** |
| **F4** | item → ponto | `game/custom-items-sync.ts`, `Plugins/OrigemZItems.cs` | criar o ranking no painel, criar o item apontando para ele, dar 3 pelo painel ⇒ **3 pontos, uma vez só**, com recibo no chat |
| **F5** | painel | `panel/` | a aba mostra a lista, o histórico, e o cadastro de ranking dinâmico; `RANKING_METRICS` some |
| **F6** | tela do jogo | `game/ui-ranking-screen.ts`, `index.ts` | `/menu` → RANKING mostra top 10 com abas por ranking e a linha do próprio jogador |

**A ordem não é negociável em F1.** As outras cinco dependem do esquema, e
começar qualquer uma antes é escrever contra um alvo que se move.

---

## 15 — As armadilhas medidas neste projeto que valem aqui

> Cada linha custou um incidente. Nenhuma delas é hipótese.

| Armadilha | Onde foi medida | O que fazer |
|---|---|---|
| `Puts` em hook disparado por comando **vira a resposta do comando** | `OrigemZPlayer.cs:463-484` | `timer.Once(0f, …)` sempre |
| Argumento não-numérico lido como 0 vira "primeira página" em silêncio | `OrigemZAgent.cs:693-712` | `TryReadInt` com recusa explícita |
| Página menor que o `limit` **não** é fim de lista | `OrigemZAgent.cs:3613-3621` | avance por `page.limit`, pare por `count` |
| Payload que estoura o frame recusa **inteiro**, nunca pela metade | `OrigemZAgent.cs:3738-3762` | `PAYLOAD_TOO_LARGE` + redução de janela no agente |
| O parser de console do Rust **come aspas** de token citado | `plugin-push.ts:26-41` | base64 em tudo que for payload empurrado |
| Gancho de console que imprime no console **entra em laço** | `index.ts:309-319` | nunca mande RCON de dentro do `onConsoleLine` |
| Comando inexistente **não dá erro**: só não responde | `game/players.ts:430-440` | resposta vazia ≠ resposta fora do contrato |
| "zero" e "não consegui perguntar" são respostas diferentes | `plugin-contract.ts:14-20` | `coverage` no §9.2, e `null` em vez de `[]` |
| Timeout de RCON reconhecido pelo **código**, nunca pelo texto | `game/players.ts:583-585` | `RconError.code === 'RCON_TIMEOUT'` |
| Um `oxide.reload` esvazia o cache do plugin e ninguém percebe | `OrigemZAgent.cs:174-193` | o plugin **pede** (`#OZAREQ#`); o agente **precisa responder** (§13) |
| `wipes.record` só roda dentro de uma execução de wipe | `wipe/run.ts:1197` | detector no sweep (§5.2) |
| Ordenação sem critério total **some com linha** entre páginas | — | o terceiro desempate do §9.3 |

---

## 16 — Medido, conferido, projeto

### Medido — lido no repositório em 05/09/2026

- última migração no array: **042** (`custom-items-pickup`); os ids **9, 33 e 34**
  estão vagos, e 33/34 têm reserva declarada em `migrations.ts:3367-3371`;
- `custom_items.action` é `TEXT` **sem `CHECK`**, com default `{"kind":"none"}`
  (`migrations.ts:3236`) — um `kind` novo **não pede migração**;
- a ação `points` **já existe** no zod (`http/routes/custom-items.ts:121-132`), no
  tipo do repositório (`custom-items-repository.ts:33-50`) e no painel
  (`custom-item-dialog.tsx:743-809`);
- `consume_on_pickup` existe desde a migração 042;
- **nenhuma linha de TypeScript envia `origemz.item.set`**; o `#OZAREQ#items` do
  plugin (`OrigemZItems.cs:269`) não tem consumidor (§13.1);
- `#OZPEVT#` também **não tem consumidor** no `core/` — o único leitor do canal
  `log` é o `UiSync`;
- a tela CALENDÁRIO **não usa** `tabsRow`; quem usa é KITS e LOJA;
- `wipesRepository.record()` tem **um único chamador**: `wipe/run.ts:1197`;
- teto do documento de UI: `UI_DOC_MAX_BYTES = 50_000`
  (`types/ui-transport.ts:534`); teto do `bp.export`: 60 000 bytes
  (`OrigemZAgent.cs:3565`).

### Conferido — lido da pesquisa e do documento do troféu, não re-verificado aqui

- `OnDispenserGather` dispara a cada golpe, e o volume estimado é ~33 eventos/s
  com 100 jogadores;
- o `combatlog` não funciona por RCON;
- a matriz de atribuição de abate (NPC, armadilha, queda, fome, suicídio, team
  kill, sleeper) do `19-PESQUISA §6.2`;
- o custo em enxofre equivalente derivado do blueprint do servidor
  (`19-PESQUISA §5.3`).

### Projeto — nada disto existe, e é o que vai ser construído

Tudo em `stat_*`, `rankings*` e `player_stats`/`player_records`; o
`origemz.stats.flush`/`ack`; o `#OZSTAT#`; a sincronização de itens custom; as
rotas `/api/rankings*`; a aba do painel; a tela `tela-ranking`.

### O que pode dar errado e este documento não cobre

- **a taxa de coleta por permissão** (VIP com gather maior) desloca o ranking de
  minério dentro do **mesmo** servidor, e o §12.4 da pesquisa só trata da
  diferença **entre** servidores;
- **o custo do hook de mineração em produção** não foi medido neste projeto —
  só estimado. A fatia de minério deve subir com um contador de tempo gasto no
  hook, e sair se o número surpreender;
- **o anti-abuso** (`19-PESQUISA §13`) está fora destas seis frentes. O modelo o
  suporta — `player_records.status` e `stat_adjustments` existem —, mas nenhum
  detector foi desenhado;
- **a premiação da temporada** (OZCoins, VIP, skin) é o §9 do documento do
  troféu e não entra aqui.

---

## Referências

- [`19-PESQUISA-RANKING.md`](19-PESQUISA-RANKING.md) — o porquê de cada métrica
- [`../TrofeuBleik/TROFEU_BLEIK_STORE.md`](../TrofeuBleik/TROFEU_BLEIK_STORE.md) — o troféu como métrica
- [`../CustomItem/01-PESQUISA-ITEM-CUSTOM.md`](../CustomItem/01-PESQUISA-ITEM-CUSTOM.md) — o item custom
- [`../CustomItem/03-ACAO-PONTOS-DE-RANKING.md`](../CustomItem/03-ACAO-PONTOS-DE-RANKING.md) — o contrato da ação `points`
- [`../06-API.md`](../06-API.md) — o padrão das rotas e a tabela de erros
- [`../02-ARQUITETURA.md`](../02-ARQUITETURA.md) — a proibição da segunda fonte
