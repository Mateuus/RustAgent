// ============================================================
//  routes/rustmaps.ts  -  a PRÉVIA do mapa.
//
//      GET  /wipe/rustmaps/status                    a chave
//      POST /servers/:id/wipe/maps/:mapId/generate   pedir agora
//
//  Duas rotas, e elas fazem coisas de tamanhos bem diferentes: a
//  primeira desenha o cabeçalho do bloco RUSTMAPS da tela; a
//  segunda é o botão "gerar a prévia" de uma entrada da fila.
//
//  ------------------------------------------------------------
//  ####  A CHAVE NÃO SAI DAQUI  ####
//
//  `RUSTMAPS_API_KEY` vive no `.env`, e a rota de status responde
//  só *válida/inválida*, o plano e a cota. Nem prefixo, nem
//  últimos quatro dígitos: uma chave que aparece na tela aparece
//  também no print que alguém cola no Discord.
//
//  ------------------------------------------------------------
//  ####  E NENHUMA DELAS PODE SEGURAR UM WIPE  ####
//
//  O `POST` responde 200 mesmo quando o RustMaps está fora do ar
//  — com a frase dizendo o que houve. Devolver 5xx faria a tela
//  pintar de vermelho uma fila que está perfeitamente utilizável:
//  num mundo procedural a seed É o mapa, e a imagem é enfeite.
//  Ver Docs\17 §"Frente H", regra 1.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { MapPoolRecord, MapPoolRepository } from '../../db/map-pool-repository.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import type { RustMapsWatcher } from '../../wipe/rustmaps-poll.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface RustMapsRoutesDeps {
  readonly watcher: RustMapsWatcher;
  readonly repository: MapPoolRepository;
  readonly supervisor: ServerSupervisor;
}

const mapParams = z.object({
  id: z.string().min(1),
  mapId: z.coerce.number().int().positive(),
});

/**
 * O corpo do "gerar agora".
 *
 * `staging` é OPCIONAL de propósito: o normal é o agente decidir
 * sozinho (a entrada aponta para um wipe forçado?), e a mão só
 * entra quando alguém quer justamente o contrário do automático.
 */
const generateBody = z
  .object({ staging: z.boolean().optional() })
  .strict()
  .optional();

/**
 * `?refresh=1` fura o cache do retrato da chave.
 *
 * Texto, e não `z.coerce.boolean()`: aquele transforma QUALQUER
 * string não vazia em `true`, e `?refresh=0` passaria a
 * significar o contrário do que está escrito.
 */
const statusQuery = z.object({ refresh: z.enum(['0', '1', 'true', 'false']).optional() });

export function registerRustMapsRoutes(app: FastifyInstance, deps: RustMapsRoutesDeps): void {
  /**
   * A chave serve, e quanto ainda cabe nela?
   *
   * Sem `?refresh=1` a resposta vem do último retrato (ver
   * `RUSTMAPS_STATUS_TTL_MS`): a tela de mapas recarrega sozinha,
   * e perguntar ao RustMaps a cada abertura gastaria cota para
   * redesenhar o mesmo cadeado.
   */
  app.get('/wipe/rustmaps/status', async (request) => {
    const query = statusQuery.parse(request.query ?? {});
    const refresh = query.refresh === '1' || query.refresh === 'true';
    const key = await deps.watcher.keyStatus(refresh);
    const state = deps.watcher.state();

    return {
      ok: true,
      configured: key.configured,
      valid: key.valid,
      plan: key.plan,
      quota: key.quota,
      checkedAt: key.checkedAt,
      autoGenerate: state.autoGenerate,
      disabledReason: state.disabledReason,
      backoffUntil: state.backoffUntil,
      /** O teto que a API ANUNCIA — e que ninguém mediu. Ver Docs\17. */
      announcedRateLimit: state.announcedRateLimit,
      callsPerTick: state.callsPerTick,
      message: key.message,
    };
  });

  /**
   * Pede a prévia de uma entrada da fila, agora.
   *
   * Responde 200 em todos os desfechos que não são culpa de quem
   * chamou — inclusive "o RustMaps está fora do ar". O que muda é
   * `outcome` e a frase; a fila continua exatamente utilizável.
   */
  app.post('/servers/:id/wipe/maps/:mapId/generate', async (request) => {
    const { id, mapId } = mapParams.parse(request.params);
    const body = generateBody.parse(request.body ?? {}) ?? {};

    assertServer(deps, id);

    const entry = deps.repository.get(id, mapId);

    if (entry === null) {
      throw new ApiError('MAP_NOT_FOUND', `O mapa ${String(mapId)} não está na fila.`, 404);
    }

    if (entry.status === 'used') {
      throw new ApiError(
        'MAP_ALREADY_USED',
        'Este mundo já foi jogado. Pedir a prévia dele agora só gastaria cota — a imagem que ' +
          'interessa é a do próximo.',
        409,
      );
    }

    const result = await deps.watcher.generate(id, mapId, { staging: body.staging });

    request.log.info(
      {
        server: id,
        map: mapId,
        seed: entry.seed,
        outcome: result.outcome.kind,
        by: operatorOf(request),
      },
      'prévia do RustMaps pedida',
    );

    return {
      ok: true,
      map: toResponse(result.entry),
      outcome: result.outcome.kind,
      message: result.message,
    };
  });
}

/**
 * A entrada da fila como a tela a lê.
 *
 * A forma é a MESMA de routes/wipe-maps.ts de propósito: as duas
 * rotas devolvem a mesma linha, e um campo a mais aqui viraria um
 * `undefined` na tela dependendo de qual chamada respondeu por
 * último.
 */
function toResponse(entry: MapPoolRecord) {
  return {
    id: entry.id,
    serverId: entry.serverId,
    position: entry.position,
    kind: entry.kind,
    seed: entry.seed,
    worldSize: entry.worldSize,
    level: entry.level,
    levelUrl: entry.levelUrl,
    rustmapsId: entry.rustmapsId,
    staging: entry.staging,
    previewUrl: entry.previewUrl,
    thumbUrl: entry.thumbUrl,
    monuments: entry.monuments,
    status: entry.status,
    lastError: entry.lastError,
    versionOk: entry.versionOk,
    note: entry.note,
    usedAt: entry.usedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** @throws {ApiError} 404 quando o servidor não existe neste agente. */
function assertServer(deps: RustMapsRoutesDeps, id: string): void {
  if (deps.supervisor.ids().includes(id)) {
    return;
  }

  throw new ApiError(
    'UNKNOWN_SERVER',
    `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
      `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
    404,
  );
}
