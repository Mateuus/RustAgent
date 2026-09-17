// ============================================================
//  routes/workshop.ts  -  skins, posse e registro.
//
//      GET    /workshop/skins                          a lista
//      GET    /workshop/skins/:skinId                  uma
//      POST   /workshop/skins                          cria. 201
//      PUT    /workshop/skins/:skinId                  edita (INTEIRA)
//      PUT    /workshop/skins/:skinId/servers          troca só onde vale
//      DELETE /workshop/skins/:skinId                  apaga
//      GET    /workshop/lookup/:workshopId             o que a Steam diz
//
//      GET    /workshop/owned?steamId=&skinId=&cursor=  a posse, paginada
//      POST   /workshop/owned                          dá (ou renova). 201
//      DELETE /workshop/owned/:ownedId                 tira
//
//      GET    /workshop/audit                          o registro
//
//      GET    /servers/:id/workshop/status             o que o plugin tem
//      POST   /servers/:id/workshop/sync               manda a carga agora
//
//  A ficha do jogador (`GET /players/:steamId/skins`) mora em
//  routes/players.ts e usa `ownedView`, daqui.
//
//  Coleções e acessos (`/workshop/collections*`, `/workshop/grants*`)
//  SAÍRAM com a migração 097. Ver Docs/OrigemZWorkshop/02 §10.
//
//  ####  AS REGRAS NÃO MORAM AQUI  ####
//
//  Moram em game/workshop-catalog.ts, porque o `/skin add` do jogo e
//  a entrega do site passam por elas também. Esta rota só lê o
//  corpo, diz quem está mexendo e repassa a frase.
//
//  ####  O :skinId DA ROTA É O NOSSO id, E NÃO O DA OFICINA  ####
//
//  O da rota (e o `skinId` do corpo de `/workshop/owned`) é a chave
//  da linha (1, 2, 3); o do Workshop é um UInt64 de vinte dígitos que
//  viaja como TEXTO, e na resposta se chama `workshopId` quando os
//  dois aparecem juntos.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ItemsRepository } from '../../db/items-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import { isOwnedLive, type WorkshopOwnedRepository } from '../../db/workshop-owned-repository.js';
import type { WorkshopSkinsRepository } from '../../db/workshop-repository.js';
import { judgeWorkshopFile, type WorkshopLookupFn } from '../../game/steam-workshop.js';
import { WorkshopCommandError, type WorkshopService } from '../../game/workshop.js';
import type { WorkshopActor, WorkshopCatalog } from '../../game/workshop-catalog.js';
import {
  ownedGrantBodySchema,
  ownedListQuerySchema,
  workshopSkinBodySchema,
  workshopSkinIdSchema,
  type OwnedSkin,
  type WorkshopAuditEntry,
  type WorkshopSkin,
} from '../../types/workshop.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface WorkshopRoutesDeps {
  readonly repository: WorkshopSkinsRepository;
  readonly owned: WorkshopOwnedRepository;
  readonly catalog: WorkshopCatalog;
  readonly items: ItemsRepository;
  readonly servers: ServersRepository;
  readonly lookup: WorkshopLookupFn;
  /**
   * O canal com o jogo.
   *
   * Ausente = o agente subiu sem servidor nenhum. O cadastro e a
   * posse continuam funcionando; mandar a carga, não — e a rota diz
   * isso em vez de fingir.
   */
  readonly workshop?: WorkshopService;
}

const skinParams = z.object({ skinId: z.coerce.number().int().positive() });
const ownedParams = z.object({ ownedId: z.coerce.number().int().positive() });
const serverParams = z.object({ id: z.string().min(1) });
const lookupParams = z.object({ workshopId: workshopSkinIdSchema });
const lookupQuery = z.object({ shortname: z.string().trim().toLowerCase().optional() });
const serversBody = z.object({ servers: z.array(z.string().min(1)).max(50) });

const auditQuery = z.object({
  steamId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});

function asApiError(cause: unknown): never {
  if (!(cause instanceof WorkshopCommandError)) throw cause;

  switch (cause.reason) {
    case 'offline':
      throw new ApiError('SERVER_OFFLINE', cause.message, 503);

    case 'no_plugin':
      throw new ApiError('WORKSHOP_PLUGIN_MISSING', cause.message, 503);

    default:
      throw new ApiError('WORKSHOP_FAILED', cause.message, 502);
  }
}

export function registerWorkshopRoutes(app: FastifyInstance, deps: WorkshopRoutesDeps): void {
  function service(): WorkshopService {
    if (deps.workshop === undefined) {
      throw new ApiError(
        'WORKSHOP_UNAVAILABLE',
        'Este agente subiu sem canal com os servidores: não há como mandar a carga.',
        503,
      );
    }

    return deps.workshop;
  }

  function assertServer(id: string): void {
    if (deps.servers.get(id) === null) {
      throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${id}".`, 404);
    }
  }

  function actorOf(request: Parameters<typeof operatorOf>[0]): WorkshopActor {
    return { name: operatorOf(request) ?? 'painel', source: 'panel' };
  }

  // ==========================================================
  //  SKINS
  // ==========================================================

  app.get('/workshop/skins', async () => {
    const skins = deps.repository.list();
    const owners = deps.owned.liveOwnerCounts();

    return {
      ok: true,
      count: skins.length,
      skins: skins.map((skin) => skinBody(skin, owners.get(skin.id) ?? 0)),
    };
  });

  app.get('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const skin = deps.repository.get(skinId);

    if (skin === null) {
      throw new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(skinId)}.`, 404);
    }

    return { ok: true, skin: skinBody(skin, deps.owned.liveOwnerCounts().get(skin.id) ?? 0) };
  });

  app.post('/workshop/skins', async (request, reply) => {
    const body = workshopSkinBodySchema.parse(request.body);
    const { skin, warning } = await deps.catalog.createSkin(body, actorOf(request));

    request.log.info(
      { skin: skin.id, base: skin.shortname, workshop: skin.skinId },
      'skin do Workshop cadastrada',
    );

    return reply.status(201).send({ ok: true, skin: skinBody(skin, 0), warning });
  });

  app.put('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const body = workshopSkinBodySchema.parse(request.body);
    const { skin, warning } = await deps.catalog.updateSkin(skinId, body, actorOf(request));

    return { ok: true, skin: skinBody(skin, deps.owned.liveOwnerCounts().get(skin.id) ?? 0), warning };
  });

  app.put('/workshop/skins/:skinId/servers', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const body = serversBody.parse(request.body);

    return { ok: true, servers: deps.catalog.setSkinServers(skinId, body.servers, actorOf(request)) };
  });

  app.delete('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);

    // Apagar é diferente de desligar: leva as posses junto (o
    // registro diz de quem eram), e o que já foi pintado no mundo
    // continua com o número, porque quem guarda a marca é o item.
    deps.catalog.removeSkin(skinId, actorOf(request));

    return { ok: true };
  });

  /**
   * O que a Steam diz de um id, ANTES de salvar.
   *
   * É o que deixa a tela preencher o nome e mostrar a prévia
   * enquanto o admin digita — e avisar "esta skin é da máscara" antes
   * de ele escolher o machado.
   */
  app.get('/workshop/lookup/:workshopId', async (request) => {
    const { workshopId } = lookupParams.parse(request.params);
    const { shortname } = lookupQuery.parse(request.query);
    const lookup = await deps.lookup(workshopId);
    const verdict =
      shortname === undefined || shortname === ''
        ? null
        : judgeWorkshopFile(lookup, shortname, (name) => deps.items.shortnamesByDisplayName(name));

    // Sugere o item quando a tag casa com um só.
    const suggested =
      lookup.status === 'found'
        ? lookup.details.tags.flatMap((tag) => deps.items.shortnamesByDisplayName(tag))
        : [];

    return {
      ok: true,
      status: lookup.status,
      details: lookup.status === 'found' ? lookup.details : null,
      reason: lookup.status === 'unavailable' ? lookup.reason : null,
      suggestedShortnames: [...new Set(suggested)],
      verdict:
        verdict === null
          ? null
          : verdict.ok
            ? { ok: true, warning: verdict.warning }
            : { ok: false, code: verdict.code, message: verdict.message },
    };
  });

  // ==========================================================
  //  POSSE
  // ==========================================================

  /**
   * Quem tem o quê. Uma das chaves (`steamId` ou `skinId`) é
   * obrigatória; `cursor` é o `nextCursor` da página anterior.
   */
  app.get('/workshop/owned', async (request) => {
    const query = ownedListQuerySchema.parse(request.query);
    const now = Date.now();
    const page = deps.owned.listOwned(
      {
        ...(query.steamId === undefined ? {} : { steamId: query.steamId }),
        ...(query.skinId === undefined ? {} : { skinRef: query.skinId }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        includeExpired: query.includeExpired,
        limit: query.limit,
      },
      now,
    );

    return {
      ok: true,
      count: page.owned.length,
      owned: ownedView(deps.repository, page.owned, now),
      nextCursor: page.nextCursor,
    };
  });

  /**
   * Dá a skin — ou renova (a regra do prazo é do repositório).
   *
   * 201 sempre: a resposta diz em `created` se a posse era nova (ou
   * estava vencida) ou se só o prazo mudou.
   */
  app.post('/workshop/owned', async (request, reply) => {
    const body = ownedGrantBodySchema.parse(request.body);
    const actor = actorOf(request);
    const now = Date.now();
    const { owned, created } = deps.catalog.grantOwnership(
      {
        steamId: body.steamId,
        skinRef: body.skinId,
        days: body.days ?? null,
        expiresAt: body.expiresAt,
        source: 'panel',
        note: body.note,
        createdBy: actor.name,
      },
      now,
    );

    return reply.status(201).send({
      ok: true,
      created,
      owned: ownedView(deps.repository, [owned], now)[0],
    });
  });

  app.delete('/workshop/owned/:ownedId', async (request) => {
    const { ownedId } = ownedParams.parse(request.params);

    // Não despinta nada: o item pintado continua pintado (02 §3).
    deps.catalog.revokeOwnershipById(ownedId, actorOf(request));

    return { ok: true };
  });

  // ==========================================================
  //  REGISTRO
  // ==========================================================

  app.get('/workshop/audit', async (request) => {
    const query = auditQuery.parse(request.query);
    const entries = deps.owned.audit({
      limit: query.limit,
      ...(query.steamId === undefined ? {} : { steamId: query.steamId }),
      ...(query.before === undefined ? {} : { before: query.before }),
    });

    return { ok: true, count: entries.length, entries: entries.map(auditBody) };
  });

  // ==========================================================
  //  O QUE ESTÁ NO JOGO
  // ==========================================================

  app.get('/servers/:id/workshop/status', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    try {
      return {
        ok: true,
        status: await service().status(id),
        // O que o plugin CONFIRMOU no último envio. Divergir do
        // `status` é o sintoma de um `oxide.reload` que ninguém
        // acompanhou.
        applied: service().appliedCount(id),
      };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  /**
   * Manda a carga agora, naquele servidor — o catálogo e a posse de
   * quem está online. FORÇADO: quem apertou o botão quer o comando
   * saindo, e não um "não mudou nada".
   */
  app.post('/servers/:id/workshop/sync', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    const outcome = await service().sync(id, 'plugin-requested');

    if (outcome.status === 'skipped') {
      throw new ApiError(
        'SERVER_OFFLINE',
        `O RCON do servidor "${id}" está fora do ar: ${outcome.reason}. A carga inteira é ` +
          'reenviada quando ele voltar.',
        503,
      );
    }

    if (outcome.status === 'failed') {
      throw new ApiError('WORKSHOP_FAILED', outcome.error.message, 502);
    }

    await service().syncOwnedAll(id, 'manual', true);

    return {
      ok: true,
      outcome: outcome.status,
      ...(outcome.status === 'sent' ? { parts: outcome.parts, bytes: outcome.bytes } : {}),
    };
  });
}

/** Uma skin, na forma que a API entrega. Datas em ISO. */
function skinBody(skin: WorkshopSkin, owners: number) {
  return {
    id: skin.id,
    label: skin.label,
    shortname: skin.shortname,
    skinId: skin.skinId,
    description: skin.description,
    rarity: skin.rarity,
    sort: skin.sort,
    openToAll: skin.openToAll,
    hideInStreamer: skin.hideInStreamer,
    enabled: skin.enabled,
    servers: skin.servers,
    source: skin.source,
    createdBy: skin.createdBy,
    workshopTitle: skin.workshopTitle,
    previewUrl: skin.previewUrl,
    /** Quantos jogadores têm posse VIVA dela. */
    owners,
    createdAt: new Date(skin.createdAt).toISOString(),
    updatedAt: new Date(skin.updatedAt).toISOString(),
  };
}

/**
 * A posse, com a skin já resolvida.
 *
 * A ficha lista a posse de um jogador; sem o nome da skin ela teria
 * de buscar o catálogo inteiro só para traduzir "skin 12". `skin` é
 * `null` só numa corrida com um DELETE (a cascata leva a posse).
 *
 * Exportada para `GET /players/:steamId/skins`.
 */
export function ownedView(
  skins: Pick<WorkshopSkinsRepository, 'getMany'>,
  rows: readonly OwnedSkin[],
  now: number,
) {
  const catalog = skins.getMany(rows.map((row) => row.skinRef));

  return rows.map((row) => {
    const skin = catalog.get(row.skinRef) ?? null;

    return {
      id: row.id,
      steamId: row.steamId,
      skinId: row.skinRef,
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
      expired: !isOwnedLive(row, now),
      source: row.source,
      sourceRef: row.sourceRef,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      skin:
        skin === null
          ? null
          : {
              id: skin.id,
              label: skin.label,
              shortname: skin.shortname,
              workshopId: skin.skinId,
              description: skin.description,
              rarity: skin.rarity,
              previewUrl: skin.previewUrl,
              openToAll: skin.openToAll,
              enabled: skin.enabled,
              servers: skin.servers,
            },
    };
  });
}

function auditBody(entry: WorkshopAuditEntry) {
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
