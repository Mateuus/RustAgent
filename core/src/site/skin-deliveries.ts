// ============================================================
//  skin-deliveries.ts  -  a skin vendida (ou sorteada) no site vira
//  posse na rede. Ver Docs/OrigemZWorkshop/04-ENTREGA-PELO-SITE.md §3.
//
//  A fila (`site/deliveries.ts`) cuida da reserva, do ACK e da
//  idempotência; este arquivo só sabe TRADUZIR a tarefa para o
//  `WorkshopCatalog` — a MESMA porta do painel e do `/skin give` —
//  e deixar o rastro `site.delivered` no registro do módulo.
//
//  ####  AS RECUSAS SAEM COMO `ApiError`, COM O CÓDIGO DO FIO  ####
//
//    SKIN_NOT_IN_CATALOG  o par não está no catálogo. A fila adia.
//    PAYLOAD_INVALID      o catálogo recusou a entrada. A fila falha.
//
//  Qualquer outra exceção (o banco) passa direto: a fila não dá ACK,
//  e a reserva órfã vira AGENT_INDETERMINATE na volta seguinte.
// ============================================================

import type { WorkshopOwnedRepository } from '../db/workshop-owned-repository.js';
import type { WorkshopCatalog } from '../game/workshop-catalog.js';
import { ApiError } from '../http/error-response.js';

/** O teto do `createdBy` e do `sourceRef` na posse. */
const REF_MAX = 120;

export interface SkinGrantRequest {
  /** O `DLV-…` da tarefa. */
  readonly deliveryId: string;
  readonly steamId: string;
  readonly shortname: string;
  readonly workshopId: string;
  /** `null` = permanente. */
  readonly days: number | null;
  /** O `sourceRef` do site (`order:1234`, `box:5678`). */
  readonly sourceRef: string | null;
  /** A fila (servidor LOCAL) que recebeu a tarefa. Só vai ao registro. */
  readonly serverId: string;
}

export type SkinRevokeRequest = Omit<SkinGrantRequest, 'days'>;

export interface SkinGrantOutcome {
  readonly created: boolean;
  /** Epoch ms, ou `null` para permanente. */
  readonly expiresAt: number | null;
}

export interface SkinRevokeOutcome {
  /** `false` = não havia posse para tirar, e isso é sucesso. */
  readonly removed: boolean;
}

export interface SkinDeliveryHandlers {
  readonly grantSkin: (request: SkinGrantRequest) => SkinGrantOutcome;
  readonly revokeSkin: (request: SkinRevokeRequest) => SkinRevokeOutcome;
}

export interface SkinDeliveryDeps {
  readonly catalog: Pick<WorkshopCatalog, 'findSkinByMark' | 'grantOwnership' | 'revokeOwnership'>;
  readonly audit: Pick<WorkshopOwnedRepository, 'log'>;
  readonly now?: () => number;
}

function notInCatalog(shortname: string, workshopId: string): ApiError {
  return new ApiError(
    'SKIN_NOT_IN_CATALOG',
    `A skin ${workshopId} em "${shortname}" não está no catálogo do agente.`,
    404,
  );
}

/** O `createdBy` da posse: `site:<sourceRef>`, ou `site:<DLV>` sem ele. */
function actorOf(request: SkinRevokeRequest): string {
  return `site:${request.sourceRef ?? request.deliveryId}`.slice(0, REF_MAX);
}

/**
 * Os erros do catálogo na língua da fila.
 *
 * `WORKSHOP_SKIN_NOT_FOUND` só aparece quando a skin foi apagada
 * entre a busca e a gravação: é o mesmo "não está no catálogo".
 */
function translated(error: unknown, request: SkinRevokeRequest): unknown {
  if (!(error instanceof ApiError)) return error;

  if (error.code === 'WORKSHOP_SKIN_NOT_FOUND') {
    return notInCatalog(request.shortname, request.workshopId);
  }

  if (error.code === 'INVALID_OWNERSHIP' || error.code === 'OWNED_ALREADY_EXPIRED') {
    return new ApiError('PAYLOAD_INVALID', error.message, 400);
  }

  return error;
}

export function createSkinDeliveryHandlers(deps: SkinDeliveryDeps): SkinDeliveryHandlers {
  const now = deps.now ?? ((): number => Date.now());

  return {
    grantSkin(request) {
      const skin = deps.catalog.findSkinByMark(request.shortname, request.workshopId);

      if (skin === null) throw notInCatalog(request.shortname, request.workshopId);

      const at = now();
      let granted;

      try {
        granted = deps.catalog.grantOwnership(
          {
            steamId: request.steamId,
            skinRef: skin.id,
            days: request.days,
            source: 'site',
            sourceRef: request.deliveryId,
            createdBy: actorOf(request),
            serverId: request.serverId,
          },
          at,
        );
      } catch (error) {
        throw translated(error, request);
      }

      // Desligada, ou em nenhum servidor, a posse é gravada do mesmo
      // jeito (o jogador pagou). O registro diz isso, para quem for
      // procurar "comprei e não aparece".
      deps.audit.log(
        {
          actor: actorOf(request),
          source: 'site',
          action: 'site.delivered',
          target: `skin #${String(skin.id)} "${skin.label}" (${skin.shortname})`,
          serverId: request.serverId,
          steamId: request.steamId,
          detail: {
            deliveryId: request.deliveryId,
            kind: 'skin',
            sourceRef: request.sourceRef,
            workshopId: skin.skinId,
            days: request.days,
            ownedId: granted.owned.id,
            expiresAt: granted.owned.expiresAt,
            created: granted.created,
            skinEnabled: skin.enabled,
            skinServers: skin.servers,
          },
        },
        at,
      );

      return { created: granted.created, expiresAt: granted.owned.expiresAt };
    },

    revokeSkin(request) {
      const skin = deps.catalog.findSkinByMark(request.shortname, request.workshopId);
      const at = now();
      let removed = false;

      // Sem a skin no catálogo não há posse dela (a posse cai em
      // cascata com a skin): o estado pedido já vale.
      if (skin !== null) {
        try {
          removed =
            deps.catalog.revokeOwnership(
              {
                steamId: request.steamId,
                skinRef: skin.id,
                source: 'site',
                sourceRef: request.sourceRef ?? request.deliveryId,
                createdBy: actorOf(request),
                serverId: request.serverId,
              },
              at,
            ) !== null;
        } catch (error) {
          throw translated(error, request);
        }
      }

      deps.audit.log(
        {
          actor: actorOf(request),
          source: 'site',
          action: 'site.delivered',
          target:
            skin === null
              ? `skin ${request.workshopId} (${request.shortname}), fora do catálogo`
              : `skin #${String(skin.id)} "${skin.label}" (${skin.shortname})`,
          serverId: request.serverId,
          steamId: request.steamId,
          detail: {
            deliveryId: request.deliveryId,
            kind: 'skin_revoke',
            sourceRef: request.sourceRef,
            workshopId: request.workshopId,
            inCatalog: skin !== null,
            removed,
          },
        },
        at,
      );

      return { removed };
    },
  };
}
