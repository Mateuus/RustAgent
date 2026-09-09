// ============================================================
//  ####  CONTRATO COMPARTILHADO COM O OrigemZDungeon.cs  ####
//
//  Este arquivo descreve, do lado do agente, o formato EXATO que o
//  plugin produz e consome. As duas pontas são compiladas
//  separadamente — não existe tipo compartilhado em tempo de
//  compilação, só este documento e os schemas abaixo.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO.
//
//  ------------------------------------------------------------
//  ####  DOIS CANAIS, PORQUE SÃO DUAS PERGUNTAS  ####
//
//  RESPOSTA CASADA — `ozdungeon status`, `ozdungeon lista`. O
//  `Reply` do Covalence volta na resposta do próprio comando de
//  RCON. MEDIDO em 08/09/2026, e com uma consequência que confunde
//  quem depura: essa linha NÃO aparece no buffer de console, porque
//  foi consumida como resposta.
//
//  STREAM COM MARCADOR — `#OZDUNGEON#{…}`. É para o que acontece
//  DEPOIS que o comando já respondeu: a construção leva segundos, o
//  jogador entra dez minutos mais tarde, o evento termina sozinho.
//  Um agente que esperasse isso na resposta casada tomaria
//  `RCON_TIMEOUT` em 5 s enquanto a masmorra subia bem.
//
//  ------------------------------------------------------------
//  ####  O SEGREDO NÃO É PARANOIA  ####
//
//  O `onConsoleLine` recebe o CHAT dos jogadores junto com o resto
//  do console. Sem defesa, alguém digitando
//
//      #OZDUNGEON#{"kind":"built","slug":"x"}
//
//  no chat inventaria um nascimento no histórico — e, pior, faria o
//  assistente do painel declarar sucesso sobre uma masmorra que não
//  existe. O segredo é sorteado a cada subida do agente, viaja no
//  `sync`, e volta em toda linha. Quem não o tem não passa, e a
//  recusa é SILENCIOSA: alguém testando o marcador não pode encher
//  o log de alarme.
//
//  É o mesmo desenho do `#OZQUEST#` e do `#OZSTAT#`.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §7.
// ============================================================

import { z } from 'zod';

import { FAILURE_REASONS } from '../types/world-events.js';

/** Os comandos do agente para o plugin. */
export const DUNGEON_COMMANDS = {
  /** `origemz.dungeon.sync <base64>` — o estado completo. */
  sync: 'origemz.dungeon.sync',
  /** `ozdungeon build <slug> <x> <z> [graus]`. */
  build: 'ozdungeon build',
  /** `ozdungeon stop`. */
  stop: 'ozdungeon stop',
  /** `ozdungeon status`. */
  status: 'ozdungeon status',
} as const;

/** O prefixo das linhas espontâneas. */
export const DUNGEON_EVENT_MARKER = '#OZDUNGEON#';

// ------------------------------------------------------------
//  O QUE O PLUGIN GRITA
// ------------------------------------------------------------

/**
 * A construção terminou.
 *
 * `ms` e `entities` existem para o painel poder dizer "618 peças em
 * 1.275 ms" em vez de "pronto" — é a diferença entre o admin
 * confiar e o admin ir conferir no jogo.
 */
const builtSchema = z.object({
  kind: z.literal('built'),
  secret: z.string().min(1),
  slug: z.string().min(1),
  x: z.number(),
  z: z.number(),
  grid: z.string().min(1).max(8),
  entities: z.number().int().min(0),
  ms: z.number().int().min(0),
  /** A semente do sorteio. É o que faz a reconstrução sair igual. */
  seed: z.number().int().optional(),
});

/** Não deu. O motivo tem o MESMO nome dos dois lados do fio. */
const failedSchema = z.object({
  kind: z.literal('failed'),
  secret: z.string().min(1),
  slug: z.string().min(1),
  reason: z.enum(FAILURE_REASONS),
});

/** Alguém desceu pelo alçapão. */
const enteredSchema = z.object({
  kind: z.literal('entered'),
  secret: z.string().min(1),
  steamId: z.string().min(1).max(32),
});

/** Alguém subiu, ou morreu lá dentro. */
const leftSchema = z.object({
  kind: z.literal('left'),
  secret: z.string().min(1),
  steamId: z.string().min(1).max(32),
  died: z.boolean().default(false),
});

/** A masmorra saiu do ar. */
const endedSchema = z.object({
  kind: z.literal('ended'),
  secret: z.string().min(1),
  reason: z.string().max(40).default('timeout'),
  entered: z.number().int().min(0).default(0),
});

/**
 * O plugin subiu (ou um `oxide.reload` esvaziou o cache dele).
 *
 * ####  ELE PEDE O ESTADO, E NÃO O CONTRÁRIO  ####
 *
 * O agente não sabe quando o plugin recarregou: o RCON continua de
 * pé, nada cai. Sem este grito, o plugin ficaria sem as masmorras
 * até o próximo `sync` por relógio — e o admin veria "não conheço
 * essa planta" logo depois de um reload.
 */
const readySchema = z.object({
  kind: z.literal('ready'),
  /** Sem segredo: é justamente ele que o plugin ainda não tem. */
  version: z.string().max(20).optional(),
});

const dungeonPushSchema = z.discriminatedUnion('kind', [
  builtSchema,
  failedSchema,
  enteredSchema,
  leftSchema,
  endedSchema,
]);

export type DungeonPushEvent = z.infer<typeof dungeonPushSchema>;
export type DungeonReadyEvent = z.infer<typeof readySchema>;

/**
 * Lê uma linha do console.
 *
 * Devolve `null` para tudo que não for nosso — e "tudo" é a maioria
 * absoluta: este método roda em TODA linha de um servidor cheio,
 * centenas por minuto. A primeira comparação de string é o que o
 * torna barato.
 */
export function parseDungeonPush(line: string, secret: string): DungeonPushEvent | null {
  const raw = markerBody(line);

  if (raw === null) return null;

  try {
    const parsed = dungeonPushSchema.safeParse(JSON.parse(raw));

    // Segredo errado é recusa SILENCIOSA: alguém testando o
    // marcador no chat não pode encher o log.
    if (!parsed.success || parsed.data.secret !== secret) return null;

    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * O `ready`, que não carrega segredo.
 *
 * Ele é o único que qualquer um pode forjar pelo chat, e o dano é
 * exatamente nenhum: o agente responde reenviando o estado que já
 * era para estar lá. Exigir segredo aqui seria exigir que o plugin
 * soubesse o que ele está pedindo.
 */
export function parseDungeonReady(line: string): DungeonReadyEvent | null {
  const raw = markerBody(line);

  if (raw === null) return null;

  try {
    const parsed = readySchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function markerBody(line: string): string | null {
  const at = line.indexOf(DUNGEON_EVENT_MARKER);

  if (at < 0) return null;

  return line.slice(at + DUNGEON_EVENT_MARKER.length).trim();
}

// ------------------------------------------------------------
//  O QUE O AGENTE EMPURRA
// ------------------------------------------------------------

/**
 * A tabela de loot, do jeito que o plugin a lê.
 *
 * Ausente = `mode: "server"`, ou seja, o Rust enche a caixa e o
 * BetterLoot continua valendo. É o que o `ModeOf` do plugin faz com
 * `null`.
 */
export interface LootTablePayload {
  readonly mode: 'server' | 'add' | 'replace';
  readonly rolls: { readonly min: number; readonly max: number };
  readonly entries: readonly {
    readonly shortname: string;
    readonly amount: { readonly min: number; readonly max: number };
    readonly weight?: number;
    readonly guaranteed?: boolean;
    readonly skin?: number;
    readonly blueprint?: boolean;
    readonly condition?: number;
  }[];
}

/**
 * O comportamento do inimigo.
 *
 * ####  CAMPO AUSENTE NÃO É ZERO  ####
 *
 * Todo campo é opcional porque a herança é campo a campo: `npc.ai` é
 * o padrão da masmorra, e `rooms[].ai` / `corridor.ai` sobrescrevem
 * só o que dizem. O `AiSpec` do plugin é todo `float?`/`bool?` pela
 * mesma razão.
 */
export interface AiPayload {
  readonly visionRadius?: number;
  readonly requireLineOfSight?: boolean;
  readonly loseTargetAfter?: number;
  readonly reactionDelay?: number;
  readonly maxTargetHeightDelta?: number;
  readonly alertOnSpot?: boolean;

  readonly holdPosition?: boolean;
  readonly moveSpeed?: number;
  readonly chaseRadius?: number;
  readonly returnHome?: boolean;
  readonly returnSpeed?: number;
  readonly arriveRadius?: number;
  readonly stuckTimeout?: number;

  readonly fireRange?: number;
  readonly fireInterval?: number;
  readonly standoffDistance?: number;
  readonly aimConeScale?: number;

  readonly senseInterval?: number;
  readonly moveInterval?: number;
}

/** O nível de construção, por tipo de peça. */
export interface GradePayload {
  readonly foundation: string;
  readonly wall: string;
  readonly ceiling: string;
}

/**
 * Uma masmorra, do jeito que o plugin precisa dela.
 *
 * ####  O QUE É OPCIONAL AQUI É O QUE O PLUGIN JÁ SABE  ####
 *
 * Um campo ausente cai no inicializador da classe de spec do C#, e
 * cada omissão abaixo foi conferida contra ele: `structure` ausente
 * é `Stone`, `lock` ausente é o `new LockSpec()`, `table` ausente é
 * `server`, `grade` ausente herda o `structure`,
 * `wideDoorCellsPerDoor` ausente é 4.
 *
 * Isso não é economia de digitação: é o orçamento de 50 KB do
 * comando de RCON. Ver `DUNGEON_SYNC_MAX_BYTES` e `sync.ts`.
 */
export interface DungeonPayload {
  readonly id: string;
  readonly mode: 'recipe' | 'blueprint';
  readonly entrance: string | null;
  readonly size: { readonly min: number; readonly max: number };
  readonly weights: { readonly green: number; readonly blue: number; readonly red: number };
  readonly corridor: {
    readonly npcDensity: number;
    readonly lootDensity: number;
    readonly crates: readonly string[];
    readonly table?: LootTablePayload;
    readonly ai?: AiPayload;
  };
  readonly grid: readonly string[] | null;
  readonly npc: {
    readonly health: { readonly min: number; readonly max: number };
    readonly damageScale: number;
    readonly weapons: readonly string[];
    readonly names: readonly string[];
    readonly loot?: LootTablePayload;
    readonly ai?: AiPayload;
  };
  readonly timeOfDay: number;
  /** Ausente = pedra em tudo, que é o `DefaultGrade` do plugin. */
  readonly structure?: GradePayload;
  /** Ausente = o `new LockSpec()` do plugin, que é o mesmo padrão daqui. */
  readonly lock?: {
    readonly enabled: boolean;
    readonly sharedCode: boolean;
    readonly carrier: string;
    readonly carrierScope: string;
    readonly onUndelivered: string;
    readonly noteTitle: string;
    readonly announceOpen: boolean;
    readonly warnOnWrongCode: boolean;
  };
  /**
   * O ciclo do loot, e ele viaja SEMPRE.
   *
   * Ausente e `enabled: false` não são a mesma coisa no plugin:
   * ausente deixa o refresh do prefab de pé (a caixa de radtown se
   * repõe sozinha), e `false` o zera. O contrato promete que
   * desligado é desligado, então este campo não é omitido nunca.
   */
  readonly respawn: {
    readonly enabled: boolean;
    readonly minutes?: number;
    readonly onlyWhenEmpty?: boolean;
    readonly rebuildDestroyed?: boolean;
  };
  readonly rooms: readonly {
    readonly key: string;
    readonly color: string;
    readonly npc: { readonly min: number; readonly max: number };
    readonly loot: { readonly min: number; readonly max: number };
    readonly crates: readonly string[];
    readonly door: string;
    readonly locked: boolean;
    /** Ausente = a sala grande usa a mesma porta das outras. */
    readonly wideDoor?: string;
    /** Ausente = 4, o `DefaultWideDoorCellsPerDoor` do plugin. */
    readonly wideDoorCellsPerDoor?: number;
    /** Ausente = herda o `structure`. */
    readonly grade?: GradePayload;
    readonly table?: LootTablePayload;
    readonly ai?: AiPayload;
  }[];
}

/**
 * O payload do `sync`.
 *
 * ####  ESTADO COMPLETO, NUNCA UM DELTA  ####
 *
 * O plugin monta um dicionário NOVO e troca o campo inteiro na
 * última linha. Quem sumiu do JSON perde efeito no instante em que
 * o comando é aplicado — e é isso que faz "apaguei no painel"
 * chegar ao jogo.
 *
 * A consequência de desenho: nunca corte o payload. Meio estado é
 * pior que estado nenhum, porque o plugin substitui um cache bom
 * por um incompleto que ele acredita ser completo.
 */
export interface DungeonSyncPayload {
  readonly secret: string;
  readonly dungeons: readonly DungeonPayload[];
  readonly zones: readonly {
    readonly x: number;
    readonly z: number;
    readonly radius: number;
  }[];
}

/**
 * Monta o comando, com o payload em base64.
 *
 * ####  BASE64 NÃO É CAPRICHO  ####
 *
 * MEDIDO no servidor e documentado no `plugin-push.ts`: o parser de
 * console do Rust trata token entre aspas como argumento citado e
 * COME AS ASPAS. Mandando o JSON cru, o plugin recebe `recipe` sem
 * aspas e o parse quebra com "Unexpected character encountered
 * while parsing value: r".
 *
 * Base64 não tem aspa, espaço nem chave: atravessa qualquer parser
 * de console sem perder byte. O custo é 33% a mais de tamanho, que
 * importa pouco perto de a alternativa não funcionar.
 */
export function buildDungeonSyncCommand(payload: DungeonSyncPayload): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, 'utf8').toString('base64');

  return `${DUNGEON_COMMANDS.sync} ${encoded}`;
}

/**
 * O teto do comando, em bytes.
 *
 * O WebRCON não negocia tamanho de frame. O que foi MEDIDO
 * atravessando íntegro neste projeto é ~70 KB; 50 KB deixa folga
 * para o resto da linha. Passar disso é RECUSAR o envio inteiro e
 * deixar o cache anterior de pé — velho, mas íntegro.
 *
 * ####  E QUANTAS MASMORRAS CABEM  ####
 *
 * MEDIDO em 09/09/2026 com as receitas de fábrica, depois das três
 * frentes (portas, loot, IA), pelo comando que o `push` monta:
 *
 *     sem tabela de loot ................ 1,7 KB  →  ~29 cabem
 *     4 tabelas de 4 itens .............. 4,1 KB  →  ~12 cabem
 *     4 tabelas de 8 itens .............. 6,0 KB  →  ~8 cabem
 *
 * A conta muda TANTO porque o que pesa é a tabela: uma linha de
 * loot enxuta são ~60 bytes, e uma masmorra com quatro tabelas de
 * oito linhas tem 32 delas. Por isso o `sync.ts` ENXUGA — tudo que
 * está no valor padrão do plugin não viaja. Quem não usa tabela
 * nenhuma continua perto dos 30, e só quem usa paga.
 *
 * Isso é muito para um servidor e pouco para uma rede grande, e o
 * dia em que apertar tem conserta óbvio: mandar a cada servidor só
 * as masmorras dos eventos LIGADOS nele, em vez do catálogo
 * inteiro. Enquanto não apertar, o catálogo inteiro é mais simples
 * e mais fácil de conferir.
 *
 * O que NÃO cabe aqui em hipótese alguma é a planta: a maior tem
 * 512 KB e viaja pelo disco (ver `materializer.ts`).
 */
export const DUNGEON_SYNC_MAX_BYTES = 50_000;
