'use client';

// ============================================================
//  collection-skins-editor.tsx  -  QUAIS skins formam a coleção.
//
//  ####  UMA POR ITEM, E UMA COLEÇÃO POR SKIN  ####
//
//  A coleção é um mapa `item → skin`: `/skin neve` pinta a máscara
//  com A máscara da neve, e não com uma de três. Por isso a escolha
//  é um rádio por item, com "nenhuma" — o agente recusaria duas
//  (COLLECTION_ITEM_TAKEN), e a tela não deixa nem montar.
//
//  E a skin mora numa coleção só: escolher aqui uma que está em
//  outra a MOVE. O aviso em âmbar é para isso não ser surpresa.
//
//  ####  ELE NÃO FALA COM A API  ####
//
//  Recebe o catálogo pronto e devolve a lista de ids.
// ============================================================

import { Loader2, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { groupByShortname } from '@/components/workshop/normalize';
import type { WorkshopCollection, WorkshopSkin } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface CollectionSkinsEditorProps {
  readonly collection: WorkshopCollection;
  readonly skins: readonly WorkshopSkin[];
  readonly collections: readonly WorkshopCollection[];
  readonly busy: boolean;
  readonly onSave: (skinIds: number[]) => void;
  readonly onCancel: () => void;
}

/** `shortname → id da skin escolhida`. Ausente = nenhuma. */
type Selection = Readonly<Record<string, number>>;

function initialSelection(skins: readonly WorkshopSkin[], collectionId: number): Selection {
  const selection: Record<string, number> = {};

  for (const skin of skins) {
    if (skin.collectionId === collectionId) selection[skin.shortname] = skin.id;
  }

  return selection;
}

export function CollectionSkinsEditor({
  collection,
  skins,
  collections,
  busy,
  onSave,
  onCancel,
}: CollectionSkinsEditorProps) {
  const [selection, setSelection] = useState<Selection>(() =>
    initialSelection(skins, collection.id),
  );
  const [query, setQuery] = useState('');

  const groups = useMemo(() => groupByShortname(skins), [skins]);
  const slugById = useMemo(
    () => new Map(collections.map((entry) => [entry.id, entry.slug])),
    [collections],
  );

  const needle = query.trim().toLowerCase();
  const visibleGroups = groups.filter(
    (group) =>
      needle === '' ||
      group.shortname.includes(needle) ||
      group.skins.some((skin) => skin.label.toLowerCase().includes(needle)),
  );

  const chosen = Object.values(selection);
  const moving = skins.filter(
    (skin) =>
      chosen.includes(skin.id) && skin.collectionId !== null && skin.collectionId !== collection.id,
  );

  function choose(shortname: string, skinId: number | null): void {
    setSelection((current) => {
      const next: Record<string, number> = { ...current };

      if (skinId === null) delete next[shortname];
      else next[shortname] = skinId;

      return next;
    });
  }

  return (
    <section className="space-y-3 border border-border bg-surface p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-condensed text-sm font-bold uppercase tracking-wide">
          Itens de <span className="font-mono normal-case">/skin {collection.slug}</span>
        </h4>
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          {chosen.length === 1 ? '1 item' : `${String(chosen.length)} itens`}
        </span>
      </header>

      <p className="text-2xs leading-relaxed text-muted">
        Uma skin por item. Escolher uma skin que já está em outra coleção a{' '}
        <strong className="text-foreground">move</strong> para esta.
      </p>

      {skins.length === 0 ? (
        <p className="text-2xs text-muted">O catálogo está vazio: cadastre skins na aba Skins.</p>
      ) : (
        <>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <Input
              value={query}
              placeholder="Filtrar por item ou nome"
              aria-label="Filtrar itens"
              className="pl-7"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="max-h-[28rem] divide-y divide-border overflow-y-auto border border-border">
            {visibleGroups.map((group) => {
              const selected = selection[group.shortname] ?? null;
              const name = `collection-${String(collection.id)}-${group.shortname}`;

              return (
                <fieldset key={group.shortname} className="px-3 py-2">
                  <legend className="float-left mr-3 flex w-44 items-center gap-2 pt-1">
                    <ItemIcon shortname={group.shortname} size="sm" />
                    <span className="truncate font-mono text-2xs text-foreground">
                      {group.shortname}
                    </span>
                  </legend>

                  <div className="flex flex-wrap gap-1.5">
                    <Choice
                      name={name}
                      checked={selected === null}
                      onChange={() => choose(group.shortname, null)}
                    >
                      <span className="text-muted">nenhuma</span>
                    </Choice>

                    {group.skins.map((skin) => {
                      const elsewhere =
                        skin.collectionId !== null && skin.collectionId !== collection.id
                          ? (slugById.get(skin.collectionId) ?? `#${String(skin.collectionId)}`)
                          : null;

                      return (
                        <Choice
                          key={skin.id}
                          name={name}
                          checked={selected === skin.id}
                          onChange={() => choose(group.shortname, skin.id)}
                        >
                          <span className={cn(!skin.enabled && 'opacity-60')}>
                            {skin.label}
                            {!skin.enabled && ' (desligada)'}
                          </span>
                          {elsewhere !== null && (
                            <span className="ml-1 font-mono text-amber">em /skin {elsewhere}</span>
                          )}
                        </Choice>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}

            {visibleGroups.length === 0 && (
              <p className="px-3 py-2 text-2xs text-muted">Nenhum item casa com o filtro.</p>
            )}
          </div>
        </>
      )}

      {moving.length > 0 && (
        <p className="border-l-2 border-amber pl-2 text-2xs leading-relaxed text-amber">
          Ao salvar, {moving.length === 1 ? 'esta skin sai' : 'estas skins saem'} da coleção em que
          estão:{' '}
          {moving
            .map(
              (skin) =>
                `${skin.label} (/skin ${slugById.get(skin.collectionId ?? 0) ?? String(skin.collectionId)})`,
            )
            .join(', ')}
          .
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onSave(chosen)}>
          {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
          Salvar itens
        </Button>
      </div>
    </section>
  );
}

function Choice({
  name,
  checked,
  onChange,
  children,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-1.5 border px-2 py-1 text-2xs',
        checked ? 'border-olive bg-olive/10 text-foreground' : 'border-border hover:border-muted',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="accent-olive"
      />
      {children}
    </label>
  );
}
