'use client';

// ============================================================
//  schedule-panel.tsx  -  a masmorra nasce sozinha.
//
//  Pedido do dono em 09/09/2026: "temos que fazer um sistema de
//  ativação, sheduler etc.".
//
//  ####  O ESQUEMA JÁ EXISTIA, E ESTAVA VAZIO  ####
//
//  A tabela `world_events` tem intervalo, duração, mínimo de gente
//  online e modo de nascimento desde a migração 057 — e nunca teve
//  uma linha, porque não havia tela para cadastrar nem relógio para
//  cumprir. Esta tela é a primeira metade disso.
//
//  ####  O QUE ELA NÃO PERGUNTA  ####
//
//  ONDE ela nasce: isso é dos pontos, na tela da família. E COMO
//  ela se anuncia (mapa e chat): isso é da masmorra, no editor
//  dela. Duas fontes para a mesma frase é o jeito de ter duas
//  frases diferentes.
//
//  ####  A AGENDA É DE TODAS AS FAMÍLIAS  ####
//
//  `world_events.kind` é texto livre desde a migração 057, e esta
//  lista mostra o que houver lá — masmorra, KOTH, o que vier. O que
//  ela NÃO faz é oferecer o cadastro de uma família que o agente
//  ainda não sabe erguer: um horário marcado para uma coisa que
//  nunca acontece é pior que a ausência do campo. Enquanto isso,
//  quem já estiver cadastrado ganha o aviso de que nada vai nascer
//  — o mesmo não que o agendador dá no log.
//
//  Ver Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md §2.
// ============================================================

import { CalendarClock, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { agent, type DungeonSummary, type WorldEvent, type WorldEventInput } from '@/lib/api';
import { EVENT_FAMILIES, familyOf } from '@/lib/events/families';
import { describeSchedule } from '@/lib/events/schedule-summary';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface SchedulePanelProps {
  readonly dungeons: readonly DungeonSummary[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
}

export function SchedulePanel({ dungeons, servers }: SchedulePanelProps) {
  const [events, setEvents] = useState<readonly WorldEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** `undefined` = fechado; `null` = criando; um evento = editando. */
  const [editing, setEditing] = useState<WorldEvent | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const response = await agent.worldEvents();

      setEvents(response.events);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(event: WorldEvent) {
    try {
      await agent.removeWorldEvent(event.id);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (error !== null) {
    return <StateBlock variant="error" title="A agenda não veio" detail={error} />;
  }

  if (events === null) {
    return <StateBlock variant="loading" title="Lendo a agenda…" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
            De quanto em quanto tempo
          </h3>
          <p className="mt-1 text-2xs text-muted">
            O agente sorteia a hora dentro da janela, ergue o evento num dos pontos marcados e o
            derruba quando o tempo acaba. Vale para qualquer família.
          </p>
        </div>

        <Button size="sm" variant="primary" onClick={() => setEditing(null)}>
          <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Novo horário
        </Button>
      </div>

      {events.length === 0 ? (
        <div className="border border-border bg-surface p-6">
          <h4 className="font-condensed text-base font-bold uppercase tracking-wide">
            Nada acontece sozinho ainda
          </h4>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Sem um horário aqui, um evento só nasce quando alguém clica em{' '}
            <strong className="text-foreground">Erguer</strong> na tela da família dele. Com um, o
            servidor passa a ter evento sozinho — de hora em hora, ou de madrugada, ou só quando
            houver dez pessoas online.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className={cn(
                'flex flex-wrap items-center gap-3 border border-border bg-surface p-3',
                !event.enabled && 'opacity-60',
              )}
            >
              <CalendarClock
                aria-hidden="true"
                className={cn('h-4 w-4 shrink-0', event.enabled ? 'text-amber' : 'text-muted')}
              />

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="border border-border px-1.5 py-0.5 font-condensed text-2xs uppercase tracking-wide text-muted">
                    {familyOf(event.kind)?.one ?? event.kind}
                  </span>
                  <span className="min-w-0 truncate font-condensed text-sm font-bold">
                    {event.name}
                  </span>
                </span>
                <span className="mt-0.5 block text-2xs text-muted">
                  {(() => {
                    // A leitura é da família, e mora fora do JSX: ver
                    // schedule-summary.ts.
                    const summary = describeSchedule(event, (id) => nameOf(dungeons, id));

                    return summary.warning !== null ? (
                      <span className="text-amber">{summary.warning}</span>
                    ) : (
                      summary.parts.join(' · ')
                    );
                  })()}
                </span>
              </span>

              <Button size="sm" variant="outline" onClick={() => setEditing(event)}>
                Editar
              </Button>

              <ConfirmButton
                variant="danger"
                disabled={false}
                icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
                label="Apagar"
                confirmLabel="Apagar mesmo"
                hint="O horário some. A masmorra que estiver de pé continua até o tempo dela acabar."
                onConfirm={() => void remove(event)}
              />
            </li>
          ))}
        </ul>
      )}

      {editing !== undefined && (
        <ScheduleDialog
          event={editing}
          dungeons={dungeons}
          servers={servers}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * O formulário de um horário.
 *
 * Os campos são os que o agendador LÊ. `access`, `ownerGrace`,
 * `radiationBefore` e os `marker_*`/`msg_*` da tabela existem e
 * estão inertes — mostrá-los seria prometer comportamento que
 * ninguém implementou.
 */
function ScheduleDialog({
  event,
  dungeons,
  servers,
  onClose,
  onSaved,
}: {
  readonly event: WorldEvent | null;
  readonly dungeons: readonly DungeonSummary[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [draft, setDraft] = useState<WorldEventInput>(() => event ?? blankEvent(dungeons, servers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(change: Partial<WorldEventInput>) {
    setDraft((current) => ({ ...current, ...change }));
  }

  async function save() {
    setBusy(true);
    setError(null);

    try {
      if (event === null) {
        await agent.createWorldEvent(draft);
      } else {
        const { id: _unused, ...body } = draft;

        await agent.updateWorldEvent(event.id, body);
      }

      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={event === null ? 'Novo horário' : `Editar ${event.name}`}
      onClose={onClose}
      busy={busy}
      guarded
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Nome</span>
            <Input
              className="mt-1"
              value={draft.name}
              maxLength={80}
              placeholder={draft.kind === 'dungeon' ? 'Noite de masmorra' : 'KOTH da noite'}
              onChange={(target) => {
                const name = target.target.value;

                // O identificador acompanha o nome enquanto o evento
                // é novo: ele nunca muda depois de criado.
                patch(event === null ? { name, id: slugify(name) } : { name });
              }}
            />
          </label>

          {/* ####  A FAMÍLIA VEM ANTES DE TUDO  ####

              Ela decide quais campos abaixo fazem sentido. A lista é
              só das famílias que o agente sabe erguer HOJE: oferecer
              uma que ele ignora produziria um horário que nunca
              acontece, e ninguém saberia por quê.

              Ela é trocável só enquanto o evento é NOVO. Mudar a
              família de um horário que já tem histórico faria as
              runs antigas mudarem de tipo no passado. */}
          <label className="block">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Que evento
            </span>
            <select
              value={draft.kind}
              disabled={event !== null}
              onChange={(target) => {
                const kind = target.target.value;

                // Trocar para KOTH larga a masmorra escolhida: ela
                // viajaria no payload e não significaria nada.
                patch(kind === 'dungeon' ? { kind } : { kind, dungeonId: null });
              }}
              className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm disabled:opacity-60"
            >
              {EVENT_FAMILIES.filter((family) => family.ready).map((family) => (
                <option key={family.kind} value={family.kind}>
                  {family.one}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-2xs text-muted">
              {event === null
                ? 'Depois de criado, o horário não muda de família.'
                : 'A família não muda depois de criada: o histórico dela ficaria de outro tipo.'}
            </span>
          </label>

          {draft.kind === 'dungeon' && (
            <label className="block">
              <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                Qual masmorra
              </span>
              <select
                value={draft.dungeonId ?? ''}
                onChange={(target) =>
                  patch({ dungeonId: target.target.value === '' ? null : target.target.value })
                }
                className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
              >
                <option value="">— escolha —</option>
                {dungeons.map((dungeon) => (
                  <option key={dungeon.id} value={dungeon.id}>
                    {dungeon.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <MinutesRange
          label="A cada"
          hint="O agente sorteia um número dentro desta janela e conta. Iguais = intervalo fixo."
          value={draft.interval}
          onChange={(interval) => patch({ interval })}
        />

        {draft.kind === 'dungeon' ? (
          <MinutesRange
            label="Fica de pé por"
            hint="Quando o tempo acaba, o agente derruba a masmorra e quem estava dentro sai."
            value={draft.duration}
            onChange={(duration) => patch({ duration })}
          />
        ) : (
          // Campo que não manda em nada é pior que campo nenhum:
          // alguém preenche e espera o evento durar aquilo.
          <p className="border-l-2 border-border bg-surface-2 px-3 py-2 text-2xs text-muted">
            Quanto o KOTH fica de pé, o raio e o tempo de domínio são de cada{' '}
            <strong className="text-foreground">território</strong>, na tela do KOTH. Este horário
            só escolhe a hora de começar — e o território é sorteado entre os ligados.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Mínimo de gente online
            </span>
            <Input
              className="mt-1"
              type="number"
              min={0}
              max={500}
              value={String(draft.minOnline)}
              onChange={(target) => patch({ minOnline: clampInt(target.target.value, 0, 500) })}
            />
            <span className="mt-1 block text-2xs text-muted">
              Abaixo disso ele adia, e não pula: evento para ninguém é loot de graça para o primeiro
              que logar.
            </span>
          </label>

          <div>
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Em que servidores
            </span>
            <div className="mt-1 space-y-1">
              {servers.map((server) => (
                <label key={server.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.servers.includes(server.id)}
                    onChange={(target) =>
                      patch({
                        servers: target.target.checked
                          ? [...draft.servers, server.id]
                          : draft.servers.filter((id) => id !== server.id),
                      })
                    }
                  />
                  {server.name}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border border-border bg-surface-2 p-3">
          <span className="min-w-0">
            <span className="block text-xs text-foreground">Contar só depois que ele fechar</span>
            <span className="block text-2xs text-muted">
              Ligado, a próxima contagem começa quando este evento acabar. Desligado, ela corre em
              paralelo — e a próxima pode estar pronta assim que esta fechar.
            </span>
          </span>
          <Toggle
            on={draft.countAfterEnd}
            busy={false}
            onChange={(countAfterEnd) => patch({ countAfterEnd })}
            labels={['Depois', 'Em paralelo']}
            label="Contar só depois que ele fechar"
          />
        </div>

        <div className="flex items-center justify-between gap-3 border border-border bg-surface-2 p-3">
          <span className="min-w-0">
            <span className="block text-xs text-foreground">Este horário está valendo</span>
            <span className="block text-2xs text-muted">
              Desligado, ele fica guardado e nada acontece.
            </span>
          </span>
          <Toggle
            on={draft.enabled}
            busy={false}
            onChange={(enabled) => patch({ enabled })}
            labels={['Valendo', 'Parado']}
            label="Este horário está valendo"
          />
        </div>

        {draft.kind === 'dungeon' && draft.dungeonId === null && (
          <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-2xs">
            Sem masmorra escolhida, este horário fica guardado e o agente o pula. Dá para salvar
            assim e escolher depois.
          </p>
        )}

        {error !== null && (
          <p role="alert" className="border-l-2 border-rust bg-surface-2 px-3 py-2 text-xs">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Fechar
          </Button>
          <Button
            size="sm"
            variant="confirm"
            disabled={busy || draft.name === '' || draft.id === ''}
            onClick={() => void save()}
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {event === null ? 'Criar' : 'Salvar'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Uma janela de tempo, em MINUTOS.
 *
 * O banco guarda segundos porque é o que o plugin de origem usava;
 * ninguém agenda evento em segundos. A conversão mora aqui, na
 * borda, e não espalhada pela tela.
 */
function MinutesRange({
  label,
  hint,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: { readonly min: number; readonly max: number };
  readonly onChange: (value: { min: number; max: number }) => void;
}) {
  return (
    <div className="border border-border bg-surface-2 p-3">
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</span>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Input
          type="number"
          min={1}
          max={1440}
          className="w-24"
          value={String(Math.round(value.min / 60))}
          onChange={(target) =>
            onChange({ ...value, min: clampInt(target.target.value, 1, 1440) * 60 })
          }
        />
        <span className="text-2xs text-muted">a</span>
        <Input
          type="number"
          min={1}
          max={1440}
          className="w-24"
          value={String(Math.round(value.max / 60))}
          onChange={(target) =>
            onChange({ ...value, max: clampInt(target.target.value, 1, 1440) * 60 })
          }
        />
        <span className="text-2xs text-muted">minutos</span>
      </div>

      <p className="mt-1 text-2xs text-muted">{hint}</p>
    </div>
  );
}

/** "de 60 a 120 min", ou "a cada 60 min" quando os dois são iguais. */
/** O nome de uma masmorra pelo id, ou `null` se ela não existe mais. */
function nameOf(dungeons: readonly DungeonSummary[], id: string): string | null {
  return dungeons.find((dungeon) => dungeon.id === id)?.name ?? null;
}

/**
 * O evento novo.
 *
 * Uma hora de espera e trinta minutos de pé: é o que o plugin de
 * origem usava, e é uma cadência que já rodou em servidor de
 * verdade. Com uma masmorra só cadastrada, ela já vem escolhida.
 */
function blankEvent(
  dungeons: readonly DungeonSummary[],
  servers: readonly { readonly id: string; readonly name: string }[],
): WorldEventInput {
  return {
    id: '',
    kind: 'dungeon',
    name: '',
    description: null,
    dungeonId: dungeons.length === 1 ? (dungeons[0]?.id ?? null) : null,
    enabled: true,
    sort: 0,
    spawnMode: 'schedule',
    interval: { min: 3600, max: 7200 },
    duration: { min: 1800, max: 1800 },
    minOnline: 1,
    countAfterEnd: false,
    access: 'anyone',
    ownerGraceSeconds: 300,
    marker: {
      enabled: true,
      label: 'Masmorra',
      color: '#ff0000',
      alpha: 0.55,
      radius: 0.5,
      showOwner: true,
      showTime: true,
    },
    messages: { start: null, location: null, warning: null, end: null, denied: null },
    warnBefore: 300,
    radiationBefore: 180,
    destroyAfter: 60,
    respawnSeconds: 3600,
    servers: servers.map((server) => server.id),
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);

  if (Number.isNaN(value)) return min;

  return Math.min(max, Math.max(min, value));
}
