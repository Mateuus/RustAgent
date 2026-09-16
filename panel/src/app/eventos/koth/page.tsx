'use client';

// ============================================================
//  /eventos/koth  -  O DOMÍNIO DE TERRITÓRIO.
//
//  ####  TRÊS ABAS  ####
//
//    Ao vivo         o que está de pé agora
//    Territórios     onde o KOTH pode acontecer, marcados no mapa
//    Configurações   vagas, e o que mais vier
//
//  "Ao vivo" vem primeiro porque é a pergunta que se faz com mais
//  frequência — "tem KOTH acontecendo?" —, e configurar é coisa que
//  se faz uma vez.
//
//  ####  A ABA "O QUE FALTA" SAIU  ####
//
//  Ela existiu enquanto metade desta família não estava escrita, e
//  servia para o admin não cadastrar território esperando uma
//  recompensa que não existia. As frentes que ela listava foram
//  todas fechadas — a agenda própria, a barra com placar, a
//  bandeira que troca de cor, o prêmio individual de quem vence — e
//  uma lista de pendências vazia só ocupa espaço e envelhece.
//
//  Decisão do dono em 17/09/2026: "depois de terminar esse o que
//  falta nós excluímos isso".
//
//  ####  NADA DE FORMULÁRIO DE MENTIRA  ####
//
//  Campo que salva numa tabela que ninguém lê é pior que campo
//  nenhum: alguém preenche, fecha, e espera o evento acontecer.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md.
// ============================================================

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ArenasPanel } from '@/components/koth/arenas-panel';
import { LivePanel } from '@/components/koth/live-panel';
import { SettingsPanel } from '@/components/koth/settings-panel';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function KothPage() {
  return (
    <RequireSession>
      <Koth />
    </RequireSession>
  );
}

function Koth() {
  const [tab, setTab] = useState<'live' | 'territorios' | 'config'>('live');
  const [servers, setServers] = useState<readonly { id: string; name: string }[] | null>(null);
  const [serverId, setServerId] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await agent.servers();

      setServers(response.servers.map((server) => ({ id: server.id, name: server.name })));
    } catch {
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ####  O TERRITÓRIO É DE UM MAPA  ####
  //
  // E um mapa é de um servidor — a mesma razão pela qual a aba
  // "Onde nasce" da masmorra também pergunta o servidor antes de
  // qualquer outra coisa.
  const current = serverId === '' ? (servers?.[0]?.id ?? '') : serverId;

  return (
    <div>
      <PageHeader
        title="KOTH"
        description="Um território no mapa aberto, e quem aguentar ficar nele"
        aside={
          <div className="flex items-center gap-3">
            {servers !== null && servers.length > 1 && (
              <label className="flex items-center gap-2">
                <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                  Servidor
                </span>
                <select
                  value={current}
                  onChange={(event) => setServerId(event.target.value)}
                  className="h-8 border border-border bg-background px-2 text-sm"
                >
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <Link
              href="/eventos/"
              className="flex items-center gap-1 font-condensed text-2xs uppercase tracking-wide text-muted hover:text-foreground"
            >
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
              Eventos
            </Link>
          </div>
        }
      />

      <div className="mt-4 border-b border-border">
        <div className="flex">
          <TabButton active={tab === 'live'} onClick={() => setTab('live')}>
            Ao vivo
          </TabButton>
          <TabButton active={tab === 'territorios'} onClick={() => setTab('territorios')}>
            Territórios
          </TabButton>
          <TabButton active={tab === 'config'} onClick={() => setTab('config')}>
            Configurações
          </TabButton>
        </div>
      </div>

      <div className="mt-4">
        {/* Toda aba daqui é de um servidor: a guarda é uma só, e
            escrevê-la três vezes faria uma delas envelhecer. */}
        {servers === null ? (
          <StateBlock variant="loading" title="Lendo os servidores…" />
        ) : current === '' ? (
          <StateBlock
            variant="empty"
            title="Nenhum servidor cadastrado"
            detail="Um território é um lugar no mapa, e um mapa é de um servidor."
          />
        ) : tab === 'live' ? (
          <LivePanel key={current} serverId={current} />
        ) : tab === 'config' ? (
          <SettingsPanel key={current} serverId={current} />
        ) : (
          <ArenasPanel key={current} serverId={current} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        '-mb-px border-b-2 px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
        active
          ? 'border-rust text-foreground'
          : 'border-transparent text-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
