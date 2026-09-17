'use client';

// ============================================================
//  reward-list.tsx  -  o que uma coisa DÁ, editado num lugar só.
//
//  ####  POR QUE ELE SAIU DO DIÁLOGO DE MISSÕES  ####
//
//  Ele nasceu lá dentro, quando só as missões pagavam alguma coisa.
//  O KOTH passou a pagar também — e o agente já entrega os dois
//  pelo mesmo caminho (`QuestRewardService`, que não entrega nada:
//  traduz para a loja, a carteira, os kits e o ranking).
//
//  Copiar estes campos para o formulário do território daria duas
//  telas para a mesma pergunta, e elas divergiriam no primeiro
//  tipo novo: a que ficasse para trás ofereceria menos, sem avisar
//  ninguém.
//
//  ####  O `perMeter` CONTINUA SENDO DA MISSÃO  ####
//
//  O OZCoin por metro percorrido só faz sentido numa entrega entre
//  dois NPCs. Ele não é oferecido aqui, e o campo nasce `null` —
//  mas o TIPO continua o mesmo, porque é o mesmo contrato que o
//  agente lê dos dois lados.
// ============================================================

import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { RewardItemField } from '@/components/quests/reward-item-field';
import { RankingPicker } from '@/components/ranking/ranking-picker';
import { RewardSkinField } from '@/components/rewards/reward-skin-field';
import { AddMenu, Field, INPUT } from '@/components/ui/field';
import type { QuestReward, QuestRewardKind } from '@/lib/api';

export const REWARD_LABELS: Readonly<Record<QuestRewardKind, string>> = {
  item: 'Item do jogo',
  coins: 'OZCoin',
  kit: 'Kit',
  points: 'Pontos de ranking',
  vip: 'VIP',
  skin: 'Skin do Workshop',
};

export function blankReward(kind: QuestRewardKind): QuestReward {
  switch (kind) {
    case 'item':
      return { kind, shortname: '', amount: 1, skinId: '0' };
    case 'coins':
      return { kind, amount: 100, perMeter: null, min: null, max: null };
    case 'kit':
      return { kind, slug: '' };
    case 'points':
      // ####  VAZIO, E NÃO UM PALPITE  ####
      //
      // O padrão era `quest.completed`, que parece o nome certo e
      // nunca existiu: quem não mexesse no campo salvava algo que
      // não teria como pagar. Vazio obriga a escolher — e o seletor
      // só oferece rankings que existem.
      return { kind, metric: '', amount: 1 };
    case 'vip':
      return { kind, tier: 'ouro', days: 7 };
    case 'skin':
      // ####  SEM SKIN, E PARA SEMPRE  ####
      //
      // A marca nasce vazia pelo mesmo motivo do ranking: não há
      // palpite honesto para "qual skin". O prazo nasce nulo porque
      // é o caso normal — é assim que o site a vende, e quem quiser
      // que ela vença escreve quantos dias.
      return { kind, shortname: '', skinId: '', days: null };
  }
}

export interface RewardListProps {
  readonly value: readonly QuestReward[];
  readonly onChange: (rewards: readonly QuestReward[]) => void;
  /** O que a tela diz quando não há nenhuma. */
  readonly emptyHint: string;
}

export function RewardList({ value, onChange, emptyHint }: RewardListProps) {
  return (
    <>
      {value.length === 0 && <p className="text-2xs text-muted">{emptyHint}</p>}

      {value.map((reward, index) => (
        <div key={index} className="flex items-end gap-3 rounded border border-border p-3">
          <span className="w-28 shrink-0 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            {REWARD_LABELS[reward.kind]}
          </span>

          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            {rewardFields(reward, (changes) =>
              onChange(
                value.map((item, position) =>
                  position === index ? ({ ...item, ...changes } as QuestReward) : item,
                ),
              ),
            )}
          </div>

          <button
            type="button"
            aria-label="Remover recompensa"
            onClick={() => onChange(value.filter((_, position) => position !== index))}
            className="text-muted hover:text-rust"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </>
  );
}

/** O `+` desta lista. Fica no cabeçalho da seção, não no corpo. */
export function RewardAddMenu({
  value,
  onChange,
  max = 8,
}: {
  readonly value: readonly QuestReward[];
  readonly onChange: (rewards: readonly QuestReward[]) => void;
  readonly max?: number;
}) {
  if (value.length >= max) {
    return <span className="text-2xs text-muted">no máximo {max}</span>;
  }

  return (
    <AddMenu
      labels={REWARD_LABELS}
      onPick={(kind) => onChange([...value, blankReward(kind)])}
    />
  );
}

/** Os campos de cada tipo de recompensa. */
export function rewardFields(
  reward: QuestReward,
  patch: (changes: Partial<QuestReward>) => void,
): ReactNode {
  switch (reward.kind) {
    case 'item':
      return (
        <>
          <Field label="Item">
            {/* Escolhido, o campo vira o ITEM: ícone, nome e
                shortname, com um botão de trocar. A caixa de busca
                sozinha obrigava o admin a conferir a recompensa pelo
                texto que ele mesmo tinha digitado. */}
            <RewardItemField
              shortname={reward.shortname}
              skinId={reward.skinId}
              onChange={(choice) => patch(choice as Partial<QuestReward>)}
            />
          </Field>
          <Field label="Quantidade">
            <input
              type="number"
              min={1}
              className={INPUT}
              value={reward.amount}
              onChange={(event) => patch({ amount: Number(event.target.value) } as Partial<QuestReward>)}
            />
          </Field>
        </>
      );

    case 'coins':
      return (
        <Field label="OZCoin">
          <input
            type="number"
            min={0}
            className={INPUT}
            value={reward.amount ?? 0}
            onChange={(event) => patch({ amount: Number(event.target.value) } as Partial<QuestReward>)}
          />
        </Field>
      );

    case 'kit':
      return (
        <Field label="Slug do kit">
          <input
            className={INPUT}
            value={reward.slug}
            onChange={(event) => patch({ slug: event.target.value } as Partial<QuestReward>)}
          />
        </Field>
      );

    case 'points':
      return (
        <>
          {/* ####  ESCOLHER, E NÃO DIGITAR  ####

              O campo era texto livre. `quest.completed` — que parece
              o nome certo e não é ranking nenhum — salvou, o jogador
              concluiu a missão e os pontos viraram pendência. */}
          <Field label="Ranking que recebe os pontos">
            <RankingPicker
              mode="award"
              value={reward.metric}
              onChange={(metric) => patch({ metric } as Partial<QuestReward>)}
            />
          </Field>
          <Field label="Pontos">
            <input
              type="number"
              className={INPUT}
              value={reward.amount}
              onChange={(event) => patch({ amount: Number(event.target.value) } as Partial<QuestReward>)}
            />
          </Field>
        </>
      );

    case 'skin':
      return (
        <>
          {/* Fora do <Field>, que é um <label>: o seletor tem caixa
              de busca e uma lista de botões dentro, e um <label>
              em volta de tudo isso rouba o clique deles. */}
          <div className="sm:col-span-2">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Skin
            </span>
            <RewardSkinField
              shortname={reward.shortname}
              skinId={reward.skinId}
              onChange={(mark) => patch(mark as Partial<QuestReward>)}
            />
          </div>
          <Field label="Dias" hint="Vazio = para sempre.">
            <input
              type="number"
              min={1}
              className={INPUT}
              value={reward.days ?? ''}
              onChange={(event) =>
                patch({
                  days: event.target.value === '' ? null : Number(event.target.value),
                } as Partial<QuestReward>)
              }
            />
          </Field>
        </>
      );

    case 'vip':
      return (
        <>
          <Field label="Tier">
            <input
              className={INPUT}
              value={reward.tier}
              onChange={(event) => patch({ tier: event.target.value } as Partial<QuestReward>)}
            />
          </Field>
          <Field label="Dias" hint="Vazio = para sempre.">
            <input
              type="number"
              className={INPUT}
              value={reward.days ?? ''}
              onChange={(event) =>
                patch({
                  days: event.target.value === '' ? null : Number(event.target.value),
                } as Partial<QuestReward>)
              }
            />
          </Field>
        </>
      );
  }
}
