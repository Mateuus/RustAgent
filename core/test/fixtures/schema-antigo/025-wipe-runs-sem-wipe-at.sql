-- ============================================================
--  025 — como ela era ANTES da coluna `wipe_at`
--
--  ####  ISTO NAO E SCHEMA DESTE AGENTE  ####
--
--  E o registro de um schema que EXISTIU em bancos de verdade e
--  que nenhum agente de hoje produz. Ele nao vem do codigo: foi
--  extraido do `sqlite_master` do banco de desenvolvimento que
--  parou de subir com `no such column: wipe_at`, tirando dele
--  apenas o `, map_decision TEXT` que a migracao 029 pendurou
--  depois (no teste a 029 roda por conta propria, como no banco
--  de verdade).
--
--  Como ele nasceu: a migracao 025 foi APLICADA num banco em
--  2026-08-18 23:38 e so DEPOIS ganhou a coluna `wipe_at`, no
--  commit ef21855, das 00:12 do dia seguinte. O runner nunca
--  reaplica um id que ja consta em `schema_migrations` — e por
--  isso aquele banco ficou com a 025 marcada como aplicada e sem
--  a coluna, para sempre, ate a migracao de conserto.
--
--  Quem lê isto porque vai editar uma migracao ja aplicada:
--  guarde aqui o texto de ANTES e escreva uma migracao NOVA. Ver
--  core/test/schema-banco-antigo.test.ts.
-- ============================================================

CREATE TABLE wipe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O wipe da agenda que virou esta execução. NULL = "WIPAR
  -- AGORA", que não sai de plano nenhum.
  plan_id INTEGER REFERENCES wipe_plans(id) ON DELETE SET NULL,

  -- O `op_xxxxxxxx` do OperationStore ENQUANTO ele existe. Depois
  -- do restart ele aponta para nada, e é justamente assim que o
  -- boot descobre a execução órfã: linha `running` cuja operação
  -- não está mais viva.
  operation_id TEXT,

  -- ####  O QUE IMPEDE O DUPLO-CLIQUE DE ZERAR DUAS VEZES  ####
  --
  -- A `Idempotency-Key` do POST. O índice único abaixo é a
  -- garantia de verdade: duas requisições idênticas correndo
  -- juntas não se enxergam na consulta, mas a segunda esbarra no
  -- índice — e aí a rota devolve a execução que já existe, em vez
  -- de começar outra.
  idempotency_key TEXT,

  kind TEXT NOT NULL CHECK (kind IN ('cadence', 'forced', 'manual')),

  bp_policy TEXT NOT NULL DEFAULT 'keep'
    CHECK (bp_policy IN ('keep', 'wipe', 'wipe_except_vip')),

  -- O full wipe é um MODO, e não uma quarta política de
  -- blueprint: ele acrescenta a lista de dados de plugin ao que
  -- a política já apaga.
  full_wipe INTEGER NOT NULL DEFAULT 0 CHECK (full_wipe IN (0, 1)),

  started_at INTEGER NOT NULL,
  finished_at INTEGER,

  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'failed', 'cancelled')),

  -- O zip. NULL = não houve backup (desligado, ou não chegou lá).
  backup_path TEXT,

  -- JSON do mundo de ANTES e do de DEPOIS: seed, tamanho, level.
  -- Guardados na linha, e não por id da fila, porque a entrada da
  -- fila pode ser apagada e a pergunta "com que seed o servidor
  -- rodou naquele mês?" continua tendo de ter resposta.
  map_before TEXT,
  map_after TEXT,

  -- O `SaveCreatedTime` lido antes e depois. Os dois iguais no
  -- fim é um wipe que RELATOU sucesso sem ter trocado o mundo.
  save_created_before INTEGER,
  save_created_after INTEGER,

  -- A frase do desfecho, na língua de quem lê a tela.
  message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_wipe_runs_idempotency
    ON wipe_runs (server_id, idempotency_key)
 WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_wipe_runs_server ON wipe_runs (server_id, started_at DESC);

CREATE TABLE wipe_run_steps (
  run_id INTEGER NOT NULL REFERENCES wipe_runs(id) ON DELETE CASCADE,

  -- Sem acento de propósito: o valor viaja em chave primária, em
  -- JSON de rota e em nome de passo no log. Ver WIPE_RUN_STEPS em
  -- types/wipe.ts.
  step TEXT NOT NULL CHECK (step IN (
    'avisar', 'esvaziar', 'parar', 'backup', 'apagar',
    'configurar', 'subir', 'pos-wipe'
  )),

  -- A ordem de execução, gravada na linha. A tela desenha por ela
  -- em vez de conhecer a sequência: um passo novo no meio, um dia,
  -- não exige tocar no painel.
  position INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),

  started_at INTEGER,
  finished_at INTEGER,

  -- O que aquele passo fez, ou por que não fez. É a linha que a
  -- tela mostra ao lado do ✔.
  message TEXT,

  PRIMARY KEY (run_id, step)
);

CREATE TABLE wipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O `SaveCreatedTime` do `serverinfo`, em epoch ms: a hora em
  -- que aquele mundo NASCEU. É a identidade do mundo, e por isso
  -- é ele que carrega o índice único.
  save_created_at INTEGER NOT NULL,

  level TEXT,

  -- TEXTO, como em `map_pool.seed`, e pelo mesmo motivo: ela é
  -- comparada e exibida, nunca somada.
  seed TEXT,

  world_size INTEGER,

  -- Quando o AGENTE viu. Diferente de `save_created_at` sempre
  -- que o mundo nasceu com o agente parado.
  detected_at INTEGER NOT NULL,

  -- A execução que criou este mundo. NULL = apareceu sem o agente
  -- ter mandado (wipe na mão, servidor adotado com mundo velho) —
  -- e registrar isso é o que impede a agenda de mentir.
  wipe_run_id INTEGER REFERENCES wipe_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_wipes_world ON wipes (server_id, save_created_at);

CREATE INDEX idx_wipes_recent ON wipes (server_id, detected_at DESC);
