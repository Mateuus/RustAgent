// ============================================================
//  appliers/store.ts  -  a vitrine que o site quer que exista.
//
//  ####  O SNAPSHOT É A LOJA INTEIRA  ####
//
//  `categories` e `offers` vêm SEMPRE as duas, e completas. Produto
//  que sumiu do snapshot sai da loja; categoria que sumiu leva as
//  ofertas dela junto (é o que `removeCategory` já faz, em cascata).
//
//  Por isso um snapshot em que falte uma das duas chaves é recusado
//  inteiro, com `INVALID_SHAPE`: um `desired` com `categories: []`
//  por engano apagaria a loja de todo mundo, e o ACK diria
//  `applied: true`.
//
//  ####  A RÉGUA É A DA ROTA LOCAL, LITERALMENTE  ####
//
//  `storeCategoryBody` e `storeOfferBody` são os MESMOS objetos zod
//  que o `POST /store/offers` usa — importados, não copiados. Uma
//  segunda régua para a mesma tabela é uma régua que vai divergir, e
//  a que ficar mais frouxa é a que grava.
//
//  ####  A RECEITA DA ENTREGA VIAJA NESTA DIREÇÃO  ####
//
//  O espelho que SAI daqui não leva `items[]`, `vip` nem `vehicle`:
//  o painel do site precisa VER a loja, não saber como o item
//  nasce. Mas para MANDAR uma oferta o site precisa dizer o que ela
//  entrega — e é por isso que o `desired` tem os três campos que o
//  espelho esconde.
//
//  Ver Docs\23-CONFIG-PELO-SITE.md §3.
// ============================================================

import type { StoreCategoryInput, StoreOfferInput, StoreRepository } from '../../db/store-repository.js';
import { storeCategoryBody, storeOfferBody, toOfferInput } from '../../http/routes/store.js';
import type { ConfigFieldError } from '../client.js';
import {
  DOMAIN_ERROR_CODES,
  type DomainApplier,
  type DomainOutcome,
  type DomainPlan,
} from '../domains.js';

/** O id de uma linha da loja: o do SITE, e ele manda. */
const MAX_ID = 64;

export interface StoreWork {
  readonly categories: readonly { readonly id: string; readonly input: StoreCategoryInput }[];
  readonly offers: readonly { readonly id: string; readonly input: StoreOfferInput }[];
  /**
   * Pode remover o que não veio?
   *
   * ####  SÓ UM SNAPSHOT INTEIRO APAGA  ####
   *
   * `false` quando alguma linha ficou de fora pela régua. O caso que
   * isto mata é o pior deste canal: um defeito de serialização do
   * outro lado invalida as quarenta ofertas, o snapshot chega
   * "vazio" para efeito de comparação, e a loja inteira some — com
   * um ACK dizendo `applied: true` e quarenta erros que ninguém leu
   * a tempo.
   *
   * Com `false`, o que passou na régua é gravado, nada é removido, e
   * a versão seguinte — já corrigida — faz a limpeza.
   */
  readonly prune: boolean;
}

export interface StoreApplierDeps {
  readonly repository: StoreRepository;
  /**
   * O espelho precisa saber que a loja mudou.
   *
   * Sem isto, o catálogo que o próprio site mandou só apareceria no
   * painel dele um minuto depois, pelo relógio — e o admin, que
   * acabou de salvar, concluiria que não gravou.
   */
  readonly onChanged?: () => void;
  readonly now?: () => number;
}

/**
 * Um id de linha: texto curto, e sem espaço em branco nas pontas.
 *
 * Quem o gera é o SITE — igual ao `DLV-` da entrega e ao `CMD-` do
 * comando. O agente não inventa id para coisa que é de lá: se ele
 * inventasse, o site não conseguiria mandar a versão seguinte da
 * mesma oferta.
 */
function idOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' || trimmed.length > MAX_ID ? null : trimmed;
}

/** Uma lista do `desired`. `null` = não é lista. */
function listOf(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function storeApplier(deps: StoreApplierDeps): DomainApplier<StoreWork> {
  const now = deps.now ?? ((): number => Date.now());

  return {
    domain: 'store',

    plan(desired): DomainPlan<StoreWork> {
      const rawCategories = listOf(desired.categories);
      const rawOffers = listOf(desired.offers);

      if (rawCategories === null || rawOffers === null) {
        // As duas, sempre. Ver o cabeçalho: meia loja é pior que
        // nenhuma.
        return {
          work: null,
          errors: [{ field: 'store', code: DOMAIN_ERROR_CODES.invalidShape }],
        };
      }

      const errors: ConfigFieldError[] = [];
      const categories: { id: string; input: StoreCategoryInput }[] = [];
      const offers: { id: string; input: StoreOfferInput }[] = [];
      const seenCategories = new Set<string>();
      const seenOffers = new Set<string>();

      for (const [index, raw] of rawCategories.entries()) {
        const row = (raw ?? {}) as Record<string, unknown>;
        const id = idOf(row.id);

        if (id === null) {
          errors.push({
            field: `categories[${String(index)}]`,
            code: DOMAIN_ERROR_CODES.invalidValue,
          });
          continue;
        }

        const { id: _categoryId, ...fields } = row;
        const parsed = storeCategoryBody.safeParse(fields);

        if (!parsed.success) {
          errors.push({ field: `categories[${id}]`, code: DOMAIN_ERROR_CODES.invalidValue });
          continue;
        }

        if (seenCategories.has(id)) {
          // Duas linhas com o mesmo id: a segunda apagaria a
          // primeira em silêncio, e o site veria as duas na tela.
          errors.push({ field: `categories[${id}]`, code: DOMAIN_ERROR_CODES.invalidValue });
          continue;
        }

        seenCategories.add(id);
        categories.push({ id, input: parsed.data });
      }

      for (const [index, raw] of rawOffers.entries()) {
        const row = (raw ?? {}) as Record<string, unknown>;
        const id = idOf(row.id);

        if (id === null) {
          errors.push({
            field: `offers[${String(index)}]`,
            code: DOMAIN_ERROR_CODES.invalidValue,
          });
          continue;
        }

        const { id: _offerId, ...fields } = row;
        const parsed = storeOfferBody.safeParse(fields);

        if (!parsed.success) {
          errors.push({ field: `offers[${id}]`, code: DOMAIN_ERROR_CODES.invalidValue });
          continue;
        }

        if (seenOffers.has(id)) {
          errors.push({ field: `offers[${id}]`, code: DOMAIN_ERROR_CODES.invalidValue });
          continue;
        }

        if (!seenCategories.has(parsed.data.categoryId)) {
          // A categoria precisa vir NO MESMO snapshot: apontar para
          // uma que só existe no banco faria a oferta sumir junto na
          // vez em que aquela categoria fosse removida.
          errors.push({ field: `offers[${id}]`, code: DOMAIN_ERROR_CODES.unknownReference });
          continue;
        }

        seenOffers.add(id);

        // ####  O SITE NÃO CONHECE A ARTE PRÓPRIA  ####
        //
        // O `icon.file` não vem no payload dele, e é por isso que o
        // schema o trata como OMITIDO e não como `null`: aplicar a
        // loja do site apagaria o PNG que alguém escolheu no painel.
        // `toOfferInput` conserva o que está gravado.
        offers.push({
          id,
          input: toOfferInput(parsed.data, deps.repository.getOffer(id)),
        });
      }

      return { work: { categories, offers, prune: errors.length === 0 }, errors };
    },

    apply(work): Promise<DomainOutcome> {
      const errors: ConfigFieldError[] = [];
      const at = now();
      const keptCategories = new Set(work.categories.map((category) => category.id));
      const keptOffers = new Set(work.offers.map((offer) => offer.id));

      let categoriesWritten = 0;
      let offersWritten = 0;

      // A ordem importa: categoria ANTES da oferta que aponta para
      // ela, e as remoções por último — remover primeiro deixaria a
      // loja vazia durante a gravação, e é nesse instante que um
      // jogador abre a vitrine.
      for (const category of work.categories) {
        try {
          deps.repository.saveCategory(category.id, category.input, at);
          categoriesWritten += 1;
        } catch {
          errors.push({
            field: `categories[${category.id}]`,
            code: DOMAIN_ERROR_CODES.writeFailed,
          });
        }
      }

      for (const offer of work.offers) {
        try {
          deps.repository.saveOffer(offer.id, offer.input, at);
          offersWritten += 1;
        } catch {
          errors.push({ field: `offers[${offer.id}]`, code: DOMAIN_ERROR_CODES.writeFailed });
        }
      }

      let offersRemoved = 0;
      let categoriesRemoved = 0;

      // As remoções por último, e só num snapshot inteiro. Ver
      // `StoreWork.prune`.
      if (work.prune) {
        for (const offer of deps.repository.listOffers()) {
          if (!keptOffers.has(offer.id) && deps.repository.removeOffer(offer.id)) {
            offersRemoved += 1;
          }
        }

        for (const category of deps.repository.listCategories()) {
          if (!keptCategories.has(category.id) && deps.repository.removeCategory(category.id)) {
            categoriesRemoved += 1;
          }
        }
      }

      deps.onChanged?.();

      return Promise.resolve({
        // Uma loja que entrou sem linha nenhuma escrita e sem nada
        // removido não aplicou coisa alguma.
        applied:
          categoriesWritten + offersWritten + offersRemoved + categoriesRemoved > 0 ||
          errors.length === 0,
        stats: {
          categories: categoriesWritten,
          offers: offersWritten,
          categoriesRemoved,
          offersRemoved,
        },
        errors,
      });
    },
  };
}
