// ============================================================
//  schema-version.test.ts  -  a trava que decide se este binário
//  pode abrir o banco.
//
//  Ela existia desde o primeiro commit e nunca era chamada. Em
//  17/09/2026 passou a ser, e passou a comparar o CONJUNTO de
//  migrações aplicadas, não só o maior id: a 097 foi aplicada
//  depois da 098 e da 099, e um agente que conhecia até a 099 subia
//  num banco que já não tinha as tabelas que ele consulta.
// ============================================================

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backupBeforeMigrations, backupsDirFor } from '../src/db/backup.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import {
  TARGET_SCHEMA,
  UnsupportedSchemaError,
  assertSchemaSupported,
  divergentMigrations,
  recordMigratedBy,
} from '../src/db/schema-version.js';

const context = { file: 'teste.db', agentVersion: '9.9.9' };

function migrated(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });
  runMigrations(db);
  return db;
}

describe('assertSchemaSupported', () => {
  it('aceita o banco novo e o banco migrado por este binário', () => {
    const fresh = openDatabase({ file: MEMORY_DATABASE });
    expect(() => assertSchemaSupported(fresh, context)).not.toThrow();

    const db = migrated();
    expect(() => assertSchemaSupported(db, context)).not.toThrow();
    expect(divergentMigrations(db)).toEqual([]);
  });

  it('recusa migração aplicada que este binário não conhece, mesmo abaixo do maior id', () => {
    const db = migrated();
    // Um id livre ABAIXO do alvo: o caso da 097 visto por um agente
    // que conhece até a 099. O maior id não denuncia nada.
    const known = new Set(MIGRATIONS.map((migration) => migration.id));
    let gap = TARGET_SCHEMA - 1;
    while (known.has(gap)) gap -= 1;
    expect(gap).toBeGreaterThan(0);

    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
      gap,
      'de-outra-branch',
      Date.now(),
    );
    recordMigratedBy(db, '1.2.3', Date.now());

    expect(() => assertSchemaSupported(db, context)).toThrow(UnsupportedSchemaError);
    expect(() => assertSchemaSupported(db, context)).toThrow(
      new RegExp(`${String(gap)} \\(de-outra-branch\\)[\\s\\S]*RustAgent 1\\.2\\.3`),
    );
  });

  it('recusa banco migrado além do que este binário conhece', () => {
    const db = migrated();
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
      TARGET_SCHEMA + 1,
      'do-futuro',
      Date.now(),
    );

    expect(() => assertSchemaSupported(db, context)).toThrow(/só conhece até o/);
  });

  it('nome diferente para o mesmo id é aviso, não recusa', () => {
    const db = migrated();
    const first = MIGRATIONS[0];
    db.prepare('UPDATE schema_migrations SET name = ? WHERE id = ?').run('nome-antigo', first.id);

    const warned: number[] = [];
    expect(() =>
      assertSchemaSupported(db, { ...context, onRenamed: (migration) => warned.push(migration.id) }),
    ).not.toThrow();
    expect(warned).toEqual([first.id]);
  });
});

describe('backupBeforeMigrations', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('grava a cópia quando há migração pendente num banco que já existe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schema-backup-'));
    dirs.push(dir);
    const file = join(dir, 'agent.db');

    const db = openDatabase({ file });
    runMigrations(db);
    // Simula um banco parado antes da última migração.
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(last.id);

    const backup = await backupBeforeMigrations({ db, file, now: 1_000 });
    db.close();

    expect(backup).not.toBeNull();
    expect(readdirSync(backupsDirFor(file))).toHaveLength(1);
  });

  it('não grava nada sem migração pendente', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schema-backup-'));
    dirs.push(dir);
    const file = join(dir, 'agent.db');

    const db = openDatabase({ file });
    runMigrations(db);

    expect(await backupBeforeMigrations({ db, file })).toBeNull();
    db.close();
  });
});
