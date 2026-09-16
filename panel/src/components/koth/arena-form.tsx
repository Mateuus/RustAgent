'use client';

// ============================================================
//  arena-form.tsx  -  o formulário de um território.
//
//  ####  UM SÓ, PARA CRIAR E PARA EDITAR  ####
//
//  Criar e editar um território são a MESMA pergunta — "como é a
//  disputa neste lugar?" —, e a única diferença é de onde vêm os
//  valores iniciais. Dois formulários divergiriam no primeiro campo
//  novo, e o campo que faltasse num deles só apareceria no dia em
//  que alguém fosse editar.
//
//  ####  MINUTOS NA TELA, SEGUNDOS NO FIO  ####
//
//  O admin pensa em "15 minutos para dominar", não em 900. A
//  conversão mora AQUI, na borda: o contrato do agente é em
//  segundos, e um campo em minutos que gravasse minutos faria o
//  evento durar quinze segundos.
// ============================================================

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { RewardFields } from '@/components/koth/reward-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import type { KothArena, KothArenaInput, KothReward } from '@/lib/api';

export interface ArenaFormProps {
  /** Os valores iniciais. */
  readonly value: KothArenaInput;
  /** O território que está sendo editado, se houver. */
  readonly arena?: KothArena;
  readonly busy: boolean;
  readonly onSave: (value: KothArenaInput) => void;
  readonly onCancel: () => void;
}

/** O prêmio de um território que ainda não tem um. */
export function blankReward(): KothReward {
  return { smoke: true, flare: true, crates: [], count: 1, crateSeconds: 600 };
}

export function ArenaForm({ value, arena, busy, onSave, onCancel }: ArenaFormProps) {
  const [draft, setDraft] = useState<KothArenaInput>(value);

  function patch(change: Partial<KothArenaInput>): void {
    setDraft((current) => ({ ...current, ...change }));
  }

  const reward = draft.reward ?? blankReward();

  return (
    <section className="space-y-4 border border-border bg-surface p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-condensed text-sm font-bold uppercase tracking-wide">
          {arena === undefined ? 'Novo território' : draft.label}
        </h4>
        <span className="font-mono text-2xs text-muted">
          {Math.round(draft.x)}, {Math.round(draft.z)}
          {arena?.grid !== null && arena?.grid !== undefined && ` · ${arena.grid}`}
        </span>
      </header>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Nome</span>
        <Input
          value={draft.label}
          maxLength={60}
          placeholder="Colina do Norte"
          className="mt-1 h-9"
          onChange={(event) => patch({ label: event.target.value })}
        />
        <span className="mt-1 block text-2xs text-muted">
          É o nome que aparece no chat e no mapa do jogador.
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Raio (m)"
          hint="O círculo da captura. 30 m é uma encosta; 100 m é um monumento."
          value={draft.radius}
          min={5}
          max={200}
          onChange={(radius) => patch({ radius })}
        />
        <Field
          label="Altura (m)"
          hint="Do chão para cima. Sem ela, quem passa de helicóptero capturaria."
          value={draft.height}
          min={5}
          max={200}
          onChange={(height) => patch({ height })}
        />
        <Field
          label="Domínio para vencer (min)"
          hint="O padrão da casa é 15 minutos."
          value={Math.round(draft.captureSeconds / 60)}
          min={1}
          max={120}
          onChange={(minutes) => patch({ captureSeconds: minutes * 60 })}
        />
        <Field
          label="Duração máxima (min)"
          hint="Estourou sem ninguém capturar, o evento expira sem vencedor."
          value={Math.round(draft.durationSeconds / 60)}
          min={1}
          max={360}
          onChange={(minutes) => patch({ durationSeconds: minutes * 60 })}
        />
      </div>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Perde por segundo com a área vazia
        </span>
        <Input
          type="number"
          min={0}
          max={60}
          value={String(draft.decayPerSecond ?? 0)}
          className="mt-1 h-9 w-28"
          onChange={(event) => {
            const decay = Number(event.target.value);

            if (Number.isFinite(decay)) patch({ decayPerSecond: Math.max(0, Math.min(60, decay)) });
          }}
        />
        {/* Zero é o padrão do KOTH normal, e é uma decisão — não um
            campo esquecido. Ver Docs/KOTH/DECISOES-DO-DONO.md §7. */}
        <span className="mt-1 block max-w-lg text-2xs text-muted">
          {(draft.decayPerSecond ?? 0) === 0
            ? 'Zero: o que foi conquistado fica. Quem chega continua de onde o outro parou, e quem fecha os 100% vence.'
            : 'A barra volta a cair quando ninguém está na área.'}
        </span>
      </label>

      <div className="border-t border-border pt-3">
        <RewardFields value={reward} onChange={(next) => patch({ reward: next })} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <Toggle
          on={draft.enabled ?? true}
          busy={false}
          onChange={(enabled) => patch({ enabled })}
          labels={['no sorteio', 'fora do sorteio']}
          label="Este território entra no sorteio?"
        />

        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || draft.label.trim() === ''}
            onClick={() => onSave({ ...draft, label: draft.label.trim(), reward })}
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {arena === undefined ? 'Cadastrar' : 'Salvar'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={String(value)}
        className="mt-1 h-9"
        onChange={(event) => {
          const parsed = Number(event.target.value);

          if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, Math.round(parsed))));
        }}
      />
      <span className="mt-1 block text-2xs text-muted">{hint}</span>
    </label>
  );
}
