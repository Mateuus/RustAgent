// ============================================================
//  Testes do AVISO À INTERFACE quando um card muda.
//
//  ####  ISTO ACONTECEU DE VERDADE, EM 11/09/2026  ####
//
//  O dono pôs uma arte no Kit Inicial pelo painel, abriu o jogo e o
//  card continuou com o ícone do primeiro item. A arte estava no
//  banco e o arquivo em `Assets\kits` — o que faltava era ela CHEGAR
//  ao servidor: os bytes viajam com a carga da interface, e salvar um
//  kit não a disparava. Ela só apareceria na volta periódica (5 min).
//
//  A página KITS e a vitrine são geradas a cada clique, então nome,
//  preço e regra aparecem na hora — e é justamente isso que faz a
//  arte parada parecer defeito.
//
//  E o aviso NUNCA pode derrubar a rota: a edição já foi gravada, e
//  um envio que falha não pode desfazê-la.
// ============================================================

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KitsRepository } from '../src/db/kits-repository.js';
import type { KitStore } from '../src/kits/service.js';
import { apiErrorToResponse, isApiError } from '../src/http/error-response.js';
import { registerKitRoutes } from '../src/http/routes/kits.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';

const KIT = {
  id: 1,
  slug: 'kit-inicial',
  name: 'Kit Inicial',
  description: null,
  iconFile: null as string | null,
  category: null,
  kind: 'resgate' as const,
  cooldownSeconds: null,
  useLimit: 1,
  useResetOn: 'never' as const,
  wipeDelaySeconds: null,
  requiredTier: null,
  requiredTierExact: false,
  items: [],
  enabled: true,
  servers: [],
  claimCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

/** O corpo que o painel manda ao salvar. */
const BODY = {
  slug: KIT.slug,
  name: KIT.name,
  kind: 'resgate',
  items: [],
  iconFile: 'kit.png',
};

let app: FastifyInstance | null = null;

function buildApp(onArtChanged: () => void): FastifyInstance {
  const repository = {
    get: () => KIT,
    getBySlug: () => null,
    create: () => KIT,
    update: () => KIT,
    remove: () => true,
  } as unknown as KitsRepository;

  const instance = Fastify();

  instance.setErrorHandler((error, _request, reply) => {
    if (isApiError(error)) {
      const { statusCode, body } = apiErrorToResponse(error);

      return reply.status(statusCode).send(body);
    }

    return reply.status(500).send({ ok: false, error: String(error) });
  });

  instance.register(
    async (api) => {
      registerKitRoutes(api, {
        store: { get: () => KIT, list: () => [KIT] } as unknown as KitStore,
        repository,
        supervisor: { ids: () => ['pvp1'] } as unknown as ServerSupervisor,
        onArtChanged,
      });
    },
    { prefix: '/api' },
  );

  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('salvar um kit avisa a interface', () => {
  it('no POST, no PUT e no DELETE', async () => {
    const avisou = vi.fn();
    const instance = buildApp(avisou);

    await instance.inject({ method: 'POST', url: '/api/kits', payload: BODY });
    expect(avisou).toHaveBeenCalledTimes(1);

    await instance.inject({ method: 'PUT', url: '/api/kits/1', payload: BODY });
    expect(avisou).toHaveBeenCalledTimes(2);

    // O DELETE também: sem ele, a arte do kit apagado ficaria na
    // tabela do plugin até a próxima poda.
    await instance.inject({ method: 'DELETE', url: '/api/kits/1' });
    expect(avisou).toHaveBeenCalledTimes(3);
  });

  it('o aviso que estoura NÃO derruba a rota', async () => {
    const instance = buildApp(() => {
      throw new Error('o RCON caiu no meio');
    });

    const response = await instance.inject({ method: 'PUT', url: '/api/kits/1', payload: BODY });

    // A edição já está no banco. Devolver 500 aqui faria quem salvou
    // tentar de novo — e a segunda tentativa gravaria o mesmo.
    expect(response.statusCode).toBe(200);
  });
});
