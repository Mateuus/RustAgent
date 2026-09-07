'use client';

// ============================================================
//  quest-progress.tsx  -  quem está fazendo o quê.
//
//  ####  A BUSCA EXIGE UM RECORTE, E A TELA DIZ ISSO  ####
//
//  A API recusa `/quests/progress` sem `steamId` nem `questId`:
//  sem recorte, a consulta varreria uma tabela que cresce com
//  jogador × quest × tentativa. A tela não tenta a chamada vazia —
//  ela pede o recorte primeiro.
//
//  ####  É AQUI QUE O SUPORTE TRABALHA  ####
//
//  "Fiz a quest e não recebi" é a mensagem que o dono vai ler. Esta
//  aba responde: quando aceitou, quanto tem de cada objetivo, se
//  resgatou — e os três botões que consertam.
// ============================================================

import { Check, Gift, RotateCcw, Search, X } from 'lucide-react';
import { useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { agent, type QuestDefinition, type QuestProgressRow } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Readonly<Record<QuestProgressRow['status'], string>> = {
  active: 'em andamento',
  completed: 'pronta para resgatar',
  claimed: 'resgatada',
  abandoned: 'cancelada',
};

export function QuestProgressPanel({
  quests,
  servers,
}: {
  readonly quests: readonly QuestDefinition[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
}) {
  const [steamId, setSteamId] = useState('');
  const [questId, setQuestId] = useState('');
  const [serverId, setServerId] = useState('');
  const [rows, setRows] = useState<readonly QuestProgressRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (steamId === '' && questId === '') {
      // A mesma regra da API, dita antes da ida à rede: uma recusa
      // que a tela já sabe prever não precisa custar um pedido.
      setError('Diga de quem ou de qual missão: preencha o SteamID ou escolha uma missão.');

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await agent.questProgress({
        steamId: steamId === '' ? undefined : steamId,
        questId: questId === '' ? undefined : questId,
        serverId: serverId === '' ? undefined : serverId,
        limit: 100,
      });

      setRows(response.progress);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRows(null);
    } finally {
      setBusy(false);
    }
  }

  async function grant() {
    await act(() => agent.grantQuest(questId, { serverId, steamId, actor: 'painel' }));
  }

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);

    try {
      await action();
      await search();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 border border-border bg-surface p-3">
        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            SteamID
          </span>
          <input
            className="w-52 rounded border border-border bg-background px-2 py-1.5 text-xs"
            placeholder="7656119…"
            value={steamId}
            onChange={(event) => setSteamId(event.target.value.trim())}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Servidor
          </span>
          <select
            className="w-36 rounded border border-border bg-background px-2 py-1.5 text-xs"
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
          >
            <option value="">(qualquer um)</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Missão
          </span>
          <select
            className="w-56 rounded border border-border bg-background px-2 py-1.5 text-xs"
            value={questId}
            onChange={(event) => setQuestId(event.target.value)}
          >
            <option value="">(qualquer uma)</option>
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={busy}
          onClick={() => void search()}
          className="flex items-center gap-1.5 rounded bg-rust px-3 py-1.5 text-2xs uppercase tracking-wide text-white disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
          Buscar
        </button>

        {/* ####  CONCEDER PASSA POR CIMA DAS REGRAS  ####

            É o `force` da API: cooldown, cadeia e teto são
            ignorados. A única trava que fica de pé é a de
            integridade — duas tentativas vivas da mesma missão
            dariam dois contadores da mesma coisa.

            Só acende com os dois campos preenchidos: conceder
            "alguma missão" a "alguém" não é uma ação. */}
        <button
          type="button"
          disabled={busy || steamId === '' || questId === '' || serverId === ''}
          onClick={() => void grant()}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-2xs uppercase tracking-wide disabled:opacity-40"
        >
          <Gift className="h-3.5 w-3.5" />
          Conceder
        </button>
      </div>

      {error !== null && <StateBlock variant="error" title="Não deu" detail={error} />}

      {rows !== null && rows.length === 0 && (
        <StateBlock variant="empty" title="Nada encontrado com esse recorte" />
      )}

      {rows?.map((row) => (
        <div key={row.playerQuestId} className="border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-condensed text-sm font-bold">{row.title}</h3>
              <p className="text-2xs text-muted">
                {row.steamId} · {row.serverId} · tentativa {row.attempt} ·{' '}
                <span className={cn(row.status === 'completed' && 'text-rust')}>
                  {STATUS_LABEL[row.status]}
                </span>
              </p>
            </div>

            <div className="flex gap-2">
              {row.status === 'completed' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => agent.claimQuest(row.playerQuestId, 'painel'))}
                  className="flex items-center gap-1 rounded border border-border px-2 py-1 text-2xs uppercase tracking-wide"
                >
                  <Check className="h-3 w-3" />
                  Resgatar por ele
                </button>
              )}

              {row.status === 'claimed' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => agent.retryQuestReward(row.playerQuestId, 'painel'))
                  }
                  className="flex items-center gap-1 rounded border border-border px-2 py-1 text-2xs uppercase tracking-wide"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reentregar
                </button>
              )}

              {(row.status === 'active' || row.status === 'completed') && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      agent.cancelQuest(row.playerQuestId, {
                        actor: 'painel',
                        reason: 'cancelada pelo painel',
                      }),
                    )
                  }
                  className="flex items-center gap-1 rounded border border-border px-2 py-1 text-2xs uppercase tracking-wide hover:text-rust"
                >
                  <X className="h-3 w-3" />
                  Cancelar
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {row.objectives.map((objective) => (
              <div key={objective.seq}>
                <div className="flex justify-between text-2xs">
                  <span className={cn(objective.done && 'text-muted line-through')}>
                    {objective.label}
                  </span>
                  <span className="text-muted">
                    {objective.have.toLocaleString('pt-BR')} /{' '}
                    {objective.need.toLocaleString('pt-BR')}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1 flex-1 rounded bg-background">
                    <div
                      className="h-1 rounded bg-rust"
                      style={{
                        width: `${String(Math.min(100, (objective.have / objective.need) * 100))}%`,
                      }}
                    />
                  </div>

                  {/* O ajuste de contador do suporte. Ele NÃO conclui
                      a quest: quem marca `completed` é o caminho
                      normal — duas portas para o mesmo estado
                      divergiriam na primeira mudança da regra. */}
                  {row.status === 'active' && (
                    <button
                      type="button"
                      disabled={busy}
                      title="Marcar este objetivo como feito"
                      onClick={() =>
                        void act(() =>
                          agent.setQuestProgress(row.playerQuestId, {
                            objectiveSeq: objective.seq,
                            value: objective.need,
                            actor: 'painel',
                            reason: 'ajustado pelo painel',
                          }),
                        )
                      }
                      className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted hover:text-foreground"
                    >
                      completar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-2 border-t border-border pt-2 text-2xs text-muted">
            Aceita em {new Date(row.acceptedAt).toLocaleString('pt-BR')}
            {row.claimedAt !== null &&
              ` · resgatada em ${new Date(row.claimedAt).toLocaleString('pt-BR')}`}
            {row.cooldownUntil !== null &&
              ` · volta em ${new Date(row.cooldownUntil).toLocaleString('pt-BR')}`}
          </p>
        </div>
      ))}
    </div>
  );
}
