'use client';

// ============================================================
//  live-card.tsx  -  o que está de pé agora, de qualquer família.
//
//  ####  ELE SAIU DA LISTA DE MASMORRAS  ####
//
//  Morava em `dungeons/dungeon-list.tsx`, e já havia uma nota lá
//  dizendo que ele é da PÁGINA e não da lista. Com o KOTH chegando
//  ele passou a ser de mais que uma página: o que está no ar é uma
//  pergunta do guarda-chuva, e quem a responde lê `event_runs` —
//  que nunca foi tabela de masmorra.
//
//  ####  A LINHA DIZ DE QUE FAMÍLIA ELA É  ####
//
//  Com dois tipos no mapa, "Bunker" e "Colina do Norte" no ar ao
//  mesmo tempo não se distinguem por nome nenhum. O selo da família
//  vem antes do nome porque derrubar a coisa errada é um clique.
//
//  ####  SEM "NENHUMA NO AR"  ####
//
//  Ausente quando não há nada. Um aviso permanente vira ruído que
//  se aprende a ignorar — e aí o dia em que ele muda ninguém vê.
// ============================================================

import { Hammer, MapPin, Users } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { agent, type EventRun, type WorldEvent } from '@/lib/api';
import { familyOf } from '@/lib/events/families';

export interface LiveCardProps {
  readonly runs: readonly EventRun[];
  /**
   * A agenda, para saber de que família é cada run.
   *
   * `event_runs` guarda o `event_id`, e é o evento que tem o
   * `kind`. Vazio = o cartão não mostra selo nenhum, que é o que
   * acontece numa tela de família só — lá o selo seria redundante.
   */
  readonly events?: readonly WorldEvent[];
  readonly onChanged: () => void;
}

export function LiveCard({ runs, events = [], onChanged }: LiveCardProps) {
  const [busy, setBusy] = useState<number | null>(null);

  async function stop(run: EventRun) {
    setBusy(run.id);

    try {
      await agent.stopWorldEventRun(run.id);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-olive bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-olive" />
        <h2 className="font-condensed text-sm font-bold uppercase tracking-wide">No ar agora</h2>
      </header>

      <div className="divide-y divide-border">
        {runs.map((run) => {
          const kind = events.find((event) => event.id === run.eventId)?.kind ?? null;
          const family = kind === null ? null : familyOf(kind);

          return (
            <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-condensed text-sm font-bold">
                  {kind !== null && (
                    <span className="border border-border px-1.5 py-0.5 text-2xs font-normal uppercase tracking-wide text-muted">
                      {family?.one ?? kind}
                    </span>
                  )}
                  {run.dungeonId ?? run.eventId}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                  <span className="flex items-center gap-1">
                    <MapPin aria-hidden="true" className="h-3 w-3" />
                    {run.grid ?? '?'}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users aria-hidden="true" className="h-3 w-3" />
                    {run.enteredCount} entrou/entraram
                  </span>
                  <span>{sinceLabel(run.startedAt)}</span>
                  <span className="font-mono">{run.serverId}</span>
                </p>
              </div>

              <Button
                size="sm"
                variant="danger"
                disabled={busy === run.id}
                onClick={() => void stop(run)}
              >
                <Hammer aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                Derrubar
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** "há 12 min". Sem segundo: ninguém precisa dessa precisão aqui. */
function sinceLabel(epoch: number | null): string {
  if (epoch === null) return 'há pouco';

  const minutes = Math.max(0, Math.round((Date.now() - epoch) / 60_000));

  if (minutes < 1) return 'agora mesmo';
  if (minutes < 60) return `há ${String(minutes)} min`;

  return `há ${String(Math.round(minutes / 60))} h`;
}
