// ============================================================
//  routes/players.ts  -  a lista de jogadores da REDE.
//
//      GET /api/players                  a lista, paginada
//      GET /api/players/:steamId         a ficha
//      GET /api/players/:steamId/servers onde ele joga
//      GET /api/players/:steamId/events  o histórico dele
//
//  ####  NÃO CONFUNDIR COM `/api/servers/:id/players`  ####
//
//  Aquela é ESTADO DO SERVIDOR: quem está conectado agora, lido do
//  RCON a cada chamada, inexistente com o jogo fora do ar. Esta é
//  a BASE do agente: todo mundo que já jogou na rede, no SQLite,
//  sobrevivendo ao wipe e ao reinício.
//
//  As duas precisam existir. Um `/api/players` que devolvesse
//  conectados esvaziaria sozinho de madrugada, e não haveria onde
//  responder "quem é este jogador que foi banido em março?".
//
//  ####  O steamId É STRING, SEMPRE  ####
//
//  No parâmetro de rota, no zod e na resposta. Um SteamID64 tem 17
//  dígitos e passa de 2^53: um `z.coerce.number()` aqui aceitaria
//  o valor e o devolveria arredondado — e a ficha seria de OUTRA
//  PESSOA, sem erro nenhum no caminho.
//
//  ####  E A LISTAGEM É PAGINADA DESDE A PRIMEIRA VERSÃO  ####
//
//  Uma rede com meses de vida tem dezenas de milhares de
//  jogadores. `total` vai junto porque sem ele a tela não sabe se
//  há página seguinte.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { assertSteamId } from '../../bans/service.js';
import {
  DEFAULT_EVENTS_LIMIT,
  MAX_EVENTS_LIMIT,
  MAX_PLAYERS_LIMIT,
  type PlayerDirectory,
} from '../../players/service.js';
import { ApiError } from '../error-response.js';

export interface PlayerRoutesDeps {
  readonly directory: PlayerDirectory;
}

const listQuery = z.object({
  /** Nome ou SteamID, por pedaço. */
  q: z.string().optional(),
  /** `1` = só quem está com sessão aberta em algum servidor. */
  online: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PLAYERS_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Ver o cabeçalho: `z.string()`, e nunca `z.number()`. */
const steamParams = z.object({ steamId: z.string().min(1) });

const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_LIMIT).optional(),
});

export function registerPlayerRoutes(app: FastifyInstance, deps: PlayerRoutesDeps): void {
  app.get('/players', async (request) => {
    const { q, online, limit, offset } = listQuery.parse(request.query);

    const page = deps.directory.list({ query: q, online: online === '1', limit, offset });

    return {
      ok: true,
      // `count` é o que veio nesta página; `total` é o que casou
      // com o filtro. Sem os dois, a tela não distingue "acabou" de
      // "tem mais, e você está no fim da página".
      count: page.players.length,
      ...page,
    };
  });

  /**
   * A ficha.
   *
   * ####  200 MESMO COM O JOGADOR OFFLINE  ####
   *
   * Estar online é um DADO da ficha, e não uma condição para ela
   * existir. Um 404 para quem está offline deixaria o painel sem
   * como mostrar justamente a ficha que mais se procura: a de quem
   * fez alguma coisa ontem.
   *
   * ####  E 200 PARA QUEM SÓ EXISTE NA LISTA DE BANIDOS  ####
   *
   * Um ban por SteamID de alguém offline, ou adotado de um
   * `bans.cfg`, cria um jogador que o agente nunca viu jogar. A
   * ficha dele vem com `known: false` e as datas nulas — que é a
   * resposta certa para "desde quando ele joga aqui?": não sei.
   *
   * O 404 fica reservado para o que ele significa de verdade: este
   * SteamID nunca passou por este agente, em canto nenhum.
   */
  app.get('/players/:steamId', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    const profile = deps.directory.get(steamId);

    if (profile === null) {
      throw new ApiError(
        'PLAYER_NOT_FOUND',
        `Este agente nunca viu o SteamID ${steamId} — nem jogando, nem numa lista de banidos. ` +
          'A ficha nasce na primeira vez que ele entra em algum servidor da rede.',
        404,
      );
    }

    return { ok: true, ...profile };
  });

  /**
   * Onde ele joga, e desde quando em cada lugar.
   *
   * Lista vazia NÃO é 404: o jogador existe na rede e nunca entrou
   * em servidor nenhum — é o caso de quem só tem banimento. A
   * resposta vazia é a informação.
   */
  app.get('/players/:steamId/servers', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    return { ok: true, servers: deps.directory.serversOf(steamId) };
  });

  /**
   * O histórico.
   *
   * ####  O QUE É REAL E O QUE É EXEMPLO VÊM SEPARADOS  ####
   *
   * `events` é o que aconteceu: entradas e saídas (a presença),
   * banimentos e revogações (a tabela `bans`), expulsões e
   * teleportes (o painel). `sample` é a ESTRUTURA do que ainda não
   * é medido — kill e morte —, com `measured: false` e a frase que
   * explica por quê.
   *
   * Os dois em campos diferentes de propósito: mock misturado com
   * dado é a única coisa pior que não ter o dado.
   */
  app.get('/players/:steamId/events', async (request) => {
    const { steamId } = steamParams.parse(request.params);
    const { limit } = eventsQuery.parse(request.query);

    assertSteamId(steamId);

    return { ok: true, ...deps.directory.timeline(steamId, limit ?? DEFAULT_EVENTS_LIMIT) };
  });
}
