-- ============================================================
--  A migração 034 COMO ELA ERA, antes de 06/09/2026.
--
--  Extraída do banco de produção (Backups/rustagent-antes-migracao-043-*),
--  que é a prova de que este schema existiu numa máquina de verdade.
--
--  Três coisas NÃO estão aqui, e é isso que o teste prova:
--    - rankings."window"
--    - ranking_settings.season_on_wipe
--    - ALTER TABLE wipe_runs ADD COLUMN open_ranking_season
--
--  Elas entraram no texto da 034 DEPOIS de ela já ter rodado — o
--  erro que a migração 043 conserta. Não edite este arquivo: ele
--  é o registro do que aconteceu, não um schema a manter.
-- ============================================================

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

  -- Quantas posições o pódio congela ao fechar (§5.4).
  snapshot_size INTEGER NOT NULL DEFAULT 50 CHECK (snapshot_size > 0),

  updated_at INTEGER NOT NULL,

  CHECK (season_mode <> 'days' OR season_days IS NOT NULL)
);

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
  --   'item'     — a ação 'points' de um item custom
  --   'computed' — não tem linha em player_stats; é derivado
  --                na leitura de outras métricas (K/D)
  source TEXT NOT NULL CHECK (source IN ('plugin','agent','item','computed')),

  -- 'counter' soma em player_stats; 'record' mora em
  -- player_records; 'ratio' é calculado.
  value_kind TEXT NOT NULL CHECK (value_kind IN ('counter','record','ratio')),

  direction TEXT NOT NULL DEFAULT 'desc' CHECK (direction IN ('desc','asc')),

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

CREATE INDEX idx_ranking_snapshots_player ON ranking_snapshots (steam_id, metric);

CREATE INDEX idx_rankings_visible ON rankings (enabled, sort_order);

INSERT INTO rankings
  (id, metric, label, unit, description, source, value_kind, direction,
   global_eligible, builtin, enabled, sort_order, created_at, updated_at)
VALUES
  ('abates', 'pvp.kills', 'Abates', 'abates', 'Cada jogador que voce abate conta um ponto.', 'plugin', 'counter', 'desc', 1, 1, 1, 10,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('mortes', 'pvp.deaths', 'Mortes', 'mortes', 'Quantas vezes voce morreu para outro jogador.', 'plugin', 'counter', 'desc', 1, 1, 1, 20,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('kd', 'pvp.kd', 'K/D', NULL, 'Abates divididos por mortes, com correcao para quem jogou pouco.', 'computed', 'ratio', 'desc', 1, 1, 1, 30,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('tempo-online', 'time.played', 'Tempo online', 'segundos', 'Tempo que voce passou dentro do servidor nesta janela.', 'agent', 'counter', 'desc', 1, 1, 1, 40,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('tiro-longo', 'shot.distance', 'Tiro mais longo', 'metros', 'O abate mais distante que voce conseguiu.', 'plugin', 'record', 'desc', 1, 1, 1, 50,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio', 'ore.total', 'Minério', 'unidades', 'Tudo o que voce minerou, somado.', 'plugin', 'counter', 'desc', 0, 1, 1, 60,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-enxofre', 'ore.sulfur', 'Enxofre', 'unidades', 'Enxofre minerado nesta janela.', 'plugin', 'counter', 'desc', 0, 1, 1, 61,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-metal', 'ore.metal', 'Metal', 'unidades', 'Minério de metal minerado nesta janela.', 'plugin', 'counter', 'desc', 0, 1, 1, 62,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-pedra', 'ore.stone', 'Pedra', 'unidades', 'Pedra minerada nesta janela.', 'plugin', 'counter', 'desc', 0, 1, 1, 63,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-hqm', 'ore.hqm', 'Metal puro', 'unidades', 'Minério de metal puro minerado nesta janela.', 'plugin', 'counter', 'desc', 0, 1, 1, 64,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('explosivo', 'explosive.seq', 'Poder de raid', 'enxofre eq.', 'O que voce detonou, convertido em enxofre equivalente.', 'plugin', 'counter', 'desc', 0, 1, 1, 70,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000);
