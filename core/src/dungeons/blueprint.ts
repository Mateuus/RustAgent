// ============================================================
//  blueprint.ts  -  a planta, do lado do agente.
//
//  Uma planta é o JSON de uma construção: uma lista de peças com
//  posição, rotação e o que cada uma carrega dentro. O formato é o
//  do CopyPaste — herdado, e não escolhido —, e as sete que vieram
//  com o projeto estão nele.
//
//  ####  ESTE ARQUIVO SÓ RESPONDE TRÊS PERGUNTAS  ####
//
//    isto é uma planta?        `parseBlueprint`
//    o que tem dentro dela?    `analyzeBlueprint`
//    ela serve de entrada?     `hasHatch`, e é a que decide tudo
//
//  Ele NÃO cola nada e não sabe o que é o Rust. Quem constrói é o
//  `OrigemZDungeon.cs`; aqui só se olha o arquivo.
//
//  ------------------------------------------------------------
//  ####  A DETECÇÃO DO ALÇAPÃO É DUPLICADA, E DE PROPÓSITO  ####
//
//  As mesmas duas convenções estão implementadas no plugin
//  (`IsEntranceHatchMarker`). As duas pontas são compiladas
//  separadamente e nada as amarra além deste comentário — é a
//  mesma situação do `game/plugin-contract.ts`.
//
//  A duplicação paga por si: sem ela, uma planta sem alçapão só
//  seria recusada no jogo, 60 segundos depois de o jogador ver a
//  casinha de pé. Com ela, o painel recusa no upload e diz por quê.
//
//  MUDAR UMA CONVENÇÃO AQUI EXIGE MUDAR O .cs JUNTO.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §5.3.
// ============================================================

/** Uma peça da planta. Só o que o agente precisa olhar. */
interface BlueprintEntity {
  readonly prefabname?: unknown;
  readonly items?: unknown;
  readonly children?: unknown;
}

/** O arquivo inteiro. */
export interface Blueprint {
  readonly entities: readonly BlueprintEntity[];
}

/**
 * O fertilizante. É o item que marca o vaso.
 *
 * MEDIDO nas sete plantas herdadas em 08/09/2026. É o `itemid` do
 * Rust, e ele é negativo — como quase todos.
 */
const FERTILIZER_ITEM_ID = -930193596;

/** O código que marca um alçapão da planta. */
const HATCH_MARKER_CODE = '0707';

const HATCH_PREFAB = 'assets/prefabs/building/floor.ladder.hatch/floor.ladder.hatch.prefab';

/** O que `analyzeBlueprint` conta. */
export interface BlueprintFacts {
  readonly entityCount: number;
  readonly byteSize: number;
  /** Ver o cabeçalho: sem isto, a planta não serve de entrada. */
  readonly hasHatch: boolean;
  /** Quantas marcas foram achadas. A `entrance1` tem oito. */
  readonly hatchMarkers: number;
  /** Quantas peças o Rust provavelmente vai recusar. */
  readonly vehicles: number;
}

/** O motivo pelo qual um texto não é uma planta. */
export type BlueprintProblem =
  | 'not_json'
  | 'not_object'
  | 'no_entities'
  | 'empty';

/**
 * Lê o texto e devolve a planta, ou o motivo de não ser uma.
 *
 * Devolve o problema em vez de lançar porque quem chama é uma rota
 * HTTP, e ela precisa do motivo para escrever a frase — não de um
 * stack trace.
 */
export function parseBlueprint(
  raw: string,
): { readonly ok: true; readonly blueprint: Blueprint } | { readonly ok: false; readonly problem: BlueprintProblem } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'not_json' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problem: 'not_object' };
  }

  const entities = (parsed as { entities?: unknown }).entities;

  if (!Array.isArray(entities)) {
    return { ok: false, problem: 'no_entities' };
  }

  if (entities.length === 0) {
    return { ok: false, problem: 'empty' };
  }

  return { ok: true, blueprint: { entities: entities as readonly BlueprintEntity[] } };
}

/** A frase que o admin lê, por problema. */
export const BLUEPRINT_PROBLEM_MESSAGE: Record<BlueprintProblem, string> = {
  not_json: 'O arquivo não é um JSON válido.',
  not_object: 'O arquivo é um JSON, mas não é um objeto de planta.',
  no_entities: 'Falta a lista `entities`: isso não é uma planta do CopyPaste.',
  empty: 'A planta não tem nenhuma peça.',
};

/**
 * O que a planta tem dentro.
 *
 * Roda uma vez, na escrita, e o resultado vira coluna. A lista do
 * painel não pode abrir 512 KB de JSON para dizer "584 peças".
 */
export function analyzeBlueprint(blueprint: Blueprint, raw: string): BlueprintFacts {
  let hatchMarkers = 0;
  let vehicles = 0;

  for (const entity of blueprint.entities) {
    if (isHatchMarker(entity)) hatchMarkers += 1;
    if (isVehicle(entity)) vehicles += 1;
  }

  return {
    entityCount: blueprint.entities.length,
    byteSize: Buffer.byteLength(raw, 'utf8'),
    hasHatch: hatchMarkers > 0,
    hatchMarkers,
    vehicles,
  };
}

/**
 * Esta peça marca onde vai o alçapão?
 *
 * Duas convenções, as duas medidas nas plantas herdadas:
 *
 *   1. um `floor.ladder.hatch` com fechadura de código `0707`
 *      — as três `base*.json`
 *   2. um `planter.large` com fertilizante 1 no slot 0 e 999 no
 *      slot 5 — as três `entrance2..4.json`
 *
 * A segunda parece arbitrária e não é: um alçapão de verdade na
 * planta seria colado como alçapão comum, e o construtor teria de
 * adivinhar qual dos vários é *o* alçapão. Um vaso com 999
 * fertilizantes não acontece por acaso.
 */
function isHatchMarker(entity: BlueprintEntity): boolean {
  const prefab = typeof entity.prefabname === 'string' ? entity.prefabname : '';

  if (prefab === HATCH_PREFAB) {
    if (!Array.isArray(entity.children)) return false;

    return entity.children.some((child) => {
      if (child === null || typeof child !== 'object') return false;

      const node = child as { prefabname?: unknown; code?: unknown };
      const childPrefab = typeof node.prefabname === 'string' ? node.prefabname : '';

      return childPrefab.includes('lock.code') && node.code === HATCH_MARKER_CODE;
    });
  }

  if (prefab.includes('planter.large')) {
    if (!Array.isArray(entity.items)) return false;

    let slotZero = false;
    let slotFive = false;

    for (const item of entity.items) {
      if (item === null || typeof item !== 'object') continue;

      const node = item as { id?: unknown; position?: unknown; amount?: unknown };
      if (node.id !== FERTILIZER_ITEM_ID) continue;

      if (node.position === 0 && node.amount === 1) slotZero = true;
      if (node.position === 5 && node.amount === 999) slotFive = true;
    }

    return slotZero && slotFive;
  }

  return false;
}

/**
 * Veículo, que o construtor pula de propósito.
 *
 * Um carro só existe montado — chassi, módulos, motor —, e colá-lo
 * peça a peça produz um destroço que não anda. Contá-los aqui é o
 * que deixa o painel avisar "3 peças desta planta não vão subir"
 * antes de alguém estranhar no jogo.
 */
function isVehicle(entity: BlueprintEntity): boolean {
  const prefab = typeof entity.prefabname === 'string' ? entity.prefabname : '';

  return (
    prefab.includes('modularcar') ||
    prefab.includes('module_car_spawned') ||
    prefab.includes('modular_car_fuel_storage')
  );
}
