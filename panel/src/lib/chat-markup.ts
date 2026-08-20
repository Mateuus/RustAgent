// ============================================================
//  chat-markup.ts  -  a mesma leitura de cor que o agente faz.
//
//  ####  ISTO É UM ESPELHO, E O ORIGINAL É O DO AGENTE  ####
//
//  A regra de verdade mora em core/src/game/chat-markup.ts, e a
//  conversão para o jogo em Plugins/OrigemZChat.cs
//  (`ApplyChatMarkup`). Aqui a cópia existe por um motivo só: a
//  PRÉVIA. Ela precisa mostrar exatamente o que vai sair no chat,
//  e uma prévia que adivinha diferente do agente é pior que
//  prévia nenhuma — ela mente com confiança.
//
//  O painel não importa do agente (bundler de um lado, ESM do
//  Node do outro), então a cópia é a mesma escolha do
//  `SPAWN_LIMITS` em spawn-status-panel.tsx. Mudar a regra exige
//  mudar os TRÊS arquivos.
// ============================================================

/** A paleta, igual à do agente e à do plugin. */
export const CHAT_COLORS: Readonly<Record<string, string>> = {
  branco: '#ffffff',
  preto: '#000000',
  cinza: '#9ca3af',
  vermelho: '#ef4444',
  laranja: '#f97316',
  amarelo: '#facc15',
  dourado: '#ffcc00',
  verde: '#22c55e',
  ciano: '#22d3ee',
  azul: '#3b82f6',
  roxo: '#a855f7',
  rosa: '#ec4899',
};

/** Os nomes em ordem estável, para a fileira de botões. */
export const CHAT_COLOR_NAMES = Object.keys(CHAT_COLORS);

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const MARKER_PATTERN = /\[(\/?)([^[\]\s]{0,20})\]/g;

/** Um pedaço da frase e a cor dele. `null` = a cor do campo. */
export interface ColorSpan {
  readonly text: string;
  readonly color: string | null;
}

/** `verde` ou `#22C55E` -> `#22c55e`. `null` quando não é cor. */
export function resolveChatColor(token: string): string | null {
  const clean = token.trim().toLowerCase();

  if (clean === '') {
    return null;
  }

  if (HEX_PATTERN.test(clean)) {
    return clean;
  }

  return CHAT_COLORS[clean] ?? null;
}

/**
 * Quebra a frase nos pedaços coloridos.
 *
 *  1. `[cor]` liga a cor daí em diante.
 *  2. `[/]` (ou `[/cor]`) desliga e volta à anterior.
 *  3. Abrir A MESMA cor que já está ligada DESLIGA.
 *
 * O que não é cor — `[AVISO]`, `[BR]` — fica literal.
 */
export function parseChatMarkup(text: string): readonly ColorSpan[] {
  const spans: ColorSpan[] = [];
  const open: string[] = [];

  let buffer = '';
  let cursor = 0;

  const flush = (): void => {
    if (buffer !== '') {
      spans.push({ text: buffer, color: open.at(-1) ?? null });
      buffer = '';
    }
  };

  for (const match of text.matchAll(MARKER_PATTERN)) {
    const at = match.index;
    const closing = match[1] === '/';
    const color = resolveChatColor(match[2] ?? '');

    buffer += text.slice(cursor, at);

    if (closing) {
      if (open.length === 0 || (match[2] !== '' && color === null)) {
        buffer += match[0];
      } else {
        flush();
        open.pop();
      }
    } else if (color === null) {
      buffer += match[0];
    } else {
      flush();

      if (open.at(-1) === color) {
        open.pop();
      } else {
        open.push(color);
      }
    }

    cursor = at + match[0].length;
  }

  buffer += text.slice(cursor);
  flush();

  return spans;
}
