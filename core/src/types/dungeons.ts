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

/**
 * A porta que a sala tem. É o que a cor significa no jogo.
 *
 * ####  AS QUATRO PRIMEIRAS SÃO DE UM METRO  ####
 *
 * Elas moram num `wall.doorway`; as seis seguintes têm dois metros
 * de passagem e moram num `wall.frame`. `none` é o vão aberto, de
 * propósito. A escolha muda a PEÇA que o construtor levanta, não só
 * a folha pendurada nela — ver `portas.md` §B.2.
 */
export const ROOM_DOORS = [
  // um metro de passagem, num `wall.doorway`
  'wood',
  'metal',
  'toptier',
  'industrial',
  // dois metros, num `wall.frame`
  'double_wood',
  'double_metal',
  'double_toptier',
  'cell_gate',
  'fence_gate',
  'garage',
  // sem folha nenhuma
  'none',
] as const;
export type RoomDoor = (typeof ROOM_DOORS)[number];

/** O nível de construção de uma peça. São os cinco do jogo. */
export const BUILD_GRADES = ['twigs', 'wood', 'stone', 'metal', 'toptier'] as const;
export type BuildGrade = (typeof BUILD_GRADES)[number];

/** O que a tabela faz com o que o Rust já pôs na caixa. */
export const LOOT_MODES = ['server', 'add', 'replace'] as const;
export type LootMode = (typeof LOOT_MODES)[number];

/** De onde o código da porta trancada sai. */
export const LOCK_CARRIERS = ['npc', 'crate', 'none'] as const;
export type LockCarrier = (typeof LOCK_CARRIERS)[number];

/** Onde o portador do código pode estar. Nunca dentro da sala que ele abre. */
export const LOCK_CARRIER_SCOPES = ['corridor', 'anywhere'] as const;
export type LockCarrierScope = (typeof LOCK_CARRIER_SCOPES)[number];

/** O que fazer com o código que não achou portador. */
export const LOCK_UNDELIVERED = ['unlock', 'keep'] as const;
export type LockUndelivered = (typeof LOCK_UNDELIVERED)[number];

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

/**
 * O nível de cada tipo de peça.
 *
 * `stone` em tudo é o que o construtor cravava até aqui — então uma
 * masmorra que ninguém reeditar nasce exatamente igual.
 */
const gradeSetSchema = z.object({
  foundation: z.enum(BUILD_GRADES).default('stone'),
  wall: z.enum(BUILD_GRADES).default('stone'),
  ceiling: z.enum(BUILD_GRADES).default('stone'),
});

export type GradeSetInput = z.infer<typeof gradeSetSchema>;

/**
 * O comportamento do inimigo.
 *
 * ####  TODO CAMPO É OPCIONAL, E ISSO É O DESENHO INTEIRO  ####
 *
 * Este bloco aparece em três lugares — `npc.ai` (o padrão da
 * masmorra), `rooms[].ai` (a cor daquela sala) e `corridor.ai` —, e
 * o de baixo sobrescreve o de cima CAMPO A CAMPO.
 *
 * Campo ausente não é zero: é "não falei disso", e o valor de cima
 * fica de pé. Um `.default(0)` aqui faria `fireInterval: 0` e "não
 * mandei fireInterval" serem a mesma coisa — e a herança viraria
 * substituição. É por isso que o `AiSpec` do plugin é todo
 * `float?`/`bool?`.
 *
 * As faixas são as mesmas do `AiProfile.Apply` do C#: o plugin
 * também aplica `Mathf.Clamp`, e ter as duas réguas iguais é o que
 * impede a tela de prometer um número que o jogo corta.
 */
export const aiSpecSchema = z.object({
  // ---- percepção ----
  /** Até onde ele enxerga. Com 0 ele só reage a tiro. */
  visionRadius: z.number().min(0).max(150).optional(),
  /** Falso = enxerga e atira ATRAVÉS da parede. */
  requireLineOfSight: z.boolean().optional(),
  /** Quanto tempo sem ver antes de desistir. */
  loseTargetAfter: z.number().min(0).max(300).optional(),
  /** Entre avistar e o primeiro tiro. É a chance do jogador de sair da mira. */
  reactionDelay: z.number().min(0).max(30).optional(),
  /** Diferença de altura que quebra o alvo: é o que impede o NPC de perseguir quem está na superfície. */
  maxTargetHeightDelta: z.number().min(0.5).max(50).optional(),
  /** Solta o grito do cientista ao avistar. */
  alertOnSpot: z.boolean().optional(),

  // ---- movimento ----
  /** Mira e atira, nunca sai do posto. */
  holdPosition: z.boolean().optional(),
  moveSpeed: z.number().min(0).max(12).optional(),
  /** Distância máxima do POSTO. É a coleira que o mantém dentro da masmorra. */
  chaseRadius: z.number().min(0).max(250).optional(),
  returnHome: z.boolean().optional(),
  returnSpeed: z.number().min(0).max(12).optional(),
  /** A que distância um ponto da trilha conta como alcançado. */
  arriveRadius: z.number().min(0.1).max(10).optional(),
  /** Preso este tempo, volta ao posto por teleporte. 0 desliga. */
  stuckTimeout: z.number().min(0).max(120).optional(),

  // ---- combate ----
  fireRange: z.number().min(0).max(250).optional(),
  /** Intervalo entre TENTATIVAS de tiro: só deixa mais lento que a arma, nunca mais rápido. */
  fireInterval: z.number().min(0.05).max(60).optional(),
  /** Chegou aqui, para de andar e atira. */
  standoffDistance: z.number().min(0).max(100).optional(),
  /** A dispersão, como multiplicador do cone da arma. Ausente = o valor do prefab fica de pé. */
  aimConeScale: z.number().min(0).max(20).optional(),

  // ---- ritmo (existe para o servidor cheio, não para o jogo) ----
  senseInterval: z.number().min(0.1).max(10).optional(),
  moveInterval: z.number().min(0.05).max(2).optional(),
});

export type AiSpecInput = z.infer<typeof aiSpecSchema>;

/**
 * O que o jogo faz quando o painel não fala nada.
 *
 * São os inicializadores do `AiProfile` do `OrigemZDungeon.cs`,
 * copiados aqui para a TELA poder mostrá-los como marca-d'água.
 * Sem isso o admin vê um campo vazio e não sabe se "vazio" é 0 ou
 * é alguma coisa — e `visionRadius` vazio é 18, não 0.
 *
 * `aimConeScale` fica de fora de propósito: o padrão dele mora no
 * prefab do cientista, dentro do bundle do jogo. Cravar um número
 * aqui mudaria a dificuldade do servidor sem ninguém pedir.
 */
export const AI_DEFAULTS = {
  visionRadius: 18,
  requireLineOfSight: true,
  loseTargetAfter: 6,
  reactionDelay: 0.4,
  maxTargetHeightDelta: 3,
  alertOnSpot: true,

  holdPosition: false,
  moveSpeed: 2.8,
  chaseRadius: 25,
  returnHome: true,
  returnSpeed: 2.2,
  arriveRadius: 0.6,
  stuckTimeout: 6,

  fireRange: 15,
  fireInterval: 0.35,
  standoffDistance: 2.5,

  senseInterval: 0.5,
  moveInterval: 0.2,
} as const satisfies Omit<Required<AiSpecInput>, 'aimConeScale'>;

/**
 * Uma linha da tabela de loot.
 *
 * ####  O SHORTNAME NÃO É VALIDADO CONTRA UMA LISTA  ####
 *
 * É a mesma decisão do `cratePrefabSchema`: o Rust acrescenta e
 * renomeia item a cada wipe, e uma lista fechada aqui viraria uma
 * migração a cada update do jogo. Item desconhecido é PULADO pelo
 * plugin, com aviso no console — e uma tabela de vinte linhas não
 * cai inteira por causa de um nome que mudou.
 */
export const lootEntrySchema = z.object({
  shortname: z.string().min(2).max(64),
  amount: countRange('quantidade', 10_000).default({ min: 1, max: 1 }),
  /** Peso no sorteio, relativo às outras linhas. */
  weight: z.number().int().min(1).max(1000).default(10),
  /** Cai sempre, e não gasta sorteio. */
  guaranteed: z.boolean().default(false),
  skin: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /** Cai o projeto, e não o item: no Rust são coisas diferentes. */
  blueprint: z.boolean().default(false),
  /** 0 a 1 da durabilidade cheia. 0 = a do jogo. */
  condition: z.number().min(0).max(1).default(0),
});

export type LootEntryInput = z.infer<typeof lootEntrySchema>;

/**
 * A tabela de uma cor de sala, do corredor ou do corpo do inimigo.
 *
 * ####  'server' É O PADRÃO, E ISSO É O DESENHO INTEIRO  ####
 *
 * Sem tabela, a caixa de radtown se enche sozinha pela tabela de
 * loot do servidor — e é assim que o BetterLoot continua valendo
 * dentro da masmorra. Quem não mexer em nada não perde isso.
 */
export const lootTableSchema = z
  .object({
    mode: z.enum(LOOT_MODES).default('server'),
    rolls: countRange('sorteios', 30).default({ min: 1, max: 2 }),
    entries: z.array(lootEntrySchema).max(60).default([]),
  })
  .superRefine((value, ctx) => {
    // Tabela sem itens em 'add' não faz nada, e em 'replace' pediria
    // uma caixa vazia. Os dois são quase sempre um campo que ficou
    // pela metade — e nenhum dos dois dá erro no jogo.
    if (value.mode !== 'server' && value.entries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'uma tabela sem itens não muda nada: use "server" ou acrescente pelo menos um item',
      });
    }
  });

export type LootTableInput = z.infer<typeof lootTableSchema>;

export const dungeonRoomInputSchema = z.object({
  /** 'green'|'blue'|'red' no modo receita; 'A','B','C'… no modo planta. */
  key: z.string().min(1).max(16),
  color: z.enum(ROOM_COLORS).default('green'),
  npc: countRange('NPCs', 20).default({ min: 0, max: 1 }),
  loot: countRange('caixas', 20).default({ min: 1, max: 1 }),
  crates: z.array(cratePrefabSchema).max(20).default([]),
  door: z.enum(ROOM_DOORS).default('wood'),
  locked: z.boolean().default(false),

  /** A porta da sala grande. `null` = usa `door` sempre. */
  wideDoor: z.enum(ROOM_DOORS).nullable().default(null),
  /** Células POR PORTA a partir das quais `wideDoor` entra. */
  wideDoorCellsPerDoor: z.number().int().min(1).max(64).default(4),
  /** O nível das peças desta cor. `null` = herda de `structure`. */
  grade: gradeSetSchema.nullable().default(null),

  /** O que cai nas caixas desta cor. `mode: 'server'` = a tabela do servidor. */
  table: lootTableSchema.prefault({}),
  /** O comportamento do inimigo desta cor. Campo ausente herda de `npc.ai`. */
  ai: aiSpecSchema.prefault({}),
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
        /** O que cai nas caixas do corredor. */
        table: lootTableSchema.prefault({}),
        /** O inimigo do corredor. Campo ausente herda de `npc.ai`. */
        ai: aiSpecSchema.prefault({}),
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
        /** O que o corpo do inimigo carrega. */
        loot: lootTableSchema.prefault({}),
        /** O comportamento PADRÃO, do qual as cores e o corredor herdam. */
        ai: aiSpecSchema.prefault({}),
      })
      .prefault({}),

    /** 0 a 23; -1 = não mexe na hora de quem entra. */
    timeOfDay: z.number().min(-1).max(23).default(0),

    /** O nível padrão das peças: corredor, entrada e tudo que não é sala. */
    structure: gradeSetSchema.prefault({}),

    /** Como a masmorra tranca, e como o código chega ao jogador. */
    lock: z
      .object({
        enabled: z.boolean().default(true),
        /** Um código para a masmorra inteira, em vez de um por sala. */
        sharedCode: z.boolean().default(false),
        carrier: z.enum(LOCK_CARRIERS).default('npc'),
        carrierScope: z.enum(LOCK_CARRIER_SCOPES).default('corridor'),
        onUndelivered: z.enum(LOCK_UNDELIVERED).default('unlock'),
        /** O nome do papel no inventário. */
        noteTitle: z.string().max(40).default('Código da porta'),
        announceOpen: z.boolean().default(true),
        warnOnWrongCode: z.boolean().default(true),
      })
      .prefault({}),

    /**
     * O ciclo do loot.
     *
     * Desligado é o certo no modo evento: a masmorra dura menos que
     * qualquer ciclo, e loot que volta num evento de 40 minutos é
     * loot dobrado.
     */
    respawn: z
      .object({
        enabled: z.boolean().default(false),
        minutes: z.number().int().min(1).max(1440).default(30),
        onlyWhenEmpty: z.boolean().default(true),
        rebuildDestroyed: z.boolean().default(true),
      })
      .prefault({}),

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

    // ####  SALA TRANCADA SEM PORTADOR É SALA QUE NINGUÉM ABRE  ####
    //
    // O plugin destranca e grita no log — mas o admin não lê o log
    // do servidor, e lê esta frase enquanto ainda pode consertar.
    const anyLocked = value.rooms.some((room) => room.locked);

    if (anyLocked && value.lock.enabled && value.lock.carrier === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['lock', 'carrier'],
        message:
          'há sala trancada e ninguém para carregar o código: escolha NPC ou caixa, ou destranque as salas',
      });
    }

    if (
      anyLocked &&
      value.lock.enabled &&
      value.lock.carrier === 'npc' &&
      value.lock.carrierScope === 'corridor' &&
      value.corridor.npcDensity === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['corridor', 'npcDensity'],
        message:
          'o código sai de um NPC de corredor e o corredor não tem nenhum: suba a densidade ou use "em qualquer lugar"',
      });
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
