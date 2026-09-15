// ============================================================
//  routes/teams.ts  -  a equipe do jogo, pelo painel.
//
//      GET    /servers/:id/teams                as equipes agora
//      GET    /servers/:id/teams/:teamId        uma delas
//      POST   /servers/:id/teams/:teamId/name   renomeia
//      POST   /servers/:id/teams/:teamId/rank   promove ou rebaixa
//      POST   /servers/:id/teams/:teamId/leader passa a liderança
//      DELETE /servers/:id/teams/:teamId/members/:steamId  expulsa
//      DELETE /servers/:id/teams/:teamId        desfaz
//
//      GET    /players/:steamId/team?server=…   a equipe de alguém
//
//      GET    /servers/:id/team-settings        o que vale, e o que o jogo diz
//      PUT    /servers/:id/team-settings        o tamanho máximo
//
//  ####  TUDO SOB /servers/:id, E ISSO É O CONTRÁRIO DO VIP  ####
//
//  O VIP é da PESSOA e vale na rede inteira. A equipe é de um MUNDO:
//  ela mora no save daquele servidor, o id dela vem de um contador
//  daquele servidor, e o mesmo número em dois servidores são duas
//  equipes diferentes. Uma rota de rede aqui misturaria as duas.
//
//  ####  NADA AQUI É LIDO DO BANCO  ####
//
//  Toda leitura pergunta ao jogo pelo RCON. Com o servidor parado a
//  resposta é 503 e não uma lista vazia — "esse jogador não tem
//  equipe" e "não consegui perguntar" são respostas diferentes, e
//  confundi-las é o jeito de o painel mentir com cara de dado.
//
//  Ver Docs/OrigemZTeam/00-LEVANTAMENTO.md.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ServersRepository } from '../../db/servers-repository.js';
import { TeamCommandError, type TeamsService } from '../../game/teams.js';
import { rankInputSchema, renameInputSchema, steamIdSchema, teamIdSchema } from '../../types/teams.js';
import { ApiError } from '../error-response.js';

export interface TeamRoutesDeps {
  readonly teams: TeamsService;
  readonly servers: ServersRepository;
}

const serverParams = z.object({ id: z.string().min(1) });
const teamParams = z.object({ id: z.string().min(1), teamId: teamIdSchema });
const memberParams = z.object({
  id: z.string().min(1),
  teamId: teamIdSchema,
  steamId: steamIdSchema,
});

/**
 * O erro do plugin virando resposta HTTP.
 *
 * ####  CADA MOTIVO TEM O SEU CÓDIGO  ####
 *
 * Um 500 genérico obrigaria quem está no painel a abrir o log do
 * servidor para saber se o problema é o plugin fora do ar ou uma
 * equipe que acabou de se desfazer. São coisas diferentes, e a
 * segunda nem é erro de ninguém.
 */
function asApiError(cause: unknown): never {
  if (!(cause instanceof TeamCommandError)) throw cause;

  switch (cause.reason) {
    case 'offline':
      throw new ApiError('SERVER_OFFLINE', cause.message, 503);

    case 'no_plugin':
      throw new ApiError('TEAM_PLUGIN_MISSING', cause.message, 503);

    case 'not_found':
      throw new ApiError('TEAM_NOT_FOUND', cause.message, 404);

    case 'not_a_member':
    case 'is_leader':
    case 'already_leader':
    case 'bad_steam_id':
      throw new ApiError('TEAM_REFUSED', cause.message, 409);

    default:
      throw new ApiError('TEAM_FAILED', cause.message, 502);
  }
}

export function registerTeamRoutes(app: FastifyInstance, deps: TeamRoutesDeps): void {
  function assertServer(id: string): void {
    if (deps.servers.get(id) === null) {
      throw new ApiError('SERVER_NOT_FOUND', `Não existe servidor com o id "${id}".`, 404);
    }
  }

  // ==========================================================
  //  LER
  // ==========================================================

  app.get('/servers/:id/teams', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    try {
      return { ok: true, ...(await deps.teams.snapshot(id)) };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.get('/servers/:id/teams/:teamId', async (request) => {
    const { id, teamId } = teamParams.parse(request.params);

    assertServer(id);

    try {
      const team = await deps.teams.team(id, teamId);

      if (team === null) {
        throw new ApiError('TEAM_NOT_FOUND', 'Essa equipe não existe mais.', 404);
      }

      return { ok: true, team };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  /**
   * A equipe de um jogador.
   *
   * Fora de `/servers/:id` porque quem pergunta é a FICHA do
   * jogador, que não sabe de servidor nenhum — ela passa o servidor
   * como query justamente por isso. Sem ele não há o que responder:
   * a mesma pessoa pode estar em equipes diferentes em dois mundos.
   */
  app.get('/players/:steamId/team', async (request) => {
    const { steamId } = z.object({ steamId: steamIdSchema }).parse(request.params);
    const { server } = z.object({ server: z.string().min(1) }).parse(request.query);

    assertServer(server);

    try {
      return { ok: true, team: await deps.teams.teamOf(server, steamId) };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  // ==========================================================
  //  A CONFIGURAÇÃO
  //
  //  ####  DUAS RESPOSTAS, E ELAS PODEM DIVERGIR  ####
  //
  //  `maxSize` é o que o admin escolheu e mora no banco. `live` é o
  //  que o jogo diz que vale AGORA — e os dois se separam quando
  //  alguém digita no console, ou quando o servidor reinicia: medido
  //  em 15/09/2026, o convar `relationshipmanager.maxteamsize` NÃO é
  //  salvo pelo `server.writecfg`, e volta a 8 em todo restart.
  //
  //  A tela mostra os dois. Escolher um para acreditar seria esconder
  //  justamente a hora em que o valor se perdeu.
  // ==========================================================

  app.get('/servers/:id/team-settings', async (request) => {
    const { id } = serverParams.parse(request.params);

    assertServer(id);

    const settings = deps.teams.settingsOf(id);
    let live: number | null = null;

    try {
      live = await deps.teams.liveMaxSize(id);
    } catch {
      // Servidor parado: `live` fica `null`, e a tela diz "não
      // consegui perguntar" em vez de inventar que está aplicado.
    }

    return { ok: true, settings, live };
  });

  app.put('/servers/:id/team-settings', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = z.object({ maxSize: z.number().int().min(0).max(64) }).parse(request.body);

    assertServer(id);

    try {
      return { ok: true, settings: await deps.teams.saveSettings(id, body) };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  // ==========================================================
  //  MEXER
  // ==========================================================

  app.post('/servers/:id/teams/:teamId/name', async (request) => {
    const { id, teamId } = teamParams.parse(request.params);
    const { name } = renameInputSchema.parse(request.body);

    assertServer(id);

    try {
      return { ok: true, team: await deps.teams.rename(id, teamId, name) };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.post('/servers/:id/teams/:teamId/rank', async (request) => {
    const { id, teamId } = teamParams.parse(request.params);
    const { steamId, rank } = rankInputSchema.parse(request.body);

    assertServer(id);

    try {
      return {
        ok: true,
        team: await deps.teams.setRank({ serverId: id, teamId, steamId, rank, grantedBy: 'painel' }),
      };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.post('/servers/:id/teams/:teamId/leader', async (request) => {
    const { id, teamId } = teamParams.parse(request.params);
    const { steamId } = z.object({ steamId: steamIdSchema }).parse(request.body);

    assertServer(id);

    try {
      return { ok: true, team: await deps.teams.setLeader(id, teamId, steamId) };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.delete('/servers/:id/teams/:teamId/members/:steamId', async (request) => {
    const { id, teamId, steamId } = memberParams.parse(request.params);

    assertServer(id);

    try {
      const team = await deps.teams.kick(id, teamId, steamId);

      // `null` = era o último, e o jogo desfez a equipe. Não é erro:
      // é o que acontece, e a tela precisa saber para não pedir a
      // equipe de novo e levar um 404.
      return { ok: true, team, disbanded: team === null };
    } catch (cause) {
      return asApiError(cause);
    }
  });

  app.delete('/servers/:id/teams/:teamId', async (request) => {
    const { id, teamId } = teamParams.parse(request.params);

    assertServer(id);

    try {
      await deps.teams.disband(id, teamId);

      return { ok: true };
    } catch (cause) {
      return asApiError(cause);
    }
  });
}
