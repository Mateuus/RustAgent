// ============================================================
//  migrations.ts  -  o schema do banco, em passos numerados.
//
//  Cada passo roda UMA vez, na ordem, dentro de uma transação, e
//  fica registrado em `schema_migrations`. Chamar `runMigrations`
//  num banco já em dia não faz nada — é essa propriedade que
//  permite chamá-la sempre no boot, sem ninguém precisar saber se
//  o banco é novo ou velho.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO COMEÇA DO ZERO  ####
//
//  O projeto anterior chegou à migração 035, e as trinta e quatro
//  primeiras descrevem tabelas que a Fase 1 não tem (loja, VIP,
//  jogadores, propagandas, wipe). Copiá-las traria um banco cheio
//  de tabelas vazias que ninguém lê — e a obrigação de mantê-las
//  compilando.
//
//  As fases seguintes acrescentam migrações NOVAS aqui embaixo,
//  numeradas a partir da 002. Ver Docs\09-ROADMAP.md.
//
//  ------------------------------------------------------------
//  Convenções:
//
//    - datas são INTEGER com epoch em MILISSEGUNDOS, e não TEXT
//      ISO: é o que `Date.now()` produz e o que ordena sem
//      conversão. A borda HTTP formata para ISO na saída;
//    - booleano é INTEGER 0/1 com CHECK: o SQLite não tem tipo
//      booleano, e o better-sqlite3 recusa `true`/`false` como
//      parâmetro;
//    - toda coluna que aponta para um servidor referencia
//      `servers(id)` com `ON DELETE CASCADE`.
// ============================================================

import type { Logger } from '../logger.js';
import type { AgentDatabase } from './database.js';

export interface Migration {
  /** Ordem de aplicação. Único e crescente. */
  readonly id: number;
  /** Só para o log e para quem lê a tabela de controle. */
  readonly name: string;
  readonly sql: string;
}

// ------------------------------------------------------------
//  001 — os servidores
//
//  ####  ESTA TABELA É UM ESPELHO, E NÃO A FONTE  ####
//
//  Quem manda no que um servidor É continua sendo o
//  `Configs\<id>.ini` (ver Docs\02-ARQUITETURA.md): ele é
//  editável à mão, sobrevive a um banco apagado e é o formato que
//  quem administra o servidor já entende.
//
//  A tabela existe para o que o arquivo faz mal: responder rápido
//  a "quais servidores existem, com que portas", numa consulta só
//  em vez de N leituras de disco, e ser o alvo das chaves
//  estrangeiras das fases seguintes (entregas, VIP, wipe).
//
//  A reconciliação acontece no boot e a cada mudança pelo painel.
//  Divergiu, o `.ini` ganha.
//
//  ####  A SENHA DE RCON É NULA AQUI  ####
//
//  Ela mora no `.ini`, e o runtime a lê de lá. A coluna existe
//  porque a criação pelo painel PODE querer guardá-la um dia —
//  mas hoje ela fica vazia de propósito: uma segunda cópia do
//  segredo é uma segunda cópia para vazar, e esta iria junto em
//  todo backup do banco.
//
//  ####  OS QUATRO UNIQUE  ####
//
//  Duas linhas com a mesma porta são dois servidores que não
//  sobem juntos — o segundo carrega o mundo inteiro e fica sem
//  aparecer na lista da Steam, sem erro nenhum. Recusar no banco
//  é o que transforma isso num 409 na hora do cadastro.
//
//  `identity` também é único: ela nomeia a pasta de saves DENTRO
//  da instalação, e duas iguais em instalações diferentes não
//  colidem em disco — mas colidem na cabeça de quem opera, e o
//  custo de proibir é zero.
// ------------------------------------------------------------
const SERVERS_SCHEMA = `
CREATE TABLE servers (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  identity TEXT NOT NULL UNIQUE,

  -- O agente cuida deste servidor? Espelha SERVER_ENABLED.
  -- Repare que LIGADO não quer dizer NO AR: ligado é o agente
  -- montar o contexto e conectar o RCON; subir o jogo é a
  -- operação server-start.
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),

  game_port  INTEGER NOT NULL UNIQUE,
  rcon_port  INTEGER NOT NULL UNIQUE,
  query_port INTEGER NOT NULL UNIQUE,
  app_port   INTEGER NOT NULL UNIQUE,

  -- Sempre 127.0.0.1 hoje: o agente roda na mesma máquina do
  -- servidor. A coluna existe para o dia em que não rodar.
  rcon_host TEXT NOT NULL DEFAULT '127.0.0.1',

  -- Ver o cabeçalho: fica NULL. A senha mora no .ini.
  rcon_password TEXT,

  -- Onde o SteamCMD instalou (Servers\\<id>\\). Guardado, e não
  -- deduzido, porque SERVERS_DIR pode mudar no .env — e uma
  -- instalação de 30 GB não se move junto.
  install_dir TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A listagem do painel ordena por nome; o índice evita o sort a
-- cada abertura de tela.
CREATE INDEX idx_servers_name ON servers (name COLLATE NOCASE);

-- ----------------------------------------------------------
--  meta — pares chave/valor do próprio agente.
--
--  Hoje guarda uma coisa só: a versão que migrou o banco pela
--  última vez, escrita por db/schema-version.ts. Ela é o que
--  responde "qual agente mexeu aqui por último" quando um banco
--  aparece com schema de um binário que não é o que está rodando.
-- ----------------------------------------------------------
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// ------------------------------------------------------------
//  002 — a biblioteca de plugins
//
//  ####  O AGENTE É O DONO DO .cs; O SERVIDOR SÓ ATIVA  ####
//
//  Antes desta migração cada servidor tinha a própria cópia solta
//  dos mesmos arquivos: atualizar um plugin em cinco servidores era
//  subir o mesmo `.cs` cinco vezes, e ninguém sabia dizer se as
//  cinco cópias eram iguais.
//
//  `plugins` é a biblioteca — UMA linha por `.cs`, e o arquivo mora
//  em `Plugins\` na raiz do projeto. `server_plugins` é o que CADA
//  servidor ativou dela.
//
//  ####  OS DOIS sha256 RESPONDEM PERGUNTAS DIFERENTES  ####
//
//    plugins.sha256              o que a BIBLIOTECA tem hoje
//    server_plugins.applied_sha  o que está EM DISCO naquele
//                                servidor
//
//  Divergiram, há atualização para aplicar. Sem o segundo, a única
//  forma de responder isso seria reler e resumir o arquivo de cada
//  servidor a cada abertura de tela — e a resposta ainda mudaria
//  sozinha quando alguém copiasse um `.cs` à mão.
//
//  ####  DESLIGAR NÃO APAGA A LINHA  ####
//
//  `enabled = 0` com a linha viva é o que preserva a memória de que
//  aquele servidor JÁ USOU o plugin. Apagar a linha faria "desliguei
//  para testar" e "nunca usou" ficarem indistinguíveis — e essa é a
//  diferença entre voltar atrás num clique e reconfigurar do zero.
// ------------------------------------------------------------
const PLUGINS_SCHEMA = `
CREATE TABLE plugins (
  -- "OrigemZPlayer", sem o .cs: é o que o \`oxide.reload\` recebe.
  -- Único por definição — o Oxide não carrega dois plugins com o
  -- mesmo nome.
  name        TEXT PRIMARY KEY,
  file        TEXT NOT NULL,

  -- Lidos do [Info(...)] e do [Description(...)] do próprio .cs.
  -- NULL quando o arquivo não os declara, o que é comum em plugin
  -- de uso interno e não é erro.
  title       TEXT,
  author      TEXT,
  version     TEXT,
  description TEXT,

  bytes       INTEGER NOT NULL,
  -- É o que responde "mudou?". Ver o cabeçalho.
  sha256      TEXT NOT NULL,

  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE server_plugins (
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL REFERENCES plugins(name) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- O sha256 do que está EM DISCO naquele servidor. NULL com o
  -- plugin desligado: não há arquivo lá para resumir.
  applied_sha TEXT,
  applied_at  INTEGER,

  PRIMARY KEY (server_id, plugin_name)
);

-- A tela da biblioteca pergunta "em quantos servidores este plugin
-- está ativo?" para CADA linha listada. Sem o índice, cada pergunta
-- dessas varre a tabela inteira.
CREATE INDEX idx_server_plugins_plugin ON server_plugins (plugin_name);
`;

// ------------------------------------------------------------
//  003 — o plugin CUSTOM de um servidor
//
//  ####  NEM TODO PLUGIN É DA REDE  ####
//
//  A 002 tinha um lugar só: a biblioteca do agente, válida para
//  todos os servidores. Falta o outro caso, que é comum — o `.cs`
//  que só faz sentido NAQUELE servidor: o evento de um fim de
//  semana, o teste que não vai para os outros, a versão adaptada
//  que ninguém mais quer.
//
//  Mandar esse arquivo para a biblioteca de todos seria poluir a
//  tela de rede com o experimento de um servidor. Deixá-lo fora do
//  agente seria voltar ao problema que a 002 resolveu: um arquivo
//  em disco que o painel não conhece.
//
//      server_id IS NULL      da BIBLIOTECA — todo servidor pode
//                             ligar
//      server_id = 'pvp1'     CUSTOM do pvp1 — nenhum outro
//                             servidor o vê
//
//  ####  POR QUE A TABELA É RECRIADA  ####
//
//  O `name` era a chave primária, e ele deixa de ser único: `pvp1`
//  e `pvp2` podem ter, cada um, um `MeuEvento.cs` com conteúdo
//  diferente — é justamente o que "custom daquele servidor" quer
//  dizer. O SQLite não muda chave primária no lugar, então o
//  caminho é a tabela nova com os dados copiados.
//
//  A chave passa a ser um `id` sintético, e a unicidade vira DOIS
//  índices parciais. Um só, sobre `(name, server_id)`, não serviria:
//  no SQLite dois NULL são distintos entre si, e a biblioteca
//  aceitaria dois "Kits".
//
//  ####  MESMO NOME, DOIS DONOS  ####
//
//  Nada impede a biblioteca ter `Kits` e o `pvp1` ter um `Kits`
//  custom. O que o banco NÃO decide é qual dos dois vai para o
//  disco daquele servidor — os dois gravariam `Kits.cs` no mesmo
//  lugar, e o Oxide só carrega um. Quem recusa ligar o segundo é
//  oxide/library.ts, com a frase que diz qual está no caminho.
// ------------------------------------------------------------
const CUSTOM_PLUGINS_SCHEMA = `
ALTER TABLE plugins RENAME TO plugins_002;
ALTER TABLE server_plugins RENAME TO server_plugins_002;

CREATE TABLE plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- "OrigemZPlayer", sem o .cs: é o que o \`oxide.reload\` recebe.
  name TEXT NOT NULL,
  file TEXT NOT NULL,

  -- NULL = da biblioteca, vale para todos. Preenchido = custom
  -- DAQUELE servidor, e some junto com ele (ON DELETE CASCADE).
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,

  title       TEXT,
  author      TEXT,
  version     TEXT,
  description TEXT,

  bytes  INTEGER NOT NULL,
  sha256 TEXT NOT NULL,

  added_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Ver o cabeçalho: DOIS índices, e não um sobre as duas colunas.
CREATE UNIQUE INDEX idx_plugins_library ON plugins (name) WHERE server_id IS NULL;
CREATE UNIQUE INDEX idx_plugins_custom ON plugins (server_id, name) WHERE server_id IS NOT NULL;

INSERT INTO plugins
  (name, file, server_id, title, author, version, description, bytes, sha256,
   added_at, updated_at)
SELECT
  name, file, NULL, title, author, version, description, bytes, sha256,
  added_at, updated_at
FROM plugins_002;

CREATE TABLE server_plugins (
  server_id TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  plugin_id INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  applied_sha TEXT,
  applied_at  INTEGER,

  PRIMARY KEY (server_id, plugin_id)
);

INSERT INTO server_plugins (server_id, plugin_id, enabled, applied_sha, applied_at)
SELECT antigo.server_id, novo.id, antigo.enabled, antigo.applied_sha, antigo.applied_at
  FROM server_plugins_002 antigo
  JOIN plugins novo ON novo.name = antigo.plugin_name AND novo.server_id IS NULL;

DROP TABLE server_plugins_002;
DROP TABLE plugins_002;

CREATE INDEX idx_server_plugins_plugin ON server_plugins (plugin_id);
`;

// ------------------------------------------------------------
//  004 — de quem cada plugin depende
//
//  ####  TIRAR UM PLUGIN PODE DERRUBAR OUTROS  ####
//
//  Três dos nossos começam com `// Requires: OrigemZAgent`. Isso
//  não é comentário: o Oxide lê a linha e não carrega o plugin
//  enquanto a dependência não estiver carregada. Desligar o
//  `OrigemZAgent` num servidor tira os três do ar junto — e o
//  sintoma aparece depois, no jogo, sem nada ligando uma coisa à
//  outra.
//
//  Guardar a lista aqui é o que permite a tela AVISAR antes:
//  "tirar este derruba OrigemZPlayer, OrigemZQueue e OrigemZVip".
//
//      requires      `// Requires: X` — dura. Sem o X, não carrega.
//      plugin_refs   `[PluginReference] Plugin X` — mole. Carrega
//                    sem o X, com a parte que dependia dele morta.
//
//  ####  POR QUE JSON NUMA COLUNA, E NÃO UMA TABELA  ####
//
//  A pergunta que se faz é sempre "de quem ESTE plugin depende" e
//  "quem depende dele" — sobre um acervo de dezenas de linhas que a
//  tela já carrega inteiro. Uma tabela de ligação daria junções e
//  uma terceira entidade para manter em dia a cada upload, para
//  responder em memória o que já cabe em memória.
//
//  ####  NULL É "AINDA NÃO SEI"  ####
//
//  E é diferente de `'[]'`, que é "li o arquivo e ele não depende
//  de ninguém". As linhas que já existiam nascem NULL de propósito:
//  é assim que a varredura da pasta sabe que precisa reler aqueles
//  `.cs` uma vez, em vez de assumir que nenhum deles tem
//  dependência.
// ------------------------------------------------------------
const PLUGIN_DEPENDENCIES_SCHEMA = `
ALTER TABLE plugins ADD COLUMN requires TEXT;
ALTER TABLE plugins ADD COLUMN plugin_refs TEXT;
`;

// ------------------------------------------------------------
//  005 — a BanList global
//
//  ####  O BANIMENTO PASSA A SER ESTADO DO AGENTE  ####
//
//  Até aqui cada servidor tinha a lista dele, no `bans.cfg`. Um
//  jogador expulso do `pvp1` entrava no `pvp2` no minuto seguinte,
//  e quem administra descobria pelo Discord. Com esta tabela a
//  lista é UMA, e cada `bans.cfg` vira espelho — quem mantém os
//  dois lados iguais é bans/service.ts.
//
//  ####  POR QUE `network` NÃO É UMA LISTA COM TODOS OS
//        SERVIDORES  ####
//
//  Porque a lista seria a de HOJE. No dia em que o `pvp3` for
//  cadastrado, todo ban de rede feito antes dele deixaria de valer
//  lá — em silêncio, sem erro nenhum, e a descoberta seria o
//  banido jogando. `scope = 'network'` não enumera ninguém, e por
//  isso não envelhece.
//
//  `scope = 'servers'` é o outro caso, e ele é real: o desafeto de
//  um servidor de PVP que não tem nada a ver com o PVE ao lado.
//  Esse enumera, em `ban_servers`.
//
//  ####  REVOGAR NÃO APAGA A LINHA  ####
//
//  `revoked_at` preenchido é o ban que deixou de valer. Apagar a
//  linha responderia "quem está banido?" e destruiria "quem JÁ
//  esteve banido, por quê, e quem o soltou" — que é a pergunta de
//  toda segunda discussão sobre o mesmo jogador.
//
//  ####  O `origin` SEPARA O QUE NASCEU AQUI DO QUE FOI ADOTADO  ####
//
//      'panel'    alguém baniu pelo agente
//      'adopted'  já estava no `bans.cfg` quando o agente chegou
//
//  A adoção é o que impede a reconciliação de virar um `unban` em
//  massa no primeiro boot: um ban que o agente não conhece foi
//  decisão de alguém, e quem acabou de chegar é o agente.
// ------------------------------------------------------------
const BANS_SCHEMA = `
CREATE TABLE bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- TEXT, e não INTEGER: um SteamID64 tem 17 dígitos e passa de
  -- 2^53. Em número ele perderia precisão na ida e volta pelo
  -- JSON, e o ban iria para a CONTA ERRADA.
  steam_id TEXT NOT NULL,

  -- O nome de quando foi banido. NULL quando ninguém sabia — é o
  -- caso do ban por SteamID com o jogador offline.
  name TEXT,

  reason TEXT NOT NULL,

  -- 'network' = vale em TODO servidor, inclusive nos que ainda vão
  --             nascer. Não enumera ninguém (ver o cabeçalho).
  -- 'servers' = vale nos listados em ban_servers, e em nenhum outro.
  scope TEXT NOT NULL CHECK (scope IN ('network', 'servers')),

  created_at INTEGER NOT NULL,
  -- O operador que aplicou. "Quem baniu este jogador?" é a
  -- primeira pergunta de toda discussão sobre banimento.
  created_by TEXT,

  -- NULL = permanente. Preenchido, quem desbane é o relógio do
  -- agente: o ban do Rust não tem prazo (ver bans/expiry-watcher.ts).
  expires_at INTEGER,

  -- NULL = ativo. Ver o cabeçalho: revogar não apaga a linha.
  revoked_at INTEGER,
  revoked_by TEXT,

  origin TEXT NOT NULL DEFAULT 'panel' CHECK (origin IN ('panel', 'adopted'))
);

-- UM banimento ATIVO por SteamID.
--
-- Dois ativos não têm resposta para "qual motivo vale?" nem para
-- "revogar fecha qual?" — e a segunda é pior, porque a tela
-- mostraria o jogador solto com um ban ainda de pé.
--
-- Índice PARCIAL: o histórico pode ter dez linhas revogadas do
-- mesmo SteamID, e deve mesmo.
CREATE UNIQUE INDEX idx_bans_active ON bans (steam_id) WHERE revoked_at IS NULL;

-- A tela de rede lista do mais recente para o mais antigo.
CREATE INDEX idx_bans_created ON bans (created_at DESC);

-- ----------------------------------------------------------
--  Os servidores de um ban de escopo 'servers'.
--
--  Um ban 'network' NÃO tem linha aqui: enumerá-lo seria
--  transformá-lo justamente no que ele existe para não ser.
--
--  ####  APAGAR O SERVIDOR ESVAZIA O BAN, E NÃO O REVOGA  ####
--
--  A cascata tira as linhas daqui, e o ban pode ficar ativo sem
--  servidor nenhum. É o comportamento certo: revogá-lo por causa
--  de um servidor removido seria soltar um jogador por um motivo
--  que não tem nada a ver com ele. A tela mostra o ban sem alvo, e
--  quem administra decide.
-- ----------------------------------------------------------
CREATE TABLE ban_servers (
  ban_id    INTEGER NOT NULL REFERENCES bans(id) ON DELETE CASCADE,
  server_id TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (ban_id, server_id)
);

-- "O que vale NESTE servidor?" é a pergunta da aba Administração,
-- e sem o índice ela varre a tabela inteira a cada abertura.
CREATE INDEX idx_ban_servers_server ON ban_servers (server_id);
`;

// ------------------------------------------------------------
//  006 — o jogador como entidade
//
//  ####  ATÉ AQUI, JOGADOR SÓ EXISTIA ENQUANTO CONECTADO  ####
//
//  A lista de quem está online é lida do servidor a cada chamada
//  (game/players.ts) e nada dela era guardado: fechou o jogo,
//  sumiu da tela. Não havia a quem pendurar o banimento, o
//  histórico, o ranking e a loja — e a BanList já sentia isso,
//  guardando um `name` solto que ninguém consegue atualizar.
//
//  ####  DUAS TABELAS, E A SEPARAÇÃO NÃO É ORGANIZAÇÃO  ####
//
//      players         QUEM ele é    — um por SteamID, para a rede
//      player_servers  O QUE ele fez — uma linha por (servidor, jogador)
//
//  "Quem é este jogador?" tem UMA resposta: o nome, desde quando
//  joga aqui, se está banido. Se ela morasse por servidor, um
//  jogador com cinco servidores teria cinco "desde quando" e o
//  banimento de rede não teria a quem se pendurar.
//
//  E o contrário também: "desde quando ele joga NO PVE?" é outra
//  pergunta. Quem joga no `pvp1` desde maio e entrou no `pve`
//  ontem é jogador desde maio na REDE e desde ontem NO PVE. Uma
//  coluna só apaga essa diferença — foi o defeito que o projeto
//  anterior levou 33 migrações para consertar: com a sessão
//  corrente numa linha só, entrar no B marcava a pessoa como
//  offline no A, onde ela ainda estava jogando.
//
//  ####  O QUE ESTAS TABELAS NÃO GUARDAM  ####
//
//  Banimento. Ele já é global desde a 005, e a ficha do jogador
//  LÊ de lá. Uma coluna `banned` aqui seria a segunda fonte para
//  "ele está banido?" — e a segunda é a que diverge no primeiro
//  ajuste, porque quem revoga mexe na `bans` e esquece do resto.
// ------------------------------------------------------------
const PLAYERS_SCHEMA = `
CREATE TABLE players (
  -- A CHAVE É O SteamID, e ele é TEXT.
  --
  -- 17 dígitos passam de 2^53: em INTEGER o id volta arredondado
  -- e a ficha seria de OUTRA PESSOA, sem erro nenhum no caminho.
  -- Mesma razão da coluna homônima em \`bans\`.
  steam_id TEXT PRIMARY KEY,

  -- O nome mais recente que vimos. Ele MUDA — o histórico de
  -- nomes é uma tabela futura, e inventá-la agora seria guardar
  -- linha para uma tela que não existe.
  name TEXT NOT NULL,

  -- Epoch ms. \`first_seen\` NUNCA muda depois da inserção: é o
  -- "jogador desde", e reescrevê-lo apagaria a única informação
  -- daqui que não dá para reconstruir de nenhuma outra fonte.
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,

  -- O último IP visto. NULLABLE de propósito: o \`playerlist\`
  -- nativo traz (campo \`Address\`), o \`origemz.players\` não — e
  -- um IP inventado é pior que um campo vazio.
  last_ip TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A busca da tela de rede é por nome, e ela ignora maiúsculas.
CREATE INDEX idx_players_name ON players (name COLLATE NOCASE);

-- A listagem padrão: quem apareceu por último primeiro. DESC no
-- índice para o ORDER BY não virar sort a cada página.
CREATE INDEX idx_players_last_seen ON players (last_seen DESC);

-- ----------------------------------------------------------
--  player_servers — o que ele fez em CADA servidor.
-- ----------------------------------------------------------
CREATE TABLE player_servers (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,

  -- Primeira e última vez NESTE servidor. As irmãs de rede moram
  -- em \`players\`, e as duas respostas são diferentes.
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,

  -- A sessão CORRENTE neste servidor. Uma por servidor é o ponto:
  -- é o que permite estar online no pvp1 e ter saído do pve.
  -- \`joined_at\` preenchido com \`left_at\` nulo = está online AQUI.
  joined_at    INTEGER,
  left_at      INTEGER,
  leave_reason TEXT,

  sessions INTEGER NOT NULL DEFAULT 0,

  -- Tempo somado, em SEGUNDOS, contado no FECHAMENTO da sessão.
  -- Somar durante a sessão exigiria escrever a cada varredura, e
  -- um agente derrubado no meio deixaria o número inflado para
  -- sempre — ver players/presence.ts.
  played_seconds INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (server_id, steam_id)
);

-- "Em quais servidores este jogador jogou?" é a pergunta da ficha
-- e da listagem. A chave primária começa por \`server_id\`, então
-- filtrar só pela segunda coluna não teria por onde entrar — e a
-- varredura seria do produto servidores × jogadores, por página.
CREATE INDEX idx_player_servers_player ON player_servers (steam_id);

-- ----------------------------------------------------------
--  player_events — a linha do tempo.
--
--  ####  ELA GUARDA O QUE NÃO TEM OUTRA CASA  ####
--
--  A sessão CORRENTE mora em \`player_servers\` e responde "ele
--  está online agora?". Ela não responde "o que aconteceu com
--  este jogador na semana passada" — numa linha por (servidor,
--  jogador) só cabem a última entrada e a última saída.
--
--  Os banimentos NÃO entram aqui: eles já são linhas em \`bans\`,
--  com quem aplicou e quem revogou. A linha do tempo os LÊ de lá
--  e mistura na ordem (ver players/service.ts). Copiá-los para cá
--  faria a ficha mostrar como ativo um ban revogado pelo caminho
--  que não escrevesse nos dois lugares.
--
--  ####  E POR QUE EXPULSAR E TELEPORTAR ENTRAM  ####
--
--  Porque hoje eles só existem no log do processo, que ninguém
--  abre para responder "por que este jogador foi expulso ontem?".
--  O log continua recebendo — ele é do AGENTE; isto aqui é do
--  JOGADOR, e é o que a ficha dele mostra.
-- ----------------------------------------------------------
CREATE TABLE player_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  steam_id TEXT NOT NULL,

  -- O servidor onde aconteceu. Cascata, como toda coluna que
  -- aponta para \`servers\`: apagar um servidor leva junto o que só
  -- fazia sentido dentro dele.
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  --   'join'      entrou (a varredura o viu chegar)
  --   'leave'     saiu   (a varredura o viu sumir)
  --   'kick'      expulso pelo painel
  --   'teleport'  movido pelo painel
  kind TEXT NOT NULL CHECK (kind IN ('join', 'leave', 'kick', 'teleport')),

  at INTEGER NOT NULL,

  -- Quem PEDIU, quando foi alguém: o operador do painel. NULL nos
  -- eventos que o jogo produziu sozinho (entrar, sair).
  actor TEXT,

  -- O detalhe daquele tipo: o motivo da saída, o motivo do kick, o
  -- destino do teleporte. Texto livre porque é para ler, não para
  -- filtrar — e uma coluna por tipo deixaria a tabela cheia de
  -- NULL que ninguém consulta.
  detail TEXT
);

-- A ficha pede "os N últimos deste jogador", e é o único acesso
-- que existe hoje. Sem o índice, cada abertura varre a tabela
-- inteira — que é a que mais cresce de todas.
CREATE INDEX idx_player_events_player ON player_events (steam_id, at DESC);
`;

// ------------------------------------------------------------
//  010 — o VIP
//
//  ####  O VIP É DA REDE, E O ESTADO É DO AGENTE  ####
//
//  Quem compra compra da REDE, e por isso não há `server_id` aqui:
//  a alternativa produziria a pergunta "comprei no PVP e não tenho
//  no PVE?" com a resposta errada. O que é por servidor é o GRUPO
//  DO OXIDE, que é como o VIP vira efeito dentro do jogo.
//
//  E o dono do estado é esta tabela, não o plugin. O `OrigemZAgent`
//  guarda um cache DESCARTÁVEL, repovoado a cada
//  `origemz.vip.sync`: se a fonte fosse o jogo, um wipe ou um
//  `oxide.reload` apagaria VIP comprado com dinheiro.
//
//  ####  RENOVAR ESTENDE A LINHA QUE EXISTE  ####
//
//  Quem compra 30 dias em cima de 20 que faltam fica com 50, e a
//  data nova é `max(agora, vencimento) + prazo`. Somar a partir de
//  "agora" faria a renovação antecipada tirar dias de quem pagou —
//  o pior jeito possível de tratar quem paga. Ver
//  db/vips-repository.ts.
// ------------------------------------------------------------
const VIPS_SCHEMA = `
CREATE TABLE vips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- TEXT, como em toda parte: 17 dígitos passam de 2^53 e em
  -- número o id volta arredondado — o VIP iria para OUTRA CONTA.
  steam_id TEXT NOT NULL,

  -- 'bronze' | 'silver' | 'gold' — o \`Tier\` do OrigemZVip.json.
  -- TEXT e não um enum fechado: o nível é configurável no plugin, e
  -- um CHECK aqui obrigaria uma migração a cada nível novo.
  tier TEXT NOT NULL,

  -- Epoch ms. NULL = permanente (o VIP vitalício existe e é
  -- vendido).
  expires_at INTEGER,

  -- De onde ele veio:
  --   'loja'     comprado
  --   'painel'   um admin concedeu
  --   'adotado'  o jogador JÁ ESTAVA no grupo do Oxide quando o
  --              agente chegou. Sem este caso a reconciliação
  --              tiraria do grupo quem alguém pôs à mão — a mesma
  --              lição da BanList (migração 005).
  origin TEXT NOT NULL CHECK (origin IN ('loja', 'painel', 'adotado')),
  created_at INTEGER NOT NULL,
  created_by TEXT,

  -- NULL = vale. Revogar NÃO apaga a linha: a segunda discussão
  -- sobre o mesmo jogador precisa da primeira. Mesma regra dos
  -- banimentos.
  --
  -- \`revoked_at\` preenchido com \`revoked_by\` NULO é a assinatura
  -- do RELÓGIO: ninguém revogou, o prazo acabou.
  revoked_at INTEGER,
  revoked_by TEXT
);

-- UM VIP ativo por (jogador, nível). Dois seriam duas datas de
-- vencimento para o mesmo benefício, e nenhuma resposta para "qual
-- vale?" nem para "revogar fecha qual?".
--
-- Índice PARCIAL: o histórico pode ter dez linhas revogadas do
-- mesmo par, e deve mesmo.
CREATE UNIQUE INDEX idx_vips_active ON vips (steam_id, tier) WHERE revoked_at IS NULL;

-- O relógio pergunta "quem venceu?" a cada rodada. Sem o índice,
-- cada batida varre a tabela inteira.
CREATE INDEX idx_vips_expires ON vips (expires_at) WHERE revoked_at IS NULL;

-- A ficha do jogador e a sincronização perguntam pelo SteamID.
CREATE INDEX idx_vips_player ON vips (steam_id);
`;

// ------------------------------------------------------------
//  011 — o loadout de cada grupo
//
//  ####  A LISTA É DERIVADA DOS GRUPOS, E NÃO MANTIDA À MÃO  ####
//
//  "Criou um novo grupo, aparece o loadout. Apagou o loadout, some
//  daquele lugar." Ou seja: quem enumera os loadouts de um servidor
//  são os GRUPOS DO OXIDE dele (\`oxide.show groups\`), e esta tabela
//  só guarda o que cada um recebe. Uma lista própria de níveis
//  envelheceria em silêncio — o grupo novo nasceria sem lugar na
//  tela.
//
//  Isso casa com o que o plugin já faz: o \`origemz.loadout.sync\`
//  recebe o estado COMPLETO, e "nível que sumiu fica sem kit".
// ------------------------------------------------------------
const LOADOUTS_SCHEMA = `
CREATE TABLE loadouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O NOME DO GRUPO do Oxide (\`origemz.vip.gold\`, \`default\`).
  --
  -- Não há chave estrangeira: o grupo vive DENTRO do servidor, num
  -- protobuf que o próprio Oxide reescreve, e não numa tabela
  -- nossa. Um grupo apagado no Oxide deixa um loadout órfão — e a
  -- TELA mostra isso, em vez de o banco apagar sozinho o trabalho
  -- de alguém.
  group_name TEXT NOT NULL,

  -- Os itens, como JSON, no formato que o plugin já espera:
  -- [{ slot, shortname, amount, skinId, position }]
  --
  -- JSON numa coluna, e não uma tabela de itens: a pergunta é
  -- sempre "o kit INTEIRO deste grupo", o conjunto é reescrito
  -- inteiro a cada edição (é configuração, não histórico), e o
  -- formato é o do \`LoadoutItemPayload\` do plugin — que atravessa
  -- daqui até o jogo sem ninguém remontá-lo.
  items TEXT NOT NULL DEFAULT '[]',

  -- Desligado é diferente de apagado: o loadout continua guardado e
  -- some do payload empurrado ao jogo. É o "tira do ar sem perder
  -- meia hora de montagem".
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT,

  UNIQUE (server_id, group_name)
);
`;

// ------------------------------------------------------------
//  012 — os kits da loja
//
//  ####  UM KIT É DA REDE; CADA SERVIDOR DECIDE SE O OFERECE  ####
//
//  Mesma razão da biblioteca de plugins: um kit por servidor faria
//  cinco cópias do mesmo kit, e a sexta mudança entraria em quatro
//  delas. \`kit_servers\` é onde o alcance mora.
// ------------------------------------------------------------
const KITS_SCHEMA = `
CREATE TABLE kits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- O identificador estável, para o site e para a interface do jogo
  -- apontarem sem depender do id numérico.
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,

  --   'compra'    o jogador paga e leva
  --   'resgate'   uma vez por jogador, para sempre
  --   'cooldown'  de N em N segundos
  kind TEXT NOT NULL CHECK (kind IN ('compra', 'resgate', 'cooldown')),

  -- Só em 'compra'. Em CENTAVOS, inteiro: dinheiro em float é o
  -- erro que aparece no extrato do cliente.
  price_cents INTEGER,

  -- Só em 'cooldown'. Em SEGUNDOS.
  --
  -- E não existe \`next_at\`: "pode pegar de novo?" é
  -- \`agora - último claim >= cooldown\`, calculado na hora. Um campo
  -- guardado seria um segundo lugar para a mesma verdade — e ele
  -- erraria no dia em que alguém mudasse o cooldown do kit.
  cooldown_seconds INTEGER,

  -- NULL = qualquer um. Preenchido = só quem tem aquele nível de
  -- VIP, ou um mais alto. É o resgate do VIP Ouro.
  required_tier TEXT,

  items TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kit_servers (
  kit_id    INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (kit_id, server_id)
);

-- "Quais kits este servidor oferece?" é a pergunta da tela do
-- servidor e da entrega. A chave primária começa por \`kit_id\`,
-- então filtrar só pela segunda coluna não teria por onde entrar.
CREATE INDEX idx_kit_servers_server ON kit_servers (server_id);
`;

// ------------------------------------------------------------
//  013 — quem já pegou o quê
//
//  Uma linha por ENTREGA. É ela que responde "ele já pegou?" e
//  "quando ele pode pegar de novo?" — e é ela que o suporte lê
//  quando o jogador diz que não recebeu.
//
//  ####  A LINHA NASCE ANTES DO COMANDO  ####
//
//  Gravar só depois do sucesso faria a entrega que travou no meio
//  (agente derrubado, RCON caindo) desaparecer do histórico — e ela
//  é justamente a que gera reclamação. Ver kits/service.ts: a linha
//  nasce como \`falhou\`, com o motivo "entrega interrompida", e é
//  fechada com o desfecho de verdade.
// ------------------------------------------------------------
const KIT_CLAIMS_SCHEMA = `
CREATE TABLE kit_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id     INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  steam_id   TEXT NOT NULL,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  claimed_at INTEGER NOT NULL,

  -- 'entregue' | 'falhou'. A falha FICA: uma entrega que não
  -- aconteceu é a pergunta que o suporte recebe.
  status TEXT NOT NULL CHECK (status IN ('entregue', 'falhou')),
  detail TEXT
);

-- "Ele já pegou este kit?" e "quando foi a última vez?" são a mesma
-- consulta, e ela roda a cada resgate.
CREATE INDEX idx_kit_claims_player ON kit_claims (steam_id, kit_id, claimed_at DESC);

-- "Quem já pegou este kit?" é a tela do kit.
CREATE INDEX idx_kit_claims_kit ON kit_claims (kit_id, claimed_at DESC);
`;

// ------------------------------------------------------------
//  014 — o VIP e o kit entram na linha do tempo do jogador
//
//  ####  O CHECK DA 006 NÃO CONHECE OS DOIS  ####
//
//  Ele admite \`join|leave|kick|teleport\`, e o SQLite não altera um
//  CHECK no lugar: a tabela é recriada com os dados copiados, como
//  na 003.
//
//  ####  E POR QUE ELES ENTRAM  ####
//
//  "Por que este jogador tem Ouro?" e "ele já pegou este kit?" têm
//  resposta em \`vips\` e em \`kit_claims\` — mas a ficha mostra UMA
//  linha do tempo, e um VIP concedido em março precisa aparecer ao
//  lado do banimento de abril.
//
//  Os banimentos são LIDOS da tabela deles na hora de montar a
//  ficha (ver players/service.ts) porque há UM ban ativo por
//  jogador, e a história inteira cabe em dois itens. O VIP e o kit
//  não cabem nesse formato: um jogador tem vários níveis e dezenas
//  de resgates, e o que a ficha quer não é o estado — é o
//  ACONTECIMENTO, com a data em que ele aconteceu.
// ------------------------------------------------------------
const PLAYER_EVENTS_VIP_SCHEMA = `
ALTER TABLE player_events RENAME TO player_events_006;

CREATE TABLE player_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  steam_id  TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  --   'join'      entrou (a varredura o viu chegar)
  --   'leave'     saiu   (a varredura o viu sumir)
  --   'kick'      expulso pelo painel
  --   'teleport'  movido pelo painel
  --   'vip'       ganhou, renovou ou perdeu um nível
  --   'kit'       resgatou (ou tentou resgatar) um kit
  kind TEXT NOT NULL CHECK (kind IN ('join', 'leave', 'kick', 'teleport', 'vip', 'kit')),

  at INTEGER NOT NULL,
  actor TEXT,
  detail TEXT
);

-- O \`id\` vai junto: ele é a ordem de desempate da ficha (\`at DESC,
-- id DESC\`), e uma renumeração faria dois eventos do mesmo
-- milissegundo trocarem de lugar na tela.
INSERT INTO player_events (id, steam_id, server_id, kind, at, actor, detail)
SELECT id, steam_id, server_id, kind, at, actor, detail FROM player_events_006;

DROP TABLE player_events_006;

CREATE INDEX idx_player_events_player ON player_events (steam_id, at DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'servers', sql: SERVERS_SCHEMA },
  { id: 2, name: 'plugins', sql: PLUGINS_SCHEMA },
  { id: 3, name: 'custom-plugins', sql: CUSTOM_PLUGINS_SCHEMA },
  { id: 4, name: 'plugin-dependencies', sql: PLUGIN_DEPENDENCIES_SCHEMA },
  { id: 5, name: 'bans', sql: BANS_SCHEMA },
  { id: 6, name: 'players', sql: PLAYERS_SCHEMA },
  // 007 a 009 são da outra frente (itens e interface); a faixa
  // desta é 010–014. Ver Docs\\15-BRIEFING-VIP-LOADOUTS-KITS.md.
  { id: 10, name: 'vips', sql: VIPS_SCHEMA },
  { id: 11, name: 'loadouts', sql: LOADOUTS_SCHEMA },
  { id: 12, name: 'kits', sql: KITS_SCHEMA },
  { id: 13, name: 'kit-claims', sql: KIT_CLAIMS_SCHEMA },
  { id: 14, name: 'player-events-vip-kit', sql: PLAYER_EVENTS_VIP_SCHEMA },
];

/** Linha da tabela de controle. */
interface AppliedMigrationRow {
  readonly id: number;
}

/**
 * Aplica o que falta e devolve o que foi aplicado AGORA.
 *
 * Chamar duas vezes seguidas é seguro: a segunda não faz nada e
 * devolve lista vazia.
 */
export function runMigrations(db: AgentDatabase, logger?: Logger): readonly Migration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const alreadyApplied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as AppliedMigrationRow[]).map(
      (row) => row.id,
    ),
  );

  const applied: Migration[] = [];

  for (const migration of MIGRATIONS) {
    if (alreadyApplied.has(migration.id)) {
      continue;
    }

    // Transação por passo: se o SQL falhar no meio, nada dele
    // fica. Sem isso um erro na terceira instrução deixaria o
    // banco com metade do schema E sem o registro em
    // `schema_migrations` — a próxima subida tentaria criar de
    // novo as tabelas que já existem, e falharia para sempre.
    //
    // DDL dentro de transação é suportado pelo SQLite (não é o
    // caso de todo banco).
    const apply = db.transaction((): void => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @applied_at)',
      ).run({ id: migration.id, name: migration.name, applied_at: Date.now() });
    });

    apply();
    applied.push(migration);

    logger?.info({ migration: migration.id, name: migration.name }, 'applied sqlite migration');
  }

  return applied;
}
