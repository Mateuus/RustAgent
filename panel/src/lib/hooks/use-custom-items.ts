'use client';

// ============================================================
//  use-custom-items.ts  -  os itens que NÓS criamos, em memória.
//
//  ####  POR QUE UM CACHE, E NÃO UMA BUSCA POR TECLA  ####
//
//  `GET /api/custom-items` traz a lista INTEIRA e não aceita
//  busca — de propósito: o catálogo do jogo tem 1259 linhas e
//  precisa de SQL, os nossos são dezenas e cabem na memória.
//
//  Só que o seletor de item não é um por tela: a oferta de kit da
//  loja monta um por linha do pacote. Sem cache, abrir um kit de
//  dez itens dispararia dez vezes a mesma requisição, e a lista
//  chegaria dez vezes igual.
//
//  Então a promessa é de MÓDULO, compartilhada por todos os
//  seletores montados, com validade curta: um item cadastrado
//  noutra aba aparece no seletor em no máximo um minuto, e não
//  depois de recarregar a página.
//
//  ####  FALHA NÃO É CACHEADA  ####
//
//  Guardar uma promessa rejeitada deixaria o painel sem os nossos
//  itens até o minuto virar, mesmo depois de a rede voltar. O
//  cache é limpo no erro, e a próxima montagem tenta de novo.
// ============================================================

import { useEffect, useState } from 'react';

import { agent, type CustomItem } from '@/lib/api';

/**
 * Por quanto tempo a lista lida vale.
 *
 * Um minuto: curto o bastante para um cadastro novo aparecer sem
 * recarregar, longo o bastante para os dez seletores de um kit
 * usarem a mesma resposta.
 */
const TTL_MS = 60_000;

interface Cached {
  readonly at: number;
  readonly items: Promise<readonly CustomItem[]>;
}

let cache: Cached | null = null;

/** Descarta o que está guardado. Existe para o cadastro chamar. */
export function forgetCustomItems(): void {
  cache = null;
}

/** A lista, do cache ou da rede. */
export function loadCustomItems(): Promise<readonly CustomItem[]> {
  const now = Date.now();

  if (cache !== null && now - cache.at < TTL_MS) {
    return cache.items;
  }

  const items = agent
    .customItems()
    .then((response) => response.items)
    .catch((cause: unknown) => {
      // Ver o cabeçalho: erro não fica guardado.
      cache = null;

      throw cause instanceof Error ? cause : new Error(String(cause));
    });

  cache = { at: now, items };

  return items;
}

export interface CustomItemsState {
  readonly items: readonly CustomItem[];
  /**
   * Por que a lista dos nossos não veio.
   *
   * `null` é "veio". A tela mostra isso numa linha discreta em vez
   * de engolir: um seletor que some com os itens da casa sem dizer
   * nada é indistinguível de um cadastro vazio.
   */
  readonly error: string | null;
}

/** Os itens nossos, para um seletor. */
export function useCustomItems(): CustomItemsState {
  const [state, setState] = useState<CustomItemsState>({ items: [], error: null });

  useEffect(() => {
    let alive = true;

    void loadCustomItems()
      .then((items) => {
        if (alive) {
          setState({ items, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setState({ items: [], error: cause instanceof Error ? cause.message : String(cause) });
        }
      });

    return () => {
      // O componente pode sair da tela antes de a lista chegar —
      // um seletor dentro de um modal que foi fechado. Sem isto,
      // o `setState` cairia num componente desmontado.
      alive = false;
    };
  }, []);

  return state;
}
