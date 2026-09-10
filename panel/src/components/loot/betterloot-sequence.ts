// ============================================================
//  betterloot-sequence.ts  -  quem chegou por último manda.
//
//  ####  A RESPOSTA VELHA É PIOR QUE A RESPOSTA QUE NÃO VEM  ####
//
//  A aba Tabelas tem três pedidos no ar ao mesmo tempo: o estado do
//  servidor, a caixa aberta e a gravação. Todos escrevem na MESMA
//  tela, e nenhum deles chega na ordem em que foi pedido — uma
//  tabela de 211 entradas demora mais que uma de 3, e trocar de
//  servidor não cancela o que já saiu.
//
//  Sem um árbitro, o desfecho não é uma tela feia: é a caixa do
//  servidor ANTERIOR repovoando o rascunho, com o nome do servidor
//  NOVO ao lado. O admin clica em "Gravar" e substitui a
//  configuração de loot de um servidor pela de outro, em silêncio.
//
//  ####  POR QUE CONTADOR, E NÃO COMPARAR `serverId`  ####
//
//  Comparar a identidade do pedido (servidor, prefab) resolve a
//  troca, mas não resolve DOIS PEDIDOS IGUAIS fora de ordem — clicar
//  duas vezes na mesma caixa, ou recarregar o estado depois de
//  gravar. O contador resolve os dois com uma regra só, e é o que a
//  casa já usa em `ranking-catalog.tsx` (`orderSeq`) para a mesma
//  doença.
//
//  ####  ABRIR NÃO É ENTRAR NA FILA  ####
//
//  `openRequest` invalida o que estiver no ar; `joinRequest` não.
//  A diferença tem consequência: um PUT que invalidasse a leitura de
//  caixa em voo deixaria o "Lendo a caixa…" preso para sempre, já
//  que quem apaga esse aviso é o `finally` da leitura — e ele confere
//  o contador antes de apagar. Quem grava, portanto, ENTRA NA FILA:
//  só quer saber se a tela ainda é a dele quando a resposta voltar.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React aqui: é o que `panel/test/betterloot-sequence.test.ts`
//  alcança. A corrida não aparece olhando a tela — ela precisa de
//  duas respostas resolvidas fora de ordem, e isso só um teste faz.
// ============================================================

import type { BetterLootTable } from '@/lib/api';

/**
 * Um contador de pedidos.
 *
 * É o `.current` de um `useRef(0)` do painel — a forma está aqui
 * para que a regra possa ser exercitada sem montar componente.
 */
export interface Sequence {
  current: number;
}

/** Abre um pedido novo e invalida tudo o que estiver no ar. */
export function openRequest(seq: Sequence): number {
  seq.current += 1;

  return seq.current;
}

/**
 * Entra na fila sem invalidar ninguém.
 *
 * Para quem só precisa saber, na volta, se a tela ainda é a mesma —
 * ver o cabeçalho.
 */
export function joinRequest(seq: Sequence): number {
  return seq.current;
}

/** A resposta deste pedido ainda é a que vale? */
export function isLatest(seq: Sequence, ticket: number): boolean {
  return seq.current === ticket;
}

/** Uma caixa lida, com a impressão que o "Gravar" devolve. */
export interface ReadTable {
  readonly table: BetterLootTable;
  /** O `tableRevision` — a impressão DESTA caixa, não a do arquivo. */
  readonly revision: string;
}

/** Onde a leitura de uma caixa escreve. São os `setState` do painel. */
export interface TableSink {
  readonly setSaved: (table: BetterLootTable | null) => void;
  readonly setDraft: (table: BetterLootTable | null) => void;
  /**
   * A impressão da caixa aberta.
   *
   * Ela anda junto com o `saved` porque é dele que ela fala: guardar
   * a revisão de uma caixa e o conteúdo de outra é exatamente o
   * estado que a revisão existe para impedir.
   */
  readonly setRevision: (revision: string | null) => void;
  readonly setError: (message: string | null) => void;
  readonly setLoading: (loading: boolean) => void;
}

/**
 * Lê uma caixa e só escreve na tela se, na volta, ela ainda for a aberta.
 *
 * ####  O `false` DO `finally` TAMBÉM É ESCRITA  ####
 *
 * Soltá-lo sem conferir apagaria o "Lendo a caixa…" de uma leitura
 * que ainda está no ar: a caixa velha chega, some o aviso, e a tela
 * fica vazia e parada até a nova responder.
 */
export async function readTableInto(
  seq: Sequence,
  read: () => Promise<ReadTable>,
  sink: TableSink,
): Promise<void> {
  const ticket = openRequest(seq);

  sink.setLoading(true);
  sink.setError(null);

  try {
    const read_ = await read();

    if (!isLatest(seq, ticket)) {
      return;
    }

    sink.setSaved(read_.table);
    sink.setDraft(read_.table);
    sink.setRevision(read_.revision);
  } catch (cause) {
    if (!isLatest(seq, ticket)) {
      return;
    }

    sink.setSaved(null);
    sink.setDraft(null);
    sink.setRevision(null);
    sink.setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (isLatest(seq, ticket)) {
      sink.setLoading(false);
    }
  }
}
