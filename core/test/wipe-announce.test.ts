// ============================================================
//  wipe-announce.test.ts  -  a PONTE entre o wipe e as mensagens.
//
//  O que este arquivo guarda:
//
//    1. os formatos puros: `6 dias e 4 horas`, `quinta, 03/09 às
//       16:00` no fuso do servidor, `mantidos`, `procedural 4000`;
//    2. `{wipe.faltam}` num servidor SEM agenda devolve "sem wipe
//       agendado" — nunca vazio — e `{wipe.faltan}` fica LITERAL;
//    3. `{wipe.faltam}` e a aba Geral leem o MESMO wipe, com a
//       mesma regra de "o próximo que ainda vai acontecer";
//    4. a execução EM CURSO ganha da agenda: durante o run, a
//       variável conta para o wipe que está acontecendo, mesmo
//       quando ele não tem plano nenhum ("WIPAR AGORA");
//    5. o locutor manda o texto CRU mais a aparência, e não formata
//       nada — a marcação é do plugin;
//    6. o locutor deixa a exceção subir: quem decide que um aviso
//       perdido não derruba o wipe é o passo `avisar`, e não ele;
//    7. de ponta a ponta: um wipe daqui a 3 minutos com offsets
//       [2, 1] produz DUAS falas no chat, com o número certo em
//       cada uma.
// ============================================================

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { Broadcaster } from '../src/game/broadcast.js';
import {
  MAP_DRAWN_ON_THE_SPOT,
  NO_WIPE_SCHEDULED,
  currentWipeFacts,
  describeBpPolicy,
  describeMapEntry,
  formatWipeCountdown,
  formatWipeMoment,
  registerWipeVariables,
  resolveWipeVariable,
  type WipeVariablesDeps,
} from '../src/messages/providers/wipe.js';
import { VariableRegistry } from '../src/messages/variables.js';
import { Operation } from '../src/ops/operations.js';
import type { BroadcastInput, BroadcastResult } from '../src/types/messages.js';
import { WipeBroadcastAnnouncer } from '../src/wipe/announce.js';
import { WipeRunner, type WipeServerControl, type WipeServers } from '../src/wipe/run.js';

const SERVER = 'pvp1';
const ZONE = 'America/Sao_Paulo';

/** Quinta, 03/09/2026, 16:00 em São Paulo — o exemplo do Docs/16. */
const WIPE_AT = Date.UTC(2026, 8, 3, 19, 0, 0);

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
//  O cenário: um banco na memória e as três leituras do provedor
// ------------------------------------------------------------

interface Readers extends WipeVariablesDeps {
  readonly db: AgentDatabase;
  readonly scheduleRepo: WipeScheduleRepository;
  readonly runsRepo: WipeRunsRepository;
  readonly poolRepo: MapPoolRepository;
}

function readers(installDir = ''): Readers {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // A agenda tem chave estrangeira para `servers`: sem a linha, o
  // `createPlan` recusaria — e o teste falharia por um motivo que
  // não é o dele.
  new ServersRepository(db).create({
    id: SERVER,
    name: 'PVP 1',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir,
  });

  const scheduleRepo = new WipeScheduleRepository(db);
  const runsRepo = new WipeRunsRepository(db);
  const poolRepo = new MapPoolRepository(db);

  return {
    db,
    schedule: scheduleRepo,
    runs: runsRepo,
    mapPool: poolRepo,
    scheduleRepo,
    runsRepo,
    poolRepo,
  };
}

/** Um `Broadcaster` que só anota o que foi pedido. */
function recorder(): { readonly sent: BroadcastInput[]; readonly broadcaster: Broadcaster } {
  const sent: BroadcastInput[] = [];

  return {
    sent,
    broadcaster: {
      send: (input: BroadcastInput): Promise<BroadcastResult> => {
        sent.push(input);

        return Promise.resolve({ sent: 3, via: 'plugin' });
      },
    },
  };
}

// ------------------------------------------------------------
//  1. Os formatos
// ------------------------------------------------------------

describe('as palavras do aviso', () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  it('escreve quanto falta como o jogador lê', () => {
    expect(formatWipeCountdown(6 * day + 4 * hour + 12 * minute + 33_000)).toBe('6 dias e 4 horas');
    expect(formatWipeCountdown(day)).toBe('1 dia');
    expect(formatWipeCountdown(2 * day + 30 * minute)).toBe('2 dias');
    expect(formatWipeCountdown(hour + 5 * minute)).toBe('1 hora e 5 minutos');
    expect(formatWipeCountdown(15 * minute)).toBe('15 minutos');
    expect(formatWipeCountdown(minute)).toBe('1 minuto');
    expect(formatWipeCountdown(20_000)).toBe('menos de um minuto');
    expect(formatWipeCountdown(0)).toBe('agora');
    expect(formatWipeCountdown(-5_000)).toBe('agora');
  });

  it('arredonda para o minuto: o aviso de 1 hora não sai como "59 minutos"', () => {
    // O `await` do passo `avisar` acorda alguns milissegundos DEPOIS
    // da hora exata. Com truncamento a fala mentiria por um minuto,
    // e justamente naquela cujo motivo de existir é dizer "uma hora".
    expect(formatWipeCountdown(hour - 120)).toBe('1 hora');
    expect(formatWipeCountdown(15 * minute - 350)).toBe('15 minutos');
  });

  it('escreve a data no fuso do SERVIDOR, e não no do host', () => {
    expect(formatWipeMoment(WIPE_AT, ZONE)).toBe('quinta, 03/09 às 16:00');
    // O mesmo instante lido em UTC. O jogador brasileiro veria a
    // hora errada se o fuso viesse do relógio da máquina.
    expect(formatWipeMoment(WIPE_AT, 'UTC')).toBe('quinta, 03/09 às 19:00');
  });

  it('diz o que acontece com os blueprints em uma palavra', () => {
    expect(describeBpPolicy('keep')).toBe('mantidos');
    expect(describeBpPolicy('wipe')).toBe('zerados');
    expect(describeBpPolicy('wipe_except_vip')).toBe('mantidos só para quem tem VIP');
  });

  it('descreve o mapa SEM a seed', () => {
    const described = describeMapEntry({
      kind: 'procedural',
      level: 'Procedural Map',
      worldSize: 4_000,
    });

    expect(described).toBe('procedural 4000');
    // A seed abre o RustMaps e entrega cada monumento dias antes do
    // wipe. Ela é decisão de produto da tela do jogo (Docs/16 §9.3),
    // e não de uma variável que vai para o chat de todo mundo.
    expect(described).not.toContain('18422');

    expect(describeMapEntry({ kind: 'procedural', level: 'Barren', worldSize: 3_000 })).toBe(
      'Barren 3000',
    );
    expect(describeMapEntry({ kind: 'custom', level: null, worldSize: null })).toBe('mapa custom');
  });
});

// ------------------------------------------------------------
//  2. Sem agenda, e o nome que não existe
// ------------------------------------------------------------

describe('o servidor sem wipe à vista', () => {
  it('devolve uma frase, e nunca vazio', async () => {
    const shared = readers();
    const registry = new VariableRegistry();

    registerWipeVariables(registry, shared, () => WIPE_AT);

    expect(await registry.resolve('O wipe é em {wipe.faltam}.', { serverId: SERVER })).toBe(
      `O wipe é em ${NO_WIPE_SCHEDULED}.`,
    );

    for (const name of ['faltam', 'quando', 'mapa', 'bp']) {
      expect(resolveWipeVariable(name, null, WIPE_AT)).toBe(NO_WIPE_SCHEDULED);
    }

    shared.db.close();
  });

  it('deixa LITERAL o nome que não é nosso', async () => {
    const shared = readers();
    const registry = new VariableRegistry();

    registerWipeVariables(registry, shared, () => WIPE_AT);

    // Feio de propósito: o admin VÊ e conserta em dez segundos. Uma
    // frase que perde metade em silêncio ele descobre semanas
    // depois — ou nunca.
    expect(await registry.resolve('em {wipe.faltan}', { serverId: SERVER })).toBe(
      'em {wipe.faltan}',
    );
    expect(resolveWipeVariable('faltan', null, WIPE_AT)).toBeNull();

    shared.db.close();
  });

  it('anuncia os quatro nomes ao editor de mensagens', () => {
    const shared = readers();
    const registry = new VariableRegistry();

    registerWipeVariables(registry, shared, () => WIPE_AT);

    // O editor lista o que o REGISTRO conhece. Sem os nomes exatos
    // ele mostraria só `{wipe.…}`, e o admin não teria onde
    // descobrir que a variável se chama `faltam`.
    expect(registry.namespaces()).toContain('wipe');
    expect(registry.names()).toEqual([
      'wipe.bp',
      'wipe.faltam',
      'wipe.mapa',
      'wipe.quando',
    ]);

    shared.db.close();
  });
});

// ------------------------------------------------------------
//  3 e 4. De onde os fatos vêm
// ------------------------------------------------------------

describe('qual wipe as variáveis estão descrevendo', () => {
  it('lê o próximo plano da agenda, com a mesma regra da aba Geral', async () => {
    const shared = readers();
    const now = WIPE_AT - 6 * 86_400_000 - 4 * 3_600_000 - 12 * 60_000;

    shared.scheduleRepo.createPlan(
      SERVER,
      { scheduledAt: WIPE_AT, bpPolicy: 'keep', mapSource: 'pool' },
      now,
    );

    const facts = currentWipeFacts(SERVER, shared, now);

    expect(facts?.wipeAt).toBe(WIPE_AT);
    expect(facts?.bpPolicy).toBe('keep');

    const registry = new VariableRegistry();

    registerWipeVariables(registry, shared, () => now);

    // O mesmo wipe e o mesmo número que a contagem `06d 04h 12m` da
    // aba Geral, cortada em dias e horas para caber numa frase.
    expect(
      await registry.resolve('{wipe.faltam} · {wipe.quando} · {wipe.bp} · {wipe.mapa}', {
        serverId: SERVER,
      }),
    ).toBe(`6 dias e 4 horas · quinta, 03/09 às 16:00 · mantidos · ${MAP_DRAWN_ON_THE_SPOT}`);

    shared.db.close();
  });

  it('não anuncia o wipe que já passou nem o que foi pulado', () => {
    const shared = readers();
    const now = WIPE_AT - 3_600_000;

    const passado = shared.scheduleRepo.createPlan(
      SERVER,
      { scheduledAt: WIPE_AT - 7 * 86_400_000, bpPolicy: 'keep' },
      WIPE_AT - 8 * 86_400_000,
    );

    shared.scheduleRepo.markPlanStatus(SERVER, passado.id, 'done');

    // Um wipe pulado (e um absorvido pelo forçado) continua na
    // tabela para explicar um dia sem wipe — e é justamente por isso
    // que ele não pode ser anunciado como se fosse acontecer.
    const pulado = shared.scheduleRepo.createPlan(
      SERVER,
      { scheduledAt: WIPE_AT - 60_000, bpPolicy: 'keep' },
      now - 86_400_000,
    );

    shared.scheduleRepo.skipPlan(SERVER, pulado.id, now);

    expect(currentWipeFacts(SERVER, shared, now)).toBeNull();

    shared.scheduleRepo.createPlan(SERVER, { scheduledAt: WIPE_AT, bpPolicy: 'wipe' }, now);

    expect(currentWipeFacts(SERVER, shared, now)?.wipeAt).toBe(WIPE_AT);

    shared.db.close();
  });

  it('anuncia o mapa da fila quando há um pronto', () => {
    const shared = readers();
    const now = WIPE_AT - 3_600_000;

    shared.poolRepo.add(SERVER, { seed: '18422', worldSize: 4_000 }, now);
    shared.scheduleRepo.createPlan(
      SERVER,
      { scheduledAt: WIPE_AT, bpPolicy: 'wipe', mapSource: 'pool' },
      now,
    );

    expect(currentWipeFacts(SERVER, shared, now)?.map).toBe('procedural 4000');

    shared.db.close();
  });

  it('a execução em curso ganha da agenda — inclusive sem plano nenhum', () => {
    const shared = readers();
    const now = WIPE_AT - 15 * 60_000;

    // Um "WIPAR AGORA" marcado para daqui a 15 minutos NÃO tem linha
    // em `wipe_plans`. Sem o desempate pela execução, o aviso sairia
    // dizendo "WIPE em sem wipe agendado".
    shared.runsRepo.create(
      SERVER,
      { kind: 'manual', bpPolicy: 'wipe_except_vip', wipeAt: WIPE_AT },
      now,
    );

    const facts = currentWipeFacts(SERVER, shared, now);

    expect(facts?.wipeAt).toBe(WIPE_AT);
    expect(facts?.kind).toBe('manual');
    expect(resolveWipeVariable('faltam', facts, now)).toBe('15 minutos');
    expect(resolveWipeVariable('bp', facts, now)).toBe('mantidos só para quem tem VIP');

    shared.db.close();
  });

  it('depois de "configurar", o mapa anunciado é o mundo JÁ escolhido', () => {
    const shared = readers();
    const now = WIPE_AT - 60_000;

    const run = shared.runsRepo.create(
      SERVER,
      { kind: 'cadence', bpPolicy: 'keep', wipeAt: WIPE_AT },
      now,
    );

    shared.runsRepo.update(SERVER, run.id, {
      mapAfter: { level: 'Procedural Map', seed: '18422', worldSize: 3_500 },
    });

    // A fila já foi consumida: olhar para ela agora mostraria o
    // mundo do wipe SEGUINTE.
    expect(currentWipeFacts(SERVER, shared, now)?.map).toBe('procedural 3500');

    shared.db.close();
  });
});

// ------------------------------------------------------------
//  5 e 6. O locutor
// ------------------------------------------------------------

describe('o locutor', () => {
  const look = {
    offsetsMinutes: [15],
    text: 'WIPE em {wipe.faltam}.',
    tag: 'WIPE',
    tagColor: '#ff4444',
    color: '#ffffff',
    size: 15,
  };

  function offset(text = look.text) {
    return {
      serverId: SERVER,
      runId: 1,
      wipeAt: WIPE_AT,
      now: WIPE_AT - 15 * 60_000,
      offsetMinutes: 15,
      kind: 'cadence' as const,
      bpPolicy: 'keep' as const,
      settings: { ...look, text },
    };
  }

  it('manda o texto CRU mais a aparência — quem formata é o plugin', async () => {
    const chat = recorder();
    const registry = new VariableRegistry();

    registry.setNamespace('wipe', (rest) => (rest === 'faltam' ? '15 minutos' : null));

    await new WipeBroadcastAnnouncer({
      broadcaster: chat.broadcaster,
      variables: registry,
    }).announceOffset(offset());

    expect(chat.sent).toHaveLength(1);

    const fala = chat.sent[0];

    expect(fala?.text).toBe('WIPE em 15 minutos.');
    // A tag viaja em CAMPO, e não colada na frente da frase: quem
    // monta o `[WIPE]` colorido é o plugin. Formatar dos dois lados
    // criaria duas verdades sobre como um aviso se parece.
    expect(fala?.text).not.toContain('[WIPE]');
    expect(fala?.text).not.toContain('<color');
    expect(fala?.text).not.toContain('<size');
    expect(fala?.tag).toBe('WIPE');
    expect(fala?.tagColor).toBe('#ff4444');
    expect(fala?.color).toBe('#ffffff');
    expect(fala?.size).toBe(15);
    // Um aviso de wipe é para o servidor inteiro, e não para um
    // jogador: com `steamId` o fallback do `say` seria recusado.
    expect(fala?.steamId).toBeUndefined();
  });

  it('não fala quando o admin apagou o texto', async () => {
    const chat = recorder();

    await new WipeBroadcastAnnouncer({
      broadcaster: chat.broadcaster,
      variables: new VariableRegistry(),
    }).announceOffset(offset('   '));

    expect(chat.sent).toHaveLength(0);
  });

  it('deixa a exceção subir: quem perdoa o aviso perdido é o passo `avisar`', async () => {
    const announcer = new WipeBroadcastAnnouncer({
      broadcaster: { send: () => Promise.reject(new Error('RCON_UNAVAILABLE')) },
      variables: new VariableRegistry(),
    });

    await expect(announcer.announceOffset(offset())).rejects.toThrow('RCON_UNAVAILABLE');
  });
});

// ------------------------------------------------------------
//  7. De ponta a ponta, pela máquina de passos de verdade
// ------------------------------------------------------------

describe('um wipe daqui a 3 minutos, com avisos em 2 e 1 minuto', () => {
  it('produz as duas falas, cada uma com o número certo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rustagent-announce-'));

    temporary.push(root);

    const installDir = join(root, 'servidor');
    const saveDir = join(installDir, 'server', SERVER);

    await mkdir(saveDir, { recursive: true });
    await writeFile(join(saveDir, 'proceduralmap.4000.12345.287.map'), 'mapa\n'.repeat(50));
    await writeFile(join(saveDir, 'proceduralmap.4000.12345.287.sav'), 'save\n'.repeat(50));

    vi.useFakeTimers();

    const start = Date.UTC(2026, 8, 3, 15, 57, 0);

    vi.setSystemTime(start);

    const shared = readers(installDir);
    const chat = recorder();
    const registry = new VariableRegistry();

    registerWipeVariables(registry, shared, () => Date.now());

    const wipeAt = start + 3 * 60_000;
    const base = shared.runsRepo.getExecSettings(SERVER);

    shared.runsRepo.saveExecSettings(SERVER, {
      ...base,
      announce: {
        offsetsMinutes: [2, 1],
        text: 'WIPE em {wipe.faltam}. Blueprints: {wipe.bp}.',
        tag: 'WIPE',
        tagColor: '#ff4444',
        color: '#ffffff',
        size: 15,
      },
      // O resto do wipe não é assunto deste teste: sem esvaziar, sem
      // backup e sem anúncio do mundo novo.
      drain: { enabled: false, waitMinutes: 0, force: false },
      backup: { enabled: false, keep: 3 },
      post: { resync: false, announce: false, announceText: '' },
    });

    const run = shared.runsRepo.create(
      SERVER,
      { kind: 'cadence', bpPolicy: 'keep', wipeAt },
      start,
    );

    const runner = new WipeRunner({
      runs: shared.runsRepo,
      wipes: new WipesRepository(shared.db),
      schedule: shared.scheduleRepo,
      mapPool: shared.poolRepo,
      servers: serversOf(root, installDir),
      world: { forget: () => undefined, saveCreatedAt: () => Promise.resolve(2_000) },
      announcer: new WipeBroadcastAnnouncer({
        broadcaster: chat.broadcaster,
        variables: registry,
      }),
    });

    const promise = runner.run({
      serverId: SERVER,
      runId: run.id,
      operation: new Operation('wipe-run', SERVER),
      control: stoppedServer(),
    });

    // `advanceTimersByTimeAsync` resolve os `setTimeout` do passo
    // `avisar` na ordem, e cada fala é montada com o `Date.now()`
    // daquele instante — que é o ponto do teste.
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    const finished = await promise;

    expect(chat.sent.map((fala) => fala.text)).toEqual([
      'WIPE em 2 minutos. Blueprints: mantidos.',
      'WIPE em 1 minuto. Blueprints: mantidos.',
    ]);

    const avisar = finished.steps.find((step) => step.step === 'avisar');

    expect(avisar?.status).toBe('done');
    // A marca do que já saiu fica no passo, e não na memória do
    // locutor: é ela que impede o agente, reiniciado entre dois
    // offsets, de reenviar o aviso de 2 minutos.
    expect(avisar?.message).toContain('2 aviso(s)');

    shared.db.close();
  });
});

/** Um supervisor de mentira: nada aqui escreve `.ini`. */
function serversOf(root: string, installDir: string): WipeServers {
  const config = {
    id: SERVER,
    name: 'PVP 1',
    hostname: 'PVP 1',
    identity: SERVER,
    level: 'Procedural Map',
    seed: 12_345,
    worldSize: 4_000,
    levelUrl: '',
    maxPlayers: 200,
    paths: {
      configPath: join(root, 'pvp1.ini'),
      installDir,
      exePath: join(installDir, 'RustDedicated.exe'),
      oxideConfigDir: join(installDir, 'oxide', 'config'),
      pluginsDir: join(installDir, 'oxide', 'plugins'),
      logsDir: join(root, 'logs'),
      backupsDir: join(root, 'backups'),
    },
  } as unknown as ServerConfig;

  return { configOf: () => config, updateSettings: () => [] };
}

/** Um servidor de mentira: já parado, e sem ninguém dentro. */
function stoppedServer(): WipeServerControl {
  return {
    isRunning: () => Promise.resolve(false),
    stop: () => Promise.resolve(),
    start: () => Promise.resolve(),
    online: () => Promise.resolve(0),
    rconConnected: true,
  };
}
