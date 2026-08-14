// ============================================================
//  backup.ts  -  o instantâneo do banco tirado ANTES de migrar.
//
//  ------------------------------------------------------------
//  ####  POR QUE ISTO EXISTE  ####
//
//  As migrações são só de ida: aplicada é imutável, registrada em
//  `schema_migrations`, sem reversa (ver o cabeçalho de
//  migrations.ts). Uma versão nova do agente migra no boot, e se
//  ela quebrar, voltar o binário antigo NÃO desfaz nada — sobra
//  código velho olhando para um banco novo, que é o cenário que
//  db/schema-version.ts passa a recusar.
//
//  Recusar é o certo, mas sozinho deixa o operador sem saída. A
//  saída é este arquivo: um instantâneo do banco de ANTES da
//  migração, que se restaura por cima e devolve a máquina ao
//  estado da versão anterior.
//
//  ------------------------------------------------------------
//  ####  A API DE BACKUP DO SQLITE, E NÃO COPIAR O ARQUIVO  ####
//
//  O banco roda em WAL (ver database.ts), e no WAL o `.db` NÃO é
//  o banco inteiro: as transações recentes vivem no `-wal` ao
//  lado. Copiar só o `.db` captura um estado incompleto, e copiar
//  os três (`.db`, `-wal`, `-shm`) de um banco VIVO é pior — o
//  `-shm` copiado descreve uma memória compartilhada que não
//  existe mais, e o motor ignora o WAL ao abrir. Nos dois casos o
//  arquivo resultante ABRE, o que é justamente o que faz o
//  problema passar despercebido até o dia em que ele for
//  restaurado.
//
//  `db.backup()` é a API de backup online do próprio SQLite:
//  copia página a página a partir da conexão aberta, e o que sai
//  é um banco consistente, com o WAL já incorporado. É assíncrona
//  (a única coisa assíncrona do better-sqlite3), e por isso este
//  módulo é o único do db/ que devolve Promise.
//
//  ------------------------------------------------------------
//  ONDE FICA, E QUANTOS FICAM
//
//  Em `backups\`, DENTRO da pasta do banco (`RustAgent\data\` por
//  padrão) — ou seja, ao lado do que ele protege. A pasta `data\`
//  é o que uma atualização do agente não pode tocar: qualquer
//  outro lugar (a pasta do código, um temp) desapareceria
//  exatamente na operação para a qual o backup existe.
//
//  A retenção está em RETAINED_BACKUPS, com o porquê lá.
// ============================================================

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

import { MEMORY_DATABASE, type AgentDatabase } from './database.js';
import { pendingMigrations, readSchemaVersion } from './schema-version.js';

/** Pasta dos instantâneos, dentro da pasta do banco. */
export const BACKUPS_DIRNAME = 'backups';

/** Extensão dos instantâneos — são bancos SQLite comuns. */
const BACKUP_EXTENSION = '.db';

/**
 * Quantos instantâneos ficam guardados.
 *
 * Cinco, e o número sai de para que eles servem: um backup de
 * migração é útil até se ter certeza de que a versão nova está
 * boa — dias, não meses. Cinco cobre as cinco últimas subidas de
 * schema, que é mais do que qualquer volta atrás plausível: quem
 * precisa voltar seis releases não vai voltar de banco, vai
 * reinstalar.
 *
 * O teto importa nos dois sentidos. Guardar um por migração para
 * sempre enche o disco em silêncio (cada instantâneo é do tamanho
 * do banco INTEIRO, e o histórico de entregas só cresce); guardar
 * um só deixaria a rede de proteção durar uma atualização — e
 * duas atualizações seguidas com defeito é exatamente o dia em
 * que ela precisa existir.
 */
export const RETAINED_BACKUPS = 5;

/** O que foi gravado. */
export interface MigrationBackup {
  /** Caminho absoluto do arquivo. */
  readonly path: string;
  /** Schema de onde o banco saiu. */
  readonly from: number;
  /** Schema a que a migração seguinte vai levá-lo. */
  readonly to: number;
}

/**
 * Não deu para gravar o instantâneo.
 *
 * Tipo próprio porque o tratamento é único e severo: quem chama
 * PARA O BOOT. Migrar é irreversível, e subir sem rede é a
 * decisão que custa caro — melhor um agente que não sobe, com a
 * causa escrita na tela, do que um agente que migrou e não tem
 * como voltar.
 */
export class DatabaseBackupError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = 'DatabaseBackupError';
  }
}

export interface MigrationBackupOptions {
  /** A conexão já aberta — é dela que o SQLite copia as páginas. */
  readonly db: AgentDatabase;
  /** Caminho do arquivo do banco. */
  readonly file: string;
  /** Epoch ms que entra no nome. Injetável para o teste fixar. */
  readonly now?: number;
  /** Quantos manter. Padrão: RETAINED_BACKUPS. */
  readonly retention?: number;
  readonly logger?: Logger;
}

/** A pasta dos instantâneos de um banco. */
export function backupsDirFor(file: string): string {
  return join(dirname(file), BACKUPS_DIRNAME);
}

/**
 * Grava o instantâneo, se houver migração pendente.
 *
 * Devolve `null` — sem gravar nada — em três casos, e cada um
 * tem seu porquê:
 *
 *   - **nada pendente**: é o boot normal, que acontece a cada
 *     restart do PM2. Gravar aqui encheria a pasta de cópias
 *     idênticas do mesmo banco;
 *   - **banco no schema 0**: acabou de nascer neste boot. Não há
 *     uma linha para proteger, e o arquivo que sairia daqui seria
 *     um banco vazio ocupando uma vaga da retenção;
 *   - **banco em memória**: é o dos testes. Não tem pasta onde
 *     morar, e `db.backup(':memory:')` nem é aceito.
 *
 * @throws {DatabaseBackupError} quando havia o que proteger e não
 * deu para gravar. Ver o tipo.
 */
export async function backupBeforeMigrations(
  options: MigrationBackupOptions,
): Promise<MigrationBackup | null> {
  if (options.file === MEMORY_DATABASE) {
    return null;
  }

  const pending = pendingMigrations(options.db);

  if (pending.length === 0) {
    return null;
  }

  const from = readSchemaVersion(options.db);

  if (from === 0) {
    options.logger?.info(
      { migrationsPending: pending.length },
      'skipping the pre-migration backup: this database is brand new and has nothing to restore',
    );
    return null;
  }

  const to = pending.reduce((highest, migration) => Math.max(highest, migration.id), from);
  const dir = backupsDirFor(options.file);
  const path = join(dir, backupName(options.file, from, to, options.now ?? Date.now()));

  try {
    // A API de backup do SQLite não cria a pasta de destino: ela
    // falha com "Cannot save backup because the directory does
    // not exist", que não diz o que fazer.
    mkdirSync(dir, { recursive: true });
    await options.db.backup(path);
  } catch (error) {
    // Um arquivo pela metade é pior do que nenhum: ele parece um
    // backup, e alguém o restauraria por cima do banco bom.
    //
    // A limpeza é engolida de propósito. Ela pode falhar por
    // motivo NENHUM relacionado ao problema real — quando a
    // própria pasta não pôde ser criada, o caminho aí em cima nem
    // existe — e deixar esse erro subir trocaria a mensagem que
    // explica a falha por uma que não explica nada.
    try {
      rmSync(path, { force: true });
    } catch {
      // O que importa é a recusa logo abaixo.
    }

    throw new DatabaseBackupError(
      `Não consegui gravar o backup do banco antes de migrar (${path}): ` +
        `${toError(error).message}\n\n` +
        'O agente NÃO vai migrar sem essa cópia — as migrações não têm volta, e sem ela ' +
        'uma atualização com defeito não teria como ser desfeita.\n\n' +
        'Confira se há espaço em disco e se o RustAgent pode escrever nessa pasta.',
      { cause: toError(error) },
    );
  }

  options.logger?.info(
    { path, fromSchema: from, toSchema: to, migrationsPending: pending.length },
    'wrote the pre-migration database backup',
  );

  pruneBackups(options.file, options.retention ?? RETAINED_BACKUPS, options.logger);

  return { path, from, to };
}

/**
 * O instantâneo mais recente que foi tirado antes de o banco
 * chegar ao schema `toSchema`.
 *
 * É o que a recusa do db/schema-version.ts cita para o operador:
 * "restaure este arquivo". `null` quando não há nenhum — a pasta
 * pode nem existir, num agente que nunca migrou nada.
 */
export function findMigrationBackup(file: string, toSchema: number): string | null {
  const found = listBackups(file).find((backup) => backup.to === toSchema);

  return found === undefined ? null : found.path;
}

/** Um instantâneo já gravado, com o que o nome dele conta. */
interface StoredBackup {
  readonly path: string;
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly stamp: string;
}

/**
 * Os instantâneos deste banco, do mais NOVO para o mais velho.
 *
 * A ordem sai do nome, e não da data do arquivo: `mtime` muda
 * quando alguém copia a pasta para outro disco, e uma cópia da
 * pasta de backups não pode reordenar o histórico. Como as
 * versões de schema só crescem e o carimbo de tempo é ISO com
 * campos de largura fixa, ordenar o nome ao contrário é ordenar
 * por "quando foi tirado".
 */
function listBackups(file: string): readonly StoredBackup[] {
  const dir = backupsDirFor(file);
  const base = basename(file, extname(file));

  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    // A pasta não existe: nenhum backup foi tirado ainda. É o
    // caso normal de um agente que nunca migrou nada, e não um
    // erro a propagar.
    return [];
  }

  const backups: StoredBackup[] = [];

  for (const name of names) {
    const parsed = parseBackupName(base, name);

    if (parsed !== null) {
      backups.push({ path: join(dir, name), name, ...parsed });
    }
  }

  return backups.sort((a, b) => {
    if (a.name === b.name) {
      return 0;
    }

    return a.name < b.name ? 1 : -1;
  });
}

/**
 * Apaga os que passaram da conta.
 *
 * NUNCA lança: a esta altura o instantâneo novo já está gravado,
 * que é a garantia que interessa. Uma pasta com um arquivo a mais
 * não pode impedir o agente de subir.
 */
function pruneBackups(file: string, retention: number, logger?: Logger): void {
  // Só os que ESTE módulo gravou entram na conta — é o que
  // `listBackups` já garante pelo formato do nome. A pasta é do
  // operador também, e um `rustagent-antes-do-wipe.db` copiado
  // para lá à mão não pode ser apagado pela retenção.
  //
  // O piso de 1 é o que impede uma retenção mal configurada de
  // apagar o instantâneo que ACABOU de ser gravado — o único que
  // com certeza ainda vai fazer falta.
  const excess = listBackups(file).slice(Math.max(retention, 1));

  for (const backup of excess) {
    try {
      rmSync(backup.path, { force: true });
      logger?.info({ path: backup.path, retention }, 'removed an expired database backup');
    } catch (error) {
      logger?.warn(
        { err: toError(error), path: backup.path },
        'could not remove an expired database backup; the agent is up and the backups ' +
          'folder will keep growing',
      );
    }
  }
}

/**
 * O nome do arquivo.
 *
 * Diz de onde e para onde (`035-to-036`) porque é essa a
 * pergunta de quem procura o que restaurar: "qual é o de ANTES
 * dessa migração?". O carimbo de tempo separa duas tentativas do
 * mesmo salto — que acontece quando a primeira subida falhou
 * depois do backup.
 *
 * Números com três casas para o nome ordenar igual ao número, e
 * o ISO sem `:` nem `.` porque o Windows não aceita esses dois em
 * nome de arquivo.
 */
function backupName(file: string, from: number, to: number, now: number): string {
  const base = basename(file, extname(file));
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');

  return `${base}-schema-${pad(from)}-to-${pad(to)}-${stamp}${BACKUP_EXTENSION}`;
}

function pad(version: number): string {
  return String(version).padStart(3, '0');
}

/** O contrário de `backupName`. `null` para o que não é nosso. */
function parseBackupName(
  base: string,
  name: string,
): { from: number; to: number; stamp: string } | null {
  const prefix = `${base}-schema-`;

  if (!name.startsWith(prefix) || !name.endsWith(BACKUP_EXTENSION)) {
    return null;
  }

  const middle = name.slice(prefix.length, -BACKUP_EXTENSION.length);
  const match = /^(\d{3})-to-(\d{3})-(.+)$/.exec(middle);

  if (match === null) {
    return null;
  }

  const [, from, to, stamp] = match;

  if (from === undefined || to === undefined || stamp === undefined) {
    return null;
  }

  return { from: Number(from), to: Number(to), stamp };
}
