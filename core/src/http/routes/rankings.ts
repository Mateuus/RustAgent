// ============================================================
//  routes/rankings.ts  -  o ranking, do lado de fora.
//
//  LEITURA — é o que o site consome (Docs/Ranking/20 §12):
//
//      GET    /rankings/metrics             o catálogo
//      GET    /rankings                     a lista, paginada
//      GET    /rankings/records             os recordes, com o testemunho
//      GET    /rankings/periods             o histórico das janelas
//      GET    /rankings/periods/:id         uma janela e o pódio congelado
//      GET    /rankings/settings            a janela de um servidor
//      GET    /rankings/audit               emitidos × convertidos, por dia
//      GET    /players/:steamId/rankings    as posições DELE
//
//  CONFIGURAÇÃO E AÇÃO — o painel:
//
//      POST   /rankings/metrics             cria um ranking dinâmico. 201
//      PUT    /rankings/metrics/order       reordena o catálogo inteiro
//      PUT    /rankings/metrics/:id         edita
//      DELETE /rankings/metrics/:id         apaga
//      PUT    /rankings/settings/:serverId  configura a janela
//      POST   /rankings/periods/:id/close   fecha um período à mão
//      POST   /servers/:id/rankings/season  fecha a temporada e abre a seguinte
//      POST   /servers/:id/rankings/flush   força um ciclo de coleta. 202
//      POST   /rankings/:steamId/reset      zera, com autor e motivo
//
//  ####  A REGRA MORA NO SERVIÇO; AQUI É SÓ A BORDA  ####
//
//  Este arquivo valida a entrada, chama o `RankingsService` e
//  traduz a resposta. Nenhuma decisão de ranking acontece aqui — o
//  K/D, o corte de amostra, "esta métrica não soma na rede" e
//  "este escopo nunca mediu nada" são todos de lá, e as frases de
//  erro vêm de lá inteiras. Uma rota que reescrevesse a frase do
//  serviço produziria duas explicações para o mesmo problema.
//
//  As três exceções — as regras que NASCEM aqui, porque só a rota
//  tem os dados para vê-las — estão marcadas no corpo:
//
//    1. `RANKING_IN_USE`: apagar um ranking para o qual um item
//       custom aponta. Quem conhece o cadastro de itens é a rota;
//    2. a trava de `periodId` da virada de temporada, que é o que
//       impede um clique duplo de abrir duas;
//    3. `RANKING_COLLECTOR_OFF`: pedir um ciclo de coleta a um
//       agente que não tem coletor ligado.
//
//  ####  AS DATAS SAEM EM ISO, E UMA DELAS NÃO ESTAVA EM MS  ####
//
//  Tudo que é instante atravessa a borda como ISO 8601, como no
//  resto da API. Atenção ao `at` do RECORDE: no banco ele é epoch
//  em SEGUNDOS (é a coluna de `player_records`), enquanto todo o
//  resto é em milissegundos. Multiplicar por mil está numa função
//  só, `toRecordBody` — errar isso deslocaria o testemunho do tiro
//  para 1970 sem nenhum erro no caminho.
//
//  ####  E TODA LISTA CARREGA OS TRÊS CAMPOS DO §9.2  ####
//
//    measuredSince  desde quando aquilo é medido;
//    coverage       quem estava coletando — "zero" e "não consegui
//                   perguntar" são respostas diferentes;
//    updatedAt      do último lote aplicado.
//
//  Ver Docs/Ranking/20-PLANO-E-CONTRATOS.md §9 e Docs/06-API.md.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { assertSteamId } from '../../bans/service.js';
import type { CustomItemsRepository } from '../../db/custom-items-repository.js';
import {
  DEFAULT_RANKING_SETTINGS,
  type RankingEntry,
  type RankingRecord,
  type RankingSettings,
  type RecordEntry,
  type SnapshotEntry,
  type StatPeriod,
} from '../../db/rankings-repository.js';
import {
  coverageMessageOf,
  DEFAULT_RANKING_LIMIT,
  MAX_RANKING_LIMIT,
  type CoverageReport,
  type PeriodView,
  type RankingsService,
  type RankingServers,
} from '../../rankings/service.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

/**
 * Quem força um ciclo de coleta agora.
 *
 * Uma interface mínima, e opcional, porque o coletor é outra
 * frente: enquanto ele não existe, a rota de `flush` recusa com
 * nome (`RANKING_COLLECTOR_OFF`) em vez de responder 202 para um
 * ciclo que nunca vai acontecer. Ver Docs/Ranking/20 §6.4.
 */
export interface RankingCollector {
  /** Uma rodada completa naquele servidor. Ver §6.4. */
  flush(serverId: string): Promise<unknown>;
}

export interface RankingRoutesDeps {
  readonly service: RankingsService;
  /**
   * Os servidores que este agente cuida.
   *
   * Serve para recusar um id que não existe com `UNKNOWN_SERVER`
   * ANTES de perguntar ao banco de ranking — senão a resposta
   * seria "este servidor nunca mediu nada", que manda procurar o
   * problema no lugar errado.
   */
  readonly servers: RankingServers;
  /**
   * O cadastro de itens custom.
   *
   * Ele está aqui por uma pergunta só: algum item dá pontos na
   * métrica deste ranking? É o `RANKING_IN_USE`, e o repositório
   * de ranking não tem como respondê-la — ver
   * `db/rankings-repository.ts:722-729`.
   */
  readonly customItems: CustomItemsRepository;
  /** Quem força o ciclo de coleta. Ausente = a coleta não está ligada. */
  readonly collector?: RankingCollector | undefined;
}

// ------------------------------------------------------------
//  Os schemas
// ------------------------------------------------------------

const scopeSchema = z.enum(['server', 'global']);
const periodKindSchema = z.enum(['wipe', 'season', 'lifetime']);
const seasonModeSchema = z.enum(['wipe', 'biweekly', 'monthly', 'quarterly', 'days', 'manual']);

/**
 * O formato da métrica: `familia.nome`, minúsculo.
 *
 * É o mesmo do cadastro de item custom
 * (`routes/custom-items.ts:135`), e é de propósito: os dois lados
 * escrevem a MESMA string, e uma diferença de régua faria o item
 * apontar para um ranking que existe com outro nome.
 */
const METRIC_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

const metricSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(METRIC_PATTERN, 'A métrica é minúscula, no formato "familia.nome".');

/** O teto e o padrão são do módulo de regra. Ver `rankings/service.ts`. */
const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_RANKING_LIMIT, `O máximo por página é ${String(MAX_RANKING_LIMIT)}.`)
  .default(DEFAULT_RANKING_LIMIT);

const offsetSchema = z.coerce.number().int().min(0).default(0);

const listQuery = z.object({
  metric: metricSchema,
  scope: scopeSchema.optional(),
  serverId: z.string().min(1).optional(),
  period: periodKindSchema.optional(),
  /** Sobrepõe `period`. É como se lê uma temporada FECHADA. */
  periodId: z.coerce.number().int().positive().optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

const catalogQuery = z.object({
  /** `1` = só os ligados. É o que a tela do jogo pede. */
  enabled: z.enum(['0', '1']).optional(),
});

const periodsQuery = z.object({
  serverId: z.string().min(1).optional(),
  kind: periodKindSchema.optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

const auditQuery = z.object({
  serverId: z.string().min(1).optional(),
  metric: metricSchema.optional(),
  /** ISO, ou epoch em ms. A conversão para a coluna é lá embaixo. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

const playerQuery = z.object({
  serverId: z.string().min(1).optional(),
  scope: scopeSchema.optional(),
});

const settingsQuery = z.object({ serverId: z.string().min(1) });

/** Ver o cabeçalho de `players.ts`: `z.string()`, e nunca `z.number()`. */
const steamParams = z.object({ steamId: z.string().min(1) });
const idParams = z.object({ id: z.string().min(1) });
const numericIdParams = z.object({ id: z.coerce.number().int().positive() });
const serverParams = z.object({ serverId: z.string().min(1) });

/**
 * A definição de um ranking dinâmico.
 *
 * `builtin` não está aqui: ele nasce `0` e não se digita. Um
 * ranking que se declarasse builtin pela API teria o botão de
 * apagar recusado para sempre, sem ninguém entender por quê.
 */
const rankingBody = z.object({
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'O identificador é minúsculo, com letras, números e hífen — ele aparece na URL.',
    ),
  metric: metricSchema,
  label: z.string().trim().min(1).max(80),
  /**
   * O nome que cabe na aba do jogo. Vazio = usa o `label`.
   *
   * O teto é 24 e não 80 de propósito: ele existe por causa da
   * largura da coluna da tela do jogo, e um "nome curto" de
   * sessenta caracteres não é curto — o campo deixaria de resolver
   * o problema para o qual foi criado sem ninguém perceber.
   */
  shortLabel: z.string().trim().max(24).nullable().default(null),
  unit: z.string().trim().max(30).nullable().default(null),
  description: z.string().trim().max(300).nullable().default(null),
  source: z.enum(['plugin', 'agent', 'item', 'computed']),
  valueKind: z.enum(['counter', 'record', 'ratio']),
  direction: z.enum(['desc', 'asc']).default('desc'),
  /** Em que janela ele DISPUTA. Ver Docs/Ranking/20 §3.1. */
  window: periodKindSchema.default('season'),
  globalEligible: z.boolean().default(true),
  enabled: z.boolean().default(true),
  /**
   * Aparece no menu do jogo? Padrão: sim.
   *
   * Não confundir com `enabled`: desligado, o ranking some de todo
   * lugar; com isto em `false`, ele some só do menu do jogo — onde
   * o espaço é caro — e continua contando, no painel e no site.
   */
  showInGame: z.boolean().default(true),

  /**
   * A posição na lista — **opcional, e sem default**.
   *
   * ####  QUEM MANDA NA ORDEM É O ARRASTO  ####
   *
   * A tela reordena arrastando, por `PUT /metrics/order`. Um
   * default aqui faria todo ranking novo nascer com o mesmo
   * número — todos empatados —, e mandar o campo num PUT de
   * edição desfaria, sem ninguém pedir, um arrasto feito no
   * intervalo entre a tela carregar e o botão ser clicado.
   *
   * Ausente na criação = entra no fim. Ausente na edição = fica
   * onde está.
   */
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

/**
 * A ordem do catálogo, inteira.
 *
 * `min(1)` porque reordenar nada é um pedido sem sentido, e o
 * silêncio de um 200 para uma lista vazia esconderia uma tela que
 * mandou o que não devia. O resto da conferência — a lista tem de
 * conter EXATAMENTE os rankings que existem — é do repositório,
 * que é quem os conhece.
 */
const orderBody = z.object({
  ids: z.array(z.string().min(1).max(60)).min(1),
});

const settingsBody = z
  .object({
    seasonMode: seasonModeSchema,
    seasonDays: z.number().int().min(1).max(365).nullable().default(null),
    /** De onde `biweekly` e `days` contam. ISO, ou epoch em ms. */
    seasonAnchorAt: z.coerce.date().nullable().default(null),
    seasonOnWipe: z.boolean().default(DEFAULT_RANKING_SETTINGS.seasonOnWipe),
    snapshotSize: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(DEFAULT_RANKING_SETTINGS.snapshotSize),
  })
  .superRefine((value, ctx) => {
    // Uma janela `days` sem tamanho não vence nunca (ver
    // `rankings/periods.ts:159-166`): a temporada ficaria aberta
    // para sempre, e a tela mostraria uma configuração que parece
    // válida. Recusar aqui é dizer isso na hora de salvar.
    if (value.seasonMode === 'days' && (value.seasonDays ?? 0) < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['seasonDays'],
        message: 'Com a temporada em "days" é preciso dizer de quantos dias ela é.',
      });
    }
  });

const closeBody = z.object({
  label: z.string().trim().min(1).max(120).nullable().default(null),
});

const seasonBody = z.object({
  label: z.string().trim().min(1).max(120).nullable().default(null),
  /**
   * A temporada que quem clicou estava vendo aberta.
   *
   * Opcional, e é a trava de idempotência do §9.1: com ela, o
   * segundo clique no mesmo botão recusa em vez de abrir uma
   * terceira temporada.
   */
  periodId: z.number().int().positive().optional(),
  reason: z
    .string()
    .trim()
    .min(1, 'Diga por que a temporada está virando — o motivo vai para o log do agente.')
    .max(200),
});

const resetBody = z
  .object({
    /** Ausente = zera TODAS as métricas do jogador naquela janela. */
    metric: metricSchema.nullable().default(null),
    periodId: z.number().int().positive().optional(),
    /** O outro jeito de dizer a janela: o servidor, e qual delas. */
    serverId: z.string().min(1).optional(),
    period: periodKindSchema.default('season'),
    reason: z
      .string()
      .trim()
      .min(1, 'Diga por que está zerando — o motivo fica gravado com o seu nome.')
      .max(200),
  })
  .superRefine((value, ctx) => {
    if (value.periodId === undefined && value.serverId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Diga em qual janela zerar: mande "periodId", ou "serverId" (com "period", que é ' +
          '"season" por padrão).',
      });
    }
  });

// ------------------------------------------------------------
//  As rotas
// ------------------------------------------------------------

export function registerRankingRoutes(app: FastifyInstance, deps: RankingRoutesDeps): void {
  // ---- leitura --------------------------------------------
  //
  // As estáticas vêm antes das de `:id` por clareza — o Fastify
  // prefere o caminho estático de qualquer jeito, mas ler o
  // arquivo na ordem em que ele resolve poupa a dúvida.

  /**
   * O catálogo: o que existe, e como cada um se comporta.
   *
   * Ele responde com todos os servidores parados, e é de
   * propósito: a definição é do agente, não do jogo.
   */
  app.get('/rankings/metrics', async (request) => {
    const { enabled } = catalogQuery.parse(request.query);

    const rankings = deps.service.metrics(enabled === '1' ? { enabledOnly: true } : {});

    return { ok: true, count: rankings.length, rankings: rankings.map(toRankingBody) };
  });

  /** Os recordes, com o testemunho de cada um. */
  app.get('/rankings/records', async (request) => {
    const query = listQuery.parse(request.query);
    const page = await deps.service.records(query);

    return {
      ok: true,
      count: page.entries.length,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      ranking: toRankingBody(page.ranking),
      scope: page.scope,
      period: toPeriodViewBody(page.period),
      measuredSince: toIso(page.measuredSince),
      updatedAt: toIso(page.updatedAt),
      coverage: toCoverageBody(page.coverage),
      entries: page.entries.map(toRecordBody),
    };
  });

  /** O histórico: as janelas, do mais novo ao mais velho. */
  app.get('/rankings/periods', async (request) => {
    const query = periodsQuery.parse(request.query);
    const page = deps.service.periods(query);

    return {
      ok: true,
      count: page.periods.length,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
      periods: page.periods.map(toPeriodBody),
    };
  });

  /**
   * Uma janela, e o pódio CONGELADO dela.
   *
   * O valor de lá não muda mais — pode ser cacheado sem prazo, e é
   * essa a diferença que faz o histórico responder amanhã o que
   * responde hoje.
   */
  app.get('/rankings/periods/:id', async (request) => {
    const { id } = numericIdParams.parse(request.params);
    const detail = deps.service.periodDetail(id);

    return {
      ok: true,
      period: toPeriodBody(detail.period),
      podium: detail.podium.map((item) => ({
        metric: item.metric,
        label: item.label,
        entries: item.entries.map(toSnapshotBody),
      })),
    };
  });

  /**
   * A janela configurada de um servidor.
   *
   * Vem com a temporada mais recente junto porque é a mesma tela
   * (§10, tela 4): "de quanto em quanto tempo" e "qual é a de
   * agora" são a mesma pergunta feita duas vezes.
   *
   * QUANDO ela vira não sai daqui: a conta de fuso mora em
   * `rankings/periods.ts` e chega à tela pelo `period.turnsAt` de
   * `GET /rankings`. Repeti-la aqui seria a segunda conta de fuso
   * do projeto, e a segunda é a que diverge no primeiro ajuste.
   */
  app.get('/rankings/settings', async (request) => {
    const { serverId } = settingsQuery.parse(request.query);

    requireServer(deps, serverId);

    const season = latestSeasonOf(deps, serverId);

    return {
      ok: true,
      serverId,
      settings: toSettingsBody(deps.service.settingsOf(serverId)),
      season: season === null ? null : toPeriodBody(season),
    };
  });

  /**
   * A conta do §2.4: quantos eventos entraram, por dia e por
   * fonte, e quanto eles somaram.
   *
   * É o que responde "o troféu que eu dei virou ponto?" sem abrir
   * o banco — e a resposta é uma conta, não uma amostra.
   */
  app.get('/rankings/audit', async (request) => {
    const query = auditQuery.parse(request.query);

    const rows = deps.service.audit({
      serverId: query.serverId,
      metric: query.metric,
      // A coluna `at` de `stat_events` é epoch em SEGUNDOS.
      from: toEpochSeconds(query.from),
      to: toEpochSeconds(query.to),
    });

    // A consulta agrega por dia e devolve tudo; a página é
    // recortada aqui. É paginação de verdade para quem consome, e
    // sem uma segunda consulta de contagem.
    const page = rows.slice(query.offset, query.offset + query.limit);

    return {
      ok: true,
      count: page.length,
      total: rows.length,
      limit: query.limit,
      offset: query.offset,
      rows: page,
    };
  });

  /**
   * A lista, paginada — a rota que o site consome.
   *
   * A ordem de desempate é do banco (valor, quem chegou primeiro,
   * `steam_id`), e é ela que faz a página 2 continuar a página 1
   * em vez de repetir e perder jogadores empatados. Ver §9.3.
   */
  app.get('/rankings', async (request) => {
    const query = listQuery.parse(request.query);
    const page = await deps.service.leaderboard(query);

    return {
      ok: true,
      // `count` é o que veio nesta página; `total` é o tamanho da
      // lista inteira. Sem os dois, a tela não distingue "acabou"
      // de "tem mais, e você está no fim da página".
      count: page.entries.length,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      ranking: toRankingBody(page.ranking),
      scope: page.scope,
      period: toPeriodViewBody(page.period),
      /** A lista veio do pódio congelado? Aí ela não muda mais. */
      frozen: page.frozen,
      measuredSince: toIso(page.measuredSince),
      updatedAt: toIso(page.updatedAt),
      coverage: toCoverageBody(page.coverage),
      entries: page.entries.map(toEntryBody),
    };
  });

  /**
   * As posições DELE, ranking a ranking.
   *
   * Um ranking em que ele não pontuou vem com `position: null`, e
   * não com o último lugar: "sem número" e "em último" são coisas
   * diferentes, e a segunda ofende quem nem jogou.
   */
  app.get('/players/:steamId/rankings', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    const query = playerQuery.parse(request.query);
    const rows = deps.service.playerRankings(steamId, query);

    return {
      ok: true,
      steamId,
      count: rows.length,
      rankings: rows.map((row) => ({
        ranking: toRankingBody(row.ranking),
        scope: row.scope,
        periodId: row.periodId,
        position: row.position,
        value: row.value,
        total: row.total,
      })),
    };
  });

  // ---- configuração e ação --------------------------------

  app.post('/rankings/metrics', async (request, reply) => {
    const input = rankingBody.parse(request.body);
    const created = deps.service.createMetric(input);

    request.log.info(
      { ranking: created.id, metric: created.metric, by: operatorOf(request) },
      'ranking criado pelo painel',
    );

    await reply.code(201).send({ ok: true, ranking: toRankingBody(created) });
  });

  /**
   * A ordem do catálogo, reescrita de uma vez.
   *
   * ####  ESTA ROTA VEM ANTES DA DE `:id`, E NÃO É ESTILO  ####
   *
   * `/rankings/metrics/order` casaria com `/rankings/metrics/:id`
   * se a de baixo viesse primeiro num roteador que resolve por
   * ordem de registro — e o pedido de reordenar viraria a edição
   * de um ranking chamado "order". O Fastify prefere o caminho
   * estático de qualquer jeito; a ordem no arquivo é para quem lê.
   *
   * O corpo traz a lista INTEIRA, na ordem desejada. Uma lista
   * parcial é recusada com `RANKING_ORDER_MISMATCH` (a frase é do
   * repositório): sem os ausentes, a posição deles ficaria
   * indefinida, e o defeito só apareceria na próxima vez que
   * alguém abrisse a tela.
   */
  app.put('/rankings/metrics/order', async (request) => {
    const { ids } = orderBody.parse(request.body);
    const rankings = deps.service.reorderMetrics(ids);

    request.log.info(
      { count: ids.length, by: operatorOf(request) },
      'ordem dos rankings reescrita pelo painel',
    );

    return { ok: true, count: rankings.length, rankings: rankings.map(toRankingBody) };
  });

  /**
   * Reescreve o ranking inteiro. PUT, e não PATCH — mesma regra do
   * cadastro de item custom: a tela edita num formulário só.
   *
   * O `id` é o da URL, sempre. Ele não muda com o rótulo: renomear
   * um ranking no painel não pode quebrar o item custom que aponta
   * para ele.
   */
  app.put('/rankings/metrics/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const input = rankingBody.parse(request.body);

    const saved = deps.service.updateMetric(id, { ...input, id });

    request.log.info(
      { ranking: id, metric: saved.metric, by: operatorOf(request) },
      'ranking alterado pelo painel',
    );

    return { ok: true, ranking: toRankingBody(saved) };
  });

  /**
   * Apaga um ranking dinâmico.
   *
   * Duas recusas antes: o `builtin` não sai (a frase é do
   * repositório) e um ranking para o qual um item custom aponta
   * também não — esta última nasce aqui, porque quem conhece o
   * cadastro de itens é esta camada.
   */
  app.delete('/rankings/metrics/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    assertNotInUse(deps, id);

    deps.service.removeMetric(id);

    request.log.warn({ ranking: id, by: operatorOf(request) }, 'ranking apagado pelo painel');

    return { ok: true };
  });

  app.put('/rankings/settings/:serverId', async (request) => {
    const { serverId } = serverParams.parse(request.params);
    const body = settingsBody.parse(request.body);

    requireServer(deps, serverId);

    const saved = deps.service.saveSettings(serverId, {
      seasonMode: body.seasonMode,
      seasonDays: body.seasonDays,
      seasonAnchorAt: body.seasonAnchorAt === null ? null : body.seasonAnchorAt.getTime(),
      seasonOnWipe: body.seasonOnWipe,
      snapshotSize: body.snapshotSize,
    });

    request.log.info(
      { server: serverId, mode: saved.seasonMode, by: operatorOf(request) },
      'janela de ranking configurada pelo painel',
    );

    return { ok: true, serverId, settings: toSettingsBody(saved) };
  });

  /**
   * Fecha um período à mão, e abre o seguinte na mesma transação.
   *
   * Fechar o mesmo duas vezes devolve `RANKING_PERIOD_CLOSED` e
   * NÃO abre um terceiro: a idempotência é por período, e não por
   * requisição. A recusa é do repositório, com a frase dele.
   */
  app.post('/rankings/periods/:id/close', async (request) => {
    const { id } = numericIdParams.parse(request.params);
    const body = closeBody.parse(request.body ?? {});

    const rolled = deps.service.closePeriod(id, { label: body.label });

    request.log.warn(
      {
        period: rolled.closed.id,
        server: rolled.closed.serverId,
        kind: rolled.closed.kind,
        opened: rolled.opened.id,
        frozen: rolled.frozen,
        by: operatorOf(request),
      },
      'período de ranking fechado pelo painel',
    );

    return {
      ok: true,
      closed: toPeriodBody(rolled.closed),
      opened: toPeriodBody(rolled.opened),
      frozen: rolled.frozen,
    };
  });

  /**
   * O botão "abrir temporada nova agora".
   *
   * É o mesmo caminho da virada automática, de propósito: um botão
   * que fecha a temporada por um caminho próprio é um botão que um
   * dia congela o pódio de um jeito diferente do sweep.
   */
  app.post('/servers/:id/rankings/season', async (request) => {
    // `:id` como em toda rota de servidor deste projeto — o nome
    // do parâmetro é o mesmo para o Fastify casar a família de
    // caminhos sem surpresa.
    const { id: serverId } = idParams.parse(request.params);
    const body = seasonBody.parse(request.body);

    requireServer(deps, serverId);
    assertSeasonNotTurned(deps, serverId, body.periodId);

    const rolled = deps.service.openNewSeason(serverId, { label: body.label });

    request.log.warn(
      {
        server: serverId,
        closed: rolled.closed.id,
        opened: rolled.opened.id,
        frozen: rolled.frozen,
        reason: body.reason,
        by: operatorOf(request),
      },
      'temporada de ranking virada pelo painel',
    );

    return {
      ok: true,
      closed: toPeriodBody(rolled.closed),
      opened: toPeriodBody(rolled.opened),
      frozen: rolled.frozen,
    };
  });

  /**
   * Força um ciclo de coleta agora. 202, e não 200.
   *
   * O ciclo fala com o jogo pelo RCON e pode levar segundos; quem
   * clicou não espera por isso. A resposta diz "aceitei", e o
   * resultado aparece no `updatedAt` da lista seguinte.
   */
  app.post('/servers/:id/rankings/flush', async (request, reply) => {
    const { id: serverId } = idParams.parse(request.params);

    requireServer(deps, serverId);

    const collector = deps.collector;

    if (collector === undefined) {
      throw new ApiError(
        'RANKING_COLLECTOR_OFF',
        'A coleta de ranking não está ligada neste agente: não há ciclo para forçar. Os números ' +
          'que já foram coletados continuam sendo respondidos normalmente.',
        503,
      );
    }

    // Sem `await`: um servidor ocupado não pode segurar a resposta
    // de quem clicou. E com `catch`, porque uma promessa rejeitada
    // sem dono derruba o processo inteiro.
    void collector.flush(serverId).catch((error: unknown) => {
      request.log.warn({ err: error, server: serverId }, 'o ciclo de coleta pedido falhou');
    });

    request.log.info({ server: serverId, by: operatorOf(request) }, 'ciclo de coleta pedido');

    await reply.code(202).send({ ok: true, server: serverId });
  });

  /**
   * Zera o jogador naquela janela, com autor e motivo.
   *
   * ####  ELE NÃO APAGA A LINHA: ELE REGISTRA O ESTORNO  ####
   *
   * Cada métrica zerada vira uma linha em `stat_adjustments` com o
   * valor antigo, o novo, quem mandou e por quê. Um ranking
   * premiado em que alguém pode zerar um número sem deixar rastro
   * é um ranking que não sustenta a primeira contestação.
   */
  app.post('/rankings/:steamId/reset', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    const body = resetBody.parse(request.body);

    // Métrica fora do catálogo é recusa com nome, e a frase é do
    // serviço. Sem esta linha, zerar uma métrica que não existe
    // responderia "0 linhas" — que parece sucesso.
    if (body.metric !== null) {
      deps.service.requireMetric(body.metric);
    }

    const periodId = body.periodId ?? openPeriodIdOf(deps, body.serverId, body.period);
    const actor = operatorOf(request) ?? 'desconhecido';

    const changed = deps.service.resetPlayer({
      steamId,
      periodId,
      metric: body.metric,
      actor,
      reason: body.reason,
    });

    request.log.warn(
      { steamId, period: periodId, metric: body.metric, rows: changed, reason: body.reason, by: actor },
      'ranking de um jogador zerado pelo painel',
    );

    return { ok: true, steamId, periodId, metric: body.metric, reset: changed };
  });
}

// ------------------------------------------------------------
//  As conferências que só a rota pode fazer
// ------------------------------------------------------------

/**
 * O servidor existe neste agente?
 *
 * Só nas rotas que MEXEM num servidor, e na de configuração. As de
 * leitura não passam por aqui de propósito: o histórico de um
 * servidor que saiu da lista continua sendo uma pergunta legítima,
 * e responder 404 a ela esconderia dado que está lá.
 */
function requireServer(deps: RankingRoutesDeps, serverId: string): void {
  if (!deps.servers.ids().includes(serverId)) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${serverId}" neste agente. Os que existem: ` +
        `${deps.servers.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }
}

/**
 * Apagar um ranking para o qual um item custom aponta.
 *
 * ####  POR QUE A RECUSA NASCE AQUI  ####
 *
 * Um item que concede pontos a uma métrica que não existe mais
 * converteria o item em NADA: o jogador perde o item e não ganha
 * ponto — o pior desfecho possível. Quem sabe perguntar ao
 * cadastro de itens é esta camada, e é por isso que o repositório
 * de ranking manda a pergunta para cá
 * (`db/rankings-repository.ts:722-729`).
 *
 * A frase diz QUAL item colidiu, e não só que colidiu — a mesma
 * régua da marca duplicada em `custom-items.ts`.
 */
function assertNotInUse(deps: RankingRoutesDeps, id: string): void {
  const ranking = deps.service.metrics().find((item) => item.id === id);

  if (ranking === undefined) {
    // Id inexistente: quem responde 404 com a frase certa é o
    // serviço, logo em seguida. Inventar a recusa aqui seria a
    // segunda frase para o mesmo problema.
    return;
  }

  const holder = deps.customItems
    .list()
    .find((item) => item.action.kind === 'points' && item.action.metric === ranking.metric);

  if (holder !== undefined) {
    throw new ApiError(
      'RANKING_IN_USE',
      `O item "${holder.displayName}" dá pontos na métrica "${ranking.metric}", que é a deste ` +
        'ranking. Apagá-lo faria o item converter em nada: o jogador perderia o item e não ' +
        'ganharia ponto. Desligue o ranking, ou mude a ação do item antes.',
      409,
    );
  }
}

/**
 * A trava que impede o clique duplo de abrir duas temporadas.
 *
 * ####  A IDEMPOTÊNCIA É POR PERÍODO, E NÃO POR REQUISIÇÃO  ####
 *
 * `openNewSeason` fecha o que estiver aberto e abre o seguinte —
 * chamado duas vezes, ele viraria a temporada duas vezes, e a
 * segunda nasceria e morreria com o pódio vazio. Quem clicou viu
 * uma temporada na tela: mandar o `periodId` dela é dizer "vire
 * ESTA", e é o que permite recusar o segundo clique.
 *
 * Sem `periodId` no corpo não há o que travar, e a virada acontece
 * — é o caminho de um script, que sabe o que está pedindo.
 */
function assertSeasonNotTurned(
  deps: RankingRoutesDeps,
  serverId: string,
  periodId: number | undefined,
): void {
  if (periodId === undefined) {
    return;
  }

  const current = latestSeasonOf(deps, serverId);

  if (current !== null && current.id === periodId && current.endedAt === null) {
    return;
  }

  throw new ApiError(
    'RANKING_PERIOD_CLOSED',
    `A temporada ${String(periodId)} não é a temporada aberta de "${serverId}" — ela já foi ` +
      'fechada, ou nunca foi deste servidor. ' +
      (current === null
        ? 'Este servidor não tem temporada nenhuma.'
        : `A aberta agora é a ${String(current.id)}${
            current.label === null ? '' : ` ("${current.label}")`
          }.`) +
      ' Recarregue a tela antes de virar de novo.',
    409,
  );
}

/**
 * A temporada mais recente daquele servidor.
 *
 * O histórico vem do mais novo para o mais velho, e só existe uma
 * aberta por servidor (o índice único parcial garante) — então a
 * primeira da lista é a aberta, quando há alguma aberta.
 */
function latestSeasonOf(deps: RankingRoutesDeps, serverId: string): StatPeriod | null {
  return deps.service.periods({ serverId, kind: 'season', limit: 1, offset: 0 }).periods[0] ?? null;
}

/** A janela aberta daquele servidor, para o estorno. */
function openPeriodIdOf(
  deps: RankingRoutesDeps,
  serverId: string | undefined,
  kind: 'wipe' | 'season' | 'lifetime',
): number {
  if (serverId === undefined) {
    // O zod já garantiu que um dos dois campos veio; este ramo
    // existe para o tipo, e não para quem chama.
    throw new ApiError(
      'INVALID_BODY',
      'Diga em qual janela zerar: mande "periodId", ou "serverId".',
      400,
    );
  }

  requireServer(deps, serverId);

  const period = deps.service.periods({ serverId, kind, limit: 1, offset: 0 }).periods[0] ?? null;

  if (period === null || period.endedAt !== null) {
    throw new ApiError(
      'RANKING_PERIOD_NOT_FOUND',
      `O servidor "${serverId}" não tem janela "${kind}" aberta para zerar. Se o que você quer é ` +
        'mexer numa janela já fechada, mande o "periodId" dela.',
      404,
    );
  }

  return period.id;
}

// ------------------------------------------------------------
//  A tradução para a borda
// ------------------------------------------------------------

/** Epoch ms -> ISO, com o `null` sobrevivendo. */
function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** A borda fala ISO; a coluna `stat_events.at` fala segundos. */
function toEpochSeconds(value: Date | undefined): number | undefined {
  return value === undefined ? undefined : Math.floor(value.getTime() / 1000);
}

/** Um ranking, na forma que a API entrega. */
function toRankingBody(ranking: RankingRecord) {
  return {
    id: ranking.id,
    metric: ranking.metric,
    label: ranking.label,
    /**
     * O nome da aba do jogo. `null` = não tem, use o `label`.
     *
     * A tela do painel edita este campo e mostra o `label` como
     * espelho quando ele está vazio; quem quiser o nome já
     * resolvido chama `gameLabelOf` (rankings/service.ts) — a
     * regra do "vazio cai no label" mora num lugar só.
     */
    shortLabel: ranking.shortLabel,
    unit: ranking.unit,
    description: ranking.description,
    source: ranking.source,
    valueKind: ranking.valueKind,
    direction: ranking.direction,
    window: ranking.window,
    globalEligible: ranking.globalEligible,
    // O painel some com o botão de apagar quando ele é `true` — e
    // some, em vez de desabilitar: um botão que nunca funciona é
    // pior que um botão que não existe.
    builtin: ranking.builtin,
    enabled: ranking.enabled,
    /**
     * Aparece no menu do JOGO? Ele continua aqui de qualquer
     * jeito: esta resposta é a do painel, e esconder do painel o
     * que está escondido no jogo tiraria do admin justamente o
     * interruptor que ele foi ligar.
     */
    showInGame: ranking.showInGame,
    sortOrder: ranking.sortOrder,
    createdAt: toIso(ranking.createdAt),
    updatedAt: toIso(ranking.updatedAt),
  };
}

/** Uma janela do banco. */
function toPeriodBody(period: StatPeriod) {
  return {
    id: period.id,
    serverId: period.serverId,
    kind: period.kind,
    wipeId: period.wipeId,
    label: period.label,
    seasonMode: period.seasonMode,
    startedAt: toIso(period.startedAt),
    endedAt: toIso(period.endedAt),
  };
}

/**
 * A janela em que a lista foi lida.
 *
 * No escopo de rede ela não tem `id`: são várias janelas somadas, e
 * inventar uma delas como "a" janela seria mentira. O que sobrevive
 * é o `startedAt`, que ali é o da MAIS ANTIGA.
 */
function toPeriodViewBody(view: PeriodView) {
  return {
    id: view.id,
    kind: view.kind,
    serverId: view.serverId,
    label: view.label,
    seasonMode: view.seasonMode,
    startedAt: toIso(view.startedAt),
    endedAt: toIso(view.endedAt),
    /** Quando ela vira, se ninguém mexer. `null` = não tem data. */
    turnsAt: toIso(view.turnsAt),
  };
}

function toSettingsBody(settings: RankingSettings) {
  return {
    seasonMode: settings.seasonMode,
    seasonDays: settings.seasonDays,
    seasonAnchorAt: toIso(settings.seasonAnchorAt),
    seasonOnWipe: settings.seasonOnWipe,
    snapshotSize: settings.snapshotSize,
    /** `null` = o servidor nunca foi configurado; valem os padrões. */
    updatedAt: toIso(settings.updatedAt),
  };
}

/**
 * `coverage` não é um booleano. São quatro estados.
 *
 *   ok          o plugin respondeu na última rodada;
 *   never       ele está aí, mas NUNCA houve lote deste servidor;
 *   no-answer   já houve lote, e o último é velho: a coleta parou;
 *   not-loaded  o plugin de coleta não está carregado.
 *
 * Um servidor em `not-loaded` que virasse lista vazia diria que
 * ninguém pontuou ali — uma afirmação sobre os jogadores, quando a
 * verdade é sobre a coleta.
 *
 * ####  A FRASE VAI JUNTO, E NÃO SÓ O CÓDIGO  ####
 *
 * `message` é o mesmo texto que a tela do jogo desenha, vindo do
 * mesmo lugar (`COVERAGE_MESSAGES`, em rankings/service.ts). Sem
 * ele, o painel escreveria a segunda versão da mesma explicação —
 * e as duas divergiriam no primeiro ajuste, deixando o admin e o
 * jogador lendo histórias diferentes sobre o mesmo defeito.
 * `null` em `ok`: não há aviso quando não há o que avisar.
 */
function toCoverageBody(report: CoverageReport) {
  return {
    servers: report.servers.map((server) => ({
      serverId: server.serverId,
      status: server.status,
      message: coverageMessageOf(server.status),
      lastBatchAt: toIso(server.lastBatchAt),
    })),
  };
}

function toEntryBody(entry: RankingEntry) {
  return {
    position: entry.position,
    steamId: entry.steamId,
    name: entry.name,
    value: entry.value,
    updatedAt: toIso(entry.updatedAt),
  };
}

/** O recorde, com o testemunho. Ver o cabeçalho: o `at` é em SEGUNDOS. */
function toRecordBody(entry: RecordEntry) {
  return {
    position: entry.position,
    steamId: entry.steamId,
    name: entry.name,
    value: entry.value,
    at: toIso(entry.at * 1000),
    /** Arma, vítima, lugar. O que o plugin mandou junto. */
    detail: entry.detail,
  };
}

/** Uma linha do pódio congelado. */
function toSnapshotBody(entry: SnapshotEntry) {
  return {
    position: entry.position,
    steamId: entry.steamId,
    // `name` como nas listas vivas: a tela desenha as duas com o
    // mesmo componente, e um campo com dois nomes faria uma delas
    // aparecer sem nome nenhum.
    name: entry.displayName,
    value: entry.value,
    frozenAt: toIso(entry.frozenAt),
  };
}
