// ============================================================
//  Os fatos de uma planta.
//
//  ####  ELE LÊ AS SETE PLANTAS DE VERDADE  ####
//
//  E não fixtures escritas à mão. A diferença importa: as duas
//  convenções de alçapão (§5.3.7 do plano) foram DESCOBERTAS
//  medindo estes arquivos, e uma fixture escrita a partir do que
//  eu achava que elas eram teria passado no teste e mentido.
//
//  Se os arquivos sumirem, o teste falha em vez de virar verde
//  vazio — um `it` que não roda nada é pior que nenhum teste.
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyzeBlueprint,
  BLUEPRINT_PROBLEM_MESSAGE,
  parseBlueprint,
} from '../src/dungeons/blueprint.js';

/**
 * Onde as sete plantas herdadas moram.
 *
 * `Assets/` e não `Docs/`: elas são conteúdo que o agente lê em
 * tempo de execução (o seeder do boot), e documentação é o que
 * gente lê.
 */
const BLUEPRINT_DIR = join(import.meta.dirname, '..', '..', 'Assets', 'dungeons');

function load(name: string): string {
  return readFileSync(join(BLUEPRINT_DIR, `${name}.json`), 'utf8');
}

/**
 * O que cada planta é, MEDIDO em 08/09/2026.
 *
 * As `base*` e a `entrance1` marcam o alçapão com um hatch de
 * código '0707'; as `entrance2..4`, com um vaso de fertilizante.
 *
 * ####  UMA MARCA POR PLANTA, EXATAMENTE  ####
 *
 * E isso não é sorte: a `entrance1` tem DOIS alçapões e SEIS vasos,
 * e só um deles carrega a marca. A convenção é precisa de propósito
 * — se qualquer alçapão servisse, o construtor teria de adivinhar
 * qual dos dois é a porta de entrada.
 *
 * A `entrance4` traz um carro modular, que o construtor pula.
 */
const EXPECTED = [
  { name: '#dung#base2', entities: 226, markers: 1, vehicles: 0 },
  { name: '#dung#base3', entities: 155, markers: 1, vehicles: 0 },
  { name: '#dung#base4', entities: 155, markers: 1, vehicles: 0 },
  { name: '#dung#entrance1', entities: 584, markers: 1, vehicles: 0 },
  { name: '#dung#entrance2', entities: 42, markers: 1, vehicles: 0 },
  { name: '#dung#entrance3', entities: 45, markers: 1, vehicles: 0 },
  { name: '#dung#entrance4', entities: 114, markers: 1, vehicles: 1 },
] as const;

describe('parseBlueprint', () => {
  it('aceita as sete plantas herdadas', () => {
    for (const { name } of EXPECTED) {
      const result = parseBlueprint(load(name));

      expect(result.ok, `${name} devia ser uma planta válida`).toBe(true);
    }
  });

  it('recusa o que não é planta, dizendo o quê', () => {
    expect(parseBlueprint('isto não é json')).toEqual({ ok: false, problem: 'not_json' });
    expect(parseBlueprint('[1,2,3]')).toEqual({ ok: false, problem: 'not_object' });
    expect(parseBlueprint('{"default":{}}')).toEqual({ ok: false, problem: 'no_entities' });
    expect(parseBlueprint('{"entities":[]}')).toEqual({ ok: false, problem: 'empty' });
  });

  it('tem uma frase para cada problema', () => {
    for (const problem of ['not_json', 'not_object', 'no_entities', 'empty'] as const) {
      expect(BLUEPRINT_PROBLEM_MESSAGE[problem].length).toBeGreaterThan(10);
    }
  });
});

describe('analyzeBlueprint', () => {
  it('conta as peças de cada planta', () => {
    for (const expected of EXPECTED) {
      const raw = load(expected.name);
      const parsed = parseBlueprint(raw);

      if (!parsed.ok) throw new Error(`${expected.name} não abriu`);

      const facts = analyzeBlueprint(parsed.blueprint, raw);

      expect(facts.entityCount, expected.name).toBe(expected.entities);
      expect(facts.byteSize).toBeGreaterThan(0);
    }
  });

  it('acha o alçapão nas SETE — as duas convenções', () => {
    // É este que quebra se alguém mexer numa das convenções sem
    // mexer no `OrigemZDungeon.cs` junto. Uma planta sem alçapão
    // sobe bonita e falha 60 segundos depois, no jogo.
    for (const expected of EXPECTED) {
      const raw = load(expected.name);
      const parsed = parseBlueprint(raw);

      if (!parsed.ok) throw new Error(`${expected.name} não abriu`);

      const facts = analyzeBlueprint(parsed.blueprint, raw);

      expect(facts.hasHatch, `${expected.name} devia ter alçapão`).toBe(true);
      expect(facts.hatchMarkers, expected.name).toBe(expected.markers);
    }
  });

  it('vê o carro modular da entrance4, e só o dela', () => {
    for (const expected of EXPECTED) {
      const raw = load(expected.name);
      const parsed = parseBlueprint(raw);

      if (!parsed.ok) throw new Error(`${expected.name} não abriu`);

      expect(analyzeBlueprint(parsed.blueprint, raw).vehicles, expected.name).toBe(
        expected.vehicles,
      );
    }
  });

  it('não confunde um hatch sem o código com uma marca', () => {
    // O código '0707' é o que separa "o alçapão que o construtor
    // deve usar" de "um alçapão qualquer que a construção tem".
    const semMarca = JSON.stringify({
      entities: [
        {
          prefabname: 'assets/prefabs/building/floor.ladder.hatch/floor.ladder.hatch.prefab',
          children: [{ prefabname: 'assets/prefabs/locks/keypad/lock.code.prefab', code: '1234' }],
        },
      ],
    });

    const parsed = parseBlueprint(semMarca);
    if (!parsed.ok) throw new Error('devia abrir');

    expect(analyzeBlueprint(parsed.blueprint, semMarca).hasHatch).toBe(false);
  });

  it('não confunde um vaso comum com uma marca', () => {
    // 1 e 999 nos slots 0 e 5. Um vaso com fertilizante de verdade
    // não tem essas quantidades exatas nesses slots exatos.
    const vasoComum = JSON.stringify({
      entities: [
        {
          prefabname: 'assets/prefabs/deployable/planters/planter.large.deployed.prefab',
          items: [{ id: -930193596, position: 0, amount: 5 }],
        },
      ],
    });

    const parsed = parseBlueprint(vasoComum);
    if (!parsed.ok) throw new Error('devia abrir');

    expect(analyzeBlueprint(parsed.blueprint, vasoComum).hasHatch).toBe(false);
  });
});
