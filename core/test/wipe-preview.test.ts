// ============================================================
//  wipe-preview.test.ts  -  a TELA DE CONFIRMAÇÃO diz o que o
//  wipe vai fazer.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO PRENDE  ####
//
//  `buildWipePreview` perguntava à fila de mapas qual é a cabeça
//  dela, e chamava isso de "o mundo que entra". Enquanto o
//  executor perguntava a mesma coisa, a resposta batia. Desde que
//  ele passou a respeitar o `mapSource` do plano (`mapOfPlan`),
//  esta tela — a ÚLTIMA que o admin lê antes de apertar o botão
//  que zera o servidor — passou a prometer outra coisa:
//
//    · plano `keep`, que não toca a fila, prometendo a cabeça
//      dela;
//    · plano `fixed` apontando a #2, prometendo a #1;
//    · e, pior, o aviso EMPTY_MAP_POOL dizendo "o agente sorteia
//      uma seed, registra que sorteou e segue" num wipe `keep`,
//      que não sorteia nem grava nada.
//
//  Um aviso que descreve o que NÃO vai acontecer é pior do que
//  aviso nenhum: o admin decide com base nele.
//
//  Nada aqui escreve em servidor nenhum: a prévia é leitura pura,
//  contra pastas temporárias e banco em memória.
// ============================================================

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { MapPoolRepository } from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import { WipeScheduleRepository } from '../src/db/wipe-schedule-repository.js';
import type { MapSource } from '../src/types/wipe.js';
import { buildWipePreview, type WipePreview } from '../src/wipe/preview.js';

const SERVER = 'pvp1';
const IDENTITY = 'pvp1';
const SEMANA = 7 * 24 * 60 * 60 * 1000;

const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Bancada {
  readonly schedule: WipeScheduleRepository;
  readonly mapPool: MapPoolRepository;
  /** As execuções: é delas que sai o wipe EM CURSO. */
  readonly runs: WipeRunsRepository;
  /** A pasta do servidor, para plantar o que o full wipe varre. */
  readonly installDir: string;
  /** A prévia de agora, com o plano e a fila que já foram montados. */
  previa(options?: {
    /** O `.map` de fora que o servidor está rodando agora. */
    readonly levelUrl?: string;
    /** O relógio da prévia, para andar para depois da hora do wipe. */
    readonly now?: number;
  }): Promise<WipePreview>;
}

async function bancada(): Promise<Bancada> {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-previa-'));

  temporary.push(root);

  const installDir = join(root, 'servidor');
  const saveDir = join(installDir, 'server', IDENTITY);

  await mkdir(saveDir, { recursive: true });
  await writeFile(join(saveDir, 'proceduralmap.4000.12345.287.sav'), 'mundo');

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

  const schedule = new WipeScheduleRepository(db);
  const mapPool = new MapPoolRepository(db);
  const runs = new WipeRunsRepository(db);

  return {
    schedule,
    mapPool,
    runs,
    installDir,
    previa: (options = {}) =>
      buildWipePreview({
        serverId: SERVER,
        identity: IDENTITY,
        installDir,
        backupsDir: join(root, 'backups'),
        current: {
          level: 'Procedural Map',
          seed: '12345',
          worldSize: 4000,
          levelUrl: options.levelUrl ?? null,
        },
        schedule,
        // A MESMA ligação que a rota faz: a prévia enxerga a
        // execução em curso, como o chat e a tela do jogo enxergam.
        runs,
        mapPool,
        exec: runs.getExecSettings(SERVER),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
  };
}

/** Duas entradas prontas, na ordem: a #1 e a #2 da fila. */
function fila(b: Bancada): { readonly primeira: number; readonly segunda: number } {
  return {
    primeira: b.mapPool.add(SERVER, { seed: '11111', worldSize: 4000 }).entry.id,
    segunda: b.mapPool.add(SERVER, { seed: '22222', worldSize: 3000 }).entry.id,
  };
}

/** O wipe marcado que a prévia vai descrever. */
function plano(b: Bancada, mapSource: MapSource, mapPoolId: number | null = null): void {
  b.schedule.createPlan(
    SERVER,
    { scheduledAt: Date.now() + SEMANA, bpPolicy: 'keep', mapSource, mapPoolId },
    Date.now(),
  );
}

/** Só os códigos: a frase é asserção à parte, quando ela importa. */
function codigos(preview: WipePreview): readonly string[] {
  return preview.warnings.map((notice) => notice.code);
}

describe('a prévia responde o MESMO mundo que o executor vai subir', () => {
  it('com `keep`, ela não promete a cabeça da fila', async () => {
    // Medido: plano `keep` e fila 4000/3500 — a prévia dizia que o
    // próximo mundo era o 4000, e o wipe mantém o mundo de agora
    // sem tocar na fila.
    const b = await bancada();
    const { primeira } = fila(b);

    plano(b, 'keep');

    const preview = await b.previa();

    expect(preview.nextMap).toBeNull();
    expect(codigos(preview)).toContain('MAP_KEPT');
    expect(JSON.stringify(preview.warnings)).not.toContain(String(primeira));
  });

  it('com `keep` e a fila VAZIA, o aviso do sorteio NÃO sai', async () => {
    // ####  O AVISO QUE DESCREVIA OUTRO WIPE  ####
    //
    // "o agente sorteia uma seed, registra que sorteou e segue" —
    // e com `keep` nada é sorteado e nada é gravado. O painel
    // renderiza essa frase no bloco "Antes de seguir:", e é com
    // ela que o admin decide.
    const b = await bancada();

    plano(b, 'keep');

    const preview = await b.previa();

    expect(codigos(preview)).not.toContain('EMPTY_MAP_POOL');
    expect(codigos(preview)).toContain('MAP_KEPT');
    expect(JSON.stringify(preview.warnings)).not.toContain('sorteia uma seed');
  });

  it('com `fixed`, é a entrada APONTADA, e não a cabeça da fila', async () => {
    const b = await bancada();
    const { segunda } = fila(b);

    plano(b, 'fixed', segunda);

    const preview = await b.previa();

    expect(preview.nextMap?.id).toBe(segunda);
    expect(preview.nextMap?.seed).toBe('22222');
    // O registro inteiro atravessa: a tela mostra a nota e a
    // prévia da entrada, e não só o id dela.
    expect(preview.nextMap).toHaveProperty('updatedAt');
    expect(codigos(preview)).not.toContain('PINNED_MAP_UNUSABLE');
  });

  it('com o ponteiro morto, ela mostra a queda E diz por quê', async () => {
    // A entrada apontada sumiu da fila: o wipe acontece com a
    // cabeça dela — cair é de propósito —, mas quem escolheu a
    // dedo precisa saber ANTES que o mundo dele não vai subir.
    const b = await bancada();
    const { primeira, segunda } = fila(b);

    plano(b, 'fixed', segunda);
    b.mapPool.remove(SERVER, segunda);

    const preview = await b.previa();
    const aviso = preview.warnings.find((notice) => notice.code === 'PINNED_MAP_UNUSABLE');

    expect(preview.nextMap?.id).toBe(primeira);
    expect(aviso?.message).toContain(`#${String(segunda)}`);
    expect(aviso?.message).toContain('não está mais na fila');
  });

  it('com `pool`, continua sendo a cabeça da fila', async () => {
    const b = await bancada();
    const { primeira } = fila(b);

    plano(b, 'pool');

    const preview = await b.previa();

    expect(preview.nextMap?.id).toBe(primeira);
    expect(codigos(preview)).not.toContain('EMPTY_MAP_POOL');
    expect(codigos(preview)).not.toContain('MAP_KEPT');
  });

  it('com `random`, ela mostra a CABEÇA da fila — e não um sorteio', async () => {
    // `random` segue a fila como o `pool`: a etiqueta diz o que o
    // admin quis, e não o que o agente faz.
    const b = await bancada();
    const { primeira } = fila(b);

    plano(b, 'random');

    const preview = await b.previa();

    expect(preview.nextMap?.id).toBe(primeira);
    expect(codigos(preview)).not.toContain('EMPTY_MAP_POOL');
  });

  it('sem plano nenhum e sem fila, o aviso do sorteio é VERDADE', async () => {
    // O "WIPAR AGORA": não há plano a respeitar, a fila é a
    // resposta, e uma fila sem nada utilizável sorteia mesmo.
    const b = await bancada();
    const preview = await b.previa();

    expect(preview.nextMap).toBeNull();
    expect(codigos(preview)).toContain('EMPTY_MAP_POOL');
    expect(codigos(preview)).not.toContain('MAP_KEPT');
  });
});

// ============================================================
//  A PRÉVIA DESCREVE O WIPE EM CURSO, E NÃO O SEGUINTE
//
//  ####  O DEFEITO QUE ESTA SEÇÃO PRENDE  ####
//
//  `buildWipePreview` descobria o plano por `schedule.nextPlan`,
//  que exige `status = 'planned' AND scheduled_at > now`. O
//  relógio marca o plano `running` ao CRIAR a execução, com a
//  antecedência do maior offset de aviso — 1440 minutos, no
//  padrão. Nas 24 h que antecedem TODO wipe agendado a prévia
//  perdia o plano em curso e respondia o da SEMANA QUE VEM:
//  mundo errado, `bpPolicy` errada — e, com ela, a lista de
//  arquivos classificada pela política de outro wipe — e o aviso
//  MAP_KEPT sumindo da última tela que o admin lê antes do botão.
//
//  É a mesma classe do defeito lá de cima, deslocada no tempo: o
//  chat, a tela do jogo e o executor já leem a execução em curso
//  ANTES da agenda (`mapOfRun` -> `mapOfPlan`).
// ============================================================

const HORA = 60 * 60 * 1000;

describe('a prévia descreve o wipe EM CURSO', () => {
  it('nas 24 h do wipe de hoje, ela não responde o da semana que vem', async () => {
    const b = await bancada();
    const { segunda } = fila(b);

    // O de hoje: manter o mundo, blueprints intactos. Ele está
    // `running` porque a execução já começou — faltam 6 horas.
    const hoje = b.schedule.createPlan(
      SERVER,
      { scheduledAt: Date.now() + 6 * HORA, bpPolicy: 'keep', mapSource: 'keep' },
      Date.now(),
    );

    // E o da semana que vem: outro mundo, outra política.
    b.schedule.createPlan(
      SERVER,
      {
        scheduledAt: Date.now() + SEMANA,
        bpPolicy: 'wipe',
        mapSource: 'fixed',
        mapPoolId: segunda,
      },
      Date.now(),
    );

    b.schedule.markPlanStatus(SERVER, hoje.id, 'running');

    const preview = await b.previa();

    expect(preview.plan?.id).toBe(hoje.id);
    expect(preview.bpPolicy).toBe('keep');
    // O mundo é o mantido, e não o `.map` da semana que vem.
    expect(preview.nextMap).toBeNull();
    expect(codigos(preview)).toContain('MAP_KEPT');
    expect(codigos(preview)).not.toContain('BLUEPRINTS_WIPED');
  });

  it('com a hora do wipe já passada, quem responde é a execução', async () => {
    // O plano `running` cuja hora chegou sai do recorte da agenda
    // (`from: now`), e aí só a execução sabe dele. É o instante em
    // que o admin abre a tela para ver o que está acontecendo.
    const b = await bancada();
    const { primeira } = fila(b);

    const hoje = b.schedule.createPlan(
      SERVER,
      { scheduledAt: Date.now() + HORA, bpPolicy: 'wipe', mapSource: 'pool' },
      Date.now(),
    );

    b.schedule.markPlanStatus(SERVER, hoje.id, 'running');
    b.runs.create(SERVER, { planId: hoje.id, kind: 'cadence', bpPolicy: 'wipe' });

    const preview = await b.previa({ now: Date.now() + 2 * HORA });

    expect(preview.plan?.id).toBe(hoje.id);
    expect(preview.bpPolicy).toBe('wipe');
    expect(preview.nextMap?.id).toBe(primeira);
    expect(codigos(preview)).toContain('BLUEPRINTS_WIPED');
  });
});

describe('`keep` num wipe FORÇADO, na tela que vem antes do botão', () => {
  const ILHA = 'https://mapas.exemplo/ilha.map';

  /** O forçado da agenda, mandando MANTER o mundo. */
  function forcadoQueMantem(b: Bancada): void {
    b.schedule.reconcile(SERVER, Date.now());

    const plan = b.schedule
      .listPlans(SERVER, { from: Date.now() })
      .find((candidate) => candidate.kind === 'forced');

    expect(plan).toBeDefined();

    b.schedule.updatePlan(SERVER, plan?.id ?? 0, { mapSource: 'keep' }, Date.now());
  }

  it('com `.map` custom sem a marca, ela recusa o `keep` e mostra a fila', async () => {
    const b = await bancada();
    const { primeira } = fila(b);

    forcadoQueMantem(b);

    const preview = await b.previa({ levelUrl: ILHA });
    const aviso = preview.warnings.find((notice) => notice.code === 'KEEP_REFUSED_IN_FORCED');

    expect(preview.nextMap?.id).toBe(primeira);
    expect(codigos(preview)).not.toContain('MAP_KEPT');
    expect(aviso?.message).toContain('compatível com a versão nova');
    // E ele NÃO trava o wipe: o forçado acontece de qualquer jeito.
    expect(preview.blockers).toHaveLength(0);
  });

  it('com a marca no `.map` de agora, o mundo mantido volta a ser verdade', async () => {
    const b = await bancada();

    fila(b);

    const custom = b.mapPool.add(SERVER, { kind: 'custom', level: 'Ilha', levelUrl: ILHA }).entry.id;

    b.mapPool.markVersionOk(SERVER, custom, true);
    b.mapPool.markUsed(SERVER, custom);

    forcadoQueMantem(b);

    const preview = await b.previa({ levelUrl: ILHA });

    expect(preview.nextMap).toBeNull();
    expect(codigos(preview)).toContain('MAP_KEPT');
    expect(codigos(preview)).not.toContain('KEEP_REFUSED_IN_FORCED');
  });

  it('mundo procedural continua sendo mantido no forçado', async () => {
    const b = await bancada();

    fila(b);
    forcadoQueMantem(b);

    const preview = await b.previa();

    expect(codigos(preview)).toContain('MAP_KEPT');
    expect(codigos(preview)).not.toContain('KEEP_REFUSED_IN_FORCED');
  });
});

// ============================================================
//  ####  O QUE A LISTA DO FULL WIPE NÃO ESTÁ MOSTRANDO  ####
//
//  A prévia é a ÚLTIMA tela antes do botão. Uma lista de 500
//  linhas que na verdade tem 600 arquivos, ou uma pasta funda que
//  a varredura nem abriu, precisam sair escritos aqui — senão o
//  admin decide achando que aquilo é tudo o que existe.
// ============================================================

/** Liga o full wipe com os padrões que o admin marcou. */
function fullWipe(b: Bancada, patterns: readonly string[]): void {
  const base = b.runs.getExecSettings(SERVER);

  b.runs.saveExecSettings(
    SERVER,
    { ...base, pluginData: { enabled: true, patterns: [...patterns] } },
    Date.now(),
  );
}

describe('a prévia conta o que a lista do full wipe NÃO mostrou', () => {
  it('lista cortada vira aviso, com o total de verdade', async () => {
    const b = await bancada();
    const pasta = join(b.installDir, 'oxide', 'data', 'PlayerDatabase');

    await mkdir(pasta, { recursive: true });

    for (let i = 0; i < 600; i += 1) {
      await writeFile(join(pasta, `7656119800000${String(i).padStart(4, '0')}.json`), '{}');
    }

    fullWipe(b, ['oxide/data/PlayerDatabase/*.json']);

    const preview = await b.previa();
    const aviso = preview.warnings.find((notice) => notice.code === 'PLUGIN_DATA_TRUNCATED');

    expect(preview.pluginData.truncated).toBe(true);
    expect(preview.pluginData.total).toBe(600);
    expect(aviso?.message).toContain('600');
  });

  it('pasta funda demais vira aviso, com o caminho que ficou de fora', async () => {
    const b = await bancada();
    const fundo = join(b.installDir, 'oxide', 'data', 'n1', 'n2', 'n3', 'n4');

    await mkdir(fundo, { recursive: true });
    await writeFile(join(fundo, 'nivel4.json'), '{}');

    fullWipe(b, ['oxide/data/**/*.json']);

    const preview = await b.previa();
    const aviso = preview.warnings.find((notice) => notice.code === 'PLUGIN_DATA_TOO_DEEP');

    expect(preview.pluginData.notScanned).toContain('oxide/data/n1/n2/n3/n4');
    expect(aviso?.message).toContain('oxide/data/n1/n2/n3/n4');
  });

  it('sem nada escondido, nenhum dos dois avisos sai', async () => {
    const b = await bancada();

    await mkdir(join(b.installDir, 'oxide', 'data'), { recursive: true });
    await writeFile(join(b.installDir, 'oxide', 'data', 'Economics.json'), '{}');

    fullWipe(b, ['oxide/data/**/*.json']);

    const codes = codigos(await b.previa());

    expect(codes).not.toContain('PLUGIN_DATA_TRUNCATED');
    expect(codes).not.toContain('PLUGIN_DATA_TOO_DEEP');
  });
});
