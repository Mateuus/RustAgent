'use client';

// ============================================================
//  console-panel.tsx  -  o console do servidor, ao vivo.
//
//  Duas fontes, e a aba deixa claro qual está na tela:
//
//    AO VIVO   o que passa pelo RCON agora. É o mesmo que o
//              console web oficial mostra, e aceita comando
//    ARQUIVO   o fim do -logfile do jogo. Tem o boot e a geração
//              do mapa, e funciona com o RCON fora do ar — é onde
//              se descobre POR QUE um servidor não subiu
//
//  ####  A ROLAGEM PARA QUANDO A PESSOA SOBE  ####
//
//  Mesma regra do log de operação: sem isso, não dá para ler a
//  linha de erro que passou — a tela puxa de volta para o fim a
//  cada segundo.
// ============================================================

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const LIVE_POLL_MS = 1_000;
const FILE_POLL_MS = 5_000;

type Source = 'vivo' | 'arquivo';

interface Line {
  readonly key: string;
  readonly text: string;
  readonly type: string;
}

/** Erro e aviso ganham cor; o resto fica no tom do log. */
function toneOf(type: string): string {
  const lower = type.toLowerCase();

  if (lower.includes('error') || lower.includes('assert')) {
    return 'text-rust';
  }

  if (lower.includes('warn')) {
    return 'text-amber';
  }

  if (lower === 'agent') {
    return 'text-olive';
  }

  return 'text-muted';
}

export function ConsolePanel({ serverId }: { serverId: string }) {
  const [source, setSource] = useState<Source>('vivo');
  const [lines, setLines] = useState<Line[]>([]);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);

  const cursor = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  // Trocar de fonte zera tudo: as duas numeram linhas de jeitos
  // diferentes, e misturar produziria a pergunta mais cara desta
  // tela — "esta linha é de agora ou de duas horas atrás?".
  useEffect(() => {
    cursor.current = 0;
    setLines([]);
    setNotice(null);
  }, [source, serverId]);

  const loadLive = useCallback(async () => {
    try {
      const response = await agent.console(serverId, cursor.current);

      cursor.current = response.nextLine;
      setConnected(response.connected);
      setNotice(response.message ?? null);

      if (response.lines.length > 0) {
        setLines((previous) => [
          ...previous.slice(-800),
          ...response.lines.map((line) => ({
            key: `v${String(line.n)}`,
            text: `${new Date(line.at).toLocaleTimeString('pt-BR')}  ${line.text}`,
            type: line.type,
          })),
        ]);
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  const loadFile = useCallback(async () => {
    try {
      const response = await agent.consoleFile(serverId, 300);

      setNotice(response.message ?? response.path);
      setLines(
        response.lines.map((text, index) => ({
          key: `f${String(index)}`,
          text,
          type: 'Generic',
        })),
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    const run = source === 'vivo' ? loadLive : loadFile;

    void run();

    const timer = setInterval(() => void run(), source === 'vivo' ? LIVE_POLL_MS : FILE_POLL_MS);

    return () => clearInterval(timer);
  }, [source, loadLive, loadFile]);

  useEffect(() => {
    if (stickToBottom.current && logRef.current !== null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();

    const trimmed = command.trim();

    if (trimmed === '') {
      return;
    }

    setSending(true);

    try {
      const response = await agent.rcon(serverId, trimmed);

      // O comando e a resposta entram no log local na hora: a
      // resposta de um comando NÃO passa pelo evento de log do
      // RCON (ela é resposta, não transmissão), e sem isto a tela
      // engoliria justamente o que a pessoa pediu.
      setLines((previous) => [
        ...previous,
        { key: `c${String(Date.now())}`, text: `> ${trimmed}`, type: 'Agent' },
        ...(response.response.trim() === ''
          ? []
          : [
              {
                key: `r${String(Date.now())}`,
                text: response.response.trimEnd(),
                type: 'Generic',
              },
            ]),
      ]);

      setCommand('');
    } catch (cause) {
      toast.error('O comando não foi', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex border border-border">
          {(
            [
              ['vivo', 'Ao vivo'],
              ['arquivo', 'Arquivo do jogo'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSource(key)}
              className={cn(
                'px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                source === key ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {source === 'vivo' && (
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <span
              aria-hidden
              className={cn('h-2 w-2 rounded-full', connected ? 'bg-olive' : 'bg-muted')}
            />
            {connected ? 'RCON conectado' : 'RCON fora do ar'}
          </span>
        )}
      </div>

      {notice !== null && <p className="truncate text-2xs text-muted">{notice}</p>}

      <div
        ref={logRef}
        onScroll={(event) => {
          const element = event.currentTarget;

          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="h-[28rem] overflow-y-auto border border-border bg-background p-3 font-mono text-2xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-muted">
            {source === 'vivo'
              ? 'Nada ainda. As linhas aparecem conforme o servidor as manda.'
              : 'O arquivo de log ainda está vazio.'}
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.key} className={cn('whitespace-pre-wrap', toneOf(line.type))}>
              {line.text}
            </div>
          ))
        )}
      </div>

      {/* O campo de comando só vale com o RCON de pé: um input que
          aceita texto e recusa tudo é pior que um input desligado
          dizendo por quê. */}
      <form onSubmit={(event) => void send(event)} className="flex gap-2">
        <Input
          value={command}
          disabled={!connected || sending}
          placeholder={
            connected ? 'comando do servidor (ex.: playerlist, status, say ola)' : 'RCON fora do ar'
          }
          onChange={(event) => setCommand(event.target.value)}
          className="font-mono"
        />
        <Button type="submit" variant="primary" disabled={!connected || sending}>
          Enviar
        </Button>
      </form>
    </div>
  );
}
