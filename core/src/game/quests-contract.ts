// ============================================================
//  quests-contract.ts  -  o contrato do LOTE de missões, do lado
//  do agente.
//
//  Este arquivo descreve o formato EXATO que o `OrigemZAgent.cs`
//  produz em `origemz.quest.flush` / `ack` e o que ele grita no
//  console como `#OZQUEST#`. As duas pontas são compiladas
//  separadamente — não existe tipo compartilhado em tempo de
//  compilação, só este documento e os schemas abaixo.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO. Se as
//  pontas divergirem, o agente RECUSA a resposta — e NUNCA a trata
//  como lista vazia: "ninguém progrediu" e "não consegui perguntar"
//  são respostas diferentes, e a segunda não pode se disfarçar da
//  primeira.
//
//  ------------------------------------------------------------
//  ####  POR QUE UM CANAL PRÓPRIO, E NÃO UMA CHAVE NO STATS  ####
//
//  O `origemz.stats.flush` do ranking já existe e já funciona em
//  produção. Pendurar as missões nele faria uma mudança de missão
//  poder quebrar o ranking — e o ranking é o que está no ar.
//
//  O custo de um comando a mais é um `send` por minuto. O desenho é
//  copiado do `stats-contract.ts` de propósito: o mesmo problema, a
//  mesma solução, e um lote congelado que já sobreviveu a quedas de
//  RCON em produção.
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
//  antes trocaria uma duplicata inofensiva — que o `batchId` recusa
//  em `quest_batches` — por uma perda silenciosa.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §8.
// ============================================================

import { z } from 'zod';

/** Os comandos de console das missões. */
export const QUEST_COMMANDS = {
  /** `origemz.quest.watch <base64>` — o catálogo do que observar. */
  watch: 'origemz.quest.watch',
  /** `origemz.quest.assign <steamId> <base64>` — o que ELE persegue. */
  assign: 'origemz.quest.assign',
  /** `origemz.quest.forget <steamId>` — ele desconectou. */
  forget: 'origemz.quest.forget',
  /** `origemz.quest.consume <steamId> <base64>` — tira os itens. */
  consume: 'origemz.quest.consume',
  /** `origemz.quest.flush [offset] [limit] [secret]` */
  flush: 'origemz.quest.flush',
  /** `origemz.quest.ack <batchId>` */
  ack: 'origemz.quest.ack',
  /**
   * `origemz.quest.diag` — o custo medido dos hooks.
   *
   * Ele não muda nada e o ciclo NÃO o chama: existe para quem
   * administra o servidor perguntar, com número na mão, se o hook
   * de loot cabe no orçamento daquele servidor. Ver §5.4 do plano.
   */
  diag: 'origemz.quest.diag',
} as const;

/**
 * A versão do contrato.
 *
 * O plugin a carimba em toda resposta de sucesso, e o agente recusa
 * o que não reconhece. Sem ela, um plugin velho num servidor
 * esquecido responderia num formato antigo e o agente somaria o que
 * entendesse — o pior desfecho, porque parece funcionar.
 */
export const QUESTS_CONTRACT = 1;

/** Padrão e teto do `limit`, iguais aos do plugin. */
export const QUEST_FLUSH_DEFAULT_LIMIT = 100;
export const QUEST_FLUSH_MAX_LIMIT = 250;

/**
 * O teto de bytes que o PLUGIN aplica antes de responder.
 *
 * Não viaja na resposta: está aqui para o log do agente poder dizer
 * contra o que a página foi medida quando ela é recusada.
 */
export const QUEST_FLUSH_MAX_BYTES = 60_000;

/**
 * A página não coube no frame do RCON.
 *
 * O plugin recusa a página INTEIRA em vez de cortá-la — resposta
 * truncada chega aqui como JSON inválido, e meio lote *parece* ter
 * funcionado. Quem recebe este código reduz o `limit` pela metade e
 * pede de novo, **sem avançar o `offset`**.
 */
export const QUEST_PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

/**
 * O lote pedido não existe (mais).
 *
 * Duas situações, e nenhuma é defeito: um `oxide.reload` entre duas
 * páginas, ou um `ack` repetido de um lote que já saiu.
 */
export const QUEST_NO_BATCH = 'NO_BATCH';

/** O marcador do push. Ver §8.5 do plano. */
export const QUEST_EVENT_MARKER = '#OZQUEST#';

// ------------------------------------------------------------
//  §1  O QUE DESCE
// ------------------------------------------------------------

/**
 * O catálogo do `watch`.
 *
 * ####  ELE SUBSTITUI O ANTERIOR, INTEIRO  ####
 *
 * Como o `origemz.item.clear` faz com as marcas: um alvo que sumiu
 * do catálogo para de ser contado. Sem isso, o plugin guardaria
 * para sempre o que já não existe.
 *
 * ####  UMA LISTA VAZIA DE `loot` DESLIGA O HOOK  ####
 *
 * `OnItemAddedToContainer` dispara para todo item que entra em
 * qualquer container do servidor. O plugin registra o hook em
 * runtime SÓ quando há alvo — um servidor sem quest de loot paga
 * zero. É a contenção nº 1 do §5.4.
 */
export interface QuestWatchPayload {
  readonly contract: number;
  /** Autentica o `#OZQUEST#` de volta. Ver §8.5. */
  readonly secret: string;
  readonly watch: Readonly<Record<string, readonly string[]>>;
  /**
   * A normalização das criaturas.
   *
   * `scientistnpc_heavy` → `scientist`, `wolf2` → `wolf`. Ela mora
   * AQUI, e não no C#, porque uma criatura nova do Rust não pode
   * exigir um release de plugin.
   */
  readonly alias: Readonly<Record<string, string>>;
}

/**
 * O que um jogador persegue, como o `assign` o manda.
 *
 * `pq` é o `player_quests.id` — o plugin nunca precisa saber o slug
 * da quest.
 */
export interface QuestAssignPayload {
  readonly contract: number;
  readonly quests: readonly {
    readonly pq: number;
    readonly objectives: readonly {
      readonly seq: number;
      readonly kind: string;
      readonly target: string;
      readonly need: number;
      readonly have: number;
    }[];
  }[];
}

// ------------------------------------------------------------
//  §2  O QUE SOBE
// ------------------------------------------------------------

/**
 * Uma linha do lote: quanto aquele objetivo andou.
 *
 * Sempre DELTA, nunca total — o agente SOMA o que chega aqui. Um
 * lote com totais reescreveria o progresso a cada minuto, e um lote
 * reenviado apagaria o que veio depois dele.
 */
const questEntrySchema = z.object({
  pq: z.number().int().positive(),
  seq: z.number().int().min(0).max(31),
  delta: z.number().int().positive(),
});

export const questFlushSchema = z.object({
  ok: z.literal(true),
  contract: z.literal(QUESTS_CONTRACT),
  /** Gerado pelo PLUGIN. É a chave da idempotência. */
  batchId: z.string().min(1).max(120),
  entries: z.array(questEntrySchema).max(QUEST_FLUSH_MAX_LIMIT),
  /**
   * Quantas linhas o lote tem NO TOTAL.
   *
   * É o que diz ao agente se há outra página. Sem ele, a única
   * forma de saber seria pedir mais uma e receber vazio — uma ida
   * de RCON por rodada, para todo servidor, para sempre.
   */
  total: z.number().int().min(0),
});

export type QuestFlushResponse = z.infer<typeof questFlushSchema>;

/** A recusa do plugin, com o código cru. */
export const questErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1).max(120),
});

/**
 * O push: o "agora".
 *
 * ####  O SEGREDO NÃO É ZELO  ####
 *
 * O `onConsoleLine` recebe TODA linha do servidor, o chat dos
 * jogadores incluído: sem ele, alguém digitando o marcador no chat
 * concluiria a própria missão. É a mesma defesa que o
 * `stat-events.ts` documenta.
 */
export const questPushSchema = z.object({
  contract: z.literal(QUESTS_CONTRACT),
  secret: z.string().min(1),
  /**
   * Gerado pelo PLUGIN, e é o que faz o push e o lote do mesmo fato
   * virarem uma linha só em `quest_events`.
   */
  eventId: z.string().min(1).max(120),
  kind: z.enum(['progress', 'complete', 'deliver']),
  steamId: z.string().regex(/^\d{17}$/),
  pq: z.number().int().positive(),
  /**
   * Só em `deliver`: para QUAL NPC o pacote foi.
   *
   * É o que o agente confere contra o snapshot da tentativa — um
   * push com o NPC errado não marca nada.
   */
  npcId: z.string().min(1).max(64).optional(),
  /**
   * Só em `deliver`: a distância que o PLUGIN mediu.
   *
   * ####  ELA CHEGA E É IGNORADA  ####
   *
   * Fica no schema porque o plugin a manda — e recusar a linha
   * inteira por um campo a mais seria pior. Mas quem paga a
   * recompensa `perMeter` usa a distância que o AGENTE mede, das
   * coordenadas do banco: um cliente adulterado que dissesse ter
   * andado 40 km seria pago por 40 km.
   *
   * ####  O `.catch()` NÃO É DESCUIDO  ####
   *
   * MEDIDO por teste: sem ele, um `meters` fora da faixa RECUSAVA O
   * PUSH INTEIRO — e a entrega não acontecia. Um campo que o agente
   * IGNORA não pode ter poder de veto sobre o que ele usa. Valor
   * absurdo vira `undefined`; a entrega segue.
   */
  meters: z.number().min(0).max(20_000).optional().catch(undefined),
});

export type QuestPushEvent = z.infer<typeof questPushSchema>;

/** A resposta do `consume`: o que saiu do inventário. */
export const questConsumeSchema = z.object({
  ok: z.literal(true),
  contract: z.literal(QUESTS_CONTRACT),
  taken: z.array(z.object({ shortname: z.string(), amount: z.number().int().min(0) })),
  /** `false` = faltou item. O resgate PARA aqui. Ver §7.4. */
  complete: z.boolean(),
});

// ------------------------------------------------------------
//  §3  MONTAGEM
// ------------------------------------------------------------

/**
 * Base64 do JSON, como o resto do projeto manda payload.
 *
 * O frame do WebRCON quebra em espaço e em aspas; base64 atravessa
 * inteiro. É a mesma escolha do `origemz.ui.doc` e do
 * `loadout.sync`.
 */
export function encodeQuestPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function buildWatchCommand(payload: QuestWatchPayload): string {
  return `${QUEST_COMMANDS.watch} ${encodeQuestPayload(payload)}`;
}

export function buildAssignCommand(steamId: string, payload: QuestAssignPayload): string {
  return `${QUEST_COMMANDS.assign} ${steamId} ${encodeQuestPayload(payload)}`;
}

export function buildFlushCommand(offset: number, limit: number, secret: string): string {
  return `${QUEST_COMMANDS.flush} ${String(offset)} ${String(limit)} ${secret}`;
}

export function buildAckCommand(batchId: string): string {
  return `${QUEST_COMMANDS.ack} ${batchId}`;
}

/**
 * Lê a linha do console e devolve o push, ou `null`.
 *
 * `null` para TUDO o que não é um push válido — inclusive para um
 * marcador com segredo errado. Quem chama não distingue os dois
 * casos de propósito: um jogador testando o marcador no chat não
 * pode gerar linha de log de alarme a cada tentativa.
 */
export function parseQuestPush(line: string, secret: string): QuestPushEvent | null {
  const at = line.indexOf(QUEST_EVENT_MARKER);

  if (at < 0) {
    return null;
  }

  const raw = line.slice(at + QUEST_EVENT_MARKER.length).trim();

  try {
    const parsed = questPushSchema.safeParse(JSON.parse(raw));

    if (!parsed.success || parsed.data.secret !== secret) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}
