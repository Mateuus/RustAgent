// ============================================================
//  Fila de notificações transitórias.
//
//  ####  QUANDO USAR TOAST, E QUANDO NÃO USAR  ####
//
//  Toast é para o desfecho de uma AÇÃO: a entrega saiu, o plugin
//  recusou, a rede caiu no meio do envio. Some sozinho porque o
//  fato já passou.
//
//  Toast NÃO é para ESTADO que continua valendo — token ausente,
//  agente fora do ar, catálogo ainda não montado. Esses ficam
//  inline, no bloco da própria tela (ver state-block.tsx). Trocar
//  um deles por toast deixa a tela mentindo que está tudo bem
//  cinco segundos depois.
//
//  ------------------------------------------------------------
//  POR QUE UM STORE DE MÓDULO, E NÃO UM CONTEXT
//
//  `toast.success(...)` precisa funcionar de qualquer lugar —
//  inclusive de dentro de um `catch` de função assíncrona, longe
//  do corpo do componente, onde não dá para chamar hook. Um store
//  de módulo com `useSyncExternalStore` do outro lado resolve
//  isso sem provider e sem prop drilling.
// ============================================================

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  readonly id: string;
  readonly variant: ToastVariant;
  /** A frase principal. Deve dizer o que aconteceu, não um código. */
  readonly message: string;
  /** Segunda linha: número, código de erro, o que fazer a seguir. */
  readonly description: string | null;
  /** Quanto tempo até sumir sozinho. `null` = fica até fecharem. */
  readonly duration: number | null;
}

export interface ToastOptions {
  readonly description?: string;
  /**
   * Sobrescreve o tempo padrão da variante. `null` prende o toast
   * na tela até alguém fechar — reservado para desfecho que o
   * admin PRECISA ver (ver o RCON_TIMEOUT em give-panel.tsx).
   */
  readonly duration?: number | null;
}

/**
 * Tempo por variante.
 *
 * Erro fica mais que o dobro do sucesso: "entregue" se lê de
 * relance, "o plugin recusou porque o jogador está morto" precisa
 * ser lido inteiro. O relógio ainda pausa no hover e no foco
 * (ver ui/toast.tsx), então estes números são o piso, não o teto.
 */
const DEFAULT_DURATION_MS: Readonly<Record<ToastVariant, number>> = {
  success: 4_000,
  info: 5_000,
  warning: 7_000,
  error: 10_000,
};

/**
 * Quantos ficam na tela ao mesmo tempo.
 *
 * Acima disso a pilha vira uma parede que cobre o canto da
 * página, e os de baixo — os mais novos, que é o que a pessoa
 * acabou de causar — saem da área visível.
 */
const MAX_VISIBLE = 4;

/**
 * Lista vazia com identidade estável.
 *
 * O `useSyncExternalStore` compara snapshots por referência: se
 * o estado inicial e o snapshot de servidor fossem dois `[]`
 * diferentes, o React entenderia "mudou" a cada render e entraria
 * em laço.
 */
const NO_TOASTS: readonly ToastMessage[] = [];

let toasts: readonly ToastMessage[] = NO_TOASTS;
const listeners = new Set<() => void>();

/**
 * Contador simples, e não `crypto.randomUUID()`.
 *
 * O painel pode ser servido por HTTP puro num IP de rede local, e
 * `crypto.randomUUID` não existe fora de contexto seguro — a
 * chamada quebraria justamente na instalação mais comum. Um id de
 * toast só precisa ser único dentro desta aba.
 */
let nextId = 0;

function emit(next: readonly ToastMessage[]): void {
  toasts = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): readonly ToastMessage[] {
  return toasts;
}

/**
 * Snapshot do HTML pré-renderizado em tempo de build: nunca há
 * toast ali. Sem isto o `useSyncExternalStore` quebra a
 * pré-renderização do export estático.
 */
export function getServerToasts(): readonly ToastMessage[] {
  return NO_TOASTS;
}

export function dismissToast(id: string): void {
  const next = toasts.filter((entry) => entry.id !== id);
  // Só notifica se algo saiu de fato: fechar duas vezes (clique e
  // relógio ao mesmo tempo) não deve render a árvore de novo.
  if (next.length !== toasts.length) emit(next);
}

function push(variant: ToastVariant, message: string, options: ToastOptions = {}): string {
  nextId += 1;
  const id = `toast-${String(nextId)}`;

  const entry: ToastMessage = {
    id,
    variant,
    message,
    description: options.description ?? null,
    duration: options.duration === undefined ? DEFAULT_DURATION_MS[variant] : options.duration,
  };

  // O mais novo entra no FIM da lista, e a pilha é desenhada de
  // cima para baixo: o recém-chegado fica embaixo, mais perto do
  // canto onde o olho já está. Estourando o teto, quem sai é o
  // mais antigo — o do topo.
  emit([...toasts, entry].slice(-MAX_VISIBLE));

  return id;
}

/**
 * A API que os componentes usam.
 *
 *     toast.success('500 × Wood no inventário de Fulano');
 *     toast.error('O jogador está morto.', { description: 'PLAYER_DEAD' });
 */
export const toast = {
  success: (message: string, options?: ToastOptions): string => push('success', message, options),
  error: (message: string, options?: ToastOptions): string => push('error', message, options),
  warning: (message: string, options?: ToastOptions): string => push('warning', message, options),
  info: (message: string, options?: ToastOptions): string => push('info', message, options),
  dismiss: dismissToast,
} as const;
