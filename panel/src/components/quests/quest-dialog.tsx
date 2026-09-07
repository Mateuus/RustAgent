'use client';

// ============================================================
//  quest-dialog.tsx  -  criar e editar uma missão.
//
//  ####  QUATRO SEÇÕES, E A ORDEM DELAS É A DA PERGUNTA  ####
//
//    Identidade    o que é, e onde aparece
//    Objetivos     o que precisa ser feito
//    Recompensas   o que ela dá
//    Regras        quando volta, o que destrava, onde vale
//
//  ####  A PRÉ-VISUALIZAÇÃO DA FRASE É BARATA E SALVA O DIA  ####
//
//  O painel mostra, ao vivo, a linha que o jogador vai ler:
//  "Coletar 5.000 de sulfur.ore". É o que impede uma quest
//  cadastrada com o shortname errado chegar ao jogo — o admin vê a
//  frase e reconhece o engano antes de salvar.
//
//  A frase montada AQUI é uma aproximação: quem monta a de verdade
//  é o agente, que tem o catálogo do jogo e traduz `sulfur.ore` em
//  "Minério de Enxofre". Duplicar a tradução no painel seria uma
//  segunda verdade sobre o nome de um item.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §12.2.
// ============================================================

import { Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { Section } from '@/components/section';
import {
  agent,
  type QuestDefinition,
  type QuestInput,
  type QuestObjective,
  type QuestObjectiveKind,
  type QuestReward,
  type QuestRewardKind,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/** Os alvos de `kill`, como o Quests.cs os cataloga. */
const KILL_TARGETS = [
  'player',
  'scientist',
  'murderer',
  'scarecrow',
  'tunneldweller',
  'underwaterdweller',
  'bear',
  'polarbear',
  'boar',
  'wolf',
  'stag',
  'chicken',
  'horse',
  'tiger',
  'panther',
  'crocodile',
  'snake',
  'simpleshark',
  'bradleyapc',
  'patrolhelicopter',
  'autoturret_deployed',
] as const;

const OBJECTIVE_LABELS: Readonly<Record<QuestObjectiveKind, string>> = {
  kill: 'Matar',
  gather: 'Coletar (minerar/colher)',
  craft: 'Fabricar',
  loot: 'Saquear de caixas',
  deliver: 'Entregar a um NPC',
  playtime: 'Ficar online (minutos)',
  metric: 'Chegar a um número num ranking',
};

const REWARD_LABELS: Readonly<Record<QuestRewardKind, string>> = {
  item: 'Item do jogo',
  coins: 'OZCoin',
  kit: 'Kit',
  points: 'Pontos de ranking',
  vip: 'VIP',
};

/** Um objetivo em branco, do tipo escolhido. */
function blankObjective(seq: number, kind: QuestObjectiveKind): QuestObjective {
  return {
    seq,
    kind,
    target: kind === 'playtime' || kind === 'metric' ? null : '',
    metric: kind === 'metric' ? '' : null,
    amount: 1,
    label: null,
    consume: false,
  };
}

function blankReward(kind: QuestRewardKind): QuestReward {
  switch (kind) {
    case 'item':
      return { kind, shortname: '', amount: 1, skinId: '0' };
    case 'coins':
      return { kind, amount: 100, perMeter: null, min: null, max: null };
    case 'kit':
      return { kind, slug: '' };
    case 'points':
      return { kind, metric: 'quest.completed', amount: 1 };
    case 'vip':
      return { kind, tier: 'ouro', days: 7 };
  }
}

/**
 * A frase que o jogador vai ler, aproximada.
 *
 * Ver o cabeçalho: a de verdade é montada pelo agente, com o nome
 * bonito do catálogo do jogo.
 */
function previewOf(objective: QuestObjective): string {
  if (objective.label !== null && objective.label !== '') {
    return objective.label;
  }

  const amount = objective.amount.toLocaleString('pt-BR');
  const target = objective.target ?? '?';

  switch (objective.kind) {
    case 'kill':
      return `Matar ${amount} ${target}`;
    case 'gather':
      return `Coletar ${amount} de ${target}`;
    case 'craft':
      return `Fabricar ${amount} ${target}`;
    case 'loot':
      return `Saquear ${amount} de ${target}`;
    case 'deliver':
      return `Entregar o pacote para ${target}`;
    case 'playtime':
      return `Ficar ${amount} minuto(s) online`;
    case 'metric':
      return `Chegar a ${amount} em ${objective.metric ?? '?'}`;
  }
}

export interface QuestDialogProps {
  /** `null` = criar. */
  readonly quest: QuestDefinition | null;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly quests: readonly QuestDefinition[];
  readonly npcs: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

export function QuestDialog({ quest, servers, quests, npcs, onClose, onSaved }: QuestDialogProps) {
  const [form, setForm] = useState<QuestInput>(() => toInput(quest));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (changes: Partial<QuestInput>) => {
    setForm((current) => ({ ...current, ...changes }));
  };

  async function save() {
    setSaving(true);
    setError(null);

    try {
      if (quest === null) {
        await agent.createQuest(form);
      } else {
        await agent.updateQuest(quest.id, form);
      }

      onSaved();
      onClose();
    } catch (cause) {
      // A frase vem da API inteira: ela conhece a regra (o ciclo de
      // pré-requisitos, o NPC de outro servidor) e este ponto não.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <div className="w-full max-w-3xl rounded border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-condensed text-sm font-bold uppercase tracking-wide">
            {quest === null ? 'Nova missão' : `Editar: ${quest.title}`}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* ---- identidade ---- */}
          <Section title="Identidade">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Título">
                <input
                  className={INPUT}
                  value={form.title}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </Field>
              <Field label="Categoria" hint="Vira uma aba na tela e um filtro aqui.">
                <input
                  className={INPUT}
                  value={form.category}
                  onChange={(event) => patch({ category: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Descrição" hint="O que o jogador lê antes de aceitar.">
              <textarea
                className={cn(INPUT, 'h-16 resize-none')}
                value={form.description ?? ''}
                onChange={(event) => patch({ description: event.target.value || null })}
              />
            </Field>
          </Section>

          {/* ---- objetivos ---- */}
          <Section
            title="Objetivos"
            aside={
              <AddMenu
                labels={OBJECTIVE_LABELS}
                onPick={(kind) =>
                  patch({ objectives: [...form.objectives, blankObjective(form.objectives.length, kind)] })
                }
              />
            }
          >
            {form.objectives.length === 0 && (
              <p className="text-2xs text-muted">
                Uma missão sem objetivo não é uma missão: acrescente pelo menos um.
              </p>
            )}

            {form.objectives.map((objective, index) => (
              <div key={objective.seq} className="rounded border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                    {OBJECTIVE_LABELS[objective.kind]}
                  </span>
                  <button
                    type="button"
                    aria-label="Remover objetivo"
                    onClick={() =>
                      patch({
                        objectives: form.objectives
                          .filter((_, position) => position !== index)
                          // O `seq` é renumerado: dois objetivos com
                          // a mesma ordem colidem no UNIQUE da
                          // tabela, e a mensagem do SQLite não diz
                          // qual dos dois.
                          .map((item, position) => ({ ...item, seq: position })),
                      })
                    }
                    className="text-muted hover:text-rust"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  {objective.kind === 'metric' ? (
                    <Field label="Métrica do ranking">
                      <input
                        className={INPUT}
                        placeholder="pvp.kills"
                        value={objective.metric ?? ''}
                        onChange={(event) =>
                          patchObjective(form, patch, index, { metric: event.target.value })
                        }
                      />
                    </Field>
                  ) : objective.kind === 'playtime' ? null : (
                    <Field label={objective.kind === 'deliver' ? 'NPC de destino' : 'Alvo'}>
                      {objective.kind === 'kill' ? (
                        <select
                          className={INPUT}
                          value={objective.target ?? ''}
                          onChange={(event) =>
                            patchObjective(form, patch, index, { target: event.target.value })
                          }
                        >
                          <option value="">escolha…</option>
                          {KILL_TARGETS.map((target) => (
                            <option key={target} value={target}>
                              {target}
                            </option>
                          ))}
                        </select>
                      ) : objective.kind === 'deliver' ? (
                        <select
                          className={INPUT}
                          value={objective.target ?? ''}
                          onChange={(event) =>
                            patchObjective(form, patch, index, { target: event.target.value })
                          }
                        >
                          <option value="">escolha…</option>
                          {npcs.map((npc) => (
                            <option key={npc.id} value={npc.id}>
                              {npc.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        // ####  O ITEM SE ESCOLHE, NÃO SE DIGITA  ####
                        //
                        // Digitar `sulfur.ore` de cabeça erra — e o
                        // erro só aparece no jogo, com a missão que
                        // nunca progride. O combobox busca por nome
                        // ("enxofre", "sulfur") e devolve o
                        // shortname certo, com ícone.
                        <ItemCombobox
                          value={objective.target ?? ''}
                          onValueChange={(shortname) =>
                            patchObjective(form, patch, index, { target: shortname })
                          }
                        />
                      )}
                    </Field>
                  )}

                  <Field label={objective.kind === 'playtime' ? 'Minutos' : 'Quantidade'}>
                    <input
                      type="number"
                      min={1}
                      className={INPUT}
                      value={objective.amount}
                      onChange={(event) =>
                        patchObjective(form, patch, index, { amount: Number(event.target.value) })
                      }
                    />
                  </Field>

                  <Field label="Texto próprio" hint="Vazio = o agente monta.">
                    <input
                      className={INPUT}
                      value={objective.label ?? ''}
                      onChange={(event) =>
                        patchObjective(form, patch, index, { label: event.target.value || null })
                      }
                    />
                  </Field>
                </div>

                {(objective.kind === 'loot' || objective.kind === 'gather') && (
                  <label className="mt-2 flex items-center gap-2 text-2xs text-muted">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      checked={objective.consume}
                      onChange={(event) =>
                        patchObjective(form, patch, index, { consume: event.target.checked })
                      }
                    />
                    Tirar os itens do inventário no resgate
                  </label>
                )}

                {/* A frase que o jogador vai ler. Ver o cabeçalho. */}
                <p className="mt-2 border-t border-border pt-2 text-2xs text-muted">
                  No jogo: <span className="text-foreground">{previewOf(objective)}</span>
                </p>
              </div>
            ))}
          </Section>

          {/* ---- recompensas ---- */}
          <Section
            title="Recompensas"
            aside={
              <AddMenu
                labels={REWARD_LABELS}
                onPick={(kind) => patch({ rewards: [...form.rewards, blankReward(kind)] })}
              />
            }
          >
            {form.rewards.length === 0 && (
              <p className="text-2xs text-muted">
                Sem recompensa. É legítimo — existe missão que só destrava a próxima da cadeia.
              </p>
            )}

            {form.rewards.map((reward, index) => (
              <div key={index} className="flex items-end gap-3 rounded border border-border p-3">
                <span className="w-28 shrink-0 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                  {REWARD_LABELS[reward.kind]}
                </span>

                <div className="grid flex-1 gap-3 sm:grid-cols-2">
                  {rewardFields(reward, (changes) =>
                    patch({
                      rewards: form.rewards.map((item, position) =>
                        position === index ? ({ ...item, ...changes } as QuestReward) : item,
                      ),
                    }),
                  )}
                </div>

                <button
                  type="button"
                  aria-label="Remover recompensa"
                  onClick={() =>
                    patch({ rewards: form.rewards.filter((_, position) => position !== index) })
                  }
                  className="text-muted hover:text-rust"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </Section>

          {/* ---- regras ---- */}
          <Section title="Regras">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Repetição">
                <select
                  className={INPUT}
                  value={form.repeatMode}
                  onChange={(event) =>
                    patch({ repeatMode: event.target.value as QuestInput['repeatMode'] })
                  }
                >
                  <option value="once">Uma vez só</option>
                  <option value="cooldown">Repete depois de um tempo</option>
                  <option value="daily">Diária</option>
                  <option value="weekly">Semanal</option>
                </select>
              </Field>

              {form.repeatMode === 'cooldown' && (
                <Field label="Tempo até voltar (segundos)">
                  <input
                    type="number"
                    min={1}
                    className={INPUT}
                    value={form.cooldownSeconds}
                    onChange={(event) => patch({ cooldownSeconds: Number(event.target.value) })}
                  />
                </Field>
              )}

              <Field label="Só depois de concluir" hint="A cadeia: a missão anterior.">
                <select
                  className={INPUT}
                  value={form.requiresQuest ?? ''}
                  onChange={(event) => patch({ requiresQuest: event.target.value || null })}
                >
                  <option value="">(nenhuma)</option>
                  {quests
                    .filter((item) => item.id !== quest?.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                </select>
              </Field>

              <Field label="Quem pode ver" hint="`vip:ouro`, ou vazio para todos.">
                <input
                  className={INPUT}
                  value={form.requires ?? ''}
                  onChange={(event) => patch({ requires: event.target.value || null })}
                />
              </Field>

              <Field label="NPC" hint="Vazio = aparece no menu para todos.">
                <select
                  className={INPUT}
                  value={form.npcId ?? ''}
                  onChange={(event) => patch({ npcId: event.target.value || null })}
                >
                  <option value="">(no menu)</option>
                  {npcs.map((npc) => (
                    <option key={npc.id} value={npc.id}>
                      {npc.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="No wipe">
                <select
                  className={INPUT}
                  value={form.wipePolicy}
                  onChange={(event) =>
                    patch({ wipePolicy: event.target.value as QuestInput['wipePolicy'] })
                  }
                >
                  <option value="reset">Zera o progresso</option>
                  <option value="keep">Atravessa o wipe</option>
                </select>
              </Field>
            </div>

            <div className="mt-3 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-2xs text-muted">
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={form.enabled}
                  onChange={(event) => patch({ enabled: event.target.checked })}
                />
                Ligada
              </label>
              <label className="flex items-center gap-2 text-2xs text-muted">
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={form.autoAccept}
                  onChange={(event) => patch({ autoAccept: event.target.checked })}
                />
                Começa sozinha quando o jogador conecta
              </label>
            </div>

            <Field
              label="Servidores"
              hint="Nenhum marcado = vale em TODOS. É o caso da maioria."
            >
              <div className="flex flex-wrap gap-3">
                {servers.map((server) => (
                  <label key={server.id} className="flex items-center gap-2 text-2xs">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      checked={form.servers.includes(server.id)}
                      onChange={(event) =>
                        patch({
                          servers: event.target.checked
                            ? [...form.servers, server.id]
                            : form.servers.filter((id) => id !== server.id),
                        })
                      }
                    />
                    {server.name}
                  </label>
                ))}
              </div>
            </Field>
          </Section>

          {error !== null && (
            <p className="rounded border border-rust/40 bg-rust/10 px-3 py-2 text-2xs text-rust">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className={BUTTON}>
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className={cn(BUTTON, 'bg-rust text-white disabled:opacity-50')}
          >
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------

const INPUT =
  'w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground';
const BUTTON = 'rounded border border-border px-3 py-1.5 text-2xs uppercase tracking-wide';

/**
 * O checkbox do painel.
 *
 * `accent-rust` e o que troca o azul do sistema pela cor da casa —
 * e o tamanho fixo e o que impede ele de encolher dentro de um
 * flex. E o mesmo do `custom-item-dialog.tsx`; um checkbox nu aqui
 * ficaria com a cor do navegador, que nao e a de lugar nenhum
 * desta tela.
 */
const CHECKBOX = 'h-4 w-4 shrink-0 accent-rust';

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
    </label>
  );
}

/** O `+` que abre a lista de tipos. */
function AddMenu<K extends string>({
  labels,
  onPick,
}: {
  readonly labels: Readonly<Record<K, string>>;
  readonly onPick: (kind: K) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Acrescentar
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded border border-border bg-surface py-1">
          {(Object.keys(labels) as K[]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                onPick(kind);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-2xs hover:bg-background"
            >
              {labels[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function patchObjective(
  form: QuestInput,
  patch: (changes: Partial<QuestInput>) => void,
  index: number,
  changes: Partial<QuestObjective>,
): void {
  patch({
    objectives: form.objectives.map((item, position) =>
      position === index ? { ...item, ...changes } : item,
    ),
  });
}

/** Os campos de cada tipo de recompensa. */
function rewardFields(
  reward: QuestReward,
  patch: (changes: Partial<QuestReward>) => void,
): ReactNode {
  switch (reward.kind) {
    case 'item':
      return (
        <>
          <Field label="Item">
            {/* Mesma razão do alvo do objetivo: o shortname se
                escolhe com busca e ícone, não se digita de cabeça. */}
            <ItemCombobox
              value={reward.shortname}
              onValueChange={(shortname) =>
                patch({ shortname } as Partial<QuestReward>)
              }
              onChoiceChange={(choice) => {
                // ####  A SKIN VIAJA JUNTO COM O ITEM  ####
                //
                // Um item NOSSO é o par (shortname, skinId): entregar
                // o shortname sem a marca dá o item comum, sem nome e
                // sem ação. O combobox devolve os dois — e escutar
                // isto é o que o cabeçalho dele manda fazer.
                if (choice !== null) {
                  patch({ skinId: choice.skinId } as Partial<QuestReward>);
                }
              }}
            />
          </Field>
          <Field label="Quantidade">
            <input
              type="number"
              min={1}
              className={INPUT}
              value={reward.amount}
              onChange={(event) =>
                patch({ amount: Number(event.target.value) } as Partial<QuestReward>)
              }
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
            onChange={(event) =>
              patch({ amount: Number(event.target.value) } as Partial<QuestReward>)
            }
          />
        </Field>
      );
    case 'kit':
      return (
        <Field label="Slug do kit">
          <input
            className={INPUT}
            placeholder="starter"
            value={reward.slug}
            onChange={(event) => patch({ slug: event.target.value } as Partial<QuestReward>)}
          />
        </Field>
      );
    case 'points':
      return (
        <>
          <Field label="Métrica">
            <input
              className={INPUT}
              value={reward.metric}
              onChange={(event) => patch({ metric: event.target.value } as Partial<QuestReward>)}
            />
          </Field>
          <Field label="Pontos">
            <input
              type="number"
              min={1}
              className={INPUT}
              value={reward.amount}
              onChange={(event) =>
                patch({ amount: Number(event.target.value) } as Partial<QuestReward>)
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
          <Field label="Dias">
            <input
              type="number"
              min={1}
              className={INPUT}
              value={reward.days}
              onChange={(event) =>
                patch({ days: Number(event.target.value) } as Partial<QuestReward>)
              }
            />
          </Field>
        </>
      );
  }
}

/** A quest vira formulário. `null` = os padrões de uma nova. */
function toInput(quest: QuestDefinition | null): QuestInput {
  if (quest === null) {
    return {
      title: '',
      description: null,
      category: 'geral',
      enabled: true,
      sort: 0,
      requires: null,
      npcId: null,
      repeatMode: 'once',
      cooldownSeconds: 0,
      requiresQuest: null,
      availableFrom: null,
      availableTo: null,
      autoAccept: false,
      wipePolicy: 'reset',
      servers: [],
      objectives: [],
      rewards: [],
    };
  }

  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = quest;

  return input;
}
