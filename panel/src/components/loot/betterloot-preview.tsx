'use client';

// ============================================================
//  betterloot-preview.tsx  -  "abrindo 100 caixas dessas, sai isto".
//
//  ####  É O RECURSO CENTRAL, E NÃO UM EXTRA  ####
//
//  É literalmente o que o concorrente vende como diferencial, e é o
//  que separa um editor de números de uma ferramenta de
//  balanceamento. Um admin que lê "8 itens, peso 4000" não sabe o
//  que fez; um que lê "de 100 caixas, 3 saem com C4" sabe.
//
//  ####  ELA É ARITMÉTICA, E DIZ QUE É  ####
//
//  Não simula o motor: reproduzir o sorteio do BetterLoot exigiria
//  o `ProbalisticRNG`, o `MightyRNG`, o `UngroupedFlatSelect` e o
//  loot pool locking dentro do painel — reescrever o motor para
//  prever o motor. O que ela calcula é o VALOR ESPERADO, que é
//  exato quando a caixa não usa grupos (e nenhuma das 111 do
//  server01 usa).
//
//  As três aproximações estão escritas na tela, e não só no
//  comentário: uma prévia que promete exatidão e erra é pior que
//  nenhuma, porque o admin balanceia contra ela.
// ============================================================

import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  formatCount,
  formatMultiplier,
  previewOf,
} from '@/components/loot/betterloot-chance';
import { ItemIcon } from '@/components/item-icon';
import type { BetterLootEntry, BetterLootGlobals, BetterLootTable } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Quantas caixas a prévia abre. 100 primeiro: é como se fala de chance. */
const OPEN_OPTIONS: readonly number[] = [100, 1000, 10_000];

interface BetterLootPreviewProps {
  readonly table: BetterLootTable;
  readonly globals: BetterLootGlobals | null;
}

export function BetterLootPreview({ table, globals }: BetterLootPreviewProps) {
  const [opens, setOpens] = useState<number>(OPEN_OPTIONS[0] ?? 100);

  const preview = useMemo(
    () => previewOf(table, globals, opens, labelOfEntry),
    [table, globals, opens],
  );

  // `null` = o arquivo global não veio. Assumir 1× aqui daria um
  // número confiante e errado — ver `unknownMultiplier`.
  const multiplier = globals?.lootMultiplier ?? null;

  return (
    <section className="flex min-h-0 flex-1 flex-col border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        {/* h2: o h1 é o da página ("Loot"), e esta é uma seção de topo
            da coluna. Pular para h4 deixaria o leitor de tela sem os
            degraus do meio ao navegar por cabeçalhos. */}
        <h2 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Abrindo {opens.toLocaleString('pt-BR')} caixas
        </h2>

        <div className="flex border border-border">
          {OPEN_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={opens === option}
              onClick={() => setOpens(option)}
              className={cn(
                'px-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide',
                opens === option
                  ? 'bg-rust text-white'
                  : 'text-muted hover:text-foreground',
              )}
            >
              {option.toLocaleString('pt-BR')}
            </button>
          ))}
        </div>
      </header>

      <p className="border-b border-border px-3 py-2 text-2xs leading-relaxed text-muted">
        {preview.rolls.toFixed(1)} sorteios de item por caixa
        {preview.scrap !== null && (
          <>
            {' · '}
            {formatCount(preview.scrap)} de scrap no total
          </>
        )}
        {multiplier !== null && multiplier !== 1 && (
          <>
            {' · '}multiplicador {formatMultiplier(multiplier)} já aplicado
          </>
        )}
      </p>

      {/* ####  SEM O MULTIPLICADOR NÃO HÁ COLUNA DE UNIDADES  ####
          O mesmo tratamento que a raridade desconhecida recebe: um
          1× suposto faria a tela prometer um quinto do que sai num
          servidor 5x, e com cara de número medido. */}
      {preview.unknownMultiplier && (
        <p className="flex items-start gap-1.5 border-b border-border bg-amber/10 px-3 py-2 text-2xs leading-relaxed text-foreground">
          <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-amber" />
          O multiplicador do servidor não veio, e ele mexe na quantidade: as unidades ficam com
          travessão. Em quantas caixas o item sai continua valendo — isso o multiplicador não muda.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {preview.lines.length === 0 ? (
          <p className="px-3 py-6 text-center text-2xs text-muted">
            A caixa está vazia — não há o que projetar.
          </p>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-surface-2">
              <tr className="border-b border-border text-left">
                <th scope="col" className="px-2 py-1 text-2xs font-normal text-muted">
                  Item
                </th>
                <th scope="col" className="px-2 py-1 text-right text-2xs font-normal text-muted">
                  Em quantas
                </th>
                <th scope="col" className="px-2 py-1 text-right text-2xs font-normal text-muted">
                  Unidades
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.lines.map((line) => (
                <tr key={line.key}>
                  <td className="px-2 py-1">
                    <span className="flex items-center gap-2">
                      <ItemIcon shortname={line.shortname} size="sm" label={line.shortname} />
                      <span className="min-w-0 truncate text-2xs text-foreground">
                        {line.label}
                      </span>
                      {line.guaranteed && (
                        <span className="shrink-0 border border-olive/50 px-1 text-[10px] uppercase text-olive">
                          sempre
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right text-2xs tabular-nums text-foreground">
                    {formatCount(line.containers)}
                  </td>
                  <td className="px-2 py-1 text-right text-2xs tabular-nums text-muted">
                    {formatCount(line.units)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ####  O QUE A CONTA NÃO COBRE  ####
          Escrito na tela porque é onde o admin balanceia. Um número
          sem a margem dele é um número em que se confia demais. */}
      <footer className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted">
        Conta, não sorteio. Fora dela:{' '}
        {preview.flat ? 'nada de raridade (esta caixa é parelha)' : 'a rejeição de repetido'}, a
        conversão em blueprint
        {/* Sem o arquivo global, "desligada neste servidor" seria uma
            afirmação que a tela não tem como fazer — o mesmo erro do
            multiplicador suposto, logo acima. */}
        {globals === null
          ? ' (não deu para saber se está ligada)'
          : globals.blueprintConversion
            ? ` (${Math.round(globals.blueprintWeight * 100)}% dos sorteios)`
            : ' (desligada neste servidor)'}
        {table.profiles.length > 0 && ', e os grupos associados, que roubam sorteios'}.
        {preview.unknownRarity > 0 && (
          <>
            {' '}
            <strong className="text-amber">
              {preview.unknownRarity} itens sem raridade ficaram de fora.
            </strong>
          </>
        )}
      </footer>
    </section>
  );
}

/** O nome que a prévia mostra: o nosso, o do catálogo, ou o shortname. */
function labelOfEntry(entry: BetterLootEntry): string {
  return entry.customName ?? entry.displayName ?? entry.shortname;
}
