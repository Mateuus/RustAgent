// ============================================================
//  wipe-map-pool.test.ts  -  a fila de mapas, e a chave
//  SERVER_LEVELURL.
//
//  O que este arquivo guarda:
//
//    1. a mesma seed duas vezes ESPERANDO é recusada; depois de
//       jogada (`used`) ela é aceita de novo — é o índice único
//       PARCIAL da migração 024;
//    2. fila vazia não trava wipe: o agente sorteia, registra o
//       que sorteou e DIZ que sorteou;
//    3. o sorteio evita o que está na fila e o que os últimos
//       wipes usaram;
//    4. seed já jogada volta com AVISO, e não com recusa;
//    5. `reorder` recebe a fila inteira — lista parcial ou com
//       repetição é recusada, e a completa termina inteira;
//    6. mapa custom só entra com a URL conferida, e não é
//       consumido por wipe FORÇADO sem a marca de versão;
//    7. um servidor com SERVER_LEVELURL vazio sobe com
//       EXATAMENTE os mesmos argumentos de antes da chave existir.
//
//  O sorteio é injetado (`random`), e o `HEAD` da URL também: o
//  teste não sai na rede nem depende de sorte.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { ServerConfig } from '../src/config.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import {
  MapPoolRepository,
  isMapPoolError,
  type MapPoolRecord,
} from '../src/db/map-pool-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipesRepository } from '../src/db/wipes-repository.js';
import { serverArgs } from '../src/ops/server-process.js';
import { ServerSupervisor } from '../src/servers/supervisor.js';
import {
  MAX_SEED,
  createMapUrlChecker,
  drawSeed,
  normalizeSeed,
  validateMapUrl,
} from '../src/wipe/map-pool.js';

const SERVER = 'pvp1';
const OTHER = 'pve1';

/** Um banco na migração mais recente, com dois servidores. */
function database(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  servers.create({
    id: SERVER,
    name: 'PVP 1',
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  servers.create({
    id: OTHER,
    name: 'PVE 1',
    identity: OTHER,
    gamePort: 28_025,
    rconPort: 28_026,
    queryPort: 28_027,
    appPort: 28_083,
    installDir: 'F:\\Servers\\pve1',
  });

  return db;
}

/**
 * Um sorteio previsível: devolve as seeds da lista, em ordem.
 *
 * Cada valor é convertido para a fração que o `drawSeed`
 * multiplica de volta — assim o teste diz "sorteie ESTA seed" em
 * vez de calibrar números mágicos.
 */
function fakeRandom(seeds: readonly number[]): () => number {
  let at = 0;

  return () => {
    const value = seeds[Math.min(at, seeds.length - 1)] ?? 0;

    at += 1;

    return value / (MAX_SEED + 1);
  };
}

function poolOf(db: AgentDatabase, seeds: readonly number[] = [1_000]): MapPoolRepository {
  return new MapPoolRepository(db, fakeRandom(seeds));
}

/** O código do erro de regra, ou `null` se não foi um deles. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isMapPoolError(error) ? error.code : `INESPERADO: ${String(error)}`;
  }

  return null;
}

describe('a seed, como texto', () => {
  it('"007" e "7" são a mesma seed', () => {
    // O índice único compara TEXTO: duas grafias do mesmo número
    // passariam por ele como se fossem mundos diferentes.
    expect(normalizeSeed('007')).toBe('7');
    expect(normalizeSeed(' 7 ')).toBe('7');
  });

  it('recusa o que não é um inteiro dentro da faixa do jogo', () => {
    expect(normalizeSeed('')).toBeNull();
    expect(normalizeSeed('-1')).toBeNull();
    expect(normalizeSeed('12.5')).toBeNull();
    expect(normalizeSeed('abc')).toBeNull();
    expect(normalizeSeed(String(MAX_SEED + 1))).toBeNull();
    expect(normalizeSeed(String(MAX_SEED))).toBe(String(MAX_SEED));
  });
});

describe('o sorteio', () => {
  it('pula o que já está tomado', () => {
    const seed = drawSeed(new Set(['10', '20']), fakeRandom([10, 20, 30]));

    expect(seed).toBe('30');
  });

  it('desiste em vez de devolver uma seed repetida', () => {
    // Devolver a última colidiria com o índice único e viraria um
    // 409 sem explicação.
    expect(drawSeed(new Set(['10']), fakeRandom([10]), 5)).toBeNull();
  });
});

describe('a fila de mapas', () => {
  it('recusa a mesma seed esperando duas vezes, e aceita depois de jogada', () => {
    const db = database();
    const pool = poolOf(db);

    const first = pool.add(SERVER, { seed: '18422', worldSize: 4000 });

    expect(first.entry.seed).toBe('18422');
    expect(first.entry.status).toBe('ready');
    expect(first.drawn).toBe(false);

    // ####  O ÚNICO É PARCIAL  ####
    //
    // Duas vezes ESPERANDO é sempre um Ctrl+V repetido.
    expect(codeOf(() => pool.add(SERVER, { seed: '18422', worldSize: 4000 }))).toBe(
      'MAP_ALREADY_QUEUED',
    );

    // Com outro tamanho é outro mundo, e entra.
    expect(pool.add(SERVER, { seed: '18422', worldSize: 3500 }).entry.id).toBeGreaterThan(0);

    // Depois de jogada, a reprise é escolha legítima.
    pool.markUsed(SERVER, first.entry.id);

    const reprise = pool.add(SERVER, { seed: '18422', worldSize: 4000 });

    expect(reprise.entry.seed).toBe('18422');
    // E ela volta com aviso, porque quase sempre é engano.
    expect(reprise.warnings.map((warning) => warning.code)).toContain('SEED_ALREADY_PLAYED');

    db.close();
  });

  it('a fila de um servidor não estorva a do outro', () => {
    const db = database();
    const pool = poolOf(db);

    pool.add(SERVER, { seed: '18422', worldSize: 4000 });

    // Mesma seed, outro servidor: são dois mundos, para gente
    // diferente.
    expect(pool.add(OTHER, { seed: '18422', worldSize: 4000 }).entry.serverId).toBe(OTHER);
    expect(pool.list(SERVER)).toHaveLength(1);

    db.close();
  });

  it('recusa tamanho de mundo fora do que o jogo aceita', () => {
    const db = database();
    const pool = poolOf(db);

    expect(codeOf(() => pool.add(SERVER, { seed: '1', worldSize: 999 }))).toBe(
      'INVALID_WORLD_SIZE',
    );
    expect(codeOf(() => pool.add(SERVER, { seed: '1', worldSize: 6001 }))).toBe(
      'INVALID_WORLD_SIZE',
    );
    expect(codeOf(() => pool.add(SERVER, { seed: 'abc', worldSize: 4000 }))).toBe('INVALID_SEED');

    db.close();
  });

  it('sorteia evitando o que está na fila e o que já foi jogado', () => {
    const db = database();
    // O sorteio tenta 10, depois 20, depois 30.
    const pool = new MapPoolRepository(db, fakeRandom([10, 20, 30]));

    pool.add(SERVER, { seed: '10', worldSize: 4000 });

    const jogada = pool.add(SERVER, { seed: '20', worldSize: 4000 });

    pool.markUsed(SERVER, jogada.entry.id);

    const sorteada = pool.add(SERVER, { worldSize: 4000 });

    expect(sorteada.entry.seed).toBe('30');
    expect(sorteada.drawn).toBe(true);

    db.close();
  });
});

describe('o histórico de mundos detectados', () => {
  it('não estorva quando a tabela não existe', () => {
    // ####  ESTE TESTE ENVELHECEU BEM, E DE PROPÓSITO  ####
    //
    // Ele nasceu quando `wipes` ainda não existia: a migração 025 é
    // de outra frente, e a fila precisava funcionar sem ela. A 025
    // chegou — então o que se prova aqui agora é o outro lado da
    // mesma conferência, e ele continua valendo: um agente que caia
    // para uma versão anterior do banco não pode estourar ao abrir
    // a fila de mapas.
    const db = database();
    const pool = poolOf(db, [10, 20]);

    db.exec('DROP TABLE wipes');

    expect(pool.recentSeeds(SERVER)).toEqual([]);
    expect(pool.add(SERVER, { worldSize: 4000 }).entry.seed).toBe('10');

    db.close();
  });

  it('entra na conta quando a tabela existe', () => {
    const db = database();
    const pool = poolOf(db, [10, 20]);

    // Agora pela tabela DE VERDADE, criada pela migração 025 e
    // escrita pelo repositório dela — e não por um CREATE TABLE
    // escrito à mão neste arquivo, que divergiria do banco real no
    // dia em que a coluna mudasse.
    new WipesRepository(db).record(
      SERVER,
      { saveCreatedAt: 1_760_000_000_000, seed: '10', worldSize: 4000 },
      1_760_000_000_000,
    );

    expect(pool.recentSeeds(SERVER)).toContain('10');

    // E ela muda as duas coisas que dependem dela: o aviso…
    const repetida = pool.add(SERVER, { seed: '10', worldSize: 4000 });

    expect(repetida.warnings.map((warning) => warning.code)).toEqual(['SEED_ALREADY_PLAYED']);

    // …e o sorteio, que passa a evitar aquela seed.
    pool.remove(SERVER, repetida.entry.id);

    expect(pool.add(SERVER, { worldSize: 4000 }).entry.seed).toBe('20');

    db.close();
  });
});

describe('a fila vazia, na hora do wipe', () => {
  it('sorteia, registra o que sorteou, e diz que sorteou', () => {
    const db = database();
    const pool = poolOf(db, [777]);

    // ####  UM WIPE NUNCA É BLOQUEADO POR FALTA DE CURADORIA  ####
    const taken = pool.takeForWipe(SERVER, { worldSize: 4000 });

    expect(taken.drawn).toBe(true);
    expect(taken.entry.seed).toBe('777');
    expect(taken.entry.status).toBe('used');
    expect(taken.entry.usedAt).not.toBeNull();

    // E o que sorteou fica GRAVADO: é o que responde, semanas
    // depois, de onde veio o mapa daquele wipe — e é o que
    // alimenta o aviso de seed repetida.
    expect(pool.list(SERVER)).toHaveLength(1);
    expect(pool.recentSeeds(SERVER)).toContain('777');

    db.close();
  });

  it('com a fila cheia, consome a primeira pronta e a marca usada', () => {
    const db = database();
    const pool = poolOf(db);

    const first = pool.add(SERVER, { seed: '11', worldSize: 4000 });

    pool.add(SERVER, { seed: '22', worldSize: 4000 });

    const taken = pool.takeForWipe(SERVER);

    expect(taken.drawn).toBe(false);
    expect(taken.entry.id).toBe(first.entry.id);
    expect(taken.entry.status).toBe('used');

    // A seguinte assume a dianteira.
    expect(pool.next(SERVER)?.seed).toBe('22');

    db.close();
  });
});

describe('a ordem da fila', () => {
  it('recebe a fila INTEIRA, e recusa lista parcial ou repetida', () => {
    const db = database();
    const pool = poolOf(db);

    const a = pool.add(SERVER, { seed: '1', worldSize: 4000 }).entry;
    const b = pool.add(SERVER, { seed: '2', worldSize: 4000 }).entry;
    const c = pool.add(SERVER, { seed: '3', worldSize: 4000 }).entry;

    expect(codeOf(() => pool.reorder(SERVER, [c.id, a.id]))).toBe('INCOMPLETE_ORDER');
    expect(codeOf(() => pool.reorder(SERVER, [c.id, c.id, a.id]))).toBe('DUPLICATED_ID');
    expect(codeOf(() => pool.reorder(SERVER, [c.id, b.id, a.id, 9_999]))).toBe('MAP_NOT_FOUND');

    // ####  DUAS ABAS TERMINAM NA ORDEM DA ÚLTIMA A SALVAR  ####
    //
    // E ela termina INTEIRA: com movimento relativo, a segunda
    // aba aplicaria "sobe o #3" sobre uma lista que já não é a
    // que ela viu.
    const depois = pool.reorder(SERVER, [c.id, b.id, a.id]);

    expect(depois.map((entry) => entry.seed)).toEqual(['3', '2', '1']);
    expect(pool.next(SERVER)?.seed).toBe('3');

    db.close();
  });

  it('as já usadas ficam fora da reordenação, e não saem da fila', () => {
    const db = database();
    const pool = poolOf(db);

    const usada = pool.add(SERVER, { seed: '1', worldSize: 4000 }).entry;
    const viva = pool.add(SERVER, { seed: '2', worldSize: 4000 }).entry;

    pool.markUsed(SERVER, usada.id);

    // A fila "de verdade" é só a viva.
    expect(pool.reorder(SERVER, [viva.id]).filter((e) => e.status !== 'used')).toHaveLength(1);

    // E o histórico não se apaga para "limpar a tela": ele é a
    // única memória de qual mundo cada wipe gerou.
    expect(codeOf(() => pool.remove(SERVER, usada.id))).toBe('MAP_ALREADY_USED');
    expect(codeOf(() => pool.remove(SERVER, 9_999))).toBe('MAP_NOT_FOUND');

    db.close();
  });
});

describe('o mapa custom', () => {
  it('a URL é conferida antes de a entrada existir', async () => {
    expect(validateMapUrl('não é url').ok).toBe(false);
    expect(validateMapUrl('ftp://host/mundo.map').ok).toBe(false);
    // Página do RustMaps não serve: o jogo baixa o ARQUIVO.
    expect(validateMapUrl('https://rustmaps.com/map/abc').ok).toBe(false);
    expect(validateMapUrl('https://cdn.exemplo/mundo.map').ok).toBe(true);

    // O `HEAD` de verdade, com um fetch de mentira.
    const responde = createMapUrlChecker(
      (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '48000000' }),
        })) as unknown as typeof globalThis.fetch,
    );

    const bom = await responde('https://cdn.exemplo/mundo.map');

    expect(bom.ok).toBe(true);

    const some = createMapUrlChecker(
      (() =>
        Promise.resolve({
          ok: false,
          status: 404,
          headers: new Headers(),
        })) as unknown as typeof globalThis.fetch,
    );

    const ruim = await some('https://cdn.exemplo/sumiu.map');

    expect(ruim.ok).toBe(false);
    expect(ruim.ok ? '' : ruim.code).toBe('MAP_URL_UNREACHABLE');
  });

  it('entra na fila, e NÃO é consumido por wipe forçado sem a marca', () => {
    const db = database();
    const pool = poolOf(db, [555]);

    const custom = pool.add(SERVER, {
      kind: 'custom',
      levelUrl: 'https://cdn.exemplo/mundo.map',
      level: 'O mundo da liga',
    }).entry;

    expect(custom.kind).toBe('custom');
    expect(custom.seed).toBeNull();
    expect(custom.versionOk).toBe(false);

    // Sem URL não entra.
    expect(codeOf(() => pool.add(SERVER, { kind: 'custom' }))).toBe('MAP_URL_REQUIRED');
    // O mesmo arquivo duas vezes esperando também não.
    expect(
      codeOf(() =>
        pool.add(SERVER, { kind: 'custom', levelUrl: 'https://cdn.exemplo/mundo.map' }),
      ),
    ).toBe('MAP_ALREADY_QUEUED');

    // Num wipe de cadência ele é o próximo.
    expect(pool.next(SERVER)?.id).toBe(custom.id);

    // ####  NO FORÇADO, ELE É PULADO  ####
    //
    // O forçado troca o binário do jogo, e um .map da versão de
    // ontem pode não carregar na de hoje. Pulado, e não recusado:
    // ele continua na fila para o wipe seguinte.
    expect(pool.next(SERVER, true)).toBeNull();

    const forcado = pool.takeForWipe(SERVER, { forced: true, worldSize: 4000 });

    expect(forcado.drawn).toBe(true);
    expect(forcado.skipped.map((item) => item.id)).toEqual([custom.id]);
    expect(pool.get(SERVER, custom.id)?.status).toBe('ready');

    // Com a marca na mão, ele passa a valer também no forçado.
    pool.markVersionOk(SERVER, custom.id, true);

    expect(pool.next(SERVER, true)?.id).toBe(custom.id);

    db.close();
  });

  it('a marca de versão não existe em mundo procedural', () => {
    const db = database();
    const pool = poolOf(db);

    const entry = pool.add(SERVER, { seed: '1', worldSize: 4000 }).entry;

    // Um mundo procedural é gerado pelo próprio servidor no boot,
    // sempre na versão certa — a pergunta não faz sentido.
    expect(codeOf(() => pool.markVersionOk(SERVER, entry.id, true))).toBe('MAP_NOT_CUSTOM');

    db.close();
  });
});

// ============================================================
//  SERVER_LEVELURL — a única mudança fora do wipe
// ============================================================

/** Um servidor qualquer, com o que o teste precisar por cima. */
function config(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: SERVER,
    name: 'PVP 1',
    hostname: 'PVP 1',
    identity: SERVER,
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
    rcon: { host: '127.0.0.1', port: 28_016, password: 'senha-do-rcon' },
    steam: { appId: '258550', login: 'anonymous', branch: 'public' },
    paths: {
      configPath: 'F:\\Configs\\pvp1.ini',
      installDir: 'F:\\Servers\\pvp1',
      exePath: 'F:\\Servers\\pvp1\\RustDedicated.exe',
      oxideConfigDir: 'F:\\Servers\\pvp1\\oxide\\config',
      pluginsDir: 'F:\\Servers\\pvp1\\oxide\\plugins',
      logsDir: 'F:\\Logs\\pvp1',
      backupsDir: 'F:\\Backups\\pvp1',
    },
    ...over,
  } as ServerConfig;
}

describe('SERVER_LEVELURL na linha de comando', () => {
  it('vazio: o servidor sobe com EXATAMENTE os mesmos argumentos de antes', () => {
    // ####  ESTE É O TESTE QUE PROTEGE OS SERVIDORES DE HOJE  ####
    //
    // O jogo aceita qualquer `+x.y` sem reclamar e ignora em
    // silêncio o que não conhece — foi assim que um
    // `+server.password` inventado atravessou teste, build e
    // produção. Um `+server.levelurl ""` não daria erro nenhum, e
    // é justamente por isso que ele não pode entrar.
    const args = serverArgs(config(), 'x.log');

    expect(args).not.toContain('+server.levelurl');
    expect(args).not.toContain('');

    // E o mundo continua vindo da seed.
    expect(args[args.indexOf('+server.seed') + 1]).toBe('12345');
  });

  it('preenchido: entra como +server.levelurl, com o link', () => {
    const args = serverArgs(config({ levelUrl: 'https://cdn.exemplo/mundo.map' }), 'x.log');

    expect(args[args.indexOf('+server.levelurl') + 1]).toBe('https://cdn.exemplo/mundo.map');
    // A seed continua na linha: quem manda com URL é o arquivo, e
    // tirar a seed daqui seria inventar uma regra que o jogo não
    // pede.
    expect(args).toContain('+server.seed');
  });

  it('a chave é de reinício, e traduz para SERVER_LEVELURL', () => {
    // Convar de mundo só é lida no BOOT: não existe trocar mapa a
    // quente, e a tela precisa dizer isso.
    expect(ServerSupervisor.RESTART_KEYS.has('levelUrl')).toBe(true);
  });
});

describe('o registro da fila é o que a tela lê', () => {
  it('a entrada nasce pronta, com as colunas do RustMaps vazias', () => {
    const db = database();
    const pool = poolOf(db);

    const entry: MapPoolRecord = pool.add(SERVER, { seed: '18422', worldSize: 4000 }).entry;

    // As colunas que a frente do RustMaps vai preencher existem
    // desde a migração 024, e nascem vazias. Prévia é enfeite:
    // sem ela o wipe usa a seed do mesmo jeito.
    expect(entry.rustmapsId).toBeNull();
    expect(entry.previewUrl).toBeNull();
    expect(entry.thumbUrl).toBeNull();
    expect(entry.monuments).toBeNull();
    expect(entry.lastError).toBeNull();
    expect(entry.staging).toBe(false);
    expect(entry.usedAt).toBeNull();
    expect(entry.position).toBe(0);

    db.close();
  });
});
