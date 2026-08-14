// ============================================================
//  util.ts  -  utilitários pequenos, sem dono natural.
// ============================================================

/**
 * Normaliza um `unknown` capturado para Error.
 *
 * `catch (e)` em TypeScript entrega `unknown` — e código real
 * chega a lançar string, número e até null. Passar isso direto
 * para o logger produz linhas como "error: undefined", que não
 * ajudam ninguém às três da manhã.
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  return new Error(`non-error thrown: ${safeStringify(value)}`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
