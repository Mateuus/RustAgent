'use client';

// ============================================================
//  tab-settings.tsx  -  as chaves, a curva de XP, o retroativo e
//  o texto da temporada.
//
//  ####  O QUE NÃO ESTÁ AQUI, E POR QUÊ  ####
//
//  ONDE ELA VALE mora na aba Temporadas, com a rota própria que
//  troca só a lista de servidores. Dois lugares editando a mesma
//  coisa é como se apaga o que outra pessoa salvou no meio — e esta
//  tela manda a temporada INTEIRA no PUT.
//
//  O PREÇO do passe também não está aqui: quem vende é a loja, e o
//  produto é da frente C. Um campo de preço nesta tela pareceria
//  configurar a venda e não configuraria nada.
//
//  ####  DESLIGAR A FAIXA PAGA NO MEIO DO MÊS  ####
//
//  É a pergunta que o 01 §8 antecipa: alguém já comprou. Não dá
//  para simplesmente sumir com o que foi pago, e "o mínimo honesto é
//  a tela do admin avisar quantos jogadores compraram naquele mês
//  antes de deixar desligar". É o que a confirmação faz — ela conta
//  os donos em cada servidor onde a temporada vale, e diz quando
//  não conseguiu contar.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import {
  messageOf,
  periodLabel,
  safeOverview,
  xpToReach,
} from '@/components/battlepass/normalize';
import { SeasonPicker } from '@/components/battlepass/season-picker';
import { StateBadge } from '@/components/battlepass/state-badge';
import type { BattlePassServerOption } from '@/components/battlepass/server-choice';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, INPUT } from '@/components/ui/field';
import { HelpTip } from '@/components/ui/help-tip';
import { Toggle } from '@/components/ui/toggle';
import { BATTLEPASS_HELP } from '@/lib/help/battlepass';
import {
  agent,
  type BattlePassSeason,
  type BattlePassSeasonInput,
  type BattlePassXpCurve,
} from '@/lib/api';
import { formatInteger } from '@/lib/format';
import { toast } from '@/lib/toast';

/** Os três formatos da curva, em português. */
const CURVE_LABELS: Readonly<Record<BattlePassXpCurve['kind'], string>> = {
  flat: 'Tudo igual',
  linear: 'Crescente',
  table: 'Desenhada à mão',
};

export function TabSettings({
  seasons,
  season,
  servers,
  onPickSeason,
  onChanged,
}: {
  readonly seasons: readonly BattlePassSeason[];
  readonly season: BattlePassSeason | null;
  readonly servers: readonly BattlePassServerOption[];
  readonly onPickSeason: (seasonId: number) => void;
  readonly onChanged: () => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <SeasonPicker seasons={seasons} value={season?.id ?? null} onChange={onPickSeason} />

      {season !== null && (
        <SeasonForm
          // A temporada trocou (ou foi salva): o formulário renasce
          // com o que o agente devolveu, em vez de manter o rascunho
          // de outro mês na tela.
          key={`${String(season.id)}:${season.updatedAt}`}
          season={season}
          servers={servers}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function SeasonForm({
  season,
  servers,
  onChanged,
}: {
  readonly season: BattlePassSeason;
  readonly servers: readonly BattlePassServerOption[];
  readonly onChanged: () => Promise<void>;
}) {
  const [label, setLabel] = useState(season.label);
  const [description, setDescription] = useState(season.description ?? '');
  const [levels, setLevels] = useState(season.levels);
  const [curve, setCurve] = useState<BattlePassXpCurve>(season.xpCurve);
  const [freeLane, setFreeLane] = useState(season.freeLane);
  const [paidLane, setPaidLane] = useState(season.paidLane);
  const [retroactive, setRetroactive] = useState(season.retroactive);
  const [busy, setBusy] = useState(false);
  /** A confirmação de desligar a faixa paga, com a contagem dos donos. */
  const [closingPaid, setClosingPaid] = useState(false);

  const stepsNeeded = Math.max(0, levels - 1);
  const stepsGiven = curve.kind === 'table' ? curve.steps.length : stepsNeeded;
  const stepsWrong = curve.kind === 'table' && stepsGiven !== stepsNeeded;

  async function save(): Promise<void> {
    setBusy(true);

    const body: BattlePassSeasonInput = {
      period: season.period,
      label: label.trim(),
      levels,
      xpCurve: curve,
      freeLane,
      paidLane,
      retroactive,
      description: description.trim() === '' ? null : description.trim(),
      // ONDE ELA VALE não se edita aqui: vai como o agente a
      // devolveu, para este formulário não desfazer o que a aba
      // Temporadas acabou de marcar.
      servers: season.servers,
    };

    try {
      await agent.updateBattlePassSeason(season.id, body);
      toast.success(`Temporada de ${periodLabel(season.period)} salva`);
      await onChanged();
    } catch (cause) {
      toast.error('Não consegui salvar', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title={`Configuração · ${periodLabel(season.period)}`}
        aside={<StateBadge state={season.state} />}
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome" hint="É o que o jogador lê no cabeçalho do passe.">
              <input
                className={INPUT}
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>

            <Field label="Níveis" hint="Quantas casas a trilha tem.">
              <input
                type="number"
                min={1}
                max={200}
                className={INPUT}
                value={levels}
                onChange={(event) => setLevels(Number(event.target.value))}
              />
            </Field>
          </div>

          <Field label="Descrição" hint="O texto da tela de compra e do card. Em branco, nenhum.">
            <input
              className={INPUT}
              maxLength={280}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <div className="space-y-2 border-t border-border pt-3">
            <SwitchRow
              label="Faixa grátis"
              hint="Desligada, a trilha mostra só a faixa paga."
              on={freeLane}
              busy={busy}
              onChange={setFreeLane}
            />

            <SwitchRow
              label="Faixa paga"
              hint="Desligada, a trilha mostra só a grátis e o produto some da loja."
              on={paidLane}
              busy={busy}
              onChange={(value) => {
                // Desligar no meio do mês pede a conferência dos
                // donos; ligar de volta não pede nada.
                if (value) setPaidLane(true);
                else setClosingPaid(true);
              }}
            />

            <SwitchRow
              label="Compra retroativa"
              hint="Ligada, quem compra no nível 17 leva os 17 de uma vez."
              topic="retroactive"
              on={retroactive}
              busy={busy}
              onChange={setRetroactive}
            />

            {!freeLane && !paidLane && (
              <StateBlock
                variant="error"
                title="Com as duas faixas desligadas não sobra trilha."
                detail="O jogador abre o passe e não vê recompensa nenhuma. O XP continua sendo contado, e ninguém entende para quê."
              />
            )}

            <p className="text-2xs text-muted">
              A terceira chave do 01 §8 — <strong>o passe ligado neste servidor</strong> — é a lista
              “onde vale”, na aba Temporadas: uma temporada que não vale num servidor não aparece
              nele, e nenhum XP é contado lá.
            </p>
          </div>

          <div className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                A curva de XP
              </span>
              <HelpTip topic={BATTLEPASS_HELP.xpCurve} />
            </div>

            <CurveFields
              curve={curve}
              levels={levels}
              onChange={setCurve}
            />

            {stepsWrong && (
              <StateBlock
                variant="error"
                title={`A curva desenhada à mão precisa de ${String(stepsNeeded)} valores, e tem ${String(stepsGiven)}.`}
                detail="Um por degrau, a partir do segundo nível — o nível 1 é de graça. O agente recusa a gravação enquanto não bater."
              />
            )}

            <p className="text-xs text-muted">
              Do começo ao fim, a trilha custa{' '}
              <strong className="text-foreground">{formatInteger(xpToReach(curve, levels))} XP</strong>.
              O nível {formatInteger(Math.max(1, Math.ceil(levels / 2)))} exige{' '}
              {formatInteger(xpToReach(curve, Math.max(1, Math.ceil(levels / 2))))} XP acumulados.
              Quanto tempo isso leva está na aba Trilha, com os tetos diários da aba XP.
            </p>
          </div>

          <div className="flex justify-end">
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              Salvar a temporada
            </Button>
          </div>
        </div>
      </Section>

      {closingPaid && (
        <ClosePaidLaneDialog
          season={season}
          servers={servers}
          onClose={() => setClosingPaid(false)}
          onConfirm={() => {
            setPaidLane(false);
            setClosingPaid(false);
          }}
        />
      )}
    </>
  );
}

function SwitchRow({
  label,
  hint,
  topic,
  on,
  busy,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly topic?: 'retroactive';
  readonly on: boolean;
  readonly busy: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-surface-2 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
            {label}
          </span>
          {topic === 'retroactive' && <HelpTip topic={BATTLEPASS_HELP.retroactive} />}
        </div>
        <p className="text-2xs text-muted">{hint}</p>
      </div>

      <Toggle on={on} busy={busy} label={label} onChange={onChange} />
    </div>
  );
}

/** Os campos de cada formato de curva. */
function CurveFields({
  curve,
  levels,
  onChange,
}: {
  readonly curve: BattlePassXpCurve;
  readonly levels: number;
  readonly onChange: (curve: BattlePassXpCurve) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Formato">
        <select
          className={INPUT}
          value={curve.kind}
          onChange={(event) => {
            const kind = event.target.value as BattlePassXpCurve['kind'];

            // Trocar de formato não tenta converter a curva: os três
            // dizem coisas diferentes, e um "equivalente" inventado
            // aqui seria um número que ninguém escolheu.
            if (kind === 'flat') onChange({ kind: 'flat', perLevel: 1000 });
            else if (kind === 'linear') onChange({ kind: 'linear', base: 1000, step: 0 });
            else onChange({ kind: 'table', steps: Array.from({ length: Math.max(0, levels - 1) }, () => 1000) });
          }}
        >
          {(Object.keys(CURVE_LABELS) as BattlePassXpCurve['kind'][]).map((kind) => (
            <option key={kind} value={kind}>
              {CURVE_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>

      {curve.kind === 'flat' && (
        <Field label="XP por degrau" hint="Todo nível custa o mesmo.">
          <input
            type="number"
            min={1}
            className={INPUT}
            value={curve.perLevel}
            onChange={(event) => onChange({ kind: 'flat', perLevel: Number(event.target.value) })}
          />
        </Field>
      )}

      {curve.kind === 'linear' && (
        <>
          <Field label="Primeiro degrau" hint="Do nível 1 para o 2.">
            <input
              type="number"
              min={1}
              className={INPUT}
              value={curve.base}
              onChange={(event) =>
                onChange({ kind: 'linear', base: Number(event.target.value), step: curve.step })
              }
            />
          </Field>

          <Field label="Passo" hint="O que cada degrau seguinte soma ao anterior.">
            <input
              type="number"
              min={0}
              className={INPUT}
              value={curve.step}
              onChange={(event) =>
                onChange({ kind: 'linear', base: curve.base, step: Number(event.target.value) })
              }
            />
          </Field>
        </>
      )}

      {curve.kind === 'table' && (
        <div className="sm:col-span-2">
          <Field
            label="Um valor por degrau"
            hint={`Separados por espaço ou vírgula. Esta trilha precisa de ${String(Math.max(0, levels - 1))}.`}
          >
            <textarea
              rows={3}
              className={INPUT}
              value={curve.steps.join(' ')}
              onChange={(event) =>
                onChange({
                  kind: 'table',
                  steps: event.target.value
                    .split(/[\s,]+/)
                    .filter((piece) => piece !== '')
                    .map((piece) => Number(piece))
                    .map((value) => (Number.isFinite(value) ? Math.trunc(value) : 0)),
                })
              }
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * Quantos compraram, antes de deixar desligar.
 *
 * A contagem é SECUNDÁRIA: o servidor fora do ar, ou a rota
 * falhando, não pode impedir o admin de mexer na própria
 * configuração. O que ela não faz é fingir que o número é zero —
 * "não consegui contar" é uma resposta diferente de "ninguém
 * comprou", e as duas aparecem com essas palavras.
 */
function ClosePaidLaneDialog({
  season,
  servers,
  onClose,
  onConfirm,
}: {
  readonly season: BattlePassSeason;
  readonly servers: readonly BattlePassServerOption[];
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const [counts, setCounts] = useState<readonly { server: string; owners: number | null }[] | null>(
    null,
  );

  const load = useCallback(async () => {
    const rows = await Promise.all(
      season.servers.map(async (serverId) => {
        const name = servers.find((entry) => entry.id === serverId)?.name ?? serverId;

        try {
          const overview = safeOverview(await agent.battlePassOverview(serverId));

          return { server: name, owners: overview.owners };
        } catch {
          return { server: name, owners: null };
        }
      }),
    );

    setCounts(rows);
  }, [season.servers, servers]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (counts ?? []).reduce((sum, row) => sum + (row.owners ?? 0), 0);

  return (
    <ConfirmDialog
      open
      title="Desligar a faixa paga"
      confirmLabel="Desligar mesmo assim"
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p className="text-sm text-foreground">
        Desligada, a trilha mostra só a faixa grátis e o passe some da loja. Quem já comprou{' '}
        <strong>não perde o direito</strong> — mas deixa de ver o que pagou enquanto ela estiver
        desligada.
      </p>

      {counts === null ? (
        <StateBlock variant="loading" title="Contando quem comprou este mês…" />
      ) : counts.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Esta temporada não vale em servidor nenhum."
          detail="Não há compra para contar."
        />
      ) : (
        <div className="space-y-1 border border-border bg-surface-2 p-3 text-xs">
          <p className="text-foreground">
            {formatInteger(total)} jogador(es) compraram o passe de {periodLabel(season.period)}:
          </p>
          <ul className="text-muted">
            {counts.map((row) => (
              <li key={row.server}>
                {row.server}:{' '}
                {row.owners === null ? 'não consegui contar' : formatInteger(row.owners)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-2xs text-muted">
        A mudança só vale depois de salvar a temporada.
      </p>
    </ConfirmDialog>
  );
}
