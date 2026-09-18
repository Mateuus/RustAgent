// ============================================================
//  inventory-room.ts  -  "cabe tudo?", perguntado ANTES do resgate.
//
//  ####  O DEFEITO QUE TROUXE ESTE ARQUIVO  ####
//
//  Em 17/09/2026 o dono resgatou uma missão de NPC com a mochila
//  cheia. A missão virou `claimed`, o cooldown começou, e o item não
//  chegou: nem na mochila, nem no chão. O prêmio estava perdido, e
//  a missão dizia que tinha sido pago.
//
//  A regra agora é: o resgate PERGUNTA ao plugin se tudo cabe
//  (`origemz.give.check`), e sem espaço ele PARA — a missão continua
//  concluída, a recompensa continua esperando, e o jogador lê
//  quantos slots precisa liberar.
//
//  ####  O QUE ENTRA NA CONTA  ####
//
//  Item e kit: os dois viram `origemz.give`. Moeda, ponto e VIP não
//  ocupam slot. O kit entra com TODOS os itens dele — contar com a
//  roupa vestida seria otimismo, e o erro para o lado do "libere mais
//  um slot" custa um clique; o outro custa o prêmio.
// ============================================================

import { z } from 'zod';

import { ApiError } from '../http/error-response.js';
import { firstJsonLine, pluginErrorSchema } from '../game/plugin-contract.js';
import type { OpsRcon } from '../ops/service.js';
import type { QuestReward } from '../types/quests.js';

export const GIVE_CHECK_COMMAND = 'origemz.give.check';

/** Um item que o resgate vai pôr na mochila. */
export interface RoomItem {
  readonly shortname: string;
  readonly amount: number;
  readonly skinId: string;
}

/** O que o plugin responde. Ver `HandleGiveCheck` em OrigemZAgent.cs. */
const giveCheckOkSchema = z.object({
  ok: z.literal(true),
  fits: z.boolean(),
  slotsNeeded: z.number().int().nonnegative(),
  freeSlots: z.number().int().nonnegative(),
  missingSlots: z.number().int().nonnegative(),
});

const giveCheckResponseSchema = z.discriminatedUnion('ok', [giveCheckOkSchema, pluginErrorSchema]);

export type GiveCheckResult = z.infer<typeof giveCheckOkSchema>;

/**
 * A recusa, com a frase do jogador e o motivo técnico.
 *
 * Duas coisas porque têm dois leitores: o jogador lê "tente de
 * novo"; o log precisa de "resposta ilegível do plugin".
 */
export class InventoryCheckError extends ApiError {
  readonly reason: string;

  constructor(message: string, status: number, reason: string) {
    super('QUEST_INVENTORY_UNCHECKED', message, status);
    this.name = 'InventoryCheckError';
    this.reason = reason;
  }
}

/**
 * `origemz.give.check <steamId> <base64>`.
 *
 * Base64 pelo mesmo motivo do `origemz.quest.consume`: o parser de
 * console do Rust come as aspas de um token citado, e o JSON tem
 * aspas.
 */
export function buildGiveCheckCommand(steamId: string, items: readonly RoomItem[]): string {
  const payload = Buffer.from(JSON.stringify({ items }), 'utf8').toString('base64');

  return `${GIVE_CHECK_COMMAND} ${steamId} ${payload}`;
}

/**
 * A frase que o jogador lê quando não cabe.
 *
 * O número é de SLOTS, e não de itens: é o que ele consegue fazer
 * com o inventário aberto.
 */
export function inventoryFullMessage(missingSlots: number): string {
  const slots = missingSlots === 1 ? '1 slot' : `${String(missingSlots)} slots`;

  return `Inventário sem espaço para receber a recompensa. Libere ${slots} e tente resgatar novamente.`;
}

/**
 * O código do plugin, na frase de quem está tentando resgatar.
 *
 * Diferente de `describeGiveError`, que fala COM o admin sobre o
 * jogador: aqui quem lê é o próprio jogador.
 */
function refusalMessage(code: string): string {
  switch (code) {
    case 'PLAYER_DEAD':
      return 'Você precisa estar vivo para receber a recompensa. Renasça e tente resgatar de novo.';
    case 'PLAYER_SLEEPING':
      return 'Você precisa estar acordado para receber a recompensa.';
    case 'PLAYER_NOT_FOUND':
      return 'Você precisa estar no servidor para receber a recompensa.';
    case 'ITEM_NOT_FOUND':
      return 'Um item desta recompensa não existe mais no jogo. Um administrador precisa corrigir a missão.';
    default:
      return 'Não deu para conferir o seu inventário agora. Tente resgatar de novo em instantes.';
  }
}

/**
 * Pergunta ao plugin se os itens cabem.
 *
 * @throws {InventoryCheckError} com a frase para o jogador quando não dá para
 * saber — RCON fora, plugin velho, jogador morto. Não saber NUNCA
 * vira "cabe": é o "cabe" errado que perde o prêmio.
 */
export async function checkInventoryRoom(
  rcon: OpsRcon | null,
  steamId: string,
  items: readonly RoomItem[],
): Promise<GiveCheckResult> {
  if (rcon === null || !rcon.isConnected) {
    throw new InventoryCheckError(
      'O servidor não está respondendo agora. Tente resgatar de novo em instantes.',
      503,
      'RCON_UNAVAILABLE',
    );
  }

  const raw = await rcon.send(buildGiveCheckCommand(steamId, items));
  const parsed = giveCheckResponseSchema.safeParse(firstJsonLine(raw));

  if (!parsed.success) {
    // Um plugin sem o comando se cala: o console do Rust não
    // reclama de comando desconhecido. É o sintoma de um
    // OrigemZAgent desatualizado neste servidor.
    throw new InventoryCheckError(
      'Não deu para conferir o seu inventário agora. Tente resgatar de novo em instantes.',
      503,
      `resposta ilegível do ${GIVE_CHECK_COMMAND}: ${raw.trim().slice(0, 160)}`,
    );
  }

  if (!parsed.data.ok) {
    throw new InventoryCheckError(refusalMessage(parsed.data.error), 409, parsed.data.error);
  }

  return parsed.data;
}

/**
 * Os itens que um conjunto de recompensas põe na mochila.
 *
 * `kitItemsOf` resolve o kit pelo slug; `null` = kit que não existe
 * mais — a entrega dele vai falhar por conta própria, e não há o que
 * medir.
 */
export function roomItemsOf(
  rewards: readonly QuestReward[],
  kitItemsOf: (slug: string) => readonly RoomItem[] | null,
): readonly RoomItem[] {
  const items: RoomItem[] = [];

  for (const reward of rewards) {
    if (reward.kind === 'item') {
      items.push({ shortname: reward.shortname, amount: reward.amount, skinId: reward.skinId });
    } else if (reward.kind === 'kit') {
      items.push(...(kitItemsOf(reward.slug) ?? []));
    }
  }

  return items;
}
