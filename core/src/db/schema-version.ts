// ============================================================
//  schema-version.ts  -  com qual schema este binário sabe
//                        conviver.
//
//  ------------------------------------------------------------
//  O PROBLEMA QUE ISTO RESOLVE
//
//  As migrações são SÓ DE IDA (ver o cabeçalho de migrations.ts).
//  Isso deixa um caminho aberto que ninguém conferia: um agente
//  ANTIGO abrindo um banco que um agente NOVO já migrou.
//
//  Ele não falha no boot — `runMigrations` vê todos os ids que
//  conhece já registrados e não faz nada. O banco parece bom. O
//  agente sobe, atende, e quebra depois, dentro de uma consulta,
//  numa coluna que mudou de nome ou que ele não conhece. O
//  sintoma chega como um 500 no meio de uma entrega, e a causa
//  ("você voltou o binário e não voltou o banco") não aparece em
//  lugar nenhum.
//
//  Com o dono do projeto publicando releases no GitHub e o agente
//  se atualizando sozinho, voltar uma versão vira operação de
//  rotina — e é exatamente aí que este caminho passa a acontecer.
//
//  ------------------------------------------------------------
//  DUAS DECLARAÇÕES, E AS DUAS SAEM DA LISTA DE MIGRAÇÕES
//
//    targetSchema  a versão a que este binário LEVA o banco.
//    minSchema     a versão mais velha de onde ele sabe partir.
//
//  Nenhuma das duas é digitada: as duas são derivadas de
//  MIGRATIONS. Uma constante escrita à mão aqui seria mais um
//  número para manter em sincronia, e o dia em que ela ficasse
//  velha é justamente o dia em que ela precisaria estar certa.
//
//  Hoje `minSchema` é 0 porque a lista começa na 001 — ou seja,
//  este binário sabe partir até de um banco vazio. Ela existe
//  para o dia em que migrações muito antigas forem podadas da
//  lista: aí um banco parado antes do novo começo é recusado com
//  "atualize primeiro para a versão X", em vez de receber metade
//  de um schema que não bate com nada.
// ============================================================

import type { AgentDatabase } from './database.js';
import { MIGRATIONS, type Migration } from './migrations.js';

/** Chave na tabela `meta`. Ver `recordMigratedBy`. */
const MIGRATED_BY_KEY = 'schema.migrated_by';

/**
 * A versão de schema a que este binário leva o banco — o maior id
 * de MIGRATIONS.
 *
 * `Math.max` sobre a lista inteira, e não o último elemento: a
 * ordem do array é conferida em teste, mas depender dela aqui
 * faria um merge malfeito virar um alvo menor do que o schema que
 * o agente realmente aplica — o pior erro possível nesta
 * constante, porque ele ABRE a porta que ela existe para fechar.
 */
export const TARGET_SCHEMA: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.id),
  0,
);

/**
 * A versão de schema mais VELHA de onde este binário sabe partir.
 *
 * É a anterior à primeira migração que ele carrega: se a lista
 * começa na 001, ele parte do 0 (banco vazio); se um dia ela
 * começar na 021, ele passa a exigir um banco já no 20.
 */
export const MIN_SCHEMA: number = MIGRATIONS.reduce(
  (lowest, migration) => Math.min(lowest, migration.id - 1),
  TARGET_SCHEMA,
);

/** Linha da tabela de controle. */
interface AppliedMigrationRow {
  readonly id: number;
}

/** Existe mesmo essa tabela? Banco novo não tem nenhuma. */
function tableExists(db: AgentDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);

  return row !== undefined;
}

/**
 * Em que versão de schema este banco está.
 *
 * `0` para um banco que nunca foi migrado — inclusive o que
 * acabou de nascer, que é o caso normal de toda instalação nova.
 *
 * O número é o MAIOR id registrado, e não a contagem de linhas:
 * a contagem mentiria num banco que pulou um id (já aconteceu
 * aqui — ver a nota da migração 015 em migrations.ts).
 */
export function readSchemaVersion(db: AgentDatabase): number {
  if (!tableExists(db, 'schema_migrations')) {
    return 0;
  }

  const row = db.prepare('SELECT MAX(id) AS version FROM schema_migrations').get() as
    | { readonly version: number | null }
    | undefined;

  return row?.version ?? 0;
}

/**
 * O que ainda falta aplicar neste banco.
 *
 * Comparação por CONJUNTO, igual à do `runMigrations`, e não
 * "id maior que a versão atual": as duas dão o mesmo resultado
 * hoje, mas só a primeira continua certa num banco que tenha
 * pulado um id.
 *
 * Não escreve nada — nem cria `schema_migrations`. É o que
 * permite chamá-la ANTES do backup, que por sua vez tem de
 * acontecer antes da primeira escrita.
 */
export function pendingMigrations(db: AgentDatabase): readonly Migration[] {
  if (!tableExists(db, 'schema_migrations')) {
    return MIGRATIONS;
  }

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as AppliedMigrationRow[]).map(
      (row) => row.id,
    ),
  );

  return MIGRATIONS.filter((migration) => !applied.has(migration.id));
}

/**
 * A versão do agente que aplicou a última migração aqui.
 *
 * `null` quando o banco não sabe — ou porque nunca foi migrado,
 * ou porque quem o migrou foi um agente anterior a este registro.
 * As duas respostas valem a mesma coisa para quem lê: não dá para
 * dizer "volte para a versão tal" com certeza.
 */
export function readMigratedBy(db: AgentDatabase): string | null {
  if (!tableExists(db, 'meta')) {
    return null;
  }

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(MIGRATED_BY_KEY) as
    | { readonly value: string }
    | undefined;

  return row?.value ?? null;
}

/**
 * Carimba no banco quem acabou de migrá-lo.
 *
 * É o que transforma a recusa lá embaixo em instrução: sem este
 * registro, a mensagem só sabe dizer "um agente mais novo"; com
 * ele, ela diz o número da versão para onde voltar.
 *
 * Usa a tabela `meta`, que já existe desde a migração 001 e é
 * exatamente isto — chave/valor do próprio agente. Uma tabela
 * nova para guardar um texto exigiria uma migração a mais, com
 * todo o risco que este arquivo existe para reduzir.
 */
export function recordMigratedBy(db: AgentDatabase, agentVersion: string, now: number): void {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at)
     VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET
       value      = excluded.value,
       updated_at = excluded.updated_at`,
  ).run({ key: MIGRATED_BY_KEY, value: agentVersion, updated_at: now });
}

/**
 * O banco está fora do que este binário sabe atender.
 *
 * Tipo próprio para o boot conseguir separar esta recusa — que é
 * uma DECISÃO, com uma mensagem pronta para uma pessoa ler — de
 * um erro qualquer do SQLite, que vai para o log com stack.
 */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

/** O que a mensagem da recusa precisa saber além dos números. */
export interface SchemaRefusalDetails {
  /** Caminho do arquivo do banco, para a mensagem citar. */
  readonly file: string;
  /** A versão deste agente. */
  readonly agentVersion: string;
  /** Quem migrou o banco, se ele souber. Ver `readMigratedBy`. */
  readonly migratedBy: string | null;
  /** O instantâneo de antes da migração, se ele existir. */
  readonly backup: string | null;
}

/** Os três números que decidem se este binário atende este banco. */
export interface SchemaRange {
  readonly version: number;
  readonly min: number;
  readonly target: number;
}

/**
 * A recusa, em texto — ou `null` quando não há o que recusar.
 *
 * Separada da leitura do banco de propósito: é ela que carrega a
 * decisão E a instrução, e as duas precisam ser conferidas por
 * teste sem depender de existir um banco no schema 36 por aí.
 */
export function describeSchemaRefusal(
  range: SchemaRange,
  details: SchemaRefusalDetails,
): string | null {
  if (range.version > range.target) {
    return [
      `O banco em ${details.file} está no schema ${String(range.version)}, e este ` +
        `RustAgent (${details.agentVersion}) só conhece até o ${String(range.target)}.`,
      '',
      'Ele foi migrado por um agente MAIS NOVO, e as migrações não têm volta. Abrir ' +
        'assim faria este código procurar coluna que mudou de nome ou que ele nem ' +
        'conhece — e o erro apareceria depois, no meio de uma entrega, em vez de aqui.',
      '',
      'O que fazer:',
      details.migratedBy === null
        ? '  - volte para a versão do RustAgent que migrou este banco (este banco não ' +
          'registra qual foi; a partir desta versão ele registra); ou'
        : `  - volte para o RustAgent ${details.migratedBy}, que foi quem migrou este ` +
          'banco; ou',
      details.backup === null
        ? '  - restaure, por cima dele, o instantâneo tirado antes dessa migração — os ' +
          'backups ficam na pasta "backups", ao lado do banco.'
        : `  - restaure ${details.backup} por cima dele — é o instantâneo tirado ANTES ` +
          'dessa migração — e suba este agente de novo.',
    ].join('\n');
  }

  if (range.version < range.min) {
    return [
      `O banco em ${details.file} está no schema ${String(range.version)}, e este ` +
        `RustAgent (${details.agentVersion}) só sabe migrar a partir do ` +
        `${String(range.min)}.`,
      '',
      'Ele é velho demais para esta versão do agente: as migrações que fariam a ponte ' +
        'não fazem mais parte deste binário.',
      '',
      'O que fazer: instale primeiro uma versão do RustAgent que ainda conheça o schema ' +
        `${String(range.version)}, deixe-a subir uma vez (ela migra o banco) e só então ` +
        'volte para esta.',
    ].join('\n');
  }

  return null;
}

export interface SchemaGuardContext {
  /** Caminho do arquivo do banco, para a mensagem citar. */
  readonly file: string;
  /** A versão deste agente. */
  readonly agentVersion: string;
  /**
   * Onde procurar o instantâneo tirado ANTES da migração que
   * levou o banco à versão em que ele está.
   *
   * Só é chamado na recusa: no caminho normal — que é todo boot —
   * ninguém vai ao disco por causa disto.
   */
  readonly findBackup?: (schemaVersion: number) => string | null;
}

/**
 * Recusa abrir um banco que este binário não sabe atender.
 *
 * ####  ELA RECUSA ANTES DE QUALQUER ESCRITA  ####
 *
 * Chamada logo depois de abrir o banco e antes do backup e das
 * migrações. Um agente que não entende este schema não pode nem
 * tirar o instantâneo dele: o arquivo nasceria com um nome que
 * anuncia uma versão de origem errada.
 *
 * @throws {UnsupportedSchemaError} quando o schema do banco está
 * acima do que este agente conhece, ou abaixo de onde ele sabe
 * partir.
 */
export function assertSchemaSupported(db: AgentDatabase, context: SchemaGuardContext): void {
  const version = readSchemaVersion(db);

  if (version <= TARGET_SCHEMA && version >= MIN_SCHEMA) {
    return;
  }

  const refusal = describeSchemaRefusal(
    { version, min: MIN_SCHEMA, target: TARGET_SCHEMA },
    {
      file: context.file,
      agentVersion: context.agentVersion,
      migratedBy: readMigratedBy(db),
      backup: context.findBackup?.(version) ?? null,
    },
  );

  // `describeSchemaRefusal` só devolve null quando a versão está
  // dentro da faixa, e essa saída já aconteceu acima.
  if (refusal !== null) {
    throw new UnsupportedSchemaError(refusal);
  }
}
