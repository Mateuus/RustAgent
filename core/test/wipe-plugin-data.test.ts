// ============================================================
//  wipe-plugin-data.test.ts  -  o full wipe.
//
//  ####  A REGRA QUE ESTE ARQUIVO PROTEGE  ####
//
//  Nada vem marcado. Nunca `del *.json`. O `OrigemZVip.json` é o
//  VIP que alguém pagou, e o `OrigemZStore.json` é a carteira — um
//  full wipe indiscriminado não devolve servidor novo, devolve
//  chargeback.
//
//  O que este arquivo guarda:
//
//    1. lista vazia de padrões => NADA marcado, mesmo com o disco
//       cheio de `.json` de plugin;
//    2. só é marcado o que casa com um padrão do admin;
//    3. um padrão marcado que não casa com nada aparece em
//       `missing` — e NÃO é apagado da escolha salva;
//    4. o que a política já apaga não é oferecido de novo;
//    5. os `.data` do Oxide (grupos, usuários, permissões) não
//       entram na lista;
//    6. `**` atravessa pasta e `*` não, e a comparação ignora
//       maiúsculas — o disco onde isto roda é o do Windows.
// ============================================================

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listPluginData, matches, resolvePluginDataTargets } from '../src/wipe/plugin-data.js';

const IDENTITY = 'server01';
const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A pasta de um servidor, com save e oxide\data, como a de verdade. */
async function installDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-server-'));

  temporary.push(root);

  const save = join(root, 'server', IDENTITY);
  const data = join(root, 'oxide', 'data');

  await mkdir(save, { recursive: true });
  await mkdir(join(data, 'OrigemZ'), { recursive: true });

  // O que o jogo escreve na pasta do save.
  for (const name of [
    'proceduralmap.4000.12345.287.map',
    'player.blueprints.16.db',
    'player.blueprints.16.db-wal',
    'player.deaths.16.db',
    'player.states.287.db',
    'player.states.287.db-wal',
    'clans.287.db',
    'relationship.287.db',
  ]) {
    await writeFile(join(save, name), name);
  }

  // O que os plugins escrevem, e o que o Oxide escreve.
  await writeFile(join(data, 'OrigemZVip.json'), '{"vip":true}');
  await writeFile(join(data, 'OrigemZStore.json'), '{"carteira":1}');
  await writeFile(join(data, 'Economics.json'), '{}');
  await writeFile(join(data, 'OrigemZ', 'historico.json'), '{}');
  await writeFile(join(data, 'oxide.groups.data'), 'grupos');
  await writeFile(join(data, 'oxide.users.data'), 'usuarios');

  return root;
}

describe('nada vem marcado', () => {
  it('sem padrão salvo, NENHUM arquivo aparece marcado', async () => {
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });

    expect(listing.files.length).toBeGreaterThan(0);
    expect(listing.files.every((file) => !file.selected)).toBe(true);
    expect(listing.missing).toHaveLength(0);

    // E, sem marcação, o purge não tem alvo nenhum.
    expect(await resolvePluginDataTargets({ installDir: root, identity: IDENTITY })).toHaveLength(0);
  });

  it('o VIP que alguém pagou não é marcado por acidente', async () => {
    const root = await installDir();

    const listing = await listPluginData({
      installDir: root,
      identity: IDENTITY,
      selected: ['oxide/data/Economics.json'],
    });

    const vip = listing.files.find((file) => file.path.endsWith('OrigemZVip.json'));
    const economics = listing.files.find((file) => file.path.endsWith('Economics.json'));

    expect(vip?.selected).toBe(false);
    expect(economics?.selected).toBe(true);
  });
});

describe('o que entra na lista', () => {
  it('os .json do oxide\\data, inclusive em subpasta', async () => {
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });
    const paths = listing.files.map((file) => file.path);

    expect(paths).toContain('oxide/data/OrigemZVip.json');
    expect(paths).toContain('oxide/data/OrigemZ/historico.json');
  });

  it('NÃO entra o .data do Oxide: ali moram as permissões', async () => {
    // Apagar `oxide.groups.data` tira o VIP de todo mundo sem que
    // uma linha da tela diga isso. Quem quiser mexer neles mexe
    // pelo Oxide, e não por efeito colateral de um wipe.
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });
    const paths = listing.files.map((file) => file.path);

    expect(paths.some((path) => path.endsWith('.data'))).toBe(false);
  });

  it('os .db do save que a política NÃO leva', async () => {
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY, bpPolicy: 'keep' });
    const paths = listing.files.map((file) => file.path);

    expect(paths).toContain(`server/${IDENTITY}/clans.287.db`);
    expect(paths).toContain(`server/${IDENTITY}/player.states.287.db`);
    // Este já some pela política de todo wipe: oferecê-lo aqui
    // sugeriria que desmarcá-lo o salvaria.
    expect(paths).not.toContain(`server/${IDENTITY}/player.deaths.16.db`);
  });

  it('o que a política de BP já leva sai da lista quando ela muda', async () => {
    const root = await installDir();

    const comKeep = await listPluginData({ installDir: root, identity: IDENTITY, bpPolicy: 'keep' });
    const comWipe = await listPluginData({ installDir: root, identity: IDENTITY, bpPolicy: 'wipe' });

    expect(comKeep.files.map((f) => f.path)).toContain(
      `server/${IDENTITY}/player.blueprints.16.db`,
    );
    expect(comWipe.files.map((f) => f.path)).not.toContain(
      `server/${IDENTITY}/player.blueprints.16.db`,
    );
  });

  it('cada item traz tamanho e data — é o que responde "isso ainda é usado?"', async () => {
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });

    for (const file of listing.files) {
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.modifiedAt).toBeGreaterThan(0);
    }
  });
});

describe('o que sumiu do disco continua na lista salva', () => {
  it('vira `missing`, e não some da escolha do admin', async () => {
    // Apagar a escolha porque o arquivo não estava lá naquele dia é
    // como se perde uma configuração em silêncio: o plugin volta a
    // ser instalado, e o full wipe deixa de levar o que devia.
    const root = await installDir();

    const listing = await listPluginData({
      installDir: root,
      identity: IDENTITY,
      selected: ['oxide/data/PluginQueFoiDesinstalado.json', 'oxide/data/Economics.json'],
    });

    expect(listing.missing).toEqual(['oxide/data/PluginQueFoiDesinstalado.json']);
    expect(listing.files.find((f) => f.path.endsWith('Economics.json'))?.selected).toBe(true);
  });

  it('e o purge simplesmente não tem o que apagar por ele', async () => {
    const root = await installDir();

    const targets = await resolvePluginDataTargets({
      installDir: root,
      identity: IDENTITY,
      selected: ['oxide/data/NaoExiste.json'],
    });

    expect(targets).toHaveLength(0);
  });
});

describe('o casamento de padrão', () => {
  it('* fica dentro de um segmento; ** atravessa pasta', () => {
    expect(matches('oxide/data/OrigemZVip.json', 'oxide/data/*.json')).toBe(true);
    // Um `*` que atravessasse pasta transformaria "os json desta
    // pasta" em "todo json do servidor" sem ninguém pedir.
    expect(matches('oxide/data/OrigemZ/historico.json', 'oxide/data/*.json')).toBe(false);
    expect(matches('oxide/data/OrigemZ/historico.json', 'oxide/data/**/*.json')).toBe(true);
  });

  it('ignora maiúsculas: no Windows os dois são o mesmo arquivo', () => {
    expect(matches('oxide/data/OrigemZVip.json', 'OXIDE/DATA/origemzvip.JSON')).toBe(true);
  });

  it('aceita contrabarra no padrão, porque é o que se copia da tela', () => {
    expect(matches('oxide/data/OrigemZVip.json', 'oxide\\data\\OrigemZVip.json')).toBe(true);
  });

  it('padrão vazio não casa com nada', () => {
    // Um padrão vazio que casasse com tudo seria o `del *.json` que
    // esta frente inteira existe para impedir.
    expect(matches('oxide/data/OrigemZVip.json', '')).toBe(false);
    expect(matches('oxide/data/OrigemZVip.json', '   ')).toBe(false);
  });

  it('ponto no padrão é ponto, e não "qualquer caractere"', () => {
    expect(matches('oxide/data/abcjson', 'oxide/data/abc.json')).toBe(false);
  });
});
