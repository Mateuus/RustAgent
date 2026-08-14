// ============================================================
//  chat-buffer.ts  -  o que os jogadores estão dizendo.
//
//  ####  POR QUE NÃO BASTA FILTRAR O ConsoleBuffer  ####
//
//  O console guarda as últimas 500 linhas de TUDO — carga de
//  plugin, aviso de save, entrada e saída de jogador. Num servidor
//  cheio, meia hora de conversa sai do buffer empurrada por ruído
//  que ninguém lê. Um anel próprio, com o mesmo teto, guarda meia
//  hora de CHAT.
//
//  ####  E POR QUE ELE NÃO ESCUTA O RCON SOZINHO  ####
//
//  Ele é alimentado pelo MESMO ouvinte do `log` que alimenta o
//  console (ver servers/context.ts). Dois ouvintes independentes
//  sobre o mesmo socket é o desenho que um dia entrega metade das
//  linhas para cada um — e a metade que some é sempre a que
//  alguém estava procurando.
//
//  ------------------------------------------------------------
//  ####  O CHAT CHEGA EM DOIS FORMATOS  ####
//
//  O Rust moderno manda `Type: "Chat"` com o campo `Message`
//  contendo um JSON:
//
//      {"Channel":0,"Message":"oi","UserId":"765…","Username":"Fulano"}
//
//  Versões e plugins antigos mandam a linha crua, no genérico:
//
//      [CHAT] Fulano[76561198000000000] : oi
//
//  Aceitar os dois custa um parser de vinte linhas. Aceitar um só
//  custa uma aba de chat vazia em metade das instalações, sem
//  nada dizendo por quê.
// ============================================================

import type { RconLogEntry } from '../rcon/client.js';

/**
 * O teto do anel.
 *
 * Mesmo número do console, e pela mesma razão: é o que cabe numa
 * tela rolável sem virar vazamento de memória num processo que
 * fica meses de pé.
 */
const MAX_LINES = 500;

export interface ChatLine {
  /** Número absoluto. É o cursor do `fromLine`. */
  readonly n: number;
  readonly at: number;
  /** `null` quando a linha não trouxe o autor. */
  readonly steamId: string | null;
  readonly name: string | null;
  readonly text: string;
  /**
   * `global`, `equipe`, ou `null` quando a linha não diz.
   *
   * Importa mais do que parece: uma mensagem de equipe lida como
   * global faz quem administra achar que o combinado foi dito para
   * todo mundo.
   */
  readonly channel: 'global' | 'equipe' | null;
}

export class ChatBuffer {
  readonly #lines: ChatLine[] = [];
  #next = 0;
  #dropped = 0;

  get nextLine(): number {
    return this.#next;
  }

  get droppedLines(): number {
    return this.#dropped;
  }

  /**
   * Recebe TODA linha do RCON e guarda só o que é chat.
   *
   * O filtro mora aqui, e não em quem chama, porque quem chama é o
   * ouvinte único do `log` — ele não deve precisar saber o que
   * conta como conversa.
   */
  push(entry: RconLogEntry): void {
    const line = parseChat(entry);

    if (line === null) {
      return;
    }

    this.#lines.push({ ...line, n: this.#next });
    this.#next += 1;

    if (this.#lines.length > MAX_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }

  /** Uma linha escrita pelo AGENTE — o `say` do painel. */
  pushLocal(text: string, name: string): void {
    this.#lines.push({
      n: this.#next,
      at: Date.now(),
      steamId: null,
      name,
      text,
      channel: 'global',
    });

    this.#next += 1;

    if (this.#lines.length > MAX_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }

  from(cursor: number): readonly ChatLine[] {
    return this.#lines.filter((line) => line.n >= cursor);
  }
}

/** `null` = a linha não é chat. */
export function parseChat(entry: RconLogEntry): Omit<ChatLine, 'n'> | null {
  const text = entry.message.trim();

  if (text === '') {
    return null;
  }

  if (entry.type.toLowerCase() === 'chat') {
    return fromChatJson(text, entry.receivedAt) ?? fromChatText(text, entry.receivedAt);
  }

  // Fora do tipo `Chat`, só o prefixo explícito conta. Sem esta
  // trava, qualquer linha com um `:` no meio viraria mensagem de
  // jogador — e a aba de chat encheria de log do servidor.
  if (text.startsWith('[CHAT]')) {
    return fromChatText(text.slice('[CHAT]'.length).trim(), entry.receivedAt);
  }

  return null;
}

/** `{"Channel":0,"Message":"oi","UserId":"765…","Username":"Fulano"}` */
function fromChatJson(text: string, at: number): Omit<ChatLine, 'n'> | null {
  if (!text.startsWith('{')) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const entry = parsed as Record<string, unknown>;
  const message = asText(entry.Message ?? entry.message);

  if (message === null) {
    return null;
  }

  return {
    at,
    steamId: asText(entry.UserId ?? entry.userId ?? entry.SteamID),
    name: asText(entry.Username ?? entry.username ?? entry.DisplayName),
    text: message,
    // 1 é o canal de equipe no Rust; 0 é o global. Um número que
    // não conhecemos vira `null` em vez de virar "global" — ver o
    // comentário do campo.
    channel: entry.Channel === 1 ? 'equipe' : entry.Channel === 0 ? 'global' : null,
  };
}

/** `Fulano[76561198000000000] : oi` */
function fromChatText(text: string, at: number): Omit<ChatLine, 'n'> | null {
  const match = /^(.*?)\[(\d{17})\]\s*:\s*(.*)$/.exec(text);

  if (match !== null) {
    return {
      at,
      steamId: match[2] ?? null,
      name: asText(match[1]),
      text: (match[3] ?? '').trim(),
      channel: null,
    };
  }

  // Sem autor reconhecível a linha ainda vale: ela É uma mensagem
  // de chat (o tipo disse isso), e jogá-la fora deixaria a aba com
  // buracos sem explicação.
  return { at, steamId: null, name: null, text, channel: null };
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}
