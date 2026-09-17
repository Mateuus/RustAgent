'use client';

// ============================================================
//  skins-panel.tsx  -  o catálogo de skins, e o que se faz nele.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  É uma tela de COMPARAÇÃO. A pergunta que se faz aqui é "que
//  skins este item tem, quem pode usar, e em que servidores?" — e
//  ela se responde varrendo colunas, não lendo cartão por cartão.
//  Várias skins por item são o caso normal: o jogador escolhe na
//  caixa do `/skin`.
//
//  ####  DUAS ORIGENS, UM CATÁLOGO  ####
//
//  O admin cadastra aqui OU no jogo (`/skin add`). As duas gravam a
//  mesma linha, e a coluna "Origem" é o único lugar que diz qual foi.
//
//  ####  O CATÁLOGO É DA REDE  ####
//
//  A coluna "Servidores" é a única coisa que varia por servidor — e
//  por isso ela é editável ali mesmo, pela rota que troca só a
//  lista, sem reenviar o formulário inteiro.
//
//  ####  O QUE O AGENTE MANDA, A TELA NÃO CONFERE  ####
//
//  Toda resposta passa pelo `safeSkin` (normalize.ts) antes de
//  chegar ao JSX: campo ausente vira TypeError e derruba a página.
// ============================================================

import { Plus, Search, Trash2, Video } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  messageOf,
  safeCollection,
  safeLookup,
  safeSkin,
} from '@/components/workshop/normalize';
import { ServerPicker, type WorkshopServerOption } from '@/components/workshop/server-picker';
import { SkinForm, blankSkin } from '@/components/workshop/skin-form';
import {
  agent,
  ApiError,
  type WorkshopCollection,
  type WorkshopLookup,
  type WorkshopSkin,
  type WorkshopSkinInput,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface SkinsPanelProps {
  readonly servers: readonly WorkshopServerOption[];
  /** Para o cabeçalho da página dizer quantas são. */
  readonly onCount?: (total: number) => void;
}

/** A skin que está sendo criada ou editada. `null` = nenhuma. */
interface Editing {
  readonly value: WorkshopSkinInput;
  /** Ausente = é uma skin nova. */
  readonly skin?: WorkshopSkin;
}

/** Colunas da tabela — a linha de servidores ocupa todas. */
const COLUMN_COUNT = 9;

/** O que o formulário recebe quando se abre uma skin já gravada. */
function toInput(skin: WorkshopSkin): WorkshopSkinInput {
  return {
    label: skin.label,
    shortname: skin.shortname,
    skinId: skin.skinId,
    permission: skin.permission ?? '',
    collectionId: skin.collectionId,
    openToAll: skin.openToAll,
    hideInStreamer: skin.hideInStreamer,
    enabled: skin.enabled,
    servers: [...skin.servers],
  };
}

/** A consulta à Steam, já normalizada. Estável: é dependência de efeito. */
async function lookupWorkshop(skinId: string, shortname: string): Promise<WorkshopLookup> {
  return safeLookup(await agent.workshopLookup(skinId, shortname));
}

export function SkinsPanel({ servers, onCount }: SkinsPanelProps) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[] | null>(null);
  const [collections, setCollections] = useState<readonly WorkshopCollection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [itemFilter, setItemFilter] = useState('');

  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  /** A recusa da última gravação. Mostrada DENTRO do formulário. */
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  /** A skin cuja lista de servidores está aberta na tabela. */
  const [openServers, setOpenServers] = useState<number | null>(null);
  const [serversDraft, setServersDraft] = useState<readonly string[]>([]);
  const [serversBusy, setServersBusy] = useState(false);
  /** A skin cujo liga/desliga está em voo. */
  const [toggling, setToggling] = useState<number | null>(null);

  const load = useCallback(async () => {
    // As coleções só dão nome à coluna e ao select: sem elas a lista
    // continua servindo, e a coluna mostra o número.
    const [skinsResult, collectionsResult] = await Promise.allSettled([
      agent.workshopSkins(),
      agent.workshopCollections(),
    ]);

    if (collectionsResult.status === 'fulfilled') {
      setCollections((collectionsResult.value.collections ?? []).map(safeCollection));
    }

    if (skinsResult.status === 'fulfilled') {
      const list = (skinsResult.value.skins ?? []).map(safeSkin);

      setSkins(list);
      onCount?.(list.length);
      setError(null);
    } else {
      setError(messageOf(skinsResult.reason));
      setSkins([]);
    }
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const collectionById = useMemo(
    () => new Map(collections.map((collection) => [collection.id, collection])),
    [collections],
  );

  const shortnames = useMemo(
    () => [...new Set((skins ?? []).map((skin) => skin.shortname))].sort(),
    [skins],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return (skins ?? []).filter(
      (skin) =>
        (itemFilter === '' || skin.shortname === itemFilter) &&
        (needle === '' ||
          skin.label.toLowerCase().includes(needle) ||
          skin.shortname.includes(needle) ||
          skin.skinId.includes(needle) ||
          (skin.workshopTitle ?? '').toLowerCase().includes(needle)),
    );
  }, [skins, query, itemFilter]);

  function warn(warning: string | null | undefined, label: string): void {
    if (typeof warning === 'string' && warning !== '') {
      toast.warning('Gravada, com um aviso', { description: `${label}: ${warning}` });
    }
  }

  async function save(value: WorkshopSkinInput): Promise<void> {
    if (editing === null) return;

    setSaving(true);
    setSaveError(null);

    try {
      if (editing.skin === undefined) {
        const response = await agent.createWorkshopSkin(value);
        const label = response.skin?.label ?? value.label;

        toast.success('Skin cadastrada', { description: label });
        warn(response.warning, label);
      } else {
        const response = await agent.updateWorkshopSkin(editing.skin.id, value);
        const label = response.skin?.label ?? editing.skin.label;

        toast.success('Skin salva', { description: label });
        warn(response.warning, label);
      }

      setEditing(null);
      await load();
    } catch (cause) {
      // A recusa fica NO FORMULÁRIO: a saída exige mexer num campo, e
      // um toast some antes de a pessoa terminar de ler.
      setSaveError(cause instanceof ApiError ? cause : new ApiError('', messageOf(cause), 0));
    } finally {
      setSaving(false);
    }
  }

  async function remove(skin: WorkshopSkin): Promise<void> {
    try {
      await agent.removeWorkshopSkin(skin.id);
      toast.success(`"${skin.label}" apagada.`);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', { description: messageOf(cause) });
    }
  }

  async function toggleEnabled(skin: WorkshopSkin): Promise<void> {
    setToggling(skin.id);

    try {
      const response = await agent.updateWorkshopSkin(skin.id, {
        ...toInput(skin),
        permission: skin.permission,
        enabled: !skin.enabled,
      });

      warn(response.warning, skin.label);
      await load();
    } catch (cause) {
      toast.error('Não consegui mudar', { description: messageOf(cause) });
    } finally {
      setToggling(null);
    }
  }

  async function saveServers(skin: WorkshopSkin): Promise<void> {
    setServersBusy(true);

    try {
      await agent.setWorkshopSkinServers(skin.id, serversDraft);
      toast.success('Servidores salvos', { description: skin.label });
      setOpenServers(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui salvar os servidores', { description: messageOf(cause) });
    } finally {
      setServersBusy(false);
    }
  }

  function openForm(skin: WorkshopSkin | null): void {
    setSaveError(null);
    setOpenServers(null);
    setEditing(skin === null ? { value: blankSkin() } : { value: toInput(skin), skin });
  }

  const serverName = (id: string): string =>
    servers.find((server) => server.id === id)?.name ?? id;

  if (error !== null && skins !== null && skins.length === 0) {
    return <StateBlock variant="error" title="Não consegui ler o catálogo de skins" detail={error} />;
  }

  if (skins === null) return <StateBlock variant="loading" title="Lendo as skins…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Uma skin <strong>não é um item novo</strong>: é a aparência de um item que o Rust já tem.
          O <strong>jogador escolhe</strong> — <span className="font-mono">/skin</span> abre a
          caixa com as que ele pode usar, e <span className="font-mono">/skin &lt;coleção&gt;</span>{' '}
          aplica a coleção inteira ao que ele veste. Admins também cadastram pelo jogo, com{' '}
          <span className="font-mono">/skin add &quot;item&quot; &quot;id&quot;</span>.
        </p>

        <Button size="sm" onClick={() => openForm(null)}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Nova skin
        </Button>
      </div>

      {editing !== null && (
        <SkinForm
          key={editing.skin?.id ?? 'nova'}
          value={editing.value}
          {...(editing.skin === undefined ? {} : { skin: editing.skin })}
          servers={servers}
          collections={collections}
          busy={saving}
          error={saveError}
          onLookup={lookupWorkshop}
          onSave={(value) => void save(value)}
          onCancel={() => {
            setEditing(null);
            setSaveError(null);
          }}
        />
      )}

      {skins.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Nenhuma skin cadastrada"
          detail="Comece por Nova skin: cole o Workshop ID da arte publicada, confira o item sugerido e diga em quais servidores ela vale."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
              />
              <Input
                value={query}
                placeholder="Filtrar por nome, item ou Workshop ID"
                aria-label="Filtrar skins"
                className="pl-7"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            <select
              value={itemFilter}
              aria-label="Filtrar por item"
              onChange={(event) => setItemFilter(event.target.value)}
              className="h-9 border border-border bg-surface-2 px-2 font-mono text-2xs text-foreground hover:border-muted"
            >
              <option value="">todos os itens</option>
              {shortnames.map((shortname) => (
                <option key={shortname} value={shortname}>
                  {shortname}
                </option>
              ))}
            </select>

            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              {visible.length === skins.length
                ? `${String(skins.length)} skins`
                : `${String(visible.length)} de ${String(skins.length)}`}
            </span>
          </div>

          {visible.length === 0 ? (
            <StateBlock variant="empty" title="Nenhuma skin casa com o filtro" />
          ) : (
            <div className="overflow-x-auto border border-border bg-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr>
                    <HeaderCell className="w-14">
                      <span className="sr-only">Prévia</span>
                    </HeaderCell>
                    <HeaderCell>Nome</HeaderCell>
                    <HeaderCell>Item</HeaderCell>
                    <HeaderCell>Workshop ID</HeaderCell>
                    <HeaderCell>Acesso</HeaderCell>
                    <HeaderCell>Coleção</HeaderCell>
                    <HeaderCell>Origem</HeaderCell>
                    <HeaderCell>Servidores</HeaderCell>
                    <HeaderCell className="text-right">
                      <span className="sr-only">Ações</span>
                    </HeaderCell>
                  </tr>
                </thead>

                <tbody className="divide-y divide-border">
                  {visible.map((skin) => (
                    <SkinRows
                      key={skin.id}
                      skin={skin}
                      collection={
                        skin.collectionId === null
                          ? null
                          : (collectionById.get(skin.collectionId) ?? null)
                      }
                      servers={servers}
                      serverName={serverName}
                      open={openServers === skin.id}
                      draft={serversDraft}
                      busy={serversBusy}
                      toggling={toggling === skin.id}
                      onOpenServers={() => {
                        setOpenServers(skin.id);
                        setServersDraft([...skin.servers]);
                      }}
                      onCloseServers={() => setOpenServers(null)}
                      onDraftChange={setServersDraft}
                      onSaveServers={() => void saveServers(skin)}
                      onEdit={() => openForm(skin)}
                      onToggle={() => void toggleEnabled(skin)}
                      onRemove={() => void remove(skin)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ####  O QUE MORDE DEPOIS  ####
          Nada disto aparece no cadastro, e tudo vira chamado de
          jogador. */}
      <div className="space-y-2 border border-border bg-surface-2 p-3 text-2xs leading-relaxed text-muted">
        <p>
          <strong className="text-foreground">Skin diferente não empilha.</strong> Um item com skin
          não junta com o mesmo item sem skin (nem com outra skin) — é o jogo, não o cadastro.
        </p>
        <p>
          <strong className="text-foreground">O item é o MESMO objeto.</strong> Aplicar uma skin só
          troca a aparência: quantidade, condição, munição e acessórios continuam como estavam.
        </p>
        <p>
          <strong className="text-foreground">
            A arte precisa estar publicada no Steam Workshop.
          </strong>{' '}
          O servidor guarda só o número; quem baixa o modelo é o cliente de cada jogador.
        </p>
        <p>
          <strong className="text-foreground">Acesso removido não despinta.</strong> Tirar a
          permissão, remover ou deixar vencer um acesso impede NOVAS aplicações — o que já foi
          pintado continua pintado.
        </p>
      </div>
    </div>
  );
}

interface SkinRowsProps {
  readonly skin: WorkshopSkin;
  readonly collection: WorkshopCollection | null;
  readonly servers: readonly WorkshopServerOption[];
  readonly serverName: (id: string) => string;
  readonly open: boolean;
  readonly draft: readonly string[];
  readonly busy: boolean;
  readonly toggling: boolean;
  readonly onOpenServers: () => void;
  readonly onCloseServers: () => void;
  readonly onDraftChange: (servers: string[]) => void;
  readonly onSaveServers: () => void;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}

function SkinRows({
  skin,
  collection,
  servers,
  serverName,
  open,
  draft,
  busy,
  toggling,
  onOpenServers,
  onCloseServers,
  onDraftChange,
  onSaveServers,
  onEdit,
  onToggle,
  onRemove,
}: SkinRowsProps) {
  return (
    <>
      <tr className={cn('hover:bg-surface-2', !skin.enabled && 'opacity-60')}>
        <td className="py-1 pl-3 pr-0">
          <SkinPreview skin={skin} />
        </td>

        <td className="px-3 py-2">
          <span className="flex items-center gap-1.5">
            <span className="text-foreground">{skin.label}</span>
            {skin.hideInStreamer && (
              <Video
                aria-label="Some do item de quem está em modo streamer"
                className="h-3.5 w-3.5 shrink-0 text-muted"
              />
            )}
            {!skin.enabled && (
              <span
                className="border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                title="Desligada: some da caixa e das coleções. O cadastro continua aqui."
              >
                desligada
              </span>
            )}
          </span>
          {skin.workshopTitle !== null && skin.workshopTitle !== skin.label && (
            <span className="block text-2xs text-muted">{skin.workshopTitle}</span>
          )}
        </td>

        <td className="px-3 py-2">
          <span className="font-mono text-2xs text-muted">{skin.shortname}</span>
        </td>

        <td className="px-3 py-2">
          {/* Texto, sem separador de milhar: vinte dígitos para
              conferir contra a URL da oficina, um a um. */}
          <span className="font-mono text-2xs text-foreground">{skin.skinId}</span>
        </td>

        <td className="px-3 py-2">
          <AccessBadge skin={skin} collection={collection} />
        </td>

        <td className="px-3 py-2 text-2xs">
          {skin.collectionId === null ? (
            <span className="text-muted">—</span>
          ) : (
            <span
              className="font-mono text-foreground"
              title={collection === null ? undefined : collection.label}
            >
              {collection === null ? `#${String(skin.collectionId)}` : `/skin ${collection.slug}`}
            </span>
          )}
        </td>

        <td className="px-3 py-2 text-2xs text-muted">
          <span title={skin.createdBy ?? undefined}>
            {skin.source === 'game' ? 'jogo' : 'painel'}
          </span>
        </td>

        <td className="px-3 py-2 text-2xs">
          <button
            type="button"
            onClick={open ? onCloseServers : onOpenServers}
            className="text-left underline decoration-dotted underline-offset-2 hover:text-foreground"
            title="Trocar só em quais servidores esta skin vale"
          >
            {skin.servers.length === 0 ? (
              <span className="text-rust">nenhum</span>
            ) : (
              <span className="text-muted">{skin.servers.map(serverName).join(', ')}</span>
            )}
          </button>
        </td>

        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-2">
            <Toggle
              on={skin.enabled}
              busy={toggling}
              onChange={onToggle}
              labels={['valendo', 'desligada']}
              label="Esta skin está valendo?"
            />

            <Button size="sm" variant="outline" onClick={onEdit}>
              Editar
            </Button>

            <ConfirmButton
              variant="danger"
              disabled={false}
              icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
              label="Apagar"
              confirmLabel="Apagar mesmo"
              hint="Some do catálogo, da caixa e da coleção. O que já foi pintado no mundo continua pintado. Para só tirar de circulação, desligue."
              onConfirm={onRemove}
            />
          </div>
        </td>
      </tr>

      {open && (
        <tr className="bg-surface-2">
          <td colSpan={COLUMN_COUNT} className="px-3 py-3">
            <p className="mb-2 font-condensed text-2xs uppercase tracking-wide text-muted">
              Em quais servidores “{skin.label}” vale
            </p>

            <ServerPicker value={draft} servers={servers} busy={busy} onChange={onDraftChange} />

            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={onSaveServers}>
                Salvar servidores
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onCloseServers}>
                Cancelar
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** A arte do Workshop quando a Steam deu a prévia; senão, o item base. */
function SkinPreview({ skin }: { readonly skin: WorkshopSkin }) {
  const [failed, setFailed] = useState(false);

  if (skin.previewUrl === null || failed) return <ItemIcon shortname={skin.shortname} />;

  return (
    // O <img> cru: a imagem vem da Steam, e o export estático não
    // tem otimizador.
    <img
      src={skin.previewUrl}
      alt=""
      loading="lazy"
      className="h-10 w-10 border border-border object-cover"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Quem pode usar, em uma palavra.
 *
 * A coleção conta: uma skin sem permissão própria numa coleção "para
 * todos" é, na prática, para todos — e dizer "só com acesso" ali
 * mandaria o admin liberar o que já está liberado.
 */
function AccessBadge({
  skin,
  collection,
}: {
  readonly skin: WorkshopSkin;
  readonly collection: WorkshopCollection | null;
}) {
  if (skin.openToAll || collection?.openToAll === true) {
    return (
      <span
        className="border border-olive px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-olive"
        title={skin.openToAll ? undefined : 'Liberada pela coleção, que é para todos'}
      >
        para todos{skin.openToAll ? '' : ' (coleção)'}
      </span>
    );
  }

  const permissions = [skin.permission, collection?.permission ?? null].filter(
    (permission): permission is string => permission !== null,
  );

  if (permissions.length > 0) {
    return (
      <span
        className="flex flex-col font-mono text-2xs text-foreground"
        title="Quem tem uma destas permissões (ou um acesso) pode usar"
      >
        {[...new Set(permissions)].map((permission) => (
          <span key={permission}>{permission}</span>
        ))}
      </span>
    );
  }

  return (
    <span
      className="text-2xs text-muted"
      title="Sem permissão: só por um acesso (aba Acessos) ou por origemzworkshop.admin"
    >
      só com acesso
    </span>
  );
}

function HeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}
