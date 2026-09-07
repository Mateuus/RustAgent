'use client';

// ============================================================
//  /quests  -  as missões da REDE.
//
//  ####  TRÊS PERGUNTAS, TRÊS ABAS  ####
//
//    Catálogo     o que existe para ser feito
//    Progresso    quem está fazendo o quê — a aba do suporte
//    Manutenção   NPCs, pendências e o botão de zerar
//
//  ####  O CATÁLOGO É LIDO UMA VEZ, AQUI  ####
//
//  As três abas precisam da mesma lista. Lê-la em cada uma daria
//  três consultas para a mesma resposta — e, pior, três momentos
//  diferentes: criar uma missão numa aba e não vê-la na outra é o
//  tipo de divergência que faz alguém cadastrar duas vezes.
//
//  É a mesma escolha de `/ranking`.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §12.
// ============================================================

import { Plus, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { PageHeader } from '@/components/page-header';
import { QuestCatalog } from '@/components/quests/quest-catalog';
import { QuestDialog } from '@/components/quests/quest-dialog';
import { QuestMaintenance } from '@/components/quests/quest-maintenance';
import { QuestProgressPanel } from '@/components/quests/quest-progress';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent, type QuestDefinition, type QuestNpc } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'catalogo' | 'progresso' | 'manutencao';

export default function QuestsPage() {
  return (
    <RequireSession>
      <Quests />
    </RequireSession>
  );
}

function Quests() {
  const [tab, setTab] = useState<Tab>('catalogo');
  const [quests, setQuests] = useState<readonly QuestDefinition[] | null>(null);
  const [npcs, setNpcs] = useState<readonly QuestNpc[]>([]);
  const [servers, setServers] = useState<readonly { id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<readonly { category: string; total: number }[]>([]);
  /** `''` = todas. */
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** `undefined` = fechado; `null` = criando; uma quest = editando. */
  const [editing, setEditing] = useState<QuestDefinition | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      // As duas juntas: o editor precisa da lista de NPCs para o
      // seletor, e o catálogo precisa dos nomes deles para a linha.
      const [questResponse, npcResponse, categoryResponse] = await Promise.all([
        agent.quests(),
        agent.questNpcs(),
        // As categorias com a contagem de cada uma: é o filtro do
        // catálogo, e ele deixa de ser enfeite quando há vinte
        // missões e o admin procura a diária.
        agent.questCategories(),
      ]);

      setQuests(questResponse.quests);
      setNpcs(npcResponse.npcs);
      setCategories(categoryResponse.categories);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Os servidores alimentam os SELETORES, e não a lista. São lidos
  // uma vez: um servidor novo no meio de uma edição de missão é
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
        // Sem a lista, a missão de rede continua funcionando — e o
        // erro de verdade aparece no catálogo.
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const enabled = (quests ?? []).filter((quest) => quest.enabled);
  const npcNames = Object.fromEntries(npcs.map((npc) => [npc.id, npc.name]));

  return (
    <div>
      <PageHeader
        title="Missões"
        description="O que os jogadores têm para fazer, o que ganham, e como está o progresso de cada um."
        aside={
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
              <ScrollText aria-hidden="true" className="h-4 w-4" />
              {quests === null
                ? 'lendo…'
                : `${String(enabled.length)} ligada(s) de ${String(quests.length)}`}
            </span>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="flex items-center gap-1.5 rounded bg-rust px-3 py-1.5 text-2xs uppercase tracking-wide text-white"
            >
              <Plus className="h-3.5 w-3.5" />
              Nova missão
            </button>
          </div>
        }
      />

      <div className="mt-4 flex border-b border-border">
        <TabButton active={tab === 'catalogo'} onClick={() => setTab('catalogo')}>
          Catálogo {quests === null ? '' : `(${String(quests.length)})`}
        </TabButton>
        <TabButton active={tab === 'progresso'} onClick={() => setTab('progresso')}>
          Progresso
        </TabButton>
        <TabButton active={tab === 'manutencao'} onClick={() => setTab('manutencao')}>
          Manutenção
        </TabButton>
      </div>

      <div className="mt-4">
        {quests === null && error === null && (
          <StateBlock variant="loading" title="Lendo o catálogo de missões…" />
        )}

        {quests === null && error !== null && (
          <StateBlock variant="error" title="Não consegui ler o catálogo" detail={error} />
        )}

        {quests !== null && tab === 'catalogo' && categories.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1">
            <CategoryChip active={category === ''} onClick={() => setCategory('')}>
              Todas ({String(quests.length)})
            </CategoryChip>
            {categories.map((item) => (
              <CategoryChip
                key={item.category}
                active={category === item.category}
                onClick={() => setCategory(item.category)}
              >
                {item.category} ({String(item.total)})
              </CategoryChip>
            ))}
          </div>
        )}

        {quests !== null && tab === 'catalogo' && (
          <QuestCatalog
            quests={category === '' ? quests : quests.filter((item) => item.category === category)}
            npcNames={npcNames}
            onEdit={(quest) => setEditing(quest)}
            onChanged={() => void load()}
          />
        )}

        {quests !== null && tab === 'progresso' && (
          <QuestProgressPanel quests={quests} servers={servers} />
        )}

        {quests !== null && tab === 'manutencao' && (
          <QuestMaintenance servers={servers} onChanged={() => void load()} />
        )}
      </div>

      {editing !== undefined && (
        <QuestDialog
          quest={editing}
          servers={servers}
          quests={quests ?? []}
          npcs={npcs.map((npc) => ({ id: npc.id, name: npc.name }))}
          onClose={() => setEditing(undefined)}
          onSaved={() => void load()}
        />
      )}
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

function CategoryChip({
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
      className={cn(
        'rounded border px-2 py-1 font-condensed text-2xs uppercase tracking-wide',
        active
          ? 'border-rust bg-rust/10 text-foreground'
          : 'border-border text-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
