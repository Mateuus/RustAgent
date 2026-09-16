'use client';

// ============================================================
//  /eventos  -  O GUARDA-CHUVA.
//
//  ####  POR QUE ESTA TELA DEIXOU DE SER A DA MASMORRA  ####
//
//  A migração 057 criou `world_events` antes de existir um segundo
//  evento, e explicou por quê: "o que justifica é o SEGUNDO —
//  agenda, marcador, anúncio, dono, time e zona proibida são os
//  mesmos para qualquer coisa que nasça no mundo e morra depois".
//
//  O segundo chegou (KOTH), e a tela repetiu a separação do banco:
//
//    AQUI   o que é de TODAS as famílias — o que está no ar, a
//           agenda e o histórico. Mais a porta de cada família.
//    LÁ     o que é de UMA só: a planta e o alçapão da masmorra, o
//           território e o volume de captura do KOTH.
//
//  ####  A PORTA VEM ANTES DAS ABAS  ####
//
//  Os cartões ficam acima, e não numa aba: eles são a NAVEGAÇÃO, e
//  quem abre /eventos na maioria das vezes quer ir para uma família
//  — não olhar a agenda. Esconder a porta atrás de uma aba é pedir
//  dois cliques para o gesto mais comum da tela.
//
//  ####  O QUE NÃO ESTÁ AQUI  ####
//
//  Um botão "novo evento" genérico. Criar é sempre criar ALGUMA
//  coisa — uma masmorra tem planta e alçapão, um KOTH tem raio e
//  tempo de domínio —, e um formulário que perguntasse o tipo antes
//  de tudo seria um passo a mais para não decidir nada.
// ============================================================

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { LiveCard } from '@/components/events/live-card';
import { RunHistory } from '@/components/events/run-history';
import { SchedulePanel } from '@/components/events/schedule-panel';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent, type DungeonSummary, type EventRun, type WorldEvent } from '@/lib/api';
import { EVENT_FAMILIES, type EventFamily } from '@/lib/events/families';
import { cn } from '@/lib/utils';

type Tab = 'agenda' | 'historico';

export default function EventosPage() {
  return (
    <RequireSession>
      <Eventos />
    </RequireSession>
  );
}

function Eventos() {
  const [tab, setTab] = useState<Tab>('agenda');
  const [events, setEvents] = useState<readonly WorldEvent[] | null>(null);
  const [runs, setRuns] = useState<readonly EventRun[] | null>(null);
  const [dungeons, setDungeons] = useState<readonly DungeonSummary[]>([]);
  const [servers, setServers] = useState<readonly { id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [eventResponse, runResponse, dungeonResponse, serverResponse] = await Promise.all([
        agent.worldEvents(),
        agent.worldEventRuns({ limit: 50 }),
        agent.dungeons(),
        agent.servers(),
      ]);

      setEvents(eventResponse.events);
      setRuns(runResponse.runs);
      setDungeons(dungeonResponse.dungeons);
      setServers(serverResponse.servers.map((server) => ({ id: server.id, name: server.name })));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = (runs ?? []).filter((run) => run.endedAt === null && run.status !== 'failed');

  /**
   * Os eventos de uma família, por id.
   *
   * O cartão precisa de dois números que saem daqui: quantos estão
   * na agenda e quantos estão no ar. `event_runs` guarda o evento,
   * não a família — quem casa os dois é este conjunto.
   */
  function idsOf(family: EventFamily): ReadonlySet<string> {
    return new Set(
      (events ?? []).filter((event) => event.kind === family.kind).map((event) => event.id),
    );
  }

  return (
    <div>
      <PageHeader
        title="Eventos"
        description="O que a casa faz nascer no mapa"
        aside={
          <span className="text-2xs uppercase tracking-wide text-muted">
            {events === null
              ? 'lendo…'
              : `${String(events.length)} na agenda${live.length > 0 ? ` · ${String(live.length)} no ar` : ''}`}
          </span>
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {EVENT_FAMILIES.map((family) => {
          const ids = idsOf(family);

          return (
            <FamilyCard
              key={family.kind}
              family={family}
              scheduled={events === null ? null : ids.size}
              live={live.filter((run) => ids.has(run.eventId)).length}
              // Só a masmorra tem catálogo próprio hoje. Quando o
              // KOTH tiver os perfis dele, o número vem junto.
              catalog={family.kind === 'dungeon' ? dungeons.length : null}
            />
          );
        })}
      </div>

      {live.length > 0 && (
        <div className="mt-4">
          <LiveCard runs={live} events={events ?? []} onChanged={() => void load()} />
        </div>
      )}

      <div className="mt-6 border-b border-border">
        <div className="flex">
          <TabButton active={tab === 'agenda'} onClick={() => setTab('agenda')}>
            Agenda {events === null ? '' : `(${String(events.length)})`}
          </TabButton>
          <TabButton active={tab === 'historico'} onClick={() => setTab('historico')}>
            Histórico
          </TabButton>
        </div>
      </div>

      <div className="mt-4">
        {error !== null && events === null && (
          <StateBlock variant="error" title="Não consegui falar com o agente" detail={error} />
        )}

        {events === null && error === null && (
          <StateBlock variant="loading" title="Lendo os eventos…" />
        )}

        {events !== null && tab === 'agenda' && (
          <SchedulePanel dungeons={dungeons} servers={servers} />
        )}

        {events !== null && tab === 'historico' && (
          <RunHistory runs={runs} error={error} events={events} />
        )}
      </div>
    </div>
  );
}

/**
 * A porta de uma família.
 *
 * Ela carrega três números porque são três perguntas diferentes, e
 * quem cuida do servidor faz as três: quantas EXISTEM cadastradas,
 * quantas estão na AGENDA, e quantas estão NO AR agora. Um cartão
 * que só dissesse o nome obrigaria a entrar para descobrir que não
 * há nada lá dentro.
 */
function FamilyCard({
  family,
  scheduled,
  live,
  catalog,
}: {
  readonly family: EventFamily;
  /** Quantos eventos desta família na agenda. `null` = ainda lendo. */
  readonly scheduled: number | null;
  readonly live: number;
  /** Quantos no catálogo próprio dela. `null` = ela ainda não tem um. */
  readonly catalog: number | null;
}) {
  const { Icon } = family;

  return (
    <Link
      href={family.href}
      className="group block border border-border bg-surface p-4 hover:border-rust"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-condensed text-base font-bold uppercase tracking-wide">
            <Icon aria-hidden="true" className="h-4 w-4 text-rust" />
            {family.many}
            {!family.ready && (
              <span className="border border-border px-1.5 py-0.5 text-2xs font-normal normal-case tracking-normal text-muted">
                em construção
              </span>
            )}
          </h2>
          <p className="mt-1 max-w-md text-2xs text-muted">{family.hint}</p>
        </div>

        <ArrowRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted group-hover:text-rust"
        />
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
        {catalog !== null && <span>{catalog} cadastrada(s)</span>}
        <span>{scheduled === null ? '…' : `${String(scheduled)} na agenda`}</span>
        {live > 0 && <span className="text-olive">{live} no ar agora</span>}
      </p>
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        '-mb-px border-b-2 px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
        active
          ? 'border-rust text-foreground'
          : 'border-transparent text-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
