'use client';

// ============================================================
//  collections-panel.tsx  -  os `/skin <slug>` da rede.
//
//  ####  O QUE UMA COLEÇÃO É  ####
//
//  Um conjunto com NOME DE COMANDO: `/skin neve` aplica a máscara, o
//  casaco e a calça da neve ao que o jogador veste, de uma vez. É
//  também um jeito de liberar várias skins juntas: a permissão (ou o
//  "para todos", ou um acesso) da coleção vale para todas as skins
//  dela.
//
//  ####  QUEM FALA COM O AGENTE É ESTE ARQUIVO  ####
//
//  O formulário e o editor de itens só devolvem o que o admin
//  montou. Toda resposta passa pelo `safeX` (normalize.ts).
// ============================================================

import { ListChecks, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Toggle } from '@/components/ui/toggle';
import { CollectionForm, blankCollection } from '@/components/workshop/collection-form';
import { CollectionSkinsEditor } from '@/components/workshop/collection-skins-editor';
import { messageOf, safeCollection, safeSkin } from '@/components/workshop/normalize';
import {
  agent,
  ApiError,
  type WorkshopCollection,
  type WorkshopCollectionInput,
  type WorkshopSkin,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Editing {
  readonly value: WorkshopCollectionInput;
  readonly collection?: WorkshopCollection;
}

function toInput(collection: WorkshopCollection): WorkshopCollectionInput {
  return {
    slug: collection.slug,
    label: collection.label,
    permission: collection.permission ?? '',
    openToAll: collection.openToAll,
    enabled: collection.enabled,
  };
}

export function CollectionsPanel() {
  const [collections, setCollections] = useState<readonly WorkshopCollection[] | null>(null);
  const [skins, setSkins] = useState<readonly WorkshopSkin[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  /** A coleção cujo editor de itens está aberto. */
  const [itemsOf, setItemsOf] = useState<WorkshopCollection | null>(null);
  const [itemsBusy, setItemsBusy] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [collectionsResult, skinsResult] = await Promise.allSettled([
      agent.workshopCollections(),
      agent.workshopSkins(),
    ]);

    if (skinsResult.status === 'fulfilled') {
      setSkins((skinsResult.value.skins ?? []).map(safeSkin));
    }

    if (collectionsResult.status === 'fulfilled') {
      setCollections((collectionsResult.value.collections ?? []).map(safeCollection));
      setError(null);
    } else {
      setError(messageOf(collectionsResult.reason));
      setCollections([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(value: WorkshopCollectionInput): Promise<void> {
    if (editing === null) return;

    setSaving(true);
    setSaveError(null);

    try {
      if (editing.collection === undefined) {
        await agent.createWorkshopCollection(value);
        toast.success('Coleção criada', { description: `/skin ${value.slug}` });
      } else {
        await agent.updateWorkshopCollection(editing.collection.id, value);
        toast.success('Coleção salva', { description: `/skin ${value.slug}` });
      }

      setEditing(null);
      await load();
    } catch (cause) {
      setSaveError(cause instanceof ApiError ? cause : new ApiError('', messageOf(cause), 0));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(collection: WorkshopCollection): Promise<void> {
    setToggling(collection.id);

    try {
      await agent.updateWorkshopCollection(collection.id, {
        ...toInput(collection),
        permission: collection.permission,
        enabled: !collection.enabled,
      });
      await load();
    } catch (cause) {
      toast.error('Não consegui mudar', { description: messageOf(cause) });
    } finally {
      setToggling(null);
    }
  }

  async function remove(collection: WorkshopCollection): Promise<void> {
    try {
      await agent.removeWorkshopCollection(collection.id);
      toast.success(`/skin ${collection.slug} apagada.`, {
        description: 'As skins dela continuam no catálogo, avulsas.',
      });
      if (itemsOf?.id === collection.id) setItemsOf(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', { description: messageOf(cause) });
    }
  }

  async function saveItems(collection: WorkshopCollection, skinIds: number[]): Promise<void> {
    setItemsBusy(true);

    try {
      const response = await agent.setWorkshopCollectionSkins(collection.id, skinIds);
      const count = Array.isArray(response.skins) ? response.skins.length : skinIds.length;

      toast.success('Itens da coleção salvos', {
        description: `/skin ${collection.slug}: ${String(count)} ${count === 1 ? 'item' : 'itens'}`,
      });
      setItemsOf(null);
      await load();
    } catch (cause) {
      // A frase do agente diz qual item colidiu; a nossa não saberia.
      toast.error(
        cause instanceof ApiError && cause.code !== ''
          ? `O agente recusou (${cause.code})`
          : 'Não consegui salvar os itens',
        { description: messageOf(cause) },
      );
    } finally {
      setItemsBusy(false);
    }
  }

  function openForm(collection: WorkshopCollection | null): void {
    setSaveError(null);
    setItemsOf(null);
    setEditing(
      collection === null
        ? { value: blankCollection() }
        : { value: toInput(collection), collection },
    );
  }

  if (error !== null && collections !== null && collections.length === 0) {
    return <StateBlock variant="error" title="Não consegui ler as coleções" detail={error} />;
  }

  if (collections === null) return <StateBlock variant="loading" title="Lendo as coleções…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Uma coleção é um <strong>comando</strong>:{' '}
          <span className="font-mono">/skin neve</span> aplica, de uma vez, a skin da coleção a
          cada item que o jogador veste. Ela tem no máximo <strong>uma skin por item</strong>, e a
          permissão, o &quot;para todos&quot; ou um acesso nela liberam todas as skins dela.
        </p>

        <Button size="sm" onClick={() => openForm(null)}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Nova coleção
        </Button>
      </div>

      {editing !== null && (
        <CollectionForm
          key={editing.collection?.id ?? 'nova'}
          value={editing.value}
          {...(editing.collection === undefined ? {} : { collection: editing.collection })}
          busy={saving}
          error={saveError}
          onSave={(value) => void save(value)}
          onCancel={() => {
            setEditing(null);
            setSaveError(null);
          }}
        />
      )}

      {itemsOf !== null && (
        <CollectionSkinsEditor
          key={itemsOf.id}
          collection={itemsOf}
          skins={skins}
          collections={collections}
          busy={itemsBusy}
          onSave={(skinIds) => void saveItems(itemsOf, skinIds)}
          onCancel={() => setItemsOf(null)}
        />
      )}

      {collections.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Nenhuma coleção"
          detail="Crie uma com Nova coleção, e depois escolha em Itens qual skin de cada item faz parte dela."
        />
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <HeaderCell>Comando</HeaderCell>
                <HeaderCell>Nome</HeaderCell>
                <HeaderCell>Acesso</HeaderCell>
                <HeaderCell>Skins</HeaderCell>
                <HeaderCell className="text-right">
                  <span className="sr-only">Ações</span>
                </HeaderCell>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {collections.map((collection) => (
                <tr
                  key={collection.id}
                  className={cn('hover:bg-surface-2', !collection.enabled && 'opacity-60')}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs text-foreground">
                      /skin {collection.slug}
                    </span>
                  </td>

                  <td className="px-3 py-2">
                    <span className="text-foreground">{collection.label}</span>
                    {!collection.enabled && (
                      <span className="ml-2 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                        desligada
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-2xs">
                    {collection.openToAll ? (
                      <span className="border border-olive px-1.5 py-0.5 font-condensed font-bold uppercase tracking-wide text-olive">
                        para todos
                      </span>
                    ) : collection.permission !== null ? (
                      <span className="font-mono text-foreground">{collection.permission}</span>
                    ) : (
                      <span className="text-muted">só com acesso</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-2xs">
                    <span
                      className={cn(
                        'font-mono',
                        collection.skinCount === 0 ? 'text-rust' : 'text-foreground',
                      )}
                      title={
                        collection.skinCount === 0
                          ? 'Sem skins, o comando não pinta nada.'
                          : undefined
                      }
                    >
                      {collection.skinCount}
                    </span>
                  </td>

                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Toggle
                        on={collection.enabled}
                        busy={toggling === collection.id}
                        onChange={() => void toggleEnabled(collection)}
                        labels={['valendo', 'desligada']}
                        label="Esta coleção está valendo?"
                      />

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing(null);
                          setItemsOf(collection);
                        }}
                      >
                        <ListChecks aria-hidden="true" className="h-4 w-4" />
                        Itens
                      </Button>

                      <Button size="sm" variant="outline" onClick={() => openForm(collection)}>
                        Editar
                      </Button>

                      <ConfirmButton
                        variant="danger"
                        disabled={false}
                        icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                        label="Apagar"
                        confirmLabel="Apagar mesmo"
                        hint="O comando some. As skins ficam no catálogo, avulsas, e os acessos liberados para esta coleção são apagados junto."
                        onConfirm={() => void remove(collection)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
