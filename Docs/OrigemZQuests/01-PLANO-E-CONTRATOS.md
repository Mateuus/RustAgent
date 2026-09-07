# 01 — O ORIGEMZQUESTS: plano e contratos

> **O que este documento é.** O fechamento do formato exato de cada peça do
> sistema de quests — esquema, comando, marcador, rota, tela — para que várias
> frentes construam em paralelo sem divergir.
>
> **Regra de leitura:** quando este documento e o `Quests.cs` de referência
> discordarem, **este vale**. O `Quests.cs` é o plugin do Gonzi (v2.4.5), lido
> como pesquisa de campo: ele mostra *que perguntas um sistema de quest precisa
> responder*. Ele não roda aqui, e §2 explica por quê.

**Escrito em 06/09/2026.** Estado do repositório na hora da escrita: última
migração aplicada **045** (`items-consumable`); as ids **046** e **047** estão
livres e são reservadas por este documento.

---

## Índice

- [§0 — O pedido do dono, e as quatro decisões](#0--o-pedido-do-dono-e-as-quatro-decisões)
- [§1 — A ideia que sustenta o desenho: quest é assinatura sobre evento](#1--a-ideia-que-sustenta-o-desenho-quest-é-assinatura-sobre-evento)
- [§2 — O que o `Quests.cs` ensina, e as cinco coisas dele que não servem](#2--o-que-o-questscs-ensina-e-as-cinco-coisas-dele-que-não-servem)
- [§3 — O esquema: migração 046](#3--o-esquema-migração-046)
- [§4 — O esquema: migração 047](#4--o-esquema-migração-047)
- [§5 — Os tipos de objetivo, e de onde cada número vem](#5--os-tipos-de-objetivo-e-de-onde-cada-número-vem)
- [§6 — A recompensa, e por que ela é um plano congelado](#6--a-recompensa-e-por-que-ela-é-um-plano-congelado)
- [§7 — O ciclo de vida, estado por estado](#7--o-ciclo-de-vida-estado-por-estado)
- [§8 — O contrato agente ↔ plugin](#8--o-contrato-agente--plugin)
- [§9 — O caminho da escrita, inteiro](#9--o-caminho-da-escrita-inteiro)
- [§10 — O NPC](#10--o-npc)
- [§11 — A API](#11--a-api)
- [§12 — O painel](#12--o-painel)
- [§13 — A tela do jogo: `/quest`](#13--a-tela-do-jogo-quest)
- [§14 — O wipe do progresso](#14--o-wipe-do-progresso)
- [§15 — As frentes, e o que cada uma entrega](#15--as-frentes-e-o-que-cada-uma-entrega)
- [§16 — As armadilhas medidas neste projeto que valem aqui](#16--as-armadilhas-medidas-neste-projeto-que-valem-aqui)
- [§17 — Medido, conferido, projeto](#17--medido-conferido-projeto)

---

## 0 — O pedido do dono, e as quatro decisões

### 0.1 O pedido

Um sistema de quests **configurável inteiro pelo painel**: criar quest, editar
quest, cadastrar NPC, ver o progresso dos jogadores, zerar progresso. No jogo,
o jogador vê e joga; no painel, o admin manda.

### 0.2 As quatro decisões, tomadas em 06/09/2026

| Pergunta | Decisão | Consequência que ela cria |
|---|---|---|
| Onde a quest aparece no jogo | **Menu próprio, `/quest`** | Um segundo documento de UI (`menu-quests`), com cabeçalho e navegação próprios. O `/menu` não muda |
| Como o jogador pega uma quest | **NPC opcional por quest** | `quests.npc_id` nulo = aparece no menu para todos; preenchido = só perto daquele NPC. O sistema funciona no dia 1 sem NPC nenhum |
| O que a quest pode dar | **Item, moeda, kit e pontos de ranking** | §6. Nenhum deles é código novo: os quatro já existem e são reusados |
| Que objetivos entram | **Os quatro**: métrica coletada, loot de item, entrega A→B, tempo online | §5. Três deles já têm hook rodando; só o loot é hook novo |

### 0.3 O que a medição do terreno encontrou antes de uma linha ser escrita

Três achados, e cada um economizou uma frente inteira:

1. **O `OrigemZAgent.cs` já roda os hooks.** `OnDispenserGather` (`:4501`),
   `OnDispenserBonus` (`:4532`), `OnCollectiblePickup` (`:4567`),
   `OnPlayerDeath` (`:4835`) e `OnItemCraftFinished` (`:5558`) já existem, já
   têm medição de custo (`StatsHookStart`/`StatsHookStop`) e já emitem métricas
   normalizadas. Quest **assina o que já é contado**, não abre hook novo.

2. **O `OrigemZUI.cs` é genérico.** Um documento com `command: 'quest'` faz o
   plugin registrar `/quest` sozinho — `RegisterChatCommand`, em
   `Plugins/OrigemZUI.cs:643`, roda em cima do que veio no pacote. **A tela
   inteira do jogo não custa uma linha de C# no plugin de UI.**

3. **O botão já tem canal.** A ação `store.buy` do `uiDocumentSchema`
   (`core/src/types/ui-document.ts:177`) vira `#OZBUY#` e chega ao `onBuy` do
   agente. Os kits já pegam carona nela (o `fallback` em
   `core/src/index.ts:1258`). **Aceitar, cancelar e resgatar quest entram pelo
   mesmo canal, com `offerId` prefixado** — §13.4.

E um quarto achado, que é o único custo real: **o `HumanNPC` não existe neste
projeto.** É o que §2 e §10 tratam.

---

## 1 — A ideia que sustenta o desenho: quest é assinatura sobre evento

O ranking escolheu guardar estatística como `(metric, value)` em vez de uma
coluna por métrica, e a consequência foi que **criar um ranking deixou de ser
escrever código** (`Docs/Ranking/20-PLANO-E-CONTRATOS.md` §1).

Quest é o passo seguinte da mesma ideia. Se o evento do jogo já vira uma linha
`(steam_id, metric, delta)`, então **uma quest é uma assinatura sobre essa
linha**: um alvo, uma quantidade, e o que acontece quando a soma chega lá.

```
    o jogo acontece
          │
          ▼
   ┌─────────────────────────────────────────────────────────┐
   │  o hook do OrigemZAgent  (JÁ EXISTE, JÁ MEDIDO)         │
   │     OnPlayerDeath, OnDispenserGather, OnItemCraft…      │
   └─────────────────────────────────────────────────────────┘
          │
          ├──────────────────────────┐
          ▼                          ▼
   ┌───────────────┐        ┌──────────────────────────────┐
   │ buffer de     │        │ contador de QUEST            │
   │ métricas      │        │   só para o que alguém       │
   │ (o ranking)   │        │   está PERSEGUINDO agora     │
   └───────────────┘        └──────────────────────────────┘
          │                          │
          │ flush 60s                │ flush 60s  +  push na conclusão
          ▼                          ▼
   ┌─────────────────────────────────────────────────────────┐
   │  o AGENTE — a única autoridade                          │
   │    soma, confere have >= need, entrega a recompensa     │
   └─────────────────────────────────────────────────────────┘
```

### 1.1 As três consequências que fazem o pedido do dono caber

**Criar uma quest não é escrever código.** É uma linha em `quests`, N linhas em
`quest_objectives` e N em `quest_rewards`. A segunda quest custa zero, a
vigésima também.

**Um objetivo pode ser qualquer métrica que o ranking já conhece.** O tipo de
objetivo `metric` (§5.5) aponta direto para uma métrica do catálogo de rankings.
"Percorra 10 km", "dê o tiro mais longo de 300 m", "colete 5 Troféus Bleik" —
nenhum deles precisa de hook novo, porque o ranking já os mede.

**Quest vira fonte de ranking.** A recompensa `points` (§6.4) soma numa métrica
— a mesma ação que o item custom já tem. Um ranking "quests concluídas" é uma
linha em `rankings` apontando para `quest.completed`, e mais nada.

### 1.2 Onde o desenho difere do ranking, e por quê

O ranking tolera 60 segundos de atraso: ninguém abre a tela para ver o número
subir ao vivo. **A quest não tolera.** Concluir uma quest e não receber o recibo
na hora é o tipo de coisa que faz o jogador achar que o sistema está quebrado —
e reclamar antes do próximo lote.

Daí o desenho ser **duplo**, e é exatamente o desenho que o `stat-events.ts` já
provou neste projeto:

| | quem dá | o que garante |
|---|---|---|
| **push** `#OZQUEST#` | o "agora" | o recibo sai no instante da conclusão. Como UDP: perdeu o frame, perdeu o instante — nunca o dado |
| **flush** `origemz.quest.flush` | o "garantido" | o lote congelado com `batchId`, `ack` só depois do COMMIT. Nada se perde |

E a idempotência não é zelo: **o mesmo evento chega duas vezes de propósito**.
Quem desempata é o `eventId` gerado pelo plugin, num `INSERT OR IGNORE` — "já
vi este" é o caso NORMAL, nunca uma linha de log de alarme.

### 1.3 A autoridade é do agente, e isso não é negociável

O plugin **propõe** a conclusão; o agente **confere** com o número dele antes de
entregar qualquer coisa. Um plugin dessincronizado por um `oxide.reload` no meio
do lote, ou adulterado, não pode conceder um kit.

A regra em uma frase: **o plugin conta para a tela; o agente conta para o
prêmio.**

---

## 2 — O que o `Quests.cs` ensina, e as cinco coisas dele que não servem

O `Docs/OrigemZQuests/Quests.cs` (3 460 linhas, Gonzi, v2.4.5) foi lido inteiro.
Ele acerta o **catálogo de perguntas** que um sistema de quest precisa
responder, e é por isso que ele está no repositório:

- que tipos de objetivo existem (`QuestType`: Kill, Craft, Gather, Loot,
  Delivery — `:160`);
- que uma quest precisa de estado por jogador (`PlayerQuestInfo`: status,
  coletado, recompensa resgatada, cooldown — `:82`);
- que a recompensa pode ser item, moeda ou pontos (`RewardItem` — `:132`);
- que "tirar os itens do inventário ao entregar" é uma escolha por quest
  (`ItemDeduction` — `:97`);
- que a entrega precisa de distância e multiplicador (`DeliveryInfo` — `:111`).

**E cinco escolhas dele não servem aqui.** Não porque estejam erradas no
contexto dele, mas porque este projeto já resolveu o mesmo problema de outro
jeito, e ter dois jeitos é pior que ter o pior dos dois.

| O que o `Quests.cs` faz | Por que não serve aqui |
|---|---|
| **Depende do `HumanNPC`** (`OnUseNPC`, `:451`) | O plugin não está instalado, e não há hook de conversa no Oxide desta instalação — **conferido**: `grep` em `Oxide.Rust.dll` só devolve `OnNpcTarget`. O NPC é construído por nós (§10) |
| **Guarda tudo em arquivo JSON do Oxide** (`Interface.Oxide.DataFileSystem`, `:285`) | O painel não lê arquivo do servidor. Aqui a definição mora no SQLite do agente e desce ao plugin, como o item custom já faz |
| **Cria e edita a quest pelo CHAT, dentro do jogo** (`QuestChat`, `:494`; a região `UI Commands`, 680 linhas) | É o oposto do pedido do dono. Toda essa camada é substituída pelo painel, e é a maior economia de código do projeto |
| **Conta o loot medindo TODO item que entra em QUALQUER container** (`OnItemAddedToContainer` + o dicionário `Looters`, `:419`) | Esse hook é o mais quente do jogo. Aqui ele só entra ligado ao que alguém está perseguindo, e com o desligamento automático de §5.4 |
| **Um objetivo por quest** (`QuestEntry.Objective`, string única) | Multi-objetivo custa uma tabela e abre "mate 10 cientistas **e** colete 500 de scrap". Ver §3.2 |

> **O que o `Quests.cs` tem e nós não vamos ter no primeiro corte:** o `LustyMap`
> (marcador de mapa por plugin de terceiro), a integração `HuntRPG`/`ZLevels` e
> as animações do menu dele. Os dois primeiros não têm equivalente instalado; o
> terceiro é decisão da tela (§13).

---

## 3 — O esquema: migração 046

> **Nome:** `quests-core`. **Id:** `46`. Entra no array `MIGRATIONS` de
> `core/src/db/migrations.ts` na posição numérica, depois da `{ id: 45 }`
> (`items-consumable`).

### 3.1 `quests` — a definição

A definição é de **REDE**, como `rankings` e `kits`: uma quest cadastrada uma
vez vale em todos os servidores. O que é por servidor é o **progresso** (§3.4).

```sql
-- ----------------------------------------------------------
--  quests — o que existe para ser feito.
--
--  ####  A DEFINIÇÃO É DE REDE; O PROGRESSO É DE SERVIDOR  ####
--
--  Cadastrar "minerar 5.000 de enxofre" em cada servidor
--  produziria N quests com o mesmo nome e progressos que ninguém
--  consegue comparar. Aqui a quest é uma só, e o servidor onde
--  ela foi feita mora na linha de player_quests.
--
--  O que é POR SERVIDOR é a disponibilidade, e ela tem tabela
--  própria (3.6): uma quest de evento pode rodar só no servidor
--  do evento sem virar duas quests.
-- ----------------------------------------------------------
CREATE TABLE quests (
  -- Slug estável. É o que a URL do painel guarda, o que o site
  -- consome e o que o endereço da tela do jogo carrega.
  id TEXT PRIMARY KEY,

  title TEXT NOT NULL,

  -- O que o jogador lê antes de aceitar. Aceita a marcação de
  -- chat do projeto (game/chat-markup.ts).
  description TEXT,

  -- 'diaria', 'semanal', 'historia', 'evento', 'geral'. É TEXTO
  -- LIVRE de propósito: a categoria é uma aba na tela e um filtro
  -- no painel, e inventar uma nova não pode ser uma migração.
  category TEXT NOT NULL DEFAULT 'geral',

  -- 0 = cadastrada mas fora do ar. Apagar seria perder o
  -- progresso de quem já a fez; a mesma escolha do
  -- server_plugins.enabled da migração 002.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- A ordem na tela do jogo e no painel. Arrastável, como o
  -- catálogo de rankings (migração 044).
  sort INTEGER NOT NULL DEFAULT 0,

  -- ####  QUEM PODE VER  ####
  --
  -- NULL = todo mundo. Preenchido = uma permissão do Oxide
  -- ('origemzquests.vip') ou um tier de VIP ('vip:ouro'). A
  -- checagem é do AGENTE, na montagem da tela: o plugin não
  -- decide quem vê o quê, pela mesma razão que `applyHidden`
  -- roda no agente (game/ui-sync.ts:33-40).
  requires TEXT,

  -- ####  ONDE SE PEGA  ####
  --
  -- NULL = aparece no menu /quest para todos.
  -- Preenchido = só aparece na tela DAQUELE NPC (§10).
  --
  -- ON DELETE SET NULL e não CASCADE: apagar um NPC não pode
  -- apagar a quest e o progresso de quem já a estava fazendo. Ela
  -- volta a ser uma quest de menu, e o painel avisa.
  npc_id TEXT,

  -- ####  REPETIÇÃO  ####
  --   'once'     — uma vez na vida, por servidor
  --   'cooldown' — repete depois de cooldown_seconds
  --   'daily'    — repete na virada do dia (fuso do agente)
  --   'weekly'   — repete na virada da semana
  repeat_mode TEXT NOT NULL DEFAULT 'once'
    CHECK (repeat_mode IN ('once','cooldown','daily','weekly')),

  -- Só lido quando repeat_mode = 'cooldown'.
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,

  -- ####  A CADEIA  ####
  --
  -- A quest só aparece depois que ESTA outra foi concluída. É o
  -- que transforma quests soltas numa história.
  --
  -- Ciclo (A exige B, B exige A) é recusado NA ROTA, e não pelo
  -- banco: SQLite não tem como ver isso, e o custo de estar
  -- errado é uma quest que nunca aparece para ninguém e ninguém
  -- entende por quê.
  requires_quest TEXT REFERENCES quests(id) ON DELETE SET NULL,

  -- ####  JANELA DE EVENTO  ####
  -- Epoch em MILISSEGUNDOS, como o resto do agente. NULL nos dois
  -- = sempre disponível.
  available_from INTEGER,
  available_to   INTEGER,

  -- 1 = o jogador não precisa aceitar; ela já nasce ativa quando
  -- ele conecta. É o que faz a diária funcionar sem clique.
  auto_accept INTEGER NOT NULL DEFAULT 0 CHECK (auto_accept IN (0, 1)),

  -- ####  O QUE O WIPE FAZ COM ELA  #### (§14)
  --   'reset' — o progresso zera quando o mundo zera
  --   'keep'  — atravessa o wipe
  wipe_policy TEXT NOT NULL DEFAULT 'reset'
    CHECK (wipe_policy IN ('reset','keep')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_quests_listing ON quests (enabled, category, sort);
CREATE INDEX idx_quests_npc     ON quests (npc_id) WHERE npc_id IS NOT NULL;
```

### 3.2 `quest_objectives` — o que precisa ser feito

```sql
-- ----------------------------------------------------------
--  quest_objectives — N por quest.
--
--  ####  POR QUE MULTI-OBJETIVO, SE O Quests.cs TEM UM SÓ  ####
--
--  Porque uma tabela é o mesmo custo de uma coluna, e ela abre
--  "mate 10 cientistas E colete 500 de scrap" — que é a diferença
--  entre uma tarefa e uma MISSÃO. Um objetivo só é o caso
--  particular de N = 1, e a tela desenha os dois igual.
--
--  A quest conclui quando TODOS os objetivos fecham. "Qualquer um
--  deles" não existe no primeiro corte: ninguém pediu, e ele
--  exigiria um campo de modo que a tela teria de explicar.
-- ----------------------------------------------------------
CREATE TABLE quest_objectives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,

  -- A ordem na tela. Também é o que o plugin usa para casar o
  -- contador com o objetivo sem carregar o id do banco.
  seq INTEGER NOT NULL,

  -- ####  DE ONDE O NÚMERO VEM  ####  (§5)
  --   'kill'     — matar. target = 'scientist', 'bear', 'player'
  --   'gather'   — colher. target = shortname do recurso
  --   'craft'    — fabricar. target = shortname do item
  --   'loot'     — pegar de container/chão. target = shortname
  --   'deliver'  — levar de um NPC a outro. target = id do NPC
  --   'playtime' — tempo online, em minutos. target = NULL
  --   'metric'   — qualquer métrica do ranking. metric preenchido
  kind TEXT NOT NULL
    CHECK (kind IN ('kill','gather','craft','loot','deliver','playtime','metric')),

  -- O alvo. NULL em 'playtime' e em 'metric'.
  target TEXT,

  -- Só em kind = 'metric': a chave em player_stats. Mesmo formato
  -- do ranking: familia.nome, minúsculas.
  metric TEXT,

  -- Quantos. Sempre > 0 — um objetivo de zero conclui sozinho e a
  -- quest inteira vira um botão de recompensa grátis.
  amount INTEGER NOT NULL CHECK (amount > 0),

  -- Sobrescreve a frase montada. NULL = o agente monta
  -- ("Matar 20 cientistas") a partir de kind + target + amount,
  -- usando o nome bonito do catálogo de itens.
  label TEXT,

  -- ####  ItemDeduction, o nome dele lá  ####
  --
  -- 1 = os itens SAEM do inventário quando a quest é resgatada.
  -- Só faz sentido em 'loot' e 'gather'. Quem tira é o plugin, a
  -- mando do agente — e se não houver o que tirar, o resgate
  -- FALHA antes de a recompensa sair (§7.4).
  consume INTEGER NOT NULL DEFAULT 0 CHECK (consume IN (0, 1)),

  UNIQUE (quest_id, seq)
);

CREATE INDEX idx_quest_objectives_quest ON quest_objectives (quest_id, seq);

-- A consulta mais quente do sistema: "que objetivos vivos existem
-- para este par kind+target?" — é ela que monta o catálogo que
-- desce ao plugin (§8.2).
CREATE INDEX idx_quest_objectives_watch ON quest_objectives (kind, target);
```

### 3.3 `quest_rewards` — o que ela dá

```sql
-- ----------------------------------------------------------
--  quest_rewards — N por quest.
--
--  ####  O PAYLOAD É JSON, COMO A AÇÃO DO ITEM CUSTOM  ####
--
--  Cinco tipos de recompensa com colunas próprias dariam uma
--  tabela com quinze colunas das quais treze são NULL em toda
--  linha, e um tipo novo seria uma migração. O item custom já
--  resolveu isso com `action` em JSON validado por zod
--  (migração 041), e o padrão é o dele.
--
--  A régua é UMA e mora no zod (§6.1). O banco só garante que o
--  `kind` é conhecido.
-- ----------------------------------------------------------
CREATE TABLE quest_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,

  kind TEXT NOT NULL CHECK (kind IN ('item','coins','kit','points','vip')),

  -- O corpo, conforme o kind. Ver §6.1.
  payload TEXT NOT NULL,

  UNIQUE (quest_id, seq)
);

CREATE INDEX idx_quest_rewards_quest ON quest_rewards (quest_id, seq);
```

### 3.4 `player_quests` — a instância

```sql
-- ----------------------------------------------------------
--  player_quests — uma TENTATIVA de um jogador numa quest.
--
--  ####  POR QUE `attempt`, E NÃO UMA LINHA POR JOGADOR  ####
--
--  Porque quest repetível é a regra, não a exceção: a diária é
--  feita trinta vezes por mês. Uma linha só, sobrescrita, apagaria
--  o histórico — e "quantas vezes o Fulano fez a diária?" é
--  exatamente a pergunta que o painel precisa responder.
--
--  A tentativa VIVA é a de maior `attempt`. A consulta usa o
--  índice parcial abaixo, que só enxerga as não terminadas.
-- ----------------------------------------------------------
CREATE TABLE player_quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  quest_id  TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,

  -- 1, 2, 3… Sobe a cada nova tentativa da mesma quest.
  attempt INTEGER NOT NULL DEFAULT 1,

  -- ####  OS QUATRO ESTADOS  ####  (§7)
  --   'active'    — aceita, contando
  --   'completed' — os objetivos fecharam; a recompensa espera
  --   'claimed'   — resgatada. É o estado FINAL feliz
  --   'abandoned' — ele cancelou, ou o admin resetou
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','claimed','abandoned')),

  accepted_at  INTEGER NOT NULL,
  completed_at INTEGER,
  claimed_at   INTEGER,

  -- Quando ela pode ser aceita de novo. Preenchido no RESGATE, a
  -- partir do repeat_mode. NULL = já pode.
  cooldown_until INTEGER,

  -- ####  A DEFINIÇÃO, CONGELADA  ####
  --
  -- O que a quest EXIGIA e o que ela PROMETIA no instante do
  -- aceite, como JSON. Mesma razão do `DeliveryPlan` da loja
  -- (store/service.ts:240-255): o resgate acontece minutos ou
  -- dias depois, e uma quest editada no meio entregaria outra
  -- coisa — ou, se apagada, nada.
  snapshot TEXT NOT NULL,

  UNIQUE (server_id, steam_id, quest_id, attempt)
);

-- A consulta do jogo: "as quests vivas deste jogador neste
-- servidor". Parcial porque as terminadas são a maioria das linhas
-- e nenhuma delas interessa a essa pergunta.
CREATE INDEX idx_player_quests_live
  ON player_quests (server_id, steam_id)
  WHERE status IN ('active','completed');

-- A do painel: "o histórico do Fulano", e "quem fez esta quest".
CREATE INDEX idx_player_quests_history ON player_quests (steam_id, accepted_at DESC);
CREATE INDEX idx_player_quests_quest   ON player_quests (quest_id, status);
```

### 3.5 `player_quest_progress` — o contador

```sql
-- ----------------------------------------------------------
--  player_quest_progress — quanto falta, objetivo a objetivo.
--
--  A chave aponta para a TENTATIVA (player_quests.id), e não para
--  (steam_id, quest_id): sem isso, a segunda diária começaria com
--  o contador da primeira.
--
--  `objective_seq` e não `objective_id`: o seq é o que viaja até
--  o plugin (§8.3), e o que sobrevive a um objetivo editado no
--  painel. O snapshot da tentativa (3.4) é quem diz o que aquele
--  seq significava.
-- ----------------------------------------------------------
CREATE TABLE player_quest_progress (
  player_quest_id INTEGER NOT NULL REFERENCES player_quests(id) ON DELETE CASCADE,
  objective_seq   INTEGER NOT NULL,

  value      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (player_quest_id, objective_seq)
);
```

### 3.6 `quest_servers` — onde ela roda

```sql
-- ----------------------------------------------------------
--  quest_servers — a quest que só vale em alguns servidores.
--
--  AUSÊNCIA DE LINHA = VALE EM TODOS. É o padrão, e é o caso da
--  esmagadora maioria das quests.
--
--  A alternativa — uma linha por servidor sempre — obrigaria a
--  mexer nesta tabela a cada servidor novo, e uma quest esquecida
--  ficaria invisível lá sem ninguém entender por quê.
-- ----------------------------------------------------------
CREATE TABLE quest_servers (
  quest_id  TEXT NOT NULL REFERENCES quests(id)   ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id)  ON DELETE CASCADE,
  PRIMARY KEY (quest_id, server_id)
);
```

### 3.7 `quest_batches` e `quest_events` — a idempotência e a auditoria

```sql
-- ----------------------------------------------------------
--  quest_batches — o lote já aplicado.
--
--  Cópia deliberada do `stat_batches` da migração 033: o mesmo
--  problema, a mesma solução, e um desenho que já sobreviveu a
--  quedas de RCON em produção.
-- ----------------------------------------------------------
CREATE TABLE quest_batches (
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  batch_id   TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  players    INTEGER NOT NULL,
  entries    INTEGER NOT NULL,
  PRIMARY KEY (server_id, batch_id)
);

CREATE INDEX idx_quest_batches_recent ON quest_batches (server_id, applied_at DESC);

-- ----------------------------------------------------------
--  quest_events — o que aconteceu, append-only.
--
--  ####  ELA EXISTE PARA RESPONDER RECLAMAÇÃO  ####
--
--  "Fiz a quest e não recebi" é a mensagem que o dono vai ler, e
--  sem esta tabela a única resposta possível seria "o número está
--  zerado aqui". Com ela: aceitou às 14h02, progrediu até 4.980,
--  o servidor caiu às 14h31, o lote de 14h32 trouxe os 20 que
--  faltavam, resgatou às 14h33, o kit saiu.
--
--  `event_id` é do PLUGIN nos eventos que vêm dele — é o que faz
--  o push e o flush do mesmo fato virarem uma linha só.
-- ----------------------------------------------------------
CREATE TABLE quest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- NULL nos eventos que nascem no agente (aceite pelo menu,
  -- reset pelo painel): só o plugin gera id de evento.
  event_id TEXT UNIQUE,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL,
  quest_id  TEXT NOT NULL,
  attempt   INTEGER NOT NULL,

  kind TEXT NOT NULL
    CHECK (kind IN ('accept','progress','complete','claim','abandon','reset','reward_failed')),

  -- O corpo do evento, como JSON: o objetivo e o delta no
  -- 'progress', o que foi entregue no 'claim', o código do erro
  -- no 'reward_failed'.
  detail TEXT,

  -- 'plugin' | 'agent' | 'panel' | 'wipe'
  source TEXT NOT NULL,

  -- Quem mandou, quando é gente. NULL quando é o jogo.
  actor TEXT,

  at INTEGER NOT NULL
);

CREATE INDEX idx_quest_events_player ON quest_events (steam_id, at DESC);
CREATE INDEX idx_quest_events_quest  ON quest_events (quest_id, at DESC);
```

### 3.8 `quest_settings` — o que muda por servidor

```sql
-- ----------------------------------------------------------
--  quest_settings — uma linha por servidor, e ela pode não
--  existir: ausência = os padrões abaixo.
--
--  ####  POR QUE NÃO UM JSON NA TABELA `servers`  ####
--
--  Porque cada frente que precisasse de uma chave teria de
--  reescrever o mesmo blob, e duas gravações concorrentes
--  perderiam uma. O ranking já tem `ranking_settings` pelo mesmo
--  motivo (migração 034).
-- ----------------------------------------------------------
CREATE TABLE quest_settings (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,

  -- 0 = sem teto. É o `PlayerMaxQuests` do Quests.cs (§7.3).
  max_active INTEGER NOT NULL DEFAULT 0 CHECK (max_active >= 0),

  -- 0 = o módulo inteiro desligado neste servidor. O /quest
  -- continua abrindo e diz que não há quests — nunca some sem
  -- explicação.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- Segundos entre dois ciclos de flush (§8.4). 60 é o do
  -- ranking, e é o padrão; um servidor apertado sobe isso.
  flush_seconds INTEGER NOT NULL DEFAULT 60 CHECK (flush_seconds >= 15),

  -- 0 = o hook de loot NÃO é registrado neste servidor, mesmo
  -- havendo quest de loot cadastrada (§5.4). É a válvula que o
  -- `diag` existe para informar.
  loot_enabled INTEGER NOT NULL DEFAULT 1 CHECK (loot_enabled IN (0, 1)),

  -- A hora da virada da diária/semanal, em minutos desde a
  -- meia-noite do fuso do agente. 0 = meia-noite.
  reset_at_minute INTEGER NOT NULL DEFAULT 0
    CHECK (reset_at_minute BETWEEN 0 AND 1439),

  updated_at INTEGER NOT NULL
);
```

---

## 4 — O esquema: migração 047

> **Nome:** `quests-npc`. **Id:** `47`. Separada da 046 de propósito: o NPC é a
> frente mais cara e a mais provável de escorregar (§10). Um esquema à parte
> permite que ela chegue depois sem segurar o resto.

```sql
-- ----------------------------------------------------------
--  quest_npcs — o vendedor de quests, no mapa.
--
--  ####  A POSIÇÃO É DE UM SERVIDOR, SEMPRE  ####
--
--  Ao contrário da quest, o NPC NÃO é de rede: um X/Z do mapa de
--  hoje não significa nada no mapa do outro servidor, e menos
--  ainda depois do wipe. Ver `wipe_policy` abaixo.
-- ----------------------------------------------------------
CREATE TABLE quest_npcs (
  id TEXT PRIMARY KEY,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O que aparece sobre a cabeça dele e no marcador do mapa.
  name TEXT NOT NULL,

  -- 'quest'    — abre a tela com as quests dele
  -- 'delivery' — é destino de uma quest de entrega (§5.6)
  kind TEXT NOT NULL DEFAULT 'quest' CHECK (kind IN ('quest','delivery')),

  -- A posição no mundo. `y` é gravado, mas o plugin RECALCULA a
  -- altura do terreno ao spawnar: o mapa muda, o chão sobe e
  -- desce, e um NPC enterrado é invisível e insuportável de
  -- diagnosticar.
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,

  -- Para onde ele olha, em graus. É o que faz o NPC encarar quem
  -- chega em vez de dar as costas.
  rotation REAL NOT NULL DEFAULT 0,

  -- O prefab do boneco. Padrão: o shopkeeper de Bandit Town.
  -- Guardado (e não fixo no código) porque trocar a aparência é
  -- pedido de admin, não release de agente.
  prefab TEXT NOT NULL DEFAULT 'assets/prefabs/npc/bandit/shopkeepers/bandit_shopkeeper.prefab',

  -- 1 = desenha um marcador no mapa do jogo (§10.4).
  map_marker INTEGER NOT NULL DEFAULT 1 CHECK (map_marker IN (0, 1)),

  -- O raio, em metros, dentro do qual apertar USE abre a tela.
  use_radius REAL NOT NULL DEFAULT 3.0,

  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- ####  O QUE O WIPE FAZ COM ELE  ####
  --   'keep'   — a posição sobrevive. É o certo para NPC em
  --              monumento, que existe em todo mapa
  --   'remove' — o wipe apaga a linha. É o certo para NPC posto
  --              num ponto que só existia naquele mapa
  wipe_policy TEXT NOT NULL DEFAULT 'keep'
    CHECK (wipe_policy IN ('keep','remove')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_quest_npcs_server ON quest_npcs (server_id, enabled);
```

> **A ligação NPC → quest é `quests.npc_id`, e ela é 1 : N.** Uma quest é
> oferecida por *um* NPC. N : N (a mesma quest em três NPCs) foi descartada no
> primeiro corte: ela dobra a complexidade da tela — a mesma quest apareceria
> três vezes na lista do menu — e ninguém pediu. Se vier, é uma tabela de
> ligação e nada mais muda.

---

## 5 — Os tipos de objetivo, e de onde cada número vem

| `kind` | O número vem de | Hook | Custo |
|---|---|---|---|
| `kill` | `OnPlayerDeath` / `OnEntityDeath` | **já existe** (`OrigemZAgent.cs:4835`) | zero |
| `gather` | `OnDispenserGather` + `OnDispenserBonus` + `OnCollectiblePickup` | **já existe** (`:4501`, `:4532`, `:4567`) | zero |
| `craft` | `OnItemCraftFinished` | **já existe** (`:5558`) | zero |
| `loot` | `OnItemAddedToContainer` | **novo** | o mais alto — §5.4 |
| `deliver` | posição do jogador vs. NPC destino | **novo**, mas raro | baixo — §5.6 |
| `playtime` | o agente, sem passar pelo plugin | nenhum | zero |
| `metric` | `player_stats`, do ranking | nenhum | zero |

### 5.1 `kill` — o alvo é o nome curto da entidade

Os alvos válidos são os que o `Quests.cs` já cataloga (`GetAllKillables`,
`:832`), mais o que o agente já normaliza. **A normalização é a parte que
importa e é fácil de errar:** `scientistnpc_heavy`, `scientistnpc_ordinary` e
`scientistnpc_oilrig` são todos `scientist` para quem cadastra a quest, e o
`Quests.cs` acerta isso em `:330-337` — `ridablehorse` → `horse`, `wolf2` →
`wolf`, `npc_tunneldweller` → `tunneldweller`.

**A tabela de normalização mora no agente e desce ao plugin junto com o
catálogo** (§8.2). Deixá-la no C# faria uma criatura nova do Rust exigir um
release de plugin.

O alvo `player` conta abate de jogador; `sleeper` conta dorminhoco. Eles são
separados porque o ranking já os separa (`MetricPvpKills`,
`MetricSleeperKills` — `OrigemZAgent.cs:4788`, `:4814`), e uma quest que
premiasse matar dorminhoco sem dizer isso seria uma armadilha.

### 5.2 `gather` — o alvo é o shortname do recurso

`sulfur.ore`, `metal.ore`, `wood`, `stones`, `cloth`. O agente já soma
`ore.total` para o ranking; a quest precisa do **detalhe por recurso**, que o
hook tem em mãos (`AddOreFromItem` recebe o `Item`) e hoje descarta.

### 5.3 `craft` — o alvo é o shortname do item fabricado

Sem pegadinha. O único cuidado: o `Quests.cs` conta `item.amount`, e não 1 —
craftar um lote de 500 balas conta 500. Mantemos isso, e o painel diz "500
balas", não "1 craft".

### 5.4 `loot` — o caro, e como ele é contido

`OnItemAddedToContainer` dispara para **todo item que entra em qualquer
container do servidor**, o tempo inteiro. O `Quests.cs` ainda mantém um
dicionário `Looters` de `ItemId` → dono (`:419-449`) para não contar o item que
o próprio jogador acabou de tirar da caixa dele.

Três contenções, e as três são obrigatórias:

1. **O hook só é registrado se houver objetivo `loot` vivo.** O plugin adiciona
   e remove o hook em runtime, a mando do catálogo (§8.2). Um servidor sem quest
   de loot paga zero.
2. **A checagem começa pelo shortname**, contra um `HashSet` do catálogo, antes
   de tocar em qualquer dicionário. Item que ninguém persegue sai na primeira
   linha.
3. **O `Looters` tem teto e expiração.** No `Quests.cs` ele cresce sem limite
   enquanto o plugin viver — o que num servidor cheio é um vazamento lento.
   Aqui: dicionário com poda por tempo, e o teto vai no `origemz.quest.diag`.

> **Este é o objetivo que o `origemz.quest.diag` existe para medir.** Se o custo
> medido do hook passar do orçamento daquele servidor, o admin desliga as quests
> de loot e o resto continua.

### 5.5 `metric` — a porta dos fundos que abre tudo

O objetivo aponta direto para uma métrica de `player_stats`. **Qualquer coisa
que o ranking mede vira quest sem uma linha de código:** distância de tiro,
explosivos, Troféu Bleik, o ranking dinâmico que o admin criou ontem.

A conta é feita pelo AGENTE, no lote: `value` do objetivo = quanto a métrica
subiu **desde o aceite**. O agente grava o valor de partida no `snapshot`
(§3.4) e a diferença é o progresso.

> **A consequência que vale dizer em voz alta:** com `metric`, o dono não
> depende de nós para inventar objetivo novo. Ele cria o ranking no painel, e a
> quest sobre ele no minuto seguinte.

### 5.6 `deliver` — o que dá vida ao mapa

O `target` é o **id do NPC de destino**; a origem é o `quests.npc_id`. O plugin:

1. no aceite, marca o destino no mapa daquele jogador (§10.4) e guarda a
   distância inicial;
2. quando o jogador aperta USE no NPC de destino, grita `#OZQUEST#` com
   `kind: "deliver"` e a distância percorrida;
3. o agente confere que o destino é o certo e conclui.

**A recompensa por distância** (o `Multiplier` do `Quests.cs`, `:114`) entra
como um campo do payload de recompensa: `{"kind":"coins","perMeter":0.5}`. O
agente calcula com a distância que ELE mediu entre os dois NPCs — nunca com a
que o plugin mandou.

### 5.7 `playtime` — o único que não passa pelo plugin

O agente já mede tempo online para o ranking. O objetivo é em **minutos**, e a
conta é a mesma do `metric` com `time.played`: diferença desde o aceite.

Ele existe como `kind` próprio, e não como `metric` disfarçado, por uma razão de
painel: "ficar 60 minutos online" é a quest que todo servidor cadastra primeiro,
e obrigar o admin a saber o nome da métrica para isso seria mesquinho.

---

## 6 — A recompensa, e por que ela é um plano congelado

### 6.1 O payload, por tipo

Um `z.discriminatedUnion('kind', …)` em `core/src/types/quests.ts`, a **única**
régua, importada tanto pela rota quanto pelo serviço — a mesma escolha que
`appliers/store.ts` documenta ("uma segunda régua para a mesma tabela é uma
régua que vai divergir, e a que ficar mais frouxa é a que grava").

```jsonc
// kind: 'item'   — entregue pelo origemz.give, com a fila do OrigemZItems
{ "shortname": "rifle.ak", "amount": 1, "skinId": "3120436264", "blueprint": false }

// kind: 'coins'  — creditado na carteira
{ "amount": 500 }
// … ou, na quest de entrega, por distância percorrida:
{ "perMeter": 0.5, "min": 50, "max": 2000 }

// kind: 'kit'    — reusa KitsService.claim inteiro
{ "slug": "starter" }

// kind: 'points' — soma numa métrica do ranking
{ "metric": "quest.completed", "amount": 1 }

// kind: 'vip'    — reusa o concessor da loja
{ "tier": "ouro", "days": 7 }
```

### 6.2 Nada disso é código novo

| `kind` | Quem entrega | Onde já está |
|---|---|---|
| `item`, `vip` | `StoreService.deliverPlan` | `core/src/store/service.ts:737` |
| `coins` | `Wallet.credit` | `core/src/store/wallet.ts:162` |
| `kit` | `KitsService.claim` | `core/src/kits/service.ts:297` |
| `points` | `RankingsService` (o mesmo caminho da ação `points` do item custom) | `core/src/rankings/service.ts` |

O `QuestRewardService` é um **tradutor**: ele converte `quest_rewards` num
`DeliveryPlan` (para item e VIP) e chama os outros três diretamente. Ele não
sabe entregar nada por conta própria, e isso é proposital.

### 6.3 A entrega é congelada no ACEITE, não no resgate

O `snapshot` de `player_quests` (§3.4) guarda os objetivos **e** as recompensas
como estavam quando o jogador aceitou. É a lição que a loja já pagou: uma oferta
editada no meio entrega outra coisa, e uma oferta apagada não entrega nada.

**A quest é pior que a compra nisso**, porque ela demora horas. Uma diária
aceita às 8h e resgatada às 23h teria atravessado qualquer edição do dia.

### 6.4 A falha de entrega não pode comer a quest

Inventário cheio é o caso comum, não o excepcional. A ordem é:

```
   conferir have >= need         (agente, com o número dele)
        ↓
   marcar 'claimed' + gravar quest_events('claim')   ── COMMIT
        ↓
   entregar
        ↓
   falhou?  →  quest_events('reward_failed', código)
               a quest FICA 'claimed'; a recompensa vira PENDÊNCIA
               visível no painel, com botão de reentregar
```

**Marcar antes de entregar**, e não o contrário. O inverso — entregar e depois
marcar — dá, numa queda no meio, um jogador que recebeu duas vezes. Neste
sentido, uma queda dá um jogador que precisa de um clique do admin, e o painel
mostra exatamente quem.

> Isto é o oposto do que a loja faz (ela debita primeiro e estorna se a entrega
> falhar, `store/service.ts:35`), e a diferença é qual erro dói mais: na loja o
> jogador **pagou**, então não receber é roubo. Aqui ele não pagou nada.

---

## 7 — O ciclo de vida, estado por estado

```
                    ┌──────────────────────────────────────┐
                    │  disponível  (não é linha no banco:   │
                    │  é a AUSÊNCIA de tentativa viva)      │
                    └──────────────────────────────────────┘
                                    │
              aceitar (menu/NPC)    │    auto_accept, ao conectar
                                    ▼
    ┌────────────────────────────────────────────────────────────┐
    │  active     contando. o plugin sabe dela (§8.3)            │
    └────────────────────────────────────────────────────────────┘
         │                        │                     │
         │ todos fecham           │ cancelar            │ admin reseta
         ▼                        ▼                     ▼
    ┌──────────────┐       ┌──────────────────────────────────┐
    │  completed   │       │  abandoned                       │
    │  espera o    │       │  o progresso morre com a linha.  │
    │  resgate     │       │  o histórico fica                │
    └──────────────┘       └──────────────────────────────────┘
         │
         │ resgatar
         ▼
    ┌────────────────────────────────────────────────────────────┐
    │  claimed    cooldown_until preenchido a partir do          │
    │             repeat_mode. attempt + 1 na próxima            │
    └────────────────────────────────────────────────────────────┘
```

### 7.1 `completed` é um estado, e não um instante

O `Quests.cs` acerta isso (`RewardClaimed`, `:87`): concluir e receber são duas
coisas. O jogador conclui minerando, e resgata quando abre o menu — talvez
horas depois, talvez com o inventário vazio de propósito.

**Sem esse estado, a recompensa sairia no instante da conclusão** — num
inventário cheio, no meio de um tiroteio, ou com o jogador desconectando.

### 7.2 O aceite é do agente, sempre

Mesmo quando o clique nasce no NPC. O plugin nunca cria uma tentativa: ele
pede, o agente decide (`requires`, `requires_quest`, `available_from`,
`cooldown_until`, teto de quests ativas) e responde com a tela nova.

### 7.3 O teto de quests ativas

O `PlayerMaxQuests` do `Quests.cs` (`:3243`). Aqui é configuração por servidor,
não por quest — `0` = sem teto. Vive na mesma tabela de configuração que o resto
do módulo (`quest_settings`, criada na 046 com uma linha por servidor).

### 7.4 O `consume` roda ANTES do prêmio

Objetivo com `consume = 1`: o agente manda o plugin retirar os itens
(`origemz.quest.consume`), e **só se ele confirmar** a recompensa sai. Faltou
item — ele gastou depois de concluir —, o resgate falha com uma frase que diz o
que falta, e a quest continua `completed`.

---

## 8 — O contrato agente ↔ plugin

> **As duas pontas são compiladas separadamente.** Não existe tipo
> compartilhado: existe este documento e o `core/src/game/quests-contract.ts`.
> Mudar qualquer coisa aqui exige mudar o `OrigemZAgent.cs` junto. Divergiram, o
> agente **recusa** a resposta — nunca a trata como lista vazia.

`QUESTS_CONTRACT = 1`, carimbado em toda resposta de sucesso.

### 8.1 Os comandos

| Comando | Direção | O que faz |
|---|---|---|
| `origemz.quest.watch <base64>` | agente → plugin | o catálogo do que observar, o mapa de normalização e o **segredo** do `#OZQUEST#` |
| `origemz.quest.assign <steamId> <base64>` | agente → plugin | as tentativas vivas daquele jogador, com `seq`, `need` e `have` |
| `origemz.quest.forget <steamId>` | agente → plugin | ele desconectou, ou não tem mais nada vivo |
| `origemz.quest.consume <steamId> <base64>` | agente → plugin | retira os itens do `consume` (§7.4). Responde `{ok,taken[]}` |
| `origemz.quest.flush [offset] [limit] [secret]` | agente → plugin | o lote congelado de progresso |
| `origemz.quest.ack <batchId>` | agente → plugin | descarta o lote. **Só aqui** |
| `origemz.quest.diag` | agente → plugin | custo medido dos hooks e estado do buffer |
| `#OZQUEST#{…}` | plugin → agente | o push: conclusão, entrega, e o pedido do NPC |
| `#OZAREQ#` | plugin → agente | "esqueci o catálogo, me mande de novo" (o marcador já existe, `OrigemZAgent.cs:204`) |

### 8.2 `watch` — o catálogo, e por que ele vem inteiro

```jsonc
{
  "contract": 1,
  "secret": "…",                       // autentica o #OZQUEST# de volta
  "watch": {
    "kill":   ["scientist", "bear", "player"],
    "gather": ["sulfur.ore", "wood"],
    "craft":  ["rifle.ak"],
    "loot":   ["scrap"]                // vazio = o hook NEM É REGISTRADO
  },
  "alias": {                            // a normalização de §5.1
    "scientistnpc_heavy": "scientist",
    "ridablehorse": "horse",
    "wolf2": "wolf"
  }
}
```

**O `clear` implícito:** o `watch` **substitui** o catálogo inteiro, como o
`origemz.item.clear` faz com as marcas (`custom-items-sync.ts:20-26`). Um alvo
que sumiu do catálogo para de ser contado; sem isso, o plugin guardaria para
sempre o que já não existe.

**O segredo pega carona aqui pela mesma razão documentada no
`custom-items-sync.ts:62-80`:** o `watch` é o único comando que sai sempre —
inclusive num servidor sem quest nenhuma, onde não há `assign` algum.

### 8.3 `assign` — o que o jogador está perseguindo

```jsonc
{
  "contract": 1,
  "quests": [
    { "pq": 8412, "objectives": [
        { "seq": 0, "kind": "gather", "target": "sulfur.ore", "need": 5000, "have": 3240 },
        { "seq": 1, "kind": "kill",   "target": "scientist",  "need": 20,   "have": 20   }
    ]}
  ]
}
```

`pq` é o `player_quests.id` — o plugin nunca precisa saber o slug da quest.

**Ele é mandado em três momentos:** ao conectar, ao aceitar/cancelar, e na
resposta ao `#OZAREQ#`. Nunca em rajada: um `oxide.reload` num servidor de 150
jogadores mandaria 150 comandos de RCON de uma vez, e o `ui-sync.ts` já pagou
essa conta (o `DEBOUNCE_MS`, `:108`).

### 8.4 `flush` — o lote, idêntico ao do ranking

Mesmo desenho de `stats-contract.ts:29-40`, e a repetição é deliberada:

```
   flush offset=0    → FECHA o buffer atual como "lote pendente"
   flush offset=100  → lê o MESMO lote
   ack <batchId>     → descarta. SÓ AQUI
   flush offset=0 com pendente não confirmado → devolve o MESMO lote
```

Limites, duplicados nos dois lados de propósito: `DEFAULT_LIMIT = 100`,
`MAX_LIMIT = 250`, `MAX_BYTES = 60_000`. Página que não cabe é recusada
**inteira** (`PAYLOAD_TOO_LARGE`) — resposta truncada chega como JSON inválido, e
meio lote *parece* ter funcionado.

> **Por que um canal próprio, e não uma chave a mais no `origemz.stats.flush`?**
> Porque aí uma mudança de quest passaria a poder quebrar o ranking. O ranking
> está em produção; o custo de um comando a mais é um `send` por minuto.

### 8.5 `#OZQUEST#` — o push

```jsonc
#OZQUEST#{"contract":1,"secret":"…","eventId":"…","kind":"complete",
          "steamId":"7656…","pq":8412,"seq":0,"value":5000,"at":1757…}
```

`kind` ∈ `progress` (só em marcos: 25/50/75/100%), `complete`, `deliver`, `npc`.

**O segredo não é zelo.** O `onConsoleLine` recebe TODA linha do servidor, o chat
dos jogadores incluído: sem ele, alguém digitando o marcador no chat concluiria
a própria quest. É a mesma defesa que o `stat-events.ts:59-63` documenta.

**E nenhum comando de RCON sai de dentro do gancho.** O `handleLine` aplica no
SQLite e **arma um relógio** para a resposta — o laço de console já foi vivido
neste projeto (`core/src/index.ts:309-319`).

### 8.6 `kind: "npc"` não inventa transporte

O jogador aperta USE perto do NPC. O plugin **não** grita `#OZQUEST#`: ele
manda um `#OZUIREQ#` com `screenId = tela-quest:npc:<npcId>`, pelo caminho que o
`ui-sync.ts` já serve.

**É o achado que mais economiza código no projeto inteiro.** A tela do NPC não
tem transporte próprio, não tem cache próprio, não tem tratamento de erro
próprio: ela é uma tela do menu como qualquer outra, com um endereço diferente.

---

## 9 — O caminho da escrita, inteiro

```
 [1] o jogador mina enxofre
       │
 [2] OnDispenserGather (OrigemZAgent) — o hook que JÁ existe
       │  soma no buffer de métricas (ranking)
       │  E, se 'sulfur.ore' está no watch, procura nas tentativas
       │  vivas dele e soma no contador de quest
       ▼
 [3] have >= need?
       │ não → segue no buffer, sai no flush de 60 s
       │ sim
       ▼
 [4] o plugin grita #OZQUEST# kind=complete   ← o "agora"
       │  e mostra o recibo no chat dele
       ▼
 [5] o agente lê a linha, valida o segredo e o schema
       │
 [6] confere have >= need COM O NÚMERO DELE
       │  divergiu para menos → ignora e deixa o flush resolver
       │  bateu
       ▼
 [7] UMA transação:
       player_quests.status = 'completed'
       quest_events('complete', event_id)         ── COMMIT
       ▼
 [8] relógio armado → origemz.quest.ack + assign atualizado
       ▼
 [9] o jogador abre /quest e clica RESGATAR  (§13.4)
       ▼
[10] consume (se houver) → marca 'claimed' → COMMIT → entrega
```

**O passo [6] é a razão de o sistema existir do jeito que existe.** Sem ele o
plugin seria a autoridade, e um `oxide.reload` no meio do lote — que zera o
cache dele sem derrubar o RCON, como o `ui-sync.ts:114-120` documenta — daria
uma conclusão baseada em contador incompleto.

---

## 10 — O NPC

> A frente mais cara, e a única onde não há código pronto para reusar. Ela é a
> migração 047 e a frente F para que possa chegar depois sem segurar nada.

### 10.1 O que a medição encontrou

Rodado com Mono.Cecil contra o `Assembly-CSharp.dll` da instalação real
(`Servers/server01/RustDedicated_Data/Managed/`), em 06/09/2026:

| Classe | Existe | Serve? |
|---|---|---|
| `NPCTalking : NPCShopKeeper` | sim | o boneco, com `maxConversationDistance` e `conversingPlayers`. **A conversa dele não** — ela depende de assets `ConversationData` |
| `NPCShopKeeper : NPCPlayer` | sim | o boneco parado, com `Greeting()` e as animações de aceno |
| `MapMarkerGenericRadius : MapMarker` | sim | o marcador de mapa, com `radius`, `color1`, `color2`, `alpha` |
| `VendingMachineMapMarker` | sim | o marcador **com nome** — é o que dá o rótulo no mapa |
| `BaseMission`, `MissionProvider` | sim | o sistema de missão vanilla. **Não serve**: `BaseMission : BaseScriptableObject`, e criar asset em Oxide não é caminho |
| hook de conversa no Oxide | **não** | `grep` no `Oxide.Rust.dll`: só `OnNpcTarget` |

### 10.2 A escolha, e a alternativa descartada

**Escolhido:** `NPCShopKeeper` spawnado parado, com a IA desligada e o dano
bloqueado, mais detecção de USE por proximidade no `OnPlayerInput`.

**Descartado:** `NPCTalking` com conversa nativa. Ele daria o "aperte E para
falar" do jogo de graça — mas as falas são assets do jogo, e cancelar a conversa
vanilla para abrir a nossa exigiria um hook que não existe nesta instalação. O
resultado seria um NPC que abre duas telas.

> **O custo da escolha, dito na cara:** `OnPlayerInput` dispara a cada quadro
> para cada jogador. A contenção é a mesma do loot (§5.4): o hook **só é
> registrado se aquele servidor tiver NPC**, e a primeira linha dele é uma
> comparação de botão, antes de qualquer distância. O custo medido vai no
> `origemz.quest.diag`, e a frente F **não fecha sem esse número**.

### 10.3 Cadastrar é in-game; gerenciar é no painel

O admin não escolhe coordenada digitando número. Ele vai até o lugar, olha para
onde o NPC deve olhar, e digita:

```
/questnpc add <nome>      cria na posição e rotação DELE
/questnpc move <id>       traz o NPC para onde ele está
/questnpc remove <id>
/questnpc list
```

O plugin manda a posição ao agente, que grava. **O painel faz o resto**: renomear,
ligar/desligar, escolher o prefab, o raio, o marcador, e ver todos no mapa
(`panel/src/components/map-view.tsx` já desenha o mapa do servidor).

> Isto é o único pedaço do `Quests.cs` que sobrevive quase igual (`:3026`), e
> pelo motivo certo: para posição no mundo, o jogo é a melhor interface que
> existe.

### 10.4 O marcador de mapa

`VendingMachineMapMarker` pelo nome, `MapMarkerGenericRadius` pelo círculo. Dois
usos:

- **permanente**, para NPC com `map_marker = 1` — todo mundo vê onde pegar
  quest;
- **temporário e privado**, para o destino de uma entrega em andamento — só o
  jogador daquela entrega vê, e some quando ela fecha.

---

## 11 — A API

`core/src/http/routes/quests.ts`. **A regra mora no serviço; a rota é só a
borda** — a mesma divisão que `routes/rankings.ts:29-38` documenta.

### 11.1 Leitura (o painel e o site)

```
GET  /quests                            o catálogo, com filtro por categoria
GET  /quests/:id                        uma quest, com objetivos e recompensas
GET  /quests/:id/players                quem está fazendo, quem já fez
GET  /quests/progress                   o progresso, paginado e filtrável
GET  /quests/events                     a auditoria (§3.7)
GET  /quests/settings                   os tetos e chaves, por servidor
GET  /players/:steamId/quests           as quests DELE — ativas, feitas, cooldown
GET  /quests/npcs                       os NPCs, por servidor
GET  /quests/rewards/pending            as entregas que falharam (§6.4)
```

### 11.2 Escrita (o painel)

```
POST   /quests                          cria. 201
PUT    /quests/:id                      edita
PUT    /quests/order                    reordena o catálogo inteiro
DELETE /quests/:id                      apaga
POST   /quests/:id/duplicate            duplica. É o que faz a semanal nascer
                                        da diária sem redigitar tudo
PUT    /quests/settings/:serverId       tetos e chaves daquele servidor

PUT    /quests/npcs/:id                 edita o NPC
DELETE /quests/npcs/:id                 apaga (o plugin despawna)
POST   /quests/npcs/:id/respawn         força o respawn

POST   /quests/:id/grant                concede a quest a um jogador (suporte)
POST   /quests/progress/:pqId/set       ajusta um contador, com autor e motivo
POST   /quests/progress/:pqId/complete  conclui à mão
POST   /quests/rewards/:pqId/retry      reentrega o que falhou

POST   /quests/wipe                     zera progresso. §14
```

### 11.3 As três regras que nascem na rota

Pelo mesmo motivo das três do ranking — só a rota tem os dados para vê-las:

1. **`QUEST_CYCLE`** — `requires_quest` que fecha um ciclo. Só quem tem o
   catálogo inteiro na mão consegue ver;
2. **`QUEST_IN_USE`** — apagar uma quest que N jogadores estão fazendo agora.
   Vira aviso com contagem, e exige `force: true`;
3. **`QUEST_NPC_MISSING`** — apontar `npc_id` para um NPC de outro servidor, ou
   inexistente. A quest ficaria invisível e ninguém entenderia por quê.

### 11.4 Para o site

`GET /quests` e `GET /players/:steamId/quests` são os dois que o site consome,
com os mesmos três campos de contexto que toda lista do ranking carrega
(`measuredSince`, `coverage`, `updatedAt`) — "zero" e "não consegui perguntar"
são respostas diferentes, e a segunda não pode se disfarçar da primeira.

---

## 12 — O painel

Página `/quests`, em `panel/src/app/quests/page.tsx`, com componentes em
`panel/src/components/quests/`. O padrão é o de `/ranking`: **o catálogo é lido
uma vez, na página, e servido às abas** — três leituras da mesma lista dariam
três momentos diferentes, e criar uma quest numa aba sem vê-la na outra é o tipo
de divergência que faz alguém cadastrar duas vezes.

### 12.1 As quatro abas

```
┌─ QUESTS ─────────────────────────────────────────────────────────┐
│  Catálogo  ·  Progresso  ·  NPCs  ·  Manutenção                  │
├──────────────────────────────────────────────────────────────────┤
│  ⠿  Diária · Minerador           gather · 5.000 sulfur.ore       │
│     🎁 500 moedas + 1 ponto      ⟳ diária   👥 47 fazendo   [⚙]  │
│  ⠿  História · O Primeiro Passo  kill · 20 scientist             │
│     🎁 kit starter               ▸ exige: Boas-vindas       [⚙]  │
│  ⠿  Entrega · Outpost → Bandit   deliver · 0,5 moeda/m           │
│     🧍 NPC: Velho do Outpost     ⏸ desativada               [⚙]  │
│                                              [ + Nova quest ]    │
└──────────────────────────────────────────────────────────────────┘
```

**Catálogo** — a lista, com ordem arrastável (o mesmo componente de ordem que o
catálogo de rankings já usa). Criar, editar, duplicar, ligar/desligar, apagar.

**Progresso** — a pergunta que o dono vai fazer todo dia. Busca por jogador ou
por quest; mostra tentativa, contador objetivo a objetivo, quando aceitou,
quando concluiu, se resgatou. Com os botões de suporte: ajustar contador,
concluir à mão, reentregar recompensa.

**NPCs** — a lista por servidor, **sobre o mapa** (o `map-view.tsx` já existe).
Renomear, mover (só pelo jogo), ligar/desligar, respawnar.

**Manutenção** — o wipe de progresso (§14), as entregas pendentes (§6.4) e a
auditoria (`quest_events`).

### 12.2 O editor de quest

Um diálogo, no padrão do `custom-item-dialog.tsx`. Quatro seções:

1. **Identidade** — título, descrição, categoria, ordem, quem pode ver;
2. **Objetivos** — lista, com o seletor de tipo mudando o campo do alvo. O alvo
   de `kill` é uma lista fechada; o de `gather`/`craft`/`loot` é o
   `item-combobox.tsx` que já existe, com ícone; o de `metric` é a lista de
   rankings; o de `deliver` é a lista de NPCs;
3. **Recompensas** — lista, com o mesmo `item-picker-dialog.tsx` da loja;
4. **Regras** — repetição, cooldown, pré-requisito, janela de evento,
   `auto_accept`, `wipe_policy`, NPC, servidores.

**A pré-visualização da frase.** O painel mostra, ao vivo, a linha que o jogador
vai ler no jogo: *"Minerar 5.000 de Minério de Enxofre"*. É barato, e é o que
impede uma quest cadastrada com o shortname errado chegar ao jogo.

### 12.3 Na ficha do jogador

`panel/src/app/jogador/page.tsx` ganha um bloco: as quests ativas dele, as
últimas concluídas, e o botão de conceder. É onde o suporte vai olhar primeiro
quando alguém reclamar.

---

## 13 — A tela do jogo: `/quest`

### 13.1 Um documento novo, e o plugin não muda

`slug: 'menu-quests'`, `command: 'quest'`. O `OrigemZUI.cs` registra o comando
sozinho a partir do pacote (`:643`) — **nenhuma linha de C# na frente de UI**.

O gerador vive em `core/src/game/ui-preset-quests-menu.ts`, no padrão do
`ui-preset-main-menu.ts`: determinístico, mesmas opções → mesmo documento, byte
a byte.

### 13.2 Os endereços

Nada guarda estado; tudo é endereço — a regra de `ui-ranking-screen.ts:37-51`:

```
   tela-quest                        ativas, página 0
   tela-quest:<aba>:<página>         aba ∈ ativas | disponiveis | feitas
   tela-quest:det:<questId>          o detalhe, como modal
   tela-quest:npc:<npcId>            as quests daquele NPC
```

### 13.3 Volátil, sempre

`volatile: true` no pacote. A tela diz "você tem 3.240 de 5.000"; em cache, ela
diria isso **para o servidor inteiro e para sempre** — o mesmo motivo que a tela
de ranking documenta.

### 13.4 O botão reusa `store.buy`

`offerId` prefixado, e o `fallback` do `onBuy` (`core/src/index.ts:1261`) ganha
mais um ramo:

```
   quest:accept:<questId>      aceitar
   quest:cancel:<pqId>         cancelar
   quest:claim:<pqId>          resgatar
```

**Nenhuma mudança no `uiDocumentSchema`, nenhuma no plugin.** É o mesmo caminho
que os kits já percorrem, com a mesma autenticação por token de sessão e a
mesma revalidação de "a ação pertence ao que está na tela agora"
(`OrigemZUI.cs:1820-1830`).

### 13.5 O tamanho, e o que ele impõe

Teto de 50 000 bytes de base64 por comando (`types/ui-transport.ts:534`). Uma
tela estourada **não dá erro no jogo: ela simplesmente não abre**.

O recorte acontece **antes do desenho**, em duas funções — `readQuestView()` lê
o banco e devolve só a página pedida; `buildQuestScreen()` desenha o que
recebeu, e nada além. Paginação pelo SQL, nunca em memória.

**Seis quests por página**, com pager. A conta cabe na frente D, e ela **não
fecha sem o teste de tamanho no pior caso** — títulos no limite, seis quests com
três objetivos cada, a barra de progresso e o rodapé.

### 13.6 O recibo é no chat, não na tela

Concluir uma quest acontece enquanto o jogador está minerando, não com o menu
aberto. O aviso é uma linha no chat, pelo `OrigemZChat`, com a marcação do
projeto — e a tela só confirma quando ele abrir.

---

## 14 — O wipe do progresso

### 14.1 Automático, junto com o wipe do mundo

O `core/src/wipe/` já orquestra o wipe. Ele ganha um passo: para cada quest com
`wipe_policy = 'reset'`, o progresso naquele servidor vai a `abandoned` e o
histórico fica.

**Fica**, e não é apagado, por uma razão: o ranking "quests concluídas"
atravessa o wipe, e apagar `quest_events` reescreveria o passado. A mesma
escolha que `stat_periods` documenta.

E os NPCs com `wipe_policy = 'remove'` somem no mesmo passo (§4).

### 14.2 À mão, pelo painel

`POST /quests/wipe`, na aba Manutenção, com três recortes e **confirmação por
digitação** (o nome do servidor, como o wipe do mundo já exige):

```
   { "serverId": "…" }                     tudo daquele servidor
   { "serverId": "…", "questId": "…" }     uma quest
   { "steamId": "…" }                      um jogador, em todos
```

Sempre com `actor` e `reason`, sempre gravando `quest_events('reset')`.

> **O `/wipePlayerProgress` do `Quests.cs` (`:3016`) não tem equivalente
> in-game aqui**, e é de propósito: um comando de chat que zera o progresso de
> todo mundo, disponível a qualquer admin, sem confirmação e sem registro de
> quem foi, é uma armadilha esperando o dia ruim.

---

## 15 — As frentes, e o que cada uma entrega

Sete frentes. **A ordem importa nas três primeiras**; da D em diante elas
correm em paralelo.

| # | Frente | Entrega | Depende de |
|---|---|---|---|
| **A** | ~~**Esquema e repositório**~~ **ENTREGUE em 06/09/2026** | migrações 046 e 047; `core/src/db/quests-repository.ts` (34 métodos); os tipos zod em `core/src/types/quests.ts`; `core/test/quests-repository.test.ts` com 49 testes. Ver §15.3 | — |
| **B** | ~~**O serviço**~~ **ENTREGUE em 06/09/2026** | `core/src/quests/service.ts` e `core/src/quests/rewards.ts`; 67 testes. Ver §15.4 | A |
| **C** | ~~**O contrato e o plugin**~~ **ENTREGUE em 06/09/2026** | o contrato, o coletor, o canal do push e a região `Quests` no `OrigemZAgent.cs` (compilada contra as DLLs reais); 21 testes. Ver §15.8 | A, B |
| **D** | ~~**A tela do jogo**~~ **ENTREGUE em 06/09/2026** | `ui-quests-screen.ts`, `ui-preset-quests-menu.ts`, o ramo `quest:` no `onBuy` e a fiação no `index.ts`; 26 testes. Ver §15.6 | B |
| **E** | ~~**A API**~~ **ENTREGUE em 06/09/2026** | `core/src/http/routes/quests.ts` (26 rotas) e o registro em `http/server.ts`; 35 testes. Ver §15.5 | B |
| **F** | ~~**O NPC**~~ **ENTREGUE em 06/09/2026** | a região `QuestNpcs` no plugin, o `npc-sync.ts` e o terceiro argumento do `origemz.ui.open`; 6 testes. Ver §15.9 | C, D |
| **G** | ~~**O painel**~~ **ENTREGUE em 06/09/2026** | `/quests` com tres abas, o editor de §12.2, o cliente em `lib/api.ts` e a entrada no menu. Ver §15.7 | E |

### 15.1 O que cada frente NÃO faz

- **A** não escreve regra. Um repositório que decide cooldown é uma regra que
  vai ser reescrita diferente no serviço.
- **B** não fala com RCON. Ele recebe um contador e devolve um desfecho.
- **C** não decide nada. Ele transporta, e recusa o que não entende.
- **D** não lê banco direto — só o que o serviço devolve, já recortado.
- **F** não segura ninguém. Se ela escorregar, o sistema inteiro funciona com
  `npc_id` nulo em todas as quests.

### 15.2 O menor corte que já vale a pena

Frentes **A + B + E + G**, sem plugin nenhum: o admin cadastra quests no painel,
e os objetivos de tipo `metric` e `playtime` — que **não passam pelo plugin** —
já funcionam de ponta a ponta, contados pelo lote do ranking que já roda.

É um sistema de quest inteiro, configurável pelo painel, sem uma linha de C#.

### 15.3 O que a frente A entregou, e as três decisões que ela fechou

Construída em 06/09/2026. Suíte do `core` verde: **1 475 testes, 75 arquivos**;
`tsc --noEmit` e `eslint` limpos.

| Arquivo | O que tem |
|---|---|
| `core/src/db/migrations.ts` | as migrações **046** (`quests-core`, nove tabelas) e **047** (`quests-npc`) |
| `core/src/types/quests.ts` | o vocabulário e a régua zod — a única, importada por todos |
| `core/src/db/quests-repository.ts` | 34 métodos: catálogo, tentativa, lote, auditoria, wipe, configuração e NPC |
| `core/test/quests-repository.test.ts` | 49 testes contra banco em memória com as migrações reais |

**Três decisões que a construção fechou, e que valem para as frentes seguintes:**

1. **O módulo nasce VAZIO, e não semeado.** O ranking nasce com onze rankings
   porque um servidor sem ranking nenhum não tem o que mostrar. Quest é o
   oposto: uma quest de exemplo apareceria no jogo, para jogadores de verdade,
   no minuto seguinte à subida.

2. **`accept` registra evento sozinho; `abandon` não.** A assimetria é
   deliberada e está documentada no método: aceitar significa sempre a mesma
   coisa, abandonar tem dois autores — o jogador que cancelou e o admin que
   resetou — e a frase do painel muda. Quem chama sabe qual foi.

3. **Existem dois tipos para a mesma quest: `QuestDraft` e `QuestInput`.** O
   primeiro é o que ENTRA (com os `.default()` por aplicar) e é o que o
   formulário do painel monta; o segundo é o que SAI do `parse` e é o que o
   repositório grava. Tipar um corpo de entrada como `QuestInput` obrigaria a
   rota a repetir `metric: null, label: null, consume: false` em todo objetivo.

**O que a frente A deliberadamente NÃO fez** — e a frente B precisa fazer:
nenhuma regra. O repositório calcula o `attempt` (aritmética de banco) e
recusa duas tentativas vivas da mesma quest (integridade). Cooldown, cadeia,
teto, "ele já pode aceitar?", "os objetivos fecharam?" e a frase que o jogador
lê não existem ainda.


### 15.4 O que a frente B entregou, e a dependência que ela deixa para a C

Construída em 06/09/2026. Suíte do `core` verde: **1 542 testes, 77 arquivos**;
`tsc --noEmit` e `eslint` limpos.

| Arquivo | O que tem |
|---|---|
| `core/src/quests/service.ts` | a REGRA: disponibilidade, aceite, aceite automático, lote, conclusão, resgate, reentrega, cooldown, cadeia, teto, a frase do objetivo |
| `core/src/quests/rewards.ts` | o TRADUTOR: as cinco recompensas, cada uma pelo caminho que já existia |
| `core/test/quests-service.test.ts` | 50 testes |
| `core/test/quests-rewards.test.ts` | 17 testes |

**Quatro decisões que a construção fechou:**

1. **A linha de partida virou parte do snapshot** (`QuestSnapshot.baselines`).
   Os objetivos `metric` e `playtime` leem um TOTAL acumulado que não sabe que a
   quest existe: sem gravar onde o jogador estava no aceite, quem já tinha 4.000
   abates concluiria "mate 20" no instante em que aceitasse. Ela mora no
   snapshot — e não numa coluna — porque é a mesma coisa que o resto dele: o que
   ficou congelado no aceite. **Não custou migração.**

2. **O `requires` que não se pode conferir TRANCA a quest.** Sem o provedor de
   permissões, uma quest de VIP fica bloqueada com uma frase que explica. Liberar
   o que não se sabe conferir entregaria a quest de VIP para todo mundo.

3. **A ordem das recusas é por utilidade, não por custo.** Cadeia → cooldown →
   `requires` → teto. "Volta em 4h" é melhor que "você atingiu o limite", e
   dizer "você está no limite" sobre uma quest que ele nem poderia pegar esconde
   o motivo de verdade. O `requires` vem por último entre as da quest porque é o
   único que pode custar uma ida à rede.

4. **`autoAcceptFor` não fura a fila.** `auto_accept` quer dizer "não precisa
   clicar", e não "pode ignorar cooldown, cadeia e teto". Ela também não abre
   quest de NPC — uma que se aceitasse sozinha apareceria como ativa sem o
   jogador nunca ter ido lá, e o NPC deixaria de ter função.

> **A DEPENDÊNCIA QUE A FRENTE C PRECISA HONRAR.** O `refreshDerived` roda no
> `liveFor` e no `claim` — os dois caminhos em que o jogador está olhando. **Isso
> não basta.** "Fique 60 minutos online" de quem nunca abre o menu fica em zero
> para sempre, e a quest jamais conclui. O ciclo do coletor precisa chamá-lo para
> os jogadores online, junto com o flush. Sem isso o buraco é **silencioso**: o
> módulo funciona inteiro, menos os objetivos `metric` e `playtime`.

**O que a frente B deliberadamente NÃO fez:** nenhum comando de RCON, nenhuma
leitura de console. Ela recebe um contador e devolve um desfecho; quem fala com
o jogo são as dependências injetadas, todas com interface mínima
(`QuestStatsSource`, `QuestPermissions`, `QuestItemDelivery`, `QuestWallet`,
`QuestKits`, `QuestPoints`) — o padrão do `WalletStore` e do `UiSyncRcon`.


### 15.5 O que a frente E entregou

Construída em 06/09/2026. Suíte do `core` verde: **1 577 testes, 78 arquivos**.

`core/src/http/routes/quests.ts` — 26 rotas, e o registro em `http/server.ts`
como dependência **opcional**: um agente sem o módulo montado responde 404 nelas
em vez de subir com dependências pela metade.

**As três regras de §11.3 estão implementadas e testadas**, e uma quarta
apareceu na construção:

| Código | Quando | Por quê nasce na rota |
|---|---|---|
| `QUEST_CYCLE` | A → B → C → A | só quem tem o catálogo inteiro enxerga; as três sumiriam para sempre, cada uma dizendo "conclua a anterior" |
| `QUEST_IN_USE` | apagar com gente no meio | recusa **com a contagem**; o `force` é um segundo clique, não um parâmetro escondido |
| `QUEST_NPC_MISSING` | NPC inexistente, ou de outro servidor | `quests.npc_id` não tem FK (as migrações são separadas), então o banco aceita qualquer texto |
| `QUEST_PROGRESS_NO_FILTER` | `/quests/progress` sem `steamId` nem `questId` | sem recorte, varreria uma tabela que cresce com jogador × quest × tentativa |

E duas decisões de borda que valem para o painel:

1. **As datas saem como EPOCH, não ISO** — ao contrário do ranking. A razão é o
   consumidor: painel e tela do jogo fazem contas de tempo (quanto falta do
   cooldown), e ISO obrigaria os dois a reconverter.
2. **A duplicata nasce desligada e sem a cadeia.** Uma cópia no ar antes de
   alguém trocar o título apareceria no jogo como duas quests iguais; herdar a
   cadeia produziria uma cópia que ninguém consegue pegar e que parece quebrada.


### 15.6 O que a frente D entregou, e os três bugs que os testes pegaram

Construída em 06/09/2026. Suíte do `core` verde: **1 605 testes, 79 arquivos**.

| Arquivo | O que tem |
|---|---|
| `core/src/game/ui-quests-screen.ts` | o endereço, a leitura, o desenho e o provedor |
| `core/src/game/ui-preset-quests-menu.ts` | o documento `menu-quests`, com `command: 'quest'` |
| `core/src/game/ui-preset-main-menu.ts` | uma linha em `UI_PRESETS` |
| `core/src/index.ts` | a fiação: o provedor de tela, o `runQuestAction` do botão e o registro das rotas |
| `core/src/db/rankings-repository.ts` | `valueOf(periodId, steamId, metric)` — o número dos objetivos `metric` |

**A promessa do §0.3 se confirmou: a tela inteira não custou uma linha de C#.**
O `command: 'quest'` do documento faz o `OrigemZUI.cs` registrar o comando
sozinho, e o botão reusa `store.buy` com `offerId` prefixado
(`quest:accept:<id>`, `quest:claim:<pq>`, `quest:cancel:<pq>`) — o mesmo canal
dos kits.

> **TRÊS BUGS QUE SÓ APARECERIAM NO JOGO, E QUE OS TESTES PEGARAM.** Vale
> registrá-los porque os três são silenciosos — nenhum deles dá erro em lugar
> nenhum.
>
> 1. **`clamp()` de `ui-widgets.ts` faz `Math.trunc`.** Ele é para PÁGINAS, que
>    são inteiras. Usá-lo na fração da barra de progresso zerava TODA barra
>    abaixo de 100%: a tela mostraria a barra vazia para quem tem 4.999 de
>    5.000, e nada no código diria por quê. A barra usa `Math.min/Math.max`.
> 2. **O `uiDocumentSchema` recusa `:` em `screenId` de ação.** A tela em
>    repouso tinha as abas, e elas navegam para `tela-quest:disponiveis` — o
>    documento INTEIRO seria recusado na gravação, e o menu sumiria do jogo. É
>    exatamente a pegadinha que o `buildMainMenu` já documentava sobre o
>    ranking; aqui ela foi pega pelo teste do schema. A tela em repouso nasce
>    com `withTabs: false`.
> 3. **A recompensa e a barra ocupavam a mesma faixa** do bloco: o texto sumia
>    atrás do trilho.

**E uma promessa que precisou ser retirada:** o campo `blueprint` da recompensa
de item **saiu do contrato**. O caminho de entrega (`StoreService.deliverPlan`)
manda `origemz.give` com o modo fixo, e um `blueprint: true` no cadastro não
teria efeito nenhum no jogo. Prometer um campo que não faz nada é pior que não
ter o campo: o admin cadastra, testa uma vez, vê o item comum chegar e passa a
desconfiar do resto. Ele volta quando a entrega souber mandar blueprint — com
teste.

**Uma dependência nova apareceu:** a recompensa de item precisa do `itemId`
numérico (o `DeliveryPlan` da loja o exige) e a quest guarda só o shortname. Daí
o `QuestItemCatalog`, e o código `ITEM_UNKNOWN` para o item que o Rust removeu
numa atualização — pendência com o nome no painel, em vez de um `give` que o
plugin recusa e cujo motivo ninguém vê.


### 15.7 O que a frente G entregou

Construída em 06/09/2026. `tsc --noEmit`, `eslint` e `next build` limpos; **150
testes do painel verdes**, e `/quests` aparece na lista de rotas do build.

| Arquivo | O que tem |
|---|---|
| `panel/src/lib/api.ts` | 12 tipos e 22 métodos |
| `panel/src/app/quests/page.tsx` | a página, com o catálogo lido UMA vez para as três abas |
| `panel/src/components/quests/quest-catalog.tsx` | a lista, com ordem, ligar/desligar, duplicar e apagar |
| `panel/src/components/quests/quest-dialog.tsx` | o editor de quatro seções, com a pré-visualização da frase |
| `panel/src/components/quests/quest-progress.tsx` | a aba do suporte |
| `panel/src/components/quests/quest-maintenance.tsx` | NPCs, pendências e o botão de zerar |
| `panel/src/components/sidebar.tsx` | a entrada **Missões** |

**Três abas, e não quatro como o §12.1 previa.** Os NPCs viraram um bloco dentro
de Manutenção: eles não têm CRUD de verdade no painel — a posição só se cria no
jogo — e uma aba inteira para uma lista de três linhas com um botão de apagar
seria uma aba vazia na maioria dos servidores.

**Quatro decisões de tela, e as quatro são sobre não mentir:**

1. **A pré-visualização da frase é aproximada, e o comentário diz isso.** O
   painel monta "Coletar 5.000 de sulfur.ore"; o agente monta a de verdade, com
   o nome bonito do catálogo do jogo. Duplicar a tradução aqui seria uma segunda
   verdade sobre o nome de um item.
2. **A recusa de apagar mostra a frase da API inteira**, com a contagem
   (`3 jogador(es) estão com esta quest…`). Reescrevê-la perderia o número, que é
   justamente o que decide o clique.
3. **O botão de zerar só acende com servidor E motivo** — o mesmo freio da API,
   dito antes da ida à rede.
4. **Apagar um NPC avisa quais quests ficaram órfãs.** Elas não são apagadas —
   voltam a ser quests de menu —, mas somem do mapa sem sumir da lista, e isso
   precisa ser dito.


### 15.8 O que a frente C entregou

Construída em 06/09/2026. Suíte do `core` verde: **1 626 testes, 80 arquivos**.
O plugin **compila com ZERO erros** contra o `Assembly-CSharp.dll` da instalação
real (Roslyn, 260 DLLs referenciadas).

| Arquivo | O que tem |
|---|---|
| `core/src/game/quests-contract.ts` | os comandos, os schemas e o `parseQuestPush` |
| `core/src/quests/collector.ts` | o relógio: catálogo, flush paginado, `ack`, e o recálculo dos derivados |
| `core/src/quests/events.ts` | o `#OZQUEST#`: aplica na hora, fala com o jogo por relógio |
| `Plugins/OrigemZAgent.cs` | a região `Quests` (~640 linhas) e quatro ganchos nos hooks que já existiam |

**A dependência que a frente B deixou por escrito está honrada:** o `sweep`
chama `refreshDerived` para quem está online, e há teste provando que
"fique 60 minutos online" progride sem ninguém abrir o menu.

**A promessa do §0.3 se confirmou no C# também.** Os hooks de matar, colher e
fabricar **não foram duplicados**: o `ApplyDeath`, o `AddOre` e o `ApplyCraft`
ganharam uma chamada cada. O único hook novo é o de loot — e ele nasce
**desinscrito**, porque o Oxide registra todo hook cujo método existe: sem o
`Unsubscribe` no boot, o hook mais quente do jogo rodaria em todo servidor,
inclusive nos que não têm missão de loot nenhuma.

> **UM BUG DE DESENHO QUE O TESTE PEGOU.** As páginas de um lote carregam o
> MESMO `batchId` — é ele que congela o lote no plugin. Mas a idempotência do
> `applyBatch` também é por `batchId`: aplicar página por página fazia a segunda
> ser recusada como "já aplicado", e **o progresso de todo mundo depois da
> centésima linha sumia em silêncio**. O coletor agora acumula as páginas e
> aplica uma vez — que é também o que o coletor do ranking já fazia.

**E o `flushSeconds` por servidor passou a valer de verdade:** o relógio bate a
cada 15 s (o menor intervalo que a configuração aceita) e cada servidor só é
perguntado quando o tempo DELE passou. Sem isso, o campo estaria no painel sem
efeito nenhum — e um campo que não faz nada é pior que campo nenhum.

**Como validar o plugin sem subir servidor:** Roslyn contra
`Servers/server01/RustDedicated_Data/Managed`, **excluindo `Newtonsoft.Json.dll`**
— o `Oxide.References` o re-exporta, e referenciar os dois faz todo
`[JsonProperty]` do arquivo virar `CS0433`, uma ambiguidade que não existe no
compilador do Oxide.


### 15.9 O que a frente F entregou, e as duas correções que ela custou

Construída em 06/09/2026. Suíte do `core` verde: **1 633 testes, 80 arquivos**;
os **dois plugins compilam com zero erros** contra as DLLs reais.

| Arquivo | O que tem |
|---|---|
| `Plugins/OrigemZAgent.cs` | a região `QuestNpcs`: spawn, marcador, `OnPlayerInput` contido, `/questnpc` |
| `Plugins/OrigemZUI.cs` | **quatro linhas**: o terceiro argumento do `origemz.ui.open` |
| `core/src/quests/npc-sync.ts` | desce os NPCs, recebe o cadastro in-game e abre a tela do NPC |

**Medido, e não chutado:** `bandit_shopkeeper.prefab` e
`genericradiusmarker.prefab` **existem nos bundles reais** do servidor —
conferidos por `grep` em `Servers/server01/Bundles/shared`.

**Os dois hooks caros nascem desinscritos.** O Oxide registra todo hook cujo
método existe na classe: sem `Unsubscribe` no boot, o `OnItemAddedToContainer` e
o `OnPlayerInput` — que dispara **a cada quadro, para cada jogador** — rodariam
em todo servidor, inclusive nos que não têm missão de loot nem NPC nenhum.

> **DUAS CORREÇÕES QUE ESTA FRENTE CUSTOU, E VALE DIZER QUAIS.**
>
> 1. **O `origemz.ui.open` recusa comando vindo do cliente** (`arg.Connection !=
>    null`) — de propósito, para um jogador não abrir a tela de outro — e abria
>    **sempre na tela de entrada**. O plugin não podia mandá-lo. O fluxo virou:
>    o plugin GRITA, o agente confere que o NPC existe **naquele servidor** e
>    manda o comando com a autoridade dele. Uma ida a mais, e a conferência que
>    ela paga vale.
> 2. **Um teste do ranking guardava que `OnItemAddedToContainer` não existia no
>    plugin** — "não há hook de posse: só o que passou pela bancada conta". A
>    promessa era por AUSÊNCIA, e as missões precisaram do hook. Ela **mudou de
>    forma, não de conteúdo**: o recorte daquele teste agora termina onde a
>    região das missões começa, e um teste NOVO prova o que importa — o hook de
>    loot existe, chama só o contador das missões, e não encosta em
>    `BumpMetric`, `AddOre`, `BumpPlayerMetric` nem `AddSeq`.

**O que ficou de fora, e é honesto dizer:** o marcador do mapa é um **círculo**
(`MapMarkerGenericRadius`), e não um rótulo com nome. O rótulo seria
`VendingMachineMapMarker`, que — MEDIDO na DLL — exige uma `VendingMachine` de
verdade por trás (`SetVendingMachine(vm, shopName)`): uma entidade invisível a
mais no mundo, por NPC, para um texto. O círculo diz onde, e o jogador vê o nome
ao chegar.

**A entrega ficou pendente nesta frente e foi fechada em seguida — ver §15.10.**


### 15.10 A varredura dos órfãos: o que estava declarado e não ligado

Fechada em 06/09/2026, depois das sete frentes. Suíte do `core`: **1 654 testes,
80 arquivos**; os dois plugins compilam com zero erros.

A entrega (`deliver`) ficara em aberto por escrito. Ao fechá-la, uma varredura
por símbolos exportados e nunca chamados encontrou **mais três buracos do mesmo
tipo** — e um deles era o pior de todos.

| Buraco | O que acontecia | Gravidade |
|---|---|---|
| **`buildAssignCommand` nunca era chamado** | o plugin **nunca soube o que cada jogador persegue**. `_questAssigned` ficava vazio, o `QuestCount` saía na primeira comparação e **`kill`, `gather`, `craft`, `loot` e `deliver` não contavam nada** | **o módulo inteiro estava morto no jogo** |
| **`autoAcceptFor` sem gatilho** | a missão `auto_accept` nunca abria sozinha | a diária não existia |
| **`origemz.quest.consume` declarado e não implementado** | o campo `consume` estava no painel, no schema e na migração **sem fazer nada** — o jogador ficava com o material E com o prêmio | o mesmo erro do `blueprint`, que eu havia retirado |
| **Nada tratava o `#OZAREQ#quests`** | um `oxide.reload` esvaziava o plugin **sem o agente notar** — e o cache daqui continuava achando que tinha mandado | silencioso e permanente |

**Os quatro foram fechados no coletor**, que já tem a presença e o RCON. A
rodada de cada jogador ganhou três passos, e **a ordem entre eles importa**:

1. `autoAcceptFor` — a diária tem de existir antes de ser mandada;
2. `refreshDerived` — `playtime` e `metric` podem ter fechado, e missão
   concluída sai do `assign`;
3. `pushAssign` — o que sobrou.

Inverter 1 e 3 faria a diária de hoje só chegar ao plugin na rodada seguinte:
quinze segundos em que minerar não contava.

E o `assign` ganhou um gatilho imediato (`onLiveChanged`): aceitar, cancelar ou
resgatar avisa o coletor, que esquece o cache daquele jogador. **O serviço avisa;
ele não manda o comando** — chamar RCON de dentro dele poria uma ida à rede no
meio de uma transação.

> **UM DETALHE DO CONTRATO QUE UM TESTE PEGOU.** O `meters` do push de entrega
> tinha `max(20_000)`, e um valor acima **recusava o push inteiro** — a entrega
> simplesmente não acontecia. Um campo que o agente **IGNORA** (a distância quem
> mede é ele, das coordenadas do banco) não pode ter poder de veto sobre o que
> ele usa. Virou `.catch(undefined)`.

**A entrega, fechada:** o plugin manda o pacote quando o jogador aperta USE no
NPC de destino; o agente confere o CONTRATO (existe um objetivo de entrega,
nesta tentativa, apontando para ESTE NPC?) e marca. A distância da recompensa
`perMeter` é medida pelo agente entre os dois NPCs, em X/Z — a altura de um
monumento não é caminho andado.


### 15.11 O fechamento: a segunda varredura, e o que ela encontrou

Feita em 06/09/2026, depois de §15.10. Estado final: **core 1 658 testes / 80
arquivos**, **painel 150 testes** e `next build` limpo, **os dois plugins com
zero erros** contra as DLLs reais.

A varredura de §15.10 procurou funções nunca chamadas. Esta procurou **colunas,
campos e rotas sem consumidor** — o mesmo defeito, visto de outro ângulo. Achou
mais seis.

| O que | O que acontecia | Como fechou |
|---|---|---|
| **O wipe do mundo não tocava nas missões** | `wipe_policy` de `quests` E de `quest_npcs` — duas colunas, o painel, a migração — **não faziam nada**. O jogador entrava no mundo novo com a missão de minerar já pela metade | `WipeQuests` no `wipe/run.ts`, no passo pós-wipe |
| **`assign` só no ciclo** | quem conectava esperava até 15 s (ou o `flushSeconds` do servidor) — o primeiro minuto de jogo não contava | `onPlayerJoined` no gancho de presença |
| **`npc.kind` só declarado** | `'quest'` e `'delivery'` não mudavam nada | um NPC de entrega **não oferece missões**, e a rota recusa prendê-lo a uma |
| **A quest órfã sumia de tudo** | o comentário do `removeNpc` prometia "volta a ser uma quest de menu" e o código **não fazia isso**: some do menu por ter `npcId`, e do NPC que não existe | `offersFor` trata NPC inexistente como "sem NPC" |
| **A configuração por servidor sem tela** | `maxActive`, `flushSeconds`, `lootEnabled` e `resetAtMinute` na API e no banco, **sem onde mudar** | `quest-settings.tsx`, em Manutenção |
| **O NPC só podia ser apagado** | nome, papel, alcance, marcador e `wipe_policy` sem edição | `NpcEditor`, e a auditoria e o "conceder" também ganharam tela |

E uma duplicata: **`DEFAULT_NPC_PREFAB` existia e o `npc-sync.ts` repetia a
string** — duas verdades sobre o mesmo prefab.

**O critério que fecha o módulo**, e que vale para quem continuar daqui:

> Nada declarado sem consumidor. Um método de cliente que ninguém chama, uma
> coluna que nenhum caminho lê e um tipo que ninguém importa são todos a mesma
> coisa: **uma promessa de que alguma coisa usa aquilo.**

Foi por isso que saíram do contrato: `LIVE_QUEST_STATUSES`, `questSteamIdSchema`,
os cinco aliases de recompensa (`ItemReward` e irmãos), os dois `Draft`
derivados, e — do cliente do painel — `quest(id)` e `questOffers()`, que são do
site e da tela do jogo, não dele.

**As duas varreduras juntas encontraram dez buracos**, e o primeiro deles
(§15.10) significava que o módulo estava **morto no jogo** apesar de tudo
compilar e 1 641 testes passarem. Os testes cobriam cada peça; nenhum cobria a
ligação entre elas. É a lição que este documento leva.


### 15.12 O primeiro teste no servidor de verdade, e o que ele encontrou

06/09/2026, no `server01` local, com o dono jogando.

**O erro que ele viu** — `RCON command timed out after 5000ms:
origemz.quest.watch`, repetido a cada rodada — **não era do agente**: o plugin
que estava RODANDO (`Servers/server01/oxide/plugins/OrigemZAgent.cs`, de 15h46)
era a versão anterior, sem a região `Quests`. Um comando que o plugin não
conhece não responde nada, e o RCON espera os 5 s inteiros.

> **UMA LIÇÃO DE DESENHO QUE ISTO EXPÔS.** Um agente novo contra um plugin
> velho custa **5 s de timeout por rodada, para sempre**, e enche o log. O
> coletor do ranking se protege perguntando `pluginLoaded` antes; o de missões
> não. Enquanto isso não existir, trocar o agente sem trocar o plugin é uma
> combinação que grita e não se conserta sozinha.

**O que faltava para o `/quest` funcionar, e ninguém tinha notado:** o preset
`menu-quests` existia em `UI_PRESETS`, mas **o DOCUMENTO nunca era criado no
banco**. Sem ele, o `OrigemZUI` não registra o comando de chat — e digitar
`/quest` no jogo devolve `unknown command`.

O `menu-principal` tem o mesmo desenho e não sofre disso porque alguém já o
criou pela tela de Interface, uma vez. Para as missões, ficou
`core/scripts/quests-seed.ts`: ele cria o documento a partir do preset, liga ao
servidor e semeia seis missões de teste — uma de cada forma de objetivo que
funciona hoje, com quantidades pequenas de propósito.

**E uma pegadinha do script, medida na hora:** `data/rustagent.db` relativo,
rodado de dentro de `core/`, cria um banco VAZIO em `core/data/` — e a primeira
gravação falha com `FOREIGN KEY constraint failed`, porque o servidor não existe
nele. O caminho passou a ser resolvido a partir da raiz.

**Confirmado vivo pelo RCON**, com o plugin novo no lugar:

```
origemz.quest.diag
{"ok":true,"contract":1,"lootHooked":true,"watchedKinds":4,
 "assignedPlayers":0,"openEntries":0,"pending":0}
```

`watchedKinds: 4` são os alvos das seis missões semeadas; `lootHooked: true` é o
hook do "Catador" ligando o `OnItemAddedToContainer` — a contenção do §5.4
funcionando como escrita.


### 15.13 O segundo teste, e a decisão de design que ele trouxe

06/09/2026, com a tela abrindo no jogo pela primeira vez.

**O `/quest` abriu — e ficou em "Carregando as suas missões…" para sempre.**

A causa é uma regra do `OrigemZUI` que ninguém tinha esbarrado: o `OpenScreen`
**desenha a tela que está no documento e só pede ao agente o que não tem**. A
carga inicial sempre leva a tela de ENTRADA junto — então uma entrada montada
pelo agente nunca era pedida, e o repouso ficava na tela.

> **O RANKING TEM O MESMO DESENHO.** A `tela-ranking` também está gravada no
> documento e também é montada pelo agente. Ela escapa só porque é aberta por
> um CLIQUE na aba, e não como entrada — mas o dia em que alguém fizer um
> `/ranking` que abre direto nela, o defeito aparece igual.

**A correção:** a tela ganhou o campo `generated` (`types/ui-document.ts`), que
viaja no pacote e no índice, e o plugin passou a **desenhar o repouso E pedir a
de verdade** quando ele está marcado. São seis linhas no `OrigemZUI.cs` e um
campo opcional no schema — `.optional()` e não `.default(false)`, senão todo
construtor de tela do projeto teria de informar "não".

**E a decisão de design, pedida pelo dono:** *"o design tem que ser padrão,
seguir o design que já temos na página menu"*.

A primeira versão do `menu-quests` desenhava uma moldura PRÓPRIA — janela de
720×520, cabeçalho e botão de fechar. Funcionava, e estava errada: o jogo
passava a ter **duas molduras, dois jeitos de fechar e dois lugares para
consertar** quando o estilo mudasse. E o menu de missões não mostrava saldo nem
VIP, que o cabeçalho do menu já sabe mostrar.

Agora `buildQuestsMenu()` **é** o `buildMainMenu()`, com duas diferenças:
`command: 'quest'` e `entryScreenId: 'tela-quest'`. O menu principal ganhou a
aba **MISSÕES** ao lado de RANKING, montada do mesmo jeito que ela.

O custo é real e foi aceito: dois documentos com o mesmo shell viajam na carga
inicial. A alternativa era um `/quest` com outra cara.

---

### 15.14 O terceiro teste: a tela que ninguem conseguia usar

Data: 06/09/2026, no `server01`, com o dono clicando.

O dono pediu cinco coisas de uma vez: missoes no `/menu`, `/quest` abrindo
direto na pagina, as tres listas numa **barra lateral**, **paginacao** (o CUI
nao tem rolagem), um **modal de detalhe** e o **abandonar**. E abriu com uma
frase que era um relatorio de defeito: *"e os botao nao esta funcionado, nao
consigo ir para quest Disponivel"*.

#### O defeito que 1 686 testes verdes nao viam

O plugin guarda o endereco que pediu e descarta a resposta cujo id nao bate:

```csharp
if (session.PendingScreenId != screen.Id) return;   // OrigemZUI.cs
```

Existe por um bom motivo — o jogador pode ter navegado enquanto a tela vinha.
E o `buildQuestsScreen` carimbava `tela-quest` em **toda** resposta, ignorando
o id pedido. O clique em DISPONIVEIS pedia `tela-quest:disponiveis`, recebia
`tela-quest`, e o plugin jogava fora **em silencio**.

Nenhum botao daquela tela funcionava. Nenhum erro, em lugar nenhum. O ranking
escapou por acidente: ele ja devolvia `options.screenId`.

**A regra, agora com teste:** *uma tela gerada responde com o id que foi
pedido.* Vale para toda familia de telas do agente.

#### O segundo, que so o log do servidor pegou

Corrigido o id, o dono voltou: *"sidebar nao muda"*. O log do Oxide foi quem
respondeu — `tela-missoes:det:1` e `quest:claim:1` apareciam nele, e
`tela-missoes:disponiveis` **nunca**. O clique nao virava nem pedido.

O culpado era o numero da contagem ao lado do rotulo. Ele era irmao do botao e
declarado **depois** — e no CUI a ordem da lista e a profundidade. No Unity o
texto tem `raycastTarget` ligado: o rotulo transparente cobria o item inteiro e
**engolia o clique**.

O mais amargo: esse comentario ja estava escrito no arquivo, sobre nao pendurar
o rotulo NO botao. A armadilha e a mesma; so mudou o parentesco.

**A regra:** *nada por cima de um botao — nem filho, nem irmao.* O botao
termina onde o numero comeca.

#### E a duplicata que o dono viu antes de mim

`/quest` precisava de outro comando de chat, e comando de chat nascia do
`command` do documento. A primeira versao resolveu **clonando o menu inteiro**
— mesmo shell, mesmas onze telas, outro comando. Funcionava.

O dono abriu a tela de Interface e viu dois "Menu" de onze telas cada:
*"excluir o menu-quests"*. Estava certo — o servidor recebia duas copias do
mesmo shell em toda carga, e todo ajuste de estilo tinha dois lugares.

O documento ganhou `shortcuts`: `{ command, screenId }`. O plugin registra o
comando extra e abre naquela tela; o resto e o mesmo menu, porque e o mesmo.
Custou uma linha no preset, um campo no schema e ~30 no `OrigemZUI.cs`.

Junto foi o nome: a pagina virou `tela-missoes` / "MISSOES", ao lado de
`tela-ranking` e `tela-eventos`. Ela estava listada como "Missoes" no meio dos
modais, e foi assim que o dono a encontrou.

#### O design: copiar, e nao parecer

Pedi licenca poetica na barra lateral e o dono cortou: *"usa o sidebar do
ranking, que e design bonito"* — e depois, mais direto: *"quando eu falo usar e
copiar"*.

As medidas agora sao as de `ui-ranking-screen.ts`, numero por numero: coluna de
210 px pintada em `surface-2` (o fundo dela E a divisoria, um elemento a menos
que uma regua), item da vez mais **escuro** que a coluna com barra vermelha de
3 px, hover que **escurece** na direcao do item aberto.

Duas colunas parecidas mas nao iguais e pior que uma so: o olho nota os 4 px e
ninguem sabe qual e a certa.

#### O card que se encavalava

Titulo e frase eram medidos do topo; a recompensa, do fundo. Num bloco de 58 px
as duas ultimas se cruzavam, e "1 pts" saia escrito por cima de "Concluida —
toque em RESGATAR".

Agora as quatro faixas sao medidas do mesmo lado, cada uma comecando onde a
anterior termina. E "1 pts" virou "1 ponto": o plural sai da quantidade.

#### O que ficou

| Pedido | Onde |
|---|---|
| MISSOES no `/menu` | `NAV` de `ui-preset-main-menu.ts` |
| `/quest` na pagina | `shortcuts` do documento |
| Barra lateral | `sidebar()`, medidas do ranking |
| Paginacao | `rowsPager` ancorado no **rodape** |
| Modal de detalhe | `tela-missoes:det:<pq>` e `:info:<questId>`, `kind: 'modal'` |
| Abandonar | `quest:cancel:<pq>`, so enquanto esta em andamento |

O detalhe nao busca a tentativa pelo id: o endereco vem do CLIENTE, e um numero
forjado apontaria para a missao de outra pessoa. Ele procura o id **dentro da
lista de quem pediu** — quem nao e dono nao acha.

## 16 — As armadilhas medidas neste projeto que valem aqui

Todas já custaram caro aqui. Nenhuma é hipotética.

1. **O laço do console.** Um comando de RCON mandado de dentro do `onConsoleLine`
   imprime, a linha volta pelo mesmo caminho e dispara de novo. O console virou
   um paredão de `loadout.sync` no dia em que isso aconteceu
   (`core/src/index.ts:309-319`). **Regra: nada sai da pilha do gancho — arme um
   relógio.**

2. **O `oxide.reload` que o agente não vê.** Ele esvazia o cache do plugin sem
   derrubar o RCON. Para o agente, nada aconteceu, e ele não reenvia. Daí o
   `#OZAREQ#` e o reenvio periódico (`ui-sync.ts:114-120`).

3. **O que o jogador não pode ver não atravessa o RCON.** O recorte é antes do
   desenho, não no desenho (`ui-calendar-screen.ts:24-36`).

4. **A tela estourada não dá erro: ela não abre.** Teste de tamanho no pior
   caso, ou não fechou.

5. **A entrega que falha depois do "deu certo".** Marcar antes de entregar, e a
   pendência visível (§6.4).

6. **O chat passa pelo mesmo cano dos marcadores.** Segredo em todo push, sem
   exceção (`stat-events.ts:59-63`).

7. **`PLUGIN_INVALID_RESPONSE` nunca vira lista vazia.** "Ninguém minerou" e
   "não consegui perguntar" são respostas diferentes.

8. **O heredoc come a barra invertida.** `Docs\20` num comentário vira o byte
   `0x10` e o texto some. Use `chr(92)` ou a ferramenta de edição.

9. **`.claude/` não está no `.gitignore`.** As worktrees dos subagentes moram
   dentro do repo; `git add -A` aqui é armadilha.

10. **O agente de produção roda em outra máquina.** `C:\OrigemZ\RustAgent` não
    existe nesta sessão. O `Servers/server01` local sobe em ~49 s e compila os
    `.cs` — é onde a frente C e a F se medem.

---

## 17 — Medido, conferido, projeto

Separado de propósito, porque a diferença importa quando alguém for conferir.

### 17.1 MEDIDO — rodado contra o disco em 06/09/2026

| O quê | Como | Resultado |
|---|---|---|
| `NPCTalking`, `NPCShopKeeper`, `MapMarkerGenericRadius`, `VendingMachineMapMarker` existem | Mono.Cecil contra `Assembly-CSharp.dll` da instalação real | existem, com os campos de §10.1 |
| `BaseMission` não serve | idem | `BaseMission : BaseScriptableObject` — asset, não código |
| Não há hook de conversa no Oxide | `grep` em `Oxide.Rust.dll` | só `OnNpcTarget` |
| O `HumanNPC` não está instalado | `ls Servers/server01/oxide/plugins/` | onze plugins, nenhum deles |
| Os hooks de objetivo já rodam | `grep` em `Plugins/OrigemZAgent.cs` | `:4501`, `:4532`, `:4567`, `:4835`, `:5558` |
| O comando de chat nasce do documento | `Plugins/OrigemZUI.cs:643` | `RegisterChatCommand(entry.Key)` |
| A ação `store.buy` é o canal do botão | `core/src/types/ui-document.ts:177` | e os kits já pegam carona (`index.ts:1258`) |
| A última migração é a 045 | `core/src/db/migrations.ts:4245` | 046 e 047 livres |

### 17.2 CONFERIDO — lido, não executado

- O `Quests.cs` inteiro, 3 460 linhas. As citações de §2 são de linha.
- O `stats-contract.ts`, o `stat-events.ts` e o `custom-items-sync.ts`: os três
  desenhos que este plano copia de propósito.
- O `ui-ranking-screen.ts` e o `ui-sync.ts`: o padrão de tela montada pelo
  agente.

### 17.3 PROJETO — decidido aqui, ainda não construído

Tudo o mais. Em particular, três coisas que só a construção vai fechar:

1. **O custo real do `OnPlayerInput`** com N NPCs (§10.2). O número sai do
   `diag`, e é ele que decide se a detecção fica no input ou vira um
   `timer.Every` de proximidade.
2. **O custo real do `OnItemAddedToContainer`** com o `Looters` podado (§5.4).
   Mesma decisão, mesmo instrumento.
3. **Quantas quests cabem na página** (§13.5). Seis é a estimativa; o teste do
   pior caso é quem manda.
