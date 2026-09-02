'use client';

// ============================================================
//  tab-historico.tsx  -  o que já foi zerado, e como.
//
//  ####  POR QUE ISTO SAIU DE "EXECUÇÃO"  ####
//
//  O histórico morava no fim da sub-aba Execução, depois da lista
//  de arquivos que somem e do botão que apaga o servidor. Para
//  conferir se o wipe de ontem rodou era preciso rolar por cima de
//  uma confirmação por identity — e quem só queria consultar
//  desistia antes de chegar lá, ou passava perto demais do gatilho.
//
//  Consultar e destruir são gestos diferentes e agora moram em
//  abas diferentes. O `runId` continua sendo o mesmo do banco: as
//  duas telas leem `GET /wipe/runs`.
//
//  ####  RETOMAR CONTINUA AQUI  ####
//
//  Uma execução que falhou é lida no histórico, e é dali que se
//  decide retomá-la — separar a leitura do conserto obrigaria a
//  voltar para a outra aba com o número do run na cabeça.
// ============================================================

import { AlertTriangle, Check, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, type WipeRun } from '@/lib/api';
import { toast } from '@/lib/toast';

/** Data e hora curtas, no fuso do navegador. */
function stamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** O que aquele wipe fez com os blueprints, em duas palavras. */
const BP_LABEL: Record<WipeRun['bpPolicy'], string> = {
  keep: 'BP mantidos',
  wipe: 'BP zerados',
  wipe_except_vip: 'BP zerados (VIP mantém)',
};

/** De onde veio a ordem. */
const KIND_LABEL: Record<string, string> = {
  forced: 'forçado',
  cadence: 'cadência',
  manual: 'manual',
};

export function TabHistorico({ serverId }: { readonly serverId: string }) {
  const [runs, setRuns] = useState<readonly WipeRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const history = await agent.wipeRuns(serverId);

      setRuns(history.runs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resume = useCallback(
    async (runId: number) => {
      setBusy(true);

      try {
        const response = await agent.resumeWipeRun(serverId, runId);

        toast.success('Retomando', { description: response.message });
        await load();
      } catch (cause) {
        toast.error('Não deu para retomar', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(false);
      }
    },
    [load, serverId],
  );

  if (loading) {
    return <StateBlock variant="loading" title="Lendo o histórico deste servidor…" />;
  }

  if (error !== null) {
    return <StateBlock variant="error" title="Não consegui ler o histórico" detail={error} />;
  }

  // O que está rodando AGORA é assunto da sub-aba Execução, que
  // mostra passo a passo e log ao vivo. Aqui é o que já terminou.
  const past = runs.filter((run) => run.status !== 'running');

  return (
    <Section title="Wipes deste servidor">
      {past.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Este servidor ainda não zerou pelo agente."
          detail="Quando o primeiro wipe rodar, ele fica aqui — com a data, o tipo, o mundo que nasceu e o que foi feito com os blueprints."
        />
      ) : (
        <ul className="space-y-2">
          {past.map((run) => (
            <li
              key={run.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2 text-sm last:border-0"
            >
              <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                #{run.id}
              </span>

              <span className="text-xs tabular-nums text-muted">{stamp(run.startedAt)}</span>
              <span className="text-xs text-muted">{KIND_LABEL[run.kind] ?? run.kind}</span>

              <RunStatus run={run} />

              {run.mapAfter !== null && (
                <span className="text-xs text-muted">
                  {run.mapAfter.level ?? 'Procedural Map'}
                  {run.mapAfter.seed === null ? '' : ` · seed ${run.mapAfter.seed}`}
                </span>
              )}

              <span className="text-xs text-muted">{BP_LABEL[run.bpPolicy]}</span>

              {run.status === 'failed' && (
                <Button
                  size="sm"
                  disabled={busy}
                  title="Retoma do passo em que parou. Todo passo é idempotente."
                  onClick={() => void resume(run.id)}
                >
                  <RotateCcw aria-hidden className="mr-1 h-3 w-3" />
                  retomar
                </Button>
              )}

              {run.message !== null && (
                <span className="w-full text-2xs text-muted">{run.message}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * O desfecho de uma execução.
 *
 * Um wipe que falhou diz EM QUE PASSO parou: "falhou" sozinho não
 * ajuda ninguém a decidir se retoma ou se conserta a máquina antes.
 */
function RunStatus({ run }: { readonly run: WipeRun }) {
  if (run.status === 'done') {
    const minutes =
      run.finishedAt === null
        ? null
        : Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000));

    return (
      <span className="flex items-center gap-1 text-xs text-olive">
        <Check aria-hidden className="h-3 w-3" />
        {minutes === null ? 'concluído' : `${String(minutes)} min`}
      </span>
    );
  }

  if (run.status === 'failed') {
    const stopped = run.steps.find((step) => step.status === 'failed');

    return (
      <span className="flex items-center gap-1 text-xs text-rust">
        <AlertTriangle aria-hidden className="h-3 w-3" />
        falhou{stopped === undefined ? '' : ` em "${stopped.step}"`}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-muted">
      <Trash2 aria-hidden className="h-3 w-3" />
      cancelado
    </span>
  );
}
