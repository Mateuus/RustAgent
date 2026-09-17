'use client';

// ============================================================
//  /workshop  -  as skins do Steam Workshop, e quem pode usá-las.
//
//  ####  O JOGADOR ESCOLHE; NADA NASCE PINTADO  ####
//
//  A arte é publicada no Steam Workshop, o número dela entra no
//  catálogo, e o JOGADOR decide o que pinta: `/skin` abre uma caixa
//  virtual no jogo, e `/skin <coleção>` aplica uma coleção inteira
//  ao que ele veste. O item é o MESMO objeto antes e depois — só a
//  aparência muda.
//
//  O cadastro entra por dois caminhos que gravam no MESMO catálogo:
//  esta tela, ou o `/skin add "shortname" "workshop_id"` de um admin
//  dentro do jogo. A coluna "Origem" diz qual foi.
//
//  ####  AS QUATRO ABAS  ####
//
//    Skins      o catálogo: item, arte, permissão opcional, coleção,
//               "para todos", servidores.
//    Coleções   os `/skin <slug>`: uma skin por item.
//    Acessos    quem pode usar o quê além da permissão: jogador ou
//               grupo do Oxide, com prazo ou permanente.
//    Registro   tudo o que mudou, pelo painel, pelo jogo ou sozinho
//               (acesso que venceu).
//
//  Um acesso é liberado por QUALQUER caminho — "para todos",
//  permissão da skin ou da coleção, acesso individual, ou
//  `origemzworkshop.admin`. Acesso removido ou vencido NÃO despinta
//  o que já foi pintado.
//
//  ####  O CATÁLOGO É DA REDE  ####
//
//  Não há seletor de servidor no topo — de propósito. A única coisa
//  por servidor é EM QUAIS a skin vale, escolhido na própria linha.
//  A faixa de cima diz o que cada servidor tem de pé agora, e é
//  onde se manda a carga de novo quando alguém recarregou o plugin
//  à mão.
//
//  ####  ELA RESPONDE COM OS SERVIDORES PARADOS  ####
//
//  Cadastrar é trabalho de madrugada. Só a faixa de status pergunta
//  ao jogo — e com ele fora do ar ela diz isso em cinza, sem fingir
//  que é falha.
//
//  Ver Docs/OrigemZWorkshop/01-CAIXA-E-COLECOES.md.
// ============================================================

import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { AccessPanel } from '@/components/workshop/access-panel';
import { AuditPanel } from '@/components/workshop/audit-panel';
import { CollectionsPanel } from '@/components/workshop/collections-panel';
import { SkinsPanel } from '@/components/workshop/skins-panel';
import { StatusBar } from '@/components/workshop/status-bar';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import { agent } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function WorkshopPage() {
  return (
    <RequireSession>
      <Workshop />
    </RequireSession>
  );
}

type TabId = 'skins' | 'collections' | 'access' | 'audit';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'skins', label: 'Skins' },
  { id: 'collections', label: 'Coleções' },
  { id: 'access', label: 'Acessos' },
  { id: 'audit', label: 'Registro' },
];

function Workshop() {
  const [servers, setServers] = useState<readonly WorkshopServerOption[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>('skins');
  /** O filtro com que a aba Registro abre. Vem do atalho de Acessos. */
  const [auditSteamId, setAuditSteamId] = useState('');

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
        // A lista de servidores alimenta a atribuição e as sugestões
        // de grupo, e não o catálogo. Sem ela a tela continua
        // servindo.
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
        description="O jogador escolhe: /skin abre a caixa, /skin <coleção> aplica a coleção ao que ele veste. Cadastre aqui ou no jogo, com /skin add."
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

            {/* Pílulas, no mesmo desenho das sub-abas do wipe. */}
            <div
              role="tablist"
              aria-label="Seções das skins"
              className="flex flex-wrap items-stretch border border-border bg-surface"
            >
              {TABS.map((item, index) => (
                <div key={item.id} role="presentation" className="flex items-stretch">
                  {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                  <button
                    type="button"
                    role="tab"
                    id={`workshop-tab-${item.id}`}
                    aria-selected={tab === item.id}
                    onClick={() => {
                      // Entrar no Registro pela pílula é ver TUDO; o
                      // filtro só vem pelo atalho de Acessos.
                      if (item.id === 'audit') setAuditSteamId('');
                      setTab(item.id);
                    }}
                    className={cn(
                      'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                      tab === item.id
                        ? 'bg-surface-2 text-foreground'
                        : 'text-muted hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </button>
                </div>
              ))}
            </div>

            {/* Cada aba monta ao entrar e relê o agente: o que mudou
                numa (uma coleção nova) já aparece na outra. */}
            <div role="tabpanel" aria-labelledby={`workshop-tab-${tab}`}>
              {tab === 'skins' && <SkinsPanel servers={servers} onCount={setTotal} />}
              {tab === 'collections' && <CollectionsPanel />}
              {tab === 'access' && (
                <AccessPanel
                  servers={servers}
                  onShowAudit={(steamId) => {
                    setAuditSteamId(steamId);
                    setTab('audit');
                  }}
                />
              )}
              {tab === 'audit' && (
                <AuditPanel key={auditSteamId} servers={servers} initialSteamId={auditSteamId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
