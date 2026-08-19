// ============================================================
//  server.ts  -  a montagem do Fastify.
//
//  Ordem que importa:
//
//    1. cookie          (o guarda lê request.cookies)
//    2. /health         sem autenticação
//    3. /auth/*         sem o guarda — é por aqui que a sessão nasce
//    4. /api/*          COM o guarda
//    5. painel estático (fallback, por último)
//
//  O painel entra por último de propósito: ele responde a
//  QUALQUER caminho não casado, e registrado antes engoliria as
//  rotas de API que viessem depois.
// ============================================================

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { OperatorAuth } from '../auth/operator.js';
import type { BanList } from '../bans/service.js';
import type { AgentConfig } from '../config.js';
import type { ItemsRepository } from '../db/items-repository.js';
import type { KitsRepository } from '../db/kits-repository.js';
import type { LoadoutsRepository } from '../db/loadouts-repository.js';
import type { SpawnStatusRepository } from '../db/spawn-status-repository.js';
import type { ServersRepository } from '../db/servers-repository.js';
import type { UiDocumentsRepository } from '../db/ui-documents-repository.js';
import type { ItemCatalog } from '../game/item-catalog.js';
import type { KitStore } from '../kits/service.js';
import type { SpawnStatusSync } from '../loadouts/status.js';
import type { LoadoutSync } from '../loadouts/sync.js';
import type { VipList } from '../vip/service.js';
import type { MonumentReader } from '../game/monuments.js';
import type { UiSync } from '../game/ui-sync.js';
import type { PlayersReader } from '../game/players.js';
import type { Logger } from '../logger.js';
import type { OperationStore } from '../ops/operations.js';
import type { PluginLibrary } from '../oxide/library.js';
import { MAX_PLUGIN_BYTES } from '../oxide/plugins.js';
import type { PlayerDirectory } from '../players/service.js';
import type { ServerSupervisor } from '../servers/supervisor.js';
import type { SteamUpdateWatcher } from '../steam/update-watcher.js';
import { createAuthGuard } from './auth.js';
import {
  apiErrorToResponse,
  internalErrorResponse,
  isApiError,
  zodErrorToResponse,
} from './error-response.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBanRoutes } from './routes/bans.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerHealthRoutes, type HealthServerView } from './routes/health.js';
import { registerKitRoutes } from './routes/kits.js';
import { registerLoadoutRoutes } from './routes/loadouts.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerOxideRoutes } from './routes/oxide.js';
import { registerPlayerRoutes } from './routes/players.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerSteamUpdateRoutes } from './routes/steam-updates.js';
import { registerSystemRoutes } from './routes/system.js';
// ---- itens e interface ----
import { registerItemRoutes } from './routes/items.js';
import { registerUiRoutes } from './routes/ui.js';
// ---- VIP, loadouts e kits ----
import { registerVipRoutes } from './routes/vips.js';
// ---- a loja e a carteira ----
import { registerStoreRoutes, type StoreRoutesDeps } from './routes/store.js';
// ---- wipe, calendário e mensagens ----
import type { WipeScheduleRepository } from '../db/wipe-schedule-repository.js';
import { registerWipeRoutes } from './routes/wipe.js';
// ---- o wipe: a fila de mapas ----
import type { MapPoolRepository } from '../db/map-pool-repository.js';
import type { WipeRunsRepository } from '../db/wipe-runs-repository.js';
import type { WipesRepository } from '../db/wipes-repository.js';
import type { WipeWorldClock } from '../wipe/run.js';
import { registerWipeMapsRoutes } from './routes/wipe-maps.js';
import { registerWipeRunRoutes } from './routes/wipe-runs.js';
// ---- as mensagens agendadas ----
import type { MessagesRepository } from '../db/messages-repository.js';
import type { MessagesService } from '../messages/service.js';
import type { VariableRegistry } from '../messages/variables.js';
import { registerMessageRoutes } from './routes/messages.js';
// ---- o wipe: a prévia do mapa (RustMaps) ----
import type { RustMapsWatcher } from '../wipe/rustmaps-poll.js';
import { registerRustMapsRoutes } from './routes/rustmaps.js';
// ---- o wipe: os blueprints que sobrevivem ----
import type { BpRepository } from '../db/bp-repository.js';
import type { BlueprintService } from '../wipe/blueprints.js';
import { registerWipeBlueprintRoutes } from './routes/wipe-blueprints.js';

export interface BuildServerOptions {
  readonly config: AgentConfig;
  readonly logger: Logger;
  readonly operators: OperatorAuth;
  readonly version: string;
  readonly startedAt: number;
  readonly servers: () => readonly HealthServerView[];
  readonly supervisor: ServerSupervisor;
  readonly repository: ServersRepository;
  readonly operations: OperationStore;
  readonly steamWatcher: SteamUpdateWatcher;
  /** A biblioteca de plugins do agente. Ver oxide/library.ts. */
  readonly library: PluginLibrary;
  /** A lista de banidos, global. Ver bans/service.ts. */
  readonly bans: BanList;
  /** Quem está online, com ou sem plugin. Ver game/players.ts. */
  readonly players: PlayersReader;
  /**
   * A base de jogadores da REDE. Ver players/service.ts.
   *
   * Repare que ela e o `players` acima respondem a perguntas
   * diferentes: aquele é quem está conectado AGORA naquele
   * servidor, lido do RCON; este é todo mundo que já jogou, lido
   * do banco. Os dois convivem porque as duas telas existem.
   */
  readonly directory: PlayerDirectory;
  /** Os monumentos do mundo. Ver game/monuments.ts. */
  readonly monuments: MonumentReader;

  // ---- itens e interface ----

  /** O catálogo guardado. Ver db/items-repository.ts. */
  readonly items: ItemsRepository;
  /** Quem relê o catálogo do jogo. Ver game/item-catalog.ts. */
  readonly itemCatalog: ItemCatalog;
  /** As interfaces. Ver db/ui-documents-repository.ts. */
  readonly uiDocuments: UiDocumentsRepository;
  /** O transporte até o jogo. Ver game/ui-sync.ts. */
  readonly uiSync: UiSync;
  // ---- o VIP, os loadouts e a loja de kits ----------------
  //
  // Ver Docs\15-BRIEFING-VIP-LOADOUTS-KITS.md. Os três chegam
  // juntos porque compartilham o mesmo caminho até o jogo: o
  // agente é a fonte, e o plugin recebe o estado COMPLETO.

  /** O VIP da rede. Ver vip/service.ts. */
  readonly vips: VipList;
  /**
   * O que cada grupo recebe ao nascer, por servidor — e em que
   * ESTADO ele acorda (vida, fome e sede).
   *
   * Os dois juntos porque são a mesma tela; separados no jogo,
   * porque são dois comandos e dois caches do plugin.
   */
  readonly loadouts: {
    readonly repository: LoadoutsRepository;
    readonly sync: LoadoutSync;
    readonly statusRepository: SpawnStatusRepository;
    readonly statusSync: SpawnStatusSync;
  };
  /** A loja de kits, e a entrega dentro do jogo. */
  readonly kits: {
    readonly store: KitStore;
    readonly repository: KitsRepository;
  };
  /**
   * A LOJA: categorias, ofertas, carteira e histórico de compras.
   *
   * Separada dos kits de propósito, e não por acaso de nomenclatura:
   * um kit é entrega com REGRA (uma vez por jogador, de N em N
   * horas); uma oferta é entrega com PREÇO. Só a segunda move
   * dinheiro, e é ela que precisa de débito, estorno e extrato.
   */
  readonly store: Omit<StoreRoutesDeps, 'supervisor'>;

  // ---- wipe, calendário e mensagens ----------------------
  //
  // Ver Docs\16-PLANO-WIPE-CALENDARIO-MENSAGENS.md.

  /**
   * A AGENDA do wipe: quando o servidor zera, e o que o wipe leva.
   *
   * Só o calendário — nada aqui executa wipe. Quem apaga arquivo é
   * a operação `wipe-run`, e ela chega depois.
   */
  readonly wipeSchedule: WipeScheduleRepository;

  /**
   * A FILA DE MAPAS de cada servidor: qual mundo entra no próximo
   * wipe. Ver db/map-pool-repository.ts.
   */
  readonly mapPool: MapPoolRepository;

  /**
   * A EXECUÇÃO do wipe: a prévia, a lista do full wipe, os runs.
   *
   * É a única parte do agente que apaga o trabalho dos jogadores, e
   * é por isso que ela chega aqui com tudo de que precisa para
   * recusar ANTES de começar — o supervisor (para conferir o
   * identity digitado), o `OperationStore` (para o log ao vivo) e o
   * relógio do mundo (para saber se o wipe realmente trocou o save).
   */
  readonly wipeRuns: {
    readonly runs: WipeRunsRepository;
    readonly wipes: WipesRepository;
    readonly world: WipeWorldClock;
  };

  /**
   * AS MENSAGENS AGENDADAS: o que o servidor fala sozinho.
   *
   * De REDE, como o VIP e o kit — a mensagem é escrita uma vez e
   * sai nos servidores escolhidos. O `variables` vem junto porque a
   * lista de `{…}` que a tela mostra é a do REGISTRO, e não uma
   * constante do painel: quem registra `{wipe.*}` é o módulo de
   * wipe, e uma lista escrita à mão mentiria no dia em que ele
   * entrasse.
   */
  readonly messages: {
    readonly repository: MessagesRepository;
    readonly service: MessagesService;
    readonly variables: VariableRegistry;
  };

  /**
   * A PRÉVIA do mapa, do rustmaps.com.
   *
   * ####  ELA É ENFEITE  ####
   *
   * Nenhuma rota dela pode segurar um wipe: sem imagem, o mundo
   * procedural nasce no boot a partir da seed do mesmo jeito. Ela
   * chega como o vigia inteiro (e não só o cliente) porque a rota
   * de status lê o retrato em memória — a chave nunca sai do
   * `.env`, e perguntar ao RustMaps a cada abertura de tela
   * gastaria cota para redesenhar o mesmo cadeado.
   */
  readonly rustmaps: RustMapsWatcher;

  /**
   * OS BLUEPRINTS QUE SOBREVIVEM AO WIPE.
   *
   * ####  A ÚNICA PARTE DO WIPE QUE DEPENDE DE UM PLUGIN  ####
   *
   * O snapshot é lido pelo `OrigemZAgent` dentro do jogo, e a
   * devolução é aplicada por ele no login. Por isso as duas rotas
   * que falam com o jogo (tirar snapshot, devolver na mão)
   * respondem 503 com o servidor fora do ar, em vez de fingir que
   * guardaram uma cópia.
   *
   * O repositório vem junto do serviço porque a tela lê o retrato
   * — quantos jogadores, quantos itens, quantos já receberam — sem
   * falar com o jogo.
   */
  readonly blueprints: {
    readonly repository: BpRepository;
    readonly service: BlueprintService;
  };
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    // O `as FastifyBaseLogger` mantém a instância no tipo PADRÃO
    // do Fastify. Sem ele, todo o app fica parametrizado com o
    // tipo do pino, e cada função que recebe `FastifyInstance`
    // (as de rota) deixa de casar — por um campo (`msgPrefix`)
    // que ninguém aqui usa.
    loggerInstance: options.logger as FastifyBaseLogger,
    // O painel manda JSON pequeno; o upload de plugin vem por
    // multipart e tem limite próprio. 1 MB aqui é folga para o
    // maior corpo que uma rota de configuração produz.
    bodyLimit: 1_048_576,
    // Confia no `X-Forwarded-For` só quando alguém pôs um proxy
    // na frente — e quem faz isso é quem expôs a API.
    trustProxy: options.config.host !== '127.0.0.1',
  });

  void app.register(cookie);

  // O upload de plugin. O teto é do próprio plugin
  // (`MAX_PLUGIN_BYTES`, em oxide/plugins.ts) e vem IMPORTADO, e
  // não copiado: aqui ele existe porque o multipart precisa recusar
  // ANTES de ler o corpo inteiro na memória, e dois números soltos
  // divergiriam no primeiro ajuste — deixando o multipart cortar o
  // arquivo que a conferência aceitaria.
  void app.register(multipart, { limits: { fileSize: MAX_PLUGIN_BYTES, files: 1 } });

  // ---- o error handler: uma forma de erro para a API toda ----
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    if (error instanceof ZodError) {
      const response = zodErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    // Corpo malformado, método não permitido e afins já vêm com
    // statusCode do próprio Fastify. Só o que não tem status é
    // erro nosso — e desses o detalhe fica no log.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        ok: false,
        error: error.code ?? 'BAD_REQUEST',
        message: error.message,
      });
    }

    request.log.error({ err: error }, 'erro não tratado numa rota');

    const response = internalErrorResponse();
    return reply.status(response.statusCode).send(response.body);
  });

  registerHealthRoutes(app, {
    version: options.version,
    startedAt: options.startedAt,
    servers: options.servers,
  });

  registerAuthRoutes(app, options.operators);

  const requireAuth = createAuthGuard({
    apiToken: options.config.apiToken,
    operators: options.operators,
  });

  // Tudo que vier de `/api` passa pelo guarda. Registrar rota de
  // API fora deste escopo é o jeito de esquecer a autenticação —
  // por isso as rotas recebem a instância `api`, e não a raiz.
  void app.register(
    async (api) => {
      api.addHook('preHandler', requireAuth);

      registerSystemRoutes(api, {
        paths: options.config.paths,
        supervisor: options.supervisor,
        version: options.version,
        startedAt: options.startedAt,
      });

      registerServerRoutes(api, {
        paths: options.config.paths,
        repository: options.repository,
        supervisor: options.supervisor,
      });

      // As rotas de operação só existem com OPS_ENABLED=1. Com 0
      // elas nem são registradas — respondem 404, e não 403: quem
      // desligou não quer nem anunciar que elas existiriam.
      if (options.config.ops.enabled) {
        registerOperationRoutes(api, {
          store: options.operations,
          supervisor: options.supervisor,
        });
      }

      registerConsoleRoutes(api, { supervisor: options.supervisor });

      registerPluginRoutes(api, { library: options.library });

      // Os grupos e as permissões do Oxide. Eles moram DENTRO do
      // servidor (protobuf reescrito por ele), então tudo aqui
      // passa pelo console — nada de editar arquivo.
      registerOxideRoutes(api, { supervisor: options.supervisor });

      registerSteamUpdateRoutes(api, {
        watcher: options.steamWatcher,
        supervisor: options.supervisor,
      });

      registerAdminRoutes(api, {
        supervisor: options.supervisor,
        players: options.players,
        monuments: options.monuments,
        // Expulsar e teleportar passam a deixar rastro na ficha do
        // jogador, e não só no log do processo.
        history: options.directory,
      });

      registerBanRoutes(api, { bans: options.bans, supervisor: options.supervisor });

      // A base de jogadores da rede. Vem DEPOIS das rotas de
      // servidor porque é o caminho `/players` da raiz — o
      // `/servers/:id/players`, que é outra coisa, já foi
      // registrado por `registerAdminRoutes`.
      registerPlayerRoutes(api, { directory: options.directory });

      // O catálogo de itens. Ele responde do BANCO, e por isso
      // continua de pé com todos os servidores parados — que é
      // justamente quando se monta um kit.
      registerItemRoutes(api, { repository: options.items, catalog: options.itemCatalog });

      // As interfaces do jogo. O desenho é da rede; o que cada
      // servidor mostra dele é dado da ligação — daí as rotas
      // virem em duas famílias.
      registerUiRoutes(api, {
        repository: options.uiDocuments,
        sync: options.uiSync,
        servers: options.supervisor,
      });

      // ---- o VIP, os loadouts e a loja ---------------------
      //
      // Três blocos no fim, e nesta ordem, porque é a ordem da
      // dependência entre eles: o VIP é o direito, o loadout é o
      // que cada grupo recebe, e o kit é o loadout com regra de
      // entrega. Ver Docs\15-BRIEFING-VIP-LOADOUTS-KITS.md.
      registerVipRoutes(api, { vips: options.vips, servers: options.supervisor });

      registerLoadoutRoutes(api, {
        repository: options.loadouts.repository,
        sync: options.loadouts.sync,
        statusRepository: options.loadouts.statusRepository,
        statusSync: options.loadouts.statusSync,
        supervisor: options.supervisor,
      });

      registerKitRoutes(api, {
        store: options.kits.store,
        repository: options.kits.repository,
        supervisor: options.supervisor,
      });

      // A loja depois dos kits porque ela DEPENDE do VIP: uma oferta
      // de VIP concede pelo `VipList`, e não por um segundo caminho.
      registerStoreRoutes(api, { ...options.store, supervisor: options.supervisor });

      // ---- o wipe -----------------------------------------
      //
      // A AGENDA, e só ela: settings, plans e upcoming. Nenhuma
      // destas rotas para servidor nem apaga arquivo — quando a
      // execução entrar, ela vem como operação, com trava e log.
      registerWipeRoutes(api, {
        repository: options.wipeSchedule,
        supervisor: options.supervisor,
      });

      // A fila de mapas responde em QUE MUNDO o servidor volta
      // depois de zerar. Ela é lida do banco, então continua de
      // pé com o servidor parado — que é exatamente quando se
      // escolhe o mapa do próximo wipe.
      registerWipeMapsRoutes(api, {
        repository: options.mapPool,
        supervisor: options.supervisor,
      });

      // As mensagens agendadas, e a fala avulsa do
      // `POST /chat/broadcast`. Elas vêm por último porque não são
      // pré-requisito de ninguém: o transporte (`Broadcaster`) é
      // que é compartilhado, e ele é injetado, não registrado.
      registerMessageRoutes(api, {
        repository: options.messages.repository,
        service: options.messages.service,
        variables: options.messages.variables,
        supervisor: options.supervisor,
      });

      // A prévia do mapa, por último: ela é a única aqui que fala
      // com um serviço de FORA, e é a única cuja indisponibilidade
      // não muda nada do que o agente faz. Ver Docs\17,
      // §"Frente H", regra 1.
      registerRustMapsRoutes(api, {
        watcher: options.rustmaps,
        repository: options.mapPool,
        supervisor: options.supervisor,
      });

      // ####  A EXECUÇÃO VEM POR ÚLTIMO, E DE PROPÓSITO  ####
      //
      // Ela é a única deste bloco que APAGA ARQUIVO. Registrá-la no
      // fim deixa claro, para quem lê este arquivo de cima a baixo,
      // que tudo o que veio antes é leitura e configuração — e que
      // a linha divisória do agente é esta.
      registerWipeRunRoutes(api, {
        runs: options.wipeRuns.runs,
        wipes: options.wipeRuns.wipes,
        schedule: options.wipeSchedule,
        mapPool: options.mapPool,
        supervisor: options.supervisor,
        store: options.operations,
        world: options.wipeRuns.world,
      });

      // Os blueprints depois da execução, e não antes: eles são o
      // que sobra de UM wipe para o seguinte, e ler este arquivo de
      // cima a baixo deve contar a história nessa ordem — a agenda,
      // o mapa, a mensagem, o wipe, e o que atravessa o wipe.
      registerWipeBlueprintRoutes(api, {
        repository: options.blueprints.repository,
        service: options.blueprints.service,
        supervisor: options.supervisor,
      });
    },
    { prefix: '/api' },
  );

  // ---- o painel ----
  const panelDir = join(options.config.paths.root, 'panel', 'out');

  if (existsSync(panelDir)) {
    void app.register(staticFiles, { root: panelDir, index: ['index.html'] });

    // O export do Next gera uma pasta por rota (`trailingSlash`),
    // então o @fastify/static resolve sozinho. O que sobra é a
    // URL desconhecida: ela recebe o index, e o roteador do Next
    // decide o que mostrar.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/auth')) {
        return reply.status(404).send({
          ok: false,
          error: 'NOT_FOUND',
          message: `Rota não encontrada: ${request.method} ${request.url}`,
        });
      }

      return reply.sendFile('index.html');
    });
  } else {
    options.logger.warn(
      { panelDir },
      'painel não compilado (panel/out ausente) — a API responde, a tela não. ' +
        'Rode "npm run build -w panel".',
    );
  }

  return app;
}
