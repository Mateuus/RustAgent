'use client';

// ============================================================
//  pagination.tsx  -  o paginador do painel, e a lógica dele.
//
//  "‹ Anterior  1 2 3 … 9  Próxima ›" e "mostrando 21–40 de 90",
//  com o seletor de quantos por página. Usado no /workshop (Skins,
//  Posse, Registro) e na aba Skins da ficha do jogador.
//
//  ####  DOIS MODOS  ####
//
//    Total conhecido   a lista inteira já está no navegador (ou o
//                      agente disse quantas são): `total` = número.
//                      A página é uma fatia — `slicePage`.
//
//    Por cursor        o agente devolve uma página e o cursor da
//                      próxima, sem total (posse e registro). O
//                      `useCursorPages` guarda o cursor de cada página
//                      já vista; os números vão até a última
//                      conhecida, e o total só aparece quando a última
//                      página de verdade foi lida.
//
//  Cursor e não offset nesses dois: a aba Posse dá e tira em lote
//  enquanto alguém pagina, e um offset pularia ou repetiria linha.
//
//  ####  A LÓGICA É PURA  ####
//
//  Fatiar, contar páginas, a faixa e a janela de números moram aqui
//  como funções sem React, e têm teste em test/pagination.test.ts.
// ============================================================

import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** As opções do seletor "por página". */
export const PAGE_SIZES: readonly number[] = [20, 50, 100];

// ------------------------------------------------------------
//  LÓGICA PURA
// ------------------------------------------------------------

/** Quantas páginas cabem `total` itens. Lista vazia ainda é uma página. */
export function pageCount(total: number, pageSize: number): number {
  if (!(pageSize > 0) || !(total > 0)) return 1;

  return Math.ceil(total / pageSize);
}

/**
 * A página dentro do que existe. Serve quando a lista encolhe (um
 * filtro, uma skin apagada) e a página guardada ficou além do fim.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize);

  if (!Number.isFinite(page) || page < 1) return 1;

  return Math.min(Math.floor(page), last);
}

/** Os itens da página `page` (a partir de 1). */
export function slicePage<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const current = clampPage(page, items.length, pageSize);
  const start = (current - 1) * pageSize;

  return items.slice(start, start + pageSize);
}

export interface RangeInput {
  readonly page: number;
  readonly pageSize: number;
  /** `null` = total desconhecido (modo cursor). */
  readonly total: number | null;
  /** Quantos itens a página atual tem. Obrigatório sem total. */
  readonly shown?: number;
}

/** A faixa mostrada, 1-based e inclusiva. `null` quando não há nada. */
export function pageRange({ page, pageSize, total, shown }: RangeInput): {
  start: number;
  end: number;
} | null {
  const start = (Math.max(1, page) - 1) * pageSize + 1;
  const end =
    total === null
      ? start + Math.max(0, shown ?? 0) - 1
      : Math.min(Math.max(1, page) * pageSize, total);

  return end < start ? null : { start, end };
}

const integer = new Intl.NumberFormat('pt-BR');

/** "mostrando 21–40 de 90"; sem total, "mostrando 21–40". */
export function describeRange(input: RangeInput): string {
  const range = pageRange(input);

  if (range === null) return 'nada para mostrar';

  const span = `mostrando ${integer.format(range.start)}–${integer.format(range.end)}`;

  return input.total === null ? span : `${span} de ${integer.format(input.total)}`;
}

/** Um item da janela de números: a página, ou as reticências. */
export type PageSlot = number | 'gap';

/**
 * Os números a desenhar, com reticências. Sempre a primeira e a
 * última, a atual e as vizinhas, em no máximo 7 posições — assim o
 * paginador não muda de largura enquanto se anda por ele.
 *
 *   atual 1 de 5    1 2 3 4 5
 *   atual 1 de 20   1 2 3 4 5 … 20
 *   atual 10 de 20  1 … 9 10 11 … 20
 *   atual 19 de 20  1 … 16 17 18 19 20
 */
export function pageWindow(current: number, count: number): PageSlot[] {
  const last = Math.max(1, Math.floor(count));
  const page = Math.min(Math.max(1, Math.floor(current)), last);
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  if (last <= 7) return range(1, last);
  if (page <= 4) return [...range(1, 5), 'gap', last];
  if (page >= last - 3) return [1, 'gap', ...range(last - 4, last)];

  return [1, 'gap', page - 1, page, page + 1, 'gap', last];
}

/**
 * A pilha de cursores depois de ler a página `page`.
 *
 * `stack[i]` é o cursor que abre a página `i + 1` (`null` = a
 * primeira). `next` é o que o agente devolveu para a seguinte.
 *
 * Se a página seguinte continua abrindo no mesmo cursor, as páginas
 * já vistas depois dela continuam válidas (`kept`); se mudou (alguém
 * deu ou tirou uma linha), tudo dali em diante é descartado.
 */
export function advanceCursors(
  stack: readonly (number | null)[],
  page: number,
  next: number | null,
): { cursors: readonly (number | null)[]; kept: boolean } {
  const head = stack.slice(0, page);

  if (next === null) return { cursors: head, kept: stack.length === page };
  if (stack.length > page && stack[page] === next) return { cursors: stack, kept: true };

  return { cursors: [...head, next], kept: false };
}

// ------------------------------------------------------------
//  O HOOK DO MODO CURSOR
// ------------------------------------------------------------

export interface CursorPage<T> {
  readonly items: readonly T[];
  /** O cursor da próxima página; `null` = esta é a última. */
  readonly next: number | null;
}

export interface CursorPages<T> {
  /** `null` até a primeira resposta. */
  readonly items: readonly T[] | null;
  readonly page: number;
  /** Páginas alcançáveis: as já vistas e a seguinte, se houver. */
  readonly knownPages: number;
  readonly hasNext: boolean;
  /** Só conhecido depois de ler a última página. */
  readonly total: number | null;
  readonly busy: boolean;
  /** A falha da última leitura (formate com o `messageOf` do chamador). */
  readonly error: unknown;
  readonly goTo: (page: number) => void;
  /** Relê a página atual — depois de dar ou tirar alguma coisa. */
  readonly refresh: () => Promise<void>;
  /** Volta à página 1 e esquece os cursores. */
  readonly reset: () => Promise<void>;
}

interface CursorState<T> {
  readonly items: readonly T[] | null;
  readonly page: number;
  readonly knownPages: number;
  readonly hasNext: boolean;
  readonly total: number | null;
}

/**
 * Paginação por cursor. Recomeça da página 1 sempre que `fetchPage`
 * (ou `pageSize`) muda — o filtro faz parte do `fetchPage`, então um
 * filtro novo é uma lista nova.
 */
export function useCursorPages<T>(
  fetchPage: (cursor: number | null) => Promise<CursorPage<T>>,
  pageSize: number,
): CursorPages<T> {
  const [state, setState] = useState<CursorState<T>>({
    items: null,
    page: 1,
    knownPages: 1,
    hasNext: false,
    total: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const cursors = useRef<readonly (number | null)[]>([null]);
  const pageRef = useRef(1);
  // Cada leitura ganha um número; resposta de leitura antiga é
  // descartada. Sem isso, dois cliques rápidos deixavam a resposta
  // mais lenta (e velha) por cima da nova, sem aviso.
  const generation = useRef(0);

  const load = useCallback(
    async (target: number, fresh: boolean) => {
      const mine = ++generation.current;
      let stack = fresh ? [null] : cursors.current;
      let page = Math.max(1, Math.min(target, stack.length));

      setBusy(true);

      try {
        let result = await fetchPage(stack[page - 1] ?? null);

        // A página esvaziou (tiraram o que havia nela): volta até
        // achar alguma coisa, em vez de mostrar uma página vazia.
        while (result.items.length === 0 && page > 1) {
          if (mine !== generation.current) return;
          page -= 1;
          stack = stack.slice(0, page);
          result = await fetchPage(stack[page - 1] ?? null);
        }

        if (mine !== generation.current) return;

        const { cursors: nextStack, kept } = advanceCursors(stack, page, result.next);
        const items = result.items;

        cursors.current = nextStack;
        pageRef.current = page;
        setState((previous) => ({
          items,
          page,
          knownPages: nextStack.length,
          hasNext: result.next !== null,
          total:
            result.next === null
              ? (page - 1) * pageSize + items.length
              : kept && !fresh
                ? previous.total
                : null,
        }));
        setError(null);
      } catch (cause) {
        if (mine !== generation.current) return;
        setError(cause);
        setState((previous) => (previous.items === null ? { ...previous, items: [] } : previous));
      } finally {
        if (mine === generation.current) setBusy(false);
      }
    },
    [fetchPage, pageSize],
  );

  useEffect(() => {
    void load(1, true);
  }, [load]);

  const goTo = useCallback((page: number) => void load(page, false), [load]);
  const refresh = useCallback(() => load(pageRef.current, false), [load]);
  const reset = useCallback(() => load(1, true), [load]);

  return { ...state, busy, error, goTo, refresh, reset };
}

// ------------------------------------------------------------
//  O COMPONENTE
// ------------------------------------------------------------

export interface PaginationProps {
  /** A página atual, a partir de 1. */
  readonly page: number;
  readonly pageSize: number;
  /** `null` = desconhecido (modo cursor): use `knownPages` e `hasNext`. */
  readonly total: number | null;
  /** Itens na página atual. Obrigatório quando `total` é `null`. */
  readonly shown?: number;
  /** Modo cursor: até que página dá para ir. */
  readonly knownPages?: number;
  /** Modo cursor: existe página depois desta. */
  readonly hasNext?: boolean;
  readonly busy?: boolean;
  readonly onPageChange: (page: number) => void;
  /** Ausente = sem o seletor "por página". */
  readonly onPageSizeChange?: (pageSize: number) => void;
  readonly pageSizes?: readonly number[];
  readonly className?: string;
}

export function Pagination({
  page,
  pageSize,
  total,
  shown,
  knownPages,
  hasNext,
  busy = false,
  onPageChange,
  onPageSizeChange,
  pageSizes = PAGE_SIZES,
  className,
}: PaginationProps) {
  const count =
    total === null ? Math.max(1, knownPages ?? page) : pageCount(total, pageSize);
  const current = Math.min(Math.max(1, page), count);
  const canNext = total === null ? (hasNext ?? false) || current < count : current < count;
  const slots = pageWindow(current, count);
  const sizes = pageSizes.includes(pageSize) ? pageSizes : [...pageSizes, pageSize].sort((a, b) => a - b);

  if (total === 0) return null;

  return (
    <nav
      aria-label="Paginação"
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-2xs text-muted" aria-live="polite">
          {describeRange({ page: current, pageSize, total, ...(shown === undefined ? {} : { shown }) })}
        </p>

        {onPageSizeChange !== undefined && (
          <label className="flex items-center gap-1.5 text-2xs text-muted">
            <select
              value={pageSize}
              disabled={busy}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="h-7 border border-border bg-surface-2 px-1 font-mono text-2xs text-foreground hover:border-muted disabled:opacity-50"
            >
              {sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            por página
          </label>
        )}

        {busy && <Loader2 aria-label="Carregando" className="h-3.5 w-3.5 animate-spin text-muted" />}
      </div>

      {(count > 1 || canNext) && (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || current <= 1}
            onClick={() => onPageChange(current - 1)}
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="max-sm:sr-only">Anterior</span>
          </Button>

          {slots.map((slot, index) =>
            slot === 'gap' ? (
              <span
                key={`gap-${String(index)}`}
                aria-hidden="true"
                className="px-1 font-mono text-2xs text-muted"
              >
                …
              </span>
            ) : (
              <Button
                key={slot}
                size="sm"
                variant="outline"
                aria-label={`Página ${String(slot)}`}
                aria-current={slot === current ? 'page' : undefined}
                disabled={busy && slot !== current}
                onClick={() => {
                  if (slot !== current) onPageChange(slot);
                }}
                className={cn(
                  'min-w-7 px-1.5 font-mono',
                  slot === current && 'border-amber text-amber hover:border-amber',
                )}
              >
                {slot}
              </Button>
            ),
          )}

          {/* Sem total, depois da última página conhecida pode haver mais. */}
          {total === null && (
            <span aria-hidden="true" className="px-1 font-mono text-2xs text-muted">
              …
            </span>
          )}

          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canNext}
            onClick={() => onPageChange(current + 1)}
          >
            <span className="max-sm:sr-only">Próxima</span>
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </nav>
  );
}
