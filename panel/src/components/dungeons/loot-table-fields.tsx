'use client';

// ============================================================
//  loot-table-fields.tsx  -  o que cai dentro da caixa.
//
//  ####  TRÊS MODOS, E O PADRÃO É NÃO MEXER  ####
//
//    servidor   o Rust enche a caixa e o BetterLoot vale. É o de
//               hoje, e o que 90% das masmorras querem
//    acrescenta o Rust enche, e a nossa tabela vem POR CIMA
//    substitui  limpamos e só a nossa tabela vale
//
//  Enquanto o modo é "servidor" a tela não mostra tabela nenhuma:
//  seriam sessenta linhas em branco pedindo para serem preenchidas,
//  numa tela em que quase ninguém precisa delas.
//
//  ####  PESO E "SEMPRE" SÃO AS DUAS MANEIRAS DE CAIR  ####
//
//  A mesa mais comum que existe precisa das duas: "toda caixa
//  vermelha tem 100 de scrap" (sempre) "e mais dois itens desta
//  lista" (sorteio por peso). Com só uma delas, essa frase não é
//  escrevível.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { LOOT_MODES, type LootEntry, type LootMode, type LootTable } from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';

const MODE_LABEL: Readonly<Record<LootMode, string>> = {
  server: 'A do servidor',
  add: 'Acrescenta',
  replace: 'Substitui',
};

const MODE_DETAIL: Readonly<Record<LootMode, string>> = {
  server: 'O Rust enche a caixa. O BetterLoot continua valendo.',
  add: 'O Rust enche, e os itens abaixo entram por cima.',
  replace: 'Só os itens abaixo. O papel do código nunca é apagado.',
};

/** O teto do schema. Passar disso a rota recusa. */
const MAX_ENTRIES = 60;

const EMPTY_ENTRY: LootEntry = {
  shortname: '',
  amount: { min: 1, max: 1 },
  weight: 10,
  guaranteed: false,
  skin: 0,
  blueprint: false,
  condition: 0,
};

export interface LootTableFieldsProps {
  readonly value: LootTable;
  readonly onChange: (value: LootTable) => void;
  /** Some no rótulo: "Caixas desta cor", "O corpo do inimigo"… */
  readonly title: string;
}

export function LootTableFields({ value, onChange, title }: LootTableFieldsProps) {
  const [draft, setDraft] = useState('');

  function update(change: Partial<LootTable>) {
    onChange({ ...value, ...change });
  }

  function updateEntry(index: number, change: Partial<LootEntry>) {
    update({
      entries: value.entries.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
    });
  }

  function add() {
    const shortname = draft.trim();

    if (shortname === '' || value.entries.length >= MAX_ENTRIES) {
      setDraft('');
      return;
    }

    update({ entries: [...value.entries, { ...EMPTY_ENTRY, shortname }] });
    setDraft('');
  }

  return (
    <div>
      <FieldLabel topic={DUNGEON_HELP.tabelaDeLoot}>{title}</FieldLabel>

      <div className="mt-1 grid gap-2 sm:grid-cols-3">
        {LOOT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={value.mode === mode}
            onClick={() => update({ mode })}
            className={
              value.mode === mode
                ? 'border border-rust bg-rust/10 p-2 text-left'
                : 'border border-border bg-surface-2 p-2 text-left hover:border-muted'
            }
          >
            <span className="block font-condensed text-2xs font-bold uppercase tracking-wide">
              {MODE_LABEL[mode]}
            </span>
            <span className="mt-0.5 block text-2xs text-muted">{MODE_DETAIL[mode]}</span>
          </button>
        ))}
      </div>

      {value.mode !== 'server' && (
        <div className="mt-3 border border-border bg-surface-2 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <FieldLabel topic={DUNGEON_HELP.sorteios}>Sorteios por caixa</FieldLabel>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={30}
                  className="w-16"
                  value={value.rolls.min}
                  onChange={(event) => {
                    const min = clampInt(event.target.value, 0, 30);

                    update({ rolls: { min, max: Math.max(min, value.rolls.max) } });
                  }}
                />
                <span className="text-2xs text-muted">a</span>
                <Input
                  type="number"
                  min={0}
                  max={30}
                  className="w-16"
                  value={value.rolls.max}
                  onChange={(event) => {
                    const max = clampInt(event.target.value, 0, 30);

                    update({ rolls: { min: Math.min(max, value.rolls.min), max } });
                  }}
                />
              </div>
            </div>

            <p className="min-w-0 flex-1 text-2xs text-muted">
              Os itens marcados <strong className="text-foreground">Sempre</strong> caem além destes
              sorteios, e não gastam nenhum deles.
            </p>
          </div>

          {value.entries.length === 0 && (
            <p className="mt-3 border-l-2 border-amber pl-2 text-2xs text-foreground">
              Uma tabela sem itens não muda nada — e o painel recusa salvar assim. Acrescente pelo
              menos um, ou volte para &ldquo;a do servidor&rdquo;.
            </p>
          )}

          {value.entries.length > 0 && (
            <div className="mt-3 space-y-2">
              {value.entries.map((entry, index) => (
                <EntryRow
                  key={`${entry.shortname}-${String(index)}`}
                  entry={entry}
                  onChange={(change) => updateEntry(index, change)}
                  onRemove={() =>
                    update({ entries: value.entries.filter((_unused, at) => at !== index) })
                  }
                />
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <Input
              value={draft}
              placeholder="scrap"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <Button size="sm" variant="outline" onClick={add}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Item
            </Button>
          </div>

          <p className="mt-1 text-2xs text-muted">
            Use o nome curto do item, como <code>rifle.ak</code> ou <code>sulfur</code>. Um nome que
            o jogo não conhece é pulado com aviso no console — a tabela inteira não cai por causa
            dele.
          </p>
        </div>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  onChange,
  onRemove,
}: {
  readonly entry: LootEntry;
  readonly onChange: (change: Partial<LootEntry>) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="border border-border bg-background p-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-32 flex-1">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Item</span>
          <Input
            className="mt-0.5 font-mono text-2xs"
            value={entry.shortname}
            onChange={(event) => onChange({ shortname: event.target.value })}
          />
        </div>

        <div>
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Quantidade
          </span>
          <div className="mt-0.5 flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={10_000}
              className="w-16"
              value={entry.amount.min}
              onChange={(event) => {
                const min = clampInt(event.target.value, 0, 10_000);

                onChange({ amount: { min, max: Math.max(min, entry.amount.max) } });
              }}
            />
            <span className="text-2xs text-muted">a</span>
            <Input
              type="number"
              min={0}
              max={10_000}
              className="w-16"
              value={entry.amount.max}
              onChange={(event) => {
                const max = clampInt(event.target.value, 0, 10_000);

                onChange({ amount: { min: Math.min(max, entry.amount.min), max } });
              }}
            />
          </div>
        </div>

        <div>
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Peso</span>
          <Input
            type="number"
            min={1}
            max={1000}
            className="mt-0.5 w-16"
            value={entry.weight}
            onChange={(event) => onChange({ weight: clampInt(event.target.value, 1, 1000) })}
          />
        </div>

        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover ${entry.shortname}`}
          className="flex h-9 w-9 shrink-0 items-center justify-center border border-border text-muted hover:border-muted hover:text-foreground"
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-2xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={entry.guaranteed}
            onChange={(event) => onChange({ guaranteed: event.target.checked })}
            className="accent-[var(--rust-red)]"
          />
          Sempre (não gasta sorteio)
        </label>

        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={entry.blueprint}
            onChange={(event) => onChange({ blueprint: event.target.checked })}
            className="accent-[var(--rust-red)]"
          />
          Cai como projeto
        </label>

        <label className="flex items-center gap-1.5">
          Skin
          <Input
            type="number"
            min={0}
            className="h-7 w-24"
            value={entry.skin}
            onChange={(event) => onChange({ skin: clampInt(event.target.value, 0, 4_000_000_000) })}
          />
        </label>

        <label className="flex items-center gap-1.5">
          Durabilidade
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            className="h-7 w-20"
            value={entry.condition}
            onChange={(event) => {
              const parsed = Number(event.target.value);

              onChange({ condition: Number.isNaN(parsed) ? 0 : clamp(parsed, 0, 1) });
            }}
          />
          <span className="text-muted">(0 = a do jogo)</span>
        </label>
      </div>
    </div>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);

  if (Number.isNaN(value)) return min;

  return clamp(value, min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
