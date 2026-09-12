'use client';

// ============================================================
//  quest-maintenance.tsx  -  o wipe e as pendências.
//
//  ####  AS COISAS QUE SÓ O ADMIN VÊ  ####
//
//    Pendências  o que a quest prometeu e não saiu
//    Zerar       o botão perigoso, com o freio
//
//  Os NPCs saíram daqui em 11/09/2026: eles viraram uma aba
//  própria (`quest-npcs.tsx`). Esta caixa é para quando algo
//  quebrou, e o NPC é rotina.
//
//  ####  O WIPE EXIGE UM RECORTE E UM MOTIVO  ####
//
//  A API recusa `QUEST_WIPE_TOO_BROAD` sem recorte, e o motivo é
//  obrigatório no corpo. Zerar todos os jogadores de todos os
//  servidores por um clique distraído é o tipo de acidente que não
//  se desfaz — e sem o motivo gravado, ninguém consegue explicar
//  depois o que aconteceu.
// ============================================================

import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { QuestSettingsPanel } from '@/components/quests/quest-settings';
import {
  agent,
  type QuestEvent,
  type QuestProgressRow,
  type QuestSettingsRow,
} from '@/lib/api';

type Pending = QuestEvent & { attempt: QuestProgressRow | null };

export function QuestMaintenance({
  servers,
}: {
  readonly servers: readonly { readonly id: string; readonly name: string }[];
}) {
  const [pending, setPending] = useState<readonly Pending[] | null>(null);
  const [settings, setSettings] = useState<readonly QuestSettingsRow[]>([]);
  const [events, setEvents] = useState<readonly QuestEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // As três juntas: quem abre Manutenção quer ver o estado
      // inteiro, e três esperas em série piscariam a tela.
      const [pendingResponse, settingsResponse, eventsResponse] = await Promise.all([
        agent.questPendingRewards(),
        agent.questSettings(),
        agent.questEvents({ limit: 40 }),
      ]);

      setPending(pendingResponse.pending);
      setSettings(settingsResponse.settings);
      setEvents(eventsResponse.events);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {error !== null && <StateBlock variant="error" title="Não consegui ler" detail={error} />}

      <PendingList pending={pending} onChanged={() => void load()} />
      <QuestSettingsPanel servers={servers} settings={settings} onSaved={() => void load()} />
      <WipeBox servers={servers} onChanged={() => void load()} />
      <AuditList events={events} />
    </div>
  );
}

// ------------------------------------------------------------

function PendingList({
  pending,
  onChanged,
}: {
  readonly pending: readonly Pending[] | null;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  return (
    <Section title="Recompensas que não saíram">
      {pending === null && <p className="text-2xs text-muted">Lendo…</p>}

      {pending !== null && pending.length === 0 && (
        <p className="text-2xs text-muted">Nada pendente. Tudo o que foi prometido saiu.</p>
      )}

      <div className="space-y-2">
        {pending?.map((event) => {
          const detail = event.detail as { kind?: string; code?: string; message?: string } | null;

          return (
            <div
              key={event.id}
              className="flex items-center justify-between gap-3 rounded border border-rust/30 bg-rust/5 p-2"
            >
              <div className="min-w-0">
                <p className="font-condensed text-xs font-bold">
                  {event.attempt?.title ?? event.questId}
                </p>
                <p className="text-2xs text-muted">
                  {event.steamId} · {event.serverId} · {detail?.kind ?? '?'} ·{' '}
                  <span className="text-rust">{detail?.code ?? '?'}</span> ·{' '}
                  {new Date(event.at).toLocaleString('pt-BR')}
                </p>
              </div>

              {/* A tentativa pode ter sumido com a quest apagada. A
                  linha da auditoria fica — é ela que responde "o que
                  aconteceu com o meu prêmio?" —, mas não há o que
                  reentregar. */}
              {event.attempt !== null && (
                <button
                  type="button"
                  disabled={busy === event.id}
                  onClick={() => {
                    setBusy(event.id);
                    void agent
                      .retryQuestReward(event.attempt?.playerQuestId ?? 0, 'painel')
                      .finally(() => {
                        setBusy(null);
                        onChanged();
                      });
                  }}
                  className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-2xs uppercase tracking-wide"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reentregar
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------

function WipeBox({
  servers,
  onChanged,
}: {
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}) {
  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function wipe() {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await agent.wipeQuests({
        serverId: serverId === '' ? undefined : serverId,
        actor: 'painel',
        reason,
      });

      setResult(`${String(response.wiped)} tentativa(s) zerada(s).`);
      setReason('');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Zerar progresso">
      <p className="mb-3 text-2xs text-muted">
        As tentativas em andamento viram canceladas e o contador some. O que já foi resgatado não é
        tocado, e o histórico fica inteiro — apagá-lo reescreveria o passado, e o ranking de missões
        atravessa o wipe.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Servidor
          </span>
          <select
            className="w-48 rounded border border-border bg-background px-2 py-1.5 text-xs"
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
          >
            <option value="">escolha…</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block flex-1">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Motivo
          </span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
            placeholder="por que está zerando?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        {/* O botão só acende com os dois preenchidos: é o mesmo
            freio que a API aplica, dito antes da ida à rede. */}
        <button
          type="button"
          disabled={busy || serverId === '' || reason.trim() === ''}
          onClick={() => void wipe()}
          className="rounded bg-rust px-3 py-1.5 text-2xs uppercase tracking-wide text-white disabled:opacity-40"
        >
          Zerar
        </button>
      </div>

      {result !== null && <p className="mt-2 text-2xs text-muted">{result}</p>}
      {error !== null && <p className="mt-2 text-2xs text-rust">{error}</p>}
    </Section>
  );
}

// ------------------------------------------------------------

const EVENT_LABEL: Readonly<Record<QuestEvent['kind'], string>> = {
  accept: 'aceitou',
  progress: 'progrediu',
  complete: 'concluiu',
  claim: 'resgatou',
  abandon: 'cancelou',
  reset: 'foi zerado',
  reward_failed: 'não recebeu',
};

/**
 * A auditoria.
 *
 * ####  ELA EXISTE PARA RESPONDER RECLAMAÇÃO  ####
 *
 * "Fiz a missão e não recebi" é a mensagem que o dono vai ler. Sem
 * esta lista, a única resposta possível seria "o número está zerado
 * aqui" — e com ela dá para contar a história inteira: aceitou às
 * 14h02, concluiu às 14h31, resgatou às 14h33, o kit falhou.
 */
function AuditList({ events }: { readonly events: readonly QuestEvent[] }) {
  return (
    <Section title="O que aconteceu">
      {events.length === 0 && (
        <p className="text-2xs text-muted">Nada registrado ainda.</p>
      )}

      <div className="space-y-1">
        {events.map((event) => (
          <p key={event.id} className="flex flex-wrap gap-x-2 text-2xs">
            <span className="text-muted">{new Date(event.at).toLocaleString('pt-BR')}</span>
            <span className="text-foreground">{event.steamId}</span>
            <span className={event.kind === 'reward_failed' ? 'text-rust' : 'text-muted'}>
              {EVENT_LABEL[event.kind]}
            </span>
            <span className="text-foreground">{event.questId}</span>
            {event.actor !== null && <span className="text-muted">por {event.actor}</span>}
          </p>
        ))}
      </div>
    </Section>
  );
}
