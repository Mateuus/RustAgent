'use client';

// ============================================================
//  player-skins.tsx  -  a aba Skins da ficha do jogador.
//
//  Docs/OrigemZWorkshop/02 §9. No molde da aba VIP: o que ele tem
//  AGORA, o formulário de dar, e o que já aconteceu.
//
//  ####  DUAS SUB-ABAS: SKINS E HISTÓRICO  ####
//
//  Empilhadas, a lista, as vencidas, o formulário e o Registro
//  passavam de uma tela, e o que se procura quase sempre é a lista.
//  A sub-aba ativa fica só no estado local: não vai para a URL.
//
//  ####  DAR SKIN ABRE NUM MODAL  ####
//
//  O mesmo `Dialog` do cadastro de skins (skins-panel.tsx): ~720 px,
//  tela cheia no celular, Esc e X fecham. É `guarded` porque o prazo
//  é um `<select>` nativo — ver dialog.tsx. Fechar desmonta o
//  formulário, então a próxima abertura nasce limpa.
//
//  ####  VIVA E VENCIDA, SEPARADAS — HOJE POR ABAS  ####
//
//  "Ele tem a AK?" se responde pela lista viva. A vencida é a resposta
//  de "eu tinha e sumiu", e misturá-las faria uma posse vencida parecer
//  valendo.
//
//  Com 48 posses a lista única virou rolagem sem fim, então o bloco "O
//  que ele tem" ganhou abas: **Todas**, **Favoritas** e **Vencidas** (as
//  duas últimas só aparecem quando há alguma). É o mesmo desenho das
//  sub-abas Skins|Histórico daqui. A aba ativa fica só no estado local.
//
//  **Nada de "Por item".** Foi considerado e recusado: agrupar quebraria
//  a paginação (uma página cortaria um grupo no meio) e o item já está em
//  toda linha, em monoespaçado, e a busca procura por ele. O que 48
//  linhas pedem é filtro, e é o que as abas e a busca dão.
//
//  ####  PÁGINAS NO NAVEGADOR  ####
//
//  A rota da ficha devolve tudo dele de uma vez (vivas e vencidas), e
//  quem pagina é a aba ativa. A página é uma só: trocar de aba, buscar
//  ou mudar o tamanho volta para a 1 — guardar uma página por aba faria
//  a de trás voltar num lugar que ninguém deixou.
//
//  ####  AS FAVORITAS SÃO SÓ LEITURA  ####
//
//  A estrela âmbar de uma linha diz que o JOGADOR marcou aquela skin
//  como favorita no menu do jogo (`origemz.skins.fav`, 03 §5). O painel
//  **não** marca nem desmarca: não há rota para isso, de propósito — a
//  favorita é o atalho dele, e não uma configuração de admin. Por isso
//  a estrela não é botão, e o tooltip diz de quem é a marca.
//
//  A rota pode não mandar o campo (agente velho): `safeFavoriteIds`
//  devolve conjunto vazio e nenhuma estrela aparece.
//
//  ####  MORA AQUI, E NÃO NA PÁGINA DA FICHA  ####
//
//  Ela usa as peças da aba Posse (owned-parts.tsx) e o Registro do
//  /workshop; a página da ficha já passa de mil linhas e só a monta.
//
//  Toda resposta passa pelo `safeX` (normalize.ts): campo ausente
//  vira TypeError no render e derruba a página.
// ============================================================

import { Loader2, Plus, Search, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { clampPage, Pagination, PAGE_SIZES, slicePage } from '@/components/ui/pagination';
import { AuditPanel } from '@/components/workshop/audit-panel';
import {
  describeOwnedExpiry,
  messageOf,
  OWNED_SOURCE_LABELS,
  ownedMatches,
  safeFavoriteIds,
  safeOwned,
  safeOwnedList,
  safeSkin,
} from '@/components/workshop/normalize';
import {
  expiryBody,
  ExpiryPicker,
  NoteField,
  OwnedErrorBox,
  PERMANENT,
  RarityBadge,
  SkinCatalogPicker,
  SkinThumb,
  type ExpiryValue,
} from '@/components/workshop/owned-parts';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import { agent, ApiError, type WorkshopOwned, type WorkshopSkin } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface PlayerSkinsProps {
  readonly steamId: string;
  /** Para o Registro dar nome ao servidor. */
  readonly servers: readonly WorkshopServerOption[];
}

type View = 'skins' | 'history';

const VIEWS: readonly { id: View; label: string }[] = [
  { id: 'skins', label: 'Skins' },
  { id: 'history', label: 'Histórico' },
];

/** As três listas do bloco "O que ele tem", uma por aba. */
type ListTab = 'all' | 'favorites' | 'expired';

/** A partir de quantas posses a lista ganha a busca. */
const SEARCH_THRESHOLD = 8;

export function PlayerSkins({ steamId, servers }: PlayerSkinsProps) {
  const [view, setView] = useState<View>('skins');
  const [live, setLive] = useState<WorkshopOwned[] | null>(null);
  const [expired, setExpired] = useState<WorkshopOwned[]>([]);
  /** Ids de skin que ele favoritou no jogo. Só leitura (ver o topo). */
  const [favorites, setFavorites] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [list, setList] = useState<ListTab>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [giving, setGiving] = useState(false);
  /** O modal está com uma requisição no ar: fechar fica travado. */
  const [givingBusy, setGivingBusy] = useState(false);
  const [query, setQuery] = useState('');
  /** Uma página só: trocar de aba, buscar ou mudar o tamanho volta à 1. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0] ?? 20);

  const load = useCallback(async () => {
    try {
      const response = await agent.playerSkins(steamId);

      setLive(safeOwnedList(response.live));
      setExpired(safeOwnedList(response.expired));
      setFavorites(safeFavoriteIds(response.favorites));
      setError(null);
    } catch (cause) {
      setLive((current) => current ?? []);
      setError(messageOf(cause));
    }
  }, [steamId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(owned: WorkshopOwned): Promise<void> {
    setBusy(true);

    try {
      await agent.revokeWorkshopOwned(owned.id);
      toast.success('Skin tirada', {
        description: `${owned.skin?.label ?? `skin #${String(owned.skinId)}`}. O que já foi pintado continua pintado.`,
      });
      await load();
    } catch (cause) {
      toast.error('Não consegui tirar', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  const liveIds = useMemo(() => new Set((live ?? []).map((owned) => owned.skinId)), [live]);
  const total = (live?.length ?? 0) + expired.length;
  const searchable = total > SEARCH_THRESHOLD;
  // Com a busca escondida, um filtro digitado antes não pode sumir
  // com linhas sem que se veja por quê.
  const needle = searchable ? query : '';
  const filtering = needle.trim() !== '';
  const shownLive = useMemo(
    () => (live ?? []).filter((owned) => ownedMatches(owned, needle)),
    [live, needle],
  );
  const shownExpired = useMemo(
    () => expired.filter((owned) => ownedMatches(owned, needle)),
    [expired, needle],
  );
  const shownFavorites = useMemo(
    () => shownLive.filter((owned) => favorites.has(owned.skinId)),
    [shownLive, favorites],
  );
  // Quantas das posses VIVAS ele favoritou, sem contar a busca: é o que
  // decide se a aba Favoritas existe. A conta é desta lista, e não do
  // conjunto todo — favoritar não exige ter (02 §5.4), e uma aba que
  // prometesse 3 e mostrasse 1 pareceria erro de tela.
  const favoriteLive = useMemo(
    () => (live ?? []).filter((owned) => favorites.has(owned.skinId)).length,
    [live, favorites],
  );

  // As contagens do rótulo acompanham a busca: com um filtro digitado, é
  // ela que diz em qual aba o que se procura está.
  const tabs = useMemo(() => {
    const result: { id: ListTab; label: string; count: number }[] = [
      { id: 'all', label: 'Todas', count: shownLive.length },
    ];

    if (favoriteLive > 0) {
      result.push({ id: 'favorites', label: 'Favoritas', count: shownFavorites.length });
    }

    if (expired.length > 0) {
      result.push({ id: 'expired', label: 'Vencidas', count: shownExpired.length });
    }

    return result;
  }, [shownLive.length, favoriteLive, shownFavorites.length, expired.length, shownExpired.length]);

  // A aba pode sumir debaixo do pé: tirar a última favorita apaga a
  // Favoritas, e quem estava nela cai em Todas em vez de ficar numa aba
  // que não existe mais.
  const active: ListTab = tabs.some((tab) => tab.id === list) ? list : 'all';
  const rows =
    active === 'favorites' ? shownFavorites : active === 'expired' ? shownExpired : shownLive;

  // Tirar uma skin pode deixar a página guardada além do fim.
  const current = clampPage(page, rows.length, pageSize);
  const pageRows = useMemo(() => slicePage(rows, current, pageSize), [rows, current, pageSize]);

  function changeList(id: ListTab): void {
    setList(id);
    setPage(1);
  }

  function changePageSize(size: number): void {
    setPageSize(size);
    setPage(1);
  }

  /** O que dizer quando a aba ativa não tem linha nenhuma. */
  function emptyMessage(): string {
    if (active === 'favorites') {
      return filtering
        ? 'Nenhuma favorita dele bate com a busca.'
        : 'Nenhuma das skins que ele tem está favoritada.';
    }

    if (active === 'expired') {
      return filtering ? 'Nenhuma vencida bate com a busca.' : 'Nada aqui.';
    }

    return filtering
      ? 'Nenhuma skin dele bate com a busca.'
      : 'Nenhuma skin valendo agora. Veja as Vencidas.';
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Seções das skins do jogador"
        className="inline-flex items-stretch border border-border bg-surface"
      >
        {VIEWS.map((item, index) => (
          <div key={item.id} role="presentation" className="flex items-stretch">
            {index > 0 && <span aria-hidden className="my-1 w-px bg-border" />}

            <button
              type="button"
              role="tab"
              id={`player-skins-tab-${item.id}`}
              aria-selected={view === item.id}
              aria-controls={`player-skins-panel-${item.id}`}
              onClick={() => setView(item.id)}
              className={cn(
                'px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                view === item.id ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>

      {view === 'skins' && (
        <div
          role="tabpanel"
          id="player-skins-panel-skins"
          aria-labelledby="player-skins-tab-skins"
          className="space-y-4"
        >
          {error !== null && (
            <StateBlock variant="error" title="Não consegui ler as skins deste jogador" detail={error} />
          )}

          <Block
            title="O que ele tem"
            count={live === null ? null : live.length}
            aside={
              <Button size="sm" onClick={() => setGiving(true)}>
                <Plus aria-hidden="true" className="h-4 w-4" />
                Adicionar skin
              </Button>
            }
          >
            {live !== null && live.length + expired.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                <div
                  role="tablist"
                  aria-label="Listas das skins do jogador"
                  className="inline-flex items-stretch border border-border bg-surface"
                >
                  {tabs.map((tab, index) => (
                    <div key={tab.id} role="presentation" className="flex items-stretch">
                      {index > 0 && <span aria-hidden className="my-1 w-px bg-border" />}

                      <button
                        type="button"
                        role="tab"
                        id={`player-skins-list-tab-${tab.id}`}
                        aria-selected={active === tab.id}
                        aria-controls="player-skins-list-panel"
                        title={
                          tab.id === 'favorites'
                            ? 'As skins que o jogador favoritou no menu do jogo. Quem marca é ele; o painel não mexe nisso.'
                            : undefined
                        }
                        onClick={() => changeList(tab.id)}
                        className={cn(
                          'flex items-center gap-1.5 px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                          active === tab.id
                            ? 'bg-surface-2 text-foreground'
                            : 'text-muted hover:text-foreground',
                        )}
                      >
                        {tab.id === 'favorites' && (
                          <Star
                            aria-hidden="true"
                            className={cn('h-3 w-3', active === tab.id && 'fill-amber text-amber')}
                          />
                        )}
                        {tab.label}
                        <span className="font-mono text-2xs font-normal opacity-70">
                          ({tab.count})
                        </span>
                      </button>
                    </div>
                  ))}
                </div>

                {searchable && (
                  <div className="relative min-w-0 flex-1 basis-56 sm:max-w-sm">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
                    />
                    <Input
                      value={query}
                      placeholder="Buscar por nome, item ou Workshop ID"
                      aria-label="Buscar nas skins do jogador"
                      className="h-8 pl-7"
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setPage(1);
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            <div
              role="tabpanel"
              id="player-skins-list-panel"
              aria-labelledby={`player-skins-list-tab-${active}`}
            >
              {live === null && error === null ? (
                <div className="p-3">
                  <StateBlock variant="loading" title="Lendo…" />
                </div>
              ) : live === null || live.length + expired.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted">
                  Este jogador não tem skin nenhuma. Ele ainda aplica as liberadas para todos.
                </p>
              ) : rows.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted">{emptyMessage()}</p>
              ) : (
                <>
                  <OwnedRows
                    rows={pageRows}
                    favorites={favorites}
                    busy={busy}
                    onRevoke={(owned) => void revoke(owned)}
                  />
                  <Pagination
                    className="border-t border-border px-4 py-2"
                    page={current}
                    pageSize={pageSize}
                    total={rows.length}
                    onPageChange={setPage}
                    onPageSizeChange={changePageSize}
                  />
                </>
              )}
            </div>
          </Block>

          <Dialog
            open={giving}
            title="Adicionar skin"
            busy={givingBusy}
            guarded
            escapable
            onClose={() => setGiving(false)}
            // ~720 px no desktop; no celular, a tela inteira.
            className="w-[min(45rem,94vw)] max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:border-0"
          >
            {giving && (
              <GiveSkin
                steamId={steamId}
                liveIds={liveIds}
                onBusy={setGivingBusy}
                onCancel={() => setGiving(false)}
                onGranted={async () => {
                  setGiving(false);
                  await load();
                }}
              />
            )}
          </Dialog>
        </div>
      )}

      {view === 'history' && (
        <div
          role="tabpanel"
          id="player-skins-panel-history"
          aria-labelledby="player-skins-tab-history"
        >
          {/* Monta ao entrar: o que mudou na outra sub-aba já aparece. */}
          <Block title="Histórico">
            <div className="p-3">
              <AuditPanel servers={servers} fixedSteamId={steamId} />
            </div>
          </Block>
        </div>
      )}
    </div>
  );
}

function Block({
  title,
  count,
  aside,
  children,
}: {
  readonly title: string;
  readonly count?: number | null;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          {title}
          {count !== undefined && count !== null && (
            <span className="font-mono text-2xs font-normal text-muted">{count}</span>
          )}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Um selo discreto, para prazo e origem. */
function Tag({ tone, title, children }: { tone?: string; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={cn(
        'whitespace-nowrap border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted',
        tone,
      )}
    >
      {children}
    </span>
  );
}

function OwnedRows({
  rows,
  favorites,
  busy,
  onRevoke,
}: {
  readonly rows: readonly WorkshopOwned[];
  /** Ids de skin favoritados pelo jogador. A estrela é um selo, não um botão. */
  readonly favorites: ReadonlySet<number>;
  readonly busy: boolean;
  readonly onRevoke: (owned: WorkshopOwned) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((owned) => {
        const skin = owned.skin;
        const permanent = owned.expiresAt === null;
        const favorite = favorites.has(owned.skinId);

        return (
          <li
            key={owned.id}
            className={cn(
              'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5',
              owned.expired && 'opacity-60',
            )}
          >
            <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
              <SkinThumb
                previewUrl={skin?.previewUrl ?? null}
                shortname={skin?.shortname ?? ''}
                large
              />

              <div className="min-w-0 space-y-0.5">
                <p className="flex flex-wrap items-center gap-1.5">
                  {/* Selo, e não botão: favoritar é do jogador, no jogo. */}
                  {favorite && (
                    <span
                      role="img"
                      aria-label="Favorita do jogador"
                      title="Favorita do jogador — ele marcou esta skin no menu do jogo. O painel não marca nem desmarca."
                      className="flex shrink-0 items-center"
                    >
                      <Star aria-hidden="true" className="h-3.5 w-3.5 fill-amber text-amber" />
                    </span>
                  )}
                  <span className="truncate font-medium text-foreground">
                    {skin?.label ?? `skin #${String(owned.skinId)}`}
                  </span>
                  {skin !== null && <RarityBadge rarity={skin.rarity} />}
                  {skin === null && <span className="text-2xs text-muted">apagada do catálogo</span>}
                  {skin !== null && !skin.enabled && (
                    <span className="text-2xs text-muted">desligada</span>
                  )}
                </p>
                {skin !== null && (
                  <p className="font-mono text-2xs text-muted">{skin.shortname}</p>
                )}
                {(owned.createdBy !== '' || owned.note !== null) && (
                  <p className="truncate text-2xs text-muted">
                    {owned.createdBy === '' ? '' : `por ${owned.createdBy}`}
                    {owned.createdBy !== '' && owned.note !== null ? ' · ' : ''}
                    {owned.note === null ? '' : `“${owned.note}”`}
                  </p>
                )}
              </div>
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              <Tag
                tone={cn(!owned.expired && permanent && 'border-olive/50 text-olive')}
                title={owned.expiresAt ?? undefined}
              >
                {permanent
                  ? 'permanente'
                  : owned.expired
                    ? describeOwnedExpiry(owned)
                    : `expira ${describeOwnedExpiry(owned).replace(/^até /, 'em ')}`}
              </Tag>
              <Tag title={owned.sourceRef ?? undefined}>
                {OWNED_SOURCE_LABELS[owned.source]}
                {owned.sourceRef === null ? '' : ` · ${owned.sourceRef}`}
              </Tag>

              <ConfirmButton
                variant="outline"
                size="sm"
                className="ml-1 text-muted hover:border-rust hover:text-rust"
                disabled={busy}
                icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
                label="Remover"
                confirmLabel="Remover mesmo"
                hint="Ele deixa de poder aplicar esta skin. O que já foi pintado continua pintado."
                onConfirm={() => onRevoke(owned)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function GiveSkin({
  steamId,
  liveIds,
  onBusy,
  onCancel,
  onGranted,
}: {
  readonly steamId: string;
  readonly liveIds: ReadonlySet<number>;
  readonly onBusy: (busy: boolean) => void;
  readonly onCancel: () => void;
  readonly onGranted: () => Promise<void>;
}) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [skinId, setSkinId] = useState<number | null>(null);
  const [expiry, setExpiry] = useState<ExpiryValue>(PERMANENT);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.workshopSkins();

        if (alive) setSkins((Array.isArray(response.skins) ? response.skins : []).map(safeSkin));
      } catch (cause) {
        if (alive) {
          setSkins([]);
          setCatalogError(messageOf(cause));
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  function changeBusy(value: boolean): void {
    setBusy(value);
    onBusy(value);
  }

  const { problem: expiryProblem, body } = expiryBody(expiry);
  const problem = skinId === null ? 'Escolha a skin.' : expiryProblem;
  const renewing = skinId !== null && liveIds.has(skinId);

  async function submit(): Promise<void> {
    if (skinId === null) return;

    changeBusy(true);
    setError(null);

    let granted = false;

    try {
      const trimmed = note.trim();
      const response = await agent.grantWorkshopOwned({
        steamId,
        skinId,
        ...body,
        ...(trimmed === '' ? {} : { note: trimmed }),
      });
      const owned = response.owned === undefined ? null : safeOwned(response.owned);

      toast.success(response.created === false ? 'Prazo renovado' : 'Skin dada', {
        ...(owned === null
          ? {}
          : { description: `${owned.skin?.label ?? ''} · ${describeOwnedExpiry(owned)}` }),
      });
      granted = true;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError('', messageOf(cause), 0));
    } finally {
      // Destrava ANTES de fechar: com `busy`, o Dialog recusaria.
      changeBusy(false);
    }

    if (granted) await onGranted();
  }

  return (
    <div className="space-y-3">
      {catalogError !== null && (
        <StateBlock variant="error" title="Não consegui ler o catálogo" detail={catalogError} />
      )}

      {skins === null ? (
        <StateBlock variant="loading" title="Lendo o catálogo…" />
      ) : (
        <SkinCatalogPicker
          skins={skins}
          multiple={false}
          selected={skinId === null ? [] : [skinId]}
          ownedIds={liveIds}
          onChange={(ids) => setSkinId(ids[0] ?? null)}
        />
      )}

      <ExpiryPicker value={expiry} onChange={setExpiry} />
      <NoteField value={note} onChange={setNote} />

      {renewing && (
        <p className="border-l-2 border-amber pl-2 text-2xs leading-relaxed text-amber">
          Ele já tem esta skin. Dar de novo <strong>soma</strong> o prazo escolhido ao que sobra —
          ou mantém o permanente.
        </p>
      )}

      <OwnedErrorBox error={error} title="Não consegui dar a skin" />

      {/* Preso no fundo da caixa, como no cadastro de skins: o -mx/-mb
          cobre o respiro do Dialog. */}
      <div className="sticky bottom-0 -mx-3 -mb-3 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-3 py-3">
        <p className="text-2xs text-muted">{problem}</p>

        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || problem !== null}
            onClick={() => void submit()}
          >
            {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
            {renewing ? 'Renovar' : 'Dar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
