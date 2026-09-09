'use client';

// ============================================================
//  /eventos  -  o que a casa faz nascer no mapa.
//
//  ####  TRÊS PERGUNTAS, TRÊS ABAS  ####
//
//    Masmorras   o que existe, e o que está de pé agora
//    Plantas     o acervo de construções prontas
//    Histórico   o que nasceu, e o que NÃO nasceu — e por quê
//
//  A quarta aba do plano (a agenda dos eventos automáticos) chega
//  com o agendador. Uma aba vazia hoje seria uma promessa que a
//  tela não cumpre.
//
//  ####  A LEITURA É FEITA UMA VEZ, AQUI  ####
//
//  As três abas precisam das mesmas listas, e o editor precisa das
//  plantas para o seletor de entrada. Ler em cada uma daria quatro
//  consultas para a mesma resposta — e, pior, quatro momentos
//  diferentes: subir uma planta numa aba e não vê-la no editor é o
//  tipo de divergência que faz alguém subir o arquivo duas vezes.
//
//  É a mesma escolha de `/quests` e `/ranking`.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §11.
// ============================================================

import { Plus, Swords } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BlueprintShelf } from '@/components/dungeons/blueprint-shelf';
import { DungeonDialog } from '@/components/dungeons/dungeon-dialog';
import { DungeonList, LiveCard } from '@/components/dungeons/dungeon-list';
import { RunHistory } from '@/components/dungeons/run-history';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { HelpTip } from '@/components/ui/help-tip';
import {
  agent,
  type BlueprintSummary,
  type Dungeon,
  type DungeonSummary,
  type EventRun,
} from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { cn } from '@/lib/utils';

type Tab = 'masmorras' | 'plantas' | 'historico';

export default function EventosPage() {
  return (
    <RequireSession>
      <Eventos />
    </RequireSession>
  );
}

function Eventos() {
  const [tab, setTab] = useState<Tab>('masmorras');
  const [dungeons, setDungeons] = useState<readonly DungeonSummary[] | null>(null);
  const [blueprints, setBlueprints] = useState<readonly BlueprintSummary[]>([]);
  const [runs, setRuns] = useState<readonly EventRun[] | null>(null);
  const [servers, setServers] = useState<readonly { id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** `undefined` = fechado; `null` = criando; uma masmorra = editando. */
  const [editing, setEditing] = useState<Dungeon | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [dungeonResponse, blueprintResponse, runResponse, serverResponse] = await Promise.all([
        agent.dungeons(),
        agent.dungeonBlueprints(),
        agent.worldEventRuns({ limit: 50 }),
        agent.servers(),
      ]);

      setDungeons(dungeonResponse.dungeons);
      setBlueprints(blueprintResponse.blueprints);
      setRuns(runResponse.runs);
      setServers(serverResponse.servers.map((server) => ({ id: server.id, name: server.name })));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = (runs ?? []).filter((run) => run.endedAt === null && run.status !== 'failed');

  return (
    // Sem padding no wrapper: o `PageHeader` traz o dele (px-4 py-3)
    // e cada bloco abaixo traz o seu. Um `p-4` aqui empurraria a
    // tela inteira para dentro e ela ficaria desalinhada das
    // vizinhas — foi o que aconteceu na primeira versao, e da para
    // ver de relance colocando /loot e /eventos lado a lado.
    <div>
      <PageHeader
        title="Eventos"
        description="O que a casa faz nascer no mapa"
        aside={
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted">
              <Swords aria-hidden="true" className="h-4 w-4" />
              {dungeons === null
                ? 'lendo…'
                : `${String(dungeons.length)} masmorra(s)${live.length > 0 ? ` · ${String(live.length)} no ar` : ''}`}
            </span>

            <Button size="sm" variant="primary" onClick={() => setEditing(null)}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Nova masmorra
            </Button>
          </div>
        }
      />

      <div className="mt-4 flex items-center justify-between border-b border-border">
        <div className="flex">
          <TabButton active={tab === 'masmorras'} onClick={() => setTab('masmorras')}>
            Masmorras {dungeons === null ? '' : `(${String(dungeons.length)})`}
          </TabButton>
          <TabButton active={tab === 'plantas'} onClick={() => setTab('plantas')}>
            Plantas ({String(blueprints.length)})
          </TabButton>
          <TabButton active={tab === 'historico'} onClick={() => setTab('historico')}>
            Histórico
          </TabButton>
        </div>

        {/* O guia da tela. O modelo "a masmorra fica 90 metros
            abaixo do mundo e o alçapão teleporta" NÃO é adivinhável,
            e quem não o entende não entende por que a entrada é uma
            planta separada. */}
        <span className="flex items-center gap-1.5 pr-1 text-2xs text-muted">
          Como funciona
          <HelpTip topic={DUNGEON_HELP.modelo} />
        </span>
      </div>

      <div className="mt-4">
        {error !== null && dungeons === null && (
          <StateBlock variant="error" title="Não consegui falar com o agente" detail={error} />
        )}

        {dungeons === null && error === null && (
          <StateBlock variant="loading" title="Lendo as masmorras…" />
        )}

        {dungeons !== null && tab === 'masmorras' && (
          <div className="space-y-3">
            {/* O cartão vem ANTES do catálogo, e independe dele: o
                que está no chão do jogo não depende de haver
                masmorra cadastrada. Apagar uma que está no ar é o
                caso em que os dois divergem. */}
            {live.length > 0 && <LiveCard runs={live} onChanged={() => void load()} />}

            {dungeons.length === 0 ? (
              <FirstRun onStart={() => setEditing(null)} />
            ) : (
              <DungeonList
                dungeons={dungeons}
                onEdit={(dungeon) => setEditing(dungeon)}
                onChanged={() => void load()}
              />
            )}
          </div>
        )}

        {dungeons !== null && tab === 'plantas' && (
          <BlueprintShelf blueprints={blueprints} onChanged={() => void load()} />
        )}

        {dungeons !== null && tab === 'historico' && <RunHistory runs={runs} error={error} />}
      </div>

      {editing !== undefined && (
        <DungeonDialog
          dungeon={editing}
          blueprints={blueprints}
          servers={servers}
          onClose={() => setEditing(undefined)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

/**
 * O primeiro uso.
 *
 * Uma tabela vazia com um botão "criar" não diz nada a quem nunca
 * fez isso. O que ajuda é mostrar os caminhos — e o primeiro deles
 * é partir de algo pronto, porque as quatro receitas de fábrica
 * são os níveis do Dungeon Bases, já balanceados e rodados.
 */
function FirstRun({ onStart }: { readonly onStart: () => void }) {
  return (
    <div className="border border-border bg-surface p-6">
      <h2 className="font-condensed text-lg font-bold uppercase tracking-wide">
        Nenhuma masmorra ainda
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Uma masmorra é uma casinha no mapa com um alçapão — e, noventa metros abaixo do mundo, os
        corredores e as salas que ninguém vê de fora.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Path
          title="Partir de uma pronta"
          detail="Quatro níveis já balanceados: fácil, normal, difícil e pesadelo. Duplique e mexa no que quiser."
        />
        <Path
          title="Montar do zero"
          detail="Seis passos, com uma prévia ao lado que mostra a masmorra que vai nascer enquanto você mexe nos números."
        />
        <Path
          title="Usar uma planta"
          detail="Sete construções prontas vieram com o projeto. Elas ficam na aba Plantas, e viram a entrada da sua masmorra."
        />
      </div>

      <Button variant="primary" className="mt-4" onClick={onStart}>
        <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
        Criar a primeira
      </Button>
    </div>
  );
}

function Path({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="border border-border bg-surface-2 p-3">
      <h3 className="flex items-center gap-2 font-condensed text-xs font-bold uppercase tracking-wide">
        <span aria-hidden="true" className="h-3 w-[3px] shrink-0 bg-rust" />
        {title}
      </h3>
      <p className="mt-1 text-2xs text-muted">{detail}</p>
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
