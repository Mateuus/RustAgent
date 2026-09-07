'use client';

// ============================================================
//  quest-settings.tsx  -  o que muda POR SERVIDOR.
//
//  ####  ESTES QUATRO CAMPOS DECIDEM COISAS DE VERDADE  ####
//
//    Teto de missões  quantas o jogador pode ter em andamento
//    Ritmo            de quanto em quanto tempo o agente pergunta
//    Loot             o hook mais caro do jogo, ligado ou não
//    Virada           a hora em que a diária volta
//
//  ####  O `loot` É UMA VÁLVULA, E NÃO UMA PREFERÊNCIA  ####
//
//  `OnItemAddedToContainer` dispara para todo item que entra em
//  qualquer caixa do servidor. Desligá-lo faz as missões de saque
//  pararem de contar naquele servidor — e é a saída para quando o
//  `origemz.quest.diag` mostrar que ele não cabe ali.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §3.8.
// ============================================================

import { useState } from 'react';

import { Section } from '@/components/section';
import { agent, type QuestSettingsRow } from '@/lib/api';

const INPUT = 'w-24 rounded border border-border bg-background px-2 py-1.5 text-xs';
const CHECKBOX = 'h-4 w-4 shrink-0 accent-rust';

export function QuestSettingsPanel({
  settings,
  servers,
  onSaved,
}: {
  readonly settings: readonly QuestSettingsRow[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onSaved: () => void;
}) {
  return (
    <Section title="Configuração por servidor">
      <p className="mb-3 text-2xs text-muted">
        Cada servidor decide o próprio ritmo. Um servidor sem linha aqui usa os padrões — e é o
        caso da maioria.
      </p>

      <div className="space-y-2">
        {settings.map((row) => (
          <ServerRow
            key={row.serverId}
            row={row}
            name={servers.find((server) => server.id === row.serverId)?.name ?? row.serverId}
            onSaved={onSaved}
          />
        ))}
      </div>
    </Section>
  );
}

function ServerRow({
  row,
  name,
  onSaved,
}: {
  readonly row: QuestSettingsRow;
  readonly name: string;
  readonly onSaved: () => void;
}) {
  const [form, setForm] = useState(row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    form.maxActive !== row.maxActive ||
    form.enabled !== row.enabled ||
    form.flushSeconds !== row.flushSeconds ||
    form.lootEnabled !== row.lootEnabled ||
    form.resetAtMinute !== row.resetAtMinute;

  async function save() {
    setBusy(true);
    setError(null);

    try {
      await agent.saveQuestSettings(row.serverId, {
        maxActive: form.maxActive,
        enabled: form.enabled,
        flushSeconds: form.flushSeconds,
        lootEnabled: form.lootEnabled,
        resetAtMinute: form.resetAtMinute,
      });

      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-3">
      <div className="flex flex-wrap items-end gap-4">
        <span className="font-condensed text-xs font-bold">{name}</span>

        <label className="flex items-center gap-2 text-2xs text-muted">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />
          Missões ligadas
        </label>

        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Teto (0 = sem)
          </span>
          <input
            type="number"
            min={0}
            max={100}
            className={INPUT}
            value={form.maxActive}
            onChange={(event) => setForm({ ...form, maxActive: Number(event.target.value) })}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Ritmo (s)
          </span>
          <input
            type="number"
            min={15}
            max={3600}
            className={INPUT}
            value={form.flushSeconds}
            onChange={(event) => setForm({ ...form, flushSeconds: Number(event.target.value) })}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Virada (min)
          </span>
          <input
            type="number"
            min={0}
            max={1439}
            className={INPUT}
            value={form.resetAtMinute}
            onChange={(event) => setForm({ ...form, resetAtMinute: Number(event.target.value) })}
          />
        </label>

        <label className="flex items-center gap-2 text-2xs text-muted">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={form.lootEnabled}
            onChange={(event) => setForm({ ...form, lootEnabled: event.target.checked })}
          />
          Contar saque
        </label>

        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className="rounded border border-border px-3 py-1.5 text-2xs uppercase tracking-wide disabled:opacity-40"
        >
          {busy ? 'Salvando…' : 'Salvar'}
        </button>
      </div>

      {/* A frase só aparece quando o admin desliga: ligado é o
          padrão, e explicar o padrão é ruído. */}
      {!form.lootEnabled && (
        <p className="mt-2 text-2xs text-amber">
          Com o saque desligado, as missões de "saqueie N de X" param de contar neste servidor. É a
          saída para quando o hook não couber no orçamento dele.
        </p>
      )}

      {error !== null && <p className="mt-2 text-2xs text-rust">{error}</p>}
    </div>
  );
}
