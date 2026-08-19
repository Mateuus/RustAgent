// ============================================================
//  wipe-save-files.test.ts  -  o que um wipe apaga, e o que não.
//
//  ####  A LISTA DE NOMES DAQUI FOI MEDIDA, NÃO INVENTADA  ####
//
//  Ela é o conteúdo real de
//  `Servers\server01\server\server01\` nesta árvore, conferido
//  com os próprios olhos antes de qualquer glob ser escrito. É por
//  isso que ela tem coisas que nenhum guia de wipe da internet
//  menciona:
//
//    player.tokens.db                 SEM número de versão
//    player.blueprints.16.db          versão 16
//    player.states.287.db             versão 287, na MESMA pasta
//    relationship.287.db              reconhecimento entre jogadores
//    ...287_occlusion_3.dat           12 MB derivados do mapa
//
//  O que este arquivo guarda:
//
//    1. o `-wal` tem SEMPRE o destino do `.db` dele;
//    2. o número no nome é a versão do formato — o padrão é por
//       prefixo, e casa tanto o `16` quanto o `287`;
//    3. `player.tokens.db`, sem número nenhum, não escapa;
//    4. `keep` mantém os blueprints; `wipe` e `wipe_except_vip` os
//       levam, e levam o `-wal` junto;
//    5. o que o agente não reconhece FICA.
// ============================================================

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyFile, classifySaveFolder, saveFolderPath } from '../src/wipe/save-files.js';

/** O conteúdo medido da pasta de saves do server01. */
const MEASURED = [
  'Log.EAC.txt',
  'clans.287.db',
  'clans.287.db-wal',
  'companion.id',
  'player.blueprints.16.db',
  'player.blueprints.16.db-wal',
  'player.deaths.16.db',
  'player.deaths.16.db-wal',
  'player.identities.16.db',
  'player.identities.16.db-wal',
  'player.states.287.db',
  'player.states.287.db-wal',
  'player.tokens.db',
  'player.tokens.db-wal',
  'proceduralmap.4000.12345.287.map',
  'proceduralmap.4000.12345.287.sav',
  'proceduralmap.4000.12345.287.sav.1',
  'proceduralmap.4000.12345.287.sav.2',
  'proceduralmap.4000.12345.287_occlusion_3.dat',
  'relationship.287.db',
  'relationship.287.db-wal',
  'sv.files.287.db',
  'sv.files.287.db-wal',
];

const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Uma pasta de saves de mentira, com os nomes medidos. */
async function saveFolder(names: readonly string[] = MEASURED): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rustagent-save-'));

  temporary.push(dir);

  for (const name of names) {
    await writeFile(join(dir, name), `conteudo de ${name}`);
  }

  return dir;
}

describe('o caminho da pasta do save', () => {
  it('é <installDir>\\server\\<identity>, e o identity manda', () => {
    // ####  O identity NÃO É O ID DO SERVIDOR  ####
    //
    // Por padrão eles coincidem, e é por isso que um caminho
    // montado com o id passa despercebido — até o dia em que
    // alguém troca a SERVER_IDENTITY. Aí o wipe classificaria uma
    // pasta VAZIA, não apagaria nada e relataria sucesso.
    expect(saveFolderPath('F:\\Servers\\pvp1', 'meuservidor')).toBe(
      join('F:\\Servers\\pvp1', 'server', 'meuservidor'),
    );
  });
});

describe('o -wal segue o destino do .db', () => {
  it('some junto com o arquivo que ele acompanha', () => {
    const db = classifyFile('player.blueprints.16.db', 'wipe');
    const wal = classifyFile('player.blueprints.16.db-wal', 'wipe');

    expect(db.fate).toBe('delete');
    expect(wal.fate).toBe('delete');
    // A herança é explícita na frase: quem lê a tela precisa saber
    // que aquele arquivo não foi escolhido sozinho.
    expect(wal.reason).toContain('player.blueprints.16.db');
  });

  it('FICA junto com o arquivo que fica', () => {
    const wal = classifyFile('player.blueprints.16.db-wal', 'keep');

    expect(wal.fate).toBe('keep');
  });

  it('vale para -shm e -journal também', () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      expect(classifyFile(`player.deaths.16.db${suffix}`, 'keep').fate).toBe('delete');
    }
  });
});

describe('o número no nome é a versão do FORMATO', () => {
  it('casa 16 e 287 na mesma pasta, e o sem-número também', () => {
    // Os três convivem de verdade. Um padrão com número cravado
    // deixaria o arquivo novo para trás no mês em que a Facepunch
    // mudasse o formato — e o BP wipe simplesmente não aconteceria.
    expect(classifyFile('player.blueprints.16.db', 'wipe').fate).toBe('delete');
    expect(classifyFile('player.blueprints.9999.db', 'wipe').fate).toBe('delete');
    expect(classifyFile('player.deaths.287.db', 'keep').fate).toBe('delete');
    expect(classifyFile('player.tokens.db', 'keep').group).toBe('players');
  });
});

describe('a política de blueprint', () => {
  it('keep mantém player.blueprints.* e o -wal dele', async () => {
    const summary = await classifySaveFolder(await saveFolder(), 'keep');
    const kept = summary.files.filter((file) => file.fate === 'keep').map((file) => file.name);

    expect(kept).toContain('player.blueprints.16.db');
    expect(kept).toContain('player.blueprints.16.db-wal');
  });

  it('wipe leva os dois', async () => {
    const summary = await classifySaveFolder(await saveFolder(), 'wipe');
    const gone = summary.files.filter((file) => file.fate === 'delete').map((file) => file.name);

    expect(gone).toContain('player.blueprints.16.db');
    expect(gone).toContain('player.blueprints.16.db-wal');
  });

  it('wipe_except_vip também leva — o arquivo é de todos de uma vez', async () => {
    // ####  NÃO DÁ PARA RECORTAR ESTE ARQUIVO POR JOGADOR  ####
    //
    // `player.blueprints.<n>.db` é UM arquivo, com todo mundo
    // dentro. Preservar "só o de quem é VIP" por arquivo é
    // impossível — quem devolve é o snapshot, depois (Frente I).
    const summary = await classifySaveFolder(await saveFolder(), 'wipe_except_vip');
    const blueprint = summary.files.find((file) => file.name === 'player.blueprints.16.db');

    expect(blueprint?.fate).toBe('delete');
    expect(blueprint?.reason).toContain('snapshot');
  });
});

describe('o que todo wipe leva, e o que ele nunca leva', () => {
  it('leva o mundo, a oclusão derivada dele, os uploads e a tela de morte', async () => {
    const summary = await classifySaveFolder(await saveFolder(), 'keep');
    const gone = new Set(
      summary.files.filter((file) => file.fate === 'delete').map((file) => file.name),
    );

    expect(gone).toContain('proceduralmap.4000.12345.287.map');
    expect(gone).toContain('proceduralmap.4000.12345.287.sav');
    // Os rotativos do jogo: manter um `.sav.1` é manter o mundo
    // antigo a um rename de distância.
    expect(gone).toContain('proceduralmap.4000.12345.287.sav.1');
    expect(gone).toContain('proceduralmap.4000.12345.287.sav.2');
    expect(gone).toContain('proceduralmap.4000.12345.287_occlusion_3.dat');
    expect(gone).toContain('sv.files.287.db');
    expect(gone).toContain('sv.files.287.db-wal');
    expect(gone).toContain('player.deaths.16.db');
  });

  it('nunca leva identidade, times nem o que não reconhece', async () => {
    const summary = await classifySaveFolder(await saveFolder(), 'wipe');
    const kept = new Set(
      summary.files.filter((file) => file.fate === 'keep').map((file) => file.name),
    );

    expect(kept).toContain('player.identities.16.db');
    expect(kept).toContain('player.states.287.db');
    expect(kept).toContain('player.tokens.db');
    expect(kept).toContain('clans.287.db');
    expect(kept).toContain('relationship.287.db');
    // O agente não mexe no que não conhece. Um arquivo novo da
    // Facepunch entra por aqui, e fica.
    expect(kept).toContain('companion.id');
    expect(kept).toContain('Log.EAC.txt');
  });

  it('todo arquivo sai com o motivo escrito', async () => {
    const summary = await classifySaveFolder(await saveFolder(), 'keep');

    for (const file of summary.files) {
      expect(file.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('a pasta que não existe', () => {
  it('devolve exists:false em vez de lançar', async () => {
    // É o estado normal de quem nunca subiu o servidor, e o passo
    // `apagar` o trata como sucesso.
    const summary = await classifySaveFolder(
      join(tmpdir(), 'rustagent-nao-existe-de-jeito-nenhum'),
      'keep',
    );

    expect(summary.exists).toBe(false);
    expect(summary.files).toHaveLength(0);
    expect(summary.deletedBytes).toBe(0);
  });
});
