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
//       maiúsculas — o disco onde isto roda é o do Windows;
//    7. o teto de linhas é da TELA, e não do purge: o que o admin
//       marcou some do disco inteiro, não só os 500 primeiros;
//    8. o par `.db`/`-wal` anda junto NOS DOIS SENTIDOS;
//    9. `**` inclui a PRÓPRIA pasta;
//   10. a varredura DIZ onde parou de descer.
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

/** O caminho absoluto de volta ao formato da lista salva. */
function relativo(root: string, target: string): string {
  return target.slice(root.length + 1).split('\\').join('/');
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

  it('`**` casa também a PRÓPRIA pasta, e não só as subpastas dela', () => {
    // A pegadinha clássica do globstar. `oxide/data/**/*.json`
    // exigindo uma pasta no meio deixava o `OrigemZStore.json` — a
    // carteira — de fora de um full wipe que o admin achou ter
    // marcado, e em SILÊNCIO, porque o padrão casava com os outros.
    expect(matches('oxide/data/OrigemZStore.json', 'oxide/data/**/*.json')).toBe(true);
    expect(matches('oxide/data/OrigemZ/historico.json', 'oxide/data/**/*.json')).toBe(true);
    expect(matches('oxide/data/n1/n2/fundo.json', 'oxide/data/**/*.json')).toBe(true);

    // E ele continua preso a `oxide/data`: um `**` que escapasse da
    // pasta transformaria a escolha do admin em `del *`.
    expect(matches('server/server01/clans.287.db', 'oxide/data/**/*.json')).toBe(false);
    expect(matches('oxide/config/OrigemZ.json', 'oxide/data/**/*.json')).toBe(false);
  });

  it('`**` no fim pega a pasta e tudo abaixo dela', () => {
    expect(matches('oxide/data/OrigemZVip.json', 'oxide/data/**')).toBe(true);
    expect(matches('oxide/data/OrigemZ/historico.json', 'oxide/data/**')).toBe(true);
    expect(matches('oxide/config/OrigemZ.json', 'oxide/data/**')).toBe(false);
  });
});

describe('o teto de linhas é da TELA, e nunca do que o wipe apaga', () => {
  /** 600 `.json` de um plugin só — o `oxide\data` de um servidor velho. */
  async function comSeiscentos(): Promise<string> {
    const root = await installDir();
    const pasta = join(root, 'oxide', 'data', 'PlayerDatabase');

    await mkdir(pasta, { recursive: true });

    for (let i = 0; i < 600; i += 1) {
      await writeFile(join(pasta, `7656119800000${String(i).padStart(4, '0')}.json`), '{"kills":1}');
    }

    return root;
  }

  const PADRAO = ['oxide/data/PlayerDatabase/*.json'];

  it('600 marcados: a tela mostra 500, e o purge leva os 600', async () => {
    // MEDIDO quando o corte valia para os dois: a lista devolveu
    // 500, o passo `apagar` gravou "500 de plugin", e 100 arquivos
    // que o admin mandou apagar continuaram em disco. Sem `missing`,
    // sem impedimento, sem aviso — o padrão tinha casado.
    const root = await comSeiscentos();

    const listing = await listPluginData({
      installDir: root,
      identity: IDENTITY,
      selected: PADRAO,
    });

    const targets = await resolvePluginDataTargets({
      installDir: root,
      identity: IDENTITY,
      selected: PADRAO,
    });

    expect(listing.files).toHaveLength(500);
    expect(targets).toHaveLength(600);
    expect(listing.missing).toHaveLength(0);
  });

  it('e a lista DIZ que cortou, em vez de fingir que aquilo é tudo', async () => {
    const root = await comSeiscentos();

    const listing = await listPluginData({
      installDir: root,
      identity: IDENTITY,
      selected: PADRAO,
    });

    expect(listing.truncated).toBe(true);
    expect(listing.total).toBeGreaterThan(600);
    expect(listing.total).toBeGreaterThan(listing.files.length);
  });

  it('lista pequena não se anuncia cortada', async () => {
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });

    expect(listing.truncated).toBe(false);
    expect(listing.total).toBe(listing.files.length);
  });
});

describe('o par .db e -wal anda junto, nos DOIS sentidos', () => {
  const BANCO = `server/${IDENTITY}/player.states.287.db`;
  const WAL = `server/${IDENTITY}/player.states.287.db-wal`;

  it('o satélite não é uma linha própria: ele entra na linha do banco', async () => {
    // Enquanto era linha, a ordenação por tamanho o punha ACIMA do
    // banco: quem procurava "player.states" na tela achava o `-wal`
    // primeiro.
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY, bpPolicy: 'keep' });
    const paths = listing.files.map((file) => file.path);

    expect(paths).toContain(BANCO);
    expect(paths).not.toContain(WAL);
    expect(listing.files.find((file) => file.path === BANCO)?.companions).toEqual([WAL]);
  });

  it('marcar o banco leva o -wal junto: senão ele fica órfão na pasta', async () => {
    const root = await installDir();

    const targets = await resolvePluginDataTargets({
      installDir: root,
      identity: IDENTITY,
      bpPolicy: 'keep',
      selected: [BANCO],
    });

    expect(targets.map((target) => relativo(root, target)).sort()).toEqual([BANCO, WAL].sort());
  });

  it('marcar o -wal leva o banco junto: sozinho, o banco reabre CALADO', async () => {
    // O pior dos dois sentidos. Levar só o `-wal` deixa um banco que
    // abre sem um erro sequer trazendo apenas o que já tinha sido
    // checkpointado: as transações confirmadas somem em silêncio, de
    // um arquivo que o wipe tinha a obrigação de preservar.
    const root = await installDir();

    const targets = await resolvePluginDataTargets({
      installDir: root,
      identity: IDENTITY,
      bpPolicy: 'keep',
      selected: [WAL],
    });

    expect(targets.map((target) => relativo(root, target)).sort()).toEqual([BANCO, WAL].sort());
  });

  it('e um padrão que só casa com o satélite NÃO é "missing"', async () => {
    const root = await installDir();

    const listing = await listPluginData({
      installDir: root,
      identity: IDENTITY,
      bpPolicy: 'keep',
      selected: [WAL],
    });

    expect(listing.missing).toHaveLength(0);
    expect(listing.files.find((file) => file.path === BANCO)?.selected).toBe(true);
  });

  it('um -wal ÓRFÃO continua sendo linha: só o full wipe o remove', async () => {
    const root = await installDir();

    await writeFile(join(root, 'server', IDENTITY, 'sobrou.287.db-wal'), 'orfao');

    const listing = await listPluginData({ installDir: root, identity: IDENTITY, bpPolicy: 'keep' });

    expect(listing.files.map((file) => file.path)).toContain(
      `server/${IDENTITY}/sobrou.287.db-wal`,
    );
  });

  it('e o full wipe pelo globstar leva a carteira da raiz de oxide\\data', async () => {
    const root = await installDir();

    const targets = await resolvePluginDataTargets({
      installDir: root,
      identity: IDENTITY,
      selected: ['oxide/data/**/*.json'],
    });

    const paths = targets.map((target) => relativo(root, target));

    expect(paths).toContain('oxide/data/OrigemZStore.json');
    expect(paths).toContain('oxide/data/OrigemZ/historico.json');
  });
});

describe('o que a varredura não olhou', () => {
  it('ela DIZ onde parou de descer, em vez de calar', async () => {
    // O limite de profundidade é intencional: um plugin de terceiro
    // pode criar uma árvore funda ou um link circular. O defeito era
    // o silêncio — nem a lista nem a rota diziam que havia mais.
    const root = await installDir();
    const data = join(root, 'oxide', 'data');

    await mkdir(join(data, 'n1', 'n2', 'n3', 'n4'), { recursive: true });
    await writeFile(join(data, 'n1', 'n2', 'n3', 'nivel3.json'), '{}');
    await writeFile(join(data, 'n1', 'n2', 'n3', 'n4', 'nivel4.json'), '{}');

    const listing = await listPluginData({ installDir: root, identity: IDENTITY });
    const paths = listing.files.map((file) => file.path);

    expect(paths).toContain('oxide/data/n1/n2/n3/nivel3.json');
    expect(paths).not.toContain('oxide/data/n1/n2/n3/n4/nivel4.json');
    expect(listing.notScanned).toContain('oxide/data/n1/n2/n3/n4');
  });

  it('árvore rasa não inventa pasta não varrida', async () => {
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });

    expect(listing.notScanned).toHaveLength(0);
  });
});

describe('o que vai para a tela e para o JSON', () => {
  it('modifiedAt é Epoch ms INTEIRO: o disco guarda fração, o campo não', async () => {
    // A rota respondeu `1787164730777.349` num campo documentado
    // como "Epoch ms" — `stat().mtimeMs` é float, e no NTFS o
    // carimbo tem resolução de 100 ns.
    const root = await installDir();
    const listing = await listPluginData({ installDir: root, identity: IDENTITY });

    expect(listing.files.length).toBeGreaterThan(0);

    for (const file of listing.files) {
      expect(Number.isInteger(file.modifiedAt)).toBe(true);
    }
  });
});
