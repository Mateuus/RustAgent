'use client';

// ============================================================
//  item-combobox.tsx  -  buscar um item no catálogo do agente.
//
//  ####  O CAMPO VALE O SHORTNAME; A BUSCA É POR NOME  ####
//
//  O shortname é o que a entrega no jogo exige — `inventory.give`
//  recebe ele, e nada mais. Mas ninguém decora
//  `wall.frame.garagedoor`, e digitar de cabeça é como o item
//  errado entra num kit que só vai ser conferido quando chegar ao
//  jogador.
//
//  Então a busca é pelo NOME ("assault", "porta"), cada opção
//  mostra os dois, e o ícone vem antes do texto: reconhecer a arma
//  pela figura é mais rápido do que ler `rifle.ak`.
//
//  E ela funciona com TODOS OS SERVIDORES PARADOS — o catálogo
//  mora no banco do agente, que é a razão de ele existir.
//
//  ------------------------------------------------------------
//  ####  ACESSIBILIDADE: É O PADRÃO COMBOBOX DA WAI-ARIA  ####
//
//  O foco NÃO sai do input; quem anda pela lista é o
//  `aria-activedescendant` apontando para a opção ativa. Fazer o
//  foco pular para o `<li>` quebraria a digitação, que é o ponto
//  do autocomplete.
// ============================================================

import { Loader2, Search } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { Input } from '@/components/ui/input';
import { agent, type CatalogItem } from '@/lib/api';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 250;

/** Quantos itens a lista mostra. */
const RESULTS = 20;

interface ItemComboboxProps {
  /** Shortname digitado ou escolhido. É o valor do formulário. */
  readonly value: string;
  readonly onValueChange: (shortname: string) => void;
  /** O item escolhido na lista. `null` = o texto foi digitado à mão. */
  readonly onItemChange?: (item: CatalogItem | null) => void;
  readonly inputId?: string;
  readonly disabled?: boolean;
  readonly describedById?: string;
  readonly placeholder?: string;
}

export function ItemCombobox({
  value,
  onValueChange,
  onItemChange,
  inputId,
  disabled = false,
  describedById,
  // ####  O NOME É EM INGLÊS, E O EXEMPLO PRECISA DIZER ISSO  ####
  //
  // Os nomes vêm do jogo: "Assault Rifle", "Wood". Um exemplo em
  // português ("madeira") não acharia nada — MEDIDO: zero
  // resultados — e a primeira busca de quem lesse o campo daria em
  // lista vazia, que se lê como catálogo quebrado.
  placeholder = 'nome em inglês ou shortname (assault, wood, rifle.ak)',
}: ItemComboboxProps) {
  const listboxId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [items, setItems] = useState<readonly CatalogItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Texto que já corresponde a um item escolhido. Escolher uma
  // opção troca o valor do campo pelo shortname dela, e sem isto o
  // efeito dispararia uma busca nova pelo texto que acabou de ser
  // resolvido — a lista reabriria dizendo "nenhum item encontrado"
  // para um item que existe.
  const [resolved, setResolved] = useState<string | null>(null);

  const query = value.trim();

  useEffect(() => {
    if (query === '' || query === resolved) {
      setItems([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    const controller = new AbortController();

    setIsSearching(true);
    setSearchError(null);

    const timer = setTimeout(() => {
      void agent
        .items({ query, limit: RESULTS, signal: controller.signal })
        .then((page) => {
          setItems(page.items);
          setActiveIndex(-1);
        })
        .catch((cause: unknown) => {
          // Busca cancelada não é erro: é a tecla seguinte.
          if (controller.signal.aborted) {
            return;
          }

          setItems([]);
          setSearchError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Aborta a busca anterior a cada tecla: sem isso a resposta
      // de "wo" pode chegar depois da de "wood" e sobrescrever a
      // lista certa.
      controller.abort();
    };
  }, [query, resolved]);

  const select = (item: CatalogItem): void => {
    setResolved(item.shortname);
    onValueChange(item.shortname);
    onItemChange?.(item);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === 'Enter') {
      const active = activeIndex >= 0 ? items[activeIndex] : undefined;

      if (active !== undefined) {
        // Só engole o Enter quando ele SELECIONA algo. Sem opção
        // ativa, o Enter tem de continuar enviando o formulário.
        event.preventDefault();
        select(active);
      }

      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    if (items.length === 0) {
      return;
    }

    event.preventDefault();
    setIsOpen(true);

    // `step` é lido AQUI, e não dentro do atualizador: o atualizador
    // roda no próximo render, e depender do objeto de evento lá
    // dentro é frágil.
    const step = event.key === 'ArrowDown' ? 1 : -1;

    setActiveIndex((current) => {
      const next = current + step;

      // Circula: de baixo volta ao topo. Numa lista de vinte itens,
      // rolar até o fim para voltar é pior.
      if (next < 0) {
        return items.length - 1;
      }

      return next >= items.length ? 0 : next;
    });
  };

  const showList = isOpen && query !== '' && query !== resolved;
  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${String(activeIndex)}` : undefined;

  return (
    <div className="relative">
      <div className="relative flex items-center gap-2">
        {/* O ícone do que ESTÁ escolhido, fora do campo: ele é a
            confirmação de que o shortname digitado é mesmo o item
            que a pessoa tinha em mente. */}
        <ItemIcon shortname={resolved ?? query} size="sm" />

        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />

          <Input
            {...(inputId === undefined ? {} : { id: inputId })}
            role="combobox"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={value}
            placeholder={placeholder}
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-autocomplete="list"
            {...(activeOptionId === undefined ? {} : { 'aria-activedescendant': activeOptionId })}
            {...(describedById === undefined ? {} : { 'aria-describedby': describedById })}
            className="pl-7 font-mono text-2xs"
            onChange={(event) => {
              setResolved(null);
              onValueChange(event.target.value);
              onItemChange?.(null);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onBlur={() => setIsOpen(false)}
            onKeyDown={handleKeyDown}
          />

          {isSearching && (
            <Loader2
              aria-hidden="true"
              className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-amber"
            />
          )}
        </div>
      </div>

      {/* Contagem anunciada em separado: `aria-live` num container
          que só aparece e some não é lido de forma confiável. */}
      <span role="status" aria-live="polite" className="sr-only">
        {showList && !isSearching ? `${String(items.length)} itens encontrados` : ''}
      </span>

      <ul
        id={listboxId}
        role="listbox"
        aria-label="Itens do jogo"
        className={cn(
          'absolute left-0 right-0 top-full z-20 mt-px max-h-64 overflow-y-auto',
          'border border-border bg-surface-2',
          !showList && 'hidden',
        )}
      >
        {isSearching && items.length === 0 && (
          <li className="px-2 py-2 text-2xs text-muted">Buscando…</li>
        )}

        {!isSearching && searchError !== null && (
          <li className="border-l-2 border-l-rust px-2 py-2 text-2xs text-foreground">
            {searchError}
          </li>
        )}

        {!isSearching && searchError === null && items.length === 0 && (
          <li className="px-2 py-2 text-2xs text-muted">
            Nenhum item com “{query}”. O catálogo é lido do jogo — se ele estiver vazio, um servidor
            precisa subir uma vez.
          </li>
        )}

        {items.map((item, index) => (
          <li
            key={item.shortname}
            id={`${listboxId}-option-${String(index)}`}
            role="option"
            aria-selected={index === activeIndex}
            // O mousedown do clique dispararia o blur do input
            // ANTES do click, fechando a lista e cancelando a
            // seleção. Prevenir o padrão mantém o foco.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => select(item)}
            onMouseEnter={() => setActiveIndex(index)}
            className={cn(
              'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-2xs',
              index === activeIndex && 'bg-surface',
            )}
          >
            {/* O ícone entra ANTES do texto: reconhecer a arma pela
                figura é mais rápido do que ler "rifle.ak", e é a
                diferença entre escolher o item certo de primeira e
                descobrir o engano quando o kit chega ao jogador. */}
            <ItemIcon shortname={item.shortname} size="sm" />

            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">{item.displayName}</span>
              <span className="block truncate font-mono text-muted">{item.shortname}</span>
            </span>

            {item.removed ? (
              <span
                className="shrink-0 uppercase text-rust"
                title="O jogo não lista mais este item nesta versão."
              >
                fora do jogo
              </span>
            ) : (
              <span className="shrink-0 uppercase text-muted">{item.category}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
