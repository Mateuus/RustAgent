// ============================================================
//  routes/bans.ts  -  a BanList, e o espelho dela em cada
//  servidor.
//
//  Duas famílias de rota, porque são dois assuntos:
//
//      /api/bans                a lista do AGENTE — a fonte
//      /api/servers/:id/bans    o que vale NAQUELE servidor, e de
//                               onde veio
//
//  ####  O steamId É STRING, SEMPRE  ####
//
//  No parâmetro de rota, no corpo, no zod e na resposta. Um
//  SteamID64 tem 17 dígitos e passa de 2^53: um `z.number()` aqui
//  aceitaria o valor e o devolveria arredondado — o ban iria para
//  a CONTA ERRADA, sem erro nenhum no caminho.
//
//  Por isso `z.string()` e nunca `z.coerce.number()`, e por isso a
//  revogação é por `:steamId` e não pelo `id` da linha: quem
//  administra tem o SteamID na mão, não o número da tabela.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { BanList } from '../../bans/service.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface BanRoutesDeps {
  readonly bans: BanList;
  readonly supervisor: ServerSupervisor;
}

const listQuery = z.object({
  /** `1` = só os que ainda não foram revogados. */
  active: z.enum(['0', '1']).optional(),
  q: z.string().optional(),
});

const serverParams = z.object({ id: z.string().min(1) });
const steamParams = z.object({ steamId: z.string().min(1) });

const createBody = z
  .object({
    steamId: z.string().min(1),
    name: z.string().trim().max(64).optional(),
    reason: z
      .string()
      .trim()
      .min(1, 'diga o motivo — é ele que aparece para o jogador e no histórico')
      .max(200),
    scope: z.enum(['network', 'servers']),
    /** Só no escopo `servers`. Ver o cabeçalho da migração 005. */
    servers: z.array(z.string().min(1)).optional(),
    /**
     * ISO-8601. `null` ou ausente = permanente.
     *
     * ISO, e não "dias": o cálculo do vencimento é da tela, que
     * sabe o fuso de quem está olhando. Guardar "7 dias" aqui
     * exigiria decidir a partir de quando eles contam.
     */
    expiresAt: z.string().datetime({ message: 'expiresAt precisa ser uma data ISO-8601' }).nullish(),
  })
  .strict();

export function registerBanRoutes(app: FastifyInstance, deps: BanRoutesDeps): void {
  // ==========================================================
  //  A lista global
  // ==========================================================

  app.get('/bans', async (request) => {
    const { active, q } = listQuery.parse(request.query);

    return {
      ok: true,
      bans: deps.bans.list({ active: active === '1', query: q }),
      // Os ids servem ao formulário: escolher os servidores de um
      // ban específico sem ter de adivinhar como eles se chamam.
      servers: deps.supervisor.ids(),
    };
  });

  app.post('/bans', async (request, reply) => {
    const body = createBody.parse(request.body);

    const result = await deps.bans.create({
      steamId: body.steamId,
      name: body.name ?? null,
      reason: body.reason,
      scope: body.scope,
      servers: body.servers ?? [],
      expiresAt: body.expiresAt == null ? null : Date.parse(body.expiresAt),
      createdBy: operatorOf(request),
    });

    return reply.status(201).send({
      ok: true,
      ...result,
      // ####  APLICADO NÃO É O MESMO QUE GRAVADO  ####
      //
      // A linha existe a partir daqui; o `banid` só chega aos
      // servidores que estão no ar. Os outros recebem na
      // reconciliação do próximo start — e dizer isso é o que evita
      // a conclusão de que o ban "não pegou".
      message: banMessage(result.applied, result.pending),
    });
  });

  /**
   * Revoga. A linha FICA, com quem revogou e quando.
   *
   * `DELETE` no verbo e revogação no efeito: o recurso que some é
   * o BANIMENTO ATIVO daquele SteamID, que é o que quem chama quer
   * remover. O histórico não é recurso desta rota.
   */
  app.delete('/bans/:steamId', async (request) => {
    const { steamId } = steamParams.parse(request.params);
    const result = await deps.bans.revoke(steamId, operatorOf(request));

    return {
      ok: true,
      ...result,
      message: unbanMessage(steamId, result.removed, result.pending),
    };
  });

  // ==========================================================
  //  O que vale naquele servidor
  // ==========================================================

  app.get('/servers/:id/bans', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertKnownServer(deps, id);

    return {
      ok: true,
      bans: deps.bans.serverBans(id),
      // O estado do RCON vai junto porque ele decide o que a tela
      // pode oferecer: sem conexão, "Sincronizar agora" não tem o
      // que fazer, e um botão que falha sempre é pior que um botão
      // desabilitado dizendo por quê.
      connected: deps.supervisor.contextOf(id)?.rcon.isConnected ?? false,
    };
  });

  /**
   * Reconcilia agora.
   *
   * As três situações estão em bans/service.ts. O que a rota
   * acrescenta é uma frase: uma resposta `{ok:true}` sem contar o
   * que mudou faria "sincronizado" parecer o mesmo que "não fiz
   * nada" — e eles são diferentes.
   */
  app.post('/servers/:id/bans/sync', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertKnownServer(deps, id);

    const result = await deps.bans.reconcile(id);

    return { ok: true, ...result, message: syncMessage(result) };
  });
}

function assertKnownServer(deps: BanRoutesDeps, id: string): void {
  if (deps.supervisor.configOf(id) === null) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
        `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }
}

function banMessage(applied: readonly string[], pending: readonly string[]): string {
  const parts = [
    applied.length === 0
      ? 'Banimento gravado.'
      : `Banimento gravado e aplicado em ${applied.join(', ')}.`,
    pending.length === 0
      ? null
      : `${pending.join(', ')} não estava no ar — o banimento entra lá na reconciliação do ` +
        'próximo start.',
  ];

  return parts.filter((part): part is string => part !== null).join(' ');
}

function unbanMessage(
  steamId: string,
  removed: readonly string[],
  pending: readonly string[],
): string {
  const parts = [
    removed.length === 0
      ? `O banimento de ${steamId} foi revogado.`
      : `O banimento de ${steamId} foi revogado e o unban saiu em ${removed.join(', ')}.`,
    pending.length === 0
      ? null
      : `${pending.join(', ')} não estava no ar — o unban chega lá na reconciliação do próximo ` +
        'start.',
    'A linha continua no histórico, com a data e quem revogou.',
  ];

  return parts.filter((part): part is string => part !== null).join(' ');
}

function syncMessage(result: {
  readonly applied: readonly string[];
  readonly removed: readonly string[];
  readonly adopted: readonly string[];
  readonly extended: readonly string[];
  readonly skipped: string | null;
}): string {
  if (result.skipped !== null) {
    return result.skipped;
  }

  const parts = [
    result.applied.length === 0
      ? null
      : `${String(result.applied.length)} banimento(s) aplicado(s)`,
    result.removed.length === 0 ? null : `${String(result.removed.length)} unban(s) enviado(s)`,
    result.adopted.length === 0
      ? null
      : `${String(result.adopted.length)} banimento(s) que já estavam no servidor foram adotados`,
    result.extended.length === 0
      ? null
      : `${String(result.extended.length)} banimento(s) existente(s) passaram a valer aqui`,
  ].filter((part): part is string => part !== null);

  return parts.length === 0
    ? 'A lista deste servidor já estava igual à do agente. Nada a fazer.'
    : `${parts.join('; ')}.`;
}
