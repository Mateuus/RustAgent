// ============================================================
//  routes/admin.ts  -  a aba Administração de um servidor.
//
//  Três assuntos, e cada um responde a uma pergunta que hoje só se
//  responde entrando no jogo ou abrindo o console:
//
//      /players   quem está online, com posição quando dá
//      /chat      o que estão dizendo, e o `say`
//      /admins    quem manda ali
//
//  Os outros dois da aba não têm rota própria: os BANIDOS moram em
//  routes/bans.ts (a lista é do agente, não do servidor), e os
//  COMANDOS reaproveitam o `POST /api/servers/:id/rcon`, que já
//  existe. Uma rota nova por comando de console seria inventar
//  vinte endpoints para o que o canivete já faz.
//
//  ------------------------------------------------------------
//  ####  EXPULSAR É DESTRUTIVO, E FICA REGISTRADO  ####
//
//  Com quem pediu junto. "Quem expulsou este jogador?" é a
//  primeira pergunta de toda discussão sobre moderação, e a
//  resposta não pode ser um encolher de ombros.
// ============================================================

import { createReadStream } from 'node:fs';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { PlayerEventInput } from '../../db/players-repository.js';
import { grantAdmin, readAdmins, revokeAdmin } from '../../game/admins.js';
import { DEFAULT_CHAT_LIMIT, MAX_CHAT_LIMIT, readChat } from '../../game/chat.js';
import { mapImagePath, readMapImage, renderMapImage } from '../../game/map-image.js';
import type { MonumentReader } from '../../game/monuments.js';
import { kickPlayer, teleportPlayer, type PlayersReader } from '../../game/players.js';
import type { ServerContext } from '../../servers/context.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';

/**
 * Onde o que o painel faz com um jogador fica registrado.
 *
 * Interface mínima: quem a satisfaz é o `PlayerDirectory`, e um
 * teste a satisfaz com uma função. Ela existe para que estas rotas
 * não precisem conhecer o repositório inteiro para gravar uma
 * linha.
 */
export interface PlayerActionLog {
  recordAction(event: PlayerEventInput): void;
}

export interface AdminRoutesDeps {
  readonly supervisor: ServerSupervisor;
  readonly players: PlayersReader;
  /** Os monumentos do mundo, guardados por seed. */
  readonly monuments: MonumentReader;
  /** A ficha do jogador. Ver `PlayerActionLog`. */
  readonly history: PlayerActionLog;
}

const serverParams = z.object({ id: z.string().min(1) });
const playerParams = z.object({ id: z.string().min(1), steamId: z.string().min(1) });
const chatQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CHAT_LIMIT).optional(),
});

const kickBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

/**
 * O destino de um teleporte.
 *
 * `y` é opcional de propósito — ver a rota. A faixa de ±10.000
 * cobre qualquer mundo do Rust com folga; quem recusa de verdade é
 * o plugin, que conhece o tamanho do mundo carregado.
 */
const teleportBody = z
  .object({
    x: z.number().finite().min(-10_000).max(10_000),
    z: z.number().finite().min(-10_000).max(10_000),
    y: z.number().finite().min(-2_000).max(5_000).optional(),
  })
  .strict();

const sayBody = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, 'a mensagem não pode ser vazia')
      .max(200, 'mensagem longa demais (máximo 200 caracteres)'),
  })
  .strict();

const adminLevel = z.enum(['owner', 'moderator']);

const grantBody = z
  .object({
    steamId: z.string().min(1),
    name: z.string().trim().max(64).optional(),
    level: adminLevel,
  })
  .strict();

const levelQuery = z.object({ level: adminLevel.optional() });

/**
 * Quem pediu.
 *
 * A sessão do painel tem nome; a integração por token não tem, e
 * dizer "token de integração" é mais honesto que gravar nada e
 * deixar a linha sem dono.
 */
export function operatorOf(request: FastifyRequest): string | null {
  if (request.operator !== undefined) {
    return request.operator.user;
  }

  return request.viaToken === true ? 'token de integração' : null;
}

/**
 * O contexto daquele servidor.
 *
 * @throws {ApiError} 404 quando o id não existe, 409 quando o
 * agente não está cuidando dele. São recusas diferentes de
 * propósito: a primeira é um id errado, a segunda é um servidor
 * que existe e está fora do alcance — e o que resolve cada uma é
 * outra coisa.
 */
function contextOf(deps: AdminRoutesDeps, id: string): ServerContext {
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
    `O agente não está cuidando do servidor "${id}" (ele está desligado, ou o jogo ainda não ` +
      'foi instalado). Sem RCON não há como perguntar quem está online.',
    409,
  );
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  // ==========================================================
  //  Jogadores
  // ==========================================================

  /**
   * ####  A FONTE NÃO É ESCOLHA DE QUEM OLHA  ####
   *
   * Com o OrigemZAgent ligado, `origemz.players`; sem ele, o
   * `playerlist` nativo. A resposta DIZ qual foi usada e o que
   * falta na outra — a tela mostra isso e oferece ligar o plugin,
   * em vez de deixar a posição sumir sem explicação.
   */
  app.get('/servers/:id/players', async (request) => {
    const { id } = serverParams.parse(request.params);
    const context = contextOf(deps, id);

    // O `worldSize` sai do `.ini`, que é a fonte da verdade do
    // servidor. Ele é o que permite dizer em que célula do mapa
    // cada um está — e o que o Map View usa para projetar.
    const worldSize = deps.supervisor.configOf(id)?.worldSize ?? 0;

    return { ok: true, ...(await deps.players.list(id, context.rcon, worldSize)) };
  });

  app.post('/servers/:id/players/:steamId/kick', async (request) => {
    const { id, steamId } = playerParams.parse(request.params);
    const { reason } = kickBody.parse(request.body ?? {});
    const context = contextOf(deps, id);

    const output = await kickPlayer(id, context.rcon, steamId, reason ?? null);
    const by = operatorOf(request);

    // Ver o cabeçalho: comando destrutivo pelo RCON é registrado,
    // com quem pediu.
    request.log.warn({ server: id, steamId, by, reason }, 'jogador expulso pelo painel');

    // A linha entra no console do agente também: quem está com a
    // aba Console aberta vê a expulsão acontecer, junto com o resto
    // do que o servidor está fazendo.
    context.console.pushLocal(
      `${by ?? 'alguém'} expulsou ${steamId}${reason === undefined ? '' : ` (${reason})`}`,
    );

    // E na ficha DELE. O log responde "o que o agente fez hoje"; a
    // ficha responde "o que já aconteceu com este jogador" — e é a
    // segunda pergunta que alguém faz três semanas depois.
    deps.history.recordAction({
      steamId,
      serverId: id,
      kind: 'kick',
      actor: by,
      detail: reason ?? null,
    });

    return {
      ok: true,
      steamId,
      output,
      message:
        `${steamId} foi expulso. Ele pode entrar de novo a qualquer momento — para impedir, ` +
        'use Banir.',
    };
  });

  /**
   * Move o jogador para um ponto do mundo.
   *
   * ####  O `y` NÃO VEM DA TELA  ####
   *
   * Quem arrasta o boneco no mapa escolhe X e Z; altura não existe
   * num mapa 2D. Sem ele, o plugin resolve pelo terreno e devolve
   * onde o jogador de fato parou — e é essa posição que a tela usa
   * para redesenhar o ponto, em vez de supor que ele chegou onde
   * foi solto.
   */
  app.post('/servers/:id/players/:steamId/teleport', async (request) => {
    const { id, steamId } = playerParams.parse(request.params);
    const target = teleportBody.parse(request.body);
    const context = contextOf(deps, id);

    const result = await teleportPlayer(id, context.rcon, steamId, target);
    const by = operatorOf(request);

    // Mover um jogador é destrutivo do ponto de vista dele: ele
    // perde o lugar onde estava. Fica registrado, com quem pediu.
    request.log.warn(
      { server: id, steamId, by, to: result.position, heightAdjusted: result.heightAdjusted },
      'jogador teleportado pelo painel',
    );

    context.console.pushLocal(
      `${by ?? 'alguém'} teleportou ${steamId} para ` +
        `${result.position.x.toFixed(0)}, ${result.position.z.toFixed(0)}`,
    );

    // A posição gravada é a FINAL, e não a pedida: a altura foi
    // resolvida pelo terreno, e é onde o jogador de fato parou que
    // responde "para onde ele foi levado?".
    deps.history.recordAction({
      steamId,
      serverId: id,
      kind: 'teleport',
      actor: by,
      detail: `${result.position.x.toFixed(0)}, ${result.position.z.toFixed(0)}`,
    });

    return {
      ok: true,
      steamId,
      ...result,
      message: result.heightAdjusted
        ? 'Jogador movido. A altura foi resolvida pelo terreno do destino.'
        : 'Jogador movido para a altura informada.',
    };
  });

  /**
   * Os monumentos daquele mundo.
   *
   * Nativo do jogo (`world.monuments`), sem plugin nenhum. A lista
   * é guardada por tamanho+seed: monumento nasce com a seed e só
   * muda no wipe, então relê-la a cada abertura de mapa seria mandar
   * um comando para receber sempre a mesma resposta.
   */
  app.get('/servers/:id/monuments', async (request) => {
    const { id } = serverParams.parse(request.params);
    const context = contextOf(deps, id);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    const monuments = await deps.monuments.list(id, context.rcon, {
      worldSize: config.worldSize,
      seed: config.seed,
    });

    return { ok: true, monuments };
  });

  // ==========================================================
  //  A imagem do mapa
  // ==========================================================

  /**
   * O retrato do que existe em disco. NÃO renderiza nada.
   *
   * A tela abre com isto e decide entre desenhar o mapa com fundo
   * ou oferecer o botão — renderizar sozinho a cada abertura seria
   * um engasgo no servidor por visita. Ver game/map-image.ts.
   */
  app.get('/servers/:id/map', async (request) => {
    const { id } = serverParams.parse(request.params);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    const image = await readMapImage(config.paths.installDir, config.worldSize, config.seed);

    return {
      ok: true,
      ...image,
      // O caminho da imagem é o da PRÓPRIA rota, e não o do disco:
      // o painel roda no navegador e não alcança `F:\...`.
      url: image.available ? `/api/servers/${encodeURIComponent(id)}/map/image` : null,
      ...(image.available
        ? {}
        : {
            message:
              'Ainda não há imagem para este mundo. Ela é desenhada pelo próprio jogo, uma vez ' +
              'por wipe — o botão manda o comando.',
          }),
    };
  });

  /**
   * O PNG.
   *
   * ####  POR QUE ELE PASSA PELO AGENTE  ####
   *
   * O painel é servido de `panel/out` e o arquivo mora ao lado da
   * instalação do jogo, em outro lugar do disco. Servi-lo aqui é o
   * que evita expor uma pasta inteira do servidor ao navegador.
   *
   * O caminho NÃO vem da requisição: ele é montado a partir do
   * `.ini` daquele servidor (tamanho e seed). Não há nome de
   * arquivo do usuário no meio.
   */
  app.get('/servers/:id/map/image', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    const image = await readMapImage(config.paths.installDir, config.worldSize, config.seed);

    if (!image.available) {
      throw new ApiError(
        'MAP_IMAGE_MISSING',
        `Ainda não há imagem do mapa para o mundo ${String(config.worldSize)} / seed ` +
          `${String(config.seed)} deste servidor. Peça o render na aba Administração.`,
        404,
      );
    }

    // 17 MB por abertura de tela seria absurdo: o nome do arquivo
    // já contém tamanho e seed, então a imagem de um mundo NUNCA
    // muda. `immutable` diz isso ao navegador, e o wipe resolve o
    // resto trocando a URL.
    void reply.header('Cache-Control', 'private, max-age=86400, immutable');
    void reply.type('image/png');

    return reply.send(createReadStream(image.path));
  });

  /**
   * Manda o jogo desenhar o mapa.
   *
   * ####  NORMALMENTE NINGUÉM PRECISA DISTO  ####
   *
   * O agente desenha sozinho quando o RCON conecta e não há imagem
   * daquele mundo — o que dá uma vez por wipe, no melhor momento
   * possível (servidor recém-subido, ninguém dentro). Ver
   * game/map-image.ts.
   *
   * Esta rota existe para o resto: a imagem que saiu corrompida, o
   * mapa customizado que mudou sem mudar a seed, o operador que
   * quer refazer agora. Ela força mesmo havendo arquivo.
   *
   * Responde assim que o comando SAI: o render passa dos cinco
   * segundos do timeout de RCON, e esperar por ele transformaria um
   * desenho que ACONTECEU num erro na tela. Quem chamou descobre
   * que terminou pelo `GET /map` passando a dizer `available`.
   */
  app.post('/servers/:id/map/render', async (request) => {
    const { id } = serverParams.parse(request.params);
    const context = contextOf(deps, id);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    if (!context.rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `Sem conexão com o RCON do servidor "${id}". Quem desenha o mapa é o jogo, e ele precisa ` +
          'estar no ar.',
        503,
      );
    }

    await renderMapImage(context.rcon);

    request.log.info({ server: id, by: operatorOf(request) }, 'render do mapa pedido');

    return {
      ok: true,
      path: mapImagePath(config.paths.installDir, config.worldSize, config.seed),
      message:
        'O jogo está desenhando o mapa. São alguns segundos, e o servidor pode engasgar enquanto ' +
        'isso — a imagem aparece aqui sozinha quando ficar pronta.',
    };
  });

  // ==========================================================
  //  Chat
  // ==========================================================

  /**
   * As últimas mensagens, lidas do HISTÓRICO DO JOGO.
   *
   * ####  NÃO É UM BUFFER DO AGENTE  ####
   *
   * A primeira versão disto guardava as linhas de chat que passavam
   * pelo RCON. Um plugin de chat (o `OrigemZChat` desta rede)
   * CANCELA a mensagem original para reenviá-la formatada, e com
   * isso o frame de chat do WebRCON deixa de existir — a aba ficava
   * vazia com o servidor cheio de gente conversando.
   *
   * `chat.tail` é o histórico do próprio servidor, que o jogo
   * alimenta nos dois caminhos. Ele ainda sobrevive ao reinício do
   * agente, coisa que um buffer em memória não faz. Ver game/chat.ts.
   */
  app.get('/servers/:id/chat', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { limit } = chatQuery.parse(request.query);
    const context = deps.supervisor.contextOf(id);

    if (context === null) {
      if (deps.supervisor.configOf(id) === null) {
        throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
      }

      // Servidor conhecido e sem contexto NÃO é erro: é um estado
      // que a tela mostra. Mesmo desenho do console ao vivo.
      return {
        ok: true,
        connected: false,
        lines: [],
        message:
          `O agente não está cuidando do servidor "${id}", então não há chat. O histórico é do ` +
          'servidor, e é pelo RCON que se pergunta por ele.',
      };
    }

    if (!context.rcon.isConnected) {
      return {
        ok: true,
        connected: false,
        lines: [],
        message:
          `O RCON do servidor "${id}" está fora do ar. O histórico de chat continua guardado no ` +
          'servidor e aparece aqui assim que a conexão voltar.',
      };
    }

    const lines = await readChat(id, context.rcon, limit ?? DEFAULT_CHAT_LIMIT);

    return {
      ok: true,
      connected: true,
      lines: lines.map((line) => ({
        at: new Date(line.at).toISOString(),
        steamId: line.steamId,
        name: line.name,
        tag: line.tag,
        text: line.text,
        channel: line.channel,
        color: line.color,
      })),
    };
  });

  app.post('/servers/:id/chat', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { message } = sayBody.parse(request.body);
    const context = contextOf(deps, id);

    if (!context.rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `Sem conexão com o RCON do servidor "${id}" — não há para quem mandar a mensagem.`,
        503,
      );
    }

    // ####  ASPAS E RICH TEXT FORA  ####
    //
    // O `say` do Rust quebra com aspas no meio, e `<color>` deixaria
    // qualquer integração se passar por mensagem de admin. Mesma
    // limpeza do aviso de atualização (ops/service.ts).
    const clean = message.replace(/["<>]/g, '').replace(/\s+/g, ' ').trim();

    if (clean === '') {
      throw new ApiError(
        'INVALID_BODY',
        'A mensagem ficou vazia depois de tirar as aspas e o rich text.',
        400,
      );
    }

    await context.rcon.send(`say "${clean}"`);

    // Não há nada a guardar deste lado: o próprio jogo registra o
    // `say` no histórico (como uma mensagem do SERVER), e é de lá
    // que a tela lê. Uma cópia local seria uma segunda verdade, e
    // ela apareceria duplicada na leitura seguinte.
    request.log.info({ server: id, by: operatorOf(request) }, 'mensagem enviada ao chat do jogo');

    return { ok: true, message: clean };
  });

  // ==========================================================
  //  Admins
  // ==========================================================

  /**
   * ####  O ARQUIVO É LIDO, E NUNCA ESCRITO  ####
   *
   * `users.cfg` é reescrito inteiro pelo jogo a cada
   * `server.writecfg`. Editá-lo com o servidor no ar perde a
   * mudança em silêncio — quem muda o estado é o comando pelo
   * RCON, e é o que as duas rotas abaixo fazem.
   */
  app.get('/servers/:id/admins', async (request) => {
    const { id } = serverParams.parse(request.params);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw new ApiError('UNKNOWN_SERVER', `Não existe servidor com o id "${id}".`, 404);
    }

    const list = await readAdmins(config.paths.installDir, config.identity);

    return {
      ok: true,
      ...list,
      ...(list.source === 'ausente'
        ? {
            message:
              `Ainda não há ${list.path}. Ele é criado pelo jogo no primeiro server.writecfg — ` +
              'ou seja, depois que este servidor subir pela primeira vez.',
          }
        : {}),
    };
  });

  app.post('/servers/:id/admins', async (request) => {
    const { id } = serverParams.parse(request.params);
    const body = grantBody.parse(request.body);
    const context = contextOf(deps, id);

    const output = await grantAdmin(id, context.rcon, {
      steamId: body.steamId,
      name: body.name ?? null,
      level: body.level,
    });

    const by = operatorOf(request);
    const label = body.level === 'owner' ? 'owner' : 'moderador';

    request.log.warn(
      { server: id, steamId: body.steamId, level: body.level, by },
      'admin promovido pelo painel',
    );

    return {
      ok: true,
      output,
      message:
        `${body.steamId} agora é ${label} em ${id}. Vale na hora, inclusive com o jogador ` +
        'dentro do jogo.',
    };
  });

  app.delete('/servers/:id/admins/:steamId', async (request) => {
    const { id, steamId } = playerParams.parse(request.params);
    const { level } = levelQuery.parse(request.query);
    const context = contextOf(deps, id);

    if (level === undefined) {
      // Sem o nível não dá para escolher entre `removeowner` e
      // `removemoderator` — e mandar o errado NÃO dá erro: não faz
      // nada. Recusar aqui é melhor que fingir que removeu.
      throw new ApiError(
        'INVALID_PARAMS',
        'Diga qual nível remover: ?level=owner ou ?level=moderator. O comando é diferente para ' +
          'cada um, e o errado não dá erro — simplesmente não faz nada.',
        400,
      );
    }

    const output = await revokeAdmin(id, context.rcon, { steamId, level });
    const by = operatorOf(request);

    request.log.warn({ server: id, steamId, level, by }, 'admin rebaixado pelo painel');

    return {
      ok: true,
      output,
      message: `${steamId} não é mais ${level === 'owner' ? 'owner' : 'moderador'} em ${id}.`,
    };
  });
}
