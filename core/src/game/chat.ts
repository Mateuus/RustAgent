// ============================================================
//  chat.ts  -  o que os jogadores estão dizendo.
//
//  ####  A FONTE É O HISTÓRICO DO JOGO, E NÃO O LOG DO RCON  ####
//
//  A primeira versão disto lia o evento `log` do RCON e filtrava as
//  linhas de chat. Funciona num servidor de fábrica, e falhou no
//  primeiro servidor de verdade — pelo motivo que torna a lição
//  útil:
//
//  Um plugin de chat (aqui o `OrigemZChat`, portado do BetterChat)
//  CANCELA a mensagem original no `OnPlayerChat` para poder
//  reenviá-la formatada, com tag e cor. Cancelada a original, o
//  servidor não emite mais o frame `Type: "Chat"` do WebRCON — e o
//  que sobra no console é um `Puts` do plugin, cujo texto o dono do
//  servidor CONFIGURA. Filtrar o log seria decorar o formato de um
//  plugin, para quebrar no dia em que alguém editasse o config.
//
//  `chat.tail` é o histórico que o PRÓPRIO jogo mantém. Ele é
//  alimentado nos dois caminhos — o do jogo e o `Chat.Record` que um
//  plugin bem-comportado chama justamente para não sumir das
//  ferramentas de admin. Uma fonte só, estruturada, que não depende
//  da configuração de ninguém.
//
//  ####  E ELE TEM O QUE O BUFFER NÃO TINHA  ####
//
//  O histórico do servidor sobrevive ao reinício do AGENTE. Um
//  buffer em memória começa vazio toda vez que o agente sobe, e a
//  conversa da última hora — justamente a que alguém foi procurar —
//  não existiria em lugar nenhum.
// ============================================================

import { z } from 'zod';

import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';

/**
 * Os canais do Rust, na ordem do enum `Chat.ChatChannel`.
 *
 * A distinção não é enfeite: uma mensagem de EQUIPE lida como
 * global faz quem administra achar que o combinado foi dito para
 * todo mundo.
 */
const CHANNELS = ['global', 'equipe', 'servidor', 'cartas', 'local'] as const;

export type ChatChannel = (typeof CHANNELS)[number];

/** Quantas mensagens pedir ao histórico. */
export const DEFAULT_CHAT_LIMIT = 100;
export const MAX_CHAT_LIMIT = 500;

/**
 * Cor aceita para ir ao `style` da tela.
 *
 * ####  ISTO É UMA TRAVA, E NÃO ZELO  ####
 *
 * A cor vem do config de um plugin — texto que alguém escreve à mão
 * e que o agente repassa ao navegador. Sem a conferência, o campo
 * seria um caminho para injetar CSS na tela de quem administra.
 * Hexadecimal, ou um nome curto de cor, e nada mais.
 */
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

export interface ChatLine {
  /** Epoch ms. O jogo responde em SEGUNDOS; a conversão é aqui. */
  readonly at: number;
  /** `null` nas mensagens do próprio servidor (`say`). */
  readonly steamId: string | null;
  readonly name: string;
  /**
   * A tag do grupo — `[VIP OURO]`, `[ADMIN]`.
   *
   * Ela vem DENTRO do texto do histórico, porque é o plugin de chat
   * que a escreve ali. Ver `splitRendered`. `null` = o jogador não
   * tem tag, ou não há plugin de chat neste servidor.
   */
  readonly tag: string | null;
  readonly text: string;
  readonly channel: ChatChannel | null;
  /** A cor do nome naquele grupo, quando o plugin a informa. */
  readonly color: string | null;
}

/**
 * Uma entrada como o `chat.tail` a devolve.
 *
 * `Message` NÃO é sempre só a mensagem: com um plugin de chat no
 * caminho ela vem RENDERIZADA (`[VIP OURO] Fulano: oi`), porque é o
 * texto que o plugin gravou no histórico. Ver `splitRendered`.
 */
const chatEntrySchema = z.object({
  Channel: z.number().int().optional(),
  Message: z.string(),
  UserId: z.string().optional(),
  Username: z.string().optional(),
  Color: z.string().optional(),
  Time: z.number().optional(),
});

/**
 * As últimas mensagens daquele servidor.
 *
 * @throws {ApiError} 503 sem RCON, 502 quando a resposta não é o
 * JSON que o `chat.tail` promete.
 */
export async function readChat(
  serverId: string,
  rcon: OpsRcon,
  limit: number = DEFAULT_CHAT_LIMIT,
): Promise<readonly ChatLine[]> {
  if (!rcon.isConnected) {
    throw new ApiError(
      'RCON_UNAVAILABLE',
      `Sem conexão com o RCON do servidor "${serverId}". O histórico de chat é do servidor — ` +
        'só dá para lê-lo com ele no ar.',
      503,
    );
  }

  const capped = Math.max(1, Math.min(MAX_CHAT_LIMIT, Math.trunc(limit)));
  const raw = await rcon.send(`chat.tail ${String(capped)}`);

  return parseChatTail(raw);
}

/** O corpo da leitura, separado para o teste não precisar de RCON. */
export function parseChatTail(response: string): readonly ChatLine[] {
  const trimmed = response.trim();

  // Servidor sem conversa nenhuma responde vazio. É um fato, não
  // uma falha de leitura.
  if (trimmed === '') {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ApiError(
      'CHAT_INVALID_RESPONSE',
      `O comando chat.tail respondeu algo que não é JSON: ${trimmed.slice(0, 200)}`,
      502,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ApiError(
      'CHAT_INVALID_RESPONSE',
      'O comando chat.tail respondeu um JSON que não é uma lista de mensagens.',
      502,
    );
  }

  const lines: ChatLine[] = [];

  for (const entry of parsed) {
    const result = chatEntrySchema.safeParse(entry);

    if (!result.success) {
      // Uma linha estranha no meio do histórico não vale perder as
      // outras: o que interessa aqui é a conversa, e ela continua
      // legível sem a entrada que não deu para entender.
      continue;
    }

    const name = (result.data.Username ?? '').trim();
    const steamId = (result.data.UserId ?? '').trim();
    const { tag, text } = splitRendered(result.data.Message, name);
    const color = result.data.Color?.trim() ?? '';

    lines.push({
      // O `Time` do Rust é epoch em SEGUNDOS. Sem o ×1000, toda
      // mensagem apareceria em 1970.
      at: (result.data.Time ?? 0) * 1_000,
      // "0" é o próprio servidor — um `say`, ou o aviso de
      // atualização que o agente manda.
      steamId: steamId === '' || steamId === '0' ? null : steamId,
      name: name === '' ? 'SERVER' : name,
      tag,
      text,
      channel: CHANNELS[result.data.Channel ?? -1] ?? null,
      color: COLOR_PATTERN.test(color) ? color : null,
    });
  }

  return lines;
}

/**
 * Separa a TAG e o texto do que o histórico guardou.
 *
 * ####  POR QUE ISTO PRECISA EXISTIR  ####
 *
 * O campo `Message` deveria ser só o que foi dito, com o autor em
 * `Username`. Um plugin que reenvia a mensagem grava ali o texto
 * RENDERIZADO — no formato que o dono configurou, que por padrão é
 * `{Title} {Username}: {Message}`:
 *
 *     "[VIP OURO] Fulano: alguem viu o helicoptero?"
 *
 * Sem esta separação a tela escreveria "Fulano: [VIP OURO] Fulano:
 * …", já que o nome tem coluna própria. Com ela, os dois mundos
 * ficam iguais: a tag de um lado, o autor no meio, o que ele disse
 * do outro — e quem administra vê o mesmo VIP que o jogador vê.
 *
 * O corte é no `<nome>:`, e não numa posição fixa: o que vem ANTES
 * é o que o formato pôs ali. Num formato que comece por `{Time}`, a
 * "tag" seria o horário — feio, mas honesto, e ainda assim melhor
 * que o nome repetido. Sem o nome no texto (servidor de fábrica,
 * ou mensagem do `say`), não há tag e o texto vai inteiro.
 */
export function splitRendered(
  message: string,
  name: string,
): { readonly tag: string | null; readonly text: string } {
  const full = message.trim();

  if (name === '') {
    return { tag: null, text: full };
  }

  const marker = `${name}:`;
  const at = full.indexOf(marker);

  if (at === -1) {
    return { tag: null, text: full };
  }

  const before = full.slice(0, at).trim();

  return {
    tag: before === '' ? null : before,
    text: full.slice(at + marker.length).trim(),
  };
}
