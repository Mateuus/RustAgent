'use client';

// ============================================================
//  betterloot-globals-bar.tsx  -  a faixa de topo, editável.
//
//  ####  ELES MORAM AQUI PORQUE SÃO DO SERVIDOR INTEIRO  ####
//
//  `Loot Multiplier` e `Scrap Multipler` estão no
//  `oxide/config/BetterLoot.json`, e valem para os 111 contêineres
//  daquele servidor de uma vez. Um controle de "2x nesta caixa"
//  mentiria — ou multiplicaria tudo, ou não existiria. Aqui em
//  cima ele diz a verdade sobre o próprio alcance, e o menu repete
//  essa verdade antes de aplicar.
//
//  Quem quer 2x numa caixa só usa o outro menu, o de dentro dela,
//  que mexe no `Item Minimum`/`Item Maximum` das entradas.
//
//  ####  E ELES MULTIPLICAM A QUANTIDADE, NÃO A CHANCE  ####
//
//  5x não dá cinco vezes mais itens: dá os mesmos itens com
//  quantidade cinco vezes maior. Quem controla "quantos itens
//  saem" é o mín./máx. de itens de cada caixa, que o jogo corta em
//  36.
//
//  ####  O RASCUNHO NASCE DO DISCO, E A `key` O REFAZ  ####
//
//  O painel monta esta faixa com `key` na revisão do
//  `BetterLoot.json`. Gravou, a revisão muda, o componente remonta
//  e o rascunho nasce do que o servidor tem — em vez de continuar
//  mostrando o que foi enviado, que é a mesma regra que o editor de
//  caixa segue com a resposta do PUT.
// ============================================================

import { RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';

import { formatMultiplier } from '@/components/loot/betterloot-chance';
import {
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  MULTIPLIER_SHORTCUTS,
  draftOfGlobals,
  formatBlueprintPercent,
  globalsDirty,
  normalizeBlueprintPercent,
  normalizeMultiplier,
  toGlobalsInput,
  type GlobalsDraft,
} from '@/components/loot/betterloot-globals';
import { BetterLootMultiplierMenu } from '@/components/loot/betterloot-multiplier-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import type { BetterLootGlobals, BetterLootGlobalsInput } from '@/lib/api';

/**
 * O atalho de "voltar ao normal" entra na lista.
 *
 * Ele é o pedido que ninguém escreve mas todo mundo faz depois de
 * um fim de semana em 5x — e como campo livre exigiria saber que o
 * padrão é 1.
 */
const GLOBAL_SHORTCUTS: readonly number[] = [MIN_MULTIPLIER, ...MULTIPLIER_SHORTCUTS];

interface BetterLootGlobalsBarProps {
  /** O que o disco tinha. `null` = não deu para ler a configuração. */
  readonly globals: BetterLootGlobals | null;
  /** Quantas caixas o plugin gerencia, e de quantas. Só leitura. */
  readonly managed: { readonly enabled: number; readonly total: number };
  readonly busy: boolean;
  /** Grava. Quem cuida da corrida e do toast é o painel. */
  readonly onSave: (input: BetterLootGlobalsInput) => Promise<void>;
}

export function BetterLootGlobalsBar({
  globals,
  managed,
  busy,
  onSave,
}: BetterLootGlobalsBarProps) {
  const [draft, setDraft] = useState<GlobalsDraft>(() => draftOfGlobals(globals));
  const [saving, setSaving] = useState(false);

  const dirty = globalsDirty(draft, globals);
  const locked = busy || saving || globals === null;

  const save = async (): Promise<void> => {
    setSaving(true);

    try {
      await onSave(toGlobalsInput(draft));
    } finally {
      // Sem guarda de corrida: o `saving` só trava esta faixa, e
      // deixá-lo ligado trocaria um estado errado por uma faixa
      // morta. Quem repovoa o rascunho é a remontagem por `key`.
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Vale para o servidor inteiro
        </h3>

        <BetterLootMultiplierMenu
          text="Multiplicar tudo…"
          label="Multiplicador do servidor inteiro"
          scope="Vale para o SERVIDOR INTEIRO — as 111 caixas de uma vez."
          hint="Põe o multiplicador de itens e o de scrap no valor escolhido. Multiplica a QUANTIDADE de cada item, não a chance de ele sair. Nada é gravado até você clicar em Gravar."
          shortcuts={GLOBAL_SHORTCUTS}
          shortcutLabel={(factor) =>
            factor === MIN_MULTIPLIER ? 'sem multiplicador' : 'em itens e scrap'
          }
          customLabel="Outro multiplicador (inteiro)"
          min={MIN_MULTIPLIER}
          max={MAX_MULTIPLIER}
          step={1}
          busy={locked}
          onApply={(factor) => {
            const value = normalizeMultiplier(factor);

            setDraft((current) => ({
              ...current,
              lootMultiplier: value,
              scrapMultiplier: value,
            }));
          }}
        />
      </div>

      {globals === null ? (
        // Sem o arquivo não há o que editar, e um campo em branco
        // seria pior que o travessão: ele convidaria a digitar um
        // número que não tem para onde ir.
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ReadOnlyStat
            label="Multiplicador de itens"
            value={formatMultiplier(null)}
            hint="Não consegui ler o BetterLoot.json deste servidor."
          />
          <ReadOnlyStat
            label="Multiplicador de scrap"
            value={formatMultiplier(null)}
            hint="Não consegui ler o BetterLoot.json deste servidor."
          />
          <ReadOnlyStat
            label="Vira blueprint"
            value="—"
            hint="Não consegui ler o BetterLoot.json deste servidor."
          />
          <ReadOnlyStat
            label="Caixas gerenciadas"
            value={`${String(managed.enabled)} de ${String(managed.total)}`}
            hint="O resto continua com o loot do jogo."
          />
        </dl>
      ) : (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberStat
            label="Multiplicador de itens"
            hint="Vale para o servidor inteiro, e multiplica a QUANTIDADE de cada item — não a chance. É inteiro: o campo do plugin não aceita 1,5."
            value={draft.lootMultiplier}
            suffix="×"
            min={MIN_MULTIPLIER}
            max={MAX_MULTIPLIER}
            step={1}
            disabled={locked}
            onChange={(value) => {
              setDraft((current) => ({ ...current, lootMultiplier: normalizeMultiplier(value) }));
            }}
          />

          <NumberStat
            label="Multiplicador de scrap"
            hint="Idem: servidor inteiro, sobre a quantidade, e inteiro."
            value={draft.scrapMultiplier}
            suffix="×"
            min={MIN_MULTIPLIER}
            max={MAX_MULTIPLIER}
            step={1}
            disabled={locked}
            onChange={(value) => {
              setDraft((current) => ({ ...current, scrapMultiplier: normalizeMultiplier(value) }));
            }}
          />

          <div>
            <dt className="text-[10px] uppercase tracking-wider text-muted">Vira blueprint</dt>
            <dd className="mt-0.5 flex items-center gap-2">
              {/* Desligado, a porcentagem não vale nada — e um
                  campo editável ao lado de um interruptor apagado
                  promete um efeito que não acontece. */}
              <Toggle
                on={draft.blueprintConversion}
                busy={locked}
                label="Converter parte do loot em blueprint"
                onChange={(on) => {
                  setDraft((current) => ({ ...current, blueprintConversion: on }));
                }}
              />
              <span className="flex items-center gap-1">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={String(draft.blueprintPercent)}
                  aria-label="Porcentagem dos sorteios que vira blueprint"
                  disabled={locked || !draft.blueprintConversion}
                  onChange={(event) => {
                    const parsed = Number.parseFloat(event.target.value);

                    setDraft((current) => ({
                      ...current,
                      blueprintPercent: normalizeBlueprintPercent(Number.isNaN(parsed) ? 0 : parsed),
                    }));
                  }}
                  className="h-7 w-16 px-1 text-center text-2xs"
                />
                <span aria-hidden="true" className="text-2xs text-muted">
                  %
                </span>
              </span>
            </dd>
            <p className="mt-0.5 text-[10px] leading-snug text-muted">
              Quanto dos sorteios sai como projeto em vez do item.
            </p>
          </div>

          <ReadOnlyStat
            label="Caixas gerenciadas"
            value={`${String(managed.enabled)} de ${String(managed.total)}`}
            hint="O resto continua com o loot do jogo. Isto se muda caixa a caixa, no interruptor de cada uma."
          />
        </dl>
      )}

      {dirty && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2">
          <span className="mr-auto text-2xs text-amber">
            Isto muda o loot do servidor inteiro. Hoje ele está em{' '}
            {formatMultiplier(globals?.lootMultiplier ?? null)} para itens,{' '}
            {formatMultiplier(globals?.scrapMultiplier ?? null)} para scrap e{' '}
            {globals !== null && globals.blueprintConversion
              ? formatBlueprintPercent(globals.blueprintWeight)
              : 'sem conversão'}{' '}
            em blueprint.
          </span>
          <Button
            size="sm"
            disabled={saving || busy}
            onClick={() => {
              setDraft(draftOfGlobals(globals));
            }}
            className="flex items-center gap-1"
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Descartar
          </Button>
          <Button
            variant="confirm"
            size="sm"
            disabled={saving || busy}
            onClick={() => void save()}
            className="flex items-center gap-1"
          >
            <Save aria-hidden="true" className="h-3.5 w-3.5" />
            {saving ? 'Gravando…' : 'Gravar e recarregar'}
          </Button>
        </div>
      )}
    </div>
  );
}

function NumberStat({
  label,
  hint,
  value,
  suffix,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly suffix: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => {
            const parsed = Number.parseFloat(event.target.value);

            onChange(Number.isNaN(parsed) ? min : parsed);
          }}
          className="h-7 w-16 px-1 text-center text-2xs"
        />
        <span aria-hidden="true" className="text-2xs text-muted">
          {suffix}
        </span>
      </dd>
      <p className="mt-0.5 text-[10px] leading-snug text-muted">{hint}</p>
    </div>
  );
}

function ReadOnlyStat({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}) {
  return (
    <div title={hint}>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="font-condensed text-sm font-bold text-foreground">{value}</dd>
    </div>
  );
}
