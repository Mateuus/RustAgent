'use client';

// ============================================================
//  /  -  a visão geral: um cartão por servidor.
//
//  O cartão responde de longe: em que estado ele está, que mapa,
//  que portas, e qual é o próximo passo.
//
//  ####  O ESTADO SAI DO AGENTE, NÃO DA TELA  ####
//
//  Nada aqui adivinha se uma operação vai dar certo: a lista de
//  `kinds` vem do core, e uma recusa vem com a frase de quem
//  conhece a regra. Botão escondido não ensina nada.
// ============================================================

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { CreateServerDialog } from '@/components/create-server-dialog';
import { ServerStateBadge } from '@/components/server-state';
import { RequireSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { agent, type PortBlock, type ServerView } from '@/lib/api';

/** De quanto em quanto tempo a lista se refresca. */
const POLL_MS = 5_000;

export default function VisaoGeralPage() {
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
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="font-condensed text-2xl font-bold uppercase tracking-wide">Servidores</h1>
          <p className="text-sm text-muted">
            {servers === null
              ? 'Carregando…'
              : `${String(servers.length)} servidor(es) nesta máquina`}
          </p>
        </div>

        <Button variant="primary" onClick={() => setCreating(true)}>
          Criar servidor
        </Button>
      </div>

      {error !== null && <p className="mb-4 border border-rust bg-surface-2 p-3 text-sm">{error}</p>}

      {servers !== null && servers.length === 0 && (
        <div className="border border-border bg-surface p-8 text-center">
          <p className="mb-2 font-condensed text-lg uppercase">Nenhum servidor ainda</p>
          <p className="mb-4 text-sm text-muted">
            Criar um servidor escreve o <code>Configs\&lt;id&gt;.ini</code> e escolhe um bloco de
            portas livre. Ele nasce desligado — o passo seguinte é instalar, que baixa o jogo pelo
            SteamCMD.
          </p>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Criar o primeiro
          </Button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {servers?.map((server) => <ServerCard key={server.id} server={server} />)}
      </div>

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

function ServerCard({ server }: { server: ServerView }) {
  return (
    <div className="border border-border bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-condensed text-lg font-bold uppercase">{server.name}</p>
          <p className="truncate text-sm text-muted">{server.hostname}</p>
        </div>

        <ServerStateBadge server={server} />
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-muted">Mapa</dt>
        <dd className="text-right">
          {server.map} · {String(server.worldSize)}
        </dd>

        <dt className="text-muted">Jogadores</dt>
        <dd className="text-right">até {String(server.maxPlayers)}</dd>

        <dt className="text-muted">Portas</dt>
        <dd className="text-right tabular-nums">
          {server.ports.game} · {server.ports.rcon}
        </dd>
      </dl>

      <Link href={`/servidor/?id=${encodeURIComponent(server.id)}`}>
        <Button className="w-full">Abrir</Button>
      </Link>
    </div>
  );
}
