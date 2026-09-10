// ============================================================
//  A corrida do editor de loot.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  O admin clica numa caixa, o GET sai, e ele troca de servidor
//  antes de a resposta voltar. Sem árbitro, a caixa do servidor
//  ANTERIOR repovoa `saved`/`draft` — e a barra de gravar reaparece,
//  porque ela só olha `draft !== null`. Um clique em "Gravar" manda
//  essa caixa para o servidor de AGORA: a configuração de loot de um
//  servidor substitui a de outro, em silêncio.
//
//  Nada disso aparece olhando a tela. Precisa de duas respostas
//  resolvidas fora de ordem, e é o que este arquivo faz.
//
//  Sem DOM de propósito: a decisão de "esta resposta ainda vale?"
//  mora em `betterloot-sequence.ts` justamente para poder ser
//  exercitada aqui — a mesma escolha que `reorder.ts` fez ao sair
//  de `ranking-catalog.tsx`.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  isLatest,
  joinRequest,
  openRequest,
  readTableInto,
  type ReadTable,
  type Sequence,
  type TableSink,
} from '@/components/loot/betterloot-sequence';
import type { BetterLootTable } from '@/lib/api';

function tableOf(prefab: string): BetterLootTable {
  return {
    prefab,
    enabled: true,
    itemCount: 0,
    guaranteedCount: 0,
    profileCount: 0,
    itemSettings: {
      minItems: 8,
      maxItems: 8,
      minScrap: 25,
      maxScrap: 25,
      minBlueprints: 0,
      maxBlueprints: 1,
      bonusItemsCountToTotal: false,
      guaranteedItemsCountToTotal: true,
    },
    poolLocking: false,
    ignoreRarityBias: false,
    profiles: [],
    guaranteed: [],
    items: [],
  };
}

/** Um `TableSink` que guarda tudo o que foi escrito, na ordem. */
interface Recording {
  readonly sink: TableSink;
  readonly saved: (BetterLootTable | null)[];
  readonly draft: (BetterLootTable | null)[];
  readonly error: (string | null)[];
  readonly loading: boolean[];
  readonly revision: (string | null)[];
}

function recording(): Recording {
  const saved: (BetterLootTable | null)[] = [];
  const draft: (BetterLootTable | null)[] = [];
  const error: (string | null)[] = [];
  const loading: boolean[] = [];
  const revision: (string | null)[] = [];

  return {
    sink: {
      setSaved: (table) => saved.push(table),
      setDraft: (table) => draft.push(table),
      setRevision: (value) => revision.push(value),
      setError: (message) => error.push(message),
      setLoading: (value) => loading.push(value),
    },
    saved,
    draft,
    error,
    loading,
    revision,
  };
}

/** Uma resposta que só chega quando o teste mandar. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  const box: {
    resolve?: (value: T) => void;
    reject?: (cause: unknown) => void;
  } = {};

  const promise = new Promise<T>((ok, fail) => {
    box.resolve = ok;
    box.reject = fail;
  });

  return {
    promise,
    resolve: (value) => box.resolve?.(value),
    reject: (cause) => box.reject?.(cause),
  };
}

/**
 * Uma caixa lida, com a impressão que o "Gravar" devolve.
 *
 * O conteúdo do sha não importa aqui: o que estes testes guardam é
 * que ele ANDA JUNTO com a caixa — guardar a revisão de uma e o
 * conteúdo de outra é o estado que a revisão existe para impedir.
 */
function read(table: BetterLootTable): ReadTable {
  return { table, revision: `sha-de-${table.prefab}` };
}

describe('readTableInto', () => {
  it('a caixa que volta a tempo abre na tela', async () => {
    const seq: Sequence = { current: 0 };
    const sink = recording();
    const elite = tableOf('crate_elite');

    await readTableInto(seq, () => Promise.resolve(read(elite)), sink.sink);

    expect(sink.saved).toEqual([elite]);
    expect(sink.draft).toEqual([elite]);
    expect(sink.loading).toEqual([true, false]);
    expect(sink.error).toEqual([null]);
  });

  // ####  O DEFEITO QUE BLOQUEOU A ENTREGA  ####
  //
  // A resposta do servidor ANTERIOR não pode encostar em nada: nem
  // no rascunho, que o "Gravar" mandaria para o servidor de agora,
  // nem no aviso de "Lendo a caixa…", que ainda é da leitura nova.
  it('a resposta do servidor anterior não altera o estado depois da troca', async () => {
    const seq: Sequence = { current: 0 };
    const sink = recording();
    const old = deferred<ReadTable>();

    const reading = readTableInto(seq, () => old.promise, sink.sink);

    // O admin troca de servidor: o painel invalida o que está no ar.
    openRequest(seq);

    old.resolve(read(tableOf('crate_do_servidor_anterior')));
    await reading;

    expect(sink.saved).toEqual([]);
    expect(sink.draft).toEqual([]);
    // O `false` do `finally` também é escrita, e também não sai.
    expect(sink.loading).toEqual([true]);
  });

  // Uma tabela de 211 entradas demora mais que uma de 3: a resposta
  // da GRANDE chega por último e sobrescreveria a pequena, deixando
  // a tela com uma caixa e o nome de outra selecionado ao lado.
  it('de duas caixas clicadas rápido, só a última pedida escreve', async () => {
    const seq: Sequence = { current: 0 };
    const sink = recording();
    const big = deferred<ReadTable>();
    const small = deferred<ReadTable>();

    const first = readTableInto(seq, () => big.promise, sink.sink);
    const second = readTableInto(seq, () => small.promise, sink.sink);

    // Fora de ordem de propósito: a grande responde por último.
    small.resolve(read(tableOf('crate_normal')));
    await second;
    big.resolve(read(tableOf('crate_elite')));
    await first;

    expect(sink.draft).toEqual([tableOf('crate_normal')]);
    expect(sink.loading).toEqual([true, true, false]);
  });

  it('o erro de uma leitura vencida não pinta erro na tela', async () => {
    const seq: Sequence = { current: 0 };
    const sink = recording();
    const old = deferred<ReadTable>();

    const reading = readTableInto(seq, () => old.promise, sink.sink);

    openRequest(seq);

    old.reject(new Error('o disco daquele servidor sumiu'));
    await reading;

    // Só o `null` da abertura, e nenhuma mensagem.
    expect(sink.error).toEqual([null]);
    expect(sink.saved).toEqual([]);
  });

  it('o erro da leitura que vale limpa a caixa e diz o motivo', async () => {
    const seq: Sequence = { current: 0 };
    const sink = recording();

    await readTableInto(
      seq,
      () => Promise.reject(new Error('BetterLoot não está instalado ali')),
      sink.sink,
    );

    expect(sink.saved).toEqual([null]);
    expect(sink.draft).toEqual([null]);
    expect(sink.error).toEqual([null, 'BetterLoot não está instalado ali']);
    expect(sink.loading).toEqual([true, false]);
  });
});

describe('joinRequest', () => {
  // ####  UM PUT NÃO PODE CORTAR UMA LEITURA  ####
  //
  // Quem apaga o "Lendo a caixa…" é o `finally` da leitura, e ele
  // confere o contador antes. Se a gravação abrisse pedido, o aviso
  // ficaria preso na tela para sempre.
  it('a gravação entra na fila sem cortar a leitura que está no ar', async () => {
    const seq: Sequence = { current: 0 };
    const sink = recording();
    const box = deferred<ReadTable>();

    const reading = readTableInto(seq, () => box.promise, sink.sink);

    const ticket = joinRequest(seq);

    box.resolve(read(tableOf('crate_elite')));
    await reading;

    expect(sink.draft).toEqual([tableOf('crate_elite')]);
    expect(sink.loading).toEqual([true, false]);
    expect(isLatest(seq, ticket)).toBe(true);
  });

  // A gravação valeu no disco; o que ela não pode é repovoar o
  // rascunho de uma tela que já mudou de caixa ou de servidor.
  it('a gravação deixa de valer quando outra caixa abre no meio', () => {
    const seq: Sequence = { current: 0 };
    const ticket = joinRequest(seq);

    openRequest(seq);

    expect(isLatest(seq, ticket)).toBe(false);
  });
});
