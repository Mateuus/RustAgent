'use client';

// ============================================================
//  loadout-panel.tsx  -  o que cada GRUPO recebe ao nascer.
//
//  ####  A LISTA VEM DOS GRUPOS DO OXIDE, E NÃO DE UMA LISTA
//        NOSSA  ####
//
//  Criou um grupo, ele aparece aqui vazio, pronto para receber.
//  Apagou o loadout, ele some do jogo na sincronização seguinte —
//  porque o payload empurrado é o estado COMPLETO, e o grupo
//  simplesmente não estará nele.
//
//  Por isso esta sub-aba fica ao lado de Oxide: lá se decide QUEM
//  está em cada grupo, aqui o que cada grupo GANHA.
//
//  ####  O SERVIDOR PARADO NÃO IMPEDE CONFIGURAR  ####
//
//  O loadout é nosso, mora no SQLite, e gravá-lo com o servidor
//  fora do ar é legítimo: ele chega ao jogo na próxima conexão. O
//  que a tela não pode é dizer "pronto" e deixar a pessoa achando
//  que já valeu — daí a frase do `sync` em toda resposta.
// ============================================================

import { RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { itemsProblem, LoadoutEditor } from '@/components/loadout-editor';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Toggle } from '@/components/ui/toggle';
import { agent, type LoadoutItem, type ServerLoadout } from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';

export function LoadoutPanel({ serverId }: { readonly serverId: string }) {
  const [groups, setGroups] = useState<ServerLoadout[] | null>(null);
  const [connected, setConnected] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Qual grupo está aberto para edição. `null` = nenhum. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoadoutItem[]>([]);
  const [draftEnabled, setDraftEnabled] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await agent.loadouts(serverId);

      setGroups(response.groups);
      setConnected(response.connected);
      setMessage(response.message ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function open(group: ServerLoadout): void {
    setEditing(group.name);
    setDraft([...group.items]);
    setDraftEnabled(group.enabled);
  }

  async function save(group: string): Promise<void> {
    const problem = itemsProblem(draft);

    if (problem !== null) {
      toast.error('Confira os itens', { description: problem });
      return;
    }

    setBusy(true);

    try {
      const response = await agent.saveLoadout(serverId, group, {
        items: draft,
        enabled: draftEnabled,
      });

      toast.success('Loadout gravado', { description: response.message });
      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(group: string): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeLoadout(serverId, group);

      toast.success('Loadout apagado', { description: response.message });
      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function sync(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.syncLoadouts(serverId);

      toast.success('Estado empurrado', { description: response.message });
    } catch (cause) {
      toast.error('Não consegui empurrar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface px-3 py-2">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          A lista vem dos <strong>grupos do Oxide</strong> deste servidor. Grupo novo aparece vazio;
          loadout apagado some do jogo na sincronização seguinte, porque o que o agente empurra é o
          estado completo.
        </p>

        <Button variant="outline" size="sm" disabled={busy} onClick={() => void sync()}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Reempurrar agora
        </Button>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler os loadouts" detail={error} />
      )}

      {message !== null && (
        <StateBlock
          variant={connected ? 'empty' : 'offline'}
          title={connected ? 'Atenção' : 'Servidor fora do ar'}
          detail={message}
        />
      )}

      {groups === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

      {groups !== null && groups.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum grupo por aqui"
          detail="Os grupos vêm do Oxide deste servidor. Os de VIP nascem com o OrigemZVip; os outros, em Configurações → Oxide."
        />
      )}

      {groups?.map((group) => (
        <div key={group.name} className="border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
                <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
                <span className="truncate font-mono normal-case tracking-normal">{group.name}</span>
              </p>

              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                <span>
                  {group.items.length === 0
                    ? 'sem loadout'
                    : `${String(group.items.length)} item(ns)`}
                </span>

                {group.members !== null && (
                  <span className="inline-flex items-center gap-1">
                    <Users aria-hidden="true" className="h-3 w-3" />
                    {group.members} dentro
                  </span>
                )}

                <span>
                  {group.updatedAt === null ? EM_DASH : `alterado ${formatWhen(group.updatedAt)}`}
                  {group.updatedBy === null ? '' : ` por ${group.updatedBy}`}
                </span>

                {/* ####  ÓRFÃO É INFORMAÇÃO, NÃO ERRO  ####

                    O grupo sumiu do Oxide e o loadout continua
                    guardado. Apagar sozinho jogaria fora meia hora
                    de montagem por causa de um `oxide.group remove`
                    que talvez tenha sido engano. */}
                {group.exists === false && (
                  <span className="text-amber">
                    o grupo não existe mais no Oxide — este loadout não vai para o jogo
                  </span>
                )}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {!group.enabled && <span className="text-2xs text-amber">desligado</span>}

              <Button
                variant={editing === group.name ? 'outline' : 'primary'}
                size="sm"
                disabled={busy}
                onClick={() => (editing === group.name ? setEditing(null) : open(group))}
              >
                {editing === group.name
                  ? 'Fechar'
                  : group.items.length === 0
                    ? 'Criar loadout'
                    : 'Editar'}
              </Button>
            </div>
          </div>

          {editing === group.name && (
            <div className="space-y-3 p-3">
              <LoadoutEditor items={draft} onChange={setDraft} disabled={busy} />

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <div className="flex items-center gap-3">
                  <Toggle
                    on={draftEnabled}
                    busy={busy}
                    labels={['Ligado', 'Desligado']}
                    onChange={setDraftEnabled}
                  />
                  <span className="max-w-72 text-2xs leading-relaxed text-muted">
                    Desligado, o loadout continua guardado aqui e{' '}
                    <strong>não vai para o jogo</strong>.
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {group.items.length > 0 && (
                    <ConfirmButton
                      variant="danger"
                      disabled={busy}
                      icon={null}
                      label="Apagar"
                      confirmLabel="Apagar mesmo"
                      hint={`Quem nascer em "${group.name}" deixa de receber qualquer coisa.`}
                      onConfirm={() => void remove(group.name)}
                    />
                  )}

                  <Button variant="primary" disabled={busy} onClick={() => void save(group.name)}>
                    {busy ? 'Gravando…' : 'Gravar'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
