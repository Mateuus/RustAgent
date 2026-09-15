'use client';

// ============================================================
//  teams-panel.tsx  -  as equipes que existem no jogo AGORA.
//
//  ####  POR QUE ISTO NÃO É UMA LISTA DE CARTÕES  ####
//
//  A primeira versão era: um cartão por equipe, com TODOS os
//  membros abertos. Com vinte equipes de oito, são cento e sessenta
//  linhas empilhadas — e achar "em que equipe está o Fulano" vira
//  rolagem no olho.
//
//  O desenho certo para isto é o de sempre que a lista é longa e o
//  item é rico: LISTA à esquerda, DETALHE à direita.
//
//    ┌──────────────┬───────────────────────────┐
//    │ busca        │  Alcateia do Norte    #2  │
//    │ ──────────── │  ─────────────────────── │
//    │ ▸ Alcateia 4 │  4 membros · 2 online     │
//    │   Os Lobos 8 │  ─────────────────────── │
//    │   #7       2 │  Mateuus      LÍDER       │
//    │   …          │  Bia          OFICIAL  …  │
//    └──────────────┴───────────────────────────┘
//
//  A lista mostra o que serve para ESCOLHER (nome, tamanho, quantos
//  online); o painel mostra o que serve para AGIR. Abaixo de `lg` a
//  tela é estreita demais para as duas colunas, e aí o detalhe
//  aparece embaixo da lista.
//
//  ####  A BUSCA PROCURA GENTE, NÃO SÓ EQUIPE  ####
//
//  Porque a pergunta que se faz aqui quase nunca é "onde está a
//  equipe tal" — é "em que equipe está esse cara que me reportaram".
//  Ela casa nome de equipe, id, nome de membro e SteamID.
//
//  ####  ESTA TELA NÃO TEM CACHE, E ISSO É O PONTO  ####
//
//  Toda abertura pergunta ao servidor. A equipe muda a cada convite
//  aceito, e uma lista guardada mostraria um time que já se desfez —
//  com botões que agiriam sobre ele.
//
//  O preço é que ela depende do servidor DE PÉ. Com ele parado, a
//  tela diz isso, em vez de mostrar uma lista vazia: "não há equipe
//  nenhuma" e "não consegui perguntar" são respostas diferentes.
//
//  Ver Docs/OrigemZTeam/00-LEVANTAMENTO.md.
// ============================================================

import {
  Crown,
  Loader2,
  Pencil,
  Search,
  Settings2,
  ShieldHalf,
  UserMinus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { agent, type Team, type TeamMember } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface TeamsPanelProps {
  readonly serverId: string;
}

/** O teto do nome, o mesmo do agente e do plugin. */
const NAME_MAX = 24;

/**
 * Como a lista é ordenada.
 *
 * `size` é o padrão porque a equipe grande é a que interessa
 * primeiro — é ela que aparece no KOTH, que domina raide, e sobre a
 * qual chegam as reclamações.
 */
type Order = 'size' | 'online' | 'name';

const ORDERS: readonly { readonly key: Order; readonly label: string }[] = [
  { key: 'size', label: 'Maiores' },
  { key: 'online', label: 'Online' },
  { key: 'name', label: 'Nome' },
];

export function TeamsPanel({ serverId }: TeamsPanelProps) {
  const [teams, setTeams] = useState<readonly Team[] | null>(null);
  const [maxSize, setMaxSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<Order>('size');
  /** A equipe aberta à direita, por id. */
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.teams(serverId);

      setTeams(response.teams);
      setMaxSize(response.maxSize);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setTeams(null);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Roda uma ação e recarrega. O erro vira aviso, não tela em branco. */
  const act = useCallback(
    async (key: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy(key);

      try {
        await action();
        await load();
      } catch (cause) {
        toast.error('O servidor recusou', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const shown = useMemo(() => filterAndSort(teams ?? [], query, order), [teams, query, order]);

  // A equipe aberta some quando é desfeita, e a tela não pode ficar
  // apontando para o vazio: ela cai na primeira da lista.
  const open = shown.find((team) => team.teamId === openId) ?? shown[0] ?? null;

  if (error !== null) {
    return (
      <StateBlock
        variant="error"
        title="Não consegui perguntar ao servidor"
        detail={`${error} — as equipes vivem no jogo, e só ele sabe quem está em qual.`}
      />
    );
  }

  if (teams === null) return <StateBlock variant="loading" title="Lendo as equipes…" />;

  const online = teams.reduce(
    (total, team) => total + team.members.filter((member) => member.online).length,
    0,
  );

  return (
    <div className="space-y-3">
      {/* ####  A BARRA DE CIMA  ####
          Ela responde "quantas há" e "onde procuro" antes de a vista
          descer para a lista. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
            Equipes no jogo
            <span className="font-normal text-muted">({teams.length})</span>
          </h2>
          <p className="mt-1 text-2xs text-muted">
            Lido do servidor agora. O time é do jogo — o que a casa acrescenta é o{' '}
            <strong className="text-foreground">nome</strong> e o{' '}
            <strong className="text-foreground">cargo</strong>.
            {maxSize > 0 && ` Cabem ${String(maxSize)}.`}
            {online > 0 && ` ${String(online)} jogador(es) online em equipe.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <Input
              value={query}
              placeholder="equipe, jogador ou SteamID"
              className="h-9 w-64 pl-7"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="flex border border-border">
            {ORDERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setOrder(entry.key)}
                aria-pressed={order === entry.key}
                className={cn(
                  'px-2 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                  order === entry.key
                    ? 'bg-surface-2 text-foreground'
                    : 'text-muted hover:text-foreground',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <Button size="sm" variant="outline" onClick={() => void load()}>
            Reler
          </Button>
        </div>
      </div>

      <TeamSettingsCard serverId={serverId} />

      {teams.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Ninguém montou equipe ainda"
          detail="Quando dois jogadores se juntarem no jogo, a equipe aparece aqui — e é aqui que ela ganha nome."
        />
      ) : shown.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Nada casou com a busca"
          detail={`Nenhuma equipe, jogador ou SteamID com "${query}".`}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {/* ####  A LISTA  ####
              Rolagem própria: com cinquenta equipes, a página inteira
              rolando levaria o painel de detalhe junto para fora da
              vista. */}
          <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto border border-border bg-surface">
            {shown.map((team) => (
              <TeamRow
                key={team.teamId}
                team={team}
                active={open?.teamId === team.teamId}
                onOpen={() => setOpenId(team.teamId)}
              />
            ))}
          </ul>

          {open !== null && (
            <TeamDetail
              key={open.teamId}
              team={open}
              serverId={serverId}
              busy={busy}
              maxSize={maxSize}
              onAct={act}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Uma linha da lista.
 *
 * Ela carrega só o que serve para ESCOLHER: o nome, o tamanho e
 * quantos estão online. O resto é do painel ao lado — repetir aqui
 * faria a lista voltar a ser o que ela era.
 */
function TeamRow({
  team,
  active,
  onOpen,
}: {
  readonly team: Team;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const online = team.members.filter((member) => member.online).length;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2',
          active && 'border-l-2 border-rust bg-surface-2',
        )}
      >
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate font-condensed text-sm font-bold uppercase tracking-wide',
              team.name === '' && 'text-muted',
            )}
          >
            {team.name === '' ? 'sem nome' : team.name}
          </p>
          <p className="flex items-center gap-2 text-2xs text-muted">
            <span className="font-mono">#{team.teamId}</span>
            <span className="truncate">{team.leaderName}</span>
          </p>
        </div>

        {/* Online primeiro, e em cor: é o número que muda o que se
            faz agora. O total fica ao lado, apagado. */}
        <span className="shrink-0 text-right">
          <span
            className={cn(
              'font-condensed text-sm font-bold',
              online > 0 ? 'text-olive' : 'text-muted',
            )}
          >
            {online}
          </span>
          <span className="text-2xs text-muted">/{team.members.length}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * O painel de uma equipe.
 *
 * ####  É AQUI QUE A EQUIPE VAI CRESCER  ####
 *
 * Hoje ele mostra o que o jogo sabe mais o cargo. Quando a equipe
 * entrar no ranking, é neste painel que a pontuação dela entra — ao
 * lado dos membros, e não numa tela nova: quem abre uma equipe quer
 * ver tudo dela de uma vez.
 */
function TeamDetail({
  team,
  serverId,
  busy,
  maxSize,
  onAct,
}: {
  readonly team: Team;
  readonly serverId: string;
  readonly busy: string | null;
  readonly maxSize: number;
  readonly onAct: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(team.name);

  const online = team.members.filter((member) => member.online).length;

  return (
    <section className="border border-border bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-3">
        <div className="min-w-0">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                autoFocus
                value={draft}
                maxLength={NAME_MAX}
                placeholder="Sem nome"
                className="h-8 w-56"
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={draft.trim() === '' || busy !== null}
                onClick={() =>
                  void onAct(`name:${team.teamId}`, async () => {
                    await agent.renameTeam(serverId, team.teamId, draft.trim());
                    setEditing(false);
                  })
                }
              >
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(team.name);
                  setEditing(false);
                }}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(team.name);
                setEditing(true);
              }}
              className="group flex items-center gap-2 text-left"
            >
              <span
                className={cn(
                  'font-condensed text-lg font-bold uppercase tracking-wide',
                  team.name === '' && 'text-muted',
                )}
              >
                {team.name === '' ? 'sem nome' : team.name}
              </span>
              <Pencil aria-hidden="true" className="h-4 w-4 text-muted group-hover:text-rust" />
            </button>
          )}

          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
            <span className="font-mono">#{team.teamId}</span>
            <span className="flex items-center gap-1">
              <Users aria-hidden="true" className="h-3 w-3" />
              {team.members.length}
              {maxSize > 0 && `/${String(maxSize)}`} membro(s)
            </span>
            {online > 0 && <span className="text-olive">{online} online</span>}
            {team.officers > 0 && <span>{team.officers} oficial(is)</span>}
            <span>de pé há {ageLabel(team.ageSeconds)}</span>
          </p>
        </div>

        <ConfirmButton
          variant="danger"
          disabled={busy !== null}
          icon={<UserMinus aria-hidden="true" className="h-3.5 w-3.5" />}
          label="Desfazer"
          confirmLabel="Desfazer mesmo"
          hint="A equipe acaba para todo mundo dentro dela, e os cargos somem junto. Não tem volta."
          onConfirm={() =>
            void onAct(`disband:${team.teamId}`, () => agent.disbandTeam(serverId, team.teamId))
          }
        />
      </header>

      <ul className="divide-y divide-border">
        {team.members.map((member) => (
          <MemberRow
            key={member.steamId}
            member={member}
            team={team}
            serverId={serverId}
            busy={busy}
            onAct={onAct}
          />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({
  member,
  team,
  serverId,
  busy,
  onAct,
}: {
  readonly member: TeamMember;
  readonly team: Team;
  readonly serverId: string;
  readonly busy: string | null;
  readonly onAct: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const working = busy === `member:${member.steamId}`;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 shrink-0 rounded-full', member.online ? 'bg-olive' : 'bg-border')}
        />

        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-condensed text-sm font-bold">
            {member.name}
            <RankBadge rank={member.rank} />
          </p>
          <p className="font-mono text-2xs text-muted">{member.steamId}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {working && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-muted" />}

        {/* O líder não recebe cargo: a liderança é do jogo, e um
            "oficial" gravado embaixo dele viraria dois cargos para a
            mesma pessoa no dia em que ela passasse a liderança. */}
        {!member.leader && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void onAct(`member:${member.steamId}`, () =>
                  agent.setTeamRank(
                    serverId,
                    team.teamId,
                    member.steamId,
                    member.rank === 'officer' ? 'member' : 'officer',
                  ),
                )
              }
            >
              <ShieldHalf aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              {member.rank === 'officer' ? 'Rebaixar' : 'Promover'}
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void onAct(`member:${member.steamId}`, () =>
                  agent.setTeamLeader(serverId, team.teamId, member.steamId),
                )
              }
            >
              <Crown aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Dar liderança
            </Button>

            <ConfirmButton
              variant="danger"
              disabled={busy !== null}
              icon={<UserMinus aria-hidden="true" className="h-3.5 w-3.5" />}
              label="Expulsar"
              confirmLabel="Expulsar mesmo"
              hint="Ele sai da equipe no jogo, e o cargo dele some. Se for o último, a equipe se desfaz."
              onConfirm={() =>
                void onAct(`member:${member.steamId}`, () =>
                  agent.kickFromTeam(serverId, team.teamId, member.steamId),
                )
              }
            />
          </>
        )}
      </div>
    </li>
  );
}

function RankBadge({ rank }: { readonly rank: TeamMember['rank'] }) {
  if (rank === 'member') return null;

  return (
    <span
      className={cn(
        'border px-1.5 py-0.5 font-condensed text-2xs font-normal uppercase tracking-wide',
        rank === 'leader' ? 'border-amber text-amber' : 'border-border text-muted',
      )}
    >
      {rank === 'leader' ? 'Líder' : 'Oficial'}
    </span>
  );
}

/**
 * A busca e a ordem.
 *
 * Fora do componente porque é lógica pura — e porque assim ela é a
 * única coisa desta tela que dá para testar sem navegador.
 */
export function filterAndSort(
  teams: readonly Team[],
  query: string,
  order: Order,
): readonly Team[] {
  const needle = query.trim().toLowerCase();

  const found =
    needle === ''
      ? [...teams]
      : teams.filter(
          (team) =>
            team.name.toLowerCase().includes(needle) ||
            team.teamId.includes(needle) ||
            team.leaderName.toLowerCase().includes(needle) ||
            team.members.some(
              (member) =>
                member.name.toLowerCase().includes(needle) || member.steamId.includes(needle),
            ),
        );

  found.sort((left, right) => {
    if (order === 'name') {
      // Equipe sem nome vai para o fim: ordenar por string vazia a
      // jogaria para o topo, que é onde ela menos ajuda.
      if (left.name === '' && right.name !== '') return 1;
      if (right.name === '' && left.name !== '') return -1;

      return left.name.localeCompare(right.name);
    }

    if (order === 'online') {
      const diff = onlineOf(right) - onlineOf(left);

      return diff === 0 ? right.members.length - left.members.length : diff;
    }

    const diff = right.members.length - left.members.length;

    return diff === 0 ? onlineOf(right) - onlineOf(left) : diff;
  });

  return found;
}

function onlineOf(team: Team): number {
  return team.members.filter((member) => member.online).length;
}

/** "3 h", "12 min". O jogo conta do boot do servidor, não de uma data. */
function ageLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);

  if (minutes < 1) return 'menos de um minuto';
  if (minutes < 60) return `${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${String(hours)} h`;

  return `${String(Math.floor(hours / 24))} d`;
}

/**
 * A configuração de equipe daquele servidor.
 *
 * ####  POR QUE ELA MOSTRA DOIS NÚMEROS  ####
 *
 * O primeiro é o que o admin ESCOLHEU, e mora no agente. O segundo é
 * o que o jogo diz que vale AGORA.
 *
 * Eles divergem, e não por bug: `relationshipmanager.maxteamsize` é
 * um ServerVar que o Rust NÃO salva — medido em 15/09/2026, o
 * `server.writecfg` não o grava no serverauto.cfg. No próximo
 * restart o jogo volta a 8 sem avisar ninguém.
 *
 * O agente reaplica quando o RCON conecta. Esta tela mostra os dois
 * justamente para que a hora em que eles se separam seja visível —
 * escolher um para acreditar esconderia o problema.
 */
function TeamSettingsCard({ serverId }: { readonly serverId: string }) {
  const [saved, setSaved] = useState<number | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.teamSettings(serverId);

      setSaved(response.settings.maxSize);
      setLive(response.live);
      setDraft(String(response.settings.maxSize));
    } catch {
      // Sem configuração legível a seção some: ela não é o assunto
      // principal desta tela.
      setSaved(null);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (saved === null) return null;

  const diverge = live !== null && live !== saved;

  async function save(): Promise<void> {
    const value = Number(draft);

    if (!Number.isInteger(value) || value < 0 || value > 64) {
      toast.error('Valor inválido', { description: 'Use um número inteiro entre 0 e 64.' });
      return;
    }

    setBusy(true);

    try {
      await agent.saveTeamSettings(serverId, value);
      await load();
      toast.success('Tamanho aplicado', {
        description:
          value === 0
            ? 'Equipes desligadas neste servidor.'
            : `Cabem ${String(value)} por equipe, a partir de agora.`,
      });
    } catch (cause) {
      toast.error('Não consegui aplicar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 font-condensed text-2xs font-bold uppercase tracking-wide">
          <Settings2 aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
          Configuração de equipe
        </span>

        <span className="flex items-center gap-2 text-2xs text-muted">
          {saved === 0 ? 'equipes desligadas' : `${String(saved)} por equipe`}
          {diverge && (
            <span className="border border-amber px-1.5 py-0.5 uppercase tracking-wide text-amber">
              o jogo está com {String(live)}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                Máximo por equipe
              </span>
              <Input
                type="number"
                min={0}
                max={64}
                value={draft}
                className="mt-1 h-9 w-28"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>

            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              Aplicar
            </Button>
          </div>

          <p className="mt-2 max-w-2xl text-2xs text-muted">
            É o <span className="font-mono">relationshipmanager.maxteamsize</span> do Rust, e vale
            na hora — inclusive para as equipes que já existem. Zero{' '}
            <strong className="text-foreground">desliga</strong> equipes no servidor.
          </p>

          <p className="mt-1 max-w-2xl text-2xs text-muted">
            O jogo não guarda este valor: ele volta a 8 em todo restart. Quem tem a memória dele é
            o agente, que o reaplica quando o RCON conecta.
          </p>
        </div>
      )}
    </section>
  );
}
