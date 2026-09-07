'use client';

// ============================================================
//  loot-rule-dialog.tsx  -  criar e editar uma regra de loot.
//
//  ####  ELA SÓ ACRESCENTA  ####
//
//  Não existe "tirar item" nem "esvaziar caixa" nesta tela, e isso
//  é decisão, não falta de tempo: uma regra que ACRESCENTA e chega
//  atrasada no boot do wipe erra para MENOS — cai menos coisa no
//  primeiro minuto, e mais nada. Uma que remove, chegando tarde,
//  distribui o que devia ter sumido, sem sintoma nenhum
//  (Docs/CustomItem/05 §10.1).
//
//  ####  E O ITEM É SEMPRE NOSSO  ####
//
//  O seletor é o mesmo das outras quatro telas, e ele lista os
//  dois mundos. Aqui, escolher um item do JOGO não serve: o item
//  nasceria sem marca, o plugin não o reconheceria como nosso e
//  ele não viraria ponto (05 §3.4). Em vez de esconder metade da
//  lista — o que faria a busca parecer quebrada, que é o defeito
//  que o próprio seletor existe para ter resolvido —, a escolha do
//  jogo é aceita no campo e recusada com a frase que diz por quê.
// ============================================================

import { useEffect, useMemo, useState } from 'react';

import { ChanceExplainer } from '@/components/loot/chance-explainer';
import { chanceFromOneIn, oneInFromChance, parseCount } from '@/components/loot/chance';
import { ContainerPicker } from '@/components/loot/container-picker';
import {
  EMPTY_RULE,
  ruleToInput,
  toSlug,
  whyNotReady,
} from '@/components/loot/rule-form';
import { CustomItemIcon } from '@/components/item-icon';
import { ItemCombobox } from '@/components/item-combobox';
import type { ItemChoice } from '@/components/item-choice';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  type LootContainerInfo,
  type LootRule,
  type LootRuleInput,
  type LootRuleMode,
} from '@/lib/api';
import { useCustomItems } from '@/lib/hooks/use-custom-items';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface LootRuleDialogProps {
  readonly open: boolean;
  /** `null` = criando. Preenchida = editando aquela regra. */
  readonly rule: LootRule | null;
  /** Campos já resolvidos de quem abriu a caixa (o contêiner clicado). */
  readonly preset?: Partial<LootRuleInput> | undefined;
  readonly containers: readonly LootContainerInfo[];
  readonly containersFromAgent: boolean;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  /** A suposição da tela para traduzir a chance. Não viaja com a regra. */
  readonly containersPerDay: number;
  readonly onContainersPerDayChange: (value: number) => void;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

export function LootRuleDialog({
  open,
  rule,
  preset,
  containers,
  containersFromAgent,
  servers,
  containersPerDay,
  onContainersPerDayChange,
  onClose,
  onSaved,
}: LootRuleDialogProps) {
  const [form, setForm] = useState<LootRuleInput>(EMPTY_RULE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** O id foi digitado à mão? Aí o nome para de reescrevê-lo. */
  const [idTouched, setIdTouched] = useState(false);
  /** O texto do seletor de item. É o shortname do CORPO, não o id. */
  const [itemText, setItemText] = useState('');
  /** O campo do item já foi preenchido nesta abertura? */
  const [itemResolved, setItemResolved] = useState(false);
  /** "1 em N", que é como se pensa em raridade. */
  const [oneInText, setOneInText] = useState('');

  const { items: customItems, error: customItemsError } = useCustomItems();

  const ourItem = useMemo(
    () => customItems.find((item) => item.id === form.customItemId) ?? null,
    [customItems, form.customItemId],
  );

  // Reabrir a caixa para OUTRA regra precisa recomeçar o
  // formulário: sem isto, editar a segunda mostraria os campos da
  // primeira até a primeira tecla.
  useEffect(() => {
    if (!open) return;

    setError(null);

    const next = rule === null ? { ...EMPTY_RULE, ...preset } : ruleToInput(rule);

    setForm(next);
    setIdTouched(rule !== null || preset?.id !== undefined);

    const oneIn = oneInFromChance(next.chance);

    setOneInText(oneIn === null ? '' : String(Math.round(oneIn)));
    setItemText('');
    setItemResolved(false);
  }, [open, rule, preset]);

  // ####  O CAMPO MOSTRA O CORPO, E O CADASTRO CHEGA DEPOIS  ####
  //
  // O seletor exibe o shortname do corpo emprestado, que só se
  // conhece depois de a lista de itens nossos responder — ela é
  // assíncrona e pode chegar depois de a caixa abrir. Sem este
  // segundo passo, reabrir uma regra deixaria o campo vazio, e o
  // seletor leria isso como "nenhum item escolhido".
  //
  // E ele acontece UMA VEZ por abertura: sem a trava, digitar
  // qualquer coisa desfaria a escolha anterior, o item nosso
  // sumiria, e este efeito apagaria o que estava sendo digitado —
  // tecla a tecla.
  useEffect(() => {
    if (!open || itemResolved || ourItem === null) return;

    setItemText(ourItem.baseShortname);
    setItemResolved(true);
  }, [open, itemResolved, ourItem]);

  const patch = (changes: Partial<LootRuleInput>): void => {
    setForm((current) => ({ ...current, ...changes }));
  };

  const editing = rule !== null;
  const problem = whyNotReady(form);

  const onItemChoice = (choice: ItemChoice | null): void => {
    // Item do jogo (ou texto solto) não vira regra: ver o
    // cabeçalho. O aviso embaixo do campo diz por quê.
    patch({ customItemId: choice?.customItem?.id ?? '' });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);

    try {
      if (editing) {
        await agent.updateLootRule(form.id, form);
        toast.success(`Regra "${form.label}" salva`);
      } else {
        await agent.createLootRule(form);
        toast.success(`Regra "${form.label}" criada`);
      }

      onSaved();
      onClose();
    } catch (cause) {
      // A frase é do CORE — ele sabe qual id já está tomado e qual
      // contêiner o plugin recusa. A nossa camada não sabe.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      busy={saving}
      onClose={onClose}
      // A largura vem em `w-` porque é a mesma propriedade que o
      // Dialog já define — um `max-w-*` não brigaria com ela.
      className="w-[min(58rem,94vw)]"
      title={editing ? `Editar "${rule.label}"` : 'Nova regra de loot'}
    >
      <div className="max-h-[72vh] space-y-5 overflow-y-auto px-1">
        {error !== null && <StateBlock variant="error" title="O agente recusou" detail={error} />}

        {/* ---- o que cai ---- */}
        <section className="space-y-3">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            O que cai
          </h3>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="loot-label">Nome da regra</Label>
              <Input
                id="loot-label"
                value={form.label}
                placeholder="Troféu na caixa de elite"
                onChange={(event) => {
                  const label = event.target.value;

                  patch(idTouched ? { label } : { label, id: toSlug(label) });
                }}
              />
              <p className="mt-1 text-2xs text-muted">
                É o nome na lista e na contagem. Diga o efeito, não o número.
              </p>
            </div>

            <div>
              <Label htmlFor="loot-id">Identificador</Label>
              <Input
                id="loot-id"
                value={form.id}
                disabled={editing}
                placeholder="trofeu-no-elite"
                onChange={(event) => {
                  setIdTouched(true);
                  patch({ id: event.target.value });
                }}
              />
              <p className="mt-1 text-2xs text-muted">
                {editing
                  ? 'O identificador não muda: é a chave que a contagem por dia usa.'
                  : 'Minúsculas, números e hífen. Nasce do nome.'}
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="loot-item">Item</Label>
            <ItemCombobox
              inputId="loot-item"
              value={itemText}
              onValueChange={(text) => {
                setItemText(text);
                // Digitou: o preenchimento automático não mexe mais
                // no campo até a caixa reabrir.
                setItemResolved(true);
              }}
              onChoiceChange={onItemChoice}
              describedById="loot-item-hint"
              placeholder="troféu, e outros itens nossos"
            />

            {ourItem !== null && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted">
                <CustomItemIcon
                  iconFile={ourItem.iconFile}
                  baseShortname={ourItem.baseShortname}
                  size="sm"
                />
                <strong className="text-foreground">{ourItem.displayName}</strong>
                <span>
                  corpo <span className="font-mono">{ourItem.baseShortname}</span> · marca{' '}
                  <span className="font-mono text-amber">{ourItem.skinId}</span>
                </span>
              </p>
            )}

            {/* ####  O ITEM DO JOGO É RECUSADO AQUI, COM O MOTIVO  ####

                Um `rifle.ak` cru no loot já existe — é o jogo que
                o põe. O que esta tela faz é pôr um item NOSSO, e
                ele só é nosso por causa da marca. */}
            {ourItem === null && itemText.trim() !== '' && (
              <p className="mt-1 text-2xs leading-relaxed text-amber">
                Esse não é um item nosso. O loot do jogo cria itens com marca zero, e um item sem
                marca o plugin não reconhece: ele não converte em ponto e não conta em ranking
                nenhum. Escolha um item do grupo <strong>nossos</strong> da lista.
              </p>
            )}

            <p id="loot-item-hint" className="mt-1 text-2xs text-muted">
              Só item nosso. Se o que você quer ainda não existe, cadastre-o em Itens → Nossos.
            </p>

            {customItemsError !== null && (
              <p className="mt-1 text-2xs text-amber">
                Não consegui ler os itens nossos: {customItemsError}
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="loot-amount-min">Quantidade mínima</Label>
              <Input
                id="loot-amount-min"
                type="number"
                min={1}
                value={String(form.amountMin)}
                onChange={(event) => {
                  const value = Number(event.target.value);

                  patch({
                    amountMin: Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1,
                  });
                }}
              />
            </div>

            <div>
              <Label htmlFor="loot-amount-max">Quantidade máxima</Label>
              <Input
                id="loot-amount-max"
                type="number"
                min={form.amountMin}
                value={String(form.amountMax)}
                onChange={(event) => {
                  const value = Number(event.target.value);

                  patch({
                    amountMax: Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1,
                  });
                }}
              />
              <p className="mt-1 text-2xs text-muted">
                Iguais = sempre a mesma quantidade. O sorteio da quantidade é por caixa que
                ganhou o item, não por dia.
              </p>
            </div>
          </div>
        </section>

        {/* ---- onde cai ---- */}
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Em quais contêineres
          </h3>

          <ContainerPicker
            containers={containers}
            fromAgent={containersFromAgent}
            selected={form.containers}
            disabled={saving}
            onChange={(next) => patch({ containers: next })}
          />

          {/* ####  A TELA NÃO MOSTRA O QUE O JOGO JÁ PÕE  ####

              É a decisão da Q2 do 05, e o custo dela precisa
              aparecer para quem está escolhendo, não só no
              documento: o admin acrescenta sem ver o que já está
              na caixa. Para `add` isso é tolerável — a nossa
              chance é sorteada por fora e não depende da tabela
              do jogo. */}
          <p className="text-2xs leading-relaxed text-muted">
            Esta tela <strong className="text-foreground">não mostra o que o jogo já põe</strong>{' '}
            dentro destas caixas — isso é a fatia seguinte. Para acrescentar não faz diferença: a
            chance daqui é sorteada por fora, sem mexer na tabela do jogo.
          </p>
        </section>

        {/* ---- com que frequência ---- */}
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Com que frequência
          </h3>

          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <Label htmlFor="loot-one-in">Chance, em "1 em quantas"</Label>
              <div className="flex items-center gap-2">
                <span className="shrink-0 font-condensed text-sm text-muted">1 em</span>
                <Input
                  id="loot-one-in"
                  type="text"
                  inputMode="numeric"
                  value={oneInText}
                  placeholder="5000"
                  onChange={(event) => {
                    const text = event.target.value;

                    setOneInText(text);

                    const parsed = parseCount(text);
                    const chance = chanceFromOneIn(parsed);

                    // Texto inválido vira chance zero, e o botão
                    // trava com a frase do `whyNotReady`. Guardar a
                    // chance anterior deixaria o campo dizendo uma
                    // coisa e a regra salvando outra.
                    patch({ chance: chance ?? 0 });
                  }}
                />
                <span className="shrink-0 text-2xs text-muted">caixas</span>
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Contado por caixa <strong>populada</strong>, e não por caixa aberta. Uma caixa que
                ninguém abre também sorteia — e a que refaz o loot sorteia de novo.
              </p>
            </div>

            <ChanceExplainer
              chance={form.chance > 0 ? form.chance : null}
              containersPerDay={containersPerDay}
              onContainersPerDayChange={onContainersPerDayChange}
              dailyCap={form.dailyCap}
              mode={form.mode}
              containerCount={form.containers.length}
            />
          </div>
        </section>

        {/* ---- medindo ou valendo ---- */}
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Medindo ou valendo
          </h3>

          <div className="grid gap-2 sm:grid-cols-2">
            <ModeCard
              mode="measuring"
              current={form.mode}
              onChoose={(mode) => patch({ mode })}
              title="Só medindo"
              lines={[
                'Não cria item nenhum.',
                'Conta quantas vezes teria disparado, por dia.',
                'É como se descobre a chance certa sem soltar nada no servidor.',
              ]}
            />

            <ModeCard
              mode="live"
              current={form.mode}
              onChoose={(mode) => patch({ mode })}
              title="Valendo"
              lines={[
                'O item cai de verdade na caixa.',
                'A contagem continua, agora com o que saiu.',
                'Vale só para caixa que nascer ou refizer o loot depois de salvar.',
              ]}
            />
          </div>
        </section>

        {/* ---- os freios ---- */}
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Os freios
          </h3>

          {/* ####  DOIS FREIOS PORQUE UM SÓ NÃO SEGURA  ####

              A chance é uma taxa por evento, e quem controla o
              número de eventos é quem joga: dobrar a rota de farm
              dobra a emissão. Um teto por dia devolve esse controle
              ao servidor. E o teto sozinho tem o defeito espelhado
              — vira prêmio de fuso horário —, que é o que a
              carência por jogador alivia (04 §6.1). */}
          <LimitField
            id="loot-daily-cap"
            label="Teto por dia"
            value={form.dailyCap}
            unit="por dia"
            // O 3 por dia é o valor de partida que o estudo
            // recomendou para o troféu (04 §6.4).
            startValue={3}
            onChange={(value) => patch({ dailyCap: value })}
            checkedHint="Passando disso, o servidor para de soltar até o dia virar."
            uncheckedHint="Sem teto: num dia de sorte, sai o que a chance mandar."
          />

          <LimitField
            id="loot-cooldown"
            label="Carência por jogador"
            value={form.playerCooldownHours}
            unit="horas"
            startValue={24}
            onChange={(value) => patch({ playerCooldownHours: value })}
            checkedHint="O mesmo jogador não acha outro nesse intervalo."
            uncheckedHint="Sem carência: quem farma mais, acha mais."
          />
        </section>

        {/* ---- servidores ---- */}
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Em quais servidores
          </h3>

          {servers.length === 0 ? (
            <p className="text-2xs text-muted">Nenhum servidor cadastrado no agente.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {servers.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  onClick={() =>
                    patch({
                      servers: form.servers.includes(server.id)
                        ? form.servers.filter((entry) => entry !== server.id)
                        : [...form.servers, server.id],
                    })
                  }
                  className={cn(
                    'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                    form.servers.includes(server.id)
                      ? 'border-olive bg-olive/10 text-foreground'
                      : 'border-border text-muted hover:border-muted',
                  )}
                >
                  {server.name}
                </button>
              ))}
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-rust"
            />
            <span className="text-2xs leading-relaxed">
              <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
                Ligada
              </span>
              <span className="block text-muted">
                Desligada não é apagada: a regra fica no cadastro e para de ser sorteada.
              </span>
            </span>
          </label>
        </section>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        {/* O motivo fica visível o tempo todo, e não escondido
            atrás de um botão desabilitado sem explicação. */}
        <p className="text-2xs text-rust">{problem}</p>

        <div className="flex shrink-0 gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={saving || problem !== null}
            onClick={() => void save()}
          >
            {saving ? 'Salvando…' : editing ? 'Salvar' : 'Criar regra'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Um dos dois modos, com o que ele significa escrito no cartão. */
function ModeCard({
  mode,
  current,
  onChoose,
  title,
  lines,
}: {
  readonly mode: LootRuleMode;
  readonly current: LootRuleMode;
  readonly onChoose: (mode: LootRuleMode) => void;
  readonly title: string;
  readonly lines: readonly string[];
}) {
  const active = current === mode;

  return (
    <button
      type="button"
      onClick={() => onChoose(mode)}
      aria-pressed={active}
      className={cn(
        'border p-3 text-left',
        active ? 'border-amber bg-surface-2' : 'border-border hover:border-muted',
      )}
    >
      <span
        className={cn(
          'font-condensed text-sm font-bold uppercase tracking-wide',
          active ? 'text-amber' : 'text-foreground',
        )}
      >
        {title}
      </span>
      <ul className="mt-1 space-y-0.5 text-2xs leading-relaxed text-muted">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </button>
  );
}

/**
 * Um freio: a caixa liga, o número diz quanto.
 *
 * Desmarcado manda `null`, que é "sem teto" — e não zero, que o
 * agente leria como "nenhum por dia".
 */
function LimitField({
  id,
  label,
  value,
  unit,
  startValue,
  onChange,
  checkedHint,
  uncheckedHint,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  /** O que a caixa marcada põe no campo. */
  readonly startValue: number;
  readonly onChange: (value: number | null) => void;
  readonly checkedHint: string;
  readonly uncheckedHint: string;
}) {
  const on = value !== null;

  return (
    <div className="flex flex-wrap items-start gap-3">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onChange(event.target.checked ? startValue : null)}
          className="h-4 w-4 shrink-0 accent-rust"
        />
        <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
          {label}
        </span>
      </label>

      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          disabled={!on}
          value={value === null ? '' : String(value)}
          placeholder={String(startValue)}
          onChange={(event) => {
            const parsed = Number(event.target.value);

            onChange(Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null);
          }}
          className="h-8 w-24 text-2xs"
        />
        <span className="text-2xs text-muted">{unit}</span>
      </div>

      <p className="min-w-40 flex-1 text-2xs leading-relaxed text-muted">
        {on ? checkedHint : uncheckedHint}
      </p>
    </div>
  );
}
