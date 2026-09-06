'use client';

// ============================================================
//  /ranking  -  o ranking da REDE.
//
//  ####  TRÊS PERGUNTAS, TRÊS ABAS  ####
//
//    Lista      quem está na frente AGORA (ou numa temporada
//               fechada, que vem congelada)
//    Histórico  as janelas que já fecharam, e o pódio de cada uma
//    Cadastro   quais rankings existem, e como cada um se comporta
//
//  A quarta tela do §10 — a JANELA, com o modo da temporada e o
//  botão de virar — mora na página do servidor, e não aqui: a
//  temporada é de UM servidor, e a rede tem várias ao mesmo tempo.
//
//  ####  O CATÁLOGO É LIDO UMA VEZ, AQUI  ####
//
//  As três abas precisam da mesma lista de rankings. Lê-la em cada
//  uma daria três consultas para a mesma resposta — e, pior, três
//  momentos diferentes: criar um ranking numa aba e não vê-lo na
//  outra é o tipo de divergência que faz alguém cadastrar duas
//  vezes.
// ============================================================

import { Trophy } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { PageHeader } from '@/components/page-header';
import { RankingCatalog } from '@/components/ranking/ranking-catalog';
import { RankingHistory } from '@/components/ranking/ranking-history';
import { RankingList } from '@/components/ranking/ranking-list';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent, type RankingDefinition } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'lista' | 'historico' | 'cadastro';

export default function RankingPage() {
  return (
    <RequireSession>
      <Ranking />
    </RequireSession>
  );
}

function Ranking() {
  const [tab, setTab] = useState<Tab>('lista');
  const [rankings, setRankings] = useState<readonly RankingDefinition[] | null>(null);
  const [servers, setServers] = useState<readonly { id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.rankingMetrics();

      setRankings(response.rankings);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Os servidores alimentam os SELETORES, e não a lista. São lidos
  // uma vez: um servidor novo no meio de uma consulta de ranking é
  // raro o bastante para não valer uma chamada por abertura.
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.servers();

        if (alive) {
          setServers(response.servers.map((server) => ({ id: server.id, name: server.name })));
        }
      } catch {
        // Sem a lista de servidores o escopo de rede continua
        // funcionando, e o erro de verdade aparece na tabela.
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const enabled = (rankings ?? []).filter((entry) => entry.enabled);

  return (
    <div>
      <PageHeader
        title="Ranking"
        description="Quem está na frente, em que janela, e desde quando aquilo é medido."
        aside={
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <Trophy aria-hidden="true" className="h-4 w-4" />
            {rankings === null
              ? 'lendo…'
              : `${String(enabled.length)} ligado(s) de ${String(rankings.length)}`}
          </span>
        }
      />

      <div className="mt-4 flex border-b border-border">
        <TabButton active={tab === 'lista'} onClick={() => setTab('lista')}>
          Lista
        </TabButton>
        <TabButton active={tab === 'historico'} onClick={() => setTab('historico')}>
          Histórico
        </TabButton>
        <TabButton active={tab === 'cadastro'} onClick={() => setTab('cadastro')}>
          Rankings {rankings === null ? '' : `(${String(rankings.length)})`}
        </TabButton>
      </div>

      <div className="mt-4">
        {rankings === null && error === null && (
          <StateBlock variant="loading" title="Lendo o catálogo de rankings…" />
        )}

        {rankings === null && error !== null && (
          <StateBlock variant="error" title="Não consegui ler o catálogo" detail={error} />
        )}

        {rankings !== null && tab === 'lista' && (
          // A lista mostra só os LIGADOS: um ranking desligado
          // continua sendo contado, mas ele saiu das telas de
          // propósito. Quem quer religá-lo vai à aba Rankings.
          <RankingList rankings={enabled} servers={servers} />
        )}

        {rankings !== null && tab === 'historico' && (
          <RankingHistory rankings={rankings} servers={servers} />
        )}

        {rankings !== null && tab === 'cadastro' && (
          <RankingCatalog rankings={rankings} error={error} onChanged={() => void load()} />
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
