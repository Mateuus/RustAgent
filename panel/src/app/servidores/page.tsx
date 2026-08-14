'use client';

// ============================================================
//  /servidores  -  a lista.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Cartão é bom para poucos itens e leitura solta; esta tela é de
//  COMPARAÇÃO — quem opera quer varrer a coluna "situação" e a de
//  portas de cima a baixo e achar o que está fora do lugar. Em
//  cartão, cada valor fica numa posição diferente da tela e o olho
//  precisa recomeçar a cada bloco.
//
//  As colunas seguem o padrão do design system: cabeçalho em
//  condensed 2xs maiúsculo, número alinhado à direita e com
//  `tabular-nums` — sem largura fixa de dígito a coluna treme a
//  cada atualização.
// ============================================================

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { CreateServerDialog } from '@/components/create-server-dialog';
import { PageHeader } from '@/components/page-header';
import { ServerStateBadge } from '@/components/server-state';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, type PortBlock, type ServerView } from '@/lib/api';
import { cn } from '@/lib/utils';

const POLL_MS = 5_000;

function HeaderCell({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        numeric === true ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

export default function ServidoresPage() {
  return (
    <RequireSession>
      <Servers />
    </RequireSession>
  );
}

function Servers() {
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [suggested, setSuggested] = useState<PortBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.servers();

      setServers(response.servers);
      setSuggested(response.suggestedPortBlock);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não consegui falar com o agente.');
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Servidores"
        description={servers === null ? 'Carregando…' : `${String(servers.length)} nesta máquina`}
        aside={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Criar servidor
          </Button>
        }
      />

      {error !== null && (
        <StateBlock variant="error" title="Não consegui falar com o agente" detail={error} />
      )}

      {error === null && servers === null && (
        <StateBlock variant="loading" title="Carregando os servidores…" />
      )}

      {error === null && servers !== null && servers.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum servidor ainda"
          detail={
            <>
              Criar um servidor escreve o <code>Configs\&lt;id&gt;.ini</code> e reserva um bloco de
              portas livre. Ele nasce desligado — o passo seguinte é Instalar, que baixa o jogo
              pelo SteamCMD.
            </>
          }
        />
      )}

      {servers !== null && servers.length > 0 && (
        <div className="border border-border bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <caption className="sr-only">Servidores de Rust desta máquina</caption>

              <thead>
                <tr className="border-b border-border">
                  <HeaderCell>Servidor</HeaderCell>
                  <HeaderCell>ID</HeaderCell>
                  <HeaderCell>Situação</HeaderCell>
                  <HeaderCell>Mapa</HeaderCell>
                  <HeaderCell numeric>Mundo</HeaderCell>
                  <HeaderCell numeric>Vagas</HeaderCell>
                  <HeaderCell numeric>Jogo</HeaderCell>
                  <HeaderCell numeric>RCON</HeaderCell>
                  <HeaderCell numeric>
                    {/* Cabeçalho só para o leitor de tela: escrever
                        "Ações" em cima de um botão que já se lê é
                        ruído para quem enxerga. */}
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody>
                {servers.map((server) => (
                  <tr
                    key={server.id}
                    className="border-b border-border last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-3 py-2">
                      <span className="block truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                        {server.name}
                      </span>
                      <span className="block truncate text-2xs text-muted">{server.hostname}</span>
                    </td>

                    <td className="px-3 py-2">
                      <code className="text-muted">{server.id}</code>
                    </td>

                    <td className="px-3 py-2">
                      <ServerStateBadge server={server} />
                    </td>

                    <td className="px-3 py-2 text-muted">{server.map}</td>

                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {String(server.worldSize)}
                    </td>

                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {String(server.maxPlayers)}
                    </td>

                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {String(server.ports.game)}
                    </td>

                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {String(server.ports.rcon)}
                    </td>

                    <td className="px-3 py-2 text-right">
                      <Link href={`/servidor/?id=${encodeURIComponent(server.id)}`}>
                        <Button size="sm">Abrir</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating && (
        <CreateServerDialog
          suggested={suggested}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
