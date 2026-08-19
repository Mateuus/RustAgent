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
//  007 — o catálogo de itens
//
//  ####  ATÉ AQUI, A LISTA DE ITENS SÓ EXISTIA COM UM SERVIDOR
//        NO AR  ####
//
//  Ela é lida do `origemz.items`, ou seja, do RCON. Montar um kit
//  ou uma entrega exigia decorar `rifle.ak` — e exigia isso com o
//  servidor ligado, que é justamente quando ninguém quer mexer.
//  Com a tabela, a busca por "Assault Rifle" responde de
//  madrugada, com tudo parado.
//
//  ####  A CHAVE É O SHORTNAME  ####
//
//  É ele que todo comando do jogo recebe (`inventory.give`, o
//  kit, a entrega), e é ele que não muda entre wipes. O `item_id`
//  numérico vem junto porque alguns comandos o pedem — e porque é
//  ele que muda quando a Facepunch renomeia um item mantendo o
//  shortname.
//
//  ####  ITEM QUE SUMIU DO JOGO NÃO É APAGADO  ####
//
//  E isso não é preguiça: um kit montado no mês passado aponta
//  para ele, e apagar a linha deixaria o kit com um shortname
//  órfão que ninguém consegue explicar. A linha fica, e a leitura
//  a MARCA — daí a tela do kit conseguir dizer "este item não
//  existe mais nesta versão do jogo".
//
//  Quem responde "ainda existe?" são as duas datas mais o carimbo
//  da varredura, guardado em `meta`:
//
//      last_seen == items.scanned_at   o jogo listou na última
//                                      varredura
//      last_seen <  items.scanned_at   sumiu
//
//  Uma coluna `removed` seria a segunda fonte para o mesmo fato, e
//  ela ficaria errada no dia em que uma varredura escrevesse as
//  datas e esquecesse dela.
//
//  ####  A INVALIDAÇÃO É POR PROTOCOLO, E NÃO POR TTL  ####
//
//  Catálogo de item não envelhece com o tempo: ele muda quando o
//  JOGO muda, e só então. Um TTL de dez minutos refaria o trabalho
//  144 vezes por dia para descobrir 143 vezes que nada mudou — e
//  ainda ficaria dez minutos errado depois de um update.
//
//  `items.protocol` guarda o `Protocol` do `serverinfo` que gerou
//  o catálogo (`"2632.287.1"` hoje). Diferente → releia. Igual →
//  não faça nada. E o gatilho vem de graça: um update reinicia o
//  servidor, o RCON cai e reconecta, e `onRconConnected` dispara.
// ------------------------------------------------------------
const ITEMS_SCHEMA = `
CREATE TABLE items (
  -- Ver o cabeçalho: a chave é o shortname, e não o id numérico.
  shortname     TEXT PRIMARY KEY,

  -- "Assault Rifle". É por ele que a tela busca.
  display_name  TEXT NOT NULL,

  item_id       INTEGER NOT NULL,
  category      TEXT NOT NULL,
  max_stack     INTEGER NOT NULL,
  has_condition INTEGER NOT NULL CHECK (has_condition IN (0, 1)),

  -- Epoch ms. \`first_seen\` NUNCA muda depois da inserção: é
  -- "desde quando este item existe no jogo, para este agente".
  -- \`last_seen\` é a última varredura que o listou — ver o
  -- cabeçalho para como ele marca o que sumiu.
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

-- A busca da tela é por nome, e ela ignora maiúsculas.
CREATE INDEX idx_items_name ON items (display_name COLLATE NOCASE);

-- O filtro por categoria é o segundo gesto de quem procura item,
-- e sem o índice ele varre as ~1250 linhas a cada tecla.
CREATE INDEX idx_items_category ON items (category);
`;

// ------------------------------------------------------------
//  008 — as interfaces do jogo
//
//  ####  O DESENHO É DA REDE; O QUE APARECE É DO SERVIDOR  ####
//
//  Esta é a decisão que manda no formato das duas tabelas. Uma
//  interface POR SERVIDOR faria seis cópias do mesmo menu, e a
//  sétima mudança seria feita em cinco delas. Um documento só, sem
//  escolha por servidor, faria o PVE anunciar a loja que ele não
//  tem.
//
//      ui_documents   o DESENHO, um por menu, da rede inteira
//      server_ui      o que CADA servidor usa dele, e o que
//                     esconde
//
//  ####  POR QUE O DOCUMENTO É UMA COLUNA JSON  ####
//
//  A pergunta que se faz é sempre "me dá o documento inteiro" — o
//  editor carrega tudo, o transporte manda tudo. Normalizar
//  elemento, âncora, cor e ação em tabelas daria junções para
//  responder o que já cabe numa leitura, e um esquema para migrar
//  a cada campo novo do editor.
//
//  O que PRECISA ser normalizado é o que se consulta de fora, e
//  está fora do JSON: \`slug\`, \`revision\` e quem usa.
//
//  ####  A REVISÃO É O QUE DIZ AO SERVIDOR QUE ELE ESTÁ VELHO  ####
//
//  O plugin guarda a interface na memória dele. Sem um número que
//  suba a cada gravação, "editei e o jogo continua igual" não
//  teria como ser respondido — nem pela tela, nem por quem
//  administra.
// ------------------------------------------------------------
const UI_DOCUMENTS_SCHEMA = `
CREATE TABLE ui_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- "menu-principal". Estável, porque o servidor aponta para ele
  -- e porque é o que abre o editor.
  slug     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,

  -- O documento inteiro, como JSON. Ver o cabeçalho.
  document TEXT NOT NULL,

  -- Sobe a cada gravação. Ver o cabeçalho.
  revision INTEGER NOT NULL DEFAULT 1,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ----------------------------------------------------------
--  server_ui — o que ESTE servidor usa, e o que ele esconde.
--
--  ####  \`enabled\` E \`hidden\` RESPONDEM COISAS DIFERENTES  ####
--
--      enabled = 0   o documento continua escolhido, mas não é
--                    empurrado: é o "desliguei para testar"
--      hidden        os pedaços que ELE não mostra, com o resto
--                    do menu igual ao dos outros
--
--  Apagar a linha para desligar destruiria a lista de escondidos
--  junto — e religar exigiria reconfigurar do zero. Mesma regra do
--  \`server_plugins.enabled\` da migração 002.
--
--  ####  applied_revision É O QUE ESTÁ NO JOGO  ####
--
--  E ele é diferente de \`ui_documents.revision\`, que é o que
--  está no agente. Divergiram, há mudança para aplicar — a mesma
--  ideia dos dois sha256 dos plugins. Sem a segunda coluna, a
--  única forma de responder isso seria perguntar ao plugin a cada
--  abertura de tela, e a resposta sumiria com o servidor parado.
-- ----------------------------------------------------------
CREATE TABLE server_ui (
  server_id   TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES ui_documents(id) ON DELETE CASCADE,

  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),

  -- Os ids dos elementos e telas que ESTE servidor desliga, como
  -- JSON. '[]' = mostra tudo, e é o padrão.
  hidden TEXT NOT NULL DEFAULT '[]',

  -- NULL = nunca foi aplicado neste servidor.
  applied_revision INTEGER,
  applied_at       INTEGER,

  PRIMARY KEY (server_id, document_id)
);

-- "Quem usa este documento?" é a pergunta da listagem do editor, e
-- ela é feita para CADA linha. A chave primária começa por
-- \`server_id\`, então filtrar pela segunda coluna não teria por
-- onde entrar.
CREATE INDEX idx_server_ui_document ON server_ui (document_id);
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

// ------------------------------------------------------------
//  015 — a loja: categorias, ofertas e o que cada uma entrega
//
//  ####  A LOJA É DA REDE; A COMPRA É DE UM LUGAR  ####
//
//  Categorias e ofertas NÃO têm `server_id`: a vitrine é a mesma em
//  todo servidor, e é isso que faz criar uma promoção uma vez em vez
//  de cinco. O que tem servidor é a COMPRA — ela foi paga por um
//  jogador que estava em algum mundo, e o item nasceu no inventário
//  dele lá.
//
//  Mesma escolha dos kits (012) e dos VIPs (010), pelo mesmo motivo.
//
//  ####  A OFERTA TEM QUATRO FORMATOS, E ELES NÃO SÃO COSMÉTICOS  ####
//
//    item     um item do jogo. O ícone é ele mesmo.
//    bundle   um kit: vários itens numa compra. Alguém precisa
//             ESCOLHER o ícone — não existe "o item" de um kit.
//    vip      um nível com prazo, mais a lista de vantagens.
//    vehicle  um veículo que nasce no mundo. É o único que pode
//             falhar por motivo legítimo: não caber onde a pessoa
//             está.
//
//  Os quatro entregam pela mesma tabela filha. O que muda é o que a
//  loja mostra e o que a compra concede ALÉM dos itens.
//
//  ####  A COMPRA GUARDA UMA CÓPIA DA OFERTA  ####
//
//  `store_purchases` copia nome, preço e ícone em vez de apontar
//  para `store_offers`. Não é redundância: a oferta pode ser editada
//  ou apagada depois, e o histórico precisa dizer o que a pessoa
//  PAGOU — não o preço de hoje.
//
//  Uma junção responderia "quanto custa"; a cópia responde "quanto
//  custou", que é a pergunta do suporte.
// ------------------------------------------------------------
const STORE_SCHEMA = `
CREATE TABLE store_categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,

  -- A ordem das abas no jogo. Empate desempata por nome, para a
  -- barra não trocar de ordem entre duas leituras.
  position INTEGER NOT NULL DEFAULT 0,

  -- Categoria desligada leva as ofertas dela junto — é o que
  -- "desligar a categoria" significa para quem administra.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE store_offers (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES store_categories(id) ON DELETE CASCADE,

  kind TEXT NOT NULL CHECK (kind IN ('item', 'bundle', 'vip', 'vehicle')),

  -- O DESENHO da oferta na loja. Vem de campo próprio, e não do
  -- item entregue: um kit de dez coisas não tem "o item", e quem
  -- escolhe o ícone é o admin.
  --
  -- \`icon_skin_id\` é TEXT porque id de workshop passa de 2^53 e
  -- não sobreviveria a um número de JavaScript.
  icon_shortname TEXT NOT NULL,
  icon_item_id   INTEGER NOT NULL,
  icon_skin_id   TEXT NOT NULL DEFAULT '0',

  -- Só em 'vip'. \`vip_days\` NULL = VITALÍCIO, que é o que "sem
  -- vencimento" significa no vips-repository.
  vip_tier TEXT,
  vip_days INTEGER,

  -- Só em 'vehicle'. \`prefab\` é o NOME CURTO (minicopter,
  -- rowboat): o jogo resolve o caminho, e ele não muda quando a
  -- Facepunch move um arquivo.
  vehicle_prefab TEXT,
  vehicle_fuel   INTEGER NOT NULL DEFAULT 0,

  name TEXT NOT NULL,

  -- Em OZCoin INTEIRO. A moeda não tem centavo, e saldo em float é
  -- como um débito de 10 vira 9,999999 e sobra um troco que a tela
  -- arredonda para zero.
  price INTEGER NOT NULL,

  -- O preço RISCADO ao lado, em promoção. NULL = não mostra nada.
  -- Uma etiqueta de promoção sozinha diz que há desconto, mas não
  -- QUANTO — é este número que a transforma em argumento.
  old_price INTEGER,

  position INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- Lista fechada, e não texto livre: cada etiqueta tem cor própria
  -- na loja, e um valor solto sairia sem cor nenhuma — visível no
  -- painel e invisível no jogo.
  badge TEXT CHECK (badge IS NULL OR badge IN ('promo', 'novo', 'destaque')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- "O que tem nesta categoria?" é a pergunta de cada clique numa aba
-- da loja, no jogo.
CREATE INDEX idx_store_offers_category ON store_offers (category_id, position);

-- O que a compra ENTREGA. Vazio é estado válido durante a edição —
-- um kit começa sem itens; a borda HTTP é quem recusa publicar
-- assim.
CREATE TABLE store_offer_items (
  id        TEXT PRIMARY KEY,
  offer_id  TEXT NOT NULL REFERENCES store_offers(id) ON DELETE CASCADE,
  shortname TEXT NOT NULL,
  item_id   INTEGER NOT NULL,
  skin_id   TEXT NOT NULL DEFAULT '0',
  amount    INTEGER NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_store_offer_items_offer ON store_offer_items (offer_id, position);

-- As vantagens listadas no modal, só para 'vip'. Elas não são
-- coisas: são promessas, e por isso são TEXTO e não itens.
CREATE TABLE store_offer_perks (
  id       TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES store_offers(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_store_offer_perks_offer ON store_offer_perks (offer_id, position);

-- ----------------------------------------------------------
--  store_purchases — o que aconteceu, e em que estado parou.
--
--  ####  OS ESTADOS SÃO UMA MÁQUINA, E ELA TEM UM BECO  ####
--
--    pending    a linha nasceu; nada foi movido ainda
--    debited    o dinheiro saiu
--    delivered  o item chegou. FIM feliz.
--    refunded   a entrega falhou e o valor voltou
--    failed     debitou, não entregou E não estornou
--
--  O último é o beco: ele PRECISA DE GENTE. Sem um estado próprio,
--  esse caso seria uma linha de log que ninguém lê — e o jogador
--  que perdeu o saldo descobriria no Discord.
--
--  ####  SEM FK PARA \`servers\`  ####
--
--  Ao contrário de \`kit_claims\` e do resto do projeto. Apagar um
--  servidor não pode apagar o comprovante de uma compra: ele é a
--  resposta a "eu paguei e não recebi", e essa pergunta chega
--  meses depois, às vezes de um servidor que já não existe.
-- ----------------------------------------------------------
CREATE TABLE store_purchases (
  id        TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  steam_id  TEXT NOT NULL,

  -- O id da oferta E uma cópia do que ela era. Ver o cabeçalho.
  offer_id    TEXT NOT NULL,
  offer_name  TEXT NOT NULL,
  shortname   TEXT NOT NULL,
  skin_id     TEXT NOT NULL DEFAULT '0',
  amount      INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,
  total_price INTEGER NOT NULL,

  state TEXT NOT NULL
    CHECK (state IN ('pending', 'debited', 'delivered', 'refunded', 'failed')),
  error TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- "O que este jogador comprou?" — a ficha dele e o suporte.
CREATE INDEX idx_store_purchases_player ON store_purchases (steam_id, created_at DESC);

-- "O que travou?" — a tela das compras presas, que é o motivo de
-- \`failed\` existir. Índice PARCIAL: as entregues são a esmagadora
-- maioria e não interessam a esta pergunta.
CREATE INDEX idx_store_purchases_stuck ON store_purchases (created_at DESC)
  WHERE state IN ('pending', 'debited', 'failed');

CREATE INDEX idx_store_purchases_server ON store_purchases (server_id, created_at DESC);
`;

// ------------------------------------------------------------
//  016 — a carteira do agente
//
//  ####  ELA É UMA DAS DUAS FONTES, NÃO A ÚNICA  ####
//
//  O saldo pode morar aqui ou no site externo — ver store/wallet.ts.
//  Quem chama não sabe qual das duas está no ar, e a virada é uma
//  variável de ambiente.
//
//  Esta tabela é a carteira LOCAL. Ela NÃO é migrada para a remota
//  automaticamente: são carteiras diferentes, e somar uma na outra
//  sem alguém mandar seria inventar dinheiro.
//
//  ####  O EXTRATO NÃO É LUXO  ####
//
//  Sem \`wallet_entries\`, "eu tinha 500 e agora tenho 200" não tem
//  resposta — e essa pergunta chega no primeiro dia. O saldo é o
//  estado; o extrato é o que explica como se chegou nele.
//
//  ####  O ID DO LANÇAMENTO É PRÓPRIO, E NÃO DERIVADO  ####
//
//  Débito e estorno da MESMA compra compartilham a \`reference\`.
//  Derivar o id dela faria os dois colidirem no mesmo milissegundo —
//  e o jogador ficaria sem o item E sem o dinheiro.
// ------------------------------------------------------------
const WALLETS_SCHEMA = `
CREATE TABLE wallets (
  steam_id TEXT PRIMARY KEY,

  -- INTEIRO, e nunca negativo. Quem impede de verdade é a transação
  -- do repositório; o CHECK é a rede embaixo dela — um saldo
  -- negativo gravado é dinheiro inventado que ninguém explica
  -- depois.
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),

  updated_at INTEGER NOT NULL
);

CREATE TABLE wallet_entries (
  id       TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL,

  -- A VARIAÇÃO (negativa no débito) e o saldo DEPOIS dela. Os dois,
  -- porque recalcular o saldo somando o extrato inteiro é a conta
  -- que sai errada no dia em que uma linha se perde.
  amount  INTEGER NOT NULL,
  balance INTEGER NOT NULL,

  reason TEXT NOT NULL,
  -- O que liga o lançamento à compra. Ver o cabeçalho.
  reference TEXT,

  created_at INTEGER NOT NULL
);

CREATE INDEX idx_wallet_entries_player ON wallet_entries (steam_id, created_at DESC);
`;

// ------------------------------------------------------------
//  017 — a compra entra na linha do tempo do jogador
//
//  Mesmo motivo do VIP e do kit na 014, e o mesmo procedimento: o
//  SQLite não altera um CHECK no lugar, então a tabela é recriada
//  com os dados copiados.
//
//  ####  POR QUE ELA PRECISA ESTAR NA FICHA  ####
//
//  `store_purchases` responde "o que ele comprou". A ficha responde
//  outra coisa: "o que aconteceu com este jogador, em ordem" — e
//  "comprou VIP Ouro" ao lado do banimento da semana seguinte é
//  exatamente o que o suporte lê antes de responder.
// ------------------------------------------------------------
const PLAYER_EVENTS_STORE_SCHEMA = `
ALTER TABLE player_events RENAME TO player_events_014;

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
  --   'compra'    comprou algo na loja
  kind TEXT NOT NULL
    CHECK (kind IN ('join', 'leave', 'kick', 'teleport', 'vip', 'kit', 'compra')),

  at INTEGER NOT NULL,
  actor TEXT,
  detail TEXT
);

INSERT INTO player_events (id, steam_id, server_id, kind, at, actor, detail)
SELECT id, steam_id, server_id, kind, at, actor, detail FROM player_events_014;

DROP TABLE player_events_014;

CREATE INDEX idx_player_events_player ON player_events (steam_id, at DESC);
`;

// ------------------------------------------------------------
//  018 — o extrato ganha uma ordem estável
//
//  ####  DOIS LANÇAMENTOS DO MESMO MILISSEGUNDO EMBARALHAVAM  ####
//
//  MEDIDO no teste: `created_at` é a ordenação do extrato, e o
//  desempate era o `id` — que na 016 era um UUID ALEATÓRIO. Débito e
//  estorno de uma compra que falha rápido caem no mesmo
//  milissegundo, e a ordem entre eles saía sorteada.
//
//  O sintoma é pior do que parece: a coluna "saldo depois" só faz
//  sentido em sequência. Fora de ordem, o extrato mostra o saldo
//  subindo antes de cair — e quem o lê para conferir uma cobrança
//  conclui que a conta não fecha.
//
//  Com \`AUTOINCREMENT\`, a ordem de INSERÇÃO vira o desempate, e ela
//  é a ordem real dos fatos. O id continua PRÓPRIO (não derivado da
//  \`reference\`), que era a razão de ele não ser a chave da compra —
//  ver o cabeçalho da 016.
// ------------------------------------------------------------
const WALLET_ENTRIES_ORDER_SCHEMA = `
ALTER TABLE wallet_entries RENAME TO wallet_entries_016;

CREATE TABLE wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  steam_id TEXT NOT NULL,
  amount   INTEGER NOT NULL,
  balance  INTEGER NOT NULL,

  reason    TEXT NOT NULL,
  reference TEXT,

  created_at INTEGER NOT NULL
);

-- Sem o \`id\` antigo: ele era um UUID, e numerar de novo pela data é
-- justamente a ordem que se quer daqui em diante.
INSERT INTO wallet_entries (steam_id, amount, balance, reason, reference, created_at)
SELECT steam_id, amount, balance, reason, reference, created_at
  FROM wallet_entries_016
 ORDER BY created_at ASC;

DROP TABLE wallet_entries_016;

CREATE INDEX idx_wallet_entries_player ON wallet_entries (steam_id, created_at DESC);
`;

// ------------------------------------------------------------
//  019 — o kit ganha categoria
//
//  ####  A VITRINE PRECISA DE ABAS PELO MESMO MOTIVO DA LOJA  ####
//
//  Oito kits cabem numa página; vinte não. Sem um agrupamento, o
//  jogador pagina até achar — e "onde está o kit de VIP?" vira uma
//  busca em vez de um clique.
//
//  ####  TEXTO LIVRE, E NÃO UMA TABELA  ####
//
//  Uma tabela de categorias (como a da loja) traria id, ordem e
//  ligado/desligado — três coisas para manter por uma aba que só
//  precisa de um nome. A loja tem essa tabela porque lá a categoria
//  é o que o admin publica e despublica; aqui ela é um rótulo.
//
//  NULL = sem categoria. A tela junta esses num grupo "GERAL", e não
//  mostra aba nenhuma quando todos caem nele.
// ------------------------------------------------------------
const KIT_CATEGORY_SCHEMA = `
ALTER TABLE kits ADD COLUMN category TEXT;
`;

// ------------------------------------------------------------
//  020 — o kit que só libera algum tempo depois do wipe
//
//  ####  O PRIMEIRO DIA É O QUE DECIDE O WIPE  ####
//
//  Um kit avançado entregue na primeira hora apaga a corrida inicial
//  — que é a parte do jogo que traz gente de volta a cada wipe. Com
//  o atraso, ele continua existindo e deixa de ser um atalho para
//  pular o começo.
//
//  ####  EM SEGUNDOS, COMO O COOLDOWN  ####
//
//  Mesma unidade da coluna ao lado, pelo mesmo motivo: minuto e hora
//  são formatação, e formatação no banco é o que faz dois lugares
//  discordarem sobre o que "2" significa.
//
//  NULL = sem bloqueio, que é o caso da esmagadora maioria.
//
//  A hora do wipe NÃO é gravada aqui: quem a sabe é o servidor
//  (`SaveCreatedTime` do `serverinfo`) — ver game/wipe.ts.
// ------------------------------------------------------------
const KIT_WIPE_DELAY_SCHEMA = `
ALTER TABLE kits ADD COLUMN wipe_delay_seconds INTEGER;
`;

// ------------------------------------------------------------
//  021 — quem mexeu na loja, e o quê
//
//  ####  O PREÇO MUDA E NINGUÉM SABE QUEM MUDOU  ####
//
//  `store_offers` guarda o preço de AGORA. Quando um item amanhece
//  custando o dobro, ela não tem como responder "quem fez isso, e
//  quando?" — e essa é exatamente a pergunta que aparece quando o
//  primeiro jogador reclama.
//
//  O log do processo registra (as rotas já logam), mas ele rola: em
//  duas semanas a linha sumiu. Isto fica.
//
//  ####  O QUE ELE GUARDA É O FATO, NÃO O ESTADO  ####
//
//  `detail` é uma frase pronta ("preço 5000 -> 4500"), e não um
//  diff estruturado. Um diff exigiria versionar a oferta inteira
//  para ser reconstruído, e o que se lê numa auditoria é a FRASE —
//  quem quiser o estado de hoje abre a vitrine.
// ------------------------------------------------------------
const STORE_AUDIT_SCHEMA = `
CREATE TABLE store_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  at INTEGER NOT NULL,

  -- Quem. NULL = veio pelo token de integração (o site), e não de
  -- uma sessão do painel.
  actor TEXT,

  -- O que aconteceu: 'category.create', 'offer.update',
  -- 'wallet.credit'… Texto livre porque a lista cresce com a loja, e
  -- um CHECK aqui viraria uma migração por ação nova.
  action TEXT NOT NULL,

  -- Sobre o quê: o NOME da oferta ou o SteamID. Nome, e não id: quem
  -- lê a auditoria quer reconhecer, e o id de uma oferta apagada não
  -- diz nada.
  target TEXT NOT NULL,

  detail TEXT
);

-- A tela lê os últimos. Sem o índice, cada abertura varre a tabela
-- que mais cresce depois das compras.
CREATE INDEX idx_store_audit_at ON store_audit (at DESC);
`;

// ------------------------------------------------------------
//  022 — com quanta vida, fome e sede cada grupo nasce
//
//  ####  POR QUE NÃO É COLUNA NA `loadouts`  ####
//
//  Porque são duas configurações com ciclos de vida diferentes, e o
//  jogo já as trata assim: o kit viaja no `origemz.loadout.sync` e o
//  status no `origemz.status.sync`, cada um trocando o SEU cache.
//  Colar os dois numa linha só faria "desliguei o loadout deste
//  grupo" apagar junto o status dele — e ninguém pediu isso.
//
//  Grupo pode ter status sem kit (nasce pelado, mas de barriga
//  cheia) e kit sem status (recebe o kit e o jogo decide o resto).
//
//  ####  NULL É "O JOGO DECIDE", E NÃO ZERO  ####
//
//  É o contrato do plugin, e ele é explícito: o `SpawnStatusPayload`
//  usa `float?` justamente porque zero de fome é nascer morrendo, e
//  isso é diferente de não configurar nada. Uma coluna NOT NULL
//  DEFAULT 0 transformaria os dois casos no pior deles.
//
//  Linha com os três nulos é a mesma coisa que não haver linha — o
//  plugin descarta essa entrada ao montar o cache. A tela evita
//  criar uma; o banco não precisa proibir.
// ------------------------------------------------------------
const SPAWN_STATUS_SCHEMA = `
CREATE TABLE spawn_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O NOME DO GRUPO do Oxide, pelas mesmas razões da 011: a lista é
  -- derivada dos grupos daquele servidor, e não mantida aqui.
  group_name TEXT NOT NULL,

  -- REAL, e não INTEGER: o jogo trabalha em float, e 62.5 de sede é
  -- valor legítimo. NULL = o jogo decide aquele atributo.
  health REAL,
  calories REAL,
  hydration REAL,

  -- Desligado é diferente de apagado, como no loadout: o status
  -- continua guardado aqui e some do payload empurrado.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT,

  UNIQUE (server_id, group_name)
);
`;

// ------------------------------------------------------------
//  023 — a agenda do wipe
//
//  ####  DUAS TABELAS, E ELAS RESPONDEM PERGUNTAS DIFERENTES ####
//
//      wipe_settings   de quanto em quanto tempo este servidor
//                      zera, em que horário e o que o wipe leva
//      wipe_plans      o calendário MATERIALIZADO: cada wipe que
//                      vai acontecer, um por linha
//
//  ####  POR QUE A AGENDA É MATERIALIZADA  ####
//
//  Porque um wipe agendado é algo que se EDITA — adiar, pular,
//  trocar a política de blueprint, escolher o mapa — e não dá para
//  editar o resultado de uma função. O agente materializa ~90 dias
//  e reconcilia quando a configuração muda, preservando o que foi
//  editado à mão e nunca tocando no passado. Ver
//  db/wipe-schedule-repository.ts e Docs\16 §7.
//
//  ####  E POR QUE NÃO HÁ TABELA DE DATAS DE FORCE WIPE  ####
//
//  "Primeira quinta do mês, 19:00 UTC" são dez linhas de código e
//  valem para sempre (wipe/schedule.ts). Um array de datas
//  chumbadas envelhece em silêncio: no dia em que ele acaba, o
//  agente para de agendar e ninguém percebe até o wipe não
//  acontecer.
//
//  ####  A CONFIGURAÇÃO É CHAVE/VALOR, POR SERVIDOR  ####
//
//  As frentes seguintes gravam AQUI as chaves delas — os avisos, o
//  backup, a lista do full wipe — sem migração nova. E chave a
//  chave, e não um JSON só: assim um valor corrompido não leva os
//  outros nove junto, e a leitura cai no padrão daquela chave.
// ------------------------------------------------------------
const WIPE_SCHEDULE_SCHEMA = `
CREATE TABLE wipe_settings (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- 'cadence.everyDays', 'collision.policy', 'forced.bpPolicy'…
  -- Prefixo do bloco a que a chave pertence.
  key   TEXT NOT NULL,
  value TEXT NOT NULL,

  updated_at INTEGER NOT NULL,

  PRIMARY KEY (server_id, key)
);

CREATE TABLE wipe_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- Epoch ms UTC, como toda data deste banco. O horário local do
  -- admin (16:00) mora em wipe_settings como texto MAIS o fuso
  -- IANA, e vira instante no cálculo — nunca antes.
  scheduled_at INTEGER NOT NULL,

  -- De onde este wipe veio. 'manual' é o que um humano marcou, e é
  -- o único que a reconciliação nunca recria.
  kind TEXT NOT NULL CHECK (kind IN ('cadence', 'forced', 'manual')),

  -- O que ele faz com o que o jogador APRENDEU.
  bp_policy TEXT NOT NULL CHECK (bp_policy IN ('keep', 'wipe', 'wipe_except_vip')),

  -- De onde sai o mundo que entra no lugar. A fila de mapas é da
  -- migração 24 (Frente C) — por isso map_pool_id NÃO tem chave
  -- estrangeira aqui: a tabela dela ainda não existe neste passo, e
  -- uma FK para tabela ausente faz o SQLite recusar a inserção
  -- inteira quando o pragma está ligado.
  map_source TEXT NOT NULL DEFAULT 'pool'
    CHECK (map_source IN ('pool', 'random', 'fixed', 'keep')),
  map_pool_id INTEGER,

  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'running', 'done', 'skipped', 'failed', 'absorbed')),

  -- O forçado que cancelou este (política 'absorb'). O absorvido
  -- CONTINUA na agenda, marcado: uma lista com um buraco não
  -- explica por que terça não vai ter wipe.
  absorbed_by INTEGER REFERENCES wipe_plans(id) ON DELETE SET NULL,

  -- ####  O CAMPO QUE FAZ *ADIAR* SER ADIAR  ####
  --
  -- O instante que a REGRA gerou para esta linha. Sem ele, mover um
  -- wipe de quinta para sexta deixaria a quinta vaga, a
  -- reconciliação a recriaria, e o servidor teria DOIS wipes
  -- naquela semana. NULL = ninguém gerou, foi marcado à mão.
  generated_for INTEGER,

  -- Um humano mexeu: a reconciliação não toca mais nesta linha.
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),

  note TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Dois wipes no mesmo instante são a mesma parada de servidor
  -- contada duas vezes.
  UNIQUE (server_id, scheduled_at)
);

-- A pergunta de toda tela: "o que vem depois de agora, neste
-- servidor?". O UNIQUE acima já cobriria (server_id, scheduled_at),
-- mas ele é único e este é o índice que a varredura por faixa usa.
CREATE INDEX idx_wipe_plans_agenda ON wipe_plans (server_id, scheduled_at, status);
`;

// ------------------------------------------------------------
//  024 — a fila de mapas
//
//  Qual mundo entra no próximo wipe, e no seguinte, e no
//  seguinte. O admin acha uma seed no rustmaps.com, cola aqui, e
//  ela espera a vez.
//
//  ####  A FILA GUARDA A DECISÃO, E NÃO O MUNDO  ####
//
//  Num mapa procedural o arquivo do terreno nem existe antes de o
//  servidor subir: quem o gera é o próprio Rust, no boot, a partir
//  da seed. "Seed 18422, tamanho 4000" É o mapa — e por isso a
//  fila pode ser preenchida com meses de antecedência sem risco,
//  enquanto um `.map` gerado hoje pode não carregar no binário de
//  amanhã.
//
//  ####  O ÚNICO É PARCIAL, E ISSO É A REGRA EM SQL  ####
//
//  `(server_id, seed, world_size) WHERE status <> 'used'`: a mesma
//  seed não pode estar duas vezes ESPERANDO — isso é sempre um
//  Ctrl+V repetido — mas PODE ser reprisada meses depois, que é
//  escolha legítima. Um único total proibiria a reprise; único
//  nenhum deixaria a fila com o mesmo mundo duas vezes, e ninguém
//  perceberia até o segundo wipe.
//
//  Em mapa custom `seed` é NULL, e o SQLite trata NULL como
//  distinto num índice único — dois `.map` diferentes convivem sem
//  precisar de exceção nenhuma.
//
//  ####  AS COLUNAS DO RUSTMAPS NASCEM AQUI E FICAM VAZIAS  ####
//
//  `rustmaps_id`, `staging`, `preview_url`, `thumb_url`,
//  `monuments`, `last_error` e o status `generating` não têm quem
//  os preencha nesta migração: quem preenche é a frente do
//  RustMaps, que NÃO tem número de migração reservado (ver
//  Docs\\17 §0.1). Criá-los agora é o que evita uma migração só
//  para acrescentar coluna — e prévia é enfeite: sem ela o wipe
//  usa a seed do mesmo jeito.
//
//  ####  `version_ok` É A TRAVA DO MAPA CUSTOM  ####
//
//  Uma entrada `custom` não pode ser consumida por wipe FORÇADO
//  sem alguém garantir, na mão, que aquele arquivo serve para a
//  versão nova do jogo. A marca é uma COLUNA, e não uma pergunta
//  na hora do wipe: na madrugada do forçado não há ninguém para
//  responder.
// ------------------------------------------------------------
const WIPE_MAP_POOL_SCHEMA = `
CREATE TABLE map_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- A ordem na fila. Entra no próximo wipe o menor \`position\`
  -- pronto. Buraco é normal: apagar a entrada do meio não
  -- renumera as outras.
  position INTEGER NOT NULL,

  kind TEXT NOT NULL DEFAULT 'procedural' CHECK (kind IN ('procedural', 'custom')),

  -- TEXTO, e não INTEGER: a seed é transportada, comparada e
  -- exibida — nunca somada. Como texto ela atravessa o .ini, o
  -- RCON e a URL do RustMaps sem ganhar um ".0" no caminho.
  -- NULL em mapa custom.
  seed TEXT,

  -- 1000..6000, conferido na borda. NULL em mapa custom: o .map
  -- traz o tamanho dele dentro.
  world_size INTEGER,

  -- \`server.level\`. Texto livre porque um mapa de fora traz o
  -- nome dele.
  level TEXT,

  -- O .map de fora, para \`server.levelurl\`. NULL em procedural.
  level_url TEXT,

  -- ---- o que o RustMaps preenche (ver o cabeçalho) ----
  rustmaps_id TEXT,
  staging INTEGER NOT NULL DEFAULT 0 CHECK (staging IN (0, 1)),
  preview_url TEXT,
  thumb_url TEXT,
  -- JSON com os nomes dos monumentos. NULL = não sabemos, que é
  -- diferente de "nenhum".
  monuments TEXT,

  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('draft', 'generating', 'ready', 'used', 'failed')),

  -- Por que a geração ou a validação da URL falhou, na língua de
  -- quem lê a tela.
  last_error TEXT,

  -- A marca "compatível com a versão nova". Ver o cabeçalho.
  version_ok INTEGER NOT NULL DEFAULT 0 CHECK (version_ok IN (0, 1)),

  -- O recado de quem colou a seed, para quem for ler a fila
  -- depois ("o mapa da liga", "pedido do Discord").
  note TEXT,

  -- Epoch ms de quando este mundo entrou num wipe. NULL = ainda
  -- na fila.
  used_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A regra do cabeçalho, em SQL.
CREATE UNIQUE INDEX idx_map_pool_seed
    ON map_pool (server_id, seed, world_size)
 WHERE status <> 'used';

-- A tela abre pela fila daquele servidor, em ordem.
CREATE INDEX idx_map_pool_queue ON map_pool (server_id, position);

-- "Que mapas já jogamos?" varre só as usadas, da mais recente
-- para trás — é a consulta do aviso de seed repetida.
CREATE INDEX idx_map_pool_used ON map_pool (server_id, used_at DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'servers', sql: SERVERS_SCHEMA },
  { id: 2, name: 'plugins', sql: PLUGINS_SCHEMA },
  { id: 3, name: 'custom-plugins', sql: CUSTOM_PLUGINS_SCHEMA },
  { id: 4, name: 'plugin-dependencies', sql: PLUGIN_DEPENDENCIES_SCHEMA },
  { id: 5, name: 'bans', sql: BANS_SCHEMA },
  { id: 6, name: 'players', sql: PLAYERS_SCHEMA },
  { id: 7, name: 'items', sql: ITEMS_SCHEMA },
  { id: 8, name: 'ui-documents', sql: UI_DOCUMENTS_SCHEMA },
  // 010 em diante: VIP, loadouts e kits — a outra frente. As
  // duas faixas nunca se cruzaram, e por isso as migracoes
  // entram na ordem em que foram escritas.
  { id: 10, name: 'vips', sql: VIPS_SCHEMA },
  { id: 11, name: 'loadouts', sql: LOADOUTS_SCHEMA },
  { id: 12, name: 'kits', sql: KITS_SCHEMA },
  { id: 13, name: 'kit-claims', sql: KIT_CLAIMS_SCHEMA },
  { id: 14, name: 'player-events-vip-kit', sql: PLAYER_EVENTS_VIP_SCHEMA },
  { id: 15, name: 'store', sql: STORE_SCHEMA },
  { id: 16, name: 'wallets', sql: WALLETS_SCHEMA },
  { id: 17, name: 'player-events-store', sql: PLAYER_EVENTS_STORE_SCHEMA },
  { id: 18, name: 'wallet-entries-order', sql: WALLET_ENTRIES_ORDER_SCHEMA },
  { id: 19, name: 'kit-category', sql: KIT_CATEGORY_SCHEMA },
  { id: 20, name: 'kit-wipe-delay', sql: KIT_WIPE_DELAY_SCHEMA },
  { id: 21, name: 'store-audit', sql: STORE_AUDIT_SCHEMA },
  { id: 22, name: 'spawn-status', sql: SPAWN_STATUS_SCHEMA },
  // 023 em diante: wipe, calendário e mensagens. Os números estão
  // reservados por frente (Docs\17 §0.1) — duas frentes escrevendo
  // o mesmo número dão merge limpo e banco quebrado.
  { id: 23, name: 'wipe-schedule', sql: WIPE_SCHEDULE_SCHEMA },
  { id: 24, name: 'wipe-map-pool', sql: WIPE_MAP_POOL_SCHEMA },
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
