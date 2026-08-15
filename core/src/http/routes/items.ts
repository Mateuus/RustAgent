// ============================================================
//  routes/items.ts  -  o catálogo de itens do jogo.
//
//      GET  /api/items              a lista, paginada
//      GET  /api/items/categories   as categorias que existem
//      GET  /api/items/:shortname   um item
//      POST /api/items/refresh      força a releitura
//
//  ####  ELA RESPONDE COM O SERVIDOR DESLIGADO  ####
//
//  É a razão de a tabela existir. `origemz.items` só responde com
//  um servidor no ar, e montar um kit ou uma entrega é trabalho de
//  madrugada. Nenhuma rota daqui fala com o RCON — exceto o
//  `refresh`, que é justamente o pedido explícito de ir lá.
//
//  ####  A RESPOSTA DIZ DE QUANDO É O CATÁLOGO  ####
//
//  `protocol`, `updatedAt`, `total` e `source` vão em TODA leitura.
//  Uma tela que mostra 1252 itens sem dizer que eles são de três
//  versões atrás é uma tela que mente — e a diferença entre "isto
//  está sendo conferido agora" e "isto é a última coisa que deu
//  para ler" muda o que quem administra faz em seguida.
//
//  ####  BANCO VAZIO NÃO É ERRO  ####
//
//  Instalação nova, nenhum servidor no ar: 200, lista vazia e uma
//  frase dizendo que o catálogo se preenche quando o primeiro
//  servidor subir. Um 404 ou um 503 aqui faria a tela parecer
//  quebrada num estado que é normal.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ItemRecord, ItemsRepository } from '../../db/items-repository.js';
import type { ItemCatalog } from '../../game/item-catalog.js';
import { ApiError } from '../error-response.js';

export interface ItemRoutesDeps {
  readonly repository: ItemsRepository;
  readonly catalog: ItemCatalog;
}

/**
 * Teto de uma página.
 *
 * O catálogo inteiro são ~1250 itens, então 200 dá seis páginas —
 * e uma tela que pedisse tudo de uma vez estaria pedindo 1250
 * linhas de tabela para o navegador desenhar.
 */
export const MAX_ITEMS_LIMIT = 200;
export const DEFAULT_ITEMS_LIMIT = 50;

const listQuery = z.object({
  /** Trecho de shortname ou de nome de exibição. */
  q: z.string().optional(),
  category: z.string().optional(),
  /** `1` = só o que sumiu do jogo; `0` = só o que existe. */
  removed: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ITEMS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * O shortname tem ponto (`rifle.ak`), e isso é normal na URL.
 *
 * `z.string()` e nada além: quem decide se ele existe é a tabela,
 * e um regex aqui recusaria em silêncio um item que o jogo criasse
 * com um caractere que ninguém previu.
 */
const shortnameParams = z.object({ shortname: z.string().min(1) });

export function registerItemRoutes(app: FastifyInstance, deps: ItemRoutesDeps): void {
  /**
   * As categorias, com quantos itens cada uma tem.
   *
   * Registrada ANTES da rota de `:shortname` por clareza — o
   * Fastify prefere o caminho estático de qualquer jeito, mas ler
   * o arquivo na ordem em que ele resolve poupa a dúvida.
   */
  app.get('/items/categories', async () => {
    return { ok: true, ...describe(deps), categories: deps.repository.categories() };
  });

  app.get('/items', async (request) => {
    const { q, category, removed, limit, offset } = listQuery.parse(request.query);

    const page = deps.repository.list({
      query: q,
      category,
      removed: removed === undefined ? undefined : removed === '1',
      limit: limit ?? DEFAULT_ITEMS_LIMIT,
      offset: offset ?? 0,
    });

    return {
      ok: true,
      // `count` é o que veio nesta página; `total` é o que casou
      // com o filtro. Sem os dois, a tela não distingue "acabou" de
      // "tem mais, e você está no fim da página".
      count: page.items.length,
      total: page.total,
      items: page.items.map(toItemBody),
      ...describe(deps),
    };
  });

  app.get('/items/:shortname', async (request) => {
    const { shortname } = shortnameParams.parse(request.params);

    const item = deps.repository.get(shortname);

    if (item === null) {
      throw new ApiError(
        'ITEM_NOT_FOUND',
        `Nenhum item com o shortname "${shortname}" no catálogo do agente. Ele é lido do jogo — ` +
          'um item que nunca esteve em nenhum servidor desta rede não tem linha aqui.',
        404,
      );
    }

    return { ok: true, item: toItemBody(item), ...describe(deps) };
  });

  /**
   * Relê o catálogo do jogo, agora.
   *
   * ####  ELE PRECISA DE UM SERVIDOR NO AR  ####
   *
   * E recusa com 409 quando não há nenhum, com a frase que diz por
   * quê — quem clicou merece a diferença entre "não deu para
   * perguntar" e "perguntei e o plugin recusou". Ver
   * `ItemCatalog.refresh`.
   *
   * A rodada é tudo-ou-nada: falhando no meio, nada é gravado e o
   * catálogo anterior continua respondendo.
   */
  app.post('/items/refresh', async (request) => {
    const scan = await deps.catalog.refresh();

    request.log.info(
      { present: scan.present, added: scan.added, removed: scan.removed },
      'catálogo de itens relido a pedido do painel',
    );

    return { ok: true, scan, ...describe(deps) };
  });
}

/**
 * De quando é o catálogo, e de onde ele está vindo.
 *
 * Vai em toda resposta de leitura — ver o cabeçalho.
 */
function describe(deps: ItemRoutesDeps): {
  readonly catalog: {
    readonly protocol: string | null;
    readonly updatedAt: string | null;
    readonly total: number;
    readonly source: 'servidor' | 'banco';
    readonly note: string | null;
  };
} {
  const state = deps.repository.state();
  const online = deps.catalog.isServerOnline;

  return {
    catalog: {
      protocol: state.protocol,
      // ISO na borda HTTP; epoch ms no banco. Ver as convenções de
      // db/migrations.ts.
      updatedAt: state.scannedAt === null ? null : new Date(state.scannedAt).toISOString(),
      total: state.total,
      // `servidor` = há um servidor no ar agora, e o catálogo está
      // sendo conferido a cada reconexão. `banco` = esta é a última
      // leitura que deu certo, e ninguém está confirmando nada.
      source: online ? 'servidor' : 'banco',
      note: noteFor(state.total, online),
    },
  };
}

/**
 * A frase que explica o estado, quando ele precisa de explicação.
 *
 * `null` no caso normal: um catálogo cheio com servidor no ar não
 * tem o que justificar, e uma frase ali seria ruído em toda
 * resposta.
 */
function noteFor(total: number, online: boolean): string | null {
  if (total === 0) {
    return online
      ? 'O catálogo ainda não foi lido deste servidor. Ele se preenche sozinho na primeira ' +
          'conexão do RCON — ou agora, em Atualizar.'
      : 'O catálogo é preenchido quando o primeiro servidor subir: a lista de itens vem do jogo, ' +
          'e só um servidor no ar sabe dizer quais existem.';
  }

  return online
    ? null
    : 'Nenhum servidor está no ar. Esta é a última leitura que deu certo — ela continua valendo, ' +
        'e é conferida sozinha quando um servidor voltar.';
}

/** Um item, na forma que a API entrega. Datas em ISO. */
function toItemBody(item: ItemRecord): {
  readonly shortname: string;
  readonly displayName: string;
  readonly itemId: number;
  readonly category: string;
  readonly maxStack: number;
  readonly hasCondition: boolean;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly removed: boolean;
} {
  return {
    shortname: item.shortname,
    displayName: item.displayName,
    itemId: item.itemId,
    category: item.category,
    maxStack: item.maxStack,
    hasCondition: item.hasCondition,
    firstSeen: new Date(item.firstSeen).toISOString(),
    lastSeen: new Date(item.lastSeen).toISOString(),
    // O jogo não lista mais este item. A linha continua aqui de
    // propósito: um kit do mês passado aponta para ela. Ver o
    // cabeçalho da migração 007.
    removed: item.removed,
  };
}
