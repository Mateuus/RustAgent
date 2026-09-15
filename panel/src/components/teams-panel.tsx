'use client';

// ============================================================
//  teams-panel.tsx  -  as equipes que existem no jogo AGORA.
//
//  ####  ESTA TELA NÃO TEM CACHE, E ISSO É O PONTO  ####
//
//  Toda abertura pergunta ao servidor. A equipe muda a cada convite
//  aceito, e uma lista guardada mostraria um time que já se desfez —
//  com botões que agiriam sobre ele.
//
//  O preço é que ela depende do servidor DE PÉ. Com ele parado, a
//  tela diz isso, em vez de mostrar uma lista vazia: "não há equipe
//  nenhuma" e "não consegui perguntar" são respostas diferentes, e
//  confundi-las é o jeito de o painel mentir com cara de dado.
//
//  ####  O QUE É DO JOGO, E O QUE É NOSSO  ####
//
//  Quem está dentro, quem é líder e quantos cabem: do jogo. O nome
//  da equipe é do jogo TAMBÉM — só que ninguém escrevia nele, e
//  agora escrevemos. O cargo é o único dado que nasce aqui.
//
//  Por isso "Promover" não tem confirmação e "Desfazer" tem: o
//  primeiro mexe numa linha nossa; o segundo acaba com uma equipe
//  de gente de verdade, e não tem volta.
//
//  Ver Docs/OrigemZTeam/00-LEVANTAMENTO.md.
// ============================================================

import { Crown, Loader2, Pencil, ShieldHalf, UserMinus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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

export function TeamsPanel({ serverId }: TeamsPanelProps) {
  const [teams, setTeams] = useState<readonly Team[] | null>(null);
  const [maxSize, setMaxSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
  async function act(key: string, action: () => Promise<unknown>): Promise<void> {
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
  }

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
            Equipes no jogo
          </h2>
          <p className="mt-1 max-w-2xl text-2xs text-muted">
            Lido do servidor agora. O time é do jogo — o que a casa acrescenta é o{' '}
            <strong className="text-foreground">nome</strong> e o{' '}
            <strong className="text-foreground">cargo</strong>.
            {maxSize > 0 && ` Cabem ${String(maxSize)} por equipe.`}
          </p>
        </div>

        <Button size="sm" variant="outline" onClick={() => void load()}>
          Reler
        </Button>
      </div>

      {teams.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Ninguém montou equipe ainda"
          detail="Quando dois jogadores se juntarem no jogo, a equipe aparece aqui — e é aqui que ela ganha nome."
        />
      ) : (
        <ul className="space-y-3">
          {teams.map((team) => (
            <TeamCard
              key={team.teamId}
              team={team}
              busy={busy}
              serverId={serverId}
              onAct={act}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamCard({
  team,
  serverId,
  busy,
  onAct,
}: {
  readonly team: Team;
  readonly serverId: string;
  readonly busy: string | null;
  readonly onAct: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(team.name);

  const online = team.members.filter((member) => member.online).length;

  return (
    <li className="border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
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
              onClick={() => setEditing(true)}
              className="group flex items-center gap-2 text-left"
            >
              <span
                className={cn(
                  'font-condensed text-base font-bold uppercase tracking-wide',
                  team.name === '' && 'text-muted',
                )}
              >
                {team.name === '' ? 'sem nome' : team.name}
              </span>
              <Pencil
                aria-hidden="true"
                className="h-3.5 w-3.5 text-muted group-hover:text-rust"
              />
            </button>
          )}

          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-2xs text-muted">
            <span className="font-mono">#{team.teamId}</span>
            <span className="flex items-center gap-1">
              <Users aria-hidden="true" className="h-3 w-3" />
              {team.members.length} membro(s){online > 0 && ` · ${String(online)} online`}
            </span>
            {team.officers > 0 && <span>{team.officers} oficial(is)</span>}
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
    </li>
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
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            member.online ? 'bg-olive' : 'bg-border',
          )}
        />

        <div className="min-w-0">
          <p className="flex items-center gap-2 font-condensed text-sm font-bold">
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
