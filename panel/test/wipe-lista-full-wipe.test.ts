// ============================================================
//  wipe-lista-full-wipe.test.ts  -  a caixa da lista do full wipe
//                                   tem de obedecer ao clique.
//
//  ####  O DEFEITO QUE ISTO EXISTE PARA PEGAR  ####
//
//  A linha da tela é um ARQUIVO; a lista salva é de PADRÕES. A
//  marca pode vir do caminho exato, do satélite (`...db-wal`,
//  gravado quando ele ainda era linha própria) ou de um glob —
//  mas o clique de desmarcar tirava `file.path` da lista, e só.
//
//  MEDIDO com a lista salva `['server/server01/clans.287.db-wal']`:
//  a tela abria com a linha do BANCO marcada; o admin clicava para
//  poupar os clãs; a lista saía IDÊNTICA; a tela recarregava
//  marcada; e o purge levava o par. A única caixa que removia
//  aquele padrão — a do próprio `-wal` — tinha deixado de existir,
//  e não há campo livre de padrão na tela.
//
//  Componente React não é montado aqui — o vitest do painel roda
//  em node puro, e a conta do clique é pura de propósito.
// ============================================================

import { describe, expect, it } from 'vitest';

import { patternsAfterToggle, selectionNote } from '@/components/wipe/labels';
import type { WipePluginDataFile } from '@/lib/api';

const BANCO = 'server/server01/clans.287.db';
const WAL = 'server/server01/clans.287.db-wal';
const VIP = 'oxide/data/OrigemZVip.json';
const CARTEIRA = 'oxide/data/OrigemZStore.json';
const GLOB = 'oxide/data/**/*.json';

/** Uma linha da lista, como o agente a devolve. */
function linha(patch: Partial<WipePluginDataFile> & { path: string }): WipePluginDataFile {
  const selectedBy = patch.selectedBy ?? [];

  return {
    area: 'oxide',
    bytes: 1024,
    modifiedAt: 1_787_186_613_891,
    companions: [],
    selected: selectedBy.length > 0,
    ...patch,
    selectedBy,
  };
}

describe('o clique na caixa da lista do full wipe', () => {
  it('marcar acrescenta o caminho exato da linha', () => {
    const vip = linha({ path: VIP });

    expect(patternsAfterToggle([BANCO], vip)).toEqual([BANCO, VIP]);
  });

  it('marcar duas vezes não duplica o padrão', () => {
    // A lista otimista pode chegar aqui já com o caminho dentro: um
    // padrão repetido não muda o que o wipe apaga, mas enche a
    // configuração de linhas que o admin não escreveu.
    const vip = linha({ path: VIP });

    expect(patternsAfterToggle([VIP], vip)).toEqual([VIP]);
  });

  it('desmarcar a linha marcada pelo próprio caminho tira o caminho', () => {
    const vip = linha({ path: VIP, selectedBy: [VIP] });

    expect(patternsAfterToggle([VIP, BANCO], vip)).toEqual([BANCO]);
  });

  it('desmarcar a linha marcada pelo SATÉLITE tira o padrão do satélite', () => {
    // ####  A LINHA QUE É O CONSERTO  ####
    //
    // Antes, o clique procurava `server/server01/clans.287.db` numa
    // lista que só tinha o `-wal`: a lista voltava idêntica e a
    // caixa recarregava marcada.
    const banco = linha({
      path: BANCO,
      area: 'save',
      companions: [WAL],
      selectedBy: [WAL],
    });

    expect(patternsAfterToggle([WAL], banco)).toEqual([]);
    expect(patternsAfterToggle([WAL, VIP], banco)).toEqual([VIP]);
  });

  it('desmarcar a linha marcada por um GLOB tira o glob', () => {
    // O mesmo mecanismo, e a mesma regra: o que sai da lista é o
    // que marcou a linha. Aqui isso desmarca as outras linhas do
    // glob junto — e é por isso que `selectionNote` avisa ANTES.
    const vip = linha({ path: VIP, selectedBy: [GLOB] });

    expect(patternsAfterToggle([GLOB], vip)).toEqual([]);
  });

  it('a comparação de caminho ignora maiúsculas, como o agente faz', () => {
    // O disco onde isto roda é o do Windows: `OrigemZVip.json` e
    // `origemzvip.json` são o mesmo arquivo lá.
    const vip = linha({ path: VIP });

    expect(patternsAfterToggle(['OXIDE/DATA/ORIGEMZVIP.JSON'], vip)).toEqual([
      'OXIDE/DATA/ORIGEMZVIP.JSON',
    ]);
  });
});

describe('a linha diz o que o clique vai remover', () => {
  it('marcada pelo próprio caminho, não há o que explicar', () => {
    const vip = linha({ path: VIP, selectedBy: [VIP] });

    expect(selectionNote(vip, [vip])).toBeNull();
  });

  it('linha desmarcada também não tem nota', () => {
    const vip = linha({ path: VIP });

    expect(selectionNote(vip, [vip])).toBeNull();
  });

  it('marcada pelo satélite, ela nomeia o padrão que segura a marca', () => {
    const banco = linha({ path: BANCO, area: 'save', companions: [WAL], selectedBy: [WAL] });
    const nota = selectionNote(banco, [banco]);

    expect(nota).toContain(WAL);
    expect(nota).toContain('desmarcar tira esse padrão da lista');
    // Uma linha só: não há outra saindo junto.
    expect(nota).not.toContain('mais 1 linha');
  });

  it('marcada por um glob, ela conta quantas OUTRAS linhas saem junto', () => {
    // Um padrão largo desmarcado às cegas é a mesma perda
    // silenciosa, na direção contrária: o admin quer poupar UM
    // arquivo e passa a apagar nenhum.
    const files = [
      linha({ path: VIP, selectedBy: [GLOB] }),
      linha({ path: CARTEIRA, selectedBy: [GLOB] }),
      linha({ path: 'oxide/data/Kits/kits_data.json', selectedBy: [GLOB] }),
    ];

    const nota = selectionNote(files[0] as WipePluginDataFile, files);

    expect(nota).toContain(GLOB);
    expect(nota).toContain('mais 2 linha(s)');
  });
});
