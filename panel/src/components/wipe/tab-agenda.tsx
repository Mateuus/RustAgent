'use client';

// ============================================================
//  tab-agenda.tsx  -  "com que frequência, a partir de quando, e
//  o que já está marcado?"
//
//  Três coisas, nesta ordem: a CADÊNCIA (a regra), a GRADE DO MÊS
//  (o desenho dela) e a LISTA (as datas materializadas, uma a
//  uma, com o que dá para mexer em cada uma).
//
//  ####  A AGENDA É MATERIALIZADA, E POR ISSO SE EDITA  ####
//
//  Cada linha da lista é uma linha do banco, e não o resultado de
//  uma função rodando na hora — é o que permite adiar um wipe
//  específico sem mudar a cadência de todos os outros. Salvar a
//  configuração faz o agente reconciliar: ele recalcula o que a
//  regra prevê, preserva o que foi mexido à mão e nunca toca no
//  passado.
//
//  ####  DIAS DE CALENDÁRIO, NÃO 604800 SEGUNDOS  ####
//
//  "A cada 7 dias às 16:00" é uma repetição de calendário lida num
//  fuso IANA. A diferença aparece na semana em que o fuso muda de
//  offset: com segundos, o wipe deslizaria uma hora e ninguém
//  entenderia por quê. Por isso o horário é texto `HH:MM` MAIS a
//  zona, e não um instante com fuso embutido.
// ============================================================

import { CalendarPlus, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { CalendarMonth } from '@/components/wipe/calendar-month';
import {
  BP_POLICY_LABEL,
  BP_POLICY_SHORT,
  COLLISION_HINT,
  COLLISION_LABEL,
  KIND_LABEL,
  MAP_SOURCE_LABEL,
  STATUS_LABEL,
  formatShortMoment,
  fromDateField,
  fromDateTimeFields,
  isPending,
  sortByDate,
  toCalendarMarks,
  toDateField,
} from '@/components/wipe/labels';
import { formatCountdown, type AgentClock } from '@/components/wipe/use-agent-clock';
import type { BpPolicy, WipePlan, WipeSettings } from '@/lib/api';
import { BP_POLICIES, COLLISION_POLICIES } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Os atalhos de cadência.
 *
 * Não limitam nada — o campo aceita qualquer inteiro de 1 a 365.
 * Existem porque estes são os intervalos que servidor de Rust usa
 * de verdade, e clicar em "7" é mais rápido que digitá-lo.
 */
const CADENCE_SHORTCUTS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 15, 30];

/**
 * Sugestões de fuso, e só sugestões: o campo aceita qualquer nome
 * IANA.
 *
 * A lista completa tem centenas de entradas e mudaria a cada
 * atualização do navegador. Quem hospeda servidor de Rust
 * brasileiro usa uma destas — e quem não usa digita a dele.
 */
const TIME_ZONES: readonly string[] = [
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Fortaleza',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Noronha',
  'UTC',
];

const LEGEND = [
  { tone: 'olive', label: 'cadência' },
  { tone: 'rust', label: 'forçado' },
  { tone: 'amber', label: 'manual' },
  { tone: 'muted', label: 'cancelado, pulado ou já feito' },
] as const;

export interface TabAgendaProps {
  readonly settings: WipeSettings;
  readonly plans: readonly WipePlan[];
  readonly clock: AgentClock;
  readonly busy: boolean;
  readonly onSave: (settings: WipeSettings) => void;
  readonly onPostpone: (plan: WipePlan, hours: number) => void;
  readonly onSkip: (plan: WipePlan) => void;
  readonly onCreate: (input: {
    scheduledAt: number;
    bpPolicy: BpPolicy;
    note: string | null;
  }) => void;
}

export function TabAgenda({
  settings,
  plans,
  clock,
  busy,
  onSave,
  onPostpone,
  onSkip,
  onCreate,
}: TabAgendaProps) {
  const [draft, setDraft] = useState<WipeSettings>(settings);

  // Chegou configuração nova do agente (salvamos, ou outro admin
  // mexeu): o rascunho acompanha. Sem isto, a tela continuaria
  // mostrando um rascunho velho depois de recarregar.
  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  const marks = useMemo(() => toCalendarMarks(plans), [plans]);
  const ordered = useMemo(() => sortByDate(plans), [plans]);

  const cadence = draft.cadence;

  function patchCadence(patch: Partial<WipeSettings['cadence']>): void {
    setDraft((current) => ({ ...current, cadence: { ...current.cadence, ...patch } }));
  }

  return (
    <div className="space-y-4">
      <Section
        title="Cadência"
        aside={
          <Button
            size="sm"
            variant="confirm"
            disabled={busy || !dirty}
            onClick={() => {
              onSave(draft);
            }}
          >
            <Save aria-hidden="true" className="h-3.5 w-3.5" />
            {busy ? 'Salvando…' : 'Salvar'}
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                O servidor zera por vontade própria
              </p>
              <p className="mt-1 text-sm text-muted">
                {cadence.enabled
                  ? 'Além do forçado mensal, o agente marca os wipes da casa.'
                  : 'Desligada: só o wipe forçado da Facepunch aparece na agenda.'}
              </p>
            </div>

            <Toggle
              on={cadence.enabled}
              busy={busy}
              label="Cadência própria"
              labels={['Ligada', 'Desligada']}
              onChange={(value) => {
                patchCadence({ enabled: value });
              }}
            />
          </div>

          <fieldset
            disabled={!cadence.enabled}
            className={cn('space-y-4', !cadence.enabled && 'opacity-50')}
          >
            <div>
              <Label htmlFor="wipe-every-days">A cada quantos dias</Label>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {CADENCE_SHORTCUTS.map((days) => (
                  <Button
                    key={days}
                    size="sm"
                    variant={cadence.everyDays === days ? 'primary' : 'outline'}
                    onClick={() => {
                      patchCadence({ everyDays: days });
                    }}
                  >
                    {days}
                  </Button>
                ))}

                <Input
                  id="wipe-every-days"
                  type="number"
                  min={1}
                  max={365}
                  value={String(cadence.everyDays)}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);

                    if (Number.isInteger(parsed) && parsed > 0) {
                      patchCadence({ everyDays: parsed });
                    }
                  }}
                  className="ml-2 w-20"
                />
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                São dias de calendário: na semana em que o fuso muda de horário, o wipe continua
                no mesmo horário local.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="wipe-time">Horário</Label>
                <Input
                  id="wipe-time"
                  type="time"
                  value={cadence.timeOfDay}
                  onChange={(event) => {
                    patchCadence({ timeOfDay: event.target.value });
                  }}
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="wipe-timezone">Fuso</Label>
                <Input
                  id="wipe-timezone"
                  list="wipe-timezones"
                  value={cadence.timeZone}
                  placeholder="America/Sao_Paulo"
                  onChange={(event) => {
                    patchCadence({ timeZone: event.target.value.trim() });
                  }}
                  className="mt-1"
                />
                <datalist id="wipe-timezones">
                  {TIME_ZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                <p className="mt-1 text-2xs leading-relaxed text-muted">
                  Nome IANA. O horário ao lado é lido neste fuso; o agente guarda tudo em UTC.
                </p>
              </div>
            </div>

            <div>
              <Label htmlFor="wipe-anchor">Contando a partir de</Label>
              <Input
                id="wipe-anchor"
                type="date"
                value={toDateField(cadence.anchorAt)}
                onChange={(event) => {
                  const parsed = fromDateField(event.target.value);

                  if (parsed !== null) {
                    patchCadence({ anchorAt: parsed });
                  }
                }}
                className="mt-1 w-48"
              />
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                O marco zero da contagem. Só o dia importa — a hora vem do campo acima.
              </p>
            </div>

            <PolicyPicker
              name="bp-cadence"
              legend="Blueprints nos wipes da cadência"
              value={cadence.bpPolicy}
              onChange={(bpPolicy) => {
                patchCadence({ bpPolicy });
              }}
            />
          </fieldset>

          <div className="border-t border-border pt-4">
            <PolicyPicker
              name="bp-forced"
              legend="Blueprints no wipe forçado"
              value={draft.forced.bpPolicy}
              onChange={(bpPolicy) => {
                setDraft((current) => ({ ...current, forced: { bpPolicy } }));
              }}
            />
            <p className="mt-2 text-2xs leading-relaxed text-muted">
              A data dele não é escolha nossa. O padrão do próprio jogo é <strong>manter</strong>{' '}
              os blueprints: a Facepunch só os zera quando mexe no sistema de itens, uma ou duas
              vezes por ano.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Quando os dois caem juntos">
        <div className="space-y-2">
          {COLLISION_POLICIES.map((policy) => (
            <label key={policy} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="wipe-collision"
                className="mt-1"
                checked={draft.collision.policy === policy}
                onChange={() => {
                  setDraft((current) => ({
                    ...current,
                    collision: { ...current.collision, policy },
                  }));
                }}
              />
              <span>
                <span className="font-medium text-foreground">{COLLISION_LABEL[policy]}</span>
                <span className="block text-2xs leading-relaxed text-muted">
                  {COLLISION_HINT[policy]}
                </span>
              </span>
            </label>
          ))}

          {draft.collision.policy === 'absorb' && (
            <div className="pt-1">
              <Label htmlFor="wipe-window">Janela, em horas</Label>
              <Input
                id="wipe-window"
                type="number"
                min={0}
                max={168}
                value={String(draft.collision.windowHours)}
                onChange={(event) => {
                  const parsed = Number(event.target.value);

                  if (Number.isInteger(parsed) && parsed >= 0) {
                    setDraft((current) => ({
                      ...current,
                      collision: { ...current.collision, windowHours: parsed },
                    }));
                  }
                }}
                className="mt-1 w-24"
              />
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                O wipe absorvido continua na lista, marcado como cancelado: uma agenda com um
                buraco não explica por que terça não vai ter wipe.
              </p>
            </div>
          )}
        </div>
      </Section>

      {clock.now === null ? (
        <StateBlock
          variant="loading"
          title="Esperando o relógio do agente…"
          detail="A grade do mês marca o dia de hoje pelo relógio do agente, e não pelo do navegador."
        />
      ) : (
        <CalendarMonth marks={marks} today={clock.now} legend={LEGEND} />
      )}

      <Section
        title="O que já está marcado"
        aside={<span className="text-2xs tabular-nums text-muted">{ordered.length}</span>}
      >
        {ordered.length === 0 ? (
          <StateBlock
            variant="empty"
            title="Nada materializado ainda."
            detail="Salvar a cadência recalcula a agenda; o wipe forçado entra sozinho. Se já salvou e nada apareceu, o agente ainda não reconciliou este servidor."
          />
        ) : (
          <ul className="divide-y divide-border">
            {ordered.map((plan) => (
              <PlanRow
                key={plan.id}
                plan={plan}
                now={clock.now}
                busy={busy}
                onPostpone={onPostpone}
                onSkip={onSkip}
              />
            ))}
          </ul>
        )}
      </Section>

      <ManualWipe busy={busy} clock={clock} onCreate={onCreate} />
    </div>
  );
}

function PlanRow({
  plan,
  now,
  busy,
  onPostpone,
  onSkip,
}: {
  readonly plan: WipePlan;
  readonly now: number | null;
  readonly busy: boolean;
  readonly onPostpone: (plan: WipePlan, hours: number) => void;
  readonly onSkip: (plan: WipePlan) => void;
}) {
  const pending = isPending(plan);
  const remaining = now === null ? null : plan.scheduledAt - now;
  const future = pending && remaining !== null && remaining > 0;

  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 py-2', !pending && 'opacity-60')}>
      <span
        className={cn(
          'font-medium tabular-nums text-foreground',
          !pending && 'line-through decoration-rust',
        )}
      >
        {formatShortMoment(plan.scheduledAt)}
      </span>

      <Tag tone={plan.kind === 'forced' ? 'rust' : 'muted'}>{KIND_LABEL[plan.kind]}</Tag>
      <Tag tone={plan.bpPolicy === 'keep' ? 'muted' : 'amber'}>
        {BP_POLICY_SHORT[plan.bpPolicy]}
      </Tag>
      <span className="text-2xs text-muted">{MAP_SOURCE_LABEL[plan.mapSource]}</span>
      {plan.pinned && <Tag tone="muted">mexido à mão</Tag>}
      {!pending && <Tag tone="muted">{STATUS_LABEL[plan.status]}</Tag>}

      <span className="ml-auto flex items-center gap-2">
        <span className="text-2xs tabular-nums text-muted">
          {future && remaining !== null ? `em ${formatCountdown(remaining)}` : STATUS_LABEL[plan.status]}
        </span>

        {future && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Empurra este wipe 24 horas para a frente."
              onClick={() => {
                onPostpone(plan, 24);
              }}
            >
              adiar
            </Button>

            {/* O forçado não aceita ser pulado — ver tab-geral.tsx. */}
            {plan.kind !== 'forced' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                title="Este wipe não acontece."
                onClick={() => {
                  onSkip(plan);
                }}
              >
                pular
              </Button>
            )}
          </>
        )}
      </span>

      {plan.note !== null && <span className="w-full text-2xs text-muted">{plan.note}</span>}
    </li>
  );
}

/**
 * Marcar um wipe fora da cadência.
 *
 * Ele nasce `manual`, e a reconciliação não o toca: quem marcou
 * uma data à mão não quer que a regra a apague na próxima vez que
 * alguém salvar a configuração.
 */
function ManualWipe({
  busy,
  clock,
  onCreate,
}: {
  readonly busy: boolean;
  readonly clock: AgentClock;
  readonly onCreate: TabAgendaProps['onCreate'];
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('16:00');
  const [bpPolicy, setBpPolicy] = useState<BpPolicy>('keep');
  const [note, setNote] = useState('');

  const at = fromDateTimeFields(date, time);
  const past = at !== null && clock.now !== null && at <= clock.now;

  if (!open) {
    return (
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        <CalendarPlus aria-hidden="true" className="h-4 w-4" />+ wipe manual
      </Button>
    );
  }

  return (
    <Section title="Wipe manual">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="manual-date">Dia</Label>
            <Input
              id="manual-date"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="manual-time">Hora</Label>
            <Input
              id="manual-time"
              type="time"
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
              }}
              className="mt-1"
            />
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              No fuso do seu navegador. O agente guarda o instante em UTC.
            </p>
          </div>
        </div>

        <PolicyPicker
          name="bp-manual"
          legend="Blueprints neste wipe"
          value={bpPolicy}
          onChange={setBpPolicy}
        />

        <div>
          <Label htmlFor="manual-note">Anotação</Label>
          <Input
            id="manual-note"
            value={note}
            placeholder="para quem for ler a agenda depois"
            onChange={(event) => {
              setNote(event.target.value);
            }}
            className="mt-1"
          />
        </div>

        {past && (
          <StateBlock
            variant="error"
            title="Essa data já passou."
            detail="O agente não mexe no passado: escolha um instante à frente do relógio dele."
          />
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancelar
          </Button>

          <Button
            variant="confirm"
            disabled={busy || at === null || past}
            onClick={() => {
              if (at === null) {
                return;
              }

              onCreate({ scheduledAt: at, bpPolicy, note: note.trim() === '' ? null : note.trim() });
              setOpen(false);
              setNote('');
            }}
          >
            Marcar
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** Os três destinos possíveis de um blueprint, sempre nesta ordem. */
function PolicyPicker({
  name,
  legend,
  value,
  onChange,
}: {
  readonly name: string;
  readonly legend: string;
  readonly value: BpPolicy;
  readonly onChange: (value: BpPolicy) => void;
}) {
  return (
    <fieldset>
      <legend className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        {legend}
      </legend>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {BP_POLICIES.map((policy) => (
          <label key={policy} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              checked={value === policy}
              onChange={() => {
                onChange(policy);
              }}
            />
            {BP_POLICY_LABEL[policy]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Tag({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone: 'rust' | 'amber' | 'muted';
}) {
  return (
    <span
      className={cn(
        'border px-1.5 py-0.5 text-2xs uppercase tracking-wide',
        tone === 'rust' && 'border-rust text-foreground',
        tone === 'amber' && 'border-amber text-foreground',
        tone === 'muted' && 'border-border text-muted',
      )}
    >
      {children}
    </span>
  );
}
