'use client';

// ============================================================
//  tab-execucao.tsx  -  "o que aconteceu, passo a passo — e como
//  retomo o que falhou?"
//
//  ####  É A ÚNICA TELA DO PAINEL QUE APAGA O JOGO DE TODO MUNDO  ####
//
//  E o desenho inteiro sai disso:
//
//    1. a LISTA DO QUE VAI SUMIR vem antes do botão, lida do disco
//       de verdade — e não um texto fixo dizendo o que deveria
//       estar lá;
//    2. o botão exige o `identity` DIGITADO. Não é "tem certeza?":
//       é o que o GitHub pede para apagar um repositório, e pelo
//       mesmo motivo — qualquer confirmação mais fraca é vencida
//       por um duplo-clique distraído;
//    3. a `Idempotency-Key` nasce quando o formulário abre e só
//       muda quando o admin desiste e volta. Dois cliques no mesmo
//       formulário são a MESMA intenção, e o agente devolve a
//       execução que já começou.
//
//  ####  O LOG É INCREMENTAL, COMO O DE OPERAÇÕES  ####
//
//  `?fromLine=N` traz só o que chegou depois do cursor. E ele vive
//  na memória do agente: depois de um reinício ele some, e o que
//  sobra são os passos, que estão no banco. O campo `live` da
//  resposta diz qual dos dois casos é — sem ele, a tela mostraria
//  um console vazio como se fosse silêncio.
// ============================================================

import {
  AlertTriangle,
  Check,
  CircleDashed,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { stepDuration } from '@/components/wipe/labels';
import {
  agent,
  type WipeClassifiedFile,
  type WipePreviewResponse,
  type WipeRun,
  type WipeRunLogLine,
  type WipeRunStepView,
  type WipeStepStatus,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** De quanto em quanto tempo a tela relê uma execução em curso. */
const LIVE_POLL_MS = 2_000;

export function TabExecucao({ serverId }: { readonly serverId: string }) {
  const [preview, setPreview] = useState<WipePreviewResponse | null>(null);
  const [runs, setRuns] = useState<readonly WipeRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [next, history] = await Promise.all([
        agent.wipePreview(serverId),
        agent.wipeRuns(serverId),
      ]);

      setPreview(next);
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

  const running = runs.find((run) => run.status === 'running') ?? null;

  const start = useCallback(
    async (identity: string, idempotencyKey: string) => {
      setBusy(true);

      try {
        const response = await agent.startWipeRun(serverId, { identity, idempotencyKey });

        toast.success('Wipe disparado', { description: response.message });
        await load();
      } catch (cause) {
        toast.error('O wipe NÃO começou', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(false);
      }
    },
    [load, serverId],
  );

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

  const cancel = useCallback(
    async (runId: number) => {
      setBusy(true);

      try {
        const response = await agent.cancelWipeRun(serverId, runId);

        toast.success('Cancelamento pedido', { description: response.message });
        await load();
      } catch (cause) {
        toast.error('Não deu para cancelar', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(false);
      }
    },
    [load, serverId],
  );

  if (loading) {
    return <StateBlock variant="loading" title="Lendo o disco deste servidor…" />;
  }

  if (error !== null) {
    return (
      <StateBlock
        variant="error"
        title="Não consegui ler o estado da execução."
        detail={
          <>
            {error} Enquanto isto não responder, o botão de wipar fica fora do ar — disparar sem a
            lista do que vai sumir seria apagar às cegas.
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {running !== null && (
        <RunningRun
          serverId={serverId}
          run={running}
          busy={busy}
          onCancel={() => void cancel(running.id)}
          onFinished={() => void load()}
        />
      )}

      {running === null && preview !== null && (
        <StartWipe preview={preview} busy={busy} onStart={start} />
      )}

      <History runs={runs} busy={busy} onResume={(id) => void resume(id)} />
    </div>
  );
}

// ------------------------------------------------------------
//  EM ANDAMENTO
// ------------------------------------------------------------

function RunningRun({
  serverId,
  run,
  busy,
  onCancel,
  onFinished,
}: {
  readonly serverId: string;
  readonly run: WipeRun;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onFinished: () => void;
}) {
  const [current, setCurrent] = useState<WipeRun>(run);
  const [lines, setLines] = useState<readonly WipeRunLogLine[]>([]);
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState(true);

  /** O cursor do log. Numa ref porque o laço não pode reiniciar por ele. */
  const cursor = useRef(0);
  const finished = useRef(false);

  useEffect(() => {
    let alive = true;

    const tick = async (): Promise<void> => {
      try {
        const response = await agent.wipeRun(serverId, run.id, cursor.current);

        if (!alive) {
          return;
        }

        cursor.current = response.nextLine;
        setCurrent(response.run);
        setLive(response.live);
        setLines((before) => [...before, ...response.lines].slice(-400));

        if (response.run.status !== 'running' && !finished.current) {
          // Uma vez só: sem esta trava, a tela recarregaria o
          // histórico a cada dois segundos para sempre depois que a
          // execução terminasse.
          finished.current = true;
          onFinished();
        }
      } catch {
        // O relógio da tela NÃO reclama: o agente pode estar
        // reiniciando o servidor neste exato segundo, e um toast de
        // erro a cada dois segundos esconderia o que interessa.
      }
    };

    void tick();

    const timer = setInterval(() => {
      void tick();
    }, LIVE_POLL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [onFinished, run.id, serverId]);

  return (
    <Section
      title={`Wipe #${String(current.id)} · ${describeKind(current)} · ${clock(current.startedAt)}`}
      aside={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? 'esconder o log' : 'ver o log'}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={onCancel}>
            <X aria-hidden className="mr-1 h-3 w-3" />
            cancelar
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Steps steps={current.steps} />

        {!live && (
          <StateBlock
            variant="offline"
            title="O log ao vivo desta execução não existe mais."
            detail="O agente reiniciou depois de ela começar. Os passos acima vêm do banco e continuam valendo — o que se perdeu foi o console linha a linha."
          />
        )}

        {open && lines.length > 0 && (
          <pre className="max-h-64 overflow-auto border border-border bg-background p-2 text-2xs leading-relaxed text-muted">
            {lines.map((line) => `${clock(line.at)}  ${line.text}`).join('\n')}
          </pre>
        )}
      </div>
    </Section>
  );
}

/**
 * Os oito passos, com o estado de cada um e a frase do que ele fez.
 *
 * ####  O RELÓGIO É O DA TENTATIVA QUE ESTÁ NA TELA  ####
 *
 * Numa retomada, o passo roda de novo: `startedAt` guarda a
 * primeira vez (é o que responde "quando este wipe atacou este
 * passo") e `attemptStartedAt` guarda a vez que produziu o ✔ ao
 * lado. Mostrar o primeiro faria a linha dizer que o passo começou
 * antes do crash e terminou depois da retomada — uma duração que é
 * o tempo em que o agente esteve MORTO. Quando os dois diferem, o
 * primeiro começo vai no `title`, que é onde ele não engana ninguém.
 */
function Steps({ steps }: { readonly steps: readonly WipeRunStepView[] }) {
  return (
    <ol className="space-y-1">
      {steps.map((step) => (
        <li key={step.step} className="flex items-start gap-2 text-sm">
          <StepIcon status={step.status} />
          <span
            className={cn(
              'w-24 shrink-0 font-condensed text-2xs font-bold uppercase tracking-wide',
              step.status === 'pending' ? 'text-muted' : 'text-foreground',
            )}
          >
            {step.step}
          </span>
          <span
            className="w-16 shrink-0 text-2xs text-muted"
            title={
              step.startedAt === null || step.startedAt === step.attemptStartedAt
                ? undefined
                : `primeira tentativa às ${clock(step.startedAt)}`
            }
          >
            {step.attemptStartedAt === null ? '' : clock(step.attemptStartedAt)}
          </span>
          <span className="w-14 shrink-0 text-right text-2xs text-muted">
            {stepDuration(step)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 text-xs',
              step.status === 'failed' ? 'text-foreground' : 'text-muted',
            )}
          >
            {step.message ?? ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ status }: { readonly status: WipeStepStatus }) {
  const className = 'mt-0.5 h-4 w-4 shrink-0';

  if (status === 'running') {
    return <Loader2 aria-label="em andamento" className={cn(className, 'animate-spin text-amber')} />;
  }

  if (status === 'done') {
    return <Check aria-label="feito" className={cn(className, 'text-olive')} />;
  }

  if (status === 'failed') {
    return <X aria-label="falhou" className={cn(className, 'text-rust')} />;
  }

  // `skipped` e `pending` compartilham o cinza: nenhum dos dois é
  // falha, e a frase ao lado diz qual dos dois é.
  return <CircleDashed aria-label={status === 'skipped' ? 'pulado' : 'na fila'} className={cn(className, 'text-muted')} />;
}

// ------------------------------------------------------------
//  WIPAR AGORA
// ------------------------------------------------------------

function StartWipe({
  preview,
  busy,
  onStart,
}: {
  readonly preview: WipePreviewResponse;
  readonly busy: boolean;
  readonly onStart: (identity: string, idempotencyKey: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');

  /**
   * A chave da requisição.
   *
   * Ela nasce com o formulário e NÃO muda a cada clique: dois
   * cliques no mesmo formulário são a mesma intenção, e é isso que
   * o agente usa para devolver a execução que já começou em vez de
   * começar uma segunda.
   */
  const key = useRef(newKey());

  const blocked = preview.blockers.length > 0;
  const matches = typed.trim() === preview.server.identity;
  const gone = preview.files.files.filter((file) => file.fate === 'delete');
  const kept = preview.files.files.filter((file) => file.fate === 'keep');

  return (
    <div className="space-y-4">
      {preview.blockers.map((notice) => (
        <StateBlock
          key={notice.code}
          variant="error"
          title="Este wipe não pode começar assim."
          detail={notice.message}
        />
      ))}

      {preview.warnings.map((notice) => (
        <StateBlock
          key={notice.code}
          variant="empty"
          title="Antes de seguir:"
          detail={notice.message}
        />
      ))}

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={`O que vai sumir (${String(gone.length)} arquivos · ${mb(preview.files.deletedBytes)})`}>
          {gone.length === 0 ? (
            <StateBlock
              variant="empty"
              title="Nada a apagar nesta pasta."
              detail={`O agente não achou arquivo de mundo em ${preview.files.path}. Se o servidor nunca subiu, é o esperado.`}
            />
          ) : (
            <FileList files={gone} />
          )}
        </Section>

        <Section title={`O que FICA (${String(kept.length)} arquivos)`}>
          <FileList files={kept} />
        </Section>
      </div>

      <Section title="Wipar agora">
        <div className="space-y-3">
          <p className="text-sm text-muted">
            O agente vai avisar no chat, esperar o servidor esvaziar, parar, {' '}
            {preview.backup.enabled ? 'copiar o save' : 'NÃO copiar o save'}, apagar o mundo,
            escrever a seed nova e subir. Blueprints:{' '}
            <strong className="text-foreground">{describePolicy(preview.bpPolicy)}</strong>.
          </p>

          <div className="max-w-md space-y-1">
            <Label htmlFor="wipe-identity">
              Digite o identity do servidor para confirmar: {preview.server.identity}
            </Label>
            <Input
              id="wipe-identity"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder={preview.server.identity}
              onChange={(event) => setTyped(event.target.value)}
            />
            <p className="text-2xs text-muted">
              Não é frescura: um &quot;tem certeza?&quot; é vencido por um duplo-clique distraído, e
              isto apaga o trabalho de todos os jogadores.
            </p>
          </div>

          <Button
            variant="danger"
            disabled={busy || blocked || !matches}
            onClick={() => {
              void onStart(typed.trim(), key.current);
            }}
          >
            <Play aria-hidden className="mr-1 h-4 w-4" />
            wipar agora
          </Button>
        </div>
      </Section>
    </div>
  );
}

function FileList({ files }: { readonly files: readonly WipeClassifiedFile[] }) {
  return (
    <ul className="max-h-72 space-y-1 overflow-auto">
      {files.map((file) => (
        <li key={file.name} className="border-b border-border pb-1 last:border-0">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                'min-w-0 break-all font-mono text-2xs',
                file.fate === 'delete' ? 'text-foreground' : 'text-muted',
              )}
            >
              {file.name}
            </span>
            <span className="shrink-0 text-2xs text-muted">{mb(file.bytes)}</span>
          </div>
          {/* Todo arquivo sai com o motivo escrito: uma lista de
              nomes sem explicação não é uma lista que alguém possa
              conferir antes de autorizar. */}
          <p className="text-2xs text-muted">{file.reason}</p>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------
//  HISTÓRICO
// ------------------------------------------------------------

function History({
  runs,
  busy,
  onResume,
}: {
  readonly runs: readonly WipeRun[];
  readonly busy: boolean;
  readonly onResume: (runId: number) => void;
}) {
  const past = runs.filter((run) => run.status !== 'running');

  return (
    <Section title="Histórico">
      {past.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Este servidor ainda não zerou pelo agente."
          detail="Quando o primeiro wipe rodar, ele fica aqui — com os passos, o log e o mundo que nasceu."
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
              <span className="text-xs text-muted">{stamp(run.startedAt)}</span>
              <span className="text-xs text-muted">{describeKind(run)}</span>
              <RunStatus run={run} />
              {run.mapAfter !== null && (
                <span className="text-xs text-muted">
                  {run.mapAfter.level ?? 'Procedural Map'}
                  {run.mapAfter.seed === null ? '' : ` · seed ${run.mapAfter.seed}`}
                </span>
              )}
              <span className="text-xs text-muted">BP {describePolicy(run.bpPolicy)}</span>

              {run.status === 'failed' && (
                <Button size="sm" disabled={busy} onClick={() => onResume(run.id)}>
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

function RunStatus({ run }: { readonly run: WipeRun }) {
  if (run.status === 'done') {
    const minutes =
      run.finishedAt === null ? null : Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000));

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

// ------------------------------------------------------------
//  Formatação
// ------------------------------------------------------------

function describeKind(run: WipeRun): string {
  if (run.kind === 'forced') return 'forçado';
  if (run.kind === 'cadence') return 'cadência';

  return 'manual';
}

function describePolicy(policy: string): string {
  if (policy === 'keep') return 'mantidos';
  if (policy === 'wipe') return 'apagados';

  return 'apagados, devolvidos a quem tem VIP';
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('pt-BR', { hour12: false });
}

function stamp(at: number): string {
  return new Date(at).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
  }

  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/**
 * Uma chave por formulário aberto.
 *
 * `randomUUID` só existe em contexto seguro (https ou localhost); o
 * painel roda nos dois, e o `Math.random` de reserva é bom o
 * bastante para o que a chave precisa ser — diferente da anterior.
 */
function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `wipe-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}
