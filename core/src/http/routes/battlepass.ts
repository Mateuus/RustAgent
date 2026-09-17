// ============================================================
//  routes/battlepass.ts  -  a temporada, a trilha, o XP e o passe
//  de cada jogador.
//
//      GET    /battlepass/overview?serverId=          a aba Visao geral
//
//      GET    /battlepass/seasons                     a lista
//      POST   /battlepass/seasons                     cria. 201
//      GET    /battlepass/seasons/:seasonId           uma
//      PUT    /battlepass/seasons/:seasonId           edita (INTEIRA)
//      PUT    /battlepass/seasons/:seasonId/servers   troca so onde vale
//      PUT    /battlepass/seasons/:seasonId/state     publica, ativa, fecha
//      DELETE /battlepass/seasons/:seasonId           apaga
//
//      GET    /battlepass/seasons/:seasonId/track                a trilha
//      PUT    /battlepass/seasons/:seasonId/track/:level/:lane   a casa
//      DELETE /battlepass/seasons/:seasonId/track/:level/:lane   esvazia
//
//      GET    /battlepass/seasons/:seasonId/xp-rules            o cardapio ligado
//      PUT    /battlepass/seasons/:seasonId/xp-rules/:source    liga e precifica
//      DELETE /battlepass/seasons/:seasonId/xp-rules/:source    tira
//
//      GET    /battlepass/players?serverId=&cursor=   a aba Jogadores
//      GET    /battlepass/players/:steamId?serverId=  a trilha DELE
//
//      POST   /battlepass/entitlements                da o passe. 201
//      DELETE /battlepass/entitlements/:entitlementId revoga
//
//      GET    /battlepass/audit                       o registro
//
//  ####  AS REGRAS NÃO MORAM AQUI  ####
//
//  Moram em `battlepass/service.ts`, porque o resgate pelo console
//  do jogo e a entrega do site passam pelas mesmas — e uma regra
//  escrita na rota só vale para quem entra pela rota. Esta camada lê
//  o corpo, diz quem está mexendo e repassa a frase.
//
//  ####  AS DATAS SAEM EM ISO  ####
//
//  Epoch em ms é o que o banco guarda e o que ordena sem conversão;
//  a borda formata. É a convenção do projeto inteiro, e os
//  serializadores do rodapé são o único lugar que a aplica.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { BattlePassActor, BattlePassService } from '../../battlepass/service.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import {
  BATTLEPASS_LANES,
  entitlementBodySchema,
  MAX_SEASON_LEVELS,
  seasonInputSchema,
  seasonStateBodySchema,
  trackCellInputSchema,
  xpRuleInputSchema,
  xpSourceSchema,
  type BattlePassAuditEntry,
  type BattlePassClaim,
  type BattlePassSeason,
  type Entitlement,
  type PendingDelivery,
  type PlayerProgress,
  type PlayerTrack,
  type TrackCell,
  type TrackCellView,
  type XpRule,
} from '../../types/battlepass.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface BattlePassRoutesDeps {
  readonly service: BattlePassService;
  readonly servers: ServersRepository;
}

const seasonParams = z.object({ seasonId: z.coerce.number().int().positive() });
const cellParams = seasonParams.extend({
  level: z.coerce.number().int().min(1).max(MAX_SEASON_LEVELS),
  lane: z.enum(BATTLEPASS_LANES),
});
const ruleParams = seasonParams.extend({ source: xpSourceSchema });
const entitlementParams = z.object({ entitlementId: z.coerce.number().int().positive() });
const playerParams = z.object({ steamId: z.string().trim().min(1) });

const serverQuery = z.object({ serverId: z.string().min(1) });
const serversBody = z.object({ servers: z.array(z.string().min(1)).max(50) });

const boardQuery = z.object({
  serverId: z.string().min(1),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const auditQuery = z.object({
  steamId: z.string().trim().min(1).optional(),
  serverId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});

/**
 * O índice único parcial, traduzido.
 *
 * O serviço já recusa o segundo direito vivo do mesmo mês com uma
 * frase; este caminho é o da CORRIDA — duas concessões no mesmo
 * instante, uma pela loja e outra pelo painel. O banco segura a
 * segunda, e sem esta tradução ela chegaria ao admin como 500.
 */
function asApiError(cause: unknown): never {
  if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) {
    throw new ApiError(
      'BATTLEPASS_ALREADY_GRANTED',
      'Este jogador já tem o passe deste mês neste servidor.',
      409,
    );
  }

  throw cause;
}

export function registerBattlePassRoutes(app: FastifyInstance, deps: BattlePassRoutesDeps): void {
  function assertServer(id: string): void {
    if (deps.servers.get(id) === null) {
      throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${id}".`, 404);
    }
  }

  function actorOf(request: Parameters<typeof operatorOf>[0]): BattlePassActor {
    return { name: operatorOf(request) ?? 'painel', source: 'panel' };
  }

  // ==========================================================
  //  A VISÃO GERAL
  // ==========================================================

  app.get('/battlepass/overview', async (request) => {
    const { serverId } = serverQuery.parse(request.query);

    assertServer(serverId);

    const overview = deps.service.overview(serverId);

    return {
      ok: true,
      serverId: overview.serverId,
      period: overview.period,
      season: overview.season === null ? null : seasonBody(overview.season),
      next: overview.next === null ? null : seasonBody(overview.next),
      owners: overview.owners,
      players: overview.players,
    };
  });

  // ==========================================================
  //  TEMPORADAS
  // ==========================================================

  app.get('/battlepass/seasons', async () => {
    const seasons = deps.service.listSeasons();

    return { ok: true, count: seasons.length, seasons: seasons.map(seasonBody) };
  });

  app.post('/battlepass/seasons', async (request, reply) => {
    const body = seasonInputSchema.parse(request.body);
    const season = deps.service.createSeason(body, actorOf(request));

    request.log.info(
      { season: season.id, period: season.period, levels: season.levels },
      'temporada de passe criada',
    );

    return reply.status(201).send({ ok: true, season: seasonBody(season) });
  });

  app.get('/battlepass/seasons/:seasonId', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);

    return { ok: true, season: seasonBody(deps.service.getSeason(seasonId)) };
  });

  app.put('/battlepass/seasons/:seasonId', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);
    const body = seasonInputSchema.parse(request.body);

    return { ok: true, season: seasonBody(deps.service.updateSeason(seasonId, body, actorOf(request))) };
  });

  app.put('/battlepass/seasons/:seasonId/servers', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);
    const body = serversBody.parse(request.body);

    return {
      ok: true,
      servers: deps.service.setSeasonServers(seasonId, body.servers, actorOf(request)),
    };
  });

  /**
   * Publicar é BOTÃO, e não efeito do calendário (01 §1.1).
   *
   * A recusa de "já tem uma no ar neste servidor" sai daqui com a
   * frase pronta — é a trava que impede duas trilhas na mesma tela.
   */
  app.put('/battlepass/seasons/:seasonId/state', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);
    const body = seasonStateBodySchema.parse(request.body);

    return {
      ok: true,
      season: seasonBody(deps.service.setSeasonState(seasonId, body.state, actorOf(request))),
    };
  });

  app.delete('/battlepass/seasons/:seasonId', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);

    // Apagar leva a trilha, o progresso, os direitos e a caixa. O
    // registro fica: é ele que responde "quem apagou setembro?".
    deps.service.removeSeason(seasonId, actorOf(request));

    return { ok: true };
  });

  // ==========================================================
  //  A TRILHA
  // ==========================================================

  app.get('/battlepass/seasons/:seasonId/track', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);
    const cells = deps.service.track(seasonId);

    return { ok: true, count: cells.length, cells: cells.map(cellBody) };
  });

  app.put('/battlepass/seasons/:seasonId/track/:level/:lane', async (request) => {
    const { seasonId, level, lane } = cellParams.parse(request.params);
    const body = trackCellInputSchema.parse(request.body);

    return {
      ok: true,
      cell: cellBody(deps.service.setTrackCell(seasonId, level, lane, body, actorOf(request))),
    };
  });

  app.delete('/battlepass/seasons/:seasonId/track/:level/:lane', async (request) => {
    const { seasonId, level, lane } = cellParams.parse(request.params);

    deps.service.clearTrackCell(seasonId, level, lane, actorOf(request));

    return { ok: true };
  });

  // ==========================================================
  //  AS REGRAS DE XP
  // ==========================================================

  app.get('/battlepass/seasons/:seasonId/xp-rules', async (request) => {
    const { seasonId } = seasonParams.parse(request.params);
    const rules = deps.service.xpRules(seasonId);

    return { ok: true, count: rules.length, rules: rules.map(xpRuleBody) };
  });

  app.put('/battlepass/seasons/:seasonId/xp-rules/:source', async (request) => {
    const { seasonId, source } = ruleParams.parse(request.params);
    // A fonte vem da URL: o corpo diz o resto. Mandar as duas
    // abriria "e se divergirem?", sem resposta boa.
    const body = xpRuleInputSchema.parse({ ...(request.body as object), source });

    return { ok: true, rule: xpRuleBody(deps.service.setXpRule(seasonId, body, actorOf(request))) };
  });

  app.delete('/battlepass/seasons/:seasonId/xp-rules/:source', async (request) => {
    const { seasonId, source } = ruleParams.parse(request.params);

    deps.service.removeXpRule(seasonId, source, actorOf(request));

    return { ok: true };
  });

  // ==========================================================
  //  OS JOGADORES
  // ==========================================================

  app.get('/battlepass/players', async (request) => {
    const query = boardQuery.parse(request.query);

    assertServer(query.serverId);

    const page = deps.service.leaderboard({
      serverId: query.serverId,
      limit: query.limit,
      cursor: query.cursor,
    });

    return {
      ok: true,
      count: page.rows.length,
      players: page.rows.map(progressBody),
      nextCursor: page.nextCursor,
    };
  });

  app.get('/battlepass/players/:steamId', async (request) => {
    const { steamId } = playerParams.parse(request.params);
    const { serverId } = serverQuery.parse(request.query);

    assertServer(serverId);

    return {
      ok: true,
      track: trackBody(deps.service.trackOf(serverId, steamId)),
      entitlements: deps.service.entitlementsOf(steamId).map(entitlementBody),
    };
  });

  // ==========================================================
  //  O DIREITO
  // ==========================================================

  /**
   * O admin dá o passe do mês.
   *
   * 201 sempre: `created` diz se o direito nasceu agora ou se ele já
   * tinha — dar de novo não é erro, é um fato (o mês já é dele).
   */
  app.post('/battlepass/entitlements', async (request, reply) => {
    const body = entitlementBodySchema.parse(request.body);
    const actor = actorOf(request);

    assertServer(body.serverId);

    try {
      const { entitlement, created } = deps.service.grant(
        {
          serverId: body.serverId,
          steamId: body.steamId,
          period: body.period ?? deps.service.periodNow(),
          origin: 'painel',
          note: body.note,
          createdBy: actor.name,
        },
        actor,
      );

      return reply.status(201).send({ ok: true, created, entitlement: entitlementBody(entitlement) });
    } catch (cause) {
      asApiError(cause);
    }
  });

  app.delete('/battlepass/entitlements/:entitlementId', async (request) => {
    const { entitlementId } = entitlementParams.parse(request.params);

    return {
      ok: true,
      entitlement: entitlementBody(deps.service.revokeEntitlement(entitlementId, actorOf(request))),
    };
  });

  // ==========================================================
  //  O REGISTRO
  // ==========================================================

  app.get('/battlepass/audit', async (request) => {
    const query = auditQuery.parse(request.query);
    const entries = deps.service.audit({
      limit: query.limit,
      ...(query.steamId === undefined ? {} : { steamId: query.steamId }),
      ...(query.serverId === undefined ? {} : { serverId: query.serverId }),
      ...(query.before === undefined ? {} : { before: query.before }),
    });

    return { ok: true, count: entries.length, entries: entries.map(auditBody) };
  });
}

// ------------------------------------------------------------
//  Os serializadores
// ------------------------------------------------------------

function seasonBody(season: BattlePassSeason) {
  return {
    id: season.id,
    period: season.period,
    label: season.label,
    levels: season.levels,
    xpCurve: season.xpCurve,
    state: season.state,
    freeLane: season.freeLane,
    paidLane: season.paidLane,
    retroactive: season.retroactive,
    description: season.description,
    servers: season.servers,
    createdBy: season.createdBy,
    createdAt: new Date(season.createdAt).toISOString(),
    updatedAt: new Date(season.updatedAt).toISOString(),
  };
}

function cellBody(cell: TrackCell) {
  return {
    seasonId: cell.seasonId,
    level: cell.level,
    lane: cell.lane,
    rewards: cell.rewards,
    milestone: cell.milestone,
    updatedAt: new Date(cell.updatedAt).toISOString(),
  };
}

/** A casa já resolvida para um jogador: com o estado e o motivo. */
function cellViewBody(cell: TrackCellView) {
  return { ...cellBody(cell), state: cell.state, reason: cell.reason };
}

function xpRuleBody(rule: XpRule) {
  return {
    seasonId: rule.seasonId,
    source: rule.source,
    enabled: rule.enabled,
    amount: rule.amount,
    dailyCap: rule.dailyCap,
    label: rule.label,
    updatedAt: new Date(rule.updatedAt).toISOString(),
  };
}

function progressBody(progress: PlayerProgress) {
  return {
    serverId: progress.serverId,
    steamId: progress.steamId,
    seasonId: progress.seasonId,
    xp: progress.xp,
    level: progress.level,
    updatedAt: new Date(progress.updatedAt).toISOString(),
  };
}

function trackBody(track: PlayerTrack) {
  return {
    serverId: track.serverId,
    steamId: track.steamId,
    season: track.season === null ? null : seasonBody(track.season),
    progress: track.progress,
    paid: track.paid,
    cells: track.cells.map(cellViewBody),
    pending: track.pending.map(pendingBody),
    /** O ponto de notificação do ícone da caixa (01 §7.1). */
    unseen: track.unseen,
  };
}

function pendingBody(pending: PendingDelivery) {
  return {
    id: pending.id,
    claimId: pending.claimId,
    idx: pending.idx,
    serverId: pending.serverId,
    steamId: pending.steamId,
    origin: pending.origin,
    reward: pending.reward,
    code: pending.code,
    attempts: pending.attempts,
    seenAt: pending.seenAt === null ? null : new Date(pending.seenAt).toISOString(),
    deliveredAt: pending.deliveredAt === null ? null : new Date(pending.deliveredAt).toISOString(),
    createdAt: new Date(pending.createdAt).toISOString(),
    updatedAt: new Date(pending.updatedAt).toISOString(),
  };
}

function entitlementBody(entitlement: Entitlement) {
  return {
    id: entitlement.id,
    serverId: entitlement.serverId,
    steamId: entitlement.steamId,
    period: entitlement.period,
    origin: entitlement.origin,
    levelAtGrant: entitlement.levelAtGrant,
    sourceRef: entitlement.sourceRef,
    note: entitlement.note,
    createdAt: new Date(entitlement.createdAt).toISOString(),
    createdBy: entitlement.createdBy,
    revokedAt: entitlement.revokedAt === null ? null : new Date(entitlement.revokedAt).toISOString(),
    revokedBy: entitlement.revokedBy,
    /** Derivado, para a tela não repetir a conta. */
    active: entitlement.revokedAt === null,
  };
}

/** Exportado para a ficha do jogador, que lista os resgates dele. */
export function claimBody(claim: BattlePassClaim) {
  return {
    id: claim.id,
    serverId: claim.serverId,
    steamId: claim.steamId,
    seasonId: claim.seasonId,
    level: claim.level,
    lane: claim.lane,
    status: claim.status,
    rewards: claim.snapshot,
    claimedAt: new Date(claim.claimedAt).toISOString(),
    settledAt: claim.settledAt === null ? null : new Date(claim.settledAt).toISOString(),
  };
}

function auditBody(entry: BattlePassAuditEntry) {
  return {
    id: entry.id,
    at: new Date(entry.at).toISOString(),
    actor: entry.actor,
    source: entry.source,
    action: entry.action,
    target: entry.target,
    serverId: entry.serverId,
    steamId: entry.steamId,
    detail: entry.detail,
  };
}
