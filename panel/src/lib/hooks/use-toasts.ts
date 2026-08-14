'use client';

import { useSyncExternalStore } from 'react';

import { getServerToasts, getToasts, subscribeToasts, type ToastMessage } from '@/lib/toast';

/**
 * A fila de toasts, reagindo às mudanças do store de módulo.
 *
 * `useSyncExternalStore` e não `useState` + efeito: é ele que
 * garante que um `toast.error(...)` disparado durante uma
 * transição do React não seja lido de um snapshot velho —
 * exatamente o caso do formulário de entrega, que notifica de
 * dentro de um `await`.
 */
export function useToasts(): readonly ToastMessage[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
}
