'use client';

// ============================================================
//  run-history.tsx  -  o que nasceu, e o que não nasceu.
//
//  ####  ELE EXISTE PARA RESPONDER "POR QUE NÃO NASCEU ONTEM?"  ####
//
//  Que é a pergunta cara. Sem esta aba, a única resposta possível
//  é "não sei" — e a causa (não tinha gente online, caiu em zona
//  proibida, a planta sumiu do disco) fica num log que já rodou.
//
//  Por isso a FALHA tem o mesmo peso visual do sucesso na lista, e
//  o motivo aparece por extenso, em português. O agente já traduz
//  o código na borda (`failureMessage`); esta tela mostra o que ele
//  mandou, inteiro.
//
//  ####  ELE É DO GUARDA-CHUVA, E NÃO DA MASMORRA  ####
//
//  `event_runs` sempre foi a tabela de TUDO que nasce no mapa. Com
//  o KOTH, a lista passou a misturar famílias — e por isso cada
//  linha carrega o selo da sua. Sem ele, "não nasceu ontem" vira
//  duas perguntas: o que não nasceu, e de que tipo era.
// ============================================================

import { MapPin, TriangleAlert, Users } from 'lucide-react';

import { StateBlock } from '@/components/state-block';
import type { EventRun, RunStatus, WorldEvent } from '@/lib/api';
import { familyLabel } from '@/lib/events/families';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  scheduled: 'agendada',
  spawning: 'construindo',
  active: 'no ar',
  closing: 'fechando',
  ended: 'terminou',
  failed: 'não nasceu',
  cancelled: 'derrubada',
};

export interface RunHistoryProps {
  readonly runs: readonly EventRun[] | null;
  readonly error: string | null;
  /**
   * A agenda, para dizer de que família é cada linha.
   *
   * Vazio = nenhum selo, que é o certo numa tela de família só. Um
   * evento apagado também não tem selo: a run continua no histórico
   * (ela aconteceu), e inventar uma família para ela seria pior que
   * não dizer nada.
   */
  readonly events?: readonly WorldEvent[];
}

export function RunHistory({ runs, error, events = [] }: RunHistoryProps) {
  if (runs === null && error !== null) {
    return <StateBlock variant="error" title="Não consegui ler o histórico" detail={error} />;
  }

  if (runs === null) {
    return <StateBlock variant="loading" title="Lendo o histórico…" />;
  }

  if (runs.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="Nada nasceu ainda"
        detail="Cada evento que subiu — e cada tentativa que falhou — aparece aqui, com onde, quando e por quê."
      />
    );
  }

  return (
    <div className="border border-border bg-surface">
      <ul className="divide-y divide-border">
        {runs.map((run) => {
          const kind = events.find((event) => event.id === run.eventId)?.kind ?? null;

          return (
          <li key={run.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
            <div className="flex min-w-0 gap-2">
              <StatusMark status={run.status} />

              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-condensed text-sm font-bold">
                  {kind !== null && (
                    <span className="border border-border px-1.5 py-0.5 text-2xs font-normal uppercase tracking-wide text-muted">
                      {familyLabel(kind)}
                    </span>
                  )}
                  <span>
                    {run.dungeonId ?? run.eventId}{' '}
                    <span className="font-normal text-muted">— {STATUS_LABEL[run.status]}</span>
                  </span>
                </p>

                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                  {run.grid !== null && (
                    <span className="flex items-center gap-1">
                      <MapPin aria-hidden="true" className="h-3 w-3" />
                      {run.grid}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Users aria-hidden="true" className="h-3 w-3" />
                    {run.enteredCount}
                  </span>
                  <span className="font-mono">{run.serverId}</span>
                  <span>{formatWhen(run.startedAt)}</span>
                </p>

                {/* A frase vem do agente inteira: ela conhece o
                    motivo, esta tela só sabe que houve um. */}
                {run.failureMessage != null && (
                  <p className="mt-1 border-l-2 border-amber pl-2 text-xs text-foreground">
                    {run.failureMessage}
                  </p>
                )}
              </div>
            </div>

            <span className="shrink-0 font-condensed text-2xs uppercase tracking-wide text-muted">
              #{run.id}
            </span>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Forma E cor: identidade nunca vem só da cor. */
function StatusMark({ status }: { readonly status: RunStatus }) {
  const failed = status === 'failed';
  const live = status === 'active' || status === 'spawning' || status === 'closing';

  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border',
        failed ? 'border-amber text-amber' : live ? 'border-olive text-olive' : 'border-border text-muted',
      )}
    >
      {failed ? (
        <TriangleAlert className="h-3 w-3" />
      ) : (
        <span className={cn('h-1.5 w-1.5', live ? 'bg-olive' : 'bg-muted')} />
      )}
    </span>
  );
}

function formatWhen(epoch: number | null): string {
  if (epoch === null) return 'sem hora';

  return new Date(epoch).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
