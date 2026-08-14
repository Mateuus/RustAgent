// ============================================================
//  database.ts  -  abre o SQLite e aplica os PRAGMAs.
//
//  UM arquivo, UM processo. O banco vive em RustAgent\data\ e é
//  criado na primeira execução — não existe passo de "instalar o
//  banco" separado do subir o agente.
//
//  ------------------------------------------------------------
//  POR QUE better-sqlite3, E POR QUE SÍNCRONO
//
//  A biblioteca é síncrona: `db.prepare(...).get()` devolve a
//  linha, não uma Promise. Num servidor HTTP isso costuma soar
//  errado, então vale dizer por que aqui está certo:
//
//    - a carga é de servidor de jogo, não de e-commerce. São
//      dezenas de entregas por hora, não milhares por segundo;
//    - as consultas são por chave primária ou por índice, em
//      tabelas de milhares de linhas — dezenas de microssegundos,
//      menos do que o event loop levaria para agendar a volta de
//      uma chamada assíncrona;
//    - e o ganho é grande: a reserva da Idempotency-Key acontece
//      sem `await` nenhum no meio, ou seja, sem janela em que
//      duas requisições concorrentes escorreguem entre a
//      consulta e a inserção. Ver http/idempotency.ts.
//
//  `node:sqlite` faria o mesmo sem dependência nativa, mas exige
//  Node 22+ e o servidor roda o 20.
//
//  ------------------------------------------------------------
//  ####  ARMADILHA DE INSTALAÇÃO  ####
//
//  better-sqlite3 é módulo NATIVO: compila (ou baixa o prebuild)
//  num script de install. Desde o pnpm 10 esses scripts são
//  bloqueados por padrão, o install sai com ERR_PNPM_IGNORED_BUILDS
//  e código 1 — e como todo `pnpm <script>` refaz a checagem de
//  dependências, TODO comando do projeto passa a falhar junto.
//
//  A liberação está no `allowBuilds` de RustAgent\pnpm-workspace.yaml.
//  Se algum dia o banco parar de abrir com "invalid ELF header" ou
//  "was compiled against a different Node.js version", é dali que
//  se começa.
// ============================================================

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import type { Logger } from 'pino';

/**
 * Uma conexão aberta.
 *
 * O tipo sai do próprio construtor (`InstanceType`) em vez do
 * namespace das typings: better-sqlite3 é CommonJS com
 * `export =`, e depender de como esse namespace aparece do lado
 * do ESM é o tipo de detalhe que quebra numa atualização de
 * @types.
 */
export type AgentDatabase = InstanceType<typeof Database>;

/**
 * Caminho especial do SQLite para um banco que só existe na
 * memória do processo. É o que os testes usam: schema real,
 * consultas reais, zero arquivo em disco.
 */
export const MEMORY_DATABASE = ':memory:';

export interface OpenDatabaseOptions {
  /** Caminho do arquivo, ou MEMORY_DATABASE nos testes. */
  readonly file: string;
  readonly logger?: Logger;
}

/**
 * Abre (criando se preciso) o banco do agente.
 *
 * A pasta que contém o arquivo é criada junto: pedir ao operador
 * para criar `data\` na mão seria uma etapa a mais para esquecer,
 * e o erro do SQLite nesse caso ("unable to open database file")
 * não diz o que fazer.
 */
export function openDatabase(options: OpenDatabaseOptions): AgentDatabase {
  const inMemory = options.file === MEMORY_DATABASE;

  if (!inMemory) {
    mkdirSync(dirname(options.file), { recursive: true });
  }

  const db = new Database(options.file);

  // Uma escrita nunca deve falhar na hora por outra escrita estar
  // em curso. São 5 s de paciência antes de devolver SQLITE_BUSY —
  // muito acima de qualquer transação daqui, que dura
  // microssegundos.
  db.pragma('busy_timeout = 5000');

  // Não há FOREIGN KEY no schema hoje. Ligar assim mesmo é o
  // padrão certo: quando a primeira aparecer, ela já vai valer —
  // o SQLite ignora chaves estrangeiras em silêncio quando este
  // pragma está desligado, que é o pior jeito de descobrir.
  db.pragma('foreign_keys = ON');

  if (!inMemory) {
    // ------------------------------------------------------
    //  WAL: leitor não bloqueia escritor, escritor não bloqueia
    //  leitor.
    //
    //  É o que permite o painel listar o histórico de entregas
    //  ENQUANTO o agente grava a entrega seguinte. No journal
    //  padrão (delete) a leitura e a escrita se excluem, e uma
    //  listagem grande de /api/deliveries seguraria uma entrega.
    //
    //  Não vale para banco em memória: ali o SQLite responde
    //  "memory" e segue a vida.
    // ------------------------------------------------------
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });

    if (typeof journalMode === 'string' && journalMode.toLowerCase() !== 'wal') {
      // Acontece de verdade quando o arquivo está numa pasta de
      // rede: o WAL precisa de memória compartilhada entre
      // processos, que SMB/NFS não oferecem. O agente continua
      // funcionando, mais lento e com menos concorrência — mas
      // quem lê o log precisa saber.
      options.logger?.warn(
        { file: options.file, journalMode },
        'could not enable WAL on the sqlite file; concurrent reads and writes will block each other',
      );
    }

    // NORMAL + WAL: o commit não espera o fsync do disco a cada
    // transação. O que se perde no pior caso (queda de energia no
    // instante do commit) são os últimos milissegundos de
    // escrita; o banco NÃO corrompe. É a recomendação da própria
    // documentação do SQLite para WAL, e o custo de FULL aqui
    // seria um fsync por entrega.
    db.pragma('synchronous = NORMAL');
  }

  return db;
}
