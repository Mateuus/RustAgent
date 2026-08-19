// ============================================================
//  wipe-run-duracao.test.ts  -  quanto um passo de wipe levou,
//                               depois de o agente morrer e
//                               alguém retomar.
//
//  ####  O DEFEITO QUE ISTO EXISTE PARA PEGAR  ####
//
//  `markStep` preserva o `started_at` na retomada — de propósito:
//  ele responde "a que horas este wipe atacou este passo", e essa
//  pergunta é de semanas depois. Só que o par
//  `started_at`/`finished_at` era também a ÚNICA conta de duração
//  que existia, e numa retomada os dois carimbos passam a ser de
//  execuções diferentes: o começo da tentativa que MORREU e o fim
//  da que CONCLUIU.
//
//  MEDIDO na simulação (cenário D, `process.exit` no meio do
//  `apagar`): 8 arquivos apagados em 8 ms, e o banco marcando
//  20.901 ms — os 20 s em que o agente esteve morto. Retomar na
//  manhã seguinte daria um `apagar` de dez horas, e é essa a hora
//  que os testes abaixo usam.
//
//  O conserto é `attempt_started_at` (migração 031): o começo da
//  tentativa ATUAL. Ele nasce igual a `started_at` e só se afasta
//  quando o passo roda de novo — as duas perguntas, dois carimbos.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository, type WipeRunRecord } from '../src/db/wipe-runs-repository.js';
import type { WipeRunStep } from '../src/types/wipe.js';

const SERVER = 'pvp1';

/** 2026-08-19 18:43:33.891 — o horário do cenário D, em ms. */
const CRASH_COMECOU = 1_787_186_613_891;

/** Dez horas depois: o admin só viu o wipe parado na manhã seguinte. */
const RETOMADA = CRASH_COMECOU + 10 * 60 * 60 * 1000;

interface Ambiente {
  readonly db: AgentDatabase;
  readonly runs: WipeRunsRepository;
}

function ambiente(): Ambiente {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'PVP 1',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\nao-existe\\pvp1',
  });

  return { db, runs: new WipeRunsRepository(db) };
}

function passo(run: WipeRunRecord, nome: WipeRunStep) {
  const encontrado = run.steps.find((step) => step.step === nome);

  if (encontrado === undefined) {
    throw new Error(`o passo "${nome}" não está na execução`);
  }

  return encontrado;
}

/** A linha crua, sem passar pela leitura do repositório. */
function linhaCrua(
  db: AgentDatabase,
  runId: number,
  nome: WipeRunStep,
): { started_at: number | null; attempt_started_at: number | null; finished_at: number | null } {
  return db
    .prepare(
      `SELECT started_at, attempt_started_at, finished_at
         FROM wipe_run_steps WHERE run_id = @run_id AND step = @step`,
    )
    .get({ run_id: runId, step: nome }) as {
    started_at: number | null;
    attempt_started_at: number | null;
    finished_at: number | null;
  };
}

describe('a duração de um passo retomado', () => {
  it('conta a tentativa que concluiu, e não as dez horas de agente morto', () => {
    const { db, runs } = ambiente();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' }, CRASH_COMECOU);

    for (const nome of ['avisar', 'esvaziar', 'parar', 'backup'] as const) {
      runs.markStep(run.id, nome, 'done', 'concluído antes do reinício', CRASH_COMECOU);
    }

    // O `apagar` começa... e o agente morre no meio dele.
    runs.markStep(run.id, 'apagar', 'running', null, CRASH_COMECOU);

    // O boot seguinte, dez horas depois: a execução vira órfã.
    runs.orphan(SERVER, run.id, RETOMADA - 1000);

    // E a retomada roda o passo de novo — 8 arquivos, 8 ms.
    runs.markStep(run.id, 'apagar', 'running', null, RETOMADA);
    runs.markStep(run.id, 'apagar', 'done', '8 arquivo(s), 27 MB liberados.', RETOMADA + 8);

    const apagar = passo(runs.get(SERVER, run.id) as WipeRunRecord, 'apagar');

    // O propósito antigo continua de pé: `startedAt` é a PRIMEIRA
    // vez, e a retomada não o move.
    expect(apagar.startedAt).toBe(CRASH_COMECOU);

    // O novo: o começo da tentativa que produziu este `done`.
    expect(apagar.attemptStartedAt).toBe(RETOMADA);
    expect(apagar.finishedAt).toBe(RETOMADA + 8);

    // A duração que a tela mostra.
    expect((apagar.finishedAt as number) - (apagar.attemptStartedAt as number)).toBe(8);

    // E a conta velha, para deixar registrado o tamanho da mentira
    // que esta coluna evita: dez horas de agente morto.
    expect((apagar.finishedAt as number) - (apagar.startedAt as number)).toBe(
      10 * 60 * 60 * 1000 + 8,
    );

    // O mesmo, lido direto do banco: a coluna existe e é escrita.
    expect(linhaCrua(db, run.id, 'apagar')).toEqual({
      started_at: CRASH_COMECOU,
      attempt_started_at: RETOMADA,
      finished_at: RETOMADA + 8,
    });

    db.close();
  });

  it('sem retomada nenhuma, os dois começos são o mesmo instante', () => {
    const { db, runs } = ambiente();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' }, CRASH_COMECOU);

    runs.markStep(run.id, 'backup', 'running', null, CRASH_COMECOU);
    runs.markStep(run.id, 'backup', 'done', '23 arquivo(s), 44 MB.', CRASH_COMECOU + 1229);

    const backup = passo(runs.get(SERVER, run.id) as WipeRunRecord, 'backup');

    expect(backup.attemptStartedAt).toBe(backup.startedAt);
    expect((backup.finishedAt as number) - (backup.attemptStartedAt as number)).toBe(1229);

    db.close();
  });

  it('o passo que falhou guarda a duração da tentativa que falhou', () => {
    const { db, runs } = ambiente();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' }, CRASH_COMECOU);

    runs.markStep(run.id, 'apagar', 'running', null, CRASH_COMECOU);
    runs.orphan(SERVER, run.id, RETOMADA);

    // A tentativa MORTA ficou de pé as dez horas, e é isso mesmo
    // que ela mostra: o passo esteve em andamento até o agente
    // reiniciar. O que não pode é essa conta contaminar a
    // tentativa SEGUINTE.
    const morta = passo(runs.get(SERVER, run.id) as WipeRunRecord, 'apagar');

    expect(morta.status).toBe('failed');
    expect(morta.attemptStartedAt).toBe(CRASH_COMECOU);
    expect(morta.finishedAt).toBe(RETOMADA);

    runs.markStep(run.id, 'apagar', 'running', null, RETOMADA + 5000);
    runs.markStep(run.id, 'apagar', 'done', 'liberados.', RETOMADA + 5010);

    const viva = passo(runs.get(SERVER, run.id) as WipeRunRecord, 'apagar');

    expect((viva.finishedAt as number) - (viva.attemptStartedAt as number)).toBe(10);

    db.close();
  });

  it('um passo pulado não inventa começo de tentativa', () => {
    const { db, runs } = ambiente();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' }, CRASH_COMECOU);

    runs.markStep(run.id, 'esvaziar', 'skipped', 'desligado na configuração.', CRASH_COMECOU);

    const esvaziar = passo(runs.get(SERVER, run.id) as WipeRunRecord, 'esvaziar');

    expect(esvaziar.startedAt).toBeNull();
    expect(esvaziar.attemptStartedAt).toBeNull();

    db.close();
  });
});

describe('o passo `avisar`, que remarca `running` a cada aviso', () => {
  // ####  ELE ESPERA HORAS DE PROPÓSITO  ####
  //
  // `#avisar` (wipe/run.ts) chama `markStep(..., 'running', ...)`
  // a cada offset falado, só para gravar a marca dos avisos que já
  // saíram — e é isso que impede um restart de reenviar o aviso de
  // 24 h. Se o começo da tentativa fosse recarimbado a cada
  // chamada, a duração do `avisar` encolheria para o trecho depois
  // do último aviso: um aviso de 24 h viraria "3 ms".
  it('remarcar `running` não recomeça a tentativa', () => {
    const { db, runs } = ambiente();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' }, CRASH_COMECOU);

    runs.markStep(run.id, 'avisar', 'running', null, CRASH_COMECOU);
    runs.markStep(run.id, 'avisar', 'running', '1440', CRASH_COMECOU + 60_000);
    runs.markStep(run.id, 'avisar', 'running', '1440,360', CRASH_COMECOU + 64_800_000);
    runs.markStep(run.id, 'avisar', 'done', '2 aviso(s) no chat.', CRASH_COMECOU + 86_400_000);

    const avisar = passo(runs.get(SERVER, run.id) as WipeRunRecord, 'avisar');

    expect(avisar.startedAt).toBe(CRASH_COMECOU);
    expect(avisar.attemptStartedAt).toBe(CRASH_COMECOU);
    expect((avisar.finishedAt as number) - (avisar.attemptStartedAt as number)).toBe(86_400_000);

    db.close();
  });
});

describe('a migração 031 num banco que já tinha execuções gravadas', () => {
  it('a coluna chega, e o backfill é o `started_at` de cada passo', () => {
    const db = openDatabase({ file: MEMORY_DATABASE });

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    // O banco de quem já está de pé: tudo até a 030, e nada da 031.
    for (const migracao of MIGRATIONS.filter((item) => item.id <= 30)) {
      applyMigration(db, migracao);

      db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @applied_at)',
      ).run({ id: migracao.id, name: migracao.name, applied_at: CRASH_COMECOU });
    }

    expect(
      db
        .prepare(`SELECT 1 AS ok FROM pragma_table_info('wipe_run_steps') WHERE name = 'attempt_started_at'`)
        .get(),
    ).toBeUndefined();

    new ServersRepository(db).create({
      id: SERVER,
      name: 'PVP 1',
      identity: SERVER,
      gamePort: 28_015,
      rconPort: 28_016,
      queryPort: 28_017,
      appPort: 28_082,
      installDir: 'F:\\nao-existe\\pvp1',
    });

    db.prepare(
      `INSERT INTO wipe_runs
         (server_id, kind, bp_policy, full_wipe, started_at, wipe_at, status, created_at, updated_at)
       VALUES (@s, 'manual', 'keep', 0, @t, @t, 'done', @t, @t)`,
    ).run({ s: SERVER, t: CRASH_COMECOU });

    db.prepare(
      `INSERT INTO wipe_run_steps (run_id, step, position, status, started_at, finished_at)
       VALUES (1, 'apagar', 4, 'done', @inicio, @fim)`,
    ).run({ inicio: CRASH_COMECOU, fim: CRASH_COMECOU + 12 });

    runMigrations(db);

    expect(
      db
        .prepare(`SELECT 1 AS ok FROM pragma_table_info('wipe_run_steps') WHERE name = 'attempt_started_at'`)
        .get(),
    ).toBeDefined();

    const linha = linhaCrua(db, 1, 'apagar');

    // Numa linha anterior à coluna não existe outro carimbo para
    // inventar — e quem nunca foi retomado tem os dois iguais de
    // qualquer forma.
    expect(linha.attempt_started_at).toBe(CRASH_COMECOU);
    expect(linha.attempt_started_at).toBe(linha.started_at);

    db.close();
  });
});
