// ============================================================
//  routes/workshop.ts  -  skins, coleções, acessos e registro.
//
//      GET    /workshop/skins                          a lista
//      GET    /workshop/skins/:skinId                  uma
//      POST   /workshop/skins                          cria. 201
//      PUT    /workshop/skins/:skinId                  edita (INTEIRA)
//      PUT    /workshop/skins/:skinId/servers          troca só onde vale
//      DELETE /workshop/skins/:skinId                  apaga
//      GET    /workshop/lookup/:workshopId             o que a Steam diz
//
//      GET    /workshop/collections                    a lista
//      GET    /workshop/collections/:collectionId      uma, com as skins
//      POST   /workshop/collections                    cria. 201
//      PUT    /workshop/collections/:collectionId      edita
//      PUT    /workshop/collections/:collectionId/skins  troca as skins
//      DELETE /workshop/collections/:collectionId      apaga (solta as skins)
//
//      GET    /workshop/grants                         filtra por quem/o quê
//      POST   /workshop/grants                         libera (ou renova)
//      DELETE /workshop/grants/:grantId                remove
//
//      GET    /workshop/audit                          o registro
//
//      GET    /servers/:id/workshop/status             o que o plugin tem
//      POST   /servers/:id/workshop/sync               manda a carga agora
//
//  ####  AS REGRAS NÃO MORAM AQUI  ####
//
//  Moram em game/workshop-catalog.ts, porque o `/skin add` do jogo
//  passa por elas também. Esta rota só lê o corpo, diz quem está
//  mexendo e repassa a frase.
//
//  ####  O CADASTRO RESPONDE COM OS SERVIDORES DESLIGADOS  ####
//
//  Cadastrar é trabalho de madrugada, com tudo parado. Só as duas
//  últimas perguntam ao jogo, e com ele fora do ar devolvem 503.
//
//  ####  O :skinId DA ROTA É O NOSSO id, E NÃO O DA OFICINA  ####
//
//  O da rota é a chave da linha (1, 2, 3); o do Workshop é um
//  UInt64 de vinte dígitos que viaja como TEXTO. O primeiro é
//  `coerce.number()`, o segundo é string com régua própria.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { WorkshopAccessRepository } from '../../db/workshop-access-repository.js';
import type { WorkshopSkinsRepository } from '../../db/workshop-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import { judgeWorkshopFile, type WorkshopLookupFn } from '../../game/steam-workshop.js';
import { WorkshopCommandError, type WorkshopService } from '../../game/workshop.js';
import type { WorkshopActor, WorkshopCatalog } from '../../game/workshop-catalog.js';
import type { ItemsRepository } from '../../db/items-repository.js';
import {
  collectionSkinsBodySchema,
  GRANT_SUBJECT_TYPES,
  GRANT_TARGET_TYPES,
  workshopCollectionInputSchema,
  workshopGrantBodySchema,
  workshopSkinBodySchema,
  workshopSkinIdSchema,
  type WorkshopAuditEntry,
  type WorkshopCollection,
  type WorkshopGrant,
  type WorkshopSkin,
} from '../../types/workshop.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface WorkshopRoutesDeps {
  readonly repository: WorkshopSkinsRepository;
  readonly access: WorkshopAccessRepository;
  readonly catalog: WorkshopCatalog;
  readonly items: ItemsRepository;
  readonly servers: ServersRepository;
  readonly lookup: WorkshopLookupFn;
  /**
   * O canal com o jogo.
   *
   * Ausente = o agente subiu sem servidor nenhum. O cadastro
   * continua funcionando; mandar a carga, não — e a rota diz isso
   * em vez de fingir.
   */
  readonly workshop?: WorkshopService;
}

const skinParams = z.object({ skinId: z.coerce.number().int().positive() });
const collectionParams = z.object({ collectionId: z.coerce.number().int().positive() });
const grantParams = z.object({ grantId: z.coerce.number().int().positive() });
const serverParams = z.object({ id: z.string().min(1) });
const lookupParams = z.object({ workshopId: workshopSkinIdSchema });
const lookupQuery = z.object({ shortname: z.string().trim().toLowerCase().optional() });
const serversBody = z.object({ servers: z.array(z.string().min(1)).max(50) });

const grantsQuery = z.object({
  subjectType: z.enum(GRANT_SUBJECT_TYPES).optional(),
  subject: z.string().trim().min(1).optional(),
  targetType: z.enum(GRANT_TARGET_TYPES).optional(),
  targetId: z.coerce.number().int().positive().optional(),
  includeExpired: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

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

    return { ok: true, count: skins.length, skins: skins.map(skinBody) };
  });

  app.get('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const skin = deps.repository.get(skinId);

    if (skin === null) {
      throw new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(skinId)}.`, 404);
    }

    return { ok: true, skin: skinBody(skin) };
  });

  app.post('/workshop/skins', async (request, reply) => {
    const body = workshopSkinBodySchema.parse(request.body);
    const { skin, warning } = await deps.catalog.createSkin(body, actorOf(request));

    request.log.info(
      { skin: skin.id, base: skin.shortname, workshop: skin.skinId },
      'skin do Workshop cadastrada',
    );

    return reply.status(201).send({ ok: true, skin: skinBody(skin), warning });
  });

  app.put('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const body = workshopSkinBodySchema.parse(request.body);
    const { skin, warning } = await deps.catalog.updateSkin(skinId, body, actorOf(request));

    return { ok: true, skin: skinBody(skin), warning };
  });

  app.put('/workshop/skins/:skinId/servers', async (request) => {
    const { skinId } = skinParams.parse(request.params);
    const body = serversBody.parse(request.body);

    return { ok: true, servers: deps.catalog.setSkinServers(skinId, body.servers, actorOf(request)) };
  });

  app.delete('/workshop/skins/:skinId', async (request) => {
    const { skinId } = skinParams.parse(request.params);

    // Apagar é diferente de desligar: o que já foi pintado no mundo
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
  //  COLEÇÕES
  // ==========================================================

  app.get('/workshop/collections', async () => {
    const collections = deps.repository.listCollections();

    return { ok: true, count: collections.length, collections: collections.map(collectionBody) };
  });

  app.get('/workshop/collections/:collectionId', async (request) => {
    const { collectionId } = collectionParams.parse(request.params);
    const collection = deps.repository.getCollection(collectionId);

    if (collection === null) {
      throw new ApiError(
        'WORKSHOP_COLLECTION_NOT_FOUND',
        `Nenhuma coleção com o id ${String(collectionId)}.`,
        404,
      );
    }

    return {
      ok: true,
      collection: collectionBody(collection),
      skins: deps.repository.skinsOfCollection(collectionId).map(skinBody),
    };
  });

  app.post('/workshop/collections', async (request, reply) => {
    const input = workshopCollectionInputSchema.parse(request.body);
    const collection = deps.catalog.createCollection(input, actorOf(request));

    return reply.status(201).send({ ok: true, collection: collectionBody(collection) });
  });

  app.put('/workshop/collections/:collectionId', async (request) => {
    const { collectionId } = collectionParams.parse(request.params);
    const input = workshopCollectionInputSchema.parse(request.body);
    const collection = deps.catalog.updateCollection(collectionId, input, actorOf(request));

    return { ok: true, collection: collectionBody(collection) };
  });

  app.put('/workshop/collections/:collectionId/skins', async (request) => {
    const { collectionId } = collectionParams.parse(request.params);
    const body = collectionSkinsBodySchema.parse(request.body);
    const skins = deps.catalog.setCollectionSkins(collectionId, body.skinIds, actorOf(request));

    return { ok: true, skins: skins.map(skinBody) };
  });

  app.delete('/workshop/collections/:collectionId', async (request) => {
    const { collectionId } = collectionParams.parse(request.params);

    deps.catalog.removeCollection(collectionId, actorOf(request));

    return { ok: true };
  });

  // ==========================================================
  //  ACESSOS
  // ==========================================================

  app.get('/workshop/grants', async (request) => {
    const query = grantsQuery.parse(request.query);
    const now = Date.now();
    const grants = deps.access.listGrants(
      {
        ...(query.subjectType === undefined ? {} : { subjectType: query.subjectType }),
        ...(query.subject === undefined
          ? {}
          : { subject: query.subjectType === 'group' ? query.subject.toLowerCase() : query.subject }),
        ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
        ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
        includeExpired: query.includeExpired,
      },
      now,
    );

    return { ok: true, count: grants.length, grants: grants.map((grant) => grantBody(grant, deps, now)) };
  });

  app.post('/workshop/grants', async (request, reply) => {
    const input = workshopGrantBodySchema.parse(request.body);
    const grant = deps.catalog.grant(input, actorOf(request));

    return reply.status(201).send({ ok: true, grant: grantBody(grant, deps, Date.now()) });
  });

  app.delete('/workshop/grants/:grantId', async (request) => {
    const { grantId } = grantParams.parse(request.params);

    deps.catalog.revoke(grantId, actorOf(request));

    return { ok: true };
  });

  // ==========================================================
  //  REGISTRO
  // ==========================================================

  app.get('/workshop/audit', async (request) => {
    const query = auditQuery.parse(request.query);
    const entries = deps.access.audit({
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
   * Manda a carga agora, naquele servidor. FORÇADO: quem apertou o
   * botão quer o comando saindo, e não um "não mudou nada".
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

    return {
      ok: true,
      outcome: outcome.status,
      ...(outcome.status === 'sent' ? { parts: outcome.parts, bytes: outcome.bytes } : {}),
    };
  });
}

/** Uma skin, na forma que a API entrega. Datas em ISO. */
function skinBody(skin: WorkshopSkin) {
  return {
    id: skin.id,
    label: skin.label,
    shortname: skin.shortname,
    skinId: skin.skinId,
    permission: skin.permission,
    collectionId: skin.collectionId,
    openToAll: skin.openToAll,
    hideInStreamer: skin.hideInStreamer,
    enabled: skin.enabled,
    servers: skin.servers,
    source: skin.source,
    createdBy: skin.createdBy,
    workshopTitle: skin.workshopTitle,
    previewUrl: skin.previewUrl,
    createdAt: new Date(skin.createdAt).toISOString(),
    updatedAt: new Date(skin.updatedAt).toISOString(),
  };
}

function collectionBody(collection: WorkshopCollection) {
  return {
    id: collection.id,
    slug: collection.slug,
    label: collection.label,
    permission: collection.permission,
    openToAll: collection.openToAll,
    enabled: collection.enabled,
    skinCount: collection.skinCount,
    createdBy: collection.createdBy,
    createdAt: new Date(collection.createdAt).toISOString(),
    updatedAt: new Date(collection.updatedAt).toISOString(),
  };
}

/**
 * Um acesso, com o nome do alvo já resolvido.
 *
 * A tela lista acessos de um jogador; sem o nome ela teria de
 * buscar o catálogo inteiro só para traduzir "skin 12".
 */
function grantBody(grant: WorkshopGrant, deps: WorkshopRoutesDeps, now: number) {
  let targetLabel = `#${String(grant.targetId)}`;
  let targetShortname: string | null = null;

  if (grant.targetType === 'skin') {
    const skin = deps.repository.get(grant.targetId);

    if (skin !== null) {
      targetLabel = skin.label;
      targetShortname = skin.shortname;
    }
  } else {
    const collection = deps.repository.getCollection(grant.targetId);

    if (collection !== null) targetLabel = `/skin ${collection.slug} — ${collection.label}`;
  }

  return {
    id: grant.id,
    subjectType: grant.subjectType,
    subject: grant.subject,
    targetType: grant.targetType,
    targetId: grant.targetId,
    targetLabel,
    targetShortname,
    expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
    expired: grant.expiresAt !== null && grant.expiresAt <= now,
    note: grant.note,
    createdBy: grant.createdBy,
    createdAt: new Date(grant.createdAt).toISOString(),
    updatedAt: new Date(grant.updatedAt).toISOString(),
  };
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
