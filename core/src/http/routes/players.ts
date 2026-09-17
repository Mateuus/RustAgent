// ============================================================
//  routes/players.ts  -  a lista de jogadores da REDE.
//
//      GET /api/players                  a lista, paginada
//      GET /api/players/:steamId         a ficha
//      GET /api/players/:steamId/servers onde ele joga
//      GET /api/players/:steamId/events  o histórico dele
//      GET /api/players/:steamId/streamer  o modo streamer dele
//      PUT /api/players/:steamId/streamer  liberar, e o que some
//      GET /api/players/:steamId/skins     as skins que ele possui
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
import type { StreamerRepository } from '../../db/streamer-repository.js';
import type { WorkshopOwnedRepository } from '../../db/workshop-owned-repository.js';
import type { WorkshopSkinsRepository } from '../../db/workshop-repository.js';
import type { StreamerSync } from '../../game/streamer-sync.js';
import type { WorkshopService } from '../../game/workshop.js';
import {
  DEFAULT_EVENTS_LIMIT,
  MAX_EVENTS_LIMIT,
  MAX_PLAYERS_LIMIT,
  type PlayerDirectory,
} from '../../players/service.js';
import { streamerUpdateSchema, type StreamerProfile } from '../../types/streamer.js';
import { ApiError } from '../error-response.js';
import { operatorOf } from './admin.js';
import { ownedView } from './workshop.js';

export interface PlayerRoutesDeps {
  readonly directory: PlayerDirectory;

  /** O modo streamer. Ver types/streamer.ts. */
  readonly streamer: StreamerRepository;

  /**
   * Quem leva o modo ao jogo.
   *
   * `null` = o agente subiu sem nenhum servidor montado. A ficha
   * continua salvando: a carga sai sozinha na primeira conexão de
   * RCON, e recusar a escrita por causa disso deixaria o admin sem
   * como preparar a liberação de um streamer antes do servidor
   * subir.
   */
  readonly streamerSync: StreamerSync | null;

  /**
   * O catálogo de skins do Workshop.
   *
   * ####  ELE LÊ A MESMA LISTA, E PRECISA SABER QUE ELA MUDOU  ####
   *
   * A carga do OrigemZWorkshop leva quem está escondendo a logo
   * agora, para o plugin não guardar uma segunda cópia dela (ver
   * types/workshop.ts). Tirar a liberação de alguém aqui muda essa
   * lista — e sem este aviso a skin continuaria nascendo com a logo
   * na mão dele até a próxima reconexão de RCON.
   *
   * Opcional: o agente sobe sem ele quando não há servidor montado.
   */
  readonly workshop?: WorkshopService;

  /**
   * A posse de skins, para a aba Skins da ficha (02 §9).
   *
   * Opcional pelo mesmo motivo do `workshop`: sem ela, a rota
   * responde 503 em vez de uma lista vazia que pareceria "não tem
   * nada".
   */
  readonly skins?: {
    readonly repository: Pick<WorkshopSkinsRepository, 'getMany'>;
    readonly owned: Pick<WorkshopOwnedRepository, 'listForPlayer' | 'listFavorites'>;
  };
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

  /**
   * O modo streamer deste jogador.
   *
   * ####  200 PARA QUEM NUNCA FOI LIBERADO  ####
   *
   * Que é quase todo mundo. A ausência de linha no banco É a
   * resposta ("não é streamer"), e o repositório a devolve como um
   * perfil desligado — ver `defaultStreamerProfile` em
   * types/streamer.ts. Um 404 aqui obrigaria a tela a tratar o
   * caso normal como erro.
   */
  app.get('/players/:steamId/streamer', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    return { ok: true, streamer: toApiStreamer(deps.streamer.get(steamId)) };
  });

  /**
   * Libera o modo, e escolhe o que some da tela dele.
   *
   * ####  PARCIAL, E CADA CHAVE E INDEPENDENTE  ####
   *
   * A tela salva uma chavinha sem reenviar as outras (ver o
   * `COALESCE` do repositório). É o que permite desmarcar "esconder
   * a logo" de um parceiro sem mexer na live que ele já ligou.
   *
   * ####  DESLIGAR A LIBERACAO DESLIGA A LIVE JUNTO  ####
   *
   * E isso é regra, não efeito colateral: um jogador que perdeu a
   * liberação não tem mais como digitar `/streamer` para desligar o
   * que ficou ligado — o comando responderia que ele não tem
   * acesso. Sem isto, tirar a liberação esconderia o overlay dele
   * para sempre, e a ficha mostraria "ativo" sem ninguém conseguir
   * mudar.
   */
  app.put('/players/:steamId/streamer', async (request) => {
    const { steamId } = steamParams.parse(request.params);
    const input = streamerUpdateSchema.parse(request.body);

    assertSteamId(steamId);

    const patch =
      input.allowed === false ? { ...input, active: false } : input;

    const streamer = deps.streamer.save(steamId, {
      ...patch,
      grantedBy: operatorOf(request),
    });

    request.log.info(
      { steamId, allowed: streamer.allowed, active: streamer.active, by: operatorOf(request) },
      'modo streamer alterado pelo painel',
    );

    // Em todos os servidores: o modo é da REDE, e o jogador pode
    // estar em qualquer um deles agora. Ver game/streamer-sync.ts.
    deps.streamerSync?.pushAllSoon('admin-saved');
    // E o catálogo de skins, que leva a mesma lista dentro dele.
    deps.workshop?.handleStreamerChanged();

    return { ok: true, streamer: toApiStreamer(streamer) };
  });

  /**
   * As skins que ele possui — vivas e vencidas, com a skin resolvida.
   *
   * ####  200 COM LISTAS VAZIAS PARA QUEM NÃO TEM NADA  ####
   *
   * Como no streamer: a ausência de posse É a resposta. O SteamID é
   * conferido, mas o jogador não precisa já ter entrado — o site pode
   * vender para quem ainda não jogou.
   *
   * Dar e tirar ficam em `/workshop/owned`: a regra do prazo é uma só
   * e mora lá.
   *
   * `favorites` são os ids de skin que ELE marcou no menu do jogo
   * (migração 100; 02 §5.4). Vêm sem filtro de servidor — a favorita
   * é da rede, como a posse — e podem apontar para uma skin que ele
   * NÃO possui: favoritar é "quero achar rápido", não "tenho".
   */
  app.get('/players/:steamId/skins', async (request) => {
    const { steamId } = steamParams.parse(request.params);

    assertSteamId(steamId);

    if (deps.skins === undefined) {
      throw new ApiError(
        'WORKSHOP_UNAVAILABLE',
        'Este agente subiu sem o módulo de skins: não há posse para mostrar.',
        503,
      );
    }

    const now = Date.now();
    const view = ownedView(deps.skins.repository, deps.skins.owned.listForPlayer(steamId), now);

    return {
      ok: true,
      steamId,
      live: view.filter((owned) => !owned.expired),
      expired: view.filter((owned) => owned.expired),
      favorites: deps.skins.owned.listFavorites(steamId),
    };
  });
}

/**
 * O perfil como a tela o lê: datas em ISO.
 *
 * O banco guarda epoch ms (ver db/streamer-repository.ts) e esta
 * ficha inteira responde em ISO — `firstSeen`, `lastSeen` e os
 * eventos, todos passam por `toIso` em players/service.ts.
 * Devolver um número solto aqui faria a tela formatar uma data
 * deste jeito e todas as outras de outro.
 */
function toApiStreamer(profile: StreamerProfile): ApiStreamer {
  return {
    ...profile,
    activatedAt: profile.activatedAt === null ? null : new Date(profile.activatedAt).toISOString(),
    updatedAt: profile.updatedAt === 0 ? null : new Date(profile.updatedAt).toISOString(),
  };
}

/**
 * `updatedAt` nulo é quem NUNCA teve linha no banco — o perfil
 * inventado por `defaultStreamerProfile`. Zero viraria 1970 na
 * tela, que é pior que o travessão.
 */
interface ApiStreamer extends Omit<StreamerProfile, 'activatedAt' | 'updatedAt'> {
  readonly activatedAt: string | null;
  readonly updatedAt: string | null;
}
