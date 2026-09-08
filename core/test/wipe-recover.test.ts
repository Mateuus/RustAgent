// ============================================================
//  wipe-recover.test.ts  -  o wipe sobrevive ao reinício
//
//  O que este arquivo guarda:
//
//    1. a execução que ficou `running` de uma sessão anterior é
//       orfanada E retomada — o wipe acontece mesmo com o agente
//       tendo morrido no meio;
//    2. a linha vira `failed` ANTES da retomada: se a retomada
//       explodir, o que sobra é o estado com botão na tela, e nunca
//       uma `running` sem dono;
//    3. atraso NÃO cancela wipe: sem teto, a execução de três dias
//       atrás é retomada do mesmo jeito — e a recusa por atraso
//       continua existindo para quem passar um `maxLateMs`;
//    4. uma execução que já passou do `parar` é retomada mesmo com
//       um teto apertado: o servidor está no chão por causa dela, e
//       só o passo `subir` o traz de volta;
//    5. o cancelamento do admin sobrevive ao reinício — nem o ponto
//       sem volta o desfaz, e o carimbo guarda o PRIMEIRO clique;
//    6. servidor que o agente não cuida não é retomado;
//    7. uma operação VIVA não é tocada (o boot não é dona dela).
//
//  Banco de verdade, em memória: o `orphan()` e os passos são os
//  do repositório, e não uma imitação deles.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import {
  recoverInterruptedWipes,
  type WipeRecoveryOperations,
  type WipeRecoveryServers,
} from '../src/wipe/recover.js';

const SERVER = 'lab1';
const HOUR = 60 * 60 * 1000;

function newRuns(): WipeRunsRepository {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // A execução tem chave estrangeira para o servidor.
  new ServersRepository(db).create({
    id: SERVER,
    name: 'Lab',
    identity: SERVER,
    gamePort: 28_915,
    rconPort: 28_916,
    queryPort: 28_917,
    appPort: 28_982,
    installDir: 'C:\\nao-existe\\lab1',
  });

  return new WipeRunsRepository(db);
}

/** Um supervisor que aceita retomar e guarda o que foi pedido. */
function fakeServers(): {
  readonly servers: WipeRecoveryServers;
  readonly started: { runId: number; resume: boolean }[];
} {
  const started: { runId: number; resume: boolean }[] = [];

  return {
    started,
    servers: {
      contextOf: (id) =>
        id !== SERVER
          ? null
          : {
              operations: {
                start: async (input) => {
                  started.push({ runId: input.wipe.runId, resume: input.wipe.resume });

                  return { id: 'op_teste' };
                },
              },
            },
    },
  };
}

/** Nenhuma operação sobreviveu ao reinício — é o caso normal. */
const noOperations: WipeRecoveryOperations = { get: () => null };

describe('recoverInterruptedWipes', () => {
  it('retoma sozinha a execução que o reinício interrompeu', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      operationId: 'op_morta',
      wipeAt: now + 5 * 60_000,
    });

    runs.markStep(run.id, 'avisar', 'running');

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers,
      now: () => now,
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.outcome).toBe('resumed');

    // Foi retomada COMO retomada: sem `resume`, o passo `apagar`
    // rodaria de novo num mundo que já é o novo.
    expect(started).toEqual([{ runId: run.id, resume: true }]);
  });

  it('carimba `failed` antes de retomar, e o carimbo fica quando a retomada explode', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe', wipeAt: now });

    runs.markStep(run.id, 'avisar', 'running');

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers: {
        contextOf: () => ({
          operations: {
            start: () => Promise.reject(new Error('a trava do servidor está ocupada')),
          },
        }),
      },
      now: () => now,
    });

    expect(decisions[0]?.outcome).toBe('kept-failed');
    expect(decisions[0]?.reason).toContain('a trava do servidor está ocupada');

    // O estado que sobra é o de antes desta mudança: falhada, com o
    // botão na tela — e NUNCA uma `running` sem ninguém correndo.
    const after = runs.get(SERVER, run.id);

    expect(after?.status).toBe('failed');
    expect(after?.steps.find((s) => s.step === 'avisar')?.status).toBe('failed');
  });

  it('atraso NÃO cancela wipe: três dias depois, ele ainda acontece', async () => {
    // ####  A REGRA DO DONO, 08/09/2026  ####
    //
    // Um wipe marcado só deixa de acontecer quando o admin cancela
    // ou adia. A máquina que passou o fim de semana desligada volta
    // e cumpre o que foi anunciado no chat e no site — nenhum teto
    // de atraso decide isso por ela. É o PADRÃO que este teste
    // guarda: aqui ninguém passa `maxLateMs`.
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      wipeAt: now - 72 * HOUR,
    });

    runs.markStep(run.id, 'avisar', 'running');

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers,
      now: () => now,
    });

    expect(decisions[0]?.outcome).toBe('resumed');
    expect(started).toEqual([{ runId: run.id, resume: true }]);
  });

  it('a recusa por atraso continua disponível para quem pedir um teto', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      // A hora do wipe passou há três dias: a máquina ficou fora.
      wipeAt: now - 72 * HOUR,
    });

    runs.markStep(run.id, 'avisar', 'running');

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers,
      now: () => now,
      maxLateMs: 6 * HOUR,
    });

    expect(decisions[0]?.outcome).toBe('kept-failed');
    expect(decisions[0]?.reason).toContain('atraso demais');
    expect(started).toEqual([]);
    expect(runs.get(SERVER, run.id)?.status).toBe('failed');
  });

  it('passou do `parar`, retoma mesmo com atraso: o servidor está no chão por causa dela', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      wipeAt: now - 72 * HOUR,
    });

    // O mundo já foi apagado. Parar aqui é deixar o servidor sem
    // mundo E fora do ar — o teto não vale para este caso.
    runs.markStep(run.id, 'avisar', 'done');
    runs.markStep(run.id, 'esvaziar', 'done');
    runs.markStep(run.id, 'parar', 'done');
    runs.markStep(run.id, 'backup', 'done');
    runs.markStep(run.id, 'apagar', 'running');

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers,
      now: () => now,
      maxLateMs: 6 * HOUR,
    });

    expect(decisions[0]?.outcome).toBe('resumed');
    expect(decisions[0]?.reason).toContain('já estava parado');
    expect(started).toEqual([{ runId: run.id, resume: true }]);
  });

  it('não retoma servidor que o agente não está cuidando', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe', wipeAt: now });

    runs.markStep(run.id, 'avisar', 'running');

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers: { contextOf: () => null },
      now: () => now,
    });

    expect(decisions[0]?.outcome).toBe('kept-failed');
    expect(decisions[0]?.reason).toContain('não está cuidando');
    expect(runs.get(SERVER, run.id)?.status).toBe('failed');
  });

  // ----------------------------------------------------------
  //  O CANCELAMENTO DO ADMIN, QUE NÃO PODE SER DESFEITO POR UM
  //  REINÍCIO
  // ----------------------------------------------------------

  it('NÃO ressuscita o wipe que o admin cancelou', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      operationId: 'op_morta',
      wipeAt: now + 5 * 60_000,
    });

    runs.markStep(run.id, 'avisar', 'running');

    // O admin clicou em cancelar. Com a operação viva, quem grava o
    // desfecho é a máquina de passos — e o agente morreu antes
    // disso. A linha ficou `running`, com o pedido carimbado.
    runs.requestCancel(SERVER, run.id, now);

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers,
      now: () => now,
    });

    expect(decisions[0]?.outcome).toBe('cancelled');
    expect(started).toEqual([]);

    const after = runs.get(SERVER, run.id);

    expect(after?.status).toBe('cancelled');
    expect(after?.finishedAt).not.toBeNull();
  });

  it('cancelado continua cancelado mesmo com o mundo já apagado', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe', wipeAt: now });

    // O pior caso: o `parar` e o `apagar` já correram, e é
    // justamente a situação em que a regra do ponto sem volta manda
    // retomar SEMPRE. O cancelamento do admin vem antes dela —
    // terminar de subir um mundo novo é o que ele mandou não fazer.
    runs.markStep(run.id, 'parar', 'done');
    runs.markStep(run.id, 'apagar', 'done');
    runs.markStep(run.id, 'configurar', 'running');
    runs.requestCancel(SERVER, run.id, now);

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: noOperations,
      servers,
      now: () => now,
    });

    expect(decisions[0]?.outcome).toBe('cancelled');
    expect(started).toEqual([]);
    expect(runs.get(SERVER, run.id)?.status).toBe('cancelled');
  });

  it('o carimbo do cancelamento guarda o PRIMEIRO clique, e não o último', () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe', wipeAt: now });

    runs.requestCancel(SERVER, run.id, now);
    runs.requestCancel(SERVER, run.id, now + 60_000);

    // Um segundo clique não reescreve a hora: o que interessa é
    // quando o admin mandou parar.
    expect(runs.get(SERVER, run.id)?.cancelRequestedAt).toBe(now);
  });

  it('não encosta na execução cuja operação ainda está viva', async () => {
    const runs = newRuns();
    const now = Date.now();
    const run = runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'wipe',
      operationId: 'op_viva',
      wipeAt: now + HOUR,
    });

    runs.markStep(run.id, 'avisar', 'running');

    const { servers, started } = fakeServers();

    const decisions = await recoverInterruptedWipes({
      runs,
      operations: { get: (id) => (id === 'op_viva' ? { id } : null) },
      servers,
      now: () => now,
    });

    expect(decisions[0]?.outcome).toBe('left-running');
    expect(started).toEqual([]);
    expect(runs.get(SERVER, run.id)?.status).toBe('running');
  });
});
