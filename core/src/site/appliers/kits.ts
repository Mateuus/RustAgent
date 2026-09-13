// ============================================================
//  appliers/kits.ts  -  os kits da rede, na opinião do site.
//
//  ####  A CHAVE É O `slug`, E NÃO O ID  ####
//
//  O id do kit é um inteiro AUTOINCREMENT desta máquina: o site não
//  o conhece, e não deveria. O `slug` é o identificador estável — é
//  o que a rota local já trata como tal (`KIT_SLUG_TAKEN`), e é o
//  que sobrevive a um kit apagado e recriado.
//
//  ####  `servers[]` VEM COM O ID DO SITE  ####
//
//  O site conhece cada servidor pelo `SITE_SERVER_ID` que ele mesmo
//  cadastrou — o retrato periódico não manda o id local, e não vai
//  mandar. Por isso a lista é traduzida aqui, na fronteira. Um id
//  que não casa com pareamento nenhum vira `UNKNOWN_REFERENCE`: o
//  kit entra sem aquele servidor, e o site vê qual foi.
//
//  ####  SNAPSHOT SUBSTITUI  ####
//
//  Kit que sumiu do `desired` é kit removido — junto com o histórico
//  de resgates dele, que é o que `remove` já faz. Um `kits: []` por
//  engano apaga todos, e é por isso que a chave `kits` ausente é
//  `INVALID_SHAPE` em vez de "lista vazia".
//
//  Ver Docs\23-CONFIG-PELO-SITE.md §4.
// ============================================================

import type { KitInput, KitsRepository } from '../../db/kits-repository.js';
import { kitBody, toKitInput } from '../../http/routes/kits.js';
import type { ConfigFieldError } from '../client.js';
import {
  DOMAIN_ERROR_CODES,
  type DomainApplier,
  type DomainOutcome,
  type DomainPlan,
} from '../domains.js';

export interface KitsWork {
  readonly kits: readonly KitInput[];
  /**
   * Pode remover o que não veio?
   *
   * `false` quando alguma linha ficou de fora pela régua — pelo
   * mesmo motivo da loja: um defeito de serialização do outro lado
   * apagaria todos os kits, com um ACK dizendo `applied: true`. Ver
   * `appliers/store.ts`.
   *
   * O `servers[]` que não casou NÃO conta: aquele kit entrou, e a
   * lista continua completa.
   */
  readonly prune: boolean;
}

export interface KitsApplierDeps {
  readonly repository: KitsRepository;
  /**
   * O id LOCAL de um servidor, a partir do id que o site usa.
   *
   * `null` = nenhum servidor deste agente está pareado com aquele
   * id. Ver o cabeçalho.
   */
  readonly localServerId: (siteServerId: string) => string | null;
}

export function kitsApplier(deps: KitsApplierDeps): DomainApplier<KitsWork> {
  return {
    domain: 'kits',

    plan(desired): DomainPlan<KitsWork> {
      if (!Array.isArray(desired.kits)) {
        return { work: null, errors: [{ field: 'kits', code: DOMAIN_ERROR_CODES.invalidShape }] };
      }

      const errors: ConfigFieldError[] = [];
      const kits: KitInput[] = [];
      const seen = new Set<string>();

      for (const [index, raw] of (desired.kits as readonly unknown[]).entries()) {
        const parsed = kitBody.safeParse(raw);

        if (!parsed.success) {
          // O `slug` é o que nomeia a linha na tela do site — e
          // quando ele é justamente o campo inválido, sobra o
          // índice.
          const row = (raw ?? {}) as Record<string, unknown>;
          const label = typeof row.slug === 'string' && row.slug !== '' ? row.slug : String(index);

          errors.push({ field: `kits[${label}]`, code: DOMAIN_ERROR_CODES.invalidValue });
          continue;
        }

        const kit = parsed.data;

        if (seen.has(kit.slug)) {
          errors.push({ field: `kits[${kit.slug}]`, code: DOMAIN_ERROR_CODES.invalidValue });
          continue;
        }

        const servers: string[] = [];

        for (const siteServerId of kit.servers) {
          const local = deps.localServerId(siteServerId);

          if (local === null) {
            errors.push({
              field: `kits[${kit.slug}].servers[${siteServerId}]`,
              code: DOMAIN_ERROR_CODES.unknownReference,
            });
            continue;
          }

          servers.push(local);
        }

        seen.add(kit.slug);

        // ####  O SITE NÃO CONHECE A ARTE PRÓPRIA  ####
        //
        // O `iconFile` não vem no payload dele, e é por isso que o
        // schema o trata como OMITIDO e não como `null`: aplicar os
        // kits do site apagaria a arte que alguém escolheu no painel.
        kits.push({ ...toKitInput(kit, deps.repository.getBySlug(kit.slug)), servers });
      }

      // O servidor que não casou é erro DE LINHA, e não de lista: o
      // kit entrou, e o snapshot continua inteiro.
      const incomplete = errors.some((error) => !error.field.includes('.servers['));

      return { work: { kits, prune: !incomplete }, errors };
    },

    apply(work): Promise<DomainOutcome> {
      const errors: ConfigFieldError[] = [];
      const kept = new Set(work.kits.map((kit) => kit.slug));

      let created = 0;
      let updated = 0;

      for (const kit of work.kits) {
        try {
          const existing = deps.repository.getBySlug(kit.slug);

          if (existing === null) {
            deps.repository.create(kit);
            created += 1;
          } else {
            deps.repository.update(existing.id, kit);
            updated += 1;
          }
        } catch {
          errors.push({ field: `kits[${kit.slug}]`, code: DOMAIN_ERROR_CODES.writeFailed });
        }
      }

      let removed = 0;

      if (work.prune) {
        for (const kit of deps.repository.list()) {
          if (!kept.has(kit.slug) && deps.repository.remove(kit.id)) {
            removed += 1;
          }
        }
      }

      return Promise.resolve({
        applied: created + updated + removed > 0 || errors.length === 0,
        stats: { created, updated, removed },
        errors,
      });
    },
  };
}
