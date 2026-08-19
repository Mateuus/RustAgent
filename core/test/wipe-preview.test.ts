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
  /** A prévia de agora, com o plano e a fila que já foram montados. */
  previa(): Promise<WipePreview>;
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
    previa: () =>
      buildWipePreview({
        serverId: SERVER,
        identity: IDENTITY,
        installDir,
        backupsDir: join(root, 'backups'),
        current: { level: 'Procedural Map', seed: '12345', worldSize: 4000 },
        schedule,
        mapPool,
        exec: runs.getExecSettings(SERVER),
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
