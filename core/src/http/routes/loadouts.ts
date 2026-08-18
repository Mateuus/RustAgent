// ============================================================
//  routes/loadouts.ts  -  o que cada GRUPO daquele servidor recebe
//  ao nascer.
//
//      GET    /servers/:id/loadouts          os grupos + o kit de cada
//      PUT    /servers/:id/loadouts/:group   grava e empurra
//      DELETE /servers/:id/loadouts/:group   apaga e empurra
//      POST   /servers/:id/loadouts/sync     reempurra agora
//
//  E o STATUS DE NASCIMENTO — a outra metade da mesma pergunta
//  ("com o que o jogador acorda") — pelas mesmas rotas, trocando o
//  substantivo:
//
//      GET    /servers/:id/spawn-status          os grupos + o status
//      PUT    /servers/:id/spawn-status/:group   grava e empurra
//      DELETE /servers/:id/spawn-status/:group   apaga e empurra
//      POST   /servers/:id/spawn-status/sync     reempurra agora
//
//  Os dois moram no mesmo arquivo porque compartilham a lista de
//  grupos e todas as regras abaixo. No JOGO eles são separados: vão
//  em comandos diferentes (`origemz.loadout.sync` e
//  `origemz.status.sync`), para caches diferentes do plugin — e por
//  isso desligar um não mexe no outro.
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
import {
  hasAnyAttribute,
  type SpawnStatusRepository,
} from '../../db/spawn-status-repository.js';
import { loadoutItemsSchema } from '../../loadouts/items.js';
import { spawnStatusValuesSchema, type SpawnStatusSync } from '../../loadouts/status.js';
import type { LoadoutSync } from '../../loadouts/sync.js';
import { assertOxideName, readPermissions } from '../../oxide/permissions.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface LoadoutRoutesDeps {
  readonly repository: LoadoutsRepository;
  readonly sync: LoadoutSync;
  /** O status de nascimento daquele grupo. Ver o cabeçalho. */
  readonly statusRepository: SpawnStatusRepository;
  readonly statusSync: SpawnStatusSync;
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

const saveStatusBody = spawnStatusValuesSchema.extend({ enabled: z.boolean().default(true) });

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

/** Uma linha da lista, antes de receber o kit ou o status. */
interface GroupRow {
  readonly name: string;
  /** Existe no Oxide agora. `null` = não deu para perguntar. */
  readonly exists: boolean | null;
  readonly members: number | null;
}

/**
 * A lista de grupos daquele servidor, cruzada com o que já está
 * guardado.
 *
 * Uma função só para os dois GETs porque a REGRA é a mesma nos
 * dois: a lista vem do Oxide, o servidor parado não impede ler, e
 * o que ficou sem grupo aparece como órfão em vez de sumir. Duas
 * cópias disso divergiriam na primeira correção feita num lado só.
 *
 * @param savedNames os grupos que têm linha guardada — é o que
 *        permite descobrir os órfãos.
 */
async function groupsOf(
  deps: LoadoutRoutesDeps,
  id: string,
  savedNames: readonly string[],
): Promise<{
  readonly connected: boolean;
  readonly rows: readonly GroupRow[];
  readonly truncated: number;
  readonly orphans: number;
}> {
  const context = deps.supervisor.contextOf(id);

  if (context === null || !context.rcon.isConnected) {
    // Sem RCON não dá para perguntar quais grupos existem. A tela
    // mostra o que ESTÁ guardado e diz que a lista está incompleta
    // — em vez de sugerir que o servidor não tem grupo nenhum.
    return {
      connected: false,
      rows: savedNames.map((name) => ({ name, exists: null, members: null })),
      truncated: 0,
      orphans: 0,
    };
  }

  const { groups, truncated } = await readPermissions(context.rcon);
  const seen = new Set(groups.map((group) => group.name));

  const rows = groups.map((group) => ({
    name: group.name,
    exists: true,
    members: group.members.length,
  }));

  // ####  OS ÓRFÃOS APARECEM, E NÃO SÃO APAGADOS  ####
  //
  // Um grupo removido do Oxide deixa a configuração dele sem dono.
  // A TELA mostra isso para quem administra decidir — apagar
  // sozinho jogaria fora meia hora de montagem por causa de um
  // `oxide.group remove` que talvez tenha sido engano.
  const orphans = savedNames
    .filter((name) => !seen.has(name))
    .map((name) => ({ name, exists: false, members: 0 }));

  return {
    connected: true,
    rows: [...rows, ...orphans],
    truncated,
    orphans: orphans.length,
  };
}

/** A frase de "o RCON está fora do ar", que os dois GETs usam. */
function offlineMessage(id: string, what: string): string {
  return (
    `O RCON de "${id}" está fora do ar, então não dá para perguntar quais grupos existem nele. ` +
    `Abaixo está ${what}; a lista completa de grupos aparece assim que a conexão voltar.`
  );
}

export function registerLoadoutRoutes(app: FastifyInstance, deps: LoadoutRoutesDeps): void {
  app.get('/servers/:id/loadouts', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const saved = new Map(
      deps.repository.list(id).map((loadout) => [loadout.groupName, loadout] as const),
    );

    const { connected, rows, truncated, orphans } = await groupsOf(deps, id, [...saved.keys()]);

    return {
      ok: true,
      connected,
      groups: rows.map((row) => {
        const loadout = saved.get(row.name);

        return {
          ...row,
          items: loadout?.items ?? [],
          enabled: loadout?.enabled ?? true,
          updatedAt: loadout === undefined ? null : new Date(loadout.updatedAt).toISOString(),
          updatedBy: loadout?.updatedBy ?? null,
        };
      }),
      truncated,
      message: !connected
        ? offlineMessage(id, 'o que já foi gravado')
        : orphans === 0
          ? undefined
          : `${String(orphans)} loadout(s) apontam para grupos que não existem mais no Oxide ` +
            'deste servidor. Eles continuam guardados e NÃO vão para o jogo.',
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

  // ==========================================================
  //  O STATUS DE NASCIMENTO — vida, fome e sede
  //
  //  Mesma lista de grupos, mesmas regras de servidor parado e de
  //  órfão. O que muda é O QUE se grava, e para qual comando do
  //  plugin isso vai.
  // ==========================================================

  app.get('/servers/:id/spawn-status', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const saved = new Map(
      deps.statusRepository.list(id).map((status) => [status.groupName, status] as const),
    );

    const { connected, rows, truncated, orphans } = await groupsOf(deps, id, [...saved.keys()]);

    return {
      ok: true,
      connected,
      groups: rows.map((row) => {
        const status = saved.get(row.name);

        return {
          ...row,
          // `null` em cada atributo é resposta, e não ausência: quer
          // dizer "o jogo decide este". Grupo sem linha nenhuma vem
          // com os três nulos, que é o mesmo estado.
          health: status?.health ?? null,
          calories: status?.calories ?? null,
          hydration: status?.hydration ?? null,
          enabled: status?.enabled ?? true,
          updatedAt: status === undefined ? null : new Date(status.updatedAt).toISOString(),
          updatedBy: status?.updatedBy ?? null,
        };
      }),
      truncated,
      message: !connected
        ? offlineMessage(id, 'o que já foi gravado')
        : orphans === 0
          ? undefined
          : `${String(orphans)} configuração(ões) de status apontam para grupos que não existem ` +
            'mais no Oxide deste servidor. Elas continuam guardadas e NÃO vão para o jogo.',
    };
  });

  /**
   * Grava o status daquele grupo e empurra o estado completo.
   *
   * ####  OS TRÊS NULOS SÃO RECUSADOS AQUI  ####
   *
   * Não porque o banco não os aceite — ele aceita —, mas porque
   * gravar uma linha que não faz nada é a forma mais fácil de
   * alguém achar que configurou. Quem quer "o jogo decide" para o
   * grupo inteiro tem o DELETE, que diz isso sem deixar rastro
   * confuso na tela.
   */
  app.put('/servers/:id/spawn-status/:group', async (request) => {
    const { id, group } = groupParams.parse(request.params);
    const body = saveStatusBody.parse(request.body);

    assertServer(deps, id);

    // O mesmo alfabeto dos grupos do Oxide, e pelo mesmo motivo do
    // loadout: o nome viaja dentro do payload que vai para a linha
    // de comando do console.
    assertOxideName(group, 'grupo');

    if (!hasAnyAttribute(body)) {
      throw new ApiError(
        'EMPTY_SPAWN_STATUS',
        `O status de "${group}" ficaria sem nenhum atributo — vida, comida e água todos vazios. ` +
          'Isso é o mesmo que não ter configuração: apague o status deste grupo, e quem nascer ' +
          'nele volta ao padrão do Rust.',
        400,
      );
    }

    const status = deps.statusRepository.save({
      serverId: id,
      groupName: group,
      health: body.health,
      calories: body.calories,
      hydration: body.hydration,
      enabled: body.enabled,
      updatedBy: operatorOf(request),
    });

    const sync = await deps.statusSync.push(id, 'spawn-status-changed');

    request.log.info(
      { server: id, group, by: operatorOf(request) },
      'status de nascimento gravado pelo painel',
    );

    return {
      ok: true,
      status: {
        name: status.groupName,
        health: status.health,
        calories: status.calories,
        hydration: status.hydration,
        enabled: status.enabled,
        updatedAt: new Date(status.updatedAt).toISOString(),
        updatedBy: status.updatedBy,
      },
      sync,
      message:
        sync.skipped ??
        `Status de "${group}" gravado e empurrado para ${id}.` +
          (body.enabled
            ? ''
            : ' Ele está DESLIGADO: continua guardado aqui e não vai para o jogo.'),
    };
  });

  /**
   * Apaga o status daquele grupo.
   *
   * O payload seguinte é o estado COMPLETO e o grupo não estará
   * nele: quem nascer ali volta ao padrão do Rust. Sem o envio, a
   * configuração continuaria valendo no jogo até o próximo
   * reinício, e ninguém entenderia por quê.
   */
  app.delete('/servers/:id/spawn-status/:group', async (request) => {
    const { id, group } = groupParams.parse(request.params);

    assertServer(deps, id);

    if (!deps.statusRepository.remove(id, group)) {
      throw new ApiError(
        'SPAWN_STATUS_NOT_FOUND',
        `Não há status de nascimento gravado para o grupo "${group}" em "${id}".`,
        404,
      );
    }

    const sync = await deps.statusSync.push(id, 'spawn-status-removed');

    request.log.warn(
      { server: id, group, by: operatorOf(request) },
      'status de nascimento removido pelo painel',
    );

    return {
      ok: true,
      sync,
      message:
        sync.skipped ??
        `Status de "${group}" apagado. Quem nascer nesse grupo em ${id} volta ao padrão do Rust.`,
    };
  });

  /** Reempurra o estado completo agora. */
  app.post('/servers/:id/spawn-status/sync', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(deps, id);

    const sync = await deps.statusSync.push(id, 'manual');

    return {
      ok: true,
      ...sync,
      message:
        sync.skipped ??
        `${String(sync.tiers)} chave(s) de status empurradas para ${id}; o plugin guardou ` +
          `${String(sync.cachedTiers)}.`,
    };
  });
}
