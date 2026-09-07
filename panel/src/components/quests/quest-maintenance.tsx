'use client';

// ============================================================
//  quest-maintenance.tsx  -  os NPCs, o wipe e as pendências.
//
//  ####  AS TRÊS COISAS QUE SÓ O ADMIN VÊ  ####
//
//    NPCs        onde eles estão, e o que depende deles
//    Pendências  o que a quest prometeu e não saiu
//    Zerar       o botão perigoso, com o freio
//
//  ####  O WIPE EXIGE UM RECORTE E UM MOTIVO  ####
//
//  A API recusa `QUEST_WIPE_TOO_BROAD` sem recorte, e o motivo é
//  obrigatório no corpo. Zerar todos os jogadores de todos os
//  servidores por um clique distraído é o tipo de acidente que não
//  se desfaz — e sem o motivo gravado, ninguém consegue explicar
//  depois o que aconteceu.
// ============================================================

import { MapPin, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { QuestSettingsPanel } from '@/components/quests/quest-settings';
import {
  agent,
  type QuestEvent,
  type QuestNpc,
  type QuestProgressRow,
  type QuestSettingsRow,
} from '@/lib/api';

type Pending = QuestEvent & { attempt: QuestProgressRow | null };

export function QuestMaintenance({
  servers,
  onChanged,
}: {
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}) {
  const [npcs, setNpcs] = useState<readonly QuestNpc[] | null>(null);
  const [pending, setPending] = useState<readonly Pending[] | null>(null);
  const [settings, setSettings] = useState<readonly QuestSettingsRow[]>([]);
  const [events, setEvents] = useState<readonly QuestEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // As quatro juntas: quem abre Manutenção quer ver o estado
      // inteiro, e quatro esperas em série piscariam a tela.
      const [npcResponse, pendingResponse, settingsResponse, eventsResponse] = await Promise.all([
        agent.questNpcs(),
        agent.questPendingRewards(),
        agent.questSettings(),
        agent.questEvents({ limit: 40 }),
      ]);

      setNpcs(npcResponse.npcs);
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

      <NpcList
        npcs={npcs}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
      <PendingList pending={pending} onChanged={() => void load()} />
      <QuestSettingsPanel servers={servers} settings={settings} onSaved={() => void load()} />
      <WipeBox servers={servers} onChanged={() => void load()} />
      <AuditList events={events} />
    </div>
  );
}

// ------------------------------------------------------------

function NpcList({
  npcs,
  onChanged,
}: {
  readonly npcs: readonly QuestNpc[] | null;
  readonly onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function remove(npc: QuestNpc) {
    setError(null);

    try {
      const result = await agent.removeQuestNpc(npc.id);

      if (result.orphaned.length > 0) {
        // A quest NÃO vai junto — ela volta a ser uma quest de
        // menu, com o progresso de quem estava fazendo intacto. Mas
        // isso precisa ser dito: ela some do mapa sem sumir da
        // lista.
        setError(
          `O NPC saiu. Estas missões voltaram a aparecer no menu para todos: ${result.orphaned.join(', ')}.`,
        );
      }

      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Section title="NPCs">
      {npcs === null && <p className="text-2xs text-muted">Lendo…</p>}

      {npcs !== null && npcs.length === 0 && (
        <p className="text-2xs text-muted">
          Nenhum NPC ainda. Ninguém escolhe coordenada digitando número: vá até o lugar no jogo,
          olhe para onde ele deve olhar, e use <code className="text-foreground">/questnpc add</code>
          . Daqui você renomeia, liga, desliga e apaga.
        </p>
      )}

      {error !== null && (
        <p className="mb-2 rounded border border-amber/40 bg-amber/10 px-3 py-2 text-2xs text-amber">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {npcs?.map((npc) => (
          <div
            key={npc.id}
            className="flex items-center justify-between gap-3 rounded border border-border p-2"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 font-condensed text-xs font-bold">
                <MapPin className="h-3.5 w-3.5 text-rust" />
                {npc.name}
                {!npc.enabled && (
                  <span className="text-2xs uppercase tracking-wide text-muted">desligado</span>
                )}
              </p>
              <p className="text-2xs text-muted">
                {npc.serverId} · {npc.x.toFixed(0)}, {npc.z.toFixed(0)} · raio{' '}
                {npc.useRadius.toFixed(1)} m
                {npc.quests.length > 0 && ` · ${String(npc.quests.length)} missão(ões)`}
                {npc.wipePolicy === 'remove' && ' · some no wipe'}
              </p>
            </div>

            <div className="flex shrink-0 gap-2">
              <NpcEditor npc={npc} onSaved={onChanged} />
              <button
                type="button"
                aria-label="Apagar NPC"
                onClick={() => void remove(npc)}
                className="rounded border border-border p-1.5 text-muted hover:text-rust"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Section>
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

/**
 * Editar um NPC.
 *
 * ####  A POSIÇÃO NÃO ESTÁ AQUI, E É DE PROPÓSITO  ####
 *
 * Ninguém escolhe coordenada digitando número: para mover, o admin
 * vai até o novo lugar no jogo e cadastra de novo. O que se muda
 * daqui é o que se lê — nome, papel, alcance — e o que se liga.
 */
function NpcEditor({ npc, onSaved }: { readonly npc: QuestNpc; readonly onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(npc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);

    try {
      await agent.updateQuestNpc(npc.id, {
        serverId: form.serverId,
        name: form.name,
        kind: form.kind,
        x: form.x,
        y: form.y,
        z: form.z,
        rotation: form.rotation,
        prefab: form.prefab,
        mapMarker: form.mapMarker,
        useRadius: form.useRadius,
        enabled: form.enabled,
        wipePolicy: form.wipePolicy,
      });

      setOpen(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Editar NPC"
        onClick={() => setOpen(true)}
        className="rounded border border-border p-1.5 text-muted hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded border border-border bg-surface p-4">
        <h3 className="mb-3 font-condensed text-sm font-bold uppercase tracking-wide">
          {npc.name}
        </h3>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Nome
            </span>
            <input
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Papel
            </span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.kind}
              onChange={(event) =>
                setForm({ ...form, kind: event.target.value as QuestNpc['kind'] })
              }
            >
              <option value="quest">Oferece missões</option>
              <option value="delivery">Só recebe entregas</option>
            </select>
            {/* Um NPC de entrega NÃO abre lista de missões: ele
                existe para receber o pacote, e uma vitrine ali
                confundiria quem chegou para entregar. */}
            {form.kind === 'delivery' && (
              <span className="mt-1 block text-2xs text-muted">
                Ele não mostra missões: serve como destino de entrega.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Alcance do USE (metros)
            </span>
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              className="w-24 rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.useRadius}
              onChange={(event) => setForm({ ...form, useRadius: Number(event.target.value) })}
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              No wipe
            </span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.wipePolicy}
              onChange={(event) =>
                setForm({ ...form, wipePolicy: event.target.value as QuestNpc['wipePolicy'] })
              }
            >
              <option value="keep">A posição sobrevive</option>
              <option value="remove">Some (a posição era só daquele mapa)</option>
            </select>
          </label>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-2xs text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-rust"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              Ligado
            </label>
            <label className="flex items-center gap-2 text-2xs text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-rust"
                checked={form.mapMarker}
                onChange={(event) => setForm({ ...form, mapMarker: event.target.checked })}
              />
              Marcar no mapa
            </label>
          </div>

          <p className="text-2xs text-muted">
            Posição: {form.x.toFixed(0)}, {form.z.toFixed(0)}. Para mover, vá até o novo lugar no
            jogo e use <code className="text-foreground">/questnpc add</code>.
          </p>

          {error !== null && <p className="text-2xs text-rust">{error}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-border px-3 py-1.5 text-2xs uppercase tracking-wide"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded bg-rust px-3 py-1.5 text-2xs uppercase tracking-wide text-white disabled:opacity-50"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
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
