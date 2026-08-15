// ============================================================
//  routes/vips.ts  -  o VIP da rede, e o espelho dele em cada
//  servidor.
//
//      GET    /vips?active=1&q=&tier=&limit=&offset=
//      GET    /vips/tiers                    os níveis que existem
//      POST   /vips                          concede ou RENOVA
//      DELETE /vips/:steamId/:tier           revoga (a linha fica)
//      GET    /players/:steamId/vips         o que este jogador tem
//      POST   /servers/:id/vips/sync         reempurra agora
//
//  ####  O steamId É STRING, SEMPRE  ####
//
//  No parâmetro de rota, no corpo, no zod e na resposta. Um
//  SteamID64 tem 17 dígitos e passa de 2^53: um `z.coerce.number()`
//  aqui aceitaria o valor e o devolveria arredondado — o VIP iria
//  para a CONTA ERRADA, sem erro nenhum no caminho.
//
//  Por isso a revogação é por `:steamId/:tier`, e não pelo `id` da
//  linha: quem administra tem o SteamID na mão, não o número da
//  tabela.
//
//  ####  A ROTA NÃO DECIDE REGRA  ####
//
//  Renovar-estende-o-vencimento, o nível precisa existir, revogar
//  não apaga — tudo isso mora em vip/service.ts, e as mensagens em
//  português nascem lá. Aqui só se traduz HTTP.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { VipList } from '../../vip/service.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface VipRoutesDeps {
  readonly vips: VipList;
  /** Só para conferir que o `:id` de `/servers/:id/vips/sync` existe. */
  readonly servers: { ids(): readonly string[] };
}

/** Tamanho de página: o padrão e o teto. */
export const DEFAULT_VIPS_LIMIT = 50;
export const MAX_VIPS_LIMIT = 200;

const listQuery = z.object({
  /** `1` = só os que valem agora; `0` = só os que não valem mais. */
  active: z.enum(['0', '1']).optional(),
  q: z.string().optional(),
  tier: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_VIPS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const steamParams = z.object({ steamId: z.string().min(1) });
const revokeParams = steamParams.extend({ tier: z.string().min(1) });
const serverParams = z.object({ id: z.string().min(1) });

/**
 * O corpo da concessão.
 *
 * ####  O PRAZO É OBRIGATÓRIO, E `null` É VITALÍCIO  ####
 *
 * Diferente do banimento (onde ausente = permanente), aqui o campo
 * TEM de vir. O motivo é o preço do engano: um `expiresAt` que
 * alguém esqueceu de mandar viraria VIP eterno de graça, e ninguém
 * repara num benefício que sobra. Mandar `null` é dizer "vitalício"
 * de propósito.
 *
 * ISO-8601, e não "dias", pela mesma razão do ban: o cálculo do
 * vencimento é de quem vende — o agente não sabe se o pacote é de
 * 30 dias corridos ou de um mês de calendário.
 */
const grantBody = z
  .object({
    steamId: z.string().min(1),
    tier: z.string().trim().min(1).max(32),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    /**
     * De onde veio. `loja` é a compra; `painel`, a mão de um admin.
     *
     * `adotado` NÃO entra aqui: ele é o que a reconciliação escreve
     * ao encontrar alguém já dentro do grupo, e aceitá-lo pela API
     * deixaria a origem mentir sobre como aquele VIP nasceu.
     */
    origin: z.enum(['loja', 'painel']).default('painel'),
  })
  .strict();

export function registerVipRoutes(app: FastifyInstance, deps: VipRoutesDeps): void {
  /**
   * A lista, PAGINADA desde a primeira versão.
   *
   * `total` vai junto porque sem ele a tela não sabe se há página
   * seguinte — e sem saber, ou ela esconde gente ou oferece uma
   * página que não existe.
   */
  app.get('/vips', async (request) => {
    const { active, q, tier, limit, offset } = listQuery.parse(request.query);

    const page = deps.vips.list({
      active: active === undefined ? undefined : active === '1',
      query: q,
      tier,
      limit: limit ?? DEFAULT_VIPS_LIMIT,
      offset: offset ?? 0,
    });

    return {
      ok: true,
      // `count` é o que veio nesta página; `total`, o que casou com
      // o filtro. Sem os dois, a tela não distingue "acabou" de
      // "tem mais".
      count: page.vips.length,
      ...page,
      limit: limit ?? DEFAULT_VIPS_LIMIT,
      offset: offset ?? 0,
    };
  });

  /**
   * Os níveis que os servidores deste agente conhecem.
   *
   * ####  ELES VÊM DO `OrigemZVip.json`, E NÃO DE UMA LISTA NOSSA  ####
   *
   * É o que permite a tela oferecer os níveis num seletor em vez de
   * um campo de texto — digitar um nível que não existe é o jeito
   * mais rápido de vender um VIP que não vira efeito nenhum.
   *
   * `servers` diz onde cada um existe: um `gold` que só o `pvp1`
   * declara é uma informação, não um erro.
   */
  app.get('/vips/tiers', async () => {
    const tiers = [...(await deps.vips.knownTiers()).values()];

    return {
      ok: true,
      tiers: tiers.map((level) => ({
        tier: level.tier,
        group: level.group,
        title: level.title,
        rank: level.rank,
        parentGroup: level.parentGroup,
        servers: level.servers,
      })),
      message:
        tiers.length === 0
          ? 'Nenhum servidor declarou níveis de VIP ainda. Eles vêm do OrigemZVip.json de cada ' +
            'servidor, criado no primeiro carregamento do plugin.'
          : undefined,
    };
  });

  /**
   * Concede — ou RENOVA, somando sobre o vencimento que já existia.
   *
   * A renovação NÃO é um caminho diferente: o mesmo POST estende a
   * linha aberta. Uma rota separada para renovar abriria a chance
   * de a compra criar uma segunda concessão do mesmo nível, que o
   * índice único recusaria com um 500.
   */
  app.post('/vips', async (request, reply) => {
    const body = grantBody.parse(request.body);

    const { vip, outcome, results } = await deps.vips.grant({
      steamId: body.steamId,
      tier: body.tier,
      expiresAt: body.expiresAt === null ? null : Date.parse(body.expiresAt),
      origin: body.origin,
      createdBy: operatorOf(request),
    });

    const pending = results.filter((result) => result.skipped !== null);

    return reply.status(outcome === 'created' ? 201 : 200).send({
      ok: true,
      vip,
      outcome,
      results,
      message:
        (outcome === 'created'
          ? `${vip.steamId} agora é VIP ${vip.tier}`
          : `O VIP ${vip.tier} de ${vip.steamId} foi renovado`) +
        (vip.expiresAt === null
          ? ' (vitalício).'
          : ` até ${new Date(vip.expiresAt).toLocaleDateString('pt-BR')}.`) +
        (pending.length === 0
          ? ''
          : ` ${String(pending.length)} servidor(es) não receberam o estado agora e serão ` +
            'conferidos quando voltarem.'),
    });
  });

  /**
   * Revoga.
   *
   * A linha continua no histórico, com quem revogou e quando — ver
   * a migração 010. Apagar responderia "quem é VIP?" e destruiria
   * "quem já foi, e por quê".
   */
  app.delete('/vips/:steamId/:tier', async (request) => {
    const { steamId, tier } = revokeParams.parse(request.params);

    const { vip, results } = await deps.vips.revoke(steamId, tier, operatorOf(request));
    const pending = results.filter((result) => result.skipped !== null);

    return {
      ok: true,
      vip,
      results,
      message:
        `${steamId} deixou de ser VIP ${vip.tier}. A linha fica no histórico com quem revogou.` +
        (pending.length === 0
          ? ''
          : ` ${String(pending.length)} servidor(es) não receberam a mudança agora — o grupo do ` +
            'Oxide deles será conferido quando voltarem.'),
    };
  });

  /**
   * O que este jogador tem, e o que ele já teve.
   *
   * Os dois na mesma resposta porque a ficha mostra os dois: o
   * bloco de VIP diz o que vale agora, e o histórico explica o "ele
   * disse que já foi Ouro".
   */
  app.get('/players/:steamId/vips', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    return {
      ok: true,
      active: deps.vips.activeOf(steamId),
      history: deps.vips.historyOf(steamId),
    };
  });

  /**
   * Reempurra o estado AGORA, e reconcilia os grupos.
   *
   * O caminho normal é automático (boot, servidor ligado, RCON
   * reconectado). Este botão existe para o caso de alguém ter
   * mexido nos grupos à mão e querer conferir sem esperar.
   */
  app.post('/servers/:id/vips/sync', async (request) => {
    const { id } = serverParams.parse(request.params);

    if (!deps.servers.ids().includes(id)) {
      throw new ApiError(
        'UNKNOWN_SERVER',
        `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
          `${deps.servers.ids().join(', ') || '(nenhum)'}.`,
        404,
      );
    }

    const result = await deps.vips.reconcile(id);

    return {
      ok: true,
      ...result,
      message:
        result.skipped ??
        `Estado de VIP empurrado para ${id}: ${String(result.players)} jogador(es). ` +
          `${String(result.added.length)} entraram no grupo, ` +
          `${String(result.removed.length)} saíram, ` +
          `${String(result.adopted.length)} foram adotados de quem já estava lá.`,
    };
  });
}
