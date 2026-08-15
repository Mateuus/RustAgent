// ============================================================
//  routes/loadouts.ts  -  o que cada GRUPO daquele servidor recebe
//  ao nascer.
//
//      GET    /servers/:id/loadouts          os grupos + o kit de cada
//      PUT    /servers/:id/loadouts/:group   grava e empurra
//      DELETE /servers/:id/loadouts/:group   apaga e empurra
//      POST   /servers/:id/loadouts/sync     reempurra agora
//
//  ####  A LISTA VEM DOS GRUPOS, E NÃO DA NOSSA TABELA  ####
//
//  `GET` pergunta ao Oxide daquele servidor quais grupos existem
//  (`oxide.show groups`, por oxide/permissions.ts) e casa cada um
//  com o loadout guardado. Grupo novo aparece VAZIO, pronto para
//  receber; loadout cujo grupo sumiu aparece como ÓRFÃO, em vez de
//  o banco apagar sozinho o trabalho de alguém.
//
//  ####  LER FUNCIONA COM O SERVIDOR PARADO; GRAVAR TAMBÉM  ####
//
//  Diferente das permissões do Oxide, o loadout é NOSSO: ele mora
//  no SQLite, e gravá-lo com o servidor fora do ar é legítimo — a
//  configuração fica pronta e chega ao jogo na próxima conexão. O
//  que a resposta não pode é fingir que chegou: o `sync` dela diz
//  se o estado foi empurrado, ou por que não.
//
//  Com o servidor parado, a lista de grupos vem VAZIA e os loadouts
//  guardados aparecem com `exists: null` — dizer "órfão" ali seria
//  acusar de sumiço um grupo que ninguém perguntou.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { LoadoutsRepository } from '../../db/loadouts-repository.js';
import { loadoutItemsSchema } from '../../loadouts/items.js';
import type { LoadoutSync } from '../../loadouts/sync.js';
import { assertOxideName, readPermissions } from '../../oxide/permissions.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface LoadoutRoutesDeps {
  readonly repository: LoadoutsRepository;
  readonly sync: LoadoutSync;
  readonly supervisor: ServerSupervisor;
}

const serverParams = z.object({ id: z.string().min(1) });
const groupParams = serverParams.extend({ group: z.string().min(1) });

const saveBody = z
  .object({
    items: loadoutItemsSchema,
    /**
     * Desligado é diferente de apagado: o kit continua guardado e
     * some do payload empurrado ao jogo.
     */
    enabled: z.boolean().default(true),
  })
  .strict();

/**
 * @throws {ApiError} 404 quando o servidor não existe.
 *
 * Só o cadastro é exigido — e não o contexto: gravar loadout de um
 * servidor desligado é legítimo (ver o cabeçalho).
 */
function assertServer(deps: LoadoutRoutesDeps, id: string): void {
  if (deps.supervisor.configOf(id) === null) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
        `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }
}

export function registerLoadoutRoutes(app: FastifyInstance, deps: LoadoutRoutesDeps): void {
  app.get('/servers/:id/loadouts', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const saved = new Map(
      deps.repository.list(id).map((loadout) => [loadout.groupName, loadout] as const),
    );

    const context = deps.supervisor.contextOf(id);

    if (context === null || !context.rcon.isConnected) {
      // Sem RCON não dá para perguntar quais grupos existem. A tela
      // mostra o que ESTÁ guardado e diz que a lista está
      // incompleta — em vez de sugerir que o servidor não tem grupo
      // nenhum.
      return {
        ok: true,
        connected: false,
        groups: [...saved.values()].map((loadout) => ({
          name: loadout.groupName,
          exists: null,
          members: null,
          items: loadout.items,
          enabled: loadout.enabled,
          updatedAt: new Date(loadout.updatedAt).toISOString(),
          updatedBy: loadout.updatedBy,
        })),
        truncated: 0,
        message:
          `O RCON de "${id}" está fora do ar, então não dá para perguntar quais grupos existem ` +
          'nele. Abaixo estão os loadouts já gravados; a lista completa de grupos aparece assim ' +
          'que a conexão voltar.',
      };
    }

    const { groups, truncated } = await readPermissions(context.rcon);
    const seen = new Set<string>();

    const rows = groups.map((group) => {
      const loadout = saved.get(group.name);

      seen.add(group.name);

      return {
        name: group.name,
        /** O grupo existe no Oxide agora. */
        exists: true,
        members: group.members.length,
        items: loadout?.items ?? [],
        enabled: loadout?.enabled ?? true,
        updatedAt: loadout === undefined ? null : new Date(loadout.updatedAt).toISOString(),
        updatedBy: loadout?.updatedBy ?? null,
      };
    });

    // ####  OS ÓRFÃOS APARECEM, E NÃO SÃO APAGADOS  ####
    //
    // Um grupo removido do Oxide deixa o loadout dele sem dono. A
    // TELA mostra isso para quem administra decidir — apagar
    // sozinho jogaria fora meia hora de montagem por causa de um
    // `oxide.group remove` que talvez tenha sido engano.
    const orphans = [...saved.values()]
      .filter((loadout) => !seen.has(loadout.groupName))
      .map((loadout) => ({
        name: loadout.groupName,
        exists: false,
        members: 0,
        items: loadout.items,
        enabled: loadout.enabled,
        updatedAt: new Date(loadout.updatedAt).toISOString(),
        updatedBy: loadout.updatedBy,
      }));

    return {
      ok: true,
      connected: true,
      groups: [...rows, ...orphans],
      truncated,
      message:
        orphans.length === 0
          ? undefined
          : `${String(orphans.length)} loadout(s) apontam para grupos que não existem mais no ` +
            'Oxide deste servidor. Eles continuam guardados e NÃO vão para o jogo.',
    };
  });

  /**
   * Grava o loadout daquele grupo e empurra o estado completo.
   *
   * O grupo NÃO precisa existir no Oxide para receber loadout:
   * configurar antes de criar é uma ordem legítima, e recusar aqui
   * obrigaria à ida-e-volta "crie o grupo, volte, configure". O que
   * a resposta faz é DIZER quando o grupo não foi encontrado — pela
   * lista do `GET`, onde ele aparece como órfão.
   */
  app.put('/servers/:id/loadouts/:group', async (request) => {
    const { id, group } = groupParams.parse(request.params);
    const body = saveBody.parse(request.body);

    assertServer(deps, id);

    // O mesmo alfabeto dos grupos do Oxide: o nome viaja dentro do
    // payload que vai para a linha de comando do console, e um nome
    // com espaço ou aspa quebraria o JSON do outro lado.
    assertOxideName(group, 'grupo');

    const loadout = deps.repository.save({
      serverId: id,
      groupName: group,
      items: body.items,
      enabled: body.enabled,
      updatedBy: operatorOf(request),
    });

    const sync = await deps.sync.push(id, 'loadout-changed');

    request.log.info(
      { server: id, group, items: body.items.length, by: operatorOf(request) },
      'loadout gravado pelo painel',
    );

    return {
      ok: true,
      loadout: {
        name: loadout.groupName,
        items: loadout.items,
        enabled: loadout.enabled,
        updatedAt: new Date(loadout.updatedAt).toISOString(),
        updatedBy: loadout.updatedBy,
      },
      sync,
      message:
        sync.skipped ??
        `Loadout de "${group}" gravado com ${String(body.items.length)} item(ns) e empurrado ` +
          `para ${id}.` +
          (body.enabled
            ? ''
            : ' Ele está DESLIGADO: continua guardado aqui e não vai para o jogo.'),
    };
  });

  /**
   * Apaga o loadout daquele grupo.
   *
   * ####  E É ISSO QUE FAZ "APAGUEI" CHEGAR AO JOGO  ####
   *
   * O payload seguinte é o estado COMPLETO, e o grupo simplesmente
   * não estará nele — o plugin troca o cache inteiro e o nível fica
   * sem kit. Sem o envio, o loadout continuaria valendo no jogo até
   * o próximo reinício, e ninguém entenderia por quê.
   */
  app.delete('/servers/:id/loadouts/:group', async (request) => {
    const { id, group } = groupParams.parse(request.params);

    assertServer(deps, id);

    if (!deps.repository.remove(id, group)) {
      throw new ApiError(
        'LOADOUT_NOT_FOUND',
        `Não há loadout gravado para o grupo "${group}" em "${id}".`,
        404,
      );
    }

    const sync = await deps.sync.push(id, 'loadout-removed');

    request.log.warn({ server: id, group, by: operatorOf(request) }, 'loadout removido pelo painel');

    return {
      ok: true,
      sync,
      message:
        sync.skipped ??
        `Loadout de "${group}" apagado. Quem nascer nesse grupo em ${id} não recebe mais nada.`,
    };
  });

  /** Reempurra o estado completo agora. */
  app.post('/servers/:id/loadouts/sync', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const sync = await deps.sync.push(id, 'manual');

    return {
      ok: true,
      ...sync,
      message:
        sync.skipped ??
        `${String(sync.tiers)} chave(s) e ${String(sync.items)} item(ns) empurrados para ${id}; ` +
          `o plugin guardou ${String(sync.cachedTiers)} e ${String(sync.cachedItems)}.`,
    };
  });
}
