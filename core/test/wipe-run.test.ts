// ============================================================
//  wipe-run.test.ts  -  a máquina de passos, contra disco de
//  verdade — em pastas temporárias, nunca num servidor.
//
//  ####  ESTE TESTE APAGA ARQUIVO  ####
//
//  Ele monta uma pasta de save de mentira em `os.tmpdir()`, com os
//  nomes MEDIDOS do server01, e deixa a máquina apagar. Nenhuma
//  linha daqui encosta em `Servers\`, e o `control` é falso: nada
//  para, sobe nem fala com RCON nenhum.
//
//  O que este arquivo guarda:
//
//    1. política `keep`: o mundo troca e `player.blueprints.*`
//       CONTINUA lá; política `wipe`: eles e os `-wal` somem;
//    2. o zip do backup abre — e abre pelo LEITOR DE ZIP DO
//       PRÓPRIO PROJETO, que confere CRC e tamanho de cada entrada;
//    3. matar o agente no passo `apagar` e voltar: a execução
//       aparece `failed`, e a retomada conclui SEM apagar um mundo
//       novo;
//    4. todo passo é idempotente: rodar de novo num diretório já
//       limpo é `done`, não `failed`;
//    5. `configurar` chama `updateSettings`, e nunca escreve .ini;
//    6. o passo `avisar` chama o locutor uma vez por offset, e um
//       aviso que EXPLODE não derruba o wipe;
//    7. um `apagar` com o servidor de pé é RECUSADO;
//    8. o relógio que dispara o plano vencido: ele dispara ANTES da
//       hora (pela folga dos avisos), nunca duas vezes o mesmo
//       plano, tenta de novo depois de uma recusa, e NUNCA lança.
// ============================================================

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '../src/config.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { Operation } from '../src/ops/operations.js';
import { readZipEntries, readZipEntryData } from '../src/util/zip.js';
import { backupSaveFolder, pruneBackups } from '../src/wipe/backup.js';
import {
  WipeRunner,
  type WipeAnnouncer,
  type WipeServerControl,
  type WipeServers,
} from '../src/wipe/run.js';
import { WipeScheduler, leadTimeMs } from '../src/wipe/scheduler.js';

const SERVER = 'pvp1';
const IDENTITY = 'pvp1';

/** Os nomes medidos em Servers\server01\server\server01\. */
const SAVE_FILES = [
  'proceduralmap.4000.12345.287.map',
  'proceduralmap.4000.12345.287.sav',
  'proceduralmap.4000.12345.287.sav.1',
  'proceduralmap.4000.12345.287_occlusion_3.dat',
  'player.blueprints.16.db',
  'player.blueprints.16.db-wal',
  'player.deaths.16.db',
  'player.deaths.16.db-wal',
  'player.identities.16.db',
  'player.tokens.db',
  'clans.287.db',
  'sv.files.287.db',
  'sv.files.287.db-wal',
];

const temporary: string[] = [];

afterEach(async () => {
  // Primeiro o relógio: um relógio falso vazado de um teste quebra o
  // SEGUINTE, com uma mensagem que não aponta para a causa.
  vi.useRealTimers();

  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------
//  O cenário
// ------------------------------------------------------------

interface Scenario {
  readonly db: AgentDatabase;
  readonly runs: WipeRunsRepository;
  readonly wipes: WipesRepository;
  readonly schedule: WipeScheduleRepository;
  readonly mapPool: MapPoolRepository;
  readonly runner: WipeRunner;
  readonly config: ServerConfig;
  readonly saveDir: string;
  readonly backupsDir: string;
  readonly control: WipeServerControl & { running: boolean; readonly stops: number[] };
  readonly settings: Record<string, string | number | boolean>[];
  readonly announced: number[];
}

async function scenario(
  options: {
    readonly announcer?: WipeAnnouncer;
    readonly saveCreatedAfter?: number | null;
  } = {},
): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-wipe-'));

  temporary.push(root);

  const installDir = join(root, 'servidor');
  const backupsDir = join(root, 'backups');
  const saveDir = join(installDir, 'server', IDENTITY);

  await mkdir(saveDir, { recursive: true });
  await mkdir(join(installDir, 'oxide', 'data'), { recursive: true });

  for (const name of SAVE_FILES) {
    // Conteúdo com algum tamanho: um zip de arquivos vazios não
    // prova que a compressão e o CRC estão certos.
    await writeFile(join(saveDir, name), `${name}\n`.repeat(200));
  }

  await writeFile(join(installDir, 'oxide', 'data', 'OrigemZVip.json'), '{"vip":true}');
  await writeFile(join(installDir, 'oxide', 'data', 'Economics.json'), '{"saldo":10}');

  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'PVP 1',
    identity: IDENTITY,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir,
  });

  const config = {
    id: SERVER,
    name: 'PVP 1',
    hostname: 'PVP 1',
    identity: IDENTITY,
    description: '',
    url: '',
    headerImage: '',
    level: 'Procedural Map',
    seed: 12_345,
    worldSize: 4000,
    levelUrl: '',
    maxPlayers: 200,
    saveInterval: 600,
    enabled: true,
    consoleWindow: false,
    ports: { game: 28_015, rcon: 28_016, query: 28_017, app: 28_082 },
    rcon: { host: '127.0.0.1', port: 28_016, password: 'senha' },
    steam: { appId: '258550', login: 'anonymous', branch: 'public' },
    paths: {
      configPath: join(root, 'pvp1.ini'),
      installDir,
      exePath: join(installDir, 'RustDedicated.exe'),
      oxideConfigDir: join(installDir, 'oxide', 'config'),
      pluginsDir: join(installDir, 'oxide', 'plugins'),
      logsDir: join(root, 'logs'),
      backupsDir,
    },
  } as ServerConfig;

  const settings: Record<string, string | number | boolean>[] = [];

  const servers: WipeServers = {
    configOf: () => config,
    updateSettings: (_id, patch) => {
      settings.push({ ...patch });
      return [];
    },
  };

  const stops: number[] = [];

  const control = {
    running: true,
    stops,
    isRunning: () => Promise.resolve(control.running),
    stop: (force: boolean) => {
      stops.push(force ? 1 : 0);
      control.running = false;
      return Promise.resolve();
    },
    start: () => {
      control.running = true;
      return Promise.resolve();
    },
    online: () => Promise.resolve(0),
    rconConnected: true,
  };

  const runs = new WipeRunsRepository(db);
  const wipes = new WipesRepository(db);
  const schedule = new WipeScheduleRepository(db);
  const mapPool = new MapPoolRepository(db);
  const announced: number[] = [];

  const runner = new WipeRunner({
    runs,
    wipes,
    schedule,
    mapPool,
    servers,
    world: {
      forget: () => undefined,
      saveCreatedAt: () =>
        Promise.resolve(options.saveCreatedAfter === undefined ? 2_000 : options.saveCreatedAfter),
    },
    announcer: options.announcer ?? {
      announceOffset: (input) => {
        announced.push(input.offsetMinutes);
        return Promise.resolve();
      },
    },
  });

  // Sem avisos e sem esvaziar por padrão: quem os quer, liga no
  // teste. Um `await` de vinte e quatro horas dentro de um teste
  // não é um teste.
  runs.saveExecSettings(SERVER, {
    ...runs.getExecSettings(SERVER),
    announce: { ...runs.getExecSettings(SERVER).announce, offsetsMinutes: [] },
    drain: { enabled: false, waitMinutes: 0, force: false },
  });

  return {
    db,
    runs,
    wipes,
    schedule,
    mapPool,
    runner,
    config,
    saveDir,
    backupsDir,
    control,
    settings,
    announced,
  };
}

function operation(): Operation {
  return new Operation('wipe-run', SERVER);
}

async function names(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------
//  Os testes
// ------------------------------------------------------------

describe('a política de blueprint decide o que sobrevive', () => {
  it('keep troca o mundo e MANTÉM player.blueprints.*', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    const left = await names(s.saveDir);

    expect(left).toContain('player.blueprints.16.db');
    expect(left).toContain('player.blueprints.16.db-wal');
    // O mundo, esse, foi.
    expect(left).not.toContain('proceduralmap.4000.12345.287.map');
    expect(left).not.toContain('proceduralmap.4000.12345.287.sav');
    expect(left).not.toContain('proceduralmap.4000.12345.287.sav.1');
    expect(left).not.toContain('proceduralmap.4000.12345.287_occlusion_3.dat');
  });

  it('wipe leva os blueprints E os -wal deles', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe' });

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    const left = await names(s.saveDir);

    expect(left).not.toContain('player.blueprints.16.db');
    // ####  O -wal É A METADE QUE SE ESQUECE  ####
    //
    // Sozinho, ele é um write-ahead log órfão com escritas que o
    // SQLite ainda não aplicou — e ele ressuscitaria parte do que
    // acabou de ser apagado.
    expect(left).not.toContain('player.blueprints.16.db-wal');
    // A identidade do jogador fica, em qualquer política.
    expect(left).toContain('player.identities.16.db');
  });
});

describe('a execução inteira', () => {
  it('grava os oito passos, na ordem, e termina `done`', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.status).toBe('done');
    expect(finished.steps.map((step) => step.step)).toEqual([
      'avisar',
      'esvaziar',
      'parar',
      'backup',
      'apagar',
      'configurar',
      'subir',
      'pos-wipe',
    ]);
    expect(finished.steps.every((step) => step.status === 'done')).toBe(true);
    // Cada passo diz o que fez. Um ✔ sem frase ao lado não explica
    // nada a quem abre a tela três semanas depois.
    expect(finished.steps.every((step) => (step.message ?? '').length > 5)).toBe(true);
  });

  it('para com quit (sem force) e sobe de volta', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    // `force` mata o processo e perde tudo desde o último save.
    // Ele só entra quando o operador pediu.
    expect(s.control.stops).toEqual([0]);
    expect(s.control.running).toBe(true);
  });

  it('registra o mundo detectado, com a seed nova', async () => {
    const s = await scenario({ saveCreatedAfter: 1_770_000_000_000 });
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    const detected = s.wipes.list(SERVER);

    expect(detected).toHaveLength(1);
    expect(detected[0]?.saveCreatedAt).toBe(1_770_000_000_000);
    expect(detected[0]?.wipeRunId).toBe(run.id);
    expect(detected[0]?.seed).not.toBeNull();
  });

  it('avisa quando o SaveCreatedTime NÃO mudou — o wipe pode não ter acontecido', async () => {
    // É a conferência independente, e o motivo de a tabela `wipes`
    // existir: a execução relata o que TENTOU fazer; o servidor diz
    // o que aconteceu.
    const s = await scenario({ saveCreatedAfter: 1_000 });
    const run = s.runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'keep',
      saveCreatedBefore: 1_000,
    });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    const post = finished.steps.find((step) => step.step === 'pos-wipe');

    expect(post?.status).toBe('done');
    expect(post?.message).toContain('não mudou');
  });
});

describe('o backup', () => {
  it('escreve um zip que o leitor do próprio projeto abre, com o .sav dentro', async () => {
    // ####  O LEITOR CONFERE CRC E TAMANHO DE CADA ENTRADA  ####
    //
    // Ver util/zip.ts. Um zip que "abre" mas tem bytes errados
    // passaria num teste que só olhasse a lista de nomes — e só
    // seria descoberto no dia da restauração.
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.backupPath).not.toBeNull();

    const archive = await readFile(finished.backupPath as string);
    const entries = readZipEntries(archive);
    const inside = entries.map((entry) => entry.path);

    expect(inside).toContain('proceduralmap.4000.12345.287.sav');
    expect(inside).toContain('proceduralmap.4000.12345.287.map');
    // O backup guarda TAMBÉM o que o wipe apagou: é o que faz dele
    // uma volta atrás de verdade.
    expect(inside).toContain('player.blueprints.16.db');

    const sav = entries.find((entry) => entry.path === 'proceduralmap.4000.12345.287.sav');
    const bytes = readZipEntryData(archive, sav as (typeof entries)[number]);

    expect(bytes.toString('utf8')).toBe('proceduralmap.4000.12345.287.sav\n'.repeat(200));
  });

  it('poda os antigos, mantendo os últimos', async () => {
    const s = await scenario();

    // O carimbo do nome vem do `at`, e por isso ele é injetado aqui:
    // três backups no mesmo segundo seriam o MESMO arquivo, e a poda
    // não teria o que podar.
    for (const at of [
      new Date(2026, 7, 16, 16, 0, 0).getTime(),
      new Date(2026, 7, 17, 16, 0, 0).getTime(),
      new Date(2026, 7, 18, 16, 0, 0).getTime(),
    ]) {
      await backupSaveFolder({ saveDir: s.saveDir, backupsDir: s.backupsDir, at, keep: 10 });
    }

    expect((await names(s.backupsDir)).filter((name) => name.endsWith('.zip'))).toHaveLength(3);

    const pruned = await pruneBackups(s.backupsDir, 2);

    expect(pruned).toHaveLength(1);
    expect((await names(s.backupsDir)).filter((name) => name.endsWith('.zip'))).toHaveLength(2);
  });

  it('a poda NÃO encosta no que não é dela', async () => {
    // A pasta de backups do servidor recebe também o backup do Oxide
    // (ver oxide/install.ts). Podar o que não é nosso seria apagar a
    // salvaguarda de outra operação.
    const s = await scenario();

    await mkdir(s.backupsDir, { recursive: true });
    await writeFile(join(s.backupsDir, 'oxide-2026-08-01.zip'), 'oxide');

    await backupSaveFolder({ saveDir: s.saveDir, backupsDir: s.backupsDir, keep: 1 });
    await pruneBackups(s.backupsDir, 1);

    expect(await names(s.backupsDir)).toContain('oxide-2026-08-01.zip');
  });

  it('desligado, o passo termina como `done` dizendo que não há volta', async () => {
    const s = await scenario();

    s.runs.saveExecSettings(SERVER, {
      ...s.runs.getExecSettings(SERVER),
      backup: { enabled: false, keep: 3 },
    });

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.status).toBe('done');
    expect(finished.steps.find((step) => step.step === 'backup')?.message).toContain('não tem volta');
  });
});

describe('o full wipe', () => {
  it('leva SÓ o que está marcado — o VIP pago fica', async () => {
    const s = await scenario();

    s.runs.saveExecSettings(SERVER, {
      ...s.runs.getExecSettings(SERVER),
      pluginData: { enabled: true, patterns: ['oxide/data/Economics.json'] },
    });

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep', fullWipe: true });

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    const data = await names(join(s.config.paths.installDir, 'oxide', 'data'));

    expect(data).not.toContain('Economics.json');
    // ####  O CHARGEBACK MORA AQUI  ####
    expect(data).toContain('OrigemZVip.json');
  });
});

describe('configurar', () => {
  it('chama updateSettings — e nunca escreve o .ini por conta própria', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    expect(s.settings).toHaveLength(1);
    expect(s.settings[0]).toHaveProperty('seed');
    expect(s.settings[0]).toHaveProperty('worldSize');
    // Sempre gravada, inclusive VAZIA: um procedural depois de um
    // custom precisa LIMPAR a chave, senão o servidor volta a
    // baixar o `.map` antigo e o wipe não troca mundo nenhum.
    expect(s.settings[0]).toHaveProperty('levelUrl', '');
  });

  it('fila vazia não trava o wipe: o agente sorteia, e REGISTRA que sorteou', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.drawn).toBe(true);
    expect(finished.steps.find((step) => step.step === 'configurar')?.message).toContain('SORTEOU');
  });
});

describe('a retomada', () => {
  it('o agente morre no `apagar`: a execução vira falha e a retomada conclui', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    // Simula o `pm2 restart` no meio: os passos até `backup` já
    // terminaram, e `apagar` ficou `running`.
    for (const step of ['avisar', 'esvaziar', 'parar', 'backup'] as const) {
      s.runs.markStep(run.id, step, 'done', 'concluído antes do reinício');
    }

    s.runs.markStep(run.id, 'apagar', 'running');

    const orphaned = s.runs.orphan(SERVER, run.id);

    expect(orphaned.status).toBe('failed');
    expect(orphaned.message).toContain('reiniciou');
    expect(orphaned.steps.find((step) => step.step === 'apagar')?.status).toBe('failed');

    // E agora a retomada.
    s.control.running = false;

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(finished.status).toBe('done');
    // Os passos que já tinham terminado NÃO rodaram de novo: só um
    // backup foi escrito, o do começo.
    expect(s.control.stops).toEqual([]);
    expect(await names(s.saveDir)).not.toContain('proceduralmap.4000.12345.287.map');
  });

  it('NÃO volta a `apagar` depois de `configurar` — senão apagaria o mundo NOVO', async () => {
    // ####  É A REGRA QUE PROTEGE O MUNDO RECÉM-NASCIDO  ####
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    for (const step of ['avisar', 'esvaziar', 'parar', 'backup', 'apagar', 'configurar'] as const) {
      s.runs.markStep(run.id, step, 'done', 'concluído antes do reinício');
    }

    s.runs.orphan(SERVER, run.id);

    // O mundo NOVO já está em disco.
    await writeFile(join(s.saveDir, 'proceduralmap.4000.99999.287.map'), 'mundo novo');
    await writeFile(join(s.saveDir, 'proceduralmap.4000.99999.287.sav'), 'mundo novo');

    await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    const left = await names(s.saveDir);

    expect(left).toContain('proceduralmap.4000.99999.287.map');
    expect(left).toContain('proceduralmap.4000.99999.287.sav');
    // E a fila não foi consumida uma segunda vez.
    expect(s.settings).toHaveLength(0);
  });

  it('`apagar` RECUSA com o servidor de pé', async () => {
    const s = await scenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    for (const step of ['avisar', 'esvaziar', 'parar', 'backup'] as const) {
      s.runs.markStep(run.id, step, 'done', 'ok');
    }

    // Alguém subiu o servidor à mão entre a falha e a retomada.
    s.control.running = true;

    await expect(
      s.runner.run({
        serverId: SERVER,
        runId: run.id,
        operation: operation(),
        control: s.control,
        resume: true,
      }),
    ).rejects.toThrow(/no ar/);

    // Nada foi apagado.
    expect(await names(s.saveDir)).toContain('proceduralmap.4000.12345.287.map');
    expect(s.runs.get(SERVER, run.id)?.status).toBe('failed');
  });
});

describe('a idempotência de cada passo', () => {
  it('apagar num diretório já limpo é sucesso, e não erro', async () => {
    const s = await scenario();

    for (const name of await names(s.saveDir)) {
      await rm(join(s.saveDir, name), { force: true });
    }

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'wipe' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.status).toBe('done');
    expect(finished.steps.find((step) => step.step === 'apagar')?.status).toBe('done');
  });

  it('parar um servidor já parado é sucesso', async () => {
    const s = await scenario();

    s.control.running = false;

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.steps.find((step) => step.step === 'parar')?.message).toContain('já estava');
    expect(finished.status).toBe('done');
  });
});

describe('os avisos', () => {
  it('chamam o locutor uma vez por offset ainda no futuro', async () => {
    const s = await scenario();

    s.runs.saveExecSettings(SERVER, {
      ...s.runs.getExecSettings(SERVER),
      announce: { ...s.runs.getExecSettings(SERVER).announce, offsetsMinutes: [60, 15, 5] },
    });

    // O wipe é "agora": os três offsets já venceram, e avisar
    // "faltam 60 min" para um wipe que começa neste segundo seria
    // pior que não avisar.
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep', wipeAt: Date.now() });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(s.announced).toEqual([]);
    expect(finished.steps.find((step) => step.step === 'avisar')?.status).toBe('done');
  });

  it('um aviso que EXPLODE não derruba o wipe', async () => {
    // ####  AVISO É MELHOR-ESFORÇO; APAGAR NÃO É  ####
    const s = await scenario({
      announcer: {
        announceOffset: () => Promise.reject(new Error('o RCON caiu')),
      },
    });

    s.runs.saveExecSettings(SERVER, {
      ...s.runs.getExecSettings(SERVER),
      announce: { ...s.runs.getExecSettings(SERVER).announce, offsetsMinutes: [1] },
    });

    // Um minuto no futuro, mas o relógio é falso: o passo espera
    // até a hora e o teste não fica parado esperando de verdade.
    vi.useFakeTimers();

    const run = s.runs.create(SERVER, {
      kind: 'manual',
      bpPolicy: 'keep',
      wipeAt: Date.now() + 60_000,
    });

    const promise = s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    await vi.advanceTimersByTimeAsync(90_000);

    const finished = await promise;

    vi.useRealTimers();

    expect(finished.status).toBe('done');
    expect(finished.steps.find((step) => step.step === 'avisar')?.status).toBe('done');
  });
});

// ------------------------------------------------------------
//  O RELÓGIO QUE DISPARA O PLANO VENCIDO
//
//  ####  O QUE ESTES TESTES PROTEGEM  ####
//
//  Este relógio é o que zera um servidor de madrugada sem ninguém
//  olhando. As três coisas que ele não pode fazer, e que estão
//  testadas abaixo, são: disparar o mesmo plano duas vezes,
//  desistir de um plano porque a primeira tentativa foi recusada,
//  e parar de funcionar em silêncio por causa de uma exceção.
// ------------------------------------------------------------

describe('o relógio do wipe', () => {
  /** Um agendador com um lançador que só ANOTA o que foi pedido. */
  function schedulerFor(
    s: Scenario,
    options: { readonly fail?: boolean; readonly servers?: () => readonly string[] } = {},
  ): { readonly clock: WipeScheduler; readonly launched: number[] } {
    const launched: number[] = [];

    const clock = new WipeScheduler({
      schedule: s.schedule,
      runs: s.runs,
      servers: options.servers ?? (() => [SERVER]),
      launcher: {
        launch: ({ planId }) => {
          if (options.fail === true) {
            return Promise.reject(new Error('o servidor está instalando agora'));
          }

          launched.push(planId);
          return Promise.resolve();
        },
      },
    });

    return { clock, launched };
  }

  it('dispara o plano ANTES da hora, com a folga dos avisos', async () => {
    // Um wipe às 16:00 com aviso de 24 h não pode começar às 16:00:
    // a primeira fala precisa sair no dia anterior. Por isso a
    // execução nasce em `scheduledAt - maiorOffset`.
    const s = await scenario();

    s.runs.saveExecSettings(SERVER, {
      ...s.runs.getExecSettings(SERVER),
      announce: { ...s.runs.getExecSettings(SERVER).announce, offsetsMinutes: [60] },
    });

    const daqui30min = s.schedule.createPlan(SERVER, {
      scheduledAt: Date.now() + 30 * 60_000,
      bpPolicy: 'keep',
    });

    const daqui3h = s.schedule.createPlan(SERVER, {
      scheduledAt: Date.now() + 3 * 60 * 60_000,
      bpPolicy: 'keep',
    });

    const { clock, launched } = schedulerFor(s);

    await clock.tick();

    expect(launched).toEqual([daqui30min.id]);
    expect(launched).not.toContain(daqui3h.id);
  });

  it('não dispara o MESMO plano duas vezes', async () => {
    // ####  A EXECUÇÃO DURA HORAS; O RELÓGIO ACORDA A CADA 30 s  ####
    //
    // O `status` do plano só muda no FIM. Sem a lembrança do que já
    // foi entregue, cada volta do relógio dispararia o mesmo wipe de
    // novo — e o segundo pegaria um mundo de minutos de idade.
    const s = await scenario();

    s.schedule.createPlan(SERVER, { scheduledAt: Date.now() + 60_000, bpPolicy: 'keep' });

    const { clock, launched } = schedulerFor(s);

    await clock.tick();
    await clock.tick();
    await clock.tick();

    expect(launched).toHaveLength(1);
  });

  it('uma recusa não perde o wipe: a volta seguinte tenta de novo', async () => {
    const s = await scenario();

    const plan = s.schedule.createPlan(SERVER, {
      scheduledAt: Date.now() + 60_000,
      bpPolicy: 'keep',
    });

    // Primeiro tick: o lançador recusa (servidor em outra operação,
    // disco cheio). O plano CONTINUA `planned`.
    const recusado = schedulerFor(s, { fail: true });

    await recusado.clock.tick();

    expect(recusado.launched).toEqual([]);
    expect(s.schedule.getPlan(SERVER, plan.id)?.status).toBe('planned');

    // Segundo tick, com o caminho livre.
    const aceito = schedulerFor(s);

    await aceito.clock.tick();

    expect(aceito.launched).toEqual([plan.id]);
  });

  it('um servidor que ESTOURA não cala os outros, e o tick nunca lança', async () => {
    // ####  UM `throw` SEM DONO MATA O LAÇO  ####
    //
    // E a partir dali nenhum wipe agendado acontece, em SILÊNCIO —
    // o pior desfecho possível para um relógio. O servidor
    // `quebrado` abaixo estoura de verdade na leitura da
    // configuração, que é a primeira coisa que o tick faz com cada
    // um; sem o `try` por servidor, o `pvp1` logo em seguida nunca
    // seria alcançado.
    const s = await scenario();
    const plan = s.schedule.createPlan(SERVER, {
      scheduledAt: Date.now() + 60_000,
      bpPolicy: 'keep',
    });

    const launched: number[] = [];

    const clock = new WipeScheduler({
      schedule: s.schedule,
      runs: {
        getExecSettings: (serverId) => {
          if (serverId === 'quebrado') {
            throw new Error('o banco deste servidor não abre');
          }

          return s.runs.getExecSettings(serverId);
        },
      },
      servers: () => ['quebrado', SERVER],
      launcher: {
        launch: ({ planId }) => {
          launched.push(planId);
          return Promise.resolve();
        },
      },
    });

    await expect(clock.tick()).resolves.toBeUndefined();
    expect(launched).toEqual([plan.id]);
  });

  it('um plano cujo instante JÁ PASSOU continua valendo', async () => {
    // O agente ficou desligado três dias. O wipe que o dono pediu
    // continua sendo um wipe que ele pediu: descartá-lo por ser
    // velho transformaria "o agente estava fora do ar" em "o wipe
    // não aconteceu, e ninguém falou nada".
    const s = await scenario();

    const plan = s.schedule.createPlan(SERVER, {
      scheduledAt: Date.now() + 60_000,
      bpPolicy: 'keep',
    });

    // Empurra a linha para o passado por baixo, que é o que o tempo
    // faz com um agente desligado.
    s.db
      .prepare('UPDATE wipe_plans SET scheduled_at = @at WHERE id = @id')
      .run({ at: Date.now() - 3 * 24 * 60 * 60_000, id: plan.id });

    const { clock, launched } = schedulerFor(s);

    await clock.tick();

    expect(launched).toEqual([plan.id]);
  });
});

describe('a folga dos avisos', () => {
  it('sem aviso nenhum, a execução começa na hora marcada', () => {
    expect(leadTimeMs([])).toBe(0);
  });

  it('com avisos, ela começa pelo MAIOR deles', () => {
    expect(leadTimeMs([60, 1440, 5])).toBe(1440 * 60_000);
  });
});
