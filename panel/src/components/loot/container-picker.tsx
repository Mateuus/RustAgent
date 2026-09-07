'use client';

// ============================================================
//  container-picker.tsx  -  escolher ONDE a regra vale.
//
//  ####  A LISTA É AGRUPADA PORQUE SÃO CEM NOMES CRUS  ####
//
//  "quero mexer na caixa de elite" é como o admin pensa; uma
//  lista alfabética de `ShortPrefabName` não responde a isso. Os
//  grupos são os do Docs/CustomItem/05 §8.2, e os raros nascem
//  fechados (Q7) — mostrar todos abertos afogaria a caixa de
//  elite no meio de meias de Natal e caixas de tutorial.
//
//  ####  O QUE JÁ ESTÁ NA REGRA NUNCA SOME DA LISTA  ####
//
//  O PUT reescreve a regra inteira. Se a regra tem um prefab que
//  esta lista não conhece — porque o agente ainda não responde
//  `/api/loot/containers`, ou porque o plugin passou a aceitar um
//  container novo —, deixá-lo fora do seletor faria o próximo
//  "Salvar" APAGAR aquele container sem uma palavra. Ele aparece
//  numa seção própria, marcado, com o aviso do que ele é.
// ============================================================

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  CONTAINER_GROUPS,
  groupContainers,
  labelOf,
  matchesContainer,
  type ContainerGroupId,
} from '@/components/loot/containers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LootContainerInfo } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ContainerPickerProps {
  readonly containers: readonly LootContainerInfo[];
  /** A lista veio do agente? Se não, a tela diz de onde ela veio. */
  readonly fromAgent: boolean;
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
}

/**
 * Os prefabs da regra que a lista não conhece, como containers.
 *
 * Ver o cabeçalho: sem isto, salvar apaga o que não coube na
 * lista.
 */
function withSelected(
  containers: readonly LootContainerInfo[],
  selected: readonly string[],
): readonly LootContainerInfo[] {
  const known = new Set(containers.map((container) => container.name));
  const extra = selected
    .filter((name) => !known.has(name))
    .map((name) => ({ name, label: null, group: null, refreshSeconds: null }));

  return extra.length === 0 ? containers : [...containers, ...extra];
}

export function ContainerPicker({
  containers,
  fromAgent,
  selected,
  onChange,
  disabled = false,
}: ContainerPickerProps) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<Partial<Record<ContainerGroupId, boolean>>>({});

  const all = useMemo(() => withSelected(containers, selected), [containers, selected]);
  const sections = useMemo(() => groupContainers(all), [all]);

  const chosen = new Set(selected);

  const toggle = (name: string): void => {
    onChange(chosen.has(name) ? selected.filter((entry) => entry !== name) : [...selected, name]);
  };

  const searching = query.trim() !== '';

  return (
    <div className="border border-border bg-surface-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-2">
        <div className="relative min-w-40 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />
          <Input
            type="text"
            value={query}
            disabled={disabled}
            aria-label="Procurar contêiner"
            placeholder="elite, barril, airdrop, crate_normal…"
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 pl-7 text-2xs"
          />
        </div>

        <span className="text-2xs text-muted">
          {selected.length === 0
            ? 'nenhum escolhido'
            : `${String(selected.length)} escolhido(s)`}
        </span>

        {selected.length > 0 && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange([])}>
            Limpar
          </Button>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto">
        {sections.map((section) => {
          const visible = section.containers.filter((container) =>
            matchesContainer(container, query),
          );

          if (visible.length === 0) {
            return null;
          }

          // Procurando, tudo abre: esconder um resultado atrás de
          // um título fechado faz a busca parecer que não achou.
          const isOpen = searching || (opened[section.group.id] ?? !section.group.collapsed);
          const chosenHere = visible.filter((container) => chosen.has(container.name)).length;
          const allChosen = chosenHere === visible.length;

          return (
            <section key={section.group.id} className="border-b border-border last:border-b-0">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  disabled={disabled}
                  aria-expanded={isOpen}
                  onClick={() =>
                    setOpened((current) => ({ ...current, [section.group.id]: !isOpen }))
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={section.group.hint}
                >
                  <span
                    aria-hidden="true"
                    className={cn('shrink-0 text-muted', isOpen && 'rotate-90')}
                  >
                    ›
                  </span>
                  <span className="truncate font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
                    {section.group.label}
                  </span>
                  <span className="shrink-0 text-2xs text-muted">
                    {chosenHere > 0
                      ? `${String(chosenHere)} de ${String(visible.length)}`
                      : String(visible.length)}
                  </span>
                </button>

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    const names = visible.map((container) => container.name);

                    onChange(
                      allChosen
                        ? selected.filter((entry) => !names.includes(entry))
                        : [...selected, ...names.filter((name) => !chosen.has(name))],
                    );
                  }}
                >
                  {allChosen ? 'Desmarcar grupo' : 'Marcar grupo'}
                </Button>
              </div>

              {isOpen && (
                <ul className="pb-1">
                  {visible.map((container) => {
                    const isChosen = chosen.has(container.name);
                    const unknown = !containers.some((entry) => entry.name === container.name);

                    return (
                      <li key={container.name}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-surface',
                            disabled && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isChosen}
                            disabled={disabled}
                            onChange={() => toggle(container.name)}
                            className="h-3.5 w-3.5 shrink-0 accent-rust"
                          />

                          <span className="min-w-0 flex-1 truncate text-2xs text-foreground">
                            {labelOf(container)}
                          </span>

                          {/* O prefab SEMPRE ao lado do apelido: o
                              apelido é nosso e pode estar errado; o
                              prefab é o que o plugin casa. */}
                          <span className="shrink-0 font-mono text-2xs text-muted">
                            {container.name}
                          </span>

                          {unknown && (
                            <span
                              className="shrink-0 border border-amber px-1 font-condensed text-2xs font-bold uppercase tracking-wide text-amber"
                              title="Está na regra e não veio na lista do agente. Desmarcar aqui o tira da regra para sempre."
                            >
                              da regra
                            </span>
                          )}

                          {container.refreshSeconds !== null && (
                            <span
                              className="shrink-0 text-2xs text-muted"
                              title="De quanto em quanto tempo este contêiner refaz o loot — e a regra volta a ser sorteada, sem ninguém abrir nada."
                            >
                              refaz {formatDuration(container.refreshSeconds)}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}

        {sections.length === 0 && (
          <p className="px-3 py-3 text-2xs text-muted">
            Nenhum contêiner para escolher. O agente não respondeu quais o plugin aceita, e a lista
            de reserva do painel também está vazia — o que não deveria acontecer.
          </p>
        )}
      </div>

      {!fromAgent && (
        <p className="border-t border-border px-2 py-1.5 text-2xs leading-relaxed text-amber">
          Esta lista é <strong className="text-foreground">do painel</strong>, e não do agente: são
          os contêineres que o estudo mediu um a um. Se o plugin aceitar um prefab que não está
          aqui, ele não aparece — quem resolve isso é a rota{' '}
          <span className="font-mono">/api/loot/containers</span> passar a responder.
        </p>
      )}

      <p className="border-t border-border px-2 py-1.5 text-2xs leading-relaxed text-muted">
        As naturezas raras nascem fechadas —{' '}
        {CONTAINER_GROUPS.filter((group) => group.collapsed)
          .map((group) => group.label.toLowerCase())
          .join(', ')}
        . O nome à esquerda é apelido nosso; o da direita é o{' '}
        <span className="font-mono">ShortPrefabName</span>, que é o que o plugin casa de verdade.
      </p>
    </div>
  );
}
