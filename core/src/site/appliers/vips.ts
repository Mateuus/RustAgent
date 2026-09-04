// ============================================================
//  appliers/vips.ts  -  o VIP que o site concede e revoga.
//
//  ####  ESTE ASSUNTO NÃO É SNAPSHOT, E É O ÚNICO ASSIM  ####
//
//  A loja e os kits são catálogo: o site manda a lista inteira e o
//  que sumiu sai. VIP não é catálogo — é um benefício de UMA conta,
//  concedido de três lugares diferentes: a compra na loja in-game
//  (que vira entrega `vip`), a mão de um admin no painel local, e a
//  reconciliação que ADOTA quem já estava no grupo do plugin.
//
//  Um snapshot aqui revogaria os dois últimos toda vez que o site
//  montasse a lista sem eles — e ninguém repara num benefício que
//  some, até o jogador reclamar. Por isso o `desired` traz VERBOS:
//  `grants` e `revocations`. O que não está em nenhuma das duas
//  listas não é tocado.
//
//  ####  E ELE NÃO PRECISA DE SNAPSHOT PARA SER SEGURO  ####
//
//  Quem garante a aplicação única é a `version`, igual aos outros
//  assuntos: uma versão já aplicada não volta, nem depois de um
//  `pm2 restart`. Sem isso, um `grant` reenviado ESTENDERIA o
//  vencimento de novo, e um VIP de 30 dias viraria um de 60 por
//  causa de um ACK perdido.
//
//  ####  REVOGAR O QUE JÁ NÃO EXISTE NÃO É ERRO  ####
//
//  `VIP_NOT_FOUND` é o desfecho de "o vencimento chegou primeiro", e
//  ele é comum: o relógio local vence o VIP às 3h, o site manda a
//  revogação às 3h05. O estado desejado é o que já vale, e chamá-lo
//  de falha faria o admin caçar um problema que não existe.
//
//  Ver Docs\23-CONFIG-PELO-SITE.md §5.
// ============================================================

import { ApiError } from '../../http/error-response.js';
import type { VipList } from '../../vip/service.js';
import type { ConfigFieldError } from '../client.js';
import {
  DOMAIN_ERROR_CODES,
  type DomainApplier,
  type DomainOutcome,
  type DomainPlan,
} from '../domains.js';

/** SteamID64: 17 dígitos, e SEMPRE texto. Ver `routes/vips.ts`. */
const STEAM_ID = /^\d{17}$/;

interface Grant {
  readonly steamId: string;
  readonly tier: string;
  /** Epoch ms. `null` = vitalício, e ele é DE PROPÓSITO. */
  readonly expiresAt: number | null;
}

interface Revocation {
  readonly steamId: string;
  readonly tier: string;
}

export interface VipsWork {
  readonly grants: readonly Grant[];
  readonly revocations: readonly Revocation[];
}

export interface VipsApplierDeps {
  readonly vips: VipList;
  /** Fica no histórico como quem concedeu. */
  readonly actor?: string;
}

/** Um `tier` do contrato: texto curto, comparado em minúsculas. */
function tierOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' || trimmed.length > 32 ? null : trimmed;
}

export function vipsApplier(deps: VipsApplierDeps): DomainApplier<VipsWork> {
  const actor = deps.actor ?? 'site';

  return {
    domain: 'vips',

    plan(desired): DomainPlan<VipsWork> {
      // As duas chaves são opcionais, e é a diferença que separa
      // este assunto dos outros: aqui a lista ausente quer dizer
      // "nada a conceder", e não "revogue tudo".
      const rawGrants = desired.grants ?? [];
      const rawRevocations = desired.revocations ?? [];

      if (!Array.isArray(rawGrants) || !Array.isArray(rawRevocations)) {
        return { work: null, errors: [{ field: 'vips', code: DOMAIN_ERROR_CODES.invalidShape }] };
      }

      const errors: ConfigFieldError[] = [];
      const grants: Grant[] = [];
      const revocations: Revocation[] = [];

      for (const [index, raw] of (rawGrants as readonly unknown[]).entries()) {
        const row = (raw ?? {}) as Record<string, unknown>;
        const steamId = typeof row.steamId === 'string' ? row.steamId.trim() : '';
        const tier = tierOf(row.tier);

        if (!STEAM_ID.test(steamId) || tier === null) {
          errors.push({
            field: `grants[${String(index)}]`,
            code: DOMAIN_ERROR_CODES.invalidValue,
          });
          continue;
        }

        // ####  `expiresAt` AUSENTE NÃO É VITALÍCIO  ####
        //
        // Ele TEM de vir, e `null` é como se diz "vitalício" de
        // propósito — a mesma regra do `POST /vips`. O motivo é o
        // preço do engano: um campo esquecido viraria VIP eterno de
        // graça, e ninguém repara num benefício que sobra.
        if (!('expiresAt' in row)) {
          errors.push({ field: `grants[${steamId}:${tier}]`, code: DOMAIN_ERROR_CODES.invalidShape });
          continue;
        }

        const rawExpires = row.expiresAt;
        let expiresAt: number | null = null;

        if (rawExpires !== null) {
          const parsed = typeof rawExpires === 'string' ? Date.parse(rawExpires) : NaN;

          if (!Number.isFinite(parsed)) {
            errors.push({
              field: `grants[${steamId}:${tier}]`,
              code: DOMAIN_ERROR_CODES.invalidValue,
            });
            continue;
          }

          expiresAt = parsed;
        }

        grants.push({ steamId, tier, expiresAt });
      }

      for (const [index, raw] of (rawRevocations as readonly unknown[]).entries()) {
        const row = (raw ?? {}) as Record<string, unknown>;
        const steamId = typeof row.steamId === 'string' ? row.steamId.trim() : '';
        const tier = tierOf(row.tier);

        if (!STEAM_ID.test(steamId) || tier === null) {
          errors.push({
            field: `revocations[${String(index)}]`,
            code: DOMAIN_ERROR_CODES.invalidValue,
          });
          continue;
        }

        revocations.push({ steamId, tier });
      }

      return { work: { grants, revocations }, errors };
    },

    async apply(work): Promise<DomainOutcome> {
      const errors: ConfigFieldError[] = [];

      let granted = 0;
      let revoked = 0;
      let alreadyRevoked = 0;

      for (const grant of work.grants) {
        try {
          await deps.vips.grant({
            steamId: grant.steamId,
            tier: grant.tier,
            expiresAt: grant.expiresAt,
            // `loja` é a origem de tudo que vem da venda, e é o que
            // a tela local já sabe desenhar. `adotado` continua
            // sendo só da reconciliação.
            origin: 'loja',
            createdBy: actor,
          });
          granted += 1;
        } catch (error) {
          // O código real sobe: `VIP_UNKNOWN_TIER` diz ao admin que
          // o nível não existe em servidor nenhum, e um genérico não
          // diria nada.
          errors.push({
            field: `grants[${grant.steamId}:${grant.tier}]`,
            code: error instanceof ApiError ? error.code : DOMAIN_ERROR_CODES.writeFailed,
          });
        }
      }

      for (const revocation of work.revocations) {
        try {
          await deps.vips.revoke(revocation.steamId, revocation.tier, actor);
          revoked += 1;
        } catch (error) {
          if (error instanceof ApiError && error.code === 'VIP_NOT_FOUND') {
            // Já não valia. O estado desejado é o que está lá.
            alreadyRevoked += 1;
            continue;
          }

          errors.push({
            field: `revocations[${revocation.steamId}:${revocation.tier}]`,
            code: error instanceof ApiError ? error.code : DOMAIN_ERROR_CODES.writeFailed,
          });
        }
      }

      return {
        applied: granted + revoked + alreadyRevoked > 0 || errors.length === 0,
        stats: { granted, revoked, alreadyRevoked },
        errors,
      };
    },
  };
}
