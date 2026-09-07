'use client';

// ============================================================
//  /propaganda  -  o overlay que aparece sozinho na tela do jogo.
//
//  ####  ELE NAO E UMA INTERFACE, E POR ISSO TEM PAGINA PROPRIA  ####
//
//  Um documento de `/interface` abre por comando, tem sessão e
//  telas que trocam sob clique. O overlay não tem nada disso:
//  aparece sozinho, para todo mundo, e o que ele faz é se MEXER.
//  Ver o cabeçalho do bloco do overlay em Plugins/OrigemZUI.cs.
//
//  ####  E POR ISSO O SELETOR NAO TEM "TODOS"  ####
//
//  A lista e o ajuste são de UM servidor: o overlay do PVP anuncia
//  o Discord do PVP. "Todos" existiria só para mostrar uma soma que
//  ninguém pode editar — e o primeiro clique em salvar precisaria
//  perguntar de novo em qual mundo.
//
//  Por isso a página escolhe o primeiro servidor sozinha, e o
//  seletor troca. Sem servidor cadastrado não há o que configurar,
//  e a tela diz isso em vez de desenhar um formulário morto.
// ============================================================

import { useEffect, useState } from 'react';

import { AdsPage } from '@/components/ads-page';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent } from '@/lib/api';

export default function PropagandaPage() {
  return (
    <RequireSession>
      <Propaganda />
    </RequireSession>
  );
}

function Propaganda() {
  const [servers, setServers] = useState<readonly { id: string; name: string }[] | null>(null);
  /** `''` enquanto a lista não chegou. Nunca "todos". */
  const [serverId, setServerId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.servers();

        if (!alive) return;

        const list = response.servers.map((server) => ({ id: server.id, name: server.name }));

        setServers(list);
        // O primeiro, sozinho: obrigar a escolher num painel de um
        // servidor só seria um clique para confirmar o óbvio.
        setServerId((current) => (current === '' ? (list[0]?.id ?? '') : current));
      } catch (cause) {
        if (alive) {
          setServers([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Propaganda"
        description="O overlay que aparece sozinho na tela de quem está jogando."
        aside={
          servers !== null && servers.length > 1 ? (
            <label className="flex items-center gap-2 text-2xs text-muted">
              Servidor
              <select
                value={serverId}
                onChange={(event) => {
                  setServerId(event.target.value);
                }}
                className="h-8 border border-border bg-surface-2 px-2 text-2xs text-foreground"
              >
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />

      <div className="flex-1 p-4">
        {servers === null && <StateBlock variant="loading" title="Carregando os servidores…" />}

        {servers !== null && servers.length === 0 && (
          <StateBlock
            variant={error === null ? 'empty' : 'error'}
            title="Nenhum servidor cadastrado"
            detail={
              error ??
              'O overlay é a configuração de um mundo: cadastre um servidor antes de desenhar a propaganda dele.'
            }
          />
        )}

        {/*
          A chave no `serverId` é o que faz trocar de servidor
          recomeçar a tela do zero. Sem ela, o rascunho do ajuste
          do PVP continuaria na tela depois de trocar para o PVE —
          e o primeiro "salvar" gravaria os números errados no
          mundo errado.
        */}
        {serverId !== '' && <AdsPage key={serverId} serverId={serverId} />}
      </div>
    </div>
  );
}
