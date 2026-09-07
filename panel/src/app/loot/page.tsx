'use client';

// ============================================================
//  /loot  -  o que a casa acrescenta ao loot do jogo.
//
//  ####  TRÊS PERGUNTAS, TRÊS ABAS  ####
//
//    Tabelas      o loot INTEIRO do servidor: quantos itens saem de
//                 cada caixa, quais, com que chance e quanto scrap
//    Regras       o que a casa acrescenta por cima, onde, e com que
//                 frequência
//    Contêineres  o caminho contrário: "quero mexer na caixa de
//                 elite" — e dali sai uma regra nova já apontada
//                 para ela
//
//  A segunda existe porque é assim que um admin pensa. A primeira
//  existe porque é assim que se administra o que já foi criado.
//
//  ####  POR QUE TABELAS É A PRIMEIRA  ####
//
//  Porque é a decisão do dono (Docs/CustomItem/06 §0): o painel
//  configura TODO o loot do jogo editando a configuração do
//  BetterLoot, em vez de construirmos motor de loot. As regras
//  continuam valendo — elas sabem teto por dia, carência por
//  jogador e medição, que o plugin de terceiro não tem —, mas quem
//  responde "como está o loot deste servidor" é a primeira aba.
//
//  ####  AS DUAS NATUREZAS NÃO SE MISTURAM  ####
//
//  Tabelas é de UM SERVIDOR: um arquivo no disco dele, lido de lá e
//  escrito de volta lá. Regras é de REDE: cadastro do agente, que
//  responde com todos os servidores parados. O seletor de servidor
//  do topo, por isso, significa coisas diferentes em cada aba — na
//  primeira ele escolhe o arquivo, na segunda ele filtra a lista.
//
//  ####  A REGRA ACRESCENTA; A TABELA SUBSTITUI  ####
//
//  Nenhuma REGRA tira item do loot nem esvazia contêiner, e isso é
//  decisão com motivo: uma regra que acrescenta e chega atrasada no
//  boot do wipe erra para menos; uma que remove, chegando tarde,
//  distribui o que devia ter sumido — e sem sintoma nenhum
//  (Docs/CustomItem/05 §10.1).
//
//  A aba de TABELAS é o oposto, e é assim por natureza: ela edita o
//  arquivo que o BetterLoot lê, e ali tirar um item é apagar uma
//  linha. A diferença é o momento — a tabela é lida uma vez, no
//  carregamento do plugin, e não a cada caixa que nasce.
//
//  ####  A LISTA DE CONTÊINERES É LIDA UMA VEZ, AQUI  ####
//
//  As duas abas e o formulário precisam dela. Lê-la em cada um
//  daria três respostas e três momentos diferentes — e o
//  formulário poderia oferecer um contêiner que a aba ao lado não
//  mostra.
// ============================================================

import { Boxes } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BetterLootPanel } from '@/components/loot/betterloot-panel';
import { CONTAINERS_PER_DAY_START } from '@/components/loot/chance';
import { ContainersPanel } from '@/components/loot/containers-panel';
import { FALLBACK_CONTAINERS } from '@/components/loot/containers';
import { LootRuleDialog } from '@/components/loot/loot-rule-dialog';
import { LootRules } from '@/components/loot/loot-rules';
import { RuleStatsDialog } from '@/components/loot/rule-stats-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import {
  agent,
  type LootContainerInfo,
  type LootRule,
  type LootRuleInput,
} from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'tabelas' | 'regras' | 'conteineres';

export default function LootPage() {
  return (
    <RequireSession>
      <Loot />
    </RequireSession>
  );
}

function Loot() {
  const [tab, setTab] = useState<Tab>('tabelas');
  const [rules, setRules] = useState<readonly LootRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [containers, setContainers] = useState<readonly LootContainerInfo[]>(FALLBACK_CONTAINERS);
  /** A lista veio do agente, ou é a de reserva do painel? */
  const [containersFromAgent, setContainersFromAgent] = useState(false);
  const [containersError, setContainersError] = useState<string | null>(null);

  const [servers, setServers] = useState<readonly { id: string; name: string }[]>([]);
  /** Vazio = todas as regras, de todos os servidores. */
  const [serverId, setServerId] = useState('');

  /**
   * A suposição que traduz a chance.
   *
   * Mora na PÁGINA, e não em cada bloco: a lista e o formulário
   * precisam projetar com o mesmo denominador, senão a mesma regra
   * apareceria com duas frequências diferentes em duas telas.
   */
  const [containersPerDay, setContainersPerDay] = useState(CONTAINERS_PER_DAY_START);

  const [editing, setEditing] = useState<LootRule | null>(null);
  const [preset, setPreset] = useState<Partial<LootRuleInput> | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [statsRule, setStatsRule] = useState<LootRule | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.lootRules(serverId === '' ? {} : { serverId });

      setRules(response.rules);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A lista de contêineres e a de servidores alimentam os
  // SELETORES, e não a tabela. São lidas uma vez: um servidor novo
  // no meio de um cadastro de loot é raro o bastante para não
  // valer uma consulta por abertura.
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.lootContainers();

        if (!alive) return;

        // Uma resposta vazia NÃO substitui a lista de reserva: uma
        // tela de cadastro sem contêiner nenhum não é uma tela
        // degradada, é uma tela inútil.
        if (response.containers.length > 0) {
          setContainers(response.containers);
          setContainersFromAgent(true);
        }

        setContainersError(null);
      } catch (cause) {
        if (alive) {
          setContainersError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    void (async () => {
      try {
        const response = await agent.servers();

        if (alive) {
          setServers(response.servers.map((server) => ({ id: server.id, name: server.name })));
        }
      } catch {
        // Sem a lista de servidores o cadastro ainda abre, e o erro
        // de verdade aparece na tabela.
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const openDialog = (rule: LootRule | null, withPreset?: Partial<LootRuleInput>): void => {
    setEditing(rule);
    setPreset(withPreset);
    setDialogOpen(true);
  };

  const measuring = (rules ?? []).filter((rule) => rule.mode === 'measuring' && rule.enabled);
  const live = (rules ?? []).filter((rule) => rule.mode === 'live' && rule.enabled);

  return (
    <div>
      <PageHeader
        title="Loot"
        description="O que a casa acrescenta às caixas do jogo — onde, com que frequência, e com que freio."
        aside={
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <Boxes aria-hidden="true" className="h-4 w-4" />
            {rules === null
              ? 'lendo…'
              : `${String(live.length)} valendo · ${String(measuring.length)} medindo`}
          </span>
        }
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex border-b border-border">
          <TabButton active={tab === 'tabelas'} onClick={() => setTab('tabelas')}>
            Tabelas
          </TabButton>
          <TabButton active={tab === 'regras'} onClick={() => setTab('regras')}>
            Regras {rules === null ? '' : `(${String(rules.length)})`}
          </TabButton>
          <TabButton active={tab === 'conteineres'} onClick={() => setTab('conteineres')}>
            Contêineres ({String(containers.length)})
          </TabButton>
        </div>

        {/* ####  O SELETOR DO TOPO NÃO VALE NA ABA TABELAS  ####

            Ali "Todos" não existe: a tabela é o arquivo de UM
            servidor, e a aba tem o seletor dela, sem essa opção.
            Deixar os dois na tela daria dois controles de servidor
            com significados diferentes lado a lado — e o admin
            trocaria o errado. */}
        {tab !== 'tabelas' && servers.length > 0 && (
          <label className="flex items-center gap-2 text-2xs text-muted">
            Servidor
            <select
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
              className="h-8 border border-border bg-surface-2 px-2 text-2xs text-foreground"
            >
              <option value="">Todos</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-4">
        {/* Os dois estados são da aba de REGRAS: a de contêineres
            se vira sozinha, com a lista de reserva, mesmo que o
            agente ainda não tenha a rota das regras. */}
        {tab === 'regras' && rules === null && error === null && (
          <StateBlock variant="loading" title="Lendo as regras de loot…" />
        )}

        {tab === 'regras' && rules === null && error !== null && (
          <StateBlock
            variant="error"
            title="Não consegui ler as regras"
            detail={`${error} — se o agente ainda não tem a rota /api/loot/rules, esta tela fica assim até ela subir.`}
          />
        )}

        {rules !== null && tab === 'regras' && (
          <LootRules
            rules={rules}
            error={error}
            servers={servers}
            containersPerDay={containersPerDay}
            onContainersPerDayChange={setContainersPerDay}
            onCreate={() => openDialog(null)}
            onEdit={(rule) => openDialog(rule)}
            onStats={(rule) => {
              setStatsRule(rule);
              setStatsOpen(true);
            }}
            onChanged={() => void load()}
          />
        )}

        {tab === 'tabelas' && <BetterLootPanel servers={servers} />}

        {tab === 'conteineres' && (
          <ContainersPanel
            containers={containers}
            fromAgent={containersFromAgent}
            error={containersError}
            rules={rules ?? []}
            onCreateHere={(container) => openDialog(null, { containers: [container] })}
          />
        )}
      </div>

      <LootRuleDialog
        open={dialogOpen}
        rule={editing}
        preset={preset}
        containers={containers}
        containersFromAgent={containersFromAgent}
        servers={servers}
        containersPerDay={containersPerDay}
        onContainersPerDayChange={setContainersPerDay}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
      />

      <RuleStatsDialog
        open={statsOpen}
        rule={statsRule}
        onClose={() => setStatsOpen(false)}
        onChanged={() => void load()}
        onContainersPerDayChange={setContainersPerDay}
      />
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
