'use client';

// ============================================================
//  /battlepass  -  o Passe de Batalha: a temporada, a trilha, o
//  XP e quem tem o passe.
//
//  ####  A TEMPORADA É O MÊS  ####
//
//  `2026-10`, e nunca "a atual": um nome estável, porque "a atual"
//  muda de significado à meia-noite do dia 1 e transformaria todo
//  registro histórico em mentira. Ela abre no dia 1, fecha no fim
//  do último dia, e o XP zera na virada.
//
//  ####  O CATÁLOGO É DA REDE; O PROGRESSO É POR SERVIDOR  ####
//
//  Decisão do dono, 17/09/2026. A temporada, a trilha e as regras
//  de XP são montadas uma vez para a rede, com uma lista dizendo em
//  que servidores valem. Já o XP, o nível, o direito comprado e o
//  resgate são POR SERVIDOR: quem joga no `pvp1` e no `pvp2` tem
//  duas trilhas, e comprar num não destrava o outro.
//
//  É o que divide esta tela em dois grupos de abas: as três do
//  meio (Trilha, XP, Configuração) pedem uma TEMPORADA; as três das
//  pontas (Visão geral, Jogadores, Registro) pedem um SERVIDOR. As
//  duas escolhas moram aqui, e não dentro de cada aba, para não
//  haver duas respostas para "de que mês é isto?" na mesma tela.
//
//  ####  AS ABAS SÃO ESTADO LOCAL  ####
//
//  `useState`, e não rota aninhada nem query string — o padrão das
//  25 telas do painel. O molde é o `wipe-panel.tsx:72`, e o desenho
//  é o de PÍLULA por serem abas internas: dois níveis com o mesmo
//  desenho fazem a pessoa perder de vista onde está.
//
//  ####  O QUE CARREGA AQUI, E O QUE CARREGA LÁ DENTRO  ####
//
//  Esta página lê duas coisas: as temporadas (ESSENCIAL — sem elas
//  não há tela) e os servidores (SECUNDÁRIO — sem eles o catálogo
//  continua editável, e o que some é a parte por servidor). O resto
//  — a trilha, as regras, o placar, o registro — cada aba lê ao
//  entrar, porque cada uma muda em ritmo próprio.
//
//  Ver Docs/BattlePass/05-O-PAINEL.md.
// ============================================================

import {
  CalendarDays,
  Gauge,
  LayoutList,
  Medal,
  ScrollText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { messageOf, safeSeasons } from '@/components/battlepass/normalize';
import type { BattlePassServerOption } from '@/components/battlepass/server-choice';
import { TabAudit } from '@/components/battlepass/tab-audit';
import { TabOverview } from '@/components/battlepass/tab-overview';
import { TabPlayers } from '@/components/battlepass/tab-players';
import { TabSeasons } from '@/components/battlepass/tab-seasons';
import { TabSettings } from '@/components/battlepass/tab-settings';
import { TabTrack } from '@/components/battlepass/tab-track';
import { TabXp } from '@/components/battlepass/tab-xp';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent, type BattlePassSeason } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function BattlePassPage() {
  return (
    <RequireSession>
      <BattlePass />
    </RequireSession>
  );
}

/**
 * Os ids não têm acento nem espaço: eles viajam em `data-`, em
 * chave de reação e no `aria-labelledby` do painel de cada aba.
 */
type Tab = 'overview' | 'seasons' | 'track' | 'xp' | 'settings' | 'players' | 'audit';

const TABS: readonly { readonly id: Tab; readonly label: string; readonly Icon: LucideIcon }[] = [
  { id: 'overview', label: 'Visão geral', Icon: LayoutList },
  { id: 'seasons', label: 'Temporadas', Icon: CalendarDays },
  { id: 'track', label: 'Trilha', Icon: Medal },
  { id: 'xp', label: 'XP', Icon: Gauge },
  { id: 'settings', label: 'Configuração', Icon: Settings },
  { id: 'players', label: 'Jogadores', Icon: Users },
  { id: 'audit', label: 'Registro', Icon: ScrollText },
];

function BattlePass() {
  const [tab, setTab] = useState<Tab>('overview');

  const [seasons, setSeasons] = useState<readonly BattlePassSeason[] | null>(null);
  const [seasonId, setSeasonId] = useState<number | null>(null);
  const [servers, setServers] = useState<readonly BattlePassServerOption[] | null>(null);
  const [serverId, setServerId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadSeasons = useCallback(async () => {
    try {
      const response = await agent.battlePassSeasons();
      // Do mês mais novo para o mais velho: quem abre esta tela está
      // montando o mês que vem, e não lendo o de março.
      const list = safeSeasons(response.seasons).sort((left, right) =>
        right.period.localeCompare(left.period),
      );

      setSeasons(list);
      setError(null);

      // A temporada escolhida sobrevive à releitura; sumindo ela (ou
      // não havendo nenhuma escolhida), a preferida é a que está no
      // ar — é nela que o admin mexe por engano, e vê-la escolhida é
      // o que impede o engano.
      setSeasonId((current) => {
        if (current !== null && list.some((season) => season.id === current)) return current;

        return (list.find((season) => season.state === 'active') ?? list[0])?.id ?? null;
      });
    } catch (cause) {
      setError(messageOf(cause));
      setSeasons(null);
    }
  }, []);

  useEffect(() => {
    void loadSeasons();
  }, [loadSeasons]);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.servers();

        if (!alive) return;

        // Todo campo com padrão pronto: um `name` que o agente
        // omitir não pode derrubar a página inteira.
        const list = (response.servers ?? []).map((server) => ({
          id: String(server.id ?? ''),
          name: server.name ?? String(server.id ?? ''),
        }));

        setServers(list);
        setServerId((current) => (current === '' ? (list[0]?.id ?? '') : current));
      } catch {
        // Secundário: o catálogo do passe é da rede e continua
        // editável. O que fica sem resposta é a parte por servidor,
        // e as abas que dependem dela dizem isso.
        if (alive) setServers([]);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const list = seasons ?? [];
  const season = list.find((entry) => entry.id === seasonId) ?? null;
  const serverList = servers ?? [];

  return (
    <div className="min-w-0">
      <PageHeader
        title="Passe de Batalha"
        description="A temporada é o mês. O jogador sobe de nível com XP e leva as duas faixas: a grátis, e a paga para quem comprou."
        aside={
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            {seasons === null
              ? ''
              : list.length === 0
                ? 'nenhuma temporada'
                : `${String(list.length)} temporada(s)`}
          </span>
        }
      />

      <div className="mt-4 min-w-0 space-y-4">
        {error !== null && (
          <StateBlock
            variant="error"
            title="Não consegui ler as temporadas do passe."
            detail={
              <>
                {error} Sem elas não há trilha, regra de XP nem configuração para mostrar — e as
                contagens por servidor também dependem de uma temporada no ar.
              </>
            }
          />
        )}

        {seasons === null && error === null && (
          <StateBlock variant="loading" title="Consultando o agente…" />
        )}

        {seasons !== null && (
          <>
            {/* Pílulas, no mesmo desenho das sub-abas do wipe. */}
            <div
              role="tablist"
              aria-label="Seções do passe de batalha"
              className="flex flex-wrap items-stretch border border-border bg-surface"
            >
              {TABS.map((item, index) => {
                const { Icon } = item;

                return (
                  // `presentation` na divisória: sem ele, o <div>
                  // ficaria entre o tablist e os tabs na árvore de
                  // acessibilidade, e o leitor de tela deixaria de
                  // anunciar "aba 3 de 7".
                  <div key={item.id} role="presentation" className="flex items-stretch">
                    {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                    <button
                      type="button"
                      role="tab"
                      id={`battlepass-tab-${item.id}`}
                      aria-selected={tab === item.id}
                      onClick={() => setTab(item.id)}
                      className={cn(
                        'flex items-center gap-2 px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                        tab === item.id
                          ? 'bg-surface-2 text-foreground'
                          : 'text-muted hover:text-foreground',
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4" />
                      {item.label}
                    </button>
                  </div>
                );
              })}
            </div>

            <div
              role="tabpanel"
              aria-labelledby={`battlepass-tab-${tab}`}
              className="min-w-0 space-y-4"
            >
              {tab === 'overview' && (
                <TabOverview
                  servers={serverList}
                  serverId={serverId}
                  onPickServer={setServerId}
                />
              )}

              {tab === 'seasons' && (
                <TabSeasons seasons={list} servers={serverList} onChanged={loadSeasons} />
              )}

              {tab === 'track' && (
                <TabTrack seasons={list} season={season} onPickSeason={setSeasonId} />
              )}

              {tab === 'xp' && (
                <TabXp seasons={list} season={season} onPickSeason={setSeasonId} />
              )}

              {tab === 'settings' && (
                <TabSettings
                  seasons={list}
                  season={season}
                  servers={serverList}
                  onPickSeason={setSeasonId}
                  onChanged={loadSeasons}
                />
              )}

              {tab === 'players' && (
                <TabPlayers
                  servers={serverList}
                  serverId={serverId}
                  onPickServer={setServerId}
                />
              )}

              {tab === 'audit' && (
                <TabAudit servers={serverList} serverId={serverId} onPickServer={setServerId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
