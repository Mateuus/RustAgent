'use client';

// ============================================================
//  betterloot-guaranteed.tsx  -  o que sai SEMPRE.
//
//  ####  GARANTIDO NÃO É SORTEIO  ####
//
//  Um item em `Guaranteed Items` sai toda vez que a caixa abre, sem
//  passar por peso, raridade ou perfil. Ele não disputa nada com
//  ninguém — e é por isso que esta lista não tem coluna de chance,
//  ao contrário de todas as outras da tela.
//
//  O que ele disputa é o TETO DE ITENS da caixa, e só quando o
//  "Garantidos contam no total" está ligado. Esse interruptor mora
//  no editor de caixa, junto do teto que ele afeta.
//
//  ####  O MESMO BLOCO SERVE À CAIXA E AO PERFIL  ####
//
//  Os dois arquivos do BetterLoot têm `Guaranteed Items` com a
//  mesma forma — a caixa no `LootTables.json`, o perfil no
//  `LootGroups.json`. Dois editores separados divergiriam na
//  primeira vez que um campo mudasse; este componente é o único
//  lugar onde essa lista se edita.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { nextEntryKey } from '@/components/loot/betterloot';
import { ItemCombobox } from '@/components/item-combobox';
import { ItemIcon } from '@/components/item-icon';
import { NO_SKIN, type ItemChoice } from '@/components/item-choice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BetterLootGuaranteedEntry } from '@/lib/api';

interface BetterLootGuaranteedProps {
  readonly entries: readonly BetterLootGuaranteedEntry[];
  readonly onChange: (next: BetterLootGuaranteedEntry[]) => void;
  readonly serverId: string;
  readonly busy: boolean;
  /** Para o `id` do campo: há dois destes na tela ao mesmo tempo. */
  readonly idPrefix: string;
  /** Uma frase que diz onde este "sempre" vale. */
  readonly hint: string;
}

export function BetterLootGuaranteed({
  entries,
  onChange,
  serverId,
  busy,
  idPrefix,
  hint,
}: BetterLootGuaranteedProps) {
  const [shortname, setShortname] = useState('');
  const [choice, setChoice] = useState<ItemChoice | null>(null);

  const patch = (key: string, next: Partial<BetterLootGuaranteedEntry>): void => {
    onChange(entries.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)));
  };

  const add = (): void => {
    const base = shortname.trim();

    if (base === '' || busy) {
      return;
    }

    onChange([
      ...entries,
      {
        // A chave é única no dicionário do arquivo: o sufixo `{n}`
        // é o que deixa o mesmo item entrar duas vezes com skins
        // diferentes. Quem edita nunca vê o sufixo.
        key: nextEntryKey(base, entries.map((entry) => entry.key)),
        shortname: base,
        displayName: choice?.displayName ?? null,
        skinId: choice?.skinId ?? NO_SKIN,
        customName: null,
        min: 1,
        max: 1,
      },
    ]);

    setShortname('');
    setChoice(null);
  };

  return (
    <section className="space-y-2 border-t border-border pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Sempre saem ({entries.length})
        </h3>
        <span className="text-2xs text-muted">{hint}</span>
      </div>

      {entries.length === 0 ? (
        <p className="text-2xs text-muted">
          Nenhum. Tudo o que sair daqui vai passar por sorteio.
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {entries.map((entry) => (
            <li key={entry.key} className="flex items-center gap-2 px-2 py-1.5">
              <ItemIcon shortname={entry.shortname} size="sm" label={entry.shortname} />

              <span className="min-w-0 flex-1 truncate text-2xs text-foreground">
                {entry.customName ?? entry.displayName ?? entry.shortname}
              </span>

              <span className="flex shrink-0 items-center gap-1 text-2xs text-muted">
                <Input
                  type="number"
                  min={0}
                  value={String(entry.min)}
                  disabled={busy}
                  aria-label={`Quantidade mínima de ${entry.shortname}`}
                  // Mexer no mínimo empurra o máximo junto quando ele
                  // ficaria menor: com os dois trocados o BetterLoot
                  // entrega sempre o mínimo, e nada reclama.
                  onChange={(event) => {
                    const min = Number(event.target.value);

                    patch(entry.key, { min, max: Math.max(min, entry.max) });
                  }}
                  className="h-7 w-16 text-right text-2xs"
                />
                <span>–</span>
                <Input
                  type="number"
                  min={0}
                  value={String(entry.max)}
                  disabled={busy}
                  aria-label={`Quantidade máxima de ${entry.shortname}`}
                  onChange={(event) => {
                    const max = Number(event.target.value);

                    patch(entry.key, { max, min: Math.min(max, entry.min) });
                  }}
                  className="h-7 w-16 text-right text-2xs"
                />
              </span>

              <button
                type="button"
                disabled={busy}
                aria-label={`Tirar ${entry.shortname} dos garantidos`}
                onClick={() => onChange(entries.filter((other) => other.key !== entry.key))}
                className="shrink-0 p-1 text-muted hover:text-rust disabled:opacity-40"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${idPrefix}-guaranteed`}>Pôr um item que sai sempre</Label>
          <ItemCombobox
            inputId={`${idPrefix}-guaranteed`}
            value={shortname}
            onValueChange={setShortname}
            onChoiceChange={setChoice}
            serverId={serverId}
            disabled={busy}
            placeholder="nome do item (scrap, assault, troféu…)"
          />
        </div>
        <Button
          size="sm"
          disabled={shortname.trim() === '' || busy}
          onClick={add}
          className="flex items-center gap-1"
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Acrescentar
        </Button>
      </div>
    </section>
  );
}
