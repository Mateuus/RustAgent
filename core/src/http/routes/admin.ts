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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { grantAdmin, readAdmins, revokeAdmin } from '../../game/admins.js';
import { DEFAULT_CHAT_LIMIT, MAX_CHAT_LIMIT, readChat } from '../../game/chat.js';
import { kickPlayer, type PlayersReader } from '../../game/players.js';
import type { ServerContext } from '../../servers/context.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError } from '../error-response.js';

export interface AdminRoutesDeps {
  readonly supervisor: ServerSupervisor;
  readonly players: PlayersReader;
}

const serverParams = z.object({ id: z.string().min(1) });
const playerParams = z.object({ id: z.string().min(1), steamId: z.string().min(1) });
const chatQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CHAT_LIMIT).optional(),
});

const kickBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

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

    return { ok: true, ...(await deps.players.list(id, context.rcon)) };
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

    return {
      ok: true,
      steamId,
      output,
      message:
        `${steamId} foi expulso. Ele pode entrar de novo a qualquer momento — para impedir, ` +
        'use Banir.',
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
