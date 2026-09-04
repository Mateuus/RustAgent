'use client';

// ============================================================
//  operations-panel.tsx  -  o que dá para fazer com o servidor.
//
//  ####  O QUE NÃO CABE NO ESTADO NÃO APARECE  ####
//
//  "Iniciar" com o servidor no ar é ruído: ele nunca vai dar
//  certo, e ocupa o lugar do botão que a pessoa procura. Então a
//  lista é filtrada duas vezes:
//
//    1. o CORE diz o que aquele servidor aceita (`kinds`) — sem
//       jogo em disco, só instalar;
//    2. a TELA tira o que o estado do processo torna impossível.
//
//  A segunda camada é conveniência; a primeira é a que vale. O
//  agente continua recusando com a frase certa se alguém chamar a
//  rota na mão — a tela sumir com o botão não é uma trava.
//
//  ####  E O LOG FICA SEMPRE NO MESMO LUGAR  ####
//
//  Embaixo dos botões, com título e estado. Uma área que aparece
//  e some conforme há operação faz a página pular na cara de quem
//  acabou de clicar.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import {
  agent,
  ApiError,
  type OperationDetail,
  type OperationKind,
  type ServerView,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const POLL_MS = 1_000;

/**
 * Quantas falhas seguidas do poll antes de desistir de acompanhar.
 *
 * Cinco segundos de silêncio. Menos que isso e um soluço de rede
 * derrubaria o acompanhamento de uma instalação boa; muito mais e
 * a tela volta a mentir por tempo demais.
 */
const MAX_POLL_FAILURES = 5;

type Group = 'ciclo' | 'instalacao' | 'historico';

const GROUPS: readonly { key: Group; label: string }[] = [
  { key: 'ciclo', label: 'Ciclo de vida' },
  { key: 'instalacao', label: 'Instalação' },
  { key: 'historico', label: 'Histórico' },
];

interface Action {
  readonly kind: OperationKind;
  readonly label: string;
  readonly hint: string;
  readonly group: Exclude<Group, 'historico'>;
  readonly variant: 'primary' | 'outline' | 'danger';
  /** Derruba quem está jogando? Aí vai por confirmação. */
  readonly destructive?: boolean;
  /** Em que estado do PROCESSO este botão faz sentido. */
  readonly needs: 'parado' | 'no-ar' | 'sempre';
}

const ACTIONS: readonly Action[] = [
  {
    kind: 'server-start',
    label: 'Iniciar',
    hint: 'Sobe o RustDedicated e espera o RCON responder. Um mapa procedural leva minutos.',
    group: 'ciclo',
    variant: 'primary',
    needs: 'parado',
  },
  {
    kind: 'server-stop',
    label: 'Parar',
    hint: 'Salva o mundo e encerra pelo RCON. É o único jeito de parar sem perder nada.',
    group: 'ciclo',
    variant: 'danger',
    destructive: true,
    needs: 'no-ar',
  },
  {
    kind: 'server-restart',
    label: 'Reiniciar',
    hint: 'Para salvando e sobe de novo. Derruba quem está jogando.',
    group: 'ciclo',
    variant: 'outline',
    destructive: true,
    needs: 'no-ar',
  },
  {
    kind: 'server-install',
    label: 'Instalar / Atualizar',
    hint: 'SteamCMD + Oxide. A primeira vez baixa ~20 GB; as seguintes só a diferença.',
    group: 'instalacao',
    variant: 'primary',
    needs: 'parado',
  },
  {
    kind: 'server-auto-update',
    label: 'Atualizar avisando',
    hint: 'Avisa no chat, conta o tempo, salva, encerra, atualiza e sobe de novo.',
    group: 'instalacao',
    variant: 'outline',
    destructive: true,
    needs: 'no-ar',
  },
  {
    kind: 'oxide-install',
    label: 'Atualizar o Oxide',
    hint:
      'Baixa a ÚLTIMA release do Oxide e aplica por cima — é assim que se atualiza. Só os ' +
      'assemblies: os plugins e as configurações deles ficam, e a pasta oxide é copiada para Backups antes.',
    group: 'instalacao',
    variant: 'outline',
    needs: 'parado',
  },
];

const LABEL_OF = new Map(ACTIONS.map((action) => [action.kind, action.label]));

function labelOf(kind: OperationKind): string {
  return LABEL_OF.get(kind) ?? kind;
}

const STATUS_LABEL: Record<string, string> = {
  running: 'rodando',
  succeeded: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada',
};

/**
 * O desfecho, como a tela o chama.
 *
 * ####  "ADIADA" NÃO É UM STATUS DO CORE  ####
 *
 * É `failed` mais `deferred` (ver api.ts): a operação desistiu
 * ANTES de tocar em qualquer coisa, porque o Oxide ainda não
 * lançou a versão do build novo do Rust. Contar as duas como a
 * mesma coisa é o que fazia a tela pedir socorro — badge em
 * vermelho, aviso permanente — por uma espera de meia hora que o
 * agente resolve sozinho.
 */
function statusLabel(status: string, deferred?: boolean): string {
  if (status === 'failed' && deferred === true) {
    return 'adiada';
  }

  return STATUS_LABEL[status] ?? status;
}

/** Vermelho é para o que quebrou; a espera é âmbar, como o que corre. */
function statusTone(status: string, deferred?: boolean): string {
  if (status === 'failed') {
    return deferred === true ? 'text-amber' : 'text-rust';
  }

  return status === 'running' ? 'text-amber' : 'text-muted';
}

export function OperationsPanel({ server }: { server: ServerView }) {
  const [group, setGroup] = useState<Group>('ciclo');
  const [kinds, setKinds] = useState<OperationKind[]>([]);
  const [history, setHistory] = useState<
    { id: string; kind: OperationKind; status: string; startedAt: string; deferred?: boolean }[]
  >([]);
  const [operation, setOperation] = useState<OperationDetail | null>(null);
  const [lines, setLines] = useState<{ n: number; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ####  QUANDO O ACOMPANHAMENTO MORRE  ####
  //
  // Não é a operação que falhou: é a LEITURA dela que parou de
  // funcionar. O agente reiniciou e perdeu o histórico (ele mora
  // em memória), ou a sessão caiu junto. O que estava em curso
  // pode muito bem ter continuado — o servidor de Rust não é
  // filho do agente e segue subindo sozinho.
  //
  // Guardar isso à parte é o que impede a tela de ficar presa em
  // "running" para sempre, batendo de segundo em segundo numa
  // operação que ela não pode mais ler.
  const [lost, setLost] = useState<string | null>(null);

  const cursor = useRef(0);
  /** Falhas seguidas do poll. Uma sozinha pode ser só um soluço. */
  const failures = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const serverId = server.id;

  const follow = useCallback(async (operationId: string) => {
    try {
      const response = await agent.operation(operationId, cursor.current);

      cursor.current = response.operation.nextLine;
      setOperation(response.operation);
      setLines((previous) => [
        ...previous,
        ...response.operation.lines.map(({ n, text }) => ({ n, text })),
      ]);
      setError(null);
      failures.current = 0;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause instanceof ApiError ? cause.code : null;
      const status = cause instanceof ApiError ? cause.status : null;

      failures.current += 1;

      // O agente reiniciou: a operação não existe mais para ele.
      if (code === 'UNKNOWN_OPERATION' || status === 404) {
        setLost(
          'O agente reiniciou e perdeu o registro desta operação — o histórico dele mora ' +
            'em memória. O que estava em curso PODE ter continuado: confira a situação do ' +
            'servidor antes de disparar de novo.',
        );
        setError(null);

        return;
      }

      // A sessão caiu. O `api.ts` já avisou o SessionProvider, que
      // manda para /entrar; aqui só se desliga o relógio para não
      // bater mais uma vez por segundo até a tela trocar.
      if (status === 401) {
        setLost(
          'A sessão caiu (o agente reiniciou). Entre de novo para voltar a acompanhar.',
        );
        setError(null);

        return;
      }

      // Rede instável, agente fora do ar por um instante. Insiste um
      // pouco antes de desistir — mas DESISTE, em vez de bater para
      // sempre numa porta que não abre.
      if (failures.current >= MAX_POLL_FAILURES) {
        setLost(
          `Perdi o contato com o agente (${String(MAX_POLL_FAILURES)} tentativas seguidas): ` +
            `${message}. A operação pode ter continuado.`,
        );
        setError(null);

        return;
      }

      setError(message);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await agent.operations(serverId);

      setKinds(response.kinds);
      setHistory(
        response.operations.map((item) => ({
          id: item.id,
          kind: item.kind,
          status: item.status,
          startedAt: item.startedAt,
          deferred: item.deferred,
        })),
      );

      // Adota a operação em curso: quem recarrega a página no meio
      // de uma instalação de uma hora precisa ver o log continuar.
      const running = response.operations.find((item) => item.status === 'running');

      setOperation((current) => {
        if (current !== null || running === undefined) {
          return current;
        }

        cursor.current = 0;
        failures.current = 0;
        setLost(null);
        setLines([]);
        void follow(running.id);

        return current;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId, follow]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (operation === null || operation.status !== 'running' || lost !== null) {
      return;
    }

    const timer = setInterval(() => void follow(operation.id), POLL_MS);

    return () => clearInterval(timer);
  }, [operation, follow, lost]);

  const status = operation?.status;
  const finished = operation?.message ?? undefined;
  const deferred = operation?.deferred === true;

  useEffect(() => {
    if (status === undefined || status === 'running') {
      return;
    }

    void load();

    if (status === 'succeeded') {
      toast.success('Operação concluída');
    } else if (status === 'failed') {
      // O adiamento não é um erro, e o aviso que não some sozinho
      // (`duration: null`) é para o que exige alguém agir. Aqui
      // ninguém precisa agir: o agente tenta de novo na próxima
      // rodada do vigia.
      if (deferred) {
        toast.warning('Atualização adiada', { description: finished, duration: 12_000 });
      } else {
        toast.error('A operação falhou', { description: finished, duration: null });
      }
    } else {
      toast.warning('Operação cancelada');
    }
  }, [status, finished, deferred, load]);

  useEffect(() => {
    if (stickToBottom.current && logRef.current !== null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  async function start(kind: OperationKind): Promise<void> {
    setError(null);

    try {
      const response = await agent.startOperation(serverId, kind);

      cursor.current = 0;
      failures.current = 0;
      setLost(null);
      setLines([]);
      await follow(response.operationId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('A operação não pôde começar', { description: message });
      setError(message);
    }
  }

  // Perdido o acompanhamento, a tela NÃO pode continuar tratando a
  // operação como viva: era isso que deixava os botões travados.
  const running = operation?.status === 'running' && lost === null;
  const up = server.running === true;

  // As duas peneiras: o que o core aceita, e o que o estado do
  // processo torna possível. Ver o cabeçalho.
  const available = ACTIONS.filter(
    (action) =>
      kinds.includes(action.kind) &&
      (action.needs === 'sempre' || (action.needs === 'no-ar' ? up : !up)),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-stretch border border-border bg-surface">
        {GROUPS.map((item, index) => (
          <div key={item.key} className="flex items-stretch">
            {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

            <button
              type="button"
              onClick={() => setGroup(item.key)}
              className={cn(
                'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                group === item.key
                  ? 'bg-surface-2 text-foreground'
                  : 'text-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>

      {group !== 'historico' && (
        <div className="border border-border bg-surface">
          {available.filter((action) => action.group === group).length === 0 ? (
            <div className="p-4">
              <StateBlock
                variant="empty"
                title="Nada a fazer aqui neste estado"
                detail={
                  up
                    ? 'O servidor está no ar. Pare-o para instalar, atualizar ou reinstalar o Oxide.'
                    : 'O servidor está parado. Inicie-o para ter as operações que falam com o jogo.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {available
                .filter((action) => action.group === group)
                .map((action) => (
                  <li key={action.kind} className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                        {action.label}
                      </p>
                      <p className="mt-0.5 text-2xs leading-relaxed text-muted">{action.hint}</p>
                    </div>

                    {action.destructive === true ? (
                      <ConfirmButton
                        variant="danger"
                        disabled={running}
                        icon={null}
                        label={action.label}
                        confirmLabel="Confirmar"
                        hint="Isso derruba quem estiver jogando. O mundo é salvo antes."
                        onConfirm={() => void start(action.kind)}
                      />
                    ) : (
                      <Button
                        variant={action.variant}
                        disabled={running}
                        onClick={() => void start(action.kind)}
                      >
                        {action.label}
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {group === 'historico' && (
        <div className="border border-border bg-surface">
          {history.length === 0 ? (
            <div className="p-4">
              <StateBlock
                variant="empty"
                title="Nenhuma operação nesta sessão"
                detail="O histórico guarda as 20 últimas e some quando o agente reinicia — ele não é registro de auditoria, é o que aconteceu desde que o agente subiu."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      cursor.current = 0;
                      setLines([]);
                      void follow(item.id);
                    }}
                    className="flex w-full items-center justify-between gap-4 px-4 py-2 text-left hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{labelOf(item.kind)}</span>
                      <span className="block text-2xs text-muted">
                        {new Date(item.startedAt).toLocaleString('pt-BR')}
                      </span>
                    </span>

                    <span
                      className={cn(
                        'shrink-0 text-2xs uppercase tracking-wider',
                        statusTone(item.status, item.deferred),
                      )}
                    >
                      {statusLabel(item.status, item.deferred)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lost !== null && (
        <StateBlock variant="offline" title="Perdi o acompanhamento" detail={lost} />
      )}

      {error !== null && <StateBlock variant="error" title="Não deu" detail={error} />}

      {/* O log fica SEMPRE aqui, com ou sem operação: uma área que
          aparece e some faz a página pular na cara de quem clicou. */}
      <div className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            {operation === null
              ? 'Console da operação'
              : `${labelOf(operation.kind)} — ${
                  lost === null
                    ? statusLabel(operation.status, operation.deferred)
                    : 'acompanhamento perdido'
                }${operation.progress === null ? '' : ` · ${operation.progress.toFixed(1)}%`}`}
          </span>

          {running && operation !== null && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => void agent.cancelOperation(operation.id)}
            >
              Cancelar
            </Button>
          )}
        </div>

        {operation?.progress != null && (
          <div className="h-1 w-full bg-surface-2">
            <div className="h-1 bg-rust" style={{ width: `${String(operation.progress)}%` }} />
          </div>
        )}

        <div
          ref={logRef}
          onScroll={(event) => {
            const element = event.currentTarget;

            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
          className="h-72 overflow-y-auto bg-background p-3 font-mono text-2xs leading-relaxed text-muted"
        >
          {lines.length === 0 ? (
            <p>
              Nada rodando. Ao disparar uma operação, a saída do SteamCMD e do agente aparece aqui,
              linha a linha.
            </p>
          ) : (
            lines.map((line) => (
              <div key={line.n} className="whitespace-pre-wrap">
                {line.text}
              </div>
            ))
          )}
        </div>

        {operation !== null && operation.droppedLines > 0 && (
          <p className="border-t border-border px-4 py-2 text-2xs text-muted">
            {operation.droppedLines} linha(s) mais antigas foram descartadas — o log guarda as 2000
            últimas.
          </p>
        )}

        {operation?.message != null && (
          <p className="border-t border-border px-4 py-2 text-sm">{operation.message}</p>
        )}
      </div>
    </div>
  );
}
