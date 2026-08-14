// ============================================================
//  format.ts  -  números para humano.
//
//  ####  AUSENTE VIRA TRAVESSÃO, NUNCA ZERO  ####
//
//  É a regra que o painel anterior aprendeu caro: "0 jogadores"
//  quando na verdade ninguém sabe faz o admin concluir que o
//  servidor está vazio. Toda função aqui aceita `null` e devolve
//  "—" — a leitura honesta de "não sei".
// ============================================================

export const EM_DASH = '—';

/** Bytes em GB/MB, com uma casa. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EM_DASH;
  }

  const gb = value / 1024 ** 3;

  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }

  return `${(value / 1024 ** 2).toFixed(0)} MB`;
}

/** Segundos em "3d 4h", "4h 12min" ou "12min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return EM_DASH;
  }

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) {
    return `${String(days)}d ${String(hours)}h`;
  }

  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}min`;
  }

  return `${String(minutes)}min`;
}

/**
 * Uma data ISO em "há 5 min", "há 3 h", "ontem" ou a data cheia.
 *
 * ####  RELATIVO PERTO, ABSOLUTO LONGE  ####
 *
 * "Visto por último" é uma coluna que se lê de relance para
 * decidir se alguém está por aí AGORA: "há 5 min" responde isso, e
 * "14/08/2026 20:31" obriga a fazer a conta de cabeça. Passada uma
 * semana a conta inverte — "há 23 dias" não localiza nada, e a
 * data localiza.
 */
export function formatWhen(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EM_DASH;
  }

  const at = Date.parse(value);

  if (!Number.isFinite(at)) {
    return EM_DASH;
  }

  const seconds = Math.round((Date.now() - at) / 1000);

  // Menos de um minuto (inclusive negativo) é "agora": o relógio do
  // agente e o do navegador não são o mesmo, e um "há -3 min" na
  // tela pareceria defeito.
  if (seconds < 60) {
    return 'agora';
  }

  if (seconds < 3_600) {
    return `há ${String(Math.floor(seconds / 60))} min`;
  }

  if (seconds < 86_400) {
    return `há ${String(Math.floor(seconds / 3_600))} h`;
  }

  if (seconds < 172_800) {
    return 'ontem';
  }

  if (seconds < 604_800) {
    return `há ${String(Math.floor(seconds / 86_400))} dias`;
  }

  return new Date(at).toLocaleDateString('pt-BR');
}

/** Data e hora completas, para quando a precisão importa. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EM_DASH;
  }

  const at = Date.parse(value);

  return Number.isFinite(at)
    ? new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : EM_DASH;
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EM_DASH;
  }

  return value.toLocaleString('pt-BR');
}

/**
 * "2 de 5" — dois números que só fazem sentido juntos.
 *
 * Com o total ausente, o parcial sozinho não diz nada, e a
 * resposta honesta é o travessão.
 */
export function formatOf(
  value: number | null | undefined,
  total: number | null | undefined,
): string {
  if (value === null || value === undefined || total === null || total === undefined) {
    return EM_DASH;
  }

  return `${String(value)} de ${String(total)}`;
}

/** Fração usada (0–100) a partir de total e livre. `null` se não dá para saber. */
export function usedPercent(
  total: number | null | undefined,
  free: number | null | undefined,
): number | null {
  if (total === null || total === undefined || free === null || free === undefined || total <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
}
