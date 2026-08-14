'use client';

// ============================================================
//  operations-panel.tsx  -  os botões e o log ao vivo.
//
//  ####  OS BOTÕES SÃO OS QUE O CORE PERMITE  ####
//
//  A lista vem de `GET /api/servers/:id/operations` (campo
//  `kinds`). A tela não adivinha nem esconde: um servidor sem
//  jogo em disco recebe só "Instalar", e é isso que aparece.
//
//  ####  O LOG É INCREMENTAL  ####
//
//  Cada rodada manda o `nextLine` da anterior e recebe só o que
//  chegou. Uma instalação imprime dezenas de milhares de linhas;
//  baixar tudo a cada segundo seria megabytes por minuto para
//  mostrar as últimas trinta.
//
//  A rolagem automática PARA quando a pessoa sobe. Sem isso, não
//  dá para ler a linha de erro que passou.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { agent, type OperationDetail, type OperationKind } from '@/lib/api';

/** Enquanto há operação rodando. Parado, o log não muda. */
const POLL_MS = 1_000;

const LABEL: Record<OperationKind, string> = {
  'server-install': 'Instalar / Atualizar',
  'server-update': 'Atualizar',
  'server-start': 'Iniciar',
  'server-stop': 'Parar',
  'server-restart': 'Reiniciar',
  'server-auto-update': 'Atualizar avisando',
  'oxide-install': 'Reinstalar Oxide',
};

/** A ordem em que os botões aparecem, e não a do enum. */
const ORDER: OperationKind[] = [
  'server-install',
  'server-start',
  'server-stop',
  'server-restart',
  'server-auto-update',
  'oxide-install',
  'server-update',
];

export function OperationsPanel({ serverId }: { serverId: string }) {
  const [kinds, setKinds] = useState<OperationKind[]>([]);
  const [operation, setOperation] = useState<OperationDetail | null>(null);
  const [lines, setLines] = useState<{ n: number; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cursor = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const follow = useCallback(async (operationId: string) => {
    try {
      const response = await agent.operation(operationId, cursor.current);
      const detail = response.operation;

      cursor.current = detail.nextLine;

      setOperation(detail);
      setLines((previous) => [...previous, ...detail.lines.map(({ n, text }) => ({ n, text }))]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadKinds = useCallback(async () => {
    try {
      const response = await agent.operations(serverId);

      setKinds(response.kinds);

      // Uma operação em curso é adotada: quem recarrega a página
      // no meio de uma instalação de uma hora precisa ver o log
      // continuar, e não um painel vazio.
      const running = response.operations.find((item) => item.status === 'running');

      if (running !== undefined) {
        setOperation((current) => {
          if (current !== null) {
            return current;
          }

          cursor.current = 0;
          setLines([]);
          void follow(running.id);

          return current;
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId, follow]);

  useEffect(() => {
    void loadKinds();
  }, [loadKinds]);

  useEffect(() => {
    if (operation === null || operation.status !== 'running') {
      return;
    }

    const timer = setInterval(() => void follow(operation.id), POLL_MS);

    return () => clearInterval(timer);
  }, [operation, follow]);

  // Terminou: os botões mudam (instalado agora aceita iniciar).
  const status = operation?.status;

  useEffect(() => {
    if (status !== undefined && status !== 'running') {
      void loadKinds();
    }
  }, [status, loadKinds]);

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
      setLines([]);
      await follow(response.operationId);
    } catch (cause) {
      // A recusa vem com a frase do core: "o SteamCMD já está
      // ocupado com…", "o servidor está no ar…".
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const running = operation?.status === 'running';

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {ORDER.filter((kind) => kinds.includes(kind)).map((kind) => (
          <Button
            key={kind}
            variant={kind === 'server-install' || kind === 'server-start' ? 'primary' : 'outline'}
            disabled={running}
            onClick={() => {
              if (kind === 'server-stop' || kind === 'server-restart') {
                if (
                  !confirm('Isso derruba quem estiver jogando. O mundo é salvo antes. Confirma?')
                ) {
                  return;
                }
              }

              void start(kind);
            }}
          >
            {LABEL[kind]}
          </Button>
        ))}
      </div>

      {error !== null && <p className="mb-4 border border-rust bg-surface-2 p-3 text-sm">{error}</p>}

      {operation !== null && (
        <div className="border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="font-condensed text-sm uppercase tracking-wide">
              {LABEL[operation.kind]} — {operation.status}
              {operation.progress !== null && ` · ${operation.progress.toFixed(1)}%`}
            </span>

            {running && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => void agent.cancelOperation(operation.id)}
              >
                Cancelar
              </Button>
            )}
          </div>

          {operation.progress !== null && (
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
            className="h-80 overflow-y-auto bg-background p-3 font-mono text-2xs leading-relaxed text-muted"
          >
            {lines.map((line) => (
              <div key={line.n} className="whitespace-pre-wrap">
                {line.text}
              </div>
            ))}
          </div>

          {operation.droppedLines > 0 && (
            <p className="border-t border-border px-4 py-2 text-2xs text-muted">
              {operation.droppedLines} linha(s) mais antigas foram descartadas — o log guarda as
              2000 últimas.
            </p>
          )}

          {operation.message !== null && (
            <p className="border-t border-border px-4 py-2 text-sm">{operation.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
