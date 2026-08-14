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

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'servers', sql: SERVERS_SCHEMA },
  { id: 2, name: 'plugins', sql: PLUGINS_SCHEMA },
  { id: 3, name: 'custom-plugins', sql: CUSTOM_PLUGINS_SCHEMA },
  { id: 4, name: 'plugin-dependencies', sql: PLUGIN_DEPENDENCIES_SCHEMA },
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
