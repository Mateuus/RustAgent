'use client';

// ============================================================
//  /workshop  -  as skins que a casa aplica sozinha nos itens.
//
//  ####  O QUE ESTA TELA É  ####
//
//  Um CATÁLOGO, e não um evento: a arte é publicada por nós no
//  Steam Workshop, o número dela é cadastrado aqui, e o servidor
//  carimba esse número no item que nasce na mão de quem tem a
//  permissão. Onde o jogo daria a pedra comum, ele dá a pedra da
//  OrigemZ.
//
//  É por isso que ela entra pela barra lateral, ao lado de Itens, e
//  não pela família de Eventos: nada aqui nasce no mapa.
//
//  ####  O CATÁLOGO É DA REDE  ####
//
//  Não há seletor de servidor no topo — de propósito. A skin é
//  cadastrada uma vez para a rede inteira, e a única coisa que é
//  por servidor é EM QUAIS ela vale, que se escolhe na própria
//  linha. A faixa de cima é a outra metade dessa história: ela diz
//  o que cada servidor tem de pé agora, e é onde se manda o
//  catálogo de novo quando alguém recarregou o plugin à mão.
//
//  ####  ELA RESPONDE COM OS SERVIDORES PARADOS  ####
//
//  Como a tela de Itens e a de Kits: cadastrar é trabalho de
//  madrugada. Só a faixa de status pergunta ao jogo — e com ele
//  fora do ar ela diz isso em cinza, sem fingir que é falha.
//
//  Ver Docs/OrigemZWorkshop/00-LEVANTAMENTO.md.
// ============================================================

import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { SkinsPanel } from '@/components/workshop/skins-panel';
import { StatusBar } from '@/components/workshop/status-bar';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import { agent } from '@/lib/api';

export default function WorkshopPage() {
  return (
    <RequireSession>
      <Workshop />
    </RequireSession>
  );
}

function Workshop() {
  const [servers, setServers] = useState<readonly WorkshopServerOption[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.servers();

        if (!alive) return;

        // Todo campo com padrão pronto: um `name` que o agente
        // omitir não pode derrubar a página inteira.
        setServers(
          (response.servers ?? []).map((server) => ({
            id: String(server.id ?? ''),
            name: server.name ?? String(server.id ?? ''),
          })),
        );
      } catch {
        // A lista de servidores alimenta a atribuição, e não o
        // catálogo. Sem ela a tela continua servindo: o cadastro
        // funciona, e o erro de verdade aparece na listagem.
        if (alive) setServers([]);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <PageHeader
        title="Skins"
        description="A arte da casa nos itens do jogo. O item já nasce com ela — sem menu e sem comando."
        aside={
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            {total === null ? '' : total === 0 ? 'nenhuma' : `${String(total)} no catálogo`}
          </span>
        }
      />

      <div className="mt-4 space-y-4">
        {servers === null ? (
          <StateBlock variant="loading" title="Lendo os servidores…" />
        ) : (
          <>
            <StatusBar servers={servers} />
            <SkinsPanel servers={servers} onCount={setTotal} />
          </>
        )}
      </div>
    </div>
  );
}
