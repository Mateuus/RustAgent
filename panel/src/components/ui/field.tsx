'use client';

// ============================================================
//  field.tsx  -  o rótulo, a caixa e o "+".
//
//  ####  TRÊS PEÇAS QUE JÁ EXISTIAM EM DOIS LUGARES  ####
//
//  Elas nasceram dentro do diálogo de missões. Quando o formulário
//  do território passou a editar as mesmas recompensas, copiar os
//  estilos daria duas caixas de texto parecidas — e "parecidas" é o
//  tipo de diferença que ninguém nota e ninguém consegue explicar
//  depois.
//
//  Elas são de FORMA, não de assunto: nenhuma sabe o que está
//  editando, e é isso que as deixa morar aqui.
// ============================================================

import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/** A caixa de texto dos diálogos. */
export const INPUT =
  'w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground';

/**
 * O checkbox do painel.
 *
 * `accent-rust` é o que troca o azul do sistema pela cor da casa —
 * e o tamanho fixo é o que impede ele de encolher dentro de um
 * flex. Um checkbox nu fica com a cor do navegador, que não é a de
 * lugar nenhum desta tela.
 */
export const CHECKBOX = 'h-4 w-4 shrink-0 accent-rust';

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
    </label>
  );
}

/** O `+` que abre a lista de tipos. */
export function AddMenu<K extends string>({
  labels,
  onPick,
}: {
  readonly labels: Readonly<Record<K, string>>;
  readonly onPick: (kind: K) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Acrescentar
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded border border-border bg-surface py-1">
          {(Object.keys(labels) as K[]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                onPick(kind);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-2xs hover:bg-background"
            >
              {labels[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
