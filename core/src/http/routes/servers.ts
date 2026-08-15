// ============================================================
//  routes/servers.ts  -  listar, criar, ligar/desligar, remover.
//
//  A rota traduz HTTP e mais nada: quem conhece as regras é
//  `servers/create-server.ts` (a criação) e `ServerSupervisor` (o
//  resto). As mensagens de erro nascem lá, em português, e sobem
//  inteiras — assim a frase é a mesma pela API e pelo painel.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { readServerConfig, type AgentPaths } from '../../config.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import {
  createServer,
  createServerBodySchema,
  FORBIDDEN_RCON_PASSWORD_CHARS,
  iniText,
  isCreateServerError,
  suggestedPortBlockFor,
} from '../../servers/create-server.js';
import {
  MAP_LEVELS,
  MAX_SEED,
  MAX_WORLD_SIZE,
  MIN_WORLD_SIZE,
} from '../../servers/map-levels.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';
import { ApiError, zodErrorToResponse } from '../error-response.js';

export interface ServerRoutesDeps {
  readonly paths: AgentPaths;
  readonly repository: ServersRepository;
  readonly supervisor: ServerSupervisor;
}

/**
 * O corpo do PATCH: a configuração do servidor, campo a campo.
 *
 * `.strict()` pelo mesmo motivo do resto da API: um painel que
 * mande `world_size` em vez de `worldSize` precisa saber na hora,
 * em vez de "salvar" e não mudar nada.
 *
 * As faixas repetem as do `.ini` (config.ts) de propósito: recusar
 * aqui devolve uma frase para a tela; recusar lá derruba o
 * servidor no próximo boot.
 */
const patchSchema = z
  .object({
    /** O agente cuida deste servidor? */
    enabled: z.boolean().optional(),
    /** A janela de console do jogo. Vale no próximo start. */
    consoleWindow: z.boolean().optional(),

    name: iniText('name', 80).optional(),
    hostname: iniText('hostname', 120).optional(),
    description: iniText('description', 500).optional().or(z.literal('')),
    url: iniText('url', 300).optional().or(z.literal('')),
    headerImage: iniText('headerImage', 300).optional().or(z.literal('')),

    /**
     * A senha do JOGADOR. String vazia LIMPA — é assim que se abre
     * um servidor que estava trancado.
     */
    password: iniText('password', 64).optional().or(z.literal('')),

    map: z.enum(MAP_LEVELS).optional(),
    seed: z.number().int().min(0).max(MAX_SEED).optional(),
    worldSize: z.number().int().min(MIN_WORLD_SIZE).max(MAX_WORLD_SIZE).optional(),
    maxPlayers: z.number().int().min(1).max(1_000).optional(),
    saveInterval: z.number().int().min(30).max(86_400).optional(),

    gamePort: z.number().int().min(1).max(65_535).optional(),
    queryPort: z.number().int().min(1).max(65_535).optional(),
    appPort: z.number().int().min(1).max(65_535).optional(),
    rconPort: z.number().int().min(1).max(65_535).optional(),

    rconPassword: z
      .string()
      .min(8, 'a senha do RCON precisa ter pelo menos 8 caracteres')
      .max(200)
      .refine(
        (value) => !FORBIDDEN_RCON_PASSWORD_CHARS.test(value),
        'a senha do RCON não pode conter "/", "\\", "?", "#" nem espaços: o WebRCON a ' +
          'transporta no caminho da URL e o Rust compara o caminho cru',
      )
      .optional(),

    steamAppId: z.string().regex(/^\d{1,10}$/, 'o AppID é numérico').optional(),
    steamLogin: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'login inválido para o SteamCMD')
      .optional(),
    steamBranch: z.string().max(64).optional().or(z.literal('')),
  })
  .strict();

const rconSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, 'informe o comando')
      .max(1_000, 'comando longo demais (máximo 1000 caracteres)'),
  })
  .strict();

const paramsSchema = z.object({ id: z.string().min(1) });

function unknownServer(id: string, deps: ServerRoutesDeps): ApiError {
  return new ApiError(
    'UNKNOWN_SERVER',
    `Não existe servidor com o id "${id}" neste agente. Os que existem: ` +
      `${deps.supervisor.ids().join(', ') || '(nenhum)'}.`,
    404,
  );
}

export function registerServerRoutes(app: FastifyInstance, deps: ServerRoutesDeps): void {
  // ---- listar ---------------------------------------------
  app.get('/servers', async () => {
    // A varredura de processos ANTES da lista: é ela que preenche
    // o `running`. Sem isso a tela chamaria de "parado" um
    // servidor que está no ar sem o agente cuidar dele.
    await deps.supervisor.scanProcesses();

    return {
      ok: true,
      servers: deps.supervisor.list(),
      // O formulário do painel mostra as quatro portas ENQUANTO a
      // pessoa digita o nome, antes de qualquer criação.
      suggestedPortBlock: suggestedPortBlockFor(deps.repository),
    };
  });

  // ---- criar ----------------------------------------------
  app.post('/servers', async (request, reply) => {
    const parsed = createServerBodySchema.safeParse(request.body);

    if (!parsed.success) {
      const response = zodErrorToResponse(parsed.error);
      return reply.status(response.statusCode).send(response.body);
    }

    try {
      const created = createServer({
        projectRoot: deps.paths.root,
        store: deps.repository,
        input: parsed.data,
      });

      // Relê o `.ini` recém-escrito: é ele a fonte da verdade, e
      // é `readServerConfig` quem resolve as pastas respeitando
      // SERVERS_DIR e companhia.
      const config = readServerConfig(deps.paths, created.id);

      deps.supervisor.adopt(config);

      return reply.status(201).send({
        ok: true,
        server: deps.supervisor.view(created.id),
        // O passo seguinte, dito em voz alta: o servidor nasce
        // desligado porque o jogo não está em disco.
        next: 'server-install',
        message:
          `Servidor "${created.id}" criado em ${created.configPath}. ` +
          'Ele nasce DESLIGADO — o próximo passo é Instalar, que baixa o jogo pelo SteamCMD.',
      });
    } catch (error) {
      if (isCreateServerError(error)) {
        return reply.status(error.status).send({
          ok: false,
          error: error.code,
          message: error.message,
          ...(error.conflicts.length > 0 ? { conflicts: error.conflicts } : {}),
        });
      }

      throw error;
    }
  });

  // ---- um servidor ----------------------------------------
  app.get('/servers/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);

    await deps.supervisor.scanProcesses();

    const view = deps.supervisor.view(id);

    if (view === null) {
      throw unknownServer(id, deps);
    }

    return { ok: true, server: view, kinds: deps.supervisor.operationsOf(id).kinds() };
  });

  // ---- ligar / desligar -----------------------------------
  app.patch('/servers/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const body = patchSchema.parse(request.body);

    if (deps.supervisor.configOf(id) === null) {
      throw unknownServer(id, deps);
    }

    // Tudo o que é do `.ini` vai numa gravação só: duas escritas
    // no mesmo arquivo por uma tela de configuração é a chance de
    // a segunda falhar e deixar metade aplicada.
    const { enabled, ...settings } = body;
    const requiresRestart = deps.supervisor.updateSettings(id, settings);

    if (enabled === true) {
      deps.supervisor.enable(id);
    } else if (enabled === false) {
      await deps.supervisor.disable(id);
    }

    await deps.supervisor.scanProcesses();

    const running = deps.supervisor.view(id)?.running === true;

    return {
      ok: true,
      server: deps.supervisor.view(id),
      requiresRestart,
      // Dito em voz alta, e SÓ quando importa: um mundo já
      // carregado não muda de mapa nem de seed, e uma janela não
      // aparece num processo que já está no ar. Sem esta frase, a
      // tela diria "salvo" e a pessoa concluiria que não funcionou.
      ...(requiresRestart.length > 0 && running
        ? {
            message:
              `Gravado. ${requiresRestart.join(', ')} só vale(m) a partir do próximo start — ` +
              'o servidor está no ar agora e continua com o que carregou.',
          }
        : {}),
    };
  });

  // ---- remover --------------------------------------------
  app.delete('/servers/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const config = deps.supervisor.configOf(id);

    if (config === null) {
      throw unknownServer(id, deps);
    }

    await deps.supervisor.forget(id);

    return {
      ok: true,
      // ####  A PASTA DO JOGO FICA  ####
      //
      // São dezenas de GB, e apagá-las por um clique num botão de
      // "remover cadastro" é o tipo de coisa que ninguém desfaz.
      // A resposta diz onde ela está para quem quiser apagar à
      // mão.
      installDir: config.paths.installDir,
      message:
        `O servidor "${id}" saiu deste agente. A instalação NÃO foi apagada: ela continua ` +
        `em ${config.paths.installDir}. O arquivo Configs\\${id}.ini também ficou — ` +
        'apague os dois à mão se quiser mesmo se livrar deles.',
    };
  });

  // ---- comando cru pelo RCON ------------------------------
  //
  // O canivete que evita inventar rota para cada coisa do jogo.
  // Ele NÃO é "comando arbitrário na máquina": o comando vai para
  // o servidor de Rust, exatamente como o console web faz — e
  // quem tem a senha do RCON já podia fazer isso.
  app.post('/servers/:id/rcon', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const body = rconSchema.parse(request.body);
    const context = deps.supervisor.contextOf(id);

    if (context === null) {
      throw new ApiError(
        'SERVER_NOT_OPERATED',
        `O agente não está cuidando do servidor "${id}" (ele está desligado, ou o jogo ` +
          'ainda não foi instalado). Ligue-o antes de mandar comandos.',
        409,
      );
    }

    if (!context.rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `Sem conexão com o RCON do servidor "${id}". Ele pode estar parado ou ainda subindo.`,
        503,
      );
    }

    const response = await context.rcon.send(body.command);

    return { ok: true, command: body.command, response };
  });
}
