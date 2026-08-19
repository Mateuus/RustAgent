// ============================================================
//  routes/wipe-blueprints.ts  -  quem recomeça sabendo o quê.
//
//      GET    /servers/:id/wipe/blueprints            régua + snapshot
//      PUT    /servers/:id/wipe/blueprints/settings   a régua
//      POST   /servers/:id/wipe/blueprints/snapshot   tirar agora
//      POST   /servers/:id/wipe/blueprints/restore    um jogador
//
//  ####  NENHUMA DESTAS ROTAS APAGA NADA  ####
//
//  O snapshot LÊ o que o jogo sabe e grava no banco do agente; a
//  devolução ENSINA de volta. Quem apaga blueprint é o passo
//  `apagar` da execução, e a política de cada wipe é escolhida na
//  sub-aba Agenda.
//
//  ####  E O SNAPSHOT EXIGE O SERVIDOR NO AR  ####
//
//  Ele é lido pelo plugin, dentro do jogo. Com o RCON fora, a
//  resposta certa é 409 com a frase dizendo isso — e não um
//  snapshot vazio, que o wipe seguinte trataria como "ninguém
//  sabia nada" e apagaria tudo com o agente achando que guardou
//  uma cópia.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { BpRepository } from '../../db/bp-repository.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import {
  BP_RULE_MODES,
  MAX_BENCH,
  MAX_BP_DELAY_HOURS,
  type BlueprintService,
  type BpSettings,
} from '../../wipe/blueprints.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface WipeBlueprintRoutesDeps {
  readonly repository: BpRepository;
  readonly service: BlueprintService;
  readonly supervisor: ServerSupervisor;
}

const serverParams = z.object({ id: z.string().min(1) });

const settingsSchema = z
  .object({
    // O nome do nível é texto livre: ele vem do `OrigemZVip.json`
    // daquele servidor, e um `enum` aqui recusaria um nível que o
    // dono do servidor criou.
    tiers: z.record(
      z.string().min(1).max(40),
      z
        .object({
          mode: z.enum(BP_RULE_MODES),
          bench: z.number().int().min(1).max(MAX_BENCH),
        })
        .strict(),
    ),
    delayHours: z.number().int().min(0).max(MAX_BP_DELAY_HOURS),
  })
  .strict();

const restoreSchema = z
  .object({
    steamId: z.string().regex(/^\d{17}$/, 'steamId precisa ser um SteamID64 de 17 dígitos'),
    /** Devolve o snapshot inteiro mesmo sem VIP. É o botão do suporte. */
    force: z.boolean().optional(),
  })
  .strict();

const snapshotSchema = z.object({}).strict().optional();

export function registerWipeBlueprintRoutes(
  app: FastifyInstance,
  deps: WipeBlueprintRoutesDeps,
): void {
  /** A régua, o último snapshot e quanto já foi devolvido. */
  app.get('/servers/:id/wipe/blueprints', (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    return {
      ok: true,
      now: Date.now(),
      settings: deps.repository.getSettings(id),
      snapshot: deps.repository.lastSnapshot(id),
      counters: deps.repository.counters(id),
    };
  });

  app.put('/servers/:id/wipe/blueprints/settings', (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const settings: BpSettings = settingsSchema.parse(request.body);
    const saved = deps.repository.saveSettings(id, settings, Date.now());

    request.log.info(
      { server: id, by: operatorOf(request) },
      'régua de blueprints alterada pelo painel',
    );

    return {
      ok: true,
      now: Date.now(),
      settings: saved,
      message:
        saved.delayHours === 0
          ? 'Régua salva. A devolução sai assim que o jogador entrar.'
          : `Régua salva. A devolução sai ${String(saved.delayHours)} h depois do wipe.`,
    };
  });

  /**
   * Tira um snapshot AGORA.
   *
   * Ele substitui o anterior inteiro — é a mesma operação que o
   * wipe faz sozinho antes de apagar, e existe aqui para conferir
   * que o caminho funciona ANTES do dia do wipe.
   */
  app.post('/servers/:id/wipe/blueprints/snapshot', async (request) => {
    const { id } = serverParams.parse(request.params);

    snapshotSchema.parse(request.body ?? {});
    assertServer(deps, id);

    const context = deps.supervisor.contextOf(id);

    if (context === null || !context.rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `O RCON do servidor "${id}" está fora do ar. O snapshot de blueprints é lido pelo ` +
          'OrigemZAgent DENTRO do jogo: sem o servidor no ar não há a quem perguntar, e gravar ' +
          'um snapshot vazio faria o wipe seguinte apagar tudo achando que guardou uma cópia.',
        503,
      );
    }

    const result = await deps.service.snapshot({ serverId: id, wipeRunId: null });

    request.log.info(
      { server: id, players: result.players, items: result.items, by: operatorOf(request) },
      'snapshot de blueprints tirado pelo painel',
    );

    return {
      ok: true,
      now: Date.now(),
      snapshot: deps.repository.lastSnapshot(id),
      message:
        result.players === 0
          ? 'Nenhum jogador deste servidor tinha blueprint guardado. O snapshot ficou vazio.'
          : `${String(result.players)} jogador(es) e ${String(result.items)} blueprint(s) ` +
            'guardados. Ele vale para o próximo wipe, e só para ele.',
    };
  });

  /** A devolução na mão, de um jogador só. */
  app.post('/servers/:id/wipe/blueprints/restore', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = restoreSchema.parse(request.body);

    assertServer(deps, id);

    const result = await deps.service.restoreOne({
      serverId: id,
      steamId: body.steamId,
      force: body.force ?? false,
    });

    request.log.info(
      { server: id, steamId: body.steamId, sent: result.sent, by: operatorOf(request) },
      'devolução de blueprints pedida pelo painel',
    );

    return {
      ok: true,
      now: Date.now(),
      sent: result.sent,
      tier: result.tier,
      counters: deps.repository.counters(id),
      message: result.message,
    };
  });
}

/**
 * @throws {ApiError} 404 quando o servidor não existe neste agente.
 */
function assertServer(deps: WipeBlueprintRoutesDeps, serverId: string): void {
  if (deps.supervisor.configOf(serverId) === null) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${serverId}" neste agente. Os que existem: ` +
        `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }
}
