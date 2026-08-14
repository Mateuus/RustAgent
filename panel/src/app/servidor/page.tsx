'use client';

// ============================================================
//  /servidor?id=<id>  -  a página de um servidor.
//
//  ####  POR QUE QUERY STRING, E NÃO /servidor/[id]  ####
//
//  O painel é EXPORT ESTÁTICO: uma rota dinâmica exigiria
//  `generateStaticParams`, ou seja, saber em tempo de BUILD quais
//  servidores existem. Eles nascem em tempo de execução, pelo
//  próprio painel. Query string resolve sem inventar um servidor
//  Next só para isso.
// ============================================================

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { ConsolePanel } from '@/components/console-panel';
import { OperationsPanel } from '@/components/operations-panel';
import { PageHeader } from '@/components/page-header';
import { PluginsPanel } from '@/components/plugins-panel';
import { ServerStateBadge } from '@/components/server-state';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, type ServerView, type SteamUpdate } from '@/lib/api';
import { toast } from '@/lib/toast';

type Tab = 'visao' | 'console' | 'operacoes' | 'plugins';

export default function ServidorPage() {
  return (
    <RequireSession>
      {/* `useSearchParams` exige Suspense no export estático. */}
      <Suspense fallback={null}>
        <Servidor />
      </Suspense>
    </RequireSession>
  );
}

function Servidor() {
  const params = useSearchParams();
  const id = params.get('id') ?? '';

  const [server, setServer] = useState<ServerView | null>(null);
  const [steam, setSteam] = useState<SteamUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('visao');

  const load = useCallback(async () => {
    if (id === '') {
      return;
    }

    try {
      const response = await agent.server(id);

      setServer(response.server);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }

    try {
      setSteam(await agent.steamUpdate(id));
    } catch {
      // O retrato da Steam é informação secundária: sem ele a
      // página continua servindo para operar o servidor.
    }
  }, [id]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), 5_000);

    return () => clearInterval(timer);
  }, [load]);

  if (id === '') {
    return <p className="text-sm text-muted">Nenhum servidor selecionado.</p>;
  }

  return (
    <div>
      <Link href="/" className="text-2xs uppercase tracking-wider text-muted hover:text-foreground">
        ← todos os servidores
      </Link>

      {error !== null && (
        <div className="mt-4">
          <StateBlock variant="error" title="Não consegui ler este servidor" detail={error} />
        </div>
      )}

      {server === null && error === null && (
        <div className="mt-4">
          <StateBlock variant="loading" title="Carregando…" />
        </div>
      )}

      {server !== null && (
        <>
          <PageHeader
            title={server.name}
            description={server.hostname}
            aside={
              <div className="flex shrink-0 items-center gap-3">
                <ServerStateBadge server={server} />

                {/* ####  CUIDAR VIRA AUTOMÁTICO DEPOIS DE INSTALAR  ####

                    O agente adota o servidor sozinho quando a
                    instalação termina — este botão existe para o
                    caso raro: tirar o agente do caminho durante
                    uma manutenção feita à mão. Por isso ele é
                    discreto, e não o passo seguinte em destaque
                    que já foi. */}
                <Button
                  size="sm"
                  variant="ghost"
                  title={
                    server.enabled
                      ? 'O agente deixa de manter o RCON deste servidor. As operações param de valer.'
                      : 'O agente passa a manter o RCON e a aceitar operações deste servidor.'
                  }
                  onClick={() => {
                    void agent
                      .setEnabled(server.id, !server.enabled)
                      .then(() => {
                        toast.success(
                          server.enabled
                            ? 'O agente parou de cuidar deste servidor'
                            : 'O agente passou a cuidar deste servidor',
                        );

                        return load();
                      })
                      .catch((cause: unknown) => {
                        const message = cause instanceof Error ? cause.message : String(cause);

                        toast.error('Não deu', { description: message });
                        setError(message);
                      });
                  }}
                >
                  {server.enabled ? 'Parar de cuidar' : 'Cuidar deste servidor'}
                </Button>
              </div>
            }
          />

          {steam?.updateAvailable === true && (
            <p className="mb-4 border border-amber bg-surface-2 p-3 text-sm">
              Há atualização do Rust publicada (build {steam.published}; instalado{' '}
              {steam.installed}). Use <strong>Atualizar avisando</strong> para derrubar com aviso no
              chat.
            </p>
          )}

          {steam !== null && steam.lastError !== null && (
            <p className="mb-4 border border-rust bg-surface-2 p-3 text-2xs">
              Não consegui conferir a versão publicada: {steam.lastError}
            </p>
          )}

          <nav className="mb-4 flex gap-1 border-b border-border">
            {(
              [
                ['visao', 'Visão'],
                ['console', 'Console'],
                ['operacoes', 'Operações'],
                ['plugins', 'Plugins'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={
                  'px-4 py-2 text-sm ' +
                  (tab === key
                    ? 'border-b-2 border-rust text-foreground'
                    : 'border-b-2 border-transparent text-muted hover:text-foreground')
                }
              >
                {label}
              </button>
            ))}
          </nav>

          {tab === 'visao' && <Visao server={server} steam={steam} onChanged={() => void load()} />}
          {tab === 'console' && <ConsolePanel serverId={server.id} />}
          {tab === 'operacoes' && <OperationsPanel serverId={server.id} />}
          {tab === 'plugins' && <PluginsPanel serverId={server.id} />}
        </>
      )}
    </div>
  );
}

function Visao({
  server,
  steam,
  onChanged,
}: {
  server: ServerView;
  steam: SteamUpdate | null;
  onChanged: () => void;
}) {
  const rows: [string, string][] = [
    ['id', server.id],
    ['processo', server.running === true ? `no ar (pid ${String(server.pid ?? 0)})` : 'parado'],
    ['identity (pasta de saves)', server.identity],
    ['mapa', `${server.map} · ${String(server.worldSize)} · seed ${String(server.seed)}`],
    ['jogadores', `até ${String(server.maxPlayers)}`],
    [
      'portas',
      `jogo ${String(server.ports.game)} · rcon ${String(server.ports.rcon)} · query ${String(
        server.ports.query,
      )} · app ${String(server.ports.app)}`,
    ],
    ['instalação', server.paths.installDir],
    ['configuração', server.paths.configPath],
    ['logs', server.paths.logsDir],
    ['build instalado', steam?.installed ?? '—'],
    ['build publicado', steam?.published ?? '—'],
  ];

  return (
    <div className="space-y-4">
      <dl className="divide-y divide-border border border-border bg-surface text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 px-4 py-2">
            <dt className="w-56 shrink-0 text-muted">{label}</dt>
            <dd className="min-w-0 break-all">{value}</dd>
          </div>
        ))}
      </dl>

      {/* ####  A JANELA DO JOGO  ####

          Um serviço 24/7 não quer uma janela por servidor, e por
          isso o padrão é sem. Mas quem administra a máquina de
          perto quer poder olhar o console sem o painel — e essa é
          uma decisão de quem opera, não nossa. */}
      <div className="border border-border bg-surface p-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-condensed text-sm font-bold uppercase tracking-wide">
              Janela de console do jogo
            </p>
            <p className="mt-1 text-muted">
              {server.consoleWindow
                ? 'O servidor sobe numa janela própria, e ela aparece na barra de tarefas.'
                : 'O servidor sobe sem janela (o log vai para o arquivo e para a aba Console).'}
            </p>
          </div>

          <Button
            size="sm"
            variant={server.consoleWindow ? 'outline' : 'primary'}
            onClick={() => {
              void agent
                .setConsoleWindow(server.id, !server.consoleWindow)
                .then((response) => {
                  toast.success(
                    server.consoleWindow ? 'Janela desligada' : 'Janela ligada',
                    { description: response.message },
                  );

                  onChanged();
                })
                .catch((cause: unknown) => {
                  toast.error('Não deu', {
                    description: cause instanceof Error ? cause.message : String(cause),
                  });
                });
            }}
          >
            {server.consoleWindow ? 'Desligar janela' : 'Ligar janela'}
          </Button>
        </div>

        {server.consoleWindow && (
          <p className="mt-3 border border-amber bg-surface-2 p-3 text-2xs">
            <strong>Cuidado com o clique.</strong> O console do Windows vem com o Modo de Edição
            Rápida ligado: clicar dentro da janela põe o console em seleção e <strong>congela o
            servidor</strong> — com os jogadores dentro — até alguém apertar Enter ali.
          </p>
        )}

        <p className="mt-3 text-2xs text-muted">
          A mudança vale no próximo start: uma janela não aparece para um processo que já está no
          ar.
        </p>
      </div>
    </div>
  );
}
