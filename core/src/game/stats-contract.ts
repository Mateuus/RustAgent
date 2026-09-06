// ============================================================
//  stats-contract.ts  -  o contrato do LOTE, do lado do agente.
//
//  Este arquivo descreve o formato EXATO que o `OrigemZAgent.cs`
//  produz em `origemz.stats.flush` e `origemz.stats.ack`. As duas
//  pontas são compiladas separadamente — não existe tipo
//  compartilhado em tempo de compilação, só este documento e os
//  schemas abaixo.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO. Se as
//  pontas divergirem, o agente RECUSA a resposta
//  (`PLUGIN_INVALID_RESPONSE`) — e NUNCA a trata como lista vazia:
//  "ninguém minerou" e "não consegui perguntar" são respostas
//  diferentes, e a segunda não pode se disfarçar da primeira.
//
//  Documento: `Docs/Ranking/20-PLANO-E-CONTRATOS.md` §6.
//
//  ------------------------------------------------------------
//  ####  OS LIMITES ESTÃO DUPLICADOS DE PROPÓSITO  ####
//
//  `DefaultStatsLimit`, `MaxStatsLimit` e o teto de bytes existem
//  nos DOIS lados. Não é descuido: o plugin não pode depender de
//  quem o chama — o mesmo comando pode ser digitado à mão no
//  console do servidor —, e o agente precisa saber com que número
//  começar a paginação antes de a primeira resposta chegar. É a
//  mesma escolha do `plugin-contract.ts` e do `blueprints.ts`.
//
//  ------------------------------------------------------------
//  ####  O LOTE CONGELA, E O `ack` É O ÚNICO QUE DESCARTA  ####
//
//      flush offset=0   → o plugin FECHA o buffer atual como
//                         "lote pendente" e abre um novo
//      flush offset=100 → lê o MESMO lote pendente
//      ack <batchId>    → descarta. SÓ AQUI.
//      flush offset=0 com pendente não confirmado
//                       → devolve o MESMO lote, mesmo batchId
//
//  É isso que faz uma queda de RCON no meio do ciclo não custar
//  nada. E é por isso que o `ack` sai DEPOIS do COMMIT: confirmar
//  antes trocaria uma duplicata inofensiva — que o `batchId`
//  recusa em `stat_batches` — por uma perda silenciosa.
// ============================================================

import { z } from 'zod';

/** Os comandos de console da coleta. */
export const STATS_COMMANDS = {
  /** `origemz.stats.flush [offset] [limit] [secret]` */
  flush: 'origemz.stats.flush',
  /** `origemz.stats.ack <batchId>` */
  ack: 'origemz.stats.ack',
  /**
   * `origemz.stats.diag` — o custo medido dos hooks, e o estado do
   * buffer.
   *
   * Ele não muda nada e o ciclo do coletor NÃO o chama: existe para
   * quem administra o servidor perguntar, com número na mão, se a
   * coleta cabe no orçamento daquele servidor.
   */
  diag: 'origemz.stats.diag',
} as const;

/**
 * A versão do contrato.
 *
 * O plugin a carimba em toda resposta de sucesso, e o agente
 * recusa o que não reconhece. Sem ela, um plugin velho num
 * servidor esquecido responderia num formato antigo e o agente
 * somaria o que entendesse — o pior desfecho, porque parece
 * funcionar.
 */
export const STATS_CONTRACT = 1;

/** Padrão e teto do `limit`, iguais aos do plugin. */
export const STATS_FLUSH_DEFAULT_LIMIT = 100;
export const STATS_FLUSH_MAX_LIMIT = 250;

/**
 * O teto de bytes que o PLUGIN aplica antes de responder.
 *
 * Ele não viaja na resposta: está aqui para o log do agente poder
 * dizer contra o que a página foi medida quando ela é recusada.
 */
export const STATS_FLUSH_MAX_BYTES = 60_000;

/**
 * A página não coube no frame do RCON.
 *
 * O plugin recusa a página INTEIRA em vez de cortá-la — resposta
 * truncada chega aqui como JSON inválido, e meio lote *parece* ter
 * funcionado. Quem recebe este código reduz o `limit` pela metade
 * e pede de novo, **sem avançar o `offset`**.
 */
export const STATS_PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

/**
 * O lote pedido não existe (mais).
 *
 * Duas situações, e nenhuma delas é defeito: um `oxide.reload`
 * entre duas páginas, ou um `ack` repetido de um lote que já saiu.
 * Quem recebe isto num `ack` trata como "já foi"; quem recebe no
 * meio de uma paginação abandona a rodada e recomeça do zero na
 * volta seguinte.
 */
export const STATS_NO_BATCH = 'NO_BATCH';

/**
 * O formato de uma métrica: `familia.nome`, minúsculas.
 *
 * É o MESMO da ação `points` do item custom
 * (`http/routes/custom-items.ts`) e o mesmo que a migração 033
 * documenta. Uma métrica fora do formato derruba a resposta
 * inteira, e é o que se quer: o plugin é nosso, e um nome torto
 * vindo dele é bug de contrato, não dado do jogo.
 */
const metricNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)*$/);

/** SteamID64 sempre como texto: 17 dígitos não cabem num `number`. */
const steamIdSchema = z.string().regex(/^\d{17}$/);

const statsPlayerSchema = z.object({
  steamId: steamIdSchema,
  /** Só para o log e para a tela; NUNCA é chave. */
  name: z.string().nullish(),
  /**
   * Sempre DELTAS, nunca totais — o agente SOMA o que chega aqui.
   * Um lote com totais reescreveria a temporada a cada minuto.
   */
  metrics: z.record(metricNameSchema, z.number().int()),
});

/**
 * `ok` ou `suspect` — e `void` NÃO chega por aqui.
 *
 * ####  QUEM DECIDE O SUSPEITO É O PLUGIN, E NÃO O AGENTE  ####
 *
 * O sinal de um tiro forjado é o `ratio` entre a distância reta e o
 * caminho do projétil (§7.2), e as duas medidas só existem dentro
 * do `HitInfo` — o agente recebe o resultado, nunca a matéria-prima.
 *
 * `void` é a terceira coluna de `player_records` e é decisão de
 * ADMIN, tomada no painel depois de alguém contestar. Um plugin que
 * pudesse anular um recorde sozinho tiraria essa decisão de quem
 * deve tomá-la.
 */
const recordStatusSchema = z.enum(['ok', 'suspect']);

const statsRecordSchema = z.object({
  steamId: steamIdSchema,
  name: z.string().nullish(),
  metric: metricNameSchema,
  /** `number`, e não inteiro: distância é medida, e 412.73 é a informação. */
  value: z.number(),
  /** Epoch em SEGUNDOS, relógio do servidor de jogo. */
  at: z.number().int().nonnegative(),
  /**
   * Ausente = `ok`.
   *
   * O padrão existe para um plugin mais velho que ainda não sabe
   * marcar suspeita continuar dentro do contrato — e o que ele
   * manda é, de fato, o que ele conseguiu apurar.
   */
  status: recordStatusSchema.default('ok'),
  /** O testemunho: arma, vítima, grid. Livre de propósito. */
  detail: z.unknown().optional(),
});

const statsEventSchema = z.object({
  /** Gerado pelo PLUGIN. É a chave da idempotência entre os dois canais. */
  eventId: z.string().min(1).max(120),
  steamId: steamIdSchema,
  name: z.string().nullish(),
  metric: metricNameSchema,
  /** Já multiplicado pelos pontos por unidade. */
  amount: z.number().int(),
  source: z.string().max(120).nullish(),
  /** Epoch em SEGUNDOS, relógio do servidor de jogo. */
  at: z.number().int().nonnegative(),
});

const statsFlushOkSchema = z.object({
  ok: z.literal(true),
  contract: z.literal(STATS_CONTRACT),
  batchId: z.string().min(1).max(120),
  /** Cresce a cada lote. Serve ao log ("recebi o 41 e o 43"), e a nada mais. */
  seq: z.number().int().nonnegative(),
  /**
   * O TOTAL de linhas do lote — o tamanho da MAIOR das três
   * listas —, e não o tamanho da página. É por ele que o laço sabe
   * quando parar: `offset >= count`.
   */
  count: z.number().int().nonnegative(),
  /** Voltam NORMALIZADOS: quem pede 5000 recebe 250 e VÊ isso aqui. */
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  players: z.array(statsPlayerSchema),
  /**
   * As duas listas nascem com `[]` como padrão de propósito: um
   * plugin que ainda não emite recorde nem evento continua
   * respondendo dentro do contrato, e a fatia seguinte desta
   * frente entra sem mexer no agente.
   */
  records: z.array(statsRecordSchema).default([]),
  events: z.array(statsEventSchema).default([]),
});

const statsAckOkSchema = z.object({
  ok: z.literal(true),
  contract: z.literal(STATS_CONTRACT),
  batchId: z.string().min(1).max(120),
  seq: z.number().int().nonnegative(),
  players: z.number().int().nonnegative(),
});

/**
 * A recusa do plugin.
 *
 * Sem `contract`: um erro precisa atravessar mesmo quando é a
 * versão do contrato que está errada.
 */
const statsErrorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

/**
 * ####  POR QUE `discriminatedUnion`, E NÃO `union`  ####
 *
 * Com `union`, uma resposta de sucesso com um campo torto tentaria
 * casar com o schema de ERRO, falharia lá também, e o relatório
 * apontaria para `error: Required` — que não tem nada a ver com o
 * defeito. O discriminante escolhe o ramo pelo `ok` e o erro sai
 * onde ele está.
 */
export const statsFlushResponseSchema = z.discriminatedUnion('ok', [
  statsFlushOkSchema,
  statsErrorSchema,
]);

export const statsAckResponseSchema = z.discriminatedUnion('ok', [
  statsAckOkSchema,
  statsErrorSchema,
]);

/** Uma página do lote, já conferida contra o contrato. */
export type StatsFlushPage = z.infer<typeof statsFlushOkSchema>;
export type StatsFlushPlayer = z.infer<typeof statsPlayerSchema>;
export type StatsFlushRecord = z.infer<typeof statsRecordSchema>;
export type StatsFlushEvent = z.infer<typeof statsEventSchema>;
export type StatsAckReply = z.infer<typeof statsAckOkSchema>;

/**
 * `origemz.stats.flush <offset> <limit> [segredo]`.
 *
 * Os dois primeiros argumentos vão SEMPRE, mesmo quando são os
 * padrões: o `offset = 0` é o que manda o plugin congelar o buffer,
 * e deixá-lo implícito faria a leitura do log depender de saber o
 * padrão.
 *
 * ####  O TERCEIRO É O SEGREDO DO CANAL `#OZSTAT#`  ####
 *
 * O plugin emite o recorde no console assim que ele acontece — o
 * "agora" do §7.1 —, e o agente só aceita a linha que carrega o
 * segredo desta subida (`rankings/stat-events.ts`, `#authentic`).
 * Sem um canal que o entregue, o plugin nunca emitiria e o recorde
 * só apareceria no lote seguinte, até um minuto depois.
 *
 * Ele viaja AQUI, e não num comando próprio, porque este é o único
 * comando desta seção que o agente manda sozinho, e ele já sai a
 * cada rodada: um comando novo dobraria o tráfego de RCON por
 * rodada para carregar poucas dezenas de bytes. Reafirmá-lo toda
 * rodada é também o que conserta sozinho o `oxide.reload` — o
 * plugin guarda o segredo só em memória, de propósito.
 *
 * Ausente, o comando sai com dois argumentos e o plugin NÃO apaga o
 * que já tem: é o mesmo comando que um admin digita à mão no
 * console, e uma digitação não pode desligar o push.
 */
export function buildStatsFlushCommand(offset: number, limit: number, secret?: string): string {
  const base = `${STATS_COMMANDS.flush} ${String(offset)} ${String(limit)}`;

  // O segredo é um UUID: sem espaço, sem aspas. O parser de console
  // do Rust COME as aspas de um token citado (medido em
  // `game/plugin-push.ts`), então ele vai cru — como o `batchId` do
  // `ack`.
  return secret === undefined || secret === '' ? base : `${base} ${secret}`;
}

/**
 * `origemz.stats.ack <batchId>`.
 *
 * O `batchId` não é citado entre aspas: o parser de console do Rust
 * **come as aspas** de um token citado (medido — ver
 * `game/plugin-push.ts`), e o plugin já o gera sem espaço nem
 * caractere especial justamente para caber aqui cru.
 */
export function buildStatsAckCommand(batchId: string): string {
  return `${STATS_COMMANDS.ack} ${batchId}`;
}
