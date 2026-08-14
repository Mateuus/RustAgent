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

export const MIGRATIONS: readonly Migration[] = [{ id: 1, name: 'servers', sql: SERVERS_SCHEMA }];

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
