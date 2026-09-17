// ============================================================
//  building-skins.ts  -  as skins de construção, por material.
//
//  ####  ESTE ARQUIVO É UM ESPELHO  ####
//
//  A fonte é `core/src/game/building-skins.ts`, e a lista de lá foi
//  MEDIDA no jogo em 17/09/2026: `Construction.grades` do próprio
//  prefab devolveu os pares (material, skin) que as peças da masmorra
//  aceitam. `panel/test/dungeon-building-skins.test.ts` cobra que as
//  duas listas sejam idênticas — a mesma regra do catálogo de caixas.
//
//  Espelho, e não uma rota, pelo mesmo motivo do `crate-catalog.ts`:
//  são oito linhas que só mudam com um update do jogo, e buscá-las
//  por HTTP poria um estado de carregamento no meio do seletor de
//  material.
//
//  ####  A SKIN SÓ EXISTE DENTRO DO MATERIAL  ####
//
//  O jogo guarda a skin como um PAR com o material, e o par que ele
//  não conhece vira palha sem aviso. É por isso que a tela só oferece
//  as skins do material escolhido — e zera a escolha quando o
//  material muda para um que não a tem. A API recusa o par torto com
//  422; esta lista é o que faz a tela nunca chegar a mandá-lo.
//
//  ####  A DE NATAL FICA DE FORA  ####
//
//  `gingerbread` (madeira) está no prefab e desligada no jogo
//  distribuído. Não é oferecida lá, e não é oferecida aqui.
// ============================================================

import type { BuildGrade } from '@/lib/api';

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
