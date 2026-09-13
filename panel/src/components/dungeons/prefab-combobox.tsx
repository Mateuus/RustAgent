'use client';

// ============================================================
//  prefab-combobox.tsx  -  escolher a caixa (ou o inimigo) pelo
//  NOME.
//
//  ####  O CAMPO VALE O CAMINHO; A BUSCA É POR NOME  ####
//
//  O caminho completo é o que o construtor exige — o
//  `CreateEntity` do jogo recebe ele e nada mais. Mas ninguém
//  decora `assets/bundled/prefabs/radtown/underwater_labs/
//  crate_ammunition.prefab`, e digitar de cabeça é como a sala
//  nasce vazia: prefab errado não dá erro, ele é PULADO com um
//  aviso no console do servidor que o admin não lê.
//
//  É o mesmo desenho do `item-combobox.tsx`, com duas diferenças:
//  a lista é local (mora em `crate-catalog.ts`, e não numa rota) e
//  o caminho digitado à mão continua valendo — é a "caixa
//  personalizada" do pedido do dono.
//
//  ####  ACESSIBILIDADE: O PADRÃO COMBOBOX DA WAI-ARIA  ####
//
//  O foco NÃO sai do input; quem anda pela lista é o
//  `aria-activedescendant`. Fazer o foco pular para o `<li>`
//  quebraria a digitação, que é o ponto do autocomplete.
// ============================================================

import { Check, ChevronDown, Search } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import {
  dungeonPrefabLabel,
  searchDungeonPrefabs,
  type DungeonPrefabEntry,
} from './crate-catalog';

export interface PrefabComboboxProps {
  /** O caminho escolhido. É o valor do formulário. */
  readonly value: string;
  readonly onChange: (prefab: string) => void;
  readonly entries: readonly DungeonPrefabEntry[];
  /** A ordem dos grupos na lista. */
  readonly groups: readonly string[];
  readonly placeholder?: string;
  /**
   * O texto da primeira linha, quando o campo aceita "nenhum".
   *
   * Existe para o marcador do desenho: lá, vazio quer dizer "o que a
   * sala já usa", e essa é a escolha padrão — ela precisa ser
   * alcançável de volta depois de alguém escolher outra.
   */
  readonly emptyLabel?: string;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
}

export function PrefabCombobox({
  value,
  onChange,
  entries,
  groups,
  placeholder = 'nome da caixa, ou o caminho do prefab',
  emptyLabel,
  disabled = false,
  ariaLabel,
}: PrefabComboboxProps) {
  const listboxId = useId();

  /**
   * O que está escrito no campo.
   *
   * Fechado, ele mostra o NOME do que está escolhido; digitando, ele
   * é a busca. Guardar as duas coisas no mesmo estado é o que faz o
   * campo poder ser lido e escrito sem dois controles.
   */
  const [text, setText] = useState(() => labelOf(value, entries, emptyLabel));
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // O valor pode mudar por fora — outra caixa selecionada na lista,
  // um rascunho recarregado. Sem isto o campo continuaria mostrando
  // o nome do anterior.
  useEffect(() => {
    if (isOpen) return;

    setText(labelOf(value, entries, emptyLabel));
  }, [value, entries, emptyLabel, isOpen]);

  const found = useMemo(() => searchDungeonPrefabs(entries, isOpen ? text : ''), [entries, isOpen, text]);

  /**
   * O caminho digitado à mão, quando parece um.
   *
   * É a "caixa personalizada" do pedido: o Rust ganha contêiner a
   * cada update, e a lista é OFERTA, nunca trava. A oferta explícita
   * existe porque um campo que aceita texto livre sem dizer que
   * aceita é indistinguível de um que recusa em silêncio.
   */
  const typedPath = useMemo(() => {
    const trimmed = text.trim();

    if (!trimmed.startsWith('assets/') || !trimmed.endsWith('.prefab')) return null;
    if (entries.some((entry) => entry.prefab === trimmed)) return null;

    return trimmed;
  }, [text, entries]);

  /** As opções na ordem em que a lista as desenha. */
  const options = useMemo<readonly Option[]>(() => {
    const list: Option[] = [];

    if (emptyLabel !== undefined && text.trim() === '') {
      list.push({ prefab: '', label: emptyLabel, group: '' });
    }

    for (const group of groups) {
      for (const entry of found) {
        if (entry.group === group) list.push(entry);
      }
    }

    // Um grupo que o catálogo tem e a lista de grupos não teria
    // sumido daqui em silêncio — o que é o defeito que o catálogo de
    // containers do painel já teve uma vez.
    for (const entry of found) {
      if (!groups.includes(entry.group)) list.push(entry);
    }

    if (typedPath !== null) {
      list.push({ prefab: typedPath, label: 'Usar este caminho', group: 'Personalizada' });
    }

    return list;
  }, [emptyLabel, text, groups, found, typedPath]);

  function select(option: Option): void {
    onChange(option.prefab);
    setText(labelOf(option.prefab, entries, emptyLabel));
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === 'Enter') {
      const active = activeIndex >= 0 ? options[activeIndex] : options[0];

      if (active !== undefined && isOpen) {
        // Só engole o Enter quando ele SELECIONA algo: sem lista
        // aberta, ele tem de continuar enviando o formulário.
        event.preventDefault();
        select(active);
      }

      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    setIsOpen(true);

    if (options.length === 0) return;

    const step = event.key === 'ArrowDown' ? 1 : -1;

    setActiveIndex((current) => {
      const next = current + step;

      // Circula: de baixo volta ao topo. Numa lista de trinta,
      // rolar até o fim para voltar é pior.
      if (next < 0) return options.length - 1;

      return next >= options.length ? 0 : next;
    });
  }

  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${String(activeIndex)}` : undefined;

  return (
    <div className="relative">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
        />

        <Input
          role="combobox"
          type="text"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={text}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          {...(activeOptionId === undefined ? {} : { 'aria-activedescendant': activeOptionId })}
          className="pl-7 pr-7 text-2xs"
          onChange={(event) => {
            setText(event.target.value);
            setIsOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            // Esvaziar ao focar é o que faz a lista INTEIRA aparecer:
            // com o nome do escolhido dentro, a busca filtraria por
            // ele e o campo ofereceria uma opção só — a que já está
            // escolhida.
            setText('');
            setIsOpen(true);
          }}
          // `onMouseDown` no item, e não `onClick`: o blur do input
          // chega primeiro que o clique e fecharia a lista antes de
          // ela ser lida. O atraso de um quadro resolve sem timer.
          onBlur={() => {
            setIsOpen(false);
            setActiveIndex(-1);
            setText(labelOf(value, entries, emptyLabel));
          }}
          onKeyDown={handleKeyDown}
        />

        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
        />
      </div>

      <span role="status" aria-live="polite" className="sr-only">
        {isOpen ? `${String(options.length)} opções` : ''}
      </span>

      <ul
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        className={cn(
          'absolute left-0 right-0 top-full z-20 mt-px max-h-64 overflow-y-auto',
          'border border-border bg-surface-2',
          !isOpen && 'hidden',
        )}
      >
        {options.length === 0 && (
          <li role="presentation" className="px-2 py-2 text-2xs leading-relaxed text-muted">
            Nada com “{text}”. A lista é oferta, não trava: cole o caminho completo de um prefab
            (<span className="font-mono">assets/…/algo.prefab</span>) e ele vale.
          </li>
        )}

        {options.map((option, index) => {
          const startsGroup = index === 0 || option.group !== options[index - 1]?.group;
          const isChosen = option.prefab === value;

          return (
            <Fragment key={`${option.group}-${option.prefab}`}>
              {startsGroup && option.group !== '' && (
                <li
                  role="presentation"
                  className="border-b border-border bg-surface px-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                >
                  {option.group}
                </li>
              )}

              <li
                id={`${listboxId}-option-${String(index)}`}
                role="option"
                aria-selected={isChosen}
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(option);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'cursor-pointer px-2 py-1.5',
                  index === activeIndex && 'bg-rust/15',
                )}
              >
                <span className="flex items-center gap-1.5">
                  {isChosen ? (
                    <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-amber" />
                  ) : (
                    <span aria-hidden="true" className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate text-xs text-foreground">{option.label}</span>
                </span>

                {option.prefab !== '' && (
                  <span className="mt-0.5 block truncate pl-4.5 font-mono text-2xs text-muted">
                    {option.prefab}
                  </span>
                )}

                {'hint' in option && option.hint !== undefined && (
                  <span className="mt-0.5 block border-l-2 border-amber pl-2 text-2xs leading-relaxed text-foreground">
                    {option.hint}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}

/** Uma linha da lista: do catálogo, a vazia ou a digitada à mão. */
type Option = DungeonPrefabEntry | { prefab: string; label: string; group: string };

/**
 * O que o campo mostra quando está fechado.
 *
 * O nome amigável, quando o caminho é conhecido; o caminho cru,
 * quando não é. Mostrar o caminho de uma caixa que TEM nome seria
 * perder o que este componente existe para dar.
 */
function labelOf(
  prefab: string,
  entries: readonly DungeonPrefabEntry[],
  emptyLabel: string | undefined,
): string {
  if (prefab === '') return emptyLabel ?? '';

  const known = entries.find((entry) => entry.prefab === prefab);

  return known?.label ?? dungeonPrefabLabel(prefab);
}
