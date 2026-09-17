'use client';

// ============================================================
//  owned-panel.tsx  -  a aba Posse: quem tem qual skin.
//
//  ####  A SKIN É POSSE DO JOGADOR  ####
//
//  Docs/OrigemZWorkshop/02 §3. Uma skin é liberada por QUALQUER um
//  destes: "liberada para todos" (skin da casa), uma posse VIVA do
//  jogador (sem prazo, ou prazo no futuro), ou
//  `origemzworkshop.admin`. Permissão do Oxide, grupo e VIP deixaram
//  de liberar skin — por isso o seletor de grupo saiu daqui.
//
//  ####  DUAS PERGUNTAS, DUAS BUSCAS  ####
//
//    Por jogador   "o Fulano tem a AK do evento?" — lista o que ele
//                  tem, e dá várias skins de uma vez.
//    Por skin      "quem tem a AK Brasa?" — lista os donos, e dá a
//                  mesma skin a vários SteamIDs de uma vez (o prêmio
//                  de evento).
//
//  As duas removem em lote. Dar de novo a quem já tem SOMA ao prazo
//  (ou mantém o permanente), e tirar — ou deixar vencer — NÃO
//  despinta o que já foi pintado.
//
//  ####  O QUE O AGENTE MANDA, A TELA NÃO CONFERE  ####
//
//  Toda resposta passa pelo `safeX` (normalize.ts): campo ausente
//  vira TypeError no render e derruba a página.
// ============================================================

import { History, Loader2, Package, Search, Trash2, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import {
  describeOwnedExpiry,
  formatDateTime,
  messageOf,
  OWNED_SOURCE_LABELS,
  safeOwned,
  safeOwnedList,
  safeSkin,
  STEAM_ID_PATTERN,
} from '@/components/workshop/normalize';
import {
  expiryBody,
  ExpiryPicker,
  NoteField,
  OwnedErrorBox,
  OwnedSkinCell,
  PERMANENT,
  RarityBadge,
  runBatch,
  searchPlayers,
  SkinCatalogPicker,
  type BatchOutcome,
  type ExpiryValue,
  type PlayerHit,
} from '@/components/workshop/owned-parts';
import { agent, ApiError, type WorkshopOwned, type WorkshopSkin } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface OwnedPanelProps {
  /** Abre a aba Registro filtrada por este jogador. */
  readonly onShowAudit: (steamId: string) => void;
}

/** O que está escolhido à esquerda. */
type Subject =
  | { readonly type: 'player'; readonly steamId: string; readonly name: string | null }
  | { readonly type: 'skin'; readonly skinId: number };

const PAGE_SIZE = 100;
/** O teto de um lote colado: acima disso, é exportação, não prêmio. */
const MAX_BATCH = 200;

function keyOf(subject: Subject): string {
  return subject.type === 'player' ? `player:${subject.steamId}` : `skin:${String(subject.skinId)}`;
}

export function OwnedPanel({ onShowAudit }: OwnedPanelProps) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [subject, setSubject] = useState<Subject | null>(null);

  // O catálogo alimenta a busca por skin e o "Dar". Falhar aqui não
  // impede ver e tirar posse de um jogador.
  const loadCatalog = useCallback(async () => {
    try {
      const response = await agent.workshopSkins();

      setSkins((Array.isArray(response.skins) ? response.skins : []).map(safeSkin));
      setCatalogError(null);
    } catch (cause) {
      setCatalogError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const skinById = useMemo(() => new Map(skins.map((skin) => [skin.id, skin])), [skins]);
  const chosenSkin = subject?.type === 'skin' ? (skinById.get(subject.skinId) ?? null) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <SubjectPicker skins={skins} selected={subject} onSelect={setSubject} />

      <div className="min-w-0 space-y-4">
        {catalogError !== null && (
          <StateBlock
            variant="error"
            title="Não consegui ler o catálogo de skins"
            detail={`${catalogError}. Dá para ver e tirar posse, mas não para dar.`}
          />
        )}

        {subject === null ? (
          <StateBlock
            variant="empty"
            title="Escolha um jogador ou uma skin"
            detail="À esquerda: busque o jogador pelo nome ou pelo SteamID64 para ver o que ele tem, ou escolha uma skin para ver quem a tem."
          />
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border border-border bg-surface px-3 py-2">
              {subject.type === 'player' ? (
                <div className="flex min-w-0 items-center gap-2">
                  <UserRound aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                  <Link
                    href={`/jogador/?id=${encodeURIComponent(subject.steamId)}`}
                    className="truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground hover:underline"
                  >
                    {subject.name ?? 'Jogador'}
                  </Link>
                  <span className="font-mono text-2xs text-muted">{subject.steamId}</span>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <Package aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                  <span className="truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                    {chosenSkin?.label ?? `skin #${String(subject.skinId)}`}
                  </span>
                  {chosenSkin !== null && (
                    <>
                      <span className="font-mono text-2xs text-muted">{chosenSkin.shortname}</span>
                      <RarityBadge rarity={chosenSkin.rarity} />
                      {chosenSkin.openToAll && (
                        <span className="text-2xs text-amber">
                          liberada para todos — a posse não muda nada no jogo
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              {subject.type === 'player' && (
                <Button size="sm" variant="ghost" onClick={() => onShowAudit(subject.steamId)}>
                  <History aria-hidden="true" className="h-4 w-4" />
                  Ver registro deste jogador
                </Button>
              )}
            </header>

            <OwnedSection
              key={keyOf(subject)}
              subject={subject}
              skins={skins}
              onChanged={() => void loadCatalog()}
            />

            <p className="border border-border bg-surface-2 p-3 text-2xs leading-relaxed text-muted">
              Dar de novo a quem já tem <strong className="text-foreground">soma ao prazo</strong>{' '}
              (ou mantém o permanente), sem duplicar. Tirar ou deixar vencer impede novas
              aplicações, mas <strong className="text-foreground">não despinta</strong> o que já foi
              pintado. Quem está online recebe a posse nova na hora.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
//  QUEM (OU O QUÊ)
// ------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 350;

function SubjectPicker({
  skins,
  selected,
  onSelect,
}: {
  readonly skins: readonly WorkshopSkin[];
  readonly selected: Subject | null;
  readonly onSelect: (subject: Subject) => void;
}) {
  const [mode, setMode] = useState<Subject['type']>(selected?.type ?? 'player');

  return (
    <aside className="space-y-3 border border-border bg-surface p-3">
      <div role="tablist" aria-label="Buscar posse por" className="flex border border-border">
        {(
          [
            ['player', 'Por jogador'],
            ['skin', 'Por skin'],
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
        <PlayerSearch
          selected={selected?.type === 'player' ? selected.steamId : null}
          onSelect={(hit) => onSelect({ type: 'player', steamId: hit.steamId, name: hit.name || null })}
        />
      ) : (
        <div role="tabpanel">
          <SkinCatalogPicker
            skins={skins}
            multiple={false}
            selected={selected?.type === 'skin' ? [selected.skinId] : []}
            onChange={(ids) => {
              const id = ids[0];

              if (id !== undefined) onSelect({ type: 'skin', skinId: id });
            }}
          />
        </div>
      )}
    </aside>
  );
}

function PlayerSearch({
  selected,
  onSelect,
}: {
  readonly selected: string | null;
  readonly onSelect: (hit: PlayerHit) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{
    key: string;
    hits: PlayerHit[];
    failure: string | null;
  } | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed === '') return;

    // `alive` joga fora a busca que chegou depois de o texto mudar.
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hits = await searchPlayers(trimmed);

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
  }, [trimmed]);

  const current = results !== null && results.key === trimmed ? results : null;
  const searching = trimmed !== '' && current === null;
  const directSteamId =
    STEAM_ID_PATTERN.test(trimmed) && !(current?.hits ?? []).some((hit) => hit.steamId === trimmed)
      ? trimmed
      : null;

  return (
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
        <p className="text-2xs text-muted">Busque pelo nome (como o agente o viu) ou cole o SteamID64.</p>
      ) : (
        <ul className="max-h-96 divide-y divide-border overflow-y-auto border border-border">
          {directSteamId !== null && (
            <li>
              <button
                type="button"
                onClick={() => onSelect({ steamId: directSteamId, name: '', online: false })}
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
            <li className="px-2 py-1.5 text-2xs text-muted">Não consegui buscar: {current.failure}</li>
          )}

          {current !== null &&
            current.failure === null &&
            current.hits.length === 0 &&
            directSteamId === null && (
              <li className="px-2 py-1.5 text-2xs text-muted">Ninguém com esse nome.</li>
            )}

          {current?.hits.map((hit) => {
            const active = selected === hit.steamId;

            return (
              <li key={hit.steamId}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(hit)}
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
  );
}

// ------------------------------------------------------------
//  A LISTA E O "DAR"
// ------------------------------------------------------------

/** O resultado do último lote, para quem apertou ler com calma. */
function BatchReport({ outcome, verb }: { readonly outcome: BatchOutcome; readonly verb: string }) {
  return (
    <div
      role="status"
      className={cn(
        'border bg-surface-2 p-3 text-2xs leading-relaxed',
        outcome.failures.length > 0 ? 'border-amber' : 'border-olive',
      )}
    >
      <p className="font-condensed font-bold uppercase tracking-wide text-foreground">
        {outcome.done} {verb}
        {outcome.failures.length > 0 ? ` · ${String(outcome.failures.length)} falharam` : ''}
      </p>
      {outcome.failures.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-muted">
          {outcome.failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OwnedSection({
  subject,
  skins,
  onChanged,
}: {
  readonly subject: Subject;
  readonly skins: readonly WorkshopSkin[];
  /** A contagem de donos do catálogo mudou. */
  readonly onChanged: () => void;
}) {
  const [includeExpired, setIncludeExpired] = useState(true);
  const [rows, setRows] = useState<WorkshopOwned[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ outcome: BatchOutcome; verb: string } | null>(null);

  const fetchPage = useCallback(
    async (cursor?: number) => {
      const response = await agent.workshopOwned({
        ...(subject.type === 'player' ? { steamId: subject.steamId } : { skinId: subject.skinId }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: PAGE_SIZE,
        includeExpired,
      });

      return {
        list: safeOwnedList(response.owned),
        next: typeof response.nextCursor === 'number' ? response.nextCursor : null,
      };
    },
    [subject, includeExpired],
  );

  const reload = useCallback(async () => {
    try {
      const { list, next } = await fetchPage();

      setRows(list);
      setNextCursor(next);
      setError(null);
      setChecked(new Set());
    } catch (cause) {
      setRows((current) => current ?? []);
      setError(messageOf(cause));
    }
  }, [fetchPage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || rows === null) return;

    setLoadingMore(true);

    try {
      const { list, next } = await fetchPage(nextCursor);

      setRows([...rows, ...list]);
      setNextCursor(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  async function revoke(targets: readonly WorkshopOwned[]): Promise<void> {
    setBusy(true);
    setReport(null);

    const outcome = await runBatch(
      targets,
      (owned) => (subject.type === 'player' ? (owned.skin?.label ?? `skin #${String(owned.skinId)}`) : owned.steamId),
      (owned) => agent.revokeWorkshopOwned(owned.id),
    );

    if (targets.length === 1 && outcome.failures.length === 0) {
      toast.success('Posse tirada', { description: 'O que já foi pintado continua pintado.' });
    } else {
      setReport({ outcome, verb: outcome.done === 1 ? 'posse tirada' : 'posses tiradas' });
    }

    setBusy(false);
    await reload();
    onChanged();
  }

  const live = useMemo(
    () => new Set((rows ?? []).filter((row) => !row.expired).map((row) => row.skinId)),
    [rows],
  );
  const selectedRows = (rows ?? []).filter((row) => checked.has(row.id));
  const allChecked = rows !== null && rows.length > 0 && rows.every((row) => checked.has(row.id));

  return (
    <div className="space-y-4">
      <section className="border border-border bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
          <h4 className="font-condensed text-sm font-bold uppercase tracking-wide">
            {subject.type === 'player' ? 'O que ele tem' : 'Quem tem'}
          </h4>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              <input
                type="checkbox"
                checked={includeExpired}
                onChange={(event) => setIncludeExpired(event.target.checked)}
              />
              mostrar vencidas
            </label>

            <ConfirmButton
              variant="danger"
              disabled={busy || selectedRows.length === 0}
              icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
              label={`Tirar selecionadas (${String(selectedRows.length)})`}
              confirmLabel="Tirar mesmo"
              hint="Deixam de liberar novas aplicações. O que já foi pintado continua pintado."
              onConfirm={() => void revoke(selectedRows)}
            />
          </div>
        </header>

        {error !== null && (
          <div className="p-3">
            <StateBlock variant="error" title="Não consegui ler a posse" detail={error} />
          </div>
        )}

        {rows === null ? (
          <div className="p-3">
            <StateBlock variant="loading" title="Lendo a posse…" />
          </div>
        ) : rows.length === 0 ? (
          error === null && (
            <p className="px-3 py-3 text-sm text-muted">
              {subject.type === 'player'
                ? 'Este jogador não tem skin nenhuma. Ele ainda aplica as liberadas para todos.'
                : 'Ninguém tem esta skin.'}
            </p>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todas"
                      checked={allChecked}
                      onChange={() =>
                        setChecked(allChecked ? new Set() : new Set(rows.map((row) => row.id)))
                      }
                    />
                  </HeaderCell>
                  <HeaderCell>{subject.type === 'player' ? 'Skin' : 'Jogador'}</HeaderCell>
                  <HeaderCell>Prazo</HeaderCell>
                  <HeaderCell>Origem</HeaderCell>
                  <HeaderCell>Nota</HeaderCell>
                  <HeaderCell>Dada por</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {rows.map((owned) => (
                  <tr key={owned.id} className={cn('hover:bg-surface-2', owned.expired && 'opacity-60')}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Selecionar"
                        checked={checked.has(owned.id)}
                        onChange={() => {
                          const next = new Set(checked);

                          if (next.has(owned.id)) next.delete(owned.id);
                          else next.add(owned.id);

                          setChecked(next);
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {subject.type === 'player' ? (
                        <OwnedSkinCell owned={owned} />
                      ) : (
                        <Link
                          href={`/jogador/?id=${encodeURIComponent(owned.steamId)}`}
                          className="font-mono text-2xs text-foreground underline decoration-dotted underline-offset-2"
                        >
                          {owned.steamId}
                        </Link>
                      )}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-3 py-2 text-2xs',
                        owned.expired
                          ? 'text-muted'
                          : owned.expiresAt === null
                            ? 'text-olive'
                            : 'text-foreground',
                      )}
                    >
                      {describeOwnedExpiry(owned)}
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted" title={owned.sourceRef ?? undefined}>
                      {OWNED_SOURCE_LABELS[owned.source]}
                    </td>
                    <td className="px-3 py-2 text-2xs text-muted">{owned.note ?? '—'}</td>
                    <td
                      className="px-3 py-2 text-2xs text-muted"
                      title={owned.updatedAt === '' ? undefined : formatDateTime(owned.updatedAt)}
                    >
                      {owned.createdBy || '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ConfirmButton
                        variant="danger"
                        disabled={busy}
                        icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                        label="Tirar"
                        confirmLabel="Tirar mesmo"
                        hint="Deixa de liberar novas aplicações. O que já foi pintado continua pintado."
                        onConfirm={() => void revoke([owned])}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor !== null && (
          <div className="border-t border-border px-3 py-2 text-right">
            <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
              Carregar mais
            </Button>
          </div>
        )}
      </section>

      {report !== null && <BatchReport outcome={report.outcome} verb={report.verb} />}

      <GrantSection
        subject={subject}
        skins={skins}
        liveSkinIds={subject.type === 'player' ? live : undefined}
        onGranted={async (outcome) => {
          setReport({
            outcome,
            verb: outcome.done === 1 ? 'posse dada ou renovada' : 'posses dadas ou renovadas',
          });
          await reload();
          onChanged();
        }}
      />
    </div>
  );
}

/** Tira SteamIDs de um texto colado: um por linha, vírgula ou espaço. */
function parseSteamIds(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
  const valid = [...new Set(tokens.filter((token) => STEAM_ID_PATTERN.test(token)))];
  const invalid = [...new Set(tokens.filter((token) => !STEAM_ID_PATTERN.test(token)))];

  return { valid, invalid };
}

function GrantSection({
  subject,
  skins,
  liveSkinIds,
  onGranted,
}: {
  readonly subject: Subject;
  readonly skins: readonly WorkshopSkin[];
  readonly liveSkinIds: ReadonlySet<number> | undefined;
  readonly onGranted: (outcome: BatchOutcome) => Promise<void>;
}) {
  const [skinIds, setSkinIds] = useState<number[]>([]);
  const [steamIdsRaw, setSteamIdsRaw] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>(PERMANENT);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const steamIds = parseSteamIds(steamIdsRaw);
  const { problem: expiryProblem, body } = expiryBody(expiry);
  const count = subject.type === 'player' ? skinIds.length : steamIds.valid.length;

  const problem =
    subject.type === 'player' && skinIds.length === 0
      ? 'Escolha uma ou mais skins.'
      : subject.type === 'skin' && steamIds.valid.length === 0
        ? 'Cole um ou mais SteamID64.'
        : subject.type === 'skin' && steamIds.invalid.length > 0
          ? `Não são SteamID64: ${steamIds.invalid.slice(0, 3).join(', ')}${steamIds.invalid.length > 3 ? '…' : ''}`
          : count > MAX_BATCH
            ? `No máximo ${String(MAX_BATCH)} por vez.`
            : expiryProblem;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const trimmedNote = note.trim();
    const common = { ...body, ...(trimmedNote === '' ? {} : { note: trimmedNote }) };

    try {
      if (count === 1) {
        // Um só: a recusa fica no formulário, com a saída escrita.
        const response =
          subject.type === 'player'
            ? await agent.grantWorkshopOwned({ steamId: subject.steamId, skinId: skinIds[0] ?? 0, ...common })
            : await agent.grantWorkshopOwned({
                steamId: steamIds.valid[0] ?? '',
                skinId: subject.skinId,
                ...common,
              });
        const owned = response.owned === undefined ? null : safeOwned(response.owned);

        toast.success(response.created === false ? 'Prazo renovado' : 'Skin dada', {
          ...(owned === null ? {} : { description: describeOwnedExpiry(owned) }),
        });
        await onGranted({ done: 1, failures: [] });
      } else {
        const outcome =
          subject.type === 'player'
            ? await runBatch(
                skinIds,
                (id) => skins.find((skin) => skin.id === id)?.label ?? `skin #${String(id)}`,
                (id) => agent.grantWorkshopOwned({ steamId: subject.steamId, skinId: id, ...common }),
              )
            : await runBatch(
                steamIds.valid,
                (steamId) => steamId,
                (steamId) => agent.grantWorkshopOwned({ steamId, skinId: subject.skinId, ...common }),
              );

        await onGranted(outcome);
      }

      setSkinIds([]);
      setSteamIdsRaw('');
      setNote('');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError('', messageOf(cause), 0));
    } finally {
      setBusy(false);
    }
  }

  const renewing =
    liveSkinIds !== undefined && skinIds.some((id) => liveSkinIds.has(id));

  return (
    <section className="space-y-3 border border-border bg-surface p-3">
      <h4 className="font-condensed text-sm font-bold uppercase tracking-wide">
        {subject.type === 'player' ? 'Dar skins' : 'Dar esta skin a vários jogadores'}
      </h4>

      {subject.type === 'player' ? (
        <SkinCatalogPicker
          skins={skins}
          multiple
          selected={skinIds}
          onChange={setSkinIds}
          {...(liveSkinIds === undefined ? {} : { ownedIds: liveSkinIds })}
        />
      ) : (
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            SteamID64 — um por linha
          </span>
          <textarea
            value={steamIdsRaw}
            rows={5}
            placeholder={'76561198000000001\n76561198000000002'}
            className="mt-1 w-full border border-border bg-surface-2 px-2 py-1.5 font-mono text-2xs text-foreground hover:border-muted"
            onChange={(event) => setSteamIdsRaw(event.target.value)}
          />
          <span className="mt-1 block text-2xs text-muted">
            {steamIds.valid.length === 0
              ? 'Serve para o prêmio de evento: cole a lista inteira.'
              : `${String(steamIds.valid.length)} jogador(es) válido(s).`}
          </span>
        </label>
      )}

      <ExpiryPicker value={expiry} onChange={setExpiry} />
      <NoteField value={note} onChange={setNote} />

      {renewing && (
        <p className="border-l-2 border-amber pl-2 text-2xs leading-relaxed text-amber">
          Ele já tem ao menos uma das escolhidas. Dar de novo <strong>soma</strong> o prazo escolhido
          ao que sobra — ou mantém o permanente.
        </p>
      )}

      <OwnedErrorBox error={error} title="Não consegui dar a skin" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-2xs text-muted">{problem}</p>
        <Button size="sm" variant="primary" disabled={busy || problem !== null} onClick={() => void submit()}>
          {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          {count > 1 ? `Dar (${String(count)})` : 'Dar'}
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
