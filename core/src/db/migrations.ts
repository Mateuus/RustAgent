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

import { rewriteLegacyPattern } from '../wipe/plugin-data.js';
import type { Logger } from '../logger.js';
import type { AgentDatabase } from './database.js';

interface MigrationBase {
  /** Ordem de aplicação. Único e crescente. */
  readonly id: number;
  /** Só para o log e para quem lê a tabela de controle. */
  readonly name: string;
}

/** O caso normal: DDL fixa, que não depende de nada. */
export interface SqlMigration extends MigrationBase {
  readonly sql: string;
}

/**
 * O caso raro: a migração precisa OLHAR o banco antes de decidir.
 *
 * Existe por causa das migrações de CONSERTO — as que acertam um
 * banco que rodou uma versão anterior de uma migração já aplicada
 * (ver a 030). Elas encontram bancos em dois estados: o que
 * precisa do conserto e o que já nasceu certo. Em SQL puro não há
 * como escrever "acrescente esta coluna se ela faltar", e um
 * `ALTER TABLE ADD COLUMN` solto derrubaria toda instalação NOVA
 * com "duplicate column name".
 *
 * Continua valendo tudo o que vale para as outras: roda uma vez,
 * dentro da mesma transação, e fica registrada em
 * `schema_migrations`.
 */
export interface RunMigration extends MigrationBase {
  /**
   * O `logger` é opcional porque o teste aplica passos sem um.
   *
   * Ele existe para as migrações que MEXEM em escolha do admin: um
   * `ALTER TABLE` não precisa contar nada a ninguém, mas reescrever
   * uma linha que o admin gravou precisa deixar dito o que virou o
   * quê. Ver a 032.
   */
  readonly run: (db: AgentDatabase, logger?: Logger) => void;
}

export type Migration = SqlMigration | RunMigration;

/**
 * Executa o passo, seja ele texto ou função.
 *
 * Exportada porque o teste também precisa aplicar uma migração
 * avulsa para montar um banco parado num id — e ter DOIS lugares
 * decidindo como um passo roda é o começo de eles discordarem.
 */
export function applyMigration(db: AgentDatabase, migration: Migration, logger?: Logger): void {
  if ('sql' in migration) {
    db.exec(migration.sql);
    return;
  }

  migration.run(db, logger);
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

// ------------------------------------------------------------
//  026 — o que o servidor fala sozinho  *(Frente E)*
//
//  ####  A MENSAGEM É DE REDE, COMO VIP, KIT E LOJA  ####
//
//  Não há `server_id` na tabela `messages`: há uma LISTA de alvos
//  em `message_targets`, e lista VAZIA quer dizer TODOS. Escrever a
//  mensagem uma vez e escolher onde ela sai é o que impede cinco
//  cópias do mesmo aviso — e a sexta correção entrando em quatro
//  delas.
//
//  ####  O RITMO É DE CADA MENSAGEM, E NÃO DO SERVIDOR  ####
//
//  O agente antigo tinha UM intervalo e um rodízio de frases. Aqui
//  cada linha sabe quando é a próxima dela, e é o que permite o
//  convite do Discord de meia em meia hora conviver com o aviso de
//  manutenção de uma vez só, na terça de madrugada.
//
//  ####  HORÁRIO LOCAL É TEXTO `HH:MM` MAIS A ZONA IANA  ####
//
//  Nunca um instante com fuso embutido, exatamente como no wipe. É
//  o que impede a mensagem das 20:00 deslizar uma hora sozinha em
//  novembro. Instante mesmo — `run_at`, `last_sent_at`, `next_at` —
//  é epoch ms UTC, como todas as outras datas deste banco.
//
//  ####  `next_at` É ESTADO, E É POR ISSO QUE ELE É INDEXADO  ####
//
//  O relógio pergunta "quem venceu?" de 30 em 30 segundos, para
//  sempre. Sem o índice, essa pergunta varreria a tabela inteira
//  duas vezes por minuto pelo resto da vida do processo.
//
//  ####  E O LOG GUARDA TAMBÉM O QUE NÃO SAIU  ####
//
//  A pergunta que ele responde é "essa mensagem está mesmo
//  aparecendo?", e um log só de sucessos responde "sim" justamente
//  quando a resposta é "não".
// ------------------------------------------------------------
const MESSAGES_SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- O nome na lista. É de quem administra; o jogador nunca o vê.
  name TEXT NOT NULL,

  -- O que sai no chat, com as variáveis ainda por resolver:
  -- {servidor}, {online}, {wipe.faltam}. Variável desconhecida vai
  -- LITERAL para o chat — ver core/src/messages/variables.ts.
  text TEXT NOT NULL,

  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- A ordem na tela, de 10 em 10 para caber alguém no meio. O mesmo
  -- padrão do 'announcements' do agente anterior.
  position INTEGER NOT NULL DEFAULT 0,

  schedule_kind TEXT NOT NULL
    CHECK (schedule_kind IN ('interval', 'daily', 'weekly', 'once')),

  -- De quantos em quantos segundos, no ritmo 'interval'.
  every_seconds INTEGER,

  -- A hora local 'HH:MM' do 'daily' e do 'weekly'.
  time_of_day TEXT,

  -- Os dias do 'weekly', como '1,4', com 0 = domingo.
  --
  -- Texto, e não uma tabela de ligação: são no máximo sete números
  -- que só existem juntos, sempre lidos com a mensagem e sempre
  -- gravados de uma vez. Uma tabela seria um JOIN a mais em toda
  -- leitura para nunca ser consultada sozinha.
  weekdays TEXT,

  -- O instante do 'once', em epoch ms UTC.
  run_at INTEGER,

  -- A zona IANA em que os horários acima são lidos.
  time_zone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',

  -- A janela: 'HH:MM' nos dois, ou NULL nos dois = a qualquer hora.
  -- Ela PODE virar a meia-noite ('22:00'-'02:00'), e o motor sabe
  -- disso — a comparação ingênua faria a mensagem nunca sair.
  window_from TEXT,
  window_to TEXT,

  -- Não fala para servidor vazio: o horário fica de pé até alguém
  -- entrar, em vez de o contador correr sozinho na madrugada.
  only_with_players INTEGER NOT NULL DEFAULT 0 CHECK (only_with_players IN (0, 1)),
  min_players INTEGER NOT NULL DEFAULT 1,

  -- A aparência, toda opcional: NULL = o padrão do plugin de chat.
  tag TEXT,
  tag_color TEXT,
  color TEXT,
  size INTEGER,

  -- Gravado DEPOIS da entrega, nunca antes: uma mensagem que o RCON
  -- recusou não pode aparecer na tela como enviada.
  last_sent_at INTEGER,

  -- Quando ela sai de novo. NULL = não há próxima, e é assim que a
  -- 'once' se desliga sozinha depois de sair.
  next_at INTEGER,

  sent_count INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A consulta do relógio, e a única que roda para sempre.
CREATE INDEX idx_messages_due ON messages (enabled, next_at);

CREATE TABLE message_targets (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  PRIMARY KEY (message_id, server_id)
);

CREATE TABLE message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,

  -- SEM chave estrangeira para servers, de propósito: o histórico
  -- responde "saiu naquele dia, naquele servidor", e apagar um
  -- servidor da frota não desfaz o que foi dito nele. É a mesma
  -- razão pela qual a auditoria da loja guarda o NOME.
  server_id TEXT NOT NULL,

  at INTEGER NOT NULL,

  -- Quantos receberam, segundo o plugin. Pelo 'say' é sempre 0, e
  -- ali 0 quer dizer DESCONHECIDO: o jogo não devolve esse número.
  players INTEGER NOT NULL DEFAULT 0,

  ok INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),

  -- Por que não saiu. NULL quando saiu.
  error TEXT
);

-- A tela lê as últimas DAQUELA mensagem.
CREATE INDEX idx_message_log_message ON message_log (message_id, at DESC);
`;

// ------------------------------------------------------------
//  025  -  AS EXECUÇÕES  (Frente D)
//
//  ####  A OPERAÇÃO VIVE EM MEMÓRIA; O WIPE PRECISA DE MAIS  ####
//
//  Toda operação do agente (instalar, subir, atualizar) mora no
//  `OperationStore`, que guarda vinte e some no `pm2 restart`.
//  Para um wipe isso não basta por dois motivos, e cada um deles é
//  uma tabela aqui:
//
//    1. "o que aconteceu no wipe do dia 6?" é uma pergunta feita
//       SEMANAS depois. `wipe_runs` responde.
//    2. "retomar do passo que falhou" exige saber em que passo
//       parou. `wipe_run_steps` responde — e é o que impede a
//       única alternativa, que seria rodar tudo de novo e apagar
//       um mundo que já é o novo.
//
//  ####  E A TERCEIRA TABELA É A CONFERÊNCIA INDEPENDENTE  ####
//
//  `wipes` não é o que a execução RELATOU: é o mundo que o
//  `WipeClock` VIU nascer, lendo o `SaveCreatedTime` do próprio
//  servidor. As duas coisas podem discordar — uma execução que
//  relata sucesso e um save que não mudou é exatamente o defeito
//  que ninguém pega sem uma segunda fonte. Ver Docs\16 §6.
//
//  Ela também é lida por quem não é desta frente: a fila de mapas
//  pergunta a ela quais seeds saíram nos últimos wipes (ver
//  `recentSeeds` em db/map-pool-repository.ts), e por isso as
//  colunas `server_id`, `seed` e `detected_at` são contrato.
// ------------------------------------------------------------
const WIPE_RUNS_SCHEMA = `
CREATE TABLE wipe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O wipe da agenda que virou esta execução. NULL = "WIPAR
  -- AGORA", que não sai de plano nenhum.
  plan_id INTEGER REFERENCES wipe_plans(id) ON DELETE SET NULL,

  -- O \`op_xxxxxxxx\` do OperationStore ENQUANTO ele existe. Depois
  -- do restart ele aponta para nada, e é justamente assim que o
  -- boot descobre a execução órfã: linha \`running\` cuja operação
  -- não está mais viva.
  operation_id TEXT,

  -- ####  O QUE IMPEDE O DUPLO-CLIQUE DE ZERAR DUAS VEZES  ####
  --
  -- A \`Idempotency-Key\` do POST. O índice único abaixo é a
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

  -- Quando a EXECUÇÃO começou. Ela começa antes do wipe: o passo
  -- \`avisar\` precisa do tempo dos offsets ("faltam 15 min") para
  -- caber inteiro.
  started_at INTEGER NOT NULL,

  -- Quando o MUNDO zera. É a hora que o jogador vê no aviso, e a
  -- que separa \`started_at\` de "a que horas foi o wipe do dia 6".
  -- Igual a \`started_at\` num wipe sem aviso nenhum.
  wipe_at INTEGER NOT NULL,

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

  -- O \`SaveCreatedTime\` lido antes e depois. Os dois iguais no
  -- fim é um wipe que RELATOU sucesso sem ter trocado o mundo.
  save_created_before INTEGER,
  save_created_after INTEGER,

  -- A frase do desfecho, na língua de quem lê a tela.
  message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Ver o comentário de \`idempotency_key\`. PARCIAL porque a maior
-- parte das execuções (as que o relógio dispara) não tem chave
-- nenhuma, e NULL não colide com NULL neste índice.
CREATE UNIQUE INDEX idx_wipe_runs_idempotency
    ON wipe_runs (server_id, idempotency_key)
 WHERE idempotency_key IS NOT NULL;

-- A tela abre pelo histórico daquele servidor, do mais novo para
-- o mais velho.
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

  -- O \`SaveCreatedTime\` do \`serverinfo\`, em epoch ms: a hora em
  -- que aquele mundo NASCEU. É a identidade do mundo, e por isso
  -- é ele que carrega o índice único.
  save_created_at INTEGER NOT NULL,

  level TEXT,

  -- TEXTO, como em \`map_pool.seed\`, e pelo mesmo motivo: ela é
  -- comparada e exibida, nunca somada.
  seed TEXT,

  world_size INTEGER,

  -- Quando o AGENTE viu. Diferente de \`save_created_at\` sempre
  -- que o mundo nasceu com o agente parado.
  detected_at INTEGER NOT NULL,

  -- A execução que criou este mundo. NULL = apareceu sem o agente
  -- ter mandado (wipe na mão, servidor adotado com mundo velho) —
  -- e registrar isso é o que impede a agenda de mentir.
  wipe_run_id INTEGER REFERENCES wipe_runs(id) ON DELETE SET NULL
);

-- Um mundo é um \`save_created_at\`. Ver o \`INSERT OR IGNORE\` de
-- db/wipes-repository.ts: sem este índice, cada boot do agente
-- registraria o mesmo mundo de novo.
CREATE UNIQUE INDEX idx_wipes_world ON wipes (server_id, save_created_at);

-- A fila de mapas pergunta "quais seeds saíram por último?".
CREATE INDEX idx_wipes_recent ON wipes (server_id, detected_at DESC);
`;

// ------------------------------------------------------------
//  028 — os blueprints que sobrevivem ao wipe
//
//  ####  POR QUE PRESERVAR POR ARQUIVO NÃO FUNCIONA  ####
//
//  `player.blueprints.<n>.db` é UM arquivo só, de todos os
//  jogadores: não há como apagar "os BPs de quem não é VIP"
//  recortando arquivo. E quando a Facepunch muda o formato, o
//  número no nome muda e o arquivo antigo é ignorado inteiro — a
//  preservação por arquivo evapora justamente no wipe mais
//  importante do ano.
//
//  A saída é um snapshot LÓGICO: o plugin lê o que cada jogador
//  aprendeu (`origemz.bp.export`), o agente guarda aqui, e devolve
//  depois a quem tem direito (`origemz.bp.restore`).
//
//  ####  O SNAPSHOT É DE TODO MUNDO  ####
//
//  E não só de quem é VIP. Salvar só de VIP criaria o caso em que
//  alguém compra VIP no dia seguinte ao wipe e não tem o que
//  restaurar. O direito é conferido na DEVOLUÇÃO, contra o VIP
//  vigente naquele instante — por isso `bp_restores.tier` é
//  preenchida na saída, e não na entrada.
//
//  ####  E ELE VALE PARA O WIPE SEGUINTE, E SÓ ELE  ####
//
//  Um snapshot novo substitui o anterior inteiro (ver
//  db/bp-repository.ts). Restaurar o BP de três wipes atrás é
//  ressuscitar vantagem que ninguém lembra ter dado.
// ------------------------------------------------------------
const BP_SNAPSHOTS_SCHEMA = `
CREATE TABLE bp_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- A execução que tirou este snapshot. NULL = foi tirado na mão,
  -- pelo botão da sub-aba Blueprints.
  wipe_run_id INTEGER REFERENCES wipe_runs(id) ON DELETE SET NULL,

  -- SteamID64 em TEXTO, como em toda parte deste banco: 17 dígitos
  -- passam de 2^53 e um number arredondaria o dono do blueprint.
  steam_id TEXT NOT NULL,

  -- JSON com os itemIds que ele sabia. Inteiro do jogo, e não
  -- shortname: é o que o persistance guarda e o que o
  -- ItemManager.FindItemDefinition recebe de volta.
  items TEXT NOT NULL,

  item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Um snapshot por jogador por servidor. É o índice que faz "vale
-- para o wipe seguinte, e só ele" ser regra do banco: não existe
-- estado em que dois snapshots do mesmo jogador convivem.
CREATE UNIQUE INDEX idx_bp_snapshots_player ON bp_snapshots (server_id, steam_id);

-- "O que este wipe guardou?" — a pergunta da tela.
CREATE INDEX idx_bp_snapshots_run ON bp_snapshots (server_id, wipe_run_id);

CREATE TABLE bp_restores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- ####  ELA É ANULÁVEL, E NÃO POR DESCUIDO  ####
  --
  -- Com \`ON DELETE CASCADE\`, o snapshot novo levaria embora o
  -- registro das devoluções do wipe anterior — inclusive as que
  -- ninguém entrou para receber, que é justamente o que alguém vai
  -- querer ler depois. Com \`SET NULL\`, a linha vira histórico:
  -- ela guarda a quem era devida, o que saiu e quando, e o
  -- \`state = 'expired'\` diz que ela não vale mais.
  --
  -- E o índice único abaixo continua valendo para as VIVAS: no
  -- SQLite, NULL não colide com NULL num índice único.
  snapshot_id INTEGER REFERENCES bp_snapshots(id) ON DELETE SET NULL,

  steam_id TEXT NOT NULL,

  -- O nível de VIP usado na entrega, e a lista que de fato saiu
  -- depois da régua. Os dois NULOS enquanto ela não sai: quem
  -- decide isso é o instante da devolução, não o do snapshot.
  tier TEXT,
  items TEXT,

  -- Quando ela pode sair: a hora do wipe mais o atraso configurado.
  -- 0 h = assim que o jogador entrar.
  release_at INTEGER NOT NULL,

  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sent', 'applied', 'expired', 'failed')),

  -- Quantas vezes o comando saiu. Sem teto, um payload que o
  -- plugin sempre recusa seria retentado a cada trinta segundos
  -- até o wipe seguinte.
  attempts INTEGER NOT NULL DEFAULT 0,

  sent_at INTEGER,
  applied_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

-- ####  A IDEMPOTÊNCIA, ESCRITA EM SQL  ####
--
-- O jogador que entra e sai três vezes não recebe três vezes, e
-- não recebe zero. Um \`enqueue\` repetido (a retomada de um wipe)
-- também não duplica a fila.
CREATE UNIQUE INDEX idx_bp_restores_once ON bp_restores (snapshot_id, steam_id);

-- O relógio pergunta "o que já venceu neste servidor?".
CREATE INDEX idx_bp_restores_due ON bp_restores (server_id, state, release_at);

-- ####  A BANCADA É UM FATO DO JOGO, E SÓ O PLUGIN A CONHECE  ####
--
-- A régua por nível ("bronze volta até a bancada 1") precisa saber
-- que bancada cada item exige. Essa informação não existe do lado
-- do agente: o catálogo do \`origemz.items\` não a carrega. Ela vem
-- junto de cada página do \`origemz.bp.export\` e é guardada aqui,
-- porque a devolução acontece HORAS depois — com o servidor
-- possivelmente parado.
CREATE TABLE bp_item_benches (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,

  -- 1, 2 ou 3. Item sem bancada não é gravado: ausência é zero.
  workbench INTEGER NOT NULL,

  updated_at INTEGER NOT NULL,

  PRIMARY KEY (server_id, item_id)
);
`;

// ------------------------------------------------------------
//  027 — os eventos  *(Frente G)*
//
//  ####  A TABELA NASCE ANTES DA TELA, E DE PROPÓSITO  ####
//
//  Não há rota de evento, não há tela de evento e não há nada que
//  escreva aqui nesta fase (Docs\16 §12). A tabela existe agora
//  porque o CALENDÁRIO — o do jogo e a grade do painel — vai ler
//  wipes e eventos JUNTOS, e descobrir isso depois custaria
//  refazer os dois: a linha do calendário passaria a ter duas
//  origens e um formato de marcação que ninguém desenhou para
//  conviver.
//
//  Uma tabela vazia não custa nada; uma migração no meio de uma
//  tela pronta custa a tela.
//
//  ####  O EVENTO NÃO EXECUTA NADA  ####
//
//  Não há operação de evento, e não vai haver: quem faz o evento
//  acontecer é um plugin ou uma pessoa. Isto aqui é o que o
//  jogador LÊ — "sexta, 20:00, Raid Night" —, e é por isso que a
//  tabela tem descrição e imagem, e não tem passo, estado nem
//  log.
//
//  ####  ELE É DE UM SERVIDOR, AO CONTRÁRIO DA MENSAGEM  ####
//
//  A mensagem é de REDE (uma linha, uma lista de alvos); o evento
//  é do servidor onde ele acontece. Um "Raid Night no pvp1" não é
//  o mesmo acontecimento que um "Raid Night no pve" — eles têm
//  horários, participantes e sentidos diferentes.
//
//  E as datas são epoch ms UTC, como todas as outras deste banco.
//  Horário local sem fuso é como o evento desliza uma hora sozinho
//  em novembro.
// ------------------------------------------------------------
const EVENTS_SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O que o jogador lê na grade: 'Raid Night'.
  name TEXT NOT NULL,

  -- A família do evento, para a cor e o ícone. Texto livre porque
  -- quem inventa evento é quem administra, e uma lista fechada
  -- aqui viraria uma migração a cada ideia nova.
  kind TEXT NOT NULL DEFAULT 'evento',

  -- Epoch ms UTC. \`ends_at\` NULL = acontecimento de um instante
  -- só, e não um período.
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,

  description TEXT,
  image_url TEXT,

  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at INTEGER NOT NULL
);

-- A pergunta das duas telas é a mesma: "o que acontece neste
-- servidor daqui para a frente?".
CREATE INDEX idx_events_quando ON events (server_id, starts_at);
`;

// ------------------------------------------------------------
//  029 — a decisão de mundo do wipe, CONGELADA antes do `.ini`
//
//  ####  A DECISÃO DEPENDIA DO ARQUIVO QUE O PASSO REESCREVE  ####
//
//  `mapOfPlan` (wipe/next-wipe.ts) lê o mundo de AGORA por uma
//  pergunta só: um wipe FORÇADO não MANTÉM um `.map` custom sem a
//  marca de compatibilidade. E o passo `configurar` reescreve esse
//  mesmo mundo — ele grava `levelurl` vazia no `.ini` ANTES de
//  gravar o resultado no banco.
//
//  MEDIDO: servidor com `.map` custom sem marca, plano FORÇADO
//  mandando MANTER, fila com a entrada #1. A trava pega, o `.ini`
//  sai com a seed da #1, e o agente morre antes do commit. Na
//  retomada o `.ini` já é procedural, a trava NÃO pega, o `keep`
//  volta a valer — e o passo "mantém" um mundo que tinha acabado
//  de sair da fila: entrada #1 ainda `ready`, `map_after` sem
//  `map_pool_id`, e a régua do VIP anunciando como "o próximo
//  mundo" o mundo que já estava no ar.
//
//  Esta coluna guarda a escolha (`keep`, a entrada #N, ou "não há
//  nada na fila"), gravada ANTES do `.ini` e RELIDA na retomada.
//  Ela não consome nada: queimar a fila continua sendo o
//  `commitWorld`, depois do `.ini`. Escolher e queimar já eram
//  dois tempos; escolher e RECALCULAR passam a ser um só.
//
//  NULL = o passo `configurar` ainda não decidiu, e é assim que
//  nascem todas as execuções — inclusive as que já estavam no
//  banco quando esta coluna chegou.
// ------------------------------------------------------------
const WIPE_RUN_MAP_DECISION_SCHEMA = `
ALTER TABLE wipe_runs ADD COLUMN map_decision TEXT;
`;

// ------------------------------------------------------------
//  030 — a `wipe_at` que ficou de fora de quem migrou cedo
//
//  ####  ESTA MIGRAÇÃO NÃO ACRESCENTA NADA AO SCHEMA  ####
//
//  Ela CONSERTA. O schema de hoje já tem `wipe_runs.wipe_at`
//  desde a 025 — mas houve uma janela em que a 025 já existia,
//  já rodava, e a coluna ainda não tinha sido escrita nela.
//  MEDIDO: o banco de desenvolvimento aplicou a 025 em
//  2026-08-18 23:38, e a coluna entrou no `CREATE TABLE` da 025
//  no commit ef21855, das 00:12 do dia seguinte.
//
//  E uma migração roda UMA VEZ: `runMigrations` pula todo id que
//  já está em `schema_migrations`. Editar a 025 depois não toca
//  em banco nenhum que já a rodou. Aquele banco ficou com a 025
//  marcada como aplicada e sem a coluna — e o agente parou de
//  subir, em `wipeRuns.running()`, com `no such column: wipe_at`.
//  Docs\17 §0.1 já avisava desta classe de defeito; o teste que
//  passa a pegá-la é core/test/schema-banco-antigo.test.ts.
//
//  ####  POR QUE `NOT NULL DEFAULT 0`, E NÃO ANULÁVEL  ####
//
//  Num banco NOVO a coluna é `INTEGER NOT NULL`, e é isso que o
//  código conta: `WipeRunsRepository` lê `wipe_at` como número
//  (nunca `number | null`) e SEMPRE o nomeia no INSERT. Deixá-la
//  anulável no banco velho faria os dois bancos discordarem
//  justamente na garantia que importa — e um dia um NULL chegaria
//  na tela como `Invalid Date`.
//
//  O SQLite, por sua vez, recusa `ADD COLUMN ... NOT NULL` sem
//  default: ele teria de inventar um valor para as linhas que já
//  existem. Então o default é o preço do `NOT NULL`, e ele nunca
//  entra em jogo — todo INSERT do repositório nomeia a coluna.
//
//  Sobram duas diferenças cosméticas contra um banco novo: o
//  `DEFAULT 0` e a posição da coluna (o SQLite só acrescenta no
//  fim). Nenhuma das duas é lida: nenhuma consulta deste projeto
//  usa `SELECT *` em `wipe_runs` nem lê coluna por posição. As
//  duas estão fixadas em teste, para não virarem descoberta.
//
//  Zerá-las exigiria RECONSTRUIR a tabela — e aí o remédio seria
//  pior: `wipe_run_steps` referencia `wipe_runs(id)` com
//  ON DELETE CASCADE, e com `foreign_keys = ON` (database.ts) o
//  DROP da tabela pai dispara a cascata. O conserto apagaria o
//  histórico de passos de todo wipe já executado.
//
//  ####  O BACKFILL É `started_at`  ####
//
//  A 025 define `wipe_at` como a hora em que o MUNDO zera, "igual
//  a `started_at` num wipe sem aviso nenhum". Uma execução
//  anterior à coluna não guardou outro horário — e não existe
//  outro para inventar.
//
//  ####  E POR QUE ELA É FUNÇÃO, E NÃO SQL  ####
//
//  Ela roda nos dois tipos de banco: no que precisa do conserto e
//  no que nasceu certo, onde a 025 de hoje já criou a coluna. Um
//  `ALTER TABLE ADD COLUMN` solto derrubaria toda instalação NOVA
//  com "duplicate column name", no primeiro boot. Em SQL puro não
//  há "se faltar"; a pergunta ao `pragma_table_info` responde.
// ------------------------------------------------------------
function addWipeAtIfMissing(db: AgentDatabase): void {
  const existing = db
    .prepare(`SELECT 1 AS ok FROM pragma_table_info('wipe_runs') WHERE name = 'wipe_at'`)
    .get();

  // Banco novo: a 025 de hoje já a criou, no lugar certo e sem
  // default. Nada a fazer — e é isto que deixa esta migração
  // rodar em qualquer banco sem explodir.
  if (existing !== undefined) {
    return;
  }

  db.exec(`
    ALTER TABLE wipe_runs ADD COLUMN wipe_at INTEGER NOT NULL DEFAULT 0;

    -- Só as linhas que existiam ANTES da coluna, que são todas as
    -- que existem neste ponto: quem escreve daqui para a frente
    -- nomeia \`wipe_at\` no INSERT.
    UPDATE wipe_runs SET wipe_at = started_at;
  `);
}

// ------------------------------------------------------------
//  031 — o começo da TENTATIVA de cada passo do wipe
//
//  ####  UMA COLUNA SÓ RESPONDIA A DUAS PERGUNTAS  ####
//
//  `wipe_run_steps.started_at` responde "a que horas este passo
//  começou pela primeira vez", e por isso a retomada o PRESERVA
//  (ver `markStep` em db/wipe-runs-repository.ts). Só que o par
//  `started_at`/`finished_at` também é a única conta de duração
//  que existe — e numa retomada os dois carimbos passam a ser de
//  execuções DIFERENTES: o começo da tentativa que morreu, e o
//  fim da tentativa que concluiu.
//
//  MEDIDO na simulação (cenário D, o `process.exit` no meio do
//  `apagar`): o passo apagou 8 arquivos em ~10 ms e o banco
//  marcou 20.901 ms — os 20 s em que o agente esteve MORTO entre
//  o crash e a retomada. Retomar na manhã seguinte daria um
//  `apagar` de dez horas.
//
//  ####  POR QUE UMA COLUNA NOVA, E NÃO REDEFINIR `started_at`  ####
//
//  As duas perguntas são legítimas e não cabem num carimbo só:
//  "quando este passo foi atacado pela primeira vez" é histórico
//  (e é o que a auditoria de um wipe de semanas atrás pede), e
//  "quanto a tentativa que terminou levou" é a duração. Reescrever
//  `started_at` a cada retomada apagaria a primeira; deixar como
//  estava mente na segunda.
//
//  `attempt_started_at` é o começo da tentativa ATUAL: ele nasce
//  igual a `started_at` e só se afasta dele quando um passo roda
//  de novo. A duração é sempre `finished_at - attempt_started_at`.
//
//  ####  O BACKFILL É `started_at`  ####
//
//  Numa linha gravada antes desta coluna não há outro carimbo, e
//  não existe outro para inventar: quem nunca foi retomado tem os
//  dois iguais de qualquer jeito, e quem foi já estava com a
//  duração errada — o backfill não a piora.
//
//  Anulável de propósito: um passo `skipped` que nunca chegou a
//  rodar não tem começo de tentativa, exatamente como já não tem
//  `started_at`.
// ------------------------------------------------------------
const WIPE_RUN_STEP_ATTEMPT_SCHEMA = `
ALTER TABLE wipe_run_steps ADD COLUMN attempt_started_at INTEGER;

UPDATE wipe_run_steps SET attempt_started_at = started_at;
`;

// ------------------------------------------------------------
//  032 — a lista do full wipe continua querendo dizer o que dizia
//
//  ####  CONSERTAR UM CASADOR DE PADRÕES MUDA UM CONTRATO  ####
//
//  `wipe_settings` guarda o full wipe como uma lista de PADRÕES, e
//  não de arquivos (ver wipe/plugin-data.ts): o admin marca num
//  dia, e o wipe de cadência relê aquilo meses depois, de
//  madrugada, sozinho.
//
//  O conserto do globstar — `oxide/data/**\/*.json` passando a
//  alcançar a RAIZ de `oxide\data`, e não só as subpastas — é o
//  comportamento certo do `**`. Só que ele valeu PARA TRÁS: a
//  mesma linha, gravada meses antes com o outro sentido, passou a
//  marcar `OrigemZStore.json` e `OrigemZVip.json` — a carteira e o
//  VIP que alguém pagou.
//
//  MEDIDO com o WipeRunner de verdade, mesma árvore de origem e a
//  lista salva `['oxide/data/**\/*.json']`:
//
//      antes    apagar: 9 arquivo(s) + 1 de plugin
//               oxide\data mantém OrigemZStore.json e OrigemZVip.json
//      depois   apagar: 9 arquivo(s) + 3 de plugin
//               os dois somem
//
//  Não houve migração, não houve aviso, e `missing` não ajuda: o
//  padrão sempre casou com alguma coisa. A prévia marca a linha
//  nova com [X] — e ninguém abre a prévia às quatro da manhã.
//
//  ####  O QUE ESTA MIGRAÇÃO FAZ  ####
//
//  Reescreve cada padrão salvo para o padrão que diz, no dialeto
//  de hoje, o que ele queria dizer no dia em que foi gravado:
//
//      oxide/data/**\/*.json   ->   oxide/data/*\/**\/*.json
//
//  O conjunto de arquivos que a lista apaga é o MESMO, par a par —
//  o teste compara os dois dialetos sobre mais de meio milhão de
//  pares padrão × caminho. E quem nunca teve globstar na lista
//  (todo mundo que só clicou na tela, porque a tela grava caminho
//  exato) sai daqui com a lista byte a byte igual.
//
//  ####  POR QUE REESCREVER, E NÃO GUARDAR UM "DIALETO"  ####
//
//  Um campo de versão ao lado da lista deixaria dois casadores
//  vivos para sempre, e o dia em que o admin acrescentasse UMA
//  linha jogaria as outras para o dialeto novo — o mesmo
//  alargamento, só que adiado. O padrão reescrito, em vez disso,
//  diz o que faz na própria tela: `*\/**\/` é "pelo menos uma
//  pasta no meio".
//
//  ####  `updated_at` NÃO MUDA  ####
//
//  A escolha é a mesma escolha, do mesmo dia. Carimbar hoje
//  contaria que o admin mexeu nisso hoje, e ele não mexeu.
// ------------------------------------------------------------

/** Uma linha de `wipe_settings` com a lista do full wipe. */
interface PluginDataPatternsRow {
  readonly server_id: string;
  readonly value: string;
}

function rewriteLegacyPluginDataPatterns(db: AgentDatabase, logger?: Logger): void {
  const rows = db
    .prepare(`SELECT server_id, value FROM wipe_settings WHERE key = 'pluginData.patterns'`)
    .all() as readonly PluginDataPatternsRow[];

  const update = db.prepare(
    `UPDATE wipe_settings SET value = @value
      WHERE server_id = @server_id AND key = 'pluginData.patterns'`,
  );

  for (const row of rows) {
    let saved: unknown;

    try {
      saved = JSON.parse(row.value);
    } catch {
      // Valor que não é JSON já era lido como lista vazia por
      // `parsePatterns`. Reescrever o que ninguém consegue ler
      // seria inventar uma escolha que o admin não fez.
      continue;
    }

    if (!Array.isArray(saved)) {
      continue;
    }

    // O que não é texto passa INTACTO: quem tira lixo da lista é a
    // leitura, e uma migração que aproveita a passagem para limpar
    // outra coisa é uma migração que ninguém consegue revisar.
    const rewritten = saved.map((item: unknown) =>
      typeof item === 'string' ? rewriteLegacyPattern(item) : item,
    );

    if (rewritten.every((item, index) => item === saved[index])) {
      continue;
    }

    update.run({ server_id: row.server_id, value: JSON.stringify(rewritten) });

    logger?.warn(
      { server: row.server_id, before: row.value, after: JSON.stringify(rewritten) },
      'full wipe patterns rewritten to keep their original meaning',
    );
  }
}

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
//  Ela é a única chave que liga esta linha ao ledger do site. Ela é
//  DERIVADA do id da compra; no dia em que a convenção mudar, todo
//  o histórico anterior deixa de ser reconciliável — e a pergunta
//  "eu paguei e não recebi" chega meses depois.
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

  -- O referenceId mandado ao site. NULL nas compras anteriores a
  -- esta migração, e nas de quem usa a carteira LOCAL.
  reference TEXT,

  -- O id da linha no ledger do site. TEXTO, e não INTEGER: lá ele é
  -- BIGINT, e ninguém faz conta com ele deste lado.
  site_transaction_id TEXT,

  -- O que esta compra prometeu entregar, em JSON.
  --
  -- NULL é resposta legítima em dois casos: compra anterior a esta
  -- migração (o INSERT ... SELECT abaixo grava NULL) e compra feita
  -- com a carteira LOCAL. NULL não é "entregue o que der".
  delivery TEXT,

  -- Quantas rodadas de reconciliação esta compra já custou.
  --
  -- Coluna, e não contador em memória: um restart do agente não pode
  -- zerar o teto, ou o laço volta a ser eterno na primeira queda.
  settle_attempts INTEGER NOT NULL DEFAULT 0,

  -- Quem está olhando esta linha AGORA, em epoch ms. NULL = ninguém.
  --
  -- O relógio da reconciliação e o botão chamam a mesma função, e
  -- nada impede que os dois estejam sobre a MESMA compra: o
  -- #running protege contra duas rodadas do relógio, não contra o
  -- relógio e um humano clicando. Duas execuções concorrentes
  -- produziriam duas entregas para uma cobrança.
  --
  -- Coluna, e NÃO um sétimo valor no CHECK: "estou olhando isto
  -- agora" é um cadeado, não um desfecho de compra, e um estado a
  -- mais mudaria o enum público de GET /api/store/purchases.
  settling_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- O id vai EXPLÍCITO na lista: ele é o comprovante.
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

-- "O que travou?" — a tela das compras presas. charge-unknown entra
-- aqui: ela é dinheiro que pode ter saído sem item, e é a pergunta
-- mais urgente que esta tabela responde.
CREATE INDEX idx_store_purchases_stuck ON store_purchases (created_at DESC)
  WHERE state IN ('pending', 'debited', 'failed', 'charge-unknown');

CREATE INDEX idx_store_purchases_server ON store_purchases (server_id, created_at DESC);

-- "Este jogador já tem compra aberta?" — a trava consultada em TODA
-- compra, antes de qualquer cobrança. PARCIAL pelos três estados
-- abertos: as fechadas são a maioria e não interessam a esta
-- pergunta.
CREATE INDEX idx_store_purchases_open ON store_purchases (server_id, steam_id, created_at DESC)
  WHERE state IN ('pending', 'debited', 'charge-unknown');

-- A referência é ÚNICA do lado do site; ela tem de ser única aqui
-- também, ou duas compras locais mandariam a mesma chave e a segunda
-- levaria o item de graça. PARCIAL porque NULL é o normal de quem
-- usa a carteira local — e no SQLite dois NULL são DISTINTOS, então
-- sem o WHERE o índice não impediria nada e ainda cresceria à toa.
CREATE UNIQUE INDEX idx_store_purchases_reference ON store_purchases (reference)
  WHERE reference IS NOT NULL;
`;

// ------------------------------------------------------------
//  036 — a idempotência da entrega puxada do site
//
//  ####  A RESERVA ACONTECE ANTES DO COMANDO  ####
//
//  Um agente que caia entre o origemz.give e o ACK reencontra a
//  tarefa na próxima página do site. Sem esta tabela ele entregaria
//  DE NOVO — item duplicado, uma cobrança. Com ela, a linha órfã em
//  `reserved` diz "o comando pode ter saído", e a tarefa vai para
//  conferência humana em vez de ser reexecutada.
//
//  ####  SEM CHAVE ESTRANGEIRA PARA `servers`  ####
//
//  Mesma razão de `store_purchases`: apagar um servidor não pode
//  apagar o comprovante de uma entrega. A pergunta "o site diz que
//  entregou; entregou mesmo?" chega meses depois, às vezes de um
//  servidor que já não existe.
//
//  ####  `indeterminate` É UM ESTADO, E NÃO UM ERRO  ####
//
//  Reexecutar entrega duas vezes; ACKar `failed` devolve ao site um
//  item que talvez esteja no chão do jogador. Na dúvida, PRESERVA —
//  e preservar é ACKar `deferred` com reason AGENT_INDETERMINATE,
//  para o site tirar a tarefa de `pending`, pô-la em `review` e a
//  expiração de 30 dias não a alcançar.
//
//  ####  O NOME É `indeterminate` PORQUE `review` É DO SITE  ####
//
//  Lá, `review` é o estado para onde o site move a tarefa ao ler
//  esse reason. Duas máquinas de estado, dois bancos, e duas telas
//  mostrando as duas contagens: o mesmo nome faria alguém concluir
//  que uma está errada. A palavra do FIO não é nem `review` nem
//  `indeterminate`: é `deferred` + AGENT_INDETERMINATE.
// ------------------------------------------------------------
const SITE_DELIVERIES_SCHEMA = `
CREATE TABLE site_deliveries (
  -- O deliveryId que o site mandou. É ele que torna a entrega
  -- idempotente, e é por isso que ele é a chave primária.
  id TEXT PRIMARY KEY,

  -- O servidor LOCAL que recebe. Com N pareamentos cada fila já sabe
  -- onde entregar: ela veio do bearer daquele servidor.
  server_id TEXT NOT NULL,
  steam_id  TEXT NOT NULL,

  kind TEXT NOT NULL CHECK (kind IN ('item', 'kit', 'vip', 'vehicle')),

  -- O payload como veio do site, em JSON, DEPOIS de validado. Ele
  -- fica guardado para que uma conferência humana consiga dizer o
  -- que era para ter saído, sem depender de o site ainda ter a fila.
  payload TEXT NOT NULL,

  -- O itemRef do site, para o suporte cruzar os dois lados.
  source_ref TEXT,

  --   'reserved'       o comando vai sair, ou saiu e não sabemos
  --   'delivered'      o plugin respondeu ok
  --   'failed'         falha DEFINITIVA, com o código cru
  --   'indeterminate'  o agente caiu no meio; ACKa 'deferred'
  --                    com reason 'AGENT_INDETERMINATE'
  --   'expired'        o site devolveu o id em unknown no ACK,
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

// ------------------------------------------------------------
//  037 — o dedup do COMANDO vindo do site
//
//  ####  ELA É O QUE FAZ O at-most-once SOBREVIVER A UM RESTART  ####
//
//  Sem esta tabela o desenho inteiro tem um buraco: o agente puxa
//  `CMD-…`, executa o `server-restart`, e o processo do agente cai
//  JUNTO — antes do ACK. Ele volta, o site não recebeu ACK nenhum, e
//  o que acontece depois depende de uma decisão do site que o agente
//  não controla. Com o id em disco, o agente sabe que já executou
//  aquilo e ACKa, em vez de repetir.
//
//  Memória não serve: `pm2 restart` apaga. Ver Docs\22 §3 regra 7.
//
//  ####  O `lease_token` MORA AQUI PORQUE O ACK O EXIGE  ####
//
//  ACK sem `leaseToken` — ou com um de uma reivindicação anterior —
//  é descartado como `unknown` pelo site, e a linha lá NÃO muda de
//  estado. Guardar só o id deixaria o desfecho de um comando que o
//  agente executou antes de cair sem como ser fechado.
//
//  ####  SEM CHAVE ESTRANGEIRA PARA `servers`  ####
//
//  Mesma razão de `site_deliveries`: apagar um servidor não pode
//  apagar o registro de quem mandou reiniciá-lo.
// ------------------------------------------------------------
const SITE_COMMANDS_SCHEMA = `
CREATE TABLE site_commands (
  -- O CMD-… que o site gerou. É ele que torna o comando
  -- at-most-once, e é por isso que ele é a chave primária.
  id TEXT PRIMARY KEY,

  -- O servidor LOCAL que executa. O comando veio pelo bearer dele.
  server_id TEXT NOT NULL,

  -- Um dos TRÊS da allowlist: server-start, server-stop,
  -- server-restart. Sem CHECK aqui de propósito: a lista fechada
  -- mora em site/commands.ts, e um kind que chegue por engano é
  -- recusado ANTES de virar linha.
  kind TEXT NOT NULL,

  -- Os params como vieram, em JSON. Ficam guardados para uma
  -- conferência humana conseguir dizer o que era para ter sido
  -- feito, sem depender de o site ainda ter a linha.
  params TEXT NOT NULL,

  -- A prova de que quem ACKa é quem puxou. Ver o cabeçalho.
  lease_token TEXT NOT NULL,

  --   'claimed'        a operação vai começar, ou começou e não
  --                    sabemos como acabou
  --   'executed'       a operação terminou bem
  --   'failed'         a operação terminou mal
  --   'refused'        nem começou: pré-condição, prazo ou trava
  --   'indeterminate'  o agente caiu no meio. NUNCA re-executa
  --
  -- Os quatro terminais são os MESMOS nomes dos status do ACK, e é
  -- de propósito: um ACK que se perca é reenviado a partir DESTA
  -- coluna, e um estado local que não fosse um status do contrato
  -- viraria um segundo desfecho, diferente do primeiro.
  state TEXT NOT NULL
    CHECK (state IN ('claimed', 'executed', 'failed', 'refused', 'indeterminate')),

  -- O reason do VOCABULÁRIO FECHADO do contrato, nunca o código
  -- interno do agente e nunca a frase. Ver o Docs 22, na seção 7.
  reason TEXT,

  -- O id da operação local. É o que liga a linha do site ao log
  -- daqui, em GET /api/operations/<id>.
  operation_id TEXT,

  claimed_at INTEGER NOT NULL,
  -- NULL = o site ainda não confirmou o DESFECHO desta linha.
  acked_at   INTEGER,
  updated_at INTEGER NOT NULL
);

-- "Que desfecho o site ainda não confirmou?" — a pergunta do laço.
-- PARCIAL: as confirmadas são a maioria e não interessam.
CREATE INDEX idx_site_commands_open ON site_commands (updated_at ASC)
  WHERE acked_at IS NULL;
`;

// ------------------------------------------------------------
//  038 — a fila também REVOGA VIP
//
//  ####  O CHECK DA 036 NÃO CONHECIA `vip_revoke`  ####
//
//  O site passou a mandar tarefas que TIRAM o VIP — estorno,
//  chargeback, ban, e o vencimento que o relógio de lá varre a cada
//  minuto. Sem esta migração a reserva dessas tarefas falharia no
//  CHECK, e a fila responderia com um `false` que significa "alguém
//  já reservou": a revogação sumiria em silêncio, e o VIP estornado
//  continuaria valendo no jogo.
//
//  ####  POR QUE A TABELA É RECRIADA  ####
//
//  Um CHECK de coluna não se altera no SQLite. O caminho é o
//  oficial: renomear, criar a nova, copiar, dropar a velha. As
//  linhas ANTIGAS passam inteiras — elas são o comprovante de
//  entregas já ACKadas, e "o site diz que entregou; entregou
//  mesmo?" é uma pergunta que chega meses depois.
//
//  Os dois índices morrem com a tabela velha (eles a acompanham no
//  RENAME) e nascem de novo aqui, com os mesmos nomes.
// ------------------------------------------------------------
const SITE_DELIVERIES_VIP_REVOKE_SCHEMA = `
ALTER TABLE site_deliveries RENAME TO site_deliveries_old;

CREATE TABLE site_deliveries (
  id TEXT PRIMARY KEY,

  server_id TEXT NOT NULL,
  steam_id  TEXT NOT NULL,

  -- 'vip_revoke' é o único que não entrega nada: ele TIRA.
  kind TEXT NOT NULL
    CHECK (kind IN ('item', 'kit', 'vip', 'vehicle', 'vip_revoke')),

  payload TEXT NOT NULL,
  source_ref TEXT,

  state TEXT NOT NULL
    CHECK (state IN ('reserved', 'delivered', 'failed', 'indeterminate', 'expired')),

  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,

  reserved_at INTEGER NOT NULL,
  acked_at    INTEGER,
  updated_at  INTEGER NOT NULL
);

INSERT INTO site_deliveries
  (id, server_id, steam_id, kind, payload, source_ref, state, reason,
   attempts, reserved_at, acked_at, updated_at)
SELECT
   id, server_id, steam_id, kind, payload, source_ref, state, reason,
   attempts, reserved_at, acked_at, updated_at
  FROM site_deliveries_old;

DROP TABLE site_deliveries_old;

CREATE INDEX idx_site_deliveries_open ON site_deliveries (updated_at DESC)
  WHERE acked_at IS NULL;

CREATE INDEX idx_site_deliveries_player ON site_deliveries (steam_id, reserved_at DESC);
`;

// ------------------------------------------------------------
//  039 — o status de nascimento vira FAIXA
//
//  ####  UM NÚMERO SÓ FAZ TODO MUNDO NASCER IGUAL  ####
//
//  Com `health = 130`, os trinta jogadores de bronze acordam com os
//  mesmos 130 — e o benefício, que era para ser uma vantagem, vira
//  um número que aparece igual na tela de todo mundo. Uma faixa
//  ("entre 25% e 35% a mais") dá a mesma vantagem sem o carimbo.
//
//  ####  POR QUE O TETO É COLUNA NOVA, E NÃO OUTRA TABELA  ####
//
//  Porque a faixa não é uma entidade: é o MESMO atributo com dois
//  extremos. `health` continua sendo o que ele sempre foi — o
//  valor, e agora o PISO da faixa —, e `health_max` nulo continua
//  querendo dizer "valor exato". Um banco que já rodou a 022 sobe
//  para cá sem tocar em linha nenhuma, e o que estava configurado
//  segue valendo com o mesmo significado.
//
//  ####  QUEM SORTEIA É O PLUGIN, E TINHA DE SER  ####
//
//  O sorteio precisa acontecer A CADA NASCIMENTO. Se o agente
//  sorteasse ao empurrar o payload, o número ficaria congelado até
//  o push seguinte e todo mundo nasceria igual de novo — só que com
//  um valor diferente por dia. O agente manda os dois extremos; o
//  `OrigemZPlayer` tira o número no respawn.
// ------------------------------------------------------------
const SPAWN_STATUS_RANGE_SCHEMA = `
ALTER TABLE spawn_status ADD COLUMN health_max    REAL;
ALTER TABLE spawn_status ADD COLUMN calories_max  REAL;
ALTER TABLE spawn_status ADD COLUMN hydration_max REAL;
`;

// ------------------------------------------------------------
//  040 — a ficha aceita "recebeu um item do admin"
//
//  ####  O CHECK DA 017 ESQUECEU DE CRESCER  ####
//
//  `kind` é uma lista fechada no banco, e a lista da 017 termina em
//  `compra`. Gravar `item` ali levanta CHECK constraint failed — o
//  INSERT da ficha morre, e com ele a rota que acabou de entregar
//  um item que JÁ ESTÁ no inventário do jogador. Ou seja: sem esta
//  migração, a entrega acontece e a resposta é 500.
//
//  ####  POR QUE UM TIPO PRÓPRIO, E NÃO 'kit'  ####
//
//  Kit é uma coisa que o JOGADOR resgatou, dentro de uma regra que
//  o admin escreveu antes. Item dado pelo painel é uma coisa que um
//  ADMIN fez, agora, sem regra nenhuma — e é a segunda que alguém
//  vai auditar. Empilhar as duas no mesmo `kind` esconderia
//  exatamente a linha que se procura.
//
//  A recriação da tabela é o preço de um CHECK no SQLite: não
//  existe ALTER que o troque. O `INSERT ... SELECT` leva tudo, e o
//  `id` vai junto para a linha do tempo não se reordenar.
// ------------------------------------------------------------
const PLAYER_EVENTS_ITEM_SCHEMA = `
ALTER TABLE player_events RENAME TO player_events_039;

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
  --   'item'      recebeu um item das mãos de um admin
  kind TEXT NOT NULL
    CHECK (kind IN ('join', 'leave', 'kick', 'teleport', 'vip', 'kit', 'compra', 'item')),

  at INTEGER NOT NULL,
  actor TEXT,
  detail TEXT
);

INSERT INTO player_events (id, steam_id, server_id, kind, at, actor, detail)
SELECT id, steam_id, server_id, kind, at, actor, detail FROM player_events_039;

DROP TABLE player_events_039;

CREATE INDEX idx_player_events_player ON player_events (steam_id, at DESC);
`;

// ------------------------------------------------------------
//  041 — os itens que NÓS criamos
//
//  ####  ITEM DO JOGO É LEITURA; ITEM NOSSO É ESCRITA  ####
//
//  É a razão de esta tabela existir separada da `items` da 007.
//  Aquela é um ESPELHO: ela é reescrita a cada varredura do
//  catálogo, e um item nosso dentro dela sumiria no primeiro update
//  do Rust que ninguém acompanhasse. Esta aqui nada apaga sozinho.
//
//  ####  O ITEM CUSTOM NÃO É UM ITEM NOVO  ####
//
//  MEDIDO no binário do jogo: um `itemid` que o cliente não conhece
//  é DESCARTADO — "Load invalid item id {0} from item {1} (no
//  ItemDefinition found)". Não existe criar item sem modificar o
//  cliente de cada jogador.
//
//  O que existe é MARCAR um item do jogo. A marca é o par
//  `(base_shortname, skin_id)`, e ela é a única coisa que o próprio
//  Rust carrega por nós: sobrevive a drop, a wipe, a restart e a
//  `oxide.reload`, porque quem a guarda é o item.
//
//  ####  A MARCA NUNCA É ZERO  ####
//
//  Dois motivos independentes, e o segundo derruba jogador:
//
//   1. skin 0 é indistinguível de item comum. Um troféu com skin 0
//      faria o servidor premiar o troféu do Twitch que o jogador já
//      tinha no baú;
//   2. skin 0 num item SEM skins estoura o cliente pelo caminho do
//      CUI — ver ui-cui.ts:309-330 e Docs\TrofeuBleik §2.6.
//
//  Daí o CHECK: ele pega o caminho que esquecer de validar.
//
//  ####  MEDIDO EM 05/09/2026, NO SERVIDOR RODANDO  ####
//
//  A dúvida que decidia este desenho era se o `skin_id` sobrevive
//  num item cuja definição NÃO aceita skins (104 dos 1266 aceitam,
//  e nenhum troféu está entre eles). O `origemz.item.diag` do
//  Plugins\OrigemZItems.cs respondeu no server01:
//
//      trophy (definitionHasSkins: false) + skin 3000000001
//        -> skinSurvived: true
//
//  Sobrevive. Ver Docs\CustomItem\01-PESQUISA-ITEM-CUSTOM.md §13 Q3.
// ------------------------------------------------------------
const CUSTOM_ITEMS_SCHEMA = `
CREATE TABLE custom_items (
  -- Nosso, e estável. É o que a loja, o kit e o site guardam.
  id            TEXT PRIMARY KEY,

  -- O que o jogador lê. Sobrescreve o nome do item base pelo campo
  -- \`name\` do protocolo, que é da INSTÂNCIA — e por isso não
  -- afeta nenhum outro item igual no servidor.
  display_name  TEXT NOT NULL,

  -- Ver o cabeçalho: a marca.
  --
  -- \`skin_id\` é TEXT e não INTEGER: é um UInt64 na rede, e ele
  -- não cabe no inteiro com sinal do SQLite. Mesma escolha que
  -- store_offer_items.skin_id já fez.
  base_shortname TEXT NOT NULL REFERENCES items(shortname),
  skin_id        TEXT NOT NULL CHECK (skin_id <> '0' AND skin_id <> ''),

  -- Nossa, e livre. As 14 categorias do jogo não têm "Troféu", e
  -- empurrar este item para dentro de \`Misc\` esconderia dele a
  -- única coisa que o descreve.
  category      TEXT NOT NULL,

  -- Vai para o painel do item no jogo, no bloco de procedência —
  -- porque NÃO EXISTE campo de descrição no protocolo. A descrição
  -- do item base continua aparecendo acima; a nossa entra abaixo.
  -- Ver OrigemZItems.cs, ApplyDescription.
  description   TEXT,

  -- O nome do arquivo em Assets\\items\\, ou NULL para "usa o ícone
  -- do item base" — que é um padrão BOM: o jogador já reconhece o
  -- ícone do item do jogo.
  --
  -- Não é o PNG: é o NOME. Os bytes vão pelo canal que já existe
  -- (\`origemz.item.icon\`), e o plugin os guarda no FileStorage do
  -- servidor, que devolve um CRC. O CRC NÃO é gravado aqui de
  -- propósito: ele nasce do outro lado, muda quando o PNG muda, e
  -- guardá-lo seria uma segunda verdade sobre a mesma imagem.
  icon_file     TEXT,

  -- NULL = herda o do item base.
  --
  -- ####  ELE SÓ SABE DIMINUIR  ####
  --
  -- O teto vive no \`stackable\` da ItemDefinition, que é do JOGO.
  -- Baixar é fácil: o jogo tenta empilhar e o plugin recusa. SUBIR
  -- é impossível — a recusa vem antes, dentro do próprio jogo.
  -- Um \`trophy\` empilha 1: pedir 5 aqui não faz nada.
  max_stack     INTEGER CHECK (max_stack IS NULL OR max_stack > 0),

  -- O corpo emprestado traz os hábitos junto: o \`trophy\` é
  -- deployable no jogo, e um troféu nosso nasce colocável no chão
  -- sem ninguém ter pedido. 0 = o plugin recusa a colocação.
  deployable    INTEGER NOT NULL DEFAULT 1 CHECK (deployable IN (0, 1)),

  -- ####  A AÇÃO  ####
  --
  -- JSON, e não colunas. Mesma razão da \`ui_documents\` (008): a
  -- forma da ação MUDA com o tipo dela, e uma coluna por efeito
  -- possível daria uma tabela larga cheia de NULL que ninguém
  -- consulta.
  --
  --   {"kind":"none"}
  --   {"kind":"consume","trigger":"use","consumes":1,
  --    "effects":[{"type":"Health","amount":40}]}
  --
  -- Os oito tipos de efeito são do JOGO, medidos no enum
  -- MetabolismAttribute.Type: Calories, Hydration, Heartrate,
  -- Poison, Radiation, Bleeding, Health e HealthOverTime.
  --
  -- Quem valida é o zod na borda HTTP, e não o banco: a regra é
  -- longa demais para um CHECK, e um CHECK que entende metade dela
  -- é pior que nenhum.
  action        TEXT NOT NULL DEFAULT '{"kind":"none"}',

  -- Frase no chat ao usar. Opcional.
  message       TEXT,

  -- Desligado NÃO é apagado. Um item desligado não é entregue, mas
  -- continua sendo RECONHECIDO pelo plugin — senão o troféu que o
  -- jogador já tem viraria lixo por causa de um clique no painel.
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Duas definições com a mesma marca deixariam o plugin sem critério
-- para escolher qual dos dois itens ele está vendo.
CREATE UNIQUE INDEX idx_custom_items_mark
  ON custom_items (base_shortname, skin_id);

CREATE INDEX idx_custom_items_category ON custom_items (category);

-- Em quais servidores este item existe. Cópia do \`kit_servers\`
-- (012), inclusive o índice: a chave primária começa por
-- \`item_id\`, e a pergunta da tela do servidor é a OUTRA — "quais
-- itens este servidor tem?" —, que sem o índice varreria a tabela.
--
-- Sem linha nenhuma = em nenhum servidor. Um item recém-cadastrado
-- que já valesse em tudo entraria em produção sem ninguém mandar.
CREATE TABLE custom_item_servers (
  item_id   TEXT NOT NULL REFERENCES custom_items(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, server_id)
);

CREATE INDEX idx_custom_item_servers_server
  ON custom_item_servers (server_id);
`;

// ------------------------------------------------------------
//  042 — o item que se gasta ao ser recebido
//
//  ####  ELE É UM RECIBO, E NÃO UMA COISA  ####
//
//  O Troféu Bleik nasce, é visto por alguns segundos e morre,
//  deixando atrás de si um número que só cresce. É o desenho do
//  briefing: "o item físico serve apenas para representar a
//  conquista antes de ser convertido automaticamente em pontuação".
//
//  ####  POR QUE UMA COLUNA, E NÃO UM CAMPO DA AÇÃO  ####
//
//  Porque "quando" e "o quê" são perguntas independentes. A ação
//  diz o QUE acontece (somar ponto, curar); esta coluna diz QUANDO
//  — e um item de cura que age ao ser recebido é tão legítimo
//  quanto um de pontos que espera o jogador clicar.
//
//  Enfiar isto dentro do JSON da ação obrigaria a repetir o mesmo
//  campo em cada tipo novo de ação, e a esquecê-lo em um deles.
//
//  ####  ELA RESOLVE AS TRÊS PROIBIÇÕES DE GRAÇA  ####
//
//  O briefing proíbe guardar, dropar e transferir o troféu. Com a
//  conversão na entrada, as três se resolvem sozinhas: não há o que
//  dropar, porque o item já não existe. Ver
//  Docs\TrofeuBleik\TROFEU_BLEIK_STORE.md §3.4.
//
//  ####  E ELA TEM UMA JANELA QUE PODE PERDER PONTO  ####
//
//  Entre destruir o item e o agente somar, o ponto não existe em
//  lugar nenhum. Se o RCON estiver fora nesse instante, o jogador
//  perdeu a conquista e não há como saber. Por isso o plugin
//  REGISTRA antes de destruir, e reenvia no boot — §3.5 do mesmo
//  documento. A coluna aqui é só a intenção; a fila é lá.
// ------------------------------------------------------------
const CUSTOM_ITEMS_PICKUP_SCHEMA = `
ALTER TABLE custom_items
  ADD COLUMN consume_on_pickup INTEGER NOT NULL DEFAULT 0
  CHECK (consume_on_pickup IN (0, 1));
`;

// ------------------------------------------------------------
//  033 — o núcleo do ranking
//
//  ####  RANKING É LINHA, E NÃO CÓDIGO  ####
//
//  A estatística é guardada como (metric TEXT, value INTEGER), e
//  não como uma coluna por métrica, porque a lista de métricas
//  CRESCE — e agora cresce em runtime: o admin cria um ranking
//  novo pelo painel e ele precisa funcionar sem migração. Coluna
//  por métrica tornaria isso impossível, não só caro.
//
//  O plano inteiro, com o porquê de cada coluna, está em
//  Docs/Ranking/20-PLANO-E-CONTRATOS.md §2. A pesquisa que decidiu
//  O QUE medir está em Docs/Ranking/19-PESQUISA-RANKING.md.
//
//  ####  AS DUAS UNIDADES DE TEMPO QUE CONVIVEM AQUI  ####
//
//  A convenção da casa é epoch em MILISSEGUNDOS, e ela vale para
//  tudo o que o AGENTE carimba (started_at, ended_at, applied_at,
//  updated_at, frozen_at).
//
//  A exceção é o instante que vem do SERVIDOR DE JOGO —
//  `stat_events.at` e `player_records.at` —, que chega em SEGUNDOS
//  no contrato do plugin (§6.1 e §7.2) e é gravado como chegou.
//  Convertê-lo na entrada faria o agente reescrever um fato alheio
//  para caber num hábito nosso, e a auditoria do §2.4 compara essa
//  coluna com o que o log do servidor de jogo mostra.
//
//  Consequência prática: a "janela de perda" (§8.3) é
//  `applied_at / 1000 - at`, e não uma subtração direta.
// ------------------------------------------------------------
const RANKINGS_CORE_SCHEMA = `
-- ----------------------------------------------------------
--  stat_periods — a JANELA de um ranking.
--
--  Um período é (servidor, tipo, começo). O tipo 'wipe' aponta
--  para a linha de 'wipes' que o criou: é assim que o ranking
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
--  mesmo tipo. O 'kind' diz o PAPEL da janela; o
--  ranking_settings.season_mode (034) diz o TAMANHO dela.
--
--  Fazer 'biweekly' e 'monthly' virarem 'kind' daria dois
--  períodos abertos ao mesmo tempo no mesmo servidor, cada um
--  com um pódio diferente, e a tela teria de explicar qual é
--  "o" ranking. Com um 'season' configurável, a resposta é
--  sempre uma.
-- ----------------------------------------------------------
CREATE TABLE stat_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('wipe','season','lifetime')),

  -- A linha de 'wipes' que abriu este período. NULL em 'lifetime'
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

-- ----------------------------------------------------------
--  player_stats — o contador.
--
--  ####  POR QUE (metric TEXT, value INTEGER) E NÃO UMA COLUNA
--        POR MÉTRICA  ####
--
--  Porque a lista de métricas CRESCE, e agora cresce em runtime:
--  o admin cria um ranking novo pelo painel (034) e ele precisa
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
  -- core/src/http/routes/custom-items.ts.
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

  -- Epoch em SEGUNDOS, relógio do servidor de jogo. Ver o
  -- cabeçalho desta migração.
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

-- ----------------------------------------------------------
--  stat_batches — a idempotência do LOTE.
--
--  Sem ela, um 'ack' perdido faria o mesmo lote entrar duas
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
--  Ela é a auditoria do documento do troféu: emitidos ×
--  convertidos, por dia, por fonte. Sem esta tabela, "o jogador
--  diz que ganhou 3 troféus e só contou 1" não tem resposta —
--  só a palavra de um contra a do outro.
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

  -- Relógio do AGENTE, epoch em MILISSEGUNDOS. Os dois existem
  -- porque a diferença entre eles é o tamanho da janela de perda;
  -- as unidades são diferentes de propósito, e o cabeçalho desta
  -- migração explica por quê.
  applied_at INTEGER NOT NULL,

  -- Por qual dos dois caminhos ele chegou PRIMEIRO.
  via TEXT NOT NULL CHECK (via IN ('push','flush'))
);

CREATE INDEX idx_stat_events_audit ON stat_events (server_id, metric, at DESC);
CREATE INDEX idx_stat_events_player ON stat_events (steam_id, at DESC);

-- ----------------------------------------------------------
--  stat_adjustments — quem mexeu no número, e por quê.
--
--  Zerar a estatística de um suspeito é AÇÃO ADMINISTRATIVA, e
--  ação administrativa sem autor é o que não se consegue
--  explicar depois. Mesma razão da store_audit (migração 021).
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
`;

// ------------------------------------------------------------
//  034 — o catálogo de rankings, e o pódio congelado
//
//  ####  A LINHA SEMEADA É O PRODUTO DESTA MIGRAÇÃO  ####
//
//  Ela não cria só tabela: ela SEMEIA os onze rankings fixos. É o
//  que faz "abates" existir num banco novo sem ninguém cadastrar
//  nada — e é o que prova que o dinâmico não é um segundo sistema,
//  porque o Troféu Bleik vai ser uma linha igual a estas, criada
//  pelo painel.
//
//  ####  E ELA CARREGA A ESCOLHA DO DONO SOBRE O QUE ZERA  ####
//
//  Três colunas nascem aqui só por causa dela:
//
//    rankings.window                  em que janela aquele ranking
//                                     disputa — e, portanto, qual
//                                     virada o zera aos olhos de
//                                     quem joga;
//    ranking_settings.season_on_wipe  a temporada também vira
//                                     quando o mundo vira?
//    wipe_runs.open_ranking_season    a exceção DAQUELA execução,
//                                     com três estados.
//
//  Nenhuma delas muda a ESCRITA: todo evento continua somando nos
//  três períodos abertos. Elas mudam o que a tela abre e o que a
//  virada fecha. Ver Docs/Ranking/20-PLANO-E-CONTRATOS.md §3 a §5.
//
//  ####  O ALTER EM wipe_runs É SEGURO AQUI, E A ORDEM É O
//        PORQUÊ  ####
//
//  `wipe_runs` nasce na 025 e nenhuma migração posterior a
//  RECRIA — as três que a alteram (029, 030, 031) são todas
//  anteriores a esta. Como o runner aplica por ordem de id, a
//  coluna existe tanto no banco velho quanto no novo.
// ------------------------------------------------------------
const RANKINGS_CATALOG_SCHEMA = `
-- ----------------------------------------------------------
--  rankings — a DEFINIÇÃO de um ranking.
--
--  ####  FIXO E DINÂMICO SÃO A MESMA LINHA  ####
--
--  Um ranking "fixo" (abates, tempo online) e um "dinâmico"
--  (Troféu Bleik) diferem em UMA coluna: 'builtin'. Ela só
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
  --   'item'     — a ação 'points' de um item custom
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
--  lugar só, no código — DEFAULT_RANKING_SETTINGS, em
--  db/rankings-repository.ts.
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
  -- Isto NÃO é o mesmo que season_mode = 'wipe'. O modo diz
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
--  E é por isso que 'display_name' é COPIADO aqui: o jogador
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

-- ----------------------------------------------------------
--  wipe_runs ganha a decisão sobre a temporada.
--
--  NULL  = herda ranking_settings.season_on_wipe
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
--  É a mesma distinção que wipes.wipe_run_id já faz na migração
--  025: NULL ali significa "wipe feito à mão", e não "wipe da
--  execução número zero".
-- ----------------------------------------------------------
ALTER TABLE wipe_runs
  ADD COLUMN open_ranking_season INTEGER
  CHECK (open_ranking_season IS NULL OR open_ranking_season IN (0, 1));

-- ----------------------------------------------------------
--  Os onze rankings fixos (§4).
--
--  ####  POR QUE strftime, E NÃO UM NÚMERO FIXO  ####
--
--  A migração é DDL estática — ela não tem como receber o
--  Date.now() do processo. Um instante fixo escrito aqui diria
--  que todo servidor criou o catálogo no mesmo dia de 2026, e a
--  coluna 'created_at' deixaria de responder a única pergunta
--  que ela existe para responder.
--
--  O '* 1000' é a convenção da casa: epoch em milissegundos.
--
--  ####  A 'window' SEMEADA É UM PADRÃO, NÃO UMA SENTENÇA  ####
--
--  O admin muda cada uma pelo painel. O critério do padrão:
--  farm zera com o mundo (o minério daquele mapa não significa
--  nada no seguinte); PvP atravessa o wipe (a perícia não zerou
--  porque o mapa zerou, e é aí que mora a premiação); tempo
--  online é de sempre; e o tiro mais longo é do mapa, porque o
--  recorde é uma história com lugar — "412 m no G12 daquele
--  mapa" — e carregá-lo adiante tira dele o que o torna
--  interessante.
--
--  ####  O TROFÉU BLEIK NÃO ESTÁ AQUI, E ISSO É O TESTE  ####
--
--  Ele é o primeiro ranking dinâmico, e o dono o cria pelo
--  painel. Semeá-lo aqui esconderia justamente a demonstração de
--  que o sistema funciona sem código novo.
-- ----------------------------------------------------------
INSERT INTO rankings
  (id, metric, label, unit, description, source, value_kind, direction, window,
   global_eligible, builtin, enabled, sort_order, created_at, updated_at)
VALUES
  ('abates', 'pvp.kills', 'Abates', 'abates',
   'Cada jogador que voce abate conta um ponto.',
   'plugin', 'counter', 'desc', 'season', 1, 1, 1, 10,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('mortes', 'pvp.deaths', 'Mortes', 'mortes',
   'Quantas vezes voce morreu para outro jogador.',
   'plugin', 'counter', 'desc', 'season', 1, 1, 1, 20,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('kd', 'pvp.kd', 'K/D', NULL,
   'Abates divididos por mortes, com correcao para quem jogou pouco.',
   'computed', 'ratio', 'desc', 'season', 1, 1, 1, 30,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('tempo-online', 'time.played', 'Tempo online', 'segundos',
   'Tempo que voce passou dentro do servidor.',
   'agent', 'counter', 'desc', 'lifetime', 1, 1, 1, 40,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('tiro-longo', 'shot.distance', 'Tiro mais longo', 'metros',
   'O abate mais distante que voce conseguiu neste mapa.',
   'plugin', 'record', 'desc', 'wipe', 1, 1, 1, 50,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio', 'ore.total', 'Minério', 'unidades',
   'Tudo o que voce minerou neste mapa, somado.',
   'plugin', 'counter', 'desc', 'wipe', 0, 1, 1, 60,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-enxofre', 'ore.sulfur', 'Enxofre', 'unidades',
   'Enxofre minerado neste mapa.',
   'plugin', 'counter', 'desc', 'wipe', 0, 1, 1, 61,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-metal', 'ore.metal', 'Metal', 'unidades',
   'Minério de metal minerado neste mapa.',
   'plugin', 'counter', 'desc', 'wipe', 0, 1, 1, 62,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-pedra', 'ore.stone', 'Pedra', 'unidades',
   'Pedra minerada neste mapa.',
   'plugin', 'counter', 'desc', 'wipe', 0, 1, 1, 63,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('minerio-hqm', 'ore.hqm', 'Metal puro', 'unidades',
   'Minério de metal puro minerado neste mapa.',
   'plugin', 'counter', 'desc', 'wipe', 0, 1, 1, 64,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('explosivo', 'explosive.seq', 'Poder de raid', 'enxofre eq.',
   'O que voce detonou neste mapa, convertido em enxofre equivalente.',
   'plugin', 'counter', 'desc', 'wipe', 0, 1, 1, 70,
   CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000);
`;

// ------------------------------------------------------------
//  043 — as três colunas que a 034 ganhou DEPOIS de já ter rodado
//
//  ####  O ERRO QUE ESTA MIGRAÇÃO CONSERTA  ####
//
//  A 034 nasceu sem `rankings.window`, sem
//  `ranking_settings.season_on_wipe` e sem
//  `wipe_runs.open_ranking_season`. As três entraram no pedido do
//  dono de 05/09/2026 — cada ranking escolhe se a virada da
//  temporada o zera, e o wipe pode abrir temporada nova — e foram
//  acrescentadas ao SQL da 034 quando ela JÁ ESTAVA APLICADA.
//
//  O runner aplica cada id UMA vez. Em banco novo o SQL editado
//  roda inteiro e tudo funciona; no banco de quem já migrou, a
//  034 é pulada e as colunas nunca aparecem. O sintoma é o agente
//  não subir: `rankings-repository.ts` consulta `window` num
//  esquema que não a tem.
//
//  É exatamente o que o comentário da 042 já avisava, três linhas
//  abaixo desta. A lição não é nova; o que faltou foi aplicá-la.
//
//  ####  POR QUE `run` E NÃO `sql`  ####
//
//  Porque ela roda nos dois mundos. Em banco novo as colunas já
//  vieram da 034 e um ALTER cru estouraria com "duplicate column
//  name"; aqui cada uma é conferida antes. É o mesmo desenho de
//  `addWipeAtIfMissing` (030), pela mesma razão.
// ------------------------------------------------------------
function addRankingScopeColumnsIfMissing(db: AgentDatabase): void {
  const hasColumn = (table: string, column: string): boolean =>
    db
      .prepare(`SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column) !== undefined;

  if (!hasColumn('rankings', 'window')) {
    db.exec(`
      ALTER TABLE rankings ADD COLUMN "window" TEXT NOT NULL DEFAULT 'season'
        CHECK ("window" IN ('wipe','season','lifetime'));
    `);

    // O default 'season' já é o certo para os três de PvP e para
    // todo ranking dinâmico. Os outros oito precisam do critério
    // do §4 do Docs/Ranking/20: farm zera com o mundo, e tempo
    // online não zera nunca.
    //
    // Só corrige quem nasceu agora com o default — este UPDATE
    // roda uma vez, dentro do `if`, e por isso não passa por cima
    // de uma escolha que o admin já tenha feito na tela.
    db.exec(`
      UPDATE rankings SET "window" = 'lifetime' WHERE metric = 'time.played';

      UPDATE rankings SET "window" = 'wipe'
       WHERE metric IN ('shot.distance', 'ore.total', 'ore.sulfur',
                        'ore.metal', 'ore.stone', 'ore.hqm', 'explosive.seq');
    `);
  }

  if (!hasColumn('ranking_settings', 'season_on_wipe')) {
    db.exec(`
      ALTER TABLE ranking_settings ADD COLUMN season_on_wipe INTEGER NOT NULL DEFAULT 0
        CHECK (season_on_wipe IN (0, 1));
    `);
  }

  if (!hasColumn('wipe_runs', 'open_ranking_season')) {
    // Sem NOT NULL e sem default: NULL aqui significa "não decidi,
    // herde a configuração do servidor", e é diferente de "decidi
    // que não". Ver o §3.4 do Docs/Ranking/20.
    db.exec(`
      ALTER TABLE wipe_runs ADD COLUMN open_ranking_season INTEGER
        CHECK (open_ranking_season IS NULL OR open_ranking_season IN (0, 1));
    `);
  }
}

// ------------------------------------------------------------
//  044 — o nome curto do menu, e quem aparece nele
//
//  ####  POR QUE UMA MIGRAÇÃO NOVA, E NÃO UM ALTER NA 034  ####
//
//  Pela lição que a 043 acabou de pagar, três dezenas de linhas
//  acima: o runner aplica cada id UMA vez. Editar o `CREATE TABLE`
//  da 034 daria banco novo certo e banco de produção sem coluna —
//  o defeito que só aparece na primeira consulta que a pedir. As
//  colunas nascem aqui, num id que ninguém aplicou ainda, e por
//  isso este é `sql` puro: não há banco em que elas já existam.
//
//  ####  `short_label` NÃO É O `label` ABREVIADO  ####
//
//  A coluna de abas da tela do jogo é estreita: "Poder de raid"
//  não cabe onde "Raid" cabe. Guardar a abreviação no `label`
//  faria o painel e o site herdarem um nome que só existe por
//  causa da largura de uma tela — e ninguém entenderia por que o
//  ranking mudou de nome no site. `NULL` (ou vazio) quer dizer
//  "não precisa de nome curto": vale o `label`.
//
//  ####  `show_in_game` NÃO É O `enabled`  ####
//
//  Desligar o ranking (`enabled = 0`) o tira de TODO lugar: do
//  site, do painel, da tela do jogo. Isto o tira só do menu do
//  jogo, onde o espaço é caro e cinco minérios seguidos empurram
//  os rankings que importam para fora da vista. O número continua
//  sendo contado e continua aparecendo no site — que é justamente
//  a diferença entre "não quero mostrar aqui" e "não quero mais".
//
//  ####  OS DOIS UPDATES SÓ MEXEM NO VALOR ANTIGO  ####
//
//  O `WHERE` compara com o texto que a linha tem hoje. Se o admin
//  já tiver renomeado o ranking pela tela, a condição não casa e a
//  escolha dele fica de pé: uma migração que corrige um dado
//  semeado não pode desfazer uma edição feita depois.
//
//  O `trofeu-bleik` não é semeado por migração nenhuma (ver o
//  cabeçalho do catálogo da 034): ele é o primeiro ranking
//  dinâmico, criado pelo painel. Em banco novo estes UPDATEs não
//  casam com linha nenhuma, e é isso mesmo.
// ------------------------------------------------------------
const RANKING_SHORT_LABEL_SCHEMA = `
ALTER TABLE rankings ADD COLUMN short_label TEXT;

ALTER TABLE rankings ADD COLUMN show_in_game INTEGER NOT NULL DEFAULT 1
  CHECK (show_in_game IN (0, 1));

-- O nome inteiro é do site e do painel; o curto é da aba do jogo.
UPDATE rankings
   SET label       = 'Troféu Bleik Store',
       short_label = 'Bleik Store',
       updated_at  = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE id = 'trofeu-bleik' AND label = 'Bleik Store';

-- "Tiro mais longo" e "Poder de raid" não cabem numa aba.
UPDATE rankings
   SET short_label = 'Tiro longo',
       updated_at  = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE metric = 'shot.distance' AND short_label IS NULL;

UPDATE rankings
   SET short_label = 'Raid',
       updated_at  = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE metric = 'explosive.seq' AND short_label IS NULL;
`;

// ------------------------------------------------------------
//  045 — o catálogo passa a saber quem é CONSUMÍVEL
//
//  ####  A PERGUNTA QUE O CADASTRO NÃO CONSEGUIA FAZER  ####
//
//  O item custom ganhou um segundo momento de conversão: em vez de
//  virar ponto ao cair no inventário, ele pode esperar o jogador
//  USAR o item. Só que "usar" não existe em item nenhum: o
//  `OnItemUse` do Oxide só dispara em quem tem `ItemModConsumable`,
//  e o menu de contexto é montado pelo CLIENTE a partir da
//  `ItemDefinition` — não há como criar uma opção nova nele.
//
//  Ou seja: configurar "só ao usar" em cima de um `trophy`
//  (decorativo) produz um item INERTE — o jogador pega, nada
//  acontece, e nada no log explica. É o pior desfecho possível, e
//  ele é silencioso.
//
//  Esta coluna é o que permite recusar essa combinação no
//  CADASTRO, que é o único momento em que alguém está olhando.
//
//  ####  POR QUE ELA ACEITA NULO  ####
//
//  `NULL` é "esta linha veio de uma varredura anterior a este
//  campo, e não dá para afirmar". É diferente de `0` ("o jogo
//  disse que não é consumível"), e a diferença importa: recusar um
//  cadastro por FALTA de dado quebraria a promessa de que o
//  cadastro funciona com todos os servidores parados. Só o `0`
//  recusa; o `NULL` deixa passar e o plugin avisa no log.
//
//  ####  E POR QUE ELA APAGA O PROTOCOLO  ####
//
//  Porque senão a coluna ficaria `NULL` PARA SEMPRE. A releitura
//  do catálogo é invalidada por PROTOCOLO (game/item-catalog.ts):
//  com o mesmo protocolo guardado, o agente conclui que a cópia
//  vale e não relê — e a informação nova nunca chegaria, até o
//  próximo update do Rust.
//
//  Apagar a chave é dizer "não sei em que versão o jogo está", que
//  é exatamente o que o `#isFresh` trata como motivo para reler. O
//  custo é uma leitura de ~1250 itens na próxima conexão de RCON.
// ------------------------------------------------------------
const ITEMS_CONSUMABLE_SCHEMA = `
ALTER TABLE items
  ADD COLUMN consumable INTEGER
  CHECK (consumable IS NULL OR consumable IN (0, 1));

DELETE FROM meta WHERE key = 'items.protocol';
`;

// ------------------------------------------------------------
//  049 — o catálogo passa a saber a RARIDADE de cada item
//
//  ####  SEM ELA, O EDITOR DE LOOT NÃO MOSTRA PORCENTAGEM  ####
//
//  O BetterLoot não guarda probabilidade nenhuma nas entradas de
//  `Ungrouped Items` — foram medidas 6.824 delas no `server01`, e
//  nenhuma tem o campo. Quem decide a chance é a raridade do item
//  NO JOGO: o plugin separa os itens da caixa em cinco baldes por
//  `(int)ItemDefinition.rarity` e pesa cada balde com
//  `2^(4-i)*1000` — [16000, 8000, 4000, 2000, 1000] —, multiplica
//  pelo tamanho do balde e sorteia.
//
//  Ou seja: a coluna de porcentagem da tela de loot é uma conta
//  que só fecha com este número. Sem ele a tela mostra travessão
//  em todas as linhas, que é honesto e inútil.
//
//  ####  E POR QUE ELA NÃO TEM CHECK DE FAIXA  ####
//
//  Diferente da 045, que aceita só `0` e `1` porque booleano tem
//  dois valores e ponto. Aqui a faixa é a de um ENUM DO JOGO, e a
//  Facepunch pode acrescentar um valor a ele num update qualquer.
//
//  Um `CHECK (rarity BETWEEN 0 AND 4)` derrubaria a transação
//  inteira no dia em que o jogo devolvesse `5` — e a gravação do
//  catálogo é TUDO OU NADA (ver game/item-catalog.ts), então o
//  agente ficaria sem catálogo nenhum por causa de um item. O que
//  se guarda é o que o jogo disse; quem não reconhece o número é
//  a tela, e ela já sabe mostrar o valor cru em vez de inventar um
//  rótulo (`rarityLabel`, no painel).
//
//  ####  E POR QUE ELA APAGA O PROTOCOLO  ####
//
//  Pela mesma razão da 045, e ela é a metade que se esquece: a
//  releitura do catálogo é invalidada por PROTOCOLO. Com o mesmo
//  protocolo guardado, o agente conclui que a cópia vale e não
//  relê — a coluna nasceria nula e ficaria nula para sempre, até o
//  próximo update do Rust.
//
//  Apagar a chave é dizer "não sei em que versão o jogo está", que
//  é o que o `#isFresh` trata como motivo para reler. O custo é
//  uma leitura de ~1250 itens na próxima conexão de RCON.
// ------------------------------------------------------------
const ITEMS_RARITY_SCHEMA = `
ALTER TABLE items
  ADD COLUMN rarity INTEGER;

DELETE FROM meta WHERE key = 'items.protocol';
`;

// ------------------------------------------------------------
//  055 — o catálogo passa a saber o nome do item EM PORTUGUÊS
//
//  ####  SEM ELA, A TELA DO JOGO FALA INGLÊS  ####
//
//  A tela de kits mostrava "Burlap Headwrap" e "Nailgun" para um
//  jogador com o jogo em português — no meio de uma interface em
//  que todo o resto ("KITS", "RANKING", "Resgatar") já estava
//  traduzido.
//
//  O CUI não tem token de tradução: ele imprime a string que o
//  servidor mandar, e ponto. Então o nome que o jogador lê é
//  escolhido AQUI, e precisa estar guardado.
//
//  ####  A TRADUÇÃO É A DO JOGO, E NÃO UMA TABELA NOSSA  ####
//
//  Não há nome inventado nesta coluna. O que ela guarda é o que a
//  Facepunch traduziu, lido pelo plugin com
//  `Translate.GetServerTranslation(token, "pt-BR")` — que resolve
//  `assets/localization/pt-br/engine.json`, de dentro do
//  `content.bundle` do próprio servidor.
//
//  Isso importa: o nome no menu passa a ser LETRA POR LETRA o
//  mesmo que o jogador vê no inventário. Uma tradução nossa, por
//  melhor que fosse, diria "Rifle de Assalto" onde o inventário
//  diz outra coisa — e o jogador não acharia o item.
//
//  MEDIDO em produção (07/09/2026, com o plugin 0.4.0): 1.255 dos
//  1.259 itens do catálogo têm tradução. Só 4 ficam NULOS.
//
//  O número é alto porque a chave é o `displayName.token`, e não o
//  shortname: casando por shortname a cobertura cai para 84%, e é
//  esse o erro que uma leitura apressada do bundle produz.
//
//  ####  E POR QUE NULO NÃO É DEFEITO  ####
//
//  Nulo aqui quer dizer "o jogo não traduz este item" — e a tela
//  cai no `display_name`, que é o que ela já mostrava. Um item sem
//  tradução não regride; ele só não melhora.
//
//  Vale para a coluna inteira, também: um servidor com o plugin
//  anterior a 07/09/2026 responde o catálogo sem o campo, e a
//  rede inteira fica com a coluna nula até que ele atualize. A
//  tela volta a ser a de hoje, e nada quebra.
//
//  ####  E POR QUE ELA APAGA O PROTOCOLO  ####
//
//  Pela mesma razão da 045 e da 049, e ela é a metade que se
//  esquece: a releitura do catálogo é invalidada por PROTOCOLO.
//  Com o mesmo protocolo guardado, o agente conclui que a cópia
//  vale e não relê — a coluna nasceria nula e ficaria nula para
//  sempre, até o próximo update do Rust.
//
//  Apagar a chave é dizer "não sei em que versão o jogo está", que
//  é o que o `#isFresh` trata como motivo para reler. O custo é
//  uma leitura de ~1250 itens na próxima conexão de RCON.
// ------------------------------------------------------------
const ITEMS_DISPLAY_NAME_PTBR_SCHEMA = `
ALTER TABLE items
  ADD COLUMN display_name_ptbr TEXT;

DELETE FROM meta WHERE key = 'items.protocol';
`;

// ------------------------------------------------------------
//  056  -  O PEDIDO DE CANCELAMENTO SOBREVIVE AO REINÍCIO
//
//  ####  PEDIDO E DESFECHO SÃO DOIS FATOS  ####
//
//  A rota de cancelar, com a operação viva, só chamava
//  \`operation.cancel()\`: quem gravava \`cancelled\` era a máquina de
//  passos, no fim — para não haver duas verdades sobre o mesmo
//  desfecho. Isso deixava uma janela em que o admin JÁ tinha
//  cancelado e a linha ainda dizia \`running\`.
//
//  A janela não é teórica: o \`backup\` de um save grande leva
//  minutos, e o cancelamento pedido no meio dele só vira desfecho
//  quando o passo termina.
//
//  Enquanto um agente morto era o fim da execução, a janela não
//  fazia mal — a linha virava \`failed\` e alguém decidia. Com a
//  retomada automática do boot (wipe/recover.ts), ela passou a ser
//  o caminho para o pior resultado possível: o agente voltando e
//  TERMINANDO um wipe que o admin mandou parar.
//
//  Esta coluna é o pedido, e não o desfecho. Ela é gravada na hora
//  do clique, sobrevive ao restart, e a máquina de passos continua
//  dona do \`status\` — as duas verdades continuam sendo uma só.
// ------------------------------------------------------------
const WIPE_RUN_CANCEL_REQUESTED_SCHEMA = `
ALTER TABLE wipe_runs
  ADD COLUMN cancel_requested_at INTEGER;
`;

// ------------------------------------------------------------
//  046  -  AS QUESTS
//
//  ####  A DEFINIÇÃO É DE REDE; O PROGRESSO É DE SERVIDOR  ####
//
//  Cadastrar "minerar 5.000 de enxofre" em cada servidor produziria
//  N quests com o mesmo nome e progressos que ninguém consegue
//  comparar. A quest é uma só, como VIP, kit e mensagem — e o
//  servidor onde ela foi feita mora na linha de player_quests.
//
//  ####  QUEST É ASSINATURA SOBRE EVENTO  ####
//
//  O ranking guarda estatística como (metric, value) para que criar
//  um ranking deixasse de ser escrever código. Quest é o passo
//  seguinte da mesma ideia: se o evento do jogo já vira uma linha,
//  uma quest é uma ASSINATURA sobre ela — um alvo, uma quantidade,
//  e o que acontece quando a soma chega lá.
//
//  A consequência que faz o pedido do dono caber: criar uma quest
//  é uma linha aqui, N em quest_objectives e N em quest_rewards.
//  A vigésima custa o mesmo que a segunda: zero.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §3.
// ------------------------------------------------------------
const QUESTS_CORE_SCHEMA = `
CREATE TABLE quests (
  -- Slug estável. É o que a URL do painel guarda, o que o site
  -- consome e o que o endereço da tela do jogo carrega.
  id TEXT PRIMARY KEY,

  title TEXT NOT NULL,

  -- O que o jogador lê antes de aceitar. Aceita a marcação de chat
  -- do projeto (game/chat-markup.ts).
  description TEXT,

  -- 'diaria', 'semanal', 'historia', 'evento', 'geral'. É TEXTO
  -- LIVRE de propósito: a categoria é uma aba na tela e um filtro
  -- no painel, e inventar uma nova não pode ser uma migração.
  category TEXT NOT NULL DEFAULT 'geral',

  -- 0 = cadastrada mas fora do ar. Apagar seria perder o progresso
  -- de quem já a fez; a mesma escolha do server_plugins.enabled da
  -- migração 002.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- A ordem na tela do jogo e no painel. Arrastável, como o
  -- catálogo de rankings da migração 044.
  sort INTEGER NOT NULL DEFAULT 0,

  -- ####  QUEM PODE VER  ####
  --
  -- NULL = todo mundo. Preenchido = uma permissão do Oxide
  -- ('origemzquests.vip') ou um tier de VIP ('vip:ouro').
  --
  -- A checagem é do AGENTE, na montagem da tela: o plugin não
  -- decide quem vê o quê, pela mesma razão que applyHidden roda no
  -- agente e não no OrigemZUI — a decisão fica do lado que tem
  -- teste.
  requires TEXT,

  -- ####  ONDE SE PEGA  ####
  --
  -- NULL = aparece no menu /quest para todos.
  -- Preenchido = só aparece na tela DAQUELE NPC.
  --
  -- Sem REFERENCES de propósito: quest_npcs nasce na migração 047,
  -- que pode chegar depois — e uma FK para tabela inexistente
  -- derrubaria esta migração inteira. A integridade é cobrada na
  -- rota (QUEST_NPC_MISSING), que é quem sabe dizer em que
  -- servidor aquele NPC está.
  npc_id TEXT,

  -- ####  REPETIÇÃO  ####
  --   'once'     — uma vez na vida, por servidor
  --   'cooldown' — repete depois de cooldown_seconds
  --   'daily'    — repete na virada do dia
  --   'weekly'   — repete na virada da semana
  repeat_mode TEXT NOT NULL DEFAULT 'once'
    CHECK (repeat_mode IN ('once','cooldown','daily','weekly')),

  -- Só lido quando repeat_mode = 'cooldown'.
  cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0),

  -- ####  A CADEIA  ####
  --
  -- A quest só aparece depois que ESTA outra foi concluída. É o
  -- que transforma quests soltas numa história.
  --
  -- Ciclo (A exige B, B exige A) é recusado NA ROTA, e não aqui:
  -- o SQLite não tem como ver isso, e o custo de estar errado é
  -- uma quest que nunca aparece para ninguém e ninguém entende
  -- por quê.
  requires_quest TEXT REFERENCES quests(id) ON DELETE SET NULL,

  -- Epoch em MILISSEGUNDOS, como o resto do agente. NULL nos dois
  -- = sempre disponível.
  available_from INTEGER,
  available_to   INTEGER,

  -- 1 = o jogador não precisa aceitar; ela já nasce ativa quando
  -- ele conecta. É o que faz a diária funcionar sem clique.
  auto_accept INTEGER NOT NULL DEFAULT 0 CHECK (auto_accept IN (0, 1)),

  -- ####  O QUE O WIPE FAZ COM ELA  ####
  --   'reset' — o progresso zera quando o mundo zera
  --   'keep'  — atravessa o wipe
  wipe_policy TEXT NOT NULL DEFAULT 'reset'
    CHECK (wipe_policy IN ('reset','keep')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_quests_listing ON quests (enabled, category, sort);
CREATE INDEX idx_quests_npc     ON quests (npc_id) WHERE npc_id IS NOT NULL;

-- ----------------------------------------------------------
--  quest_objectives — o que precisa ser feito. N por quest.
--
--  ####  POR QUE MULTI-OBJETIVO, SE O Quests.cs TEM UM SÓ  ####
--
--  Porque uma tabela custa o mesmo que uma coluna, e ela abre
--  "mate 10 cientistas E colete 500 de scrap" — que é a diferença
--  entre uma tarefa e uma MISSÃO. Um objetivo só é o caso
--  particular de N = 1, e a tela desenha os dois igual.
--
--  A quest conclui quando TODOS fecham. "Qualquer um deles" não
--  existe no primeiro corte: ninguém pediu, e ele exigiria um
--  campo de modo que a tela teria de explicar.
--
--  ####  seq É A CHAVE QUE ATRAVESSA  ####
--
--  O id autoincremento nunca sai desta tabela. Quem viaja até o
--  plugin, quem a linha de progresso guarda e quem o snapshot da
--  tentativa referencia é o seq — é ele que sobrevive a um
--  objetivo reescrito no painel.
-- ----------------------------------------------------------
CREATE TABLE quest_objectives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,

  seq INTEGER NOT NULL,

  -- ####  DE ONDE O NÚMERO VEM  ####
  --   'kill'     — matar. target = 'scientist', 'bear', 'player'
  --   'gather'   — colher. target = shortname do recurso
  --   'craft'    — fabricar. target = shortname do item
  --   'loot'     — pegar de container/chão. target = shortname
  --   'deliver'  — levar de um NPC a outro. target = id do NPC
  --   'playtime' — tempo online, em minutos. target = NULL
  --   'metric'   — qualquer métrica do ranking. metric preenchido
  --
  -- Os quatro primeiros e o metric custam ZERO em performance: o
  -- OrigemZAgent já roda esses hooks para o ranking. O loot é o
  -- único caro, e ele só é registrado no plugin quando existe
  -- objetivo de loot vivo.
  kind TEXT NOT NULL
    CHECK (kind IN ('kill','gather','craft','loot','deliver','playtime','metric')),

  -- O alvo. NULL em 'playtime' e em 'metric'.
  target TEXT,

  -- Só em kind = 'metric': a chave em player_stats. Mesmo formato
  -- do ranking: familia.nome, minúsculas.
  metric TEXT,

  -- Zero é recusado: um objetivo de zero conclui sozinho e a quest
  -- inteira vira um botão de recompensa grátis.
  amount INTEGER NOT NULL CHECK (amount > 0),

  -- Sobrescreve a frase montada. NULL = o agente monta ("Matar 20
  -- cientistas") a partir de kind + target + amount, com o nome
  -- bonito do catálogo de itens.
  label TEXT,

  -- ####  ItemDeduction, o nome dele no Quests.cs  ####
  --
  -- 1 = os itens SAEM do inventário quando a quest é resgatada.
  -- Só faz sentido em 'loot' e 'gather' — e quem cobra isso é o
  -- zod, porque a frase de erro precisa ser lida por quem cadastra.
  --
  -- Quem tira é o plugin, a mando do agente; e se não houver o que
  -- tirar, o resgate FALHA antes de a recompensa sair.
  consume INTEGER NOT NULL DEFAULT 0 CHECK (consume IN (0, 1)),

  UNIQUE (quest_id, seq)
);

CREATE INDEX idx_quest_objectives_quest ON quest_objectives (quest_id, seq);

-- A consulta mais quente do sistema: "que objetivos vivos existem
-- para este par kind+target?" — é ela que monta o catálogo que
-- desce ao plugin no origemz.quest.watch.
CREATE INDEX idx_quest_objectives_watch ON quest_objectives (kind, target);

-- ----------------------------------------------------------
--  quest_rewards — o que ela dá. N por quest.
--
--  ####  O PAYLOAD É JSON, COMO A AÇÃO DO ITEM CUSTOM  ####
--
--  Cinco tipos de recompensa com colunas próprias dariam uma
--  tabela com quinze colunas das quais treze são NULL em toda
--  linha, e um tipo novo seria uma migração. A migração 041 já
--  resolveu isso com custom_items.action, e o padrão é o dela.
--
--  A régua é UMA e mora no zod (types/quests.ts). O banco só
--  garante que o kind é conhecido.
-- ----------------------------------------------------------
CREATE TABLE quest_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,

  kind TEXT NOT NULL CHECK (kind IN ('item','coins','kit','points','vip')),

  -- O corpo, conforme o kind, sem repetir o kind dentro.
  payload TEXT NOT NULL,

  UNIQUE (quest_id, seq)
);

CREATE INDEX idx_quest_rewards_quest ON quest_rewards (quest_id, seq);

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
  quest_id  TEXT NOT NULL REFERENCES quests(id)  ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (quest_id, server_id)
);

-- "Que quests valem neste servidor?" é a pergunta do catálogo que
-- desce ao plugin, e a chave primária começa pela outra coluna.
CREATE INDEX idx_quest_servers_server ON quest_servers (server_id);

-- ----------------------------------------------------------
--  player_quests — uma TENTATIVA de um jogador numa quest.
--
--  ####  POR QUE attempt, E NÃO UMA LINHA POR JOGADOR  ####
--
--  Porque quest repetível é a regra, não a exceção: a diária é
--  feita trinta vezes por mês. Uma linha só, sobrescrita, apagaria
--  o histórico — e "quantas vezes o Fulano fez a diária?" é
--  exatamente a pergunta que o painel precisa responder.
--
--  A tentativa VIVA é a de maior attempt, e a consulta dela usa o
--  índice parcial abaixo, que só enxerga as não terminadas.
-- ----------------------------------------------------------
CREATE TABLE player_quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  quest_id  TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,

  -- 1, 2, 3… Sobe a cada nova tentativa da mesma quest.
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),

  -- ####  OS QUATRO ESTADOS  ####
  --   'active'    — aceita, contando
  --   'completed' — os objetivos fecharam; a recompensa espera
  --   'claimed'   — resgatada. É o estado FINAL feliz
  --   'abandoned' — ele cancelou, ou o admin resetou
  --
  -- 'completed' é um estado, e não um instante: concluir e receber
  -- são coisas diferentes. Sem essa separação a recompensa sairia
  -- no instante da conclusão — num inventário cheio, no meio de um
  -- tiroteio, ou com o jogador desconectando.
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
  -- aceite, como JSON. Mesma razão do DeliveryPlan da loja: o
  -- resgate acontece horas depois, e uma quest editada no meio
  -- entregaria outra coisa — ou, se apagada, nada.
  --
  -- E aqui é pior que na compra, que leva segundos: uma diária
  -- aceita às 8h é resgatada às 23h.
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

-- ----------------------------------------------------------
--  player_quest_progress — quanto falta, objetivo a objetivo.
--
--  A chave aponta para a TENTATIVA, e não para (steam_id,
--  quest_id): sem isso, a segunda diária começaria com o contador
--  da primeira.
--
--  objective_seq e não objective_id: o seq é o que viaja até o
--  plugin e o que sobrevive a um objetivo editado no painel. O
--  snapshot da tentativa é quem diz o que aquele seq significava.
-- ----------------------------------------------------------
CREATE TABLE player_quest_progress (
  player_quest_id INTEGER NOT NULL REFERENCES player_quests(id) ON DELETE CASCADE,
  objective_seq   INTEGER NOT NULL,

  value      INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (player_quest_id, objective_seq)
);

-- ----------------------------------------------------------
--  quest_batches — o lote já aplicado.
--
--  Cópia deliberada do stat_batches da migração 033: o mesmo
--  problema, a mesma solução, e um desenho que já sobreviveu a
--  quedas de RCON em produção.
--
--  Ele existe porque o ack pode se perder DEPOIS do commit — e
--  então o mesmo lote volta na rodada seguinte. Sem esta tabela,
--  ele somaria duas vezes e nada no log diria por quê.
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
--  zerado aqui". Com ela: aceitou às 14h02, progrediu até 4.980, o
--  servidor caiu às 14h31, o lote de 14h32 trouxe os 20 que
--  faltavam, resgatou às 14h33, o kit saiu.
--
--  ####  event_id É DO PLUGIN, E É ELE QUE DESEMPATA  ####
--
--  O mesmo fato chega duas vezes DE PROPÓSITO: o push dá o
--  "agora", o lote dá o "garantido". O UNIQUE aqui é o que faz as
--  duas chegadas virarem uma linha só — e "já vi este" é o caso
--  NORMAL, nunca uma linha de log de alarme.
--
--  NULL nos eventos que nascem no agente (aceite pelo menu, reset
--  pelo painel): só o plugin gera id de evento.
-- ----------------------------------------------------------
CREATE TABLE quest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  event_id TEXT UNIQUE,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id  TEXT NOT NULL,
  quest_id  TEXT NOT NULL,
  attempt   INTEGER NOT NULL,

  kind TEXT NOT NULL
    CHECK (kind IN ('accept','progress','complete','claim','abandon','reset','reward_failed')),

  -- O corpo do evento, como JSON: o objetivo e o delta no
  -- 'progress', o que foi entregue no 'claim', o código do erro no
  -- 'reward_failed'.
  detail TEXT,

  source TEXT NOT NULL CHECK (source IN ('plugin','agent','panel','wipe')),

  -- Quem mandou, quando é gente. NULL quando é o jogo.
  actor TEXT,

  at INTEGER NOT NULL
);

CREATE INDEX idx_quest_events_player ON quest_events (steam_id, at DESC);
CREATE INDEX idx_quest_events_quest  ON quest_events (quest_id, at DESC);

-- ----------------------------------------------------------
--  quest_settings — o que muda por servidor.
--
--  Uma linha por servidor, e ela pode não existir: ausência = os
--  padrões de DEFAULT_QUEST_SETTINGS.
--
--  ####  POR QUE NÃO UM JSON NA TABELA servers  ####
--
--  Porque cada frente que precisasse de uma chave teria de
--  reescrever o mesmo blob, e duas gravações concorrentes
--  perderiam uma. O ranking já tem ranking_settings pelo mesmo
--  motivo.
-- ----------------------------------------------------------
CREATE TABLE quest_settings (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,

  -- 0 = sem teto. É o PlayerMaxQuests do Quests.cs.
  max_active INTEGER NOT NULL DEFAULT 0 CHECK (max_active >= 0),

  -- 0 = o módulo inteiro desligado neste servidor. O /quest
  -- continua abrindo e diz que não há quests — nunca some sem
  -- explicação.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- Segundos entre dois ciclos de flush. 60 é o do ranking, e é o
  -- padrão; um servidor apertado sobe isso.
  flush_seconds INTEGER NOT NULL DEFAULT 60 CHECK (flush_seconds >= 15),

  -- 0 = o hook de loot NÃO é registrado neste servidor, mesmo
  -- havendo quest de loot cadastrada. É a válvula que o
  -- origemz.quest.diag existe para informar.
  loot_enabled INTEGER NOT NULL DEFAULT 1 CHECK (loot_enabled IN (0, 1)),

  -- A hora da virada da diária/semanal, em minutos desde a
  -- meia-noite do fuso do agente. 0 = meia-noite.
  reset_at_minute INTEGER NOT NULL DEFAULT 0
    CHECK (reset_at_minute BETWEEN 0 AND 1439),

  updated_at INTEGER NOT NULL
);
`;

// ------------------------------------------------------------
//  047  -  O NPC DAS QUESTS
//
//  ####  POR QUE ELE É UMA MIGRAÇÃO SEPARADA  ####
//
//  Porque é a frente mais cara e a mais provável de escorregar: o
//  Quests.cs de referência depende do HumanNPC, que não está
//  instalado aqui, e não há hook de conversa no Oxide desta
//  instalação (CONFERIDO: grep no Oxide.Rust.dll só devolve
//  OnNpcTarget). O boneco é construído por nós.
//
//  Separada, ela pode chegar depois sem segurar o resto — e o
//  sistema inteiro funciona com npc_id nulo em todas as quests.
//
//  ####  O NPC NÃO É DE REDE  ####
//
//  Ao contrário da quest, um X/Z do mapa de hoje não significa
//  nada no mapa do outro servidor, e menos ainda depois do wipe.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §4 e §10.
// ------------------------------------------------------------
const QUESTS_NPC_SCHEMA = `
CREATE TABLE quest_npcs (
  id TEXT PRIMARY KEY,

  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- O que aparece sobre a cabeça dele e no marcador do mapa.
  name TEXT NOT NULL,

  -- 'quest'    — abre a tela com as quests dele
  -- 'delivery' — é destino de uma quest de entrega
  kind TEXT NOT NULL DEFAULT 'quest' CHECK (kind IN ('quest','delivery')),

  -- A posição no mundo. y é gravado, mas o plugin RECALCULA a
  -- altura do terreno ao spawnar: o mapa muda, o chão sobe e
  -- desce, e um NPC enterrado é invisível e insuportável de
  -- diagnosticar.
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,

  -- Para onde ele olha, em graus. É o que faz o NPC encarar quem
  -- chega em vez de dar as costas.
  rotation REAL NOT NULL DEFAULT 0,

  -- O prefab do boneco. MEDIDO com Mono.Cecil contra o
  -- Assembly-CSharp.dll real: NPCShopKeeper existe e é o que se
  -- spawna parado.
  --
  -- Guardado, e não fixo no código, porque trocar a aparência é
  -- pedido de admin — não release de agente.
  prefab TEXT NOT NULL
    DEFAULT 'assets/prefabs/npc/bandit/shopkeepers/bandit_shopkeeper.prefab',

  -- 1 = desenha um marcador no mapa do jogo.
  map_marker INTEGER NOT NULL DEFAULT 1 CHECK (map_marker IN (0, 1)),

  -- O raio, em metros, dentro do qual apertar USE abre a tela. Um
  -- raio grande faz dois NPCs próximos disputarem o mesmo clique,
  -- e quem joga não tem como saber com qual dos dois falou.
  use_radius REAL NOT NULL DEFAULT 3.0 CHECK (use_radius > 0),

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
`;

// ------------------------------------------------------------
//  048 — a regra de loot: o que NÓS acrescentamos ao que o jogo
//  já põe na caixa.
//
//  ####  ELA É COMPLEMENTAR, E NUNCA SUBSTITUI  ####
//
//  O jogo popula o container normalmente; nós acrescentamos por
//  cima. Nada aqui reimplementa `FillLoot`, `PopulateLoot` ou
//  `GenerateScrap` — e o motivo decisivo não é segurança, é o
//  update: a tabela do Rust são 1.396 entradas alcançáveis que a
//  Facepunch mantém de graça, com filtro de era e 38 tabelas de
//  Halloween que aparecem e somem sozinhas. Substituir é assumir
//  essa manutenção em silêncio.
//
//  Ver Docs/CustomItem/05-EDITOR-DE-LOOT.md §4.
//
//  ####  UMA REGRA É UMA LINHA; A CÓPIA DA TABELA SERIAM 1.396  ####
//
//  Por isso o que se guarda aqui é a REGRA — "no crate_elite,
//  acrescente o troféu com chance 1/10.000" —, e não a tabela do
//  jogo. O que não foi tocado continua sendo o do jogo, de graça.
//
//  ####  A MARCA SAI DO `custom_items`, E É POR ISSO QUE HÁ FK  ####
//
//  MEDIDO em Docs/CustomItem/04 §4.1: `LootSpawn.SpawnIntoContainer`
//  passa `0uL` literal ao `ItemManager.Create`, e `ItemAmount` não
//  tem campo de skin. Um item nascido da tabela nativa sai SEM
//  marca, o `Match` do plugin sai em `skin == 0`, e o jogador acha
//  lixo. Só o nosso código carimba skin — e a skin vem daqui, do
//  item custom apontado pela FK.
//
//  Apagar o item custom leva as regras junto (CASCADE): uma regra
//  que aponta para item que não existe mais não teria como
//  carimbar marca nenhuma.
//
//  ####  O `mode` NÃO É OPCIONAL, E ELE É O CORAÇÃO DESTA FATIA  ####
//
//  Q8 do `04`, respondida pelo dono: mede antes de soltar. Em
//  `measuring` a regra CONTA quantas vezes teria disparado e não
//  cria item nenhum; em `live` ela cria. É o que troca a
//  estimativa de 1.000–5.000 containers/dia por número medido —
//  sem ele, a probabilidade de partida é um chute com fator de
//  erro de 5.
//
//  ####  E `loot_rule_hits` É CONTADOR, NÃO FILA  ####
//
//  A linha é SOBRESCRITA a cada leitura, e não somada. O plugin
//  guarda o acumulado do dia em disco e o agente o copia — ler
//  duas vezes dá o mesmo número, e uma leitura perdida se conserta
//  sozinha na volta seguinte. É o oposto da fila de pontos
//  (OrigemZItems, `pending`), e de propósito: lá o item JÁ FOI
//  DESTRUÍDO e o que se perde não volta; aqui o que se perde é uma
//  contagem que o próprio plugin ainda tem.
//
//  O `day` chega PRONTO do servidor de jogo, e não é recalculado
//  aqui. Quem aplica o teto diário é o plugin, com o relógio dele:
//  um teto que vira à meia-noite de um fuso e um gráfico que vira
//  à de outro seriam duas verdades sobre o mesmo dia, e a pergunta
//  "por que o teto de 3 rendeu 4?" não teria resposta.
// ------------------------------------------------------------
const LOOT_RULES_SCHEMA = `
CREATE TABLE loot_rules (
  -- Slug derivado do rótulo, como em custom_items: ele viaja num
  -- comando de console do Rust, onde espaço separa argumentos.
  id              TEXT PRIMARY KEY,

  -- O que o admin lê na lista.
  label           TEXT NOT NULL,

  -- De onde sai a MARCA (base_shortname, skin_id). Ver o cabeçalho.
  custom_item_id  TEXT NOT NULL REFERENCES custom_items(id) ON DELETE CASCADE,

  -- Os ShortPrefabName, em JSON. Lista, e não tabela de junção:
  -- ela é lida e escrita SEMPRE inteira (o PUT reescreve a regra),
  -- nunca consultada por container do lado do agente — quem
  -- pergunta "esta caixa tem regra?" é o plugin, com o índice dele
  -- em memória. Uma tabela aqui daria três consultas para guardar
  -- o que cabe numa coluna.
  containers      TEXT NOT NULL,

  -- Por container POPULADO — e o denominador é esse, não "caixa
  -- aberta". Ver Docs/CustomItem/04 §6.3: em regime estacionário
  -- os dois convergem, porque barril destruído é barril que
  -- alguém abriu.
  chance          REAL NOT NULL CHECK (chance > 0 AND chance <= 1),

  amount_min      INTEGER NOT NULL DEFAULT 1 CHECK (amount_min >= 1),
  amount_max      INTEGER NOT NULL DEFAULT 1 CHECK (amount_max >= amount_min),

  -- 'measuring' conta e NÃO cria; 'live' cria. Ver o cabeçalho.
  -- O default é o que não solta item no mundo: uma regra criada
  -- por um painel antigo, sem o campo, mede em vez de emitir.
  mode            TEXT NOT NULL DEFAULT 'measuring'
                  CHECK (mode IN ('measuring', 'live')),

  -- Teto por servidor por dia. NULL = sem teto.
  --
  -- Ele existe porque probabilidade sozinha entrega o controle da
  -- economia a quem mais joga: dobrar a rota de farm dobra a
  -- emissão. Ver Docs/CustomItem/04 §6.1.
  daily_cap       INTEGER CHECK (daily_cap IS NULL OR daily_cap > 0),

  -- O portão da Via B (OnLootEntity). NULL = sem cooldown.
  --
  -- Ele não cabe na Via A: no instante em que o container é
  -- populado NÃO EXISTE JOGADOR a quem aplicar cooldown. Ver
  -- Docs/CustomItem/04 §6.5 e a Q1 de lá.
  player_cooldown_hours INTEGER
                  CHECK (player_cooldown_hours IS NULL OR player_cooldown_hours > 0),

  -- Desligada não é apagada: o histórico de medição continua
  -- valendo, e religar não exige recadastrar.
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_loot_rules_item ON loot_rules (custom_item_id);

-- Em quais servidores esta regra vale. Junção PURA, cópia do
-- \`custom_item_servers\` (041) e do \`kit_servers\` (012),
-- inclusive o índice: a chave primária começa por \`rule_id\`, e a
-- pergunta do plugin é a OUTRA — "quais regras este servidor
-- tem?" —, que sem o índice varreria a tabela.
--
-- Sem linha nenhuma = em nenhum servidor. Uma regra recém-criada
-- que já valesse em tudo soltaria item em produção sem ninguém
-- mandar.
--
-- ####  SEM COLUNA DE OVERRIDE, E ISSO É UMA ESCOLHA  ####
--
-- O Docs/CustomItem/05 §6.2 recomenda junção COM payload (chance
-- diferente por servidor, no molde de \`player_servers\`), e a Q4
-- de lá deixou isso em aberto. Esta fatia fica na junção pura: o
-- que ela entrega é UM item raro medido antes de soltar, e uma
-- coluna de override que nasce NULL em todas as linhas é uma
-- pergunta respondida cedo demais. Quando ela for pedida, é uma
-- migração de três colunas — o mesmo custo de agora.
CREATE TABLE loot_rule_servers (
  rule_id   TEXT NOT NULL REFERENCES loot_rules(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, server_id)
);

CREATE INDEX idx_loot_rule_servers_server
  ON loot_rule_servers (server_id);

-- ----------------------------------------------------------
--  A MEDIÇÃO — o que a regra fez, por dia.
--
--  Quatro números, e cada um responde uma pergunta diferente:
--
--    rolls    quantos containers ELEGÍVEIS passaram pelo sorteio.
--             É o \`N\` do Docs/CustomItem/04 §6.3, o denominador
--             que o estudo não conseguiu medir;
--    hits     quantas vezes o sorteio deu positivo;
--    spawned  quantas vezes o item de fato NASCEU. Em
--             'measuring' é sempre 0 — é essa diferença que faz o
--             modo servir para alguma coisa. Em 'live' ele é menor
--             que \`hits\` quando o teto do dia estourou ou o
--             container estava cheio;
--    blocked  quantas vezes o portão da Via B barrou um jogador
--             (cooldown). O item CONTINUA no container: barrar não
--             é destruir. Ver Docs/CustomItem/04, Q1.
--
--  Sem \`spawned\` separado de \`hits\`, "não saiu troféu" não teria
--  como distinguir sorte ruim de teto batendo — que é a
--  caixa-preta que o §7.4 daquele documento manda evitar.
-- ----------------------------------------------------------
CREATE TABLE loot_rule_hits (
  rule_id    TEXT NOT NULL REFERENCES loot_rules(id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- 'YYYY-MM-DD', no fuso do SERVIDOR DE JOGO. Ver o cabeçalho.
  day        TEXT NOT NULL,

  -- O modo em que a regra estava. Ele entra na chave de propósito:
  -- o dia em que alguém virou a chave de 'measuring' para 'live'
  -- tem duas linhas, e é isso que permite dizer "com esta chance,
  -- teria dado tantos" ao lado de "deu tantos".
  mode       TEXT NOT NULL CHECK (mode IN ('measuring', 'live')),

  rolls      INTEGER NOT NULL DEFAULT 0,
  hits       INTEGER NOT NULL DEFAULT 0,
  spawned    INTEGER NOT NULL DEFAULT 0,
  blocked    INTEGER NOT NULL DEFAULT 0,

  updated_at INTEGER NOT NULL,

  PRIMARY KEY (rule_id, server_id, day, mode)
);

CREATE INDEX idx_loot_rule_hits_day ON loot_rule_hits (day);
`;

// ------------------------------------------------------------
//  050 — o overlay de propagandas
//
//  ####  ELE VEIO DO AGENTE ANTIGO, E CHEGA ACHATADO  ####
//
//  Lá foram TRÊS migrações até esta forma: a tabela, depois o logo
//  com lugar próprio, e por fim a reconstrução que pôs `server_id`
//  em tudo. Aqui nenhuma das duas tabelas existiu um dia, então
//  elas nascem no estado final — repetir os passos históricos só
//  reproduziria uma escada que este banco nunca subiu.
//
//  ####  DUAS TABELAS, E ELAS MUDAM POR MOTIVOS DIFERENTES  ####
//
//    ads            a LISTA — o que aparece, em que ordem e
//                   quando. Muda quando alguém cadastra campanha.
//    ads_settings   o AJUSTE — tamanho, posição, relógio e
//                   animação. Muda quando alguém mexe no desenho.
//
//  A `position` anda de 10 em 10, igual aos avisos do chat:
//  arrastar uma linha para o meio grava 15 e não reescreve a
//  lista inteira, que é o que uma numeração 1,2,3 exigiria.
//
//  ####  NAO HA LINHA SEMEADA DE AJUSTE, E ISSO E DE PROPOSITO  ####
//
//  O ajuste é POR SERVIDOR, e semeá-lo exigiria saber quais
//  servidores existem no instante da migração — e teria de
//  acontecer de novo a cada servidor criado depois. Quem responde
//  por servidor sem linha é o repositório, com o padrão
//  DESLIGADO; quem grava usa UPSERT. Ver `settings` e
//  `updateSettings` em db/ads-repository.ts.
// ------------------------------------------------------------
const ADS_SCHEMA = `
CREATE TABLE ads (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,

  -- Desligada, a propaganda continua cadastrada e sai do rodízio.
  -- É o que permite guardar a campanha de Natal o ano inteiro.
  enabled     INTEGER NOT NULL DEFAULT 1,

  image_url   TEXT NOT NULL,

  -- NULL = usa o padrão do ajuste. Guardar o padrão copiado em
  -- cada linha faria mudá-lo não ter efeito nenhum.
  display_duration INTEGER,

  position    INTEGER NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  weight      INTEGER NOT NULL DEFAULT 1,

  fit              TEXT NOT NULL DEFAULT 'cover'
                   CHECK (fit IN ('cover', 'contain')),
  background_color TEXT NOT NULL DEFAULT '#0A0A0AEB',
  border_color     TEXT NOT NULL DEFAULT '#FFFFFF26',

  -- A janela de exibição. Tudo NULL = sem restrição.
  start_date  TEXT,
  end_date    TEXT,
  start_time  TEXT,
  end_time    TEXT,
  -- CSV de 0 a 6, com 0 = domingo. Vazio = todos os dias.
  -- CSV e não tabela filha: são no máximo sete números que só
  -- são lidos junto com a linha, e uma junção para isso seria
  -- cerimônia sem ganho.
  days_of_week TEXT NOT NULL DEFAULT '',
  permission  TEXT,

  -- O cache da imagem, do lado do agente.
  image_status     TEXT NOT NULL DEFAULT 'pending'
                   CHECK (image_status IN ('pending', 'ready', 'error')),
  image_key        TEXT,
  image_sha        TEXT,
  image_bytes      INTEGER,
  image_width      INTEGER,
  image_height     INTEGER,
  image_error      TEXT,
  image_fetched_at INTEGER,

  shown_count   INTEGER NOT NULL DEFAULT 0,
  last_shown_at INTEGER,

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_ads_position ON ads (server_id, position);

CREATE TABLE ads_settings (
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  id          INTEGER NOT NULL CHECK (id = 1),

  -- ####  NASCE DESLIGADO, DE PROPÓSITO  ####
  --
  -- Um agente recém-instalado não deveria pôr um painel na tela
  -- de ninguém. Ligar é um clique; descobrir que o servidor está
  -- mostrando propaganda de exemplo para os jogadores é outra
  -- coisa.
  enabled     INTEGER NOT NULL DEFAULT 0,

  -- 'Hud' e não 'Overlay': é a camada que fica visível enquanto
  -- se joga e que não disputa espaço com o inventário.
  layer       TEXT NOT NULL DEFAULT 'Hud',
  permission  TEXT,

  anchor       TEXT NOT NULL DEFAULT 'top-right',
  margin_top   INTEGER NOT NULL DEFAULT 24,
  margin_right INTEGER NOT NULL DEFAULT 24,

  logo_enabled     INTEGER NOT NULL DEFAULT 1,
  logo_image_url   TEXT,
  logo_width       INTEGER NOT NULL DEFAULT 90,
  logo_height      INTEGER NOT NULL DEFAULT 90,
  logo_opacity     REAL NOT NULL DEFAULT 0.95,
  logo_animation_enabled INTEGER NOT NULL DEFAULT 1,
  logo_sway_pixels REAL NOT NULL DEFAULT 2,
  logo_scale_amount REAL NOT NULL DEFAULT 0.02,
  logo_duration_seconds REAL NOT NULL DEFAULT 3,

  -- 5 quadros por segundo. Ver o comentário do campo em
  -- types/ads.ts: este número é, literalmente, o custo de rede
  -- do balanço multiplicado por quantos jogadores estão online.
  logo_fps INTEGER NOT NULL DEFAULT 5,

  panel_width  INTEGER NOT NULL DEFAULT 360,
  panel_height INTEGER NOT NULL DEFAULT 120,
  panel_color  TEXT NOT NULL DEFAULT '#0A0A0AEB',
  panel_border_color TEXT NOT NULL DEFAULT '#FFFFFF26',
  panel_border_enabled INTEGER NOT NULL DEFAULT 1,

  interval_seconds INTEGER NOT NULL DEFAULT 300,
  default_display_duration INTEGER NOT NULL DEFAULT 8,
  opening_ms   INTEGER NOT NULL DEFAULT 700,
  closing_ms   INTEGER NOT NULL DEFAULT 600,
  transition_ms INTEGER NOT NULL DEFAULT 500,
  order_mode   TEXT NOT NULL DEFAULT 'sequential'
               CHECK (order_mode IN ('sequential', 'random')),
  ads_per_cycle INTEGER NOT NULL DEFAULT 3,
  animation_fps INTEGER NOT NULL DEFAULT 15,

  image_mode  TEXT NOT NULL DEFAULT 'stored'
              CHECK (image_mode IN ('stored', 'url')),

  -- ####  O LOGO COM LUGAR PRÓPRIO  ####
  --
  -- Desligado, o logo mora no mesmo canto do painel: ele é a
  -- versão recolhida dele. Ligado, ele se solta e ganha âncora e
  -- deslocamento próprios, em qualquer um dos nove pontos da
  -- tela — que é o que permite "o logo no alto e ao centro, e o
  -- painel no canto".
  logo_detached INTEGER NOT NULL DEFAULT 0,
  logo_anchor   TEXT NOT NULL DEFAULT 'top-center',

  -- ####  AQUI ELAS SAO DESLOCAMENTO, E NAO MARGEM  ####
  --
  -- Num canto, "24" é a distância até a borda. No CENTRO não há
  -- borda de onde medir, e o mesmo número passa a significar
  -- "24 px para o lado do centro" — inclusive negativo. É por
  -- isso que não reaproveitam margin_top/margin_right.
  logo_margin_x INTEGER NOT NULL DEFAULT 0,
  logo_margin_y INTEGER NOT NULL DEFAULT 24,

  updated_at  INTEGER NOT NULL,

  PRIMARY KEY (server_id, id)
);
`;

// ------------------------------------------------------------
//  051 — a propaganda que fica parada, e o logo que se solta dela
//
//  ####  DUAS PERGUNTAS DIFERENTES, DOIS CAMPOS  ####
//
//  "ONDE aparece" já existia e é a `layer`: `Hud` fica sempre na
//  tela, `Hud.Menu` é a camada onde o Rust põe o inventário — e
//  pendurar ali faz o overlay aparecer só com o inventário
//  aberto, sem nenhum hook.
//
//  "COMO se comporta" é este campo. Desligado, o painel abre de
//  tempos em tempos, gira as campanhas e fecha. Ligado, ele é
//  desenhado UMA vez, com UMA propaganda, e fica.
//
//  Manter os dois separados é o que permite as quatro
//  combinações — inclusive um banner fixo sempre visível, e o
//  rodízio animado dentro do inventário.
//
//  ####  POR QUE UMA SO, E NAO UM RODIZIO SEM ANIMACAO  ####
//
//  Uma sessão de inventário dura segundos. Um rodízio de oito
//  segundos dentro dela quase nunca chegaria à segunda imagem —
//  e custaria um comando de RCON por troca e por grupo de
//  jogadores, para nada. O giro entre campanhas acontece entre
//  uma abertura de inventário e a seguinte.
// ------------------------------------------------------------
const ADS_STATIC_SCHEMA = `
ALTER TABLE ads_settings ADD COLUMN ads_static INTEGER NOT NULL DEFAULT 0;

-- ####  O LOGO GANHA CAMADA PROPRIA  ####
--
-- Sem esta coluna, "a propaganda so aparece com o inventario
-- aberto" levaria o LOGO junto: os dois eram pendurados na mesma
-- coluna layer (ver o parent do logo em game/ads-timeline.ts), e o
-- dono ficaria sem a marca do servidor na tela fora do menu.
--
-- NULL = herda a camada do painel, que e o que sempre aconteceu.
-- Um DEFAULT concreto aqui congelaria a escolha de quem ja tem
-- overlay configurado, e mudar o desenho de quem nao pediu e
-- pior que nao ter a opcao.
--
-- So vale com logo_detached ligado: preso ao painel, o logo e
-- filho dele e nao tem camada para chamar de sua.
ALTER TABLE ads_settings ADD COLUMN logo_layer TEXT;
`;

// ------------------------------------------------------------
//  052 — o kit deixa de ser comprado
//
//  ####  QUEM VENDE É A LOJA, E ELA TEM VITRINE PRÓPRIA  ####
//
//  Um kit nasceu com três tipos, e um deles era `compra`: preço em
//  centavos, e o jogador levava quantas vezes quisesse. Só que o que
//  se vende na rede está na LOJA (`store_offers`), com vitrine,
//  categoria e carteira. O kit com preço era uma segunda vitrine
//  escondida num formulário — e duas vitrines discordam no primeiro
//  ajuste de preço.
//
//  ####  O QUE ERA COMPRA VIRA RESGATE ÚNICO  ####
//
//  E não cooldown curto: um kit que era PAGO virando ilimitado e de
//  graça é o pior desfecho possível para quem já pagou. Resgate
//  único é o mais restritivo dos dois que sobraram, e é o que dá
//  para desfazer com uma edição.
//
//  ####  O `CHECK` ANTIGO FICA, E ISSO É DELIBERADO  ####
//
//  Tirar `'compra'` da lista exigiria recriar a tabela `kits` — e
//  `DROP TABLE` aqui levaria `kit_claims` e `kit_servers` junto,
//  pela cascata. O histórico de resgates vale mais do que a beleza
//  do `CHECK`. Quem recusa o valor hoje é a rota (`http/routes/kits`
//  não tem mais o enum) e a leitura (`toRecord` devolve `resgate`).
//
//  A coluna do preço, essa sai: ela não está em índice nem em
//  restrição, e `DROP COLUMN` não dispara cascata nenhuma.
// ------------------------------------------------------------
const KIT_SEM_COMPRA_SCHEMA = `
UPDATE kits SET kind = 'resgate' WHERE kind = 'compra';

ALTER TABLE kits DROP COLUMN price_cents;
`;

// ------------------------------------------------------------
//  053 — o kit exclusivo de UM nível de VIP
//
//  ####  "OU MAIS ALTO" NÃO SERVE PARA TODO KIT  ####
//
//  `required_tier` sempre significou "aquele nível, ou um acima" —
//  o que é certo para um benefício acumulativo, e errado para o kit
//  que É a recompensa daquele nível. Sem esta coluna, o kit do Ouro
//  também cai na mão do Diamante, e o do Bronze cai na de todo
//  mundo — e aí o Bronze deixa de ter algo que só ele tem.
//
//  Ligado, o nível vira igualdade pura: só quem tem AQUELE tier
//  ativo pega, e quem está acima não pega o kit de baixo.
//
//  ####  DESLIGADO POR PADRÃO, PORQUE É O QUE JÁ VALIA  ####
//
//  Todo kit que existe hoje foi configurado esperando "ou mais
//  alto". Um DEFAULT 1 mudaria a regra de quem não pediu — e o
//  sintoma seria o VIP mais caro perdendo kits da noite para o dia.
//
//  Sem `required_tier`, a coluna não tem efeito: ver `toColumns` em
//  db/kits-repository.ts, que a zera junto.
// ------------------------------------------------------------
const KIT_TIER_EXCLUSIVO_SCHEMA = `
ALTER TABLE kits ADD COLUMN required_tier_exact INTEGER NOT NULL DEFAULT 0;
`;

// ------------------------------------------------------------
//  054 — o kit com N usos, e o que o wipe faz com a conta
//
//  ####  "RESGATE ÚNICO" SEMPRE FOI UM LIMITE DE 1  ####
//
//  Um kit de 10 usos não é um tipo novo de kit: é o mesmo resgate,
//  com outro número. Por isso `use_limit` entra como COLUNA e não
//  como um quarto `kind` — e por isso a migração preenche 1 em todo
//  kit de resgate que já existe, que é exatamente o que ele sempre
//  significou.
//
//  (O `CHECK` do `kind` também não aceitaria um valor novo sem
//  recriar a tabela, e recriar levaria `kit_claims` junto pela
//  cascata. Mas mesmo sem esse detalhe o desenho seria este.)
//
//  ####  A CONTA É CALCULADA, NUNCA GUARDADA  ####
//
//  Não existe `uses_left`. "Quantos ele já gastou?" é
//  `count(kit_claims WHERE status = 'entregue' AND claimed_at >= X)`
//  — e o X é o que esta migração acrescenta. Um contador guardado
//  seria um segundo lugar para a mesma verdade, e ele erraria no dia
//  em que alguém mudasse o limite do kit.
//
//  ####  E O X VEM DO RESET  ####
//
//      never       X = 0. O gasto vale para sempre.
//      wipe        X = a hora do último wipe DAQUELE servidor, que
//                  quem sabe é ele (`SaveCreatedTime`).
//      full-wipe   X = a hora do último full wipe conduzido pelo
//                  agente (`wipe_runs.full_wipe = 1`).
//
//  Sem saber a hora (servidor mudo, nenhum full wipe registrado), a
//  janela cai para "desde sempre" — o kit NÃO reseta. É o oposto da
//  escolha do bloqueio pós-wipe, e de propósito: lá a dúvida libera
//  o kit uma vez, aqui ela daria usos infinitos.
// ------------------------------------------------------------
const KIT_USE_LIMIT_SCHEMA = `
ALTER TABLE kits ADD COLUMN use_limit INTEGER;
ALTER TABLE kits ADD COLUMN use_reset_on TEXT NOT NULL DEFAULT 'never';

-- O que já existe continua valendo o que valia: uma vez por
-- jogador, para sempre.
UPDATE kits SET use_limit = 1 WHERE kind = 'resgate';
`;

// ------------------------------------------------------------
//  057 a 060 — O ORIGEMZEVENTS E A MASMORRA
//
//  Quatro migrações, uma por assunto, para que uma delas poder ser
//  adiada não trave as outras. É a divisão do OrigemZQuests, pela
//  mesma razão.
//
//    057  o guarda-chuva: quando nasce, onde pode, o que fala
//    058  a masmorra por dentro: receita ou planta, e as salas
//    059  o acervo de plantas, que sai do disco e vira linha
//    060  o que aconteceu: cada nascimento e cada falha
//
//  ####  POR QUE `world_` NA FRENTE DE TUDO  ####
//
//  Porque `events` JÁ EXISTE, e é outra coisa: a migração 027 a
//  criou para o CALENDÁRIO — "Raid Night, sábado às 20h", com
//  `starts_at`, `image_url` e o que o jogador lê na grade.
//
//  As duas são "evento" em português e não têm nada em comum. A do
//  calendário é uma DATA que alguém anunciou; estas são coisas que
//  NASCEM no mapa, com posição, dono e destroços. Reaproveitar a
//  primeira faria a grade do wipe listar masmorras, e o agendador
//  tentar erguer uma Raid Night.
//
//  `world_` é o prefixo porque é o que as separa: estas nascem no
//  mundo.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §6.
// ------------------------------------------------------------

const EVENTS_CORE_SCHEMA = `
-- ============================================================
--  057  world_events  -  o guarda-chuva de tudo que NASCE no mapa.
--
--  ####  POR QUE ELE EXISTE ANTES DE HAVER DOIS EVENTOS  ####
--
--  A masmorra é o primeiro inquilino, e sozinha ela não justifica
--  uma camada. O que justifica é o SEGUNDO: agenda, marcador,
--  anúncio, dono, time e zona proibida são os mesmos para qualquer
--  coisa que nasça no mundo e morra depois. Descobrir isso quando
--  o convoy chegar significa reescrever a masmorra inteira.
--
--  O que é DAQUI: quando nasce, onde pode nascer, o que fala, quem
--  entra, quanto dura.
--  O que é da masmorra: geometria, salas, alçapão, radiação.
-- ============================================================

CREATE TABLE world_events (
  -- Slug. É o que o comando de console leva e o que a URL guarda.
  id TEXT PRIMARY KEY,

  -- 'dungeon' hoje. TEXTO LIVRE de propósito, como quests.category:
  -- um evento novo não pode custar uma migração.
  kind TEXT NOT NULL DEFAULT 'dungeon',

  name TEXT NOT NULL,
  description TEXT,

  -- 0 = cadastrado mas fora do ar. Apagar perderia o histórico de
  -- event_runs; a mesma escolha do server_plugins.enabled (002).
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0,

  -- ####  COMO ELE NASCE  ####
  --   'schedule'  — o agendador sorteia dentro da janela
  --   'manual'    — só por comando ou botão do painel
  --   'permanent' — plantado à mão, fica até o wipe
  spawn_mode TEXT NOT NULL DEFAULT 'schedule'
    CHECK (spawn_mode IN ('schedule','manual','permanent')),

  -- A janela do sorteio, em segundos. Herda o desenho do 1.3.4:
  -- sorteia um número entre os dois e conta.
  interval_min INTEGER NOT NULL DEFAULT 3600,
  interval_max INTEGER NOT NULL DEFAULT 7200,

  -- Quanto ele dura depois de no ar, em segundos.
  -- Inerte quando spawn_mode = 'permanent'.
  duration_min INTEGER NOT NULL DEFAULT 2000,
  duration_max INTEGER NOT NULL DEFAULT 3000,

  -- Abaixo disso o agendador ADIA em vez de nascer. Evento para
  -- ninguém é loot de graça para o primeiro que logar.
  min_online INTEGER NOT NULL DEFAULT 1,

  -- 1 = a próxima contagem só começa quando este acabar.
  -- É o 'afterTime' do 1.3.4.
  count_after_end INTEGER NOT NULL DEFAULT 0 CHECK (count_after_end IN (0, 1)),

  -- ####  QUEM ENTRA  ####
  --   'anyone' — qualquer um
  --   'owner'  — só quem chegou primeiro
  --   'team'   — o dono e o time dele
  --
  -- No modo permanente isto cai para 'anyone' na leitura: uma
  -- masmorra fixa em que só o primeiro entra é uma masmorra que
  -- ninguém visita.
  access TEXT NOT NULL DEFAULT 'team'
    CHECK (access IN ('anyone','owner','team')),

  -- Segundos que o dono pode ficar deslogado antes de perder a
  -- posse. O 1.3.4 usa 300.
  owner_grace_seconds INTEGER NOT NULL DEFAULT 300,

  -- ####  O MARCADOR NO MAPA  ####
  marker_enabled INTEGER NOT NULL DEFAULT 1 CHECK (marker_enabled IN (0, 1)),
  marker_label TEXT NOT NULL DEFAULT 'Masmorra',
  marker_color TEXT NOT NULL DEFAULT '#ff0000',
  marker_alpha REAL NOT NULL DEFAULT 0.55,
  marker_radius REAL NOT NULL DEFAULT 0.5,
  marker_show_owner INTEGER NOT NULL DEFAULT 1 CHECK (marker_show_owner IN (0, 1)),
  marker_show_time INTEGER NOT NULL DEFAULT 1 CHECK (marker_show_time IN (0, 1)),

  -- ####  O QUE ELE FALA  ####
  --
  -- NULL = a frase padrão do agente. Aceita a marcação de chat do
  -- projeto (game/chat-markup.ts), como as mensagens.
  msg_start TEXT,
  msg_location TEXT,
  msg_warning TEXT,
  msg_end TEXT,
  msg_denied TEXT,

  -- Segundos ANTES do fim em que cada coisa acontece.
  warn_before INTEGER NOT NULL DEFAULT 300,
  radiation_before INTEGER NOT NULL DEFAULT 180,
  -- Segundos DEPOIS do fim até a entrada ser destruída.
  destroy_after INTEGER NOT NULL DEFAULT 60,

  -- ####  SÓ PARA O MODO PERMANENTE  ####
  --
  -- De quanto em quanto tempo o loot volta. Uma masmorra fixa e
  -- vazia é decoração; com respawn ela vira monumento.
  -- 0 = o loot não volta.
  respawn_seconds INTEGER NOT NULL DEFAULT 3600,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_world_events_kind ON world_events (kind, enabled);

-- ----------------------------------------------------------
--  world_event_servers — onde cada evento vale.
--
--  O evento é da REDE e cada servidor liga o que quiser, igual a
--  quest_servers (046). Sem linha aqui, ele não roda em lugar
--  nenhum — o que é o estado normal de um evento recém-criado.
-- ----------------------------------------------------------
CREATE TABLE world_event_servers (
  event_id  TEXT NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, server_id)
);

CREATE INDEX idx_world_event_servers_server ON world_event_servers (server_id);

-- ----------------------------------------------------------
--  world_event_zones — onde NENHUM evento nasce.
--
--  ####  ELA É POR SERVIDOR, E NÃO DA REDE  ####
--
--  Uma zona é um lugar no mapa, e cada servidor tem o seu mapa.
--  Guardá-la na rede faria a proibição de um mundo cair no meio de
--  outro — e ninguém entenderia por que aquele canto não nasce
--  evento.
--
--  ####  E O RAIO É UMA COLUNA  ####
--
--  No 1.3.4 a zona é um Vector3 numa lista de config, com o campo
--  \`y\` SEQUESTRADO para guardar o raio. Funciona, e é ilegível:
--  quem abre o JSON vê uma altura absurda e não sabe que é um raio.
-- ----------------------------------------------------------
CREATE TABLE world_event_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,

  -- Para o admin saber por que aquela zona existe.
  label TEXT NOT NULL DEFAULT '',

  x REAL NOT NULL,
  z REAL NOT NULL,
  radius REAL NOT NULL DEFAULT 100,

  created_at INTEGER NOT NULL
);

CREATE INDEX idx_world_event_zones_server ON world_event_zones (server_id);
`;

const DUNGEONS_CORE_SCHEMA = `
-- ============================================================
--  058  dungeons  -  a masmorra por dentro.
--
--  Duas maneiras de produzir a MESMA estrutura, e daí para baixo o
--  construtor é um só:
--
--    'recipe'    parâmetros; o jogo sorteia o layout, e cada
--                nascimento sai diferente
--    'blueprint' um grid desenhado no painel; sai sempre igual
--
--  A cor da sala (verde/azul/vermelha) NÃO é decoração: ela é o
--  tier de conteúdo daquele cômodo — quantos NPCs, que loot, que
--  porta. Ver dungeon_rooms.
-- ============================================================

CREATE TABLE dungeons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,

  mode TEXT NOT NULL DEFAULT 'recipe' CHECK (mode IN ('recipe','blueprint')),

  -- ####  A ENTRADA  ####
  --
  -- A casinha da superfície: o slug de uma linha de
  -- dungeon_blueprints. NULL = a entrada mínima gerada por código
  -- (uma laje, um alçapão, uma luz) — é o que faz uma masmorra
  -- funcionar sem nenhuma planta importada.
  --
  -- Sem REFERENCES: dungeon_blueprints nasce na 059, que pode ser
  -- adiada, e uma FK para tabela inexistente derrubaria esta
  -- migração inteira. A integridade é cobrada na rota
  -- (BLUEPRINT_MISSING), que é quem sabe explicar o que faltou.
  entrance_blueprint TEXT,

  -- ####  MODO 'recipe'  ####
  size_min INTEGER NOT NULL DEFAULT 10,       -- em SALAS, não células
  size_max INTEGER NOT NULL DEFAULT 15,

  -- Pesos, não porcentagens: não precisam somar 100.
  weight_green INTEGER NOT NULL DEFAULT 60,
  weight_blue  INTEGER NOT NULL DEFAULT 30,
  weight_red   INTEGER NOT NULL DEFAULT 10,

  corridor_npc_density  INTEGER NOT NULL DEFAULT 20,
  corridor_loot_density INTEGER NOT NULL DEFAULT 10,
  -- JSON: array de prefab de caixa.
  corridor_crates TEXT NOT NULL DEFAULT '[]',

  -- ####  MODO 'blueprint'  ####
  --
  -- O grid desenhado, como JSON. NULL quando mode='recipe'.
  --
  -- Uma linha por z, do maior para o menor, com um caractere por
  -- célula: '.' vazio, '#' corredor, 'E' entrada, letra = sala.
  -- Uma masmorra de 20x20 são 400 células: como lista de objetos
  -- seriam ~20 KB e ninguém leria; como 20 strings são 400 bytes e
  -- um humano ABRE O JSON E VÊ A MASMORRA.
  grid TEXT,

  -- ####  O NPC (vale nos dois modos)  ####
  npc_health_min REAL NOT NULL DEFAULT 100,
  npc_health_max REAL NOT NULL DEFAULT 150,
  npc_damage_scale REAL NOT NULL DEFAULT 1.0,
  npc_weapons TEXT NOT NULL DEFAULT '[]',     -- JSON: shortnames
  npc_names   TEXT NOT NULL DEFAULT '[]',     -- JSON: nomes sorteados

  -- A hora do dia de quem está lá dentro, de 0 a 23.
  -- -1 = não mexe. O 1.3.4 usa 0 para deixar a masmorra escura.
  time_of_day REAL NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ----------------------------------------------------------
--  dungeon_rooms — o conteúdo, por cor ou por sala.
--
--  No modo receita são TRÊS linhas por masmorra (green/blue/red) e
--  elas descrevem uma CLASSE de sala. No modo planta é uma linha
--  por sala nomeada ('A', 'B', 'C'…) e cada uma descreve AQUELE
--  cômodo.
--
--  A mesma tabela para os dois porque a pergunta é a mesma —
--  "quantos NPCs, que loot, que porta?" —, e duplicá-la faria o
--  construtor ter dois caminhos para ler a mesma coisa.
-- ----------------------------------------------------------
CREATE TABLE dungeon_rooms (
  dungeon_id TEXT NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,

  -- 'green'|'blue'|'red' no modo receita; 'A','B','C'… no modo planta.
  room_key TEXT NOT NULL,

  color TEXT NOT NULL DEFAULT 'green' CHECK (color IN ('green','blue','red')),

  npc_min  INTEGER NOT NULL DEFAULT 0,
  npc_max  INTEGER NOT NULL DEFAULT 1,
  loot_min INTEGER NOT NULL DEFAULT 1,
  loot_max INTEGER NOT NULL DEFAULT 1,

  -- JSON: array de prefab de caixa.
  crates TEXT NOT NULL DEFAULT '[]',

  -- O que a cor SIGNIFICA no jogo: a porta que o jogador encontra.
  door TEXT NOT NULL DEFAULT 'wood' CHECK (door IN ('wood','metal','toptier')),

  -- 1 = a porta tem fechadura, e o código cai de um NPC.
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),

  PRIMARY KEY (dungeon_id, room_key)
);
`;

const DUNGEON_BLUEPRINTS_SCHEMA = `
-- ============================================================
--  059  dungeon_blueprints  -  as plantas saem do disco.
--
--  ####  O ARQUIVO DEIXA DE SER A VERDADE  ####
--
--  Até aqui uma planta era um .json em oxide/data de UM servidor,
--  copiado à mão de máquina em máquina. A partir daqui a verdade é
--  esta tabela, e o arquivo no disco é uma cópia de trabalho que o
--  agente reescreve: apagado à mão, ele volta no próximo save.
--
--  ####  E A COLUNA content GUARDA MEGABYTES  ####
--
--  A maior das sete plantas herdadas tem 584 peças e 512 KB. O
--  SQLite guarda TEXT sem teto prático, e o que NÃO cabe é o
--  console do RCON (~70 KB de frame). É por isso que a planta
--  viaja pelo disco e o comando leva só o slug.
-- ============================================================

CREATE TABLE dungeon_blueprints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,

  -- 'entrance' é colada na SUPERFÍCIE; 'base', a -90 metros.
  -- Marcar isso evita o erro que o 1.3.4 só descobre 60 segundos
  -- depois, com a casinha já de pé, no "No hatch found".
  kind TEXT NOT NULL DEFAULT 'entrance' CHECK (kind IN ('entrance','base')),

  -- O JSON inteiro, no formato do CopyPaste.
  content TEXT NOT NULL,

  -- Derivados, gravados na escrita. Sem eles a lista do painel
  -- precisaria abrir 512 KB para dizer "584 peças".
  entity_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,

  -- ####  1 = TEM MARCA DE ALÇAPÃO  ####
  --
  -- E é o campo mais importante da tabela. Sem alçapão não há
  -- masmorra, e uma planta sem ele SOBE BONITA e falha depois —
  -- que é o pior lugar para descobrir. Medido na escrita, para a
  -- rota poder recusar já no upload (BLUEPRINT_NO_HATCH).
  --
  -- A marca é uma convenção, e são duas: um floor.ladder.hatch com
  -- fechadura de código '0707', ou um planter.large com
  -- fertilizante 1 no slot 0 e 999 no slot 5.
  has_hatch INTEGER NOT NULL DEFAULT 0 CHECK (has_hatch IN (0, 1)),

  --   'builtin' — veio com o projeto (as sete herdadas)
  --   'import'  — alguém subiu um arquivo pelo painel
  --   'capture' — foi lida do mundo por /ozdungeon capturar
  origin TEXT NOT NULL DEFAULT 'import'
    CHECK (origin IN ('builtin','import','capture')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_dungeon_blueprints_kind ON dungeon_blueprints (kind);
`;

const EVENT_RUNS_SCHEMA = `
-- ============================================================
--  060  world_event_runs  -  o que aconteceu de verdade.
--
--  ####  ELA EXISTE PARA RESPONDER "POR QUE NÃO NASCEU ONTEM?"  ####
--
--  Que é a pergunta cara. Sem esta tabela, a única resposta
--  possível é "não sei" — e a causa (não tinha gente online, caiu
--  em zona proibida, a planta sumiu do disco) fica num log que já
--  rodou.
--
--  Por isso ela guarda tanto o SUCESSO quanto a FALHA, e a falha
--  com NOME: os oito motivos do §7.3 do plano são os mesmos dos
--  dois lados do fio.
-- ============================================================

CREATE TABLE world_event_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Sem REFERENCES para events: apagar um evento não pode apagar a
  -- história dele. É a mesma razão pela qual uma nota fiscal não
  -- some quando o produto sai do catálogo.
  event_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  dungeon_id TEXT,

  --  'scheduled'  esperando a hora
  --  'spawning'   mandou construir, esperando o "terminei"
  --  'active'     no ar
  --  'closing'    avisou, radiação subindo
  --  'ended'      acabou bem
  --  'failed'     não conseguiu nascer (failure_reason diz por quê)
  --  'cancelled'  o admin parou
  status TEXT NOT NULL
    CHECK (status IN ('scheduled','spawning','active','closing','ended','failed','cancelled')),

  -- Um dos oito códigos do contrato: no_position, no_hatch,
  -- blueprint_missing, blueprint_invalid, too_few_online,
  -- already_active, wipe_window, build_timeout.
  failure_reason TEXT,

  pos_x REAL,
  pos_z REAL,
  -- 'K7'. Guardado pronto porque quem lê a linha é gente, e
  -- recalcular a grade exige o tamanho do mundo daquele wipe.
  grid TEXT,

  -- ####  A SEMENTE, E POR QUE ELA É UMA COLUNA  ####
  --
  -- Nada da masmorra entra no save do mundo (EnableSaving(false)),
  -- então ela não sobrevive a um restart por si só: ela é
  -- RECONSTRUÍDA. Com a mesma semente, sai idêntica — e um jogador
  -- que decorou o caminho até a sala vermelha volta ao mesmo lugar.
  --
  -- Sem ela, guardar uma masmorra permanente exigiria serializar
  -- 3.000 entidades. Com ela, é um inteiro.
  seed INTEGER,

  owner_steam_id TEXT,
  entered_count INTEGER NOT NULL DEFAULT 0,

  scheduled_for INTEGER,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE INDEX idx_world_event_runs_server ON world_event_runs (server_id, status);
CREATE INDEX idx_world_event_runs_recent ON world_event_runs (started_at DESC);
CREATE INDEX idx_world_event_runs_event  ON world_event_runs (event_id, started_at DESC);

-- ----------------------------------------------------------
--  world_event_run_players — quem entrou.
--
--  É o que a ficha do jogador vai ler, do mesmo jeito que já lê as
--  quests dele. E é o que responde "eu estava lá e não levei nada".
-- ----------------------------------------------------------
CREATE TABLE world_event_run_players (
  run_id   INTEGER NOT NULL REFERENCES world_event_runs(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,

  entered_at INTEGER NOT NULL,
  -- NULL = ainda está lá dentro, ou o evento acabou com ele dentro.
  left_at INTEGER,

  died INTEGER NOT NULL DEFAULT 0 CHECK (died IN (0, 1)),

  PRIMARY KEY (run_id, steam_id)
);

CREATE INDEX idx_world_event_run_players_steam ON world_event_run_players (steam_id);
`;

const DUNGEON_LAYOUTS_SCHEMA = `
-- ============================================================
--  061  dungeon_layouts  -  o desenho vira acervo.
--
--  ####  UM DESENHO PRESO NUMA MASMORRA MORRE COM ELA  ####
--
--  Até aqui o traçado desenhado morava na coluna \`grid\` da
--  masmorra: um desenho de vinte minutos servia a uma masmorra e a
--  mais nenhuma, e a segunda começava do grid em branco outra vez.
--
--  A partir daqui ele é um objeto por si — salvo, nomeado, e ponto
--  de partida de quantas masmorras o admin quiser. A coluna
--  \`grid\` da masmorra continua existindo e continua sendo a
--  verdade do que ela constrói: carregar um traçado COPIA, e não
--  referencia. Editar a masmorra depois não pode mexer no acervo
--  pelas costas de quem salvou.
--
--  ####  POR QUE NÃO É UMA dungeon_blueprints  ####
--
--  Aquela guarda JSON do CopyPaste — uma construção literal que o
--  plugin COLA, e que o materializador escreve no disco. Isto é um
--  esquema de células que o plugin CONSTRÓI. Na mesma tabela, o
--  materializador escreveria um desenho como se fosse planta de
--  colar, e o CopyPaste não saberia ler o arquivo.
--
--  Na tela os dois aparecem juntos, porque para quem usa são
--  ambos "plantas".
-- ============================================================

CREATE TABLE dungeon_layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,

  -- JSON: array de strings, uma por fileira de z, do MAIOR para o
  -- menor (o norte em cima). Um caractere por célula: '.' vazio,
  -- '#' corredor, 'E' entrada, G/B/R a cor da sala.
  --
  -- Um desenho inteiro cabe em algumas centenas de bytes — ao
  -- contrário de uma planta do CopyPaste, que tem meio megabyte.
  -- É por isso que este vai na LISTA: a tela mostra a miniatura de
  -- cada um sem uma segunda consulta.
  grid TEXT NOT NULL,

  -- Derivados, gravados na escrita.
  cell_count INTEGER NOT NULL DEFAULT 0,
  room_count INTEGER NOT NULL DEFAULT 0,
  green_rooms INTEGER NOT NULL DEFAULT 0,
  blue_rooms INTEGER NOT NULL DEFAULT 0,
  red_rooms INTEGER NOT NULL DEFAULT 0,

  -- 1 = tem o 'E'. Sem ele o alçapão não tem onde cuspir o jogador.
  has_entrance INTEGER NOT NULL DEFAULT 0 CHECK (has_entrance IN (0, 1)),

  -- ####  QUANTOS DEFEITOS O VERIFICADOR ACHOU  ####
  --
  -- E ele é gravado em vez de recusado. Um traçado com uma sala
  -- lacrada ainda é um bom ponto de partida — o que não pode é o
  -- admin não SABER. A lista mostra o selo, e o editor mostra as
  -- frases.
  problem_count INTEGER NOT NULL DEFAULT 0,

  origin TEXT NOT NULL DEFAULT 'panel'
    CHECK (origin IN ('builtin','panel','capture')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const DUNGEON_DOORS_AND_GRADE_SCHEMA = `
-- ============================================================
--  062  o nível de construção e a fechadura saem do código.
--
--  Duas partes. A segunda é chata porque o SQLite não altera um
--  CHECK.
--
--  ####  A COLUNA door TEM UM CHECK, E ELE ENVELHECEU  ####
--
--  A 058 escreveu CHECK (door IN ('wood','metal','toptier')). O
--  catálogo cresceu de 3 para 11 portas, e o SQLite não altera
--  restrição: a tabela é renomeada, recriada, copiada e a velha
--  dropada — o mesmo caminho da 034 (site_deliveries). Por isso
--  ela vem PRIMEIRO: se algo falhar aqui, nada mais foi escrito.
--
--  Todo padrão reproduz o que o construtor cravava: 'stone' em
--  tudo, fechadura ligada com o código saindo de um NPC de
--  corredor. Masmorra existente nasce igual.
--
--  Ver Docs/OrigemZDurgeon/frentes/portas.md §B.
-- ============================================================

ALTER TABLE dungeon_rooms RENAME TO dungeon_rooms_061;

CREATE TABLE dungeon_rooms (
  dungeon_id TEXT NOT NULL REFERENCES dungeons(id) ON DELETE CASCADE,
  room_key TEXT NOT NULL,

  color TEXT NOT NULL DEFAULT 'green' CHECK (color IN ('green','blue','red')),

  npc_min  INTEGER NOT NULL DEFAULT 0,
  npc_max  INTEGER NOT NULL DEFAULT 1,
  loot_min INTEGER NOT NULL DEFAULT 1,
  loot_max INTEGER NOT NULL DEFAULT 1,

  crates TEXT NOT NULL DEFAULT '[]',

  -- Onze valores. Os quatro primeiros têm um metro de passagem e
  -- moram num wall.doorway; os seis seguintes têm dois e moram num
  -- wall.frame; 'none' é o vão aberto, de propósito.
  door TEXT NOT NULL DEFAULT 'wood' CHECK (door IN (
    'wood','metal','toptier','industrial',
    'double_wood','double_metal','double_toptier',
    'cell_gate','fence_gate','garage','none')),

  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),

  -- NULL = a sala grande usa a mesma porta das outras.
  wide_door TEXT CHECK (wide_door IS NULL OR wide_door IN (
    'wood','metal','toptier','industrial',
    'double_wood','double_metal','double_toptier',
    'cell_gate','fence_gate','garage','none')),

  -- Células POR PORTA, e não células: um salão de nove células com
  -- quatro entradas não afunila ninguém.
  wide_door_cells_per_door INTEGER NOT NULL DEFAULT 4,

  -- NULL nos três = herda o structure_* da masmorra.
  grade_foundation TEXT CHECK (grade_foundation IS NULL OR grade_foundation IN ('twigs','wood','stone','metal','toptier')),
  grade_wall       TEXT CHECK (grade_wall       IS NULL OR grade_wall       IN ('twigs','wood','stone','metal','toptier')),
  grade_ceiling    TEXT CHECK (grade_ceiling    IS NULL OR grade_ceiling    IN ('twigs','wood','stone','metal','toptier')),

  PRIMARY KEY (dungeon_id, room_key)
);

INSERT INTO dungeon_rooms
  (dungeon_id, room_key, color, npc_min, npc_max, loot_min, loot_max, crates, door, locked)
SELECT dungeon_id, room_key, color, npc_min, npc_max, loot_min, loot_max, crates, door, locked
FROM dungeon_rooms_061;

DROP TABLE dungeon_rooms_061;

-- ------------------------------------------------------------
--  E o resto é ALTER TABLE, que o SQLite faz.
-- ------------------------------------------------------------
ALTER TABLE dungeons ADD COLUMN structure_foundation TEXT NOT NULL DEFAULT 'stone';
ALTER TABLE dungeons ADD COLUMN structure_wall       TEXT NOT NULL DEFAULT 'stone';
ALTER TABLE dungeons ADD COLUMN structure_ceiling    TEXT NOT NULL DEFAULT 'stone';

ALTER TABLE dungeons ADD COLUMN lock_enabled         INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dungeons ADD COLUMN lock_shared_code     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dungeons ADD COLUMN lock_carrier         TEXT NOT NULL DEFAULT 'npc';
ALTER TABLE dungeons ADD COLUMN lock_carrier_scope   TEXT NOT NULL DEFAULT 'corridor';
ALTER TABLE dungeons ADD COLUMN lock_on_undelivered  TEXT NOT NULL DEFAULT 'unlock';

-- Anulável porque o texto padrão é do CONTRATO, e não do banco: o
-- schema Zod escreve "Código da porta" e mudá-lo um dia não pode
-- exigir uma migração para reescrever linha nenhuma.
ALTER TABLE dungeons ADD COLUMN lock_note_title      TEXT;

ALTER TABLE dungeons ADD COLUMN lock_announce_open   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dungeons ADD COLUMN lock_warn_wrong_code INTEGER NOT NULL DEFAULT 1;
`;

const DUNGEON_LOOT_TABLES_SCHEMA = `
-- ============================================================
--  063  o loot da masmorra deixa de ser o do prefab.
--
--  ####  A TABELA MORA EM COLUNA DE TEXTO  ####
--
--  É a mesma escolha de crates/weapons/names, e pela mesma razão:
--  é um objeto pequeno que ninguém consulta POR DENTRO — nenhuma
--  consulta pergunta "quais masmorras dão scrap". Normalizar
--  daria duas tabelas e um join para montar uma linha.
--
--  '{}' é a tabela padrão: mode 'server', ou seja, o Rust enche a
--  caixa e o BetterLoot continua valendo. Masmorra existente
--  nasce igual.
--
--  Ver Docs/OrigemZDurgeon/frentes/loot.md §3.
-- ============================================================

ALTER TABLE dungeon_rooms ADD COLUMN loot_table TEXT NOT NULL DEFAULT '{}';

ALTER TABLE dungeons ADD COLUMN corridor_loot_table TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dungeons ADD COLUMN npc_loot_table      TEXT NOT NULL DEFAULT '{}';

-- O ciclo do loot. Desligado é o certo no modo evento: a masmorra
-- dura menos que qualquer ciclo, e loot que volta num evento de 40
-- minutos é loot dobrado.
ALTER TABLE dungeons ADD COLUMN respawn_enabled           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dungeons ADD COLUMN respawn_minutes           INTEGER NOT NULL DEFAULT 30;
ALTER TABLE dungeons ADD COLUMN respawn_only_when_empty   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dungeons ADD COLUMN respawn_rebuild_destroyed INTEGER NOT NULL DEFAULT 1;
`;

const DUNGEON_AI_SCHEMA = `
-- ============================================================
--  064  o comportamento do inimigo sai do código.
--
--  ####  TRÊS COLUNAS DE TEXTO, E NÃO CINQUENTA E SETE  ####
--
--  O contrato da frente de IA (Docs/OrigemZDurgeon/frentes/ia.md
--  §2.1) previa uma coluna por campo, com prefixo ai_. São 19
--  campos em TRÊS lugares — o padrão da masmorra, cada cor de sala
--  e o corredor —, ou seja 57 colunas anuláveis numa tabela de
--  vinte.
--
--  Aqui elas viram JSON, pela mesma razão de crates e da tabela de
--  loot da 063: ninguém consulta um bloco de IA POR DENTRO, e o
--  único leitor é o sync, que o manda inteiro ao plugin.
--
--  ####  E O JSON GUARDA SÓ O QUE FOI DITO  ####
--
--  É o que sustenta a herança campo a campo: a sala que não fala
--  de visionRadius não tem a chave no JSON, e o plugin lê isso
--  como "não falei disso" — e não como zero. Uma coluna
--  ai_vision_radius REAL faria NULL e 0 conviverem, e o dia em que
--  alguém trocasse um pelo outro o cientista ficaria cego sem
--  ninguém pedir.
--
--  '{}' = herda tudo. Masmorra existente nasce igual.
-- ============================================================

ALTER TABLE dungeon_rooms ADD COLUMN ai TEXT NOT NULL DEFAULT '{}';

ALTER TABLE dungeons ADD COLUMN npc_ai      TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dungeons ADD COLUMN corridor_ai TEXT NOT NULL DEFAULT '{}';
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
  { id: 25, name: 'wipe-runs', sql: WIPE_RUNS_SCHEMA },
  { id: 26, name: 'messages', sql: MESSAGES_SCHEMA },
  // A 27 entra AQUI, e não no fim: o número é reservado, e a
  // ordem do array é a ordem em que o banco aplica.
  { id: 27, name: 'events', sql: EVENTS_SCHEMA },
  { id: 28, name: 'bp-snapshots', sql: BP_SNAPSHOTS_SCHEMA },
  // A 29 é da mesma frente do wipe: a decisão de mundo que a
  // retomada precisa RELER, em vez de refazer contra um `.ini`
  // que o próprio passo acabou de reescrever.
  { id: 29, name: 'wipe-run-map-decision', sql: WIPE_RUN_MAP_DECISION_SCHEMA },
  // A 30 não acrescenta schema: ela ACERTA o banco que aplicou a
  // 025 antes de a coluna `wipe_at` existir nela. Ver o cabeçalho.
  { id: 30, name: 'wipe-run-wipe-at', run: addWipeAtIfMissing },
  // A 31 também é da frente do wipe: o começo da TENTATIVA de
  // cada passo, que é o que a duração de um passo retomado
  // precisa e o `started_at` (preservado de propósito) não pode
  // dar. Ver o cabeçalho.
  { id: 31, name: 'wipe-run-step-attempt', sql: WIPE_RUN_STEP_ATTEMPT_SCHEMA },
  // A 32 não acrescenta schema nenhum: ela reescreve a ESCOLHA que
  // o admin já tinha gravado, para que o conserto do globstar não
  // valha para trás. Ver o cabeçalho.
  { id: 32, name: 'wipe-plugin-data-globstar', run: rewriteLegacyPluginDataPatterns },
  // A 033 e a 034 sao a fundacao do ranking
  // (Docs/Ranking/20-PLANO-E-CONTRATOS.md). O numero estava
  // reservado desde a 035, e elas entram AQUI, na posicao
  // numerica: a ordem do array e a ordem em que o banco aplica.
  //
  // A 033 referencia `wipes`, que nasce na 025, e `players`, que
  // nasce na 006 - as duas ja rodaram quando ela chega.
  { id: 33, name: 'rankings-core', sql: RANKINGS_CORE_SCHEMA },
  { id: 34, name: 'rankings-catalog', sql: RANKINGS_CATALOG_SCHEMA },
  // 035 e 036 sao da frente da integracao com o site OrigemZ
  // (Docs\20). A reserva das 033/034 acima foi honrada: duas
  // frentes que escrevam o mesmo numero dao merge limpo e banco
  // quebrado, porque o SQLite aplica a primeira e ignora a segunda
  // para sempre.
  //
  // A 035 RECRIA store_purchases: ela precisa rodar depois de toda
  // migracao que toque essa tabela.
  { id: 35, name: 'store-purchase-charge-unknown', sql: STORE_PURCHASE_CHARGE_UNKNOWN_SCHEMA },
  { id: 36, name: 'site-deliveries', sql: SITE_DELIVERIES_SCHEMA },
  // A 037 é da mesma frente: o dedup do COMANDO que o site
  // enfileira. Ela está reservada nos DOIS documentos — na tabela
  // do Docs\20 §15.0 e no Docs\22 —, que é o que a regra do
  // Docs\17 §0.1 exige para uma reserva valer.
  { id: 37, name: 'site-commands', sql: SITE_COMMANDS_SCHEMA },
  { id: 38, name: 'site-deliveries-vip-revoke', sql: SITE_DELIVERIES_VIP_REVOKE_SCHEMA },
  { id: 39, name: 'spawn-status-range', sql: SPAWN_STATUS_RANGE_SCHEMA },
  // A 040 recria player_events: como a 017, ela precisa rodar
  // depois de toda migração que toque essa tabela.
  { id: 40, name: 'player-events-item', sql: PLAYER_EVENTS_ITEM_SCHEMA },
  // A 041 é a frente do item custom (Docs\CustomItem). Ela precisa
  // rodar depois da 007, que cria a `items` que ela referencia.
  { id: 41, name: 'custom-items', sql: CUSTOM_ITEMS_SCHEMA },
  // A 042 acrescenta uma coluna à 041, e é uma migração própria
  // porque a 041 JÁ RODOU: o SQLite aplica cada número uma vez só,
  // e editar a de cima deixaria o banco de quem já migrou sem a
  // coluna, para sempre.
  { id: 42, name: 'custom-items-pickup', sql: CUSTOM_ITEMS_PICKUP_SCHEMA },
  // A 043 conserta a 034, que ganhou três colunas depois de já ter
  // rodado — o mesmo erro que o comentário da 042 descreve. Ela é
  // `run` porque precisa conferir antes de acrescentar: em banco
  // novo as colunas já vieram da 034.
  { id: 43, name: 'ranking-window-and-wipe-season', run: addRankingScopeColumnsIfMissing },
  // A 44 é da frente do redesenho do ranking: o nome curto da aba
  // do jogo e o interruptor que decide quem aparece nesse menu.
  // Ela é `sql` puro, e não `run`, porque nasce com o número: não
  // existe banco em que estas duas colunas já estejam.
  { id: 44, name: 'ranking-short-label', sql: RANKING_SHORT_LABEL_SCHEMA },
  // A 45 é da frente do item custom. Ela acrescenta uma coluna à
  // `items` da 007 — e é uma migração PRÓPRIA, e não uma edição
  // daquela, pela mesma razão que a 042 registra e a 043 conserta:
  // o runner aplica cada id UMA vez, e editar o SQL de uma
  // migração já aplicada deixa o banco de produção sem a coluna,
  // para sempre.
  { id: 45, name: 'items-consumable', sql: ITEMS_CONSUMABLE_SCHEMA },

  // As quests. A 046 é o sistema inteiro; a 047 é só o boneco no
  // mapa, e ela é separada para poder chegar depois — ver o
  // cabeçalho de cada uma.
  { id: 46, name: 'quests-core', sql: QUESTS_CORE_SCHEMA },
  { id: 47, name: 'quests-npc', sql: QUESTS_NPC_SCHEMA },

  // A 048 e a frente da regra de loot (Docs/CustomItem/05). Ela
  // referencia `custom_items`, que nasce na 041, e `servers`, da
  // 001 — as duas ja rodaram quando ela chega.
  //
  // O numero 046 que o estudo previa JA FOI USADO pelas quests,
  // que entraram entre a escrita daquele documento e esta
  // migracao. O runner aplica cada id UMA vez para sempre: reusar
  // o 046 daria merge limpo e banco sem estas tabelas.
  { id: 48, name: 'loot-rules', sql: LOOT_RULES_SCHEMA },

  // A 049 é do EDITOR DE LOOT (Docs/CustomItem/06). Ela acrescenta
  // uma coluna à `items` da 007 — e é uma migração própria, e não
  // uma edição da 045 que está logo ao lado, pela razão que a 042
  // registra e a 043 conserta: o runner aplica cada id UMA vez, e
  // mexer no SQL de uma migração já aplicada deixa o banco de
  // produção sem a coluna, para sempre.
  { id: 49, name: 'items-rarity', sql: ITEMS_RARITY_SCHEMA },

  // A 050 traz o OVERLAY DE PROPAGANDAS do agente antigo. O plugin
  // deste repo já sabia desenhá-lo (ver o bloco do overlay em
  // Plugins/OrigemZUI.cs); o que faltava era o lado de cá.
  //
  // Ela referencia `servers` da 001, que já rodou quando chega. O
  // ajuste e a lista são POR SERVIDOR desde o nascimento: no agente
  // antigo isso custou uma reconstrução de tabela inteira, e repetir
  // o erro barato aqui custaria a mesma reconstrução depois.
  { id: 50, name: 'ads', sql: ADS_SCHEMA },

  // A 051 é uma coluna a mais na `ads_settings` da 050 — e é uma
  // migração PRÓPRIA, e não uma edição daquela, pela razão que a
  // 042 registra e a 043 conserta: o runner aplica cada id UMA
  // vez, e mexer no SQL de uma migração já aplicada deixa o banco
  // sem a coluna, para sempre. Isto custou uma tabela em
  // 07/09/2026, no mesmo dia em que a 050 nasceu.
  { id: 51, name: 'ads-static-e-camada-do-logo', sql: ADS_STATIC_SCHEMA },
  // 07/09/2026: o kit sai da vitrine e ganha o nível exclusivo.
  { id: 52, name: 'kit-sem-compra', sql: KIT_SEM_COMPRA_SCHEMA },
  { id: 53, name: 'kit-tier-exclusivo', sql: KIT_TIER_EXCLUSIVO_SCHEMA },
  { id: 54, name: 'kit-use-limit', sql: KIT_USE_LIMIT_SCHEMA },
  // 07/09/2026: a tela do jogo para de mostrar o nome do item em
  // inglês para quem joga em português.
  { id: 55, name: 'items-display-name-ptbr', sql: ITEMS_DISPLAY_NAME_PTBR_SCHEMA },
  // 08/09/2026: com a retomada automática do boot, o cancelamento
  // do admin precisou passar a sobreviver ao reinício do agente.
  { id: 56, name: 'wipe-run-cancel-requested', sql: WIPE_RUN_CANCEL_REQUESTED_SCHEMA },
  // 08/09/2026: o OrigemZEvents e a masmorra. `world_` porque
  // `events` já é o calendário (027) — ver o cabeçalho delas.
  { id: 57, name: 'world-events-core', sql: EVENTS_CORE_SCHEMA },
  { id: 58, name: 'dungeons-core', sql: DUNGEONS_CORE_SCHEMA },
  { id: 59, name: 'dungeon-blueprints', sql: DUNGEON_BLUEPRINTS_SCHEMA },
  { id: 60, name: 'world-event-runs', sql: EVENT_RUNS_SCHEMA },
  { id: 61, name: 'dungeon-layouts', sql: DUNGEON_LAYOUTS_SCHEMA },
  // 09/09/2026: as três frentes do OrigemZDungeon (portas, loot e
  // IA) entregaram comportamento no plugin com os campos cravados
  // no C#. Estas três migrações são o que faz o admin conseguir
  // mudá-los — sem elas, o painel não tem onde gravar.
  //
  // A 062 vem primeiro porque RECRIA `dungeon_rooms` (o CHECK de
  // `door` não se altera no SQLite); as duas seguintes só
  // acrescentam colunas a ela.
  { id: 62, name: 'dungeon-doors-and-grade', sql: DUNGEON_DOORS_AND_GRADE_SCHEMA },
  { id: 63, name: 'dungeon-loot-tables', sql: DUNGEON_LOOT_TABLES_SCHEMA },
  { id: 64, name: 'dungeon-ai', sql: DUNGEON_AI_SCHEMA },
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
      applyMigration(db, migration, logger);
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
