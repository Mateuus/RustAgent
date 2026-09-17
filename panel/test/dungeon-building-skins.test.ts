// ============================================================
//  O catálogo de skins de construção é um espelho, e espelho
//  divergente é pior que espelho nenhum.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO TRANCA  ####
//
//  `panel/src/components/dungeons/building-skins.ts` repete a lista
//  de `core/src/game/building-skins.ts`, que foi MEDIDA no jogo. Um
//  lado sem o outro falha em silêncio dos dois jeitos:
//
//    · faltando no painel: a skin existe e o admin não a encontra;
//    · sobrando no painel: a tela OFERECE um par (material, skin)
//      que a API recusa com 422 — ou, pior, que o jogo não conhece
//      e transforma o bloco em palha.
//
//  O teste lê o ARQUIVO do core como texto, pelo mesmo motivo do
//  `dungeon-crate-catalog.test.ts`: o painel e o core são dois
//  pacotes com tsconfig próprio, e um import atravessando a fronteira
//  passaria a valer para o build do Next.
// ============================================================

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BUILDING_SKINS,
  isSkinCompatible,
  skinsForGrade,
} from '@/components/dungeons/building-skins';

const CORE_FILE = new URL('../../core/src/game/building-skins.ts', import.meta.url);

interface SkinRow {
  id: number;
  key: string;
  grade: string;
  label: string;
}

/** As linhas da lista do arquivo do core, na ordem em que aparecem. */
function fromCore(): SkinRow[] {
  const source = readFileSync(CORE_FILE, 'utf8');
  const start = source.indexOf('export const BUILDING_SKINS: readonly BuildingSkin[] = [');

  if (start < 0) throw new Error('a lista BUILDING_SKINS não existe mais no core');

  const end = source.indexOf('\n];', start);
  const block = source.slice(start, end);
  const found: SkinRow[] = [];

  const entry = /\{\s*id:\s*(\d+),\s*key:\s*'([^']+)',\s*grade:\s*'([^']+)',\s*label:\s*'([^']*)'\s*\}/gu;
  let match = entry.exec(block);

  while (match !== null) {
    const [, id, key, grade, label] = match;

    if (id !== undefined && key !== undefined && grade !== undefined && label !== undefined) {
      found.push({ id: Number(id), key, grade, label });
    }

    match = entry.exec(block);
  }

  return found;
}

/** O texto de uma função do arquivo, sem espaços — para comparar a regra. */
function coreFunctionBody(name: string): string {
  const source = readFileSync(CORE_FILE, 'utf8');
  const start = source.indexOf(`export function ${name}(`);

  if (start < 0) throw new Error(`a função ${name} não existe mais no core`);

  const end = source.indexOf('\n}', start);

  return source.slice(start, end).replace(/\s+/gu, '');
}

describe('o catálogo de skins do painel espelha o do agente', () => {
  it('as skins são as mesmas, na mesma ordem', () => {
    const core = fromCore();

    // Oito é o que o jogo devolveu em 17/09/2026. Um número diferente
    // aqui quer dizer que a leitura do arquivo quebrou — e aí a
    // comparação de baixo passaria comparando duas listas vazias.
    expect(core).toHaveLength(8);
    expect(BUILDING_SKINS.map((skin) => ({ ...skin }))).toEqual(core);
  });

  it('as duas funções têm a mesma regra', () => {
    const panel = readFileSync(
      new URL('../src/components/dungeons/building-skins.ts', import.meta.url),
      'utf8',
    );

    for (const name of ['skinsForGrade', 'isSkinCompatible']) {
      const start = panel.indexOf(`export function ${name}(`);
      const end = panel.indexOf('\n}', start);

      expect(panel.slice(start, end).replace(/\s+/gu, '')).toBe(coreFunctionBody(name));
    }
  });

  it('não há id repetido', () => {
    // O `skinID` é a chave do par no jogo: dois materiais com o mesmo
    // número fariam `isSkinCompatible` aceitar o par errado.
    const ids = BUILDING_SKINS.map((skin) => skin.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('as skins de cada material', () => {
  it('palha não tem nenhuma', () => {
    expect(skinsForGrade('twigs')).toEqual([]);
  });

  it('pedra tem as cinco, na ordem do catálogo', () => {
    expect(skinsForGrade('stone').map((skin) => skin.label)).toEqual([
      'Adobe',
      'Tijolo',
      'Brutalista',
      'Selva',
      'Cripta',
    ]);
  });

  it('madeira, metal e blindado têm uma cada', () => {
    expect(skinsForGrade('wood').map((skin) => skin.id)).toEqual([10232]);
    expect(skinsForGrade('metal').map((skin) => skin.id)).toEqual([10221]);
    expect(skinsForGrade('toptier').map((skin) => skin.id)).toEqual([10430]);
  });
});

describe('isSkinCompatible', () => {
  it('zero vale para qualquer material', () => {
    for (const grade of ['twigs', 'wood', 'stone', 'metal', 'toptier'] as const) {
      expect(isSkinCompatible(grade, 0)).toBe(true);
    }
  });

  it('recusa a skin do material errado', () => {
    // O Contêiner é de metal. Em pedra, o jogo não acha o par e o
    // bloco vira palha — é exatamente o caso que a tela evita.
    expect(isSkinCompatible('metal', 10221)).toBe(true);
    expect(isSkinCompatible('stone', 10221)).toBe(false);
    expect(isSkinCompatible('twigs', 10232)).toBe(false);
  });

  it('recusa um número que não está no catálogo', () => {
    // A de Natal (madeira) existe no prefab, desligada no jogo
    // distribuído — e não é oferecida.
    expect(isSkinCompatible('wood', 2)).toBe(false);
    expect(isSkinCompatible('stone', 99999)).toBe(false);
  });
});
