// ============================================================
//  wipe-backup.test.ts  -  o passo que é a ÚNICA volta atrás.
//
//  ####  POR QUE ESTE ARQUIVO EXISTE SEPARADO  ####
//
//  Ele precisa de um `readFile` que RECUSA — e recusa com o `code`
//  que a situação de verdade produz. No Windows, um handle aberto
//  sem `FILE_SHARE_READ` (antivírus escaneando o `.sav` que o
//  servidor acabou de fechar, backup em nuvem, um RustDedicated
//  que não morreu direito) devolve `EBUSY`/`EACCES`; o arquivo que
//  rotacionou devolve `ENOENT`. Os dois são exceções do mesmo
//  `readFile`, e o wipe inteiro depende de tratá-los como
//  OPOSTOS.
//
//  `vi.mock` é de arquivo, então ele mora aqui e não em
//  wipe-run.test.ts: tudo o que não estiver travado de propósito
//  atravessa para o `node:fs/promises` de verdade, e o disco
//  abaixo é disco de verdade em `os.tmpdir()`.
//
//  O que este arquivo guarda:
//
//    1. um arquivo TRAVADO não vira "sumiu antes de ser copiado":
//       ele derruba o backup, o zip pela metade é apagado e o wipe
//       para ANTES do `apagar`;
//    2. a trava passageira (a do antivírus) é esperada, não é
//       motivo de aborto — o arquivo entra no zip;
//    3. `ENOENT` continua inofensivo, que é a metade que já estava
//       certa;
//    4. dois backups no MESMO instante viram dois arquivos, e
//       nenhum come o outro;
//    5. a frase do passo diz o tamanho CRU e o do zip, com rótulo;
//    6. um arquivo travado que o `apagar` NÃO leva não derruba
//       nada: ele fica de fora do zip, continua em disco, e a
//       frase do passo diz quem ficou;
//    7. o zip guarda também o que o FULL WIPE apaga de fora da
//       pasta do save — a carteira, o VIP.
//
//  ####  ESTE TESTE APAGA ARQUIVO  ####
//
//  Em pastas de `os.tmpdir()`, criadas e removidas aqui. Nenhuma
//  linha encosta em `Servers\`.
// ============================================================

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
import { readZipEntries, readZipEntryData } from '../src/util/zip.js';
import { backupSaveFolder } from '../src/wipe/backup.js';
import { WipeRunner, type WipeServerControl, type WipeServers } from '../src/wipe/run.js';
import { classifyFile } from '../src/wipe/save-files.js';

// ------------------------------------------------------------
//  O `readFile` que recusa
// ------------------------------------------------------------

interface Trava {
  /** `EBUSY`, `EACCES`, `ENOENT`... */
  readonly code: string;
  /** Quantas leituras ainda falham. `Infinity` = a trava não solta. */
  readonly restam: number;
}

/**
 * Os caminhos travados, e o erro de cada um.
 *
 * `vi.hoisted` porque a fábrica do `vi.mock` sobe para o topo do
 * arquivo: sem isto, ela leria o mapa antes de ele existir.
 */
const { travados } = vi.hoisted(() => ({ travados: new Map<string, Trava>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...real,
    default: real,
    readFile: (...args: unknown[]): unknown => {
      const path = typeof args[0] === 'string' ? args[0] : null;
      const trava = path === null ? undefined : travados.get(path);

      if (path !== null && trava !== undefined && trava.restam > 0) {
        travados.set(path, { code: trava.code, restam: trava.restam - 1 });

        const boom: NodeJS.ErrnoException = new Error(
          `${trava.code}: resource busy or locked, open '${path}'`,
        );

        boom.code = trava.code;
        boom.syscall = 'open';
        boom.path = path;

        return Promise.reject(boom);
      }

      return (real.readFile as (...rest: unknown[]) => unknown)(...args);
    },
  };
});

// ------------------------------------------------------------
//  O cenário
// ------------------------------------------------------------

const SERVER = 'pvp1';
const IDENTITY = 'pvp1';

/**
 * Os nomes medidos em Servers\server01\server\server01\.
 *
 * `Log.EAC.txt` e `clans.287.db` estão aqui porque metade da pasta
 * de verdade é assim: arquivo que o `apagar` NÃO leva. Uma árvore
 * só de arquivos condenados não teria como mostrar a diferença
 * entre "não consegui ler" e "não consegui ler algo em risco".
 */
const SAVE_FILES = [
  'proceduralmap.4000.12345.287.map',
  'proceduralmap.4000.12345.287.sav',
  'proceduralmap.4000.12345.287.sav.1',
  'player.blueprints.16.db',
  'player.identities.16.db',
  'player.tokens.db',
  'clans.287.db',
  'Log.EAC.txt',
];

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
  readonly installDir: string;
  readonly saveDir: string;
  readonly backupsDir: string;
  readonly control: WipeServerControl & { running: boolean };
  readonly settings: Record<string, string | number | boolean>[];
}

async function cenario(): Promise<Cenario> {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-backup-'));

  temporary.push(root);

  const installDir = join(root, 'servidor');
  const backupsDir = join(root, 'backups');
  const saveDir = join(installDir, 'server', IDENTITY);

  await mkdir(saveDir, { recursive: true });
  await mkdir(join(installDir, 'oxide', 'data'), { recursive: true });

  for (const name of SAVE_FILES) {
    // Conteúdo com algum tamanho, e diferente por arquivo: um zip
    // de arquivos vazios não prova CRC nem compressão, e tamanhos
    // iguais não provariam a soma do tamanho CRU.
    await writeFile(join(saveDir, name), `${name}\n`.repeat(name.length * 10));
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

  // Sem avisos e sem esvaziar: um `await` de vinte e quatro horas
  // dentro de um teste não é um teste.
  runs.saveExecSettings(SERVER, {
    ...runs.getExecSettings(SERVER),
    announce: { ...runs.getExecSettings(SERVER).announce, offsetsMinutes: [] },
    drain: { enabled: false, waitMinutes: 0, force: false },
    backup: { enabled: true, keep: 3 },
  });

  return { runs, runner, installDir, saveDir, backupsDir, control, settings };
}

function operation(): Operation {
  return new Operation('wipe-run', SERVER);
}

function logDe(op: Operation): string {
  return op
    .logFrom(0)
    .map((line) => line.text)
    .join('\n');
}

async function zipsDe(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.zip')).sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------
//  §1  Travado não é "sumiu"
// ------------------------------------------------------------

describe('um arquivo que NÃO SE DEIXA LER derruba o backup', () => {
  it('a trava que não solta faz o backup LANÇAR, e não escrever um zip incompleto', async () => {
    // ####  O DESFECHO QUE ESTE TESTE IMPEDE  ####
    //
    // Medido na simulação: o `.sav` travado durante o backup e
    // solto antes do `apagar`. Os oito passos terminaram `done`,
    // o zip saiu com 22 das 23 entradas, e o `apagar` levou o
    // original. O mundo não ficou no zip nem no disco.
    const s = await cenario();
    const linhas: string[] = [];

    travados.set(join(s.saveDir, 'proceduralmap.4000.12345.287.sav'), {
      code: 'EBUSY',
      restam: Number.POSITIVE_INFINITY,
    });

    const boom = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      readRetryDelaysMs: [1, 1],
      onLine: (line) => linhas.push(line),
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(boom).not.toBeNull();
    expect(boom?.message).toContain('não consegui ler proceduralmap.4000.12345.287.sav');
    expect(boom?.message).toContain('EBUSY');
    // A frase VELHA, a que mentia, não pode aparecer em lugar nenhum.
    expect(linhas.join('\n')).not.toContain('sumiu antes de ser copiado');
    expect(boom?.message).not.toContain('sumiu antes de ser copiado');
    // E o zip pela metade não fica em disco: um arquivo com o nome
    // certo e o conteúdo incompleto é o que faria alguém confiar
    // nele no dia da restauração.
    expect(await zipsDe(s.backupsDir)).toHaveLength(0);
  });

  it('insiste antes de desistir, porque a trava do antivírus é passageira', async () => {
    const s = await cenario();
    const linhas: string[] = [];
    const alvo = join(s.saveDir, 'proceduralmap.4000.12345.287.sav');

    // Duas negativas e o arquivo solta — o antivírus terminou de
    // escanear. Isso NÃO pode custar o wipe.
    travados.set(alvo, { code: 'EBUSY', restam: 2 });

    const result = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      readRetryDelaysMs: [1, 1, 1, 1],
      onLine: (line) => linhas.push(line),
    });

    expect(result).not.toBeNull();
    expect(result?.files).toBe(SAVE_FILES.length);
    expect(linhas.join('\n')).toContain('travado por outro processo (EBUSY)');
    expect(linhas.join('\n')).toContain('liberou na tentativa 3');

    // E o conteúdo está lá DE VERDADE: o leitor do próprio projeto
    // confere CRC e tamanho de cada entrada.
    const archive = await readFile(result?.path as string);
    const entries = readZipEntries(archive);
    const sav = entries.find((entry) => entry.path === 'proceduralmap.4000.12345.287.sav');

    expect(sav).not.toBeUndefined();
    expect(readZipEntryData(archive, sav as (typeof entries)[number])).toEqual(
      await readFile(alvo),
    );
  });

  it('`EACCES` também derruba: não é só o `EBUSY`', async () => {
    const s = await cenario();

    travados.set(join(s.saveDir, 'player.blueprints.16.db'), {
      code: 'EACCES',
      restam: Number.POSITIVE_INFINITY,
    });

    await expect(
      backupSaveFolder({
        saveDir: s.saveDir,
        backupsDir: s.backupsDir,
        readRetryDelaysMs: [1],
      }),
    ).rejects.toThrow(/não consegui ler player\.blueprints\.16\.db/);
  });

  it('um erro que não é de trava desiste na hora, sem esperar', async () => {
    // `EIO` não passa sozinho. Insistir seria segurar o servidor
    // fora do ar por nada.
    const s = await cenario();
    const linhas: string[] = [];

    travados.set(join(s.saveDir, 'player.tokens.db'), {
      code: 'EIO',
      restam: Number.POSITIVE_INFINITY,
    });

    await expect(
      backupSaveFolder({
        saveDir: s.saveDir,
        backupsDir: s.backupsDir,
        readRetryDelaysMs: [30_000, 30_000],
        onLine: (line) => linhas.push(line),
      }),
    ).rejects.toThrow(/não consegui ler player\.tokens\.db/);

    expect(linhas.join('\n')).not.toContain('tento de novo');
  });

  it('`ENOENT` continua inofensivo: um a menos no zip, e ninguém lança', async () => {
    // A metade que já estava certa, e que precisa CONTINUAR certa:
    // um arquivo que não existe mais não é conteúdo perdido.
    const s = await cenario();
    const linhas: string[] = [];

    travados.set(join(s.saveDir, 'proceduralmap.4000.12345.287.sav.1'), {
      code: 'ENOENT',
      restam: Number.POSITIVE_INFINITY,
    });

    const result = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      onLine: (line) => linhas.push(line),
    });

    expect(result?.files).toBe(SAVE_FILES.length - 1);
    expect(linhas.join('\n')).toContain(
      'proceduralmap.4000.12345.287.sav.1 sumiu antes de ser copiado',
    );
    expect(await zipsDe(s.backupsDir)).toHaveLength(1);
  });
});

// ------------------------------------------------------------
//  §2  Pela máquina de passos
// ------------------------------------------------------------

describe('o wipe inteiro, com o mundo travado durante o backup', () => {
  it(
    'para no `backup`: o `apagar` nunca roda e o mundo continua em disco',
    async () => {
      const s = await cenario();
      const op = operation();

      travados.set(join(s.saveDir, 'proceduralmap.4000.12345.287.sav'), {
        code: 'EBUSY',
        restam: Number.POSITIVE_INFINITY,
      });

      const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

      await expect(
        s.runner.run({ serverId: SERVER, runId: run.id, operation: op, control: s.control }),
      ).rejects.toThrow(/não consegui ler proceduralmap\.4000\.12345\.287\.sav/);

      const depois = s.runs.get(SERVER, run.id);
      const passo = (nome: string): string | undefined =>
        depois?.steps.find((step) => step.step === nome)?.status;

      expect(depois?.status).toBe('failed');
      expect(passo('parar')).toBe('done');
      expect(passo('backup')).toBe('failed');
      // ####  A LINHA QUE É O CONSERTO  ####
      //
      // O `apagar` não pode nem ter COMEÇADO. Com o backup
      // incompleto, ele é o passo que transforma "faltou um
      // arquivo no zip" em "o arquivo não existe em lugar nenhum".
      expect(passo('apagar')).toBe('pending');
      expect(passo('configurar')).toBe('pending');

      // E a prova em disco: o mundo está inteiro, os 6 arquivos.
      expect((await readdir(s.saveDir)).sort()).toEqual([...SAVE_FILES].sort());
      // O `.ini` não foi tocado, e o servidor continua parado — o
      // operador retoma daqui sem nada para desfazer.
      expect(s.settings).toHaveLength(0);
      expect(s.control.running).toBe(false);
      expect(logDe(op)).toContain('backup FALHOU');
    },
    // As esperas de verdade (~3,7 s) valem o teste: é o caminho
    // que o operador percorre, com os tempos que ele espera.
    20_000,
  );

  it('a frase do passo traz o tamanho CRU e o do zip, cada um com seu rótulo', async () => {
    // ####  OS DOIS NÚMEROS QUE NÃO BATIAM  ####
    //
    // `backup` dizia "44 MB" (o zip) e `apagar` dizia "68 MB" (o
    // cru), sobre a MESMA pasta, e nada na tela explicava que a
    // diferença era a compressão.
    const s = await cenario();
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    const message = finished.steps.find((step) => step.step === 'backup')?.message ?? '';

    expect(message).toMatch(/^\d+ arquivo\(s\), .+ do save em .+ de zip -> /);
  });
});

// ------------------------------------------------------------
//  §3  O nome do zip
// ------------------------------------------------------------

describe('o nome do zip é único', () => {
  it('o carimbo desce ao milissegundo', async () => {
    const s = await cenario();

    const result = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      at: new Date(2026, 7, 19, 15, 41, 0, 472).getTime(),
    });

    expect(basename(result?.path as string)).toBe('wipe-2026-08-19_15-41-00-472.zip');
  });

  it('dois backups no MESMO instante viram dois arquivos, e nenhum come o outro', async () => {
    // ####  APARECEU NA PRÁTICA  ####
    //
    // Com resolução de segundo, o segundo backup abria o MESMO
    // caminho em modo `w` e sobrescrevia o primeiro sem um erro
    // nem uma linha de log — a simulação precisou de 1,1 s de
    // pausa entre as voltas para os quatro zips existirem.
    const s = await cenario();
    const at = new Date(2026, 7, 19, 15, 41, 0, 472).getTime();

    const primeiro = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      at,
      keep: 10,
    });

    const segundo = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      at,
      keep: 10,
    });

    expect(primeiro?.path).not.toBe(segundo?.path);
    expect(await zipsDe(s.backupsDir)).toEqual([
      'wipe-2026-08-19_15-41-00-472-2.zip',
      'wipe-2026-08-19_15-41-00-472.zip',
    ]);

    // Os DOIS abrem, e os dois têm o save inteiro dentro: o
    // segundo não é o primeiro truncado.
    for (const zip of [primeiro?.path as string, segundo?.path as string]) {
      const entries = readZipEntries(await readFile(zip));

      expect(entries.map((entry) => entry.path).sort()).toEqual([...SAVE_FILES].sort());
    }
  });

  it('o resultado sabe dizer o tamanho CRU do que guardou', async () => {
    const s = await cenario();

    let cru = 0;

    for (const name of SAVE_FILES) {
      cru += (await stat(join(s.saveDir, name))).size;
    }

    const result = await backupSaveFolder({ saveDir: s.saveDir, backupsDir: s.backupsDir });

    expect(result?.rawBytes).toBe(cru);
    // E o zip é menor que o cru — que é justamente a diferença que
    // a frase do passo precisava explicar.
    expect(result?.bytes).toBeLessThan(cru);
  });
});

// ------------------------------------------------------------
//  §4  A fatalidade segue o RISCO, e não a leitura
// ------------------------------------------------------------

/** A peneira que o passo `backup` monta: o que o `apagar` leva. */
const APAGA = (name: string): boolean => classifyFile(name, 'keep').fate === 'delete';

describe('um arquivo que o `apagar` NÃO leva não derruba o wipe', () => {
  it('o Log.EAC.txt travado fica de fora do zip, e o backup termina', async () => {
    // ####  O DESFECHO QUE ESTE TESTE IMPEDE  ####
    //
    // MEDIDO com o EAC segurando o próprio log depois de um
    // RustDedicated morto à força — o caminho "o servidor travou,
    // force o wipe": quatro retentativas, "backup FALHOU" em
    // 3.755 ms, os quatro passos seguintes `pending`, nenhum zip,
    // `.ini` não trocado e o servidor PARADO. Para proteger um
    // arquivo que o `apagar` nunca ia encostar.
    const s = await cenario();
    const linhas: string[] = [];

    travados.set(join(s.saveDir, 'Log.EAC.txt'), {
      code: 'EBUSY',
      restam: Number.POSITIVE_INFINITY,
    });

    const result = await backupSaveFolder({
      saveDir: s.saveDir,
      backupsDir: s.backupsDir,
      readRetryDelaysMs: [1, 1],
      deletes: APAGA,
      onLine: (line) => linhas.push(line),
    });

    expect(result).not.toBeNull();
    expect(result?.files).toBe(SAVE_FILES.length - 1);
    // E ele não some em silêncio: a lista sobe para a frase do passo.
    expect(result?.skipped).toEqual(['Log.EAC.txt']);
    expect(linhas.join('\n')).toContain('não se deixou ler (EBUSY)');
    expect(linhas.join('\n')).toContain('continua inteiro em disco');
    // A frase que MENTIRIA sobre este arquivo não pode aparecer.
    expect(linhas.join('\n')).not.toContain('sumiu antes de ser copiado');

    const zips = await zipsDe(s.backupsDir);

    expect(zips).toHaveLength(1);

    // E o resto do save está lá DE VERDADE, com CRC conferido pelo
    // leitor do próprio projeto.
    const archive = await readFile(join(s.backupsDir, zips[0] as string));
    const entries = readZipEntries(archive);

    expect(entries.map((entry) => entry.path).sort()).toEqual(
      SAVE_FILES.filter((name) => name !== 'Log.EAC.txt').sort(),
    );
  });

  it('mas o `.sav` travado continua derrubando: ESSE o `apagar` leva', async () => {
    // A metade que o conserto anterior acertou, e que não pode
    // afrouxar: o mundo fora do zip é o mundo em lugar nenhum.
    const s = await cenario();

    travados.set(join(s.saveDir, 'proceduralmap.4000.12345.287.sav'), {
      code: 'EBUSY',
      restam: Number.POSITIVE_INFINITY,
    });

    await expect(
      backupSaveFolder({
        saveDir: s.saveDir,
        backupsDir: s.backupsDir,
        readRetryDelaysMs: [1],
        deletes: APAGA,
      }),
    ).rejects.toThrow(/passo seguinte APAGA/);
  });

  it('e o `clans.287.db` MARCADO no full wipe volta a ser fatal', async () => {
    // O mesmo arquivo, a mesma política, e o desfecho oposto: ele é
    // `keep` para save-files.ts, mas o admin o marcou na lista do
    // full wipe — e o passo `apagar` VAI levá-lo. A peneira é a
    // união das duas coisas.
    const s = await cenario();

    travados.set(join(s.saveDir, 'clans.287.db'), {
      code: 'EACCES',
      restam: Number.POSITIVE_INFINITY,
    });

    await expect(
      backupSaveFolder({
        saveDir: s.saveDir,
        backupsDir: s.backupsDir,
        readRetryDelaysMs: [1],
        deletes: (name) => APAGA(name) || name === 'clans.287.db',
      }),
    ).rejects.toThrow(/não consegui ler clans\.287\.db/);
  });

  it('quem não diz o que apaga é tratado como se apagasse tudo', async () => {
    // O padrão é a recusa: sem a peneira não há como saber o que
    // está em risco, e adivinhar para o lado permissivo é como o
    // conteúdo se perde.
    const s = await cenario();

    travados.set(join(s.saveDir, 'Log.EAC.txt'), {
      code: 'EBUSY',
      restam: Number.POSITIVE_INFINITY,
    });

    await expect(
      backupSaveFolder({
        saveDir: s.saveDir,
        backupsDir: s.backupsDir,
        readRetryDelaysMs: [1],
      }),
    ).rejects.toThrow(/não consegui ler Log\.EAC\.txt/);
  });
});

describe('o wipe inteiro, com um arquivo `keep` travado no backup', () => {
  it(
    'termina: mapa novo, servidor no ar, e o arquivo travado intacto em disco',
    async () => {
      const s = await cenario();
      const op = operation();

      travados.set(join(s.saveDir, 'Log.EAC.txt'), {
        code: 'EBUSY',
        restam: Number.POSITIVE_INFINITY,
      });

      const run = s.runs.create(SERVER, { kind: 'cadence', bpPolicy: 'keep' });

      const finished = await s.runner.run({
        serverId: SERVER,
        runId: run.id,
        operation: op,
        control: s.control,
      });

      const passo = (nome: string): string | undefined =>
        finished.steps.find((step) => step.step === nome)?.status;

      expect(finished.status).toBe('done');
      expect(passo('backup')).toBe('done');
      expect(passo('apagar')).toBe('done');
      // O `.ini` trocou e o servidor voltou: é o wipe da madrugada
      // acontecendo, que era o que a fatalidade demais impedia.
      expect(s.settings).toHaveLength(1);
      expect(s.control.running).toBe(true);
      // E o arquivo que ficou de fora do zip continua em disco —
      // não havia conteúdo em risco.
      expect(await readdir(s.saveDir)).toContain('Log.EAC.txt');

      const message = finished.steps.find((step) => step.step === 'backup')?.message ?? '';

      expect(message).toContain('ficaram de fora do zip');
      expect(message).toContain('Log.EAC.txt');
    },
    20_000,
  );
});

// ------------------------------------------------------------
//  §5  O zip cobre o que o FULL WIPE apaga
// ------------------------------------------------------------

describe('o backup guarda o que o full wipe leva de fora da pasta do save', () => {
  /** A carteira: o arquivo que uma restauração precisa devolver. */
  const CARTEIRA = 'oxide/data/OrigemZStore.json';
  const CONTEUDO = '{"saldo":{"76561198000000001":4200}}';

  it('a carteira apagada pelo full wipe volta do zip, byte a byte', async () => {
    // ####  O DESFECHO QUE ESTE TESTE IMPEDE  ####
    //
    // MEDIDO: full wipe com backup LIGADO e a carteira marcada.
    // Depois, ela não estava em disco NEM no zip de 23 entradas, e
    // nenhuma linha da tela avisou — `BACKUP_DISABLED` só sai
    // quando o backup está DESLIGADO. O par `.db`/`-wal` do mesmo
    // wipe voltava, porque mora na pasta do save.
    const s = await cenario();
    const carteira = join(s.installDir, 'oxide', 'data', 'OrigemZStore.json');

    await writeFile(carteira, CONTEUDO);

    s.runs.saveExecSettings(SERVER, {
      ...s.runs.getExecSettings(SERVER),
      pluginData: { enabled: true, patterns: [CARTEIRA, 'server/pvp1/clans.287.db'] },
    });

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep', fullWipe: true });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    // O full wipe fez o que prometeu: os dois sumiram do disco.
    await expect(stat(carteira)).rejects.toThrow();
    await expect(stat(join(s.saveDir, 'clans.287.db'))).rejects.toThrow();

    const zips = await zipsDe(s.backupsDir);
    const archive = await readFile(join(s.backupsDir, zips[0] as string));
    const entries = readZipEntries(archive);
    const guardada = entries.find((entry) => entry.path === CARTEIRA);

    expect(guardada).not.toBeUndefined();
    expect(readZipEntryData(archive, guardada as (typeof entries)[number]).toString('utf8')).toBe(
      CONTEUDO,
    );
    // O `.db` da pasta do save entra pelo nome solto, como sempre:
    // nome com barra = relativo à pasta do servidor.
    expect(entries.map((entry) => entry.path)).toContain('clans.287.db');

    // E a frase do passo separa os dois números — o admin lê "24
    // arquivos" e precisa saber que um deles não é do save.
    const message = finished.steps.find((step) => step.step === 'backup')?.message ?? '';

    expect(message).toContain('(1 de dado de plugin)');
  });

  it('sem full wipe o zip é o de sempre: só a pasta do save', async () => {
    // O recorte não pode alargar sozinho: um zip com mais coisa
    // dentro prometeria restaurar o que ele não guarda.
    const s = await cenario();

    await writeFile(join(s.installDir, 'oxide', 'data', 'OrigemZStore.json'), CONTEUDO);

    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    const zips = await zipsDe(s.backupsDir);
    const entries = readZipEntries(await readFile(join(s.backupsDir, zips[0] as string)));

    expect(entries.map((entry) => entry.path).sort()).toEqual([...SAVE_FILES].sort());
  });
});
