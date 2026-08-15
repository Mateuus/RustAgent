// ============================================================
//  COR: hex no modelo, floats no CUI.
//
//  ####  POR QUE O MODELO NÃO GUARDA O FORMATO DO JOGO  ####
//
//  O CUI representa cor como "R G B A" com floats de 0 a 1:
//
//      "0.66 0.66 0.66 0.9"
//
//  O modelo guarda "#A8A8A8E6". Os dois descrevem a mesma cor, e
//  a escolha do hex é do lado de quem edita:
//
//    - todo seletor de cor de navegador fala hex, e o <input
//      type="color"> nativo devolve hex;
//    - hex é comparável por igualdade de string; float não é
//      ("0.5" e "0.500" são a mesma cor e strings diferentes);
//    - o CSS entende #RRGGBBAA direto, então o preview não
//      precisa de conversão nenhuma.
//
//  ------------------------------------------------------------
//  ####  A TRADUÇÃO PARA O CUI NÃO ACONTECE AQUI  ####
//
//  Ela mora no CORE (`core/src/game/ui-cui.ts`), onde tem teste —
//  e o editor a consulta pelo `POST /api/ui/documents/:id/preview`
//  quando quer ver o JSON que de fato vai ao jogo.
//
//  O projeto anterior tinha as duas implementações, uma em cada
//  lado, e a obrigação de mantê-las iguais. Uma só é uma a menos
//  para divergir no primeiro ajuste — e a que sobra é a que o
//  cliente do jogo recebe.
// ============================================================

/** Preto opaco. Usado onde uma cor precisa existir. */
export const BLACK = '#000000FF';

/** Branco opaco — a cor neutra de tingimento de imagem. */
export const WHITE = '#FFFFFFFF';

/** Totalmente transparente. */
export const TRANSPARENT = '#00000000';

export interface Rgba {
  /** 0..255 */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0..255 */
  readonly a: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{3,8})$/i;

/**
 * Lê `#RGB`, `#RGBA`, `#RRGGBB` ou `#RRGGBBAA`.
 *
 * Devolve `null` em vez de lançar: isto roda em campo de texto
 * enquanto a pessoa digita, e metade de um hex é um estado
 * normal de digitação, não um erro para interromper.
 */
export function parseHexColor(input: string): Rgba | null {
  const match = HEX_PATTERN.exec(input.trim());
  if (match === null) {
    return null;
  }

  const digits = match[1];
  if (digits === undefined) {
    return null;
  }

  // Forma curta: cada dígito vale por dois ("#F0A" = "#FF00AA").
  const expanded =
    digits.length === 3 || digits.length === 4
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;

  if (expanded.length !== 6 && expanded.length !== 8) {
    return null;
  }

  const byteAt = (index: number): number => Number.parseInt(expanded.slice(index, index + 2), 16);

  return {
    r: byteAt(0),
    g: byteAt(2),
    b: byteAt(4),
    // Sem canal alfa escrito, a cor é opaca — que é o que
    // qualquer notação de 6 dígitos significa em toda parte.
    a: expanded.length === 8 ? byteAt(6) : 255,
  };
}

function toHexByte(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0').toUpperCase();
}

export function formatHexColor(color: Rgba): string {
  return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}${toHexByte(color.a)}`;
}

/**
 * A cor para o CSS do preview.
 *
 * `#RRGGBBAA` é válido em CSS desde 2016, então isto é quase
 * identidade — existe para normalizar a forma curta e para dar
 * um destino previsível ao hex quebrado que o campo de texto
 * produz no meio de uma digitação.
 */
export function cssColorFromHex(hex: string): string {
  const color = parseHexColor(hex);
  return color === null ? 'transparent' : formatHexColor(color);
}
