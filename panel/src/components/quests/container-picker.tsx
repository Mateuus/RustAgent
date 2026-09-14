'use client';

// ============================================================
//  container-picker.tsx  -  escolher o que o saque alcança.
//
//  ####  TRÊS CHIPS EM CIMA, E A LISTA INTEIRA EMBAIXO  ####
//
//  O pedido do dono tem dois usos, e eles pesam diferente:
//
//    "qualquer barril"       é o que ele quer na maioria das vezes
//    "estes quatro prefabs"  é o que ele quer quando quer
//
//  Por isso as categorias ficam em cima, grandes, e a lista dos 65
//  contêineres fica embaixo, agrupada e fechada. Uma lista de 65
//  nomes crus como primeira coisa da tela é exatamente o que o
//  `loot/containers.ts` já documenta que não pode acontecer.
//
//  ####  O CATÁLOGO VEM DA API, E ISSO NÃO É DETALHE  ####
//
//  Se esta tela tivesse a própria lista de barris, ela ofereceria
//  "qualquer barril" contando uma coisa enquanto o agente contaria
//  outra — e o admin só descobriria pelo contador que não anda.
//  Quem sabe o que `@barrel` alcança é `game/quest-containers.ts`,
//  e é de lá que isto vem.
//
//  ####  CATEGORIA E PREFAB CONVIVEM  ####
//
//  A seleção é uma UNIÃO: "qualquer barril MAIS a caixa de elite" é
//  uma missão legítima, e nada aqui impede escrevê-la. O que a tela
//  faz é dizer, em uma frase, o que a soma alcança hoje — porque
//  `@barrel` sozinho não conta quantos barris são.
// ============================================================

import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  agent,
  type QuestContainerCategory,
  type QuestContainerEntry,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const INPUT =
  'w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground';
const CHECKBOX = 'h-4 w-4 shrink-0 accent-rust';

export interface ContainerPickerProps {
  /** Os seletores escolhidos: prefabs e categorias, misturados. */
  readonly value: readonly string[];
  readonly onChange: (targets: string[]) => void;
}

export function ContainerPicker({ value, onChange }: ContainerPickerProps) {
  const [categories, setCategories] = useState<readonly QuestContainerCategory[]>([]);
  const [containers, setContainers] = useState<readonly QuestContainerEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;

    agent
      .questContainers()
      .then((response) => {
        if (alive) {
          setCategories(response.categories ?? []);
          setContainers(response.containers ?? []);
        }
      })
      // ####  A LISTA SOME; O QUE JÁ FOI ESCOLHIDO FICA  ####
      //
      // Sem catálogo o admin perde a OFERTA, e não o cadastro: os
      // alvos que já estão no objetivo continuam ali, e o objetivo
      // salva igual. Derrubar o diálogo inteiro por uma rota que não
      // respondeu levaria junto as recompensas e as regras que ele
      // acabou de escrever.
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  const chosen = new Set(value);

  /** Os grupos, na ordem em que a API os devolve. */
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    const map = new Map<string, QuestContainerEntry[]>();

    for (const entry of containers) {
      const matches =
        needle === '' ||
        entry.label.toLocaleLowerCase('pt-BR').includes(needle) ||
        entry.prefab.includes(needle);

      if (!matches) {
        continue;
      }

      const list = map.get(entry.group) ?? [];

      list.push(entry);
      map.set(entry.group, list);
    }

    return [...map.entries()];
  }, [containers, query]);

  function toggle(selector: string): void {
    onChange(
      chosen.has(selector)
        ? value.filter((item) => item !== selector)
        : [...value, selector],
    );
  }

  return (
    <div className="rounded border border-border p-2">
      {/* ---- as três categorias ---- */}
      <div className="flex flex-wrap gap-1.5">
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            title={category.hint}
            aria-pressed={chosen.has(category.id)}
            onClick={() => toggle(category.id)}
            className={cn(
              'rounded border px-2 py-1 text-2xs uppercase tracking-wide',
              chosen.has(category.id)
                ? 'border-rust bg-rust/15 text-foreground'
                : 'border-border text-muted hover:text-foreground',
            )}
          >
            {category.label}
          </button>
        ))}

        {failed && (
          <span className="text-2xs text-muted">
            O catálogo de contêineres não carregou. O que já está escolhido continua valendo.
          </span>
        )}
      </div>

      {/* ---- o que a soma alcança ---- */}
      <p className="mt-2 text-2xs text-muted">
        {value.length === 0 ? (
          <span className="text-rust">Escolha pelo menos um contêiner.</span>
        ) : (
          <>
            Contam: <span className="text-foreground">{summaryOf(value, categories, containers)}</span>
          </>
        )}
      </p>

      {/* ---- a lista, fechada ---- */}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mt-2 flex items-center gap-1 text-2xs uppercase tracking-wide text-muted hover:text-foreground"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        Escolher contêineres, um a um
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              className={cn(INPUT, 'pl-7')}
              placeholder="barril, elite, crate_normal…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {groups.length === 0 && (
              <p className="text-2xs text-muted">Nenhum contêiner com esse nome.</p>
            )}

            {groups.map(([group, entries]) => (
              <div key={group}>
                <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                  {group}
                </p>

                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {entries.map((entry) => (
                    <label
                      key={entry.prefab}
                      className="flex items-center gap-2 text-2xs text-foreground"
                    >
                      <input
                        type="checkbox"
                        className={CHECKBOX}
                        checked={chosen.has(entry.prefab)}
                        onChange={() => toggle(entry.prefab)}
                      />
                      <span className="truncate">
                        {entry.label}{' '}
                        {/* O prefab ao lado, sempre: o nome amigável é
                            NOSSO e pode estar errado — o prefab é o que
                            o plugin casa de verdade. */}
                        <span className="font-mono text-muted">{entry.prefab}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A frase que resume a escolha.
 *
 * Ela conta QUANTOS prefabs a seleção alcança hoje, e não quantos
 * itens foram clicados: "qualquer barril" é um clique e cinco
 * contêineres, e é o cinco que responde "isso vai contar o quê?".
 */
function summaryOf(
  value: readonly string[],
  categories: readonly QuestContainerCategory[],
  containers: readonly QuestContainerEntry[],
): string {
  const names = value.map((selector) => {
    const category = categories.find((item) => item.id === selector);

    if (category !== undefined) {
      return category.label.toLocaleLowerCase('pt-BR');
    }

    return containers.find((item) => item.prefab === selector)?.label ?? selector;
  });

  const alcance = expandedCount(value, categories, containers);
  const lista = names.length > 3 ? `${names.length} tipos escolhidos` : names.join(', ');

  // Sem catálogo não há alcance a calcular — e prometer "0
  // contêineres" seria pior do que não dizer nada.
  return containers.length === 0 || alcance === 0
    ? lista
    : `${lista} (${alcance} contêiner${alcance === 1 ? '' : 'es'})`;
}

/** Quantos prefabs distintos a seleção alcança. */
function expandedCount(
  value: readonly string[],
  categories: readonly QuestContainerCategory[],
  containers: readonly QuestContainerEntry[],
): number {
  const prefabs = new Set<string>();

  for (const selector of value) {
    const category = categories.find((item) => item.id === selector);

    if (category === undefined) {
      prefabs.add(selector);
      continue;
    }

    // A regra é a mesma do agente, e ela é uma linha: a categoria
    // cobre famílias. O que decide qual família cada contêiner tem
    // continua sendo o agente — aqui só se lê o que ele mandou.
    for (const entry of containers) {
      if (familiesOf(category.id).includes(entry.family)) {
        prefabs.add(entry.prefab);
      }
    }
  }

  return prefabs.size;
}

function familiesOf(categoryId: string): readonly QuestContainerEntry['family'][] {
  switch (categoryId) {
    case '@barrel':
      return ['barrel'];
    case '@crate':
      return ['crate'];
    default:
      return ['barrel', 'crate', 'debris'];
  }
}
