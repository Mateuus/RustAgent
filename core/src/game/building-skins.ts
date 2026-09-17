// ============================================================
//  building-skins.ts  -  as skins de construção, por material.
//
//  ####  O NÚMERO VEM DO JOGO, E NÃO DA MEMÓRIA  ####
//
//  MEDIDO em 17/09/2026 no server01, perguntando ao próprio prefab:
//  `PrefabAttribute.server.Find<Construction>(id).grades` devolve os
//  pares (grade, skin) que cada peça aceita. As seis peças que a
//  masmorra usa — fundação, parede, vão, quadro, piso e piso vazado —
//  devolveram a MESMA lista de quatorze pares: os cinco materiais
//  puros e as nove skins abaixo.
//
//  A skin é um par com o material, e não um enfeite solto: o
//  `Construction.GetGrade(grade, skin)` do jogo procura o par exato e,
//  sem achar, devolve o grade PADRÃO do prefab — o bloco vira palha em
//  silêncio. É por isso que o painel só oferece a skin do material
//  escolhido, e o schema recusa o par que o jogo não tem.
//
//  ####  A DE NATAL FICA DE FORA  ####
//
//  `gingerbread` (madeira, skin 2) está no prefab com
//  `enabledInStandalone = false`: o jogo distribuído a desliga. Ela
//  não é oferecida.
//
//  ####  O PAINEL TEM UM ESPELHO  ####
//
//  `panel/src/components/dungeons/building-skins.ts`, e o teste
//  `panel/test/dungeon-building-skins.test.ts` cobra que os dois sejam
//  iguais — a mesma regra do catálogo de caixas.
// ============================================================

import type { BuildGrade } from '../types/dungeons.js';

export interface BuildingSkin {
  /** O `skinID` do bloco. É o que viaja no JSON e no fio. */
  readonly id: number;
  /** O nome do `BuildingGrade` no jogo. */
  readonly key: string;
  /** O material ao qual a skin pertence. */
  readonly grade: BuildGrade;
  /** O que o admin lê. */
  readonly label: string;
}

export const BUILDING_SKINS: readonly BuildingSkin[] = [
  { id: 10232, key: 'frontier', grade: 'wood', label: 'Fronteira' },
  { id: 10220, key: 'adobe', grade: 'stone', label: 'Adobe' },
  { id: 10223, key: 'brick', grade: 'stone', label: 'Tijolo' },
  { id: 10225, key: 'brutalist', grade: 'stone', label: 'Brutalista' },
  { id: 10326, key: 'jungle', grade: 'stone', label: 'Selva' },
  { id: 10472, key: 'crypt', grade: 'stone', label: 'Cripta' },
  { id: 10221, key: 'shipping_container', grade: 'metal', label: 'Contêiner' },
  { id: 10430, key: 'space_station', grade: 'toptier', label: 'Estação espacial' },
];

/** As skins que aquele material aceita. Palha não tem nenhuma. */
export function skinsForGrade(grade: BuildGrade): readonly BuildingSkin[] {
  return BUILDING_SKINS.filter((skin) => skin.grade === grade);
}

/**
 * O par existe no jogo?
 *
 * Zero é "sem skin", e vale para qualquer material.
 */
export function isSkinCompatible(grade: BuildGrade, skin: number): boolean {
  return skin === 0 || BUILDING_SKINS.some((entry) => entry.id === skin && entry.grade === grade);
}
