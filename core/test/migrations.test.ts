// ============================================================
//  migrations.test.ts  -  o banco que JÁ EXISTE continua servindo.
//
//  ####  POR QUE ISTO PRECISA DE TESTE  ####
//
//  Uma migração roda UMA vez, na máquina de quem já está de pé, sem
//  ninguém olhando. Se ela perder uma linha, o sintoma aparece
//  depois — um plugin que sumiu da tela, um servidor que "nunca
//  teve" aquele plugin ligado — e a essa altura o banco de antes
//  não existe mais para comparar.
//
//  A 003 é o caso agudo: ela RECRIA as duas tabelas da 002 para que
//  o nome do plugin deixe de ser a chave. Recriar tabela com
//  `INSERT ... SELECT` é onde se perde dado em silêncio.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';

/**
 * Um banco parado na migração `upTo`.
 *
 * Aplica os passos à mão, do mesmo jeito que `runMigrations` faria,
 * e registra cada um em `schema_migrations` — é esse registro que
 * faz a chamada seguinte pular o que já foi.
 */
function databaseAt(upTo: number): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  for (const migration of MIGRATIONS.filter((item) => item.id <= upTo)) {
    applyMigration(db, migration);
    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @applied_at)',
    ).run({ id: migration.id, name: migration.name, applied_at: 1_760_000_000_000 });
  }

  return db;
}

describe('runMigrations', () => {
  it('num banco novo aplica tudo, e a segunda chamada não faz nada', () => {
    const db = openDatabase({ file: MEMORY_DATABASE });

    expect(runMigrations(db)).toHaveLength(MIGRATIONS.length);
    // A propriedade que permite chamá-la sempre no boot, sem
    // ninguém precisar saber se o banco é novo ou velho.
    expect(runMigrations(db)).toHaveLength(0);

    db.close();
  });
});

describe('003 — o plugin custom', () => {
  /** Um banco na 002, com uma biblioteca em uso. */
  function seeded(): AgentDatabase {
    const db = databaseAt(2);

    db.prepare(
      `INSERT INTO servers
         (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
          rcon_host, rcon_password, install_dir, created_at, updated_at)
       VALUES
         ('pvp1', 'PVP 1', 'pvp1', 1, 28015, 28016, 28017, 28082,
          '127.0.0.1', '', 'F:\\Servers\\pvp1', 1760000000000, 1760000000000)`,
    ).run();

    db.prepare(
      `INSERT INTO plugins
         (name, file, title, author, version, description, bytes, sha256, added_at, updated_at)
       VALUES
         ('Kits', 'Kits.cs', 'Kits', 'Autor', '4.0.1', NULL, 18432, 'abc123',
          1760000000000, 1760000000000)`,
    ).run();

    db.prepare(
      `INSERT INTO server_plugins (server_id, plugin_name, enabled, applied_sha, applied_at)
       VALUES ('pvp1', 'Kits', 1, 'abc123', 1760000100000)`,
    ).run();

    return db;
  }

  it('preserva o plugin da biblioteca, agora sem dono', () => {
    const db = seeded();

    // Tudo o que faltava a partir da 002 é aplicado de uma vez.
    //
    // A lista sai do próprio `MIGRATIONS`, e não escrita à mão:
    // fixada em `[3, 4]`, esta linha quebraria a cada migração nova
    // — e o que ela existe para provar não é QUANTAS migrações há,
    // é que a 003 recria as tabelas sem perder dado.
    expect(runMigrations(db).map((migration) => migration.id)).toEqual(
      MIGRATIONS.filter((migration) => migration.id > 2).map((migration) => migration.id),
    );

    const plugin = db.prepare('SELECT * FROM plugins').get() as {
      id: number;
      name: string;
      server_id: string | null;
      version: string;
      added_at: number;
    };

    expect(plugin.name).toBe('Kits');
    // `server_id` nulo = da biblioteca. Tudo o que existia antes da
    // 003 era de rede, por definição: o custom nasce com ela.
    expect(plugin.server_id).toBeNull();
    expect(plugin.version).toBe('4.0.1');
    // A data de entrada sobrevive: ela não é a data da migração.
    expect(plugin.added_at).toBe(1_760_000_000_000);

    db.close();
  });

  it('preserva o que cada servidor tinha ligado, religado ao novo id', () => {
    const db = seeded();

    runMigrations(db);

    const row = db.prepare('SELECT * FROM server_plugins').get() as {
      server_id: string;
      plugin_id: number;
      enabled: number;
      applied_sha: string;
    };

    const plugin = db.prepare('SELECT id FROM plugins').get() as { id: number };

    expect(row.server_id).toBe('pvp1');
    // A ligação passou a ser por id — e aponta para a linha certa.
    expect(row.plugin_id).toBe(plugin.id);
    expect(row.enabled).toBe(1);
    // Sem o applied_sha, a tela perderia o "está em dia?".
    expect(row.applied_sha).toBe('abc123');

    db.close();
  });

  it('as tabelas antigas não ficam para trás', () => {
    const db = seeded();

    runMigrations(db);

    const leftovers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_002'")
      .all();

    expect(leftovers).toEqual([]);

    db.close();
  });

  it('a biblioteca continua sem aceitar dois plugins de mesmo nome', () => {
    const db = seeded();

    runMigrations(db);

    // O índice parcial `WHERE server_id IS NULL` é o que segura
    // isto: um UNIQUE(name, server_id) comum deixaria passar,
    // porque no SQLite dois NULL são distintos entre si.
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugins (name, file, server_id, bytes, sha256, added_at, updated_at)
           VALUES ('Kits', 'Kits.cs', NULL, 1, 'x', 1, 1)`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('mas aceita um custom de mesmo nome, por servidor', () => {
    const db = seeded();

    runMigrations(db);

    db.prepare(
      `INSERT INTO plugins (name, file, server_id, bytes, sha256, added_at, updated_at)
       VALUES ('Kits', 'Kits.cs', 'pvp1', 1, 'x', 1, 1)`,
    ).run();

    expect(db.prepare("SELECT COUNT(*) AS total FROM plugins WHERE name = 'Kits'").get()).toEqual({
      total: 2,
    });

    // E não dois customs iguais NO MESMO servidor.
    expect(() =>
      db
        .prepare(
          `INSERT INTO plugins (name, file, server_id, bytes, sha256, added_at, updated_at)
           VALUES ('Kits', 'Kits.cs', 'pvp1', 1, 'y', 1, 1)`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('apagar o servidor leva junto os customs dele', () => {
    const db = seeded();

    runMigrations(db);

    db.prepare(
      `INSERT INTO plugins (name, file, server_id, bytes, sha256, added_at, updated_at)
       VALUES ('MeuEvento', 'MeuEvento.cs', 'pvp1', 1, 'x', 1, 1)`,
    ).run();

    db.prepare("DELETE FROM servers WHERE id = 'pvp1'").run();

    // O custom vai embora com o dono; o da biblioteca fica.
    expect(db.prepare('SELECT name FROM plugins').all()).toEqual([{ name: 'Kits' }]);

    db.close();
  });
});

describe('038 — a fila que também revoga VIP', () => {
  /** Um banco parado na 037, com uma entrega já ACKada dentro. */
  function comEntregaAntiga(): AgentDatabase {
    const db = databaseAt(37);

    db.prepare(
      `INSERT INTO site_deliveries
         (id, server_id, steam_id, kind, payload, source_ref, state, reason,
          attempts, reserved_at, acked_at, updated_at)
       VALUES
         ('DLV-antiga', 'pvp1', '76561198000000001', 'item', '{}', 'ITM-1',
          'delivered', NULL, 1, 10, 20, 20)`,
    ).run();

    return db;
  }

  it('preserva o comprovante das entregas que já existiam', () => {
    // A tabela é RECRIADA para trocar o CHECK, e recriar tabela com
    // INSERT ... SELECT é onde se perde dado em silêncio. Estas
    // linhas são a resposta de "o site diz que entregou; entregou
    // mesmo?", que chega meses depois.
    const db = comEntregaAntiga();

    runMigrations(db);

    expect(
      db.prepare("SELECT state, acked_at FROM site_deliveries WHERE id = 'DLV-antiga'").get(),
    ).toEqual({ state: 'delivered', acked_at: 20 });

    db.close();
  });

  it('passa a aceitar vip_revoke — e continua recusando o que não existe', () => {
    const db = comEntregaAntiga();

    runMigrations(db);

    const insert = (kind: string): void => {
      db.prepare(
        `INSERT INTO site_deliveries
           (id, server_id, steam_id, kind, payload, source_ref, state, reason,
            attempts, reserved_at, acked_at, updated_at)
         VALUES
           (@kind, 'pvp1', '76561198000000001', @kind, '{}', NULL,
            'reserved', NULL, 0, 30, NULL, 30)`,
      ).run({ kind });
    };

    expect(() => {
      insert('vip_revoke');
    }).not.toThrow();
    // O CHECK continua sendo um vocabulário fechado: um kind
    // inventado do outro lado não vira linha aqui.
    expect(() => {
      insert('vip_transfer');
    }).toThrow();

    db.close();
  });

  it('os dois índices voltam com a tabela nova', () => {
    // Eles acompanham a tabela no RENAME e morrem com ela no DROP.
    // Sem recriá-los, a pergunta do laço ("o que falta ACKar?")
    // passaria a varrer a tabela inteira, calada.
    const db = comEntregaAntiga();

    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'site_deliveries'")
      .all() as { readonly name: string }[];

    expect(indexes.map((index) => index.name).sort()).toContain('idx_site_deliveries_open');
    expect(indexes.map((index) => index.name).sort()).toContain('idx_site_deliveries_player');

    db.close();
  });
});

describe('039 — o status de nascimento vira faixa', () => {
  it('o que já estava configurado continua sendo valor EXATO', () => {
    // Uma migração que transformasse o valor antigo em piso de uma
    // faixa mudaria, calada, o que trinta jogadores recebem.
    const db = databaseAt(38);

    db.prepare(
      `INSERT INTO servers
         (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
          install_dir, created_at, updated_at)
       VALUES ('pvp1', 'PVP', 'pvp1', 1, 28015, 28016, 28017, 28082, 'C:/x', 1, 1)`,
    ).run();

    db.prepare(
      `INSERT INTO spawn_status
         (server_id, group_name, health, calories, hydration, enabled, updated_at, updated_by)
       VALUES ('pvp1', 'origemz.vip.gold', 200, 1000, 500, 1, 10, 'admin')`,
    ).run();

    runMigrations(db);

    expect(
      db
        .prepare(
          `SELECT health, calories, hydration, health_max, calories_max, hydration_max
             FROM spawn_status WHERE group_name = 'origemz.vip.gold'`,
        )
        .get(),
    ).toEqual({
      health: 200,
      calories: 1000,
      hydration: 500,
      health_max: null,
      calories_max: null,
      hydration_max: null,
    });

    db.close();
  });
});
