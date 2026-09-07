'use client';

// ============================================================
//  quest-catalog.tsx  -  a lista de missões, e o que se faz nelas.
//
//  ####  APAGAR PEDE DOIS CLIQUES QUANDO HÁ GENTE NO MEIO  ####
//
//  A API recusa com `QUEST_IN_USE` e a contagem; a tela mostra a
//  frase dela e só então oferece o segundo clique. Apagar leva por
//  cascata o progresso de quem está fazendo — e quem clica precisa
//  ver quantos são antes de confirmar.
//
//  ####  A ORDEM VAI INTEIRA  ####
//
//  Subir e descer reescrevem o catálogo todo. Uma lista parcial é
//  recusada pela API: os ausentes ficariam com a posição cruzada, e
//  o defeito só apareceria na próxima abertura da tela.
// ============================================================

import { ArrowDown, ArrowUp, Copy, Pencil, Power, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { agent, type QuestDefinition } from '@/lib/api';
import { cn } from '@/lib/utils';

const REPEAT_LABEL: Readonly<Record<QuestDefinition['repeatMode'], string>> = {
  once: 'uma vez',
  cooldown: 'com espera',
  daily: 'diária',
  weekly: 'semanal',
};

export interface QuestCatalogProps {
  readonly quests: readonly QuestDefinition[];
  readonly npcNames: Readonly<Record<string, string>>;
  readonly onEdit: (quest: QuestDefinition) => void;
  readonly onChanged: () => void;
}

export function QuestCatalog({ quests, npcNames, onEdit, onChanged }: QuestCatalogProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A quest cuja remoção pede o segundo clique, e a frase da API. */
  const [confirming, setConfirming] = useState<{ id: string; message: string } | null>(null);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError(null);

    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove(quest: QuestDefinition) {
    setBusy(quest.id);
    setError(null);

    try {
      await agent.removeQuest(quest.id);
      onChanged();
    } catch (cause) {
      // A frase da API traz a contagem: "3 jogador(es) estão com
      // esta quest em andamento…". Reescrevê-la aqui perderia o
      // número, que é justamente o que decide o clique.
      setConfirming({ id: quest.id, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }

  function move(id: string, direction: -1 | 1) {
    const order = quests.map((quest) => quest.id);
    const from = order.indexOf(id);
    const to = from + direction;

    if (from < 0 || to < 0 || to >= order.length) {
      return;
    }

    // A troca acontece na lista INTEIRA, e é ela que sobe. Ver o
    // cabeçalho.
    [order[from], order[to]] = [order[to] as string, order[from] as string];

    void run(id, () => agent.reorderQuests(order));
  }

  if (quests.length === 0) {
    return (
      <p className="border border-border bg-surface p-6 text-center text-xs text-muted">
        Nenhuma missão cadastrada ainda. O módulo nasce vazio de propósito — uma missão de exemplo
        apareceria no jogo, para jogadores de verdade, no minuto seguinte.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error !== null && (
        <p className="rounded border border-rust/40 bg-rust/10 px-3 py-2 text-2xs text-rust">
          {error}
        </p>
      )}

      {quests.map((quest, index) => (
        <div
          key={quest.id}
          className={cn(
            'border border-border bg-surface p-3',
            !quest.enabled && 'opacity-60',
            busy === quest.id && 'animate-pulse',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded bg-background px-1.5 py-0.5 font-condensed text-2xs uppercase tracking-wide text-muted">
                  {quest.category}
                </span>
                <h3 className="truncate font-condensed text-sm font-bold">{quest.title}</h3>
                {!quest.enabled && (
                  <span className="text-2xs uppercase tracking-wide text-muted">desligada</span>
                )}
              </div>

              <p className="mt-1 text-2xs text-muted">
                {quest.objectives
                  .map((objective) =>
                    objective.kind === 'playtime'
                      ? `${String(objective.amount)} min online`
                      : `${objective.kind} · ${String(objective.amount)} ${objective.target ?? objective.metric ?? ''}`,
                  )
                  .join('  +  ')}
              </p>

              <p className="mt-1 flex flex-wrap gap-x-3 text-2xs text-muted">
                <span>⟳ {REPEAT_LABEL[quest.repeatMode]}</span>
                {quest.npcId !== null && <span>🧍 {npcNames[quest.npcId] ?? quest.npcId}</span>}
                {quest.requiresQuest !== null && <span>▸ exige: {quest.requiresQuest}</span>}
                {quest.requires !== null && <span>🔒 {quest.requires}</span>}
                {quest.servers.length > 0 && <span>◈ {quest.servers.join(', ')}</span>}
                {quest.rewards.length > 0 && (
                  <span className="text-rust">
                    🎁 {quest.rewards.map((reward) => reward.kind).join(' + ')}
                  </span>
                )}
              </p>
            </div>

            <div className="flex shrink-0 gap-1">
              <IconButton
                label="Subir"
                disabled={index === 0}
                onClick={() => move(quest.id, -1)}
                Icon={ArrowUp}
              />
              <IconButton
                label="Descer"
                disabled={index === quests.length - 1}
                onClick={() => move(quest.id, 1)}
                Icon={ArrowDown}
              />
              <IconButton
                label={quest.enabled ? 'Desligar' : 'Ligar'}
                onClick={() =>
                  void run(quest.id, () =>
                    agent.updateQuest(quest.id, { ...toInput(quest), enabled: !quest.enabled }),
                  )
                }
                Icon={Power}
              />
              <IconButton
                label="Duplicar"
                onClick={() => void run(quest.id, () => agent.duplicateQuest(quest.id))}
                Icon={Copy}
              />
              <IconButton label="Editar" onClick={() => onEdit(quest)} Icon={Pencil} />
              <IconButton label="Apagar" onClick={() => void remove(quest)} Icon={Trash2} danger />
            </div>
          </div>

          {confirming?.id === quest.id && (
            <div className="mt-3 rounded border border-rust/40 bg-rust/10 p-3">
              <p className="text-2xs text-rust">{confirming.message}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="rounded border border-border px-3 py-1 text-2xs uppercase tracking-wide"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(null);
                    void run(quest.id, () => agent.removeQuest(quest.id, true));
                  }}
                  className="rounded bg-rust px-3 py-1 text-2xs uppercase tracking-wide text-white"
                >
                  Apagar mesmo assim
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  Icon,
  disabled,
  danger,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly Icon: typeof Pencil;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded border border-border p-1.5 text-muted hover:text-foreground disabled:opacity-30',
        danger === true && 'hover:text-rust',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** A quest vira corpo de escrita: a API não recebe os campos que gera. */
function toInput(quest: QuestDefinition) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = quest;

  return input;
}
