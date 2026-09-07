'use client';

// ============================================================
//  item-picker-dialog.tsx  -  escolher um item do jogo, OLHANDO.
//
//  ####  POR QUE UMA GRADE, E NÃO UMA LISTA  ####
//
//  Porque a pergunta que se faz aqui não é "qual é o shortname?" —
//  é "qual desses tem cara de troféu?". Quem escolhe o corpo de um
//  item custom está escolhendo o que o jogador vai SEGURAR, e isso
//  se decide pelo ícone, não pelo nome.
//
//  Um campo de busca com uma listinha suspensa serve para quem já
//  sabe o nome. Para quem está procurando uma FORMA, ele obriga a
//  digitar palpites em inglês e ler seis linhas por vez.
//
//  ####  E POR QUE UM MODAL PRÓPRIO  ####
//
//  Porque a escolha tem espaço demais para caber dentro de outro
//  formulário: 1259 itens, 14 categorias e uma busca. Empurrar isso
//  para dentro do cadastro foi o que deixou o cadastro ruim.
// ============================================================

import { Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { agent, type CatalogItem } from '@/lib/api';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Quantos itens a grade traz por vez.
 *
 * O teto da rota é 200. Numa grade de ícones, 120 já enchem duas
 * rolagens — e quem não achou em 120 vai refinar a busca, não
 * rolar mais.
 */
const PAGE_SIZE = 120;

interface ItemPickerDialogProps {
  readonly open: boolean;
  /** O que já está escolhido, para aparecer marcado. */
  readonly selected: string;
  readonly onClose: () => void;
  readonly onPick: (item: CatalogItem) => void;
}

export function ItemPickerDialog({ open, selected, onClose, onPick }: ItemPickerDialogProps) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<{ category: string; total: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [busca, setBusca] = useState('');
  const [categoria, setCategoria] = useState('');

  const load = useCallback(async () => {
    if (!open) return;

    try {
      const response = await agent.items({
        query: busca,
        category: categoria,
        limit: PAGE_SIZE,
      });

      setItems(response.items);
      setTotal(response.total);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [open, busca, categoria]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;

    void (async () => {
      try {
        setCategories([...(await agent.itemCategories()).categories]);
      } catch {
        // O filtro é conveniência; a busca continua servindo sem
        // ele, e o erro de verdade já aparece na grade.
      }
    })();
  }, [open]);

  return (
    <Dialog
      open={open}
      title="Escolher o corpo emprestado"
      onClose={onClose}
      className="w-[min(64rem,94vw)]"
    >
      <div className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted">
          O item custom usa o <strong>modelo 3D, o slot e o empilhamento</strong> deste item.
          Escolha pela forma que o jogador vai segurar na mão.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-64 flex-1 items-center gap-2 border border-border bg-surface-2 px-2">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
            <Input
              value={busca}
              autoFocus
              placeholder="Nome em inglês ou shortname (trophy, bandage…)"
              aria-label="Buscar item do jogo"
              className="border-0 bg-transparent px-0 hover:border-0"
              onChange={(event) => setBusca(event.target.value)}
            />
          </label>

          <select
            value={categoria}
            aria-label="Categoria"
            onChange={(event) => setCategoria(event.target.value)}
            className="border border-border bg-surface-2 px-2 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground"
          >
            <option value="">Todas as categorias</option>
            {categories.map((entry) => (
              <option key={entry.category} value={entry.category}>
                {entry.category} ({String(entry.total)})
              </option>
            ))}
          </select>
        </div>

        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler o catálogo" detail={error} />
        )}

        {items === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

        {items !== null && items.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nada com esses filtros"
            detail="O catálogo é do jogo, e os nomes estão em inglês. Tente parte do nome, o shortname, ou outra categoria."
          />
        )}

        {items !== null && items.length > 0 && (
          <div className="max-h-[52vh] overflow-y-auto border border-border bg-surface p-2">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1">
              {items.map((item) => (
                <button
                  key={item.shortname}
                  type="button"
                  onClick={() => {
                    onPick(item);
                    onClose();
                  }}
                  title={`${item.displayName} · ${item.shortname} · empilha ${String(item.maxStack)}`}
                  className={cn(
                    'flex flex-col items-center gap-1 border p-2 text-center transition-colors',
                    item.shortname === selected
                      ? 'border-rust bg-rust/10'
                      : 'border-transparent hover:border-border hover:bg-surface-2',
                  )}
                >
                  <ItemIcon shortname={item.shortname} />

                  <span className="line-clamp-2 text-2xs leading-tight text-foreground">
                    {item.displayName}
                  </span>

                  {/* O empilhamento aparece porque ele é herdado: o
                      item custom só sabe DIMINUIR esse número. */}
                  <span className="font-mono text-2xs text-muted">
                    {item.maxStack > 1 ? `×${String(item.maxStack)}` : ' '}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-2xs text-muted">
            {items === null
              ? ''
              : total > PAGE_SIZE
                ? `Mostrando ${String(items.length)} de ${formatInteger(total)} — refine a busca para ver o resto.`
                : `${formatInteger(total)} item(ns)`}
          </p>

          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
