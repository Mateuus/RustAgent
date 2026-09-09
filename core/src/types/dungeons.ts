// ============================================================
//  dungeons.ts  -  O CONTRATO DA MASMORRA.
//
//  Duas maneiras de produzir a MESMA estrutura, e daí para baixo o
//  construtor é um só:
//
//    'recipe'     parâmetros; o jogo sorteia o layout, e cada
//                 nascimento sai diferente
//    'blueprint'  um grid desenhado no painel; sai sempre igual
//
//  ####  A COR DA SALA NÃO É DECORAÇÃO  ####
//
//  Verde, azul e vermelha são o TIER DE CONTEÚDO daquele cômodo:
//  quantos NPCs, que loot, que porta o jogador encontra. É a única
//  linguagem que o jogador aprende sem ler nada — porta vermelha
//  quer dizer "cuidado, e vale a pena".
//
//  ####  A RÉGUA É IMPORTADA, NUNCA REDIGITADA  ####
//
//  A rota valida com estes schemas; o repositório grava o que eles
//  produziram; o sync manda o mesmo tipo ao plugin.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §4 e §6.2.
// ============================================================

import { z } from 'zod';

import { slugSchema } from './world-events.js';

// ------------------------------------------------------------
//  §1  VOCABULÁRIO
// ------------------------------------------------------------

export const DUNGEON_MODES = ['recipe', 'blueprint'] as const;
export type DungeonMode = (typeof DUNGEON_MODES)[number];

export const ROOM_COLORS = ['green', 'blue', 'red'] as const;
export type RoomColor = (typeof ROOM_COLORS)[number];

/** A porta que a sala tem. É o que a cor significa no jogo. */
export const ROOM_DOORS = ['wood', 'metal', 'toptier'] as const;
export type RoomDoor = (typeof ROOM_DOORS)[number];

// ------------------------------------------------------------
//  §2  A RÉGUA DA ESCRITA
// ------------------------------------------------------------

/**
 * Um par min/max de contagem.
 *
 * `min > max` é o erro que produz o sintoma mais confuso: o sorteio
 * devolve lixo e a sala nasce vazia, sem nada no log dizendo por
 * quê.
 */
function countRange(field: string, max: number) {
  return z
    .object({ min: z.number().int().min(0).max(max), max: z.number().int().min(0).max(max) })
    .superRefine((value, ctx) => {
      if (value.min > value.max) {
        ctx.addIssue({ code: 'custom', message: `o mínimo de ${field} não pode ser maior que o máximo` });
      }
    });
}

/**
 * O prefab de uma caixa.
 *
 * Validado só como caminho de asset, e não contra uma lista
 * fechada: o Rust acrescenta contêiner a cada wipe, e uma lista
 * aqui viraria uma migração a cada update do jogo. Um prefab que
 * não existe é PULADO pelo construtor, com aviso — o mesmo
 * tratamento de qualquer peça que o jogo removeu.
 */
const cratePrefabSchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^assets\/.+\.prefab$/, 'informe o caminho completo do prefab');

export const dungeonRoomInputSchema = z.object({
  /** 'green'|'blue'|'red' no modo receita; 'A','B','C'… no modo planta. */
  key: z.string().min(1).max(16),
  color: z.enum(ROOM_COLORS).default('green'),
  npc: countRange('NPCs', 20).default({ min: 0, max: 1 }),
  loot: countRange('caixas', 20).default({ min: 1, max: 1 }),
  crates: z.array(cratePrefabSchema).max(20).default([]),
  door: z.enum(ROOM_DOORS).default('wood'),
  locked: z.boolean().default(false),
});

export type DungeonRoomInput = z.infer<typeof dungeonRoomInputSchema>;

/**
 * O grid desenhado, no modo planta.
 *
 * Uma string por linha de z, do MAIOR para o menor — a mesma ordem
 * em que um mapa é lido, com o norte em cima. Um caractere por
 * célula:
 *
 *     .  vazio        #  corredor
 *     E  a entrada    A-Z  a sala daquela letra
 *
 * ####  POR QUE TEXTO, E NÃO UMA LISTA DE OBJETOS  ####
 *
 * Uma masmorra de 20×20 tem 400 células. Como lista de
 * `{x, z, kind}` são 400 objetos e ~20 KB que ninguém lê; como 20
 * strings de 20 caracteres são 400 bytes, e quem abre o JSON VÊ A
 * MASMORRA. O custo é um parse de seis linhas nas duas pontas.
 */
export const dungeonGridSchema = z
  .array(z.string().regex(/^[.#E A-Z]*$/, 'use ".", "#", "E" ou uma letra por célula').max(64))
  .min(1)
  .max(64);

export type DungeonGrid = z.infer<typeof dungeonGridSchema>;

const dungeonBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(1000).nullable().optional(),

    mode: z.enum(DUNGEON_MODES).default('recipe'),

    /** O slug de uma planta. `null` = a entrada mínima gerada por código. */
    entranceBlueprint: z.string().min(1).max(64).nullable().default(null),

    // ---- modo 'recipe' ----
    // Uma sala é o piso; trinta é onde uma masmorra leva mais de
    // meia hora para ser limpa, e o evento acaba antes.
    size: countRange('tamanho', 30).default({ min: 10, max: 15 }),
    weights: z
      .object({
        green: z.number().int().min(0).max(100).default(60),
        blue: z.number().int().min(0).max(100).default(30),
        red: z.number().int().min(0).max(100).default(10),
      })
      .prefault({}),
    corridor: z
      .object({
        npcDensity: z.number().int().min(0).max(100).default(20),
        lootDensity: z.number().int().min(0).max(100).default(10),
        crates: z.array(cratePrefabSchema).max(20).default([]),
      })
      .prefault({}),

    // ---- modo 'blueprint' ----
    grid: dungeonGridSchema.nullable().default(null),

    // ---- os dois modos ----
    npc: z
      .object({
        health: countRange('vida', 5000).default({ min: 100, max: 150 }),
        damageScale: z.number().min(0).max(10).default(1),
        weapons: z.array(z.string().min(2).max(64)).max(20).default([]),
        names: z.array(z.string().min(1).max(40)).max(20).default([]),
      })
      .prefault({}),

    /** 0 a 23; -1 = não mexe na hora de quem entra. */
    timeOfDay: z.number().min(-1).max(23).default(0),

    rooms: z.array(dungeonRoomInputSchema).max(64).default([]),
  })
  .superRefine((value, ctx) => {
    // ####  AS DUAS REGRAS QUE SÓ SE ENXERGAM COM O OBJETO INTEIRO  ####
    //
    // Elas moram aqui, e não no repositório, porque o repositório
    // recebe o que já passou por esta régua. E não moram na rota
    // porque a captura in-game entra pelo mesmo caminho.

    if (value.mode === 'blueprint' && value.grid === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['grid'],
        message: 'no modo planta o grid é obrigatório: sem ele não há o que construir',
      });
    }

    if (value.mode === 'recipe') {
      const total = value.weights.green + value.weights.blue + value.weights.red;

      if (total === 0) {
        // Todos zero não é "sem salas": é uma divisão por zero no
        // sorteio, e a masmorra nasce só com corredor.
        ctx.addIssue({
          code: 'custom',
          path: ['weights'],
          message: 'pelo menos uma cor de sala precisa ter peso maior que zero',
        });
      }
    }
  });

/**
 * A criação: o corpo mais o slug.
 *
 * ####  POR QUE DOIS SCHEMAS, E NÃO UM `.omit()`  ####
 *
 * `superRefine` fecha o objeto: um `.omit({id: true})` depois dele
 * perderia as duas regras que só se enxergam com o objeto inteiro.
 * Então o corpo é validado uma vez, e o slug entra por fora — na
 * criação, pelo `id`; na edição, pela URL.
 */
export const dungeonInputSchema = z.intersection(
  z.object({ id: slugSchema }),
  dungeonBodySchema,
);

export type DungeonInput = z.infer<typeof dungeonInputSchema>;

/** A edição não mexe no slug: ele é a identidade. */
export const dungeonUpdateSchema = dungeonBodySchema;
export type DungeonUpdate = z.infer<typeof dungeonUpdateSchema>;

// ------------------------------------------------------------
//  §3  O QUE SAI DAQUI PARA O PAINEL
// ------------------------------------------------------------

export interface Dungeon extends DungeonInput {
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * O resumo da lista.
 *
 * Sem `grid` e sem `rooms`: a lista mostra dez masmorras e nenhuma
 * delas precisa do desenho para caber numa linha.
 */
export interface DungeonSummary {
  readonly id: string;
  readonly name: string;
  readonly mode: DungeonMode;
  readonly entranceBlueprint: string | null;
  readonly roomCount: number;
  readonly sizeMin: number;
  readonly sizeMax: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ####  A ORDEM DESTE BLOCO IMPORTA, E O TYPECHECK NÃO A VÊ  ####
//
// `FACTORY_RECIPES` chama `factory()`, que lê as duas constantes
// abaixo. Declará-las DEPOIS delas compila sem um aviso e explode
// no import, em tempo de execução:
//
//     ReferenceError: Cannot access 'CORRIDOR_CRATES'
//     before initialization
//
// E explode no BOOT do agente, porque `dungeons-repository.ts`
// importa este arquivo — o processo nem chega a servir uma rota.
// Foi assim que ele caiu em 09/09/2026. Não mova para baixo.

/** As caixas comuns de corredor, do 1.3.4. */
const CORRIDOR_CRATES = [
  'assets/bundled/prefabs/radtown/crate_normal.prefab',
  'assets/bundled/prefabs/radtown/crate_tools.prefab',
  'assets/bundled/prefabs/radtown/crate_basic.prefab',
  'assets/bundled/prefabs/radtown/crate_normal_2.prefab',
];

/** As caixas de cada cor, do 1.3.4. */
const CRATES_BY_COLOR: Record<RoomColor, readonly string[]> = {
  green: [
    'assets/bundled/prefabs/radtown/crate_normal.prefab',
    'assets/bundled/prefabs/radtown/crate_normal_2.prefab',
  ],
  blue: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
  red: [
    'assets/bundled/prefabs/radtown/crate_normal.prefab',
    'assets/bundled/prefabs/radtown/crate_elite.prefab',
  ],
};

/**
 * As quatro receitas de fábrica.
 *
 * São os tiers do `DungeonBases 1.3.4`, que já estão balanceados e
 * rodados. Elas existem para o admin ter de onde partir: duplicar e
 * mexer é infinitamente mais fácil que encarar trinta campos em
 * branco — e é o que faz a tela valer alguma coisa no primeiro
 * minuto.
 */
export const FACTORY_RECIPES: readonly DungeonInput[] = [
  factory('facil', 'Fácil', {
    size: { min: 1, max: 10 },
    weights: { green: 70, blue: 20, red: 10 },
    corridor: { npcDensity: 10, lootDensity: 5 },
    health: { min: 50, max: 80 },
    damageScale: 0.5,
    weapons: ['pistol.revolver', 'pistol.m92'],
    rooms: [
      { key: 'green', color: 'green', npc: { min: 0, max: 0 }, loot: { min: 1, max: 1 }, door: 'wood' },
      { key: 'blue', color: 'blue', npc: { min: 0, max: 1 }, loot: { min: 1, max: 2 }, door: 'metal' },
      { key: 'red', color: 'red', npc: { min: 1, max: 2 }, loot: { min: 2, max: 3 }, door: 'toptier' },
    ],
  }),
  factory('normal', 'Normal', {
    size: { min: 10, max: 15 },
    weights: { green: 60, blue: 30, red: 10 },
    corridor: { npcDensity: 20, lootDensity: 10 },
    health: { min: 80, max: 120 },
    damageScale: 1,
    weapons: ['rifle.semiauto', 'pistol.m92', 'smg.mp5'],
    rooms: [
      { key: 'green', color: 'green', npc: { min: 0, max: 1 }, loot: { min: 1, max: 1 }, door: 'wood' },
      { key: 'blue', color: 'blue', npc: { min: 1, max: 2 }, loot: { min: 1, max: 2 }, door: 'metal' },
      { key: 'red', color: 'red', npc: { min: 2, max: 3 }, loot: { min: 2, max: 3 }, door: 'toptier' },
    ],
  }),
  factory('dificil', 'Difícil', {
    size: { min: 15, max: 20 },
    weights: { green: 50, blue: 35, red: 15 },
    corridor: { npcDensity: 50, lootDensity: 20 },
    health: { min: 120, max: 180 },
    damageScale: 1.5,
    weapons: ['rifle.ak', 'rifle.lr300', 'shotgun.spas12', 'smg.mp5'],
    rooms: [
      { key: 'green', color: 'green', npc: { min: 1, max: 2 }, loot: { min: 1, max: 1 }, door: 'wood' },
      { key: 'blue', color: 'blue', npc: { min: 2, max: 3 }, loot: { min: 1, max: 2 }, door: 'metal' },
      { key: 'red', color: 'red', npc: { min: 3, max: 5 }, loot: { min: 2, max: 3 }, door: 'toptier' },
    ],
  }),
  factory('pesadelo', 'Pesadelo', {
    size: { min: 20, max: 30 },
    weights: { green: 30, blue: 40, red: 30 },
    corridor: { npcDensity: 80, lootDensity: 30 },
    health: { min: 180, max: 300 },
    damageScale: 2,
    weapons: ['rifle.ak', 'lmg.m249', 'rifle.lr300', 'smg.mp5', 'minigun'],
    rooms: [
      { key: 'green', color: 'green', npc: { min: 2, max: 3 }, loot: { min: 1, max: 1 }, door: 'wood' },
      { key: 'blue', color: 'blue', npc: { min: 3, max: 5 }, loot: { min: 1, max: 2 }, door: 'metal' },
      { key: 'red', color: 'red', npc: { min: 5, max: 8 }, loot: { min: 2, max: 3 }, door: 'toptier' },
    ],
  }),
];

function factory(
  id: string,
  name: string,
  spec: {
    size: { min: number; max: number };
    weights: { green: number; blue: number; red: number };
    corridor: { npcDensity: number; lootDensity: number };
    health: { min: number; max: number };
    damageScale: number;
    weapons: readonly string[];
    rooms: readonly {
      key: string;
      color: RoomColor;
      npc: { min: number; max: number };
      loot: { min: number; max: number };
      door: RoomDoor;
    }[];
  },
): DungeonInput {
  return dungeonInputSchema.parse({
    id,
    name,
    description: `Receita de fábrica: a dificuldade "${name.toLowerCase()}" do Dungeon Bases.`,
    mode: 'recipe',
    size: spec.size,
    weights: spec.weights,
    corridor: { ...spec.corridor, crates: CORRIDOR_CRATES },
    npc: {
      health: spec.health,
      damageScale: spec.damageScale,
      weapons: [...spec.weapons],
      names: ['Guardião', 'Sentinela', 'Vigia da Masmorra'],
    },
    rooms: spec.rooms.map((room) => ({
      ...room,
      crates: [...CRATES_BY_COLOR[room.color]],
      locked: room.color === 'red',
    })),
  });
}
