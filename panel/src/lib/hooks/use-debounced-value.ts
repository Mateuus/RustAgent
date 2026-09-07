'use client';

import { useEffect, useState } from 'react';

/**
 * Atrasa a propagação de um valor até ele parar de mudar.
 *
 * No autocomplete de itens é o que separa "uma busca por
 * palavra" de "uma busca por tecla digitada": o catálogo tem
 * 1243 itens e cada consulta passa pelo agente.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
