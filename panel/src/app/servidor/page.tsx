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

import {
  LayoutList,
  LayoutTemplate,
  Puzzle,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { AdminPanel } from '@/components/admin-panel';
import { ConsolePanel } from '@/components/console-panel';
import { OperationsPanel } from '@/components/operations-panel';
import { PageHeader } from '@/components/page-header';
import { PluginsPanel } from '@/components/plugins-panel';
import { ServerMenuPanel } from '@/components/server-menu-panel';
import { ServerSettings } from '@/components/server-settings';
import { ServerStateBadge } from '@/components/server-state';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, type ServerView, type SteamUpdate } from '@/lib/api';
import { toast } from '@/lib/toast';

type Tab = 'visao' | 'administracao' | 'console' | 'operacoes' | 'plugins' | 'menu' | 'config';

/**
 * As abas, com ícone.
 *
 * O ícone não decora: com seis abas, ele é o que a vista pega antes
 * de ler — e é o que permite achar "Console" de relance numa tela
 * que se abre dezenas de vezes por dia.
 *
 * ####  ADMINISTRAÇÃO VEM LOGO DEPOIS DE VISÃO  ####
 *
 * A ordem é a do uso: quem abre a página de um servidor quer
 * primeiro saber como ele está, e logo em seguida quem está dentro
 * dele. Console e Operações são o que se procura quando algo deu
 * errado, e configurar é o que se faz uma vez.
 */
const TABS = [
  { key: 'visao', label: 'Visão', Icon: LayoutList },
  { key: 'administracao', label: 'Administração', Icon: ShieldCheck },
  { key: 'console', label: 'Console', Icon: TerminalSquare },
  { key: 'operacoes', label: 'Operações', Icon: SlidersHorizontal },
  { key: 'plugins', label: 'Plugins', Icon: Puzzle },
  // ####  MENU VEM ANTES DE CONFIGURAÇÕES  ####
  //
  // É o que os JOGADORES veem, e por isso se mexe nele muito mais
  // do que nas portas ou no SteamCMD. As páginas do menu ficam
  // aqui; o desenho delas é da rede e mora em Interface, na barra
  // lateral.
  { key: 'menu', label: 'Menu', Icon: LayoutTemplate },
  { key: 'config', label: 'Configurações', Icon: Settings2 },
] as const;

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
              {steam.installed}).{' '}
              {steam.autoUpdate ? (
                <>
                  O agente <strong>atualiza sozinho</strong>: avisa no chat, conta o tempo, salva e
                  sobe de novo. Para não esperar a próxima rodada, use{' '}
                  <strong>Atualizar avisando</strong>.
                  {steam.attempts > 0 && (
                    <> Tentativas automáticas gastas neste build: {steam.attempts} de 3.</>
                  )}
                </>
              ) : (
                <>
                  A atualização automática está <strong>desligada</strong> (STEAM_AUTO_UPDATE=0 no
                  .env do agente). Use <strong>Atualizar avisando</strong> para derrubar com aviso no
                  chat.
                </>
              )}
            </p>
          )}

          {steam !== null && steam.lastError !== null && (
            <p className="mb-4 border border-rust bg-surface-2 p-3 text-2xs">
              Não consegui conferir a versão publicada: {steam.lastError}
            </p>
          )}

          {/* A divisória vertical entre as abas (`border-l` a
              partir da segunda) é o que separa cinco alvos de
              clique que, sem ela, viram uma faixa contínua de
              texto. Ela para ANTES da linha de baixo — daí o
              `my-2`, e não uma borda de altura cheia que cruzaria
              o sublinhado da aba ativa. */}
          <nav className="mb-4 flex overflow-x-auto border-b border-border">
            {TABS.map(({ key, label, Icon }, index) => (
              <div key={key} className="flex shrink-0 items-stretch">
                {index > 0 && <span aria-hidden className="my-2 w-px bg-border" />}

                <button
                  type="button"
                  onClick={() => setTab(key)}
                  className={
                    'flex items-center gap-2 px-5 py-2 text-sm ' +
                    (tab === key
                      ? 'border-b-2 border-rust text-foreground'
                      : 'border-b-2 border-transparent text-muted hover:text-foreground')
                  }
                >
                  <Icon
                    aria-hidden="true"
                    className={'h-4 w-4' + (tab === key ? ' text-rust' : '')}
                  />
                  {label}
                </button>
              </div>
            ))}
          </nav>

          {tab === 'visao' && <Visao server={server} steam={steam} />}
          {tab === 'administracao' && <AdminPanel server={server} />}
          {tab === 'console' && <ConsolePanel serverId={server.id} />}
          {tab === 'operacoes' && <OperationsPanel server={server} />}
          {tab === 'plugins' && <PluginsPanel serverId={server.id} />}
          {tab === 'menu' && <ServerMenuPanel serverId={server.id} />}
          {tab === 'config' && <ServerSettings server={server} onChanged={() => void load()} />}
        </>
      )}
    </div>
  );
}

function Visao({ server, steam }: { server: ServerView; steam: SteamUpdate | null }) {
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

      {/* A janela de console e o resto da configuração moram na
          aba Configurações: opção espalhada é a que ninguém acha
          na hora. */}
    </div>
  );
}
