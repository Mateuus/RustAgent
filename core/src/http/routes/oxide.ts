// ============================================================
//  routes/oxide.ts  -  o Oxide daquele servidor: quem pode o quê.
//
//      GET    /oxide                          o framework em si
//      GET    /oxide/permissions              grupos e permissões
//      POST   /oxide/groups                   cria um grupo
//      PATCH  /oxide/groups/:group            título, rank, pai
//      DELETE /oxide/groups/:group            apaga
//      POST   /oxide/groups/:group/permissions        concede
//      DELETE /oxide/groups/:group/permissions/:perm  revoga
//      POST   /oxide/groups/:group/members            põe alguém
//      DELETE /oxide/groups/:group/members/:steamId   tira
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  O VIP deste projeto é um jogador dentro de um GRUPO do Oxide
//  (`origemz.vip.bronze` → `silver` → `gold`, cada um herdando do
//  anterior). O plugin cria a hierarquia sozinho ao carregar, a
//  partir do config dele — mas quem está dentro dela, e o que cada
//  nível de fato concede, só se via digitando `oxide.show` no
//  Console e lendo prosa em inglês.
//
//  ####  LER É BARATO, AGIR EXIGE O SERVIDOR NO AR  ####
//
//  As duas leituras respondem 200 mesmo com o RCON fora, com
//  `connected: false` e uma frase — a aba de Configurações é aberta
//  com o servidor parado o tempo todo, e um erro vermelho ali seria
//  mentira sobre o que está errado. Já conceder uma permissão exige
//  o servidor: não existe "agendar" concessão, e fingir que
//  aconteceu seria o pior desfecho.
//
//  ####  O QUE NÃO ENTRA AQUI  ####
//
//  Conceder permissão DIRETO a um jogador (`oxide.grant user`).
//  Ela existe no Oxide e é o que faz um servidor virar uma colcha
//  de retalhos que ninguém audita: a pergunta "por que este
//  jogador pode isso?" passa a ter N respostas. Quem dá poder é o
//  grupo — as permissões soltas de alguém continuam VISÍVEIS na
//  leitura, para que dê para descobrir que existem.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { assertSteamId } from '../../bans/service.js';
import { readOxideFrameworkConfig } from '../../oxide/install.js';
import {
  createGroup,
  grantToGroup,
  readOxideStatus,
  readPermissions,
  removeGroup,
  revokeFromGroup,
  setGroupParent,
  setGroupTitle,
  setUserGroup,
} from '../../oxide/permissions.js';
import type { ServerContext } from '../../servers/context.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';

export interface OxideRoutesDeps {
  readonly supervisor: ServerSupervisor;
}

const serverParams = z.object({ id: z.string().min(1) });
const groupParams = z.object({ id: z.string().min(1), group: z.string().min(1) });
const permissionParams = groupParams.extend({ permission: z.string().min(1) });
const memberParams = groupParams.extend({ steamId: z.string().min(1) });

/**
 * O título é livre (vai entre aspas no comando, e o módulo limpa
 * as aspas); o NOME não é — ele vira argumento solto. Ver
 * `assertOxideName`.
 */
const createBody = z
  .object({
    name: z.string().min(1).max(64),
    title: z.string().trim().max(64).optional(),
    rank: z.number().int().min(0).max(1_000_000).optional(),
    parent: z.string().max(64).optional(),
  })
  .strict();

/**
 * O PATCH aceita os três, e cada um vira um comando diferente do
 * Oxide: `oxide.group set` para título/rank, `oxide.group parent`
 * para a herança. `parent: ""` DESLIGA a herança — string vazia, e
 * não `null`, para não confundir com "não mexa".
 */
const patchBody = z
  .object({
    title: z.string().trim().max(64).optional(),
    rank: z.number().int().min(0).max(1_000_000).optional(),
    parent: z.string().max(64).optional(),
  })
  .strict();

const permissionBody = z.object({ permission: z.string().min(1).max(64) }).strict();
const memberBody = z.object({ steamId: z.string().min(1) }).strict();

/**
 * O contexto daquele servidor — só quando ele existe.
 *
 * @throws {ApiError} 404 id desconhecido, 409 servidor desligado.
 */
function contextOf(deps: OxideRoutesDeps, id: string): ServerContext {
  const context = deps.supervisor.contextOf(id);

  if (context !== null) {
    return context;
  }

  if (deps.supervisor.configOf(id) === null) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
        `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
      404,
    );
  }

  throw new ApiError(
    'SERVER_NOT_OPERATED',
    `O agente não está cuidando do servidor "${id}" (ele está desligado, ou o jogo ainda não foi ` +
      'instalado). Os grupos do Oxide moram dentro do servidor, e é a ele que se pergunta.',
    409,
  );
}

/**
 * O RCON daquele servidor, para AGIR.
 *
 * @throws {ApiError} 503 sem conexão. Não há como enfileirar: uma
 * concessão que "vai acontecer depois" é uma que ninguém confere.
 */
function rconOf(deps: OxideRoutesDeps, id: string): ServerContext['rcon'] {
  const context = contextOf(deps, id);

  if (!context.rcon.isConnected) {
    throw new ApiError(
      'RCON_UNAVAILABLE',
      `Sem conexão com o RCON do servidor "${id}". Grupos e permissões do Oxide só mudam com o ` +
        'servidor no ar — ele guarda tudo em memória e grava quando mandam.',
      503,
    );
  }

  return context.rcon;
}

export function registerOxideRoutes(app: FastifyInstance, deps: OxideRoutesDeps): void {
  // ==========================================================
  //  O Oxide em si
  // ==========================================================

  /**
   * Versão, plugins CARREGADOS e o `oxide.config.json`.
   *
   * ####  "CARREGADO" NÃO É "ATIVO NO ACERVO"  ####
   *
   * A aba Plugins mostra o que o agente aplicou naquele servidor;
   * isto mostra o que o Oxide conseguiu compilar e está rodando
   * AGORA. Quando os dois discordam, o plugin está em disco e não
   * roda — e é essa diferença que se procura quando "liguei e não
   * aconteceu nada".
   */
  app.get('/servers/:id/oxide', async (request) => {
    const { id } = serverParams.parse(request.params);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    // O arquivo é lido do DISCO, e por isso existe mesmo com o
    // servidor parado — que é quando alguém abre esta aba para
    // conferir a configuração antes de subir.
    const framework = await readOxideFrameworkConfig(config.paths.installDir);
    const context = deps.supervisor.contextOf(id);

    if (context === null || !context.rcon.isConnected) {
      return {
        ok: true,
        connected: false,
        oxide: { version: null, branch: null },
        plugins: [],
        config: framework,
        message:
          `O servidor "${id}" não está no ar. A versão do Oxide e os plugins carregados são ` +
          'perguntados a ele pelo console — o arquivo de configuração abaixo vem do disco e ' +
          'continua valendo.',
      };
    }

    return {
      ok: true,
      connected: true,
      ...(await readOxideStatus(context.rcon)),
      config: framework,
    };
  });

  // ==========================================================
  //  Grupos e permissões
  // ==========================================================

  app.get('/servers/:id/oxide/permissions', async (request) => {
    const { id } = serverParams.parse(request.params);
    const context = deps.supervisor.contextOf(id);

    if (context === null) {
      if (deps.supervisor.configOf(id) === null) {
        throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
      }

      return {
        ok: true,
        connected: false,
        groups: [],
        permissions: [],
        truncated: 0,
        message:
          `O agente não está cuidando do servidor "${id}". Os grupos do Oxide vivem dentro do ` +
          'servidor, e é a ele que se pergunta por eles.',
      };
    }

    if (!context.rcon.isConnected) {
      return {
        ok: true,
        connected: false,
        groups: [],
        permissions: [],
        truncated: 0,
        message:
          `O RCON do servidor "${id}" está fora do ar. Os grupos continuam gravados lá e ` +
          'aparecem aqui assim que a conexão voltar.',
      };
    }

    return { ok: true, connected: true, ...(await readPermissions(context.rcon)) };
  });

  /**
   * Cria um grupo.
   *
   * Os grupos de VIP NÃO nascem por aqui: quem os cria é o plugin,
   * ao carregar, a partir do config dele. Este caminho existe para
   * o resto — o grupo de evento, o que um plugin de terceiro
   * espera encontrar pronto.
   */
  app.post('/servers/:id/oxide/groups', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const body = createBody.parse(request.body);
    const rcon = rconOf(deps, id);

    const output = await createGroup(rcon, {
      name: body.name,
      title: body.title ?? null,
      rank: body.rank ?? null,
      parent: body.parent ?? null,
    });

    request.log.info(
      { server: id, group: body.name, parent: body.parent, by: operatorOf(request) },
      'grupo do Oxide criado pelo painel',
    );

    return reply.status(201).send({
      ok: true,
      output,
      message:
        `Grupo "${body.name}" criado em ${id}.` +
        (body.parent === undefined || body.parent === ''
          ? ' Ele ainda não concede nada: as permissões são o próximo passo.'
          : ` Ele herda tudo de "${body.parent}".`),
    });
  });

  /**
   * Título, rank e herança.
   *
   * ####  O CONSOLE NÃO DEVOLVE TÍTULO NEM RANK  ####
   *
   * `oxide.show group` só lista membros e permissões, então o
   * agente NÃO sabe dizer qual é o título de hoje — e por isso a
   * tela pede os dois juntos, em vez de mostrar um campo
   * preenchido com um palpite.
   */
  app.patch('/servers/:id/oxide/groups/:group', async (request) => {
    const { id, group } = groupParams.parse(request.params);
    const body = patchBody.parse(request.body);
    const rcon = rconOf(deps, id);
    const done: string[] = [];

    if (body.title !== undefined) {
      await setGroupTitle(rcon, group, body.title, body.rank ?? null);
      done.push(`título "${body.title}"`);

      if (body.rank !== undefined) {
        done.push(`rank ${String(body.rank)}`);
      }
    }

    if (body.parent !== undefined) {
      await setGroupParent(rcon, group, body.parent === '' ? null : body.parent);
      done.push(body.parent === '' ? 'herança removida' : `herda de "${body.parent}"`);
    }

    if (done.length === 0) {
      throw new ApiError(
        'INVALID_BODY',
        'Diga o que mudar: título (com rank, se quiser) ou o grupo pai. Um corpo vazio não muda ' +
          'nada, e responder "pronto" a isso seria mentir.',
        400,
      );
    }

    request.log.info(
      { server: id, group, changes: done, by: operatorOf(request) },
      'grupo do Oxide alterado pelo painel',
    );

    return { ok: true, message: `Grupo "${group}": ${done.join(', ')}.` };
  });

  /**
   * Apaga o grupo.
   *
   * Some com as permissões dele e com quem estava dentro. Um grupo
   * que um plugin espera encontrar é recriado por ele no próximo
   * carregamento, VAZIO — e é isso que a confirmação da tela diz.
   */
  app.delete('/servers/:id/oxide/groups/:group', async (request) => {
    const { id, group } = groupParams.parse(request.params);
    const rcon = rconOf(deps, id);

    const output = await removeGroup(rcon, group);

    request.log.warn(
      { server: id, group, by: operatorOf(request) },
      'grupo do Oxide removido pelo painel',
    );

    return {
      ok: true,
      output,
      message:
        `Grupo "${group}" removido de ${id}. Quem estava nele perdeu o que vinha dali — e um ` +
        'plugin que dependa deste grupo vai recriá-lo vazio no próximo carregamento.',
    };
  });

  // ---- as permissões de um grupo ----

  app.post('/servers/:id/oxide/groups/:group/permissions', async (request) => {
    const { id, group } = groupParams.parse(request.params);
    const { permission } = permissionBody.parse(request.body);
    const rcon = rconOf(deps, id);

    const output = await grantToGroup(rcon, group, permission);

    request.log.info(
      { server: id, group, permission, by: operatorOf(request) },
      'permissão concedida a um grupo pelo painel',
    );

    return {
      ok: true,
      output,
      message:
        `"${permission}" concedida ao grupo "${group}". Vale para quem está nele e para quem ` +
        'herda dele.',
    };
  });

  app.delete('/servers/:id/oxide/groups/:group/permissions/:permission', async (request) => {
    const { id, group, permission } = permissionParams.parse(request.params);
    const rcon = rconOf(deps, id);

    const output = await revokeFromGroup(rcon, group, permission);

    request.log.info(
      { server: id, group, permission, by: operatorOf(request) },
      'permissão revogada de um grupo pelo painel',
    );

    return { ok: true, output, message: `"${permission}" revogada do grupo "${group}".` };
  });

  // ---- quem está no grupo ----

  /**
   * Põe um jogador no grupo.
   *
   * Pelo SteamID, sempre: nome muda, e dois jogadores podem ter o
   * mesmo no mesmo dia. O Oxide precisa CONHECER o jogador — ou
   * seja, ele precisa ter entrado no servidor pelo menos uma vez.
   */
  app.post('/servers/:id/oxide/groups/:group/members', async (request) => {
    const { id, group } = groupParams.parse(request.params);
    const { steamId } = memberBody.parse(request.body);
    const rcon = rconOf(deps, id);

    assertSteamId(steamId);

    const output = await setUserGroup(rcon, steamId, group, true);

    request.log.warn(
      { server: id, group, steamId, by: operatorOf(request) },
      'jogador posto num grupo do Oxide pelo painel',
    );

    return {
      ok: true,
      output,
      message:
        `${steamId} entrou no grupo "${group}" em ${id}. Vale na hora, inclusive com ele dentro ` +
        'do jogo.',
    };
  });

  app.delete('/servers/:id/oxide/groups/:group/members/:steamId', async (request) => {
    const { id, group, steamId } = memberParams.parse(request.params);
    const rcon = rconOf(deps, id);

    assertSteamId(steamId);

    const output = await setUserGroup(rcon, steamId, group, false);

    request.log.warn(
      { server: id, group, steamId, by: operatorOf(request) },
      'jogador tirado de um grupo do Oxide pelo painel',
    );

    return { ok: true, output, message: `${steamId} saiu do grupo "${group}" em ${id}.` };
  });
}
