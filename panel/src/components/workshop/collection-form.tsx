'use client';

// ============================================================
//  collection-form.tsx  -  o cadastro de uma coleção (`/skin neve`).
//
//  ####  O SLUG É UM COMANDO  ####
//
//  O jogador digita `/skin <slug>` no chat. Por isso a régua é
//  curta (24), minúscula e sem acento — o teclado de cada um é
//  diferente — e não pode ser um subcomando que o `/skin` já usa.
//  A régua daqui é CÓPIA da de core/src/types/workshop.ts, só para
//  avisar antes de salvar; quem decide é o agente.
//
//  ####  ELE NÃO FALA COM A API  ####
//
//  Quem chama o agente é o painel-pai.
// ============================================================

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import type { ApiError, WorkshopCollection, WorkshopCollectionInput } from '@/lib/api';

export interface CollectionFormProps {
  readonly value: WorkshopCollectionInput;
  /** Ausente = é nova. */
  readonly collection?: WorkshopCollection;
  readonly busy: boolean;
  readonly error?: ApiError | null;
  readonly onSave: (value: WorkshopCollectionInput) => void;
  readonly onCancel: () => void;
}

/** Os subcomandos do `/skin`. Espelha `RESERVED_COLLECTION_SLUGS`. */
const RESERVED_SLUGS: readonly string[] = [
  'add',
  'adicionar',
  'ajuda',
  'help',
  'lista',
  'list',
  'caixa',
  'box',
];

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export function blankCollection(): WorkshopCollectionInput {
  return { slug: '', label: '', permission: '', openToAll: false, enabled: true };
}

function slugProblem(slug: string): string | null {
  if (slug === '') return 'Dê um comando à coleção.';
  if (!SLUG_PATTERN.test(slug)) {
    return 'O comando tem até 24 letras minúsculas, dígitos, "-" ou "_", começando por letra ou dígito.';
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return `"${slug}" já é um subcomando do /skin (${RESERVED_SLUGS.join(', ')}).`;
  }
  return null;
}

function wayOut(code: string): string | null {
  switch (code) {
    case 'DUPLICATE_COLLECTION':
      return 'Já existe uma coleção com esse comando. Escolha outro, ou edite a existente.';

    case 'WORKSHOP_COLLECTION_NOT_FOUND':
      return 'A coleção foi apagada enquanto você editava. Feche e recarregue a lista.';

    default:
      return null;
  }
}

export function CollectionForm({
  value,
  collection,
  busy,
  error = null,
  onSave,
  onCancel,
}: CollectionFormProps) {
  const [draft, setDraft] = useState<WorkshopCollectionInput>(value);

  function patch(change: Partial<WorkshopCollectionInput>): void {
    setDraft((current) => ({ ...current, ...change }));
  }

  const slug = draft.slug.trim();
  const permission = draft.permission ?? '';
  const problem =
    slugProblem(slug) ?? (draft.label.trim() === '' ? 'Dê um nome à coleção.' : null);

  return (
    <section className="space-y-4 border border-border bg-surface p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-condensed text-sm font-bold uppercase tracking-wide">
          {collection === undefined ? 'Nova coleção' : collection.label}
        </h4>
        <span className="font-mono text-2xs text-foreground">
          /skin {slug === '' ? '…' : slug}
        </span>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Comando
          </span>
          <Input
            value={draft.slug}
            maxLength={24}
            placeholder="neve"
            className="mt-1 h-9 font-mono"
            onChange={(event) => patch({ slug: event.target.value.toLowerCase().replace(/\s/g, '') })}
          />
          <span className="mt-1 block text-2xs text-muted">
            O jogador digita <span className="font-mono text-foreground">/skin {slug || 'neve'}</span>{' '}
            e a coleção é aplicada ao que ele veste.
          </span>
        </label>

        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Nome</span>
          <Input
            value={draft.label}
            maxLength={60}
            placeholder="Inverno 2026"
            className="mt-1 h-9"
            onChange={(event) => patch({ label: event.target.value })}
          />
          <span className="mt-1 block text-2xs text-muted">
            É o que o jogador lê na resposta do comando.
          </span>
        </label>
      </div>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Permissão (opcional)
        </span>
        <Input
          value={permission}
          maxLength={80}
          placeholder="origemzworkshop.inverno"
          className="mt-1 h-9 font-mono"
          onChange={(event) => patch({ permission: event.target.value })}
        />
        <span className="mt-1 block text-2xs text-muted">
          Quem tem esta permissão pode usar TODAS as skins da coleção — pelo comando e pela caixa.
          Em branco, a coleção não tem permissão própria.
        </span>
      </label>

      <div className="space-y-3 border-t border-border pt-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <p className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Liberada para todos
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Qualquer jogador pode aplicar a coleção e as skins dela, sem permissão nem acesso.
            </p>
          </div>
          <Toggle
            on={draft.openToAll}
            busy={false}
            onChange={(openToAll) => patch({ openToAll })}
            labels={['para todos', 'restrita']}
            label="Esta coleção é liberada para todos?"
          />
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
          <div className="max-w-xl">
            <p className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Esta coleção está valendo?
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Desligada, o comando deixa de existir no jogo. As skins continuam no catálogo.
            </p>
          </div>
          <Toggle
            on={draft.enabled}
            busy={false}
            onChange={(enabled) => patch({ enabled })}
            labels={['valendo', 'desligada']}
            label="Esta coleção está valendo?"
          />
        </div>
      </div>

      {error !== null && (
        <div role="alert" className="border border-rust bg-surface-2 p-3">
          <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
            {error.code === '' ? 'Não consegui gravar' : `O agente recusou (${error.code})`}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-foreground">{error.message}</p>
          {wayOut(error.code) !== null && (
            <p className="mt-2 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-muted">
              {wayOut(error.code)}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-2xs text-muted">{problem}</p>

        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || problem !== null}
            onClick={() =>
              onSave({
                ...draft,
                slug,
                label: draft.label.trim(),
                permission: permission.trim() === '' ? null : permission.trim(),
              })
            }
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {collection === undefined ? 'Criar' : 'Salvar'}
          </Button>
        </div>
      </div>
    </section>
  );
}
