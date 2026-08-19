// ============================================================
//  wipe-purge-parcial.test.ts  -  o dado de plugin que NÃO saiu.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO PRENDE  ####
//
//  Um `.json` de plugin que não se deixa apagar (arquivo aberto,
//  permissão) NÃO derruba o wipe, e isso está certo: quando o
//  passo `apagar` chega nessa parte o mundo já foi removido, e
//  parar ali deixaria o servidor sem mundo e sem subir.
//
//  O que estava errado era o silêncio. O contador somava só os
//  sucessos: cinco marcados, um travado, e a aba Execução dizia
//  "+ 4 de plugin" com o passo `done`. MEDIDO: `jogador3.json`
//  continuava em disco, e a única pista era uma linha no log da
//  operação — que ninguém abre quando o wipe terminou verde.
//
//  ####  POR QUE ESTE ARQUIVO É SEPARADO  ####
//
//  Ele precisa de um `rm` que RECUSA, e `vi.mock` é de arquivo.
//  Tudo o que não estiver travado de propósito atravessa para o
//  `node:fs/promises` de verdade, e o disco abaixo é disco de
//  verdade em `os.tmpdir()`.
//
//  ####  ESTE TESTE APAGA ARQUIVO  ####
//
//  Em pastas de `os.tmpdir()`, criadas e removidas aqui. Nenhuma
//  linha encosta em `Servers\`.
// ============================================================

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '../src/config.js';
import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { Operation } from '../src/ops/operations.js';
import { WipeRunner, type WipeServerControl, type WipeServers } from '../src/wipe/run.js';

// ------------------------------------------------------------
//  O `rm` que recusa
// ------------------------------------------------------------

/**
 * Os caminhos travados. `vi.hoisted` porque a fábrica do `vi.mock`
 * sobe para o topo do arquivo: sem isto, ela leria o conjunto
 * antes de ele existir.
 */
const { travados } = vi.hoisted(() => ({ travados: new Set<string>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...real,
    default: real,
    rm: (...args: unknown[]): unknown => {
      const path = typeof args[0] === 'string' ? args[0] : null;

      if (path !== null && travados.has(path)) {
        const boom: NodeJS.ErrnoException = new Error(
          `EBUSY: resource busy or locked, unlink '${path}'`,
        );

        boom.code = 'EBUSY';
        boom.syscall = 'unlink';
        boom.path = path;

        return Promise.reject(boom);
      }

      return (real.rm as (...rest: unknown[]) => unknown)(...args);
    },
  };
});

// ------------------------------------------------------------
//  O cenário
// ------------------------------------------------------------

const SERVER = 'pvp1';
const IDENTITY = 'pvp1';

/** Cinco `.json` por jogador, como num `oxide\data` de verdade. */
const JOGADORES = ['jogador1', 'jogador2', 'jogador3', 'jogador4', 'jogador5'];

const temporary: string[] = [];

afterEach(async () => {
  travados.clear();

  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Cenario {
  readonly runs: WipeRunsRepository;
  readonly runner: WipeRunner;
  readonly saveDir: string;
  readonly pluginDir: string;
  readonly control: WipeServerControl & { running: boolean };
}

async function cenario(): Promise<Cenario> {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-purge-'));

  temporary.push(root);

  const installDir = join(root, 'servidor');
  const saveDir = join(installDir, 'server', IDENTITY);
  const pluginDir = join(installDir, 'oxide', 'data', 'PlayerDatabase');

  await mkdir(saveDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });

  await writeFile(join(saveDir, 'proceduralmap.4000.12345.287.map'), 'mapa');
  await writeFile(join(saveDir, 'proceduralmap.4000.12345.287.sav'), 'mundo');

  for (const nome of JOGADORES) {
    await writeFile(join(pluginDir, `${nome}.json`), `{"nome":"${nome}"}`);
  }

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
      backupsDir: join(root, 'backups'),
    },
  } as ServerConfig;

  const servers: WipeServers = { configOf: () => config, updateSettings: () => [] };

  const control = {
    running: true,
    isRunning: () => Promise.resolve(control.running),
    stop: () => {
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

  const runner = new WipeRunner({
    runs,
    wipes: new WipesRepository(db),
    schedule: new WipeScheduleRepository(db),
    mapPool: new MapPoolRepository(db),
    servers,
    world: { forget: () => undefined, saveCreatedAt: () => Promise.resolve(2_000) },
    announcer: { announceOffset: () => Promise.resolve() },
  });

  const base = runs.getExecSettings(SERVER);

  // Sem avisos, sem esvaziar e sem backup: o que este arquivo mede
  // é a frase do passo `apagar`, e um `await` de vinte e quatro
  // horas dentro de um teste não é um teste.
  runs.saveExecSettings(SERVER, {
    ...base,
    announce: { ...base.announce, offsetsMinutes: [] },
    drain: { enabled: false, waitMinutes: 0, force: false },
    backup: { enabled: false, keep: 3 },
    pluginData: {
      enabled: true,
      patterns: JOGADORES.map((nome) => `oxide/data/PlayerDatabase/${nome}.json`),
    },
    post: { ...base.post, resync: false, announce: false },
  });

  return { runs, runner, saveDir, pluginDir, control };
}

// ------------------------------------------------------------
//  O que a aba Execução mostra
// ------------------------------------------------------------

describe('o passo `apagar` conta o que NÃO saiu', () => {
  it('cinco marcados e um travado: a frase diz que ficou um para trás', async () => {
    const s = await cenario();

    travados.add(join(s.pluginDir, 'jogador3.json'));

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep', fullWipe: true });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: new Operation('wipe-run', SERVER),
      control: s.control,
    });

    const passo = finished.steps.find((step) => step.step === 'apagar');

    // Não derrubar o wipe está CERTO: o mundo já foi apagado.
    expect(passo?.status).toBe('done');
    expect(finished.status).toBe('done');

    // ####  A LINHA QUE É O CONSERTO  ####
    //
    // Ela dizia "+ 4 de plugin" e parava aí. O quinto continuava em
    // disco, e nada na tela dizia isso.
    expect(passo?.message).toContain('+ 4 de plugin');
    expect(passo?.message).toContain('1 dado(s) de plugin NÃO saiu(íram)');
    expect(passo?.message).toContain('jogador3.json');

    // E a prova em disco: é ele mesmo que sobrou.
    expect(await readdir(s.pluginDir)).toEqual(['jogador3.json']);
  });

  it('sem nenhum travado, a frase continua a de sempre', async () => {
    // O conserto não pode acrescentar ruído ao caminho feliz, que é
    // o de todo wipe que dá certo.
    const s = await cenario();

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep', fullWipe: true });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: new Operation('wipe-run', SERVER),
      control: s.control,
    });

    const message = finished.steps.find((step) => step.step === 'apagar')?.message ?? '';

    expect(message).toContain('+ 5 de plugin');
    expect(message).not.toContain('NÃO saiu');
    expect(await readdir(s.pluginDir)).toHaveLength(0);
  });

  it('a pasta do save vazia com um dado de plugin preso não vira "já estava limpa"', async () => {
    // A retomada depois de o `apagar` ter levado o mundo: não há
    // arquivo do save, não saiu dado de plugin nenhum — e "a pasta
    // já estava limpa" seria uma frase tranquila sobre um wipe que
    // deixou tudo o que o admin marcou em disco.
    const s = await cenario();

    for (const nome of await readdir(s.saveDir)) {
      await rm(join(s.saveDir, nome), { force: true });
    }

    for (const nome of JOGADORES) {
      travados.add(join(s.pluginDir, `${nome}.json`));
    }

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep', fullWipe: true });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: new Operation('wipe-run', SERVER),
      control: s.control,
    });

    const message = finished.steps.find((step) => step.step === 'apagar')?.message ?? '';

    expect(message).not.toContain('já estava limpa');
    expect(message).toContain('5 dado(s) de plugin NÃO saiu(íram)');
  });
});
