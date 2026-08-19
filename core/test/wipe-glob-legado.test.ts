// ============================================================
//  wipe-glob-legado.test.ts  -  UMA LISTA JÁ SALVA NÃO MUDA DE
//  SENTIDO.
//
//  ####  O QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  A escolha do full wipe é uma lista de PADRÕES, gravada num dia
//  e relida meses depois por um wipe de cadência que roda de
//  madrugada, sozinho, sem tela aberta. Mexer no casador de
//  padrões, então, não é mexer só em código: é reinterpretar uma
//  ordem que o admin já deu.
//
//  MEDIDO, e é o estrago que este arquivo tranca: o conserto do
//  globstar fez `oxide/data/**\/*.json` — salvo quando aquilo
//  queria dizer "os json das SUBPASTAS" — passar a alcançar a raiz
//  de `oxide\data`. Com o WipeRunner de verdade, mesma árvore e
//  mesma lista salva:
//
//      antes    apagar: 9 arquivo(s) + 1 de plugin
//      depois   apagar: 9 arquivo(s) + 3 de plugin
//
//  Os dois a mais eram `OrigemZStore.json` e `OrigemZVip.json`: a
//  carteira e o VIP que alguém pagou. Ninguém pediu, ninguém viu.
//
//  O que este arquivo guarda:
//
//    1. sobre um corpus GERADO de padrões × caminhos, o casador de
//       hoje responde para o padrão REESCRITO exatamente o que o
//       casador de feb20ff respondia para o padrão original — nem
//       um par a mais (ALARGOU, o estrago) nem um a menos
//       (ESTREITOU, que apaga menos mas some calado);
//    2. os alargamentos nomeados no achado, um a um: a carteira, o
//       VIP e os bancos que o wipe de mapa tem obrigação de
//       preservar;
//    3. o estreitamento irmão: `***`, um `*` a mais de digitação,
//       continua atravessando pasta;
//    4. a migração 032 reescreve a lista gravada, deixa intacta a
//       lista de caminhos exatos (a que a tela grava) e rodar de
//       novo não mexe em nada;
//    5. e o desfecho que importa: com a lista legada no banco, o
//       `apagar` NÃO leva o `OrigemZVip.json`.
//
//  ####  O ORÁCULO É CÓPIA CONGELADA  ####
//
//  `matchesLegacy`, aqui embaixo, é o `matches` de feb20ff
//  recortado byte a byte. Ele não é uma segunda implementação a
//  manter: é o REGISTRO do que as listas salvas querem dizer.
//  Editá-lo para um teste passar é apagar a prova.
// ============================================================

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { WipeRunsRepository } from '../src/db/wipe-runs-repository.js';
import { matches, resolvePluginDataTargets, rewriteLegacyPattern } from '../src/wipe/plugin-data.js';

// ------------------------------------------------------------
//  O ORÁCULO  —  o casador de feb20ff, CONGELADO
// ------------------------------------------------------------

const LEGACY_SPECIAL = /[.+^${}()|[\]\\?]/;

function legacyNormalize(value: string): string {
  return value.split(sep).join('/').split('\\').join('/').replace(/^\.\//, '').trim();
}

/**
 * O que uma lista salva ANTES do conserto do globstar quer dizer.
 *
 * ####  NÃO EDITE  ####
 *
 * Ver o cabeçalho: isto é o contrato antigo, não uma alternativa
 * de implementação.
 */
function matchesLegacy(path: string, pattern: string): boolean {
  const normalized = legacyNormalize(pattern);

  if (normalized === '') {
    return false;
  }

  let expression = '';
  let at = 0;

  while (at < normalized.length) {
    const character = normalized[at] ?? '';

    if (character === '*') {
      if (normalized[at + 1] === '*') {
        expression += '.*';
        at += 2;
        continue;
      }

      expression += '[^/]*';
      at += 1;
      continue;
    }

    expression += LEGACY_SPECIAL.test(character) ? `\\${character}` : character;
    at += 1;
  }

  return new RegExp(`^${expression}$`, 'i').test(legacyNormalize(path));
}

// ------------------------------------------------------------
//  O CORPUS
// ------------------------------------------------------------

/** Pedaços de padrão, com as pegadinhas juntas das linhas reais. */
const PEDACOS = ['a', 'b.json', '*', '**', '***', 'a*', '*b', 'a**b', 'a**', '**b'];

/** Nomes de pasta e de arquivo, para montar caminhos de 1 a 4 níveis. */
const NOMES = ['a', 'b', 'b.json'];

function combinacoes(alfabeto: readonly string[], ate: number): readonly string[] {
  let nivel: readonly string[] = [''];
  const saida: string[] = [];

  for (let n = 0; n < ate; n += 1) {
    nivel = nivel.flatMap((prefixo) =>
      alfabeto.map((item) => (prefixo === '' ? item : `${prefixo}/${item}`)),
    );
    saida.push(...nivel);
  }

  return saida;
}

/** Os padrões que a doc, a tela e os cenários usam de verdade. */
const PADROES_REAIS = [
  'oxide/data/**/*.json',
  'oxide/data/*.json',
  'oxide/data/**',
  'oxide/data/**/',
  'oxide/data/***/*.json',
  'oxide/data/**/**/*.json',
  'oxide/data/**/Kits/*.json',
  'oxide/data/Kits/*.json',
  'oxide/data/Kits/**',
  'oxide/data/OrigemZStore.json',
  'oxide/**/data/*.json',
  'server/server01/**/*.db',
  'server/server01/*.db',
  'server/server01/player.*.db',
  'OXIDE/DATA/*.JSON',
  './oxide/data/*.json',
  'oxide\\data\\*.json',
  '**',
  '***',
  '*',
  '',
  '   ',
];

const CAMINHOS_REAIS = [
  'oxide/data/OrigemZStore.json',
  'oxide/data/OrigemZVip.json',
  'oxide/data/Kits/kits_data.json',
  'oxide/data/oxide.users.data',
  'oxide/data/a/b/c.json',
  'oxide/data/a/b/c/d.json',
  'oxide/data/aXXb/x.json',
  'oxide/data',
  'oxide/config/x.json',
  'server/server01/clans.287.db',
  'server/server01/player.tokens.db',
  'server/server01/player.states.287.db',
  'server/server01/relationship.287.db',
  'server/server01/sub/x.db',
];

const PADROES = [...combinacoes(PEDACOS, 3), ...PADROES_REAIS];
const CAMINHOS = [...combinacoes(NOMES, 4), ...CAMINHOS_REAIS];

describe('o casador de hoje responde o que a lista salva combinou', () => {
  it('nem um par a mais, nem um a menos, sobre o corpus inteiro', () => {
    const alargou: string[] = [];
    const estreitou: string[] = [];

    for (const padrao of PADROES) {
      const reescrito = rewriteLegacyPattern(padrao);

      for (const caminho of CAMINHOS) {
        const antes = matchesLegacy(caminho, padrao);
        const depois = matches(caminho, reescrito);

        if (antes === depois) {
          continue;
        }

        // O padrão sai com a reescrita ao lado: sem ela não dá para
        // saber se quem divergiu foi o casador ou a tradução.
        (depois ? alargou : estreitou).push(`${padrao} -> ${reescrito} x ${caminho}`);
      }
    }

    // Um teste que só contasse quantos divergiram diria "3" e
    // deixaria alguém procurar quais. As listas vêm inteiras.
    expect({ alargou, estreitou }).toEqual({ alargou: [], estreitou: [] });
  });

  it('e o corpus é grande o bastante para a conta valer alguma coisa', () => {
    // Se alguém encolher o alfabeto para o teste rodar mais rápido,
    // o teste de cima passa a provar menos sem dizer.
    expect(PADROES.length * CAMINHOS.length).toBeGreaterThan(100_000);
  });
});

describe('os alargamentos que o achado nomeou', () => {
  /** A lista como o admin a gravou, já passada pela reescrita. */
  function salvo(pattern: string): string {
    return rewriteLegacyPattern(pattern);
  }

  it('a carteira e o VIP ficam de fora de `oxide/data/**\\/*.json`', () => {
    // Os dois arquivos do cabeçalho de plugin-data.ts: "não devolve
    // servidor novo, devolve chargeback".
    expect(matches('oxide/data/OrigemZStore.json', salvo('oxide/data/**/*.json'))).toBe(false);
    expect(matches('oxide/data/OrigemZVip.json', salvo('oxide/data/**/*.json'))).toBe(false);

    // E o que o admin marcou de verdade continua marcado.
    expect(matches('oxide/data/OrigemZ/historico.json', salvo('oxide/data/**/*.json'))).toBe(true);
    expect(matches('oxide/data/n1/n2/fundo.json', salvo('oxide/data/**/*.json'))).toBe(true);
  });

  it('os bancos que o wipe de mapa preserva não entram por `server/<id>/**\\/*.db`', () => {
    const padrao = salvo('server/server01/**/*.db');

    for (const banco of [
      'server/server01/clans.287.db',
      'server/server01/player.tokens.db',
      'server/server01/player.states.287.db',
      'server/server01/relationship.287.db',
    ]) {
      expect(matches(banco, padrao)).toBe(false);
    }

    expect(matches('server/server01/sub/x.db', padrao)).toBe(true);
  });

  it('`oxide/data/**` não passa a casar a própria pasta `oxide/data`', () => {
    expect(matches('oxide/data', salvo('oxide/data/**'))).toBe(false);
    expect(matches('oxide/data/OrigemZVip.json', salvo('oxide/data/**'))).toBe(true);
  });
});

describe('o estreitamento irmão: a ordem do admin também não pode encolher', () => {
  it('`***` — um `*` a mais de digitação — continua atravessando pasta', () => {
    // Ele não cai em `missing` (continua casando com outras
    // linhas), então uma lista que encolhesse encolheria calada.
    expect(matches('oxide/data/a/b/c.json', rewriteLegacyPattern('oxide/data/***/*.json'))).toBe(
      true,
    );
    expect(matches('oxide/data/a/b/c/d.json', rewriteLegacyPattern('oxide/data/***/*.json'))).toBe(
      true,
    );
    expect(matches('oxide/data/OrigemZVip.json', rewriteLegacyPattern('oxide/data/***/*.json'))).toBe(
      false,
    );
  });

  it('e `**` colado a texto atravessa pasta no casador cru', () => {
    // `a**` não tem segmento próprio para virar globstar; encolhê-lo
    // para `[^/]*` mudaria de sentido uma lista já salva.
    expect(matches('oxide/data/a/b/c.json', 'oxide/data/a**/*.json')).toBe(true);
    expect(matches('oxide/data/a/b/c.json', 'oxide/data/a**b/*.json')).toBe(true);
    // E um `*` sozinho continua preso ao segmento.
    expect(matches('oxide/data/a/b/c.json', 'oxide/data/a*/*.json')).toBe(false);
  });
});

// ------------------------------------------------------------
//  A MIGRAÇÃO 032
// ------------------------------------------------------------

const SERVER = 'server01';
const IDENTITY = 'server01';
const MIGRACAO = MIGRATIONS.find((item) => item.name === 'wipe-plugin-data-globstar');

/** Um banco parado antes da 032, com um servidor dentro. */
function bancoAntesDaMigracao(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  // Sem a 032 no código, "parar antes dela" é o banco inteiro — e
  // aí a falha aparece na asserção que importa, e não num
  // `no such table` que não explica nada.
  const parada = MIGRACAO?.id ?? Number.POSITIVE_INFINITY;

  for (const migration of MIGRATIONS.filter((item) => item.id < parada)) {
    applyMigration(db, migration);
    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @applied_at)',
    ).run({ id: migration.id, name: migration.name, applied_at: 1_760_000_000_000 });
  }

  new ServersRepository(db).create({
    id: SERVER,
    name: 'OrigemZ #1',
    identity: IDENTITY,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\server01',
  });

  return db;
}

/** Grava a lista do jeito que a versão antiga do agente gravava. */
function gravarListaLegada(db: AgentDatabase, patterns: readonly string[]): void {
  const runs = new WipeRunsRepository(db);
  const base = runs.getExecSettings(SERVER);

  runs.saveExecSettings(SERVER, {
    ...base,
    pluginData: { enabled: true, patterns },
  });
}

function listaSalva(db: AgentDatabase): readonly string[] {
  return new WipeRunsRepository(db).getExecSettings(SERVER).pluginData.patterns;
}

describe('a migração 032 reescreve a lista sem mudar o que ela apaga', () => {
  it('existe, e roda depois da que criou `wipe_settings`', () => {
    // Um passo de conserto que ninguém pôs no array é um passo que
    // roda em máquina nenhuma. E ele precisa vir DEPOIS da 025,
    // senão reescreve uma tabela que ainda não existe.
    expect(MIGRACAO).toBeDefined();
    expect(MIGRACAO?.id ?? 0).toBeGreaterThan(25);
  });

  it('a lista com globstar vira o padrão que diz "pelo menos uma pasta"', () => {
    const db = bancoAntesDaMigracao();

    gravarListaLegada(db, ['oxide/data/**/*.json']);
    expect(listaSalva(db)).toEqual(['oxide/data/**/*.json']);

    runMigrations(db);

    expect(listaSalva(db)).toEqual(['oxide/data/*/**/*.json']);

    db.close();
  });

  it('a lista de caminhos exatos — a que a tela grava — volta byte a byte igual', () => {
    const db = bancoAntesDaMigracao();
    const exatos = [
      'oxide/data/OrigemZStore.json',
      'oxide/data/Kits/kits_data.json',
      'server/server01/clans.287.db',
      'oxide/data/*.json',
    ];

    gravarListaLegada(db, exatos);
    runMigrations(db);

    expect(listaSalva(db)).toEqual(exatos);

    db.close();
  });

  it('subir o agente de novo não mexe na lista', () => {
    const db = bancoAntesDaMigracao();

    gravarListaLegada(db, ['oxide/data/**/*.json']);
    runMigrations(db);

    const depoisDaPrimeira = listaSalva(db);

    // É a propriedade que permite chamar `runMigrations` em todo
    // boot: o banco em dia não é tocado. Ela é o que garante a vez
    // única — ver o teste seguinte, que diz por que a vez única
    // importa.
    expect(runMigrations(db)).toHaveLength(0);
    expect(listaSalva(db)).toEqual(depoisDaPrimeira);

    db.close();
  });

  it('e a tradução não pode ser idempotente, porque `*\\/**` é padrão legado legítimo', () => {
    // MEDIDO no dialeto antigo: `oxide/data/*\/**\/*.json` exige
    // DUAS pastas — casa `oxide/data/a/b/x.json` e não casa
    // `oxide/data/a/x.json`. Uma reescrita que reconhecesse o
    // próprio resultado e o deixasse passar faria esse padrão
    // digitado à mão passar a exigir UMA: o mesmo alargamento que
    // tudo isto existe para impedir.
    expect(rewriteLegacyPattern('oxide/data/*/**/*.json')).toBe('oxide/data/*/*/**/*.json');

    expect(matches('oxide/data/a/b/x.json', 'oxide/data/*/*/**/*.json')).toBe(true);
    expect(matches('oxide/data/a/x.json', 'oxide/data/*/*/**/*.json')).toBe(false);
    // E o que aconteceria se ela se reconhecesse: uma pasta a menos.
    expect(matches('oxide/data/a/x.json', 'oxide/data/*/**/*.json')).toBe(true);
  });

  it('e o `updated_at` do admin não é carimbado de novo', () => {
    const db = bancoAntesDaMigracao();

    gravarListaLegada(db, ['oxide/data/**/*.json']);

    const antes = db
      .prepare(`SELECT updated_at FROM wipe_settings WHERE key = 'pluginData.patterns'`)
      .get() as { readonly updated_at: number };

    runMigrations(db);

    const depois = db
      .prepare(`SELECT updated_at FROM wipe_settings WHERE key = 'pluginData.patterns'`)
      .get() as { readonly updated_at: number };

    // A escolha é a mesma escolha, do mesmo dia.
    expect(depois.updated_at).toBe(antes.updated_at);

    db.close();
  });

  it('um valor que não é lista não vira escolha nova', () => {
    const db = bancoAntesDaMigracao();

    gravarListaLegada(db, ['oxide/data/**/*.json']);
    db.prepare(
      `UPDATE wipe_settings SET value = 'nao e json' WHERE key = 'pluginData.patterns'`,
    ).run();

    runMigrations(db);

    // Continua sendo lixo ilegível — e lixo ilegível é lista vazia,
    // que é o desfecho seguro. Inventar padrões aqui seria inventar
    // uma ordem que o admin não deu.
    expect(listaSalva(db)).toEqual([]);

    db.close();
  });
});

// ------------------------------------------------------------
//  O DESFECHO, EM DISCO
// ------------------------------------------------------------

const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A pasta de um servidor com a carteira, o VIP e uma subpasta. */
async function installDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-glob-'));

  temporary.push(root);

  const data = join(root, 'oxide', 'data');

  await mkdir(join(root, 'server', IDENTITY), { recursive: true });
  await mkdir(join(data, 'OrigemZ'), { recursive: true });

  await writeFile(join(data, 'OrigemZStore.json'), '{"saldo":1200}');
  await writeFile(join(data, 'OrigemZVip.json'), '{"vip":true}');
  await writeFile(join(data, 'OrigemZ', 'historico.json'), '{"linhas":[]}');

  return root;
}

describe('o wipe que roda de madrugada, com a lista salva antes do conserto', () => {
  it('não leva o VIP que alguém pagou, e leva o que o admin marcou', async () => {
    const db = bancoAntesDaMigracao();

    gravarListaLegada(db, ['oxide/data/**/*.json']);
    runMigrations(db);

    const root = await installDir();
    const alvos = await resolvePluginDataTargets({
      installDir: root,
      identity: IDENTITY,
      selected: listaSalva(db),
      bpPolicy: 'keep',
    });

    const relativos = alvos.map((alvo) => alvo.slice(root.length + 1).split(sep).join('/'));

    expect(relativos).toEqual(['oxide/data/OrigemZ/historico.json']);

    db.close();
  });
});
