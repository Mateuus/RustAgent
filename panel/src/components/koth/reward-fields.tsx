'use client';

// ============================================================
//  reward-fields.tsx  -  o que nasce quando alguém vence.
//
//  ####  PESO, E NÃO PORCENTAGEM  ####
//
//  Cada caixa tem um peso, e a tela mostra ao lado a chance que
//  aquele peso REPRESENTA — calculada, e não digitada.
//
//  A alternativa era pedir porcentagem e exigir que somasse 100.
//  Ela erra de dois jeitos: somando 90 (e aí 10% do sorteio não é
//  nada), e obrigando a refazer as outras linhas toda vez que uma
//  caixa nova entra. Com peso, acrescentar `elite: 1` ao lado de
//  `normal: 9` não toca em nada — e a coluna da direita já diz
//  "10%".
//
//  ####  O CATÁLOGO É O MESMO DA MASMORRA  ####
//
//  `DUNGEON_CRATES` — as mesmas caixas, com os mesmos nomes. Duas
//  listas para a mesma pergunta divergiriam no primeiro update do
//  Rust, e o admin não tem como saber qual delas está certa.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';

import { DUNGEON_CRATES } from '@/components/dungeons/crate-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import type { KothReward } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface RewardFieldsProps {
  readonly value: KothReward;
  readonly onChange: (value: KothReward) => void;
}

/** A caixa oferecida quando o admin clica em "acrescentar". */
const FIRST_CRATE = 'assets/bundled/prefabs/radtown/crate_normal_2.prefab';

export function RewardFields({ value, onChange }: RewardFieldsProps) {
  const total = value.crates.reduce((sum, crate) => sum + crate.weight, 0);

  function patch(change: Partial<KothReward>): void {
    onChange({ ...value, ...change });
  }

  return (
    <div className="space-y-3">
      <div>
        <h4 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          O que nasce no fim
        </h4>
        <p className="mt-0.5 text-2xs text-muted">
          Quando alguém conquista o território, a bandeira cai e isto aparece no lugar dela. Um
          evento que <strong className="text-foreground">expira sem vencedor</strong> não deixa
          nada.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Toggle
          on={value.smoke}
          busy={false}
          onChange={(smoke) => patch({ smoke })}
          labels={['com fumaça', 'sem fumaça']}
          label="Sobe fumaça no fim?"
        />

        <Toggle
          on={value.flare}
          busy={false}
          onChange={(flare) => patch({ flare })}
          labels={['com flare', 'sem flare']}
          label="Sobe um flare vermelho no fim?"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Quantas caixas
          </span>
          <Input
            type="number"
            min={0}
            max={10}
            value={String(value.count)}
            className="mt-1 h-9"
            onChange={(event) => {
              const count = Number(event.target.value);

              if (Number.isInteger(count)) patch({ count: Math.max(0, Math.min(10, count)) });
            }}
          />
          <span className="mt-1 block text-2xs text-muted">Zero = o evento não deixa caixa.</span>
        </label>

        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            A caixa some em (min)
          </span>
          <Input
            type="number"
            min={0}
            max={1440}
            value={String(Math.round(value.crateSeconds / 60))}
            className="mt-1 h-9"
            onChange={(event) => {
              const minutes = Number(event.target.value);

              if (Number.isFinite(minutes)) {
                patch({ crateSeconds: Math.max(0, Math.min(1440, Math.round(minutes))) * 60 });
              }
            }}
          />
          {/* Zero é legítimo e perigoso: vale dizer o que ele faz. */}
          <span className="mt-1 block text-2xs text-muted">
            {value.crateSeconds === 0
              ? 'Zero = ela fica no mapa até alguém abrir.'
              : 'Saqueada, ela some na hora — isso o jogo já faz.'}
          </span>
        </label>
      </div>

      {/* ####  AS CAIXAS  #### */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Tipos de caixa e o peso de cada um
          </span>
          <span className="text-2xs text-muted">
            {value.crates.length === 0
              ? 'Sem nenhuma, nasce a caixa militar comum.'
              : `${String(value.crates.length)} tipo(s) no sorteio`}
          </span>
        </div>

        {value.crates.map((crate, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <select
                value={crate.prefab}
                onChange={(event) => {
                  const crates = [...value.crates];

                  crates[index] = { ...crate, prefab: event.target.value };
                  patch({ crates });
                }}
                className="h-9 w-full border border-border bg-background px-2 text-sm"
              >
                {DUNGEON_CRATES.some((entry) => entry.prefab === crate.prefab) ? null : (
                  // Um prefab que não está no catálogo continua
                  // válido: o campo é oferta, não trava.
                  <option value={crate.prefab}>{crate.prefab}</option>
                )}
                {DUNGEON_CRATES.map((entry) => (
                  <option key={entry.prefab} value={entry.prefab}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="w-20">
              <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                Peso
              </span>
              <Input
                type="number"
                min={0}
                max={1000}
                value={String(crate.weight)}
                className="mt-1 h-9"
                onChange={(event) => {
                  const weight = Number(event.target.value);

                  if (!Number.isFinite(weight)) return;

                  const crates = [...value.crates];

                  crates[index] = { ...crate, weight: Math.max(0, Math.min(1000, weight)) };
                  patch({ crates });
                }}
              />
            </label>

            {/* A chance é CALCULADA. É o número que o admin queria
                escrever, sem a obrigação de somar 100. */}
            <span
              className={cn(
                'w-14 pb-2 text-right font-condensed text-sm',
                crate.weight === 0 ? 'text-muted' : 'text-foreground',
              )}
            >
              {total === 0 ? '—' : `${String(Math.round((crate.weight / total) * 100))}%`}
            </span>

            <Button
              size="sm"
              variant="outline"
              className="mb-0.5"
              onClick={() => patch({ crates: value.crates.filter((_, other) => other !== index) })}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}

        <Button
          size="sm"
          variant="outline"
          disabled={value.crates.length >= 20}
          onClick={() => patch({ crates: [...value.crates, { prefab: FIRST_CRATE, weight: 1 }] })}
        >
          <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Acrescentar tipo
        </Button>
      </div>
    </div>
  );
}
