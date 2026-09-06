'use client';

// ============================================================
//  ranking-dialog.tsx  -  criar e editar a DEFINIÇÃO de um
//  ranking.
//
//  ####  CRIAR UM RANKING NÃO É ESCREVER CÓDIGO  ####
//
//  É uma linha em `rankings`. Um ranking "fixo" (abates) e um
//  "dinâmico" (Troféu Bleik) diferem numa coluna só — `builtin` —,
//  e ela decide apenas se o botão de apagar aparece. Ver
//  Docs/Ranking/20 §1 e §3.1.
//
//  ####  A CAIXA MORA AQUI PORQUE DOIS LUGARES A ABREM  ####
//
//  O cadastro de rankings, e o cadastro de ITEM CUSTOM: quem está
//  criando o Troféu Bleik precisa criar o ranking sem sair do
//  formulário do item — sair perderia tudo o que já foi digitado.
// ============================================================

import { useEffect, useState } from 'react';

import {
  SOURCE_LABELS,
  VALUE_KIND_LABELS,
  WINDOW_HINTS,
  WINDOW_LABELS,
} from '@/components/ranking/labels';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  type RankingDefinition,
  type RankingDefinitionInput,
  type RankingDirection,
  type RankingPeriodKind,
  type RankingSource,
  type RankingValueKind,
} from '@/lib/api';
import { toast } from '@/lib/toast';

const SOURCES: readonly RankingSource[] = ['plugin', 'agent', 'item', 'computed'];
const VALUE_KINDS: readonly RankingValueKind[] = ['counter', 'record', 'ratio'];
const WINDOWS: readonly RankingPeriodKind[] = ['wipe', 'season', 'lifetime'];

/**
 * O primeiro ranking dinâmico do projeto, pronto para o dono criar.
 *
 * Ele é a demonstração de que o sistema funciona sem código novo —
 * e é o que o item custom "Troféu Bleik Store" aponta com a ação
 * `points`. Ver Docs/Ranking/20 §0.1.
 */
export const TROPHY_BLEIK_PRESET: RankingDefinitionInput = {
  id: 'trofeu-bleik',
  metric: 'trophy.bleik',
  label: 'Troféu Bleik Store',
  // "Troféu Bleik Store" não cabe na coluna do jogo. É o exemplo
  // que o campo existe para resolver.
  shortLabel: 'Bleik Store',
  unit: 'troféus',
  description: 'Cada troféu pego na loja vira ponto na temporada.',
  source: 'item',
  valueKind: 'counter',
  direction: 'desc',
  window: 'season',
  globalEligible: true,
  enabled: true,
  showInGame: true,
};

/** O que um ranking novo é, antes de alguém digitar nada. */
const EMPTY: RankingDefinitionInput = {
  id: '',
  metric: '',
  label: '',
  shortLabel: null,
  unit: null,
  description: null,
  source: 'item',
  valueKind: 'counter',
  direction: 'desc',
  window: 'season',
  globalEligible: true,
  enabled: true,
  showInGame: true,
};

/** O teto do `shortLabel` na API. Ver `rankingBody` em routes/rankings.ts. */
const SHORT_LABEL_MAX = 24;

/** A definição, na forma que o PUT quer de volta. */
export function rankingToInput(ranking: RankingDefinition): RankingDefinitionInput {
  return {
    id: ranking.id,
    metric: ranking.metric,
    label: ranking.label,
    shortLabel: ranking.shortLabel,
    unit: ranking.unit,
    description: ranking.description,
    source: ranking.source,
    valueKind: ranking.valueKind,
    direction: ranking.direction,
    window: ranking.window,
    globalEligible: ranking.globalEligible,
    enabled: ranking.enabled,
    showInGame: ranking.showInGame,
  };
}

/**
 * O rótulo vira id: "Troféu Bleik Store" → "trofeu-bleik-store".
 *
 * O id aparece na URL e é o que o site guarda, então ele nasce do
 * nome e para de acompanhá-lo depois do primeiro salvamento —
 * renomear um ranking não pode quebrar quem aponta para ele.
 */
function toSlug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface RankingDialogProps {
  readonly open: boolean;
  /** `null` = criando. Preenchido = editando aquele ranking. */
  readonly ranking: RankingDefinition | null;
  /** Campos já resolvidos de quem abriu a caixa (o atalho do troféu). */
  readonly preset?: Partial<RankingDefinitionInput> | undefined;
  readonly onClose: () => void;
  readonly onSaved: (ranking: RankingDefinition) => void;
}

export function RankingDialog({ open, ranking, preset, onClose, onSaved }: RankingDialogProps) {
  const [form, setForm] = useState<RankingDefinitionInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** O id foi digitado à mão? Aí o rótulo para de reescrevê-lo. */
  const [idTouched, setIdTouched] = useState(false);

  // Reabrir a caixa para OUTRO ranking precisa recomeçar o
  // formulário: sem isto, editar o B mostraria os campos do A até a
  // primeira tecla.
  useEffect(() => {
    if (!open) return;

    setError(null);

    if (ranking === null) {
      setForm({ ...EMPTY, ...preset });
      setIdTouched(preset?.id !== undefined);
      return;
    }

    setForm(rankingToInput(ranking));
    setIdTouched(true);
  }, [open, ranking, preset]);

  const patch = (changes: Partial<RankingDefinitionInput>): void => {
    setForm((current) => ({ ...current, ...changes }));
  };

  const editing = ranking !== null;
  const ready = form.label.trim() !== '' && form.metric.trim() !== '' && form.id.trim() !== '';

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);

    try {
      const response = editing
        ? await agent.updateRanking(form.id, form)
        : await agent.createRanking(form);

      toast.success(editing ? 'Ranking salvo' : `Ranking "${response.ranking.label}" criado`);
      onSaved(response.ranking);
      onClose();
    } catch (cause) {
      // A frase é do CORE — ela sabe qual métrica já está tomada e
      // qual ranking veio semeado. A nossa camada não sabe.
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
      title={editing ? `Editar ${ranking.label}` : 'Novo ranking'}
      className="w-[min(44rem,94vw)]"
    >
      <div className="space-y-3">
        {error !== null && (
          <StateBlock variant="error" title="O agente recusou" detail={error} />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="rk-label">Nome na tela</Label>
            <Input
              id="rk-label"
              value={form.label}
              placeholder="Troféu Bleik Store"
              onChange={(event) => {
                const label = event.target.value;

                patch(idTouched ? { label } : { label, id: toSlug(label) });
              }}
            />
            <p className="mt-1 text-2xs text-muted">
              É o nome no painel e no site — e também no jogo, se o campo ao lado ficar vazio.
            </p>
          </div>

          {/* ####  DOIS NOMES PORQUE SÃO DUAS LARGURAS  ####

              A coluna do menu do jogo é estreita, e um nome que
              não cabe lá aparece cortado no meio da palavra. Vazio
              não é "sem nome": é "use o de cima" — e quem resolve
              isso é o `gameLabelOf` do core, num lugar só. */}
          <div>
            <Label htmlFor="rk-short-label">Nome no jogo</Label>
            <Input
              id="rk-short-label"
              value={form.shortLabel ?? ''}
              maxLength={SHORT_LABEL_MAX}
              placeholder={form.label.trim() === '' ? 'Bleik Store' : form.label.trim()}
              onChange={(event) =>
                patch({ shortLabel: event.target.value === '' ? null : event.target.value })
              }
            />
            <p className="mt-1 text-2xs text-muted">
              A coluna do menu do jogo é estreita: &quot;Troféu Bleik Store&quot; cabe ali como
              &quot;Bleik Store&quot;. Vazio usa o nome da tela. No máximo{' '}
              {String(SHORT_LABEL_MAX)} caracteres.
            </p>
          </div>

          <div>
            <Label htmlFor="rk-metric">Métrica</Label>
            <Input
              id="rk-metric"
              value={form.metric}
              disabled={ranking?.builtin === true}
              placeholder="trophy.bleik"
              onChange={(event) => patch({ metric: event.target.value })}
            />
            <p className="mt-1 text-2xs text-muted">
              {ranking?.builtin === true
                ? 'Este ranking veio com o agente: a métrica não troca, senão o número já contado ficaria sob a métrica antiga.'
                : 'No formato familia.nome, em minúsculas. É a mesma string que o item custom aponta.'}
            </p>
          </div>

          <div>
            <Label htmlFor="rk-id">Identificador</Label>
            <Input
              id="rk-id"
              value={form.id}
              disabled={editing}
              placeholder="trofeu-bleik"
              onChange={(event) => {
                setIdTouched(true);
                patch({ id: event.target.value });
              }}
            />
            <p className="mt-1 text-2xs text-muted">
              {editing
                ? 'O identificador não muda: ele está na URL do painel e no que o site guardou.'
                : 'Minúsculas, números e hífen. Ele aparece na URL.'}
            </p>
          </div>

          <div>
            <Label htmlFor="rk-unit">Unidade</Label>
            <Input
              id="rk-unit"
              value={form.unit ?? ''}
              placeholder="troféus, abates, metros…"
              onChange={(event) =>
                patch({ unit: event.target.value === '' ? null : event.target.value })
              }
            />
            <p className="mt-1 text-2xs text-muted">
              Vazio quando o número não tem unidade — é o caso do K/D.
            </p>
          </div>
        </div>

        <div>
          <Label htmlFor="rk-description">O que o jogador precisa fazer</Label>
          <Input
            id="rk-description"
            value={form.description ?? ''}
            placeholder="Cada troféu pego na loja vira ponto na temporada."
            onChange={(event) =>
              patch({ description: event.target.value === '' ? null : event.target.value })
            }
          />
          <p className="mt-1 text-2xs text-muted">
            Aparece na tela do jogo e no site. É a frase que evita a pergunta no chat.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="rk-source">De onde vem o número</Label>
            <select
              id="rk-source"
              value={form.source}
              onChange={(event) => patch({ source: event.target.value as RankingSource })}
              className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              {SOURCES.map((source) => (
                <option key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="rk-value-kind">Como o valor se forma</Label>
            <select
              id="rk-value-kind"
              value={form.valueKind}
              onChange={(event) => patch({ valueKind: event.target.value as RankingValueKind })}
              className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              {VALUE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {VALUE_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="rk-window">Janela em que ele disputa</Label>
            <select
              id="rk-window"
              value={form.window}
              onChange={(event) => patch({ window: event.target.value as RankingPeriodKind })}
              className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              {WINDOWS.map((kind) => (
                <option key={kind} value={kind}>
                  {WINDOW_LABELS[kind]}
                </option>
              ))}
            </select>
            {/* A `window` é CONFIGURAÇÃO, e não definição: por isso
                ela é editável até nos rankings que vieram com o
                agente. */}
            <p className="mt-1 text-2xs text-muted">
              {WINDOW_HINTS[form.window]}. O número continua somando nas três janelas — isto diz
              qual delas a tela abre.
            </p>
          </div>

          <div>
            <Label htmlFor="rk-direction">Quem fica na frente</Label>
            <select
              id="rk-direction"
              value={form.direction}
              onChange={(event) => patch({ direction: event.target.value as RankingDirection })}
              className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              <option value="desc">O maior número</option>
              <option value="asc">O menor número</option>
            </select>
          </div>

        </div>

        {/*
          A ORDEM NÃO SE DIGITA AQUI, E ISSO É DE PROPÓSITO.

          Havia um campo de número neste formulário, e ele era um
          segundo jeito de fazer o que o arrasto já faz. O defeito
          não era teórico: a tela carrega o formulário com a ordem
          daquele instante, alguém arrasta as linhas, e o "Salvar"
          seguinte mandava de volta o número velho — desfazendo o
          arrasto sem ninguém ter tocado em ordem nenhuma.

          Agora o ranking novo entra no fim da lista, e a ordem se
          muda num lugar só.
        */}
        <p className="text-2xs text-muted">
          A ordem na lista se muda arrastando as linhas na aba Rankings. Um ranking novo entra no
          fim.
        </p>

        <div className="space-y-2 border border-border bg-surface-2 p-3">
          <CheckLine
            checked={form.globalEligible}
            onChange={(value) => patch({ globalEligible: value })}
            label="Soma entre servidores"
            hint="Desligue quando as taxas forem diferentes: somar um 1x com um 5x produz uma lista ordenada por em que servidor a pessoa jogou. É o caso do minério e do explosivo."
          />

          {/* ####  ESTE INTERRUPTOR NÃO É O DE BAIXO  ####

              Desligar tira o ranking de TODO lugar; isto o tira só
              do menu do jogo, onde o espaço é caro. Quem quer um
              ranking que continua valendo mas não merece uma aba
              na tela do jogador precisa dos dois separados —
              senão a única saída seria desligá-lo, e aí ele
              sumiria também do painel e do site. */}
          <CheckLine
            checked={form.showInGame}
            onChange={(value) => patch({ showInGame: value })}
            label="Mostrar no menu do jogo"
            hint="Desmarcado, ele sai da tela do jogo e CONTINUA no painel, no site e na contagem. Não confunda com desligar: desligado ele some de todo lugar."
          />

          <CheckLine
            checked={form.enabled}
            onChange={(value) => patch({ enabled: value })}
            label="Ligado"
            hint="Desligado não é apagado: o número continua contado, só sai das telas."
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={saving || !ready} onClick={() => void save()}>
            {saving ? 'Salvando…' : editing ? 'Salvar' : 'Criar ranking'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Uma caixa de marcar, com o motivo embaixo.
 *
 * Mesma escolha do cadastro de item custom: aqui os dois lados são
 * uma REGRA, e regra se lê de uma vez — marcada vale, desmarcada
 * não.
 */
function CheckLine({
  checked,
  onChange,
  label,
  hint,
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
  readonly hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-rust"
      />
      <span className="text-2xs leading-relaxed">
        <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
          {label}
        </span>
        <span className="block text-muted">{hint}</span>
      </span>
    </label>
  );
}
