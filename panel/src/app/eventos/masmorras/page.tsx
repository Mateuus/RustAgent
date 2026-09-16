'use client';

// ============================================================
//  /eventos/masmorras  -  a casinha com alçapão.
//
//  ####  ELA ERA A TELA DE EVENTOS INTEIRA  ####
//
//  Era, enquanto a masmorra era o único inquilino do guarda-chuva.
//  Com o KOTH chegando, o que é DE TODAS as famílias subiu para
//  `/eventos` — o que está no ar, a agenda e o histórico —, e aqui
//  ficou o que só a masmorra tem.
//
//  ####  TRÊS PERGUNTAS, TRÊS ABAS  ####
//
//    Masmorras    o que existe, e o que está de pé agora
//    Onde nasce   os lugares do mapa em que ela pode subir
//    Plantas      o acervo de traçados e construções prontas
//
//  Plantas é daqui e não do hub: um traçado de células e um .json
//  do CopyPaste são a matéria-prima DESTA família. O KOTH não cola
//  planta nenhuma para existir — ele marca um território.
//
//  ####  A LEITURA É FEITA UMA VEZ, AQUI  ####
//
//  As abas precisam das mesmas listas, e o editor precisa das
//  plantas para o seletor de entrada. Ler em cada uma daria quatro
//  consultas para a mesma resposta — e, pior, quatro momentos
//  diferentes: subir uma planta numa aba e não vê-la no editor é o
//  tipo de divergência que faz alguém subir o arquivo duas vezes.
//
//  É a mesma escolha de `/quests` e `/ranking`.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §11.
// ============================================================

import { ArrowLeft, Plus, Swords } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BlueprintShelf } from '@/components/dungeons/blueprint-shelf';
import { DungeonDialog } from '@/components/dungeons/dungeon-dialog';
import { BuildDialog } from '@/components/dungeons/build-dialog';
import { DungeonList } from '@/components/dungeons/dungeon-list';
import { SpawnPointsPanel } from '@/components/dungeons/spawn-points-panel';
import { LayoutShelf } from '@/components/dungeons/layout-shelf';
import { LiveCard } from '@/components/events/live-card';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { HelpTip } from '@/components/ui/help-tip';
import {
  agent,
  type BlueprintSummary,
  type Dungeon,
  type DungeonLayoutSummary,
  type DungeonSummary,
  type EventRun,
  type WorldEvent,
} from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { cn } from '@/lib/utils';

type Tab = 'masmorras' | 'onde' | 'plantas';

export default function MasmorrasPage() {
  return (
    <RequireSession>
      <Masmorras />
    </RequireSession>
  );
}

function Masmorras() {
  const [tab, setTab] = useState<Tab>('masmorras');
  const [dungeons, setDungeons] = useState<readonly DungeonSummary[] | null>(null);
  const [blueprints, setBlueprints] = useState<readonly BlueprintSummary[]>([]);
  const [layouts, setLayouts] = useState<readonly DungeonLayoutSummary[]>([]);
  /**
   * As runs, só para o cartão do que está no ar.
   *
   * O histórico inteiro é do hub. Aqui a lista serve a uma única
   * pergunta — tem masmorra de pé agora? —, e por isso ela não
   * precisa de estado de erro próprio: sem resposta, o cartão
   * simplesmente não aparece.
   */
  const [runs, setRuns] = useState<readonly EventRun[] | null>(null);
  const [events, setEvents] = useState<readonly WorldEvent[]>([]);
  const [servers, setServers] = useState<readonly { id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** `undefined` = fechado; `null` = criando; uma masmorra = editando. */
  const [editing, setEditing] = useState<Dungeon | null | undefined>(undefined);
  /** A masmorra que está para ser erguida. `null` = ninguém. */
  const [building, setBuilding] = useState<DungeonSummary | null>(null);
  /** O servidor cujos pontos a aba "Onde nasce" está mostrando. */
  const [pointsServer, setPointsServer] = useState<string>('');
  /**
   * O traçado com que a criação começa.
   *
   * É o atalho da aba Plantas: clicar em "Usar" abre a masmorra
   * nova já no modo desenho, com aquele traçado dentro. Sem ele, o
   * admin teria de abrir a criação, trocar o modo e procurar o
   * traçado outra vez na faixa.
   */
  const [startFrom, setStartFrom] = useState<DungeonLayoutSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const [
        dungeonResponse,
        blueprintResponse,
        layoutResponse,
        runResponse,
        eventResponse,
        serverResponse,
      ] = await Promise.all([
        agent.dungeons(),
        agent.dungeonBlueprints(),
        agent.dungeonLayouts(),
        agent.worldEventRuns({ limit: 50 }),
        agent.worldEvents(),
        agent.servers(),
      ]);

      setDungeons(dungeonResponse.dungeons);
      setBlueprints(blueprintResponse.blueprints);
      setLayouts(layoutResponse.layouts);
      setRuns(runResponse.runs);
      setEvents(eventResponse.events);
      setServers(serverResponse.servers.map((server) => ({ id: server.id, name: server.name })));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ####  NO AR AGORA, DESTA FAMÍLIA  ####
  //
  // `event_runs` é do guarda-chuva: com o KOTH no ar, as runs dele
  // chegam nesta mesma lista. Quem separa é o `kind` do evento —
  // não `dungeonId`, que é campo opcional e estaria `null` numa
  // masmorra mal cadastrada também.
  //
  // Uma run cujo evento sumiu da agenda (apagado enquanto estava de
  // pé) fica SEM família e aparece aqui: ela está no chão do jogo, e
  // esta é a tela que tem o botão de derrubar.
  const dungeonEvents = new Set(
    events.filter((event) => event.kind === 'dungeon').map((event) => event.id),
  );
  const known = new Set(events.map((event) => event.id));

  const live = (runs ?? []).filter(
    (run) =>
      run.endedAt === null &&
      run.status !== 'failed' &&
      (dungeonEvents.has(run.eventId) || !known.has(run.eventId)),
  );

  return (
    // Sem padding no wrapper: o `PageHeader` traz o dele (px-4 py-3)
    // e cada bloco abaixo traz o seu. Um `p-4` aqui empurraria a
    // tela inteira para dentro e ela ficaria desalinhada das
    // vizinhas — foi o que aconteceu na primeira versao, e da para
    // ver de relance colocando /loot e /eventos lado a lado.
    <div>
      <PageHeader
        title="Masmorras"
        description="A casinha com alçapão, e o que existe noventa metros abaixo dela"
        aside={
          <div className="flex items-center gap-3">
            {/* O caminho de volta. Ele é um link e não um botão de
                histórico: quem chega por URL colada também precisa
                achar o resto dos eventos. */}
            <Link
              href="/eventos/"
              className="flex items-center gap-1 font-condensed text-2xs uppercase tracking-wide text-muted hover:text-foreground"
            >
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
              Eventos
            </Link>

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
          <TabButton active={tab === 'onde'} onClick={() => setTab('onde')}>
            Onde nasce
          </TabButton>
          <TabButton active={tab === 'plantas'} onClick={() => setTab('plantas')}>
            Plantas ({String(blueprints.length + layouts.length)})
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
                // Sem servidor cadastrado o botão abriria um diálogo
                // sem para onde mandar o comando.
                onBuild={servers.length === 0 ? undefined : (dungeon) => setBuilding(dungeon)}
              />
            )}
          </div>
        )}

        {dungeons !== null && tab === 'onde' && (
          // ####  ELA RESPONDE A PERGUNTA QUE O EDITOR NÃO RESPONDIA  ####
          //
          // O passo ⑥ dizia: "o painel sabe tudo sobre esta masmorra,
          // menos ONDE ela deve nascer". Esta aba é onde isso passa a
          // ser sabido — e é o que faz o botão Erguer ter para onde
          // apontar.
          <WhereTab
            servers={servers}
            serverId={pointsServer === '' ? (servers[0]?.id ?? '') : pointsServer}
            onServer={setPointsServer}
          />
        )}

        {dungeons !== null && tab === 'plantas' && (
          // ####  DUAS SEÇÕES, PORQUE SÃO DUAS COISAS  ####
          //
          // Um traçado é o mapa das células, que o plugin CONSTRÓI;
          // uma construção é o JSON do CopyPaste, que ele COLA. Para
          // quem usa, as duas são "plantas" — e por isso moram na
          // mesma aba —, mas escolher entre elas é escolher entre
          // desenhar e colar, e a tela precisa dizer isso.
          //
          // Os traçados vêm primeiro: é deles que sai toda masmorra
          // nova. As construções são a casinha da entrada, e se
          // escolhem uma vez.
          <div className="space-y-6">
            <section className="space-y-3">
              <SectionTitle
                title="Plantas desenhadas"
                detail="O mapa dos corredores e das salas. É daqui que uma masmorra nova parte."
                count={layouts.length}
              />
              <LayoutShelf
                layouts={layouts}
                onChanged={() => void load()}
                onUse={(layout) => {
                  setStartFrom(layout);
                  setEditing(null);
                }}
              />
            </section>

            <section className="space-y-3">
              <SectionTitle
                title="Construções (.json)"
                detail="Prédios inteiros no formato do CopyPaste. É deles que sai a casinha da entrada."
                count={blueprints.length}
              />
              <BlueprintShelf blueprints={blueprints} onChanged={() => void load()} />
            </section>
          </div>
        )}
      </div>

      {building !== null && (
        <BuildDialog
          dungeon={building}
          servers={servers}
          onClose={() => setBuilding(null)}
          // O histórico é quem confirma que ela subiu: recarregar
          // aqui é o que faz o cartão "no ar agora" aparecer.
          onSent={() => void load()}
        />
      )}

      {editing !== undefined && (
        <DungeonDialog
          dungeon={editing}
          blueprints={blueprints}
          layouts={layouts}
          startFrom={startFrom?.grid ?? null}
          servers={servers}
          onClose={() => {
            setEditing(undefined);
            setStartFrom(null);
          }}
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

/**
 * O cabeçalho de uma seção da aba Plantas.
 *
 * Ele existe porque as duas listas parecem a mesma coisa e não são
 * — e sem uma linha dizendo o que cada uma é, o admin sobe um .json
 * esperando que ele vire o traçado da masmorra.
 */
function SectionTitle({
  title,
  detail,
  count,
}: {
  readonly title: string;
  readonly detail: string;
  readonly count: number;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
        {title}
        <span className="font-normal text-muted">({count})</span>
      </h2>
      <p className="text-2xs text-muted">{detail}</p>
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

/**
 * A aba "Onde nasce".
 *
 * Um seletor de servidor e o painel de pontos. O servidor é escolha
 * desta tela porque um ponto é de um MAPA — e cada servidor tem o
 * seu.
 */
function WhereTab({
  servers,
  serverId,
  onServer,
}: {
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly serverId: string;
  readonly onServer: (id: string) => void;
}) {
  if (servers.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="Nenhum servidor cadastrado"
        detail="Um ponto de nascimento é de um mapa, e um mapa é de um servidor."
      />
    );
  }

  return (
    <div className="space-y-3">
      {servers.length > 1 && (
        <label className="flex items-center gap-2">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Servidor
          </span>
          <select
            value={serverId}
            onChange={(event) => onServer(event.target.value)}
            className="h-9 border border-border bg-background px-2 text-sm"
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <SpawnPointsPanel serverId={serverId} />
    </div>
  );
}
