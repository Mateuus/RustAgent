'use client';

// ============================================================
//  betterloot-table-list.tsx  -  a coluna da esquerda: as caixas.
//
//  ####  O CONTÊINER É O EIXO, E NUNCA O CAMINHO CRU  ####
//
//  O admin chega pensando "quero mexer na caixa de elite". A chave
//  do arquivo é
//  `assets/bundled/prefabs/radtown/crate_elite.prefab`, e uma
//  lista de 111 linhas assim seria uma lista que ninguém lê.
//
//  Então cada linha mostra o APELIDO em cima e o nome curto
//  embaixo, com a categoria ao lado — e o caminho inteiro só no
//  `title`, para quem precisar conferir. É o mesmo desenho da aba
//  de contêineres ao lado, de propósito: duas telas com dois mapas
//  do mesmo mundo é como o admin perde a caixa.
//
//  ####  A CONTAGEM É O QUE DECIDE ONDE CLICAR  ####
//
//  Uma caixa com 145 itens e uma com 3 pedem trabalhos diferentes.
//  O número ao lado do nome é o que faz o admin escolher sem abrir
//  as duas — e é grátis, porque o resumo já vem com ele.
// ============================================================

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { matchesRow, sectionsOf, type TableRow } from '@/components/loot/betterloot';
import { Input } from '@/components/ui/input';
import type { BetterLootTableSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

interface BetterLootTableListProps {
  readonly tables: readonly BetterLootTableSummary[];
  /** O caminho do prefab aberto. `null` = nenhum. */
  readonly selected: string | null;
  readonly onSelect: (prefab: string) => void;
}

export function BetterLootTableList({ tables, selected, onSelect }: BetterLootTableListProps) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<Readonly<Record<string, boolean>>>({});

  const sections = useMemo(() => sectionsOf(tables), [tables]);
  const searching = query.trim() !== '';

  return (
    <div className="flex h-full flex-col border border-border bg-surface">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            value={query}
            aria-label="Procurar caixa"
            placeholder="elite, barril, airdrop, crate_normal…"
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-7 text-2xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Lista vazia é um estado real, e não um erro: o
            BetterLoot gera o arquivo no primeiro boot, e antes
            disso não há caixa nenhuma para mostrar. Sem esta
            frase, a coluna ficaria em branco e se leria como
            tela quebrada. */}
        {tables.length === 0 && (
          <p className="px-3 py-6 text-center text-2xs leading-relaxed text-muted">
            O arquivo de loot deste servidor está vazio. O plugin o preenche sozinho no primeiro
            boot, a partir do loot do jogo.
          </p>
        )}

        {sections.map((section) => {
          const visible = section.rows.filter((row) => matchesRow(row, query));

          if (visible.length === 0) {
            return null;
          }

          // Buscando, tudo abre: procurar e não achar porque a
          // seção estava fechada é o defeito clássico de lista
          // agrupada.
          const isOpen = searching || (opened[section.id] ?? !section.collapsed);

          return (
            <section key={section.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                title={section.hint}
                onClick={() => setOpened((current) => ({ ...current, [section.id]: !isOpen }))}
                className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border bg-surface-2 px-2 py-1.5 text-left"
              >
                <span aria-hidden="true" className={cn('text-muted', isOpen && 'rotate-90')}>
                  ›
                </span>
                <span className="flex-1 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
                  {section.label}
                </span>
                <span className="text-2xs tabular-nums text-muted">{visible.length}</span>
              </button>

              {isOpen && (
                <ul>
                  {visible.map((row) => (
                    <TableListRow
                      key={row.table.prefab}
                      row={row}
                      active={row.table.prefab === selected}
                      onSelect={onSelect}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        {searching &&
          tables.length > 0 &&
          sections.every((section) => !section.rows.some((row) => matchesRow(row, query))) && (
            <p className="px-3 py-6 text-center text-2xs text-muted">
              Nenhuma caixa com esse nome.
            </p>
          )}
      </div>
    </div>
  );
}

function TableListRow({
  row,
  active,
  onSelect,
}: {
  readonly row: TableRow;
  readonly active: boolean;
  readonly onSelect: (prefab: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        title={row.table.prefab}
        onClick={() => onSelect(row.table.prefab)}
        className={cn(
          'flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-left',
          active
            ? 'border-rust bg-surface-2'
            : 'border-transparent hover:border-border hover:bg-surface-2',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-2xs text-foreground">{row.label}</span>
          <span className="block truncate font-mono text-[10px] text-muted">{row.shortName}</span>
        </span>

        {/* Desligado devolve a caixa ao loot do JOGO — não a deixa
            vazia. O rótulo diz "jogo" por isso: "desligado" faria
            pensar em caixa sem nada dentro. */}
        {!row.table.enabled && (
          <span className="shrink-0 border border-border px-1 text-[10px] uppercase text-muted">
            jogo
          </span>
        )}

        <span className="shrink-0 text-2xs tabular-nums text-muted">{row.table.itemCount}</span>
      </button>
    </li>
  );
}
