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

import { Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { ContainerPicker } from '@/components/quests/container-picker';
import { RankingPicker } from '@/components/ranking/ranking-picker';
import { RequiresPicker } from '@/components/quests/requires-picker';
import { RewardAddMenu, RewardList } from '@/components/rewards/reward-list';
import { AddMenu, Field, INPUT } from '@/components/ui/field';
import { Section } from '@/components/section';
import {
  agent,
  type QuestDefinition,
  type QuestInput,
  type QuestObjective,
  type QuestObjectiveKind,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Os alvos de `kill`, pelo nome que o agente normaliza.
 *
 * ####  MEDIDOS CONTRA O JOGO, E NÃO CATALOGADOS  ####
 *
 * Em 15/09/2026 a sonda `ozprobe.types` percorreu o
 * `GameManifest.Current.entities` do server01 e perguntou ao próprio
 * Rust o que existe. Saiu daqui o `murderer`, que o jogo não tem
 * mais — quem sobrou no lugar dele é o `zombie`.
 *
 * Uma quest antiga apontando para `murderer` continua salva e
 * continua sem contar: ela já não contava, porque o alvo não existe.
 */
const KILL_TARGETS = [
  'player',
  'scientist',
  'zombie',
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
  // ####  OS DOIS SAQUES SAO PERGUNTAS DIFERENTES  ####
  //
  // O `loot` conta ITEM ("pegue 200 de scrap, de onde vier"), e o
  // rotulo dele dizia "Saquear de caixas" -- que e o que o
  // `container` faz. O dono procurou barril aqui dentro em
  // 14/09/2026 e nao achou, porque nunca esteve.
  loot: 'Pegar um item (de caixa ou do chao)',
  container: 'Saquear caixas e barris',
  deliver: 'Entregar a um NPC',
  playtime: 'Ficar online (minutos)',
  metric: 'Chegar a um número num ranking',
};


/** Um objetivo em branco, do tipo escolhido. */
function blankObjective(seq: number, kind: QuestObjectiveKind): QuestObjective {
  return {
    seq,
    kind,
    target: kind === 'playtime' || kind === 'metric' || kind === 'container' ? null : '',
    // ####  ELE NASCE COM UMA ESCOLHA, E NAO VAZIO  ####
    //
    // "Qualquer barril" e o caso do pedido ("Limpeza da Estrada"), e
    // um objetivo que nasce sem alvo nenhum e um objetivo que so
    // recusa no salvar -- depois de o admin ter escrito o resto.
    targets: kind === 'container' ? ['@barrel'] : null,
    metric: kind === 'metric' ? '' : null,
    item: null,
    amount: 1,
    label: null,
    consume: false,
  };
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
    // Aqui o numero conta CAIXA, e nao unidade -- por isso sem o
    // "de", que no `loot` acima quer dizer "vinte daquilo".
    case 'container':
      return `Saquear ${amount} ${describeTargets(objective.targets ?? [])}`;
    case 'deliver':
      // Sem item é o correio: o que se leva é figurado, e o que a
      // missão paga é o caminho. Ver o campo `item`.
      return objective.item === null || objective.item === ''
        ? `Entregar o pacote para ${target}`
        : `Entregar ${amount} ${objective.item} para ${target}`;
    case 'playtime':
      return `Ficar ${amount} minuto(s) online`;
    case 'metric':
      return `Chegar a ${amount} em ${objective.metric ?? '?'}`;
  }
}

/**
 * O resumo dos alvos do saque, para a frase de previa.
 *
 * A de verdade e montada pelo agente
 * (`describeContainerSelectors`), que conhece o nome bonito de cada
 * prefab; esta e a aproximacao do painel, pela mesma razao que a
 * previa do item mostra o shortname -- ver o cabecalho.
 */
function describeTargets(targets: readonly string[]): string {
  if (targets.length === 0) {
    return 'contêineres';
  }

  if (targets.length === 1) {
    const only = targets[0] ?? '';

    if (only === '@barrel') return 'barris';
    if (only === '@crate') return 'caixas';
    if (only === '@any') return 'contêineres';

    return only;
  }

  return `${targets.length} tipos de contêiner`;
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
    // ####  A UNICA CONFERENCIA QUE MORA AQUI  ####
    //
    // O zod da API recusaria isto de qualquer jeito, mas com
    // "Too small: expected array to have >=1 items" -- uma frase
    // que nao diz QUAL objetivo nem o que fazer. O resto continua
    // sendo respondido pela API, que e quem conhece as regras.
    const semAlvo = form.objectives.find(
      (objective) => objective.kind === 'container' && (objective.targets?.length ?? 0) === 0,
    );

    if (semAlvo !== undefined) {
      setError(
        `O objetivo ${semAlvo.seq + 1} é de saque e não tem contêiner nenhum escolhido.`,
      );

      return;
    }

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

                {/* ####  O SAQUE ESCOLHE UMA LISTA, E ELA NAO CABE NUMA COLUNA  #### */}
                {objective.kind === 'container' && (
                  <div className="mt-2">
                    <Field
                      label="Contêineres que contam"
                      hint="Todos os escolhidos somam no MESMO contador. Para exigir uma quantidade por tipo, acrescente um objetivo para cada um."
                    >
                      <ContainerPicker
                        value={objective.targets ?? []}
                        onChange={(targets) =>
                          patchObjective(form, patch, index, { targets })
                        }
                      />
                    </Field>
                  </div>
                )}

                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  {objective.kind === 'metric' ? (
                    /* Aqui a missão LÊ o ranking, e por isso a lista
                       é a inteira: "chegue a 1.000 de minério" é um
                       objetivo legítimo. Quem ESCREVE é a recompensa,
                       e lá a lista é outra. */
                    <Field label="Ranking do objetivo">
                      <RankingPicker
                        mode="read"
                        value={objective.metric ?? ''}
                        onChange={(metric) => patchObjective(form, patch, index, { metric })}
                      />
                    </Field>
                  ) : objective.kind === 'playtime' || objective.kind === 'container' ? null : (
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

                  {objective.kind === 'deliver' && (
                    // ####  O QUE ELE LEVA NA MOCHILA  ####
                    //
                    // Vazio é o correio de sempre: chegar ao boneco
                    // conclui. Com um item, a missão passa a cobrar
                    // a coisa — "consiga um cartão verde e entregue
                    // ao NPC", o pedido do dono em 13/09/2026.
                    <Field
                      label="Item a entregar"
                      hint="Vazio = só chegar ao NPC já conclui."
                    >
                      <ItemCombobox
                        value={objective.item ?? ''}
                        onValueChange={(shortname) =>
                          patchObjective(form, patch, index, { item: shortname || null })
                        }
                      />
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
              <RewardAddMenu
                value={form.rewards}
                onChange={(rewards) => patch({ rewards: [...rewards] })}
              />
            }
          >
            <RewardList
              value={form.rewards}
              onChange={(rewards) => patch({ rewards: [...rewards] })}
              emptyHint="Sem recompensa. É legítimo — existe missão que só destrava a próxima da cadeia."
            />

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

              <Field label="Quem pode ver" hint="Vazio = todos veem.">
                {/* Os níveis vêm do cadastro de VIP. Digitado à mão,
                    um requisito que não casa com nada não dá erro: a
                    missão só não aparece para ninguém, para sempre. */}
                <RequiresPicker
                  value={form.requires}
                  onChange={(requires) => patch({ requires })}
                />
              </Field>

              <Field label="Quem oferece" hint="Vazio = aparece no menu para todos.">
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

              {/* ####  DAR E RECEBER PODEM SER PESSOAS DIFERENTES  ####

                  Vazio = entrega onde pegou, que é como tudo o que já
                  existe se comporta. Preenchido, a missão vira uma
                  cadeia: "leve isto ao ferreiro do outro lado". */}
              <Field
                label="Quem recebe"
                hint="Vazio = no mesmo NPC que ofereceu (ou no menu)."
              >
                <select
                  className={INPUT}
                  value={form.turnInNpcId ?? ''}
                  onChange={(event) => patch({ turnInNpcId: event.target.value || null })}
                >
                  <option value="">(quem ofereceu)</option>
                  {npcs.map((npc) => (
                    <option key={npc.id} value={npc.id}>
                      {npc.name}
                    </option>
                  ))}
                </select>
                {form.turnInNpcId !== null && form.turnInNpcId !== form.npcId && (
                  <span className="mt-1 block text-2xs text-muted">
                    O jogador conclui e volta a este NPC para resgatar.
                  </span>
                )}
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
      turnInNpcId: null,
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
