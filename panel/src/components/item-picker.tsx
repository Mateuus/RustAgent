'use client';

// ============================================================
//  item-picker.tsx  -  escolher um item do jogo pelo NOME.
//
//  ####  É PARA ISTO QUE O CATÁLOGO EXISTE  ####
//
//  Sem ele, pôr o ícone de uma AK numa tela exige decorar
//  `1545779598`. Com ele, digita-se "assault" e escolhe-se na
//  lista — com o ícone ao lado, que é o que confirma que o item é
//  aquele mesmo.
//
//  E funciona com TODOS OS SERVIDORES PARADOS: a busca vai ao
//  banco do agente, não ao jogo.
//
//  ####  O ÍCONE VEM DO PAINEL, O RESTO DO AGENTE  ####
//
//  Duas origens diferentes de propósito: o ícone só existe na
//  instalação do cliente do Rust (ver components/item-icon.tsx) e
//  viaja no bundle; o nome, a categoria e o id vêm do catálogo, que
//  o agente lê do servidor.
// ============================================================

import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { Input } from '@/components/ui/input';
import { agent, type CatalogItem } from '@/lib/api';

/**
 * Quantos itens a lista mostra.
 *
 * Oito cabem sem rolagem sob o campo e são o suficiente para o
 * item certo aparecer numa busca de duas ou três letras.
 */
const RESULTS = 8;

/**
 * Espera antes de perguntar ao agente.
 *
 * A busca é barata (uma consulta indexada no SQLite), mas uma
 * requisição POR TECLA num campo de dez letras são dez idas para
 * mostrar o resultado da última.
 */
const DEBOUNCE_MS = 200;

export interface ItemPickerProps {
  /** O que está escolhido agora. Vazio = nada. */
  readonly shortname: string;
  readonly onPick: (item: CatalogItem) => void;
}

export function ItemPicker({ shortname, onPick }: ItemPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (query.trim() === '') {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      void agent
        .items({ query, limit: RESULTS })
        .then((page) => {
          setResults(page.items);
        })
        .catch(() => {
          // Uma busca que falha não pode derrubar o editor: o campo
          // simplesmente não oferece nada, e o erro de verdade — se
          // houver — aparece na tela de Itens.
          setResults([]);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="space-y-1">
      <span className="flex items-center gap-2">
        <ItemIcon shortname={shortname} size="lg" />

        <span className="flex min-w-0 flex-1 items-center gap-2 border border-border bg-surface-2 px-2">
          <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />
          <Input
            value={query}
            placeholder={shortname === '' ? 'Buscar item…' : shortname}
            aria-label="Buscar um item do jogo"
            className="border-0 bg-transparent px-0 text-2xs hover:border-0"
            onFocus={() => setOpen(true)}
            // O clique num resultado tira o foco do campo ANTES do
            // `onClick` do botão. Sem o atraso, a lista fecharia
            // antes de a escolha acontecer.
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
          />
        </span>
      </span>

      {open && results.length > 0 && (
        <ul className="max-h-48 overflow-y-auto border border-border bg-surface">
          {results.map((item) => (
            <li key={item.shortname}>
              <button
                type="button"
                onClick={() => {
                  onPick(item);
                  setQuery('');
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-2"
              >
                <ItemIcon shortname={item.shortname} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-2xs text-foreground">{item.displayName}</span>
                  <span className="block truncate font-mono text-2xs text-muted">
                    {item.shortname}
                  </span>
                </span>
                {item.removed && (
                  <span
                    className="shrink-0 text-2xs text-rust"
                    title="O jogo não lista mais este item nesta versão."
                  >
                    fora do jogo
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
