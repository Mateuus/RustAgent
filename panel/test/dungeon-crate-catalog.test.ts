// ============================================================
//  O catálogo de caixas e inimigos é um espelho, e espelho
//  divergente é pior que espelho nenhum.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO TRANCA  ####
//
//  `panel/src/components/dungeons/crate-catalog.ts` repete a lista
//  de `core/src/game/dungeon-prefabs.ts`. A duplicação é uma
//  escolha — são ~45 linhas que não mudam entre wipes, e buscá-las
//  por HTTP poria um estado de carregamento no meio de um
//  formulário.
//
//  O preço dela é este: um prefab acrescentado num lado e não no
//  outro. E o sintoma é mudo dos dois jeitos —
//
//    · faltando no painel: a caixa existe e o admin não a encontra;
//    · faltando no core: a tela OFERECE um caminho que ninguém
//      conferiu contra o manifest do jogo, e a sala nasce vazia
//      porque o `CreateEntity` devolveu null em silêncio.
//
//  Então o teste lê o ARQUIVO do core como texto e compara os pares
//  (caminho, nome). Ler o texto, e não importar o módulo: o painel
//  e o core são dois pacotes com tsconfig próprio, e um import
//  atravessando a fronteira passaria a valer para o build do Next.
// ============================================================

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DUNGEON_CRATES,
  DUNGEON_NPCS,
  searchDungeonPrefabs,
} from '@/components/dungeons/crate-catalog';

const CORE_FILE = new URL('../../core/src/game/dungeon-prefabs.ts', import.meta.url);

/** Os pares (caminho, nome) de uma das listas do arquivo do core. */
function fromCore(listName: string): { prefab: string; label: string }[] {
  const source = readFileSync(CORE_FILE, 'utf8');
  const start = source.indexOf(`export const ${listName}: readonly DungeonPrefabEntry[] = [`);

  if (start < 0) throw new Error(`a lista ${listName} não existe mais no core`);

  const end = source.indexOf('\n];', start);
  const block = source.slice(start, end);
  const found: { prefab: string; label: string }[] = [];

  const entry = /prefab:\s*'([^']+)',\s*label:\s*'([^']*)'/gu;
  let match = entry.exec(block);

  while (match !== null) {
    const [, prefab, label] = match;

    if (prefab !== undefined && label !== undefined) found.push({ prefab, label });

    match = entry.exec(block);
  }

  return found;
}

describe('o catálogo do painel espelha o do agente', () => {
  it('as caixas são as mesmas, na mesma ordem', () => {
    const core = fromCore('DUNGEON_CRATES');

    // A ORDEM também: ela é a do risco (do farm de rota para o
    // evento), e é o que faz a primeira opção da lista ser a que o
    // admin quer em nove de cada dez vezes.
    expect(DUNGEON_CRATES.map((entry) => ({ prefab: entry.prefab, label: entry.label }))).toEqual(
      core,
    );
  });

  it('os inimigos são os mesmos, na mesma ordem', () => {
    expect(DUNGEON_NPCS.map((entry) => ({ prefab: entry.prefab, label: entry.label }))).toEqual(
      fromCore('DUNGEON_NPCS'),
    );
  });

  it('os grupos de toda entrada existem na ordem que a tela desenha', () => {
    // Um grupo que o catálogo usa e a tela não conhece cairia fora de
    // qualquer cabeçalho — foi assim que 33 containers viraram
    // "Outros" no editor de loot, em 06/09/2026.
    const crateGroups = new Set(DUNGEON_CRATES.map((entry) => entry.group));
    const npcGroups = new Set(DUNGEON_NPCS.map((entry) => entry.group));

    expect([...crateGroups].sort()).toEqual(
      ['As mais usadas', 'Barris e lixo', 'Caixas comuns', 'Caixas de risco', 'Guardados (nascem vazios)'].sort(),
    );
    expect([...npcGroups].sort()).toEqual(['De evento', 'Guardas', 'Patrulha'].sort());
  });
});

describe('a busca do seletor', () => {
  it('acha pelo nome, sem exigir o acento', () => {
    // Ninguém digita "munição" com acento no meio de um formulário.
    const found = searchDungeonPrefabs(DUNGEON_CRATES, 'municao');

    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe('Caixa de munição');
  });

  it('acha pelo caminho colado de um log', () => {
    const found = searchDungeonPrefabs(DUNGEON_CRATES, 'crate_elite');

    expect(found.map((entry) => entry.label)).toContain('Caixa de elite');
  });

  it('busca vazia devolve o catálogo inteiro', () => {
    expect(searchDungeonPrefabs(DUNGEON_CRATES, '')).toHaveLength(DUNGEON_CRATES.length);
  });

  it('não confunde a caixa comum com a militar', () => {
    // `crate_normal` é a MILITAR e `crate_normal_2` é a comum — o
    // nome do arquivo diz o contrário do que a peça é, e é a razão
    // principal de este seletor existir.
    const militar = DUNGEON_CRATES.find((entry) => entry.label === 'Caixa militar');
    const comum = DUNGEON_CRATES.find((entry) => entry.label === 'Caixa comum');

    expect(militar?.prefab).toContain('crate_normal.prefab');
    expect(comum?.prefab).toContain('crate_normal_2.prefab');
  });
});
