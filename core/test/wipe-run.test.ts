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
import {
  WipeRunsRepository,
  type WipeRunRecord,
  type WipeWorld,
} from '../src/db/wipe-runs-repository.js';
import {
  WipeScheduleRepository,
  type WipePlanInput,
} from '../src/db/wipe-schedule-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { Operation } from '../src/ops/operations.js';
import type { WipePlan } from '../src/types/wipe.js';
import { readZipEntries, readZipEntryData } from '../src/util/zip.js';
import { backupSaveFolder, pruneBackups } from '../src/wipe/backup.js';
import { currentWorldReader, nextWipe, type NextWipeMap } from '../src/wipe/next-wipe.js';
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

/**
 * O `WipeRunsRepository` com uma falha plantada no `commitWorld`.
 *
 * ####  A INTERRUPÇÃO QUE ESTE ARQUIVO PRECISA MEDIR  ####
 *
 * O passo `configurar` grava o `.ini` e SÓ DEPOIS o resultado no
 * banco. Entre as duas escritas cabe uma interrupção — o agente
 * morrendo, ou o próprio `commitWorld` lançando (um
 * `MAP_NOT_FOUND` no `markUsed`, o SQLite ocupado). Nos dois casos
 * o `.ini` já é o do mundo novo e o banco ainda não sabe de nada,
 * e é exatamente aí que a retomada precisa chegar à MESMA decisão.
 *
 * `settingsErrors` planta a falha do OUTRO lado (o `.ini` que não
 * grava); esta planta a de depois dele.
 */
class RunsComCommitQueFalha extends WipeRunsRepository {
  readonly commitErrors: Error[] = [];

  override commitWorld(
    serverId: string,
    id: number,
    escolher: () => WipeWorld,
    now: number = Date.now(),
  ): WipeRunRecord {
    const boom = this.commitErrors.shift();

    if (boom !== undefined) {
      throw boom;
    }

    return super.commitWorld(serverId, id, escolher, now);
  }
}

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
  /**
   * O `.ini` de AGORA — o de depois do que o wipe já gravou.
   *
   * `config` é o retrato do começo; este é o que o supervisor
   * responderia se alguém perguntasse neste segundo, e é o que as
   * superfícies que anunciam leem.
   */
  readonly configOf: () => ServerConfig;
  readonly saveDir: string;
  readonly backupsDir: string;
  readonly control: WipeServerControl & { running: boolean; readonly stops: number[] };
  readonly settings: Record<string, string | number | boolean>[];
  /**
   * Erros que o `updateSettings` vai lançar, um por chamada.
   *
   * É o supervisor gravando o `.ini`: ele escreve em disco, confere
   * as portas e relê o arquivo, e está declarado `@throws`. Um
   * teste de atomicidade sem ele não existe.
   */
  readonly settingsErrors: Error[];
  /** Erros que o `commitWorld` vai lançar. Ver `RunsComCommitQueFalha`. */
  readonly commitErrors: Error[];
  readonly announced: number[];
}

async function scenario(
  options: {
    readonly announcer?: WipeAnnouncer;
    readonly saveCreatedAfter?: number | null;
    /**
     * O `.map` de fora que o servidor está rodando AGORA.
     *
     * Vazio = mundo procedural, que é o caso comum. Ele existe
     * para uma pergunta só: um wipe FORÇADO pode MANTER o mundo de
     * hoje? Ver `keepBlockedInForced`.
     */
    readonly levelUrl?: string;
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
    levelUrl: options.levelUrl ?? '',
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

  const settingsErrors: Error[] = [];

  // ####  O `.ini` DE DEPOIS É O QUE O SUPERVISOR RELÊ  ####
  //
  // `updateSettings` escreve o arquivo, confere as portas e RELÊ o
  // resultado: quem chamar `configOf` depois dele recebe o mundo
  // NOVO, e é assim mesmo quando o agente morre no meio (o `.ini`
  // já está em disco, e o boot seguinte o lê). Um stub que
  // devolvesse para sempre o mundo do começo esconderia a única
  // coisa que o passo `configurar` reescreve — e é dela que a
  // decisão dele dependia.
  let atual = config;

  const servers: WipeServers = {
    configOf: () => atual,
    updateSettings: (_id, patch) => {
      const boom = settingsErrors.shift();

      if (boom !== undefined) {
        throw boom;
      }

      settings.push({ ...patch });

      atual = {
        ...atual,
        ...(typeof patch.map === 'string' ? { level: patch.map } : {}),
        ...(patch.seed === undefined ? {} : { seed: Number(patch.seed) }),
        ...(typeof patch.worldSize === 'number' ? { worldSize: patch.worldSize } : {}),
        ...(typeof patch.levelUrl === 'string' ? { levelUrl: patch.levelUrl } : {}),
      } as ServerConfig;

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

  const runs = new RunsComCommitQueFalha(db);
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
    configOf: () => atual,
    saveDir,
    backupsDir,
    control,
    settings,
    settingsErrors,
    commitErrors: runs.commitErrors,
    announced,
  };
}

function operation(): Operation {
  return new Operation('wipe-run', SERVER);
}

/** Tudo o que a operação escreveu, numa string só. */
function logDe(op: Operation): string {
  return op
    .logFrom(0)
    .map((line) => line.text)
    .join('\n');
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

// ============================================================
//  O MUNDO É O DO PLANO, E NÃO A CABEÇA DA FILA
//
//  ####  O DEFEITO QUE ESTA SEÇÃO PRENDE  ####
//
//  O passo `configurar` chamava `takeForWipe` direto, sem olhar o
//  `mapSource` do plano. Um plano `keep` — "não troque o mundo" —
//  trocava o mundo assim mesmo e ainda queimava a cabeça da fila;
//  um `fixed` apontando para a entrada #2 subia a #1. E a tela do
//  jogo e o chat, que já liam o plano, anunciavam a entrada certa:
//  o VIP prata pagava pela prévia de um mundo que não ia subir.
//
//  Por isso toda asserção daqui vem em par: o que o executor FEZ,
//  e o que `nextWipe` — a mesma decisão que vira frase no chat e
//  imagem na tela — tinha ANUNCIADO. Um teste que só olhasse o
//  executor ficaria verde no dia em que as duas voltassem a
//  divergir.
// ============================================================

const SEMANA = 7 * 24 * 60 * 60 * 1000;

/**
 * O que o chat e a tela do jogo estão anunciando, agora.
 *
 * O `world` entra aqui porque o index.ts o entrega às três
 * superfícies que anunciam: sem ele, este teste ficaria verde no
 * dia em que a tela voltasse a prometer "o mesmo mapa de agora"
 * para um `.map` custom que o wipe forçado vai trocar.
 */
function anunciado(s: Scenario): NextWipeMap | null {
  const next = nextWipe(
    SERVER,
    {
      schedule: s.schedule,
      runs: s.runs,
      mapPool: s.mapPool,
      world: currentWorldReader({
        // O mundo de AGORA, e não o do começo da execução: é o
        // `.ini` de agora que o chat e a tela do jogo leem.
        servers: { configOf: () => s.configOf() },
        mapPool: s.mapPool,
      }),
    },
    Date.now(),
  );

  return next === null ? null : next.map;
}

/** Um wipe marcado na agenda, com a origem de mapa que o teste quer. */
function plano(s: Scenario, input: Partial<WipePlanInput> = {}): WipePlan {
  return s.schedule.createPlan(
    SERVER,
    { scheduledAt: Date.now() + SEMANA, bpPolicy: 'keep', ...input },
    Date.now(),
  );
}

/** A execução DAQUELE plano, começando agora. */
function execucaoDe(s: Scenario, plan: WipePlan): WipeRunRecord {
  return s.runs.create(SERVER, {
    planId: plan.id,
    kind: plan.kind,
    bpPolicy: plan.bpPolicy,
    mapBefore: { level: s.config.level, seed: String(s.config.seed), worldSize: s.config.worldSize },
  });
}

/** Duas entradas prontas, na ordem: a #1 e a #2 da fila. */
function fila(s: Scenario): { readonly primeira: number; readonly segunda: number } {
  return {
    primeira: s.mapPool.add(SERVER, { seed: '11111', worldSize: 4000 }).entry.id,
    segunda: s.mapPool.add(SERVER, { seed: '22222', worldSize: 3000 }).entry.id,
  };
}

describe('`keep`: o mundo NÃO muda', () => {
  it('não troca o mundo, não escreve o .ini e não consome a fila', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'keep' }));

    // O que a tela do jogo e o `{wipe.mapa}` estão dizendo AGORA.
    expect(anunciado(s)).toEqual({ source: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    // ####  O `.ini` NEM FOI ABERTO  ####
    //
    // E não é preciosismo: o patch normal grava `levelUrl` sempre,
    // inclusive vazia. Num servidor de mapa custom isso apagaria o
    // `.map` que o plano mandou manter.
    expect(s.settings).toHaveLength(0);

    // A fila continua inteira: as duas entradas esperando a vez.
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('ready');
    expect(s.mapPool.next(SERVER)?.id).toBe(primeira);

    // E o mundo gravado é o de agora, e não o da cabeça da fila.
    expect(finished.mapAfter?.seed).toBe(String(s.config.seed));
    expect(finished.mapAfter?.worldSize).toBe(s.config.worldSize);
    expect(finished.mapAfter?.mapPoolId).toBeNull();
    expect(finished.mapAfter?.drawn).toBe(false);
    expect(finished.steps.find((step) => step.step === 'configurar')?.message).toContain('MANTER');
  });

  it('a retomada não consome fila nem depois de `configurar` ter passado', async () => {
    const s = await scenario();
    const { primeira } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'keep' }));

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    // O agente reinicia, e alguém manda retomar a MESMA execução.
    s.runs.markStep(run.id, 'subir', 'failed', 'o agente morreu aqui');
    s.control.running = false;

    const retomado = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(retomado.status).toBe('done');
    expect(s.settings).toHaveLength(0);
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
    expect(retomado.steps.find((step) => step.step === 'configurar')?.status).toBe('done');
  });

  it('durante os avisos, o chat e a tela já anunciam o mundo que fica', async () => {
    // ####  A JANELA DOS AVISOS É O DIA INTEIRO  ####
    //
    // A execução começa com a antecedência do maior aviso e só
    // decide o mundo no `configurar`. Enquanto `map_after` é null,
    // perguntar à fila faria um plano `keep` anunciar por 24 h a
    // cabeça de uma fila que ele nem vai tocar.
    const s = await scenario();

    fila(s);
    execucaoDe(s, plano(s, { mapSource: 'keep' }));

    expect(anunciado(s)).toEqual({ source: 'keep' });
  });
});

describe('`fixed`: a entrada APONTADA, esteja onde estiver na fila', () => {
  it('consome a #2 e deixa a #1 esperando a vez', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));

    const antes = anunciado(s);

    expect(antes?.source).toBe('entry');
    expect(antes?.source === 'entry' ? antes.entry.id : null).toBe(segunda);

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    // O que subiu é o que foi anunciado.
    expect(finished.mapAfter?.mapPoolId).toBe(segunda);
    expect(finished.mapAfter?.seed).toBe('22222');
    expect(s.settings[0]).toMatchObject({ seed: '22222', worldSize: 3000 });

    // A cabeça da fila NÃO foi queimada: ela é o mundo do wipe que vem.
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('used');
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
    expect(s.mapPool.next(SERVER)?.id).toBe(primeira);
  });

  it('a retomada não consome uma SEGUNDA entrada', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));

    await s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control });

    s.runs.markStep(run.id, 'subir', 'failed', 'o agente morreu aqui');
    s.control.running = false;

    await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(s.settings).toHaveLength(1);
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
  });

  it('a entrada apontada sumiu da fila: cai para a cabeça, e o wipe acontece', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);

    s.mapPool.remove(SERVER, segunda);

    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));

    const antes = anunciado(s);

    expect(antes?.source === 'entry' ? antes.entry.id : null).toBe(primeira);

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.status).toBe('done');
    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
  });

  it('a entrada apontada JÁ FOI usada: cai para a cabeça, e não reescreve a história dela', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const usadaEm = Date.now() - SEMANA;

    s.mapPool.markUsed(SERVER, segunda, usadaEm);

    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));
    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    // O `used_at` continua contando quando ela entrou DE VERDADE.
    expect(s.mapPool.get(SERVER, segunda)?.usedAt).toBe(usadaEm);
  });

  it('a entrada apontada ainda está `generating`: cai para a cabeça', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);

    s.mapPool.markGenerating(SERVER, segunda, 'r5t6y7', false);

    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));
    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('generating');
  });

  it('a fila inteira sumiu: o agente SORTEIA, e o wipe não fica bloqueado', async () => {
    // A regra da fila de mapas continua valendo com `fixed`: falta
    // de curadoria não pode ser motivo para o servidor não zerar.
    const s = await scenario();
    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: 4242 }));

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.status).toBe('done');
    expect(finished.mapAfter?.drawn).toBe(true);
  });
});

describe('o wipe FORÇADO e o mapa custom apontado a dedo', () => {
  /** O primeiro forçado que a reconciliação materializar. */
  function forcado(s: Scenario): WipePlan {
    s.schedule.reconcile(SERVER, Date.now());

    const plan = s.schedule
      .listPlans(SERVER, { from: Date.now() })
      .find((candidate) => candidate.kind === 'forced');

    expect(plan).toBeDefined();

    return plan as WipePlan;
  }

  it('sem a marca de compatibilidade, o `.map` de ontem NÃO sobe — nem apontado a dedo', async () => {
    // ####  É ESTE O CASO QUE DEIXA O SERVIDOR SEM SUBIR  ####
    //
    // O forçado troca o binário do jogo. Um `.map` gerado na versão
    // de ontem pode não carregar na de hoje, e o admin só descobre
    // isso na madrugada, com o mundo velho já apagado.
    const s = await scenario();
    const { primeira } = fila(s);

    const custom = s.mapPool.add(SERVER, {
      kind: 'custom',
      level: 'Ilha',
      levelUrl: 'https://mapas.exemplo/ilha.map',
    }).entry.id;

    const plan = forcado(s);

    s.schedule.updatePlan(SERVER, plan.id, { mapSource: 'fixed', mapPoolId: custom }, Date.now());

    const run = s.runs.create(SERVER, {
      planId: plan.id,
      kind: 'forced',
      bpPolicy: plan.bpPolicy,
    });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    expect(finished.mapAfter?.levelUrl).toBeNull();
    expect(s.mapPool.get(SERVER, custom)?.status).toBe('ready');
  });

  it('COM a marca, ele sobe: quem garantiu foi o admin', async () => {
    const s = await scenario();

    fila(s);

    const custom = s.mapPool.add(SERVER, {
      kind: 'custom',
      level: 'Ilha',
      levelUrl: 'https://mapas.exemplo/ilha.map',
    }).entry.id;

    s.mapPool.markVersionOk(SERVER, custom, true);

    const plan = forcado(s);

    s.schedule.updatePlan(SERVER, plan.id, { mapSource: 'fixed', mapPoolId: custom }, Date.now());

    const run = s.runs.create(SERVER, {
      planId: plan.id,
      kind: 'forced',
      bpPolicy: plan.bpPolicy,
    });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(custom);
    expect(s.settings[0]).toMatchObject({ levelUrl: 'https://mapas.exemplo/ilha.map' });
  });

  it('o pulo do custom sai no log com `fixed`, como já saía com `pool`', async () => {
    // ####  DOIS CENÁRIOS IDÊNTICOS, LADO A LADO  ####
    //
    // Mesma fila, mesmo wipe forçado, mesmo mundo no fim. O
    // `fixed` deixava de rodar o `pickForWipe` — que é quem monta
    // a lista de puladas — e NENHUMA linha de pulo saía: a entrada
    // ficava `ready` para sempre, sem registro de por que não
    // subiu, e o admin não descobria que falta marcar a
    // compatibilidade dela. A trava do Docs\16 §9.1 existe
    // exatamente para ele ficar sabendo.
    const logs: string[] = [];

    for (const aDedo of [false, true]) {
      const s = await scenario();

      // O custom sem marca é a CABEÇA da fila: é ele que o wipe
      // forçado tem de pular para chegar no procedural.
      const custom = s.mapPool.add(SERVER, {
        kind: 'custom',
        level: 'Ilha',
        levelUrl: 'https://mapas.exemplo/ilha.map',
      }).entry.id;

      const procedural = s.mapPool.add(SERVER, { seed: '33333', worldSize: 4000 }).entry.id;
      const plan = forcado(s);

      if (aDedo) {
        s.schedule.updatePlan(
          SERVER,
          plan.id,
          { mapSource: 'fixed', mapPoolId: custom },
          Date.now(),
        );
      }

      const op = operation();

      const run = s.runs.create(SERVER, {
        planId: plan.id,
        kind: 'forced',
        bpPolicy: plan.bpPolicy,
      });

      const finished = await s.runner.run({
        serverId: SERVER,
        runId: run.id,
        operation: op,
        control: s.control,
      });

      // O mundo é o mesmo nos dois, e a entrada recusada continua
      // na fila esperando a marca.
      expect(finished.mapAfter?.mapPoolId).toBe(procedural);
      expect(s.mapPool.get(SERVER, custom)?.status).toBe('ready');

      logs.push(logDe(op));
    }

    for (const texto of logs) {
      expect(texto).toContain('pulei a entrada #1 da fila');
      expect(texto).toContain('mapa custom sem a marca');
    }

    // E o `fixed` diz também o que houve com a escolha a dedo.
    expect(logs[1]).toContain('NÃO vai subir');
  });
});

describe('o log diz QUEM escolheu o mundo', () => {
  it('a queda para a fila não passa por escolha a dedo', async () => {
    // ####  A QUEDA TEM O MESMO FORMATO DA ESCOLHA  ####
    //
    // Quando o ponteiro não serve, `mapOfPlan` devolve a cabeça da
    // fila — também como `source: 'entry'`. Sem comparar o id, o
    // `wipe_run_steps.message` e o log da operação diziam
    // "escolhida a dedo no plano" de uma entrada que ninguém
    // escolheu.
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const op = operation();

    s.mapPool.remove(SERVER, segunda);

    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: op,
      control: s.control,
    });

    const message = finished.steps.find((step) => step.step === 'configurar')?.message ?? '';

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    expect(message).toContain(`entrada #${String(primeira)} da fila`);
    expect(message).not.toContain('escolhida a dedo');

    // E o admin fica sabendo o que houve com a escolha DELE.
    expect(logDe(op)).toContain(`a entrada #${String(segunda)}`);
    expect(logDe(op)).toContain('ela não está mais na fila');
  });

  it('a entrada realmente apontada continua dizendo que foi a dedo', async () => {
    const s = await scenario();
    const { segunda } = fila(s);
    const op = operation();
    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: op,
      control: s.control,
    });

    expect(finished.steps.find((step) => step.step === 'configurar')?.message).toContain(
      'escolhida a dedo no plano',
    );
    expect(logDe(op)).not.toContain('NÃO vai subir');
  });
});

describe('a fila só é QUEIMADA depois de o `.ini` estar gravado', () => {
  it('o `.ini` falha, e o wipe inteiro consome UMA entrada só', async () => {
    // ####  MEDIDO: DUAS ENTRADAS POR UM WIPE SÓ  ####
    //
    // A entrada era queimada antes do `updateSettings`, e o
    // `map_after` — a única marca de idempotência do passo — só
    // era gravado depois dele. Um erro no meio deixava a #1 `used`
    // sem nunca ter subido, e a retomada, sem marca nenhuma,
    // queimava a #2.
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'pool' }));

    s.settingsErrors.push(new Error('o .ini está aberto em outro programa'));

    await expect(
      s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control }),
    ).rejects.toThrow('o .ini');

    // Nada consumido, e nenhuma marca: a volta reencontra a MESMA
    // fila e toma a MESMA decisão.
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
    expect(s.runs.get(SERVER, run.id)?.mapAfter ?? null).toBeNull();

    const retomado = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(retomado.status).toBe('done');
    expect(retomado.mapAfter?.mapPoolId).toBe(primeira);
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('used');
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('ready');
    expect(s.settings).toHaveLength(1);
  });

  it('com `fixed`, a retomada sobe a entrada APONTADA — e não a cabeça', async () => {
    // ####  O PIOR DOS DOIS  ####
    //
    // A #2 ficava `used` sem ter subido; na volta o `mapOfPlan` a
    // via consumida, caía para a cabeça da fila e o wipe subia o
    // mundo que o plano explicitamente não queria.
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'fixed', mapPoolId: segunda }));

    s.settingsErrors.push(new Error('o .ini está aberto em outro programa'));

    await expect(
      s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control }),
    ).rejects.toThrow('o .ini');

    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('ready');

    const retomado = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(retomado.mapAfter?.mapPoolId).toBe(segunda);
    expect(retomado.mapAfter?.seed).toBe('22222');
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('used');
  });
});

describe('o SORTEIO também escolhe antes de queimar', () => {
  it('o `.ini` lança duas vezes com a fila VAZIA: UMA linha `used` no fim', async () => {
    // ####  MEDIDO: TRÊS MUNDOS QUE NUNCA SUBIRAM  ####
    //
    // `takeForWipe` inseria a linha e a marcava `used` ANTES do
    // `updateSettings`. Com o `.ini` lançando duas vezes, o banco
    // ficava com três linhas `used` para um wipe só — e
    // `recentSeeds`, que alimenta o aviso "já jogamos esta seed",
    // olha só os seis últimos wipes: dois fantasmas já empurram um
    // terço da memória real para fora da janela.
    const s = await scenario();
    const run = execucaoDe(s, plano(s, { mapSource: 'pool' }));

    s.settingsErrors.push(new Error('o .ini está aberto em outro programa'));
    s.settingsErrors.push(new Error('o .ini continua aberto'));

    for (const tentativa of [1, 2]) {
      await expect(
        s.runner.run({
          serverId: SERVER,
          runId: run.id,
          operation: operation(),
          control: s.control,
          resume: tentativa > 1,
        }),
      ).rejects.toThrow('o .ini');

      // Nada gravado: sortear é escolher, e escolher não é queimar.
      expect(s.mapPool.list(SERVER)).toHaveLength(0);
      expect(s.runs.get(SERVER, run.id)?.mapAfter ?? null).toBeNull();
    }

    const retomado = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    const usadas = s.mapPool.list(SERVER).filter((entry) => entry.status === 'used');

    expect(retomado.status).toBe('done');
    expect(retomado.mapAfter?.drawn).toBe(true);
    expect(usadas).toHaveLength(1);
    expect(retomado.mapAfter?.seed).toBe(usadas[0]?.seed);
    // E a memória do sorteio é a de UM wipe, e não a de três.
    expect(new Set(s.mapPool.recentSeeds(SERVER)).size).toBe(1);
  });

  it('a seed sorteada é a que foi para o `.ini`, e não uma segunda', async () => {
    const s = await scenario();
    const run = execucaoDe(s, plano(s, { mapSource: 'pool' }));

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    const sorteada = s.mapPool.list(SERVER).find((entry) => entry.status === 'used');

    expect(s.settings[0]).toMatchObject({ seed: sorteada?.seed ?? '' });
    expect(finished.mapAfter?.mapPoolId).toBe(sorteada?.id);
  });
});

describe('as duas escritas do fim de `configurar` são uma só', () => {
  it('o banco caindo entre elas não deixa mundo gravado com a fila intacta', async () => {
    // ####  MEDIDO: A MESMA SEED EM DOIS WIPES SEGUIDOS  ####
    //
    // O `map_after` era gravado, a entrada continuava `ready`, e a
    // retomada pulava o passo inteiro (a marca já estava lá): o
    // wipe SEGUINTE consumia a MESMA entrada. No intervalo, a
    // régua do VIP anunciava como "o próximo mundo" o mundo que já
    // estava no ar.
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'pool' }));
    const update = s.runs.update.bind(s.runs);

    let cair = true;

    s.runs.update = (serverId, id, patch, now) => {
      if (cair && patch.mapAfter !== undefined) {
        cair = false;

        throw new Error('o banco caiu entre a fila e o mundo');
      }

      return update(serverId, id, patch, now);
    };

    await expect(
      s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control }),
    ).rejects.toThrow('o banco caiu');

    s.runs.update = update;

    // Nem uma coisa nem outra: a queima voltou atrás junto com o
    // mundo que ela acompanha.
    expect(s.runs.get(SERVER, run.id)?.mapAfter ?? null).toBeNull();
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');

    const retomado = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(retomado.mapAfter?.mapPoolId).toBe(primeira);
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('used');
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('ready');
  });
});

describe('`random` segue a fila, e não sorteia por cima dela', () => {
  it('com a fila curada, ele consome a CABEÇA — igual ao `pool`', async () => {
    // A etiqueta dizia "o agente sorteia" na tela, na doc e no
    // tipo, e o agente comia a entrada que o admin tinha curado.
    // O que muda é a frase; o comportamento é este, e continua.
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'random' }));

    const antes = anunciado(s);

    expect(antes?.source === 'entry' ? antes.entry.id : null).toBe(primeira);

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    expect(finished.mapAfter?.drawn).toBe(false);
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('ready');
  });

  it('com a fila vazia, aí sim ele sorteia', async () => {
    const s = await scenario();
    const run = execucaoDe(s, plano(s, { mapSource: 'random' }));

    expect(anunciado(s)).toEqual({ source: 'undecided' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.drawn).toBe(true);
  });
});

describe('`keep` num wipe FORÇADO', () => {
  const ILHA = 'https://mapas.exemplo/ilha.map';

  /** O primeiro forçado da agenda, já mandando MANTER o mundo. */
  function forcadoQueMantem(s: Scenario): WipePlan {
    s.schedule.reconcile(SERVER, Date.now());

    const plan = s.schedule
      .listPlans(SERVER, { from: Date.now() })
      .find((candidate) => candidate.kind === 'forced');

    expect(plan).toBeDefined();

    // Direto no repositório: a ROTA recusa gravar isto, e é esse o
    // outro lado desta mesma decisão (ver wipe-plans.test.ts). O
    // que se prende aqui é o plano que já estava gravado quando a
    // trava chegou — e o servidor que virou mapa custom depois.
    return s.schedule.updatePlan(SERVER, (plan as WipePlan).id, { mapSource: 'keep' }, Date.now());
  }

  it('não mantém um `.map` custom sem a marca: o mundo sai da fila', async () => {
    // ####  O DESFECHO QUE `blockedInForced` EXISTE PARA IMPEDIR  ####
    //
    // O forçado troca o binário do jogo. Mantendo o `.map` gerado
    // na versão de ontem, o servidor sobe — ou não sobe — com o
    // arquivo velho, na primeira quinta do mês.
    const s = await scenario({ levelUrl: ILHA });
    const { primeira } = fila(s);
    const plan = forcadoQueMantem(s);
    const op = operation();

    const run = s.runs.create(SERVER, {
      planId: plan.id,
      kind: 'forced',
      bpPolicy: plan.bpPolicy,
    });

    // O chat e a tela do jogo já anunciam a troca, e não "o mesmo
    // mapa de agora".
    const antes = anunciado(s);

    expect(antes?.source === 'entry' ? antes.entry.id : null).toBe(primeira);

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: op,
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    // A chave do `.map` é LIMPA: sem isso o servidor sobe baixando
    // o arquivo velho de novo, e o wipe não troca mundo nenhum.
    expect(s.settings[0]).toMatchObject({ levelUrl: '' });
    expect(logDe(op)).toContain('não pode ficar');
  });

  it('COM a marca no `.map` de agora, o mundo fica', async () => {
    const s = await scenario({ levelUrl: ILHA });

    fila(s);

    // A entrada que virou o mundo de hoje: já consumida, e marcada
    // à mão como compatível com a versão nova.
    const custom = s.mapPool.add(SERVER, { kind: 'custom', level: 'Ilha', levelUrl: ILHA }).entry.id;

    s.mapPool.markVersionOk(SERVER, custom, true);
    s.mapPool.markUsed(SERVER, custom);

    const plan = forcadoQueMantem(s);

    expect(anunciado(s)).toEqual({ source: 'keep' });

    const run = s.runs.create(SERVER, {
      planId: plan.id,
      kind: 'forced',
      bpPolicy: plan.bpPolicy,
    });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(s.settings).toHaveLength(0);
    expect(finished.mapAfter?.levelUrl).toBe(ILHA);
  });

  it('mundo procedural continua sendo mantido no forçado, sem atrito', async () => {
    const s = await scenario();
    const { primeira } = fila(s);
    const plan = forcadoQueMantem(s);

    expect(anunciado(s)).toEqual({ source: 'keep' });

    const run = s.runs.create(SERVER, {
      planId: plan.id,
      kind: 'forced',
      bpPolicy: plan.bpPolicy,
    });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(s.settings).toHaveLength(0);
    expect(finished.mapAfter?.seed).toBe(String(s.config.seed));
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');
  });

  // ==========================================================
  //  E A RETOMADA, QUE NÃO PODE CHEGAR A OUTRA DECISÃO
  // ==========================================================
  //
  //  ####  A DECISÃO DEPENDIA DO ARQUIVO QUE O PASSO REESCREVE  ####
  //
  //  A trava acima lê o mundo de AGORA (`.map` custom sem marca ->
  //  o forçado não mantém), e o próprio passo `configurar`
  //  reescreve esse mundo: `levelurl` sai VAZIA no `.ini` antes de
  //  o resultado chegar ao banco. Entre as duas escritas cabe uma
  //  interrupção — e a retomada, relendo um `.ini` já procedural,
  //  concluía que o `keep` VOLTAVA a valer.
  //
  //  O estrago não é um mapa trocado: é um mundo que veio da FILA
  //  sem que ninguém tenha registrado que veio. A entrada continua
  //  `ready`, o `map_after` não tem `map_pool_id`, e o wipe
  //  seguinte promete — no chat, na tela do jogo, na prévia do
  //  admin e para o executor — o mundo que JÁ ESTÁ no ar.
  describe('a retomada relê a decisão, e não a refaz', () => {
    it('o `.ini` já reescrito não faz o `keep` voltar a valer', async () => {
      const s = await scenario({ levelUrl: ILHA });
      const { primeira, segunda } = fila(s);
      const plan = forcadoQueMantem(s);

      const run = s.runs.create(SERVER, {
        planId: plan.id,
        kind: 'forced',
        bpPolicy: plan.bpPolicy,
      });

      // O que as superfícies anunciam ANTES: a entrada #1.
      const antes = anunciado(s);

      expect(antes?.source === 'entry' ? antes.entry.id : null).toBe(primeira);

      // A interrupção ENTRE o `.ini` e o commit. Ela vale pelas
      // duas: o `commitWorld` lançando, e o agente morrendo com o
      // `.ini` já em disco — nos dois casos o mundo de agora, para
      // quem perguntar em seguida, é o NOVO.
      s.commitErrors.push(new Error('o banco não respondeu'));

      await expect(
        s.runner.run({
          serverId: SERVER,
          runId: run.id,
          operation: operation(),
          control: s.control,
        }),
      ).rejects.toThrow('o banco não respondeu');

      // O `.ini` já é o do mundo da fila, e o banco ainda não sabe
      // de nada: nada consumido, nenhuma marca de idempotência.
      expect(s.settings[0]).toMatchObject({ seed: '11111', levelUrl: '' });
      expect(s.configOf().levelUrl).toBe('');
      expect(s.runs.get(SERVER, run.id)?.mapAfter ?? null).toBeNull();
      expect(s.mapPool.get(SERVER, primeira)?.status).toBe('ready');

      const op = operation();

      const retomado = await s.runner.run({
        serverId: SERVER,
        runId: run.id,
        operation: op,
        control: s.control,
        resume: true,
      });

      // A MESMA decisão da primeira tentativa: o mundo é o da fila,
      // e o passo NÃO virou "manter".
      expect(retomado.mapAfter?.seed).toBe('11111');
      expect(retomado.mapAfter?.mapPoolId).toBe(primeira);
      expect(retomado.mapAfter?.drawn).toBe(false);
      expect(retomado.steps.find((step) => step.step === 'configurar')?.message).not.toContain(
        'MANTER',
      );
      expect(logDe(op)).toContain('já estava escolhido');

      // A fila registrou que a #1 subiu: UMA linha `used`, e ela.
      expect(s.mapPool.get(SERVER, primeira)?.status).toBe('used');
      expect(s.mapPool.list(SERVER).filter((entry) => entry.status === 'used')).toHaveLength(1);

      // ####  E O QUE AS SUPERFÍCIES ANUNCIAM DEPOIS  ####
      //
      // O mundo da #1 está no ar. Com a entrada ainda `ready`, o
      // wipe seguinte prometia ao VIP como "o próximo mundo" o
      // mundo que já estava no ar. A vez agora é da #2.
      const depois = anunciado(s);

      expect(depois?.source === 'entry' ? depois.entry.id : null).toBe(segunda);
    });

    it('a decisão gravada é a que o chat e a tela leem enquanto a execução espera', async () => {
      // O agente que MORRE não marca nada: a linha fica `running`
      // até o boot seguinte chamar `orphan`. Nesse intervalo o
      // `.ini` já é o do mundo novo — e recontar a decisão ali faria
      // a tela do jogo prometer "o mesmo mapa de agora" para um
      // wipe cuja escolha, gravada, é a entrada da fila que a
      // retomada vai subir.
      const s = await scenario({ levelUrl: ILHA });
      const { primeira } = fila(s);
      const plan = forcadoQueMantem(s);

      const run = s.runs.create(SERVER, {
        planId: plan.id,
        kind: 'forced',
        bpPolicy: plan.bpPolicy,
      });

      s.commitErrors.push(new Error('o banco não respondeu'));

      await expect(
        s.runner.run({
          serverId: SERVER,
          runId: run.id,
          operation: operation(),
          control: s.control,
        }),
      ).rejects.toThrow('o banco não respondeu');

      s.runs.update(SERVER, run.id, { status: 'running' });

      const durante = anunciado(s);

      expect(durante?.source === 'entry' ? durante.entry.id : null).toBe(primeira);
    });
  });
});

describe('a agenda depois de uma retomada', () => {
  it('o plano que falhou volta a `done` quando a retomada conclui', async () => {
    // ####  MEDIDO: A AGENDA DIZENDO QUE O WIPE DE ONTEM FALHOU  ####
    //
    // O `UPDATE` do `markPlanStatus` não aceitava sair de
    // `failed`: o wipe acontecia, o mundo trocava, o run ficava
    // `done` — e o plano ficava `failed` para sempre. O admin lê
    // isso e pode disparar um "WIPAR AGORA" que consumiria uma
    // segunda entrada da curadoria.
    const s = await scenario();
    const { primeira } = fila(s);
    const plan = plano(s, { mapSource: 'pool' });
    const run = execucaoDe(s, plan);

    s.settingsErrors.push(new Error('o .ini está aberto em outro programa'));

    await expect(
      s.runner.run({ serverId: SERVER, runId: run.id, operation: operation(), control: s.control }),
    ).rejects.toThrow('o .ini');

    expect(s.schedule.getPlan(SERVER, plan.id)?.status).toBe('failed');

    const retomado = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
      resume: true,
    });

    expect(retomado.status).toBe('done');
    expect(s.schedule.getPlan(SERVER, plan.id)?.status).toBe('done');
    expect(s.mapPool.get(SERVER, primeira)?.status).toBe('used');

    // E o conserto NÃO reabre caminho para o wipe acontecer duas
    // vezes: quem dispara sozinho é o relógio, e ele só enxerga
    // `planned`.
    expect(s.schedule.duePlans(SERVER, Date.now() + 2 * SEMANA)).toHaveLength(0);
  });
});

describe('`pool` e o wipe sem plano continuam na cabeça da fila', () => {
  it('`pool` consome a #1', async () => {
    const s = await scenario();
    const { primeira, segunda } = fila(s);
    const run = execucaoDe(s, plano(s, { mapSource: 'pool' }));

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
    expect(s.mapPool.get(SERVER, segunda)?.status).toBe('ready');
  });

  it('o "WIPAR AGORA" sem plano nenhum também', async () => {
    const s = await scenario();
    const { primeira } = fila(s);
    const run = s.runs.create(SERVER, { kind: 'manual', bpPolicy: 'keep' });

    const finished = await s.runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: operation(),
      control: s.control,
    });

    expect(finished.mapAfter?.mapPoolId).toBe(primeira);
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
