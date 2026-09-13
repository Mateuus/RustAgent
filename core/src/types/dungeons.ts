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

/**
 * O que a casinha da entrada carrega dentro.
 *
 * ####  `none` É O PADRÃO PORQUE A PLANTA VEIO CHEIA  ####
 *
 * MEDIDO em 09/09/2026, apontado pelo dono: as quatro plantas de
 * entrada do projeto trazem armas nas caixas — a `entrance2`, que
 * é a entrada das duas masmorras cadastradas, traz uma M249; a
 * `entrance3` traz minigun e lança-foguetes; a `entrance1` traz um
 * arsenal com 200 explosives e 1.000 scrap.
 *
 * Não é loot desenhado: é o que estava dentro das caixas quando
 * alguém copiou a construção, em outro servidor. O construtor
 * copiava fielmente, e virou conteúdo por acidente.
 *
 *   `none`     nada. A casinha nasce com as caixas vazias.
 *   `unarmed`  tudo, menos arma, munição e explosivo.
 *   `all`      o que a planta mandar — para quem a desenhou.
 *
 * A escolha é da MASMORRA e não da planta: a mesma entrada pode
 * servir a duas masmorras com regras diferentes.
 */
export const ENTRANCE_ITEM_MODES = ['none', 'unarmed', 'all'] as const;
export type EntranceItemMode = (typeof ENTRANCE_ITEM_MODES)[number];

/** De onde o código da porta trancada sai. */
export const LOCK_CARRIERS = ['npc', 'crate', 'none'] as const;
export type LockCarrier = (typeof LOCK_CARRIERS)[number];

/** Onde o portador do código pode estar. Nunca dentro da sala que ele abre. */
export const LOCK_CARRIER_SCOPES = ['corridor', 'anywhere'] as const;
export type LockCarrierScope = (typeof LOCK_CARRIER_SCOPES)[number];

/**
 * O que fazer com o código que não achou portador.
 *
 * ####  `abort` EXISTE PORQUE DESTRANCAR TAMBÉM É UMA PERDA  ####
 *
 * Pedido do dono em 13/09/2026: *"o sistema deve validar a rota
 * antes de construir a Dungeon. Se não existir um local acessível
 * para o código, deve impedir a construção ou destrancar a sala,
 * conforme a configuração escolhida."*
 *
 *   `unlock`  destranca e ergue (o padrão: uma masmorra com uma
 *             porta aberta ainda é jogável);
 *   `keep`    ergue com a sala lacrada — para o evento em que o
 *             admin abre a porta na mão;
 *   `abort`   NÃO ergue. É para quem prefere consertar o desenho a
 *             entregar uma masmorra que promete o que não cumpre.
 *
 * Só `abort` é destrutivo para o evento (ninguém joga), e é por
 * isso que ele não é o padrão: uma masmorra que não nasce no
 * horário é um evento perdido, e o desenho continua errado do
 * mesmo jeito.
 */
export const LOCK_UNDELIVERED = ['unlock', 'keep', 'abort'] as const;
export type LockUndelivered = (typeof LOCK_UNDELIVERED)[number];

/** O que um marcador do desenho põe naquela célula. */
export const PLACEMENT_KINDS = ['npc', 'crate'] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/**
 * Quem desce pelo alçapão.
 *
 * ####  `everyone` NASCE PRIMEIRO PORQUE É O PEDIDO DO DONO  ####
 *
 * "A Dungeon todo o servidor pode entrar nela, não só um player que
 * faz claimer" — 09/09/2026. A masmorra já era de todos por acaso,
 * porque ninguém tinha escrito o contrário; agora é por escolha.
 *
 * Fechá-la exige DIZER isso, e o plugin trata qualquer valor que
 * não seja exatamente `permission` como `everyone`: um modo escrito
 * errado não pode trancar a masmorra.
 */
export const ACCESS_WHO_ENTERS = ['everyone', 'permission'] as const;
export type AccessWhoEnters = (typeof ACCESS_WHO_ENTERS)[number];

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

/**
 * O prêmio em OZCoin de uma caixa.
 *
 * ####  ELE NÃO É UM ITEM DENTRO DA CAIXA  ####
 *
 * OZCoin é SALDO — mora na carteira (o banco do agente, ou o site
 * quando o servidor está pareado), e não no inventário de ninguém.
 * Então o que acontece aqui é o que já acontece na recompensa de
 * quest: a caixa sorteia o valor ao nascer, e quando alguém a abre
 * o plugin grita para o agente, que credita com `Wallet.credit`.
 *
 * Pôr a moeda como item seria a outra decisão possível, e ela
 * perde: a moeda física da loja é um `researchpaper` marcado, e
 * hoje nenhuma ação de item custom credita carteira — o jogador
 * ficaria com um papel na mão e nada no saldo.
 *
 * ####  E A CHANCE É SORTEADA UMA VEZ POR CAIXA  ####
 *
 * No nascimento, e não na abertura: assim o respawn re-sorteia
 * (cada caixa nova é uma chance nova) e duas pessoas abrindo a
 * mesma caixa não produzem dois prêmios. Quem chega segundo não
 * ganha nada — como acontece com o loot.
 */
export const coinsDropSchema = z.object({
  /**
   * Quanto. Um intervalo, porque prêmio fixo em toda caixa vira
   * salário: o jogador soma de cabeça e para de abrir caixa.
   */
  amount: countRange('OZCoin', 1_000_000).default({ min: 50, max: 200 }),
  /** A chance, em porcento, de esta caixa ter prêmio. */
  chance: z.number().int().min(1).max(100).default(100),
});

export type CoinsDropInput = z.infer<typeof coinsDropSchema>;

/**
 * Uma caixa cadastrada numa cor de sala ou no corredor.
 *
 * ####  ERA UMA STRING, E UMA STRING NÃO TEM CONTEÚDO  ####
 *
 * `crates` era uma lista de caminhos: "esta cor sorteia entre estas
 * quatro caixas". O que caía DENTRO delas vinha de uma tabela só, a
 * da cor — então "a caixa de elite desta sala tem a AK, e as comuns
 * têm sucata" não era escrevível. Pedido do dono em 13/09/2026:
 * *"também deve ser possível selecionar uma caixa específica e
 * personalizar seu conteúdo"*.
 *
 * Agora cada caixa carrega o que ela quiser:
 *
 *   `table: null`   usa a tabela da cor (ou do corredor). É o
 *                   padrão, e é o que mantém de pé toda masmorra
 *                   que já existia;
 *   `table: {…}`    esta caixa tem a dela, e a da cor não a
 *                   alcança. Os três modos são os mesmos —
 *                   `server`, `add`, `replace`.
 *
 * ####  A STRING ANTIGA CONTINUA ENTRANDO  ####
 *
 * O `preprocess` transforma `"assets/…/crate_elite.prefab"` em
 * `{ prefab: "assets/…/crate_elite.prefab" }`. Isso não é gentileza
 * com JSON escrito à mão: é o que faz a masmorra gravada antes
 * desta mudança ser LIDA pelo repositório sem migração de dados —
 * e é o que faz a captura in-game e um PUT de painel antigo
 * continuarem valendo.
 */
export const crateSpecSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? { prefab: raw } : raw),
  z.object({
    prefab: cratePrefabSchema,
    /** `null` = a tabela da cor de sala (ou do corredor). */
    table: lootTableSchema.nullable().default(null),
    /** `null` = esta caixa não paga OZCoin. */
    coins: coinsDropSchema.nullable().default(null),
  }),
);

export type CrateSpecInput = z.infer<typeof crateSpecSchema>;

/**
 * Vinte caixas cadastradas, no máximo, e sem prefab repetido.
 *
 * ####  O REPETIDO SERIA AMBÍGUO NO JOGO  ####
 *
 * O construtor sorteia POR PREFAB, e o conteúdo próprio viaja
 * chaveado por ele (ver `CrateContentPayload`): duas linhas
 * `crate_elite` com tabelas diferentes não têm resposta certa — o
 * jogo obedeceria a uma das duas, e o admin veria a outra na tela.
 *
 * Recusar aqui é melhor que escolher uma: o admin queria DUAS
 * caixas de elite na sala, e isso já é o que a faixa `loot` dela
 * faz — a lista é o catálogo de TIPOS, não a contagem de peças.
 *
 * O teto de vinte é o de antes. Ele vale mais agora: vinte caixas
 * com tabela própria de oito itens são uns 6 KB no comando de
 * RCON, e o orçamento do `sync` é de 50 KB para TODAS as masmorras
 * daquele servidor.
 */
const crateListSchema = z
  .array(crateSpecSchema)
  .max(20)
  .default([])
  .superRefine((crates, ctx) => {
    const seen = new Set<string>();

    for (const crate of crates) {
      if (seen.has(crate.prefab)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'esta caixa já está na lista: o que decide quantas nascem é a faixa de caixas da sala, e não repetir o tipo',
        });
        return;
      }

      seen.add(crate.prefab);
    }
  });

/**
 * Um marcador do desenho: onde nasce um inimigo ou uma caixa.
 *
 * ####  A COORDENADA É EM RELAÇÃO À ENTRADA, E NÃO AO CANTO  ####
 *
 * `(0,0)` é a célula do `E` — a mesma origem que o construtor usa
 * (ele translada o desenho inteiro para que o `E` caia ali) e a
 * mesma que o alçapão conhece.
 *
 * Ancorar no canto do desenho seria mais fácil de calcular e
 * erraria sozinho: o editor RECORTA as linhas vazias ao salvar, e
 * um desenho que perde duas colunas à esquerda deslocaria todo
 * marcador duas células — para dentro da parede.
 *
 * ####  E ELE VALE SÓ NO MODO PLANTA  ####
 *
 * No modo receita o traçado é sorteado no servidor, a cada
 * nascimento: não existe célula `(3,-2)` para marcar. O campo é
 * guardado de qualquer jeito (trocar de modo e voltar não pode
 * apagar o trabalho de ninguém), e o construtor o ignora fora do
 * desenho.
 */
export const dungeonPlacementSchema = z.object({
  kind: z.enum(PLACEMENT_KINDS),
  /** Células a leste da entrada; negativo é a oeste. */
  x: z.number().int().min(-64).max(64),
  /** Células ao norte da entrada; negativo é ao sul. */
  z: z.number().int().min(-64).max(64),
  /**
   * Quantos nascem neste ponto.
   *
   * O teto é 8, e passar de 4 já começa a empilhar: uma célula é um
   * quadrado de 3×3 m, e o construtor espalha as peças num anel
   * dentro dela. Oito caixas ali ficam encostadas umas nas outras.
   */
  amount: z.number().int().min(1).max(8).default(1),
  /**
   * O prefab desta posição. Vazio = o que a sala já usa.
   *
   * Para `kind: 'crate'`, vazio sorteia entre as `crates` da cor —
   * e um prefab escrito aqui que TAMBÉM está cadastrado na cor
   * herda a tabela e o OZCoin daquele cadastro. É isso que liga o
   * marcador ao loot sem duplicar campo nenhum.
   */
  prefab: z
    .union([
      z.literal(''),
      z
        .string()
        .min(8)
        .max(200)
        .regex(/^assets\/.+\.prefab$/, 'informe o caminho completo do prefab'),
    ])
    .default(''),
});

export type DungeonPlacementInput = z.infer<typeof dungeonPlacementSchema>;

export const dungeonRoomInputSchema = z.object({
  /** 'green'|'blue'|'red' no modo receita; 'A','B','C'… no modo planta. */
  key: z.string().min(1).max(16),
  color: z.enum(ROOM_COLORS).default('green'),
  npc: countRange('NPCs', 20).default({ min: 0, max: 1 }),
  loot: countRange('caixas', 20).default({ min: 1, max: 1 }),
  /** As caixas desta cor, cada uma com o conteúdo dela. Ver `crateSpecSchema`. */
  crates: crateListSchema,
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

    /**
     * O que a casinha da entrada carrega dentro.
     *
     * O padrão é `none`, e ele MUDA o comportamento de quem já
     * existia — de propósito. Ver `ENTRANCE_ITEM_MODES`.
     */
    entranceItems: z.enum(ENTRANCE_ITEM_MODES).default('none'),

    /**
     * O ângulo da casinha da entrada, em graus.
     *
     * ####  ELE GIRA A CASINHA, E SÓ ELA  ####
     *
     * A masmorra lá embaixo cresce na direção que o ponto de
     * nascimento manda, e quem desce chega de frente para o
     * corredor — isso o plugin resolve sozinho.
     *
     * A planta, essa, tem uma frente própria: a porta foi desenhada
     * apontando para algum lado, e não há como o agente adivinhar
     * qual. Pedido do dono em 09/09/2026, de dentro do jogo: "talvez
     * colocar o ângulo que aí fica certo, uma seta para girar".
     */
    entranceRotation: z.number().min(0).max(359).default(0),

    /**
     * Qual lado do DESENHO fica de frente no jogo.
     *
     * ####  NÃO CONFUNDIR COM `entranceRotation`  ####
     *
     * Aquele gira a CASINHA no terreno — a porta de frente para a
     * estrada. Este gira o DESENHO: é o que decide para onde o
     * corredor sai de quem acabou de descer.
     *
     * `null` = automático, e é o caso normal: a masmorra gira
     * sozinha para o corredor sair de frente para a casinha. A
     * escolha manual existe para o que o automático não cobre — uma
     * entrada com dois corredores saindo, ou um traçado que o admin
     * quer deitado de outro jeito.
     *
     * Só os quatro múltiplos de 90: o desenho é uma grade, e 37
     * graus não existem nela.
     */
    entranceFacing: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .nullable()
      .default(null),

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
        crates: crateListSchema,
        /** O que cai nas caixas do corredor. */
        table: lootTableSchema.prefault({}),
        /** O inimigo do corredor. Campo ausente herda de `npc.ai`. */
        ai: aiSpecSchema.prefault({}),

        /**
         * O nível das peças do CORREDOR. `null` = herda `structure`.
         *
         * ####  O CORREDOR NÃO TINHA MATERIAL PRÓPRIO  ####
         *
         * A sala tinha (`rooms[].grade`), a masmorra tinha
         * (`structure`) — e o corredor era o resto: tudo que não
         * era sala nascia com o `structure`, junto com a entrada e
         * com o que a planta colou.
         *
         * Pedido do dono em 13/09/2026: *"na seção 'O Corredor',
         * adicionar seleção independente de material para piso,
         * parede e teto"*. E ele tem consequência de jogo: o
         * corredor de madeira com as salas blindadas é a masmorra
         * em que se entra pelo caminho e não pela parede.
         *
         * `null` e não um `gradeSetSchema.prefault({})` porque
         * "herda" e "escolhi pedra" precisam ser distinguíveis: com
         * o prefault, trocar o `structure` da masmorra para metal
         * deixaria o corredor em pedra sem ninguém ter pedido.
         */
        grade: gradeSetSchema.nullable().default(null),
      })
      .prefault({}),

    // ---- modo 'blueprint' ----
    grid: dungeonGridSchema.nullable().default(null),

    /**
     * Onde nasce cada inimigo e cada caixa, marcado no desenho.
     *
     * ####  VAZIO É O SORTEIO DE SEMPRE, E ISSO É O CONTRATO  ####
     *
     * "Atualmente, NPCs e caixas nascem aleatoriamente nas salas"
     * — pedido do dono, 13/09/2026 — e o sorteio continua sendo o
     * padrão: lista vazia é uma masmorra que se comporta exatamente
     * como antes desta mudança. Nenhuma masmorra gravada muda de
     * comportamento por causa deste campo.
     *
     * ####  O MARCADOR MANDA NA SALA DELE, E NAQUELE TIPO  ####
     *
     * Decidido com o dono em 13/09/2026, entre três leituras
     * possíveis. A sala que tem marcador de CAIXA nasce só com as
     * caixas marcadas — a faixa `loot` dela deixa de ser sorteada.
     * Os inimigos da MESMA sala continuam sorteados, se ninguém
     * marcou inimigo ali.
     *
     * É o que deixa marcar só a sala do chefe e deixar o resto da
     * masmorra no sorteio. As outras duas leituras — "um marcador
     * desliga o sorteio na masmorra inteira" e "o marcador soma ao
     * sorteio" — obrigariam a marcar tudo, ou entregariam salas
     * mais cheias do que a receita promete.
     *
     * O corredor conta como uma unidade: marcador de caixa no
     * corredor desliga a `lootDensity`, e não a `npcDensity`.
     */
    placements: z.array(dungeonPlacementSchema).max(100).default([]),

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
     * Quem desce pelo alçapão.
     *
     * O padrão é o servidor inteiro, e ele é IDÊNTICO ao
     * `new AccessSpec()` do plugin — é isso que autoriza o
     * `leanAccess` do sync a não mandar nada neste caso. Mudar o
     * padrão de um lado só é o jeito de quebrar isto em silêncio:
     * o admin escolhe uma coisa, o sync não manda, e o jogo faz
     * outra.
     */
    access: z
      .object({
        whoEnters: z.enum(ACCESS_WHO_ENTERS).default('everyone'),
        /**
         * A permissão exigida no modo `permission`.
         *
         * Vazio cai na nossa, `origemzdungeon.enter`. Pode apontar
         * para a de outro plugin — uma de VIP, por exemplo —, e
         * uma que plugin nenhum registrou DEIXA ENTRAR: trancar por
         * engano é o defeito que ninguém diagnostica de dentro do
         * jogo.
         */
        enterPermission: z.string().trim().max(64).default(''),
      })
      .prefault({}),

    /**
     * O que ninguém tira do lugar.
     *
     * Martelo (bater, melhorar, girar, demolir, reparar), a
     * ferramenta de remoção e o "segurar E". Blindar contra DANO
     * nunca blindou contra isso: remover não passa por `Hurt`.
     *
     * O decay fica de fora de propósito e não obedece a este bloco
     * — ver o `OnDecayDamage` do plugin. Desligar a proteção contra
     * martelo e ver a entrada cair sozinha três horas depois seria
     * uma surpresa que ninguém liga ao botão que apertou.
     */
    protection: z
      .object({
        enabled: z.boolean().default(true),
        /** Sem isto, uma masmorra emperrada vira lixo permanente no mapa. */
        allowAdmin: z.boolean().default(true),
        warnOnAttempt: z.boolean().default(true),
      })
      .prefault({}),

    /**
     * O círculo no mapa do jogo.
     *
     * ####  SEM ELE A MASMORRA É INVISÍVEL  ####
     *
     * MEDIDO em 09/09/2026, apontado pelo dono ("verificar se está
     * marcando no mapa"): o plugin não criava marcador nenhum. Quem
     * não visse o chat não tinha como saber que ela existia, nem
     * onde — e um evento que ninguém acha é um evento que não
     * aconteceu.
     *
     * São dois prefabs empilhados no jogo, como no DungeonBases
     * 1.3.4: um `genericradiusmarker` (o círculo colorido) filho de
     * um `vending_mapmarker` (que carrega o texto do rótulo).
     */
    marker: z
      .object({
        enabled: z.boolean().default(true),
        /** O que aparece ao passar o mouse sobre o círculo. */
        label: z.string().trim().min(1).max(40).default('Masmorra'),
        /**
         * A cor do círculo, em `#rrggbb`.
         *
         * Hexadecimal e não três números de 0 a 1 como no 1.3.4: o
         * painel tem um seletor de cor, e traduzir uma vez na
         * borda é melhor que três campos que ninguém sabe preencher.
         */
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/u, 'a cor é um hexadecimal como #ff0000')
          .default('#ff0000'),
        /** 0 = invisível, 1 = sólido. O 1.3.4 usa 0.55. */
        alpha: z.number().min(0).max(1).default(0.55),
        /**
         * O raio do círculo, na escala do mapa do jogo.
         *
         * Meio ponto é o do 1.3.4 e cobre a casinha. Acima de uns
         * poucos pontos ele vira uma mancha que cobre um quarto do
         * mapa — o teto existe para isso.
         */
        radius: z.number().min(0.1).max(10).default(0.5),
      })
      .prefault({}),

    /**
     * O que o servidor inteiro ouve.
     *
     * ####  HAVIA UM ÚNICO CAMINHO DE FALA, E ELE NÃO SAÍA DA MASMORRA  ####
     *
     * MEDIDO em 09/09/2026, apontado pelo dono ("verificar se
     * alerta no chat"): o `Announce` do plugin fala com
     * `dungeon.inside` — quem JÁ está lá dentro. Não havia nada que
     * alcançasse quem está no mapa.
     *
     * Texto vazio = a frase padrão do agente. Isso é de propósito:
     * mudar a frase padrão um dia não pode exigir reescrever a
     * linha de cada masmorra.
     */
    announce: z
      .object({
        enabled: z.boolean().default(true),
        /** Vazio = "Uma masmorra apareceu em {grid}." */
        onBuild: z.string().max(200).default(''),
        /** Vazio = "A masmorra de {grid} fechou." */
        onEnd: z.string().max(200).default(''),
        /**
         * Dizer a grade (`E7`) na frase.
         *
         * Ligado é o certo para um evento que as pessoas devem
         * achar; desligado, para uma masmorra que é para ser
         * procurada. A coordenada crua nunca entra: ninguém joga
         * com `(-1330, 871)` na cabeça.
         */
        showGrid: z.boolean().default(true),
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

    /**
     * Em que servidores esta masmorra vale.
     *
     * ####  VAZIO É "EM TODOS", E ISSO É O CONTRÁRIO DO ÓBVIO  ####
     *
     * A leitura natural de uma lista vazia é "em nenhum", e ela
     * está errada aqui por dois motivos.
     *
     * O primeiro é a migração: toda masmorra já gravada nasce sem
     * vínculo nenhum, e "em nenhum" as apagaria do jogo em
     * silêncio, no primeiro boot depois do update.
     *
     * O segundo é o caso comum: quem tem UM servidor nunca vai
     * querer marcar nada, e quem tem três normalmente quer a
     * masmorra nos três. A escolha explícita é a exceção, e é ela
     * que deve custar um clique.
     *
     * É o oposto do `servers` do evento agendado, e de propósito:
     * lá, vazio é "em nenhum", porque um evento sem servidor não
     * tem quando acontecer. A masmorra é conteúdo, e conteúdo sem
     * dono é de todos.
     */
    servers: z.array(z.string().min(1).max(64)).max(64).default([]),

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

    // ####  "O CORREDOR NÃO TEM NPC" DEIXOU DE SER SÓ A DENSIDADE  ####
    //
    // Um marcador de inimigo no desenho é um NPC de corredor tão
    // bom quanto o sorteado — e, se ele existe, densidade zero não
    // é defeito nenhum: é justamente como se põe o guarda no lugar
    // escolhido, e só nele.
    //
    // Sem esta segunda pergunta, a tela recusaria salvar exatamente
    // a masmorra que o pedido de 13/09/2026 descreve.
    const markedNpcs = value.placements.filter((mark) => mark.kind === 'npc').length;

    if (
      anyLocked &&
      value.lock.enabled &&
      value.lock.carrier === 'npc' &&
      value.lock.carrierScope === 'corridor' &&
      value.corridor.npcDensity === 0 &&
      markedNpcs === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['corridor', 'npcDensity'],
        message:
          'o código sai de um NPC de corredor e o corredor não tem nenhum: suba a densidade, marque um inimigo no desenho ou use "em qualquer lugar"',
      });
    }

    // ####  MARCADOR NO VAZIO É PEÇA QUE NÃO NASCE  ####
    //
    // O construtor põe a peça no CHÃO da célula, e célula que não
    // está no desenho não tem chão: a caixa cairia noventa metros,
    // ou simplesmente não nasceria — em silêncio, que é o modo de
    // falha que esta tela existe para evitar.
    //
    // Acontece sozinho: marcar a sala, voltar ao desenho e apagar
    // aquelas células. O editor limpa os marcadores órfãos quando o
    // admin apaga a célula; esta régua é para o que chega por API,
    // por captura ou por um acervo que mudou embaixo.
    if (value.mode === 'blueprint' && value.grid !== null && value.placements.length > 0) {
      const cells = cellsOfGrid(value.grid);
      const stray = value.placements.filter((mark) => !cells.has(`${String(mark.x)},${String(mark.z)}`));

      if (stray.length > 0) {
        const first = stray[0];

        ctx.addIssue({
          code: 'custom',
          path: ['placements'],
          message:
            stray.length === 1
              ? `há um marcador numa célula que não existe no desenho (${String(first?.x)}, ${String(first?.z)}): sem chão ali, a peça não nasce`
              : `há ${String(stray.length)} marcadores em células que não existem no desenho: sem chão ali, as peças não nascem`,
        });
      }

      // A (0,0) e a (0,1) são a chegada do alçapão, e o construtor
      // as deixa livres de propósito: uma caixa ali é onde o
      // jogador materializa, e um inimigo ali atira nele antes de a
      // tela terminar de carregar.
      const atArrival = value.placements.filter(
        (mark) => mark.x === 0 && (mark.z === 0 || mark.z === 1),
      ).length;

      if (atArrival > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['placements'],
          message:
            'há marcador na chegada do alçapão: é onde o jogador materializa, e o construtor mantém as duas células livres',
        });
      }
    }
  });

/**
 * As células que o desenho tem, em coordenadas de ENTRADA.
 *
 * A mesma translação do construtor e do editor: o `E` vira (0,0), a
 * primeira linha é a de maior z. Escrever isso aqui de um jeito
 * diferente faria a régua recusar marcador que o jogo aceita.
 */
function cellsOfGrid(grid: readonly string[]): Set<string> {
  const cells = new Set<string>();
  let originX = 0;
  let originZ = 0;
  let found = false;

  grid.forEach((row, index) => {
    const at = row.indexOf('E');

    // O PRIMEIRO `E`, e não o último: é o que o construtor usa, e um
    // desenho com duas entradas (que o verificador já reclama por
    // outro caminho) não pode ancorar os marcadores num lugar e a
    // masmorra em outro.
    if (at >= 0 && !found) {
      originX = at;
      originZ = grid.length - 1 - index;
      found = true;
    }
  });

  grid.forEach((row, index) => {
    const z = grid.length - 1 - index;

    [...row].forEach((char, x) => {
      if (char === '.' || char === ' ') return;

      cells.add(`${String(x - originX)},${String(z - originZ)}`);
    });
  });

  return cells;
}

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
  /** Em que servidores ela vale. Vazio = em todos. */
  readonly servers: readonly string[];
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
