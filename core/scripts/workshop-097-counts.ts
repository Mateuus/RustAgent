// ============================================================
//  workshop-097-counts.ts  -  o que a migração 097 vai fazer com os
//  acessos do Workshop, contado ANTES de ela rodar.
//
//  ####  PARA QUE ISTO EXISTE  ####
//
//  A 097 (Docs/OrigemZWorkshop/02 §4.3) converte acesso de jogador em
//  posse, expande acesso de coleção em uma posse por skin e DESCARTA
//  acesso de grupo e permissão — com registro, mas descarta. O banco
//  de produção está em outra máquina, e o dono precisa ver os números
//  antes de subir o agente novo lá.
//
//  Abre o banco SÓ PARA LEITURA: não migra, não grava, não cria nada.
//  Serve para o agente parado e para o agente rodando (WAL).
//
//  O `sqlite3` de linha de comando não está instalado nas máquinas da
//  casa; por isso é um script, e não um SELECT para colar.
//
//  Uso (da raiz do repositório):
//      npx tsx core/scripts/workshop-097-counts.ts <caminho do rustagent.db>
//
//  Sem argumento, usa `data/rustagent.db` da pasta atual.
// ============================================================

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

const file = resolve(process.argv[2] ?? 'data/rustagent.db');

if (!existsSync(file)) {
  console.error(`Banco não encontrado: ${file}`);
  process.exit(1);
}

const db = new Database(file, { readonly: true, fileMustExist: true });

const applied = db
  .prepare(`SELECT id FROM schema_migrations WHERE id IN (95, 96, 97) ORDER BY id`)
  .all() as { id: number }[];

const ids = applied.map((row) => row.id);

console.log(`Banco: ${file}`);
console.log(`Migrações do Workshop aplicadas: ${ids.length === 0 ? 'nenhuma' : ids.join(', ')}`);

if (ids.includes(97)) {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  console.log('A 097 JÁ rodou neste banco. O que ela deixou:');
  console.log(`  posses (workshop_owned_skins):          ${String(count('SELECT count(*) AS n FROM workshop_owned_skins'))}`);
  console.log(
    `  resumo gravado na migração:             ${
      (db.prepare(`SELECT detail FROM workshop_audit WHERE action = 'migration.097'`).get() as
        | { detail: string }
        | undefined)?.detail ?? '(não encontrado)'
    }`,
  );
  process.exit(0);
}

if (!ids.includes(96)) {
  console.log('A 096 não rodou: não há acessos nem coleções para converter.');
  process.exit(0);
}

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

const rows: [string, number][] = [
  ['acessos no total', count('SELECT count(*) AS n FROM workshop_grants')],
  ['acessos de GRUPO (descartados)', count(`SELECT count(*) AS n FROM workshop_grants WHERE subject_type = 'group'`)],
  ['acessos de jogador a skin', count(`SELECT count(*) AS n FROM workshop_grants WHERE subject_type = 'player' AND target_type = 'skin'`)],
  [
    'acessos de jogador a COLEÇÃO (expandidos)',
    count(`SELECT count(*) AS n FROM workshop_grants WHERE subject_type = 'player' AND target_type = 'collection'`),
  ],
  [
    'posses que a expansão gera (antes da fusão)',
    count(
      `SELECT count(*) AS n FROM workshop_grants g
         JOIN workshop_skins s ON s.collection_id = g.collection_ref
        WHERE g.subject_type = 'player' AND g.target_type = 'collection'`,
    ),
  ],
  [
    'posses finais (pares jogador+skin distintos)',
    count(
      `SELECT count(*) AS n FROM (
         SELECT subject, skin_ref FROM workshop_grants
          WHERE subject_type = 'player' AND target_type = 'skin'
         UNION
         SELECT g.subject, s.id FROM workshop_grants g
           JOIN workshop_skins s ON s.collection_id = g.collection_ref
          WHERE g.subject_type = 'player' AND g.target_type = 'collection'
       )`,
    ),
  ],
  [
    'PERMISSÕES distintas (descartadas)',
    count(
      `SELECT count(*) AS n FROM (
         SELECT trim(permission) AS p FROM workshop_skins WHERE permission IS NOT NULL AND trim(permission) <> ''
         UNION
         SELECT trim(permission) FROM workshop_collections WHERE permission IS NOT NULL AND trim(permission) <> ''
       )`,
    ),
  ],
  ['coleções (removidas)', count('SELECT count(*) AS n FROM workshop_collections')],
  [
    'skins que viram "liberada para todos" pela coleção',
    count(
      `SELECT count(*) AS n FROM workshop_skins s
         JOIN workshop_collections c ON c.id = s.collection_id
        WHERE s.open_to_all = 0 AND c.open_to_all = 1 AND c.enabled = 1`,
    ),
  ],
  ['skins no catálogo', count('SELECT count(*) AS n FROM workshop_skins')],
];

const width = Math.max(...rows.map(([label]) => label.length));

console.log('');

for (const [label, value] of rows) {
  console.log(`  ${label.padEnd(width)}  ${String(value)}`);
}

const groups = db
  .prepare(
    `SELECT subject, count(*) AS n FROM workshop_grants WHERE subject_type = 'group'
      GROUP BY subject ORDER BY n DESC, subject`,
  )
  .all() as { subject: string; n: number }[];

if (groups.length > 0) {
  console.log('\nAcessos de grupo, por grupo (quem os tinha perde o acesso):');

  for (const group of groups) console.log(`  ${group.subject}: ${String(group.n)}`);
}

db.close();
