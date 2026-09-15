// ============================================================
//  O domínio de território, do lado do agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O KOTH falha do mesmo jeito silencioso do agendador: nada quebra,
//  o evento simplesmente não acontece — ou acontece e ninguém
//  registra. Os casos abaixo são os que produzem esse silêncio:
//
//    run aberta sem evento     o comando falhou e a linha ficou
//                              "ativa", e o painel diz "1 no ar"
//                              com o mapa vazio para sempre
//    dois de pé                o segundo start passa por cima do
//                              primeiro sem ninguém notar
//    território de outro mapa  o x/z de ontem é fundo de lago hoje
//    sorteio repetido          o mesmo lugar três vezes seguidas, e
//                              o servidor acampa lá
//    aviso forjado             um jogador digita `#OZKOTH#` no chat
//                              e encerra o evento alheio
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { KothArenasRepository } from '../src/db/koth-arenas-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WorldEventsRepository } from '../src/db/world-events-repository.js';
import { KothCommandError, KothService, KOTH_MARKER } from '../src/game/koth.js';
import { kothArenaInputSchema } from '../src/types/koth.js';

const silent = pino({ level: 'silent' });
const SERVER = 'server01';
const WORLD = '4000:1234';

interface Harness {
  readonly service: KothService;
  readonly arenas: KothArenasRepository;
  readonly events: WorldEventsRepository;
  readonly sent: string[];
  readonly said: string[];
  readonly replies: Map<string, string>;
  connected: boolean;
  world: string | null;
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: 'Dev',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\devserver',
  });

  const arenas = new KothArenasRepository(db);
  const events = new WorldEventsRepository(db, silent);

  const state: Harness = {
    service: null as unknown as KothService,
    arenas,
    events,
    sent: [],
    said: [],
    // ####  O `status` NÃO ESTÁ AQUI, E ISSO É DE PROPÓSITO  ####
    //
    // Ele é derivado do banco lá embaixo: o "jogo" deste teste
    // responde que há um território de pé quando um foi erguido. Uma
    // resposta fixa faria a reconciliação fechar, no teste, uma run
    // que o próprio teste acabou de abrir — e o teste passaria a
    // medir o harness, não o código.
    //
    // Quem precisa de outra resposta a escreve no `replies`, e ela
    // ganha: é o caso do KOTH órfão.
    replies: new Map([
      ['origemz.koth start', JSON.stringify({ ok: true, runId: '1', grid: 'E7', y: 12 })],
      ['origemz.koth stop', JSON.stringify({ ok: true })],
      ['origemz.koth sync', JSON.stringify({ ok: true, active: false })],
    ]),
    connected: true,
    world: WORLD,
  };

  const service = new KothService({
    arenas,
    events,
    servers: {
      ids: () => [SERVER],
      worldKey: () => state.world,
      contextOf: () => ({
        rcon: {
          get isConnected() {
            return state.connected;
          },
          send: (command: string) => {
            state.sent.push(command);

            for (const [prefix, reply] of state.replies) {
              if (command.startsWith(prefix)) return Promise.resolve(reply);
            }

            if (command.startsWith('origemz.koth status')) {
              const open = events.activeRun(SERVER);

              return Promise.resolve(
                JSON.stringify(
                  open === null
                    ? { ok: true, active: false }
                    : { ok: true, active: true, runId: String(open.id) },
                ),
              );
            }

            return Promise.resolve('');
          },
        },
      }),
    },
    logger: silent,
    announce: (_serverId, message) => {
      state.said.push(message);

      return Promise.resolve();
    },
  });

  return Object.assign(state, { service });
}

function arena(h: Harness, patch: Record<string, unknown> = {}) {
  return h.arenas.add(
    SERVER,
    kothArenaInputSchema.parse({ label: 'Colina do Norte', x: 100, z: -200, ...patch }),
    { worldKey: WORLD, grid: 'E7' },
  );
}

/** O segredo desta sessão, lido do comando que saiu. */
async function grabSecret(h: Harness): Promise<string> {
  await h.service.sync(SERVER);

  const line = h.sent.find((command) => command.startsWith('origemz.koth sync'));

  return /"secret":"([^"]+)"/.exec(line ?? '')?.[1] ?? '';
}

describe('erguer', () => {
  it('manda o território inteiro, e abre a run', async () => {
    const h = harness();

    arena(h, { radius: 40, captureSeconds: 120 });

    const started = await h.service.start({ serverId: SERVER });

    expect(started.grid).toBe('E7');

    const command = h.sent.find((line) => line.startsWith('origemz.koth start')) ?? '';
    const body = JSON.parse(command.slice('origemz.koth start '.length)) as Record<string, unknown>;

    expect(body['radius']).toBe(40);
    expect(body['captureSeconds']).toBe(120);
    // Decisão do dono: só participa quem está em equipe.
    expect(body['requireTeam']).toBe(true);

    const run = h.events.run(started.runId);

    expect(run?.status).toBe('active');
  });

  it('anuncia onde ele abriu', async () => {
    const h = harness();

    arena(h);
    await h.service.start({ serverId: SERVER });

    expect(h.said.some((message) => message.includes('Colina do Norte'))).toBe(true);
  });

  it('sem território cadastrado, recusa com nome', async () => {
    const h = harness();

    await expect(h.service.start({ serverId: SERVER })).rejects.toMatchObject({
      reason: 'no_arena',
    });
  });

  it('território desligado não é sorteado', async () => {
    const h = harness();

    arena(h, { enabled: false });

    await expect(h.service.start({ serverId: SERVER })).rejects.toMatchObject({
      reason: 'no_arena',
    });
  });

  it('território de outro mapa fica de fora do sorteio', async () => {
    const h = harness();

    arena(h);
    h.world = '4000:9999';

    await expect(h.service.start({ serverId: SERVER })).rejects.toMatchObject({
      reason: 'no_arena',
    });
  });

  it('com o comando recusado, a run NÃO fica aberta', async () => {
    const h = harness();

    arena(h);
    h.replies.set(
      'origemz.koth start',
      JSON.stringify({ ok: false, error: 'no_banner', message: 'A bandeira não nasceu.' }),
    );

    await expect(h.service.start({ serverId: SERVER })).rejects.toThrow(KothCommandError);

    // Uma run aberta aqui faria o painel dizer "1 no ar" com o mapa
    // vazio, para sempre.
    expect(h.events.activeRun(SERVER)).toBeNull();
  });

  it('não ergue dois no mesmo servidor', async () => {
    const h = harness();

    arena(h);
    await h.service.start({ serverId: SERVER });

    await expect(h.service.start({ serverId: SERVER })).rejects.toMatchObject({
      reason: 'already_active',
    });
  });

  it('com o servidor parado, diz isso', async () => {
    const h = harness();

    arena(h);
    h.connected = false;

    await expect(h.service.start({ serverId: SERVER })).rejects.toMatchObject({
      reason: 'offline',
    });
  });

  it('com o plugin fora, diz isso — e não "sem território"', async () => {
    const h = harness();

    arena(h);
    h.replies.clear();

    await expect(h.service.start({ serverId: SERVER })).rejects.toMatchObject({
      reason: 'no_plugin',
    });
  });
});

describe('o sorteio do território', () => {
  it('não repete o último usado', () => {
    const h = harness();

    const primeiro = arena(h, { label: 'Colina' });

    arena(h, { label: 'Vale' });

    h.arenas.markUsed(SERVER, primeiro.id);

    const escolhido = h.arenas.pickFor(SERVER, { worldKey: WORLD, random: () => 0 });

    expect(escolhido?.label).toBe('Vale');
  });

  it('com um só, usa esse mesmo', () => {
    const h = harness();

    const unico = arena(h, { label: 'Colina' });

    h.arenas.markUsed(SERVER, unico.id);

    expect(h.arenas.pickFor(SERVER, { worldKey: WORLD })?.label).toBe('Colina');
  });
});

describe('o desfecho', () => {
  it('capturado fecha a run e anuncia o nome da equipe', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });
    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ KOTH] ${KOTH_MARKER}{"kind":"captured","teamName":"Os Lobos","teamId":"7","secret":"${secret}"}`,
    );

    expect(h.events.run(started.runId)?.status).toBe('ended');
    expect(h.said.some((message) => message.includes('Os Lobos'))).toBe(true);
  });

  it('expirado também é anunciado: o silêncio faria o evento sumir', async () => {
    const h = harness();

    arena(h);

    await h.service.start({ serverId: SERVER });

    const secret = await grabSecret(h);

    h.said.length = 0;

    h.service.handleLine(
      SERVER,
      `[OrigemZ KOTH] ${KOTH_MARKER}{"kind":"expired","secret":"${secret}"}`,
    );

    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toContain('ninguém dominou');
  });

  it('expirado fecha a run sem vencedor', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });
    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ KOTH] ${KOTH_MARKER}{"kind":"expired","secret":"${secret}"}`,
    );

    expect(h.events.run(started.runId)?.status).toBe('ended');
    expect(h.events.activeRun(SERVER)).toBeNull();
  });

  it('depois de fechar, dá para erguer outro', async () => {
    const h = harness();

    arena(h);

    await h.service.start({ serverId: SERVER });

    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[OrigemZ KOTH] ${KOTH_MARKER}{"kind":"ended","reason":"command","secret":"${secret}"}`,
    );

    await expect(h.service.start({ serverId: SERVER })).resolves.toBeTruthy();
  });

  it('um aviso com segredo errado não fecha nada', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });

    h.service.handleLine(
      SERVER,
      `[OrigemZ KOTH] ${KOTH_MARKER}{"kind":"captured","teamName":"Ladrão","secret":"chutei"}`,
    );

    expect(h.events.run(started.runId)?.status).toBe('active');
  });

  it('o marcador no MEIO da linha não vale: é o chat', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });
    const secret = await grabSecret(h);

    h.service.handleLine(
      SERVER,
      `[CHAT] Fulano: ${KOTH_MARKER}{"kind":"captured","teamName":"Eu","secret":"${secret}"}`,
    );

    expect(h.events.run(started.runId)?.status).toBe('active');
  });

  it('derrubar pelo painel fecha a run como cancelada', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });

    await h.service.stopRun(SERVER);

    expect(h.events.run(started.runId)?.status).toBe('cancelled');
  });

  it('o agente que volta READOTA o KOTH que continuou de pé', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });

    // ####  ELE NÃO MORRE COM O AGENTE  ####
    //
    // Reiniciar o agente não toca no servidor de jogo: lá o
    // território segue de pé, com a bandeira plantada — e o harness
    // responde isso, porque a run está aberta.
    await h.service.reconcile(SERVER);

    // A run continua aberta — e é isso que faz o desfecho, quando
    // chegar pelo console, encontrar a linha certa.
    expect(h.events.run(started.runId)?.status).toBe('active');
  });

  it('um KOTH de pé que o agente não conhece é derrubado', async () => {
    const h = harness();

    arena(h);

    // Nada foi erguido por este agente, e o plugin diz que há algo de
    // pé: bandeira sem dono, que não sairia do mapa até o wipe.
    h.replies.set(
      'origemz.koth status',
      JSON.stringify({ ok: true, active: true, runId: '999' }),
    );

    await h.service.reconcile(SERVER);

    expect(h.sent.some((command) => command.startsWith('origemz.koth stop'))).toBe(true);
  });

  it('sem nada de pé, a run aberta é fechada', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });

    // O servidor reiniciou: o plugin subiu limpo e não há território,
    // mesmo com a run aberta no banco.
    h.replies.set('origemz.koth status', JSON.stringify({ ok: true, active: false }));

    await h.service.reconcile(SERVER);

    expect(h.events.run(started.runId)?.status).toBe('ended');
  });

  it('sem resposta do servidor, NÃO decide nada', async () => {
    const h = harness();

    arena(h);

    const started = await h.service.start({ serverId: SERVER });

    h.connected = false;

    await h.service.reconcile(SERVER);

    // Fechar a run aqui apagaria o registro de um evento que pode
    // estar acontecendo agora.
    expect(h.events.run(started.runId)?.status).toBe('active');
  });
});
