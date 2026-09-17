'use client';

// ============================================================
//  access-panel.tsx  -  quem pode usar o quê, além da permissão.
//
//  ####  QUEM, E DEPOIS O QUÊ  ####
//
//  A pergunta do suporte começa pela PESSOA: "o Fulano ganhou a
//  máscara do evento?". Por isso a tela escolhe primeiro quem
//  (jogador ou grupo do Oxide) e só depois mostra e libera alvos.
//
//  ####  O ACESSO É UM "OU" A MAIS  ####
//
//  Uma skin é liberada por QUALQUER caminho: "para todos", permissão
//  da skin ou da coleção, `origemzworkshop.admin`, ou um acesso daqui
//  — na skin ou na coleção, para o jogador ou para um grupo dele.
//  Grupo usa a membership do Oxide NO SERVIDOR: quem decide é o
//  plugin, na hora.
//
//  Liberar de novo o mesmo alvo RENOVA o prazo (não duplica). E
//  remover, ou deixar vencer, não despinta o que já foi pintado.
//
//  ####  QUEM FALA COM O AGENTE É O PAINEL  ####
//
//  O formulário "Liberar" e a busca só recebem funções. Toda
//  resposta passa pelo `safeX` (normalize.ts).
// ============================================================

import { History, Loader2, Search, Trash2, UserRound, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import {
  formatDateTime,
  groupByShortname,
  messageOf,
  OXIDE_GROUP_PATTERN,
  safeCollection,
  safeGrant,
  safeSkin,
  STEAM_ID_PATTERN,
} from '@/components/workshop/normalize';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import {
  agent,
  ApiError,
  type WorkshopCollection,
  type WorkshopGrant,
  type WorkshopGrantInput,
  type WorkshopGrantSubjectType,
  type WorkshopGrantTargetType,
  type WorkshopSkin,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface AccessPanelProps {
  readonly servers: readonly WorkshopServerOption[];
  /** Abre a aba Registro filtrada por este jogador. */
  readonly onShowAudit: (steamId: string) => void;
}

/** Quem está escolhido. */
interface Subject {
  readonly type: WorkshopGrantSubjectType;
  /** SteamID64 ou nome do grupo, já normalizado. */
  readonly id: string;
  /** O nome do jogador, quando a busca o trouxe. */
  readonly name: string | null;
}

/** Um jogador da busca, com padrão em cada campo. */
interface PlayerHit {
  readonly steamId: string;
  readonly name: string;
  readonly online: boolean;
}

async function searchPlayers(query: string): Promise<PlayerHit[]> {
  const response = await agent.networkPlayers({ query, limit: 20, offset: 0 });

  return (Array.isArray(response.players) ? response.players : [])
    .map((player) => ({
      steamId: String(player.steamId ?? ''),
      name: typeof player.name === 'string' ? player.name : '',
      online: player.online === true,
    }))
    .filter((player) => player.steamId !== '');
}

export function AccessPanel({ servers, onShowAudit }: AccessPanelProps) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[]>([]);
  const [collections, setCollections] = useState<readonly WorkshopCollection[]>([]);
  const [groups, setGroups] = useState<readonly string[]>([]);

  const [subject, setSubject] = useState<Subject | null>(null);
  const [grants, setGrants] = useState<{ key: string; list: WorkshopGrant[] } | null>(null);
  const [grantsError, setGrantsError] = useState<string | null>(null);

  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<ApiError | null>(null);

  const firstServer = servers[0]?.id ?? null;

  // O catálogo alimenta os selects do "Liberar". Falhar aqui não
  // impede ver e remover acessos.
  useEffect(() => {
    let alive = true;

    void (async () => {
      const [skinsResult, collectionsResult] = await Promise.allSettled([
        agent.workshopSkins(),
        agent.workshopCollections(),
      ]);

      if (!alive) return;

      if (skinsResult.status === 'fulfilled') {
        setSkins((skinsResult.value.skins ?? []).map(safeSkin));
      }
      if (collectionsResult.status === 'fulfilled') {
        setCollections((collectionsResult.value.collections ?? []).map(safeCollection));
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // Os grupos do Oxide são só SUGESTÃO, e do primeiro servidor: com
  // ele parado, o campo continua sendo texto livre.
  useEffect(() => {
    if (firstServer === null) return;

    let alive = true;

    void (async () => {
      try {
        const response = await agent.oxidePermissions(firstServer);
        const names = (Array.isArray(response.groups) ? response.groups : [])
          .map((group) => (typeof group?.name === 'string' ? group.name.toLowerCase() : ''))
          .filter((name) => name !== '');

        if (alive) setGroups([...new Set(names)].sort());
      } catch {
        // Sem sugestão; o campo segue livre.
      }
    })();

    return () => {
      alive = false;
    };
  }, [firstServer]);

  const subjectKey = subject === null ? null : `${subject.type}:${subject.id}`;

  const fetchGrants = useCallback(async (target: Subject): Promise<WorkshopGrant[]> => {
    const response = await agent.workshopGrants({
      subjectType: target.type,
      subject: target.id,
      includeExpired: true,
    });

    return (response.grants ?? []).map(safeGrant);
  }, []);

  useEffect(() => {
    if (subject === null || subjectKey === null) return;

    let alive = true;

    void (async () => {
      try {
        const list = await fetchGrants(subject);

        if (!alive) return;

        setGrants({ key: subjectKey, list });
        setGrantsError(null);
      } catch (cause) {
        if (!alive) return;

        setGrants({ key: subjectKey, list: [] });
        setGrantsError(messageOf(cause));
      }
    })();

    return () => {
      alive = false;
    };
  }, [subject, subjectKey, fetchGrants]);

  async function reloadGrants(target: Subject): Promise<void> {
    try {
      const list = await fetchGrants(target);

      setGrants({ key: `${target.type}:${target.id}`, list });
      setGrantsError(null);
    } catch (cause) {
      setGrantsError(messageOf(cause));
    }
  }

  const currentGrants = grants !== null && grants.key === subjectKey ? grants.list : null;

  async function createGrant(input: WorkshopGrantInput, renewing: boolean): Promise<boolean> {
    if (subject === null) return false;

    setGranting(true);
    setGrantError(null);

    try {
      const response = await agent.createWorkshopGrant(input);
      const grant = response.grant === undefined ? null : safeGrant(response.grant);

      toast.success(
        renewing ? 'Acesso renovado' : 'Acesso liberado',
        grant === null ? undefined : { description: `${grant.targetLabel} · ${describeExpiry(grant)}` },
      );
      await reloadGrants(subject);

      return true;
    } catch (cause) {
      setGrantError(cause instanceof ApiError ? cause : new ApiError('', messageOf(cause), 0));

      return false;
    } finally {
      setGranting(false);
    }
  }

  async function removeGrant(grant: WorkshopGrant): Promise<void> {
    if (subject === null) return;

    try {
      await agent.removeWorkshopGrant(grant.id);
      toast.success('Acesso removido', {
        description: `${grant.targetLabel}. O que já foi pintado continua pintado.`,
      });
      await reloadGrants(subject);
    } catch (cause) {
      toast.error('Não consegui remover', { description: messageOf(cause) });
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <SubjectPicker
        groups={groups}
        selected={subject}
        onSearch={searchPlayers}
        onSelect={(next) => {
          setGrantError(null);
          setSubject(next);
        }}
      />

      <div className="min-w-0 space-y-4">
        {subject === null ? (
          <StateBlock
            variant="empty"
            title="Escolha um jogador ou um grupo"
            detail="À esquerda: busque o jogador pelo nome ou pelo SteamID64, ou digite o nome de um grupo do Oxide."
          />
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border border-border bg-surface px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                {subject.type === 'player' ? (
                  <UserRound aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                ) : (
                  <UsersRound aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                )}
                <span className="truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                  {subject.type === 'group'
                    ? `Grupo ${subject.id}`
                    : (subject.name ?? 'Jogador')}
                </span>
                {subject.type === 'player' && (
                  <span className="font-mono text-2xs text-muted">{subject.id}</span>
                )}
              </div>

              {subject.type === 'player' && (
                <Button size="sm" variant="ghost" onClick={() => onShowAudit(subject.id)}>
                  <History aria-hidden="true" className="h-4 w-4" />
                  Ver registro deste jogador
                </Button>
              )}
            </header>

            {grantsError !== null && (
              <StateBlock variant="error" title="Não consegui ler os acessos" detail={grantsError} />
            )}

            {currentGrants === null ? (
              <StateBlock variant="loading" title="Lendo os acessos…" />
            ) : currentGrants.length === 0 ? (
              grantsError === null && (
                <StateBlock
                  variant="empty"
                  title={
                    subject.type === 'group'
                      ? 'Este grupo não tem acessos'
                      : 'Este jogador não tem acessos individuais'
                  }
                  detail={
                    subject.type === 'player'
                      ? 'Ele ainda pode usar skins pela permissão, por um grupo do Oxide ou por skins para todos.'
                      : undefined
                  }
                />
              )
            ) : (
              <GrantsTable grants={currentGrants} onRemove={(grant) => void removeGrant(grant)} />
            )}

            <GrantForm
              key={subjectKey ?? ''}
              subject={subject}
              skins={skins}
              collections={collections}
              grants={currentGrants ?? []}
              busy={granting}
              error={grantError}
              onSubmit={createGrant}
            />

            <p className="border border-border bg-surface-2 p-3 text-2xs leading-relaxed text-muted">
              Acesso por <strong className="text-foreground">grupo</strong> vale para quem está no
              grupo do Oxide <strong className="text-foreground">naquele servidor</strong> — quem
              confere é o plugin, na hora. Liberar de novo o mesmo alvo{' '}
              <strong className="text-foreground">renova o prazo</strong>, sem duplicar. Remover ou
              deixar vencer impede novas aplicações, mas{' '}
              <strong className="text-foreground">não despinta</strong> o que já foi pintado.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function describeExpiry(grant: WorkshopGrant): string {
  if (grant.expiresAt === null) return 'permanente';

  return grant.expired
    ? `venceu em ${formatDateTime(grant.expiresAt)}`
    : `até ${formatDateTime(grant.expiresAt)}`;
}

// ------------------------------------------------------------
//  QUEM
// ------------------------------------------------------------

interface SubjectPickerProps {
  readonly groups: readonly string[];
  readonly selected: Subject | null;
  readonly onSearch: (query: string) => Promise<PlayerHit[]>;
  readonly onSelect: (subject: Subject) => void;
}

const SEARCH_DEBOUNCE_MS = 350;

function SubjectPicker({ groups, selected, onSearch, onSelect }: SubjectPickerProps) {
  const [mode, setMode] = useState<WorkshopGrantSubjectType>(selected?.type ?? 'player');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{
    key: string;
    hits: PlayerHit[];
    failure: string | null;
  } | null>(null);
  const [groupDraft, setGroupDraft] = useState('');

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed === '') return;

    // `alive` joga fora a busca que chegou depois de o texto mudar.
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hits = await onSearch(trimmed);

          if (alive) setResults({ key: trimmed, hits, failure: null });
        } catch (cause) {
          if (alive) setResults({ key: trimmed, hits: [], failure: messageOf(cause) });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trimmed, onSearch]);

  const current = results !== null && results.key === trimmed ? results : null;
  const searching = trimmed !== '' && current === null;
  const directSteamId =
    STEAM_ID_PATTERN.test(trimmed) &&
    !(current?.hits ?? []).some((hit) => hit.steamId === trimmed)
      ? trimmed
      : null;

  const groupName = groupDraft.trim().toLowerCase();
  const groupValid = OXIDE_GROUP_PATTERN.test(groupName);

  return (
    <aside className="space-y-3 border border-border bg-surface p-3">
      <div role="tablist" aria-label="Quem recebe o acesso" className="flex border border-border">
        {(
          [
            ['player', 'Jogador'],
            ['group', 'Grupo Oxide'],
          ] as const
        ).map(([id, label], index) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={cn(
              'flex-1 px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
              index > 0 && 'border-l border-border',
              mode === id ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'player' ? (
        <div role="tabpanel" className="space-y-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <Input
              value={query}
              placeholder="Nome ou SteamID64"
              aria-label="Buscar jogador"
              className="pl-7"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {trimmed === '' ? (
            <p className="text-2xs text-muted">
              Busque pelo nome (como o agente o viu) ou cole o SteamID64.
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto border border-border">
              {directSteamId !== null && (
                <li>
                  <button
                    type="button"
                    onClick={() => onSelect({ type: 'player', id: directSteamId, name: null })}
                    className="w-full px-2 py-1.5 text-left text-2xs hover:bg-surface-2"
                  >
                    Usar <span className="font-mono text-foreground">{directSteamId}</span>
                    <span className="block text-muted">mesmo sem ele ter entrado na rede</span>
                  </button>
                </li>
              )}

              {searching && (
                <li className="flex items-center gap-1 px-2 py-1.5 text-2xs text-muted">
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  Buscando…
                </li>
              )}

              {current !== null && current.failure !== null && (
                <li className="px-2 py-1.5 text-2xs text-muted">
                  Não consegui buscar: {current.failure}
                </li>
              )}

              {current !== null &&
                current.failure === null &&
                current.hits.length === 0 &&
                directSteamId === null && (
                  <li className="px-2 py-1.5 text-2xs text-muted">Ninguém com esse nome.</li>
                )}

              {current?.hits.map((hit) => {
                const active = selected?.type === 'player' && selected.id === hit.steamId;

                return (
                  <li key={hit.steamId}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        onSelect({ type: 'player', id: hit.steamId, name: hit.name || null })
                      }
                      className={cn(
                        'flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-2',
                        active && 'bg-surface-2',
                      )}
                    >
                      <span
                        aria-label={hit.online ? 'online' : 'offline'}
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          hit.online ? 'bg-olive' : 'border border-muted',
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">
                          {hit.name || '(sem nome)'}
                        </span>
                        <span className="block font-mono text-2xs text-muted">{hit.steamId}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <form
          role="tabpanel"
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (groupValid) onSelect({ type: 'group', id: groupName, name: null });
          }}
        >
          <Input
            value={groupDraft}
            list="workshop-oxide-groups"
            maxLength={64}
            placeholder="vip"
            aria-label="Grupo do Oxide"
            className="font-mono"
            onChange={(event) => setGroupDraft(event.target.value)}
          />
          <datalist id="workshop-oxide-groups">
            {groups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>

          {groupName !== '' && !groupValid && (
            <p className="text-2xs text-amber">
              Grupo do Oxide: letras minúsculas, dígitos, &quot;.&quot;, &quot;-&quot; ou &quot;_&quot;.
            </p>
          )}

          <Button type="submit" size="sm" variant="outline" disabled={!groupValid}>
            Ver acessos do grupo
          </Button>

          {groups.length > 0 && (
            <div className="flex flex-wrap gap-1 border-t border-border pt-2">
              {groups.map((group) => {
                const active = selected?.type === 'group' && selected.id === group;

                return (
                  <button
                    key={group}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setGroupDraft(group);
                      onSelect({ type: 'group', id: group, name: null });
                    }}
                    className={cn(
                      'border px-1.5 py-0.5 font-mono text-2xs',
                      active
                        ? 'border-olive bg-olive/10 text-foreground'
                        : 'border-border text-muted hover:border-muted hover:text-foreground',
                    )}
                  >
                    {group}
                  </button>
                );
              })}
            </div>
          )}

          <p className="text-2xs text-muted">
            {groups.length > 0
              ? 'Grupos lidos do primeiro servidor. Pode digitar outro.'
              : 'Sem a lista de grupos (servidor parado?): digite o nome como está no Oxide.'}
          </p>
        </form>
      )}
    </aside>
  );
}

// ------------------------------------------------------------
//  A LISTA
// ------------------------------------------------------------

function GrantsTable({
  grants,
  onRemove,
}: {
  readonly grants: readonly WorkshopGrant[];
  readonly onRemove: (grant: WorkshopGrant) => void;
}) {
  return (
    <div className="overflow-x-auto border border-border bg-surface">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <HeaderCell>Alvo</HeaderCell>
            <HeaderCell>Tipo</HeaderCell>
            <HeaderCell>Prazo</HeaderCell>
            <HeaderCell>Nota</HeaderCell>
            <HeaderCell>Liberado por</HeaderCell>
            <HeaderCell>
              <span className="sr-only">Ações</span>
            </HeaderCell>
          </tr>
        </thead>

        <tbody className="divide-y divide-border">
          {grants.map((grant) => (
            <tr key={grant.id} className={cn('hover:bg-surface-2', grant.expired && 'opacity-60')}>
              <td className="px-3 py-2">
                <span className="flex items-center gap-2">
                  {grant.targetShortname !== null && (
                    <ItemIcon shortname={grant.targetShortname} size="sm" />
                  )}
                  <span className="text-foreground">{grant.targetLabel}</span>
                </span>
              </td>
              <td className="px-3 py-2 text-2xs text-muted">
                {grant.targetType === 'skin' ? 'skin' : 'coleção'}
              </td>
              <td
                className={cn(
                  'whitespace-nowrap px-3 py-2 text-2xs',
                  grant.expired
                    ? 'text-muted'
                    : grant.expiresAt === null
                      ? 'text-olive'
                      : 'text-foreground',
                )}
              >
                {describeExpiry(grant)}
              </td>
              <td className="px-3 py-2 text-2xs text-muted">{grant.note || '—'}</td>
              <td className="px-3 py-2 text-2xs text-muted" title={formatDateTime(grant.updatedAt)}>
                {grant.createdBy ?? '—'}
              </td>
              <td className="px-3 py-2 text-right">
                <ConfirmButton
                  variant="danger"
                  disabled={false}
                  icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                  label="Remover"
                  confirmLabel="Remover mesmo"
                  hint="Deixa de liberar novas aplicações. O que já foi pintado continua pintado."
                  onConfirm={() => onRemove(grant)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------
//  LIBERAR
// ------------------------------------------------------------

type Duration = 'permanent' | '1' | '7' | '30' | '90' | 'custom';

const DURATIONS: readonly { id: Duration; label: string }[] = [
  { id: 'permanent', label: 'Permanente' },
  { id: '1', label: '1 dia' },
  { id: '7', label: '7 dias' },
  { id: '30', label: '30 dias' },
  { id: '90', label: '90 dias' },
  { id: 'custom', label: 'Até uma data…' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

interface GrantFormProps {
  readonly subject: Subject;
  readonly skins: readonly WorkshopSkin[];
  readonly collections: readonly WorkshopCollection[];
  /** Os acessos que ele já tem — para avisar que é renovação. */
  readonly grants: readonly WorkshopGrant[];
  readonly busy: boolean;
  readonly error: ApiError | null;
  /** `true` = gravou. */
  readonly onSubmit: (input: WorkshopGrantInput, renewing: boolean) => Promise<boolean>;
}

function GrantForm({ subject, skins, collections, grants, busy, error, onSubmit }: GrantFormProps) {
  const [targetType, setTargetType] = useState<WorkshopGrantTargetType>('skin');
  const [targetId, setTargetId] = useState('');
  const [duration, setDuration] = useState<Duration>('permanent');
  const [customDate, setCustomDate] = useState('');
  const [note, setNote] = useState('');

  const skinGroups = useMemo(() => groupByShortname(skins), [skins]);

  const existing =
    targetId === ''
      ? null
      : (grants.find(
          (grant) => grant.targetType === targetType && grant.targetId === Number(targetId),
        ) ?? null);

  const customTime = customDate === '' ? Number.NaN : new Date(customDate).getTime();
  const problem =
    targetId === ''
      ? targetType === 'skin'
        ? 'Escolha a skin.'
        : 'Escolha a coleção.'
      : duration === 'custom' && Number.isNaN(customTime)
        ? 'Escolha a data de vencimento.'
        : duration === 'custom' && customTime <= Date.now()
          ? 'A data escolhida já passou.'
          : null;

  function expiresAt(): string | null {
    if (duration === 'permanent') return null;
    if (duration === 'custom') return new Date(customTime).toISOString();

    return new Date(Date.now() + Number(duration) * DAY_MS).toISOString();
  }

  async function submit(): Promise<void> {
    const saved = await onSubmit(
      {
        subjectType: subject.type,
        subject: subject.id,
        targetType,
        targetId: Number(targetId),
        expiresAt: expiresAt(),
        note: note.trim(),
      },
      existing !== null,
    );

    if (saved) {
      setTargetId('');
      setNote('');
    }
  }

  return (
    <section className="space-y-3 border border-border bg-surface p-3">
      <h4 className="font-condensed text-sm font-bold uppercase tracking-wide">Liberar</h4>

      <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)]">
        <div>
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Tipo</span>
          <div role="group" aria-label="Tipo do alvo" className="mt-1 flex border border-border">
            {(
              [
                ['skin', 'Skin'],
                ['collection', 'Coleção'],
              ] as const
            ).map(([id, label], index) => (
              <button
                key={id}
                type="button"
                aria-pressed={targetType === id}
                onClick={() => {
                  setTargetType(id);
                  setTargetId('');
                }}
                className={cn(
                  'h-[2.125rem] px-3 font-condensed text-2xs font-bold uppercase tracking-wide',
                  index > 0 && 'border-l border-border',
                  targetType === id
                    ? 'bg-surface-2 text-foreground'
                    : 'text-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="block min-w-0">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Alvo</span>
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            className="mt-1 h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground hover:border-muted"
          >
            <option value="">
              {targetType === 'skin' ? 'escolha a skin…' : 'escolha a coleção…'}
            </option>
            {targetType === 'skin'
              ? skinGroups.map((group) => (
                  <optgroup key={group.shortname} label={group.shortname}>
                    {group.skins.map((skin) => (
                      <option key={skin.id} value={String(skin.id)}>
                        {skin.label}
                        {skin.openToAll ? ' (já é para todos)' : ''}
                        {skin.enabled ? '' : ' (desligada)'}
                      </option>
                    ))}
                  </optgroup>
                ))
              : collections.map((collection) => (
                  <option key={collection.id} value={String(collection.id)}>
                    /skin {collection.slug} — {collection.label}
                    {collection.openToAll ? ' (já é para todos)' : ''}
                    {collection.enabled ? '' : ' (desligada)'}
                  </option>
                ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Duração</span>
          <select
            value={duration}
            onChange={(event) => setDuration(event.target.value as Duration)}
            className="mt-1 h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground hover:border-muted"
          >
            {DURATIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {duration === 'custom' ? (
          <label className="block">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Vence em (hora local)
            </span>
            <Input
              type="datetime-local"
              value={customDate}
              className="mt-1 h-9"
              onChange={(event) => setCustomDate(event.target.value)}
            />
          </label>
        ) : (
          <label className="block">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Nota (opcional)
            </span>
            <Input
              value={note}
              maxLength={200}
              placeholder="vencedor do evento de sábado"
              className="mt-1 h-9"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        )}
      </div>

      {duration === 'custom' && (
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Nota (opcional)
          </span>
          <Input
            value={note}
            maxLength={200}
            placeholder="vencedor do evento de sábado"
            className="mt-1 h-9"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      )}

      {existing !== null && (
        <p className="border-l-2 border-amber pl-2 text-2xs leading-relaxed text-amber">
          {subject.type === 'group' ? 'Este grupo' : 'Este jogador'} já tem acesso a este alvo (
          {describeExpiry(existing)}). Liberar de novo <strong>renova</strong> o prazo para o
          escolhido acima.
        </p>
      )}

      {error !== null && (
        <div role="alert" className="border border-rust bg-surface-2 p-3">
          <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
            {error.code === '' ? 'Não consegui liberar' : `O agente recusou (${error.code})`}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-foreground">{error.message}</p>
          {error.code === 'GRANT_ALREADY_EXPIRED' && (
            <p className="mt-2 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-muted">
              Escolha uma data no futuro, ou &quot;Permanente&quot;.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-2xs text-muted">{problem}</p>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || problem !== null}
          onClick={() => void submit()}
        >
          {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          {existing !== null ? 'Renovar' : 'Liberar'}
        </Button>
      </div>
    </section>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
    >
      {children}
    </th>
  );
}
