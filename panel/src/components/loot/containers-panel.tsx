'use client';

// ============================================================
//  containers-panel.tsx  -  a tela por CONTÊINER.
//
//  ####  É O EIXO DA NAVEGAÇÃO, E NÃO UM ÍNDICE BONITO  ####
//
//  O admin chega aqui pensando "quero mexer na caixa de elite" —
//  nunca "quero mexer na regra trofeu-no-elite". A aba de regras
//  responde a segunda pergunta; esta responde a primeira, e é ela
//  que o Docs/CustomItem/05 §8.2 defende com a medição: 105
//  contêineres contra 650 tabelas de loot, e é o contêiner que a
//  pessoa reconhece.
//
//  ####  O QUE ESTA TELA NÃO MOSTRA  ####
//
//  O que o JOGO já põe dentro de cada caixa. É a decisão da Q2 do
//  05 — a extração da tabela do jogo fica para depois —, e o custo
//  dela está escrito na tela, não só no documento: quem acrescenta
//  aqui acrescenta às cegas. Para acrescentar isso é tolerável,
//  porque a nossa chance é sorteada por fora e não depende do que
//  já está lá dentro.
// ============================================================

import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  groupContainers,
  labelOf,
  matchesContainer,
  type ContainerGroupId,
} from '@/components/loot/containers';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LootContainerInfo, LootRule } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ContainersPanelProps {
  readonly containers: readonly LootContainerInfo[];
  readonly fromAgent: boolean;
  readonly error: string | null;
  readonly rules: readonly LootRule[];
  /** Abre o cadastro já com este contêiner marcado. */
  readonly onCreateHere: (container: string) => void;
}

export function ContainersPanel({
  containers,
  fromAgent,
  error,
  rules,
  onCreateHere,
}: ContainersPanelProps) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<Partial<Record<ContainerGroupId, boolean>>>({});

  const sections = useMemo(() => groupContainers(containers), [containers]);
  const searching = query.trim() !== '';

  /** As regras que apontam para um contêiner. */
  const rulesOf = (name: string): readonly LootRule[] =>
    rules.filter((rule) => rule.containers.includes(name));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Os contêineres que o plugin aceita, agrupados pela natureza que o admin reconhece. O
          número ao lado de cada um é quantas regras <strong>nossas</strong> caem ali — e não o que
          o jogo põe dentro, que esta tela ainda não lê.
        </p>

        <div className="relative min-w-56">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />
          <Input
            type="text"
            value={query}
            aria-label="Procurar contêiner"
            placeholder="elite, barril, airdrop, crate_normal…"
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-7 text-2xs"
          />
        </div>
      </div>

      {error !== null && (
        <StateBlock
          variant="error"
          title="Não consegui ler a lista de contêineres do agente"
          detail={`${error} — a tela seguiu com a lista de reserva do painel.`}
        />
      )}

      {!fromAgent && error === null && (
        <StateBlock
          variant="offline"
          title="Esta lista é do painel, não do agente"
          detail={
            <>
              A rota <span className="font-mono">/api/loot/containers</span> ainda não respondeu.
              São os contêineres que o estudo mediu um a um — se o plugin aceitar outro prefab, ele
              não aparece aqui.
            </>
          }
        />
      )}

      {sections.map((section) => {
        const visible = section.containers.filter((container) =>
          matchesContainer(container, query),
        );

        if (visible.length === 0) {
          return null;
        }

        const isOpen = searching || (opened[section.group.id] ?? !section.group.collapsed);
        const used = visible.filter((container) => rulesOf(container.name).length > 0).length;

        return (
          <section key={section.group.id} className="border border-border bg-surface">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpened((current) => ({ ...current, [section.group.id]: !isOpen }))}
              className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left"
            >
              <span aria-hidden="true" className={cn('text-muted', isOpen && 'rotate-90')}>
                ›
              </span>
              <span className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                {section.group.label}
              </span>
              <span className="text-2xs text-muted">
                {String(visible.length)} contêiner(es)
                {used > 0 && ` · ${String(used)} com regra nossa`}
              </span>
            </button>

            {isOpen && (
              <>
                <p className="border-b border-border px-3 py-1.5 text-2xs text-muted">
                  {section.group.hint}
                </p>

                <ul className="divide-y divide-border">
                  {visible.map((container) => {
                    const here = rulesOf(container.name);

                    return (
                      <li
                        key={container.name}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-surface-2"
                      >
                        <span className="min-w-40 flex-1">
                          <span className="block text-sm text-foreground">
                            {labelOf(container)}
                          </span>
                          <span className="block font-mono text-2xs text-muted">
                            {container.name}
                          </span>
                        </span>

                        {container.refreshSeconds !== null && (
                          <span
                            className="text-2xs text-muted"
                            title="De quanto em quanto tempo este contêiner refaz o loot. É por isso que uma regra volta a ser sorteada sem ninguém abrir nada."
                          >
                            refaz a cada {formatDuration(container.refreshSeconds)}
                          </span>
                        )}

                        {here.length === 0 ? (
                          <span className="text-2xs text-muted">sem regra nossa</span>
                        ) : (
                          <span
                            className="border border-olive px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground"
                            title={here.map((rule) => rule.label).join(', ')}
                          >
                            {String(here.length)} regra(s)
                            {here.some((rule) => rule.mode === 'measuring') && ' · medindo'}
                          </span>
                        )}

                        <Button size="sm" onClick={() => onCreateHere(container.name)}>
                          <Plus aria-hidden="true" className="h-4 w-4" />
                          Acrescentar item aqui
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        );
      })}

      {sections.length > 0 && searching && (
        <p className="text-2xs text-muted">
          Procurando por “{query}”. A busca casa o apelido, o prefab e o nome do grupo.
        </p>
      )}
    </div>
  );
}
