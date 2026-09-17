'use client';

// ============================================================
//  status-bar.tsx  -  o que cada servidor tem de pé AGORA.
//
//  ####  O CADASTRO NÃO É O JOGO  ####
//
//  O catálogo desta tela responde com tudo parado — cadastrar é
//  trabalho de madrugada. O que está VALENDO dentro do jogo é outra
//  pergunta, e ela só o plugin responde. Sem esta faixa, "cadastrei
//  e não aconteceu nada" não tem onde ser investigado.
//
//  ####  FORA DO AR NÃO É ERRO  ####
//
//  Servidor parado é o estado normal de madrugada. Ele aparece em
//  cinza, e não em vermelho: quem vê alerta o tempo todo para de
//  ler alerta.
//
//  ####  DUAS CONTAGENS DE SKIN, E ELAS SÃO PERGUNTAS DIFERENTES  ####
//
//  `skins` é o que o plugin tem carregado neste instante.
//  `confirmadas` é o que ele CONFIRMOU ter recebido no último envio.
//  Divergirem é o sintoma de um `oxide.reload` que ninguém
//  acompanhou — e é exatamente para isso que o botão de mandar a
//  carga de novo existe.
//
//  O resto (de quantos jogadores ele tem a posse na memória e quem
//  está escondendo a logo) é o que o plugin tem de pé: a mesma
//  carga, vista pelo lado do jogo.
// ============================================================

import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import { agent, ApiError, type WorkshopStatus } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface StatusBarProps {
  readonly servers: readonly WorkshopServerOption[];
}

export function StatusBar({ servers }: StatusBarProps) {
  if (servers.length === 0) return null;

  return (
    <div className="divide-y divide-border border border-border bg-surface">
      {servers.map((server) => (
        <ServerStatusRow key={server.id} server={server} />
      ))}
    </div>
  );
}

/** O que a linha sabe. `null` em `status` = ainda não perguntamos. */
interface RowState {
  readonly status: WorkshopStatus | null;
  /** O que o plugin confirmou no último push. `null` = nenhum ainda. */
  readonly applied: number | null;
  /** Por que não deu para perguntar. `null` = deu. */
  readonly reason: string | null;
}

function ServerStatusRow({ server }: { readonly server: WorkshopServerOption }) {
  const [state, setState] = useState<RowState | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Lê e DEVOLVE — quem grava é quem chamou.
   *
   * É o que permite ao efeito jogar fora uma resposta que chegou
   * depois de a tela ter saído, sem duplicar a leitura.
   */
  const read = useCallback(async (): Promise<RowState> => {
    try {
      const response = await agent.workshopStatus(server.id);

      // O agente pode responder sem um dos dois campos — e uma
      // leitura direta aqui derruba a página inteira.
      return {
        status: {
          skins: Number(response.status?.skins ?? 0),
          ownedPlayers: Number(response.status?.ownedPlayers ?? 0),
          streamers: Number(response.status?.streamers ?? 0),
        },
        applied: typeof response.applied === 'number' ? response.applied : null,
        reason: null,
      };
    } catch (cause) {
      return {
        status: null,
        applied: null,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [server.id]);

  useEffect(() => {
    let alive = true;

    void (async () => {
      const next = await read();

      if (alive) setState(next);
    })();

    return () => {
      alive = false;
    };
  }, [read]);

  async function sync(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.syncWorkshop(server.id);

      toast.success(response.outcome === 'unchanged' ? 'Carga já estava lá' : 'Carga enviada', {
        description: server.name,
      });
      setState(await read());
    } catch (cause) {
      // A frase vem do CORE inteira: ela sabe se o RCON caiu, se o
      // plugin não está lá ou se a carga passou do tamanho do
      // frame de console — e a nossa não saberia.
      toast.error('Não consegui mandar a carga', {
        description: cause instanceof ApiError ? cause.message : String(cause),
      });
      setState(await read());
    } finally {
      setBusy(false);
    }
  }

  const online = state !== null && state.status !== null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-2xs">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              online ? 'bg-olive' : 'border border-muted',
            )}
          />
          <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
            {server.name}
          </span>
        </span>

        {state === null ? (
          <span className="text-muted">lendo…</span>
        ) : state.status === null ? (
          <span className="text-muted">{state.reason}</span>
        ) : (
          <>
            <Count label="Skins" value={state.status.skins} />
            <Count label="Jogadores com posse" value={state.status.ownedPlayers} />
            <Count label="Escondendo a logo" value={state.status.streamers} />
            <Count label="Confirmadas no último envio" value={state.applied} />
          </>
        )}
      </div>

      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void sync()}
        title="Manda a carga inteira (o catálogo e a posse de quem está online) agora, mesmo que nada tenha mudado. Serve para quem acabou de recarregar o plugin à mão."
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
        )}
        Mandar agora
      </Button>
    </div>
  );
}

function Count({ label, value }: { readonly label: string; readonly value: number | null }) {
  return (
    <span className="text-muted">
      {label}: <span className="font-mono text-foreground">{value ?? '—'}</span>
    </span>
  );
}
